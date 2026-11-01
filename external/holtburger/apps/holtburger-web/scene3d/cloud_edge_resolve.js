// scene3d/cloud_edge_resolve.js — `?cloudEdgeResolve` (2026-11-01; DEFAULT ON since the 1070 live A/B the same day, `=off` escapes;
// GLSL not yet compiled on a GPU — see the url-flags.md row). Depth-aware
// temporal upscale of the takram clouds at scene-object silhouettes.
//
// THE ARTIFACT (owner, 1070 vehicle tour 2026-11-01: "notice artifacts from
// balloon when in front of clouds"; stills 07-cruise-chase / 08-bank-chase): a
// noisy white, 4-px-gridded halo around the balloon wherever it is in front of
// clouds, and a gridded trail on the side it is moving away from.
//
// ROOT CAUSE — takram's temporal upscale (vendor/takram-three-clouds,
// src/shaders/cloudsResolve.frag + src/CloudsPass.ts; its README "Known
// issues": "prone to ghosting ... and disocclusion errors on scene objects").
// The clouds march ONE pixel per 4x4 block per frame (a Bayer slot,
// `ceil(w/4) x ceil(h/4)` texels, CloudsPass.setSize); the resolve writes that
// fresh pixel and fills the other 15 from the reprojected history. Three
// things go wrong at a silhouette:
//   1. velocity: `getClosestFragment` takes the NEAREST depth of the 3x3
//      low-res neighbourhood, so sky pixels up to ~8 px around the balloon
//      reproject with the BALLOON's velocity, and that velocity is a
//      static-world reprojection of a point 20-50 m away while the balloon
//      actually moves with the chase camera — history comes from the wrong
//      place;
//   2. clipping: the variance box is built from neighbourhood texels of BOTH
//      sides (balloon texels hold haze only, alpha ~0; sky texels hold cloud),
//      so it is huge and admits the wrong-side history; this project also runs
//      it at gamma 4 (cloud_volume.js, the 2026-08-01 anti-cycling fix), and
//      `clipAABB` tests rgb only — history ALPHA is never clipped;
//   3. disocclusion: sky pixels the balloon just uncovered keep balloon-era
//      history (haze, alpha ~0 = "no cloud here") until their own Bayer slot
//      comes round, up to 16 frames — the gridded trail.
// Away from silhouettes none of this happens, which is why the rest of the sky
// is fine.
//
// THE FIX (opt-in). The resolve pass learns which side of a silhouette a pixel
// is on, with the SAME test the march itself uses (clouds.frag
// getRayDistanceToScene: scene depth < 1 - 1e-7 after the reversed-Z flip =
// "scene", else "sky"):
//   * a tiny R8 pass records each frame's sky/scene map after the resolve
//     (`hbPrevSky`, read by the NEXT frame), so the resolve knows the class the
//     history pixel had when it was written;
//   * uniform 3x3 neighbourhood AND history of the same class → takram's own
//     result, untouched (bit-identical; the common case);
//   * uniform neighbourhood, history of the other class (disocclusion) → this
//     frame's samples only (bilinear low-res), no stale history;
//   * neighbourhood straddling the silhouette → velocity and variance box from
//     the SAME-class texels only (the march position of each low-res texel is
//     known: block centre + the frame's `jitterOffset`), a 4-channel clip
//     (alpha included) at `hbEdgeGamma` (default 2, takram's own), or the
//     same-class mean when the history is of the other class.
// Cost: 1 + 9 depth fetches + 1 class fetch per pixel, +18 at silhouette
// pixels, and one full-res R8 pass. Off (absent flag): nothing is installed.
//
// Live: `window.__cloudEdgeResolve` — `.set(false|true)` (A/B without a
// reload), `.gamma(v)`, `.stats()`.

export const CLOUD_EDGE_GAMMA_DEFAULT = 2;

/** `?cloudEdgeResolve` — DEFAULT ON (owner flip 2026-11-01 after the 1070 live A/B: the gridded fringe around the
 *  balloon against clouds gone, shader compiled clean); `off`/`0`/`false`/`no` turn it off, anything else ON. */
export function cloudEdgeResolveEnabled(search) {
  try {
    const s = search ?? globalThis.location?.search ?? "";
    const v = (new URLSearchParams(s).get("cloudEdgeResolve") || "").trim().toLowerCase();
    return !(v === "off" || v === "0" || v === "false" || v === "no");
  } catch (_) {
    return true;
  }
}

/** `?cloudEdgeGamma=N` (0 < N <= 16) → N, else the default 2. */
export function cloudEdgeGamma(search) {
  try {
    const s = search ?? globalThis.location?.search ?? "";
    const n = Number(new URLSearchParams(s).get("cloudEdgeGamma"));
    if (Number.isFinite(n) && n > 0 && n <= 16) return n;
  } catch (_) { /* default */ }
  return CLOUD_EDGE_GAMMA_DEFAULT;
}

// Anchors in takram's (include-resolved, loop-unrolled) cloudsResolve.frag.
export const ANCHOR_UNIFORM = "uniform vec2 jitterOffset;";
export const ANCHOR_FUNC = "void temporalUpscale(";
export const ANCHOR_CLOSEST = "vec4 depthVelocity = getClosestFragment(lowResCoord);";

const GLSL_UNIFORMS = `
// holtburger ?cloudEdgeResolve (scene3d/cloud_edge_resolve.js)
uniform sampler2D hbSceneDepth;
uniform sampler2D hbPrevSky;
uniform float hbReversedDepth;
uniform float hbEdgeGamma;
uniform float hbEdgeEnable;`;

const GLSL_FUNCS = `// holtburger ?cloudEdgeResolve (scene3d/cloud_edge_resolve.js): the same
// sky/scene test the march uses (clouds.frag getRayDistanceToScene).
bool hbIsSky(const vec2 uv) {
  float d = texture(hbSceneDepth, uv).r;
  if (hbReversedDepth > 0.5) {
    d = 1.0 - d;
  }
  return d >= 1.0 - 1e-7;
}

bool hbWasSky(const vec2 uv) {
  return texture(hbPrevSky, uv).r > 0.5;
}

// Clip all four channels (alpha too) toward the box centre.
vec4 hbClip4(const vec4 center, const vec4 history, const vec4 extent) {
  vec4 v = history - center;
  vec4 u = abs(v) / (extent + 1e-7);
  float m = max(max(u.x, u.y), max(u.z, u.w));
  return m > 1.0 ? center + v / m : history;
}

// true: wrote color (takram's reprojection is skipped); false: takram's path.
bool hbEdgeResolve(const ivec2 lowResCoord, const vec4 closest, out vec4 color) {
  color = vec4(0.0);
  if (hbEdgeEnable < 0.5) {
    return false;
  }
  bool selfSky = hbIsSky(vUv);
  ivec2 lowMax = textureSize(colorBuffer, 0) - 1;
  bool nSky[9];
  float other = 0.0;
  for (int i = 0; i < 9; ++i) {
    ivec2 nc = clamp(lowResCoord + neighborOffsets[i], ivec2(0), lowMax);
    // Where this low-res texel was marched this frame: block centre + jitter.
    vec2 marchUv = (vec2(nc) * 4.0 + 2.0 + jitterOffset) * texelSize;
    nSky[i] = hbIsSky(marchUv);
    if (nSky[i] != selfSky) {
      other += 1.0;
    }
  }
  if (other < 0.5) {
    // Uniform neighbourhood: takram's closest fragment is this side's.
    vec2 prevUv = vUv - closest.gb;
    if (any(lessThan(prevUv, vec2(0.0))) || any(greaterThan(prevUv, vec2(1.0)))) {
      return false; // takram's own rejection path
    }
    if (hbWasSky(prevUv) == selfSky) {
      return false; // coherent history: takram's result stands
    }
    color = texture(colorBuffer, vUv); // disoccluded: this frame's samples only
    return true;
  }
  // Silhouette: velocity and variance box from this side's texels only.
  vec4 m1 = vec4(0.0);
  vec4 m2 = vec4(0.0);
  float n = 0.0;
  vec4 best = vec4(1e7, 0.0, 0.0, 0.0);
  for (int i = 0; i < 9; ++i) {
    if (nSky[i] != selfSky) {
      continue;
    }
    ivec2 nc = clamp(lowResCoord + neighborOffsets[i], ivec2(0), lowMax);
    vec4 c = texelFetch(colorBuffer, nc, 0);
    m1 += c;
    m2 += c * c;
    n += 1.0;
    vec4 dv = texelFetch(depthVelocityBuffer, nc, 0);
    if (dv.r < best.r) {
      best = dv;
    }
  }
  if (n < 0.5) {
    return false;
  }
  vec4 mean = m1 / n;
  vec2 prevUv = vUv - best.gb;
  if (
    any(lessThan(prevUv, vec2(0.0))) ||
    any(greaterThan(prevUv, vec2(1.0))) ||
    hbWasSky(prevUv) != selfSky
  ) {
    color = mean;
    return true;
  }
  vec4 extent = sqrt(max(m2 / n - mean * mean, vec4(0.0))) * hbEdgeGamma;
  color = hbClip4(mean, texture(colorHistoryBuffer, prevUv), extent);
  return true;
}

`;

const GLSL_CALL = `
  // holtburger ?cloudEdgeResolve
  vec4 hbColor;
  if (hbEdgeResolve(lowResCoord, depthVelocity, hbColor)) {
    outputColor = hbColor;
    #ifdef SHADOW_LENGTH
    outputShadowLength = currentShadowLength.r;
    #endif // SHADOW_LENGTH
    return;
  }`;

/**
 * Patch takram's resolve fragment source. Returns the patched source, or null
 * when any anchor is missing or not unique (a vendor update) — the caller then
 * installs nothing and the clouds render exactly as before.
 */
export function patchCloudsResolveSource(src) {
  if (typeof src !== "string") return null;
  const once = (a) => {
    const i = src.indexOf(a);
    return i >= 0 && src.indexOf(a, i + a.length) < 0;
  };
  if (!once(ANCHOR_UNIFORM) || !once(ANCHOR_FUNC) || !once(ANCHOR_CLOSEST)) return null;
  if (src.includes("hbEdgeResolve")) return null; // already patched
  return src
    .replace(ANCHOR_UNIFORM, ANCHOR_UNIFORM + GLSL_UNIFORMS)
    .replace(ANCHOR_FUNC, GLSL_FUNCS + ANCHOR_FUNC)
    .replace(ANCHOR_CLOSEST, ANCHOR_CLOSEST + GLSL_CALL);
}

// The sky/scene map pass (one R8 write per pixel).
export const CLASS_FRAG = `precision highp float;

uniform sampler2D hbSceneDepth;
uniform float hbReversedDepth;

in vec2 vUv;

layout(location = 0) out vec4 outputColor;

void main() {
  float d = texture(hbSceneDepth, vUv).r;
  if (hbReversedDepth > 0.5) {
    d = 1.0 - d;
  }
  outputColor = vec4(d >= 1.0 - 1e-7 ? 1.0 : 0.0, 0.0, 0.0, 1.0);
}
`;

/**
 * Install on a takram CloudsEffect. Returns a handle or null (nothing changed).
 * @param {object} effect  CloudsEffect (needs .cloudsPass with resolveMaterial,
 *   currentMaterial, resolvePass, update)
 * @param {object} THREE   the three namespace
 * @param {{gamma?: number, warn?: Function}} [opts]
 */
export function installCloudEdgeResolve(effect, THREE, opts = {}) {
  const warn = typeof opts.warn === "function"
    ? opts.warn
    : (m) => { try { console.warn(m); } catch (_) { /* no console */ } };
  const cp = effect && effect.cloudsPass;
  const rm = cp && cp.resolveMaterial;
  const cm = cp && cp.currentMaterial;
  const PassCtor = cp && cp.resolvePass && cp.resolvePass.constructor;
  if (!rm || !cm || !cm.uniforms || !cm.uniforms.depthBuffer || typeof PassCtor !== "function" || typeof cp.update !== "function") {
    warn("[clouds] cloudEdgeResolve: takram clouds pass shape not recognised — NOT installed");
    return null;
  }
  const patched = patchCloudsResolveSource(rm.fragmentShader);
  if (!patched) {
    warn("[clouds] cloudEdgeResolve: resolve shader anchors not found — NOT installed");
    return null;
  }
  const gamma = Number.isFinite(opts.gamma) && opts.gamma > 0 ? opts.gamma : CLOUD_EDGE_GAMMA_DEFAULT;
  const depthUniform = cm.uniforms.depthBuffer; // SHARED: setDepthTexture updates both
  const reversed = new THREE.Uniform(0);
  const enable = new THREE.Uniform(1);
  const gammaU = new THREE.Uniform(gamma);
  const classRT = new THREE.WebGLRenderTarget(1, 1, {
    depthBuffer: false,
    type: THREE.UnsignedByteType,
    format: THREE.RedFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    generateMipmaps: false,
  });
  classRT.texture.name = "Clouds.hbPrevSky";
  const classMat = new THREE.RawShaderMaterial({
    name: "HbCloudsSkyClass",
    glslVersion: THREE.GLSL3,
    vertexShader: rm.vertexShader, // takram's fullscreen vert (vUv)
    fragmentShader: CLASS_FRAG,
    uniforms: { hbSceneDepth: depthUniform, hbReversedDepth: reversed },
    depthTest: false,
    depthWrite: false,
  });
  const classPass = new PassCtor(classMat);

  rm.fragmentShader = patched;
  rm.uniforms.hbSceneDepth = depthUniform;
  rm.uniforms.hbPrevSky = new THREE.Uniform(classRT.texture);
  rm.uniforms.hbReversedDepth = reversed;
  rm.uniforms.hbEdgeGamma = gammaU;
  rm.uniforms.hbEdgeEnable = enable;
  rm.needsUpdate = true;

  const state = { user: true };
  const stats = {
    installed: true, gamma, frames: 0, classPasses: 0, width: 0, height: 0,
    reversedDepth: false, packedDepthSkips: 0, lastError: null,
  };
  const RGBA_PACKING = THREE.RGBADepthPacking ?? 3201;
  const origUpdate = cp.update;
  cp.update = function hbCloudEdgeResolveUpdate(renderer, frame, deltaTime) {
    stats.frames += 1;
    // The resolve inside origUpdate reads LAST frame's class map with this
    // frame's depth convention; the class pass after it records this frame's.
    let on = state.user;
    if (cm.depthPacking === RGBA_PACKING) {
      on = false; // packed depth: our raw .r read would be wrong
      stats.packedDepthSkips += 1;
    }
    let rev = false;
    try { rev = renderer?.state?.buffers?.depth?.getReversed?.() === true; } catch (_) { rev = false; }
    reversed.value = rev ? 1 : 0;
    stats.reversedDepth = rev;
    enable.value = on ? 1 : 0;
    const out = origUpdate.call(this, renderer, frame, deltaTime);
    if (!on) return out;
    try {
      const w = this.width | 0;
      const h = this.height | 0;
      if (w > 0 && h > 0 && (classRT.width !== w || classRT.height !== h)) classRT.setSize(w, h);
      stats.width = classRT.width;
      stats.height = classRT.height;
      const prev = renderer.getRenderTarget();
      classPass.render(renderer, null, classRT);
      renderer.setRenderTarget(prev);
      stats.classPasses += 1;
    } catch (e) {
      stats.lastError = String(e && e.message ? e.message : e);
    }
    return out;
  };

  return {
    stats: () => ({ ...stats, enabled: state.user, gamma: gammaU.value }),
    set(v) { state.user = v !== false && v !== 0 && v !== "off"; return state.user; },
    gamma(v) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0 && n <= 16) gammaU.value = n;
      return gammaU.value;
    },
    dispose() {
      cp.update = origUpdate;
      enable.value = 0;
      try { classRT.dispose(); } catch (_) { /* fail-soft */ }
      try { classMat.dispose(); } catch (_) { /* fail-soft */ }
    },
  };
}
