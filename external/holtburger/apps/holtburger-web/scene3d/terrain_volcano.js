// scene3d/terrain_volcano.js — VOLCANO (LAVA) terrain VFX (Wave 2B).
//
// Design plan: `docs/2026-07-31-terrain-vfx-plan.md` §3.6. `FAM_VOLCANO` is
// derived from `terrain_families.js`, never hardcoded here (plan §8 risk 12:
// family membership is a property of the CODE, and another region could name
// the same code differently).
//
// 2026-10-23 — THE SPLIT (owner, on the 1070: "we have obsidian plains and dark
// isles texture mixed up with lava, should make new effect for obsidian").
// FAM_VOLCANO was codes 6 (`ObsidianPlain`), 25 (`Volcano1`) and 26
// (`Volcano2`), so everything below also ran on 2430 obsidian-glass landblocks
// and 297 grey-ash ones. Verified from the DATs, only code 25's texture
// (0x06006D54, black basalt with orange-red glowing cracks painted in) is lava.
// FAM_VOLCANO is now {25}; code 6 is FAM_OBSIDIAN (`terrain_obsidian.js`, its
// own glass effect and master flag) and code 26 is FAM_ASH (plain; its only
// treatment is the tier-2 fx-field ash drift, `vfx/fx_fields.js`). So the crack
// glow, the ember vents and the heat-shimmer disc all run over LAVA alone.
//
// THE LOOK (plan §3.6): dangerous. Heat visibly distorting the air, embers
// lifting and dying, the lava glow breathing in the cracks underfoot.
//
// THREE EFFECTS, THREE OWNERS:
//   1. HEAT SHIMMER — the Effect lives in `vfx/heat_haze_effect.js` (it needs
//      THREE + `postprocessing`); THIS file owns the per-frame state it reads
//      (`HEAT_HAZE_STATE`) and the landblock bookkeeping that decides whether
//      any lava ground is resident at all. The Effect is inserted into the
//      EXISTING `EffectPass` in `atmosphere_pipeline.js` — never a new pass.
//   2. EMBERS — here (lifecycle) + `vfx/components/terrainVolcanoEmbers.js`
//      (the registered, lint-passing descriptor, which RE-ANCHORS
//      `brazierEmbers.js`'s own builders rather than forking them).
//      2026-10-23: emission is DISTANCE-GATED (`VOLCANO_TUNING.ventEngageM`).
//      LRU residency is capacity-driven, not distance-driven (the haze learnt
//      this as `hazeMaxEngageM`): across the owner's teleport tour ventLandblocks
//      grew 11 → 63 → 80 while the player went 10 km away, and every unparked
//      far vent kept emitting. A vent landblock now holds emitters only while
//      the player is within range, and drops them (destroy, not stop) past it.
//   3. CRACK GLOW — in the TERRAIN FRAGMENT SHADER (`terrain.js`, search
//      `LAVA CRACK GLOW`), gated on FAM_VOLCANO read from `uVertexTypes` (plan
//      trap T3 — the subdiv path IGNORES the `terrainCode` geometry attribute),
//      bypassed on any water-touching cell (plan §2.7.3). 2026-10-23: keyed to
//      the texture's OWN painted cracks (emissive = the hot texel colour), not
//      a procedural vein field that followed nothing. NOT in this file; this
//      file owns the breathing oscillator, the flag surface and the live knobs
//      (`window.__terrainVolcano.tune({...})`, CRACK_GLOW_KNOBS).
//   ASH FALL — not a volcano effect any more: the grey ash ground is FAM_ASH,
//      and `vfx/fx_fields.js` already drifts ash over it (and over lava).
//
// ASH (plan §3.6 item 4 / §8 risk 9). The plan says to parameterise
// `weather/snow.js SnowSystem` rather than write a third falling-particle
// system, and to note it and move on if that proves invasive. It is invasive:
// `SnowSystem` seeds and re-seeds every particle through TEN `Math.random()`
// calls (directly against the §5.5 determinism invariant every terrain-VFX
// effect is held to), it is constructed and disposed by `weather/manager.js`
// keyed on the active weather profile's `temperature_C` rather than on terrain,
// and there is no notion of a terrain gate anywhere under `scene3d/weather/`.
// Wave 2B therefore shipped NO ash flag here; since 2026-10-10 the tier-2 GPU
// field (`vfx/fx_fields.js` "ash") covers it, keyed on FAM_VOLCANO + FAM_ASH.
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
//   2026-10-23: `?terrainHaze` is its OWN master now (vfx_flags.js
//   heatHazeEnabled; tier high/ultra): the haze provider registers without
//   `?terrainVolcano`, and `terrain_desert_haze.js` adds the desert arm.
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
  heatHazeEnabled,
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
// The live-knob override pusher is shared with the obsidian family (one
// implementation of "re-assert a tuning uniform on every terrain material").
import { createUniformOverrides } from "./terrain_obsidian.js";

export const METERS_PER_LANDBLOCK = 192;
export const VERTEX_GRID = 9;
export const VERTEX_SPACING_M = 24;

/** Provider ids — also the `VFX_EFFECT_FLAGS` router rows. `EMBER_PROVIDER_ID`
 *  is additionally the registered component id of the ember descriptor. */
export const HAZE_PROVIDER_ID = "terrain.volcanoHaze";
export const EMBER_PROVIDER_ID = "terrain.volcanoEmbers";
/** The crack glow's camera-scope provider (it only re-asserts live knobs) —
 *  also its `VFX_EFFECT_FLAGS` row. */
export const CRACK_PROVIDER_ID = "terrain.volcanoCrackGlow";

// ---------------------------------------------------------------------------
// Pure helpers — no THREE, no window. The directly-tested surface.
// ---------------------------------------------------------------------------

/** The terrain codes that are FAM_VOLCANO (lava — {25} in Dereth since the
 *  2026-10-23 split), DERIVED from the family LUT. */
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
  // 2026-10-23 (owner: "mirage when you look in on the town from the outside"):
  // a landblock drives the shimmer disc only if it is a real lava FIELD — at
  // least this many of its 81 vertices lava — not a few stray lava vertices.
  hazeMinLavaVerts: 12,
  // 2026-10-23 — EMBER VENT RANGE. The same LRU lesson for the vents: a vent
  // landblock holds its emitters only while the player is within
  // `ventEngageM` of its nearest vent, and DESTROYS them past
  // `ventEngageM * ventDropFactor` (the gap is hysteresis, so standing on the
  // edge does not churn). 480 m is 2.5 landblocks — an ember is a 0.2 m sprite
  // and a plume a few metres, both sub-pixel well before that. Evaluated at
  // `ventEvalHz` (the sand devils' cadence), never per frame.
  ventEngageM: 480,
  ventDropFactor: 1.15,
  ventEvalHz: 2,
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

/**
 * `window.__terrainVolcano.tune({...})` knobs → the terrain.js crack-glow
 * uniforms (defaults: `terrain.js` `DEFAULT_CRACK_GLOW_*`; these are clamps).
 *   strength  emissive gain on the hot texel colour at night (1.6)
 *   day       fraction of that gain kept in full daylight (0.55)
 *   heat      [lo, hi] smoothstep window on linear r - max(0.55 g, b) ([0.03, 0.25])
 *   color     warm tint multiplied into the texel colour ([1, 0.85, 0.7])
 *   pulse     depth of the travelling per-patch pulse, 0..1 (0.4)
 *   fadeStart / fadeEnd  distance fade, metres (350 / 1400)
 *   enabled   0/1 — the shader gate itself, for an instant A/B
 */
export const CRACK_GLOW_KNOBS = Object.freeze({
  enabled: Object.freeze({ uniform: "uCrackGlowEnabled", size: 1, min: 0, max: 1 }),
  strength: Object.freeze({ uniform: "uCrackGlowStrength", size: 1, min: 0, max: 16 }),
  day: Object.freeze({ uniform: "uCrackGlowDay", size: 1, min: 0, max: 4 }),
  heat: Object.freeze({ uniform: "uCrackGlowHeat", size: 2, min: -1, max: 2 }),
  color: Object.freeze({ uniform: "uCrackGlowColor", size: 3, min: 0, max: 4 }),
  pulse: Object.freeze({ uniform: "uCrackGlowPulse", size: 1, min: 0, max: 1 }),
  fadeStart: Object.freeze({ uniform: "uCrackGlowFadeStart", size: 1, min: 0, max: 8000 }),
  fadeEnd: Object.freeze({ uniform: "uCrackGlowFadeEnd", size: 1, min: 1, max: 8000 }),
});

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
  // 2026-10-23 — the GROUND arm (`terrain_desert_haze.js` writes these; the
  // volcano disc above never touches them and clearHeatHazeState leaves them).
  /** Ground shimmer weight (desert × heat × tier strength, low-passed). */
  groundStrength: 0,
  /** Ground depth band, eye-forward metres: starts, full, fades out. */
  groundNearM: 0, groundFullM: 1, groundFarM: 0,
  /** Inferior-mirage weight and its depth ramp (sky patches on far ground). */
  mirage: 0, mirageStartM: 0, mirageFeatherM: 1,
  /** Diagnostics: the desert share around the player and the env heat. */
  desertWeight: 0, desertHeat: 0,
  /** 2026-10-23 — 1 in open country, toward 0 in a town (terrain_desert_haze.js
   *  counts the interior cells near the player); scales BOTH arms in the Effect. */
  townFactor: 1,
};

/** Lava vertices in a landblock's 81 codes (the disc's "real lava field" test). */
export function lavaVertexCount(codes) {
  if (!codes) return 0;
  let n = 0;
  const len = Math.min(codes.length, VERTEX_GRID * VERTEX_GRID);
  for (let i = 0; i < len; i += 1) if (familyForCode(codes[i]) === FAM_VOLCANO) n += 1;
  return n;
}

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

/** Reset only the GROUND / mirage fields (the desert arm's half). */
export function clearGroundHazeState() {
  HEAT_HAZE_STATE.groundStrength = 0;
  HEAT_HAZE_STATE.groundNearM = 0;
  HEAT_HAZE_STATE.groundFullM = 1;
  HEAT_HAZE_STATE.groundFarM = 0;
  HEAT_HAZE_STATE.mirage = 0;
  HEAT_HAZE_STATE.mirageStartM = 0;
  HEAT_HAZE_STATE.mirageFeatherM = 1;
  HEAT_HAZE_STATE.desertWeight = 0;
  HEAT_HAZE_STATE.desertHeat = 0;
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
// Module state + the three providers (haze, embers, crack-glow knobs).
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
  // 2026-10-23 vent range gate.
  ventEvals: 0,
  rangeSpawns: 0,
  rangeDrops: 0,
  rangeDeferred: 0,
  // live crack-glow knobs
  crackOverridePushes: 0,
  crackOverrideWrites: 0,
};

/** Landblock-scoped vent bookkeeping:
 *  lbKey → {ownerKey, slots, ids, parked, active}. `active` = it holds emitters
 *  (the range gate's state); `parked` = the LRU stashed its terrain mesh. */
const _ventLbs = new Map();

/** The vent range gate's live parameters (`VOLCANO_TUNING` seeds them;
 *  `window.__terrainVolcano.ventRange({...})` moves them for the vistest). */
const _ventRange = {
  engageM: VOLCANO_TUNING.ventEngageM,
  dropFactor: VOLCANO_TUNING.ventDropFactor,
  evalHz: VOLCANO_TUNING.ventEvalHz,
};
/** Last known player position (AC metres) + the evaluation clock. */
const _ventPlayer = { x: 0, y: 0, valid: false, lastEvalT: -Infinity };
/** Scratch for the hoisted per-record evaluation (no closure per tick). */
const _ventEval = { engage2: 0, drop2: 0 };

/** Live crack-glow knob overrides (pushed onto every terrain material). */
const _crackOverrides = createUniformOverrides(CRACK_GLOW_KNOBS);

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
    // 2026-10-23: its own master (no longer gated on ?terrainVolcano).
    enabled() { return heatHazeEnabled(); },
    quality(flags) {
      const q = resolveVolcanoQuality(flags);
      return q && q.hazeStrength > 0 && q.hazeRadiusM > 0 ? q : null;
    },
    onLandblockReady(ctx) {
      if (lavaVertexCount(ctx.codes) < VOLCANO_TUNING.hazeMinLavaVerts) return;
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
      if (!ctx || lavaVertexCount(ctx.codes) < VOLCANO_TUNING.hazeMinLavaVerts) return;
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

/** Squared distance from the last known player position to a vent record's
 *  nearest vent (AC metres, ground plane). */
function _ventDist2(rec) {
  let best = Infinity;
  for (let i = 0; i < rec.slots.length; i += 1) {
    const s = rec.slots[i];
    const dx = s.x - _ventPlayer.x;
    const dy = s.y - _ventPlayer.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < best) best = d2;
  }
  return best;
}

function _activateVents(rec) {
  // No ParticleManager yet (early boot): stay dormant, so the range gate
  // retries on its next evaluation instead of marking a vent live that never
  // got an emitter.
  if (!_managerFor()) { _stats.noManager += 1; return; }
  rec.active = true;
  _stats.rangeSpawns += 1;
  _spawnVents(rec);
}

/** Range drop: the player is far from this landblock's vents (teleport, ride,
 *  walk). DESTROY, not stop — a stopped emitter still holds its particle
 *  buffers, and this landblock may sit in the LRU for minutes. Not a lifecycle
 *  event: the vents re-form, hash-stable, if the player comes back. */
function _dropVents(rec) {
  rec.active = false;
  rec.ids.length = 0;
  _stats.rangeDrops += 1;
  _stats.destroyAllCalls += 1;
  try { _volc.ownerRegistry.destroyAllForOwner(rec.ownerKey); } catch (_) {}
}

// The 2 Hz range evaluation's per-record pass (a hoisted Map.forEach callback,
// so the walk allocates no iterator and no closure).
function _evalVentRec(rec) {
  const d2 = _ventDist2(rec);
  if (rec.active && d2 > _ventEval.drop2) { _dropVents(rec); return; }
  if (!rec.active && !rec.parked && d2 <= _ventEval.engage2) _activateVents(rec);
}

/** Run the range gate now (also the test seam). Needs a known player. */
export function evaluateVentRange() {
  if (!_volc || !_ventPlayer.valid) return 0;
  const engage = Math.max(1, _ventRange.engageM);
  const drop = engage * Math.max(1, _ventRange.dropFactor);
  _ventEval.engage2 = engage * engage;
  _ventEval.drop2 = drop * drop;
  _stats.ventEvals += 1;
  _ventLbs.forEach(_evalVentRec);
  return _ventLbs.size;
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
        active: false,
      };
      _ventLbs.set(ctx.lbKey >>> 0, rec);
      _stats.ventLandblocks += 1;
      // The range gate decides from the first frame: a landblock that streams
      // in beyond range (the far edge of the ring) stays dormant until the
      // player comes near. With no player known yet (boot), spawn — the first
      // evaluation drops it if it is far.
      if (_ventPlayer.valid && _ventDist2(rec) > Math.max(1, _ventRange.engageM) ** 2) {
        _stats.rangeDeferred += 1;
        return;
      }
      _activateVents(rec);
    },
    onLandblockPark(lbKey) {
      const rec = _ventLbs.get(lbKey >>> 0);
      if (!rec || rec.parked) return;
      rec.parked = true;
      _stats.parks += 1;
      if (!rec.active) return;
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
      // it was — this is NOT a re-scatter. A dormant (out-of-range) record
      // waits for the range gate instead.
      if (rec.active) _spawnVents(rec);
      else if (!_ventPlayer.valid || _ventDist2(rec) <= Math.max(1, _ventRange.engageM) ** 2) {
        _activateVents(rec);
      }
    },
    onLandblockGone(lbKey) {
      const rec = _ventLbs.get(lbKey >>> 0);
      if (!rec) return;
      _ventLbs.delete(lbKey >>> 0);
      _stats.gones += 1;
      _stats.destroyAllCalls += 1;
      try { _volc.ownerRegistry.destroyAllForOwner(rec.ownerKey); } catch (_) {}
    },
    update(dt, frameCtx) {
      if (!frameCtx || !frameCtx.hasPlayer || !frameCtx.playerPos) return;
      _ventPlayer.x = frameCtx.playerPos.x;
      _ventPlayer.y = frameCtx.playerPos.y;
      _ventPlayer.valid = true;
      const t = Number.isFinite(frameCtx.tSec) ? frameCtx.tSec : 0;
      const evalDt = 1 / Math.max(0.1, _ventRange.evalHz);
      if (t - _ventPlayer.lastEvalT >= evalDt || t < _ventPlayer.lastEvalT) {
        _ventPlayer.lastEvalT = t;
        evaluateVentRange();
      }
    },
    dispose() {
      for (const [, rec] of _ventLbs) {
        try { _volc?.ownerRegistry.destroyAllForOwner(rec.ownerKey); } catch (_) {}
      }
      _ventLbs.clear();
    },
  };
}

function _terrainMaterials(frameCtx) {
  try {
    const s = (frameCtx && frameCtx.scene3d) || (_volc && _volc.scene3d);
    if (s && Array.isArray(s.terrainMaterials)) return s.terrainMaterials;
    if (typeof window !== "undefined" && Array.isArray(window.liveScene3d?.terrainMaterials)) {
      return window.liveScene3d.terrainMaterials;
    }
  } catch (_) { /* fail-soft */ }
  return null;
}

function _pushCrackOverrides(frameCtx) {
  if (!_crackOverrides.active) return;
  const mats = _terrainMaterials(frameCtx);
  if (!mats) return;
  _stats.crackOverrideWrites += _crackOverrides.push(mats);
  _stats.crackOverridePushes += 1;
}

/** The crack glow is a terrain-shader term with no per-landblock state; this
 *  camera-scope provider exists only to re-assert live knob overrides each
 *  frame (a single length test when none are set). */
function _crackProvider() {
  return {
    id: CRACK_PROVIDER_ID,
    families: [FAM_VOLCANO],
    scope: "camera",
    enabled() { return terrainVolcanoEnabled() && terrainCrackGlowEnabled(); },
    update(dt, frameCtx) { _pushCrackOverrides(frameCtx); },
    dispose() {},
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
  // The family master (ship-OFF, plan §5.9) gates embers + crack glow. The heat
  // shimmer is its OWN master since 2026-10-23 (owner: the mirage must be on):
  // it registers at high/ultra whatever ?terrainVolcano says.
  const master = terrainVolcanoEnabled();
  const hazeOn = heatHazeEnabled();
  const embersOn = master && terrainEmbersEnabled();
  const crackOn = master && terrainCrackGlowEnabled();
  // Crack glow is `terrain.js`'s fragment work: it needs the shared breathing
  // oscillator registered, and a camera-scope provider that re-asserts the
  // live knobs (`tune`) each frame.
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
  if (crackOn) _volc.registered.push(registerTerrainVfx(_crackProvider()));
  return terrainVolcanoSurface();
}

/** Diagnostics — mirrored onto `window.__terrainVolcano` by `scene3d/index.js`.
 *  Shape mirrors `terrain_sand.js::terrainSandStats`. */
export function terrainVolcanoStats() {
  return {
    enabled: terrainVolcanoEnabled(),
    haze: heatHazeEnabled(),
    embers: terrainVolcanoEnabled() && terrainEmbersEnabled(),
    crackGlow: terrainVolcanoEnabled() && terrainCrackGlowEnabled(),
    inited: !!_volc,
    volcanoCodes: volcanoTerrainCodes(),
    volcanoCodeMask: volcanoCodeBitmask(),
    // LRU residency (bounded by the ring, NOT by distance) ...
    ventLandblocks: _ventLbs.size,
    // ... versus the landblocks actually holding emitters (distance-bounded by
    // the range gate — the number that costs anything).
    ventsActive: (() => { let n = 0; _ventLbs.forEach((r) => { if (r.active) n += 1; }); return n; })(),
    ventRange: { ..._ventRange },
    ventOwners: [..._ventLbs.values()].map((r) => ({
      ownerKey: r.ownerKey,
      slots: r.slots.length,
      ids: r.ids.length,
      parked: r.parked,
      active: r.active,
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
    crackOverrides: _crackOverrides.current(),
    counters: { ..._stats },
  };
}

/**
 * Live crack-glow tuning for the 1070 vistest: `tune({strength: 2.2, day: 0.8})`
 * records the override, writes it onto every live terrain material now, and
 * the crack provider re-asserts it every frame (new landblocks and the batched
 * material included). `tune(null)` drops every override and writes the
 * captured defaults back onto every terrain material (a real reset — the
 * vistest's `tune({day: 1})` night preview must not outlive it). Knobs:
 * CRACK_GLOW_KNOBS.
 */
export function tuneCrackGlow(patch) {
  const out = _crackOverrides.set(patch);
  _pushCrackOverrides(null);
  return out;
}

/**
 * Live vent-range tuning: `ventRange({engageM: 700})`. Re-evaluates at once.
 * Returns the live parameters.
 */
export function setVentRange(patch) {
  if (patch && typeof patch === "object") {
    if (Number.isFinite(Number(patch.engageM))) _ventRange.engageM = Math.min(4000, Math.max(16, Number(patch.engageM)));
    if (Number.isFinite(Number(patch.dropFactor))) _ventRange.dropFactor = Math.min(4, Math.max(1, Number(patch.dropFactor)));
    if (Number.isFinite(Number(patch.evalHz))) _ventRange.evalHz = Math.min(30, Math.max(0.1, Number(patch.evalHz)));
    evaluateVentRange();
  }
  return { ..._ventRange };
}

function terrainVolcanoSurface() {
  return {
    stats: terrainVolcanoStats,
    tune: tuneCrackGlow,
    knobs: Object.keys(CRACK_GLOW_KNOBS),
    ventRange: setVentRange,
    get haze() { return HEAT_HAZE_STATE; },
    get vents() { return [..._ventLbs.keys()]; },
    get activeVents() {
      const out = [];
      _ventLbs.forEach((r, k) => { if (r.active) out.push(k); });
      return out;
    },
    get hazeLbs() { return [..._hazeLbs.keys()]; },
    lbKeyFromXY,
  };
}

/** Test seam — unregister every provider, the oscillator, and drop all state. */
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
  clearGroundHazeState();
  HEAT_HAZE_STATE.frames = 0;
  _volc = null;
  _ventPlayer.valid = false;
  _ventPlayer.lastEvalT = -Infinity;
  _ventRange.engageM = VOLCANO_TUNING.ventEngageM;
  _ventRange.dropFactor = VOLCANO_TUNING.ventDropFactor;
  _ventRange.evalHz = VOLCANO_TUNING.ventEvalHz;
  _crackOverrides.reset();
  for (const k of Object.keys(_stats)) _stats[k] = 0;
}

export { VENT_GATE_MIN };
