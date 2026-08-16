"""relief3d.py -- the round-2 pipeline, in one module.

    gate (matlib.classify)         WHETHER this surface may carve at all
      -> height field (matlib)     WHERE within the texture it carves
      -> subdivide + displace      at texture-resolving resolution
      -> QEM decimate to ~4x       triangles survive only where the carve
                                   actually bent the surface
      -> attributes recomputed     UV/normal are pure functions of position +
                                   source triangle, so decimation needs no
                                   attribute bookkeeping at all

Doctrine ported from holtburger-dat/src/gfx_subdiv.rs (read in full):
  * never touch the shared vertex_array -- this builds a REPLACEMENT render
    mesh and leaves physics polygons alone;
  * displace OUTWARD along the AUTHORED normal only, capped at 0.10 m;
  * AC carries PER-FACE UVs, so the polygon across an original polygon
    boundary samples a different uv -- height modulation must ramp to the
    welded corner amplitude over BOUNDARY_RAMP_M or slits open;
  * excluded polygons (NoPos filler, CullMode.None alpha cards, CullMode.
    Clockwise two-surface sheets) pin their vertices to zero.

Round-1's mistake this fixes: uniform subdivision with a CONSTANT per-material
amplitude is a rigid offset -- 10x the triangles, byte-identical shading.  The
height field is what makes triangles do work.
"""
import heapq
import math

import numpy as np

MAX_AMPLITUDE_M = 0.10
BOUNDARY_RAMP_M = 0.03

KIND_FREE, KIND_CHAIN, KIND_CORNER = 0, 1, 2


# ----------------------------------------------------------------- helpers
def _n3(v):
    l = math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
    if l < 1e-12:
        return None
    return (v[0] / l, v[1] / l, v[2] / l)


def smoothstep01(x):
    t = 0.0 if x < 0 else (1.0 if x > 1 else x)
    return t * t * (3.0 - 2.0 * t)


def sample_height(h, u, v):
    """Bilinear, wrapped.  h is (H,W) float32, uv in texture space (v down)."""
    H, W = h.shape
    x = (u % 1.0) * W - 0.5
    y = (v % 1.0) * H - 0.5
    x0 = math.floor(x)
    y0 = math.floor(y)
    fx = x - x0
    fy = y - y0
    x0 = int(x0) % W
    y0 = int(y0) % H
    x1 = (x0 + 1) % W
    y1 = (y0 + 1) % H
    return float((h[y0, x0] * (1 - fx) + h[y0, x1] * fx) * (1 - fy)
                 + (h[y1, x0] * (1 - fx) + h[y1, x1] * fx) * fy)


class SourceMesh:
    """The authored render mesh of one GfxObj / CellStruct, in world space."""

    def __init__(self):
        self.P = []          # source vertex positions
        self.N = []          # source vertex normals (authored)
        self.polys = []      # dicts: v[], uv[], surf, cls, amp, hfield, excluded

    @staticmethod
    def from_record(rec, surfaces_meta, xform=None):
        """rec: gfxlib.parse_gfxobj / one CellStruct.  surfaces_meta: sid -> dict
        with keys cls, amp, h (height field or None).  xform: (3x3 R, t)."""
        m = SourceMesh()
        P = rec["P"]
        N = rec["N"]
        if xform is not None:
            R, t = xform
            P = [tuple(np.asarray(p) @ R.T + t) for p in P]
            N = [tuple(np.asarray(n) @ R.T) for n in N]
        m.P = [tuple(map(float, p)) for p in P]
        m.N = [tuple(map(float, n)) for n in N]
        idx = rec["idx"]
        UV = rec["UV"]
        for p in rec["polys"]:
            vids = [idx[k] for k in p["v"]]
            uvs = []
            for corner, vi in enumerate(vids):
                lst = UV[vi]
                k = p["uvi"][corner] if corner < len(p["uvi"]) else 0
                uvs.append(lst[k] if k < len(lst) else (lst[0] if lst else (0.0, 0.0)))
            sid = rec["surfaces"][p["pos"]] if 0 <= p["pos"] < len(rec["surfaces"]) else 0
            meta = surfaces_meta.get(sid, {})
            excluded = bool(p["stip"] & 0x4) or p["sides"] in (1, 2)
            # NoPos filler quads describe door/window OPENINGS and are never
            # drawn; fully translucent surfaces are the same idea.  Round 1's
            # renders drew them as grey slabs.
            sm = meta.get("surf") or {}
            invisible = bool(p["stip"] & 0x4) or sm.get("translucency", 0.0) >= 0.999
            m.polys.append(dict(v=vids, uv=uvs, surf=sid, sides=p["sides"],
                                stip=p["stip"], excluded=excluded,
                                invisible=invisible,
                                cls=meta.get("cls", "Unknown"),
                                amp=0.0 if excluded else meta.get("amp", 0.0),
                                h=None if excluded else meta.get("h")))
        m.substituted_normals = m._fix_zero_normals()
        return m

    def _fix_zero_normals(self):
        """Some records ship ZERO SWVertex normals (measured: 6% of GfxObj
        records have some, 2.3% of all vertices; the Rithwic causeway modules
        are 100% zero).  gfx_subdiv refuses to displace along a degenerate
        normal -- correctly -- and a Gouraud renderer shades them with ambient
        only, so a before/after built on them compares "unlit" with "lit".

        Substitute the area-weighted smooth FACET normal, which is a per-source-
        vertex quantity, so both sides of a shared edge still agree exactly.
        Used for BOTH panels; the production writer must store these normals in
        the patched record."""
        import numpy as _np
        P = _np.array(self.P)
        N = _np.array(self.N)
        if len(N) == 0:
            return 0
        zero = _np.abs(N).sum(1) < 1e-9
        if not zero.any():
            return 0
        acc = _np.zeros_like(P)
        for p in self.polys:
            v = p["v"]
            for k in range(1, len(v) - 1):
                a, b, c = P[v[0]], P[v[k]], P[v[k + 1]]
                n = _np.cross(b - a, c - a)
                for vi in (v[0], v[k], v[k + 1]):
                    acc[vi] += n
        l = _np.linalg.norm(acc, axis=1, keepdims=True)
        l[l < 1e-12] = 1.0
        acc = acc / l
        for i in _np.nonzero(zero)[0]:
            self.N[i] = tuple(acc[i])
        return int(zero.sum())

    def tri_count(self, visible_only=True):
        return sum(len(p["v"]) - 2 for p in self.polys
                   if not (visible_only and p.get("invisible")))

    def area(self):
        import numpy as _np
        tot = 0.0
        for p in self.polys:
            if p.get("invisible"):
                continue
            v = p["v"]
            for k in range(1, len(v) - 1):
                a = _np.array(self.P[v[0]])
                b = _np.array(self.P[v[k]])
                c = _np.array(self.P[v[k + 1]])
                tot += 0.5 * float(_np.linalg.norm(_np.cross(b - a, c - a)))
        return tot

    def uv_per_metre(self, poly):
        """|d(uv)/d(x)| for one polygon, from its first triangle."""
        import numpy as _np
        v = poly["v"]
        if len(v) < 3:
            return None
        a = _np.array(self.P[v[0]])
        b = _np.array(self.P[v[1]])
        c = _np.array(self.P[v[2]])
        ua = _np.array(poly["uv"][0])
        ub = _np.array(poly["uv"][1])
        uc = _np.array(poly["uv"][2])
        l1 = _np.linalg.norm(b - a)
        l2 = _np.linalg.norm(c - a)
        if l1 < 1e-6 or l2 < 1e-6:
            return None
        s1 = _np.linalg.norm(ub - ua) / l1
        s2 = _np.linalg.norm(uc - ua) / l2
        return float((s1 + s2) / 2.0)

    def weld_amplitudes(self):
        """Per source vertex outward amplitude, averaged over adjacent polygons;
        pinned to zero by any excluded polygon (gfx_subdiv::weld_vertex_amplitudes)."""
        acc = {}
        pinned = set()
        for p in self.polys:
            if p["excluded"]:
                pinned.update(p["v"])
                continue
            a = min(max(p["amp"], 0.0), MAX_AMPLITUDE_M)
            for vi in p["v"]:
                s, n = acc.get(vi, (0.0, 0))
                acc[vi] = (s + a, n + 1)
        out = {}
        for vi, (s, n) in acc.items():
            if vi in pinned or n == 0:
                continue
            a = s / n
            if a > 0:
                out[vi] = min(a, MAX_AMPLITUDE_M)
        return out


# --------------------------------------------------------- build fine mesh
def build_displaced(src, segments=12, scale=1.0, subdiv_flat=False,
                    carved_only=False, floor_m=0.0, amp_fn=None):
    """Subdivide + displace.  Returns dict(V, faces, srctri, kind, chain,
    vframe, srctri_data, stats).

    vframe[i] = frozenset of SOURCE TRIANGLE indices whose patches use vertex
    i -- the source triangle IS the UV frame (finalize/TriFrame builds one per
    tri_data entry).  Interior vertices carry exactly one; welded points on a
    fan diagonal or a polygon ring edge carry both/every frame that meets
    there.  The decimator uses it to refuse any collapse that would drag a
    vertex out of a frame it serves (see Decimator's docstring).

    vbary[i] = {frame id: (w0, w1, w2)} -- the vertex's PARAMETRIC position on
    the undisplaced source triangle.  This is what finalize() interpolates the
    UV and the authored normal with.  Re-deriving it by projecting the
    DISPLACED position back into the triangle (what this module used to do) is
    only exact when the displacement is parallel to the facet normal; it is
    displaced along the interpolated AUTHORED normal, whose in-plane component
    at welded corners and smoothed edges is real, so the projection lands on a
    different parametric point and the texture slides.

    carved_only: emit ONLY carving polygons (the shell).  Used when the
    importer carries every original polygon verbatim — re-emitting uncarved
    polys would draw them twice, coplanar.  Shell gaps at carved/uncarved
    seams are backstopped by the carried original surface behind them.
    floor_m: minimum outward displacement in metres for every emitted vertex
    (including boundary ramps and groove bottoms), so the shell never sits
    coplanar with the carried original polygon underneath (z-fighting).
    amp_fn: optional callable(undisplaced_pos) -> scale in [0,1] applied to the
    local amplitude.  It must be a pure function of POSITION so that vertices
    shared between polygons agree bit-exactly (recipe C's plinth ramp)."""
    amp_w = src.weld_amplitudes()
    P, N = src.P, src.N

    V = []
    kind = []
    chain = []
    vframe = []
    vbary = []
    vkey = {}

    def add_vertex(key, pos, k, ch, pid, bary):
        i = vkey.get(key)
        if i is None:
            i = len(V)
            vkey[key] = i
            V.append(pos)
            kind.append(k)
            chain.append(ch)
            vframe.append({pid})
            vbary.append({pid: bary})
        else:
            vframe[i].add(pid)
            vbary[i][pid] = bary
            if k > kind[i]:
                kind[i] = k
                chain[i] = ch
        return i

    faces = []
    srctri = []
    tri_data = []          # per source triangle: (p0,p1,p2, uv0..2, n0..2, poly)
    n_sub = n_flat = 0

    for pi, poly in enumerate(src.polys):
        if poly.get("invisible"):
            continue
        vids = poly["v"]
        uvs = poly["uv"]
        nv = len(vids)
        h = poly["h"]
        amp = min(max(poly["amp"] * scale, 0.0), MAX_AMPLITUDE_M)
        carving = (h is not None) and amp > 0
        if carved_only and not carving:
            continue
        segs = segments if (carving or subdiv_flat) else 1

        for k in range(1, nv - 1):
            corners = (0, k, k + 1)
            gi = [vids[c] for c in corners]
            tuv = [uvs[c] for c in corners]
            tp = [P[j] for j in gi]
            tn = [N[j] for j in gi]
            # ring edges of the source polygon are BOUNDARY; fan diagonals are not
            bnd = ((corners[0], corners[1]) in ((0, 1),),
                   True,                                    # (k, k+1) always ring
                   (corners[2] == nv - 1))
            ti = len(tri_data)
            tri_data.append(dict(p=tp, uv=tuv, n=tn, poly=pi, gi=gi, bnd=bnd))
            _emit_patch(ti, tri_data[ti], segs, amp, h, amp_w, add_vertex,
                        faces, srctri, floor_m, ti, amp_fn)
            if segs > 1:
                n_sub += 1
            else:
                n_flat += 1

    return dict(V=np.array(V, dtype=np.float64), faces=faces, srctri=srctri,
                kind=kind, chain=chain, tri=tri_data,
                vframe=[frozenset(s) for s in vframe], vbary=vbary,
                stats=dict(sub_tris=n_sub, flat_tris=n_flat, segments=segments))


def _emit_patch(ti, td, n, face_amp, hfield, amp_w, add_vertex, faces, srctri,
                floor_m=0.0, frame_id=-1, amp_fn=None):
    p0, p1, p2 = td["p"]
    u0, u1, u2 = td["uv"]
    n0, n1, n2 = td["n"]
    gi = td["gi"]
    bnd = td["bnd"]
    ca = [amp_w.get(gi[0], 0.0), amp_w.get(gi[1], 0.0), amp_w.get(gi[2], 0.0)]
    elen = max(
        math.dist(p0, p1), math.dist(p1, p2), math.dist(p2, p0))
    ramp = max(elen / BOUNDARY_RAMP_M, 3.0) if elen > 1e-6 else 3.0

    inv = 1.0 / n
    grid = {}
    for i in range(n + 1):
        for j in range(n + 1 - i):
            w1 = i * inv
            w2 = j * inv
            w0 = 1.0 - w1 - w2
            pos = (p0[0] * w0 + p1[0] * w1 + p2[0] * w2,
                   p0[1] * w0 + p1[1] * w1 + p2[1] * w2,
                   p0[2] * w0 + p1[2] * w1 + p2[2] * w2)
            nv = (n0[0] * w0 + n1[0] * w1 + n2[0] * w2,
                  n0[1] * w0 + n1[1] * w1 + n2[1] * w2,
                  n0[2] * w0 + n1[2] * w1 + n2[2] * w2)
            welded = ca[0] * w0 + ca[1] * w1 + ca[2] * w2
            if hfield is None or face_amp <= 0:
                a = welded
            else:
                d = 1.0
                if bnd[0]:
                    d = min(d, w2)
                if bnd[1]:
                    d = min(d, w0)
                if bnd[2]:
                    d = min(d, w1)
                inner = smoothstep01(d * ramp)
                u = u0[0] * w0 + u1[0] * w1 + u2[0] * w2
                v = u0[1] * w0 + u1[1] * w1 + u2[1] * w2
                hh = sample_height(hfield, u, v)
                a = welded * (1.0 - inner) + face_amp * hh * inner
            if amp_fn is not None:
                a *= amp_fn(pos)
            if floor_m > 0.0 and a < floor_m:
                a = floor_m
            un = _n3(nv)
            if un is not None and a > 0:
                pos = (pos[0] + un[0] * a, pos[1] + un[1] * a, pos[2] + un[2] * a)

            # vertex identity: shared between neighbouring source triangles.
            # Ring edges are shared across POLYGONS (and are the crack risk);
            # fan diagonals are shared inside one polygon and agree exactly,
            # because both triangles carry the same uv map and face amplitude.
            if (i, j) == (0, 0):
                key, k, ch = ("v", gi[0]), KIND_CORNER, -1
            elif (i, j) == (n, 0):
                key, k, ch = ("v", gi[1]), KIND_CORNER, -1
            elif (i, j) == (0, n):
                key, k, ch = ("v", gi[2]), KIND_CORNER, -1
            elif j == 0:                      # edge 0-1
                key, k, ch = _edge_key(gi[0], gi[1], i, n, bnd[0])
            elif i == 0:                      # edge 0-2
                key, k, ch = _edge_key(gi[0], gi[2], j, n, bnd[2])
            elif i + j == n:                  # edge 1-2
                key, k, ch = _edge_key(gi[1], gi[2], j, n, bnd[1])
            else:
                key, k, ch = ("i", ti, i, j), KIND_FREE, -1
            grid[(i, j)] = add_vertex(key, pos, k, ch, frame_id,
                                      (w0, w1, w2))

    for i in range(n):
        for j in range(n - i):
            a = grid[(i, j)]
            b = grid[(i + 1, j)]
            c = grid[(i, j + 1)]
            faces.append([a, b, c])
            srctri.append(ti)
            if i + j + 1 < n:
                d = grid[(i + 1, j + 1)]
                faces.append([b, d, c])
                srctri.append(ti)


def _edge_key(va, vb, step, n, is_boundary):
    """Canonical key for a point on the segment va-vb, `step` sub-steps from va.
    Shared between the two source triangles that meet on this edge."""
    if va <= vb:
        key = ("e", va, vb, step)
    else:
        key = ("e", vb, va, n - step)
    if not is_boundary:
        return key, KIND_FREE, -1
    return key, KIND_CHAIN, (min(va, vb), max(va, vb))


# ---------------------------------------------------------------- decimate
class Decimator:
    """Quadric edge collapse with the constraints this pipeline needs:

      * original source vertices are LOCKED (silhouette + physics footprint);
      * vertices on an original polygon boundary may only collapse ALONG their
        own boundary chain (so both sides of a shared edge simplify to the same
        polyline and no crack can open);
      * UV-FRAME PROVENANCE is honoured: a vertex remembers which source
        triangles' patches use it (the source triangle IS the UV frame), and u
        may only collapse into v when frames(u) <= frames(v) -- and v may only
        MOVE when frames(u) == frames(v).  Everything else is free, and because
        UV/normal are recomputed from the surviving triangle's SOURCE triangle
        frame afterwards, there are no attributes to interpolate.

    Why the provenance rule (the "pale ghost wedge", 2026-08-15).  finalize()
    recovers each vertex's UV by projecting it into its face's source TRIANGLE
    frame -- an affine map that is only valid INSIDE that triangle.  Nothing
    used to stop a collapse from moving a welded border vertex (a fan diagonal
    of a source polygon, or a ring edge shared with the neighbour polygon) off
    that border: the move is scored by one patch's quadric alone and drags the
    OTHER patch's faces with it, so a face keeps pointing at a source triangle
    it no longer covers.  Measured on 0x01002232 at 4x before this fix: 1142 of
    1476 output faces -- 66 % of the drawn area -- had a vertex outside its own
    source triangle, the worst face 158x its source triangle's area at
    barycentric -93, i.e. its UVs extrapolated ~90 triangle-widths into the
    neighbour's texture.  That is the visible defect: oversized triangles
    fanning off window corners, sitting proud of the fine mesh, smearing one
    polygon's texture across another (a diagonal shading band across
    0x01002232's front wall and a white seam at the near corner).

    The invariant restored: every vertex of a face stays inside the closure of
    that face's own source triangle, so no output triangle ever spans two UV
    frames and texture registration holds by construction.  It is the
    boundary-clamp doctrine (gfx_subdiv.rs) extended from the record's outer
    boundary to every interior patch border.  Cost: each source triangle keeps
    at least its own base triangle, i.e. a floor of exactly n_source_tris --
    far under the 4x budget.
    """

    def __init__(self, V, faces, srctri, kind, chain, vframe=None, vbary=None):
        self.V = [tuple(p) for p in V]
        self.faces = [list(f) for f in faces]
        self.srctri = list(srctri)
        self.kind = list(kind)
        self.chain = list(chain)
        # provenance: frozenset of source-triangle (UV frame) ids per vertex.
        # None (the legacy call shape) is reconstructed from the faces, which
        # is exact for any mesh build_displaced produced.
        if vframe is None:
            vframe = self._provenance_from_faces()
        self.vframe = [frozenset(s) for s in vframe]
        # parametric (barycentric) position per frame, carried through every
        # collapse so UV/normal never have to be re-derived from geometry.
        self.vbary = [dict(d) for d in vbary] if vbary is not None else None
        self.out_vbary = None
        self.alive_f = [True] * len(self.faces)
        self.alive_v = [True] * len(self.V)
        self.vf = [set() for _ in self.V]
        for fi, f in enumerate(self.faces):
            for v in f:
                self.vf[v].add(fi)
        self.nface = len(self.faces)
        self.Q = None
        # live faces per UV frame, for the fair-share budget floor
        self.fcount = {}
        for t in self.srctri:
            self.fcount[t] = self.fcount.get(t, 0) + 1
        self.floor = None

    def _provenance_from_faces(self):
        """Fallback when the caller did not pass vframe: read the frame ids off
        the faces.  Exact for any mesh build_displaced produced (a face's
        srctri IS its frame); only a vertex that no live face references is
        left empty, and such a vertex is unreachable by any collapse."""
        prov = [set() for _ in self.V]
        for fi, f in enumerate(self.faces):
            t = self.srctri[fi]
            for v in f:
                prov[v].add(t)
        return prov

    # ---- quadrics
    def _face_plane(self, fi):
        a, b, c = self.faces[fi]
        pa, pb, pc = self.V[a], self.V[b], self.V[c]
        ux, uy, uz = pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]
        vx, vy, vz = pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]
        nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
        l = math.sqrt(nx * nx + ny * ny + nz * nz)
        if l < 1e-14:
            return None, 0.0
        nx, ny, nz = nx / l, ny / l, nz / l
        d = -(nx * pa[0] + ny * pa[1] + nz * pa[2])
        return (nx, ny, nz, d), l * 0.5

    @staticmethod
    def _q_from_plane(pl, w=1.0):
        a, b, c, d = pl
        return np.array([a * a, a * b, a * c, a * d,
                         b * b, b * c, b * d,
                         c * c, c * d, d * d]) * w

    @staticmethod
    def _err(q, p):
        x, y, z = p
        return (q[0] * x * x + 2 * q[1] * x * y + 2 * q[2] * x * z + 2 * q[3] * x
                + q[4] * y * y + 2 * q[5] * y * z + 2 * q[6] * y
                + q[7] * z * z + 2 * q[8] * z + q[9])

    def build_quadrics(self, chain_weight=8.0):
        n = len(self.V)
        Q = np.zeros((n, 10))
        for fi in range(len(self.faces)):
            pl, area = self._face_plane(fi)
            if pl is None:
                continue
            q = self._q_from_plane(pl, area)
            for v in self.faces[fi]:
                Q[v] += q
        # chain constraint: keep boundary polylines on their own line
        seen = set()
        for fi, f in enumerate(self.faces):
            for k in range(3):
                a, b = f[k], f[(k + 1) % 3]
                ka, kb = self.kind[a], self.kind[b]
                if ka == KIND_FREE or kb == KIND_FREE:
                    continue
                if ka == KIND_CHAIN and kb == KIND_CHAIN and self.chain[a] != self.chain[b]:
                    continue
                key = (min(a, b), max(a, b))
                if key in seen:
                    continue
                seen.add(key)
                pl, _ = self._face_plane(fi)
                if pl is None:
                    continue
                pa, pb = self.V[a], self.V[b]
                ex, ey, ez = pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]
                # plane through the edge, perpendicular to the face
                nx = ey * pl[2] - ez * pl[1]
                ny = ez * pl[0] - ex * pl[2]
                nz = ex * pl[1] - ey * pl[0]
                l = math.sqrt(nx * nx + ny * ny + nz * nz)
                if l < 1e-14:
                    continue
                nx, ny, nz = nx / l, ny / l, nz / l
                d = -(nx * pa[0] + ny * pa[1] + nz * pa[2])
                q = self._q_from_plane((nx, ny, nz, d), chain_weight)
                Q[a] += q
                Q[b] += q
        self.Q = Q

    # ---- collapse legality
    def _candidates(self, u, v):
        """Return list of (cost, position) for collapsing u INTO v, or []."""
        ku, kv = self.kind[u], self.kind[v]
        if ku == KIND_CORNER:
            return []
        if ku == KIND_CHAIN:
            if kv == KIND_CHAIN and self.chain[u] == self.chain[v]:
                pass
            elif kv == KIND_CORNER:
                pass
            else:
                return []
        # UV-frame provenance.  u's faces become v's faces, so every frame u
        # serves must survive at v; and v may only be MOVED when it serves
        # exactly the same frames as u (otherwise the move is scored by one
        # patch's quadric and drags another patch's faces out of frame).
        prov_u, prov_v = self.vframe[u], self.vframe[v]
        if not prov_u <= prov_v:
            return []
        same_frame = prov_u == prov_v
        q = self.Q[u] + self.Q[v]
        pu, pv = self.V[u], self.V[v]
        if ku == kv and same_frame and (
                ku == KIND_FREE
                or (ku == KIND_CHAIN and self.chain[u] == self.chain[v])):
            cands = [pv, pu, ((pu[0] + pv[0]) / 2, (pu[1] + pv[1]) / 2, (pu[2] + pv[2]) / 2)]
        else:
            cands = [pv]
        best = min(((self._err(q, p), p) for p in cands), key=lambda t: t[0])
        return [best]

    def _would_flip(self, u, v, newp):
        for fi in self.vf[u]:
            if not self.alive_f[fi]:
                continue
            f = self.faces[fi]
            if v in f:
                continue
            pts = [newp if x == u else self.V[x] for x in f]
            n_old = self._normal([self.V[x] for x in f])
            n_new = self._normal(pts)
            if n_old is None or n_new is None:
                return True
            if n_old[0] * n_new[0] + n_old[1] * n_new[1] + n_old[2] * n_new[2] < 0.2:
                return True
        return False

    @staticmethod
    def _normal(p):
        a, b, c = p
        ux, uy, uz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
        vx, vy, vz = c[0] - a[0], c[1] - a[1], c[2] - a[2]
        nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
        l = math.sqrt(nx * nx + ny * ny + nz * nz)
        if l < 1e-16:
            return None
        return (nx / l, ny / l, nz / l)

    def set_area_floor(self, target_faces, tri_data, share=0.75):
        """Fair-share budget floor: no source triangle may be decimated below
        `share` x its area-proportional slice of the budget.

        Without it the global QEM heap flattens whole large wall polygons to a
        couple of triangles (their quadric error per collapse is low because
        they ARE flat) and spends the budget on small busy geometry.  The
        leftover coarse facets tilt a few degrees against the source plane --
        which sculpted normals at gain 2.5 amplify into visible hard-edged
        shading wedges across a wall.  `share` < 1 leaves the heap room to
        allocate the remainder by cost."""
        areas = {}
        for t in set(self.srctri):
            p = np.array(tri_data[t]["p"])
            areas[t] = 0.5 * float(np.linalg.norm(
                np.cross(p[1] - p[0], p[2] - p[0])))
        tot = sum(areas.values())
        if tot <= 0:
            return
        self.floor = {t: max(1, int(share * target_faces * a / tot))
                      for t, a in areas.items()}

    def _floor_blocks(self, u, v):
        """True if collapsing u into v would take a frame under its floor."""
        if self.floor is None:
            return False
        killed = {}
        for fi in self.vf[u]:
            if self.alive_f[fi] and v in self.faces[fi]:
                t = self.srctri[fi]
                killed[t] = killed.get(t, 0) + 1
        for t, k in killed.items():
            if self.fcount.get(t, 0) - k < self.floor.get(t, 1):
                return True
        return False

    def run(self, target_faces, max_error=None, verbose=False):
        if self.Q is None:
            self.build_quadrics()
        heap = []
        ver = [0] * len(self.V)

        def push(u, v):
            c = self._candidates(u, v)
            if c:
                heapq.heappush(heap, (c[0][0], u, v, ver[u], ver[v], c[0][1]))

        edges = set()
        for f in self.faces:
            for k in range(3):
                a, b = f[k], f[(k + 1) % 3]
                edges.add((min(a, b), max(a, b)))
        for a, b in edges:
            push(a, b)
            push(b, a)

        removed = 0
        while self.nface > target_faces and heap:
            cost, u, v, vu, vv, p = heapq.heappop(heap)
            if not (self.alive_v[u] and self.alive_v[v]):
                continue
            if ver[u] != vu or ver[v] != vv:
                continue
            if max_error is not None and cost > max_error:
                break
            if self._floor_blocks(u, v):
                ver[u] += 1
                continue
            if self._would_flip(u, v, p):
                ver[u] += 1
                continue
            # perform collapse u -> v at p
            if self.vbary is not None:
                self._blend_bary(u, v, p)
            self.V[v] = p
            self.Q[v] = self.Q[u] + self.Q[v]
            # no-op under the _candidates guard (prov[u] <= prov[v]); kept so
            # the invariant survives any future relaxation of that guard.
            self.vframe[v] = self.vframe[v] | self.vframe[u]
            dead = []
            for fi in list(self.vf[u]):
                if not self.alive_f[fi]:
                    continue
                f = self.faces[fi]
                if v in f:
                    self.alive_f[fi] = False
                    self.nface -= 1
                    t = self.srctri[fi]
                    self.fcount[t] = self.fcount.get(t, 1) - 1
                    dead.append(fi)
                    for x in f:
                        self.vf[x].discard(fi)
                else:
                    self.faces[fi] = [v if x == u else x for x in f]
                    self.vf[v].add(fi)
            self.alive_v[u] = False
            self.vf[u] = set()
            ver[v] += 1
            removed += 1
            # re-push the 1-ring of v
            ring = set()
            for fi in self.vf[v]:
                if self.alive_f[fi]:
                    ring.update(self.faces[fi])
            ring.discard(v)
            for w in ring:
                ver[w] += 1
            for w in ring:
                push(w, v)
                push(v, w)
                for fi in list(self.vf[w]):
                    if not self.alive_f[fi]:
                        continue
                    for x in self.faces[fi]:
                        if x != w:
                            push(w, x)
                            push(x, w)
        if verbose:
            print("   collapses=%d faces=%d" % (removed, self.nface))
        return self.result()

    def _blend_bary(self, u, v, p):
        """Move v's parametric coordinate along with its position.  p always
        lies on the segment [V[v], V[u]] (it is pv, pu or their midpoint), so
        the same parameter t transports the barycentric coordinate exactly.
        _candidates only offers p != pv when u and v serve the SAME frames, so
        every frame v serves has a coordinate on both ends to blend."""
        pv, pu = self.V[v], self.V[u]
        dx, dy, dz = pu[0] - pv[0], pu[1] - pv[1], pu[2] - pv[2]
        den = dx * dx + dy * dy + dz * dz
        if den < 1e-24:
            t = 0.0
        else:
            t = ((p[0] - pv[0]) * dx + (p[1] - pv[1]) * dy
                 + (p[2] - pv[2]) * dz) / den
            t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
        if t <= 0.0:
            return
        bu, bv = self.vbary[u], self.vbary[v]
        for f, b in bv.items():
            c = bu.get(f)
            if c is None:
                continue
            bv[f] = (b[0] + t * (c[0] - b[0]),
                     b[1] + t * (c[1] - b[1]),
                     b[2] + t * (c[2] - b[2]))
        for f, c in bu.items():
            if f not in bv:
                bv[f] = c

    def result(self):
        remap = {}
        V = []
        for i, alive in enumerate(self.alive_v):
            if alive:
                remap[i] = len(V)
                V.append(self.V[i])
        faces = []
        srctri = []
        for fi, alive in enumerate(self.alive_f):
            if not alive:
                continue
            f = self.faces[fi]
            if len(set(f)) < 3:
                continue
            faces.append([remap[x] for x in f])
            srctri.append(self.srctri[fi])
        if self.vbary is not None:
            out = [None] * len(V)
            for i, j in remap.items():
                out[j] = self.vbary[i]
            self.out_vbary = out
        return np.array(V), faces, srctri


# ------------------------------------------------- attributes from position
class TriFrame:
    """UV + authored normal as pure functions of position, in one source
    triangle's own frame.  Exact for the undisplaced surface; displacement is
    normal-directed so it projects out."""

    def __init__(self, td):
        p = np.array(td["p"], dtype=np.float64)
        self.p0 = p[0]
        E = np.stack([p[1] - p[0], p[2] - p[0]])          # (2,3)
        G = E @ E.T
        try:
            self.Ginv = np.linalg.inv(G)
        except np.linalg.LinAlgError:
            self.Ginv = np.linalg.pinv(G)
        self.E = E
        self.uv = np.array(td["uv"], dtype=np.float64)
        self.n = np.array(td["n"], dtype=np.float64)
        nrm = np.cross(E[0], E[1])
        l = np.linalg.norm(nrm)
        self.plane_n = nrm / l if l > 1e-14 else np.array([0.0, 0.0, 1.0])

    def bary(self, P):
        d = P - self.p0
        w = (self.Ginv @ (self.E @ d.T)).T                  # (n,2)
        return np.column_stack([1.0 - w[:, 0] - w[:, 1], w])

    def attrs(self, P):
        b = self.bary(np.asarray(P, dtype=np.float64))
        uv = b @ self.uv
        nn = b @ self.n
        return uv, nn


def finalize(V, faces, srctri, tri_data, smooth=True, normal_gain=1.0,
             vbary=None):
    """Per-face-corner UV and normal.  Normal = authored interpolated normal +
    normal_gain * (displaced geometric normal - original facet normal): the
    gfx_subdiv blend, which keeps AC's authored smoothing and adds exactly what
    the displacement did.  Without it displacement is a bit-exact no-op on a
    Gouraud image.  normal_gain > 1 exaggerates the carved shading (starkness
    ladder arm C); boundary rings are naturally unaffected because displacement
    ramps to zero there so (g - plane_n) ~ 0.

    vbary: {frame: (w0,w1,w2)} per vertex, carried from build_displaced through
    the decimator.  When present the UV and the authored normal are read at the
    vertex's own PARAMETRIC position -- texture registration by construction,
    exact whatever the displacement did.  Without it they are recovered by
    projecting the displaced position back into the source triangle, which
    silently mis-registers wherever the authored normal is not parallel to the
    facet normal (measured on 0x01002232 at amp 0.20: 18.4 % of fine faces, up
    to a full triangle-width of slide -- the "pale ghost wedge")."""
    V = np.asarray(V)
    F = np.array(faces, dtype=np.int64)
    frames = {}
    for ti, td in enumerate(tri_data):
        frames[ti] = TriFrame(td)

    # geometric normals of the displaced mesh
    p0 = V[F[:, 0]]
    p1 = V[F[:, 1]]
    p2 = V[F[:, 2]]
    gn = np.cross(p1 - p0, p2 - p0)
    l = np.linalg.norm(gn, axis=1, keepdims=True)
    l[l < 1e-14] = 1.0
    gn = gn / l

    # smooth the geometric normal per vertex, but only across faces of the SAME
    # source polygon, so a wall corner stays a corner.  AREA-WEIGHTED: after
    # decimation a vertex can touch one big flat triangle and a dozen tiny
    # carved ones, and an unweighted mean lets the slivers outvote the surface
    # the eye actually sees -- with normal_gain 2.5 that painted a soft
    # diagonal band right across a decimated wall.
    poly_of = np.array([tri_data[t]["poly"] for t in srctri])
    acc = {}
    if smooth:
        for fi in range(len(F)):
            key = poly_of[fi]
            g = gn[fi] * float(l[fi, 0])
            for v in F[fi]:
                k = (key, v)
                acc[k] = acc.get(k, np.zeros(3)) + g

    UVs = np.zeros((len(F), 3, 2))
    NRs = np.zeros((len(F), 3, 3))
    for fi in range(len(F)):
        ti = srctri[fi]
        fr = frames[ti]
        pts = V[F[fi]]
        if vbary is not None:
            b = np.array([vbary[int(x)].get(ti) or fr.bary(V[[int(x)]])[0]
                          for x in F[fi]], dtype=np.float64)
            uv = b @ fr.uv
            an = b @ fr.n
        else:
            uv, an = fr.attrs(pts)
        UVs[fi] = uv
        for k in range(3):
            g = acc.get((poly_of[fi], F[fi][k]), gn[fi]) if smooth else gn[fi]
            gl = np.linalg.norm(g)
            g = g / gl if gl > 1e-14 else gn[fi]
            # normal_gain was DEAD until 2026-08-16 (audit): the multiplier
            # never made it from the docstring into the body, so recipe C's
            # "sculpted normals, gain 2.5" shipped as gain 1.0 in every lane.
            n = an[k] + float(normal_gain) * (g - fr.plane_n)
            nl = np.linalg.norm(n)
            NRs[fi, k] = n / nl if nl > 1e-9 else g
    surf = np.array([tri_data[t]["poly"] for t in srctri])
    return UVs, NRs, surf


def pn_tessellate(src, level=2, skip_double_sided=True):
    """PN-triangle (curved point-normal) tessellation -- the SILHOUETTE op for
    everything the texture gate refuses: creature limbs, tree trunks, crystals.

    Crack-free by construction: every edge's cubic Bezier control points are a
    function of the two endpoint positions and their AUTHORED normals only, so
    both triangles sharing an edge generate identical points without any
    clamping.  Two-sided cards (alpha billboards) are skipped -- round 1
    measured what happens when they are not (tree_phong_ab.png).

    Returns (V, F, UV, NR, poly) like original_mesh.
    """
    n = 1 << max(0, int(level))
    V, F, UV, NR, PO = [], [], [], [], []
    P = [np.array(p) for p in src.P]
    N = []
    for x in src.N:
        v = np.array(x)
        l = np.linalg.norm(v)
        N.append(v / l if l > 1e-12 else np.array([0.0, 0.0, 1.0]))

    for pi, poly in enumerate(src.polys):
        if poly.get("invisible"):
            continue
        vids = poly["v"]
        seg = 1 if (skip_double_sided and poly["sides"] in (1, 2)) else n
        for k in range(1, len(vids) - 1):
            c = (0, k, k + 1)
            gi = [vids[x] for x in c]
            p = [P[g] for g in gi]
            nn = [N[g] for g in gi]
            uv = [np.array(poly["uv"][x]) for x in c]
            b = _pn_control(p, nn)
            base = len(V)
            grid = {}
            for i in range(seg + 1):
                for j in range(seg + 1 - i):
                    w1 = i / seg
                    w2 = j / seg
                    w0 = 1.0 - w1 - w2
                    grid[(i, j)] = len(V)
                    V.append(_pn_eval(b, w0, w1, w2))
                    NR.append(_pn_normal(nn, p, w0, w1, w2))
                    UV.append(uv[0] * w0 + uv[1] * w1 + uv[2] * w2)
            for i in range(seg):
                for j in range(seg - i):
                    a = grid[(i, j)]
                    bb = grid[(i + 1, j)]
                    cc = grid[(i, j + 1)]
                    F.append([a, bb, cc])
                    PO.append(pi)
                    if i + j + 1 < seg:
                        F.append([bb, grid[(i + 1, j + 1)], cc])
                        PO.append(pi)
            del base
    V = np.array(V)
    F = np.array(F)
    UVa = np.array([[UV[f[0]], UV[f[1]], UV[f[2]]] for f in F])
    NRa = np.array([[NR[f[0]], NR[f[1]], NR[f[2]]] for f in F])
    return V, F, UVa, NRa, np.array(PO)


def _pn_control(p, n):
    """10 cubic Bezier control points of a PN triangle."""
    def w(i, j):
        return float(np.dot(p[j] - p[i], n[i]))
    b300, b030, b003 = p[0], p[1], p[2]
    b210 = (2 * p[0] + p[1] - w(0, 1) * n[0]) / 3.0
    b120 = (2 * p[1] + p[0] - w(1, 0) * n[1]) / 3.0
    b021 = (2 * p[1] + p[2] - w(1, 2) * n[1]) / 3.0
    b012 = (2 * p[2] + p[1] - w(2, 1) * n[2]) / 3.0
    b102 = (2 * p[2] + p[0] - w(2, 0) * n[2]) / 3.0
    b201 = (2 * p[0] + p[2] - w(0, 2) * n[0]) / 3.0
    E = (b210 + b120 + b021 + b012 + b102 + b201) / 6.0
    Vv = (p[0] + p[1] + p[2]) / 3.0
    b111 = E + (E - Vv) / 2.0
    return (b300, b030, b003, b210, b120, b021, b012, b102, b201, b111)


def _pn_eval(b, w, u, v):
    (b300, b030, b003, b210, b120, b021, b012, b102, b201, b111) = b
    return (b300 * w ** 3 + b030 * u ** 3 + b003 * v ** 3
            + 3 * b210 * w * w * u + 3 * b120 * w * u * u
            + 3 * b021 * u * u * v + 3 * b012 * u * v * v
            + 3 * b102 * w * v * v + 3 * b201 * w * w * v
            + 6 * b111 * w * u * v)


def _pn_normal(n, p, w, u, v):
    """Quadratic PN normal (n200..n002 scheme)."""
    def nij(i, j):
        d = p[j] - p[i]
        s = n[i] + n[j]
        vv = 2.0 * float(np.dot(d, s)) / float(np.dot(d, d)) if np.dot(d, d) > 1e-12 else 0.0
        r = s - vv * d
        l = np.linalg.norm(r)
        return r / l if l > 1e-12 else s / max(np.linalg.norm(s), 1e-12)
    n110 = nij(0, 1)
    n011 = nij(1, 2)
    n101 = nij(2, 0)
    r = (n[0] * w * w + n[1] * u * u + n[2] * v * v
         + n110 * w * u + n011 * u * v + n101 * w * v)
    l = np.linalg.norm(r)
    return r / l if l > 1e-12 else n[0]


def original_mesh(src):
    """The authored mesh as (V, faces, uv, normals, poly index) for the LEFT
    panel -- same renderer, same texture, no displacement."""
    V = np.array(src.P, dtype=np.float64)
    faces, UV, NR, poly = [], [], [], []
    for pi, p in enumerate(src.polys):
        if p.get("invisible"):
            continue
        vids = p["v"]
        for k in range(1, len(vids) - 1):
            c = (0, k, k + 1)
            faces.append([vids[c[0]], vids[c[1]], vids[c[2]]])
            UV.append([p["uv"][c[0]], p["uv"][c[1]], p["uv"][c[2]]])
            NR.append([src.N[vids[c[0]]], src.N[vids[c[1]]], src.N[vids[c[2]]]])
            poly.append(pi)
    return (V, np.array(faces), np.array(UV), np.array(NR), np.array(poly))


def facet_op(src, amp=0.03, rounds=1, size_scale=0.12, max_amp=MAX_AMPLITUDE_M):
    """The FACET op: replace each triangle with a shallow three-sided pyramid.

    For gems, crystals, hewn rock and any flat-shaded prop the texture gate
    refuses, this is the op that actually spends triangles usefully: PN
    tessellation is a geometric NO-OP on flat-shaded geometry (its control
    points collapse into the plane), which is precisely round 1's "10x
    triangles, identical picture".  A raised centroid changes the facet normal
    of every emitted triangle, so Gouraud has something new to shade, and no
    edge moves, so no crack can open and the silhouette corners are exact.

    3x triangles per round.
    """
    V, F, UV, NR, PO = original_mesh(src)
    V = [tuple(p) for p in V]
    F = [list(f) for f in F]
    UV = [u for u in UV]
    NR = [n for n in NR]
    PO = list(PO)
    for _ in range(max(1, rounds)):
        nV, nF, nUV, nNR, nPO = V[:], [], [], [], []
        for fi, f in enumerate(F):
            p = [np.array(V[f[k]]) for k in range(3)]
            uv = UV[fi]
            nr = NR[fi]
            c = (p[0] + p[1] + p[2]) / 3.0
            n = np.array(nr).mean(axis=0)
            l = np.linalg.norm(n)
            if l < 1e-12:
                n = np.cross(p[1] - p[0], p[2] - p[0])
                l = np.linalg.norm(n)
            n = n / l if l > 1e-12 else np.array([0.0, 0.0, 1.0])
            # rise scales with the facet's own size, capped
            r = np.sqrt(0.5 * np.linalg.norm(np.cross(p[1] - p[0], p[2] - p[0])))
            a = min(max_amp, min(amp, size_scale * r))
            ci = len(nV)
            nV.append(tuple(c + n * a))
            cuv = tuple(np.array(uv).mean(axis=0))
            for k in range(3):
                k2 = (k + 1) % 3
                nF.append([f[k], f[k2], ci])
                nUV.append([tuple(uv[k]), tuple(uv[k2]), cuv])
                e0 = np.array(nr[k])
                e1 = np.array(nr[k2])
                tn = np.cross(np.array(V[f[k2]]) - np.array(V[f[k]]),
                              np.array(nV[ci]) - np.array(V[f[k]]))
                tl = np.linalg.norm(tn)
                tn = tn / tl if tl > 1e-12 else n
                nNR.append([tuple(e0 + (tn - n)), tuple(e1 + (tn - n)), tuple(tn)])
                nPO.append(PO[fi])
        V, F, UV, NR, PO = nV, nF, nUV, nNR, nPO
    return (np.array(V), np.array(F), np.array(UV), np.array(NR), np.array(PO))
