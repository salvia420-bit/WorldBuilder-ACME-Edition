#!/usr/bin/env python3
"""site.py - the egg-orchard-run site: a bottom stand point for the hidden avatar + PVS prime hops.

ACE sends a dungeon creature to a client only while it stands in a cell of the avatar's cell PVS
(ObjectMaint.GetVisibleObjects(EnvCell) -> cell.VisibleCells). The film camera flies far from the parked avatar,
so `site.prime` walks the hidden avatar down the dungeon first (DESIGN 1), then it stands at the site teleport.

  python3 tools/site.py [--line=data/racing_line.json] [--out=site.json]

  prime  : research-2's 7 PVS anchors, top -> bottom; each hop = the cell's floor centre (+0.005 m), validated:
           inside its cell (retail BSP), >= 6 m from both Surface portals, >= 0.6 m from walls at knee/chest height,
           not inside a prop or a creature cylinder (+0.5 m).
  stand  : the bottom-level cell (floor <= -54) whose PVS covers the most creatures near the last segments (J, K),
           >= 10 m from both Surface portals and >= 4 m from the racing line, with the same validation.
  coverage: creatures within 15 m of the line, how many each hop / the union / the stand cell sees.
"""
import argparse, json, math, os, sys
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import eogeo as G

ROOT = G.ROOT
ANCHORS = ['0x002B035D', '0x002B02D2', '0x002B028E', '0x002B020A', '0x002B01D8', '0x002B0163', '0x002B0121']


def visible_cells():
    out = {}
    for line in open(os.path.join(G.SRC, 'eo_parse_all.jsonl')):
        d = json.loads(line)
        if d.get('typeName') == 'EnvCell':
            out[d['id'] & 0xFFFF] = set(d['fields'].get('visibleCells') or []) | {d['id'] & 0xFFFF}
    return out


def stand_point(D, cid, xy=None):
    c = D.cells[cid]
    lo, hi = c.bbox
    cands = []
    if xy is not None:
        cands.append(np.array(xy, float))
    ctr = (lo[:2] + hi[:2]) / 2
    cands.append(ctr)
    for dx in (-2, 0, 2):
        for dy in (-2, 0, 2):
            cands.append(ctr + np.array([dx, dy]))
    for q in cands:
        fz, cz = D.floor_ceil(np.array([q[0], q[1], c.floorZ + 1.0]))
        if fz is None:
            continue
        p = np.array([q[0], q[1], fz + 0.005])
        if D.point_cell(p + np.array([0, 0, 0.3])) != cid:
            continue
        ok, why = validate(D, p)
        if ok:
            return p
    return None


def validate(D, p, portal_min=6.0):
    for sp in D.surface_portals:
        if np.linalg.norm(sp['pos'] - p) < portal_min:
            return False, 'near a Surface portal'
    for h in (0.5, 1.2):
        q = p + np.array([0, 0, h])
        bc = D.wall_by_class(q)
        if bc['wall'] < 0.6:
            return False, f'wall {bc["wall"]:.2f} m at +{h} m'
        dp, prop = D.prop(q)
        if prop is not None and dp < 0.5:
            return False, f'prop {prop["kind"]} {dp:.2f} m'
        for c, cyl, box in D.creature_clearance(q, 5.0):
            if cyl < 0.5:
                return False, f'creature {c["name"]} {cyl:.2f} m'
    return True, 'ok'


def local_cmd(cid, p, q=(1, 0, 0, 0)):
    return '@teleloc 0x%08X %.3f %.3f %.3f %g %g %g %g' % (0x002B0000 | cid, p[0], p[1] - 8256.0, p[2], *q)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--line', default=os.path.join(ROOT, 'data', 'racing_line.json'))
    ap.add_argument('--out', default=os.path.join(ROOT, 'site.json'))
    a = ap.parse_args(argv)
    D = G.Dungeon()
    vis = visible_cells()
    line = json.load(open(a.line))
    P = np.array(line['points']); s = np.array(line['s'])
    segs = {g['id']: g for g in line['segments']}
    # creatures within 15 m of the line (axis distance), with their s
    near = []
    for c in D.creatures:
        base = c['pos']; zc = np.clip(P[:, 2], base[2], base[2] + c['top'])
        d = np.linalg.norm(P - np.c_[np.full(len(P), base[0]), np.full(len(P), base[1]), zc], axis=1)
        k = int(np.argmin(d))
        if d[k] <= 15.0:
            near.append({'i': c['i'], 'cell': c['cell'], 'name': c['name'], 's': float(s[k]), 'dist': float(d[k])})
    near.sort(key=lambda r: r['s'])
    hops = []
    covered = set()
    for cell in ANCHORS:
        cid = int(cell, 16) & 0xFFFF
        p = stand_point(D, cid)
        if p is None:
            # e.g. a ramp cell: use the neighbour whose PVS covers the most creatures near the line
            best = None
            for nb in D.cells[cid].neighbors:
                if nb not in D.cells:
                    continue
                q = stand_point(D, nb)
                if q is None:
                    continue
                n_s = sum(1 for n in near if n['cell'] in vis[nb])
                if best is None or n_s > best[0]:
                    best = (n_s, nb, q)
            if best is None:
                raise SystemExit(f'no valid stand point in {cell} or its neighbours')
            _, cid, p = best
            cell = '0x%08X' % (0x002B0000 | cid)
        sees = [n for n in near if n['cell'] in vis[cid]]
        covered |= {n['i'] for n in sees}
        hops.append({'cell': cell, 'world': [round(float(x), 3) for x in p], 'cmd': local_cmd(cid, p),
                     'sees': len(sees), 'seesS': [round(min(n['s'] for n in sees), 1), round(max(n['s'] for n in sees), 1)] if sees else None,
                     'floorToLineM': round(float(np.min(np.linalg.norm(P - p, axis=1))), 2)})
    # the stand point: bottom-level cells
    tail = [n for n in near if n['s'] >= segs['J']['s0']]
    best = None
    for cid, c in D.cells.items():
        if c.floorZ > -53.9:
            continue
        p = stand_point(D, cid)
        if p is None:
            continue
        if min(np.linalg.norm(sp['pos'] - p) for sp in D.surface_portals) < 10.0:
            continue
        dline = float(np.min(np.linalg.norm(P - (p + np.array([0, 0, 1.0])), axis=1)))
        if dline < 4.0:
            continue
        sees = [n for n in tail if n['cell'] in vis[cid]]
        score = (len(sees), -abs(p[0] - 25.0) - abs(p[1] - 8131.0))   # tie -> nearest the egg chamber
        if best is None or score > best[0]:
            best = (score, cid, p, sees, dline)
    _, scid, sp, ssees, sdline = best
    out = {
        'id': 'egg-orchard-run', 'name': 'Egg Orchard - FPV run (drop to the exit portal)', 'gazetteerId': 'egg-orchard',
        'teleport': local_cmd(scid, sp), 'anchor': {'cell': '0x%08X' % (0x002B0000 | scid), 'local': [round(sp[0], 3), round(sp[1] - 8256.0, 3), round(sp[2], 3)]},
        'cell': '0x%08X' % (0x002B0000 | scid), 'indoor': True, 'interiorLb': '0x002B0000',
        'prime': [h['cmd'] for h in hops],
        'settleSec': 2, 'ready': {'settleSec': 8, 'timeoutSec': 120}, 'look': {'timeOfDay': 0.48, 'grade': 'cool'},
        'notes': ('Hidden avatar parks at the bottom (cell %s, %.1f m from the nearest Surface portal, %.1f m off the racing line); '
                  'prime walks it through research-2\'s 7 PVS anchors top->bottom so ACE sends the creatures on the route '
                  '(they see %d of the %d creatures within 15 m of the line; the stand cell sees %d of the %d after segment J). '
                  'ACE drops objects ~25 s after they leave the avatar PVS: if the upper levels come up empty in a take, '
                  'shoot the run in legs or hop during the take.') % (
                     '0x%08X' % (0x002B0000 | scid), min(np.linalg.norm(p['pos'] - sp) for p in D.surface_portals), sdline,
                     len(covered), len(near), len(ssees), len(tail)),
        'validation': {'hops': hops, 'stand': {'cell': '0x%08X' % (0x002B0000 | scid), 'world': [round(float(x), 3) for x in sp],
                                                'sees': len(ssees), 'of': len(tail), 'lineDistM': round(sdline, 2),
                                                'portalDistM': [round(float(np.linalg.norm(p['pos'] - sp)), 1) for p in D.surface_portals]},
                       'creaturesNear15m': len(near), 'coveredByPrime': len(covered),
                       'notCovered': [n for n in near if n['i'] not in covered]},
    }
    json.dump(out, open(a.out, 'w'), indent=1)
    print(f"site -> {a.out}: stand {out['cell']} {out['teleport']} sees {len(ssees)}/{len(tail)}; prime covers {len(covered)}/{len(near)}")
    for h in hops:
        print(f"  hop {h['cell']} sees {h['sees']:2d} s {h['seesS']}  {h['cmd']}")


if __name__ == '__main__':
    main()
