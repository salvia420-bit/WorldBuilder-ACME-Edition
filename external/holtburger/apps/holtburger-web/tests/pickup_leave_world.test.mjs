// tests/pickup_leave_world.test.mjs — held-4 (2026-10-08, `?pickupLeaveWorld`):
// a PickupEvent for an item its wielder still owns only takes it out of the
// world. Retail `SmartBox::DoPickupEvent` (acclient.c:143483-143500) is
// `unset_parent` + `leave_world`; the object survives and the reload
// ParentEvent (`set_parent` :322952) shows the SAME object again. ACE hides
// held ammo this way on every missile shot.
//
//   1. EntityManager.leaveWorld: same rig kept, unparented, state-hidden, not
//      disposed; ledger replays / setVisibility leave it hidden; the next
//      attach re-mounts the SAME inst and shows it.
//   2. A PickupEvent that beats the rig's spawn parks and replays on commit.
//   3. noteWireRemove(wielder) reaps the left-world items it owned.
//   4. loop.js `_armAttach` routes the leave-world sentinel to leaveWorld and
//      `_armRemove` calls noteWireRemove.
//   5. Source: the wasm PickupEvent arm branches on Wielder ownership and keeps
//      `js_spawned_guids` on that path.
//
// Run from apps/holtburger-web/:  node tests/pickup_leave_world.test.mjs

import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join as joinPath } from "node:path";
import { readFileSync } from "node:fs";

const APP = joinPath(dirname(fileURLToPath(import.meta.url)), "..");
const THREE = await import("three");
const { EntityManager } = await import("../scene3d/entities.js");

let passed = 0, failed = 0;
const check = async (name, fn) => {
  try { await fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${e.message}`); }
};
const ticks = async (n = 6) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

const P = 0x50000001, C = 0x80000010, C2 = 0x80000011, LATE = 0x80000012;
const PARENT_SETUP = 0x02000001, CHILD_SETUP = 0x02000ab1;

/** wasm stand-in: the wielder Setup holds location 1 (RightHand) on part 1. */
const wasm = {
  async fetchSetupHoldingLocations(sid) {
    if (sid !== PARENT_SETUP) return null;
    return {
      takeLocations: () => [{ locationKey: 1, partId: 1, ox: 0.1, oy: 0.2, oz: 0.3, qw: 1, qx: 0, qy: 0, qz: 0 }],
    };
  },
};

const entitiesGroup = new THREE.Group();
const em = new EntityManager({ entitiesGroup, materialCache: null }, wasm);

/** Fake rig: real three Groups (the attach path re-parents them). */
function rig(guid, setupId, nParts) {
  const root = new THREE.Group();
  const parts = [];
  for (let i = 0; i < nParts; i++) { const g = new THREE.Group(); root.add(g); parts.push(g); }
  const geom = new THREE.BufferGeometry();
  let disposed = 0;
  geom.addEventListener("dispose", () => { disposed++; });
  parts[0].add(new THREE.Mesh(geom));
  entitiesGroup.add(root);
  const inst = {
    guid, root, parts, meta: { setupId },
    get geomDisposed() { return disposed; },
    dispose() { geom.dispose(); root.parent?.remove(root); },
  };
  em.entityMap.set(guid, inst);
  return inst;
}

const wielder = rig(P, PARENT_SETUP, 3);
const child = rig(C, CHILD_SETUP, 1);

await check("setup: the attach mounts the child on the wielder's hand part", async () => {
  await em.attachChildToParent(C, P, 1, 1);
  assert.equal(child.root.parent, wielder.parts[1]);
  assert.equal(child._attachedParentGuid, P);
  assert.equal(child.root.visible, true);
});

await check("1a: leaveWorld keeps the SAME rig, unparented and state-hidden", () => {
  em.leaveWorld(C);
  assert.equal(em.entityMap.get(C), child);
  assert.equal(child._attachedParentGuid, null);
  assert.equal(child.root.parent, entitiesGroup);
  assert.equal(child._stateVisible, false);
  assert.equal(child.root.visible, false);
  assert.equal(child._leftWorld, true);
  assert.equal(wielder._attachedChildren.has(C), false);
  assert.equal(em._leftWorldChildren.get(C), P);
});

await check("1b: nothing was disposed and the re-attach ledger is kept", () => {
  assert.equal(child.geomDisposed, 0);
  assert.equal(em._lastAttach.has(C), true);
});

await check("1c: a wielder rebuild's ledger replay and a visibility event keep it hidden", async () => {
  em._replayLastAttach(P, false);
  em.setVisibility(C, true);
  await ticks();
  assert.equal(child._attachedParentGuid, null);
  assert.equal(child.root.visible, false);
});

await check("1d: an internal rebuild of the left-world rig stays out of the world", () => {
  // Spawn-commit block in `_spawnImpl`: internal → hidden; wire → state ends.
  assert.match(
    readFileSync(joinPath(APP, "scene3d", "entities.js"), "utf8"),
    /this\._leftWorldChildren\.has\(guid\)\) \{\s*if \(meta\._internalRespawn\) \{\s*_setEntityStateVisible\(inst, false\);\s*inst\._leftWorld = true;\s*\} else \{\s*this\._leftWorldChildren\.delete\(guid\);/,
  );
});

await check("1e: the reload ParentEvent re-mounts the SAME inst and shows it", async () => {
  await em.attachChildToParent(C, P, 1, 1);
  assert.equal(em.entityMap.get(C), child);
  assert.equal(child.root.parent, wielder.parts[1]);
  assert.equal(child.root.visible, true);
  assert.equal(child._leftWorld, false);
  assert.equal(em._leftWorldChildren.has(C), false);
});

await check("2: a PickupEvent that beats the rig's spawn parks and replays on commit", () => {
  em.leaveWorld(LATE);
  assert.equal(em._preCreate.hasFor(LATE, "leaveWorld"), true);
  const late = rig(LATE, CHILD_SETUP, 1);
  em._drainPreCreate(LATE);
  assert.equal(late.root.visible, false);
  assert.equal(late._leftWorld, true);
  assert.equal(em._preCreate.hasFor(LATE), false);
});

await check("3: removing the wielder from the wire reaps the left-world items it owned", async () => {
  const c2 = rig(C2, CHILD_SETUP, 1);
  await em.attachChildToParent(C2, P, 1, 1);
  em.leaveWorld(C2);
  em.noteWireRemove(P);
  assert.equal(em.entityMap.has(C2), false);
  assert.equal(c2.geomDisposed, 1);
  assert.equal(em._leftWorldChildren.has(C2), false);
  assert.equal(em.entityMap.has(C), true); // mounted, not left-world: untouched
});

// ---- 4. loop.js dispatch (spliced like tests/held_attach_promote.test.mjs) ----
{
  const raw = readFileSync(joinPath(APP, "scene3d", "loop.js"), "utf8");
  const stripped = raw.replace(/^import[\s\S]*?from\s+["'][^"']+["'];\s*$/gm, "");
  const stubs = `
const tickCellVisibility3D = () => {}; const tickPvsLoadExpansion = () => {};
const noteEntityLandcell = () => {}; const tickLightingForCellState = () => {};
const getTerrainVisualZ = (sc, x, y, z) => z; const cullTerrainGroup = () => {};
const BUILDINGS_SHADOW_RANGE_SQ_M = 0; const STATICS_SHADOW_RANGE_SQ_M = 0;
const cullStaticsGroup = () => {}; const tickFrustumCull = () => {}; const setCullers = () => {};
const tickEntityRenderVisibility = () => {}; const tickPortalSpace = () => {};
const cloneEntityUpdate = (u) => ({ ...u }); const weatherForState = () => null;
const wxUpdateFromDayGroup = () => {}; const createClientEventDispatcher = () => () => false;
const VFX_GLOBALS = { uTime: { value: 0 } }; const setMasterClock = () => {};
const shouldDeferDeathRemove = () => false; const deathHoldVerdict = () => "remove"; const DEATH_CLAIM_POLL_MS = 150;
const KIND = Object.freeze({ POSITION: 0, SPAWN: 1, REMOVE: 2, META_REFRESH: 3, VELOCITY: 4,
  MOTION: 5, APPEARANCE: 6, ATTACH: 7, MOTION_ACTION: 8, TURN: 9 });
const createEntityDispatcher = () => ({ dispatch() { return false; } });
`;
  const THREE_URL = pathToFileURL(joinPath(APP, "node_modules", "three", "build", "three.module.js")).href;
  const src = `import * as THREE from ${JSON.stringify(THREE_URL)};\n${stubs}${stripped}\n`;
  globalThis.window = { location: { search: "" } };
  globalThis.location = { search: "" };
  const loop = await import("data:text/javascript;base64," + Buffer.from(src).toString("base64"));
  const calls = [];
  const fakeEm = {
    entityMap: new Map(),
    remove: (g) => calls.push(["remove", g]),
    leaveWorld: (g) => calls.push(["leaveWorld", g]),
    noteWireRemove: (g) => calls.push(["noteWireRemove", g]),
    attachChildToParent: (...a) => calls.push(["attach", ...a]),
  };
  const sc = { entityManager: fakeEm };

  await check("4a: kind=7 detach with the leave-world sentinel → em.leaveWorld", () => {
    calls.length = 0;
    loop.dispatchEntityUpdate(sc, fakeEm, { kind: 7, guid: C, modelId: 0, motionCommand: 0, motionStance: 0xFFFFFFFF });
    assert.deepEqual(calls, [["leaveWorld", C]]);
  });
  await check("4b: a plain detach (placement 0) is still a detach", () => {
    calls.length = 0;
    loop.dispatchEntityUpdate(sc, fakeEm, { kind: 7, guid: C, modelId: 0, motionCommand: 0, motionStance: 0 });
    assert.deepEqual(calls, [["attach", C, 0, 0, 0]]);
  });
  await check("4c: an EntityManager without leaveWorld falls back to the detach", () => {
    calls.length = 0;
    const oldEm = { ...fakeEm, leaveWorld: undefined };
    loop.dispatchEntityUpdate(sc, oldEm, { kind: 7, guid: C, modelId: 0, motionStance: 0xFFFFFFFF });
    assert.deepEqual(calls, [["attach", C, 0, 0, 0xFFFFFFFF]]);
  });
  await check("4d: a wire KIND_REMOVE tells the manager (noteWireRemove) before removing", () => {
    calls.length = 0;
    loop.dispatchEntityUpdate(sc, fakeEm, { kind: 2, guid: C2 });
    assert.deepEqual(calls[0], ["noteWireRemove", C2]);
    assert.ok(calls.some((c) => c[0] === "remove" && c[1] === C2));
  });
  delete globalThis.window;
  delete globalThis.location;
}

// ---- 5. wasm source: PickupEvent arm + plumbing ---------------------------
await check("5: the wasm PickupEvent arm keeps a wielder-owned rig (leave-world detach)", () => {
  const objects = readFileSync(joinPath(APP, "src", "session", "messages", "objects.rs"), "utf8");
  const arm = objects.slice(objects.indexOf("GameMessage::PickupEvent(data) => {"));
  const owned = arm.indexOf("let owned = pickup_leave_world_on");
  const sentinel = arm.indexOf("motion_stance: ATTACH_PLACEMENT_LEAVE_WORLD");
  const early = arm.indexOf("return LoopFlow::Continue;");
  const removeLedger = arm.indexOf("js_spawned_guids.remove(");
  assert.ok(owned > 0 && /e\.wielder_id\(\)\.is_some\(\)/.test(arm.slice(owned, sentinel)));
  assert.ok(owned < sentinel && sentinel < early && early < removeLedger,
    "owned branch emits the sentinel and returns before js_spawned_guids.remove");
  assert.match(arm.slice(owned, early), /kind: ENTITY_UPDATE_KIND_ATTACH,[\s\S]*model_id: 0,/);
  const lib = readFileSync(joinPath(APP, "src", "lib.rs"), "utf8");
  assert.match(lib, /const ATTACH_PLACEMENT_LEAVE_WORLD: u32 = 0xFFFF_FFFF;/);
  assert.match(lib, /let pickup_leave_world_on: bool = parse_pickup_leave_world_flag\(&flag_search\(\)\);/);
  assert.match(lib, /"pickupLeaveWorld=off" \| "pickupLeaveWorld=0" \| "pickupLeaveWorld=false"/);
  const mod = readFileSync(joinPath(APP, "src", "session", "mod.rs"), "utf8");
  assert.match(mod, /pub\(crate\) pickup_leave_world_on: bool,/);
});

console.log(`\npickup_leave_world: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
