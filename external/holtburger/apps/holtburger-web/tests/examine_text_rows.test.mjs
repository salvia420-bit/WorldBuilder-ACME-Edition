// tests/examine_text_rows.test.mjs — examine-text-3 (2026-10-13).
//
// Row-level examine-panel bugs, each re-derived from acclient.c:
//   - a salvage bag printed ItemWorkmanship raw (the SUM over
//     NumItemsInMaterial items: a 10-item bag of ~7.2 read "72");
//     ItemExamineUI::Appraisal_ShowTinkeringInfo (:231087) prints the
//     average "%0.2f" + "Salvaged from %d items.", and every item gets the
//     InqWorkmanshipAdjective (:479578) word;
//   - Bonded −1 read "Destroyed on death" and −2 nothing;
//     BondedStatusToString (:479552) is −2 Destroyed / −1 Dropped on Death;
//   - Attuned 2 was ignored; AttunedStatusToString (:479535) takes 1..2;
//   - DamageTypeToString (:479074) says "Electrical" and "Prismatic";
//   - a negative armor modifier read "Vulnerable"; DamageResistanceToString
//     (:480119) prints a per-type sentence + "  (%.0f)";
//   - the Nether armor row passed highlight bit 0 (InqFloatEnchantmentMod
//     0xA5 → armor bit 0x100, :477475) and a dead `hp.hook_type` debug row.
//
// Run: node tests/examine_text_rows.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const F = await import(new URL("../plugins/examine_format.js", import.meta.url).href);

test("salvage bag: ItemWorkmanship 72 over 10 items reads the average + the item count", () => {
  assert.deepEqual(F.workmanshipText(72, 10), { value: "Flawless (7.20)", salvagedLine: "Salvaged from 10 items." });
});

test("salvage bag: adjective is (int)(avg + 0.5), value is the float average", () => {
  // 75 / 10 = 7.5 → adjective level 8.
  assert.deepEqual(F.workmanshipText(75, 10), { value: "Utterly flawless (7.50)", salvagedLine: "Salvaged from 10 items." });
  // 20 / 3 = 6.667 → level 7, "%0.2f" → 6.67.
  assert.equal(F.workmanshipText(20, 3).value, "Flawless (6.67)");
  // Retail keeps "items" for a single item.
  assert.equal(F.workmanshipText(4, 1).salvagedLine, "Salvaged from 1 items.");
});

test("plain item: '<adjective> (N)', no salvaged line", () => {
  assert.deepEqual(F.workmanshipText(8), { value: "Utterly flawless (8)", salvagedLine: null });
  assert.deepEqual(F.workmanshipText(3, undefined), { value: "Finely crafted (3)", salvagedLine: null });
  assert.equal(F.workmanshipText("6").value, "Nearly flawless (6)");
});

test("workmanship: unset → null; a count ≤ 0 is treated as absent", () => {
  assert.equal(F.workmanshipText(undefined), null);
  assert.equal(F.workmanshipText(null, 10), null);
  assert.equal(F.workmanshipText("", 10), null);
  assert.deepEqual(F.workmanshipText(5, 0), { value: "Magnificent (5)", salvagedLine: null });
});

test("workmanshipAdjective is InqWorkmanshipAdjective (rgWorkmanshipStrings, 'crafted' below 5)", () => {
  assert.equal(F.WORKMANSHIP_STRINGS.length, 11);
  assert.equal(F.workmanshipAdjective(0), "crafted");
  assert.equal(F.workmanshipAdjective(1), "Poorly crafted");
  assert.equal(F.workmanshipAdjective(2), "Well-crafted");
  assert.equal(F.workmanshipAdjective(4), "Exquisitely crafted");
  assert.equal(F.workmanshipAdjective(5), "Magnificent");
  assert.equal(F.workmanshipAdjective(9), "Incomparable");
  assert.equal(F.workmanshipAdjective(10), "Priceless");
  assert.equal(F.workmanshipAdjective(11), "Priceless", "clamped to 10");
  assert.equal(F.workmanshipAdjective(3, true), "Finely cut", "gem");
});

test("bondedText is BondedStatusToString", () => {
  assert.equal(F.bondedText(-1), "Dropped on Death");
  assert.equal(F.bondedText(-2), "Destroyed on Death");
  assert.equal(F.bondedText(1), "Bonded");
  assert.equal(F.bondedText(0), null);
  assert.equal(F.bondedText(2), null);
  assert.equal(F.bondedText(undefined), null);
});

test("attunedText is AttunedStatusToString (1..2)", () => {
  assert.equal(F.attunedText(1), "Attuned");
  assert.equal(F.attunedText(2), "Attuned");
  assert.equal(F.attunedText(0), null);
  assert.equal(F.attunedText(3), null);
  assert.equal(F.attunedText(null), null);
});

test("damageTypeLabel uses retail's DamageTypeToString literals", () => {
  assert.equal(F.damageTypeLabel(0x40), "Electrical");
  assert.equal(F.damageTypeLabel(0x10000000), "Prismatic");
  assert.equal(F.damageTypeLabel(0x440), "Electrical/Nether");
  assert.equal(F.damageTypeLabel(0x10000001), "Slashing/Prismatic");
  assert.equal(F.damageTypeLabel(0x11), "Slashing/Fire");
});

test("negative armor modifier with a damage type → retail's sentence + '  (%.0f)'", () => {
  assert.equal(F.protectionText(-0.5, 100, 0x10), "Your armor is flammable.  (-50)");
  assert.equal(F.protectionText(-0.5, 100, 0x1), "Your armor will rend and slash you if hit.  (-50)");
  assert.equal(F.protectionText(-0.5, 100, 0x2), "Your armor will cave in and pierce you if hit.  (-50)");
  assert.equal(F.protectionText(-0.5, 100, 0x4), "Your armor will shatter and bruise you if hit.  (-50)");
  assert.equal(F.protectionText(-0.5, 100, 0x8), "Your armor is unnaturally cold.  (-50)");
  assert.equal(F.protectionText(-0.25, 200, 0x20), "Your armor itches and burns your skin.  (-50)");
  assert.equal(F.protectionText(-0.5, 100, 0x40), "Your armor is extremely conductive.  (-50)");
  assert.equal(F.protectionText(-0.5, 100, 0x400), "Your armor is infused with shadow.  (-50)");
  assert.equal(F.protectionText(-0.5, null, 0x10), "Your armor is flammable.", "no AL → sentence only");
});

test("protectionText keeps the old paths: no damage type → 'Vulnerable'; positives unchanged", () => {
  assert.equal(F.protectionText(-0.5, 100), "Vulnerable (-50)");
  assert.equal(F.protectionText(-0.5, 100, 0x10000000), "Vulnerable (-50)", "no sentence for that bit");
  assert.equal(F.protectionText(1.0, 150, 0x1), "Average (150)");
  assert.equal(F.protectionText(0, 100, 0x10), "No (0)");
  assert.equal(F.protectionText(-0.0001, 100, 0x10), "No (0)", "|m| ≤ 0.0002 is 'No'");
  assert.equal(F.protectionText(2.5, 100, 0x400), "Unparalleled (200)");
});

test("examine-target.js renders the helpers", () => {
  const src = readFileSync(new URL("../plugins/examine-target.js", import.meta.url), "utf8");
  assert.match(src, /workmanshipText, bondedText, attunedText,\n/);
  assert.match(src, /workmanshipText\(ints\.ItemWorkmanship, ints\.NumItemsInMaterial\)/);
  assert.doesNotMatch(src, /tinkerRows\.push\(\["Workmanship", ints\.ItemWorkmanship\]\)/);
  assert.match(src, /prose\(wrapEl, workmanship\.salvagedLine\)/);
  assert.match(src, /prot\("Nether",\s+ap\.nether,\s+0x0100, 0x400\);/);
  assert.match(src, /prot\("Fire",\s+ap\.fire,\s+0x0020, 0x010\);/);
  assert.match(src, /protectionText\(mod, Number\.isFinite\(AL\) \? AL : null, dtype\)/);
  assert.doesNotMatch(src, /Destroyed on death/);
  assert.doesNotMatch(src, /hook_type/);
  const a = src.indexOf("attunedText(ints.Attuned)");
  const b = src.indexOf("bondedText(ints.Bonded)");
  assert.ok(a > 0 && b > a, "Attuned before Bonded (Appraisal_ShowSpecialProperties order)");
});
