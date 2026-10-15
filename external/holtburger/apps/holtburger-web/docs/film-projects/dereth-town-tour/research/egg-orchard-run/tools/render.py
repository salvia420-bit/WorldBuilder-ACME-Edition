#!/usr/bin/env python3
"""render.py - section drawings of the Egg Orchard geometry (PIL only).

A section is the intersection of every cell surface / prop mesh with a plane, drawn in the plane's 2-D basis,
plus the racing line projected onto it (points within `band` m of the plane drawn bright, the rest faint),
creatures (physics circle / cylinder) and props.

  python3 tools/render.py plan  --z=-58 --x=10,40 --y=8118,8146 [--line=data/racing_line.json] --out=img.png
  python3 tools/render.py side  --x=470 --y=8080,8110 --z=-2,10 ...        (vertical plane x = const, axis y)
  python3 tools/render.py sidey --y=8156 --x=180,200 --z=-56,-28 ...       (vertical plane y = const, axis x)
"""
import argparse, json, math, os, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import eogeo as G


def font(n):
    for f in ('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/TTF/DejaVuSans.ttf'):
        if os.path.exists(f):
            return ImageFont.truetype(f, n)
    return ImageFont.load_default()


def plane_segments(A, B, C, o, n):
    """Intersect triangles with plane n.(p-o)=0 -> list of (p0, p1) 3-D segments."""
    da = (A - o) @ n; db = (B - o) @ n; dc = (C - o) @ n
    segs = []
    for i in np.nonzero(~((da > 0) & (db > 0) & (dc > 0)) & ~((da < 0) & (db < 0) & (dc < 0)))[0]:
        P = [A[i], B[i], C[i]]; d = [da[i], db[i], dc[i]]
        pts = []
        for a, b in ((0, 1), (1, 2), (2, 0)):
            if (d[a] > 0) != (d[b] > 0) and d[a] != d[b]:
                t = d[a] / (d[a] - d[b]); pts.append(P[a] + t * (P[b] - P[a]))
            elif d[a] == 0:
                pts.append(P[a])
        if len(pts) >= 2:
            segs.append((pts[0], pts[1]))
    return segs


def draw_section(D, out, o, u, v, ur, vr, line=None, band=1.5, title='', scale=None, marks=(), W=1400):
    o, u, v = (np.asarray(x, float) for x in (o, u, v))
    n = np.cross(u, v); n /= np.linalg.norm(n)
    du = ur[1] - ur[0]; dv = vr[1] - vr[0]
    s = scale or (W - 60) / du
    Wimg = int(du * s) + 60; Himg = int(dv * s) + 90
    im = Image.new('RGB', (Wimg, Himg), (16, 18, 22)); d = ImageDraw.Draw(im)
    X = lambda p: (30 + ((p - o) @ u - ur[0]) * s, 60 + (vr[1] - (p - o) @ v) * s)
    # grid every 1 m (faint), 5 m (stronger)
    for k in range(int(math.floor(ur[0])), int(math.ceil(ur[1])) + 1):
        x = 30 + (k - ur[0]) * s
        d.line([(x, 60), (x, Himg - 30)], fill=(40, 44, 52) if k % 5 else (62, 68, 80))
        if k % 5 == 0:
            d.text((x + 2, Himg - 28), str(round((o @ u) + k, 1)), fill=(120, 130, 140), font=font(11))
    for k in range(int(math.floor(vr[0])), int(math.ceil(vr[1])) + 1):
        y = 60 + (vr[1] - k) * s
        d.line([(30, y), (Wimg - 30, y)], fill=(40, 44, 52) if k % 5 else (62, 68, 80))
        if k % 5 == 0:
            d.text((2, y - 6), str(round((o @ v) + k, 1)), fill=(120, 130, 140), font=font(11))
    for a, b in plane_segments(D.TA, D.TB, D.TC, o, n):
        d.line([X(a), X(b)], fill=(220, 220, 225), width=2)
    for a, b in plane_segments(D.PA, D.PB, D.PC, o, n):
        d.line([X(a), X(b)], fill=(90, 200, 120), width=2)
    # creatures: intersect the physics cylinder with the plane (approx: draw circle in plan, rect in side)
    for c in D.creatures:
        p = c['pos']; dist = abs((p - o) @ n)
        if dist > c['r'] + band + 1.0:
            continue
        col = {'Olthoi Ripper': (240, 80, 70), 'Olthoi Slasher': (240, 170, 60), 'Olthoi Slayer': (230, 120, 220),
               'Olthoi Larvae': (250, 240, 120)}[c['name']]
        if abs(n[2]) > 0.9:  # plan
            cx, cy = X(p); r = c['r'] * s
            d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=col, width=2)
            r2 = (c['r'] + 0.8) * s
            d.ellipse([cx - r2, cy - r2, cx + r2, cy + r2], outline=tuple(int(x * 0.5) for x in col), width=1)
            f = c['forward']; d.line([(cx, cy), (cx + f[0] * c['sweptR'] * s * 0.8, cy - f[1] * c['sweptR'] * s * 0.8)], fill=col, width=2)
        else:
            a = p - c['r'] * u; b = p + c['r'] * u + c['top'] * np.array([0, 0, 1.0])
            xa, ya = X(a); xb, yb = X(b)
            d.rectangle([min(xa, xb), min(ya, yb), max(xa, xb), max(ya, yb)], outline=col, width=2)
        d.text(X(p), c['name'].split()[-1][:3] + c['cellHex'][-3:], fill=col, font=font(11))
    if line is not None:
        L = np.asarray(line, float)
        dist = np.abs((L - o) @ n)
        for i in range(len(L) - 1):
            bright = dist[i] < band
            d.line([X(L[i]), X(L[i + 1])], fill=(80, 190, 255) if bright else (40, 80, 110), width=3 if bright else 1)
    for p, text, col in marks:
        x, y = X(np.asarray(p, float)); d.ellipse([x - 4, y - 4, x + 4, y + 4], fill=col)
        d.text((x + 6, y - 6), text, fill=col, font=font(12))
    d.rectangle([0, 0, Wimg, 26], fill=(0, 0, 0)); d.text((8, 5), title, fill=(255, 255, 255), font=font(14))
    im.save(out)
    return out


def parse_range(s):
    a, b = s.split(','); return float(a), float(b)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('view', choices=['plan', 'side', 'sidey'])
    ap.add_argument('--x'); ap.add_argument('--y'); ap.add_argument('--z')
    ap.add_argument('--line'); ap.add_argument('--band', type=float, default=1.5)
    ap.add_argument('--out', required=True); ap.add_argument('--title', default='')
    a = ap.parse_args(argv)
    D = G.Dungeon()
    line = None
    if a.line:
        j = json.load(open(a.line)); line = j['points'] if isinstance(j, dict) else j
    if a.view == 'plan':
        z = float(a.z); xr = parse_range(a.x); yr = parse_range(a.y)
        draw_section(D, a.out, [0, 0, z], [1, 0, 0], [0, 1, 0], xr, yr, line, a.band, a.title or f'plan z={z}')
    elif a.view == 'side':
        x = float(a.x); yr = parse_range(a.y); zr = parse_range(a.z)
        draw_section(D, a.out, [x, 0, 0], [0, 1, 0], [0, 0, 1], yr, zr, line, a.band, a.title or f'side x={x} (axis y north ->)')
    else:
        y = float(a.y); xr = parse_range(a.x); zr = parse_range(a.z)
        draw_section(D, a.out, [0, y, 0], [1, 0, 0], [0, 0, 1], xr, zr, line, a.band, a.title or f'side y={y} (axis x east ->)')


if __name__ == '__main__':
    main()
