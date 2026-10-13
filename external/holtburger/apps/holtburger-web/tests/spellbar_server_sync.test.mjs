// tests/spellbar_server_sync.test.mjs — input-options-2 / hud-ui-2
// (2026-10-13): the 8 spell-bar tabs and the spellbook filter word are kept
// on the server per character, as in retail.
//
// Retail SpellCastSubMenu::AddSpellToPlayerModule / RemoveSpellFromPlayerModule
// (acclient.c:247988 / :247949) send Event_AddSpellFavorite(spell, pos, tab) /
// Event_RemoveSpellFavorite(spell, tab); each tab is an ordered list
// (PlayerModule::AddSpellFavorite :512742 = PackableList::InsertPos);
// UpdateFromPlayerModule (:248027) prunes favourites the character no longer
// knows with a RemoveSpellFavorite each; gmSpellbookUI::UpdateFilter
// (:198845) sends the whole filter word. ACE (CharacterExtensions.
// AddSpellToBar) inserts at min(index, count), ignores a spell already on
// the bar and one the character does not know.
//
//   [1] pure helpers (plugins/spellbar_sync.js): compactIndex, server lists
//       → 18-cell tabs, diff ops (a move = [Remove, Add], an insert = [Add];
//       a randomised replay through ACE's rules always lands on the new
//       order), prune, hydration (server wins / cached gaps kept / migration
//       upload), flush (overflow kept), filter word keeps Level_9, the
//       per-character store under its own localStorage key, and the
//       rebuild-from-mirror guard.
//   [2] the REAL plugins/spellbook.js on a fake session that keeps an
//       ACE-rules server model: per-character tabs, hydration, every edit
//       (place, combat-bar swap, clear, tab drop) leaves the server holding
//       the tab's cells in order, prune on a forgotten spell, filter word,
//       second-character migration, re-login keeps the cached gaps,
//       logged-out / stale-pkg paths, and the regression: combat-bar.js's
//       stale wholesale saveState of `holtburger_combat_bar_v1` (panel
//       opened before login) no longer reverts the tabs or makes the next
//       flush remove the server's favourites.
//   [3] NEGATIVE CONTROL `?serverSpellBars=off`: the old per-browser bars,
//       nothing on the wire.
//   [4] source pins for the Rust side (opcodes, GameAction, SessionHandle
//       exports, command routing) — the orchestrator compiles + runs the
//       Rust tests.
//
// Run from apps/holtburger-web/:  node tests/spellbar_server_sync.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as S from "../plugins/spellbar_sync.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
const HOLT = path.resolve(APP, "..", "..");

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  [FAIL] ${name} — ${err.stack || err.message}`);
  }
}

const EMPTY = () => new Array(18).fill(0);
const tabOf = (cells) => { const t = EMPTY(); cells.forEach((v, i) => { t[i] = v; }); return t; };
const replay = (list, ops) => ops.reduce((l, o) => S.applySpellBarOp(l, o), list);

// ── [1] pure helpers ────────────────────────────────────────────────────
console.log("## [1] spellbar_sync.js pure helpers");

await check("?serverSpellBars: default on, off/0/false turn it off", () => {
  assert.equal(S.serverSpellBarsEnabled(""), true);
  assert.equal(S.serverSpellBarsEnabled("?serverSpellBars=on"), true);
  for (const v of ["off", "0", "false"]) assert.equal(S.serverSpellBarsEnabled(`?serverSpellBars=${v}`), false, v);
});

await check("compactTab / compactIndex: cells in order, gaps dropped", () => {
  const tab = tabOf([5, 0, 7, 0, 0, 9]);
  assert.deepEqual(S.compactTab(tab), [5, 7, 9]);
  assert.equal(S.compactIndex(tab, 0), 0);
  assert.equal(S.compactIndex(tab, 2), 1);
  assert.equal(S.compactIndex(tab, 5), 2);
  assert.equal(S.compactIndex(tab, 17), 3);
  assert.deepEqual(S.compactTab([4, 4, 0, 6]), [4, 6], "first copy wins");
});

await check("server lists → 18-cell tabs filled from cell 0, the rest in overflow", () => {
  const long = Array.from({ length: 20 }, (_, i) => 100 + i);
  const { tabs, overflow } = S.serverListsToTabs([[21, 13], [], long]);
  assert.equal(tabs.length, 8);
  for (const t of tabs) assert.equal(t.length, 18);
  assert.deepEqual(tabs[0], tabOf([21, 13]));
  assert.deepEqual(tabs[1], EMPTY());
  assert.deepEqual(tabs[2], long.slice(0, 18));
  assert.deepEqual(overflow[2], [118, 119]);
  assert.deepEqual(overflow[0], []);
});

await check("diff: a move is [Remove, Add] at the final index; an insert is one Add", () => {
  assert.deepEqual(S.diffSpellBarOps([1, 2, 3], [2, 3, 1], 4), [
    { op: "remove", spell: 1, list: 4 },
    { op: "add", spell: 1, index: 2, list: 4 },
  ]);
  const newTab = tabOf([1, 0, 9, 2]);
  const ops = S.diffSpellBarOps([1, 2], newTab, 0);
  assert.deepEqual(ops, [{ op: "add", spell: 9, index: 1, list: 0 }]);
  assert.equal(ops[0].index, S.compactIndex(newTab, 2), "the Add carries the cell's compact index");
  assert.deepEqual(S.diffSpellBarOps([1, 2, 3], tabOf([1, 0, 3]), 0), [{ op: "remove", spell: 2, list: 0 }]);
  assert.deepEqual(S.diffSpellBarOps([1, 2], [1, 2], 0), []);
});

await check("diff: replaying the ops with ACE's rules always lands on the new order (300 random cases)", () => {
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const pick = () => {
    const pool = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const out = [];
    const n = rnd(9);
    for (let i = 0; i < n; i++) out.push(pool.splice(rnd(pool.length), 1)[0]);
    return out;
  };
  for (let k = 0; k < 300; k++) {
    const from = pick();
    const to = pick();
    const ops = S.diffSpellBarOps(from, to, 0);
    assert.deepEqual(replay(from, ops), to, `${from} → ${to}`);
    const adds = ops.filter((o) => o.op === "add").length;
    assert.ok(adds <= to.length, "never more Adds than spells");
  }
});

await check("prune: unknown spells leave their cell (gaps kept) with one Remove each; empty known prunes nothing", () => {
  const { tabs, removed } = S.pruneUnknownSpells([tabOf([1, 0, 2, 3]), tabOf([2])], new Set([1, 3]));
  assert.deepEqual(tabs[0], tabOf([1, 0, 0, 3]));
  assert.deepEqual(tabs[1], EMPTY());
  assert.deepEqual(removed, [
    { op: "remove", spell: 2, list: 0 },
    { op: "remove", spell: 2, list: 1 },
  ]);
  assert.deepEqual(S.pruneUnknownSpells([tabOf([1, 2])], new Set()).removed, []);
});

await check("hydrate: server wins, unknown favourites pruned with RemoveSpellFavorite", () => {
  const plan = S.planSpellBarHydration({
    serverLists: [[21, 99, 13], [], [], [], [], [], [], []],
    record: null,
    legacyTabs: [tabOf([11, 0, 12])],
    known: new Set([21, 13, 11, 12]),
  });
  assert.deepEqual(plan.ops, [{ op: "remove", spell: 99, list: 0 }]);
  assert.deepEqual(plan.tabs[0], tabOf([21, 13]), "filled from cell 0");
  assert.deepEqual(plan.mirror[0], [21, 13]);
  assert.equal(plan.tabs.length, 8);
});

await check("hydrate: the cached layout keeps its gaps only while its order matches", () => {
  const known = new Set([1, 2, 3]);
  const same = S.planSpellBarHydration({
    serverLists: [[1, 2]], record: { tabs: [tabOf([1, 0, 0, 2])], synced: true }, known,
  });
  assert.deepEqual(same.tabs[0], tabOf([1, 0, 0, 2]));
  assert.deepEqual(same.ops, []);
  const moved = S.planSpellBarHydration({
    serverLists: [[2, 1]], record: { tabs: [tabOf([1, 0, 0, 2])], synced: true }, known,
  });
  assert.deepEqual(moved.tabs[0], tabOf([2, 1]), "edited elsewhere → the server's order");
});

await check("hydrate: synced character + empty server = emptied elsewhere (no upload)", () => {
  const plan = S.planSpellBarHydration({
    serverLists: [[], [], [], [], [], [], [], []],
    record: { tabs: [tabOf([1, 2])], synced: true },
    legacyTabs: [tabOf([3])],
    known: new Set([1, 2, 3]),
  });
  assert.deepEqual(plan.ops, []);
  assert.deepEqual(plan.tabs[0], EMPTY());
});

await check("hydrate (migration): empty server + never synced → the local bars uploaded once, known spells only", () => {
  const legacy = [tabOf([11, 0, 12, 14]), tabOf([0, 15])];
  const plan = S.planSpellBarHydration({
    serverLists: [[], [], [], [], [], [], [], []], record: null, legacyTabs: legacy,
    known: new Set([11, 14, 15]),
  });
  assert.deepEqual(plan.ops, [
    { op: "add", spell: 11, index: 0, list: 0 },
    { op: "add", spell: 14, index: 1, list: 0 },
    { op: "add", spell: 15, index: 0, list: 1 },
  ]);
  assert.deepEqual(plan.tabs[0], tabOf([11, 0, 0, 14]), "unknown 12 cleared, gaps kept");
  assert.deepEqual(plan.mirror[0], [11, 14]);
  const fromRecord = S.planSpellBarHydration({
    serverLists: [], record: { tabs: [tabOf([15])], synced: false }, legacyTabs: legacy,
    known: new Set([11, 14, 15]),
  });
  assert.deepEqual(fromRecord.ops, [{ op: "add", spell: 15, index: 0, list: 0 }], "an unsynced cache beats the legacy bars");
});

await check("flush: server entries past the 18 cells stay at the end; unknown spells left off; missing tab untouched", () => {
  const long = Array.from({ length: 20 }, (_, i) => 100 + i);
  const hyd = S.planSpellBarHydration({ serverLists: [long, [7]], known: new Set([...long, 7, 50]) });
  const tabs = hyd.tabs.map((t) => t.slice());
  tabs[0][3] = 0; // clear 103
  tabs[0][17] = 119; // file an overflow spell on a cell (replaces 117)
  const plan = S.planSpellBarFlush(hyd.mirror, tabs.slice(0, 1), hyd.overflow, new Set([...long, 7]));
  // cells: 100..116 minus 103, then 119 in cell 17; overflow 118 stays at the end
  assert.deepEqual(plan.mirror[0], [...long.slice(0, 17).filter((id) => id !== 103), 119, 118]);
  assert.deepEqual(replay(hyd.mirror[0], plan.ops.filter((o) => o.list === 0)), plan.mirror[0]);
  assert.deepEqual(plan.overflow[0], [118], "119 is on a cell now");
  assert.deepEqual(plan.mirror[1], [7], "tab 1 not in `tabs` → left as it is");
  assert.equal(plan.ops.some((o) => o.list === 1), false);
});

await check("filter word: FilterBox bits from the mask, Level_9 0x1000 as the server sent it", () => {
  assert.equal(S.spellbookFilterWord(0x2FFF, 0x3FFF), 0x3FFF);
  assert.equal(S.spellbookFilterWord(0x2FFF & ~0x8, 0x3FFF), 0x3FF7);
  assert.equal(S.spellbookFilterWord(0x2FFF, 0x2FFF), 0x2FFF, "server without 0x1000 stays without it");
});

await check("per-character store: its own localStorage key (not the combat-bar blob), other characters kept", () => {
  assert.equal(S.SPELL_BARS_BY_CHAR_KEY, "holtburger_spell_bars_by_char_v1");
  assert.notEqual(S.SPELL_BARS_BY_CHAR_KEY, "holtburger_combat_bar_v1",
    "combat-bar.js writes that blob back wholesale from a stale snapshot");
  const key = S.spellBarCharKey(0x50000001);
  assert.equal(key, "50000001");
  const store = S.writeCharSpellBars({ 50000002: { tabs: [tabOf([7])], synced: true } }, key, [tabOf([21, 0, 13])], true);
  const back = JSON.parse(JSON.stringify(store));
  assert.deepEqual(S.readCharSpellBars(back, key), { tabs: [tabOf([21, 0, 13])], synced: true });
  assert.deepEqual(S.readCharSpellBars(back, "50000002"), { tabs: [tabOf([7])], synced: true });
  S.writeCharSpellBars(back, key, [tabOf([13])]);
  assert.equal(S.readCharSpellBars(back, key).synced, true, "undefined keeps the stored flag");
  assert.equal(S.readCharSpellBars(back, "50000003"), null);
  assert.equal(S.readCharSpellBars(null, key), null);
});

await check("rebuild guard: tabs a record lacks come from the server lists; tabs it has are kept", () => {
  const mirror = [[21, 13], [22], [], [], [], [], [], []];
  const none = S.fillTabsFromMirror([], mirror);
  assert.equal(none.rebuilt, true);
  assert.equal(none.tabs.length, 8);
  assert.deepEqual(none.tabs[0], tabOf([21, 13]));
  assert.deepEqual(none.tabs[1], tabOf([22]));
  const short = S.fillTabsFromMirror([tabOf([0, 13, 0, 21])], mirror);
  assert.deepEqual(short.tabs[0], tabOf([0, 13, 0, 21]), "a tab the record has keeps its layout");
  assert.deepEqual(short.tabs[1], tabOf([22]));
  const full = S.fillTabsFromMirror(Array.from({ length: 8 }, () => EMPTY()), mirror);
  assert.equal(full.rebuilt, false, "a whole record is never overridden");
  assert.deepEqual(S.fillTabsFromMirror([], null), { tabs: [], rebuilt: false }, "no mirror (no wire) = nothing to rebuild from");
});

// ── shared fake browser for [2]/[3] ─────────────────────────────────────
globalThis.window = globalThis;
const events = [];
window.addEventListener = () => {};
window.removeEventListener = () => {};
window.dispatchEvent = (ev) => { events.push(ev?.type); return true; };
globalThis.document = globalThis.document || {
  createElement: () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {} }, appendChild() {}, setAttribute() {}, addEventListener() {} }),
  getElementById: () => null, head: { appendChild() {}, prepend() {} }, body: { appendChild() {} },
  addEventListener() {}, removeEventListener() {}, documentElement: { style: { setProperty() {} } },
};
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
const KEY = "holtburger_combat_bar_v1";
const blob = () => JSON.parse(localStorage.getItem(KEY) || "{}");
const charStore = () => JSON.parse(localStorage.getItem(S.SPELL_BARS_BY_CHAR_KEY) || "{}");
const LEGACY = [tabOf([11, 0, 12])];
const seedBlob = () => localStorage.setItem(KEY, JSON.stringify({ powerLevel: 0.4, attackHeight: 3, activeSpellBar: 0, spellBars: LEGACY }));
const tick = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };

// A session whose server applies ACE's rules (refuses unknown spells).
function fakeSession() {
  const h = {
    guid: 0,
    knownByGuid: new Map(),
    listsByGuid: new Map(),
    filters: 0x3FF7,
    calls: [],
    known() { return this.knownByGuid.get(this.guid) ?? []; },
    lists() {
      if (!this.listsByGuid.has(this.guid)) this.listsByGuid.set(this.guid, [[], [], [], [], [], [], [], []]);
      return this.listsByGuid.get(this.guid);
    },
    playerGuid() { return this.guid; },
    playerKnownSpells() { return Uint32Array.from(this.known()); },
    playerSpellBars() { return this.lists().map((l) => Uint32Array.from(l)); },
    playerSpellbookFilters() { return this.filters; },
    addSpellFavorite(spell, index, list) {
      this.calls.push(["add", spell, index, list]);
      if (list > 7 || !this.known().includes(spell)) return;
      this.lists()[list] = S.applySpellBarOp(this.lists()[list], { op: "add", spell, index });
    },
    removeSpellFavorite(spell, list) {
      this.calls.push(["remove", spell, list]);
      this.lists()[list] = S.applySpellBarOp(this.lists()[list], { op: "remove", spell });
    },
    setSpellbookFilters(word) { this.calls.push(["filters", word]); },
  };
  return h;
}
const SB_URL = pathToFileURL(path.join(APP, "plugins", "spellbook.js")).href;

// ── [3] negative control first (its module instance has no poll) ───────
console.log("\n## [3] ?serverSpellBars=off — per-browser bars, nothing on the wire");
{
  globalThis.location = { search: "?serverSpellBars=off" };
  const OFF = await import(`${SB_URL}?serverSpellBars=off`);
  const h = fakeSession();
  h.guid = 0x50000001;
  h.knownByGuid.set(h.guid, [11, 12, 22]);
  h.listsByGuid.set(h.guid, [[11], [], [], [], [], [], [], []]);
  window.__sessionHandle = h;
  seedBlob();
  await check("off: sync is a no-op and the global bars show", async () => {
    assert.equal(OFF.syncSpellBarsFromServer(), false);
    assert.deepEqual(OFF.getSpellBarSlots(0), LEGACY[0]);
  });
  await check("off: an edit writes the per-browser `spellBars`, sends nothing", async () => {
    OFF.setSpellBarSlot(3, 22, 1);
    OFF.sendSpellbookFilters(0x2FFF);
    await tick();
    const b = blob();
    assert.equal(b.spellBars[1][3], 22);
    assert.equal(b.spellBarsByChar, undefined);
    assert.equal(localStorage.getItem(S.SPELL_BARS_BY_CHAR_KEY), null);
    assert.equal(b.powerLevel, 0.4);
    assert.deepEqual(h.calls, []);
  });
  window.__sessionHandle = undefined;
  store.clear();
}

// ── [2] the real spellbook.js, flag on ──────────────────────────────────
console.log("\n## [2] plugins/spellbook.js — server spell bars");
globalThis.location = { search: "" };
const SB = await import(`${SB_URL}?serverSpellBars=on`);
const ME = 0x50000001;
const ALT = 0x50000002;
const h = fakeSession();
const serverTab = (t, guid = ME) => h.listsByGuid.get(guid)[t];
const localOrder = (t) => S.compactTab(SB.getSpellBarSlots(t));
seedBlob();

await check("logged out: the per-browser bars", () => {
  assert.equal(SB.syncSpellBarsFromServer(), false);
  assert.deepEqual(SB.getSpellBarSlots(0), LEGACY[0]);
});

await check("in world before the PlayerDescription: empty tabs, never another character's bars", () => {
  window.__sessionHandle = h;
  h.guid = ME;
  h.listsByGuid.set(ME, [[21, 13], [], [], [], [], [], [], []]);
  assert.equal(SB.syncSpellBarsFromServer(), false, "no known spells yet");
  assert.deepEqual(SB.getSpellBarSlots(0), EMPTY());
});

await check("PlayerDescription: tabs from SpellLists8, filter word hydrated, shared record untouched", () => {
  h.knownByGuid.set(ME, [11, 12, 13, 21, 22, 23]);
  assert.equal(SB.syncSpellBarsFromServer(), true);
  assert.deepEqual(SB.getSpellBarSlots(0), tabOf([21, 13]));
  assert.deepEqual(h.calls, [], "all known → nothing to prune");
  assert.equal(localStorage.getItem("hb.spellbook.filterMask.v1"), String(0x3FF7 & 0x2FFF));
  assert.ok(events.includes("hb-spellbook-filters-changed"));
  assert.ok(events.includes("hb-spellbar-changed"));
  const b = blob();
  assert.equal(b.powerLevel, 0.4);
  assert.equal(b.attackHeight, 3);
  assert.deepEqual(b.spellBars, LEGACY, "legacy per-browser bars kept for ?serverSpellBars=off");
  assert.equal(b.spellBarsByChar, undefined, "the tabs are not in the combat-bar blob");
  assert.equal(charStore()["50000001"].synced, true);
});

await check("place a spell in a gap: one Add at the compact index, the gap stays local", async () => {
  SB.setSpellBarSlot(5, 11, 0);
  await tick();
  assert.deepEqual(h.calls, [["add", 11, 2, 0]]);
  assert.equal(SB.getSpellBarSlots(0)[5], 11);
  assert.deepEqual(serverTab(0), [21, 13, 11]);
});

await check("combat-bar swap (two writes) = one diff; the server ends in the tab's order", async () => {
  h.calls.length = 0;
  const cur = SB.getSpellBarSlots(0)[0]; // 21
  SB.setSpellBarSlot(0, 11); // 11 moves from cell 5 to cell 0
  SB.setSpellBarSlot(5, cur); // 21 into cell 5
  await tick();
  assert.deepEqual(SB.getSpellBarSlots(0), tabOf([11, 13, 0, 0, 0, 21]));
  assert.deepEqual(serverTab(0), localOrder(0));
  assert.ok(h.calls.length <= 4, `one diff (${JSON.stringify(h.calls)})`);
  assert.ok(h.calls.every(([op]) => op === "add" || op === "remove"));
});

await check("clear a cell = RemoveSpellFavorite", async () => {
  h.calls.length = 0;
  SB.setSpellBarSlot(1, 0); // 13
  await tick();
  assert.deepEqual(h.calls, [["remove", 13, 0]]);
  assert.deepEqual(serverTab(0), [11, 21]);
});

await check("drop on another tab (vacate + addToFirstEmptySlot) moves it between lists", async () => {
  h.calls.length = 0;
  SB.setSpellBarSlot(0, 0); // vacate 11 on tab 0
  SB.addToFirstEmptySlot(11, 2);
  await tick();
  assert.deepEqual(serverTab(0), [21]);
  assert.deepEqual(serverTab(2), [11]);
  assert.deepEqual(localOrder(2), [11]);
  assert.deepEqual(h.calls, [["remove", 11, 0], ["add", 11, 0, 2]]);
});

await check("a spell leaves the spellbook → it leaves every tab, one Remove each (RecvNotice_SpellRemoved)", async () => {
  h.calls.length = 0;
  h.knownByGuid.set(ME, [11, 12, 13, 22, 23]); // 21 forgotten
  SB.syncSpellBarsFromServer();
  await tick();
  assert.deepEqual(h.calls, [["remove", 21, 0]]);
  assert.deepEqual(SB.getSpellBarSlots(0), EMPTY());
  assert.deepEqual(serverTab(0), []);
});

await check("filter toggle sends the whole word, Level_9 0x1000 kept", () => {
  h.calls.length = 0;
  SB.sendSpellbookFilters(0x2FFF); // War back on
  assert.deepEqual(h.calls, [["filters", 0x3FFF]]);
  SB.sendSpellbookFilters(0x2FFF & ~0x10); // Level I off
  assert.deepEqual(h.calls[1], ["filters", 0x3FEF]);
});

await check("second character, empty server lists: the per-browser bars upload once (known spells only)", async () => {
  h.calls.length = 0;
  h.guid = ALT;
  h.knownByGuid.set(ALT, [11]);
  assert.equal(SB.syncSpellBarsFromServer(), true);
  assert.deepEqual(h.calls, [["add", 11, 0, 0]], "12 is not known → not sent");
  assert.deepEqual(SB.getSpellBarSlots(0), tabOf([11]));
  assert.deepEqual(serverTab(0, ALT), [11]);
  // ME's tabs are not ALT's.
  assert.deepEqual(charStore()["50000001"].tabs[2].slice(0, 1), [11]);
  h.calls.length = 0;
  SB.syncSpellBarsFromServer();
  await tick();
  assert.deepEqual(h.calls, [], "once");
});

await check("back on the first character: re-read from the server, cached gaps kept, nothing sent", async () => {
  h.calls.length = 0;
  h.guid = ME;
  SB.setSpellBarSlot(4, 12, 1); // reconciles first, then files 12 at cell 4 of tab 1
  await tick();
  assert.deepEqual(h.calls, [["add", 12, 0, 1]]);
  h.calls.length = 0;
  h.guid = 0; // log out …
  SB.syncSpellBarsFromServer();
  assert.deepEqual(SB.getSpellBarSlots(0), LEGACY[0], "logged out → per-browser bars");
  h.guid = ME; // … and back in
  SB.syncSpellBarsFromServer();
  await tick();
  assert.deepEqual(h.calls, []);
  assert.deepEqual(SB.getSpellBarSlots(1), tabOf([0, 0, 0, 0, 12]), "same order as the server → the gap layout stays");
});

await check("a new session for the same character re-reads the server (bars edited in another client)", async () => {
  h.calls.length = 0;
  h.listsByGuid.get(ME)[1] = [23, 12]; // edited elsewhere between sessions
  const next = { ...h }; // a new SessionHandle object, same server
  window.__sessionHandle = next;
  assert.equal(SB.syncSpellBarsFromServer(), true);
  await tick();
  assert.deepEqual(SB.getSpellBarSlots(1), tabOf([23, 12]), "server order wins over the cached layout");
  assert.deepEqual(h.calls, []);
  window.__sessionHandle = h;
  SB.syncSpellBarsFromServer();
});

await check("stale pkg/ (no spell-bar exports): a per-character copy minus unknown spells, nothing sent", async () => {
  const stale = {
    playerGuid: () => 0x50000003,
    playerKnownSpells: () => Uint32Array.from([12]),
    calls: [],
  };
  window.__sessionHandle = stale;
  assert.equal(SB.syncSpellBarsFromServer(), true);
  assert.deepEqual(SB.getSpellBarSlots(0), tabOf([0, 0, 12]));
  SB.setSpellBarSlot(0, 12, 0);
  await tick();
  const rec = charStore()["50000003"];
  assert.equal(rec.synced, false, "the server is consulted once the exports exist");
  assert.deepEqual(rec.tabs[0], tabOf([12]));
  window.__sessionHandle = h;
});

// Review R1 regression: combat-bar.js loads `holtburger_combat_bar_v1` once
// when its panel opens and saveState() writes that whole snapshot back on
// every spell-picker setArmed / power slider / attack height / checkbox
// change. With the tabs in that blob, a snapshot taken before the
// PlayerDescription deleted them, and the next edit's flush sent
// [remove 21 bar0, remove 13 bar0, remove 22 bar1, add 11 bar1].
const MAGE = 0x50000004;
await check("stale combat-bar saveState (panel opened before login) cannot revert the tabs or wipe the server", async () => {
  h.calls.length = 0;
  h.guid = MAGE;
  h.listsByGuid.set(MAGE, [[21, 13], [22], [], [], [], [], [], []]);
  h.knownByGuid.set(MAGE, []); // PlayerDescription not in yet
  window.__sessionHandle = h;
  assert.equal(SB.syncSpellBarsFromServer(), false);
  const snapshot = blob(); // combat-bar.js activate() → loadState()
  h.knownByGuid.set(MAGE, [11, 13, 21, 22]);
  assert.equal(SB.syncSpellBarsFromServer(), true);
  assert.deepEqual(SB.getSpellBarSlots(0), tabOf([21, 13]));
  assert.deepEqual(SB.getSpellBarSlots(1), tabOf([22]));
  localStorage.setItem(KEY, JSON.stringify({ ...snapshot, armedSpellId: 21 })); // setArmed → saveState(stale)
  assert.deepEqual(SB.getSpellBarSlots(0), tabOf([21, 13]), "the stale blob does not touch the tabs");
  SB.setSpellBarSlot(3, 11, 1);
  await tick();
  assert.deepEqual(h.calls, [["add", 11, 1, 1]], "only the edit goes out");
  assert.deepEqual(serverTab(0, MAGE), [21, 13]);
  assert.deepEqual(serverTab(1, MAGE), [22, 11]);
  localStorage.setItem(KEY, JSON.stringify({ ...snapshot, powerLevel: 0.9 })); // power slider → saveState(stale)
  assert.deepEqual(SB.getSpellBarSlots(1), tabOf([22, 0, 0, 11]), "an edit made after panel-open is not reverted");
});

await check("rebuild guard: a lost per-character cache after reconcile is rebuilt from the server lists, never flushed as removals", async () => {
  h.calls.length = 0;
  localStorage.removeItem(S.SPELL_BARS_BY_CHAR_KEY); // cleared site data / another writer
  assert.deepEqual(SB.getSpellBarSlots(1), tabOf([22, 11]), "rebuilt from what the server holds");
  SB.setSpellBarSlot(2, 13, 2);
  await tick();
  assert.deepEqual(h.calls, [["add", 13, 0, 2]]);
  assert.deepEqual(serverTab(0, MAGE), [21, 13]);
  assert.deepEqual(serverTab(1, MAGE), [22, 11]);
  h.calls.length = 0;
  localStorage.removeItem(S.SPELL_BARS_BY_CHAR_KEY);
  h.knownByGuid.set(MAGE, [11, 13, 21]); // 22 forgotten → only 22 is removed
  SB.syncSpellBarsFromServer();
  await tick();
  assert.deepEqual(h.calls, [["remove", 22, 1]]);
  assert.deepEqual(serverTab(0, MAGE), [21, 13]);
  assert.deepEqual(serverTab(1, MAGE), [11]);
  assert.deepEqual(serverTab(2, MAGE), [13]);
});

// ── [4] Rust-side source pins ───────────────────────────────────────────
console.log("\n## [4] Rust wiring (source pins)");
const read = (...p) => readFileSync(path.join(HOLT, ...p), "utf8");
await check("opcodes 0x01E3 / 0x01E4 / 0x0286 are live GameActionOpcode variants", () => {
  const src = read("crates", "holtburger-protocol", "src", "opcodes.rs");
  assert.match(src, /^\s+AddSpellFavorite = 0x01E3,/m);
  assert.match(src, /^\s+RemoveSpellFavorite = 0x01E4,/m);
  assert.match(src, /^\s+SpellbookFilter = 0x0286,/m);
});
await check("GameAction variants pack + unpack, wire layout tests exist", () => {
  const ga = read("crates", "holtburger-protocol", "src", "messages", "game_action.rs");
  for (const v of ["AddSpellFavorite", "RemoveSpellFavorite", "SpellbookFilter"]) {
    assert.match(ga, new RegExp(`GameActionOpcode::${v} => GameAction::${v}\\(`), `${v} unpack`);
    assert.match(ga, new RegExp(`GameAction::${v}\\(data\\) => \\{`), `${v} pack`);
  }
  const magic = read("crates", "holtburger-protocol", "src", "messages", "magic", "actions.rs");
  assert.match(magic, /fn test_add_spell_favorite_wire_layout/);
  assert.match(magic, /fn test_remove_spell_favorite_wire_layout/);
  assert.match(magic, /fn test_spellbook_filter_wire_layout/);
});
await check("SessionHandle exports + recv-loop routing", () => {
  const lib = read("apps", "holtburger-web", "src", "lib.rs");
  for (const n of ["addSpellFavorite", "removeSpellFavorite", "setSpellbookFilters", "playerSpellBars", "playerSpellbookFilters"]) {
    assert.match(lib, new RegExp(`js_name = ${n}\\)`), n);
  }
  const mod = read("apps", "holtburger-web", "src", "session", "commands", "mod.rs");
  for (const v of ["AddSpellFavorite", "RemoveSpellFavorite", "SpellbookFilter"]) {
    assert.match(mod, new RegExp(`SessionCommand::${v} \\{ \\.\\. \\}`), v);
  }
  const ch = read("apps", "holtburger-web", "src", "session", "commands", "character.rs");
  assert.match(ch, /crate::spell_favorites::add_spell_favorite\(/);
  assert.match(ch, /crate::spell_favorites::remove_spell_favorite\(/);
});

console.log(`\nspellbar_server_sync: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
