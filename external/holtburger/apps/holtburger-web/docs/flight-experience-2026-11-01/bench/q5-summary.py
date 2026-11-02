#!/usr/bin/env python3
"""q5-summary.py — the Q5 / Q7 read-out of 1070 flight runs (flight-1070.mjs result.json).

Only UNCAPPED runs (--uncapped, ?targetFps=0) have real frame times in `frames`: under the 30 fps cap rAF ticks at
the display rate while the loop renders every other tick. Usage: q5-summary.py <run dir> [<run dir> ...]
"""
import json
import sys


def row(label, fr):
    if not fr:
        return f"{label}: no frame record"
    a = fr.get("after60") or {}
    of = fr.get("onFoot") or {}
    return (f"{label}: flight {fr['seconds']} s, fps mean {fr['fpsMean']}, p50 {fr['p50']} ms, p99 {fr['p99']} ms, "
            f"max {fr['max']} ms | after 60 s: fps {a.get('fpsMean')}, p50 {a.get('p50')} ms, p99 {a.get('p99')} ms, "
            f"max {a.get('max')} ms, >100 ms {a.get('over100')}, >50 ms {a.get('over50')} | on foot: fps {of.get('fpsMean')}, "
            f"p50 {of.get('p50')}, p99 {of.get('p99')}, max {of.get('max')}")


for d in sys.argv[1:]:
    r = json.load(open(d.rstrip("/") + "/result.json"))
    print(row(r.get("label", d), r.get("frames")))
    f = (r.get("steps") or {}).get("flight") or {}
    s = f.get("summary") or {}
    print(f"   flight: {s.get('travelledKm')} km, corrections {s.get('corrections')} (max {s.get('corrMax')} m), "
          f"AGL median {s.get('aglMedian')}, long task max {s.get('longTaskMax')} ms, heap max {s.get('heapMax')} MB; "
          f"window {json.dumps(r.get('window'))}; url flags: {r.get('url', '').split('vehicles=on&')[-1]}")
    for p in r.get("profiles") or []:
        idle = next((x for x in p.get("selfByFn", []) if x["name"].startswith("(idle)")), None)
        print(f"   profile @{p['window'][0]} s (AGL {round(p.get('agl') or 0)}): idle {idle['pct'] if idle else '?'} %, "
              f"top files {[(x['name'], x['pct']) for x in p['selfByFile'][:5]]}")
