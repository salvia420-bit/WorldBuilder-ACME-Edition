"""Minimal OBJ loader + z-buffer software renderer (numpy/PIL only).
Used to build concept boards for the dat-patch project.
"""
import numpy as np
from PIL import Image, ImageDraw


def load_obj(path):
    V = []
    VN = []
    F = []          # list of (i0,i1,i2) vertex indices (0-based)
    FM = []         # material name per face
    cur = "default"
    with open(path, "r", errors="replace") as fh:
        for line in fh:
            if line.startswith("v "):
                p = line.split()
                V.append((float(p[1]), float(p[2]), float(p[3])))
            elif line.startswith("vn "):
                p = line.split()
                VN.append((float(p[1]), float(p[2]), float(p[3])))
            elif line.startswith("usemtl"):
                cur = line.split(None, 1)[1].strip()
            elif line.startswith("f "):
                p = line.split()[1:]
                idx = []
                for tok in p:
                    a = tok.split("/")[0]
                    i = int(a)
                    idx.append(i - 1 if i > 0 else len(V) + i)
                for k in range(1, len(idx) - 1):
                    F.append((idx[0], idx[k], idx[k + 1]))
                    FM.append(cur)
    return np.array(V, dtype=np.float64), np.array(F, dtype=np.int64), FM


def bbox(V):
    return V.min(axis=0), V.max(axis=0)


def _rot(yaw, pitch):
    cy, sy = np.cos(yaw), np.sin(yaw)
    cp, sp = np.cos(pitch), np.sin(pitch)
    Ry = np.array([[cy, -sy, 0], [sy, cy, 0], [0, 0, 1]])       # about Z (AC up)
    Rp = np.array([[1, 0, 0], [0, cp, -sp], [0, sp, cp]])       # tilt
    return Rp @ Ry


def render(V, F, FM=None, size=(760, 620), yaw=np.radians(35), pitch=np.radians(22),
           bg=(24, 26, 32), matcolors=None, wire=False, wirecolor=(255, 255, 255),
           wire_alpha=0.35, light=(0.45, -0.6, 0.75), scale_pad=1.14,
           fit=None, base_color=(176, 174, 168), silhouette=False,
           highlight_faces=None, highlight_color=(255, 176, 60)):
    """Orthographic z-buffer render. AC convention: +Z up.
    fit: optional (center, radius) to lock framing across A/B renders."""
    W, H = size
    R = _rot(yaw, pitch)
    P = V @ R.T
    if fit is None:
        c = (V.min(axis=0) + V.max(axis=0)) / 2.0
        rad = np.linalg.norm(V.max(axis=0) - V.min(axis=0)) / 2.0
        fit = (c, rad)
    c, rad = fit
    cP = c @ R.T
    s = min(W, H) / (2.0 * rad * scale_pad)
    xs = (P[:, 0] - cP[0]) * s + W / 2.0
    ys = -(P[:, 2] - cP[2]) * s + H / 2.0
    zs = P[:, 1]                                     # depth (view axis)

    img = np.zeros((H, W, 3), dtype=np.float32)
    img[:, :] = np.array(bg, dtype=np.float32)
    zbuf = np.full((H, W), 1e18, dtype=np.float64)

    L = np.array(light, dtype=np.float64)
    L = L / np.linalg.norm(L)

    if matcolors is None:
        matcolors = {}

    order = np.argsort(-zs[F].mean(axis=1))  # far to near (painter assist)
    hl = set(highlight_faces or [])
    for fi in order:
        tri = F[fi]
        a, b, cc = V[tri[0]], V[tri[1]], V[tri[2]]
        n = np.cross(b - a, cc - a)
        ln = np.linalg.norm(n)
        if ln < 1e-12:
            continue
        n /= ln
        lam = abs(float(n @ L))
        shade = 0.22 + 0.78 * (lam ** 0.85)
        if silhouette:
            col = np.array(base_color, dtype=np.float64) * 1.0
        else:
            key = FM[fi] if FM else None
            col = np.array(matcolors.get(key, base_color), dtype=np.float64)
        if fi in hl:
            col = np.array(highlight_color, dtype=np.float64)
            shade = min(1.0, shade * 1.15 + 0.12)
        col = col * shade

        x = xs[tri]
        y = ys[tri]
        z = zs[tri]
        minx = max(int(np.floor(x.min())), 0)
        maxx = min(int(np.ceil(x.max())), W - 1)
        miny = max(int(np.floor(y.min())), 0)
        maxy = min(int(np.ceil(y.max())), H - 1)
        if minx > maxx or miny > maxy:
            continue
        gx, gy = np.meshgrid(np.arange(minx, maxx + 1), np.arange(miny, maxy + 1))
        px = gx + 0.5
        py = gy + 0.5
        d = ((y[1] - y[2]) * (x[0] - x[2]) + (x[2] - x[1]) * (y[0] - y[2]))
        if abs(d) < 1e-12:
            continue
        w0 = ((y[1] - y[2]) * (px - x[2]) + (x[2] - x[1]) * (py - y[2])) / d
        w1 = ((y[2] - y[0]) * (px - x[2]) + (x[0] - x[2]) * (py - y[2])) / d
        w2 = 1.0 - w0 - w1
        m = (w0 >= -1e-9) & (w1 >= -1e-9) & (w2 >= -1e-9)
        if not m.any():
            continue
        zz = w0 * z[0] + w1 * z[1] + w2 * z[2]
        sub = zbuf[miny:maxy + 1, minx:maxx + 1]
        upd = m & (zz < sub)
        if not upd.any():
            continue
        sub[upd] = zz[upd]
        zbuf[miny:maxy + 1, minx:maxx + 1] = sub
        tgt = img[miny:maxy + 1, minx:maxx + 1]
        tgt[upd] = col.astype(np.float32)
        img[miny:maxy + 1, minx:maxx + 1] = tgt

    out = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8))
    if wire:
        ov = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        dr = ImageDraw.Draw(ov)
        col = wirecolor + (int(255 * wire_alpha),)
        for tri in F:
            pts = [(xs[i], ys[i]) for i in tri]
            dr.line(pts + [pts[0]], fill=col, width=1)
        out = Image.alpha_composite(out.convert("RGBA"), ov).convert("RGB")
    return out, (xs, ys, fit)


def project(V, size, yaw, pitch, fit):
    W, H = size
    R = _rot(yaw, pitch)
    P = V @ R.T
    c, rad = fit
    cP = c @ R.T
    s = min(W, H) / (2.0 * rad * 1.14)
    xs = (P[:, 0] - cP[0]) * s + W / 2.0
    ys = -(P[:, 2] - cP[2]) * s + H / 2.0
    return xs, ys
