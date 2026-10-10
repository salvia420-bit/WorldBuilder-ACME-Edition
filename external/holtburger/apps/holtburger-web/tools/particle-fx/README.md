# tools/particle-fx — the per-emitter particle upgrade pipeline

Produces `data/particle-fx-catalog.json` (one entry per retail ParticleEmitter +
every synthesized emitter kind: family, behaviour, a note on what the effect is
in game, upgrade params), from which `scripts/gen-particle-fx-profiles.mjs`
generates the runtime table `scene3d/particles/particle_fx_profiles.js` read by
`scene3d/particles/particle_fx.js` (`?particleFx`, see docs/url-flags.md).

Generated intermediates go to `$PFX_WORK` (default `tools/particle-fx/work/`,
gitignored). Committed inputs live here: `families.py`, `synth_profiles.json`,
`overrides/*.json`, `semantics.md`.

## Pipeline

```sh
cd apps/holtburger-web/tools/particle-fx
python3 datcat.py      # client_portal.dat → work/{emitters,scripts,tables,setups_fx}.json + work/thumbs/
python3 enrich.py      # + context: PlayScript names, LSD weenie names, CallPES parents → work/emitters_ctx.json
python3 features.py    # texture features (radial symmetry, edge energy, brightness, hue) → work/surface_features.json
python3 sheets.py      # labelled contact sheets of all 257 particle textures → work/sheets/ (for eyes)
python3 gen_profiles.py   # family recipe × behaviour × measured size/life/crowding × context
                          # + overrides/*.json (per key, files in name order) → work/profiles.json
python3 build_catalog.py ../../data/particle-fx-catalog.json   # clamp/validate + synthesized rows
python3 tier1.py       # tier 1 (2026-10-10): light / glow / children / distortion / smoke terms
                       # per emitter → ../../data/particle-fx-tier1.json (+ tier1_overrides.json)
cd ../.. && node scripts/gen-particle-fx-profiles.mjs          # → scene3d/particles/particle_fx_profiles.js
node test_particle_fx.mjs                                      # includes the "module not stale" guard
```

`make_packets.py` rebuilds the per-family review packets (work/packets/) that the
2026-10-09 review used; `semantics.md` is the reviewer brief (what every param
does on screen, safe ranges, output schema).

## The model

- **Family** (what the sprite IS) comes from the texture: all 257 particle
  surfaces in the DAT are filed by eye in `families.py` (fire, flame_tongue,
  smoke_dark/light/add, mist_magic, star, glow_orb, faint_glow, lightning,
  tendril, vortex, swirl_tex, rune, snow, blood, insect, … 44 families).
- **Behaviour** (how the emitter moves it) comes from the 0x32 record:
  standing / plume / stream / trail (per-metre) / burst / implode / swarm /
  fountain / flash / puff / drift.
- **Measured numbers** individualise the recipe: sprite size in metres
  (soft-particle distance, near fade, flicker rate), lifespan (fade fractions,
  spin turns), crowding (dense additive emitters get less gain so they do not
  blow out), retail start/final translucency (no double fades; pop-in/out
  removal only where retail pops), texture brightness/hue (gain compensation,
  hue-deepening afterglow), UV layout (spin only on full-UV 4-vertex quads).
- **Context** (PlayScript names, weenie names) adds signature tweaks: portal
  breathing, lifestone pulse, hearth flicker, water spray, buff/debuff, fizzle.
- **Review**: eight family reviewers read every emitter's data + context +
  texture, wrote a note per emitter and corrected params (`overrides/g*.json`);
  a consistency critic aligned multi-part effects (`overrides/zz_consistency.json`).
- `build_catalog.py` is the safety net: ranges clamped, spin zeroed on
  partial-UV quads, fades capped where retail already fades, misc/none/sky rows
  neutral.

## Tier 1 (2026-10-10)

`tier1.py` derives each emitter's tier-1 terms — FX light (intensity, range,
colour), glow share, GPU children (kind, count, size, life, spread), distortion
(kind, strength, radius), smoke shading (sunLit, noise, flow, shadow, rim) —
from its catalog family + behaviour, the measured sprite size / lifespan / live
count / texture colour, and context tags. The generator merges them into the
same rows (10 texels). Runtime + switches: `docs/HANDOFF-particle-fx-tier1-2026-10-10.md`.
Per-DID corrections: `tier1_overrides.json` (`{"emitters": {"0x…": {"light": 40, "kids": null}}}`).

## Editing one effect

Add or edit an entry in an override file (`{"emitters": {"0x3200026E": {"note": …,
"params": {"flicker": 0.2}}}}`), rerun `gen_profiles.py`, `build_catalog.py` and
the node generator. Or edit `data/particle-fx-catalog.json` directly and run the
node generator (the Python step would overwrite a hand edit, so prefer overrides).
