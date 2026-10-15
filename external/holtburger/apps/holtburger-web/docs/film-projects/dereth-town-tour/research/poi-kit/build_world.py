#!/usr/bin/env python3
"""Build the offline world kit for the Dereth tour expansion (2026-10-15).

Inputs: WBT dumps wbt/dump1.out (POI 3x3s), wbt/dump2.out (town 3x3s) = describe-landblock(includeFootprints) +
list-objects + get-terrain-data per landblock; wbt/dump3.out = get-object-detail per model; the served dist's
default procedural scenery and the opt-in retail scenery bakes, and its ACE outdoor spawns.
Output: world/0xXXYY.json per landblock:
  {lb, lbX, lbY, h[9][9] (terrain z, index [gx][gy]), tt[9][9] (terrain type), road[9][9],
   statics:[{i, m, p, yaw, lo, hi, cat, tags}], structs:[{i, m, type, fp, z0, z1, stories}],
   scenery:[{m, p, lo, hi, set}], spawns:[{name, wcid, p, cat}], summary:{...}}
and world/_index.json. Pure offline after the dumps.
"""
import json, math, os, glob, collections

K = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.expanduser("~/hb-serve/dist/current")
TAGS = json.load(open("/home/wbterminal/WorldBuilder-ACME-Edition/WorldBuilder/Data/object-tags.json", encoding="utf-8-sig"))
os.makedirs(f"{K}/world", exist_ok=True)

det = {}
for l in open(f"{K}/wbt/dump3.out"):
    d = json.loads(l)
    if d.get("command") == "get-object-detail" and d.get("found"):
        det[d["objectId"]] = d

by = collections.defaultdict(dict)
for f in ("dump1.out", "dump2.out"):
    for l in open(f"{K}/wbt/{f}"):
        d = json.loads(l)
        c = d.get("command")
        if c in ("describe-landblock", "list-objects", "get-terrain-data") and d.get("success", True) and d.get("found", True) is not False:
            lb = d.get("landblock")
            if lb:
                by[lb.upper().replace("0X", "0x")][c] = d


def yaw_of(q):
    return 2 * math.atan2(q["z"], q["w"])


def rot_aabb(p, q, s, bmin, bmax):
    w, x, y, z = q["w"], q["x"], q["y"], q["z"]
    lo, hi = [1e18] * 3, [-1e18] * 3
    for cx in (bmin[0] * s["x"], bmax[0] * s["x"]):
        for cy in (bmin[1] * s["y"], bmax[1] * s["y"]):
            for cz in (bmin[2] * s["z"], bmax[2] * s["z"]):
                tx, ty, tz = 2 * (y * cz - z * cy), 2 * (z * cx - x * cz), 2 * (x * cy - y * cx)
                r = (cx + w * tx + (y * tz - z * ty), cy + w * ty + (z * tx - x * tz), cz + w * tz + (x * ty - y * tx))
                for i in range(3):
                    lo[i] = min(lo[i], r[i] + p[i]); hi[i] = max(hi[i], r[i] + p[i])
    return [round(v, 2) for v in lo], [round(v, 2) for v in hi]


index = {}
for lb, parts in sorted(by.items()):
    t = parts.get("get-terrain-data")
    if not t:
        continue
    lbX, lbY = t["lbX"], t["lbY"]
    ox, oy = lbX * 192, lbY * 192
    h = [[None] * 9 for _ in range(9)]
    tt = [[None] * 9 for _ in range(9)]
    rd = [[0] * 9 for _ in range(9)]
    for v in t["vertices"]:
        h[v["gridX"]][v["gridY"]] = v["heightWorld"]
        tt[v["gridX"]][v["gridY"]] = v["terrainType"]
        rd[v["gridX"]][v["gridY"]] = v["road"]
    W = {"lb": lb, "lbX": lbX, "lbY": lbY, "h": h, "tt": tt, "road": rd, "statics": [], "structs": [], "scenery": [], "spawns": []}
    lo_ = parts.get("list-objects")
    for o in (lo_ or {}).get("objects", []):
        d = det.get(o["modelId"])
        p = [o["x"], o["y"], o["z"]]
        if d:
            lo, hi = rot_aabb(p, o["orientation"], o["scale"], d["boundsMin"], d["boundsMax"])
        else:
            lo, hi = [p[0] - 6, p[1] - 6, p[2]], [p[0] + 6, p[1] + 6, p[2] + 12]
        tags = TAGS.get(o["modelId"][2:].upper(), [])
        W["statics"].append({"i": o["index"], "m": o["modelId"], "p": [round(v, 2) for v in p],
                             "yaw": round(math.degrees(yaw_of(o["orientation"])), 1), "lo": lo, "hi": hi,
                             "cat": d.get("ontologyCategory") if d else None, "known": bool(d),
                             "tags": tags[:10] if isinstance(tags, list) else []})
    desc = parts.get("describe-landblock")
    named = {}
    if desc:
        body = desc.get("body", {})
        for n in body.get("namedObjects", []):
            named[n["index"]] = n.get("weenieName")
        for s in body.get("structures", []):
            fp = [[q["x"], q["y"]] for q in (s.get("footprintWorld") or [])]
            W["structs"].append({"i": s["index"], "m": s["modelId"], "type": s.get("typeDescription"), "origin": [s["origin"]["x"], s["origin"]["y"], s["origin"]["z"]],
                                 "fp": fp, "z0": s.get("floorZ"), "z1": s.get("topZ"), "stories": s.get("stories"), "roof": s.get("roofShape"), "name": s.get("nameHint")})
        for sp in body.get("spawns", []):
            if (sp.get("cell") or 0) >= 0x100:
                continue
            W["spawns"].append({"name": sp["name"], "wcid": sp["wcid"], "cat": sp.get("category"), "p": [round(ox + sp["x"], 2), round(oy + sp["y"], 2), sp["z"]]})
        ctx = desc.get("context", {})
        ter = desc.get("terrain", {})
        W["summary"] = {"town": ctx.get("townName"), "region": ctx.get("regionName"), "culture": ctx.get("culture"),
                        "arch": ctx.get("dominantArchitecture"), "terrain": ter.get("summary"),
                        "zRange": [ter.get("heightMin"), ter.get("heightMax")],
                        "types": [(x["name"], x["share"]) for x in ctx.get("dominantTerrainTypes", [])][:6],
                        "pois": [p_["title"] for p_ in ctx.get("knownPois", [])][:40]}
    for s in W["statics"]:
        if s["i"] in named:
            s["weenie"] = named[s["i"]]
    for bake in ("scenery", "scenery-retail"):
        p = f"{DIST}/{bake}/{lb}.scenery.jsonl"
        if not os.path.exists(p):
            continue
        for l in open(p):
            if not l.strip():
                continue
            r = json.loads(l)
            W["scenery"].append({"m": r.get("obj_id"), "set": "default" if bake == "scenery" else "retail",
                                 "p": [round(ox + r["x"], 2), round(oy + r["y"], 2), round(r["z"], 2)],
                                 "lo": [round(ox + r["aabb_min_x"], 2), round(oy + r["aabb_min_y"], 2), round(r["aabb_min_z"], 2)],
                                 "hi": [round(ox + r["aabb_max_x"], 2), round(oy + r["aabb_max_y"], 2), round(r["aabb_max_z"], 2)]})
    # ACE spawns from the dist bake when describe-landblock had none (FX / non-creature only)
    p = f"{DIST}/spawns/{lb}.spawns.jsonl"
    if os.path.exists(p) and not W["spawns"]:
        for l in open(p):
            r = json.loads(l)
            if r.get("cell") and r["cell"] >= 0x100:
                continue
            W["spawns"].append({"name": r["name"], "wcid": r["wcid"], "cat": r.get("category"), "p": [round(ox + r["x"], 2), round(oy + r["y"], 2), r["z"]]})
    json.dump(W, open(f"{K}/world/{lb}.json", "w"), separators=(",", ":"))
    index[lb] = {"lbX": lbX, "lbY": lbY, "statics": len(W["statics"]), "structs": len(W["structs"]), "scenery": len(W["scenery"]), "spawns": len(W["spawns"]), "described": bool(desc)}
json.dump(index, open(f"{K}/world/_index.json", "w"), indent=0)
print(len(index), "landblocks;", sum(v["structs"] for v in index.values()), "structures;", sum(v["statics"] for v in index.values()), "statics;", sum(v["scenery"] for v in index.values()), "scenery")
