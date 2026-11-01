#!/usr/bin/env python3
"""analyze.py <result.json> [...] — one table row per carry-flight step (hb-carry experiment, 2026-10-31)."""
import json, sys

def g(d, *ks, default=None):
    for k in ks:
        if d is None:
            return default
        d = d.get(k) if isinstance(d, dict) else None
    return default if d is None else d

COLS = [
    ("step", lambda s, r, x: s.get("name")),
    ("km/h tgt", lambda s, r, x: g(s, "step", "speedKmh")),
    ("km/h cruise", lambda s, r, x: g(x, "cruiseKmhMed")),
    ("km/h avg", lambda s, r, x: g(x, "achievedKmh")),
    ("m", lambda s, r, x: g(x, "metres")),
    ("AGL tgt/med/min", lambda s, r, x: f"{g(s,'step','aglM')}/{g(x,'aglMed')}/{g(x,'aglMin')}"),
    ("blind", lambda s, r, x: g(x, "blindCtlFrac")),
    ("underBaked", lambda s, r, x: g(x, "terrainUnderBakedFrac")),
    ("ring r1/r2/r3/r5", lambda s, r, x: f"{g(x,'r1Mean')}/{g(x,'r2Mean')}/{g(x,'r3Mean')}/{g(x,'r5Mean')}"),
    ("lead med/min m", lambda s, r, x: f"{g(x,'leadMed')}/{g(x,'leadMin')}"),
    ("physLead med/min", lambda s, r, x: f"{g(x,'physLeadMed')}/{g(x,'physLeadMin')}"),
    ("bubble mean/zero", lambda s, r, x: f"{g(x,'bubbleMean')}/{g(x,'bubbleZeroFrac')}"),
    ("newObj", lambda s, r, x: g(x, "newObjectsInFlight")),
    ("1st-seen min/med/max", lambda s, r, x: "/".join(str(v) for v in (g(x,'firstSeen','min'), g(x,'firstSeen','median'), g(x,'firstSeen','max')))),
    ("ahead", lambda s, r, x: g(x, "firstSeenAheadFrac")),
    ("census med/max", lambda s, r, x: f"{g(x,'censusDrawsMed')}/{g(x,'censusDrawsMax')}"),
    ("LT ms/s", lambda s, r, x: g(x, "longTaskMsPerSec")),
    ("LT max", lambda s, r, x: g(x, "longTaskMax")),
    ("rAF p95/max", lambda s, r, x: f"{g(x,'rafP95Med')}/{g(x,'rafMax')}"),
    ("heap s/e/max", lambda s, r, x: f"{g(x,'heapStart')}/{g(x,'heapEnd')}/{g(x,'heapMax')}"),
    ("LRU max/evict", lambda s, r, x: f"{g(x,'lruResidentMax')}/{g(x,'lruEvicted')}"),
    ("bakeQ max", lambda s, r, x: g(x, "bakeQueueMax")),
    ("carry sends/catch/maxGap", lambda s, r, x: f"{g(x,'carry','sends')}/{g(x,'carry','catchUps')}/{g(x,'carry','maxGapM')}"),
    ("ACE cpu%", lambda s, r, x: g(s, "ace", "cpuPct")),
    ("chrome cpu%/gpu%/rss", lambda s, r, x: f"{g(s,'chrome','cpuPct')}/{g(s,'chrome','gpuProcCpuPct')}/{g(s,'chrome','rssMB')}"),
    ("ACE log", lambda s, r, x: len(g(s, "ace", "log", default=[]))),
    ("state", lambda s, r, x: g(x, "droneState")),
    ("err", lambda s, r, x: (s.get("error") or "")[:60] + ";".join(e[:80] for e in g(r, "errors", default=[]))),
]

for f in sys.argv[1:]:
    d = json.load(open(f))
    print(f"== {f}  render={d.get('render')} boot={g(d,'boot','ms')}ms errors={d.get('errors')}")
    for s in d.get("steps", []):
        r = s.get("result") or {}
        x = r.get("summary") or {}
        if not x and 'views' in r:
            for v in r['views']:
                print(f"-- {s.get('name')} view {v.get('label')}: " + json.dumps({k: v.get(k) for k in ('calls','tris','census','ratio','msPerFrame','agl','frames','p50','p95','max','meanMs')}))
            print(f"   chrome {s.get('chrome')} ace {s.get('ace',{}).get('cpuPct')}")
            continue
        print(f"-- {s.get('name')}  deploy={r.get('deploySec')}s climb={r.get('climbSec')}s fly={r.get('flySec')}s fatal={r.get('fatal')}")
        for name, fn in COLS[1:]:
            try:
                v = fn(s, r, x)
            except Exception as e:  # noqa: BLE001
                v = f"?{e}"
            print(f"   {name:>26}: {v}")
        for l in g(s, "ace", "log", default=[])[:8]:
            print("   ACE:", l[:220])
        if "views" in r:
            for v in r["views"]:
                if 'calls' in v:
                    print(f"   view {v['label']}: calls {v['calls']} tris {v['tris']} census {v['census']} ratio {v.get('ratio')} ms {v['msPerFrame']} agl {v.get('agl')}")
                else:
                    print(f"   view {v['label']}: frames {v.get('frames')} p50 {v.get('p50')} p95 {v.get('p95')} max {v.get('max')} mean {v.get('meanMs')} LT {v.get('longTasks')}")
    pe = d.get("pageErrors") or []
    ce = d.get("consoleErrors") or []
    print(f"page errors {len(pe)}; console errors {len(ce)}")
    for e in (pe[:5] + ce[:10]):
        print("   ", e[:240])
