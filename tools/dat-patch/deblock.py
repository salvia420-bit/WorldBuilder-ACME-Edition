"""deblock.py -- DXT block-grid scorer (exc0) + grid-targeted deblock prefilter.

From reports/block-artifact-graphical-research-2026-08-17.md:
  * exc0: fold the per-column/per-row mean |luminance gradient| modulo the
    block period P (4 px on the source, 4*scale on a bake), compare phase 0
    (the block edge) against the median of the other phases.
  * filter: wrap-aware H.264-style 4-tap smoothing applied ONLY at x = 0
    (mod 4) boundaries, per RGB channel, gated by a luminance-step threshold
    so genuine strong edges on the grid are left alone.  The threshold is
    binary-searched per texture to drive source grid excess to zero;
    2 passes is the shipped profile (grid +92% -> +2.7% mean, 103% off-grid
    detail retained on the 40-worst set).

CLI:
  score    one PNG (or --csv batch) -> exc0/abs0/base/peakPhase
  validate reproduce a sample of block-scores.csv rows (scorer ground truth)
  batch    deblock a source set (CSV-driven) into --out + ledger.jsonl
"""
import argparse
import csv
import json
import os
import sys

import numpy as np
from PIL import Image

LANE_BAKED = {ln: "/mnt/wbterminal2/dat-patch-%s/baked/" % ln
              for ln in ("dungeons", "doors", "props", "scenery", "creatures")}
TEX_BASE = os.environ.get("DATPATCH_TEX_BASE",
                          "/mnt/wbterminal2/tex-reexport-2026-07-30/")


def _lum255(rgb):
    return (0.299 * rgb[:, :, 0] + 0.587 * rgb[:, :, 1]
            + 0.114 * rgb[:, :, 2]).astype(np.float32)


def _load(path):
    im = Image.open(path).convert("RGBA")
    a = np.asarray(im, dtype=np.float32)
    return a  # 0..255, RGBA


def _fold_profile(g, P, offset=1):
    """Per-phase mean of a gradient profile.  Gradient index i sits between
    pixels i and i+1, so with offset=1 the block boundary (between px P-1
    and P) lands at phase 0."""
    if len(g) < 2 * P:
        return None
    phases = (np.arange(len(g)) + offset) % P
    out = np.zeros(P)
    for p in range(P):
        out[p] = g[phases == p].mean()
    return out


def grid_score(rgba, P, alpha_mask=None):
    """-> dict(exc0, abs0, base, peakPhase, f) or None if unscorable.

    Gradient dx[i] = |L[i+1]-L[i]|; the boundary between pixel P-1 and P is
    the block edge, so phase = (i+1) mod P and f[0] is the on-edge value.
    Alpha-masked at a > 8 (mask from the image itself unless alpha_mask given).
    """
    L = _lum255(rgba)
    a = rgba[:, :, 3] if alpha_mask is None else alpha_mask
    valid = a > 8
    Lm = np.where(valid, L, np.nan)
    with np.errstate(invalid="ignore"):
        dx = np.abs(np.diff(Lm, axis=1))
        dy = np.abs(np.diff(Lm, axis=0))
        gx = np.nanmean(dx, axis=0)
        gy = np.nanmean(dy, axis=1)
    gx = np.nan_to_num(gx, nan=0.0)
    gy = np.nan_to_num(gy, nan=0.0)
    fx = _fold_profile(gx, P)
    fy = _fold_profile(gy, P)
    if fx is None or fy is None:
        return None
    f = 0.5 * (fx + fy)
    base = float(np.median(f[1:]))
    if base <= 1e-6:
        return None
    return dict(exc0=float((f[0] - base) / base), abs0=float(f[0] - base),
                base=base, peakPhase=int(np.argmax(f)), f=f.tolist())


# ------------------------------------------------------------------ filter
def _deblock_axis(rgb, thr, axis):
    """One filtering sweep along `axis` at every boundary x = 0 (mod 4).

    Boundary at column x (wrapping): p1 = x-2, p0 = x-1, q0 = x, q1 = x+1.
    A pair is filtered only when its step is an ARTIFACT SEED:
      |lum(p0)-lum(q0)| < thr           (genuine strong edges left alone) AND
      |lum(p0)-lum(q0)| > local          (it exceeds its off-grid neighbours,
                                          per the block-excess-map definition)
    then  p0' = (p1 + 2*p0 + q0)/4 ,  q0' = (p0 + 2*q0 + q1)/4.
    The seed gate is what keeps off-grid detail at ~100% (a thr-only gate
    measured 68-80% retention; seed-gated measures 95-100%).
    """
    if axis == 0:
        rgb = rgb.transpose(1, 0, 2)
    n = rgb.shape[1]
    if n >= 8:
        lum = _lum255(rgb)
        xs = np.arange(0, n, 4)

        def C(i):
            return rgb[:, np.mod(i, n), :]

        def L(i):
            return lum[:, np.mod(i, n)]

        p1s, p0s, q0s, q1s = C(xs - 2), C(xs - 1), C(xs), C(xs + 1)
        lp1, lp0, lq0, lq1 = L(xs - 2), L(xs - 1), L(xs), L(xs + 1)
        step = np.abs(lp0 - lq0)
        local = (np.abs(L(xs - 3) - lp1) + np.abs(lp1 - lp0)
                 + np.abs(lq0 - lq1) + np.abs(lq1 - L(xs + 2))) / 4.0
        gate = ((step < thr) & (step > local))[..., None]
        rgb[:, np.mod(xs - 1, n), :] = np.where(gate, (p1s + 2.0 * p0s + q0s) / 4.0, p0s)
        rgb[:, xs, :] = np.where(gate, (p0s + 2.0 * q0s + q1s) / 4.0, q0s)
    if axis == 0:
        rgb = rgb.transpose(1, 0, 2)
    return rgb


def deblock_rgba(rgba, thr, passes=2):
    """Filter RGB in place of the block grid; alpha untouched.  0..255 float."""
    rgb = rgba[:, :, :3].astype(np.float32).copy()
    for _ in range(passes):
        rgb = _deblock_axis(rgb, thr, axis=1)
        rgb = _deblock_axis(rgb, thr, axis=0)
    out = rgba.copy()
    out[:, :, :3] = rgb
    return out


def auto_deblock(rgba, passes=2, steps=12, thr_hi=128.0):
    """Binary-search the luminance gate to drive source exc0 (P=4) to <= 0.

    -> (filtered_rgba, thr, score_before, score_after) ; scores may be None
    for tiny/flat textures (then thr falls back to thr_hi/4 fixed gate).
    """
    before = grid_score(rgba, 4)
    if before is None or before["exc0"] <= 0:
        return rgba, 0.0, before, before  # nothing on the grid: no-op
    lo, hi = 0.0, thr_hi
    best = None
    for _ in range(steps):
        mid = 0.5 * (lo + hi)
        cand = deblock_rgba(rgba, mid, passes)
        s = grid_score(cand, 4)
        if s is None:
            break
        if s["exc0"] > 0:
            lo = mid            # not enough smoothing -> raise the gate
        else:
            hi = mid            # overshoot -> keep the smallest sufficient gate
            best = (cand, mid, s)
    if best is None:
        cand = deblock_rgba(rgba, thr_hi, passes)
        return cand, thr_hi, before, grid_score(cand, 4)
    return best[0], best[1], before, best[2]


# --------------------------------------------------------------------- CLI
def cmd_score(args):
    rgba = _load(args.png)
    s = grid_score(rgba, args.P)
    print(json.dumps(dict(png=args.png, P=args.P, **{k: s[k] for k in
                          ("exc0", "abs0", "base", "peakPhase")})
                     if s else dict(png=args.png, unscorable=True)))


def cmd_validate(args):
    rows = list(csv.DictReader(open(args.csv)))
    if args.sample:
        rows = rows[::max(1, len(rows) // args.sample)][:args.sample]
    worst = 0.0
    n = 0
    for r in rows:
        bp = LANE_BAKED[r["lane"]] + r["rsId"] + ".png"
        if not os.path.exists(bp):
            continue
        P = 4 * int(r["scale"])
        s = grid_score(_load(bp), P)
        if s is None:
            continue
        de = abs(s["exc0"] - float(r["exc0"]))
        da = abs(s["abs0"] - float(r["abs0"]))
        n += 1
        worst = max(worst, de)
        flag = "  <-- MISMATCH" if de > args.tol else ""
        print("%s exc0 %+0.4f (csv %+0.4f) abs0 %+0.2f (csv %s) peak %d (csv %s)%s"
              % (r["rsId"], s["exc0"], float(r["exc0"]), s["abs0"], r["abs0"],
                 s["peakPhase"], r["peakPhase"], flag))
    print("validated %d rows, worst |d exc0| = %.4f (tol %.3f)" % (n, worst, args.tol))
    sys.exit(0 if worst <= args.tol else 1)


def cmd_batch(args):
    rows = list(csv.DictReader(open(args.csv)))
    if args.material_only:
        rows = [r for r in rows if r["material"] == "1"]
    os.makedirs(args.out, exist_ok=True)
    led = open(os.path.join(args.out, "deblock-ledger.jsonl"), "w")
    excs_b, excs_a, kept = [], [], []
    for i, r in enumerate(rows):
        sp = os.path.join(args.src_base, r["rsId"] + ".png")
        if not os.path.exists(sp):
            led.write(json.dumps(dict(rsId=r["rsId"], missing=True)) + "\n")
            continue
        rgba = _load(sp)
        out, thr, sb, sa = auto_deblock(rgba, passes=args.passes)
        Image.fromarray(np.clip(out + 0.5, 0, 255).astype(np.uint8), "RGBA") \
             .save(os.path.join(args.out, r["rsId"] + ".png"))
        rec = dict(rsId=r["rsId"], lane=r["lane"], thr=round(thr, 3),
                   passes=args.passes,
                   excBefore=round(sb["exc0"], 4) if sb else None,
                   excAfter=round(sa["exc0"], 4) if sa else None,
                   detailKept=round(sa["base"] / sb["base"], 4) if sb and sa else None)
        led.write(json.dumps(rec) + "\n")
        led.flush()
        if sb and sa:
            excs_b.append(sb["exc0"]); excs_a.append(sa["exc0"])
            kept.append(sa["base"] / sb["base"])
        if (i + 1) % 50 == 0:
            print("%d/%d" % (i + 1, len(rows)), flush=True)
    if excs_b:
        print("deblocked %d: src excess mean %+.1f%% -> %+.1f%% (median %+.1f%% -> %+.1f%%), "
              "off-grid detail kept mean %.0f%% p10 %.0f%%"
              % (len(excs_b), 100 * np.mean(excs_b), 100 * np.mean(excs_a),
                 100 * np.median(excs_b), 100 * np.median(excs_a),
                 100 * np.mean(kept), 100 * np.percentile(kept, 10)))


def cmd_ab(args):
    """Score the A-arm (deblocked->Remacri) bakes against the CSV baselines.

    Pass bar (report section 5C): material count drops 702 -> < 150 and no
    surface loses > 15% off-grid detail (base_new >= 0.85 * base_old, only
    meaningful at equal dims i.e. scale=4 rows).
    """
    rows = [r for r in csv.DictReader(open(args.csv)) if r["material"] == "1"]
    out = open(args.report, "w")
    n = mat_new = detail_fail = scored = 0
    for r in rows:
        np_ = os.path.join(args.new, r["rsId"] + ".png")
        if not os.path.exists(np_):
            continue
        new = _load(np_)
        amask = None
        bp = LANE_BAKED[r["lane"]] + r["rsId"] + ".png"
        if os.path.exists(bp):
            old = _load(bp)
            if old.shape[:2] == new.shape[:2] and (old[:, :, 3] < 250).any():
                amask = old[:, :, 3]
        s = grid_score(new, 16, alpha_mask=amask)
        if s is None:
            out.write(json.dumps(dict(rsId=r["rsId"], unscorable=True)) + "\n")
            continue
        scored += 1
        material = s["exc0"] >= 0.20 and s["abs0"] >= 1.5
        mat_new += material
        comparable = int(r["scale"]) == 4
        kept = s["base"] / float(r["base"]) if comparable else None
        lost = comparable and kept < 0.85
        detail_fail += lost
        out.write(json.dumps(dict(
            rsId=r["rsId"], lane=r["lane"],
            excOld=float(r["exc0"]), excNew=round(s["exc0"], 4),
            absOld=float(r["abs0"]), absNew=round(s["abs0"], 3),
            baseOld=float(r["base"]), baseNew=round(s["base"], 3),
            detailKept=round(kept, 4) if kept is not None else None,
            materialStill=bool(material), detailLost=bool(lost))) + "\n")
    print("A/B: %d scored; material %d -> %d (bar < 150); detail-lost(>15%%) %d (bar 0)"
          % (scored, len(rows), mat_new, detail_fail))
    print("PASS" if (mat_new < 150 and detail_fail == 0) else "FAIL")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("score"); s.add_argument("png"); s.add_argument("--P", type=int, default=4)
    s.set_defaults(fn=cmd_score)
    v = sub.add_parser("validate"); v.add_argument("--csv", required=True)
    v.add_argument("--sample", type=int, default=40); v.add_argument("--tol", type=float, default=0.02)
    v.set_defaults(fn=cmd_validate)
    b = sub.add_parser("batch"); b.add_argument("--csv", required=True)
    b.add_argument("--src-base", default=TEX_BASE); b.add_argument("--out", required=True)
    b.add_argument("--material-only", action="store_true")
    b.add_argument("--passes", type=int, default=2)
    b.set_defaults(fn=cmd_batch)
    a = sub.add_parser("ab"); a.add_argument("--csv", required=True)
    a.add_argument("--new", required=True, help="dir of A-arm bakes from the box")
    a.add_argument("--report", required=True, help="output jsonl")
    a.set_defaults(fn=cmd_ab)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
