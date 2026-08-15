"""pipeline.py -- glue: record -> gated height fields -> displaced+decimated
render mesh -> textures ready for render3.

Artist overrides live here, each with the reason it was needed.  They are the
honest output of looking at the texture: the curated table was seeded from
exterior building surfaces and mislabels dungeon rock, and the kNN corpus
misses thatch.
"""
import numpy as np

import datlib
import gfxlib
import matlib
import relief3d

# surface id -> (class, why).  Artist calls made by LOOKING at the texture.
OVERRIDES = {
    0x08000742: ("Shingle", "thatch: coursed straw with a hard course line "
                            "(kNN said Flush)"),
    0x0800017A: ("Stone", "cave: cobble/boulder wall (curated table said Flush "
                          "-- it was seeded on exterior surfaces)"),
    0x0800017C: ("Stone", "cave: cracked rock face (curated said Flush)"),
}

P = gfxlib.Portal()


def surface_meta(sids, prefer_remacri=False, max_side=512, amp_scale=1.0,
                 force=None, allow_ml=True):
    """Gate + height field for a set of Surface ids.  Returns
    {sid: dict(cls, why, amp, h, rsId, carved, src)}."""
    out = {}
    for sid in sids:
        s = P.surface(sid)
        cls, why = matlib.classify(sid, s)
        if force and sid in force:
            cls, why = force[sid]
        elif sid in OVERRIDES:
            cls, why = OVERRIDES[sid]
            why = "artist override: " + why
        rs = (s or {}).get("rsId")
        h = None
        src = None
        op = "veto"
        cf = 0.0
        if rs:
            h, op, cf, src = matlib.height_route(rs, cls, prefer_remacri, max_side,
                                                 allow_ml=allow_ml)
        amp = matlib.amp_for(cls) * amp_scale if h is not None else 0.0
        out[sid] = dict(cls=cls, why=why, amp=amp, h=h, rsId=rs, op=op,
                        carved=cf, src=src, surf=s)
    return out


def load_textures(metas, remacri=True, max_side=1024):
    """surface id -> RGBA float array for RENDERING (Remacri if we have it --
    the upscale is what actually ships on the model)."""
    tex = {}
    srcs = {}
    for sid, m in metas.items():
        rs = m.get("rsId")
        if not rs:
            tex[sid] = None
            continue
        a, src = matlib.load_tex_full(rs, remacri, max_side)
        tex[sid] = a
        srcs[sid] = src
    return tex, srcs


def gfx_source(gid, xform=None, force=None, prefer_remacri_height=False,
               amp_scale=1.0, allow_ml=True):
    rec = P.gfx(gid)
    sids = set(rec["surfaces"])
    metas = surface_meta(sids, prefer_remacri_height, force=force,
                         amp_scale=amp_scale, allow_ml=allow_ml)
    src = relief3d.SourceMesh.from_record(rec, metas, xform)
    return src, metas, rec


def setup_sources(setup_id, placement=0, force=None, amp_scale=1.0,
                  prefer_remacri_height=False, allow_ml=True):
    """Assemble a Setup's parts into ONE SourceMesh (world space)."""
    s = datlib.parse_setup(P.dat.get(setup_id))
    key = placement if placement in s["frames"] else sorted(s["frames"])[0]
    fr = s["frames"][key]
    merged = relief3d.SourceMesh()
    metas = {}
    parts = []
    for i, pid in enumerate(s["parts"]):
        rec = P.gfx(pid)
        sids = set(rec["surfaces"])
        m = surface_meta(sids, prefer_remacri_height, force=force,
                         amp_scale=amp_scale, allow_ml=allow_ml)
        metas.update(m)
        o, q = fr[i]
        R = _qmat(q)
        sm = relief3d.SourceMesh.from_record(rec, m, (R, np.array(o)))
        base = len(merged.P)
        merged.P += sm.P
        merged.N += sm.N
        for p in sm.polys:
            p = dict(p)
            p["v"] = [v + base for v in p["v"]]
            p["part"] = i
            merged.polys.append(p)
        parts.append((i, "0x%08X" % pid, sm.tri_count()))
    return merged, metas, parts, s


def _qmat(q):
    w, x, y, z = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def bandlimit(src, metas, target_faces, verbose=True):
    """Band-limit every height field to the frequency the triangle budget can
    actually carry.

    THE round-2 lesson: mortar-scale carving needs 16-32 segments per source
    edge (gfx_subdiv's own arithmetic).  At 4x you get TWO.  Displacing a
    10-cm-period joint field with a 60-cm vertex spacing does not produce
    mortar joints, it produces aliased noise -- which is exactly the "the
    triangles were there but not doing much" verdict.

    So: blur the height field to the achievable spacing (sigma = 0.6 x the
    target vertex spacing, converted to texels through the polygon's own
    uv-per-metre), then restore the contrast the blur removed.  What survives
    is the LOW-frequency part of what the texture says: the big stones, the
    course lines, the plank gaps, the beam edges -- and those the budget CAN
    carry.  The texture still supplies WHERE; the budget supplies HOW COARSE.
    """
    from scipy import ndimage as ndi
    area = src.area()
    if target_faces <= 0 or area <= 0:
        return {}, 0.0
    spacing = np.sqrt(2.0 * area / target_faces)
    # uv-per-metre per surface (median over the polygons that use it)
    scales = {}
    for p in src.polys:
        if p.get("invisible"):
            continue
        s = src.uv_per_metre(p)
        if s:
            scales.setdefault(p["surf"], []).append(s)
    info = {}
    for sid, m in metas.items():
        h = m.get("h")
        if h is None:
            continue
        sc = float(np.median(scales.get(sid, [0.0]))) if scales.get(sid) else 0.0
        if sc <= 0:
            continue
        texels_per_m = sc * float(min(h.shape))
        sigma = 0.6 * spacing * texels_per_m
        info[sid] = dict(spacing=spacing, uv_per_m=sc, sigma_tex=sigma,
                         period_m=1.0 / sc if sc else 0.0)
        if sigma < 0.5:
            continue
        lo0, hi0 = np.percentile(h, [2, 98])
        hb = ndi.gaussian_filter(h.astype(np.float32), sigma, mode="wrap")
        lo1, hi1 = np.percentile(hb, [2, 98])
        # restore the contrast the blur removed (bounded), keeping 1 = proud
        g = min(3.0, (hi0 - lo0) / max(hi1 - lo1, 1e-4)) if hi1 > lo1 else 1.0
        hb = np.clip(1.0 - (1.0 - hb) * g, 0.0, 1.0)
        m["h"] = hb.astype(np.float32)
        m["bandlimited"] = dict(sigma_tex=round(float(sigma), 2),
                                gain=round(float(g), 2),
                                spacing_m=round(float(spacing), 3))
        info[sid].update(gain=g)
    if verbose and info:
        k = sorted(info)[0]
        print("   band-limit: target spacing %.3f m" % spacing)
    return info, spacing


def run(src, segments=12, mult=4.0, verbose=True, max_error=None,
        carved_only=False, floor_m=0.0, target_tris=None, normal_gain=1.0,
        amp_fn=None, area_share=0.75):
    """subdivide+displace -> decimate to mult x source triangles.
    target_tris overrides the n0*mult budget (used for shell-only emission,
    where the carried originals already count toward the drawn total).
    normal_gain: sculpted-normal exaggeration (recipe C ships 2.5).
    amp_fn: callable(pos) -> amplitude scale, e.g. recipe C's plinth ramp.
    area_share: fair-share budget floor per source triangle (0 disables)."""
    n0 = src.tri_count()
    fine = relief3d.build_displaced(src, segments=segments,
                                    carved_only=carved_only, floor_m=floor_m,
                                    amp_fn=amp_fn)
    nfine = len(fine["faces"])
    target = int(round(n0 * mult)) if target_tris is None else int(target_tris)
    dec = relief3d.Decimator(fine["V"], fine["faces"], fine["srctri"],
                             fine["kind"], fine["chain"], fine["vframe"],
                             fine["vbary"])
    if area_share:
        dec.set_area_floor(target, fine["tri"], share=area_share)
    V, F, ST = dec.run(target, max_error=max_error, verbose=verbose)
    UV, NR, poly = relief3d.finalize(V, F, ST, fine["tri"],
                                     normal_gain=normal_gain,
                                     vbary=dec.out_vbary)
    if verbose:
        print("   src=%d fine=%d (%.0fx) -> final=%d (%.2fx)"
              % (n0, nfine, nfine / max(n0, 1), len(F), len(F) / max(n0, 1)))
    return dict(V=V, F=np.array(F), UV=UV, NR=NR, poly=poly, fine=nfine,
                src_tris=n0, target=target, tri=fine["tri"], srctri=ST,
                vbary=dec.out_vbary)


def face_surface(src, poly_idx):
    return np.array([src.polys[p]["surf"] for p in poly_idx])


def original(src):
    V, F, UV, NR, poly = relief3d.original_mesh(src)
    return dict(V=V, F=F, UV=UV, NR=NR, poly=poly, src_tris=len(F))


# ------------------------------------------------------------------ dungeon
CELLDAT = "/mnt/wbterminal2/dpc-work/proj/dats/base/client_cell_1.dat"
_cell = None


def celldat():
    global _cell
    if _cell is None:
        _cell = datlib.Dat(CELLDAT)
    return _cell


def cave_source(lb, limit=None, force=None, amp_scale=1.0, allow_ml=True,
                cell_filter=None):
    """Assemble a dungeon's EnvCells into one SourceMesh.

    Dungeon geometry is NOT GfxObjs: an EnvCell names an Environment (0x0D) +
    a CellStruct index + a placement Frame, and carries ITS OWN surface table
    that the CellStruct polygons index into.  Same primitives otherwise, so the
    whole relief pipeline transfers unchanged.
    """
    cd = celldat()
    ids = sorted(i for i in cd.files
                 if (i >> 16) == lb and 0x0100 <= (i & 0xFFFF) < 0xFFFE)
    if cell_filter:
        ids = [i for i in ids if cell_filter(i)]
    if limit:
        ids = ids[:limit]
    merged = relief3d.SourceMesh()
    metas = {}
    used = 0
    portal_pinned = 0
    for cid in ids:
        d = datlib.parse_envcell(cd.get(cid))
        try:
            cells = P.env(d["env"])
        except Exception:
            continue
        cs = cells.get(d["cstruct"])
        if cs is None:
            continue
        m = surface_meta(set(d["surfaces"]), force=force, amp_scale=amp_scale,
                         allow_ml=allow_ml)
        metas.update(m)
        rec = dict(cs)
        rec["surfaces"] = d["surfaces"]
        R = _qmat(d["orient"])
        sm = relief3d.SourceMesh.from_record(rec, m, (R, np.array(d["origin"])))
        # portal polygons drive PVS and must never move
        pin = set(cs.get("portal_ids") or [])
        for j, p in enumerate(sm.polys):
            if cs["polys"][j].get("key") in pin:
                p["excluded"] = True
                p["amp"] = 0.0
                p["h"] = None
                portal_pinned += 1
        base = len(merged.P)
        merged.P += sm.P
        merged.N += sm.N
        for p in sm.polys:
            p = dict(p)
            p["v"] = [v + base for v in p["v"]]
            p["cell"] = cid
            merged.polys.append(p)
        used += 1
    return merged, metas, used, len(ids), portal_pinned
