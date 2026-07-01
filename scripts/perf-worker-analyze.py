#!/usr/bin/env python3
"""Analyze a walk-west-driver samples.jsonl. Usage: perf-worker-analyze.py <dir> [--table]"""
import sys, json, os

def load(d):
    rows = []
    with open(os.path.join(d, 'samples.jsonl')) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except Exception:
                pass
    return rows

def g(s, *path):
    cur = s
    for p in path:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(p)
    return cur

def main():
    d = sys.argv[1]
    table = '--table' in sys.argv
    rows = load(d)
    if not rows:
        print('no samples'); return
    t0 = rows[0]['t']
    if table:
        hdr = ('sec','phase','boot','fps','maxMs','cCalls','cpf','mTot','mVis','prog','geo','tex','terr','stat','bldg','pvs','heapMB','lt')
        print(('{:>5} {:>6} {:>9} {:>6} {:>7} {:>7} {:>5} {:>5} {:>5} {:>4} {:>4} {:>4} {:>4} {:>5} {:>4} {:>4} {:>7} {:>5}').format(*hdr))
        prev = None
        for s in rows:
            sec = round((s['t']-t0)/1000)
            cc = g(s,'ri','cumCalls')
            fn = g(s,'frame','n')
            cpf = None
            if prev is not None and cc is not None and g(prev,'ri','cumCalls') is not None and fn:
                dc = cc - g(prev,'ri','cumCalls')
                if dc >= 0: cpf = round(dc/fn)
            prev = s
            print(('{:>5} {:>6} {:>9} {:>6} {:>7} {:>7} {:>5} {:>5} {:>5} {:>4} {:>4} {:>4} {:>4} {:>5} {:>4} {:>4} {:>7} {:>5}').format(
                sec, str(s.get('phase','')), str(s.get('boot')), str(g(s,'frame','fps')), str(g(s,'frame','max')),
                str(cc), str(cpf), str(g(s,'mesh','total')), str(g(s,'mesh','visChain')),
                str(g(s,'ri','programs')), str(g(s,'ri','geometries')), str(g(s,'ri','textures')),
                str(g(s,'bakes','terrain')), str(g(s,'bakes','statics')), str(g(s,'bakes','buildings')),
                str(s.get('pvsVis')), str(s.get('heapMB')), str(s.get('ltCount'))))
        print()

    def summ(name, get):
        vals = [get(s) for s in rows if get(s) is not None]
        if not vals:
            return f"{name:>16}: (none)"
        return f"{name:>16}: first={vals[0]}  last={vals[-1]}  min={min(vals)}  max={max(vals)}"
    print(f"samples={len(rows)}  span={round((rows[-1]['t']-t0)/1000)}s  phases={sorted(set(str(s.get('phase')) for s in rows))}")
    for name, get in [
        ('cumDrawCalls', lambda s: g(s,'ri','cumCalls')),
        ('meshTotal', lambda s: g(s,'mesh','total')),
        ('meshVisibleChain', lambda s: g(s,'mesh','visChain')),
        ('programs', lambda s: g(s,'ri','programs')),
        ('geometries', lambda s: g(s,'ri','geometries')),
        ('textures', lambda s: g(s,'ri','textures')),
        ('terrainLBs', lambda s: g(s,'bakes','terrain')),
        ('staticsLBs', lambda s: g(s,'bakes','statics')),
        ('buildingLBs', lambda s: g(s,'bakes','buildings')),
        ('pvsVisible', lambda s: s.get('pvsVis')),
        ('heapMB', lambda s: s.get('heapMB')),
        ('ltCount', lambda s: s.get('ltCount')),
    ]:
        print(summ(name, get))

    # per-phase fps + per-frame draw calls
    for ph in ['settle', 'walk']:
        pr = [s for s in rows if s.get('phase') == ph]
        if not pr:
            continue
        fps = [g(s,'frame','fps') for s in pr if g(s,'frame','fps') is not None]
        mx = [g(s,'frame','max') for s in pr if g(s,'frame','max') is not None]
        cpf = []
        for i in range(1, len(pr)):
            a, b = g(pr[i-1],'ri','cumCalls'), g(pr[i],'ri','cumCalls')
            fn = g(pr[i],'frame','n')
            if a is not None and b is not None and fn and b-a >= 0:
                cpf.append((b-a)/fn)
        line = f"  {ph}: intervals={len(pr)}"
        if fps: line += f" meanFps={round(sum(fps)/len(fps),2)} minFps={min(fps)} worstFrameMs={max(mx) if mx else None}"
        if cpf: line += f" callsPerFrame(mean={round(sum(cpf)/len(cpf))},min={round(min(cpf))},max={round(max(cpf))})"
        print(line)

    # pose movement
    poses = [s['pose'] for s in rows if s.get('pose')]
    if poses:
        lbs = [p.get('lb') for p in poses if p.get('lb') is not None]
        print(f"  pose: start_lb={hex(lbs[0]) if lbs else None} end_lb={hex(lbs[-1]) if lbs else None} distinctLBs={len(set(lbs))}")

if __name__ == '__main__':
    main()
