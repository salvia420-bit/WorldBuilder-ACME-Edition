// scene3d/vfx/heat_haze_effect.js — heat shimmer + mirage (Wave 2B volcano disc;
// 2026-10-23 desert GROUND shimmer + inferior MIRAGE, see below).
//
// 2026-10-23 (owner on the 1070, Tufa desert: "get our mirage effect sorted,
// its not active or not as much as it should be ... improve it also"):
//   - its OWN master (`vfx_flags.js::heatHazeEnabled`, tier high/ultra), no
//     longer constructed only under `?terrainVolcano`;
//   - a GROUND term (`terrain_desert_haze.js`): over hot sand the shimmer grows
//     with eye distance, so the far dunes and the horizon wobble;
//   - a MIRAGE term: past a few hundred metres the ground samples the sky just
//     above it, in drifting patches along the horizon — the inferior mirage,
//     "water on the road". Still a pure UV warp: no second texture read;
//   - the base amplitude 0.006 -> 0.009 (the disc read as too faint).
//
// Design plan: `docs/2026-07-31-terrain-vfx-plan.md` §3.6 item 1 — "the one
// place a postprocessing addition is clearly right". `postprocessing@6.39.1` is
// ALREADY PINNED; this adds no package.
//
// WHAT IT IS. A custom pmndrs `Effect` implementing `void mainUv(inout vec2 uv)`
// — the CHEAPEST effect class there is, a pure UV warp with no colour work and
// no second sample of the input buffer. It is declared with
// `EffectAttribute.DEPTH` so `depthBuffer` is bound and the warp can be gated by
// distance: the sky never wobbles and objects in front of the heat source stay
// crisp.
//
// ⚠ IT GOES INTO THE EXISTING `EffectPass`, NEVER A NEW PASS.
// `atmosphere_pipeline.js` builds ONE `fxPass` from
//   [heatHaze, aerialPerspective, horizonDissolve, lensFlare, bloom, vignette,
//    toneMapping, dithering].filter(Boolean)
// and `createHeatHazeEffect()` returns `null` when the flags are off, so
// `filter(Boolean)` drops the slot and `composer.passes.length` — and the
// generated shader — are byte-identical to the pre-feature pipeline. Heat haze
// is FIRST, before `aerialPerspective`: pmndrs concatenates every `mainUv` body
// before any `mainImage`, so the distortion is applied to the raw scene and
// everything downstream (fog, bloom, tone mapping) then operates on it.
// (`EffectPass` re-sorts its effects by `attributes` DESCENDING; `Array#sort` is
// stable and `aerialPerspective` also carries DEPTH, so first-in-the-list stays
// first.)
//
// ⚠ TRAP T4 — THE LOG-DEPTH BUFFER. `scene3d/index.js` enables
// `logarithmicDepthBuffer`. This effect reads the RAW `depthBuffer` texel and
// decodes it itself:
//     dist = exp2(2.0 * d / uLogDepthFC) - 1.0        // eye-forward metres
// exactly as `HorizonDissolveEffect` does. It deliberately does NOT use pmndrs'
// own `readDepth()` helper: in 6.39.1 that helper carries its own
// `#if defined(USE_LOGARITHMIC_DEPTH_BUFFER)` branch, and three r184 injects
// that define into every non-raw `ShaderMaterial` — so `readDepth()` has ALREADY
// converted the value, and a second manual decode on top of it would be wrong.
// Reading the raw texel makes the decode unambiguous and independent of which
// three/postprocessing versions happen to be pinned.
//
// MASKING (plan §3.6, v1). No mask pass, no matrices in the shader: the host
// (`terrain_volcano.js`) already runs inside the terrain-VFX tick with the
// camera and the player position in hand, so it PROJECTS the nearest resident
// volcanic landblock's centre to uv on the CPU, once per frame, and publishes
// the disc + a depth band in `HEAT_HAZE_STATE`. **`uHeatRadius` is 0 whenever no
// volcanic landblock is resident** — otherwise the distortion follows the player
// out of the region (plan §3.6, test-asserted). The v1 single-centre mask will
// read wrong where volcanic and non-volcanic landblocks interleave; that is
// plan §8 risk 5, accepted for v1.
//
// INVARIANTS. Adds no light (§5.2). Binds `VFX_GLOBALS.uTime` BY IDENTITY as its
// clock (§5.6) — the same `{value}` object `vfx/oscillators.js::tickOscillators`
// writes once per frame, so the shimmer is phase-locked to every other VFX
// channel and to the terrain shader's own `uTime`, and it inherits that tick's
// 3600 s wrap. Deterministic: sums of sines of (uv, clock) only, no
// `Math.random`. It patches no material and varies no program cache key.

import * as THREE from "three";
import { BlendFunction, Effect, EffectAttribute } from "postprocessing";
import { VFX_GLOBALS } from "../materials.js";
import { HEAT_HAZE_STATE } from "../terrain_volcano.js";
import { heatHazeEnabled } from "../vfx_flags.js";
import { HEAT_HAZE_FRAG } from "./heat_haze_glsl.js";

// Base warp amplitude in uv units, BEFORE `?terrainHazeStrength`. Deliberately a
// whisper: at 0.006 a pixel moves ~0.6 % of the frame at full mask, which reads
// as air moving rather than as a broken frame. The calibration target is the BC7
// arm (:8767 `texBc7=on&terrainBc7=on`), plan §8 risk 13.
// 2026-10-23: 0.006 -> 0.009, the owner found the volcano disc too faint.
const HEAT_BASE_AMPLITUDE = 0.009;
// Spatial frequency of the shimmer in uv units — how many ripples fit the frame.
const HEAT_BASE_FREQ = 42.0;
// Temporal rate, radians/second. 2.2 rad/s ≈ 0.35 Hz, inside the ≤ 1 Hz band the
// shared clock's 3600 s wrap is phase-continuous for.
const HEAT_BASE_SPEED = 2.2;
// 2026-10-23 desert arm. The GROUND shimmer's amplitude relative to the base
// (it covers the whole far field, so it runs a little under the disc), and the
// MIRAGE lift in uv units at full weight: 0.007 of the frame height is ~7 px at
// 1080p, a band of sky the height of a distant dune crest. Live: __heatHaze.
const HEAT_GROUND_GAIN = 0.8;
const MIRAGE_BASE_LIFT = 0.007;

// The fragment GLSL lives in ./heat_haze_glsl.js (no imports; the smoke compiles it).

/**
 * The heat-shimmer Effect. Reads `HEAT_HAZE_STATE` (written once per frame by
 * `terrain_volcano.js`'s `terrain.volcanoHaze` provider) in `update()`.
 */
export class HeatHazeEffect extends Effect {
  /**
   * @param {{cameraFar?:number, state?:object, clock?:{value:number},
   *          freq?:number, speed?:number, amplitude?:number}} [opts]
   */
  constructor(opts = {}) {
    const far = Number.isFinite(opts.cameraFar) ? opts.cameraFar : 10000;
    super("HeatHazeEffect", HEAT_HAZE_FRAG, {
      blendFunction: BlendFunction.NORMAL,
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map([
        // ⚠ BY IDENTITY, not a clone (plan §5.6). `{value}` is all three's
        // WebGLUniforms needs, and pmndrs re-uses the very object we put in this
        // Map when it builds the compound material's uniform set — so this stays
        // the shared VFX clock through the whole integration.
        ["uTime", opts.clock || VFX_GLOBALS.uTime],
        ["uHeatScreen", new THREE.Uniform(new THREE.Vector2(0.5, 0.5))],
        ["uHeatScreenRadius", new THREE.Uniform(0)],
        ["uHeatRadius", new THREE.Uniform(0)],
        ["uHeatNear", new THREE.Uniform(0)],
        ["uHeatFar", new THREE.Uniform(0)],
        ["uHeatFeather", new THREE.Uniform(1)],
        ["uStrength", new THREE.Uniform(0)],
        ["uFreq", new THREE.Uniform(Number.isFinite(opts.freq) ? opts.freq : HEAT_BASE_FREQ)],
        ["uSpeed", new THREE.Uniform(Number.isFinite(opts.speed) ? opts.speed : HEAT_BASE_SPEED)],
        ["uLogDepthFC", new THREE.Uniform(2.0 / Math.log2(far + 1.0))],
        ["uGround", new THREE.Uniform(0)],
        ["uGroundNear", new THREE.Uniform(0)],
        ["uGroundFull", new THREE.Uniform(1)],
        ["uGroundFar", new THREE.Uniform(0)],
        ["uMirage", new THREE.Uniform(0)],
        ["uMirageStart", new THREE.Uniform(0)],
        ["uMirageFeather", new THREE.Uniform(1)],
      ]),
    });
    /** The live state object, held BY REFERENCE (never snapshotted). */
    this.state = opts.state || HEAT_HAZE_STATE;
    /** Base warp amplitude; `state.strength` multiplies it. */
    this.amplitude = Number.isFinite(opts.amplitude) ? opts.amplitude : HEAT_BASE_AMPLITUDE;
    /** Ground shimmer gain over the base amplitude (desert arm). */
    this.groundGain = Number.isFinite(opts.groundGain) ? opts.groundGain : HEAT_GROUND_GAIN;
    /** Mirage lift in uv units at full weight (desert arm). */
    this.mirageLift = Number.isFinite(opts.mirageLift) ? opts.mirageLift : MIRAGE_BASE_LIFT;
  }

  /** `camera.far` changed (the composer never rebuilds the Effect). */
  setCameraFar(far) {
    this.uniforms.get("uLogDepthFC").value = 2.0 / Math.log2(far + 1.0);
  }

  /** pmndrs calls this once per frame from `EffectPass.render`, BEFORE the
   *  draw — the copy point for the host's per-frame state. Zero allocation. */
  update(_renderer, _inputBuffer, _deltaTime) {
    const s = this.state;
    const u = this.uniforms;
    // 2026-10-23 — towns stand both arms down (terrain_desert_haze.js).
    const town = s && Number.isFinite(s.townFactor) ? Math.max(0, Math.min(1, s.townFactor)) : 1;
    // Desert arm (ground shimmer + mirage): independent of the volcano disc.
    const g = s && Number.isFinite(s.groundStrength) ? s.groundStrength * town : 0;
    if (g > 0) {
      u.get("uGround").value = this.amplitude * this.groundGain * g;
      u.get("uGroundNear").value = s.groundNearM;
      u.get("uGroundFull").value = s.groundFullM;
      u.get("uGroundFar").value = s.groundFarM;
    } else {
      u.get("uGround").value = 0;
    }
    const mi = s && Number.isFinite(s.mirage) ? s.mirage * town : 0;
    if (mi > 0) {
      u.get("uMirage").value = this.mirageLift * mi;
      u.get("uMirageStart").value = s.mirageStartM;
      u.get("uMirageFeather").value = s.mirageFeatherM;
    } else {
      u.get("uMirage").value = 0;
    }
    if (!s || !s.enabled) {
      u.get("uHeatRadius").value = 0;
      u.get("uHeatScreenRadius").value = 0;
      u.get("uStrength").value = 0;
      return;
    }
    const sc = u.get("uHeatScreen").value;
    sc.x = s.screenU;
    sc.y = s.screenV;
    u.get("uHeatScreenRadius").value = s.screenRadiusUv;
    u.get("uHeatRadius").value = s.radiusM;
    u.get("uHeatNear").value = s.nearM;
    u.get("uHeatFar").value = s.farM;
    u.get("uHeatFeather").value = s.featherM;
    u.get("uStrength").value = this.amplitude * s.strength * town;
  }

  // Live-tuning accessors — the `HorizonDissolveEffect` pattern, exposed on
  // `window.__heatHaze` for the 1070 eye-test (no rebuild, no reload).
  get strength() { return this.amplitude; }
  set strength(v) { if (Number.isFinite(+v)) this.amplitude = +v; }
  get freq() { return this.uniforms.get("uFreq").value; }
  set freq(v) { if (Number.isFinite(+v)) this.uniforms.get("uFreq").value = +v; }
  get speed() { return this.uniforms.get("uSpeed").value; }
  set speed(v) { if (Number.isFinite(+v)) this.uniforms.get("uSpeed").value = +v; }
  get ground() { return this.groundGain; }
  set ground(v) { if (Number.isFinite(+v)) this.groundGain = +v; }
  get mirage() { return this.mirageLift; }
  set mirage(v) { if (Number.isFinite(+v)) this.mirageLift = +v; }
}

/**
 * Construct the heat-shimmer Effect, or `null` when it is off.
 *
 * `null` is the load-bearing return: `atmosphere_pipeline.js` spreads the
 * effect list through `.filter(Boolean)`, so an off flag leaves the `fxPass`
 * argument list — and therefore the compiled compound shader and
 * `composer.passes.length` — byte-identical to the pre-feature pipeline.
 *
 * @param {{cameraFar?:number, enabled?:boolean}} [opts] `enabled` forces the
 *   gate either way so headless tests need no URL.
 * @returns {HeatHazeEffect|null}
 */
export function createHeatHazeEffect(opts = {}) {
  const on = typeof opts.enabled === "boolean"
    ? opts.enabled
    : heatHazeEnabled();
  if (!on) return null;
  return new HeatHazeEffect(opts);
}

/** Install the `window.__heatHaze` live-tuning handle (the
 *  `window.__horizonFade` pattern). No-op with no window or no effect. */
export function installHeatHazeHandle(effect) {
  if (typeof window === "undefined" || !effect) return null;
  const handle = {
    get strength() { return effect.strength; },
    set strength(v) { effect.strength = v; },
    get freq() { return effect.freq; },
    set freq(v) { effect.freq = v; },
    get speed() { return effect.speed; },
    set speed(v) { effect.speed = v; },
    // 2026-10-23 desert arm: ground shimmer gain and mirage lift (uv units).
    get ground() { return effect.ground; },
    set ground(v) { effect.ground = v; },
    get mirage() { return effect.mirage; },
    set mirage(v) { effect.mirage = v; },
    get state() { return { ...effect.state }; },
    effect,
  };
  window.__heatHaze = handle;
  return handle;
}

export { HEAT_BASE_AMPLITUDE, HEAT_BASE_FREQ, HEAT_BASE_SPEED, HEAT_GROUND_GAIN, MIRAGE_BASE_LIFT };
