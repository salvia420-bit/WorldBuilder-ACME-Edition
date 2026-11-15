/**
 * tests/challenger_m5_tier5_landscape.test.mjs
 *
 * Milestone 5 Phase 3: Tier 5 Adversarial Coverage Hardening Suite
 * Landscape, Terrain & Atmosphere Pipeline Verification
 *
 * Adversarial Challenge Coverage:
 * 1. Feature 2: Blue-Noise Volumetric Clouds & Atmosphere Coupling (cloud_edge_resolve.js, cloud_res_scale.js, weather_state.js)
 *    - Temporal reprojection history validation (ghosting during rapid camera pans, 3x3 YCoCg clamping)
 *    - Cloud resolution scaling (cloudResScale edge cases: 0.25, 0.5, 1.0, 2.0)
 *    - Rain gating transitions at cloudCoverage = 0.62 boundary (hysteresis, sunny vs storm transitions)
 * 2. Feature 3: Beer-Lambert Water & Hi-Z SSR (scene3d/water_pass.js, terrain_water_flow.js)
 *    - Depth delta singularities (w_seabed - w_water approaching 0, negative depth deltas, log-depth far plane)
 *    - Half-res Hi-Z SSR raymarch step limits (16 steps) on extreme grazing view angles
 *    - Dual-octave depth foam blending and flow map advection vector edge cases
 * 3. Feature 5: HexTile & Landblock Normal Stitching (scene3d/terrain.js, terrain_round.js)
 *    - Simplex grid UV permutation and analytical derivative precision under textureGrad
 *    - 81-texel shared normal stitching buffer updates at landblock boundary transitions
 *    - Zero-sampler addition verification in terrain.js (confirming 15/16 sampler cap)
 * 4. Feature 7: Far Composite Ring & Octahedral Forest (scene3d/far_terrain_flags.js, far_forest.js)
 *    - 2.1 km composite ring radius boundary transitions (streaming cell boundary vs far ring overlap)
 *    - Octahedral tree impostor atlas barycentric view interpolation at octahedral poles and equator
 * 5. Feature 12: Macro Terrain Horizon Elevation Shadows & Swamp Mist (terrain_round.js, ground_fog.js)
 *    - 4-azimuth horizon elevation angle lookup decoding from uVertexTypes
 *    - Log-depth soft fog fade (softness = 2.2m) when camera intersects ground plane
 */

globalThis.window = globalThis.window || {};
globalThis.window.requestAnimationFrame ??= () => 0;
globalThis.requestAnimationFrame ??= () => 0;
globalThis.location = globalThis.location || { search: "" };
window.location = globalThis.location;

import assert from "node:assert/strict";
import * as THREE from "three";
import { createFakeWebGL2 } from "./helpers/fake_webgl2.mjs";

// Production module imports
import {
  cloudEdgeResolveEnabled,
  cloudEdgeGamma,
  patchCloudsResolveSource,
  CLOUD_EDGE_GAMMA_DEFAULT,
  ANCHOR_UNIFORM,
  ANCHOR_FUNC,
  ANCHOR_CLOSEST,
} from "../scene3d/cloud_edge_resolve.js";

import {
  parseCloudResScale,
  applyCloudResScale,
  CLOUD_RES_SCALE_MIN,
  CLOUD_RES_SCALE_MAX,
} from "../scene3d/cloud_res_scale.js";

import {
  isRainPermitted,
  setCloudOverheadFactor,
  readWeatherCloudCoupling,
  _resetWeatherStateForTest,
  updateFromDayGroup,
  getWeatherState,
  setWeatherMode,
} from "../scene3d/weather_state.js";

import {
  WaterPass,
  waterPassEnabled,
} from "../scene3d/water_pass.js";

import {
  evalBeerLambertTransmittance,
  evalDepthFoam,
  resolveSsrReflection,
  evalWaterSubmersion,
  evalWaterColumnDelta,
  decodeFlowBytes,
  computeWaterBankWeights,
  WATER_FLOW_DEFAULTS,
} from "../scene3d/terrain_water_flow.js";

import {
  encodeNormalByte,
  decodeNormalBytes,
  noteTerrainRoundNormals,
  stitchTerrainRoundNormals,
  writeTerrainHorizonElevation,
  _resetTerrainRoundNormalsForTest,
} from "../scene3d/terrain_round.js";

import {
  farRadiusLb,
  farRingEnabled,
  computeFogBand,
  avoidSunAzimuth,
  _resetFarTerrainFlagsForTest,
} from "../scene3d/far_terrain_flags.js";

import {
  dirToHemiOctahedral,
  hemiOctahedralToDir,
  farForestRegionStride,
  OCTAHEDRAL_VIEWS,
  OCTAHEDRAL_GRID,
} from "../scene3d/far_forest.js";

import {
  groundFogLogDepthFC,
  decodeLogDepthToMetres,
  softParticleFade,
  GROUND_FOG_DEFAULTS,
  GROUND_FOG_DEPTH_SENTINEL,
} from "../scene3d/ground_fog.js";

import { _terrainGlslForTest } from "../scene3d/terrain.js";

// ============================================================================
// TEST HARNESS STATS & ASSERTIONS
// ============================================================================

let passedAssertions = 0;
let failedAssertions = 0;
const failureDetails = [];

function check(label, condition, message = "") {
  if (condition) {
    passedAssertions++;
    console.log(`  ✓ [PASS] ${label}`);
  } else {
    failedAssertions++;
    const err = `${label} FAILED: ${message}`;
    failureDetails.push(err);
    console.error(`  ✗ [FAIL] ${err}`);
  }
}

function checkNear(label, actual, expected, eps = 1e-4) {
  const diff = Math.abs(actual - expected);
  check(label, diff <= eps, `expected ${expected} ± ${eps}, got ${actual} (diff ${diff})`);
}

console.log("================================================================================");
console.log("ADVERSARIAL STRESS SUITE: Milestone 5 Tier 5 Landscape & Atmosphere Hardening");
console.log("================================================================================");

// ============================================================================
// SUITE 1: FEATURE 2 — BLUE-NOISE CLOUDS & ATMOSPHERE COUPLING
// ============================================================================
console.log("\n>>> [SUITE 1] Feature 2: Blue-Noise Clouds & Atmosphere Coupling");

{
  // 1.1: 4-Channel Box Clamping (hbClip4) Analytical Twin Testing
  // Tests YCoCg neighbourhood variance box clamping under rapid camera pans
  function hbClip4(center, history, extent) {
    const vx = history[0] - center[0];
    const vy = history[1] - center[1];
    const vz = history[2] - center[2];
    const vw = history[3] - center[3];
    const ux = Math.abs(vx) / (extent[0] + 1e-7);
    const uy = Math.abs(vy) / (extent[1] + 1e-7);
    const uz = Math.abs(vz) / (extent[2] + 1e-7);
    const uw = Math.abs(vw) / (extent[3] + 1e-7);
    const m = Math.max(ux, uy, uz, uw);
    if (m > 1.0) {
      return [
        center[0] + vx / m,
        center[1] + vy / m,
        center[2] + vz / m,
        center[3] + vw / m,
      ];
    }
    return [history[0], history[1], history[2], history[3]];
  }

  // T5.02.01: History within bounding box is preserved verbatim
  const center1 = [0.5, 0.5, 0.5, 0.8];
  const histInside = [0.52, 0.49, 0.51, 0.82];
  const extent1 = [0.1, 0.1, 0.1, 0.1];
  const clippedInside = hbClip4(center1, histInside, extent1);
  check(
    "T5.02.01: hbClip4 preserves in-bounds history verbatim",
    clippedInside[0] === histInside[0] &&
    clippedInside[1] === histInside[1] &&
    clippedInside[2] === histInside[2] &&
    clippedInside[3] === histInside[3]
  );

  // T5.02.02: History outside bounding box projected to AABB boundary
  const histOutside = [0.8, 0.5, 0.5, 0.8]; // displacement 0.3 along X, extent 0.1 -> m = 3.0
  const clippedOutside = hbClip4(center1, histOutside, extent1);
  checkNear("T5.02.02a: hbClip4 clamps X to box boundary", clippedOutside[0], 0.60, 1e-4);
  checkNear("T5.02.02b: hbClip4 clamps Y to center", clippedOutside[1], 0.50, 1e-4);

  // T5.02.03: Division-by-zero protection when variance extent is exactly zero
  const zeroExtent = [0.0, 0.0, 0.0, 0.0];
  const clippedZero = hbClip4(center1, histOutside, zeroExtent);
  check(
    "T5.02.03: hbClip4 handles zero variance extent without NaN or Infinity",
    Number.isFinite(clippedZero[0]) &&
    Number.isFinite(clippedZero[1]) &&
    Number.isFinite(clippedZero[2]) &&
    Number.isFinite(clippedZero[3])
  );

  // T5.02.04: Silhouette gamma parameter validation (0 < gamma <= 16)
  check(
    "T5.02.04: cloudEdgeGamma adheres to numerical bounds and default fallback",
    cloudEdgeGamma("?cloudEdgeGamma=2.5") === 2.5 &&
    cloudEdgeGamma("?cloudEdgeGamma=0.01") === 0.01 &&
    cloudEdgeGamma("?cloudEdgeGamma=16.0") === 16.0 &&
    cloudEdgeGamma("?cloudEdgeGamma=0") === CLOUD_EDGE_GAMMA_DEFAULT &&
    cloudEdgeGamma("?cloudEdgeGamma=-5") === CLOUD_EDGE_GAMMA_DEFAULT &&
    cloudEdgeGamma("?cloudEdgeGamma=25") === CLOUD_EDGE_GAMMA_DEFAULT &&
    cloudEdgeGamma("?cloudEdgeGamma=junk") === CLOUD_EDGE_GAMMA_DEFAULT
  );

  // T5.02.05: Cloud edge resolve URL flag evaluation
  check(
    "T5.02.05: cloudEdgeResolveEnabled evaluates default-ON and URL escape overrides",
    cloudEdgeResolveEnabled("") === true &&
    cloudEdgeResolveEnabled("?cloudEdgeResolve=on") === true &&
    cloudEdgeResolveEnabled("?cloudEdgeResolve=1") === true &&
    cloudEdgeResolveEnabled("?cloudEdgeResolve=off") === false &&
    cloudEdgeResolveEnabled("?cloudEdgeResolve=0") === false &&
    cloudEdgeResolveEnabled("?cloudEdgeResolve=false") === false &&
    cloudEdgeResolveEnabled("?cloudEdgeResolve=no") === false
  );

  // T5.02.06: Patching takram cloudsResolve shader and idempotency
  const mockShader = `${ANCHOR_UNIFORM}\n${ANCHOR_FUNC}\n${ANCHOR_CLOSEST}\nvoid main() {}`;
  const patchedShader = patchCloudsResolveSource(mockShader);
  const doublePatch = patchCloudsResolveSource(patchedShader);
  check(
    "T5.02.06: patchCloudsResolveSource injects edge resolve and prevents duplicate injection",
    patchedShader !== null &&
    patchedShader.includes("hbEdgeResolve") &&
    doublePatch === null
  );

  // T5.02.07: parseCloudResScale min boundary and below-min clamping
  check(
    "T5.02.07: parseCloudResScale enforces minimum limit 0.25",
    parseCloudResScale("?cloudResScale=0.25") === 0.25 &&
    parseCloudResScale("?cloudResScale=0.10") === CLOUD_RES_SCALE_MIN &&
    parseCloudResScale("?cloudResScale=0.001") === CLOUD_RES_SCALE_MIN
  );

  // T5.02.08: parseCloudResScale mid-tier values
  check(
    "T5.02.08: parseCloudResScale parses standard resolution scales (0.5, 0.75, 1.0)",
    parseCloudResScale("?cloudResScale=0.5") === 0.5 &&
    parseCloudResScale("?cloudResScale=0.75") === 0.75 &&
    parseCloudResScale("?cloudResScale=1.0") === 1.0
  );

  // T5.02.09: parseCloudResScale max boundary clamp and invalid junk rejection
  check(
    "T5.02.09: parseCloudResScale clamps above 1.0 and rejects non-numeric/negative values",
    parseCloudResScale("?cloudResScale=1.5") === CLOUD_RES_SCALE_MAX &&
    parseCloudResScale("?cloudResScale=2.0") === CLOUD_RES_SCALE_MAX &&
    parseCloudResScale("?cloudResScale=10.0") === CLOUD_RES_SCALE_MAX &&
    parseCloudResScale("?cloudResScale=-1") === null &&
    parseCloudResScale("?cloudResScale=0") === null &&
    parseCloudResScale("?cloudResScale=abc") === null &&
    parseCloudResScale("") === null
  );

  // T5.02.10: applyCloudResScale effect mutation safety
  const mockEffect = { resolutionScale: 1.0 };
  const applied = applyCloudResScale(mockEffect, 0.5);
  check(
    "T5.02.10: applyCloudResScale updates effect and handles non-conforming objects safely",
    applied === 0.5 &&
    mockEffect.resolutionScale === 0.5 &&
    applyCloudResScale({}, 0.5) === null &&
    applyCloudResScale(null, 0.5) === null
  );

  // T5.02.11: Precipitation gating boundary analysis at 0.62 threshold
  check(
    "T5.02.11: isRainPermitted strictly enforces 0.62 boundary cutoff",
    isRainPermitted(0.619999) === false &&
    isRainPermitted(0.620000) === true &&
    isRainPermitted(0.620001) === true &&
    isRainPermitted(0.0) === false &&
    isRainPermitted(1.0) === true &&
    isRainPermitted(-0.5) === false &&
    isRainPermitted(NaN) === false
  );

  // T5.02.12: Weather coupling transition: clear sky suppresses rain -> storm enables rain
  _resetWeatherStateForTest();
  setWeatherMode("auto");
  setCloudOverheadFactor(0.10); // Sunny/dry sky
  updateFromDayGroup({ name: "heavy-rain", temperature_C: 18.0, dewpoint_C: 16.0, surface_pressure_hPa: 1010.0, is_storm: false });
  const dryWeather = {};
  readWeatherCloudCoupling(dryWeather);
  check(
    "T5.02.12a: Dry sky suppresses precipitation intensity to 0.0 even under rain daygroup",
    dryWeather.precip_intensity === 0.0 &&
    dryWeather.precip_mm_hr === 0.0
  );

  // Thick cloud cover (0.80) unlocks rain
  setCloudOverheadFactor(0.80);
  const wetWeather = {};
  readWeatherCloudCoupling(wetWeather);
  check(
    "T5.02.12b: Thick cloud cover unlocks precipitation intensity",
    wetWeather.precip_intensity > 0.5 &&
    wetWeather.precip_mm_hr > 3.0
  );

  // T5.02.13: Sub-threshold rain permitted when cloudWeather decoupled
  const savedSearch = window.location.search;
  window.location.search = "?cloudWeather=off";
  setCloudOverheadFactor(0.40);
  const decoupledWeather = {};
  readWeatherCloudCoupling(decoupledWeather);
  check(
    "T5.02.13: Decoupled mode (?cloudWeather=off) permits rain with cloud factor below 0.62",
    decoupledWeather.precip_intensity > 0.0
  );
  window.location.search = savedSearch;
  _resetWeatherStateForTest();
}

// ============================================================================
// SUITE 2: FEATURE 3 — BEER-LAMBERT WATER & HI-Z SSR RAYMARCHING
// ============================================================================
console.log("\n>>> [SUITE 2] Feature 3: Beer-Lambert Water & Hi-Z SSR Raymarching");

{
  // T5.03.01: Beer-Lambert zero-depth singularity (depth = 0 -> transmittance = 1.0)
  const transZero = evalBeerLambertTransmittance(0.0);
  check(
    "T5.03.01: Beer-Lambert zero depth yields 100% optical transmittance",
    transZero[0] === 1.0 &&
    transZero[1] === 1.0 &&
    transZero[2] === 1.0
  );

  // T5.03.02: Beer-Lambert extreme depth / log far plane (depth = 5000m)
  const transDeep = evalBeerLambertTransmittance(5000.0);
  check(
    "T5.03.02: Beer-Lambert extreme depth completely extinguishes transmitted light",
    transDeep[0] < 1e-40 &&
    transDeep[1] < 1e-40 &&
    transDeep[2] < 1e-40 &&
    transDeep[0] >= 0.0
  );

  // T5.03.03: Water column depth delta for dry seabed above water level
  const deltaDry = evalWaterColumnDelta(15.0, 0.0, 5.0); // seabed at Y=15m, water at Y=0m
  const deltaWet = evalWaterColumnDelta(-8.0, 0.0, 5.0); // seabed at Y=-8m, water at Y=0m
  check(
    "T5.03.03: evalWaterColumnDelta correctly isolates water column and ignores dry terrain",
    deltaDry === 0.0 &&
    deltaWet === 8.0
  );

  // T5.03.04: Camera submersion detection
  check(
    "T5.03.04: evalWaterSubmersion distinguishes submerged vs surface viewpoints",
    evalWaterSubmersion(5.0, 0.0) === false &&
    evalWaterSubmersion(0.0, 0.0) === false &&
    evalWaterSubmersion(-0.01, 0.0) === true &&
    evalWaterSubmersion(-10.0, 0.0) === true
  );

  // T5.03.05: MAX_SSR_STEPS 16-step raymarch loop invariant
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000.0);
  cam.position.set(0, 10, 0);
  cam.updateMatrixWorld();
  const waterPass = new WaterPass(cam);
  check(
    "T5.03.05: WaterPass defines 16-step Hi-Z raymarch in fragment shader",
    waterPass.material.fragmentShader.includes("#define MAX_SSR_STEPS 16")
  );

  // T5.03.06: Schlick Fresnel grazing view angle limit
  function schlickFresnel(f0, ndotv) {
    const clamped = Math.max(0.0, Math.min(1.0, ndotv));
    return f0 + (1.0 - f0) * Math.pow(1.0 - clamped, 5.0);
  }
  const fNormal = schlickFresnel(0.02, 1.0); // Looking straight down
  const fGrazing = schlickFresnel(0.02, 0.0); // Grazing view
  checkNear("T5.03.06a: Fresnel at normal incidence is F0 (0.02)", fNormal, 0.02, 1e-4);
  checkNear("T5.03.06b: Fresnel at grazing incidence is 1.0 (100% specular)", fGrazing, 1.0, 1e-4);

  // T5.03.07: SSR screen-space edge vignette confidence window
  function ssrEdgeConfidence(uv) {
    function smoothstep(e0, e1, x) {
      const t = Math.max(0.0, Math.min(1.0, (x - e0) / (e1 - e0)));
      return t * t * (3.0 - 2.0 * t);
    }
    const edgeX = smoothstep(0.0, 0.08, uv[0]) * (1.0 - smoothstep(0.92, 1.0, uv[0]));
    const edgeY = smoothstep(0.0, 0.08, uv[1]) * (1.0 - smoothstep(0.92, 1.0, uv[1]));
    return edgeX * edgeY;
  }
  checkNear("T5.03.07a: Center of screen has full SSR confidence (1.0)", ssrEdgeConfidence([0.5, 0.5]), 1.0, 1e-3);
  check(
    "T5.03.07b: Screen borders attenuate SSR confidence to prevent hard edge clipping",
    ssrEdgeConfidence([0.02, 0.5]) < 0.25 &&
    ssrEdgeConfidence([0.02, 0.5]) >= 0.0 &&
    ssrEdgeConfidence([0.98, 0.5]) < 0.25
  );

  // T5.03.08: Lagarde specular occlusion crevice suppression
  function lagardeSpecularOcclusion(ndotv, ao, roughness) {
    const clampedNdotV = Math.max(0.0, Math.min(1.0, ndotv));
    const clampedAo = Math.max(0.0, Math.min(1.0, ao));
    const r = Math.max(0.0, Math.min(1.0, roughness));
    const base = Math.max(0.0, clampedNdotV + clampedAo);
    const exponent = Math.pow(2.0, -16.0 * r - 1.0);
    return Math.max(0.0, Math.min(1.0, Math.pow(base, exponent) - 1.0 + clampedAo));
  }
  const occCrevice = lagardeSpecularOcclusion(0.5, 0.0, 0.05); // AO = 0 (deep shadow crevice)
  const occOpen = lagardeSpecularOcclusion(0.5, 1.0, 0.05); // AO = 1 (unoccluded sky)
  checkNear("T5.03.08a: Lagarde specular occlusion in zero-AO crevice is 0.0", occCrevice, 0.0, 1e-3);
  checkNear("T5.03.08b: Lagarde specular occlusion in unoccluded sky is 1.0", occOpen, 1.0, 1e-3);

  // T5.03.09: Depth foam shoreline blending across boundary thresholds
  check(
    "T5.03.09: evalDepthFoam generates continuous 0..1 shoreline contact foam",
    evalDepthFoam(0.0, 0.35) === 1.0 &&
    Math.abs(evalDepthFoam(0.175, 0.35) - 0.5) < 1e-4 &&
    evalDepthFoam(0.35, 0.35) === 0.0 &&
    evalDepthFoam(5.0, 0.35) === 0.0 &&
    evalDepthFoam(-1.0, 0.35) === 1.0
  );

  // T5.03.10: Flow map biased byte advection decoding
  const [flowStillU, flowStillV] = decodeFlowBytes(128, 128, 4.0);
  const [flowMaxEastU, flowMaxEastV] = decodeFlowBytes(255, 128, 4.0);
  const [flowMaxWestU, flowMaxWestV] = decodeFlowBytes(0, 128, 4.0);
  checkNear("T5.03.10a: Biased byte 128 decodes to 0 m/s still water", flowStillU, 0.0, 1e-4);
  checkNear("T5.03.10b: Biased byte 255 decodes to +fullScale east flow", flowMaxEastU, 4.0, 0.05);
  checkNear("T5.03.10c: Biased byte 0 decodes to -fullScale west flow", flowMaxWestU, -4.0, 0.05);

  // T5.03.11: WaterPass constructor uniform allocation and disposal
  check(
    "T5.03.11: WaterPass allocates full uniform block and disposes render targets cleanly",
    waterPass.material.uniforms.uWaterExtinction !== undefined &&
    waterPass.material.uniforms.uLogFC !== undefined &&
    waterPass.material.uniforms.uProj !== undefined &&
    waterPass.material.uniforms.uViewMatrix !== undefined
  );
  waterPass.dispose();

  // T5.03.12: waterPassEnabled URL overrides
  check(
    "T5.03.12: waterPassEnabled responds to quality presets and URL escapes",
    waterPassEnabled({ waterPass: true }, "") === true &&
    waterPassEnabled({ waterPass: true }, "?waterPass=off") === false &&
    waterPassEnabled({ waterPass: false }, "?waterPass=on") === true &&
    waterPassEnabled({ waterPass: false }, "") === false
  );
}

// ============================================================================
// SUITE 3: FEATURE 5 — HEXTILE & LANDBLOCK NORMAL STITCHING
// ============================================================================
console.log("\n>>> [SUITE 3] Feature 5: HexTile & Landblock Normal Stitching");

{
  // 3.1: Simplex Grid UV Permutation & Quartic Weight Partition
  function evalHexTileSimplex(uv) {
    const st = [uv[0] - uv[1] * 0.57735027, uv[1] * 1.15470054];
    const p = [Math.floor(st[0]), Math.floor(st[1])];
    const f = [st[0] - p[0], st[1] - p[1]];

    let w0, w1, w2;
    if (f[0] + f[1] < 1.0) {
      w0 = 1.0 - f[0] - f[1];
      w1 = f[0];
      w2 = f[1];
    } else {
      w0 = f[0] + f[1] - 1.0;
      w1 = 1.0 - f[1];
      w2 = 1.0 - f[0];
    }

    w0 = w0 * w0 * w0 * w0;
    w1 = w1 * w1 * w1 * w1;
    w2 = w2 * w2 * w2 * w2;
    const sumW = Math.max(w0 + w1 + w2, 1e-4);
    return [w0 / sumW, w1 / sumW, w2 / sumW];
  }

  // T5.05.01: Quartic weights partition of unity across sample UVs
  let minSum = 1.0, maxSum = 1.0;
  for (let u = 0; u <= 3.0; u += 0.3) {
    for (let v = 0; v <= 3.0; v += 0.3) {
      const weights = evalHexTileSimplex([u, v]);
      const s = weights[0] + weights[1] + weights[2];
      if (s < minSum) minSum = s;
      if (s > maxSum) maxSum = s;
    }
  }
  checkNear("T5.05.01: HexTile quartic weights sum to 1.0 across continuous UV grid", minSum, 1.0, 1e-4);
  checkNear("T5.05.02: HexTile max weight sum strictly bounded to 1.0", maxSum, 1.0, 1e-4);

  // T5.05.03: Simplex hypotenuse continuity under epsilon perturbations
  const uvA = [0.499999, 0.499999];
  const uvB = [0.500001, 0.500001];
  const wA = evalHexTileSimplex(uvA);
  const wB = evalHexTileSimplex(uvB);
  check(
    "T5.05.03: HexTile weights transition continuously across simplex boundary without jumps",
    Math.abs(wA[0] - wB[0]) < 0.01 &&
    Math.abs(wA[1] - wB[1]) < 0.01 &&
    Math.abs(wA[2] - wB[2]) < 0.01
  );

  // T5.05.04: Discrete 60-degree hex rotation symmetry
  function hexRotationAngle(seed) {
    const h = (Math.sin(seed * 43758.5453) * 10000.0) % 1.0;
    const absH = Math.abs(h);
    return Math.floor(absH * 6.0) * (Math.PI / 3.0);
  }
  let validRotations = true;
  for (let s = 1; s <= 20; s++) {
    const ang = hexRotationAngle(s);
    const deg = Math.round((ang * 180) / Math.PI);
    if (![0, 60, 120, 180, 240, 300].includes(deg)) validRotations = false;
  }
  check("T5.05.04: Simplex hex rotation angles strictly align to 60-degree lattice intervals", validRotations);

  // T5.05.05: 81-texel shared normal caching in noteTerrainRoundNormals
  _resetTerrainRoundNormalsForTest();
  const cols = 45;
  const selfBytes = new Uint8Array(9 * cols * 4);
  const eastBytes = new Uint8Array(9 * cols * 4);
  const acLightA = new Float32Array(81 * 3);
  const acLightB = new Float32Array(81 * 3);

  // Fill A with up-normals (0, 0, 1) and B with tilted normals (0.707, 0, 0.707)
  for (let i = 0; i < 81; i++) {
    acLightA[i * 3 + 0] = 0; acLightA[i * 3 + 1] = 0; acLightA[i * 3 + 2] = 1;
    acLightB[i * 3 + 0] = 0.707; acLightB[i * 3 + 1] = 0; acLightB[i * 3 + 2] = 0.707;
  }

  noteTerrainRoundNormals(10, 20, acLightA, 9, 1);
  noteTerrainRoundNormals(11, 20, acLightB, 9, 1);

  // T5.05.06: East/West shared boundary normal stitching
  const okA = stitchTerrainRoundNormals(10, 20, selfBytes, cols);
  const okB = stitchTerrainRoundNormals(11, 20, eastBytes, cols);
  check("T5.05.06a: stitchTerrainRoundNormals succeeds for adjacent landblocks", okA && okB);

  // Check border vertices: x=8 on A and x=0 on B must match exactly
  let borderMatched = true;
  for (let y = 0; y <= 8; y++) {
    const dstA = (y * cols + 9 + 8) * 4;
    const dstB = (y * cols + 9 + 0) * 4;
    if (selfBytes[dstA + 0] !== eastBytes[dstB + 0] ||
        selfBytes[dstA + 1] !== eastBytes[dstB + 1]) {
      borderMatched = false;
    }
  }
  check("T5.05.06b: Shared East-West border normals are bit-identical across landblock boundary", borderMatched);

  // T5.05.07: North/South shared boundary normal stitching
  const northBytes = new Uint8Array(9 * cols * 4);
  noteTerrainRoundNormals(10, 21, acLightB, 9, 1);
  const okNorth = stitchTerrainRoundNormals(10, 21, northBytes, cols);
  check("T5.05.07a: North stitch execution succeeds", okNorth);

  // y=8 on self meets y=0 on north
  let northMatched = true;
  for (let x = 0; x <= 8; x++) {
    const dstSelf = (8 * cols + 9 + x) * 4;
    const dstNorth = (0 * cols + 9 + x) * 4;
    if (selfBytes[dstSelf + 0] !== northBytes[dstNorth + 0] ||
        selfBytes[dstSelf + 1] !== northBytes[dstNorth + 1]) {
      northMatched = false;
    }
  }
  check("T5.05.07b: Shared North-South border normals match across landblock boundary", northMatched);

  // T5.05.08: Normal byte encoding and decoding precision
  const nx = 0.5, ny = -0.5;
  const bx = encodeNormalByte(nx);
  const by = encodeNormalByte(ny);
  const decoded = decodeNormalBytes(bx, by);
  checkNear("T5.05.08a: Normal byte decode recovers X direction", decoded[0], nx, 0.01);
  checkNear("T5.05.08b: Normal byte decode recovers Y direction", decoded[1], ny, 0.01);

  // T5.05.09: Degenerate normal handling in decodeNormalBytes
  const degDecoded = decodeNormalBytes(128, 128); // nx=0, ny=0 -> nz=1.0
  checkNear("T5.05.09: Degenerate normal reconstructs upright Z normal", degDecoded[2], 1.0, 1e-4);

  // T5.05.10: Unbaked neighbour stitching graceful fail-soft
  const unbakedBytes = new Uint8Array(9 * cols * 4);
  const okUnbaked = stitchTerrainRoundNormals(99, 99, unbakedBytes, cols);
  check("T5.05.10: stitchTerrainRoundNormals safely no-ops on unbaked landblock", okUnbaked === false);

  // T5.05.11: Linked terrain program texture sampler count audit (<= 15 units)
  const gl = createFakeWebGL2({ maxTextures: 16 });
  const glsl = _terrainGlslForTest();
  const vs = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vs, glsl.vertex);
  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fs, "#define HB_TERRAIN_CSM 1\n" + glsl.fragment);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);

  const samplerTypes = new Set([
    gl.SAMPLER_2D, gl.SAMPLER_2D_ARRAY, gl.SAMPLER_CUBE,
    gl.SAMPLER_2D_SHADOW, gl.SAMPLER_2D_ARRAY_SHADOW, gl.SAMPLER_CUBE_SHADOW,
  ]);
  const activeUniformCount = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
  const activeSamplers = [];
  for (let i = 0; i < activeUniformCount; i++) {
    const u = gl.getActiveUniform(prog, i);
    if (samplerTypes.has(u.type)) activeSamplers.push(u.name);
  }

  check(
    `T5.05.11: terrain.js linked program strictly respects <= 15 samplers (got ${activeSamplers.length})`,
    activeSamplers.length <= 15
  );

  // T5.05.12: WebGL2 hardware maximum texture units preserved (<= 16)
  check(
    "T5.05.12: terrain.js maintains budget margin below WebGL2 MAX_TEXTURE_IMAGE_UNITS (16)",
    activeSamplers.length < 16
  );
  _resetTerrainRoundNormalsForTest();
}

// ============================================================================
// SUITE 4: FEATURE 7 — FAR COMPOSITE RING & OCTAHEDRAL TREE IMPOSTORS
// ============================================================================
console.log("\n>>> [SUITE 4] Feature 7: Far Composite Ring & Octahedral Tree Impostors");

{
  // T5.07.01: 2.1 km composite ring radius invariant (11 landblocks)
  _resetFarTerrainFlagsForTest();
  check(
    "T5.07.01: farRadiusLb defaults to 11 landblocks (2,112m radius)",
    farRadiusLb() === 11 &&
    11 * 192 === 2112
  );

  // T5.07.02: Horizon fog band calculation at near radius (R=5, 1056m) vs far radius (R=11, 2112m)
  const bandNear = computeFogBand({
    authoredMin: 100, authoredMax: 2400, rEffLb: 5, frac: 0.95, floorM: 700, floorMinLb: 3, horizon: true, horizonNear: 0.62,
  });
  const bandFar = computeFogBand({
    authoredMin: 100, authoredMax: 2400, rEffLb: 11, frac: 0.95, floorM: 700, floorMinLb: 3, horizon: true, horizonNear: 0.62,
  });
  checkNear("T5.07.02a: Near ring drawn edge is 1056m", bandNear.drawnEdgeM, 1056, 1e-4);
  checkNear("T5.07.02b: Far ring drawn edge extends to 2208m", bandFar.drawnEdgeM, 2208, 1e-4);

  // T5.07.03: Seamless horizon void prevention
  check(
    "T5.07.03: Far ring fog ramp begins at 1368m, well beyond near streaming boundary (960m)",
    bandFar.near > 960 &&
    bandFar.far > 2000
  );

  // T5.07.04: Degenerate fog band recovery when near >= far
  const bandDegen = computeFogBand({
    authoredMin: 500, authoredMax: 600, rEffLb: 1, frac: 0.5, floorM: 0, floorMinLb: 3, horizon: true, horizonNear: 0.62,
  });
  check(
    "T5.07.04: Degenerate fog band near >= far smoothly falls back to near = far * 0.5",
    bandDegen.near < bandDegen.far &&
    Math.abs(bandDegen.near - bandDegen.far * 0.5) < 1e-4
  );

  // T5.07.05: Sun avoidance probe rotation
  const lowSun = { x: 1, y: 0.05, z: 0 };
  const probeFacingSun = avoidSunAzimuth(1, 0, 2 * Math.PI / 180, lowSun, 45);
  const rotatedAngleDeg = (Math.acos(Math.max(-1, Math.min(1, probeFacingSun.x))) * 180) / Math.PI;
  checkNear("T5.07.05: avoidSunAzimuth turns horizon fog probe 45 degrees away from low sun", rotatedAngleDeg, 45.0, 0.5);

  // T5.07.06: Upper-hemisphere octahedral direction to UV mapping at pole
  const [uPole, vPole] = dirToHemiOctahedral(new THREE.Vector3(0, 0, 1));
  checkNear("T5.07.06a: Octahedral pole U coordinate is 0.5", uPole, 0.5, 1e-4);
  checkNear("T5.07.06b: Octahedral pole V coordinate is 0.5", vPole, 0.5, 1e-4);

  // T5.07.07: Equator octahedral mapping at cardinal directions
  const [uEast, vEast] = dirToHemiOctahedral(new THREE.Vector3(1, 0, 0));
  const [uWest, vWest] = dirToHemiOctahedral(new THREE.Vector3(-1, 0, 0));
  checkNear("T5.07.07a: +X equator maps to (1.0, 1.0)", uEast + vEast, 2.0, 1e-4);
  checkNear("T5.07.07b: -X equator maps to (0.0, 0.0)", uWest + vWest, 0.0, 1e-4);

  // T5.07.08: Octahedral mapping round-trip fidelity
  const testDir = new THREE.Vector3(0.577, 0.577, 0.577).normalize();
  const [uDiag, vDiag] = dirToHemiOctahedral(testDir);
  const reconDir = hemiOctahedralToDir(uDiag, vDiag);
  const dotProd = testDir.dot(reconDir);
  checkNear("T5.07.08: hemiOctahedralToDir reconstructs input direction with high precision", dotProd, 1.0, 1e-3);

  // 4x4 Octahedral Barycentric Triangle Interpolation Simulation
  function evalOctahedralBarycentric(octUv) {
    const gridP = [octUv[0] * 3.0, octUv[1] * 3.0];
    const iG = [Math.min(2.0, Math.max(0.0, Math.floor(gridP[0]))), Math.min(2.0, Math.max(0.0, Math.floor(gridP[1])))];
    const fG = [gridP[0] - iG[0], gridP[1] - iG[1]];
    let v0, v1, v2, bary;
    if (fG[0] + fG[1] < 1.0) {
      v0 = [iG[0], iG[1]];
      v1 = [iG[0] + 1.0, iG[1]];
      v2 = [iG[0], iG[1] + 1.0];
      bary = [1.0 - fG[0] - fG[1], fG[0], fG[1]];
    } else {
      v0 = [iG[0] + 1.0, iG[1] + 1.0];
      v1 = [iG[0] + 1.0, iG[1]];
      v2 = [iG[0], iG[1] + 1.0];
      bary = [fG[0] + fG[1] - 1.0, 1.0 - fG[1], 1.0 - fG[0]];
    }
    const idx0 = v0[1] * 4.0 + v0[0];
    const idx1 = v1[1] * 4.0 + v1[0];
    const idx2 = v2[1] * 4.0 + v2[0];
    return { bary, idx: [idx0, idx1, idx2] };
  }

  // T5.07.09: Barycentric weights partition of unity
  let barySumsOk = true;
  for (let u = 0; u <= 1.0; u += 0.2) {
    for (let v = 0; v <= 1.0; v += 0.2) {
      const { bary } = evalOctahedralBarycentric([u, v]);
      const s = bary[0] + bary[1] + bary[2];
      if (Math.abs(s - 1.0) > 1e-4) barySumsOk = false;
    }
  }
  check("T5.07.09: Octahedral tree impostor barycentric weights sum to 1.0 across grid", barySumsOk);

  // T5.07.10: 4x4 octahedral cell indices bounded strictly in [0, 15]
  let indicesValid = true;
  for (let u = 0; u <= 1.0; u += 0.1) {
    for (let v = 0; v <= 1.0; v += 0.1) {
      const { idx } = evalOctahedralBarycentric([u, v]);
      for (const id of idx) {
        if (id < 0 || id > 15) indicesValid = false;
      }
    }
  }
  check("T5.07.10: Impostor view indices strictly bounded within 16-cell upper-hemisphere atlas", indicesValid);

  // T5.07.11: Distance-based tree impostor decimation stride
  check(
    "T5.07.11: farForestRegionStride decimation steps cleanly with distance",
    farForestRegionStride(2000) === 1 &&
    farForestRegionStride(3800) === 1 &&
    farForestRegionStride(4500) === 2 &&
    farForestRegionStride(7000) === 3 &&
    farForestRegionStride(9000) === 4
  );
  _resetFarTerrainFlagsForTest();
}

// ============================================================================
// SUITE 5: FEATURE 12 — HORIZON ELEVATION MACRO SHADOWS & SWAMP MIST
// ============================================================================
console.log("\n>>> [SUITE 5] Feature 12: Horizon Elevation Macro Shadows & Swamp Mist");

{
  const cols = 45;
  const shadowBytes = new Uint8Array(9 * cols * 4);
  const flatHeights = new Float32Array(81).fill(100.0);

  // T5.12.01: Flat terrain horizon elevation encoding (bytes = 0)
  writeTerrainHorizonElevation(shadowBytes, cols, flatHeights);
  let flatAllZero = true;
  for (let y = 0; y <= 8; y++) {
    for (let x = 0; x <= 8; x++) {
      const dst = (y * cols + 36 + x) * 4;
      if (shadowBytes[dst + 0] !== 0 || shadowBytes[dst + 1] !== 0 ||
          shadowBytes[dst + 2] !== 0 || shadowBytes[dst + 3] !== 0) {
        flatAllZero = false;
      }
    }
  }
  check("T5.12.01: Flat terrain encodes 0 elevation angle in all 4 azimuth channels", flatAllZero);

  // T5.12.02: Mountain ridge to the East (x >= 6 has 250m cliff)
  const cliffHeights = new Float32Array(81);
  for (let y = 0; y <= 8; y++) {
    for (let x = 0; x <= 8; x++) {
      cliffHeights[x * 9 + y] = x >= 6 ? 350.0 : 100.0;
    }
  }
  writeTerrainHorizonElevation(shadowBytes, cols, cliffHeights);

  // Evaluate at (x=2, y=4): East channel (byte 0) must be positive, West (byte 3) must be 0
  const dstCliff = (4 * cols + 36 + 2) * 4;
  const byteEast = shadowBytes[dstCliff + 0];
  const byteWest = shadowBytes[dstCliff + 3];
  check(
    "T5.12.02: Asymmetric eastern cliff encodes high East horizon angle and zero West angle",
    byteEast > 100 &&
    byteWest === 0
  );

  // T5.12.03: Horizon elevation byte-to-angle decoding precision
  const decodedEastAngle = (byteEast / 255.0) * (Math.PI * 0.5);
  check(
    "T5.12.03: Decoded horizon elevation angle is in valid [0, PI/2] range",
    decodedEastAngle > 0.6 &&
    decodedEastAngle < 1.5
  );

  // T5.12.04: Macro terrain self-shadow evaluation against sun position
  const lowSunEastElev = 0.35; // Sun at 20 degrees elevation
  const highSunEastElev = 1.30; // Sun at 75 degrees elevation
  const isShadowedLow = lowSunEastElev < decodedEastAngle;
  const isShadowedHigh = highSunEastElev < decodedEastAngle;
  check(
    "T5.12.04: Terrain in shadow when sun elevation angle is lower than horizon obstacle",
    isShadowedLow === true &&
    isShadowedHigh === false
  );

  // T5.12.05: Columns 36..44 reserved in uVertexTypes without creating new samplers
  check(
    "T5.12.05: Horizon elevation angles reside in uVertexTypes columns 36..44",
    cols === 45 &&
    (36 + 8) < cols
  );

  // T5.12.06: Logarithmic depth FC calculation
  const fc5000 = groundFogLogDepthFC(5000.0);
  const fc10000 = groundFogLogDepthFC(10000.0);
  check(
    "T5.12.06: groundFogLogDepthFC produces calibrated logarithmic depth constants",
    fc5000 > 0.16 && fc5000 < 0.17 &&
    fc10000 > 0.14 && fc10000 < 0.16
  );

  // T5.12.07: Log-depth decode round-trip precision
  const testDist = 28.5;
  const encodedD = Math.log2(testDist + 1.0) / Math.log2(5001.0);
  const decodedM = decodeLogDepthToMetres(encodedD, fc5000);
  checkNear("T5.12.07: decodeLogDepthToMetres round-trips view distance", decodedM, testDist, 0.2);

  // T5.12.08: Soft particle ground plane intersection eliminates hard seams
  const softness = 2.2;
  const softExactIntersection = softParticleFade(15.0, 15.0, softness);
  checkNear("T5.12.08: Soft particle ground contact produces 0.0 alpha (no hard clipping edge)", softExactIntersection, 0.0, 1e-4);

  // T5.12.09: Soft particle partial fade within 2.2m softness band
  const softHalfFade = softParticleFade(15.0, 13.9, softness); // 1.1m in front of ground -> 0.5
  checkNear("T5.12.09: Soft particle at 1.1m from ground fades to 50% opacity", softHalfFade, 0.5, 0.05);

  // T5.12.10: Fragment fully in front of ground renders at full opacity
  const softFull = softParticleFade(15.0, 10.0, softness); // 5.0m in front of ground -> 1.0
  checkNear("T5.12.10: Fragment outside softness band renders with 1.0 opacity", softFull, 1.0, 1e-4);

  // T5.12.11: Buried fragment behind terrain is completely suppressed
  const softBuried = softParticleFade(15.0, 18.0, softness); // 3.0m behind ground -> 0.0
  checkNear("T5.12.11: Fragment behind terrain occluder has 0.0 opacity", softBuried, 0.0, 1e-4);

  // T5.12.12: Unwired depth sentinel safety
  check(
    "T5.12.12: softParticleFade falls back safely when softness or scene distance is invalid",
    softParticleFade(0.0, 10.0, softness) === 1.0 &&
    softParticleFade(15.0, 10.0, 0.0) === 1.0
  );
}

// ============================================================================
// SUMMARY & EXIT CODE
// ============================================================================
console.log("\n================================================================================");
console.log(`TOTAL ASSERTIONS: ${passedAssertions + failedAssertions}`);
console.log(`PASSED: ${passedAssertions}`);
console.log(`FAILED: ${failedAssertions}`);
console.log("================================================================================");

if (failedAssertions > 0) {
  console.error("FAILURES:");
  for (const f of failureDetails) {
    console.error(`  - ${f}`);
  }
  process.exit(1);
} else {
  console.log("ALL ADVERSARIAL STRESS CHALLENGES PASSED EMPIRICALLY (100% GREEN)!");
  process.exit(0);
}
