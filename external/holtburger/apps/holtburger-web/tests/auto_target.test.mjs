// tests/auto_target.test.mjs — A3-selection (2026-10-08) selection rules on a
// real EntityManager with fake entities and a fake SessionHandle:
//   selection-2 retail combat auto-target (`?autoTarget`):
//     ClientCombatSystem::RecvNotice_SelectionChanged (acclient.c:408741),
//     ::AutoTarget (:408690), ::SetCombatMode (:408881-408901), the defender
//     tails (:409335-409345 / :409956-409964) and the Escape willingly-lost
//     mark (ClientUISystem::OnAction :402199-402203). Mirrors OpenAC
//     RuntimeCombatTargetStateTests (+ the 15 s attacker rule OpenAC skips).
//   selection-1 retail Next/Previous Monster + prevSelected anchor.
//   selection-4 the 1 s range-exit drop (`?selectionRangeExit`).
//   selection-6 the wielded-item attack redirect (`attackTargetFor`).
//
// Run from apps/holtburger-web/:  node tests/auto_target.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

globalThis.window ??= {};
globalThis.window.location ??= { search: "" };
globalThis.window.__playEffectVfxBound = true;
globalThis.window.__spellShapePreviewBound = true;

const THREE = await import("three");
const { EntityManager } = await import("../scene3d/entities.js");
const { autoTargetChoice } = await import("../scene3d/target_cycle.js");

const ME = 0x50000001;
const A = 0x80000a01; // mob @3 m
const B = 0x80000b01; // mob @10 m
const C = 0x80000c01; // mob @50 m
const F = 0x80000f01; // mob @100 m — beyond the 75 m radar range
const N = 0x80000e01; // town NPC @4 m (not attackable)
const W = 0x80000d01; // C's wielded sword
const MOB = { itemType: 0x10, objDescFlags: 0x14 };

function makeSession() {
  return {
    mode: 2, // Melee
    autoTarget: true,
    attacker: 0,
    iids: new Map(),
    radar: new Map(),
    getLocalPlayerPose() { return { x: 0, y: 0, z: 0, heading: 0, landblockId: 0x00000019 }; },
    getCurrentCellId() { return 0x00000019; }, // outdoor → 75 m
    combatMode() { return this.mode; },
    isCharacterOptionEnabled(o) { return o === 0x0d ? this.autoTarget : false; },
    objectInstanceIdProperty(g, s) {
      if (g === ME && s === 11) return this.attacker || undefined;
      return this.iids.get(`${g >>> 0}:${s}`);
    },
    objectIntProperty(g, s) { return s === 133 ? (this.radar.get(g >>> 0) ?? 2) : undefined; },
    objectDescFlags() { return 0x18; },
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
  em._selectionRangeExitOn = true;
  em._lastCombatMode = sh.mode; // already in this mode: no SetCombatMode edge
  addEntity(em, ME, 0, { itemType: 0x10, objDescFlags: 0x18 });
  addEntity(em, A, 3, MOB);
  addEntity(em, B, 10, MOB);
  addEntity(em, C, 50, MOB);
  addEntity(em, F, 100, MOB);
  addEntity(em, N, 4, { itemType: 0x10, objDescFlags: 0x04 });
  const tick = () => em._tickSelectionRules(em._localPlayerWorldPose());
  return { em, sh, tick };
}

const sel = (em) => em.getSelectedTarget();

// ── pure decision (target_cycle.js autoTargetChoice) ──────────────────────
test("autoTargetChoice: melee/missile + option → closest; magic/peace/option off → none", () => {
  const base = { autoTargetOn: true, willinglyLost: false, attackerGuid: 0, attackerLive: false, msSinceAttacked: Infinity };
  assert.equal(autoTargetChoice({ ...base, combatMode: 2 }), "closest");
  assert.equal(autoTargetChoice({ ...base, combatMode: 4 }), "closest");
  assert.equal(autoTargetChoice({ ...base, combatMode: 8 }), "none");
  assert.equal(autoTargetChoice({ ...base, combatMode: 1 }), "none");
  assert.equal(autoTargetChoice({ ...base, combatMode: 2, autoTargetOn: false }), "none");
});

test("autoTargetChoice: a live attacker within 15 s wins; 16 s or gone → closest; mark → consume", () => {
  const base = { combatMode: 2, autoTargetOn: true, willinglyLost: false, attackerGuid: C };
  assert.equal(autoTargetChoice({ ...base, attackerLive: true, msSinceAttacked: 10000 }), "attacker");
  assert.equal(autoTargetChoice({ ...base, attackerLive: true, msSinceAttacked: 16000 }), "closest");
  assert.equal(autoTargetChoice({ ...base, attackerLive: false, msSinceAttacked: 1000 }), "closest");
  assert.equal(autoTargetChoice({ ...base, willinglyLost: true, attackerLive: true, msSinceAttacked: 0 }), "consume-mark");
});

// ── EntityManager wiring ──────────────────────────────────────────────────
test("a despawned target in melee is replaced by the closest hostile one tick later", () => {
  const { em, tick } = world();
  em._commitSelection(B);
  em.remove(B);
  assert.equal(sel(em), 0, "cleared at once (F16-4)");
  tick();
  assert.equal(sel(em), A, "closest attackable in radar range (the NPC is skipped)");
  em.dispose();
});

test("a dynamic-LOD respawn of the selected guid is re-selected, not replaced", () => {
  const { em, tick } = world();
  em._commitSelection(B);
  const inst = em.entityMap.get(B);
  em.spawnInFlight.set(B, Promise.resolve(null));
  em.remove(B);
  tick();
  assert.equal(sel(em), 0, "waits while the respawn is in flight");
  em.entityMap.set(B, inst);
  em.spawnInFlight.delete(B);
  tick();
  assert.equal(sel(em), B);
  em.dispose();
});

test("a willing deselect skips exactly one auto-target", () => {
  const { em } = world();
  em._commitSelection(B);
  em.deselectTarget();
  assert.equal(sel(em), 0, "Escape-style deselect stays empty");
  em._commitSelection(B);
  em._commitSelection(0);
  assert.equal(sel(em), A, "the mark was consumed by the first notice");
  em.dispose();
});

test("the current attacker is preferred for 15 s, then the closest", () => {
  const { em, sh } = world();
  sh.attacker = C;
  em.noteAttacked();
  assert.equal(sel(em), C, "hit with nothing selected → the attacker");
  em._commitSelection(B);
  em.noteAttacked();
  assert.equal(sel(em), B, "a hit never replaces an existing selection");
  em._lastAttackedAt = performance.now() - 16000;
  em._commitSelection(0);
  assert.equal(sel(em), A, "16 s later the attacker is stale → closest");
  em.dispose();
});

test("no auto-target in magic or peace mode, with the option off, or with ?autoTarget=off", () => {
  for (const [mode, opt, flag] of [[8, true, true], [1, true, true], [2, false, true], [2, true, false]]) {
    const { em, sh } = world();
    sh.mode = mode;
    sh.autoTarget = opt;
    em._autoTargetOn = flag;
    em._commitSelection(B);
    em._commitSelection(0);
    assert.equal(sel(em), 0, `mode ${mode} option ${opt} flag ${flag}`);
    em.dispose();
  }
});

test("entering melee clears a non-attackable selection and auto-targets", () => {
  const { em, sh, tick } = world();
  sh.mode = 1;
  tick();
  em._commitSelection(N);
  sh.mode = 2;
  tick();
  assert.equal(sel(em), A);
  em.dispose();
});

test("entering melee with a monster's weapon selected re-selects the wielder", () => {
  const { em, sh, tick } = world();
  addEntity(em, W, 0, { itemType: 0x1, objDescFlags: 0x12 }, { _attachedParentGuid: C });
  sh.mode = 1;
  tick();
  em._commitSelection(W);
  sh.mode = 2;
  tick();
  assert.equal(sel(em), C);
  em.dispose();
});

test("attackTargetFor: weapon → wielder, own item → 0, mob → itself, ?attackWielder=off → item", () => {
  const { em, sh } = world();
  addEntity(em, W, 0, { itemType: 0x1, objDescFlags: 0x12 }, { _attachedParentGuid: C });
  assert.equal(em.attackTargetFor(W), C);
  assert.equal(em.attackTargetFor(B), B);
  assert.equal(em.attackTargetFor(0), 0);
  sh.iids.set(`${W}:3`, ME);
  assert.equal(em.attackTargetFor(W), 0, "wielded by me");
  sh.iids.delete(`${W}:3`);
  em._attackWielderOn = false;
  assert.equal(em.attackTargetFor(W), W);
  em.dispose();
});

test("range exit: beyond radar range AND off screen drops the selection (1 s cadence)", () => {
  const { em, sh, tick } = world();
  sh.mode = 1; // peace: no auto-target follows
  em._commitSelection(C);
  const c = em.entityMap.get(C);
  c.root.position.set(80, 0, 0);
  c.root.visible = true;
  em._selRangeNextAt = 0;
  tick();
  assert.equal(sel(em), C, "still drawn on screen → kept");
  c.root.visible = false;
  tick();
  assert.equal(sel(em), C, "waits for the next 1 s check");
  em._selRangeNextAt = 0;
  sh.iids.set(`${C}:2`, ME);
  tick();
  assert.equal(sel(em), C, "an owned object is never range-checked");
  sh.iids.delete(`${C}:2`);
  em._selRangeNextAt = 0;
  tick();
  assert.equal(sel(em), 0, "out of range and off screen → dropped");
  em._selectionRangeExitOn = false;
  em._commitSelection(C);
  em._selRangeNextAt = 0;
  tick();
  assert.equal(sel(em), C, "?selectionRangeExit=off keeps it");
  em.dispose();
});

test("cycle: retail Next/Previous, radar range, off-list and previous-selection anchors", () => {
  const { em, sh } = world();
  sh.mode = 1;
  assert.equal(em.cycleTarget("next", "monster"), C, "unanchored Next → farthest in range (F@100 is out)");
  assert.equal(em.cycleTarget("next", "monster"), A, "outward from the farthest wraps to the nearest");
  assert.equal(em.cycleTarget("next", "monster"), B);
  assert.equal(em.cycleTarget("previous", "monster"), A, "Previous steps inward");
  assert.equal(em.cycleTarget("previous", "monster"), C, "…and wraps to the farthest");
  em._commitSelection(N);
  assert.equal(em.cycleTarget("next", "monster"), B, "NPC @4 m anchors: first mob farther");
  em._commitSelection(N);
  assert.equal(em.cycleTarget("previous", "monster"), A, "…first mob not farther");
  em._commitSelection(B);
  em.deselectTarget();
  assert.equal(em.cycleTarget("next", "monster"), C, "nothing selected → anchored on the previous selection");
  sh.radar.set(C, 1); // ShowNever
  em._commitSelection(0);
  em._prevSelectedGuid = 0;
  assert.equal(em.cycleTarget("next", "monster"), B, "radar-hidden mobs are not cycled");
  em._retailSelectNextOn = false;
  em._cycleRadarFilterOn = false;
  em._commitSelection(0);
  assert.equal(em.cycleTarget("next", "monster"), A, "=off: the legacy dispatch (unanchored Next → nearest)");
  em.dispose();
});

test("wiring: despawn notice, attacked subscription, flag readers", () => {
  const ent = readFileSync(new URL("../scene3d/entities.js", import.meta.url), "utf8");
  const idx = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const rm = ent.slice(ent.indexOf("F16-4 — clear the selected target"));
  assert.match(rm.slice(0, 1500), /this\._selRemovedGuid = g;/);
  assert.match(ent, /get\("autoTarget"\)/);
  assert.match(ent, /get\("attackWielder"\)/);
  assert.match(ent, /if \(prev !== 0 && \(\(this\._selectedGuid >>> 0\) \|\| 0\) === 0\) \{\s*this\._autoTarget\("notice"\);/);
  assert.match(idx, /pluginClient\.events\.on\("damageTaken", __onAttacked\);/);
  assert.match(idx, /pluginClient\.events\.on\("evadedAttacker", __onAttacked\);/);
  assert.match(idx, /entityManager\?\.noteAttacked\?\.\(\)/);
});
