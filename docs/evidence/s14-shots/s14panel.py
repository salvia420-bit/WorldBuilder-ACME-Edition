#!/usr/bin/env python3
"""s14panel.py — labelled N-up composite for phone review.

A bare 1600x1000 frame is unreadable on a phone and a lone frame proves nothing,
so the owner-facing artifact is: same crop, same camera pose, N arms, labelled,
with a caption naming what to look at.

usage: s14panel.py <out.png> <crop x0,y0,x1,y1 (0-1) | full> <caption> <sub>
                   <label1> <img1> [<label2> <img2> ...]
"""
import sys
from PIL import Image, ImageDraw, ImageFont


def font(sz, bold=True):
    paths = ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
             "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]
    if not bold:
        paths.reverse()
    for p in paths:
        try:
            return ImageFont.truetype(p, sz)
        except OSError:
            continue
    return ImageFont.load_default()


out_p, crop_s, caption, sub = sys.argv[1:5]
rest = sys.argv[5:]
pairs = [(rest[i], rest[i + 1]) for i in range(0, len(rest) - 1, 2)]

imgs = []
for lab, p in pairs:
    im = Image.open(p).convert("RGB")
    if crop_s != "full":
        x0, y0, x1, y1 = (float(v) for v in crop_s.split(","))
        W, H = im.size
        im = im.crop((int(x0 * W), int(y0 * H), int(x1 * W), int(y1 * H)))
    imgs.append((lab, im))

h = min(i.height for _, i in imgs)
imgs = [(l, i.crop((0, 0, i.width, h))) for l, i in imgs]

CAP, SUB, BAR, GAP, PAD = 52, 40, 44, 10, 12
W = sum(i.width for _, i in imgs) + GAP * (len(imgs) - 1) + PAD * 2
H = CAP + SUB + BAR + h + PAD
out = Image.new("RGB", (W, H), (16, 16, 18))
d = ImageDraw.Draw(out)
d.text((PAD, 10), caption, fill=(255, 255, 255), font=font(30))
d.text((PAD, 10 + CAP - 12), sub, fill=(170, 175, 185), font=font(21, False))

COLS = [(255, 120, 120), (130, 255, 150), (140, 190, 255), (255, 215, 120)]
x = PAD
for k, (lab, im) in enumerate(imgs):
    d.text((x, CAP + SUB), lab, fill=COLS[k % len(COLS)], font=font(24))
    out.paste(im, (x, CAP + SUB + BAR))
    d.rectangle([x, CAP + SUB + BAR, x + im.width - 1, CAP + SUB + BAR + h - 1],
                outline=COLS[k % len(COLS)], width=2)
    x += im.width + GAP

out.save(out_p)
print(out_p, out.size)
