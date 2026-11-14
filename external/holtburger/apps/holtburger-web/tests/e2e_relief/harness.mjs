/**
 * apps/holtburger-web/tests/e2e_relief/harness.mjs
 *
 * Authoritative E2E Test Harness & Oracle for 3D Surface Relief & Visual Enhancements.
 * Derived from ORIGINAL_REQUEST.md, PROJECT.md, and TEST_INFRA.md.
 */

import * as THREE from "three";

// ============================================================================
// 1. AUTHORITATIVE ENGINE CONSTANTS & THRESHOLDS
// ============================================================================
export const CONSTANTS = {
  // Distance LOD Bands (meters)
  POM_LOD_NEAR_DEFAULT: 5.0,
  POM_LOD_FAR_DEFAULT: 10.0,
  POM_LOD_NEAR_EXTENDED: 15.0,
  POM_LOD_FAR_EXTENDED: 35.0,
  POM_LOD_FAR_ULTRA: 50.0,

  // Raymarch Step Counts
  POM_STEPS_CLOSE: 16,
  POM_STEPS_MID: 8,
  POM_STEPS_FAR: 4,
  POM_STEPS_MAX_GRAZE: 64,
  POM_SHADOW_STEPS_DEFAULT: 8,
  POM_SHADOW_STEPS_MID: 4,
  POM_SHADOW_STEPS_ULTRA: 12,

  // Grazing Angle & Silhouette Clamping
  GRAZE_EPSILON_LEGACY: 0.05,
  GRAZE_EPSILON_BOUNDED: 0.12,
  GRAZE_RAMP_MIN_Z: 0.12,
  GRAZE_RAMP_MAX_Z: 0.45,

  // Micro-Surface Crevice AO
  CREVICE_AO_GAIN: 1.5,
  CREVICE_AO_MIN: 0.0,
  CREVICE_AO_MAX: 1.0,

  // Specular Rim Highlighting
  EDGE_RIM_DEFAULT_GAMMA: 0.5,

  // Terrain POM & Lighting (R3)
  TERRAIN_POM_DEPTH_SCALE: 0.016,
  TERRAIN_LOD_NEAR: 15.0,
  TERRAIN_LOD_FAR: 40.0,
  TERRAIN_POM_STEPS_NEAR: 6,
  TERRAIN_POM_STEPS_FAR: 4,

  // Foliage & Arbory 3D Depth (R4)
  FOLIAGE_POM_DEPTH_SCALE: 0.015,
  FOLIAGE_POM_STEPS: 16,
  FOLIAGE_MICRO_DETAIL_MIX: 0.65,

  // ModelGate Remodel Thresholds
  MODELGATE_LEGACY: Object.freeze({
    min_bbox_extent_m: 4.0,
    min_median_edge_m: 0.60,
    min_area_m2: 50.0,
    max_double_sided_frac: 0.25,
  }),
  MODELGATE_RELAXED: Object.freeze({
    min_bbox_extent_m: 2.0,
    min_median_edge_m: 0.60,
    min_area_m2: 10.0,
    max_double_sided_frac: 0.25,
  }),

  // GTX 1070 Production Performance Targets
  GTX1070_TARGET_FPS: 60.0,
  GTX1070_MAX_P95_DELTA_MS: 2.0,
  GTX1070_BENCHMARK_DURATION_SEC: 10.0,
};

// ============================================================================
// 2. MATHEMATICAL & ALGORITHMIC ORACLES
// ============================================================================

/**
 * GLSL smoothstep(edge0, edge1, x) equivalent
 */
export function smoothstep(edge0, edge1, x) {
  const t = Math.max(0.0, Math.min(1.0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3.0 - 2.0 * t);
}

/**
 * POM LOD attenuation factor over distance.
 * Returns 1.0 (full displacement) inside lodNear, decays smoothly to 0.0 at lodFar.
 */
export function pomLodAtDistance(dist, lodNear = CONSTANTS.POM_LOD_NEAR_EXTENDED, lodFar = CONSTANTS.POM_LOD_FAR_EXTENDED) {
  if (dist <= lodNear) return 1.0;
  if (dist >= lodFar) return 0.0;
  return 1.0 - smoothstep(lodNear, lodFar, dist);
}

/**
 * Terrain POM linear distance fade factor.
 * Returns 1.0 at and below lodNear (15.0m), linearly fading to 0.0 at lodFar (40.0m).
 */
export function terrainPomFade(dist, near = CONSTANTS.TERRAIN_LOD_NEAR, far = CONSTANTS.TERRAIN_LOD_FAR) {
  if (dist <= near) return 1.0;
  if (dist >= far) return 0.0;
  return 1.0 - Math.max(0.0, Math.min(1.0, (dist - near) / Math.max(far - near, 1e-3)));
}

/**
 * Foliage composite heightfield oracle:
 * Combines distance-transform pillowing with vein dark-detail carving.
 * Cutout transparent margins (pillowH <= 0.0) strictly evaluate to 0.0.
 */
export function calculateFoliageHeight(pillowH, veinLuma, microMix = CONSTANTS.FOLIAGE_MICRO_DETAIL_MIX) {
  if (pillowH <= 0.0) return 0.0;
  const p = Math.max(0.0, Math.min(1.0, pillowH));
  const v = Math.max(0.0, Math.min(1.0, veinLuma));
  return Math.max(0.0, Math.min(1.0, p * (1.0 - microMix) + v * microMix));
}

/**
 * Terrain layer relief height oracle:
 * Evaluates height channel from NRA array, falling back to albedo luma on curated codes.
 */
export function terrainLayerReliefH(code, uv = [0, 0], nraSampler = null, atlasSampler = null) {
  const c = Math.max(0, Math.min(32, Math.floor(code)));
  const nra = typeof nraSampler === "function" ? nraSampler(c, uv) : null;
  const hasNraA = nra && typeof nra.a === "number" && !Number.isNaN(nra.a);
  const nraA = hasNraA ? Math.max(0.0, Math.min(1.0, nra.a)) : null;

  if (hasNraA && nraA < 0.995) {
    return nraA;
  }
  if (c === 32 || c === 0 || c === 13 || c === 14) {
    const a = typeof atlasSampler === "function" ? atlasSampler(c, uv) : { r: 0.5, g: 0.5, b: 0.5, a: 1.0 };
    const luma = a.r * 0.299 + a.g * 0.587 + a.b * 0.114;
    return Math.max(0.0, Math.min(1.0, 0.32 + 0.62 * Math.sqrt(Math.max(luma, 0.0))));
  }
  return hasNraA ? nraA : 1.0;
}

/**
 * POM Grazing silhouette weight and clamped ray-projection Z.
 */
export function pomGrazeWeight(tanDirZ, pomGraze = true) {
  const pz = Math.max(Math.abs(tanDirZ), pomGraze ? CONSTANTS.GRAZE_EPSILON_BOUNDED : CONSTANTS.GRAZE_EPSILON_LEGACY);
  let grazeW = 0.0;
  if (pomGraze) {
    grazeW = smoothstep(CONSTANTS.GRAZE_RAMP_MIN_Z, CONSTANTS.GRAZE_RAMP_MAX_Z, tanDirZ);
  } else {
    grazeW = tanDirZ > 0.15 ? 1.0 : 0.0;
  }
  return { pz, grazeW };
}

/**
 * Micro-Surface Crevice AO attenuation factor:
 * cavityAo = clamp(1.0 - 1.5 * max(0.0, -deltaH), 0.0, 1.0)
 */
export function calculateCreviceAo(deltaH) {
  const dip = Math.max(0.0, -deltaH);
  return Math.max(0.0, Math.min(1.0, 1.0 - CONSTANTS.CREVICE_AO_GAIN * dip));
}

/**
 * Specular Rim Highlight term on protruding masonry:
 * edgeRim = gamma * max(0.0, deltaH) * (1.0 - abs(dot(N, V)))
 */
export function calculateSpecularRim(deltaH, dotNV, gamma = CONSTANTS.EDGE_RIM_DEFAULT_GAMMA) {
  const proud = Math.max(0.0, deltaH);
  const fresnel = 1.0 - Math.min(1.0, Math.abs(dotNV));
  return gamma * proud * fresnel;
}

/**
 * ModelGate evaluation oracle:
 * Tests whether a model passes architectural geometry gating.
 */
export function passesModelGate(modelProps, gate = CONSTANTS.MODELGATE_RELAXED) {
  return (
    modelProps.bbox_extent_m >= gate.min_bbox_extent_m &&
    modelProps.median_edge_m >= gate.min_median_edge_m &&
    modelProps.total_area_m2 >= gate.min_area_m2 &&
    modelProps.double_sided_frac <= gate.max_double_sided_frac
  );
}

/**
 * Compute terrain POM raymarching step count based on camera view depth.
 */
export function computeTerrainPomSteps(viewDepth, fadeStart = CONSTANTS.TERRAIN_LOD_NEAR, fadeEnd = CONSTANTS.TERRAIN_LOD_FAR) {
  const midThreshold = fadeStart + (fadeEnd - fadeStart) * 0.45; // 26.25m
  return viewDepth > midThreshold ? CONSTANTS.TERRAIN_POM_STEPS_FAR : CONSTANTS.TERRAIN_POM_STEPS_NEAR;
}

/**
 * Evaluate whether material properties qualify for POM relief.
 */
export function evaluateReliefEligible(props, opts = { foliageRelief: true }) {
  const isTranslucent = !!props.isTranslucent;
  const isAdditive = !!props.isAdditive;
  const isAlpha = !!props.isAlpha;
  const isLuminous = !!props.isLuminous;
  const isClipMap = !!props.isClipMap;
  const isFoliage = props.category === "Foliage";
  const hasRelief = props.hasRelief !== undefined ? props.hasRelief : true;

  // Base1ClipMap is unblocked specifically for foliage under foliageRelief
  const hasCutout = isClipMap && !(opts.foliageRelief && isFoliage);
  const catPomDepth = isFoliage ? CONSTANTS.FOLIAGE_POM_DEPTH_SCALE : (props.depthScale || 0.0);

  return (
    hasRelief &&
    !isTranslucent &&
    !isAdditive &&
    !isAlpha &&
    !isLuminous &&
    !hasCutout &&
    catPomDepth > 0
  );
}

/**
 * Texture classification macro allowance:
 * S, B, T, P, H allow macro seam / pillow generation; F, C, V, U suppress it.
 */
export function allowsMacro(reliefClass) {
  const code = typeof reliefClass === "string" ? reliefClass.trim().toUpperCase() : "";
  return code === "S" || code === "B" || code === "T" || code === "P" || code === "H";
}

/**
 * Shader Program Cache Key disambiguation oracle:
 * Computes canonical key given active material patches.
 */
export function buildProgramCacheKey(userData = {}) {
  const u = userData || {};
  return (
    "hb" +
    "|d" + (u.detailEnabled ? 1 : 0) +
    "|c" + (u.csmEnabled ? 2 : 0) +
    "|p" + (u.pomEnabled ? 1 : 0) +
    "|l" + (u.lightClampRetail ? 1 : 0) +
    "|a" + (u.__aoPatched ? 1 : 0) +
    "|b" + (u.__depthBiased ? 1 : 0) +
    "|f" + (u.__floorBiased ? 1 : 0) +
    "|s" + (u.__staticBiased ? 1 : 0) +
    "|k" + (u.__acBakedLight ? 1 : 0) +
    (u.__acBakedDirectOut ? "d" : "") +
    (u.__creviceAo ? "|mc1" : "|mc0") +
    (u.__microShadow ? "|ms1" : "|ms0") +
    "|v" + (u.__vfxSetKey || "")
  );
}

// ============================================================================
// 3. MATERIAL & SHADER TESTING UTILITIES
// ============================================================================

/**
 * Compile a Three.js material's onBeforeCompile hook on standard shader chunks.
 */
export function compileMaterialShader(material) {
  const lib = THREE.ShaderLib.standard;
  const shader = {
    uniforms: THREE.UniformsUtils.clone(lib.uniforms),
    vertexShader: lib.vertexShader,
    fragmentShader: lib.fragmentShader,
    defines: {},
  };
  if (typeof material.onBeforeCompile === "function") {
    material.onBeforeCompile(shader, null);
  }
  return shader;
}

/**
 * Create a mock 1x1 DataTexture for testing height / normal planes.
 */
export function createMockTexture(r = 128, g = 128, b = 255, a = 255, name = "mockTex") {
  const tex = new THREE.DataTexture(new Uint8Array([r, g, b, a]), 1, 1);
  tex.name = name;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Statistical latency profiler helper for frame-time delta arrays.
 */
export function computeLatencyPercentiles(frameTimesMs) {
  if (!frameTimesMs || frameTimesMs.length === 0) {
    return { mean: 0, p50: 0, p95: 0, p99: 0, max: 0, fps: 0, hitchCount: 0 };
  }
  const sorted = [...frameTimesMs].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((a, b) => a + b, 0) / n;
  const p50 = sorted[Math.floor(n * 0.5)];
  const p95 = sorted[Math.floor(n * 0.95)];
  const p99 = sorted[Math.floor(n * 0.99)];
  const max = sorted[n - 1];
  const fps = mean > 0 ? 1000.0 / mean : 0;
  // Hitching defined as any frame taking > 33.3ms (drops below 30 FPS)
  const hitchCount = sorted.filter((t) => t > 33.3).length;
  return { mean, p50, p95, p99, max, fps, hitchCount };
}

// ============================================================================
// 4. TEST SUITE RUNNER & ASSERTION FRAMEWORK
// ============================================================================

let currentSuite = "Default";
const results = {
  passed: 0,
  failed: 0,
  total: 0,
  suites: {},
  failures: [],
};

export function describe(name, fn) {
  const prevSuite = currentSuite;
  currentSuite = name;
  if (!results.suites[name]) {
    results.suites[name] = { passed: 0, failed: 0, tests: [] };
  }
  try {
    fn();
  } finally {
    currentSuite = prevSuite;
  }
}

export async function test(name, fn) {
  results.total++;
  const suiteName = currentSuite;
  const suite = results.suites[suiteName] || (results.suites[suiteName] = { passed: 0, failed: 0, tests: [] });

  try {
    const res = fn();
    if (res && typeof res.then === "function") {
      await res;
    }
    results.passed++;
    suite.passed++;
    suite.tests.push({ name, status: "pass" });
  } catch (err) {
    results.failed++;
    suite.failed++;
    const errMsg = err?.message || String(err);
    results.failures.push({ suite: suiteName, test: name, error: errMsg, stack: err?.stack });
    suite.tests.push({ name, status: "fail", error: errMsg });
  }
}

export function ok(condition, message = "expected truthy value") {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

export function equal(actual, expected, message = "") {
  if (actual !== expected) {
    throw new Error(`Assertion failed: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}. ${message}`);
  }
}

export function deepEqual(actual, expected, message = "") {
  const act = JSON.stringify(actual);
  const exp = JSON.stringify(expected);
  if (act !== exp) {
    throw new Error(`Assertion failed: expected ${exp}, got ${act}. ${message}`);
  }
}

export function near(actual, expected, epsilon = 1e-4, message = "") {
  if (Math.abs(actual - expected) > epsilon) {
    throw new Error(`Assertion failed: expected ${expected} ± ${epsilon}, got ${actual} (diff: ${Math.abs(actual - expected)}). ${message}`);
  }
}

export function getResults() {
  return { ...results };
}

export function resetResults() {
  results.passed = 0;
  results.failed = 0;
  results.total = 0;
  results.suites = {};
  results.failures = [];
}
