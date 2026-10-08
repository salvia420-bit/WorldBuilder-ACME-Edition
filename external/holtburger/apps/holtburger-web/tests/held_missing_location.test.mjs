// tests/held_missing_location.test.mjs — held-6 (2026-10-08, `?heldMountStrict`):
// no holding location, no mount.
//
// Retail `CPhysicsObj::add_child` (acclient.c:316729-316760) fails when the
// wielder's Setup has no holding location for the key, and `set_parent`
// (:322952-322992) then does nothing: the child is not drawn. holtburger used
// to mount it at the wielder's root origin (its feet).
//
//   1. missing holding location → an unmounted child stays out of the world
//      (state-hidden, not at the feet); a child already mounted keeps that
//      mount (retail `set_parent` returns without touching it).
//   2. a null holding-location fetch is not cached (the next attach re-fetches);
//      a real table is cached.
//   3. scene3d/held_location.js `heuristicParentLocation` = ACE
//      `Creature_Equipment.GetPlacementLocation` (location AND placement), and
//      scene3d/index.js flushWieldedDirty uses it under the flag.
//
// Run from apps/holtburger-web/:  node tests/held_missing_location.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const THREE = await import("three");
const { EntityManager } = await import("../scene3d/entities.js");
const { heuristicParentLocation } = await import("../scene3d/held_location.js");

let passed = 0, failed = 0;
const check = async (name, fn) => {
  try { await fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${e.message}`); }
};

const P = 0x50000001, C = 0x80000030;
const PARENT_SETUP = 0x02000001, CHILD_SETUP = 0x02000ab1;
let holdingFetches = 0;
let holdingAnswer = "table";
const wasm = {
  async fetchSetupHoldingLocations() {
    holdingFetches++;
    if (holdingAnswer === "null") return null;
    // RightHand(1) only — no LeftWeapon(8) on this Setup.
    return { takeLocations: () => [{ locationKey: 1, partId: 1, ox: 0.1, oy: 0.2, oz: 0.3, qw: 1, qx: 0, qy: 0, qz: 0 }] };
  },
};
const entitiesGroup = new THREE.Group();
const em = new EntityManager({ entitiesGroup, materialCache: null }, wasm);
function rig(guid, setupId, n) {
  const root = new THREE.Group();
  const parts = Array.from({ length: n }, () => { const g = new THREE.Group(); root.add(g); return g; });
  entitiesGroup.add(root);
  const inst = { guid, root, parts, meta: { setupId }, dispose() { root.parent?.remove(root); } };
  em.entityMap.set(guid, inst);
  return inst;
}
const wielder = rig(P, PARENT_SETUP, 3);
const child = rig(C, CHILD_SETUP, 1);
const underWielder = (o) => { for (let n = o.parent; n; n = n.parent) if (n === wielder.root) return true; return false; };

await check("2a: a null holding-location fetch is not cached as an empty table", async () => {
  holdingAnswer = "null";
  await em.attachChildToParent(C, P, 1, 1);
  assert.equal(em._holdingLocCache.has(PARENT_SETUP), false);
  assert.equal(underWielder(child.root), false, "nothing to mount on → not drawn at the feet");
  assert.equal(child.root.visible, false);
});

await check("2b: the next attach re-fetches, mounts, and caches the real table", async () => {
  holdingAnswer = "table";
  const before = holdingFetches;
  await em.attachChildToParent(C, P, 1, 1);
  assert.equal(holdingFetches, before + 1);
  assert.equal(child.root.parent, wielder.parts[1]);
  assert.equal(child.root.visible, true);
  assert.equal(em._holdingLocCache.has(PARENT_SETUP), true);
  await em.attachChildToParent(C, P, 1, 1);
  assert.equal(holdingFetches, before + 1, "cached");
});

await check("1a: a location the Setup lacks leaves a MOUNTED child as it is (set_parent no-op)", async () => {
  await em.attachChildToParent(C, P, 8, 2); // LeftWeapon: absent on this Setup
  assert.equal(child.root.parent, wielder.parts[1]);
  assert.equal(child._attachedParentGuid, P);
  assert.equal(child._attachedLocation, 1);
  assert.equal(child.root.visible, true);
  assert.deepEqual(em._lastAttach.get(C), { parentGuid: P, location: 1, placement: 1 });
});

await check("1b: an UNMOUNTED child with no holding location is not drawn (not at the feet)", async () => {
  await em.attachChildToParent(C, 0, 0, 0); // unwield
  child.root.visible = true; child._stateVisible = true;
  await em.attachChildToParent(C, P, 8, 2);
  assert.equal(underWielder(child.root), false);
  assert.equal(child.root.parent, entitiesGroup);
  assert.equal(child._attachedParentGuid, null);
  assert.equal(child._stateVisible, false);
  assert.equal(child.root.visible, false);
});

// ---- 3. fallback mapping = ACE GetPlacementLocation ------------------------
const ARMOR = 0x2, MELEE = 0x1, MISSILE = 0x100, CASTER = 0x8000;
const cases = [
  ["MeleeWeapon", 0x00100000, MELEE, { loc: 1, place: 1 }],
  ["Held (caster)", 0x01000000, CASTER, { loc: 1, place: 1 }],
  ["TwoHanded", 0x02000000, MELEE, { loc: 1, place: 1 }],
  ["Shield slot, armour shield", 0x00200000, ARMOR, { loc: 3, place: 6 }],
  ["Shield slot, off-hand weapon", 0x00200000, MELEE, { loc: 8, place: 2 }],
  ["MissileWeapon (bow vs thrown unknown)", 0x00400000, MISSILE, null],
  ["MissileAmmo (FU-1 Quiver while held-6 c is open)", 0x00800000, 0x100, { loc: 5, place: 0 }],
  ["armour slot", 0x00000200, ARMOR, null],
  ["no slot", 0, MELEE, null],
];
for (const [name, mask, itemType, want] of cases) {
  await check(`3: ${name} → ${want ? `(${want.loc},${want.place})` : "wait for the server attach"}`, () => {
    assert.deepEqual(heuristicParentLocation(mask, itemType), want);
  });
}
await check("3: MissileAmmo with `?wieldHandAttach=off` → no guess", () => {
  assert.equal(heuristicParentLocation(0x00800000, 0x100, { ammoQuiver: false }), null);
});
await check("3: flushWieldedDirty uses the mapping under heldMountStrict, skips left-world items", () => {
  const src = readFileSync(new URL("../scene3d/index.js", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("function flushWieldedDirty()"), src.indexOf("function markWielderDirty("));
  assert.match(body, /if \(loc === 0 && heldMountStrict\) \{[\s\S]*heuristicParentLocation\(it\.equipMask, it\.itemType,[\s\S]*if \(!h\) continue;[\s\S]*if \(place === 0\) place = h\.place;/);
  assert.match(body, /if \(mounted \|\| leftWorld\) \{ heldAttached\+\+; continue; \}/);
  assert.match(src, /import \{ heuristicParentLocation \} from "\.\/held_location\.js";/);
});

console.log(`\nheld_missing_location: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
