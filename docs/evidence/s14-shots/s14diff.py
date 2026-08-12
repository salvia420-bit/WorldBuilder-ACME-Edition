#!/usr/bin/env python3
"""s14diff.py — where does statPom actually change the frame?

Two frames from the SAME camera pose differing only by the statPom uniform.
The per-pixel |A-B| is tiny in absolute terms (a parallax shift of a few texels
plus its self-shadow), so a raw difference image reads as black. Amplify it and
report the spatial distribution, which is the whole question: a content-FOLLOWING
height field moves pixels along the art's own dark seams, so the difference must
be structured and concentrated, not a uniform wash.

usage: s14diff.py <A.png> <B.png> <outHeat.png> [gain]
"""
import sys
from PIL import Image, ImageChops

a_p, b_p, out_p = sys.argv[1], sys.argv[2], sys.argv[3]
gain = float(sys.argv[4]) if len(sys.argv) > 4 else 12.0

A = Image.open(a_p).convert("RGB")
B = Image.open(b_p).convert("RGB")
if A.size != B.size:
    B = B.resize(A.size)
W, H = A.size

d = ImageChops.difference(A, B).convert("L")
px = d.load()

hist = [0] * 256
nz = 0
tot = W * H
acc = 0
for y in range(H):
    for x in range(W):
        v = px[x, y]
        hist[v] += 1
        acc += v
        if v > 2:
            nz += 1

# amplified heat map: grey = no change, hot = statPom moved this pixel
heat = d.point(lambda v: min(255, int(v * gain)))
heat.save(out_p)

mean = acc / tot
p = sorted(range(256), key=lambda i: -hist[i])[:1]
mx = max(i for i in range(256) if hist[i] > 0)
print(f"{out_p}  size={W}x{H} gain={gain}")
print(f"  changed>2/255 : {100.0*nz/tot:.2f}% of pixels")
print(f"  mean|A-B|     : {mean:.3f}/255   max={mx}")
print(f"  mode diff     : {p[0]}")
