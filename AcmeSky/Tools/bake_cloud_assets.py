#!/usr/bin/env python3
# bake_cloud_assets.py -- OFFLINE converter for the M2 cloud assets: wraps the takram
# three-clouds prebaked noise volumes + the local-weather map into the ASKYLUT1 .bin
# container AcmeSky's SkyLut loader consumes (32-byte header + raw texel data).
#
#   shape.bin         128^3 R8 (tiling low-freq cloud shape erosion)
#   shape_detail.bin   32^3 R8 (tiling hi-freq detail erosion)
#   stbn.bin          128x128x64 R8 (spatio-temporal blue noise; z = frame slice)
#   local_weather.png 512^2 RGBA8 -> RGBA8 with a FULL MIP CHAIN (box filter);
#                     header 'reserved' field = mip count (sampleWeather uses
#                     textureLod with a distance-driven mip level).
#
# Header (little-endian): magic "ASKYLUT1"(8), u32 width, height, depth,
# channels, bytesPerChannel, reserved(=mipCount for 2D, else 0).
#
# Usage: python3 bake_cloud_assets.py [SRC_DIR] [OUT_DIR]
#   SRC default: external/holtburger/apps/holtburger-web/assets/clouds
#   OUT default: AcmeSky/assets/sky/clouds

import os, struct, sys
import numpy as np
from PIL import Image

MAGIC = b"ASKYLUT1"


def write_bin(path, payload_bytes, w, h, d, ch, bpc, mips=0):
    with open(path, "wb") as f:
        f.write(MAGIC)
        f.write(struct.pack("<6I", w, h, d, ch, bpc, mips))
        f.write(payload_bytes)
    print(f"  wrote {path}  {w}x{h}x{d} ch={ch} bpc={bpc} mips={mips}  {len(payload_bytes)}B payload")


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.abspath(os.path.join(here, "..", ".."))
    src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        repo, "external", "holtburger", "apps", "holtburger-web", "assets", "clouds")
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(here, "..", "assets", "sky", "clouds")
    out = os.path.abspath(out)
    os.makedirs(out, exist_ok=True)
    print(f"src={src}\nout={out}")

    # --- raw R8 volumes: pass through verbatim ---
    for name, dims in (("shape.bin", (128, 128, 128)),
                       ("shape_detail.bin", (32, 32, 32)),
                       ("stbn.bin", (128, 128, 64))):
        raw = open(os.path.join(src, name), "rb").read()
        w, h, d = dims
        assert len(raw) == w * h * d, (name, len(raw))
        write_bin(os.path.join(out, name), raw, w, h, d, 1, 1)

    # --- local weather: RGBA8 + box-filtered mip chain ---
    img = Image.open(os.path.join(src, "local_weather.png")).convert("RGBA")
    assert img.size == (512, 512), img.size
    levels = []
    cur = np.asarray(img, dtype=np.uint8)
    levels.append(cur.tobytes())
    a = cur.astype(np.float32)
    size = 512
    while size > 1:
        size //= 2
        a = (a[0::2, 0::2] + a[0::2, 1::2] + a[1::2, 0::2] + a[1::2, 1::2]) * 0.25
        levels.append(a.astype(np.uint8).tobytes())
    payload = b"".join(levels)
    write_bin(os.path.join(out, "local_weather.bin"), payload, 512, 512, 1, 4, 1, mips=len(levels))
    print("done.")


if __name__ == "__main__":
    main()
