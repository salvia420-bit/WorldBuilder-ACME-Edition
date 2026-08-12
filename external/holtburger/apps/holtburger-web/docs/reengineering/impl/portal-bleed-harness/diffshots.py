#!/usr/bin/env python3
"""diffshots.py — quantify the A/B between two eyetest arms, frame for frame.

Both arms drive the SAME camera rig (see mkjob.mjs RIG), so a pair of frames
with the same tag differs only by the flag under test. Ranking the pairs by how
much they differ is how the repro angle gets picked on evidence rather than by
squinting.

usage: diffshots.py <outDir> <armA> <armB>
"""
import sys, os
from PIL import Image, ImageChops


def load(p):
    return Image.open(p).convert("RGB")


def main():
    out, a, b = sys.argv[1], sys.argv[2], sys.argv[3]
    rows = []
    for fn in sorted(os.listdir(out)):
        if not fn.startswith(a + "-") or not fn.endswith("-gl.png"):
            continue
        tag = fn[len(a) + 1:-len("-gl.png")]
        pa = os.path.join(out, fn)
        pb = os.path.join(out, f"{b}-{tag}-gl.png")
        if not os.path.exists(pb):
            rows.append((tag, None, None, None, "MISSING-B"))
            continue
        ia, ib = load(pa), load(pb)
        if ia.size != ib.size:
            rows.append((tag, None, None, None, f"SIZE {ia.size}!={ib.size}"))
            continue
        d = ImageChops.difference(ia, ib)
        w, h = d.size
        npx = w * h
        # per-pixel max-channel difference histogram
        lum = d.convert("L")
        hist = lum.histogram()
        changed = sum(hist[16:])          # visibly different pixels
        strong = sum(hist[64:])           # strongly different
        mean = sum(i * c for i, c in enumerate(hist)) / npx
        rows.append((tag, 100.0 * changed / npx, 100.0 * strong / npx, mean, "ok"))

    print(f"{'tag':<12} {'changed%':>9} {'strong%':>9} {'meanDiff':>9}  note")
    for tag, ch, st, mn, note in sorted(
        rows, key=lambda r: (r[2] is None, -(r[2] or 0))
    ):
        if ch is None:
            print(f"{tag:<12} {'-':>9} {'-':>9} {'-':>9}  {note}")
        else:
            print(f"{tag:<12} {ch:9.3f} {st:9.3f} {mn:9.3f}  {note}")


if __name__ == "__main__":
    main()
