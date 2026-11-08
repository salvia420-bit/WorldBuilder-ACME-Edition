// tests/challenger_m1_pom_stress.test.mjs
// Adversarial Empirical Challenge Suite for Milestone 1:
// 1. Material clone variants (chains, rapid reseats, transparent/forced, null textures)
// 2. Distance LOD transition boundaries (15m, 25m, 35m, 50m, 0m, degenerate bounds)

import assert from "node:assert/strict";
import * as THREE from "three";
import {
  MaterialCache,
  SURFACE_TYPE,
  SURFACE_CATEGORY,
  _reinstallClonePom,
  heightTexForMaterial,
} from "../scene3d/materials.js";
import { statPomConfig, makeArrayMaterial } from "../scene3d/static_atlas.js";

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

const tex = new THREE.DataTexture(new Uint8Array([200, 150, 100, 255]), 1, 1);
const nrm = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
const hgtA = new THREE.DataTexture(new Uint8Array([220]), 1, 1);
hgtA.name = "hgtA";
const hgtB = new THREE.DataTexture(new Uint8Array([180]), 1, 1);
hgtB.name = "hgtB";

console.log("================================================================================");
console.log("CHALLENGER STRESS HARNESS — Milestone 1: Material Clones & LOD Boundaries");
console.log("================================================================================");

// -----------------------------------------------------------------------------
// PART 1: MATERIAL CLONE VARIANTS & CHAINS
// -----------------------------------------------------------------------------
console.log("\n>>> [CHALLENGE 1.1] Clones from Base vs Repeated Clone-of-Clone Chain");
{
  const mc = new MaterialCache({ pomEnabled: true, pomOpts: { steps: 16, depth: 0.08 } });
  const did = 0x08100001;
  const base = mc._materialFromFlags(SURFACE_TYPE.Base1Image, tex, SURFACE_CATEGORY.Stone, nrm, undefined, hgtA);
  mc.materials.set(did, base);

  // Direct clone from base:
  const c1 = base.clone();
  c1.userData = { ...(base.userData || {}), __cacheOwned: true };
  _reinstallClonePom(c1, base);

  assert.equal(c1.userData.pomEnabled, true, "c1 has pomEnabled true");
  assert.match(c1.customProgramCacheKey(), /\|p1\|/, "c1 has |p1| cache key");
  const sh1 = compile(c1);
  assert.ok(sh1.fragmentShader.includes("_pomPerturbedUv"), "c1 compiles POM");

  // Defect check: Clone-of-clone (c2 cloned from c1)
  const c2 = c1.clone();
  c2.userData = { ...(c1.userData || {}), __cacheOwned: true };
  _reinstallClonePom(c2, c1);

  const hTexC1 = heightTexForMaterial(c1);
  const c2HasCustomKey = c2.customProgramCacheKey && /\|p1\|/.test(c2.customProgramCacheKey());

  console.log("  [DIAGNOSTIC] heightTexForMaterial(c1):", hTexC1 ? "present" : "MISSING (null)");
  console.log("  [DIAGNOSTIC] c2.userData.pomEnabled:", c2.userData.pomEnabled);
  console.log("  [DIAGNOSTIC] c2 customProgramCacheKey has |p1|:", c2HasCustomKey);

  assert.equal(hTexC1, hgtA, "c1 height texture is registered in _heightTexByMaterial");
  assert.equal(c2.userData.pomEnabled, true, "c2 retains pomEnabled true");
  assert.equal(c2HasCustomKey, true, "c2 customProgramCacheKey has |p1|");
  const sh2 = compile(c2);
  assert.ok(sh2.fragmentShader.includes("_pomPerturbedUv"), "c2 compiles POM shader");

  // Verify arbitrary depth (3-deep clone chain: c1 -> c2 -> c3)
  const c3 = c2.clone();
  c3.userData = { ...(c2.userData || {}), __cacheOwned: true };
  _reinstallClonePom(c3, c2);
  assert.equal(heightTexForMaterial(c2), hgtA, "c2 height texture is registered");
  assert.equal(c3.userData.pomEnabled, true, "c3 has pomEnabled true");
  assert.match(c3.customProgramCacheKey(), /\|p1\|/, "c3 customProgramCacheKey has |p1|");
  const sh3 = compile(c3);
  assert.ok(sh3.fragmentShader.includes("_pomPerturbedUv"), "c3 compiles POM shader");
  console.log("  [PASS] Arbitrary-depth clone chains (base -> c1 -> c2 -> c3) retain full POM functionality.");
}

console.log("\n>>> [CHALLENGE 1.2] Rapid Reseating: Texture Swaps & Stale Height Uniform");
{
  const mc = new MaterialCache({ pomEnabled: true });
  const D = 0x08100099;

  const fb = mc.getCachedFloorBias(D);
  const stoneA = mc._materialFromFlags(SURFACE_TYPE.Base1Image, tex, SURFACE_CATEGORY.Stone, nrm, undefined, hgtA);
  const brickB = mc._materialFromFlags(SURFACE_TYPE.Base1Image, tex, SURFACE_CATEGORY.Brick, nrm, undefined, hgtB);

  // 1. Initial reseat to Stone A
  mc.materials.set(D, stoneA);
  mc._reseatVariantsForDid(D);
  const sh1 = compile(fb);
  assert.equal(sh1.uniforms.uPomMap.value.name, "hgtA", "Initial compilation binds hgtA");

  // 2. Texture swap to Brick B
  mc.materials.set(D, brickB);
  mc._reseatVariantsForDid(D);
  const sh2 = compile(fb);
  console.log("  [DIAGNOSTIC] After swap to Brick B, sh2 uPomMap is:", sh2.uniforms.uPomMap.value.name);
  assert.equal(sh2.uniforms.uPomMap.value.name, "hgtB", "uPomMap uniform updated to hgtB on reseat");
  assert.equal(fb.userData.pomShaderUniforms.uPomMap.value.name, "hgtB", "pomShaderUniforms live handle updated to hgtB");
  console.log("  [PASS] Texture swap to Brick B successfully updates uPomMap uniform and live handle.");

  // 3. Deactivation latching check
  const trans = mc._materialFromFlags(SURFACE_TYPE.Base1Image | SURFACE_TYPE.Translucent, tex, SURFACE_CATEGORY.Stone, nrm, undefined, hgtA);
  mc.materials.set(D, trans);
  mc._reseatVariantsForDid(D);
  assert.equal(fb.userData.pomEnabled, false, "Translucent reseat disables pomEnabled");

  // Re-seat back to Stone A
  mc.materials.set(D, stoneA);
  mc._reseatVariantsForDid(D);
  console.log("  [DIAGNOSTIC] After re-seat back to Stone A, pomEnabled is:", fb.userData.pomEnabled);
  assert.equal(fb.userData.pomEnabled, true, "pomEnabled safely restored on re-seat to Stone A");
  console.log("  [PASS] pomEnabled successfully recovers when re-seating onto valid masonry base.");
}

console.log("\n>>> [CHALLENGE 1.3] Clone Parameter Overrides");
{
  const mc = new MaterialCache({ pomEnabled: true, pomOpts: { steps: 16, depth: 0.08 } });
  const did = 0x08100002;
  const base = mc._materialFromFlags(SURFACE_TYPE.Base1Image, tex, SURFACE_CATEGORY.Stone, nrm, undefined, hgtA);
  mc.materials.set(did, base);

  const c1 = mc.getCachedFloorBias(did);
  const c2 = base.clone();
  c2.userData = { ...(base.userData || {}), __cacheOwned: true };
  _reinstallClonePom(c2, base, { steps: 32, depth: 0.15 });

  assert.equal(c1.userData.pomUniforms.steps, 16, "c1 steps remain 16");
  assert.equal(c2.userData.pomUniforms.steps, 32, "c2 steps overridden to 32");
  assert.equal(c2.userData.pomUniforms.depth, 0.15, "c2 depth overridden to 0.15");

  const sh1 = compile(c1);
  const sh2 = compile(c2);
  assert.equal(sh1.uniforms.uPomSteps.value, 16, "sh1 uPomSteps bound to 16");
  assert.equal(sh2.uniforms.uPomSteps.value, 32, "sh2 uPomSteps bound to 32");
  console.log("  [PASS] Clone parameter overrides isolate cleanly.");
}

console.log("\n>>> [CHALLENGE 1.4] Transparent & Additive Materials with POM Flags");
{
  const mc = new MaterialCache({ pomEnabled: true });
  const did = 0x08100004;

  const transBase = mc._materialFromFlags(
    SURFACE_TYPE.Base1Image | SURFACE_TYPE.Translucent,
    tex,
    SURFACE_CATEGORY.Stone,
    nrm,
    undefined,
    hgtA
  );
  mc.materials.set(did, transBase);
  const fb = mc.getCachedFloorBias(did);
  assert.equal(fb.userData.pomEnabled, undefined, "Translucent material clone has pomEnabled undefined");
  assert.match(fb.customProgramCacheKey(), /\|p0\|/, "Translucent material has |p0| key");

  const forcedBase = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.75, map: tex, normalMap: nrm });
  forcedBase.userData = { pomEnabled: true, pomForced: true };
  const forcedClone = forcedBase.clone();
  forcedClone.userData = { ...forcedBase.userData };

  _reinstallClonePom(forcedClone, forcedBase);
  assert.equal(forcedClone.userData.pomShaderUniforms, undefined, "Missing height texture skips clone hook");

  console.log("  [PASS] Transparent and additive materials adhere to POM safety exclusions.");
}

console.log("\n>>> [CHALLENGE 1.5] Null Textures and Degenerate Input Safety");
{
  assert.doesNotThrow(() => _reinstallClonePom(null, null), "null clone + null base does not throw");
  const dummy = new THREE.MeshStandardMaterial();
  assert.doesNotThrow(() => _reinstallClonePom(dummy, null), "dummy clone + null base does not throw");
  assert.doesNotThrow(() => _reinstallClonePom(null, dummy), "null clone + dummy base does not throw");

  const plainBase = new THREE.MeshStandardMaterial();
  const c = plainBase.clone();
  _reinstallClonePom(c, plainBase);
  assert.equal(c.userData.pomEnabled, undefined, "plain base does not activate POM on clone");

  // Missing height texture on clone:
  // Observe that Three.js clone copies base.userData (pomEnabled: true).
  // _reinstallClonePom returns early at `if (!hTex) return;` BEFORE deleting clone.userData.pomEnabled!
  const baseNoHeight = new THREE.MeshStandardMaterial();
  baseNoHeight.userData = { pomEnabled: true };
  const cNoHeight = baseNoHeight.clone();
  _reinstallClonePom(cNoHeight, baseNoHeight);

  console.log("  [DIAGNOSTIC] cNoHeight.userData.pomEnabled after failed reinstall:", cNoHeight.userData.pomEnabled);
  assert.equal(cNoHeight.userData.pomEnabled, undefined, "unbacked pomEnabled claim removed when hTex is missing");
  console.log("  [PASS] Missing height texture cleanly deletes unbacked pomEnabled claim.");

  const mc = new MaterialCache({ pomEnabled: true });
  const did = 0x08100005;
  const base = mc._materialFromFlags(SURFACE_TYPE.Base1Image, tex, SURFACE_CATEGORY.Stone, nrm, undefined, hgtA);
  mc.materials.set(did, base);
  const fb = mc.getCachedFloorBias(did);
  const initialHook = fb.onBeforeCompile;
  _reinstallClonePom(fb, base);
  _reinstallClonePom(fb, base);
  assert.equal(fb.onBeforeCompile, initialHook, "_reinstallClonePom is idempotent via WeakSet guard");
  console.log("  [PASS] Degenerate inputs safely handled.");
}

// -----------------------------------------------------------------------------
// PART 2: DISTANCE LOD TRANSITION BOUNDARIES
// -----------------------------------------------------------------------------
console.log("\n>>> [CHALLENGE 2.1] LOD Distance Evaluation Oracle & Boundary Continuity");

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0.0, Math.min(1.0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3.0 - 2.0 * t);
}

function evaluatePomShaderLOD(dist, near = 15.0, far = 35.0, steps = 16, shadowSteps = 8) {
  const pomDist = dist;
  const pomLod = 1.0 - smoothstep(near, far, pomDist);
  let pomEffSteps = steps;
  let pomEffShadowSteps = shadowSteps;
  const pomMid = (near + far) * 0.5;

  if (pomDist > pomMid) {
    pomEffSteps = Math.max(4, Math.floor(steps / 4));
    pomEffShadowSteps = Math.max(2, Math.floor(shadowSteps / 4));
  } else if (pomDist > near) {
    pomEffSteps = Math.max(4, Math.floor(steps / 2));
    pomEffShadowSteps = Math.max(2, Math.floor(shadowSteps / 2));
  }

  const active = pomLod > 0.001;
  const uvStepDivisor = pomEffSteps;
  const shadowStepDivisor = pomEffShadowSteps;

  return {
    dist,
    pomLod,
    active,
    pomEffSteps,
    pomEffShadowSteps,
    uvStepDivisor,
    shadowStepDivisor,
  };
}

const testDistances = [
  0.0,
  0.0001,
  1.0,
  14.9999,
  15.0,
  15.0001,
  20.0,
  24.9999,
  25.0,
  25.0001,
  30.0,
  34.9999,
  35.0,
  35.0001,
  49.9999,
  50.0,
  50.0001,
  100.0,
  1000.0,
];

for (const d of testDistances) {
  const res = evaluatePomShaderLOD(d, 15.0, 35.0, 16, 8);
  assert.ok(Number.isFinite(res.pomLod), `pomLod must be finite at dist ${d}`);
  assert.ok(!Number.isNaN(res.pomLod), `pomLod must not be NaN at dist ${d}`);
  assert.ok(res.pomLod >= 0.0 && res.pomLod <= 1.0, `pomLod must be in [0, 1] at dist ${d}`);
  assert.ok(res.uvStepDivisor >= 4, `uvStepDivisor must be >= 4 at dist ${d}`);
  assert.ok(res.shadowStepDivisor >= 2, `shadowStepDivisor must be >= 2 at dist ${d}`);

  if (d <= 15.0) {
    assert.equal(res.pomLod, 1.0, `Full strength below near (15m) at dist ${d}`);
    assert.equal(res.pomEffSteps, 16, `Full steps below near (15m) at dist ${d}`);
    assert.equal(res.pomEffShadowSteps, 8, `Full shadow steps below near at dist ${d}`);
  } else if (d > 15.0 && d <= 25.0) {
    assert.equal(res.pomEffSteps, 8, `Half steps (8) in [15m, 25m] at dist ${d}`);
    assert.equal(res.pomEffShadowSteps, 4, `Half shadow steps (4) in [15m, 25m] at dist ${d}`);
  } else if (d > 25.0 && d < 35.0) {
    assert.equal(res.pomEffSteps, 4, `Quarter steps (4) in [25m, 35m] at dist ${d}`);
    assert.equal(res.pomEffShadowSteps, 2, `Quarter shadow steps (2) in [25m, 35m] at dist ${d}`);
  } else if (d >= 35.0) {
    assert.equal(res.pomLod, 0.0, `pomLod must be 0.0 at or beyond 35m at dist ${d}`);
    assert.equal(res.active, false, `Shader POM branch inactive at or beyond 35m at dist ${d}`);
  }
}
console.log("  [PASS] All 19 critical distance boundary points evaluate without NaN/Inf/div-by-zero.");

console.log("\n>>> [CHALLENGE 2.2] Ultra Preset Boundaries (near 15m, far 50m, midpoint 32.5m)");
{
  const ultraSteps = 32;
  const ultraShadow = 16;
  const ultraNear = 15.0;
  const ultraFar = 50.0;
  const ultraMid = (ultraNear + ultraFar) * 0.5;

  const ultraDistances = [
    14.999, 15.0, 15.001,
    32.499, 32.5, 32.501,
    49.999, 50.0, 50.001,
  ];

  for (const d of ultraDistances) {
    const res = evaluatePomShaderLOD(d, ultraNear, ultraFar, ultraSteps, ultraShadow);
    assert.ok(Number.isFinite(res.pomLod), `Ultra pomLod must be finite at dist ${d}`);
    assert.ok(!Number.isNaN(res.pomLod), `Ultra pomLod must not be NaN at dist ${d}`);
    assert.ok(res.uvStepDivisor >= 4, `Ultra uvStepDivisor >= 4 at dist ${d}`);
    assert.ok(res.shadowStepDivisor >= 2, `Ultra shadowStepDivisor >= 2 at dist ${d}`);

    if (d <= ultraNear) {
      assert.equal(res.pomEffSteps, 32, "Ultra full steps at <= 15m");
      assert.equal(res.pomEffShadowSteps, 16, "Ultra full shadow steps at <= 15m");
    } else if (d > ultraNear && d <= ultraMid) {
      assert.equal(res.pomEffSteps, 16, "Ultra half steps at 15m-32.5m");
      assert.equal(res.pomEffShadowSteps, 8, "Ultra half shadow steps at 15m-32.5m");
    } else if (d > ultraMid && d < ultraFar) {
      assert.equal(res.pomEffSteps, 8, "Ultra quarter steps at 32.5m-50m");
      assert.equal(res.pomEffShadowSteps, 4, "Ultra quarter shadow steps at 32.5m-50m");
    } else if (d >= ultraFar) {
      assert.equal(res.active, false, "Ultra inactive beyond 50m");
    }
  }
  console.log("  [PASS] Ultra preset bounds (15m, 32.5m, 50m) scale correctly.");
}

console.log("\n>>> [CHALLENGE 2.3] Static Atlas Parity at Boundaries (15m, 25m, 35m)");
{
  const cfg = statPomConfig();
  assert.equal(cfg.near, 15.0, "Static atlas near is 15.0m");
  assert.equal(cfg.far, 35.0, "Static atlas far is 35.0m");

  const diffArray = new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1);
  const nraArray = new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1);
  const mat = makeArrayMaterial(diffArray, 1, nraArray, {});
  const shader = compile(mat);
  assert.ok(shader.fragmentShader.includes("_statEffSteps"), "Static atlas shader includes _statEffSteps");
  assert.ok(shader.fragmentShader.includes("float( _statEffSteps )"), "Static atlas uses _statEffSteps divisor");
  console.log("  [PASS] Static atlas config and shader match distance-adaptive step architecture.");
}

console.log("\n================================================================================");
console.log("CHALLENGER STRESS HARNESS EXECUTION COMPLETE");
console.log("================================================================================");
