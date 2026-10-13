// tests/cam_fade_hierarchical.test.mjs — models-camera-1 (2026-10-13,
// `?camFadeHier`): the camera fade on the local player is hierarchical and
// sticky, as retail.
//
// Retail fades the player with `CPhysicsObj::SetTranslucencyHierarchical`
// (acclient.c:318733-318755), which recurses the CHILDLIST, and
// `CameraSet::UpdateCamera` (:149181-149216) re-applies it every frame in-head
// and in the 0.45 m near band. `CPhysicsObj::DoObjDescChanges`
// (:316853-316876) re-applies the translucency to re-dressed parts. holtburger
// faded only the body's part meshes and deduped on the value, so in first
// person the wielded weapon hovered opaque in front of the camera, and a
// re-dress / respawn brought the body back.
//
//   1. the fade reaches held children (and theirs: a dart on an atlatl);
//      backing off restores everything and forgets the remembered fade.
//   2. a re-dress hot-swap (fresh, unfaded materials) is re-faded by the
//      `_syncCamFade(inst, true)` hook; the plain re-push is deduped away.
//   3. an item mounted while faded fades; one unmounted while faded is restored.
//   4. a respawned local player re-takes the fade on the spawn commit, also
//      when the push landed while the rig was being rebuilt.
//   5. other rigs are untouched (no material clone); authored translucency
//      composes multiplicatively and is restored exactly.
//   6. `?camFadeHier=off` = the body-only fade (child untouched, no memory).
//   7. the hooks sit at the hot-swap commit, the spawn commit, the mount and
//      the detach, plus (review R1) the partial-rebuild sites: the
//      ReplaceObject hook and both R-8 heal ladders.
//   8. review R1 — a ReplaceObject swap to a surface DID the rig never used,
//      and a plain-ladder heal, re-take the fade instead of leaving the
//      shared, unfaded cache material on the faded player; a partial re-sync
//      keeps a stale-faded rig restorable; `?camFadeHier=off` stays inert.
//
// Run from apps/holtburger-web/:  node tests/cam_fade_hierarchical.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const THREE = await import("three");
const { EntityManager, camFadeHierEnabled } = await import("../scene3d/entities.js");

let passed = 0, failed = 0;
const check = async (name, fn) => {
  try { await fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${e.message}`); }
};

const P = 0x50000001, C = 0x80000040, C2 = 0x80000041, D = 0x80000042, O = 0x50000077;
const PARENT_SETUP = 0x02000001, CHILD_SETUP = 0x02000ab1;
const BODY_DID = 0x08000101, HEAD_DID = 0x08000102, SWORD_DID = 0x08000201;
const DART_DID = 0x08000202, GHOST_DID = 0x08000203;

const wasm = {
  async fetchSetupHoldingLocations() {
    // RightHand(1) → part 1 of the wielder; the child's own part 0 for a nested child.
    return { takeLocations: () => [
      { locationKey: 1, partId: 1, ox: 0.1, oy: 0.2, oz: 0.3, qw: 1, qx: 0, qy: 0, qz: 0 },
      { locationKey: 2, partId: 0, ox: 0, oy: 0, oz: 0, qw: 1, qx: 0, qy: 0, qz: 0 },
    ] };
  },
};

/** Fresh manager whose material cache hands out shared per-DID materials. */
function setup() {
  const shared = new Map();
  const sharedMat = (did, opacity = 1) => {
    if (!shared.has(did)) {
      const m = new THREE.MeshStandardMaterial({ transparent: opacity < 1, opacity });
      m.userData = { __cacheOwned: true };
      shared.set(did, m);
    }
    return shared.get(did);
  };
  sharedMat(GHOST_DID, 0.5); // authored-translucent surface
  const materialCache = {
    fallbackMaterial: new THREE.MeshBasicMaterial(),
    getCached: (did) => shared.get(did >>> 0) ?? null,
  };
  const entitiesGroup = new THREE.Group();
  const em = new EntityManager({ entitiesGroup, materialCache }, wasm);
  const rig = (guid, setupId, dids) => {
    const root = new THREE.Group();
    const parts = dids.map((did) => {
      const g = new THREE.Group();
      const m = new THREE.Mesh(new THREE.BufferGeometry(), sharedMat(did));
      m.userData = { guid, surfaceDid: did };
      g.add(m);
      root.add(g);
      return g;
    });
    entitiesGroup.add(root);
    const inst = {
      guid, root, parts, meta: { setupId },
      _attachedParentGuid: null, _attachedChildren: null,
      dispose() { root.parent?.remove(root); },
    };
    em.entityMap.set(guid, inst);
    return inst;
  };
  const player = rig(P, PARENT_SETUP, [BODY_DID, HEAD_DID]);
  const child = rig(C, CHILD_SETUP, [SWORD_DID]);
  return { em, shared, rig, player, child };
}
const mat = (inst, part = 0) => inst.parts[part].children.find((o) => o.isMesh).material;

await check("1a: the fade reaches the held child (CHILDLIST walk)", async () => {
  const { em, shared, player, child } = setup();
  await em.attachChildToParent(C, P, 1, 1);
  em.setLocalPlayerCameraOpacity(P, 0);
  for (const m of [mat(player, 0), mat(player, 1), mat(child)]) {
    assert.equal(m.opacity, 0);
    assert.equal(m.transparent, true);
    assert.equal(m.depthWrite, false);
  }
  assert.equal(shared.get(SWORD_DID).opacity, 1, "the shared cache material was not mutated");
  assert.notEqual(mat(child), shared.get(SWORD_DID), "the child got a per-entity clone");
  assert.deepEqual(em._localCamFade, { guid: P, o: 0 });
});

await check("1b: a nested child (dart on an atlatl) fades too", async () => {
  const { em, rig, child } = setup();
  const dart = rig(D, CHILD_SETUP, [DART_DID]);
  await em.attachChildToParent(C, P, 1, 1);
  await em.attachChildToParent(D, C, 2, 1);
  assert.equal(dart.root.parent, child.parts[0]);
  em.setLocalPlayerCameraOpacity(P, 0.25);
  assert.equal(mat(dart).opacity, 0.25);
});

await check("1c: backing off restores body + child and forgets the fade", async () => {
  const { em, player, child } = setup();
  await em.attachChildToParent(C, P, 1, 1);
  em.setLocalPlayerCameraOpacity(P, 0);
  em.setLocalPlayerCameraOpacity(P, 1);
  for (const m of [mat(player, 0), mat(child)]) {
    assert.equal(m.opacity, 1);
    assert.equal(m.transparent, false);
    assert.equal(m.depthWrite, true);
    assert.equal(m.userData.__preCamFadeOpacity, undefined);
  }
  assert.equal(em._localCamFade, null);
});

await check("2: a re-dress hot-swap keeps the body faded (the re-push alone is deduped)", async () => {
  const { em, player } = setup();
  em.setLocalPlayerCameraOpacity(P, 0);
  // What `_applyAppearanceHotSwap` does: fresh meshes + materials, new map.
  const fresh = new Map();
  player.parts.forEach((g, i) => {
    for (const o of g.children.slice()) if (o.isMesh) g.remove(o);
    const did = i === 0 ? BODY_DID : HEAD_DID;
    const m = new THREE.MeshStandardMaterial();
    m.userData = { __disposable: true };
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), m);
    mesh.userData = { guid: P, surfaceDid: did };
    g.add(mesh);
    fresh.set(did, m);
  });
  player._entityMaterials = fresh;
  em.setLocalPlayerCameraOpacity(P, 0); // camera.js would not even push this
  assert.equal(mat(player).opacity, 1, "stale per-inst dedupe skipped the fresh materials");
  em._syncCamFade(player, true); // the hot-swap commit hook
  assert.equal(mat(player, 0).opacity, 0);
  assert.equal(mat(player, 1).opacity, 0);
  assert.equal(mat(player, 0), fresh.get(BODY_DID), "faded in place, no extra clone");
});

await check("3a: an item mounted on the faded player fades with it", async () => {
  const { em, rig } = setup();
  em.setLocalPlayerCameraOpacity(P, 0);
  const shield = rig(C2, CHILD_SETUP, [SWORD_DID]);
  await em.attachChildToParent(C2, P, 1, 1);
  assert.equal(mat(shield).opacity, 0);
  assert.equal(mat(shield).depthWrite, false);
});

await check("3b: an item unmounted while faded is restored (not left invisible)", async () => {
  const { em, player, child } = setup();
  await em.attachChildToParent(C, P, 1, 1);
  em.setLocalPlayerCameraOpacity(P, 0);
  await em.attachChildToParent(C, 0, 0, 0); // ParentEvent(NULL) → _detachChild
  assert.equal(mat(child).opacity, 1);
  assert.equal(mat(child).transparent, false);
  assert.equal(mat(child).depthWrite, true);
  assert.equal(mat(player).opacity, 0, "the player stays faded");
});

await check("3c: _detachChild restores the child's authored (pre) opacity", async () => {
  const { em, rig } = setup();
  const ghost = rig(C2, CHILD_SETUP, [GHOST_DID]);
  await em.attachChildToParent(C2, P, 1, 1);
  em.setLocalPlayerCameraOpacity(P, 0.5);
  assert.equal(mat(ghost).opacity, 0.25, "composes multiplicatively over the surface's own 0.5");
  em._detachChild(C2);
  assert.equal(mat(ghost).opacity, 0.5);
  assert.equal(mat(ghost).transparent, true);
});

await check("4a: a respawned local player re-takes the fade on the spawn commit", async () => {
  const { em, rig } = setup();
  em.setLocalPlayerCameraOpacity(P, 0);
  em.entityMap.delete(P); // applyAppearance fallback: remove(g) …
  const fresh = rig(P, PARENT_SETUP, [BODY_DID, HEAD_DID]); // … + spawn(newMeta)
  em._syncCamFade(fresh); // the `_spawnImpl` commit hook
  assert.equal(mat(fresh).opacity, 0);
});

await check("4b: a push that lands while the rig is being rebuilt is remembered", async () => {
  const { em, rig } = setup();
  em.entityMap.delete(P);
  em.setLocalPlayerCameraOpacity(P, 0.5);
  const fresh = rig(P, PARENT_SETUP, [BODY_DID, HEAD_DID]);
  em._syncCamFade(fresh);
  assert.equal(mat(fresh).opacity, 0.5);
});

await check("5: other rigs are untouched by the sync hooks (no clone)", async () => {
  const { em, shared, rig } = setup();
  em.setLocalPlayerCameraOpacity(P, 0);
  const other = rig(O, PARENT_SETUP, [BODY_DID]);
  em._syncCamFade(other);
  em._syncCamFade(other, true);
  assert.equal(mat(other), shared.get(BODY_DID));
  assert.equal(other._camFadeOpacity, undefined);
  assert.equal(shared.get(BODY_DID).opacity, 1);
});

await check("6: `?camFadeHier=off` — body only, no memory, hooks inert", async () => {
  const { em, shared, rig, player, child } = setup();
  em._camFadeHier = false;
  await em.attachChildToParent(C, P, 1, 1);
  em.setLocalPlayerCameraOpacity(P, 0);
  assert.equal(mat(player).opacity, 0);
  assert.equal(mat(child), shared.get(SWORD_DID), "child untouched");
  assert.equal(mat(child).opacity, 1);
  assert.equal(em._localCamFade, null);
  const shield = rig(C2, CHILD_SETUP, [GHOST_DID]);
  await em.attachChildToParent(C2, P, 1, 1);
  assert.equal(mat(shield), shared.get(GHOST_DID));
  em.setLocalPlayerCameraOpacity(P, 0); // per-inst dedupe as before
  assert.equal(player._camFadeOpacity, 0);
});

await check("6b: camFadeHierEnabled parses the escape", () => {
  assert.equal(camFadeHierEnabled(""), true);
  assert.equal(camFadeHierEnabled("?camFadeHier=on"), true);
  assert.equal(camFadeHierEnabled("?camFadeHier=off"), false);
  assert.equal(camFadeHierEnabled("?camFadeHier=OFF"), false);
  assert.equal(camFadeHierEnabled("?x=1&camFadeHier=0"), false);
  assert.equal(camFadeHierEnabled("?camFadeHier=false"), false);
});

// ── review R1: partial rebuilds (ReplaceObject hook, R-8 heal ladders) ──────
const NEWHAND_DID = 0x08000301;
/** A one-triangle wasm mesh on `did`, as `fetchBuildingPlacement` hands back. */
const fakeBundle = (did) => ({
  partCount: 1,
  takePartMeshes: () => [{
    triCount: 1,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    uvs: new Float32Array(6),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    surfaceIndices: new Uint8Array([0]),
    surfaces: new Uint32Array([did]),
  }],
});
/** setup() + the hook's wasm/cache surface + spawn-shaped geometry tracking. */
function setupHook() {
  const s = setup();
  s.em.wasmExports = { ...wasm, fetchBuildingPlacement: async (id) => fakeBundle(id === 1 ? BODY_DID : NEWHAND_DID) };
  s.em.materialCache.materials = new Map();
  for (const inst of [s.player, s.child]) {
    inst.geometries = [];
    inst.registerGeometry = (g) => inst.geometries.push(g);
  }
  // The new surface is already decoded (shared cache) but this rig never used it.
  const nm = new THREE.MeshStandardMaterial();
  nm.userData = { __cacheOwned: true };
  s.shared.set(NEWHAND_DID, nm);
  s.em.materialCache.materials.set(NEWHAND_DID, nm);
  return s;
}
const meshes = (inst, part) => inst.parts[part].children.filter((o) => o.isMesh);

await check("8a: a ReplaceObject swap to a new surface DID re-takes the fade (R1)", async () => {
  const { em, shared, player, child } = setupHook();
  await em.attachChildToParent(C, P, 1, 1);
  em.setLocalPlayerCameraOpacity(P, 0);
  await em._fireReplaceObjectHook(player, 1, 0x01000abc); // hand part → bare-hand GfxObj
  const [m] = meshes(player, 1);
  assert.equal(m.userData.surfaceDid, NEWHAND_DID);
  assert.notEqual(m.material, shared.get(NEWHAND_DID), "the shared cache material is not left on the faded rig");
  assert.equal(m.material.opacity, 0);
  assert.equal(m.material.depthWrite, false);
  assert.equal(shared.get(NEWHAND_DID).opacity, 1, "the shared cache material was not mutated");
  assert.equal(mat(player, 0).opacity, 0, "untouched parts stay faded");
  assert.equal(mat(child).opacity, 0, "the held child stays faded and stays mounted");
  assert.equal(child.root.parent, player.parts[1]);
  // Backing off still restores the swapped part and the old clones.
  em.setLocalPlayerCameraOpacity(P, 1);
  assert.equal(m.material.opacity, 1);
  assert.equal(m.material.depthWrite, true);
  assert.equal(mat(player, 0).opacity, 1);
});

await check("8b: a same-DID swap reuses the faded clone; no fade live = NPC untouched", async () => {
  const { em, shared, player, rig } = setupHook();
  em.setLocalPlayerCameraOpacity(P, 0.5);
  const faded = mat(player, 0);
  await em._fireReplaceObjectHook(player, 0, 1); // id 1 → BODY_DID again
  assert.equal(meshes(player, 0)[0].material, faded);
  assert.equal(faded.opacity, 0.5);
  em.setLocalPlayerCameraOpacity(P, 1);
  const npc = rig(O, PARENT_SETUP, [BODY_DID]);
  npc.geometries = []; npc.registerGeometry = () => {};
  await em._fireReplaceObjectHook(npc, 0, 0x01000abc);
  assert.equal(meshes(npc, 0)[0].material, shared.get(NEWHAND_DID), "no clone for a never-faded rig");
  assert.equal(npc._camFadeOpacity, undefined);
});

await check("8c: `?camFadeHier=off` — the hook leaves the swapped part as before", async () => {
  const { em, shared, player } = setupHook();
  em._camFadeHier = false;
  em.setLocalPlayerCameraOpacity(P, 0);
  await em._fireReplaceObjectHook(player, 1, 0x01000abc);
  assert.equal(meshes(player, 1)[0].material, shared.get(NEWHAND_DID));
  assert.equal(mat(player, 0).opacity, 0);
});

await check("8d: a partial re-sync keeps a stale-faded rig restorable (not orphaned)", async () => {
  // A faded child that left the world (PickupEvent) is not restored by the
  // back-off push; a partial rebuild must not forget it still owns faded
  // clones, unlike the full re-dress reset (`_syncCamFade(inst, true)`).
  const { em, player, child } = setupHook();
  await em.attachChildToParent(C, P, 1, 1);
  em.setLocalPlayerCameraOpacity(P, 0);
  player._attachedChildren.delete(C); // _unlinkChildRig (leaveWorld): no restore
  child._attachedParentGuid = null;
  em.setLocalPlayerCameraOpacity(P, 1);
  assert.equal(mat(child).opacity, 0, "precondition: the unlinked child kept its fade");
  em._syncCamFadePartial(child);
  assert.equal(mat(child).opacity, 1);
  assert.equal(mat(child).depthWrite, true);
  assert.equal(child._camFadeOpacity, 1);
});

await check("8e: the plain R-8 heal ladder re-fades a healed part on the faded player", async () => {
  const { em, shared, player } = setupHook();
  // A part whose decode lost the spawn race: the mapless fallback, and the
  // surface is not in the cache yet, so the fade itself skips it.
  const m = meshes(player, 1)[0];
  m.material = em.materialCache.fallbackMaterial;
  shared.delete(HEAD_DID);
  em.setLocalPlayerCameraOpacity(P, 0);
  assert.equal(player._entityMaterials.has(HEAD_DID), false, "precondition: fade skipped the miss");
  const real = new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
  real.userData = { __cacheOwned: true };
  shared.set(HEAD_DID, real);
  em.materialCache.preload = async () => {};
  em.wasmExports.fetch_surfaces_pixels = () => [];
  em._scheduleEntitySurfaceRefresh(player, 0);
  await new Promise((r) => setTimeout(r, 700));
  // The fixture's other (map-less) parts re-arm the ladder; stop it.
  clearTimeout(player._surfaceRefreshTimer);
  assert.notEqual(m.material, real, "the shared healed material is not left on the faded rig");
  assert.equal(m.material.map, real.map);
  assert.equal(m.material.opacity, 0);
  assert.equal(real.opacity, 1);
});

await check("7: the sync hooks sit at the four rebuild / mount sites", () => {
  const src = readFileSync(new URL("../scene3d/entities.js", import.meta.url), "utf8");
  const body = (sig) => {
    const i = src.indexOf(sig);
    assert.ok(i >= 0, `missing ${sig}`);
    const j = src.indexOf("\n  }\n", i);
    return src.slice(i, j);
  };
  assert.match(body("async _applyAppearanceHotSwap(inst, newMeta, guid) {"),
    /inst\._entityMaterials = entityMaterials;\s*\n(?:\s*\/\/[^\n]*\n)*\s*this\._syncCamFade\(inst, true\);/);
  assert.match(body("async _spawnImpl(meta, gen = 0) {"),
    /this\._syncCamFade\(inst\);[\s\S]*return inst;/);
  assert.match(body("async attachChildToParent(childGuid, parentGuid, location, placement) {"),
    /p\._attachedChildren\.add\(cGuid\);\s*\n(?:\s*\/\/[^\n]*\n)*\s*this\._syncCamFade\(c\);/);
  assert.match(body("_detachChild(childGuid) {"),
    /this\._unlinkChildRig\(c, cGuid\);\s*\n(?:\s*\/\/[^\n]*\n)*\s*this\._syncCamFade\(c\);/);
  // review R1 — the partial rebuild sites: the ReplaceObject hook and both
  // R-8 heal ladders.
  assert.match(body("async _fireReplaceObjectHook(inst, partIndex, newGfxObjId) {"),
    /_stampEntityIndoorLayer\(this\.scene3d, partGroup\);\s*\n(?:\s*\/\/[^\n]*\n)*\s*this\._syncCamFadePartial\(inst\);/);
  assert.match(src.slice(src.indexOf("_scheduleEntitySurfaceRefresh(inst, attempt = 0) {"),
    src.indexOf("_cancelRecoloredSurfaceRefresh(inst) {")),
    /if \(swapped\) this\._syncCamFadePartial\(inst\);/);
  assert.match(src.slice(src.indexOf("_scheduleRecoloredSurfaceRefresh(inst, spec, attempt = 0) {"),
    src.indexOf("_scheduleDyedSurfaceRefresh(inst, spec, attempt = 0) {")),
    /inst\._entityMaterials\.set\(d, m\);\s*\n(?:\s*\/\/[^\n]*\n)*\s*this\._syncCamFadePartial\(inst\);/);
  // camera_retail_math.test.cjs pins this signature.
  assert.match(src, /setLocalPlayerCameraOpacity\(guid, opacity\)/);
});

console.log(`\ncam_fade_hierarchical: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
