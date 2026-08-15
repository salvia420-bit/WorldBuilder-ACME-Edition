#!/usr/bin/env python3
"""pilot.py -- Holtburg pilot batch: texture-driven 4x displacement of the
building GfxObjs used by the 7x7-LB window around 0xA9B4, emitted as OBJs for
WBT obj-import (overwrite + preservePhysics + gfxObjOnly).

Stages (run in order):
  python3 pilot.py enumerate   -> models.json (buildings resolved to GfxObj ids + gate routing)
  python3 pilot.py build       -> obj/0x????????.obj + imports.jsonl
  (then run WBT with imports.jsonl + export, see run_import.sh it writes)
"""
import json
import os
import struct
import sys

import numpy as np

sys.path.insert(0, "/mnt/wbterminal2/dpc-work")
import datlib          # noqa: E402
import gfxlib          # noqa: E402
import pipeline        # noqa: E402
import relief3d        # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
CELL = os.path.join(HERE, "proj/dats/base/client_cell_1.dat")
OBJD = os.path.join(HERE, "obj")
# 7x7 tile window centred on the T4 anchor's landblock 0xA9B4 (Holtburg).
WINDOW = [(x << 8) | y for x in range(0xA6, 0xAD) for y in range(0xB1, 0xB8)]

MULT = 4.0
FINE_BUDGET = 220_000    # max fine-mesh faces before decimation (RAM/time guard)

# ---------------------------------------------------------------- recipe C
# Starkness ladder arm C, promoted to production (HANDOFF 2026-08-15 TODO #2):
#   * wall-class surfaces carve at 0.20 m ABOVE plinth height, de-rated to
#     ~0.11 m at ground level -- at a flat 0.20 m a wall overhangs its footing
#     and the collision divergence doubles the design bound (LADDER.md 3c);
#   * sculpted shading normals, gain 2.5 (retail lights from STORED normals, so
#     this is free contrast);
#   * the 4x triangle budget is unchanged.
WALL_CLASSES = {"Brick", "Stone", "Plank", "Timber"}
AMP_WALL = 0.20          # metres, at/above plinth height
GROUND_SCALE = 0.55      # 0.55 * 0.20 = 0.11 m at ground level (spec 0.10-0.12)
PLINTH_LO = 0.45         # ramp start, metres above the record's lowest vertex
PLINTH_HI = 0.75         # ramp end
NORMAL_GAIN = 2.5
# Minimum outward shell displacement.  The importer now carries every ORIGINAL
# polygon verbatim (portal-filler quads + drawing-BSP PORT nodes are
# load-bearing), so the OBJ ships ONLY the displaced shell for carving polys;
# the floor keeps the shell off the coplanar original underneath (z-fighting).
FLOOR_M = 0.006


# ---------------------------------------------------------------- LBInfo
def parse_lbinfo(data):
    """Port of ACE LandblockInfo.Unpack: id, numCells, objects, buildings."""
    r = datlib.R(data)
    _id = r.u32()
    num_cells = r.u32()
    n_obj = r.u32()
    objects = []
    for _ in range(n_obj):
        oid = r.u32()
        origin = r.vec3()
        quat = r.quat()
        objects.append((oid, origin, quat))
    n_bld = struct.unpack_from("<H", data, r.o)[0]
    r.o += 2
    _packmask = struct.unpack_from("<H", data, r.o)[0]
    r.o += 2
    buildings = []
    for _ in range(n_bld):
        mid = r.u32()
        origin = r.vec3()
        quat = r.quat()
        _leaves = r.u32()
        n_port = r.u32()
        for _ in range(n_port):
            _flags, _ocell, _oportal, n_stab = struct.unpack_from("<4H", data, r.o)
            r.o += 8
            r.o += 2 * n_stab
            r.align()
        buildings.append((mid, origin, quat))
    return dict(numCells=num_cells, objects=objects, buildings=buildings)


def resolve_gfx(mid, P):
    """modelId (0x01 GfxObj or 0x02 Setup) -> list of GfxObj ids."""
    if (mid >> 24) == 0x01:
        return [mid]
    if (mid >> 24) == 0x02:
        s = datlib.parse_setup(P.dat.get(mid))
        return list(dict.fromkeys(s["parts"]))
    return []


def enumerate_models():
    cd = datlib.Dat(CELL)
    P = pipeline.P
    building_models = {}     # modelId -> instance count
    per_lb = {}
    for lb in WINDOW:
        rid = (lb << 16) | 0xFFFE
        if rid not in cd.files:
            continue
        info = parse_lbinfo(cd.get(rid))
        per_lb["%04X" % lb] = dict(buildings=len(info["buildings"]),
                                   objects=len(info["objects"]))
        for mid, _o, _q in info["buildings"]:
            building_models[mid] = building_models.get(mid, 0) + 1
    gids = {}                # gid -> {models: [modelId...], instances: n}
    for mid, cnt in building_models.items():
        for gid in resolve_gfx(mid, P):
            e = gids.setdefault(gid, dict(models=[], instances=0))
            e["models"].append("0x%08X" % mid)
            e["instances"] += cnt

    # gate routing per gid
    out = {}
    for gid in sorted(gids):
        try:
            src, metas, rec = pipeline.gfx_source(gid)
        except Exception as ex:
            out["0x%08X" % gid] = dict(route="error", why=str(ex)[:200],
                                       **gids[gid])
            continue
        n0 = src.tri_count()
        carve_sids = sorted("0x%08X" % s for s, m in metas.items()
                            if m.get("h") is not None and m.get("amp", 0) > 0)
        carving_polys = sum(1 for p in src.polys
                            if p.get("h") is not None and p.get("amp", 0) > 0
                            and not p.get("excluded") and not p.get("invisible"))
        route = "displace" if (carve_sids and carving_polys) else "skip"
        why = ("%d/%d surfaces carve" % (len(carve_sids), len(metas))
               if route == "displace" else
               "gate refused all surfaces (" +
               ", ".join(sorted({m["cls"] for m in metas.values()})) + ")")
        out["0x%08X" % gid] = dict(
            route=route, why=why, tris=n0, carvingPolys=carving_polys,
            carveSurfaces=carve_sids,
            surfaces={"0x%08X" % s: dict(cls=m["cls"], amp=m.get("amp", 0),
                                         op=m.get("op"), carved=round(m.get("carved", 0), 3))
                      for s, m in metas.items()},
            zeroNormals=src.substituted_normals, **gids[gid])
    js = dict(window="A6-AC x B1-B7 (7x7 around 0xA9B4)", perLb=per_lb,
              buildingModels={"0x%08X" % k: v for k, v in building_models.items()},
              gfxObjs=out)
    with open(os.path.join(HERE, "models.json"), "w") as f:
        json.dump(js, f, indent=1)
    n_d = sum(1 for e in out.values() if e["route"] == "displace")
    n_s = sum(1 for e in out.values() if e["route"] == "skip")
    print("window LBs with LBInfo:", len(per_lb),
          "| building models:", len(building_models),
          "| distinct GfxObjs:", len(out),
          "| displace:", n_d, "| skip:", n_s)


# ---------------------------------------------------------------- OBJ out
def fmt(x):
    return "%.9g" % (x if abs(x) > 1e-12 else 0.0)


class Pool:
    def __init__(self):
        self.d = {}
        self.rows = []

    def add(self, row):
        k = tuple(np.round(row, 9))
        i = self.d.get(k)
        if i is None:
            i = len(self.rows) + 1     # OBJ is 1-based
            self.d[k] = i
            self.rows.append(row)
        return i


def write_obj(path, gid, res, src):
    """Displaced mesh + passthrough invisible polys + reversed passes for
    two-sided source polys. Faces grouped by surface DID (usemtl)."""
    vp, tp, npo = Pool(), Pool(), Pool()
    by_surf = {}     # sid -> list of (vi, ti, ni) triplets (len-3 lists)

    V, F, UV, NR, poly = res["V"], res["F"], res["UV"], res["NR"], res["poly"]
    for fi in range(len(F)):
        sp = src.polys[poly[fi]]
        sid = sp["surf"]
        tri = []
        for c in range(3):
            vi = vp.add(np.asarray(V[F[fi][c]], float))
            ti = tp.add(np.asarray(UV[fi][c], float))
            ni = npo.add(np.asarray(NR[fi][c], float))
            tri.append((vi, ti, ni))
        by_surf.setdefault(sid, []).append(tri)
        if sp["sides"] == 1:   # CullMode.None: emit the reversed pass too
            rev = []
            for c in (0, 2, 1):
                vi = vp.add(np.asarray(V[F[fi][c]], float))
                ti = tp.add(np.asarray(UV[fi][c], float))
                ni = npo.add(-np.asarray(NR[fi][c], float))
                rev.append((vi, ti, ni))
            by_surf.setdefault(sid, []).append(rev)

    # NOTE: invisible NoPos filler quads are NOT re-emitted.  The importer
    # carries every original polygon (fillers included, flags intact) plus the
    # original drawing BSP verbatim; the OBJ is the displaced shell only.
    # (An earlier revision re-emitted them as drawn triangles, which lost the
    # NoPos flag and turned door/window openings into white quads.)
    with open(path, "w") as f:
        f.write("# dat-patch pilot displaced mesh for 0x%08X\n" % gid)
        for r in vp.rows:
            f.write("v %s %s %s\n" % (fmt(r[0]), fmt(r[1]), fmt(r[2])))
        for r in tp.rows:
            f.write("vt %s %s\n" % (fmt(r[0]), fmt(r[1])))
        for r in npo.rows:
            n = np.asarray(r, float)
            l = np.linalg.norm(n)
            n = n / l if l > 1e-12 else np.array([0.0, 0.0, 1.0])
            f.write("vn %s %s %s\n" % (fmt(n[0]), fmt(n[1]), fmt(n[2])))
        nfaces = 0
        for sid in sorted(by_surf):
            f.write("usemtl surface_0x%08X\n" % sid)
            for tri in by_surf[sid]:
                f.write("f %d/%d/%d %d/%d/%d %d/%d/%d\n"
                        % tuple(x for c in tri for x in c))
                nfaces += 1
    return nfaces, len(vp.rows)


def recipe_c_source(gid):
    """Arm-C source mesh: wall classes at AMP_WALL, everything else as gated.
    Returns (src, metas, rec, amp_fn) -- amp_fn is the plinth ramp, a pure
    function of POSITION so vertices welded between polygons agree exactly."""
    rec = pipeline.P.gfx(gid)
    metas = pipeline.surface_meta(set(rec["surfaces"]))
    for m in metas.values():
        if m["cls"] in WALL_CLASSES and m.get("h") is not None:
            m["amp"] = AMP_WALL
    src = relief3d.SourceMesh.from_record(rec, metas)
    z0 = min(p[2] for p in src.P) if src.P else 0.0

    def amp_fn(pos):
        t = relief3d.smoothstep01((pos[2] - z0 - PLINTH_LO)
                                  / (PLINTH_HI - PLINTH_LO))
        return GROUND_SCALE + (1.0 - GROUND_SCALE) * t

    return src, metas, rec, amp_fn


def build():
    models = json.load(open(os.path.join(HERE, "models.json")))["gfxObjs"]
    os.makedirs(OBJD, exist_ok=True)
    imports = []
    stats = {}
    for gid_h, e in sorted(models.items()):
        if e["route"] != "displace":
            continue
        gid = int(gid_h, 16)
        src, metas, rec, amp_fn = recipe_c_source(gid)
        n0 = src.tri_count()
        # Shell budget: the importer carries all n0 original tris verbatim, so
        # the shell gets (MULT-1)*n0 and the drawn total lands at MULT*n0.
        target = int(round(n0 * (MULT - 1.0)))
        pipeline.bandlimit(src, metas, target, verbose=False)
        # adaptive segments: keep the fine (carved-only) mesh under FINE_BUDGET
        carve_fans = sum(len(p["v"]) - 2 for p in src.polys
                         if p.get("h") is not None and p.get("amp", 0) > 0
                         and not p.get("excluded") and not p.get("invisible"))
        segs = 16
        while segs > 4 and carve_fans * segs * segs > FINE_BUDGET:
            segs -= 2
        old_max = relief3d.MAX_AMPLITUDE_M
        relief3d.MAX_AMPLITUDE_M = max(old_max, AMP_WALL)
        try:
            res = pipeline.run(src, segments=segs, mult=MULT,
                               target_tris=target, carved_only=True,
                               floor_m=FLOOR_M, verbose=False,
                               normal_gain=NORMAL_GAIN, amp_fn=amp_fn)
        finally:
            relief3d.MAX_AMPLITUDE_M = old_max
        objp = os.path.join(OBJD, "%s.obj" % gid_h)
        nf, nv = write_obj(objp, gid, res, src)
        # surfaceDid: required arg; any resolvable surface. Use the record's first.
        sdid = rec["surfaces"][0]
        imports.append(dict(command="obj-import", objPath=objp,
                            surfaceDid="0x%08X" % sdid, gfxObjId=gid_h,
                            overwrite=True, preservePhysics=True,
                            gfxObjOnly=True))
        shell = int(len(res["F"]))
        stats[gid_h] = dict(srcTris=n0, objFaces=nf, objVerts=nv, segments=segs,
                            shellTris=shell, totalTris=n0 + shell,
                            mult=round((n0 + shell) / max(n0, 1), 3))
        print("%s  %4d src + %4d shell = %4d drawn (%.2fx)  segs=%d  obj %d faces"
              % (gid_h, n0, shell, n0 + shell, (n0 + shell) / max(n0, 1), segs, nf))
    with open(os.path.join(HERE, "imports.jsonl"), "w") as f:
        for c in imports:
            f.write(json.dumps(c) + "\n")
        f.write(json.dumps(dict(command="export",
                                directory=os.path.join(HERE, "export"))) + "\n")
    with open(os.path.join(HERE, "build_stats.json"), "w") as f:
        json.dump(stats, f, indent=1)
    print("imports.jsonl:", len(imports), "models")


if __name__ == "__main__":
    {"enumerate": enumerate_models, "build": build}[sys.argv[1]]()
