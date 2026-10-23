"""satnogs_sign.py - fetch recent real satellite receptions from SatNOGS and seal them
with an EDEN signature, for the live "received · signed" pings on edenrefinery.com.

What this proves: that these are the receptions SatNOGS published at fetch time, and
that nobody has changed them since EDEN signed them. It does NOT prove what each
ground station actually heard; that needs signing at the station itself.

Data: SatNOGS Network (https://network.satnogs.org), (c) SatNOGS contributors,
CC BY-SA 4.0. The signed output (receptions.json) is shared under the same licence.

Usage
  python scripts/satnogs_sign.py                 # fetch, sign, write receptions.json
  python scripts/satnogs_sign.py --mock FILE     # sign a saved API response (testing)
  python scripts/satnogs_sign.py --verify        # check receptions.json yourself
Needs: pip install cryptography. Signing key: env EDEN_SIGNING_SEED (64 hex chars).
"""
import datetime as dt, hashlib, json, os, re, sys, urllib.request

API = "https://network.satnogs.org/api/observations/?status=good&format=json"
SCHEMA = "EDEN-SATNOGS-RECEIPTS-v1"
DOMAIN = (SCHEMA + "\0").encode()
OUT, PUBFILE = "receptions.json", "eden_pubkey.txt"
MAX_RECORDS, MAX_PAGES, MAX_AGE_H = 60, 4, 72


def canon(v):
    """Canonical JSON: sorted keys, no spaces, UTF-8. Only strings, ints, bools, null,
    lists and objects are used, so the browser produces exactly the same bytes."""
    return json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def sha(b): return hashlib.sha256(b).digest()


def merkle_root(leaves):                      # RFC 6962
    if not leaves: return sha(b"")
    if len(leaves) == 1: return leaves[0]
    k = 1
    while k * 2 < len(leaves): k *= 2
    return sha(b"\x01" + merkle_root(leaves[:k]) + merkle_root(leaves[k:]))


def leaf(rec): return sha(b"\x00" + canon(rec))


def clean(s, n=80):
    s = re.sub(r"[\x00-\x1f\x7f]", "", str(s or "")).strip()
    return s[:n]


def fix(x, nd=4):
    try: return ("%." + str(nd) + "f") % float(x)
    except (TypeError, ValueError): return None


def to_record(o):
    """Keep only public, display-relevant fields. Numbers that are not whole are stored
    as fixed-decimal strings so Python and JavaScript canonicalise them identically."""
    try:
        oid, norad = int(o["id"]), int(o["norad_cat_id"])
    except (KeyError, TypeError, ValueError):
        return None
    lat, lng = fix(o.get("station_lat")), fix(o.get("station_lng"))
    t1, t2 = clean(o.get("tle1"), 69), clean(o.get("tle2"), 69)
    if lat is None or lng is None or not (t1.startswith("1 ") and t2.startswith("2 ")):
        return None
    demod = o.get("demoddata")
    rec = {
        "obs": oid,
        "url": "https://network.satnogs.org/observations/%d/" % oid,
        "sat": clean(o.get("tle0") or "NORAD %d" % norad).removeprefix("0 "),
        "norad": norad,
        "station": clean(o.get("station_name")) or "Station %s" % o.get("ground_station"),
        "lat": lat, "lng": lng,
        "start": clean(o.get("start"), 32), "end": clean(o.get("end"), 32),
        "mode": clean(o.get("transmitter_mode"), 24),
        "frames": len(demod) if isinstance(demod, list) else 0,
        "tle1": t1, "tle2": t2,
    }
    if isinstance(o.get("ground_station"), int): rec["station_id"] = o["ground_station"]
    return rec


def fetch():
    url, rows = API, []
    for _ in range(MAX_PAGES):
        req = urllib.request.Request(url, headers={"User-Agent": "EDEN-Refinery-site/1 (+https://edenrefinery.com)",
                                                   "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=60) as r:
            body = json.load(r); link = r.headers.get("Link", "")
        page = body.get("results", []) if isinstance(body, dict) else body
        rows += page
        nxt = body.get("next") if isinstance(body, dict) else None
        if not nxt:
            m = re.search(r'<([^>]+)>;\s*rel="next"', link); nxt = m and m.group(1)
        if not nxt or len(rows) >= MAX_RECORDS * 2: break
        url = nxt
    return rows


def parse_time(s):
    try: return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError: return None


def build(rows, now):
    if rows: print("SatNOGS fields seen:", ", ".join(sorted(rows[0].keys())))
    recs, seen = [], set()
    for o in rows:
        r = to_record(o)
        if not r or r["obs"] in seen: continue
        t = parse_time(r["end"]) or parse_time(r["start"])
        if t is None or t.tzinfo is None or (now - t).total_seconds() > MAX_AGE_H * 3600 or t > now: continue
        seen.add(r["obs"]); recs.append(r)
    recs.sort(key=lambda r: r["start"], reverse=True)
    return recs[:MAX_RECORDS]


def keys():
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives import serialization as S
    seed = os.environ.get("EDEN_SIGNING_SEED", "").strip()
    if not re.fullmatch(r"[0-9a-fA-F]{64}", seed):
        return None, None
    sk = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(seed))
    pub = sk.public_key().public_bytes(S.Encoding.Raw, S.PublicFormat.Raw)
    return sk, pub


def sign(recs, now, sk, pub):
    doc = {
        "schema": SCHEMA,
        "what": "Recent good-quality receptions published by the SatNOGS Network, sealed by EDEN at fetch time. "
                "Proves these records are unchanged since then; does not prove what each station heard.",
        "source": "SatNOGS Network, https://network.satnogs.org",
        "licence": "CC BY-SA 4.0. Data (c) SatNOGS contributors; this signed file is shared under the same licence.",
        "fetched_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "count": len(recs),
        "root": merkle_root([leaf(r) for r in recs]).hex(),
        "pub": pub.hex(),
        "key": sha(pub).hex()[:16],
        "records": recs,
    }
    doc["sig"] = sk.sign(DOMAIN + canon(doc)).hex()
    return doc


def verify(doc, pinned_hex=None):
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    body = {k: v for k, v in doc.items() if k != "sig"}
    pub = bytes.fromhex(doc["pub"])
    if pinned_hex and pinned_hex != doc["pub"]: return False, "key does not match the published EDEN key"
    if doc.get("key") != sha(pub).hex()[:16]: return False, "key id mismatch"
    if merkle_root([leaf(r) for r in doc["records"]]).hex() != doc["root"]: return False, "records do not match root"
    if doc.get("count") != len(doc["records"]): return False, "count mismatch"
    try: Ed25519PublicKey.from_public_bytes(pub).verify(bytes.fromhex(doc["sig"]), DOMAIN + canon(body))
    except Exception: return False, "signature invalid"
    return True, "OK: %d receptions, signed %s, key %s" % (doc["count"], doc["fetched_at"], doc["key"])


def main(argv):
    if "--verify" in argv:
        doc = json.load(open(OUT, encoding="utf-8"))
        pinned = open(PUBFILE).read().strip() if os.path.exists(PUBFILE) else None
        ok, why = verify(doc, pinned); print(("PASS " if ok else "FAIL ") + why); return 0 if ok else 1
    sk, pub = keys()
    if not sk:
        print("No EDEN_SIGNING_SEED secret set; skipping SatNOGS step (site keeps working without pings).")
        return 0
    if os.path.exists(PUBFILE) and open(PUBFILE).read().strip() != pub.hex():
        print("Signing key differs from the published eden_pubkey.txt; refusing to sign. "
              "If you rotated the key on purpose, update eden_pubkey.txt in a commit.")
        return 1
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    if "--mock" in argv:
        rows = json.load(open(argv[argv.index("--mock") + 1]))
        if "--now" in argv: now = parse_time(argv[argv.index("--now") + 1])
    else:
        try: rows = fetch()
        except Exception as e:
            print("SatNOGS fetch failed (%s); keeping previous receptions.json" % e); return 0
    recs = build(rows, now)
    print("usable receptions:", len(recs))
    if len(recs) < 3:
        print("Too few usable receptions; keeping previous receptions.json"); return 0
    doc = sign(recs, now, sk, pub)
    ok, why = verify(doc); assert ok, why
    with open(OUT, "w", encoding="utf-8") as f: json.dump(doc, f, ensure_ascii=False, indent=1)
    if not os.path.exists(PUBFILE):
        open(PUBFILE, "w").write(pub.hex() + "\n")
    print("signed:", why)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
