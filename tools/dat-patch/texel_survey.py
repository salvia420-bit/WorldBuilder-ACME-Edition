#!/usr/bin/env python3
"""texel_survey.py -- Phase-4 lane 4.H4: texel-starvation survey (measure-first gate).

Research: docs/dat-patch/research/highres-terrain-lanes-research.md section 3.
4096-square world textures ARE loadable (no client dimension cap -- dims pass
verbatim to D3D9, DECOMP:685242), but the client's 4-LEVEL MIP CLAMP
(ImgTex::CreateD3DTexture, `if (v16 > 4) NumMipLevels = 4`, DECOMP:366125) makes
an un-patched 4096-square alias badly once it is minified below 512-square.  So a
4096 record only earns its bytes on a surface that is TEXEL-STARVED at typical
view distance AND stays near-field enough that its selected mip never drops below
512-square.  This tool measures the first half from the dats and reports the
short list.

DEFINITION (research 3.2):
  world_units_per_texel   = face_world_edge / (uv_span * texture_edge)
  world_units_per_pixel_D = 2 * D * tan(fov/2) / screen_height
  starved  <=>  world_units_per_texel > world_units_per_pixel_D
             (texture coarser than the screen at distance D)
  texels_per_screen_pixel = world_units_per_pixel_D / world_units_per_texel   ( <1 = starved )

The mesh half -- world_units_per_uv = face_world_edge / uv_span -- is INTRINSIC to
the mesh+UVs and fully derivable read-only.  world_units_per_texel then follows
for ANY assumed texture edge, so we score at the 2048 shipped ceiling (a 4096
candidate must be starved even at 2048, research 3.2) and also report what 4096
would buy.

COVERAGE (both surface populations are measured):
  * 0x01 GfxObj surfaces -- props / scenery / building structures.  poly.pos
    indexes the GfxObj's OWN surface list.
  * 0x0D dungeon-interior surfaces -- via the cell dat: each EnvCell
    (0x____0100..0x____FFFD) carries a per-cell surface array + an Environment id
    + a CellStruct index; the CellStruct mesh lives in the Environment (0x0D)
    record, and a CellStruct poly's pos resolves through EACH EnvCell's own
    surface array (per-cell indirection -- one prefab room, different textures
    per placement; geometry-lanes-research.md sec 4a, env_geo._cell_walk).
  NOT covered: outdoor terrain landscape (runtime-composited, no static RS -- and
    handled by the separate terrain lanes) and weenie-spawned statics (not placed
    in the cell dat).

THE ONE INPUT THIS CANNOT GET FROM THE DATS: the true per-surface dwell / view
distance D.  That needs world PLACEMENT + camera/player-path data (LandBlock /
Scene placement + where players actually stand), which is NOT in the 0x01/0x0D
geometry records.  So D is handled two ways, both reported:
  (a) a size-based heuristic D per surface (you view a thing from ~k x its extent),
      clamped to [--dmin, --dmax];
  (b) the PLACEMENT-INDEPENDENT crossover distance D_crit = the distance beyond
      which the surface stops being starved at 2048.  Ranking by D_crit needs no
      view-distance assumption at all -- a surface starved out to a large D_crit
      is starved from far away, the strongest 4096 candidate.

THIS FILE MODIFIES NO CORE LANE.  It reuses gfxlib / datlib / texture_lane
(rs_header) read-only.  It ships NOTHING -- it only measures and ranks.

usage:
  texel_survey.py --base DAT [--cell CELLDAT|none] [--out JSON] [--edge 2048]
                  [--fov 63.5] [--screen-h 1080] [--dmin 2] [--dmax 30] [--k 3]
                  [--limit N] [--cell-limit N] [--top 60]
"""
import argparse
import json
import math
import os
import struct
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import datlib
import gfxlib
import texture_lane as TL   # rs_header (read-only)

DEFAULT_BASE = "/home/wbterminal/ac_base_dats/client_portal.dat"


def _edge_len(a, b):
    return math.sqrt(sum((a[i] - b[i]) ** 2 for i in range(len(a))))


def _uv_len(a, b):
    return math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2)


def _poly_geom(Pk, UVk, poly):
    """(best_world_units_per_uv, world_area, max_world_edge) for one drawing
    polygon, or None if it has no usable textured geometry.  Pk/UVk map a vertex
    id -> position tuple / UV-list.  Same math as the GfxObj handle_mesh path;
    factored out so the EnvCell (0x0D) walk reuses it exactly."""
    vids = poly["v"]
    uvi = poly["uvi"]
    n = len(vids)
    if n < 3:
        return None
    pos = [Pk(v) for v in vids]
    if any(p is None for p in pos):
        return None
    area = 0.0
    for k in range(1, n - 1):
        ax = (pos[k][0] - pos[0][0], pos[k][1] - pos[0][1], pos[k][2] - pos[0][2])
        bx = (pos[k + 1][0] - pos[0][0], pos[k + 1][1] - pos[0][1], pos[k + 1][2] - pos[0][2])
        cx = (ax[1] * bx[2] - ax[2] * bx[1],
              ax[2] * bx[0] - ax[0] * bx[2],
              ax[0] * bx[1] - ax[1] * bx[0])
        area += 0.5 * math.sqrt(cx[0] ** 2 + cx[1] ** 2 + cx[2] ** 2)
    if area <= 0:
        return None
    best = 0.0
    world = 0.0
    ok = False
    for k in range(n):
        v0, v1 = vids[k], vids[(k + 1) % n]
        p0, p1 = Pk(v0), Pk(v1)
        uv0, uv1 = UVk(v0), UVk(v1)
        if p0 is None or p1 is None or uv0 is None or uv1 is None:
            continue
        try:
            a0 = uv0[uvi[k]]
            a1 = uv1[uvi[(k + 1) % n]]
        except IndexError:
            continue
        wl = _edge_len(p0, p1)
        ul = _uv_len(a0, a1)
        if ul < 1e-4 or wl < 1e-4:
            continue
        if wl / ul > best:
            best = wl / ul
        if wl > world:
            world = wl
        ok = True
    if not ok:
        return None
    return best, area, world


def collect(dat, portal, cell_dat=None, limit=0, cell_limit=0):
    """Walk every GfxObj (0x01) + Environment (0x0D) drawing polygon, resolve its
    RenderSurface, and accumulate area-weighted world_units_per_uv per RS.
    Returns {rs_hex: dict(samples, area, wupu_num, wupu_den, max_world_edge,
                          obj_max_diag, ntris)}."""
    import collections
    acc = collections.defaultdict(lambda: dict(
        area=0.0, wupu_num=0.0, wupu_den=0.0, max_world_edge=0.0,
        obj_max_diag=0.0, npolys=0, nobjs=set()))

    def surf_rs(surfaces, pos):
        if pos is None or pos < 0 or pos >= len(surfaces):
            return None
        sid = surfaces[pos]
        s = portal.surface(sid)
        if not s:
            return None
        return s.get("rsId")

    def handle_mesh(oid, P_by_key, UV_by_key, idx, surfaces, polys):
        # object diagonal (a view-distance proxy)
        if P_by_key:
            xs = [p[0] for p in P_by_key]; ys = [p[1] for p in P_by_key]; zs = [p[2] for p in P_by_key]
            diag = math.sqrt((max(xs) - min(xs)) ** 2 + (max(ys) - min(ys)) ** 2 + (max(zs) - min(zs)) ** 2)
        else:
            diag = 0.0
        # index maps key->position array offset; gfxlib stores P as list indexed
        # by position with idx{key->i}. Build position lookup by vertex-id (key).
        def Pk(vid):
            i = idx.get(vid)
            return P_by_key[i] if i is not None else None
        def UVk(vid):
            i = idx.get(vid)
            return UV_by_key[i] if i is not None else None
        for poly in polys:
            rs = surf_rs(surfaces, poly.get("pos"))
            if not rs:
                continue
            # resolve edges directly by vertex id (key)
            vids = poly["v"]; uvi = poly["uvi"]; n = len(vids)
            if n < 3:
                continue
            best_wupu = 0.0; poly_world = 0.0; ok = False
            # world area of the poly (fan) for weighting
            pos = [Pk(v) for v in vids]
            if any(p is None for p in pos):
                continue
            area = 0.0
            for k in range(1, n - 1):
                ax = (pos[k][0] - pos[0][0], pos[k][1] - pos[0][1], pos[k][2] - pos[0][2])
                bx = (pos[k + 1][0] - pos[0][0], pos[k + 1][1] - pos[0][1], pos[k + 1][2] - pos[0][2])
                cx = (ax[1] * bx[2] - ax[2] * bx[1],
                      ax[2] * bx[0] - ax[0] * bx[2],
                      ax[0] * bx[1] - ax[1] * bx[0])
                area += 0.5 * math.sqrt(cx[0] ** 2 + cx[1] ** 2 + cx[2] ** 2)
            for k in range(n):
                v0, v1 = vids[k], vids[(k + 1) % n]
                p0, p1 = Pk(v0), Pk(v1)
                uv0, uv1 = UVk(v0), UVk(v1)
                if p0 is None or p1 is None or uv0 is None or uv1 is None:
                    continue
                try:
                    a0 = uv0[uvi[k]]; a1 = uv1[uvi[(k + 1) % n]]
                except IndexError:
                    continue
                wl = _edge_len(p0, p1); ul = _uv_len(a0, a1)
                if ul < 1e-4 or wl < 1e-4:
                    continue
                r = wl / ul
                if r > best_wupu:
                    best_wupu = r
                poly_world = max(poly_world, wl)
                ok = True
            if not ok or area <= 0:
                continue
            a = acc[rs]
            a["wupu_num"] += best_wupu * area
            a["wupu_den"] += area
            a["area"] += area
            a["max_world_edge"] = max(a["max_world_edge"], poly_world)
            a["obj_max_diag"] = max(a["obj_max_diag"], diag)
            a["npolys"] += 1
            a["nobjs"].add(oid)

    ids = sorted(dat.files.keys())
    gfx_ids = [i for i in ids if (i >> 24) == 0x01]
    if limit:
        gfx_ids = gfx_ids[:limit]
    t0 = time.time()
    ng = 0
    for gid in gfx_ids:
        try:
            rec = portal.gfx(gid)
        except Exception:
            continue
        handle_mesh(gid, rec["P"], rec["UV"], rec["idx"], rec["surfaces"], rec["polys"])
        ng += 1
        if ng % 2000 == 0:
            print("  gfxobj %d/%d (%.0fs)" % (ng, len(gfx_ids), time.time() - t0), flush=True)

    # ---- 0x0D dungeon-interior surfaces via EnvCell (cell dat) -> Environment
    # CellStruct.  The Environment (0x0D) record itself has NO surface ids: a
    # CellStruct polygon's surface slot (poly.pos) resolves through EACH EnvCell's
    # OWN surface array, so one prefab CellStruct renders stone in one dungeon and
    # ice in another (geometry-lanes-research.md sec 4a; env_geo._cell_walk).  We
    # walk EnvCells, cache the per-(env,cs) polygon geometry, and bind surfaces
    # per cell.
    ncell = ncell_used = 0
    if cell_dat and os.path.exists(cell_dat):
        cdat = datlib.Dat(cell_dat)
        geom_cache = {}   # (env_id, cs) -> (list[(slot, wupu, area, world)], diag)

        def cs_geom(env_id, cs):
            g = geom_cache.get((env_id, cs))
            if g is not None:
                return g
            polys_g = []
            diag = 0.0
            try:
                cells = portal.env(env_id)
            except Exception:
                cells = None
            c = cells.get(cs) if cells else None
            if c:
                P, UV, idx = c["P"], c["UV"], c["idx"]
                if P:
                    xs = [p[0] for p in P]; ys = [p[1] for p in P]; zs = [p[2] for p in P]
                    diag = math.sqrt((max(xs) - min(xs)) ** 2 + (max(ys) - min(ys)) ** 2
                                     + (max(zs) - min(zs)) ** 2)

                def Pk(v):
                    i = idx.get(v)
                    return P[i] if i is not None else None

                def UVk(v):
                    i = idx.get(v)
                    return UV[i] if i is not None else None

                for poly in c["polys"]:
                    gm = _poly_geom(Pk, UVk, poly)
                    if gm is not None:
                        polys_g.append((poly.get("pos"), gm[0], gm[1], gm[2]))
            g = (polys_g, diag)
            geom_cache[(env_id, cs)] = g
            return g

        cell_ids = [o for o in cdat.files if 0x100 <= (o & 0xFFFF) <= 0xFFFD]
        if cell_limit:
            cell_ids = cell_ids[:cell_limit]
        for oid in cell_ids:
            raw = cdat.get(oid)
            if raw is None or len(raw) < 16:
                continue
            ns = raw[12]
            try:
                surfs = struct.unpack_from("<%dH" % ns, raw, 16)
                env16, cs = struct.unpack_from("<2H", raw, 16 + 2 * ns)
            except struct.error:
                continue
            polys_g, diag = cs_geom(0x0D000000 | env16, cs)
            touched = False
            for slot, wupu, area, world in polys_g:
                if slot is None or slot < 0 or slot >= ns:
                    continue
                s = portal.surface(0x08000000 | surfs[slot])
                if not s:
                    continue
                rs = s.get("rsId")
                if not rs:
                    continue
                a = acc[rs]
                a["wupu_num"] += wupu * area
                a["wupu_den"] += area
                a["area"] += area
                a["max_world_edge"] = max(a["max_world_edge"], world)
                a["obj_max_diag"] = max(a["obj_max_diag"], diag)
                a["npolys"] += 1
                a["nobjs"].add(oid)
                touched = True
            ncell += 1
            ncell_used += 1 if touched else 0
            if ncell % 20000 == 0:
                print("  envcell %d/%d (%.0fs)" % (ncell, len(cell_ids), time.time() - t0),
                      flush=True)
    else:
        print("  WARNING: no cell dat -> 0x0D dungeon-interior surfaces NOT measured")

    print("collect: %d gfxobjs, %d envcells (%d textured) scanned, %d surfaces touched (%.0fs)"
          % (ng, ncell, ncell_used, len(acc), time.time() - t0))
    # finalize nobjs -> count
    for rs, a in acc.items():
        a["nobjs"] = len(a["nobjs"])
    return acc


def rs_dims(dat, rs_hex):
    try:
        h = TL.rs_header(dat, int(rs_hex, 16))
    except Exception:
        return None
    if not h:
        return None
    return dict(w=h["w"], h=h["h"], fmt=h["fmtname"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=DEFAULT_BASE)
    ap.add_argument("--cell", default=None,
                    help="cell dat for the 0x0D dungeon-interior (EnvCell) walk; "
                         "default = client_cell_1.dat beside --base. Pass 'none' to skip.")
    ap.add_argument("--cell-limit", type=int, default=0,
                    help="cap EnvCells scanned (0 = all); use a small value for a "
                         "light verification run without the full cell-dat sweep")
    ap.add_argument("--out", default="/mnt/wbterminal2/detail-texture-4h2-2026-08-20/texel-survey.json")
    ap.add_argument("--edge", type=int, default=2048,
                    help="shipped-ceiling texture edge to score against (research: "
                         "a 4096 candidate must be starved even at 2048)")
    ap.add_argument("--fov", type=float, default=63.5, help="vertical FOV degrees (retail default)")
    ap.add_argument("--screen-h", type=int, default=1080)
    ap.add_argument("--dmin", type=float, default=2.0)
    ap.add_argument("--dmax", type=float, default=30.0)
    ap.add_argument("--k", type=float, default=3.0, help="view distance ~= k * object diagonal")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--top", type=int, default=60)
    ap.add_argument("--max-face-edge", type=float, default=12.0,
                    help="near-field guard: exclude surfaces whose largest textured "
                         "face edge exceeds this (m). A single face spanning tens of "
                         "metres is landscape/sky/backdrop -- viewed at a distance the "
                         "size-heuristic D cannot capture, and 4096 cannot resolve it. "
                         "This is a PROXY for the missing true view-distance data.")
    ap.add_argument("--resolve-min", type=float, default=0.5,
                    help="require 4096 to lift texels/pixel to at least this at D "
                         "(else 4096 is a rounding error on a hopelessly stretched face)")
    a = ap.parse_args()

    os.environ.setdefault("DATPATCH_PORTAL", a.base)
    dat = datlib.Dat(a.base)
    portal = gfxlib.Portal(a.base)

    if a.cell is None:
        cell_dat = os.path.join(os.path.dirname(os.path.abspath(a.base)), "client_cell_1.dat")
    elif a.cell.lower() == "none":
        cell_dat = None
    else:
        cell_dat = a.cell

    acc = collect(dat, portal, cell_dat=cell_dat, limit=a.limit, cell_limit=a.cell_limit)

    tan_half = math.tan(math.radians(a.fov) / 2.0)
    # world units per screen pixel at distance D
    def wupp(D):
        return 2.0 * D * tan_half / a.screen_h

    rows = []
    for rs, a_ in acc.items():
        if a_["wupu_den"] <= 0:
            continue
        wupu = a_["wupu_num"] / a_["wupu_den"]           # world units per UV unit (tex-indep)
        wupt = wupu / a.edge                              # world units per texel @ eval edge
        # heuristic per-surface view distance from object size
        D = min(a.dmax, max(a.dmin, a.k * a_["obj_max_diag"] if a_["obj_max_diag"] > 0 else a.dmin))
        tps = wupp(D) / wupt if wupt > 0 else float("inf")   # texels per screen pixel @ D, edge
        # placement-independent crossover: D beyond which NOT starved at eval edge
        d_crit = wupt * a.screen_h / (2.0 * tan_half)
        # what 4096 would buy at the same D
        wupt_4k = wupu / 4096.0
        tps_4k = wupp(D) / wupt_4k if wupt_4k > 0 else float("inf")
        # mip-clamp safety at 4096 & D: selected mip level ~ log2(tps_4k) clamped>=0;
        # selected mip edge = 4096 / 2^L must stay >= 512  => L <= 3.
        L = max(0, round(math.log2(tps_4k))) if tps_4k > 0 else 0
        mip_edge_4k = 4096 / (2 ** L)
        mip_safe = mip_edge_4k >= 512
        dims = rs_dims(dat, rs)
        rows.append(dict(
            rs=rs, retail_dims=(("%dx%d %s" % (dims["w"], dims["h"], dims["fmt"])) if dims else None),
            world_units_per_uv=round(wupu, 4),
            wupt_at_edge=round(wupt, 6),
            D_heuristic=round(D, 2),
            texels_per_pixel_at_2048=round(tps, 3),
            texels_per_pixel_at_4096=round(tps_4k, 3),
            starved_at_2048=bool(tps < 1.0),
            D_crit_meters=round(d_crit, 2),
            mip_edge_at_4096=int(mip_edge_4k),
            mip_clamp_safe_4096=bool(mip_safe),
            world_area=round(a_["area"], 2),
            max_face_world_edge=round(a_["max_world_edge"], 3),
            obj_diag=round(a_["obj_max_diag"], 2),
            nobjs=a_["nobjs"], npolys=a_["npolys"],
            near_field=bool(a_["max_world_edge"] <= a.max_face_edge),
            resolves_at_4096=bool(tps_4k >= a.resolve_min),
            # raw candidate = the literal research definition (starved@2048 + mip-safe)
            candidate_4096_raw=bool(tps < 1.0 and mip_safe),
            # defensible candidate = raw + near-field proxy + 4096 actually resolves it
            candidate_4096=bool(tps < 1.0 and mip_safe
                                and a_["max_world_edge"] <= a.max_face_edge
                                and tps_4k >= a.resolve_min)))

    # rank the SHORT LIST: starved at 2048 AND mip-clamp-safe, by severity
    # (lowest texels/pixel, i.e. coarsest), tie-broken by D_crit and screen area.
    cands = [r for r in rows if r["candidate_4096"]]
    # rank by exposure: coarsest first among the near-field resolvable set, then
    # by how many objects show it (screen-time proxy) and screen area.
    cands.sort(key=lambda r: (r["texels_per_pixel_at_2048"], -r["nobjs"], -r["world_area"]))
    raw_cands = [r for r in rows if r["candidate_4096_raw"]]
    # also a placement-independent ranking by D_crit
    by_dcrit = sorted(rows, key=lambda r: -r["D_crit_meters"])

    out = dict(
        lane="4.H4-texel-starvation-survey",
        base=a.base, cell=cell_dat, eval_edge=a.edge, fov=a.fov, screen_h=a.screen_h,
        coverage=("0x01 GfxObj surfaces (props/scenery/structures) AND 0x0D "
                  "dungeon-interior surfaces via the EnvCell(cell dat)->Environment "
                  "CellStruct walk with per-cell surface indirection"
                  + ("" if cell_dat else " [DISABLED: no cell dat -> dungeon surfaces "
                     "NOT measured this run]")),
        not_covered=("outdoor terrain landscape (composited at runtime, no static RS) "
                     "and weenie-spawned statics (not placed in the cell dat)"),
        D_model="heuristic D = clamp(%g x obj_diag, %g, %g) m; D_crit is placement-independent"
                % (a.k, a.dmin, a.dmax),
        missing_input="true per-surface dwell/view distance (needs LandBlock/Scene "
                      "placement + player-path/camera data, not in the geometry records); "
                      "handled via size heuristic + placement-independent D_crit",
        near_field_guard_m=a.max_face_edge, resolve_min=a.resolve_min,
        surfaces_measured=len(rows),
        raw_candidates_starved_and_mipsafe=len(raw_cands),
        candidates_defensible=len(cands),
        short_list=cands[:a.top],
        raw_short_list=sorted(raw_cands, key=lambda r: r["texels_per_pixel_at_2048"])[:a.top],
        top_by_Dcrit=by_dcrit[:a.top])
    json.dump(out, open(a.out, "w"), indent=1)
    print("\nsurvey: %d surfaces measured" % len(rows))
    print("  raw candidates (starved@2048 + mip-safe@4096, research letter): %d" % len(raw_cands))
    print("  defensible candidates (+ near-field <=%gm + 4096 resolves to >=%g): %d"
          % (a.max_face_edge, a.resolve_min, len(cands)))
    print("wrote %s" % a.out)
    print("\nDEFENSIBLE SHORT LIST (near-field, 4096 actually helps), coarsest first:")
    print("  %-12s %8s %8s %8s %7s %5s %6s  %s" %
          ("RS", "tps2048", "tps4096", "faceEdge", "Dcrit", "nobj", "npoly", "retail_dims"))
    for r in cands[:min(a.top, 40)]:
        print("  %-12s %8.3f %8.3f %8.2f %7.1f %5d %6d  %s" %
              (r["rs"], r["texels_per_pixel_at_2048"], r["texels_per_pixel_at_4096"],
               r["max_face_world_edge"], r["D_crit_meters"], r["nobjs"], r["npolys"],
               r["retail_dims"]))
    if not cands:
        print("  (empty -- no near-field surface is starved at the 2048 ceiling under these params)")


if __name__ == "__main__":
    main()
