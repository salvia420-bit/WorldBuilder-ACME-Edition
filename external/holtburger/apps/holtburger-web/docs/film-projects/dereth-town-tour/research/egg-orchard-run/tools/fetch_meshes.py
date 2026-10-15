#!/usr/bin/env python3
"""fetch_meshes.py - one WorldBuilder.Terminal session that parses every static Setup placed in
landblock 0x002B (plus the creature setups and the portal disc) and the GfxObj parts they use,
then bakes data/meshes.json: per setup id, its triangles in setup-local metres (Default
placement frames applied) and its bounds.

Run (ONE WBT session at a time; check `free -m` >= 2000 MB available first):
    python3 tools/fetch_meshes.py
Inputs : data/src/eo_parse_all.jsonl (the 639 EnvCell / 50 Environment DAT parse)
Outputs: data/src/meshes_raw.jsonl (raw WBT answers), data/meshes.json
"""
import json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, 'data', 'src')
WBT = '/home/wbterminal/WorldBuilder-ACME-Edition/WorldBuilder.Terminal/bin/Release/net8.0/WorldBuilder.Terminal.dll'
PORTAL_DAT = '/home/wbterminal/ac_base_dats/client_portal.dat'
CREATURE_SETUPS = [0x02000A36, 0x02000AAC, 0x02000F3D, 0x020001B3]


def qrot(q, v):
    w, x, y, z = q
    vx, vy, vz = v
    tx = 2 * (y * vz - z * vy); ty = 2 * (z * vx - x * vz); tz = 2 * (x * vy - y * vx)
    return (vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx))


def static_ids():
    ids = set()
    for line in open(os.path.join(SRC, 'eo_parse_all.jsonl')):
        d = json.loads(line)
        if d.get('typeName') != 'EnvCell':
            continue
        for s in d['fields'].get('staticObjects') or []:
            ids.add(s['id'])
    return sorted(ids | set(CREATURE_SETUPS))


class Wbt:
    def __init__(self):
        env = dict(os.environ, DOTNET_ROLL_FORWARD='LatestMajor')
        self.p = subprocess.Popen(['dotnet', WBT, '--stdin'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, text=True, bufsize=1, env=env)
        self.read()  # ready

    def read(self):
        while True:
            line = self.p.stdout.readline()
            if not line:
                raise RuntimeError('WBT closed its stdout')
            line = line.strip()
            if line.startswith('{'):
                return json.loads(line)

    def ask(self, cmd):
        self.p.stdin.write(json.dumps(cmd) + '\n')
        self.p.stdin.flush()
        return self.read()

    def close(self):
        try:
            self.ask({'command': 'quit'})
        except Exception:
            pass
        self.p.wait(timeout=30)


def parse(w, i, type_name):
    return w.ask({'command': 'chorizite-parse-dat-record', 'datPath': PORTAL_DAT, 'idHex': '0x%08X' % i, 'typeName': type_name})


def gfx_tris(f):
    verts = {int(k): v['origin'] for k, v in f['vertexArray']['vertices'].items()}
    out = []
    for poly in (f.get('polygons') or {}).values():
        vid = poly['vertexIds']
        pv = [verts[i] for i in vid]
        for k in range(1, len(pv) - 1):
            out.append([pv[0], pv[k], pv[k + 1]])
    return out


def main():
    ids = static_ids()
    print('setups/gfxobjs to fetch:', len(ids), file=sys.stderr)
    raw = open(os.path.join(SRC, 'meshes_raw.jsonl'), 'w')
    w = Wbt()
    setups, gfx = {}, {}
    try:
        for i in ids:
            if (i >> 24) == 0x01:
                r = parse(w, i, 'GfxObj'); raw.write(json.dumps(r) + '\n')
                if r.get('success'):
                    gfx[i] = r['fields']
                continue
            r = parse(w, i, 'Setup'); raw.write(json.dumps(r) + '\n')
            if r.get('success'):
                setups[i] = r['fields']
        need = set()
        for f in setups.values():
            for p in f.get('parts') or []:
                need.add(p['dataId'])
        for g in sorted(need - set(gfx)):
            r = parse(w, g, 'GfxObj'); raw.write(json.dumps(r) + '\n')
            if r.get('success'):
                gfx[g] = r['fields']
    finally:
        w.close(); raw.close()

    meshes = {}
    for i in ids:
        tris = []
        if i in gfx:
            tris = gfx_tris(gfx[i]); phys = {}
        elif i in setups:
            f = setups[i]
            pf = f.get('placementFrames') or {}
            frames = (pf.get('Default') or (next(iter(pf.values())) if pf else {})).get('frames') or []
            scales = f.get('defaultScale') or []
            for k, part in enumerate(f.get('parts') or []):
                g = gfx.get(part['dataId'])
                if not g:
                    continue
                fr = frames[k] if k < len(frames) else {'origin': [0, 0, 0], 'orientation': [1, 0, 0, 0]}
                sc = scales[k] if k < len(scales) else [1, 1, 1]
                if isinstance(sc, (int, float)):
                    sc = [sc, sc, sc]
                for t in gfx_tris(g):
                    tris.append([[a + b for a, b in zip(qrot(fr['orientation'], [v[0] * sc[0], v[1] * sc[1], v[2] * sc[2]]), fr['origin'])] for v in t])
            phys = {k: f.get(k) for k in ('height', 'radius', 'spheres', 'cylSpheres', 'stepUpHeight')}
        else:
            continue
        if not tris:
            continue
        xs = [v[0] for t in tris for v in t]; ys = [v[1] for t in tris for v in t]; zs = [v[2] for t in tris for v in t]
        meshes['0x%08X' % i] = {'tris': [[[round(c, 4) for c in v] for v in t] for t in tris],
                               'min': [min(xs), min(ys), min(zs)], 'max': [max(xs), max(ys), max(zs)], 'physics': phys}
    json.dump(meshes, open(os.path.join(ROOT, 'data', 'meshes.json'), 'w'))
    for k, m in meshes.items():
        print(k, len(m['tris']), 'tris', 'size', [round(b - a, 2) for a, b in zip(m['min'], m['max'])], file=sys.stderr)


if __name__ == '__main__':
    main()
