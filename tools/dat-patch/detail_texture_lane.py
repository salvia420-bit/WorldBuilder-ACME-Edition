#!/usr/bin/env python3
"""detail_texture_lane.py -- Phase-4 lane 4.H2: terrain DETAIL-texture upscale.

GREEN / turnkey micro-lane (research: docs/dat-patch/research/highres-terrain-lanes-research.md).
Detail textures render through LScape::GenerateDetailSurface -> makeCustomSurface /
UseTextureMap (DECOMP:307706-307717), a normal DXT-capable CSurface path that is
DISJOINT from the ImgTex::MergeTexture composite buffer that killed the terrain-2x
lane (4.H3).  So the 3 detail RenderSurfaces can be upsized + DXT-encoded like any
other object texture, without touching the 30 base merge SurfaceTextures.

Candidate set (verified read-only against ~/ac_base_dats/client_portal.dat this run):
  0x060037D2  64x64   A8R8G8B8  detailTexTiling 1  (generic, 29 terrain types)
  0x06006D57  256x256 A8R8G8B8  detailTexTiling 4  (BarrenRock)
  0x06006D58  256x256 A8R8G8B8  detailTexTiling 4  (Grassland)
All three carry a meaningful (non-opaque) alpha channel = the detail-blend strength,
so all three bake to DXT5 (BC3) to preserve it.

THIS FILE DOES NOT MODIFY ANY CORE LANE.  It reuses, as black boxes:
  * texture_lane.prep_dat / fixup_dat / b64_to_rgba / rs_header  (imported)
  * WorldBuilder.Terminal render-surface-import                  (subprocess, stdin JSON)
  * DatCompress / walk_check.py                                  (subprocess)

Pixels are sourced by decoding the base dat and upscaling 4x with Lanczos (PIL).
The GPU upscaler (ESRGAN/Remacri) lives on the buildbox/T4, which this laptop-scale
lane deliberately does NOT spin up; Lanczos is the documented laptop fallback (it
adds no invented detail, but gives clean 4x edges + mip headroom, which is all the
detail-blend layer needs).  Point --corpus at a Remacri PNG dir to override per-RS.

Outputs land in a SCRATCH copy under /mnt/wbterminal2 ONLY; ~/ac_base_dats is
read-only and guarded.

usage:
  detail_texture_lane.py bake  --root R [--base DAT] [--scale 4] [--cap 2048] [--corpus DIR]
  detail_texture_lane.py land  --root R --src-highres DAT [--out DAT] [--arena-blocks N]
                                        [--wbt DLL] [--datcompress DLL] [--no-compress]
  detail_texture_lane.py run   --root R --src-highres DAT ...   (bake then land)
"""
import argparse
import json
import os
import struct
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import texture_lane as TL   # black-box reuse: prep_dat, fixup_dat, b64_to_rgba, rs_header

REPO = "/home/wbterminal/WorldBuilder-ACME-Edition"
DEFAULT_BASE = "/home/wbterminal/ac_base_dats/client_portal.dat"
DEFAULT_WBT = REPO + "/WorldBuilder.Terminal/bin/Release/net8.0/WorldBuilder.Terminal.dll"
DEFAULT_DATCOMPRESS = REPO + "/tools/dat-patch/DatCompress/bin/Release/net8.0/DatCompress.dll"
WALK_CHECK = HERE + "/walk_check.py"

# The 3 detail RenderSurfaces + the SurfaceTexture that owns each (0x05 -> 0x06).
# Detail STs are single-entry already, so NO surface-texture-collapse is needed
# (research 2.5.4) -- we only rewrite the RenderSurface payload.
CANDIDATES = [
    dict(rs="0x060037D2", st="0x050012AF", tiling=1, note="generic (29 terrain types)"),
    dict(rs="0x06006D57", st="0x05001786", tiling=4, note="BarrenRock"),
    dict(rs="0x06006D58", st="0x05001787", tiling=4, note="Grassland"),
]

ARENA_GUARD = 2 ** 31 - 1   # int32 dat fileSize ceiling


def _die(msg):
    sys.stderr.write("FATAL: %s\n" % msg)
    sys.exit(1)


def _guard_not_base(path):
    rp = os.path.realpath(path)
    if "/ac_base_dats/" in rp or rp.startswith(os.path.expanduser("~/ac_base_dats")):
        _die("refusing to write inside ~/ac_base_dats (read-only base): %s" % rp)
    if not rp.startswith("/mnt/wbterminal2/"):
        _die("scratch/output dats MUST live under /mnt/wbterminal2/ (got %s)" % rp)


def wbt_call(wbt_dll, cmds, timeout=1800):
    run = ["dotnet", wbt_dll, "--stdin"]
    env = dict(os.environ, DOTNET_ROLL_FORWARD="LatestMajor")
    inp = "".join(json.dumps(c) + "\n" for c in cmds)
    p = subprocess.run(run, input=inp, capture_output=True, text=True,
                       timeout=timeout, env=env)
    outs = []
    for line in p.stdout.splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                outs.append(json.loads(line))
            except Exception:
                pass
    return outs, p


def read_base_rs(base_portal, wbt_dll):
    """Read + decode the candidate RenderSurfaces straight out of the base dat.
    Returns {rs_hex: dict(w,h,fmt,bytes,rgba)}.  Read-only."""
    import numpy as np
    cmds = [dict(command="chorizite-parse-dat-record", datPath=base_portal,
                 idHex=c["rs"], typeName="RenderSurface") for c in CANDIDATES]
    outs, p = wbt_call(wbt_dll, cmds, timeout=600)
    by = {}
    for o in outs:
        if o.get("command") != "chorizite-parse-dat-record":
            continue
        f = o.get("fields") or {}
        fmt = (f.get("format") or "").replace("PFID_", "")
        w, h = f.get("width"), f.get("height")
        rgba = TL.b64_to_rgba(fmt, w, h, f.get("sourceData"))
        if rgba is None:
            _die("could not decode %s (fmt=%s, err=%s)" %
                 (o.get("idHex"), fmt, o.get("errorMessage")))
        # raw A8R8G8B8 payload = w*h*4
        raw_bytes = int(w) * int(h) * 4
        by[o.get("idHex").upper()] = dict(w=int(w), h=int(h), fmt=fmt,
                                          raw_bytes=raw_bytes,
                                          rgba=np.ascontiguousarray(rgba))
    for c in CANDIDATES:
        if c["rs"].upper() not in by:
            _die("candidate %s missing from base dat parse" % c["rs"])
    return by


def pick_format(rgba):
    """DXT5 (BC3) if the alpha channel is meaningful (non-opaque anywhere),
    else DXT1 (BC1).  Detail-texture alpha = the detail blend strength, so any
    non-opaque content means DXT1 would destroy the layer's contribution."""
    if rgba.shape[-1] < 4:
        return "DXT1"
    a = rgba[..., 3]
    return "DXT5" if (a < 250).any() else "DXT1"


def bake(root, base_portal, wbt_dll, scale, cap, corpus):
    from PIL import Image
    os.makedirs(root, exist_ok=True)
    baked_dir = os.path.join(root, "baked")
    os.makedirs(baked_dir, exist_ok=True)

    base = read_base_rs(base_portal, wbt_dll)
    imports = []
    report = []
    for c in CANDIDATES:
        rs = c["rs"].upper()
        b = base[rs]
        src = Image.fromarray(b["rgba"], "RGBA")
        used_corpus = None
        target_w, target_h = b["w"] * scale, b["h"] * scale
        # cap the LONG side at `cap` (client UI path punishes oversize; 4x of 256
        # = 1024 <= 2048, well inside).  Keep multiple-of-4 for DXT + Serialize
        # identity (imageSize == w*h*bpp/8).
        s = min(scale, cap / max(b["w"], b["h"]))
        target_w = max(4, (int(round(b["w"] * s)) // 4) * 4)
        target_h = max(4, (int(round(b["h"] * s)) // 4) * 4)

        # optional Remacri/ESRGAN corpus override (a pre-upscaled PNG per RS)
        corpus_png = os.path.join(corpus, rs + ".png") if corpus else None
        if corpus_png and os.path.exists(corpus_png):
            up = Image.open(corpus_png).convert("RGBA")
            if up.size != (target_w, target_h):
                up = up.resize((target_w, target_h), Image.LANCZOS)
            used_corpus = corpus_png
        else:
            up = src.resize((target_w, target_h), Image.LANCZOS)

        fmt = pick_format(b["rgba"])
        png = os.path.join(baked_dir, rs + ".png")
        up.save(png)

        # payload byte estimate (block-compressed): DXT1 = 0.5 B/texel, DXT5 = 1
        bpp = 8 if fmt == "DXT1" else 16
        new_dxt_bytes = max(1, (target_w + 3) // 4) * max(1, (target_h + 3) // 4) * bpp
        imports.append(dict(idHex=c["rs"], pngPath=png, format=fmt, allowResize=True))
        report.append(dict(
            rs=c["rs"], st=c["st"], terrain=c["note"], detailTiling=c["tiling"],
            src_w=b["w"], src_h=b["h"], src_fmt=b["fmt"], src_raw_bytes=b["raw_bytes"],
            new_w=target_w, new_h=target_h, new_fmt=fmt, new_dxt_bytes=new_dxt_bytes,
            scale="%dx" % scale, upscaler=("corpus:" + os.path.basename(used_corpus))
                                          if used_corpus else "lanczos"))
    man = dict(lane="4.H2-detail-textures", base_portal=base_portal,
               scale=scale, cap=cap, imports=imports, records=report)
    json.dump(man, open(os.path.join(root, "bake-manifest.json"), "w"), indent=1)
    print("bake: %d detail RS baked -> %s" % (len(imports), baked_dir))
    for r in report:
        print("  %s  %dx%d %s -> %dx%d %s  (%d -> %d B, %s)" %
              (r["rs"], r["src_w"], r["src_h"], r["src_fmt"],
               r["new_w"], r["new_h"], r["new_fmt"],
               r["src_raw_bytes"], r["new_dxt_bytes"], r["upscaler"]))
    return man


def _hdr(path):
    with open(path, "rb") as f:
        f.seek(0x140)
        h = struct.unpack("<9i", f.read(36))
    return dict(blockSize=h[1], fileSize=h[2], freeHead=h[5], freeTail=h[6],
                freeCount=h[7])


def reset_free_list(path):
    """Zero the free list for the DRW contiguous-allocator bug state.

    render-surface-import into a prep_dat arena can leave the header with
    firstFreeBlock=0 while FreeBlockCount>0 -- an inconsistent state that
    texture_lane.fixup_dat's own compaction cannot fix (it guards on
    freeHead>0), and which walk_check rejects ("free chain length 0 != count").

    The retail client READ path never consults freeHead/freeTail/FreeBlockCount
    (decomp-verified; same premise as fixup_dat / DatExportFixer.PatchFreeBlocks
    BeforeExport), so the correct, zero-risk repair is to declare the free list
    EMPTY: freeHead=freeTail=fileSize, FreeBlockCount=0.  Any real free blocks
    (interior + the unused arena tail) become unreferenced dead space -- harmless
    and identical in kind to the "dead free-arena, harmless" the texture lane
    already ships.  No truncation, no block moves, so it cannot damage a live
    record's chain.  New code -- does not modify any core lane file.
    """
    HDR = 320
    h = _hdr(path)
    fs = h["fileSize"]
    if h["freeCount"] == 0 and h["freeHead"] in (0, fs):
        return dict(action="none", reason="free list already empty/consistent")
    with open(path, "r+b") as f:
        f.seek(HDR + 20)
        f.write(struct.pack("<3i", fs, fs, 0))   # freeHead, freeTail, freeCount
        f.flush()
        os.fsync(f.fileno())
    return dict(action="reset", old_freeHead=h["freeHead"],
                old_freeCount=h["freeCount"], dead_arena_bytes=h["freeCount"] * h["blockSize"])


def _datcompress(datcompress_dll, out, tag):
    print("land: DatCompress --verify (%s) ..." % tag)
    cp = subprocess.run(["dotnet", datcompress_dll, out, "--verify"],
                        capture_output=True, text=True,
                        env=dict(os.environ, DOTNET_ROLL_FORWARD="LatestMajor"),
                        timeout=5400)
    sys.stdout.write(cp.stdout[-1200:])
    if cp.returncode != 0:
        sys.stderr.write(cp.stderr[-2000:])
        _die("DatCompress (%s) returned %d" % (tag, cp.returncode))


def land(root, src_highres, out, arena_blocks, wbt_dll, datcompress_dll, compress,
         flow="compress"):
    from PIL import Image
    man_path = os.path.join(root, "bake-manifest.json")
    if not os.path.exists(man_path):
        _die("no bake-manifest.json in %s -- run `bake` first" % root)
    man = json.load(open(man_path))
    imports = man["imports"]

    out = out or os.path.join(root, "client_highres.dat")
    _guard_not_base(out)
    print("land: [flow=%s] copy %s -> %s" % (flow, src_highres, out))
    subprocess.run(["cp", "-f", src_highres, out], check=True)
    before_size = os.path.getsize(out)

    # ---- 1) make the allocator a valid free pool that render-surface-import can
    # chain MULTI-BLOCK records through.
    #
    # flow="compress" (DEFAULT, r9-proven): DatCompress the base first.  It
    # rewrites the (uncompressed) RenderSurfaces as zlib, freeing interior blocks
    # with VALID free-chain next-pointers, which DRW's writer then allocates from.
    # This is the ONLY flow proven to land large records: the live r9 highres
    # carries 4096x4096 DXT records imported exactly this way that read back
    # clean.  (Verified 2026-08-20.)
    #
    # flow="prep": texture_lane.prep_dat appends a ZEROED arena.  DRW's contiguous
    # allocator chains SMALL records (<=~65 blocks) through it, but corrupts
    # MULTI-HUNDRED-block records -- the arena's next-pointers are all zero, so a
    # >~65-block record's chain terminates after ~1 block and reads back 0x0.
    # Reproduced this run on both 512^2 (258 blk) and 1024^2 (1029 blk) DXT5.
    # Kept only for the <=64^2 case / A-B comparison; NOT for the 4x detail bake.
    if flow == "compress":
        _datcompress(datcompress_dll, out, "pass 1: free interior blocks")
    elif flow == "prep":
        h = _hdr(out)
        need = sum(os.path.getsize(im["pngPath"]) for im in imports)
        if arena_blocks is None:
            arena_blocks = max(8000, (need // h["blockSize"]) + 4000)
        if before_size + arena_blocks * h["blockSize"] >= ARENA_GUARD:
            _die("arena would push fileSize past int32 ceiling")
        print("land: prep zeroed arena (%d blocks, blockSize=%d)" % (arena_blocks, h["blockSize"]))
        TL.prep_dat(out, arena_blocks)
    else:
        _die("unknown flow %r (compress|prep)" % flow)

    # ---- 2) import the 3 detail RS (DXT, allowResize, allowCreate: they are new in highres).
    print("land: render-surface-import %d records ..." % len(imports))
    outs, p = wbt_call(wbt_dll, [dict(command="render-surface-import", datPath=out,
                                      allowCreate=True, imports=imports)], timeout=1800)
    imp = next((o for o in outs if o.get("command") == "render-surface-import"), None)
    if not imp:
        _die("render-surface-import returned nothing\n" + (p.stdout or p.stderr)[-2000:])
    written = imp.get("writtenCount")
    failed = imp.get("failCount")
    fails = [r for r in imp.get("records", []) if r.get("status") == "FAIL" or r.get("error")]
    print("land: import written=%s failed=%s" % (written, failed))
    for r in imp.get("records", []):
        print("   %s  %s  %sx%s %s  bytes=%s blocks=%s  %s" % (
            r.get("didHex"), r.get("status"),
            r.get("width"), r.get("height"), r.get("dstFormat"),
            r.get("bytesUsed") or r.get("bytes"), r.get("blocksUsed") or r.get("blocks"),
            r.get("error") or ""))
    if fails or (failed or 0) > 0:
        _die("import had failures: %s" % json.dumps(fails[:5]))

    # ---- 3) structural fixup (leaf-sentinel zeroing + arena compaction) -> client-conformant.
    print("land: structural fixup ...")
    fx = TL.fixup_dat(out)
    # render-surface-import into a prep arena can leave freeHead=0/freeCount>0
    # (DRW contiguous-allocator bug), which fixup_dat cannot compact and
    # walk_check rejects.  Clean the dead arena tail ourselves (same convention).
    _ = fx
    h_after = _hdr(out)
    if h_after["freeCount"] != 0:
        # fixup_dat could not compact (freeHead=0 allocator-bug state); declare
        # the free list empty so the file is walk_check/client consistent.
        c = reset_free_list(out)
        print("land: free-list reset: %s" % c)

    # ---- 4) DatCompress --verify (proves trevis's decompression patch; reclaims bulk).
    if compress:
        print("land: DatCompress --verify ...")
        cp = subprocess.run(["dotnet", datcompress_dll, out, "--verify"],
                            capture_output=True, text=True,
                            env=dict(os.environ, DOTNET_ROLL_FORWARD="LatestMajor"),
                            timeout=3600)
        sys.stdout.write(cp.stdout[-1500:])
        if cp.returncode != 0:
            sys.stderr.write(cp.stderr[-2000:])
            _die("DatCompress returned %d" % cp.returncode)

    # ---- 5) walk_check (client-reader integrity tripwire).
    print("land: walk_check ...")
    wc = subprocess.run(["python3", WALK_CHECK, out], capture_output=True, text=True)
    sys.stdout.write(wc.stdout)
    if wc.returncode != 0:
        sys.stderr.write(wc.stderr)
        _die("walk_check FAILED (rc=%d)" % wc.returncode)

    # ---- 6) read-back: re-parse each RS from the landed dat, assert new dims/fmt.
    print("land: read-back parse ...")
    cmds = [dict(command="chorizite-parse-dat-record", datPath=out,
                 idHex=im["idHex"], typeName="RenderSurface") for im in imports]
    outs2, _ = wbt_call(wbt_dll, cmds, timeout=600)
    rec_by_id = {r["rs"].upper(): r for r in man["records"]}
    rt = []
    ok_all = True
    for o in outs2:
        if o.get("command") != "chorizite-parse-dat-record":
            continue
        f = o.get("fields") or {}
        rid = o.get("idHex").upper()
        got_fmt = (f.get("format") or "").replace("PFID_", "")
        want = rec_by_id.get(rid, {})
        ok = (not o.get("errorMessage") and f.get("width") == want.get("new_w")
              and f.get("height") == want.get("new_h") and got_fmt == want.get("new_fmt"))
        ok_all = ok_all and ok
        rt.append(dict(rs=o.get("idHex"), got_w=f.get("width"), got_h=f.get("height"),
                       got_fmt=got_fmt, want_w=want.get("new_w"), want_h=want.get("new_h"),
                       want_fmt=want.get("new_fmt"), ok=ok, err=o.get("errorMessage")))
    after_size = os.path.getsize(out)
    result = dict(
        lane="4.H2-detail-textures", src_highres=src_highres, out=out,
        out_size_before=before_size, out_size_after=after_size,
        import_written=written, import_failed=failed,
        walk_check="PASS", roundtrip=rt, roundtrip_ok=ok_all,
        gate_ok=bool(ok_all and (failed or 0) == 0), records=man["records"])
    json.dump(result, open(os.path.join(root, "land-result.json"), "w"), indent=1)
    print("\nland: roundtrip:")
    for r in rt:
        print("   %s  %sx%s %s  ->  %s" % (r["rs"], r["got_w"], r["got_h"], r["got_fmt"],
                                           "OK" if r["ok"] else "MISMATCH %s" % r))
    print("land: GATE %s  (out=%s, %.1f MiB)" %
          ("PASS" if result["gate_ok"] else "FAIL", out, after_size / 2 ** 20))
    return result


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    for c in ("bake", "land", "run"):
        s = sub.add_parser(c)
        s.add_argument("--root", required=True)
        s.add_argument("--base", default=DEFAULT_BASE)
        s.add_argument("--src-highres", default=None)
        s.add_argument("--out", default=None)
        s.add_argument("--scale", type=int, default=4)
        s.add_argument("--cap", type=int, default=2048)
        s.add_argument("--corpus", default=None)
        s.add_argument("--arena-blocks", type=int, default=None)
        s.add_argument("--wbt", default=DEFAULT_WBT)
        s.add_argument("--datcompress", default=DEFAULT_DATCOMPRESS)
        s.add_argument("--no-compress", action="store_true",
                       help="skip the post-import DatCompress pass-2 (records are "
                            "incompressible DXT; flow=compress already ran pass-1)")
        s.add_argument("--flow", default="compress", choices=("compress", "prep"),
                       help="compress (r9-proven, lands large records via "
                            "DatCompress-freed interior blocks) | prep (zeroed "
                            "arena; ONLY safe for <=64^2 records)")
    a = ap.parse_args()
    if a.cmd in ("bake", "run"):
        bake(a.root, a.base, a.wbt, a.scale, a.cap, a.corpus)
    if a.cmd in ("land", "run"):
        if not a.src_highres:
            _die("--src-highres required for land/run")
        land(a.root, a.src_highres, a.out, a.arena_blocks, a.wbt,
             a.datcompress, not a.no_compress, flow=a.flow)


if __name__ == "__main__":
    main()
