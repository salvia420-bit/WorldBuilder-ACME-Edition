// tests/death_selection.test.mjs — A2-death round 2 (2026-10-08): the state
// around the death hold on a real EntityManager with fake entities and a fake
// SessionHandle (same harness shape as tests/auto_target.test.mjs).
//   death-2  `isDeathHeld` — what loop.js `_armMotion` reads to turn the
//            server's resurrect Ready (wire cmd 0) into a Ready for the local
//            rig (CPhysics::SetObjectMovement acclient.c:311149-311193).
//   death-3  the selection drops at the server delete of a dying creature
//            whose rig lingers (`releaseSelectionOnServerDelete(g, true)`,
//            ACCWeenieObject::Remove :438580-438606), the next tick
//            auto-targets past it, and cycles skip delete-deferred rigs.
//   death-4  a corpse never claims the LOCAL player's death-held rig.
//   death-5  the unopened-corpse cycle + opened-corpse ledger
//            (CPlayerSystem::SelectNext case 5 :398069-398072, OnAction
//            :399807-399833, SetCorpseOpened :401686-401690, SetCorpseDeleted
//            :390935).
//
// Run from apps/holtburger-web/:  node tests/death_selection.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window ??= {};
globalThis.window.location ??= { search: "" };
globalThis.window.__playEffectVfxBound = true;
globalThis.window.__spellShapePreviewBound = true;

const THREE = await import("three");
const { EntityManager } = await import("../scene3d/entities.js");
const { _resetUseThrottleForTests } = await import("../scene3d/target_cycle.js");

const ME = 0x50000001;
const A = 0x80000a01; // mob @3 m
const B = 0x80000b01; // mob @10 m
const K1 = 0x80001c01; // corpse @2 m
const K2 = 0x80001c02; // corpse @6 m
const CHEST = 0x80001d01; // a chest @4 m
const MOB = { itemType: 0x10, objDescFlags: 0x14 };
const CORPSE = { itemType: 0x200, objDescFlags: 0x2001 };

function makeSession() {
  return {
    mode: 2, // Melee
    uses: [],
    getLocalPlayerPose() { return { x: 0, y: 0, z: 0, heading: 0, landblockId: 0x00000019 }; },
    getCurrentCellId() { return 0x00000019; }, // outdoor → 75 m
    combatMode() { return this.mode; },
    isCharacterOptionEnabled(o) { return o === 0x0d; },
    objectInstanceIdProperty() { return undefined; },
    objectIntProperty(g, s) { return s === 133 ? 2 : undefined; },
    objectDescFlags() { return 0x18; },
    useObject(g) { this.uses.push(g >>> 0); },
    stopStick() {},
    cancelPursuit() {},
  };
}

function addEntity(em, guid, x, meta, extra = {}) {
  const root = new THREE.Group();
  root.position.set(x, 0, 0);
  const inst = {
    guid, root, parts: [], meta: { guid, ...meta },
    _stateVisible: true, _attachedParentGuid: null, _attachedChildren: null,
    dispose() {},
    ...extra,
  };
  em.entityMap.set(guid, inst);
  return inst;
}

function world() {
  const sh = makeSession();
  globalThis.window.__sessionHandle = sh;
  globalThis.window.getLocalPlayerGuid = () => ME;
  const em = new EntityManager({ entitiesGroup: new THREE.Group(), materialCache: null }, {});
  em._autoTargetOn = true;
  em._selectionRangeExitOn = false;
  em._lastCombatMode = sh.mode; // already in this mode: no SetCombatMode edge
  addEntity(em, ME, 0, { itemType: 0x10, objDescFlags: 0x18 });
  addEntity(em, A, 3, MOB);
  addEntity(em, B, 10, MOB);
  const tick = () => em._tickSelectionRules(em._localPlayerWorldPose());
  return { em, sh, tick };
}

const sel = (em) => em.getSelectedTarget();

// ── death-3 ────────────────────────────────────────────────────────────────
test("death-3: the dying creature's server delete drops the selection at once; auto-target skips its rig", () => {
  const { em, tick } = world();
  em._commitSelection(A);
  const a = em.entityMap.get(A);
  a._deathAt = performance.now();
  // loop.js _armRemove, death-deferral path: release, then mark the hold.
  em.releaseSelectionOnServerDelete(A, true);
  a._removePending = true;
  assert.equal(sel(em), 0, "dropped at the delete, not at the deferred remove()");
  assert.equal(em._prevSelectedGuid, A);
  assert.ok(em.entityMap.has(A), "the rig itself still lingers");
  tick();
  assert.equal(sel(em), B, "the next tick auto-targets the next mob, not the dying rig");
  em.releaseSelectionOnServerDelete(A, true); // idempotent
  em.remove(A); // the deferred removal later: nothing to clear
  assert.equal(sel(em), B);
  em.dispose();
});

test("death-3: a corpse-claimed rig is not re-selected either", () => {
  const { em, tick } = world();
  em._commitSelection(A);
  em.entityMap.get(A)._corpseHandoffGuid = 0x80009999;
  em.releaseSelectionOnServerDelete(A, true);
  tick();
  assert.equal(sel(em), B);
  em.dispose();
});

test("death-3: ?deathSelectRelease=off keeps the selection until the rig is removed", () => {
  const { em } = world();
  em._deathSelectReleaseOn = false;
  em._commitSelection(A);
  em.releaseSelectionOnServerDelete(A, true);
  assert.equal(sel(em), A, "deferred release is off");
  em.remove(A); // remove() always releases
  assert.equal(sel(em), 0);
  em.dispose();
});

test("death-3: Tab / closest skip delete-deferred and corpse-claimed rigs", () => {
  const { em, sh } = world();
  sh.mode = 1; // peace: no auto-target
  em.entityMap.get(A)._removePending = true;
  assert.equal(em.cycleTarget("closest", "monster"), B);
  em._commitSelection(0);
  em.entityMap.get(A)._removePending = false;
  em.entityMap.get(A)._corpseHandoffGuid = 0x80009999;
  assert.equal(em.cycleTarget("closest", "monster"), B);
  em.entityMap.get(A)._corpseHandoffGuid = 0;
  em._commitSelection(0);
  assert.equal(em.cycleTarget("closest", "monster"), A, "a live mob is cycled again");
  em.dispose();
});

// ── death-2 ────────────────────────────────────────────────────────────────
test("death-2: isDeathHeld = the CQ-06 death-hold test", () => {
  const { em } = world();
  const me = em.entityMap.get(ME);
  assert.equal(em.isDeathHeld(ME), false);
  me.lastMotionCommand = 0x40000011; // Dead
  assert.equal(em.isDeathHeld(ME), true);
  me.lastMotionCommand = 0x41000003;
  me._unifiedSeq = { deathHold: true };
  assert.equal(em.isDeathHeld(ME), true, "unified death hold");
  me._unifiedSeq = null;
  assert.equal(em.isDeathHeld(ME), false);
  assert.equal(em.isDeathHeld(0x80dead00), false, "unknown guid");
  em.dispose();
});

// ── death-4 ────────────────────────────────────────────────────────────────
test("death-4: the player's own corpse never claims the local rig; a dying creature is claimed", async () => {
  const { em } = world();
  const now = performance.now();
  const me = em.entityMap.get(ME);
  me._deathAt = now;
  me._deathEndAt = now;
  const pc = addEntity(em, 0x80002001, 0, CORPSE); // the player's corpse, d = 0
  em._tryCorpseDeathHandoff(pc);
  assert.equal(me._corpseHandoffGuid, undefined, "the local player is not claimed");
  assert.notEqual(pc._hiddenForHandoff, true, "the corpse shows at once");
  const d = addEntity(em, 0x80000e01, 20.5, MOB, { _deathAt: now, _deathEndAt: now });
  const dc = addEntity(em, 0x80002002, 20, CORPSE);
  em._tryCorpseDeathHandoff(dc);
  assert.equal(d._corpseHandoffGuid, 0x80002002, "a dying creature 0.5 m away is claimed");
  assert.equal(dc._hiddenForHandoff, true);
  await new Promise((r) => setTimeout(r, 20)); // finishReveal (remaining 0)
  assert.equal(em.entityMap.has(0x80000e01), false, "the claimed creature is removed at the reveal");
  assert.equal(dc._hiddenForHandoff, false, "its corpse revealed");
  assert.ok(em.entityMap.has(ME), "the local player rig survives");
  em.dispose();
});

// ── death-5 ────────────────────────────────────────────────────────────────
function corpseWorld() {
  const w = world();
  w.sh.mode = 1; // peace
  addEntity(w.em, K1, 2, CORPSE);
  addEntity(w.em, K2, 6, CORPSE);
  addEntity(w.em, CHEST, 4, { itemType: 0x200, objDescFlags: 0x1 });
  _resetUseThrottleForTests();
  return w;
}

test("death-5: Closest / Next Unopened Corpse cycle corpses only and skip opened ones", () => {
  const { em } = corpseWorld();
  assert.equal(em.unopenedCorpseAction("closest"), K1, "the nearest corpse, not the mob @3 m");
  assert.equal(em.unopenedCorpseAction("next"), K2, "one step outward");
  assert.equal(em.unopenedCorpseAction("next"), K1, "nothing farther → wraps to the closest");
  em.noteContainerOpened(K1);
  assert.equal(em.hasCorpseBeenOpened(K1), true);
  em._commitSelection(0);
  assert.equal(em.unopenedCorpseAction("closest"), K2, "an opened corpse drops out");
  em.noteContainerOpened(CHEST);
  assert.equal(em.hasCorpseBeenOpened(CHEST), false, "only corpses are recorded");
  em.noteWireRemove(K1); // the server deleted it (SetCorpseDeleted)
  assert.equal(em.hasCorpseBeenOpened(K1), false);
  em.noteContainerOpened(K2);
  em.clearWorldEntities();
  assert.equal(em._openedCorpses.size, 0, "session reset clears the ledger");
  em.dispose();
});

test("death-5: the Use variants Use the selected corpse (throttled), even when nothing new was found", () => {
  const { em, sh } = corpseWorld();
  assert.equal(em.unopenedCorpseAction("closest", sh), K1);
  assert.deepEqual(sh.uses, [K1]);
  em.unopenedCorpseAction("closest", sh);
  assert.deepEqual(sh.uses, [K1], "the 0.2 s use throttle drops the repeat");
  _resetUseThrottleForTests();
  em.noteContainerOpened(K1);
  em.noteContainerOpened(K2);
  assert.equal(em.unopenedCorpseAction("closest", sh), K1, "no unopened corpse: the selection stays");
  assert.deepEqual(sh.uses, [K1, K1], "retail still Uses the selected corpse");
  _resetUseThrottleForTests();
  em._commitSelection(A);
  em.unopenedCorpseAction("next", sh);
  assert.equal(sel(em), A);
  assert.deepEqual(sh.uses, [K1, K1], "a selected mob is never Used");
  em.dispose();
});
