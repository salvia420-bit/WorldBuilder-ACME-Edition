#!/usr/bin/env python3
"""sidebyside.py — labelled A|B composite of one crop, for phone review.

A bare 1280x800 frame is unreadable on a phone and a lone frame proves nothing,
so the owner-facing artifact is: same crop, same camera, two arms, labelled,
stacked side by side with a caption naming what to look at.

usage: sidebyside.py <out.png> <caption> <labelA> <imgA> <labelB> <imgB>
"""
import sys
from PIL import Image, ImageDraw, ImageFont


def font(sz):
    for p in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ):
        try:
            return ImageFont.truetype(p, sz)
        except OSError:
            continue
    return ImageFont.load_default()


dst, caption, la, pa, lb, pb = sys.argv[1:7]
ia, ib = Image.open(pa).convert("RGB"), Image.open(pb).convert("RGB")
h = min(ia.height, ib.height)
ia = ia.crop((0, 0, ia.width, h))
ib = ib.crop((0, 0, ib.width, h))

BAR, CAP, GAP = 46, 56, 12
W = ia.width + ib.width + GAP
out = Image.new("RGB", (W, CAP + BAR + h), (18, 18, 18))
d = ImageDraw.Draw(out)
d.text((14, 14), caption, fill=(255, 255, 255), font=font(28))
d.text((14, CAP + 10), la, fill=(255, 140, 140), font=font(26))
d.text((ia.width + GAP + 14, CAP + 10), lb, fill=(140, 255, 160), font=font(26))
out.paste(ia, (0, CAP + BAR))
out.paste(ib, (ia.width + GAP, CAP + BAR))
out.save(dst)
print(dst, out.size)
