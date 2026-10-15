#!/usr/bin/env python3
"""poi-kit/area.py — what is around a world point, from the offline world kit (Dereth tour expansion, 2026-10-15).

usage: python3 area.py <x> <y> [radius=250] [--map] [--cell=24] [--statics=40]
  x y      AC world metres (wx = lbX*192 + localX; map coords: wx = (EW + 101.95) * 240, wy = (NS + 101.95) * 240,
           S/W negative)
  --map    ASCII terrain/obstacle map around the point (one char per --cell metres; default 12 m)
Prints: landblocks + region/town/architecture/terrain summary; terrain z range and water share; every building
(type, origin, floor..top z, stories, distance); statics grouped by model (count, ontology category, tags, nearest
positions, top z); outdoor non-creature spawns (portals, life stones, fountains, braziers…); gazetteer entries
(teleports) within the radius.
"""
import json, math, os, sys, collections

K = os.path.dirname(os.path.abspath(__file__))
GAZ = "/mnt/wbterminal2/film-projects/_gazetteer/film_gazetteer.jsonl"
a = [x for x in sys.argv[1:] if not x.startswith("--")]
opt = {x.split("=")[0]: (x.split("=")[1] if "=" in x else True) for x in sys.argv[1:] if x.startswith("--")}
X, Y = float(a[0]), float(a[1])
R = float(a[2]) if len(a) > 2 else 250.0
NST = int(opt.get("--statics", 40))
cache = {}


def lbw(lx, ly):
    k = "0x%02X%02X" % (lx, ly)
    if k not in cache:
        f = f"{K}/world/{k}.json"
        cache[k] = json.load(open(f)) if os.path.exists(f) else None
    return cache[k]


def split(gx, gy):
    m = lambda v: v & 0xFFFFFFFF
    s32 = lambda v: v - (1 << 32) if v & 0x80000000 else v
    a_ = s32(m(gx * 214614067 + 1813693831))
    b_ = s32(m(gx * 1109124029))
    return (m(gy * a_ - b_ - 1369149221)) * 2.3283064e-10 >= 0.5


def gz(x, y):
    lx, ly = int(x // 192), int(y // 192)
    w = lbw(lx, ly)
    if not w:
        return None
    cx, cy = (x - lx * 192) / 24, (y - ly * 192) / 24
    ix, iy = min(int(cx), 7), min(int(cy), 7)
    fx, fy = cx - ix, cy - iy
    g = w["h"]
    sw, se, nw, ne = g[ix][iy], g[ix + 1][iy], g[ix][iy + 1], g[ix + 1][iy + 1]
    if split(lx * 8 + ix, ly * 8 + iy):
        return sw + fx * (se - sw) + fy * (ne - se) if fx > fy else sw + fx * (ne - nw) + fy * (nw - sw)
    return sw + fx * (se - sw) + fy * (nw - sw) if fx + fy <= 1 else ne + (1 - fx) * (nw - ne) + (1 - fy) * (se - ne)


def tt(x, y):
    lx, ly = int(x // 192), int(y // 192)
    w = lbw(lx, ly)
    if not w:
        return None
    return w["tt"][min(8, round((x - lx * 192) / 24))][min(8, round((y - ly * 192) / 24))]


lbs = [(lx, ly) for lx in range(int((X - R) // 192), int((X + R) // 192) + 1) for ly in range(int((Y - R) // 192), int((Y + R) // 192) + 1)]
d = lambda p: math.hypot(p[0] - X, p[1] - Y)
NS, EW = Y / 240 - 101.95, X / 240 - 101.95
print(f"== area ({X:.1f}, {Y:.1f}) r={R:.0f} m  map {abs(NS):.2f}{'N' if NS >= 0 else 'S'} {abs(EW):.2f}{'E' if EW >= 0 else 'W'}  ground z {gz(X, Y)}")
water = collections.Counter(); n = 0; zs = []
for lx, ly in lbs:
    w = lbw(lx, ly)
    if not w:
        print(f"  LB 0x{lx:02X}{ly:02X}: NOT IN KIT")
        continue
    s = w.get("summary") or {}
    print(f"  LB {w['lb']} ({lx},{ly}) {s.get('town') or ''} | {s.get('region')} | arch {s.get('arch')} | {s.get('terrain')} z {s.get('zRange')} | {s.get('types')}")
    for i in range(9):
        for j in range(9):
            px, py = lx * 192 + i * 24, ly * 192 + j * 24
            if math.hypot(px - X, py - Y) <= R:
                n += 1; zs.append(w["h"][i][j])
                t = w["tt"][i][j]
                if 16 <= t <= 20: water[{16: "river", 17: "lake", 18: "sea", 19: "sea", 20: "deep sea"}[t]] += 1
if zs:
    print(f"  terrain z {min(zs)}..{max(zs)} within r; water vertices {dict(water)} of {n}")
print("-- buildings (structures with footprints)")
B = []
for lx, ly in lbs:
    w = lbw(lx, ly)
    for s in (w or {}).get("structs", []):
        if d(s["origin"]) <= R:
            B.append((d(s["origin"]), w["lb"], s))
for dd, lb, s in sorted(B, key=lambda z: z[0]):
    print(f"   {dd:6.0f} m  {lb}#{s['i']} {s['m']} {s['type']} @({s['origin'][0]:.1f},{s['origin'][1]:.1f}) floor {s['z0']} top {s['z1']} roof {s.get('roof')} fp {len(s.get('fp') or [])} pts")
print("-- statics by model (count, category, tags; nearest positions; top z)")
G = collections.defaultdict(list)
for lx, ly in lbs:
    w = lbw(lx, ly)
    for o in (w or {}).get("statics", []):
        if d(o["p"]) <= R:
            G[o["m"]].append((d(o["p"]), w["lb"], o))
for m, os_ in sorted(G.items(), key=lambda kv: (min(z[0] for z in kv[1])))[:NST]:
    os_.sort(key=lambda z: z[0])
    o = os_[0][2]
    size = [round(o["hi"][k] - o["lo"][k], 1) for k in range(3)]
    pts = " ".join(f"({z[2]['p'][0]:.1f},{z[2]['p'][1]:.1f},{z[2]['p'][2]:.1f})" for z in os_[:4])
    wn = sorted({z[2].get("weenie") for z in os_ if z[2].get("weenie")})
    print(f"   {m} x{len(os_)} {o.get('cat')} size~{size} top {max(z[2]['hi'][2] for z in os_):.1f} [{','.join(o.get('tags') or [])}]{' weenie ' + ','.join(wn) if wn else ''} nearest {os_[0][0]:.0f} m: {pts}{' …' if len(os_) > 4 else ''}")
if len(G) > NST:
    print(f"   … {len(G) - NST} more models (raise --statics)")
print("-- outdoor spawns (non-creature)")
S = collections.Counter(); SP = {}
for lx, ly in lbs:
    w = lbw(lx, ly)
    for e in (w or {}).get("spawns", []):
        if e.get("cat") == "Creature" or d(e["p"]) > R or e["name"] in ("Door", "Chest", "Place Holder Object"):
            continue
        S[e["name"]] += 1
        if e["name"] not in SP or d(e["p"]) < d(SP[e["name"]]):
            SP[e["name"]] = e["p"]
for k, c in S.most_common(60):
    p = SP[k]
    print(f"   {k} x{c} nearest @({p[0]:.1f},{p[1]:.1f},{p[2]}) {d(p):.0f} m")
cr = collections.Counter(e["name"] for lx, ly in lbs for e in (lbw(lx, ly) or {}).get("spawns", []) if e.get("cat") == "Creature" and d(e["p"]) <= R)
if cr:
    print("   creatures:", ", ".join(f"{k} x{c}" for k, c in cr.most_common(12)))
print("-- gazetteer within r (id | kind | best teleport | pos)")
for l in open(GAZ):
    g = json.loads(l)
    if g.get("pos") and not g.get("indoor") and d(g["pos"]) <= R:
        print(f"   {d(g['pos']):5.0f} m  {g['id']} | {g['kind']} | {g['teleport'].get('best')} | {[round(v, 1) for v in g['pos']]}")
if opt.get("--map"):
    cell = float(opt.get("--cell", 12))
    half = int(R // cell)
    zc = gz(X, Y) or 0
    occ = {}
    for lx, ly in lbs:
        w = lbw(lx, ly)
        if not w:
            continue
        for s in w["structs"]:
            for q in s.get("fp") or []:
                occ[(round((q[0] - X) / cell), round((q[1] - Y) / cell))] = "B"
            occ[(round((s["origin"][0] - X) / cell), round((s["origin"][1] - Y) / cell))] = "B"
        for o in w["statics"]:
            k = (round((o["p"][0] - X) / cell), round((o["p"][1] - Y) / cell))
            if k not in occ and max(o["hi"][0] - o["lo"][0], o["hi"][1] - o["lo"][1]) > 1.5:
                occ[k] = "o"
        for o in w["scenery"]:
            if o["set"] != "default" or o["hi"][2] - o["lo"][2] < 2:
                continue
            k = (round((o["p"][0] - X) / cell), round((o["p"][1] - Y) / cell))
            if k not in occ:
                occ[k] = "t"
        for e in w["spawns"]:
            if e.get("cat") == "Creature" or e["name"] in ("Door", "Chest"):
                continue
            occ[(round((e["p"][0] - X) / cell), round((e["p"][1] - Y) / cell))] = "*"
    print(f"-- map: north up, {cell:g} m/char, centre '@' z {zc:.0f}; digits = (ground z - centre z)/10 m (0-9, '-' lower, '+' >9 higher); ~ water; B building; o static; t tree (default bake); * spawn/FX")
    for j in range(half, -half - 1, -1):
        row = []
        for i in range(-half, half + 1):
            if i == 0 and j == 0:
                row.append("@"); continue
            k = occ.get((i, j))
            if k:
                row.append(k); continue
            x, y = X + i * cell, Y + j * cell
            t = tt(x, y)
            if t is not None and 16 <= t <= 20:
                row.append("~"); continue
            g = gz(x, y)
            if g is None:
                row.append(" "); continue
            v = (g - zc) / 10
            row.append("-" if v < -0.5 else "+" if v > 9.5 else str(int(round(v))))
        print("   " + "".join(row))
