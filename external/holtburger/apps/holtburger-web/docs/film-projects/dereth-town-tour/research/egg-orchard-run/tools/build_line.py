#!/usr/bin/env python3
"""build_line.py - the Egg Orchard FPV racing line (base line, before creature passes are baked in).

Pipeline:
  1. Gates: the 163 route doors (data/src/eo_fpv_route.json, cell route 0x002B0371 -> 0x002B0100) give one point
     each: tunnel doors at bottom + 1.85 m (3.75 m doors) / + 1.5 m (3.0 m trench doors), room doors at bottom +
     min(3, h/2).
  2. Features: door ranges are REPLACED by authored waypoints (FEATURES below: entry hall + burrow dive, -12 burrow
     pop-up + floor chute, the pit, the -54 burrow pop-up + ramp-hall swoop, the -60 dive / pop-up / dive, the egg
     chamber reveal, the exit portal). Every authored point is a soft attractor; only the start and the end are pinned.
     Extra 'via' points force the vent-column detour in X-junction 0x163.
  3. Elastic band: Laplacian (shortening = racing line) + bi-Laplacian (curvature spreading) smoothing, then
     projection: wall clearance (tunnel 1.3 m / room 1.6 m targets; verify floors are 0.9 / 1.2), prop clearance
     1.1 m (verify 0.6), the tunnel height band floor + [1.5, 2.6] m (only where the cell is a closed tunnel, i.e.
     ceiling - floor < 4.6 m), and a guard that rejects any move leaving every cell (no line inside rock).
  4. Resample at 0.5 m; write data/racing_line.base.json (points, s, cells, regions, floor/ceiling, segment
     ranges, feature anchors).

  python3 tools/build_line.py [--iters=160] [--out=data/racing_line.base.json]
"""
import argparse, json, math, os, sys, time
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import eogeo as G

ROOT = G.ROOT
START = (458.535, 8083.797, 0.005 + 2.75)   # the drop xy; 0.75 m above the drawn 2 m marker 0x02000C39 standing on it
END = (9.704, 8143.2, -58.65)               # 0.5 m past the 'Surface' disc plane (y 8142.688), disc centre height

# Authored waypoints. doors=(i0, i1): door indices (eo_fpv_route.json 'doors', inclusive) replaced by `pts`.
# Each point: (x, y, z, tag) ; tag names a feature anchor used for zones/tricks ('' = none).
FEATURES = [
    {'id': 'A-entry', 'doors': (0, 3), 'pts': [
        (460.6, 8086.4, 2.65, 'A.lift'),
        (463.4, 8089.6, 2.55, ''),
        (466.4, 8093.0, 2.45, 'A.float'),        # open air between the mushroom caps (AC1 east edge x 465, AC5 north edge y 8090.3)
        (468.8, 8096.4, 1.95, 'A.dive'),         # into the groove cut through the mound (x 467.2-471.8)
        (469.6, 8099.4, 1.6, ''),
        (469.8, 8101.2, 1.5, 'A.tunnel'),        # trench -> tunnel 0x374 mouth (3.0 m tall)
    ]},
    {'id': 'D-popup-E-chute', 'doors': (41, 46), 'pts': [
        (360.0, 8140.6, -10.2, ''),
        (360.0, 8138.2, -9.8, 'D.popup'),       # rise out of the groove in mound room 0x2C9
        (359.6, 8134.8, -7.9, ''),               # over Slasher 0x2C9 (359.1, 8134.1)
        (357.5, 8131.3, -6.7, 'D.top'),          # -12 hall (ceiling -3)
        (355.0, 8128.2, -7.6, 'E.cut'),          # cut throttle over the floor hole
        (352.7, 8126.0, -9.8, 'E.hole'),
        (350.6, 8125.6, -12.0, 'E.lip'),         # through the 6.4 x 5.9 m hole
        (348.3, 8125.7, -14.0, ''),              # under the chute roof lip (x 348.1, z -12)
        (346.0, 8125.9, -15.6, ''),
        (345.0, 8126.0, -16.45, 'E.exit'),       # chute -> tunnel 0x2AD (3.1 m mouth)
    ]},
    {'id': 'H-pit', 'doors': (98, 102), 'pts': [
        (199.5, 8155.8, -33.4, 'H.approach'),
        (195.6, 8156.0, -33.4, 'H.edge'),        # over the edge (pit column x 184.5-194.5, y 8150-8160, lid -30)
        (193.0, 8156.3, -33.9, ''),
        (191.2, 8156.8, -35.6, 'H.nose'),
        (190.4, 8157.0, -38.5, ''),
        (190.1, 8157.0, -42.0, ''),
        (190.0, 8156.6, -45.5, 'H.bottom'),
        (190.0, 8155.2, -48.4, ''),
        (190.0, 8153.2, -50.3, 'H.pullout'),     # between / over the two pit-bottom Rippers
        (190.0, 8150.8, -51.2, ''),
        (190.0, 8147.0, -51.7, ''),
    ]},
    {'id': 'J-popup-ramp', 'doors': (141, 144), 'pts': [
        (95.0, 8116.0, -52.3, ''),
        (92.5, 8116.0, -51.9, 'J.popup'),        # out of trench 0x152
        (89.6, 8116.0, -50.2, ''),               # over Ripper 0x153 (88.5, 8116.1)
        (86.0, 8116.0, -49.6, 'J.top'),
        (82.0, 8116.5, -51.0, 'J.swoop'),        # down the 31 deg ramp hall 0x150 (ceiling -45)
        (78.0, 8117.6, -53.6, ''),
        (74.0, 8118.3, -56.6, ''),
    ]},
    {'id': 'K1-dive', 'doors': (145, 147), 'pts': [
        (71.5, 8119.5, -56.0, ''),
        (70.3, 8123.0, -55.4, 'K.over12F'),      # over Ripper 0x12F (70.7, 8121.0)
        (70.0, 8126.5, -56.2, 'K.dive1'),
        (70.0, 8129.3, -58.0, ''),
        (70.0, 8131.0, -58.5, ''),               # trench 0x130 -> tunnel 0x12E (3.0 m)
    ]},
    {'id': 'K2-popup-K3-dive', 'doors': (151, 155), 'pts': [
        (60.0, 8141.2, -58.2, ''),
        (60.0, 8143.4, -57.2, 'K.popup2'),       # out of trench 0x122 into room 0x121
        (59.2, 8145.4, -55.6, ''),
        (56.5, 8146.4, -54.6, 'K.hop'),
        (52.5, 8146.2, -55.0, ''),
        (49.0, 8146.0, -56.6, 'K.dive3'),        # dive into trench 0x11B
        (46.7, 8146.0, -58.0, ''),
        (45.0, 8146.0, -58.5, ''),               # trench -> tunnel 0x111 (3.0 m)
    ]},
    {'id': 'K-egg-chamber', 'doors': (157, 159), 'pts': [
        (31.0, 8142.2, -58.0, ''),
        (30.0, 8138.8, -56.6, 'K.egg.enter'),
        (28.6, 8135.2, -54.6, 'K.egg.rise'),
        (26.5, 8131.0, -53.5, 'K.egg.float'),
        (22.5, 8127.5, -53.5, 'K.egg.hive'),     # over the toxic hive (20.0, 8126.0)
        (19.0, 8127.8, -54.0, ''),
        (17.6, 8131.0, -55.3, 'K.egg.carve'),
        (17.8, 8134.3, -56.9, ''),
        (16.4, 8135.9, -57.9, ''),
        (15.0, 8136.0, -58.2, 'K.egg.exit'),     # west door 0x105 -> 0x102 (3.75 m)
    ]},
    {'id': 'K-portal', 'doors': (160, 162), 'pts': [
        (13.0, 8136.1, -58.3, 'K.corner'),       # exit-corner Ripper 0x101 (12.9, 8136.2)
        (10.8, 8137.9, -58.4, ''),
        (10.0, 8140.2, -58.55, 'K.portal'),
    ]},
]
# Soft 'via' points inserted after a door (keeps the line round the 2.4 x 3.0 m vent column in X-junction 0x163).
# The 'column' is a floor base (z -54..-52.6) + a ceiling flare (-51.5..-50.25) with green gas between: solid only
# near the floor and ceiling, but the gas jet and the flares sit on the tunnel centreline, so the line goes round.
VIAS = [{'after_door': None, 'near': (130.0, 8116.4), 'weight': 0.6, 'pts': [(130.2, 8118.5, -52.15, 'I.column')]}]

# Segment ends (research segments A-K) as door indices: A ends at door 3 ... J ends at door 144.
SEGMENT_END_DOOR = {'A': 3, 'B': 17, 'C': 41, 'D': 45, 'E': 46, 'F': 92, 'G': 98, 'H': 102, 'I': 141, 'J': 144}

CFG = dict(spacing=0.5, wall_tunnel=1.3, wall_room=1.6, prop=1.1, band=(1.5, 2.6), tunnel_open=4.6,
           k_lap=0.3, k_bil=0.5, k_att=0.25, att_sigma=2.2, push=0.8)


def load_route():
    return json.load(open(os.path.join(G.SRC, 'eo_fpv_route.json')))


def gate(door):
    at = list(door['at'])
    h = float(door['height']); b = float(door['bottom'])
    kind = door['kind']
    if kind.startswith('wall opening'):
        if h <= 3.2:
            at[2] = b + h / 2.0
        elif h <= 4.0:
            at[2] = b + 1.85
        else:
            at[2] = b + min(3.0, h / 2.0)
    return tuple(at)


def initial_polyline(route):
    doors = route['doors']
    # where does each segment-end door sit (to find the s of segment boundaries later)
    replaced = {}
    for f in FEATURES:
        for i in range(f['doors'][0], f['doors'][1] + 1):
            replaced[i] = f
    pts, tags = [START], ['start']
    done = set()
    door_pt_index = {}
    for i, d in enumerate(doors):
        f = replaced.get(i)
        if f is not None:
            if f['id'] not in done:
                done.add(f['id'])
                for (x, y, z, tag) in f['pts']:
                    pts.append((x, y, z)); tags.append(tag or ('feat:' + f['id']))
            door_pt_index[i] = len(pts) - 1
            continue
        pts.append(gate(d)); tags.append('gate:%d' % i)
        door_pt_index[i] = len(pts) - 1
        for v in VIAS:
            if v['after_door'] is None:
                # insert after the door whose gate is closest (from before) to the via
                pass
    pts.append(END); tags.append('end')
    # vias: insert at the best position (between consecutive points minimising detour)
    for v in VIAS:
        for (x, y, z, tag) in v['pts']:
            P = np.array(pts); q = np.array((x, y, z))
            best, bi = 1e18, None
            for k in range(len(P) - 1):
                c = np.linalg.norm(P[k] - q) + np.linalg.norm(q - P[k + 1]) - np.linalg.norm(P[k + 1] - P[k])
                if c < best:
                    best, bi = c, k
            pts.insert(bi + 1, (x, y, z)); tags.insert(bi + 1, tag)
            for kk, vv in list(door_pt_index.items()):
                if vv > bi:
                    door_pt_index[kk] = vv + 1
    return np.array(pts, float), tags, door_pt_index


def resample(P, spacing, keep=()):
    """Uniform arc-length resampling between consecutive kept indices (kept points stay exact)."""
    keep = sorted(set([0, len(P) - 1]) | set(keep))
    out = [P[0]]; newkeep = [0]
    for a, b in zip(keep, keep[1:]):
        seg = P[a:b + 1]
        d = np.r_[0, np.cumsum(np.linalg.norm(np.diff(seg, axis=0), axis=1))]
        L = d[-1]
        n = max(1, int(round(L / spacing)))
        ts = np.linspace(0, L, n + 1)[1:]
        for t in ts:
            out.append(np.array([np.interp(t, d, seg[:, k]) for k in range(3)]))
        newkeep.append(len(out) - 1)
    return np.array(out), newkeep


def arclen(P):
    return np.r_[0, np.cumsum(np.linalg.norm(np.diff(P, axis=0), axis=1))]


class Relaxer:
    def __init__(self, D, cfg):
        self.D, self.cfg = D, cfg
        self.cell_cache = {}

    def cell(self, p, prefer=None):
        return self.D.point_cell(p, prefer)

    def project(self, q, prev_cell, wall_target=None):
        D, cfg = self.D, self.cfg
        cid = self.cell(q, prev_cell)
        if cid is None:
            return None, None
        region = D.region_of(cid)
        target = cfg['wall_tunnel'] if region == 'tunnel' else cfg['wall_room']
        if wall_target is not None and np.isfinite(wall_target):
            target = min(target, float(wall_target) + (0.0 if region == 'tunnel' else 0.3))
        for _ in range(2):
            d, cp, cls, _o = D.wall(q)
            if cp is not None and d < target and d > 1e-6:
                q = q + (q - cp) / d * (target - d) * cfg['push']
            dp, prop = D.prop(q)
            if prop is not None and dp < cfg['prop']:
                # push away from the nearest prop triangle
                idx = D.phash.near(q, 1)
                cpp = G.closest_on_tris(q, D.PA[idx], D.PB[idx], D.PC[idx])
                dd = np.linalg.norm(cpp - q, axis=1); k = int(np.argmin(dd))
                if dd[k] > 1e-6:
                    q = q + (q - cpp[k]) / dd[k] * (cfg['prop'] - dd[k]) * cfg['push']
        if region == 'tunnel':
            fz, cz = D.floor_ceil(q)
            if fz is not None and cz is not None and (cz - fz) < cfg['tunnel_open']:
                lo, hi = fz + cfg['band'][0], min(fz + cfg['band'][1], cz - cfg['wall_tunnel'])
                if wall_target is not None and np.isfinite(wall_target):
                    # inside a creature-pass window: the band top follows the ceiling rule (over passes)
                    hi = cz - target
                if hi < lo:
                    hi = lo = (fz + cz) / 2
                q = q.copy(); q[2] = min(max(q[2], lo), hi)
        cid2 = self.cell(q, cid)
        if cid2 is None:
            return None, None
        return q, cid2

    def run(self, P, pinned, attractors, iters, log=True, constraints=None):
        """constraints: optional object with .apply(Pn) -> per-point wall-target overrides (array, nan = none);
        it moves points to satisfy its own rules (creature passes) before the wall/prop projection."""
        cfg = self.cfg
        cells = [self.cell(p) for p in P]
        t0 = time.time()
        for it in range(iters):
            n = len(P)
            dP = np.zeros_like(P)
            lap = P[:-2] + P[2:] - 2 * P[1:-1]
            dP[1:-1] += cfg['k_lap'] * lap / 2
            bil = P[:-4] - 4 * P[1:-3] + 6 * P[2:-2] - 4 * P[3:-1] + P[4:]
            dP[2:-2] -= cfg['k_bil'] * bil / 16
            # attractors: gaussian falloff around the nearest point
            for (q, w) in attractors:
                k = int(np.argmin(np.linalg.norm(P - q, axis=1)))
                for j in range(max(1, k - 6), min(n - 1, k + 7)):
                    wj = w * math.exp(-0.5 * ((j - k) * cfg['spacing'] / cfg['att_sigma']) ** 2)
                    dP[j] += cfg['k_att'] * wj * (q - P[j])
            dP[list(pinned)] = 0
            Pn = P + dP
            wt = constraints.apply(Pn) if constraints is not None else None
            moved = 0; rejected = 0
            for i in range(n):
                if i in pinned:
                    continue
                q, cid = self.project(Pn[i], cells[i], None if wt is None else wt[i])
                if q is None:
                    Pn[i] = P[i]; rejected += 1
                    continue
                Pn[i] = q; cells[i] = cid
            P = Pn
            if (it + 1) % 10 == 0 or it == iters - 1:
                keep = sorted(pinned)
                P, newkeep = resample(P, cfg['spacing'], keep)
                pinned = set(newkeep)
                cells = [self.cell(p) for p in P]
                if log:
                    print(f'  iter {it + 1}: n={len(P)} len={arclen(P)[-1]:.1f} rejected={rejected} '
                          f'outside={sum(c is None for c in cells)} ({time.time() - t0:.0f}s)', file=sys.stderr)
        return P, pinned


def annotate(D, P, route, door_pt_index_s):
    s = arclen(P)
    cells, regions, floors, ceils = [], [], [], []
    prev = None
    for p in P:
        cid = D.point_cell(p, prev); prev = cid or prev
        cells.append(cid); regions.append(D.region_of(cid) if cid else 'outside')
        fz, cz = D.floor_ceil(p); floors.append(fz); ceils.append(cz)
    return s, cells, regions, floors, ceils


def door_s(P, s, door):
    """s where the line passes closest to a door centre (search the whole line)."""
    at = np.array(door['at'])
    k = int(np.argmin(np.linalg.norm(P - at, axis=1)))
    return float(s[k]), k


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--iters', type=int, default=220)
    ap.add_argument('--out', default=os.path.join(ROOT, 'data', 'racing_line.base.json'))
    a = ap.parse_args(argv)
    D = G.Dungeon()
    route = load_route()
    P0, tags, door_pt_index = initial_polyline(route)
    attractors = []
    via_w = {t: v.get('weight', 1.0) for v in VIAS for (_x, _y, _z, t) in v['pts']}
    for p, t in zip(P0, tags):
        if not t.startswith('gate:') and t not in ('start', 'end'):
            attractors.append((p.copy(), via_w.get(t, 1.0)))
    P, keep = resample(P0, CFG['spacing'])
    pinned = {0, len(P) - 1}
    print(f'initial: {len(P0)} control points, {len(P)} samples, length {arclen(P)[-1]:.1f} m', file=sys.stderr)
    R = Relaxer(D, CFG)
    P, pinned = R.run(P, pinned, attractors, a.iters)
    s, cells, regions, floors, ceils = annotate(D, P, route, None)
    # feature anchors: nearest line point to each tagged authored point
    anchors = {}
    for p, t in zip(P0, tags):
        if t and not t.startswith('gate:') and not t.startswith('feat:'):
            k = int(np.argmin(np.linalg.norm(P - p, axis=1)))
            anchors[t] = {'s': round(float(s[k]), 2), 'i': k, 'authored': [round(float(x), 3) for x in p],
                          'line': [round(float(x), 3) for x in P[k]], 'offset': round(float(np.linalg.norm(P[k] - p)), 2)}
    # segment ranges
    segs = []
    prev_s = 0.0
    for sid in 'ABCDEFGHIJK':
        if sid in SEGMENT_END_DOOR:
            e, _ = door_s(P, s, route['doors'][SEGMENT_END_DOOR[sid]])
        else:
            e = float(s[-1])
        name = next((x['name'] for x in route['segments'] if x['seg'] == sid), sid)
        segs.append({'id': sid, 'name': name, 's0': round(prev_s, 2), 's1': round(e, 2)})
        prev_s = e
    out = {
        'about': 'Egg Orchard (LB 0x002B) FPV racing line, BASE (no creature passes). World metres: x east, y north, z up; '
                 'landblock-local = world - (0, 8256, 0). Built by tools/build_line.py from the DAT cell geometry.',
        'frame': 'world', 'spacing': CFG['spacing'], 'cfg': CFG,
        'start': list(START), 'end': list(END),
        'length': round(float(s[-1]), 2),
        'points': [[round(float(x), 3) for x in p] for p in P],
        's': [round(float(x), 3) for x in s],
        'cells': ['0x%08X' % (0x002B0000 | c) if c else None for c in cells],
        'regions': regions,
        'floor': [None if f is None else round(f, 3) for f in floors],
        'ceil': [None if c is None else round(c, 3) for c in ceils],
        'segments': segs,
        'anchors': anchors,
    }
    json.dump(out, open(a.out, 'w'))
    print(f'wrote {a.out}: length {s[-1]:.1f} m, {len(P)} points, outside={sum(c is None for c in cells)}', file=sys.stderr)


if __name__ == '__main__':
    main()
