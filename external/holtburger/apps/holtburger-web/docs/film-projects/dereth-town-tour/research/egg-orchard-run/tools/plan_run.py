#!/usr/bin/env python3
"""plan_run.py - speed zones + trick placements along the Egg Orchard racing line, and a duration estimate.

  python3 tools/plan_run.py [--line=data/racing_line.json] [--zones=data/zones.json] [--tricks=data/tricks.json]

Zones (`fpv.fpv-run` param `zones: [{s0, s1, speed}]`, non-overlapping, sorted): the research speed plan per
segment A-K (research-2 (e)), split where a feature needs its own cap (chimney-A float, the pit edge / dive /
pull-out, the egg-chamber reveal, the portal approach). Speeds are CAPS; the technique's curvature limit
(alat) and the duration fit lower them further.

Tricks (`tricks: [{type, s, ...}]`, s = arc length where the trick starts) are placed from the line's feature
anchors (data/racing_line.json 'anchors', authored in tools/build_line.py) - DESIGN 4's list: entry float + dive
into the trench, the -12 floor chute (cut throttle + 33 deg dive), the chimney-A punch-float, the pit (roll over
the edge + nose-over dive; split-S skipped: the pit lid is only ~3.4 m above the edge), the ramp-hall swoop,
the -60 burrow dives / pop-up, the egg-chamber float-up reveal and a roll into the portal.

The duration estimate is a forward/backward speed profile: v(s) = min(zone cap, sqrt(alat / curvature)),
accel/decel <= amax, start from a hover and end at rest, + startHoldSec. It is an estimate only - the
technique fits its own profile to the shot duration.
"""
import argparse, json, math, os, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

SEG_SPEED = {'A': 5.5, 'B': 8.0, 'C': 7.5, 'D': 5.0, 'E': 7.0, 'F': 9.5, 'G': 6.5, 'H': 10.0, 'I': 9.0, 'J': 6.5, 'K': 6.0}


def curvature(P, span=3):
    n = len(P); k = np.zeros(n)
    for i in range(span, n - span):
        a, b, c = P[i - span], P[i], P[i + span]
        ab = np.linalg.norm(b - a); bc = np.linalg.norm(c - b); ca = np.linalg.norm(a - c)
        area = np.linalg.norm(np.cross(b - a, c - a)) / 2
        k[i] = 4 * area / (ab * bc * ca) if ab * bc * ca > 1e-9 else 0.0
    return k


def nearest_s(P, s, q):
    return float(s[int(np.argmin(np.linalg.norm(P - np.asarray(q, float), axis=1)))])


def build_zones(line, P, s):
    segs = {g['id']: g for g in line['segments']}
    an = {k: v['s'] for k, v in line['anchors'].items()}
    chimney = nearest_s(P, s, (219.5, 8136.0, -33.0))
    cuts = []   # (s0, s1, speed, why) overrides inside segments
    cuts.append((chimney - 6.0, chimney + 6.0, 2.6, 'chimney A punch-float: stay inside the 10 x 10 m shaft while airborne'))
    cuts.append((an['H.approach'] - 2.0, an['H.edge'] + 1.5, 4.5, 'pit edge: roll over the edge'))
    cuts.append((an['H.edge'] + 1.5, an['H.bottom'], 12.0, 'pit dive (near-ballistic)'))
    cuts.append((an['H.bottom'], segs['H']['s1'], 7.5, 'pit pull-out (radius ~5.5 m)'))
    cuts.append((an['K.egg.enter'] - 2.0, an['K.egg.exit'], 4.0, 'egg chamber float-up reveal + carve'))
    cuts.append((an['K.corner'] - 1.0, float(s[-1]), 3.5, 'exit corner + portal approach'))
    cuts.append((0.0, an['A.tunnel'], 5.0, 'entry hover, float between the mushroom caps, dive into the trench'))
    cuts.append((an['E.cut'] - 1.0, an['E.exit'] + 2.0, 6.0, 'floor chute: cut throttle over the hole, 33 deg dive'))
    # base zones per segment, then overrides (later wins), flattened to non-overlapping pieces
    edges = sorted({0.0, float(s[-1])} | {g['s0'] for g in line['segments']} | {g['s1'] for g in line['segments']} |
                   {round(c[0], 2) for c in cuts} | {round(c[1], 2) for c in cuts})
    zones = []
    for a, b in zip(edges, edges[1:]):
        if b - a < 0.05:
            continue
        mid = (a + b) / 2
        seg = next((g for g in line['segments'] if g['s0'] <= mid <= g['s1']), line['segments'][-1])
        sp, why = SEG_SPEED[seg['id']], f"segment {seg['id']}: {seg['name']}"
        for c in cuts:
            if c[0] <= mid <= c[1]:
                sp, why = c[2], c[3]
        if zones and zones[-1]['speed'] == sp and zones[-1]['why'] == why and abs(zones[-1]['s1'] - a) < 1e-6:
            zones[-1]['s1'] = round(b, 2)
        else:
            zones.append({'s0': round(a, 2), 's1': round(b, 2), 'speed': sp, 'segment': seg['id'], 'why': why})
    return zones, chimney


def build_tricks(line, P, s, chimney):
    an = {k: v['s'] for k, v in line['anchors'].items()}
    chB = nearest_s(P, s, (210.0, 8151.5, -33.0))
    T = [
        {'type': 'float', 's': an['A.lift'] + 1.0, 'rise': 2.4, 'punchAccel': 8.0,
         'why': 'entry hall: punch up between the mushroom caps (AC1 top 4.46, hall ceiling 9), cut throttle, float over the mound'},
        {'type': 'dive', 's': an['A.dive'] - 1.0, 'pitchDeg': -35,
         'why': 'nose down into the groove cut through the mound -> trench 0x375'},
        {'type': 'float', 's': an['E.cut'] - 2.0, 'rise': 1.0, 'punchAccel': 7.5,
         'why': '-12 hall: cut throttle over the 6.4 x 5.9 m floor hole'},
        {'type': 'dive', 's': an['E.hole'], 'pitchDeg': -40, 'why': 'floor chute: 33 deg dive under the roof lip into the -18 tunnel'},
        {'type': 'float', 's': chimney - 5.0, 'rise': 13.0, 'punchAccel': 12.0,
         'why': 'chimney A over 0x1E0 (10 x 10 m, lid at -12): punch up ~13 m, cut throttle, float, drop back'},
        {'type': 'yaw-spin', 's': chB - 2.0, 'turns': 1, 'dir': 'right', 'durationSec': 1.6,
         'why': '0x1DC under chimney B (open above): one flat yaw spin'},
        {'type': 'roll', 's': an['H.edge'] - 4.0, 'turns': 1, 'dir': 'left', 'durationSec': 0.9, 'rise': 0.2,
         'why': 'roll out over the pit edge (lid 3.4 m above: no room for a split-S)'},
        {'type': 'dive', 's': an['H.edge'] + 0.5, 'pitchDeg': -80,
         'why': 'THE PIT: nose-over, ~16 m near-ballistic drop, pull out over the two pit-bottom Rippers'},
        {'type': 'roll', 's': an['J.swoop'] - 1.0, 'turns': 1, 'dir': 'right', 'durationSec': 1.1,
         'why': 'ramp hall 0x150 swoop (20 m wide, ceiling -45)'},
        {'type': 'dive', 's': an['K.dive1'] - 0.5, 'pitchDeg': -35, 'why': '-60: dive into trench 0x130'},
        {'type': 'float', 's': an['K.popup2'] - 1.0, 'rise': 1.2, 'punchAccel': 8.0,
         'why': '-60: pop up out of trench 0x122 into room 0x121'},
        {'type': 'dive', 's': an['K.dive3'] - 0.5, 'pitchDeg': -35, 'why': '-60: dive into trench 0x11B'},
        {'type': 'float', 's': an['K.egg.rise'] - 1.0, 'rise': 3.5, 'punchAccel': 8.0, 'hangSec': 1.2, 'lookDownDeg': 45,
         'why': 'west egg chamber: float-up reveal over the eggs, larvae and the toxic hive'},
        {'type': 'roll', 's': an['K.portal'] - 2.5, 'turns': 1, 'dir': 'left', 'durationSec': 1.0,
         'why': 'roll into the Surface portal swirl'},
    ]
    skipped = [{'type': 'split-S', 'where': 'pit edge 0x1D8 -> 0x1D4', 'reason': 'the pit lid (-30) is only ~3.4 m above the line at the edge; a half-roll + half-loop down needs ~2 r of height above the entry and would invert the drone under the lid. Roll + nose-over dive instead.'},
               {'type': 'power-loop', 'where': 'anywhere', 'reason': 'not requested by DESIGN 4; the tallest straight spaces (chimneys, pit) are 10 m wide - a loop of radius >= 3.5 m would need a straight 10 m+ run inside them'}]
    for t in T:
        t['s'] = round(float(t['s']), 2)
    T.sort(key=lambda t: t['s'])
    return T, skipped


def estimate(P, s, zones, alat=12.0, amax=9.0, v0=0.5, vend=0.5, start_hold=0.8):
    k = curvature(P)
    cap = np.full(len(P), 8.0)
    for z in zones:
        m = (s >= z['s0']) & (s <= z['s1'])
        cap[m] = z['speed']
    vk = np.sqrt(alat / np.maximum(k, 1e-6))
    v = np.minimum(cap, vk)
    v[0] = min(v[0], v0); v[-1] = min(v[-1], vend)
    ds = np.diff(s)
    for i in range(1, len(v)):
        v[i] = min(v[i], math.sqrt(v[i - 1] ** 2 + 2 * amax * ds[i - 1]))
    for i in range(len(v) - 2, -1, -1):
        v[i] = min(v[i], math.sqrt(v[i + 1] ** 2 + 2 * amax * ds[i]))
    t = np.r_[0, np.cumsum(ds / np.maximum((v[1:] + v[:-1]) / 2, 0.05))]
    return float(t[-1]) + start_hold, t + start_hold, v


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--line', default=os.path.join(ROOT, 'data', 'racing_line.json'))
    ap.add_argument('--zones', default=os.path.join(ROOT, 'data', 'zones.json'))
    ap.add_argument('--tricks', default=os.path.join(ROOT, 'data', 'tricks.json'))
    a = ap.parse_args(argv)
    line = json.load(open(a.line))
    P = np.array(line['points']); s = np.array(line['s'])
    zones, chimney = build_zones(line, P, s)
    tricks, skipped = build_tricks(line, P, s, chimney)
    total, t, v = estimate(P, s, zones)
    for tr in tricks:
        i = int(np.searchsorted(s, tr['s']))
        tr['tEstimate'] = round(float(t[min(i, len(t) - 1)]), 2)
    json.dump({'about': 'Speed caps by arc length along data/racing_line.json for fpv.fpv-run `zones` (m/s). Outside zones the technique `speed` applies.',
               'line': os.path.relpath(a.line, ROOT), 'lengthM': line['length'], 'zones': zones,
               'estimate': {'durationSec': round(total, 1), 'model': 'v = min(zone cap, sqrt(12 / curvature)), |a| <= 9 m/s^2, hover start (0.8 s) and rest end',
                            'meanSpeed': round(line['length'] / (total - 0.8), 2)}},
              open(a.zones, 'w'), indent=1)
    json.dump({'about': 'Trick placements for fpv.fpv-run `tricks` (s = arc length in m along data/racing_line.json where the trick starts). tEstimate = time from the zone/curvature profile (no trick time).',
               'line': os.path.relpath(a.line, ROOT), 'tricks': tricks, 'skipped': skipped},
              open(a.tricks, 'w'), indent=1)
    print(f"zones {len(zones)}, tricks {len(tricks)}, estimated duration {total:.1f} s (mean {line['length'] / (total - 0.8):.2f} m/s)")
    for z in zones:
        print(f"  zone {z['s0']:7.2f}-{z['s1']:7.2f} {z['speed']:5.1f} m/s  {z['why']}")
    for tr in tricks:
        print(f"  trick {tr['type']:9s} s {tr['s']:7.2f} t~{tr['tEstimate']:6.2f}  {tr['why'][:80]}")


if __name__ == '__main__':
    main()
