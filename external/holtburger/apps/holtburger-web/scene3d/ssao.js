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
// Under `?reversedZ=on` it is reversed (1 near, 0 far): w = n f / (d (f - n) + n).
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

// 2026-11-15 — Milestone 1: Screen-Space Contact Shadows (SSCS)
// 12-step raymarch along view-space light vector in half-res log-depth.
// Default ON; ?sscs=off disables.
export function sscsEnabled(search) {
  try {
    const s = search ?? globalThis.location?.search ?? "";
    const v = (new URLSearchParams(s).get("sscs") || "").toLowerCase();
    return !(v === "off" || v === "0" || v === "false" || v === "no");
  } catch (_) {
    return true;
  }
}

// 2026-11-15 — Milestone 3: Horizon-Based Ground Truth Ambient Occlusion (GTAO)
// 2-slice x 4-step half-res GTAO with view-space bent normals and multi-bounce.
export function gtaoEnabled(qualityFlags, search) {
  try {
    const s = search ?? (typeof window !== "undefined" ? window.location?.search : "") ?? "";
    const v = new URLSearchParams(s).get("gtao");
    if (v != null) {
      const lv = String(v).toLowerCase();
      if (lv === "off" || lv === "0" || lv === "false" || lv === "no") return false;
      if (lv === "on" || lv === "1" || lv === "true" || lv === "yes") return true;
    }
  } catch (_) {}
  return qualityFlags?.gtao !== false && qualityFlags?.ssao !== false;
}

// Jimenez et al. 2016 multi-bounce polynomial preserving crevice color saturation
export function jimenezMultiBounce(visibility, albedo) {
  const v = Math.max(0.0, Math.min(1.0, visibility));
  const evalChannel = (alb) => {
    const a = 2.0404 * alb - 0.3324;
    const b = -4.7951 * alb + 0.6417;
    const c = 2.7552 * alb + 0.6903;
    const poly = ((v * a + b) * v + c) * v;
    return Math.max(v, Math.min(1.0, poly));
  };
  if (typeof albedo === "number") return evalChannel(albedo);
  if (Array.isArray(albedo)) return [evalChannel(albedo[0]), evalChannel(albedo[1]), evalChannel(albedo[2])];
  return evalChannel(0.5);
}

// Lagarde Frostbite specular occlusion formula suppressing unoccluded sky highlights
export function lagardeSpecularOcclusion(ndotv, ao, roughness) {
  const clampedNdotV = Math.max(0.0, Math.min(1.0, ndotv));
  const clampedAo = Math.max(0.0, Math.min(1.0, ao));
  const r = Math.max(0.0, Math.min(1.0, roughness));
  const base = Math.max(0.0, clampedNdotV + clampedAo);
  const exponent = Math.pow(2.0, -16.0 * r - 1.0);
  return Math.max(0.0, Math.min(1.0, Math.pow(base, exponent) - 1.0 + clampedAo));
}

const _defaultSunDir = new THREE.Vector3(60, 80, 30).normalize();
const _sunViewScratch = new THREE.Vector3();

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
uniform vec3 uSunViewDir;
uniform float uSscsStrength;
varying vec2 vUv;
#ifdef USE_REVERSED_DEPTH_BUFFER
// ?reversedZ=on: raw reversed depth (1 near, 0 far / cleared) -> metres.
uniform vec2 uNearFar;
float revW(float d) { return (uNearFar.x * uNearFar.y) / (d * (uNearFar.y - uNearFar.x) + uNearFar.x); }
#endif

float viewW(vec2 uv) {
  float d = texture2D(tDepth, uv).r;
#ifdef USE_REVERSED_DEPTH_BUFFER
  return revW(d);
#else
  return exp2(d * uLogFC) - 1.0;
#endif
}
vec3 viewPos(vec2 uv, float w) {
  vec2 ndc = uv * 2.0 - 1.0;
  return vec3(ndc.x * w / uProj.x, ndc.y * w / uProj.y, -w);
}
vec3 viewPosAt(vec2 uv) { return viewPos(uv, viewW(uv)); }

vec2 octWrap(vec2 v) {
  return (1.0 - abs(v.yx)) * (vec2(greaterThanEqual(v.xy, vec2(0.0))) * 2.0 - 1.0);
}
vec2 octEncode(vec3 n) {
  n /= (abs(n.x) + abs(n.y) + abs(n.z));
  return (n.z >= 0.0) ? n.xy : octWrap(n.xy);
}

void main() {
  float d = texture2D(tDepth, vUv).r;
  // Sky: no AO, and a far sentinel distance for the blur weights. It must fit
  // the RG16F target (max 65504): a larger value may be stored as +Inf, and
  // Inf - Inf in the blur turns the whole sky's AO into NaN.
#ifdef USE_REVERSED_DEPTH_BUFFER
  if (d <= 0.0) { gl_FragColor = vec4(1.0, 6.0e4, 0.0, 1.0); return; }
  float w = revW(d);
#else
  if (d >= 0.99999) { gl_FragColor = vec4(1.0, 6.0e4, 0.0, 1.0); return; }
  float w = exp2(d * uLogFC) - 1.0;
#endif
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

  // Milestone 3 — 2-slice x 4-step Ground-Truth Ambient Occlusion (GTAO) with bent normals
  vec3 bentNormal = N;
  float gtaoVis = 0.0;
  const int NUM_SLICES = 2;
  const int STEPS_PER_SLICE = 4;
  for (int s = 0; s < NUM_SLICES; s++) {
    float phi = float(s) * 1.57079632 + rnd * 3.14159265;
    vec2 sliceDir = vec2(cos(phi), sin(phi));
    float maxH1 = 0.0;
    float maxH2 = 0.0;
    for (int j = 1; j <= STEPS_PER_SLICE; j++) {
      float stepFrac = (float(j) - 0.5 + rnd * 0.25) / float(STEPS_PER_SLICE);
      float stepR = stepFrac * rss;
      vec2 suv1 = vUv + sliceDir * (stepR * t);
      vec2 suv2 = vUv - sliceDir * (stepR * t);
      if (suv1.x >= 0.0 && suv1.x <= 1.0 && suv1.y >= 0.0 && suv1.y <= 1.0) {
        vec3 Q1 = viewPosAt(suv1);
        vec3 delta1 = Q1 - P;
        float d1Len = length(delta1);
        if (d1Len > 0.01 && d1Len < uRadius) {
          float sinH1 = clamp(dot(delta1, N) / d1Len, 0.0, 1.0);
          maxH1 = max(maxH1, sinH1);
        }
      }
      if (suv2.x >= 0.0 && suv2.x <= 1.0 && suv2.y >= 0.0 && suv2.y <= 1.0) {
        vec3 Q2 = viewPosAt(suv2);
        vec3 delta2 = Q2 - P;
        float d2Len = length(delta2);
        if (d2Len > 0.01 && d2Len < uRadius) {
          float sinH2 = clamp(dot(delta2, N) / d2Len, 0.0, 1.0);
          maxH2 = max(maxH2, sinH2);
        }
      }
    }
    float sliceVis = 1.0 - 0.25 * (maxH1 + maxH2);
    gtaoVis += sliceVis;
    bentNormal += vec3(sliceDir * (maxH1 - maxH2), 0.0) * 0.5;
  }
  gtaoVis /= float(NUM_SLICES);
  bentNormal = normalize(bentNormal);
  float gtaoAo = clamp(gtaoVis, 0.0, 1.0);
  ao = min(ao, gtaoAo);

  // Milestone 1 — 12-step screen-space contact shadow raymarch (SSCS)
  // Marches along view-space sun vector uSunViewDir in half-res log depth.
  if (uSscsStrength > 0.0 && w < uFade.y && dot(uSunViewDir, uSunViewDir) > 0.01) {
    const int SSCS_STEPS = 12;
    float minReach = 0.05;
    float maxReach = 1.8;
    float stepSize = (maxReach - minReach) / float(SSCS_STEPS);
    vec3 rayStart = P + N * 0.02;
    float hitSum = 0.0;
    for (int k = 0; k < SSCS_STEPS; k++) {
      float tk = minReach + (float(k) + rnd) * stepSize;
      vec3 Pk = rayStart + uSunViewDir * tk;
      if (Pk.z >= -0.05) break;
      vec2 sUv = (Pk.xy * uProj / (-Pk.z)) * 0.5 + 0.5;
      if (sUv.x < 0.0 || sUv.x > 1.0 || sUv.y < 0.0 || sUv.y > 1.0) continue;
      float sampleW = viewW(sUv);
      float depthDelta = (-Pk.z) - sampleW;
      if (depthDelta > 0.02 && depthDelta < 0.25) {
        float atten = 1.0 - (tk / maxReach);
        hitSum += atten * 0.35;
      }
    }
    float sscs = clamp(1.0 - hitSum * uSscsStrength, 0.0, 1.0);
    ao = min(ao, sscs);
  }

  // Distance fade: AO is a near-field cue.
  ao = mix(ao, 1.0, smoothstep(uFade.x, uFade.y, w));
  vec2 octBent = octEncode(bentNormal);
  gl_FragColor = vec4(ao, w, octBent.x, octBent.y);
}`;

const BLUR_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tAO;
uniform vec2 uRes;
uniform vec2 uDir;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(tAO, vUv);
  float ws = 1.0;
  vec3 s = vec3(c.r, c.b, c.a);
  // Gaussian-ish weights; depth weight relative to the centre's distance.
  float g[5];
  g[0] = 1.0; g[1] = 0.85; g[2] = 0.6; g[3] = 0.35; g[4] = 0.16;
  for (int i = 1; i <= 4; i++) {
    for (int sgn = -1; sgn <= 1; sgn += 2) {
      vec2 suv = vUv + uDir * float(i * sgn) / uRes;
      vec4 q = texture2D(tAO, suv);
      float wd = exp(-abs(q.g - c.g) * 12.0 / max(c.g, 1.0));
      float wt = g[i] * wd;
      s += vec3(q.r, q.b, q.a) * wt;
      ws += wt;
    }
  }
  vec3 blurred = s / ws;
  gl_FragColor = vec4(blurred.x, c.g, blurred.y, blurred.z);
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
    const rtOpts = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
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
      // Milestone 1 — SSCS uniforms
      uSunViewDir: { value: new THREE.Vector3(0, 1, 0) },
      uSscsStrength: { value: sscsEnabled() ? 1.0 : 0.0 },
      // ?reversedZ=on only (the uniform is declared under USE_REVERSED_DEPTH_BUFFER).
      uNearFar: { value: new THREE.Vector2(0.1, 5000) },
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
    this.ran = false;
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
    // `ran` tells the composite whether rtA holds THIS frame's AO: a skipped
    // frame (the top-down ortho camera, no depth yet) leaves an older frame's.
    this.ran = false;
    if (!this.enabled || !u.tDepth.value || !this.camera || !this.camera.isPerspectiveCamera) return;
    const p = this.params;
    const pm = this.camera.projectionMatrix.elements;
    u.uProj.value.set(pm[0], pm[5]);
    u.uLogFC.value = Math.log2(this.camera.far + 1.0);
    u.uNearFar.value.set(this.camera.near, this.camera.far);
    // Pixels per metre at unit distance, in AO-target pixels.
    u.uProjScale.value = 0.5 * u.uRes.value.y * pm[5];
    u.uRadius.value = p.radius;
    u.uIntensity.value = p.intensity;
    u.uBias.value = p.bias;
    u.uFade.value.set(p.fadeStart, p.fadeEnd);
    if (this.camera.matrixWorldInverse) {
      const sunWorld = this.sunDir || globalThis.window?.liveScene3d?.atmosphereLights?.sun?.sunDirection || _defaultSunDir;
      _sunViewScratch.copy(sunWorld).transformDirection(this.camera.matrixWorldInverse).normalize();
      u.uSunViewDir.value.copy(_sunViewScratch);
    }
    u.uSscsStrength.value = this.params.sscsStrength !== undefined ? this.params.sscsStrength : (sscsEnabled() ? 1.0 : 0.0);

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
    this.ran = true;
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
// Milestone 3: Jimenez multi-bounce polynomial preserving crevice color saturation
// and directional bent-normal ambient bounce.
const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tSsao;
uniform float uSsaoStrength;
uniform float uGrassAo;

vec3 evalJimenezMultiBounce(float visibility, vec3 albedo) {
  vec3 a = 2.0404 * albedo - vec3(0.3324);
  vec3 b = -4.7951 * albedo + vec3(0.6417);
  vec3 c = 2.7552 * albedo + vec3(0.6903);
  vec3 poly = ((visibility * a + b) * visibility + c) * visibility;
  return clamp(poly, vec3(visibility), vec3(1.0));
}

vec3 octDecode(vec2 f) {
  vec3 n = vec3(f.x, f.y, 1.0 - abs(f.x) - abs(f.y));
  float t = clamp(-n.z, 0.0, 1.0);
  n.xy += (vec2(greaterThanEqual(n.xy, vec2(0.0))) * -2.0 + 1.0) * t;
  return normalize(n);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec4 ssaoTex = texture2D(tSsao, uv);
  float ao = ssaoTex.r;
  vec3 bentNormal = octDecode(ssaoTex.ba);
  float grass = 1.0 - smoothstep(0.0, 0.02, inputColor.a);
  float k = uSsaoStrength * mix(1.0, uGrassAo, grass);

  // Guard against HDR polynomial overflow
  vec3 clampedAlbedo = clamp(inputColor.rgb, 0.0, 1.0);
  vec3 mbAo = evalJimenezMultiBounce(ao, clampedAlbedo);

  // Directional indirect bounce modulation using bent normal
  // View-space up is (0, 1, 0); bent normal facing upward receives ambient sky bounce
  float skyBounce = clamp(bentNormal.y * 0.35 + 0.65, 0.0, 1.0);
  vec3 directionalMbAo = mix(mbAo * 0.85, mbAo * 1.15, skyBounce);

  vec3 finalRgb = inputColor.rgb * mix(vec3(1.0), directionalMbAo, k);
  outputColor = vec4(finalRgb, mix(inputColor.a, 1.0, grass));
}`;

export function octEncode(nx, ny, nz) {
  const l = Math.abs(nx) + Math.abs(ny) + Math.abs(nz);
  let x = nx / l;
  let y = ny / l;
  if (nz < 0.0) {
    const ox = (1.0 - Math.abs(y)) * (x >= 0.0 ? 1.0 : -1.0);
    const oy = (1.0 - Math.abs(x)) * (y >= 0.0 ? 1.0 : -1.0);
    x = ox; y = oy;
  }
  return [x, y];
}

export function octDecode(ex, ey) {
  let nz = 1.0 - Math.abs(ex) - Math.abs(ey);
  let nx = ex;
  let ny = ey;
  const t = Math.max(0.0, -nz);
  nx += (nx >= 0.0 ? -1.0 : 1.0) * t;
  ny += (ny >= 0.0 ? -1.0 : 1.0) * t;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1.0;
  return [nx / len, ny / len, nz / len];
}

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
    // Runs after the AO pass in the same frame (it is added ahead of the pass
    // that composites it), so `ran` is this frame's.
    this.uniforms.get("uSsaoStrength").value = p.enabled && p.ran ? p.params.strength : 0.0;
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
