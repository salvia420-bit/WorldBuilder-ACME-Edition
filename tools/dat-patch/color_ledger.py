#!/usr/bin/env python3
"""color_ledger.py -- the COLOUR TRIPWIRE for a texture take (I8, 2026-08-18).

Why this exists
---------------
The r7 corpus was baked through `legibility.bake_texture`, whose hard
constraint is

    mean_lum(shipped) = LUM_TARGET (1.15) x mean_lum(RETAIL)      legibility.py:160

Every shipped r7 texture therefore sits at a *measured, known* offset from
retail.  On 2026-08-17 the deblock A/B produced 1,630 RAW Remacri bakes
(`/mnt/wbterminal2/deblock-ab/out-remacri-full/`) which never went through that
anchor; the owner caught the result by eye -- "darker and flatter", measured at
-8..-30% RGB and -5..-10% saturation.  Nothing in the take gate would have
caught it, because the gate checks structure (walk_check, degrade chains,
record counts) and not a single pixel statistic.

This tool is that missing tripwire.  For every baked texture it computes the
drift of the shipped pixels against the RETAIL re-export and fails the take
when the population leaves the calibrated band.

    lumRatio  = mean_lum(bake)  / mean_lum(retail)      -> expect ~LUM_TARGET
    satRatio  = mean_sat(bake)  / mean_sat(retail)
    rRatio/gRatio/bRatio                                -> per-channel means
    conRatio  = std_lum(bake)   / std_lum(retail)
    castDrift = max_c |bake_c - lumRatio*retail_c| / lum(retail)   -> colour CAST

All means are over the OPAQUE texels only (alpha >= 0.5): a clipmap's
transparent border stores arbitrary RGB and would otherwise dominate the
average of a door or a fence.

Usage
-----
    # ledger + gate over one or more lane bake dirs
    python3 color_ledger.py --baked $R7/dungeons/baked,$R7/doors/baked \\
        --retail-dir /mnt/wbterminal2/tex-reexport-2026-07-30/ \\
        --json $R7/color-ledger.json --gate

    # same, but scoring an arbitrary corpus (e.g. the raw A-arm) without a gate
    python3 color_ledger.py --baked /mnt/wbterminal2/deblock-ab/out-remacri-full \\
        --retail-dir ... --json /tmp/aarm.json

`--gate` exits 1 on violation and prints every failing aggregate.  Without it
the tool is read-only reporting and always exits 0 (except on hard errors).

Thresholds
----------
Defaults are CALIBRATED, not guessed: they are the widest band that passes the
whole shipped r7 corpus (2,192 bakes) and still fails the raw A-arm corpus.
See docs/dat-patch/reports/color-anchor-2026-08-18.md for the distributions.
Override any of them on the command line for a lane with a different contract
(terrain, for instance, ships without the 1.15x anchor).
"""
import argparse
import json
import math
import os
import re
import sys

import numpy as np
from PIL import Image

RS_RE = re.compile(r"^(0x[0-9A-Fa-f]{8})\.png$")
CAST_DARK_FLOOR = 0.15   # see score_one()

# --- calibrated defaults (see module docstring) ------------------------------
DEF = dict(
    lum_target=1.15,
    lum_median_tol=0.03,     # |median(lumRatio) - target| must be <= this
    lum_lo=1.05,             # per-texture band ...
    lum_hi=1.30,
    lum_out_frac=0.02,       # ... at most this fraction may fall outside it
    lum_ceiling=0.92,        # retail tiles brighter than this cannot reach the
                             # target: judged 'not darker than retail' instead
    sat_median_lo=0.88,      # median(satRatio) floor: colour must not wash out
    sat_median_hi=1.15,
    chan_median_tol=0.08,    # |median(<c>Ratio) - target| per channel
    cast_p99=0.20,           # p99 of the scale-free colour-cast metric
    min_records=1,
)


def opaque(a):
    if a.shape[-1] >= 4:
        m = a[..., 3] >= 0.5
        if m.any():
            return m
    return np.ones(a.shape[:2], bool)


def load(path, size=None):
    """RGBA float in [0,1], optionally resampled onto a common grid.

    `size` is the SHARED grid the bake and its retail reference are compared
    on.  Comparing a 2048^2 bake against a 512^2 retail tile at their native
    sizes is not wrong for the means, but it makes the two alpha masks
    different populations, and that is fatal here: the shipped clipmap bakes
    carry a RE-BINARISED base alpha (texture_lane.py, alpha transplant) while
    the retail export carries the raw ramp, so a cutout door would score a 3.1x
    "brightness regression" that is entirely a mask artefact.  One grid, one
    mask (retail's), one population."""
    im = Image.open(path).convert("RGBA")
    if size and im.size != size:
        im = im.resize(size, Image.BOX if (im.width > size[0]) else Image.BILINEAR)
    return np.asarray(im, np.float32) / 255.0


def stats(a, mask=None):
    m = opaque(a) if mask is None else mask
    px = a[..., :3][m]
    if px.size == 0:
        return None
    mx = px.max(1)
    mn = px.min(1)
    sat = np.where(mx > 1e-6, (mx - mn) / np.maximum(mx, 1e-6), 0.0)
    l = 0.299 * px[:, 0] + 0.587 * px[:, 1] + 0.114 * px[:, 2]
    return dict(r=float(px[:, 0].mean()), g=float(px[:, 1].mean()),
                b=float(px[:, 2].mean()), lum=float(l.mean()),
                sat=float(sat.mean()), con=float(l.std()), n=int(px.shape[0]))


def _ratio(a, b):
    return float(a / b) if b > 1e-6 else None


def score_one(bake_png, retail_png, max_side=512):
    with Image.open(retail_png) as _ri:
        rw, rh = _ri.size
    f = min(1.0, max_side / max(rw, rh)) if max_side else 1.0
    grid = (max(1, int(round(rw * f))), max(1, int(round(rh * f))))
    ar = load(retail_png, grid)
    ab = load(bake_png, grid)
    mask = opaque(ar)                    # the RETAIL alpha decides the population
    sr = stats(ar, mask)
    sb = stats(ab, mask)
    if sb is None or sr is None:
        return None
    lr = _ratio(sb["lum"], sr["lum"])
    row = dict(lumRatio=lr,
               satRatio=_ratio(sb["sat"], sr["sat"]),
               conRatio=_ratio(sb["con"], sr["con"]),
               rRatio=_ratio(sb["r"], sr["r"]),
               gRatio=_ratio(sb["g"], sr["g"]),
               bRatio=_ratio(sb["b"], sr["b"]),
               lumBake=sb["lum"], lumRetail=sr["lum"],
               satBake=sb["sat"], satRetail=sr["sat"])
    # Colour CAST, measured in units of retail luminance rather than as a
    # channel-ratio: a ratio explodes on a channel whose retail mean is near
    # zero (a blue-less brick tile scores 2.5 for a change the eye cannot see),
    # which makes a ratio-based metric useless as a tripwire.  This asks the
    # scale-free question directly -- "after allowing for the exposure change,
    # how far did any channel move, relative to the picture's own brightness".
    # The DARK_FLOOR in the denominator is load-bearing: on a near-black tile
    # (retail mean luminance 0.04) a +0.02 lift in one channel is 50% of the
    # picture's brightness by that ratio, and the metric would spend its whole
    # budget on tiles nobody can see a cast in.  Normalising by max(lum, 0.15)
    # asks "how big is the channel move next to a MID-TONE", which is the
    # question the eye asks.
    if lr:
        row["castDrift"] = max(
            abs(sb[c] - lr * sr[c]) for c in ("r", "g", "b")) / max(sr["lum"], CAST_DARK_FLOOR)
    else:
        row["castDrift"] = None
    return row


def _task(t):
    rs, bp, rp, lane, max_side = t
    try:
        row = score_one(bp, rp, max_side)
    except Exception as e:              # a corrupt PNG must not silently vanish
        return rs, None, "%s: %s" % (type(e).__name__, e)
    if row is None:
        return rs, None, "empty after alpha mask"
    row["lane"] = lane
    return rs, row, None


def collect(baked_dirs, retail_dir, max_side=512, limit=None, only=None,
            progress=False, jobs=1):
    tasks, missing = [], []
    seen = set()
    for d in baked_dirs:
        if not os.path.isdir(d):
            raise SystemExit("no such bake dir: %s" % d)
        lane = os.path.basename(os.path.dirname(d.rstrip("/"))) or d
        for fn in sorted(os.listdir(d)):
            m = RS_RE.match(fn)
            if not m:
                continue
            rs = m.group(1).upper().replace("0X", "0x")
            if only and rs not in only:
                continue
            if rs in seen:
                continue
            seen.add(rs)
            rp = os.path.join(retail_dir, rs + ".png")
            if not os.path.exists(rp):
                missing.append(rs)
                continue
            tasks.append((rs, os.path.join(d, fn), rp, lane, max_side))
            if limit and len(tasks) >= limit:
                break
        if limit and len(tasks) >= limit:
            break

    rows = {}
    if jobs > 1 and len(tasks) > jobs:
        import multiprocessing as mp
        # spawned pool: forked workers would inherit this process's PIL/numpy
        # state and, on this 8 GB laptop, its resident arrays too.
        with mp.get_context("spawn").Pool(jobs) as pool:
            for i, (rs, row, err) in enumerate(
                    pool.imap_unordered(_task, tasks, chunksize=8)):
                if row is None:
                    missing.append(rs)
                else:
                    rows[rs] = row
                if progress and (i + 1) % 200 == 0:
                    print("  scored %d/%d ..." % (i + 1, len(tasks)), flush=True)
    else:
        for i, t in enumerate(tasks):
            rs, row, err = _task(t)
            if row is None:
                missing.append(rs)
            else:
                rows[rs] = row
            if progress and (i + 1) % 200 == 0:
                print("  scored %d/%d ..." % (i + 1, len(tasks)), flush=True)
    return rows, missing


def _pct(vals, q):
    v = sorted(x for x in vals if x is not None and not math.isnan(x))
    if not v:
        return None
    return float(np.percentile(np.array(v), q))


def summarise(rows, th):
    lum = [r["lumRatio"] for r in rows.values()]
    sat = [r["satRatio"] for r in rows.values()]
    con = [r["conRatio"] for r in rows.values()]
    cast = [r["castDrift"] for r in rows.values()]
    n = len(rows)
    # A texture whose retail mean luminance is already near white CANNOT reach
    # lum_target x retail -- the softclip runs out of headroom and the anchor
    # converges to the brightest reachable image (measured: 0x060043F3, retail
    # mean 0.965, best possible ratio 1.035).  That is the anchor working, not
    # failing, so those records are judged by a weaker rule -- never DARKER
    # than retail -- instead of by the band.
    def ceiling_limited(r):
        lr = r.get("lumRetail")
        return lr is not None and th["lum_target"] * lr > th["lum_ceiling"]

    out_band, ceil_bad, ceil_n = [], [], 0
    for rs, r in rows.items():
        if ceiling_limited(r):
            ceil_n += 1
            if r["lumRatio"] is None or r["lumRatio"] < 1.0:
                ceil_bad.append(rs)
            continue
        if r["lumRatio"] is None or not (th["lum_lo"] <= r["lumRatio"] <= th["lum_hi"]):
            out_band.append(rs)
    checked = n - ceil_n
    agg = dict(
        records=n,
        ceilingLimited=ceil_n,
        ceilingLimitedDarker=len(ceil_bad),
        ceilingLimitedExamples=sorted(ceil_bad)[:20],
        bandChecked=checked,
        lumRatio=dict(p10=_pct(lum, 10), median=_pct(lum, 50), p90=_pct(lum, 90),
                      min=_pct(lum, 0), max=_pct(lum, 100)),
        satRatio=dict(p10=_pct(sat, 10), median=_pct(sat, 50), p90=_pct(sat, 90)),
        conRatio=dict(p10=_pct(con, 10), median=_pct(con, 50), p90=_pct(con, 90)),
        castDrift=dict(median=_pct(cast, 50), p90=_pct(cast, 90),
                       p99=_pct(cast, 99), max=_pct(cast, 100)),
        rRatio=dict(median=_pct([r["rRatio"] for r in rows.values()], 50)),
        gRatio=dict(median=_pct([r["gRatio"] for r in rows.values()], 50)),
        bRatio=dict(median=_pct([r["bRatio"] for r in rows.values()], 50)),
        outOfBand=len(out_band),
        outOfBandFrac=(len(out_band) / checked) if checked else 0.0,
        outOfBandExamples=sorted(out_band)[:20],
    )
    return agg


def gate(agg, th):
    """-> list of violation strings (empty == pass)."""
    v = []
    n = agg["records"]
    if n < th["min_records"]:
        v.append("only %d records scored (need >= %d) -- the ledger's inputs "
                 "are missing, which is itself a failure" % (n, th["min_records"]))
        return v
    med = agg["lumRatio"]["median"]
    if med is None or abs(med - th["lum_target"]) > th["lum_median_tol"]:
        v.append("median lumRatio %.4f is off the %.2f anchor by more than "
                 "%.3f -- the retail exposure anchor did not run (or ran "
                 "against the wrong reference)"
                 % (-1 if med is None else med, th["lum_target"],
                    th["lum_median_tol"]))
    if agg["outOfBandFrac"] > th["lum_out_frac"]:
        v.append("%.2f%% of textures are outside the per-texture lumRatio band "
                 "[%.2f, %.2f] (limit %.2f%%); examples: %s"
                 % (100 * agg["outOfBandFrac"], th["lum_lo"], th["lum_hi"],
                    100 * th["lum_out_frac"], ", ".join(agg["outOfBandExamples"][:8])))
    smed = agg["satRatio"]["median"]
    if smed is None or smed < th["sat_median_lo"]:
        v.append("median satRatio %.4f below floor %.2f -- colour is washing out"
                 % (-1 if smed is None else smed, th["sat_median_lo"]))
    elif smed > th["sat_median_hi"]:
        v.append("median satRatio %.4f above ceiling %.2f -- the corpus is being "
                 "over-saturated, which is an enhancement pass, not an anchor"
                 % (smed, th["sat_median_hi"]))
    for ch in ("rRatio", "gRatio", "bRatio"):
        cm = agg[ch]["median"]
        if cm is None or abs(cm - th["lum_target"]) > th["chan_median_tol"]:
            v.append("median %s %.4f is off the %.2f anchor by more than %.3f -- "
                     "the per-channel colour anchor did not hold"
                     % (ch, -1 if cm is None else cm, th["lum_target"],
                        th["chan_median_tol"]))
    c99 = agg["castDrift"]["p99"]
    if c99 is not None and c99 > th["cast_p99"]:
        v.append("p99 castDrift %.4f above %.3f -- a per-channel colour cast is "
                 "shipping" % (c99, th["cast_p99"]))
    if agg["ceilingLimitedDarker"]:
        v.append("%d near-white texture(s) came back DARKER than retail: %s"
                 % (agg["ceilingLimitedDarker"],
                    ", ".join(agg["ceilingLimitedExamples"][:8])))
    return v


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--baked", required=True,
                    help="comma-separated bake dirs of <rsId>.png")
    ap.add_argument("--retail-dir", required=True,
                    help="retail re-export dir of <rsId>.png (the anchor reference)")
    ap.add_argument("--json", default=None, help="write the full ledger here")
    ap.add_argument("--gate", action="store_true",
                    help="exit 1 on violation (take gate); default is report-only")
    ap.add_argument("--max-side", type=int, default=512)
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--only", default=None,
                    help="comma-separated rsIds to restrict to")
    ap.add_argument("--label", default="")
    ap.add_argument("--jobs", type=int, default=1,
                    help="parallel scorers (spawned pool); 3 is the laptop ceiling")
    for k, dv in DEF.items():
        ap.add_argument("--" + k.replace("_", "-"), type=type(dv), default=dv)
    a = ap.parse_args()
    th = {k: getattr(a, k) for k in DEF}

    dirs = [d for d in a.baked.split(",") if d.strip()]
    only = set(x.strip() for x in a.only.split(",")) if a.only else None
    rows, missing = collect(dirs, a.retail_dir, a.max_side, a.limit, only,
                            progress=True, jobs=a.jobs)
    agg = summarise(rows, th)
    viol = gate(agg, th)
    rep = dict(label=a.label, bakedDirs=dirs, retailDir=a.retail_dir,
               thresholds=th, aggregate=agg,
               missingRetail=len(missing), missingExamples=missing[:20],
               violations=viol, textures=rows)
    if a.json:
        json.dump(rep, open(a.json, "w"), indent=1, sort_keys=True)

    print("colour ledger%s: %d textures scored, %d without a retail reference"
          % ((" [" + a.label + "]") if a.label else "", agg["records"], len(missing)))
    for k in ("lumRatio", "satRatio", "conRatio", "rRatio", "gRatio", "bRatio"):
        d = agg[k]
        print("  %-9s p10 %s  median %s  p90 %s"
              % (k, _f(d.get("p10")), _f(d.get("median")), _f(d.get("p90"))))
    print("  castDrift median %s  p90 %s  p99 %s"
          % (_f(agg["castDrift"]["median"]), _f(agg["castDrift"]["p90"]),
             _f(agg["castDrift"]["p99"])))
    print("  lumRatio out of band [%.2f,%.2f]: %d of %d checked (%.2f%%); "
          "%d near-white ceiling-limited (%d darker than retail)"
          % (th["lum_lo"], th["lum_hi"], agg["outOfBand"], agg["bandChecked"],
             100 * agg["outOfBandFrac"], agg["ceilingLimited"],
             agg["ceilingLimitedDarker"]))
    if a.json:
        print("  ledger -> %s" % a.json)
    if viol:
        print("  COLOUR LEDGER VIOLATIONS: %d" % len(viol))
        for s in viol:
            print("    - " + s)
    else:
        print("  colour ledger: PASS")
    sys.exit(1 if (viol and a.gate) else 0)


def _f(x):
    return "n/a" if x is None else "%.4f" % x


if __name__ == "__main__":
    main()
