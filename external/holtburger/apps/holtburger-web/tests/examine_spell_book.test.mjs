// tests/examine_spell_book.test.mjs — examine-text-4 (2026-10-13).
//
// ACE AppraiseInfo.AddEnchantments sends every enchantment on an item (and
// wielder auras) as `SpellId | 0x80000000`. The examine panel listed those
// as spells the item carries (getSpellRecord masks the bit, so a buffed
// armor piece read "Impenetrability VI" next to its real spells).
//
// Retail ItemExamineUI::Appraisal_ShowMagicInfo (acclient.c:232515) splits
// the spell book on bit 31 (:232581) into "Spell Descriptions:" ("~ Name:
// description") and a separate "Enchantments:" block, and prints the mana
// cost from ManaRate, else ItemManaCost (int 0x75) — "Mana Cost: %d." with
// "(Can be reduced by the Mana Conversion skill)" when > 0 (:232660-232676).
// A failed appraisal that still carried a spell book prints
// "Spells: unknown." (:232508 / :232717).
//
// Run: node tests/examine_spell_book.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installFakeDom, visibleText } from "./helpers/fake_dom_items.mjs";

const F = await import(new URL("../plugins/examine_format.js", import.meta.url).href);

// ── splitSpellBook ─────────────────────────────────────────────────────

test("splitSpellBook: bit 31 clear = intrinsic, set = enchantment (masked)", () => {
  assert.deepEqual(F.splitSpellBook([0x1234, 0x80000F00]), { intrinsic: [0x1234], enchantments: [0xF00] });
});

test("splitSpellBook: an empty or missing list gives two empties", () => {
  assert.deepEqual(F.splitSpellBook([]), { intrinsic: [], enchantments: [] });
  assert.deepEqual(F.splitSpellBook(undefined), { intrinsic: [], enchantments: [] });
  assert.deepEqual(F.splitSpellBook(null), { intrinsic: [], enchantments: [] });
  assert.deepEqual(F.splitSpellBook("2"), { intrinsic: [], enchantments: [] });
});

test("splitSpellBook: exactly 0x80000000 masks to 0", () => {
  assert.deepEqual(F.splitSpellBook([0x80000000]), { intrinsic: [], enchantments: [0] });
  assert.equal(F.SPELL_BOOK_ENCHANTMENT_BIT, 0x80000000);
});

test("splitSpellBook: wire order and duplicates are kept; typed arrays work", () => {
  const ids = [2, 0x80000F00, 3, 0x80000F00, 0x80000001];
  assert.deepEqual(F.splitSpellBook(ids), { intrinsic: [2, 3], enchantments: [0xF00, 0xF00, 1] });
  assert.deepEqual(F.splitSpellBook(Uint32Array.from(ids)), { intrinsic: [2, 3], enchantments: [0xF00, 0xF00, 1] });
});

// ── manaCostText ───────────────────────────────────────────────────────

test("manaCostText: ItemManaCost 50 with no ManaRate gives 'Mana Cost: 50.' + the Mana Conversion note", () => {
  assert.deepEqual(F.manaCostText({ ItemManaCost: 50 }, {}), {
    value: "50",
    text: "Mana Cost: 50.",
    note: "(Can be reduced by the Mana Conversion skill)",
  });
});

test("manaCostText: ItemManaCost <= 0 prints the bare line (iManaCost <= 0 branch)", () => {
  assert.deepEqual(F.manaCostText({ ItemManaCost: 0 }, {}), { value: "0", text: "Mana Cost: 0.", note: null });
  assert.equal(F.manaCostText({ ItemManaCost: -3 }).text, "Mana Cost: -3.");
  assert.equal(F.manaCostText({ ItemManaCost: -3 }).note, null);
});

test("manaCostText: ManaRate gives '1 point per N seconds' with (unsigned)(|1/rate| + 0.5)", () => {
  assert.deepEqual(F.manaCostText({}, { ManaRate: -1 / 30 }), {
    value: "1 point per 30 seconds",
    text: "Mana Cost: 1 point per 30 seconds.",
    note: null,
  });
  // 1 / 0.0333 = 30.03 → 30.
  assert.equal(F.manaCostText({}, { ManaRate: -0.0333 }).value, "1 point per 30 seconds");
  // 1 / 0.4 = 2.5 → 3 (+0.5 then truncate).
  assert.equal(F.manaCostText({}, { ManaRate: -0.4 }).value, "1 point per 3 seconds");
  // Retail takes the absolute value, so a positive rate reads the same.
  assert.equal(F.manaCostText({}, { ManaRate: 0.05 }).value, "1 point per 20 seconds");
});

test("manaCostText: ManaRate wins over ItemManaCost; a zero rate does not fall through", () => {
  assert.equal(F.manaCostText({ ItemManaCost: 50 }, { ManaRate: -0.05 }).text, "Mana Cost: 1 point per 20 seconds.");
  assert.equal(F.manaCostText({ ItemManaCost: 50 }, { ManaRate: 0 }), null);
});

test("manaCostText: neither property → null", () => {
  assert.equal(F.manaCostText({}, {}), null);
  assert.equal(F.manaCostText(), null);
  assert.equal(F.manaCostText({ ItemManaCost: "" }, { ManaRate: "" }), null);
});

// ── examine-target.js wiring (source pins) ─────────────────────────────

test("examine-target.js imports the helpers and drops the old mana-rate text", () => {
  const src = readFileSync(new URL("../plugins/examine-target.js", import.meta.url), "utf8");
  assert.match(src, /splitSpellBook, manaCostText,\n/);
  assert.match(src, /const \{ intrinsic, enchantments \} = splitSpellBook\(sb\);/);
  assert.match(src, /const manaCost = manaCostText\(ints, floats\);/);
  assert.match(src, /sec\("Enchantments"\);\n\s+wrapEl\.appendChild\(spellListEl\(enchantments\)\);/);
  assert.doesNotMatch(src, /1 every \$\{secs\} s/);
  assert.match(src, /\(identifyFlags & IDENTIFY_FLAG_SPELL_BOOK\) !== 0\) \{\n\s+prose\(wrapEl, "Spells: unknown\."\);/);
});

// ── examine panel DOM (fake DOM, real mountExamineBody) ────────────────

globalThis.window = globalThis;
installFakeDom(globalThis);

const SPELLS = new Map([
  [2, { name: "Strength Other I", description: "Increases the target's Strength by 10 points.", iconId: 0 }],
  [0xF00, { name: "Impenetrability VI", description: "Improves a shield or piece of armor's armor value by 160 points.", iconId: 0 }],
]);
const spellRecordCalls = [];
const ITEMS = [
  { guid: 0x50000001, name: "Chainmail Hauberk", value: 1250, stackSize: 1, itemType: 0x2, equipMask: 0, validLocations: 0x600, iconId: 0 },
  { guid: 0x50000002, name: "Mysterious Ring", value: 10, stackSize: 1, itemType: 0x8, equipMask: 0, validLocations: 0, iconId: 0 },
  { guid: 0x50000003, name: "Plain Ring", value: 10, stackSize: 1, itemType: 0x8, equipMask: 0, validLocations: 0, iconId: 0 },
];
const emptyProps = { ints: {}, int64s: {}, bools: {}, floats: {}, strings: {}, dids: {} };
const APPRAISALS = new Map([
  [0x50000001, {
    identifySuccess: true, identifyFlags: 0,
    properties: { ints: { Value: 1250, ItemSpellcraft: 150, ItemMaxMana: 800, ItemCurMana: 400, ItemManaCost: 50 }, floats: {}, strings: {}, bools: {} },
    spellBook: [2, 0x80000F00],
  }],
  [0x50000002, { identifySuccess: false, identifyFlags: 0x0010, properties: emptyProps, spellBook: [] }],
  [0x50000003, { identifySuccess: false, identifyFlags: 0, properties: emptyProps, spellBook: [] }],
]);
window.__sessionHandle = {
  playerInventory: () => ITEMS,
  getObjectAppraisal: (g) => (APPRAISALS.has(g) ? JSON.stringify(APPRAISALS.get(g)) : undefined),
  requestAppraisal: () => {},
  getObjectInscription: () => undefined,
  getSpellRecord: (id) => {
    spellRecordCalls.push(id >>> 0);
    const r = SPELLS.get(id >>> 0);
    return r ? new Map(Object.entries(r)) : null;
  },
};
window.__pluginClient = { events: { on() {}, off() {}, emit() {} } };

const exa = await import(new URL("../plugins/examine-target.js", import.meta.url).href);

function mount(guid) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const cleanup = exa.mountExamineBody(host, { guid, fromInventory: true });
  const wrap = host.querySelector(".hb-exa-appraisal-wrap");
  return { host, wrap, done: () => { cleanup?.(); host.remove(); } };
}

test("panel: intrinsic spells under Magic with descriptions, enchantments in their own section", () => {
  const { wrap, done } = mount(0x50000001);
  try {
    const kids = wrap.children;
    const titleIdx = (t) => kids.findIndex((k) => k.classList.contains("hbk-section-title") && k.textContent === t);
    const magic = titleIdx("Magic");
    const ench = titleIdx("Enchantments");
    assert.ok(magic >= 0, "Magic section");
    assert.ok(ench > magic, "Enchantments section after Magic");
    const magicBlock = kids.slice(magic + 1, ench).map((k) => visibleText(k)).join(" | ");
    assert.match(magicBlock, /Strength Other I Increases the target's Strength by 10 points\./);
    assert.doesNotMatch(magicBlock, /Impenetrability/, "an enchantment is not listed as an item spell");
    assert.match(magicBlock, /Mana cost 50/);
    assert.match(magicBlock, /\(Can be reduced by the Mana Conversion skill\)/);
    const enchList = kids[ench + 1];
    assert.ok(enchList.classList.contains("hb-exa-spelllist"), "the enchantment list follows its title");
    assert.match(visibleText(enchList), /^Impenetrability VI Improves a shield or piece of armor's armor value by 160 points\.$/);
    const entry = enchList.querySelector(".hb-exa-spell");
    assert.ok(entry.classList.contains("has-desc"));
    assert.equal(entry.querySelector(".hb-exa-spell-desc").textContent, "Improves a shield or piece of armor's armor value by 160 points.");
    assert.ok(spellRecordCalls.length > 0);
    assert.ok(spellRecordCalls.every((id) => id < 0x80000000), `masked lookups only: ${spellRecordCalls}`);
    assert.doesNotMatch(visibleText(wrap), /Unknown spell/);
  } finally { done(); }
});

test("panel: a failed appraisal that flagged a spell book reads 'Spells: unknown.'", () => {
  const a = mount(0x50000002);
  try {
    assert.match(visibleText(a.wrap), /Your skill is not high enough to identify this item\..*Spells: unknown\./);
  } finally { a.done(); }
  const b = mount(0x50000003);
  try {
    assert.doesNotMatch(visibleText(b.wrap), /Spells: unknown/);
  } finally { b.done(); }
});
