"""render3.py -- textured Gouraud software renderer.

Round 1 rendered flat-shaded and untextured, which is exactly why "10x
triangles" looked like nothing: under Gouraud the picture is a function of the
NORMALS and the TEXTURE, and displacement only reaches the eye through those.
This renderer does what the retail fixed-function pipeline does:

    per-vertex  I = ambient + diffuse * max(0, N.L)      (Gouraud, interpolated)
    per-pixel   C = texture(u, v) * I

Orthographic, so linear interpolation of uv/intensity is exact (no perspective
divide needed).  +Z is up (AC convention), depth along the view axis.
"""
import numpy as np
from PIL import Image, ImageDraw


def rot(yaw, pitch):
    cy, sy = np.cos(yaw), np.sin(yaw)
    cp, sp = np.cos(pitch), np.sin(pitch)
    Ry = np.array([[cy, -sy, 0], [sy, cy, 0], [0, 0, 1]])
    Rp = np.array([[1, 0, 0], [0, cp, -sp], [0, sp, cp]])
    return Rp @ Ry


def fit_of(V, pad=1.0):
    c = (V.min(axis=0) + V.max(axis=0)) / 2.0
    rad = np.linalg.norm(V.max(axis=0) - V.min(axis=0)) / 2.0 * pad
    return (c, max(rad, 1e-6))


def sample(tex, u, v, wrap=True):
    """Bilinear sample of an (H,W,4) float array at float uv arrays."""
    H, W = tex.shape[:2]
    x = np.mod(u, 1.0) * W - 0.5
    y = np.mod(v, 1.0) * H - 0.5
    x0 = np.floor(x).astype(np.int64)
    y0 = np.floor(y).astype(np.int64)
    fx = (x - x0)[..., None]
    fy = (y - y0)[..., None]
    x0m = np.mod(x0, W)
    y0m = np.mod(y0, H)
    x1m = np.mod(x0 + 1, W)
    y1m = np.mod(y0 + 1, H)
    c00 = tex[y0m, x0m]
    c10 = tex[y0m, x1m]
    c01 = tex[y1m, x0m]
    c11 = tex[y1m, x1m]
    return (c00 * (1 - fx) + c10 * fx) * (1 - fy) + (c01 * (1 - fx) + c11 * fx) * fy


def render(V, F, UV, NR, face_tex, textures, size=(760, 640), yaw=np.radians(35),
           pitch=np.radians(20), fit=None, light=(0.55, -0.72, 0.42),
           ambient=0.30, diffuse=0.95, bg=(16, 18, 24), wire=False,
           wire_alpha=0.30, wirecolor=(255, 255, 255), scale_pad=1.06,
           fill_light=None, fill_amt=0.18, alpha_test=None, flat=False,
           tint=None, gamma=1.0, cull=0,
           sun_color=None, fill_color=None, ambient_color=None, bg_grad=None,
           near=None, far=None):
    """V (n,3); F (m,3); UV (m,3,2); NR (m,3,3); face_tex (m,) key into
    `textures` (key -> (H,W,4) float array in [0,1], or None for untextured)."""
    W, H = size
    R = rot(yaw, pitch)
    P = V @ R.T
    if fit is None:
        fit = fit_of(V)
    c, rad = fit
    cP = np.asarray(c) @ R.T
    s = min(W, H) / (2.0 * rad * scale_pad)
    xs = (P[:, 0] - cP[0]) * s + W / 2.0
    ys = -(P[:, 2] - cP[2]) * s + H / 2.0
    zs = P[:, 1]

    img = np.zeros((H, W, 3), np.float32)
    if bg_grad is not None:
        top = np.array(bg_grad[0], np.float32) / 255.0
        bot = np.array(bg_grad[1], np.float32) / 255.0
        t = (np.arange(H, dtype=np.float32) / max(H - 1, 1))[:, None]
        img[:, :] = (top[None, :] * (1 - t) + bot[None, :] * t)[:, None, :]
    else:
        img[:, :] = np.array(bg, np.float32) / 255.0
    zbuf = np.full((H, W), 1e18)

    SUNC = np.array(sun_color if sun_color else (1.0, 1.0, 1.0), np.float32)
    FILC = np.array(fill_color if fill_color else (1.0, 1.0, 1.0), np.float32)
    AMBC = np.array(ambient_color if ambient_color else (1.0, 1.0, 1.0), np.float32)

    L = np.asarray(light, float)
    L = L / np.linalg.norm(L)
    L2 = None
    if fill_light is not None:
        L2 = np.asarray(fill_light, float)
        L2 = L2 / np.linalg.norm(L2)

    fwd = R.T @ np.array([0.0, 1.0, 0.0])      # camera forward, world space
    order = np.argsort(-zs[F].mean(axis=1))
    # Near clip.  The study renderer is orthographic with no frustum, so on a
    # close crop the eave/overhang BETWEEN the camera plane and the target wall
    # is drawn over it -- LADDER.md's "pale ghost wedge".  A perspective client
    # at eye height never sees that geometry; clipping everything nearer than
    # (target plane - near) reproduces what a player would actually see.
    near_cut = (float(cP[1]) - near) if near is not None else None
    far_cut = (float(cP[1]) + far) if far is not None else None

    for fi in order:
        tri = F[fi]
        if near_cut is not None and zs[tri].max() < near_cut:
            continue
        if far_cut is not None and zs[tri].min() > far_cut:
            continue
        if cull:
            a0, b0, c0 = V[tri[0]], V[tri[1]], V[tri[2]]
            fn = np.cross(b0 - a0, c0 - a0)
            if float(fn @ fwd) * cull > 0:
                continue
        x = xs[tri]
        y = ys[tri]
        z = zs[tri]
        minx = max(int(np.floor(x.min())), 0)
        maxx = min(int(np.ceil(x.max())), W - 1)
        miny = max(int(np.floor(y.min())), 0)
        maxy = min(int(np.ceil(y.max())), H - 1)
        if minx > maxx or miny > maxy:
            continue
        d = ((y[1] - y[2]) * (x[0] - x[2]) + (x[2] - x[1]) * (y[0] - y[2]))
        if abs(d) < 1e-12:
            continue
        gx, gy = np.meshgrid(np.arange(minx, maxx + 1), np.arange(miny, maxy + 1))
        px = gx + 0.5
        py = gy + 0.5
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

        n = NR[fi]
        if flat:
            a, b, cc = V[tri[0]], V[tri[1]], V[tri[2]]
            fn = np.cross(b - a, cc - a)
            ln = np.linalg.norm(fn)
            fn = fn / ln if ln > 1e-14 else np.array([0.0, 0.0, 1.0])
            n = np.stack([fn, fn, fn])
        nl = np.linalg.norm(n, axis=1, keepdims=True)
        nl[nl < 1e-12] = 1.0
        n = n / nl
        # per-vertex, per-channel intensity (3 verts, 3 channels)
        inten = (ambient * AMBC)[None, :] + \
            (diffuse * np.clip(n @ L, 0, None))[:, None] * SUNC[None, :]
        if L2 is not None:
            inten = inten + (fill_amt * np.clip(n @ L2, 0, None))[:, None] \
                * FILC[None, :]
        ii = (w0[..., None] * inten[0] + w1[..., None] * inten[1]
              + w2[..., None] * inten[2])

        key = face_tex[fi]
        tex = textures.get(key) if textures else None
        if tex is None:
            col = np.ones(list(ii.shape[:2]) + [3], np.float64) * 0.62
        else:
            uv = UV[fi]
            u = w0 * uv[0, 0] + w1 * uv[1, 0] + w2 * uv[2, 0]
            v = w0 * uv[0, 1] + w1 * uv[1, 1] + w2 * uv[2, 1]
            t = sample(tex, u, v)
            col = t[:, :, :3]
            if alpha_test and key in alpha_test:
                upd = upd & (t[:, :, 3] >= 0.5)
                if not upd.any():
                    continue
        if tint and key in tint:
            col = col * np.asarray(tint[key], float)
        px_col = np.clip(col * ii, 0, 1)
        sub[upd] = zz[upd]
        zbuf[miny:maxy + 1, minx:maxx + 1] = sub
        tgt = img[miny:maxy + 1, minx:maxx + 1]
        tgt[upd] = px_col[upd]
        img[miny:maxy + 1, minx:maxx + 1] = tgt

    if gamma != 1.0:
        img = np.clip(img, 0, 1) ** (1.0 / gamma)
    out = Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8))
    if wire:
        ov = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        dr = ImageDraw.Draw(ov)
        col = tuple(wirecolor) + (int(255 * wire_alpha),)
        for tri in F:
            pts = [(xs[i], ys[i]) for i in tri]
            dr.line(pts + [pts[0]], fill=col, width=1)
        out = Image.alpha_composite(out.convert("RGBA"), ov).convert("RGB")
    return out
