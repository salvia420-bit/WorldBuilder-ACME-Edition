import json, sys, math
import numpy as np
from PIL import Image, ImageDraw
import acmodel
d = json.load(open(sys.argv[1]))
parts = [dict(did=p["did"], offset=p["offset"], rot=p["rot"], scale=p["scale"]) for p in d["parts"]]
if "--pilot" in sys.argv:
    parts.append(dict(did=0x02000001, offset=d["seat"], rot=[1,0,0,0], scale=1.0, tint=(0.9,0.2,0.2)))
V, F, C = acmodel.composite(parts)
size = 520
views = ["iso", "side", "top", "front"]
ims = [acmodel.render(V, F, C, v, size) for v in views]
W = Image.new("RGB", (size * 2, size * 2 + 18), (30, 30, 30))
for i, im in enumerate(ims):
    W.paste(im, ((i % 2) * size, 18 + (i // 2) * size))
lo, hi = V.min(0), V.max(0)
ImageDraw.Draw(W).text((4, 2), "bbox x %.2f..%.2f y %.2f..%.2f z %.2f..%.2f tris %d" % (lo[0], hi[0], lo[1], hi[1], lo[2], hi[2], len(F)), fill=(255,255,255))
W.save(sys.argv[2])
