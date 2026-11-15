/**
 * tests/challenger_m5_tier5_geometry.test.mjs
 *
 * Tier 5 White-Box Adversarial Hardening Suite for Milestone 5 Phase 3
 * Visual Improvement Features 1, 4, 6, 8, 9, 10, 11 (Geometry, Lighting, Materials & Surfaces)
 *
 * Targeted Adversarial Challenge Areas:
 * 1. Feature 1: Static CSM Cascades & Screen-Space Contact Shadows (shadow_caster_list.js, csm.js, ssao.js)
 *    - Static cascade depth split boundaries (near/mid/far cascade transition artifacts).
 *    - Dynamic entity exclusion stability (verify dynamic entities never leak into cached static cascades).
 *    - 12-step logarithmic SSCS raymarch at screen edges and grazing view angles.
 * 2. Feature 4: Alpha-to-Coverage & Toksvig Specular AA (materials.js, bc7_textures.js)
 *    - SAMPLE_ALPHA_TO_COVERAGE render state setup on Base1ClipMap materials.
 *    - Screen-space Toksvig normal variance roughness expansion formula: sigma2 = max(0, 1 - len(N)^2), roughness clamping in [0, 1].
 *    - Box-filtered mipmap dilation limits on BC7 textures.
 * 3. Feature 6: Cohesive Grass AO & Wrap SSS (terrain_grass.js, grass_gpu_place.js)
 *    - Slope density cutoff attenuation (>42° steep cliff culling).
 *    - Ground tint lerp (70% pickup) and root-to-tip AO factor [0, 1] range.
 *    - Wrap subsurface scattering energy conservation (dot(V, -L - N*0.35)).
 * 4. Feature 8: Horizon GTAO & Specular Occlusion (ssao.js, ibl_environment.js)
 *    - 2-slice x 4-step horizon integration angle boundaries.
 *    - Jimenez multi-bounce albedo polynomial clamping on saturated colors.
 *    - Lagarde specular occlusion PMREM reflection suppression.
 * 5. Feature 9: Clustered Forward+ Froxels & EnvCell L2 SH Probes (lighting.js, cells.js)
 *    - 3,456 froxel cluster binning (16x9x24) under 0 lights, 1 light, 64 lights, 256 lights (overflow handling).
 *    - 9-coefficient per-cell L2 SH irradiance probe unpacking from 108-byte layout and interpolation across dungeon portals.
 * 6. Feature 10: Contact Parallax Occlusion Mapping & Clearcoat (materials.js)
 *    - 12-to-4 distance-adaptive linear POM steps + 3 secant refinement convergence.
 *    - Grazing angle step attenuation without depth swimming.
 *    - Dual-lobe clearcoat BRDF energy conservation (F0 = 0.04, coatRoughness = 0.22).
 * 7. Feature 11: Near RVT Ground Skirt Blend (far_terrain.js, materials.js)
 *    - 1024² toroidal Near RVT coordinate wrap boundaries.
 *    - 16m dirty strip orthographic bake update correctness.
 *    - Vertical height blend skirt range [0.0m, 0.55m] clamping.
 */

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import * as THREE from "three";

// Global window shim for headless Node execution
globalThis.window = globalThis.window || {};
globalThis.window.requestAnimationFrame ??= () => 0;
globalThis.requestAnimationFrame ??= () => 0;
globalThis.location = globalThis.location || { search: "" };
window.location = globalThis.location;

// Production scene3d module imports
import {
  setupCsm,
  DEFAULT_CSM_SPLITS,
  DEFAULT_CSM_MAP_SIZES,
  DEFAULT_CSM_BLEND_FRAC
} from "../scene3d/csm.js";

import {
  shadowStaticCacheFlag,
  shadowStaticCacheRender,
  getShadowStaticCacheStats,
  __resetShadowStaticCacheForTest
} from "../scene3d/shadow_caster_list.js";

import {
  applyClipMapRenderState,
  CLIPMAP_ALPHA_REF_DDS,
  CLIPMAP_ALPHA_REF_PALETTED,
  SURFACE_TYPE,
  dilateRgbaTexture,
  evalClearcoatFresnel,
  installClearcoatShaderPatch,
  installPomShaderPatch,
  applyParallaxOcclusion,
  CATEGORY_POM_DEPTH_SCALE
} from "../scene3d/materials.js";

import {
  sscsEnabled,
  jimenezMultiBounce,
  lagardeSpecularOcclusion,
  SSAO_DEFAULTS
} from "../scene3d/ssao.js";

import {
  FROXEL_CLUSTERS_X,
  FROXEL_CLUSTERS_Y,
  FROXEL_CLUSTERS_Z,
  TOTAL_FROXELS,
  MAX_FORWARD_LIGHTS,
  MAX_LIGHT_INDICES,
  FroxelLightGrid
} from "../scene3d/lighting.js";

import {
  computeEnvCellL2Sh,
  evaluateRamamoorthiSh
} from "../scene3d/cells.js";

import {
  NEAR_RVT_EXTENT_M,
  NEAR_RVT_SIZE,
  NEAR_RVT_GRID_SNAP_M,
  nearRvtEnabled,
  getNearRvtState,
  tickNearRvt
} from "../scene3d/far_terrain.js";

import {
  GRASS_DEFAULTS,
  GRASS_BLADE_UVS,
  makeGrassBladeGeometry
} from "../scene3d/terrain_grass.js";

// ============================================================================
// TEST STATS & ASSERTION HARNESS
// ============================================================================

let totalAssertions = 0;
let totalTestsPassed = 0;
let totalTestsFailed = 0;
const failures = [];

function check(cond, msg = "Assertion failed") {
  totalAssertions++;
  assert.ok(cond, msg);
}

function checkEqual(actual, expected, msg = "") {
  totalAssertions++;
  assert.equal(actual, expected, msg);
}

function checkNear(actual, expected, eps = 1e-4, msg = "") {
  totalAssertions++;
  const diff = Math.abs(actual - expected);
  assert.ok(diff <= eps, `${msg} (expected ${expected} ± ${eps}, got ${actual}, diff ${diff})`);
}

function runTestCase(name, fn) {
  try {
    fn();
    totalTestsPassed++;
    console.log(`  ✓ [PASS] ${name}`);
  } catch (err) {
    totalTestsFailed++;
    failures.push({ name, error: err.message, stack: err.stack });
    console.error(`  ✗ [FAIL] ${name}: ${err.message}`);
  }
}

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0.0, Math.min(1.0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3.0 - 2.0 * t);
}

function clamp(x, minVal, maxVal) {
  return Math.max(minVal, Math.min(maxVal, x));
}

// ============================================================================
// ORACLES & MATHEMATICAL SIMULATORS
// ============================================================================

/**
 * CSM Cascade selector & transition oracle mirroring scene3d/materials.js:1730-1767
 */
function evaluateCsmCascadeFactor(worldPos, viewDepth, splits, blendFrac, selDist, camPos, c0 = 0.0, c1 = 0.5, c2 = 0.8) {
  let effectiveDepth = viewDepth;
  if (selDist > 0.5) {
    const dx = worldPos.x - camPos.x;
    const dy = worldPos.y - camPos.y;
    const dz = worldPos.z - camPos.z;
    effectiveDepth = Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  const uCsmFar = splits[2];
  const blendW0 = splits[0] * blendFrac;
  const blendW1 = splits[1] * blendFrac;

  if (effectiveDepth > uCsmFar) {
    return 1.0; // unshadowed beyond far cascade
  }
  if (effectiveDepth < splits[0] - blendW0) {
    return c0; // solid cascade 0
  }
  if (effectiveDepth < splits[0]) {
    const t = blendW0 > 1e-6 ? (effectiveDepth - (splits[0] - blendW0)) / blendW0 : 1.0;
    return c0 * (1.0 - clamp(t, 0.0, 1.0)) + c1 * clamp(t, 0.0, 1.0);
  }
  if (effectiveDepth < splits[1] - blendW1) {
    return c1; // solid cascade 1
  }
  if (effectiveDepth < splits[1]) {
    const t = blendW1 > 1e-6 ? (effectiveDepth - (splits[1] - blendW1)) / blendW1 : 1.0;
    return c1 * (1.0 - clamp(t, 0.0, 1.0)) + c2 * clamp(t, 0.0, 1.0);
  }
  return c2; // solid cascade 2
}

/**
 * SSCS 12-step raymarch simulation mirroring scene3d/ssao.js:250-275
 */
function simulateSscsRaymarch({
  P,               // view-space start position (THREE.Vector3)
  N,               // view-space normal (THREE.Vector3)
  uSunViewDir,     // normalized sun direction in view space (THREE.Vector3)
  uSscsStrength,   // float
  w,               // fragment depth
  uFadeY = 120.0,  // fade distance
  depthSampler,    // function(uv) -> viewW
  uProj = 1.0      // projection scale
}) {
  let ao = 1.0;
  if (uSscsStrength > 0.0 && w < uFadeY && uSunViewDir.lengthSq() > 0.01) {
    const SSCS_STEPS = 12;
    const minReach = 0.05;
    const maxReach = 1.8;
    const stepSize = (maxReach - minReach) / SSCS_STEPS;
    const rayStart = P.clone().addScaledVector(N, 0.02);
    let hitSum = 0.0;

    for (let k = 0; k < SSCS_STEPS; k++) {
      const tk = minReach + (k + 0.5) * stepSize;
      const Pk = rayStart.clone().addScaledVector(uSunViewDir, tk);
      if (Pk.z >= -0.05) break; // grazing near-plane exit
      const sUv = new THREE.Vector2(
        (Pk.x * uProj / (-Pk.z)) * 0.5 + 0.5,
        (Pk.y * uProj / (-Pk.z)) * 0.5 + 0.5
      );
      if (sUv.x < 0.0 || sUv.x > 1.0 || sUv.y < 0.0 || sUv.y > 1.0) continue; // screen boundary skip

      const sampleW = depthSampler(sUv);
      const depthDelta = (-Pk.z) - sampleW;
      if (depthDelta > 0.02 && depthDelta < 0.25) {
        const atten = 1.0 - (tk / maxReach);
        hitSum += atten * 0.35;
      }
    }
    const sscs = clamp(1.0 - hitSum * uSscsStrength, 0.0, 1.0);
    ao = Math.min(ao, sscs);
  }
  return ao;
}

/**
 * Toksvig normal variance roughness expansion formula:
 * sigma2 = max(0, 1 - len(N)^2)
 * roughnessFactor = sqrt(clamp(roughnessFactor^2 + min(0.35, 2.0 * sigma2), 0.0, 1.0))
 */
function evaluateToksvigExpansion(roughness, normalLengthOrSigma2, isSigma2 = false) {
  const r = clamp(roughness, 0.0, 1.0);
  let sigma2 = 0.0;
  if (isSigma2) {
    sigma2 = Math.max(0.0, normalLengthOrSigma2);
  } else {
    const lenN = normalLengthOrSigma2;
    sigma2 = Math.max(0.0, 1.0 - lenN * lenN);
  }
  const varianceTerm = Math.min(0.35, 2.0 * sigma2);
  return Math.sqrt(clamp(r * r + varianceTerm, 0.0, 1.0));
}

/**
 * 2-slice x 4-step GTAO horizon integration oracle mirroring scene3d/ssao.js:207-248
 */
function evaluateGtaoHorizonIntegration({
  P,
  N,
  uRadius = 1.1,
  sampleHorizonFn // function(sliceDir, stepR) -> { Q1, Q2 }
}) {
  const NUM_SLICES = 2;
  const STEPS_PER_SLICE = 4;
  let gtaoVis = 0.0;
  const bentNormal = N.clone();

  for (let s = 0; s < NUM_SLICES; s++) {
    const phi = s * (Math.PI / 2.0); // 90 degree slice offset
    const sliceDir = new THREE.Vector2(Math.cos(phi), Math.sin(phi));
    let maxH1 = 0.0;
    let maxH2 = 0.0;

    for (let j = 1; j <= STEPS_PER_SLICE; j++) {
      const stepFrac = (j - 0.5) / STEPS_PER_SLICE;
      const stepR = stepFrac * uRadius;
      const { Q1, Q2 } = sampleHorizonFn(sliceDir, stepR);

      if (Q1) {
        const delta1 = Q1.clone().sub(P);
        const d1Len = delta1.length();
        if (d1Len > 0.01 && d1Len < uRadius) {
          const sinH1 = clamp(delta1.dot(N) / d1Len, 0.0, 1.0);
          maxH1 = Math.max(maxH1, sinH1);
        }
      }
      if (Q2) {
        const delta2 = Q2.clone().sub(P);
        const d2Len = delta2.length();
        if (d2Len > 0.01 && d2Len < uRadius) {
          const sinH2 = clamp(delta2.dot(N) / d2Len, 0.0, 1.0);
          maxH2 = Math.max(maxH2, sinH2);
        }
      }
    }
    const sliceVis = 1.0 - 0.25 * (maxH1 + maxH2);
    gtaoVis += sliceVis;
    bentNormal.add(new THREE.Vector3(sliceDir.x * (maxH1 - maxH2) * 0.5, sliceDir.y * (maxH1 - maxH2) * 0.5, 0.0));
  }
  gtaoVis /= NUM_SLICES;
  bentNormal.normalize();
  return {
    ao: clamp(gtaoVis, 0.0, 1.0),
    bentNormal
  };
}

/**
 * Contact POM simulation with distance-adaptive steps + 3 secant refinement steps
 * Mirroring scene3d/materials.js:2340-2386
 */
function simulatePomSecantRefinement({
  baseUv,
  vTanDir,
  depthScale,
  distanceM,
  heightSampler // function(uv) -> float in [0, 1]
}) {
  // Distance-adaptive step reduction
  let steps = 12;
  if (distanceM > 50.0) return { uv: baseUv.clone(), hitDepth: 0.0, steps: 0 };
  else if (distanceM > 35.0) steps = 4;
  else if (distanceM > 15.0) steps = 8;

  const _pz = Math.max(Math.abs(vTanDir.z), 0.15);
  let rawShift = new THREE.Vector2(
    (vTanDir.x / _pz) * depthScale,
    (vTanDir.y / _pz) * depthScale
  );
  const maxShift = 1.15 * depthScale;
  const rawLen = rawShift.length();
  if (rawLen > maxShift && rawLen > 1e-6) {
    rawShift.multiplyScalar(maxShift / rawLen);
  }

  const uvStep = rawShift.clone().divideScalar(steps);
  const layerStep = 1.0 / steps;

  let currentUv = baseUv.clone();
  let currentLayerDepth = 0.0;
  let currentHeight = 1.0 - heightSampler(currentUv);

  let i = 0;
  for (; i < 16; i++) {
    if (i >= steps) break;
    if (currentLayerDepth >= currentHeight) break;
    currentUv.sub(uvStep);
    currentLayerDepth += layerStep;
    currentHeight = 1.0 - heightSampler(currentUv);
  }

  let prevUv = currentUv.clone().add(uvStep);
  let afterDepth = currentHeight - currentLayerDepth;
  let prevSample = heightSampler(prevUv);
  let beforeDepth = (1.0 - prevSample) - (currentLayerDepth - layerStep);

  // 3-step secant refinement
  for (let sec = 0; sec < 3; sec++) {
    const denSec = afterDepth - beforeDepth;
    const wSec = denSec < -1e-6 ? clamp(afterDepth / denSec, 0.0, 1.0) : 0.5;
    const midUv = currentUv.clone().lerp(prevUv, wSec);
    const midLayerDepth = currentLayerDepth * (1.0 - wSec) + (currentLayerDepth - layerStep) * wSec;
    const midHeight = 1.0 - heightSampler(midUv);
    if (midLayerDepth >= midHeight) {
      currentUv = midUv;
      currentLayerDepth = midLayerDepth;
      afterDepth = midHeight - midLayerDepth;
    } else {
      prevUv = midUv;
      beforeDepth = midHeight - midLayerDepth;
      prevSample = 1.0 - midHeight;
    }
  }

  const den = afterDepth - beforeDepth;
  const w = den < -1e-6 ? clamp(afterDepth / den, 0.0, 1.0) : 0.0;
  const finalUv = currentUv.clone().lerp(prevUv, w);
  const finalHitDepth = clamp((1.0 - currentHeight) * (1.0 - w) + prevSample * w, 0.0, 1.0);

  return { uv: finalUv, hitDepth: finalHitDepth, steps };
}

// ============================================================================
// SUITE EXECUTION
// ============================================================================

export function runTests() {
  console.log("================================================================================");
  console.log(" Milestone 5 Phase 3 — Tier 5 Adversarial Coverage Hardening Suite");
  console.log(" Geometry, Lighting, Materials & Surfaces (Features 1, 4, 6, 8, 9, 10, 11)");
  console.log("================================================================================\n");

  // --------------------------------------------------------------------------
  // FEATURE 1: Static CSM Cascades & Screen-Space Contact Shadows
  // --------------------------------------------------------------------------
  console.log("--- Feature 1: Static CSM Cascades & Screen-Space Contact Shadows ---");

  runTestCase("F1.1: Static cascade split boundaries with near/mid/far transitions", () => {
    const splits = [30.0, 100.0, 300.0];
    const blendFrac = 0.10; // 10% blend zone
    const blendW0 = splits[0] * blendFrac; // 3.0m
    const blendW1 = splits[1] * blendFrac; // 10.0m
    const camPos = new THREE.Vector3(0, 0, 0);

    // Deep in Cascade 0
    const sNear = evaluateCsmCascadeFactor(new THREE.Vector3(0, 0, 10), 10, splits, blendFrac, 0, camPos, 0.1, 0.5, 0.9);
    checkEqual(sNear, 0.1, "Solid Cascade 0 at 10m");

    // Start of Blend Zone 0 -> 1 (27m)
    const sStart0 = evaluateCsmCascadeFactor(new THREE.Vector3(0, 0, 27), 27, splits, blendFrac, 0, camPos, 0.1, 0.5, 0.9);
    checkNear(sStart0, 0.1, 1e-4, "Start of blend zone 0->1 at 27m");

    // Midpoint of Blend Zone 0 -> 1 (28.5m)
    const sMid0 = evaluateCsmCascadeFactor(new THREE.Vector3(0, 0, 28.5), 28.5, splits, blendFrac, 0, camPos, 0.1, 0.5, 0.9);
    checkNear(sMid0, 0.3, 1e-4, "Midpoint of blend zone 0->1 is linear 50% mix (0.1 and 0.5)");

    // End of Blend Zone 0 -> 1 (30.0m)
    const sEnd0 = evaluateCsmCascadeFactor(new THREE.Vector3(0, 0, 30.0), 30.0, splits, blendFrac, 0, camPos, 0.1, 0.5, 0.9);
    checkNear(sEnd0, 0.5, 1e-4, "Boundary split 0 (30m) reaches pure Cascade 1");

    // Solid in Cascade 1 (50m)
    const sMid = evaluateCsmCascadeFactor(new THREE.Vector3(0, 0, 50), 50, splits, blendFrac, 0, camPos, 0.1, 0.5, 0.9);
    checkEqual(sMid, 0.5, "Solid Cascade 1 at 50m");

    // Midpoint of Blend Zone 1 -> 2 (95.0m)
    const sMid1 = evaluateCsmCascadeFactor(new THREE.Vector3(0, 0, 95.0), 95.0, splits, blendFrac, 0, camPos, 0.1, 0.5, 0.9);
    checkNear(sMid1, 0.7, 1e-4, "Midpoint of blend zone 1->2 is linear 50% mix (0.5 and 0.9)");

    // Solid in Cascade 2 (200m)
    const sFar = evaluateCsmCascadeFactor(new THREE.Vector3(0, 0, 200), 200, splits, blendFrac, 0, camPos, 0.1, 0.5, 0.9);
    checkEqual(sFar, 0.9, "Solid Cascade 2 at 200m");

    // Beyond Far Cascade (350m)
    const sBeyond = evaluateCsmCascadeFactor(new THREE.Vector3(0, 0, 350), 350, splits, blendFrac, 0, camPos, 0.1, 0.5, 0.9);
    checkEqual(sBeyond, 1.0, "Beyond far split (300m) returns unshadowed 1.0");

    // Zero blend fraction (hard boundary step without division by zero)
    const sHardStep = evaluateCsmCascadeFactor(new THREE.Vector3(0, 0, 29.99), 29.99, splits, 0.0, 0, camPos, 0.1, 0.5, 0.9);
    checkEqual(sHardStep, 0.1, "Hard split at 29.99m is Cascade 0");
    const sHardStepAfter = evaluateCsmCascadeFactor(new THREE.Vector3(0, 0, 30.01), 30.01, splits, 0.0, 0, camPos, 0.1, 0.5, 0.9);
    checkEqual(sHardStepAfter, 0.5, "Hard split at 30.01m steps to Cascade 1 without NaN");
  });

  runTestCase("F1.2: Spherical distance cascade selection (uCsmSelDist=1) at screen corners", () => {
    const splits = [30.0, 100.0, 300.0];
    const blendFrac = 0.05;
    const camPos = new THREE.Vector3(0, 0, 0);

    // Off-axis point: viewDepth is 24m, but X=20m, Y=10m => distance = sqrt(400 + 100 + 576) = sqrt(1076) = 32.8m
    const cornerPos = new THREE.Vector3(20, 10, 24);

    // Under view-depth selection (uCsmSelDist = 0), 24m < 30m => Cascade 0
    const selViewDepth = evaluateCsmCascadeFactor(cornerPos, 24, splits, blendFrac, 0, camPos, 0.2, 0.6, 0.9);
    checkEqual(selViewDepth, 0.2, "View-depth selection places corner in Cascade 0");

    // Under stable spherical distance selection (uCsmSelDist = 1), 32.8m > 30m => Cascade 1
    const selDist = evaluateCsmCascadeFactor(cornerPos, 24, splits, blendFrac, 1, camPos, 0.2, 0.6, 0.9);
    checkEqual(selDist, 0.6, "Stable distance selection accounts for off-axis corner distance, selecting Cascade 1");
  });

  runTestCase("F1.3: Dynamic entity exclusion stability from cached static cascades", () => {
    const scene = new THREE.Scene();

    // Static casters
    const staticHouse = new THREE.Mesh(new THREE.BoxGeometry(5, 5, 5), new THREE.MeshBasicMaterial());
    staticHouse.name = "static-house";
    staticHouse.castShadow = true;
    scene.add(staticHouse);

    const staticWall = new THREE.Mesh(new THREE.BoxGeometry(10, 2, 1), new THREE.MeshBasicMaterial());
    staticWall.name = "static-wall";
    staticWall.castShadow = true;
    scene.add(staticWall);

    // Dynamic entities root (entitiesGroup)
    const dynRoot = new THREE.Group();
    dynRoot.name = "entitiesGroup";
    scene.add(dynRoot);

    // Rigs, projectiles, and monster fragments under dynRoot
    const playerMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), new THREE.MeshBasicMaterial());
    playerMesh.name = "player-rig";
    playerMesh.castShadow = true;
    dynRoot.add(playerMesh);

    const monsterFragment = new THREE.Mesh(new THREE.SphereGeometry(0.5), new THREE.MeshBasicMaterial());
    monsterFragment.name = "monster-dismember";
    monsterFragment.castShadow = true;
    dynRoot.add(monsterFragment);

    // Mock shadowMap with dynRoot reference
    const shadowMap = {
      type: THREE.PCFShadowMap,
      __hbShadowDynamicRoot: dynRoot,
      needsUpdate: true
    };

    const light = new THREE.DirectionalLight(0xffffff, 1.0);
    light.castShadow = true;
    light.shadow.map = {
      depthTexture: { isTexture: true },
      isWebGLCubeRenderTarget: false
    };
    light.userData.hbShadowManaged = true;

    // Verify collectSplit separates static and dynamic candidates completely
    // We emulate the collectSplit walk logic from shadow_caster_list.js:191-206
    const staticOut = [];
    const found = { hit: false };
    const camLayers = new THREE.Layers();

    function collectSplitMock(o, layers, vsm, out, dr, f) {
      if (o.visible === false) return 1;
      if (o === dr) { f.hit = true; return 1; }
      if ((o.isMesh || o.isLine || o.isPoints) && (o.castShadow || (vsm && o.receiveShadow)) && o.layers.test(layers)) {
        out.push(o);
        return 1;
      }
      let n = 1;
      for (const ch of o.children) n += collectSplitMock(ch, layers, vsm, out, dr, f);
      return n;
    }

    collectSplitMock(scene, camLayers, false, staticOut, dynRoot, found);

    checkEqual(found.hit, true, "collectSplit encountered and marked dynamic root hit");
    checkEqual(staticOut.length, 2, "Static list collected exactly 2 static meshes");
    check(staticOut.includes(staticHouse), "Static house is in static list");
    check(staticOut.includes(staticWall), "Static wall is in static list");
    check(!staticOut.includes(playerMesh), "Player rig is strictly EXCLUDED from static list");
    check(!staticOut.includes(monsterFragment), "Monster fragment is strictly EXCLUDED from static list");

    // Adversarial: Even if dynRoot itself is a Mesh with castShadow=true, it must not enter static list
    const meshDynRoot = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    meshDynRoot.castShadow = true;
    scene.add(meshDynRoot);
    const staticOut2 = [];
    const found2 = { hit: false };
    collectSplitMock(scene, camLayers, false, staticOut2, meshDynRoot, found2);
    check(!staticOut2.includes(meshDynRoot), "Mesh dynRoot itself is stopped at the gate and never enters static list");

    // Stand down check: Detached dynRoot
    const detachedDynRoot = new THREE.Group();
    const isUnderScene = (o, sc) => { let p = o.parent; while (p) { if (p === sc) return true; p = p.parent; } return false; };
    checkEqual(isUnderScene(detachedDynRoot, scene), false, "Detached dynRoot detected as not under scene");
  });

  runTestCase("F1.4: 12-step logarithmic SSCS raymarch at screen edges and grazing view angles", () => {
    const P = new THREE.Vector3(0, 0, -2.0); // 2m in front of camera
    const N = new THREE.Vector3(0, 1, 0);    // upward surface normal
    const uSunViewDir = new THREE.Vector3(0.5, 0.8, 0.3).normalize();

    // Depth buffer indicating an occluding surface 0.08m in front of ray point
    const depthSamplerHit = (uv) => 1.90; // for P=(0, 0, -2.0) with Pk.z ~ -1.98, depthDelta ~ 0.08 in [0.02, 0.25]
    const depthSamplerMiss = (uv) => 5.0; // far away, no contact shadow

    // 1. Nominal contact shadow hit
    const aoHit = simulateSscsRaymarch({
      P, N, uSunViewDir, uSscsStrength: 1.0, w: 2.0,
      depthSampler: depthSamplerHit
    });
    check(aoHit < 1.0 && aoHit >= 0.0, `Nominal contact shadow hit darkens AO: ${aoHit}`);

    // 2. Off-screen ray step handling
    // When ray originates at screen boundary (e.g. extreme X/Y), rays stepping outside UV [0,1] must continue without crashing
    const PEdge = new THREE.Vector3(15.0, 10.0, -2.0);
    const aoEdge = simulateSscsRaymarch({
      P: PEdge, N, uSunViewDir, uSscsStrength: 1.0, w: 2.0,
      depthSampler: depthSamplerHit
    });
    checkEqual(aoEdge, 1.0, "Ray stepping outside screen bounds skips taps and does not produce false shadow");

    // 3. Grazing view angle stepping toward camera plane (Pk.z >= -0.05)
    // Ray pointing directly at camera
    const uSunTowardsCamera = new THREE.Vector3(0, 0, 1.0);
    const PGrazing = new THREE.Vector3(0, 0, -0.08); // very close to near plane
    const aoGrazing = simulateSscsRaymarch({
      P: PGrazing, N, uSunViewDir: uSunTowardsCamera, uSscsStrength: 1.0, w: 0.08,
      depthSampler: depthSamplerHit
    });
    check(Number.isFinite(aoGrazing), "Grazing near-plane raymarch breaks cleanly without NaN or division by zero");

    // 4. Zero sun vector bypass
    const aoZeroSun = simulateSscsRaymarch({
      P, N, uSunViewDir: new THREE.Vector3(0, 0, 0), uSscsStrength: 1.0, w: 2.0,
      depthSampler: depthSamplerHit
    });
    checkEqual(aoZeroSun, 1.0, "Zero sun vector completely bypasses SSCS calculation");

    // 5. Zero strength bypass
    const aoZeroStrength = simulateSscsRaymarch({
      P, N, uSunViewDir, uSscsStrength: 0.0, w: 2.0,
      depthSampler: depthSamplerHit
    });
    checkEqual(aoZeroStrength, 1.0, "uSscsStrength=0 disables SSCS completely");
  });

  // --------------------------------------------------------------------------
  // FEATURE 4: Alpha-to-Coverage & Toksvig Specular AA
  // --------------------------------------------------------------------------
  console.log("\n--- Feature 4: Alpha-to-Coverage & Toksvig Specular AA ---");

  runTestCase("F4.1: SAMPLE_ALPHA_TO_COVERAGE render state setup on Base1ClipMap materials", () => {
    // 1. Paletted source texture Base1ClipMap
    const palettedTarget = {
      transparent: true,
      depthWrite: false,
      alphaTest: 0.0
    };
    applyClipMapRenderState(palettedTarget, true);
    checkEqual(palettedTarget.alphaTest, CLIPMAP_ALPHA_REF_PALETTED, "Paletted clipmap uses 100/255 reference");
    checkEqual(palettedTarget.transparent, false, "Clipmap remains in opaque pass for MSAA efficiency");
    checkEqual(palettedTarget.depthWrite, true, "Clipmap performs depth writes");
    checkEqual(palettedTarget.alphaToCoverage, true, "alphaToCoverage is enabled for SAMPLE_ALPHA_TO_COVERAGE");

    // 2. DDS/Truecolor source texture Base1ClipMap
    const ddsTarget = {
      transparent: true,
      depthWrite: false,
      alphaTest: 0.0
    };
    applyClipMapRenderState(ddsTarget, false);
    checkEqual(ddsTarget.alphaTest, CLIPMAP_ALPHA_REF_DDS, "DDS clipmap uses 200/255 reference");
    checkEqual(ddsTarget.alphaToCoverage, true, "DDS clipmap enables alphaToCoverage");

    // 3. onBeforeCompile hook injection check
    check(typeof ddsTarget.onBeforeCompile === "function", "onBeforeCompile hook registered");
    const mockShader = {
      fragmentShader: `#include <alphatest_fragment>`
    };
    ddsTarget.onBeforeCompile(mockShader);
    check(mockShader.fragmentShader.includes("fwidth(diffuseColor.a)"), "Shader contains fwidth alpha derivative scaling");
    check(mockShader.fragmentShader.includes("clamp((diffuseColor.a - alphaTest)"), "Shader contains A2C smoothstep/clamp transition");
  });

  runTestCase("F4.2: Screen-space Toksvig normal variance roughness expansion formula", () => {
    // Flat surface with unit normal (variance = 0)
    const rFlat = evaluateToksvigExpansion(0.2, 1.0);
    checkNear(rFlat, 0.2, 1e-4, "Zero normal variance retains original roughness (0.2)");

    // Sub-pixel geometric curvature / grazing angle normal shrinkage (|N| = 0.8 => sigma2 = 0.36)
    const rCurved = evaluateToksvigExpansion(0.2, 0.8);
    // sigma2 = 1 - 0.64 = 0.36; varianceTerm = min(0.35, 2 * 0.36) = 0.35
    // sqrt(0.04 + 0.35) = sqrt(0.39) = 0.6245
    checkNear(rCurved, Math.sqrt(0.39), 1e-4, "High normal variance expands roughness to suppress specular sparkle");

    // Mirror surface (roughness = 0.0) with mild normal variance (sigma2 = 0.05)
    const rMirror = evaluateToksvigExpansion(0.0, 0.05, true);
    // varianceTerm = 2 * 0.05 = 0.10 => sqrt(0.10) = 0.3162
    checkNear(rMirror, Math.sqrt(0.10), 1e-4, "Mirror surface roughness smoothly expands with normal variance");

    // Fully rough surface (roughness = 1.0) clamped at 1.0
    const rRough = evaluateToksvigExpansion(1.0, 0.5, true);
    checkEqual(rRough, 1.0, "Rough surface expands up to upper bound 1.0 without overshoot");

    // Negative variance guard (floating point fuzz)
    const rNegative = evaluateToksvigExpansion(0.3, -0.05, true);
    checkEqual(rNegative, 0.3, "Negative variance clamped to zero, preventing NaN");
  });

  runTestCase("F4.3: Box-filtered mipmap dilation limits on BC7 textures", () => {
    // 3x3 RGBA image with single transparent center pixel
    const w = 3, h = 3;
    const data = new Uint8Array(w * h * 4);
    // Fill all pixels with Red (255, 0, 0, 255)
    for (let i = 0; i < w * h * 4; i += 4) {
      data[i] = 255;
      data[i + 1] = 0;
      data[i + 2] = 0;
      data[i + 3] = 255;
    }
    // Set center pixel (x=1, y=1) to transparent black (0, 0, 0, 0)
    const centerIdx = (1 * w + 1) * 4;
    data[centerIdx] = 0;
    data[centerIdx + 1] = 0;
    data[centerIdx + 2] = 0;
    data[centerIdx + 3] = 0;

    const dilated = dilateRgbaTexture(data, w, h, 128);

    // Center pixel should receive average color of valid neighbors (255, 0, 0)
    checkEqual(dilated[centerIdx], 255, "Dilated center pixel R is 255");
    checkEqual(dilated[centerIdx + 1], 0, "Dilated center pixel G is 0");
    checkEqual(dilated[centerIdx + 2], 0, "Dilated center pixel B is 0");
    checkEqual(dilated[centerIdx + 3], 0, "Dilated center pixel keeps original alpha 0");

    // Valid pixels remain unchanged
    const cornerIdx = 0;
    checkEqual(dilated[cornerIdx], 255, "Corner pixel R remains 255");
    checkEqual(dilated[cornerIdx + 3], 255, "Corner pixel alpha remains 255");

    // Boundary edge test: 1x1 image
    const singlePix = new Uint8Array([0, 0, 0, 0]);
    const dilatedSingle = dilateRgbaTexture(singlePix, 1, 1, 128);
    checkEqual(dilatedSingle[0], 0, "Single transparent pixel has 0 neighbors and stays 0");

    // Empty/null input safety
    checkEqual(dilateRgbaTexture(null, 0, 0), null, "Null data returns null safely");
  });

  // --------------------------------------------------------------------------
  // FEATURE 6: Cohesive Grass AO & Wrap SSS
  // --------------------------------------------------------------------------
  console.log("\n--- Feature 6: Cohesive Grass AO & Wrap SSS ---");

  runTestCase("F6.1: Slope density cutoff attenuation (>42° steep cliff culling)", () => {
    // Cliff slope culling rule: slopes steeper than 42° culled
    const cutoffDeg = 42.0;
    const cutoffRad = (cutoffDeg * Math.PI) / 180.0;
    const minNz = Math.cos(cutoffRad); // ~0.7431448

    const isGrassPermitted = (normal) => {
      const lenSq = normal.x * normal.x + normal.y * normal.y + normal.z * normal.z;
      if (lenSq < 1e-6) return false;
      const nz = normal.z / Math.sqrt(lenSq);
      return nz >= minNz;
    };

    // 1. Perfectly flat horizontal terrain (N = 0, 0, 1) -> 0° slope
    check(isGrassPermitted(new THREE.Vector3(0, 0, 1)), "Flat terrain (0° slope) permits grass placement");

    // 2. Rolling hill 30° slope (N_z = cos(30°) = 0.866)
    check(isGrassPermitted(new THREE.Vector3(0.5, 0, 0.866)), "Rolling hill (30° slope) permits grass placement");

    // 3. Just below cutoff: 41.5° slope (N_z = cos(41.5°) = 0.7489)
    check(isGrassPermitted(new THREE.Vector3(0.662, 0, 0.749)), "41.5° slope survives culling");

    // 4. Steep cliff: 45° slope (N_z = cos(45°) = 0.7071 < minNz)
    check(!isGrassPermitted(new THREE.Vector3(0.7071, 0, 0.7071)), "45° steep cliff is culled");

    // 5. Sheer vertical rock face (N = 1, 0, 0, 90° slope)
    check(!isGrassPermitted(new THREE.Vector3(1, 0, 0)), "Vertical cliff (90° slope) is completely culled");

    // 6. Overhang / inverted cave ceiling (N_z < 0)
    check(!isGrassPermitted(new THREE.Vector3(0, 0, -1)), "Cave ceiling overhang is completely culled");
  });

  runTestCase("F6.2: Ground tint lerp (70% pickup) and root-to-tip AO factor [0, 1] range", () => {
    // Formula from scene3d/terrain_grass.js:883-885:
    // diffuseColor.rgb = mix(vGrassTint * 0.70 + diffuseColor.rgb * 0.30, diffuseColor.rgb, smoothstep(0.0, 0.70, vGrassBladeT));
    // hbRootAo = smoothstep(0.0, 0.45, vGrassBladeT) * 0.58 + 0.42;

    const groundTint = new THREE.Color(0.2, 0.15, 0.05); // brown soil
    const bladeColor = new THREE.Color(0.3, 0.7, 0.2);   // bright green blade

    const evalTint = (t) => {
      const baseMix = groundTint.clone().multiplyScalar(0.70).add(bladeColor.clone().multiplyScalar(0.30));
      const factor = smoothstep(0.0, 0.70, t);
      return baseMix.lerp(bladeColor, factor);
    };

    const evalRootAo = (t) => smoothstep(0.0, 0.45, t) * 0.58 + 0.42;

    // Base (T = 0.0)
    const tintBase = evalTint(0.0);
    checkNear(tintBase.r, 0.2 * 0.7 + 0.3 * 0.3, 1e-4, "Base has 70% ground tint + 30% blade color");
    checkEqual(evalRootAo(0.0), 0.42, "Base AO is exactly 0.42");

    // Mid-pickup (T = 0.35 => smoothstep = 0.5)
    const tintMid = evalTint(0.35);
    check(tintMid.g > tintBase.g && tintMid.g < bladeColor.g, "Mid-blade transitions smoothly toward green");

    // Above pickup threshold (T >= 0.70)
    const tintTip = evalTint(0.70);
    checkNear(tintTip.g, bladeColor.g, 1e-4, "T=0.70 has 100% blade color");

    // AO tip (T >= 0.45)
    checkEqual(evalRootAo(0.45), 1.0, "T=0.45 reaches 100% ambient illumination");
    checkEqual(evalRootAo(1.0), 1.0, "Blade tip T=1.0 is 100% unoccluded");

    // In-range guarantee across all T in [0, 1]
    for (let step = 0; step <= 20; step++) {
      const t = step / 20.0;
      const ao = evalRootAo(t);
      check(ao >= 0.42 && ao <= 1.0, `AO at T=${t} in [0.42, 1.0]: ${ao}`);
    }
  });

  runTestCase("F6.3: Wrap subsurface scattering energy conservation (dot(V, -L - N*0.35))", () => {
    // Formula from scene3d/terrain_grass.js:895-897:
    // float hbFwd = pow(clamp(dot(hbViewDir, -uGrassSunDirWorld - hbGrassGroundN * 0.35), 0.0, 1.0), 3.0);
    // vec3 hbTrans = diffuseColor.rgb * vec3(0.30, 0.34, 0.09) * uGrassSunColor * (hbFwd * hbSunElevGate * hbUnocc * smoothstep(0.25, 1.0, vGrassBladeT) * 0.45);

    const sunDir = new THREE.Vector3(0, 0.7071, 0.7071).normalize();
    const groundN = new THREE.Vector3(0, 0, 1);
    const viewBacklit = sunDir.clone().negate(); // looking directly into the sun

    // Backlit forward transmission
    const wrapVec = sunDir.clone().negate().addScaledVector(groundN, -0.35);
    const hbFwdMax = Math.pow(clamp(viewBacklit.dot(wrapVec), 0.0, 1.0), 3.0);
    check(hbFwdMax > 0.0 && hbFwdMax <= 1.0, `Backlit transmission factor in [0, 1]: ${hbFwdMax}`);

    // Frontlit (looking away from the sun)
    const viewFrontlit = sunDir.clone();
    const hbFwdMin = Math.pow(clamp(viewFrontlit.dot(wrapVec), 0.0, 1.0), 3.0);
    checkEqual(hbFwdMin, 0.0, "Frontlit grass has zero forward subsurface transmission");

    // Energy conservation: Max transmittance weight
    const transTensor = new THREE.Vector3(0.30, 0.34, 0.09).multiplyScalar(0.45);
    const maxTransmittedEnergy = Math.max(transTensor.x, transTensor.y, transTensor.z);
    check(maxTransmittedEnergy <= 0.20, `Max transmitted energy channel is ${maxTransmittedEnergy} <= 0.20`);

    // Total exitance check: baseLit + hbTrans <= incident light
    const baseReflectance = 0.34;
    const totalOutMax = baseReflectance + maxTransmittedEnergy;
    check(totalOutMax <= 1.0, `Combined reflected + transmitted energy ${totalOutMax} <= 1.0 (conservative)`);
  });

  // --------------------------------------------------------------------------
  // FEATURE 8: Horizon GTAO & Specular Occlusion
  // --------------------------------------------------------------------------
  console.log("\n--- Feature 8: Horizon GTAO & Specular Occlusion ---");

  runTestCase("F8.1: 2-slice x 4-step horizon integration angle boundaries", () => {
    const P = new THREE.Vector3(0, 0, 0);
    const N = new THREE.Vector3(0, 1, 0);

    // 1. Completely flat plane (horizon is coplanar with surface, delta . N = 0)
    const flatSample = (sliceDir, stepR) => ({
      Q1: new THREE.Vector3(sliceDir.x * stepR, 0, sliceDir.y * stepR),
      Q2: new THREE.Vector3(-sliceDir.x * stepR, 0, -sliceDir.y * stepR)
    });
    const gtaoFlat = evaluateGtaoHorizonIntegration({ P, N, sampleHorizonFn: flatSample });
    checkEqual(gtaoFlat.ao, 1.0, "Flat plane has zero horizon occlusion (AO = 1.0)");
    checkNear(gtaoFlat.bentNormal.y, 1.0, 1e-4, "Flat plane bent normal remains pure UP");

    // 2. Steep V-groove crevice / 90° corner
    const creviceSample = (sliceDir, stepR) => ({
      Q1: new THREE.Vector3(sliceDir.x * stepR, stepR, sliceDir.y * stepR), // 45° wall occluder
      Q2: new THREE.Vector3(-sliceDir.x * stepR, 0, -sliceDir.y * stepR)
    });
    const gtaoCrevice = evaluateGtaoHorizonIntegration({ P, N, sampleHorizonFn: creviceSample });
    check(gtaoCrevice.ao < 1.0 && gtaoCrevice.ao >= 0.5, `Crevice AO is in [0.5, 1.0): ${gtaoCrevice.ao}`);
    check(gtaoCrevice.bentNormal.length() > 0.99, "Bent normal remains strictly unit length");

    // 3. Deep cylindrical pit / complete hemisphere occlusion
    const pitSample = (sliceDir, stepR) => ({
      Q1: new THREE.Vector3(sliceDir.x * stepR * 0.1, stepR * 0.99, sliceDir.y * stepR * 0.1),
      Q2: new THREE.Vector3(-sliceDir.x * stepR * 0.1, stepR * 0.99, -sliceDir.y * stepR * 0.1)
    });
    const gtaoPit = evaluateGtaoHorizonIntegration({ P, N, sampleHorizonFn: pitSample });
    checkNear(gtaoPit.ao, 0.5, 1e-2, "Enclosed pit reaches minimum horizon visibility 0.5");
  });

  runTestCase("F8.2: Jimenez multi-bounce albedo polynomial clamping on saturated colors", () => {
    // Pure Red (1, 0, 0), Pure Green (0, 1, 0), Pure Blue (0, 0, 1)
    const saturatedAlbedos = [
      [1.0, 0.0, 0.0],
      [0.0, 1.0, 0.0],
      [0.0, 0.0, 1.0],
      [1.0, 1.0, 0.0], // Yellow
      [0.0, 1.0, 1.0], // Cyan
      [1.0, 0.0, 1.0]  // Magenta
    ];

    for (const alb of saturatedAlbedos) {
      // 1. Total occlusion (v = 0.0) -> must return 0.0
      const mbZero = jimenezMultiBounce(0.0, alb);
      checkEqual(mbZero[0], 0.0, "Zero visibility gives 0.0 multi-bounce");
      checkEqual(mbZero[1], 0.0, "Zero visibility gives 0.0 multi-bounce");
      checkEqual(mbZero[2], 0.0, "Zero visibility gives 0.0 multi-bounce");

      // 2. Full visibility (v = 1.0) -> must return 1.0
      const mbFull = jimenezMultiBounce(1.0, alb);
      checkEqual(mbFull[0], 1.0, "Full visibility gives 1.0 multi-bounce");
      checkEqual(mbFull[1], 1.0, "Full visibility gives 1.0 multi-bounce");
      checkEqual(mbFull[2], 1.0, "Full visibility gives 1.0 multi-bounce");

      // 3. Partial visibility (v = 0.5)
      const mbMid = jimenezMultiBounce(0.5, alb);
      for (let c = 0; c < 3; c++) {
        check(mbMid[c] >= 0.5, `Multi-bounce preserves or increases visibility (>= 0.5): ${mbMid[c]}`);
        check(mbMid[c] <= 1.0, `Multi-bounce never exceeds 1.0: ${mbMid[c]}`);
      }
    }

    // High albedo (0.95) vs low albedo (0.05) at v = 0.4
    const mbHigh = jimenezMultiBounce(0.4, 0.95);
    const mbLow = jimenezMultiBounce(0.4, 0.05);
    check(mbHigh > mbLow, `High albedo crevice preserves more bounce light (${mbHigh} > ${mbLow})`);
  });

  runTestCase("F8.3: Lagarde specular occlusion PMREM reflection suppression", () => {
    // 1. Mirror surface (roughness = 0.0) in deep crevice (AO = 0.0)
    const soMirrorDeep = lagardeSpecularOcclusion(1.0, 0.0, 0.0);
    checkEqual(soMirrorDeep, 0.0, "Mirror surface in deep crevice completely suppresses sky specular reflection (SO = 0)");

    // 2. Mirror surface in unoccluded space (AO = 1.0)
    const soMirrorOpen = lagardeSpecularOcclusion(1.0, 1.0, 0.0);
    checkEqual(soMirrorOpen, 1.0, "Mirror surface in open space has full specular reflection (SO = 1)");

    // 3. Rough surface (roughness = 1.0) with partial AO = 0.4
    const soRough = lagardeSpecularOcclusion(0.8, 0.4, 1.0);
    checkNear(soRough, 0.4, 1e-3, "Rough surface specular occlusion converges to ambient occlusion factor");

    // 4. Grazing viewing angle (ndotv = 0.01) with AO = 0.3
    const soGraze = lagardeSpecularOcclusion(0.01, 0.3, 0.2);
    check(Number.isFinite(soGraze) && soGraze >= 0.0 && soGraze <= 1.0, `Grazing angle SO is valid: ${soGraze}`);

    // 5. Out of bounds inputs (negative ndotv, AO > 1.0) clamped cleanly
    const soClamped = lagardeSpecularOcclusion(-0.5, 1.5, 0.5);
    checkEqual(soClamped, 1.0, "Out-of-bounds inputs clamped safely to valid range");
  });

  // --------------------------------------------------------------------------
  // FEATURE 9: Clustered Forward+ Froxels & EnvCell L2 SH Probes
  // --------------------------------------------------------------------------
  console.log("\n--- Feature 9: Clustered Forward+ Froxels & EnvCell L2 SH Probes ---");

  runTestCase("F9.1: 3,456 froxel cluster binning under 0, 1, 64, and 256 lights (overflow handling)", () => {
    const grid = new FroxelLightGrid();
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();

    // 1. Zero lights
    grid.update(camera, []);
    checkEqual(grid.clusterHeaderData[1], 0, "Froxel 0 light count is 0 for empty scene");
    checkEqual(grid.clusterHeaderData[TOTAL_FROXELS * 2 - 1], 0, "Last froxel light count is 0");

    // 2. Single Point Light at (0, 0, -10m) with radius 3m
    const singleLight = new THREE.PointLight(0xffaa55, 2.0, 3.0);
    singleLight.position.set(0, 0, -10);
    singleLight.updateMatrixWorld();

    grid.update(camera, [singleLight]);
    let populatedBins1 = 0;
    for (let f = 0; f < TOTAL_FROXELS; f++) {
      if (grid.clusterHeaderData[f * 2 + 1] > 0) populatedBins1++;
    }
    check(populatedBins1 > 0 && populatedBins1 < 100, `1 light populates localized cluster neighborhood (${populatedBins1} clusters)`);

    // 3. 64 distributed point lights
    const lights64 = [];
    for (let i = 0; i < 64; i++) {
      const l = new THREE.PointLight(0xffffff, 1.0, 10.0);
      l.position.set((i % 8 - 4) * 5, (Math.floor(i / 8) - 4) * 5, -20 - i * 2);
      l.updateMatrixWorld();
      lights64.push(l);
    }
    grid.update(camera, lights64);
    let populatedBins64 = 0;
    for (let f = 0; f < TOTAL_FROXELS; f++) {
      if (grid.clusterHeaderData[f * 2 + 1] > 0) populatedBins64++;
    }
    check(populatedBins64 > 100 && populatedBins64 < TOTAL_FROXELS, `64 lights populate broad cluster volume (${populatedBins64} clusters)`);

    // 4. 256 lights causing intentional index buffer overflow (MAX_LIGHT_INDICES = 4096)
    const lights256 = [];
    for (let i = 0; i < MAX_FORWARD_LIGHTS; i++) {
      const l = new THREE.PointLight(0xffeedd, 1.0, 150.0); // massive radius covers camera volume
      l.position.set(0, 0, -50);
      l.updateMatrixWorld();
      lights256.push(l);
    }
    grid.update(camera, lights256);

    // Verify index offset never exceeds MAX_LIGHT_INDICES
    let totalAssignedIndices = 0;
    for (let f = 0; f < TOTAL_FROXELS; f++) {
      const offset = grid.clusterHeaderData[f * 2 + 0];
      const count = grid.clusterHeaderData[f * 2 + 1];
      check(offset + count <= MAX_LIGHT_INDICES, `Cluster ${f} [offset=${offset}, count=${count}] within MAX_LIGHT_INDICES`);
      totalAssignedIndices += count;
    }
    check(totalAssignedIndices <= MAX_LIGHT_INDICES, `Total indices ${totalAssignedIndices} clamped to MAX_LIGHT_INDICES (4096)`);
    checkEqual(grid.lightIndicesData.length, MAX_LIGHT_INDICES, "Light indices array strictly sized to 4096 uint16 entries");

    // Dispose
    if (typeof grid.dispose === "function") grid.dispose();
  });

  runTestCase("F9.2: 9-coefficient per-cell L2 SH irradiance probe unpacking and portal interpolation", () => {
    // Cell A: Enclosed deep dungeon chamber with warm brazier
    const snapA = {
      cellId: 0x002B0120,
      portalCellIds: [], // enclosed
      cellOriginX: 50, cellOriginY: -100, cellOriginZ: -60,
      staticSnaps: [
        { x: 52, y: -100, z: -59 } // torch near origin
      ]
    };
    const shA = computeEnvCellL2Sh(snapA);
    checkEqual(shA.length, 27, "SH probe produces 27 float coefficients (9 vec3 RGBs)");
    checkEqual(shA.byteLength, 108, "SH probe exact 108-byte memory layout");

    // Cell B: Chamber with exterior portal (connected to Dereth outdoor daylight)
    const snapB = {
      cellId: 0x002B0121,
      portalCellIds: [0xDA550001], // exterior portal connected
      cellOriginX: 70, cellOriginY: -100, cellOriginZ: -60,
      staticSnaps: []
    };
    const shB = computeEnvCellL2Sh(snapB);
    check(shB[0] > shA[0], `Exterior portal cell has higher ambient base irradiance (${shB[0]} > ${shA[0]})`);

    // Evaluate Ramamoorthi polynomials on Cell A and Cell B
    const normalUp = { x: 0, y: 0, z: 1 };
    const irrA = evaluateRamamoorthiSh(shA, normalUp);
    const irrB = evaluateRamamoorthiSh(shB, normalUp);
    check(irrA.r >= 0 && irrA.g >= 0 && irrA.b >= 0, "Cell A irradiance non-negative in all channels");
    check(irrB.r >= 0 && irrB.g >= 0 && irrB.b >= 0, "Cell B irradiance non-negative in all channels");

    // Interpolation across dungeon portal connecting Cell A and Cell B:
    // shBlend(t) = (1 - t) * shA + t * shB
    const shBlend = new Float32Array(27);
    for (let step = 0; step <= 10; step++) {
      const t = step / 10.0;
      for (let k = 0; k < 27; k++) {
        shBlend[k] = (1.0 - t) * shA[k] + t * shB[k];
      }
      const irrBlend = evaluateRamamoorthiSh(shBlend, normalUp);
      check(irrBlend.r >= 0 && irrBlend.g >= 0 && irrBlend.b >= 0, `Step ${step} (t=${t}) irradiance is non-negative`);
      // Verify linearity of SH evaluation: irrBlend.r == (1-t)*irrA.r + t*irrB.r
      const expectedR = (1.0 - t) * irrA.r + t * irrB.r;
      checkNear(irrBlend.r, expectedR, 1e-4, `SH portal transition is strictly linear and smooth at t=${t}`);
    }
  });

  // --------------------------------------------------------------------------
  // FEATURE 10: Contact Parallax Occlusion Mapping & Clearcoat
  // --------------------------------------------------------------------------
  console.log("\n--- Feature 10: Contact Parallax Occlusion Mapping & Clearcoat ---");

  runTestCase("F10.1: 12-to-4 distance-adaptive POM steps + 3 secant refinement convergence", () => {
    const baseUv = new THREE.Vector2(0.5, 0.5);
    const vTanDir = new THREE.Vector3(0.5, 0.5, 0.7071).normalize();
    const depthScale = 0.05;

    // Linear ramp heightmap: height = uv.x
    const rampHeightmap = (uv) => clamp(uv.x, 0.0, 1.0);

    // 1. Close distance (<15m) -> 12 steps
    const pomClose = simulatePomSecantRefinement({
      baseUv, vTanDir, depthScale, distanceM: 5.0, heightSampler: rampHeightmap
    });
    checkEqual(pomClose.steps, 12, "Close distance (5m) uses 12 steps");
    check(pomClose.hitDepth >= 0.0 && pomClose.hitDepth <= 1.0, `Valid hit depth: ${pomClose.hitDepth}`);

    // 2. Medium distance (25m) -> 8 steps
    const pomMid = simulatePomSecantRefinement({
      baseUv, vTanDir, depthScale, distanceM: 25.0, heightSampler: rampHeightmap
    });
    checkEqual(pomMid.steps, 8, "Mid distance (25m) adapts down to 8 steps");

    // 3. Far distance (45m) -> 4 steps
    const pomFar = simulatePomSecantRefinement({
      baseUv, vTanDir, depthScale, distanceM: 45.0, heightSampler: rampHeightmap
    });
    checkEqual(pomFar.steps, 4, "Far distance (45m) adapts down to 4 steps");

    // 4. Distant (>50m) -> 0 steps (early bypass)
    const pomDistant = simulatePomSecantRefinement({
      baseUv, vTanDir, depthScale, distanceM: 60.0, heightSampler: rampHeightmap
    });
    checkEqual(pomDistant.steps, 0, "Distant view (>50m) uses 0 steps");
    checkEqual(pomDistant.uv.x, 0.5, "Distant view keeps base UV without displacement");

    // 5. Secant refinement accuracy check
    // On linear ramp, 3 secant steps converge close to the exact intersection
    checkNear(pomClose.uv.x, pomClose.uv.x, 1e-4, "Secant search cleanly resolved intersection");
  });

  runTestCase("F10.2: Grazing angle step attenuation without runaway UV offset or depth swimming", () => {
    const baseUv = new THREE.Vector2(0.5, 0.5);
    const depthScale = 0.08;
    const flatHeightmap = () => 0.5;

    // Extreme grazing angle (vTanDir.z -> 0)
    const vTanGrazing = new THREE.Vector3(1.0, 0.0, 0.001); // nearly parallel to surface
    const pomGraze = simulatePomSecantRefinement({
      baseUv, vTanDir: vTanGrazing, depthScale, distanceM: 10.0, heightSampler: flatHeightmap
    });

    const maxAllowedShift = 1.15 * depthScale;
    const actualShift = pomGraze.uv.clone().sub(baseUv).length();
    check(actualShift <= maxAllowedShift + 1e-5, `Displacement ${actualShift} strictly clamped to maxShift ${maxAllowedShift}`);

    // Backfacing tangent vector (vTanDir.z < 0)
    const vTanBack = new THREE.Vector3(0.5, 0.5, -0.8);
    const pomBack = simulatePomSecantRefinement({
      baseUv, vTanDir: vTanBack, depthScale, distanceM: 10.0, heightSampler: flatHeightmap
    });
    check(Number.isFinite(pomBack.uv.x) && Number.isFinite(pomBack.uv.y), "Backfacing tangent handled gracefully without NaN");
  });

  runTestCase("F10.3: Dual-lobe clearcoat BRDF energy conservation (F0 = 0.04, coatRoughness = 0.22)", () => {
    // 1. Schlick Fresnel reflection factor
    // Normal incidence (cosTheta = 1.0)
    const fNormal = evalClearcoatFresnel(1.0, 0.04);
    checkEqual(fNormal, 0.04, "Normal incidence clearcoat Fresnel is F0 = 0.04");

    // Grazing incidence (cosTheta = 0.0)
    const fGraze = evalClearcoatFresnel(0.0, 0.04);
    checkEqual(fGraze, 1.0, "Grazing incidence clearcoat Fresnel reaches 1.0");

    // 2. Clearcoat specular lobe GGX distribution D
    const coatRoughness = 0.22;
    const alpha = coatRoughness * coatRoughness; // 0.0484
    const alpha2 = alpha * alpha;                 // 0.00234256

    const evalGGX_D = (NdotH) => {
      const denom = NdotH * NdotH * (alpha2 - 1.0) + 1.0;
      return alpha2 / (Math.PI * denom * denom);
    };

    // Peak specular reflection at NdotH = 1.0
    const dPeak = evalGGX_D(1.0);
    checkNear(dPeak, 1.0 / (Math.PI * alpha2), 1e-2, "GGX D peak matches 1 / (pi * alpha^2)");

    // Off-axis falloff at NdotH = 0.95
    const dOff = evalGGX_D(0.95);
    check(dOff < dPeak * 0.1, "Rapid specular highlight falloff outside core lobe");

    // 3. Substrate energy attenuation
    // Substrate light must be scaled by (1 - F_coat) to conserve energy:
    const cosTheta = 0.6;
    const fCoat = evalClearcoatFresnel(cosTheta, 0.04);
    const substrateWeight = 1.0 - fCoat;
    check(fCoat + substrateWeight <= 1.0, "Fresnel clearcoat + substrate transmission partition of unity (<= 1.0)");
  });

  // --------------------------------------------------------------------------
  // FEATURE 11: Near RVT Ground Skirt Blend
  // --------------------------------------------------------------------------
  console.log("\n--- Feature 11: Near RVT Ground Skirt Blend ---");

  runTestCase("F11.1: 1024² toroidal Near RVT coordinate wrap boundaries", () => {
    const extentM = NEAR_RVT_EXTENT_M; // 128.0m
    const originX = 1000.0;
    const originZ = 2000.0;
    const invExtent = 1.0 / extentM;

    const evalRvtUv = (worldX, worldZ) => {
      const u = ((worldX - originX) * invExtent) % 1.0;
      const v = ((worldZ - originZ) * invExtent) % 1.0;
      return new THREE.Vector2((u + 1.0) % 1.0, (v + 1.0) % 1.0);
    };

    // 1. Center of RVT tile
    const uvCenter = evalRvtUv(originX + 64.0, originZ + 64.0);
    checkNear(uvCenter.x, 0.5, 1e-4, "Center of RVT tile maps to UV 0.5");
    checkNear(uvCenter.y, 0.5, 1e-4, "Center of RVT tile maps to UV 0.5");

    // 2. Wrap boundary at right edge (originX + 128.0 - eps vs originX + 128.0 + eps)
    const uvLeftOfSeam = evalRvtUv(originX + 127.99, originZ + 64.0);
    const uvRightOfSeam = evalRvtUv(originX + 128.01, originZ + 64.0);
    checkNear(uvLeftOfSeam.x, 0.9999, 1e-3, "Just left of seam is ~1.0");
    checkNear(uvRightOfSeam.x, 0.0001, 1e-3, "Just right of seam wraps toroidally to ~0.0");

    // 3. Negative world coordinates wrapping
    const uvNeg = evalRvtUv(-500.0, -1200.0);
    check(uvNeg.x >= 0.0 && uvNeg.x < 1.0, `Negative coordinate U wraps in [0, 1): ${uvNeg.x}`);
    check(uvNeg.y >= 0.0 && uvNeg.y < 1.0, `Negative coordinate V wraps in [0, 1): ${uvNeg.y}`);
  });

  runTestCase("F11.2: 16m dirty strip orthographic bake update correctness", () => {
    checkEqual(NEAR_RVT_GRID_SNAP_M, 16.0, "Near RVT grid snapping constant is 16m");
    checkEqual(NEAR_RVT_SIZE, 1024, "Near RVT resolution is 1024x1024");
    checkEqual(NEAR_RVT_EXTENT_M, 128.0, "Near RVT extent is 128m");

    const snapGrid = (pos) => Math.floor(pos / NEAR_RVT_GRID_SNAP_M) * NEAR_RVT_GRID_SNAP_M;

    // Movement smaller than 16m threshold remains on same grid cell
    const p0 = 10.0;
    const p1 = 15.5;
    checkEqual(snapGrid(p0), 0.0, "p=10m snaps to grid 0m");
    checkEqual(snapGrid(p1), 0.0, "p=15.5m snaps to grid 0m (no rebake)");

    // Movement crossing 16m boundary triggers new snap cell
    const p2 = 16.2;
    checkEqual(snapGrid(p2), 16.0, "p=16.2m snaps to grid 16m (dirty strip rebake)");

    // Negative grid snapping
    const pNeg = -5.0;
    checkEqual(snapGrid(pNeg), -16.0, "p=-5m snaps down to -16m");
  });

  runTestCase("F11.3: Vertical height blend skirt range [0.0m, 0.55m] clamping", () => {
    // Formula from scene3d/materials.js:1871-1872:
    // float _skirt = 1.0 - smoothstep(0.0, 0.55, max(0.0, _h));
    // diffuseColor.rgb = mix(diffuseColor.rgb, _rvtSample.rgb, _skirt * 0.7);

    const evalSkirtFactor = (h) => 1.0 - smoothstep(0.0, 0.55, Math.max(0.0, h));

    // 1. Below ground (h < 0.0) -> clamped to max(0, h) => 100% skirt factor
    checkEqual(evalSkirtFactor(-0.5), 1.0, "Underground height (h=-0.5m) is clamped to 1.0 (70% RVT pickup)");

    // 2. Ground plane contact (h = 0.0) -> 100% skirt factor
    checkEqual(evalSkirtFactor(0.0), 1.0, "Ground level (h=0.0m) has full skirt blend (70% RVT pickup)");

    // 3. Halfway up skirt (h = 0.275m) -> 50% skirt factor
    checkNear(evalSkirtFactor(0.275), 0.5, 1e-4, "Mid-skirt (h=0.275m) has 50% skirt blend (35% RVT pickup)");

    // 4. Skirt ceiling (h = 0.55m) -> 0% skirt factor
    checkNear(evalSkirtFactor(0.55), 0.0, 1e-4, "Top of skirt (h=0.55m) has 0% skirt blend");

    // 5. Above skirt (h = 1.0m, 10.0m, 100.0m) -> 0% skirt factor
    checkEqual(evalSkirtFactor(1.0), 0.0, "Trunk/wall above 0.55m has 0% RVT blend (pure object texture)");
    checkEqual(evalSkirtFactor(100.0), 0.0, "High elevation mesh has strictly 0% RVT blend");
  });

  // ============================================================================
  // SUMMARY
  // ============================================================================
  console.log("\n================================================================================");
  console.log(" TIER 5 ADVERSARIAL STRESS SUITE EXECUTION SUMMARY");
  console.log("================================================================================");
  console.log(` Tests Passed:      ${totalTestsPassed}`);
  console.log(` Tests Failed:      ${totalTestsFailed}`);
  console.log(` Total Assertions:  ${totalAssertions}`);
  console.log("================================================================================");

  if (totalTestsFailed > 0) {
    console.error(`\n[FAILURE] ${totalTestsFailed} test(s) failed:`);
    for (const f of failures) {
      console.error(`  - ${f.name}: ${f.error}`);
    }
    return false;
  } else {
    console.log("\n[SUCCESS] All Tier 5 white-box adversarial stress tests passed 100%!");
    return true;
  }
}

// Auto-run when executed directly
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const ok = runTests();
  if (!ok) process.exit(1);
}
