#!/usr/bin/env python3
"""mkpairs.py — build the owner-facing before/after pairs for taildrop.

Emits, per camera tag, two files named so they are self-describing on a phone
with no surrounding context:

    s12-B-holtburg-<tag>-punchSidedness-off-<n>.png
    s12-B-holtburg-<tag>-punchSidedness-on-<n>.png

A frame whose GL capture landed between passes (the flat ~1.7-luma clear
colour — see arm.mjs's own note) is SKIPPED and named on stdout: sending a pair
where one side is a capture artifact would be worse than sending nothing.

usage: mkpairs.py <outDir> <dstDir> <armOff> <armOn> [tag ...]
"""
import os
import sys
from PIL import Image

CLEAR_LUMA_MAX = 4.0  # a real frame at noon is ~120; the clear colour is ~1.7


def luma(im):
    h = im.convert("L").histogram()
    n = sum(h)
    return sum(i * c for i, c in enumerate(h)) / n if n else 0.0


def main():
    out, dst, a, b = sys.argv[1:5]
    tags = sys.argv[5:]
    os.makedirs(dst, exist_ok=True)
    if not tags:
        tags = sorted(
            f[len(a) + 1:-len("-gl.png")]
            for f in os.listdir(out)
            if f.startswith(a + "-") and f.endswith("-gl.png")
        )
    n = 0
    for tag in tags:
        pa = os.path.join(out, f"{a}-{tag}-gl.png")
        pb = os.path.join(out, f"{b}-{tag}-gl.png")
        if not (os.path.exists(pa) and os.path.exists(pb)):
            print(f"SKIP {tag}: missing one side")
            continue
        ia, ib = Image.open(pa).convert("RGB"), Image.open(pb).convert("RGB")
        la, lb = luma(ia), luma(ib)
        if la < CLEAR_LUMA_MAX or lb < CLEAR_LUMA_MAX:
            print(f"SKIP {tag}: capture artifact (luma off={la:.2f} on={lb:.2f})")
            continue
        n += 1
        fa = os.path.join(dst, f"s12-B-holtburg-{tag}-punchSidedness-off-{n}.png")
        fb = os.path.join(dst, f"s12-B-holtburg-{tag}-punchSidedness-on-{n}.png")
        ia.save(fa)
        ib.save(fb)
        print(f"PAIR {tag}: luma off={la:.2f} on={lb:.2f}\n  {fa}\n  {fb}")


if __name__ == "__main__":
    main()
