// tests/held_attach_generation.test.mjs — held-5 (2026-10-08, `?attachGen`):
// the last server request for a held child wins.
//
// Retail DoParentEvent / DoPickupEvent (acclient.c:143483-143528) run
// synchronously, in arrival order. `attachChildToParent` awaits the wielder's
// holding-location fetch and the child's placement-frame fetch, so a resumed
// request used to land after a newer detach / re-placement. A per-child
// generation (attach, explicit detach, PickupEvent, wire removal) drops it.
//
//   1. attach then explicit detach mid-await → stays detached, nothing parked.
//   2. two placements whose frame fetches resolve out of order → the newer
//      placement's frames stay on the parts.
//   3. EQUIP-3 kept: the rig torn down mid-await by an INTERNAL respawn →
//      the request re-parks; after a WIRE removal it is dropped instead.
//
// Run from apps/holtburger-web/:  node tests/held_attach_generation.test.mjs

import assert from "node:assert/strict";

const THREE = await import("three");
const { EntityManager } = await import("../scene3d/entities.js");

let passed = 0, failed = 0;
const check = async (name, fn) => {
  try { await fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${e.message}`); }
};
const ticks = async (n = 8) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const P = 0x50000001, C = 0x80000020;
const PARENT_SETUP = 0x02000001, CHILD_SETUP = 0x02000ab1;
const holdingBundle = () => ({
  takeLocations: () => [{ locationKey: 1, partId: 1, ox: 0.1, oy: 0.2, oz: 0.3, qw: 1, qx: 0, qy: 0, qz: 0 }],
});
const framesBundle = (placement) => ({
  // One part; its x offset names the placement the frames came from.
  takeFrames: () => [{ partIndex: 0, ox: 10 + placement, oy: 0, oz: 0, qw: 1, qx: 0, qy: 0, qz: 0 }],
});

/** Fresh manager + fake wielder / child rigs; `wasm` overrides per case. */
function setup(wasm) {
  const entitiesGroup = new THREE.Group();
  const em = new EntityManager({ entitiesGroup, materialCache: null }, wasm);
  const rig = (guid, setupId, n) => {
    const root = new THREE.Group();
    const parts = Array.from({ length: n }, () => { const g = new THREE.Group(); root.add(g); return g; });
    entitiesGroup.add(root);
    const inst = { guid, root, parts, meta: { setupId }, dispose() { root.parent?.remove(root); } };
    em.entityMap.set(guid, inst);
    return inst;
  };
  return { em, entitiesGroup, wielder: rig(P, PARENT_SETUP, 3), child: rig(C, CHILD_SETUP, 1), rig };
}
const parked = (em, g) => em._preCreate.hasFor(g, "attach") || em._pendingAttach.has(g);

await check("1: an explicit detach during the holding-location await wins", async () => {
  const hold = deferred();
  const { em, wielder, child } = setup({ fetchSetupHoldingLocations: () => hold.promise });
  const pending = em.attachChildToParent(C, P, 1, 1);
  await ticks();
  await em.attachChildToParent(C, 0, 0, 0); // ParentEvent(NULL) / kind:47
  hold.resolve(holdingBundle());
  await pending;
  await ticks();
  assert.notEqual(child.root.parent, wielder.parts[1]);
  assert.equal(child._attachedParentGuid ?? null, null);
  assert.equal(em._lastAttach.has(C), false);
  assert.equal(parked(em, C), false);
});

await check("2: out-of-order placement-frame fetches leave the NEWER grip on the parts", async () => {
  const slow = deferred();
  const { em, child } = setup({
    fetchSetupHoldingLocations: async () => holdingBundle(),
    fetchSetupPlacementFrames: (sid, placement) =>
      placement === 0 ? slow.promise : Promise.resolve(framesBundle(placement)),
  });
  const first = em.attachChildToParent(C, P, 1, 0);
  await ticks(); // first is mounted and waiting on the placement-0 frames
  assert.equal(child._attachedPlacement, 0);
  await em.attachChildToParent(C, P, 1, 1);
  assert.equal(child.parts[0].position.x, 11);
  slow.resolve(framesBundle(0));
  await first;
  await ticks();
  assert.equal(child.parts[0].position.x, 11, "the late placement-0 frames were applied");
  assert.equal(child._attachedPlacement, 1);
});

await check("3a: EQUIP-3 kept — a rig rebuilt mid-await (internal) re-parks the request", async () => {
  const hold = deferred();
  const { em } = setup({ fetchSetupHoldingLocations: () => hold.promise });
  const pending = em.attachChildToParent(C, P, 1, 1);
  await ticks();
  em.remove(C); // applyAppearance / LOD remove()+spawn(): no wire removal
  hold.resolve(holdingBundle());
  await pending;
  assert.equal(parked(em, C), true);
});

await check("3b: after a WIRE removal the resumed request is dropped, not re-parked", async () => {
  const hold = deferred();
  const { em } = setup({ fetchSetupHoldingLocations: () => hold.promise });
  const pending = em.attachChildToParent(C, P, 1, 1);
  await ticks();
  em.noteWireRemove(C); // loop.js _armRemove
  em.remove(C);
  hold.resolve(holdingBundle());
  await pending;
  assert.equal(parked(em, C), false);
  assert.equal(em._attachGen.has(C), false, "the generation entry is released");
});

await check("4: a PickupEvent (leaveWorld) during the await wins over the attach", async () => {
  const hold = deferred();
  const { em, wielder, child } = setup({ fetchSetupHoldingLocations: () => hold.promise });
  const pending = em.attachChildToParent(C, P, 1, 1);
  await ticks();
  em.leaveWorld(C);
  hold.resolve(holdingBundle());
  await pending;
  assert.notEqual(child.root.parent, wielder.parts[1]);
  assert.equal(child.root.visible, false);
});

await check("5: generations are manager-wide, so a re-created guid never matches an old one", () => {
  const { em } = setup({});
  const g1 = em._bumpAttachGen(C);
  em.noteWireRemove(C);
  const g2 = em._bumpAttachGen(C);
  assert.notEqual(g1, g2);
  assert.equal(em._attachSuperseded(C, g1), true);
  assert.equal(em._attachSuperseded(C, g2), false);
});

console.log(`\nheld_attach_generation: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
