"""EDEN ground-side verifier and key provisioning (v2 rebuild).

    python3 ground.py keygen KEYDIR          # creates seed.hex (for the satellite) + pub.hex (stays on ground)
    python3 ground.py verify OUTDIR PUBHEX   # verify everything a pass downlinked

Every check takes the PINNED public key, held by the ground segment.
A verified record proves what was decided, by which model, on which input.
It does not prove the decision was right.
"""
import hashlib
import json
import os
import sys

import marble_core as mc
from onboard import BUNDLE_DOMAIN, CHECKPOINT_DOMAIN


def keygen(keydir):
    os.makedirs(keydir, exist_ok=True)
    seed = os.urandom(32)
    pub = mc.public_from_seed(seed)
    with open(os.path.join(keydir, "seed.hex"), "w") as f:
        f.write(seed.hex())
    with open(os.path.join(keydir, "pub.hex"), "w") as f:
        f.write(pub.hex())
    return pub


def _sig_ok(obj, domain, pub):
    body = {k: v for k, v in obj.items() if k != "sig"}
    try:
        sig = bytes.fromhex(obj["sig"])
    except (KeyError, ValueError):
        return False
    return obj.get("key") == mc.key_id(pub) and mc.verify(pub, domain + mc.canon(body), sig)


def verify_bundle(bundle, pub):
    """Signature + shape. Returns (ok, reason)."""
    if bundle.get("v") != 2:
        return False, "unknown version"
    if not _sig_ok(bundle, BUNDLE_DOMAIN, pub):
        return False, "bad signature"
    return True, bundle["status"]


def _path(p):
    return [bytes.fromhex(x) for x in p]


def verify_proof(bundle, pkg, pub):
    """Spot check: is this record (e.g. a discarded tile) in the signed pass?"""
    ok, why = verify_bundle(bundle, pub)
    if not ok:
        return False, why
    rec = pkg["record"]
    if rec.get("pass") != bundle["pass"] or rec.get("i") != pkg["index"]:
        return False, "record does not belong to this pass/index"
    if not mc.verify_inclusion(mc.canon(rec), pkg["index"], bundle["n"],
                               _path(pkg["path"]), bytes.fromhex(bundle["root"])):
        return False, "inclusion proof fails"
    return True, "included"


def verify_journal(bundle, journal_path, pub):
    """Full audit: does a downlinked journal reproduce the signed root?"""
    ok, why = verify_bundle(bundle, pub)
    if not ok:
        return False, why
    recs = []
    with open(journal_path, "rb") as f:
        for ln in f:
            recs.append(mc.canon(json.loads(ln)["rec"]))
    if len(recs) != bundle["n"] or mc.merkle_root(recs).hex() != bundle["root"]:
        return False, "journal does not reproduce the signed root"
    return True, "journal matches"


def verify_alert(pkg, pub):
    """Verify an alert the moment it arrives, before the pass ends."""
    cp = pkg.get("checkpoint", {})
    if not _sig_ok(cp, CHECKPOINT_DOMAIN, pub):
        return False, "bad checkpoint signature"
    rec = pkg["record"]
    if rec.get("action") != "ALERT" or rec.get("pass") != cp.get("pass"):
        return False, "not an alert for this pass"
    if rec.get("i") != pkg["index"] or pkg["index"] != cp["n"] - 1:
        return False, "alert is not the record the checkpoint was cut at"
    if not mc.verify_inclusion(mc.canon(rec), pkg["index"], cp["n"],
                               _path(pkg["path"]), bytes.fromhex(cp["root"])):
        return False, "inclusion proof fails"
    return True, "alert verified"


def verify_checkpoints(bundle, consistency, pub, received=None):
    """Prove the final pass EXTENDS every checkpoint the ground already holds.

    `received` = checkpoints taken from alerts as they arrived. Those are the
    ground's own copies, so a key holder who rewrote history later and
    re-signed can't make the final root consistent with them.
    """
    ok, why = verify_bundle(bundle, pub)
    if not ok:
        return False, why
    consistency = consistency or []
    listed = [[c["seq"], c["n"], c["root"]] for c in consistency]
    if hashlib.sha256(mc.canon(listed)).hexdigest() != bundle["cp_hash"] \
            or len(listed) != bundle["ncp"]:
        return False, "checkpoint list does not match the signed bundle"
    by_seq = {c["seq"]: c for c in consistency}
    for cp in (received or []):
        c = by_seq.get(cp["seq"])
        if c is None or c["n"] != cp["n"] or c["root"] != cp["root"]:
            return False, "received checkpoint %d missing or altered" % cp["seq"]
    for c in consistency:
        if not mc.verify_consistency(c["n"], bundle["n"], bytes.fromhex(c["root"]),
                                     bytes.fromhex(bundle["root"]), _path(c["proof"])):
            return False, "pass does not extend checkpoint %d" % c["seq"]
    return True, "extends %d checkpoint(s)" % len(consistency)


def verify_retained(record, data):
    """Does a retained/downlinked image match what the record committed to?"""
    return hashlib.sha256(data).hexdigest() == record.get("input_sha256")


def verify_model(record, model_bytes=None, model_sha256=None):
    """Did THIS exact model (weights file) make the decision in `record`?"""
    if model_bytes is not None:
        model_sha256 = hashlib.sha256(model_bytes).hexdigest()
    return record.get("model_sha256") is not None and record["model_sha256"] == model_sha256


def verify_telemetry(bundle, telemetry_path, pub, journal_path=None):
    """MARBLE/1.0 stream: chain intact, matches the head SIGNED in the bundle,
    and (with the journal) every event points at a real receipt."""
    import telemetry
    ok, why = verify_bundle(bundle, pub)
    if not ok:
        return False, why
    if not bundle.get("telemetry"):
        return False, "bundle carries no telemetry summary"
    ok, why = telemetry.verify_stream(telemetry_path, bundle["telemetry"], journal_path)
    if ok and bundle["telemetry"]["status"] != "OK":
        why += " | stream status " + bundle["telemetry"]["status"]
    return ok, why


def verify_budget_usage(bundle, usage_rec, journal_path, pub):
    """Audit the satellite's USAGE claim: signed bundle names it, and the journal's
    KEEP/ALERT payload bytes add up to exactly the bytes it says it used."""
    ok, why = verify_bundle(bundle, pub)
    if not ok:
        return False, why
    b = bundle.get("budget")
    if not b or b["usage_id"] != usage_rec.get("id") or b["used"] != usage_rec.get("used"):
        return False, "usage record is not the one signed into the bundle"
    used = 0
    with open(journal_path, "rb") as f:
        for ln in f:
            r = json.loads(ln)["rec"]
            if r["action"] in ("KEEP", "ALERT"):
                used += r.get("bytes") or 0
    if used != usage_rec["used"]:
        return False, "journal shows %d payload bytes, usage claims %d" % (used, usage_rec["used"])
    return True, "usage %d of %d bytes matches the journal" % (used, b["amount"])


def _cli(argv):
    if len(argv) >= 2 and argv[0] == "keygen":
        pub = keygen(argv[1])
        print("key_id", mc.key_id(pub), "->", argv[1])
        return 0
    if len(argv) >= 3 and argv[0] == "verify":
        out, pub = argv[1], bytes.fromhex(open(argv[2]).read().strip()
                                          if os.path.exists(argv[2]) else argv[2])
        bundle = json.load(open(os.path.join(out, "bundle.json")))
        alerts, rc = [], 0
        for name in sorted(os.listdir(out)):
            if name.startswith("alert_"):
                pkg = json.load(open(os.path.join(out, name)))
                ok, why = verify_alert(pkg, pub)
                print(name, "PASS" if ok else "FAIL", why)
                rc |= not ok
                alerts.append(pkg["checkpoint"])
        cpath = os.path.join(out, "consistency.json")
        cons = json.load(open(cpath)) if os.path.exists(cpath) else []
        ok, why = verify_checkpoints(bundle, cons, pub, alerts)
        print("bundle", "PASS" if ok else "FAIL", why, "| status", bundle["status"])
        for name, h in sorted(bundle.get("models", {}).items()):
            print("model", name, h[:16] + "...")
        for ev in bundle.get("model_events", []):
            print("MODEL EVENT", ev)
        return rc | (not ok)
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(_cli(sys.argv[1:]))
