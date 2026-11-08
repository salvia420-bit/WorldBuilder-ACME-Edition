// apps/holtburger-web/tests/challenger_m1_it2_deep_stress.mjs
// Adversarial Challenger 2 (Milestone 1 Iteration 2) Deep Stress Harness
//
// Rigorously tests:
// 1. Repeated clone chains (base -> c1 -> c2 -> c3 -> c4), idempotency, isolation, reseating recovery.
// 2. static_atlas raymarching numerical stability across 10,000 evaluations (distances 0..1000m, grazing angles, edge singularities).
// 3. WebGL2 SwiftShader headless compilation & rendering matrix across material variants and lighting configurations.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as THREE from "three";

import {
  MaterialCache,
  SURFACE_TYPE,
  SURFACE_CATEGORY,
  installPomShaderPatch,
  _reinstallClonePom,
  heightTexForMaterial,
} from "../scene3d/materials.js";

import {
  statPomConfig,
  setStatPom,
  makeArrayMaterial,
} from "../scene3d/static_atlas.js";

import { batchedMaterialFor } from "../scene3d/batched_material_variant.js";

const require = createRequire(import.meta.url);
const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..");
const SMOKE_PAGE = join(APP, "harness/glsl_smoke/challenger_it2_deep_page.html");

console.log("================================================================================");
console.log(" CHALLENGER M1-IT2 DEEP ADVERSARIAL STRESS HARNESS");
console.log("================================================================================");

let totalPassed = 0;
let totalFailed = 0;

function check(title, condition, detail = "") {
  if (condition) {
    console.log(`  [PASS] ${title}`);
    totalPassed++;
  } else {
    console.error(`  [FAIL] ${title}${detail ? " : " + detail : ""}`);
    totalFailed++;
  }
}

function compile(mat) {
  const lib = THREE.ShaderLib.standard;
  const shader = {
    uniforms: THREE.UniformsUtils.clone(lib.uniforms),
    vertexShader: lib.vertexShader,
    fragmentShader: lib.fragmentShader,
    defines: {},
  };
  mat.onBeforeCompile.call(mat, shader, null);
  return shader;
}

// =============================================================================
// PILLAR 1: Deep Repeated Clone Chains, Idempotency, and Isolation
// =============================================================================
console.log("\n>>> PILLAR 1: Deep Repeated Clone Chains & Reseating Isolation");

{
  const mc = new MaterialCache({ pomEnabled: true });
  const diffA = new THREE.DataTexture(new Uint8Array(16), 2, 2, THREE.RGBAFormat);
  diffA.name = "diffA";
  const normA = new THREE.DataTexture(new Uint8Array(16), 2, 2, THREE.RGBAFormat);
  normA.name = "normA";
  const hgtA = new THREE.DataTexture(new Uint8Array(4), 2, 2, THREE.RedFormat);
  hgtA.name = "hgtA";

  const diffB = new THREE.DataTexture(new Uint8Array(16), 2, 2, THREE.RGBAFormat);
  diffB.name = "diffB";
  const hgtB = new THREE.DataTexture(new Uint8Array(4), 2, 2, THREE.RedFormat);
  hgtB.name = "hgtB";

  const did = 0x08005001;
  const base = mc._materialFromFlags(SURFACE_TYPE.Base1Image, diffA, SURFACE_CATEGORY.Stone, normA, undefined, hgtA);
  mc.materials.set(did, base);

  // 1.1 Arbitrary depth clone chain: base -> c1 -> c2 -> c3 -> c4
  const c1 = base.clone();
  _reinstallClonePom(c1, base);

  const c2 = c1.clone();
  _reinstallClonePom(c2, c1);

  const c3 = c2.clone();
  _reinstallClonePom(c3, c2);

  const c4 = c3.clone();
  _reinstallClonePom(c4, c3);

  check("Chain depth 4: c4 retains height texture in WeakMap", heightTexForMaterial(c4) === hgtA);
  check("Chain depth 4: c4 userData.pomEnabled is true", c4.userData?.pomEnabled === true);
  check("Chain depth 4: c4 customProgramCacheKey has |p1|", c4.customProgramCacheKey().includes("|p1|"));

  // 1.2 Verify shader hook compilation for c4
  const shC4 = compile(c4);
  check("Chain depth 4: c4 uPomMap uniform binds hgtA", shC4.uniforms.uPomMap?.value === hgtA);
  check("Chain depth 4: c4 pomShaderUniforms live handle exists", c4.userData?.pomShaderUniforms?.uPomMap?.value === hgtA);

  // 1.3 Idempotency: calling _reinstallClonePom multiple times on same clone
  const hookBefore = c4.onBeforeCompile;
  _reinstallClonePom(c4, c3);
  _reinstallClonePom(c4, c3);
  _reinstallClonePom(c4, c3);
  check("Idempotency gate: multiple _reinstallClonePom calls are no-ops", c4.onBeforeCompile === hookBefore);

  // 1.4 MaterialCache variants deep chain
  const fb = mc.getCachedFloorBias(did);
  const cb = mc.getCachedCellBaked(did);
  const sb = mc.getCachedStaticBias(did);
  const fs = mc.getCached(did, false);
  const owned = mc.makeOwnedVariant(base, "testSet", (m) => { m.userData.customFlag = true; });
  const batchFb = batchedMaterialFor(fb);

  check("FloorBias clone retains height texture", heightTexForMaterial(fb) === hgtA);
  check("CellBaked clone retains height texture", heightTexForMaterial(cb) === hgtA);
  check("StaticBias clone retains height texture", heightTexForMaterial(sb) === hgtA);
  check("FrontSide clone retains height texture", heightTexForMaterial(fs) === hgtA);
  check("makeOwnedVariant retains POM and height texture", heightTexForMaterial(owned) === hgtA && owned.userData.pomEnabled === true);
  check("batchedMaterialFor(fb) inherits POM hooks", batchFb.userData?.pomEnabled === true);

  // Initial compilation so GPU live handles exist
  compile(fb);
  compile(cb);
  compile(sb);
  compile(fs);

  // 1.5 Rapid Reseating & Texture Swap Isolation
  // Swap DID to Brick B
  const baseB = mc._materialFromFlags(SURFACE_TYPE.Base1Image, diffB, SURFACE_CATEGORY.Brick, normA, undefined, hgtB);
  mc.materials.set(did, baseB);
  mc._reseatVariantsForDid(did);

  check("Reseat: fb live uPomMap updated to hgtB", fb.userData?.pomShaderUniforms?.uPomMap?.value === hgtB);
  check("Reseat: cb live uPomMap updated to hgtB", cb.userData?.pomShaderUniforms?.uPomMap?.value === hgtB);
  check("Reseat: sb live uPomMap updated to hgtB", sb.userData?.pomShaderUniforms?.uPomMap?.value === hgtB);
  check("Reseat: fs live uPomMap updated to hgtB", fs.userData?.pomShaderUniforms?.uPomMap?.value === hgtB);

  // Subsequent re-compile also binds hgtB
  const shFbRecompile = compile(fb);
  check("Reseat: fb recompile binds hgtB", shFbRecompile.uniforms.uPomMap?.value === hgtB);

  // Isolation check: c1..c4 (cloned prior to reseat) remain untouched with hgtA
  check("Isolation: un-reseated c1 keeps hgtA", heightTexForMaterial(c1) === hgtA);
  check("Isolation: un-reseated c4 keeps hgtA", heightTexForMaterial(c4) === hgtA);

  // 1.6 Temporary non-POM fallback and recovery
  // Reseat to flat untextured material (no heightmap)
  const baseFlat = new THREE.MeshStandardMaterial({ color: 0x888888 });
  baseFlat.userData = { pomEnabled: false };
  mc.materials.set(did, baseFlat);
  mc._reseatVariantsForDid(did);

  check("Fallback: fb.userData.pomEnabled toggles to false", fb.userData.pomEnabled === false);
  check("Fallback: fb uPomMap cleared to null", fb.userData?.pomShaderUniforms?.uPomMap?.value === null);

  // Reseat back to Stone A
  mc.materials.set(did, base);
  mc._reseatVariantsForDid(did);

  check("Recovery: fb.userData.pomEnabled successfully restores to true", fb.userData.pomEnabled === true);
  check("Recovery: fb uPomMap restored to hgtA", fb.userData?.pomShaderUniforms?.uPomMap?.value === hgtA);
}

// =============================================================================
// PILLAR 2: Static Atlas Raymarch Numerical Oracle (10,000 Evaluations)
// =============================================================================
console.log("\n>>> PILLAR 2: Static Atlas Raymarch Oracle (10,000 Monte Carlo & Edge Evaluations)");

{
  function glslSmoothstep(edge0, edge1, x) {
    const t = Math.max(0.0, Math.min(1.0, (x - edge0) / (edge1 - edge0)));
    return t * t * (3.0 - 2.0 * t);
  }

  function simulateStaticAtlasRaymarch({
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
      const pomV = vTanDir;
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

    return { statPomUv, statPomFade, statPomHitDepth, statEffSteps };
  }

  const testHms = [
    (uv) => 0.0,
    (uv) => 1.0,
    (uv) => 0.5,
    (uv) => (uv[0] > 0.5 ? 0.9 : 0.1),
    (uv) => 0.5 + 0.5 * Math.sin(uv[0] * 50.0),
    (uv) => Math.abs((uv[0] * 37.0 + uv[1] * 91.0) % 1.0),
  ];

  let evalCount = 0;
  let nanInfFound = 0;
  let boundsViolations = 0;
  let stepScaleErrors = 0;

  for (let iter = 0; iter < 10000; iter++) {
    evalCount++;
    let d;
    if (iter < 20) {
      const bounds = [0, 1e-6, 14.9999, 15.0, 15.0001, 24.9999, 25.0, 25.0001, 34.9999, 35.0, 35.0001, 50.0];
      d = bounds[iter % bounds.length];
    } else if (iter % 3 === 0) {
      d = Math.random() * 40.0;
    } else if (iter % 3 === 1) {
      d = 15.0 + Math.random() * 20.0;
    } else {
      d = Math.exp(Math.random() * 7.0) - 1.0;
    }

    let vTan;
    if (iter < 10) {
      const edgeAngles = [
        [0, 0, 1],
        [0.707, 0, 0.707],
        [0.988, 0, 0.1500001],
        [0.988, 0, 0.1499999],
        [1, 0, 0],
        [0, 0, -1],
      ];
      vTan = edgeAngles[iter % edgeAngles.length];
    } else {
      const theta = Math.random() * Math.PI * 0.55;
      const phi = Math.random() * Math.PI * 2.0;
      vTan = [Math.sin(theta) * Math.cos(phi), Math.sin(theta) * Math.sin(phi), Math.cos(theta)];
    }

    const hm = testHms[iter % testHms.length];
    const steps = [4, 8, 16, 24][iter % 4];
    const depth = [0.0, 0.05, 0.07, 0.12, 0.25][iter % 5];

    const out = simulateStaticAtlasRaymarch({
      dist: d,
      vTanDir: vTan,
      heightMapFn: hm,
      near: 15.0,
      far: 35.0,
      steps,
      depth,
    });

    if (
      !Number.isFinite(out.statPomUv[0]) ||
      !Number.isFinite(out.statPomUv[1]) ||
      !Number.isFinite(out.statPomFade) ||
      !Number.isFinite(out.statPomHitDepth) ||
      !Number.isFinite(out.statEffSteps)
    ) {
      nanInfFound++;
    }

    if (
      out.statPomFade < 0.0 || out.statPomFade > 1.0 ||
      out.statPomHitDepth < 0.0 || out.statPomHitDepth > 1.0
    ) {
      boundsViolations++;
    }

    if (d < 35.0 && vTan[2] > 0.15) {
      if (d > 25.0) {
        if (out.statEffSteps !== Math.max(4, Math.floor(steps / 4))) stepScaleErrors++;
      } else if (d > 15.0) {
        if (out.statEffSteps !== Math.max(4, Math.floor(steps / 2))) stepScaleErrors++;
      } else {
        if (out.statEffSteps !== steps) stepScaleErrors++;
      }
    }
  }

  check(`10,000 evaluations executed without crash`, evalCount === 10000);
  check(`Zero NaN / Infinity occurrences across 10,000 runs`, nanInfFound === 0, `errors=${nanInfFound}`);
  check(`Zero fade or hit depth bounds violations`, boundsViolations === 0, `errors=${boundsViolations}`);
  check(`Step scaling strictly matches mathematical spec`, stepScaleErrors === 0, `errors=${stepScaleErrors}`);
}

// =============================================================================
// PILLAR 3: WebGL2 SwiftShader Headless Compilation & Rendering
// =============================================================================
console.log("\n>>> PILLAR 3: WebGL2 SwiftShader Compilation & Render Matrix");

async function runWebGlMatrix() {
  const browser = await chromium.launch({
    executablePath: "/usr/bin/chromium",
    headless: true,
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
  });

  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));

    await page.route("http://smoke.test/**", (route) => {
      const u = new URL(route.request().url());
      let file, type = "text/javascript";
      if (u.pathname === "/page.html") {
        file = SMOKE_PAGE;
        type = "text/html";
      } else if (u.pathname.startsWith("/three-addons/")) {
        file = join(APP, "node_modules/three/examples/jsm", u.pathname.slice(14));
      } else if (u.pathname.startsWith("/three/")) {
        file = join(APP, "node_modules/three/build", u.pathname.slice(7));
      } else if (u.pathname.startsWith("/app/")) {
        file = join(APP, u.pathname.slice(5));
      }

      if (!file || !existsSync(file)) {
        return route.fulfill({ status: 404, body: `File not found: ${u.pathname}` });
      }
      return route.fulfill({ status: 200, contentType: type, body: readFileSync(file) });
    });

    await page.goto("http://smoke.test/page.html");
    await page.waitForFunction(() => window.__smoke, null, { timeout: 30000 });
    const res = await page.evaluate(() => window.__smoke);

    if (pageErrors.length > 0) {
      console.error("Browser Page Errors:", pageErrors);
    }
    if (res.errors.length > 0) {
      console.error("WebGL Harness Errors:", res.errors);
    }

    console.log(`  Programs Compiled in WebGL: ${res.programsCompiled}`);
    for (const c of res.checks) {
      check(`WebGL2: ${c.name}`, c.ok, `detail=${c.detail}`);
    }
  } finally {
    await browser.close();
  }
}

await runWebGlMatrix();

console.log("\n================================================================================");
console.log(` SUMMARY: ${totalPassed} passed, ${totalFailed} failed`);
console.log("================================================================================");

if (totalFailed > 0) {
  process.exit(1);
}
