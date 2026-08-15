import numpy as np, objlib, board as B
from PIL import Image, ImageDraw

OUT = '/mnt/wbterminal2/dat-patch-concepts-2026-08-14/'


def subdiv(V, F, n=1):
    V = np.asarray(V, dtype=np.float64)
    for _ in range(n):
        nv = [v for v in V]
        nf = []
        mid = {}
        def m(a, b):
            k = (min(a, b), max(a, b))
            if k not in mid:
                mid[k] = len(nv); nv.append((nv[a] + nv[b]) / 2)
            return mid[k]
        for t in F:
            a, b, c = t
            ab, bc, ca = m(a, b), m(b, c), m(c, a)
            nf += [(a, ab, ca), (ab, b, bc), (ca, bc, c), (ab, bc, ca)]
        V = np.array(nv); F = np.array(nf)
    return V, F


def displace(V, F, amp=0.02, seed=0):
    """Tiny pseudo-random normal displacement so a tessellated concept reads as relief."""
    rs = np.random.RandomState(seed)
    N = np.zeros_like(V)
    for t in F:
        a, b, c = V[t[0]], V[t[1]], V[t[2]]
        n = np.cross(b - a, c - a)
        for i in t:
            N[i] += n
    ln = np.linalg.norm(N, axis=1, keepdims=True); ln[ln == 0] = 1
    N = N / ln
    return V + N * (rs.rand(len(V), 1) - 0.5) * 2 * amp


def three_panel(im, d, imgs, y0=126, y1=706, x0=28, gap=12, wtot=1444):
    w = (wtot - gap * (len(imgs) - 1)) // len(imgs)
    for i, (img, lab, sub, col) in enumerate(imgs):
        x = x0 + i * (w + gap)
        inner = B.panel(d, (x, y0, x + w, y1), lab, sub, col)
        B.paste_render(im, img, inner, None, d)
    return w


def views(V, F, FM=None, size=(600, 640), yaw=38, pitch=18, **kw):
    fit = ((V.min(0) + V.max(0)) / 2, np.linalg.norm(V.max(0) - V.min(0)) / 2)
    return objlib.render(V, F, FM, size=size, yaw=np.radians(yaw), pitch=np.radians(pitch),
                         fit=fit, **kw)[0], fit
