#!/usr/bin/env python3
"""mkframes.py — compose s13 lane-R comparison frames from relief_v2_probe dumps.

Each row is the SAME texture under the SAME lighting rig; the only thing that
changes between tiles is which height field drove the normal:

  albedo      the decoded texture, untouched
  07-30       Some(Flush)  — the classifier margin-fallback's verdict, macro OFF
  pre-v2      correct class, content-BLIND noise micro (dents land at random)
  v2 shipped  correct class, content-FOLLOWING micro (today)

Raking light (low elevation) because relief reads as shading, not as colour.
Nearest-neighbour upscale so texel-scale dents survive the zoom.

Pure stdlib + PIL on purpose: this box is PEP-668 managed and numpy is not
installable without --break-system-packages, which is not worth it here.
"""
import json
import os
import sys
from math import sqrt

from PIL import Image, ImageDraw, ImageFont

SRC = "/home/wbterminal/fanout-s12/B/eyetest-B/relief"
OUT = "/home/wbterminal/fanout-s12/B/eyetest-B/drop"
os.makedirs(OUT, exist_ok=True)

TILE, PAD, HDR, LBL = 384, 14, 60, 30

# raking light: low elevation makes a 2-3% dip read as shading
_l = (-0.55, -0.42, 0.72)
_n = sqrt(sum(c * c for c in _l))
LX, LY, LZ = (c / _n for c in _l)


def font(sz, bold=True):
    for p in (("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else None),
              "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
        if p and os.path.exists(p):
            return ImageFont.truetype(p, sz)
    return ImageFont.load_default()


F_HDR, F_LBL = font(23), font(17)


def read(p):
    with open(p, "rb") as f:
        return f.read()


def shade(did, var, alb, w, h, neutral):
    """Lambert under the raking light, from the SHIPPED seam_normal_rgb8 output.
    `neutral` drops texture colour so relief is judged on its own."""
    p = f"{SRC}/{did}-n-{var}.raw"
    if not os.path.exists(p):
        return None
    nb = read(p)
    out = bytearray(w * h * 3)
    for i in range(w * h):
        j = i * 3
        nx = nb[j] / 127.5 - 1.0
        ny = nb[j + 1] / 127.5 - 1.0
        nz = nb[j + 2] / 127.5 - 1.0
        m = sqrt(nx * nx + ny * ny + nz * nz) or 1.0
        d = (nx * LX + ny * LY + nz * LZ) / m
        if d < 0.0:
            d = 0.0
        lit = 0.22 + 0.78 * d
        if neutral:
            v = int(0.62 * lit * 255)
            if v > 255:
                v = 255
            out[j] = out[j + 1] = out[j + 2] = v
        else:
            k = i * 4
            for c in range(3):
                v = int(alb[k + c] * lit)
                out[j + c] = 255 if v > 255 else v
    return bytes(out)


def tile_img(raw, w, h, mode, crop):
    im = Image.frombytes(mode, (w, h), raw)
    if mode == "RGBA":
        im = im.convert("RGB")
    if crop:
        x0, y0, cw = crop
        im = im.crop((x0, y0, x0 + cw, y0 + cw))
    return im.resize((TILE, TILE), Image.NEAREST)


def row_image(did, meta, neutral, crop=None):
    w, h = meta["w"], meta["h"]
    alb = read(f"{SRC}/{did}-albedo.raw")
    variants = [("albedo", None), ("07-30   (Flush)", "flush"),
                ("pre-v2   micro", "prev2"), ("v2   SHIPPED", "v2")]
    tiles = []
    for label, var in variants:
        if var is None:
            tiles.append((label, tile_img(alb, w, h, "RGBA", crop)))
            continue
        s = shade(did, var, alb, w, h, neutral)
        tiles.append((label, tile_img(s, w, h, "RGB", crop) if s else
                      Image.new("RGB", (TILE, TILE), (0, 0, 0))))

    n = len(tiles)
    W = PAD + n * (TILE + PAD)
    H = HDR + LBL + TILE + PAD
    im = Image.new("RGB", (W, H), (16, 18, 24))
    d = ImageDraw.Draw(im)
    zoom = "  [ZOOM]" if crop else ""
    d.text((PAD, 8),
           f"0x{did}   {w}x{h}   class={meta['class']}{zoom}",
           fill=(232, 238, 248), font=F_HDR)
    d.text((PAD, 34),
           f"face-joint={meta['faceMinusJoint']}    "
           f"dent-follows-art on FACES:  v2 r={meta['rFaceV2']:+.3f}   "
           f"pre-v2 r={meta['rFacePreV2']:+.3f}",
           fill=(158, 170, 190), font=F_LBL)
    for i, (label, timg) in enumerate(tiles):
        x = PAD + i * (TILE + PAD)
        im.paste(timg, (x, HDR + LBL))
        col = (150, 225, 170) if "SHIPPED" in label else (
            (235, 140, 140) if "07-30" in label else (215, 200, 150))
        if label == "albedo":
            col = (170, 190, 220)
        d.text((x + 2, HDR + 5), label, fill=col, font=F_LBL)
        d.rectangle([x - 1, HDR + LBL - 1, x + TILE, HDR + LBL + TILE],
                    outline=(60, 66, 78))
    return im


def main():
    metrics = {m["did"].replace("0x", ""): m
               for m in json.load(open(f"{SRC}/metrics.json"))}
    jobs = json.load(open(sys.argv[1]))
    for j in jobs:
        did = j["did"]
        im = row_image(did, metrics[did], j.get("neutral", False), j.get("crop"))
        p = f"{OUT}/{j['name']}.png"
        im.save(p)
        print(p, im.size)


main()
