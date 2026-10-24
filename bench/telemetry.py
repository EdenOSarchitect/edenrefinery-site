"""MARBLE/1.0 telemetry for the on-board recorder (v2.2).

Rule: TELEMETRY OBSERVES, NEVER ALTERS THE COMPUTATION.
  - Telemetry is written beside the signed receipts, never into the Merkle tree.
  - A telemetry failure (full disk, bad path, exception) can never change or
    block a decision record. It only marks the telemetry stream GAPPED.
  - Writes are buffered and flushed at checkpoints and close, so telemetry costs
    no extra fsync per tile. A power cut can lose the unflushed tail; recovery
    detects that and marks the stream GAPPED rather than hiding it.

Each envelope follows the MARBLE/1.0 packet from the 3 Oct 2026 schema:
identity, time, source, state, chrysalis, bandwidth, keep, entropy, ledger.
Fields this recorder does not measure are null with status NOT_MEASURED -
never filled with placeholder numbers. Two extensions are added:
  "receipt": links the envelope to the signed record (pass, index, leaf hash)
  "label" fields: evidence labels (e.g. clock UNTRUSTED, bytes PLANNED)

Ledger chain: packet_hash = SHA256("MARBLE/1.0" domain || canonical JSON of the
envelope with previous_hash set and packet_hash removed). Canonical JSON with a
domain tag replaces the schema's raw concatenation H(t-1)||I||X||C||B||K, which
is ambiguous at field boundaries.
"""
import datetime
import hashlib
import json
import os
import time
import uuid

import marble_core as mc

SCHEMA = "MARBLE/1.0"
DOMAIN = b"MARBLE/1.0\x00"
GENESIS = "0" * 64
NOT_MEASURED = {"status": "NOT_MEASURED"}


def packet_hash(env):
    mb = dict(env["marble"])
    mb["ledger"] = {k: v for k, v in mb["ledger"].items() if k != "packet_hash"}
    return hashlib.sha256(DOMAIN + mc.canon({"marble": mb})).hexdigest()


class MarbleTelemetry:
    """Hash-chained MARBLE/1.0 stream. Never raises into the caller."""

    def __init__(self, path, node_id="sat-001", flush_every=256):
        self.path = path
        self.node_id = node_id
        self.runtime_id = str(uuid.uuid4())   # new per boot/recorder instance
        self.flush_every = flush_every
        self.buf = []
        self.seq = 0
        self.head = GENESIS
        self.status = "OK"
        self.errors = 0
        try:
            self._recover()
        except Exception:
            self._gap()

    def _gap(self):
        self.status = "GAPPED"
        self.errors += 1

    def _recover(self):
        if not os.path.exists(self.path):
            return
        with open(self.path, "rb") as f:
            raw = f.read()
        lines = raw.split(b"\n")
        tail = lines.pop()
        good = []
        prev = GENESIS
        for ln in lines:
            try:
                env = json.loads(ln)
                led = env["marble"]["ledger"]
                ok = (led["previous_hash"] == prev and led["chain_index"] == len(good)
                      and led["packet_hash"] == packet_hash(env))
            except Exception:
                ok = False
            if not ok:
                break
            good.append(ln)
            prev = led["packet_hash"]
        if tail or len(good) != len(lines):
            self._gap()                     # unflushed tail lost or chain broken
            with open(self.path + ".broken.%d" % int(time.time()), "wb") as f:
                f.write(raw)
            with open(self.path, "wb") as f:
                f.write(b"".join(x + b"\n" for x in good))
        self.seq, self.head = len(good), prev
        if self.status == "GAPPED":
            self.emit("TELEMETRY_GAP", note="stream recovered after loss or corruption")

    # ------------------------------------------------------------------ emit
    def emit(self, kind, receipt=None, eden_tick=None, model=None, model_sha256=None,
             input_hash=None, output_hash=None, raw_bytes=None, planned_bytes=None,
             kept=None, score=None, note=None):
        try:
            if raw_bytes is not None and planned_bytes is not None:
                ratio = round(raw_bytes / planned_bytes, 6) if planned_bytes else None
            else:
                ratio = None
            env = {"marble": {
                "schema": SCHEMA,
                "event_id": str(uuid.uuid4()),
                "event_kind": kind,
                "sequence": self.seq,
                "time": {"wall_utc": datetime.datetime.now(datetime.timezone.utc)
                                     .isoformat(timespec="milliseconds"),
                         "monotonic_ns": time.monotonic_ns(),
                         "eden_tick": eden_tick,
                         "label": "UNTRUSTED"},
                "source": {"node_id": self.node_id, "runtime_id": self.runtime_id,
                           "operator": model or "EDEN-Onboard",
                           "operator_version": model_sha256},
                "state": {"input_hash": input_hash, "output_hash": output_hash,
                          "dimension": None},
                "chrysalis": dict(NOT_MEASURED, fractal_light_integral=None, resonance=None,
                                  curvature=None, coherence=None, transition_delta=None),
                "bandwidth": {"raw": raw_bytes, "effective": planned_bytes,
                              "compression_ratio": ratio,
                              "state": None if planned_bytes is None else "PLANNED",
                              "label": "planned downlink bytes, not a link measurement"},
                "keep": {"projected": kept, "projection_score": score,
                         "state_hash": input_hash if kept else None},
                "entropy": dict(NOT_MEASURED, input=None, output=None, delta=None, score=None),
                "receipt": receipt,
                "note": note,
                "ledger": {"previous_hash": self.head, "packet_hash": None,
                           "chain_index": self.seq},
            }}
            led = env["marble"]["ledger"]
            del led["packet_hash"]
            h = hashlib.sha256(DOMAIN + mc.canon(env)).hexdigest()
            led["packet_hash"] = h
            self.buf.append(mc.canon(env) + b"\n")
            self.head, self.seq = h, self.seq + 1
            if len(self.buf) >= self.flush_every:
                self.flush()
        except Exception:
            self._gap()

    def flush(self, sync=False):
        if not self.buf:
            return
        try:
            with open(self.path, "ab") as f:
                f.write(b"".join(self.buf))
                f.flush()
                if sync:
                    os.fsync(f.fileno())
            self.buf = []
        except Exception:
            self.buf = []
            self._gap()

    def summary(self):
        return {"schema": SCHEMA, "count": self.seq, "head": self.head,
                "status": self.status, "node_id": self.node_id}


def verify_stream(path, expected=None, journal_path=None):
    """Ground check of a downlinked telemetry stream.

    expected: the "telemetry" summary from a VERIFIED bundle (signed head + count).
    journal_path: if given, every receipt link must match the journal's leaf hash.
    Returns (ok, reason).
    """
    prev, n, envs = GENESIS, 0, []
    with open(path, "rb") as f:
        for ln in f:
            env = json.loads(ln)
            led = env["marble"]["ledger"]
            if (led["previous_hash"] != prev or led["chain_index"] != n
                    or led["packet_hash"] != packet_hash(env)):
                return False, "telemetry chain broken at %d" % n
            prev, n = led["packet_hash"], n + 1
            envs.append(env)
    if expected is not None and (expected["head"] != prev or expected["count"] != n):
        return False, "telemetry does not match the head signed in the bundle"
    if journal_path:
        leaves = []
        with open(journal_path, "rb") as f:
            for ln in f:
                leaves.append(hashlib.sha256(b"\x00" + mc.canon(json.loads(ln)["rec"])).hexdigest())
        for env in envs:
            r = env["marble"]["receipt"]
            if r and (r["i"] >= len(leaves) or leaves[r["i"]] != r["leaf_hash"]):
                return False, "telemetry event %d points at a receipt that doesn't match" \
                    % env["marble"]["sequence"]
    return True, "telemetry chain intact (%d events)" % n
