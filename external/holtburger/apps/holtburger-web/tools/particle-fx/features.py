#!/usr/bin/env python3
"""Per-surface texture features for the particle FX generator.

radial: how rotation-invariant the sprite is (1 = perfectly radial; spin is
        invisible-safe), from the correlation of the energy map with its own
        30/45/60/90-degree rotations, inside the inscribed circle.
edge:   energy in the outer ring vs the centre (a spun sprite whose corners
        carry energy would show its square corners sweeping).
lum95 / lumMax: 95th-percentile / max luminance of the BLEND-weighted texel
        (additive: rgb*a; alpha: rgb where a>0.1), 0..1.
hue / chroma: dominant hue (degrees) + chroma of the weighted mean colour.
cover: fraction of texels carrying energy (> 4% of max).
"""
import json, math, os
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.environ.get("PFX_WORK") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "work")
os.makedirs(WORK, exist_ok=True)
rows = json.load(open(os.path.join(WORK, "emitters_ctx.json")))
surfs = {}
for e in rows:
    if e["gfx"]["surfaces"]:
        surfs[e["gfx"]["surfaces"][0]] = e["surface"] or {}

out = {}
for sid, st in surfs.items():
    p = os.path.join(WORK, "thumbs", f"{sid:08X}.png")
    f = {"hasTex": os.path.exists(p), "additive": bool(st.get("type", 0) & 0x10000),
         "clip": bool(st.get("type", 0) & 0x4)}
    if f["hasTex"]:
        im = np.asarray(Image.open(p).convert("RGBA")).astype(np.float32) / 255.0
        h, w = im.shape[:2]
        a = im[:, :, 3]
        rgb = im[:, :, :3]
        if f["additive"]:
            wrgb = rgb * a[:, :, None]
            energy = wrgb.max(axis=2)
        else:
            wrgb = rgb
            energy = a
        lum = 0.2126 * wrgb[:, :, 0] + 0.7152 * wrgb[:, :, 1] + 0.0722 * wrgb[:, :, 2]
        mask = (a > 0.1) if not f["additive"] else (energy > 0.04 * max(1e-6, energy.max()))
        f["cover"] = round(float(mask.mean()), 3)
        f["lumMax"] = round(float(lum.max()), 3)
        f["lum95"] = round(float(np.percentile(lum[mask], 95)) if mask.any() else 0.0, 3)
        f["lumMean"] = round(float(lum[mask].mean()) if mask.any() else 0.0, 3)
        wts = energy[mask] if mask.any() else np.ones(1)
        if mask.any():
            mc = (wrgb[mask] * wts[:, None]).sum(0) / max(1e-6, wts.sum())
        else:
            mc = np.zeros(3)
        mx, mn = float(mc.max()), float(mc.min())
        f["meanColor"] = [round(float(x), 3) for x in mc]
        f["chroma"] = round((mx - mn) / mx, 3) if mx > 1e-4 else 0.0
        r, g, b = mc
        if mx - mn < 1e-4:
            hue = 0.0
        elif mx == r:
            hue = (60 * ((g - b) / (mx - mn)) + 360) % 360
        elif mx == g:
            hue = 60 * ((b - r) / (mx - mn)) + 120
        else:
            hue = 60 * ((r - g) / (mx - mn)) + 240
        f["hue"] = round(float(hue), 1)
        # radial symmetry on a square resample
        sq = np.asarray(Image.fromarray((energy * 255).astype(np.uint8)).resize((64, 64), Image.BILINEAR)).astype(np.float32) / 255.0
        yy, xx = np.mgrid[0:64, 0:64]
        rr = np.hypot(xx - 31.5, yy - 31.5)
        inside = rr <= 31.5
        base = Image.fromarray((sq * 255).astype(np.uint8))
        cors = []
        for ang in (30, 45, 60, 90):
            rot = np.asarray(base.rotate(ang, resample=Image.BILINEAR)).astype(np.float32) / 255.0
            x1 = sq[inside] - sq[inside].mean(); x2 = rot[inside] - rot[inside].mean()
            den = math.sqrt(float((x1 * x1).sum() * (x2 * x2).sum()))
            cors.append(float((x1 * x2).sum() / den) if den > 1e-9 else 1.0)
        f["radial"] = round(min(cors), 3)
        ring = (rr > 26) & (rr <= 31.5)
        corner = rr > 31.5
        tot = float(sq.sum()) + 1e-6
        f["edge"] = round(float(sq[ring].sum() + sq[corner].sum()) / tot, 3)
        f["aspect"] = round(w / h, 3)
        # Energy in the outermost ~4% frame relative to the peak (perceptual
        # for additive): what shows as a hard square at the quad border.
        pe = (np.sqrt(np.maximum(rgb.max(axis=2), 0)) * a) if f["additive"] else a
        b = max(1, round(min(h, w) * 0.04))
        frame = np.concatenate([pe[:b].ravel(), pe[-b:].ravel(), pe[:, :b].ravel(), pe[:, -b:].ravel()])
        f["border"] = round(float(frame.mean() / (pe.max() or 1.0)), 3)
    out[sid] = f
json.dump({hex(k): v for k, v in out.items()}, open(os.path.join(WORK, "surface_features.json"), "w"), indent=0)
print(len(out), "surfaces")
