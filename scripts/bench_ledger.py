"""bench_ledger.py - weekly "verify vs re-run" benchmark, kept as a sealed EDEN Evidence ledger.

What it measures (MEASURED on the GitHub runner): how long it takes to check every decision of a
2,000-image pass with EDEN, versus re-running a small stand-in AI on each image. What it models
(MODELLED): the yearly audit cost at a stated volume, using cited GPU prices.

It is a benchmark, not a customer workload: no real AI decisions are being audited yet.

Each run: verify the existing ledger (bench/ledger.json), append this week's result, seal, save.
Every seal is published in this public repo, so git history is the witness: any rewrite of past
results would fail against seals already published.
Usage: EDEN_SIGNING_SEED=<hex> python scripts/bench_ledger.py [--tiles 1000]
"""
import argparse, datetime as dt, json, os, platform, re, subprocess, sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "bench"))
import eden_evidence as ev          # noqa: E402

LEDGER, LOG_ID = "bench/ledger.json", "edenrefinery.com/bench/verify-vs-rerun"


def now():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def run_benchmark(tiles):
    out = "bench/_last_run.json"
    cmd = [sys.executable, "bench/exp_verify_vs_recompute.py", "--label", "github-runner", "--tiles", str(tiles), "--json", out]
    env = dict(os.environ, PYTHONPATH="bench")
    r = subprocess.run(cmd, capture_output=True, text=True, env=env, cwd=".")
    print(r.stdout[-2500:])
    if r.returncode != 0:
        print(r.stderr[-2000:]); raise SystemExit("benchmark failed")
    d = json.load(open(out)); os.remove(out)
    return d


def body_from(d):
    a = d["A"]
    c70 = next(x for x in d["C"] if x["model"].startswith("70B"))
    return {
        "what": "benchmark: check every decision of a pass vs re-run a 0.09 GFLOP stand-in AI per image",
        "runner": "%s %s" % (platform.system(), platform.machine()),
        "tiles": a["tiles"],
        "rerun_us_per_decision": int(round(a["rerun_ms_per_tile"] * 1000)),
        "verify_all_ns_per_decision": int(round(a["verify_all_ms_per_decision"] * 1e6)),
        "verify_one_us": int(round(a["verify_one_ms"] * 1000)),
        "checking_cheaper_x": int(round(a["rerun_ms_per_tile"] / a["verify_all_ms_per_decision"])),
        "modelled_70b_audit_usd_per_year_rerun_all": "%d-%d" % tuple(round(x) for x in c70["rerun_all_usd_yr"]),
        "modelled_70b_audit_usd_per_year_eden": "%d-%d" % tuple(round(x) for x in c70["eden_usd_yr"]),
        "modelled_assumptions": "1,000,000 decisions/day, EDEN verifies all + re-runs 1%, H100 USD 1.99-6.88/h at 40% utilisation",
    }


def rebuild(pack, seed):
    """Replay the published ledger into a writable log (same key, same entries, same seals)."""
    log = ev.EvidenceLog(LOG_ID, seed)
    ns = [s["n"] for s in pack["seals"]]
    for e in pack["entries"]:
        log.append(e["kind"], e["actor"], e["body"], input_sha256=e["input"], model=e["model"], t=e["t"])
        while ns and log.tree.size == ns[0]:
            s_old = pack["seals"][len(log.seals)]
            log.seal(t=s_old["t"], note=s_old.get("note")); ns.pop(0)
    if [s["sig"] for s in log.seals] != [s["sig"] for s in pack["seals"]]:
        raise SystemExit("replayed ledger does not reproduce the published seals")
    return log


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--tiles", type=int, default=1000)
    args = ap.parse_args()
    seed_hex = os.environ.get("EDEN_SIGNING_SEED", "").strip()
    if not re.fullmatch(r"[0-9a-fA-F]{64}", seed_hex):
        print("No EDEN_SIGNING_SEED; cannot seal the ledger."); return 0
    seed = bytes.fromhex(seed_hex)
    pub = ev.mc.public_from_seed(seed)
    if os.path.exists("eden_pubkey.txt") and open("eden_pubkey.txt").read().strip() != pub.hex():
        raise SystemExit("signing key differs from the published eden_pubkey.txt")
    if os.path.exists(LEDGER):
        old = json.load(open(LEDGER))
        code, why = ev.verify_pack(old, pub)
        print("existing ledger:", code, why)
        if code != ev.OK:
            raise SystemExit("existing ledger failed verification; refusing to extend it")
        log, held = rebuild(old, seed), [old["seals"][-1]]
    else:
        log, held = ev.EvidenceLog(LOG_ID, seed), []
    d = run_benchmark(args.tiles)
    t = now()
    log.append("benchmark", "github-actions", body_from(d), t=t)
    log.seal(t=t, note="weekly benchmark")
    pack = log.pack()
    code, why = ev.verify_pack(pack, pub, held_seals=held)
    print("new ledger:", code, why)
    if code != ev.OK:
        raise SystemExit("new ledger failed verification")
    json.dump(pack, open(LEDGER, "w"), ensure_ascii=False, indent=1)
    b = pack["entries"][-1]["body"]
    print("this run: checking every decision is %sx cheaper than re-running (%s us vs %s ns per decision)"
          % ("{:,}".format(b["checking_cheaper_x"]), b["rerun_us_per_decision"], b["verify_all_ns_per_decision"]))
    print("ledger now holds %d runs, sealed %d times" % (len(pack["entries"]), len(pack["seals"])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
