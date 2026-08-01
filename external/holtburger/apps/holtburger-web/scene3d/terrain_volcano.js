// scene3d/terrain_volcano.js — VOLCANO / OBSIDIAN terrain VFX (Wave 2B).
//
// Design plan: `docs/2026-07-31-terrain-vfx-plan.md` §3.6. Terrain codes 6
// (`ObsidianPlain`), 25 (`Volcano1`) and 26 (`Volcano2`) = `FAM_VOLCANO` —
// derived from `terrain_families.js`, never hardcoded here (plan §8 risk 12:
// family membership is a property of the CODE, and another region could name
// the same code differently).
//
// THE LOOK (plan §3.6): dangerous. Heat visibly distorting the air, embers
// lifting and dying, a dull red glow breathing in the cracks underfoot,
// obsidian glassy-black with a hard specular edge.
//
// FOUR EFFECTS, THREE OWNERS:
//   1. HEAT SHIMMER — the Effect lives in `vfx/heat_haze_effect.js` (it needs
//      THREE + `postprocessing`); THIS file owns the per-frame state it reads
//      (`HEAT_HAZE_STATE`) and the landblock bookkeeping that decides whether
//      any volcanic ground is resident at all. The Effect is inserted into the
//      EXISTING `EffectPass` in `atmosphere_pipeline.js` — never a new pass.
//   2. EMBERS — here (lifecycle) + `vfx/components/terrainVolcanoEmbers.js`
//      (the registered, lint-passing descriptor, which RE-ANCHORS
//      `brazierEmbers.js`'s own builders rather than forking them).
//   3. CRACK GLOW + OBSIDIAN SPECULAR — in the TERRAIN FRAGMENT SHADER
//      (`terrain.js`, search `VOLCANO CRACK GLOW`), gated on FAM_VOLCANO read
//      from `uVertexTypes` (plan trap T3 — the subdiv path IGNORES the
//      `terrainCode` geometry attribute), sited after the POM `cellUv` offset
//      and bypassed on any water-touching cell (plan §2.7.3). NOT in this file;
//      this file owns the code masks, the breathing oscillator's identity and
//      the flag surface.
//   4. ASH FALL — DELIBERATELY NOT IMPLEMENTED. See ASH, below.
//
// ASH (plan §3.6 item 4 / §8 risk 9). The plan says to parameterise
// `weather/snow.js SnowSystem` rather than write a third falling-particle
// system, and to note it and move on if that proves invasive. It is invasive:
// `SnowSystem` seeds and re-seeds every particle through TEN `Math.random()`
// calls (directly against the §5.5 determinism invariant every terrain-VFX
// effect is held to), it is constructed and disposed by `weather/manager.js`
// keyed on the active weather profile's `temperature_C` rather than on terrain,
// and there is no notion of a terrain gate anywhere under `scene3d/weather/`.
// Making it carry ash means a seeded PRNG, a second construction/ownership path
// in the manager, and a terrain-family dependency inside the weather stack —
// for one ultra-only effect, against an explicit owner deferral on refactoring.
// Wave 2B therefore ships NO ash: no flag, no preset key, no dead config.
//
// INJECTED THREE (the `terrain_vfx.js` / `terrain_sand.js` idiom). This module
// imports no three: `initTerrainVolcano({THREE, scene3d, ...})` takes it, and
// every GPU object is optional. That is what keeps `test_terrain_volcano.mjs` a
// pure-node test and what makes `?nullRender=1` free. The camera projection
// below is deliberately hand-rolled over `camera.projectionMatrix.elements` for
// the same reason — a `Vector3.project()` would drag THREE in here.
//
// INVARIANTS (plan §5). A HOST module, not a registered VFX component: it is
// not swept by `vfx/lint_caps.js` (the DESCRIPTOR next door is). It obeys the
// firewall anyway — it reads static terrain, a server-derived player position,
// the shared clock and the camera, and writes only its own state object and
// synthesized emitters. It adds NO LIGHT (§5.2 — embers are additive sprites,
// never a PointLight), varies no program cache key (§5.4), uses no
// `Math.random` (§5.5) and binds the clock by reference (§5.6).
//
// FLAGS (plan §2.4, all STRICT `=== "on"` opt-ins that ship OFF):
//   ?terrainVolcano    family master (also `?terrainVfx=off`, `?visual=off`
//                                     and `?wireframe=1` kill everything)
//   ?terrainHaze  ?terrainEmbers  ?terrainCrackGlow
//   ?terrainVolcanoEmberCount  ?terrainHazeStrength  ?terrainVolcanoRadius

import {
  FAM_VOLCANO,
  TERRAIN_CODE_COUNT,
  familyForCode,
} from "./terrain_families.js";
import { scatterHash01 } from "./terrain_scatter.js";
import { registerTerrainVfx, unregisterTerrainVfx, lbKeyFromXY } from "./terrain_vfx.js";
import {
  terrainVolcanoEnabled,
  terrainHazeEnabled,
  terrainEmbersEnabled,
  terrainCrackGlowEnabled,
  terrainVolcanoEmberCount,
  terrainHazeStrength,
  terrainVolcanoRadiusM,
} from "./vfx_flags.js";
import { registerOscillator, unregisterOscillator, sampleWave } from "./vfx/oscillators.js";
import { staticOwnerKeyForLb } from "./vfx/particle_attach.js";
import { ownerRegistry as defaultOwnerRegistry } from "./particles/owner_registry.js";
import { terrainVolcanoEmbers, VENT_GATE_MIN } from "./vfx/components/terrainVolcanoEmbers.js";

export const METERS_PER_LANDBLOCK = 192;
export const VERTEX_GRID = 9;
export const VERTEX_SPACING_M = 24;

/** Provider ids — also the `VFX_EFFECT_FLAGS` router rows. `EMBER_PROVIDER_ID`
 *  is additionally the registered component id of the ember descriptor. */
export const HAZE_PROVIDER_ID = "terrain.volcanoHaze";
export const EMBER_PROVIDER_ID = "terrain.volcanoEmbers";

/**
 * `LandDefs::TerrainType::ObsidianPlain` (`ac-headers/acclient.h` ≈:4112).
 *
 * The obsidian material is CODE 6 ONLY (plan §3.6 item 5), not the whole
 * family: `Volcano1`/`Volcano2` are cracked rock, `ObsidianPlain` is glass.
 * Codes 0..0x14 are NAMED in the shipped retail executable's enum, so 6 IS
 * ObsidianPlain engine-wide — this is a retail-enum constant, not a name match
 * against the Dereth palette (which plan §8 risk 12 forbids).
 */
export const TERRAIN_CODE_OBSIDIAN_PLAIN = 6;

// ---------------------------------------------------------------------------
// Pure helpers — no THREE, no window. The directly-tested surface.
// ---------------------------------------------------------------------------

/** The terrain codes that are FAM_VOLCANO, DERIVED from the family LUT. */
export function volcanoTerrainCodes() {
  const out = [];
  for (let c = 0; c < TERRAIN_CODE_COUNT; c += 1) {
    if (familyForCode(c) === FAM_VOLCANO) out.push(c);
  }
  return out;
}

/** The same set as a GPU bitmask (the `computeCodeBitmask` convention). */
export function volcanoCodeBitmask() {
  let mask = 0;
  for (const c of volcanoTerrainCodes()) mask |= (1 << c);
  return mask >>> 0;
}

/** The obsidian mask — code 6 alone (see `TERRAIN_CODE_OBSIDIAN_PLAIN`). */
export function obsidianCodeBitmask() {
  return (1 << TERRAIN_CODE_OBSIDIAN_PLAIN) >>> 0;
}

/** Tuning that is NOT worth a URL flag. */
export const VOLCANO_TUNING = Object.freeze({
  // Ember vents: in-cell placement jitter (the cell is 24 m) and the height the
  // vent sits above the sampled ground.
  ventJitterM: 14,
  ventLiftM: 0.15,
  // Heat haze depth band, as a fraction of the heat radius. The shimmer only
  // touches pixels whose eye-forward distance is inside
  // [centreDist - radius*bandNear, centreDist + radius*bandFar]; anything in
  // front (a tree, the player's own mount) stays crisp, and the sky never warps
  // because the raw-depth read rejects it outright.
  hazeBandNear: 1.0,
  hazeBandFar: 1.35,
  hazeFeatherFrac: 0.4,
  // When the player is INSIDE the heat radius the centre can project behind the
  // camera, so the projected disc is useless. Fall back to a large low-frame
  // disc: heat rises off the ground you are standing on.
  hazeInsideUv: Object.freeze({ u: 0.5, v: 0.38 }),
  hazeInsideRadiusUv: 1.6,
  // Clamp on the projected screen radius so a distant vent cannot end up warping
  // a single pixel (invisible) or the whole frame (a wobbling world).
  hazeMinScreenRadiusUv: 0.02,
  hazeMaxScreenRadiusUv: 1.8,
  // Hard engagement ceiling on the player→field distance. `_hazeLbs` residency
  // is LRU-driven (park/gone), and the LRU parks on capacity pressure, not
  // distance — after a teleport a volcanic LB can stay cached for minutes,
  // and the min-screen-radius clamp above then pins a full-strength shimmer
  // blob on screen from ANYWHERE on the map (live-repro 2026-08-01: lbKey
  // 0xC8ED0000 still driving haze from Holtburg, 10 km away). 8 LBs covers
  // every legitimate approach sightline; past that the state clears.
  hazeMaxEngageM: 1536,
});

// ---------------------------------------------------------------------------
// The crack-glow breathing oscillator (plan §3.6 item 3).
//
// Registered in the SHARED `vfx/oscillators.js` registry, i.e. the same O(1)
// per-frame tick every other VFX channel rides, driven from the same clock as
// `terrain.js`'s `uTime` push (`loop.js`). `tickOscillators` wraps that clock at
// 3600 s to bound float32 drift and is phase-continuous for any waveform at
// ≤ 1 Hz — 0.07 Hz (a ~14 s breath) is comfortably inside that.
//
// ⚠ WHY THE VALUE IS PUSHED, NOT BOUND BY REFERENCE. The obvious wiring is to
// hand the oscillator a `{value}` object and bind THAT object into every terrain
// material. It does not work: `terrain_batch.js` builds the batched material by
// CLONING each uniform's value into a FRESH `{value}` object, and
// `?terrainBatch=on` is DEFAULT-ON — so the batched path would silently freeze
// the breath at whatever it read at bake time. `loop.js::tickTerrainUTime`
// therefore walks `scene3d.terrainMaterials` and writes `uCrackGlowBreath` the
// same way it writes `uTime` and the way `tickTerrainSunDir` writes `uSunDir`.
// ---------------------------------------------------------------------------

export const CRACK_GLOW_OSC_NAME = "terrain.volcanoCrackGlow";

/** Kind + config for the breathing oscillator. Range = bias ± amp = 0.44..1.0,
 *  period 1/0.07 ≈ 14.3 s. Frozen so a caller cannot mutate the shared spec. */
export const CRACK_GLOW_OSC_SPEC = Object.freeze({
  kind: "sine",
  config: Object.freeze({ freq: 0.07, amp: 0.28, bias: 0.72, phase: 0 }),
});

/** The breath value at clock `tSec` — the pure twin of what the registered
 *  oscillator writes, for tests and for the no-oscillator fallback. */
export function crackGlowBreathAt(tSec) {
  const t = (Number.isFinite(tSec) ? tSec : 0) % 3600;
  return sampleWave(CRACK_GLOW_OSC_SPEC.kind, t, CRACK_GLOW_OSC_SPEC.config);
}

// ---------------------------------------------------------------------------
// The heat-haze state — the ONE object `vfx/heat_haze_effect.js` reads.
//
// Plain numbers, no THREE, written in place (never replaced) so the Effect can
// hold it by reference forever. All-zero is the DISABLED state and is what a
// bare-default boot leaves it at, so an Effect that somehow got constructed with
// the flag off still warps nothing.
// ---------------------------------------------------------------------------

export const HEAT_HAZE_STATE = {
  /** 1 when a volcanic landblock is resident AND the tier/flags want haze. */
  enabled: 0,
  /** Heat centre, AC world metres (+X east, +Y north, +Z up). */
  centerX: 0, centerY: 0, centerZ: 0,
  /** Heat radius, AC metres. **0 whenever no volcanic LB is resident.** */
  radiusM: 0,
  /** Screen-space mask (uv units) — the projected heat disc. */
  screenU: 0.5, screenV: 0.5, screenRadiusUv: 0,
  /** Eye-forward depth band, metres. */
  nearM: 0, farM: 0, featherM: 1,
  /** Warp amplitude multiplier (`?terrainHazeStrength` × tier). */
  strength: 0,
  /** Diagnostics. */
  lbKey: 0, residentLbs: 0, insideFactor: 0, frames: 0,
};

/** Reset the haze state to its inert all-zero form. */
export function clearHeatHazeState() {
  HEAT_HAZE_STATE.enabled = 0;
  HEAT_HAZE_STATE.centerX = 0;
  HEAT_HAZE_STATE.centerY = 0;
  HEAT_HAZE_STATE.centerZ = 0;
  HEAT_HAZE_STATE.radiusM = 0;
  HEAT_HAZE_STATE.screenU = 0.5;
  HEAT_HAZE_STATE.screenV = 0.5;
  HEAT_HAZE_STATE.screenRadiusUv = 0;
  HEAT_HAZE_STATE.nearM = 0;
  HEAT_HAZE_STATE.farM = 0;
  HEAT_HAZE_STATE.featherM = 1;
  HEAT_HAZE_STATE.strength = 0;
  HEAT_HAZE_STATE.lbKey = 0;
  HEAT_HAZE_STATE.residentLbs = 0;
  HEAT_HAZE_STATE.insideFactor = 0;
  return HEAT_HAZE_STATE;
}

/**
 * Project an AC-space point through a three.js camera to uv + eye distance.
 *
 * PURE and THREE-free: it reads only `camera.projectionMatrix.elements` and
 * `camera.matrixWorldInverse.elements` (column-major, `e[col*4 + row]` — the
 * three.js convention), so a node test can hand it a POJO camera.
 *
 * The frame bridge is the one the whole client uses: `worldRoot` carries
 * `rotation.x = -PI/2`, so AC `(x, y, z)` is three world `(x, z, -y)`
 * (`adapter.js::acToThree`).
 *
 * @param {{projectionMatrix:{elements:ArrayLike<number>},
 *          matrixWorldInverse:{elements:ArrayLike<number>}}} camera
 * @param {number} ax AC east
 * @param {number} ay AC north
 * @param {number} az AC up
 * @param {{u:number,v:number,distM:number,behind:boolean,ndcScaleY:number}} [out]
 * @returns {object|null} null when the camera has no usable matrices.
 */
export function projectAcPointToUv(camera, ax, ay, az, out) {
  const pe = camera && camera.projectionMatrix ? camera.projectionMatrix.elements : null;
  const ve = camera && camera.matrixWorldInverse ? camera.matrixWorldInverse.elements : null;
  if (!pe || !ve || pe.length < 16 || ve.length < 16) return null;
  const o = out || { u: 0, v: 0, distM: 0, behind: true, ndcScaleY: 1 };
  // AC -> three world.
  const wx = ax, wy = az, wz = -ay;
  // view = matrixWorldInverse * world
  const vx = ve[0] * wx + ve[4] * wy + ve[8] * wz + ve[12];
  const vy = ve[1] * wx + ve[5] * wy + ve[9] * wz + ve[13];
  const vz = ve[2] * wx + ve[6] * wy + ve[10] * wz + ve[14];
  // clip = projectionMatrix * view
  const cx = pe[0] * vx + pe[4] * vy + pe[8] * vz + pe[12];
  const cy = pe[1] * vx + pe[5] * vy + pe[9] * vz + pe[13];
  const cw = pe[3] * vx + pe[7] * vy + pe[11] * vz + pe[15];
  // Eye-forward distance: three cameras look down -Z, so it is -vz.
  o.distM = -vz;
  o.behind = !(cw > 1e-4) || !(o.distM > 1e-4);
  o.ndcScaleY = pe[5];          // = 1 / tan(fovY / 2) for a perspective camera
  if (o.behind) { o.u = 0.5; o.v = 0.5; return o; }
  o.u = (cx / cw) * 0.5 + 0.5;
  o.v = (cy / cw) * 0.5 + 0.5;
  return o;
}

/**
 * Resolve the live VOLCANO quality tier. `null` ⇒ the whole family is disabled
 * at this tier (plan §5.8: "`low` is null/disabled for every effect here without
 * exception"). Pure in `flags`.
 *
 * @param {object|null} flags `liveScene3d.quality.flags`-shaped bag.
 * @returns {{emberCount:number, hazeStrength:number, hazeRadiusM:number,
 *   crackGlow:boolean}|null}
 */
export function resolveVolcanoQuality(flags) {
  const num = (v, def) => (Number.isFinite(Number(v)) ? Number(v) : def);
  const emberCount = Math.max(0, Math.round(num(flags?.terrainVolcanoEmberCount, 0)));
  const hazeStrength = Math.max(0, Math.min(4, num(flags?.terrainHazeStrength, 0)));
  const hazeRadiusM = Math.max(0, Math.min(1024, num(flags?.terrainVolcanoRadius, 0)));
  const crackGlow = flags?.terrainCrackGlow === true;
  if (emberCount === 0 && !crackGlow && (hazeStrength === 0 || hazeRadiusM === 0)) return null;
  return { emberCount, hazeStrength, hazeRadiusM, crackGlow };
}

/**
 * Hash-stable ember-vent placements for one landblock.
 *
 * PURE and deterministic in `(lbKey, codes, heights, count, seed)` — the whole
 * point (plan §5.5): park/unpark, rebake, walk away and come back, and the same
 * vent stands in the same place. Vents are placed ONLY on FAM_VOLCANO vertices,
 * so a landblock with one volcanic corner gets its vent on the lava.
 *
 * `codes` and `heights` are the LB's 81-entry COLUMN-MAJOR grids
 * (`idx = vx * 9 + vy`, `terrain.js` userData / `LandblockMesh`).
 *
 * Structurally identical to `terrain_sand.js::devilSlotsForLandblock` on
 * purpose — same determinism contract, same distinct-vertex walk, same clamp
 * into the landblock so a vent on an edge vertex cannot drift into a neighbour
 * we know nothing about.
 *
 * @param {{lbKey:number, lbX:number, lbY:number, codes:ArrayLike<number>,
 *   heights?:ArrayLike<number>|null, count:number, seed?:number}} opts
 * @returns {Array<{slot:number, x:number, y:number, z:number, vx:number,
 *   vy:number, code:number, seed:number}>}
 */
export function ventSlotsForLandblock(opts = {}) {
  const codes = opts.codes;
  const count = Math.max(0, Math.min(8, opts.count | 0));
  if (!codes || count === 0) return [];
  const lbKey = opts.lbKey >>> 0;
  const lbX = opts.lbX | 0;
  const lbY = opts.lbY | 0;
  const heights = opts.heights || null;
  const seed = (Number.isFinite(opts.seed) ? opts.seed : 0x5601ca70) | 0;

  const volcIdx = [];
  const n = Math.min(codes.length, VERTEX_GRID * VERTEX_GRID);
  for (let i = 0; i < n; i += 1) {
    if (familyForCode(codes[i]) === FAM_VOLCANO) volcIdx.push(i);
  }
  if (volcIdx.length === 0) return [];

  const out = [];
  const used = new Set();
  for (let slot = 0; slot < count; slot += 1) {
    const pick = scatterHash01(lbKey | 0, slot, 1, seed);
    let k = Math.min(volcIdx.length - 1, Math.floor(pick * volcIdx.length));
    let guard = 0;
    while (used.has(volcIdx[k]) && guard < volcIdx.length) {
      k = (k + 1) % volcIdx.length;
      guard += 1;
    }
    if (used.has(volcIdx[k])) break;   // fewer volcanic vertices than vents
    used.add(volcIdx[k]);
    const idx = volcIdx[k];
    const vx = (idx / VERTEX_GRID) | 0;
    const vy = idx % VERTEX_GRID;
    const jx = (scatterHash01(lbKey | 0, slot, 2, seed) - 0.5) * VOLCANO_TUNING.ventJitterM;
    const jy = (scatterHash01(lbKey | 0, slot, 3, seed) - 0.5) * VOLCANO_TUNING.ventJitterM;
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
      seed: ((lbKey ^ Math.imul(slot + 1, 0x85ebca6b)) >>> 0),
    });
  }
  return out;
}

/**
 * The owner key a landblock's ember vents register under.
 *
 * DERIVED from `vfx/particle_attach.js::staticOwnerKeyForLb` (the single source
 * of truth for the per-LB owner key) with a `:volcano` scope appended — exactly
 * the decision wave 1B made for `:sand`, for exactly the same reason.
 *
 * ⚠ WHY THE SUFFIX. The teardown API is `destroyAllForOwner(ownerKey)`, and this
 * provider's `onLandblockGone` fires for a terrain LOD REBAKE as well as for an
 * evict (`terrain_vfx.js` deliberately delivers a rebake as gone-then-ready). A
 * rebake does NOT rebuild statics — so calling `destroyAllForOwner("static:N")`
 * there would silently reap every brazier/foliage emitter in the landblock and
 * never bring them back. The suffix keeps the derivation (change the static
 * scheme and this changes with it) while making the teardown exact.
 *
 * @param {number} landblockIdOrLbKey
 */
export function volcanoOwnerKeyForLb(landblockIdOrLbKey) {
  return `${staticOwnerKeyForLb(landblockIdOrLbKey)}:volcano`;
}

/** The scoped emitter handle for vent `slot`'s `which`-th spec (0 = embers,
 *  1 = smoke). Never 0, so `ownerRegistry.stopEmitter` can find it at park. */
export function ventEmitterHandle(slot, which) {
  return (0x5601_0000 + (((slot | 0) & 0xff) << 4) + ((which | 0) & 0xf)) >>> 0;
}

// ---------------------------------------------------------------------------
// Module state + the two providers.
// ---------------------------------------------------------------------------

let _volc = null;       // the init record, or null

const _stats = {
  inits: 0,
  hazeFrames: 0,
  hazeClears: 0,
  oscillatorRegistrations: 0,
  ventLandblocks: 0,
  ventsRequested: 0,
  ventsCreated: 0,
  ventCreateFailures: 0,
  parks: 0,
  unparks: 0,
  gones: 0,
  destroyAllCalls: 0,
  noManager: 0,
};

/** Landblock-scoped vent bookkeeping: lbKey → {ownerKey, slots, ids, parked}. */
const _ventLbs = new Map();

/**
 * Resident volcanic landblocks, for the haze: lbKey → {x, y, z}, the LB centre
 * in AC metres with the mean volcanic-vertex height.
 *
 * ⚠ PARK REMOVES an LB from this map and unpark puts it back. A parked LB's
 * terrain mesh is detached from `terrainGroup` — it is not on screen — so it
 * must not hold the shimmer up. This is what makes "uHeatRadius → 0 whenever no
 * volcanic LB is resident" true in the park case as well as the evict case.
 */
const _hazeLbs = new Map();

const _proj = { u: 0, v: 0, distM: 0, behind: true, ndcScaleY: 1 };

function _managerFor() {
  if (!_volc) return null;
  try {
    const m = _volc.getParticleManager ? _volc.getParticleManager() : null;
    return m && typeof m.addEmitter === "function" ? m : null;
  } catch (_) { return null; }
}

function _envSnapshot() {
  if (!_volc || typeof _volc.readEnv !== "function") return null;
  try { return _volc.readEnv(_volc.scene3d) || null; } catch (_) { return null; }
}

/** Emitter parent frame for one vent. AC world coordinates, exactly like
 *  `terrain_sand.js::_devilParent` / `statics.js::_buildStaticParticleParent`
 *  (the static ParticleManager's scene is `staticsGroup`, same transform). */
function _ventParent(THREE, slot) {
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
 * Create (or replace) the emitters for one landblock's vents. Fire-and-forget:
 * `addEmitter` is async and the owner registry is EPOCH-GUARDED, so a create
 * that resolves after the landblock was evicted self-destroys.
 */
function _spawnVents(rec) {
  const manager = _managerFor();
  if (!manager) { _stats.noManager += 1; return; }
  const env = _envSnapshot();
  const reg = _volc.ownerRegistry;
  for (const slot of rec.slots) {
    _stats.ventsRequested += 1;
    let specs = [];
    try {
      specs = terrainVolcanoEmbers.emit({
        anchor: {
          partIndex: -1,
          // The emitter is parented AT the vent, so the anchor centre is the
          // origin of that frame.
          center: { x: 0, y: 0, z: 0 },
        },
        env,
        seed: slot.seed,
        clock: _volc.scene3d?.frameTime?.tsSec || 0,
        config: null,
      }) || [];
    } catch (_) { specs = []; }
    if (!Array.isArray(specs) || specs.length === 0) continue;   // gated out
    for (let which = 0; which < specs.length; which += 1) {
      const spec = specs[which];
      const info = spec && spec.emitterInfo;
      if (!info || (info.hwGfxObjId >>> 0) === 0) continue;
      if (info.billboard === undefined) info.billboard = true;
      const req = {
        emitterInfo: info,
        parent: _ventParent(_volc.THREE, slot),
        partIndex: -1,
        parentOffset: spec.parentOffset || null,
        emitterId: ventEmitterHandle(slot.slot, which),
        blocking: false,
      };
      Promise.resolve()
        .then(() => reg.addEmitter(rec.ownerKey, manager, req))
        .then((id) => {
          if ((id >>> 0) !== 0) {
            rec.ids.push(id >>> 0);
            _stats.ventsCreated += 1;
          } else {
            _stats.ventCreateFailures += 1;
          }
        })
        .catch(() => { _stats.ventCreateFailures += 1; });
    }
  }
}

/** Mean AC-space centre of an LB's FAM_VOLCANO vertices — the haze anchor. */
export function volcanoCentreOfLandblock(lbX, lbY, codes, heights) {
  if (!codes) return null;
  let sx = 0, sy = 0, sz = 0, n = 0;
  const len = Math.min(codes.length, VERTEX_GRID * VERTEX_GRID);
  for (let i = 0; i < len; i += 1) {
    if (familyForCode(codes[i]) !== FAM_VOLCANO) continue;
    const vx = (i / VERTEX_GRID) | 0;
    const vy = i % VERTEX_GRID;
    sx += vx * VERTEX_SPACING_M;
    sy += vy * VERTEX_SPACING_M;
    sz += heights && Number.isFinite(heights[i]) ? heights[i] : 0;
    n += 1;
  }
  if (n === 0) return null;
  return {
    x: (lbX | 0) * METERS_PER_LANDBLOCK + sx / n,
    y: (lbY | 0) * METERS_PER_LANDBLOCK + sy / n,
    z: sz / n,
  };
}

/**
 * THE haze state write. Pure-ish: reads `_hazeLbs`, the tier and the frame
 * context; writes only `HEAT_HAZE_STATE` in place.
 *
 * ⚠ THE CONTRACT (plan §3.6, test-asserted): with NO volcanic landblock
 * resident, `radiusM` — and therefore the Effect's `uHeatRadius` — is ZERO.
 * Otherwise the distortion follows the player out of the region.
 */
export function updateHeatHazeState(quality, playerPos, camera) {
  const q = quality;
  const hazeOn = !!q && q.hazeStrength > 0 && q.hazeRadiusM > 0;
  if (!hazeOn || _hazeLbs.size === 0 || !playerPos) {
    if (HEAT_HAZE_STATE.radiusM !== 0 || HEAT_HAZE_STATE.enabled !== 0) _stats.hazeClears += 1;
    clearHeatHazeState();
    HEAT_HAZE_STATE.residentLbs = _hazeLbs.size;
    return HEAT_HAZE_STATE;
  }
  // Nearest resident volcanic landblock (plan §3.6 "v1 takes uHeatCenter /
  // uHeatRadius (the nearest volcanic LB)"). Linear over a set bounded by the
  // 13x13 ring, and only over the VOLCANIC members of it.
  let best = null, bestKey = 0, bestD2 = Infinity;
  for (const [lbKey, c] of _hazeLbs) {
    const dx = c.x - playerPos.x;
    const dy = c.y - playerPos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) { bestD2 = d2; best = c; bestKey = lbKey; }
  }
  if (!best) {
    clearHeatHazeState();
    return HEAT_HAZE_STATE;
  }
  const radius = q.hazeRadiusM;
  const dist = Math.sqrt(bestD2);
  // Distance gate (see VOLCANO_TUNING.hazeMaxEngageM): LRU residency is not
  // distance-bounded, so a far-away cached field must not hold the shimmer up.
  if (dist > VOLCANO_TUNING.hazeMaxEngageM) {
    if (HEAT_HAZE_STATE.radiusM !== 0 || HEAT_HAZE_STATE.enabled !== 0) _stats.hazeClears += 1;
    clearHeatHazeState();
    HEAT_HAZE_STATE.residentLbs = _hazeLbs.size;
    return HEAT_HAZE_STATE;
  }
  const inside = Math.max(0, Math.min(1, 1 - dist / radius));

  HEAT_HAZE_STATE.enabled = 1;
  HEAT_HAZE_STATE.centerX = best.x;
  HEAT_HAZE_STATE.centerY = best.y;
  HEAT_HAZE_STATE.centerZ = best.z;
  HEAT_HAZE_STATE.radiusM = radius;
  HEAT_HAZE_STATE.strength = q.hazeStrength;
  HEAT_HAZE_STATE.lbKey = bestKey >>> 0;
  HEAT_HAZE_STATE.residentLbs = _hazeLbs.size;
  HEAT_HAZE_STATE.insideFactor = inside;
  HEAT_HAZE_STATE.frames += 1;

  const p = projectAcPointToUv(camera, best.x, best.y, best.z, _proj);
  const insideRadius = inside * VOLCANO_TUNING.hazeInsideRadiusUv;
  if (!p || p.behind) {
    // Centre off-camera. Only the "standing in it" fallback survives.
    HEAT_HAZE_STATE.screenU = VOLCANO_TUNING.hazeInsideUv.u;
    HEAT_HAZE_STATE.screenV = VOLCANO_TUNING.hazeInsideUv.v;
    HEAT_HAZE_STATE.screenRadiusUv = insideRadius;
    HEAT_HAZE_STATE.nearM = 0;
    HEAT_HAZE_STATE.farM = radius * VOLCANO_TUNING.hazeBandFar;
    HEAT_HAZE_STATE.featherM = Math.max(1, radius * VOLCANO_TUNING.hazeFeatherFrac);
    return HEAT_HAZE_STATE;
  }
  // uv radius of a `radius`-metre sphere at `distM`: ndc half-height is
  // radius * (1/tan(fovY/2)) / dist, and uv = ndc * 0.5.
  const projRadius = 0.5 * radius * p.ndcScaleY / Math.max(p.distM, 1e-3);
  const r = Math.max(
    Math.min(Math.max(projRadius, insideRadius), VOLCANO_TUNING.hazeMaxScreenRadiusUv),
    VOLCANO_TUNING.hazeMinScreenRadiusUv,
  );
  // Blend the projected centre toward the low-frame fallback as the player walks
  // into the field, so there is no pop when the centre crosses behind the eye.
  HEAT_HAZE_STATE.screenU = p.u * (1 - inside) + VOLCANO_TUNING.hazeInsideUv.u * inside;
  HEAT_HAZE_STATE.screenV = p.v * (1 - inside) + VOLCANO_TUNING.hazeInsideUv.v * inside;
  HEAT_HAZE_STATE.screenRadiusUv = r;
  HEAT_HAZE_STATE.nearM = Math.max(0, p.distM - radius * VOLCANO_TUNING.hazeBandNear);
  HEAT_HAZE_STATE.farM = p.distM + radius * VOLCANO_TUNING.hazeBandFar;
  HEAT_HAZE_STATE.featherM = Math.max(1, radius * VOLCANO_TUNING.hazeFeatherFrac);
  return HEAT_HAZE_STATE;
}

function _hazeProvider() {
  return {
    id: HAZE_PROVIDER_ID,
    families: [FAM_VOLCANO],
    scope: "landblock",
    enabled() { return terrainVolcanoEnabled() && terrainHazeEnabled(); },
    quality(flags) {
      const q = resolveVolcanoQuality(flags);
      return q && q.hazeStrength > 0 && q.hazeRadiusM > 0 ? q : null;
    },
    onLandblockReady(ctx) {
      const c = volcanoCentreOfLandblock(ctx.lbX, ctx.lbY, ctx.codes, ctx.heights);
      if (!c) return;
      // Refine z through the oracle when it is up (exact split-diagonal height
      // rather than the vertex mean). Deterministic — pure static terrain.
      const oracle = _volc ? _volc.oracleRef() : null;
      if (oracle && typeof oracle.heightAt === "function") {
        const h = oracle.heightAt(c.x, c.y);
        if (Number.isFinite(h)) c.z = h;
      }
      _hazeLbs.set(ctx.lbKey >>> 0, c);
    },
    // Park DETACHES the terrain mesh from terrainGroup — the ground is not on
    // screen, so it must not hold the shimmer up.
    onLandblockPark(lbKey) { _hazeLbs.delete(lbKey >>> 0); },
    onLandblockUnpark(lbKey, ctx) {
      if (!ctx) return;
      const c = volcanoCentreOfLandblock(ctx.lbX, ctx.lbY, ctx.codes, ctx.heights);
      if (c) _hazeLbs.set(lbKey >>> 0, c);
    },
    onLandblockGone(lbKey) { _hazeLbs.delete(lbKey >>> 0); },
    update(dt, frameCtx) {
      _stats.hazeFrames += 1;
      updateHeatHazeState(
        resolveVolcanoQuality(frameCtx && frameCtx.quality),
        frameCtx && frameCtx.hasPlayer ? frameCtx.playerPos : null,
        frameCtx && frameCtx.camera,
      );
    },
    dispose() {
      _hazeLbs.clear();
      clearHeatHazeState();
    },
  };
}

function _emberProvider() {
  return {
    id: EMBER_PROVIDER_ID,
    families: [FAM_VOLCANO],
    scope: "landblock",
    enabled() { return terrainVolcanoEnabled() && terrainEmbersEnabled(); },
    quality(flags) {
      const q = resolveVolcanoQuality(flags);
      return q && q.emberCount > 0 ? q : null;
    },
    onLandblockReady(ctx) {
      if (!_volc) return;
      const count = ctx?.quality?.emberCount > 0 ? ctx.quality.emberCount : terrainVolcanoEmberCount();
      if (count <= 0) return;
      const slots = ventSlotsForLandblock({
        lbKey: ctx.lbKey,
        lbX: ctx.lbX,
        lbY: ctx.lbY,
        codes: ctx.codes,
        heights: ctx.heights,
        count,
        seed: _volc.seed,
      });
      if (slots.length === 0) return;
      const oracle = _volc.oracleRef();
      if (oracle && typeof oracle.heightAt === "function") {
        for (const s of slots) {
          const h = oracle.heightAt(s.x, s.y);
          if (Number.isFinite(h)) s.z = h;
        }
      }
      for (const s of slots) s.z += VOLCANO_TUNING.ventLiftM;
      const rec = {
        ownerKey: volcanoOwnerKeyForLb(ctx.lbKey),
        slots,
        ids: [],
        parked: false,
      };
      _ventLbs.set(ctx.lbKey >>> 0, rec);
      _stats.ventLandblocks += 1;
      _spawnVents(rec);
    },
    onLandblockPark(lbKey) {
      const rec = _ventLbs.get(lbKey >>> 0);
      if (!rec || rec.parked) return;
      rec.parked = true;
      _stats.parks += 1;
      // PARK STOPS EMISSION — it never destroys (plan §2.2.2 / §5.3), so
      // `emitterCountForOwner` is unchanged and unpark is free.
      for (const slot of rec.slots) {
        for (let which = 0; which < 2; which += 1) {
          try { _volc.ownerRegistry.stopEmitter(rec.ownerKey, ventEmitterHandle(slot.slot, which)); } catch (_) {}
        }
      }
    },
    onLandblockUnpark(lbKey) {
      const rec = _ventLbs.get(lbKey >>> 0);
      if (!rec || !rec.parked) return;
      rec.parked = false;
      _stats.unparks += 1;
      // Placement is hash-stable (§5.5), so the vent comes back exactly where
      // it was — this is NOT a re-scatter.
      _spawnVents(rec);
    },
    onLandblockGone(lbKey) {
      const rec = _ventLbs.get(lbKey >>> 0);
      if (!rec) return;
      _ventLbs.delete(lbKey >>> 0);
      _stats.gones += 1;
      _stats.destroyAllCalls += 1;
      try { _volc.ownerRegistry.destroyAllForOwner(rec.ownerKey); } catch (_) {}
    },
    dispose() {
      for (const [, rec] of _ventLbs) {
        try { _volc?.ownerRegistry.destroyAllForOwner(rec.ownerKey); } catch (_) {}
      }
      _ventLbs.clear();
    },
  };
}

/**
 * Construct + register the VOLCANO family. Called once from `scene3d/index.js`
 * right after `initTerrainSand` (the spine must exist first — the providers are
 * replayed onto the already-resident ring by `registerTerrainVfx`).
 *
 * Returns `null` (registering nothing, allocating nothing) when the family
 * master is off — a bare-default boot is byte-identical.
 *
 * @param {object} opts
 * @param {object} [opts.THREE]    the three namespace (injected).
 * @param {object} opts.scene3d    the live facade.
 * @param {Function} [opts.readEnv] `vfx/particle_env.js::readParticleEnv`
 *   (injected so this module stays THREE-free).
 * @param {Function} [opts.getParticleManager] defaults to the shared static
 *   ParticleManager (`scene3d._staticParticleManager`), whose scene is
 *   `staticsGroup` — the same AC frame the vent positions are in.
 * @param {object} [opts.ownerRegistry] the shared singleton by default.
 * @param {Function} [opts.getOracle] override for the terrain oracle.
 */
export function initTerrainVolcano(opts = {}) {
  const scene3d = opts.scene3d || null;
  if (!terrainVolcanoEnabled()) return null;      // ship-OFF master (plan §5.9)

  const hazeOn = terrainHazeEnabled();
  const embersOn = terrainEmbersEnabled();
  const crackOn = terrainCrackGlowEnabled();
  // Crack glow is `terrain.js`'s fragment work; it needs no provider, but it
  // DOES need the shared breathing oscillator registered.
  if (!hazeOn && !embersOn && !crackOn) return null;

  _volc = {
    THREE: opts.THREE || null,
    scene3d,
    readEnv: typeof opts.readEnv === "function" ? opts.readEnv : null,
    getParticleManager: typeof opts.getParticleManager === "function"
      ? opts.getParticleManager
      : () => scene3d?._staticParticleManager || null,
    ownerRegistry: opts.ownerRegistry || defaultOwnerRegistry,
    seed: Number.isFinite(opts.seed) ? opts.seed | 0 : 0x5601ca70,
    registered: [],
    oscillator: null,
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

  if (crackOn) {
    _volc.oscillator = registerOscillator(CRACK_GLOW_OSC_NAME, {
      kind: CRACK_GLOW_OSC_SPEC.kind,
      config: { ...CRACK_GLOW_OSC_SPEC.config },
    });
    _stats.oscillatorRegistrations += 1;
  }
  if (hazeOn) _volc.registered.push(registerTerrainVfx(_hazeProvider()));
  if (embersOn) _volc.registered.push(registerTerrainVfx(_emberProvider()));
  return terrainVolcanoSurface();
}

/** Diagnostics — mirrored onto `window.__terrainVolcano` by `scene3d/index.js`.
 *  Shape mirrors `terrain_sand.js::terrainSandStats`. */
export function terrainVolcanoStats() {
  return {
    enabled: terrainVolcanoEnabled(),
    haze: terrainVolcanoEnabled() && terrainHazeEnabled(),
    embers: terrainVolcanoEnabled() && terrainEmbersEnabled(),
    crackGlow: terrainVolcanoEnabled() && terrainCrackGlowEnabled(),
    inited: !!_volc,
    volcanoCodes: volcanoTerrainCodes(),
    volcanoCodeMask: volcanoCodeBitmask(),
    obsidianCodeMask: obsidianCodeBitmask(),
    ventLandblocks: _ventLbs.size,
    ventOwners: [..._ventLbs.values()].map((r) => ({
      ownerKey: r.ownerKey,
      slots: r.slots.length,
      ids: r.ids.length,
      parked: r.parked,
      live: (() => {
        try { return _volc ? _volc.ownerRegistry.emitterCountForOwner(r.ownerKey) : 0; }
        catch (_) { return 0; }
      })(),
    })),
    hazeLandblocks: _hazeLbs.size,
    haze3State: { ...HEAT_HAZE_STATE },
    oscillator: _volc && _volc.oscillator
      ? { name: CRACK_GLOW_OSC_NAME, value: _volc.oscillator.value }
      : null,
    counters: { ..._stats },
  };
}

function terrainVolcanoSurface() {
  return {
    stats: terrainVolcanoStats,
    get haze() { return HEAT_HAZE_STATE; },
    get vents() { return [..._ventLbs.keys()]; },
    get hazeLbs() { return [..._hazeLbs.keys()]; },
    lbKeyFromXY,
  };
}

/** Test seam — unregister both providers, the oscillator, and drop all state. */
export function _resetTerrainVolcano() {
  if (_volc) {
    for (const h of _volc.registered) {
      try { unregisterTerrainVfx(h.id); } catch (_) {}
    }
    if (_volc.oscillator) { try { unregisterOscillator(CRACK_GLOW_OSC_NAME); } catch (_) {} }
  }
  _ventLbs.clear();
  _hazeLbs.clear();
  clearHeatHazeState();
  HEAT_HAZE_STATE.frames = 0;
  _volc = null;
  for (const k of Object.keys(_stats)) _stats[k] = 0;
}

export { VENT_GATE_MIN };
