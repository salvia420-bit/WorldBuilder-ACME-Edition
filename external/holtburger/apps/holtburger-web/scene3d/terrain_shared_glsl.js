// scene3d/terrain_shared_glsl.js — the SHARED terrain lighting + fog tail.
//
// WHY THIS FILE EXISTS (far-terrain design §2.4, "anti-fork guarantee").
// The Far Composite Ring draws distant landblocks with a ~40-line shader that
// samples a pre-baked albedo composite. For the near/far seam to be invisible,
// the far shader's LIGHTING must be the same arithmetic the 2,100-line monolith
// runs — not "the same idea", the same characters. So the load-bearing tail is
// extracted here as GLSL strings and interpolated into BOTH programs. A shader-
// source diff can then prove the tail is character-identical in both consumers,
// which is the checkable form of "don't fork the logic".
//
// Everything here is a pure function of its arguments — no uniforms are read
// except the three.js-injected fog uniforms, which are declared under the
// renderer's own `USE_FOG` define so a scene with `scene.fog === null` compiles
// byte-identically to the pre-feature shader.
//
// ⚠ GLSL rules for anyone editing this file:
//   - NEVER put a backtick inside these template literals (it terminates the
//     string and takes the whole boot down with a syntax error).
//   - The monolith is at 16/16 fragment texture units (the WebGL2 guaranteed
//     minimum). NOTHING added here may declare a sampler.

// ---------------------------------------------------------------------------
// Lighting tail — interpolated into the terrain monolith fragment shader
// (scene3d/terrain.js) and the far-patch fragment shader
// (scene3d/far_terrain.js).
// ---------------------------------------------------------------------------
//
// `terrainSunNdotl`   — the wrap-lit lambert term. The monolith feeds it the
//                       RNM-combined detail normal (which mips to the flat
//                       tangent base (0,0,1) long before the near/far seam) and
//                       the geometry normal for the FU-2 slope relief; the far
//                       shader feeds it exactly the same two normals.
// `terrainAcGouraud`  — retail `CLandBlockStruct::calc_lighting`
//                       (acclient.c:353886-353899). DEFAULT-ON via
//                       ?terrainGouraud, so this — not `terrainApplyLight` — is
//                       where most of the shipped terrain light actually lives.
//                       It multiplies the ALBEDO, which is why the far bake must
//                       run with uAcGouraudEnabled forced to 0 and re-apply this
//                       live (see far_terrain.js "albedo-only" contract).
// `terrainApplyLight` — the final shadowed multiply. Kept as a function purely
//                       so the far shader provably runs the same expression;
//                       cloudShadow/csmShadow are both structurally 1.0 past the
//                       seam (cloud shadow cascade 0 covers ~10% of view
//                       distance; `csmShadowFactor` returns 1.0 for
//                       viewDepth > uCsmFar, ~300 m), so the far shader passes
//                       literal 1.0 for both and spends no sampler on them.
export const TERRAIN_LIGHT_TAIL_GLSL = /* glsl */ `
// ==== SHARED TERRAIN LIGHTING TAIL (scene3d/terrain_shared_glsl.js) ====
// Interpolated character-identically into the terrain monolith and the far
// composite ring. Do not edit one consumer's copy — there is only one copy.

// Wrap-lighting bias so unlit faces do not go pure black: terrain shading is
// otherwise unmodulated, so a pure cosine produces too much contrast at sunset
// orientations. Both n and sunDirAc are AC-space (z-up) unit vectors.
float terrainSunNdotl(vec3 n, vec3 sunDirAc) {
  return mix(0.65, 1.0, clamp(dot(n, sunDirAc), 0.0, 1.0));
}

// Retail Gouraud terrain colour, verbatim CLandBlockStruct::calc_lighting:
//   L = max(0, N . sunlight_vec)                  // |sunlight_vec| == dirBright
//   c = min(1, sun_c * L + amb_c * ambient_level) // per channel, no low clamp
// acLightNormal is the RAW interpolated retail normal (never renormalised —
// dot() must stay linear across each retail triangle so the GPU's Gouraud
// interpolation reproduces retail's per-vertex colour lerp).
vec3 terrainAcGouraud(vec3 albedo, vec3 acLightNormal, vec3 acSunVec,
                      vec3 acSunColor, vec3 acAmbColor, float acAmbLevel) {
  float acL = max(0.0, dot(acLightNormal, acSunVec));
  vec3 acC = min(vec3(1.0), acSunColor * acL + acAmbColor * acAmbLevel);
  return albedo * acC;
}

// The shadowed multiply. Separate from terrainAcGouraud because cloud/CSM
// shadow are screen-driven and must never be baked into a composite.
vec3 terrainApplyLight(vec3 albedo, float ndotl, float cloudShadow, float csmShadow) {
  return albedo * ndotl * cloudShadow * csmShadow;
}
// ==== end SHARED TERRAIN LIGHTING TAIL ====
`;

// ---------------------------------------------------------------------------
// Fog tail — RETAIL RANGE FOG (FARCRIT-2 reconciliation (a)).
// ---------------------------------------------------------------------------
//
// Retail closed its horizon with fixed-function LINEAR fog authored in the DAT
// (`SkyDesc::GetWorldFog`, acclient.c:301602 — min/max/colour lerped between
// bracketing SkyTimeOfDay entries; Dereth clear day = 150 -> 2400 m,
// 0xFFC3C8DC). That mechanism is ~90% plumbed in this repo already:
//   - wasm exposes SkyState.fogMin / fogMax / fogColorArgbLerp,
//   - loop.js::tickDistanceFogColor already writes scene.fog.{near,far,color},
//   - statics/models already compile <fog_fragment>.
// The ONE hole was that the terrain ShaderMaterial had no fog code at all, so
// `scene.fog` has never affected the ground. This closes it.
//
// three's chunk is PLANE-based (`-mvPosition.z`); retail set
// D3DRS_RANGEFOGENABLE (radial). We deliberately match THREE, not retail, so
// terrain and statics cannot disagree with each other at a shared silhouette
// edge. Radial can be offered later behind its own flag if the corner-of-screen
// difference is ever visible.
//
// The arithmetic below is character-for-character three's <fog_fragment>, hand-
// written because the terrain shader is GLSL3 with a custom `out` (fragColor)
// and the stock chunk targets `gl_FragColor`. The uniforms ARE three's own
// injected ones (`fogColor`/`fogNear`/`fogFar`/`fogDensity`) — the renderer
// drives them via refreshFogUniforms() for any material with `fog === true`,
// in the same colour space as every other material in the frame.
//
// `USE_FOG` / `FOG_EXP2` are renderer-set defines. With `scene.fog === null`
// (the shipped default before this wave) neither is defined, the uniform block
// vanishes and terrainApplyFog() is an identity return — i.e. flag-off is
// provably byte-identical.
export const TERRAIN_FOG_TAIL_GLSL = /* glsl */ `
// ==== SHARED TERRAIN FOG TAIL (scene3d/terrain_shared_glsl.js) ====
// Retail range fog. Same uniforms + same arithmetic as three's <fog_fragment>,
// so terrain, statics and models fog identically at a shared silhouette edge.
#ifdef USE_FOG
  uniform vec3 fogColor;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif

// viewDepth is -mvPos.z (three's vFogDepth) — the terrain shader already
// carries it as vViewDepth, so no new varying is added anywhere.
vec3 terrainApplyFog(vec3 rgb, float viewDepth) {
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * viewDepth * viewDepth );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, viewDepth );
  #endif
  return mix( rgb, fogColor, fogFactor );
#else
  return rgb;
#endif
}
// ==== end SHARED TERRAIN FOG TAIL ====
`;

/**
 * The two shared strings concatenated, in the order both consumers insert them.
 * Exported as one value so a validator can assert equality with a single read
 * (`window.__farTerrainState().sharedTail`).
 */
export const TERRAIN_SHARED_TAIL_GLSL =
  TERRAIN_LIGHT_TAIL_GLSL + TERRAIN_FOG_TAIL_GLSL;

/**
 * Cheap stable 32-bit hash of a string (FNV-1a). Used only to publish a
 * fingerprint of the shared tail on the probe surface so the validator can
 * confirm both programs carry the same bytes without diffing 2,100 lines.
 * @param {string} s
 * @returns {string} 8-char lowercase hex
 */
export function glslFingerprint(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
