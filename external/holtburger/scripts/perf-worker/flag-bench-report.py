#!/usr/bin/env python3
"""flag-bench-report.py DIR [DIR...] — per-arm table for flag-bench.mjs output.

Pools every <arm>-r<rep>/result.json without an `error` across the given
dirs, then compares each arm against the baseline of its quality ("base" for
mid, "baseHigh" for high). Frame times snap to the display's vsync steps
(8.33 ms at 120 Hz), so p50 moves in coarse jumps: the MEAN frame time is the
primary metric; p50/p95 are shown for shape. "spread" is max-min of the
per-rep means; a delta inside the larger of the two spreads is NOISE.
"""
import glob
import json
import os
import statistics as st
import sys

runs = {}
for d in sys.argv[1:]:
    for f in sorted(glob.glob(os.path.join(d, "*", "result.json"))):
        r = json.load(open(f))
        if r.get("error"):
            continue
        runs.setdefault(r["arm"], []).append(r)

BASE = {"mid": "base", "high": "baseHigh"}


def agg(rs, win, key):
    xs = [r[win][key] for r in rs if r.get(win) and r[win].get(key) is not None]
    return xs


def fmt(xs):
    if not xs:
        return "-"
    return f"{st.mean(xs):6.1f}"


print(f"{'arm':15} n  | {'STILL mean':>10} {'spr':>5} {'p50':>5} {'p95':>5} | {'MOVING mean':>11} {'spr':>5} {'p50':>5} {'p95':>5} | draws | tour h50 h100  max | errs")
order = ["base", "geomCache", "batchRuns", "sortProgram", "allOn", "baseHigh", "memoSlotsHigh", "allOnHigh"]
for arm in order + sorted(set(runs) - set(order)):
    rs = runs.get(arm)
    if not rs:
        continue
    line = f"{arm:15} {len(rs)}  |"
    for win in ("still", "moving"):
        m = agg(rs, win, "mean")
        line += f" {fmt(m):>10} {(max(m) - min(m)) if m else 0:5.1f} {fmt(agg(rs, win, 'p50')):>5} {fmt(agg(rs, win, 'p95')):>5} |" if win == "still" else \
                f" {fmt(m):>11} {(max(m) - min(m)) if m else 0:5.1f} {fmt(agg(rs, win, 'p50')):>5} {fmt(agg(rs, win, 'p95')):>5} |"
    line += f" {fmt(agg(rs, 'still', 'drawsPerFrame')):>5} |"
    t = [r for r in rs if r.get("tour")]
    if t:
        line += f" {st.mean([r['tour']['hitch50'] for r in t]):8.0f} {st.mean([r['tour']['hitch100'] for r in t]):4.0f} {st.mean([r['tour']['max'] for r in t]):5.0f} |"
    else:
        line += f" {'':>19} |"
    line += f" {sum(len(r.get('errors', [])) for r in rs)}"
    print(line)

print("\nverdicts (mean frame ms vs same-quality base; NOISE if |delta| <= max spread):")
for arm, rs in sorted(runs.items()):
    q = rs[0]["quality"]
    b = runs.get(BASE.get(q))
    if not b or arm == BASE.get(q):
        continue
    out = []
    for win in ("still", "moving"):
        a, bb = agg(rs, win, "mean"), agg(b, win, "mean")
        if not a or not bb:
            continue
        delta = st.mean(a) - st.mean(bb)
        spread = max(max(a) - min(a), max(bb) - min(bb))
        tag = "NOISE" if abs(delta) <= spread or len(a) < 2 or len(bb) < 2 else ("BETTER" if delta < 0 else "WORSE")
        out.append(f"{win} {delta:+.1f} ms ({100 * delta / st.mean(bb):+.0f}%) {tag} [spread {spread:.1f}]")
    print(f"  {arm:15} " + " | ".join(out))

probes = [p for r in runs.get("sortProgram", []) for p in [r.get("sortProbe")] if p]
if probes:
    off = [x["switchesPerFrame"] for p in probes for x in p.get("off", []) if x.get("switchesPerFrame")]
    on = [x["switchesPerFrame"] for p in probes for x in p.get("on", []) if x.get("switchesPerFrame")]
    if off and on:
        print(f"\ndrawSortProgram live probe: program switches/frame off {st.mean(off):.0f} -> on {st.mean(on):.0f} ({100 * (st.mean(on) / st.mean(off) - 1):+.0f}%), n={len(off)}/{len(on)}")

gc = [r["snapEnd"].get("geomCache") for r in runs.get("geomCache", []) + runs.get("allOn", []) if r.get("snapEnd") and r["snapEnd"].get("geomCache")]
if gc:
    print("statGeomCache end-of-run:", json.dumps(gc[-1])[:400])
