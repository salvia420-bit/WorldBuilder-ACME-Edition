#!/usr/bin/env python3
"""Tier-2 particle upgrade params (2026-10-10) for every emitter in the catalog.

Tier 1 (tier1.py) made the world react to the effects. Tier 2 changes the
sprites themselves, each emitter by its own numbers:

  stretch   velocity stretch (`?fxMotion`): the quad is lengthened along its
            screen-space velocity by |v| x 0.04 s x stretch — hit sparks,
            specks, water spray and streaks, blood droplets, debris
  shape     analytic sprite (`?fxShapes`) computed in the shader instead of
            sampling the texture: 1 star (crisp core, halo, diffraction
            spikes), 2 orb (crisp core, gaussian halo), 3 ring (the portal rim:
            a crisp ring with swirling arms)
  spikes    4 or 6 diffraction spikes on a star (6 on cool / white stars)
  bounce    restitution of the GPU spark children against the scene depth
            (the war-spell impact showcase): 0 = no bounce
  sprite    the analytic sprite's colour, ENERGY-MATCHED to the retail texture:
            the mean linear (rgb x a) of the texture over the quad, divided by
            the mean of the analytic profile — the same light, a crisper shape
  halo      the analytic halo falloff, from the texture's measured cover

Inputs: $PFX_WORK (datcat.py + enrich.py + features.py: emitters_ctx.json,
surface_features.json, thumbs/<surface>.png), data/particle-fx-catalog.json,
data/particle-fx-tier1.json (spark children).

  cd apps/holtburger-web/tools/particle-fx
  PFX_WORK=<work> python3 tier2.py            # -> ../../data/particle-fx-tier2.json
  cd ../.. && node scripts/gen-particle-fx-profiles.mjs

The analytic profiles here MIRROR scene3d/particles/particle_fx.js
(FRAG_MAP, `hbFxAnalytic`): change one, change the other (the node test checks
the constants agree).
"""
import json, math, os, re, sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.normpath(os.path.join(HERE, "..", ".."))
WORK = os.environ.get("PFX_WORK") or os.path.join(HERE, "work")
CATALOG = os.path.join(APP, "data", "particle-fx-catalog.json")
TIER1 = os.path.join(APP, "data", "particle-fx-tier1.json")
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(APP, "data", "particle-fx-tier2.json")

SHAPES = {"star": 1, "orb": 2, "ring": 3}
RANGE = dict(stretch=(0.0, 2.0), shape=(0, 3), spikes=(0, 6), bounce=(0.0, 0.6), halo=(0.0, 20.0),
             sprite=(0.0, 8.0))

# ---------------------------------------------------------------------------
# The analytic profiles (MIRROR of particle_fx.js `hbFxAnalytic`).
# ---------------------------------------------------------------------------
STAR_CORE_R = 0.07
ORB_CORE_R = 0.16
RING_R0 = 0.74
RING_W = 0.03
EDGE0 = 0.80


def _smooth(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def analytic(shape, spikes, halo, res=64):
    """Mean intensity of the analytic sprite over the unit quad (per channel)."""
    u = (np.arange(res) + 0.5) / res
    X, Y = np.meshgrid(u, u)
    px, py = X * 2.0 - 1.0, Y * 2.0 - 1.0
    r = np.hypot(px, py)
    fw = 2.0 / res
    edge = 1.0 - _smooth(EDGE0, 1.0, r)
    if shape == 1:
        core = 1.0 - _smooth(STAR_CORE_R - fw, STAR_CORE_R + fw, r)
        h = np.exp(-r * halo)
        m = max(1, spikes // 2)
        out = []
        for wk in (1.08, 1.0, 0.9):
            S = np.zeros_like(r)
            for i in range(m):
                a = i * math.pi / m
                ax, ay = math.cos(a), math.sin(a)
                al = np.abs(px * ax + py * ay)
                ac = np.abs(-px * ay + py * ax)
                w = (0.028 + 0.035 * al) * wk
                S = np.maximum(S, np.exp(-(ac * ac) / (w * w)) * np.maximum(1.0 - al, 0.0) ** 2)
            out.append(float(((1.6 * core + 0.75 * h + 0.85 * S) * edge).mean()))
        return out
    if shape == 2:
        core = 1.0 - _smooth(ORB_CORE_R - fw, ORB_CORE_R + fw, r)
        h = np.exp(-r * r * halo)
        v = float(((1.0 * core + 0.85 * h) * edge).mean())
        return [v, v, v]
    if shape == 3:
        d = np.abs(r - RING_R0)
        ring = 1.0 - _smooth(RING_W - fw, RING_W + fw, d)
        glow = np.exp(-d * halo)
        th = np.arctan2(py, px)
        arms = 0.62 + 0.38 * np.sin(5.0 * th + 6.0 * np.log(r + 0.06))
        inner = 0.10 * (1.0 - _smooth(RING_R0 - 0.1, RING_R0, r)) * (0.6 + 0.4 * arms)
        v = float(((1.35 * ring + 0.7 * glow * arms + inner) * edge).mean())
        return [v, v, v]
    return [1.0, 1.0, 1.0]


def _lin(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


_tex_cache = {}


def texture_energy(sid):
    """Mean LINEAR (rgb x a) over the whole quad — what the additive sprite adds."""
    if sid in _tex_cache:
        return _tex_cache[sid]
    p = os.path.join(WORK, "thumbs", f"{sid:08X}.png")
    e = None
    if os.path.exists(p):
        im = np.asarray(Image.open(p).convert("RGBA")).astype(np.float64) / 255.0
        rgb = _lin(im[:, :, :3])
        a = im[:, :, 3:4]
        e = [float(x) for x in (rgb * a).reshape(-1, 3).mean(axis=0)]
    _tex_cache[sid] = e
    return e


def clamp(v, lo, hi):
    return lo if v < lo else hi if v > hi else v


def r4(v):
    return round(float(v), 4)


# ---------------------------------------------------------------------------
# Family recipes.
# ---------------------------------------------------------------------------
# Velocity stretch per family; behaviours whose particles stand still carry
# none (the stretch is velocity-driven anyway, this keeps buff swirls round).
STRETCH = {
    "star": 1.0, "specks": 1.1, "water_streak": 1.0, "splash": 0.8, "liquid": 0.8, "blood": 1.0,
    "debris": 0.7, "solid_shard": 0.6, "solid_ball": 0.5, "streak": 0.6, "snow": 0.0,
}
MOVING = {"burst", "flash", "fountain", "stream", "trail", "puff", "implode"}
# The buff-swirl workhorses take the analytic shapes (stars spin and glint, orbs
# glow); a star that is THROWN (a hit spark) becomes a clean orb streak instead.
SHAPE_FAMILY = {"star": "star", "glow_orb": "orb", "glow_point": "orb"}
PORTAL_RIM = re.compile(r"portal rim layer|rim swirl", re.I)


def full_uv_quad(e):
    g = e.get("gfx") or {}
    ub = g.get("uvBounds") or [0, 0, 0, 0]
    return g.get("nVerts") == 4 and abs(ub[0]) < 1e-3 and abs(ub[1]) < 1e-3 and abs(ub[2] - 1) < 1e-3 and abs(ub[3] - 1) < 1e-3


def build(e, cat, t1, feats):
    fam = cat["family"]
    beh = cat["behavior"]
    out = {}
    if fam in ("misc", "none", "sky"):
        return out
    surf = e.get("surface") or {}
    additive = bool(surf.get("type", 0) & 0x10000)
    sid = (e.get("gfx") or {}).get("surfaces", [0])[0] if (e.get("gfx") or {}).get("surfaces") else 0
    ft = feats.get(hex(sid), {}) if sid else {}

    # ---- stretch --------------------------------------------------------------
    st = STRETCH.get(fam, 0.0)
    if st > 0 and beh in MOVING:
        if fam == "star" and beh not in ("burst", "flash", "fountain", "stream", "trail"):
            st = 0.0
        if st > 0:
            out["stretch"] = st

    # ---- analytic shape ----------------------------------------------------------
    kind = SHAPE_FAMILY.get(fam)
    if fam == "vortex" and PORTAL_RIM.search(cat.get("note") or ""):
        kind = "ring"
    if kind == "star" and out.get("stretch", 0) > 0:
        kind = "orb"                     # a streaking star reads as a clean line, not a smeared cross
    if kind and additive and full_uv_quad(e):
        energy = texture_energy(sid)
        if energy and max(energy) > 1e-4:
            cover = clamp(float(ft.get("cover", 0.3) or 0.3), 0.03, 0.95)
            shape = SHAPES[kind]
            spikes = 0
            if kind == "star":
                halo = clamp(2.85 / math.sqrt(cover), 3.0, 14.0)
                hue = float(ft.get("hue", 0.0) or 0.0)
                chroma = float(ft.get("chroma", 0.0) or 0.0)
                spikes = 6 if (chroma < 0.1 or 170.0 <= hue <= 280.0) else 4
            elif kind == "orb":
                halo = clamp(2.51 / cover, 2.5, 16.0)
            else:
                halo = 12.0
            m = analytic(shape, spikes, halo)
            sprite = [clamp(energy[i] / max(1e-5, m[i]), 0.0, 8.0) for i in range(3)]
            out["shape"] = shape
            if spikes:
                out["spikes"] = spikes
            out["halo"] = halo
            out["sprite"] = sprite

    # ---- spark bounce (the GPU spark children) ------------------------------------
    if (t1 or {}).get("kidKind") == 3:
        out["bounce"] = 0.35
    return out


def sanitize(p):
    q = {}
    for k, v in p.items():
        if k == "sprite":
            q[k] = [r4(clamp(x, *RANGE["sprite"])) for x in v]
            continue
        lo, hi = RANGE.get(k, (None, None))
        if k in ("shape", "spikes"):
            v = int(v)
        if lo is not None:
            v = clamp(v, lo, hi)
        q[k] = v if isinstance(v, int) else r4(v)
    if q.get("shape", 0) <= 0:
        for k in ("shape", "spikes", "halo", "sprite"):
            q.pop(k, None)
    return {k: v for k, v in q.items() if not (isinstance(v, (int, float)) and v == 0)}


def main():
    catalog = json.load(open(CATALOG))
    tier1 = json.load(open(TIER1)) if os.path.exists(TIER1) else {"emitters": {}}
    rows = {f"0x{e['id']:08X}": e for e in json.load(open(os.path.join(WORK, "emitters_ctx.json")))}
    feats = json.load(open(os.path.join(WORK, "surface_features.json")))
    overrides = {}
    ov_path = os.path.join(HERE, "tier2_overrides.json")
    if os.path.exists(ov_path):
        overrides = json.load(open(ov_path)).get("emitters", {})
    emitters = {}
    counts = {k: 0 for k in ("stretch", "shape", "star", "orb", "ring", "bounce")}
    for did, cat in sorted(catalog["emitters"].items()):
        e = rows.get(did)
        if e is None:
            continue
        p = build(e, cat, tier1["emitters"].get(did), feats)
        if did in overrides:
            for k, v in overrides[did].items():
                if v is None:
                    p.pop(k, None)
                else:
                    p[k] = v
        p = sanitize(p)
        if p:
            emitters[did] = p
            for k in ("stretch", "shape", "bounce"):
                if p.get(k):
                    counts[k] += 1
            if p.get("shape"):
                counts[{1: "star", 2: "orb", 3: "ring"}[p["shape"]]] += 1
    doc = {
        "version": 1,
        "description": "Tier-2 particle upgrade params (velocity stretch, analytic star / orb / ring sprites with an "
                       "energy-matched colour, spark bounce) per retail emitter. Generated by "
                       "tools/particle-fx/tier2.py from data/particle-fx-catalog.json x the DAT measurements; merged "
                       "into scene3d/particles/particle_fx_profiles.js by scripts/gen-particle-fx-profiles.mjs.",
        "shapes": SHAPES,
        "analytic": {"starCoreR": STAR_CORE_R, "orbCoreR": ORB_CORE_R, "ringR0": RING_R0, "ringW": RING_W,
                     "edge0": EDGE0},
        "ranges": {k: list(v) for k, v in RANGE.items()},
        "emitters": emitters,
        "synthesized": {},
    }
    with open(OUT, "w") as f:
        f.write("{\n")
        for k in ("version", "description", "shapes", "analytic", "ranges"):
            f.write(f" {json.dumps(k)}: {json.dumps(doc[k])},\n")
        f.write(' "emitters": {\n' + ",\n".join(
            f"  {json.dumps(k)}: {json.dumps(v, separators=(',', ':'))}" for k, v in emitters.items()) + "\n },\n")
        f.write(' "synthesized": {}\n}\n')
    json.load(open(OUT))
    print(f"tier2: {len(emitters)} emitters -> {OUT}")
    print("with:", counts)


if __name__ == "__main__":
    main()
