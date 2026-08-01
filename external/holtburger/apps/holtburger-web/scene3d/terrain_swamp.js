// scene3d/terrain_swamp.js — SWAMP / MARSH terrain VFX (Wave 3A).
//
// Design plan: `docs/2026-07-31-terrain-vfx-plan.md` §3.5. Terrain code 4
// (`MarshSparseSwamp`) = `FAM_SWAMP`, plus code 23 (`SeaSlime`) ONLY under
// `?strictWaterCodes` — both DERIVED from `terrain_families.js`, never
// hardcoded here (plan §8 risk 12: family membership is a property of the CODE,
// and another region could name the same code differently).
//
// ⚠ CODE 23 IS WATER BY DEFAULT AND THAT IS DELIBERATE (plan §3.8.3). The
// shipped `terrain.js TERRAIN_WATER_CODES` is `{16..20, 22, 23}`, so the client
// already gives SeaSlime wave displacement through `uWaterCodeMask` and the
// WATER agent owns it. `?strictWaterCodes` drops 22 and 23, and only THEN does
// 23 fall through to `FAM_SWAMP` and pick up everything in this file. Nothing
// here lists 23; `swampTerrainCodes()` simply asks the family LUT, which asks
// the live water set. `swampIncludesSeaSlime()` reports which way it resolved,
// and `test_terrain_swamp.mjs` asserts BOTH configurations.
//
// THE LOOK (plan §3.5): oppressive and damp. Fireflies drifting at night, gas
// bubbling sluggishly out of the peat and occasionally igniting as a wisp, low
// fog clinging IN the terrain, midge columns hanging in shafts of light.
//
// FOUR EFFECTS, TWO OWNERS:
//   1. FIREFLIES — here (lifecycle) + `vfx/components/terrainSwampAmbient.js`
//      (`terrain.swampFireflies`). **NOT a second firefly system** (plan §3.5
//      item 1): the descriptor calls `foliageFireflies.emit()` and this file
//      supplies a GROUND anchor instead of a canopy part frame. That is the
//      whole delta — a new anchor source, not a new mechanism.
//   2. MIDGES    — same shape, re-anchoring `foliagePollen`.
//   3. MARSH GAS — here (lifecycle, and the long wisp timer) + the
//      `terrain.marshGas` descriptor. Landblock-scoped stationary vents at
//      hash-stable positions on the LB's swamp cells. **Adds no light** (§5.2)
//      — the wisp is an additive sprite, never a PointLight.
//   4. GROUND FOG — the SHARED `scene3d/ground_fog.js` (snow and volcano
//      compose the same module later), camera-scoped. This file supplies only
//      the palette, the family gate and the tier numbers.
//
// NOTHING IN THIS WAVE TOUCHES THE TERRAIN FRAGMENT SHADER. Every swamp effect
// is a particle emitter or a billboard, so `terrain.js` is byte-unchanged and
// the wave-2 shader seams are untouched.
//
// INJECTED THREE (the `terrain_vfx.js` / `terrain_sand.js` / `terrain_volcano.js`
// idiom). This module imports no three: `initTerrainSwamp({THREE, ...})` takes
// it and every GPU object is optional. That is what keeps
// `test_terrain_swamp.mjs` cheap and what makes `?nullRender=1` free.
//
// ⚠ THE RE-GATE LOOP, and why it exists here but not in the canopy path.
// A canopy firefly emitter is synthesized ONCE, when its static is baked — so a
// player who logs in at noon and plays until midnight never sees canopy
// fireflies in that landblock. That is a known limitation of the bake-time
// seam. Terrain providers get a per-frame `update()`, so this file re-evaluates
// each effect's gate on a SLOW timer (`REGATE_SEC`) and starts or stops that
// effect's emitters when the gate crosses `SWAMP_GATE_MIN`. Cost is one gate
// call plus a Map walk every 12 s. Without it "fireflies at night" is only true
// if you happened to stream the landblock at night.
//
// INVARIANTS (plan §5). A HOST module, not a registered VFX component: it is
// not swept by `vfx/lint_caps.js` (the DESCRIPTORS next door are). It obeys the
// firewall anyway — it reads static terrain, a server-derived player position,
// the shared clock and the derived weather env, and writes only its own state,
// its own buffers and synthesized emitters. It adds NO LIGHT (§5.2), varies no
// program cache key (§5.4), uses no `Math.random` (§5.5) and sets
// `castShadow = false` on the fog mesh (§5.7, enforced inside `ground_fog.js`).
//
// FLAGS (plan §2.4, all STRICT `=== "on"` opt-ins that ship OFF):
//   ?terrainSwamp        family master (also `?terrainVfx=off`, `?visual=off`
//                                       and `?wireframe=1` kill everything)
//   ?terrainGroundFog (SHARED name)  ?terrainMarshGas  ?terrainMarshWisps
//   ?terrainSwampFireflies  ?terrainSwampMidges
//   ?terrainGroundFogCount  ?terrainGroundFogRadius  ?terrainGroundFogSoftness
//   ?terrainMarshGasCount

import {
  FAM_SWAMP,
  TERRAIN_CODE_COUNT,
  familyForCode,
} from "./terrain_families.js";
import { scatterHash01 } from "./terrain_scatter.js";
import { createGroundFog } from "./ground_fog.js";
import { registerTerrainVfx, unregisterTerrainVfx, lbKeyFromXY } from "./terrain_vfx.js";
import {
  terrainSwampEnabled,
  terrainGroundFogEnabled,
  terrainMarshGasEnabled,
  terrainMarshWispsEnabled,
  terrainSwampFirefliesEnabled,
  terrainSwampMidgesEnabled,
  terrainGroundFogCount,
  terrainGroundFogRadiusM,
  terrainGroundFogSoftnessM,
  terrainMarshGasCount,
} from "./vfx_flags.js";
import { staticOwnerKeyForLb } from "./vfx/particle_attach.js";
import { ownerRegistry as defaultOwnerRegistry } from "./particles/owner_registry.js";
import {
  terrainSwampFireflies,
  terrainSwampMidges,
  terrainMarshGas,
  SWAMP_GATE_MIN,
} from "./vfx/components/terrainSwampAmbient.js";

export const METERS_PER_LANDBLOCK = 192;
export const VERTEX_GRID = 9;
export const VERTEX_SPACING_M = 24;

/** Provider ids — also the `VFX_EFFECT_FLAGS` router rows. The last three are
 *  additionally the registered component ids of the swamp descriptors. */
export const FOG_PROVIDER_ID = "terrain.groundFog";
export const GAS_PROVIDER_ID = "terrain.marshGas";
export const FIREFLY_PROVIDER_ID = "terrain.swampFireflies";
export const MIDGE_PROVIDER_ID = "terrain.swampMidges";

/** Emitter-effect slots. Dense small integers: they index the handle space, the
 *  per-LB effect records and the re-gate accumulators. */
export const EFFECT_GAS = 0;
export const EFFECT_FIREFLIES = 1;
export const EFFECT_MIDGES = 2;
/** The wisp is not a per-LB effect — it is a transient the gas timer creates —
 *  but it needs its own handle range so it can never collide with a vent. */
export const EFFECT_WISP = 3;

/** Seconds between gate re-evaluations (see the header's re-gate note). */
export const REGATE_SEC = 12;

// ---------------------------------------------------------------------------
// Pure helpers — no THREE, no window. The directly-tested surface.
// ---------------------------------------------------------------------------

/** The terrain codes that are FAM_SWAMP, DERIVED from the family LUT. Under the
 *  shipped water set this is `[4]`; under `?strictWaterCodes` it is `[4, 23]`. */
export function swampTerrainCodes() {
  const out = [];
  for (let c = 0; c < TERRAIN_CODE_COUNT; c += 1) {
    if (familyForCode(c) === FAM_SWAMP) out.push(c);
  }
  return out;
}

/** The same set as a GPU bitmask (the `computeCodeBitmask` convention). */
export function swampCodeBitmask() {
  let mask = 0;
  for (const c of swampTerrainCodes()) mask |= (1 << c);
  return mask >>> 0;
}

/** Did code 23 (`SeaSlime`) fall through to the swamp family? True only under
 *  `?strictWaterCodes` (plan §3.8.3). Diagnostics + the test's readback. */
export function swampIncludesSeaSlime() {
  return familyForCode(23) === FAM_SWAMP;
}

/** Tuning that is NOT worth a URL flag. */
export const SWAMP_TUNING = Object.freeze({
  // In-cell placement jitter for a vent/anchor (the cell is 24 m).
  slotJitterM: 12,
  // Spawn-sphere radii handed to the descriptors as the anchor radius. The
  // MIDGE value is the "tighter orbit" lever (plan §3.5 item 4) — see trap T-C
  // in `terrainSwampAmbient.js` for why it is the anchor and not the sprite.
  fireflyAnchorRadiusM: 3.2,
  midgeAnchorRadiusM: 1.1,
  gasAnchorRadiusM: 0.7,
  // Wisp ignition cadence. RARE (plan §3.5 item 2: "rare ignition on a long
  // timer"); each ignition lasts ~2 s, so this is a ~1.5 % duty cycle over the
  // whole resident swamp ring.
  wispPeriodSec: 140,
  wispHandleSlots: 4,
});

/** The SWAMP palette handed to the shared `ground_fog.js`. Marsh green-grey and
 *  DIM: it is an alpha pass over the near field, so its cost is fill-bound. */
export const SWAMP_FOG_PALETTE = Object.freeze({
  colour: [0.56, 0.62, 0.54],
  opacity: 0.17,
  cardWidthM: 26,
  cardHeightM: 5.0,
  liftMinM: 0.2,        // plan §3.5: z = height + 0.2..1.5
  liftMaxM: 1.5,
  nearFadeM: 3.5,
  driftHz: 0.011,
  driftAmount: 0.4,
  fadeFraction: 0.35,
});

/**
 * Resolve the live SWAMP quality tier. `null` ⇒ the whole family is disabled at
 * this tier (plan §5.8: "`low` is null/disabled for every effect here without
 * exception"). Pure in `flags`.
 *
 * @param {object|null} flags `liveScene3d.quality.flags`-shaped bag.
 * @returns {{fogCount:number, fogRadiusM:number, fogSoftnessM:number,
 *   gasCount:number, wisps:boolean, fireflies:boolean, midges:boolean}|null}
 */
export function resolveSwampQuality(flags) {
  const num = (v, def) => (Number.isFinite(Number(v)) ? Number(v) : def);
  const fogCount = Math.max(0, Math.round(num(flags?.terrainGroundFogCount, 0)));
  const fogRadiusM = Math.min(512, Math.max(8, num(flags?.terrainGroundFogRadius, 56)));
  // URL-ONLY (no preset key) — see `vfx_flags.js::terrainGroundFogSoftnessM`.
  const fogSoftnessM = Math.max(0, terrainGroundFogSoftnessM());
  const gasCount = Math.max(0, Math.round(num(flags?.terrainMarshGasCount, 0)));
  const wisps = flags?.terrainMarshWisps === true && gasCount > 0;
  const fireflies = flags?.terrainSwampFireflies === true;
  const midges = flags?.terrainSwampMidges === true;
  if (fogCount === 0 && gasCount === 0 && !fireflies && !midges) return null;
  return { fogCount, fogRadiusM, fogSoftnessM, gasCount, wisps, fireflies, midges };
}

/**
 * Hash-stable emitter placements for one landblock, for ONE effect.
 *
 * PURE and deterministic in `(lbKey, codes, heights, count, seed, channel)` —
 * the whole point (plan §5.5): park/unpark, a LOD rebake, walking away and
 * coming back all put the same vent in the same place. Slots are placed ONLY on
 * FAM_SWAMP vertices, so a landblock with one marshy corner gets its vent on
 * the marsh — and, by construction, never on a water code (plan §3.8.1).
 *
 * `channel` decorrelates the effects: the gas vents, the firefly anchors and
 * the midge columns in one landblock pick DIFFERENT vertices rather than
 * stacking on top of each other.
 *
 * `codes` and `heights` are the LB's 81-entry COLUMN-MAJOR grids
 * (`idx = vx * 9 + vy`, `terrain.js` userData / `LandblockMesh`).
 *
 * Structurally identical to `terrain_sand.js::devilSlotsForLandblock` and
 * `terrain_volcano.js::ventSlotsForLandblock` on purpose — same determinism
 * contract, same distinct-vertex walk, same clamp into the landblock so a slot
 * on an edge vertex cannot drift into a neighbour we know nothing about.
 *
 * @param {{lbKey:number, lbX:number, lbY:number, codes:ArrayLike<number>,
 *   heights?:ArrayLike<number>|null, count:number, seed?:number,
 *   channel?:number}} opts
 * @returns {Array<{slot:number, x:number, y:number, z:number, vx:number,
 *   vy:number, code:number, seed:number}>}
 */
export function swampSlotsForLandblock(opts = {}) {
  const codes = opts.codes;
  const count = Math.max(0, Math.min(8, opts.count | 0));
  if (!codes || count === 0) return [];
  const lbKey = opts.lbKey >>> 0;
  const lbX = opts.lbX | 0;
  const lbY = opts.lbY | 0;
  const heights = opts.heights || null;
  const seed = (Number.isFinite(opts.seed) ? opts.seed : 0x53574d70) | 0;
  const channel = (opts.channel | 0) & 0xff;

  const swampIdx = [];
  const n = Math.min(codes.length, VERTEX_GRID * VERTEX_GRID);
  for (let i = 0; i < n; i += 1) {
    if (familyForCode(codes[i]) === FAM_SWAMP) swampIdx.push(i);
  }
  if (swampIdx.length === 0) return [];

  const out = [];
  const used = new Set();
  for (let slot = 0; slot < count; slot += 1) {
    const pick = scatterHash01(lbKey | 0, (channel << 8) | slot, 1, seed);
    let k = Math.min(swampIdx.length - 1, Math.floor(pick * swampIdx.length));
    let guard = 0;
    while (used.has(swampIdx[k]) && guard < swampIdx.length) {
      k = (k + 1) % swampIdx.length;
      guard += 1;
    }
    if (used.has(swampIdx[k])) break;   // fewer swamp vertices than slots
    used.add(swampIdx[k]);
    const idx = swampIdx[k];
    const vx = (idx / VERTEX_GRID) | 0;
    const vy = idx % VERTEX_GRID;
    const jx = (scatterHash01(lbKey | 0, (channel << 8) | slot, 2, seed) - 0.5) * SWAMP_TUNING.slotJitterM;
    const jy = (scatterHash01(lbKey | 0, (channel << 8) | slot, 3, seed) - 0.5) * SWAMP_TUNING.slotJitterM;
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
      seed: ((lbKey ^ Math.imul(slot + 1 + (channel << 4), 0x85ebca6b)) >>> 0),
    });
  }
  return out;
}

/**
 * The owner key a landblock's swamp emitters register under — ONE key for the
 * whole family (plan §3.5 names it exactly this), with the effects separated by
 * handle range rather than by key, so `destroyAllForOwner` at evict is a single
 * exact sweep that cannot miss a wisp mid-ignition.
 *
 * DERIVED from `vfx/particle_attach.js::staticOwnerKeyForLb` (the single source
 * of truth for the per-LB owner key) with a `:swamp` scope appended — exactly
 * the decision waves 1B (`:sand`) and 2B (`:volcano`) made, for exactly the
 * same reason.
 *
 * ⚠ WHY THE SUFFIX. The teardown API is `destroyAllForOwner(ownerKey)`, and
 * these providers' `onLandblockGone` fires for a terrain LOD REBAKE as well as
 * for an evict (`terrain_vfx.js` deliberately delivers a rebake as
 * gone-then-ready). A rebake does NOT rebuild statics — so calling
 * `destroyAllForOwner("static:N")` there would silently reap every
 * brazier/foliage emitter in the landblock and never bring them back. The
 * suffix keeps the derivation (change the static scheme and this changes with
 * it) while making the teardown exact.
 *
 * @param {number} landblockIdOrLbKey
 */
export function swampOwnerKeyForLb(landblockIdOrLbKey) {
  return `${staticOwnerKeyForLb(landblockIdOrLbKey)}:swamp`;
}

/** The scoped emitter handle for `effect`'s `slot`. Never 0, so
 *  `ownerRegistry.stopEmitter` can find it at park. */
export function swampEmitterHandle(effect, slot) {
  return (0x5357_0000 + (((effect | 0) & 0xf) << 8) + ((slot | 0) & 0xff)) >>> 0;
}

// ---------------------------------------------------------------------------
// Module state + the four providers.
// ---------------------------------------------------------------------------

let _swamp = null;      // the init record, or null

const _stats = {
  inits: 0,
  fogBuilds: 0,
  fogFrames: 0,
  landblocks: 0,
  slotsRequested: 0,
  emittersCreated: 0,
  emitterCreateFailures: 0,
  regates: 0,
  gateStarts: 0,
  gateStops: 0,
  wispIgnitions: 0,
  wispFailures: 0,
  parks: 0,
  unparks: 0,
  gones: 0,
  destroyAllCalls: 0,
  noManager: 0,
};

/**
 * Landblock bookkeeping. lbKey → {lbKey, lbX, lbY, ownerKey, parked,
 *   eff: Map<effect, {slots, ids, live}>}
 * ONE record per LB shared by all three emitter providers — they gate
 * independently but they teardown together (one owner key).
 */
const _lbs = new Map();

/** Per-effect re-gate accumulators, indexed by EFFECT_*. */
const _regateAcc = [0, 0, 0];
/** Per-effect last gate reading, for diagnostics. */
const _lastGate = [0, 0, 0];

let _wispAcc = 0;
let _wispCounter = 0;

/** effect → the registered descriptor that plans its emitter. */
const _COMPONENT = [terrainMarshGas, terrainSwampFireflies, terrainSwampMidges];
/** effect → the anchor radius the descriptor is handed. */
const _ANCHOR_RADIUS = [
  SWAMP_TUNING.gasAnchorRadiusM,
  SWAMP_TUNING.fireflyAnchorRadiusM,
  SWAMP_TUNING.midgeAnchorRadiusM,
];
/** effect → diagnostic name. */
export const EFFECT_NAMES = Object.freeze(["gas", "fireflies", "midges", "wisp"]);

function _managerFor() {
  if (!_swamp) return null;
  try {
    const m = _swamp.getParticleManager ? _swamp.getParticleManager() : null;
    return m && typeof m.addEmitter === "function" ? m : null;
  } catch (_) { return null; }
}

function _envSnapshot() {
  if (!_swamp || typeof _swamp.readEnv !== "function") return null;
  try { return _swamp.readEnv(_swamp.scene3d) || null; } catch (_) { return null; }
}

/** Emitter parent frame for one slot. AC world coordinates, exactly like
 *  `terrain_sand.js::_devilParent` / `statics.js::_buildStaticParticleParent`
 *  (the static ParticleManager's scene is `staticsGroup`, same transform). */
function _slotParent(THREE, slot) {
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

/**
 * Plan + create the emitters for one landblock's slots of ONE effect.
 * Fire-and-forget: `addEmitter` is async and the owner registry is
 * EPOCH-GUARDED, so a create that resolves after the landblock was evicted
 * self-destroys.
 */
function _spawnEffect(rec, effect) {
  const e = rec.eff.get(effect);
  if (!e || e.slots.length === 0) return;
  const manager = _managerFor();
  if (!manager) { _stats.noManager += 1; return; }
  const env = _envSnapshot();
  const reg = _swamp.ownerRegistry;
  const comp = _COMPONENT[effect];
  const radius = _ANCHOR_RADIUS[effect];
  for (const slot of e.slots) {
    _stats.slotsRequested += 1;
    let specs = [];
    try {
      specs = comp.emit({
        anchor: {
          partIndex: -1,
          // The emitter is parented AT the slot, so the anchor centre is the
          // origin of that frame; the descriptor applies its own AC +Z lift.
          center: { x: 0, y: 0, z: 0 },
          radius,
        },
        env,
        seed: slot.seed,
        clock: _swamp.scene3d?.frameTime?.tsSec || 0,
        config: null,
      }) || [];
    } catch (_) { specs = []; }
    if (!Array.isArray(specs) || specs.length === 0) continue;   // gated out
    const spec = specs[0];
    const info = spec && spec.emitterInfo;
    if (!info || (info.hwGfxObjId >>> 0) === 0) continue;
    if (info.billboard === undefined) info.billboard = true;
    const req = {
      emitterInfo: info,
      parent: _slotParent(_swamp.THREE, slot),
      partIndex: -1,
      parentOffset: spec.parentOffset || null,
      emitterId: swampEmitterHandle(effect, slot.slot),
      blocking: false,
    };
    Promise.resolve()
      .then(() => reg.addEmitter(rec.ownerKey, manager, req))
      .then((id) => {
        if ((id >>> 0) !== 0) {
          e.ids.push(id >>> 0);
          _stats.emittersCreated += 1;
        } else {
          _stats.emitterCreateFailures += 1;
        }
      })
      .catch(() => { _stats.emitterCreateFailures += 1; });
  }
}

/** Stop (never destroy) one effect's emitters in one landblock. §2.2.2/§5.3:
 *  park and gate-out STOP emission; `.visible = false` is banned and
 *  `emitterCountForOwner` must be unchanged so restart is free. */
function _stopEffect(rec, effect) {
  const e = rec.eff.get(effect);
  if (!e) return;
  for (const slot of e.slots) {
    try { _swamp.ownerRegistry.stopEmitter(rec.ownerKey, swampEmitterHandle(effect, slot.slot)); }
    catch (_) { /* fail-soft */ }
  }
}

/**
 * Bring one effect in one landblock into agreement with its env gate.
 * Idempotent, and the ONLY place `live` flips.
 */
function _syncEffect(rec, effect, env) {
  const e = rec.eff.get(effect);
  if (!e || !_swamp) return;
  const comp = _COMPONENT[effect];
  let g = 1;
  try { g = comp.gateFn(env); } catch (_) { g = 0; }
  _lastGate[effect] = g;
  const want = !rec.parked && g > SWAMP_GATE_MIN;
  if (want === e.live) return;
  if (want) { _spawnEffect(rec, effect); e.live = true; _stats.gateStarts += 1; }
  else { _stopEffect(rec, effect); e.live = false; _stats.gateStops += 1; }
}

/** The slow re-gate for one effect across every resident landblock. Called from
 *  that effect's provider `update()`; see the module header for why. */
function _maybeRegate(dt, effect) {
  if (!_swamp) return false;
  _regateAcc[effect] += Number.isFinite(dt) ? dt : 0;
  if (_regateAcc[effect] < REGATE_SEC) return false;
  _regateAcc[effect] = 0;
  _stats.regates += 1;
  const env = _envSnapshot();
  for (const rec of _lbs.values()) _syncEffect(rec, effect, env);
  return true;
}

/**
 * THE WISP IGNITION (plan §3.5 item 2: "rare ignition — a ~2 s wisp — on a long
 * timer"). Picks one resident, unparked, LIVE gas vent and creates a FINITE
 * emitter over it; `particle_emitter.js:320` expires it after
 * `emitterInfo.totalSeconds` with no further bookkeeping from us.
 *
 * Deterministic in the sense that matters (§5.5 is about PLACEMENT): there is
 * no `Math.random` anywhere — the landblock and the vent are chosen by a
 * monotonic counter and the shared integer hash.
 */
function _igniteWisp() {
  if (!_swamp) return false;
  const manager = _managerFor();
  if (!manager) { _stats.noManager += 1; return false; }
  const candidates = [];
  for (const rec of _lbs.values()) {
    const e = rec.eff.get(EFFECT_GAS);
    if (!rec.parked && e && e.live && e.slots.length > 0) candidates.push(rec);
  }
  if (candidates.length === 0) return false;
  const n = _wispCounter++;
  const rec = candidates[n % candidates.length];
  const e = rec.eff.get(EFFECT_GAS);
  const pick = scatterHash01(rec.lbKey | 0, n, 9, _swamp.seed);
  const slot = e.slots[Math.min(e.slots.length - 1, Math.floor(pick * e.slots.length))];
  let specs = [];
  try {
    specs = terrainMarshGas.emit({
      anchor: { partIndex: -1, center: { x: 0, y: 0, z: 0 }, radius: SWAMP_TUNING.gasAnchorRadiusM },
      env: _envSnapshot(),
      seed: slot.seed ^ Math.imul(n + 1, 0x9e3779b9),
      config: { mode: "wisp" },
    }) || [];
  } catch (_) { specs = []; }
  if (specs.length === 0) return false;
  const spec = specs[0];
  const info = spec.emitterInfo;
  if (!info || (info.hwGfxObjId >>> 0) === 0) return false;
  if (info.billboard === undefined) info.billboard = true;
  // Rotate over a small handle set and clear the previous occupant first: a
  // finite emitter usually self-expired long ago, but re-using a live handle
  // would be ambiguous to the registry.
  const handle = swampEmitterHandle(EFFECT_WISP, n % SWAMP_TUNING.wispHandleSlots);
  try { _swamp.ownerRegistry.destroyEmitter(rec.ownerKey, handle); } catch (_) {}
  const req = {
    emitterInfo: info,
    parent: _slotParent(_swamp.THREE, slot),
    partIndex: -1,
    parentOffset: spec.parentOffset || null,
    emitterId: handle,
    blocking: false,
  };
  Promise.resolve()
    .then(() => _swamp.ownerRegistry.addEmitter(rec.ownerKey, manager, req))
    .then((id) => {
      if ((id >>> 0) !== 0) _stats.wispIgnitions += 1;
      else _stats.wispFailures += 1;
    })
    .catch(() => { _stats.wispFailures += 1; });
  return true;
}

/** Ensure the shared per-LB record exists (three providers share one). */
function _recordFor(ctx) {
  const lbKey = ctx.lbKey >>> 0;
  let rec = _lbs.get(lbKey);
  if (!rec) {
    rec = {
      lbKey,
      lbX: ctx.lbX | 0,
      lbY: ctx.lbY | 0,
      ownerKey: swampOwnerKeyForLb(lbKey),
      parked: false,
      eff: new Map(),
    };
    _lbs.set(lbKey, rec);
    _stats.landblocks += 1;
  }
  return rec;
}

/**
 * The shared landblock-scoped provider body. Gas, fireflies and midges differ
 * only in their flag, their tier key, their slot count and their hash channel —
 * so they are ONE factory, not three near-copies.
 */
function _emitterProvider(effect, cfg) {
  return {
    id: cfg.id,
    families: [FAM_SWAMP],
    scope: "landblock",
    enabled: cfg.enabled,
    quality(flags) {
      const q = resolveSwampQuality(flags);
      return q && cfg.countOf(q) > 0 ? q : null;
    },
    onLandblockReady(ctx) {
      if (!_swamp) return;
      // ⚠ `ctx.quality` here is ALREADY this provider's RESOLVED tier object
      // (`terrain_vfx.js::_ctxFor` stores `provider.quality(flags)`), whereas
      // `frameCtx.quality` in `update()` is the RAW flags bag. Same asymmetry
      // `terrain_sand.js`/`terrain_volcano.js` live with; read the resolved
      // field directly here and never re-resolve.
      const q = (ctx && ctx.quality) || null;
      const tierCount = q ? cfg.countOf(q) : 0;
      const count = tierCount > 0 ? tierCount : cfg.fallbackCount();
      if (count <= 0) return;
      const slots = swampSlotsForLandblock({
        lbKey: ctx.lbKey,
        lbX: ctx.lbX,
        lbY: ctx.lbY,
        codes: ctx.codes,
        heights: ctx.heights,
        count,
        seed: _swamp.seed,
        channel: effect,
      });
      if (slots.length === 0) return;
      // Refine z through the oracle when it is up (the exact split-diagonal
      // height rather than the nearest vertex). `ctx.oracle` is a LIVE getter
      // on the spine — read it, never stash it (wave-0 handoff §5).
      const oracle = _swamp.oracleRef();
      if (oracle && typeof oracle.heightAt === "function") {
        for (const s of slots) {
          const h = oracle.heightAt(s.x, s.y);
          if (Number.isFinite(h)) s.z = h;
        }
      }
      const rec = _recordFor(ctx);
      rec.eff.set(effect, { slots, ids: [], live: false });
      _syncEffect(rec, effect, _envSnapshot());
    },
    onLandblockPark(lbKey) {
      const rec = _lbs.get(lbKey >>> 0);
      if (!rec) return;
      if (!rec.parked) { rec.parked = true; _stats.parks += 1; }
      const e = rec.eff.get(effect);
      if (!e || !e.live) return;
      // PARK STOPS EMISSION — it never destroys (plan §2.2.2 / §5.3), so
      // `emitterCountForOwner` is unchanged and unpark is free.
      _stopEffect(rec, effect);
      e.live = false;
    },
    onLandblockUnpark(lbKey) {
      const rec = _lbs.get(lbKey >>> 0);
      if (!rec) return;
      if (rec.parked) { rec.parked = false; _stats.unparks += 1; }
      // Placement is hash-stable (§5.5), so everything comes back exactly where
      // it was — this is NOT a re-scatter.
      _syncEffect(rec, effect, _envSnapshot());
    },
    onLandblockGone(lbKey) {
      const rec = _lbs.get(lbKey >>> 0);
      if (!rec) return;
      const e = rec.eff.get(effect);
      if (e) {
        for (const slot of e.slots) {
          try { _swamp.ownerRegistry.destroyEmitter(rec.ownerKey, swampEmitterHandle(effect, slot.slot)); }
          catch (_) { /* fail-soft */ }
        }
        rec.eff.delete(effect);
      }
      _stats.gones += 1;
      // The LAST effect out sweeps the owner — this also reaps a wisp that was
      // mid-ignition, which per-handle destroys alone would miss.
      if (rec.eff.size === 0) {
        _lbs.delete(rec.lbKey);
        _stats.destroyAllCalls += 1;
        try { _swamp.ownerRegistry.destroyAllForOwner(rec.ownerKey); } catch (_) {}
      }
    },
    update(dt, frameCtx) {
      _maybeRegate(dt, effect);
      if (effect !== EFFECT_GAS) return;
      // The wisp timer rides the gas provider: a wisp is an ignition OF the gas.
      const q = resolveSwampQuality(frameCtx && frameCtx.quality);
      const wispsOn = terrainMarshWispsEnabled() && (!q || q.wisps);
      if (!wispsOn) { _wispAcc = 0; return; }
      _wispAcc += Number.isFinite(dt) ? dt : 0;
      if (_wispAcc < SWAMP_TUNING.wispPeriodSec) return;
      _wispAcc = 0;
      _igniteWisp();
    },
    dispose() {
      for (const rec of _lbs.values()) {
        try { _swamp?.ownerRegistry.destroyAllForOwner(rec.ownerKey); } catch (_) {}
      }
      _lbs.clear();
    },
  };
}

/** The camera-scoped ground fog. Immune to evict/park/rebake by construction
 *  (plan §2.2: a camera-scope provider owns one pool that follows the player). */
function _fogProvider() {
  return {
    id: FOG_PROVIDER_ID,
    families: [FAM_SWAMP],
    scope: "camera",
    enabled() { return terrainSwampEnabled() && terrainGroundFogEnabled(); },
    quality(flags) {
      const q = resolveSwampQuality(flags);
      return q && q.fogCount > 0 ? q : null;
    },
    update(dt, frameCtx) {
      if (!_swamp) return;
      if (!frameCtx || !frameCtx.hasPlayer) return;
      _stats.fogFrames += 1;
      if (!_swamp.fog) {
        const q = resolveSwampQuality(frameCtx.quality);
        const count = q && q.fogCount > 0 ? q.fogCount : terrainGroundFogCount();
        if (count <= 0) return;
        _swamp.fog = createGroundFog({
          THREE: _swamp.THREE,
          name: "terrain-swamp-fog",
          parent: _swamp.parent,
          // GETTER, never a snapshot — the oracle resolves lazily and a field
          // built before it landed must still come alive (wave-0 handoff §5).
          oracle: () => (_swamp ? _swamp.oracleRef() : null),
          // The family gate is what keeps fog OFF water (plan §3.8.1) and off
          // every non-marsh code: the pool writes a degenerate zero-scale
          // instance for anything that is not FAM_SWAMP.
          families: [FAM_SWAMP],
          count,
          radiusM: (q && q.fogRadiusM) || terrainGroundFogRadiusM(),
          softnessM: (q && q.fogSoftnessM) || terrainGroundFogSoftnessM(),
          seed: _swamp.seed ^ 0x60f0,
          tuning: SWAMP_FOG_PALETTE,
          cameraFar: frameCtx.camera && Number.isFinite(frameCtx.camera.far)
            ? frameCtx.camera.far : undefined,
        });
        _stats.fogBuilds += 1;
      }
      const cam = frameCtx.camera;
      if (cam && Number.isFinite(cam.far) && cam.far !== _swamp.fogCameraFar) {
        _swamp.fogCameraFar = cam.far;
        _swamp.fog.setCameraFar(cam.far);
      }
      const p = frameCtx.playerPos;
      _swamp.fog.update(dt, frameCtx.tSec, p.x, p.y, p.z);
    },
    dispose() {
      if (_swamp && _swamp.fog) { _swamp.fog.dispose(); _swamp.fog = null; }
    },
  };
}

/**
 * Construct + register the SWAMP family. Called once from `scene3d/index.js`
 * right after `initTerrainVolcano` (the spine must exist first — the providers
 * are replayed onto the already-resident ring by `registerTerrainVfx`).
 *
 * Returns `null` (registering nothing, allocating nothing) when the family
 * master is off — a bare-default boot is byte-identical.
 *
 * @param {object} opts
 * @param {object} [opts.THREE]    the three namespace (injected).
 * @param {object} opts.scene3d    the live facade.
 * @param {object} [opts.parent]   Object3D for the fog mesh; defaults to
 *   `terrainGroup.parent` (worldRoot) — a SIBLING of terrainGroup with the same
 *   transform, so the ring is in AC space and the LRU's terrainGroup scans
 *   cannot take it.
 * @param {Function} [opts.readEnv] `vfx/particle_env.js::readParticleEnv`
 *   (injected so this module stays THREE-free).
 * @param {Function} [opts.getParticleManager] defaults to the shared static
 *   ParticleManager (`scene3d._staticParticleManager`), whose scene is
 *   `staticsGroup` — the same AC frame the slot positions are in.
 * @param {object} [opts.ownerRegistry] the shared singleton by default.
 * @param {Function} [opts.getOracle] override for the terrain oracle.
 */
export function initTerrainSwamp(opts = {}) {
  const scene3d = opts.scene3d || null;
  if (!terrainSwampEnabled()) return null;         // ship-OFF master (plan §5.9)

  const fogOn = terrainGroundFogEnabled();
  const gasOn = terrainMarshGasEnabled();
  const firefliesOn = terrainSwampFirefliesEnabled();
  const midgesOn = terrainSwampMidgesEnabled();
  if (!fogOn && !gasOn && !firefliesOn && !midgesOn) return null;

  _swamp = {
    THREE: opts.THREE || null,
    scene3d,
    parent: opts.parent || scene3d?.terrainGroup?.parent || null,
    readEnv: typeof opts.readEnv === "function" ? opts.readEnv : null,
    getParticleManager: typeof opts.getParticleManager === "function"
      ? opts.getParticleManager
      : () => scene3d?._staticParticleManager || null,
    ownerRegistry: opts.ownerRegistry || defaultOwnerRegistry,
    seed: Number.isFinite(opts.seed) ? opts.seed | 0 : 0x5357414d,
    fog: null,
    fogCameraFar: 0,
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

  if (fogOn) _swamp.registered.push(registerTerrainVfx(_fogProvider()));
  if (gasOn) {
    _swamp.registered.push(registerTerrainVfx(_emitterProvider(EFFECT_GAS, {
      id: GAS_PROVIDER_ID,
      enabled: () => terrainSwampEnabled() && terrainMarshGasEnabled(),
      countOf: (q) => q.gasCount,
      fallbackCount: () => terrainMarshGasCount(),
    })));
  }
  if (firefliesOn) {
    _swamp.registered.push(registerTerrainVfx(_emitterProvider(EFFECT_FIREFLIES, {
      id: FIREFLY_PROVIDER_ID,
      enabled: () => terrainSwampEnabled() && terrainSwampFirefliesEnabled(),
      // One firefly swarm per swamp landblock: they are a wide-area ambience,
      // not a per-vertex feature, and each one is already a multi-particle
      // Swarm emitter.
      countOf: (q) => (q.fireflies ? 1 : 0),
      fallbackCount: () => 1,
    })));
  }
  if (midgesOn) {
    _swamp.registered.push(registerTerrainVfx(_emitterProvider(EFFECT_MIDGES, {
      id: MIDGE_PROVIDER_ID,
      enabled: () => terrainSwampEnabled() && terrainSwampMidgesEnabled(),
      countOf: (q) => (q.midges ? 1 : 0),
      fallbackCount: () => 1,
    })));
  }
  return terrainSwampSurface();
}

/** Diagnostics — mirrored onto `window.__terrainSwamp` by `scene3d/index.js`.
 *  Shape mirrors `terrain_sand.js::terrainSandStats`. */
export function terrainSwampStats() {
  const on = terrainSwampEnabled();
  return {
    enabled: on,
    groundFog: on && terrainGroundFogEnabled(),
    marshGas: on && terrainMarshGasEnabled(),
    wisps: on && terrainMarshGasEnabled() && terrainMarshWispsEnabled(),
    fireflies: on && terrainSwampFirefliesEnabled(),
    midges: on && terrainSwampMidgesEnabled(),
    inited: !!_swamp,
    swampCodes: swampTerrainCodes(),
    swampCodeMask: swampCodeBitmask(),
    seaSlimeIsSwamp: swampIncludesSeaSlime(),
    landblocks: _lbs.size,
    owners: [..._lbs.values()].map((r) => ({
      ownerKey: r.ownerKey,
      parked: r.parked,
      effects: [...r.eff.entries()].map(([effect, e]) => ({
        effect: EFFECT_NAMES[effect],
        slots: e.slots.length,
        ids: e.ids.length,
        live: e.live,
      })),
      live: (() => {
        try { return _swamp ? _swamp.ownerRegistry.emitterCountForOwner(r.ownerKey) : 0; }
        catch (_) { return 0; }
      })(),
    })),
    gates: {
      gas: _lastGate[EFFECT_GAS],
      fireflies: _lastGate[EFFECT_FIREFLIES],
      midges: _lastGate[EFFECT_MIDGES],
    },
    fog: _swamp && _swamp.fog ? _swamp.fog.stats() : null,
    counters: { ..._stats },
  };
}

function terrainSwampSurface() {
  return {
    stats: terrainSwampStats,
    get fog() { return _swamp ? _swamp.fog : null; },
    get landblocks() { return [..._lbs.keys()]; },
    /** 1070 seam: arm the fog's scene-depth soft-particle read by hand. See
     *  `ground_fog.js`'s header for why this is not wired automatically. */
    setFogSceneDepthTexture(tex) {
      return _swamp && _swamp.fog ? _swamp.fog.setSceneDepthTexture(tex) : false;
    },
    /** 1070 seam: force a wisp now rather than waiting out the long timer. */
    igniteWisp() { return _igniteWisp(); },
    lbKeyFromXY,
  };
}

/** Test seam — unregister every provider and drop all state. */
export function _resetTerrainSwamp() {
  if (_swamp) {
    for (const h of _swamp.registered) {
      try { unregisterTerrainVfx(h.id); } catch (_) {}
    }
    if (_swamp.fog) { try { _swamp.fog.dispose(); } catch (_) {} }
  }
  _lbs.clear();
  _regateAcc[0] = _regateAcc[1] = _regateAcc[2] = 0;
  _lastGate[0] = _lastGate[1] = _lastGate[2] = 0;
  _wispAcc = 0;
  _wispCounter = 0;
  _swamp = null;
  for (const k of Object.keys(_stats)) _stats[k] = 0;
}

export { SWAMP_GATE_MIN };
