#!/usr/bin/env python3
"""cropshot.py — crop a frame to a punch rect (GL convention) and magnify.

The punch rect from `_portalPunchDiag.rect` is in the GL convention: [0,1] with
y increasing UPWARD. Image rows run the other way, so y must be flipped before
it means anything as a crop box. Getting that backwards crops the sky.

usage: cropshot.py <in.png> <out.png> <x0> <y0gl> <x1> <y1gl> [scale] [pad]
"""
import sys
from PIL import Image

src, dst = sys.argv[1], sys.argv[2]
x0, y0g, x1, y1g = (float(v) for v in sys.argv[3:7])
scale = int(sys.argv[7]) if len(sys.argv) > 7 else 2
pad = int(sys.argv[8]) if len(sys.argv) > 8 else 24

im = Image.open(src).convert("RGB")
W, H = im.size
# GL y-up -> image y-down
yi0, yi1 = 1.0 - y1g, 1.0 - y0g
box = (
    max(0, int(x0 * W) - pad),
    max(0, int(yi0 * H) - pad),
    min(W, int(x1 * W) + pad),
    min(H, int(yi1 * H) + pad),
)
c = im.crop(box)
if scale != 1:
    c = c.resize((c.width * scale, c.height * scale), Image.LANCZOS)
c.save(dst)
print(f"{dst} box={box} -> {c.size}")
