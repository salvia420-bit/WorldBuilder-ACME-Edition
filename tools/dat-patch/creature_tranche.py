#!/usr/bin/env python3
"""creature_tranche.py -- Phase-4 4.P4 creature-part SUBDIV driver (POC).

Drives the EXISTING relief3d silhouette ops (pn_tessellate / facet_op) over one
creature part GfxObj and emits an obj-import job that patches ONLY the drawn
shell of that part (gfxObjOnly + preservePhysics + overwrite) into a SCRATCH
portal copy.  It edits no core lane file: relief3d, pilot, pipeline, gfxlib are
imported as black boxes exactly the way tranche.py drives them.

Key differences from the building/static tranche (research 1c/1d):
  * orientation="off" -- the floor-sink veto is a walkable-surface guard; a
    creature part in its authored space has no world "up", and the player never
    stands on a creature, so the veto would silently delete up-facing shell for
    no benefit.  Pass "off" to SourceMesh.from_record.
  * the op is a SILHOUETTE op, not wall-texture displacement.  Creature limbs
    are organic curves the texture gate refuses, so we tessellate the silhouette:
    pn_tessellate (curved, crack-free PN triangles) by default, facet_op as the
    documented fallback when PN is a visual no-op on flat-shaded parts.
  * the degrade band0-not-self guard runs on the PART (mirrors tranche's guard).

Nothing about physics changes: gfxObjOnly keeps the record identity (same 0x01
id -> every Setup part slot / Animation part index resolves unchanged) and
preservePhysics re-appends the original physics polys + physics BSP verbatim.
The Setup (0x02) record is never opened, so CylSpheres/Spheres/Height/Radius are
structurally untouched.

Usage (workdir gets obj/ + imports.jsonl):
  DATPATCH_PORTAL=/home/wbterminal/ac_base_dats/client_portal.dat \
  python3 creature_tranche.py build --gid 0x01002C00 --workdir <dir> \
          [--op pn|facet] [--level 2]
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pilot           # noqa: E402  (write_obj reused verbatim)
import pipeline        # noqa: E402
import relief3d        # noqa: E402

# BULGE GUARD (2026-08-21, the "big heads" regression).  PN tessellation
# trusts the AUTHORED normals; on silhouette-convex / coarse creature parts
# (Lich head 0x010007EE: 59 tris, X-span 0.187) those normals fan far off the
# facet planes, so the cubic patches balloon OUTWARD past the authored
# silhouette (shipped head X-span 0.398 = 2.1x).  204 of the 1,657 scaled-out
# parts did this.  Guard: if the PN result grows the drawn bbox by more than
# BULGE_TOL on any axis, fall back to facet_op (planar, edge-preserving --
# silhouette exact by construction); if even facet exceeds the tolerance,
# refuse the part entirely (SystemExit -> scale-out logs it as a skip).
BULGE_TOL = 0.10


def _bbox_spans(pts):
    """[(x,y,z)...] -> (xspan, yspan, zspan); (0,0,0) when empty."""
    if len(pts) == 0:
        return (0.0, 0.0, 0.0)
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    zs = [p[2] for p in pts]
    return (max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs))


def bulge_axes(src, V, tol=BULGE_TOL):
    """Axes on which the op result V grows the source drawn bbox by > tol.

    Compares against the bbox of the vertices actually used by VISIBLE source
    polys (the drawn shell -- what the player sees), mirroring the regression
    analysis that flagged the 204 bulged parts.  Returns a list like
    ['x0.398/0.187'] -- empty means the silhouette is preserved."""
    used = set()
    for poly in src.polys:
        if not poly.get("invisible"):
            used.update(poly["v"])
    s0 = _bbox_spans([src.P[i] for i in sorted(used)])
    s1 = _bbox_spans([tuple(p) for p in V])
    out = []
    for ax, a0, a1 in zip("xyz", s0, s1):
        if a1 > a0 * (1.0 + tol) + 1e-6:
            out.append("%s%.4f/%.4f" % (ax, a1, a0))
    return out


def subdiv_part(gid, op="pn", level=2):
    """Return (res, src, rec, metas, stats).  res is the pilot.write_obj dict."""
    P = pipeline.P
    # belt-and-braces degrade guard (research 1c; mirrors tranche._build_one)
    bands = P.degrade(gid)
    if bands and bands[0]["id"] != gid:
        raise SystemExit("DEGRADE GUARD: 0x%08X band0 is 0x%08X, not self -- "
                         "refusing to patch an invisible root mesh"
                         % (gid, bands[0]["id"]))
    rec = P.gfx(gid)
    sids = set(rec["surfaces"])
    metas = pipeline.surface_meta(sids)
    # orientation="off": no floor-sink veto for a creature part (research 1d)
    src = relief3d.SourceMesh.from_record(rec, metas, orientation="off")
    n0 = src.tri_count()
    pn_bulge, fell_back = [], False
    if op == "pn":
        V, F, UV, NR, PO = relief3d.pn_tessellate(src, level=level)
        pn_bulge = bulge_axes(src, V)
        if pn_bulge:
            # PN ballooned the silhouette -> planar fallback (see BULGE_TOL)
            fell_back = True
            op = "facet"
            V, F, UV, NR, PO = relief3d.facet_op(src, rounds=max(1, level))
    elif op == "facet":
        V, F, UV, NR, PO = relief3d.facet_op(src, rounds=max(1, level))
    else:
        raise SystemExit("--op must be pn|facet")
    final_bulge = bulge_axes(src, V)
    if final_bulge:
        raise SystemExit("BULGE GUARD: 0x%08X %s op grows drawn bbox > %d%% on "
                         "%s -- refusing (silhouette would visibly balloon)"
                         % (gid, op, int(BULGE_TOL * 100), final_bulge))
    res = dict(V=V, F=F, UV=UV, NR=NR, poly=PO)
    stats = dict(gfxObj="0x%08X" % gid, op=op, level=level, srcTris=n0,
                 pnBulgeAxes=pn_bulge, pnFellBackToFacet=fell_back,
                 drawnTris=int(len(F)), mult=round(len(F) / max(n0, 1), 3),
                 surfaces=len(sids), degradeBands=len(bands),
                 degradeBand0Self=bool(bands),
                 zeroNormalsSubstituted=src.substituted_normals,
                 orientationGate=src.orientation_gate.get("mode"))
    return res, src, rec, metas, stats


def build(gid, workdir, op="pn", level=2):
    objd = os.path.join(workdir, "obj")
    os.makedirs(objd, exist_ok=True)
    res, src, rec, metas, stats = subdiv_part(gid, op, level)
    gid_h = "0x%08X" % gid
    objp = os.path.join(objd, "%s.obj" % gid_h)
    nf, nv = pilot.write_obj(objp, gid, res, src)
    stats["objFaces"] = nf
    stats["objVerts"] = nv
    sdid = rec["surfaces"][0]
    imports = [dict(command="obj-import", objPath=objp,
                    surfaceDid="0x%08X" % sdid, gfxObjId=gid_h,
                    overwrite=True, preservePhysics=True, gfxObjOnly=True)]
    exportd = os.path.join(workdir, "export")
    os.makedirs(exportd, exist_ok=True)
    imports.append(dict(command="export", directory=exportd))
    with open(os.path.join(workdir, "imports.jsonl"), "w") as f:
        for c in imports:
            f.write(json.dumps(c) + "\n")
    with open(os.path.join(workdir, "build_stats.json"), "w") as f:
        json.dump(stats, f, indent=1)
    print("[creature_tranche] %s  op=%s  src=%d -> drawn=%d (%.2fx)  obj=%d faces"
          % (gid_h, op, stats["srcTris"], stats["drawnTris"], stats["mult"], nf))
    print("[creature_tranche] orientationGate=%s zeroNormalsSubst=%d degradeBands=%d(band0self=%s)"
          % (stats["orientationGate"], stats["zeroNormalsSubstituted"],
             stats["degradeBands"], stats["degradeBand0Self"]))
    print("[creature_tranche] wrote", os.path.join(workdir, "imports.jsonl"))
    return stats


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build")
    b.add_argument("--gid", required=True)
    b.add_argument("--workdir", required=True)
    b.add_argument("--op", default="pn", choices=["pn", "facet"])
    b.add_argument("--level", type=int, default=2)
    args = ap.parse_args()
    if args.cmd == "build":
        build(int(args.gid, 16), args.workdir, args.op, args.level)


if __name__ == "__main__":
    main()
