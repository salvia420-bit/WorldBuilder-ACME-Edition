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
BARREL = 0x02001888          # Barrel (wcid 72602), upright, z 0..1.02, hexagonal 0.81 x 0.69
STEEL_KEG = 0x0200188D       # Keg (wcid 72599), steel, upright, z -0.04..0.80, tap at +y
AMBER_KEG = 0x020014F6       # Amber Keg, upright, z 0.01..0.81, 0.78 x 0.84
BUCKET = 0x0200043C          # Bucket (wcid 36715), open steel tub 1.52 x 1.40
GEAR_SHIELD = 0x020018C8     # Gear Shield, toothed bronze cogwheel 0.75 x 0.75 x 0.10
TOWER_SHIELD = 0x02000161    # Tower Shield (wcid 95), flat, long axis y -0.71..0.23, arched across x
KITE_SHIELD = 0x02000164     # Kite Shield (wcid 91), flat, point at -y (-0.605..0.242)
SILYUN_SHIELD = 0x02001523   # Shield of Silyun, dark steel armored shield, y -0.627..0.485, x -0.367..0.366
BORELEAN_SHIELD = 0x02001975 # Shield of Borelean, dark metallic shield, y -0.609..0.291, x -0.327..0.323
ELDRYTCH_SHIELD = 0x02001858 # Eldrytch Web Shield, purple-trimmed dark shield, y -0.470..0.241
ROUND_SHIELD = 0x02000162    # Round Shield (wcid 93), flat octagonal dome 0.66
SPADONE = 0x0200130B         # Spadone (wcid 29978), blade along -y (tip -1.37), hilt +0.28
FIRE_GREATSWORD = 0x02001916 # Fire Gearknight Greatsword, blade along -y (tip -1.622), hilt +0.663
GEAR_CROSSBOW = 0x02001958   # Gear Crossbow, shoots toward -y in rest pose
CROSSBOW = 0x02000874        # Composite Crossbow with Handle (wcid 7013): stock along x, shoots toward -x
BALLISTA = 0x020010DE        # Biting Ballistae: heavy mechanical crossbow
WAND = 0x0200017C            # Wand (wcid 2472): purple crystal at +y
STAFF = 0x0200013D           # Academy Staff (wcid 45548): along y -1.33..0.30
SPEAR = 0x0200054D           # Lightning Spear (wcid 47753): along y -1.49..0.49
LEVER = 0x020004B5           # Lever, control stick
LEVER_BOX = 0x02001B8F       # Lever Box, cockpit instrument console
BELLOWS = 0x020000A8         # Bellows, supercharger / exhaust manifold
CRYSTAL = 0x020019C4         # Crystal (wcid 42888): a 1 x 2 m panel, x -0.5..0.5, z 0..2
QUARREL = 0x0200012A         # Deadly Armor Piercing Quarrel (wcid 15440): the gun's round (client-drawn)

ZC = 2.68                    # thrust line (prop hub) height, level frame


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


ROT_FWD = q_axis((1, 0, 0), -90)   # an upright model's +z -> +y (forward)
ROT_BWD = q_axis((1, 0, 0), 90)    # an upright model's +z -> -y (aft)

parts = []


def add(did, offset, rot=(1, 0, 0, 0), scale=1.0, role=0, note=""):
    parts.append({"did": did, "offset": [round(v, 4) for v in offset], "rot": [round(v, 6) for v in rot],
                  "scale": round(scale, 4), "role": role, "note": note})


# ==============================================================================
# 1. DEEP MULTI-LOBED GRUMMAN FUSELAGE (y = -7.10 .. +2.15)
# ==============================================================================
# Main central spine (overlapping dark wood/iron barrels so there are zero air gaps)
spine_stations = [
    (-7.10, 0.62, ZC + 0.22, "tailcone tip"),
    (-6.60, 0.80, ZC + 0.19, "tailcone aft"),
    (-6.00, 0.98, ZC + 0.15, "tailcone mid"),
    (-5.25, 1.16, ZC + 0.11, "rear fuselage aft"),
    (-4.40, 1.34, ZC + 0.07, "rear fuselage mid"),
    (-3.45, 1.50, ZC + 0.04, "rear fuselage fwd"),
    (-2.40, 1.62, ZC + 0.02, "mid fuselage aft"),
    (-1.35, 1.70, ZC + 0.00, "cockpit under-fuselage"),
    (-0.20, 1.76, ZC + 0.00, "cockpit forward fuselage"),
    (0.85,  1.84, ZC + 0.02, "firewall fuselage"),
]
for y0, s, z0, label in spine_stations:
    add(BARREL, (0, y0, z0), ROT_FWD, s, note=label)

# Deep ventral belly keel (gives the F6F Hellcat's deep "pregnant guppy" fuselage section)
belly_stations = [
    (-5.40, 0.72, ZC - 0.12, "ventral tail strake barrel"),
    (-4.50, 0.92, ZC - 0.24, "ventral rear belly"),
    (-3.50, 1.12, ZC - 0.36, "ventral mid-aft belly"),
    (-2.40, 1.28, ZC - 0.46, "ventral mid belly"),
    (-1.25, 1.38, ZC - 0.52, "ventral cockpit belly"),
    (-0.10, 1.44, ZC - 0.54, "ventral wing-root belly"),
    (0.95,  1.48, ZC - 0.50, "ventral forward belly"),
]
for y0, s, z0, label in belly_stations:
    add(BARREL, (0, y0, z0), ROT_FWD, s, note=label)

# Upper dorsal razorback turtledeck spine (dark barrels tapering smoothly from behind cockpit to fin)
dorsal_stations = [
    (-6.10, 0.58, ZC + 0.34, "dorsal spine tail"),
    (-5.35, 0.76, ZC + 0.42, "dorsal spine aft"),
    (-4.45, 0.94, ZC + 0.50, "dorsal spine mid-aft"),
    (-3.45, 1.12, ZC + 0.58, "dorsal spine mid"),
    (-2.35, 1.28, ZC + 0.66, "dorsal spine fwd"),
    (-1.45, 1.36, ZC + 0.70, "dorsal turtledeck"),
]
for y0, s, z0, label in dorsal_stations:
    add(BARREL, (0, y0, z0), ROT_FWD, s, note=label)

# Arched Tower-Shield + Borelean dorsal turtledeck fairings (smoothly sloped along the top spine)
# Positive rotation around +x tips +y UP and -y DOWN so plates slope cleanly down toward the tail!
for y0, z0, s, pitch_deg in [
    (-5.30, ZC + 0.48, 1.22, 6.5),
    (-4.25, ZC + 0.60, 1.38, 6.8),
    (-3.10, ZC + 0.73, 1.54, 7.0),
    (-1.90, ZC + 0.86, 1.68, 6.5),
    (1.25,  ZC + 0.66, 1.72, -3.5),
]:
    add(TOWER_SHIELD, (0, y0, z0), q_axis((1, 0, 0), pitch_deg), s, note="dorsal turtledeck fairing")
    add(BORELEAN_SHIELD, (0, y0 - 0.05, z0 + 0.03), q_axis((1, 0, 0), pitch_deg), s * 0.88,
        note="dorsal armor spine plate")

# Fuselage cheek armor fairings (port & starboard slab-sided Grumman fuselage skins)
for side in (-1, 1):
    cheek_rot_base = q_axis((0, 1, 0), 90 * side)
    for y0, x0, z0, s, yaw_deg in [
        (-5.20, 0.36, ZC + 0.16, 1.18, -5.5),
        (-4.00, 0.48, ZC + 0.16, 1.38, -4.5),
        (-2.70, 0.58, ZC + 0.16, 1.54, -3.0),
        (-1.40, 0.66, ZC + 0.14, 1.66, -1.0),
        (-0.10, 0.70, ZC + 0.10, 1.72,  0.0),
        (1.15,  0.72, ZC + 0.08, 1.72,  1.5),
    ]:
        q_cheek = q_of(cheek_rot_base, q_axis((0, 0, 1), yaw_deg * side))
        add(SILYUN_SHIELD, (side * x0, y0, z0), q_cheek, s, note="fuselage cheek armor")

# Flush structural Gearknight fuselage bulkhead rings (sized to hug the fuselage skin cleanly)
for y0, z0, s in [
    (-5.85, ZC + 0.22, 1.05),
    (-3.60, ZC + 0.18, 1.48),
    (-1.25, ZC + 0.12, 1.76),
    (0.85,  ZC + 0.08, 1.88),
]:
    add(GEAR_SHIELD, (0, y0, z0), ROT_FWD, s, note="fuselage gearknight frame ring")


# ==============================================================================
# 2. R-2800 DOUBLE-WASP RADIAL ENGINE, ARMORED COWLING & 4-BLADE PROPELLER
# ==============================================================================
COWL_Y = 2.00
# Primary heavy steel cowling barrel + forward ring
add(STEEL_KEG, (0, COWL_Y, ZC + 0.02), ROT_FWD, 2.22, note="main engine cowling")
add(STEEL_KEG, (0, COWL_Y + 0.38, ZC + 0.02), ROT_FWD, 2.12, note="forward engine cowling")

# Under-nose oil cooler & supercharger chin intake scoop
add(STEEL_KEG, (0, COWL_Y + 0.22, ZC - 0.58), ROT_FWD, 1.42, note="chin oil-cooler intake")
add(SILYUN_SHIELD, (0, COWL_Y + 0.85, ZC - 1.02), q_axis((1, 0, 0), -12), 1.35, note="chin scoop armor lip")
add(GEAR_SHIELD, (0, COWL_Y + 1.30, ZC - 0.58), ROT_FWD, 1.15, note="oil-cooler intake grille")

# Circumferential radial cowling armor petals & cooling gills (10 petals around the R-2800)
for k in range(10):
    ang = k * 36.0
    rad = math.radians(ang)
    r_cowl = 0.88
    cx = r_cowl * math.sin(rad)
    cz = (ZC + 0.02) + r_cowl * math.cos(rad)
    q_petal = q_of(q_axis((1, 0, 0), -6.0), q_axis((0, 1, 0), ang))
    add(BORELEAN_SHIELD, (cx, COWL_Y + 1.05, cz), q_petal, 1.48, note=f"cowl armor petal {k}")

# 9 Radial Engine Cylinders visible inside the front cowling opening + Bronze Reduction Gear Case
CYL_Y = COWL_Y + 1.38
add(GEAR_SHIELD, (0, CYL_Y + 0.22, ZC), ROT_FWD, 1.85, note="R-2800 crankcase reduction gear")
add(GEAR_SHIELD, (0, CYL_Y + 0.34, ZC), ROT_FWD, 1.32, note="R-2800 front cam ring")
for k in range(9):
    ang = k * 40.0
    rad = math.radians(ang)
    q_cyl = q_of(q_axis((0, 1, 0), ang))
    add(STEEL_KEG, (0.24 * math.sin(rad), CYL_Y, ZC + 0.24 * math.cos(rad)), q_cyl, 0.78, note=f"radial cylinder {k}")

# Exhaust Collector Stacks & Supercharger Manifolds along port & starboard cowling gills
for side in (-1, 1):
    add(BELLOWS, (side * 0.78, COWL_Y - 0.15, ZC - 0.18), q_of(ROT_FWD, q_axis((0, 0, 1), -15 * side)), 0.95,
        note="supercharger manifold")
    for idx, ey in enumerate((1.55, 1.85, 2.15)):
        # Staff long axis is Y; yaw outward by 24 deg so stub exhaust pipes jut out from the cowl gills
        q_exh = q_of(q_axis((0, 0, 1), -24 * side), q_axis((1, 0, 0), 10))
        add(STAFF, (side * 0.72, ey, ZC - 0.08 - 0.10 * idx), q_exh, 0.52, note=f"exhaust stack {idx}")

# Propeller & Spinner Assembly (role = 1; first role=1 part defines HUB for rotation!)
y_cowl_front = COWL_Y + 1.72
HUB = (0.0, round(y_cowl_front + 0.12, 4), ZC)
# 1st role=1 part MUST be at HUB so airframe.js spins around HUB!
add(ROUND_SHIELD, HUB, ROT_FWD, 1.32, role=1, note="spinner base dome")
add(GEAR_SHIELD, HUB, ROT_FWD, 1.38, role=1, note="spinner pitch-gear collar")
add(STEEL_KEG, (0, HUB[1] - 0.08, ZC), ROT_FWD, 0.82, role=1, note="spinner core cone")
add(ROUND_SHIELD, (0, HUB[1] + 0.36, ZC), ROT_FWD, 0.88, role=1, note="spinner forward cone")
add(ROUND_SHIELD, (0, HUB[1] + 0.52, ZC), ROT_FWD, 0.52, role=1, note="spinner tip cap")

# 4-Bladed Heavy Gearknight Hamilton-Standard Propeller
PROP_S = 1.42
CUFF_S = 1.48
for k in range(4):
    base = q_axis((1, 0, 0), 90)          # tip (-y) -> -z, flat face -> the disc
    pitch = q_axis((0, 0, 1), 22)         # blade pitch about blade axis
    spin = q_axis((0, 1, 0), 90 * k)
    add(FIRE_GREATSWORD, HUB, q_of(base, pitch, spin), PROP_S, role=1, note=f"prop main blade {k}")
    add(SPADONE, HUB, q_of(base, q_axis((0, 0, 1), 26), spin), CUFF_S, role=1, note=f"prop blade cuff {k}")


# ==============================================================================
# 3. ARMORED COCKPIT, INSTRUMENT CONSOLE & FRAMED CANOPY (role=3)
# ==============================================================================
y_cockpit0 = -1.05
# Pilot seat lowered into the armored tub so pilot sits waist-deep inside the cockpit
SEAT = [0.0, round(y_cockpit0 + 0.65, 4), round(ZC - 0.34, 4)]

# Cockpit armored tub (Bucket) + raised side coaming armor
add(BUCKET, (0, y_cockpit0 + 0.70, ZC - 0.60), (1, 0, 0, 0), 1.02, note="cockpit armored tub")
# Tall rear armored bulkhead & pilot headrest (reaches up behind pilot's head at z ~ ZC + 1.25)
add(SILYUN_SHIELD, (0, y_cockpit0 - 0.05, ZC + 0.82), q_of(ROT_FWD, q_axis((1, 0, 0), 8)), 1.22,
    note="cockpit armor bulkhead")
add(GEAR_SHIELD, (0, y_cockpit0 + 0.02, ZC + 1.08), ROT_FWD, 0.92, note="cockpit headrest ring")
# Cockpit side coaming sills & quarter armor panels
for side in (-1, 1):
    add(ELDRYTCH_SHIELD, (side * 0.64, y_cockpit0 + 0.72, ZC + 0.56),
        q_axis((0, 1, 0), 90 * side), 1.45, note="cockpit side coaming")
    add(SILYUN_SHIELD, (side * 0.56, y_cockpit0 + 0.05, ZC + 0.76),
        q_of(q_axis((0, 1, 0), 90 * side), q_axis((1, 0, 0), -6)), 1.15, note="cockpit rear quarter armor")

# Forward instrument coaming, console, gunsight & flight stick
add(BORELEAN_SHIELD, (0, y_cockpit0 + 1.55, ZC + 0.72), q_axis((1, 0, 0), 14), 1.32, note="forward anti-glare coaming")
add(GEAR_SHIELD, (0, y_cockpit0 + 1.28, ZC + 0.88), ROT_FWD, 0.36, note="reflector gunsight ring")
add(GEAR_SHIELD, (0, y_cockpit0 + 1.32, ZC + 0.46), ROT_FWD, 0.68, note="instrument console")
add(LEVER, (0, y_cockpit0 + 0.95, ZC - 0.05), (1, 0, 0, 0), 0.85, note="control stick")

# Framed fighter windscreen & bubble canopy arch (role = 3: visible externally, hidden in 1st-person cockpit view!)
CANOPY_ROLE = 3
for side in (-1, 1):
    # Forward angled windscreen side pillars
    add(STAFF, (side * 0.34, y_cockpit0 + 1.12, ZC + 1.36),
        q_of(q_axis((1, 0, 0), -42), q_axis((0, 1, 0), -12 * side)), 0.54, role=CANOPY_ROLE, note="windscreen pillar")
    # Canopy upper side rails arching above pilot's head
    add(STAFF, (side * 0.30, y_cockpit0 + 1.05, ZC + 1.44),
        q_of(q_axis((1, 0, 0), 8), q_axis((0, 1, 0), -8 * side)), 0.78, role=CANOPY_ROLE, note="canopy upper rail")
    # Canopy mid beltline rails
    add(STAFF, (side * 0.52, y_cockpit0 + 1.02, ZC + 0.96),
        q_axis((1, 0, 0), 5), 0.78, role=CANOPY_ROLE, note="canopy waist rail")
# Canopy top dorsal spine & armored windscreen brow arch
add(STAFF, (0, y_cockpit0 + 1.05, ZC + 1.52), q_axis((1, 0, 0), 9), 0.80, role=CANOPY_ROLE, note="canopy dorsal rail")
add(ELDRYTCH_SHIELD, (0, y_cockpit0 + 1.32, ZC + 1.04), q_axis((1, 0, 0), -36), 0.92, role=CANOPY_ROLE,
    note="windscreen armored brow")


# ==============================================================================
# 4. THICK MULTI-SPAR CRANKED GULL WINGS (span ~15.86 m)
# ==============================================================================
WING_Z = ZC - 0.58
WING_Y = 0.45
DIHEDRAL = 7.5
INNER_KNUCKLE_X = 2.35


def wing_z_at(x_abs):
    if x_abs <= INNER_KNUCKLE_X:
        return WING_Z
    return WING_Z + (x_abs - INNER_KNUCKLE_X) * math.tan(math.radians(DIHEDRAL))


def add_wing_surface(did, side, x_in, y_pos, z_base, s, dihedral_deg, pitch_deg=0.0, note="wing panel"):
    rz = -90 if side > 0 else 90
    rot = q_of(
        q_axis((0, 0, 1), rz),
        q_axis((1, 0, 0), pitch_deg),
        q_axis((0, 1, 0), -dihedral_deg * side),
    )
    inner = 0.711 * s
    add(did, (side * (x_in + inner), y_pos, z_base), rot, s, note=note)
    return x_in + 0.942 * s


tips = {}
for side in (1, -1):
    # Wing-root armored fillet fairing blending fuselage to inner gull wing
    add(SILYUN_SHIELD, (side * 1.15, WING_Y + 0.35, WING_Z + 0.16),
        q_of(q_axis((0, 1, 0), -12 * side), q_axis((1, 0, 0), 3)), 1.65, note="wing root upper fillet")
    add(SILYUN_SHIELD, (side * 1.15, WING_Y - 0.45, WING_Z + 0.12),
        q_of(q_axis((0, 1, 0), -10 * side), q_axis((1, 0, 0), -2)), 1.55, note="wing root trailing fillet")

    # --- INNER HORIZONTAL SECTION (x = 0.50 .. 2.45, dihedral = 0) ---
    add_wing_surface(TOWER_SHIELD, side, 0.50, WING_Y + 0.44, WING_Z + 0.05, 2.15, 0.0, 2.0, "inner wing fwd upper")
    add_wing_surface(TOWER_SHIELD, side, 0.50, WING_Y + 0.40, WING_Z - 0.06, 2.10, 0.0, -1.5, "inner wing fwd lower")
    add_wing_surface(TOWER_SHIELD, side, 0.50, WING_Y - 0.28, WING_Z + 0.04, 2.15, 0.0, -2.0, "inner wing aft upper")
    add_wing_surface(TOWER_SHIELD, side, 0.50, WING_Y - 0.30, WING_Z - 0.06, 2.10, 0.0, 1.0, "inner wing aft lower")
    add_wing_surface(BORELEAN_SHIELD, side, 0.65, WING_Y + 0.08, WING_Z + 0.09, 1.95, 0.0, 0.0, "inner wing armor walk")

    # Knuckle Gearknight rib joint at x = 2.35
    add(GEAR_SHIELD, (side * INNER_KNUCKLE_X, WING_Y + 0.08, WING_Z - 0.02),
        q_axis((0, 1, 0), 90 * side), 0.92, note="wing fold knuckle rib")

    # --- MID OUTER PANEL (x = 2.25 .. 4.65, dihedral = 7.5 deg) ---
    z_mid = WING_Z + 0.08
    x_mid_out = add_wing_surface(TOWER_SHIELD, side, 2.25, WING_Y + 0.38, z_mid + 0.04, 2.55, DIHEDRAL, 1.5,
                                 "mid wing fwd upper")
    add_wing_surface(TOWER_SHIELD, side, 2.25, WING_Y + 0.35, z_mid - 0.05, 2.50, DIHEDRAL, -1.5,
                     "mid wing fwd lower")
    add_wing_surface(TOWER_SHIELD, side, 2.25, WING_Y - 0.28, z_mid + 0.03, 2.55, DIHEDRAL, -2.0,
                     "mid wing aft upper")
    add_wing_surface(TOWER_SHIELD, side, 2.25, WING_Y - 0.30, z_mid - 0.05, 2.50, DIHEDRAL, 1.0,
                     "mid wing aft lower")
    add_wing_surface(BORELEAN_SHIELD, side, 2.35, WING_Y + 0.06, z_mid + 0.08, 2.35, DIHEDRAL, 0.0,
                     "mid wing dorsal armor")

    # --- OUTER PANEL (x = 4.45 .. 6.65, dihedral = 7.5 deg) ---
    z_out = wing_z_at(4.45) + 0.08
    x_out_end = add_wing_surface(TOWER_SHIELD, side, 4.45, WING_Y + 0.28, z_out + 0.03, 2.32, DIHEDRAL, 1.5,
                                 "outer wing fwd upper")
    add_wing_surface(TOWER_SHIELD, side, 4.45, WING_Y + 0.25, z_out - 0.04, 2.28, DIHEDRAL, -1.0,
                     "outer wing fwd lower")
    add_wing_surface(TOWER_SHIELD, side, 4.45, WING_Y - 0.24, z_out + 0.02, 2.32, DIHEDRAL, -2.0,
                     "outer wing aft upper")
    add_wing_surface(ELDRYTCH_SHIELD, side, 4.55, WING_Y + 0.02, z_out + 0.07, 2.20, DIHEDRAL, 0.0,
                     "outer wing trim skin")

    # Internal continuous front & rear tubular wing spars (Academy Staffs)
    q_spar = q_of(q_axis((0, 0, 1), -90 * side), q_axis((0, 1, 0), -DIHEDRAL * side))
    add(STAFF, (side * 3.80, WING_Y + 0.32, wing_z_at(3.80)), q_spar, 2.10, note="main front wing spar")
    add(STAFF, (side * 3.80, WING_Y - 0.22, wing_z_at(3.80)), q_spar, 2.10, note="main rear wing spar")

    # Slotted trailing-edge flaps & ailerons
    add_wing_surface(BORELEAN_SHIELD, side, 1.10, WING_Y - 0.62, WING_Z - 0.04, 1.55, 0.0, -8.0, "inboard slotted flap")
    add_wing_surface(BORELEAN_SHIELD, side, 2.65, WING_Y - 0.58, wing_z_at(3.20) - 0.02, 1.75, DIHEDRAL, -6.0,
                     "mid slotted flap")
    add_wing_surface(ELDRYTCH_SHIELD, side, 4.65, WING_Y - 0.48, wing_z_at(5.30), 1.85, DIHEDRAL, -3.0, "aileron")

    # Sculpted raked wingtip (Kite Shield + Eldrytch accent cap + wingtip Pitot spear)
    s_tip = 1.78
    rz_tip = 90 if side > 0 else -90
    q_tip = q_of(q_axis((0, 0, 1), rz_tip), q_axis((0, 1, 0), -DIHEDRAL * side))
    x_tip_base = x_out_end - 0.20
    z_tip = wing_z_at(x_tip_base) + 0.16
    add(KITE_SHIELD, (side * (x_tip_base + 0.242 * s_tip), WING_Y + 0.04, z_tip), q_tip, s_tip, note="wing tip main")
    add(ELDRYTCH_SHIELD, (side * (x_tip_base + 0.18 * s_tip), WING_Y + 0.06, z_tip + 0.04), q_tip, 1.45,
        note="wing tip trim")
    add(SPEAR, (side * (x_tip_base + 0.45), WING_Y + 0.65, z_tip - 0.02), (1, 0, 0, 0), 0.68, note="wingtip pitot tube")
    tips[side] = x_tip_base + 0.605 * s_tip


# ==============================================================================
# 5. SCULPTED EMPENNAGE / TAIL ASSEMBLY (y = -6.95 .. -4.50)
# ==============================================================================
TAIL_Y = -6.25
for side in (1, -1):
    rz = 90 if side > 0 else -90
    add_wing_surface(BORELEAN_SHIELD, side, 0.18, TAIL_Y + 0.12, ZC + 0.26, 1.55, 0.0, 0.0, "tailplane inboard")
    s_tp = 1.95
    add(KITE_SHIELD, (side * (1.15 + 0.242 * s_tp), TAIL_Y, ZC + 0.24), q_axis((0, 0, 1), rz), s_tp,
        note="tailplane tip")
    add(ELDRYTCH_SHIELD, (side * (1.05 + 0.20 * s_tp), TAIL_Y - 0.18, ZC + 0.27), q_axis((0, 0, 1), rz), 1.45,
        note="elevator trim")
    add(STAFF, (side * 0.85, TAIL_Y + 0.05, ZC - 0.02),
        q_of(q_axis((0, 0, 1), -90 * side), q_axis((0, 1, 0), -18 * side)), 0.72, note="tailplane brace strut")

# Tall Vertical Fin, Dorsal Fillet Strake & Rudder
# Fin orientation matrix: rest -y (point) -> +z (up), face -> side, rest x -> -y (chord along fuselage)
M_FIN = np.array([[0, 0, 1], [-1, 0, 0], [0, -1, 0]], dtype=float)
FIN_BASE_Q = quat_from_matrix(M_FIN)

# Forward dorsal fin fillet strake (long point buried forward inside the dorsal spine at -78 deg)
add(KITE_SHIELD, (0, TAIL_Y - 0.32, ZC + 0.58), q_of(FIN_BASE_Q, q_axis((1, 0, 0), -78)), 2.15,
    note="dorsal fin strake")
# Main vertical stabilizer fin (swept 14 deg)
add(KITE_SHIELD, (0, TAIL_Y - 0.05, ZC + 0.42), q_of(FIN_BASE_Q, q_axis((1, 0, 0), -14)), 2.55,
    note="vertical fin main")
# Rudder post & armored rudder surface
add(BORELEAN_SHIELD, (0, TAIL_Y - 0.42, ZC + 0.52), q_of(FIN_BASE_Q, q_axis((1, 0, 0), -8)), 2.15,
    note="rudder surface")
add(ELDRYTCH_SHIELD, (0, TAIL_Y - 0.52, ZC + 0.88), q_of(FIN_BASE_Q, q_axis((1, 0, 0), -6)), 1.55,
    note="rudder trim tab")
# Ventral tailfin keel & carrier arrestor tailhook
add(KITE_SHIELD, (0, TAIL_Y + 0.15, ZC - 0.05), q_of(FIN_BASE_Q, q_axis((1, 0, 0), -155)), 1.15,
    note="ventral tail bumper")
add(SPEAR, (0, TAIL_Y - 0.35, ZC - 0.22), q_axis((1, 0, 0), 22), 0.72, note="carrier arrestor hook")

# Twin Radio Antenna Masts (anchored solidly into dorsal spine & fin)
add(SPEAR, (0, -2.05, ZC + 1.05), q_of(q_axis((1, 0, 0), 90), q_axis((1, 0, 0), -14)), 0.78,
    note="forward dorsal radio mast")
add(SPEAR, (0, TAIL_Y - 0.15, ZC + 1.45), q_of(q_axis((1, 0, 0), 90), q_axis((1, 0, 0), -14)), 0.52,
    note="fin tip antenna")


# ==============================================================================
# 6. ELABORATE ARMAMENT (15 weapons in exact profile order 0..14)
# ==============================================================================
weapons = []   # {kind, muzzle, ...}

# --- Weapons 0..5: 6 Heavy Wing Autocannons / Gearknight Crossbow Batteries ---
GUN_XS = (2.55, 3.20, 3.85)
GUN_Y = WING_Y + 0.76
GEAR_CBOW_Q = q_axis((0, 0, 1), 180)   # Gear Crossbow shoots toward -y in rest pose -> +y forward
COMP_CBOW_Q = q_axis((0, 0, 1), -90)   # Composite Crossbow shoots toward -x in rest pose -> +y forward
for side in (-1, 1):
    for gx in (GUN_XS if side > 0 else GUN_XS[::-1]):
        wi = len(weapons)
        gz = wing_z_at(gx) + 0.04
        # Gearknight mechanical crossbow housing projecting menacingly from the wing leading edge
        add(GEAR_CROSSBOW, (side * gx, GUN_Y, gz), GEAR_CBOW_Q, 1.05, note=f"gun {wi} gearknight housing")
        # Long composite crossbow barrel fairing projecting forward
        add(CROSSBOW, (side * gx, GUN_Y + 0.22, gz + 0.02), COMP_CBOW_Q, 0.78, note=f"gun {wi} barrel")
        weapons.append({"kind": 1, "muzzle": [round(side * gx, 4), round(GUN_Y + 0.74, 4), round(gz + 0.02, 4)]})

# --- Weapons 6..11: 6 Underwing HVAR Lightning Rocket Rails ---
RAIL_XS = (4.45, 5.10, 5.75)
RAIL_Y = WING_Y - 0.05
WAND_S = 2.05
for side in (-1, 1):
    for rx in (RAIL_XS if side > 0 else RAIL_XS[::-1]):
        wi = len(weapons)
        rz_wing = wing_z_at(rx)
        zz = rz_wing - 0.24
        # Static underwing rocket launch pylon (stays on wing when rocket fires)
        add(KITE_SHIELD, (side * rx, RAIL_Y - 0.05, rz_wing - 0.10),
            q_of(FIN_BASE_Q, q_axis((1, 0, 0), 180)), 0.58, role=0, note=f"rail {wi} pylon")
        # Ordnance rocket assembly (Wand crystal warhead + Spear rocket motor body)
        ord_role = 4 | (wi << 16)
        add(WAND, (side * rx, RAIL_Y, zz), (1, 0, 0, 0), WAND_S, role=ord_role, note=f"lightning rail {wi} (wand)")
        add(SPEAR, (side * rx, RAIL_Y + 0.15, zz + 0.01), (1, 0, 0, 0), 0.58, role=ord_role,
            note=f"lightning rail {wi} body")
        weapons.append({"kind": 2, "muzzle": [round(side * rx, 4), round(RAIL_Y + 0.51 * WAND_S + 0.30, 4), round(zz, 4)]})


def heavy_bomb(xc, yc, zc, s, wi, note):
    """Multi-part Gearknight finned bomb (all parts tagged with ordnance role 4 | (wi << 16))."""
    ord_role = 4 | (wi << 16)
    add(STEEL_KEG, (xc, yc - 0.38 * s, zc), ROT_FWD, s, role=ord_role, note=note + " body")
    add(AMBER_KEG, (xc, yc - 0.68 * s, zc), ROT_FWD, 0.82 * s, role=ord_role, note=note + " aft cone")
    add(ROUND_SHIELD, (xc, yc + 0.42 * s, zc), ROT_FWD, 0.88 * s, role=ord_role, note=note + " nose dome")
    add(GEAR_SHIELD, (xc, yc + 0.36 * s, zc), ROT_FWD, 0.85 * s, role=ord_role, note=note + " fuse ring")
    add(GEAR_SHIELD, (xc, yc - 0.42 * s, zc), ROT_FWD, 0.92 * s, role=ord_role, note=note + " tail ring")
    fs = 0.48 * s
    for k in range(4):
        add(KITE_SHIELD, (xc, yc - 0.48 * s, zc),
            q_of(q_axis((1, 0, 0), -90), q_axis((0, 0, 1), 180), q_axis((0, 1, 0), 45 + 90 * k)),
            fs, role=ord_role, note=note + " fin")


# --- Weapon 12: 2,000 lb Centreline Blockbuster Bomb ---
wi = len(weapons)
BOMB_CL_Y = 0.35
BOMB_CL_Z = ZC - 1.38
for side in (-1, 1):
    add(STAFF, (side * 0.26, BOMB_CL_Y, ZC - 0.82),
        q_of(q_axis((1, 0, 0), 90), q_axis((0, 1, 0), 22 * side)), 0.42, role=0, note="centreline bomb sway brace")
heavy_bomb(0.0, BOMB_CL_Y, BOMB_CL_Z, 1.26, wi, "2000 lb bomb (centreline)")
weapons.append({"kind": 3, "muzzle": [0.0, BOMB_CL_Y, round(BOMB_CL_Z, 4)], "lb": 2000})

# --- Weapons 13, 14: Two 1,000 lb Wing Bombs ---
for side in (-1, 1):
    wi = len(weapons)
    bx = side * 1.68
    by = 0.42
    bz = WING_Z - 0.56
    add(KITE_SHIELD, (bx, by - 0.10, WING_Z - 0.16),
        q_of(FIN_BASE_Q, q_axis((1, 0, 0), 180)), 0.82, role=0, note=f"wing bomb {wi} pylon")
    heavy_bomb(bx, by, bz, 0.98, wi, "1000 lb bomb (wing)")
    weapons.append({"kind": 3, "muzzle": [round(bx, 4), by, round(bz, 4)], "lb": 1000})


# ==============================================================================
# 7. HEAVY RETRACTABLE LANDING GEAR (role=2; max gear Y = MAIN_Y = 1.20)
# ==============================================================================
GEAR_PITCH = 11.0
MAIN_Y = 1.20
WHEEL_S = 1.42
WHEEL_Z = 0.47   # radius = 0.33 * 1.42 = 0.4686 -> bottom rests right at z = 0.00
for side in (-1, 1):
    wx = side * 2.05
    add(ROUND_SHIELD, (wx, MAIN_Y, WHEEL_Z), q_axis((0, 1, 0), 90 * side), WHEEL_S, role=2, note="main wheel outer")
    add(ROUND_SHIELD, (wx - side * 0.10, MAIN_Y, WHEEL_Z), q_axis((0, 1, 0), -90 * side), WHEEL_S, role=2,
        note="main wheel inner")
    add(GEAR_SHIELD, (wx + side * 0.04, MAIN_Y, WHEEL_Z), q_axis((0, 1, 0), 90 * side), 0.96, role=2,
        note="main wheel gearknight hub")
    add(STAFF, (side * 1.96, MAIN_Y, WHEEL_Z + 1.22),
        q_of(q_axis((1, 0, 0), 90), q_axis((0, 1, 0), 4 * side)), 1.02, role=2, note="main oleo strut")
    add(STAFF, (side * 1.72, MAIN_Y - 0.38, WHEEL_Z + 1.05),
        q_of(q_axis((1, 0, 0), 68), q_axis((0, 1, 0), -18 * side)), 0.82, role=2, note="main gear diagonal brace")
    add(KITE_SHIELD, (side * 2.18, MAIN_Y - 0.04, WHEEL_Z + 0.92),
        q_of(q_axis((0, 1, 0), 90 * side), q_axis((1, 0, 0), 90)), 1.38, role=2, note="main gear door")

# Tail wheel assembly (positioned so when pitched nose-up by GEAR_PITCH=11 deg around MAIN_Y, tailwheel touches z=0)
TAIL_WHEEL_Y = TAIL_Y + 0.35
d_tail = MAIN_Y - TAIL_WHEEL_Y
tz = d_tail * math.tan(math.radians(GEAR_PITCH))
TAIL_WHEEL_S = 0.72
TAIL_WHEEL_R = 0.33 * TAIL_WHEEL_S
add(ROUND_SHIELD, (0.06, TAIL_WHEEL_Y, tz + TAIL_WHEEL_R + 0.02), q_axis((0, 1, 0), 90), TAIL_WHEEL_S, role=2,
    note="tail wheel")
add(GEAR_SHIELD, (0.09, TAIL_WHEEL_Y, tz + TAIL_WHEEL_R + 0.02), q_axis((0, 1, 0), 90), 0.48, role=2,
    note="tail wheel hub")
add(STAFF, (0.0, TAIL_WHEEL_Y, tz + TAIL_WHEEL_R + 0.72), q_axis((1, 0, 0), 90), 0.56, role=2, note="tail gear strut")

out = {
    "parts": parts,
    "weapons": weapons,
    "seat": SEAT,
    "hub": list(HUB),
    "gearPitch": GEAR_PITCH,
    "mainY": MAIN_Y,
    "span": [round(-tips[-1], 4), round(tips[1], 4)],
    "zc": ZC,
}

if __name__ == "__main__":
    json.dump(out, open(sys.argv[1] if len(sys.argv) > 1 else "hellcat.json", "w"), indent=1)
    print(len(parts), "parts;", len(weapons), "weapons; span", round(tips[1] * 2, 2), "m; seat", [round(v, 2) for v in SEAT])
