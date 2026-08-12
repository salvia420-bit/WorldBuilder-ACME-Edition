#!/usr/bin/env python3
"""mkweak.py — the honest counterweight frame.

Classifier v2 rescued 139 of 148 Shoushi architectural textures from Flush.
It did NOT rescue all of them: on 9, the seam operator finds almost no joints
even though the class is now correct, so they still read vanilla. This sheet
puts the worst of those next to a texture where v2 clearly works, at identical
lighting, so the difference is attributable to the CONTENT and not the rig.
"""
import json
import os
import sys
from math import sqrt

from PIL import Image, ImageDraw, ImageFont

SRC = "/home/wbterminal/fanout-s12/B/eyetest-B/corpus"
OUT = "/home/wbterminal/fanout-s12/B/eyetest-B/drop"
TILE, PAD, HDR, ROWH = 300, 12, 66, 26

_l = (-0.55, -0.42, 0.72)
_n = sqrt(sum(c * c for c in _l))
LX, LY, LZ = (c / _n for c in _l)


def font(sz):
    for p in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
              "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
        if os.path.exists(p):
            return ImageFont.truetype(p, sz)
    return ImageFont.load_default()


F_HDR, F_ROW = font(22), font(16)


def read(p):
    with open(p, "rb") as f:
        return f.read()


def lit(did, w, h):
    nb = read(f"{SRC}/{did}-n-v2.raw")
    out = bytearray(w * h * 3)
    for i in range(w * h):
        j = i * 3
        nx, ny, nz = nb[j] / 127.5 - 1, nb[j + 1] / 127.5 - 1, nb[j + 2] / 127.5 - 1
        m = sqrt(nx * nx + ny * ny + nz * nz) or 1.0
        d = max(0.0, (nx * LX + ny * LY + nz * LZ) / m)
        v = int(0.62 * (0.22 + 0.78 * d) * 255)
        out[j] = out[j + 1] = out[j + 2] = min(255, v)
    return Image.frombytes("RGB", (w, h), bytes(out)).resize((TILE, TILE), Image.NEAREST)


def alb(did, w, h):
    return Image.frombytes("RGBA", (w, h), read(f"{SRC}/{did}-albedo.raw")).convert(
        "RGB").resize((TILE, TILE), Image.NEAREST)


def main():
    metrics = {m["did"].replace("0x", ""): m for m in json.load(open(f"{SRC}/metrics.json"))}
    rows = json.load(open(sys.argv[1]))
    W = PAD + 2 * (TILE + PAD) + 470
    H = HDR + len(rows) * (TILE + ROWH + PAD) + PAD
    im = Image.new("RGB", (W, H), (16, 18, 24))
    d = ImageDraw.Draw(im)
    d.text((PAD, 10), "CAUSE 2 residual: correct class, but the seam operator still finds no joints",
           fill=(232, 238, 248), font=F_HDR)
    d.text((PAD, 38), "9 of 148 Shoushi architectural textures land here. Same light, same rig — "
                      "only the texture content differs.", fill=(158, 170, 190), font=F_ROW)
    y = HDR
    for r in rows:
        did = r["did"]
        m = metrics[did]
        w, h = m["w"], m["h"]
        good = r.get("good", False)
        col = (150, 225, 170) if good else (235, 140, 140)
        d.text((PAD, y), f"0x{did}  {w}x{h}  class={m['class']}   face-joint={m['faceMinusJoint']:.3f}"
                         f"   {'WORKS' if good else 'STILL READS FLAT'}", fill=col, font=F_ROW)
        im.paste(alb(did, w, h), (PAD, y + ROWH))
        im.paste(lit(did, w, h), (PAD + TILE + PAD, y + ROWH))
        d.text((PAD + 2 * (TILE + PAD), y + ROWH + 6), "albedo", fill=(170, 190, 220), font=F_ROW)
        d.text((PAD + 2 * (TILE + PAD), y + ROWH + 30), "v2 relief  ->", fill=col, font=F_ROW)
        d.multiline_text((PAD + 2 * (TILE + PAD), y + ROWH + 62),
                         r.get("note", ""), fill=(150, 160, 178), font=F_ROW, spacing=4)
        for k in range(2):
            x = PAD + k * (TILE + PAD)
            d.rectangle([x - 1, y + ROWH - 1, x + TILE, y + ROWH + TILE], outline=(60, 66, 78))
        y += TILE + ROWH + PAD
    p = f"{OUT}/s13-R-CAUSE2-residual-still-flat.png"
    im.save(p)
    print(p, im.size)


main()
