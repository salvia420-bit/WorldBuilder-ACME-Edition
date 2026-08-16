"""pallib.py -- palettized (P8/INDEX16) RenderSurface decode for the dat-patch
lanes, grounded in TWO independent references:

  * holtburger-dat file_type/texture.rs `to_rgba8_impl` (the client-parity
    renderer that draws the whole world from these records): palette id =
    override (Surface.OrigPaletteId, non-zero) else Texture.default_palette_id;
    P8 = 1-byte index, INDEX16 = 2-byte LE index; palette colors are ARGB u32;
    CLIPMAP surfaces (SurfaceType & 0x4) treat palette index < 8 as fully
    transparent (retail ImgTex::CopyIntoData, acclient.c:365958/365980).
  * DRW dats.xml `Palette` = [i32 numColors][u32 ARGB * n]  (256 or 2048).

RECOLOR SAFETY (the community's palette-swap trap): converting a palettized
record to RGB/DXT freezes its colors — any entity recolored via ClothingTable
subpalettes or weenie palette overrides would lose its tint.  Callers MUST
gate conversion on a census proving the texture is only reachable from
non-recolored statics (see the door lane: ClothingTable raw scan + ACE
weenie_properties_palette/texture_map checks).
"""
import struct

# Authoritative ids: ACE SurfacePixelFormat.cs (PFID_P8 = 41, PFID_INDEX16 =
# 101/0x65) — texture_lane.py's original {1, 65} table was a hex/decimal
# confusion of these.
PF_P8 = 41
PF_INDEX16 = 101
PALETTED = {PF_P8, PF_INDEX16}


def palette_colors(dat, pal_id):
    """Palette (0x04) record -> list of ARGB u32."""
    raw = dat.get(pal_id)
    if raw is None:
        raise KeyError("palette 0x%08X absent" % pal_id)
    oid, n = struct.unpack_from("<Ii", raw, 0)
    if n < 0 or 8 + 4 * n > len(raw):
        raise ValueError("palette 0x%08X bad count %d" % (pal_id, n))
    return list(struct.unpack_from("<%dI" % n, raw, 8))


def decode_paletted_rs(dat, rsid, clipmap=False, palette_override=0):
    """P8/INDEX16 RenderSurface -> (RGBA uint8 HxWx4, info dict).

    `palette_override` is Surface.OrigPaletteId (0 = none -> default palette).
    """
    import numpy as np
    raw = dat.get(rsid)
    oid, dcat, w, h, fmt, dlen = struct.unpack_from("<6I", raw, 0)
    if fmt not in PALETTED:
        raise ValueError("0x%08X format %d is not palettized" % (rsid, fmt))
    data = raw[24:24 + dlen]
    # trailing default_palette_id (present iff palettized -- holtburger
    # texture.rs / DRW both gate it on the format)
    (default_pal,) = struct.unpack_from("<I", raw, 24 + dlen)
    pal_id = palette_override or default_pal
    colors = palette_colors(dat, pal_id)
    pal = np.zeros((len(colors), 4), np.uint8)
    arr = np.array(colors, np.uint32)
    pal[:, 0] = (arr >> 16) & 0xFF   # R
    pal[:, 1] = (arr >> 8) & 0xFF    # G
    pal[:, 2] = arr & 0xFF           # B
    pal[:, 3] = (arr >> 24) & 0xFF   # A
    if fmt == PF_P8:
        idx = np.frombuffer(data[:w * h], np.uint8).astype(np.int32)
    else:
        idx = np.frombuffer(data[:w * h * 2], "<u2").astype(np.int32)
    if int(idx.max(initial=0)) >= len(colors):
        raise ValueError("0x%08X palette index %d >= %d (pal 0x%08X)"
                         % (rsid, int(idx.max()), len(colors), pal_id))
    out = pal[idx].reshape(h, w, 4).copy()
    if clipmap:
        # Alpha goes to 0, but the RGB underneath must be COLOUR-BLED, not
        # black: DXT block fitting and the client's box mips filter RGB
        # independently of alpha, so black backing rings every cutout edge
        # dark (audit finding).  Bleed the nearest opaque colour outward.
        m = (idx < 8).reshape(h, w)
        if m.any() and not m.all():
            from scipy import ndimage as ndi
            _, near = ndi.distance_transform_edt(m, return_indices=True)
            out[..., :3] = out[..., :3][tuple(near)]
        out[m, 3] = 0
    return out, dict(w=w, h=h, fmt=fmt, palette=pal_id,
                     default_palette=default_pal, clipmap=clipmap)
