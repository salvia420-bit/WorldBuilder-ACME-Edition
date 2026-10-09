// tests/character_select.test.mjs — app/character_select.js (2026-10-09), the
// retail character screen (gmCharacterManagementUI, layout 0x21000004).
//
// What must hold:
//   - when it shows: `?autoLogin=1&autoSpawn=select` and a manual Connect
//     (unless `?charSelect=off`); never for any other autoSpawn (agents);
//   - retail list order (pending deletions greyed and last, the wire slot
//     kept), the remembered character preselected, else the first active one;
//     UpdateButtons: Restore replaces Delete on a greyed row, Enter only for
//     an active one;
//   - on the fake DOM: rows render; a click selects and starts the warm-up
//     for that character's remembered spot (once per character) plus the
//     terrain-asset warm-up; Enter clicks the hidden spawn button of
//     #character-ul (the unchanged index.html spawn flow) and shows the
//     entering line; Delete needs DELETE typed and sends the row's SLOT;
//     an `in-world` boot state hides the page and drops the preview camera;
//     an error keeps it, with the retail CharacterError text;
//   - an account with no characters (a first-time player) warms the Training
//     Academy a new character starts in, as soon as the char-gen catalog has
//     loaded — once.
//
// Run from apps/holtburger-web/:  node tests/character_select.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installFakeDom, FakeEvent } from "./helpers/fake_dom_items.mjs";
import { spliceModule } from "../harness/lib/splice_module.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");

globalThis.window = globalThis;
const { document } = installFakeDom(globalThis);

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${e.stack || e.message}`); }
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

const rules = await import(pathToFileURL(path.join(APP, "app", "login_ui_rules.js")).href);
const preview = await import(pathToFileURL(path.join(APP, "app", "spawn_preview.js")).href);
globalThis.__T = { ...rules, ...preview };
const real = (names) => Object.fromEntries(names.map((n) => [n, `globalThis.__T.${n}`]));
const src = readFileSync(path.join(APP, "app", "character_select.js"), "utf8");
const body = spliceModule(src, {
  label: "character_select.js",
  provided: [],
  stubs: {
    setAcText: "(el, t) => { if (el) el.textContent = String(t ?? ''); }",
    loadAcFont: "() => Promise.resolve(null)",
    ensureDialogChromeStyles: "() => {}",
    ...real([
      "characterErrorInfo", "deleteConfirmationAccepted", "deleteConfirmationText", "isGreyedOut", "orderCharacterRows",
      "lastLocationKey", "loadLastLocation", "newCharacterSpot", "spawnPreviewEnabled", "startSpawnPreview",
    ]),
  },
});
const M = new Function(body + "\nreturn { characterSelectWanted, characterSelectRows, characterSelectButtons, initCharacterSelect, CHARSELECT_ROOT_ID };")();

console.log("\npure rules");
await check("shows for autoSpawn=select and a manual Connect; never for agents", () => {
  assert.equal(M.characterSelectWanted("?autoLogin=1&autoSpawn=select"), true);
  assert.equal(M.characterSelectWanted("?autoLogin=1&autoSpawn=first"), false);
  assert.equal(M.characterSelectWanted("?autoLogin=1"), false, "autoLogin defaults to autoSpawn=first");
  assert.equal(M.characterSelectWanted("?autoLogin=1&autoSpawn=0"), false);
  assert.equal(M.characterSelectWanted(""), true, "manual Connect");
  assert.equal(M.characterSelectWanted("?charSelect=off"), false);
});
const LIST = [
  { id: 0x50000001, name: "Alpha", deleteTime: 0 },
  { id: 0x50000002, name: "Doomed", deleteTime: 1 },
  { id: 0x50000003, name: "Gamma", deleteTime: 0 },
];
await check("retail order + selection: greyed last with the wire slot, remembered id wins, else the first active", () => {
  const r = M.characterSelectRows(LIST, 0x50000003);
  assert.deepEqual(r.rows.map((x) => [x.name, x.slot, x.greyed]), [["Alpha", 0, false], ["Gamma", 2, false], ["Doomed", 1, true]]);
  assert.equal(r.selectedId, 0x50000003);
  assert.equal(M.characterSelectRows(LIST, 0x5000ffff).selectedId, 0x50000001, "unknown remembered id");
  assert.equal(M.characterSelectRows([LIST[1]], 0).selectedId, 0x50000002, "only a greyed row");
  assert.equal(M.characterSelectRows([], 0).selectedId, 0);
});
await check("UpdateButtons: Restore replaces Delete on a greyed row; Enter only when active", () => {
  assert.deepEqual(M.characterSelectButtons({ greyed: false }), { enter: true, del: true, restore: false });
  assert.deepEqual(M.characterSelectButtons({ greyed: true }), { enter: false, del: false, restore: true });
  assert.deepEqual(M.characterSelectButtons(null), { enter: false, del: false, restore: false });
});

console.log("\nthe page on the fake DOM");
// index.html's hidden list: one Spawn button per active character.
const characterUl = document.createElement("ul");
characterUl.id = "character-ul";
document.body.appendChild(characterUl);
const spawnClicks = [];
for (const c of LIST.filter((x) => !x.deleteTime)) {
  const li = document.createElement("li");
  li.dataset.id = String(c.id);
  li.dataset.name = c.name;
  const b = document.createElement("button");
  b.dataset.id = String(c.id);
  b.addEventListener("click", () => spawnClicks.push(c.id));
  li.appendChild(b);
  characterUl.appendChild(li);
}
const calls = [];
const handle = {
  canCreateCharacter: true,
  characterList: () => LIST.map((c) => ({ ...c })),
  deleteCharacter: (slot) => calls.push(["deleteCharacter", slot]),
  restoreCharacter: (id) => calls.push(["restoreCharacter", id]),
};
const previews = [];
let warmCalls = 0;
let clearCalls = 0;
globalThis.liveScene3d = {
  previewSpawnArea: (loc) => { previews.push(loc); return { cell: loc.cell }; },
  warmTerrainAssets: () => { warmCalls++; return Promise.resolve(true); },
  clearSpawnPreview: () => { clearCalls++; },
};
// Gamma stood in Holtburg last time; Alpha has no spot on this browser.
localStorage.setItem(
  preview.lastLocationKey({ server: "127.0.0.1:9000", account: "tailnet1", charId: 0x50000003 }),
  JSON.stringify({ cell: 0xa9b40019, x: 82.7, y: 8.8, z: 94 }),
);
const page = M.initCharacterSelect({
  getHandle: () => handle,
  characterUl,
  getServerName: () => "Holtburger Test",
  getAccountKey: () => ({ server: "127.0.0.1:9000", account: "tailnet1" }),
  openWizard: () => {},
  onExit: () => calls.push(["exit"]),
});
const root = () => document.getElementById(M.CHARSELECT_ROOT_ID);
const rows = () => Array.from(root().querySelectorAll(".hcs-row"));
const rowOf = (id) => rows().find((r) => Number(r.dataset.id) === id);

await check("show(): the world name and the three rows in retail order, first active selected", async () => {
  page.show();
  await tick(5);
  assert.equal(root().dataset.open, "1");
  assert.equal(root().querySelector(".hcs-world-name").textContent, "Holtburger Test");
  assert.deepEqual(rows().map((r) => Number(r.dataset.id)), [0x50000001, 0x50000003, 0x50000002]);
  assert.ok(rowOf(0x50000001).classList.contains("is-selected"));
  assert.ok(rowOf(0x50000002).classList.contains("is-greyed"));
  assert.ok(warmCalls >= 1, "the terrain-asset warm-up starts with the page");
  assert.equal(previews.length, 0, "Alpha has no remembered spot: nothing location-specific");
});
await check("selecting Gamma starts the warm-up at its remembered Holtburg spot, once", async () => {
  rowOf(0x50000003).dispatchEvent(new FakeEvent("click", { button: 0 }));
  await tick(1300);
  assert.ok(rowOf(0x50000003).classList.contains("is-selected"));
  assert.equal(previews.length, 1);
  assert.equal(previews[0].cell, 0xa9b40019);
  rowOf(0x50000001).dispatchEvent(new FakeEvent("click", { button: 0 }));
  rowOf(0x50000003).dispatchEvent(new FakeEvent("click", { button: 0 }));
  await tick(1300);
  assert.equal(previews.length, 1, "re-selecting the same character does not start a second ring");
});
await check("a greyed row: Restore replaces Delete and Enter is disabled", async () => {
  rowOf(0x50000002).dispatchEvent(new FakeEvent("click", { button: 0 }));
  await tick(5);
  const btns = Array.from(root().querySelectorAll(".hcs-small"));
  const del = btns.find((b) => b.textContent === "DELETE");
  const res = btns.find((b) => b.textContent === "RESTORE");
  assert.equal(del.hidden, true);
  assert.equal(res.hidden, false);
  assert.equal(root().querySelector(".hcs-enter").disabled, true);
  res.dispatchEvent(new FakeEvent("click", { button: 0 }));
  assert.deepEqual(calls.at(-1), ["restoreCharacter", 0x50000002]);
});
await check("Delete needs DELETE typed, then sends the row's wire slot", async () => {
  rowOf(0x50000003).dispatchEvent(new FakeEvent("click", { button: 0 }));
  await tick(5);
  const del = Array.from(root().querySelectorAll(".hcs-small")).find((b) => b.textContent === "DELETE");
  del.dispatchEvent(new FakeEvent("click", { button: 0 }));
  const veil = root().querySelector(".hcs-dialog-veil");
  assert.equal(veil.dataset.open, "1");
  const input = veil.querySelector("input");
  const done = Array.from(veil.querySelectorAll("button")).find((b) => b.textContent === "Done");
  input.value = "delete it";
  done.dispatchEvent(new FakeEvent("click", { button: 0 }));
  assert.equal(calls.filter((c) => c[0] === "deleteCharacter").length, 0, "not without DELETE");
  input.value = "delete";
  done.dispatchEvent(new FakeEvent("click", { button: 0 }));
  assert.deepEqual(calls.at(-1), ["deleteCharacter", 2], "Gamma's slot is 2, not its row index 1");
  assert.equal(veil.dataset.open, "0");
});
await check("Enter clicks the hidden spawn button and shows the entering line", async () => {
  root().querySelector(".hcs-enter").dispatchEvent(new FakeEvent("click", { button: 0 }));
  assert.deepEqual(spawnClicks, [0x50000003]);
  assert.equal(root().querySelector(".hcs-status").textContent, "Entering game...");
  assert.equal(root().querySelector(".hcs-enter").disabled, true, "no second Enter while entering");
});
await check("an error keeps the page with retail's CharacterError text", async () => {
  window.__lastCharacterError = { code: 0x0d };
  window.dispatchEvent(new FakeEvent("holtburger:state", { detail: { state: "error", message: "spawn" } }));
  await tick(5);
  assert.equal(root().dataset.open, "1");
  const veil = root().querySelector(".hcs-dialog-veil");
  assert.match(veil.textContent, /still in the world/);
  Array.from(veil.querySelectorAll("button")).find((b) => b.textContent === "OK").dispatchEvent(new FakeEvent("click", { button: 0 }));
  assert.equal(root().querySelector(".hcs-enter").disabled, false, "Enter works again");
});
await check("in-world hides the page and drops the preview camera", async () => {
  root().querySelector(".hcs-enter").dispatchEvent(new FakeEvent("click", { button: 0 }));
  window.dispatchEvent(new FakeEvent("holtburger:state", { detail: { state: "in-world" } }));
  await tick(5);
  assert.equal(root().dataset.open, "0");
  assert.ok(clearCalls >= 1);
});

console.log("\nfirst-time player");
await check("no characters: the default academy warms once the catalog loads, once", async () => {
  page.hide();
  root().remove();
  let catalog = null;
  previews.length = 0;
  const fresh = M.initCharacterSelect({
    getHandle: () => ({ canCreateCharacter: true, characterList: () => [] }),
    characterUl: document.createElement("ul"),
    getServerName: () => "Holtburger Test",
    getAccountKey: () => ({ server: "127.0.0.1:9000", account: "newplayer" }),
    getCatalog: () => catalog,
    openWizard: () => {},
    onExit: () => {},
  });
  assert.notEqual(fresh, page, "a new page for the new account");
  fresh.show();
  await tick(5);
  assert.match(root().querySelector(".hcs-status").textContent, /no characters/i);
  assert.equal(previews.length, 0, "catalog not loaded yet: nothing location-specific");
  // The live catalog's Holtburg academy (wasm load_character_gen_catalog).
  catalog = {
    heritages: [{ heritageId: 1, primaryStartAreaIds: [0], secondaryStartAreaIds: [1, 2, 3] }],
    starterAreas: [{ startAreaId: 0, firstLocation: { cell: 0x860201ad, x: 12.3199, y: -28.482, z: 0.005 } }],
  };
  await tick(700);
  assert.equal(previews.length, 1);
  assert.equal(previews[0].cell, 0x860201ad);
  fresh.refresh();
  await tick(700);
  assert.equal(previews.length, 1, "not restarted by a re-render");
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
