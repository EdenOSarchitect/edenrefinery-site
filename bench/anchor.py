"""Ground-side anchoring of received bundles (v2).

Two layers:

1. ANCHOR LOG (implemented, tested). An append-only, hash-chained log of every
   bundle the ground receives: entry k commits to entry k-1. Rewriting an old
   entry breaks every hash after it.

2. EXTERNAL TIMESTAMP (optional). After each append, the log's head hash is
   written to anchors/head_NNNNNN.txt and, if the OpenTimestamps client is
   installed (`pip install opentimestamps-client`), stamped with `ots stamp`.
   That ties the head to the Bitcoin blockchain via public calendars, so
   nobody - including whoever runs this ground station or holds the satellite
   key - can later rewrite a pass that was anchored, without it showing.
   Needs network access. Verify a stamp later with `ots verify head_NNNNNN.txt.ots`.

Status: layer 1 IMPLEMENTED; layer 2 PROPOSED until a stamp is made and
verified on a networked machine. A local log alone does NOT stop the ground
operator rewriting their own log - only the external stamp does.

    python3 anchor.py add ANCHORDIR path/to/bundle.json    # log + (optional) stamp
    python3 anchor.py verify ANCHORDIR                      # check the chain
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time

import marble_core as mc

GENESIS = "0" * 64


def _entry_hash(entry):
    body = {k: v for k, v in entry.items() if k != "h"}
    return hashlib.sha256(b"EDEN-ANCHOR-v2\x00" + mc.canon(body)).hexdigest()


def _log_path(anchor_dir):
    return os.path.join(anchor_dir, "anchor_log.jsonl")


def read_log(anchor_dir):
    p = _log_path(anchor_dir)
    if not os.path.exists(p):
        return []
    with open(p, "rb") as f:
        return [json.loads(ln) for ln in f if ln.strip()]


def verify_log(anchor_dir):
    """Returns (ok, reason). Checks every link in the chain."""
    prev = GENESIS
    log = read_log(anchor_dir)
    for k, e in enumerate(log):
        if e.get("seq") != k or e.get("prev") != prev or e.get("h") != _entry_hash(e):
            return False, "chain broken at entry %d" % k
        prev = e["h"]
    return True, "chain intact (%d entries)" % len(log)


def head(anchor_dir):
    log = read_log(anchor_dir)
    return log[-1]["h"] if log else GENESIS


def add_bundle(anchor_dir, bundle_bytes, stamp=True):
    """Append a received bundle to the anchor log; optionally stamp the new head.

    Returns (entry, stamp_status) where stamp_status is one of
    STAMPED / NO_CLIENT / FAILED: <reason> / SKIPPED.
    """
    os.makedirs(anchor_dir, exist_ok=True)
    ok, why = verify_log(anchor_dir)
    if not ok:
        raise RuntimeError("refusing to extend a broken anchor log: " + why)
    log = read_log(anchor_dir)
    bundle = json.loads(bundle_bytes)
    entry = {"seq": len(log), "prev": log[-1]["h"] if log else GENESIS,
             "bundle_sha256": hashlib.sha256(bundle_bytes).hexdigest(),
             "pass": bundle.get("pass"), "n": bundle.get("n"), "root": bundle.get("root"),
             "received": {"t": round(time.time(), 3), "label": "GROUND CLOCK"}}
    entry["h"] = _entry_hash(entry)
    with open(_log_path(anchor_dir), "ab") as f:
        f.write(mc.canon(entry) + b"\n")
        f.flush()
        os.fsync(f.fileno())
    hp = os.path.join(anchor_dir, "head_%06d.txt" % entry["seq"])
    with open(hp, "w") as f:
        f.write(entry["h"] + "\n")
    status = "SKIPPED"
    if stamp:
        if shutil.which("ots") is None:
            status = "NO_CLIENT"
        else:
            try:
                r = subprocess.run(["ots", "stamp", hp], capture_output=True,
                                   text=True, timeout=60)
                status = "STAMPED" if r.returncode == 0 else "FAILED: " + r.stderr.strip()[:200]
            except Exception as e:  # network, timeout
                status = "FAILED: %s" % e
    return entry, status


def find_bundle(anchor_dir, bundle_bytes):
    """Was this exact bundle anchored? Returns the log entry or None."""
    h = hashlib.sha256(bundle_bytes).hexdigest()
    for e in read_log(anchor_dir):
        if e["bundle_sha256"] == h:
            return e
    return None


def _cli(argv):
    if len(argv) == 3 and argv[0] == "add":
        with open(argv[2], "rb") as f:
            entry, status = add_bundle(argv[1], f.read())
        print("anchored seq %d head %s... | external stamp: %s" % (entry["seq"], entry["h"][:16], status))
        return 0
    if len(argv) == 2 and argv[0] == "verify":
        ok, why = verify_log(argv[1])
        print("PASS" if ok else "FAIL", why)
        return 0 if ok else 1
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(_cli(sys.argv[1:]))
