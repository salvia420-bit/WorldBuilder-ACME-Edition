#!/usr/bin/env python3
"""wspy.py acad-<label>.json [--min-dids N] — an academy.mjs --workerspy run's bake-worker timeline:
each message (arrival → reply, run clock) and the worker's event-loop blocks (synchronous wasm)."""
import json, sys, collections
d = json.load(open(sys.argv[1])); t0 = d["t0"]
mind = int(sys.argv[sys.argv.index("--min-dids") + 1]) if "--min-dids" in sys.argv else 0
for w in d["net"]["workers"]:
    sp = w.get("spy")
    if not sp:
        continue
    off = sp["origin"] - t0
    ins = {}
    for m in sp["msgs"]:
        if m[0] == "in":
            ins[m[3]] = m
            continue
        i = ins.get(m[3])
        if i and (i[4] >= mind or i[2] == "fetchModelMeshes"):
            print(f"id {m[3]:>3} {i[2]:<30} n={i[4]:<4} urgent={str(i[5]):<5} in {(i[1] + off) / 1000:6.2f}s "
                  f"out {(m[1] + off) / 1000:6.2f}s  {(m[1] - i[1]) / 1000:5.2f}s {m[2]}")
    per = collections.Counter()
    for st, ms in sp["lag"]:
        per[int((st + off) / 1000)] += ms
    print("blocked ms per second:", " ".join(f"{k}:{v}" for k, v in sorted(per.items())))
    print("blocks > 300 ms:", [(round((st + off) / 1000, 2), ms) for st, ms in sp["lag"] if ms > 300])
