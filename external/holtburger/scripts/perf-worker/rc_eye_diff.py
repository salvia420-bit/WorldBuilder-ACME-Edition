#!/usr/bin/env python3
"""rc_eye_diff.py — compare two rc-eye.mjs runs shot by shot (2026-10-29, batch RC-EYE).

    python3 -I scripts/perf-worker/rc_eye_diff.py <prefixA> <prefixB> <outDir>

For every `<prefixA>-<shot>.png` with a `<prefixB>-<shot>.png`: the share of pixels whose max
channel differs by more than 8 / 255 and by more than 32 / 255, both frames' mean brightness, and
`<outDir>/pair-<shot>.png` = A | B | |A - B| x4 (the heatmap shows WHERE they differ). Particle
positions, wind sway and idle animation differ between boots by design; a lane fault shows as a
structural difference (missing / extra objects, wrong colours, broken interiors). Prints JSON.
"""
import glob
import json
import os
import sys

from PIL import Image, ImageChops


def main():
    a_pre, b_pre, out_dir = sys.argv[1], sys.argv[2], sys.argv[3]
    os.makedirs(out_dir, exist_ok=True)
    rows = []
    for a_path in sorted(glob.glob(a_pre + "-*.png")):
        shot = a_path[len(a_pre) + 1:-4]
        b_path = f"{b_pre}-{shot}.png"
        if not os.path.exists(b_path):
            continue
        a = Image.open(a_path).convert("RGB")
        b = Image.open(b_path).convert("RGB")
        if a.size != b.size:
            rows.append({"shot": shot, "error": f"size {a.size} vs {b.size}"})
            continue
        d = ImageChops.difference(a, b)
        r, g, bl = d.split()
        mx = ImageChops.lighter(ImageChops.lighter(r, g), bl)
        hist = mx.histogram()
        n = a.size[0] * a.size[1]
        over8 = sum(hist[9:]) / n
        over32 = sum(hist[33:]) / n
        mean = lambda im: sum(i * c for i, c in enumerate(im.convert("L").histogram())) / n
        heat = mx.point(lambda v: min(255, v * 4)).convert("RGB")
        w, h = a.size
        pair = Image.new("RGB", (w * 3, h))
        pair.paste(a, (0, 0))
        pair.paste(b, (w, 0))
        pair.paste(heat, (2 * w, 0))
        pair.save(os.path.join(out_dir, f"pair-{shot}.png"))
        rows.append({"shot": shot, "pxOver8": round(over8 * 100, 2), "pxOver32": round(over32 * 100, 2),
                     "meanA": round(mean(a), 1), "meanB": round(mean(b), 1)})
    print(json.dumps(rows, indent=1))


if __name__ == "__main__":
    main()
