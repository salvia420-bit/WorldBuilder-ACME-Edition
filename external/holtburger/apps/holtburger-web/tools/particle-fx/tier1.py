#!/usr/bin/env python3
"""Tier-1 particle upgrade params (2026-10-10) for every emitter in the catalog.

The 2026-10-09 pass (`?particleFx`) re-shaded the retail sprites. Tier 1 changes
what reaches the screen around them, and every emitter gets its own numbers:

  light        the effect lights the world (FX light source through the fixed
               light pool; the terrain now takes pool lights too)
  glow         share of the particle's light sent to the FX glow buffer
               (a blurred halo independent of the scene bloom threshold)
  kids         GPU child particles per retail particle (embers off flames,
               glitter round orbs, sparks off impacts, crackle on lightning,
               drips off water, motes spiralling into portals)
  distort      screen-space distortion source (heat over fires, swirl over
               portals, shockwave ring on bursts, ripple on runes)
  smoke        sun shading from the sprite's own shape, noise erosion, curl
               flow, sun-shadow receive, back-lit rim (smoke, dust, mist, gas)

profile = family recipe (catalog family: what the sprite IS)
        x behaviour (catalog behaviour: standing / plume / burst / trail ...)
        x measured numbers ($PFX_WORK/emitters_ctx.json from datcat.py +
          enrich.py: sprite size, lifespan, live count, texture colour, blend)
        x context tags (portal / hearth / buff / debuff / spell projectile ...)
        + tier1_overrides.json (per-DID corrections).

  cd apps/holtburger-web/tools/particle-fx
  PFX_WORK=<work> python3 tier1.py            # -> ../../data/particle-fx-tier1.json
  cd ../.. && node scripts/gen-particle-fx-profiles.mjs

The runtime reads the result through scene3d/particles/particle_fx_profiles.js
(rows grow from 6 to 10 texels; see particle_fx.js FX_PARAM_LAYOUT).
"""
import json, math, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.normpath(os.path.join(HERE, "..", ".."))
WORK = os.environ.get("PFX_WORK") or os.path.join(HERE, "work")
CATALOG = os.path.join(APP, "data", "particle-fx-catalog.json")
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(APP, "data", "particle-fx-tier1.json")
sys.path.insert(0, HERE)
import gen_profiles as G  # noqa: E402  (behaviour / size_m / ctx_tags on the same measurements)

KID_KINDS = {"ember": 1, "glitter": 2, "spark": 3, "drip": 4, "inflow": 5, "crackle": 6}
DIST_KINDS = {"heat": 1, "swirl": 2, "ring": 3, "ripple": 4}

# Ranges every emitted value is clamped to (the runtime trusts these).
RANGE = dict(glow=(0.0, 2.0), kids=(0, 8), kidSize=(0.01, 0.4), kidLife=(0.15, 4.0), kidSpread=(0.05, 4.0),
             kidGain=(0.3, 2.5), rim=(0.0, 1.0), sunLit=(0.0, 1.0), noise=(0.0, 1.0), flow=(0.0, 0.04),
             shadow=(0.0, 1.0), light=(0.0, 80.0), lightRange=(0.0, 14.0), distort=(0.0, 1.0),
             distortRadius=(0.0, 12.0))

# ---------------------------------------------------------------------------
# Family recipes.
#   glow   share of the (calibrated) particle colour sent to the glow buffer
#          — additive sprites only (an alpha sprite is matter, not light)
#   kid    (kind, per-parent count, size K, life s, spread K, gain)
#          size and spread scale with the measured sprite size S (metres)
#   dist   (kind, strength, radius K)    radius = K * S, clamped
#   light  (intensity, range K, range min, range max)   intensity in the DAT's
#          LightInfo units (setup torches author 20-100); range = min + K * S
#   smoke  (sunLit, noise, flow, shadow, rim)
# ---------------------------------------------------------------------------
T1 = {
    "fire":         dict(glow=0.55, kid=("ember", 4, 0.07, 1.6, 1.1, 1.3), dist=("heat", 0.8, 1.6),
                         light=(26.0, 3.0, 3.5, 9.0), smoke=(0.0, 0.45, 0.016, 0.0, 0.0)),
    "flame_tongue": dict(glow=0.6, kid=("ember", 3, 0.06, 1.4, 1.0, 1.2), dist=("heat", 0.7, 1.8),
                         light=(22.0, 4.0, 3.0, 7.0), smoke=(0.0, 0.35, 0.02, 0.0, 0.0)),
    "mist_fire":    dict(glow=0.35, kid=("ember", 2, 0.06, 1.8, 1.2, 1.0), dist=("heat", 0.6, 1.2),
                         light=(14.0, 2.0, 3.0, 8.0), smoke=(0.0, 0.5, 0.014, 0.0, 0.0)),
    "smoke_dark":   dict(smoke=(0.85, 0.6, 0.012, 0.85, 0.35)),
    "smoke_light":  dict(smoke=(0.9, 0.55, 0.012, 0.8, 0.6)),
    "smoke_add":    dict(smoke=(0.55, 0.5, 0.010, 0.6, 0.55)),
    "mist_white":   dict(glow=0.08, smoke=(0.45, 0.45, 0.010, 0.5, 0.5)),
    "gas_alpha":    dict(smoke=(0.5, 0.5, 0.014, 0.6, 0.3)),
    "mist_magic":   dict(glow=0.35, kid=("glitter", 2, 0.05, 1.6, 0.6, 1.1), light=(10.0, 2.0, 3.0, 7.0),
                         smoke=(0.0, 0.4, 0.012, 0.0, 0.0)),
    "dust":         dict(smoke=(0.85, 0.6, 0.010, 0.85, 0.45)),
    "dark_burst":   dict(dist=("ring", 0.4, 1.2), smoke=(0.4, 0.5, 0.0, 0.4, 0.0)),
    "star":         dict(glow=0.8, kid=("glitter", 1, 0.04, 1.2, 0.5, 1.2), light=(8.0, 2.0, 2.5, 6.0)),
    "star_dark":    dict(),
    "glow_orb":     dict(glow=0.9, kid=("glitter", 2, 0.045, 1.4, 0.55, 1.2), light=(12.0, 2.5, 3.0, 7.0)),
    "glow_point":   dict(glow=1.1, light=(16.0, 3.0, 3.0, 8.0)),
    "faint_glow":   dict(glow=0.3, light=(9.0, 0.6, 3.0, 9.0)),
    "lightning":    dict(glow=1.2, kid=("crackle", 3, 0.05, 0.35, 0.6, 1.6), light=(40.0, 2.0, 4.0, 10.0)),
    "tendril":      dict(glow=0.6, kid=("spark", 2, 0.05, 0.9, 1.2, 1.3), dist=("ring", 0.5, 1.0),
                         light=(16.0, 2.0, 3.0, 8.0)),
    "vortex":       dict(glow=0.65, kid=("inflow", 3, 0.05, 2.0, 0.7, 1.2), dist=("swirl", 0.9, 0.7),
                         light=(22.0, 1.6, 4.0, 9.0), smoke=(0.0, 0.25, 0.006, 0.0, 0.0)),
    "vortex_dark":  dict(dist=("swirl", 0.7, 0.7), smoke=(0.0, 0.3, 0.006, 0.0, 0.0)),
    "swirl_tex":    dict(glow=0.35, kid=("glitter", 1, 0.04, 1.6, 0.5, 1.0), dist=("swirl", 0.25, 0.8),
                         light=(6.0, 2.0, 2.5, 6.0), smoke=(0.0, 0.2, 0.004, 0.0, 0.0)),
    "ring_soft":    dict(glow=0.7, kid=("glitter", 1, 0.05, 1.4, 0.6, 1.1), dist=("ring", 0.45, 1.0),
                         light=(12.0, 2.0, 3.0, 7.0)),
    "ring_line":    dict(glow=0.6, dist=("ring", 0.55, 1.0), light=(10.0, 2.0, 3.0, 7.0)),
    "rune":         dict(glow=0.9, kid=("glitter", 2, 0.045, 1.6, 0.6, 1.1), dist=("ripple", 0.25, 0.8),
                         light=(10.0, 2.0, 2.5, 6.0)),
    "streak":       dict(glow=0.8, kid=("spark", 2, 0.04, 0.7, 1.0, 1.3)),
    "beam":         dict(glow=0.8, kid=("glitter", 2, 0.05, 2.0, 0.6, 1.0), light=(14.0, 0.8, 3.0, 8.0)),
    "specks":       dict(glow=0.5),
    "snow":         dict(glow=0.12, smoke=(0.0, 0.0, 0.0, 0.5, 0.0)),
    "bubbles":      dict(glow=0.15, smoke=(0.0, 0.0, 0.0, 0.4, 0.0)),
    "liquid":       dict(smoke=(0.4, 0.0, 0.0, 0.6, 0.0)),
    "blood":        dict(smoke=(0.35, 0.0, 0.0, 0.6, 0.0)),
    "blood_mist":   dict(smoke=(0.6, 0.5, 0.008, 0.6, 0.2)),
    "splash":       dict(smoke=(0.6, 0.35, 0.0, 0.6, 0.4)),
    "water_sheet":  dict(kid=("drip", 2, 0.04, 0.8, 0.8, 0.9), smoke=(0.55, 0.3, 0.0, 0.6, 0.4)),
    "water_streak": dict(glow=0.1, kid=("drip", 2, 0.035, 0.7, 0.8, 0.8)),
    "debris":       dict(smoke=(0.0, 0.0, 0.0, 0.6, 0.0)),
    "leaves":       dict(smoke=(0.0, 0.0, 0.0, 0.6, 0.0)),
    "insect":       dict(smoke=(0.0, 0.0, 0.0, 0.5, 0.0)),
    "solid_ball":   dict(smoke=(0.5, 0.0, 0.0, 0.6, 0.0)),
    "solid_shard":  dict(smoke=(0.4, 0.0, 0.0, 0.6, 0.0)),
    "solid_disc":   dict(smoke=(0.0, 0.0, 0.0, 0.5, 0.0)),
}

# Behaviours that may carry an FX light. Trails ride projectiles, whose Setup
# light already goes through the pool (PROJ-VIS); fountains/drifts are matter.
LIGHT_BEHAVIOURS = {"standing", "plume", "stream", "swarm", "burst", "flash", "implode", "puff"}
TRANSIENT_BEHAVIOURS = {"burst", "flash", "implode", "puff"}
# Persistent distortion (heat over a fire, swirl over a portal) vs the one-shot
# shockwave ring a burst throws.
PERSISTENT_DIST = {"heat", "swirl", "ripple"}


def clamp(v, lo, hi):
    return lo if v < lo else hi if v > hi else v


def r4(v):
    return round(float(v), 4)


def light_color(e, cat_params):
    """Alpha-weighted texture colour x mid-life tint, max channel 1, chroma x1.15."""
    s = e.get("surface") or {}
    mc = s.get("meanRGBa") or s.get("meanRGB") or [200.0, 200.0, 200.0]
    t0 = cat_params.get("tint0") or [1.0, 1.0, 1.0]
    t1 = cat_params.get("tint1") or [1.0, 1.0, 1.0]
    c = [max(1e-3, mc[i] / 255.0) * 0.5 * (t0[i] + t1[i]) for i in range(3)]
    m = max(c)
    c = [x / m for x in c]
    lum = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
    c = [clamp(lum + (x - lum) * 1.15, 0.05, 1.0) for x in c]
    m = max(c)
    return [r4(x / m) for x in c]


def live_count(e, beh):
    if beh in ("burst", "implode"):
        return max(1, e["initialParticles"]) + (e["totalParticles"] if e["totalParticles"] > e["initialParticles"] else 0) * 0.3
    if e["emitterType"] == 1 and e["birthrate"] > 1e-4:
        return min(max(1, e["maxParticles"]), max(0.05, e["lifespan"]) / e["birthrate"] + e["initialParticles"])
    return max(1, min(e["maxParticles"], 6))


def build(e, cat):
    fam = cat["family"]
    beh = cat["behavior"]
    cp = cat.get("params") or {}
    rec = T1.get(fam)
    out = {}
    if not rec or fam in ("misc", "none", "sky"):
        return out
    S, _quad = G.size_m(e)
    tags = G.ctx_tags(e)
    additive = bool((e.get("surface") or {}).get("type", 0) & 0x10000)
    n_live = live_count(e, beh)
    sizeK = clamp(S / 0.6, 0.4, 2.5) ** 0.5

    # ---- glow: additive light only; dense emitters already pile up -----------
    if additive and rec.get("glow", 0) > 0:
        crowd = 1.0 / math.sqrt(max(1.0, n_live / 12.0))
        # A big sprite already IS a halo; its blurred copy would wash the frame.
        big = clamp(0.8 / max(0.05, S), 0.25, 1.0) ** 0.35
        out["glow"] = (rec["glow"] * clamp(cp.get("gain", 1.0), 0.7, 1.6) / 1.15
                       * clamp(crowd, 0.45, 1.0) * big)

    # ---- kids --------------------------------------------------------------------
    if rec.get("kid"):
        kind, n, sK, life, spK, gain = rec["kid"]
        if beh in ("burst", "flash", "implode") and kind == "ember":
            kind, n, life, gain = "spark", n, 0.8, gain * 1.1
        if beh == "implode" and kind in ("glitter", "spark"):
            kind = "inflow"
        if beh == "trail" and kind == "glitter":
            n = max(1, n - 1)
        # cap the children an emitter spawns in total (vertex work + overdraw)
        n = int(min(n, max(0, 64 // max(1, int(round(n_live))))))
        if n > 0 and (additive or kind == "drip"):
            out["kids"] = n
            out["kidKind"] = KID_KINDS[kind]
            out["kidSize"] = sK * sizeK
            out["kidLife"] = life
            out["kidSpread"] = clamp(spK * max(0.3, S), 0.1, 3.0)
            out["kidGain"] = gain

    # ---- distortion ----------------------------------------------------------------
    if rec.get("dist"):
        kind, strength, rK = rec["dist"]
        transient = beh in TRANSIENT_BEHAVIOURS
        if kind in PERSISTENT_DIST and transient and fam in ("fire", "flame_tongue", "mist_fire"):
            kind, strength = "ring", strength * 0.7   # a fire burst throws a shockwave, not a heat column
        if kind == "ring" and not transient:
            kind = None                               # rings only on one-shots
        if kind == "heat" and beh in ("trail", "fountain", "drift"):
            kind = None
        if kind == "swirl" and beh in ("burst", "flash", "trail"):
            kind = None
        if kind:
            if "portal" in tags and kind == "swirl":
                strength = min(1.0, strength * 1.25)
            out["distort"] = strength
            out["distortKind"] = DIST_KINDS[kind]
            out["distortRadius"] = clamp(rK * max(0.35, S), 0.3, 6.0)

    # ---- light ---------------------------------------------------------------------
    if rec.get("light") and beh in LIGHT_BEHAVIOURS and additive:
        I, rK, rMin, rMax = rec["light"]
        I *= clamp(S / 0.8, 0.45, 1.6) ** 0.5
        if "portal" in tags and fam in ("vortex", "ring_soft", "faint_glow", "glow_orb"):
            I *= 1.3
        if ("buff" in tags or "debuff" in tags) and beh == "swarm":
            I *= 0.6                                  # a soft wash on the caster, not a flare
        if "hearth" in tags:
            I *= 0.85                                 # usually paired with the setup's own LightInfo
        out["light"] = I
        out["lightRange"] = clamp(rMin + rK * S, rMin, rMax)
        out["lightColor"] = light_color(e, cp)

    # ---- smoke shading -----------------------------------------------------------------
    if rec.get("smoke"):
        sl, nz, fl, sh, rim = rec["smoke"]
        if sl > 0: out["sunLit"] = sl
        if nz > 0: out["noise"] = nz
        if fl > 0: out["flow"] = fl * clamp(1.0 / sizeK, 0.6, 1.4)
        if sh > 0: out["shadow"] = sh
        if rim > 0: out["rim"] = rim
    return out


def sanitize(p):
    q = {}
    for k, v in p.items():
        if k == "lightColor":
            q[k] = [r4(clamp(x, 0.0, 1.0)) for x in v]
            continue
        lo, hi = RANGE.get(k, (None, None))
        if k in ("kids", "kidKind", "distortKind"):
            v = int(v)
        if lo is not None:
            v = clamp(v, lo, hi)
        q[k] = v if isinstance(v, int) else r4(v)
    # a light needs a range and a colour; a child kind needs a count
    if q.get("light", 0) <= 0 or q.get("lightRange", 0) <= 0:
        for k in ("light", "lightRange", "lightColor"):
            q.pop(k, None)
    if q.get("kids", 0) <= 0:
        for k in ("kids", "kidKind", "kidSize", "kidLife", "kidSpread", "kidGain"):
            q.pop(k, None)
    if q.get("distort", 0) <= 0:
        for k in ("distort", "distortKind", "distortRadius"):
            q.pop(k, None)
    return {k: v for k, v in q.items() if not (isinstance(v, (int, float)) and v == 0)}


# Synthesized Visual-Behavior-Suite emitters (no DAT record to measure).
SYNTH = {
    "particle.gemSparkle": dict(glow=1.0, kids=1, kidKind=2, kidSize=0.03, kidLife=1.2, kidSpread=0.25, kidGain=1.2),
    "particle.brazierEmbers.ember": dict(glow=0.7),
    "particle.brazierEmbers.smoke": dict(sunLit=0.8, noise=0.55, flow=0.012, shadow=0.8, rim=0.4),
    "terrain.volcanoEmbers.ember": dict(glow=0.8),
    "terrain.volcanoEmbers.smoke": dict(sunLit=0.6, noise=0.55, flow=0.012, shadow=0.7, rim=0.3),
    "particle.foliagePollen": dict(glow=0.2),
    "particle.foliageFireflies": dict(glow=1.2),
    "particle.foliageLeaves": dict(shadow=0.6),
    "particle.breathFog": dict(sunLit=0.45, noise=0.45, flow=0.01, shadow=0.4, rim=0.5),
    "terrain.sandDevils": dict(sunLit=0.8, noise=0.6, flow=0.012, shadow=0.7, rim=0.45),
    "terrain.swampFireflies": dict(glow=1.2),
    "terrain.swampMidges": dict(),
    "terrain.marshGas.bubble": dict(glow=0.2),
    "terrain.marshGas.wisp": dict(glow=0.6, light=4.0, lightRange=3.0, lightColor=[0.75, 1.0, 0.45]),
}


def main():
    catalog = json.load(open(CATALOG))
    rows = {f"0x{e['id']:08X}": e for e in json.load(open(os.path.join(WORK, "emitters_ctx.json")))}
    overrides = {}
    ov_path = os.path.join(HERE, "tier1_overrides.json")
    if os.path.exists(ov_path):
        overrides = json.load(open(ov_path)).get("emitters", {})
    emitters = {}
    counts = {k: 0 for k in ("light", "glow", "kids", "distort", "sunLit", "noise", "shadow")}
    for did, cat in sorted(catalog["emitters"].items()):
        e = rows.get(did)
        if e is None:
            continue
        p = build(e, cat)
        if did in overrides:
            for k, v in overrides[did].items():
                if v is None:
                    p.pop(k, None)
                else:
                    p[k] = v
        p = sanitize(p)
        if p:
            emitters[did] = p
            for k in counts:
                if p.get(k):
                    counts[k] += 1
    synth = {}
    for name in catalog.get("synthesized", {}):
        p = sanitize(SYNTH.get(name, {}))
        if p:
            synth[name] = p
    doc = {
        "version": 1,
        "description": "Tier-1 particle upgrade params (light, glow, GPU children, distortion, smoke shading) per "
                       "retail emitter + synthesized profile. Generated by tools/particle-fx/tier1.py from "
                       "data/particle-fx-catalog.json x the DAT measurements; merged into "
                       "scene3d/particles/particle_fx_profiles.js by scripts/gen-particle-fx-profiles.mjs.",
        "kidKinds": KID_KINDS,
        "distortKinds": DIST_KINDS,
        "ranges": {k: list(v) for k, v in RANGE.items()},
        "emitters": emitters,
        "synthesized": synth,
    }
    with open(OUT, "w") as f:
        f.write("{\n")
        for k in ("version", "description", "kidKinds", "distortKinds", "ranges"):
            f.write(f" {json.dumps(k)}: {json.dumps(doc[k])},\n")
        f.write(' "emitters": {\n' + ",\n".join(
            f"  {json.dumps(k)}: {json.dumps(v, separators=(',', ':'))}" for k, v in emitters.items()) + "\n },\n")
        f.write(' "synthesized": {\n' + ",\n".join(
            f"  {json.dumps(k)}: {json.dumps(v, separators=(',', ':'))}" for k, v in synth.items()) + "\n }\n}\n")
    json.load(open(OUT))
    print(f"tier1: {len(emitters)} emitters + {len(synth)} synthesized -> {OUT}")
    print("with:", counts)


if __name__ == "__main__":
    main()
