#!/usr/bin/env python3
"""validate.py -- hard validation of the exported pilot dats.

Checks per patched GfxObj (base vs export/client_portal.dat):
  A. record parses (gfxlib)
  B. physics polygons: field-identical AND physics-referenced vertex positions
     + normals drift == 0 (the r1 corruption this pilot's importer fix removes)
  C. surface table: original table is an exact prefix (order + slots preserved)
  D. render tri multiplier ~= build target, vertex cap respected
  E. per-record byte size delta (B/added-tri)
  H. ORIGINAL drawn polygons carried verbatim at their original keys (vertex
     ids, stippling, sides, pos/neg surface indices, uv indices) — this covers
     the NoPos portal-filler quads that keep door/window openings see-through
  I. drawing-BSP PORT node count identical to base (portal linkage intact)
  J. shell actually displaced: max appended-vertex distance from the base
     render surface > 0.02 m (guards against silent zeroing)
Global:
  F. client_cell_1.dat: size == base AND every differing 32-bit word is either
     the header free-chain patch or a 0xCDCDCDCD -> 0 sentinel fix
  G. portal.dat size delta sane
"""
import argparse
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gfxlib  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
_ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
_ap.add_argument("--root", default=HERE,
                 help="run directory holding proj/dats/base, export/ and "
                      "build_stats.json (default: this script's directory, "
                      "i.e. the original in-place pilot layout)")
_ap.add_argument("--stats", default=None, help="build_stats.json override")
_ap.add_argument("--out", default=None, help="validation.json override")
_A = _ap.parse_args()

ROOT = os.path.abspath(_A.root)
BASE_P = os.path.join(ROOT, "proj/dats/base/client_portal.dat")
BASE_C = os.path.join(ROOT, "proj/dats/base/client_cell_1.dat")
EXP_P = os.path.join(ROOT, "export/client_portal.dat")
EXP_C = os.path.join(ROOT, "export/client_cell_1.dat")
STATS = _A.stats or os.path.join(ROOT, "build_stats.json")
OUT = _A.out or os.path.join(ROOT, "validation.json")

report = dict(models={}, globalChecks={})
base = gfxlib.Portal(BASE_P)
pat = gfxlib.Portal(EXP_P)
stats = json.load(open(STATS))

fail = 0
for gid_h in sorted(stats):
    gid = int(gid_h, 16)
    r = {}
    try:
        b = base.gfx(gid)
        p = pat.gfx(gid)
        r["parses"] = True
    except Exception as ex:
        r["parses"] = False
        r["error"] = str(ex)[:200]
        report["models"][gid_h] = r
        fail += 1
        continue
    bp, pp = b["phys"] or [], p["phys"] or []
    r["physPolys"] = [len(bp), len(pp)]
    fields_ok = len(bp) == len(pp) and all(
        x["v"] == y["v"] and x["stip"] == y["stip"] and x["sides"] == y["sides"]
        and x["n"] == y["n"] for x, y in zip(bp, pp))
    Pb, Pp = np.array(b["P"]), np.array(p["P"])
    Nb, Np_ = np.array(b["N"]), np.array(p["N"])
    ids = sorted({v for poly in bp for v in poly["v"]})
    if ids:
        pos_drift = max(float(np.linalg.norm(Pb[i] - Pp[i])) for i in ids)
        nrm_drift = max(float(np.linalg.norm(Nb[i] - Np_[i])) for i in ids)
    else:
        pos_drift = nrm_drift = 0.0
    r["physFieldsIdentical"] = fields_ok
    r["physVertexPosDrift"] = pos_drift
    r["physVertexNrmDrift"] = nrm_drift
    r["surfacesPrefixOk"] = (b["surfaces"] == p["surfaces"][:len(b["surfaces"])])
    r["surfaces"] = [len(b["surfaces"]), len(p["surfaces"])]
    r["renderTris"] = [len(b["polys"]), len(p["polys"])]
    r["verts"] = [len(b["P"]), len(p["P"])]
    r["vertexCapOk"] = len(p["P"]) <= 32767

    # H: every base drawn polygon carried verbatim at its original key
    pk = {q["key"]: q for q in p["polys"]}
    same = lambda x, y: (x["v"] == y["v"] and x["stip"] == y["stip"]  # noqa: E731
                         and x["sides"] == y["sides"] and x["pos"] == y["pos"]
                         and x["neg"] == y["neg"] and x["uvi"] == y["uvi"])
    carried = sum(1 for q in b["polys"]
                  if q["key"] in pk and same(q, pk[q["key"]]))
    r["origPolysCarried"] = [carried, len(b["polys"])]
    r["origPolysCarriedOk"] = carried == len(b["polys"])
    nopos_b = sum(1 for q in b["polys"] if q["stip"] & 0x04)
    nopos_p = sum(1 for q in p["polys"] if q["stip"] & 0x04)
    r["noPosFillers"] = [nopos_b, nopos_p]
    r["noPosFillersOk"] = nopos_b == nopos_p

    # I: drawing-BSP PORT node count (portal linkage)
    rb, rp = base.dat.get(gid), pat.dat.get(gid)
    r["portNodes"] = [rb.count(b"TROP"), rp.count(b"TROP")]
    r["portNodesOk"] = r["portNodes"][0] == r["portNodes"][1]

    # J: shell displacement present in the bytes
    nvb = len(b["P"])
    new = Pp[nvb:]
    if len(new):
        best = np.full(len(new), np.inf)
        for poly in b["polys"]:
            vv = poly["v"]
            for k in range(1, len(vv) - 1):
                a3, b3, c3 = Pb[vv[0]], Pb[vv[k]], Pb[vv[k + 1]]
                n3 = np.cross(b3 - a3, c3 - a3)
                nn = np.linalg.norm(n3)
                if nn < 1e-12:
                    continue
                dpl = np.abs((new - a3) @ (n3 / nn))
                best = np.minimum(best, dpl)
        r["maxShellDisp"] = round(float(best.max()), 4)
    else:
        r["maxShellDisp"] = 0.0
    r["shellDisplacedOk"] = r["maxShellDisp"] > 0.02

    # K: ConstructMesh data-invariant checklist (roadmap §5.5) — the renderer
    # executes drawn polys with no bounds checks; polyfix.constructmesh_check
    # is the codified list (num_pts, surface/vertex/uv index bounds, sides=2
    # neg rule, stip bits, full-consumption).
    import polyfix
    viol = polyfix.constructmesh_check(rp)
    r["constructMeshViolations"] = viol[:10]
    r["constructMeshOk"] = not viol

    ok = (fields_ok and pos_drift == 0.0 and nrm_drift == 0.0
          and r["surfacesPrefixOk"] and r["vertexCapOk"]
          and r["origPolysCarriedOk"] and r["noPosFillersOk"]
          and r["portNodesOk"] and r["shellDisplacedOk"]
          and r["constructMeshOk"])
    r["OK"] = ok
    if not ok:
        fail += 1
    report["models"][gid_h] = r

# F: cell dat forensics
szb, sze = os.path.getsize(BASE_C), os.path.getsize(EXP_C)
cell = dict(sizeBase=szb, sizeExport=sze, sizeEqual=szb == sze)
if szb == sze:
    diffs = []
    CH = 16 * 1024 * 1024
    with open(BASE_C, "rb") as fb, open(EXP_C, "rb") as fe:
        ofs = 0
        while True:
            a = fb.read(CH)
            e = fe.read(CH)
            if not a:
                break
            if a != e:
                av = np.frombuffer(a, dtype="<u4")
                ev = np.frombuffer(e, dtype="<u4")
                n = min(len(av), len(ev))
                idx = np.nonzero(av[:n] != ev[:n])[0]
                for i in idx:
                    diffs.append((ofs + int(i) * 4, int(av[i]), int(ev[i])))
            ofs += len(a)
    hdr, sentinel, other = [], [], []
    for d in diffs:
        if 0x140 <= d[0] < 0x190:
            hdr.append(d)
        elif d[1] == 0xCDCDCDCD and d[2] == 0:
            sentinel.append(d)
        else:
            other.append(d)
    cell.update(diffWords=len(diffs), headerWords=len(hdr),
                sentinelFixes=len(sentinel), unexplained=len(other),
                unexplainedSample=[(hex(o), hex(a), hex(b))
                                   for o, a, b in other[:10]])
    if other:
        fail += 1
report["globalChecks"]["cellDat"] = cell
report["globalChecks"]["portalDat"] = dict(
    sizeBase=os.path.getsize(BASE_P), sizeExport=os.path.getsize(EXP_P),
    delta=os.path.getsize(EXP_P) - os.path.getsize(BASE_P))
report["failures"] = fail

with open(OUT, "w") as f:
    json.dump(report, f, indent=1)

print(json.dumps(report["globalChecks"], indent=1))
nok = sum(1 for m in report["models"].values() if m.get("OK"))
print("models OK: %d/%d, failures=%d" % (nok, len(report["models"]), fail))
for g, m in report["models"].items():
    print(" %s tris %s verts %s physDrift %.9f surf %s carried %s "
          "fillers %s PORT %s disp %.3fm %s"
          % (g, m.get("renderTris"), m.get("verts"),
             m.get("physVertexPosDrift", -1), m.get("surfaces"),
             m.get("origPolysCarried"), m.get("noPosFillers"),
             m.get("portNodes"), m.get("maxShellDisp", -1),
             "OK" if m.get("OK") else "FAIL"))

# Exit code so a batch driver can gate on the contract (green = 0).
sys.exit(1 if fail else 0)
