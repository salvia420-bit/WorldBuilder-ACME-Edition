// scene3d/vfx/heat_haze_effect.js — VOLCANO heat shimmer (Wave 2B).
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
import { terrainVolcanoEnabled, terrainHazeEnabled } from "../vfx_flags.js";

// Base warp amplitude in uv units, BEFORE `?terrainHazeStrength`. Deliberately a
// whisper: at 0.006 a pixel moves ~0.6 % of the frame at full mask, which reads
// as air moving rather than as a broken frame. The calibration target is the BC7
// arm (:8767 `texBc7=on&terrainBc7=on`), plan §8 risk 13.
const HEAT_BASE_AMPLITUDE = 0.006;
// Spatial frequency of the shimmer in uv units — how many ripples fit the frame.
const HEAT_BASE_FREQ = 42.0;
// Temporal rate, radians/second. 2.2 rad/s ≈ 0.35 Hz, inside the ≤ 1 Hz band the
// shared clock's 3600 s wrap is phase-continuous for.
const HEAT_BASE_SPEED = 2.2;

// No backticks anywhere in this GLSL, including comments (a stray backtick
// closes the JS template literal — it has bitten terrain.js).
const HEAT_HAZE_FRAG = /* glsl */ `
uniform float uTime;          // VFX_GLOBALS.uTime, bound BY IDENTITY (plan 5.6)
uniform vec2  uHeatScreen;    // projected heat centre, uv
uniform float uHeatScreenRadius; // mask radius, uv (v units; x corrected by aspect)
uniform float uHeatRadius;    // heat radius in METRES; 0 => no volcanic LB resident
uniform float uHeatNear;      // depth band, metres
uniform float uHeatFar;
uniform float uHeatFeather;
uniform float uStrength;      // amplitude multiplier (?terrainHazeStrength x tier)
uniform float uFreq;
uniform float uSpeed;
uniform float uLogDepthFC;    // 2.0 / log2(cameraFar + 1.0)

// Eye-forward distance in metres for this pixel, or -1.0 for sky / cleared far.
// Reads the RAW depth texel on purpose -- see the trap-T4 note in the header.
float hbHeatDistanceM(const in vec2 uv) {
  float d = texture2D(depthBuffer, uv).r;
  if (d >= 0.9999) return -1.0;
  return exp2(2.0 * d / uLogDepthFC) - 1.0;
}

void mainUv(inout vec2 uv) {
  // STRICT NO-OP. uHeatRadius is zeroed by the host whenever no volcanic
  // landblock is resident, and uStrength is 0 at every tier that does not want
  // the effect -- so the whole body costs one compare on those frames.
  if (uHeatRadius <= 0.0 || uStrength <= 0.0 || uHeatScreenRadius <= 0.0) return;

  float dist = hbHeatDistanceM(uv);
  if (dist < 0.0) return;                  // sky: never warp

  // Screen mask: a disc around the projected heat centre, circular in SCREEN
  // space (x scaled by the built-in aspect uniform, not by texel size).
  vec2 d2 = vec2((uv.x - uHeatScreen.x) * aspect, uv.y - uHeatScreen.y);
  float m = 1.0 - smoothstep(uHeatScreenRadius * 0.35, uHeatScreenRadius, length(d2));
  if (m <= 0.0) return;

  // Depth gate: only geometry inside the heat volume's depth band shimmers, so
  // a tree between the eye and the lava field stays crisp.
  m *= smoothstep(uHeatNear, uHeatNear + uHeatFeather, dist);
  m *= 1.0 - smoothstep(max(uHeatFar - uHeatFeather, uHeatNear + uHeatFeather), uHeatFar, dist);
  if (m <= 0.0) return;

  // Rising columnar shimmer: two incommensurate vertical sines (so the pattern
  // never reads as one clean wave) plus a weaker horizontal one. Deterministic
  // in (uv, uTime) alone.
  float w  = sin(uv.y * uFreq + uTime * uSpeed) * 0.6
           + sin(uv.y * uFreq * 1.87 - uTime * uSpeed * 0.73) * 0.4;
  float w2 = sin(uv.x * uFreq * 0.61 + uTime * uSpeed * 0.41);

  float a = uStrength * m;
  uv.x += w * a;
  uv.y += w2 * a * 0.35;
}
`;

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
      ]),
    });
    /** The live state object, held BY REFERENCE (never snapshotted). */
    this.state = opts.state || HEAT_HAZE_STATE;
    /** Base warp amplitude; `state.strength` multiplies it. */
    this.amplitude = Number.isFinite(opts.amplitude) ? opts.amplitude : HEAT_BASE_AMPLITUDE;
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
    u.get("uStrength").value = this.amplitude * s.strength;
  }

  // Live-tuning accessors — the `HorizonDissolveEffect` pattern, exposed on
  // `window.__heatHaze` for the 1070 eye-test (no rebuild, no reload).
  get strength() { return this.amplitude; }
  set strength(v) { if (Number.isFinite(+v)) this.amplitude = +v; }
  get freq() { return this.uniforms.get("uFreq").value; }
  set freq(v) { if (Number.isFinite(+v)) this.uniforms.get("uFreq").value = +v; }
  get speed() { return this.uniforms.get("uSpeed").value; }
  set speed(v) { if (Number.isFinite(+v)) this.uniforms.get("uSpeed").value = +v; }
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
    : (terrainVolcanoEnabled() && terrainHazeEnabled());
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
    get state() { return { ...effect.state }; },
    effect,
  };
  window.__heatHaze = handle;
  return handle;
}

export { HEAT_BASE_AMPLITUDE, HEAT_BASE_FREQ, HEAT_BASE_SPEED };
