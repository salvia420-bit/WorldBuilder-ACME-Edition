#!/usr/bin/env python3
"""executor.py -- AcmeRedline: an agent walks the work queue and CORRECTS each item.

Consumes a work-items.json from queue_worker.py (this repo owns that format) and,
per item, dispatches by lane to a concrete action that produces a corrected
record into a WORKING COPY of a dat -- then emits a status event and, where a fix
landed, an A/B board via verify_fix.py.

    # classify + print the plan, touch nothing (DEFAULT):
    python3 executor.py --work-items fixtures/work-items.json --base <dat>

    # actually write ONE record into a scratch dat and verify it:
    python3 executor.py --work-items fixtures/work-items.json --base <dat> \
        --apply --max-records 1 --wbt <WorldBuilder.Terminal.dll> \
        --work-dir /mnt/wbterminal2/redline-exec --status redline-status.jsonl

HARD SAFETY RULES (the dat pipeline runs LIVE):
  * Core lane files are driven ONLY as black boxes -- `texture_lane.py run` and
    `tranche.py build` by subprocess, `verify_fix.make_board` the way verify_fix
    already does. This module reimplements NONE of their logic.
  * WRITES only ever land on a working COPY under --work-dir. Any write path that
    resolves under ~/ac_base_dats is refused (assert_not_base). The base dats are
    opened read-only to make the copy.
  * --max-records caps the number of records actually written per run; hitting it
    is logged and the rest are deferred, not silently dropped.
  * Dry-run (default) writes nothing at all -- no dat, no status event.

DISPATCH TABLE (drivable-today vs needs-a-proposal) -- see docs/redline/DESIGN.md 10:
  lane / tags                         -> disposition   how
  texture-legibility-rebake           -> EXECUTABLE    DatCompress prep (once/run, SAFE
                                                        free pool) -> texture_lane.py run
                                                        -> WBT render-surface-import
                                                        -> readback verify (non-zero dims)
  texture-source-replacement          -> NEEDS-MANUAL  art asset first; exact run cmd emitted
    (wrong-material / recolor)
  texture-palette-fill (INDEX16/P8)   -> NEEDS-MANUAL  fill_import.py + DatRecordInsert
                                                        (no single headless dat-writing entrypoint)
  geometry-displace + silhouette      -> EXECUTABLE*   tranche.py build --only (subprocess);
                                                        *artifact only -- see note
  geometry-displace + remove-detail   -> BLOCKED       needs the per-poly-exclusion knob
                                                        that does NOT exist in the shipped lane
                                                        (precise PROPOSAL emitted, not applied)
  geometry-degrade-deferred           -> BLOCKED       band0-not-self guard (retarget suggested)
  terrain-lane-only                   -> BLOCKED       terrain-protected guard
  triage / rs-missing / object        -> NEEDS-MANUAL  narrow the selection / missing record

  *geometry note: `tranche.py build` produces the corrected OBJ + imports.jsonl
   (the geometry correction as an artifact). LANDING it into a dat is a further
   `dotnet WBT -p <proj>.wbproj < imports.jsonl` + export step that needs a
   WorldBuilder project this executor is not given, so geometry apply stops at
   the artifact and the final dat-write command is emitted as needs-manual. Only
   the texture lane writes a dat end-to-end headlessly today.
"""
import argparse
import datetime
import json
import os
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
DATPATCH = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, DATPATCH)

import status_writer                                # noqa: E402  (sibling)

BASE_DAT_DIR = os.path.realpath(os.path.expanduser("~/ac_base_dats"))
DEFAULT_TEX_BASE = os.environ.get("DATPATCH_TEX_BASE",
                                  "/mnt/wbterminal2/tex-reexport-2026-07-30/")
# The SAFE free-pool prep for multi-block record imports (F1). Same dll
# detail_texture_lane.py:53 uses.
DEFAULT_DATCOMPRESS = os.path.join(
    DATPATCH, "DatCompress/bin/Release/net8.0/DatCompress.dll")

# Dispositions
EXECUTED = "executed"
NEEDS_MANUAL = "needs-manual"
BLOCKED = "blocked"
DEFERRED = "deferred"
DRY = "planned"


def utcnow():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def assert_not_base(path, what):
    rp = os.path.realpath(path)
    if rp == BASE_DAT_DIR or rp.startswith(BASE_DAT_DIR + os.sep):
        raise SystemExit("REFUSING to %s a path under ~/ac_base_dats: %s"
                         % (what, path))


def run_cmd(argv, env=None, timeout=3600, cwd=None):
    """Subprocess a black-box tool; capture output. Returns (rc, stdout, stderr)."""
    p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout,
                       env=env, cwd=cwd)
    return p.returncode, p.stdout, p.stderr


def _wbt_call(wbt, cmds, timeout=1800):
    """One WBT --stdin batch; returns the parsed json result objects."""
    inp = "".join(json.dumps(c) + "\n" for c in cmds)
    p = subprocess.run(["dotnet", wbt, "--stdin"], input=inp, capture_output=True,
                       text=True, timeout=timeout,
                       env=dict(os.environ, DOTNET_ROLL_FORWARD="LatestMajor"))
    outs = []
    for line in p.stdout.splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                outs.append(json.loads(line))
            except Exception:
                pass
    return outs, p


def prepare_free_pool(ctx):
    """F1: make the scratch dat's allocator a VALID free pool that
    render-surface-import can chain MULTI-BLOCK records through -- by running
    DatCompress on it, exactly the detail_texture_lane.py:264-269 flow="compress".

    DatCompress rewrites the uncompressed RenderSurfaces as zlib, freeing interior
    blocks with VALID free-chain next-pointers, which DRW's writer then allocates
    from. This is the ONLY flow proven to land large records (the live r9 highres
    carries 4096^2 DXT records imported this way that read back clean).

    NOT texture_lane.py prep: that appends a ZEROED arena whose next-pointers are
    all zero, so a >~65-block record's chain terminates after ~1 block and reads
    back 0x0 -- and every record this lane writes is 500-5,500 blocks
    (detail_texture_lane.py:271-276, reproduced by a sibling agent this run).

    Runs ONCE per run (fixes F4). Sets ctx["free_pool_ready"]. Heavy dat op --
    only on --apply.
    """
    if not ctx.get("datcompress"):
        print("[executor] WARN: no --datcompress dll; cannot prepare a safe free "
              "pool -- texture applies will refuse (see F1).", file=sys.stderr)
        ctx["free_pool_ready"] = False
        return
    log = os.path.join(ctx["work_dir"], "prepare_free_pool.log")
    argv = ["dotnet", ctx["datcompress"], ctx["scratch_dat"], "--verify"]
    print("[executor] preparing free pool: DatCompress --verify on scratch "
          "(once per run) ...")
    rc, out, err = run_cmd(argv, timeout=ctx["timeout"])
    with open(log, "w") as f:
        f.write("ARGV: %s\n\nSTDOUT:\n%s\n\nSTDERR:\n%s\n" % (" ".join(argv), out, err))
    ctx["free_pool_ready"] = (rc == 0)
    if rc != 0:
        print("[executor] WARN: DatCompress prep returned %d -- texture applies "
              "will refuse (see %s)" % (rc, log), file=sys.stderr)


def _readback_verify(scratch, rs_hex, ctx):
    """F1: read THIS record back out of the scratch and confirm non-zero dims, so
    a corrupt (0x0) write is never stamped fixed. Light WBT op (one record)."""
    if not ctx.get("wbt"):
        return dict(ok=None, why="no --wbt: cannot read back (skipped)")
    try:
        outs, p = _wbt_call(ctx["wbt"], [dict(
            command="chorizite-parse-dat-record", datPath=scratch,
            idHex=rs_hex, typeName="RenderSurface")], timeout=600)
    except Exception as ex:
        return dict(ok=False, why="readback call failed: %s" % ex)
    o = next((x for x in outs
              if x.get("command") == "chorizite-parse-dat-record"), None)
    if not o:
        return dict(ok=False, why="no parse result")
    if o.get("errorMessage"):
        return dict(ok=False, why="parse error: %s" % o["errorMessage"])
    f = o.get("fields") or {}
    w, h = f.get("width"), f.get("height")
    fmt = (f.get("format") or "").replace("PFID_", "")
    ok = bool(w and h and w > 0 and h > 0 and fmt)
    return dict(ok=ok, w=w, h=h, fmt=fmt,
                why=None if ok else "record read back as %sx%s fmt=%r (corrupt/zero)"
                % (w, h, fmt))


def structural_finalize(ctx, report):
    """F1 tail: after all imports, run the detail_texture_lane land() steps that
    make the file client-conformant -- fixup_dat (zero DRW leaf sentinels) then
    walk_check (client-reader integrity tripwire). Records the result in the
    report; a walk_check FAIL is surfaced loudly. Heavy-ish; --apply only."""
    scratch = ctx["scratch_dat"]
    fin = dict(fixup=None, walkCheck=None)
    try:
        sys.path.insert(0, DATPATCH)
        import texture_lane as TL           # black box: fixup_dat only
        fin["fixup"] = TL.fixup_dat(scratch)
    except Exception as ex:
        fin["fixup"] = "ERROR: %s" % ex
    wc = os.path.join(DATPATCH, "walk_check.py")
    if os.path.exists(wc):
        rc, out, err = run_cmd(["python3", wc, scratch], timeout=ctx["timeout"])
        with open(os.path.join(ctx["work_dir"], "walk_check.log"), "w") as f:
            f.write("STDOUT:\n%s\n\nSTDERR:\n%s\n" % (out, err))
        fin["walkCheck"] = "PASS" if rc == 0 else "FAIL(rc=%d)" % rc
        if rc != 0:
            print("[executor] !!! walk_check FAILED on the scratch dat -- the "
                  "written records may be structurally unsound; do NOT ship this "
                  "dat (see walk_check.log)", file=sys.stderr)
    report["structuralFinalize"] = fin
    return fin


# ============================================================ classification
def item_plan(item):
    """Map a work item -> (disposition_if_apply, dispatcher_name, human_reason).
    Pure: no side effects. `disposition_if_apply` is what --apply WOULD do."""
    lane = item.get("lane", "triage")
    tags = set(item.get("tags", []))
    if item.get("blocked"):
        gnames = [g["guard"] for g in item.get("guards", []) if g.get("blocking")]
        return BLOCKED, "guard-passthrough", "blocking guard(s): " + ", ".join(gnames)

    if lane == "texture-legibility-rebake":
        return EXECUTED, "texture_rebake", "drivable: texture_lane.py run -> WBT import"
    if lane == "texture-source-replacement":
        return NEEDS_MANUAL, "texture_source_replacement", \
            "no automated recipe: needs a replacement art asset first"
    if lane == "texture-palette-fill":
        return NEEDS_MANUAL, "texture_palette", \
            "palette route records are inserted by DatRecordInsert, not a single " \
            "headless dat-writing entrypoint"
    if lane == "geometry-displace":
        if "remove-detail" in tags:
            return BLOCKED, "geometry_remove_detail", \
                "needs the per-poly-exclusion knob (not in the shipped lane)"
        return NEEDS_MANUAL, "geometry_displace", \
            "tranche.py build produces the OBJ + imports.jsonl; the dat-write " \
            "(WBT obj-import + export) needs a WorldBuilder project"
    if lane in ("geometry-degrade-deferred", "terrain-lane-only"):
        return BLOCKED, "guard-passthrough", "lane is guard-blocked"
    return NEEDS_MANUAL, "triage", "needs a human/agent decision (%s)" % lane


# ============================================================ dispatchers
# Each returns a dict: disposition, commands[], artifacts{}, boardPath, reason,
# statusNote.  In dry-run they DESCRIBE (commands only); in apply they DO.

def _surface_facts(item):
    """Pull the surface/RS facts queue_worker already resolved."""
    r = item.get("resolved", {})
    rs = r.get("renderSurface", {})
    surf = r.get("surface", {})
    return rs, surf


def disp_texture_rebake(item, ctx):
    """Drive `texture_lane.py run` on the reported surface into the scratch dat.
    Black box: builds the surfaces.json + ids_file the lane's own `run`
    subcommand consumes (texture_lane.py:486-527), then subprocesses it."""
    rs, surf = _surface_facts(item)
    sid = surf.get("surfaceId")
    rs_hex = rs.get("rsId")
    st = surf.get("surfaceTextureId")
    stype = surf.get("type", 0)
    if not (sid and rs_hex and surf.get("resolvedRsId")):
        return dict(disposition=NEEDS_MANUAL,
                    reason="work item lacks a resolved surfaceId/rsId "
                           "(entry omitted surfaceId?) -- cannot drive the lane",
                    commands=[])
    base_png = os.path.join(ctx["tex_base"], rs_hex + ".png")
    if not os.path.exists(base_png):
        return dict(disposition=NEEDS_MANUAL,
                    reason="no base re-export PNG %s in DATPATCH_TEX_BASE -- the "
                           "lane has nothing to bake from" % (rs_hex + ".png"),
                    commands=[])

    work = ctx["item_dir"]
    ids_file = os.path.join(work, "ids.txt")
    surfaces_json = os.path.join(work, "surfaces.json")
    scratch = ctx["scratch_dat"]
    tl = os.path.join(DATPATCH, "texture_lane.py")
    argv = ["python3", tl, "run",
            "--root", work, "--base", ctx["base_dat"], "--patched", scratch,
            "--ids-file", ids_file, "--tag", "redline"]
    if ctx["wbt"]:
        argv += ["--wbt", ctx["wbt"]]
    cmds = ["# free pool prepared ONCE per run by DatCompress on the scratch "
            "(main -> prepare_free_pool); NOT texture_lane.py prep (zeroed arena "
            "corrupts >~65-block records -- detail_texture_lane.py:271-276)",
            "# surfaces.json + ids.txt (the lane's `run` inputs)",
            " ".join(argv)]

    if ctx["dry"]:
        return dict(disposition=DRY, reason="would rebake %s (RS %s) via "
                    "texture_lane.py run into the DatCompress-freed pool"
                    % (sid, rs_hex), commands=cmds,
                    artifacts=dict(surfacesJson=surfaces_json, idsFile=ids_file,
                                   scratchDat=scratch))

    # --- APPLY ---
    # F1: the free pool is prepared ONCE per run by prepare_free_pool() (DatCompress,
    # the detail_texture_lane.py:264-269 pattern), BEFORE this loop -- never the
    # zeroed-arena prep, which corrupts any record >~65 blocks (and every record
    # this lane writes is 500-5,500 blocks: detail_texture_lane.py:271-276). If
    # that step did not run/succeed, refuse rather than import into an unsafe pool.
    if not ctx.get("free_pool_ready"):
        return dict(disposition=NEEDS_MANUAL,
                    reason="free pool not prepared (DatCompress prep did not run "
                           "or failed) -- refusing to import into an unsafe "
                           "allocator; see the run's prepare_free_pool log",
                    commands=cmds)
    os.makedirs(work, exist_ok=True)
    # the minimal surfaces.json run_lane reads (texture_lane.py:486, 513-527)
    surfaces = {sid: dict(hasTexture=True, renderSurface=rs_hex,
                          surfaceTexture=st, surfaceType=stype)}
    with open(surfaces_json, "w") as f:
        json.dump(dict(base=ctx["base_dat"], surfaces=surfaces,
                       gfxObjSurfaces={}), f)
    with open(ids_file, "w") as f:
        f.write(sid + "\n")
    env = dict(os.environ)
    env["DATPATCH_TEX_BASE"] = ctx["tex_base"]
    env.setdefault("DOTNET_ROLL_FORWARD", "LatestMajor")
    t0 = time.time()
    rc, out, err = run_cmd(argv, env=env, timeout=ctx["timeout"])
    runlog = os.path.join(work, "texture_lane.run.log")
    with open(runlog, "w") as f:
        f.write("ARGV: %s\n\nSTDOUT:\n%s\n\nSTDERR:\n%s\n" % (" ".join(argv), out, err))
    runjson = os.path.join(work, "run_redline.json")
    res = json.load(open(runjson)) if os.path.exists(runjson) else {}
    encoded = res.get("encoded", 0)
    gate_ok = res.get("gate_ok")
    rt_fail = res.get("roundtrip_fail")
    rt_pass = res.get("roundtrip_pass")
    if rc != 0 or not encoded:
        return dict(disposition=NEEDS_MANUAL,
                    reason="texture_lane.py run did not encode the record "
                           "(rc=%d encoded=%s); see %s" % (rc, encoded, runlog),
                    commands=cmds, artifacts=dict(runLog=runlog, runJson=runjson))
    # F1: the lane's own gate must be green (its roundtrip re-reads dims/fmt).
    if not gate_ok or (rt_fail or 0) > 0:
        return dict(disposition=NEEDS_MANUAL,
                    reason="texture_lane.py run gate not green "
                           "(gate_ok=%s roundtrip_fail=%s) -- NOT stamping fixed; "
                           "see %s" % (gate_ok, rt_fail, runlog),
                    commands=cmds, artifacts=dict(runLog=runlog, runJson=runjson))
    # F1: independent per-record READBACK VERIFY -- re-read THIS record out of the
    # scratch and confirm non-zero dims. A corrupt (0x0) write can then never be
    # stamped "fixed", even if the lane's sampled roundtrip missed it.
    rbk = _readback_verify(scratch, rs_hex, ctx)
    if not rbk.get("ok"):
        return dict(disposition=NEEDS_MANUAL,
                    reason="readback verify FAILED for %s (%s) -- the record read "
                           "back corrupt/zero; NOT stamping fixed"
                           % (rs_hex, rbk.get("why")),
                    commands=cmds,
                    artifacts=dict(runLog=runlog, runJson=runjson, readback=rbk))
    return dict(disposition=EXECUTED,
                reason="rebaked RS %s into %s (encoded=%d gate_ok=%s rt=%s/%s "
                       "readback %sx%s %s, %.0fs)"
                       % (rs_hex, os.path.basename(scratch), encoded, gate_ok,
                          rt_pass, rt_fail, rbk.get("w"), rbk.get("h"),
                          rbk.get("fmt"), time.time() - t0),
                commands=cmds,
                artifacts=dict(runLog=runlog, runJson=runjson, readback=rbk,
                               scratchDat=scratch),
                verifyTarget=rs_hex, verifyGid=None)


def disp_texture_source_replacement(item, ctx):
    rs, surf = _surface_facts(item)
    rs_hex = rs.get("rsId", "<rs>")
    w, h = rs.get("w"), rs.get("h")
    run = ("python3 tools/dat-patch/texture_lane.py run --root <R> --base <BASE> "
           "--patched <SCRATCH> --ids-file <ids with %s> --wbt <DLL>"
           % surf.get("surfaceId", "<surfaceId>"))
    return dict(disposition=NEEDS_MANUAL,
                reason="'%s' is a claim about WHAT the texture depicts; the bake "
                       "cannot change subject matter (texture_lane.py:363-422). "
                       "A human/AI must drop a replacement RGBA PNG (>= %sx%s, "
                       "mult-4) at $DATPATCH_TEX_BASE/%s.png, THEN the rebake "
                       "ships it." % (",".join(sorted(set(item.get("tags", []))
                                                      & {"wrong-material", "recolor"})),
                                      w, h, rs_hex),
                commands=["# 1) art step: produce $DATPATCH_TEX_BASE/%s.png" % rs_hex,
                          "# 2) " + run])


def disp_texture_palette(item, ctx):
    rs, _ = _surface_facts(item)
    rs_hex = rs.get("rsId", "<rs>")
    return dict(disposition=NEEDS_MANUAL,
                reason="INDEX16/P8 palette route: fill_import.py emits raw record "
                       "bytes to idx/<id>.bin for DatRecordInsert "
                       "(fill_import.py:150-170) -- there is no single headless "
                       "entrypoint that both bakes AND writes the dat, so this is "
                       "a two-command manual sequence.",
                commands=[
                    "python3 tools/dat-patch/fill_import.py --ids <file with %s> "
                    "--upscales <UPSCALE_DIR> --out-root <R> --portal <BASE>" % rs_hex,
                    "# then apply the idx/<id>.bin records with the DatRecordInsert "
                    "tool (tools/dat-patch/DatRecordInsert) into the scratch dat"])


def disp_geometry_displace(item, ctx):
    """Drivable to the ARTIFACT (OBJ + imports.jsonl) with today's knobs; the
    dat-write needs a WB project this executor is not given."""
    gid = (item.get("target") or {}).get("id", "<gid>")
    world = item.get("world") or {}
    lb = world.get("landblock")
    window = None
    if lb:
        try:
            v = int(lb, 16)
            window = "%02X,%02X" % ((v >> 24) & 0xFF, (v >> 16) & 0xFF)
        except Exception:
            window = None
    knobs = "--area-share 0.75 --max-segments 16"      # tranche.py:675-679 defaults
    if "silhouette" in set(item.get("tags", [])):
        knobs += "   # raise this record's mult toward 6x in models.json before build"
    enum = ("python3 tools/dat-patch/tranche.py enumerate --root <R> --portal "
            "<BASE> --cell <CELL>%s" % (" --window %s" % window if window else ""))
    build = ("python3 tools/dat-patch/tranche.py build --root <R> --only %s "
             "--portal <BASE> --cell <CELL> %s" % (gid, knobs))
    apply_ = ("dotnet WorldBuilder.Terminal.dll --stdin -p <R>/proj/*.wbproj "
              "< <R>/imports.jsonl   # obj-import + export -> writes the dat")
    return dict(disposition=NEEDS_MANUAL,
                reason="tranche.py build --only %s produces the corrected OBJ + "
                       "imports.jsonl with existing knobs (%s); the final dat-write "
                       "is a WB-project obj-import+export step this executor is not "
                       "given a project for (tranche.py:14-15)." % (gid, knobs),
                commands=[enum, build, apply_])


def disp_geometry_remove_detail(item, ctx):
    gid = (item.get("target") or {}).get("id", "<gid>")
    tri = (item.get("resolved") or {}).get("triangles", {})
    polys = [p["polyIndex"] for p in tri.get("sourcePolygons", [])]
    return dict(disposition=BLOCKED,
                reason="'remove-detail' needs per-polygon exclusion, which the "
                       "shipped lane cannot express: exclusion is derived only from "
                       "the record's own stip/sides (relief3d.py:152). Refusing to "
                       "edit core lane code (pipeline is live). See the PROPOSAL.",
                proposal=per_poly_exclusion_proposal(gid, polys),
                commands=[])


def disp_guard_passthrough(item, ctx):
    guards = [g for g in item.get("guards", []) if g.get("blocking")]
    reasons = "; ".join(g.get("why", g.get("guard", "")) for g in guards)
    retarget = None
    for a in item.get("actions", []):
        if a.get("action") == "retarget-to-band-object":
            retarget = a.get("candidateTargets")
    return dict(disposition=BLOCKED,
                reason="guard-blocked, passed through unexecuted: " + reasons,
                retargetCandidates=retarget, commands=[])


def disp_triage(item, ctx):
    return dict(disposition=NEEDS_MANUAL,
                reason="triage: %s. Narrow the selection (a whole object / a "
                       "missing record is not an actionable single target)."
                       % item.get("lane"),
                commands=[a.get("action") for a in item.get("actions", [])])


DISPATCH = {
    "texture_rebake": disp_texture_rebake,
    "texture_source_replacement": disp_texture_source_replacement,
    "texture_palette": disp_texture_palette,
    "geometry_displace": disp_geometry_displace,
    "geometry_remove_detail": disp_geometry_remove_detail,
    "guard-passthrough": disp_guard_passthrough,
    "triage": disp_triage,
}


# ============================================================ the proposal
def per_poly_exclusion_proposal(gid, poly_indices):
    """A PRECISE spec of the per-poly-exclusion knob -- as a proposal, NOT applied.
    Nothing in core lane code is edited by this executor."""
    return dict(
        title="per-poly-exclusion override knob for the displace lane",
        why=("remove-detail on a specific record needs to exclude named source "
             "polygons from carving. Today relief3d.SourceMesh.from_record derives "
             "`excluded` ONLY from the polygon's own stip/sides (relief3d.py:152, "
             "157) -- there is no per-record override, so a single-record complaint "
             "cannot be honoured without touching every record of that material."),
        proposedChange=[
            dict(file="tools/dat-patch/relief3d.py",
                 function="SourceMesh.from_record",
                 at="relief3d.py:127 (signature) / :152-163 (per-poly flag build)",
                 change="add an optional `exclude_polys=None` arg (a set of source "
                        "polygon indices in record order); when a polygon's index "
                        "is in it, force excluded=True and amp=0.0 exactly as the "
                        "stip/sides path already does, so the existing weld-to-zero "
                        "(relief3d.py:287-304) needs no change."),
            dict(file="tools/dat-patch/pilot.py",
                 function="recipe_c_source",
                 at="pilot.py:237-254",
                 change="thread an `exclude_polys` through to "
                        "SourceMesh.from_record; source it from a new optional "
                        "per-record override file."),
            dict(file="tools/dat-patch/tranche.py",
                 function="cmd_build / _build_one",
                 at="tranche.py:453-499 (_build_one) + :521 (cmd_build)",
                 change="read an optional <root>/redline_overrides.json "
                        "{gid_hex: {excludePolys: [int,...]}} and pass the list "
                        "into recipe_c_source for that gid."),
            dict(file="tools/dat-patch/tranche.py",
                 constant="RECIPE_VERSION",
                 at="tranche.py:111",
                 change="BUMP it (e.g. 'C-2026-08-15' -> 'C-redline-excl-1'); the "
                        "resume hash (_recipe_hash, tranche.py:440-450) folds "
                        "RECIPE_VERSION, so a bump forces a rebuild of any record "
                        "whose override set changed -- without it a stale OBJ is "
                        "reused."),
        ],
        targetGfxObj=gid,
        excludePolysForThisItem=poly_indices,
        note="PROPOSAL ONLY -- not applied. The dat pipeline is running live; "
             "core lane code must not be edited from the redline tooling.")


# ============================================================ verify hook
def run_verify(item, dispatch_res, ctx):
    """Call verify_fix.py to attach an A/B board (pre=base, post=scratch)."""
    target = dispatch_res.get("verifyTarget")
    gid = dispatch_res.get("verifyGid")
    if not target:
        return None
    argv = ["python3", os.path.join(HERE, "verify_fix.py"),
            "--target", target, "--pre", ctx["base_dat"],
            "--post", ctx["scratch_dat"], "--root", ctx["item_dir"]]
    if gid:
        argv += ["--gid", gid]
    if ctx["wbt"]:
        argv += ["--wbt", ctx["wbt"]]
    env = dict(os.environ)
    env["DATPATCH_TEX_BASE"] = ctx["tex_base"]
    env.setdefault("DOTNET_ROLL_FORWARD", "LatestMajor")
    rc, out, err = run_cmd(argv, env=env, timeout=ctx["timeout"])
    board = None
    for line in out.splitlines():
        if line.startswith("[verify] board -> "):
            board = line.split("-> ", 1)[1].strip()
    vlog = os.path.join(ctx["item_dir"], "verify_fix.log")
    with open(vlog, "w") as f:
        f.write("ARGV: %s\n\nSTDOUT:\n%s\n\nSTDERR:\n%s\n" % (" ".join(argv), out, err))
    return board


# ============================================================ main loop
def process(items, ctx):
    report = dict(generatedBy="tools/dat-patch/redline/executor.py",
                  mode="apply" if ctx["apply"] else "dry-run",
                  base=ctx["base_dat"], workDir=ctx["work_dir"],
                  maxRecords=ctx["max_records"], recordsWritten=0,
                  capHit=False, counts={}, items=[])
    for item in items:
        wid = item.get("workItemId")
        if ctx["only"] and wid != ctx["only"]:
            continue
        disp_if_apply, dispatcher, reason = item_plan(item)
        entry = dict(workItemId=wid, target=item.get("target"),
                     lane=item.get("lane"), tags=item.get("tags"),
                     entryIds=item.get("entryIds"),
                     dispatcher=dispatcher, planReason=reason)

        # cap check: only EXECUTABLE items consume the record budget
        will_write = ctx["apply"] and disp_if_apply == EXECUTED
        if will_write and report["recordsWritten"] >= ctx["max_records"]:
            entry["disposition"] = DEFERRED
            entry["reason"] = ("record cap %d reached -- deferred (re-run to "
                               "continue)" % ctx["max_records"])
            report["capHit"] = True
            report["items"].append(entry)
            continue

        if not ctx["apply"]:
            # DRY: describe only, no status, no writes
            ctx["item_dir"] = os.path.join(ctx["work_dir"], wid or "item")
            res = DISPATCH[dispatcher](item, {**ctx, "dry": True})
            entry["disposition"] = DRY if disp_if_apply == EXECUTED else disp_if_apply
            entry["wouldDo"] = res.get("reason")
            entry["commands"] = res.get("commands", [])
            if res.get("proposal"):
                entry["proposal"] = res["proposal"]
            if res.get("retargetCandidates"):
                entry["retargetCandidates"] = res["retargetCandidates"]
            report["items"].append(entry)
            continue

        # --- APPLY ---
        ctx["item_dir"] = os.path.join(ctx["work_dir"], wid or "item")
        os.makedirs(ctx["item_dir"], exist_ok=True)
        picked = False
        if disp_if_apply == EXECUTED and ctx["status"]:
            _emit_status(ctx, item, "in-progress",
                         "executor picked up: %s" % dispatcher)
            picked = True
        res = DISPATCH[dispatcher](item, {**ctx, "dry": False})
        disp = res.get("disposition", disp_if_apply)
        entry["disposition"] = disp
        entry["reason"] = res.get("reason", reason)
        entry["commands"] = res.get("commands", [])
        if res.get("artifacts"):
            entry["artifacts"] = res["artifacts"]
        if res.get("proposal"):
            entry["proposal"] = res["proposal"]
        if res.get("retargetCandidates"):
            entry["retargetCandidates"] = res["retargetCandidates"]

        if disp == EXECUTED:
            report["recordsWritten"] += 1
            board = run_verify(item, res, ctx) if ctx["wbt"] else None
            entry["boardPath"] = board
            if ctx["status"]:
                note = "fixed by executor: %s" % res["reason"]
                if board:
                    note += " | A/B board %s" % board
                _emit_status(ctx, item, "fixed", note, release=ctx["release"])
        else:
            # needs-manual / blocked: schema state enum is queued|in-progress|
            # fixed only, so we do NOT invent a state. An executable item we
            # picked up but could not finish gets an in-progress note recording
            # the manual follow-up; a purely guard-blocked item (never picked up)
            # gets no status event, per "pass through unexecuted".
            if picked and ctx["status"]:
                _emit_status(ctx, item, "in-progress",
                             "%s: %s" % (disp.upper(), res.get("reason", reason)))
        report["items"].append(entry)

    # F1 tail: make the scratch client-conformant once, after all imports.
    if ctx["apply"] and report["recordsWritten"] > 0:
        structural_finalize(ctx, report)

    from collections import Counter
    report["counts"] = dict(Counter(i["disposition"] for i in report["items"]))
    return report


def _emit_status(ctx, item, state, note, release=None):
    # F2: a `fixed` event REQUIRES a real release (schema pattern acme-r<N>). main()
    # guarantees --release is present whenever fixed events can be written (apply +
    # status), so we never fall back to an invalid placeholder that append_event
    # would reject -- which is exactly how a fixed event was previously lost,
    # stranding the entry at in-progress.
    ev = dict(entryId=item["entryIds"][0], at=utcnow(), state=state,
              by="executor.py", note=note[:2000])
    if state == "fixed":
        if not release:
            print("   WARN: no release for fixed event on %s -- skipping the fixed "
                  "event (entry stays in-progress)" % item.get("workItemId"),
                  file=sys.stderr)
            return
        ev["release"] = release
    try:
        status_writer.append_event(ctx["status"], ev)
    except Exception as ex:
        print("   WARN: status write failed for %s: %s" % (item.get("workItemId"), ex),
              file=sys.stderr)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--work-items", required=True)
    ap.add_argument("--base", required=True,
                    help="base dat to COPY from (read-only). Writes go to a copy.")
    ap.add_argument("--work-dir", default=None,
                    help="where the working copy + per-item outputs live "
                         "(default /mnt/wbterminal2/redline-exec/<ts>)")
    ap.add_argument("--apply", action="store_true",
                    help="actually write to the working dat (default: dry-run)")
    ap.add_argument("--max-records", type=int, default=1,
                    help="cap on records actually written per run (owner safety)")
    ap.add_argument("--wbt", default=None, help="WorldBuilder.Terminal.dll")
    ap.add_argument("--datcompress", default=DEFAULT_DATCOMPRESS,
                    help="DatCompress.dll -- prepares the scratch dat's free pool "
                         "(the SAFE flow; see F1 / detail_texture_lane.py:264-269)")
    ap.add_argument("--tex-base", default=DEFAULT_TEX_BASE)
    ap.add_argument("--status", default=None, help="redline-status.jsonl to append to")
    ap.add_argument("--release", default=None, help="kit tag for fixed events")
    ap.add_argument("--only", default=None, help="run just this workItemId")
    ap.add_argument("--report", default=None,
                    help="default <work-items dir>/executor-report.json")
    ap.add_argument("--timeout", type=int, default=5400)
    a = ap.parse_args(argv)

    # F2: a `fixed` status event needs a real release (schema pattern acme-r<N>).
    # Fixed events are only written when --apply AND --status are set, so require
    # --release exactly then -- fail cleanly up front rather than silently losing
    # the fixed event later.
    if a.apply and a.status and not a.release:
        raise SystemExit(
            "--apply with --status writes 'fixed' status events, which REQUIRE a "
            "release tag: pass --release acme-r<N> (or drop --status to skip "
            "status writes).")

    doc = json.load(open(a.work_items))
    items = doc.get("workItems", doc if isinstance(doc, list) else [])
    base = os.path.abspath(a.base)
    if not os.path.exists(base):
        raise SystemExit("missing base dat: %s" % base)

    work_dir = os.path.abspath(a.work_dir or os.path.join(
        "/mnt/wbterminal2/redline-exec",
        datetime.datetime.now().strftime("%Y%m%d-%H%M%S")))
    scratch = os.path.join(work_dir, "client_portal.dat")
    assert_not_base(work_dir, "use as a work dir")
    assert_not_base(scratch, "write a scratch dat")

    ctx = dict(apply=a.apply, base_dat=base, work_dir=work_dir,
               scratch_dat=scratch, wbt=os.path.abspath(a.wbt) if a.wbt else None,
               datcompress=os.path.abspath(a.datcompress)
               if (a.datcompress and os.path.exists(a.datcompress)) else None,
               tex_base=a.tex_base, status=a.status, release=a.release,
               only=a.only, max_records=a.max_records, timeout=a.timeout,
               item_dir=work_dir, free_pool_ready=False)

    # will any executable (dat-writing) item actually run this pass?
    will_execute = a.apply and any(
        item_plan(it)[0] == EXECUTED and (not a.only or it.get("workItemId") == a.only)
        for it in items)

    print("[executor] mode=%s  base=%s  items=%d  maxRecords=%d"
          % ("APPLY" if a.apply else "dry-run", os.path.basename(base),
             len(items), a.max_records))
    if a.apply:
        os.makedirs(work_dir, exist_ok=True)
        if not os.path.exists(scratch):
            print("[executor] copying base -> scratch working dat (%s) ..." % scratch)
            shutil.copy2(base, scratch)
        print("[executor] scratch dat: %s" % scratch)
        # F1 + F4: prepare a SAFE free pool ONCE per run (DatCompress, never the
        # zeroed-arena prep), before any import. Only when a record will actually
        # land this pass (an executable item exists AND the cap allows a write).
        if will_execute and a.max_records > 0:
            prepare_free_pool(ctx)
        elif will_execute:
            print("[executor] --max-records 0: nothing will be written; skipping "
                  "free-pool prep")

    report = process(items, ctx)

    report_path = os.path.abspath(a.report or os.path.join(
        os.path.dirname(os.path.abspath(a.work_items)), "executor-report.json"))
    with open(report_path, "w") as f:
        json.dump(report, f, indent=1)

    print("=" * 72)
    for it in report["items"]:
        line = "%-11s %-26s %-26s %s" % (
            it["disposition"], (it.get("target") or {}).get("id", "-"),
            it["lane"], it["dispatcher"])
        print(line)
        if it.get("boardPath"):
            print("            board: %s" % it["boardPath"])
    print("=" * 72)
    print("[executor] counts: %s" % report["counts"])
    print("[executor] records written: %d%s"
          % (report["recordsWritten"], "  (CAP HIT)" if report["capHit"] else ""))
    print("[executor] report -> %s" % report_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
