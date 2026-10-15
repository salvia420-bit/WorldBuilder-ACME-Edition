#!/usr/bin/env python3
"""passes.py - creature passes for the Egg Orchard racing line.

  python3 tools/passes.py inputs [--line=data/racing_line.base.json] [--out=data/pass_input.json] [--within=6]
      Every spawned creature within `within` m of the line (3-D distance from its axis to the line, with a clear
      line of sight to it) -> one pass-plan input row, in route order:
        gaps.left / gaps.right : free space between the creature's physics radius and the wall on that side, at
                                 the creature's station, BOUNDED BY THE CORRIDOR THE LINE FLIES (a ray is cut where it
                                 leaves the cells the line passes through, so a creature in a side branch or alcove
                                 cannot be passed on its far side). 'left' = the side of the creature the drone flies on, seen in the
                                 direction of travel. Measured at several drone heights; the best height is kept.
        gaps.over              : headroom from the creature's top (max of physics height and mesh top) to the
                                 ceiling (minimum over the footprint); 0 when the creature stands in a cell the
                                 line never enters or more than 4.5 m off the line (flying over it would leave the line).
        needs                  : the VERIFY rules + 0.1 m: side = 0.8 m creature clearance + the region wall rule
                                 (tunnel 0.9 / room 1.2) + 0.1 = 1.8 / 2.1 m; over = the same above the creature top
                                 and below the ceiling. DESIGN 4's defaults (side 1.9 m, over 1.2 + 0.4 m) cannot be
                                 met in the 5.3 m tunnels (a centred Slasher leaves ~1.7 m a side) and its 0.4 m
                                 below the ceiling fails the 0.9 m tunnel verify, so the run passes verify-consistent
                                 needs. Plain DESIGN defaults: drop `needs` from the input.
        nextTurn               : left / right / straight - heading change over the next 15 m
      -> node tools/pass_plan.mjs --input=data/pass_input.json --out=data/passes.code.json --code

  python3 tools/passes.py bake [--line=data/racing_line.base.json] [--passes=data/passes.code.json]
                                [--zones=data/zones.json] [--out=data/racing_line.json] [--iters=70]
      1. raised-cosine bumps (flat top over the creature's footprint, ramps sized from the zone speed so the bump's
         own acceleration stays <= 4 m/s^2 lateral / 3 m/s^2 vertical), each point clipped so it never leaves the
         dungeon cells;
      2. a repair relaxation (bi-Laplacian smoothing only, no shortening, no resampling; tools/build_line.py Relaxer
         projection): inside each creature's station window (base-line arc length) the chosen side is enforced in
         the creature's own frame - side: lateral distance from the axis in [r + 1.0 + 0.1, wall limit
         - 0.1] (DESIGN: radius + 1.0 m) or the middle of the gap when it is tighter; over: above top + 1.2 m (or the
         middle of the headroom) and aligned over the axis - while walls/props/the tunnel band keep their rules
         (the wall target drops to the verify rule + 0.1 m inside pass windows so tight passes fit).
"""
import argparse, json, math, os, sys
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import eogeo as G
import build_line as BL

ROOT = G.ROOT
WALL_RULE = {'tunnel': 0.9, 'room': 1.2}
CREATURE_RULE = 0.8   # verify: >= radius + 0.8 m
NEED_MARGIN = 0.1     # added to the verify sums for the decision's needs
SIDE_CLEAR = 1.0      # preferred creature clearance for a side pass when the gap allows (DESIGN: radius + 1.0 m)
OVER_ABOVE = 1.2      # preferred height above the creature top when the headroom allows (DESIGN)
MARGIN = 0.1          # extra margin used when the gap allows it
OVER_MAX_LAT = 4.5    # flying over a creature further off the line than this is not offered
MAX_SHIFT = {'tunnel': 3.5, 'room': 5.0}   # longest lateral swing a side pass may ask for
LINE_CELLS = {}       # cache: id(points array) -> set of cells the line flies through


def load_line(path):
    d = json.load(open(path))
    return d, np.array(d['points'], float), np.array(d['s'], float)


def horiz_tangent(P, k, span=3):
    a = P[max(0, k - span)]; b = P[min(len(P) - 1, k + span)]
    t = np.array([b[0] - a[0], b[1] - a[1], 0.0])
    n = np.linalg.norm(t)
    if n < 1e-6:
        return None
    return t / n


def ray_hit(D, o, d, maxd=12.0, props=True):
    """Distance along unit direction d from o to the first cell surface (or prop) - maxd when nothing is hit."""
    o = np.asarray(o, float); d = np.asarray(d, float)
    b = o + d * maxd
    best = maxd
    for A, B, C, H in ((D.TA, D.TB, D.TC, D.hash),) + (((D.PA, D.PB, D.PC, D.phash),) if props else ()):
        idx = H.along(o, b)
        if not len(idx):
            continue
        hit = G.seg_tri_hit(o, b, A[idx], B[idx], C[idx])
        for j in idx[hit]:
            e1 = B[j] - A[j]; e2 = C[j] - A[j]
            h = np.cross(b - o, e2); det = e1 @ h
            if abs(det) < 1e-12:
                continue
            s = o - A[j]; q = np.cross(s, e1)
            best = min(best, ((e2 @ q) / det) * maxd)
    return best


def next_turn(P, s, k, ahead=15.0):
    t0 = horiz_tangent(P, k)
    j = min(int(np.searchsorted(s, s[k] + ahead)), len(P) - 1)
    t1 = horiz_tangent(P, j)
    if t0 is None or t1 is None:
        return 'straight'
    ang = math.degrees(math.atan2(t0[0] * t1[1] - t0[1] * t1[0], t0 @ t1))
    return 'left' if ang > 15 else 'right' if ang < -15 else 'straight'


def creature_rows(D, P, s, within=6.0):
    rows = []
    for c in D.creatures:
        base = c['pos']; top = base + np.array([0, 0, c['top']])
        zc = np.clip(P[:, 2], base[2], top[2])
        dist = np.linalg.norm(P - np.c_[np.full(len(P), base[0]), np.full(len(P), base[1]), zc], axis=1)
        k = int(np.argmin(dist))
        if dist[k] > within:
            continue
        mid = base + np.array([0, 0, c['top'] / 2])
        if D.seg_hits(mid, P[k], props=False):
            continue  # behind a wall (another tunnel)
        rows.append((float(s[k]), k, c, float(dist[k])))
    rows.sort(key=lambda r: r[0])
    return rows


def measure(D, P, s, k, c):
    T = horiz_tangent(P, k)
    L = np.array([-T[1], T[0], 0.0])
    base = c['pos']; topz = base[2] + c['top']
    lat = float((base - P[k]) @ L)
    cid = D.point_cell(base + np.array([0, 0, 0.3]))
    region = D.region_of(cid) if cid else D.region_of(D.point_cell(P[k]))
    zl = P[k][2]
    fb, cb = D.floor_ceil(np.array([base[0], base[1], base[2] + 0.3]))
    if region == 'tunnel' and fb is not None:
        heights = [round(fb + h, 3) for h in (1.4, 1.6, 1.8, 2.0, 2.2, 2.4, 2.6)]
    else:
        heights = [round(zl + h, 3) for h in (-0.6, -0.3, 0.0, 0.3, 0.6)]
    if cb is not None:
        heights = [z for z in heights if z <= cb - 0.5] or [round((base[2] + cb) / 2, 3)]
    # creature-based gaps (rays from the creature's axis)
    gl, gr = [], []
    for z in heights:
        # measured at the station only (u = 0); footprint minima over +-0.5 or +-1 m were tried and gave worse lines
        gl.append(min(ray_hit(D, np.array([base[0], base[1], z]) + T * u, L) for u in (0.0,)) - c['r'])
        gr.append(min(ray_hit(D, np.array([base[0], base[1], z]) + T * u, -L) for u in (0.0,)) - c['r'])
    # corridor = the cells the line flies through: a side ray is capped where it leaves them, so a creature
    # standing in a branch or alcove (a cell the line never enters) cannot be passed on its far side
    line_cells = LINE_CELLS.get(id(P))
    if line_cells is None:
        line_cells = set()
        prev = None
        for q in P:
            cq = D.point_cell(q, prev); prev = cq or prev
            if cq:
                line_cells.add(cq)
        LINE_CELLS[id(P)] = line_cells

    # a creature standing in an alcove / branch cell: the side FACING the line may cross its own cell to reach the
    # line's cells; its far side is blocked (the drone would have to leave the line's corridor to get behind it)
    own_ok = cid not in line_cells

    def corridor_cap(o, dvec, dmax, toward_line):
        allowed = line_cells | (({cid} | set(D.cells[cid].neighbors)) if (own_ok and toward_line and cid) else set())
        t = 0.0
        while t < dmax:
            if D.point_cell(o + dvec * t) not in allowed:
                return t
            t += 0.2
        return dmax
    gl = [corridor_cap(np.array([base[0], base[1], z]), L, g + c['r'], lat < 0) - c['r'] for g, z in zip(gl, heights)]
    gr = [corridor_cap(np.array([base[0], base[1], z]), -L, g + c['r'], lat >= 0) - c['r'] for g, z in zip(gr, heights)]
    WL = WR = None
    il, ir = int(np.argmax(gl)), int(np.argmax(gr))
    # detour rule: the lateral shift a side needs from the line (to radius + 1.0 m) must be <= 3.5 m in tunnels,
    # 5 m in rooms; a longer swing is not offered (the gap reads 'blocked', with a note)
    shift = {'left': max(0.0, lat + c['r'] + SIDE_CLEAR), 'right': max(0.0, c['r'] + SIDE_CLEAR - lat)}
    max_shift = MAX_SHIFT.get(region, 5.0)
    side_note = {}
    for side, arr in (('left', gl), ('right', gr)):
        if shift[side] > max_shift:
            side_note[side] = f'needs a {shift[side]:.1f} m swing off the line (> {max_shift} m in a {region})'
            for j in range(len(arr)):
                arr[j] = min(arr[j], -0.01)
    # over: headroom above the top across the footprint (axis + 4 points at radius r)
    hs = []
    for dx, dy in ((0, 0), (1, 0), (-1, 0), (0, 1), (0, -1)):
        o = np.array([base[0] + dx * c['r'], base[1] + dy * c['r'], topz + 0.01])
        hs.append(ray_hit(D, o, np.array([0, 0, 1.0]), 30.0, props=True))
    # ... and above the line itself around the station (an over pass at a tunnel mouth must fit the tunnel too)
    for j in range(max(0, k - 6), min(len(P), k + 7)):
        _fz, cz = D.floor_ceil(P[j])
        if cz is not None:
            hs.append(cz - topz)
    over = min(hs)
    inside = cid in line_cells
    over_note = None
    if not inside:
        over, over_note = 0.0, 'creature outside the corridor the line flies'
    elif abs(lat) > OVER_MAX_LAT:
        over, over_note = 0.0, f'creature {abs(lat):.1f} m off the line (> {OVER_MAX_LAT} m)'
    return {'lat': round(lat, 3), 'region': region, 'heights': heights,
            'gaps': {'over': round(over, 3), 'left': round(gl[il], 3), 'right': round(gr[ir], 3)},
            'bestHeight': {'left': heights[il], 'right': heights[ir]},
            'overNote': over_note, 'sideNotes': side_note, 'shift': {k2: round(v2, 2) for k2, v2 in shift.items()},
            'top': round(float(topz), 3), 'L': L.tolist(), 'T': T.tolist()}


def cmd_inputs(a):
    D = G.Dungeon()
    d, P, s = load_line(a.line)
    out = []
    for s0, k, c, dist in creature_rows(D, P, s, a.within):
        m = measure(D, P, s, k, c)
        wr = WALL_RULE.get(m['region'], 1.2)
        row = {
            'id': f"{c['name'].split()[-1].lower()}-{c['cellHex'][-3:].lower()}-{c['i']}",
            'name': c['name'], 'cell': '0x002B' + c['cellHex'][2:], 's': round(s0, 2), 'k': k, 'distToLine': round(dist, 2),
            'region': m['region'], 'pos': [round(float(x), 3) for x in c['pos']], 'radius': round(c['r'], 3),
            'top': m['top'], 'lateral': m['lat'], 'gaps': m['gaps'], 'bestHeight': m['bestHeight'],
            'needs': {k2: round(CREATURE_RULE + wr + NEED_MARGIN, 2) for k2 in ('left', 'right', 'over')},
            'nextTurn': next_turn(P, s, k),
        }
        if m['overNote']:
            row['overNote'] = m['overNote']
        if m['sideNotes']:
            row['sideNotes'] = m['sideNotes']
        row['shift'] = m['shift']
        out.append(row)
    doc = {'about': 'Egg Orchard pass-plan input (tools/passes.py inputs) for `film jev task pass-plan` / tools/pass_plan.mjs. '
                    'Gaps in metres: left/right = from the creature physics radius to the wall on that side, bounded by the '
                    'corridor the line flies; over = creature top to the ceiling (0 when flying over it would leave the line). '
                    'left/right = the side the drone flies on, seen in the direction of travel. needs = verify rules + 0.1 m.',
           'line': os.path.relpath(a.line, ROOT), 'within': a.within,
           'creatures': out}
    json.dump(doc, open(a.out, 'w'), indent=1)
    print(f'{len(out)} creatures within {a.within} m -> {a.out}', file=sys.stderr)
    for r in out:
        print(f"  s {r['s']:6.1f} {r['name']:15s} {r['cell']} {r['region']:6s} lat {r['lateral']:+.2f} gaps L {r['gaps']['left']:5.2f} R {r['gaps']['right']:5.2f} O {r['gaps']['over']:5.2f} turn {r['nextTurn']}", file=sys.stderr)


def raised(s, s0, H, R):
    """Plateau raised-cosine weight: 1 on [s0-H, s0+H], cosine ramps of length R outside."""
    d = np.abs(s - s0) - H
    w = np.ones_like(s)
    m = d > 0
    w[m] = np.where(d[m] < R, 0.5 * (1 + np.cos(np.pi * d[m] / R)), 0.0)
    return w


def zone_speed(zones, s0, default=8.0):
    for z in zones or []:
        if z['s0'] <= s0 <= z['s1']:
            return float(z['speed'])
    return default


class PassConstraints:
    """Creature-frame pass rules applied inside the relaxation (see the module doc)."""

    def __init__(self, items):
        self.items = items

    def apply(self, Pn):
        n = len(Pn)
        wt = np.full(n, np.nan)
        for c in self.items:
            d = Pn - c['C']
            u = d @ c['T']; lat = d @ c['L']; dz = Pn[:, 2] - c['C'][2]
            near = (np.abs(u) <= c['H'] + 3.0) & (np.abs(lat) <= 8.0) & (dz > -3.0) & (dz < 8.0)
            wt[near] = np.fmin(wt[near], c['wallTarget'])
            win = near & (np.abs(u) <= c['H'])
            for i in np.nonzero(win)[0]:
                if c['side'] in ('left', 'right'):
                    sg = 1.0 if c['side'] == 'left' else -1.0
                    x = lat[i] * sg
                    x2 = min(max(x, c['lo']), c['hi'])
                    Pn[i] = Pn[i] + (x2 - x) * sg * c['L']
                else:
                    if c['align']:
                        Pn[i] = Pn[i] - lat[i] * c['L'] * 0.6
                    Pn[i][2] = min(max(Pn[i][2], c['zlo']), c['zhi'])
        return wt


def cmd_bake(a):
    D = G.Dungeon()
    d, P, s = load_line(a.line)
    plan = json.load(open(a.passes))
    zones = json.load(open(a.zones))['zones'] if a.zones and os.path.exists(a.zones) else []
    n = len(P)
    Lft = np.zeros((n, 3))
    for k in range(n):
        T = horiz_tangent(P, k)
        Lft[k] = [0, 0, 0] if T is None else [-T[1], T[0], 0.0]
    dlat = np.zeros(n); dz = np.zeros(n)
    applied, items = [], []
    for p in sorted(plan['passes'], key=lambda q: q['s']):
        ci = int(p['id'].split('-')[-1])
        cre = next(c for c in D.creatures if c['i'] == ci)
        k = int(np.argmin(np.abs(s - p['s'])))
        m = measure(D, P, s, k, cre)
        region = m['region']; wr = WALL_RULE.get(region, 1.2)
        lat_c = m['lat']; r = cre['r']; gaps = m['gaps']
        side = p['side']
        v = zone_speed(zones, s[k])
        H = max(r + SIDE_CLEAR, 0.9 * cre['sweptR'] + 0.3) + 0.5
        A_lat = 0.0; A_z = 0.0; flag = None
        item = {'C': cre['pos'].copy(), 'T': np.array(m['T']), 'L': np.array(m['L']), 'H': H, 'side': side,
                'wallTarget': wr + 0.1, 's0': float(s[k])}
        if side in ('left', 'right'):
            sg = 1.0 if side == 'left' else -1.0
            gap = gaps[side]
            lo = r + CREATURE_RULE; hi = r + gap - wr
            if hi - lo >= (SIDE_CLEAR - CREATURE_RULE) + 2 * MARGIN:
                lo2, hi2 = r + SIDE_CLEAR + MARGIN, hi - MARGIN
                lo2 = min(lo2, hi2)
            elif hi >= lo:
                lo2 = hi2 = (lo + hi) / 2
            else:
                lo2 = hi2 = (lo + hi) / 2; flag = f'infeasible side gap {gap:.2f} m (verify needs {CREATURE_RULE + wr:.2f})'
            cur = -lat_c * sg
            want = min(max(cur, lo2), hi2)
            A_lat = (want - cur) * sg
            item.update(lo=lo2, hi=hi2, wallTarget=max(0.5, min(wr + 0.1, r + gap - hi2)),
                        zBest=(m['bestHeight'][side] if region == 'tunnel' else None))
        else:
            ceil_above = m['top'] + gaps['over']
            lo = m['top'] + CREATURE_RULE; hi = ceil_above - wr
            if hi - lo >= (OVER_ABOVE - CREATURE_RULE) + 2 * MARGIN:
                lo2, hi2 = m['top'] + OVER_ABOVE + MARGIN, hi - MARGIN
                lo2 = min(lo2, hi2)
            elif hi >= lo:
                lo2 = hi2 = (lo + hi) / 2
            else:
                lo2 = hi2 = (lo + hi) / 2; flag = f'infeasible headroom {gaps["over"]:.2f} m (verify needs {CREATURE_RULE + wr:.2f})'
            zl = P[k][2]
            A_z = min(max(zl, lo2), hi2) - zl
            align = abs(lat_c) <= OVER_MAX_LAT
            A_lat = lat_c if align else 0.0
            item.update(zlo=lo2, zhi=hi2, align=align, wallTarget=max(0.5, min(wr + 0.1, ceil_above - hi2)))
        items.append(item)
        R_lat = min(14.0, max(3.0, math.pi * v * math.sqrt(abs(A_lat) / (2 * 4.0)))) if A_lat else 0.0
        R_z = min(12.0, max(3.0, math.pi * v * math.sqrt(abs(A_z) / (2 * 3.0)))) if A_z else 0.0
        if A_lat:
            w = raised(s, s[k], H, R_lat) * A_lat
            same = (np.sign(dlat) == np.sign(w)) | (dlat == 0)
            dlat = np.where(same, np.where(np.abs(w) > np.abs(dlat), w, dlat), dlat + w)
        if A_z:
            w = raised(s, s[k], H, R_z) * A_z
            dz = np.where(np.abs(w) > np.abs(dz), w, dz)
        applied.append({'id': p['id'], 'name': p['name'], 'cell': p.get('cell'), 'sBase': round(float(s[k]), 2), 'side': side,
                        'source': p.get('source'), 'region': region, 'lateralOfCreature': round(lat_c, 2),
                        'bumpLat': round(A_lat, 3), 'bumpZ': round(A_z, 3), 'plateauHalf': round(H, 2),
                        'rampLat': round(R_lat, 2), 'rampZ': round(R_z, 2), 'zoneSpeed': v, 'gaps': gaps,
                        'target': ({'lateralFromAxis': [round(item['lo'], 2), round(item['hi'], 2)]} if side != 'over'
                                   else {'z': [round(item['zlo'], 2), round(item['zhi'], 2)], 'alignOver': item['align']}),
                        **({'flag': flag} if flag else {})})
    # 1) raised-cosine bumps, clipped so no point leaves the cells
    Q = P.copy()
    for i in range(n):
        disp = Lft[i] * dlat[i] + np.array([0, 0, dz[i]])
        if not disp.any():
            continue
        for f in (1.0, 0.75, 0.5, 0.25):
            q = P[i] + disp * f
            if D.point_cell(q) is not None:
                Q[i] = q
                break
    # 2) repair: bi-Laplacian smoothing + the pass rules in index windows (stations on the base line) + the wall /
    #    prop / tunnel-band / inside-the-cells projection; no resampling, no shortening, no attractors
    R = BL.Relaxer(D, BL.CFG)
    for it in items:
        it['win'] = np.nonzero(np.abs(s - it['s0']) <= it['H'])[0]
        it['near'] = np.nonzero(np.abs(s - it['s0']) <= it['H'] + 4.0)[0]
    cells = [D.point_cell(q) for q in Q]
    for itn in range(a.iters):
        bil = Q[:-4] - 4 * Q[1:-3] + 6 * Q[2:-2] - 4 * Q[3:-1] + Q[4:]
        Qn = Q.copy()
        Qn[2:-2] -= 0.5 * bil / 16
        Qn[0] = P[0]; Qn[-1] = P[-1]
        wt = np.full(n, np.nan)
        for it in items:
            wt[it['near']] = np.fmin(wt[it['near']], it['wallTarget'])
            for i in it['win']:
                d3 = Qn[i] - it['C']
                lat = d3 @ it['L']
                if it['side'] in ('left', 'right'):
                    sg = 1.0 if it['side'] == 'left' else -1.0
                    x = lat * sg
                    x2 = min(max(x, it['lo']), it['hi'])
                    Qn[i] = Qn[i] + (x2 - x) * sg * it['L']
                    if it.get('zBest') is not None:
                        Qn[i][2] += 0.5 * (it['zBest'] - Qn[i][2])
                else:
                    if it['align']:
                        Qn[i] = Qn[i] - lat * it['L'] * 0.5
                    Qn[i][2] = min(max(Qn[i][2], it['zlo']), it['zhi'])
        rejected = 0
        for i in range(1, n - 1):
            q, cid = R.project(Qn[i], cells[i], wt[i])
            if q is None:
                Qn[i] = Q[i]; rejected += 1
            else:
                Qn[i] = q; cells[i] = cid
        Q = Qn
        if (itn + 1) % 10 == 0:
            print(f'  repair {itn + 1}: rejected {rejected}', file=sys.stderr)
    s2 = BL.arclen(Q)
    out = dict(d)
    out['about'] = d['about'].replace('BASE (no creature passes)', 'with the creature passes baked in')
    out['points'] = [[round(float(x), 3) for x in p] for p in Q]
    out['s'] = [round(float(x), 3) for x in s2]
    out['length'] = round(float(s2[-1]), 2)
    prev = None; cells = []; regions = []; floors = []; ceils = []
    for p in Q:
        cid = D.point_cell(p, prev); prev = cid or prev
        cells.append('0x%08X' % (0x002B0000 | cid) if cid else None); regions.append(D.region_of(cid) if cid else 'outside')
        fz, cz = D.floor_ceil(p); floors.append(None if fz is None else round(fz, 3)); ceils.append(None if cz is None else round(cz, 3))
    out['cells'], out['regions'], out['floor'], out['ceil'] = cells, regions, floors, ceils

    def s_of(pt):
        return round(float(s2[int(np.argmin(np.linalg.norm(Q - np.asarray(pt), axis=1)))]), 2)
    for seg in out['segments']:
        seg['s0'] = 0.0 if seg['s0'] == 0 else s_of(P[int(np.argmin(np.abs(s - seg['s0'])))])
        seg['s1'] = s_of(P[min(n - 1, int(np.argmin(np.abs(s - seg['s1']))))])
    out['segments'][-1]['s1'] = round(float(s2[-1]), 2)
    for v in out['anchors'].values():
        k2 = int(np.argmin(np.linalg.norm(Q - np.asarray(v['line']), axis=1)))
        v['i'] = k2; v['s'] = round(float(s2[k2]), 2); v['line'] = [round(float(x), 3) for x in Q[k2]]
    for x, it in zip(applied, items):
        k2 = int(np.argmin(np.linalg.norm(Q[:, :2] - it['C'][:2], axis=1) + 3.0 * np.abs(Q[:, 2] - it['C'][2] - 1.0)))
        x['s'] = round(float(s2[k2]), 2)
    out['passes'] = applied
    out['passesSource'] = {'file': os.path.relpath(a.passes, ROOT), 'source': plan.get('source'), 'counts': plan.get('counts')}
    json.dump(out, open(a.out, 'w'))
    print(f"baked {len(applied)} passes -> {a.out} (length {s2[-1]:.1f} m)", file=sys.stderr)
    for x in applied:
        print(f"  s {x['s']:6.1f} {x['name']:15s} {x['side']:5s} lat_c {x['lateralOfCreature']:+.2f} bump lat {x['bumpLat']:+.2f} z {x['bumpZ']:+.2f} {x.get('flag', '')}", file=sys.stderr)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', choices=['inputs', 'bake'])
    ap.add_argument('--line', default=os.path.join(ROOT, 'data', 'racing_line.base.json'))
    ap.add_argument('--out')
    ap.add_argument('--within', type=float, default=6.0)
    ap.add_argument('--passes', default=os.path.join(ROOT, 'data', 'passes.code.json'))
    ap.add_argument('--zones', default=os.path.join(ROOT, 'data', 'zones.json'))
    ap.add_argument('--iters', type=int, default=40)
    a = ap.parse_args(argv)
    if a.cmd == 'inputs':
        a.out = a.out or os.path.join(ROOT, 'data', 'pass_input.json')
        cmd_inputs(a)
    else:
        a.out = a.out or os.path.join(ROOT, 'data', 'racing_line.json')
        cmd_bake(a)


if __name__ == '__main__':
    main()
