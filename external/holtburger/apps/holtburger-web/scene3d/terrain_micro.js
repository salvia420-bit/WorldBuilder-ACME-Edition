// scene3d/terrain_micro.js — TERRAIN FINE SURFACE DETAIL (step 4 of the
// owner-approved terrain plan, 2026-10-07). Visual only: every term here is a
// SHADING or SAMPLING change. No geometry moves; physics and the server keep
// standing on the retail triangles.
//
// Owner, on the plan: "we are rounding by half meters when inches would give
// the look". Steps 1-2 (scene3d/terrain_round.js) softened the creases. This
// module is the "inches": centimetre-scale relief and cleaner sampling within
// roughly 0-75 m of the camera, all of it gone by the time the far composite
// ring takes over (that ring starts several landblocks out).
//
// ===========================================================================
// AUDIT (2026-10-07, read from source + the real textures; quality=ultra)
// ===========================================================================
// What actually SHADES the shipped ground is the retail Gouraud term
// (`?terrainGouraud`, default ON): albedo x min(1, sun*max(0, N.sun) + amb),
// with N = the bevelled retail per-vertex normal. Every per-pixel normal term
// in terrain.js sits behind `!acGouraud`, so in a default session:
//   * the Phase 1.2 detail-normal array (5 x 1024^2, ~9 MB download that
//     init3D AWAITS, ~20 MB GPU) shades NOTHING;
//   * the BC7 nra material normal + AO (registered to the albedo, derived from
//     it) shades NOTHING; neither does the triplanar block.
// So the ground near the player had zero sub-cell light/shade response. Also:
//   * the procedural detail normals are millimetre-scale (1.5 m tile of a
//     1024^2 map = 1.5 mm/texel; grass features ~6 mm) and mip to flat by
//     ~20 m. They read as sparkle, not as pebbles or clumps.
//   * atlasUvFor() wraps with fract() and each cell restarts at 0, so the
//     implicit UV derivative jumps a whole tile at every 12 m tile wrap and
//     24 m cell edge. The 2x2 quads on those lines pick the 1x1 mip: a 2 px
//     line of the tile's MEAN colour on a 12 m grid. Since ?maskMips (default
//     ON, 2026-08-02) the TexMerge masks do the same at cell edges (a line of
//     ~25% overlay where the edge should be pure base).
//   * the retail detail crossfade (0x05001786 -> RenderSurface 0x06006D57,
//     256^2 grey noise, alpha ~0.21, 6 m period) is mixed in LINEAR space.
//     Retail blended in the gamma-encoded framebuffer. Linear mixing toward a
//     mid-grey lifts dark ground: dark grass (sRGB 0.22) near the camera came
//     out ~20% brighter than retail. That is the "washed near ground"
//     gradient over the 10-50 m fade.
//   * TexMerge transitions are a linear alpha ramp: no height interplay
//     between the two materials (no grass settling between rocks).
//
// ===========================================================================
// WHAT THIS MODULE ADDS (each behind its own flag; url-flags.md rows)
// ===========================================================================
// 1. MICRO-RELIEF on the Gouraud normal (`?terrainMicro`, DEFAULT ON).
//    The bevel's output normal gets a small tangent-plane perturbation:
//      n' = n + |n| (E sx + N sy)      E, N = east/north tangents of n
//    LINEAR in the slope (no renormalisation), so dot(n', sun) is the retail
//    value plus a zero-mean term: the AVERAGE brightness is unchanged and
//    mip-filtering the slope is exactly equivalent to averaging the shading.
//    That is what keeps the near/far seam and the fade invisible. Sources:
//      a. MATERIAL relief: the nra normal (BC7 arm: derived from the retail
//         albedo, so the light follows the pebbles and clumps you can SEE),
//         composited through the SAME TexMerge mask weights as the albedo.
//      b. PROCEDURAL relief: the existing 5-slice detail-normal array at two
//         scales (2.4 m axis-aligned + 7.68 m rotated 36.87 deg). Both tile
//         counts are snapped so the pattern is seamless across landblocks
//         with LB-local UVs (world-space UVs lose ~4 mm of float precision at
//         Dereth's coordinates). Two slices blend by corner weight, which is
//         continuous where the nearest-corner code switches.
//      c. SLOPE ROCK: steep ground (28-49 deg) leans toward the stone slice.
//    Distance curve: full strength nearer than 20 m, smoothstep to 0 at 75 m.
// 2. HEIGHT-BLEND transitions (`?terrainHeightBlend`, DEFAULT ON). Inside the
//    TexMerge loop the overlay weight is shifted by the two layers' mean-
//    centred heights (atlas alpha = the BC7/CC0 POM height) and sharpened.
//    A band limiter keeps authored full coverage (0 / 1) exactly untouched;
//    water and road slots are skipped; fades out 30 -> 90 m, so the far bake
//    (vViewDepth ~1000) is unchanged.
// 3. GAMMA-SPACE retail detail crossfade (`?terrainDetailGamma`, DEFAULT ON).
// 4. EXPLICIT-GRADIENT atlas / nra / mask taps (`?terrainGradUv`, DEFAULT ON):
//    textureGrad with the derivative of the CONTINUOUS grid UV, the standard
//    fix for fract() mip seams. Also stops POM's per-step offset jumps from
//    blowing up the mip selection.
//
// TEXTURE UNITS: nothing here declares a sampler. It reads uAtlas,
// uAtlasNormalAo, uAlphaMasks and uTerrainDetailNormalArray, all of which the
// terrain program already declares and references (15 of the 1070's 16
// fragment units, see cells.js). A new sampler would turn terrain black.
//
// Live tuning (every registered terrain material, per-LB and the batch):
//   window.__terrainMicro.set({ strength, fadeStartM, fadeEndM, material,
//     procedural, rock, fineTileM, coarseTileM, hbAmount, hbGain, hbSharp,
//     hbFadeStartM, hbFadeEndM })
//   window.__terrainMicro.live()   window.__terrainMicro.config
//
// NOTE: no backticks inside the GLSL template literals below (they would end
// the string and take the boot down).

/** Defaults — the numbers the url-flags.md rows document. */
export const TERRAIN_MICRO_DEFAULTS = Object.freeze({
  // micro-relief
  strength: 1,
  fadeStartM: 20,
  fadeEndM: 75,
  material: 2,
  procedural: 0.25,
  rock: 0.6,
  fineTileM: 2.4,   // 80 repeats per 192 m landblock
  coarseTileM: 7.68, // 25 per landblock (a multiple of 5: the 3-4-5 rotation stays seamless)
  // height blend
  hbAmount: 1,
  hbGain: 3,
  hbSharp: 0.15,
  hbFadeStartM: 30,
  hbFadeEndM: 90,
});

/** Detail-normal slice the slope-rock term leans toward (terrain.js DETAIL_SLICE_STONE). */
export const MICRO_ROCK_SLICE = 3;

/** Slope (1 - n.z) band of the slope-rock term: 0.12 ~ 28 deg, 0.35 ~ 49 deg. */
export const MICRO_ROCK_SLOPE = Object.freeze([0.12, 0.35]);

const LB_M = 192;
const CELLS_PER_LB = 8;

function _param(search, name) {
  try {
    if (typeof search === "string") return new URLSearchParams(search).get(name);
    if (typeof window === "undefined" || !window.location) return null;
    return new URLSearchParams(window.location.search || "").get(name);
  } catch (_) {
    return null;
  }
}

function _finite(raw) {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function _off(raw) {
  if (typeof raw !== "string" || raw === "") return false;
  const v = raw.toLowerCase();
  return v === "off" || v === "0" || v === "false" || v === "no";
}

function _on(raw) {
  return typeof raw === "string" && raw.toLowerCase() === "on";
}

function _clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** "A,B" -> [A, B]; "B" -> [B/3, B]; else null. Metres, >= 0, B > A. */
function _fadePair(raw) {
  if (typeof raw !== "string" || raw === "") return null;
  const parts = raw.split(",").map((p) => _finite(p.trim()));
  let a;
  let b;
  if (parts.length >= 2 && parts[0] != null && parts[1] != null) {
    a = Math.max(0, parts[0]);
    b = Math.max(0, parts[1]);
  } else if (parts[0] != null) {
    b = Math.max(0, parts[0]);
    a = b / 3;
  } else {
    return null;
  }
  // GLSL smoothstep(e0, e1, x) is undefined for e0 >= e1.
  if (!(b > a + 0.001)) b = a + 0.001;
  return [a, b];
}

/**
 * Snap the two procedural tile sizes so LB-local UVs are seamless across a
 * landblock edge: the fine (axis-aligned) tap needs an integer number of
 * repeats per 192 m, the coarse tap is rotated by atan(3/4) = 36.87 deg, so
 * its repeat count must be a multiple of 5 (then R * (count, 0) = (0.8, 0.6)
 * * count is an integer vector too). Returns repeats PER 24 m CELL (the unit
 * of vGridUv) plus the snapped sizes in metres.
 */
export function snapMicroTiles(fineM, coarseM) {
  const f = Math.max(1, Math.round(LB_M / Math.max(0.05, fineM)));
  const c = 5 * Math.max(1, Math.round(LB_M / (5 * Math.max(0.05, coarseM))));
  return { fine: f / CELLS_PER_LB, coarse: c / CELLS_PER_LB, fineM: LB_M / f, coarseM: LB_M / c, finePerLb: f, coarsePerLb: c };
}

/**
 * Resolve the config from a query string (default: the page URL). All four
 * features are DEFAULT-ON; off/0/false/no is the escape. `?terrainMicro=<n>`
 * and `?terrainHeightBlend=<n>` double as strength knobs, and `=on` forces the
 * feature on the `low` quality tier too (where it is otherwise held at 0).
 *
 * @param {string} [search] e.g. "?terrainMicro=0.5&terrainMicroFade=10,60"
 */
export function readTerrainMicroConfig(search) {
  const D = TERRAIN_MICRO_DEFAULTS;
  const source = {};
  const note = (name, raw) => {
    if (typeof raw === "string" && raw !== "") source[name] = raw;
  };

  // --- 1. micro-relief ---
  const rawMicro = _param(search, "terrainMicro");
  note("terrainMicro", rawMicro);
  const micro = !_off(rawMicro);
  const microForced = _on(rawMicro);
  let strength = D.strength;
  const nMicro = _finite(rawMicro);
  if (micro && nMicro != null) strength = _clamp(nMicro, 0, 3);
  let fadeStartM = D.fadeStartM;
  let fadeEndM = D.fadeEndM;
  const rawFade = _param(search, "terrainMicroFade");
  note("terrainMicroFade", rawFade);
  const fp = _fadePair(rawFade);
  if (fp) [fadeStartM, fadeEndM] = fp;
  const num = (name, dflt, lo, hi) => {
    const raw = _param(search, name);
    note(name, raw);
    const n = _finite(raw);
    return n == null ? dflt : _clamp(n, lo, hi);
  };
  const material = num("terrainMicroMaterial", D.material, 0, 6);
  const procedural = num("terrainMicroDetail", D.procedural, 0, 2);
  const rock = num("terrainMicroRock", D.rock, 0, 1);
  let fineTileM = D.fineTileM;
  let coarseTileM = D.coarseTileM;
  const rawTile = _param(search, "terrainMicroTile");
  note("terrainMicroTile", rawTile);
  if (typeof rawTile === "string" && rawTile !== "") {
    const parts = rawTile.split(",").map((p) => _finite(p.trim()));
    if (parts[0] != null) fineTileM = _clamp(parts[0], 0.25, 48);
    if (parts.length >= 2 && parts[1] != null) coarseTileM = _clamp(parts[1], 0.25, 96);
  }
  const tiles = snapMicroTiles(fineTileM, coarseTileM);

  // --- 2. height blend ---
  const rawHb = _param(search, "terrainHeightBlend");
  note("terrainHeightBlend", rawHb);
  const heightBlend = !_off(rawHb);
  const heightBlendForced = _on(rawHb);
  let hbAmount = D.hbAmount;
  const nHb = _finite(rawHb);
  if (heightBlend && nHb != null) hbAmount = _clamp(nHb, 0, 1);
  const hbGain = num("terrainHeightBlendGain", D.hbGain, 0, 10);
  const hbSharp = num("terrainHeightBlendSharp", D.hbSharp, 0.02, 0.5);
  let hbFadeStartM = D.hbFadeStartM;
  let hbFadeEndM = D.hbFadeEndM;
  const rawHbFade = _param(search, "terrainHeightBlendFade");
  note("terrainHeightBlendFade", rawHbFade);
  const hfp = _fadePair(rawHbFade);
  if (hfp) [hbFadeStartM, hbFadeEndM] = hfp;

  // --- 3. gamma-space retail detail crossfade ---
  const rawGamma = _param(search, "terrainDetailGamma");
  note("terrainDetailGamma", rawGamma);
  const detailGamma = !_off(rawGamma);

  // --- 4. explicit-gradient atlas / nra / mask taps ---
  const rawGrad = _param(search, "terrainGradUv");
  note("terrainGradUv", rawGrad);
  const gradUv = !_off(rawGrad);

  return {
    micro, microForced, strength, fadeStartM, fadeEndM, material, procedural, rock,
    fineTileM: tiles.fineM, coarseTileM: tiles.coarseM, tiles,
    heightBlend, heightBlendForced, hbAmount, hbGain, hbSharp, hbFadeStartM, hbFadeEndM,
    detailGamma, gradUv,
    source,
  };
}

/** The session config (module load, like every sibling terrain flag). */
export const TERRAIN_MICRO = readTerrainMicroConfig();

/**
 * Is a tier-gated feature live for this quality preset? `low` holds micro-
 * relief and the height blend at 0 (the terrain-VFX plan's "null on low"
 * contract; they cost extra taps) unless the URL forced them with `=on`.
 */
export function terrainMicroTierOn(preset, which = "micro", cfg = TERRAIN_MICRO) {
  if (!cfg) return false;
  if (which === "heightBlend") return !!cfg.heightBlend && (cfg.heightBlendForced || preset !== "low");
  return !!cfg.micro && (cfg.microForced || preset !== "low");
}

// ---------------------------------------------------------------------------
// JS mirrors of the shader maths (tests + diag). Keep in lock-step with the
// GLSL below.
// ---------------------------------------------------------------------------

function _smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Distance fade: 1 nearer than start, smoothstep to 0 at end. */
export function microFadeAt(depthM, startM, endM) {
  return 1 - _smoothstep(startM, endM, depthM);
}

/**
 * terrainMicroPerturb(): n + |n| (E sx + N sy). `n` is the (unnormalised)
 * bevelled retail normal; E is the east tangent of n, N = n x E (north).
 */
export function microPerturbNormal(n, slope) {
  const len = Math.hypot(n[0], n[1], n[2]);
  if (len < 1e-4) return n.slice();
  const u = [n[0] / len, n[1] / len, n[2] / len];
  let e = [u[2], 0, -u[0]];
  const el = Math.hypot(e[0], e[1], e[2]);
  if (el < 1e-4) return n.slice();
  e = e.map((c) => c / el);
  const b = [u[1] * e[2] - u[2] * e[1], u[2] * e[0] - u[0] * e[2], u[0] * e[1] - u[1] * e[0]];
  return [0, 1, 2].map((k) => n[k] + len * (e[k] * slope[0] + b[k] * slope[1]));
}

/**
 * The two-slice procedural blend: primary = the slice of the heaviest corner
 * that HAS a real slice (< 5), with the summed weight of every corner sharing
 * it; secondary = the heaviest corner with a different real slice. Continuous
 * wherever the heaviest corner switches, because the pair (and their weights)
 * just swap roles. No-detail corners (water / swamp, 255) never take a slot,
 * so they cannot push a real slice out (they only contribute zero weight).
 * `slices` / `weights` are the 4 corners (00, 10, 01, 11).
 */
export function microSliceWeights(slices, weights) {
  let s1 = 255;
  let best1 = -1;
  for (let i = 0; i < 4; i += 1) {
    if (slices[i] < 5 && weights[i] > best1) { best1 = weights[i]; s1 = slices[i]; }
  }
  let s2 = 255;
  let best2 = -1;
  for (let i = 0; i < 4; i += 1) {
    if (slices[i] < 5 && slices[i] !== s1 && weights[i] > best2) { best2 = weights[i]; s2 = slices[i]; }
  }
  const sum = (s) => (s < 5 ? slices.reduce((acc, si, i) => acc + (si === s ? weights[i] : 0), 0) : 0);
  return { s1, w1: sum(s1), s2, w2: sum(s2) };
}

/** terrainHeightBlendW(): height-shifted, sharpened, band-limited base weight. */
export function heightBlendWeight(baseW, hBase, hOver, amt, gain, sharp) {
  const x = baseW + (hBase - hOver) * gain;
  const d = Math.max(sharp, 0.01);
  const hw = _smoothstep(0.5 - d, 0.5 + d, x);
  const band = Math.min(1, Math.max(0, 6 * baseW * (1 - baseW)));
  return baseW + (hw - baseW) * (amt * band);
}

export function linToSrgb(c) {
  const v = Math.max(0, c);
  return v < 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}
export function srgbToLin(c) {
  const v = Math.max(0, c);
  return v < 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
/** terrainDetailGammaMix(): retail's framebuffer (gamma-space) crossfade, in linear in/out. */
export function detailGammaMix(baseLin, detailLin, a) {
  return srgbToLin(linToSrgb(baseLin) * (1 - a) + linToSrgb(detailLin) * a);
}

// ---------------------------------------------------------------------------
// GLSL. terrain.js interpolates each string only when its feature is on, so
// `?terrainMicro=off&terrainHeightBlend=off&terrainDetailGamma=off` compiles
// none of it (the sampling helpers below stay: with ?terrainGradUv=off they
// are plain texture() calls, behaviour-identical to the pre-wave program).
// ---------------------------------------------------------------------------

/** Atlas / nra / mask sampling helpers (global scope, after maskUvFor). */
export function terrainSamplingGlsl(gradUv) {
  if (!gradUv) {
    return `
// 2026-10-07 (terrain step 4) — atlas / nra / mask taps through one helper
// each (scene3d/terrain_micro.js). ?terrainGradUv=off: implicit derivatives,
// identical to the pre-wave samples.
vec4 terrainAtlasTex(int code, vec2 cellUv) {
  return texture(uAtlas, atlasUvFor(code, cellUv));
}
vec4 terrainNraTex(int code, vec2 cellUv) {
  return texture(uAtlasNormalAo, atlasUvFor(code, cellUv));
}
vec4 terrainMaskTex(vec2 cellUv, int rot, int maskIdx) {
  return texture(uAlphaMasks, vec3(maskUvFor(cellUv, rot), float(maskIdx)));
}
`;
  }
  return `
// 2026-10-07 (terrain step 4, ?terrainGradUv) — EXPLICIT-GRADIENT atlas, nra
// and mask taps (scene3d/terrain_micro.js). atlasUvFor() wraps with fract()
// and each 24 m cell restarts its UV at 0, so the IMPLICIT derivative of the
// sampled UV jumps by a whole tile at every 12 m wrap and every cell edge and
// the 2x2 quads on those lines pick the 1x1 mip: a 2 px line of the tile's
// mean colour on a 12 m grid (masks: a line of the mask's mean coverage on
// the cell edges). The derivative of the CONTINUOUS grid UV, times the
// tiling, is the true footprint, so mip and anisotropy choice are unchanged
// everywhere else. The gradients are taken once at the top of main(), in
// uniform control flow; POM's per-step offset jumps no longer reach the mip
// selection either. No new sampler.
vec2 gTerrainGridDx;
vec2 gTerrainGridDy;
vec4 terrainAtlasTex(int code, vec2 cellUv) {
  float tiling = float(uBaseTexTiling[clamp(code, 0, 32)]);
  return textureGrad(uAtlas, atlasUvFor(code, cellUv),
                     gTerrainGridDx * tiling, gTerrainGridDy * tiling);
}
vec4 terrainNraTex(int code, vec2 cellUv) {
  float tiling = float(uBaseTexTiling[clamp(code, 0, 32)]);
  return textureGrad(uAtlasNormalAo, atlasUvFor(code, cellUv),
                     gTerrainGridDx * tiling, gTerrainGridDy * tiling);
}
vec4 terrainMaskTex(vec2 cellUv, int rot, int maskIdx) {
  // maskUvFor is affine in cellUv (a 90 deg step rotation + a flip), so the
  // finite difference through it IS the mapped gradient, rotation included.
  vec2 m = maskUvFor(cellUv, rot);
  return textureGrad(uAlphaMasks, vec3(m, float(maskIdx)),
                     maskUvFor(cellUv + gTerrainGridDx, rot) - m,
                     maskUvFor(cellUv + gTerrainGridDy, rot) - m);
}
`;
}

/** First statements of main() when ?terrainGradUv is on. */
export const TERRAIN_GRADUV_MAIN_GLSL = `
  // 2026-10-07 — continuous-UV gradients for the terrainAtlasTex / Nra / Mask
  // helpers (scene3d/terrain_micro.js). Uniform control flow: first in main().
  gTerrainGridDx = dFdx(vGridUv);
  gTerrainGridDy = dFdy(vGridUv);
`;

/** Gamma-space crossfade helpers (global scope). */
export const TERRAIN_DETAIL_GAMMA_GLSL = `
// 2026-10-07 (terrain step 4, ?terrainDetailGamma) — retail mixed the landscape
// detail tile in the GAMMA-ENCODED framebuffer (fixed-function SRCALPHA /
// INVSRCALPHA, no sRGB framebuffer). result here is linear and the detail
// texel is sRGB-decoded, so a plain mix() is a LINEAR crossfade toward a
// mid-grey: it lifts dark ground (~20% on dark grass at the camera). Encode,
// mix, decode reproduces the retail operation exactly. sRGB curve as three's.
vec3 terrainLinToSrgb(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
vec3 terrainSrgbToLin(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
vec3 terrainDetailGammaMix(vec3 base, vec3 detailLin, float a) {
  return terrainSrgbToLin(mix(terrainLinToSrgb(base), terrainLinToSrgb(detailLin), a));
}
`;

/** The crossfade statement, per mode (terrain.js detail-tex branch). */
export const TERRAIN_DETAIL_GAMMA_MIX_GLSL =
  "if (amtA > 0.0) result = terrainDetailGammaMix(result, detail.rgb, amtA);";
export const TERRAIN_DETAIL_LINEAR_MIX_GLSL = "result = mix(result, detail.rgb, amtA);";

/** Micro-relief uniforms + helpers (global scope, after the sampling helpers). */
export const TERRAIN_MICRO_FRAG_GLSL = `
// 2026-10-07 (terrain step 4, ?terrainMicro) — MICRO-RELIEF on the retail
// Gouraud normal (scene3d/terrain_micro.js header). The perturbation is
// LINEAR in the slope, so dot(n, sun) gains a zero-mean term: the average
// brightness and the far look are unchanged, and a mip-filtered slope is
// exactly the averaged shading.
uniform vec2 uMicroFade;     // metres: full strength nearer than x, 0 beyond y
uniform vec4 uMicroAmt;      // x overall (0 = off), y material relief, z procedural, w slope rock
uniform vec2 uMicroTiles;    // procedural repeats per 24 m cell: x fine, y coarse (rotated)
// The albedo-registered material relief: the nra tangent normal XY (BC7 arm:
// derived from the retail albedo itself; xy = (-dh/deast, -dh/dnorth)).
vec2 terrainMicroNra(int code, vec2 cellUv) {
  return terrainNraTex(clamp(code, 0, 32), cellUv).rg * 2.0 - 1.0;
}
// One detail-normal slice at two scales. LB-LOCAL grid UVs (vGridUv): the
// tile counts are snapped on the JS side so both taps repeat an integer
// number of times per landblock (the coarse one in a 3-4-5 rotated frame),
// i.e. seamless at every 192 m edge without world-space float precision loss.
vec2 terrainMicroSlice(int slice, vec2 g) {
  vec2 uvF = g * uMicroTiles.x;
  vec2 uvC = vec2(0.8 * g.x - 0.6 * g.y, 0.6 * g.x + 0.8 * g.y) * uMicroTiles.y;
  vec2 f = texture(uTerrainDetailNormalArray, vec3(uvF, float(slice))).rg * 2.0 - 1.0;
  vec2 c = texture(uTerrainDetailNormalArray, vec3(uvC, float(slice))).rg * 2.0 - 1.0;
  // The coarse tap's slope is in the rotated frame: rotate it back (R^T).
  c = vec2(0.8 * c.x + 0.6 * c.y, -0.6 * c.x + 0.8 * c.y);
  return 0.5 * f + c;
}
// n + |n| (E sx + N sy). n is NOT renormalised (retail's interpolated normal
// carries meaning in its length), and E is well defined because a heightfield
// normal always has n.z > 0.
vec3 terrainMicroPerturb(vec3 n, vec2 slope) {
  float len = length(n);
  if (len < 1.0e-4) return n;
  vec3 nu = n / len;
  vec3 e = vec3(nu.z, 0.0, -nu.x);
  float el = length(e);
  if (el < 1.0e-4) return n;
  e /= el;
  vec3 b = cross(nu, e);
  return n + len * (e * slope.x + b * slope.y);
}
`;

/** main(): declarations before the TexMerge composite. */
export const TERRAIN_MICRO_DECL_GLSL = `
  // 2026-10-07 (?terrainMicro) — micro-relief state. The material relief is
  // composited by the TexMerge loop below with the SAME mask weights as the
  // albedo (microMerged), or bilinear over the four corners when the merge
  // path did not run. microRoad = road-slot coverage (procedural relief
  // stands down under painted roads; the road tile brings its own nra).
  bool microNear = uMicroAmt.x > 0.0 && vViewDepth < uMicroFade.y;
  bool microMat = microNear && uMicroAmt.y > 0.0 && uPbrEnabled > 0.5;
  vec2 microMerged = vec2(0.0);
  bool microMergedSet = false;
  float microRoad = 0.0;
`;

/** TexMerge: right after the base slot's albedo sample. */
export const TERRAIN_MICRO_MERGE_BASE_GLSL = `
    microMergedSet = true;
    if (microMat) {
      microMerged = terrainMicroNra(baseLayer, isWaterCode(baseLayer) ? waterCellUv : cellUv);
    }`;

/** TexMerge loop: before the albedo mix (after the height blend, if any). */
export const TERRAIN_MICRO_MERGE_SLOT_GLSL = `
        if (microMat) {
          microMerged = mix(terrainMicroNra(layer, isWaterCode(layer) ? waterCellUv : cellUv),
                            microMerged, baseW);
        }
        if (s >= 4) microRoad = mix(1.0, microRoad, baseW);`;

/** The Gouraud site: perturbs acShadeN (the bevelled retail normal). */
export const TERRAIN_MICRO_APPLY_GLSL = `
    // 2026-10-07 (?terrainMicro) — micro-relief on the bevelled normal.
    if (microNear) {
      vec2 microSlope = vec2(0.0);
      if (microMat) {
        if (!microMergedSet) {
          microMerged = terrainMicroNra(t00, uv00) * w00 + terrainMicroNra(t10, uv10) * w10
                      + terrainMicroNra(t01, uv01) * w01 + terrainMicroNra(t11, uv11) * w11;
        }
        microSlope += microMerged * uMicroAmt.y;
      }
      if (uMicroAmt.z > 0.0 && uDetailNormalEnabled > 0.5) {
        // Two-slice blend by corner weight: the heaviest REAL-slice corner and
        // the heaviest corner with a different real slice. Continuous where
        // the heaviest corner switches (the pair swaps roles), unlike the
        // single nearest-corner slice; no-detail corners (255: water, swamp)
        // never take a slot, so they cannot push a real slice out.
        int ms00 = uCodeToSlice[clamp(t00, 0, 31)];
        int ms10 = uCodeToSlice[clamp(t10, 0, 31)];
        int ms01 = uCodeToSlice[clamp(t01, 0, 31)];
        int ms11 = uCodeToSlice[clamp(t11, 0, 31)];
        int ms1 = 255;
        float mBest = -1.0;
        if (ms00 < 5 && w00 > mBest) { mBest = w00; ms1 = ms00; }
        if (ms10 < 5 && w10 > mBest) { mBest = w10; ms1 = ms10; }
        if (ms01 < 5 && w01 > mBest) { mBest = w01; ms1 = ms01; }
        if (ms11 < 5 && w11 > mBest) { mBest = w11; ms1 = ms11; }
        int ms2 = 255;
        mBest = -1.0;
        if (ms00 != ms1 && ms00 < 5 && w00 > mBest) { mBest = w00; ms2 = ms00; }
        if (ms10 != ms1 && ms10 < 5 && w10 > mBest) { mBest = w10; ms2 = ms10; }
        if (ms01 != ms1 && ms01 < 5 && w01 > mBest) { mBest = w01; ms2 = ms01; }
        if (ms11 != ms1 && ms11 < 5 && w11 > mBest) { mBest = w11; ms2 = ms11; }
        vec2 microDet = vec2(0.0);
        if (ms1 < 5) {
          float mw1 = (ms00 == ms1 ? w00 : 0.0) + (ms10 == ms1 ? w10 : 0.0)
                    + (ms01 == ms1 ? w01 : 0.0) + (ms11 == ms1 ? w11 : 0.0);
          microDet += terrainMicroSlice(ms1, vGridUv) * mw1;
        }
        if (ms2 < 5) {
          float mw2 = (ms00 == ms2 ? w00 : 0.0) + (ms10 == ms2 ? w10 : 0.0)
                    + (ms01 == ms2 ? w01 : 0.0) + (ms11 == ms2 ? w11 : 0.0);
          microDet += terrainMicroSlice(ms2, vGridUv) * mw2;
        }
        // Slope rock: steep ground leans toward the stone slice.
        float microRock = uMicroAmt.w * smoothstep(${MICRO_ROCK_SLOPE[0].toFixed(2)}, ${MICRO_ROCK_SLOPE[1].toFixed(2)}, 1.0 - geomN.z);
        if (microRock > 0.0) {
          microDet = mix(microDet, terrainMicroSlice(${MICRO_ROCK_SLICE}, vGridUv), microRock);
        }
        microSlope += microDet * (uMicroAmt.z * (1.0 - microRoad));
      }
      float microFade = 1.0 - smoothstep(uMicroFade.x, uMicroFade.y, vViewDepth);
      acShadeN = terrainMicroPerturb(acShadeN, microSlope * (uMicroAmt.x * microFade * (1.0 - waterW)));
    }`;

/** Height-blend uniforms + helpers (global scope, after the sampling helpers). */
export const TERRAIN_HEIGHT_BLEND_FRAG_GLSL = `
// 2026-10-07 (terrain step 4, ?terrainHeightBlend) — HEIGHT-BLEND TexMerge
// transitions (scene3d/terrain_micro.js). The overlay weight is shifted by the
// two layers' MEAN-CENTRED heights (atlas alpha = the POM height bake; the
// 1x1 mip is the layer mean) and sharpened around 0.5. The band limiter
// 6 w (1 - w) is 0 at authored full coverage, so a mask's solid interior
// never changes; only the transition reshapes. Faded by distance, so the far
// composite bake (vViewDepth ~1000) is exactly the linear composite.
uniform vec4 uHeightBlend;      // x amount (0 = off), y height gain, z sharpness half-band
uniform vec2 uHeightBlendFade;  // metres: full nearer than x, gone beyond y
float terrainHbHeight(int code, vec2 cellUv) {
  int c = clamp(code, 0, 32);
  return terrainAtlasTex(c, cellUv).a - terrainTypeMeanTex(c).a;
}
float terrainHeightBlendW(float baseW, float hBase, float hOver, float amt) {
  float x = baseW + (hBase - hOver) * uHeightBlend.y;
  float d = max(uHeightBlend.z, 0.01);
  float hw = smoothstep(0.5 - d, 0.5 + d, x);
  float band = clamp(6.0 * baseW * (1.0 - baseW), 0.0, 1.0);
  return mix(baseW, hw, amt * band);
}
`;

/** main(): declarations before the TexMerge composite. */
export const TERRAIN_HEIGHT_BLEND_DECL_GLSL = `
  // 2026-10-07 (?terrainHeightBlend) — needs the height bake in uAtlas alpha,
  // which exists exactly when the nra array does (uPbrEnabled; retail RGBA8
  // layers hold A = 255).
  float hbAmt = 0.0;
  if (uHeightBlend.x > 0.0 && uPbrEnabled > 0.5 && vViewDepth < uHeightBlendFade.y) {
    hbAmt = uHeightBlend.x * (1.0 - smoothstep(uHeightBlendFade.x, uHeightBlendFade.y, vViewDepth));
  }
  // hbH = the running composite's centred height, fetched LAZILY by the first
  // overlay that needs it (most near cells have no overlay at all).
  float hbH = 0.0;
  bool hbHSet = false;
`;

/** TexMerge loop: first thing before the albedo mix. Terrain slots only. */
export const TERRAIN_HEIGHT_BLEND_MERGE_SLOT_GLSL = `
        if (hbAmt > 0.0 && s < 4 && !isWaterCode(layer) && !isWaterCode(baseLayer)) {
          if (!hbHSet) { hbH = terrainHbHeight(baseLayer, cellUv); hbHSet = true; }
          float hbO = terrainHbHeight(layer, cellUv);
          baseW = terrainHeightBlendW(baseW, hbH, hbO, hbAmt);
          hbH = mix(hbO, hbH, baseW);
        }`;

/** Global-scope helper block for the session config. */
export function terrainDetailFragGlsl(cfg = TERRAIN_MICRO) {
  return (
    terrainSamplingGlsl(!!cfg.gradUv) +
    (cfg.detailGamma ? TERRAIN_DETAIL_GAMMA_GLSL : "") +
    (cfg.micro ? TERRAIN_MICRO_FRAG_GLSL : "") +
    (cfg.heightBlend ? TERRAIN_HEIGHT_BLEND_FRAG_GLSL : "")
  );
}

// ---------------------------------------------------------------------------
// Live uniforms
// ---------------------------------------------------------------------------

const _live = {
  strength: TERRAIN_MICRO.strength,
  fadeStartM: TERRAIN_MICRO.fadeStartM,
  fadeEndM: TERRAIN_MICRO.fadeEndM,
  material: TERRAIN_MICRO.material,
  procedural: TERRAIN_MICRO.procedural,
  rock: TERRAIN_MICRO.rock,
  fineTileM: TERRAIN_MICRO.fineTileM,
  coarseTileM: TERRAIN_MICRO.coarseTileM,
  hbAmount: TERRAIN_MICRO.hbAmount,
  hbGain: TERRAIN_MICRO.hbGain,
  hbSharp: TERRAIN_MICRO.hbSharp,
  hbFadeStartM: TERRAIN_MICRO.hbFadeStartM,
  hbFadeEndM: TERRAIN_MICRO.hbFadeEndM,
};

/**
 * Uniform entries for a NEW terrain ShaderMaterial (spread into its
 * `uniforms`; cloned into the batch material like every other uniform).
 * Only the features whose GLSL is compiled get entries. `preset` is the
 * quality preset name (`low` holds micro + height blend at 0 unless forced).
 * `THREE` needs Vector2 + Vector4.
 */
export function terrainMicroUniforms(THREE, preset, cfg = TERRAIN_MICRO) {
  const out = {};
  if (!cfg || !THREE || typeof THREE.Vector2 !== "function" || typeof THREE.Vector4 !== "function") return out;
  if (cfg.micro) {
    const t = snapMicroTiles(_live.fineTileM, _live.coarseTileM);
    out.uMicroFade = { value: new THREE.Vector2(_live.fadeStartM, _live.fadeEndM) };
    out.uMicroAmt = {
      value: new THREE.Vector4(
        terrainMicroTierOn(preset, "micro", cfg) ? _live.strength : 0,
        _live.material, _live.procedural, _live.rock),
    };
    out.uMicroTiles = { value: new THREE.Vector2(t.fine, t.coarse) };
  }
  if (cfg.heightBlend) {
    out.uHeightBlend = {
      value: new THREE.Vector4(
        terrainMicroTierOn(preset, "heightBlend", cfg) ? _live.hbAmount : 0,
        _live.hbGain, _live.hbSharp, 0),
    };
    out.uHeightBlendFade = { value: new THREE.Vector2(_live.hbFadeStartM, _live.hbFadeEndM) };
  }
  return out;
}

function _setV(v, a, b, c, d) {
  if (!v) return;
  if (typeof v.set === "function") {
    if (c === undefined) v.set(a, b); else v.set(a, b, c, d);
    return;
  }
  v.x = a; v.y = b;
  if (c !== undefined) { v.z = c; v.w = d; }
}

function _applyLive(mat) {
  const u = mat && mat.uniforms;
  if (!u) return false;
  let hit = false;
  if (u.uMicroAmt) {
    const t = snapMicroTiles(_live.fineTileM, _live.coarseTileM);
    _setV(u.uMicroAmt.value, _live.strength, _live.material, _live.procedural, _live.rock);
    if (u.uMicroFade) _setV(u.uMicroFade.value, _live.fadeStartM, _live.fadeEndM);
    if (u.uMicroTiles) _setV(u.uMicroTiles.value, t.fine, t.coarse);
    hit = true;
  }
  if (u.uHeightBlend) {
    _setV(u.uHeightBlend.value, _live.hbAmount, _live.hbGain, _live.hbSharp, 0);
    if (u.uHeightBlendFade) _setV(u.uHeightBlendFade.value, _live.hbFadeStartM, _live.hbFadeEndM);
    hit = true;
  }
  return hit;
}

/**
 * Live tuning without a reload. Applies to every registered terrain material
 * (per-LB and the terrain batch) and to materials baked later. A live
 * `strength` / `hbAmount` also overrides the `low`-tier hold.
 */
export function setTerrainMicroLive(scene3d, patch = {}) {
  const fin = (k, lo, hi) => {
    if (Number.isFinite(patch[k])) _live[k] = _clamp(patch[k], lo, hi);
  };
  fin("strength", 0, 3);
  fin("fadeStartM", 0, 1000);
  fin("fadeEndM", 0, 1000);
  fin("material", 0, 6);
  fin("procedural", 0, 2);
  fin("rock", 0, 1);
  fin("fineTileM", 0.25, 48);
  fin("coarseTileM", 0.25, 96);
  fin("hbAmount", 0, 1);
  fin("hbGain", 0, 10);
  fin("hbSharp", 0.02, 0.5);
  fin("hbFadeStartM", 0, 1000);
  fin("hbFadeEndM", 0, 1000);
  if (!(_live.fadeEndM > _live.fadeStartM + 0.001)) _live.fadeEndM = _live.fadeStartM + 0.001;
  if (!(_live.hbFadeEndM > _live.hbFadeStartM + 0.001)) _live.hbFadeEndM = _live.hbFadeStartM + 0.001;
  const t = snapMicroTiles(_live.fineTileM, _live.coarseTileM);
  _live.fineTileM = t.fineM;
  _live.coarseTileM = t.coarseM;
  let touched = 0;
  const seen = new Set();
  const lists = [scene3d && scene3d.terrainMaterials];
  try {
    const liveS = typeof window !== "undefined" ? window.liveScene3d : null;
    if (liveS && liveS !== scene3d) lists.push(liveS.terrainMaterials);
  } catch (_) { /* fail-soft */ }
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const m of list) {
      if (!m || seen.has(m)) continue;
      seen.add(m);
      if (_applyLive(m)) touched += 1;
    }
  }
  return { ..._live, materials: touched };
}

/** Install `window.__terrainMicro` (idempotent; browser only). */
export function installTerrainMicroDiag(scene3d) {
  if (typeof window === "undefined") return null;
  const api = {
    config: TERRAIN_MICRO,
    live: () => ({ ..._live }),
    set: (patch) => setTerrainMicroLive(scene3d, patch),
    /** First registered material's uniform values (what the GPU sees). */
    state: () => {
      const u = (scene3d?.terrainMaterials ?? [])[0]?.uniforms;
      if (!u) return null;
      const v = (o) => (o && o.value ? { ...o.value } : null);
      return {
        uMicroAmt: v(u.uMicroAmt), uMicroFade: v(u.uMicroFade), uMicroTiles: v(u.uMicroTiles),
        uHeightBlend: v(u.uHeightBlend), uHeightBlendFade: v(u.uHeightBlendFade),
        uPbrEnabled: u.uPbrEnabled?.value, uDetailNormalEnabled: u.uDetailNormalEnabled?.value,
        uAcGouraudEnabled: u.uAcGouraudEnabled?.value,
        materials: (scene3d?.terrainMaterials ?? []).length,
      };
    },
  };
  try { window.__terrainMicro = api; } catch (_) { /* fail-soft */ }
  return api;
}
