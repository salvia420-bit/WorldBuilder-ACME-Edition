# Attribute CPU samples inside long frames (>= MIN ms) of a tourprof capture.
import json, sys
from collections import defaultdict
base = sys.argv[1]; MIN = float(sys.argv[2]) if len(sys.argv) > 2 else 50
prof = json.load(open(base + ".cpuprofile")); fr = json.load(open(base + ".frames.json"))
nodes = {n['id']: n for n in prof['nodes']}
parent = {}
for n in prof['nodes']:
    for c in n.get('children', []): parent[c] = n['id']
def key(n):
    cf = n['callFrame']; u = cf['url'].split('/')[-1].split('?')[0]
    return f"{cf['functionName'] or '(anon)'} {u}:{cf['lineNumber']+1}"
# sample absolute times (ms, profile clock)
t = prof['startTime'] / 1000.0; times = []
for d in prof['timeDeltas']: t += d / 1000.0; times.append(t)
S = prof['samples']
# marker: first sample whose stack contains __hbMark
mark_t = None
for i, sid in enumerate(S):
    nid = sid; hit = False
    while nid is not None:
        if nodes[nid]['callFrame']['functionName'] == '__hbMark': hit = True; break
        nid = parent.get(nid)
    if hit: mark_t = times[i]; break
off = mark_t - fr['tMark']  # profile_ms = page_ms + off
F = fr['frames']
long = [(F[i], F[i+1]) for i in range(len(F)-1) if F[i+1] - F[i] >= MIN]
print(f"marker offset {off:.1f} ms; frames {len(F)-1}; long frames >= {MIN}: {len(long)}; total {sum(b-a for a,b in long):.0f} ms")
import bisect
agg_self = defaultdict(float); agg_app = defaultdict(float); per = []
for a, b in long:
    lo = bisect.bisect_left(times, a + off); hi = bisect.bisect_left(times, b + off)
    s = defaultdict(float); app = defaultdict(float)
    for i in range(lo, hi):
        dt = (times[i] - times[i-1]) if i > 0 else 0.5
        sid = S[i]; k = key(nodes[sid]); s[k] += dt
        seen = set(); nid = sid
        while nid is not None:
            u = nodes[nid]['callFrame']['url']; kk = key(nodes[nid])
            if kk not in seen and ('/scene3d/' in u or 'holtburger_web' in u or 'index.html' in u or '/app/' in u or '/ui/' in u or '/plugins/' in u):
                seen.add(kk); app[kk] += dt
            nid = parent.get(nid)
    for k, v in s.items(): agg_self[k] += v
    for k, v in app.items(): agg_app[k] += v
    per.append((b - a, a, s, app))
for ms, a, s, app in sorted(per, key=lambda x: -x[0])[:10]:
    print(f"\n== frame @{a - F[0]:.0f}ms dur {ms:.0f}ms")
    print("   self: " + "; ".join(f"{k} {v:.0f}" for k, v in sorted(s.items(), key=lambda kv: -kv[1])[:5]))
    print("   app : " + "; ".join(f"{k} {v:.0f}" for k, v in sorted(app.items(), key=lambda kv: -kv[1])[:8]))
print("\n--- aggregate self over long frames")
for k, v in sorted(agg_self.items(), key=lambda kv: -kv[1])[:25]: print(f"{v:8.0f}  {k}")
print("--- aggregate app-inclusive over long frames")
for k, v in sorted(agg_app.items(), key=lambda kv: -kv[1])[:40]: print(f"{v:8.0f}  {k}")
