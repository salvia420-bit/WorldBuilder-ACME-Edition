// scene3d/ssao.js — screen-space ambient occlusion (`?ssao`, 2026-10-07).
//
// Owner look pass on the GTX 1070: with sun shadows working again the town
// finally had a key light, but nothing grounded it — walls met the grass with
// no contact darkening, eaves and window recesses read flat, every crease was
// lit like an open field. This adds the missing ambient term: SAO (McGuire et
// al. 2012, "Scalable Ambient Obscurance") from the depth buffer alone.
//
//   SsaoPass (before the [Clouds, AerialPerspective] pass):
//     1. AO at HALF resolution into an RG16F target: R = obscurance, G = the
//        decoded view distance (for the blur weights). 12 taps on a golden-angle
//        spiral, per-pixel rotated by interleaved gradient noise; normals from
//        the nearer of the two neighbour depth taps per axis (no normal pass, no
//        extra scene render, no edge halos from dFdx).
//     2. Two separable 9-tap DEPTH-AWARE blur passes (H then V) at half res.
//   SsaoCompositeEffect (first effect of that pass, i.e. before aerial
//   perspective, so distant haze is never darkened): colour *= mix(1, ao, k).
//
// Depth is the composer's stable depth copy (pmndrs `EffectComposer.StableDepth`,
// handed in by `setDepthTexture` because `needsDepthTexture` is true) and is
// LOGARITHMIC (index.js `logarithmicDepthBuffer: true`): three writes
// gl_FragDepth = log2(1 + w) / log2(far + 1), so w = exp2(d * log2(far + 1)) - 1.
//
// Cost on the 1070 at 1920x1080: ~0.5 M half-res pixels x (12 + 4) depth taps
// + 2 x 9 blur taps. Live tuning: `window.__ssao` (radius / intensity / bias /
// strength / fadeStart / fadeEnd / off).

import * as THREE from "three";
import { BlendFunction, Effect, Pass } from "postprocessing";

/** `?ssao=on|off` beats the quality preset's `ssao` (true at high / ultra). */
export function ssaoEnabled(qualityFlags, search) {
  try {
    const s = search ?? (typeof window !== "undefined" ? window.location?.search : "") ?? "";
    const v = new URLSearchParams(s).get("ssao");
    if (v != null) {
      const lv = String(v).toLowerCase();
      if (lv === "off" || lv === "0" || lv === "false" || lv === "no") return false;
      if (lv === "on" || lv === "1" || lv === "true" || lv === "yes") return true;
    }
  } catch (_) { /* fall through to the preset */ }
  return qualityFlags?.ssao === true;
}

export const SSAO_DEFAULTS = Object.freeze({
  radius: 1.1,       // metres — the contact / crease scale (a door jamb, a wall foot)
  intensity: 1.15,
  bias: 0.012,       // metres along the normal; kills flat-ground self-occlusion
  strength: 0.85,    // composite blend (0 = off, 1 = full obscurance)
  fadeStart: 45,     // metres: AO fades out with distance (it is a near-field cue)
  fadeEnd: 110,
  grassAo: 0.25,     // fraction of the AO a grass blade (marked pixel) receives
});

const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const SAO_FRAG = /* glsl */ `
precision highp float;
uniform highp sampler2D tDepth;
uniform vec2 uRes;
uniform float uLogFC;
uniform vec2 uProj;
uniform float uRadius;
uniform float uIntensity;
uniform float uBias;
uniform float uProjScale;
uniform vec2 uFade;
varying vec2 vUv;

float viewW(vec2 uv) {
  float d = texture2D(tDepth, uv).r;
  return exp2(d * uLogFC) - 1.0;
}
vec3 viewPos(vec2 uv, float w) {
  vec2 ndc = uv * 2.0 - 1.0;
  return vec3(ndc.x * w / uProj.x, ndc.y * w / uProj.y, -w);
}
vec3 viewPosAt(vec2 uv) { return viewPos(uv, viewW(uv)); }

void main() {
  float d = texture2D(tDepth, vUv).r;
  if (d >= 0.99999) { gl_FragColor = vec4(1.0, 1.0e6, 0.0, 1.0); return; }
  float w = exp2(d * uLogFC) - 1.0;
  if (w > uFade.y) { gl_FragColor = vec4(1.0, w, 0.0, 1.0); return; }
  vec3 P = viewPos(vUv, w);
  // Normal from the nearer neighbour per axis (avoids smearing across an edge).
  vec2 t = 1.0 / uRes;
  vec3 pr = viewPosAt(vUv + vec2(t.x, 0.0));
  vec3 pl = viewPosAt(vUv - vec2(t.x, 0.0));
  vec3 pu = viewPosAt(vUv + vec2(0.0, t.y));
  vec3 pd = viewPosAt(vUv - vec2(0.0, t.y));
  vec3 dx = abs(pr.z - P.z) < abs(P.z - pl.z) ? pr - P : P - pl;
  vec3 dy = abs(pu.z - P.z) < abs(P.z - pd.z) ? pu - P : P - pd;
  vec3 N = normalize(cross(dx, dy));
  if (dot(N, -P) < 0.0) N = -N;

  // Interleaved gradient noise rotates the spiral per pixel.
  float rnd = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float rss = uProjScale * uRadius / w;          // spiral radius in AO pixels
  float r2 = uRadius * uRadius;
  float sum = 0.0;
  const int K = 12;
  for (int i = 0; i < K; i++) {
    float a = (float(i) + 0.5) / float(K);
    float ang = a * 6.2831853 * 7.0 + rnd * 6.2831853;
    vec2 off = vec2(cos(ang), sin(ang)) * (rss * a);
    vec2 suv = vUv + off * t;
    if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) continue;
    vec3 Q = viewPosAt(suv);
    vec3 v = Q - P;
    float vv = dot(v, v);
    float vn = dot(v, N);
    float f = max(r2 - vv, 0.0);
    sum += f * f * f * max((vn - uBias) / (0.01 + vv), 0.0);
  }
  float ao = max(0.0, 1.0 - sum * uIntensity * (5.0 / (r2 * r2 * r2 * float(K))));
  // Distance fade: AO is a near-field cue.
  ao = mix(ao, 1.0, smoothstep(uFade.x, uFade.y, w));
  gl_FragColor = vec4(ao, w, 0.0, 1.0);
}`;

const BLUR_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tAO;
uniform vec2 uRes;
uniform vec2 uDir;
varying vec2 vUv;
void main() {
  vec2 c = texture2D(tAO, vUv).rg;
  float ws = 1.0;
  float s = c.r;
  // Gaussian-ish weights; depth weight relative to the centre's distance.
  float g[5];
  g[0] = 1.0; g[1] = 0.85; g[2] = 0.6; g[3] = 0.35; g[4] = 0.16;
  for (int i = 1; i <= 4; i++) {
    for (int sgn = -1; sgn <= 1; sgn += 2) {
      vec2 suv = vUv + uDir * float(i * sgn) / uRes;
      vec2 q = texture2D(tAO, suv).rg;
      float wd = exp(-abs(q.g - c.g) * 12.0 / max(c.g, 1.0));
      float wt = g[i] * wd;
      s += q.r * wt;
      ws += wt;
    }
  }
  gl_FragColor = vec4(s / ws, c.g, 0.0, 1.0);
}`;

function fsMaterial(frag, uniforms) {
  return new THREE.ShaderMaterial({
    vertexShader: FS_VERT,
    fragmentShader: frag,
    uniforms,
    depthTest: false,
    depthWrite: false,
  });
}

export class SsaoPass extends Pass {
  constructor(camera, opts = {}) {
    super("SsaoPass");
    this.needsSwap = false;
    this.needsDepthTexture = true;
    this.camera = camera;
    this.params = { ...SSAO_DEFAULTS, ...opts };
    this.enabled = true;
    const rtOpts = { type: THREE.HalfFloatType, format: THREE.RGFormat, depthBuffer: false, stencilBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
    this.rtA = new THREE.WebGLRenderTarget(1, 1, rtOpts);
    this.rtB = new THREE.WebGLRenderTarget(1, 1, rtOpts);
    this.rtA.texture.name = "Ssao.A";
    this.rtB.texture.name = "Ssao.B";
    this.saoMat = fsMaterial(SAO_FRAG, {
      tDepth: { value: null },
      uRes: { value: new THREE.Vector2(1, 1) },
      uLogFC: { value: Math.log2(5001) },
      uProj: { value: new THREE.Vector2(1, 1) },
      uRadius: { value: this.params.radius },
      uIntensity: { value: this.params.intensity },
      uBias: { value: this.params.bias },
      uProjScale: { value: 500 },
      uFade: { value: new THREE.Vector2(this.params.fadeStart, this.params.fadeEnd) },
    });
    this.blurMat = fsMaterial(BLUR_FRAG, {
      tAO: { value: null },
      uRes: { value: new THREE.Vector2(1, 1) },
      uDir: { value: new THREE.Vector2(1, 0) },
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.saoMat);
    this.quad.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.quad);
    this.orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.stats = { frames: 0 };
  }

  /** The blurred half-res AO texture the composite effect samples. */
  get texture() { return this.rtA.texture; }

  setDepthTexture(depthTexture /* , depthPacking */) {
    this.saoMat.uniforms.tDepth.value = depthTexture;
  }

  setCamera(cam) { if (cam) this.camera = cam; }

  setSize(width, height) {
    const w = Math.max(1, Math.round(width / 2)), h = Math.max(1, Math.round(height / 2));
    this.rtA.setSize(w, h);
    this.rtB.setSize(w, h);
    this.saoMat.uniforms.uRes.value.set(w, h);
    this.blurMat.uniforms.uRes.value.set(w, h);
  }

  render(renderer /* , inputBuffer, outputBuffer */) {
    const u = this.saoMat.uniforms;
    if (!this.enabled || !u.tDepth.value || !this.camera || !this.camera.isPerspectiveCamera) return;
    const p = this.params;
    const pm = this.camera.projectionMatrix.elements;
    u.uProj.value.set(pm[0], pm[5]);
    u.uLogFC.value = Math.log2(this.camera.far + 1.0);
    // Pixels per metre at unit distance, in AO-target pixels.
    u.uProjScale.value = 0.5 * u.uRes.value.y * pm[5];
    u.uRadius.value = p.radius;
    u.uIntensity.value = p.intensity;
    u.uBias.value = p.bias;
    u.uFade.value.set(p.fadeStart, p.fadeEnd);

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    // 1) AO -> A
    this.quad.material = this.saoMat;
    renderer.setRenderTarget(this.rtA);
    renderer.render(this.scene, this.orthoCam);
    // 2) blur H: A -> B, 3) blur V: B -> A
    this.quad.material = this.blurMat;
    this.blurMat.uniforms.tAO.value = this.rtA.texture;
    this.blurMat.uniforms.uDir.value.set(1, 0);
    renderer.setRenderTarget(this.rtB);
    renderer.render(this.scene, this.orthoCam);
    this.blurMat.uniforms.tAO.value = this.rtB.texture;
    this.blurMat.uniforms.uDir.value.set(0, 1);
    renderer.setRenderTarget(this.rtA);
    renderer.render(this.scene, this.orthoCam);
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
    this.stats.frames += 1;
  }

  dispose() {
    this.rtA.dispose(); this.rtB.dispose();
    this.saoMat.dispose(); this.blurMat.dispose();
    this.quad.geometry.dispose();
  }
}

// Grass blades mark themselves with alpha 0 (ssao_marker.js): they get only
// uGrassAo of the obscurance, and alpha goes back to 1 here, before any later
// effect or the canvas sees it.
const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tSsao;
uniform float uSsaoStrength;
uniform float uGrassAo;
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  float ao = texture2D(tSsao, uv).r;
  float grass = 1.0 - smoothstep(0.0, 0.02, inputColor.a);
  float k = uSsaoStrength * mix(1.0, uGrassAo, grass);
  outputColor = vec4(inputColor.rgb * mix(1.0, ao, k), mix(inputColor.a, 1.0, grass));
}`;

export class SsaoCompositeEffect extends Effect {
  constructor(ssaoPass) {
    super("SsaoCompositeEffect", COMPOSITE_FRAG, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map([
        ["tSsao", new THREE.Uniform(ssaoPass.texture)],
        ["uSsaoStrength", new THREE.Uniform(ssaoPass.params.strength)],
        ["uGrassAo", new THREE.Uniform(ssaoPass.params.grassAo)],
      ]),
    });
    this._pass = ssaoPass;
  }
  update() {
    const p = this._pass;
    this.uniforms.get("tSsao").value = p.texture;
    this.uniforms.get("uSsaoStrength").value = p.enabled ? p.params.strength : 0.0;
    this.uniforms.get("uGrassAo").value = p.params.grassAo;
  }
}

/** `window.__ssao` live handle. */
export function installSsaoHandle(pass) {
  if (typeof window === "undefined" || !pass) return null;
  const h = {
    get params() { return pass.params; },
    set(o) { Object.assign(pass.params, o || {}); return { ...pass.params }; },
    get off() { return !pass.enabled; },
    set off(v) { pass.enabled = !v; },
    stats: () => ({ ...pass.stats, enabled: pass.enabled, size: [pass.rtA.width, pass.rtA.height] }),
    pass,
  };
  window.__ssao = h;
  return h;
}
