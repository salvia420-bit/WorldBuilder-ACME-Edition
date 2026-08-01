// Per-effect VFX flag readers — Visual-Behavior Suite, Phase 1 (2026-06-23).
//
// The ?visual master gate (vfx_catalog.js visualEnabled()) turns the
// descriptor-catalog VFX path ON; these per-effect flags pick WHICH cheap-
// fragment effects within that path are live. Every per-effect flag is a
// NON-RETAIL enhancement and defaults to visualAllEffects() — DEFAULT-ON
// since the 2026-06-24 suite validation (`?visualAll=off` drops them all,
// a per-effect `=off` drops one; `?visual=off` kills the whole suite).
//
// THE FIREWALL AT THE FLAG LAYER: an effect is active iff
//   visualEnabled()  AND  <its per-effect flag>
// — gating on BOTH means a per-effect flag alone (e.g. ?glint=on without
// ?visual) NEVER builds a VFX material variant. vfxEffectEnabled(id) is the one
// gate the frag-install path + each component installer consult.
//
// `?visual=all` (or `?visualAll=on`) is the one-URL "light everything" switch:
// it flips the master gate on AND defaults every per-effect flag on, so the 1070
// eye-test can A/B the whole suite in one URL; opt out per effect with
// `?glint=off` etc.
//
// `?visualBudget` is a governor STUB — parsed + memoized now so the future
// bloom/light governor (build spec §10/§11) can read a cap without a later
// flag-plumbing change; nothing consumes it yet (queued-for-1070).
//
// Import-cycle-safe: imports ONLY visualEnabled from vfx_catalog.js, which
// imports nothing from the scene3d graph. No back-edges → no static cycle.
// Lint-clean by construction (no Math.random / argless Date.now / .visible= /
// wire / per-instance cache key); this module lives outside scene3d/vfx/
// components/ so the legacy-safety component sweep does not scan it, but it is
// kept clean regardless.

import { visualEnabled } from "./vfx_catalog.js";

function _strFlag(name) {
  try {
    if (typeof window !== "undefined" && window.location) {
      return new URLSearchParams(window.location.search).get(name);
    }
  } catch (_) { /* default */ }
  return null;
}

function _boolFlag(name, def) {
  const v = _strFlag(name);
  if (v == null) return def;
  const s = v.toLowerCase();
  if (s === "on" || s === "1" || s === "true" || s === "yes") return true;
  if (s === "off" || s === "0" || s === "false" || s === "no" || s === "") return false;
  return def;
}

function _numFlag(name, def, min, max) {
  const v = _strFlag(name);
  const n = v == null ? NaN : parseFloat(v);
  if (Number.isFinite(n) && (min == null || n >= min) && (max == null || n <= max)) return n;
  return def;
}

let _materialBake;
/** Phase-5 — `?material=off` escapes the baked roughness detail maps. DEFAULT-ON
 *  (the conservative remap cannot chrome; look-polish owed to a 1070 eye-test).
 *  `?material=off` ⇒ exact pre-Phase-5 material (no roughnessMap from the bake). */
export function materialBakeEnabled() {
  if (_materialBake !== undefined) return _materialBake;
  let on = true; // default-on; ?material=off is the escape
  const v = _strFlag("material");
  if (v != null) { const s = v.toLowerCase(); on = s !== "off" && s !== "0" && s !== "false" && s !== "no" && s !== ""; }
  return (_materialBake = on);
}

let _aoIntensity;
/** Cavity-AO strength for the Phase-5 texchan `aoMap` (materials.js
 *  `_applyRough`) and the statics-atlas nra alpha channel (static_atlas.js).
 *  Default 0.6 — the conservative value both paths hardcoded before this flag
 *  existed, so an absent `?aoIntensity` is byte-identical to the old build.
 *  AO can only darken, never brighten, so higher values deepen mortar lines and
 *  crevices. Clamped to [0, 3]; a non-numeric value falls back to the default.
 */
export function aoMapIntensityValue() {
  if (_aoIntensity !== undefined) return _aoIntensity;
  let v = 0.6;
  const raw = _strFlag("aoIntensity");
  if (raw != null) {
    const n = Number(raw);
    if (Number.isFinite(n)) v = Math.min(3, Math.max(0, n));
  }
  return (_aoIntensity = v);
}

let _all;
/** Per-effect default. DEFAULT-ON (2026-06-24: validated suite ships on). Every
 *  per-effect flag defaults to this, so absent any URL flag all effects are on
 *  (still composed with the ?visual master gate by vfxEffectEnabled()). Escapes:
 *  `?visualAll=off` drops ALL per-effects (master stays on); `?<effect>=off` opts
 *  one out; `?visual=off` kills the whole suite. `?visual=all` still forces on. */
export function visualAllEffects() {
  if (_all !== undefined) return _all;
  let on = _boolFlag("visualAll", true); // default-on; ?visualAll=off drops per-effects
  if (!on) {
    const v = _strFlag("visual");
    if (v != null && v.toLowerCase() === "all") on = true;
  }
  return (_all = on);
}

let _glint;
/** `?glint=on` — emissive.glint specular sparkle on metal. DEFAULT-ON via visualAllEffects(); `=off` opts out. */
export function glintEnabled() {
  if (_glint === undefined) _glint = _boolFlag("glint", visualAllEffects());
  return _glint;
}

let _magicGlow;
/** `?magicGlow=on` — emissive.magicGlow ambient glow on magic items. DEFAULT-ON via visualAllEffects(); `=off` opts out. */
export function magicGlowEnabled() {
  if (_magicGlow === undefined) _magicGlow = _boolFlag("magicGlow", visualAllEffects());
  return _magicGlow;
}

let _enchantShimmer;
/** `?enchantShimmer=on` — emissive.enchantShimmer pulse on enchanted gear. DEFAULT-ON via visualAllEffects(); `=off` opts out. */
export function enchantShimmerEnabled() {
  if (_enchantShimmer === undefined) _enchantShimmer = _boolFlag("enchantShimmer", visualAllEffects());
  return _enchantShimmer;
}

let _tarnish;
/** `?tarnish=on` — weathering.tarnish metal patina + crevice darkening. DEFAULT-ON via visualAllEffects(); `=off` opts out. */
export function tarnishEnabled() {
  if (_tarnish === undefined) _tarnish = _boolFlag("tarnish", visualAllEffects());
  return _tarnish;
}

let _wetness;
/** `?wetness=on` — weathering.wetness global rain sheen. DEFAULT-ON via visualAllEffects(); `=off` opts out. */
export function wetnessEnabled() {
  if (_wetness === undefined) _wetness = _boolFlag("wetness", visualAllEffects());
  return _wetness;
}

let _frost;
/** `?frost=on` — weathering.frost winter-zone frost/ice. DEFAULT-ON via visualAllEffects(); `=off` opts out. */
export function frostEnabled() {
  if (_frost === undefined) _frost = _boolFlag("frost", visualAllEffects());
  return _frost;
}

let _flameFlicker;
/** `?flameFlicker=on` — light.flameFlicker torch/brazier intensity jitter. DEFAULT-ON via visualAllEffects(); `=off` opts out. */
export function flameFlickerEnabled() {
  if (_flameFlicker === undefined) _flameFlicker = _boolFlag("flameFlicker", visualAllEffects());
  return _flameFlicker;
}

let _tipFlex;
/** `?tipFlex=on` — deformation.tipFlex GPU (MECH-B) spear/staff/wand tip-sway: the
 *  FIRST vertex-displacement effect. Default-OFF, composed under the ?visual master
 *  gate (and lit by ?visual=all for the 1070 batch). Consumed in TWO places:
 *  (a) as the tipFlex component's `enabled` gate — frag_attach.fragEntriesForDescriptor
 *  drops the MECH-B entry when off, so statics/entities stay byte-identical without a
 *  seam change; (b) at the entities.js catalog-plan seam (whether to resolve the plan
 *  at all). DEFAULT-ON via visualAllEffects(); `=off` opts out. */
export function tipFlexEnabled() {
  if (_tipFlex === undefined) _tipFlex = _boolFlag("tipFlex", visualAllEffects());
  return _tipFlex;
}

let _gemSparkle;
/** `?gemSparkle=on` — particle.gemSparkle synthesized additive twinkle on magic
 *  gems/crystals: the FIRST synthesized-emitter (MECH "particle") effect, the Phase-3
 *  minimal vertical slice (like tipFlex was for Phase 2). Default-OFF, composed under
 *  the ?visual master gate (and lit by ?visual=all for the 1070 batch). Consumed as the
 *  gemSparkle component's `enabled` gate — particle_attach.particleEntriesForDescriptor
 *  drops the emitter entry when off, so statics/entities stay byte-identical (no emitter
 *  synthesized, no addEmitter call) without a seam change. DEFAULT-ON via visualAllEffects(); `=off` opts out. */
export function gemSparkleEnabled() {
  if (_gemSparkle === undefined) _gemSparkle = _boolFlag("gemSparkle", visualAllEffects());
  return _gemSparkle;
}

let _brazier;
/** `?brazier=on` — particle.brazierEmbers synthesized embers+smoke on flame-bowl
 *  braziers/torches (P3.6). TWO persistent emitters (additive embers + alpha smoke)
 *  anchored to the bowl part. Default-OFF, composed under ?visual (lit by ?visual=all).
 *  Consumed as the brazierEmbers component's `enabled` gate — off ⇒ no emitter ⇒
 *  byte-identical. The classifier gates this OUT for default_script-bearing DIDs
 *  (Track-B coexistence). DEFAULT-ON via visualAllEffects(); `=off` opts out. */
export function brazierEnabled() {
  if (_brazier === undefined) _brazier = _boolFlag("brazier", visualAllEffects());
  return _brazier;
}

let _foliagePollen, _foliageFireflies, _foliageLeaves, _breathFog;
/** `?foliagePollen=on` — particle.foliagePollen daytime soft motes. DEFAULT-ON via visualAllEffects(); `=off` opts out. */
export function foliagePollenEnabled() {
  if (_foliagePollen === undefined) _foliagePollen = _boolFlag("foliagePollen", visualAllEffects());
  return _foliagePollen;
}
/** `?foliageFireflies=on` — particle.foliageFireflies dusk/night additive swarm. DEFAULT-ON via visualAllEffects(); `=off` opts out. */
export function foliageFirefliesEnabled() {
  if (_foliageFireflies === undefined) _foliageFireflies = _boolFlag("foliageFireflies", visualAllEffects());
  return _foliageFireflies;
}
/** `?foliageLeaves=on` — particle.foliageLeaves canopy falling leaves. DEFAULT-ON via visualAllEffects(); `=off` opts out. */
export function foliageLeavesEnabled() {
  if (_foliageLeaves === undefined) _foliageLeaves = _boolFlag("foliageLeaves", visualAllEffects());
  return _foliageLeaves;
}
/** `?breathFog=on` — particle.breathFog creature head cold-breath puff. DEFAULT-ON via visualAllEffects(); `=off` opts out. */
export function breathFogEnabled() {
  if (_breathFog === undefined) _breathFog = _boolFlag("breathFog", visualAllEffects());
  return _breathFog;
}

// ---------------------------------------------------------------------------
// TERRAIN VFX (Wave 0B — docs/2026-07-31-terrain-vfx-plan.md §2.4).
//
// These do NOT default to visualAllEffects(). Every terrain-VFX flag is a
// STRICT exact-match opt-in that ships OFF (plan §5.9) and is deliberately kept
// out of `quality.js BOOL_FLAGS` so `parseBool` cannot widen `=== "on"` to
// `1`/`true`/`yes` — the same rule `gfxRelief` follows and the same reason.
// The ONE exception is the master kill switch, which is an opt-OUT by design.
// ---------------------------------------------------------------------------

/** Quality-preset bag, read through the canonical runtime idiom
 *  (`particles/particle_emitter.js:213`). Null pre-init / in node. */
function _presetFlags() {
  try {
    if (typeof window !== "undefined" && window.liveScene3d?.quality?.flags) {
      return window.liveScene3d.quality.flags;
    }
  } catch (_) { /* fail-soft */ }
  return null;
}

let _terrainVfx;
/** `?terrainVfx=off` — THE master kill switch for the whole terrain-VFX
 *  programme (grass, sand, rock, snow, swamp, volcano, dirt). DEFAULT-ON as an
 *  opt-OUT because the spine (`scene3d/terrain_vfx.js`) is INERT until a family
 *  provider registers, and every family flag ships OFF — so a bare default
 *  boots byte-identical while `=off` guarantees one URL kills everything.
 *  `?wireframe=1` is a second, independent kill (plan §8 risk 8), enforced once
 *  in `terrain_vfx.js::wireframeActive`. */
export function terrainVfxEnabled() {
  if (_terrainVfx === undefined) _terrainVfx = _boolFlag("terrainVfx", true);
  return _terrainVfx;
}

let _terrainGrass;
let _terrainGrassWarned = false;
/** `?terrainGrass=on` — the §3.1 GRASS family (`scene3d/terrain_grass.js`):
 *  one camera-scoped instanced blade field over terrain codes 1/3/9/21/28/29,
 *  wind-bent off the tree-wind gust function and crushed flat by the trail map.
 *  STRICT exact-match opt-in (the `gfx_relief.js:137` argument: a silent no-op
 *  on a typo is indistinguishable from a broken decode, so anything
 *  unrecognised warns and does NOT enable). Absent ⇒ the quality preset's
 *  `terrainGrass`, **false on all four tiers this wave** (§5.9 ship-OFF; the
 *  promotion target is high/ultra true). The preset branch is NOT memoized: it
 *  may be consulted before `window.liveScene3d.quality` exists and caching
 *  "not ready" would stick. */
export function terrainGrassEnabled() {
  if (_terrainGrass !== undefined) return _terrainGrass;
  const raw = _strFlag("terrainGrass");
  if (raw === "on") return (_terrainGrass = true);
  if (raw === "off") return (_terrainGrass = false);
  if (raw !== null && !_terrainGrassWarned) {
    _terrainGrassWarned = true;
    // eslint-disable-next-line no-console
    console.warn(
      `[terrainGrass] ignoring ?terrainGrass=${JSON.stringify(raw)} — the master flag is an EXACT-match opt-in; use ?terrainGrass=on (or =off).`,
    );
  }
  const flags = _presetFlags();
  if (!flags) return false;             // deliberately not memoized
  return (_terrainGrass = flags.terrainGrass === true);
}

let _terrainGrassStomp;
let _terrainGrassStompWarned = false;
/** `?terrainGrassStomp=on` — let the blades read the shared trail map and bend
 *  down/splay where something walked. SEPARATE from the master flag so the
 *  trail render target can be bisected independently of the blade field (plan
 *  §3.1). STRICT exact-match opt-in, same shape as `terrainGrass`; absent ⇒ the
 *  preset's `terrainGrassStomp` (false on low/mid, false on high/ultra this
 *  wave; the promotion target is high/ultra true).
 *  ⚠ It needs the map to EXIST: the trail map is constructed by
 *  `terrain_vfx.js::initTerrainVfx` only under `?terrainTrail=on` (or a preset
 *  with `terrainTrail: true`). With the map absent the blades simply never bend
 *  — `uTrailEnabled` stays 0 — rather than erroring. */
export function terrainGrassStompEnabled() {
  if (_terrainGrassStomp !== undefined) return _terrainGrassStomp;
  const raw = _strFlag("terrainGrassStomp");
  if (raw === "on") return (_terrainGrassStomp = true);
  if (raw === "off") return (_terrainGrassStomp = false);
  if (raw !== null && !_terrainGrassStompWarned) {
    _terrainGrassStompWarned = true;
    // eslint-disable-next-line no-console
    console.warn(
      `[terrainGrassStomp] ignoring ?terrainGrassStomp=${JSON.stringify(raw)} — the master flag is an EXACT-match opt-in; use ?terrainGrassStomp=on (or =off).`,
    );
  }
  const flags = _presetFlags();
  if (!flags) return false;             // deliberately not memoized
  return (_terrainGrassStomp = flags.terrainGrassStomp === true);
}

/** `?terrainGrassBlades` — instances in the blade pool (the DEGRADE LEVER for a
 *  vertex-bound effect; render scale buys grass nothing — plan §3.1). Preset key
 *  `terrainGrassBlades`: low 0 (the tier is disabled, §5.8) / mid 24336 (156²) /
 *  high 60025 (245²) / ultra 119716 (346²). The pool rounds any count UP to a
 *  perfect square. Fallback 60025. */
export function terrainGrassBladeCount() {
  return Math.round(_terrainNum("terrainGrassBlades", "terrainGrassBlades", 60025, 0, 1000000));
}

/** `?terrainGrassRadius` — HALF-extent of the blade field in metres (it covers
 *  2x this). Preset key `terrainGrassRadius`: low 32 / mid 32 / high 48 /
 *  ultra 64. Fallback 48. Raising it at a fixed blade count thins the field. */
export function terrainGrassRadiusM() {
  return _terrainNum("terrainGrassRadius", "terrainGrassRadius", 48, 4, 512);
}

/** `?terrainGrassDensity` — 0..2 multiplier on the tier blade count, default
 *  1.0. URL-ONLY on purpose (no preset key): it is the continuous A/B knob for
 *  the 1070 perf sweep, while the tier owns the shipped count. 0 disables. */
export function terrainGrassDensity() {
  return _numFlag("terrainGrassDensity", 1, 0, 2);
}

// ---------------------------------------------------------------------------
// THE TRAIL MAP AND ITS THREE WRITERS (promotion-readiness, 2026-08-01).
//
// Three effects stamp the shared map — grass stomp, snow prints, mud prints —
// and every one of them is a SILENT no-op when the map was never built (the
// families deliberately never lazy-create it). That is the exact failure
// `gfx_relief.js:137` argues against, and it is the promotion trap: an owner
// approves `?terrainSnow=on&terrainSnowPrints=on`, sees nothing, and cannot
// tell a missing map from a broken decode.
//
// So the writers IMPLY the map. `_trailFadeClaims` is the one list both
// `terrainTrailEnabled` (any claimant ⇒ build it) and `terrainTrailRecoverySec`
// (longest claim wins) read, so the two can never disagree about who is live.
// An EXPLICIT `?terrainTrail=off` still wins — it is the bisection knob — and
// warns that the writers are now no-ops.
//
// The fade table lives HERE rather than in `trail_map.js` because
// `terrain_snow.js` and `terrain_dirt.js` must read it while keeping their
// "this module never imports trail_map.js" invariant (no lazy-ensure, no second
// render target) — and they already import this file.
// ---------------------------------------------------------------------------

/**
 * The fade each trail-writing family asks for. A texel in the map is ONE scalar
 * in an R8 target: no room for a per-print age, owner or rate, and a second
 * channel would need a sampler the terrain shader does not have (15 of a
 * guaranteed 16 are bound — the wave-2A ruling in the `terrain_snow.js`
 * header). So the three families share ONE fade and these three numbers, two
 * orders of magnitude apart, have to be reconciled. One place, so no family
 * can drift from the reader that applies its ask.
 */
export const TRAIL_FAMILY_FADE_SEC = Object.freeze({
  grassStomp: 4,    // blade springback (plan §3.1)
  mudPrints: 30,    // "slow recovery (~30 s)" (plan §3.7 item 2)
  snowPrints: 300,  // effectively infinite; also the trail map's clamp ceiling
});

/**
 * LONGEST WINS. Resolve the fade a set of simultaneous claims deserves.
 *
 * WHY THE MAXIMUM and not a per-print tag: with one scalar per texel a fade
 * SHORTER than a family asked for DESTROYS that family's effect outright (a 4 s
 * grass springback erases a snow footprint before it can be seen), while a fade
 * LONGER than asked for only makes a shorter-lived effect linger — and the
 * map's own `2R` extent already scrolls a print out of existence in ~24 s of
 * running, which bounds "linger" for everyone. One direction of the error is
 * unrecoverable and the other is not, so the max is the only correct pick.
 *
 * @param {Array<{id:string, sec:number}>} claims
 * @returns {{sec:number|null, claimants:string[]}} `sec` null ⇒ nobody claimed.
 */
export function longestTrailFadeClaim(claims) {
  let sec = null;
  const claimants = [];
  for (const c of claims || []) {
    if (!c || !Number.isFinite(c.sec)) continue;
    claimants.push(c.id);
    if (sec === null || c.sec > sec) sec = c.sec;
  }
  return { sec, claimants };
}

/** The trail-writing effects that are live right now, with the fade each asks
 *  for (`trail_map.js::TRAIL_FAMILY_FADE_SEC`). Each row composes its family
 *  master exactly as the `VFX_EFFECT_FLAGS` row for the same id does. */
function _trailFadeClaims() {
  const out = [];
  // `?visual=off` kills every one of these rows through `vfxEffectEnabled`, so
  // a claim under it would imply a render target for effects that cannot draw.
  if (!visualEnabled()) return out;
  if (terrainGrassEnabled() && terrainGrassStompEnabled()) {
    out.push({ id: "terrain.grassStomp", sec: TRAIL_FAMILY_FADE_SEC.grassStomp });
  }
  if (terrainSnowEnabled() && terrainSnowPrintsEnabled()) {
    out.push({ id: "terrain.snowPrints", sec: TRAIL_FAMILY_FADE_SEC.snowPrints });
  }
  if (terrainDirtEnabled() && terrainMudPrintsEnabled()) {
    out.push({ id: "terrain.mudPrints", sec: TRAIL_FAMILY_FADE_SEC.mudPrints });
  }
  return out;
}

/** Effect ids currently writing the trail map — `[]` on a bare default. The
 *  diagnostic half of the implied promotion (`window.__terrainVfx.stats()`). */
export function terrainTrailWriters() {
  return _trailFadeClaims().map((c) => c.id);
}

let _terrainTrail;
let _terrainTrailWarned = false;
let _terrainTrailImpliedLogged = false;
let _terrainTrailSuppressedWarned = false;
/** `?terrainTrail=on` — the shared stomp/footprint trail map
 *  (`scene3d/trail_map.js`): one R8 render target centred on the player that
 *  grass reads to flatten blades, snow to dent drifts and mud to keep a print.
 *  STRICT exact-match opt-in; anything unrecognised warns and does NOT enable
 *  (a silent no-op here is indistinguishable from a broken decode —
 *  `gfx_relief.js:137` makes exactly this argument).
 *  RESOLUTION ORDER: `=on` ⇒ on · `=off` ⇒ off (and the writers are told they
 *  will no-op) · the quality preset's `terrainTrail` · IMPLIED by any live
 *  trail-writing effect (see `_trailFadeClaims`, logged once) · off.
 *  A bare default has no writers, so it resolves exactly as it did before the
 *  implication existed.
 *  The preset branch is NOT memoized: it may be consulted before
 *  `window.liveScene3d.quality` exists, and caching "not ready" would stick. */
export function terrainTrailEnabled() {
  if (_terrainTrail !== undefined) return _terrainTrail;
  const raw = _strFlag("terrainTrail");
  if (raw === "on") return (_terrainTrail = true);
  if (raw === "off") {
    // EXPLICIT off beats the implication below — but say what it costs, once.
    const writers = terrainTrailWriters();
    if (writers.length > 0 && !_terrainTrailSuppressedWarned) {
      _terrainTrailSuppressedWarned = true;
      // eslint-disable-next-line no-console
      console.warn(
        `[terrainTrail] ?terrainTrail=off with ${writers.join(", ")} enabled — the map is NOT built, so those stamps and the shader reads they feed will silently no-op. Drop ?terrainTrail=off to let the family imply the map.`,
      );
    }
    return (_terrainTrail = false);
  }
  // One-shot: the branches below deliberately do not always memoize, so this
  // reader can run every init — the warn must not become a log flood.
  if (raw !== null && !_terrainTrailWarned) {
    _terrainTrailWarned = true;
    // eslint-disable-next-line no-console
    console.warn(
      `[terrainTrail] ignoring ?terrainTrail=${JSON.stringify(raw)} — the master flag is an EXACT-match opt-in; use ?terrainTrail=on (or =off).`,
    );
  }
  const flags = _presetFlags();
  if (flags && flags.terrainTrail === true) return (_terrainTrail = true);
  const writers = terrainTrailWriters();
  if (writers.length > 0) {
    if (!_terrainTrailImpliedLogged) {
      _terrainTrailImpliedLogged = true;
      // eslint-disable-next-line no-console
      console.log(
        `[terrainTrail] implied ON by ${writers.join(", ")} — the shared trail map is a PROMOTION of those effects, not a default. ?terrainTrail=off suppresses it (and makes them no-ops).`,
      );
    }
    return (_terrainTrail = true);
  }
  if (!flags) return false;             // deliberately not memoized
  return (_terrainTrail = false);
}

/** Numeric knob shared shape: URL wins, then the quality preset, then a
 *  hardcoded fallback (the `gfx_relief.js` `base` composition, minus the
 *  static quality.js import that would give vfx_flags.js a new module edge). */
function _terrainNum(name, key, def, min, max) {
  const v = _numFlag(name, NaN, min, max);
  if (Number.isFinite(v)) return v;
  const flags = _presetFlags();
  const q = flags ? Number(flags[key]) : NaN;
  if (Number.isFinite(q) && q >= min && q <= max) return q;
  return def;
}

/** `?terrainTrailRes` — trail-map texels per side. Preset key `terrainTrailRes`
 *  (low 128 / mid 128 / high 256 / ultra 512). Fallback 256 = 0.375 m/texel at
 *  the default 96 m extent (plan §8 risk 7 — coarse for one footprint). */
export function terrainTrailResolution() {
  return Math.round(_terrainNum("terrainTrailRes", "terrainTrailRes", 256, 16, 2048));
}

/** `?terrainTrailRadius` — HALF-extent in metres; the map covers 2× this.
 *  Preset key `terrainTrailRadius`. Fallback 48 m (a 96 m square). */
export function terrainTrailRadiusM() {
  return _terrainNum("terrainTrailRadius", "terrainTrailRadius", 48, 4, 512);
}

/**
 * `?terrainTrailFade` — seconds for a full stomp to recover to zero, WITH its
 * provenance. The four claimants, in order:
 *
 *   url     an explicit in-range `?terrainTrailFade=` ALWAYS wins. It is the
 *           A/B knob; a number the operator typed must never be silently
 *           raised by a family that happens to be on.
 *   family  the LONGEST of the live trail-writing effects' asks
 *           (`trail_map.js::TRAIL_FAMILY_FADE_SEC`, longest-wins rationale in
 *           `longestTrailFadeClaim`) — but only when it beats the preset, so
 *           the two lower layers compose as "longest wins" too.
 *   preset  the tier's `terrainTrailFade`.
 *   fallback 4 s = grass springback (plan §3.1).
 *
 * With no family live this is byte-identical to the old URL > preset > 4.
 */
export function terrainTrailFadeSource() {
  const url = _numFlag("terrainTrailFade", NaN, 0.05, 300);
  if (Number.isFinite(url)) return { sec: url, source: "url", claimants: terrainTrailWriters() };
  const claim = longestTrailFadeClaim(_trailFadeClaims());
  const flags = _presetFlags();
  const q = flags ? Number(flags.terrainTrailFade) : NaN;
  const preset = (Number.isFinite(q) && q >= 0.05 && q <= 300) ? q : null;
  if (claim.sec !== null && (preset === null || claim.sec > preset)) {
    return { sec: claim.sec, source: "family", claimants: claim.claimants };
  }
  if (preset !== null) return { sec: preset, source: "preset", claimants: claim.claimants };
  return { sec: 4, source: "fallback", claimants: claim.claimants };
}

/** Seconds for a full stomp to recover to zero — see `terrainTrailFadeSource`
 *  for the precedence. NOT memoized: the answer moves with the live family set,
 *  exactly as the old preset lookup moved with `liveScene3d.quality`. */
export function terrainTrailRecoverySec() {
  return terrainTrailFadeSource().sec;
}

// ---------------------------------------------------------------------------
// TERRAIN SAND / DESERT (Wave 1B — plan §3.2). Codes 10, 11, 12 = FAM_SAND.
//
// FOUR flags, one family master + three effects, ALL strict exact-match opt-ins
// that ship OFF (plan §2.4/§5.9), all kept out of `quality.js BOOL_FLAGS` for
// the `gfxRelief` reason. Composition:
//     streamers = terrainSandEnabled() && terrainSandStreamersEnabled()
//     devils    = terrainSandEnabled() && terrainSandDevilsEnabled()
//     sparkle   = terrainSandEnabled() && terrainSandSparkleEnabled()
// The MASTER (`?terrainSand`) is what ships OFF on every tier; the three
// sub-flags fall back to their quality-preset value when absent so that ONE
// URL (`?terrainSand=on`) lights the tier's intended set for an eye-test,
// exactly like `?gfxRelief=on` does for its sub-knobs. `?terrainSand=off`,
// `?terrainVfx=off`, `?visual=off` and `?wireframe=1` each kill all three.
// ---------------------------------------------------------------------------

/** Shared strict `=== "on"` / `=== "off"` reader with a quality-preset
 *  fallback. Copied from `terrainTrailEnabled` (which copies `gfx_relief.js`):
 *  an unrecognised value WARNS ONCE and does NOT enable — a silent no-op here
 *  is indistinguishable from a broken decode. The preset branch is deliberately
 *  NOT memoized (it can be consulted before `window.liveScene3d.quality`
 *  exists, and caching "not ready" would stick for the session). */
function _terrainStrictFlag(name, presetKey, presetDefault, warned) {
  const raw = _strFlag(name);
  if (raw === "on") return { value: true, memo: true };
  if (raw === "off") return { value: false, memo: true };
  if (raw !== null && !warned.hit) {
    warned.hit = true;
    // eslint-disable-next-line no-console
    console.warn(
      `[${name}] ignoring ?${name}=${JSON.stringify(raw)} — the flag is an EXACT-match opt-in; use ?${name}=on (or =off).`,
    );
  }
  const flags = _presetFlags();
  if (!flags) return { value: presetDefault, memo: false };
  const v = flags[presetKey];
  return { value: typeof v === "boolean" ? v : presetDefault, memo: true };
}

let _terrainSand;
const _terrainSandWarn = { hit: false };
/** `?terrainSand=on` — THE family master for the SAND/DESERT programme
 *  (streamers + dust devils + grain sparkle; plan §3.2). STRICT exact-match
 *  opt-in; absent ⇒ the quality preset's `terrainSand`, **false on all four
 *  tiers** this wave (§5.9 ship-OFF; the promotion target is high/ultra true). */
export function terrainSandEnabled() {
  if (_terrainSand !== undefined) return _terrainSand;
  const r = _terrainStrictFlag("terrainSand", "terrainSand", false, _terrainSandWarn);
  return r.memo ? (_terrainSand = r.value) : r.value;
}

let _terrainSandStreamers;
const _terrainSandStreamersWarn = { hit: false };
/** `?terrainSandStreamers=on` — ground-hugging wind-driven sand streaks
 *  (camera-scoped instanced quad field, `scene3d/terrain_sand.js`). Requires
 *  the family master. Absent ⇒ ON wherever the tier's
 *  `terrainSandStreamerCount` is non-zero (low = 0 ⇒ off). */
export function terrainSandStreamersEnabled() {
  if (_terrainSandStreamers !== undefined) return _terrainSandStreamers;
  const raw = _strFlag("terrainSandStreamers");
  if (raw === "on") return (_terrainSandStreamers = true);
  if (raw === "off") return (_terrainSandStreamers = false);
  if (raw !== null && !_terrainSandStreamersWarn.hit) {
    _terrainSandStreamersWarn.hit = true;
    // eslint-disable-next-line no-console
    console.warn(
      `[terrainSandStreamers] ignoring ?terrainSandStreamers=${JSON.stringify(raw)} — the flag is an EXACT-match opt-in; use ?terrainSandStreamers=on (or =off).`,
    );
  }
  const flags = _presetFlags();
  if (!flags) return false;              // deliberately not memoized
  return (_terrainSandStreamers = Number(flags.terrainSandStreamerCount) > 0);
}

let _terrainSandDevils;
const _terrainSandDevilsWarn = { hit: false };
/** `?terrainSandDevils=on` — landblock-scoped dust devils (≤ the tier's
 *  `terrainSandDevilCount` per LB, hash-stable, synthesized through the
 *  EXISTING particle system + owner registry). Requires the family master.
 *  Absent ⇒ ON wherever the tier's `terrainSandDevilCount` is non-zero
 *  (low/mid = 0 ⇒ off). */
export function terrainSandDevilsEnabled() {
  if (_terrainSandDevils !== undefined) return _terrainSandDevils;
  const raw = _strFlag("terrainSandDevils");
  if (raw === "on") return (_terrainSandDevils = true);
  if (raw === "off") return (_terrainSandDevils = false);
  if (raw !== null && !_terrainSandDevilsWarn.hit) {
    _terrainSandDevilsWarn.hit = true;
    // eslint-disable-next-line no-console
    console.warn(
      `[terrainSandDevils] ignoring ?terrainSandDevils=${JSON.stringify(raw)} — the flag is an EXACT-match opt-in; use ?terrainSandDevils=on (or =off).`,
    );
  }
  const flags = _presetFlags();
  if (!flags) return false;              // deliberately not memoized
  return (_terrainSandDevils = Number(flags.terrainSandDevilCount) > 0);
}

let _terrainSandSparkle;
const _terrainSandSparkleWarn = { hit: false };
/** `?terrainSandSparkle=on` — grazing-angle grain sparkle, a FRAGMENT addition
 *  in the terrain shader gated on FAM_SAND read from `uVertexTypes` (plan trap
 *  T3) and placed after the POM `cellUv` offset, bypassed on any water-touching
 *  cell (plan §2.7.3). Requires the family master. Absent ⇒ the tier's
 *  `terrainSandSparkle` (false on low, true on mid/high/ultra). */
export function terrainSandSparkleEnabled() {
  if (_terrainSandSparkle !== undefined) return _terrainSandSparkle;
  const r = _terrainStrictFlag("terrainSandSparkle", "terrainSandSparkle", false, _terrainSandSparkleWarn);
  return r.memo ? (_terrainSandSparkle = r.value) : r.value;
}

/** Instance count for the streamer field at the live tier. URL knob
 *  `?terrainSandStreamerCount` (an INT_FLAGS quality override — it cannot turn
 *  the effect on by itself). Fallback 2000 = the `high` tier. */
export function terrainSandStreamerCount() {
  return Math.round(_terrainNum("terrainSandStreamerCount", "terrainSandStreamerCount", 2000, 0, 20000));
}

/** Dust devils per landblock at the live tier. URL knob
 *  `?terrainSandDevilCount`. Fallback 1 = the `high` tier. */
export function terrainSandDevilCount() {
  return Math.round(_terrainNum("terrainSandDevilCount", "terrainSandDevilCount", 1, 0, 8));
}

/** `?terrainSandRadius` — HALF-extent (metres) of the streamer field window.
 *  Fallback 64 m. Cannot enable the feature on its own. */
export function terrainSandRadiusM() {
  return _terrainNum("terrainSandRadius", "terrainSandRadius", 64, 8, 512);
}

// ---------------------------------------------------------------------------
// TERRAIN SNOW / ICE (Wave 2A — plan §3.4). Codes 2 `Ice`, 15 `Snow`,
// 27 `BlueIce` = FAM_SNOWICE; the ICE MATERIAL is codes 2/27 only.
//
// TWO masters, deliberately (plan §3.4 "separate — one is particles+shader, the
// other a material change; bisecting matters"):
//     spindrift = terrainSnowEnabled() && terrainSnowSpindriftEnabled()
//     sparkle   = terrainSnowEnabled() && terrainSnowSparkleEnabled()
//     prints    = terrainSnowEnabled() && terrainSnowPrintsEnabled()   (+ ?terrainTrail=on)
//     ice       = terrainIceEnabled()
//     refract   = terrainIceEnabled() && terrainIceRefractionEnabled()
// All STRICT exact-match opt-ins that ship OFF (plan §2.4/§5.9), all kept out of
// `quality.js BOOL_FLAGS` for the `gfxRelief` reason. `?terrainVfx=off`,
// `?visual=off` and `?wireframe=1` each kill every one of them.
// ---------------------------------------------------------------------------

let _terrainSnow;
const _terrainSnowWarn = { hit: false };
/** `?terrainSnow=on` — THE family master for SNOW (spindrift ribbons + the
 *  terrain-shader crystal sparkle + persistent footprints; plan §3.4). It does
 *  NOT gate the ICE MATERIAL — that is `?terrainIce`, on purpose: one is
 *  particles+shader and the other is a material change, and bisecting them
 *  separately is the point. Absent ⇒ the quality preset's `terrainSnow`,
 *  **false on all four tiers** this wave (§5.9 ship-OFF; the promotion target is
 *  high/ultra true). */
export function terrainSnowEnabled() {
  if (_terrainSnow !== undefined) return _terrainSnow;
  const r = _terrainStrictFlag("terrainSnow", "terrainSnow", false, _terrainSnowWarn);
  return r.memo ? (_terrainSnow = r.value) : r.value;
}

let _terrainSnowSpindrift;
const _terrainSnowSpindriftWarn = { hit: false };
/** `?terrainSnowSpindrift=on` — the slope-biased white ribbon field blowing off
 *  crests (a camera-scoped `terrain_scatter.js` pool, `scene3d/terrain_snow.js`).
 *  Requires the family master. Absent ⇒ ON wherever the tier's
 *  `terrainSnowSpindriftCount` is non-zero (low/mid = 0 ⇒ off), the same shape
 *  `terrainSandStreamers` uses. */
export function terrainSnowSpindriftEnabled() {
  if (_terrainSnowSpindrift !== undefined) return _terrainSnowSpindrift;
  const raw = _strFlag("terrainSnowSpindrift");
  if (raw === "on") return (_terrainSnowSpindrift = true);
  if (raw === "off") return (_terrainSnowSpindrift = false);
  if (raw !== null && !_terrainSnowSpindriftWarn.hit) {
    _terrainSnowSpindriftWarn.hit = true;
    // eslint-disable-next-line no-console
    console.warn(
      `[terrainSnowSpindrift] ignoring ?terrainSnowSpindrift=${JSON.stringify(raw)} — the flag is an EXACT-match opt-in; use ?terrainSnowSpindrift=on (or =off).`,
    );
  }
  const flags = _presetFlags();
  if (!flags) return false;              // deliberately not memoized
  return (_terrainSnowSpindrift = Number(flags.terrainSnowSpindriftCount) > 0);
}

let _terrainSnowSparkle;
const _terrainSnowSparkleWarn = { hit: false };
/** `?terrainSnowSparkle=on` — sun-glitter that twinkles as the CAMERA moves, a
 *  FRAGMENT term in the terrain shader gated on FAM_SNOWICE read from
 *  `uVertexTypes` (plan trap T3), sited after the POM `cellUv` offset and
 *  bypassed on any water-touching cell (plan §2.7.3). Requires the family
 *  master. Absent ⇒ the tier's `terrainSnowSparkle` (false on low, true on
 *  mid/high/ultra — it is the whole `mid` tier for this family). */
export function terrainSnowSparkleEnabled() {
  if (_terrainSnowSparkle !== undefined) return _terrainSnowSparkle;
  const r = _terrainStrictFlag("terrainSnowSparkle", "terrainSnowSparkle", false, _terrainSnowSparkleWarn);
  return r.memo ? (_terrainSnowSparkle = r.value) : r.value;
}

let _terrainSnowPrints;
const _terrainSnowPrintsWarn = { hit: false };
/** `?terrainSnowPrints=on` — persistent footprints: the shared trail map read in
 *  the terrain fragment shader as a small parallax dent plus a darkening.
 *  Requires the family master AND `?terrainTrail=on` — the map is built by
 *  `terrain_vfx.js::initTerrainVfx` and this module NEVER lazily creates one
 *  (the grass-stomp precedent); with the map absent `uSnowTrailEnabled` stays 0
 *  and nothing is drawn, no error. Absent ⇒ the tier's `terrainSnowPrints`
 *  (false low/mid — `mid` has no POM, so the print would be darkening-only —
 *  true high/ultra).
 *  ⚠ RECOVERY: the map's fade is GLOBAL (`?terrainTrailFade`, default 4 s =
 *  grass springback). Snow wants effectively-infinite recovery, so the live URL
 *  is `?terrainTrailFade=300`; `terrain_snow.js` warns once if it is short. */
export function terrainSnowPrintsEnabled() {
  if (_terrainSnowPrints !== undefined) return _terrainSnowPrints;
  const r = _terrainStrictFlag("terrainSnowPrints", "terrainSnowPrints", false, _terrainSnowPrintsWarn);
  return r.memo ? (_terrainSnowPrints = r.value) : r.value;
}

let _terrainIce;
const _terrainIceWarn = { hit: false };
/** `?terrainIce=on` — THE master for the ICE MATERIAL TREATMENT on codes 2
 *  (`Ice`) and 27 (`BlueIce`) ONLY — never 15 (`Snow`), which stays matte.
 *  Roughness down, a sharper specular and an env term off the `?ibl` cube.
 *  Explicitly NOT `MeshTransmissionMaterial` (plan §3.4: that needs a second
 *  full scene render per frame for a handful of texels). Absent ⇒ the quality
 *  preset's `terrainIce`, **false on all four tiers** this wave. */
export function terrainIceEnabled() {
  if (_terrainIce !== undefined) return _terrainIce;
  const r = _terrainStrictFlag("terrainIce", "terrainIce", false, _terrainIceWarn);
  return r.memo ? (_terrainIce = r.value) : r.value;
}

let _terrainIceRefraction;
const _terrainIceRefractionWarn = { hit: false };
/** `?terrainIceRefraction=on` — the cheap fake refraction inside the ice
 *  treatment: ONE extra atlas tap at a UV offset by the view vector times a
 *  small depth constant, applied AFTER the POM march with an amplitude well
 *  under `uPomScale` (0.012) so the two never fight. Requires `?terrainIce`.
 *  Absent ⇒ the tier's `terrainIceRefraction` (ultra only — plan §3.4). */
export function terrainIceRefractionEnabled() {
  if (_terrainIceRefraction !== undefined) return _terrainIceRefraction;
  const r = _terrainStrictFlag("terrainIceRefraction", "terrainIceRefraction", false, _terrainIceRefractionWarn);
  return r.memo ? (_terrainIceRefraction = r.value) : r.value;
}

/** Instances in the spindrift ribbon pool at the live tier. URL knob
 *  `?terrainSnowSpindriftCount` (an `INT_FLAGS` quality override — it cannot
 *  turn the effect on by itself). Preset: low 0 / mid 0 / high 1200 /
 *  ultra 2500. Fallback 1200 = the `high` tier. */
export function terrainSnowSpindriftCount() {
  return Math.round(_terrainNum("terrainSnowSpindriftCount", "terrainSnowSpindriftCount", 1200, 0, 20000));
}

/** `?terrainSnowRadius` — HALF-extent (metres) of the spindrift window; the
 *  field covers 2× this. Preset key `terrainSnowRadius` (low 32 / mid 48 /
 *  high 64 / ultra 80). Fallback 64. Cannot enable the feature on its own. */
export function terrainSnowRadiusM() {
  return _terrainNum("terrainSnowRadius", "terrainSnowRadius", 64, 8, 512);
}

/** `?terrainSnowSlope` — the slope-bias threshold for spindrift, as
 *  `1 - normal.z` (0 = dead flat, ~0.5 ≈ 30°). Ribbons lift where the ground
 *  tilts past this and thin out below it, which is where real spindrift comes
 *  off. URL-ONLY on purpose (no preset key), exactly like
 *  `?terrainGrassDensity`: it is the continuous A/B knob for the 1070 look
 *  pass, while the tier owns the count. Default 0.12 ≈ 7°; 0 disables the bias
 *  entirely (ribbons everywhere on snow). */
export function terrainSnowSlopeBias() {
  return _numFlag("terrainSnowSlope", 0.12, 0, 1);
}

// ---------------------------------------------------------------------------
// TERRAIN VOLCANO / OBSIDIAN (Wave 2B — plan §3.6). Codes 6 (`ObsidianPlain`),
// 25 (`Volcano1`) and 26 (`Volcano2`) = FAM_VOLCANO.
//
// FOUR flags, one family master + three effects, ALL strict exact-match opt-ins
// that ship OFF (plan §2.4/§5.9), all kept out of `quality.js BOOL_FLAGS` for
// the `gfxRelief` reason. Composition:
//     heat haze  = terrainVolcanoEnabled() && terrainHazeEnabled()
//     embers     = terrainVolcanoEnabled() && terrainEmbersEnabled()
//     crack glow = terrainVolcanoEnabled() && terrainCrackGlowEnabled()
//
// ⚠ `?terrainHaze` IS THE SHARED NAME, deliberately (plan §3.2 item 3 lists heat
// shimmer as "shared with volcano (§3.6)" and wave 1B deferred it here). It is
// NOT `terrainVolcanoHaze`. Today the ONLY arm that composes it is the volcano
// master, because the sand family shipped no shimmer — a later sand arm adds
// `terrainSandEnabled() && terrainHazeEnabled()` alongside, without renaming the
// flag or re-documenting it.
//
// Ash fall (plan §3.6 item 4, `ultra` only) is DEFERRED — see plan §8 risk 9 and
// the wave-2B handoff: parameterising `weather/snow.js SnowSystem` proved
// invasive (10 `Math.random` sites vs the §5.5 determinism invariant, ownership
// by `weather/manager.js` keyed on the weather profile rather than on terrain,
// and no terrain gate anywhere in `weather/`), and the owner has explicitly
// deferred refactoring. There is deliberately NO `terrainAsh` flag and NO ash
// quality key: a documented flag with no reader fails the url-flags lint, and a
// preset key with no consumer is dead config.
// ---------------------------------------------------------------------------

let _terrainVolcano;
const _terrainVolcanoWarn = { hit: false };
/** `?terrainVolcano=on` — THE family master for VOLCANO/OBSIDIAN (heat haze +
 *  embers + crack glow + the obsidian specular; plan §3.6). STRICT exact-match
 *  opt-in; absent ⇒ the quality preset's `terrainVolcano`, **false on all four
 *  tiers** this wave (§5.9 ship-OFF; the promotion target is high/ultra true). */
export function terrainVolcanoEnabled() {
  if (_terrainVolcano !== undefined) return _terrainVolcano;
  const r = _terrainStrictFlag("terrainVolcano", "terrainVolcano", false, _terrainVolcanoWarn);
  return r.memo ? (_terrainVolcano = r.value) : r.value;
}

let _terrainHaze;
const _terrainHazeWarn = { hit: false };
/** `?terrainHaze=on` — the heat-shimmer postprocessing `Effect` (a pure `mainUv`
 *  warp inserted into the EXISTING `EffectPass`, never a new pass). SHARED name
 *  with the sand family by design (see the block comment above). Requires a
 *  family master. Absent ⇒ the tier's `terrainHaze` (false low/mid, true
 *  high/ultra). */
export function terrainHazeEnabled() {
  if (_terrainHaze !== undefined) return _terrainHaze;
  const r = _terrainStrictFlag("terrainHaze", "terrainHaze", false, _terrainHazeWarn);
  return r.memo ? (_terrainHaze = r.value) : r.value;
}

let _terrainEmbers;
const _terrainEmbersWarn = { hit: false };
/** `?terrainEmbers=on` — landblock-scoped rising embers over volcanic ground,
 *  RE-ANCHORED from `vfx/components/brazierEmbers.js` (same builders, wider
 *  footprint, terrain anchor). Requires the family master. Absent ⇒ ON wherever
 *  the tier's `terrainVolcanoEmberCount` is non-zero (low/mid 0 ⇒ off). */
export function terrainEmbersEnabled() {
  if (_terrainEmbers !== undefined) return _terrainEmbers;
  const raw = _strFlag("terrainEmbers");
  if (raw === "on") return (_terrainEmbers = true);
  if (raw === "off") return (_terrainEmbers = false);
  if (raw !== null && !_terrainEmbersWarn.hit) {
    _terrainEmbersWarn.hit = true;
    // eslint-disable-next-line no-console
    console.warn(
      `[terrainEmbers] ignoring ?terrainEmbers=${JSON.stringify(raw)} — the flag is an EXACT-match opt-in; use ?terrainEmbers=on (or =off).`,
    );
  }
  const flags = _presetFlags();
  if (!flags) return false;              // deliberately not memoized
  return (_terrainEmbers = Number(flags.terrainVolcanoEmberCount) > 0);
}

let _terrainCrackGlow;
const _terrainCrackGlowWarn = { hit: false };
/** `?terrainCrackGlow=on` — the dull red glow breathing in the cracks underfoot:
 *  a FRAGMENT term in the terrain shader gated on FAM_VOLCANO read from
 *  `uVertexTypes` (plan trap T3), sited after the POM `cellUv` offset and
 *  bypassed on any water-touching cell (plan §2.7.3). Also carries the
 *  code-6-only OBSIDIAN specular (same block, same gate — one flag, because
 *  they are one fragment edit and one eye-test). Requires the family master.
 *  Absent ⇒ the tier's `terrainCrackGlow` (false on low, true mid/high/ultra). */
export function terrainCrackGlowEnabled() {
  if (_terrainCrackGlow !== undefined) return _terrainCrackGlow;
  const r = _terrainStrictFlag("terrainCrackGlow", "terrainCrackGlow", false, _terrainCrackGlowWarn);
  return r.memo ? (_terrainCrackGlow = r.value) : r.value;
}

/** Embers per volcanic landblock at the live tier. URL knob
 *  `?terrainVolcanoEmberCount`. Fallback 1 = the `high` tier. */
export function terrainVolcanoEmberCount() {
  return Math.round(_terrainNum("terrainVolcanoEmberCount", "terrainVolcanoEmberCount", 1, 0, 8));
}

/** `?terrainHazeStrength` — UV-warp amplitude of the heat shimmer, in SCREEN
 *  units (a 0.02 warp moves a pixel ~2 % of the frame). Fallback 1 = the `high`
 *  tier multiplier. 0 disables the warp without removing the Effect. */
export function terrainHazeStrength() {
  return _terrainNum("terrainHazeStrength", "terrainHazeStrength", 1, 0, 4);
}

/** `?terrainVolcanoRadius` — the heat-source radius in METRES around the nearest
 *  resident volcanic landblock's centre. Drives `uHeatRadius`, which is forced
 *  to 0 whenever no volcanic LB is resident (plan §3.6: otherwise the distortion
 *  follows the player out of the region). Fallback 160 m = the `high` tier. */
export function terrainVolcanoRadiusM() {
  return _terrainNum("terrainVolcanoRadius", "terrainVolcanoRadius", 160, 8, 1024);
}

// ---------------------------------------------------------------------------
// TERRAIN DIRT / MUD (Wave 3B — plan §3.7). Codes 5 (`MudRichDirt`),
// 7 (`PackedDirt`), 8 (`PatchyDirt`), 24 (`Argila`) and 31 (`DesolateLands`)
// = FAM_DIRT; CLAY (the redder, slicker wet treatment) is code 24 alone.
//
// ONE family master + four effects, ALL strict exact-match opt-ins that ship
// OFF (plan §2.4/§5.9), all kept out of `quality.js BOOL_FLAGS` for the
// `gfxRelief` reason. Composition:
//     footfall puffs = terrainDirtEnabled() && terrainFootfallEnabled()
//     mud prints     = terrainDirtEnabled() && terrainMudPrintsEnabled()   (+ ?terrainTrail=on)
//     wetness        = terrainDirtEnabled() && terrainMudWetnessEnabled()
//     dry dust haze  = terrainDirtEnabled() && terrainDustHazeEnabled()
// `?terrainVfx=off`, `?visual=off` and `?wireframe=1` each kill all of them.
//
// ⚠ `?terrainMudWetness` is a FOURTH flag where plan §3.7 names three. The
// plan's own tier table carries `wetness: true` at `ultra` only, i.e. a knob
// that ships on a different tier from the prints it rides with — and the house
// rule is one knob, one reader, one docs row (an undocumented preset key is
// dead config and an unbisectable effect is exactly what `?terrainIceRefraction`
// was given its own flag to avoid in wave 2A). Same shape, same reason.
// ---------------------------------------------------------------------------

let _terrainDirt;
const _terrainDirtWarn = { hit: false };
/** `?terrainDirt=on` — THE family master for DIRT/MUD (footfall dust puffs +
 *  mud prints + the wet-mud darkening/sheen + the dry dust haze; plan §3.7).
 *  STRICT exact-match opt-in; absent ⇒ the quality preset's `terrainDirt`,
 *  **false on all four tiers** this wave (§5.9 ship-OFF; the promotion target is
 *  high/ultra true). */
export function terrainDirtEnabled() {
  if (_terrainDirt !== undefined) return _terrainDirt;
  const r = _terrainStrictFlag("terrainDirt", "terrainDirt", false, _terrainDirtWarn);
  return r.memo ? (_terrainDirt = r.value) : r.value;
}

let _terrainFootfall;
const _terrainFootfallWarn = { hit: false };
/** `?terrainFootfall=on` — the small dust burst thrown where a foot lands on
 *  dry dirt (`scene3d/terrain_dirt.js`, a fixed-capacity billboard ring buffer).
 *  It hangs off the EXISTING footstep-audio trigger — the `Sound.Footstep1/2`
 *  (0x37/0x38) SoundTable animation hook in `entities.js::_fireHook` — rather
 *  than re-deriving ground contact from velocity (plan §3.7 item 1). Requires
 *  the family master. Absent ⇒ the tier's `terrainFootfall` (false on low, true
 *  on mid/high/ultra — it is the whole `mid` tier for this family). */
export function terrainFootfallEnabled() {
  if (_terrainFootfall !== undefined) return _terrainFootfall;
  const r = _terrainStrictFlag("terrainFootfall", "terrainFootfall", false, _terrainFootfallWarn);
  return r.memo ? (_terrainFootfall = r.value) : r.value;
}

let _terrainMudPrints;
const _terrainMudPrintsWarn = { hit: false };
/** `?terrainMudPrints=on` — deforming mud prints: the SHARED trail map read in
 *  the terrain fragment shader as a parallax dent plus a darkening. Requires the
 *  family master AND `?terrainTrail=on` — the map is built by
 *  `terrain_vfx.js::initTerrainVfx` and this module NEVER lazily creates one
 *  (the grass-stomp precedent); with the map absent `uMudTrailEnabled` stays 0
 *  and nothing is drawn, no error. Absent ⇒ the tier's `terrainMudPrints`
 *  (false low/mid — `mid` has no POM, so the print would be darkening-only —
 *  true high/ultra).
 *  ⚠ RECOVERY: the map's fade is GLOBAL (`?terrainTrailFade`, default 4 s =
 *  grass springback, snow runs 300 s). Mud asks for ~30 s and expresses its
 *  RAIN-DEPENDENT persistence through stamp/shader AMPLITUDE instead, so no
 *  second render target and no second fade constant — full rationale in the
 *  `scene3d/terrain_dirt.js` header. `initTerrainDirt` warns once in each
 *  direction when the live fade is far off 30 s. */
export function terrainMudPrintsEnabled() {
  if (_terrainMudPrints !== undefined) return _terrainMudPrints;
  const r = _terrainStrictFlag("terrainMudPrints", "terrainMudPrints", false, _terrainMudPrintsWarn);
  return r.memo ? (_terrainMudPrints = r.value) : r.value;
}

let _terrainMudWetness;
const _terrainMudWetnessWarn = { hit: false };
/** `?terrainMudWetness=on` — wet mud: a darkening plus a specular/env sheen on
 *  FAM_DIRT ground, driven by the ALREADY-SMOOTHED `VFX_GLOBALS.uWetness` (plan
 *  §3.7 item 4 — never re-derived from `weather/rain.js`) and reusing the
 *  RESPONSE CURVE of `vfx/components/wetness.js` (the same up-facing
 *  `smoothstep(0.05, 0.6, n_up)` weight, the same 0.62 darken, the same 0.25
 *  roughness drop) so puddled statics and puddled ground agree. Clay (code 24)
 *  goes redder and slicker than the rest of the family. Requires the family
 *  master. Absent ⇒ the tier's `terrainMudWetness` (**ultra only** — plan §3.7's
 *  tier table). */
export function terrainMudWetnessEnabled() {
  if (_terrainMudWetness !== undefined) return _terrainMudWetness;
  const r = _terrainStrictFlag("terrainMudWetness", "terrainMudWetness", false, _terrainMudWetnessWarn);
  return r.memo ? (_terrainMudWetness = r.value) : r.value;
}

let _terrainDustHaze;
const _terrainDustHazeWarn = { hit: false };
/** `?terrainDustHaze=on` — the low brown wind-lifted dust veil over dry dirt
 *  (a camera-scoped `terrain_scatter.js` pool, `DesolateLands`-biased through
 *  the per-code table in `terrain_dirt.js`, suppressed by rain and by cold).
 *  Requires the family master. Absent ⇒ ON wherever the tier's
 *  `terrainDirtDustCount` is non-zero (low/mid = 0 ⇒ off), the same shape
 *  `terrainSandStreamers` and `terrainSnowSpindrift` use. */
export function terrainDustHazeEnabled() {
  if (_terrainDustHaze !== undefined) return _terrainDustHaze;
  const raw = _strFlag("terrainDustHaze");
  if (raw === "on") return (_terrainDustHaze = true);
  if (raw === "off") return (_terrainDustHaze = false);
  if (raw !== null && !_terrainDustHazeWarn.hit) {
    _terrainDustHazeWarn.hit = true;
    // eslint-disable-next-line no-console
    console.warn(
      `[terrainDustHaze] ignoring ?terrainDustHaze=${JSON.stringify(raw)} — the flag is an EXACT-match opt-in; use ?terrainDustHaze=on (or =off).`,
    );
  }
  const flags = _presetFlags();
  if (!flags) return false;              // deliberately not memoized
  return (_terrainDustHaze = Number(flags.terrainDirtDustCount) > 0);
}

/** Instances in the dry-dust-haze pool at the live tier. URL knob
 *  `?terrainDirtDustCount` (an `INT_FLAGS` quality override — it cannot turn
 *  the effect on by itself). Preset: low 0 / mid 0 / high 800 / ultra 2000
 *  (plan §3.7's `dustHaze` tier numbers). Fallback 800 = the `high` tier. */
export function terrainDirtDustCount() {
  return Math.round(_terrainNum("terrainDirtDustCount", "terrainDirtDustCount", 800, 0, 20000));
}

/** `?terrainDirtRadius` — HALF-extent (metres) of the dust-haze window; the
 *  field covers 2× this. Preset key `terrainDirtRadius` (low 32 / mid 40 /
 *  high 56 / ultra 72). Fallback 56. Cannot enable the feature on its own. */
export function terrainDirtRadiusM() {
  return _terrainNum("terrainDirtRadius", "terrainDirtRadius", 56, 8, 512);
}

/** `?terrainDirtDustDensity` — 0..2 multiplier on the tier haze count, default
 *  1.0. URL-ONLY on purpose (no preset key), exactly like `?terrainGrassDensity`
 *  and `?terrainSnowSlope`: it is the continuous A/B knob for the 1070 perf
 *  sweep, while the tier owns the shipped count. 0 disables the haze. */
export function terrainDirtDustDensity() {
  return _numFlag("terrainDirtDustDensity", 1, 0, 2);
}

/** `?terrainFootfallPuffs` — capacity of the footfall ring buffer, i.e. the max
 *  number of dust bursts alive at once. URL-ONLY (no preset key): a puff lives
 *  under a second, so the pool is tiny and bounded by the emit rate rather than
 *  by the tier — `terrainFootfall` is the tier's lever. Default 48. Cannot
 *  enable the feature on its own. */
export function terrainFootfallPuffCount() {
  return Math.round(_numFlag("terrainFootfallPuffs", 48, 1, 512));
}

// ---------------------------------------------------------------------------
// TERRAIN SWAMP / MARSH (Wave 3A — plan §3.5). Terrain code 4
// (`MarshSparseSwamp`) = FAM_SWAMP; code 23 (`SeaSlime`) joins it ONLY under
// `?strictWaterCodes` (plan §3.8.3 — 23 is WATER by default and the water agent
// owns it). Both are DERIVED from `terrain_families.js`, never listed here.
//
// SIX booleans, one family master + five effects, ALL strict exact-match
// opt-ins that ship OFF (plan §2.4/§5.9), all kept out of `quality.js
// BOOL_FLAGS` for the `gfxRelief` reason. Composition:
//     ground fog = terrainSwampEnabled() && terrainGroundFogEnabled()
//     marsh gas  = terrainSwampEnabled() && terrainMarshGasEnabled()
//     wisps      = marsh gas             && terrainMarshWispsEnabled()
//     fireflies  = terrainSwampEnabled() && terrainSwampFirefliesEnabled()
//     midges     = terrainSwampEnabled() && terrainSwampMidgesEnabled()
//
// ⚠ `?terrainGroundFog` IS THE SHARED NAME, deliberately (plan §3.5 item 3:
// "new shared `scene3d/ground_fog.js`", flag "`?terrainGroundFog` (shared with
// snow/volcano)"). It is NOT `terrainSwampFog`. Today only the swamp master
// composes it; a later snow or volcano arm adds
// `terrainSnowEnabled() && terrainGroundFogEnabled()` alongside without
// renaming the flag or re-documenting it — exactly the precedent
// `?terrainHaze` set in wave 2B.
//
// ⚠ FIREFLIES ARE NOT A SECOND FIREFLY SYSTEM (plan §3.5 item 1). The existing
// `?foliageFireflies` flag still owns the CANOPY emitters and is untouched;
// `?terrainSwampFireflies` gates a terrain ANCHOR SOURCE for the SAME
// registered behaviour (`vfx/components/terrainSwampAmbient.js` calls
// `foliageFireflies.emit()`). The two flags are independent on purpose: a
// player can have canopy fireflies without marsh ones and vice versa.
// ---------------------------------------------------------------------------

let _terrainSwamp;
const _terrainSwampWarn = { hit: false };
/** `?terrainSwamp=on` — THE family master for SWAMP/MARSH (ground fog + marsh
 *  gas + the firefly/midge terrain anchors; plan §3.5). STRICT exact-match
 *  opt-in; absent ⇒ the quality preset's `terrainSwamp`, **false on all four
 *  tiers** this wave (§5.9 ship-OFF; the promotion target is high/ultra true). */
export function terrainSwampEnabled() {
  if (_terrainSwamp !== undefined) return _terrainSwamp;
  const r = _terrainStrictFlag("terrainSwamp", "terrainSwamp", false, _terrainSwampWarn);
  return r.memo ? (_terrainSwamp = r.value) : r.value;
}

let _terrainGroundFog;
const _terrainGroundFogWarn = { hit: false };
/** `?terrainGroundFog=on` — the SHARED camera-centred ring of soft
 *  camera-facing fog cards (`scene3d/ground_fog.js`), anchored 0.2..1.5 m over
 *  the sampled ground so it clings in hollows. Composed with the family master.
 *  Absent ⇒ ON wherever the tier's `terrainGroundFogCount` is non-zero (low 0 ⇒
 *  off), the same shape `terrainSandStreamers` uses. */
export function terrainGroundFogEnabled() {
  if (_terrainGroundFog !== undefined) return _terrainGroundFog;
  const raw = _strFlag("terrainGroundFog");
  if (raw === "on") return (_terrainGroundFog = true);
  if (raw === "off") return (_terrainGroundFog = false);
  if (raw !== null && !_terrainGroundFogWarn.hit) {
    _terrainGroundFogWarn.hit = true;
    // eslint-disable-next-line no-console
    console.warn(
      `[terrainGroundFog] ignoring ?terrainGroundFog=${JSON.stringify(raw)} — the flag is an EXACT-match opt-in; use ?terrainGroundFog=on (or =off).`,
    );
  }
  const flags = _presetFlags();
  if (!flags) return false;             // deliberately not memoized
  return (_terrainGroundFog = Number(flags.terrainGroundFogCount) > 0);
}

let _terrainMarshGas;
const _terrainMarshGasWarn = { hit: false };
/** `?terrainMarshGas=on` — landblock-scoped stationary bubble vents at
 *  hash-stable positions on the LB's swamp cells (≤ the tier's
 *  `terrainMarshGasCount` per LB), synthesized through the EXISTING particle
 *  system and owned through the owner registry. **Adds no light** (§5.2).
 *  Absent ⇒ ON wherever the tier's `terrainMarshGasCount` is non-zero
 *  (low/mid 0 ⇒ off). */
export function terrainMarshGasEnabled() {
  if (_terrainMarshGas !== undefined) return _terrainMarshGas;
  const raw = _strFlag("terrainMarshGas");
  if (raw === "on") return (_terrainMarshGas = true);
  if (raw === "off") return (_terrainMarshGas = false);
  if (raw !== null && !_terrainMarshGasWarn.hit) {
    _terrainMarshGasWarn.hit = true;
    // eslint-disable-next-line no-console
    console.warn(
      `[terrainMarshGas] ignoring ?terrainMarshGas=${JSON.stringify(raw)} — the flag is an EXACT-match opt-in; use ?terrainMarshGas=on (or =off).`,
    );
  }
  const flags = _presetFlags();
  if (!flags) return false;             // deliberately not memoized
  return (_terrainMarshGas = Number(flags.terrainMarshGasCount) > 0);
}

let _terrainMarshWisps;
const _terrainMarshWispsWarn = { hit: false };
/** `?terrainMarshWisps=on` — the rare ~2 s ignition over a marsh-gas vent: a
 *  FINITE additive-sprite emitter on a long host timer (never a PointLight —
 *  §5.2). Composed with `terrainMarshGas`, because a wisp is an ignition OF the
 *  gas: with no vents there is nothing to light. Absent ⇒ the tier's
 *  `terrainMarshWisps` (**ultra only**, per plan §3.5). */
export function terrainMarshWispsEnabled() {
  if (_terrainMarshWisps !== undefined) return _terrainMarshWisps;
  const r = _terrainStrictFlag("terrainMarshWisps", "terrainMarshWisps", false, _terrainMarshWispsWarn);
  return r.memo ? (_terrainMarshWisps = r.value) : r.value;
}

let _terrainSwampFireflies;
const _terrainSwampFirefliesWarn = { hit: false };
/** `?terrainSwampFireflies=on` — the TERRAIN ANCHOR SOURCE for the existing
 *  `particle.foliageFireflies` behaviour: FAM_SWAMP landblocks emit the same
 *  registered firefly emitter from the GROUND at night, marsh-green (an
 *  additive green sprite) and lower-drifting. **This is not a second firefly
 *  system** (plan §3.5 item 1) — `?foliageFireflies` still independently owns
 *  the canopy anchors and the shared `firefliesGate` still decides night/season
 *  for both. Absent ⇒ the tier's `terrainSwampFireflies` (false on low, true on
 *  mid/high/ultra). */
export function terrainSwampFirefliesEnabled() {
  if (_terrainSwampFireflies !== undefined) return _terrainSwampFireflies;
  const r = _terrainStrictFlag("terrainSwampFireflies", "terrainSwampFireflies", false, _terrainSwampFirefliesWarn);
  return r.memo ? (_terrainSwampFireflies = r.value) : r.value;
}

let _terrainSwampMidges;
const _terrainSwampMidgesWarn = { hit: false };
/** `?terrainSwampMidges=on` — the terrain anchor source for the existing
 *  `particle.foliagePollen` behaviour, swamp-tinted (a small ALPHA mote, not a
 *  glow) with a tighter orbit: a midge column over the marsh. Same reuse
 *  contract as the fireflies above, same shared `pollenGate`. Absent ⇒ the
 *  tier's `terrainSwampMidges` (false on low, true on mid/high/ultra). */
export function terrainSwampMidgesEnabled() {
  if (_terrainSwampMidges !== undefined) return _terrainSwampMidges;
  const r = _terrainStrictFlag("terrainSwampMidges", "terrainSwampMidges", false, _terrainSwampMidgesWarn);
  return r.memo ? (_terrainSwampMidges = r.value) : r.value;
}

/** `?terrainGroundFogCount` — fog cards in the ring. Preset key
 *  `terrainGroundFogCount` (low 0 / mid 8 / high 16 / ultra 24 — plan §3.5's
 *  tier table verbatim). ⚠ The scatter pool rounds the request UP to a perfect
 *  square, so 8 becomes 9 and 24 becomes 25; `groundFog.count` is
 *  authoritative. An `INT_FLAGS` quality override — it cannot turn the family
 *  on. Fallback 16 = the `high` tier. */
export function terrainGroundFogCount() {
  return Math.round(_terrainNum("terrainGroundFogCount", "terrainGroundFogCount", 16, 0, 256));
}

/** `?terrainGroundFogRadius` — HALF-extent (metres) of the fog ring; the ring
 *  covers 2× this and fades over the outer 35 %. Preset key
 *  `terrainGroundFogRadius` (low 32 / mid 40 / high 56 / ultra 72). Fallback
 *  56 m = the `high` tier. */
export function terrainGroundFogRadiusM() {
  return _terrainNum("terrainGroundFogRadius", "terrainGroundFogRadius", 56, 8, 512);
}

/** `?terrainGroundFogSoftness` — the soft-particle fade band in METRES for the
 *  fog's depth-buffer read. **0 (the default) leaves the depth read OFF.**
 *
 *  ⚠ URL-ONLY on purpose, and 0 by default on purpose — this is not timidity,
 *  it is the feedback-loop rule. The only scene-depth texture the client owns
 *  (`atmosphere_pipeline.js`'s `sceneDepthTexture`) is attached to BOTH composer
 *  ping-pong targets, i.e. it is the LIVE depth attachment while the world pass
 *  the fog cards draw in is running; sampling it from that pass is a
 *  framebuffer feedback loop and ANGLE may reject the draw. The soft-particle
 *  path is fully implemented and tested in `scene3d/ground_fog.js` (log-depth
 *  decode + NEAREST + a sentinel-aware threshold, all three mandated by plan
 *  trap T4 and `OPTICAL_EFFECTS_HANDOFF.md`), and this knob is how the 1070
 *  eye-test adjudicates it. Like `?terrainGrassDensity` and `?terrainSnowSlope`
 *  it carries NO preset key, so no tier can turn it on behind your back.
 *  Clamped 0..64. */
export function terrainGroundFogSoftnessM() {
  return _numFlag("terrainGroundFogSoftness", 0, 0, 64);
}

/** `?terrainMarshGasCount` — bubble vents per swamp landblock. Preset key
 *  `terrainMarshGasCount` (low 0 / mid 0 / high 2 / ultra 3). Each vent takes a
 *  distinct FAM_SWAMP vertex. An `INT_FLAGS` quality override — it cannot turn
 *  the family on. Fallback 2 = the `high` tier. */
export function terrainMarshGasCount() {
  return Math.round(_terrainNum("terrainMarshGasCount", "terrainMarshGasCount", 2, 0, 8));
}

// ---------------------------------------------------------------------------
// TERRAIN ROCK / BARREN (Wave 4A — plan §3.3). Codes 0 (`BarrenRock`),
// 13 (`SedimentaryRock`), 14 (`SemiBarrenRock`) and 30 (`olthoi`) = FAM_ROCK;
// the OLTHOI sub-variant (chitinous shards + the faint sickly emissive) is
// code 30 alone. Both sets are DERIVED in `terrain_rock.js`, never listed here.
//
// ONE family master + two effects, ALL strict exact-match opt-ins that ship OFF
// (plan §2.4/§5.9), all kept out of `quality.js BOOL_FLAGS` for the `gfxRelief`
// reason. Composition:
//     pebbles = terrainRockEnabled() && terrainRockPebblesEnabled()
//     grit    = terrainRockEnabled() && terrainRockGritEnabled()
// `?terrainVfx=off`, `?visual=off` and `?wireframe=1` each kill both.
//
// ⚠ Plan §3.3's third item, FOOTFALL DUST PUFFS, is "shared with §3.7" and gets
// NO flag here: the mechanism, the `entities.js` seam and the
// `?terrainFootfall` flag all landed in wave 3B and are owned by
// `terrain_dirt.js`. Extending it to dry rock is a DIRT-side change to
// `puffForGround` (which gates on FAM_DIRT and has a suite lock saying so) —
// see the `scene3d/terrain_rock.js` header.
// ---------------------------------------------------------------------------

let _terrainRock;
const _terrainRockWarn = { hit: false };
/** `?terrainRock=on` — THE family master for ROCK/BARREN (the opaque, lit
 *  pebble/rubble scatter + the grey grit streamers; plan §3.3). STRICT
 *  exact-match opt-in; absent ⇒ the quality preset's `terrainRock`, **false on
 *  all four tiers** this wave (§5.9 ship-OFF; the promotion target is
 *  high/ultra true). */
export function terrainRockEnabled() {
  if (_terrainRock !== undefined) return _terrainRock;
  const r = _terrainStrictFlag("terrainRock", "terrainRock", false, _terrainRockWarn);
  return r.memo ? (_terrainRock = r.value) : r.value;
}

let _terrainRockPebbles;
const _terrainRockPebblesWarn = { hit: false };
/** `?terrainRockPebbles=on` — the camera-scoped instanced pebble/rubble field
 *  (`scene3d/terrain_rock.js`, on the shared `terrain_scatter.js` pool). The one
 *  OPAQUE, LIT scatter field in the programme: it carries real fragment cost and
 *  a real day/night response, and it is the only reason this family needs the
 *  sky snapshot. Requires the family master. Absent ⇒ ON wherever the tier's
 *  `terrainRockPebbleCount` is non-zero (low = 0 ⇒ off), the same shape
 *  `terrainSandStreamers` and `terrainSnowSpindrift` use. */
export function terrainRockPebblesEnabled() {
  if (_terrainRockPebbles !== undefined) return _terrainRockPebbles;
  const raw = _strFlag("terrainRockPebbles");
  if (raw === "on") return (_terrainRockPebbles = true);
  if (raw === "off") return (_terrainRockPebbles = false);
  if (raw !== null && !_terrainRockPebblesWarn.hit) {
    _terrainRockPebblesWarn.hit = true;
    // eslint-disable-next-line no-console
    console.warn(
      `[terrainRockPebbles] ignoring ?terrainRockPebbles=${JSON.stringify(raw)} — the flag is an EXACT-match opt-in; use ?terrainRockPebbles=on (or =off).`,
    );
  }
  const flags = _presetFlags();
  if (!flags) return false;             // deliberately not memoized
  return (_terrainRockPebbles = Number(flags.terrainRockPebbleCount) > 0);
}

let _terrainRockGrit;
const _terrainRockGritWarn = { hit: false };
/** `?terrainRockGrit=on` — the grey, short-lived grit streamers skittering over
 *  hard ground: plan §3.3 item 2, "the §3.2 streamer module at 1/5 density,
 *  greyer, shorter life. A parameter block, not a new module." It is a parameter
 *  block of the SAND streamer maths, copied into `terrain_rock.js` exactly as
 *  wave 2A copied them for spindrift (widening `terrain_sand.js`'s hardcoded
 *  `families: [FAM_SAND]` would be a cross-family drive-by). Requires the family
 *  master. Absent ⇒ ON wherever the tier's `terrainRockGritCount` is non-zero
 *  (low = 0 ⇒ off). */
export function terrainRockGritEnabled() {
  if (_terrainRockGrit !== undefined) return _terrainRockGrit;
  const raw = _strFlag("terrainRockGrit");
  if (raw === "on") return (_terrainRockGrit = true);
  if (raw === "off") return (_terrainRockGrit = false);
  if (raw !== null && !_terrainRockGritWarn.hit) {
    _terrainRockGritWarn.hit = true;
    // eslint-disable-next-line no-console
    console.warn(
      `[terrainRockGrit] ignoring ?terrainRockGrit=${JSON.stringify(raw)} — the flag is an EXACT-match opt-in; use ?terrainRockGrit=on (or =off).`,
    );
  }
  const flags = _presetFlags();
  if (!flags) return false;             // deliberately not memoized
  return (_terrainRockGrit = Number(flags.terrainRockGritCount) > 0);
}

/** `?terrainRockPebbleCount` — instances in the pebble pool at the live tier.
 *  Preset key `terrainRockPebbleCount` (low 0 / mid 3000 / high 9000 /
 *  ultra 18000 — plan §3.3's tier table verbatim). ⚠ The scatter pool rounds the
 *  request UP to a perfect square, so 3000 becomes 3025 and 18000 becomes 18225;
 *  `pool.count` is authoritative. An `INT_FLAGS` quality override — it cannot
 *  turn the family on by itself. Fallback 9000 = the `high` tier. */
export function terrainRockPebbleCount() {
  return Math.round(_terrainNum("terrainRockPebbleCount", "terrainRockPebbleCount", 9000, 0, 200000));
}

/** `?terrainRockGritCount` — instances in the grit-streamer pool at the live
 *  tier. Preset key `terrainRockGritCount` (low 0 / mid 160 / high 400 /
 *  ultra 600) — plan §3.3 item 2's "1/5 density" applied to §3.2's streamer
 *  ladder (800/2000/3000), because §3.3's own tier table names pebbles only.
 *  An `INT_FLAGS` quality override. Fallback 400 = the `high` tier. */
export function terrainRockGritCount() {
  return Math.round(_terrainNum("terrainRockGritCount", "terrainRockGritCount", 400, 0, 20000));
}

/** `?terrainRockRadius` — HALF-extent (metres) of BOTH rock windows; each field
 *  covers 2× this. Preset key `terrainRockRadius` (low 32 / mid 40 / high 56 /
 *  ultra 72 — the `terrainDirtRadius` ladder: pebbles are opaque and lit, so
 *  they buy nothing from render scale and want a tighter window than the
 *  additive families). Fallback 56 m = the `high` tier. Cannot enable the
 *  feature on its own. */
export function terrainRockRadiusM() {
  return _terrainNum("terrainRockRadius", "terrainRockRadius", 56, 8, 512);
}

/** `?terrainRockDensity` — 0..2 multiplier on BOTH tier counts (pebbles AND
 *  grit), default 1.0. THE knob plan §3.3 names alongside the master. URL-ONLY
 *  on purpose (no preset key), exactly like `?terrainGrassDensity`,
 *  `?terrainSnowSlope` and `?terrainDirtDustDensity`: it is the continuous A/B
 *  knob for the 1070 perf sweep, while the tier owns the shipped counts. 0
 *  disables the whole family's geometry. Note it multiplies BOTH pools because
 *  §3.3 gives the family ONE density knob — per-effect counts are the two
 *  `*Count` flags above. */
export function terrainRockDensity() {
  return _numFlag("terrainRockDensity", 1, 0, 2);
}

let _budget;
/** `?visualBudget` — governor STUB (Phase 1). A soft cap on concurrently-active
 *  VFX component-SETs / per-frame VFX cost units the future bloom/light governor
 *  (build spec §10/§11) will enforce. DEFAULT ∞ (uncapped). Parsed + memoized
 *  now; nothing consumes it yet (queued-for-1070). Clamp 0..4096. */
export function visualBudget() {
  if (_budget === undefined) _budget = _numFlag("visualBudget", Infinity, 0, 4096);
  return _budget;
}

// Component-id → per-effect flag reader (the gate router). Extend per effect.
// flameFlicker is a light-tick (not a frag component) but rides the same gate.
export const VFX_EFFECT_FLAGS = Object.freeze({
  "deformation.tipFlex": tipFlexEnabled,
  "emissive.glint": glintEnabled,
  "emissive.magicGlow": magicGlowEnabled,
  "emissive.enchantShimmer": enchantShimmerEnabled,
  "weathering.tarnish": tarnishEnabled,
  "weathering.wetness": wetnessEnabled,
  "weathering.frost": frostEnabled,
  "light.flameFlicker": flameFlickerEnabled,
  "particle.gemSparkle": gemSparkleEnabled,
  "particle.brazierEmbers": brazierEnabled,
  "particle.foliagePollen": foliagePollenEnabled,
  "particle.foliageFireflies": foliageFirefliesEnabled,
  "particle.foliageLeaves": foliageLeavesEnabled,
  "particle.breathFog": breathFogEnabled,
  // Terrain VFX (Wave 0B). Registered so `?visual=off` kills the terrain
  // programme too (the firewall composition rule in this file's header) and so
  // `vfxEffectEnabled("terrain.trailMap")` resolves rather than falling through
  // to visualAllEffects() — which, being DEFAULT-ON, would have turned a
  // ship-OFF effect on. Note these readers do NOT track visualAllEffects(), so
  // `?visual=all` does NOT light them: they are strict opt-ins (plan §2.4/§5.9)
  // and the count of DEFAULT-ON effects is unchanged at 14.
  // The MASTER kill switch `?terrainVfx` is deliberately absent — it is a
  // master gate like `?visual`/`?visualAll`, not a per-effect row.
  "terrain.grass": terrainGrassEnabled,
  "terrain.grassStomp": terrainGrassStompEnabled,
  "terrain.trailMap": terrainTrailEnabled,
  // Terrain SAND (Wave 1B, plan §3.2) — same contract as the row above: strict
  // ship-OFF opt-ins that do NOT track visualAllEffects(), so `?visual=all`
  // does not light them and the DEFAULT-ON count stays 14. The three effect
  // rows compose the family master themselves, so `vfxEffectEnabled` answers
  // the same question the effect asks.
  "terrain.sand": terrainSandEnabled,
  "terrain.sandStreamers": () => terrainSandEnabled() && terrainSandStreamersEnabled(),
  "terrain.sandDevils": () => terrainSandEnabled() && terrainSandDevilsEnabled(),
  "terrain.sandSparkle": () => terrainSandEnabled() && terrainSandSparkleEnabled(),
  // Terrain SNOW / ICE (Wave 2A, plan §3.4) — same contract again: strict
  // ship-OFF opt-ins that do NOT track visualAllEffects(), so `?visual=all`
  // does not light them and the DEFAULT-ON count stays 14. `terrain.snow` and
  // `terrain.ice` are two independent family masters (particles+shader vs a
  // material change), so both get a row.
  "terrain.snow": terrainSnowEnabled,
  "terrain.snowSpindrift": () => terrainSnowEnabled() && terrainSnowSpindriftEnabled(),
  "terrain.snowSparkle": () => terrainSnowEnabled() && terrainSnowSparkleEnabled(),
  "terrain.snowPrints": () => terrainSnowEnabled() && terrainSnowPrintsEnabled(),
  "terrain.ice": terrainIceEnabled,
  "terrain.iceRefraction": () => terrainIceEnabled() && terrainIceRefractionEnabled(),
  // Terrain VOLCANO (Wave 2B, plan §3.6) — same contract again: strict ship-OFF
  // opt-ins that do NOT track visualAllEffects(), so `?visual=all` does not
  // light them and the DEFAULT-ON count stays 14. Each row composes the family
  // master itself, so `vfxEffectEnabled` answers the same question the effect
  // asks. `terrain.volcanoEmbers` is also the REGISTERED COMPONENT ID of
  // `vfx/components/terrainVolcanoEmbers.js`, which is what makes
  // `vfxEffectEnabled(component.id)` resolve for it.
  "terrain.volcano": terrainVolcanoEnabled,
  "terrain.volcanoHaze": () => terrainVolcanoEnabled() && terrainHazeEnabled(),
  "terrain.volcanoEmbers": () => terrainVolcanoEnabled() && terrainEmbersEnabled(),
  "terrain.volcanoCrackGlow": () => terrainVolcanoEnabled() && terrainCrackGlowEnabled(),
  // Terrain DIRT / MUD (Wave 3B, plan §3.7) — same contract again: strict
  // ship-OFF opt-ins that do NOT track visualAllEffects(), so `?visual=all` does
  // not light them and the DEFAULT-ON count stays 14. Each row composes the
  // family master itself, so `vfxEffectEnabled` answers the same question the
  // effect asks. `terrain.footfall`, `terrain.mudPrints` and `terrain.dirtDust`
  // are also the PROVIDER IDS registered with the terrain-VFX spine.
  "terrain.dirt": terrainDirtEnabled,
  "terrain.footfall": () => terrainDirtEnabled() && terrainFootfallEnabled(),
  "terrain.mudPrints": () => terrainDirtEnabled() && terrainMudPrintsEnabled(),
  "terrain.mudWetness": () => terrainDirtEnabled() && terrainMudWetnessEnabled(),
  "terrain.dirtDust": () => terrainDirtEnabled() && terrainDustHazeEnabled(),
  // Terrain SWAMP / MARSH (Wave 3A, plan §3.5) — same contract again: strict
  // ship-OFF opt-ins that do NOT track visualAllEffects(), so `?visual=all`
  // does not light them and the DEFAULT-ON count stays 14. Three of these rows
  // are also the REGISTERED COMPONENT IDS of
  // `vfx/components/terrainSwampAmbient.js` (`terrain.swampFireflies`,
  // `terrain.swampMidges`, `terrain.marshGas`), which is what makes
  // `vfxEffectEnabled(component.id)` resolve for them.
  // ⚠ `terrain.swampFireflies` is a SECOND ANCHOR for the SAME registered
  // firefly behaviour, not a second effect: `particle.foliageFireflies` above
  // still independently gates the canopy anchors and is untouched.
  "terrain.swamp": terrainSwampEnabled,
  "terrain.groundFog": () => terrainSwampEnabled() && terrainGroundFogEnabled(),
  "terrain.marshGas": () => terrainSwampEnabled() && terrainMarshGasEnabled(),
  "terrain.swampFireflies": () => terrainSwampEnabled() && terrainSwampFirefliesEnabled(),
  "terrain.swampMidges": () => terrainSwampEnabled() && terrainSwampMidgesEnabled(),
  // Terrain ROCK / BARREN (Wave 4A, plan §3.3) — same contract again: strict
  // ship-OFF opt-ins that do NOT track visualAllEffects(), so `?visual=all` does
  // not light them and the DEFAULT-ON count stays 14. Each row composes the
  // family master itself, so `vfxEffectEnabled` answers the same question the
  // effect asks. `terrain.rockPebbles` and `terrain.rockGrit` are also the
  // PROVIDER IDS registered with the terrain-VFX spine. There is deliberately
  // NO `terrain.rockFootfall` row: plan §3.3 item 3 is the wave-3B dirt puff
  // mechanism, whose row is `terrain.footfall`.
  "terrain.rock": terrainRockEnabled,
  "terrain.rockPebbles": () => terrainRockEnabled() && terrainRockPebblesEnabled(),
  "terrain.rockGrit": () => terrainRockEnabled() && terrainRockGritEnabled(),
});

/**
 * Is this VFX component's effect live? Requires the ?visual master gate AND the
 * component's per-effect flag — the single gate the frag-install path + each
 * per-component installer consult. Unknown ids fall back to visualAllEffects()
 * (so `?visual=all` lights up a not-yet-flagged component, otherwise off).
 * Fail-safe: master off ⇒ always false ⇒ byte-identical frozen render.
 */
export function vfxEffectEnabled(componentId) {
  if (!visualEnabled()) return false;
  const reader = VFX_EFFECT_FLAGS[componentId];
  return reader ? reader() : visualAllEffects();
}

/** The component ids whose effect is currently active (diag / gauge / slice 15). */
export function vfxActiveEffectIds() {
  if (!visualEnabled()) return [];
  return Object.keys(VFX_EFFECT_FLAGS).filter((id) => VFX_EFFECT_FLAGS[id]());
}

/** Reset memoized flag readers (tests only). */
export function _resetVfxFlags() {
  _all = _glint = _magicGlow = _enchantShimmer = _tarnish = _wetness = _frost = _flameFlicker = _tipFlex = _gemSparkle = _brazier = _foliagePollen = _foliageFireflies = _foliageLeaves = _breathFog = _budget = undefined;
  _terrainVfx = _terrainTrail = undefined;
  _terrainTrailWarned = _terrainTrailImpliedLogged = _terrainTrailSuppressedWarned = false;
  _terrainGrass = _terrainGrassStomp = undefined;
  _terrainGrassWarned = _terrainGrassStompWarned = false;
  _terrainSand = _terrainSandStreamers = _terrainSandDevils = _terrainSandSparkle = undefined;
  _terrainSandWarn.hit = false;
  _terrainSandStreamersWarn.hit = false;
  _terrainSandDevilsWarn.hit = false;
  _terrainSandSparkleWarn.hit = false;
  _terrainSnow = _terrainSnowSpindrift = _terrainSnowSparkle = _terrainSnowPrints = undefined;
  _terrainIce = _terrainIceRefraction = undefined;
  _terrainSnowWarn.hit = false;
  _terrainSnowSpindriftWarn.hit = false;
  _terrainSnowSparkleWarn.hit = false;
  _terrainSnowPrintsWarn.hit = false;
  _terrainIceWarn.hit = false;
  _terrainIceRefractionWarn.hit = false;
  _terrainVolcano = _terrainHaze = _terrainEmbers = _terrainCrackGlow = undefined;
  _terrainVolcanoWarn.hit = false;
  _terrainHazeWarn.hit = false;
  _terrainEmbersWarn.hit = false;
  _terrainCrackGlowWarn.hit = false;
  _terrainDirt = _terrainFootfall = _terrainMudPrints = undefined;
  _terrainMudWetness = _terrainDustHaze = undefined;
  _terrainDirtWarn.hit = false;
  _terrainFootfallWarn.hit = false;
  _terrainMudPrintsWarn.hit = false;
  _terrainMudWetnessWarn.hit = false;
  _terrainDustHazeWarn.hit = false;
  _terrainSwamp = _terrainGroundFog = _terrainMarshGas = _terrainMarshWisps = undefined;
  _terrainSwampFireflies = _terrainSwampMidges = undefined;
  _terrainSwampWarn.hit = false;
  _terrainGroundFogWarn.hit = false;
  _terrainMarshGasWarn.hit = false;
  _terrainMarshWispsWarn.hit = false;
  _terrainSwampFirefliesWarn.hit = false;
  _terrainSwampMidgesWarn.hit = false;
  _terrainRock = _terrainRockPebbles = _terrainRockGrit = undefined;
  _terrainRockWarn.hit = false;
  _terrainRockPebblesWarn.hit = false;
  _terrainRockGritWarn.hit = false;
}
