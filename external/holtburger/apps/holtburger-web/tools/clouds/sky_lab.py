#!/usr/bin/env python3
"""tools/clouds/sky_lab.py — offline CPU proxy of the takram cloud layers, seen from the ground.

WHY: the laptop's headless Chromium is SwiftShader, whose 3D-texture sampling silently returns zero, so the real
cloud raymarch cannot be rendered here (cloud_render_test.html); real-shader eyes are the GTX 1070 only. This lab
reproduces the per-layer DENSITY math of vendor/takram-three-clouds/src/shaders/clouds.glsl exactly (sampleWeather:
weather^exponent, the shape-altering semicircle, the Skybolt coverage remap; sampleMedia: shape erosion, the shape-
detail step — which DOUBLES the density of a layer whose shapeDetailAmount is 0 —, the density profile and scale;
extinction = density, scattering 1, absorption 0) on the real assets (a weather map PNG, shape.bin, shape_detail.bin),
including the weather-map mip level that grey-averages a fine pattern toward the horizon. Lighting is SIMPLIFIED
(single scattering toward the sun + a dual-lobe HG phase + octave multiple scattering + powder + a flat sky ambient +
a distance haze): use it to judge coverage, opacity, structure and the horizon band, NOT colour — the 1070 decides.

  python3 tools/clouds/sky_lab.py --map=assets/clouds/local_weather.png --layers=v1 --out=/tmp/v1.png
  python3 tools/clouds/sky_lab.py --map=assets/clouds/local_weather_v2.png --layers=v2 --coverage=0.3 --out=/tmp/v2.png

The layer specs are read from scene3d/cloud_storm_look.js (FAIR_LAYERS / FAIR_LAYERS_V2) so the lab always renders
what the client ships. Output: one PNG strip of three views (up 55°, mid 20°, horizon 6°) + printed per-layer stats.
"""
import argparse
import json
import math
import os
import re
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
HB = os.path.dirname(os.path.dirname(HERE))
EARTH_R = 6_360_000.0
TILE_M = 2 * math.pi * EARTH_R / 4 / 100  # localWeatherRepeat 100 per cube-sphere face edge (~100 km)
SHAPE_REPEAT = 0.0003  # takram defaults (CloudsEffect.ts)
DETAIL_REPEAT = 0.006
DEFAULT_PROFILE = dict(expTerm=0.0, exponent=0.0, linearTerm=0.75, constantTerm=0.25)


def load_layers(which):
    """FAIR_LAYERS (v1) or FAIR_LAYERS_V2 (v2) from scene3d/cloud_storm_look.js (a JS array of object literals)."""
    src = open(os.path.join(HB, "scene3d", "cloud_storm_look.js"), encoding="utf8").read()
    name = "FAIR_LAYERS" if which == "v1" else "FAIR_LAYERS_V2"
    m = re.search(r"export const " + name + r"\s*=\s*(?:Object\.freeze\()?\[(.*?)\n\]", src, re.S)
    if not m:
        sys.exit(f"sky_lab: {name} not found in cloud_storm_look.js")
    body = re.sub(r"//[^\n]*", "", m.group(1))
    body = re.sub(r"([{,]\s*)([A-Za-z_]\w*)\s*:", r'\1"\2":', body)
    body = body.replace("'", '"')
    body = re.sub(r",\s*([}\]])", r"\1", body)
    return json.loads("[" + body.strip().rstrip(",") + "]")


def load_noise(name, n):
    a = np.fromfile(os.path.join(HB, "assets", "clouds", name), dtype=np.uint8).astype(np.float32) / 255.0
    return a.reshape(n, n, n)  # [z][y][x], x fastest (Data3DTexture order)


def trilinear(vol, p):
    n = vol.shape[0]
    q = p * n - 0.5
    i0 = np.floor(q).astype(np.int64)
    f = q - i0
    i0 %= n
    i1 = (i0 + 1) % n
    x0, y0, z0 = i0[..., 0], i0[..., 1], i0[..., 2]
    x1, y1, z1 = i1[..., 0], i1[..., 1], i1[..., 2]
    fx, fy, fz = f[..., 0], f[..., 1], f[..., 2]
    c = lambda z, y, x: vol[z, y, x]
    c00 = c(z0, y0, x0) * (1 - fx) + c(z0, y0, x1) * fx
    c01 = c(z0, y1, x0) * (1 - fx) + c(z0, y1, x1) * fx
    c10 = c(z1, y0, x0) * (1 - fx) + c(z1, y0, x1) * fx
    c11 = c(z1, y1, x0) * (1 - fx) + c(z1, y1, x1) * fx
    return (c00 * (1 - fy) + c01 * fy) * (1 - fz) + (c10 * (1 - fy) + c11 * fy) * fz


def mip_pyramid(img):
    levels = [img]
    while levels[-1].shape[0] > 1:
        a = levels[-1]
        levels.append(0.25 * (a[0::2, 0::2] + a[1::2, 0::2] + a[0::2, 1::2] + a[1::2, 1::2]))
    return levels


def bilinear2(img, u, v):
    h, w = img.shape[:2]
    x = u * w - 0.5
    y = v * h - 0.5
    x0 = np.floor(x).astype(np.int64)
    y0 = np.floor(y).astype(np.int64)
    fx = (x - x0)[..., None]
    fy = (y - y0)[..., None]
    x0 %= w
    y0 %= h
    x1 = (x0 + 1) % w
    y1 = (y0 + 1) % h
    return (img[y0, x0] * (1 - fx) + img[y0, x1] * fx) * (1 - fy) + (img[y1, x0] * (1 - fx) + img[y1, x1] * fx) * fy


def sample_weather(pyr, u, v, mip):
    """Trilinear-in-mip sample of the RGBA weather pyramid (mip per sample)."""
    mip = np.clip(mip, 0, len(pyr) - 1)
    m0 = np.floor(mip).astype(np.int64)
    fm = (mip - m0)[..., None]
    out = np.zeros(u.shape + (4,), np.float32)
    for lv in np.unique(m0):
        sel = m0 == lv
        a = bilinear2(pyr[lv], u[sel], v[sel])
        b = bilinear2(pyr[min(lv + 1, len(pyr) - 1)], u[sel], v[sel])
        out[sel] = a * (1 - fm[sel]) + b * fm[sel]
    return out


def remap_clamped(x, a, b):
    return np.clip((x - a) / np.maximum(b - a, 1e-6), 0.0, 1.0)


class Layers:
    def __init__(self, specs, coverage):
        ch = {"r": 0, "g": 1, "b": 2, "a": 3}
        self.n = len(specs)
        self.chan = np.array([ch[s.get("channel", "r")] for s in specs])
        g = lambda k, d: np.array([float(s.get(k, d)) for s in specs], np.float32)
        self.alt = g("altitude", 0)
        self.height = g("height", 0)
        self.scale = g("densityScale", 0)
        self.shape_amt = g("shapeAmount", 1)
        self.detail_amt = g("shapeDetailAmount", 1)
        self.wexp = g("weatherExponent", 1)
        self.bias = g("shapeAlteringBias", 0.35)
        self.cfw = g("coverageFilterWidth", 0.6)
        prof = [dict(DEFAULT_PROFILE, **(s.get("densityProfile") or {})) for s in specs]
        self.p_exp = np.array([p["expTerm"] for p in prof], np.float32)
        self.p_e = np.array([p["exponent"] for p in prof], np.float32)
        self.p_lin = np.array([p["linearTerm"] for p in prof], np.float32)
        self.p_const = np.array([p["constantTerm"] for p in prof], np.float32)
        self.coverage = coverage


def density(L, pyr, shape, detail, pos, alt, mip_w, detail_on):
    """Per-layer density (… × nL) at world points pos (… × 3, metres, z up) and altitude alt (…)."""
    u = pos[..., 0] / TILE_M
    v = pos[..., 1] / TILE_M
    w4 = sample_weather(pyr, u, v, mip_w)  # … × 4
    w = np.take_along_axis(w4, np.broadcast_to(L.chan, w4.shape[:-1] + (L.n,)), axis=-1)
    hf = remap_clamped(alt[..., None], L.alt, L.alt + np.maximum(L.height, 1e-3))
    inside = (alt[..., None] >= L.alt) & (alt[..., None] <= L.alt + L.height) & (L.height > 0)
    w = np.power(np.clip(w, 0, 1), L.wexp)
    x = np.clip(np.power(hf, L.bias) * 2 - 1, -1, 1)
    hs = 1 - x * x
    factor = 1 - L.coverage * hs
    d = remap_clamped(w * (1 - L.cfw) + L.cfw, factor, factor + L.cfw)
    s = trilinear(shape, pos * SHAPE_REPEAT)[..., None]
    d = remap_clamped(d, (1 - s) * L.shape_amt, np.ones_like(d))
    det = trilinear(detail, pos * DETAIL_REPEAT)[..., None]
    mod = np.where(remap_clamped(hf, 0.2, 0.4) > 0.5, 1 - det, det ** 6)
    mod = mod * L.detail_amt
    dd = remap_clamped(d * 2, mod * 0.5, np.ones_like(d))
    d = np.where(detail_on[..., None], dd, d)
    prof = L.p_exp * np.exp(L.p_e * hf) + L.p_lin * hf + L.p_const
    d = np.clip(d * L.scale * prof, 0, 1)
    return np.where(inside, d, 0.0)


def hg(c, g):
    return (1 - g * g) / (4 * math.pi * np.power(1 + g * g - 2 * g * c, 1.5))


def render(L, pyr, shape, detail, width, height, fov_deg, elev_deg, az_deg, sun_elev, sun_az, eye_alt=100.0, steps=24, sun_steps=3):
    yaw, pitch = math.radians(az_deg), math.radians(elev_deg)
    fwd = np.array([math.sin(yaw) * math.cos(pitch), math.cos(yaw) * math.cos(pitch), math.sin(pitch)])
    right = np.array([math.cos(yaw), -math.sin(yaw), 0.0])
    up = np.cross(right, fwd)
    tan = math.tan(math.radians(fov_deg) / 2)
    xs = (np.arange(width) + 0.5) / width * 2 - 1
    ys = 1 - (np.arange(height) + 0.5) / height * 2
    X, Y = np.meshgrid(xs * tan, ys * tan * height / width)
    d = fwd + X[..., None] * right + Y[..., None] * up
    d /= np.linalg.norm(d, axis=-1, keepdims=True)
    sun = np.array([math.sin(math.radians(sun_az)) * math.cos(math.radians(sun_elev)),
                    math.cos(math.radians(sun_az)) * math.cos(math.radians(sun_elev)), math.sin(math.radians(sun_elev))])
    pix = 2 * tan / width  # radians per pixel (approx)
    # Sky background.
    el = np.clip(d[..., 2], 0, 1)
    sky = np.array([0.80, 0.86, 0.95]) * (1 - el[..., None]) ** 3 + np.array([0.28, 0.46, 0.86]) * (1 - (1 - el[..., None]) ** 3)
    cs = (d @ sun)
    sky = sky + np.array([1.0, 0.92, 0.8]) * (0.6 * np.exp((cs - 1) * 60) + 0.12 * np.exp((cs - 1) * 4))[..., None]
    col = np.zeros(d.shape, np.float32)
    trans = np.ones(d.shape[:2], np.float32)
    o = np.array([0.0, 0.0, EARTH_R + eye_alt])
    lo = float(np.min(L.alt[L.height > 0]))
    hi = float(np.max((L.alt + L.height)[L.height > 0]))
    # Slabs: merge overlapping layers so every point is marched once with the shader's summed density.
    spans = sorted([(float(a), float(a + h)) for a, h in zip(L.alt, L.height) if h > 0])
    slabs = []
    for a, b in spans:
        if slabs and a <= slabs[-1][1]:
            slabs[-1][1] = max(slabs[-1][1], b)
        else:
            slabs.append([a, b])
    sun_col = np.array([1.0, 0.95, 0.85]) * 4.0
    amb_col = np.array([0.45, 0.55, 0.75]) * 0.9
    for a, b in slabs:
        def hit(r):
            bq = d @ o
            c = o @ o - r * r
            disc = bq * bq - c
            return -bq + np.sqrt(np.maximum(disc, 0))
        t0 = hit(EARTH_R + a)
        t1 = hit(EARTH_R + b)
        t1 = np.minimum(t1, t0 + 60_000.0)
        dt = (t1 - t0) / steps
        for i in range(steps):
            t = t0 + (i + 0.5) * dt
            p = o + d * t[..., None]
            r = np.linalg.norm(p, axis=-1)
            alt = r - EARTH_R
            pw = p[..., :2].copy()
            # Weather mip: texels per pixel of the footprint on the layer (grazing stretch by 1/|cos incidence|).
            nrm = p / r[..., None]
            cosi = np.clip(np.abs(np.sum(d * nrm, -1)), 0.05, 1)
            tpp = (t * pix / cosi) / (TILE_M / 512)
            mip = np.maximum(0, 0.5 * np.log2(np.maximum(1, tpp * tpp * 0.1)))
            pos = np.stack([pw[..., 0], pw[..., 1], alt], -1)
            dens = density(L, pyr, shape, detail, pos, alt, mip, mip < 1.0)
            ext = dens.sum(-1)
            if not np.any(ext > 1e-6):
                continue
            # Light: march toward the sun through this slab.
            tl = np.ones_like(ext)
            od = np.zeros_like(ext)
            for k in range(sun_steps):
                ds = 60.0 * (4 ** k)  # 60, 240, 960 m: near self-shadowing first, then the layer's depth
                q = pos + sun * ds
                od += density(L, pyr, shape, detail, q, q[..., 2], mip, mip < 1.0).sum(-1) * ds * 0.75
            phase = 0.5 * hg(cs, 0.7) + 0.5 * hg(cs, -0.2)
            sc = np.zeros(ext.shape + (3,), np.float32)
            aa, bb, cc = 1.0, 1.0, 1.0
            for _ in range(4):
                ph = 0.5 * hg(cs, 0.7 * cc) + 0.5 * hg(cs, -0.2 * cc)
                sc += (aa * np.exp(-od * bb) * ph)[..., None] * sun_col
                aa *= 0.5; bb *= 0.5; cc *= 0.5
            powder = 1 - 0.8 * np.exp(-ext * 150)
            src = (sc + amb_col * (0.25 + 0.75 * np.clip((alt - lo) / max(hi - lo, 1), 0, 1))[..., None]) * powder[..., None]
            stepT = np.exp(-ext * dt)
            integ = np.where(ext > 1e-7, (1 - stepT) / np.maximum(ext, 1e-7), dt)
            haze = np.exp(-t / 45_000.0)[..., None]
            c = src * haze + np.array([0.80, 0.86, 0.95]) * (1 - haze)
            col += (trans * ext * integ)[..., None] * c
            trans *= stepT
    out = col + sky * trans[..., None]
    out = out / (1 + out)  # Reinhard
    out = np.power(np.clip(out * 1.6, 0, 1), 1 / 2.2)
    return (out * 255).astype(np.uint8), trans


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--map", default=os.path.join(HB, "assets", "clouds", "local_weather.png"))
    ap.add_argument("--layers", default="v1", choices=["v1", "v2"])
    ap.add_argument("--only", default="", help="comma list of channels to keep (e.g. a,b) — isolates layers")
    ap.add_argument("--coverage", type=float, default=0.5)
    ap.add_argument("--width", type=int, default=320)
    ap.add_argument("--offset", type=float, default=0.0, help="weather offset in tiles (shifts the pattern)")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    specs = load_layers(a.layers)
    if a.only:
        keep = set(a.only.split(","))
        specs = [s if s.get("channel") in keep else dict(s, height=0) for s in specs]
    L = Layers(specs, a.coverage)
    img = np.asarray(Image.open(a.map).convert("RGBA"), np.float32) / 255.0
    if a.offset:
        k = int(a.offset * img.shape[0])
        img = np.roll(img, (k, k), (0, 1))
    pyr = mip_pyramid(img)
    shape = load_noise("shape.bin", 128)
    detail = load_noise("shape_detail.bin", 32)
    w, h = a.width, int(a.width * 9 / 16)
    views = [(55, 300), (20, 300), (6, 140)]
    tiles = []
    for el, az in views:
        im, tr = render(L, pyr, shape, detail, w, h, 75, el, az, sun_elev=25, sun_az=110)
        tiles.append(im)
        print(f"view elev {el:>2} az {az:>3}: sky cloud-covered (transmittance < 0.5) {100 * np.mean(tr < 0.5):.0f}%  mean transmittance {np.mean(tr):.2f}")
    strip = np.concatenate([np.pad(t, ((0, 0), (0, 6), (0, 0)), constant_values=255) for t in tiles], 1)
    Image.fromarray(strip).save(a.out)
    print("wrote", a.out)


if __name__ == "__main__":
    main()
