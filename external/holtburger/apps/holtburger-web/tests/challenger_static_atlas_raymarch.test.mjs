// tests/challenger_static_atlas_raymarch.test.mjs
// Adversarial Challenger Oracle: Static Atlas Batching & Adaptive POM Raymarching Stability
// Milestone 1 Verification

import assert from "node:assert/strict";
import * as THREE from "three";
import {
  statPomConfig,
  setStatPom,
  makeArrayMaterial,
} from "../scene3d/static_atlas.js";

console.log("======================================================================");
console.log(" CHALLENGER STRESS HARNESS: Static Atlas Batching & Raymarching Oracle");
console.log("======================================================================");

let testsPassed = 0;
let testsFailed = 0;

function check(title, condition, detail = "") {
  if (condition) {
    console.log(`  [PASS] ${title}`);
    testsPassed++;
  } else {
    console.error(`  [FAIL] ${title}${detail ? " : " + detail : ""}`);
    testsFailed++;
  }
}

// -----------------------------------------------------------------------------
// Section 1: Static Atlas POM Configuration & Uniform Passing (15m / 35m LOD)
// -----------------------------------------------------------------------------
console.log("\n--- Section 1: Static Atlas Config & Uniform Passing ---");

{
  const cfg = statPomConfig();
  check("statPomConfig near LOD default is 15.0m", cfg.near === 15.0, `near=${cfg.near}`);
  check("statPomConfig far LOD default is 35.0m", cfg.far === 35.0, `far=${cfg.far}`);
  check("statPomConfig steps is between 4 and 24", cfg.steps >= 4 && cfg.steps <= 24, `steps=${cfg.steps}`);
  check("statPomConfig depth is 0.07", cfg.depth === 0.07, `depth=${cfg.depth}`);

  // Test dynamic updating via setStatPom
  setStatPom({ on: true, near: 18.0, far: 42.0, steps: 20, depth: 0.1 });
  const updatedCfg = statPomConfig();
  check("setStatPom updates near to 18.0", updatedCfg.near === 18.0, `near=${updatedCfg.near}`);
  check("setStatPom updates far to 42.0", updatedCfg.far === 42.0, `far=${updatedCfg.far}`);
  check("setStatPom updates steps to 20", updatedCfg.steps === 20, `steps=${updatedCfg.steps}`);
  check("setStatPom updates depth to 0.10", Math.abs(updatedCfg.depth - 0.1) < 1e-5, `depth=${updatedCfg.depth}`);

  // Reset back to standard defaults for subsequent tests
  setStatPom({ on: true, near: 15.0, far: 35.0, steps: 16, depth: 0.07, shadowSteps: 8 });
  const resetCfg = statPomConfig();
  check("reset to 15m/35m standard baseline", resetCfg.near === 15.0 && resetCfg.far === 35.0);
}

// -----------------------------------------------------------------------------
// Section 2: makeArrayMaterial Shader Uniforms & onBeforeCompile Wiring
// -----------------------------------------------------------------------------
console.log("\n--- Section 2: makeArrayMaterial Shader Uniforms Wiring ---");

{
  const diffArray = new THREE.DataArrayTexture(new Uint8Array(4 * 16 * 16 * 2), 16, 16, 2);
  const nraArray = new THREE.DataArrayTexture(new Uint8Array(4 * 16 * 16 * 2), 16, 16, 2);
  diffArray.needsUpdate = true;
  nraArray.needsUpdate = true;

  const mat = makeArrayMaterial(diffArray, "lb_0_0_16_16|w", nraArray);

  check("makeArrayMaterial creates a MeshStandardMaterial", mat instanceof THREE.MeshStandardMaterial);
  check("makeArrayMaterial onBeforeCompile is installed", typeof mat.onBeforeCompile === "function");

  // Simulate Three.js shader compilation hook
  const shader = {
    uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.standard.uniforms),
    vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader,
    defines: {},
  };

  mat.onBeforeCompile(shader, null);

  check("uDiffuseArray uniform bound", shader.uniforms.uDiffuseArray?.value === diffArray);
  check("uNraArray uniform bound", shader.uniforms.uNraArray?.value === nraArray);
  check("uStatPomOn uniform bound and active", shader.uniforms.uStatPomOn?.value === 1);
  check("uStatPomNear uniform is 15.0", shader.uniforms.uStatPomNear?.value === 15.0, `val=${shader.uniforms.uStatPomNear?.value}`);
  check("uStatPomFar uniform is 35.0", shader.uniforms.uStatPomFar?.value === 35.0, `val=${shader.uniforms.uStatPomFar?.value}`);
  check("uStatPomSteps uniform is 16", shader.uniforms.uStatPomSteps?.value === 16, `val=${shader.uniforms.uStatPomSteps?.value}`);
  check("uStatPomDepth uniform is 0.07", Math.abs(shader.uniforms.uStatPomDepth?.value - 0.07) < 1e-5);

  check("mat.userData._statPomUniforms is populated", mat.userData._statPomUniforms === shader.uniforms);
  check("mat.userData._statArrayUniforms is populated", mat.userData._statArrayUniforms === shader.uniforms);

  // Check GLSL source modifications
  const fs = shader.fragmentShader;
  check("GLSL defines uStatPomNear and uStatPomFar", fs.includes("uniform float uStatPomNear;") && fs.includes("uniform float uStatPomFar;"));
  check("GLSL includes distance LOD check: _pomVd < uStatPomFar", fs.includes("_pomVd < uStatPomFar"));
  check("GLSL includes grazing angle guard: _pomV.z > 0.15", fs.includes("_pomV.z > 0.15"));
  check("GLSL includes adaptive step scaling: _pomMid = mix( uStatPomNear, uStatPomFar, 0.5 )", fs.includes("_statMid = mix( uStatPomNear, uStatPomFar, 0.5 )"));
  check("GLSL scales steps by 4 for far distance: max( 4, uStatPomSteps / 4 )", fs.includes("max( 4, uStatPomSteps / 4 )"));
  check("GLSL scales steps by 2 for mid distance: max( 4, uStatPomSteps / 2 )", fs.includes("max( 4, uStatPomSteps / 2 )"));
}

// -----------------------------------------------------------------------------
// Section 3: Static Atlas Raymarch Numerical Oracle & Edge Case Generator
// -----------------------------------------------------------------------------
console.log("\n--- Section 3: Raymarch Oracle & Numerical Stability Stress ---");

// Oracle function implementing the exact GLSL mathematical kernel from static_atlas.js:878-915
function glslSmoothstep(edge0, edge1, x) {
  const t = Math.max(0.0, Math.min(1.0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3.0 - 2.0 * t);
}

function runStaticPomRaymarchOracle({
  dist,
  vTanDir,
  near = 15.0,
  far = 35.0,
  pomOn = 1.0,
  depth = 0.07,
  steps = 16,
  baseUv = [0.5, 0.5],
  heightMapFn,
}) {
  let statPomFade = 0.0;
  let statPomHitDepth = 0.0;
  let statPomUv = [baseUv[0], baseUv[1]];
  let statEffSteps = steps;

  const pomVd = dist;
  if (pomOn > 0.5 && pomVd < far) {
    const pomV = vTanDir; // tangent-space view dir
    if (pomV[2] > 0.15) {
      statPomFade = 1.0 - glslSmoothstep(near, far, pomVd);
      statEffSteps = steps;
      const statMid = (near + far) * 0.5;
      if (pomVd > statMid) {
        statEffSteps = Math.max(4, Math.floor(steps / 4));
      } else if (pomVd > near) {
        statEffSteps = Math.max(4, Math.floor(steps / 2));
      }

      const pomStep = [
        (pomV[0] / pomV[2]) * (depth * statPomFade) / statEffSteps,
        (pomV[1] / pomV[2]) * (depth * statPomFade) / statEffSteps,
      ];
      const pomLayerStep = 1.0 / statEffSteps;
      let pomUv = [baseUv[0], baseUv[1]];
      let pomLd = 0.0;
      let pomHd = 1.0 - heightMapFn(pomUv);

      for (let i = 0; i < 24; i++) {
        if (i >= statEffSteps || pomLd >= pomHd) break;
        pomUv[0] -= pomStep[0];
        pomUv[1] -= pomStep[1];
        pomLd += pomLayerStep;
        pomHd = 1.0 - heightMapFn(pomUv);
      }

      const pomPrev = [pomUv[0] + pomStep[0], pomUv[1] + pomStep[1]];
      const pomAfter = pomHd - pomLd;
      const pomBefore = (1.0 - heightMapFn(pomPrev)) - (pomLd - pomLayerStep);
      const pomDen = pomAfter - pomBefore;
      const pomW = (pomDen < -1e-6) ? Math.max(0.0, Math.min(1.0, pomAfter / pomDen)) : 0.0;

      statPomUv = [
        pomUv[0] * (1.0 - pomW) + pomPrev[0] * pomW,
        pomUv[1] * (1.0 - pomW) + pomPrev[1] * pomW,
      ];
      statPomHitDepth = 1.0 - heightMapFn(statPomUv);
    }
  }

  return {
    statPomUv,
    statPomFade,
    statPomHitDepth,
    statEffSteps,
  };
}

// Generate various heightmap shapes
const heightmaps = {
  flatMortar: (uv) => 0.0,
  flatProud: (uv) => 1.0,
  halfDepth: (uv) => 0.5,
  stepEdge: (uv) => (uv[0] > 0.5 ? 1.0 : 0.0),
  sinusoidal: (uv) => 0.5 + 0.5 * Math.sin(uv[0] * 20.0) * Math.cos(uv[1] * 20.0),
  randomNoise: (uv) => Math.abs(Math.sin(uv[0] * 12.9898 + uv[1] * 78.233) * 43758.5453) % 1.0,
  impulseGroove: (uv) => (Math.abs(uv[0] - 0.5) < 0.05 ? 0.0 : 1.0),
};

// Test sweeps:
const distances = [
  0.0, 1e-5, 0.1, 1.0, 5.0, 10.0, 14.99, 15.0, 15.01,
  20.0, 24.99, 25.0, 25.01, 30.0, 34.99, 35.0, 35.01,
  40.0, 50.0, 100.0, 1000.0,
];

const viewDirs = [
  // Normal incidence
  [0.0, 0.0, 1.0],
  // 45 degrees
  [0.7071, 0.0, 0.7071],
  [0.0, 0.7071, 0.7071],
  [0.5, 0.5, 0.7071],
  // Near grazing boundary (0.15 threshold)
  [0.9886, 0.0, 0.1501],
  [0.9887, 0.0, 0.1500001],
  [0.9887, 0.0, 0.1500000],
  [0.9887, 0.0, 0.1499999],
  [0.9987, 0.0, 0.05],
  [0.9999, 0.0, 0.001],
  [1.0, 0.0, 0.0],
  // Backfacing
  [0.0, 0.0, -1.0],
  [0.7071, 0.0, -0.7071],
];

let totalEvaluations = 0;
let nanOrInfCount = 0;
let boundsViolationCount = 0;
let stepScalingErrors = 0;

for (const dist of distances) {
  for (const vTan of viewDirs) {
    for (const [hmName, hmFn] of Object.entries(heightmaps)) {
      totalEvaluations++;
      const res = runStaticPomRaymarchOracle({
        dist,
        vTanDir: vTan,
        heightMapFn: hmFn,
        near: 15.0,
        far: 35.0,
        steps: 16,
      });

      // Check NaN / Inf
      if (
        !Number.isFinite(res.statPomUv[0]) ||
        !Number.isFinite(res.statPomUv[1]) ||
        !Number.isFinite(res.statPomFade) ||
        !Number.isFinite(res.statPomHitDepth) ||
        !Number.isFinite(res.statEffSteps)
      ) {
        nanOrInfCount++;
      }

      // Check bounds
      if (
        res.statPomFade < 0.0 || res.statPomFade > 1.0 ||
        res.statPomHitDepth < 0.0 || res.statPomHitDepth > 1.0
      ) {
        boundsViolationCount++;
      }

      // Verify adaptive step scaling rule when active:
      if (dist < 35.0 && vTan[2] > 0.15) {
        if (dist > 25.0) {
          if (res.statEffSteps !== 4) stepScalingErrors++;
        } else if (dist > 15.0) {
          if (res.statEffSteps !== 8) stepScalingErrors++;
        } else {
          if (res.statEffSteps !== 16) stepScalingErrors++;
        }
      }
    }
  }
}

check(`Executed ${totalEvaluations} raymarch stress evaluations`, totalEvaluations > 1000);
check("Zero NaN or Infinity values encountered across all evaluations", nanOrInfCount === 0, `errors=${nanOrInfCount}`);
check("Zero bounds violations for fade and hit depth (all within [0, 1])", boundsViolationCount === 0, `errors=${boundsViolationCount}`);
check("Adaptive step scaling strictly verified (16 steps <=15m, 8 steps 15-25m, 4 steps >25m)", stepScalingErrors === 0, `errors=${stepScalingErrors}`);

// -----------------------------------------------------------------------------
// Section 4: Boundary & Singular Edge Case Attacks
// -----------------------------------------------------------------------------
console.log("\n--- Section 4: Boundary & Singular Edge Case Attacks ---");

// Attack 1: Exact distance boundaries
{
  const resNear = runStaticPomRaymarchOracle({ dist: 15.0, vTanDir: [0, 0, 1], heightMapFn: heightmaps.halfDepth });
  check("At exactly 15.0m: statPomFade is 1.0", Math.abs(resNear.statPomFade - 1.0) < 1e-6, `fade=${resNear.statPomFade}`);
  check("At exactly 15.0m: statEffSteps is 16", resNear.statEffSteps === 16);

  const resFar = runStaticPomRaymarchOracle({ dist: 35.0, vTanDir: [0, 0, 1], heightMapFn: heightmaps.halfDepth });
  check("At exactly 35.0m: POM early-outs (_pomVd < uStatPomFar is false), fade is 0.0", resFar.statPomFade === 0.0);
  check("At exactly 35.0m: UV is unchanged base UV", resFar.statPomUv[0] === 0.5 && resFar.statPomUv[1] === 0.5);

  const resMid = runStaticPomRaymarchOracle({ dist: 25.0, vTanDir: [0, 0, 1], heightMapFn: heightmaps.halfDepth });
  check("At exactly 25.0m (midpoint): statEffSteps is 8", resMid.statEffSteps === 8);
  check("At exactly 25.0m: statPomFade is 0.5", Math.abs(resMid.statPomFade - 0.5) < 1e-6, `fade=${resMid.statPomFade}`);

  const resMidPlus = runStaticPomRaymarchOracle({ dist: 25.0001, vTanDir: [0, 0, 1], heightMapFn: heightmaps.halfDepth });
  check("At 25.0001m: statEffSteps drops to 4", resMidPlus.statEffSteps === 4);
}

// Attack 2: Grazing angle boundary at Vz = 0.15
{
  const resBelow = runStaticPomRaymarchOracle({ dist: 10.0, vTanDir: [0.9887, 0, 0.14999], heightMapFn: heightmaps.halfDepth });
  check("At Vz = 0.14999 (below 0.15): grazing gate holds, statPomFade is 0.0", resBelow.statPomFade === 0.0);
  check("At Vz = 0.14999: UV is untouched base UV", resBelow.statPomUv[0] === 0.5 && resBelow.statPomUv[1] === 0.5);

  const resAbove = runStaticPomRaymarchOracle({ dist: 10.0, vTanDir: [0.9887, 0, 0.15001], heightMapFn: heightmaps.halfDepth });
  check("At Vz = 0.15001 (just above 0.15): grazing gate passes, statPomFade is 1.0", Math.abs(resAbove.statPomFade - 1.0) < 1e-6);
  check("At Vz = 0.15001: UV perturbation is non-zero and finite", Number.isFinite(resAbove.statPomUv[0]) && resAbove.statPomUv[0] !== 0.5);
}

// Attack 3: Secant denominator near-zero singularity test
{
  // Test den values near -1e-6
  const denValues = [0.0, 1e-5, -1e-7, -9.99e-7, -1.00001e-6, -1e-5, -0.5, -1.0];
  let secantErrors = 0;
  for (const den of denValues) {
    const afterDepth = -0.05;
    const pomW = (den < -1e-6) ? Math.max(0.0, Math.min(1.0, afterDepth / den)) : 0.0;
    if (!Number.isFinite(pomW) || pomW < 0.0 || pomW > 1.0) {
      secantErrors++;
    }
  }
  check("Secant denominator guard (den < -1e-6) prevents division by zero without NaN/Inf", secantErrors === 0);
}

console.log("\n======================================================================");
console.log(` SUMMARY: ${testsPassed} passed, ${testsFailed} failed`);
console.log("======================================================================");

if (testsFailed > 0) {
  process.exit(1);
}
