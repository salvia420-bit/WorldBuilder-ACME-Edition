#!/usr/bin/env python3
"""texture_lane.py -- the TEXTURE LEGIBILITY LANE.

Bakes the legibility recipe (legibility.py, mid gainset) into the RenderSurfaces
used by the patched architecture GfxObjs, DXT-encodes them into a COPY of the
geometry tranche's client_portal.dat via WorldBuilder.Terminal, collapses the
owning SurfaceTextures to the single shipped entry, then validates by re-reading
every record straight back out of the patched dat.

Layering: the geometry tranche patched GfxObjs (0x01); textures (RenderSurface
0x06 / SurfaceTexture 0x05) are an INDEPENDENT db type, so we patch textures INTO
the geometry export to produce a COMBINED geometry+texture dat.

Reads (python, read-only):
  * BASE portal.dat  -> record structure, surfaces per GfxObj, height fields
  * base texture PNGs (~/tex-reexport-2026-07-30/<rsId>.png) -> albedo + seam h
Writes (WorldBuilder.Terminal, into the patched COPY):
  * render-surface-import  -> baked PNG -> DXT1/DXT5 RenderSurface
  * surface-texture-collapse -> single-entry SurfaceTexture
Reads back (python datlib on the patched copy):
  * RenderSurface header (Id,DataCategory,W,H,Format,len) round-trip
  * DXT-decoded pixels for the A/B board AFTER panels

Subcommands:
  probe    --base DAT --rsid 0x06.. [--wbt ...]   layout self-check vs WBT
  derive   --root R --base DAT                     matched surface set -> surfaces.json
  run      --root R --base DAT --patched DAT --ids-file F [--board GID,GID]
                                                   bake+import+collapse+roundtrip
  board    --root R --base DAT --patched DAT --gid GID   one A/B board

Every number this emits comes from a real run.  No fabrication.
"""
import argparse
import io
import json
import os
import struct
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# --remacri: bake onto the Remacri 4x upscales (owner-approved recipe) instead
# of the retail-res base textures. The 2026-08-15 box run shipped base-res
# bakes because the box has no Remacri corpus — set this on a laptop rerun.
PREFER_REMACRI = False

# ----- PixelFormat numeric ids (retail D3DFMT / FourCC values) --------------
PF = {
    1: "INDEX16", 65: "P8",
    20: "R8G8B8", 21: "A8R8G8B8", 23: "R5G6B5", 26: "A4R4G4B4", 28: "A8",
    827611204: "DXT1",   # b'DXT1' little-endian
    861165636: "DXT3",   # b'DXT3'
    894720068: "DXT5",   # b'DXT5'
    1000: "CUSTOM_RAW_JPEG",
}
NAME2PF = {v: k for k, v in PF.items()}
DXT1, DXT3, DXT5 = 827611204, 861165636, 894720068
PALETTED = {1, 65}


# ----- raw RenderSurface header from the dat (datlib) -----------------------
def rs_header(dat, rsid):
    """Parse a RenderSurface record straight out of a datlib.Dat.
    Layout (DBObj HasId|HasDataCategory): Id,DataCategory,Width,Height,Format,
    _sourceDataLength,SourceData[,DefaultPaletteId]."""
    raw = dat.get(rsid)
    if raw is None or len(raw) < 24:
        return None
    oid, dcat, w, h, fmt, dlen = struct.unpack_from("<6I", raw, 0)
    return dict(id=oid, dcat=dcat, w=w, h=h, fmt=fmt,
                fmtname=PF.get(fmt, "0x%08X" % fmt), dlen=dlen,
                data=raw[24:24 + dlen])


def _dds(fourcc, w, h, data):
    """Wrap raw DXT block data in a minimal DDS container PIL can decode."""
    block = 8 if fourcc == b"DXT1" else 16
    linsize = max(1, (w + 3) // 4) * max(1, (h + 3) // 4) * block
    hdr = b"DDS " + struct.pack("<I", 124)
    hdr += struct.pack("<I", 0x1 | 0x2 | 0x4 | 0x1000 | 0x80000)  # flags
    hdr += struct.pack("<I", h) + struct.pack("<I", w)
    hdr += struct.pack("<I", linsize) + struct.pack("<I", 0) + struct.pack("<I", 0)
    hdr += b"\x00" * 44                      # reserved1[11]
    hdr += struct.pack("<I", 32) + struct.pack("<I", 0x4)  # pf size, DDPF_FOURCC
    hdr += fourcc + struct.pack("<5I", 0, 0, 0, 0, 0)
    hdr += struct.pack("<I", 0x1000) + struct.pack("<4I", 0, 0, 0, 0)
    return hdr + data


def decode_rs(dat, rsid):
    """Read a RenderSurface out of the dat and return an RGBA uint8 array."""
    from PIL import Image
    import numpy as np
    h = rs_header(dat, rsid)
    if h is None:
        return None, None
    fmt = h["fmt"]
    if fmt in (DXT1, DXT3, DXT5):
        fourcc = {DXT1: b"DXT1", DXT3: b"DXT3", DXT5: b"DXT5"}[fmt]
        im = Image.open(io.BytesIO(_dds(fourcc, h["w"], h["h"], h["data"])))
        return np.asarray(im.convert("RGBA"), np.uint8), h["fmtname"]
    if fmt == NAME2PF["A8R8G8B8"]:
        a = np.frombuffer(h["data"], np.uint8).reshape(h["h"], h["w"], 4)
        # stored BGRA
        return a[:, :, [2, 1, 0, 3]].copy(), h["fmtname"]
    if fmt == NAME2PF["R8G8B8"]:
        a = np.frombuffer(h["data"], np.uint8).reshape(h["h"], h["w"], 3)
        out = np.dstack([a[:, :, 2], a[:, :, 1], a[:, :, 0],
                         np.full(a.shape[:2], 255, np.uint8)])
        return out, h["fmtname"]
    return None, h["fmtname"]


def b64_to_rgba(fmt_name, w, h, b64):
    """Decode a WBT chorizite-parse sourceData base64 payload to RGBA uint8."""
    import base64
    import numpy as np
    from PIL import Image
    if not b64 or not w or not h:
        return None
    data = base64.b64decode(b64)
    if fmt_name in ("DXT1", "DXT3", "DXT5"):
        fourcc = {"DXT1": b"DXT1", "DXT3": b"DXT3", "DXT5": b"DXT5"}[fmt_name]
        im = Image.open(io.BytesIO(_dds(fourcc, w, h, data)))
        return np.asarray(im.convert("RGBA"), np.uint8)
    if fmt_name == "A8R8G8B8":
        a = np.frombuffer(data, np.uint8).reshape(h, w, 4)
        return a[:, :, [2, 1, 0, 3]].copy()
    if fmt_name == "R8G8B8":
        a = np.frombuffer(data, np.uint8).reshape(h, w, 3)
        return np.dstack([a[:, :, 2], a[:, :, 1], a[:, :, 0],
                          np.full((h, w), 255, np.uint8)])
    return None


# ----- allocator prep (bake/scripts/prep_dat.py, generalised in place) -------
def prep_dat(path, blocks):
    """Append a ZEROED free arena at EOF and repoint the header free list at it,
    so DatReaderWriter 2.1.2's contiguous ReserveBlockCore never hands out a live
    block.  Header @0x140: magic,blockSize,fileSize,type,subset,firstFreeBlock,
    lastFreeBlock,freeBlockCount,root."""
    HDR = 320
    disk = os.path.getsize(path)
    with open(path, "r+b") as f:
        f.seek(HDR)
        magic, bs, fs, typ, sub, ffb, lfb, fbc, root = struct.unpack("<9i", f.read(36))
        arena = fs if fs == disk else (disk - (disk % bs))
        new = arena + blocks * bs
        if new >= 2 ** 31:
            raise SystemExit("prep: arena would push fileSize past int32 (2 GiB)")
        f.seek(arena)
        CH = 4096
        zeros = bytes(CH * bs)
        left = blocks
        while left > 0:
            n = min(CH, left)
            f.write(zeros[:n * bs])
            left -= n
        f.seek(HDR + 8)
        f.write(struct.pack("<i", new))
        f.seek(HDR + 20)
        f.write(struct.pack("<3i", arena, new - bs, blocks))
        f.flush()
        os.fsync(f.fileno())
    print("prep: appended %d blocks (%d bytes) arena@%d -> fileSize %d"
          % (blocks, blocks * bs, arena, new))
    return dict(blocks=blocks, blockSize=bs, arena_start=arena, new_size=new)


def fixup_dat(path, compact=True):
    """Post-write structural fixup for a DRW-written dat; run AFTER all imports,
    BEFORE shipping. Makes the file retail-client conformant (decomp-verified
    2026-08-15 against acclient.c BTree::Search / CLBlockAllocator):

    1. Chorizite/DRW writes 0xCDCDCDCD into unused leaf-node branch slots. The
       retail client's ONLY leaf test is NextNode_[0] != 0, so a sentinel leaf
       is mis-read as an internal node: every lookup MISS in that leaf seeks to
       a negative offset and poisons the 100-slot node cache, and any tree
       enumeration recurses into garbage. Hits are unaffected, which is why the
       bug survives tooling round-trips. Zero every sentinel branch word.
       (Same fix as WorldBuilder.Shared DatExportFixer.FixLeafBranchSentinels,
       which the WBT project-export path runs but direct DRW writes bypass.)
    2. Compacts the dead free arena prep_dat appended: if the whole tail
       [freeHead, fileSize) is free per the header AND nothing references a
       block in it, truncate and set freeHead=freeTail=fileSize, freeCount=0
       (the DatExportFixer.PatchFreeBlocksBeforeExport convention; the retail
       READ path never consults these fields, this keeps write-tooling safe)."""
    HDR, SENT = 320, 0xCDCDCDCD
    objsize = 4 * 0x3E + 4 + 24 * 0x3D
    f = open(path, "r+b")
    f.seek(HDR)
    magic, bs, fs, typ, sub, ffb, lfb, fbc, root = struct.unpack("<9i", f.read(36))
    if magic != 0x5442:
        raise SystemExit("fixup: bad magic 0x%x" % magic)
    maxblk = 0

    def chain(off, need):
        nonlocal maxblk
        blocks, have, cur = [], 0, off
        while have < need and cur > 0:
            if cur % bs or cur + bs > fs or cur in blocks:
                return None
            blocks.append(cur)
            maxblk = max(maxblk, cur)
            have += bs - 4
            if have >= need:
                break
            f.seek(cur)
            cur = struct.unpack("<i", f.read(4))[0]
        return blocks

    def read_chain(blocks, need):
        out = bytearray()
        for b in blocks:
            f.seek(b + 4)
            out += f.read(min(bs - 4, need - len(out)))
        return out

    def write_chain(blocks, data):
        off = 0
        for b in blocks:
            n = min(bs - 4, len(data) - off)
            f.seek(b + 4)
            f.write(data[off:off + n])
            off += n

    fixed, entries, seen = 0, [], set()
    stack = [root]
    while stack:
        off = stack.pop()
        if off <= 0 or off >= fs or off in seen:
            continue
        seen.add(off)
        blocks = chain(off, objsize)
        if not blocks:
            continue
        node = read_chain(blocks, objsize)
        cnt = struct.unpack_from("<I", node, 62 * 4)[0]
        if cnt > 61:
            continue
        branches = list(struct.unpack_from("<62I", node, 0))
        for i in range(cnt):
            _bf, oid, foff, fsz = struct.unpack_from("<4I", node, 62 * 4 + 4 + i * 24)
            entries.append((foff, fsz))
        dirty = False
        for i, b in enumerate(branches):
            if b == SENT:
                struct.pack_into("<I", node, i * 4, 0)
                dirty = True
            elif 0 < b < fs:
                stack.append(b)
        if dirty:
            write_chain(blocks, node)
            fixed += 1
    print("fixup: zeroed sentinel branches in %d leaf node(s); %d entries" % (fixed, len(entries)))

    for foff, fsz in entries:
        cur, rem = foff, fsz
        while cur > 0 and rem > 0:
            maxblk = max(maxblk, cur)
            f.seek(cur)
            cur = struct.unpack("<i", f.read(4))[0]
            rem -= bs - 4

    if compact and fbc > 0 and ffb > 0 and fbc * bs == fs - ffb and maxblk + bs <= ffb:
        f.seek(HDR + 8)
        f.write(struct.pack("<i", ffb))
        f.seek(HDR + 20)
        f.write(struct.pack("<3i", ffb, ffb, 0))
        f.flush()
        os.fsync(f.fileno())
        f.truncate(ffb)
        print("fixup: compacted free arena %d -> %d bytes (-%.1f MiB)"
              % (fs, ffb, (fs - ffb) / 2 ** 20))
    elif compact:
        print("fixup: compaction skipped (maxblk=%d freeHead=%d freeCount=%d span=%d)"
              % (maxblk, ffb, fbc, (fs - ffb) // bs))
    f.flush()
    os.fsync(f.fileno())
    f.close()
    return dict(leaves_fixed=fixed, max_block=maxblk)


# ----- WorldBuilder.Terminal driver -----------------------------------------
def wbt(run, cmds, timeout=1800):
    """run = argv list for `dotnet WBT.dll --stdin`; cmds = list of dicts.
    Returns list of parsed json result objects (one per emitting command)."""
    inp = "".join(json.dumps(c) + "\n" for c in cmds)
    p = subprocess.run(run, input=inp, capture_output=True, text=True,
                       timeout=timeout)
    outs = []
    for line in p.stdout.splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                outs.append(json.loads(line))
            except Exception:
                pass
    if not outs and p.returncode != 0:
        sys.stderr.write("WBT rc=%d stderr:\n%s\n" % (p.returncode, p.stderr[-2000:]))
    return outs, p


def set_caches(root):
    """Pin matlib's height/deepbump caches under the run root (its module
    defaults point at /mnt/wbterminal2 which does not exist on the buildbox)."""
    import matlib
    matlib.CACHE = os.path.join(root, "hcache") + "/"
    matlib.DBCACHE = os.path.join(root, "dbcache") + "/"
    os.makedirs(matlib.CACHE, exist_ok=True)
    os.makedirs(matlib.DBCACHE, exist_ok=True)


# ----- matched surface set ---------------------------------------------------
def derive(root, base_portal):
    import gfxlib
    os.environ.setdefault("DATPATCH_PORTAL", base_portal)
    stats = json.load(open(os.path.join(root, "build_stats.json")))
    P = gfxlib.Portal(base_portal)
    gids = sorted(int(k, 16) for k in stats)
    surf_of = {}          # gid -> [sid]
    all_sids = set()
    for gid in gids:
        try:
            rec = P.gfx(gid)
        except Exception:
            continue
        sids = sorted(set(rec.get("surfaces", [])))
        surf_of["0x%08X" % gid] = ["0x%08X" % s for s in sids]
        all_sids.update(sids)
    surfaces = {}         # sid_hex -> {st, rs, ...}
    for sid in sorted(all_sids):
        s = P.surface(sid)
        if not s:
            continue
        st = s.get("tex") or 0
        rs = s.get("rsId")
        surfaces["0x%08X" % sid] = dict(
            surfaceTexture=("0x%08X" % st) if st else None,
            renderSurface=rs,
            surfaceType=s.get("type"),
            hasTexture=bool(rs))
    out = dict(base=base_portal, gfxObjCount=len(surf_of),
               surfaceCount=len(surfaces),
               withRenderSurface=sum(1 for v in surfaces.values() if v["hasTexture"]),
               surfaces=surfaces, gfxObjSurfaces=surf_of)
    p = os.path.join(root, "surfaces.json")
    json.dump(out, open(p, "w"), indent=1)
    print("derive: %d GfxObjs, %d surfaces, %d with a RenderSurface -> %s"
          % (len(surf_of), len(surfaces), out["withRenderSurface"], p))
    return out


# ----- bake one RenderSurface ------------------------------------------------
def bake_one(sid_int, base_portal):
    """-> (baked RGBA uint8, info) or (None, reason)."""
    import numpy as np
    import matlib
    import pipeline
    import legibility
    metas = pipeline.surface_meta({sid_int})
    m = metas.get(sid_int) or {}
    rs = m.get("rsId")
    if not rs:
        return None, "no rsId"
    arr, src = matlib.load_tex_full(rs, prefer_remacri=PREFER_REMACRI, max_side=4096)
    if arr is None:
        return None, "no base png"
    h_full = {sid_int: m["h"]} if m.get("h") is not None else {}
    tex_after = {sid_int: arr}
    tex_base = {sid_int: arr}
    G = legibility.GAINSETS["mid"]
    out, infos = legibility.bake_all(tex_after, tex_base, metas, h_full,
                                     G["g_hi"], G["g_lo"], G["a0"])
    a = out.get(sid_int)
    if a is None:
        return None, "bake returned None"
    u8 = (np.clip(a, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)
    info = infos.get(sid_int, {})
    info["cls"] = m.get("cls")
    info["amp"] = m.get("amp")
    return u8, info


def has_alpha(u8):
    import numpy as np
    if u8.shape[-1] < 4:
        return False
    return bool((u8[..., 3] < 250).mean() > 0.001)


# ----- full run --------------------------------------------------------------
def run_lane(root, base_portal, patched_portal, ids_file, wbt_run, board_gids,
             tag):
    import numpy as np
    import gfxlib
    from PIL import Image
    os.environ.setdefault("DATPATCH_PORTAL", base_portal)
    set_caches(root)

    surfaces = json.load(open(os.path.join(root, "surfaces.json")))["surfaces"]
    want = [l.strip() for l in open(ids_file) if l.strip()]
    base_dat = gfxlib.datlib.Dat(base_portal)

    baked_dir = os.path.join(root, "baked")
    os.makedirs(baked_dir, exist_ok=True)
    res = dict(tag=tag, requested=len(want), processed=0, encoded=0,
               skipped_palette=0, skipped_nondxt=0, skipped_nobase=0,
               skipped_other=0, imports=[], skips=[])

    imports = []          # WBT imports[] specs (rsId 0x06 -> baked png)
    collapses = []        # WBT collapses[] specs (st 0x05, keepDid rs)
    plan = []             # per-surface plan for roundtrip

    t0 = time.time()
    for i, sid_hex in enumerate(want):
        rec = surfaces.get(sid_hex)
        if not rec or not rec["hasTexture"]:
            res["skipped_other"] += 1
            res["skips"].append(dict(sid=sid_hex, why="no rsId"))
            continue
        rs_hex = rec["renderSurface"]
        st_hex = rec["surfaceTexture"]
        rs_int = int(rs_hex, 16)
        st_int = int(st_hex, 16) if st_hex else 0
        hdr = rs_header(base_dat, rs_int)
        if hdr is None:
            res["skipped_nobase"] += 1
            res["skips"].append(dict(sid=sid_hex, rs=rs_hex, why="rs absent in base"))
            continue
        if hdr["fmt"] in PALETTED:
            res["skipped_palette"] += 1
            res["skips"].append(dict(sid=sid_hex, rs=rs_hex,
                                     why="palettized " + hdr["fmtname"]))
            continue
        base_png = os.path.join(os.environ["DATPATCH_TEX_BASE"], rs_hex + ".png")
        if not os.path.exists(base_png):
            res["skipped_nobase"] += 1
            res["skips"].append(dict(sid=sid_hex, rs=rs_hex, why="no base png"))
            continue
        try:
            u8, info = bake_one(int(sid_hex, 16), base_portal)
        except Exception as e:
            res["skipped_other"] += 1
            res["skips"].append(dict(sid=sid_hex, rs=rs_hex, why="bake error: %s" % e))
            continue
        if u8 is None:
            res["skipped_other"] += 1
            res["skips"].append(dict(sid=sid_hex, rs=rs_hex, why="bake: %s" % info))
            continue
        H, W = u8.shape[:2]
        alpha = has_alpha(u8)
        fmt = "DXT5" if alpha else "DXT1"
        if W % 4 or H % 4:
            res["skipped_nondxt"] += 1
            res["skips"].append(dict(sid=sid_hex, rs=rs_hex,
                                     why="dims %dx%d not mult-4" % (W, H)))
            continue
        png = os.path.join(baked_dir, rs_hex + ".png")
        Image.fromarray(u8, "RGBA").save(png)
        imports.append(dict(idHex=rs_hex, pngPath=png, format=fmt, allowResize=True))
        if st_int:
            collapses.append(dict(idHex=st_hex, keepDid=rs_hex))
        plan.append(dict(sid=sid_hex, rs=rs_hex, st=st_hex, fmt=fmt,
                         w=W, h=H, srcFmt=hdr["fmtname"],
                         cls=info.get("cls"), embossed=info.get("embossed"),
                         lum_after=info.get("lum_after"), lum_base=info.get("lum_base")))
        res["encoded"] += 1
        res["processed"] += 1
        if (i + 1) % 25 == 0:
            print("  baked %d/%d (%.0fs)" % (i + 1, len(want), time.time() - t0))
    print("bake done: %d encoded of %d (%.0fs)"
          % (res["encoded"], len(want), time.time() - t0))

    # ---- import (WBT, batch) ----
    portal_before = os.path.getsize(patched_portal)
    res["portal_before_bytes"] = portal_before
    if imports:
        print("importing %d RenderSurfaces into %s ..." % (len(imports),
                                                           os.path.basename(patched_portal)))
        outs, _ = wbt(wbt_run, [dict(command="render-surface-import",
                                     datPath=patched_portal, imports=imports)])
        imp = next((o for o in outs if o.get("command") == "render-surface-import"), None)
        res["import_result"] = {k: imp.get(k) for k in
                                ("writtenCount", "failCount", "requestedCount")} if imp else None
        if imp:
            fails = [r for r in imp.get("records", []) if r.get("status") == "FAIL"]
            res["import_fails"] = fails[:20]
            res["encoded"] = imp.get("writtenCount", res["encoded"])
        # ---- collapse (WBT, batch) ----
        print("collapsing %d SurfaceTextures ..." % len(collapses))
        outs2, _ = wbt(wbt_run, [dict(command="surface-texture-collapse",
                                      datPath=patched_portal, collapses=collapses)])
        col = next((o for o in outs2 if o.get("command") == "surface-texture-collapse"), None)
        res["collapse_result"] = {k: col.get(k) for k in
                                  ("collapsedCount", "unchangedCount", "failCount",
                                   "requestedCount")} if col else None
        if col:
            cfails = [r for r in col.get("records", []) if r.get("status") == "FAIL"]
            res["collapse_fails"] = cfails[:20]
    portal_after = os.path.getsize(patched_portal)
    res["portal_after_bytes"] = portal_after
    res["portal_after_mib"] = round(portal_after / (1024 * 1024), 1)
    res["portal_ceiling_mib"] = 2048
    res["portal_under_ceiling"] = portal_after < 2000 * 1024 * 1024

    # ---- integrity: the whole RenderSurface tree must still enumerate for DRW,
    # with the SAME record count as the base dat (no records lost/overlapped).
    # datlib's naive full-walk chokes on the rewritten b-tree, so use DRW.
    print("integrity: enumerating RenderSurface records in base + patched ...")
    lo, _ = wbt(wbt_run, [
        dict(command="chorizite-list-dat-records", datPath=base_portal, typeName="RenderSurface"),
        dict(command="chorizite-list-dat-records", datPath=patched_portal, typeName="RenderSurface")])
    counts = [o.get("recordCount") for o in lo
              if o.get("command") == "chorizite-list-dat-records"]
    base_n = counts[0] if len(counts) > 0 else None
    pat_n = counts[1] if len(counts) > 1 else None
    res["integrity"] = dict(base_rs_count=base_n, patched_rs_count=pat_n,
                            equal=(base_n is not None and base_n == pat_n))

    # ---- round-trip: DRW re-parse a spread SAMPLE straight out of the patched
    # dat; each imported record was ALSO read back inside render-surface-import
    # (writtenBytes), so writtenCount is itself a per-record round-trip.
    n_sample = min(24, len(plan))
    step = max(1, len(plan) // n_sample) if plan else 1
    sample = plan[::step][:n_sample]
    parse_cmds = [dict(command="chorizite-parse-dat-record", datPath=patched_portal,
                       idHex=pl["rs"], typeName="RenderSurface") for pl in sample]
    rt_pass = rt_fail = 0
    rt_details = []
    if parse_cmds:
        pouts, _ = wbt(wbt_run, parse_cmds)
        by_id = {}
        for o in pouts:
            if o.get("command") != "chorizite-parse-dat-record":
                continue
            f = o.get("fields") or {}
            by_id[int(o.get("idHex"), 16)] = dict(
                w=f.get("width"), h=f.get("height"),
                fmt=(f.get("format") or "").replace("PFID_", ""),
                err=o.get("errorMessage"))
        for pl in sample:
            g = by_id.get(int(pl["rs"], 16))
            ok = (g is not None and not g["err"] and g["fmt"] == pl["fmt"]
                  and g["w"] == pl["w"] and g["h"] == pl["h"])
            if ok:
                rt_pass += 1
            else:
                rt_fail += 1
                rt_details.append(dict(rs=pl["rs"], want=[pl["fmt"], pl["w"], pl["h"]],
                                       got=g))
    res["roundtrip_sampled"] = len(sample)
    res["roundtrip_pass"] = rt_pass
    res["roundtrip_fail"] = rt_fail
    res["roundtrip_fail_details"] = rt_details[:20]
    res["collapse_count"] = len(collapses)
    res["gate_ok"] = bool(
        res.get("import_result") and res["import_result"].get("failCount") == 0
        and not res.get("collapse_fails")
        and res["integrity"]["equal"] and rt_fail == 0 and res["portal_under_ceiling"])
    res["plan"] = plan
    return res, plan


# ----- slice picker ----------------------------------------------------------
def pick_slice(root, base_portal, n_surfaces=40):
    """Choose 2 cottage-scale board GfxObjs (most carved wall surfaces) and a
    slice surface set that INCLUDES every surface of the board GfxObjs (so their
    AFTER textures exist in the patched dat), padded to ~n_surfaces."""
    import gfxlib
    import matlib
    os.environ.setdefault("DATPATCH_PORTAL", base_portal)
    sj = json.load(open(os.path.join(root, "surfaces.json")))
    surfaces = sj["surfaces"]
    gfxSurf = sj["gfxObjSurfaces"]
    P = gfxlib.Portal(base_portal)
    WALL = {"Brick", "Stone", "Timber", "Plank", "Shingle"}
    score = {}
    for gid_hex, sids in gfxSurf.items():
        tex = [s for s in sids if surfaces.get(s, {}).get("hasTexture")]
        if not (3 <= len(tex) <= 16) or not tex:
            continue
        wall = 0
        for sid in tex:
            s = P.surface(int(sid, 16))
            if not s:
                continue
            cls, _ = matlib.classify(int(sid, 16), s)
            if cls in WALL:
                wall += 1
        if wall >= 1:
            score[gid_hex] = (wall, len(tex))
    board_gids = sorted(score, key=lambda g: (-score[g][0], score[g][1]))[:2]
    slice_sids = []
    seen = set()
    for g in board_gids:
        for sid in gfxSurf[g]:
            if surfaces.get(sid, {}).get("hasTexture") and sid not in seen:
                seen.add(sid); slice_sids.append(sid)
    for g in sorted(gfxSurf):
        for sid in gfxSurf[g]:
            if len(slice_sids) >= n_surfaces:
                break
            if surfaces.get(sid, {}).get("hasTexture") and sid not in seen:
                seen.add(sid); slice_sids.append(sid)
    out = dict(board_gids=board_gids, sliceCount=len(slice_sids),
               board_scores={g: score[g] for g in board_gids},
               slice=slice_sids)
    json.dump(out, open(os.path.join(root, "slice.json"), "w"), indent=1)
    with open(os.path.join(root, "slice_ids.txt"), "w") as f:
        f.write("\n".join(slice_sids) + "\n")
    print("slice: %d surfaces, board gids %s" % (len(slice_sids), board_gids))
    return out


def all_ids(root):
    sj = json.load(open(os.path.join(root, "surfaces.json")))
    ids = [k for k, v in sj["surfaces"].items() if v.get("hasTexture")]
    with open(os.path.join(root, "all_ids.txt"), "w") as f:
        f.write("\n".join(ids) + "\n")
    print("all_ids: %d texturable surfaces" % len(ids))
    return ids


# ----- A/B board (BEFORE base textures, AFTER patched-dat textures) ---------
def make_board(root, base_portal, patched_portal, gid, wbt_run=None):
    import numpy as np
    from PIL import Image, ImageDraw, ImageFont
    os.environ.setdefault("DATPATCH_PORTAL", base_portal)
    import gfxlib
    import pipeline
    import relief3d
    import render3
    import legibility
    # ladder -> r2lib does a module-level makedirs() under a hardcoded
    # /mnt/wbterminal2 path that does not exist on the buildbox; neutralise
    # makedirs for the duration of the import so the constants still load.
    _orig_makedirs = os.makedirs
    os.makedirs = lambda *a, **k: None
    try:
        import ladder
    finally:
        os.makedirs = _orig_makedirs
    set_caches(root)

    SUN_C = (1.00, 0.965, 0.895); FILL_C = (0.62, 0.74, 1.00)
    AMB_C = (0.94, 0.965, 1.00); AMBIENT = 0.55; DIFFUSE = 0.62; FILL_AMT = 0.22
    SKY = ((146, 188, 232), (226, 235, 240))
    SUN_CAM = np.array([-0.46, -0.74, 0.49]); FILL_CAM = np.array([0.52, 0.30, 0.80])
    BOARD_W = 1000; PANEL = {"hero": 640, "graze": 560}

    def world_light(yaw, pitch, v):
        R = render3.rot(np.radians(yaw), np.radians(pitch))
        w = R.T @ (v / np.linalg.norm(v))
        return tuple(w)

    def rend(mesh, keys, tex, cam, size):
        return render3.render(
            mesh["V"], mesh["F"], mesh["UV"], mesh["NR"], keys, tex, size=size,
            yaw=np.radians(cam["yaw"]), pitch=np.radians(cam["pitch"]), fit=cam["fit"],
            light=world_light(cam["yaw"], cam["pitch"], SUN_CAM),
            fill_light=world_light(cam["yaw"], cam["pitch"], FILL_CAM),
            ambient=AMBIENT, diffuse=DIFFUSE, fill_amt=FILL_AMT,
            sun_color=SUN_C, fill_color=FILL_C, ambient_color=AMB_C,
            bg_grad=SKY, scale_pad=cam.get("pad", 1.06), cull=cam.get("cull", 0))

    def poly_geom(src, p):
        v = p["v"]; V = np.array([src.P[i] for i in v]); cen = V.mean(0)
        n = np.cross(V[1] - V[0], V[2] - V[0]); ln = np.linalg.norm(n)
        n = n / ln if ln > 1e-12 else np.array([0.0, 0.0, 1.0])
        area = sum(0.5 * float(np.linalg.norm(np.cross(V[k] - V[0], V[k + 1] - V[0])))
                   for k in range(1, len(v) - 1))
        return cen, n, area, V

    def face_on_yaw(n):
        return float(np.degrees(np.arctan2(-n[0], -n[1])))

    def outward(n, cen, mid):
        d = np.asarray(cen) - np.asarray(mid); d[2] *= 0.15
        return n if float(n @ d) >= 0 else -n

    def fit_projected(V, yaw, pitch, size, margin=1.13):
        R = render3.rot(np.radians(yaw), np.radians(pitch)); P = np.asarray(V) @ R.T
        mid = np.array([(P[:, 0].min() + P[:, 0].max()) / 2,
                        (P[:, 1].min() + P[:, 1].max()) / 2,
                        (P[:, 2].min() + P[:, 2].max()) / 2])
        dx = max(P[:, 0].max() - P[:, 0].min(), 1e-3)
        dz = max(P[:, 2].max() - P[:, 2].min(), 1e-3)
        W, H = size; s = min(W / dx, H / dz) / margin
        return (R.T @ mid, min(W, H) / (2.0 * s))

    def pick_wall(src, classes=ladder.WALL, wide=False):
        best, ba = None, -1.0
        for p in src.polys:
            if p.get("invisible") or p.get("excluded") or p.get("h") is None:
                continue
            if p.get("amp", 0.0) <= 0:
                continue
            if classes and p.get("cls") not in classes:
                continue
            cen, n, area, V = poly_geom(src, p); s = area
            if abs(n[2]) > 0.75:
                s *= 0.25
            if wide:
                ext = V.max(0) - V.min(0); horiz = float(np.hypot(ext[0], ext[1]))
                s *= float(np.clip(horiz / 2.5, 0.15, 1.0))
                s *= float(np.clip(horiz / max(ext[2], 1e-3), 0.10, 1.0))
            if s > ba:
                ba, best = s, (cen, n, area, V)
        return best

    def cameras(src):
        V = np.array(src.P); lo, hi = V.min(0), V.max(0); mid = (lo + hi) / 2
        wall = pick_wall(src) or pick_wall(src, None)
        wcen, wn0, warea, WV = wall; wn = outward(wn0, wcen, mid)
        hyaw = face_on_yaw(wn) + 38.0
        hero = dict(yaw=hyaw, pitch=15.0, pad=1.0, cull=1,
                    fit=fit_projected(V, hyaw, 15.0, (BOARD_W, PANEL["hero"])))
        gw = pick_wall(src, wide=True) or wall
        gcen, gn0, garea, GV = gw; gn = outward(gn0, gcen, mid)
        span = float(np.linalg.norm(GV.max(0) - GV.min(0)))
        graze = dict(fit=(gcen, max(1.8, 0.42 * span)),
                     yaw=face_on_yaw(gn) + 72.0, pitch=6.0, pad=1.03, cull=1)
        return dict(hero=hero, graze=graze)

    def bg_mask(img, grad):
        a = np.asarray(img, np.int16); H = a.shape[0]
        top = np.array(grad[0], np.float32); bot = np.array(grad[1], np.float32)
        t = (np.arange(H, dtype=np.float32) / max(H - 1, 1))[:, None]
        bgr = np.round((top[None, :] * (1 - t) + bot[None, :] * t)).astype(np.int16)
        return np.abs(a - bgr[:, None, :]).max(2) > 3

    def panel_lum(img, grad):
        a = np.asarray(img, np.float32) / 255.0; m = bg_mask(img, grad)
        return float(legibility.lum(a)[m].mean()) if m.any() else 0.0

    def font(sz, bold=True):
        p = ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else
             "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")
        try:
            return ImageFont.truetype(p, sz)
        except Exception:
            return ImageFont.load_default()

    F_BIG, F_SM, F_HDR, F_TINY = font(40), font(21, False), font(32), font(18, False)

    def labelled(img, tag, sub, accent):
        w, h = img.size; bar = 72
        out = Image.new("RGB", (w, h + bar), (24, 26, 32)); out.paste(img, (0, 0))
        d = ImageDraw.Draw(out); d.rectangle([0, h, w, h + bar], fill=accent)
        d.text((20, h + 5), tag, font=F_BIG, fill=(255, 255, 255))
        d.text((22, h + 47), sub, font=F_SM, fill=(255, 255, 255))
        return out

    # ---- build BEFORE (retail) and AFTER (arm C + patched-dat textures) ----
    rec = pipeline.P.gfx(gid)
    metasA, _ = ladder.build_metas(rec, "A")
    srcA = relief3d.SourceMesh.from_record(rec, metasA)
    texB, _ = pipeline.load_textures(metasA, remacri=False, max_side=1024)
    before = pipeline.original(srcA)
    keysB = pipeline.face_surface(srcA, before["poly"])

    src, metas, h_full, resC = ladder.build_arm(rec, "C")
    keysA = pipeline.face_surface(src, resC["poly"])

    # AFTER textures: DRW-decode straight out of the PATCHED dat (one batched
    # WBT call), keyed by Surface id.  datlib's naive walk chokes on the
    # rewritten b-tree, so read through DRW/WBT which is the client's own reader.
    rs_of = {sid: m.get("rsId") for sid, m in metas.items() if m.get("rsId")}
    uniq = sorted(set(rs_of.values()))
    parse = [dict(command="chorizite-parse-dat-record", datPath=patched_portal,
                  idHex=rs, typeName="RenderSurface") for rs in uniq]
    decoded = {}
    if parse and wbt_run:
        outs, _ = wbt(wbt_run, parse)
        for o in outs:
            if o.get("command") != "chorizite-parse-dat-record":
                continue
            f = o.get("fields") or {}
            fmt = (f.get("format") or "").replace("PFID_", "")
            arr = b64_to_rgba(fmt, f.get("width"), f.get("height"), f.get("sourceData"))
            decoded[int(o.get("idHex"), 16)] = arr
    texA = {}
    for sid, m in metas.items():
        rs = m.get("rsId")
        arr = decoded.get(int(rs, 16)) if rs else None
        texA[sid] = (arr.astype(np.float32) / 255.0) if arr is not None else None

    cams = cameras(srcA)
    name = "0x%08X" % gid
    blocks = []
    hdr = Image.new("RGB", (BOARD_W, 118), (18, 20, 26)); d = ImageDraw.Draw(hdr)
    d.text((20, 14), "%s   TODAY vs PATCHED (textures read from patched dat)" % name,
           font=F_HDR, fill=(245, 246, 250))
    d.text((20, 58), "legibility bake mid g_hi=0.35 g_lo=0.50 a0=0.15  |  "
           "AFTER textures DXT-decoded from client_portal.dat", font=F_TINY,
           fill=(168, 176, 190))
    d.text((20, 84), "identical camera + identical daylight on both panels",
           font=F_TINY, fill=(168, 176, 190))
    blocks.append(hdr)
    CAP = {"hero": "a.  whole building, 3/4 view", "graze": "c.  grazing view down a wall"}
    lum_pairs = []
    for f in ("hero", "graze"):
        cam = cams[f]; size = (BOARD_W, PANEL[f])
        A = rend(before, keysB, texB, cam, size)
        B = rend(resC, keysA, texA, cam, size)
        lb, la = panel_lum(A, SKY), panel_lum(B, SKY)
        lum_pairs.append((f, lb, la))
        cb = Image.new("RGB", (BOARD_W, 50), (36, 40, 50)); dd = ImageDraw.Draw(cb)
        dd.text((20, 12), CAP[f], font=font(26), fill=(226, 231, 240))
        blocks.append(cb)
        blocks.append(labelled(A, "TODAY", "retail mesh + base 128px textures   "
                               "frame lum %.3f" % lb, (96, 100, 112)))
        blocks.append(labelled(B, "PATCHED", "4x mesh + legibility-baked DXT from dat   "
                               "frame lum %.3f  (%+.1f%%)"
                               % (la, 100 * (la / max(lb, 1e-6) - 1)), (26, 118, 72)))
    Hh = sum(b.size[1] for b in blocks) + 8 * (len(blocks) - 1)
    out = Image.new("RGB", (BOARD_W, Hh), (18, 20, 26)); y = 0
    for b in blocks:
        out.paste(b, (0, y)); y += b.size[1] + 8
    boards_dir = os.path.join(root, "boards"); os.makedirs(boards_dir, exist_ok=True)
    p = os.path.join(boards_dir, "board_%s.png" % name)
    out.save(p)
    print("wrote board %s  %s  lum=%s" % (p, out.size, lum_pairs))
    return p, lum_pairs


def assemble_results(root, patched_portal):
    import glob
    import hashlib
    def load(p):
        return json.load(open(p)) if os.path.exists(p) else None
    slc = load(os.path.join(root, "run_slice.json"))
    full = load(os.path.join(root, "run_full.json"))
    sl = load(os.path.join(root, "slice.json")) or {}
    surf = load(os.path.join(root, "surfaces.json")) or {}
    def sha(p):
        h = hashlib.sha256()
        with open(p, "rb") as f:
            for c in iter(lambda: f.read(1 << 22), b""):
                h.update(c)
        return h.hexdigest()
    boards = sorted(glob.glob(os.path.join(root, "boards", "*.png")))
    size = os.path.getsize(patched_portal)

    def block(d):
        if not d:
            return None
        return dict(surfaces_requested=d["requested"], encoded=d["encoded"],
                    skipped_palette=d["skipped_palette"], skipped_nondxt=d["skipped_nondxt"],
                    skipped_nobase=d["skipped_nobase"], skipped_other=d["skipped_other"],
                    import_result=d.get("import_result"), collapse_result=d.get("collapse_result"),
                    integrity=d.get("integrity"), roundtrip_sampled=d.get("roundtrip_sampled"),
                    roundtrip_pass=d.get("roundtrip_pass"), roundtrip_fail=d.get("roundtrip_fail"),
                    portal_after_mib=d.get("portal_after_mib"),
                    gate_ok=d.get("gate_ok"),
                    verdict=("PASS" if d.get("gate_ok") else "FAIL"))
    res = dict(
        lane="texture-legibility",
        recipe="legibility mid (g_hi=0.35 g_lo=0.50 a0=0.15), mean-lum 1.15x, "
               "seam height, DXT1(opaque)/DXT5(alpha), SurfaceTexture collapse",
        base_portal="~/ac_base_dats/client_portal.dat",
        patched_base="~/tranche-run/export/client_portal.dat (geometry tranche, 447 GfxObjs)",
        matched_surface_set=dict(
            patched_gfxObjs=(surf.get("gfxObjCount")),
            surfaces_total=(surf.get("surfaceCount")),
            with_render_surface=(surf.get("withRenderSurface"))),
        slice_board_gids=sl.get("board_gids"),
        slice=block(slc),
        full=block(full),
        portal_after_bytes=size, portal_after_mib=round(size / 1048576, 1),
        portal_ceiling_mib=2048, portal_under_ceiling=size < 2000 * 1048576,
        portal_note="file includes the zeroed free-arena appended by the allocator "
                    "prep (dead space, harmless, under the 2 GiB ceiling)",
        boards=boards,
        slice_gate_verdict=("PASS" if (slc and slc.get("gate_ok")) else "FAIL"),
        full_verdict=("PASS" if (full and full.get("gate_ok")) else "FAIL"),
        portal_sha256=sha(patched_portal))
    json.dump(res, open(os.path.join(root, "results.json"), "w"), indent=1)
    print("results.json: slice=%s full=%s portal=%s MiB under_ceiling=%s"
          % (res["slice_gate_verdict"], res["full_verdict"],
             res["portal_after_mib"], res["portal_under_ceiling"]))
    return res


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    for c in ("probe", "derive", "slice", "allids", "prep", "fixup", "run", "board", "results"):
        s = sub.add_parser(c)
        s.add_argument("--root", default=os.getcwd())
        s.add_argument("--base", required=True)
        s.add_argument("--patched", default=None)
        s.add_argument("--rsid", default=None)
        s.add_argument("--ids-file", default=None)
        s.add_argument("--gid", default=None)
        s.add_argument("--board", default="")
        s.add_argument("--tag", default="run")
        s.add_argument("--blocks", type=int, default=450000)
        s.add_argument("--out", default=None)
        s.add_argument("--wbt", default=None, help="path to WorldBuilder.Terminal.dll")
        s.add_argument("--remacri", action="store_true",
                       help="bake onto Remacri 4x upscales (needs the corpus mounted)")
    a = ap.parse_args()
    if getattr(a, "remacri", False):
        global PREFER_REMACRI
        PREFER_REMACRI = True
    wbt_run = None
    if a.wbt:
        wbt_run = ["dotnet", a.wbt, "--stdin"]
        os.environ.setdefault("DOTNET_ROLL_FORWARD", "LatestMajor")

    if a.cmd == "probe":
        import gfxlib
        dat = gfxlib.datlib.Dat(a.base)
        rs = int(a.rsid, 16)
        h = rs_header(dat, rs)
        print("python:", json.dumps({k: h[k] for k in ("id", "w", "h", "fmt", "fmtname", "dlen")}))
        if wbt_run:
            outs, _ = wbt(wbt_run, [dict(command="chorizite-parse-dat-record",
                                         datPath=a.base, idHex=a.rsid, typeName="RenderSurface")])
            o = next((x for x in outs if x.get("command") == "chorizite-parse-dat-record"), None)
            f = (o or {}).get("fields") or {}
            print("wbt:", json.dumps({k: f.get(k) for k in ("width", "height", "format")}),
                  "err:", (o or {}).get("errorMessage"))
    elif a.cmd == "derive":
        derive(a.root, a.base)
    elif a.cmd == "slice":
        pick_slice(a.root, a.base)
    elif a.cmd == "allids":
        all_ids(a.root)
    elif a.cmd == "prep":
        prep_dat(a.patched, a.blocks)
    elif a.cmd == "fixup":
        fixup_dat(a.patched)
    elif a.cmd == "results":
        assemble_results(a.root, a.patched)
    elif a.cmd == "run":
        board_gids = [int(x, 16) for x in a.board.split(",") if x.strip()]
        res, plan = run_lane(a.root, a.base, a.patched, a.ids_file, wbt_run,
                             board_gids, a.tag)
        out = a.out or os.path.join(a.root, "run_%s.json" % a.tag)
        json.dump(res, open(out, "w"), indent=1)
        print("wrote", out)
        print(json.dumps({k: res[k] for k in
                          ("requested", "encoded", "skipped_palette", "skipped_nondxt",
                           "skipped_nobase", "skipped_other", "roundtrip_pass",
                           "roundtrip_fail", "portal_after_mib", "portal_under_ceiling")},
                         indent=1))
    elif a.cmd == "board":
        make_board(a.root, a.base, a.patched, int(a.gid, 16), wbt_run)


if __name__ == "__main__":
    main()
