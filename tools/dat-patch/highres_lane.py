#!/usr/bin/env python3
"""highres_lane.py -- the r7.1 HIGHRES (bake-both) LANE.

Reads a `client_highres.dat` -- the acquired EoR one (133,169,152 bytes,
2,294 RenderSurfaces) or the CI fixture from `synth_highres.py` -- and
produces upscaled replacement RenderSurface records for the 1,342 lane ids:
the highres entries our r7 importer collapsed out of the SurfaceTexture
chains whose portal entry we already baked (F1 degrade audit,
`dropped_from_retail`).

WHY 2x AND NOT 4x
-----------------
r7 upscales the *portal* record 4x linear.  A retail highres record is
normally 2x its portal sibling in each dimension (mip-chain doubling;
inventory report S4b, `RenderTexture::ConstructTexture` loading
`m_SourceLevels[i]` into D3D mip level i, which is `(w>>i, h>>i)`).  So
reaching the SAME output size from the highres source is a **2x** upscale,
not 4x -- halving the upscaler's hallucination budget.  The headline is
"2x instead of 4x", not "512 instead of 256" (report S5: the median highres
source is 256^2, not 512^2).

Measured on the real dat: 1,318 lane records are a 2x job, 2 are 4x (their
highres record is 1:1 with the portal sibling, so highres buys nothing there
and we must still reach r7's size), and 22 need no upscale at all.

THE ROUTES (counts from a real-dat plan run, 2026-08-17)
--------------------------------------------------------
  UPSCALE       1,320 records.  Target dims = **the r7 output dims**, not a
                blind 2x -- see plan_lane(); this makes "never ship smaller
                than r7 already does" an invariant instead of a hope.
                Linear scale: 2x on 1,318, 4x on 2.
  PASSTHROUGH   22 records whose retail highres record ALREADY meets or
                exceeds the r7 output size; their bytes are copied verbatim.
                The cheapest win in the lane and the only records that ship
                genuine retail pixels.  (The inventory report predicted 20;
                the two extras are 0x06003950, whose highres record is 4x its
                portal sibling, and 0x0600628F at 1024x1024 DXT1.)
  PALETTE       INDEX16/P8 records take the palette route, NOT a DXT
                re-encode: the output stays INDEX16/P8 against the record's
                own DefaultPaletteId, so ClothingTable subpalette recolours
                still work (pallib.py's RECOLOR SAFETY note).  385 of the
                1,342 lane records are INDEX16.

UPSCALER = PLUGGABLE STAGE
--------------------------
  --baked DIR            the other lanes' `baked/` convention: one
                         `<ID>.png` (or `0x<ID>.png`) per record, already at
                         the target dims, produced by whatever upscaler
                         (Remacri/ESRGAN 2x) the driver ran on a GPU box.
                         PNG -> record encoders here are SCAFFOLDING quality
                         for the DXT case; shipping bakes should go through
                         WorldBuilder.Terminal `render-surface-import` like
                         the other lanes.
  --synth-passthrough    no PNGs, no GPU: the deterministic NEAREST upscale
                         in the stored encoding (bit-exact, reuses
                         synth_highres.upscale2).  End-to-end plumbing proof,
                         NOT shipping content.
  (both)                 PNG where one exists, nearest elsewhere.

By default the output is a COMPLETE drop-in client_highres.dat: lane records
replaced, the other 952 records and the 0xFFFF0001 iteration entry carried
through byte-for-byte.  `--lane-only` emits just the 1,342.

USAGE
-----
  python3 highres_lane.py plan --highres H.dat [--portal P.dat] --out plan.json
  python3 highres_lane.py run  --highres H.dat --out OUT.dat --synth-passthrough \\
                               [--baked DIR] [--manifest M.json] [--lane-only]
  python3 highres_lane.py verify --dat OUT.dat --manifest M.json --highres H.dat

Refuses to write inside ~/ac_base_dats or the r7 export / ship trees.
"""
import argparse
import json
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import datlib                                                   # noqa: E402
import synth_highres as SH                                      # noqa: E402
from synth_highres import (DatWriter, ITERATION_ID, PALETTED, PF_NAME,      # noqa: E402
                           PF_DXT1, PF_DXT3, PF_DXT5, PF_INDEX16, PF_P8,
                           BYTES_PER_PIXEL, DXT_BLOCK_BYTES,
                           build_rs, parse_rs, rs_expected_length, upscale2,
                           load_chain_table, guard_write, _raw_directory)

DEFAULT_AUDIT = "/mnt/wbterminal2/dat-patch-r7/degrade-chain-audit.json"
DEFAULT_PORTAL = os.path.expanduser("~/ac_base_dats/client_portal.dat")

ROUTE_UPSCALE = "UPSCALE"   # scale is per-record (2x on 1,318, 4x on 2)
ROUTE_PASSTHROUGH = "PASSTHROUGH-RETAIL-BYTES"


# ------------------------------------------------------------------ planning
def plan_lane(highres_path, audit_path, portal_path=None):
    """-> (plan list, stats dict).  One row per lane id (the 1,342
    `dropped_from_retail` highres ids), with its route, scale and target dims.

    THE TARGET IS THE r7 OUTPUT SIZE, not a blind 2x.  Shipping 2x-of-highres
    is normally the same thing (highres = 2x portal, r7 = 4x portal), but the
    REAL client_highres.dat has 11 chains where the highres record is 1:1 with
    its portal sibling and one that is 4x -- so a blind 2x would *regress* r7
    on some ids and overshoot on others.  Anchoring on `r7_dim` makes "never
    ship smaller than r7" an invariant of the plan instead of a hope, and
    reduces to the 2x profile on 1,318 of the 1,342.
    """
    table = load_chain_table(audit_path)
    hr = SH.open_dat(highres_path)
    portal = SH.open_dat(portal_path) if portal_path else None
    rows, stats = [], dict(lane=0, present=0, missing=0, upscale=0, passthrough=0,
                           palette=0, dxt=0, raw=0, no_r7_reference=0,
                           non_integer_scale=0, scales={})
    for hid in sorted(table):
        rec = table[hid]
        if not rec["lane"]:
            continue
        stats["lane"] += 1
        raw = hr.get(hid)
        if raw is None:
            stats["missing"] += 1
            rows.append(dict(id="0x%08X" % hid, sibling="0x%08X" % rec["sibling"],
                             route="ABSENT-FROM-HIGHRES", r7_dim=rec["r7_dim"]))
            continue
        stats["present"] += 1
        src = parse_rs(raw)
        sw, sh = src["w"], src["h"]
        r7 = rec["r7_dim"]
        if r7:
            rw, rh = (int(x) for x in r7.split("x"))
        else:
            stats["no_r7_reference"] += 1
            rw, rh = sw * 2, sh * 2            # fall back to the 2x profile
        if sw >= rw and sh >= rh:
            route, (tw, th), scale = ROUTE_PASSTHROUGH, (sw, sh), 1
            stats["passthrough"] += 1
        else:
            route, (tw, th) = ROUTE_UPSCALE, (rw, rh)
            scale = rw / sw if sw else 0
            if scale != rh / sh or scale != int(scale):
                stats["non_integer_scale"] += 1
                scale = None
            else:
                scale = int(scale)
            stats["upscale"] += 1
        stats["scales"][str(scale)] = stats["scales"].get(str(scale), 0) + 1
        if src["fmt"] in PALETTED:
            stats["palette"] += 1
            encoder = "palette"
        elif src["fmt"] in DXT_BLOCK_BYTES:
            stats["dxt"] += 1
            encoder = "dxt"
        else:
            stats["raw"] += 1
            encoder = "raw"
        portal_dim = None
        if portal:
            p = parse_rs(portal.get(rec["sibling"]))
            if p:
                portal_dim = "%dx%d" % (p["w"], p["h"])
        rows.append(dict(
            id="0x%08X" % hid, sibling="0x%08X" % rec["sibling"], route=route,
            encoder=encoder, fmt=src["fmt"], scale=scale,
            fmt_name=PF_NAME.get(src["fmt"], "0x%08X" % src["fmt"]),
            src_dim="%dx%d" % (sw, sh), target_dim="%dx%d" % (tw, th),
            r7_dim=r7, portal_dim=portal_dim,
            palette=(None if src["palette"] is None else "0x%08X" % src["palette"]),
            data_category=src["dcat"], st=rec["st"]))
    return rows, stats


def _dim_ge(wh, s):
    bw, bh = (int(x) for x in s.split("x"))
    return wh[0] >= bw and wh[1] >= bh


# ------------------------------------------------------------ PNG -> record
def _load_png(path):
    from PIL import Image
    import numpy as np
    return np.asarray(Image.open(path).convert("RGBA"), np.uint8)


def encode_raw(rgba, fmt):
    """RGBA uint8 (H,W,4) -> raw SourceData bytes for an uncompressed format.
    Byte orders follow ACE DatLoader/FileTypes/Texture.cs:GetImageColorArray."""
    import numpy as np
    h, w = rgba.shape[:2]
    if fmt == SH.PF_R8G8B8:                     # stored B,G,R
        return np.dstack([rgba[..., 2], rgba[..., 1], rgba[..., 0]]).tobytes()
    if fmt == SH.PF_LSCAPE_RGB:                 # stored R,G,B
        return rgba[..., :3].tobytes()
    if fmt == SH.PF_A8R8G8B8:                   # stored as u32 ARGB LE = B,G,R,A
        return np.dstack([rgba[..., 2], rgba[..., 1], rgba[..., 0], rgba[..., 3]]).tobytes()
    if fmt in (SH.PF_A8, SH.PF_LSCAPE_ALPHA):
        return rgba[..., 0].tobytes()
    if fmt == SH.PF_R5G6B5:
        v = ((rgba[..., 0].astype(np.uint16) >> 3) << 11) | \
            ((rgba[..., 1].astype(np.uint16) >> 2) << 5) | \
            (rgba[..., 2].astype(np.uint16) >> 3)
        return v.astype("<u2").tobytes()
    if fmt == SH.PF_A4R4G4B4:
        v = ((rgba[..., 3].astype(np.uint16) >> 4) << 12) | \
            ((rgba[..., 0].astype(np.uint16) >> 4) << 8) | \
            ((rgba[..., 1].astype(np.uint16) >> 4) << 4) | \
            (rgba[..., 2].astype(np.uint16) >> 4)
        return v.astype("<u2").tobytes()
    raise ValueError("no raw encoder for PixelFormat %d" % fmt)


def upscale_paletted_nearest(src, tw, th):
    """THE ONLY sanctioned upscale for INDEX16/P8 records: per-index nearest
    replication in the stored encoding (synth_highres.upscale2 doubling until
    the target dims).  Every output pixel carries an index the source record
    already had at that location, so the distinct-index set, the sentinel
    (transparency) pixel FRACTION, and ClothingTable subpalette recolours are
    all preserved EXACTLY.

    Added 2026-08-21 after the r9/r10 regression: the PNG route RGBA-resampled
    paletted records and re-quantized them back through encode_paletted, which
    (a) exploded ClipMap index-0 transparency (Shallows Destroyer RenderSurface
    0x06006111: 3.1%% -> 38.8%% sentinel pixels -> holes in the hide) and
    (b) collapsed the distinct-index count on ~176 clothing textures
    (0x060070B0: 163 -> 30 indices), so subpalette recolours land on the wrong
    rows -> muddy town-NPC robes.  Requantization of a paletted record is now
    forbidden in this lane -- see the guard in _encode_from_png."""
    data, cw, ch = src["data"], src["w"], src["h"]
    if tw % cw or th % ch or (tw // cw) != (th // ch):
        raise ValueError("paletted replication needs an integer uniform scale "
                         "(%dx%d -> %dx%d)" % (cw, ch, tw, th))
    scale = tw // cw
    if scale & (scale - 1):
        raise ValueError("paletted replication needs a power-of-two scale, "
                         "got %d" % scale)
    while (cw, ch) != (tw, th):
        data = upscale2(data, cw, ch, src["fmt"])
        cw, ch = cw * 2, ch * 2
    exp = rs_expected_length(src["fmt"], tw, th)
    if len(data) != exp:
        raise ValueError("replication gave %d bytes, want %d" % (len(data), exp))
    return build_rs(src["id"], src["dcat"], tw, th, src["fmt"], data,
                    palette=src["palette"]), scale


def encode_paletted(rgba, fmt, palette_argb, allowed=None,
                    allow_requantize=False):
    """RGBA -> nearest palette index, keeping the record INDEX16/P8 against
    its own DefaultPaletteId.  Never DXT: converting a palettized record
    freezes its colours and breaks ClothingTable subpalette recolours
    (pallib.py RECOLOR SAFETY).

    !! GUARDED (2026-08-21): requantizing an EXISTING paletted record is what
    corrupted the r9/r10 highres (ClipMap transparency holes + distinct-index
    collapse -> broken recolours).  The upscale lane must use
    upscale_paletted_nearest instead; this encoder refuses to run unless the
    caller passes allow_requantize=True (legitimate only for NEW art that has
    no source index grid, never for upscales of retail records).

    `allowed`: optional iterable of palette indices the search may return.
    Retail records use a small subset of their 2048-colour palette (median
    422), and indices <8 are clipmap-transparency sentinels -- an
    unconstrained nearest search hands upscaled pixels to unused entries and
    can punch NEW transparent holes into clipmap surfaces (the 2026-08-18
    bake-prep census: 7/10 sampled sentinel-free records gained sentinel
    pixels).  Restricting to the SOURCE record's own used set makes
    'no new palette entries, no new holes' an invariant."""
    if not allow_requantize:
        raise ValueError(
            "encode_paletted: refusing to re-quantize a paletted record -- "
            "RGBA-resample+requantize corrupts index semantics (transparency "
            "sentinels, recolour rows).  Upscales must use "
            "upscale_paletted_nearest; pass allow_requantize=True only for "
            "new art with no source index grid.")
    import numpy as np
    pal = np.zeros((len(palette_argb), 4), np.int16)
    a = np.asarray(palette_argb, np.uint32)
    pal[:, 0] = (a >> 16) & 0xFF
    pal[:, 1] = (a >> 8) & 0xFF
    pal[:, 2] = a & 0xFF
    pal[:, 3] = (a >> 24) & 0xFF
    remap = None
    if allowed is not None:
        remap = np.unique(np.asarray(list(allowed), np.int64))
        if remap.size == 0 or remap.min() < 0 or remap.max() >= len(pal):
            raise ValueError("allowed index set empty or out of palette range")
        pal = pal[remap]
    px = rgba.reshape(-1, 4).astype(np.int16)
    # chunked nearest-neighbour so a 2048^2 x 2048-colour palette never
    # materialises a 8-billion-element distance matrix
    out = np.empty(px.shape[0], np.int64)
    step = max(1, (1 << 22) // max(1, len(pal)))
    for i in range(0, px.shape[0], step):
        d = px[i:i + step, None, :] - pal[None, :, :]
        out[i:i + step] = (d.astype(np.int32) ** 2).sum(2).argmin(1)
    if remap is not None:
        out = remap[out]
    if fmt == PF_INDEX16:
        return out.astype("<u2").tobytes()
    if out.max(initial=0) > 255:
        raise ValueError("P8 record needs index %d > 255" % out.max())
    return out.astype(np.uint8).tobytes()


def encode_dxt(rgba, fmt):
    """Scaffolding DXT1/DXT5 encoder (per-block bounding-box range fit).

    Good enough to make the PNG route runnable end to end; SHIPPING bakes
    should go through WorldBuilder.Terminal `render-surface-import`, which is
    what the other lanes use and which shares the client's encoder settings.
    """
    import numpy as np
    if fmt not in (PF_DXT1, PF_DXT5):
        raise ValueError("no DXT encoder for PixelFormat %d" % fmt)
    h, w = rgba.shape[:2]
    bw, bh = max(1, (w + 3) // 4), max(1, (h + 3) // 4)
    pad = np.zeros((bh * 4, bw * 4, 4), np.uint8)
    pad[:h, :w] = rgba
    blocks = pad.reshape(bh, 4, bw, 4, 4).transpose(0, 2, 1, 3, 4).reshape(-1, 16, 4)
    n = blocks.shape[0]
    rgb = blocks[:, :, :3].astype(np.int32)
    alpha = blocks[:, :, 3]

    lo = rgb.min(1)
    hi = rgb.max(1)

    def to565(c):
        return (((c[:, 0] >> 3) << 11) | ((c[:, 1] >> 2) << 5) | (c[:, 2] >> 3)).astype(np.uint16)

    def from565(v):
        v = v.astype(np.int32)
        r = ((v >> 11) & 0x1F) * 255 // 31
        g = ((v >> 5) & 0x3F) * 255 // 63
        b = (v & 0x1F) * 255 // 31
        return np.stack([r, g, b], 1)

    c0, c1 = to565(hi), to565(lo)
    punch = np.zeros(n, bool)
    if fmt == PF_DXT1:
        punch = (alpha < 128).any(1)
        # 1-bit-alpha mode requires c0 <= c1; opaque mode requires c0 > c1
        swap = punch & (c0 > c1)
        c0[swap], c1[swap] = c1[swap], c0[swap]
        eq = (~punch) & (c0 <= c1)
        c1[eq] = np.where(c0[eq] > 0, c0[eq] - 1, c0[eq])
        bump = eq & (c0 == 0)
        c0[bump] = 1
    e0, e1 = from565(c0), from565(c1)
    pal = np.zeros((n, 4, 3), np.int32)
    pal[:, 0], pal[:, 1] = e0, e1
    two = punch if fmt == PF_DXT1 else np.zeros(n, bool)
    pal[:, 2] = np.where(two[:, None], (e0 + e1) // 2, (2 * e0 + e1) // 3)
    pal[:, 3] = np.where(two[:, None], 0, (e0 + 2 * e1) // 3)
    d = ((rgb[:, :, None, :] - pal[:, None, :, :]) ** 2).sum(3)
    if fmt == PF_DXT1:
        d[two, :, 3] = 1 << 30                      # index 3 == transparent
    idx = d.argmin(2).astype(np.uint16)
    if fmt == PF_DXT1:
        idx[punch] = np.where(alpha[punch] < 128, 3, idx[punch])
    cidx = SH._pack_bits(idx, 2, 4)
    colour = np.concatenate([c0.astype("<u2").view(np.uint8).reshape(n, 2),
                             c1.astype("<u2").view(np.uint8).reshape(n, 2),
                             cidx], 1)
    if fmt == PF_DXT1:
        out = colour
    else:
        a0 = alpha.max(1).astype(np.int32)
        a1 = alpha.min(1).astype(np.int32)
        span = np.maximum(a0 - a1, 1)
        t = np.clip(np.round((alpha.astype(np.int32) - a1[:, None]) * 7
                             / span[:, None]), 0, 7).astype(np.uint16)
        # DXT5 8-alpha ordering: 0->a0, 1->a1, 2..7 -> lerp(a0,a1, k/7)
        aidx = np.where(t == 7, 0, np.where(t == 0, 1, 8 - t))
        ablk = np.concatenate([a0.astype(np.uint8).reshape(n, 1),
                               a1.astype(np.uint8).reshape(n, 1),
                               SH._pack_bits(aidx.astype(np.uint16), 3, 6)], 1)
        out = np.concatenate([ablk, colour], 1)
    return out.reshape(bh, bw, -1).tobytes()


# ----------------------------------------------------------------- lane run
def _find_png(baked_dir, hid):
    if not baked_dir:
        return None
    for name in ("%08X.png" % hid, "0x%08X.png" % hid, "%08x.png" % hid,
                 "%d.png" % hid):
        p = os.path.join(baked_dir, name)
        if os.path.exists(p):
            return p
    return None


def cmd_run(args):
    out = guard_write(args.out)
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    rows, stats = plan_lane(args.highres, args.audit,
                            args.portal if os.path.exists(args.portal) else None)
    by_id = {int(r["id"], 16): r for r in rows}
    hr = SH.open_dat(args.highres)
    hr_dir = _raw_directory(args.highres)
    portal = SH.open_dat(args.portal) if os.path.exists(args.portal) else None

    lane_ids = set(by_id)
    if args.lane_only:
        emit = sorted(lane_ids & set(hr.files))
    else:
        emit = sorted(i for i in hr.files if i != ITERATION_ID)

    w = DatWriter(out, dataset=hr.dataset, subset=hr.subset,
                  block_size=hr.blocksize)
    itr = hr.get(ITERATION_ID)
    if itr is not None and not args.lane_only:
        fl, _o, _s, dt, it = hr_dir[ITERATION_ID]
        w.add(ITERATION_ID, itr, flags=fl, date=dt, iteration=it)

    report, counts = [], dict(written=0, upscaled_png=0, upscaled_nearest=0,
                              passthrough=0, carried=0, skipped_no_source=0,
                              failed=0)
    for hid in emit:
        raw = hr.get(hid)
        row = by_id.get(hid)
        fl, _o, _s, dt, it = hr_dir.get(hid, (0x20000, 0, 0, 0, 1))
        if row is None:
            # not a lane id -> carry the source record through byte-for-byte
            w.add(hid, raw, flags=fl, date=dt, iteration=it)
            counts["carried"] += 1
            counts["written"] += 1
            continue
        src = parse_rs(raw)
        try:
            if row["route"] == ROUTE_PASSTHROUGH:
                body, how = raw, "passthrough-retail-bytes"
                counts["passthrough"] += 1
            elif src["fmt"] in PALETTED:
                # 4.H1 RULE: paletted (INDEX16/P8) records upscale by
                # per-index nearest replication ONLY -- a baked PNG for the
                # id is deliberately IGNORED (see upscale_paletted_nearest;
                # the PNG requantize path is what broke ClipMap transparency
                # and clothing recolours in r9/r10).
                tw, th = (int(x) for x in row["target_dim"].split("x"))
                body, scale = upscale_paletted_nearest(src, tw, th)
                how = "paletted-index-replication-%dx" % scale
                if _find_png(args.baked, hid):
                    how += " (baked png ignored: paletted)"
                counts["paletted_nearest"] = counts.get("paletted_nearest", 0) + 1
            else:
                tw, th = (int(x) for x in row["target_dim"].split("x"))
                png = _find_png(args.baked, hid)
                if png:
                    body = _encode_from_png(png, src, tw, th, portal)
                    how = "png:" + os.path.basename(png)
                    counts["upscaled_png"] += 1
                elif args.synth_passthrough:
                    scale = row.get("scale")
                    if not scale or scale & (scale - 1):
                        raise ValueError("nearest route needs a power-of-two "
                                         "scale, plan says %r (%s -> %s)"
                                         % (scale, row["src_dim"], row["target_dim"]))
                    data, cw, ch = src["data"], src["w"], src["h"]
                    while (cw, ch) != (tw, th):
                        data = upscale2(data, cw, ch, src["fmt"])
                        cw, ch = cw * 2, ch * 2
                    exp = rs_expected_length(src["fmt"], tw, th)
                    if len(data) != exp:
                        raise ValueError("nearest %dx gave %d bytes, want %d"
                                         % (scale, len(data), exp))
                    body = build_rs(hid, src["dcat"], tw, th, src["fmt"], data,
                                    palette=src["palette"])
                    how = "nearest-%dx (SCAFFOLDING)" % scale
                    counts["upscaled_nearest"] += 1
                else:
                    counts["skipped_no_source"] += 1
                    report.append(dict(id=row["id"], route=row["route"],
                                       status="NO-UPSCALE-SOURCE"))
                    if args.carry_missing:
                        w.add(hid, raw, flags=fl, date=dt, iteration=it)
                        counts["written"] += 1
                    continue
        except Exception as exc:                              # noqa: BLE001
            counts["failed"] += 1
            report.append(dict(id=row["id"], route=row["route"],
                               status="FAILED", error=str(exc)))
            continue
        chk = parse_rs(body)
        report.append(dict(id=row["id"], route=row["route"], how=how,
                           src_fmt_name=row["fmt_name"],
                           fmt_name=PF_NAME.get(chk["fmt"], str(chk["fmt"])),
                           encoder=row["encoder"], scale=row.get("scale"),
                           src_dim=row["src_dim"],
                           out_dim="%dx%d" % (chk["w"], chk["h"]),
                           r7_dim=row["r7_dim"], bytes=len(body),
                           status="OK"))
        w.add(hid, body, flags=fl, date=dt, iteration=it)
        counts["written"] += 1
    info = w.close()

    summary = dict(
        tool="tools/dat-patch/highres_lane.py", source_highres=args.highres,
        out=out, lane_only=bool(args.lane_only), baked=args.baked,
        synth_passthrough=bool(args.synth_passthrough),
        plan=stats, counts=counts, records=info["records"],
        file_size=os.path.getsize(out), btree_root=info["root"])
    if args.manifest:
        mp = guard_write(args.manifest)
        with open(mp, "w") as fh:
            json.dump(dict(summary=summary, plan=rows, records=report), fh, indent=1)
        print("manifest -> %s" % mp)
    print(json.dumps(summary, indent=1))
    return 1 if counts["failed"] else 0


def _encode_from_png(png, src, tw, th, portal):
    rgba = _load_png(png)
    if (rgba.shape[1], rgba.shape[0]) != (tw, th):
        raise ValueError("%s is %dx%d, target is %dx%d"
                         % (os.path.basename(png), rgba.shape[1], rgba.shape[0], tw, th))
    fmt = src["fmt"]
    if fmt in PALETTED:
        # HARD GUARD (2026-08-21): the PNG->requantize path corrupted every
        # INDEX16 record it touched in r9/r10 (transparency-sentinel explosion
        # on ClipMaps, distinct-index collapse on recolour-live clothing).
        # Paletted records are routed to upscale_paletted_nearest in cmd_run
        # and must NEVER reach this encoder.
        raise ValueError(
            "paletted record 0x%08X reached the PNG requantize path -- "
            "forbidden; use upscale_paletted_nearest (per-index replication)"
            % src["id"])
    if fmt in DXT_BLOCK_BYTES:
        data = encode_dxt(rgba, fmt)
    else:
        data = encode_raw(rgba, fmt)
    exp = rs_expected_length(fmt, tw, th)
    if len(data) != exp:
        raise ValueError("encoder gave %d bytes, want %d" % (len(data), exp))
    return build_rs(src["id"], src["dcat"], tw, th, fmt, data, palette=src["palette"])


# ------------------------------------------------------------------- plan
def cmd_plan(args):
    rows, stats = plan_lane(args.highres, args.audit,
                            args.portal if os.path.exists(args.portal) else None)
    hist = {}
    for r in rows:
        k = "%s %s -> %s" % (r.get("fmt_name"), r.get("src_dim"), r.get("target_dim"))
        hist[k] = hist.get(k, 0) + 1
    doc = dict(highres=args.highres, stats=stats,
               transitions=dict(sorted(hist.items(), key=lambda kv: -kv[1])[:25]),
               rows=rows)
    if args.out:
        with open(guard_write(args.out), "w") as fh:
            json.dump(doc, fh, indent=1)
        print("plan -> %s" % args.out)
    print(json.dumps(dict(stats=stats, top_transitions=doc["transitions"]), indent=1))
    return 0


# ----------------------------------------------------------------- verify
def cmd_verify(args):
    d = SH.open_dat(args.dat)
    size = os.path.getsize(args.dat)
    errs = []
    print("== header ==")
    print("  filetype=0x%08X blocksize=%d fileSize=%d (actual %d) dataset=%d "
          "subset=0x%08X btree=0x%X records=%d"
          % (d.filetype, d.blocksize, d.filesize, size, d.dataset, d.subset,
             d.btree, len(d.files)))
    if d.filesize != size:
        errs.append("header fileSize %d != actual %d" % (d.filesize, size))
    if d.subset != SH.SUBSET_HIFI:
        errs.append("subset 0x%08X != 'HiFi'" % d.subset)

    src = SH.open_dat(args.highres) if args.highres else None
    man = None
    if args.manifest:
        with open(args.manifest) as fh:
            man = json.load(fh)

    print("== re-read every written record ==")
    fmts, dims, nbad = {}, {}, 0
    for oid in sorted(d.files):
        if oid == ITERATION_ID:
            continue
        try:
            r = parse_rs(d.get(oid))
        except ValueError as e:
            errs.append(str(e))
            nbad += 1
            continue
        if r["id"] != oid:
            errs.append("0x%08X id echo 0x%08X" % (oid, r["id"]))
        exp = rs_expected_length(r["fmt"], r["w"], r["h"])
        if exp != r["dlen"]:
            errs.append("0x%08X len %d != %d" % (oid, r["dlen"], exp))
        if r["tail"] != 0:
            errs.append("0x%08X %d trailing bytes" % (oid, r["tail"]))
        if (r["fmt"] in PALETTED) != (r["palette"] is not None):
            errs.append("0x%08X palette trailer/format mismatch" % oid)
        n = PF_NAME.get(r["fmt"], str(r["fmt"]))
        fmts[n] = fmts.get(n, 0) + 1
        dims["%dx%d" % (r["w"], r["h"])] = dims.get("%dx%d" % (r["w"], r["h"]), 0) + 1
    print("  %d records parsed, %d unparseable" % (len(d.files) - 1, nbad))
    print("  formats:", dict(sorted(fmts.items(), key=lambda kv: -kv[1])))

    if man:
        print("== per-record expectations from the run manifest ==")
        ok = 0
        for rec in man["records"]:
            if rec["status"] != "OK":
                continue
            oid = int(rec["id"], 16)
            if oid not in d.files:
                errs.append("%s in manifest but not in dat" % rec["id"])
                continue
            r = parse_rs(d.get(oid))
            got = "%dx%d" % (r["w"], r["h"])
            if got != rec["out_dim"]:
                errs.append("%s dim %s != manifest %s" % (rec["id"], got, rec["out_dim"]))
                continue
            if PF_NAME.get(r["fmt"], str(r["fmt"])) != rec["fmt_name"]:
                errs.append("%s format %s != manifest %s"
                            % (rec["id"], PF_NAME.get(r["fmt"]), rec["fmt_name"]))
                continue
            ok += 1
        print("  %d/%d manifest OK-records confirmed by re-read"
              % (ok, sum(1 for r in man["records"] if r["status"] == "OK")))

        print("== invariants ==")
        lane = [r for r in man["records"] if r["status"] == "OK"]
        up = [r for r in lane if r["route"] == ROUTE_UPSCALE]
        pt = [r for r in lane if r["route"] == ROUTE_PASSTHROUGH]
        scales = {}
        for r in up:
            scales[str(r.get("scale"))] = scales.get(str(r.get("scale")), 0) + 1
        regress = [r for r in lane if r["r7_dim"] and _dim_lt(r["out_dim"], r["r7_dim"])]
        shrink = [r for r in lane if _dim_lt(r["out_dim"], r["src_dim"])]
        print("  UPSCALE: %d, linear scale histogram: %s" % (len(up), scales))
        print("  NO-REGRESSION-VS-r7: %d/%d records >= the r7 output dim"
              % (len(lane) - len(regress), len(lane)))
        if regress:
            errs.append("%d records ship SMALLER than r7 already does: %s"
                        % (len(regress), [(r["id"], r["out_dim"], r["r7_dim"])
                                          for r in regress[:5]]))
        if shrink:
            errs.append("%d records ship smaller than their highres source: %s"
                        % (len(shrink), [r["id"] for r in shrink[:5]]))
        pal_dxt = [r for r in lane if r.get("encoder") == "palette"
                   and r["fmt_name"] not in ("INDEX16", "P8")]
        print("  PASSTHROUGH: %d" % len(pt))
        if src:
            nver = 0
            for r in pt:
                oid = int(r["id"], 16)
                if d.get(oid) != src.get(oid):
                    errs.append("%s passthrough bytes differ from the source dat" % r["id"])
                else:
                    nver += 1
            print("  passthrough byte-identity vs source dat: %d/%d" % (nver, len(pt)))
        npal = sum(1 for r in lane if r.get("encoder") == "palette")
        print("  palette-route records: %d, still INDEX16/P8 on output: %d"
              % (npal, npal - len(pal_dxt)))
        if pal_dxt:
            errs.append("%d palette records were re-encoded away from INDEX16/P8: %s"
                        % (len(pal_dxt), [r["id"] for r in pal_dxt[:5]]))
        drift = [r for r in lane if r.get("src_fmt_name") and
                 r["fmt_name"] != r["src_fmt_name"]]
        if drift:
            errs.append("%d records changed pixel format: %s"
                        % (len(drift), [(r["id"], r["src_fmt_name"], r["fmt_name"])
                                        for r in drift[:5]]))

    print("== VERDICT: %s ==" % ("FAIL" if errs else "OK"))
    for e in errs[:20]:
        print("  ERR " + e)
    return 1 if errs else 0


def _is_2x(a, b):
    aw, ah = (int(x) for x in a.split("x"))
    bw, bh = (int(x) for x in b.split("x"))
    return bw == aw * 2 and bh == ah * 2


def _dim_lt(a, b):
    """True if a is smaller than b in either dimension."""
    aw, ah = (int(x) for x in a.split("x"))
    bw, bh = (int(x) for x in b.split("x"))
    return aw < bw or ah < bh


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("plan")
    p.add_argument("--highres", required=True)
    p.add_argument("--audit", default=DEFAULT_AUDIT)
    p.add_argument("--portal", default=DEFAULT_PORTAL)
    p.add_argument("--out", default=None)
    p.set_defaults(fn=cmd_plan)

    r = sub.add_parser("run")
    r.add_argument("--highres", required=True)
    r.add_argument("--out", required=True)
    r.add_argument("--audit", default=DEFAULT_AUDIT)
    r.add_argument("--portal", default=DEFAULT_PORTAL)
    r.add_argument("--baked", default=None, help="dir of pre-upscaled <ID>.png")
    r.add_argument("--synth-passthrough", action="store_true",
                   help="no GPU: deterministic in-format 2x nearest (scaffolding)")
    r.add_argument("--lane-only", action="store_true",
                   help="emit only the 1,342 lane records (default: full dat)")
    r.add_argument("--carry-missing", action="store_true",
                   help="carry source bytes for lane ids with no upscale source")
    r.add_argument("--manifest", default=None)
    r.set_defaults(fn=cmd_run)

    v = sub.add_parser("verify")
    v.add_argument("--dat", required=True)
    v.add_argument("--manifest", default=None)
    v.add_argument("--highres", default=None, help="the source dat, for passthrough byte-identity")
    v.set_defaults(fn=cmd_verify)

    args = ap.parse_args()
    sys.exit(args.fn(args))


if __name__ == "__main__":
    main()
