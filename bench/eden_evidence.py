"""eden_evidence.py - EDEN Evidence v1: a sealed, append-only decision log for any AI.

Reference implementation of EDEN_EVIDENCE_SPEC_v1.md. Satellites, robots, vehicles and
software agents all use the same format: entries are canonical JSON, chained into an
RFC 6962 Merkle tree, and periodically sealed with an Ed25519 signature. Each seal links
to the one before it and comes with a consistency proof, so history can only be appended,
never rewritten, even by the key holder, once a seal has been handed to someone else.

    log = EvidenceLog("robot-07", seed)
    i = log.append("decision", actor="robot-07", body={...}, input_bytes=frame)
    seal = log.seal()                       # give this to the insurer / OEM / custodian
    proof = log.inclusion(i, seal)          # ~1 kB, proves entry i is in that seal
    pack = log.pack()                       # everything an auditor needs
    verify_pack(pack, pub)                  # -> ("OK", detail) or (ERROR_CODE, detail)

Rules that keep every language byte-identical (spec section 3):
  - canonical JSON: sorted keys, no whitespace, UTF-8, integers only (no floats/exponents),
    integers within +/- 2**53 - 1. Decimals go in strings ("0.93").
"""
import copy as _copy
import datetime as _dt
import hashlib
import json

import marble_core as mc

VERSION = 1
SEAL_DOMAIN = b"EDEN-EVIDENCE-SEAL-v1\x00"
MAX_INT = 2 ** 53 - 1
GENESIS = "0" * 64

OK = "OK"
E_FORMAT, E_FLOAT, E_KEY, E_SIG = "BAD_FORMAT", "FLOAT_FORBIDDEN", "WRONG_KEY", "BAD_SIGNATURE"
E_ROOT, E_INDEX, E_INCL, E_CONS, E_CHAIN = "BAD_ROOT", "INDEX_MISMATCH", "BAD_INCLUSION", "BAD_CONSISTENCY", "BAD_SEAL_CHAIN"


class EvidenceError(ValueError):
    pass


def now_utc():
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def check_value(v, path="$"):
    """Raise EvidenceError if v contains anything the spec forbids (floats, big ints, non-str keys)."""
    if isinstance(v, bool) or v is None or isinstance(v, str):
        return
    if isinstance(v, float):
        raise EvidenceError("%s: floats are forbidden; use an integer or a decimal string" % path)
    if isinstance(v, int):
        if abs(v) > MAX_INT:
            raise EvidenceError("%s: integer outside +/- 2^53-1" % path)
        return
    if isinstance(v, list):
        for k, x in enumerate(v):
            check_value(x, "%s[%d]" % (path, k))
        return
    if isinstance(v, dict):
        for k, x in v.items():
            if not isinstance(k, str):
                raise EvidenceError("%s: object keys must be strings" % path)
            check_value(x, "%s.%s" % (path, k))
        return
    raise EvidenceError("%s: unsupported type %s" % (path, type(v).__name__))


def canon(v):
    check_value(v)
    return mc.canon(v)


def sha_hex(b):
    return hashlib.sha256(b).hexdigest()


def leaf_hash(entry):
    return mc._leaf(canon(entry))


def seal_id(seal):
    """Hash identifying a seal (used by the next seal's prev_seal)."""
    return sha_hex(SEAL_DOMAIN + canon(seal))


# ------------------------------------------------------------------ writer
class EvidenceLog:
    def __init__(self, log_id, seed, clock=now_utc):
        if not isinstance(seed, (bytes, bytearray)) or len(seed) != 32:
            raise EvidenceError("seed must be 32 bytes")
        self.log_id, self.seed, self.clock = log_id, bytes(seed), clock
        self.pub = mc.public_from_seed(self.seed)
        self.key = mc.key_id(self.pub)
        self.entries, self.hashes = [], []
        self.tree = mc.StreamingTree()
        self.seals = []

    def append(self, kind, actor, body=None, input_bytes=None, input_sha256=None, model=None, t=None):
        if input_bytes is not None:
            input_sha256 = sha_hex(input_bytes)
        e = {"v": VERSION, "log": self.log_id, "i": len(self.entries), "t": t or self.clock(),
             "kind": kind, "actor": actor, "input": input_sha256, "model": model, "body": body or {}}
        lh = leaf_hash(e)                       # validates (no floats etc.) before anything changes
        self.entries.append(e)
        self.hashes.append(lh)
        self.tree.append_leaf_hash(lh)
        return e["i"]

    def seal(self, t=None, note=None):
        prev = self.seals[-1] if self.seals else None
        s = {"v": VERSION, "type": "seal", "log": self.log_id, "seq": len(self.seals),
             "n": self.tree.size, "root": self.tree.root().hex(), "t": t or self.clock(),
             "key": self.key, "prev_seal": seal_id(prev) if prev else GENESIS}
        if note is not None:
            s["note"] = note
        s["sig"] = mc.sign(self.seed, SEAL_DOMAIN + canon(s)).hex()
        self.seals.append(s)
        return _copy.deepcopy(s)

    def inclusion(self, i, seal):
        if not 0 <= i < seal["n"]:
            raise EvidenceError("entry %d is not covered by seal %d" % (i, seal["seq"]))
        path = mc.inclusion_proof_from_hashes(self.hashes[:seal["n"]], i)
        return _copy.deepcopy({"v": VERSION, "type": "inclusion", "entry": self.entries[i], "seal": seal,
                               "path": [p.hex() for p in path]})   # copies: callers can't alter the log

    def consistency(self, a, b):
        if not (0 < a["n"] <= b["n"]):
            raise EvidenceError("need 0 < first.n <= second.n")
        path = mc.consistency_proof_from_hashes(self.hashes[:b["n"]], a["n"]) if a["n"] < b["n"] else []
        return _copy.deepcopy({"v": VERSION, "type": "consistency", "from": a, "to": b, "path": [p.hex() for p in path]})

    def pack(self):
        """Everything an auditor needs: entries, every seal, consistency proofs between seals."""
        if not self.seals:
            raise EvidenceError("seal the log first")
        last = self.seals[-1]
        cons = []
        for a, b in zip(self.seals, self.seals[1:]):
            if a["n"] > 0:
                cons.append(self.consistency(a, b)["path"])
            else:
                cons.append([])
        return _copy.deepcopy({"v": VERSION, "type": "pack", "log": self.log_id, "pub": self.pub.hex(),
                               "entries": self.entries[:last["n"]], "seals": self.seals, "consistency": cons})


# ------------------------------------------------------------------ verifier
def _sig_ok(seal, pub):
    body = {k: v for k, v in seal.items() if k != "sig"}
    try:
        return mc.verify(pub, SEAL_DOMAIN + canon(body), bytes.fromhex(seal["sig"]))
    except (ValueError, KeyError, TypeError):
        return False


def verify_seal(seal, pub):
    try:
        check_value(seal)
    except EvidenceError as e:
        return E_FLOAT if "float" in str(e) else E_FORMAT, str(e)
    need = {"v", "type", "log", "seq", "n", "root", "t", "key", "prev_seal", "sig"}
    if not isinstance(seal, dict) or not need <= set(seal) or seal.get("type") != "seal" or seal.get("v") != VERSION:
        return E_FORMAT, "not a v1 seal"
    if seal["key"] != mc.key_id(pub):
        return E_KEY, "seal names key %s, expected %s" % (seal["key"], mc.key_id(pub))
    if not _sig_ok(seal, pub):
        return E_SIG, "seal %d signature invalid" % seal["seq"]
    return OK, "seal %d valid (n=%d)" % (seal["seq"], seal["n"])


def verify_inclusion(bundle, pub):
    code, why = verify_seal(bundle.get("seal"), pub)
    if code != OK:
        return code, why
    e, s = bundle.get("entry"), bundle["seal"]
    try:
        data = canon(e)
    except EvidenceError as ex:
        return (E_FLOAT if "float" in str(ex) else E_FORMAT), str(ex)
    if not isinstance(e, dict) or e.get("log") != s["log"] or not isinstance(e.get("i"), int):
        return E_FORMAT, "entry does not belong to this log"
    try:
        path = [bytes.fromhex(p) for p in bundle.get("path", [])]
    except ValueError:
        return E_FORMAT, "bad path hex"
    if not mc.verify_inclusion(data, e["i"], s["n"], path, bytes.fromhex(s["root"])):
        return E_INCL, "entry %d is not in seal %d" % (e["i"], s["seq"])
    return OK, "entry %d is in seal %d" % (e["i"], s["seq"])


def verify_consistency(bundle, pub):
    a, b = bundle.get("from"), bundle.get("to")
    for s in (a, b):
        code, why = verify_seal(s, pub)
        if code != OK:
            return code, why
    if a["log"] != b["log"]:
        return E_FORMAT, "seals from different logs"
    try:
        path = [bytes.fromhex(p) for p in bundle.get("path", [])]
    except ValueError:
        return E_FORMAT, "bad path hex"
    if not mc.verify_consistency(a["n"], b["n"], bytes.fromhex(a["root"]), bytes.fromhex(b["root"]), path):
        return E_CONS, "seal %d does not extend seal %d: history was rewritten" % (b["seq"], a["seq"])
    return OK, "seal %d extends seal %d" % (b["seq"], a["seq"])


def verify_pack(pack, pub, held_seals=()):
    """Full audit. held_seals: seals received earlier by a third party (e.g. at incident time).
    Each must be in this pack unchanged, or be provably extended by it."""
    try:
        check_value(pack)
    except EvidenceError as e:
        return (E_FLOAT if "float" in str(e) else E_FORMAT), str(e)
    if not isinstance(pack, dict) or pack.get("type") != "pack" or pack.get("v") != VERSION:
        return E_FORMAT, "not a v1 pack"
    if pack.get("pub") != pub.hex():
        return E_KEY, "pack signed with a different key"
    seals, entries = pack.get("seals") or [], pack.get("entries") or []
    if not seals:
        return E_FORMAT, "no seals"
    prev = None
    for k, s in enumerate(seals):
        code, why = verify_seal(s, pub)
        if code != OK:
            return code, why
        if s["seq"] != k or s["log"] != pack["log"]:
            return E_CHAIN, "seal %d out of sequence" % k
        if s["prev_seal"] != (seal_id(prev) if prev else GENESIS):
            return E_CHAIN, "seal %d does not link to seal %d" % (k, k - 1)
        if prev is not None:
            path = [bytes.fromhex(p) for p in pack["consistency"][k - 1]]
            if prev["n"] > s["n"] or (prev["n"] > 0 and not mc.verify_consistency(
                    prev["n"], s["n"], bytes.fromhex(prev["root"]), bytes.fromhex(s["root"]), path)):
                return E_CONS, "seal %d does not extend seal %d" % (k, k - 1)
        prev = s
    if len(entries) != seals[-1]["n"]:
        return E_ROOT, "pack has %d entries, final seal covers %d" % (len(entries), seals[-1]["n"])
    hashes = []
    for k, e in enumerate(entries):
        if not isinstance(e, dict) or e.get("i") != k or e.get("log") != pack["log"]:
            return E_INDEX, "entry at position %d is numbered %r" % (k, e.get("i") if isinstance(e, dict) else None)
        hashes.append(leaf_hash(e))
    for s in seals:                                   # every seal's root must match the entries it covers
        if mc.root_from_leaf_hashes(hashes[:s["n"]]).hex() != s["root"]:
            return E_ROOT, "entries do not reproduce seal %d's root" % s["seq"]
    for h in held_seals:                              # third-party copies
        code, why = verify_seal(h, pub)
        if code != OK:
            return code, "held seal: " + why
        if h["n"] > len(entries) or mc.root_from_leaf_hashes(hashes[:h["n"]]).hex() != h["root"]:
            return E_CONS, "a seal handed out at %s (n=%d) is not a prefix of this log: history was rewritten" % (h["t"], h["n"])
    return OK, "%d entries, %d seals, chain and roots verified" % (len(entries), len(seals))
