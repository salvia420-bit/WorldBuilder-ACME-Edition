#!/usr/bin/env python3
# bake_atmosphere_luts.py -- OFFLINE converter: Bruneton precomputed-scattering
# EXR LUTs  ->  raw RGBA16F half-float ".bin" with a 32-byte header, ready to be
# uploaded verbatim as a D3D11 Texture2D / Texture3D by the AcmeSky live sky
# compositor (Milestone 1). Runtime does NO EXR parsing.
#
# WHY a hand-rolled EXR reader: the build box has no OpenEXR / imageio / pip.
# These 3 LUTs are ZIP-compressed (compression code 3) scanline EXRs with four
# HALF channels (A,B,G,R). We decode with the stdlib zlib + numpy only.
#
# CORRECTNESS ANCHOR: the takram loader (@takram/three-atmosphere
# PrecomputedTexturesLoader) has a 'binary' path that reads a raw Uint16 (half)
# RGBA array straight into a three.js DataTexture / Data3DTexture with the SAME
# width/height/depth we use here. three's EXRLoader yields image.data as a flat
# top-to-bottom (EXR ymin first) RGBA half array; Data3DTexture treats that flat
# array as z-major ( index = ((z*H)+y)*W + x ). We therefore emit the decoded
# EXR pixels in native scanline order (ymin first), channel order R,G,B,A --
# byte-identical to what holtburger-web samples at runtime.
#
#   transmittance.exr  256 x 64          -> 2D   R16G16B16A16_FLOAT
#   scattering.exr     256 x 4096        -> 3D   256 x 128 x 32  (z-major)
#   irradiance.exr     64  x 16          -> 2D
#
# Usage:  python3 bake_atmosphere_luts.py [SRC_DIR] [OUT_DIR]
#   SRC_DIR default: external/holtburger/.../scene3d/assets/atmosphere
#   OUT_DIR default: AcmeSky/assets/sky/atmosphere

import os, sys, struct, zlib
import numpy as np

# ---- header emitted in front of the raw RGBA16F payload (32 bytes) ----
# magic[8]="ASKYLUT1", u32 width, u32 height, u32 depth (1 for 2D),
# u32 channels (4), u32 bytesPerChannel (2 = half), u32 reserved(0)
MAGIC = b"ASKYLUT1"


def read_exr_rgba_half(path):
    """Decode a ZIP-compressed HALF RGBA scanline EXR into an (H, W, 4) uint16
    array in R,G,B,A order, native scanline order (row 0 = EXR ymin)."""
    with open(path, "rb") as f:
        data = f.read()
    if data[:4] != b"\x76\x2f\x31\x01":
        raise ValueError(f"{path}: not an EXR (bad magic)")
    pos = 8  # skip magic(4) + version(4)

    attrs = {}
    while True:
        end = data.index(b"\x00", pos); name = data[pos:end].decode(); pos = end + 1
        if name == "":
            break
        end = data.index(b"\x00", pos); atype = data[pos:end].decode(); pos = end + 1
        size = struct.unpack("<I", data[pos:pos + 4])[0]; pos += 4
        attrs[name] = data[pos:pos + size]; pos += size
    header_end = pos

    # channels (name, pixelType) in file order
    cv = attrs["channels"]; p = 0; channels = []
    while cv[p] != 0:
        e = cv.index(b"\x00", p); cn = cv[p:e].decode(); p = e + 1
        ptype = struct.unpack("<i", cv[p:p + 4])[0]; p += 16  # ptype,pLinear+2pad,xSamp,ySamp
        channels.append((cn, ptype))
    for cn, pt in channels:
        if pt != 1:
            raise ValueError(f"{path}: channel {cn} is not HALF (ptype={pt})")

    comp = attrs["compression"][0]
    if comp != 3:
        raise ValueError(f"{path}: compression {comp} != ZIP(3)")

    xmin, ymin, xmax, ymax = struct.unpack("<4i", attrs["dataWindow"])
    W = xmax - xmin + 1; H = ymax - ymin + 1
    line_order = attrs.get("lineOrder", b"\x00\x00\x00\x00")[0]  # 0=INCREASING_Y

    n_ch = len(channels)
    bytes_per_sample = 2
    row_bytes = W * bytes_per_sample * n_ch
    lines_per_block = 16  # ZIP
    n_blocks = (H + lines_per_block - 1) // lines_per_block

    # offset table: one uint64 per block, right after the header
    offsets = struct.unpack(f"<{n_blocks}Q", data[header_end:header_end + 8 * n_blocks])

    # channel order within a scanline == file (alphabetical) order: A,B,G,R
    ch_names = [c[0] for c in channels]
    out = np.zeros((H, W, n_ch), dtype=np.uint16)  # ordered by ch_names
    for off in offsets:
        y0 = struct.unpack("<i", data[off:off + 4])[0]
        dsize = struct.unpack("<i", data[off + 4:off + 8])[0]
        comp_bytes = data[off + 8:off + 8 + dsize]
        n_lines = min(lines_per_block, H - (y0 - ymin))
        raw_size = n_lines * row_bytes

        raw = zlib.decompress(comp_bytes)
        if len(raw) != raw_size:
            raise ValueError(f"{path}: block size {len(raw)} != {raw_size}")
        buf = bytearray(raw)
        # EXR ZIP reconstruction: predictor (delta) then interleave.
        b = np.frombuffer(buf, dtype=np.uint8).astype(np.int32)
        for i in range(1, len(b)):
            b[i] = (b[i - 1] + b[i] - 128) & 0xFF
        b = b.astype(np.uint8)
        half = (raw_size + 1) // 2
        recon = np.empty(raw_size, dtype=np.uint8)
        recon[0::2] = b[:half][: (raw_size + 1) // 2]
        recon[1::2] = b[half:half + raw_size // 2]

        # recon holds n_lines scanlines; each scanline = concatenated channels.
        recon16 = recon.view(np.uint16).reshape(n_lines, n_ch * W)
        for ci in range(n_ch):
            chan = recon16[:, ci * W:(ci + 1) * W]
            ry = (y0 - ymin)
            out[ry:ry + n_lines, :, ci] = chan

    if line_order == 1:  # DECREASING_Y
        out = out[::-1]

    # reorder ch_names -> R,G,B,A
    idx = {n: i for i, n in enumerate(ch_names)}
    rgba = np.stack([
        out[:, :, idx["R"]],
        out[:, :, idx["G"]],
        out[:, :, idx["B"]],
        out[:, :, idx["A"]],
    ], axis=-1)
    return rgba, W, H


def half_to_float(u16):
    return np.frombuffer(u16.tobytes(), dtype=np.float16).astype(np.float32)


def write_bin(out_path, rgba, width, height, depth):
    with open(out_path, "wb") as f:
        f.write(MAGIC)
        f.write(struct.pack("<6I", width, height, depth, 4, 2, 0))
        f.write(rgba.astype("<u2").tobytes())
    n = rgba.size
    fl = half_to_float(rgba.reshape(-1).copy())
    print(f"  wrote {out_path}  {width}x{height}x{depth}  "
          f"payload={n*2} bytes  range=[{fl.min():.4g},{fl.max():.4g}]")


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.abspath(os.path.join(here, "..", ".."))
    src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        repo, "external", "holtburger", "apps", "holtburger-web",
        "scene3d", "assets", "atmosphere")
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(
        here, "..", "assets", "sky", "atmosphere")
    out = os.path.abspath(out)
    os.makedirs(out, exist_ok=True)
    print(f"src={src}\nout={out}")

    # transmittance 256x64 -> 2D
    rgba, W, H = read_exr_rgba_half(os.path.join(src, "transmittance.exr"))
    assert (W, H) == (256, 64), (W, H)
    write_bin(os.path.join(out, "transmittance.bin"), rgba, 256, 64, 1)

    # irradiance 64x16 -> 2D
    rgba, W, H = read_exr_rgba_half(os.path.join(src, "irradiance.exr"))
    assert (W, H) == (64, 16), (W, H)
    write_bin(os.path.join(out, "irradiance.bin"), rgba, 64, 16, 1)

    # scattering 256x4096 -> 3D 256x128x32 (z-major: EXR row Y = z*128 + y)
    rgba, W, H = read_exr_rgba_half(os.path.join(src, "scattering.exr"))
    assert (W, H) == (256, 4096), (W, H)
    write_bin(os.path.join(out, "scattering.bin"), rgba, 256, 128, 32)

    print("done.")


if __name__ == "__main__":
    main()
