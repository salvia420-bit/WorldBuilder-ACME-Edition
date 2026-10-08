// tests/salvage_suitable.test.mjs — crafting-2 + crafting-3 (2026-10-08 round 3).
//
// crafting-2: retail gmSalvageUI::IsItemSuitable (acclient.c:252433):
//   TinkeringSystem::IsValidMaterialType(material)   (:500471)
//   && pwd._structure < 100
//   && (PlayerModule::SalvageMultiple || m_material == 0 || material == m_material)
//   && !(pwd._bitfield & 0x01000000)   (Retained)
// with m_material locked to the first item (_AddItem :252614) and cleared
// when the list empties (RemoveItem) / is salvaged / reopened.
//
// crafting-3: ClientUISystem::Handle_Inventory__Recv_SalvageOperationsResultData
// (:402586) + GenerateMaterialsSalvagedString (:402430):
//   "You obtain 12 Iron (ws 5.42), 3 Amber (ws 2.00) and 1 Silver (ws 7.00)
//    using your knowledge of Salvaging. Your augmentation has given you a
//    return bonus of 25%!"
//
// Run: node tests/salvage_suitable.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";

// A minimal window so the panel's session reads resolve to our fake handle.
const items = new Map();
let salvageMultiple = true;
const chat = [];
globalThis.window = {
  __sessionHandle: {
    objectIntProperty: (g, stype) => {
      const it = items.get(g >>> 0);
      if (!it) return undefined;
      if (stype === 131) return it.material;
      if (stype === 92) return it.structure;
      return undefined;
    },
    objectDescFlags: (g) => items.get(g >>> 0)?.flags ?? 0,
    objectBoolProperty: (g, stype) => (stype === 91 ? items.get(g >>> 0)?.retained : undefined),
    isCharacterOptionEnabled: (opt) => (opt === 0x22 ? salvageMultiple : false),
  },
  __appendChatLine: (text, cat) => chat.push([text, cat]),
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
};

const sp = await import("../plugins/salvage-panel.js");

test("IsValidMaterialType matches the retail switch", () => {
  const valid = [1, 2, 4, 5, 6, 7, 8, 10, 11, 37, 55, 57, 64, 66, 71, 73, 77];
  const invalid = [0, 3, 9, 56, 65, 72, 78, 255];
  for (const m of valid) assert.equal(sp.isValidSalvageMaterial(m), true, `material ${m}`);
  for (const m of invalid) assert.equal(sp.isValidSalvageMaterial(m), false, `material ${m}`);
});

test("IsItemSuitable: structure < 100, not Retained, single-material lock when the option is off", () => {
  const ok = { materialType: 0x0B, structure: 50, descFlags: 0 };
  assert.equal(sp.salvageItemSuitable(ok), true);
  assert.equal(sp.salvageItemSuitable({ ...ok, structure: 100 }), false, "a full bag");
  assert.equal(sp.salvageItemSuitable({ ...ok, descFlags: sp.ODF_RETAINED }), false, "Retained bit");
  assert.equal(sp.salvageItemSuitable({ ...ok, retained: true }), false, "Retained bool");
  assert.equal(sp.salvageItemSuitable({ ...ok, materialType: 9 }), false, "Gem (category) material");
  assert.equal(sp.salvageItemSuitable({ ...ok, materialType: null }), false, "no material");
  assert.equal(sp.salvageItemSuitable({ ...ok, structure: null }), true, "no structure field = 0");
  assert.equal(sp.salvageItemSuitable(ok, { salvageMultiple: false, lockedMaterial: 0x3D }), false);
  assert.equal(sp.salvageItemSuitable(ok, { salvageMultiple: false, lockedMaterial: 0x0B }), true);
  assert.equal(sp.salvageItemSuitable(ok, { salvageMultiple: true, lockedMaterial: 0x3D }), true);
  // Only the Retained bit of the top byte matters (retail BYTE3 & 1).
  assert.equal(sp.salvageItemSuitable({ ...ok, descFlags: 0x40000000 }), true, "WieldLeft is not a block");
});

test("addItem gates through the session facts and locks the first material", () => {
  items.clear();
  items.set(0x80000001, { material: 0x3D, structure: 0 });      // Iron dagger
  items.set(0x80000002, { material: 0x0B, structure: 0 });      // Amber
  items.set(0x80000003, { material: 0x3D, structure: 100 });    // full Iron bag
  items.set(0x80000004, { material: 0x3D, structure: 0, flags: 0x01000000 }); // Retained
  items.set(0x80000005, { material: 0x3D, structure: 0 });

  salvageMultiple = false;
  // openPanel needs a DOM; drive addItem directly (renderList no-ops without refs).
  assert.equal(sp.addItem(0x80000001, "Iron Dagger"), true);
  assert.equal(sp.addItem(0x80000002, "Amber Ring"), false, "second material refused with the option off");
  assert.equal(sp.addItem(0x80000003, "Full bag"), false);
  assert.equal(sp.addItem(0x80000004, "Retained"), false);
  assert.equal(sp.addItem(0x80000005, "Iron Mace"), true, "same material accepted");
  assert.equal(sp.addItem(0x80000005, "Iron Mace"), false, "already listed");

  salvageMultiple = true;
  assert.equal(sp.addItem(0x80000002, "Amber Ring"), true, "option on → mixed materials allowed");
});

test("no session facts (stale pkg) → the gate fails open, as before", async () => {
  const saved = window.__sessionHandle;
  window.__sessionHandle = {};
  try {
    assert.equal(sp.addItem(0x800000AA, "Mystery"), true);
  } finally {
    window.__sessionHandle = saved;
  }
});

test("salvage result chat line uses retail wording, separators and the aug clause", () => {
  const names = (id) => ({ 40: "Salvaging", 18: "Item Tinkering" })[id] ?? null;
  const three = sp.salvageResultChatLine({
    skill: 40, augBonus: 25,
    results: [
      { material: 0x3D, units: 12, workmanship: 5.4166 },
      { material: 0x0B, units: 3, workmanship: 2 },
      { material: 0x3F, units: 1, workmanship: 7 },
    ],
  }, names);
  assert.equal(three,
    "You obtain 12 Iron (ws 5.42), 3 Amber (ws 2.00) and 1 Silver (ws 7.00) using your knowledge of Salvaging. " +
    "Your augmentation has given you a return bonus of 25%!");
  const one = sp.salvageResultChatLine({ skill: 18, augBonus: 0, results: [{ material: 0x3D, units: 4, workmanship: 3 }] }, names);
  assert.equal(one, "You obtain 4 Iron (ws 3.00) using your knowledge of Item Tinkering.");
  const two = sp.salvageResultChatLine({ skill: 40, augBonus: 0, results: [{ material: 0x3D, units: 1, workmanship: 1 }, { material: 0x0B, units: 2, workmanship: 2 }] }, names);
  assert.match(two, /^You obtain 1 Iron \(ws 1\.00\) and 2 Amber \(ws 2\.00\) using/);
  assert.equal(sp.salvageResultChatLine({ skill: 40, augBonus: 0, results: [] }, names), null);
});
