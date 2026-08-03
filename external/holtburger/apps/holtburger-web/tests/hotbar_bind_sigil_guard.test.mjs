// tests/hotbar_bind_sigil_guard.test.mjs — round-9 review, finding R9-1.
//
// `canBindToHotbar` (plugins/inventory_helpers.js) is documented as
// "Rejects Container items and Sigil items per the user-authorized spec".
// The Container leg is right (ItemType.Container = 0x00000200). The Sigil
// leg tested `itemType & 0x00020000` — but 0x00020000 is
// **ItemType.Lockable**, not a sigil:
//
//   ACE.Entity/Enum/ItemType.cs:26   Lockable = 0x00020000
//   plugins/world-objects/canonical_classify.js:46
//       // const IT_LOCKABLE = 0x00020000;  // not used by classifier
//
// There is no "Sigil" ItemType at all. Aetheria sigils are
// `ItemType.Gem` (0x800 — LSD weenie 42635 "Coalesced Aetheria",
// intStats key 1 = 2048); what makes them sigils is the EQUIP SLOT:
//
//   ACE.Entity/Enum/EquipMask.cs:40-42,50
//       SigilOne = 0x10000000, SigilTwo = 0x20000000,
//       SigilThree = 0x40000000, Sigil = 0x70000000
//
// which is exactly what plugins/inventory.js:261-263 (PAPERDOLL_SLOTS
// "Aetheria Blue/Yellow/Red") and inventory_helpers' own EQUIP.Sigil*
// constants already use.
//
// This is the SECOND instance of a bug the repo has already fixed once —
// see plugins/inventory.js:1959-1961:
//     "IT_TINKERING_TOOL = 0x20000000 (canonical_classify.js / chorizite
//      enum), NOT 0x00020000 (= IT_LOCKABLE)."
//
// NEGATIVE CONTROLS (a plausible-but-wrong fix must ALSO go red here):
//   * `ITEM_TYPE_SIGIL = 0x20000000` — the *EquipMask* SigilTwo bit read
//     against `itemType`, where 0x20000000 means ItemType.TinkeringTool.
//     Covered by "tinkering tool (ItemType 0x20000000) still binds".
//   * detecting sigils via `itemType & ItemType.Gem (0x800)` — over-rejects
//     every gem in the pack. Covered by "plain gem still binds".
//
// Run from apps/holtburger-web/:  node tests/hotbar_bind_sigil_guard.test.mjs

import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const helpers = await import(
  pathToFileURL(path.join(HERE, "..", "plugins", "inventory_helpers.js")).href
);
const { canBindToHotbar, EQUIP, ITEM_TYPE_CONTAINER } = helpers;

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  [FAIL] ${name} — ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Ground-truth fixtures. `itemType` values are ACE ItemType; `validLocations`
// / `equipMask` are ACE EquipMask.
// ---------------------------------------------------------------------------
const ITEM_TYPE_GEM = 0x00000800;       // ItemType.Gem — what Aetheria IS
const ITEM_TYPE_LOCKABLE = 0x00020000;  // ItemType.Lockable — the wrong bit
const ITEM_TYPE_TINKERING_TOOL = 0x20000000; // ItemType.TinkeringTool

const aetheriaBlue = {
  name: "Coalesced Aetheria (Blue)",
  itemType: ITEM_TYPE_GEM,
  validLocations: EQUIP.SigilBlue,
  equipMask: 0,
};
const aetheriaYellowEquipped = {
  name: "Coalesced Aetheria (Yellow)",
  itemType: ITEM_TYPE_GEM,
  validLocations: 0,          // not hydrated; already wielded
  equipMask: EQUIP.SigilYellow,
};
const aetheriaRed = {
  name: "Coalesced Aetheria (Red)",
  itemType: ITEM_TYPE_GEM,
  validLocations: EQUIP.SigilRed,
  equipMask: 0,
};

// ---------------------------------------------------------------------------
// [1] The spec's own claim: sigils do not bind.
// ---------------------------------------------------------------------------
for (const [label, item] of [
  ["blue (validLocations)", aetheriaBlue],
  ["yellow (equipMask, already wielded)", aetheriaYellowEquipped],
  ["red (validLocations)", aetheriaRed],
]) {
  check(`Aetheria sigil ${label} is REJECTED from the hotbar`, () => {
    const v = canBindToHotbar(item);
    assert.equal(
      v.ok,
      false,
      `expected sigil to be rejected, got ok=${v.ok} reason=${JSON.stringify(v.reason)}`,
    );
    assert.match(v.reason, /Sigil/i, "rejection reason should name Sigils");
  });
}

// ---------------------------------------------------------------------------
// [2] The wrong bit must not reject anything: ItemType.Lockable binds fine.
// ---------------------------------------------------------------------------
check("ItemType.Lockable (0x00020000) item still binds — it is not a sigil", () => {
  const v = canBindToHotbar({
    name: "Locked Chest",
    itemType: ITEM_TYPE_LOCKABLE,
    validLocations: 0,
    equipMask: 0,
  });
  assert.equal(v.ok, true, `expected Lockable to bind, got reason=${JSON.stringify(v.reason)}`);
});

// ---------------------------------------------------------------------------
// [3] NEGATIVE CONTROL — `ITEM_TYPE_SIGIL = 0x20000000` is ItemType
//     .TinkeringTool. A fix that just bumps the constant to the EquipMask
//     SigilTwo value fails here.
// ---------------------------------------------------------------------------
check("NEGATIVE CONTROL: tinkering tool (ItemType 0x20000000) still binds", () => {
  const v = canBindToHotbar({
    name: "Tinkering Tool",
    itemType: ITEM_TYPE_TINKERING_TOOL,
    validLocations: 0,
    equipMask: 0,
  });
  assert.equal(v.ok, true, `expected tinkering tool to bind, got reason=${JSON.stringify(v.reason)}`);
});

// ---------------------------------------------------------------------------
// [4] NEGATIVE CONTROL — detecting sigils by ItemType.Gem over-rejects gems.
// ---------------------------------------------------------------------------
check("NEGATIVE CONTROL: a plain gem (ItemType.Gem, no sigil slot) still binds", () => {
  const v = canBindToHotbar({
    name: "Ruby",
    itemType: ITEM_TYPE_GEM,
    validLocations: 0,
    equipMask: 0,
  });
  assert.equal(v.ok, true, `expected a plain gem to bind, got reason=${JSON.stringify(v.reason)}`);
});

// ---------------------------------------------------------------------------
// [5] Regressions on the legs that already worked.
// ---------------------------------------------------------------------------
check("Container is still rejected", () => {
  const v = canBindToHotbar({ name: "Sack", itemType: ITEM_TYPE_CONTAINER });
  assert.equal(v.ok, false);
  assert.match(v.reason, /Container/i);
});
check("null item is still rejected", () => {
  assert.equal(canBindToHotbar(null).ok, false);
});
check("an ordinary healing kit still binds", () => {
  const v = canBindToHotbar({ name: "Healing Kit", itemType: 0x00000080 /* Misc */ });
  assert.equal(v.ok, true);
});
// Missing fields must not throw or accidentally match.
check("item with no itemType/validLocations/equipMask binds (fail-open)", () => {
  assert.equal(canBindToHotbar({ name: "Unknown" }).ok, true);
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
