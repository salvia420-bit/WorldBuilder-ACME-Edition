// tests/spell_target_compat.test.mjs — spellcast-3 (2026-10-08).
//
// Retail refuses an incompatible selected target in the client and never sends
// the cast: ClientMagicSystem::CastSpell (acclient.c:404755) →
// ObjectCompatibleWithSpell (:404473, "Casting %hs" on success) →
// ObjectCompatibleWithSpellTargetType (:403992). This locks the JS port
// (ui/ac_spell_target_compat.js), its wiring in ui/ac_cast_spell.js
// (no send, no predicted windup on a refusal; "Casting <spell>" after a send),
// and the kind=14 UseDone safety net in app/client_events.js
// (ui/cast_reject_policy.js shouldCancelOnUseDone).
//
// Formulas are the DAT-decrypted ones in data/spell-table-attrs.json.
//
// Run from apps/holtburger-web/:  node tests/spell_target_compat.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");

// Minimal browser globals (castSpellViaHandle + dispatchClientEvent touch these).
globalThis.window = globalThis;
globalThis.location = { search: "", href: "http://test/index.html", reload() {} };
globalThis.sessionStorage = { getItem: () => null, setItem() {} };
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ style: {} }),
  body: { appendChild() {} },
};

const C = await import(pathToFileURL(path.join(APP, "ui", "ac_spell_target_compat.js")).href);
const { castSpellViaHandle, castSpellViaHandleResult } =
  await import(pathToFileURL(path.join(APP, "ui", "ac_cast_spell.js")).href);
const attrs = JSON.parse(fs.readFileSync(path.join(APP, "data", "spell-table-attrs.json"), "utf8")).attrs;

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${e.message}`); }
}

// ItemType bits (ACE ItemType.cs).
const IT = { MeleeWeapon: 0x1, Armor: 0x2, Creature: 0x10, Misc: 0x80, Portal: 0x10000, LifeStone: 0x10000000 };
const PLAYER = 0x50000001;
const MONSTER = 0x80000101;
const VENDOR = 0x80000102;
const PYREALS = 0x80000103;
const SWORD = 0x80000104;
const PORTAL = 0x80000105;
const PET = 0x80000106;
const GHOST = 0x80000999; // unknown to the wasm

const known = (over) => ({ known: true, name: "X", itemType: IT.Creature, stackSize: 0, descFlags: 0x10, petOwner: 0, ...over });

// Spells (DAT formulas + bitfields).
const SP = {
  flameBolt: 27,      // [1,15,34,46,55] → 0x10
  strengthOther: 1,   // [1,7,33,44,49] → 0x10
  healSelf: 6,        // SelfTargeted
  portalTie: 47,      // [3,73,21,66,32,42,59] → 0x10010000
  bladeBane: 37,      // [1,7,34,46,57] → 0x88b8f
  searingDisc: 1783,  // type 0 (ring)
};
const NAMES = { 27: "Flame Bolt I", 1: "Strength Other I", 6: "Heal Self I", 47: "Primary Portal Tie", 37: "Blade Bane I", 1783: "Searing Disc" };
const record = (id) => {
  const a = attrs[String(id)];
  if (!a) return null;
  return new Map([
    ["name", NAMES[id] ?? `Spell ${id}`],
    ["isSelfTargeted", !!(a.bitfield & 8)],
    ["components", a.formula],
    ["flags", new Map([["selfTargeted", !!(a.bitfield & 8)]])],
  ]);
};

// Object table the stub wasm answers from.
const OBJ = {
  [PLAYER]: { name: "Me", itemType: IT.Creature, descFlags: 0x08 },
  [MONSTER]: { name: "Drudge Skulker", itemType: IT.Creature, descFlags: 0x10 },
  [VENDOR]: { name: "Shopkeeper", itemType: IT.Creature, descFlags: 0x00 },
  [PYREALS]: { name: "Pyreal", itemType: IT.Misc, descFlags: 0x10, stackSize: 25 },
  [SWORD]: { name: "Sword", itemType: IT.MeleeWeapon, descFlags: 0x10, stackSize: 1 },
  [PORTAL]: { name: "Holtburg Portal", itemType: IT.Portal, descFlags: 0x10 },
  [PET]: { name: "Spectral Wolf", itemType: IT.Creature, descFlags: 0x10, petOwner: PLAYER },
};
function makeHandle(over = {}) {
  const calls = [];
  const h = {
    calls,
    getSpellRecord: (id) => record(id),
    objectName: (g) => OBJ[g >>> 0]?.name,
    objectDescFlags: (g) => OBJ[g >>> 0]?.descFlags ?? 0,
    objectIntProperty: (g, s) => {
      const o = OBJ[g >>> 0];
      if (!o) return undefined;
      if (s === 1) return o.itemType;
      if (s === 12) return o.stackSize;
      return undefined;
    },
    objectInstanceIdProperty: (g, s) => (s === 44 ? OBJ[g >>> 0]?.petOwner : undefined),
    castTargetedSpell: (t, s) => calls.push(["targeted", t >>> 0, s >>> 0]),
    castUntargetedSpell: (s) => calls.push(["untargeted", s >>> 0]),
    ...over,
  };
  return h;
}

console.log("\n[1] ObjectCompatibleWithSpellTargetType (acclient.c:403992) — pure rules");
const R = (targetType, targetGuid, target) => C.spellTargetRefusal({ targetType, targetGuid, playerGuid: PLAYER, target });

await check("type 0: no target passes, a target is 'would require no target'", () => {
  assert.equal(R(0, 0, null), null);
  assert.deepEqual(R(0, MONSTER, known()), { reason: "requiresNoTarget", message: "This spell would require no target" });
});
await check("targeted type with no target → 'This spell would require a target'", () => {
  assert.deepEqual(R(0x10, 0, null), { reason: "requiresTarget", message: "This spell would require a target" });
});
await check("self + creature-only type 0x10 → 'You cannot cast this spell upon yourself'", () => {
  assert.deepEqual(R(0x10, PLAYER, known({ descFlags: 0x08 })), { reason: "self", message: "You cannot cast this spell upon yourself" });
});
await check("self + a 0x8107 type (0x88b8f, 0x8107) passes: the player is IsPlayer", () => {
  assert.equal(R(0x88b8f, PLAYER, known({ descFlags: 0x08 })), null);
  assert.equal(R(0x8107, PLAYER, known({ descFlags: 0x08 })), null);
});
await check("unknown object → silent refusal (message '')", () => {
  assert.deepEqual(R(0x10, GHOST, null), { reason: "unknownTarget", message: "" });
  assert.deepEqual(R(0x10, GHOST, { known: false }), { reason: "unknownTarget", message: "" });
});
await check("StackSize 5 → 'Cannot cast spell on a stack of items.' (checked before the type)", () => {
  assert.deepEqual(R(0x10, PYREALS, known({ itemType: IT.Misc, stackSize: 5 })), { reason: "stack", message: "Cannot cast spell on a stack of items." });
  assert.equal(R(0x88b8f, SWORD, known({ itemType: IT.MeleeWeapon, stackSize: 1 })), null, "a stack of 1 is fine");
});
await check("ItemType Misc vs 0x10 → 'This spell cannot be cast on <name>'", () => {
  assert.deepEqual(R(0x10, PYREALS, known({ name: "Pyreal", itemType: IT.Misc })), { reason: "type", message: "This spell cannot be cast on Pyreal" });
});
await check("a 0x8107 type skips the ItemType mask (Misc item, attackable → pass)", () => {
  assert.equal(R(0x88b8f, PYREALS, known({ itemType: IT.Misc })), null);
});
await check("creature without ATTACKABLE (vendor / NPC) → refused; with it → pass", () => {
  assert.deepEqual(R(0x10, VENDOR, known({ name: "Shopkeeper", descFlags: 0 })), { reason: "notAttackable", message: "This spell cannot be cast on Shopkeeper" });
  assert.equal(R(0x10, MONSTER, known({ descFlags: 0x10 })), null);
});
await check("a PLAYER that is not ATTACKABLE (non-PK) still passes (IsPlayer arm)", () => {
  assert.equal(R(0x10, 0x50000077, known({ descFlags: 0x08 })), null);
});
await check("PetOwner set → refused with the same text", () => {
  assert.deepEqual(R(0x10, PET, known({ name: "Spectral Wolf", petOwner: PLAYER })), { reason: "pet", message: "This spell cannot be cast on Spectral Wolf" });
});
await check("portal tie (0x10010000): a portal passes, a creature is refused", () => {
  assert.equal(R(0x10010000, PORTAL, known({ itemType: IT.Portal })), null);
  assert.equal(R(0x10010000, 0x80000107, known({ itemType: IT.LifeStone })), null);
  assert.equal(R(0x10010000, MONSTER, known({ name: "Drudge" })).reason, "type");
});
await check("unknown ItemType skips the mask arm (fail-open); flags/pet still apply", () => {
  assert.equal(R(0x10, MONSTER, known({ itemType: undefined })), null);
  assert.equal(R(0x10, VENDOR, known({ itemType: undefined, descFlags: 0 })).reason, "notAttackable");
});
await check("retail strings: no trailing period except the stack message", () => {
  for (const m of [C.MSG_NO_SELECTION, C.MSG_REQUIRES_NO_TARGET, C.MSG_REQUIRES_TARGET, C.MSG_SELF, C.msgCannotBeCastOn("X")]) {
    assert.ok(!m.endsWith("."), m);
  }
  assert.ok(C.MSG_STACK.endsWith("."));
  assert.equal(C.castingNotice("Flame Bolt I"), "Casting Flame Bolt I");
});

console.log("\n[2] readSpellTargetFacts — existing wasm getters");
await check("reads ItemType (1), StackSize (12), PetOwner IID (44), desc flags, name", () => {
  const f = C.readSpellTargetFacts(makeHandle(), PET);
  assert.deepEqual(f, { known: true, name: "Spectral Wolf", itemType: IT.Creature, stackSize: 0, descFlags: 0x10, petOwner: PLAYER });
});
await check("unknown guid → known false", () => {
  assert.equal(C.readSpellTargetFacts(makeHandle(), GHOST).known, false);
});
await check("a pkg without the getters, or a throwing getter → null (fail-open)", () => {
  assert.equal(C.readSpellTargetFacts({ getSpellRecord: () => null }, MONSTER), null);
  assert.equal(C.readSpellTargetFacts(makeHandle({ objectName: () => { throw new Error("borrow"); } }), MONSTER), null);
  assert.equal(C.readSpellTargetFacts(null, MONSTER), null);
});

console.log("\n[3] checkSpellTarget — the CastSpell decision (real DAT formulas)");
const chk = (h, sid, tgt) => C.checkSpellTarget(h, sid, tgt, PLAYER);
await check("DAT target types: bolt/other 0x10, portal tie 0x10010000, Blade Bane 0x88b8f", async () => {
  const { inqTargetType } = await import(pathToFileURL(path.join(APP, "ui", "ac_spell_target_type.js")).href);
  assert.equal(inqTargetType(attrs["27"].formula), 0x10);
  assert.equal(inqTargetType(attrs["1"].formula), 0x10);
  assert.equal(inqTargetType(attrs["47"].formula), 0x10010000);
  assert.equal(inqTargetType(attrs["37"].formula), 0x88b8f);
  assert.equal(inqTargetType(attrs["1783"].formula), 0);
  assert.ok(attrs["6"].bitfield & 8, "Heal Self I is SelfTargeted");
});
await check("SelfTargeted, type-0, no record, no formula → skip (never read the selection)", () => {
  const h = makeHandle();
  assert.deepEqual(chk(h, SP.healSelf, VENDOR), { verdict: "skip", reason: "selfTargeted" });
  assert.deepEqual(chk(h, SP.searingDisc, VENDOR), { verdict: "skip", reason: "untargeted" });
  assert.deepEqual(chk(h, 999999, VENDOR), { verdict: "skip", reason: "noRecord" });
  const noFormula = makeHandle({ getSpellRecord: () => new Map([["name", "Flame Bolt I"], ["isSelfTargeted", false]]) });
  assert.deepEqual(chk(noFormula, SP.flameBolt, VENDOR), { verdict: "skip", reason: "noFormula" });
  const throws = makeHandle({ getSpellRecord: () => { throw new Error("SpellTable not loaded"); } });
  assert.deepEqual(chk(throws, SP.flameBolt, VENDOR), { verdict: "skip", reason: "noRecord" });
});
await check("target 0 → CastSpell's 'You must select a suitable target before casting this spell'", () => {
  assert.deepEqual(chk(makeHandle(), SP.flameBolt, 0), { verdict: "refuse", reason: "noSelection", message: C.MSG_NO_SELECTION });
});
await check("bolt at a vendor → refused; at a monster → pass with the spell name", () => {
  const h = makeHandle();
  assert.deepEqual(chk(h, SP.flameBolt, VENDOR), { verdict: "refuse", reason: "notAttackable", message: "This spell cannot be cast on Shopkeeper" });
  assert.deepEqual(chk(h, SP.flameBolt, MONSTER), { verdict: "pass", spellName: "Flame Bolt I" });
});
await check("Strength Other I on yourself → refused; Blade Bane I on yourself → pass", () => {
  const h = makeHandle();
  assert.deepEqual(chk(h, SP.strengthOther, PLAYER), { verdict: "refuse", reason: "self", message: C.MSG_SELF });
  assert.deepEqual(chk(h, SP.bladeBane, PLAYER), { verdict: "pass", spellName: "Blade Bane I" });
});
await check("stack of pyreals, a pet, a portal tie at a portal", () => {
  const h = makeHandle();
  assert.equal(chk(h, SP.bladeBane, PYREALS).message, "Cannot cast spell on a stack of items.");
  assert.equal(chk(h, SP.flameBolt, PET).message, "This spell cannot be cast on Spectral Wolf");
  assert.equal(chk(h, SP.portalTie, PORTAL).verdict, "pass");
  assert.equal(chk(h, SP.portalTie, MONSTER).message, "This spell cannot be cast on Drudge Skulker");
});
await check("unknown target / missing getters → skip (fail-open), but self needs no getters", () => {
  assert.deepEqual(chk(makeHandle(), SP.flameBolt, GHOST), { verdict: "skip", reason: "unknownTarget" });
  const old = { getSpellRecord: (id) => record(id) };
  assert.deepEqual(chk(old, SP.flameBolt, VENDOR), { verdict: "skip", reason: "noGetters" });
  assert.equal(chk(old, SP.strengthOther, PLAYER).reason, "self");
});
await check("flag reader: default on; off / 0 / false disable", () => {
  assert.equal(C.spellTargetPrecheckEnabled(""), true);
  assert.equal(C.spellTargetPrecheckEnabled("?spellTargetPrecheck=on"), true);
  for (const v of ["off", "0", "false", "OFF"]) assert.equal(C.spellTargetPrecheckEnabled(`?spellTargetPrecheck=${v}`), false, v);
});

console.log("\n[4] castSpellViaHandle — no send on a refusal, 'Casting <spell>' after a send");
function harness(handleOver = {}) {
  const emits = [];
  const lines = [];
  delete globalThis.__pluginClient; // the wasm fallback path is the one that records sends
  globalThis.__sessionHandle = makeHandle(handleOver);
  globalThis.__appendChatLine = (text, cat) => lines.push([text, cat]);
  globalThis.getLocalPlayerGuid = () => PLAYER;
  const bus = { emit: (name, payload) => emits.push([name, payload]) };
  globalThis.__pluginClient = { events: bus }; // no `player` → falls through to the handle
  return { emits, lines, calls: globalThis.__sessionHandle.calls };
}
function teardown() {
  delete globalThis.__pluginClient;
  delete globalThis.__sessionHandle;
  delete globalThis.__appendChatLine;
  delete globalThis.getLocalPlayerGuid;
  globalThis.location.search = "";
}
await check("refused: returns false / 'refused', sends nothing, toasts + transient line + spellCastRejected", () => {
  const { emits, lines, calls } = harness();
  try {
    assert.equal(castSpellViaHandleResult(SP.flameBolt, VENDOR), "refused");
    assert.equal(castSpellViaHandle(SP.flameBolt, VENDOR), false);
    assert.deepEqual(calls, [], "no castTargetedSpell");
    const msg = "This spell cannot be cast on Shopkeeper";
    assert.deepEqual(emits[0], ["clientActionRejected", { message: msg }]);
    assert.deepEqual(emits[1], ["spellCastRejected", { spellId: SP.flameBolt, casterGuid: PLAYER, reason: msg }]);
    assert.deepEqual(lines[0], [msg, 9], "transient chat category 9");
  } finally { teardown(); }
});
await check("pass: castTargetedSpell(target, spell), then 'Casting Flame Bolt I' (transient)", () => {
  const { emits, lines, calls } = harness();
  try {
    assert.equal(castSpellViaHandleResult(SP.flameBolt, MONSTER), "sent");
    assert.deepEqual(calls, [["targeted", MONSTER, SP.flameBolt]]);
    assert.deepEqual(lines, [["Casting Flame Bolt I", 9]]);
    assert.equal(emits.length, 0);
  } finally { teardown(); }
});
await check("self-target promotion and untargeted casts print no notice and are not checked", () => {
  const { lines, calls } = harness();
  try {
    assert.equal(castSpellViaHandle(SP.healSelf, null), true);
    assert.equal(castSpellViaHandle(SP.searingDisc, null), true);
    assert.deepEqual(calls, [["targeted", PLAYER, SP.healSelf], ["untargeted", SP.searingDisc]]);
    assert.deepEqual(lines, []);
  } finally { teardown(); }
});
await check("?spellTargetPrecheck=off: the vendor cast goes out unchecked, no notice", () => {
  const { lines, calls, emits } = harness();
  globalThis.location.search = "?spellTargetPrecheck=off";
  try {
    assert.equal(castSpellViaHandle(SP.flameBolt, VENDOR), true);
    assert.deepEqual(calls, [["targeted", VENDOR, SP.flameBolt]]);
    assert.deepEqual(lines, []);
    assert.deepEqual(emits, []);
  } finally { teardown(); }
});
await check("plugin-client path: a refusal never reaches client.player.castSpell", () => {
  const { emits } = harness();
  const sent = [];
  globalThis.__pluginClient = { events: { emit: (n, p) => emits.push([n, p]) }, player: { castSpell: (...a) => sent.push(a) } };
  try {
    assert.equal(castSpellViaHandle(SP.flameBolt, PET), false);
    assert.deepEqual(sent, []);
    assert.equal(castSpellViaHandle(SP.flameBolt, MONSTER), true);
    assert.deepEqual(sent, [[SP.flameBolt, MONSTER]]);
  } finally { teardown(); }
});
await check("no session → 'unavailable' (distinct from a refusal)", () => {
  teardown();
  assert.equal(castSpellViaHandleResult(SP.flameBolt, MONSTER), "unavailable");
  assert.equal(castSpellViaHandleResult(0, MONSTER), "unavailable");
});

console.log("\n[5] kind=14 UseDone safety net (app/client_events.js, ?castUseDoneCancels)");
const { dispatchClientEvent } = await import("../app/client_events.js");
const { ClientEventKind } = await import("../scene3d/client_event_kinds.js");
function useDoneRun({ chainActive, busy, search = "" }) {
  const log = [];
  const inst = { _castChainActive: chainActive, _castBusyUntilMs: 0 };
  globalThis.location.search = search;
  globalThis.liveScene3d = {
    entityManager: {
      entityMap: new Map([[PLAYER, inst]]),
      cancelCastSequence: (g, cause) => { log.push(["cancel", g >>> 0, cause]); inst._castChainActive = false; return true; },
      clearCastBusy: (g) => { log.push(["clear", g >>> 0]); inst._castChainActive = false; },
    },
  };
  globalThis.__sessionHandle = busy === undefined ? {} : { getBusyState: () => busy };
  const evt = { kind: ClientEventKind.USE_DONE, u32Payload: 0, u32Payload2: 0, stringPayload: "", free() {} };
  const D = { getLocalPlayerGuid: () => PLAYER, EVT_GUARD_ON: true, CMD_INTERP_ON: false, CAST_MOVE_ON: false };
  const quiet = console.log;
  console.log = () => {};
  try { dispatchClientEvent(evt, D); } finally { console.log = quiet; }
  delete globalThis.liveScene3d;
  delete globalThis.__sessionHandle;
  globalThis.location.search = "";
  return log;
}
await check("chain active + nothing outstanding → cancelCastSequence('server-done') BEFORE clearCastBusy", () => {
  assert.deepEqual(useDoneRun({ chainActive: true, busy: 0 }), [["cancel", PLAYER, "server-done"], ["clear", PLAYER]]);
});
await check("a request still outstanding (an earlier action's UseDone) → only clearCastBusy", () => {
  assert.deepEqual(useDoneRun({ chainActive: true, busy: 1 }), [["clear", PLAYER]]);
});
await check("no chain running → only clearCastBusy", () => {
  assert.deepEqual(useDoneRun({ chainActive: false, busy: 0 }), [["clear", PLAYER]]);
});
await check("pkg without getBusyState → never cancels", () => {
  assert.deepEqual(useDoneRun({ chainActive: true, busy: undefined }), [["clear", PLAYER]]);
});
await check("?castUseDoneCancels=off → only clearCastBusy", () => {
  assert.deepEqual(useDoneRun({ chainActive: true, busy: 0, search: "?castUseDoneCancels=off" }), [["clear", PLAYER]]);
});

console.log("\n===========================================================");
console.log(`spell_target_compat: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
