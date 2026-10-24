// scene3d/terrain_sand.js — SAND / DESERT terrain VFX (Wave 1B).
//
// Design plan: `docs/2026-07-31-terrain-vfx-plan.md` §3.2. Terrain codes 10
// (`sand-yellow`), 11 (`sand-grey`) and 12 (`sand-rockStrewn`) = `FAM_SAND` —
// derived from `terrain_families.js`, never hardcoded here (plan §8 risk 12:
// family membership is a property of the CODE, and another region could name
// the same code differently).
//
// THE LOOK (plan §3.2): the surface is MOVING. Low sheets of wind-driven sand
// stream across the ground; the occasional dust devil turns; grains catch the
// sun as a fine grazing-angle sparkle.
//
// THREE EFFECTS, THREE OWNERS:
//   1. STREAMERS  — here. A camera-scoped instanced RIBBON field built on
//      `terrain_scatter.js` (the shared pool: placement, residency, family
//      gating, amortisation). Advected along the shared wind vector, opacity
//      pulsing on a drifting gust field so sheets form and dissolve.
//   2. DUST DEVILS — here (lifecycle) + `vfx/components/terrainDustDevil.js`
//      (the registered, lint-passing descriptor). Landblock-scoped, hash-stable
//      home slots, synthesized through the EXISTING particle system and owned
//      through the owner registry.
//   3. GRAIN SPARKLE — in the TERRAIN FRAGMENT SHADER (`terrain.js`, search
//      `SAND SPARKLE`), gated on FAM_SAND read from `uVertexTypes` (plan trap
//      T3), sited after the POM `cellUv` offset and bypassed on any
//      water-touching cell (plan §2.7.3). This file owns its FLAG and its live
//      tuning knobs (`window.__terrainSand.sparkle({...})`), nothing else.
//   (HEAT SHIMMER / the desert MIRAGE is `terrain_desert_haze.js` — not here.)
//
// 2026-10-23 — "IMPROVE BEFORE THE VISTEST" (owner, 1070, high tier, noon:
// "streamers, dust devils and grain sparkle are essentially invisible").
// Diagnosed from the before-stills + stats, each with a physical fix:
//   STREAMERS. (a) A flat 0.22 m quad seen by a chase camera ~15° above the
//     ground foreshortens to ~3 px: now a camera-facing RIBBON about its own
//     along-wind axis (constant apparent height, never edge-on). (b) ADDITIVE
//     tan over bright tan sand adds almost nothing and glows at night: now
//     NORMAL-blended airborne sand — paler and less saturated than the code it
//     blows over (the same mineral, scattered in air) and LIT by the very
//     retail-Gouraud light the ground is (`uAcSunVec/uAcSunColor/uAcAmb*`
//     copied off the terrain material each frame), so it is dark at night by
//     construction. (c) The per-instance opacity multiplied the pool's
//     SCATTER-TIME fade, which is frozen: leading-edge instances are scattered
//     at the rim (fade ≈ 0) and keep that as the player walks onto them, so
//     after ~16 m of walking the whole near field was invisible. Only the live
//     shader fade remains. (d) The gust field scrolled UPWIND (sign bug) and
//     averaged ~10 % coverage; it now drifts downwind with ~40 % coverage and
//     two octaves. (e) The 26 m recycle span with no envelope popped and let a
//     streak slide 13 m off its anchor over dunes; now an 18 m span with a
//     fade-in/fade-out life envelope, and the ribbon follows the ground PLANE
//     at its anchor (the pool's scattered normal) instead of a flat z.
//     (f) A sinuous meander along the path: the "sand snake" look.
//   DEVILS. (a) 40 sprites of 0.2-0.5 m rising ~5 m read as sub-pixel specks
//     at 100-250 m: the descriptor now builds a 15-30 m funnel (see there).
//     (b) Persistent, motionless fountains: a devil now has a deterministic
//     LIFE (forms, wanders downwind 70-160 m with a lateral wobble, dissolves;
//     idle a while; repeats), pure in (seed, clock, wind). (c) LRU residency
//     is capacity-driven, not distance-driven (the volcano haze learnt this as
//     `VOLCANO_TUNING.hazeMaxEngageM`): across the owner's teleport tour 79
//     landblocks 129-139 LBs away were still UNPARKED and EMITTING. Emission is
//     now distance-gated to `devilEngageM` around the player and capped to the
//     N nearest live devils; anything beyond is destroyed outright (it is past
//     the draw radius, so nothing visible is cut). `devilLandblocks` is still
//     the LRU's (bounded) residency count — the cost now lives in
//     `devilsActive`, which is distance-bounded.
//     (d) 2026-10-24: a STOPPED (dissolving) devil holds its emitter only for
//     its longest puff life + 1 s, then `_evalRec` releases the slot
//     (`DEVIL_DRAIN_MARGIN_S`), so `devilsHoldingEmitter` and
//     `devilRangeDestroys` no longer count emitters the manager has reaped.
//   SPARKLE — see the terrain.js block (`SAND GRAIN SPARKLE`).
//
// 2026-10-24 — RACING STREAMERS (the rock grit pass found the same pair in
// `terrain_rock.js` the same day; its header carries the full derivation).
//   (1) The advection was `uTime * uSpeed * aStreak.y * |wind|`. Its time
//       derivative carries `uTime * d|wind|/dt`, so as the calm wind breathes
//       (+-6 % over 13 s) the ribbons sped up with session age: an hour in they
//       slid hundreds of m/s and, aliased across the 18 m span, read as
//       flicker. (2) The gust sheets scrolled by `dir * (uTime * uPulseSpeed)`,
//       so the 45 s +-12 deg direction wander swept them sideways at
//       `uTime * uPulseSpeed * dtheta/dt` (~230 m/s an hour in). Both are now
//       INTEGRATED on the CPU from the frame `dt`: `uTravel` (integral of
//       |wind| dt) and `uPulseOffset` (integral of dir * pulseSpeed dt, metres,
//       still DOWNWIND). For a constant wind both equal the old closed forms
//       exactly (`streamerAdvect` stays that closed form; `streamerAdvectTravel`
//       is the live GLSL twin), so the look at constant wind is unchanged.
//       `uTravel` wraps SEAMLESSLY: per-ribbon speeds are quantised to
//       k/64 (`streamerSpeedMul`, the same 0.75..1.35 spread; the rounding,
//       at most 1/128, is under 1.1 % of a ribbon's speed), and the
//       `terrain_rock.js` helpers (`gritTravelWrap` / `gritAdvectTravel` /
//       `GRIT_SPEED_QUANTUM` / `GRIT_MAX_DT`) are reused unchanged. The
//       `uTime` terms left in the shader (meander `uWaveW`, grain
//       `uSpeed * 0.9`) multiply TUNING constants, never the wind, so their
//       rate is fixed: no race. (Their float32 phase still coarsens with
//       session age like any absolute-clock term: ~24 h in, the grain phase
//       is ~2.8e5 rad and steps in 0.03 rad quanta. Cosmetic, pre-existing.)
//
// INJECTED THREE (the `terrain_vfx.js` / `trail_map.js` / `terrain_scatter.js`
// idiom). This module imports no three: `initTerrainSand({THREE, scene3d, ...})`
// takes it, and every GPU object is optional — with no THREE the providers still
// run their full CPU bookkeeping. That is what keeps `test_terrain_sand.mjs` a
// pure-node test and what makes `?nullRender=1` free.
//
// INVARIANTS (plan §5). A HOST module, not a registered VFX component: it is not
// swept by `vfx/lint_caps.js` (the DESCRIPTOR next door is). It obeys the
// firewall anyway — it reads static terrain, a server-derived player position,
// the shared clock, the shared wind, the derived weather env and the terrain's
// own light uniforms, and writes only its own buffers, uniforms and
// synthesized emitters (plus, when the owner turns a live sparkle knob, the
// sparkle uniforms on the terrain materials). It adds no light (§5.2), varies
// no program cache key (§5.4 — one material, no per-instance key), uses no
// `Math.random` (§5.5), binds the clock BY REFERENCE (§5.6), sets
// `castShadow = false` (§5.7) and allocates nothing per frame.
//
// FLAGS (plan §2.4, all STRICT `=== "on"` opt-ins that ship OFF):
//   ?terrainSand           family master  (also `?terrainVfx=off`, `?visual=off`
//                                          and `?wireframe=1` kill everything)
//   ?terrainSandStreamers  ?terrainSandDevils  ?terrainSandSparkle
//   ?terrainSandStreamerCount  ?terrainSandDevilCount  ?terrainSandRadius

import {
  FAM_SAND,
  TERRAIN_CODE_COUNT,
  familyForCode,
} from "./terrain_families.js";
import { createScatterPool, SCATTER_FADE_GLSL, scatterHash01 } from "./terrain_scatter.js";
import { registerTerrainVfx, unregisterTerrainVfx, lbKeyFromXY } from "./terrain_vfx.js";
import {
  terrainSandEnabled,
  terrainSandStreamersEnabled,
  terrainSandDevilsEnabled,
  terrainSandSparkleEnabled,
  terrainSandStreamerCount,
  terrainSandDevilCount,
  terrainSandRadiusM,
} from "./vfx_flags.js";
import { staticOwnerKeyForLb } from "./vfx/particle_attach.js";
import { ownerRegistry as defaultOwnerRegistry } from "./particles/owner_registry.js";
import { terrainDustDevil, dustDevilGate } from "./vfx/components/terrainDustDevil.js";
import { withLogDepth } from "./shader_logdepth.js";
// The rock grit's 2026-10-24 travel integrator, reused unchanged (it is
// parameter-free once the span is resolved; see the header). `terrain_rock.js`
// imports no three and nothing from this module, so there is no cycle.
import {
  GRIT_SPEED_QUANTUM,
  GRIT_MAX_DT,
  gritTravelWrap,
  gritAdvectTravel,
} from "./terrain_rock.js";

export const METERS_PER_LANDBLOCK = 192;
export const VERTEX_GRID = 9;
export const VERTEX_SPACING_M = 24;

/** Segments along one streamer ribbon (the meander needs a bendable strip). */
export const RIBBON_SEGMENTS = 8;

/** Provider ids — also the `VFX_EFFECT_FLAGS` router rows. */
export const STREAMER_PROVIDER_ID = "terrain.sandStreamers";
export const DEVIL_PROVIDER_ID = "terrain.sandDevils";

// ---------------------------------------------------------------------------
// Pure helpers — no THREE, no window. The directly-tested surface.
// ---------------------------------------------------------------------------

/** The terrain codes that are FAM_SAND, DERIVED from the family LUT. */
export function sandTerrainCodes() {
  const out = [];
  for (let c = 0; c < TERRAIN_CODE_COUNT; c += 1) {
    if (familyForCode(c) === FAM_SAND) out.push(c);
  }
  return out;
}

/** The same set as a GPU bitmask (the `computeCodeBitmask` convention). */
export function sandCodeBitmask() {
  let mask = 0;
  for (const c of sandTerrainCodes()) mask |= (1 << c);
  return mask >>> 0;
}

/**
 * Tuning that is NOT worth a URL flag. These are the DEFAULTS; the live values
 * are a mutable copy (`window.__terrainSand.tune({...})`, reset on re-init).
 */
export const SAND_TUNING = Object.freeze({
  // --- STREAMERS -----------------------------------------------------------
  // Ribbon geometry, metres. A ribbon is long, low and camera-facing about its
  // along-wind axis; "height" is its extent off the sand.
  streakLengthM: 4.8,
  streakLengthJitter: 0.4,      // ±40 % per instance
  streakHeightM: 0.34,
  streakHeightJitter: 0.35,
  // Lift of the ribbon's foot above the ground (plan §3.2: "z = height +
  // 0.05..0.4"); the ribbon then rises `streakHeightM` from there.
  liftMinM: 0.05,
  liftMaxM: 0.12,
  // Advection: metres/second per unit of wind magnitude, and the distance a
  // ribbon travels before it recycles. Short enough that the ground-PLANE
  // approximation at the anchor holds over dunes; the life envelope below
  // hides the recycle.
  advectSpeed: 3.6,
  advectSpanM: 18,
  lifeFadeIn: 0.22,             // fraction of the span spent fading in
  lifeFadeOut: 0.3,             // ... and out
  // The meander ("sand snakes"): lateral amplitude, wavelength along the path,
  // and a slow evolution so a standing camera does not see a frozen pattern.
  waveAmpM: 0.32,
  waveLengthM: 5.5,
  waveRadPerSec: 0.45,
  // The gust field: sheets form, drift DOWNWIND and dissolve.
  pulseFreq: 0.05,              // cycles per metre (≈20 m sheets)
  pulseSpeedMps: 2.2,           // sheet drift speed, downwind
  pulseThreshold: 0.36,         // noise level where a sheet starts
  pulseSoft: 0.3,               // ... and the band over which it ramps in
  stormThresholdDrop: 0.12,     // a stormy sky lowers the threshold (more sheets)
  // Airborne sand is the SAME mineral as the code it blows over, scattered in
  // air: paler and less saturated. tint = mix(albedo, luma, desat) * lift.
  tintLift: 1.55,
  tintDesat: 0.45,
  colour: Object.freeze([1, 1, 1]),   // live multiplier on the tint
  opacity: 0.75,                // peak alpha ≈ 0.3-0.4 after the profile
  gateCalm: 0.8,                // weather gate in dead calm, dry, clear air
  envRefreshSec: 0.25,          // weather env re-read cadence
  // --- DEVILS ----------------------------------------------------------------
  devilColumnRadiusM: 2.4,
  devilJitterM: 9,              // in-cell placement jitter (cell is 24 m)
  // Emission is DISTANCE-gated (LRU residency is not): only home slots within
  // this of the player may run a devil; past ×1.15 a held emitter is destroyed.
  // ≥ the descriptor's draw radius (480 m), so the destroy is never visible.
  devilEngageM: 520,
  devilMaxActivePerCount: 6,    // live-devil cap = this × the tier's devilCount
  // The deterministic life: period, the share of it a devil is alive, how far
  // it wanders downwind over that life and its lateral wobble.
  devilPeriodMinSec: 150,
  devilPeriodMaxSec: 270,
  devilDutyMin: 0.42,
  devilDutyMax: 0.7,
  devilTravelMinM: 70,
  devilTravelMaxM: 160,
  devilWobbleMinM: 3,
  devilWobbleMaxM: 8,
  devilWobbleCyclesMin: 1.2,
  devilWobbleCyclesMax: 2.6,
  devilGateMin: 0.15,           // below this the weather cannot hold a devil up
  devilEvalHz: 2,               // start/stop decisions (moves are per frame)
});

/**
 * Resolve the live SAND quality tier. `null` ⇒ the whole family is disabled at
 * this tier (plan §5.8: "`low` is null/disabled for every effect here without
 * exception"). Pure in `flags`.
 *
 * @param {object|null} flags `liveScene3d.quality.flags`-shaped bag.
 * @returns {{streamerCount:number, devilCount:number, sparkle:boolean,
 *   radiusM:number}|null}
 */
export function resolveSandQuality(flags) {
  const num = (v, def) => (Number.isFinite(Number(v)) ? Number(v) : def);
  const streamerCount = Math.max(0, Math.round(num(flags?.terrainSandStreamerCount, 0)));
  const devilCount = Math.max(0, Math.round(num(flags?.terrainSandDevilCount, 0)));
  const sparkle = flags?.terrainSandSparkle === true;
  const radiusM = Math.min(512, Math.max(8, num(flags?.terrainSandRadius, 64)));
  if (streamerCount === 0 && devilCount === 0 && !sparkle) return null;
  return { streamerCount, devilCount, sparkle, radiusM };
}

/**
 * The shared wind vector in AC ground coordinates (+X east, +Y north).
 *
 * `VFX_GLOBALS.uWindDir` is a `Vector2` holding the THREE-space ground wind
 * `(x, z)` (`vfx/weather_inputs.js::writeWindVector`), and three `z` is AC `-y`
 * — so the conversion is `(w.x, -w.y)`. It is bound BY REFERENCE and written
 * once per frame by `loop.js::tickVfxWeatherInputs`; never snapshot it.
 *
 * With no globals (node, or a boot that has not built the VFX uniforms) this
 * falls back to `tree_wind.js`'s prevailing 135° (SE) at unit strength, so the
 * effect is still deterministic and still moves.
 *
 * @param {{uWindDir?:{value:{x:number,y:number}}}|null} globals VFX_GLOBALS
 * @param {{x:number,y:number}} out zero-alloc target
 */
export function windAcFromGlobals(globals, out) {
  const o = out || { x: 0, y: 0 };
  const v = globals && globals.uWindDir ? globals.uWindDir.value : null;
  if (v && Number.isFinite(v.x) && Number.isFinite(v.y)) {
    o.x = v.x;
    o.y = -v.y;
    if (o.x !== 0 || o.y !== 0) return o;
  }
  // 135° = SE, the tree_wind default (`tree_wind.js:53 treeWindDir`).
  o.x = Math.cos((135 * Math.PI) / 180);
  o.y = Math.sin((135 * Math.PI) / 180);
  return o;
}

/**
 * Streamer advection — the offset (metres, AC frame) of one ribbon from its
 * scattered anchor at time `tSec`.
 *
 * THE CONTRACT (plan §3.2 tests): a PURE function of (wind, clock, hash). No
 * player state, no frame history, no `Math.random`. The GLSL in
 * `SAND_STREAMER_VERTEX_GLSL` computes exactly this expression, so the JS is
 * both the test oracle and the readable spec.
 *
 * The ribbon slides along the wind and RECYCLES every `spanM` metres, phased by
 * its own hash so the field never pulses in lockstep. Wind MAGNITUDE scales the
 * speed (gusts blow harder), wind DIRECTION steers.
 *
 * ⚠ 2026-10-24: this is the CONSTANT-wind closed form. The GLSL now runs
 * `streamerAdvectTravel` with `tSec * |wind|` replaced by `uTravel`, the
 * per-frame INTEGRAL of the live gust magnitude — identical for a constant
 * wind (this function is that identity), but for a breathing wind the
 * product's derivative grows with session time (the racing bug, header).
 *
 * @param {number} windX AC east component
 * @param {number} windY AC north component
 * @param {number} tSec  the shared clock (`scene3d.frameTime.tsSec`)
 * @param {number} phase01 per-instance hash, [0,1)
 * @param {number} spanM recycle distance
 * @param {number} speed metres/second per unit wind magnitude
 * @param {{x:number,y:number,s:number}} [out]
 */
export function streamerAdvect(windX, windY, tSec, phase01, spanM, speed, out) {
  const o = out || { x: 0, y: 0, s: 0 };
  const span = Number.isFinite(spanM) && spanM > 0 ? spanM : SAND_TUNING.advectSpanM;
  const wl = Math.max(Math.hypot(windX, windY), 1e-4);
  const dx = windX / wl;
  const dy = windY / wl;
  const travelled = tSec * speed * wl + phase01 * span;
  let s = travelled % span;
  if (s < 0) s += span;
  s -= span * 0.5;
  o.s = s;
  o.x = dx * s;
  o.y = dy * s;
  return o;
}

/** Per-frame `dt` ceiling for the travel / gust-sheet integrators (a resumed
 *  background tab must not jump the field) — the rock grit's, shared. */
export const STREAMER_MAX_DT = GRIT_MAX_DT;
/** Per-ribbon speed multipliers are multiples of 1 / this (seamless wrap). */
export const STREAMER_SPEED_QUANTUM = GRIT_SPEED_QUANTUM;

/**
 * The per-ribbon speed multiplier: the 0.75..1.35 spread drawn by a [0,1)
 * hash, QUANTISED to multiples of `1 / STREAMER_SPEED_QUANTUM` (k/64, so
 * 48/64..86/64). That is what lets the CPU travel accumulator wrap with no
 * seam: at a wrap of `streamerTravelWrap(span, speed)` every ribbon's
 * travelled distance changes by a WHOLE number of recycle spans, so
 * `mod(travelled, span)` is unchanged for every ribbon. The rounding (at most
 * half a step, 1/128) is under 1.1 % of the slowest ribbon's speed; the step
 * itself (1/64) is ~2.1 % of it. PURE; exact in float32.
 *
 * @param {number} r01 the pool's `ctx.rand` draw
 * @returns {number} k / 64
 */
export function streamerSpeedMul(r01) {
  const r = Number.isFinite(r01) ? Math.min(1, Math.max(0, r01)) : 0.5;
  return Math.round((0.75 + r * 0.6) * STREAMER_SPEED_QUANTUM) / STREAMER_SPEED_QUANTUM;
}

/**
 * The travel wrap period, in `uTravel` units (seconds x gust): after it every
 * quantised ribbon has crossed a WHOLE number of spans. `terrain_rock.js::
 * gritTravelWrap` with the SAND span default (~1280 s of unit wind at the
 * shipped 18 m / 3.6 m/s). Infinity for a non-positive speed.
 *
 * @param {number} spanM recycle distance (`uSpanM`)
 * @param {number} speed metres/second per unit wind (`uSpeed`)
 */
export function streamerTravelWrap(spanM, speed) {
  const span = Number.isFinite(spanM) && spanM > 0 ? spanM : SAND_TUNING.advectSpanM;
  return gritTravelWrap(span, speed);
}

/**
 * Streamer advection from an INTEGRATED travel — the JS twin of the advection
 * at the top of `SAND_STREAMER_VERTEX_GLSL`, symbol for symbol:
 * `travelled = uTravel * uSpeed * aStreak.y + aStreak.x * uSpanM`. `travel` is
 * the CPU integral of |wind| dt (`uTravel`), so a changing wind magnitude
 * changes the SPEED smoothly instead of re-scaling the whole session's
 * history. For a constant wind,
 * `streamerAdvectTravel(w, t * |w|, ...) === streamerAdvect(w, t, ...)`.
 * (`terrain_rock.js::gritAdvectTravel` with the SAND span default.)
 *
 * @param {number} windX AC east component (the live `uWindAc`)
 * @param {number} windY AC north component
 * @param {number} travel integral of |wind| dt, wrapped (`uTravel`)
 * @param {number} phase01 per-instance hash, [0,1)
 * @param {number} spanM recycle distance
 * @param {number} speed metres/second per unit wind x the ribbon's multiplier
 * @param {{x:number,y:number,s:number}} [out]
 */
export function streamerAdvectTravel(windX, windY, travel, phase01, spanM, speed, out) {
  const span = Number.isFinite(spanM) && spanM > 0 ? spanM : SAND_TUNING.advectSpanM;
  return gritAdvectTravel(windX, windY, travel, phase01, span, speed, out);
}

function _smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / ((e1 - e0) || 1e-6)));
  return t * t * (3 - 2 * t);
}
const _clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/**
 * The ribbon's LIFE envelope over one recycle span — the JS twin of the
 * `lifeFade` line in `SAND_STREAMER_VERTEX_GLSL`. 0 at both ends of the span
 * (so the recycle jump is invisible), 1 in the middle.
 *
 * @param {number} s the advection offset (`streamerAdvect(...).s`), in
 *   [-span/2, span/2)
 * @param {number} spanM
 * @param {number} [fadeIn]  fraction of the span spent fading in
 * @param {number} [fadeOut] fraction of the span spent fading out
 */
export function streamerLifeFade(s, spanM, fadeIn = SAND_TUNING.lifeFadeIn,
  fadeOut = SAND_TUNING.lifeFadeOut) {
  const span = Number.isFinite(spanM) && spanM > 0 ? spanM : SAND_TUNING.advectSpanM;
  const life = s / span + 0.5;
  const fin = Math.max(Number.isFinite(fadeIn) ? fadeIn : 0, 0.001);
  const fout = Math.max(Number.isFinite(fadeOut) ? fadeOut : 0, 0.001);
  return _smoothstep(0, fin, life) * (1 - _smoothstep(1 - fout, 1, life));
}

/**
 * Weather gate for the streamer field, 0..1. Pure and total.
 *
 * Saltation needs DRY sand and moving air: rain (`wetness`, the smoothed
 * signal) kills it quadratically — damp sand binds long before it is wet —
 * and storminess (gusts) feeds it from the calm baseline to 1. A dry storm
 * (`isStorm` with no rain yet) is a sand storm: full strength.
 *
 * A NULL env degrades to the calm baseline rather than to 0: unlike the devil
 * descriptor (whose null-env contract is the foliage gates'), the streamer
 * field is a host-owned ground layer, and a boot without the weather producer
 * should still show the desert moving. Night is NOT a gate — sand blows at
 * night too; the ribbons are LIT like the ground, so they darken with it.
 *
 * @param {object|null} env `readParticleEnv` snapshot
 * @param {object} [tuning]
 */
export function streamerGate(env, tuning = SAND_TUNING) {
  const calm = Number.isFinite(tuning?.gateCalm) ? tuning.gateCalm : SAND_TUNING.gateCalm;
  if (!env) return calm;
  const wet = _clamp01(env.wetness);
  const storm = env.isStorm === true ? 1 : _clamp01(env.stormness);
  const dry = (1 - wet) * (1 - wet);
  return Math.min(1, Math.max(0, dry * (calm + (1 - calm) * storm)));
}

/**
 * sRGB mean colour of each sand code — copied from `terrain.js`
 * `TERRAIN_CODE_TO_RGB` (the per-code atlas approximation the wire bake uses;
 * kept here rather than imported because terrain.js is the THREE-heavy
 * monolith this module deliberately does not import).
 */
export const SAND_CODE_SRGB = Object.freeze({
  10: Object.freeze([0.78, 0.66, 0.40]),   // sand-yellow
  11: Object.freeze([0.70, 0.62, 0.50]),   // sand-grey
  12: Object.freeze([0.60, 0.54, 0.42]),   // sand-rockStrewn
});

function _srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * The LINEAR albedo of the airborne sand over terrain code `code`: the code's
 * own mean colour, desaturated toward its luma and lifted (a thin cloud of
 * grains lit from all sides is paler than the self-shadowed surface it came
 * from). Pure; writes `out[0..2]`. A non-sand code falls back to sand-yellow.
 *
 * @param {number} code
 * @param {number[]|Float32Array} [out]
 * @param {object} [tuning]
 */
export function streamerTintForCode(code, out, tuning = SAND_TUNING) {
  const o = out || [0, 0, 0];
  const srgb = SAND_CODE_SRGB[code | 0] || SAND_CODE_SRGB[10];
  const r = _srgbToLinear(srgb[0]);
  const g = _srgbToLinear(srgb[1]);
  const b = _srgbToLinear(srgb[2]);
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const d = _clamp01(Number.isFinite(tuning?.tintDesat) ? tuning.tintDesat : SAND_TUNING.tintDesat);
  const lift = Number.isFinite(tuning?.tintLift) ? tuning.tintLift : SAND_TUNING.tintLift;
  o[0] = Math.min(1, (r + (luma - r) * d) * lift);
  o[1] = Math.min(1, (g + (luma - g) * d) * lift);
  o[2] = Math.min(1, (b + (luma - b) * d) * lift);
  return o;
}

/**
 * Hash-stable dust-devil HOME slots for one landblock.
 *
 * PURE and deterministic in `(lbKey, codes, heights, count, seed)` — the whole
 * point (plan §5.5): park/unpark, rebake, walk away and come back, and the same
 * devil lives in the same place. Homes are placed ONLY on FAM_SAND vertices,
 * so a landblock with one sand corner gets its devil on the sand.
 *
 * `codes` and `heights` are the LB's 81-entry COLUMN-MAJOR grids
 * (`idx = vx * 9 + vy`, `terrain.js` userData / `LandblockMesh`).
 *
 * @param {{lbKey:number, lbX:number, lbY:number, codes:ArrayLike<number>,
 *   heights?:ArrayLike<number>|null, count:number, seed?:number}} opts
 * @returns {Array<{slot:number, x:number, y:number, z:number, vx:number,
 *   vy:number, code:number, seed:number}>}
 */
export function devilSlotsForLandblock(opts = {}) {
  const codes = opts.codes;
  const count = Math.max(0, Math.min(8, opts.count | 0));
  if (!codes || count === 0) return [];
  const lbKey = opts.lbKey >>> 0;
  const lbX = opts.lbX | 0;
  const lbY = opts.lbY | 0;
  const heights = opts.heights || null;
  const seed = (Number.isFinite(opts.seed) ? opts.seed : 0x5a4d1e55) | 0;

  // Every FAM_SAND vertex, in grid order (deterministic).
  const sandIdx = [];
  const n = Math.min(codes.length, VERTEX_GRID * VERTEX_GRID);
  for (let i = 0; i < n; i += 1) {
    if (familyForCode(codes[i]) === FAM_SAND) sandIdx.push(i);
  }
  if (sandIdx.length === 0) return [];

  const out = [];
  const used = new Set();
  for (let slot = 0; slot < count; slot += 1) {
    // `scatterHash01(a, b, c, seed)` is the shared FNV-1a + fmix32 avalanche.
    const pick = scatterHash01(lbKey | 0, slot, 1, seed);
    let k = Math.min(sandIdx.length - 1, Math.floor(pick * sandIdx.length));
    // Distinct vertices per LB: walk forward on a collision (still pure).
    let guard = 0;
    while (used.has(sandIdx[k]) && guard < sandIdx.length) {
      k = (k + 1) % sandIdx.length;
      guard += 1;
    }
    if (used.has(sandIdx[k])) break;   // fewer sand vertices than devils
    used.add(sandIdx[k]);
    const idx = sandIdx[k];
    const vx = (idx / VERTEX_GRID) | 0;
    const vy = idx % VERTEX_GRID;
    const jx = (scatterHash01(lbKey | 0, slot, 2, seed) - 0.5) * SAND_TUNING.devilJitterM;
    const jy = (scatterHash01(lbKey | 0, slot, 3, seed) - 0.5) * SAND_TUNING.devilJitterM;
    // Clamp inside the landblock so a devil on an edge vertex cannot drift into
    // a neighbour we know nothing about.
    const localX = Math.min(METERS_PER_LANDBLOCK, Math.max(0, vx * VERTEX_SPACING_M + jx));
    const localY = Math.min(METERS_PER_LANDBLOCK, Math.max(0, vy * VERTEX_SPACING_M + jy));
    const z = heights && Number.isFinite(heights[idx]) ? heights[idx] : 0;
    out.push({
      slot,
      vx,
      vy,
      code: codes[idx] | 0,
      x: lbX * METERS_PER_LANDBLOCK + localX,
      y: lbY * METERS_PER_LANDBLOCK + localY,
      z,
      // Per-devil deterministic seed for the emitter's own variety.
      seed: ((lbKey ^ Math.imul(slot + 1, 0x9e3779b9)) >>> 0),
    });
  }
  return out;
}

const DEVIL_LIFE_SALT = 0x0de71e5;

/**
 * A devil's LIFE at time `tSec` — PURE in (seed, clock, gate, tuning).
 *
 * Each home slot cycles with its own hashed period: alive for `duty` of it
 * (forming, wandering, dissolving), idle for the rest. Every life also draws a
 * hashed COIN and only happens when `coin < gate`, so poor weather THINS the
 * lives that happen without ever moving the clock of the ones that do (a
 * devil never jumps when the weather changes; it simply stops early).
 *
 * @param {number} seed   the home slot's seed (`devilSlotsForLandblock`)
 * @param {number} tSec   the shared clock
 * @param {number} gate   `dustDevilGate(env)`, 0..1
 * @param {object} [tuning]
 * @param {object} [out]  zero-alloc target
 * @returns {{active:boolean, lifeIdx:number, progress:number, period:number,
 *   duty:number}}
 */
export function devilLifeAt(seed, tSec, gate, tuning = SAND_TUNING, out) {
  const o = out || { active: false, lifeIdx: 0, progress: 0, period: 0, duty: 0 };
  const L = tuning || SAND_TUNING;
  const sd = seed | 0;
  const hP = scatterHash01(sd, 1, 11, DEVIL_LIFE_SALT);
  const hD = scatterHash01(sd, 2, 11, DEVIL_LIFE_SALT);
  const hO = scatterHash01(sd, 3, 11, DEVIL_LIFE_SALT);
  const period = L.devilPeriodMinSec + (L.devilPeriodMaxSec - L.devilPeriodMinSec) * hP;
  const duty = _clamp01(L.devilDutyMin + (L.devilDutyMax - L.devilDutyMin) * hD);
  const t = Number.isFinite(tSec) ? tSec : 0;
  const x = t / Math.max(period, 1) + hO;
  const lifeIdx = Math.floor(x);
  const u = x - lifeIdx;
  const g = _clamp01(gate);
  const coin = scatterHash01(sd, lifeIdx, 12, DEVIL_LIFE_SALT);
  o.period = period;
  o.duty = duty;
  o.lifeIdx = lifeIdx;
  o.active = g >= L.devilGateMin && duty > 0 && u < duty && coin < g;
  o.progress = o.active ? u / duty : 0;
  return o;
}

/**
 * Where a devil stands relative to its HOME at `progress` (0..1) through life
 * `lifeIdx` — PURE in (seed, life, progress, wind). It crosses its home
 * travelling DOWNWIND (devils drift with the ambient flow), from -travel/2 to
 * +travel/2, with a slow lateral wobble. Each life draws its own travel and
 * wobble, so two lives of one home never retrace the same line.
 *
 * @returns {{x:number, y:number}} AC metres from the home slot
 */
export function devilWanderOffset(seed, lifeIdx, progress, windX, windY,
  tuning = SAND_TUNING, out) {
  const o = out || { x: 0, y: 0 };
  const L = tuning || SAND_TUNING;
  const sd = seed | 0;
  const li = lifeIdx | 0;
  let wl = Math.hypot(windX, windY);
  let dx = 1;
  let dy = 0;
  if (Number.isFinite(wl) && wl > 1e-6) { dx = windX / wl; dy = windY / wl; }
  const h4 = scatterHash01(sd, li, 13, DEVIL_LIFE_SALT);
  const h5 = scatterHash01(sd, li, 14, DEVIL_LIFE_SALT);
  const h6 = scatterHash01(sd, li, 15, DEVIL_LIFE_SALT);
  const h7 = scatterHash01(sd, li, 16, DEVIL_LIFE_SALT);
  const travel = L.devilTravelMinM + (L.devilTravelMaxM - L.devilTravelMinM) * h4;
  const p = _clamp01(progress);
  const s = (p - 0.5) * travel;
  const cycles = L.devilWobbleCyclesMin + (L.devilWobbleCyclesMax - L.devilWobbleCyclesMin) * h5;
  const amp = L.devilWobbleMinM + (L.devilWobbleMaxM - L.devilWobbleMinM) * h7;
  const wob = Math.sin(p * 2 * Math.PI * cycles + h6 * 2 * Math.PI) * amp;
  o.x = dx * s - dy * wob;
  o.y = dy * s + dx * wob;
  return o;
}

/**
 * The owner key a landblock's devils register under.
 *
 * DERIVED from `vfx/particle_attach.js::staticOwnerKeyForLb` (the single source
 * of truth for the per-LB owner key — D7) with a `:sand` scope appended.
 *
 * ⚠ WHY THE SUFFIX, given the plan says to reuse the static key verbatim. The
 * teardown API is `destroyAllForOwner(ownerKey)`, and this provider's
 * `onLandblockGone` fires for a terrain LOD REBAKE as well as for an evict
 * (`terrain_vfx.js` deliberately delivers a rebake as gone-then-ready). A
 * rebake does NOT rebuild statics — so calling `destroyAllForOwner("static:N")`
 * there would silently reap every brazier/foliage emitter in the landblock and
 * never bring them back. The suffix keeps the derivation (change the static
 * scheme and this changes with it) while making the teardown exact.
 *
 * @param {number} landblockIdOrLbKey
 */
export function sandOwnerKeyForLb(landblockIdOrLbKey) {
  return `${staticOwnerKeyForLb(landblockIdOrLbKey)}:sand`;
}

/** The scoped emitter handle for devil `slot` under its owner (never 0, so
 *  `ownerRegistry.stopEmitter` can find it at park time). One handle per slot:
 *  a new life REPLACES whatever the slot's previous emitter left behind. */
export function devilEmitterHandle(slot) {
  return (0x5a4d0000 + ((slot | 0) & 0xff)) >>> 0;
}

// ---------------------------------------------------------------------------
// The streamer field — GLSL. Kept as exported strings so the shader test can
// assert on them without a GPU (the `terrain.js` convention).
//
// ⚠ NO BACKTICKS anywhere in this GLSL, including comments: a stray backtick
// closes the JS template literal (this has bitten `terrain.js`). ASCII only,
// and no braces in comments (the log-depth main() locator counts them).
// ---------------------------------------------------------------------------

export const SAND_STREAMER_VERTEX_GLSL = `
precision highp float;

// Per-instance (written by terrain_scatter.js; see the schema below).
attribute vec3 aOffset;    // AC world position of the anchor (x, y, z=ground+lift)
attribute vec2 aScale;     // (length, height) in metres
attribute vec4 aStreak;    // (phase01, speedMul k/64, wavePhase01, opacity)
attribute vec3 aNormal;    // ground normal at the anchor, AC z-up (the pool writes it)
attribute vec3 aTint;      // linear albedo of the airborne sand over this code

uniform float uTime;       // the SHARED clock, bound by reference (plan 5.6)
uniform vec2  uWindAc;     // AC ground wind (+X east, +Y north), live
uniform float uTravel;     // integral of |wind| dt (seconds x gust), CPU, wrapped
uniform float uSpanM;      // advection recycle distance
uniform float uSpeed;      // metres/sec per unit wind magnitude
uniform float uLifeIn;     // fraction of the span spent fading in
uniform float uLifeOut;    // fraction of the span spent fading out
uniform float uWaveAmp;    // metres of lateral meander
uniform float uWaveK;      // radians per metre along the path
uniform float uWaveW;      // radians per second (slow evolution)
uniform float uPulseFreq;  // gust sheets, cycles per metre
uniform vec2  uPulseOffset; // integral of dir x sheet drift dt (AC metres, DOWNWIND), CPU
uniform float uPulseThreshold;
uniform float uPulseSoft;
uniform float uGate;       // weather gate (dry x wind), CPU side
uniform vec3  uLightDir;   // terrain light: uAcSunVec (AC, to the sun)
uniform vec3  uLightSun;   // terrain light: uAcSunColor
uniform vec3  uLightAmb;   // terrain light: uAcAmbColor * uAcAmbLevel

varying vec2 vQuadUv;
varying float vAlpha;
varying vec3 vLit;
varying float vGrain;

${SCATTER_FADE_GLSL}

// Cheap value noise (the terrain.js fragValueNoise2D shape, vertex-side).
float sandHash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float sandNoise2D(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = sandHash21(i);
  float b = sandHash21(i + vec2(1.0, 0.0));
  float c = sandHash21(i + vec2(0.0, 1.0));
  float d = sandHash21(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

void main() {
  // --- advection: the JS twin is terrain_sand.js::streamerAdvectTravel ------
  float wl = max(length(uWindAc), 1e-4);
  vec2 dir = uWindAc / wl;
  vec2 side = vec2(-dir.y, dir.x);
  // 2026-10-24: uTravel is the INTEGRAL of the gust magnitude, accumulated per
  // frame on the CPU, never the absolute clock times the live wind: that
  // product's derivative carries uTime x d|wind|/dt, so the ribbons raced
  // faster the older the session. Identical for a constant wind.
  float travelled = uTravel * uSpeed * aStreak.y + aStreak.x * uSpanM;
  float s = mod(travelled, uSpanM) - uSpanM * 0.5;

  // --- life over the span: the JS twin is terrain_sand.js::streamerLifeFade -
  float life = s / uSpanM + 0.5;
  float lifeFade = smoothstep(0.0, max(uLifeIn, 0.001), life)
    * (1.0 - smoothstep(1.0 - max(uLifeOut, 0.001), 1.0, life));

  // --- the path: along the wind, meandering, on the ground PLANE ------------
  // position.x runs along the ribbon in -0.5..0.5, position.y is 0 at the foot
  // and 1 at the top edge. The meander is a function of the distance along the
  // PATH, so the body follows its head through the same curves.
  float pathS = s + position.x * aScale.x;
  float waveArg = pathS * uWaveK + aStreak.z * 6.2831853 - uTime * uWaveW;
  float meander = sin(waveArg) * uWaveAmp;
  float meanderSlope = cos(waveArg) * uWaveAmp * uWaveK;
  vec2 g2 = dir * pathS + side * meander;
  float nz = max(aNormal.z, 0.35);
  vec3 local = vec3(g2, -(aNormal.x * g2.x + aNormal.y * g2.y) / nz);

  // instanceMatrix carries the anchor translation AND the pool's 0/1 live
  // scale, so a degenerate (wrong-family / unbaked / out-of-range) instance
  // collapses to a point and is zero-area for this material too.
  vec4 placed = instanceMatrix * vec4(local, 1.0);
  float liveScale = length(instanceMatrix[0].xyz);

  // --- face the camera about the ribbon axis (view space) -------------------
  // A flat strip seen by a chase camera a few degrees above the sand is a
  // few pixels thick; an axial billboard keeps its true height on screen and
  // is never seen edge-on. The extent always points UP, so the foot stays on
  // the sand and the top edge feathers into the air.
  vec2 t2 = dir + side * meanderSlope;
  vec3 tanAc = vec3(t2, -(aNormal.x * t2.x + aNormal.y * t2.y) / nz);
  mat3 mv3 = mat3(modelViewMatrix);
  vec4 mvPos = modelViewMatrix * vec4(placed.xyz, 1.0);
  vec3 tanV = normalize(mv3 * tanAc);
  vec3 upV = normalize(mv3 * vec3(0.0, 0.0, 1.0));
  vec3 widthV = cross(tanV, normalize(-mvPos.xyz));
  float wLen = length(widthV);
  widthV = wLen > 1e-4 ? widthV / wLen : upV;
  if (dot(widthV, upV) < 0.0) widthV = -widthV;
  widthV = normalize(mix(upV, widthV, smoothstep(0.08, 0.3, wLen)));
  mvPos.xyz += widthV * (position.y * aScale.y * liveScale);

  // --- gust sheets: an instance-constant pulse, drifting DOWNWIND ----------
  // The drift is INTEGRATED on the CPU (dt x sheet speed x the live
  // direction): the old dir x uTime swept the sheets sideways at uTime x the
  // 45 s wind wander, ever faster as the session aged. Subtracting a downwind
  // offset moves the pattern downwind (the 2026-10-23 sign fix holds).
  vec2 centreXy = instanceMatrix[3].xy + dir * s;
  vec2 pq = (centreXy - uPulseOffset) * uPulseFreq;
  float nse = 0.65 * sandNoise2D(pq) + 0.35 * sandNoise2D(pq * 2.7 + vec2(17.3, 5.1));
  float pulse = smoothstep(uPulseThreshold, uPulseThreshold + max(uPulseSoft, 0.001), nse);

  // Distance blend at the ribbon centre, identical in form to the CPU fadeFor()
  // (LINEAR). Instance-constant on purpose: the collapse test below must treat
  // every vertex of one ribbon alike.
  float fade = hbScatterFade(centreXy);
  float a = pulse * lifeFade * fade * aStreak.w * uGate * liveScale;

  // Lit like the ground it blows over: the retail per-vertex Gouraud term the
  // terrain shader applies (terrain.js acC), from the same light uniforms.
  vec3 nn = normalize(vec3(aNormal.xy, nz));
  vLit = aTint * min(vec3(1.0), uLightSun * max(dot(nn, uLightDir), 0.0) + uLightAmb);
  vAlpha = a;
  vQuadUv = uv;
  // Fine streaks sliding along the ribbon a little faster than the ribbon:
  // the saltating grains themselves. uSpeed is the TUNING constant here, not
  // the wind, so this phase advances at a fixed rate (it cannot race).
  vGrain = pathS * 2.4 - uTime * uSpeed * 0.9;
  gl_Position = projectionMatrix * mvPos;
  // A fully transparent ribbon costs no fill: push it outside the clip volume.
  if (a < 0.002) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
}
`;

export const SAND_STREAMER_FRAGMENT_GLSL = `
precision highp float;

uniform vec3 uColour;      // live multiplier on the per-instance sand tint
uniform float uOpacity;

varying vec2 vQuadUv;
varying float vAlpha;
varying vec3 vLit;
varying float vGrain;

void main() {
  float u = vQuadUv.x;
  float v = vQuadUv.y;
  // Along the ribbon: a long soft tail upwind (u = 0), a firmer head downwind.
  float along = smoothstep(0.0, 0.45, u) * (1.0 - smoothstep(0.78, 1.0, u));
  // Across (height off the sand): densest just above the ground and thinning
  // upward; the foot is feathered so no hard line shows where it meets sand.
  // The max() is load-bearing: under MSAA a partly covered edge pixel shades
  // at its centre, outside the strip, so v extrapolates past 1.0 along the
  // top edge, and pow() of a negative base is NaN on ANGLE D3D11 and on
  // SwiftShader. A NaN alpha survives the discard test and the blend, and
  // bloom spreads it into black blocks.
  float across = smoothstep(0.0, 0.18, v) * pow(max(1.0 - v, 0.0), 1.6);
  float grain = 0.72 + 0.28 * sin(vGrain + v * 3.0);
  float a = along * across * grain * vAlpha * uOpacity;
  if (a < 0.003) discard;
  // NORMAL blend: airborne sand scatters light, it does not emit (an additive
  // ribbon would glow at night, the tell of a fake one).
  gl_FragColor = vec4(uColour * vLit, a);
}
`;

/** The per-instance attribute schema the pool allocates for a streamer field. */
export const SAND_STREAMER_SCHEMA = Object.freeze([
  { name: "aOffset", itemSize: 3 },
  { name: "aScale", itemSize: 2 },
  { name: "aStreak", itemSize: 4 },
  { name: "aNormal", itemSize: 3 },
  { name: "aTint", itemSize: 3 },
]);

// ---------------------------------------------------------------------------
// The streamer field (THREE optional).
// ---------------------------------------------------------------------------

function _streakGeometry(THREE, segments = RIBBON_SEGMENTS) {
  // A strip in the XY plane: x in -0.5..0.5 along the ribbon (segments + 1
  // columns, so the meander can bend it), y = 0 at the foot and 1 at the top
  // edge. Built by hand so the winding and the uv are explicit.
  const segs = Math.max(1, segments | 0);
  const cols = segs + 1;
  const geom = new THREE.BufferGeometry();
  const pos = new Float32Array(cols * 2 * 3);
  const uv = new Float32Array(cols * 2 * 2);
  for (let c = 0; c < cols; c += 1) {
    const u = c / segs;
    const b = c * 2;
    pos[b * 3] = u - 0.5; pos[b * 3 + 1] = 0; pos[b * 3 + 2] = 0;
    pos[(b + 1) * 3] = u - 0.5; pos[(b + 1) * 3 + 1] = 1; pos[(b + 1) * 3 + 2] = 0;
    uv[b * 2] = u; uv[b * 2 + 1] = 0;
    uv[(b + 1) * 2] = u; uv[(b + 1) * 2 + 1] = 1;
  }
  const index = [];
  for (let c = 0; c < segs; c += 1) {
    const a = c * 2;
    const b = a + 1;
    const d = a + 2;
    const e = a + 3;
    index.push(a, d, e, a, e, b);
  }
  geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geom.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geom.setIndex(index);
  geom.name = "sand-ribbon";
  return geom;
}

/** Find the terrain material carrying the retail light uniforms (indexed loop:
 *  no iterator allocation on the per-frame path). */
function _terrainLightMaterial(materials) {
  if (!materials || typeof materials.length !== "number") return null;
  for (let i = 0; i < materials.length; i += 1) {
    const u = materials[i] && materials[i].uniforms;
    if (u && u.uAcSunVec && u.uAcSunColor && u.uAcAmbColor && u.uAcAmbLevel) return u;
  }
  return null;
}

function _set3(dst, x, y, z) {
  if (!dst) return;
  if (typeof dst.set === "function") dst.set(x, y, z);
  else { dst.x = x; dst.y = y; dst.z = z; }
}

/**
 * Create the camera-scoped sand-streamer field.
 *
 * @param {object} opts
 * @param {object} [opts.THREE]    injected; omit for a headless CPU-only field.
 * @param {object} [opts.parent]   Object3D to hang the mesh off (AC space).
 * @param {object|Function} opts.oracle  the terrain oracle, or a GETTER (use the
 *   getter form: `ctx.oracle` / `frameCtx.oracle` is LIVE and must never be
 *   stashed — handoff §5).
 * @param {object} [opts.globals]  VFX_GLOBALS (uTime + uWindDir, BY REFERENCE).
 * @param {number} [opts.count]    instances (rounded up to a square).
 * @param {number} [opts.radiusM]
 * @param {number} [opts.seed]
 * @param {object} [opts.tuning]   a LIVE tuning object (read at fill + apply).
 */
export function createSandStreamerField(opts = {}) {
  const THREE = opts.THREE || null;
  const count = Math.max(1, Math.round(Number.isFinite(opts.count) ? opts.count : 2000));
  const radiusM = Math.min(512, Math.max(8, Number.isFinite(opts.radiusM) ? opts.radiusM : 64));
  const seed = (Number.isFinite(opts.seed) ? opts.seed : 0x5a4d5052) | 0;
  const globals = opts.globals || null;
  const tuning = opts.tuning && typeof opts.tuning === "object"
    ? opts.tuning
    : { ...SAND_TUNING };

  let geometry = null;
  let material = null;
  const uniforms = {
    // Still read by the GLSL, but only at TUNING-constant rates (the meander
    // evolution and the grain scroll); the wind-driven motion comes from the
    // CPU-integrated `uTravel` / `uPulseOffset` since 2026-10-24.
    uTime: { value: 0 },
    uWindAc: { value: null },
    uTravel: { value: 0 },
    uSpanM: { value: tuning.advectSpanM },
    uSpeed: { value: tuning.advectSpeed },
    uLifeIn: { value: tuning.lifeFadeIn },
    uLifeOut: { value: tuning.lifeFadeOut },
    uWaveAmp: { value: tuning.waveAmpM },
    uWaveK: { value: (2 * Math.PI) / Math.max(0.1, tuning.waveLengthM) },
    uWaveW: { value: tuning.waveRadPerSec },
    uPulseFreq: { value: tuning.pulseFreq },
    // CPU-side rate (metres/s, downwind): `update` integrates it into
    // `uPulseOffset` along the live wind direction. Not declared in the GLSL
    // since 2026-10-24 (the old `dir * (uTime * uPulseSpeed)` raced).
    uPulseSpeed: { value: tuning.pulseSpeedMps },
    // A plain {x, y} headless; a THREE.Vector2 once THREE is injected.
    uPulseOffset: { value: { x: 0, y: 0 } },
    uPulseThreshold: { value: tuning.pulseThreshold },
    uPulseSoft: { value: tuning.pulseSoft },
    uGate: { value: streamerGate(null, tuning) },
    uLightDir: { value: null },
    uLightSun: { value: null },
    uLightAmb: { value: null },
    uColour: { value: null },
    uOpacity: { value: tuning.opacity },
  };
  // CPU mirrors so a headless field still reports what the shader would see.
  const light = { dir: [0, 0, 1], sun: [0.55, 0.55, 0.55], amb: [0.3, 0.3, 0.3], fromTerrain: false };

  const wind = { x: 0, y: 0 };
  const advect = { x: 0, y: 0, s: 0 };
  const tint = [0, 0, 0];

  // Build the geometry + material BEFORE the pool so the pool can own the mesh
  // (that is what writes `instanceMatrix`, which this shader reads for both the
  // anchor translation and the degenerate 0-scale kill). The four scatter
  // uniforms are re-pointed at the pool's own objects immediately after
  // construction — the pool cannot exist yet to be bound here, and a
  // ShaderMaterial reads `material.uniforms` afresh on every upload, so
  // swapping the entries before the first render is exact (plan §5.6: the
  // shader must see the pool's LIVE centre, never a copy).
  if (THREE && typeof THREE.ShaderMaterial === "function") {
    try {
      geometry = _streakGeometry(THREE);
      uniforms.uWindAc.value = new THREE.Vector2(1, 0);
      uniforms.uPulseOffset.value = new THREE.Vector2(0, 0);
      uniforms.uLightDir.value = new THREE.Vector3(0, 0, 1);
      uniforms.uLightSun.value = new THREE.Vector3(0.55, 0.55, 0.55);
      uniforms.uLightAmb.value = new THREE.Vector3(0.3, 0.3, 0.3);
      const col = tuning.colour || SAND_TUNING.colour;
      uniforms.uColour.value = new THREE.Color(col[0], col[1], col[2]);
      material = new THREE.ShaderMaterial(withLogDepth({
        vertexShader: SAND_STREAMER_VERTEX_GLSL,
        fragmentShader: SAND_STREAMER_FRAGMENT_GLSL,
        uniforms: {
          ...uniforms,
          // Placeholders, replaced by reference below.
          uScatterCenter: { value: new THREE.Vector3(0, 0, 0) },
          uScatterRadius: { value: radiusM },
          uScatterFadeStart: { value: radiusM * 0.75 },
          uScatterShape: { value: 0 },
        },
        transparent: true,
        depthWrite: false,
        depthTest: true,
        // NORMAL, not additive (2026-10-23): airborne sand scatters light, it
        // does not emit. Additive tan over bright tan sand was invisible by day
        // and would glow at night.
        blending: THREE.NormalBlending,
        side: THREE.DoubleSide,
        toneMapped: false,
      }));
      material.name = "terrain-sand-streamers";
    } catch (_) {
      geometry = null;
      material = null;
    }
  }

  const pool = createScatterPool({
    THREE,
    name: "terrain-sand-streamers",
    count,
    radiusM,
    seed,
    shape: "disc",
    fadeFraction: 0.25,
    jitter: 1,
    families: [FAM_SAND],
    attributes: SAND_STREAMER_SCHEMA.map((a) => ({ ...a })),
    // The pool writes aOffset + aScale (1s) + aNormal + the instance matrix;
    // `fill` turns those into a ribbon. It never allocates — `ctx` is reused
    // per instance and the tint goes through a closure scratch.
    fill(ctx) {
      // Foot lift: 0.05..0.12 m above the ground (inside plan §3.2's
      // 0.05..0.4). Hash-stable per cell.
      const lift = tuning.liftMinM + ctx.rand(3) * (tuning.liftMaxM - tuning.liftMinM);
      ctx.z += lift;
      const lenJ = 1 + (ctx.rand(4) - 0.5) * 2 * tuning.streakLengthJitter;
      const hJ = 1 + (ctx.rand(9) - 0.5) * 2 * tuning.streakHeightJitter;
      ctx.set("aScale", tuning.streakLengthM * lenJ, tuning.streakHeightM * hJ);
      // ⚠ 2026-10-23: the opacity no longer multiplies `ctx.fade`. That is the
      // SCATTER-TIME fade and it is frozen into the instance: a leading-edge
      // instance is scattered at the rim (fade ≈ 0) and kept that as the player
      // walked onto it, so a few metres of walking emptied the near field. The
      // shader's live `hbScatterFade` is the only distance blend now.
      ctx.set(
        "aStreak",
        ctx.rand(5),                      // advection phase
        streamerSpeedMul(ctx.rand(6)),    // 0.75..1.35, quantised k/64 (seamless wrap)
        ctx.rand(7),                      // meander phase
        0.55 + ctx.rand(8) * 0.45,        // per-ribbon opacity
      );
      streamerTintForCode(ctx.code, tint, tuning);
      ctx.set("aTint", tint[0], tint[1], tint[2]);
    },
    oracle: opts.oracle,
    geometry,
    material,
    parent: opts.parent || null,
    writeInstanceMatrix: true,   // the shader reads instanceMatrix (see the GLSL)
    frustumCulled: false,        // the window follows the player
  });

  // Re-point the four scatter uniforms at the pool's live objects (see above).
  if (material && material.uniforms) {
    material.uniforms.uScatterCenter = pool.uniforms.uScatterCenter;
    material.uniforms.uScatterRadius = pool.uniforms.uScatterRadius;
    material.uniforms.uScatterFadeStart = pool.uniforms.uScatterFadeStart;
    material.uniforms.uScatterShape = pool.uniforms.uScatterShape;
  }

  let mesh = pool.mesh || null;
  if (mesh) {
    mesh.name = "terrain-sand-streamers";
    mesh.castShadow = false;      // §5.7 — added geometry is paid twice
    mesh.receiveShadow = false;
    mesh.renderOrder = 3;
  }

  const state = {
    frames: 0, lastRescattered: 0, built: !!mesh, lightCopies: 0,
    // Integral of |wind| dt (`uTravel`), wrapped seamlessly; a double here.
    travel: 0, travelWraps: 0,
    // Integral of dir x pulseSpeed dt (`uPulseOffset`), AC metres. Not wrapped
    // (value noise is not periodic); at 2.2 m/s it reaches ~190 km in a day,
    // where float32 still resolves ~1.6 cm against 20 m sheets.
    pulseX: 0, pulseY: 0,
  };

  /** Push the live tuning into the uniforms (cheap; called on a knob turn). */
  function applyTuning() {
    uniforms.uSpanM.value = tuning.advectSpanM;
    uniforms.uSpeed.value = tuning.advectSpeed;
    uniforms.uLifeIn.value = tuning.lifeFadeIn;
    uniforms.uLifeOut.value = tuning.lifeFadeOut;
    uniforms.uWaveAmp.value = tuning.waveAmpM;
    uniforms.uWaveK.value = (2 * Math.PI) / Math.max(0.1, tuning.waveLengthM);
    uniforms.uWaveW.value = tuning.waveRadPerSec;
    uniforms.uPulseFreq.value = tuning.pulseFreq;
    uniforms.uPulseSpeed.value = tuning.pulseSpeedMps;
    uniforms.uPulseSoft.value = tuning.pulseSoft;
    uniforms.uOpacity.value = tuning.opacity;
    const c = uniforms.uColour.value;
    const col = tuning.colour || SAND_TUNING.colour;
    if (c && typeof c.setRGB === "function") c.setRGB(col[0], col[1], col[2]);
  }

  return {
    pool,
    uniforms,
    tuning,
    get mesh() { return mesh; },
    get material() { return material; },
    get geometry() { return geometry; },
    applyTuning,
    /** Weather → the gate and the gust threshold. Zero-alloc. */
    setEnvironment(env) {
      uniforms.uGate.value = streamerGate(env, tuning);
      const storm = env ? (env.isStorm === true ? 1 : _clamp01(env.stormness)) : 0;
      uniforms.uPulseThreshold.value = tuning.pulseThreshold - tuning.stormThresholdDrop * storm;
    },
    /**
     * Copy the retail terrain light off the first terrain material that carries
     * it (`loop.js::tickTerrainSunDir` writes those on the 15 s light tick).
     * Zero-alloc; a no-op until a terrain material exists.
     */
    setTerrainLight(materials) {
      const u = _terrainLightMaterial(materials);
      if (!u) return false;
      const sv = u.uAcSunVec.value;
      const sc = u.uAcSunColor.value;
      const ac = u.uAcAmbColor.value;
      const lvl = Number.isFinite(u.uAcAmbLevel.value) ? u.uAcAmbLevel.value : 0;
      if (!sv || !sc || !ac) return false;
      light.dir[0] = sv.x; light.dir[1] = sv.y; light.dir[2] = sv.z;
      light.sun[0] = sc.r; light.sun[1] = sc.g; light.sun[2] = sc.b;
      light.amb[0] = ac.r * lvl; light.amb[1] = ac.g * lvl; light.amb[2] = ac.b * lvl;
      light.fromTerrain = true;
      _set3(uniforms.uLightDir.value, light.dir[0], light.dir[1], light.dir[2]);
      _set3(uniforms.uLightSun.value, light.sun[0], light.sun[1], light.sun[2]);
      _set3(uniforms.uLightAmb.value, light.amb[0], light.amb[1], light.amb[2]);
      state.lightCopies += 1;
      return true;
    },
    /**
     * Per-frame: re-centre the pool and refresh the live uniforms. The motion
     * is INTEGRATED from the live shared wind: travel advances by
     * `dt x |wind|` and the gust-sheet offset by `dt x pulseSpeed x dir`, so a
     * gust or the direction wander changes the SPEED smoothly, whatever the
     * clock reads. `dt` is clamped to STREAMER_MAX_DT (a resumed tab must not
     * jump). Zero-alloc.
     */
    update(dt, tSec, px, py, pz) {
      state.frames += 1;
      windAcFromGlobals(globals, wind);
      uniforms.uTime.value = Number.isFinite(tSec) ? tSec : 0;
      const wv = uniforms.uWindAc.value;
      if (wv) { wv.x = wind.x; wv.y = wind.y; }
      const d = Number.isFinite(dt) ? Math.min(STREAMER_MAX_DT, Math.max(0, dt)) : 0;
      const gust = Math.hypot(wind.x, wind.y);
      state.travel += d * gust;
      const wrap = streamerTravelWrap(uniforms.uSpanM.value, uniforms.uSpeed.value);
      if (state.travel >= wrap) {
        state.travel -= wrap * Math.floor(state.travel / wrap);
        state.travelWraps += 1;
      }
      uniforms.uTravel.value = state.travel;
      // dir = uWindAc / max(|uWindAc|, 1e-4), exactly as the GLSL forms it.
      const k = d * uniforms.uPulseSpeed.value / Math.max(gust, 1e-4);
      state.pulseX += k * wind.x;
      state.pulseY += k * wind.y;
      const po = uniforms.uPulseOffset.value;
      if (po) { po.x = state.pulseX; po.y = state.pulseY; }
      state.lastRescattered = pool.update(dt, px, py, pz);
      return state.lastRescattered;
    },
    /**
     * The CPU twin of the shader advection AS DRAWN THIS FRAME (the live
     * integrated `uTravel` and the wind of the last `update`), for diagnostics
     * and tests. `speedMul` is the ribbon's `aStreak.y`. (Before 2026-10-24 it
     * took a clock; the closed form is still `streamerAdvect`.)
     */
    advectionOf(phase01, speedMul) {
      if (state.frames === 0) windAcFromGlobals(globals, wind);
      return streamerAdvectTravel(
        wind.x, wind.y,
        state.travel,
        phase01,
        uniforms.uSpanM.value,
        uniforms.uSpeed.value * (Number.isFinite(speedMul) ? speedMul : 1),
        advect,
      );
    },
    dispose() {
      // The pool owns the mesh (it built it) and deliberately never disposes
      // the geometry/material it was handed — those are ours.
      try { pool.dispose(); } catch (_) { /* fail-soft */ }
      mesh = null;
      if (geometry) { try { geometry.dispose(); } catch (_) {} geometry = null; }
      if (material) { try { material.dispose(); } catch (_) {} material = null; }
    },
    stats() {
      return {
        built: !!mesh,
        frames: state.frames,
        lastRescattered: state.lastRescattered,
        wind: { x: wind.x, y: wind.y },
        // 2026-10-24 — the integrated motion (the racing fix).
        travel: state.travel,
        travelWraps: state.travelWraps,
        travelWrap: streamerTravelWrap(uniforms.uSpanM.value, uniforms.uSpeed.value),
        pulseOffset: { x: state.pulseX, y: state.pulseY },
        gate: uniforms.uGate.value,
        pulseThreshold: uniforms.uPulseThreshold.value,
        light: {
          fromTerrain: light.fromTerrain,
          copies: state.lightCopies,
          dir: light.dir.slice(),
          sun: light.sun.slice(),
          amb: light.amb.slice(),
        },
        pool: pool.stats(),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Module state + the two providers.
// ---------------------------------------------------------------------------

let _sand = null;       // the init record, or null

/** The LIVE tuning (a mutable copy of SAND_TUNING; `tune()` writes it). */
let _L = { ...SAND_TUNING, colour: SAND_TUNING.colour.slice() };

const _stats = {
  inits: 0,
  streamerBuilds: 0,
  devilLandblocks: 0,
  devilsRequested: 0,
  devilsCreated: 0,
  devilCreateFailures: 0,
  parks: 0,
  unparks: 0,
  gones: 0,
  destroyAllCalls: 0,
  noManager: 0,
  // 2026-10-23 — the lifecycle / distance gate.
  devilEvals: 0,
  devilSpawns: 0,
  devilStopsLife: 0,
  devilStopsOffSand: 0,
  devilRangeDestroys: 0,
  devilSpawnOutOfRange: 0,
  devilParkStops: 0,
  devilCapped: 0,
  devilGatedOut: 0,
  // 2026-10-24 — dissolving emitters released once their longest puff life has
  // passed since the stop: `Retires` = the manager had already reaped it (the
  // registry no longer held the handle); `Forced` = the registry still held it,
  // so it was destroyed (it has no live puffs by then).
  devilDrainRetires: 0,
  devilDrainForced: 0,
  envReads: 0,
  sparklePushes: 0,
};

/** Landblock-scoped devil bookkeeping: lbKey → {ownerKey, slots, parked}. */
const _devilLbs = new Map();

// Devil slot states.
const DEVIL_IDLE = 0;
const DEVIL_ACTIVE = 1;

// 2026-10-24 — the DISSOLVE WINDOW. An in-view stop (and a park) leaves the
// slot's emitter alive while its puffs age out; the manager then reaps it on
// its own (stopped && no particles — `particle_manager.js` tick, which also
// drains a stopped emitter while it is culled) and the owner registry unbinds
// the handle. A stopped emitter emits nothing, so after the longest puff life
// (`lifespan + |lifespanRand|`, the bound of `getRandomLifespan`) it is empty.
// The slot is released that long after its stop plus this margin (the
// manager's next tick + the 2 Hz evaluation cadence), so `devilsHoldingEmitter`
// and the range-destroy only ever see emitters that can still exist.
const DEVIL_DRAIN_MARGIN_S = 1.0;
// Used when an emitterInfo carries no finite lifespan (the descriptor defaults).
const DEVIL_DRAIN_FALLBACK_S = 9.5;
// `destroyEmitter` option bag for the drain release, hoisted (zero-alloc): a
// scoped handle only, never the registry's raw-underlying-id fallback.
const DESTROY_SCOPED_ONLY = Object.freeze({ scopedOnly: true });

/** Live (ACTIVE) devil slots — a fixed array compacted in place (no per-frame
 *  allocation). Capacity bounds the live-devil cap. */
const DEVIL_LIVE_CAP = 64;
const _live = new Array(DEVIL_LIVE_CAP).fill(null);
let _liveN = 0;

// Shared per-frame state (one env read + one light/sparkle push per frame,
// whichever provider ticks first).
const _shared = {
  lastT: NaN,
  lastEnvT: -Infinity,
  env: null,
  gate: 0,
  lastEvalT: -Infinity,
  player: { x: 0, y: 0, z: 0, valid: false },
};
const _wind = { x: 0, y: 0 };
const _wander = { x: 0, y: 0 };
const _lifeScratch = { active: false, lifeIdx: 0, progress: 0, period: 0, duty: 0 };
const _sampleScratch = {};
// Nearest-K candidate scratch for the 2 Hz evaluation.
const _cand = new Array(DEVIL_LIVE_CAP).fill(null);
const _candRec = new Array(DEVIL_LIVE_CAP).fill(null);
const _candD2 = new Float64Array(DEVIL_LIVE_CAP);
const _candLife = new Int32Array(DEVIL_LIVE_CAP);
let _candN = 0;
let _candK = 0;
// Evaluation parameters, hoisted so the Map.forEach callback allocates nothing.
const _ev = { t: 0, px: 0, py: 0, engage2: 0, drop2: 0, drawR2: 0 };

// --- the sparkle live knobs -------------------------------------------------
/** knob → terrain uniform. `enabled` is a live A/B of the whole term. */
export const SAND_SPARKLE_KNOBS = Object.freeze({
  enabled: "uSandSparkleEnabled",
  strength: "uSandSparkleStrength",
  density: "uSandSparkleDensity",
  fadeStart: "uSandSparkleFadeStart",
  fadeEnd: "uSandSparkleFadeEnd",
  sharpness: "uSandSparkleSharpness",
  facetFrac: "uSandSparkleFacetFrac",
});
// `version` 0 = no override active. `serial` only ever grows (never reset, not
// even by sparkle(null) or the test seam): a material stamped with an earlier
// version must never match a LATER override, or sparkle(null) followed by
// sparkle({...}) would reuse version 1 and skip every material the first
// override already stamped (the A/B "enabled:false → null → enabled:true"
// left the sparkle off).
const _sparkle = { version: 0, serial: 0, names: [], values: [] };

/**
 * Push the sparkle overrides onto every terrain material that has not seen
 * this override version yet (new landblocks bake with the terrain.js
 * defaults; this re-stamps them on their first frame). A no-op until a knob
 * is turned. Exported for the test.
 *
 * @returns {number} materials written this call
 */
export function pushSandSparkleOverrides(materials) {
  if (_sparkle.version === 0 || !materials || typeof materials.length !== "number") return 0;
  let n = 0;
  for (let i = 0; i < materials.length; i += 1) {
    const m = materials[i];
    const u = m && m.uniforms;
    if (!u || !u.uSandSparkleEnabled) continue;
    const ud = m.userData;
    if (ud && ud.__sandSparkleVer === _sparkle.version) continue;
    for (let k = 0; k < _sparkle.names.length; k += 1) {
      const slot = u[_sparkle.names[k]];
      if (slot) slot.value = _sparkle.values[k];
    }
    if (ud) ud.__sandSparkleVer = _sparkle.version;
    n += 1;
  }
  return n;
}

function _managerFor() {
  if (!_sand) return null;
  try {
    const m = _sand.getParticleManager ? _sand.getParticleManager() : null;
    return m && typeof m.addEmitter === "function" ? m : null;
  } catch (_) { return null; }
}

function _envSnapshot() {
  if (!_sand || typeof _sand.readEnv !== "function") return null;
  try { return _sand.readEnv(_sand.scene3d) || null; } catch (_) { return null; }
}

function _terrainMaterials(frameCtx) {
  try {
    const s = (frameCtx && frameCtx.scene3d) || (_sand && _sand.scene3d);
    if (s && Array.isArray(s.terrainMaterials)) return s.terrainMaterials;
    if (typeof window !== "undefined" && Array.isArray(window.liveScene3d?.terrainMaterials)) {
      return window.liveScene3d.terrainMaterials;
    }
  } catch (_) { /* fail-soft */ }
  return null;
}

/**
 * Once per frame, whichever provider ticks first: re-read the weather env (on
 * its cadence), refresh the streamer gate + terrain light, and push any
 * sparkle overrides. Deduped on the shared clock (both providers see the same
 * `frameCtx.tSec` within one spine tick).
 */
function _sharedTick(frameCtx) {
  if (!_sand || !frameCtx) return;
  const t = Number.isFinite(frameCtx.tSec) ? frameCtx.tSec : 0;
  if (t === _shared.lastT) return;
  _shared.lastT = t;
  if (!(t - _shared.lastEnvT < _L.envRefreshSec) || t < _shared.lastEnvT) {
    _shared.env = _envSnapshot();
    _shared.lastEnvT = t;
    _shared.gate = dustDevilGate(_shared.env);
    _stats.envReads += 1;
    if (_sand.field) _sand.field.setEnvironment(_shared.env);
  }
  const materials = _terrainMaterials(frameCtx);
  if (materials) {
    if (_sand.field) _sand.field.setTerrainLight(materials);
    if (_sparkle.version !== 0) _stats.sparklePushes += pushSandSparkleOverrides(materials);
  }
  if (frameCtx.hasPlayer && frameCtx.playerPos) {
    _shared.player.x = frameCtx.playerPos.x;
    _shared.player.y = frameCtx.playerPos.y;
    _shared.player.z = frameCtx.playerPos.z;
    _shared.player.valid = true;
  }
}

/** Build the emitter parent frame for one devil — ONCE per home slot (the
 *  per-frame walk only writes its position). AC world coordinates, exactly
 *  like `statics.js::_buildStaticParticleParent` (the static ParticleManager's
 *  scene is `staticsGroup`, which carries the same transform). */
function _devilParent(THREE, slot) {
  if (!THREE || typeof THREE.Vector3 !== "function") {
    return {
      position: { x: slot.x, y: slot.y, z: slot.z },
      quaternion: { x: 0, y: 0, z: 0, w: 1 },
    };
  }
  return {
    position: new THREE.Vector3(slot.x, slot.y, slot.z),
    quaternion: new THREE.Quaternion(),
  };
}

function _liveAdd(sl) {
  if (_liveN >= DEVIL_LIVE_CAP) return false;
  _live[_liveN] = sl;
  _liveN += 1;
  return true;
}

function _liveRemoveAt(i) {
  _liveN -= 1;
  _live[i] = _live[_liveN];
  _live[_liveN] = null;
}

function _liveRemove(sl) {
  for (let i = 0; i < _liveN; i += 1) {
    if (_live[i] === sl) { _liveRemoveAt(i); return; }
  }
}

/**
 * Start one devil (fire-and-forget: `addEmitter` is async and the owner
 * registry is EPOCH-GUARDED, so a create that resolves after the landblock was
 * evicted self-destroys). The slot's ONE scoped handle means a new life
 * replaces whatever its previous emitter left behind.
 */
function _spawnDevil(rec, sl, t, lifeIdx) {
  const manager = _managerFor();
  if (!manager) { _stats.noManager += 1; return false; }
  const reg = _sand.ownerRegistry;
  _stats.devilsRequested += 1;
  let specs = [];
  try {
    specs = terrainDustDevil.emit({
      anchor: {
        partIndex: -1,
        // The emitter is parented AT the devil, so the anchor centre is the
        // origin of that frame and the radius is the column radius.
        center: { x: 0, y: 0, z: 0 },
        radius: _L.devilColumnRadiusM,
      },
      env: _shared.env,
      // Each life draws its own variety (spin direction, radius, density).
      seed: (sl.seed ^ Math.imul((lifeIdx | 0) + 1, 0x85ebca6b)) >>> 0,
      clock: t,
      config: _L.devilConfig || null,
    }) || [];
  } catch (_) { specs = []; }
  if (!Array.isArray(specs) || specs.length === 0) { _stats.devilGatedOut += 1; return false; }
  const spec = specs[0];
  const info = spec.emitterInfo;
  if (!info || (info.hwGfxObjId >>> 0) === 0) return false;
  if (info.billboard === undefined) info.billboard = true;
  const req = {
    emitterInfo: info,
    parent: sl.parent,
    partIndex: -1,
    parentOffset: spec.parentOffset || null,
    emitterId: devilEmitterHandle(sl.slot),
    blocking: false,
  };
  sl.state = DEVIL_ACTIVE;
  sl.lifeIdx = lifeIdx;
  sl.hasEmitter = true;
  sl.stopT = NaN;
  sl.drainS = _maxPuffLifeS(info);
  sl.gen += 1;
  const gen = sl.gen;
  _stats.devilSpawns += 1;
  _liveAdd(sl);
  Promise.resolve()
    .then(() => reg.addEmitter(rec.ownerKey, manager, req))
    .then((id) => {
      if ((id >>> 0) !== 0) {
        if (sl.gen === gen) sl.id = id >>> 0;
        _stats.devilsCreated += 1;
      } else {
        _stats.devilCreateFailures += 1;
        if (sl.gen === gen) sl.hasEmitter = false;
      }
    })
    .catch(() => { _stats.devilCreateFailures += 1; });
  return true;
}

/**
 * Stop one devil. In view (inside the draw radius): STOP — emission ends and
 * the column dissolves as its puffs age out (the manager reaps the drained
 * emitter). Out of view: DESTROY — a culled emitter is frozen (RP6 skips its
 * update), so a stop there would hold its puffs forever.
 * A STOPPED slot keeps `hasEmitter` through its dissolve window only: `t` is
 * stamped as `stopT` and `_evalRec` releases the slot once the longest puff
 * life has passed (2026-10-24, see DEVIL_DRAIN_MARGIN_S).
 */
function _stopDevil(rec, sl, reason, t) {
  const reg = _sand ? _sand.ownerRegistry : null;
  const p = _shared.player;
  const dx = sl.parent.position.x - p.x;
  const dy = sl.parent.position.y - p.y;
  const far = !p.valid || (dx * dx + dy * dy) > _ev.drawR2;
  if (reg && sl.hasEmitter) {
    const h = devilEmitterHandle(sl.slot);
    if (far && typeof reg.destroyEmitter === "function") {
      try { reg.destroyEmitter(rec.ownerKey, h); } catch (_) {}
      sl.hasEmitter = false;
      sl.id = 0;
      sl.stopT = NaN;
    } else {
      try { reg.stopEmitter(rec.ownerKey, h); } catch (_) {}
      sl.stopT = t;
    }
  }
  if (sl.state === DEVIL_ACTIVE) _liveRemove(sl);
  sl.state = DEVIL_IDLE;
  if (reason === "life") { _stats.devilStopsLife += 1; sl.doneLife = sl.lifeIdx; }
  else if (reason === "offSand") { _stats.devilStopsOffSand += 1; sl.doneLife = sl.lifeIdx; }
}

/** Range-destroy: the player is far from this slot's emitter (teleport, ride,
 *  walk). Not a life event — the devil may re-form if the player returns. */
function _rangeDestroy(rec, sl) {
  const reg = _sand ? _sand.ownerRegistry : null;
  if (reg && sl.hasEmitter) {
    const h = devilEmitterHandle(sl.slot);
    if (typeof reg.destroyEmitter === "function") {
      try { reg.destroyEmitter(rec.ownerKey, h); } catch (_) {}
    } else {
      try { reg.stopEmitter(rec.ownerKey, h); } catch (_) {}
    }
  }
  if (sl.state === DEVIL_ACTIVE) _liveRemove(sl);
  sl.state = DEVIL_IDLE;
  sl.hasEmitter = false;
  sl.id = 0;
  sl.stopT = NaN;
  _stats.devilRangeDestroys += 1;
}

/** The longest life one puff of this emitter can have: the bound of
 *  `ParticleEmitterInfo.getRandomLifespan` (lifespan + r * lifespanRand, r in
 *  [-1, 1]). A stopped emitter is empty this long after its stop. */
function _maxPuffLifeS(info) {
  const life = Number(info && info.lifespan);
  if (!Number.isFinite(life) || life < 0) return DEVIL_DRAIN_FALLBACK_S;
  const rand = Number(info && info.lifespanRand);
  return life + (Number.isFinite(rand) ? Math.abs(rand) : 0);
}

/** Is a stopped slot's dissolve window over at `t`? A missing stamp, or one
 *  from the future (the clock was reset), restarts the wait from now: the
 *  release is never early, and always comes. Allocation-free. */
function _drainDue(sl, t) {
  if (!(sl.stopT <= t)) { sl.stopT = t; return false; }
  const span = (Number.isFinite(sl.drainS) && sl.drainS >= 0 ? sl.drainS : DEVIL_DRAIN_FALLBACK_S)
    + DEVIL_DRAIN_MARGIN_S;
  return t - sl.stopT >= span;
}

/** Release a stopped slot whose dissolve window is over (2026-10-24). The
 *  manager has normally reaped the emitter already, which unbinds the handle,
 *  so the scoped destroy is a no-op (`devilDrainRetires`). If the registry
 *  still holds it (no natural-retire unbind, `?particleOwnerRetire=off`, or a
 *  create that resolved late) it is destroyed now (`devilDrainForced`): past
 *  the longest puff life it has nothing left to show. Either way the slot then
 *  holds nothing, so a later range-destroy is not counted for it. */
function _drainRelease(rec, sl) {
  const reg = _sand ? _sand.ownerRegistry : null;
  let held = false;
  if (reg && typeof reg.destroyEmitter === "function") {
    try {
      held = reg.destroyEmitter(rec.ownerKey, devilEmitterHandle(sl.slot), DESTROY_SCOPED_ONLY) === true;
    } catch (_) { held = false; }
  }
  if (held) _stats.devilDrainForced += 1;
  else _stats.devilDrainRetires += 1;
  sl.hasEmitter = false;
  sl.id = 0;
  sl.stopT = NaN;
}

/** Where a live devil stands at time t; returns the oracle sample (or null
 *  when it has left the cached sand). Zero-alloc. */
function _devilPosition(sl, progress) {
  devilWanderOffset(sl.seed, sl.lifeIdx, progress, _wind.x, _wind.y, _L, _wander);
  const x = sl.homeX + _wander.x;
  const y = sl.homeY + _wander.y;
  const oracle = _sand ? _sand.oracleRef() : null;
  const s = oracle && typeof oracle.sample === "function" ? oracle.sample(x, y, _sampleScratch) : null;
  if (!s || s.family !== FAM_SAND || s.hasHeight === false || !Number.isFinite(s.height)) return null;
  _wander.x = x;
  _wander.y = y;
  return s;
}

function _candInsert(rec, sl, d2, lifeIdx) {
  if (_candK <= 0) return;
  if (_candN < _candK) {
    let i = _candN;
    _candN += 1;
    while (i > 0 && _candD2[i - 1] > d2) {
      _cand[i] = _cand[i - 1]; _candRec[i] = _candRec[i - 1];
      _candD2[i] = _candD2[i - 1]; _candLife[i] = _candLife[i - 1];
      i -= 1;
    }
    _cand[i] = sl; _candRec[i] = rec; _candD2[i] = d2; _candLife[i] = lifeIdx;
    return;
  }
  _stats.devilCapped += 1;
  if (d2 >= _candD2[_candN - 1]) return;
  let i = _candN - 1;
  while (i > 0 && _candD2[i - 1] > d2) {
    _cand[i] = _cand[i - 1]; _candRec[i] = _candRec[i - 1];
    _candD2[i] = _candD2[i - 1]; _candLife[i] = _candLife[i - 1];
    i -= 1;
  }
  _cand[i] = sl; _candRec[i] = rec; _candD2[i] = d2; _candLife[i] = lifeIdx;
}

// The 2 Hz evaluation's per-record pass (a hoisted Map.forEach callback, so the
// walk allocates no iterator).
function _evalRec(rec) {
  for (let k = 0; k < rec.slots.length; k += 1) {
    const sl = rec.slots[k];
    // (0) Dissolve window (2026-10-24): a STOPPED slot (in-view end of life /
    // off the sand, or a park) still claims its emitter while the puffs age
    // out. Once the longest puff life has passed the manager has reaped it, so
    // release the slot: `devilsHoldingEmitter` stops counting it and (1) no
    // longer "range-destroys" an emitter that is already gone. Parked records
    // too (a park is a stop). Allocation-free.
    if (sl.hasEmitter && sl.state !== DEVIL_ACTIVE && _drainDue(sl, _ev.t)) _drainRelease(rec, sl);
    // (1) Distance: a held emitter past the drop radius is destroyed outright.
    if (sl.hasEmitter || sl.state === DEVIL_ACTIVE) {
      const ex = sl.parent.position.x - _ev.px;
      const ey = sl.parent.position.y - _ev.py;
      if (ex * ex + ey * ey > _ev.drop2) { _rangeDestroy(rec, sl); continue; }
    }
    if (rec.parked || sl.state === DEVIL_ACTIVE) continue;
    // (2) Candidates: home in range, life running, this life not already spent.
    const hx = sl.homeX - _ev.px;
    const hy = sl.homeY - _ev.py;
    const d2 = hx * hx + hy * hy;
    if (d2 > _ev.engage2) continue;
    const life = devilLifeAt(sl.seed, _ev.t, _shared.gate, _L, _lifeScratch);
    if (!life.active || life.lifeIdx === sl.doneLife) continue;
    _candInsert(rec, sl, d2, life.lifeIdx);
  }
}

function _devilEvaluate(t, frameCtx) {
  _stats.devilEvals += 1;
  const p = _shared.player;
  const engage = Math.max(1, _L.devilEngageM);
  // The draw radius the LIVE emitters were built with: a `tune({devilConfig:
  // {drawRadiusM}})` override wins over the descriptor default, or a devil
  // past the default 480 m but inside the tuned radius (in view) would be
  // destroyed (popped) at end of life instead of dissolving.
  const cfgDraw = _L.devilConfig ? Number(_L.devilConfig.drawRadiusM) : NaN;
  const drawR = Number.isFinite(cfgDraw) && cfgDraw > 0 ? cfgDraw
    : Number.isFinite(terrainDustDevil.defaults?.drawRadiusM)
      ? terrainDustDevil.defaults.drawRadiusM : engage;
  _ev.t = t;
  _ev.px = p.x;
  _ev.py = p.y;
  _ev.engage2 = engage * engage;
  _ev.drop2 = (engage * 1.15) * (engage * 1.15);
  _ev.drawR2 = drawR * drawR;
  // The tier's devilCount, read without building a quality record (2 Hz, but
  // the eval stays allocation-free like the per-frame walk).
  const dc = Number(frameCtx && frameCtx.quality ? frameCtx.quality.terrainSandDevilCount : NaN);
  const unit = Math.max(1, Number.isFinite(dc) && dc > 0 ? Math.round(dc) : (terrainSandDevilCount() || 1));
  const cap = Math.min(DEVIL_LIVE_CAP, Math.max(0, Math.round(_L.devilMaxActivePerCount * unit)));
  _candN = 0;
  _candK = Math.max(0, cap - _liveN);
  _devilLbs.forEach(_evalRec);
  // Spawn the nearest candidates that stand on sand right now.
  for (let i = 0; i < _candN; i += 1) {
    const sl = _cand[i];
    const rec = _candRec[i];
    const lifeIdx = _candLife[i];
    _cand[i] = null; _candRec[i] = null;
    if (_liveN >= cap) { _stats.devilCapped += 1; continue; }
    sl.lifeIdx = lifeIdx;
    const life = devilLifeAt(sl.seed, t, _shared.gate, _L, _lifeScratch);
    const s = _devilPosition(sl, life.progress);
    if (!s) { _stats.devilStopsOffSand += 1; sl.doneLife = lifeIdx; continue; }
    // HYSTERESIS (verifier fix, 2026-10-23): the candidate test is on the
    // HOME, the range-destroy on the devil's CURRENT position (up to ~88 m off
    // its home). A home just inside devilEngageM whose devil had wandered past
    // the 1.15x drop radius was destroyed, re-spawned on the next evaluation,
    // destroyed again ... an addEmitter/destroy churn every second for the rest
    // of its life. Spawn only where the devil stands inside the engage radius
    // NOW; the 15 % band to the drop radius is the hysteresis. The life is not
    // marked spent, so it can still form if the player closes in.
    const sdx = _wander.x - _ev.px;
    const sdy = _wander.y - _ev.py;
    if (sdx * sdx + sdy * sdy > _ev.engage2) { _stats.devilSpawnOutOfRange += 1; continue; }
    const pp = sl.parent.position;
    pp.x = _wander.x; pp.y = _wander.y; pp.z = s.height;
    _spawnDevil(rec, sl, t, lifeIdx);
  }
  _candN = 0;
}

function _devilFrame(frameCtx) {
  const t = Number.isFinite(frameCtx.tSec) ? frameCtx.tSec : 0;
  windAcFromGlobals(_sand.globals, _wind);
  const evalDt = 1 / Math.max(0.1, _L.devilEvalHz);
  if (t - _shared.lastEvalT >= evalDt || t < _shared.lastEvalT) {
    _shared.lastEvalT = t;
    _devilEvaluate(t, frameCtx);
  }
  // Per frame: walk every live devil along its path; stop the ones whose life
  // ended, whose weather coin failed, or that wandered off the sand.
  for (let i = 0; i < _liveN;) {
    const sl = _live[i];
    const rec = sl ? sl.rec : null;
    if (!sl || !rec || sl.state !== DEVIL_ACTIVE) { _liveRemoveAt(i); continue; }
    const life = devilLifeAt(sl.seed, t, _shared.gate, _L, _lifeScratch);
    if (!life.active || life.lifeIdx !== sl.lifeIdx) { _stopDevil(rec, sl, "life", t); continue; }
    const s = _devilPosition(sl, life.progress);
    if (!s) { _stopDevil(rec, sl, "offSand", t); continue; }
    const pp = sl.parent.position;
    pp.x = _wander.x; pp.y = _wander.y; pp.z = s.height;
    i += 1;
  }
}

function _streamerProvider() {
  return {
    id: STREAMER_PROVIDER_ID,
    families: [FAM_SAND],
    scope: "camera",
    enabled() { return terrainSandEnabled() && terrainSandStreamersEnabled(); },
    quality(flags) {
      const q = resolveSandQuality(flags);
      return q && q.streamerCount > 0 ? q : null;
    },
    update(dt, frameCtx) {
      if (!_sand) return;
      if (!frameCtx || !frameCtx.hasPlayer) return;
      // `frameCtx.oracle` is a LIVE getter on the spine (handoff §5) — read it
      // every frame, never stash it. The pool holds a GETTER for the same
      // reason, so a field built before the oracle resolved still comes alive.
      if (!_sand.field) {
        const q = resolveSandQuality(frameCtx.quality) || {
          streamerCount: terrainSandStreamerCount(),
          radiusM: terrainSandRadiusM(),
        };
        const count = q.streamerCount > 0 ? q.streamerCount : terrainSandStreamerCount();
        if (count <= 0) return;
        _sand.field = createSandStreamerField({
          THREE: _sand.THREE,
          parent: _sand.parent,
          globals: _sand.globals,
          oracle: () => (_sand ? _sand.oracleRef() : null),
          count,
          radiusM: q.radiusM || terrainSandRadiusM(),
          seed: _sand.seed,
          tuning: _L,
        });
        _stats.streamerBuilds += 1;
        // First frame: seed the gate + light before the shared tick dedupes.
        _sand.field.setEnvironment(_shared.env);
        const mats = _terrainMaterials(frameCtx);
        if (mats) _sand.field.setTerrainLight(mats);
      }
      _sharedTick(frameCtx);
      const p = frameCtx.playerPos;
      _sand.field.update(dt, frameCtx.tSec, p.x, p.y, p.z);
    },
    dispose() {
      if (_sand && _sand.field) { _sand.field.dispose(); _sand.field = null; }
    },
  };
}

function _devilProvider() {
  return {
    id: DEVIL_PROVIDER_ID,
    families: [FAM_SAND],
    scope: "landblock",
    enabled() { return terrainSandEnabled() && terrainSandDevilsEnabled(); },
    quality(flags) {
      const q = resolveSandQuality(flags);
      return q && q.devilCount > 0 ? q : null;
    },
    onLandblockReady(ctx) {
      if (!_sand) return;
      const count = ctx?.quality?.devilCount > 0 ? ctx.quality.devilCount : terrainSandDevilCount();
      if (count <= 0) return;
      const slots = devilSlotsForLandblock({
        lbKey: ctx.lbKey,
        lbX: ctx.lbX,
        lbY: ctx.lbY,
        codes: ctx.codes,
        heights: ctx.heights,
        count,
        seed: _sand.seed,
      });
      if (slots.length === 0) return;
      // Refine z through the oracle when it is up (exact split-diagonal height
      // at the jittered point rather than the nearest vertex). Deterministic:
      // the oracle is a pure function of static terrain.
      const oracle = _sand.oracleRef();
      if (oracle && typeof oracle.heightAt === "function") {
        for (const s of slots) {
          const h = oracle.heightAt(s.x, s.y);
          if (Number.isFinite(h)) s.z = h;
        }
      }
      const key = ctx.lbKey >>> 0;
      // A rebake is gone-then-ready, so a stale record cannot be here; guard
      // anyway so a double ready never leaks a live slot.
      if (_devilLbs.has(key)) this.onLandblockGone(key);
      const rec = {
        lbKey: key,
        ownerKey: sandOwnerKeyForLb(ctx.lbKey),
        parked: false,
        slots: [],
      };
      for (const s of slots) {
        rec.slots.push({
          rec,
          slot: s.slot,
          seed: s.seed,
          homeX: s.x,
          homeY: s.y,
          homeZ: s.z,
          parent: _devilParent(_sand.THREE, s),
          state: DEVIL_IDLE,
          lifeIdx: -1,
          doneLife: -1,
          hasEmitter: false,
          // 2026-10-24 — the dissolve window: when the emitter was stopped
          // (NaN = not dissolving) and its longest puff life.
          stopT: NaN,
          drainS: DEVIL_DRAIN_FALLBACK_S,
          id: 0,
          gen: 0,
        });
      }
      _devilLbs.set(key, rec);
      _stats.devilLandblocks += 1;
      // NO spawn here (2026-10-23): emission is decided by the per-frame
      // update — distance to the player, the devil's life, the live cap —
      // never by LRU residency alone.
    },
    onLandblockPark(lbKey) {
      const rec = _devilLbs.get(lbKey >>> 0);
      if (!rec || rec.parked) return;
      rec.parked = true;
      _stats.parks += 1;
      // PARK STOPS EMISSION — it never destroys (plan §2.2.2 / §5.3), so
      // `emitterCountForOwner` is unchanged and unpark is free.
      for (const sl of rec.slots) {
        if (!sl.hasEmitter && sl.state !== DEVIL_ACTIVE) continue;
        try { _sand.ownerRegistry.stopEmitter(rec.ownerKey, devilEmitterHandle(sl.slot)); } catch (_) {}
        if (sl.state === DEVIL_ACTIVE) {
          _liveRemove(sl);
          // The dissolve window starts now (the last frame's clock; before any
          // frame it is NaN and the next evaluation stamps it). A slot that was
          // already dissolving keeps its own stop time.
          sl.stopT = _shared.lastT;
        }
        sl.state = DEVIL_IDLE;
        _stats.devilParkStops += 1;
      }
    },
    onLandblockUnpark(lbKey) {
      const rec = _devilLbs.get(lbKey >>> 0);
      if (!rec || !rec.parked) return;
      rec.parked = false;
      _stats.unparks += 1;
      // Eligible again at the next evaluation. Placement is hash-stable
      // (§5.5) and the life clock never stopped, so a devil comes back on the
      // same path it was walking — this is NOT a re-scatter. Re-evaluate on
      // the next tick rather than in 0.5 s.
      _shared.lastEvalT = -Infinity;
    },
    onLandblockGone(lbKey) {
      const rec = _devilLbs.get(lbKey >>> 0);
      if (!rec) return;
      _devilLbs.delete(lbKey >>> 0);
      _stats.gones += 1;
      _stats.destroyAllCalls += 1;
      for (const sl of rec.slots) {
        if (sl.state === DEVIL_ACTIVE) _liveRemove(sl);
        sl.state = DEVIL_IDLE;
        sl.hasEmitter = false;
        sl.stopT = NaN;
        sl.gen += 1;
      }
      try { _sand.ownerRegistry.destroyAllForOwner(rec.ownerKey); } catch (_) {}
    },
    update(dt, frameCtx) {
      if (!_sand || !frameCtx) return;
      _sharedTick(frameCtx);
      if (!frameCtx.hasPlayer) return;
      _devilFrame(frameCtx);
    },
    dispose() {
      for (const [, rec] of _devilLbs) {
        try { _sand?.ownerRegistry.destroyAllForOwner(rec.ownerKey); } catch (_) {}
      }
      _devilLbs.clear();
      for (let i = 0; i < _liveN; i += 1) _live[i] = null;
      _liveN = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Live knobs — `window.__terrainSand.tune / sparkle / respawnDevils`.
// ---------------------------------------------------------------------------

/**
 * Merge numeric knobs into the LIVE tuning and push them where they act
 * immediately (streamer uniforms). Devil knobs act on the next spawn
 * (`respawnDevils()` to see them now); `devilConfig: {...}` is merged over
 * the descriptor defaults at spawn (e.g. `{finalScale: 9.5, maxParticles:
 * 120}`). Fill-time knobs (lengths, heights, lift, tint) apply as ribbons
 * re-scatter (`__terrainSand.field.pool.rescatterAll(x, y, z)` to force).
 * Returns the resulting tuning (a copy).
 */
function tuneSand(patch) {
  if (patch && typeof patch === "object") {
    for (const k of Object.keys(patch)) {
      const v = patch[k];
      if (k === "colour" && Array.isArray(v) && v.length >= 3) {
        _L.colour = [Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0];
      } else if (k === "devilConfig" && v && typeof v === "object") {
        _L.devilConfig = { ...(_L.devilConfig || {}), ...v };
      } else if (k in SAND_TUNING && Number.isFinite(Number(v))) {
        _L[k] = Number(v);
      }
    }
    if (_sand && _sand.field) {
      _sand.field.applyTuning();
      _sand.field.setEnvironment(_shared.env);
    }
  }
  return { ..._L, colour: _L.colour.slice() };
}

/**
 * Live sparkle knobs: `{strength, density, fadeStart, fadeEnd, sharpness,
 * facetFrac, enabled}`. Written onto every terrain material now and onto each
 * new landblock's material on its first frame. `sparkle(null)` stops
 * overriding (materials keep the last written values until they rebake).
 */
function sparkleSand(patch) {
  if (patch === null) {
    _sparkle.version = 0;
    _sparkle.names.length = 0;
    _sparkle.values.length = 0;
    return {};
  }
  if (patch && typeof patch === "object") {
    for (const k of Object.keys(SAND_SPARKLE_KNOBS)) {
      if (!(k in patch)) continue;
      let v = patch[k];
      if (k === "enabled") v = v ? 1 : 0;
      if (!Number.isFinite(Number(v))) continue;
      const name = SAND_SPARKLE_KNOBS[k];
      const at = _sparkle.names.indexOf(name);
      if (at >= 0) _sparkle.values[at] = Number(v);
      else { _sparkle.names.push(name); _sparkle.values.push(Number(v)); }
    }
    _sparkle.serial += 1;
    _sparkle.version = _sparkle.serial;
    const mats = _terrainMaterials(null);
    if (mats) _stats.sparklePushes += pushSandSparkleOverrides(mats);
  }
  const out = {};
  for (const k of Object.keys(SAND_SPARKLE_KNOBS)) {
    const at = _sparkle.names.indexOf(SAND_SPARKLE_KNOBS[k]);
    if (at >= 0) out[k] = _sparkle.values[at];
  }
  return out;
}

/** Destroy every live devil and forget spent lives, so the next evaluation
 *  re-forms them with the current tuning. */
function respawnDevils() {
  let n = 0;
  _devilLbs.forEach((rec) => {
    for (const sl of rec.slots) {
      if (sl.hasEmitter || sl.state === DEVIL_ACTIVE) {
        try { _sand?.ownerRegistry.destroyEmitter?.(rec.ownerKey, devilEmitterHandle(sl.slot)); } catch (_) {}
        n += 1;
      }
      if (sl.state === DEVIL_ACTIVE) _liveRemove(sl);
      sl.state = DEVIL_IDLE;
      sl.hasEmitter = false;
      sl.stopT = NaN;
      sl.doneLife = -1;
    }
  });
  _shared.lastEvalT = -Infinity;
  return n;
}

/**
 * The live devils, nearest first, with a compass bearing from the player
 * (0 = north, 90 = east) — "where do I look?" for the vistest. Allocates
 * (diagnostics only).
 */
function activeDevils() {
  const p = _shared.player;
  const out = [];
  for (let i = 0; i < _liveN; i += 1) {
    const sl = _live[i];
    if (!sl) continue;
    const dx = sl.parent.position.x - p.x;
    const dy = sl.parent.position.y - p.y;
    let bearing = (Math.atan2(dx, dy) * 180) / Math.PI;
    if (bearing < 0) bearing += 360;
    out.push({
      lbKey: `0x${(sl.rec.lbKey >>> 0).toString(16).padStart(8, "0")}`,
      slot: sl.slot,
      x: +sl.parent.position.x.toFixed(1),
      y: +sl.parent.position.y.toFixed(1),
      z: +sl.parent.position.z.toFixed(1),
      distM: Math.round(Math.hypot(dx, dy)),
      bearingDeg: Math.round(bearing),
      life: sl.lifeIdx,
      emitterId: sl.id,
    });
  }
  out.sort((a, b) => a.distM - b.distM);
  return out;
}

/**
 * Construct + register the SAND family. Called once from `scene3d/index.js`
 * right after `initTerrainVfx` (the spine must exist first — the providers are
 * replayed onto the already-resident ring by `registerTerrainVfx`).
 *
 * Returns `null` (registering nothing, allocating nothing) when the family
 * master is off — a bare-default boot is byte-identical.
 *
 * @param {object} opts
 * @param {object} [opts.THREE]    the three namespace (injected).
 * @param {object} opts.scene3d    the live facade.
 * @param {object} [opts.parent]   Object3D for the streamer mesh; defaults to
 *   `terrainGroup.parent` (worldRoot) — a SIBLING of terrainGroup with the same
 *   transform, so the field is in AC space and the LRU's terrainGroup scans
 *   cannot take it.
 * @param {object} [opts.globals]  VFX_GLOBALS (uTime/uWindDir, BY REFERENCE).
 * @param {Function} [opts.readEnv] `vfx/particle_env.js::readParticleEnv`
 *   (injected so this module stays THREE-free).
 * @param {Function} [opts.getParticleManager] defaults to the shared static
 *   ParticleManager (`scene3d._staticParticleManager`), whose scene is
 *   `staticsGroup` — the same AC frame the devil positions are in.
 * @param {object} [opts.ownerRegistry] the shared singleton by default.
 * @param {Function} [opts.getOracle] override for the terrain oracle.
 */
export function initTerrainSand(opts = {}) {
  const scene3d = opts.scene3d || null;
  if (!terrainSandEnabled()) return null;          // ship-OFF master (plan §5.9)

  const streamersOn = terrainSandStreamersEnabled();
  const devilsOn = terrainSandDevilsEnabled();
  if (!streamersOn && !devilsOn) return null;      // sparkle is terrain.js's

  _sand = {
    THREE: opts.THREE || null,
    scene3d,
    parent: opts.parent || scene3d?.terrainGroup?.parent || null,
    globals: opts.globals || null,
    readEnv: typeof opts.readEnv === "function" ? opts.readEnv : null,
    getParticleManager: typeof opts.getParticleManager === "function"
      ? opts.getParticleManager
      : () => scene3d?._staticParticleManager || null,
    ownerRegistry: opts.ownerRegistry || defaultOwnerRegistry,
    seed: Number.isFinite(opts.seed) ? opts.seed | 0 : 0x5a4d1e55,
    field: null,
    registered: [],
    oracleRef: typeof opts.getOracle === "function"
      ? opts.getOracle
      : () => {
        try {
          return (typeof window !== "undefined" && window.__terrainVfx)
            ? window.__terrainVfx.oracle
            : null;
        } catch (_) { return null; }
      },
  };
  _stats.inits += 1;
  // Seed the shared env now so a field built on the first tick has a gate.
  _shared.env = _envSnapshot();
  _shared.gate = dustDevilGate(_shared.env);

  if (streamersOn) _sand.registered.push(registerTerrainVfx(_streamerProvider()));
  if (devilsOn) _sand.registered.push(registerTerrainVfx(_devilProvider()));
  return terrainSandSurface();
}

/** Diagnostics — mirrored onto `window.__terrainSand` by `scene3d/index.js`. */
export function terrainSandStats() {
  let holding = 0;
  _devilLbs.forEach((rec) => { for (const sl of rec.slots) if (sl.hasEmitter) holding += 1; });
  return {
    enabled: terrainSandEnabled(),
    streamers: terrainSandEnabled() && terrainSandStreamersEnabled(),
    devils: terrainSandEnabled() && terrainSandDevilsEnabled(),
    sparkle: terrainSandEnabled() && terrainSandSparkleEnabled(),
    inited: !!_sand,
    sandCodes: sandTerrainCodes(),
    sandCodeMask: sandCodeBitmask(),
    // LRU residency (capacity-bounded) — NOT the cost. See devilsActive.
    devilLandblocks: _devilLbs.size,
    // Distance-bounded: live devils (≤ devilMaxActivePerCount × devilCount) and
    // slots still holding an emitter (live + dissolving; a dissolving slot is
    // released lifespan + |lifespanRand| + 1 s after its stop, 2026-10-24).
    devilsActive: _liveN,
    devilsHoldingEmitter: holding,
    devilGate: _shared.gate,
    devilOwners: [..._devilLbs.values()].map((r) => ({
      ownerKey: r.ownerKey,
      slots: r.slots.length,
      ids: r.slots.reduce((n, sl) => n + (sl.id ? 1 : 0), 0),
      active: r.slots.reduce((n, sl) => n + (sl.state === DEVIL_ACTIVE ? 1 : 0), 0),
      parked: r.parked,
      live: (() => {
        try { return _sand ? _sand.ownerRegistry.emitterCountForOwner(r.ownerKey) : 0; }
        catch (_) { return 0; }
      })(),
    })),
    field: _sand && _sand.field ? _sand.field.stats() : null,
    sparkleOverrides: sparkleSand(undefined),
    counters: { ..._stats },
  };
}

function terrainSandSurface() {
  return {
    stats: terrainSandStats,
    get field() { return _sand ? _sand.field : null; },
    get devils() { return [..._devilLbs.keys()]; },
    activeDevils,
    tune: tuneSand,
    tuning: () => tuneSand(null),
    sparkle: sparkleSand,
    respawnDevils,
    lbKeyFromXY,
  };
}

/** Test seam — unregister both providers and drop all state. */
export function _resetTerrainSand() {
  if (_sand) {
    for (const h of _sand.registered) {
      try { unregisterTerrainVfx(h.id); } catch (_) {}
    }
    if (_sand.field) { try { _sand.field.dispose(); } catch (_) {} }
  }
  _devilLbs.clear();
  for (let i = 0; i < DEVIL_LIVE_CAP; i += 1) { _live[i] = null; _cand[i] = null; _candRec[i] = null; }
  _liveN = 0;
  _candN = 0;
  _sand = null;
  _L = { ...SAND_TUNING, colour: SAND_TUNING.colour.slice() };
  _shared.lastT = NaN;
  _shared.lastEnvT = -Infinity;
  _shared.env = null;
  _shared.gate = 0;
  _shared.lastEvalT = -Infinity;
  _shared.player.valid = false;
  _sparkle.version = 0;
  _sparkle.names.length = 0;
  _sparkle.values.length = 0;
  for (const k of Object.keys(_stats)) _stats[k] = 0;
}
