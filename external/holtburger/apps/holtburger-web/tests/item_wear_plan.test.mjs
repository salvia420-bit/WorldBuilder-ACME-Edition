// tests/item_wear_plan.test.mjs — items-4 JS half (2026-10-08).
//
// Retail never strips a worn piece to make room and never swaps a second
// stack of the ammo it holds:
//   CPlayerSystem::AutoWearIsLegal (acclient.c:397338) → "You must remove
//     your %s to wear that" / "The %s is already being worn", nothing moves;
//     AutoWear (:398318) then wields with the FULL ValidLocations;
//   CPlayerSystem::AutoWield (:398828, ~399250-399335) → ItemHolder::
//     AttemptMerge (:432468) into the held ready-slot stack first; a full
//     ammo stack of the same wcid → "You cannot wield more %s".
// The wasm WieldFromPack used to push every overlapping worn item back to
// the pack, so a coat over breastplate + bracers left the player stripped
// AND not wearing the coat (ACE refused it over the bracers).
//
// Pure rules in plugins/inventory_helpers.js: planWear, planAmmoWield,
// readySlotOccupant, retailPluralName; wired into decideItemDrop's DOLL /
// DOLL_SLOT through ctx.wearPlan / ctx.readySlotOccupant and into
// inventory.js activateItem (`?retailAutoWear=off` = old path; the
// activateItem wiring is pinned by tests/inventory_dnd_dom.test.mjs).
//
// Run from apps/holtburger-web/:  node tests/item_wear_plan.test.mjs

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const H = await import(pathToFileURL(path.join(HERE, "..", "plugins", "inventory_helpers.js")).href);
const {
  planWear, planAmmoWield, readySlotOccupant, retailPluralName, copyInventoryRow,
  decideItemDrop, primaryUseAction, DROP_TARGET, EQUIP, WEARABLE_LOCATIONS, WEAPON_READY_LOCATIONS,
} = H;

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${e.message}`); }
}

// ClothingPriority (CoverageMask) bits used below.
const OUTER_CHEST = 0x400, OUTER_UPPER_ARMS = 0x1000, OUTER_LOWER_ARMS = 0x2000;
const UNDER_CHEST = 0x8, UNDER_UPPER_ARMS = 0x20;
// ValidLocations / EquipMask bits.
const CHEST_WEAR = 0x2, UPPER_ARM_WEAR = 0x8;
const CHEST_ARMOR = 0x200, UPPER_ARM_ARMOR = 0x800, LOWER_ARM_ARMOR = 0x1000;

let nextGuid = 0x60000100;
const row = (extra) => ({
  guid: nextGuid++, wcid: 1, name: "Item", itemType: 0x2, stackSize: 1, equipMask: 0,
  containerId: 0, validLocations: 0, requiresBackpackSlot: false, ...extra,
});
const breastplate = row({ name: "Breastplate", validLocations: CHEST_ARMOR, equipMask: CHEST_ARMOR, clothingPriority: OUTER_CHEST });
const bracers = row({ name: "Bracers", validLocations: LOWER_ARM_ARMOR, equipMask: LOWER_ARM_ARMOR, clothingPriority: OUTER_LOWER_ARMS });
const coat = row({
  name: "Coat", validLocations: CHEST_ARMOR | UPPER_ARM_ARMOR | LOWER_ARM_ARMOR,
  clothingPriority: OUTER_CHEST | OUTER_UPPER_ARMS | OUTER_LOWER_ARMS,
});
const shirtWorn = row({ name: "Shirt", itemType: 0x4, validLocations: CHEST_WEAR | UPPER_ARM_WEAR, equipMask: CHEST_WEAR | UPPER_ARM_WEAR, clothingPriority: UNDER_CHEST | UNDER_UPPER_ARMS });
const shirt2 = row({ name: "Flared Shirt", itemType: 0x4, validLocations: CHEST_WEAR | UPPER_ARM_WEAR, clothingPriority: UNDER_CHEST | UNDER_UPPER_ARMS });
const sword = row({ name: "Sword", itemType: 0x1, validLocations: EQUIP.MeleeWeapon, equipMask: EQUIP.MeleeWeapon });

console.log("\n[1] planWear = AutoWearIsLegal → AutoWear");
check("coat over breastplate + bracers → refused, naming the FIRST blocker; nothing to unequip", () => {
  const p = planWear(coat, [sword, breastplate, bracers]);
  assert.deepEqual(p, { op: "reject", message: "You must remove your Breastplate to wear that" });
  assert.equal(p.unequip, undefined, "no strip list — retail never moves armour to make room");
});
check("the blocker is the first worn item in wield order (bracers worn first)", () => {
  assert.equal(planWear(coat, [bracers, breastplate]).message, "You must remove your Bracers to wear that");
});
check("shirt over shirt → refused", () => {
  assert.deepEqual(planWear(shirt2, [shirtWorn]), { op: "reject", message: "You must remove your Shirt to wear that" });
});
check("no coverage overlap → wear with the FULL ValidLocations (not one bit)", () => {
  // A shirt under a breastplate: under- vs outer-wear layers do not overlap.
  assert.deepEqual(planWear(shirt2, [breastplate, bracers, sword]), {
    op: "wear", guid: shirt2.guid, slotMask: CHEST_WEAR | UPPER_ARM_WEAR,
  });
  assert.deepEqual(planWear(coat, [shirtWorn]), { op: "wear", guid: coat.guid, slotMask: 0x1a00 });
});
check("the item itself worn → 'The X is already being worn'", () => {
  assert.deepEqual(planWear(breastplate, [breastplate]), { op: "reject", message: "The Breastplate is already being worn" });
});
check("a weapon's (or jewellery's) priority never counts; only the 0x8007FFF family", () => {
  const oddRing = row({ name: "Ring", validLocations: 0x40000, equipMask: 0x40000, clothingPriority: OUTER_CHEST });
  assert.equal(planWear(coat, [oddRing]).op, "wear", "a worn ring is outside clothingPriorityMask");
});
check("priority overlap without a shared location still names the overlapping piece", () => {
  const robe = row({ name: "Robe", validLocations: CHEST_WEAR, clothingPriority: OUTER_CHEST });
  assert.equal(planWear(robe, [breastplate]).message, "You must remove your Breastplate to wear that");
});
check("stale wasm (no clothingPriority getter) → the old single-bit wear, no pre-check", () => {
  // That wasm also predates the WieldFromPack no-strip guard: a full mask
  // would make it strip every location overlap instead of one.
  const { clothingPriority: _a, ...coatNoPrio } = coat;
  const { clothingPriority: _b, ...bpNoPrio } = breastplate;
  assert.deepEqual(planWear(coatNoPrio, [bpNoPrio]), { op: "wear", guid: coat.guid, slotMask: CHEST_ARMOR });
});
check("not a wearable (sword, ring) → none", () => {
  assert.deepEqual(planWear(row({ validLocations: EQUIP.MeleeWeapon }), []), { op: "none" });
  assert.deepEqual(planWear(row({ validLocations: 0x40000 | 0x80000 }), []), { op: "none" });
  assert.deepEqual(planWear(null, []), { op: "none" });
});

console.log("\n[2] planAmmoWield = AutoWield's AttemptMerge");
const quiver = (stack, extra = {}) => row({
  name: "Arrow", wcid: 300, itemType: 0x100, validLocations: EQUIP.MissileAmmo, equipMask: EQUIP.MissileAmmo,
  stackSize: stack, maxStackSize: 250, ...extra,
});
const arrows = (stack, extra = {}) => row({
  name: "Arrow", wcid: 300, itemType: 0x100, validLocations: EQUIP.MissileAmmo, stackSize: stack, maxStackSize: 250, ...extra,
});
check("arrows wcid A onto wielded wcid A (50/250) → merge the whole 50", () => {
  const q = quiver(50);
  const a = arrows(50);
  assert.deepEqual(planAmmoWield(a, q), { op: "merge", guid: a.guid, target: q.guid, amount: 50, targetStack: 50 });
});
check("merge amount is min(stack, max − held): 80 onto 200/250 → 50", () => {
  assert.equal(planAmmoWield(arrows(80), quiver(200)).amount, 50);
});
check("onto a FULL wielded stack → 'You cannot wield more Arrows' (retail plural)", () => {
  assert.deepEqual(planAmmoWield(arrows(10), quiver(250)), { op: "reject", message: "You cannot wield more Arrows" });
  assert.equal(planAmmoWield(arrows(10, { name: "Arrowhead", pluralName: "Arrowheads (bundle)" }), quiver(250)).message,
    "You cannot wield more Arrowheads (bundle)", "the weenie's PluralName wins");
});
check("a different wcid → wield (the wasm unblock swaps the old ammo out)", () => {
  assert.deepEqual(planAmmoWield(arrows(50, { wcid: 301 }), quiver(50)), { op: "wield" });
});
check("empty ammo slot / no occupant → wield", () => {
  assert.deepEqual(planAmmoWield(arrows(50), null), { op: "wield" });
});
check("unknown stack limit: ammo merges the whole amount; a split amount is honoured", () => {
  const q = quiver(10, { maxStackSize: undefined });
  const a = arrows(30, { maxStackSize: undefined });
  assert.equal(planAmmoWield(a, q).amount, 30);
  assert.equal(planAmmoWield(arrows(30), quiver(10), { amount: 7 }).amount, 7);
});
check("weapon-ready slot: same-wcid thrown stack merges; full or non-stackable → wield (swap), never refused", () => {
  const darts = (stack, extra) => row({ name: "Dart", wcid: 400, itemType: 0x100, validLocations: EQUIP.MissileWeapon, stackSize: stack, maxStackSize: 100, ...extra });
  const held = darts(60, { equipMask: EQUIP.MissileWeapon });
  const more = darts(70);
  assert.deepEqual(planAmmoWield(more, held), { op: "merge", guid: more.guid, target: held.guid, amount: 40, targetStack: 60 });
  assert.deepEqual(planAmmoWield(darts(5), darts(100, { equipMask: EQUIP.MissileWeapon })), { op: "wield" });
  const s1 = row({ name: "Sword", wcid: 500, itemType: 0x1, validLocations: EQUIP.MeleeWeapon, equipMask: EQUIP.MeleeWeapon });
  const s2 = row({ name: "Sword", wcid: 500, itemType: 0x1, validLocations: EQUIP.MeleeWeapon });
  assert.deepEqual(planAmmoWield(s2, s1), { op: "wield" }, "two same-wcid swords swap as before");
});
check("readySlotOccupant: ammo slot, weapon-ready family, nothing for shield / armour", () => {
  const q = quiver(1);
  const rows = [breastplate, sword, q];
  assert.equal(readySlotOccupant(rows, EQUIP.MissileAmmo), q);
  assert.equal(readySlotOccupant(rows, EQUIP.MissileWeapon), sword, "a bow onto the weapon-ready slot sees the sword");
  assert.equal(readySlotOccupant(rows, EQUIP.Shield), null);
  assert.equal(readySlotOccupant(rows, CHEST_ARMOR), null);
  assert.equal(WEAPON_READY_LOCATIONS >>> 0, (EQUIP.MeleeWeapon | EQUIP.MissileWeapon | EQUIP.Held | EQUIP.TwoHanded) >>> 0);
});
check("retailPluralName: + 's', + 'es' after a trailing s, PluralName wins", () => {
  assert.equal(retailPluralName("Arrow"), "Arrows");
  assert.equal(retailPluralName("Atlan Arrows"), "Atlan Arrowses", "retail appends 'es' after any trailing s");
  assert.equal(retailPluralName("Quarrel", "Quarrels of Doom"), "Quarrels of Doom");
});

console.log("\n[3] decideItemDrop paperdoll paths with the ctx hooks");
const rows = [breastplate, bracers, sword];
const ctx = {
  playerGuid: 0x50000001,
  wearPlan: (item) => planWear(item, rows),
  readySlotOccupant: (mask) => readySlotOccupant(rows, mask),
};
check("figure (DOLL): overlapping coat → reject with the retail text; legal shirt → wear with the full mask", () => {
  assert.deepEqual(decideItemDrop({ guid: coat.guid, item: coat, owned: true }, { kind: DROP_TARGET.DOLL }, ctx),
    { op: "reject", message: "You must remove your Breastplate to wear that" });
  assert.deepEqual(decideItemDrop({ guid: shirt2.guid, item: shirt2, owned: true }, { kind: DROP_TARGET.DOLL }, ctx),
    { op: "wear", guid: shirt2.guid, slotMask: CHEST_WEAR | UPPER_ARM_WEAR });
});
check("figure without the hooks (?retailAutoWear=off) keeps the old single-bit wear", () => {
  assert.deepEqual(decideItemDrop({ guid: coat.guid, item: coat, owned: true }, { kind: DROP_TARGET.DOLL }, { playerGuid: 1 }),
    { op: "wear", guid: coat.guid, slotMask: CHEST_ARMOR });
});
check("armour slot (DOLL_SLOT): an overlapping coat is refused too", () => {
  const a = decideItemDrop({ guid: coat.guid, item: coat, owned: true }, { kind: DROP_TARGET.DOLL_SLOT, slotMask: CHEST_ARMOR }, ctx);
  assert.equal(a.op, "reject");
  assert.equal(a.message, "You must remove your Breastplate to wear that");
});
check("ammo slot (DOLL_SLOT): a same-wcid stack merges, honouring a shift-split amount", () => {
  const q = quiver(100);
  const a = arrows(60);
  const c2 = { playerGuid: 1, readySlotOccupant: (mask) => readySlotOccupant([q], mask) };
  assert.deepEqual(decideItemDrop({ guid: a.guid, item: a, owned: true }, { kind: DROP_TARGET.DOLL_SLOT, slotMask: EQUIP.MissileAmmo }, c2),
    { op: "merge", guid: a.guid, target: q.guid, amount: 60, targetStack: 100 });
  assert.equal(decideItemDrop({ guid: a.guid, item: a, owned: true, split: 20 }, { kind: DROP_TARGET.DOLL_SLOT, slotMask: EQUIP.MissileAmmo }, c2).amount, 20);
  assert.equal(decideItemDrop({ guid: a.guid, item: a, owned: true }, { kind: DROP_TARGET.DOLL_SLOT, slotMask: EQUIP.MissileAmmo }, { playerGuid: 1 }).op,
    "wield", "no hook → the old wield");
});
check("weapon slot (DOLL_SLOT) for a different weapon still wields (the wasm swap)", () => {
  const axe = row({ name: "Axe", wcid: 600, itemType: 0x1, validLocations: EQUIP.MeleeWeapon });
  assert.equal(decideItemDrop({ guid: axe.guid, item: axe, owned: true }, { kind: DROP_TARGET.DOLL_SLOT, slotMask: EQUIP.MeleeWeapon }, ctx).op, "wield");
});

console.log("\n[4] InventoryItem getters (guarded) + CombatUse fallback");
check("copyInventoryRow copies clothingPriority / combatUse only when the wasm has them", () => {
  const box = { guid: 7, name: "Coat", clothingPriority: 0x3400, combatUse: 0 };
  const r = copyInventoryRow(box);
  assert.equal(r.clothingPriority, 0x3400);
  assert.equal(r.combatUse, 0);
  const old = copyInventoryRow({ guid: 8, name: "Coat" });
  assert.equal("clothingPriority" in old, false, "stale pkg → field absent, not 0-as-truth");
  assert.equal("combatUse" in old, false);
});
check("primaryUseAction: no ValidLocations → CombatUse picks the ready slot (Ammo 3, Shield 4)", () => {
  assert.deepEqual(primaryUseAction(row({ itemType: 0x80, combatUse: 3 })), { kind: "wield", slotMask: EQUIP.MissileAmmo });
  assert.deepEqual(primaryUseAction(row({ itemType: 0x80, combatUse: 4 })), { kind: "wield", slotMask: EQUIP.Shield });
  assert.deepEqual(primaryUseAction(row({ itemType: 0x1 })), { kind: "wield", slotMask: EQUIP.MeleeWeapon }, "no CombatUse → ItemType as before");
  assert.equal(WEARABLE_LOCATIONS >>> 0, 0x08007fff);
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
