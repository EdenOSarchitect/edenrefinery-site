"""Chrysalis Budget Ledger (v2.3): reusable, transferable DOWNLINK BUDGET.

Naming: "Chrysalis" here means this budget ledger only. It is distinct from the
Chrysalis8D operator formalism and from the VULKAN004 "Chrysalis transport".

What it is - ACCOUNTING, NOT CURRENCY:
  A downlink pass's capacity can't literally be stored or moved; once the pass
  is over, it's gone. What CAN be made reusable and transferable is the RIGHT
  to use downlink bytes, recorded as signed, conserved, single-use credits.
  Credits are not money, not a security and not asset-backed. Their only use is
  scheduling who may put how many bytes on which pass.

Records (canonical JSON, Ed25519, domain-separated; id = hash of the body):
  GRANT     signed by the AUTHORITY key: creates credits from nothing (the only
            record that may). outputs: [{holder, amount}]
  TRANSFER  signed by the holder of `input`: consumes that credit entirely,
            outputs must sum EXACTLY to its amount (recipient(s) + change).
  DRAW      signed by the holder of `input`: turns part of a credit into an
            ALLOCATION for one satellite pass; the rest returns as change.
  USAGE     signed by the SATELLITE named in the allocation: states bytes used;
            the remainder returns to the allocation's holder as a new credit,
            reusable on a later pass or transferable.

Ledger rules checked by verify_ledger():
  signature by the right party, integer amounts > 0, every credit and
  allocation spent at most once (no double spend), conservation (outputs ==
  input; used + remainder == allocation), used <= allocation (no overdraw).

Unit: payload bytes the satellite PLANS to downlink (image bytes of KEEP and
ALERT records). Not a link measurement; framing/protocol overhead excluded.
"""
import hashlib

import marble_core as mc

DOMAIN = b"EDEN-CHRYSALIS-BUDGET-v1\x00"
UNIT = "payload_bytes"


def _rid(body):
    return hashlib.sha256(DOMAIN + mc.canon(body)).hexdigest()[:32]


def _seal(body, seed):
    """Fix the record id from the body, then sign body+id."""
    pub = mc.public_from_seed(seed)
    body = dict(body, signer=mc.key_id(pub), unit=UNIT)
    rec = dict(body, id=_rid(body))
    for k, o in enumerate(rec.get("outputs", [])):
        o["id"] = "%s:%d" % (rec["id"], k)
    if "allocation" in rec:
        rec["allocation"]["id"] = rec["id"] + ":alloc"
    rec["sig"] = mc.sign(seed, DOMAIN + mc.canon(rec)).hex()
    return rec


def _outs(outputs):
    return [{"holder": h, "amount": int(a)} for h, a in outputs]


def grant(authority_seed, outputs, note=None):
    """outputs: [(holder_key_id, amount_bytes), ...]"""
    return _seal({"type": "GRANT", "outputs": _outs(outputs), "note": note}, authority_seed)


def transfer(holder_seed, credit, outputs):
    """Spend `credit` (an output dict) fully: outputs must sum to its amount."""
    return _seal({"type": "TRANSFER", "input": credit["id"], "outputs": _outs(outputs)},
                 holder_seed)


def draw(holder_seed, credit, sat_key_id, pass_id, amount):
    """Allocate `amount` of `credit` to one satellite pass; change returns to holder."""
    me = mc.key_id(mc.public_from_seed(holder_seed))
    change = credit["amount"] - int(amount)
    return _seal({"type": "DRAW", "input": credit["id"],
                  "allocation": {"sat": sat_key_id, "pass": str(pass_id),
                                 "holder": me, "amount": int(amount)},
                  "outputs": _outs([(me, change)] if change > 0 else [])}, holder_seed)


def usage(sat_seed, allocation, pass_id, used):
    """Signed by the satellite at close: used bytes, remainder back to the holder."""
    rem = allocation["amount"] - int(used)
    return _seal({"type": "USAGE", "input": allocation["id"], "pass": str(pass_id),
                  "used": int(used),
                  "outputs": _outs([(allocation["holder"], rem)] if rem > 0 else [])},
                 sat_seed)


def _sig_ok(rec, pubs):
    pub = pubs.get(rec.get("signer"))
    if pub is None:
        return False
    body = {k: v for k, v in rec.items() if k != "sig"}
    try:
        return mc.verify(pub, DOMAIN + mc.canon(body), bytes.fromhex(rec["sig"]))
    except (KeyError, ValueError):
        return False


def _id_ok(rec):
    body = {k: v for k, v in rec.items() if k not in ("sig", "id")}
    body = dict(body)
    body["outputs"] = [{k: v for k, v in o.items() if k != "id"} for o in rec.get("outputs", [])]
    if "allocation" in body:
        body["allocation"] = {k: v for k, v in body["allocation"].items() if k != "id"}
    return rec.get("id") == _rid(body)


def verify_ledger(records, pubs, authority_id):
    """Replay records in order. pubs: {key_id: public_key_bytes}.

    Returns (ok, report) with report = {"balances", "allocations", "errors"}.
    A rejected record is skipped and reported; replay continues so every
    problem is listed.
    """
    credits, allocs, seen, errors = {}, {}, set(), []

    def bad(rec, why):
        errors.append("%s %s: %s" % (rec.get("type"), str(rec.get("id"))[:12], why))

    for rec in records:
        t = rec.get("type")
        if rec.get("id") in seen:
            bad(rec, "duplicate record")
            continue
        if not _id_ok(rec):
            bad(rec, "id does not match body")
            continue
        if not _sig_ok(rec, pubs):
            bad(rec, "bad or unknown signature")
            continue
        outs = rec.get("outputs", [])
        if any(not isinstance(o.get("amount"), int) or o["amount"] <= 0 for o in outs):
            bad(rec, "amounts must be positive integers")
            continue
        total_out = sum(o["amount"] for o in outs)
        if t == "GRANT":
            if rec["signer"] != authority_id:
                bad(rec, "only the authority may grant")
                continue
        elif t in ("TRANSFER", "DRAW"):
            c = credits.get(rec.get("input"))
            if c is None:
                bad(rec, "unknown input credit")
                continue
            if c["spent"]:
                bad(rec, "DOUBLE SPEND of %s" % rec["input"][:14])
                continue
            if rec["signer"] != c["holder"]:
                bad(rec, "signer does not hold the input credit")
                continue
            a = rec.get("allocation", {}).get("amount", 0) if t == "DRAW" else 0
            if t == "DRAW" and (not isinstance(a, int) or a <= 0
                                or rec["allocation"]["holder"] != c["holder"]):
                bad(rec, "bad allocation")
                continue
            if total_out + a != c["amount"]:
                bad(rec, "not conserved: in %d, out %d" % (c["amount"], total_out + a))
                continue
            c["spent"] = True
            if t == "DRAW":
                al = rec["allocation"]
                allocs[al["id"]] = dict(al, used=None)
        elif t == "USAGE":
            al = allocs.get(rec.get("input"))
            if al is None:
                bad(rec, "unknown allocation")
                continue
            if al["used"] is not None:
                bad(rec, "allocation already used (double spend)")
                continue
            if rec["signer"] != al["sat"] or rec.get("pass") != al["pass"]:
                bad(rec, "usage not signed by the allocated satellite/pass")
                continue
            used = rec.get("used")
            if not isinstance(used, int) or not 0 <= used <= al["amount"]:
                bad(rec, "OVERDRAW or bad used amount")
                continue
            if used + total_out != al["amount"] or any(o["holder"] != al["holder"] for o in outs):
                bad(rec, "remainder not conserved to the holder")
                continue
            al["used"] = used
        else:
            bad(rec, "unknown record type")
            continue
        seen.add(rec["id"])
        for o in outs:
            credits[o["id"]] = {"holder": o["holder"], "amount": o["amount"], "spent": False}

    balances = {}
    for c in credits.values():
        if not c["spent"]:
            balances[c["holder"]] = balances.get(c["holder"], 0) + c["amount"]
    return not errors, {"balances": balances, "allocations": allocs, "errors": errors}


def unspent(records, holder):
    """Convenience: a holder's unspent credits (output dicts), from a verified replay."""
    spent = {r.get("input") for r in records}
    out = []
    for r in records:
        for o in r.get("outputs", []):
            if o["holder"] == holder and o["id"] not in spent:
                out.append(o)
    return out
