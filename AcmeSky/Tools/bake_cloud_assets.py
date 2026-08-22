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

    # --- 2D RGBA maps: RGBA8 + box-filtered mip chain ---

    def seam_ratio(a):
        """Wrap-seam discontinuity vs interior gradient (1.0 = seamless)."""
        sx = np.abs(a[:, 0].astype(np.float32) - a[:, -1].astype(np.float32)).mean()
        sy = np.abs(a[0, :].astype(np.float32) - a[-1, :].astype(np.float32)).mean()
        ix = np.abs(np.diff(a.astype(np.float32), axis=1)).mean()
        iy = np.abs(np.diff(a.astype(np.float32), axis=0)).mean()
        return max(sx / max(ix, 1e-6), sy / max(iy, 1e-6))

    def tileize(a, band=96):
        """Make a wrap-tileable by mirror-pair cross-fading `band` px at each edge.

        For column pair (i, W-1-i): w = 0.5*(1 - i/(band-1)) -> at the very edge both
        columns become the same 50/50 mix (perfectly continuous across the wrap), fading
        to the original `band` px in. Same for rows. The weather tile is ~90 km in the sky
        (localWeatherRepeat=100), so a 32/512 band is a ~5.6 km coverage transition --
        invisible; the raw NASA/dereth crops instead put a hard cloud cutoff line across
        the sky where the wrap seam lands (takram's own map is procedurally tileable).
        """
        # Roll-and-blend: near the edges, cross-fade into a half-rolled copy of the image.
        # The rolled copy is wrap-continuous at the ORIGINAL's edges by construction (its own
        # seam lands in the image center, where the mask is zero), so the result tiles with no
        # mirror-symmetry artifacts -- edge content is simply borrowed from the image middle.
        f = a.astype(np.float32)
        h, w = f.shape[0], f.shape[1]
        r = np.roll(f, (h // 2, w // 2), axis=(0, 1))
        dx = np.minimum(np.arange(w), w - 1 - np.arange(w))
        dy = np.minimum(np.arange(h), h - 1 - np.arange(h))
        mx = np.clip(1.0 - dx / band, 0.0, 1.0)
        my = np.clip(1.0 - dy / band, 0.0, 1.0)
        m = np.maximum(mx[None, :], my[:, None])
        m = m * m * (3.0 - 2.0 * m)            # smoothstep falloff
        out = f * (1.0 - m[..., None]) + r * m[..., None]
        return np.clip(out + 0.5, 0, 255).astype(np.uint8)

    def bake_png(name_png, name_bin, expect=None):
        img = Image.open(os.path.join(src, name_png)).convert("RGBA")
        if expect: assert img.size == expect, (name_png, img.size)
        w, h = img.size
        levels = []
        cur = np.asarray(img, dtype=np.uint8)
        r = seam_ratio(cur)
        if r > 1.3:   # non-tileable source (NASA/dereth crops); takram's own map passes at ~0.9
            cur = tileize(cur)
            # NB: the post-tileize ratio can legitimately stay >1 — the wrap now lands on a REAL
            # adjacent-source-pixel edge (continuous by construction), which the crude mean-step
            # metric can't tell from a chop. The eye test is the 2x2 tiled preview.
            print(f"  {name_png}: wrap seam ratio {r:.1f} -> roll-blend tileized (band 96px, structurally continuous)")
            Image.fromarray(cur, "RGBA").save(os.path.join(out, name_png.replace(".png", ".tileable.png")))
        cur = np.ascontiguousarray(cur)
        levels.append(cur.tobytes())
        a = cur.astype(np.float32)
        size = min(w, h)
        while size > 1:
            size //= 2
            a = (a[0::2, 0::2] + a[0::2, 1::2] + a[1::2, 0::2] + a[1::2, 1::2]) * 0.25
            levels.append(a.astype(np.uint8).tobytes())
        write_bin(os.path.join(out, name_bin), b"".join(levels), w, h, 1, 4, 1, mips=len(levels))

    bake_png("local_weather.png", "local_weather.bin", (512, 512))
    bake_png("local_weather_nasa.png", "local_weather_nasa.bin", (512, 512))
    bake_png("local_weather_dereth.png", "local_weather_dereth.bin", (512, 512))
    bake_png("turbulence.png", "turbulence.bin", (128, 128))
    print("done.")


if __name__ == "__main__":
    main()
