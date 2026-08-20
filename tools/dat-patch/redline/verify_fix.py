#!/usr/bin/env python3
"""verify_fix.py -- AcmeRedline tier-1 verification loop (DESIGN.md section 8).

Given a work item's target (a RenderSurface 0x06 or a GfxObj 0x01) and two dats
-- the PRE dat the reporter saw and the POST dat a lane just wrote -- render a
record-level BEFORE/AFTER A/B board by CALLING the pipeline's existing
`texture_lane.make_board` (tools/dat-patch/texture_lane.py:768), then optionally
close the redline loop by appending a `fixed` status event whose note carries
the board path.

    python3 verify_fix.py --target 0x06003C97 \
        --pre  ~/ac_base_dats/client_portal.dat \
        --post /some/patched/client_portal.dat \
        --root /tmp/verify-run --wbt <WorldBuilder.Terminal.dll> \
        [--gid 0x01000827] \
        [--status redline-status.jsonl --entry rl-... --release acme-r10]

What the board shows (make_board's own contract, texture_lane.py:897-967):
  * LEFT  "TODAY"   -- retail mesh + base re-export textures (from --pre)
  * RIGHT "PATCHED" -- the arm-C displaced mesh + textures DXT-decoded straight
                       out of --post, identical camera + daylight on both panels
So it is a genuine two-dat A/B for the TEXTURE on a record, read back from the
patched dat through the client's own reader (WBT/DRW). It is NOT a
geometry-from-post-dat diff: make_board recomputes the arm-C mesh rather than
reading --post's geometry (gallery.py does read export/ back, but it is a
run-once script bound to a tranche dir, not a callable -- see DESIGN.md 8b).

Everything is READ-ONLY on the dats. The only writes are the board PNG under
--root and, if asked, one appended line to the status log.

TODO (not verified): make_board requires the retail re-export PNG corpus
(matlib.TEX_BASE, default /mnt/wbterminal2/tex-reexport-2026-07-30) for the
BEFORE textures and a built WorldBuilder.Terminal.dll for the AFTER decode.
Without --wbt the AFTER panel renders untextured (decoded stays empty,
texture_lane.py:916); without the corpus the BEFORE panel does too. The board
still renders and is still a valid geometry A/B in that degraded mode.
"""
import argparse
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DATPATCH = os.path.dirname(HERE)


def find_gfxobj_using_rs(pre_dat_path, rs_hex, limit=None):
    """Scan 0x01 records for the FIRST GfxObj whose surface set routes to rs_hex.
    Uses gfxlib's own Surface->SurfaceTexture->RenderSurface walk (gfxlib.py:318).
    Returns a gid hex or None."""
    sys.path.insert(0, DATPATCH)
    import gfxlib
    P = gfxlib.Portal(pre_dat_path)
    rs_int = int(rs_hex, 16)
    n = 0
    for gid in sorted(i for i in P.dat.files if (i >> 24) == 0x01):
        try:
            rec = P.gfx(gid)
        except Exception:
            continue
        for sid in rec["surfaces"]:
            s = P.surface(sid)
            if s and s.get("rsId") and int(s["rsId"], 16) == rs_int:
                return "0x%08X" % gid
        n += 1
        if limit and n >= limit:
            break
    return None


def main(argv=None):
    ap = argparse.ArgumentParser(
        description=__doc__.splitlines()[0],
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--target", required=True,
                    help="the work item's target: a RenderSurface 0x06.. or a "
                         "GfxObj 0x01..")
    ap.add_argument("--pre", required=True, help="PRE dat (what the reporter saw)")
    ap.add_argument("--post", required=True, help="POST dat (a lane just wrote)")
    ap.add_argument("--root", required=True, help="work dir for the board output")
    ap.add_argument("--wbt", default=None, help="WorldBuilder.Terminal.dll (for "
                    "AFTER-texture DXT decode from --post)")
    ap.add_argument("--gid", default=None,
                    help="GfxObj to render (required-ish for an 0x06 target; "
                         "skips the scan). For an 0x01 target it defaults to the "
                         "target itself.")
    ap.add_argument("--scan-limit", type=int, default=0,
                    help="cap the RS->gid scan (0 = whole dat)")
    ap.add_argument("--status", default=None, help="redline-status.jsonl to append to")
    ap.add_argument("--entry", default=None, help="entry id for the status event")
    ap.add_argument("--release", default=None, help="kit tag for the fixed event")
    ap.add_argument("--by", default="verify_fix.py")
    ap.add_argument("--dry", action="store_true",
                    help="resolve the gid and print what would render, no board")
    a = ap.parse_args(argv)

    for p in (a.pre, a.post):
        if not os.path.exists(p):
            raise SystemExit("missing dat: %s" % p)
    pre = os.path.abspath(a.pre)
    post = os.path.abspath(a.post)
    root = os.path.abspath(a.root)
    os.makedirs(root, exist_ok=True)

    tgt = a.target.upper()
    kind = tgt[:4]
    if kind == "0X06":
        gid = a.gid
        if not gid:
            print("[verify] scanning %s for a GfxObj that uses %s ..."
                  % (os.path.basename(pre), tgt))
            gid = find_gfxobj_using_rs(pre, tgt, a.scan_limit or None)
            if not gid:
                raise SystemExit("no GfxObj in %s routes to %s -- pass --gid"
                                 % (os.path.basename(pre), tgt))
        print("[verify] RenderSurface target %s rendered via GfxObj %s" % (tgt, gid))
    elif kind == "0X01":
        gid = a.gid or tgt
        print("[verify] GfxObj target %s" % gid)
    else:
        raise SystemExit("--target must be a 0x06 RenderSurface or 0x01 GfxObj")

    # pipeline.P is bound at import from DATPATCH_PORTAL; point it at PRE first.
    os.environ["DATPATCH_PORTAL"] = pre
    wbt_run = None
    if a.wbt:
        os.environ.setdefault("DOTNET_ROLL_FORWARD", "LatestMajor")
        wbt_run = ["dotnet", os.path.abspath(a.wbt), "--stdin"]

    if a.dry:
        print("[verify] --dry: would call texture_lane.make_board(root=%s, "
              "base=%s, patched=%s, gid=%s, wbt=%s)"
              % (root, os.path.basename(pre), os.path.basename(post), gid,
                 bool(wbt_run)))
        return 0

    sys.path.insert(0, DATPATCH)
    import texture_lane
    print("[verify] rendering A/B board (this calls texture_lane.make_board) ...")
    board_path, lum_pairs = texture_lane.make_board(root, pre, post,
                                                    int(gid, 16), wbt_run)
    board_path = os.path.abspath(board_path)
    print("[verify] board -> %s" % board_path)
    print("[verify] frame luminance BEFORE->AFTER per view:")
    for view, lb, la in lum_pairs:
        delta = 100 * (la / lb - 1) if lb else 0.0
        print("    %-6s  %.4f -> %.4f  (%+.1f%%)" % (view, lb, la, delta))

    if a.status:
        if not (a.entry and a.release):
            print("[verify] --status given without --entry/--release: not "
                  "writing a status event (a 'fixed' event needs both).",
                  file=sys.stderr)
        else:
            sys.path.insert(0, HERE)
            import status_writer
            note = ("verified: A/B board %s | frame lum %s"
                    % (board_path,
                       ", ".join("%s %.3f->%.3f" % (v, lb, la)
                                 for v, lb, la in lum_pairs)))
            ev = dict(entryId=a.entry, at=status_writer.utcnow(), state="fixed",
                      release=a.release, note=note[:2000], by=a.by)
            status_writer.append_event(a.status, ev)
            print("[verify] appended fixed status event for %s -> %s"
                  % (a.entry, os.path.abspath(a.status)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
