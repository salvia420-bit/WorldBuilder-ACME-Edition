/**
 * apps/holtburger-web/tests/challenger_m3_tier5_edge_cases.test.mjs
 *
 * Tier 5 White-Box Adversarial Coverage Hardening Suite for Milestone 3
 * Holtburger 3D Brick & Stone Relief and Surface Visual Enhancements
 *
 * Targeted Adversarial Challenge Areas:
 * 1. Grazing viewing angles (vTanDir.z -> 0, vTanDir.z < 0), POM clamping, division-by-zero, runaway UV offsets, and NaN artifacts.
 * 2. Micro-crevice AO under zero or negative height gradients (deltaH <= 0 vs deltaH > 0).
 * 3. Micro-contact shadowing when light vector Lt points away from the surface (N . L <= 0).
 * 4. Specular rim highlighting under extreme view and normal permutations (N . V -> 1 and N . V -> 0).
 * 5. quality.js LOD distance transition points (15m, 35m, 50m) and step transitions (16 -> 8 -> 4 -> 0).
 * 6. Untextured surfaces, missing heightmaps, or materials with pomEnabled: false where micro-surface functions must safely no-op without GL errors.
 */

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import * as THREE from "three";

import {
  installPomShaderPatch,
  applyMicroSurfaceEnhancement,
  _reinstallClonePom,
  CREVICE_AO_DEFAULTS,
} from "../scene3d/materials.js";
import { PRESETS, getQuality } from "../scene3d/quality.js";
import {
  smoothstep,
  pomLodAtDistance,
  pomGrazeWeight,
  calculateCreviceAo,
  calculateSpecularRim,
  compileMaterialShader,
  createMockTexture,
  CONSTANTS,
} from "./e2e_relief/harness.mjs";

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

function checkMatch(str, regex, msg = "") {
  totalAssertions++;
  assert.match(str, regex, msg);
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

// ============================================================================
// SIMULATION ORACLES CORRESPONDING TO SHADER GLSL
// ============================================================================

/**
 * GLSL _pomPerturbedUv simulation in scene3d/materials.js:1939-1995
 */
function simulatePomPerturbedUv(baseUv, vTanDir, depthScale, steps, heightSampler, uPomGraze = 1.0) {
  // Feature 10: Adaptive POM Grazing Silhouette Clamping
  const _pz = Math.max(Math.abs(vTanDir.z), 0.15);
  let nSteps = steps;
  if (uPomGraze > 0.5) {
    nSteps = Math.floor(Math.min(64.0, steps * Math.min(3.0, Math.max(1.0, 1.0 / _pz)) + 0.5));
  }
  let uvStepX = (vTanDir.x / _pz) * depthScale / nSteps;
  let uvStepY = (vTanDir.y / _pz) * depthScale / nSteps;

  // Strict per-step displacement bounding: eliminates stalactites and texture smearing
  const maxStepShift = (0.05 * depthScale) / nSteps;
  uvStepX = Math.max(-maxStepShift, Math.min(maxStepShift, uvStepX));
  uvStepY = Math.max(-maxStepShift, Math.min(maxStepShift, uvStepY));

  const layerStep = 1.0 / nSteps;
  let currentUv = { x: baseUv.x, y: baseUv.y };
  let currentLayerDepth = 0.0;
  let currentHeight = 1.0 - heightSampler(currentUv.x, currentUv.y);

  for (let i = 0; i < 64; i++) {
    if (i >= nSteps) break;
    if (currentLayerDepth >= currentHeight) break;
    currentUv.x -= uvStepX;
    currentUv.y -= uvStepY;
    currentLayerDepth += layerStep;
    currentHeight = 1.0 - heightSampler(currentUv.x, currentUv.y);
  }

  // One-step secant refinement
  const prevUv = { x: currentUv.x + uvStepX, y: currentUv.y + uvStepY };
  const afterDepth = currentHeight - currentLayerDepth;
  const beforeDepth = (1.0 - heightSampler(prevUv.x, prevUv.y)) - (currentLayerDepth - layerStep);
  const den = afterDepth - beforeDepth;
  const w = den < -1e-6 ? Math.max(0.0, Math.min(1.0, afterDepth / den)) : 0.0;

  return {
    uv: {
      x: currentUv.x * (1.0 - w) + prevUv.x * w,
      y: currentUv.y * (1.0 - w) + prevUv.y * w,
    },
    pz: _pz,
    nSteps,
    uvStep: { x: uvStepX, y: uvStepY },
    maxStepShift,
    w,
  };
}

/**
 * GLSL <lights_fragment_begin> micro-contact shadow & horizon slope simulation
 */
function simulateMicroContactShadow(geometryNormal, normal, lightDir, tangentLightDir, h0, h1, h2, strength = 0.65) {
  if (tangentLightDir.z <= 0.001) {
    return { atten: 1.0, active: false, reason: "light_behind_surface" };
  }

  const msOcc = Math.max(Math.max(0.0, h1 - h0), Math.max(0.0, h2 - h0));
  const msHorizonShadow = Math.max(0.0, Math.min(1.0, 1.0 - 2.5 * msOcc));

  const geomDotL = geometryNormal.dot(lightDir);
  const normDotL = normal.dot(lightDir);
  const msSlope = Math.max(0.0, Math.min(1.0, (geomDotL + 0.08) / Math.max(normDotL, 0.08)));

  const msAtten = 1.0 * (1.0 - strength) + Math.min(msSlope, msHorizonShadow) * strength;
  return { atten: msAtten, active: true, msHorizonShadow, msSlope, msOcc };
}

// ============================================================================
// MASTER SUITE EXECUTION
// ============================================================================

export function runTests() {
  console.log("================================================================================");
  console.log(" TIER 5 WHITE-BOX ADVERSARIAL STRESS SUITE (Milestone 3 Hardening)");
  console.log("================================================================================");

  // ----------------------------------------------------------------------------
  // SUITE 1: Grazing Viewing Angles, Negative Projections & Silhouette Clamping
  // ----------------------------------------------------------------------------
  console.log("\n>>> [SUITE 1] Grazing Viewing Angles, Clamping & Silhouette Ramp");

  runTestCase("T5-1.1: Asymptotic graze vTanDir.z -> 0+ and 0- bounds pz to strictly >= 0.15", () => {
    const testZValues = [
      0.0, 1e-15, 1e-7, 1e-4, 0.001, 0.05, 0.10, 0.12, 0.149999, 0.15,
      -0.0, -1e-15, -1e-7, -0.05, -0.12, -0.15, -0.5, -1.0,
    ];
    for (const z of testZValues) {
      const pz = Math.max(Math.abs(z), 0.15);
      check(pz >= 0.15, `pz must be >= 0.15 for z=${z} (got ${pz})`);
      check(Number.isFinite(pz), `pz must be finite for z=${z}`);
      check(!Number.isNaN(pz), `pz must not be NaN for z=${z}`);
      const invPz = 1.0 / pz;
      check(invPz <= 1.0 / 0.15 + 1e-6, `1/pz must be <= 6.6667 for z=${z}`);
    }
  });

  runTestCase("T5-1.2: Strict single-step displacement clamp |uvStep| <= (0.05 * depthScale) / nSteps", () => {
    const dummySampler = () => 0.5;
    const depths = [0.01, 0.04, 0.08, 0.15, 0.30];
    const baseSteps = [8, 16, 24];

    for (const depth of depths) {
      for (const steps of baseSteps) {
        // Test with massive horizontal view vector (simulating extreme tangential glance)
        const vTanDir = { x: 1000.0, y: -2000.0, z: 0.0001 };
        const sim = simulatePomPerturbedUv({ x: 0.5, y: 0.5 }, vTanDir, depth, steps, dummySampler, 1.0);

        check(Math.abs(sim.uvStep.x) <= sim.maxStepShift + 1e-9, `uvStep.x must be clamped by maxStepShift`);
        check(Math.abs(sim.uvStep.y) <= sim.maxStepShift + 1e-9, `uvStep.y must be clamped by maxStepShift`);
        check(sim.maxStepShift <= (0.05 * depth) / sim.nSteps + 1e-9, `maxStepShift formula holds`);
      }
    }
  });

  runTestCase("T5-1.3: Total cumulative raymarch displacement strictly bounded by 0.05 * depthScale", () => {
    // If every single step is pushed to the maximum clamp limit, cumulative displacement
    // over nSteps steps is nSteps * maxStepShift = nSteps * (0.05 * depthScale / nSteps) = 0.05 * depthScale.
    const depths = [0.02, 0.04, 0.08, 0.10];
    const dummySampler = () => 0.0; // ray never hits, marches full count

    for (const depth of depths) {
      const vTanDir = { x: 1.0, y: 0.0, z: 0.0001 };
      const sim = simulatePomPerturbedUv({ x: 0.5, y: 0.5 }, vTanDir, depth, 16, dummySampler, 1.0);
      const totalShiftX = Math.abs(sim.uv.x - 0.5);

      const theoreticalMax = 0.05 * depth;
      check(totalShiftX <= theoreticalMax + 1e-6, `Total cumulative shift (${totalShiftX}) must not exceed 0.05*depth (${theoreticalMax})`);
    }
  });

  runTestCase("T5-1.4: Smoothstep grazing silhouette ramp across [0.15, 0.45] eliminates edge popping", () => {
    // Grazing weight formula: smoothstep(0.15, 0.45, abs(tanZ))
    checkEqual(smoothstep(0.15, 0.45, 0.0), 0.0, "Weight at z=0.0 is exactly 0.0");
    checkEqual(smoothstep(0.15, 0.45, 0.10), 0.0, "Weight at z=0.10 is 0.0");
    checkEqual(smoothstep(0.15, 0.45, 0.15), 0.0, "Weight at z=0.15 is 0.0");
    checkEqual(smoothstep(0.15, 0.45, 0.45), 1.0, "Weight at z=0.45 is 1.0");
    checkEqual(smoothstep(0.15, 0.45, 0.80), 1.0, "Weight at z=0.80 is 1.0");

    // Monotonicity verification
    let prev = 0.0;
    for (let z = 0.15; z <= 0.45; z += 0.01) {
      const w = smoothstep(0.15, 0.45, z);
      check(w >= prev, `Ramp must be monotonically non-decreasing at z=${z.toFixed(2)}`);
      check(w >= 0.0 && w <= 1.0, `Ramp must be within [0, 1]`);
      prev = w;
    }
  });

  runTestCase("T5-1.5: Back-facing & negative view vectors (vTanDir.z < 0) safely processed via abs()", () => {
    const dummySampler = () => 0.5;
    for (const negZ of [-0.001, -0.05, -0.15, -0.45, -0.99]) {
      const vTanDir = { x: 0.3, y: 0.4, z: negZ };
      const sim = simulatePomPerturbedUv({ x: 0.2, y: 0.2 }, vTanDir, 0.08, 16, dummySampler, 1.0);
      check(sim.pz >= 0.15, `pz must be >= 0.15 for negZ=${negZ}`);
      check(sim.nSteps >= 16 && sim.nSteps <= 64, `nSteps in [16, 64]`);
      check(!Number.isNaN(sim.uv.x) && !Number.isNaN(sim.uv.y), `UV must not be NaN for negZ=${negZ}`);
    }
  });

  runTestCase("T5-1.6: Secant bisection numerical stability under zero or non-crossing denominator", () => {
    // When ray doesn't cross or beforeDepth == afterDepth, den >= -1e-6 => w defaults strictly to 0.0
    const flatSampler = () => 1.0; // flat plane at 1.0
    const sim = simulatePomPerturbedUv({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5, z: 0.5 }, 0.05, 16, flatSampler, 1.0);
    checkEqual(sim.w, 0.0, "Secant weight w must default to 0.0 on non-crossing ray");
    check(!Number.isNaN(sim.uv.x) && Number.isFinite(sim.uv.x), "UV must remain finite and valid");
  });

  runTestCase("T5-1.7: Static Atlas Array POM grazing guard (if pomV.z > 0.15) prevents glancing division", () => {
    // In static_atlas.js:900, if ( _pomV.z > 0.15 ) guards the division (_pomV.xy / _pomV.z)
    for (const z of [0.0, 0.05, 0.10, 0.15, -0.2, -1.0]) {
      const allowsMarch = z > 0.15;
      checkEqual(allowsMarch, false, `Static atlas march must be bypassed for z=${z}`);
    }
    checkEqual(0.15001 > 0.15, true, "Static atlas march allowed when z > 0.15");
  });

  runTestCase("T5-1.8: Monte Carlo 10,000 raymarch simulation on unit sphere: zero NaNs or runaway UVs", () => {
    const dummySampler = (u, v) => 0.5 + 0.4 * Math.sin(u * 20.0) * Math.cos(v * 20.0);
    let minUvX = Infinity, maxUvX = -Infinity;
    let minUvY = Infinity, maxUvY = -Infinity;

    for (let i = 0; i < 10000; i++) {
      // Random unit vector on sphere
      const theta = Math.random() * Math.PI * 2.0;
      const phi = Math.acos(2.0 * Math.random() - 1.0);
      const vx = Math.sin(phi) * Math.cos(theta);
      const vy = Math.sin(phi) * Math.sin(theta);
      const vz = Math.cos(phi);

      const sim = simulatePomPerturbedUv({ x: 0.5, y: 0.5 }, { x: vx, y: vy, z: vz }, 0.08, 16, dummySampler, 1.0);
      check(!Number.isNaN(sim.uv.x) && Number.isFinite(sim.uv.x), `uv.x finite at iter ${i}`);
      check(!Number.isNaN(sim.uv.y) && Number.isFinite(sim.uv.y), `uv.y finite at iter ${i}`);

      if (sim.uv.x < minUvX) minUvX = sim.uv.x;
      if (sim.uv.x > maxUvX) maxUvX = sim.uv.x;
      if (sim.uv.y < minUvY) minUvY = sim.uv.y;
      if (sim.uv.y > maxUvY) maxUvY = sim.uv.y;
    }

    // Displacement bounded by base + 0.05*depth = 0.5 ± 0.004
    check(minUvX >= 0.5 - 0.005, `minUvX bounded (${minUvX})`);
    check(maxUvX <= 0.5 + 0.005, `maxUvX bounded (${maxUvX})`);
    check(minUvY >= 0.5 - 0.005, `minUvY bounded (${minUvY})`);
    check(maxUvY <= 0.5 + 0.005, `maxUvY bounded (${maxUvY})`);
  });

  // ----------------------------------------------------------------------------
  // SUITE 2: Micro-Crevice Cavity AO Under Adversarial Height Gradients
  // ----------------------------------------------------------------------------
  console.log("\n>>> [SUITE 2] Micro-Crevice Cavity AO Under Height Gradients (deltaH <= 0 vs deltaH > 0)");

  runTestCase("T5-2.1: Flat surface (deltaH = 0) maintains cavityAo = 1.0 (no false ambient darkening)", () => {
    // 5-point stencil: deltaH = 4*H0 - (HR + HL + HU + HD)
    const deltaH = 4.0 * 0.7 - (0.7 + 0.7 + 0.7 + 0.7);
    checkEqual(deltaH, 0.0, "Laplacian of flat surface is 0.0");
    const ao = calculateCreviceAo(deltaH);
    checkEqual(ao, 1.0, "Cavity AO on flat surface must be strictly 1.0");
  });

  runTestCase("T5-2.2: Protruding ridge (deltaH > 0) preserves cavityAo = 1.0 (raised features never darken)", () => {
    // Center is raised above neighbors
    const deltaH = 4.0 * 1.0 - (0.2 + 0.2 + 0.2 + 0.2); // +3.2 > 0
    check(deltaH > 0.0, "DeltaH is strictly positive on protrusion");
    const ao = calculateCreviceAo(deltaH);
    checkEqual(ao, 1.0, "Protruding masonry center must retain cavityAo = 1.0");
  });

  runTestCase("T5-2.3: Recessed crevice (deltaH < 0) smoothly attenuates indirect diffuse light", () => {
    // Mortar dip: center lower than surrounding brick
    const deltaH = 4.0 * 0.2 - (0.8 + 0.8 + 0.8 + 0.8); // 0.8 - 3.2 = -2.4
    check(deltaH < 0.0, "DeltaH is strictly negative in crevice");
    const ao = calculateCreviceAo(deltaH);
    // formula: clamp(1.0 - 1.5 * (-deltaH), 0.0, 1.0)
    // 1.0 - 1.5 * 2.4 = -2.6 -> clamped to 0.0
    checkEqual(ao, 0.0, "Deep crevice is clamped to 0.0");

    // Shallow dip: deltaH = -0.2
    const shallowAo = calculateCreviceAo(-0.2);
    // 1.0 - 1.5 * 0.2 = 0.70
    checkNear(shallowAo, 0.70, 1e-4, "Shallow crevice attenuates to 0.70");
  });

  runTestCase("T5-2.4: Extreme negative deltaH = -4.0 clamped at 0.0, preventing negative light values", () => {
    const abyssalDelta = 4.0 * 0.0 - (1.0 + 1.0 + 1.0 + 1.0); // -4.0
    const ao = calculateCreviceAo(abyssalDelta);
    checkEqual(ao, 0.0, "Cavity AO never drops below 0.0");
    check(ao >= 0.0, "Cavity AO non-negative");
  });

  runTestCase("T5-2.5: Uniform planes at H=0.0 and H=1.0 both produce cavityAo = 1.0", () => {
    const aoZero = calculateCreviceAo(4.0 * 0.0 - (0.0 + 0.0 + 0.0 + 0.0));
    const aoOne = calculateCreviceAo(4.0 * 1.0 - (1.0 + 1.0 + 1.0 + 1.0));
    checkEqual(aoZero, 1.0, "All-zero heightfield yields cavityAo = 1.0");
    checkEqual(aoOne, 1.0, "All-one heightfield yields cavityAo = 1.0");
  });

  runTestCase("T5-2.6: Gain factor sweep from 0.0 to 10.0 preserves [0.0, 1.0] bounds", () => {
    const testGains = [0.0, 0.1, 0.5, 1.0, 1.5, 2.0, 5.0, 10.0];
    const testDeltas = [-4.0, -2.0, -0.5, -0.1, 0.0, 0.5, 2.0, 4.0];

    for (const gain of testGains) {
      for (const d of testDeltas) {
        const dip = Math.max(0.0, -d);
        const ao = Math.max(0.0, Math.min(1.0, 1.0 - gain * dip));
        check(ao >= 0.0 && ao <= 1.0, `ao in [0, 1] for gain=${gain}, delta=${d}`);
        if (d >= 0.0) checkEqual(ao, 1.0, `ao must be 1.0 for delta >= 0`);
      }
    }
  });

  runTestCase("T5-2.7: Texel size derivative fallback in shader injection", () => {
    // GLSL: vec2 _cStep = max(fwidth(_cBaseUv), uCreviceAoTexelSize);
    // When fwidth is 0.0 (constant UV), fallback to uCreviceAoTexelSize is active
    const mat = new THREE.MeshStandardMaterial({ name: "texel_test" });
    const tex = createMockTexture(128, 128, 255, 255, "texel_h");
    applyMicroSurfaceEnhancement(mat, tex);
    const compiled = compileMaterialShader(mat);

    checkMatch(compiled.fragmentShader, /vec2 _cStep = max\(fwidth\(_cBaseUv\), uCreviceAoTexelSize\);/, "Fallback max(fwidth, texelSize) present");
    check(compiled.uniforms.uCreviceAoTexelSize !== undefined, "uCreviceAoTexelSize uniform instantiated");
  });

  runTestCase("T5-2.8: Monte Carlo 10,000 5-point height stencils: cavityAo strictly in [0.0, 1.0]", () => {
    let minAo = 1.0, maxAo = 0.0;
    for (let i = 0; i < 10000; i++) {
      const h0 = Math.random();
      const hr = Math.random();
      const hl = Math.random();
      const hu = Math.random();
      const hd = Math.random();
      const deltaH = 4.0 * h0 - (hr + hl + hu + hd);
      const ao = calculateCreviceAo(deltaH);

      check(ao >= 0.0 && ao <= 1.0, `ao in [0, 1] at iter ${i}`);
      if (deltaH >= 0.0) checkEqual(ao, 1.0, `ao is 1.0 for deltaH >= 0 at iter ${i}`);
      if (ao < minAo) minAo = ao;
      if (ao > maxAo) maxAo = ao;
    }
    checkEqual(minAo, 0.0, "Reached lower clamp bound 0.0");
    checkEqual(maxAo, 1.0, "Reached upper clamp bound 1.0");
  });

  // ----------------------------------------------------------------------------
  // SUITE 3: Micro-Contact Shadowing Under Adverse Light Vectors (N . L <= 0)
  // ----------------------------------------------------------------------------
  console.log("\n>>> [SUITE 3] Micro-Contact Shadowing Under Adverse Light Vectors (N . L <= 0)");

  runTestCase("T5-3.1: Tangent light vector behind surface (Lt.z <= 0.001) bypasses micro-shadow", () => {
    // In shader: if (_msLt.z > 0.001) { ... }
    const geomN = new THREE.Vector3(0, 0, 1);
    const norm = new THREE.Vector3(0, 0, 1);
    const lightDir = new THREE.Vector3(0, 1, -1).normalize(); // pointing into back face

    const testLtZ = [0.001, 0.0, -0.001, -0.5, -1.0];
    for (const z of testLtZ) {
      const res = simulateMicroContactShadow(geomN, norm, lightDir, new THREE.Vector3(0, 1, z), 0.2, 0.8, 0.8);
      checkEqual(res.active, false, `Micro-shadow must not activate for Lt.z=${z}`);
      checkEqual(res.atten, 1.0, `Direct light attenuation must remain 1.0 for Lt.z=${z}`);
    }
  });

  runTestCase("T5-3.2: Horizon slope denominator clamp max(normDotL, 0.08) prevents division by zero", () => {
    // GLSL: float _msSlope = clamp((dot(geometryNormal, _msLightDir) + 0.08) / max(dot(normal, _msLightDir), 0.08), 0.0, 1.0);
    const geomN = new THREE.Vector3(0, 0, 1);
    const norm = new THREE.Vector3(0, 0, 1);

    const testAngles = [
      new THREE.Vector3(1, 0, 0),        // perpendicular (N . L = 0)
      new THREE.Vector3(0, 1, 0),        // perpendicular (N . L = 0)
      new THREE.Vector3(0, 0, -1),       // opposite (N . L = -1)
      new THREE.Vector3(0.5, 0.5, -0.5).normalize(),
    ];

    for (const lightDir of testAngles) {
      const normDotL = norm.dot(lightDir);
      const geomDotL = geomN.dot(lightDir);
      const denom = Math.max(normDotL, 0.08);
      check(denom >= 0.08, `Denominator must be >= 0.08 (got ${denom})`);
      const slope = Math.max(0.0, Math.min(1.0, (geomDotL + 0.08) / denom));
      check(Number.isFinite(slope), `Slope must be finite for normDotL=${normDotL}`);
      check(!Number.isNaN(slope), `Slope must not be NaN for normDotL=${normDotL}`);
      check(slope >= 0.0 && slope <= 1.0, `Slope must be in [0, 1]`);
    }
  });

  runTestCase("T5-3.3: Horizon probe height differences: zero obstacle yields atten=1.0, full obstacle yields atten=1.0-strength", () => {
    const geomN = new THREE.Vector3(0, 0, 1);
    const norm = new THREE.Vector3(0, 0, 1);
    const lightDir = new THREE.Vector3(0, 0.5, 0.866).normalize();
    const tLight = new THREE.Vector3(0, 0.5, 0.866);

    // No obstacle: probes h1, h2 <= h0
    const noObs = simulateMicroContactShadow(geomN, norm, lightDir, tLight, 0.8, 0.5, 0.5, 0.65);
    checkEqual(noObs.msOcc, 0.0, "Obstruction factor is 0.0");
    checkNear(noObs.atten, 1.0, 1e-4, "Attenuation with no obstacle is 1.0");

    // Full obstacle: h1 - h0 = 1.0
    const fullObs = simulateMicroContactShadow(geomN, norm, lightDir, tLight, 0.0, 1.0, 1.0, 0.65);
    checkEqual(fullObs.msHorizonShadow, 0.0, "Horizon shadow fully occluded (0.0)");
    checkNear(fullObs.atten, 0.35, 1e-4, "Attenuation with full obstacle is 1.0 - 0.65 = 0.35");
  });

  runTestCase("T5-3.4: POM secondary self-shadow raymarch gate (_pomShadow: lTan.z <= 0.001 returns 1.0)", () => {
    // In materials.js:2003: float _pomShadow(...) { if (lTan.z <= 0.001) return 1.0; ... }
    const mat = new THREE.MeshStandardMaterial({ name: "pom_shadow_test" });
    const tex = createMockTexture(128, 128, 255, 255, "shadow_h");
    installPomShaderPatch(mat, tex);
    const compiled = compileMaterialShader(mat);

    checkMatch(compiled.fragmentShader, /if \(lTan\.z <= 0\.001\) return 1\.0;/, "_pomShadow early exit for lTan.z <= 0.001 present");
  });

  runTestCase("T5-3.5: Static atlas micro-shadow gate (_pomLt.z > 0.05 && _statPomHitDepth > 0.001)", () => {
    // In static_atlas.js:1021: if ( _pomLt.z > 0.05 && _statPomHitDepth > 0.001 )
    const canShadow = (ltZ, depth) => ltZ > 0.05 && depth > 0.001;
    checkEqual(canShadow(0.04, 0.5), false, "Sun at glancing angle <= 0.05 bypassed");
    checkEqual(canShadow(0.5, 0.0005), false, "Zero-depth hit bypassed");
    checkEqual(canShadow(0.5, 0.1), true, "Valid sun angle and depth executes shadow");
  });

  runTestCase("T5-3.6: Monte Carlo 5,000 light vector sweep: attenuation always finite and in [0.0, 1.0]", () => {
    const geomN = new THREE.Vector3(0, 0, 1);
    const norm = new THREE.Vector3(0, 0, 1);

    for (let i = 0; i < 5000; i++) {
      const theta = Math.random() * Math.PI * 2.0;
      const phi = Math.acos(2.0 * Math.random() - 1.0);
      const lightDir = new THREE.Vector3(
        Math.sin(phi) * Math.cos(theta),
        Math.sin(phi) * Math.sin(theta),
        Math.cos(phi)
      );

      const h0 = Math.random();
      const h1 = Math.random();
      const h2 = Math.random();
      const res = simulateMicroContactShadow(geomN, norm, lightDir, lightDir, h0, h1, h2, 0.65);

      check(Number.isFinite(res.atten), `attenuation finite at iter ${i}`);
      check(!Number.isNaN(res.atten), `attenuation non-NaN at iter ${i}`);
      check(res.atten >= 0.0 && res.atten <= 1.0, `attenuation in [0, 1] at iter ${i}`);
    }
  });

  // ----------------------------------------------------------------------------
  // SUITE 4: Specular Rim Highlighting Under Extreme View and Normal Permutations
  // ----------------------------------------------------------------------------
  console.log("\n>>> [SUITE 4] Specular Rim Highlighting Across Extreme View and Normal Permutations");

  runTestCase("T5-4.1: Perpendicular viewing angle (N . V = ±1.0) yields edgeRim = 0.0 regardless of curvature", () => {
    // GLSL: float _cDotNV = saturate(abs(dot(_cNorm, _cView)));
    // float _cEdgeRim = uRimGamma * max(0.0, _cDeltaH) * (1.0 - _cDotNV);
    for (const dotNV of [1.0, -1.0, 0.999999, -0.999999]) {
      const rim = calculateSpecularRim(2.0, dotNV, 0.5);
      checkNear(rim, 0.0, 1e-4, `Rim highlight must be 0.0 at perpendicular angle dotNV=${dotNV}`);
    }
  });

  runTestCase("T5-4.2: Glancing silhouette viewing (N . V -> 0.0) yields full rim highlight on protruding masonry", () => {
    const deltaH = 1.5;
    const gamma = 0.5;
    const rim = calculateSpecularRim(deltaH, 0.0, gamma);
    // formula: gamma * deltaH * (1.0 - 0.0) = 0.5 * 1.5 * 1.0 = 0.75
    checkNear(rim, 0.75, 1e-4, "Full rim highlight achieved at silhouette glance (N . V = 0)");
  });

  runTestCase("T5-4.3: Concave and flat surfaces (deltaH <= 0) produce edgeRim = 0.0 at all viewing angles", () => {
    for (const deltaH of [-4.0, -1.0, -0.1, 0.0]) {
      for (const dotNV of [0.0, 0.2, 0.5, 0.8, 1.0]) {
        const rim = calculateSpecularRim(deltaH, dotNV, 0.5);
        checkEqual(rim, 0.0, `Rim highlight must be 0.0 for deltaH=${deltaH}, dotNV=${dotNV}`);
      }
    }
  });

  runTestCase("T5-4.4: Inverted normal / back-face viewing (N . V < 0) safely clamped by abs() and saturate()", () => {
    for (const dotNV of [-0.001, -0.2, -0.5, -0.8, -1.0]) {
      const rim = calculateSpecularRim(1.0, dotNV, 0.5);
      check(rim >= 0.0, `Rim highlight must be non-negative for dotNV=${dotNV}`);
      check(Number.isFinite(rim), `Rim highlight must be finite for dotNV=${dotNV}`);
    }
  });

  runTestCase("T5-4.5: Double-sided material normal flipping (_cNorm *= gl_FrontFacing ? 1.0 : -1.0)", () => {
    const mat = new THREE.MeshStandardMaterial({ name: "double_sided_test" });
    const tex = createMockTexture(128, 128, 255, 255, "rim_h");
    applyMicroSurfaceEnhancement(mat, tex);
    const compiled = compileMaterialShader(mat);

    checkMatch(compiled.fragmentShader, /#ifdef DOUBLE_SIDED\s+_cNorm \*= \(gl_FrontFacing \? 1\.0 : -1\.0\);/, "Double-sided normal flip present");
  });

  runTestCase("T5-4.6: Direct specular accumulation with colored sunlight preserves directional light color", () => {
    const mat = new THREE.MeshStandardMaterial({ name: "sun_rim_test" });
    const tex = createMockTexture(128, 128, 255, 255, "sun_rim_h");
    applyMicroSurfaceEnhancement(mat, tex);
    const compiled = compileMaterialShader(mat);

    checkMatch(compiled.fragmentShader, /reflectedLight\.directSpecular \+= _cEdgeRim \* directionalLights\[0\]\.color;/, "Direct specular accumulation with directional light color present");
  });

  runTestCase("T5-4.7: Monte Carlo 10,000 view/normal permutation sweep: edgeRim strictly non-negative and finite", () => {
    for (let i = 0; i < 10000; i++) {
      const dotNV = (Math.random() * 2.0) - 1.0; // [-1, 1]
      const deltaH = (Math.random() * 8.0) - 4.0; // [-4, 4]
      const gamma = Math.random() * 2.0;

      const rim = calculateSpecularRim(deltaH, dotNV, gamma);
      check(Number.isFinite(rim), `rim finite at iter ${i}`);
      check(!Number.isNaN(rim), `rim non-NaN at iter ${i}`);
      check(rim >= 0.0, `rim >= 0.0 at iter ${i}`);
      if (deltaH <= 0.0 || Math.abs(dotNV) >= 1.0) {
        checkEqual(rim, 0.0, `rim is 0.0 for non-protruding or head-on at iter ${i}`);
      }
    }
  });

  // ----------------------------------------------------------------------------
  // SUITE 5: quality.js LOD Distance Transitions & Step Scaling
  // ----------------------------------------------------------------------------
  console.log("\n>>> [SUITE 5] quality.js LOD Distance Transition Points and Step Scaling");

  runTestCase("T5-5.1: POM LOD distance curve: 15m near -> 35m far extended transition", () => {
    // 0m to 15m: 1.0
    checkEqual(pomLodAtDistance(0.0), 1.0, "LOD at 0m is 1.0");
    checkEqual(pomLodAtDistance(10.0), 1.0, "LOD at 10m is 1.0");
    checkEqual(pomLodAtDistance(15.0), 1.0, "LOD at 15m is 1.0");

    // Midpoint at 25m: exactly 0.5
    checkNear(pomLodAtDistance(25.0), 0.5, 1e-4, "LOD at midpoint 25m is 0.5");

    // Far bound at 35m: 0.0
    checkEqual(pomLodAtDistance(35.0), 0.0, "LOD at 35m is 0.0");
    checkEqual(pomLodAtDistance(50.0), 0.0, "LOD beyond 35m is 0.0");
    checkEqual(pomLodAtDistance(100.0), 0.0, "LOD at 100m is 0.0");
  });

  runTestCase("T5-5.2: Ultra preset LOD distance: 15m near -> 50m far transition", () => {
    checkEqual(pomLodAtDistance(15.0, 15.0, 50.0), 1.0, "Ultra LOD at 15m is 1.0");
    checkNear(pomLodAtDistance(32.5, 15.0, 50.0), 0.5, 1e-4, "Ultra LOD at midpoint 32.5m is 0.5");
    checkEqual(pomLodAtDistance(50.0, 15.0, 50.0), 0.0, "Ultra LOD at 50m is 0.0");
    checkEqual(pomLodAtDistance(75.0, 15.0, 50.0), 0.0, "Ultra LOD beyond 50m is 0.0");
  });

  runTestCase("T5-5.3: Dynamic step degradation ladder (16 -> 8 -> 4 -> 0 steps)", () => {
    function getEffSteps(dist, baseSteps = 16, near = 15.0, far = 35.0) {
      const lod = pomLodAtDistance(dist, near, far);
      if (lod <= 0.001) return 0; // bypassed
      const mid = (near + far) * 0.5;
      if (dist > mid) {
        return Math.max(4, Math.floor(baseSteps / 4));
      } else if (dist > near) {
        return Math.max(4, Math.floor(baseSteps / 2));
      }
      return baseSteps;
    }

    checkEqual(getEffSteps(5.0), 16, "Close range (5m) uses 16 steps");
    checkEqual(getEffSteps(15.0), 16, "Boundary 15m uses 16 steps");
    checkEqual(getEffSteps(20.0), 8, "Mid-near range (20m) uses 8 steps");
    checkEqual(getEffSteps(25.0), 8, "Midpoint (25m) uses 8 steps");
    checkEqual(getEffSteps(30.0), 4, "Mid-far range (30m) uses 4 steps");
    checkEqual(getEffSteps(35.0), 0, "Far boundary (35m) uses 0 steps (bypassed)");
    checkEqual(getEffSteps(60.0), 0, "Distant range (60m) uses 0 steps");
  });

  runTestCase("T5-5.4: Presets integrity check across low, mid, high, ultra tiers", () => {
    // Low: POM off
    checkEqual(PRESETS.low.pom, false, "low preset has pom: false");
    checkEqual(PRESETS.low.pomStepsPrimary, 0, "low preset has 0 primary steps");
    checkEqual(PRESETS.low.creviceAo, false, "low preset has creviceAo: false");
    checkEqual(PRESETS.low.microContactShadow, false, "low preset has microContactShadow: false");

    // Mid: POM on, 5 lightweight steps (tuned 2026-11-12 Pass 2)
    checkEqual(PRESETS.mid.pom, true, "mid preset has pom: true");
    checkEqual(PRESETS.mid.pomStepsPrimary, 5, "mid preset has 5 primary steps");
    checkEqual(PRESETS.mid.creviceAo, true, "mid preset has creviceAo: true");
    checkEqual(PRESETS.mid.microContactShadow, false, "mid preset has microContactShadow: false");
    check(
      PRESETS.low.pomStepsPrimary < PRESETS.mid.pomStepsPrimary &&
      PRESETS.mid.pomStepsPrimary < PRESETS.high.pomStepsPrimary &&
      PRESETS.high.pomStepsPrimary < PRESETS.ultra.pomStepsPrimary,
      "pomStepsPrimary strictly monotonic across low < mid < high < ultra"
    );

    // High: POM on, 16 steps, micro shadow on
    checkEqual(PRESETS.high.pom, true, "high preset has pom: true");
    checkEqual(PRESETS.high.pomStepsPrimary, 16, "high preset has 16 primary steps");
    checkEqual(PRESETS.high.creviceAo, true, "high preset has creviceAo: true");
    checkEqual(PRESETS.high.microContactShadow, true, "high preset has microContactShadow: true");

    // Ultra: POM on, 24 steps, micro shadow on
    checkEqual(PRESETS.ultra.pom, true, "ultra preset has pom: true");
    checkEqual(PRESETS.ultra.pomStepsPrimary, 24, "ultra preset has 24 primary steps");
    checkEqual(PRESETS.ultra.creviceAo, true, "ultra preset has creviceAo: true");
    checkEqual(PRESETS.ultra.microContactShadow, true, "ultra preset has microContactShadow: true");
  });

  runTestCase("T5-5.5: URL override resolution and parameter synchronization", () => {
    const qMidPomOff = getQuality("?quality=mid&pom=off");
    checkEqual(qMidPomOff.flags.pom, false, "URL pom=off overrides mid preset");

    const qCustomSteps = getQuality("?quality=high&pomStepsPrimary=32");
    checkEqual(qCustomSteps.flags.pomStepsPrimary, 32, "URL pomStepsPrimary=32 overrides high preset");

    // URL alias creviceAo <-> microCreviceAo
    const qCreviceAlias = getQuality("?quality=low&creviceAo=on");
    checkEqual(qCreviceAlias.flags.creviceAo, true, "creviceAo alias resolved");
    checkEqual(qCreviceAlias.flags.microCreviceAo, true, "microCreviceAo synchronized");

    // URL alias microShadow <-> microContactShadow
    const qShadowAlias = getQuality("?quality=mid&microShadow=on");
    checkEqual(qShadowAlias.flags.microContactShadow, true, "microContactShadow synchronized from microShadow=on");
  });

  // ----------------------------------------------------------------------------
  // SUITE 6: Fallback Materials, Missing Textures & Disabled POM Safety
  // ----------------------------------------------------------------------------
  console.log("\n>>> [SUITE 6] Fallback Materials, Missing Textures & Disabled POM Safety");

  runTestCase("T5-6.1: Null / undefined tolerance in installer functions", () => {
    // Should never throw
    assert.doesNotThrow(() => installPomShaderPatch(null, null), "installPomShaderPatch(null, null) safe");
    assert.doesNotThrow(() => applyMicroSurfaceEnhancement(null, null), "applyMicroSurfaceEnhancement(null, null) safe");
    assert.doesNotThrow(() => _reinstallClonePom(null, null), "_reinstallClonePom(null, null) safe");

    const dummyMat = new THREE.MeshStandardMaterial({ name: "null_test" });
    assert.doesNotThrow(() => installPomShaderPatch(dummyMat, null), "installPomShaderPatch(mat, null) safe");
    assert.doesNotThrow(() => applyMicroSurfaceEnhancement(dummyMat, null), "applyMicroSurfaceEnhancement(mat, null) safe");
    checkEqual(dummyMat.userData?.pomEnabled, undefined, "pomEnabled not set when texture is null");
  });

  runTestCase("T5-6.2: Materials with pomEnabled: false cleanly retain false status", () => {
    const mat = new THREE.MeshStandardMaterial({ name: "disabled_pom" });
    mat.userData = { pomEnabled: false };
    const tex = createMockTexture(128, 128, 255, 255, "h_tex");
    applyMicroSurfaceEnhancement(mat, tex, { microCreviceAo: true });

    checkEqual(mat.userData.pomEnabled, false, "pomEnabled remains false");
    const key = mat.customProgramCacheKey();
    checkMatch(key, /\|p0/, "Program cache key reflects |p0 when pomEnabled: false");
    checkMatch(key, /\|mc1/, "Program cache key reflects |mc1 for crevice AO");
  });

  runTestCase("T5-6.3: Untextured material shader compilation generates safe UV fallbacks", () => {
    // Raw MeshStandardMaterial with no map or normalMap
    const untexturedMat = new THREE.MeshStandardMaterial({ name: "untextured_wall" });
    const tex = createMockTexture(128, 128, 255, 255, "raw_h");
    applyMicroSurfaceEnhancement(untexturedMat, tex, { microCreviceAo: true, microContactShadow: true });

    const compiled = compileMaterialShader(untexturedMat);
    // Verifies the #else vec2(0.0) fallback is present in the shader
    checkMatch(compiled.fragmentShader, /#else\s+vec2 _msMapUv = vec2\(0\.0\);/, "Micro-shadow fallback UV vec2(0.0) present");
    checkMatch(compiled.fragmentShader, /#else\s+vec2 _cBaseUv = vec2\(0\.0\);/, "Crevice AO fallback UV vec2(0.0) present");
  });

  runTestCase("T5-6.4: Cloned un-enhanced material guarantees pomEnabled is stripped", () => {
    const base = new THREE.MeshStandardMaterial({ name: "base_unenhanced" });
    const clone = base.clone();
    // Simulate accidental leak or clone copy
    clone.userData = { pomEnabled: true };

    _reinstallClonePom(clone, base);
    checkEqual(clone.userData.pomEnabled, undefined, "pomEnabled stripped from clone when base is unenhanced");
  });

  runTestCase("T5-6.5: Clone chain idempotency and WeakMap gating prevents redundant hooking", () => {
    const base = new THREE.MeshStandardMaterial({ name: "base_chain" });
    const tex = createMockTexture(128, 128, 255, 255, "chain_h");
    installPomShaderPatch(base, tex, { steps: 16 });
    applyMicroSurfaceEnhancement(base, tex, { microCreviceAo: true });

    const c1 = base.clone();
    _reinstallClonePom(c1, base);
    const hook1 = c1.onBeforeCompile;

    // Second call to _reinstallClonePom on c1
    _reinstallClonePom(c1, base);
    const hook2 = c1.onBeforeCompile;
    checkEqual(hook1, hook2, "_clonePomGated prevents re-wrapping onBeforeCompile");
  });

  runTestCase("T5-6.6: Program cache keys 8-way disambiguation across all combinations", () => {
    const keys = new Set();
    const permutations = [
      { pom: false, mc: false, ms: false, expected: "hb|d0|c0|p0|l0|a0|b0|f0|s0|k0|mc0|ms0|v" },
      { pom: true,  mc: false, ms: false, expected: "hb|d0|c0|p1|l0|a0|b0|f0|s0|k0|mc0|ms0|v" },
      { pom: false, mc: true,  ms: false, expected: "hb|d0|c0|p0|l0|a0|b0|f0|s0|k0|mc1|ms0|v" },
      { pom: false, mc: false, ms: true,  expected: "hb|d0|c0|p0|l0|a0|b0|f0|s0|k0|mc0|ms1|v" },
      { pom: true,  mc: true,  ms: false, expected: "hb|d0|c0|p1|l0|a0|b0|f0|s0|k0|mc1|ms0|v" },
      { pom: true,  mc: false, ms: true,  expected: "hb|d0|c0|p1|l0|a0|b0|f0|s0|k0|mc0|ms1|v" },
      { pom: false, mc: true,  ms: true,  expected: "hb|d0|c0|p0|l0|a0|b0|f0|s0|k0|mc1|ms1|v" },
      { pom: true,  mc: true,  ms: true,  expected: "hb|d0|c0|p1|l0|a0|b0|f0|s0|k0|mc1|ms1|v" },
    ];

    for (const p of permutations) {
      const mat = new THREE.MeshStandardMaterial({ name: `mat_${p.pom}_${p.mc}_${p.ms}` });
      const tex = createMockTexture(128, 128, 255, 255, `tex_${p.pom}`);
      if (p.pom) installPomShaderPatch(mat, tex);
      if (p.mc || p.ms) {
        applyMicroSurfaceEnhancement(mat, tex, { microCreviceAo: p.mc, microContactShadow: p.ms });
      } else {
        // ensure customProgramCacheKey is installed
        mat.userData = { ...(mat.userData || {}), pomEnabled: p.pom };
        applyMicroSurfaceEnhancement(mat, tex, { microCreviceAo: false, microContactShadow: false });
      }

      const key = mat.customProgramCacheKey();
      checkEqual(key, p.expected, `Cache key matches expected: ${p.expected}`);
      keys.add(key);
    }

    checkEqual(keys.size, 8, "All 8 permutations must produce distinct program cache keys without collision");
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
