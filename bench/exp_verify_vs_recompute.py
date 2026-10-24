"""exp_verify_vs_recompute.py - how much computing does "Don't recompute it. Verify it." avoid?

Question: to check an AI's decisions, what does it cost to VERIFY EDEN's receipts,
compared with RE-RUNNING the AI?

Important limit, stated up front: verifying proves WHAT the AI decided (input, model,
verdict, order, unaltered). It does not prove the decision was RIGHT. So EDEN's audit
model is: verify 100% of decisions, re-run a small random sample to check correctness.
Part C prices exactly that, against re-running everything.

Labels
  MEASURED   timed on the machine running this script
  MODELLED   arithmetic from cited model sizes and cited prices, not timed here
  ASSUMED    a stated input you can change on the command line

Part A  MEASURED  verify vs re-run a small stand-in cloud-detection CNN (numpy, ~0.1 GFLOP)
Part B  MODELLED  the same comparison for well-known model sizes (FLOPs from their papers)
Part C  MODELLED  yearly cost of auditing a fleet: re-run all vs EDEN verify all + sample

Usage:  python exp_verify_vs_recompute.py [--label laptop] [--tiles 2000] [--sample 0.01]
        [--decisions-per-day 1000000] [--gpu-low 1.99] [--gpu-high 6.88] [--util 0.4]
Needs numpy (Termux: pkg install python-numpy).
"""
import argparse, json, os, platform, shutil, statistics, sys, tempfile, time

import numpy as np

import ground
import marble_core as mc
from onboard import PassRecorder

TILE = 64 * 1024          # same 64 KiB tiles as the pass demo

# ---------------------------------------------------------------- stand-in AI
class TinyCloudNet:
    """A small but real CNN: 3 conv layers + classifier on a 128x128x4 tile.
    Stand-in for an onboard cloud detector; weights are random (speed, not accuracy)."""
    def __init__(self, seed=1):
        r = np.random.default_rng(seed)
        self.w = [r.standard_normal((9 * cin, cout)).astype(np.float32) * 0.1
                  for cin, cout in ((4, 16), (16, 32), (32, 64))]
        self.fc = r.standard_normal((64, 2)).astype(np.float32) * 0.1

    @staticmethod
    def conv3(x, w):                               # x: H,W,C ; im2col + matmul
        H, Wd, C = x.shape
        p = np.pad(x, ((1, 1), (1, 1), (0, 0)))
        cols = np.concatenate([p[i:i + H, j:j + Wd, :] for i in range(3) for j in range(3)], axis=2)
        return np.maximum(cols.reshape(H * Wd, 9 * C) @ w, 0).reshape(H, Wd, -1)

    @staticmethod
    def pool(x):
        H, W, C = x.shape
        return x.reshape(H // 2, 2, W // 2, 2, C).max(axis=(1, 3))

    def flops(self):
        f, h = 0, 128
        for w in self.w:
            f += 2 * h * h * w.shape[0] * w.shape[1]; h //= 2
        return f + 2 * 64 * 2

    def __call__(self, tile):
        x = np.frombuffer(tile, dtype=np.uint8).reshape(128, 128, 4).astype(np.float32) / 255
        for w in self.w:
            x = self.pool(self.conv3(x, w))
        logits = x.mean(axis=(0, 1)) @ self.fc
        return float(1 / (1 + np.exp(logits[0] - logits[1])))


def median_ms(fn, reps):
    ts = []
    for _ in range(reps):
        t0 = time.perf_counter(); fn(); ts.append((time.perf_counter() - t0) * 1e3)
    return statistics.median(ts)


# ---------------------------------------------------------------- Part A
def part_a(n_tiles, seed=20261024):
    rng = np.random.default_rng(seed)
    tiles = [rng.integers(0, 256, TILE, dtype=np.uint8).tobytes() for _ in range(n_tiles)]
    net = TinyCloudNet()
    tmp = tempfile.mkdtemp(prefix="eden_exp_")
    try:
        pub = ground.keygen(os.path.join(tmp, "keys"))
        rec = PassRecorder(os.path.join(tmp, "state"), "pass-exp", os.path.join(tmp, "keys", "seed.hex"))
        rec.register_model("tinycloud", data=b"tinycloud random weights")
        t0 = time.perf_counter()
        for i, t in enumerate(tiles):
            s = net(t)
            rec.record("tile-%05d" % i, "VOID" if s > 0.5 else "KEEP", input_bytes=t, model="tinycloud", score=round(s, 4))
        onboard_s = time.perf_counter() - t0
        bundle = json.load(open(rec.close()))
        recs = rec._journal_records()
        pkgs = [rec.proof_for(i) for i in range(0, n_tiles, max(1, n_tiles // 50))]

        # 1. re-run the AI on one tile (what an auditor must do to "recompute")
        k = [0]
        def rerun():
            net(tiles[k[0] % n_tiles]); k[0] += 1
        rerun_ms = median_ms(rerun, min(200, n_tiles))

        # 2. verify ONE decision on its own: signature + inclusion proof (~1 kB, no image needed)
        j = [0]
        def verify_one():
            ok, _ = ground.verify_proof(bundle, pkgs[j[0] % len(pkgs)], pub); j[0] += 1
            assert ok
        verify_one_ms = median_ms(verify_one, 50)

        # 3. verify EVERY decision in the pass: one signature + rebuild the Merkle root from all records
        def verify_all():
            ok, _ = ground.verify_bundle(bundle, pub); assert ok
            assert mc.root_from_leaf_hashes([mc._leaf(r) for r in recs]).hex() == bundle["root"]
        verify_all_ms = median_ms(verify_all, 7)

        # 4. if the auditor also holds the image: confirm it is the exact input (one SHA-256 of 64 KiB)
        def verify_image():
            assert ground.verify_retained(pkgs[0]["record"], tiles[pkgs[0]["index"]])
        verify_image_ms = median_ms(verify_image, 200)

        return {
            "tiles": n_tiles,
            "model_flops": net.flops(),
            "rerun_ms_per_tile": rerun_ms,
            "cpu_gflops_achieved": net.flops() / (rerun_ms / 1e3) / 1e9,
            "verify_one_ms": verify_one_ms,
            "verify_all_ms_per_decision": verify_all_ms / n_tiles,
            "verify_image_ms": verify_image_ms,
            "onboard_ms_per_tile_incl_ai_and_record": onboard_s / n_tiles * 1e3,
            "bundle_bytes": len(mc.canon(bundle)),
            "proof_bytes": len(mc.canon(pkgs[0])),
        }
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ---------------------------------------------------------------- Part B
# FLOPs per decision. Sources: He et al. 2015 (ResNet-50, 3.8e9 multiply-adds, ~4.1 GFLOPs as
# commonly reported); Dosovitskiy et al. 2020 (ViT-B/16, 17.6 GFLOPs at 224px, Table 6);
# Kaplan et al. 2020 (transformer forward pass ~= 2 x parameters FLOPs per token).
MODELS = [
    ("ResNet-50 image classifier", 4.1e9, "He et al. 2015"),
    ("ViT-B/16 vision transformer", 17.6e9, "Dosovitskiy et al. 2020"),
    ("7B-parameter LLM, 500-token answer", 2 * 7e9 * 500, "Kaplan et al. 2020 rule"),
    ("70B-parameter LLM, 500-token answer", 2 * 70e9 * 500, "Kaplan et al. 2020 rule"),
]
H100_DENSE_BF16 = 989e12   # NVIDIA H100 SXM datasheet, dense BF16 tensor TFLOPS


def part_b(a, util, gpu_low, gpu_high):
    out = [{"model": "Stand-in CNN (measured)", "flops": a["model_flops"], "src": "this script",
            "rerun_cpu_ms": a["rerun_ms_per_tile"]}]
    for name, f, src in MODELS:
        out.append({"model": name, "flops": f, "src": src,
                    "rerun_cpu_ms": f / (a["cpu_gflops_achieved"] * 1e9) * 1e3})
    for m in out:
        m["ratio_vs_verify_all"] = m["rerun_cpu_ms"] / a["verify_all_ms_per_decision"]
        gpu_s = m["flops"] / (H100_DENSE_BF16 * util)
        m["gpu_usd_per_million"] = (gpu_s * 1e6 / 3600 * gpu_low, gpu_s * 1e6 / 3600 * gpu_high)
    return out


# ---------------------------------------------------------------- Part C
def part_c(b, a, per_day, sample, gpu_low, gpu_high, cpu_usd_hr):
    rows = []
    verify_cpu_s_per_year = a["verify_all_ms_per_decision"] / 1e3 * per_day * 365
    verify_usd = verify_cpu_s_per_year / 3600 * cpu_usd_hr
    for m in b:
        full_lo, full_hi = (x * per_day * 365 / 1e6 for x in m["gpu_usd_per_million"])
        eden_lo, eden_hi = full_lo * sample + verify_usd, full_hi * sample + verify_usd
        rows.append({"model": m["model"], "rerun_all_usd_yr": (full_lo, full_hi),
                     "eden_usd_yr": (eden_lo, eden_hi), "saved_usd_yr": (full_lo - eden_lo, full_hi - eden_hi),
                     "saved_pct": 100 * (1 - eden_hi / full_hi) if full_hi else 0})
    return rows, verify_usd


def money(x):
    return "$%s" % ("{:,.0f}".format(x) if x >= 100 else "{:,.2f}".format(x))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", default=platform.node() or "machine")
    ap.add_argument("--tiles", type=int, default=2000)
    ap.add_argument("--sample", type=float, default=0.01, help="ASSUMED fraction still re-run for correctness")
    ap.add_argument("--decisions-per-day", type=int, default=1_000_000, help="ASSUMED fleet decision volume")
    ap.add_argument("--gpu-low", type=float, default=1.99, help="USD per H100-hour, low on-demand (cited)")
    ap.add_argument("--gpu-high", type=float, default=6.88, help="USD per H100-hour, AWS on-demand (cited)")
    ap.add_argument("--util", type=float, default=0.4, help="ASSUMED GPU utilisation for inference")
    ap.add_argument("--cpu-usd-hr", type=float, default=0.05, help="ASSUMED USD per CPU-core-hour for verifying")
    ap.add_argument("--json", default=None)
    args = ap.parse_args()

    print("EDEN experiment: verify vs recompute  [%s, %s, numpy %s, Ed25519 backend: %s]"
          % (args.label, platform.machine(), np.__version__, mc.backend()))
    a = part_a(args.tiles)
    print("\nPART A  MEASURED on this machine (%d tiles of 64 KiB)" % a["tiles"])
    print("  Re-run the stand-in AI on one tile ......... %8.3f ms   (%.2f GFLOP, %.1f GFLOP/s achieved)"
          % (a["rerun_ms_per_tile"], a["model_flops"] / 1e9, a["cpu_gflops_achieved"]))
    print("  Verify ONE decision alone (sig + proof) .... %8.3f ms   (proof %d bytes, no image needed)"
          % (a["verify_one_ms"], a["proof_bytes"]))
    print("  Verify EVERY decision, per decision ........ %8.4f ms   (whole pass checked against one %d-byte summary)"
          % (a["verify_all_ms_per_decision"], a["bundle_bytes"]))
    print("  Confirm a held image is the exact input .... %8.3f ms   (one SHA-256 of 64 KiB)" % a["verify_image_ms"])
    print("  -> Checking every decision is %.0fx cheaper than re-running even this small AI."
          % (a["rerun_ms_per_tile"] / a["verify_all_ms_per_decision"]))

    b = part_b(a, args.util, args.gpu_low, args.gpu_high)
    print("\nPART B  MODELLED: re-run cost grows with the model; verify cost does not")
    print("  %-38s %12s %14s %16s   %s" % ("Model", "GFLOP/decn", "re-run vs verify", "H100 $/1M re-runs", "FLOPs source"))
    for m in b:
        lo, hi = m["gpu_usd_per_million"]
        print("  %-38s %12s %14s %16s   %s" % (m["model"], "{:,.1f}".format(m["flops"] / 1e9),
              "{:,.0f}x".format(m["ratio_vs_verify_all"]), "%s-%s" % (money(lo), money(hi)), m["src"]))
    print("  (CPU ratios use this machine's measured GFLOP/s; GPU cost uses H100 dense BF16 989 TFLOPS x %.0f%% utilisation"
          " at $%.2f-$%.2f per GPU-hour)" % (args.util * 100, args.gpu_low, args.gpu_high))

    c, verify_usd = part_c(b, a, args.decisions_per_day, args.sample, args.gpu_low, args.gpu_high, args.cpu_usd_hr)
    print("\nPART C  MODELLED: auditing %s decisions a day for a year"
          % "{:,}".format(args.decisions_per_day))
    print("  Option 1: re-run every decision.  Option 2: EDEN verifies every decision + re-runs a %.0f%% random sample."
          % (args.sample * 100))
    print("  EDEN verification for the whole year costs about %s of CPU time." % money(verify_usd))
    print("  %-38s %24s %24s %8s" % ("Model", "Re-run all / year", "EDEN / year", "Saved"))
    for r in c:
        print("  %-38s %24s %24s %7.1f%%" % (r["model"], "%s-%s" % tuple(money(x) for x in r["rerun_all_usd_yr"]),
              "%s-%s" % tuple(money(x) for x in r["eden_usd_yr"]), r["saved_pct"]))
    print("\nLimits: random-weight stand-in CNN (speed only); Part B/C are arithmetic, not timed; GPU prices change often;")
    print("the sample still catches wrong decisions statistically, not every single one.")
    if args.json:
        json.dump({"label": args.label, "A": a, "B": b, "C": c}, open(args.json, "w"), indent=1, default=float)
    return 0


if __name__ == "__main__":
    sys.exit(main())
