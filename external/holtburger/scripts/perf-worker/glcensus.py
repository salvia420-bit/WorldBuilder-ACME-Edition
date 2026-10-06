# glcensus.py — analyse a glcensus.js result: phases, long frames (+2 before), uploads by owner,
# first draws by owner, LoAF. Usage: python3 glcensus.py census.json [MIN_FRAME_MS]
import json, sys, collections
d = json.load(open(sys.argv[1])); K = d["keys"]; rows = [dict(zip(K, r)) for r in d["rows"]]
thr = float(sys.argv[2]) if len(sys.argv) > 2 else 80
print(f"mode={d['mode']} frames={len(rows)} scanMs={d['scanMs']} scans={d['scans']} programs={d.get('programs')} asyncLink={json.dumps(d.get('asyncLink'))}")
for ph in ("pre", "sweep", "post"):
    R = [r for r in rows if r["phase"] == ph]
    if not R: continue
    tot = sum(r["dt"] for r in R); n = len(R); s = sorted(r["dt"] for r in R); agg = lambda k: sum(r[k] for r in R)
    L = sorted(r["lagMs"] for r in R if r["lagMs"] >= 0)
    print(f"[{ph}] n={n} fps={n/(tot/1000):.1f} p50={s[n//2]:.1f} max={s[-1]:.0f} >50={sum(1 for x in s if x>50)} >100={sum(1 for x in s if x>100)} jank(>50,-33)={sum(x-33.3 for x in s if x>50):.0f}ms | draws/f {agg('dr')/n:.0f}+{agg('inst')/n:.0f}i+{agg('md')/n:.0f}md rMs/f {agg('rMs')/n:.1f} | tex {agg('texN')} {agg('texB')/1e6:.1f}MB {agg('texMs'):.0f}ms buf {agg('bufN')} {agg('bufB')/1e6:.1f}MB {agg('bufMs'):.0f}ms newDraw {agg('newDraw')} cmp {agg('cmp')} lnk {agg('lnk')} | prog {R[0]['prog']}->{R[-1]['prog']} geo {R[0]['geo']}->{R[-1]['geo']} txc {R[0]['txc']}->{R[-1]['txc']} | lag p50 {L[len(L)//2] if L else -1} max {L[-1] if L else -1}")
print(f"\nframes dt>={thr} (+2 before):")
print("fi   ph     dt   rMs  maxMs maxName              dr   md  texN texMB  texMs bufN bufMB bufMs newD cmp lnk  lag  prog geo  txc")
show = set()
for i, r in enumerate(rows):
    if r["dt"] >= thr: show.update([i - 2, i - 1, i])
for i in sorted(x for x in show if 0 <= x < len(rows)):
    r = rows[i]
    print(f"{i:<4d} {r['phase']:<5s} {r['dt']:5.0f} {r['rMs']:5.1f} {r['maxMs']:5.1f} {r['maxName'][:20]:<20s} {r['dr']:4d} {r['md']:4d} {r['texN']:4d} {r['texB']/1e6:5.2f} {r['texMs']:5.1f} {r['bufN']:4d} {r['bufB']/1e6:5.2f} {r['bufMs']:5.1f} {r['newDraw']:4d} {r['cmp']:3d} {r['lnk']:3d} {r['lagMs']:4d} {r['prog']:4d} {r['geo']:4d} {r['txc']:4d}")
print("\nuploads by owner (MB, calls, main-ms, by phase):")
for u in d["ups"][:45]: print(f"  {u['mb']:7.2f}MB n={u['n']:5d} {u['ms']:6.1f}ms first@{u['firstFi']:<4d} {json.dumps(u['ph'])} {u['k']} {u['tex']}")
grp = collections.defaultdict(float)
for u in d["ups"]:
    if u["ph"].get("sweep"): grp[u["k"].split(":")[0] + " " + u["k"].split("|")[1].strip().split(":")[0]] += u["ph"]["sweep"]
print("\nsweep upload MB by group+kind:", sorted(((k, round(v, 1)) for k, v in grp.items()), key=lambda x: -x[1]))
print("\nnew draws (first drawn after pre) by owner:")
for e in d["newDraws"][:30]: print(f"  n={e['n']:4d} verts={e['verts']:7d} first@{e['firstFi']:<4d} {e['k']}")
print("\nunattributed uploads:", len(d["unknownUp"]))
for u in d["unknownUp"][:12]: print("  ", json.dumps(u)[:300])
print("\nLoAF:")
for e in d["loaf"][:20]: print("  ", json.dumps(e)[:300])
