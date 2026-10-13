// tests/retail_autowield_legal.test.mjs — inventory-session-2 (2026-10-13).
//
// Retail wield legality, CPlayerSystem::AutoWieldIsLegal (acclient.c:397227),
// tested against the item in the weapon-ready slot (0x3500000 — includes a
// wielded wand):
//   - MissileAmmo: the ready weapon's non-zero AmmoType must equal the
//     item's — "Cannot be used with %s";
//   - Shield: ACCWeenieObject::BlocksUseOfShield (:395589 — CombatUse
//     Missile with an AmmoType, CombatUse TwoHanded, or ITEM_TYPE Caster) —
//     "A shield may not be worn with the %s";
//   - Held outside NonCombat for a NON-caster (ITEM_TYPE & 0x8000 clear) —
//     "Cannot hold %s while in combat". The old canEquipInSlot cascade had
//     this inverted (it refused a CASTER in combat) and never saw a wand
//     under the shield check.
// A paperdoll slot outside the item's ValidLocations is a quiet refusal
// (gmPaperDollUI::AcceptDragObject :219987 / HandleDropRelease :220960).
//
// Pure rules in plugins/inventory_helpers.js: retailAutoWieldIllegal,
// blocksUseOfShield, retailAppropriateName and canEquipInSlot's retail branch
// (a buildPlayerEquipState built with retailWieldLegal); inventory.js wires
// them behind `?retailWieldLegal` (default ON, `=off` = the old cascade,
// still pinned unchanged by tests/inventory_paperdoll_helpers.test.cjs).
//
// Run from apps/holtburger-web/:  node tests/retail_autowield_legal.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
const H = await import(pathToFileURL(path.join(APP, "plugins", "inventory_helpers.js")).href);
const {
  retailAutoWieldIllegal, blocksUseOfShield, retailAppropriateName, canEquipInSlot,
  buildPlayerEquipState, decideItemDrop, DROP_TARGET: T, EQUIP,
} = H;
const ITEM_TYPE_CASTER = 0x00008000;

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${e.message}`); }
}

// ACE ItemType: MeleeWeapon 0x1, Misc 0x80, MissileWeapon 0x100, Caster 0x8000.
const sword = { guid: 0x60000001, name: "Sword", itemType: 0x1, validLocations: EQUIP.MeleeWeapon, equipMask: EQUIP.MeleeWeapon, combatUse: 1, ammoType: 0 };
const wandPacked = { guid: 0x60000002, name: "Wand", itemType: ITEM_TYPE_CASTER, validLocations: EQUIP.Held, equipMask: 0, stackSize: 1 };
const wandWielded = { ...wandPacked, equipMask: EQUIP.Held };
const gunk = { guid: 0x60000003, name: "Ball of Gunk", itemType: 0x80, validLocations: EQUIP.Held, equipMask: 0, stackSize: 1 };
const shield = { guid: 0x60000004, name: "Kite Shield", itemType: 0x2, validLocations: EQUIP.Shield, equipMask: 0, stackSize: 1 };
const bow = { guid: 0x60000005, name: "Longbow", itemType: 0x100, validLocations: EQUIP.MissileWeapon, equipMask: EQUIP.MissileWeapon, combatUse: 2, ammoType: 1 };
const crossbow = { guid: 0x60000006, name: "Heavy Crossbow", itemType: 0x100, validLocations: EQUIP.MissileWeapon, equipMask: EQUIP.MissileWeapon, combatUse: 2, ammoType: 2 };
const spadone = { guid: 0x60000007, name: "Spadone", itemType: 0x1, validLocations: EQUIP.TwoHanded, equipMask: EQUIP.TwoHanded, combatUse: 5, ammoType: 0 };
const arrows = { guid: 0x60000008, name: "Arrow", pluralName: "Arrows", itemType: 0x100, validLocations: EQUIP.MissileAmmo, equipMask: 0, ammoType: 1, stackSize: 50 };
const darts = { guid: 0x60000009, name: "Throwing Dart", itemType: 0x100, validLocations: EQUIP.MissileWeapon, equipMask: EQUIP.MissileWeapon, combatUse: 2, ammoType: 0 };

const retailState = (rows, inCombatMode) => buildPlayerEquipState(rows, { inCombatMode, retailWieldLegal: true });

console.log("\n[1] Held — a caster may be held in combat, a non-caster may not");
check("wand while a sword is wielded, in combat → legal (old cascade refused it)", () => {
  assert.equal(retailAutoWieldIllegal(wandPacked, [sword], true), null);
  const v = canEquipInSlot(wandPacked, EQUIP.Held, retailState([sword], true));
  assert.deepEqual([v.ok, v.reason], [true, ""]);
});
check("the =off cascade is unchanged: same wand + sword in combat still refused there", () => {
  const legacy = buildPlayerEquipState([sword], { inCombatMode: true });
  assert.equal(legacy.retailWieldLegal, undefined);
  assert.equal(legacy.rows, undefined);
  const v = canEquipInSlot({ ...wandPacked, defaultCombatStyle: 0x40 }, EQUIP.Held, legacy);
  assert.equal(v.ok, false);
});
check("Ball of Gunk (Held, not a caster) in combat → 'Cannot hold Ball of Gunk while in combat'", () => {
  assert.equal(retailAutoWieldIllegal(gunk, [], true), "Cannot hold Ball of Gunk while in combat");
  const v = canEquipInSlot(gunk, EQUIP.Held, retailState([], true));
  assert.deepEqual([v.ok, v.reason], [false, "Cannot hold Ball of Gunk while in combat"]);
});
check("Ball of Gunk out of combat (NonCombat) → legal", () => {
  assert.equal(retailAutoWieldIllegal(gunk, [], false), null);
  assert.equal(canEquipInSlot(gunk, EQUIP.Held, retailState([], false)).ok, true);
});
check("a held stack is named NAME_APPROPRIATE (plural name for more than one)", () => {
  const stack = { ...gunk, stackSize: 3, pluralName: "Balls of Gunk" };
  assert.equal(retailAutoWieldIllegal(stack, [], true), "Cannot hold Balls of Gunk while in combat");
  assert.equal(retailAppropriateName({ name: "Arrow", stackSize: 2 }), "Arrows");
  assert.equal(retailAppropriateName({ name: "Arrow", stackSize: 1 }), "Arrow");
});

console.log("\n[2] Shield — BlocksUseOfShield on the weapon-ready slot");
check("shield with a wielded wand (Held 0x1000000, Caster) → 'A shield may not be worn with the Wand'", () => {
  assert.equal(retailAutoWieldIllegal(shield, [wandWielded], false), "A shield may not be worn with the Wand");
  const v = canEquipInSlot(shield, EQUIP.Shield, retailState([wandWielded], false));
  assert.deepEqual([v.ok, v.reason], [false, "A shield may not be worn with the Wand"]);
});
check("shield with a bow (CombatUse 2 + AmmoType) or a two-hander (CombatUse 5) → refused", () => {
  assert.equal(retailAutoWieldIllegal(shield, [bow], false), "A shield may not be worn with the Longbow");
  assert.equal(retailAutoWieldIllegal(shield, [spadone], false), "A shield may not be worn with the Spadone");
});
check("shield with a sword, a thrown weapon (no AmmoType) or nothing wielded → legal", () => {
  assert.equal(retailAutoWieldIllegal(shield, [sword], true), null);
  assert.equal(retailAutoWieldIllegal(shield, [darts], false), null);
  assert.equal(retailAutoWieldIllegal(shield, [], false), null);
});
check("BlocksUseOfShield: no CombatUse on the row → the wield slot stands in", () => {
  const { combatUse: _a, ...bowNoCu } = bow;
  const { combatUse: _b, ...spadoneNoCu } = spadone;
  assert.equal(blocksUseOfShield(bowNoCu), true);
  assert.equal(blocksUseOfShield(spadoneNoCu), true);
  assert.equal(blocksUseOfShield({ ...sword, combatUse: undefined }), false);
  assert.equal(blocksUseOfShield(wandWielded), true, "the caster bit alone");
  assert.equal(blocksUseOfShield(null), false);
});

console.log("\n[3] Ammo — the ready launcher's AmmoType");
check("arrows with a crossbow wielded → 'Cannot be used with Heavy Crossbow'", () => {
  assert.equal(retailAutoWieldIllegal(arrows, [crossbow], false), "Cannot be used with Heavy Crossbow");
  const v = canEquipInSlot(arrows, EQUIP.MissileAmmo, retailState([crossbow], false));
  assert.deepEqual([v.ok, v.reason], [false, "Cannot be used with Heavy Crossbow"]);
});
check("arrows with a bow, a melee weapon or nothing wielded → legal", () => {
  assert.equal(retailAutoWieldIllegal(arrows, [bow], true), null);
  assert.equal(retailAutoWieldIllegal(arrows, [sword], true), null);
  assert.equal(retailAutoWieldIllegal(arrows, [], true), null);
});
check("retail compares the launcher's AmmoType whatever the item's is (0 included)", () => {
  assert.equal(retailAutoWieldIllegal({ ...arrows, ammoType: 0 }, [bow], false), "Cannot be used with Longbow");
});

console.log("\n[4] canEquipInSlot retail branch — guards and slot mismatch");
check("no ValidLocations: the 'attributes pending' guard still runs first", () => {
  const v = canEquipInSlot({ equipMask: EQUIP.Held, validLocations: 0 }, EQUIP.Held, retailState([], true));
  assert.deepEqual([v.ok, v.reason], [false, "Item attributes pending — try again."]);
  assert.equal(retailAutoWieldIllegal({ validLocations: 0 }, [], false), "", "retail: illegal, no message");
});
check("slot outside ValidLocations → quiet refusal (no line)", () => {
  const v = canEquipInSlot(sword, EQUIP.MissileAmmo, retailState([], false));
  assert.deepEqual([v.ok, v.silent, v.reason], [false, true, ""]);
});

console.log("\n[5] decideItemDrop DOLL_SLOT through the retail canEquip");
const ME = 0x50000001;
const inv = (item) => ({ guid: item.guid, item, owned: true, sourceList: { key: 0, kind: "inventory" }, sourceIndex: 0, split: 0 });
const ctxFor = (rows, inCombat) => ({
  playerGuid: ME,
  canEquip: (item, mask) => canEquipInSlot(item, mask >>> 0, retailState(rows, inCombat)),
});
check("ValidLocations mismatch → noop (refused, silent), not 'This item cannot be worn in that slot.'", () => {
  const packedSword = { ...sword, equipMask: 0 };
  const a = decideItemDrop(inv(packedSword), { kind: T.DOLL_SLOT, slotMask: EQUIP.MissileAmmo }, ctxFor([], false));
  assert.equal(a.op, "noop");
  assert.equal(a.refused, true);
  assert.equal(a.message, undefined);
});
check("=off canEquip (legacy state) keeps the old reject line for the same drop", () => {
  const packedSword = { ...sword, equipMask: 0 };
  const ctx = { playerGuid: ME, canEquip: (item, mask) => canEquipInSlot(item, mask >>> 0, buildPlayerEquipState([], {})) };
  const a = decideItemDrop(inv(packedSword), { kind: T.DOLL_SLOT, slotMask: EQUIP.MissileAmmo }, ctx);
  assert.deepEqual([a.op, a.message], ["reject", "This item cannot be worn in that slot."]);
});
check("wand onto the Weapon slot in combat with a sword wielded → wield to Held", () => {
  const a = decideItemDrop(inv(wandPacked), { kind: T.DOLL_SLOT, slotMask: 0x03500000 }, ctxFor([sword], true));
  assert.deepEqual([a.op, a.slotMask], ["wield", EQUIP.Held]);
});
check("shield onto the Shield slot while a wand is wielded → retail refusal line", () => {
  const a = decideItemDrop(inv(shield), { kind: T.DOLL_SLOT, slotMask: EQUIP.Shield }, ctxFor([wandWielded], false));
  assert.deepEqual([a.op, a.message], ["reject", "A shield may not be worn with the Wand"]);
});

console.log("\n[6] wiring (source pins)");
const src = (rel) => readFileSync(path.join(APP, rel), "utf8");
check("inventory.js: ?retailWieldLegal default-ON, both wield checks share wieldEquipState", () => {
  const s = src("plugins/inventory.js");
  assert.match(s, /const RETAIL_WIELD_LEGAL = typeof window !== "undefined" \? defaultOnUrlFlag\("retailWieldLegal"\) : true;/);
  assert.match(s, /retailWieldLegal: RETAIL_WIELD_LEGAL,/);
  assert.match(s, /const verdict = canEquipInSlot\(row, slotMask, wieldEquipState\(rows\)\);/, "activateItem");
  assert.match(s, /function equipState\(\) \{\s*return wieldEquipState\(rows\);\s*\}/, "paperdoll dropCtx.canEquip");
  assert.match(s, /typeof h\?\.combatMode === "function"/, "combat = the wasm combatMode() (guarded)");
  assert.match(s, /const ok = action\.op !== "reject" && !action\.refused;/, "quiet refusal keeps the reject highlight");
});
check("item_drag.js: a silent refused hit plays no error sound", () => {
  assert.match(src("plugins/item_drag.js"), /if \(!hit\.silent\) uiError\(\);/);
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
