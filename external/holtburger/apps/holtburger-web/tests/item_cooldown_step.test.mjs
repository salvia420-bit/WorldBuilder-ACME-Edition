// tests/item_cooldown_step.test.mjs — items-5 (2026-10-08).
//
// Retail draws the shortcut cooldown overlay per ITEM:
// UIElement_UIItem::UpdateCooldownDisplay (acclient.c:272052) reads the
// item's shared-cooldown id and cooldown_duration, asks
// CEnchantmentRegistry::OnCooldown (acclient.c:445755) for the entry whose
// 16-bit spell id is id + 0x8000, and shows ONE of the ten
// m_elem_Icon_Cooldown_10..100 overlays:
//   phase = (unsigned)(time_left / duration * 100 * 0.1 + 1)
// The hotbar used to sweep EVERY slot (spells included) for a fixed 2.5 s on
// any cooldown. Table from OpenAC ItemCooldownDisplayTests.
//
// Run from apps/holtburger-web/:  node tests/item_cooldown_step.test.mjs

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { cooldownStep, matchCooldownEnchantment } = await import(
  pathToFileURL(path.join(HERE, "..", "plugins", "inventory_helpers.js")).href
);

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${e.message}`); }
}

console.log("\n[1] cooldownStep — UpdateCooldownDisplay phase");
for (const [d, r, want] of [
  [10, 10, 10], [10, 9, 10], [10, 8.999, 9], [10, 5, 6], [10, 0.001, 1], [10, 0, 0], [0, 5, 0], [10, -1, 0], [30, 45, 10],
]) {
  check(`duration ${d}, remaining ${r} → ${want}`, () => assert.equal(cooldownStep(d, r), want));
}

console.log("\n[2] matchCooldownEnchantment — OnCooldown id + 0x8000");
const enchs = [
  { spellId: 0x0041, layer: 1 },            // an ordinary buff
  { spellId: 0x8004, layer: 1, tag: "4" },  // cooldown id 4
  { spellId: 0x8003, layer: 1, tag: "3" },  // cooldown id 3
];
check("cooldown id 3 matches spell 0x8003, not 0x8004", () => {
  assert.equal(matchCooldownEnchantment(enchs, 3)?.tag, "3");
  assert.equal(matchCooldownEnchantment(enchs, 4)?.tag, "4");
});
check("no cooldown id (0) / no entry → null (no overlay, spells never get one)", () => {
  assert.equal(matchCooldownEnchantment(enchs, 0), null);
  assert.equal(matchCooldownEnchantment(enchs, 9), null);
  assert.equal(matchCooldownEnchantment(null, 3), null);
});
check("only the low 16 bits of the spell id count (layered ids)", () => {
  assert.equal(matchCooldownEnchantment([{ spellId: 0x00018003 }], 3)?.spellId, 0x00018003);
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
