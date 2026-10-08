// tests/item_primary_use.test.mjs — items-3 (2026-10-08).
//
// What a shortcut key, the toolbar / selected-item Use button, the radial
// "Use" and an inventory double-click do with an OWNED item:
// plugins/inventory_helpers.js primaryUseAction = retail
// ItemHolder::DetermineUseResult (acclient.c:433086) as
// ItemHolder::UseObject (acclient.c:433354) applies it. Results 2..7 never
// send a Use event — CPlayerSystem::UsingItem (acclient.c:400434) wields
// (3/8 → AutoWield), wears (4 → AutoSort) or opens the salvage panel (6).
// The hotbar used to send a bare Use for every item binding, and ACE has no
// wield path behind Use (WorldObject.OnActivate → ActOnUse "undefined"), so
// a sword / shield / arrow / shirt on a shortcut key did nothing.
//
// Run from apps/holtburger-web/:  node tests/item_primary_use.test.mjs

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { primaryUseAction, EQUIP, WIELD_ON_USE_LOCATIONS } = await import(
  pathToFileURL(path.join(HERE, "..", "plugins", "inventory_helpers.js")).href
);

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${e.message}`); }
}

// Plain rows as copyInventoryRow builds them.
const row = (extra) => ({
  guid: 0x60000001, name: "Item", itemType: 0x80, validLocations: 0, equipMask: 0,
  containerId: 0, requiresBackpackSlot: false, ...extra,
});

console.log("\n[1] DetermineUseResult 3 / 8 — AutoWield");
check("a sword in the pack → wield MeleeWeapon (no Use event)", () => {
  const sword = row({ itemType: 0x1, validLocations: EQUIP.MeleeWeapon });
  assert.deepEqual(primaryUseAction(sword), { kind: "wield", slotMask: 0x00100000 });
});
check("a WIELDED sword → falls through to a plain Use", () => {
  const sword = row({ itemType: 0x1, validLocations: EQUIP.MeleeWeapon, equipMask: EQUIP.MeleeWeapon });
  assert.deepEqual(primaryUseAction(sword), { kind: "use" });
});
check("arrows → wield MissileAmmo; a shield → Shield; a bow → MissileWeapon", () => {
  assert.deepEqual(primaryUseAction(row({ itemType: 0x100, validLocations: EQUIP.MissileAmmo })), { kind: "wield", slotMask: 0x00800000 });
  assert.deepEqual(primaryUseAction(row({ itemType: 0x2, validLocations: EQUIP.Shield })), { kind: "wield", slotMask: 0x00200000 });
  assert.deepEqual(primaryUseAction(row({ itemType: 0x100, validLocations: EQUIP.MissileWeapon })), { kind: "wield", slotMask: 0x00400000 });
});
check("a caster (ItemType 0x8000) without ValidLocations still wields to Held", () => {
  assert.deepEqual(primaryUseAction(row({ itemType: 0x8000 })), { kind: "wield", slotMask: EQUIP.Held });
  assert.deepEqual(primaryUseAction(row({ itemType: 0x1 })), { kind: "wield", slotMask: EQUIP.MeleeWeapon },
    "a melee weapon without the property keeps the old ItemType inference");
});
check("WIELD_ON_USE_LOCATIONS = MeleeWeapon|Shield|MissileWeapon|MissileAmmo|Held|TwoHanded", () => {
  assert.equal(WIELD_ON_USE_LOCATIONS >>> 0,
    (EQUIP.MeleeWeapon | EQUIP.Shield | EQUIP.MissileWeapon | EQUIP.MissileAmmo | EQUIP.Held | EQUIP.TwoHanded) >>> 0);
});

console.log("\n[2] DetermineUseResult 4 — AutoSort (armour / clothing / jewellery)");
check("an unworn shirt → wear", () => {
  const shirt = row({ itemType: 0x4, validLocations: 0x00000002 | 0x00000008 }); // chest + upper-arm wear
  const a = primaryUseAction(shirt);
  assert.equal(a.kind, "wear");
  assert.ok((a.slotMask & shirt.validLocations) !== 0 && (a.slotMask & (a.slotMask - 1)) === 0, "one valid bit");
});
check("a worn shirt → Use (location already covers its group)", () => {
  assert.deepEqual(primaryUseAction(row({ itemType: 0x4, validLocations: 0x0a, equipMask: 0x0a })), { kind: "use" });
});
check("armour (0x7E00 group), e.g. a breastplate → wear", () => {
  assert.equal(primaryUseAction(row({ itemType: 0x2, validLocations: 0x00000200 })).kind, "wear");
});
check("a ring takes the FREE ring finger (left worn → right)", () => {
  const ring = row({ itemType: 0x8, validLocations: 0x00040000 | 0x00080000 });
  assert.deepEqual(primaryUseAction(ring), { kind: "wear", slotMask: 0x00040000 });
  assert.deepEqual(primaryUseAction(ring, { equippedMask: 0x00040000 }), { kind: "wear", slotMask: 0x00080000 });
  assert.deepEqual(primaryUseAction(ring, { equippedMask: 0x000c0000 }), { kind: "wear", slotMask: 0x00040000 },
    "both worn → the first (AutoWear swaps)");
});

console.log("\n[3] DetermineUseResult 6, target mode, Use, packs");
check("a tinkering tool (ItemType 0x20000000) → salvage panel", () => {
  assert.deepEqual(primaryUseAction(row({ itemType: 0x20000000 })), { kind: "salvage" });
});
check("a healing kit with classifyUse.needsTarget → target mode", () => {
  assert.deepEqual(primaryUseAction(row({ itemType: 0x80 }), { needsTarget: true }), { kind: "target" });
});
check("a potion → Use", () => {
  assert.deepEqual(primaryUseAction(row({ itemType: 0x80 })), { kind: "use" });
});
check("an owned pack → open", () => {
  assert.deepEqual(primaryUseAction(row({ itemType: 0x200, requiresBackpackSlot: true })), { kind: "open" });
});
check("wield is decided BEFORE target mode (a wand that also targets wields first)", () => {
  assert.equal(primaryUseAction(row({ itemType: 0x8000, validLocations: EQUIP.Held }), { needsTarget: true }).kind, "wield");
});
check("no row → none", () => {
  assert.deepEqual(primaryUseAction(null), { kind: "none" });
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
