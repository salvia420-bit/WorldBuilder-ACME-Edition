// tests/dismember_archive.test.mjs — corpse dismemberment archive ownership
// (2026-10-07). An archive entry that expires used to hand its stumps back to
// "a rig" whenever the stump still had a parent — but a despawned corpse
// detaches only its root, so its stumps keep their dead part group as parent
// and were never freed. The entry now remembers the rig holding the stumps.
//
// Run from apps/holtburger-web/:  node tests/dismember_archive.test.mjs

import assert from "node:assert/strict";
import * as THREE from "three";

globalThis.window = { location: { search: "" } };
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);

const dm = await import("../scene3d/dismember.js");

let passed = 0, failed = 0;
const check = (name, fn) => {
  try { fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${e.message}`); }
};

let nextGuid = 0x80000001;
const shared = new THREE.BufferGeometry(); // cache-shared original geometry
const rig = () => {
  const root = new THREE.Group();
  const part = new THREE.Group();
  root.add(part);
  part.add(new THREE.Mesh(shared, new THREE.MeshBasicMaterial()));
  return { guid: nextGuid++, root, parts: [part] };
};
// A creature whose part 0 was already sliced: originals stashed, one stump
// mesh (module-owned geometry) on the part.
const slicedCreature = () => {
  const c = rig();
  const originals = c.parts[0].children.slice();
  for (const m of originals) c.parts[0].remove(m);
  c._dismemberStash = new Map([[0, originals]]);
  const g = new THREE.BufferGeometry();
  g.userData.__disposable = true;
  let disposed = 0;
  g.addEventListener("dispose", () => disposed++);
  const stump = new THREE.Mesh(g, new THREE.MeshBasicMaterial());
  c.parts[0].add(stump);
  return { c, stump, disposedCount: () => disposed };
};
// Fill the archive past its cap (32) so the oldest entry is evicted.
const pushArchiveOut = () => {
  for (let i = 0; i < 32; i++) {
    const { c } = slicedCreature();
    dm.transferDismemberment(c, rig());
  }
};

check("a despawned corpse's archived stump is freed at eviction", () => {
  const { c, stump, disposedCount } = slicedCreature();
  const corpse = rig();
  assert.equal(dm.transferDismemberment(c, corpse), 1);
  assert.equal(stump.parent, corpse.parts[0], "stump moved onto the corpse");
  assert.equal(stump.geometry.userData.__corpseArchived, true);
  // Corpse despawns: EntityManager.remove detaches the root only.
  corpse._disposed = true;
  corpse.root.parent?.remove(corpse.root);
  pushArchiveOut();
  assert.equal(disposedCount(), 1, "geometry disposed exactly once");
  assert.equal(stump.parent, null, "detached from the dead part group");
});

check("a corpse still alive at eviction gets ownership back (not freed)", () => {
  const { c, stump, disposedCount } = slicedCreature();
  const corpse = rig();
  dm.transferDismemberment(c, corpse);
  pushArchiveOut();
  assert.equal(disposedCount(), 0);
  assert.equal(stump.parent, corpse.parts[0]);
  assert.equal(stump.geometry.userData.__disposable, true, "the live rig's dispose walk now frees it");
  assert.equal(stump.geometry.userData.__corpseArchived, false);
});

check("a re-spawned corpse owns the restored stumps (the old rig's death does not matter)", () => {
  const { c, stump, disposedCount } = slicedCreature();
  const corpse = rig();
  dm.transferDismemberment(c, corpse);
  corpse._disposed = true;
  const again = rig();
  again.guid = corpse.guid;
  assert.equal(dm.restoreCorpseDismemberment(again), true);
  assert.equal(stump.parent, again.parts[0]);
  pushArchiveOut();
  assert.equal(disposedCount(), 0, "still drawn by the re-spawned corpse");
  assert.equal(stump.geometry.userData.__disposable, true);
});

console.log(`dismember_archive: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
