#!/usr/bin/env python3
"""diag.py -- byte-level diagnosis of the two gallery defects.

For every patched model, compare base vs export/client_portal.dat records:
  1. displacement: distance of appended render vertices from the base render
     surface (max/mean, fraction > 2 cm)  -> was relief zeroed anywhere?
  2. NoPos portal-filler polygons: are they still present with stip&0x04,
     same vertex ids, same pos/neg surface indices?
  3. drawing BSP: PORT node count base vs patched (portal visibility linkage).
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, "/mnt/wbterminal2/dpc-work")
import gfxlib  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
base = gfxlib.Portal(os.path.join(HERE, "proj/dats/base/client_portal.dat"))
pat = gfxlib.Portal(os.path.join(HERE, "export/client_portal.dat"))
stats = json.load(open(os.path.join(HERE, "build_stats.json")))


def tri_dist(pts, V, F):
    """min distance from each pt to any triangle in (V,F). Vectorized per tri."""
    best = np.full(len(pts), np.inf)
    P = np.asarray(pts)
    for f in F:
        a, b, c = V[f[0]], V[f[1]], V[f[2]]
        ab, ac = b - a, c - a
        n = np.cross(ab, ac)
        nn = np.linalg.norm(n)
        if nn < 1e-12:
            continue
        n = n / nn
        ap = P - a
        d_plane = ap @ n
        proj = ap - d_plane[:, None] * n
        # barycentric of projection
        d00, d01, d11 = ab @ ab, ab @ ac, ac @ ac
        d20, d21 = proj @ ab, proj @ ac
        den = d00 * d11 - d01 * d01
        v = (d11 * d20 - d01 * d21) / den
        w = (d00 * d21 - d01 * d20) / den
        inside = (v >= -1e-6) & (w >= -1e-6) & (v + w <= 1 + 1e-6)
        d = np.where(inside, np.abs(d_plane), np.inf)
        # edge distances for outside pts (cheap approx: verts only)
        dv = np.minimum(np.minimum(np.linalg.norm(P - a, axis=1),
                                   np.linalg.norm(P - b, axis=1)),
                        np.linalg.norm(P - c, axis=1))
        best = np.minimum(best, np.minimum(d, dv))
    return best


def fillers(rec):
    out = {}
    for p in rec["polys"]:
        if p["stip"] & 0x04:
            out[tuple(sorted(p["v"]))] = (p["stip"], p["pos"], p["neg"])
    return out


rows = {}
for gid_h in sorted(stats):
    gid = int(gid_h, 16)
    b = base.gfx(gid)
    q = pat.gfx(gid)
    raw_b = base.dat.get(gid) if hasattr(base, "dat") else None

    nvb, nvq = len(b["P"]), len(q["P"])
    Vb = np.asarray(b["P"])
    Fb = [(p["v"][0], p["v"][k], p["v"][k + 1])
          for p in b["polys"] for k in range(1, len(p["v"]) - 1)]
    new = np.asarray(q["P"][nvb:]) if nvq > nvb else np.zeros((0, 3))
    if len(new):
        d = tri_dist(new, Vb, Fb)
        disp = dict(newVerts=int(len(new)), maxDisp=round(float(d.max()), 4),
                    meanDisp=round(float(d.mean()), 4),
                    over2cm=int((d > 0.02).sum()))
    else:
        disp = dict(newVerts=0, maxDisp=0.0, meanDisp=0.0, over2cm=0)

    fb, fq = fillers(b), fillers(q)
    lost = [k for k in fb if k not in fq]
    changed = [k for k in fb if k in fq and fq[k] != fb[k]]
    # do the base filler vertex-id sets appear as NON-NoPos polys in patched?
    vq_all = {}
    for p in q["polys"]:
        vq_all.setdefault(tuple(sorted(p["v"])), []).append(p)
    demoted = [k for k in lost if k in vq_all]

    def portcount(portal, g):
        return portal.raw(g).count(b"TROP") if hasattr(portal, "raw") else None

    rows[gid_h] = dict(**disp,
                       baseFillers=len(fb), lostNoPos=len(lost),
                       demotedToDrawn=len(demoted), flagChanged=len(changed),
                       basePolys=len(b["polys"]), patPolys=len(q["polys"]),
                       basePORT=None, patPORT=None)

# PORT node counts from raw bytes
import struct  # noqa: E402


def raw_of(path, gid):
    d = gfxlib.Portal(path)
    return d.raw(gid) if hasattr(d, "raw") else None


for portal, key in ((base, "basePORT"), (pat, "patPORT")):
    for gid_h in rows:
        gid = int(gid_h, 16)
        rawb = None
        try:
            rawb = portal.raw(gid)
        except AttributeError:
            try:
                rawb = portal.dat.get(gid)
            except AttributeError:
                pass
        if rawb is not None:
            rows[gid_h][key] = rawb.count(b"TROP")

print(json.dumps(rows, indent=1))
with open(os.path.join(HERE, "diag.json"), "w") as f:
    json.dump(rows, f, indent=1)
