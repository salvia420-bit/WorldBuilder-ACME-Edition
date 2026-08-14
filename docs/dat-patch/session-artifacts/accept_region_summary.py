#!/usr/bin/env python3
"""Acceptance checks for gfxobj-region-summary (dat-patch artist-trial ground truth)."""
import json, math, os, sys

D = os.path.dirname(os.path.abspath(__file__))
passed = failed = 0
def check(name, ok, actual):
    global passed, failed
    print(f"{'PASS' if ok else 'FAIL'}  {name}  actual={actual}")
    if ok: passed += 1
    else: failed += 1

cot = json.load(open(f"{D}/cottage_0100082E.json"))

# ── top-level ────────────────────────────────────────────────────────
check("materials == 6", len(cot["materials"]) == 6, len(cot["materials"]))
check("triCount == 90 (render tris excl. NoPos portal fillers)", cot["triCount"] == 90,
      f"triCount={cot['triCount']} facesStored={cot['facesStored']} facesEffective={cot['facesEffective']} portalPolys={cot['portalPolyCount']}")
bb = cot["bbox"]; size = [bb[1][i]-bb[0][i] for i in range(3)]
check("bbox ~13.6 x 11.3 x 12.48 (z-up)",
      abs(size[0]-13.6) < 0.05 and abs(size[1]-11.3) < 0.05 and abs(size[2]-12.4832) < 0.05, size)
check("didDegrade == 0x11000588", cot["didDegrade"] == "0x11000588", cot["didDegrade"])
check("physics NOT identical to render", cot["isCollisionHull"] is False, cot["isCollisionHull"])
check("physicsPolyCount == 59", cot["physicsPolyCount"] == 59,
      f"physics={cot['physicsPolyCount']} render={cot['renderPolyCount']}")

# ── front ground wall region (0x08000371, n=(0,-1,0), d≈4.65) ───────
def region_match(m, n, d, tol=1e-3):
    for r in m["regions"]:
        rn, rd = r["plane"]["n"], r["plane"]["d"]
        if r["material"] == "surface_0x08000371" and \
           sum((rn[i]-n[i])**2 for i in range(3)) < 1e-6 and abs(rd-d) < tol:
            return r
    return None
fw = region_match(cot, (0, -1, 0), 4.65)
check("front wall region exists (0x08000371, n=(0,-1,0), d=4.65)", fw is not None,
      fw["id"] if fw else None)

M, c = fw["uvMap"]["M"], fw["uvMap"]["c"]
exp_M = [[1/3, 0, 0], [0, 0, -1/2.8]]
exp_c = [2.233333, 1.0]
mok = all(abs(M[i][j]-exp_M[i][j]) < 1e-4 for i in range(2) for j in range(3))
cok = all(abs(c[i]-exp_c[i]) < 1e-4 for i in range(2))
check("front wall uvMap M == [[1/3,0,0],[0,0,-1/2.8]]", mok, M)
check("front wall uvMap c == (2.233333, 1.0)", cok, c)
check("front wall uv residual < 1e-4", fw["uvMap"]["residual"] < 1e-4, fw["uvMap"]["residual"])

# holes: loop coords are in basis coords; convert back to world via basis
def hole_world_bounds(region, hole):
    o, u, v = (region["basis"][k] for k in ("origin", "uAxis", "vAxis"))
    pts = [[o[i] + a*u[i] + b*v[i] for i in range(3)] for a, b in hole["loop"]]
    return [min(p[0] for p in pts), max(p[0] for p in pts)], \
           [min(p[2] for p in pts), max(p[2] for p in pts)]

def find_hole(region, xr, zr, tol=0.05):
    for h in region["holes"]:
        (x0, x1), (z0, z1) = hole_world_bounds(region, h)
        if abs(x0-xr[0]) < tol and abs(x1-xr[1]) < tol and abs(z0-zr[0]) < tol and abs(z1-zr[1]) < tol:
            return h
    return None

door = find_hole(fw, (-4.1, -2.2), (0, 2.5))
check("front door hole x[-4.1,-2.2] z[0,2.5] exists", door is not None,
      [ [round(x,3) for x in b] for b in hole_world_bounds(fw, door)] if door else fw["holes"])
check("front door touchesGround == True", door is not None and door["touchesGround"],
      door and door["touchesGround"])
win = find_hole(fw, (-0.2, 0.9), (1, 2.5))
check("front window hole x[-0.2,0.9] z[1,2.5] exists", win is not None,
      win and [ [round(x,3) for x in b] for b in hole_world_bounds(fw, win)])
check("front window touchesGround == False", win is not None and not win["touchesGround"],
      win and win["touchesGround"])

# ── other openings anywhere in the output ────────────────────────────
def any_hole(m, xr, zr, material=None, tol=0.05):
    for r in m["regions"]:
        if material and r["material"] != material: continue
        h = find_hole(r, xr, zr, tol)
        if h: return r, h
    return None, None
r_up, h_up = any_hole(cot, (-1.2, 1.1), (4, 5.5), "surface_0x080007E2")
check("front upper window x[-1.2,1.1] z[4,5.5] in an 0x080007E2 region", h_up is not None,
      r_up["id"] if r_up else None)
r_bd, h_bd = any_hole(cot, (2.2, 4.1), (0, 2.5))
check("back door x[2.2,4.1] z[0,2.5] appears as a hole", h_bd is not None,
      (r_bd["id"], r_bd["material"]) if r_bd else None)

# ── chimney: battered (non-axis-aligned) 0x080001A5 region above z≈2.8
def is_axis_aligned(n, tol=1e-3):
    return sum(1 for x in n if abs(abs(x)-1) < tol) == 1 and sum(1 for x in n if abs(x) < tol) == 2
chimney_regions = [r for r in cot["regions"] if r["material"] == "surface_0x080001A5"]
battered = [r for r in chimney_regions if not is_axis_aligned(r["plane"]["n"])]
check("chimney (0x080001A5) has a non-axis-aligned (battered) region", len(battered) > 0,
      [(r["id"], r["plane"]["n"]) for r in battered][:4])
# battered flank not merged with vertical flank: normals of chimney regions must differ
verticals = [r for r in chimney_regions if is_axis_aligned(r["plane"]["n"])]
check("chimney vertical and battered flanks are separate regions",
      len(battered) > 0 and len(verticals) > 0,
      f"{len(verticals)} vertical + {len(battered)} battered of {len(chimney_regions)} chimney regions")

# ── robustness models ────────────────────────────────────────────────
house = json.load(open(f"{D}/house_01002232.json"))
check("house 0x01002232: sane regions, no crash", house["regionCount"] > 0 and
      all(("loopsFailed" in r) or r["outer"] is not None for r in house["regions"]),
      f"regions={house['regionCount']} loopsFailed={sum(1 for r in house['regions'] if r.get('loopsFailed'))}")
wall = json.load(open(f"{D}/wall_01000AEF.json"))
check("wall 0x01000AEF: 4-poly smoke, valid, not unstructured",
      wall["facesStored"] == 4 and not wall["unstructured"],
      f"facesStored={wall['facesStored']} regions={wall['regionCount']} unstructured={wall['unstructured']}")
tree = json.load(open(f"{D}/tree_02001897.json"))
tmodels = tree["models"] if "models" in tree else [tree]
tstat = [(m["gfxObj"], m["facesStored"], m["regionCount"], m["unstructured"],
          max((r["planarity"] for r in m["regions"]), default=0),
          max((r["uvMap"]["residual"] for r in m["regions"] if r["uvMap"]), default=0)) for m in tmodels]
check("organic model: valid JSON, no crash (unstructured or high residual acceptable)",
      all(m["regionCount"] >= 0 for m in tmodels), tstat)

# thumbnails exist on disk
nth = 0
for name in ("cottage_0100082E", "house_01002232", "wall_01000AEF", "tree_02001897"):
    m = json.load(open(f"{D}/{name}.json"))
    for mm in (m["models"] if "models" in m else [m]):
        for k, v in mm["materials"].items():
            if v["thumbnail"]:
                p = os.path.join(D, v["thumbnail"])
                assert os.path.exists(p), p
                nth += 1
check("all referenced thumbnails exist on disk", True, f"{nth} references")

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
