#!/usr/bin/env python3
"""gen-outdoor-run-plans.py — precompute obstacle-free run corridors per outdoor POI.

For battery-outdoor-run.mjs (the 5-min-run stress battery): for every outdoor
@telepoi destination, find the compass heading whose straight-line corridor is
clear of water, steep terrain (mountains), map edges and placed statics
(buildings) for as far as possible, plus a "clear start" point far enough from
town structures that a held-W run starts unimpeded.

Terrain truth comes from WorldBuilder.Terminal — but fetched per-LANDBLOCK
(get-terrain-data: all 81 vertices' heightWorld/terrainType/road in one call)
and sampled locally, replicating CommandEngine.GetHeight exactly:
  * height  = TerrainAlgorithms.SampleHeightTriangle (triangle-interpolated,
    retail IsSWtoNEcut split magic, uint32 wraparound arithmetic);
  * terrainType/road = nearest vertex (WorldToVertex: C# Math.Round =
    round-half-even = Python round(), clamped 0..8).
That turns ~5,000 per-point get-height round-trips per POI into ~200 cached
per-LB fetches (~20x fewer WBT calls; LB cache persists across POIs). One
deliberate difference: a landblock with NO terrain data is treated as a
blocker here (get-height would report success with height 0).
Statics come from list-objects (per-LB placed statics from LandBlockInfo —
buildings; procedural scenery like trees is NOT in LBI, the run driver's
stuck-guard handles those at runtime).

Usage:
  python3 gen-outdoor-run-plans.py \
    --pois-json poi-destinations.json \
    --wbproj /home/wbterminal/projects/RetailSmoke/RetailSmoke.wbproj \
    --out outdoor-run-plans.json

poi-destinations.json rows come from ace_world:
  SELECT p.name, pos.obj_Cell_Id, pos.origin_X/Y/Z, pos.angles_W/X/Y/Z
  FROM points_of_interest p
  JOIN weenie_properties_position pos
    ON pos.object_Id = p.weenie_Class_Id AND pos.position_Type = 2
(outdoor = (cell & 0xFFFF) < 0x100).

Heading/quat convention (ACE Position.Rotate): facing unit dir (dx,dy) is a
rotation about Z by atan2(-dx, dy); for compass heading θ (radians clockwise
from north, dir = (sinθ, cosθ)) the @teleloc quat is
  qw = cos(θ/2), qx = 0, qy = 0, qz = -sin(θ/2).
"""
import argparse
import json
import math
import subprocess
import sys

LB_M = 192.0
WATER_TYPES = {16, 17, 18, 19, 20}   # WaterRunning..WaterDeepSea (TerrainType)
MAX_CORRIDOR_M = 2200.0              # ~5 min at ~7 m/s; driver ping-pongs if shorter
COARSE_STEP_M = 24.0
FINE_STEP_M = 8.0
N_HEADINGS = 32
TOP_K = 6                            # headings that get the statics pass
GRADE_BLOCK = 0.85                   # dz/dxy between samples that counts as a wall
STATIC_CLEAR_M = 10.0                # corridor half-width vs placed statics
START_CLEAR_M = 25.0                 # clear-start: no static within this radius
START_MIN_M = 40.0                   # clear-start at least this far along the ray
START_MAX_M = 400.0
MIN_CORRIDOR_M = 250.0               # below this the plan is marked unusable
END_MARGIN_M = 50.0                  # back the corridor end off the first blocker


class Wbt:
    """Lockstep JSON-per-line client for WorldBuilder.Terminal --stdin."""

    def __init__(self, dll, wbproj):
        self.proc = subprocess.Popen(
            ["dotnet", dll, "--stdin", "-p", wbproj],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, bufsize=1,
            env={"DOTNET_ROLL_FORWARD": "LatestMajor", "PATH": "/home/wbterminal/.local/bin:/usr/local/bin:/usr/bin:/bin",
                 "HOME": "/home/wbterminal"})
        self.calls = 0

    def ask(self, obj, expect_command):
        self.proc.stdin.write(json.dumps(obj) + "\n")
        self.proc.stdin.flush()
        self.calls += 1
        # Skip banner/pre-load lines; every command response echoes "command".
        while True:
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError(f"WBT died (after {self.calls} calls)")
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            if r.get("command") == expect_command:
                return r

    def close(self):
        try:
            self.proc.stdin.close()
            self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()


def _sw_to_ne_cut(gcx, gcy):
    """TerrainAlgorithms.IsSWtoNEcut — retail split-direction magic, replicated
    with explicit uint32 wraparound (C# unchecked int arithmetic)."""
    magic_a = (gcx * 214614067 + 1813693831) & 0xFFFFFFFF
    magic_b = (gcx * 1109124029) & 0xFFFFFFFF
    split = (gcy * magic_a - magic_b - 1369149221) & 0xFFFFFFFF
    return split * 2.3283064e-10 >= 0.5


class TerrainOracle:
    """Per-LANDBLOCK cache over get-terrain-data + local sampling that
    replicates CommandEngine.GetHeight (see module docstring). ~20x fewer WBT
    round-trips than per-point get-height; caches persist across POIs."""

    def __init__(self, wbt):
        self.wbt = wbt
        self.lbcache = {}    # (lbX, lbY) -> None | {"h": [81], "t": [81], "r": [81]}
        self.objcache = {}   # (lbX, lbY) -> [(worldX, worldY)]

    def _lb(self, lb_x, lb_y):
        key = (lb_x, lb_y)
        if key not in self.lbcache:
            r = self.wbt.ask({"command": "get-terrain-data", "lbX": lb_x, "lbY": lb_y},
                             "get-terrain-data")
            if not (r.get("success") and r.get("found")):
                self.lbcache[key] = None
            else:
                h, t, rd = [0.0] * 81, [0] * 81, [0] * 81
                for v in r["vertices"]:
                    i = v["index"]  # == gridX*9 + gridY (TerrainAlgorithms.GetHeightFromData)
                    h[i] = v["heightWorld"]; t[i] = v["terrainType"]; rd[i] = v["road"]
                self.lbcache[key] = {"h": h, "t": t, "r": rd}
        return self.lbcache[key]

    def sample(self, x, y):
        """height (triangle-interp) + terrainType/road (nearest vertex) at a
        world point; None = out of bounds / no terrain data (a blocker)."""
        if x < 0 or y < 0:
            return None
        lbx, lby = int(x // LB_M), int(y // LB_M)
        if lbx > 254 or lby > 254:
            return None
        lb = self._lb(lbx, lby)
        if lb is None:
            return None
        lx, ly = x - lbx * LB_M, y - lby * LB_M
        # nearest vertex for type/road (WorldToVertex: Math.Round = round-half-even)
        vx = min(8, max(0, round(lx / 24.0)))
        vy = min(8, max(0, round(ly / 24.0)))
        vi = vx * 9 + vy
        # triangle-interpolated height (SampleHeightTriangle)
        cx, cy = lx / 24.0, ly / 24.0
        ix, iy = min(int(cx), 7), min(int(cy), 7)
        fx, fy = cx - ix, cy - iy
        h = lb["h"]
        h_sw, h_se = h[ix * 9 + iy], h[(ix + 1) * 9 + iy]
        h_nw, h_ne = h[ix * 9 + iy + 1], h[(ix + 1) * 9 + iy + 1]
        if _sw_to_ne_cut(lbx * 8 + ix, lby * 8 + iy):
            if fx > fy:
                hh = h_sw + fx * (h_se - h_sw) + fy * (h_ne - h_se)
            else:
                hh = h_sw + fx * (h_ne - h_nw) + fy * (h_nw - h_sw)
        elif fx + fy <= 1.0:
            hh = h_sw + fx * (h_se - h_sw) + fy * (h_nw - h_sw)
        else:
            hh = h_ne + (1.0 - fx) * (h_nw - h_ne) + (1.0 - fy) * (h_se - h_ne)
        return {"height": hh, "terrainType": lb["t"][vi], "road": lb["r"][vi]}

    def statics(self, lb_x, lb_y):
        key = (lb_x, lb_y)
        if key not in self.objcache:
            r = self.wbt.ask({"command": "list-objects", "lbX": lb_x, "lbY": lb_y}, "list-objects")
            out = []
            if r.get("found"):
                # list-objects returns object origins in WORLD coords already
                # (verified: LB 169,180 -> x≈32523 = 169*192 + 75), NOT
                # landblock-local — do NOT re-add lb_x*192 (that double-add
                # pushed every static ~32 km away, so statics never registered).
                for o in r.get("objects", []):
                    out.append((o["x"], o["y"]))
            self.objcache[key] = out
        return self.objcache[key]


def ray_clear_distance(oracle, x0, y0, theta, step_m, max_m):
    """March the ray; return (clear_m, climb_sum, road_frac) up to first blocker."""
    dx, dy = math.sin(theta), math.cos(theta)
    prev_h = None
    climb = 0.0
    road_hits = 0
    n = 0
    d = step_m
    while d <= max_m:
        x, y = x0 + dx * d, y0 + dy * d
        if not (0 <= x < 255 * LB_M and 0 <= y < 255 * LB_M):
            return d - step_m, climb, (road_hits / n if n else 0.0)
        r = oracle.sample(x, y)
        if r is None or r.get("terrainType") in WATER_TYPES:
            return d - step_m, climb, (road_hits / n if n else 0.0)
        h = r["height"]
        if prev_h is not None:
            grade = abs(h - prev_h) / step_m
            if grade > GRADE_BLOCK:
                return d - step_m, climb, (road_hits / n if n else 0.0)
            climb += max(0.0, h - prev_h)
        prev_h = h
        road_hits += 1 if r.get("road") else 0
        n += 1
        d += step_m
    return max_m, climb, (road_hits / n if n else 0.0)


def statics_along_ray(oracle, x0, y0, theta, length_m):
    """Distance along the ray of the first placed static within STATIC_CLEAR_M
    of the path (None if the whole length is clear), plus per-sample nearest
    static distance for the clear-start search."""
    dx, dy = math.sin(theta), math.cos(theta)
    # collect statics from every LB the corridor touches (pad 1 LB)
    lbs = set()
    d = 0.0
    while d <= length_m:
        lx, ly = int((x0 + dx * d) // LB_M), int((y0 + dy * d) // LB_M)
        for ax in (lx - 1, lx, lx + 1):
            for ay in (ly - 1, ly, ly + 1):
                if 0 <= ax <= 254 and 0 <= ay <= 254:
                    lbs.add((ax, ay))
        d += LB_M
    # Spatial hash: town LBs hold thousands of statics and the naive
    # per-sample min() over all of them was the generator's Python hot spot.
    # Bucket by 32 m cell; a 3x3 neighborhood query is exact for any distance
    # < 32 m, which covers both thresholds we compare against (10 m block,
    # 25 m clear-start) — anything farther reads as "clear" (1e9).
    grid_cell = 32.0
    grid = {}
    for lb in sorted(lbs):
        for (px, py) in oracle.statics(*lb):
            grid.setdefault((int(px // grid_cell), int(py // grid_cell)), []).append((px, py))

    def nearest_static(x, y):
        gx, gy = int(x // grid_cell), int(y // grid_cell)
        nd = 1e9
        for ax in (gx - 1, gx, gx + 1):
            for ay in (gy - 1, gy, gy + 1):
                for (px, py) in grid.get((ax, ay), ()):
                    h = math.hypot(x - px, y - py)
                    if h < nd:
                        nd = h
        return nd

    first_block = None
    near = []  # (d, nearest static dist — exact below 32 m, else 1e9)
    d = 0.0
    while d <= length_m:
        x, y = x0 + dx * d, y0 + dy * d
        nd = nearest_static(x, y)
        near.append((d, nd))
        if first_block is None and nd < STATIC_CLEAR_M:
            first_block = d
        d += FINE_STEP_M
    return first_block, near


def outdoor_cell(x, y):
    lbx, lby = int(x // LB_M), int(y // LB_M)
    cx, cy = int((x - lbx * LB_M) // 24.0), int((y - lby * LB_M) // 24.0)
    return (lbx << 24) | (lby << 16) | (cx * 8 + cy + 1)


def plan_poi(oracle, poi, log):
    cell = poi["cell"]
    lbx, lby = (cell >> 24) & 0xFF, (cell >> 16) & 0xFF
    x0, y0 = lbx * LB_M + poi["x"], lby * LB_M + poi["y"]

    # Phase 1: coarse terrain-only scan of all headings.
    cand = []
    for i in range(N_HEADINGS):
        theta = 2 * math.pi * i / N_HEADINGS
        clear, climb, road = ray_clear_distance(oracle, x0, y0, theta, COARSE_STEP_M, MAX_CORRIDOR_M)
        cand.append({"theta": theta, "clear": clear, "climb": climb, "road": road})
    cand.sort(key=lambda c: (-c["clear"], c["climb"]))

    # Phase 2: statics pass + fine re-march on the top headings.
    best = None
    for c in cand[:TOP_K]:
        clear, climb, road = ray_clear_distance(oracle, x0, y0, c["theta"], FINE_STEP_M, min(c["clear"], MAX_CORRIDOR_M))
        _first_static, near = statics_along_ray(oracle, x0, y0, c["theta"], clear)
        # clear-start FIRST: first fine sample in [START_MIN_M, min(START_MAX_M,
        # clear)] with no static within START_CLEAR_M. Statics BEFORE the start
        # (the town the POI sits in) do NOT count — we @teleloc straight to the
        # clear-start, so the run never traverses them. (Prior bug: a static at
        # d=0, i.e. the POI standing next to a town building, drove usable
        # negative and nuked every otherwise-open corridor.)
        start_d = None
        for (d, nd) in near:
            if d < START_MIN_M or d > min(START_MAX_M, clear):
                continue
            if nd >= START_CLEAR_M:
                start_d = d
                break
        if start_d is None:
            continue
        # First static blocker AT OR BEYOND the clear-start — this is what
        # actually caps the run corridor. Terrain (clear) or that static, minus
        # a margin, is the end.
        block_d = None
        for (d, nd) in near:
            if d >= start_d and nd < STATIC_CLEAR_M:
                block_d = d
                break
        end_d = min(clear, (block_d - STATIC_CLEAR_M) if block_d is not None else clear)
        corridor = max(0.0, end_d - start_d - END_MARGIN_M)
        score = (corridor, -climb)
        if best is None or score > best["score"]:
            best = {"theta": c["theta"], "startD": start_d, "corridor": corridor,
                    "climb": climb, "roadFrac": road, "score": score}
    if best is None or best["corridor"] < MIN_CORRIDOR_M:
        log(f"  !! {poi['name']}: no usable corridor "
            f"(best={best['corridor'] if best else 0:.0f}m) — marked unusable")
        return {"poi": poi["name"], "usable": False,
                "reason": "no corridor >= %dm clear of water/slope/statics" % MIN_CORRIDOR_M,
                "source": poi}

    theta = best["theta"]
    dxu, dyu = math.sin(theta), math.cos(theta)
    sx, sy = x0 + dxu * best["startD"], y0 + dyu * best["startD"]
    hz = oracle.sample(sx, sy)
    ex, ey = x0 + dxu * (best["startD"] + best["corridor"]), y0 + dyu * (best["startD"] + best["corridor"])
    heading_deg = math.degrees(theta) % 360.0
    plan = {
        "poi": poi["name"], "usable": True,
        "headingDeg": round(heading_deg, 1),
        "quat": {"w": round(math.cos(theta / 2), 6), "x": 0, "y": 0,
                 "z": round(-math.sin(theta / 2), 6)},
        "flipQuat": {"w": round(math.cos((theta + math.pi) / 2), 6), "x": 0, "y": 0,
                     "z": round(-math.sin((theta + math.pi) / 2), 6)},
        "clearStart": {
            "cell": f"0x{outdoor_cell(sx, sy):08X}",
            "x": round(sx % LB_M, 3), "y": round(sy % LB_M, 3),
            "z": round((hz["height"] if hz else poi["z"]) + 0.05, 3),
            "worldX": round(sx, 1), "worldY": round(sy, 1),
            "offsetM": round(best["startD"], 1),
        },
        "corridorM": round(best["corridor"], 1),
        "corridorEnd": {"worldX": round(ex, 1), "worldY": round(ey, 1)},
        "climbM": round(best["climb"], 1), "roadFrac": round(best["roadFrac"], 3),
        "source": poi,
    }
    log(f"  {poi['name']}: heading {heading_deg:.0f}° corridor {best['corridor']:.0f}m "
        f"start +{best['startD']:.0f}m climb {best['climb']:.0f}m")
    return plan


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pois-json", required=True)
    ap.add_argument("--wbproj", default="/home/wbterminal/projects/RetailSmoke/RetailSmoke.wbproj")
    ap.add_argument("--dll", default="/home/wbterminal/WorldBuilder-ACME-Edition/WorldBuilder.Terminal/bin/Release/net8.0/WorldBuilder.Terminal.dll")
    ap.add_argument("--out", default="outdoor-run-plans.json")
    ap.add_argument("--only", help="comma-separated POI names (subset run)")
    args = ap.parse_args()

    pois = [p for p in json.load(open(args.pois_json)) if p.get("outdoor")]
    if args.only:
        names = {s.strip().lower() for s in args.only.split(",")}
        pois = [p for p in pois if p["name"].lower() in names]
    log = lambda s: print(s, file=sys.stderr, flush=True)
    log(f"[gen] {len(pois)} outdoor POIs")

    wbt = Wbt(args.dll, args.wbproj)
    oracle = TerrainOracle(wbt)
    plans = []
    try:
        for i, poi in enumerate(pois):
            log(f"[gen] {i + 1}/{len(pois)} {poi['name']} (wbt calls so far: {wbt.calls})")
            plans.append(plan_poi(oracle, poi, log))
    finally:
        wbt.close()

    out = {"generated": None, "params": {
        "maxCorridorM": MAX_CORRIDOR_M, "gradeBlock": GRADE_BLOCK,
        "waterTypes": sorted(WATER_TYPES), "staticClearM": STATIC_CLEAR_M,
        "startClearM": START_CLEAR_M, "minCorridorM": MIN_CORRIDOR_M,
    }, "plans": plans}
    import datetime
    out["generated"] = datetime.datetime.now().isoformat(timespec="seconds")
    json.dump(out, open(args.out, "w"), indent=1)
    usable = sum(1 for p in plans if p.get("usable"))
    log(f"[gen] wrote {args.out}: {usable}/{len(plans)} usable, {wbt.calls} wbt calls")


if __name__ == "__main__":
    main()
