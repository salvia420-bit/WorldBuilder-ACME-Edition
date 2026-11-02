#!/usr/bin/env python3
"""The Hellcat airframe as retail AC parts (vehicle frame: x right, y forward, z up; origin = the ground under the
main wheels, level). Emits parts JSON (did, offset, rot [w,x,y,z], scale, role, note) for the preview renderer and
the C# profile. Roles: 0 static, 1 propeller, 2 gear, 3 canopy, 4 | (weaponIndex << 16) ordnance."""
import json
import math
import sys

import numpy as np

sys.path.insert(0, __file__.rsplit("/", 1)[0])
import acmodel  # noqa: E402

# ---- models (retail portal.dat Setups)
BARREL = 0x02001888       # Barrel (wcid 72602), upright, z 0..1.02, hexagonal 0.81 x 0.69
STEEL_KEG = 0x0200188D    # Keg (wcid 72599), steel, upright, z -0.04..0.80, tap at +y
BUCKET = 0x0200043C       # Bucket (wcid 36715), open steel tub 1.52 x 1.40
TOWER_SHIELD = 0x02000161 # Tower Shield (wcid 95), flat, long axis y -0.71..0.23, arched across x
KITE_SHIELD = 0x02000164  # Kite Shield (wcid 91), flat, point at -y
ROUND_SHIELD = 0x02000162 # Round Shield (wcid 93), flat octagonal dome 0.66
SPADONE = 0x0200130B      # Spadone (wcid 29978), blade along -y (tip -1.37), hilt +0.28
CROSSBOW = 0x02000874     # Composite Crossbow with Handle (wcid 7013): stock along x, shoots toward -x
WAND = 0x0200017C         # Wand (wcid 2472): purple crystal at +y
STAFF = 0x0200013D        # Academy Staff (wcid 45548): along y -1.33..0.30
SPEAR = 0x0200054D        # Lightning Spear (wcid 47753): along y -1.49..0.49
CRYSTAL = 0x020019C4      # Crystal (wcid 42888): a 1 x 2 m panel, x -0.5..0.5, z 0..2
QUARREL = 0x0200012A      # Deadly Armor Piercing Quarrel (wcid 15440): the gun's round (client-drawn)

ZC = 2.30                 # thrust line (prop hub) height, level frame


def q_axis(axis, deg):
    a = math.radians(deg) / 2
    ax = np.array(axis, dtype=float)
    ax /= np.linalg.norm(ax)
    return (math.cos(a), *(ax * math.sin(a)))


def qmul(a, b):
    return acmodel.qmul(a, b)


def q_of(*qs):
    """Rotations applied in order: q_of(A, B) = apply A first, then B."""
    q = (1.0, 0.0, 0.0, 0.0)
    for r in qs:
        q = qmul(r, q)
    n = math.sqrt(sum(c * c for c in q))
    return tuple(c / n for c in q)


ROT_FWD = q_axis((1, 0, 0), -90)   # an upright model's +z -> +y (forward)

parts = []


def add(did, offset, rot=(1, 0, 0, 0), scale=1.0, role=0, note=""):
    parts.append({"did": did, "offset": [round(v, 4) for v in offset], "rot": [round(v, 6) for v in rot],
                  "scale": round(scale, 4), "role": role, "note": note})


# ------------------------------------------------------------------ fuselage (rear -> front)
def barrel(y0, s, note, z=ZC):
    # upright barrel z 0..1.02s, rotated forward: spans y y0..y0+1.02s; its hexagon centre at rest y ~ +0.006
    add(BARREL, (0, y0, z), ROT_FWD, s, note=note)
    return y0 + 1.019 * s


y = -6.15
y = barrel(y, 0.50, "tail cone", ZC + 0.18)
y = barrel(y, 0.68, "tail cone", ZC + 0.12)
y = barrel(y, 0.90, "rear fuselage", ZC + 0.07)
y = barrel(y, 1.12, "rear fuselage", ZC + 0.03)
y = barrel(y, 1.32, "fuselage")
y_cockpit0 = y
# the cockpit tub: the open steel bucket, upright, its floor below the thrust line
BUCKET_S = 0.86
add(BUCKET, (0, y + 0.70, ZC - 0.62), (1, 0, 0, 0), BUCKET_S, note="cockpit tub")
y += 1.30
y = barrel(y, 1.42, "forward fuselage")
# the engine cowling: the steel keg (R-2800 under a keg)
KEG_COWL_S = 1.78
add(STEEL_KEG, (0, y - 0.02, ZC), ROT_FWD, KEG_COWL_S, note="cowling (steel keg)")
y_cowl_front = y - 0.02 + 0.80 * KEG_COWL_S
# spinner: a round shield's dome facing forward
add(ROUND_SHIELD, (0, y_cowl_front + 0.02, ZC), ROT_FWD, 0.95, role=1, note="spinner")
HUB = (0, y_cowl_front + 0.10, ZC)
# propeller: three Spadones, flat in the disc, a little pitch
PROP_S = 1.38
for k in range(3):
    base = q_axis((1, 0, 0), 90)          # tip (-y) -> -z, flat face -> the disc
    pitch = q_axis((0, 0, 1), 20)         # blade pitch about the blade's long axis (z after base)
    spin = q_axis((0, 1, 0), 120 * k)
    add(SPADONE, HUB, q_of(base, pitch, spin), PROP_S, role=1, note=f"prop blade {k}")

# ------------------------------------------------------------------ wings (tower shields, kite-shield tips)
WING_Z = ZC - 0.62
WING_Y = 0.55


def wing_panel(side, x_in, s, z, dihedral, note):
    # tower shield long axis (rest y -0.711..0.231) -> span outward
    rz = -90 if side > 0 else 90
    rot = q_of(q_axis((0, 0, 1), rz), q_axis((0, 1, 0), -dihedral * side))
    # rest y=-0.711 -> inner end
    inner = 0.711 * s
    add(TOWER_SHIELD, (side * (x_in + inner), WING_Y, z), rot, s, note=note)
    return x_in + 0.942 * s


tips = {}
for side in (1, -1):
    x = wing_panel(side, 0.45, 2.55, WING_Z, 0.0, "wing inner panel")
    x = wing_panel(side, x - 0.15, 2.25, WING_Z + 0.05, 7.0, "wing outer panel")
    # tip: kite shield, point outward
    s = 1.55
    rz = 90 if side > 0 else -90
    add(KITE_SHIELD, (side * (x - 0.15 + 0.242 * s), WING_Y + 0.05, WING_Z + 0.26), q_of(q_axis((0, 0, 1), rz), q_axis((0, 1, 0), -7.0 * side)), s, note="wing tip")
    tips[side] = x + 0.605 * s

# ------------------------------------------------------------------ tail
TAIL_Y = -5.35
for side in (1, -1):
    s = 1.55
    rz = 90 if side > 0 else -90
    add(KITE_SHIELD, (side * (0.18 + 0.242 * s), TAIL_Y, ZC + 0.12), q_axis((0, 0, 1), rz), s, note="tailplane")
# fin: rest -y (point) -> up, face -> side, rest x -> -y (chord along the fuselage)
M = np.array([[0, 0, 1], [-1, 0, 0], [0, -1, 0]], dtype=float)  # columns = images of ex, ey, ez


def quat_from_matrix(m):
    t = m[0, 0] + m[1, 1] + m[2, 2]
    if t > 0:
        s = math.sqrt(t + 1.0) * 2
        return (0.25 * s, (m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s)
    i = int(np.argmax([m[0, 0], m[1, 1], m[2, 2]]))
    if i == 0:
        s = math.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        return ((m[2, 1] - m[1, 2]) / s, 0.25 * s, (m[0, 1] + m[1, 0]) / s, (m[0, 2] + m[2, 0]) / s)
    if i == 1:
        s = math.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        return ((m[0, 2] - m[2, 0]) / s, (m[0, 1] + m[1, 0]) / s, 0.25 * s, (m[1, 2] + m[2, 1]) / s)
    s = math.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
    return ((m[1, 0] - m[0, 1]) / s, (m[0, 2] + m[2, 0]) / s, (m[1, 2] + m[2, 1]) / s, 0.25 * s)


FIN_Q = q_of(quat_from_matrix(M), q_axis((1, 0, 0), -14))
add(KITE_SHIELD, (0, TAIL_Y - 0.05, ZC + 0.30), FIN_Q, 2.1, note="fin")

# ------------------------------------------------------------------ canopy, mast
# (no windscreen: an open cockpit, the pilot's head over the bucket's rim — the kit-bashed early-war look)
add(SPEAR, (0, y_cockpit0 - 0.35, ZC + 0.62), q_of(q_axis((1, 0, 0), 90), q_axis((1, 0, 0), -12)), 0.62, note="radio mast")

# ------------------------------------------------------------------ weapons (indices = profile weapon order)
weapons = []   # {kind, muzzle, ...}
GUN_XS = (2.0, 2.55, 3.1)
GUN_Y = WING_Y + 0.85
GUN_Z = WING_Z + 0.04
CROSSBOW_Q = q_axis((0, 0, 1), -90)
CROSSBOW_S = 0.62
for side in (-1, 1):
    for gx in (GUN_XS if side > 0 else GUN_XS[::-1]):
        wi = len(weapons)
        add(CROSSBOW, (side * gx, GUN_Y, GUN_Z), CROSSBOW_Q, CROSSBOW_S, note=f"gun {wi} (crossbow)")
        weapons.append({"kind": 1, "muzzle": [side * gx, GUN_Y + 0.67 * CROSSBOW_S, GUN_Z]})
RAIL_XS = (3.55, 4.05, 4.55)
RAIL_Y = WING_Y - 0.20
RAIL_Z = WING_Z - 0.22
WAND_S = 1.75
for side in (-1, 1):
    for rx in (RAIL_XS if side > 0 else RAIL_XS[::-1]):
        wi = len(weapons)
        zz = RAIL_Z + (rx - 3.55) * math.tan(math.radians(7.0)) * 0.6
        add(WAND, (side * rx, RAIL_Y, zz), (1, 0, 0, 0), WAND_S, role=4 | (wi << 16), note=f"lightning rail {wi} (wand)")
        weapons.append({"kind": 2, "muzzle": [side * rx, RAIL_Y + 0.51 * WAND_S + 0.3, zz]})


def bomb(xc, yc, zc, s, wi, note):
    # a steel keg on its side + four kite-shield fins at the back
    add(STEEL_KEG, (xc, yc - 0.40 * s, zc), ROT_FWD, s, role=4 | (wi << 16), note=note)
    fs = 0.42 * s
    for k in range(4):
        add(KITE_SHIELD, (xc, yc - 0.40 * s - 0.02, zc), q_of(q_axis((1, 0, 0), -90), q_axis((0, 0, 1), 180), q_axis((0, 1, 0), 45 + 90 * k)), fs,
            role=4 | (wi << 16), note=note + " fin")


wi = len(weapons)
bomb(0, 0.35, ZC - 1.20, 1.15, wi, "2000 lb bomb (centreline)")
weapons.append({"kind": 3, "muzzle": [0, 0.35, ZC - 1.20], "lb": 2000})
for side in (-1, 1):
    wi = len(weapons)
    bomb(side * 1.55, 0.40, WING_Z - 0.48, 0.92, wi, "1000 lb bomb (wing)")
    weapons.append({"kind": 3, "muzzle": [side * 1.55, 0.40, WING_Z - 0.48], "lb": 1000})

# ------------------------------------------------------------------ landing gear (level frame; the client tips the
# parked aircraft tail-down by GEAR_PITCH about the main-wheel contact line)
GEAR_PITCH = 11.0
MAIN_Y = 1.05
for side in (-1, 1):
    add(ROUND_SHIELD, (side * 1.75, MAIN_Y, 0.41), q_axis((0, 1, 0), 90 * side), 1.24, role=2, note="main wheel")
    add(STAFF, (side * 1.70, MAIN_Y, 0.41 + 1.06), q_of(q_axis((1, 0, 0), 90), q_axis((0, 1, 0), 6 * side)), 0.80, role=2, note="main strut")
# tail wheel: touches the ground once tipped (z_level = d * tan(pitch))
d = MAIN_Y - (TAIL_Y + 0.35)
tz = d * math.tan(math.radians(GEAR_PITCH))
add(ROUND_SHIELD, (0.10, TAIL_Y + 0.35, tz + 0.22), q_axis((0, 1, 0), 90), 0.62, role=2, note="tail wheel")
add(STAFF, (0.0, TAIL_Y + 0.35, tz + 0.22 + 0.55), q_axis((1, 0, 0), 90), 0.42, role=2, note="tail strut")

SEAT = [0.0, y_cockpit0 + 0.62, ZC - 0.12]

out = {"parts": parts, "weapons": weapons, "seat": SEAT, "hub": HUB, "gearPitch": GEAR_PITCH, "mainY": MAIN_Y,
       "span": [-tips[-1], tips[1]], "zc": ZC}

if __name__ == "__main__":
    json.dump(out, open(sys.argv[1] if len(sys.argv) > 1 else "hellcat.json", "w"), indent=1)
    print(len(parts), "parts;", len(weapons), "weapons; span", round(tips[1] * 2, 2), "m; seat", [round(v, 2) for v in SEAT])
