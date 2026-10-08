// scene3d/layered_haze.js — `?layerHaze` (2026-10-08, DEFAULT strength 0.4;
// `=off` escape, `=<0..1>` sets the strength).
//
// Owner on the 1070, distant hills: "they should look like something out of
// princess mononoke" -> picked "layered blue haze", then "something in the
// middle" between the 0.3 / 0.5 arms. Painted landscapes separate their ridges
// with atmosphere: each farther range a little lighter and bluer, mist pooling
// in the low ground while crests stand out. Aerial perspective (takram) is the
// physical part of that and stays as it is; this is the painterly part.
//
// A post pass over EVERYTHING the scene drew (terrain, trees, buildings — a
// terrain-only haze left the objects popping out unhazed in front of it). Per
// pixel: decode the view distance from the composer's stable LOG depth
// (w = exp2(d * log2(far + 1)) - 1, as ssao.js), rebuild the world position,
// then
//   haze = strength * (1 - exp(-max(dist - near, 0) / distScale))
//                   * mix(0.3, 1.0, exp(-max(altitude, 0) / heightScale))
// toward the scene's fog colour (the horizon sky radiance loop.js probes — grey
// under overcast, blue under clear sky) shifted toward blue. Sky pixels (depth
// at the far plane) and sky-blocked cells (dungeons) pass through. One
// full-screen pass, no new scene render; sits after the clouds/aerial
// perspective pass and before bloom/tone mapping (HDR in, HDR out).

import * as THREE from "three";
import { Pass } from "postprocessing";

export const LAYER_HAZE_DEFAULT = 0.4;
export const LAYER_HAZE_DEFAULTS = Object.freeze({
  nearM: 250,          // no haze nearer than this
  distScaleM: 1400,    // e-folding distance beyond nearM
  heightScaleM: 120,   // e-folding altitude (AC metres): low ground hazes more
  blue: 0.85,          // 0 = the fog colour as is, 1 = shifted fully blue
  maxHaze: 0.85,
});

/** Strength in [0, 1]; 0 = off. `?layerHaze=off` / a number. */
export function layerHazeStrength(search) {
  try {
    const s = search ?? (typeof window !== "undefined" ? window.location?.search : "") ?? "";
    const v = new URLSearchParams(s).get("layerHaze");
    if (v == null || v === "") return LAYER_HAZE_DEFAULT;
    const lv = String(v).toLowerCase();
    if (lv === "off" || lv === "false" || lv === "no") return 0;
    if (lv === "on" || lv === "true" || lv === "yes") return LAYER_HAZE_DEFAULT;
    const n = Number(lv);
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : LAYER_HAZE_DEFAULT;
  } catch (_) {
    return LAYER_HAZE_DEFAULT;
  }
}

/** JS mirror of the shader's haze amount (tests + live diagnostics). */
export function layerHazeAmount(strength, distM, altitudeM, p = LAYER_HAZE_DEFAULTS) {
  if (!(strength > 0)) return 0;
  const far = 1 - Math.exp(-Math.max(distM - p.nearM, 0) / Math.max(p.distScaleM, 1));
  const low = Math.exp(-Math.max(altitudeM, 0) / Math.max(p.heightScaleM, 1));
  return Math.min(p.maxHaze, Math.max(0, strength * far * (0.3 + 0.7 * low)));
}

export const LAYER_HAZE_FRAG = /* glsl */ `
uniform sampler2D inputBuffer;
uniform sampler2D tDepth;
uniform float uLogFar;
uniform float uSkyM;
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform vec3 uHazeColor;
uniform vec4 uHaze;      // strength, nearM, distScaleM, heightScaleM
uniform vec2 uHazeTone;  // blue shift, max haze
varying vec2 vUv;
void main() {
  vec4 src = texture2D(inputBuffer, vUv);
  if (uHaze.x <= 0.0) { gl_FragColor = src; return; }
  float w = exp2(texture2D(tDepth, vUv).r * uLogFar) - 1.0;
  if (w >= uSkyM) { gl_FragColor = src; return; }
  vec4 r = uInvProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 ray = r.xyz / r.w;
  vec3 vpos = ray * (w / max(-ray.z, 1e-4));
  vec3 wpos = (uCamWorld * vec4(vpos, 1.0)).xyz;
  float far = 1.0 - exp(-max(length(vpos) - uHaze.y, 0.0) / max(uHaze.z, 1.0));
  float low = exp(-max(wpos.y, 0.0) / max(uHaze.w, 1.0));
  float h = clamp(uHaze.x * far * mix(0.3, 1.0, low), 0.0, uHazeTone.y);
  vec3 hc = mix(uHazeColor, uHazeColor * vec3(0.80, 0.93, 1.20), uHazeTone.x);
  gl_FragColor = vec4(mix(src.rgb, hc, h), src.a);
}`;

const VERT = "varying vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 1.0, 1.0); }";

/**
 * The pass. `opts.getFogColor()` -> THREE.Color | null (the haze tint source),
 * `opts.isSkyBlocked()` -> boolean (dungeons: no haze).
 */
export class LayeredHazePass extends Pass {
  constructor(camera, opts = {}) {
    super("LayeredHazePass");
    this.needsSwap = true;
    this.needsDepthTexture = true;
    this.camera = camera; // pmndrs Pass.mainCamera is a no-op setter — keep our own
    this.strength = Number.isFinite(opts.strength) ? opts.strength : layerHazeStrength();
    this.params = { ...LAYER_HAZE_DEFAULTS, ...(opts.params || {}) };
    this.getFogColor = typeof opts.getFogColor === "function" ? opts.getFogColor : () => null;
    this.isSkyBlocked = typeof opts.isSkyBlocked === "function" ? opts.isSkyBlocked : () => false;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        inputBuffer: { value: null },
        tDepth: { value: null },
        uLogFar: { value: Math.log2(5001) },
        uSkyM: { value: 4500 },
        uInvProj: { value: new THREE.Matrix4() },
        uCamWorld: { value: new THREE.Matrix4() },
        uHazeColor: { value: new THREE.Color(0.6, 0.7, 0.85) },
        uHaze: { value: new THREE.Vector4() },
        uHazeTone: { value: new THREE.Vector2() },
      },
      vertexShader: VERT,
      fragmentShader: LAYER_HAZE_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.quad);
    this.orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.stats = { frames: 0 };
  }

  setDepthTexture(depthTexture /* , depthPacking */) {
    this.material.uniforms.tDepth.value = depthTexture;
  }

  setCamera(cam) { if (cam) this.camera = cam; }

  render(renderer, inputBuffer, outputBuffer) {
    const u = this.material.uniforms;
    u.inputBuffer.value = inputBuffer ? inputBuffer.texture : null;
    const cam = this.camera;
    let strength = this.strength;
    try { if (this.isSkyBlocked()) strength = 0; } catch (_) { /* haze on */ }
    if (!u.tDepth.value || !cam || !cam.isPerspectiveCamera) strength = 0;
    if (cam) {
      u.uLogFar.value = Math.log2(cam.far + 1.0);
      u.uSkyM.value = cam.far * 0.9;
      u.uInvProj.value.copy(cam.projectionMatrixInverse);
      u.uCamWorld.value.copy(cam.matrixWorld);
    }
    try { const c = this.getFogColor(); if (c && c.isColor) u.uHazeColor.value.copy(c); } catch (_) { /* last colour */ }
    const p = this.params;
    u.uHaze.value.set(strength, p.nearM, p.distScaleM, p.heightScaleM);
    u.uHazeTone.value.set(p.blue, p.maxHaze);
    renderer.setRenderTarget(this.renderToScreen ? null : outputBuffer);
    renderer.render(this.scene, this.orthoCam);
    this.stats.frames += 1;
  }

  dispose() {
    this.material.dispose();
    this.quad.geometry.dispose();
  }
}

/** `window.__layerHaze` — live A/B: { strength, params, set(o) }. */
export function installLayerHazeHandle(pass) {
  if (typeof window === "undefined") return;
  window.__layerHaze = pass
    ? {
      get strength() { return pass.strength; },
      set strength(v) { pass.strength = Math.min(1, Math.max(0, Number(v) || 0)); },
      params: pass.params,
      stats: () => ({ ...pass.stats, strength: pass.strength, params: { ...pass.params } }),
    }
    : null;
}
