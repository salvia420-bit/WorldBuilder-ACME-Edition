# angleattr.py — GPU-process self time by (thread, event) from a gputrace.mjs capture, plus what overlapped the
# worst frames. Usage: python3 angleattr.py trace.json '{"worst": [[ms, offsetMs], ...]}'
import json, sys, collections
tr = json.load(open(sys.argv[1])); ev = tr["traceEvents"] if isinstance(tr, dict) else tr
pn, tn = {}, {}
for e in ev:
    if e.get("ph") == "M" and e.get("name") == "process_name": pn[e["pid"]] = e["args"].get("name")
    if e.get("ph") == "M" and e.get("name") == "thread_name": tn[(e["pid"], e["tid"])] = e["args"].get("name")
T0 = [e for e in ev if e.get("name") == "hbSweepStart"][0]["ts"]
# build complete spans (X, and B/E pairs) per thread with nesting for self-time
spans = []
stacks = collections.defaultdict(list)
for e in sorted((e for e in ev if e.get("ph") in ("X", "B", "E")), key=lambda e: (e["ts"], 0 if e["ph"] != "E" else -1)):
    ph = e["ph"]; key = (e["pid"], e["tid"])
    if ph == "X": spans.append([e["ts"], e["ts"] + e.get("dur", 0), key, e["name"], e.get("cat")])
    elif ph == "B": stacks[key].append(e)
    elif ph == "E" and stacks[key]: b = stacks[key].pop(); spans.append([b["ts"], e["ts"], key, b["name"], b.get("cat")])
gp = {p for p, n in pn.items() if n == "GPU Process"}
# self time per name on GPU threads
bythr = collections.defaultdict(list)
for s in spans:
    if s[2][0] in gp: bythr[s[2]].append(s)
selft = collections.Counter(); tot = collections.Counter(); cnt = collections.Counter(); mx = collections.Counter()
for key, L in bythr.items():
    L.sort(key=lambda s: (s[0], -(s[1] - s[0])))
    st = []
    for s in L:
        while st and st[-1][1] <= s[0]: st.pop()
        d = s[1] - s[0]
        k = (tn.get(key), s[3])
        tot[k] += d; cnt[k] += 1; mx[k] = max(mx[k], d); selft[k] += d
        if st: selft[(tn.get(key), st[-1][3])] -= d
        st.append(s)
print("GPU-process self time by (thread, event) — top 40:")
for k, v in selft.most_common(40):
    print(f"  self {v/1000:8.1f} ms  total {tot[k]/1000:8.1f}  n={cnt[k]:6d}  max {mx[k]/1000:7.1f}  {k[0]}  {k[1]}")
res = json.loads(sys.argv[2]) if len(sys.argv) > 2 else None
if res:
    for dur, off in res["worst"][:6]:
        a = T0 + off * 1000; b = a + dur * 1000
        print(f"\n=== frame {dur} ms at +{off} ms: GPU-process events overlapping, by self-time ===")
        c = collections.Counter(); m = {}
        for key, L in bythr.items():
            for s in L:
                if s[1] > a - 100000 and s[0] < b:
                    k = (tn.get(key), s[3]); d = min(s[1], b) - max(s[0], a - 100000); c[k] += d; m[k] = max(m.get(k, 0), s[1] - s[0])
        for k, v in c.most_common(14): print(f"   {v/1000:7.1f} ms (max single {m[k]/1000:6.1f})  {k[0]}  {k[1]}")
