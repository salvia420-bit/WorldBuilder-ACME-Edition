#!/usr/bin/env python3
"""table.py result.json [...] — one compact row per flight step."""
import json, sys
def f(v, w):
    return f"{('-' if v is None else v)!s:>{w}}"
cols = [("run",16),("kmh",5),("cruise",6),("AGL",5),("r2/r3/r5",14),("lead m",10),("newObj",6),("1st med",7),("ahead",5),("bub0",5),("LTms/s",6),("LTmax",5),("rAFp95",6),("rAFmax",6),("heapMax",7),("evict",5),("gap",5),("ACE%",5),("ACElog",6),("census",9)]
print(" ".join(f"{n:>{w}}" for n,w in cols))
for fn in sys.argv[1:]:
    d = json.load(open(fn))
    for s in d.get("steps", []):
        r = s.get("result") or {}; x = r.get("summary")
        if not x or "cruiseKmhMed" not in x:
            continue
        fs = x.get("firstSeen") or {}
        ace = s.get("ace") or {}
        vals = [s["name"][:16], s["step"].get("speedKmh"), x.get("cruiseKmhMed"), x.get("aglMed"),
                f"{x.get('r2Mean')}/{x.get('r3Mean')}/{x.get('r5Mean')}", f"{x.get('leadMed')}/{x.get('leadMin')}",
                x.get("newObjectsInFlight"), fs.get("median"), x.get("firstSeenAheadFrac"), x.get("bubbleZeroFrac"),
                x.get("longTaskMsPerSec"), x.get("longTaskMax"), x.get("rafP95Med"), x.get("rafMax"), x.get("heapMax"),
                x.get("lruEvicted"), x.get("playerGapMax"), ace.get("cpuPct"), len(ace.get("log") or []),
                f"{x.get('censusDrawsMed')}/{x.get('censusDrawsMax')}"]
        print(" ".join(f(v, w) for v, (_, w) in zip(vals, cols)))
