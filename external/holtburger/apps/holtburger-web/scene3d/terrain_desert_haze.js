// scene3d/terrain_desert_haze.js — the DESERT arm of the heat shimmer + mirage
// (2026-10-23, owner on the 1070 in the Tufa desert: "get our mirage effect
// sorted, its not active or not as much as it should be ... improve it also").
//
// WHY A SECOND ARM. `terrain_volcano.js` drives the shimmer as a projected DISC
// around the nearest volcanic landblock: right for a lava field, wrong for a
// desert, which is everywhere around you. Here the heat source is the GROUND:
// the shimmer grows with eye distance over hot sand, and past a few hundred
// metres the distant ground shows the sky just above it in shimmering patches —
// the inferior mirage, the "water on the road" look. Both are pure UV work in
// the SAME `HeatHazeEffect` (`vfx/heat_haze_effect.js`, ground + mirage terms).
//
// HOW HOT. One number per frame, `desertWeight × heat`:
//   - desertWeight: the sand share of the landblocks around the player
//     (FAM_SAND vertex fraction, tent-weighted by distance to each landblock's
//     centre over a 5×5 window), so the effect fades in as you walk into a
//     desert and out as you leave — and never follows you out (a landblock that
//     is not resident counts as sand-free; park/gone drop it);
//   - heat: daylight (sun altitude), times dry (1 − rain wetness), times calm
//     (storms damp it). No mirage at night or in the rain.
// The product is low-passed (MIRAGE_TUNING.smoothSec) so a landblock boundary or
// a cloud of rain never pops it.
//
// WRITES ONLY the ground / mirage fields of `HEAT_HAZE_STATE` (the volcano arm
// owns the disc fields; neither clears the other's). THREE-free, deterministic
// (no Math.random, no clock reads: `dt` and the env come from the caller).

import { registerTerrainVfx, unregisterTerrainVfx } from "./terrain_vfx.js";
import { FAM_SAND, familyForCode } from "./terrain_families.js";
import { heatHazeEnabled } from "./vfx_flags.js";
import { HEAT_HAZE_STATE, clearGroundHazeState } from "./terrain_volcano.js";
import { createInteriorMask } from "./grass_interior_mask.js";

export const DESERT_HAZE_PROVIDER_ID = "terrain.desertHaze";

/** Tuning that is NOT worth a URL flag (live handle: `window.__heatHaze`). */
export const MIRAGE_TUNING = Object.freeze({
  // Desert weight: tent weight 1 − d / tentM over the landblock-centre distance,
  // a 5×5 window around the player's landblock. 384 m = 2 landblocks: the 8
  // neighbours weigh 0.5 / 0.29 against the player's own 1, so one landblock
  // cannot carry the weight alone and the desert edge fades over ~2 landblocks.
  windowLb: 2,
  tentM: 384,
  // desertWeight → effect: below `weightLo` nothing, full at `weightHi`. A lone
  // sand landblock in grass country (weight 0.24) and mixed country stay clean.
  weightLo: 0.3,
  weightHi: 0.7,
  // Heat: sun altitude (sin of the pitch, as particle_env.js reports it) from
  // `sunLo` (low morning sun, ~6°) to `sunHi` (~35°) ramps 0 → 1.
  sunLo: 0.1,
  sunHi: 0.57,
  // Storminess damps the heat by up to this fraction (wind mixes the air).
  stormDamp: 0.7,
  // Low-pass time constant on the published strength, seconds.
  smoothSec: 1.5,
  // Ground shimmer depth band (eye-forward metres): starts at `groundNearM`,
  // full by `groundFullM`, fades out by `groundFarM` (where fog has the frame).
  groundNearM: 25,
  groundFullM: 450,
  groundFarM: 2600,
  // Mirage (sky patches on far ground): from `mirageStartM`, full by
  // `mirageStartM + mirageFeatherM`.
  mirageStartM: 160,
  mirageFeatherM: 420,
  // 2026-10-23 (owner: shimmer and mirage in towns is unsuitable): the interior
  // cells (EnvCells) within townRadiusM of the player decide "town". Below
  // townCellsLo the air is open country (factor 1); from townCellsHi it is a
  // town (factor 0). Sampled townHz times a second, low-passed like the desert.
  townRadiusM: 160,
  townCellsLo: 4,
  townCellsHi: 16,
  townHz: 4,
});

/** Town factor from an interior-cell count: 1 in open country, 0 in a town. */
export function townFactorFromCells(n, tuning = MIRAGE_TUNING) {
  if (!(n > 0)) return 1;
  return 1 - smooth01(tuning.townCellsLo, tuning.townCellsHi, n);
}

let _desert = null;
let _townClock = 0, _townTarget = 1;
/** lbKey → { x, y, frac }: resident landblocks with any sand (centre in AC m). */
const _sandLbs = new Map();
const _stats = { inits: 0, frames: 0, lbsSeen: 0, peakWeight: 0, townCells: 0 };

/**
 * The FAM_SAND share of one landblock's 81 vertex codes, 0..1. Pure.
 * @param {ArrayLike<number>|null|undefined} codes column-major 9×9 terrain codes
 */
export function sandFractionOfCodes(codes) {
  if (!codes || !(codes.length >= 81)) return 0;
  let n = 0;
  for (let i = 0; i < 81; i += 1) if (familyForCode(codes[i]) === FAM_SAND) n += 1;
  return n / 81;
}

/**
 * Tent-weighted sand share around a world position. Pure over `lbs`
 * (lbKey → {x, y, frac}). Every in-window landblock carries its tent weight;
 * one that is not in the map (no sand, or not resident) counts as sand-free, so
 * the weight only ever rises on LOADED sand — a teleport into a desert ramps in
 * as the ring bakes, and nothing far away can hold it up.
 */
export function desertWeightAt(lbs, px, py, tuning = MIRAGE_TUNING) {
  if (!lbs || lbs.size === 0 || !Number.isFinite(px) || !Number.isFinite(py)) return 0;
  const cx = Math.floor(px / 192), cy = Math.floor(py / 192);
  const R = tuning.windowLb;
  let wSum = 0, fSum = 0;
  for (let dx = -R; dx <= R; dx += 1) {
    for (let dy = -R; dy <= R; dy += 1) {
      const lx = cx + dx, ly = cy + dy;
      if (lx < 0 || ly < 0 || lx > 255 || ly > 255) continue;
      const ox = lx * 192 + 96 - px, oy = ly * 192 + 96 - py;
      const w = 1 - Math.hypot(ox, oy) / tuning.tentM;
      if (w <= 0) continue;
      const rec = lbs.get((((lx << 24) | (ly << 16)) >>> 0));
      wSum += w;
      if (rec) fSum += w * rec.frac;
    }
  }
  return wSum > 0 ? fSum / wSum : 0;
}

const smooth01 = (lo, hi, v) => {
  if (!(hi > lo)) return v >= hi ? 1 : 0;
  const t = Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};

/**
 * Heat from the environment, 0..1: daylight × dry × calm. `env` is the
 * particle-env snapshot (`vfx/particle_env.js::readParticleEnv`): sunAlt (sin of
 * the sun pitch), wetness 0..1, stormness 0..1. A null env is a clear noon.
 */
export function desertHeatFromEnv(env, tuning = MIRAGE_TUNING) {
  const sunAlt = env && Number.isFinite(env.sunAlt) ? env.sunAlt : 0.92;
  const wet = env && Number.isFinite(env.wetness) ? Math.max(0, Math.min(1, env.wetness)) : 0;
  const storm = env && Number.isFinite(env.stormness) ? Math.max(0, Math.min(1, env.stormness)) : 0;
  return smooth01(tuning.sunLo, tuning.sunHi, sunAlt) * (1 - wet) * (1 - tuning.stormDamp * storm);
}

/** `{strength}` for the tier, or null (the provider then gets no landblocks). */
export function resolveDesertHazeQuality(flags) {
  if (!flags || flags.terrainHaze !== true) return null;
  const s = Number(flags.terrainHazeStrength);
  const strength = Number.isFinite(s) ? Math.max(0, Math.min(4, s)) : 0;
  return strength > 0 ? { strength } : null;
}

/**
 * THE ground/mirage state write. Writes only the ground fields of
 * `HEAT_HAZE_STATE`, in place. `target` is low-passed toward with time constant
 * `smoothSec` (dt ≤ 0.25 s per step, so a hitch cannot overshoot).
 */
export function updateDesertHazeState(quality, playerPos, env, dt, tuning = MIRAGE_TUNING) {
  const s = HEAT_HAZE_STATE;
  if (!quality || !playerPos) {
    clearGroundHazeState();
    return s;
  }
  const weight = desertWeightAt(_sandLbs, playerPos.x, playerPos.y, tuning);
  const heat = desertHeatFromEnv(env, tuning);
  const target = smooth01(tuning.weightLo, tuning.weightHi, weight) * heat * quality.strength;
  const step = Math.max(0, Math.min(0.25, Number.isFinite(dt) ? dt : 0));
  const k = tuning.smoothSec > 0 ? 1 - Math.exp(-step / tuning.smoothSec) : 1;
  const prev = Number.isFinite(s.groundStrength) ? s.groundStrength : 0;
  let g = prev + (target - prev) * k;
  // Snap the tail to exactly 0 (2e-3 of full weight is ~1e-5 of the frame).
  if (g < 2e-3 && target === 0) g = 0;
  s.desertWeight = weight;
  s.desertHeat = heat;
  s.groundStrength = g;
  s.mirage = g;
  s.groundNearM = tuning.groundNearM;
  s.groundFullM = tuning.groundFullM;
  s.groundFarM = tuning.groundFarM;
  s.mirageStartM = tuning.mirageStartM;
  s.mirageFeatherM = tuning.mirageFeatherM;
  if (weight > _stats.peakWeight) _stats.peakWeight = weight;
  return s;
}

function _provider() {
  return {
    id: DESERT_HAZE_PROVIDER_ID,
    families: [FAM_SAND],
    scope: "landblock",
    enabled() { return heatHazeEnabled(); },
    quality(flags) { return resolveDesertHazeQuality(flags); },
    onLandblockReady(ctx) {
      const frac = sandFractionOfCodes(ctx.codes);
      if (frac <= 0) return;
      _sandLbs.set(ctx.lbKey >>> 0, { x: ctx.lbX * 192 + 96, y: ctx.lbY * 192 + 96, frac });
      _stats.lbsSeen += 1;
    },
    // Park detaches the terrain mesh: off screen, so it must not heat the air.
    onLandblockPark(lbKey) { _sandLbs.delete(lbKey >>> 0); },
    onLandblockUnpark(lbKey, ctx) {
      if (!ctx) return;
      const frac = sandFractionOfCodes(ctx.codes);
      if (frac > 0) _sandLbs.set(lbKey >>> 0, { x: ctx.lbX * 192 + 96, y: ctx.lbY * 192 + 96, frac });
    },
    onLandblockGone(lbKey) { _sandLbs.delete(lbKey >>> 0); },
    update(dt, frameCtx) {
      _stats.frames += 1;
      // Town factor (both arms): the interior cells near the player, sampled at
      // townHz from the CPU interior mask (grass_interior_mask.js, CPU mode).
      if (_desert) {
        if (!_desert.mask) { try { _desert.mask = createInteriorMask(); } catch (_) { _desert.mask = null; } }
        const step = Number.isFinite(dt) ? Math.min(0.25, Math.max(0, dt)) : 0;
        const p = frameCtx && frameCtx.hasPlayer ? frameCtx.playerPos : null;
        if (_desert.mask) {
          try { _desert.mask.sync(frameCtx ? frameCtx.scene3d : null); } catch (_) { /* fail-soft */ }
          _townClock -= step;
          if (_townClock <= 0 && p) {
            _townClock = 1 / MIRAGE_TUNING.townHz;
            const n = _desert.mask.boxesNear(p.x, p.y, MIRAGE_TUNING.townRadiusM);
            _stats.townCells = n;
            _townTarget = townFactorFromCells(n);
          }
        }
        const k = MIRAGE_TUNING.smoothSec > 0 ? 1 - Math.exp(-step / MIRAGE_TUNING.smoothSec) : 1;
        const prev = Number.isFinite(HEAT_HAZE_STATE.townFactor) ? HEAT_HAZE_STATE.townFactor : 1;
        HEAT_HAZE_STATE.townFactor = prev + (_townTarget - prev) * k;
      }
      let env = null;
      if (_desert && _desert.readEnv) {
        try { env = _desert.readEnv(_desert.scene3d) || null; } catch (_) { env = null; }
      }
      updateDesertHazeState(
        resolveDesertHazeQuality(frameCtx && frameCtx.quality),
        frameCtx && frameCtx.hasPlayer ? frameCtx.playerPos : null,
        env,
        frameCtx && Number.isFinite(frameCtx.dt) ? frameCtx.dt : dt,
      );
    },
    dispose() {
      _sandLbs.clear();
      clearGroundHazeState();
      HEAT_HAZE_STATE.townFactor = 1;
    },
  };
}

/**
 * Register the desert arm. Returns a surface for `window.__terrainDesertHaze`,
 * or null when the heat shimmer is off (`?terrainHaze=off`, `?visual=off`,
 * `?terrainVfx=off`, or a tier without it: low / mid).
 * @param {{scene3d?:object, readEnv?:(scene3d:object)=>object}} [opts]
 */
export function initDesertHaze(opts = {}) {
  if (!heatHazeEnabled()) return null;
  if (_desert) return desertHazeSurface();
  _desert = {
    scene3d: opts.scene3d || null,
    readEnv: typeof opts.readEnv === "function" ? opts.readEnv : null,
    registered: registerTerrainVfx(_provider()),
  };
  _stats.inits += 1;
  return desertHazeSurface();
}

/** Diagnostics: the published ground state and the sand landblocks held. */
export function desertHazeStats() {
  const s = HEAT_HAZE_STATE;
  return {
    enabled: !!_desert,
    sandLbs: _sandLbs.size,
    desertWeight: s.desertWeight,
    desertHeat: s.desertHeat,
    groundStrength: s.groundStrength,
    mirage: s.mirage,
    townFactor: s.townFactor,
    ..._stats,
  };
}

function desertHazeSurface() {
  return { stats: desertHazeStats, tuning: MIRAGE_TUNING };
}

/** Tests / teardown. */
export function disposeDesertHaze() {
  if (_desert && _desert.registered) {
    try { unregisterTerrainVfx(_desert.registered.id); } catch (_) {}
  }
  _desert = null;
  _sandLbs.clear();
  clearGroundHazeState();
  HEAT_HAZE_STATE.townFactor = 1;
  _townClock = 0; _townTarget = 1;
  _stats.inits = 0; _stats.frames = 0; _stats.lbsSeen = 0; _stats.peakWeight = 0; _stats.townCells = 0;
}

/** Tests: the held sand landblocks (read-only use). */
export function _desertSandLbs() { return _sandLbs; }
