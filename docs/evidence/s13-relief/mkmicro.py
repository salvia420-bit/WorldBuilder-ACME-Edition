#!/usr/bin/env python3
"""mkmicro.py — the "dents ON the stones" frame, isolated.

The owner's complaint was about the MICRO layer specifically, and in a normal
lit render the shared macro (seam+pillow) swamps it. So this strips the macro
away and shows the micro DIP field on its own:

  albedo            the decoded texture
  art's own pores   the texture's fine-scale dark detail (height_seam.rs
                    micro_detail_dark) — where a dent SHOULD land
  pre-v2 dents      synthesized value noise, content-blind: dents at random
  v2 dents          today's shipped micro: 65% art-following, 35% noise

Dents are shown as heat (bright = deeper dent) at a FIXED gain shared by both
dent tiles, so the two are directly comparable. Gain is printed on the frame.
"""
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

SRC = "/home/wbterminal/fanout-s12/B/eyetest-B/relief"
OUT = "/home/wbterminal/fanout-s12/B/eyetest-B/drop"
os.makedirs(OUT, exist_ok=True)

TILE, PAD, HDR, LBL = 384, 14, 60, 30
GAIN = 10.0  # dips are 2-6% of range; without gain the frame is flat grey


def font(sz, bold=True):
    p = ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold
         else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")
    return ImageFont.truetype(p, sz) if os.path.exists(p) else ImageFont.load_default()


F_HDR, F_LBL = font(23), font(17)


def read(p):
    with open(p, "rb") as f:
        return f.read()


def heat(vals, w, h):
    """dip in [0,1] -> blue-black .. orange .. white."""
    out = bytearray(w * h * 3)
    for i, v in enumerate(vals):
        if v < 0.0:
            v = 0.0
        elif v > 1.0:
            v = 1.0
        j = i * 3
        out[j] = int(255 * min(1.0, v * 1.6))
        out[j + 1] = int(255 * max(0.0, min(1.0, v * 1.6 - 0.45)))
        out[j + 2] = int(255 * max(0.0, min(1.0, v * 1.6 - 0.80)) * 0.9 + 18 * (1 - v))
    return bytes(out)


def dip_field(did, var, w, h):
    """macro - variant = the micro dip, exactly as composed at
    height_seam.rs:767-771."""
    m = read(f"{SRC}/{did}-h-macroonly.raw")
    v = read(f"{SRC}/{did}-h-{var}.raw")
    return [max(0, m[i] - v[i]) / 255.0 * GAIN for i in range(w * h)]


def tile(raw_or_vals, w, h, mode, crop, is_vals=False):
    im = (Image.frombytes("RGB", (w, h), heat(raw_or_vals, w, h)) if is_vals
          else Image.frombytes(mode, (w, h), raw_or_vals))
    if mode == "RGBA" and not is_vals:
        im = im.convert("RGB")
    if mode == "L" and not is_vals:
        im = im.convert("RGB")
    if crop:
        x0, y0, cw = crop
        im = im.crop((x0, y0, x0 + cw, y0 + cw))
    return im.resize((TILE, TILE), Image.NEAREST)


def build(did, meta, crop):
    w, h = meta["w"], meta["h"]
    tiles = [
        ("albedo", tile(read(f"{SRC}/{did}-albedo.raw"), w, h, "RGBA", crop)),
        ("art's own pores", tile(read(f"{SRC}/{did}-dark.raw"), w, h, "L", crop)),
        ("pre-v2 dents  (random)", tile(dip_field(did, "prev2", w, h), w, h, "RGB", crop, True)),
        ("v2 dents  (follow art)", tile(dip_field(did, "v2", w, h), w, h, "RGB", crop, True)),
    ]
    W = PAD + len(tiles) * (TILE + PAD)
    im = Image.new("RGB", (W, HDR + LBL + TILE + PAD), (16, 18, 24))
    d = ImageDraw.Draw(im)
    d.text((PAD, 8), f"0x{did}   {w}x{h}   class={meta['class']}   "
                     f"MICRO layer only (macro removed){'   [ZOOM]' if crop else ''}",
           fill=(232, 238, 248), font=F_HDR)
    d.text((PAD, 34),
           f"dent-follows-art on FACES:  v2 r={meta['rFaceV2']:+.3f}   "
           f"pre-v2 r={meta['rFacePreV2']:+.3f}    |    mean dent on face: "
           f"v2 {meta['dipOnFaceV2']:.4f} vs pre-v2 {meta['dipOnFacePreV2']:.4f}"
           f"    |    heat gain x{GAIN:.0f}",
           fill=(158, 170, 190), font=F_LBL)
    for i, (label, timg) in enumerate(tiles):
        x = PAD + i * (TILE + PAD)
        im.paste(timg, (x, HDR + LBL))
        col = ((150, 225, 170) if label.startswith("v2") else
               (235, 140, 140) if label.startswith("pre-v2") else
               (215, 200, 150) if "pores" in label else (170, 190, 220))
        d.text((x + 2, HDR + 5), label, fill=col, font=F_LBL)
        d.rectangle([x - 1, HDR + LBL - 1, x + TILE, HDR + LBL + TILE],
                    outline=(60, 66, 78))
    return im


def main():
    metrics = {m["did"].replace("0x", ""): m
               for m in json.load(open(f"{SRC}/metrics.json"))}
    for j in json.load(open(sys.argv[1])):
        did = j["did"]
        p = f"{OUT}/{j['name']}.png"
        build(did, metrics[did], j.get("crop")).save(p)
        print(p)


main()
