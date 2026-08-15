#!/usr/bin/env python3
"""tranche.py -- the production runner for the STATIC-ARCHITECTURE tranche.

Generalises `pilot.py` (hardcoded to the 18 building GfxObjs of the 7x7-LB
Holtburg window) to the whole world's static architecture -- the ~2,000-record
lane of docs/dat-patch/reports/concepts-r2-REPORT.md section 6.3 -- with the
byte-budget, resume, parallelism and LOD-correctness knobs a batch of that size
needs.  The geometry recipe itself is UNCHANGED (recipe C, imported from
pilot.py so there is exactly one copy of it).

    tranche.py enumerate --root DIR [...]   -> models.json + degrade_deferred.json
    tranche.py build     --root DIR [...]   -> obj/*.obj + imports.jsonl + build_stats.json

Then (driver_buildbox.sh does this for you):
    dotnet WorldBuilder.Terminal.dll --stdin -p DIR/proj/*.wbproj < DIR/imports.jsonl
    validate.py --root DIR

--------------------------------------------------------------------- the tranche
`enumerate` walks EVERY LandBlockInfo (0x____FFFE) record in client_cell_1.dat
and takes both static-placement lists:

  * `buildings[]` -- the structures with interiors/portals   -> class "building"
  * `objects[]`   -- the landblock's static objects (walls, bridges, gates,
                     fences, signposts, ...)                 -> class "structure"

Model ids are 0x01 GfxObj or 0x02 Setup; Setups are resolved to their parts.
Measured on the retail dats: 5,346 LBInfo records -> 398 building models
(6,979 placements) + 1,475 object models (42,942 placements) -> 1,921 distinct
GfxObjs.  That IS the "~2,000 large statics" lane.

Three filters then run, each of which REPORTS rather than silently drops:
  1. `--min-tris` (default 50): r2's "skip the ~10,700 <=50-tri props" -- at
     that size the source mesh is already at texel scale (r2 section 5) and the
     texture lane covers it for free.               -> route "skip-small"
  2. the DEGRADE GUARD (see below).                 -> route "skip-degrade"
  3. the surface gate (matlib.classify + the height router): a record with no
     carving surface has nothing to displace.       -> route "skip-gate"

------------------------------------------------------------- the DEGRADE GUARD
client-headroom-dossier.md section 5a, decomp-verified: when a GfxObj carries a
GfxObjDegradeInfo record, `CPhysicsPart::LoadGfxObjArray` fills the draw array
EXCLUSIVELY from the degrade bands -- the root GfxObj is never inserted at any
index, INCLUDING 0.  Band 0 is frequently a different object.  So patching a
carrier whose band 0 is not itself is COMPLETELY INVISIBLE in the retail client,
at every distance, and would burn bytes for nothing.  Nobody has ever hit this
(discord-headroom-crosscheck.md) -- we would be first.

v1 policy, implemented here:
  * no degrade record            -> patch normally (loader's null path = "root
                                    mesh at every distance", verified);
  * degrade record, band0 == me  -> patch normally.  gfxobj[0] resolves to this
                                    record, so the patched mesh IS what draws in
                                    the nearest band.  (Bands 1+ stay retail --
                                    that is the intended LOD behaviour, and the
                                    handoff notes it as a visibility RANGE, not
                                    a correctness problem.)
  * degrade record, band0 != me  -> EXCLUDE, and write the record plus its band
                                    object ids to degrade_deferred.json for the
                                    follow-up lane, which patches band objects
                                    directly.
Counts are printed loudly at the end of both `enumerate` and `build`, and the
guard is RE-CHECKED in `build` (belt and braces: a hand-edited models.json must
not be able to slip a carrier through).

Measured on the retail dats over the 1,921-record tranche: 1,310 carriers, of
which 1,301 are their own band 0 and 9 are not.  The guard is cheap and the 9
would have been invisible bytes.

-------------------------------------------------------------------- the budget
`--plan plan.json` (from budget_planner.py) caps the geometry spend.  Every
record is costed at `--bytes-per-tri` (default 106 B, the pilot's MEASURED
per-added-triangle cost) x its added triangles.  Records are taken in value
order (placements first, then size); the first record that does not fit STOPS
the run cleanly and every remaining record is written to the report with reason
"budget-exhausted".  No silent caps, no partial-mesh fallbacks.

------------------------------------------------------------------ per-record mult
r2 section 6.3 budgets architecture at 4-6x.  4x is the knee for a mesh whose
vertex spacing is already fine; a bridge module at 4.5 m spacing (r2 section 5)
is nowhere near it, so coarse records get the extra.  The ramp is on the vertex
spacing the 4x budget would buy:  > 1.5 m -> 6x,  > 0.9 m -> 5x,  else 4x.

---------------------------------------------------------------------- resume
`build` is resumable: each finished record writes state/<gid>.json holding the
sha256 of (base record bytes + every recipe parameter).  A re-run skips a record
only when that hash still matches AND its .obj is on disk; imports.jsonl is
rebuilt from the state directory each time, so a killed run resumes cleanly and
still emits a complete import batch.

------------------------------------------------------------------- parallelism
`--jobs N` (default cpu_count-1) uses a SPAWNED pool -- forked workers would
share the dat file descriptor and race on seek().  Height fields are computed
ONCE PER RenderSurface in a warm-up phase before the per-record work fans out
(HANDOFF TODO #5: "fields are per-texture, not per-record"); after that
pipeline's per-Surface memo keeps them in RAM inside each worker.
"""
import argparse
import hashlib
import json
import multiprocessing as mp
import os
import struct
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

# Recipe identity.  Any change to the geometry recipe MUST bump this, or resume
# will happily keep stale OBJs from the previous recipe.
RECIPE_VERSION = "C-2026-08-15"

MIB = 1024 * 1024
DEFAULT_BYTES_PER_TRI = 106.0        # pilot-measured
DEFAULT_MIN_TRIS = 50                # r2 6.3 long-tail cut
MULT_MIN, MULT_MAX = 4.0, 6.0        # r2 6.3 architecture band

# Lazily bound by _setup(): datlib, gfxlib, pipeline, relief3d, pilot.
datlib = gfxlib = pipeline = relief3d = pilot = None


# ------------------------------------------------------------------- plumbing
def _setup(args):
    """Point the vendored modules at this run's dats, then import them."""
    global datlib, gfxlib, pipeline, relief3d, pilot
    os.environ["DATPATCH_PORTAL"] = args.portal
    os.environ["DATPATCH_CELL"] = args.cell
    if args.hcache:
        os.environ["DATPATCH_HCACHE"] = args.hcache
    import datlib as _d
    import gfxlib as _g
    import pipeline as _p
    import relief3d as _r
    import pilot as _pi
    datlib, gfxlib, pipeline, relief3d, pilot = _d, _g, _p, _r, _pi
    pipeline.memo_enabled = True
    if pipeline.P.path != args.portal:            # module-level default lost
        pipeline.P = gfxlib.Portal(args.portal)


def _paths(args):
    r = os.path.abspath(args.root)
    return dict(root=r,
                models=os.path.join(r, "models.json"),
                deferred=os.path.join(r, "degrade_deferred.json"),
                report=os.path.join(r, "tranche_report.json"),
                obj=os.path.join(r, "obj"),
                state=os.path.join(r, "state"),
                imports=os.path.join(r, "imports.jsonl"),
                stats=os.path.join(r, "build_stats.json"),
                export=os.path.join(r, "export"))


def _write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, indent=1)
    os.replace(tmp, path)


def hexid(v):
    return "0x%08X" % v


# ----------------------------------------------------------------- enumerate
def _lbinfo_ids(cd, window):
    ids = [i for i in cd.files if (i & 0xFFFF) == 0xFFFE]
    if window:
        ids = [i for i in ids if (i >> 16) in window]
    return sorted(ids)


def _parse_window(spec):
    """'A6-AC,B1-B7' -> the set of landblock (x<<8|y) keys in that tile box."""
    if not spec:
        return None
    xs, ys = spec.split(",")

    def rng(s):
        if "-" in s:
            a, b = s.split("-")
            return range(int(a, 16), int(b, 16) + 1)
        return [int(s, 16)]
    return {(x << 8) | y for x in rng(xs) for y in rng(ys)}


def _collect_placements(cd, window):
    """-> (building_models, object_models) as {modelId: placement count}."""
    bld, obj = {}, {}
    errors = []
    for rid in _lbinfo_ids(cd, window):
        try:
            info = pilot.parse_lbinfo(cd.get(rid))
        except Exception as ex:                       # pragma: no cover
            errors.append((hexid(rid), str(ex)[:120]))
            continue
        for mid, _o, _q in info["buildings"]:
            bld[mid] = bld.get(mid, 0) + 1
        for mid, _o, _q in info["objects"]:
            obj[mid] = obj.get(mid, 0) + 1
    return bld, obj, errors


def _mult_for(area, n0):
    """r2 6.3's 4-6x architecture band, ramped on the vertex spacing 4x buys."""
    if n0 <= 0 or area <= 0:
        return MULT_MIN
    spacing = (2.0 * area / (MULT_MIN * n0)) ** 0.5
    if spacing > 1.5:
        return MULT_MAX
    if spacing > 0.9:
        return 5.0
    return MULT_MIN


def _gate_one(gid):
    """Worker: surface gate + geometry facts for one GfxObj. Never raises."""
    try:
        src, metas, rec = pipeline.gfx_source(gid)
        n0 = src.tri_count()
        area = src.area()
        carve_sids = sorted(hexid(s) for s, m in metas.items()
                            if m.get("h") is not None and m.get("amp", 0) > 0)
        carving = sum(1 for p in src.polys
                      if p.get("h") is not None and p.get("amp", 0) > 0
                      and not p.get("excluded") and not p.get("invisible"))
        return dict(gid=gid, ok=True, tris=n0, area=round(area, 2),
                    verts=len(rec["P"]), carvingPolys=carving,
                    carveSurfaces=carve_sids, zeroNormals=src.substituted_normals,
                    surfaces={hexid(s): dict(cls=m["cls"], why=m["why"],
                                             amp=round(m.get("amp", 0), 4),
                                             op=m.get("op"),
                                             carved=round(m.get("carved", 0), 3))
                              for s, m in metas.items()})
    except Exception as ex:
        return dict(gid=gid, ok=False, why=str(ex)[:200])


def _warm_one(rs):
    """Worker: compute+cache one RenderSurface height field (the per-TEXTURE
    cache of HANDOFF TODO #5).  Returns (rs, carved_fraction or None)."""
    import matlib
    try:
        h, _src = matlib.height_for(rs, False, 512)
        return (rs, None if h is None else round(matlib.carved_fraction(h), 3))
    except Exception:
        return (rs, None)


def _pool(args, initializer_args):
    ctx = mp.get_context("spawn")
    return ctx.Pool(args.jobs, initializer=_worker_init,
                    initargs=(initializer_args,))


def _worker_init(args_ns):
    _setup(args_ns)


def cmd_enumerate(args):
    p = _paths(args)
    os.makedirs(p["root"], exist_ok=True)
    t0 = time.time()
    cd = datlib.Dat(args.cell)
    window = _parse_window(args.window)
    bld_models, obj_models, lb_errors = _collect_placements(cd, window)
    print("[enumerate] LBInfo scanned: %d | building models %d (%d placements) "
          "| object models %d (%d placements)"
          % (len(_lbinfo_ids(cd, window)), len(bld_models),
             sum(bld_models.values()), len(obj_models), sum(obj_models.values())))

    # model -> GfxObj, keeping the class and the placement count
    cand = {}
    for models, cls in ((bld_models, "building"), (obj_models, "structure")):
        for mid, cnt in models.items():
            for gid in pilot.resolve_gfx(mid, pipeline.P):
                e = cand.setdefault(gid, dict(cls=cls, models=[], instances=0))
                if cls == "building":
                    e["cls"] = "building"          # a building wins the label
                if hexid(mid) not in e["models"]:
                    e["models"].append(hexid(mid))
                e["instances"] += cnt
    gids = sorted(cand)
    print("[enumerate] distinct static GfxObjs: %d" % len(gids))
    if args.limit:
        gids = gids[:args.limit]
        print("[enumerate] --limit %d applied" % args.limit)

    out, deferred = {}, {}
    n_small = n_deg = n_missing = 0
    survivors = []
    for gid in gids:
        e = dict(cand[gid])
        gh = hexid(gid)
        try:
            rec = pipeline.P.gfx(gid)
        except Exception as ex:
            out[gh] = dict(e, route="error", why="parse: " + str(ex)[:160])
            n_missing += 1
            continue
        tris = sum(len(q["v"]) - 2 for q in rec["polys"] if not (q["stip"] & 0x4))
        e["tris"] = tris
        # --- filter 1: the <=50-tri long tail (texture lane covers it) -------
        if tris <= args.min_tris:
            out[gh] = dict(e, route="skip-small", cls="prop",
                           why="%d tris <= --min-tris %d" % (tris, args.min_tris))
            n_small += 1
            continue
        # --- filter 2: THE DEGRADE GUARD ------------------------------------
        bands = pipeline.P.degrade(gid)
        e["degradeId"] = hexid(rec["degrade"]) if rec.get("degrade") else None
        e["degradeBands"] = len(bands)
        if bands and bands[0]["id"] != gid:
            e["route"] = "skip-degrade"
            e["why"] = ("degrade band 0 is %s, not this record -- the client "
                        "never draws the root mesh (dossier 5a)"
                        % hexid(bands[0]["id"]))
            out[gh] = e
            deferred[gh] = dict(
                cls=e["cls"], tris=tris, instances=e["instances"],
                models=e["models"], degradeId=e["degradeId"],
                bands=[dict(id=hexid(b["id"]), mode=b["mode"], min=b["min"],
                            ideal=b["ideal"], max=b["max"]) for b in bands],
                bandObjects=[hexid(b["id"]) for b in bands if b["id"]],
                reason="band0-not-self")
            n_deg += 1
            continue
        e["degradeBand0Self"] = bool(bands)
        survivors.append(gid)
        out[gh] = e

    print("[enumerate] after long-tail cut (<= %d tris): %d | degrade-deferred: "
          "%d | unparseable: %d | to gate: %d"
          % (args.min_tris, len(survivors) + n_deg, n_deg, n_missing,
             len(survivors)))

    # --- height-field warm-up: ONE field per RenderSurface, not per record ---
    import matlib
    surf_ids, rs_ids = set(), set()
    for gid in survivors:
        surf_ids.update(pipeline.P.gfx(gid)["surfaces"])
    for sid in surf_ids:
        s = pipeline.P.surface(sid)
        cls, _why = matlib.classify(sid, s)
        if cls in matlib.MACRO_OK and (s or {}).get("rsId"):
            rs_ids.add(s["rsId"])
    rs_ids = sorted(rs_ids)
    print("[enumerate] distinct Surfaces %d -> relief-allowed RenderSurfaces %d "
          "(height fields computed once each)" % (len(surf_ids), len(rs_ids)))
    tw = time.time()
    if args.jobs > 1 and rs_ids:
        with _pool(args, args) as pool:
            for i, _ in enumerate(pool.imap_unordered(_warm_one, rs_ids, 4)):
                if (i + 1) % 50 == 0:
                    print("   warmed %d/%d (%.0fs)" % (i + 1, len(rs_ids),
                                                       time.time() - tw))
    else:
        for i, rs in enumerate(rs_ids):
            _warm_one(rs)
            if (i + 1) % 50 == 0:
                print("   warmed %d/%d (%.0fs)" % (i + 1, len(rs_ids),
                                                   time.time() - tw))
    print("[enumerate] height cache warm in %.0fs" % (time.time() - tw))

    # --- filter 3: the surface gate ----------------------------------------
    tg = time.time()
    if args.jobs > 1 and survivors:
        with _pool(args, args) as pool:
            gated = list(pool.imap_unordered(_gate_one, survivors, 8))
    else:
        gated = [_gate_one(g) for g in survivors]
    n_disp = n_gate = 0
    for g in gated:
        gh = hexid(g["gid"])
        e = out[gh]
        if not g["ok"]:
            e.update(route="error", why="gate: " + g["why"])
            n_missing += 1
            continue
        e.update(tris=g["tris"], area=g["area"], verts=g["verts"],
                 carvingPolys=g["carvingPolys"], carveSurfaces=g["carveSurfaces"],
                 zeroNormals=g["zeroNormals"], surfaces=g["surfaces"])
        if g["carveSurfaces"] and g["carvingPolys"]:
            mult = _mult_for(g["area"], g["tris"])
            added = int(round(g["tris"] * (mult - 1.0)))
            e.update(route="displace", mult=mult, plannedAddedTris=added,
                     plannedBytes=int(added * args.bytes_per_tri),
                     why="%d/%d surfaces carve" % (len(g["carveSurfaces"]),
                                                   len(g["surfaces"])))
            n_disp += 1
        else:
            classes = sorted({m["cls"] for m in g["surfaces"].values()})
            e.update(route="skip-gate",
                     why="gate refused all surfaces (%s)" % ", ".join(classes))
            n_gate += 1
    print("[enumerate] gate done in %.0fs" % (time.time() - tg))

    # --- budget ranking (advisory here; build enforces) ---------------------
    order = sorted((gh for gh, e in out.items() if e["route"] == "displace"),
                   key=lambda gh: (-out[gh]["instances"], -out[gh]["tris"], gh))
    for rank, gh in enumerate(order):
        out[gh]["budgetRank"] = rank
    planned_bytes = sum(out[gh]["plannedBytes"] for gh in order)

    js = dict(generatedAt=time.strftime("%Y-%m-%dT%H:%M:%S"),
              recipe=RECIPE_VERSION,
              window=args.window or "world (every LandBlockInfo)",
              minTris=args.min_tris, bytesPerTri=args.bytes_per_tri,
              counts=dict(candidates=len(gids), displace=n_disp,
                          skipSmall=n_small, skipGate=n_gate,
                          skipDegrade=n_deg, errors=n_missing),
              plannedAddedTris=sum(out[gh]["plannedAddedTris"] for gh in order),
              plannedBytes=planned_bytes,
              lbInfoErrors=lb_errors, gfxObjs=out)
    _write_json(p["models"], js)
    _write_json(p["deferred"],
                dict(policy="v1: a GfxObj whose degrade band 0 is a DIFFERENT "
                            "object is never drawn from its root mesh "
                            "(client-headroom-dossier.md 5a) -- excluded here, "
                            "patch the band objects directly in the follow-up "
                            "lane",
                     count=len(deferred), records=deferred))
    _write_json(p["report"], js["counts"])

    print("=" * 72)
    print("TRANCHE: %d records to displace (%.1f Mtri added, %.0f MiB at %.0f B/tri)"
          % (n_disp, js["plannedAddedTris"] / 1e6, planned_bytes / MIB,
             args.bytes_per_tri))
    print("  skipped <=%d tris (long tail, texture lane): %d" % (args.min_tris,
                                                                 n_small))
    print("  DEGRADE-DEFERRED (band 0 is not the record -- patching it would be "
          "INVISIBLE): %d  -> %s" % (n_deg, p["deferred"]))
    print("  gate-refused (no carving surface): %d" % n_gate)
    print("  errors: %d" % n_missing)
    print("  enumerate took %.0fs -> %s" % (time.time() - t0, p["models"]))
    return 0


# --------------------------------------------------------------------- build
def _recipe_hash(gid, mult, args):
    """Identity of a built OBJ: the base bytes + every recipe knob."""
    h = hashlib.sha256()
    h.update(RECIPE_VERSION.encode())
    h.update(pipeline.P.dat.get(gid) or b"")
    for v in (mult, pilot.AMP_WALL, pilot.GROUND_SCALE, pilot.PLINTH_LO,
              pilot.PLINTH_HI, pilot.NORMAL_GAIN, pilot.FLOOR_M,
              pilot.FINE_BUDGET, args.area_share, args.max_segments):
        h.update(repr(v).encode())
    h.update(",".join(sorted(pilot.WALL_CLASSES)).encode())
    return h.hexdigest()


def _build_one(job):
    """Worker: one record -> OBJ.  Returns a stats dict (never raises)."""
    gid_h, mult, objp, statep, want, args = job
    gid = int(gid_h, 16)
    try:
        # belt and braces: the guard again, on the record we are about to patch
        bands = pipeline.P.degrade(gid)
        if bands and bands[0]["id"] != gid:
            return dict(gid=gid_h, ok=False,
                        why="DEGRADE GUARD: band 0 is %s -- refusing to patch "
                            "an invisible root mesh" % hexid(bands[0]["id"]))
        src, metas, rec, amp_fn = pilot.recipe_c_source(gid)
        n0 = src.tri_count()
        target = int(round(n0 * (mult - 1.0)))     # importer carries the n0
        pipeline.bandlimit(src, metas, target, verbose=False)
        carve_fans = sum(len(p["v"]) - 2 for p in src.polys
                         if p.get("h") is not None and p.get("amp", 0) > 0
                         and not p.get("excluded") and not p.get("invisible"))
        segs = args.max_segments
        while segs > 4 and carve_fans * segs * segs > pilot.FINE_BUDGET:
            segs -= 2
        old_max = relief3d.MAX_AMPLITUDE_M
        relief3d.MAX_AMPLITUDE_M = max(old_max, pilot.AMP_WALL)
        try:
            res = pipeline.run(src, segments=segs, mult=mult, target_tris=target,
                               carved_only=True, floor_m=pilot.FLOOR_M,
                               verbose=False, normal_gain=pilot.NORMAL_GAIN,
                               amp_fn=amp_fn, area_share=args.area_share)
        finally:
            relief3d.MAX_AMPLITUDE_M = old_max
        tmp = objp + ".tmp"
        nf, nv = pilot.write_obj(tmp, gid, res, src)
        os.replace(tmp, objp)
        shell = int(len(res["F"]))
        st = dict(gid=gid_h, ok=True, hash=want, objPath=objp,
                  surfaceDid=hexid(rec["surfaces"][0]), srcTris=n0, objFaces=nf,
                  objVerts=nv, segments=segs, shellTris=shell,
                  totalTris=n0 + shell, plannedMult=mult,
                  mult=round((n0 + shell) / max(n0, 1), 3),
                  addedTris=shell, bytesEst=int(shell * args.bytes_per_tri))
        _write_json(statep, st)
        return st
    except Exception as ex:
        import traceback
        return dict(gid=gid_h, ok=False,
                    why="%s: %s" % (type(ex).__name__, str(ex)[:180]),
                    trace=traceback.format_exc()[-600:])


def _geometry_allocation(args):
    """Bytes the geometry lane may spend, from budget_planner.py's plan.json."""
    if args.geometry_budget_mib is not None:
        return int(args.geometry_budget_mib * MIB), "--geometry-budget-mib"
    if not args.plan:
        return None, "no --plan and no --geometry-budget-mib"
    plan = json.load(open(args.plan))
    portal = plan.get("portal") or {}
    geo = int(portal.get("geometry_bytes_est") or 0)
    if geo > 0:
        return geo, "%s geometry_bytes_est" % os.path.basename(args.plan)
    budget = int(portal.get("budget_bytes") or 0)
    if budget > 0:
        return budget, ("%s budget_bytes (whole portal budget -- plan carried "
                        "no geometry line)" % os.path.basename(args.plan))
    raise SystemExit("plan %s has no portal budget -- refusing to guess"
                     % args.plan)


def cmd_build(args):
    p = _paths(args)
    os.makedirs(p["obj"], exist_ok=True)
    os.makedirs(p["state"], exist_ok=True)
    models = json.load(open(p["models"]))
    recs = models["gfxObjs"]
    alloc, alloc_src = _geometry_allocation(args)
    print("[build] geometry allocation: %s (%s)"
          % ("%.0f MiB" % (alloc / MIB) if alloc else "unbounded", alloc_src))

    order = sorted((gh for gh, e in recs.items() if e["route"] == "displace"),
                   key=lambda gh: (-recs[gh]["instances"], -recs[gh]["tris"], gh))
    if args.only:
        want = {s.upper() for s in args.only.split(",")}
        order = [gh for gh in order if gh.upper() in want]
        missing = want - {gh.upper() for gh in order}
        if missing:
            raise SystemExit("--only names records that are not route=displace: "
                             + ", ".join(sorted(missing)))
    if args.limit:
        order = order[:args.limit]

    # --- budget: take in value order, stop cleanly at the first non-fit -----
    spend, selected, dropped = 0, [], []
    for gh in order:
        e = recs[gh]
        cost = int(e["plannedAddedTris"] * args.bytes_per_tri)
        if alloc is not None and spend + cost > alloc:
            dropped = [dict(gid=g, plannedAddedTris=recs[g]["plannedAddedTris"],
                            plannedBytes=int(recs[g]["plannedAddedTris"]
                                             * args.bytes_per_tri),
                            instances=recs[g]["instances"], tris=recs[g]["tris"],
                            reason="budget-exhausted")
                       for g in order[len(selected):]]
            break
        spend += cost
        selected.append(gh)
    if dropped:
        print("!" * 72)
        print("[build] BUDGET EXHAUSTED after %d records (%.1f MiB of %.1f MiB): "
              "%d records DROPPED, listed in %s"
              % (len(selected), spend / MIB, alloc / MIB, len(dropped),
                 os.path.join(p["root"], "budget_dropped.json")))
        print("!" * 72)
        _write_json(os.path.join(p["root"], "budget_dropped.json"),
                    dict(allocationBytes=alloc, allocationSource=alloc_src,
                         spentBytesEst=spend, droppedCount=len(dropped),
                         dropped=dropped))

    # --- resume: skip records whose OBJ exists and whose input hash matches --
    jobs, resumed, done = [], 0, {}
    for gh in selected:
        gid = int(gh, 16)
        mult = float(recs[gh].get("mult", MULT_MIN))
        objp = os.path.join(p["obj"], gh + ".obj")
        statep = os.path.join(p["state"], gh + ".json")
        want = _recipe_hash(gid, mult, args)
        if os.path.exists(statep) and os.path.exists(objp):
            try:
                st = json.load(open(statep))
            except Exception:
                st = {}
            if st.get("hash") == want and st.get("ok"):
                done[gh] = st
                resumed += 1
                continue
        jobs.append((gh, mult, objp, statep, want, args))
    print("[build] %d selected | %d already built (resumed) | %d to build | "
          "jobs=%d" % (len(selected), resumed, len(jobs), args.jobs))

    t0 = time.time()
    failures = []
    if jobs and args.jobs > 1:
        with _pool(args, args) as pool:
            for i, st in enumerate(pool.imap_unordered(_build_one, jobs)):
                _log_built(st, i + 1, len(jobs), t0, done, failures)
    else:
        for i, j in enumerate(jobs):
            _log_built(_build_one(j), i + 1, len(jobs), t0, done, failures)

    # --- imports.jsonl is rebuilt from state, so a resumed run is complete ---
    stats = {}
    with open(p["imports"], "w") as f:
        for gh in sorted(done):
            st = done[gh]
            f.write(json.dumps(dict(
                command="obj-import", objPath=st["objPath"],
                surfaceDid=st["surfaceDid"], gfxObjId=gh, overwrite=True,
                preservePhysics=True, gfxObjOnly=True)) + "\n")
            stats[gh] = {k: v for k, v in st.items()
                         if k not in ("ok", "hash", "gid")}
        f.write(json.dumps(dict(command="export", directory=p["export"])) + "\n")
    _write_json(p["stats"], stats)

    added = sum(s["addedTris"] for s in stats.values())
    print("=" * 72)
    print("[build] %d records ready (%d added tris, ~%.1f MiB) -> %s"
          % (len(stats), added, added * args.bytes_per_tri / MIB, p["imports"]))
    if failures:
        print("[build] FAILURES: %d" % len(failures))
        for fl in failures[:20]:
            print("   %s  %s" % (fl["gid"], fl["why"]))
        _write_json(os.path.join(p["root"], "build_failures.json"), failures)
    if dropped:
        print("[build] DROPPED for budget: %d (budget_dropped.json)" % len(dropped))
    print("[build] took %.0fs" % (time.time() - t0))
    return 1 if failures else 0


def _log_built(st, i, n, t0, done, failures):
    if st.get("ok"):
        done[st["gid"]] = st
        print("[%d/%d] %s  %4d src + %4d shell = %5d drawn (%.2fx) segs=%d "
              "(%.0fs)" % (i, n, st["gid"], st["srcTris"], st["shellTris"],
                           st["totalTris"], st["mult"], st["segments"],
                           time.time() - t0))
    else:
        failures.append(st)
        print("[%d/%d] %s  FAILED: %s" % (i, n, st["gid"], st["why"]))
    sys.stdout.flush()


# ---------------------------------------------------------------------- main
def main(argv=None):
    ap = argparse.ArgumentParser(
        description=__doc__.splitlines()[0],
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("mode", choices=("enumerate", "build"))
    ap.add_argument("--root", required=True,
                    help="run directory (holds models.json, obj/, state/, "
                         "imports.jsonl, export/)")
    ap.add_argument("--portal", default=None,
                    help="base client_portal.dat (default <root>/proj/dats/base/)")
    ap.add_argument("--cell", default=None,
                    help="base client_cell_1.dat (default <root>/proj/dats/base/)")
    ap.add_argument("--hcache", default=None,
                    help="per-RenderSurface height-field cache dir "
                         "(default: matlib's, /mnt/wbterminal2/dpc-work/hcache)")
    ap.add_argument("--jobs", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    ap.add_argument("--min-tris", type=int, default=DEFAULT_MIN_TRIS,
                    help="skip records at or below this triangle count "
                         "(r2 6.3 long tail; default %d)" % DEFAULT_MIN_TRIS)
    ap.add_argument("--window", default=None,
                    help="limit to a landblock tile box, e.g. 'A6-AC,B1-B7' "
                         "(Holtburg).  Default: the whole world.")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--only", default=None,
                    help="build only these GfxObj ids (comma separated hex)")
    ap.add_argument("--plan", default=None,
                    help="plan.json from budget_planner.py -- caps the geometry "
                         "spend and reports every dropped record")
    ap.add_argument("--geometry-budget-mib", type=float, default=None,
                    help="explicit geometry allocation, overrides --plan")
    ap.add_argument("--bytes-per-tri", type=float, default=DEFAULT_BYTES_PER_TRI)
    ap.add_argument("--max-segments", type=int, default=16,
                    help="subdivision segments per source edge before the "
                         "FINE_BUDGET back-off (pilot default 16)")
    ap.add_argument("--area-share", type=float, default=0.75,
                    help="decimator per-source-triangle fair-share floor")
    a = ap.parse_args(argv)

    a.root = os.path.abspath(a.root)
    base = os.path.join(a.root, "proj", "dats", "base")
    a.portal = os.path.abspath(a.portal or os.path.join(base, "client_portal.dat"))
    a.cell = os.path.abspath(a.cell or os.path.join(base, "client_cell_1.dat"))
    for f in (a.portal, a.cell):
        if not os.path.exists(f):
            raise SystemExit("missing base dat: %s" % f)
    a.jobs = max(1, a.jobs)
    _setup(a)
    return {"enumerate": cmd_enumerate, "build": cmd_build}[a.mode](a)


if __name__ == "__main__":
    sys.exit(main())
