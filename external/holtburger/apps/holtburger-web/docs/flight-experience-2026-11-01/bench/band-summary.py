#!/usr/bin/env python3
"""band-summary.py — frame rate by altitude band from the flight rows of 1070 flight runs (flight-1070.mjs result.json).

Each flight row is one sample window (~0.6 s): rafN = rAF ticks in the window, rafMax = the longest rAF interval in it,
lt = long tasks. Valid for UNCAPPED runs only (under the 30 fps cap rAF ticks at the display rate).
Usage: band-summary.py <run dir> [<run dir> ...]
"""
import json
import statistics
import sys

BANDS = [(0, 450, "< 450 m"), (450, 1800, "0.45-1.8 km"), (1800, 4500, "1.8-4.5 km"), (4500, 1e9, ">= 4.5 km")]


def pct(xs, p):
    if not xs:
        return None
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(p / 100 * (len(xs) - 1))))]


for d in sys.argv[1:]:
    r = json.load(open(d.rstrip("/") + "/result.json"))
    rows = ((r.get("steps") or {}).get("flight") or {}).get("rows") or []
    print(f"{r.get('label', d)}  ({len(rows)} rows; url flags: {r.get('url', '').split('vehicles=on&')[-1]})")
    prev = None
    per = {b[2]: {"fps": [], "max": [], "secs": 0.0, "over100": 0, "lt": 0} for b in BANDS}
    for row in rows:
        if prev is not None and row.get("phase") in ("fly", "climb", "descend", "cruise", "landing", "takeoff"):
            dt = row["t"] - prev["t"]
            if 0.05 < dt < 5 and row.get("rafN"):
                agl = row.get("agl") or 0
                for lo, hi, name in BANDS:
                    if lo <= agl < hi:
                        b = per[name]
                        b["fps"].append(row["rafN"] / dt)
                        b["max"].append(row.get("rafMax") or 0)
                        b["secs"] += dt
                        b["over100"] += 1 if (row.get("rafMax") or 0) > 100 else 0
                        b["lt"] += (row.get("lt") or {}).get("ms", 0)
                        break
        prev = row
    for lo, hi, name in BANDS:
        b = per[name]
        if not b["fps"]:
            continue
        print(f"   {name:>12}: {b['secs']:6.1f} s  fps median {statistics.median(b['fps']):5.1f}  p10 {pct(b['fps'], 10):5.1f}  "
              f"window-max p50 {pct(b['max'], 50)} ms  p90 {pct(b['max'], 90)} ms  worst {max(b['max'])} ms  "
              f"windows >100 ms {b['over100']}  long-task ms {b['lt']}")
