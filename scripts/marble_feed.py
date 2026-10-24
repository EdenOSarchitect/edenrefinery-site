"""marble_feed.py - wrap every file the globe uses in a MARBLE/1.0 envelope, chain them,
and seal the chain with EDEN's key. The browser checks the chain and each file's SHA-256
before it draws anything; a file that doesn't match its envelope is refused.

Envelopes follow MARBLE/1.0 as in eden_onboard/telemetry.py: packet_hash =
SHA256("MARBLE/1.0\\0" || canonical JSON of the envelope without packet_hash), each linking
to the previous. Rule kept: telemetry observes, never alters - files are hashed, not changed.
Numbers are integers only, so Python and JavaScript produce identical canonical bytes.

Usage: python scripts/marble_feed.py           (needs EDEN_SIGNING_SEED; pip install cryptography)
       python scripts/marble_feed.py --verify
"""
import datetime as dt, hashlib, json, os, re, sys, uuid

OUT, PUBFILE = "globe.marble.json", "eden_pubkey.txt"
FEED_DOMAIN = b"EDEN-MARBLE-FEED-v1\x00"
MARBLE_DOMAIN = b"MARBLE/1.0\x00"
GENESIS = "0" * 64
NOT_MEASURED = {"status": "NOT_MEASURED"}


def canon(v): return json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
def sha_hex(b): return hashlib.sha256(b).hexdigest()


def describe(path, data):
    if path == "tle.txt":
        n = sum(1 for ln in data.decode(errors="replace").splitlines() if ln.startswith("1 "))
        return "ORBIT_DATA", "%d satellites · CelesTrak" % n
    if path == "receptions.json":
        d = json.loads(data)
        return "RECEPTIONS", "%d real receptions · SatNOGS · EDEN-signed" % d.get("count", 0)
    if path == "land.geojson":
        return "LAND_OUTLINES", "Natural Earth 1:110m"
    if path.startswith("tex/"):
        layer = path[4:].split(".")[0].replace("_", " ")
        return "EARTH_IMAGERY", "%s · %d kB" % (layer, len(data) // 1024)
    return "FILE", path


def envelope(i, prev, path, data, now):
    kind, detail = describe(path, data)
    env = {"marble": {
        "schema": "MARBLE/1.0",
        "event_id": str(uuid.uuid4()),
        "event_kind": kind,
        "sequence": i,
        "time": {"wall_utc": now, "label": "UNTRUSTED"},
        "source": {"node_id": "edenrefinery.com/globe-feed", "operator": "EDEN globe feed", "operator_version": "1"},
        "state": {"input_hash": sha_hex(data), "output_hash": None, "dimension": None},
        "payload": {"path": path, "bytes": len(data), "sha256": sha_hex(data), "detail": detail},
        "chrysalis": dict(NOT_MEASURED),
        "bandwidth": {"raw": len(data), "effective": None, "compression_ratio": None, "state": "DELIVERED",
                      "label": "bytes the browser downloads"},
        "keep": {"projected": True, "projection_score": None, "state_hash": sha_hex(data)},
        "entropy": dict(NOT_MEASURED),
        "receipt": None,
        "note": "observes, never alters",
        "ledger": {"previous_hash": prev, "chain_index": i},
    }}
    env["marble"]["ledger"]["packet_hash"] = hashlib.sha256(MARBLE_DOMAIN + canon(env)).hexdigest()
    return env


def files():
    out = [p for p in ("tle.txt", "receptions.json", "land.geojson") if os.path.exists(p)]
    if os.path.isdir("tex"):
        out += sorted("tex/" + f for f in os.listdir("tex") if f.endswith(".jpg"))
    return out


def keys():
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives import serialization as S
    seed = os.environ.get("EDEN_SIGNING_SEED", "").strip()
    if not re.fullmatch(r"[0-9a-fA-F]{64}", seed): return None, None
    sk = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(seed))
    return sk, sk.public_key().public_bytes(S.Encoding.Raw, S.PublicFormat.Raw)


def verify(doc, pinned=None):
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    if pinned and pinned != doc["pub"]: return False, "key is not the published EDEN key"
    prev = GENESIS
    for i, e in enumerate(doc["stream"]):
        m = e["marble"]; led = m["ledger"]
        if m["sequence"] != i or led["chain_index"] != i or led["previous_hash"] != prev: return False, "chain broken at %d" % i
        c = json.loads(json.dumps(e)); del c["marble"]["ledger"]["packet_hash"]
        if hashlib.sha256(MARBLE_DOMAIN + canon(c)).hexdigest() != led["packet_hash"]: return False, "envelope %d altered" % i
        p = m["payload"]["path"]
        if os.path.exists(p) and sha_hex(open(p, "rb").read()) != m["payload"]["sha256"]: return False, "%s does not match" % p
        prev = led["packet_hash"]
    if doc["head"] != prev or doc["count"] != len(doc["stream"]): return False, "head or count mismatch"
    body = {k: v for k, v in doc.items() if k != "sig"}
    try: Ed25519PublicKey.from_public_bytes(bytes.fromhex(doc["pub"])).verify(bytes.fromhex(doc["sig"]), FEED_DOMAIN + canon(body))
    except Exception: return False, "signature invalid"
    return True, "OK: %d envelopes, head %s" % (doc["count"], doc["head"][:16])


def main(argv):
    pinned = open(PUBFILE).read().strip() if os.path.exists(PUBFILE) else None
    if "--verify" in argv:
        ok, why = verify(json.load(open(OUT)), pinned); print(("PASS " if ok else "FAIL ") + why); return 0 if ok else 1
    sk, pub = keys()
    if not sk: print("No EDEN_SIGNING_SEED; skipping MARBLE feed."); return 0
    if pinned and pinned != pub.hex(): print("Signing key differs from eden_pubkey.txt; refusing."); return 1
    now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    stream, prev = [], GENESIS
    for i, p in enumerate(files()):
        e = envelope(i, prev, p, open(p, "rb").read(), now); stream.append(e); prev = e["marble"]["ledger"]["packet_hash"]
    if not stream: print("Nothing to seal."); return 0
    doc = {"schema": "EDEN-MARBLE-FEED-v1",
           "what": "Every file the edenrefinery.com globe uses, each in a MARBLE/1.0 envelope, hash-chained and sealed by EDEN. "
                   "Satellite positions drawn from these files are modelled, not received.",
           "sealed_at": now, "count": len(stream), "head": prev, "pub": pub.hex(),
           "key": hashlib.sha256(pub).hexdigest()[:16], "stream": stream}
    doc["sig"] = sk.sign(FEED_DOMAIN + canon(doc)).hex()
    ok, why = verify(doc, pinned); assert ok, why
    json.dump(doc, open(OUT, "w"), ensure_ascii=False, indent=1)
    if not pinned: open(PUBFILE, "w").write(pub.hex() + "\n")
    print("sealed:", why)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
