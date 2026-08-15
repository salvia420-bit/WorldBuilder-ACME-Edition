#!/usr/bin/env python3
"""gallery.py -- A/B boards straight from the DATs: LEFT = base record, RIGHT =
the record READ BACK from export/client_portal.dat (round-trip proof), same
camera, Remacri textures on both.

Two rows per board:
  top    -- whole model, standard three-quarter view
  bottom -- CLOSE CROP of the largest carved wall polygon, grazing key light
            (0.05-0.10 m relief is sub-pixel at whole-building framing; the
            crop is where the displacement must be visible)
Bottom row carries a pixel-diff %% (fraction of pixels differing > 8/255).
"""
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, "/mnt/wbterminal2/dpc-work")
import gfxlib      # noqa: E402
import pipeline    # noqa: E402
import relief3d    # noqa: E402
import render3     # noqa: E402
import r2lib as R  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
EXP_P = os.path.join(HERE, "export/client_portal.dat")
GAL = os.path.join(HERE, "gallery")
os.makedirs(GAL, exist_ok=True)

pat = gfxlib.Portal(EXP_P)
stats = json.load(open(os.path.join(HERE, "build_stats.json")))
models = json.load(open(os.path.join(HERE, "models.json")))["gfxObjs"]


def build_mesh(portal, gid, metas):
    rec = portal.gfx(gid)
    src = relief3d.SourceMesh.from_record(rec, metas)
    return pipeline.original(src), src


def crop_target(src):
    """Largest-area carving polygon that is wall-like (steep normal)."""
    best, best_area = None, 0.0
    P = np.asarray(src.P)
    for p in src.polys:
        if p.get("h") is None or p.get("amp", 0) <= 0 or p.get("invisible"):
            continue
        v = P[p["v"]]
        area = 0.0
        for k in range(1, len(v) - 1):
            area += 0.5 * np.linalg.norm(np.cross(v[k] - v[0], v[k + 1] - v[0]))
        n = np.cross(v[1] - v[0], v[2] - v[0])
        nn = np.linalg.norm(n)
        if nn < 1e-9:
            continue
        n = n / nn
        wall = abs(n[2]) < 0.6
        score = area * (2.0 if wall else 1.0)
        if score > best_area:
            best_area, best = score, (v.mean(axis=0), n, area)
    return best


def crop_camera(ctr, n, area):
    """Oblique view onto the wall + grazing key light along it."""
    yaw = float(np.arctan2(-n[0], -n[1]) + np.radians(55))
    pitch = np.radians(6)
    t = np.cross([0.0, 0.0, 1.0], n)
    tl = np.linalg.norm(t)
    t = t / tl if tl > 1e-9 else np.array([1.0, 0.0, 0.0])
    L = t + 0.22 * n + np.array([0.0, 0.0, 0.30])
    rad = float(np.clip(np.sqrt(area) * 0.85, 1.4, 3.2))
    return dict(fit=(ctr + n * 0.05, rad), yaw=yaw, pitch=pitch,
                light=tuple(L / np.linalg.norm(L)), ambient=0.26, diffuse=1.45,
                fill_light=(-t[0], -t[1], 0.5), fill_amt=0.12)


def to_img(a):
    """render3.render returns a PIL Image already; pass it through."""
    if isinstance(a, Image.Image):
        return a
    return Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8))


def diff_pct_of(a, b):
    """% of pixels whose max channel delta exceeds 8/255. Int-safe."""
    x = np.asarray(a, dtype=np.int16)
    y = np.asarray(b, dtype=np.int16)
    return 100.0 * float((np.abs(x - y).max(axis=2) > 8).mean())


index = ["# Holtburg pilot A/B gallery (v2)",
         "",
         "LEFT = retail record (base dat). RIGHT = patched record read back "
         "from `export/client_portal.dat` (round-trip proof). Top row: whole "
         "model. Bottom row: close crop of the largest carved wall, grazing "
         "key light. diff%% = pixels differing >8/255 in the close crop.",
         "", "| model | drawn tris | mult | crop diff%% | board |",
         "|---|---|---|---|---|"]

picked = sorted(stats, key=lambda g: -stats[g]["totalTris"])
for gid_h in picked:
    gid = int(gid_h, 16)
    _src0, metas, _rec = pipeline.gfx_source(gid)
    tex, _ = pipeline.load_textures(metas)
    oa, sa = build_mesh(pipeline.P, gid, metas)
    ob, sb = build_mesh(pat, gid, metas)
    fta = pipeline.face_surface(sa, oa["poly"])
    ftb = pipeline.face_surface(sb, ob["poly"])
    Vb = np.asarray(pipeline.P.gfx(gid)["P"])
    fit = ((Vb.min(0) + Vb.max(0)) / 2.0,
           float(np.linalg.norm(Vb.max(0) - Vb.min(0)) / 2) or 1.0)

    far = dict(fit=fit, size=(640, 430), yaw=np.radians(24),
               pitch=np.radians(8), light=(0.92, -0.34, 0.20), ambient=0.30,
               diffuse=1.35, fill_light=(-0.5, 0.6, 0.25), fill_amt=0.16)
    A1 = render3.render(oa["V"], oa["F"], oa["UV"], oa["NR"], fta, tex, **far)
    B1 = render3.render(ob["V"], ob["F"], ob["UV"], ob["NR"], ftb, tex, **far)

    tgt = crop_target(sa)
    diff_pct = float("nan")
    if tgt is not None:
        cam = crop_camera(*tgt)
        cam["size"] = (640, 430)
        A2 = render3.render(oa["V"], oa["F"], oa["UV"], oa["NR"], fta, tex, **cam)
        B2 = render3.render(ob["V"], ob["F"], ob["UV"], ob["NR"], ftb, tex, **cam)
        diff_pct = diff_pct_of(A2, B2)
    else:
        A2 = Image.new("RGB", (640, 430), (16, 18, 24))
        B2 = A2.copy()

    row1 = R.side_by_side([to_img(A1), to_img(B1)])
    row2 = R.side_by_side([to_img(A2), to_img(B2)])
    img = R.stack([row1, row2])
    strip = Image.new("RGB", (img.size[0], img.size[1] + 34), (12, 13, 18))
    strip.paste(img, (0, 0))
    d = ImageDraw.Draw(strip)
    n0, n1 = len(oa["F"]), len(ob["F"])
    d.text((8, img.size[1] + 8),
           "%s   base %d tris -> patched %d drawn (%.2fx)   close-crop diff "
           "%.1f%%   %s" % (gid_h, n0, n1, n1 / max(n0, 1), diff_pct,
                            models[gid_h]["why"]),
           fill=(230, 230, 230))
    out = os.path.join(GAL, "%s.png" % gid_h)
    strip.save(out)
    index.append("| %s | %d -> %d | %.2fx | %.1f | ![](%s.png) |"
                 % (gid_h, n0, n1, n1 / max(n0, 1), diff_pct, gid_h))
    print("rendered %s  %d -> %d  crop-diff %.1f%%" % (gid_h, n0, n1, diff_pct))

with open(os.path.join(GAL, "INDEX.md"), "w") as f:
    f.write("\n".join(index) + "\n")
print("gallery ->", GAL)
