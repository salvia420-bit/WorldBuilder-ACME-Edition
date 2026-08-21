#!/usr/bin/env python3
"""fill_import.py -- Phase-4 coverage fill: bake the upscaled corpus into the
highres dat (2026-08-20).

This is the COVERAGE lane, not the relief lane: it ships upscaled albedo for
retail records nobody has touched yet, with no emboss/AO (legibility.bake_texture
with h=None = "anchor only"), because those records have no surface metadata,
material class or seam height behind them. What it DOES carry is the same retail
exposure/colour anchor the shipped lanes use, so a filled wall and an r7.1 wall
sit at the same exposure instead of one looking hot next to the other.

Routing (decided in TASKLIST-2026-08-20-phase4-fill.md):
  * INDEX16 / P8 -> stay palettized, 2x, indices re-solved against the record's
    OWN palette and its OWN used subset. Converting them to DXT would freeze the
    colours and break every ClothingTable subpalette recolour (pallib.py RECOLOR
    SAFETY), which is most of the creature/clothing corpus.
  * everything else -> DXT1 (opaque) / DXT5 (alpha) at 4x, encoded by
    WorldBuilder.Terminal (BCnEncoder, the client-grade path).
  * terrain-protected RenderSurfaces are REFUSED (they must stay 512^2
    A8R8G8B8 or ImgTex::MergeTexture reads out of bounds -> VeryHigh crash).

Stages:
  bake     upscale + retail anchor + alpha transplant -> baked/<id>.png,
           and for the palette route -> idx/<id>.bin (raw record bytes)
  import   WBT render-surface-import (allowCreate) for the DXT route
  (the palette route's records are inserted by DatRecordInsert)
"""
import argparse, json, os, struct, subprocess, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

PF_P8, PF_INDEX16 = 41, 101
PF_NAMES = {20: 'R8G8B8', 21: 'A8R8G8B8', 28: 'A8', 41: 'P8', 101: 'INDEX16',
            827611204: 'DXT1', 861165636: 'DXT3', 894720068: 'DXT5'}


def rs_header(dat, oid):
    d = dat.get(oid)
    if d is None or len(d) < 24:
        return None
    _id, _unk, w, h, fmt, length = struct.unpack_from('<6I', d, 0)
    return dict(w=w, h=h, fmt=fmt, length=length, data=d)


def default_palette(dat, oid):
    """RenderSurface trailing DefaultPaletteId (palettized records only)."""
    h = rs_header(dat, oid)
    if h is None or h['fmt'] not in (PF_P8, PF_INDEX16):
        return None
    off = 24 + h['length']
    if off + 4 > len(h['data']):
        return None
    return struct.unpack_from('<I', h['data'], off)[0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ids', required=True, help='file of 0x06xxxxxx ids to fill')
    ap.add_argument('--upscales', required=True, help='dir of <id>.png Remacri 4x output')
    ap.add_argument('--retail-dir', default='/mnt/wbterminal2/tex-reexport-2026-07-30')
    ap.add_argument('--portal', default=os.path.expanduser('~/ac_base_dats/client_portal.dat'))
    ap.add_argument('--out-root', required=True)
    ap.add_argument('--anchor', default='rgb+sat')
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--jobs', type=int, default=3)
    ap.add_argument('--max-side', type=int, default=2048,
                    help='cap the DXT route (WBT refuses 4096-side inputs: '
                         '"Specified argument was out of the range of valid values")')
    ap.add_argument('--shard', type=int, default=0)
    ap.add_argument('--shard-count', type=int, default=1)
    a = ap.parse_args()

    import numpy as np
    from PIL import Image
    import datlib, legibility, pallib

    protected = set()
    pp = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'terrain_protected_rs.txt')
    if os.path.exists(pp):
        protected = {int(l, 16) for l in open(pp) if l.strip() and not l.startswith('#')}

    baked = os.path.join(a.out_root, 'baked'); os.makedirs(baked, exist_ok=True)
    idxd = os.path.join(a.out_root, 'idx'); os.makedirs(idxd, exist_ok=True)
    portal = datlib.Dat(a.portal)
    G = legibility.GAINSETS['mid']

    ids = [int(l.strip(), 16) for l in open(a.ids) if l.strip()]
    if a.limit:
        ids = ids[:a.limit]
    if a.shard_count > 1:                     # trivial sharding: N processes, N
        ids = ids[a.shard::a.shard_count]     # out-roots, manifests merged by
                                              # build_r9_highres.sh
    imports, inserts = [], []
    stats = dict(requested=len(ids), dxt=0, palette=0, skipped_protected=0,
                 skipped_no_upscale=0, skipped_no_retail=0, skipped_dims=0, failed=0)
    t0 = time.time()
    for n, oid in enumerate(ids):
        hexid = '0x%08X' % oid
        if oid in protected:
            stats['skipped_protected'] += 1
            continue
        # RESUME: a finished record leaves either a baked PNG or an idx bin.
        # (The bake is memory-hungry — ~1 GB RSS per worker on 512-source
        # records — so being able to kill a shard and restart it is what keeps
        # the laptop off its swap cliff.)
        bp = os.path.join(baked, hexid + '.png')
        if os.path.exists(bp):
            # the DXT choice is a property of the baked alpha, so re-derive it
            # rather than guessing: a new record has no format to preserve.
            al = np.asarray(Image.open(bp).convert('RGBA'), np.uint8)[..., 3]
            stats['dxt'] += 1
            imports.append(dict(idHex=hexid, pngPath=bp,
                                format='DXT5' if (al < 250).mean() > 0.001 else 'DXT1',
                                allowResize=True))
            continue
        hdr0 = rs_header(portal, oid)
        if hdr0 is not None and hdr0['fmt'] in (PF_P8, PF_INDEX16):
            # PALETTE ROUTE (rewritten 2026-08-21, the INDEX16 regression):
            # per-index nearest 2x replication of the PORTAL record's own
            # index grid -- NEVER an RGBA bake + re-quantize.  The old
            # LANCZOS-resize + nearest-palette solve corrupted every INDEX16
            # record it touched in r9/r10: ClipMap index-0 transparency
            # sentinels exploded (0x06006111: 3.1% -> 38.8% -> holes in the
            # Shallows Destroyer) and distinct-index counts collapsed
            # (0x060070B0: 163 -> 30 -> ClothingTable subpalette recolours
            # land on the wrong rows -> muddy town-NPC clothing).
            # Replication keeps the distinct-index set, sentinel fraction and
            # recolour semantics EXACTLY; it needs no upscale PNG at all.
            import synth_highres as SH
            pal_id = default_palette(portal, oid)
            if not pal_id:
                stats['failed'] += 1
                continue
            raw0 = hdr0['data'][24:24 + hdr0['length']]
            tw, th = hdr0['w'] * 2, hdr0['h'] * 2
            data = SH.upscale2(raw0, hdr0['w'], hdr0['h'], hdr0['fmt'])
            assert len(data) == tw * th * (2 if hdr0['fmt'] == PF_INDEX16 else 1), \
                'replication size mismatch for %s' % hexid
            rec = struct.pack('<6I', oid, 0, tw, th, hdr0['fmt'], len(data)) + data \
                + struct.pack('<I', pal_id)
            bp2 = os.path.join(idxd, hexid + '.bin')
            # RESUME-safe: an existing bin from a pre-fix (requantize) run is
            # detected by byte-compare and REBUILT, never reused.
            if not os.path.exists(bp2) or open(bp2, 'rb').read() != rec:
                open(bp2, 'wb').write(rec)
            inserts.append(dict(id=hexid, path=bp2))
            stats['palette'] += 1
            continue
        if os.path.exists(os.path.join(idxd, hexid + '.bin')):
            stats['palette'] += 1
            inserts.append(dict(id=hexid, path=os.path.join(idxd, hexid + '.bin')))
            continue
        up_p = os.path.join(a.upscales, hexid + '.png')
        ret_p = os.path.join(a.retail_dir, hexid + '.png')
        if not os.path.exists(up_p):
            stats['skipped_no_upscale'] += 1
            continue
        if not os.path.exists(ret_p):
            stats['skipped_no_retail'] += 1
            continue
        hdr = rs_header(portal, oid)
        if hdr is None:
            stats['failed'] += 1
            continue
        try:
            up = np.asarray(Image.open(up_p).convert('RGBA'), np.float32) / 255.0
            base = np.asarray(Image.open(ret_p).convert('RGBA'), np.float32) / 255.0
            out, _info = legibility.bake_texture(up, base, None, G['g_hi'], G['g_lo'],
                                                 G['a0'], color_anchor=a.anchor)
            rng = np.random.default_rng(oid & 0xFFFFFFFF)
            u8 = np.clip(out * 255.0 + rng.random(out.shape) - 0.5 + 0.5, 0, 255).astype(np.uint8)

            # alpha is retail truth, always transplanted (upscales come back opaque)
            base_a = (base[:, :, 3] * 255.0 + 0.5).astype(np.uint8)
            binary_src = bool(np.isin(base_a, (0, 255)).all())
            if base_a.shape != u8.shape[:2]:
                base_a = np.asarray(Image.fromarray(base_a).resize(
                    (u8.shape[1], u8.shape[0]), Image.LANCZOS), np.uint8)
            if binary_src:
                base_a = ((base_a > 100).astype(np.uint8)) * 255
            u8[:, :, 3] = base_a

            if hdr['fmt'] in (PF_P8, PF_INDEX16):
                # HARD GUARD (2026-08-21): a paletted record must never reach
                # the RGBA bake -- requantization is what corrupted the r9/r10
                # INDEX16 records (transparency-sentinel explosion + distinct-
                # index collapse).  Paletted records are handled above by
                # per-index replication, before any PNG is opened.
                raise RuntimeError('paletted record %s reached the RGBA bake '
                                   'path -- forbidden (use the replication '
                                   'route)' % hexid)
            else:
                # WBT's importer throws "argument out of range" on 4096-side
                # inputs (found on the r9 fill: the five 1024^2 sources whose 4x
                # bake is 4096^2 were the only DXT imports that failed). Cap the
                # long side; the client's own mip chain never reaches that size
                # anyway.
                if max(u8.shape[0], u8.shape[1]) > a.max_side:
                    sc = a.max_side / float(max(u8.shape[0], u8.shape[1]))
                    nw = max(4, int(round(u8.shape[1] * sc)) & ~3)
                    nh = max(4, int(round(u8.shape[0] * sc)) & ~3)
                    u8 = np.asarray(Image.fromarray(u8, 'RGBA').resize((nw, nh), Image.LANCZOS),
                                    np.uint8)
                H, W = u8.shape[:2]
                if W % 4 or H % 4:
                    stats['skipped_dims'] += 1
                    continue
                has_a = bool((u8[..., 3] < 250).mean() > 0.001)
                png = os.path.join(baked, hexid + '.png')
                # compress_level=1: these PNGs are read once by WBT and thrown
                # away; zlib level 6 on a 2048^2 RGBA frame costs more than the
                # bake itself.
                Image.fromarray(u8, 'RGBA').save(png, compress_level=1)
                imports.append(dict(idHex=hexid, pngPath=png,
                                    format='DXT5' if has_a else 'DXT1', allowResize=True))
                stats['dxt'] += 1
        except Exception as e:
            stats['failed'] += 1
            print('FAIL %s: %s' % (hexid, e), flush=True)
        if (n + 1) % 200 == 0:
            el = time.time() - t0
            print('%d/%d  %.1f min  (dxt %d, palette %d)'
                  % (n + 1, len(ids), el / 60, stats['dxt'], stats['palette']), flush=True)

    json.dump(dict(stats=stats, imports=imports, inserts=inserts),
              open(os.path.join(a.out_root, 'fill-manifest.json'), 'w'))
    print(json.dumps(stats, indent=1))
    print('manifest -> %s' % os.path.join(a.out_root, 'fill-manifest.json'))


def legibility_encode_paletted(rgba_u8, fmt, colors, used):
    """Nearest-palette index solve, identical in result to
    highres_lane.encode_paletted(allowed=used) but solved over the image's
    UNIQUE colours instead of every texel.

    !! DO NOT use this to upscale an EXISTING paletted record (the 2026-08-21
    r9/r10 regression): requantization breaks ClipMap transparency sentinels
    and ClothingTable recolour rows.  Upscales replicate indices instead (see
    the palette route in main / highres_lane.upscale_paletted_nearest).  Kept
    only for genuinely NEW paletted art with no source index grid.

    An upscaled palettized texture has far fewer distinct colours than pixels
    (a 1024^2 creature skin: tens of thousands, not a million), and the cost of
    this stage is pixels x palette-entries. Deduplicating first is what took the
    fill's bake from ~2.5 records/min/worker to something that finishes.
    The result is bit-identical: same distance metric, same tie-break (argmin
    takes the lowest index), same allowed-subset remap.
    """
    import numpy as np
    import highres_lane

    pal_all = np.zeros((len(colors), 4), np.int16)
    a = np.asarray(colors, np.uint32)
    pal_all[:, 0] = (a >> 16) & 0xFF
    pal_all[:, 1] = (a >> 8) & 0xFF
    pal_all[:, 2] = a & 0xFF
    pal_all[:, 3] = (a >> 24) & 0xFF
    remap = np.unique(np.asarray(list(used), np.int64))
    if remap.size == 0 or remap.min() < 0 or remap.max() >= len(pal_all):
        raise ValueError("allowed index set empty or out of palette range")
    pal = pal_all[remap]

    px = rgba_u8.reshape(-1, 4).astype(np.int16)
    uniq, inv = np.unique(px, axis=0, return_inverse=True)
    try:
        from scipy.spatial import cKDTree
    except ImportError:
        cKDTree = None
    if cKDTree is not None and uniq.shape[0] > 4096:
        # k-d tree over the palette: the brute-force solve is
        # pixels x palette-entries, which is ~40 s for a 1024^2 record against a
        # 600-colour used-set. Ties are resolved back to the LOWEST palette index
        # so the result stays bit-identical to the reference solve.
        tree = cKDTree(pal.astype(np.float32))
        d, idx = tree.query(uniq.astype(np.float32), k=2, workers=-1)
        out_u = idx[:, 0].astype(np.int64)
        tied = np.flatnonzero(d[:, 0] == d[:, 1])
        for i in range(0, tied.size, 65536):
            sel = tied[i:i + 65536]
            dd = uniq[sel][:, None, :] - pal[None, :, :]
            out_u[sel] = (dd.astype(np.int32) ** 2).sum(2).argmin(1)
    else:
        out_u = np.empty(uniq.shape[0], np.int64)
        step = max(1, (1 << 22) // max(1, len(pal)))
        for i in range(0, uniq.shape[0], step):
            d = uniq[i:i + step, None, :] - pal[None, :, :]
            out_u[i:i + step] = (d.astype(np.int32) ** 2).sum(2).argmin(1)
    out = remap[out_u][inv]
    if fmt == highres_lane.PF_INDEX16:
        return out.astype("<u2").tobytes()
    if out.max(initial=0) > 255:
        raise ValueError("P8 record needs index %d > 255" % out.max())
    return out.astype(np.uint8).tobytes()


if __name__ == '__main__':
    main()
