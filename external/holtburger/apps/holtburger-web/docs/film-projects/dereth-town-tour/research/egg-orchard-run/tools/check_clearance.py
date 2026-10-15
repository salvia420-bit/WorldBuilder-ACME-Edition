#!/usr/bin/env python3
"""check_clearance.py - clearance checker for a sampled trajectory through the Egg Orchard (LB 0x002B).

Input : a JSON trajectory - [{t, pos:[x,y,z]}], {samples|rows|traj|table: [...]}, rows {t,x,y,z}, a racing line
        {points, s} (data/racing_line.json) or [[x,y,z], ...]. World metres (landblock-local + (0, 8256, 0)).
Output: a JSON report (--out) + a text summary on stdout:
  per sample : i, t, s, pos, cell, region (tunnel|room|outside), wall (nearest cell surface, any class),
               byClass {floor, ceiling, wall}, prop (nearest static mesh) + kind, creature {name, cell, cyl, box}
               (cyl = clearance to the physics cylinder: radius r, height = max(physics, mesh top); box = clearance
               to the oriented mesh-bounds box, i.e. claws/head), fails [...]
  minima     : wall in tunnels / rooms, floor, ceiling, prop, creature cylinder, creature box
  violations : contiguous runs of failing samples per rule (kind, i0, i1, t0, t1, worst)
  crossings  : consecutive sample pairs whose segment passes through a cell surface or a prop
  ok         : no violation, no outside sample, no crossing
Rules (DESIGN 4 + phase-2 brief): walls/floor/ceiling >= 0.9 m in tunnels, >= 1.2 m in rooms; props >= 0.6 m;
creatures >= radius + 0.8 m (cylinder clearance >= 0.8); creature box >= 0.3 m is a warning only (claw margin).
The goal portal disc (the end of the run) is not a prop.

  python3 tools/check_clearance.py <traj.json> [--out=report.json] [--every=1] [--rows] [--no-crossings]
"""
import argparse, json, math, os, sys
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import eogeo as G

RULES = {'wall_tunnel': 0.9, 'wall_room': 1.2, 'prop': 0.6, 'creature_cyl': 0.8, 'creature_box_warn': 0.3}


def check(D, rows, rules=RULES, crossings=True, keep_rows=True):
    out_rows = []
    prev = None
    mins = {k: {'value': 99.0} for k in ('wall_tunnel', 'wall_room', 'floor', 'ceiling', 'prop', 'creature_cyl', 'creature_box')}
    fails_by_kind = {}
    outside = 0
    for i, r in enumerate(rows):
        p = np.asarray(r['pos'], float)
        cid = D.point_cell(p, prev)
        prev = cid or prev
        region = D.region_of(cid) if cid else 'outside'
        bc = D.wall_by_class(p, 2 if region == 'room' else 1)
        wall = min(bc.values())
        dp, prop = D.prop(p)
        cr = D.creature_clearance(p, 14.0)
        cbest = None
        for c, cyl, box in cr:
            if cbest is None or cyl < cbest[1]:
                cbest = (c, cyl, box)
        boxmin = min((b for _, _, b in cr), default=99.0)
        fails = []
        if region == 'outside':
            outside += 1; fails.append('outside')
        else:
            lim = rules['wall_tunnel'] if region == 'tunnel' else rules['wall_room']
            if wall < lim:
                fails.append('wall_' + region)
        if prop is not None and dp < rules['prop']:
            fails.append('prop')
        if cbest and cbest[1] < rules['creature_cyl']:
            fails.append('creature')
        warns = ['creature_box'] if boxmin < rules['creature_box_warn'] else []
        row = {'i': i, 't': r.get('t'), 's': r.get('s'), 'pos': [round(float(x), 3) for x in p],
               'cell': '0x%08X' % (0x002B0000 | cid) if cid else None, 'region': region,
               'wall': round(wall, 3), 'byClass': {k: round(v, 3) for k, v in bc.items()},
               'prop': round(dp, 3), 'propKind': prop['kind'] if prop else None, 'propSetup': prop['setup'] if prop else None,
               'creature': None if not cbest else {'name': cbest[0]['name'], 'cell': cbest[0]['cellHex'], 'i': cbest[0]['i'],
                                                    'cyl': round(cbest[1], 3), 'box': round(cbest[2], 3)},
               'boxMin': round(boxmin, 3), 'fails': fails, 'warns': warns}
        out_rows.append(row)
        for f in fails + warns:
            fails_by_kind.setdefault(f, []).append(i)

        def upd(key, val):
            if val < mins[key]['value']:
                mins[key] = {'value': round(val, 3), 'i': i, 't': r.get('t'), 's': r.get('s'), 'pos': row['pos'], 'cell': row['cell']}
        if region == 'tunnel':
            upd('wall_tunnel', wall)
        elif region == 'room':
            upd('wall_room', wall)
        upd('floor', bc['floor']); upd('ceiling', bc['ceiling'])
        if prop is not None:
            upd('prop', dp)
            if mins['prop'].get('i') == i:
                mins['prop']['kind'] = prop['kind']; mins['prop']['setup'] = prop['setup']
        if cbest:
            upd('creature_cyl', cbest[1])
            if mins['creature_cyl'].get('i') == i:
                mins['creature_cyl']['creature'] = f"{cbest[0]['name']} {cbest[0]['cellHex']}"
        upd('creature_box', boxmin)
    # violation runs
    violations = []
    for kind, idx in sorted(fails_by_kind.items()):
        runs = []
        for k in idx:
            if runs and k == runs[-1][1] + 1:
                runs[-1][1] = k
            else:
                runs.append([k, k])
        for a, b in runs:
            key = {'wall_tunnel': 'wall', 'wall_room': 'wall', 'prop': 'prop', 'creature': 'creature', 'creature_box': 'boxMin',
                   'outside': 'wall'}[kind]
            worst = min(out_rows[j][key] if key != 'creature' else (out_rows[j]['creature'] or {}).get('cyl', 99) for j in range(a, b + 1))
            violations.append({'kind': kind, 'i0': a, 'i1': b, 't0': out_rows[a]['t'], 't1': out_rows[b]['t'],
                               's0': out_rows[a]['s'], 's1': out_rows[b]['s'], 'worst': round(worst, 3),
                               'cell': out_rows[a]['cell'], 'pos': out_rows[a]['pos'],
                               'warning': kind == 'creature_box'})
    cross = []
    if crossings:
        for i in range(len(rows) - 1):
            h = D.seg_hits(rows[i]['pos'], rows[i + 1]['pos'])
            if h:
                cross.append({'i': i, 'what': h, 'a': rows[i]['pos'], 'b': rows[i + 1]['pos']})
    hard = [v for v in violations if not v['warning']]
    report = {'rules': rules, 'n': len(rows), 'outside': outside, 'minima': mins, 'violations': violations,
              'crossings': cross, 'ok': not hard and not cross and outside == 0}
    if keep_rows:
        report['rows'] = out_rows
    return report


def summary(rep):
    m = rep['minima']
    lines = [f"samples {rep['n']}  outside {rep['outside']}  crossings {len(rep['crossings'])}  ok {rep['ok']}",
             f"min wall tunnel {m['wall_tunnel']['value']} (rule {rep['rules']['wall_tunnel']}) at {m['wall_tunnel'].get('cell')} s={m['wall_tunnel'].get('s')} t={m['wall_tunnel'].get('t')}",
             f"min wall room   {m['wall_room']['value']} (rule {rep['rules']['wall_room']}) at {m['wall_room'].get('cell')} s={m['wall_room'].get('s')} t={m['wall_room'].get('t')}",
             f"min floor {m['floor']['value']}  min ceiling {m['ceiling']['value']}",
             f"min prop {m['prop']['value']} (rule {rep['rules']['prop']}) at {m['prop'].get('cell')} s={m['prop'].get('s')}",
             f"min creature cyl {m['creature_cyl']['value']} (rule {rep['rules']['creature_cyl']}) {m['creature_cyl'].get('creature', '')} s={m['creature_cyl'].get('s')}",
             f"min creature box {m['creature_box']['value']} (warn < {rep['rules']['creature_box_warn']})"]
    for v in rep['violations'][:40]:
        lines.append(f"  {'WARN' if v['warning'] else 'FAIL'} {v['kind']:13s} i{v['i0']}-{v['i1']} s {v['s0']}-{v['s1']} t {v['t0']}-{v['t1']} worst {v['worst']} {v['cell']} {v['pos']}")
    for c in rep['crossings'][:10]:
        lines.append(f"  CROSS {c['what']} i{c['i']} {c['a']} -> {c['b']}")
    return '\n'.join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('traj')
    ap.add_argument('--out')
    ap.add_argument('--every', type=int, default=1)
    ap.add_argument('--rows', action='store_true', help='keep per-sample rows in the report')
    ap.add_argument('--no-crossings', action='store_true')
    a = ap.parse_args(argv)
    D = G.Dungeon()
    rows = G.load_traj(a.traj)[::a.every]
    rep = check(D, rows, crossings=not a.no_crossings, keep_rows=a.rows)
    if a.out:
        json.dump(rep, open(a.out, 'w'))
    print(summary(rep))
    return 0 if rep['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
