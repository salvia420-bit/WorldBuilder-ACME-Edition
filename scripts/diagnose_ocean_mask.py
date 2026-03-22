"""
diagnose_ocean_mask.py
======================
Samples specific known-inland pixel regions and reports which rule in
is_ocean() fires for them. Helps diagnose why inland features are being
marked as ocean in the mask.

Usage:
  python scripts/diagnose_ocean_mask.py
"""
import colorsys
from PIL import Image

INPUT = "screenshots/world_map.png"

# Known inland coordinates to test (x, y pixel coords, description)
TEST_POINTS = [
    # Known passable land
    (1540, 1275, "Swamp/Blackmire  LB(192,95)"),
    (1550,  840, "Impassable water LB(194,149)"),
    # Sample a broad grid of the interior landmass
    ( 800,  800, "Interior grid (800,800)"),
    ( 900,  900, "Interior grid (900,900)"),
    (1000, 1000, "Interior grid (1000,1000)"),
    (1100, 1100, "Interior grid (1100,1100)"),
    (1200,  600, "Interior grid (1200,600)"),
    ( 600, 1200, "Interior grid (600,1200)"),
    (1300,  900, "Interior grid (1300,900)"),
    ( 700, 1400, "Interior grid (700,1400)"),
    # Mountain-ish regions (usually greyer)
    (1050,  500, "Possible mountain (1050,500)"),
    ( 500,  500, "Possible mountain (500,500)"),
    (1400,  400, "Possible mountain (1400,400)"),
    # River-ish areas
    ( 900,  700, "River area (900,700)"),
    (1150,  850, "River area (1150,850)"),
]

OCEAN_R, OCEAN_G, OCEAN_B, OCEAN_TOL = 59, 33, 29, 8
IW_R, IW_G, IW_B, IW_TOL = 54, 60, 29, 10
COASTAL_HUE_LO, COASTAL_HUE_HI = 170 / 360.0, 250 / 360.0
COASTAL_SAT_MAX, COASTAL_BRI_MAX = 0.45, 0.75

def why_ocean(r, g, b):
    """Returns the rule name that fires, or None if not ocean."""
    if abs(r-OCEAN_R)<=OCEAN_TOL and abs(g-OCEAN_G)<=OCEAN_TOL and abs(b-OCEAN_B)<=OCEAN_TOL:
        return "OCEAN_COLOR (#3B211D)"
    if abs(r-IW_R)<=IW_TOL and abs(g-IW_G)<=IW_TOL and abs(b-IW_B)<=IW_TOL:
        return "IMPASSABLE_WATER (#363C1D)"
    if r < 20 and g < 20 and b < 20:
        return "PURE_BLACK"
    rf, gf, bf = r/255.0, g/255.0, b/255.0
    h, s, v = colorsys.rgb_to_hsv(rf, gf, bf)
    hue_deg = h * 360
    if COASTAL_HUE_LO <= h <= COASTAL_HUE_HI and s < COASTAL_SAT_MAX and v < COASTAL_BRI_MAX:
        return f"COASTAL_GREY (H={hue_deg:.0f}° S={s:.2f} B={v:.2f})"
    return None

img = Image.open(INPUT).convert("RGB")
px  = img.load()

print(f"{'Coord':<20} {'RGB':<20} {'Hex':<10} {'H°':>6} {'S':>6} {'B':>6}  Result")
print("-" * 90)

for x, y, label in TEST_POINTS:
    r, g, b = px[x, y]
    rf, gf, bf = r/255.0, g/255.0, b/255.0
    h, s, v = colorsys.rgb_to_hsv(rf, gf, bf)
    rule = why_ocean(r, g, b)
    result = f"OCEAN ({rule})" if rule else "land"
    print(f"({x:4},{y:4}) {label:<20}  ({r:3},{g:3},{b:3})  #{r:02X}{g:02X}{b:02X}  "
          f"{h*360:6.1f} {s:6.2f} {v:6.2f}  {result}")

# Also scan a 50x50 block in the centre of the landmass and count misfires
print("\n--- Centre-mass scan 950-1050, 950-1050 ---")
rule_counter = {}
land_count = 0
for x in range(950, 1050):
    for y in range(950, 1050):
        r, g, b = px[x, y]
        rule = why_ocean(r, g, b)
        if rule:
            key = rule.split(" ")[0]
            rule_counter[key] = rule_counter.get(key, 0) + 1
        else:
            land_count += 1
total = 100*100
print(f"  Land pixels   : {land_count} / {total}")
for k, v in sorted(rule_counter.items(), key=lambda x: -x[1]):
    print(f"  {k:<30}: {v}")
