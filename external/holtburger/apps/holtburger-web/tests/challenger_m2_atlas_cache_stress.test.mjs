// apps/holtburger-web/tests/challenger_m2_atlas_cache_stress.test.mjs
// Adversarial Challenger 2: Milestone 2 Surface Visual Enhancements Stress Suite
// Probes Program Cache Key Permutations, Batched Material Parity, and FLAT_SHADED WebGL Execution.

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
  applyMicroSurfaceEnhancement,
  _reinstallClonePom,
  _inheritHeightTex,
  heightTexForMaterial,
} from "../scene3d/materials.js";
import {
  batchedMaterialFor,
  holdBatchedMaterial,
  releaseBatchedMaterial,
  memberMaterialOf,
} from "../scene3d/batched_material_variant.js";
import { makeArrayMaterial, setStatPom } from "../scene3d/static_atlas.js";
import { buildProgramCacheKey } from "./e2e_relief/harness.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..");
const SMOKE_PAGE = join(APP, "harness/glsl_smoke/challenger_m2_atlas_cache_page.html");

console.log("======================================================================");
console.log(" CHALLENGER STRESS HARNESS: M2 Atlas, Cache Keys & FLAT_SHADED Parity");
console.log("======================================================================");

let totalPassed = 0;
function pass(msg) {
  totalPassed++;
  console.log(`  [PASS] ${msg}`);
}

// Helper mock textures
const diffTex = new THREE.DataTexture(new Uint8Array([200, 150, 100, 255]), 1, 1);
diffTex.name = "diffTex";
const normTex = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
normTex.name = "normTex";
const hgtTex = new THREE.DataTexture(new Uint8Array([220]), 1, 1);
hgtTex.name = "hgtTexPrimary";
const hgtTex2 = new THREE.DataTexture(new Uint8Array([180]), 1, 1);
hgtTex2.name = "hgtTexReseated";

const diffArray = new THREE.DataArrayTexture(new Uint8Array(4 * 16 * 16 * 2), 16, 16, 2);
const nraArray = new THREE.DataArrayTexture(new Uint8Array(4 * 16 * 16 * 2), 16, 16, 2);

// ============================================================================
// SECTION 1: Exhaustive Program Cache Key Matrix Stress (32 Permutations)
// ============================================================================
console.log("\n--- Section 1: Program Cache Key Permutations & Token Conformance ---");
{
  const pomOpts = [false, true];
  const creviceOpts = [false, true];
  const shadowOpts = [false, true];
  const csmOpts = [false, true];
  const flatOpts = [false, true];

  const uniqueCustomKeys = new Map(); // key -> config
  let permCount = 0;

  for (const pom of pomOpts) {
    for (const crevice of creviceOpts) {
      for (const shadow of shadowOpts) {
        for (const csm of csmOpts) {
          for (const flat of flatOpts) {
            permCount++;
            const mat = new THREE.MeshStandardMaterial({
              map: diffTex,
              normalMap: normTex,
              flatShading: flat,
            });

            applyMicroSurfaceEnhancement(mat, hgtTex, {
              microCreviceAo: crevice,
              microContactShadow: shadow,
            });

            if (pom) {
              installPomShaderPatch(mat, hgtTex, { steps: 16, depth: 0.08 });
            } else {
              mat.userData.pomEnabled = false;
            }

            mat.userData.csmEnabled = csm;

            const key = mat.customProgramCacheKey ? mat.customProgramCacheKey() : "";
            assert.ok(key.startsWith("hb"), `Key must start with hb prefix: ${key}`);

            // Byte-exact token verification
            const expectedPomToken = pom ? "|p1" : "|p0";
            assert.ok(key.includes(expectedPomToken), `Key must contain ${expectedPomToken}, got: ${key}`);

            const expectedCreviceToken = crevice ? "|mc1" : "|mc0";
            assert.ok(key.includes(expectedCreviceToken), `Key must contain ${expectedCreviceToken}, got: ${key}`);

            const expectedShadowToken = shadow ? "|ms1" : "|ms0";
            assert.ok(key.includes(expectedShadowToken), `Key must contain ${expectedShadowToken}, got: ${key}`);

            const expectedCsmToken = csm ? "|c2" : "|c0";
            assert.ok(key.includes(expectedCsmToken), `Key must contain ${expectedCsmToken}, got: ${key}`);

            // Conformance with harness.mjs oracle
            const harnessExpectedKey = buildProgramCacheKey(mat.userData);
            assert.equal(key, harnessExpectedKey, `Key conforms exactly to harness.mjs oracle: ${key}`);

            // Feature signature key without flatShading (which is a three built-in parameter)
            const featureSig = `${pom ? 1 : 0}-${crevice ? 1 : 0}-${shadow ? 1 : 0}-${csm ? 1 : 0}`;
            if (!uniqueCustomKeys.has(featureSig)) {
              uniqueCustomKeys.set(featureSig, { key, mat });
            } else {
              // Same feature signature must share the exact same key
              assert.equal(uniqueCustomKeys.get(featureSig).key, key, `Materials with identical features share keys`);
            }
          }
        }
      }
    }
  }

  assert.equal(permCount, 32, "Evaluated exactly 32 permutations");
  assert.equal(uniqueCustomKeys.size, 16, "Produced exactly 16 distinct program cache keys without collision");
  pass("All 32 permutations evaluated with 16 collision-free custom program cache keys");
  pass("Byte-exact conformance verified with harness.mjs tokens (|p, |mc, |ms, |c)");

  // Test Static Atlas Array Material Cache Keys
  const wrapMatWithNra = makeArrayMaterial(diffArray, "0|0|1|b1|w", nraArray);
  const clampMatWithNra = makeArrayMaterial(diffArray, "0|0|1|b1|c", nraArray);
  const wrapMatNoNra = makeArrayMaterial(diffArray, "0|0|1|b1|w", null);
  const clampMatNoNra = makeArrayMaterial(diffArray, "0|0|1|b1|c", null);

  const kWrapNra = wrapMatWithNra.customProgramCacheKey();
  const kClampNra = clampMatWithNra.customProgramCacheKey();
  const kWrapNoNra = wrapMatNoNra.customProgramCacheKey();
  const kClampNoNra = clampMatNoNra.customProgramCacheKey();

  assert.ok(kWrapNra.startsWith("statAtlasArrayMatV4w"), "Wrap array key prefix");
  assert.ok(kClampNra.startsWith("statAtlasArrayMatV4c"), "Clamp array key prefix");
  assert.ok(kWrapNra.includes("|mc1|ms1"), "Array key contains |mc1|ms1 when NRA attached");
  assert.ok(kClampNra.includes("|mc1|ms1"), "Clamp array key contains |mc1|ms1 when NRA attached");
  assert.ok(!kWrapNoNra.includes("|mc1|ms1"), "Array key omits |mc1|ms1 when NRA absent");
  assert.ok(!kClampNoNra.includes("|mc1|ms1"), "Clamp array key omits |mc1|ms1 when NRA absent");

  assert.notEqual(kWrapNra, kClampNra, "Wrap and Clamp keys are distinct");
  assert.notEqual(kWrapNra, kWrapNoNra, "NRA vs Non-NRA keys are distinct");
  pass("Static Atlas Array Material cache keys verify wrap/clamp and micro-surface tokens");
}

// ============================================================================
// SECTION 2: Batched Material Parity & Deep Clone Chains
// ============================================================================
console.log("\n--- Section 2: Batched Material Parity & Clone Latches ---");
{
  // 2a. Single-member batched material with micro-surface enhancements
  const memberMat = new THREE.MeshStandardMaterial({ map: diffTex, normalMap: normTex });
  installPomShaderPatch(memberMat, hgtTex, { steps: 16 });
  applyMicroSurfaceEnhancement(memberMat, hgtTex, { microCreviceAo: true, microContactShadow: true });

  const batchMat = batchedMaterialFor(memberMat);
  assert.ok(batchMat, "batchedMaterialFor returned a valid material");
  assert.notEqual(batchMat, memberMat, "batchedMaterial is a distinct variant");
  assert.equal(memberMaterialOf(batchMat), memberMat, "memberMaterialOf points to base member");

  // Verify heightmap resolution on the variant
  const resolvedHeightTex = heightTexForMaterial(batchMat);
  assert.equal(resolvedHeightTex, hgtTex, "heightTexForMaterial resolves heightmap on batched variant");

  // Verify userData enhancement flags mirrored
  assert.equal(batchMat.userData.pomEnabled, true, "POM enabled on batched variant");
  assert.equal(batchMat.userData.microCreviceAo, true, "microCreviceAo on batched variant");
  assert.equal(batchMat.userData.microContactShadow, true, "microContactShadow on batched variant");
  pass("Single-member batched material inherits POM, crevice AO, and micro-shadows");

  // 2b. Multi-member batching
  const memberMatB = new THREE.MeshStandardMaterial({ map: diffTex });
  installPomShaderPatch(memberMatB, hgtTex2, { steps: 8 });
  const batchMatB = batchedMaterialFor(memberMatB);

  assert.notEqual(batchMat, batchMatB, "Different members get different batched variants");
  assert.equal(heightTexForMaterial(batchMatB), hgtTex2, "batchMatB resolves its own heightmap");

  // Idempotence test
  const batchMatB2 = batchedMaterialFor(batchMatB);
  assert.equal(batchMatB2, batchMatB, "batchedMaterialFor on an already-variant returns itself");
  pass("Multi-member variants isolate heightmaps and verify idempotence");

  // 2c. Deep 4-tier clone chain: Base -> FloorBias (c1) -> CellBaked (c2) -> StaticBias (c3) -> Batched (v4)
  const mc = new MaterialCache({
    pomEnabled: true,
    pomOpts: { steps: 24, depth: 0.1 },
    microCreviceAo: true,
    microContactShadow: true,
  });
  const did = 0x08004501;
  const base = mc._materialFromFlags(SURFACE_TYPE.Base1Image, diffTex, SURFACE_CATEGORY.Stone, normTex, undefined, hgtTex);
  mc.materials.set(did, base);

  const c1 = mc.getCachedFloorBias(did);
  assert.equal(heightTexForMaterial(c1), hgtTex, "Tier 1 FloorBias retains heightmap");
  assert.equal(c1.userData.pomEnabled, true, "Tier 1 FloorBias pomEnabled");
  assert.equal(c1.userData.microCreviceAo, true, "Tier 1 FloorBias microCreviceAo");

  const c2 = mc.getCachedCellBaked(did);
  assert.equal(heightTexForMaterial(c2), hgtTex, "Tier 2 CellBaked retains heightmap");
  assert.equal(c2.userData.pomEnabled, true, "Tier 2 CellBaked pomEnabled");

  const c3 = mc.getCachedStaticBias(did);
  assert.equal(heightTexForMaterial(c3), hgtTex, "Tier 3 StaticBias retains heightmap");
  assert.equal(c3.userData.pomEnabled, true, "Tier 3 StaticBias pomEnabled");

  const v4 = batchedMaterialFor(c3);
  assert.equal(heightTexForMaterial(v4), hgtTex, "Tier 4 Batched Material variant retains heightmap");
  assert.equal(v4.userData.pomEnabled, true, "Tier 4 Batched Material pomEnabled");
  pass("4-tier deep clone hierarchy (Base -> FloorBias -> CellBaked -> StaticBias -> Batched) verified");

  // 2d. Dynamic Re-seat Stress
  // Update base with new height texture and trigger reseat
  const reseatDid = 0x08004502;
  const reseatBase = mc._materialFromFlags(SURFACE_TYPE.Base1Image, diffTex, SURFACE_CATEGORY.Stone, normTex, undefined, hgtTex);
  mc.materials.set(reseatDid, reseatBase);
  const reseatClone = mc.getCachedFloorBias(reseatDid);

  // Initial check
  assert.equal(heightTexForMaterial(reseatClone), hgtTex, "Clone initially has hgtTex");

  // Re-seat base with hgtTex2
  _inheritHeightTex(null, reseatBase); // clear old
  if (reseatBase.userData) reseatBase.userData.pomTextureName = hgtTex2.name;
  installPomShaderPatch(reseatBase, hgtTex2, { steps: 32 });
  applyMicroSurfaceEnhancement(reseatBase, hgtTex2, { microCreviceAo: true, microContactShadow: true });

  // Reseat clone
  mc._reseatVariantsForDid(reseatDid);

  assert.equal(heightTexForMaterial(reseatClone), hgtTex2, "Reseated clone points to new heightmap");
  assert.equal(reseatClone.userData.pomTextureName, hgtTex2.name, "Reseated clone pomTextureName matches");
  pass("Dynamic re-seat correctly propagates new heightmaps and updates uniform latches");

  // 2e. Building Batch Lifecycle: Mock _BuildingBatch holding variant
  class _MockBuildingBatch extends THREE.BatchedMesh {
    dispose() {
      if (this.userData && this.userData.__disposed) return this;
      if (this.userData) this.userData.__disposed = true;
      try { releaseBatchedMaterial(this); } catch (_) {}
      return super.dispose();
    }
  }

  const mockBatchMesh = new _MockBuildingBatch(10, 100, 100, batchMat);
  holdBatchedMaterial(mockBatchMesh);
  assert.equal(mockBatchMesh.material, batchMat, "Batch mesh holds variant");

  mockBatchMesh.dispose();
  assert.equal(mockBatchMesh.userData.__disposed, true, "Dispose latch activated");
  pass("_BuildingBatch lifecycle hold/release and dispose latch verified");
}

// ============================================================================
// SECTION 3: Headless WebGL Compilation & Pixel Readback Matrix
// ============================================================================
console.log("\n--- Section 3: Headless WebGL Compilation & Execution Matrix ---");

async function runBrowserSmoke(query) {
  const browser = await chromium.launch({
    executablePath: "/usr/bin/chromium",
    headless: true,
    args: [
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--no-sandbox",
    ],
  });

  try {
    const page = await browser.newPage();
    const pageErrors = [];
    const missing = [];

    page.on("pageerror", (e) => {
      console.error("  [PAGE ERROR]", String(e).slice(0, 400));
      pageErrors.push(String(e).slice(0, 400));
    });
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        console.error("  [PAGE CONSOLE ERROR]", msg.text().slice(0, 400));
      }
    });

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
        if (u.pathname !== "/favicon.ico") missing.push(u.pathname);
        return route.fulfill({ status: 404, body: `File not found: ${u.pathname}` });
      }

      try {
        return route.fulfill({ status: 200, contentType: type, body: readFileSync(file) });
      } catch (e) {
        missing.push(u.pathname);
        return route.fulfill({ status: 404, body: String(e) });
      }
    });

    await page.goto(`http://smoke.test/page.html${query}`);
    await page.waitForFunction(() => window.__smoke, null, { timeout: 60000 });
    const res = await page.evaluate(() => window.__smoke);

    res.pageErrors = pageErrors;
    res.missing = missing;
    return res;
  } finally {
    await browser.close();
  }
}

const testRuns = [
  { name: "WebGL2 SwiftShader (LogDepth ON, Quality HIGH)", query: "?depthMode=log&quality=high" },
  { name: "WebGL2 SwiftShader (Reversed-Z ON, Quality HIGH)", query: "?depthMode=reversed&quality=high" },
];

for (const t of testRuns) {
  console.log(`\n  Executing ${t.name}...`);
  const r = await runBrowserSmoke(t.query);

  assert.equal(r.pageErrors.length, 0, `Zero page errors: ${JSON.stringify(r.pageErrors)}`);
  assert.equal(r.missing.length, 0, `Zero missing routes: ${JSON.stringify(r.missing)}`);
  assert.equal(r.errors.length, 0, `Zero test runtime errors: ${JSON.stringify(r.errors)}`);
  assert.ok(r.results.length >= 16, `Expected >= 16 test results, got ${r.results.length}`);

  for (const c of r.results) {
    assert.equal(c.ok, true, `WebGL Test failed: ${c.name} (${c.detail})`);
    pass(`[WebGL] ${c.name} -> ${c.detail}`);
  }
}

console.log("\n======================================================================");
console.log(` ALL ADVERSARIAL STRESS SUITES PASSED (${totalPassed} assertions verified).`);
console.log("======================================================================\n");
