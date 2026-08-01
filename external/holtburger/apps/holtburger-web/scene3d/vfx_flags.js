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

let _terrainTrail;
let _terrainTrailWarned = false;
/** `?terrainTrail=on` — the shared stomp/footprint trail map
 *  (`scene3d/trail_map.js`): one R8 render target centred on the player that
 *  grass reads to flatten blades, snow to dent drifts and mud to keep a print.
 *  STRICT exact-match opt-in; anything unrecognised warns and does NOT enable
 *  (a silent no-op here is indistinguishable from a broken decode —
 *  `gfx_relief.js:137` makes exactly this argument). Absent ⇒ the quality
 *  preset's `terrainTrail`, which is **false on all four tiers this wave**.
 *  The preset branch is NOT memoized: it may be consulted before
 *  `window.liveScene3d.quality` exists, and caching "not ready" would stick. */
export function terrainTrailEnabled() {
  if (_terrainTrail !== undefined) return _terrainTrail;
  const raw = _strFlag("terrainTrail");
  if (raw === "on") return (_terrainTrail = true);
  if (raw === "off") return (_terrainTrail = false);
  // One-shot: the preset branch below deliberately does not memoize, so this
  // reader can run every init — the warn must not become a log flood.
  if (raw !== null && !_terrainTrailWarned) {
    _terrainTrailWarned = true;
    // eslint-disable-next-line no-console
    console.warn(
      `[terrainTrail] ignoring ?terrainTrail=${JSON.stringify(raw)} — the master flag is an EXACT-match opt-in; use ?terrainTrail=on (or =off).`,
    );
  }
  const flags = _presetFlags();
  if (!flags) return false;             // deliberately not memoized
  return (_terrainTrail = flags.terrainTrail === true);
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

/** `?terrainTrailFade` — seconds for a full stomp to recover to zero. Preset
 *  key `terrainTrailFade`. Fallback 4 s (grass springback, plan §3.1); mud
 *  wants ~30 s and snow effectively never, so families override per effect. */
export function terrainTrailRecoverySec() {
  return _terrainNum("terrainTrailFade", "terrainTrailFade", 4, 0.05, 300);
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
  _terrainTrailWarned = false;
  _terrainGrass = _terrainGrassStomp = undefined;
  _terrainGrassWarned = _terrainGrassStompWarned = false;
  _terrainSand = _terrainSandStreamers = _terrainSandDevils = _terrainSandSparkle = undefined;
  _terrainSandWarn.hit = false;
  _terrainSandStreamersWarn.hit = false;
  _terrainSandDevilsWarn.hit = false;
  _terrainSandSparkleWarn.hit = false;
}
