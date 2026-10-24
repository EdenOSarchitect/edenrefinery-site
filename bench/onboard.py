"""EDEN SSI (Signed Satellite Inference) on-board pass recorder (flight-candidate prototype, v2.4).

STATUS: REBUILT 22 Oct 2026, PROPOSED. Not flight software - see README
"Readiness gap". Target assumption: a Linux payload computer with Python
3.8+ and a persistent filesystem. Standard library only (plus the optional
`cryptography` package). No network, no threads, no key generation.

One PassRecorder per contact pass:

    rec = PassRecorder(state_dir, pass_id, seed_path)   # recovers an interrupted journal
    rec.record(item="tile-0042", action="VOID", input_bytes=raw, model="cloud-v3", score=0.91)
    pkg_path = rec.alert(item="tile-0777", input_bytes=raw, model="fire-v1", score=0.97)
    bundle_path = rec.close()                           # signed root -> downlink queue

Files in state_dir/<pass_id>/:
    journal.jsonl     append-only records (stays on board; source of spot-check proofs)
    checkpoints.jsonl signed checkpoints issued by alerts
    quarantine.jsonl  journal lines that failed their checksum on recovery
    out/alert_NNNN.json, out/bundle.json, out/consistency.json  -> downlink queue
"""
import hashlib
import json
import os
import time

import marble_core as mc
from telemetry import MarbleTelemetry
import chrysalis_budget as cb

BUNDLE_DOMAIN = b"EDEN-ONBOARD-BUNDLE-v2\x00"
CHECKPOINT_DOMAIN = b"EDEN-ONBOARD-CHECKPOINT-v2\x00"

ACTIONS = {"KEEP", "VOID", "COMPUTE", "REUSE", "ALERT"}


class LimitExceeded(Exception):
    pass


class RefuseToSign(Exception):
    pass


class BudgetExceeded(Exception):
    """A KEEP/ALERT would put more payload bytes on this pass than its allocation."""


def _check(rec_bytes):
    return hashlib.sha256(rec_bytes).hexdigest()[:16]


def _fsync_append(path, line):
    with open(path, "ab") as f:
        f.write(line)
        f.flush()
        os.fsync(f.fileno())


def _write_atomic(path, data):
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def _file_sha256(path, chunk=1 << 20):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(chunk), b""):
            h.update(block)
    return h.hexdigest()


def load_seed(path):
    """Load a 32-byte Ed25519 seed provisioned from the ground (hex file)."""
    with open(path) as f:
        seed = bytes.fromhex(f.read().strip())
    if len(seed) != 32:
        raise ValueError("seed must be 32 bytes")
    return seed


class PassRecorder:
    def __init__(self, state_dir, pass_id, seed_path,
                 max_records=100_000, max_journal_bytes=64 * 2**20,
                 max_checkpoints=32, telemetry=True, node_id="sat-001",
                 budget_allocation=None):
        self.pass_id = str(pass_id)
        self.dir = os.path.join(state_dir, self.pass_id)
        self.out = os.path.join(self.dir, "out")
        os.makedirs(self.out, exist_ok=True)
        self.journal = os.path.join(self.dir, "journal.jsonl")
        self.cp_file = os.path.join(self.dir, "checkpoints.jsonl")
        self.q_file = os.path.join(self.dir, "quarantine.jsonl")
        self.seed = load_seed(seed_path)
        self.pub = mc.public_from_seed(self.seed)
        self.max_records = max_records
        self.max_journal_bytes = max_journal_bytes
        self.max_checkpoints = max_checkpoints
        self.tree = mc.StreamingTree()
        self.status = "OK"
        self.quarantined = 0
        self.torn_dropped = 0
        self.checkpoints = []
        self.closed = False
        self.models = {}          # name -> {"sha256": hex, "path": path or None}
        self.model_events = []    # re-attestation failures found at close
        resumed = os.path.exists(self.journal)
        # Chrysalis budget: an allocation (from a holder's signed DRAW) for THIS satellite + pass
        self.allocation = budget_allocation
        self.budget_used = 0
        if budget_allocation is not None:
            if budget_allocation.get("sat") != mc.key_id(self.pub) \
                    or budget_allocation.get("pass") != self.pass_id:
                raise ValueError("budget allocation is for a different satellite or pass")
        self._recover()
        # MARBLE/1.0 telemetry: observes, never alters. Opened after recovery so
        # it can report what recovery found; any failure leaves records untouched.
        self.tele = None
        if telemetry:
            try:
                self.tele = MarbleTelemetry(os.path.join(self.dir, "telemetry.marble.jsonl"),
                                            node_id=node_id)
            except Exception:
                self.tele = None
        self._tele("PASS_RESUME" if resumed else "PASS_OPEN", eden_tick=self.tree.size,
                   note="status=%s torn_dropped=%d quarantined=%d"
                   % (self.status, self.torn_dropped, self.quarantined))

    def _tele(self, kind, **kw):
        if self.tele is not None:
            try:
                self.tele.emit(kind, **kw)
            except Exception:
                pass

    # ---------------------------------------------------------------- recovery
    def _recover(self):
        """Rebuild state from disk after a restart or power loss.

        - A torn final line (no newline / unparseable) is dropped: the write
          never completed, so it was never acknowledged.
        - A complete line that fails its checksum means storage corruption.
          That line and everything after it are moved to quarantine.jsonl and
          the pass is marked DEGRADED. Nothing is silently repaired.
        """
        if os.path.exists(self.journal):
            with open(self.journal, "rb") as f:
                raw = f.read()
            lines = raw.split(b"\n")
            tail = lines.pop()  # bytes after the last newline (torn write if non-empty)
            if tail:
                self.torn_dropped += 1
            good, bad = [], []
            for ln in lines:
                if bad:
                    bad.append(ln)
                    continue
                ok = False
                try:
                    obj = json.loads(ln)
                    rb = mc.canon(obj["rec"])
                    ok = (obj["c"] == _check(rb) and obj["rec"]["i"] == len(good)
                          and obj["rec"]["pass"] == self.pass_id)
                except Exception:
                    ok = False
                if ok:
                    good.append(ln)
                    self.tree.append(rb)
                    if obj["rec"]["action"] in ("KEEP", "ALERT"):
                        self.budget_used += obj["rec"].get("bytes") or 0
                else:
                    bad.append(ln)
            if bad:
                self.status = "DEGRADED"
                self.quarantined = len(bad)
                for ln in bad:
                    _fsync_append(self.q_file, json.dumps(
                        {"raw": ln.decode("latin-1")}).encode() + b"\n")
            if bad or tail:
                _write_atomic(self.journal, b"".join(x + b"\n" for x in good))
        if os.path.exists(self.cp_file):
            with open(self.cp_file, "rb") as f:
                for ln in f.read().split(b"\n"):
                    if ln:
                        try:
                            self.checkpoints.append(json.loads(ln))
                        except ValueError:
                            self.status = "DEGRADED"
        if any(cp["n"] > self.tree.size for cp in self.checkpoints):
            # history that an alert already committed to has been lost
            self.status = "DEGRADED"

    # ---------------------------------------------------------------- models
    def register_model(self, name, data=None, path=None):
        """Attest a model: hash the exact weights file (or bytes) once at pass start.

        Every record that names this model then carries its SHA-256, so the
        ground can prove WHICH model made each decision. If `path` is given,
        the file is hashed again at close(); a mismatch marks the pass DEGRADED.
        """
        if (data is None) == (path is None):
            raise ValueError("give exactly one of data= or path=")
        if path is not None:
            data_hash = _file_sha256(path)
        else:
            data_hash = hashlib.sha256(data).hexdigest()
        self.models[str(name)] = {"sha256": data_hash, "path": path}
        return data_hash

    # ---------------------------------------------------------------- record
    def record(self, item, action, input_bytes=None, input_sha256=None,
               model=None, score=None, note=None):
        """Append one decision. Returns (index, audit_path_to_current_root)."""
        if self.closed:
            raise RuntimeError("pass closed")
        if action not in ACTIONS:
            raise ValueError("unknown action %r" % action)
        if self.tree.size >= self.max_records:
            raise LimitExceeded("max_records")
        nbytes = len(input_bytes) if input_bytes is not None else None
        if self.allocation is not None and action in ("KEEP", "ALERT"):
            if nbytes is None:
                raise ValueError("budgeted KEEP/ALERT needs input_bytes to count")
            if self.budget_used + nbytes > self.allocation["amount"]:
                self._tele("BUDGET_REFUSED", eden_tick=self.tree.size, raw_bytes=nbytes,
                           note="used=%d alloc=%d" % (self.budget_used, self.allocation["amount"]))
                raise BudgetExceeded("%d + %d > %d" % (self.budget_used, nbytes,
                                                       self.allocation["amount"]))
        if input_bytes is not None:
            input_sha256 = hashlib.sha256(input_bytes).hexdigest()
        rec = {"pass": self.pass_id, "i": self.tree.size, "item": str(item),
               "action": action, "input_sha256": input_sha256}
        if nbytes is not None:
            rec["bytes"] = nbytes
        if model is not None:
            rec["model"] = str(model)
            m = self.models.get(str(model))
            if m is not None:
                rec["model_sha256"] = m["sha256"]
            elif self.models:
                raise ValueError("model %r was not attested with register_model()" % model)
        if score is not None:
            rec["score"] = round(float(score), 6)
        if note is not None:
            rec["note"] = str(note)[:200]
        rb = mc.canon(rec)
        line = mc.canon({"c": _check(rb), "rec": rec}) + b"\n"
        size = os.path.getsize(self.journal) if os.path.exists(self.journal) else 0
        if size + len(line) > self.max_journal_bytes:
            raise LimitExceeded("max_journal_bytes")
        _fsync_append(self.journal, line)        # durable before acknowledged
        if action in ("KEEP", "ALERT") and nbytes:
            self.budget_used += nbytes
        lh = mc._leaf(rb)
        path = self.tree.append_leaf_hash(lh)
        raw = len(input_bytes) if input_bytes is not None else None
        planned = {"KEEP": raw, "ALERT": raw, "VOID": 0}.get(action)
        self._tele("RECORD", eden_tick=rec["i"], model=rec.get("model"),
                   model_sha256=rec.get("model_sha256"), input_hash=input_sha256,
                   output_hash=lh.hex(), raw_bytes=raw, planned_bytes=planned,
                   kept=action in ("KEEP", "ALERT"), score=rec.get("score"),
                   receipt={"pass": self.pass_id, "i": rec["i"], "leaf_hash": lh.hex(),
                            "action": action})
        return rec["i"], path

    # ---------------------------------------------------------------- alerts
    def alert(self, item, input_bytes=None, input_sha256=None, model=None,
              score=None, note=None):
        """Record an ALERT and immediately sign a checkpoint of everything so far.

        Writes out/alert_NNNN.json: the record, the signed checkpoint and the
        audit path linking them. The ground can verify it on arrival.
        """
        if len(self.checkpoints) >= self.max_checkpoints:
            raise LimitExceeded("max_checkpoints")
        i, path = self.record(item, "ALERT", input_bytes, input_sha256,
                              model, score, note)
        rec = self._read_record(i)
        body = {"pass": self.pass_id, "seq": len(self.checkpoints),
                "n": self.tree.size, "root": self.tree.root().hex(),
                "key": mc.key_id(self.pub),
                "clock": {"t": round(time.time(), 3), "label": "UNTRUSTED"}}
        cp = dict(body, sig=mc.sign(self.seed, CHECKPOINT_DOMAIN + mc.canon(body)).hex())
        _fsync_append(self.cp_file, mc.canon(cp) + b"\n")
        self.checkpoints.append(cp)
        pkg = {"record": rec, "index": i, "path": [h.hex() for h in path],
               "checkpoint": cp}
        p = os.path.join(self.out, "alert_%04d.json" % cp["seq"])
        blob = mc.canon(pkg)
        _write_atomic(p, blob)
        self._tele("CHECKPOINT", eden_tick=i, output_hash=cp["root"],
                   planned_bytes=len(blob), note="seq=%d n=%d" % (cp["seq"], cp["n"]))
        if self.tele is not None:
            self.tele.flush()
        return p

    def _read_record(self, i):
        # the newest record is the last journal line
        with open(self.journal, "rb") as f:
            f.seek(0, 2)
            end = f.tell()
            back = min(end, 4096)
            f.seek(end - back)
            last = f.read().rstrip(b"\n").split(b"\n")[-1]
        rec = json.loads(last)["rec"]
        assert rec["i"] == i
        return rec

    # ---------------------------------------------------------------- close
    def _journal_records(self):
        recs = []
        with open(self.journal, "rb") as f:
            for ln in f:
                obj = json.loads(ln)
                rb = mc.canon(obj["rec"])
                if obj["c"] != _check(rb):
                    raise RefuseToSign("journal line %d fails its checksum" % len(recs))
                recs.append(rb)
        return recs

    def close(self):
        """Sign the pass. Refuses if the journal on disk doesn't reproduce the root."""
        try:
            if self.tree.size == 0:
                raise RefuseToSign("empty pass")
            recs = self._journal_records()
            hashes = [mc._leaf(r) for r in recs]
            if len(recs) != self.tree.size or mc.root_from_leaf_hashes(hashes) != self.tree.root():
                raise RefuseToSign("journal does not reproduce the in-memory root")
        except RefuseToSign as e:
            self._tele("REFUSED_TO_SIGN", eden_tick=self.tree.size, note=str(e))
            if self.tele is not None:
                self.tele.flush(sync=True)
            raise
        for name, m in sorted(self.models.items()):
            if m["path"] is not None:
                try:
                    now = _file_sha256(m["path"])
                except OSError:
                    now = None
                if now != m["sha256"]:
                    self.status = "DEGRADED"
                    self.model_events.append({"model": name, "event": "CHANGED_DURING_PASS"})
        root = self.tree.root()
        self._tele("PASS_CLOSE", eden_tick=self.tree.size, output_hash=root.hex(),
                   note="status=%s" % self.status)
        if self.tele is not None:
            self.tele.flush(sync=True)
        usage_rec = None
        if self.allocation is not None:
            usage_rec = cb.usage(self.seed, self.allocation, self.pass_id, self.budget_used)
            _write_atomic(os.path.join(self.out, "budget_usage.json"), mc.canon(usage_rec))
        cons = []
        for cp in self.checkpoints:
            if cp["n"] > len(hashes):
                raise RefuseToSign("journal shorter than checkpoint %d" % cp["seq"])
            proof = mc.consistency_proof_from_hashes(hashes, cp["n"])
            cons.append({"seq": cp["seq"], "n": cp["n"], "root": cp["root"],
                         "proof": [h.hex() for h in proof]})
        body = {"v": 2, "pass": self.pass_id, "n": self.tree.size,
                "root": root.hex(), "status": self.status,
                "quarantined": self.quarantined, "ncp": len(self.checkpoints),
                "cp_hash": hashlib.sha256(mc.canon(
                    [[c["seq"], c["n"], c["root"]] for c in self.checkpoints])).hexdigest(),
                "models": {k: v["sha256"] for k, v in sorted(self.models.items())},
                "model_events": self.model_events,
                "telemetry": self.tele.summary() if self.tele is not None else None,
                "budget": None if usage_rec is None else {
                    "allocation": self.allocation["id"], "amount": self.allocation["amount"],
                    "used": self.budget_used, "usage_id": usage_rec["id"]},
                "key": mc.key_id(self.pub),
                "clock": {"t": round(time.time(), 3), "label": "UNTRUSTED"}}
        bundle = dict(body, sig=mc.sign(self.seed, BUNDLE_DOMAIN + mc.canon(body)).hex())
        bp = os.path.join(self.out, "bundle.json")
        _write_atomic(bp, mc.canon(bundle))
        if cons:
            _write_atomic(os.path.join(self.out, "consistency.json"), mc.canon(cons))
        self.closed = True
        return bp

    def budget_remaining(self):
        if self.allocation is None:
            return None
        return self.allocation["amount"] - self.budget_used

    # ---------------------------------------------------------------- spot checks
    def proof_for(self, index):
        """Answer a ground request: the record at `index` plus its audit path."""
        recs = self._journal_records()
        hashes = [mc._leaf(r) for r in recs]
        path = mc.inclusion_proof_from_hashes(hashes, index)
        return {"record": json.loads(recs[index]), "index": index,
                "path": [h.hex() for h in path]}
