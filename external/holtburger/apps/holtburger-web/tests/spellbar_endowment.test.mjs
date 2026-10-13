// tests/spellbar_endowment.test.mjs — hud-ui-8 (2026-10-13).
//
// The spell bar's ENDOWMENT icon (retail gmSpellcastingUI m_endowmentIcon,
// element 0x100000B1): the held caster's built-in spell as a selectable,
// castable cell ahead of slot 1. ui/ac_spell_endowment.js carries the rules:
//   - findEndowment = UpdateEndowmentIcon (acclient.c:247815): THE object at
//     the Held location (0x1000000), Caster ItemType bit 0x8000, a PWD
//     _spellID (PropertyDataId 28);
//   - endowmentWalk = RecvNotice_Next/Prev/First/LastSpellSelection
//     (:248837-249140): order [endowment, 0..N-1], wrapping;
//   - endowmentCastAction = Cast (:247774) → ItemHolder::UseObject(item, 1, 1)
//     (:433354): UseWithTarget on the selection, the 0x1A "Select your
//     target before using the %s" line, Use, or "The %s cannot be used";
//   - the "%s (%hs)\nDouble-click to cast this spell" tooltip.
// Plus the glue combat-bar.js calls (readEndowment / castEndowment) against
// a recording fake SessionHandle, and source pins on the combat-bar wiring.
//
// Run from apps/holtburger-web/:  node tests/spellbar_endowment.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");

// showTransientLine writes through window.__appendChatLine.
const chatLines = [];
globalThis.window = globalThis.window ?? globalThis;
globalThis.window.__appendChatLine = (text, category) => { chatLines.push([text, category]); };

const E = await import(pathToFileURL(path.join(APP, "ui", "ac_spell_endowment.js")).href);
const { importedNames } = await import(pathToFileURL(path.join(APP, "harness", "lib", "splice_module.mjs")).href);

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${e.stack || e.message}`); }
}

const WAND = 0x60000010;
const ORB = 0x60000011;
const SWORD = 0x60000012;
const TARGET = 0x50000099;
const SPELL = 1785;
const HELD = 0x01000000;
const row = (extra) => ({
  guid: WAND, name: "Wand", itemType: 0x8000, equipMask: HELD, iconId: 0x06001234, uiEffects: 0, ...extra,
});
const didsFor = (map) => (guid, stype) => (stype === 28 ? (map[guid] ?? 0) : 0);

console.log("\n[1] findEndowment — UpdateEndowmentIcon's item test");
await check("the Held caster with a spell id is the endowment", () => {
  const e = E.findEndowment([row({ guid: SWORD, itemType: 0x1, equipMask: 0x00100000 }), row()], didsFor({ [WAND]: SPELL }));
  assert.deepEqual(e, { guid: WAND, spellId: SPELL, name: "Wand", iconId: 0x06001234, itemType: 0x8000, uiEffects: 0 });
});
await check("a Held non-caster (no 0x8000 ItemType bit) is no endowment", () => {
  assert.equal(E.findEndowment([row({ itemType: 0x1 })], didsFor({ [WAND]: SPELL })), null);
});
await check("a Held caster without a spell id (did 28 = 0 / unknown) is no endowment", () => {
  assert.equal(E.findEndowment([row()], didsFor({})), null);
  assert.equal(E.findEndowment([row()], () => undefined), null);
});
await check("a caster with a spell that is NOT Held (pack, other slot) is no endowment", () => {
  assert.equal(E.findEndowment([row({ equipMask: 0 })], didsFor({ [WAND]: SPELL })), null);
  assert.equal(E.findEndowment([row({ equipMask: 0x00800000 })], didsFor({ [WAND]: SPELL })), null);
});
await check("retail takes THE Held object: a held non-caster hides a pack caster", () => {
  const rows = [row({ guid: ORB, itemType: 0x80 }), row({ guid: WAND, equipMask: 0 })];
  assert.equal(E.findEndowment(rows, didsFor({ [WAND]: SPELL, [ORB]: SPELL })), null);
});
await check("junk input → null, a throwing reader → null", () => {
  assert.equal(E.findEndowment(null, () => SPELL), null);
  assert.equal(E.findEndowment([row()], () => { throw new Error("x"); }), null);
});

console.log("\n[2] endowmentWalk — the Next/Prev/First/Last selection walks");
const BOUND = [0, 2, 5];
const walk = (cur, op, present = true) => E.endowmentWalk(BOUND, cur, op, present);
await check("next: endowment → 0 → 2 → 5 → endowment (wraps through the endowment)", () => {
  const seen = [];
  let cur = E.ENDOWMENT;
  for (let i = 0; i < 4; i++) { cur = walk(cur, "next"); seen.push(cur); }
  assert.deepEqual(seen, [0, 2, 5, E.ENDOWMENT]);
});
await check("prev: endowment → 5 → 2 → 0 → endowment", () => {
  const seen = [];
  let cur = E.ENDOWMENT;
  for (let i = 0; i < 4; i++) { cur = walk(cur, "prev"); seen.push(cur); }
  assert.deepEqual(seen, [5, 2, 0, E.ENDOWMENT]);
});
await check("first = the endowment, last = the last bound cell", () => {
  assert.equal(walk(2, "first"), E.ENDOWMENT);
  assert.equal(walk(E.ENDOWMENT, "last"), 5);
});
await check("nothing selected → the first item either way (retail which = 0)", () => {
  assert.equal(walk(-1, "next"), 0);
  assert.equal(walk(-1, "prev"), 0);
});
await check("an empty tab with the endowment present → the endowment for every op", () => {
  for (const op of ["next", "prev", "first", "last"]) {
    assert.equal(E.endowmentWalk([], -1, op, true), E.ENDOWMENT, op);
  }
});
await check("no endowment → the strip's old wrap, unchanged (prev from nothing = last)", () => {
  assert.equal(walk(-1, "next", false), 0);
  assert.equal(walk(-1, "prev", false), 5);
  assert.equal(walk(5, "next", false), 0);
  assert.equal(walk(0, "prev", false), 5);
  assert.equal(walk(2, "first", false), 0);
  assert.equal(walk(2, "last", false), 5);
  assert.equal(E.endowmentWalk([], -1, "next", false), null);
});

console.log("\n[3] endowmentCastAction — ItemHolder::UseObject(item, 1, 1)");
const wand = { guid: WAND, name: "Wand" };
await check("targeted, nothing selected → the 0x1A 'Select your target before using the Wand'", () => {
  const a = E.endowmentCastAction(wand, { targeted: true, selectedGuid: 0 });
  assert.equal(a.transient, "Select your target before using the Wand");
  assert.equal(a.reason, "noSelection");
  assert.equal(a.useWithTarget, undefined);
});
await check("targeted with a selection → UseWithTarget(item, target)", () => {
  assert.deepEqual(E.endowmentCastAction(wand, { targeted: true, selectedGuid: TARGET }), { useWithTarget: [WAND, TARGET] });
});
await check("untargeted → Use(item)", () => {
  assert.deepEqual(E.endowmentCastAction(wand, { targeted: false, selectedGuid: TARGET }), { use: WAND });
});
await check("targeted is IsUseable_Targeted(ItemUseable) when not given", () => {
  // LSD casters with a built-in spell: 0x600004 / 0x200008 / 0xA0004.
  for (const u of [0x600004, 0x200008, 0xa0004]) {
    assert.equal(E.isUseableTargeted(u), true, u.toString(16));
    assert.deepEqual(E.endowmentCastAction(wand, { useable: u, selectedGuid: TARGET }), { useWithTarget: [WAND, TARGET] });
  }
  assert.equal(E.isUseableTargeted(0x8), false);
  assert.deepEqual(E.endowmentCastAction(wand, { useable: 0x8 }), { use: WAND });
});
await check("USEABLE_NO (bit 1) untargeted → 'The Wand cannot be used', nothing sent", () => {
  const a = E.endowmentCastAction(wand, { useable: 0x1 });
  assert.equal(a.transient, "The Wand cannot be used");
  assert.equal(a.reason, "notUseable");
});
await check("no item → none", () => {
  assert.deepEqual(E.endowmentCastAction(null, { targeted: true, selectedGuid: TARGET }), { none: true });
});

console.log("\n[4] texts, layers and the flag");
await check("tooltip = '%s (%hs)\\nDouble-click to cast this spell', label = '%s (%hs)'", () => {
  assert.equal(E.endowmentTooltip("Wand", "Flame Bolt I"), "Wand (Flame Bolt I)\nDouble-click to cast this spell");
  assert.equal(E.endowmentLabel("Wand", "Flame Bolt I"), "Wand (Flame Bolt I)");
});
await check("background: the drag icon paints OVER the spell icon (first layer on top)", () => {
  assert.equal(E.endowmentBackground({ spell: "data:s", item: "data:i" }), 'url("data:i"), url("data:s")');
  assert.equal(E.endowmentBackground({ spell: "data:s", item: null }), 'url("data:s")');
  assert.equal(E.endowmentBackground({}), "");
});
await check("?spellbarEndowment: default ON; off / 0 / false disable", () => {
  assert.equal(E.spellbarEndowmentEnabled(""), true);
  assert.equal(E.spellbarEndowmentEnabled("?spellbarEndowment=on"), true);
  for (const v of ["off", "0", "false", "OFF"]) {
    assert.equal(E.spellbarEndowmentEnabled(`?spellbarEndowment=${v}`), false, v);
  }
});
await check("wield events: the local player's or the endowment item's count, others do not", () => {
  const ME = 0x50000001;
  assert.equal(E.wieldEventMarksEndowment({ u32Payload: WAND, u32Payload2: ME }, ME, 0), true);
  assert.equal(E.wieldEventMarksEndowment({ u32Payload: WAND, u32Payload2: 0x50000777 }, ME, WAND), true);
  assert.equal(E.wieldEventMarksEndowment({ u32Payload: 0x7000AAAA, u32Payload2: 0x50000777 }, ME, WAND), false);
  assert.equal(E.wieldEventMarksEndowment(null, ME, WAND), true, "unreadable → refresh");
});

console.log("\n[5] glue — readEndowment / castEndowment against a recording handle");
function fakeHandle({ items, dids = {}, useable = {}, spellName = "Flame Bolt I", withSends = true } = {}) {
  const calls = [];
  let freed = 0;
  const h = {
    playerInventory: () => items.map((r) => ({ ...r, free() { freed++; } })),
    objectDataIdProperty: (g, k) => dids[`${g >>> 0}:${k}`],
    objectIntProperty: (g, k) => (k === 16 ? useable[g >>> 0] : undefined),
    getSpellRecord: (id) => (id === SPELL ? new Map([["name", spellName]]) : null),
  };
  if (withSends) {
    h.useWithTarget = (a, b) => calls.push(["useWithTarget", a >>> 0, b >>> 0]);
    h.useObject = (g) => calls.push(["useObject", g >>> 0]);
  }
  return { h, calls, freedCount: () => freed };
}
await check("readEndowment: the Held caster + its drag-icon inputs; snapshot boxes freed", () => {
  const f = fakeHandle({
    items: [row({ guid: SWORD, itemType: 0x1, equipMask: 0x00100000 }), row()],
    dids: { [`${WAND}:28`]: SPELL, [`${WAND}:50`]: 0x06005555, [`${WAND}:52`]: 0x06006666 },
  });
  const e = E.readEndowment(f.h);
  assert.equal(e.guid, WAND);
  assert.equal(e.spellId, SPELL);
  assert.deepEqual(e.iconMeta, {
    iconId: 0x06001234, itemType: 0x8000, uiEffects: 0, iconOverlay: 0x06005555, iconUnderlay: 0x06006666,
  });
  assert.equal(f.freedCount(), 2, "every playerInventory() box freed");
  assert.equal(E.readSpellName(f.h, SPELL), "Flame Bolt I");
  assert.equal(E.readSpellName(f.h, 1), null);
});
await check("readEndowment: no handle / no inventory getter → null", () => {
  assert.equal(E.readEndowment(null), null);
  assert.equal(E.readEndowment({}), null);
});
await check("castEndowment: targeted + selection → useWithTarget(item, target)", () => {
  const f = fakeHandle({ items: [row()], useable: { [WAND]: 0x600004 } });
  const a = E.castEndowment(f.h, wand, { targetGuid: TARGET, now: 10_000 });
  assert.deepEqual(a, { useWithTarget: [WAND, TARGET] });
  assert.deepEqual(f.calls, [["useWithTarget", WAND, TARGET]]);
});
await check("castEndowment: inside retail's 0.2 s use throttle → dropped", () => {
  const f = fakeHandle({ items: [row()], useable: { [WAND]: 0x600004 } });
  assert.deepEqual(E.castEndowment(f.h, wand, { targetGuid: TARGET, now: 10_100 }), { throttled: true });
  assert.deepEqual(f.calls, []);
});
await check("castEndowment: targeted, nothing selected → transient line (category 9), nothing sent", () => {
  const f = fakeHandle({ items: [row()], useable: { [WAND]: 0x600004 } });
  chatLines.length = 0;
  const a = E.castEndowment(f.h, wand, { targetGuid: 0, now: 20_000 });
  assert.equal(a.reason, "noSelection");
  assert.deepEqual(chatLines, [["Select your target before using the Wand", 9]]);
  assert.deepEqual(f.calls, []);
});
await check("castEndowment: untargeted → useObject(item)", () => {
  const f = fakeHandle({ items: [row()], useable: { [WAND]: 0x8 } });
  E.castEndowment(f.h, wand, { targetGuid: TARGET, now: 30_000 });
  assert.deepEqual(f.calls, [["useObject", WAND]]);
});
await check("castEndowment: a stale pkg/ without the send getters does not throw", () => {
  const f = fakeHandle({ items: [row()], useable: { [WAND]: 0x600004 }, withSends: false });
  assert.deepEqual(E.castEndowment(f.h, wand, { targetGuid: TARGET, now: 40_000 }), { useWithTarget: [WAND, TARGET] });
});

console.log("\n[6] combat-bar wiring (source pins)");
const cb = readFileSync(path.join(APP, "plugins", "combat-bar.js"), "utf8");
await check("combat-bar loads the endowment module lazily, never as a static import", () => {
  assert.match(cb, /import\("\.\.\/ui\/ac_spell_endowment\.js"\)\.then\(\(m\) => \{\s*if \(!m\.spellbarEndowmentEnabled\(\)\) return;/);
  const names = importedNames(cb);
  for (const n of ["findEndowment", "endowmentWalk", "castEndowment", "readEndowment", "spellbarEndowmentEnabled"]) {
    assert.equal(names.has(n), false, `${n} must not be a static import (splice suites stub every one)`);
  }
});
await check("Cast takes the endowment first; the walks route through endowmentWalk", () => {
  assert.match(cb, /function castCurrent\(\) \{\s*if \(endowLib && endowmentActive\(\)\) \{ castEndowmentNow\(\); return; \}/);
  assert.match(cb, /function selectDelta\(dir\) \{\s*if \(endowLib && endowment\) \{ walkWithEndowment\(dir > 0 \? "next" : "prev"\); return; \}/);
  assert.match(cb, /function selectEdge\(which\) \{\s*if \(endowLib && endowment\) \{ walkWithEndowment\(which === "last" \? "last" : "first"\); return; \}/);
});
await check("the cell sits ahead of slot 1 and is a .hb-ss-slot (ring, cast sweep, drag exemption)", () => {
  assert.match(cb, /endowEl\.className = "hbk-slot hb-ss-slot hb-ss-endow";/);
  const cell = cb.indexOf("slotsWrap.appendChild(endowEl);");
  const loop = cb.indexOf("for (let i = 0; i < SPELL_BAR_SLOTS; i++) {");
  assert.ok(cell > 0 && loop > cell, "endowment appended before the slot cells");
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
