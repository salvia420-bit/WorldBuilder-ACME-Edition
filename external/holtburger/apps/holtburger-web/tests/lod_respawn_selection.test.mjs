// tests/lod_respawn_selection.test.mjs — T9 dynamic-LOD respawns vs the selection and the attack
// loop (2026-10-11, found on the 1070).
//
// A selected "Pumpkin Buffer" 11.5 m away was remove()+spawn()ed twice a second: the spawn-time
// LOD pick read the lod_prewarm memo (25 m buckets), which held the other band, so every respawn
// rebuilt the band the tick had just rejected. Each remove() released the selection and emitted
// selectionChanged(0); picking.js read that as a deselect and sent CancelAttack every ~0.5 s in
// melee stance, so a charge at another mob ended in "Action cancelled!" whenever the two met.
//   L1  _respawnForLod hands the tick's band to the spawn (meta._lodForcedSub) and marks the guid
//       for the duration of its remove()
//   L2  the selection release of a same-guid LOD respawn is flagged lodRespawn; a real delete is not
//   L3  picking.js's deselect handler reads the CustomEvent's detail (it read `ev.guid` = undefined, so
//       EVERY selection change counted as a clear and cancelled the attack) and ignores a lodRespawn clear
//   L4  the spawn-time LOD pick prefers the forced band over the memo and drops it after use
//
// Run from apps/holtburger-web/:  node tests/lod_respawn_selection.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

globalThis.window ??= {};
globalThis.window.location ??= { search: "" };
globalThis.window.__playEffectVfxBound = true;
globalThis.window.__spellShapePreviewBound = true;

const THREE = await import("three");
const { EntityManager } = await import("../scene3d/entities.js");

const ME = 0x50000001;
const A = 0x8000370d;

function world() {
  const emitted = [];
  globalThis.window.__pluginClient = { events: { emit: (name, ev) => emitted.push({ name, ev }), on() {} } };
  globalThis.window.__sessionHandle = {
    getLocalPlayerPose() { return { x: 0, y: 0, z: 0, heading: 0, landblockId: 0x00000019 }; },
    combatMode() { return 2; },
  };
  globalThis.window.getLocalPlayerGuid = () => ME;
  const em = new EntityManager({ entitiesGroup: new THREE.Group(), materialCache: null }, {});
  const add = (guid, x) => {
    const root = new THREE.Group();
    root.position.set(x, 0, 0);
    const inst = { guid, root, parts: [], meta: { guid, landblockId: 0, x, y: 0, z: 0 }, _stateVisible: true, _attachedParentGuid: null, _attachedChildren: null, dispose() {} };
    em.entityMap.set(guid, inst);
    return inst;
  };
  add(ME, 0);
  const a = add(A, 11.5);
  return { em, a, emitted };
}

test("L1: _respawnForLod passes the measured band and marks the guid during remove()", async () => {
  const { em, a } = world();
  let markedDuringRemove = null;
  let spawnedMeta = null;
  em.remove = (g) => { markedDuringRemove = em._lodRespawnGuid; em.entityMap.delete(g >>> 0); };
  em.spawn = async (meta) => { spawnedMeta = meta; };
  await em._respawnForLod(a, A, 0x01001e41);
  assert.equal(markedDuringRemove, A, "the guid is marked while remove() runs");
  assert.equal(em._lodRespawnGuid, 0, "and cleared after");
  assert.equal(spawnedMeta._lodForcedSub, 0x01001e41, "the spawn receives the tick's band");
  assert.equal(spawnedMeta._internalRespawn, true);
  em.dispose?.();
});

test("L1: without a measured band the stale forced band is not carried over", async () => {
  const { em, a } = world();
  a.meta._lodForcedSub = 0x01000001; // left by an earlier respawn
  let spawnedMeta = null;
  em.remove = (g) => { em.entityMap.delete(g >>> 0); };
  em.spawn = async (meta) => { spawnedMeta = meta; };
  await em._respawnForLod(a, A);
  assert.equal("_lodForcedSub" in spawnedMeta, false);
  em.dispose?.();
});

test("L2: a same-guid LOD respawn's selection release is flagged lodRespawn; a real delete is not", () => {
  const { em, emitted } = world();
  em._commitSelection(A);
  em._lodRespawnGuid = A;
  em.releaseSelectionOnServerDelete(A);
  em._lodRespawnGuid = 0;
  const lod = emitted.filter((e) => e.name === "selectionChanged" && e.ev.guid === 0).pop();
  assert.ok(lod, "the clear is still emitted (subscribers re-sync on the re-select)");
  assert.equal(lod.ev.lodRespawn, true);
  assert.equal(lod.ev.prevGuid, A);
  emitted.length = 0;
  em._commitSelection(A);
  em.releaseSelectionOnServerDelete(A);
  const real = emitted.filter((e) => e.name === "selectionChanged" && e.ev.guid === 0).pop();
  assert.equal(real.ev.lodRespawn, false, "a server delete is a real deselect");
  em.dispose?.();
});

test("L3: picking.js reads ev.detail and ignores a lodRespawn clear before cancelling the move or the attack", () => {
  const src = readFileSync(new URL("../scene3d/picking.js", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("onSelectionCleared = (ev) => {"));
  assert.ok(body.indexOf("const d = ev?.detail ?? ev ?? {};") > 0 && body.indexOf("const d = ev?.detail") < body.indexOf("cancelClientMove();"), "the payload is read from the CustomEvent detail");
  assert.ok(body.indexOf("if (((d.guid >>> 0) || 0) !== 0) return;") > 0, "a selection (not a clear) returns early");
  assert.equal(body.slice(0, body.indexOf("cancelClientMove();")).includes("ev?.guid"), false, "no bare ev.guid read");
  const iGuard = body.indexOf("if (d.lodRespawn) return;");
  assert.ok(iGuard > 0, "the guard exists");
  assert.ok(iGuard < body.indexOf("cancelClientMove();"), "before the client move is cancelled");
  assert.ok(iGuard < body.indexOf("sessionHandle.cancelAttack()"), "before CancelAttack");
});

test("L4: the spawn-time LOD pick prefers the forced band over the memo, one-shot", () => {
  const src = readFileSync(new URL("../scene3d/entities.js", import.meta.url), "utf8");
  const i = src.indexOf("Number.isFinite(meta._lodForcedSub)");
  assert.ok(i > 0);
  const near = src.slice(i, i + 400);
  assert.ok(near.indexOf("meta._lodForcedSub >>> 0") < near.indexOf("lodPrewarmGet(setupId, distance)"), "forced band first, memo second");
  assert.ok(near.includes("delete meta._lodForcedSub"), "dropped after use");
  assert.ok(src.includes("this._respawnForLod(inst, g, sub)"), "the tick passes its band");
});
