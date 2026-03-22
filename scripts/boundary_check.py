"""
Sample a grid of pixels around the reported boundary to see exactly
where flood-fill is bleeding and what colors are at the transition.
"""
import colorsys
from PIL import Image

img = Image.open("pipeline_data/screenshots/world_map.png").convert("RGB")
mask = Image.open("pipeline_data/screenshots/ocean_mask.png").convert("L")
px = img.load()
mx = mask.load()

OCEAN_R, OCEAN_G, OCEAN_B, OCEAN_TOL = 59, 33, 29, 8

print("Sampling grid around (560,475) passable -> (570,480) impassable")
print(f"{'(x,y)':<12} {'RGB':<18} {'Hex':<10} {'H°':>6} {'S':>6} {'B':>6}  {'Mask':<6} OceanDist  MatchOcean?")
print("-" * 105)

for y in range(470, 490):
    for x in range(555, 580):
        r, g, b = px[x, y]
        rf, gf, bf = r/255.0, g/255.0, b/255.0
        h, s, v = colorsys.rgb_to_hsv(rf, gf, bf)
        m = mx[x, y]
        mask_label = "LAND" if m > 128 else "OCEAN"
        
        # Euclidean distance from ocean color
        dist = ((r-OCEAN_R)**2 + (g-OCEAN_G)**2 + (b-OCEAN_B)**2) ** 0.5
        
        matches = (abs(r-OCEAN_R) <= OCEAN_TOL and 
                   abs(g-OCEAN_G) <= OCEAN_TOL and 
                   abs(b-OCEAN_B) <= OCEAN_TOL)
        
        # Only print pixels near the boundary or the specific ones mentioned
        if (x in (560, 570) and y in (475, 480)) or (555 <= x <= 575 and 473 <= y <= 483):
            marker = ""
            if x == 560 and y == 475: marker = " ← PASSABLE (user)"
            if x == 570 and y == 480: marker = " ← IMPASSABLE (user)"
            print(f"({x:3},{y:3})  ({r:3},{g:3},{b:3})  #{r:02X}{g:02X}{b:02X}  "
                  f"{h*360:6.1f} {s:6.2f} {v:6.2f}  {mask_label:<6} {dist:6.1f}      {'YES' if matches else 'no'}{marker}")

# Also check: what tolerance would correctly classify (560,475) as land?
print("\n--- Tolerance analysis for pixel (560,475) ---")
r, g, b = px[560, 475]
print(f"  Color: ({r},{g},{b}) = #{r:02X}{g:02X}{b:02X}")
print(f"  dR={abs(r-OCEAN_R)}, dG={abs(g-OCEAN_G)}, dB={abs(b-OCEAN_B)}")
print(f"  Max component delta: {max(abs(r-OCEAN_R), abs(g-OCEAN_G), abs(b-OCEAN_B))}")
print(f"  Current tolerance: ±{OCEAN_TOL}")
print(f"  Would need tolerance ≤ {max(abs(r-OCEAN_R), abs(g-OCEAN_G), abs(b-OCEAN_B)) - 1} to exclude this pixel")

r2, g2, b2 = px[570, 480]
print(f"\n--- For pixel (570,480) ---")
print(f"  Color: ({r2},{g2},{b2}) = #{r2:02X}{g2:02X}{b2:02X}")
print(f"  dR={abs(r2-OCEAN_R)}, dG={abs(g2-OCEAN_G)}, dB={abs(b2-OCEAN_B)}")
print(f"  Max component delta: {max(abs(r2-OCEAN_R), abs(g2-OCEAN_G), abs(b2-OCEAN_B))}")
