#!/usr/bin/env python3
"""Particle FX profile generator — one individual profile per retail emitter.

profile = family recipe (what the sprite IS, from the texture)
        x behaviour (how the emitter moves it: standing / trail / burst / swarm /
          fountain / stream / drift, from the 0x32 record)
        x measured numbers (sprite size in metres, lifespan, crowding, retail
          start/final translucency, texture brightness + hue, UV layout)
        x context (who plays it: PlayScript names, weenie names, setups)
        + review overrides (overrides/*.json, written by family reviewers).

Output: profiles.json  {did: {family, behavior, params, note, ...}}

Param semantics (consumed by scene3d/particles/particle_fx.js; all optional,
neutral defaults = retail look):
  gain        rgb multiplier (HDR: >1.1 lit pixels feed the bloom pass)
  core        extra gain on the texel's bright core (white-hot centre)
  sat         saturation multiplier
  tint0/tint1 rgb multiplier at birth / at death; tintCurve = age exponent
  fadeIn/fadeOut  fraction of life ramped in from / out to zero (no pops)
  erode       texture-driven dissolve over life (dim texels vanish first)
  flicker, flickerHz   smooth value-noise brightness flicker
  twinkle     sharp glint peaks (rides flickerHz)
  spin        texture turns over one particle's life (random sign/rate per particle)
  wobble      UV turbulence amplitude (licking flames, shimmering water)
  soft        soft-particle depth fade distance, metres
  nearFade    fade out within this many metres of the camera
  lit         0..1 response to scene light (day/night/indoor) — non-emissive sprites
  pulse, pulseHz   smooth sinusoidal breathing (auras, runes, portals)
"""
import json, math, os, re, sys
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.environ.get("PFX_WORK") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "work")
os.makedirs(WORK, exist_ok=True)
sys.path.insert(0, HERE)
from families import FAMILY_OF_SURFACE  # noqa: E402

rows = json.load(open(os.path.join(WORK, "emitters_ctx.json")))
feats = {int(k, 16): v for k, v in json.load(open(os.path.join(WORK, "surface_features.json"))).items()}

NEUTRAL = dict(gain=1.0, core=0.0, sat=1.0, tintCurve=1.0, tint0=[1, 1, 1], tint1=[1, 1, 1],
               fadeIn=0.0, fadeOut=0.0, erode=0.0, flicker=0.0, flickerHz=8.0, twinkle=0.0,
               spin=0.0, wobble=0.0, soft=0.0, nearFade=0.0, lit=0.0, pulse=0.0, pulseHz=1.0, edgeSoft=0.0)

# ---------------------------------------------------------------------------
# Family recipes. Time targets are SECONDS (converted to life fractions per
# emitter); spinRate is turns/second; softK / nearK scale with sprite size.
# ---------------------------------------------------------------------------
R = {}
def fam(name, desc, **kw):
    base = dict(gain=1.0, core=0.0, sat=1.0, tintCurve=1.0, tint0=[1, 1, 1], tint1=[1, 1, 1],
                tIn=0.0, tOut=0.0, erode=0.0, flicker=0.0, flickerHz=8.0, twinkle=0.0,
                spinRate=0.0, spinOk=False, wobble=0.0, softK=0.0, softMin=0.0, softMax=0.0,
                nearK=0.0, nearMin=0.0, nearMax=0.0, lit=0.0, pulse=0.0, pulseHz=1.0,
                hdr=True, crowdSens=1.0, colorDeepen=0.0)
    base.update(kw)
    base["desc"] = desc
    R[name] = base

# -- fire ---------------------------------------------------------------------
fam("fire", "billowing orange flame puff",
    gain=1.32, core=0.75, sat=1.06, tint0=[1.12, 1.02, 0.86], tint1=[1.0, 0.58, 0.42], tintCurve=1.15,
    tIn=0.07, tOut=0.30, erode=0.34, flicker=0.16, flickerHz=9.0, spinRate=0.10, spinOk=True,
    wobble=0.018, softK=0.45, softMin=0.12, softMax=1.4, nearK=1.0, nearMin=0.35, nearMax=2.0)
fam("flame_tongue", "tall licking flame sprite (directional — never spun)",
    gain=1.30, core=0.65, sat=1.05, tint0=[1.10, 1.03, 0.92], tint1=[1.0, 0.70, 0.55], tintCurve=1.2,
    tIn=0.08, tOut=0.30, erode=0.28, flicker=0.20, flickerHz=10.5, wobble=0.030,
    softK=0.35, softMin=0.08, softMax=0.9, nearK=0.9, nearMin=0.3, nearMax=1.6)
fam("mist_fire", "warm glowing ember haze",
    gain=1.18, core=0.35, sat=1.05, tint0=[1.06, 1.0, 0.9], tint1=[1.0, 0.7, 0.55],
    tIn=0.12, tOut=0.35, erode=0.30, flicker=0.10, flickerHz=6.0, spinRate=0.06, spinOk=True,
    softK=0.5, softMin=0.2, softMax=1.6, nearK=1.0, nearMin=0.5, nearMax=2.0)
# -- smoke / gas -----------------------------------------------------------------
fam("smoke_dark", "dark soot smoke puff (alpha)",
    gain=1.0, sat=0.65, tint0=[0.92, 0.88, 0.84], tint1=[1.10, 1.10, 1.12], tintCurve=0.8,
    tIn=0.18, tOut=0.45, erode=0.42, spinRate=0.05, spinOk=True,
    softK=0.6, softMin=0.25, softMax=2.0, nearK=1.2, nearMin=0.6, nearMax=2.5, lit=0.85, hdr=False)
fam("smoke_light", "soft grey smoke/steam puff (alpha)",
    gain=1.0, sat=0.7, tint0=[0.98, 0.97, 0.96], tint1=[1.06, 1.07, 1.10], tintCurve=0.8,
    tIn=0.18, tOut=0.45, erode=0.38, spinRate=0.05, spinOk=True,
    softK=0.6, softMin=0.25, softMax=2.0, nearK=1.2, nearMin=0.6, nearMax=2.5, lit=0.8, hdr=False)
fam("smoke_add", "white wispy smoke/steam drawn additively (must not glow)",
    gain=0.86, sat=0.6, tint0=[1.0, 0.99, 0.97], tint1=[0.95, 0.97, 1.02],
    tIn=0.15, tOut=0.40, erode=0.36, spinRate=0.05, spinOk=True,
    softK=0.6, softMin=0.25, softMax=2.0, nearK=1.2, nearMin=0.6, nearMax=2.5, lit=0.45, hdr=False)
fam("mist_white", "soft white additive cloud (spray / breath / ghostly mist)",
    gain=0.95, sat=0.75, tIn=0.15, tOut=0.40, erode=0.32, spinRate=0.05, spinOk=True,
    softK=0.6, softMin=0.25, softMax=2.0, nearK=1.2, nearMin=0.6, nearMax=2.5, lit=0.35, hdr=False)
fam("gas_alpha", "coloured poison/acid gas cloud (alpha)",
    gain=1.0, sat=1.05, tint1=[1.05, 1.05, 1.05], tIn=0.16, tOut=0.42, erode=0.40, spinRate=0.06, spinOk=True,
    softK=0.55, softMin=0.2, softMax=1.8, nearK=1.1, nearMin=0.5, nearMax=2.2, lit=0.6, hdr=False)
fam("mist_magic", "coloured magic mist (additive)",
    gain=1.16, core=0.25, sat=1.10, tIn=0.12, tOut=0.36, erode=0.30, spinRate=0.06, spinOk=True,
    softK=0.5, softMin=0.2, softMax=1.6, nearK=1.0, nearMin=0.5, nearMax=2.0, colorDeepen=0.25)
fam("dust", "brown dust cloud (alpha)",
    gain=1.0, sat=0.8, tint1=[1.08, 1.06, 1.04], tIn=0.15, tOut=0.45, erode=0.45, spinRate=0.05, spinOk=True,
    softK=0.6, softMin=0.25, softMax=2.0, nearK=1.2, nearMin=0.6, nearMax=2.5, lit=0.85, hdr=False)
fam("dark_burst", "black spiky soot/void burst (alpha)",
    gain=1.0, sat=0.9, tIn=0.03, tOut=0.35, erode=0.38, spinRate=0.12, spinOk=True,
    softK=0.4, softMin=0.1, softMax=1.2, nearK=1.0, nearMin=0.4, nearMax=2.0, lit=0.4, hdr=False)
# -- light / magic -----------------------------------------------------------------
fam("star", "4-point star flare / sparkle",
    gain=1.75, core=1.0, sat=1.08, tIn=0.04, tOut=0.25, twinkle=0.32, flickerHz=7.0,
    spinRate=0.08, spinOk=True, softK=0.15, softMin=0.04, softMax=0.4, nearK=0.6, nearMin=0.15, nearMax=0.8,
    crowdSens=0.8)
fam("star_dark", "dark (alpha) star — void / shadow spark",
    gain=0.95, sat=1.0, tIn=0.04, tOut=0.25, spinRate=0.08, spinOk=True, softK=0.15, softMin=0.04, softMax=0.4,
    nearK=0.6, nearMin=0.15, nearMax=0.8, lit=0.3, hdr=False)
fam("glow_orb", "soft radial glow orb",
    gain=1.55, core=0.80, sat=1.10, tIn=0.06, tOut=0.28, softK=0.35, softMin=0.08, softMax=1.2,
    nearK=0.9, nearMin=0.3, nearMax=1.8, colorDeepen=0.18)
fam("glow_point", "tiny hot point of light",
    gain=2.0, core=1.0, sat=1.05, tIn=0.04, tOut=0.25, twinkle=0.18, flickerHz=6.0,
    softK=0.15, softMin=0.03, softMax=0.3, nearK=0.5, nearMin=0.1, nearMax=0.6)
fam("faint_glow", "large faint additive halo",
    gain=1.28, core=0.20, sat=1.08, tIn=0.15, tOut=0.35, softK=0.55, softMin=0.25, softMax=2.5,
    nearK=1.2, nearMin=0.6, nearMax=3.0, crowdSens=0.7)
fam("lightning", "electric arc / lightning bolt (directional)",
    gain=2.1, core=1.15, sat=1.12, tIn=0.0, tOut=0.18, flicker=0.42, flickerHz=17.0,
    softK=0.15, softMin=0.03, softMax=0.5, nearK=0.6, nearMin=0.15, nearMax=1.0)
fam("tendril", "radial energy tendril burst",
    gain=1.75, core=0.90, sat=1.10, tIn=0.04, tOut=0.30, erode=0.22, flicker=0.18, flickerHz=12.0,
    spinRate=0.18, spinOk=True, softK=0.25, softMin=0.05, softMax=0.8, nearK=0.8, nearMin=0.2, nearMax=1.4)
fam("vortex", "swirling energy vortex ring",
    gain=1.50, core=0.60, sat=1.10, tIn=0.10, tOut=0.30, spinRate=0.30, spinOk=True, pulse=0.05, pulseHz=1.4,
    softK=0.3, softMin=0.06, softMax=1.0, nearK=0.9, nearMin=0.3, nearMax=1.8, colorDeepen=0.15)
fam("vortex_dark", "dark (alpha) vortex — void magic swirl",
    gain=1.0, sat=1.05, tIn=0.10, tOut=0.30, spinRate=0.30, spinOk=True, pulse=0.04, pulseHz=1.2,
    softK=0.3, softMin=0.06, softMax=1.0, nearK=0.9, nearMin=0.3, nearMax=1.8, lit=0.25, hdr=False)
fam("swirl_tex", "full-frame swirl stripes (enchantment column body; square — never spun)",
    gain=1.38, core=0.45, sat=1.10, tIn=0.10, tOut=0.30, wobble=0.012, pulse=0.05, pulseHz=1.6,
    softK=0.3, softMin=0.08, softMax=1.0, nearK=0.9, nearMin=0.3, nearMax=1.8, crowdSens=0.8)
fam("ring_soft", "soft glowing ring / portal halo",
    gain=1.45, core=0.40, sat=1.10, tIn=0.08, tOut=0.32, spinRate=0.10, spinOk=True, pulse=0.05, pulseHz=1.2,
    softK=0.3, softMin=0.06, softMax=1.0, nearK=0.9, nearMin=0.3, nearMax=1.8)
fam("ring_line", "thin shockwave ring outline",
    gain=1.0, tIn=0.03, tOut=0.40, spinRate=0.05, spinOk=True, softK=0.2, softMin=0.05, softMax=0.6,
    nearK=0.6, nearMin=0.2, nearMax=1.0, lit=0.3, hdr=False)
fam("rune", "glowing glyph / sigil (orientation matters — never spun)",
    gain=1.65, core=0.80, sat=1.08, tIn=0.15, tOut=0.30, pulse=0.10, pulseHz=1.5,
    softK=0.15, softMin=0.04, softMax=0.5, nearK=0.6, nearMin=0.2, nearMax=1.0)
fam("streak", "glowing streak / slash",
    gain=1.75, core=0.80, sat=1.08, tIn=0.0, tOut=0.25, flicker=0.10, flickerHz=14.0,
    softK=0.15, softMin=0.03, softMax=0.5, nearK=0.6, nearMin=0.15, nearMax=1.0)
fam("beam", "light beam / column",
    gain=1.6, core=0.6, sat=1.05, tIn=0.08, tOut=0.30, pulse=0.06, pulseHz=1.0, softK=0.3, softMin=0.08,
    softMax=1.0, nearK=0.9, nearMin=0.3, nearMax=1.8)
fam("specks", "speckle/sparkle field",
    gain=1.30, core=0.40, tIn=0.12, tOut=0.30, twinkle=0.28, flickerHz=5.0, spinRate=0.05, spinOk=True,
    softK=0.3, softMin=0.08, softMax=1.0, nearK=0.9, nearMin=0.3, nearMax=1.8)
# -- matter ----------------------------------------------------------------------
fam("snow", "snowflake cutout (6-fold — tumbles)",
    gain=1.05, sat=0.9, tIn=0.10, tOut=0.18, spinRate=0.35, spinOk=True, nearK=0.8, nearMin=0.2, nearMax=0.8,
    lit=0.7, hdr=False)
fam("bubbles", "bubble cluster",
    gain=1.08, tIn=0.08, tOut=0.15, twinkle=0.10, flickerHz=4.0, spinRate=0.05, spinOk=True,
    softK=0.15, softMin=0.03, softMax=0.4, nearK=0.6, nearMin=0.15, nearMax=0.8, lit=0.55, hdr=False)
fam("liquid", "acid/slime blobs (alpha)",
    gain=1.0, sat=1.05, tIn=0.03, tOut=0.25, spinRate=0.20, spinOk=True, softK=0.12, softMin=0.03, softMax=0.4,
    nearK=0.6, nearMin=0.15, nearMax=0.8, lit=0.7, hdr=False)
fam("blood", "blood droplets (alpha)",
    gain=0.92, sat=1.05, tint1=[0.85, 0.80, 0.80], tIn=0.02, tOut=0.25, spinRate=0.25, spinOk=True,
    softK=0.12, softMin=0.03, softMax=0.4, nearK=0.6, nearMin=0.15, nearMax=0.8, lit=0.75, hdr=False)
fam("blood_mist", "blood spray haze (alpha)",
    gain=0.95, sat=1.0, tIn=0.03, tOut=0.40, erode=0.32, softK=0.4, softMin=0.1, softMax=1.0,
    nearK=0.9, nearMin=0.3, nearMax=1.6, lit=0.7, hdr=False)
fam("splash", "white water/snow splash (alpha)",
    gain=1.02, sat=0.95, tIn=0.05, tOut=0.35, erode=0.30, spinRate=0.10, spinOk=True,
    softK=0.4, softMin=0.1, softMax=1.2, nearK=0.9, nearMin=0.3, nearMax=1.6, lit=0.6, hdr=False)
fam("water_sheet", "falling water sheet (alpha)",
    gain=1.02, tIn=0.08, tOut=0.25, wobble=0.010, softK=0.5, softMin=0.15, softMax=1.5,
    nearK=1.0, nearMin=0.4, nearMax=2.0, lit=0.55, hdr=False)
fam("water_streak", "rain/water streaks (additive)",
    gain=0.95, sat=0.8, tIn=0.06, tOut=0.25, wobble=0.008, softK=0.4, softMin=0.1, softMax=1.2,
    nearK=0.9, nearMin=0.3, nearMax=1.6, lit=0.5, hdr=False)
fam("debris", "splinters / rock chips (alpha)",
    gain=1.0, tIn=0.0, tOut=0.18, spinRate=0.6, spinOk=True, nearK=0.5, nearMin=0.1, nearMax=0.6,
    lit=0.85, hdr=False)
fam("leaves", "falling leaves (alpha)",
    gain=1.0, tIn=0.10, tOut=0.20, spinRate=0.35, spinOk=True, nearK=0.6, nearMin=0.15, nearMax=0.8,
    lit=0.85, hdr=False)
fam("insect", "insect sprite (orientation matters)",
    gain=1.0, tIn=0.10, tOut=0.15, nearK=0.5, nearMin=0.1, nearMax=0.6, lit=0.8, hdr=False)
fam("solid_ball", "opaque ball/orb sprite (alpha)",
    gain=1.0, tIn=0.03, tOut=0.18, softK=0.1, softMin=0.02, softMax=0.3, nearK=0.5, nearMin=0.1, nearMax=0.6,
    lit=0.35, hdr=False)
fam("solid_shard", "teardrop/crystal shard sprite (alpha)",
    gain=1.0, tIn=0.03, tOut=0.18, nearK=0.5, nearMin=0.1, nearMax=0.6, lit=0.4, hdr=False)
fam("solid_disc", "flat disc / sun sprite (alpha)",
    gain=1.0, tIn=0.05, tOut=0.2, nearK=0.5, nearMin=0.1, nearMax=0.6, hdr=False)
fam("misc", "one-off picture sprite (faces, moons, signs, creatures) — left as authored",
    gain=1.0, hdr=False)
fam("none", "surface without a texture — nothing is drawn (left neutral)", gain=1.0, hdr=False)
fam("sky", "sky-chain object (moon nebula / celestial sheet) — the sky chain is excluded from FX at runtime", gain=1.0, hdr=False)


def lerp(a, b, t): return a + (b - a) * t
def clamp(v, lo, hi): return max(lo, min(hi, v))
def r3(v): return round(float(v), 3)


def vlen(v): return math.sqrt(sum(x * x for x in v))


def behaviour(e):
    """Classify how the emitter moves its particles."""
    pt = e["particleType"]
    persistent = e["totalParticles"] == 0 and e["totalSeconds"] == 0
    per_meter = e["emitterType"] == 2
    vA = vlen(e["A"]) * 0.5 * (e["minA"] + e["maxA"])
    vB = vlen(e["B"]) * 0.5 * (e["minB"] + e["maxB"])
    vC = vlen(e["C"]) * 0.5 * (e["minC"] + e["maxC"])
    L = max(1e-3, e["lifespan"])
    # parabolic families: A = initial velocity, B = acceleration (B global for *GA)
    grav_down = pt in (3, 4, 8, 9, 10, 11) and e["B"][2] * 0.5 * (e["minB"] + e["maxB"]) < -0.5
    burst = (pt in (6, 7)) or (not persistent and e["initialParticles"] >= max(3, 0.5 * max(1, e["maxParticles"]))
                                and (e["totalSeconds"] > 0 and e["totalSeconds"] < 1.0 or e["totalParticles"] > 0 and e["totalParticles"] <= e["initialParticles"] + 2))
    if per_meter:
        return "trail", dict(vA=vA, vB=vB, vC=vC, persistent=persistent)
    if pt == 5:
        return "swarm", dict(vA=vA, vB=vB, vC=vC, persistent=persistent)
    if burst:
        return ("implode" if pt == 7 else "burst"), dict(vA=vA, vB=vB, vC=vC, persistent=persistent)
    if grav_down:
        return "fountain", dict(vA=vA, vB=vB, vC=vC, persistent=persistent)
    speed = vA
    if pt in (1,) or speed * L < 0.35:
        return ("standing" if persistent else "flash"), dict(vA=vA, vB=vB, vC=vC, persistent=persistent)
    rising = False
    if pt in (2, 3, 4, 8, 9, 10, 11, 12):
        az = e["A"][2] * 0.5 * (e["minA"] + e["maxA"])
        rising = az > 0.25 * max(1e-6, vA)
    if persistent:
        return ("plume" if rising else "stream"), dict(vA=vA, vB=vB, vC=vC, persistent=persistent)
    return ("puff" if rising else "drift"), dict(vA=vA, vB=vB, vC=vC, persistent=persistent)


BEH_DESC = {"trail": "per-metre trail", "swarm": "orbiting swarm", "burst": "one-shot burst", "implode": "implosion",
            "fountain": "falling arc / fountain", "standing": "standing (persistent, near-still)",
            "flash": "brief near-still flash", "plume": "rising plume", "stream": "persistent stream",
            "puff": "rising one-shot puff", "drift": "drifting one-shot"}

CTX_RULES = [
    (re.compile(r"portal", re.I), "portal"),
    (re.compile(r"lifestone", re.I), "lifestone"),
    (re.compile(r"fountain|waterfall|water|spout|geyser", re.I), "water"),
    (re.compile(r"torch|brazier|candle|campfire|fire pit|firepit|lamp|lantern|hearth|forge|bonfire|chandelier|sconce", re.I), "hearth"),
    (re.compile(r"PlayScript (Launch|Explode)", re.I), "spell_projectile"),
    (re.compile(r"PlayScript (Enchant|Shield|Attrib|Skill|Regen|Health|Vitae|Vision|Trans|SwapHealth)\w*Up", re.I), "buff"),
    (re.compile(r"PlayScript (Enchant|Shield|Attrib|Skill|Regen|Health|Vitae|Vision|Trans|SwapHealth)\w*(Down|Void)", re.I), "debuff"),
    (re.compile(r"PlayScript Splatter", re.I), "splatter"),
    (re.compile(r"PlayScript Spark", re.I), "hit_spark"),
    (re.compile(r"PlayScript Breathe", re.I), "breath"),
    (re.compile(r"PlayScript (LevelUp|Wedding|Augmentation|Aetheria)", re.I), "celebration"),
    (re.compile(r"PlayScript (Fizzle)", re.I), "fizzle"),
    (re.compile(r"PlayScript (Create|Destroy|DisappearDestroy|Hide|UnHide)", re.I), "appear"),
    (re.compile(r"chimney|smoke|stack", re.I), "chimney"),
]


def ctx_tags(e):
    tags = set()
    blob = " | ".join(e.get("ctx") or [])
    for rx, tag in CTX_RULES:
        if rx.search(blob):
            tags.add(tag)
    # Void magic only from the PlayScript names themselves (…DownVoid, Void…):
    # weenie names like "Void Knight" must not mark an effect as a debuff.
    if any(c.startswith("PlayScript ") and "void" in c.split(" on ")[0].lower() for c in (e.get("ctx") or [])):
        tags.add("void")
    return tags


def size_m(e):
    s = e["gfx"].get("size") or [0.3, 0.0, 0.3]
    q = max(s[0], s[1], s[2]) or 0.3
    sc = 0.5 * (clamp(e["startScale"], 0.1, 10) + clamp(e["finalScale"], 0.1, 10))
    return q * sc, q


def build(e):
    sid = e["gfx"]["surfaces"][0] if e["gfx"]["surfaces"] else 0
    family = FAMILY_OF_SURFACE.get(sid, "none")
    f = R[family]
    ft = feats.get(sid, {})
    beh, bd = behaviour(e)
    tags = ctx_tags(e)
    S, quad = size_m(e)
    L = max(0.05, e["lifespan"])
    p = dict(NEUTRAL)
    p["tint0"] = [1, 1, 1]; p["tint1"] = [1, 1, 1]
    why = []
    if S > 60.0 or L > 600.0:
        family = "sky"; f = R[family]
    if family in ("none", "misc", "sky"):
        return family, beh, tags, p, [], dict(S=r3(S), L=r3(L))

    add = bool((e["surface"] or {}).get("type", 0) & 0x10000)
    # ---- crowding: expected live particles x footprint vs spread area -----------
    if beh in ("burst", "implode"):
        n_live = max(1, e["initialParticles"]) + (e["totalParticles"] if e["totalParticles"] > e["initialParticles"] else 0) * 0.3
    elif e["emitterType"] == 1 and e["birthrate"] > 1e-4:
        n_live = min(max(1, e["maxParticles"]), L / e["birthrate"] + e["initialParticles"])
    else:
        n_live = max(1, min(e["maxParticles"], 6))
    spread = max(e["maxOffset"], bd["vA"] * L, 0.5 * bd["vB"] * L * L, S * 0.5)
    crowd = n_live * (S * S) / (math.pi * (spread + 0.5 * S) ** 2)
    crowd_scale = 1.0 / (1.0 + 0.30 * f["crowdSens"] * math.log2(1.0 + max(0.0, crowd)))

    # ---- brightness: lift dim sprites, rein in already-hot ones ------------------
    lum95 = ft.get("lum95", 0.6) or 0.6
    bright_comp = clamp((0.65 / max(0.15, lum95)) ** 0.35, 0.85, 1.35)

    if f["hdr"] and add:
        gain = 1.0 + (f["gain"] - 1.0) * crowd_scale * bright_comp
        core = f["core"] * crowd_scale
    else:
        gain = f["gain"]
        core = f["core"] * (crowd_scale if add else 0.0)
    p["gain"] = gain
    p["core"] = core
    p["sat"] = f["sat"]
    p["tint0"] = list(f["tint0"]); p["tint1"] = list(f["tint1"]); p["tintCurve"] = f["tintCurve"]
    # deepen toward the sprite's own hue at end of life (coloured afterglow)
    if f["colorDeepen"] > 0 and ft.get("chroma", 0) > 0.25:
        mc = ft.get("meanColor") or [1, 1, 1]
        m = max(mc) or 1.0
        hue_tint = [c / m for c in mc]
        k = f["colorDeepen"]
        p["tint1"] = [r3(lerp(t, lerp(1.0, h, 1.0), k) * (1.0 + 0.10 * k)) for t, h in zip(p["tint1"], hue_tint)]
        why.append("afterglow deepens to its own hue")

    # ---- fades: absolute-time targets -> life fractions, respecting retail lerps --
    st, fn = e["startTrans"], e["finalTrans"]
    tIn = f["tIn"]; tOut = f["tOut"]
    if beh in ("burst", "implode", "flash"):
        tIn = min(tIn, 0.035)          # bursts must flash immediately
        tOut *= 1.25
    if beh == "trail":
        tOut *= 1.4
    if beh in ("standing", "plume", "stream"):
        tIn = max(tIn, 0.10 if not f["hdr"] else 0.06)
    if st >= 0.85:
        fade_in = 0.0                    # retail already fades it in
    else:
        fade_in = clamp(tIn / L, 0.0, 0.30) * (1.0 - st)
    if fn >= 0.92:
        fade_out = clamp(0.03 / L, 0.0, 0.06) if tOut > 0 else 0.0   # retail fades it out; only round the tail
    else:
        cap = 0.25 if st > fn + 0.3 else 0.45   # retail opacity RISES over life: keep the build-up, round only the end
        fade_out = clamp(tOut / L, 0.05 if tOut > 0 else 0.0, cap) * (1.0 - fn) ** 0.5
    if tOut <= 0:
        fade_out = 0.0
    p["fadeIn"] = fade_in; p["fadeOut"] = fade_out
    if fade_out > 0.0 and fn < 0.92:
        why.append(f"no pop-out (retail ends {1-fn:.0%} opaque)")
    if fade_in > 0.0 and st < 0.5:
        why.append("no pop-in")

    # ---- erosion: dissolve, less where retail already thins it -------------------
    er = f["erode"] * (1.0 - 0.55 * fn)
    if beh == "trail": er *= 1.15
    if beh in ("burst", "implode"): er *= 0.9
    p["erode"] = clamp(er, 0.0, 0.6)
    if p["erode"] > 0.05:
        why.append("dissolves from its dim edges")

    # ---- flicker / twinkle ----------------------------------------------------------
    hz_scale = clamp((0.6 / max(0.05, S)) ** 0.3, 0.7, 1.4)
    p["flickerHz"] = f["flickerHz"] * hz_scale
    p["flicker"] = f["flicker"]
    p["twinkle"] = f["twinkle"]
    if family in ("fire", "flame_tongue", "mist_fire") and beh in ("standing", "plume", "stream", "flash"):
        p["flicker"] *= 1.15; why.append("hearth flicker")
    if family in ("fire", "flame_tongue") and beh in ("trail", "burst"):
        p["flicker"] *= 0.6
    if beh == "swarm" and family in ("star", "glow_point", "glow_orb", "specks"):
        p["twinkle"] = max(p["twinkle"], 0.25); why.append("swarm motes twinkle")

    # ---- spin: only radial-ish sprites on full 0..1 quads ---------------------------
    uvb = e["gfx"].get("uvBounds")
    full_uv = uvb == [0.0, 0.0, 1.0, 1.0]
    simple_quad = e["gfx"].get("nVerts") == 4
    radial = ft.get("radial", 0.0); edge = ft.get("edge", 1.0)
    spin_ok = f["spinOk"] and full_uv and simple_quad and edge < 0.16 and (radial > 0.45 or family in ("snow", "debris", "leaves", "blood", "liquid", "tendril", "vortex", "vortex_dark", "star", "star_dark"))
    if spin_ok and f["spinRate"] > 0:
        turns = f["spinRate"] * L
        if beh in ("burst", "implode"): turns *= 1.3
        p["spin"] = clamp(turns, 0.0, 1.6 if family in ("debris", "snow", "leaves", "vortex") else 0.9)
        if p["spin"] > 0.02:
            why.append("slow random roll breaks repetition" if family not in ("vortex", "vortex_dark") else "vortex turns")
    # ---- wobble -------------------------------------------------------------------
    p["wobble"] = f["wobble"]
    if p["wobble"] > 0 and family in ("fire", "flame_tongue"):
        why.append("licking UV turbulence")

    # ---- soft particles + near fade (scale with sprite size) ------------------------
    if f["softK"] > 0:
        p["soft"] = clamp(f["softK"] * S, f["softMin"], f["softMax"])
        why.append(f"soft {p['soft']:.2f} m against walls/ground")
    if f["nearK"] > 0:
        p["nearFade"] = clamp(f["nearK"] * S, f["nearMin"], f["nearMax"])

    # ---- lighting response ---------------------------------------------------------
    p["lit"] = f["lit"]
    if p["lit"] > 0:
        why.append("dims with night/indoor light")

    # ---- pulse ---------------------------------------------------------------------
    p["pulse"] = f["pulse"]; p["pulseHz"] = f["pulseHz"]

    # ---- context ----------------------------------------------------------------------
    if "portal" in tags and family in ("vortex", "ring_soft", "swirl_tex", "glow_orb", "mist_magic", "star"):
        p["pulse"] = max(p["pulse"], 0.07); p["pulseHz"] = 0.9
        if p["spin"] > 0: p["spin"] = clamp(p["spin"] * 1.3, 0, 1.6)
        why.append("portal breathing")
    if "lifestone" in tags and p.get("gain", 1) >= 1.0:
        p["pulse"] = max(p["pulse"], 0.08); p["pulseHz"] = 0.7
        why.append("lifestone pulse")
    if "hearth" in tags and family in ("fire", "flame_tongue", "mist_fire", "glow_orb", "faint_glow"):
        p["flicker"] = max(p["flicker"], 0.12 if family != "faint_glow" else 0.06)
        p["flickerHz"] = max(p["flickerHz"], 7.0)
    if "water" in tags and family in ("mist_white", "smoke_add", "smoke_light", "splash", "water_sheet", "water_streak", "bubbles"):
        p["lit"] = max(p["lit"], 0.55); p["soft"] = max(p["soft"], 0.4)
        why.append("water spray")
    if "buff" in tags and p["gain"] > 1.0:
        p["gain"] *= 1.05
    if ("debuff" in tags or "void" in tags) and p["gain"] > 1.0:
        p["gain"] = 1.0 + (p["gain"] - 1.0) * 0.75; p["sat"] *= 1.05
    if "splatter" in tags and family in ("blood", "blood_mist", "liquid"):
        p["fadeOut"] = max(p["fadeOut"], 0.2)
    if "celebration" in tags and family in ("star", "glow_point", "specks", "glow_orb"):
        p["twinkle"] = max(p["twinkle"], 0.35)
    if "fizzle" in tags:
        p["gain"] = min(p["gain"], 1.15); p["sat"] *= 0.8
        why.append("fizzle stays dull")

    # ---- edge soften: hard square quad borders -------------------------------------
    # Full-UV quads whose texture still carries energy in its outer frame show
    # the quad's straight edges; fade the last few % of UV. Never on surfaces
    # meant to fill or tile their quad, nor on clip-map (alpha-tested) sprites.
    if (full_uv and simple_quad and not ft.get("clip") and ft.get("border", 0.0) > 0.06
            and family not in ("swirl_tex", "water_sheet", "beam", "streak", "lightning", "rune", "ring_line",
                               "insect", "leaves", "debris", "solid_ball", "solid_shard", "solid_disc")):
        p["edgeSoft"] = clamp(0.06 + 0.5 * ft["border"], 0.06, 0.16)
        why.append("soft quad edges")

    # ---- sanitise ------------------------------------------------------------------
    for k in ("gain", "core", "sat", "tintCurve", "fadeIn", "fadeOut", "erode", "flicker", "flickerHz",
              "twinkle", "spin", "wobble", "soft", "nearFade", "lit", "pulse", "pulseHz", "edgeSoft"):
        p[k] = r3(p[k])
    p["tint0"] = [r3(x) for x in p["tint0"]]; p["tint1"] = [r3(x) for x in p["tint1"]]
    meta = dict(S=r3(S), L=r3(L), crowd=r3(crowd), nLive=r3(n_live))
    return family, beh, tags, p, why, meta


def main():
    overrides = {}
    od = os.path.join(HERE, "overrides")
    if os.path.isdir(od):
        for fn in sorted(os.listdir(od)):
            if fn.endswith(".json"):
                d = json.load(open(os.path.join(od, fn)))
                for k, v in d.get("emitters", {}).items():
                    try:
                        did = int(k, 16)
                    except ValueError:
                        continue
                    cur = overrides.setdefault(did, {"params": {}, "note": None, "family": None, "src": []})
                    if isinstance(v.get("params"), dict):
                        cur["params"].update(v["params"])
                    if v.get("note"):
                        cur["note"] = v["note"]
                    if v.get("family"):
                        cur["family"] = v["family"]
                    cur["src"].append(fn[:-5])
    out = {}
    for e in rows:
        res = build(e)
        if len(res) == 5:
            family, beh, tags, p, why = res; meta = {}
        else:
            family, beh, tags, p, why, meta = res
        did = e["id"]
        ov = overrides.get(did)
        note_ov = None
        if ov:
            for k, v in (ov.get("params") or {}).items():
                if k in p:
                    p[k] = v
            if ov.get("family") and ov["family"] in R:
                family = ov["family"]
            note_ov = ov.get("note")
        ctx0 = (e.get("ctx") or ["no script/setup context in the DAT"])[0]
        note = note_ov or (f"{R[family]['desc']} · {BEH_DESC.get(beh, beh)} · {ctx0}"
                           + (f" → {'; '.join(why)}" if why else ""))
        out[f"0x{did:08X}"] = dict(family=family, behavior=beh, tags=sorted(tags), params=p, note=note,
                                   reviewed=sorted(set(ov["src"])) if ov else [],
                                   meta=meta, surface=f"0x{(e['gfx']['surfaces'][0] if e['gfx']['surfaces'] else 0):08X}",
                                   gfx=f"0x{e['gfx']['id']:08X}")
    json.dump(out, open(os.path.join(WORK, "profiles.json"), "w"), indent=0)
    c = Counter((v["family"], v["behavior"]) for v in out.values())
    print(len(out), "profiles;", len({json.dumps(v["params"], sort_keys=True) for v in out.values()}), "distinct param sets")
    print(Counter(v["behavior"] for v in out.values()).most_common())


if __name__ == "__main__":
    main()
