// tests/selection_keys.test.mjs — input-options-7 (2026-10-13): the rest of
// retail's keyboard selection commands (CPlayerSystem::OnAction,
// acclient.c:399450).
//
//   [1] pure choices (scene3d/target_cycle.js): the ITEM / COMPASS_ITEM
//       SelectNext filters (acclient.c:398090-398117), Select Last Attacker
//       (:399749-399788 + ObjectIsWithinRadarRange :398216), Previous
//       Selection (:399687-399691) and the fellow walk
//       (ClientFellowshipSystem::SelectNext/PreviousFellow :406174 / :406239).
//   [2] ui/selection_keys.js on a real InputFunnel: the actions are keyed by
//       their ClientAction ids (Controls rows go live), dispatch to the right
//       EntityManager call, [ / ] stand down in magic stance, ?targetCycle=off
//       binds nothing; every key yields to a focused HUD control that owns
//       it and to the open radial menu (review I-ui-input-R2).
//   [3] a real EntityManager with fake entities and a fake SessionHandle
//       (same harness as tests/auto_target.test.mjs).
//   [4] static wiring: index.html installs the keys; the keymap.js comment no
//       longer claims retail binds Next Monster to Tab.
//
// Run from apps/holtburger-web/:  node tests/selection_keys.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const APP = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolvePath(APP, "..", "..");

class MemStorage {
  constructor() { this.m = new Map(); }
  get length() { return this.m.size; }
  key(i) { return [...this.m.keys()][i] ?? null; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}
globalThis.window ??= {};
globalThis.window.location ??= { search: "" };
globalThis.window.__playEffectVfxBound = true;
globalThis.window.__spellShapePreviewBound = true;
globalThis.localStorage ??= new MemStorage();

const THREE = await import("three");
const { EntityManager } = await import("../scene3d/entities.js");
const TC = await import("../scene3d/target_cycle.js");
const { InputFunnel } = await import("../ui/input-funnel.js");
const K = await import("../ui/keymap.js");
const SK = await import("../ui/selection_keys.js");

const { SELECTION_TYPE, cycleCandidateOk, matchesSelectionType } = TC;

const ODF_ATTACK = 0x10;
const ODF_PLAYER = 0x08;
const ODF_CORPSE = 0x2000;
const ODF_HIDDEN = 0x80;
const ODF_VENDOR = 0x200;
const ODF_LIFESTONE = 0x4000;
const ODF_PORTAL = 0x40000;
const CREATURE = 0x10;

// ── [1] pure choices ─────────────────────────────────────────────────────
const base = { playerMeta: { objDescFlags: 0x08 }, isFellow: false, stateVisible: true,
  attached: false, dist2d: 10, range: 75, showable: false };
const okFor = (meta, over, type) => cycleCandidateOk(meta, { ...base, ...over }, type);

test("ITEM: a loose object with no RadarBehavior is an item", () => {
  const I = SELECTION_TYPE.ITEM;
  const sword = { itemType: 0x1, objDescFlags: 0 };
  assert.equal(okFor(sword, { radarBehavior: 0, wielder: 0 }, I), true);
  assert.equal(okFor(sword, { radarBehavior: undefined, wielder: undefined }, I), true, "absent = 0");
  assert.equal(okFor(sword, { radarBehavior: () => 0, wielder: () => 0 }, I), true, "thunks");
  assert.equal(okFor(sword, { radarBehavior: 0, wielder: 0x50000001 }, I), false, "wielded");
  assert.equal(okFor(sword, { radarBehavior: 0, attached: true }, I), false, "mounted on a wielder");
  assert.equal(okFor(sword, { radarBehavior: 0, dist2d: 76 }, I), false, "beyond radar range");
  assert.equal(okFor(sword, { radarBehavior: 0, stateVisible: false }, I), false, "not drawn");
  assert.equal(okFor({ itemType: 0x1, objDescFlags: ODF_HIDDEN }, { radarBehavior: 0 }, I), false, "UI-hidden");
});

test("ITEM: anything on radar is out unless it is a lifestone/portal/bindstone; corpses are not tested", () => {
  const I = SELECTION_TYPE.ITEM;
  assert.equal(okFor({ itemType: CREATURE, objDescFlags: ODF_ATTACK }, { radarBehavior: 2 }, I), false, "monster");
  assert.equal(okFor({ itemType: CREATURE, objDescFlags: 0x04 }, { radarBehavior: 4 }, I), false, "NPC");
  assert.equal(okFor({ itemType: CREATURE, objDescFlags: 0 }, { radarBehavior: 1 }, I), false, "pet (ShowNever 1)");
  assert.equal(okFor({ itemType: 0x10000000, objDescFlags: ODF_LIFESTONE }, { radarBehavior: 4 }, I), true, "lifestone");
  assert.equal(okFor({ itemType: 0x10000, objDescFlags: ODF_PORTAL }, { radarBehavior: 4 }, I), true, "portal");
  assert.equal(okFor({ itemType: 0x200, objDescFlags: ODF_CORPSE }, { radarBehavior: 0 }, I), true,
    "a corpse (retail case 1 has no corpse test)");
});

test("ITEM: the wasm lookups run only for ITEM candidates", () => {
  let calls = 0;
  const thunk = () => { calls++; return 0; };
  okFor({ itemType: CREATURE, objDescFlags: ODF_ATTACK }, { wielder: thunk, radarBehavior: thunk, showable: true },
    SELECTION_TYPE.MONSTER);
  okFor({ itemType: CREATURE, objDescFlags: 0x04 }, { wielder: thunk, radarBehavior: thunk, showable: true },
    SELECTION_TYPE.COMPASS_ITEM);
  assert.equal(calls, 0);
});

test("COMPASS_ITEM outside melee/missile: shown on radar or a lifestone/portal/bindstone", () => {
  const C = SELECTION_TYPE.COMPASS_ITEM;
  assert.equal(okFor({ itemType: CREATURE, objDescFlags: 0x04 }, { showable: true }, C), true, "NPC on radar");
  assert.equal(okFor({ itemType: 0x1, objDescFlags: 0 }, { showable: false }, C), false, "ground item");
  assert.equal(okFor({ itemType: 0x10000, objDescFlags: ODF_PORTAL }, { showable: false }, C), true, "portal");
  assert.equal(okFor({ itemType: CREATURE, objDescFlags: ODF_VENDOR }, { showable: true }, C), true, "vendor");
  assert.equal(okFor({ itemType: CREATURE, objDescFlags: 0x04 | ODF_HIDDEN }, { showable: true }, C), false, "UI-hidden");
  assert.equal(okFor({ itemType: CREATURE, objDescFlags: 0x04 }, { showable: true, dist2d: 80 }, C), false, "range");
});

test("COMPASS_ITEM in melee/missile: the COMPASS_COMBAT rule", () => {
  const C = SELECTION_TYPE.COMPASS_ITEM;
  const mob = { itemType: CREATURE, objDescFlags: ODF_ATTACK };
  assert.equal(okFor(mob, { showable: true, meleeOrMissile: true }, C), true);
  assert.equal(okFor({ itemType: CREATURE, objDescFlags: 0x04 }, { showable: true, meleeOrMissile: true }, C), false,
    "a non-attackable NPC");
  assert.equal(okFor(mob, { showable: true, meleeOrMissile: true, isFellow: true }, C), false, "a fellow");
  assert.equal(okFor({ itemType: CREATURE, objDescFlags: ODF_ATTACK | ODF_VENDOR }, { showable: true, meleeOrMissile: true }, C),
    false, "a vendor");
  assert.equal(okFor({ itemType: 0x10000, objDescFlags: ODF_PORTAL }, { showable: false, meleeOrMissile: true }, C), false,
    "a portal is not attackable");
});

test("matchesSelectionType (?cycleRadarFilter=off): ITEM / COMPASS_ITEM type-only rules", () => {
  const I = SELECTION_TYPE.ITEM;
  const C = SELECTION_TYPE.COMPASS_ITEM;
  assert.equal(matchesSelectionType({ itemType: 0x1, objDescFlags: 0 }, I), true, "a sword");
  assert.equal(matchesSelectionType({ itemType: CREATURE, objDescFlags: ODF_ATTACK }, I), false, "a creature");
  assert.equal(matchesSelectionType({ itemType: 0, objDescFlags: ODF_PLAYER }, I), false, "a player");
  assert.equal(matchesSelectionType({ itemType: 0x10000, objDescFlags: ODF_PORTAL }, I), true, "a portal");
  assert.equal(matchesSelectionType({ itemType: 0x1, objDescFlags: ODF_HIDDEN }, I), false, "UI-hidden");
  assert.equal(matchesSelectionType(null, I), false, "no meta");
  assert.equal(matchesSelectionType({ itemType: CREATURE, objDescFlags: 0x04 }, C), true, "NPC");
  assert.equal(matchesSelectionType({ itemType: 0x1, objDescFlags: 0 }, C), false, "sword");
  assert.equal(matchesSelectionType({ itemType: CREATURE, objDescFlags: 0x04 }, C, { meleeOrMissile: true }), false,
    "melee: a non-attackable NPC");
  assert.equal(matchesSelectionType({ itemType: CREATURE, objDescFlags: ODF_ATTACK }, C, { meleeOrMissile: true }), true,
    "melee: a monster");
  assert.equal(matchesSelectionType({ itemType: CREATURE, objDescFlags: ODF_ATTACK | ODF_CORPSE }, C), false, "a corpse");
});

test("radarBehaviorFor: the raw int 133, absent = 0, stale pkg → heuristic", () => {
  const sh = (v) => ({ objectIntProperty: (g, s) => (s === 133 ? v : undefined) });
  assert.equal(TC.radarBehaviorFor(sh(undefined), 1, 0, 1), 0);
  assert.equal(TC.radarBehaviorFor(sh(null), 1, 0, 1), 0);
  assert.equal(TC.radarBehaviorFor(sh(2), 1, 0, CREATURE), 2);
  assert.equal(TC.radarBehaviorFor({ objectIntProperty() { throw new Error("x"); } }, 1, 0, 1), 0);
  assert.equal(TC.radarBehaviorFor(null, 1, 0, CREATURE), 4, "stale pkg: a creature reads as shown");
  assert.equal(TC.radarBehaviorFor({}, 1, 0, 0x1), 0, "stale pkg: a sword reads as hidden");
});

test("lastAttackerChoice: none → none; out of radar range → none; in range → the attacker", () => {
  assert.equal(TC.lastAttackerChoice({ attackerGuid: 0, inRadarRange: true }), 0);
  assert.equal(TC.lastAttackerChoice({ attackerGuid: 0x80000c01, inRadarRange: false }), 0);
  assert.equal(TC.lastAttackerChoice({ attackerGuid: 0x80000c01, inRadarRange: true }), 0x80000c01);
  assert.equal(TC.objectWithinRadarRange({ xyDist: 74.9, range: 75 }), true);
  assert.equal(TC.objectWithinRadarRange({ xyDist: 75, range: 75 }), false, "strictly inside (radius > dist)");
  assert.equal(TC.objectWithinRadarRange({ xyDist: NaN, range: 75 }), false);
});

test("previousSelectionChoice: 0 → nothing; the current one → nothing; gone → nothing", () => {
  assert.equal(TC.previousSelectionChoice({ prevGuid: 0, selectedGuid: 5, prevLive: true }), 0);
  assert.equal(TC.previousSelectionChoice({ prevGuid: 5, selectedGuid: 5, prevLive: true }), 0);
  assert.equal(TC.previousSelectionChoice({ prevGuid: 7, selectedGuid: 5, prevLive: false }), 0);
  assert.equal(TC.previousSelectionChoice({ prevGuid: 7, selectedGuid: 5, prevLive: true }), 7);
  assert.equal(TC.previousSelectionChoice({ prevGuid: 7, selectedGuid: 0, prevLive: true }), 7);
});

test("fellowCycleChoice: the retail table walk", () => {
  const F = [1, 2, 3];
  assert.equal(TC.fellowCycleChoice(F, 0, true), 1, "next, no fellow selected → first");
  assert.equal(TC.fellowCycleChoice(F, 1, true), 2);
  assert.equal(TC.fellowCycleChoice(F, 3, true), 1, "next wraps");
  assert.equal(TC.fellowCycleChoice(F, 99, true), 1, "next from a non-fellow → first");
  assert.equal(TC.fellowCycleChoice(F, 0, false), 3, "previous, none selected → last");
  assert.equal(TC.fellowCycleChoice(F, 2, false), 1);
  assert.equal(TC.fellowCycleChoice(F, 1, false), 3, "previous wraps");
  assert.equal(TC.fellowCycleChoice(F, 99, false), 3, "previous from a non-fellow → last");
  assert.equal(TC.fellowCycleChoice([], 1, true), 0);
  assert.equal(TC.fellowCycleChoice(null, 1, false), 0);
  assert.equal(TC.fellowCycleChoice([4], 4, true), 4, "a lone member stays selected");
  assert.equal(TC.fellowCycleChoice(new Set([1, 2]), 2, true), 1, "any iterable");
});

// ── [2] ui/selection_keys.js on a real InputFunnel ───────────────────────
function keyEv(code, mods = {}) {
  return {
    code, key: code, shiftKey: !!mods.shift, ctrlKey: !!mods.ctrl, altKey: !!mods.alt, metaKey: false,
    repeat: !!mods.repeat, target: null, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  };
}
function fakeEm() {
  const calls = [];
  const rec = (name) => (...args) => { calls.push([name, ...args]); return 0; };
  return {
    calls,
    cycleTarget: rec("cycleTarget"),
    selectSelf: rec("selectSelf"),
    selectPrevious: rec("selectPrevious"),
    selectLastAttacker: rec("selectLastAttacker"),
    selectFellow: rec("selectFellow"),
  };
}

test("the table: retail ids, retail defaults where free, unbound Select Self / Next Fellow", () => {
  const ui = readFileSync(resolvePath(REPO, "crates/holtburger-common/src/properties/ui.rs"), "utf8");
  const enumBody = ui.slice(ui.indexOf("pub enum ClientAction"), ui.indexOf("}", ui.indexOf("pub enum ClientAction")));
  const ids = new Set([...enumBody.matchAll(/=\s*0x([0-9A-Fa-f]{8})/g)].map((x) => Number.parseInt(x[1], 16)));
  const rows = SK.SELECTION_KEY_ACTIONS;
  assert.equal(new Set(rows.map((r) => r.action)).size, rows.length, "unique ids");
  for (const r of rows) assert.ok(ids.has(r.action), `0x${r.action.toString(16)} is a ClientAction`);
  const def = (id) => rows.find((r) => r.action === id)?.defaultBinding;
  assert.equal(def(0x1000002E), "KeyP");
  assert.equal(def(0x10000038), "Home");
  assert.deepEqual([def(0x1000002F), def(0x10000030), def(0x10000031)], ["Backspace", "Minus", "Equal"]);
  assert.deepEqual([def(0x10000032), def(0x10000033), def(0x10000034)], ["Backslash", "BracketLeft", "BracketRight"]);
  assert.deepEqual([def(0x10000039), def(0x1000003A), def(0x1000003B)], ["Slash", "Comma", "Period"]);
  assert.equal(def(0x1000003C), "KeyN");
  assert.equal(def(0x1000003D), null, "M is the world map here");
  assert.equal(def(0x1000002A), null, "no retail default");
  assert.ok(!rows.some((r) => [0x10000035, 0x10000036, 0x10000037, 0x1000003E, 0x1000003F].includes(r.action)),
    "the monster / corpse keys stay with index.html");
  // The table spells the SELECTION_TYPE values out (no scene3d import).
  assert.deepEqual([SELECTION_TYPE.ITEM, SELECTION_TYPE.COMPASS_ITEM, SELECTION_TYPE.PLAYER],
    ["item", "compassItem", "player"]);
});

test("the defaults collide with no live LOCAL_ACTIONS or hard-coded key", () => {
  for (const r of SK.SELECTION_KEY_ACTIONS) {
    if (!r.defaultBinding) continue;
    const hits = K.findConflictingBindings(r.defaultBinding, false, false, false, false);
    assert.deepEqual(hits, [], `${r.label} (${r.defaultBinding}) conflicts: ${JSON.stringify(hits)}`);
  }
});

test("installSelectionKeys binds every action under its retail id and dispatches", () => {
  const funnel = new InputFunnel();
  const em = fakeEm();
  let magic = false;
  const off = SK.installSelectionKeys(funnel, { getEntityManager: () => em, inMagicStance: () => magic, search: "" });
  const hashes = funnel.actions.map((a) => a.labelHash);
  assert.ok(hashes.includes("0x1000002E"), "Previous Selection");
  assert.ok(hashes.includes("0x10000038"), "Last Attacker");
  assert.equal(hashes.length, SK.SELECTION_KEY_ACTIONS.length);

  const press = (code, mods) => { em.calls.length = 0; const ev = keyEv(code, mods); funnel.handleKeyDown(ev); return ev; };
  let ev = press("KeyP");
  assert.deepEqual(em.calls, [["selectPrevious"]]);
  assert.equal(ev.defaultPrevented, true);
  press("Home");
  assert.deepEqual(em.calls, [["selectLastAttacker"]]);
  press("Slash");
  assert.deepEqual(em.calls, [["cycleTarget", "closest", "player"]]);
  press("Comma");
  assert.deepEqual(em.calls, [["cycleTarget", "previous", "player"]]);
  press("Period");
  assert.deepEqual(em.calls, [["cycleTarget", "next", "player"]]);
  press("Backslash");
  assert.deepEqual(em.calls, [["cycleTarget", "closest", "item"]]);
  press("BracketRight");
  assert.deepEqual(em.calls, [["cycleTarget", "next", "item"]]);
  press("Backspace");
  assert.deepEqual(em.calls, [["cycleTarget", "closest", "compassItem"]]);
  press("Minus");
  assert.deepEqual(em.calls, [["cycleTarget", "previous", "compassItem"]]);
  press("Equal");
  assert.deepEqual(em.calls, [["cycleTarget", "next", "compassItem"]]);
  press("KeyN");
  assert.deepEqual(em.calls, [["selectFellow", false]]);
  press("KeyM");
  assert.deepEqual(em.calls, [], "Next Fellow is unbound by default");
  press("KeyP", { shift: true });
  assert.deepEqual(em.calls, [], "modifiers must match");
  press("KeyP", { repeat: true });
  assert.deepEqual(em.calls, [], "a held key fires once");

  magic = true;
  ev = press("BracketLeft");
  assert.deepEqual(em.calls, [], "[ stands down in magic stance (combat-bar's spell-tab alias)");
  assert.equal(ev.defaultPrevented, false);
  press("KeyP");
  assert.deepEqual(em.calls, [["selectPrevious"]], "the rest still work in magic stance");
  magic = false;
  press("BracketLeft");
  assert.deepEqual(em.calls, [["cycleTarget", "previous", "item"]]);

  // Unbound rows go live once the player binds them in Options → Controls.
  K.setBinding("0x1000002A", { code: "KeyY" });
  K.setBinding("0x1000003D", { code: "KeyM", shift: true });
  press("KeyY");
  assert.deepEqual(em.calls, [["selectSelf"]]);
  press("KeyM", { shift: true });
  assert.deepEqual(em.calls, [["selectFellow", true]]);
  K.clearBinding("0x1000002A");
  K.clearBinding("0x1000003D");

  off();
  assert.equal(funnel.actions.length, 0, "unbind retires every action");
  press("KeyP");
  assert.deepEqual(em.calls, []);
});

test("the Controls rows go live through the funnel (retailActionStatus)", () => {
  const funnel = new InputFunnel();
  SK.installSelectionKeys(funnel, { getEntityManager: () => null, search: "" });
  const s = K.retailActionStatus(0x1000002E, { funnelActions: funnel.actions });
  assert.equal(s.status, "rebindable");
  assert.equal(s.source, "funnel");
  assert.equal(s.bindingId, "0x1000002E");
  assert.equal(s.binding?.code, "KeyP");
  const self = K.retailActionStatus(0x1000002A, { funnelActions: funnel.actions });
  assert.equal(self.status, "rebindable", "Select Self is bindable though unbound");
  assert.equal(self.binding, null);
  assert.equal(K.retailActionStatus(0x1000002E, { funnelActions: [] }).status, "unavailable",
    "without the funnel rows the action is not live");
});

test("?targetCycle=off binds nothing; no entity manager → the key is consumed quietly", () => {
  const funnel = new InputFunnel();
  const off = SK.installSelectionKeys(funnel, { getEntityManager: () => null, search: "?targetCycle=off" });
  assert.equal(funnel.actions.length, 0);
  off();
  assert.equal(SK.targetCycleOn("?targetCycle=OFF"), false);
  assert.equal(SK.targetCycleOn("?targetCycle=0"), true, "only =off, like entities.js");
  assert.equal(SK.targetCycleOn(""), true);
  const f2 = new InputFunnel();
  SK.installSelectionKeys(f2, { getEntityManager: () => null, search: "" });
  assert.doesNotThrow(() => f2.handleKeyDown(keyEv("KeyP")));
  assert.equal(SK.installSelectionKeys(null)(), undefined, "no funnel → a no-op unbind");
});

test("review I-ui-input-R2: the keys stand down while a focused HUD control or the radial menu owns them", () => {
  const funnel = new InputFunnel();
  const em = fakeEm();
  const off = SK.installSelectionKeys(funnel, { getEntityManager: () => em, inMagicStance: () => false, search: "" });
  const control = (attrs) => ({
    isConnected: true,
    getAttribute: (n) => (Object.prototype.hasOwnProperty.call(attrs, n) ? attrs[n] : null),
  });
  const press = (code, target = null) => {
    em.calls.length = 0;
    const ev = keyEv(code);
    ev.target = target;
    funnel.handleKeyDown(ev);
    return ev;
  };

  // (a) tinker 'Use' drop target (role=button div, tabIndex 0) clears on Backspace.
  const tinkerSlot = control({ tabindex: "0", role: "button" });
  let ev = press("Backspace", tinkerSlot);
  assert.deepEqual(em.calls, [], "Backspace belongs to the focused slot, not Select Closest Compass Item");
  assert.equal(ev.defaultPrevented, false, "left unclaimed for the slot's own keydown");
  ev = press("KeyP", tinkerSlot);
  assert.deepEqual(em.calls, [["selectPrevious"]], "a printable selection key still works with a control focused");
  // Options tab strip (native <button role=tab>) and the Spell Research list
  // overlay (tabIndex -1) own Home.
  press("Home", control({ role: "tab" }));
  assert.deepEqual(em.calls, [], "Home walks the Options tabs");
  press("Home", control({ tabindex: "-1" }));
  assert.deepEqual(em.calls, [], "Home jumps the Spell Research list");
  // A native <button> merely left focused by a mouse click is not a key owner.
  press("Home", control({}));
  assert.deepEqual(em.calls, [["selectLastAttacker"]]);
  // A detached control (panel torn down mid-focus) owns nothing.
  press("Backspace", { ...tinkerSlot, isConnected: false });
  assert.deepEqual(em.calls, [["cycleTarget", "closest", "compassItem"]]);

  // (b) radial menu open: type-ahead (P N , . - =) and Home are the menu's.
  globalThis.window.__radialMenuOpen = true;
  try {
    for (const code of ["KeyP", "KeyN", "Comma", "Period", "Minus", "Equal", "Home", "Backslash", "Slash"]) {
      ev = press(code);
      assert.deepEqual(em.calls, [], `${code} stays with the open radial menu`);
      assert.equal(ev.defaultPrevented, false, `${code} unclaimed`);
    }
  } finally {
    globalThis.window.__radialMenuOpen = false;
  }
  press("KeyP");
  assert.deepEqual(em.calls, [["selectPrevious"]], "back to normal once the menu closes");
  off();
});

test("review I-ui-input-R2: an injected hudOwnsKey sees the keydown; magic-stance scope still applies", () => {
  const funnel = new InputFunnel();
  const em = fakeEm();
  const seen = [];
  SK.installSelectionKeys(funnel, {
    getEntityManager: () => em,
    inMagicStance: () => true,
    hudOwnsKey: (ev) => { seen.push(ev?.code); return false; },
    search: "",
  });
  em.calls.length = 0;
  funnel.handleKeyDown(keyEv("KeyP"));
  assert.ok(seen.includes("KeyP"), "the funnel passes the keydown to `when`");
  assert.deepEqual(em.calls, [["selectPrevious"]]);
  em.calls.length = 0;
  const ev = keyEv("BracketLeft");
  funnel.handleKeyDown(ev);
  assert.deepEqual(em.calls, [], "[ still stands down in magic stance");
  assert.equal(ev.defaultPrevented, false);
});

// ── [3] a real EntityManager ─────────────────────────────────────────────
const ME = 0x50000001;
const A = 0x80000a01; // mob @3 m
const B = 0x80000b01; // mob @10 m
const C = 0x80000c01; // mob @50 m
const FAR = 0x80000f01; // mob @100 m — beyond the 75 m radar range
const N = 0x80000e01; // town NPC @4 m (not attackable)
const S = 0x80000501; // a sword on the ground @2 m
const G = 0x80000601; // a gem on the ground @6 m
const W = 0x80000d01; // C's wielded weapon
const P2 = 0x50000002; // another player @8 m
const MOB = { itemType: CREATURE, objDescFlags: 0x14 };

function makeSession() {
  return {
    mode: 1, // peace: no auto-target side effects
    attacker: 0,
    cell: 0x00000019, // outdoor → 75 m
    iids: new Map(),
    radar: new Map(),
    fellowship: null,
    getLocalPlayerPose() { return { x: 0, y: 0, z: 0, heading: 0, landblockId: 0x00000019 }; },
    getCurrentCellId() { return this.cell; },
    combatMode() { return this.mode; },
    isCharacterOptionEnabled() { return false; },
    objectInstanceIdProperty(g, s) {
      if (g === ME && s === 11) return this.attacker || undefined;
      return this.iids.get(`${g >>> 0}:${s}`);
    },
    objectIntProperty(g, s) { return s === 133 ? this.radar.get(g >>> 0) : undefined; },
    objectDescFlags() { return 0x18; },
    playerFellowship() { return this.fellowship; },
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
  delete globalThis.window.__useTargeting;
  const em = new EntityManager({ entitiesGroup: new THREE.Group(), materialCache: null }, {});
  em._lastCombatMode = sh.mode;
  addEntity(em, ME, 0, { itemType: CREATURE, objDescFlags: 0x18 });
  for (const [g, x] of [[A, 3], [B, 10], [C, 50], [FAR, 100]]) {
    addEntity(em, g, x, MOB);
    sh.radar.set(g, 2);
  }
  addEntity(em, N, 4, { itemType: CREATURE, objDescFlags: 0x04 });
  sh.radar.set(N, 4);
  addEntity(em, S, 2, { itemType: 0x1, objDescFlags: 0 });
  addEntity(em, G, 6, { itemType: 0x800, objDescFlags: 0 });
  addEntity(em, W, 0, { itemType: 0x1, objDescFlags: 0x12 }, { _attachedParentGuid: C });
  sh.iids.set(`${W}:3`, C);
  addEntity(em, P2, 8, { itemType: CREATURE, objDescFlags: ODF_PLAYER });
  sh.radar.set(P2, 4);
  return { em, sh };
}
const sel = (em) => em.getSelectedTarget();

test("selectPrevious swaps with the previous selection; nothing when there is none or it is gone", () => {
  const { em } = world();
  assert.equal(em.selectPrevious(), 0, "no previous selection → nothing");
  em._commitSelection(A);
  em._commitSelection(B);
  assert.equal(em.selectPrevious(), A);
  assert.equal(sel(em), A);
  assert.equal(em.selectPrevious(), B, "pressing it again swaps back");
  em._commitSelection(C);
  em.remove(B); // the previous selection despawns
  assert.equal(em.selectPrevious(), C, "a gone previous selection leaves the target alone");
  assert.equal(sel(em), C);
  em._targetCycleEnabled = false;
  em._commitSelection(A);
  assert.equal(em.selectPrevious(), A, "?targetCycle=off");
  em.dispose();
});

test("selectLastAttacker: the CurrentAttacker inside radar range only", () => {
  const { em, sh } = world();
  assert.equal(em.selectLastAttacker(), 0, "no attacker");
  sh.attacker = C;
  assert.equal(em.selectLastAttacker(), C, "50 m outdoors (75 m radar)");
  em._commitSelection(A);
  sh.attacker = FAR;
  assert.equal(em.selectLastAttacker(), A, "100 m → out of range, selection kept");
  sh.attacker = 0x80009999;
  assert.equal(em.selectLastAttacker(), A, "an unknown object");
  sh.attacker = C;
  sh.cell = 0x01000100; // indoors → 25 m
  assert.equal(em.selectLastAttacker(), A, "50 m indoors is beyond the 25 m radar");
  sh.attacker = B;
  assert.equal(em.selectLastAttacker(), B, "10 m indoors");
  em.dispose();
});

test("selectFellow walks the fellowship roster in order, skipping members not spawned here", () => {
  const { em, sh } = world();
  assert.equal(em.selectFellow(true), 0, "no fellowship → nothing");
  sh.fellowship = { leaderGuid: ME, members: [{ guid: ME }, { guid: P2 }, { guid: 0x50000099 }, { guid: A }] };
  assert.equal(em.selectFellow(true), ME, "next, none selected → first");
  assert.equal(em.selectFellow(true), P2);
  assert.equal(em.selectFellow(true), A, "the unspawned member is skipped");
  assert.equal(em.selectFellow(true), ME, "wraps");
  assert.equal(em.selectFellow(false), A, "previous wraps to the last");
  em._commitSelection(N);
  assert.equal(em.selectFellow(false), A, "previous from a non-fellow → last");
  em.dispose();
});

test("selectSelf selects the player, or completes a pending use-on-target on yourself", () => {
  const { em } = world();
  em._commitSelection(A);
  const resolved = [];
  globalThis.window.__useTargeting = { pending: { itemGuid: 0x70000001 }, resolve(g) { resolved.push(g); this.pending = null; return true; } };
  assert.equal(em.selectSelf(), A, "target mode 3: the selection is untouched");
  assert.deepEqual(resolved, [ME]);
  assert.equal(em.selectSelf(), ME, "no pending use → select self");
  delete globalThis.window.__useTargeting;
  em.dispose();
});

test("item cycle: loose ground objects only, by distance, wrapping", () => {
  const { em } = world();
  assert.equal(em.cycleTarget("closest", SELECTION_TYPE.ITEM), S, "the sword @2 m (not the wielded weapon)");
  assert.equal(em.cycleTarget("next", SELECTION_TYPE.ITEM), G, "the gem @6 m");
  assert.equal(em.cycleTarget("next", SELECTION_TYPE.ITEM), S, "wraps to the nearest");
  assert.equal(em.cycleTarget("previous", SELECTION_TYPE.ITEM), G, "previous wraps to the farthest");
  em.dispose();
});

test("compass-item cycle: radar objects at peace, attackable ones in melee", () => {
  const { em, sh } = world();
  assert.equal(em.cycleTarget("closest", SELECTION_TYPE.COMPASS_ITEM), A, "the mob @3 m");
  assert.equal(em.cycleTarget("next", SELECTION_TYPE.COMPASS_ITEM), N, "then the NPC @4 m");
  em._commitSelection(0);
  sh.mode = 2;
  em._lastCombatMode = 2;
  em._autoTargetOn = false;
  em._commitSelection(A);
  assert.equal(em.cycleTarget("next", SELECTION_TYPE.COMPASS_ITEM), B, "melee: the NPC @4 m is skipped");
  em.dispose();
});

test("player cycle: other players on radar", () => {
  const { em } = world();
  assert.equal(em.cycleTarget("closest", SELECTION_TYPE.PLAYER), P2);
  em.dispose();
});

// ── [4] static wiring ────────────────────────────────────────────────────
test("index.html installs the selection keys on the funnel and retires them per login", () => {
  const html = readFileSync(resolvePath(APP, "index.html"), "utf8");
  assert.match(html, /import \{ installSelectionKeys as __installSelectionKeys \} from "\.\/ui\/selection_keys\.js";/);
  const at = html.indexOf('__inputFunnel.bindRaw("index.gameplay", __gameplayKeyDown');
  assert.ok(at > 0);
  const block = html.slice(at, at + 1200);
  assert.match(block, /__gameplayUnbinds\.push\(__installSelectionKeys\(__inputFunnel\)\);/);
  assert.ok(block.indexOf("__installSelectionKeys") < block.indexOf("} else {"),
    "installed only under ?inputFunnelV2 (the legacy path stays byte-identical)");
});

test("keymap.js no longer claims retail binds Next Monster to Tab", () => {
  const src = readFileSync(resolvePath(APP, "ui/keymap.js"), "utf8");
  assert.doesNotMatch(src, /Retail binds NextMonster to\s*(\/\/\s*)?Tab/);
  assert.match(src, /Enter\/Exit Chat\s*(\/\/\s*)?Mode \(0x10000024\)/);
});
