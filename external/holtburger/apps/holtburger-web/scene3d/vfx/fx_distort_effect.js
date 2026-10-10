// scene3d/vfx/fx_distort_effect.js — tier 1 `?fxDistort` (2026-10-10):
// screen-space distortion driven by the effects in view.
//
// The generalisation of vfx/heat_haze_effect.js (one volcano disc) to every
// source in vfx/fx_distort.js: heat columns over fires, a slow vortex twist
// over portals, an expanding shockwave ring on bursts and impacts, soft
// ripples over runes. Same effect class as the heat haze: a pmndrs Effect that
// implements `mainUv` only (a pure UV warp, no colour work), declared with
// EffectAttribute.DEPTH so each source warps only what lies at or behind it —
// a creature standing in front of a brazier stays crisp.
//
// PLACEMENT (atmosphere_pipeline.js). In the atmosphere EffectPass right after
// the heat haze: the warp moves the scene, the clouds and the aerial
// perspective together. With `?particlesOverClouds` (the split chain) the
// particles are drawn after that pass, so the flames themselves stay sharp and
// only the air behind them bends; on the single chain they bend with the rest.
//
// THE LOG-DEPTH TRAP (heat_haze_effect.js T4): the raw depth texel is decoded
// here (eye-forward metres = exp2(2 d / uLogDepthFC) - 1), never through
// pmndrs readDepth(), which three r184 has already log-converted.
//
// Up to FX_DISTORT_MAX (16) sources a frame, strongest on screen first; the
// fixed-size uniform arrays never change the program. No light, no material
// patch, constant program.

import * as THREE from "three";
import { BlendFunction, Effect, EffectAttribute } from "postprocessing";
import { FX_DISTORT_MAX, collectFxDistortSources } from "./fx_distort.js";
import { fxTier1Enabled } from "./fx_tier1.js";

// Base displacement (uv units at a source's full strength and screen size 1).
const FX_DISTORT_AMP = 1.0;

// No backticks in the GLSL (template literal).
const FRAG = /* glsl */ `
uniform vec4 uFxDistA[${FX_DISTORT_MAX}];   // x, y (uv), radius (uv height units), depth (m)
uniform vec4 uFxDistB[${FX_DISTORT_MAX}];   // kind, strength, phase (rings), radius (m)
uniform int uFxDistN;
uniform float uFxDistTime;
uniform float uFxDistAmp;
uniform float uFxDistLogFC;                 // 2 / log2(cameraFar + 1)

float hbFxDistDepth(const in vec2 uv) {
  float d = texture2D(depthBuffer, uv).r;
  if (d >= 0.9999) return 1.0e6;            // sky: behind everything
  return exp2(2.0 * d / uFxDistLogFC) - 1.0;
}

void mainUv(inout vec2 uv) {
  if (uFxDistN <= 0 || uFxDistAmp <= 0.0) return;
  vec2 total = vec2(0.0);
  float sceneD = -1.0;
  for (int i = 0; i < ${FX_DISTORT_MAX}; i++) {
    if (i >= uFxDistN) break;
    vec4 a = uFxDistA[i];
    vec4 b = uFxDistB[i];
    vec2 d = vec2((uv.x - a.x) * aspect, uv.y - a.y);
    float kind = b.x;
    // heat rises in a column: an ellipse twice as tall as wide
    vec2 dd = kind < 1.5 ? vec2(d.x, d.y * 0.5) : d;
    float r = length(dd) / max(a.z, 1e-4);
    if (r >= 1.0) continue;
    if (sceneD < 0.0) sceneD = hbFxDistDepth(uv);
    // only what lies at or behind the source bends (soft over half a radius)
    float gate = smoothstep(a.w - b.w * 1.2, a.w - b.w * 0.6, sceneD);
    if (gate <= 0.0) continue;
    float s = b.y * gate * a.z;
    float seed = fract(a.w * 0.37);
    vec2 disp = vec2(0.0);
    if (kind < 1.5) {
      // heat: two incommensurate rising waves, strongest in the column's core
      float m = (1.0 - r) * (1.0 - r);
      float w = sin(uv.y / max(a.z, 1e-3) * 26.0 - uFxDistTime * 7.0 + seed * 6.28) * 0.6
              + sin(uv.y / max(a.z, 1e-3) * 41.0 + d.x / max(a.z, 1e-3) * 7.0 - uFxDistTime * 9.3) * 0.4;
      disp = vec2(w, 0.35 * cos(uv.x / max(a.z, 1e-3) * 19.0 - uFxDistTime * 5.1 + seed * 3.0)) * m * 0.035;
    } else if (kind < 2.5) {
      // swirl: a twist that is strongest at the centre, slowly breathing,
      // plus a faint pull inward (the portal drinks the world)
      float m = (1.0 - r) * (1.0 - r);
      float th = 1.25 * m * (0.85 + 0.15 * sin(uFxDistTime * 0.7 + seed * 6.28));
      float c = cos(th), sn = sin(th);
      vec2 rd = vec2(c * d.x - sn * d.y, sn * d.x + c * d.y);
      disp = (rd - d) / max(a.z, 1e-4) * 0.22 - d / max(a.z, 1e-4) * 0.05 * (1.0 - r);
    } else if (kind < 3.5) {
      // ring: an expanding shockwave band, fading as it grows
      float ph = clamp(b.z, 0.0, 1.0);
      float band = exp(-pow((r - ph) / 0.12, 2.0)) * (1.0 - ph);
      disp = (length(d) > 1e-5 ? normalize(d) : vec2(0.0)) * band * 0.09;
    } else {
      // ripple: soft concentric rings drifting outward
      disp = (length(d) > 1e-5 ? normalize(d) : vec2(0.0))
           * sin(r * 22.0 - uFxDistTime * 5.0 + seed * 6.28) * (1.0 - r) * 0.02;
    }
    total += disp * s;
  }
  uv += vec2(total.x / aspect, total.y) * uFxDistAmp;
}
`;

export class FxDistortEffect extends Effect {
  /** @param {{camera?: THREE.Camera, cameraFar?: number, amplitude?: number}} [opts] */
  constructor(opts = {}) {
    const far = Number.isFinite(opts.cameraFar) ? opts.cameraFar : 10000;
    super("FxDistortEffect", FRAG, {
      blendFunction: BlendFunction.NORMAL,
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map([
        ["uFxDistA", new THREE.Uniform(Array.from({ length: FX_DISTORT_MAX }, () => new THREE.Vector4()))],
        ["uFxDistB", new THREE.Uniform(Array.from({ length: FX_DISTORT_MAX }, () => new THREE.Vector4()))],
        ["uFxDistN", new THREE.Uniform(0)],
        ["uFxDistTime", new THREE.Uniform(0)],
        ["uFxDistAmp", new THREE.Uniform(Number.isFinite(opts.amplitude) ? opts.amplitude : FX_DISTORT_AMP)],
        ["uFxDistLogFC", new THREE.Uniform(2.0 / Math.log2(far + 1.0))],
      ]),
    });
    this.camera = opts.camera ?? null;
    this._out = [];
    this.stats = { frames: 0, sources: 0 };
  }

  set mainCamera(c) { if (c) this.camera = c; }
  get mainCamera() { return this.camera; }

  /** `camera.far` changed (the composer never rebuilds the Effect). */
  setCameraFar(far) {
    if (Number.isFinite(far) && far > 0) this.uniforms.get("uFxDistLogFC").value = 2.0 / Math.log2(far + 1.0);
  }

  get amplitude() { return this.uniforms.get("uFxDistAmp").value; }
  set amplitude(v) { if (Number.isFinite(+v)) this.uniforms.get("uFxDistAmp").value = Math.max(0, +v); }

  update(_renderer, _inputBuffer, _deltaTime) {
    const u = this.uniforms;
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    u.get("uFxDistTime").value = (now / 1000) % 1024;
    const cam = this.camera;
    if (cam && Number.isFinite(cam.far)) this.setCameraFar(cam.far);
    const out = collectFxDistortSources(cam, this._out, now);
    const A = u.get("uFxDistA").value;
    const B = u.get("uFxDistB").value;
    for (let i = 0; i < out.length; i++) {
      const s = out[i];
      A[i].set(s.x, s.y, s.r, s.depth);
      B[i].set(s.kind, s.strength, s.phase, s.radiusM ?? 1);
    }
    u.get("uFxDistN").value = out.length;
    this.stats.frames++;
    this.stats.sources = out.length;
  }
}

/** The effect, or null when `?fxDistort` is off for this session. */
export function createFxDistortEffect(opts = {}) {
  const on = typeof opts.enabled === "boolean" ? opts.enabled : fxTier1Enabled("fxDistort");
  if (!on) return null;
  return new FxDistortEffect(opts);
}

/** `window.__fxDistort` live-tuning handle. */
export function installFxDistortHandle(effect) {
  if (typeof window === "undefined" || !effect) return null;
  const h = {
    get amplitude() { return effect.amplitude; },
    set amplitude(v) { effect.amplitude = v; },
    stats: () => ({ ...effect.stats }),
    effect,
  };
  window.__fxDistort = h;
  return h;
}
