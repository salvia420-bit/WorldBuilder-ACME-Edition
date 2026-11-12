// tests/entity_hotloop_vel_and_attach.test.mjs — Area 7 (2026-11):
// 1. AC Z-up horizontal velocity (Math.hypot(dx, dy)).
// 2. Elimination of hot-loop performance.now() and material scans for clothed entities.
// 3. Clear this._lastAttach on clearWorldEntities() and dispose().
// 4. Counter-scale monster rig held weapons in attachChildToParent.
// 5. Async liveness checks in _attachParticleChainForEntity.
// 6. Shader patch preservation in _getOrCloneEntityMaterial.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { EntityManager } from "../scene3d/entities.js";

function createMockScene3d() {
  const scene = new THREE.Scene();
  return {
    scene,
    camera: null, // bail open distance test in _shouldTickEntity
    activeLights: new Set(),
    renderer: {
      capabilities: { maxTextures: 16 },
    },
  };
}

test("1. AC Z-up horizontal velocity: Math.hypot(dx, dy)", () => {
  const scene3d = createMockScene3d();
  const em = new EntityManager(scene3d, {
    fetch_surfaces_pixels: () => {},
  });

  const inst = {
    guid: 0x50000001,
    root: new THREE.Group(),
    _velPrevX: 100,
    _velPrevY: 200,
    _velPrevZ: 50,
    _velScale: 1.0,
    _isLocalPlayer: false,
  };
  inst.root.position.set(100, 200, 50);
  em.entityMap.set(inst.guid, inst);

  // Case A: Moving North (+Y) in AC coords (dx = 0, dy = 10, dz = 0)
  inst.root.position.set(100, 210, 50);
  em.tick(1.0); // dt = 1.0 s
  // speed = Math.hypot(0, 10) / 1.0 = 10
  assert.equal(inst._velPrevX, 100);
  assert.equal(inst._velPrevY, 210);
  assert.equal(inst._velPrevZ, 50);
  assert.ok(Math.abs(inst._emaSpeed - 10) < 1e-3, `North running speed should be ~10, got ${inst._emaSpeed}`);

  // Case B: Moving East (+X) in AC coords (dx = 6, dy = 0, dz = 0)
  inst.root.position.set(106, 210, 50);
  em.tick(1.0);
  assert.ok(Math.abs(inst._velPrevX - 106) < 1e-3);
  assert.ok(Math.abs(inst._velPrevY - 210) < 1e-3);

  // Case C: Moving strictly Up (+Z) in AC coords (dx = 0, dy = 0, dz = 20) -> horizontal ground delta is 0
  inst.root.position.set(106, 210, 70);
  inst._emaSpeed = undefined;
  em.tick(1.0);
  assert.equal(inst._emaSpeed, 0, `Vertical movement must produce 0 horizontal ground speed, got ${inst._emaSpeed}`);

  em.dispose();
});

test("2. Clothed entity hot-loop eliminates performance.now() and scans when no tweens/texVel", () => {
  const scene3d = createMockScene3d();
  const em = new EntityManager(scene3d);

  const mat = new THREE.MeshStandardMaterial();
  const inst = {
    guid: 0x50000002,
    root: new THREE.Group(),
    _entityMaterials: new Map([
      [0x08000001, mat],
    ]),
    _materialHookTweens: null,
    _texVelMaterials: null,
  };
  inst.root.position.set(0, 0, 0);
  em.entityMap.set(inst.guid, inst);

  let tweenNowMsCalls = 0;
  em._tweenNowMs = () => {
    tweenNowMsCalls += 1;
    return 1000;
  };

  em.tick(0.016);
  assert.equal(tweenNowMsCalls, 0, "No performance.now / _tweenNowMs should be called without active tweens");

  // Setup part surface lookup with proper Group and Mesh
  mat.map = new THREE.Texture();
  mat.map.offset = new THREE.Vector2(0, 0);
  const partGroup = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
  mesh.userData = { surfaceDid: 0x08000001 };
  partGroup.add(mesh);
  inst.parts = [partGroup];

  em._setTextureVelocity(inst, 0, 0.5, 0.25);
  assert.ok(inst._texVelMaterials instanceof Set);
  assert.ok(inst._texVelMaterials.has(mat), "inst._texVelMaterials contains the scrolling material");

  em.tick(1.0);
  assert.equal(tweenNowMsCalls, 0, "TexVel alone does not invoke _tweenNowMs");
  assert.ok(Math.abs(mat.map.offset.x - 0.5) < 1e-4, "offset.x scrolled by us * dt");
  assert.ok(Math.abs(mat.map.offset.y - 0.25) < 1e-4, "offset.y scrolled by vs * dt");

  // Stop texture velocity
  em._setTextureVelocity(inst, 0, 0, 0);
  assert.equal(inst._texVelMaterials.has(mat), false, "Stopping texVel removes material from Set");

  em.dispose();
});

test("3. clearWorldEntities() and dispose() clear this._lastAttach", () => {
  const scene3d = createMockScene3d();
  const em = new EntityManager(scene3d);

  em._lastAttach.set(0x50000010, { parentGuid: 0x50000001, partIndex: 2 });
  em._lastAttach.set(0x50000011, { parentGuid: 0x50000002, partIndex: 1 });
  assert.equal(em._lastAttach.size, 2);

  em.clearWorldEntities();
  assert.equal(em._lastAttach.size, 0, "clearWorldEntities() must clear _lastAttach");

  em._lastAttach.set(0x50000012, { parentGuid: 0x50000003, partIndex: 0 });
  assert.equal(em._lastAttach.size, 1);

  em.dispose();
  assert.equal(em._lastAttach.size, 0, "dispose() must clear _lastAttach");
});

test("4. Held weapon scaling distortion prevention on scaled monster rigs", async () => {
  const scene3d = createMockScene3d();
  const em = new EntityManager(scene3d);

  // Parent monster rig scaled up 2.5x
  const parent = {
    guid: 0x50000100,
    root: new THREE.Group(),
    parts: [new THREE.Group()],
    meta: { setupId: 0x02000001 },
  };
  parent.root.scale.set(2.5, 2.5, 2.5);
  parent.root.add(parent.parts[0]);

  // Child weapon rig with normal scale 1.0
  const child = {
    guid: 0x50000200,
    root: new THREE.Group(),
    _attachedParentGuid: null,
    meta: { obj_scale: 1.0 },
  };
  child.root.scale.set(1.0, 1.0, 1.0);

  em.entityMap.set(parent.guid, parent);
  em.entityMap.set(child.guid, child);

  // Mock holding location resolve
  em._resolveHoldingLocation = async () => ({
    partId: 0,
    ox: 0,
    oy: 0,
    oz: 0,
    qw: 1,
    qx: 0,
    qy: 0,
    qz: 0,
  });

  await em.attachChildToParent(child.guid, parent.guid, 1, 0);

  // Child root should be counter-scaled by 1 / 2.5 = 0.4
  assert.ok(Math.abs(child.root.scale.x - 0.4) < 1e-4, `Expected counter-scaled x=0.4, got ${child.root.scale.x}`);
  assert.ok(Math.abs(child.root.scale.y - 0.4) < 1e-4, `Expected counter-scaled y=0.4, got ${child.root.scale.y}`);
  assert.ok(Math.abs(child.root.scale.z - 0.4) < 1e-4, `Expected counter-scaled z=0.4, got ${child.root.scale.z}`);

  // When unlinking/detaching, original scale (1.0) must be restored
  em._unlinkChildRig(child);
  assert.equal(child.root.scale.x, 1.0);
  assert.equal(child.root.scale.y, 1.0);
  assert.equal(child.root.scale.z, 1.0);

  em.dispose();
});

test("5. Liveness checks across async yields in _attachParticleChainForEntity", async () => {
  const scene3d = createMockScene3d();
  const em = new EntityManager(scene3d, {
    fetch_surfaces_pixels: () => {},
  });

  const inst = {
    guid: 0x50000300,
    root: new THREE.Group(),
    _disposed: false,
  };
  em.entityMap.set(inst.guid, inst);

  // Mock wasm exports with async delay
  let resolvedScript = false;
  em.wasmExports = {
    fetchPhysicsScript: async () => {
      // Simulate removal mid-flight
      em.entityMap.delete(inst.guid);
      inst._disposed = true;
      resolvedScript = true;
      return null;
    },
  };

  const res = await em._attachParticleChainForEntity(inst.guid, inst.root, 0x02000001);
  assert.equal(resolvedScript, true);
  assert.equal(res.ok, false);
  // inst was disposed mid-flight, so no particle chains attached to inst.root
  assert.equal(inst.root.children.length, 0, "No particle nodes should attach to disposed entity");

  em.dispose();
});

test("6. _getOrCloneEntityMaterial preserves CSM, lightClampRetail, and POM patches", () => {
  const scene3d = createMockScene3d();
  const em = new EntityManager(scene3d);

  const inst = {
    guid: 0x50000400,
    root: new THREE.Group(),
    _entityMaterials: new Map(),
  };

  const sharedMat = new THREE.MeshStandardMaterial({ color: 0xffffff });
  sharedMat.userData = {
    __cacheOwned: true,
    __lightClampRetailPatched: true,
    __csmShaderPatched: true,
    __pomPatched: true,
  };
  sharedMat.onBeforeCompile = (shader) => {
    shader.fragmentShader = "// patched lightClamp\n" + shader.fragmentShader;
  };
  sharedMat.customProgramCacheKey = () => "test_light_clamp_key";

  em.materialCache = {
    getCached: (did) => (did === 0x08000099 ? sharedMat : null),
  };

  const cloned = em._getOrCloneEntityMaterial(inst, 0x08000099);
  assert.ok(cloned);
  assert.notStrictEqual(cloned, sharedMat);
  assert.equal(cloned.userData.lightClampRetail, true, "lightClamp patch preserved on clone");
  assert.equal(cloned.userData.__csmShaderPatched, true, "CSM patch preserved on clone");
  assert.equal(cloned.userData.__pomPatched, true, "POM patch preserved on clone");
  assert.ok(typeof cloned.onBeforeCompile === "function", "onBeforeCompile preserved");
  assert.ok(typeof cloned.customProgramCacheKey === "function", "customProgramCacheKey preserved");
  assert.ok(cloned.customProgramCacheKey().includes("l1"), "customProgramCacheKey contains lightClamp marker (l1)");

  em.dispose();
});
