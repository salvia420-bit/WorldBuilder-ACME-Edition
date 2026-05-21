#!/usr/bin/env bash
# diff-perf.sh — print a side-by-side perf delta between two runs.
# Usage: diff-perf.sh A B
#   A, B may be a run directory or a path to summary.json directly.

set -uo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 A B" >&2
  echo "  A, B = perf-worker run dir, or summary.json path" >&2
  exit 1
fi

resolve_summary() {
  local p="$1"
  if [[ -f "$p" ]]; then echo "$p"; return; fi
  if [[ -d "$p" && -f "$p/summary.json" ]]; then echo "$p/summary.json"; return; fi
  echo "ERROR: not a summary.json or run dir: $p" >&2
  exit 2
}

A_SUM="$(resolve_summary "$1")"
B_SUM="$(resolve_summary "$2")"
A_DIR="$(dirname "$A_SUM")"
B_DIR="$(dirname "$B_SUM")"
A_META="${A_DIR}/meta.json"
B_META="${B_DIR}/meta.json"

python3 - "$A_SUM" "$B_SUM" "$A_META" "$B_META" <<'PY'
import json, sys, os

def load(p):
    try:
        with open(p) as f: return json.load(f)
    except Exception: return {}

a_full = load(sys.argv[1])
b_full = load(sys.argv[2])
a = (a_full.get("result") or {}) if "result" in a_full else a_full
b = (b_full.get("result") or {}) if "result" in b_full else b_full
am = load(sys.argv[3])
bm = load(sys.argv[4])

def lbl(m, fallback):
    return (m.get("label") if m else None) or fallback

A_LBL = lbl(am, "A"); B_LBL = lbl(bm, "B")

USE_COLOR = sys.stdout.isatty()
def c(s, code):
    if not USE_COLOR: return s
    return f"\033[{code}m{s}\033[0m"
RED  = lambda s: c(s, "31")
GRN  = lambda s: c(s, "32")
DIM  = lambda s: c(s, "2")
BOLD = lambda s: c(s, "1")

def fmt_num(v):
    if v is None: return "-"
    if isinstance(v, float): return f"{v:.2f}"
    return str(v)

def diff_cell(a_v, b_v, higher_is_better):
    """Return formatted delta string with color."""
    if a_v is None or b_v is None: return DIM("n/a")
    try:
        dv = b_v - a_v
        pct = (dv / a_v * 100.0) if a_v not in (0, 0.0) else None
    except Exception:
        return DIM("?")
    sign = "+" if dv >= 0 else ""
    pct_s = f"  ({sign}{pct:.1f}%)" if pct is not None else ""
    raw  = f"{sign}{dv:.2f}"
    improving = (dv > 0) if higher_is_better else (dv < 0)
    if abs(dv) < 1e-9: return DIM("(no Δ)")
    return (GRN if improving else RED)(f"{raw}{pct_s}")

print()
print("=" * 90)
print(f"  A/B PERF DIFF   A={BOLD(A_LBL)}   B={BOLD(B_LBL)}")
if am and bm:
    print(f"     A: git={am.get('git', {}).get('head', 'n/a')[:7]} quality={am.get('quality')} pattern={am.get('patternVersion')}")
    print(f"     B: git={bm.get('git', {}).get('head', 'n/a')[:7]} quality={bm.get('quality')} pattern={bm.get('patternVersion')}")
print("=" * 90)

# Validate same pattern — perf comparisons are meaningless across patterns.
ap = am.get("patternVersion") if am else None
bp = bm.get("patternVersion") if bm else None
if ap and bp and ap != bp:
    print(RED(f"  WARNING: pattern mismatch ({ap} vs {bp}) — diff may be invalid"))
    print()

aq = am.get("quality") if am else None
bq = bm.get("quality") if bm else None
if aq and bq and aq != bq:
    print(RED(f"  WARNING: quality preset differs ({aq} vs {bq})"))
    print()

rows = []
def row(label, a_v, b_v, higher_is_better=True):
    rows.append((label, fmt_num(a_v), fmt_num(b_v), diff_cell(a_v, b_v, higher_is_better)))

aft = a.get("frameTimeMs") or {}
bft = b.get("frameTimeMs") or {}
ahc = a.get("hitchCounts") or {}
bhc = b.get("hitchCounts") or {}
aht = a.get("hitchTimeMs") or {}
bht = b.get("hitchTimeMs") or {}
apo = a.get("pose") or {}
bpo = b.get("pose") or {}
ars = (a.get("renderer") or {}).get("end") or {}
brs = (b.get("renderer") or {}).get("end") or {}
alt = a.get("longTask") or {}
blt = b.get("longTask") or {}

row("fps avg",          a.get("avgFps"),    b.get("avgFps"),    higher_is_better=True)
row("frame p50 ms",     aft.get("p50"),     bft.get("p50"),     higher_is_better=False)
row("frame p95 ms",     aft.get("p95"),     bft.get("p95"),     higher_is_better=False)
row("frame p99 ms",     aft.get("p99"),     bft.get("p99"),     higher_is_better=False)
row("frame max ms",     aft.get("max"),     bft.get("max"),     higher_is_better=False)
row("hitches >=50ms",   ahc.get(">=50ms"),  bhc.get(">=50ms"),  higher_is_better=False)
row("hitches >=100ms",  ahc.get(">=100ms"), bhc.get(">=100ms"), higher_is_better=False)
row("hitches >=250ms",  ahc.get(">=250ms"), bhc.get(">=250ms"), higher_is_better=False)
row("hitches >=500ms",  ahc.get(">=500ms"), bhc.get(">=500ms"), higher_is_better=False)
row("hitches >=1000ms", ahc.get(">=1000ms"),bhc.get(">=1000ms"),higher_is_better=False)
row("hitch time >=100ms ms", aht.get(">=100ms"), bht.get(">=100ms"), higher_is_better=False)
row("hitch time >=500ms ms", aht.get(">=500ms"), bht.get(">=500ms"), higher_is_better=False)
row("longtask count",   alt.get("count"),   blt.get("count"),   higher_is_better=False)
row("longtask max ms",  alt.get("maxMs"),   blt.get("maxMs"),   higher_is_better=False)
row("longtask sum ms",  alt.get("sumMs"),   blt.get("sumMs"),   higher_is_better=False)
row("path length m",    apo.get("pathLengthM"), bpo.get("pathLengthM"), higher_is_better=True)
row("draws/frame end",  ars.get("callsPerFrame"),     brs.get("callsPerFrame"),     higher_is_better=False)
row("tris/frame end",   ars.get("trianglesPerFrame"), brs.get("trianglesPerFrame"), higher_is_better=False)
row("meshes (end)",     ars.get("meshes"),  brs.get("meshes"),  higher_is_better=False)
row("textures (end)",   ars.get("textures"),brs.get("textures"),higher_is_better=False)
row("geometries (end)", ars.get("geometries"), brs.get("geometries"), higher_is_better=False)
row("programs (end)",   ars.get("programs"),brs.get("programs"),higher_is_better=False)

# Column widths
lw = max(len("metric"), max(len(r[0]) for r in rows))
av_w = max(len("A"), max(len(r[1]) for r in rows))
bv_w = max(len("B"), max(len(r[2]) for r in rows))

print(f"  {'metric'.ljust(lw)}   {'A'.rjust(av_w)}   {'B'.rjust(bv_w)}   Δ (B - A)")
print("  " + "-" * (lw + 6 + av_w + 6 + bv_w + 3 + 20))
for label, av, bv, dv in rows:
    print(f"  {label.ljust(lw)}   {av.rjust(av_w)}   {bv.rjust(bv_w)}   {dv}")

print()
# Headline call: did B improve over A?
def cmp_lower(a_v, b_v, ratio_thresh=0.05):
    if a_v in (None, 0, 0.0) or b_v is None: return None
    return (b_v - a_v) / a_v
deltas = {
    "fps_avg":      None if a.get("avgFps") in (None, 0) else (b.get("avgFps", 0) - a.get("avgFps", 0)) / a.get("avgFps"),
    "p95_ms":       cmp_lower(aft.get("p95"), bft.get("p95")),
    "hitches_100":  cmp_lower(ahc.get(">=100ms"), bhc.get(">=100ms")),
}
# Build a short verdict
gains, losses = [], []
if deltas["fps_avg"] is not None:
    if deltas["fps_avg"] > 0.03:  gains.append(f"fps avg +{deltas['fps_avg']*100:.1f}%")
    if deltas["fps_avg"] < -0.03: losses.append(f"fps avg {deltas['fps_avg']*100:.1f}%")
if deltas["p95_ms"] is not None:
    if deltas["p95_ms"] < -0.05:  gains.append(f"p95 frame {deltas['p95_ms']*100:.1f}%")
    if deltas["p95_ms"] > 0.05:   losses.append(f"p95 frame +{deltas['p95_ms']*100:.1f}%")
if deltas["hitches_100"] is not None:
    if deltas["hitches_100"] < -0.10: gains.append(f"hitches>=100ms {deltas['hitches_100']*100:.1f}%")
    if deltas["hitches_100"] > 0.10:  losses.append(f"hitches>=100ms +{deltas['hitches_100']*100:.1f}%")

print("  VERDICT:")
if not gains and not losses:
    print("    " + DIM("noise / no significant Δ on tracked metrics"))
else:
    for g in gains:  print("    " + GRN("✓ ") + g)
    for l in losses: print("    " + RED("✗ ") + l)
print()
PY
