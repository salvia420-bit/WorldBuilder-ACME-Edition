#!/usr/bin/env python3
"""profiles.json (+ synth_profiles.json) -> data/particle-fx-catalog.json.

Validation is the safety net for reviewer edits nobody can eyeball:
  * every param clamped to its safe range (named/synthesized rows may pulse harder)
  * spin forced to 0 unless the GfxObj is a 4-vertex quad with full 0..1 UVs
    (the shader masks the rotated square; a tiled/partial-UV quad would vanish)
  * misc / none / sky rows forced neutral (sky chain is excluded at runtime too)
  * fadeOut capped when retail already fades the particle out
Reports every clamp so it can be reviewed.
"""
import json, os, sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.environ.get("PFX_WORK") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "work")
os.makedirs(WORK, exist_ok=True)
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "..", "data", "particle-fx-catalog.json")

P = json.load(open(os.path.join(WORK, "profiles.json")))
SYN = json.load(open(os.path.join(HERE, "synth_profiles.json")))
E = {f"0x{e['id']:08X}": e for e in json.load(open(os.path.join(WORK, "emitters_ctx.json")))}
sys.path.insert(0, HERE)
import gen_profiles as G  # noqa: E402  (family descriptions)

LAYOUT = ["gain", "core", "sat", "tintCurve", "tint0r", "tint0g", "tint0b", "fadeIn",
          "tint1r", "tint1g", "tint1b", "fadeOut", "erode", "flicker", "flickerHz", "twinkle",
          "spin", "wobble", "soft", "nearFade", "lit", "pulse", "pulseHz", "edgeSoft"]
RANGE = dict(gain=(0.6, 2.4), core=(0.0, 1.3), sat=(0.0, 1.4), tintCurve=(0.4, 3.0), fadeIn=(0.0, 0.35),
             fadeOut=(0.0, 0.6), erode=(0.0, 0.6), flicker=(0.0, 0.5), flickerHz=(0.5, 24.0), twinkle=(0.0, 0.45),
             spin=(0.0, 1.6), wobble=(0.0, 0.04), soft=(0.0, 2.5), nearFade=(0.0, 3.0), lit=(0.0, 1.0),
             pulse=(0.0, 0.15), pulseHz=(0.2, 4.0), edgeSoft=(0.0, 0.3))
NEUTRAL = dict(G.NEUTRAL)
clamps = Counter()
clamp_log = []


def norm(params, did, named=False, emitter=None):
    p = dict(NEUTRAL)
    p["tint0"] = [1.0, 1.0, 1.0]; p["tint1"] = [1.0, 1.0, 1.0]
    for k, v in (params or {}).items():
        if k in ("tint0", "tint1"):
            if isinstance(v, (list, tuple)) and len(v) == 3:
                p[k] = [float(x) for x in v]
        elif k in p:
            try:
                p[k] = float(v)
            except (TypeError, ValueError):
                pass
    for k, (lo, hi) in RANGE.items():
        hi2 = 0.8 if (named and k == "pulse") else hi
        lo2 = 0.0 if (named and k == "sat") else lo
        v = p[k]
        if v != v:  # NaN
            v = NEUTRAL[k]
        if v < lo2 or v > hi2:
            clamps[k] += 1
            clamp_log.append(f"{did} {k} {v} -> [{lo2},{hi2}]")
            v = min(hi2, max(lo2, v))
        p[k] = round(v, 4)
    for k in ("tint0", "tint1"):
        t = []
        for x in p[k]:
            if x < 0.3 or x > 1.45:
                clamps[k] += 1
                clamp_log.append(f"{did} {k} {x}")
            t.append(round(min(1.45, max(0.3, x)), 4))
        p[k] = t
    if emitter is not None and p["spin"] > 0:
        g = emitter["gfx"]
        if g.get("uvBounds") != [0.0, 0.0, 1.0, 1.0] or g.get("nVerts") != 4:
            clamps["spin-uv"] += 1
            clamp_log.append(f"{did} spin {p['spin']} -> 0 (uv {g.get('uvBounds')}, verts {g.get('nVerts')})")
            p["spin"] = 0.0
    if emitter is not None and emitter["finalTrans"] >= 0.92 and p["fadeOut"] > 0.12:
        clamps["fadeOut-retailfade"] += 1
        clamp_log.append(f"{did} fadeOut {p['fadeOut']} -> 0.12 (retail finalTrans {emitter['finalTrans']:.2f})")
        p["fadeOut"] = 0.12
    if emitter is not None and emitter["startTrans"] >= 0.85 and p["fadeIn"] > 0.08:
        clamps["fadeIn-retailfade"] += 1
        p["fadeIn"] = 0.08
    return p


def row_of(p):
    return [p["gain"], p["core"], p["sat"], p["tintCurve"], *p["tint0"], p["fadeIn"], *p["tint1"], p["fadeOut"],
            p["erode"], p["flicker"], p["flickerHz"], p["twinkle"], p["spin"], p["wobble"], p["soft"], p["nearFade"],
            p["lit"], p["pulse"], p["pulseHz"], p["edgeSoft"]]


emitters = {}
for did, v in sorted(P.items()):
    fam = v["family"]
    if fam in ("misc", "none", "sky"):
        p = norm({}, did)
    else:
        p = norm(v["params"], did, emitter=E[did])
    emitters[did] = dict(family=fam, behavior=v["behavior"], note=v["note"], params=p, surface=v["surface"],
                         gfx=v["gfx"], tags=v.get("tags") or [], reviewed=v.get("reviewed") or [])

synth = {}
for name, v in SYN.items():
    p = norm(v["params"], name, named=True)
    synth[name] = dict(ids=v.get("ids") or [], family=v["family"], sprite=v["sprite"], note=v["note"], params=p)

families = {k: v["desc"] for k, v in G.R.items()}
cat = {
    "version": 1,
    "description": "Per-emitter particle FX upgrade catalog for holtburger-web (?particleFx). One entry per retail "
                   "ParticleEmitter (0x32) in client_portal.dat + every synthesized Visual-Behavior-Suite emitter. "
                   "Generated by tools/particle-fx (DAT extraction + family/behaviour generator + per-family review); "
                   "scripts/gen-particle-fx-profiles.mjs turns it into scene3d/particles/particle_fx_profiles.js.",
    "layout": LAYOUT,
    "families": families,
    "emitters": emitters,
    "synthesized": synth,
}
rows = {json.dumps(row_of(x["params"])) for x in list(emitters.values()) + list(synth.values())}


def slim(p):
    out = {}
    for k, v in p.items():
        if k in ("tint0", "tint1"):
            if v != [1.0, 1.0, 1.0]:
                out[k] = v
        elif v != NEUTRAL[k]:
            out[k] = v
    if "flickerHz" in out and not out.get("flicker") and not out.get("twinkle"):
        del out["flickerHz"]
    if "pulseHz" in out and not out.get("pulse"):
        del out["pulseHz"]
    if "tintCurve" in out and "tint0" not in out and "tint1" not in out:
        del out["tintCurve"]
    return out


for d in (emitters, synth):
    for v in d.values():
        v["params"] = slim(v["params"])
# One entry per line: diff-friendly, ~half the size of an indented dump.
with open(OUT, "w") as f:
    f.write("{\n")
    f.write(f' "version": {cat["version"]},\n "description": {json.dumps(cat["description"])},\n')
    f.write(f' "layout": {json.dumps(LAYOUT)},\n')
    f.write(' "families": {\n' + ",\n".join(f"  {json.dumps(k)}: {json.dumps(v, ensure_ascii=False)}" for k, v in families.items()) + "\n },\n")
    f.write(' "emitters": {\n' + ",\n".join(f"  {json.dumps(k)}: {json.dumps(v, ensure_ascii=False, separators=(',', ':'))}" for k, v in emitters.items()) + "\n },\n")
    f.write(' "synthesized": {\n' + ",\n".join(f"  {json.dumps(k)}: {json.dumps(v, ensure_ascii=False, separators=(',', ':'))}" for k, v in synth.items()) + "\n }\n}\n")
json.load(open(OUT))
open(os.path.join(WORK, "clamp_log.txt"), "w").write("\n".join(clamp_log))
print(f"catalog: {len(emitters)} emitters, {len(synth)} synthesized, {len(rows)} distinct rows -> {OUT}")
print("clamps:", dict(clamps))
print("reviewed emitters:", sum(1 for x in emitters.values() if x["reviewed"]))
