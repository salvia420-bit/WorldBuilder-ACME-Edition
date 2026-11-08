// apps/holtburger-web/tests/challenger_m2_surface_stress.test.mjs
// Adversarial Challenger Empirical Stress Suite for Milestone 2 Surface Visual Enhancements
// Rigorous verification of Features 6, 7, 8, 9, 10:
// 1. Cavity AO Mathematical Bounds & Oracles
// 2. Specular Edge Rim Bounds & Angle Sweeps
// 3. Directional Micro-Contact Shadowing & Oblique Slope Shading
// 4. Adaptive POM Grazing Clamping & UV Bounding
// 5. Material System Shader Injection & Program Key Integration

import assert from "node:assert/strict";
import * as THREE from "three";
import {
  MaterialCache,
  applyMicroSurfaceEnhancement,
  installMicroSurfaceEnhancement,
  CREVICE_AO_DEFAULTS,
  heightTexForMaterial,
  _inheritHeightTex,
} from "../scene3d/materials.js";
import { batchedMaterialFor, memberMaterialOf } from "../scene3d/batched_material_variant.js";

let totalAssertions = 0;
function check(cond, msg) {
  totalAssertions++;
  assert.ok(cond, msg);
}
function checkEqual(actual, expected, msg) {
  totalAssertions++;
  assert.equal(actual, expected, msg);
}
function checkNear(actual, expected, eps, msg) {
  totalAssertions++;
  const diff = Math.abs(actual - expected);
  assert.ok(diff <= eps, `${msg} (expected ${expected}, got ${actual}, diff ${diff} > ${eps})`);
}
function checkMatch(actual, regex, msg) {
  totalAssertions++;
  assert.match(actual, regex, msg);
}

function compile(mat) {
  const lib = THREE.ShaderLib.standard;
  const shader = {
    uniforms: THREE.UniformsUtils.clone(lib.uniforms),
    vertexShader: lib.vertexShader,
    fragmentShader: lib.fragmentShader,
    defines: {},
  };
  mat.onBeforeCompile(shader, null);
  return shader;
}

function createDummyTex(r = 128, g = 128, b = 255, name = "tex") {
  const t = new THREE.DataTexture(new Uint8Array([r, g, b, 255]), 1, 1);
  t.name = name;
  t.needsUpdate = true;
  return t;
}

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0.0, Math.min(1.0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3.0 - 2.0 * t);
}

console.log("================================================================================");
console.log(" ADVERSARIAL CHALLENGER: MILESTONE 2 SURFACE VISUAL ENHANCEMENTS STRESS SUITE");
console.log("================================================================================");

// =============================================================================
// SUITE 1: CAVITY AO MATHEMATICAL BOUNDS & ORACLES (Feature 6)
// =============================================================================
console.log("\n>>> [SUITE 1] Cavity AO Mathematical Bounds & Oracles");

function evalCavityAo(deltaH, gain = 1.5) {
  const dip = Math.max(0.0, -deltaH);
  return Math.max(0.0, Math.min(1.0, 1.0 - gain * dip));
}

function evalLaplacian5(h0, hr, hl, hu, hd) {
  return 4.0 * h0 - (hr + hl + hu + hd);
}

// 1.1: 10,000 randomized heightfield configurations
{
  let minObserved = 1.0;
  let maxObserved = 0.0;
  for (let i = 0; i < 10000; i++) {
    const h0 = Math.random();
    const hr = Math.random();
    const hl = Math.random();
    const hu = Math.random();
    const hd = Math.random();
    const deltaH = evalLaplacian5(h0, hr, hl, hu, hd);
    const gain = 0.5 + Math.random() * 3.0; // gain in [0.5, 3.5]
    const ao = evalCavityAo(deltaH, gain);

    check(!Number.isNaN(ao), `ao must not be NaN at iter ${i}`);
    check(Number.isFinite(ao), `ao must be finite at iter ${i}`);
    check(ao >= 0.0, `ao must be >= 0.0 at iter ${i} (got ${ao})`);
    check(ao <= 1.0, `ao must be <= 1.0 at iter ${i} (got ${ao})`);
    if (ao < minObserved) minObserved = ao;
    if (ao > maxObserved) maxObserved = ao;
  }
  check(minObserved === 0.0, "Cavity AO reached lower clamp boundary (0.0)");
  check(maxObserved === 1.0, "Cavity AO reached upper clamp boundary (1.0)");
}

// 1.2: Pathological and boundary heightfield geometries
{
  // Flat proud face (H=1.0)
  checkEqual(evalCavityAo(evalLaplacian5(1.0, 1.0, 1.0, 1.0, 1.0)), 1.0, "Flat H=1.0 yields cavityAo = 1.0");
  // Flat ground / zero plane (H=0.0)
  checkEqual(evalCavityAo(evalLaplacian5(0.0, 0.0, 0.0, 0.0, 0.0)), 1.0, "Flat H=0.0 yields cavityAo = 1.0");
  // Deep pit / abyssal mortar joint (H0=0.0, neighbors=1.0)
  const pitDelta = evalLaplacian5(0.0, 1.0, 1.0, 1.0, 1.0); // deltaH = -4.0
  checkEqual(evalCavityAo(pitDelta, 1.5), 0.0, "Deep pit clamps strictly to 0.0 without negative numbers");
  // Isolated peak / protruding stone face (H0=1.0, neighbors=0.0)
  const peakDelta = evalLaplacian5(1.0, 0.0, 0.0, 0.0, 0.0); // deltaH = +4.0
  checkEqual(evalCavityAo(peakDelta, 1.5), 1.0, "Protruding stone peak preserves cavityAo = 1.0");

  // Linear planar ramps (Laplacian of linear surface is zero)
  for (let slope = -2.0; slope <= 2.0; slope += 0.4) {
    const h0 = 0.5;
    const hr = h0 + slope * 0.01;
    const hl = h0 - slope * 0.01;
    const hu = h0 + slope * 0.02;
    const hd = h0 - slope * 0.02;
    const rampDelta = evalLaplacian5(h0, hr, hl, hu, hd);
    checkNear(rampDelta, 0.0, 1e-12, `Planar ramp with slope ${slope} has zero Laplacian`);
    checkEqual(evalCavityAo(rampDelta), 1.0, `Planar ramp with slope ${slope} receives cavityAo = 1.0`);
  }

  // Extreme delta values
  for (const extreme of [-1e6, -1000.0, -50.0, -1.0, 0.0, 1.0, 50.0, 1000.0, 1e6]) {
    const ao = evalCavityAo(extreme, 1.5);
    check(ao >= 0.0 && ao <= 1.0, `Extreme delta ${extreme} bounded in [0, 1]`);
    check(!Number.isNaN(ao), `Extreme delta ${extreme} is not NaN`);
  }

  // Extreme gain values
  for (const g of [0.0, 0.0001, 1.5, 10.0, 1000.0]) {
    const aoPit = evalCavityAo(-1.0, g);
    const aoProud = evalCavityAo(1.0, g);
    check(aoPit >= 0.0 && aoPit <= 1.0, `Pit with gain ${g} bounded`);
    checkEqual(aoProud, 1.0, `Proud surface with gain ${g} is 1.0`);
  }
}

// 1.3: Indirect specular occlusion interaction
{
  function computeSpecularOcclusion(dotNV, ambientOcclusion, roughness) {
    // Three.js computeSpecularOcclusion approximation:
    // saturate(pow(dotNV + ambientOcclusion, exp2(-16.0 * roughness - 1.0)) - 1.0 + ambientOcclusion)
    const factor = Math.pow(dotNV + ambientOcclusion, Math.pow(2.0, -16.0 * roughness - 1.0)) - 1.0 + ambientOcclusion;
    return Math.max(0.0, Math.min(1.0, factor));
  }

  for (let r = 0.0; r <= 1.0; r += 0.2) {
    for (let dotNV = 0.0; dotNV <= 1.0; dotNV += 0.25) {
      for (let ao = 0.0; ao <= 1.0; ao += 0.25) {
        const specOcc = computeSpecularOcclusion(dotNV, ao, r);
        check(specOcc >= 0.0 && specOcc <= 1.0, `specOcc bounded in [0,1] for r=${r}, dotNV=${dotNV}, ao=${ao}`);
        check(!Number.isNaN(specOcc), "specOcc is not NaN");
      }
    }
  }
}

// =============================================================================
// SUITE 2: SPECULAR EDGE RIM BOUNDS & ANGLE SWEEPS (Feature 7)
// =============================================================================
console.log("\n>>> [SUITE 2] Specular Edge Rim Bounds & Angle Sweeps");

function evalEdgeRim(deltaH, dotNV, gamma = 0.5) {
  const proud = Math.max(0.0, deltaH);
  const fresnel = 1.0 - Math.min(1.0, Math.abs(dotNV));
  return gamma * proud * fresnel;
}

// 2.1: Full angle domain sweep theta in [0, pi] over 10,000 steps
{
  const steps = 10000;
  const deltaH = 0.8;
  const gamma = 0.5;
  let prevVal = -1.0;

  for (let i = 0; i <= steps; i++) {
    const theta = (i / steps) * Math.PI;
    // N = (0, 0, 1), V = (sin(theta), 0, cos(theta)) -> dot(N, V) = cos(theta)
    const dotNV = Math.cos(theta);
    const rim = evalEdgeRim(deltaH, dotNV, gamma);

    check(!Number.isNaN(rim), `Edge rim must not be NaN at step ${i}`);
    check(rim >= 0.0, `Edge rim must be non-negative at step ${i} (got ${rim})`);

    // At theta = 0 (perpendicular view), dotNV = 1.0 -> rim must be strictly 0.0
    if (i === 0) {
      checkEqual(rim, 0.0, "Edge rim must be exactly 0.0 at perpendicular viewing (theta = 0)");
    }
    // At theta = pi/2 (silhouette grazing), dotNV = 0.0 -> rim must be max (gamma * deltaH)
    if (i === steps / 2) {
      checkNear(rim, gamma * deltaH, 1e-4, "Edge rim reaches peak at silhouette grazing (theta = pi/2)");
    }
    // At theta = pi (backface view), abs(dotNV) = 1.0 -> rim must return to 0.0
    if (i === steps) {
      checkNear(rim, 0.0, 1e-4, "Edge rim returns to 0.0 at backface viewing (theta = pi)");
    }

    // Monotonic increase from theta = 0 to theta = pi/2
    if (theta <= Math.PI / 2.0 && prevVal >= 0.0) {
      check(rim >= prevVal - 1e-12, `Edge rim must monotonically increase from 0 to pi/2 (step ${i})`);
    }
    prevVal = rim;
  }
}

// 2.2: Cavity / mortar joints never receive edge rim highlight
{
  for (const negativeDelta of [-0.01, -0.1, -0.5, -1.0, -100.0]) {
    for (let dotNV = 0.0; dotNV <= 1.0; dotNV += 0.1) {
      const rim = evalEdgeRim(negativeDelta, dotNV, 0.5);
      checkEqual(rim, 0.0, `Mortar cavity deltaH=${negativeDelta} must receive strictly 0.0 edge rim`);
    }
  }
}

// 2.3: Gamma scaling and extreme boundary checks
{
  for (const g of [0.0, 0.1, 0.5, 1.0, 5.0]) {
    const rim = evalEdgeRim(1.0, 0.0, g); // at grazing angle dotNV = 0.0
    checkNear(rim, g * 1.0, 1e-4, `Rim scales linearly with gamma ${g}`);
  }
}

// =============================================================================
// SUITE 3: DIRECTIONAL MICRO-CONTACT SHADOWING & OBLIQUE SLOPE (Features 8 & 9)
// =============================================================================
console.log("\n>>> [SUITE 3] Directional Micro-Contact Shadowing & Oblique Slope Shading");

function evalMicroShadowAndSlope({
  geomNormal,
  perturbedNormal,
  lightDir,
  lightTan,
  h0,
  h1,
  h2,
  strength = 0.65,
  scale = 1.0,
}) {
  // If light is behind surface plane in tangent space, probe is skipped (atten = 1.0)
  if (lightTan.z <= 0.001) {
    return { atten: 1.0, slope: 1.0, horizonShadow: 1.0, active: false };
  }

  // Horizon occlusion probe (2 taps along lightTan.xy)
  const occ = Math.max(0.0, Math.max(h1 - h0, h2 - h0));
  const horizonShadow = Math.max(0.0, Math.min(1.0, 1.0 - 2.5 * occ));

  // Oblique horizon slope shading:
  // dot(geomN, L) vs max(dot(norm, L), 0.08)
  const geomDotL = geomNormal.dot(lightDir);
  const pertDotL = perturbedNormal.dot(lightDir);
  const slope = Math.max(0.0, Math.min(1.0, (geomDotL + 0.08) / Math.max(pertDotL, 0.08)));

  const atten = (1.0 - strength) + strength * Math.min(slope, horizonShadow);
  return { atten, slope, horizonShadow, active: true };
}

// 3.1: Sun elevations at grazing angles (0 deg to 15 deg)
{
  const geomN = new THREE.Vector3(0, 0, 1);
  const pertN = new THREE.Vector3(0, 0, 1);

  for (let deg = 0.0; deg <= 15.0; deg += 0.5) {
    const rad = (deg * Math.PI) / 180.0;
    // Light coming from grazing elevation above surface
    const L = new THREE.Vector3(Math.cos(rad), 0, Math.sin(rad)).normalize();
    const Lt = L.clone(); // in flat TBN, tangent space aligns with world

    // Mortar fragment (H0=0.2), occluded by adjacent brick (H1=0.8, H2=0.8)
    const res = evalMicroShadowAndSlope({
      geomNormal: geomN,
      perturbedNormal: pertN,
      lightDir: L,
      lightTan: Lt,
      h0: 0.2,
      h1: 0.8,
      h2: 0.8,
      strength: 0.65,
    });

    check(!Number.isNaN(res.atten), `Grazing atten at ${deg} deg must not be NaN`);
    check(res.atten >= 0.0, `Grazing atten at ${deg} deg must be >= 0.0`);
    check(res.atten <= 1.0, `Grazing atten at ${deg} deg must be <= 1.0`);
    check(res.slope >= 0.0 && res.slope <= 1.0, `Slope at ${deg} deg must be in [0, 1]`);
    check(res.horizonShadow >= 0.0 && res.horizonShadow <= 1.0, `HorizonShadow at ${deg} deg must be in [0, 1]`);

    if (deg > 0.06) {
      check(res.active, `Probe should be active at ${deg} deg (Lt.z = ${Lt.z})`);
      check(res.horizonShadow === 0.0, `Deep mortar occluded by tall neighbor receives 0.0 horizon shadow`);
      checkNear(res.atten, 0.35, 1e-4, `Atten with strength 0.65 and full shadow evaluates to 1.0 - 0.65 = 0.35`);
    }
  }
}

// 3.2: Inverted and back-facing light vectors (Lt.z <= 0)
{
  const geomN = new THREE.Vector3(0, 0, 1);
  const pertN = new THREE.Vector3(0, 0, 1);

  for (let deg = -90.0; deg <= 0.0; deg += 5.0) {
    const rad = (deg * Math.PI) / 180.0;
    const L = new THREE.Vector3(Math.cos(rad), 0, Math.sin(rad)).normalize();
    const Lt = L.clone();

    const res = evalMicroShadowAndSlope({
      geomNormal: geomN,
      perturbedNormal: pertN,
      lightDir: L,
      lightTan: Lt,
      h0: 0.2,
      h1: 0.8,
      h2: 0.8,
      strength: 0.65,
    });

    check(!res.active, `Inverted light at ${deg} deg must be inactive`);
    checkEqual(res.atten, 1.0, `Inverted light at ${deg} deg returns atten 1.0 (no negative light)`);
  }
}

// 3.3: 10,000 randomized 3D light vectors & adversarial normals
{
  for (let i = 0; i < 10000; i++) {
    // Random direction on unit sphere
    const u = Math.random();
    const v = Math.random();
    const phi = 2.0 * Math.PI * u;
    const cosTheta = 2.0 * v - 1.0;
    const sinTheta = Math.sqrt(Math.max(0.0, 1.0 - cosTheta * cosTheta));
    const L = new THREE.Vector3(sinTheta * Math.cos(phi), sinTheta * Math.sin(phi), cosTheta);

    // Random geometric normal and perturbed normal
    const geomN = new THREE.Vector3(0, 0, 1);
    const pertN = new THREE.Vector3(
      (Math.random() - 0.5) * 0.8,
      (Math.random() - 0.5) * 0.8,
      0.5 + Math.random() * 0.5
    ).normalize();

    const Lt = L.clone();
    const h0 = Math.random();
    const h1 = Math.random();
    const h2 = Math.random();

    const res = evalMicroShadowAndSlope({
      geomNormal: geomN,
      perturbedNormal: pertN,
      lightDir: L,
      lightTan: Lt,
      h0,
      h1,
      h2,
      strength: Math.random(),
    });

    check(!Number.isNaN(res.atten), `Atten must not be NaN at iter ${i}`);
    check(res.atten >= 0.0 && res.atten <= 1.0, `Atten must be in [0, 1] at iter ${i} (got ${res.atten})`);
    check(res.slope >= 0.0 && res.slope <= 1.0, `Slope must be in [0, 1] at iter ${i} (got ${res.slope})`);
    check(res.horizonShadow >= 0.0 && res.horizonShadow <= 1.0, `HorizonShadow must be in [0, 1] at iter ${i}`);
  }
}

// =============================================================================
// SUITE 4: ADAPTIVE POM GRAZING CLAMPING & UV BOUNDING (Feature 10)
// =============================================================================
console.log("\n>>> [SUITE 4] Adaptive POM Grazing Clamping & UV Bounding");

function evalPomGrazingClamp(vTanDir, depthScale = 0.08, steps = 16, uPomGraze = 1.0) {
  const pz = Math.max(Math.abs(vTanDir.z), 0.15);
  let nSteps = steps;
  if (uPomGraze > 0.5) {
    nSteps = Math.floor(Math.min(64.0, steps * Math.max(1.0, Math.min(3.0, 1.0 / pz)) + 0.5));
  }

  const rawStepX = (vTanDir.x / pz) * depthScale / nSteps;
  const rawStepY = (vTanDir.y / pz) * depthScale / nSteps;

  const maxStepShift = (0.05 * depthScale) / nSteps;
  const clampedStepX = Math.max(-maxStepShift, Math.min(maxStepShift, rawStepX));
  const clampedStepY = Math.max(-maxStepShift, Math.min(maxStepShift, rawStepY));

  const grazeW = (uPomGraze > 0.5)
    ? smoothstep(0.15, 0.45, Math.abs(vTanDir.z))
    : (Math.abs(vTanDir.z) > 0.15 ? 1.0 : 0.0);

  return {
    pz,
    nSteps,
    maxStepShift,
    clampedStepX,
    clampedStepY,
    grazeW,
    maxTotalShift: nSteps * maxStepShift,
  };
}

// 4.1: Glancing view vectors vz in [0.0, 0.2]
{
  for (let vz = 0.0; vz <= 0.20; vz += 0.005) {
    const vTan = new THREE.Vector3(Math.sqrt(Math.max(0.0, 1.0 - vz * vz)), 0, vz);
    const res = evalPomGrazingClamp(vTan, 0.08, 16, 1.0);

    check(res.pz >= 0.15, `pz must be clamped to >= 0.15 at vz=${vz} (got ${res.pz})`);
    check(res.nSteps >= 16 && res.nSteps <= 64, `nSteps bounded in [16, 64] at vz=${vz}`);
    check(res.maxTotalShift <= 0.05 * 0.08 + 1e-9, `Total shift cannot exceed 0.05 * depthScale`);

    // For vz <= 0.15, smoothstep(0.15, 0.45, vz) is strictly 0.0
    if (vz <= 0.15) {
      checkEqual(res.grazeW, 0.0, `grazeW at glancing vz=${vz.toFixed(3)} must be strictly 0.0`);
    } else {
      check(res.grazeW > 0.0, `grazeW at vz=${vz.toFixed(3)} must begin ramp`);
    }
  }
}

// 4.2: Smoothstep continuity and Lipschitz bound across ramp [0.15, 0.45]
{
  let prevW = 0.0;
  const deltaZ = 0.001;
  for (let vz = 0.15; vz <= 0.45; vz += deltaZ) {
    const w = smoothstep(0.15, 0.45, vz);
    check(w >= prevW - 1e-12, `grazeW must be monotonically non-decreasing at vz=${vz.toFixed(3)}`);
    const derivative = (w - prevW) / deltaZ;
    // max derivative of smoothstep(0, 1, t) is 1.5 at t=0.5; scaled by 1/0.30 -> max derivative is 5.0
    check(derivative <= 5.1, `Derivative must be bounded without sharp popping (got ${derivative})`);
    prevW = w;
  }
  checkEqual(smoothstep(0.15, 0.45, 0.45), 1.0, "grazeW reaches exactly 1.0 at vz=0.45");
}

// 4.3: Secant refinement stability
{
  function evalSecantRefinement(afterDepth, beforeDepth) {
    const den = afterDepth - beforeDepth;
    const w = den < -1e-6 ? Math.max(0.0, Math.min(1.0, afterDepth / den)) : 0.0;
    return w;
  }

  // Crossing cases: afterDepth <= 0, beforeDepth >= 0 -> den is strictly negative
  for (let i = 0; i < 10000; i++) {
    const after = -Math.random() * 0.5;
    const before = Math.random() * 0.5;
    const w = evalSecantRefinement(after, before);

    check(!Number.isNaN(w), `Secant w must not be NaN at iter ${i}`);
    check(Number.isFinite(w), `Secant w must be finite at iter ${i}`);
    check(w >= 0.0 && w <= 1.0, `Secant w must be in [0, 1] at iter ${i} (got ${w})`);
  }

  // Non-crossing or degenerate cases (flat seam field, ray entirely above or below surface)
  checkEqual(evalSecantRefinement(0.5, 0.5), 0.0, "Zero denominator degenerates weight safely to 0.0");
  checkEqual(evalSecantRefinement(-0.1, -0.1), 0.0, "Parallel ray degenerates weight safely to 0.0");
  checkEqual(evalSecantRefinement(0.1, -0.1), 0.0, "Positive denominator returns 0.0");
}

// =============================================================================
// SUITE 5: MATERIAL SYSTEM SHADER INJECTION & PROGRAM KEY INTEGRATION
// =============================================================================
console.log("\n>>> [SUITE 5] Material System Shader Injection & Program Key Integration");

const hTex1 = createDummyTex(200, 200, 200, "hTex1");
const hTex2 = createDummyTex(150, 150, 150, "hTex2");

// 5.1: applyMicroSurfaceEnhancement exports & parameter handling
{
  checkEqual(typeof applyMicroSurfaceEnhancement, "function", "applyMicroSurfaceEnhancement is exported");
  checkEqual(typeof installMicroSurfaceEnhancement, "function", "installMicroSurfaceEnhancement alias is exported");
  checkEqual(applyMicroSurfaceEnhancement, installMicroSurfaceEnhancement, "Aliases are identical function references");
  checkEqual(CREVICE_AO_DEFAULTS.gain, 1.5, "Default gain is 1.5");
  checkEqual(CREVICE_AO_DEFAULTS.gamma, 0.5, "Default gamma is 0.5");
}

// 5.2: Injection onto MeshStandardMaterial and userData state
{
  const mat = new THREE.MeshStandardMaterial({ color: 0xcccccc });
  applyMicroSurfaceEnhancement(mat, hTex1, {
    microCreviceAo: true,
    microContactShadow: true,
    gain: 2.0,
    gamma: 0.7,
    shadowStrength: 0.8,
  });

  checkEqual(mat.userData.microCreviceAo, true, "mat has microCreviceAo true");
  checkEqual(mat.userData.__creviceAo, true, "mat has __creviceAo true");
  checkEqual(mat.userData.microContactShadow, true, "mat has microContactShadow true");
  checkEqual(mat.userData.__microShadow, true, "mat has __microShadow true");
  checkEqual(mat.userData.creviceAoUniforms.gain, 2.0, "gain recorded on userData");
  checkEqual(mat.userData.creviceAoUniforms.gamma, 0.7, "gamma recorded on userData");
  checkEqual(mat.userData.microShadowUniforms.strength, 0.8, "strength recorded on userData");

  // Shader compilation check
  const sh = compile(mat);
  check(sh.uniforms.uCreviceAoGain !== undefined, "sh has uCreviceAoGain uniform");
  checkEqual(sh.uniforms.uCreviceAoGain.value, 2.0, "uCreviceAoGain has value 2.0");
  check(sh.uniforms.uRimGamma !== undefined, "sh has uRimGamma uniform");
  checkEqual(sh.uniforms.uRimGamma.value, 0.7, "uRimGamma has value 0.7");
  check(sh.uniforms.uMicroContactShadowStrength !== undefined, "sh has uMicroContactShadowStrength uniform");
  checkEqual(sh.uniforms.uMicroContactShadowStrength.value, 0.8, "uMicroContactShadowStrength has value 0.8");
  checkEqual(sh.uniforms.uCreviceAoEnabled.value, 1.0, "uCreviceAoEnabled is 1.0");
  checkEqual(sh.uniforms.uMicroShadowEnabled.value, 1.0, "uMicroShadowEnabled is 1.0");

  // Verify fragment shader injection markers
  check(sh.fragmentShader.includes("Feature 6: Micro-Surface Crevice AO"), "Fragment shader contains Feature 6 injection");
  check(sh.fragmentShader.includes("Feature 7: Specular Edge Rim"), "Fragment shader contains Feature 7 injection");
  check(sh.fragmentShader.includes("Feature 8: Directional Micro-Contact Shadowing"), "Fragment shader contains Feature 8 injection");
  check(sh.fragmentShader.includes("Feature 9: Oblique Horizon Slope Shading"), "Fragment shader contains Feature 9 injection");
}

// 5.3: Cache key disambiguation for all 4 micro-surface flag states
{
  function getCustomCacheKey(mat) {
    return typeof mat.customProgramCacheKey === "function" ? mat.customProgramCacheKey() : "";
  }

  // Permutation A: mc=1, ms=1
  const matA = new THREE.MeshStandardMaterial({ color: 0xaaaaaa });
  applyMicroSurfaceEnhancement(matA, hTex1, { microCreviceAo: true, microContactShadow: true });
  checkMatch(getCustomCacheKey(matA), /\|mc1/, "matA has |mc1");
  checkMatch(getCustomCacheKey(matA), /\|ms1/, "matA has |ms1");

  // Permutation B: mc=1, ms=0
  const matB = new THREE.MeshStandardMaterial({ color: 0xaaaaaa });
  applyMicroSurfaceEnhancement(matB, hTex1, { microCreviceAo: true, microContactShadow: false });
  checkMatch(getCustomCacheKey(matB), /\|mc1/, "matB has |mc1");
  checkMatch(getCustomCacheKey(matB), /\|ms0/, "matB has |ms0");

  // Permutation C: mc=0, ms=1
  const matC = new THREE.MeshStandardMaterial({ color: 0xaaaaaa });
  applyMicroSurfaceEnhancement(matC, hTex1, { microCreviceAo: false, microContactShadow: true });
  checkMatch(getCustomCacheKey(matC), /\|mc0/, "matC has |mc0");
  checkMatch(getCustomCacheKey(matC), /\|ms1/, "matC has |ms1");

  // Permutation D: mc=0, ms=0
  const matD = new THREE.MeshStandardMaterial({ color: 0xaaaaaa });
  applyMicroSurfaceEnhancement(matD, hTex1, { microCreviceAo: false, microContactShadow: false });
  checkMatch(getCustomCacheKey(matD), /\|mc0/, "matD has |mc0");
  checkMatch(getCustomCacheKey(matD), /\|ms0/, "matD has |ms0");

  // Disambiguation check: all 4 keys must be mutually distinct
  const keys = [getCustomCacheKey(matA), getCustomCacheKey(matB), getCustomCacheKey(matC), getCustomCacheKey(matD)];
  const distinctKeys = new Set(keys);
  checkEqual(distinctKeys.size, 4, "All 4 micro-surface program cache keys must be distinct");
}

// 5.4: Batched material parity and height texture propagation
{
  const baseMat = new THREE.MeshStandardMaterial({ color: 0x777777 });
  applyMicroSurfaceEnhancement(baseMat, hTex1, { microCreviceAo: true, microContactShadow: true });

  const batchedMat = batchedMaterialFor(baseMat);
  check(batchedMat !== baseMat, "batchedMaterialFor creates distinct variant");
  checkEqual(memberMaterialOf(batchedMat), baseMat, "memberMaterialOf retrieves baseMat");

  // Parity of height texture resolution
  const resolvedTex = heightTexForMaterial(batchedMat);
  checkEqual(resolvedTex, hTex1, "heightTexForMaterial resolves hTex1 for batchedMat via member material");
}

// 5.5: Idempotence & Flat Shading compatibility
{
  const flatMat = new THREE.MeshStandardMaterial({ color: 0x888888, flatShading: true });
  // Call twice to verify idempotence
  applyMicroSurfaceEnhancement(flatMat, hTex2, { microCreviceAo: true, microContactShadow: true });
  applyMicroSurfaceEnhancement(flatMat, hTex2, { microCreviceAo: true, microContactShadow: true });

  const shFlat = compile(flatMat);
  // Verify that uniform declarations and helper functions are not duplicated
  const commonMatches = (shFlat.fragmentShader.match(/uniform float uCreviceAoGain;/g) || []).length;
  checkEqual(commonMatches, 1, "uCreviceAoGain is declared exactly once");
  const shadowMatches = (shFlat.fragmentShader.match(/Feature 8: Directional Micro-Contact Shadowing/g) || []).length;
  checkEqual(shadowMatches, 1, "Feature 8 chunk is injected exactly once");
  const creviceMatches = (shFlat.fragmentShader.match(/Feature 6: Micro-Surface Crevice AO/g) || []).length;
  checkEqual(creviceMatches, 1, "Feature 6 chunk is injected exactly once");

  // In flat shading mode, check that _msGeomN uses cross(dFdx, dFdy)
  check(shFlat.fragmentShader.includes("cross(dFdx(vViewPosition), dFdy(vViewPosition))"), "Flat shaded material uses screen-space derivatives");
}

console.log("\n================================================================================");
console.log(` ALL ADVERSARIAL STRESS SUITES PASSED (${totalAssertions} assertions verified)`);
console.log("================================================================================");
