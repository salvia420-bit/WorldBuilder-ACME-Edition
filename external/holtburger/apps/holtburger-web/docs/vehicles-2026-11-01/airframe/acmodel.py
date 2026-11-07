#!/usr/bin/env python3
"""Offline AC model tool: Setup/GfxObj -> triangles with per-surface average colour, bbox report, and a
flat-shaded z-buffer render of a composite (parts placed by offset / quaternion / scale) from several views.
Reads ~/ac_base_dats/client_portal.dat read-only through tools/dat-patch/datlib.py."""
import io
import json
import math
import struct
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

HERE_ = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE_.parents[6] / "tools" / "dat-patch"))  # .../WorldBuilder-ACME-Edition/tools/dat-patch
from datlib import Dat, R, parse_setup, _vertex_array, _poly, _bsp  # noqa: E402

PORTAL = "/home/wbterminal/ac_base_dats/client_portal.dat"
_dat = None


def dat():
    global _dat
    if _dat is None:
        _dat = Dat(PORTAL)
    return _dat


def cu32(b, o):
    b0 = b[o]
    if not (b0 & 0x80):
        return b0, o + 1
    b1 = b[o + 1]
    if not (b0 & 0x40):
        return ((b0 & 0x7F) << 8) | b1, o + 2
    s = struct.unpack_from("<H", b, o + 2)[0]
    return ((((b0 & 0x3F) << 8) | b1) << 16) | s, o + 4


def parse_gfxobj(did):
    b = dat().get(did)
    if b is None:
        raise KeyError(hex(did))
    r = R(b)
    _id = r.u32()
    flags = r.u32()
    n, r.o = cu32(b, r.o)
    surfaces = [r.u32() for _ in range(n)]
    P, N, UV, idx = _vertex_array(r)
    if flags & 1:
        npp, r.o = cu32(b, r.o)
        for _ in range(npp):
            r.o += 2
            _poly(r)
        _bsp(r, "physics")
    r.o += 12  # sort centre
    polys = []
    if flags & 2:
        npl, r.o = cu32(b, r.o)
        for _ in range(npl):
            r.o += 2
            polys.append(_poly(r))
    tris = []
    for p in polys:
        vs = [idx.get(v, v) for v in p["v"]]
        si = p["pos"] if p["pos"] >= 0 else p["neg"]
        sid = surfaces[si] if 0 <= si < len(surfaces) else 0
        for k in range(1, len(vs) - 1):
            tris.append((vs[0], vs[k], vs[k + 1], sid))
    return {"P": np.array(P, dtype=np.float64), "tris": tris, "surfaces": surfaces}


_colour_cache = {}


def _decode_avg(tex):
    b = dat().get(tex)
    if b is None:
        return None
    _id, _unk, w, h, fmt, ln = struct.unpack_from("<IiiiIi", b, 0)
    data = b[24:24 + ln]
    try:
        if fmt in (0x31545844, 0x33545844, 0x35545844):  # DXT1/3/5
            four = {0x31545844: b"DXT1", 0x33545844: b"DXT3", 0x35545844: b"DXT5"}[fmt]
            hdr = struct.pack("<4sIIIIIII44sIIIIIIIII16s", b"DDS ", 124, 0x1007, h, w, len(data), 0, 1, b"\0" * 44,
                              32, 4, four, 0, 0, 0, 0, 0, 0x1000, b"\0" * 16)
            im = Image.open(io.BytesIO(hdr + data)).convert("RGBA")
            a = np.asarray(im, dtype=np.float64)
        elif fmt == 500:  # 0x1F4 JPEG
            im = Image.open(io.BytesIO(data)).convert("RGBA")
            a = np.asarray(im, dtype=np.float64)
        elif fmt in (20, 0xF3):
            a = np.frombuffer(data[: w * h * 3], dtype=np.uint8).reshape(-1, 3)[:, ::-1].astype(np.float64)
            a = np.concatenate([a, np.full((a.shape[0], 1), 255.0)], 1)
        elif fmt in (21, 22):
            a = np.frombuffer(data[: w * h * 4], dtype=np.uint8).reshape(-1, 4)[:, [2, 1, 0, 3]].astype(np.float64)
            if fmt == 22:
                a[:, 3] = 255
        elif fmt == 23:
            v = np.frombuffer(data[: w * h * 2], dtype="<u2").astype(np.int64)
            a = np.stack([((v >> 11) & 31) * 255 / 31, ((v >> 5) & 63) * 255 / 63, (v & 31) * 255 / 31, np.full_like(v, 255)], 1).astype(np.float64)
        elif fmt == 26:
            v = np.frombuffer(data[: w * h * 2], dtype="<u2").astype(np.int64)
            a = np.stack([((v >> 8) & 15) * 17, ((v >> 4) & 15) * 17, (v & 15) * 17, ((v >> 12) & 15) * 17], 1).astype(np.float64)
        elif fmt in (41, 101):
            pal_id = struct.unpack_from("<I", b, 24 + ln)[0]
            pb = dat().get(pal_id)
            cnt = struct.unpack_from("<i", pb, 4)[0]
            pal = np.frombuffer(pb[8:8 + 4 * cnt], dtype="<u4").astype(np.int64)
            if fmt == 41:
                ix = np.frombuffer(data[: w * h], dtype=np.uint8).astype(np.int64)
            else:
                ix = np.frombuffer(data[: w * h * 2], dtype="<u2").astype(np.int64)
            c = pal[np.clip(ix, 0, len(pal) - 1)]
            a = np.stack([(c >> 16) & 255, (c >> 8) & 255, c & 255, (c >> 24) & 255], 1).astype(np.float64)
        else:
            return None
        a = a.reshape(-1, 4)
        m = a[:, 3] > 32
        if not m.any():
            return None
        return tuple((a[m, :3].mean(0) / 255.0).tolist())
    except Exception:
        return None


def surface_colour(sid):
    if sid in _colour_cache:
        return _colour_cache[sid]
    col = (0.6, 0.6, 0.6)
    b = dat().get(sid)
    if b is not None:
        t = struct.unpack_from("<I", b, 0)[0]
        if t & 6:
            st = struct.unpack_from("<I", b, 4)[0]
            sb = dat().get(st)
            if sb is not None:
                n = struct.unpack_from("<i", sb, 9)[0]
                ids = struct.unpack_from("<%dI" % n, sb, 13) if n > 0 else ()
                for tex in ids:
                    c = _decode_avg(tex)
                    if c:
                        col = c
                        break
        else:
            v = struct.unpack_from("<I", b, 4)[0]
            col = (((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255)
    _colour_cache[sid] = col
    return col


def qrot(q, v):
    w, x, y, z = q
    # v' = q v q*
    vx, vy, vz = v[..., 0], v[..., 1], v[..., 2]
    tx = 2 * (y * vz - z * vy)
    ty = 2 * (z * vx - x * vz)
    tz = 2 * (x * vy - y * vx)
    return np.stack([vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)], -1)


def qmul(a, b):
    aw, ax, ay, az = a
    bw, bx, by, bz = b
    return (aw * bw - ax * bx - ay * by - az * bz, aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw)


def model_tris(did):
    """[(P (n,3) in model frame, tris)] for a Setup (placement 0x65 / 0 / first) or a GfxObj."""
    if (did >> 24) == 0x01:
        g = parse_gfxobj(did)
        return [(g["P"], g["tris"])]
    s = parse_setup(dat().get(did))
    fr = s["frames"].get(0x65) or s["frames"].get(0) or (next(iter(s["frames"].values())) if s["frames"] else None)
    out = []
    for i, part in enumerate(s["parts"]):
        try:
            g = parse_gfxobj(part)
        except Exception:
            continue
        P = g["P"].copy()
        if "scale" in s:
            P = P * np.array(s["scale"][i])
        if fr:
            (o, q) = fr[i]
            P = qrot(q, P) + np.array(o)
            # parent chain ignored (statics / items rarely use it)
        out.append((P, g["tris"]))
    return out


def bbox(did):
    pts = np.concatenate([P for P, _ in model_tris(did)]) if model_tris(did) else np.zeros((1, 3))
    return pts.min(0), pts.max(0)


def composite(parts):
    """parts: [{did, offset:[x,y,z], rot:[w,x,y,z], scale:s|[sx,sy,sz], pre:[w,x,y,z]?}] -> (V (n,3), F (m,3), C (m,3))."""
    V, F, C = [], [], []
    base = 0
    for p in parts:
        sc = p.get("scale", 1.0)
        sc = np.array(sc if isinstance(sc, (list, tuple)) else [sc] * 3, dtype=np.float64)
        q = p.get("rot", [1, 0, 0, 0])
        for P, tris in model_tris(p["did"]):
            Q = qrot(q, P * sc) + np.array(p.get("offset", [0, 0, 0]))
            V.append(Q)
            for (a, b_, c, sid) in tris:
                F.append((a + base, b_ + base, c + base))
                C.append(p.get("tint") or surface_colour(sid))
            base += len(Q)
    if not V:
        return np.zeros((0, 3)), np.zeros((0, 3), int), np.zeros((0, 3))
    return np.concatenate(V), np.array(F, dtype=np.int64), np.array(C, dtype=np.float64)


def render(V, F, C, view, size=420, extent=None, bg=(0.55, 0.68, 0.85)):
    """Orthographic flat-shaded render. view: 'side' (look +x→ from the right: y right, z up), 'top', 'front', 'iso'."""
    light = np.array([0.4, -0.5, 0.75]); light /= np.linalg.norm(light)
    if view == "side":       # from +x looking -x: screen x = -y? use y forward to the left
        M = np.array([[0, -1, 0], [0, 0, 1], [1, 0, 0]], dtype=np.float64)
    elif view == "top":
        M = np.array([[1, 0, 0], [0, 1, 0], [0, 0, 1]], dtype=np.float64)
    elif view == "front":    # from +y looking back at the nose
        M = np.array([[-1, 0, 0], [0, 0, 1], [0, 1, 0]], dtype=np.float64)
    else:                    # iso: from front-right-above
        az, el = math.radians(35), math.radians(25)
        # camera looking along d; build basis
        d = np.array([-math.sin(az) * math.cos(el), -math.cos(az) * math.cos(el), -math.sin(el)])
        d = -d  # direction from target to eye
        right = np.cross([0, 0, 1], d); right /= np.linalg.norm(right)
        up = np.cross(d, right)
        M = np.stack([-right, up, d])
    S = V @ M.T
    if extent is None:
        lo, hi = S[:, :2].min(0), S[:, :2].max(0)
    else:
        lo, hi = np.array(extent[0]), np.array(extent[1])
    span = max(hi[0] - lo[0], hi[1] - lo[1]) * 1.08 + 1e-6
    ctr = (lo + hi) / 2
    px = (S[:, 0] - ctr[0]) / span * size + size / 2
    py = size / 2 - (S[:, 1] - ctr[1]) / span * size
    zb = np.full((size, size), -1e18)
    img = np.ones((size, size, 3)) * np.array(bg)
    tri = F
    n = np.cross(V[tri[:, 1]] - V[tri[:, 0]], V[tri[:, 2]] - V[tri[:, 0]])
    nl = np.linalg.norm(n, axis=1, keepdims=True) + 1e-12
    n = n / nl
    shade = 0.35 + 0.65 * np.abs(n @ light)
    for i in range(len(tri)):
        a, b_, c = tri[i]
        xs = np.array([px[a], px[b_], px[c]]); ys = np.array([py[a], py[b_], py[c]]); zs = np.array([S[a, 2], S[b_, 2], S[c, 2]])
        x0, x1 = int(max(0, math.floor(xs.min()))), int(min(size - 1, math.ceil(xs.max())))
        y0, y1 = int(max(0, math.floor(ys.min()))), int(min(size - 1, math.ceil(ys.max())))
        if x1 < x0 or y1 < y0:
            continue
        gx, gy = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
        d = (ys[1] - ys[2]) * (xs[0] - xs[2]) + (xs[2] - xs[1]) * (ys[0] - ys[2])
        if abs(d) < 1e-9:
            continue
        w0 = ((ys[1] - ys[2]) * (gx - xs[2]) + (xs[2] - xs[1]) * (gy - ys[2])) / d
        w1 = ((ys[2] - ys[0]) * (gx - xs[2]) + (xs[0] - xs[2]) * (gy - ys[2])) / d
        w2 = 1 - w0 - w1
        m = (w0 >= -1e-6) & (w1 >= -1e-6) & (w2 >= -1e-6)
        if not m.any():
            continue
        z = w0 * zs[0] + w1 * zs[1] + w2 * zs[2]
        sub = zb[y0:y1 + 1, x0:x1 + 1]
        m &= z > sub
        sub[m] = z[m]
        img[y0:y1 + 1, x0:x1 + 1][m] = np.clip(np.array(C[i]) * shade[i] * 1.25, 0, 1)
    return Image.fromarray((img * 255).astype(np.uint8))


def sheet(parts, out, views=("iso", "side", "top", "front"), size=420, title=None):
    V, F, C = composite(parts)
    ims = [render(V, F, C, v, size) for v in views]
    W = Image.new("RGB", (size * len(ims), size + 18), (30, 30, 30))
    for i, im in enumerate(ims):
        W.paste(im, (i * size, 18))
    d = ImageDraw.Draw(W)
    lo, hi = V.min(0), V.max(0)
    d.text((4, 2), (title or "") + "  bbox x %.2f..%.2f y %.2f..%.2f z %.2f..%.2f  tris %d" % (lo[0], hi[0], lo[1], hi[1], lo[2], hi[2], len(F)), fill=(255, 255, 255))
    W.save(out)
    return lo, hi


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "bbox":
        for a in sys.argv[2:]:
            did = int(a, 16)
            try:
                lo, hi = bbox(did)
                print("0x%08X  x %.3f..%.3f  y %.3f..%.3f  z %.3f..%.3f  size %.2f x %.2f x %.2f" % (did, lo[0], hi[0], lo[1], hi[1], lo[2], hi[2], *(hi - lo)))
            except Exception as e:
                print("0x%08X  ERR %s" % (did, e))
    elif cmd == "sheet":
        parts = json.load(open(sys.argv[2]))
        sheet(parts, sys.argv[3], title=Path(sys.argv[2]).stem)
    elif cmd == "one":
        for a in sys.argv[3:]:
            did = int(a, 16)
            sheet([{"did": did}], f"{sys.argv[2]}/m_{did:08x}.png", title=hex(did))
