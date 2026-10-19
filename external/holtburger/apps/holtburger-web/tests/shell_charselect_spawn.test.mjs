// tests/shell_charselect_spawn.test.mjs — 2026-10-18 review, shell group.
//
// The character list's spawn path, end to end on the fake DOM: index.html's
// REAL #character-ul click handler (lifted from the shipped page and run),
// app/client_events.js (real import) and app/character_select.js (spliced).
//
//   SHELL-1: `dataset.name` gives back the DECODED wire name (the list escapes
//     it into the attribute only), so a shard-supplied
//     `<img src=x onerror=…>` reached loginStatus.innerHTML raw from the
//     Spawn and Restore branches and from the kind=1 PlayerSpawned arm.
//     Each must now land escaped.
//   SHELL-2: ENTER while ACE still holds the character (CharacterError 0x0D,
//     session kept) left the character screen on "Entering game..." with
//     ENTER disabled for good — nothing set an 'error' boot state, and the
//     index.html spawn latch (spawningCharId / spawnedPlayerGuid + disabled
//     Spawn buttons) never released. The wasm reports kind=1 PlayerSpawned
//     eagerly on the first SelectCharacter, BEFORE the server answers, so the
//     latch the 0x0D meets is spawnedPlayerGuid, not spawningCharId. Now the
//     CharacterError releases it and the screen shows retail's text and lets
//     the player press ENTER again. Follow-up (same day): any character, not
//     only the refused one — the next SelectCharacter hands the session's
//     eager WorldState to the picked guid and re-arms kind=1 (lifecycle.rs).
//   SHELL-7: with site data blocked the `localStorage` getter throws; the
//     preview read it outside a try, so show() threw and every later row
//     change threw from the preview timer.
//
// NEGATIVE CONTROL: a CharacterError with no spawn pending leaves the latch
// variables alone.
//
// Run from apps/holtburger-web/:  node tests/shell_charselect_spawn.test.mjs

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

const { escapeHtml } = await import("../app/dom_utils.js");
const rules = await import(pathToFileURL(path.join(APP, "app", "login_ui_rules.js")).href);
const preview = await import(pathToFileURL(path.join(APP, "app", "spawn_preview.js")).href);
const { dispatchClientEvent } = await import("../app/client_events.js");
const { ClientEventKind } = await import("../scene3d/client_event_kinds.js");

// app/character_select.js, spliced exactly as tests/character_select.test.mjs does.
globalThis.__T = { ...rules, ...preview };
const real = (names) => Object.fromEntries(names.map((n) => [n, `globalThis.__T.${n}`]));
const CS = new Function(spliceModule(readFileSync(path.join(APP, "app", "character_select.js"), "utf8"), {
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
}) + "\nreturn { initCharacterSelect, CHARSELECT_ROOT_ID };")();

// index.html's #character-ul click handler (Delete / Restore / Spawn), lifted
// from the shipped page: the balanced block after the anchor.
const HTML = readFileSync(path.join(APP, "index.html"), "utf8");
function liftBlock(src, anchor) {
  const start = src.indexOf(anchor);
  if (start < 0) throw new Error(`anchor drifted: ${anchor}`);
  let i = src.indexOf("{", start + anchor.length - 1);
  let depth = 0;
  for (; i < src.length; i += 1) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") { i = src.indexOf("\n", i); continue; }
    if (c === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i) + 1; continue; }
    if (c === '"' || c === "'" || c === "`") {
      for (i += 1; i < src.length && src[i] !== c; i += 1) if (src[i] === "\\") i += 1;
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced block at: ${anchor}`);
}
const SPAWN_CLICK = liftBlock(HTML, 'characterUl.addEventListener("click", (ev) => {') + ")";

const EVIL = `<img src=x onerror="window.__pwned=1">`;
const CHAR = { id: 0x50000001, name: EVIL, deleteTime: 0 };
const DOOMED = { id: 0x50000002, name: EVIL, deleteTime: 1 };
const OTHER = { id: 0x50000004, name: "Other", deleteTime: 0 };

/** The hidden dev list (two Spawn rows + one Restore row) with the real handler bound. */
function mountList() {
  const characterUl = document.createElement("ul");
  document.body.appendChild(characterUl);
  const li = document.createElement("li");
  li.dataset.id = String(CHAR.id);
  li.dataset.name = CHAR.name; // what the browser decodes `data-name="${escapeHtml(name)}"` back to
  const spawn = document.createElement("button");
  spawn.dataset.id = String(CHAR.id);
  spawn.textContent = "Spawn";
  li.appendChild(spawn);
  characterUl.appendChild(li);
  const li2 = document.createElement("li");
  li2.dataset.id = String(DOOMED.id);
  li2.dataset.name = DOOMED.name;
  const restore = document.createElement("button");
  restore.dataset.restoreId = String(DOOMED.id);
  restore.dataset.name = DOOMED.name;
  li2.appendChild(restore);
  characterUl.appendChild(li2);
  const li3 = document.createElement("li");
  li3.dataset.id = String(OTHER.id);
  li3.dataset.name = OTHER.name;
  const other = document.createElement("button");
  other.dataset.id = String(OTHER.id);
  other.textContent = "Spawn";
  li3.appendChild(other);
  characterUl.appendChild(li3);

  const calls = [];
  const loginStatus = { innerHTML: "" };
  const scope = {
    characterUl,
    loginStatus,
    spawningCharId: null,
    spawnedPlayerGuid: null,
    enteredWorld: false,
    escapeHtml,
    retailCharListEnabled: rules.retailCharListEnabled,
    deleteConfirmationText: rules.deleteConfirmationText,
    deleteConfirmationAccepted: rules.deleteConfirmationAccepted,
    setBootState: (s, m) => calls.push(["boot", s, m]),
    handle: {
      selectCharacter: (id) => calls.push(["selectCharacter", id]),
      restoreCharacter: (id) => calls.push(["restoreCharacter", id]),
      deleteCharacter: (slot) => calls.push(["deleteCharacter", slot]),
      characterList: () => [CHAR, OTHER, DOOMED].map((c) => ({ ...c })),
      canCreateCharacter: true,
    },
  };
  new Function("__scope", `with (__scope) {\n${SPAWN_CLICK}\n}`)(scope);
  // index.html's __clientEventDeps: the spawn `let`s through live accessors.
  const D = {
    loginStatus,
    characterUl,
    __resetEntDrainPending() {}, setLocalPlayerGuid() {}, getLocalPlayerGuid: () => null,
    setBootState: scope.setBootState, EVT_GUARD_ON: true, CMD_INTERP_ON: false, CAST_MOVE_ON: false,
    get spawningCharId() { return scope.spawningCharId; }, set spawningCharId(v) { scope.spawningCharId = v; },
    get spawnedPlayerGuid() { return scope.spawnedPlayerGuid; }, set spawnedPlayerGuid(v) { scope.spawnedPlayerGuid = v; },
    get enteredWorld() { return scope.enteredWorld; }, set enteredWorld(v) { scope.enteredWorld = v; },
    get lastPredictionTime() { return null; }, set lastPredictionTime(_) {},
  };
  return { characterUl, spawn, other, restore, loginStatus, scope, D, calls };
}

function dispatch(D, kind, u32Payload, stringPayload = "") {
  const evt = { kind, u32Payload, u32Payload2: 0, stringPayload, free() {} };
  const warn = console.warn;
  console.warn = () => {};
  try { return dispatchClientEvent(evt, D); } finally { console.warn = warn; }
}

console.log("\nSHELL-1: decoded character names stay escaped");
await check("Spawn branch: the selected-name line escapes the decoded name", () => {
  const L = mountList();
  L.spawn.click();
  assert.equal(L.scope.spawningCharId, CHAR.id, "the spawn latched");
  assert.ok(L.loginStatus.innerHTML.includes(`<strong>${escapeHtml(EVIL)}</strong>`), L.loginStatus.innerHTML);
  assert.ok(!L.loginStatus.innerHTML.includes("<img"), "no raw markup from the wire name");
});
await check("Restore branch: escaped", () => {
  const L = mountList();
  L.restore.click();
  assert.deepEqual(L.calls.at(-1), ["restoreCharacter", DOOMED.id]);
  assert.ok(L.loginStatus.innerHTML.includes(`Restore requested for <strong>${escapeHtml(EVIL)}</strong>`), L.loginStatus.innerHTML);
  assert.ok(!L.loginStatus.innerHTML.includes("<img"));
});
await check("kind=1 PlayerSpawned (client_events.js): escaped", () => {
  const L = mountList();
  L.spawn.click();
  dispatch(L.D, ClientEventKind.PLAYER_SPAWNED, CHAR.id);
  assert.equal(L.scope.spawnedPlayerGuid, CHAR.id);
  assert.ok(L.loginStatus.innerHTML.includes(`Spawned <strong>${escapeHtml(EVIL)}</strong>`), L.loginStatus.innerHTML);
  assert.ok(!L.loginStatus.innerHTML.includes("<img"));
  assert.equal(L.spawn.textContent, "Spawned");
});
await check("an unnamed row shows the literal <unknown> fallback (escaped, not parsed away)", () => {
  const L = mountList();
  delete L.spawn.parentElement.dataset.name;
  L.spawn.click();
  assert.ok(L.loginStatus.innerHTML.includes("<strong>&lt;unknown&gt;</strong>"), L.loginStatus.innerHTML);
});

console.log("\nSHELL-2: a refused Enter World releases the spawn and the character screen");
await check("CharacterError 0x0D after the eager kind=1: latch released for the refused character", () => {
  const L = mountList();
  L.spawn.click();
  assert.equal(L.spawn.disabled, true);
  assert.equal(L.spawn.textContent, "Spawning…");
  // The wasm's eager PlayerSpawned (first SelectCharacter of the session).
  dispatch(L.D, ClientEventKind.PLAYER_SPAWNED, CHAR.id);
  assert.equal(L.scope.spawningCharId, null);
  assert.equal(L.scope.spawnedPlayerGuid, CHAR.id);
  dispatch(L.D, ClientEventKind.CHARACTER_ERROR, 0x0d, "EnterGameCharacterInWorld");
  assert.equal(L.scope.spawningCharId, null);
  assert.equal(L.scope.spawnedPlayerGuid, null, "index.html's spawnedPlayerGuid cleared (kind=7 refills it)");
  assert.equal(L.spawn.disabled, false);
  assert.equal(L.spawn.textContent, "Spawn");
  assert.equal(L.other.disabled, false, "SHELL-2 follow-up: every character is offered again");
  assert.equal(window.__lastCharacterError.code, 0x0d, "auto_login's stash is still written");
  assert.ok(!L.calls.some((c) => c[0] === "boot" && c[1] === "error"), "no 'error' boot state (agents read it)");
  L.spawn.click();
  assert.equal(L.calls.filter((c) => c[0] === "selectCharacter").length, 2, "a retry sends a second request");
});
await check("SHELL-2 follow-up: after a refusal another character can enter", () => {
  const L = mountList();
  L.spawn.click();
  dispatch(L.D, ClientEventKind.PLAYER_SPAWNED, CHAR.id);
  dispatch(L.D, ClientEventKind.CHARACTER_ERROR, 0x0d, "EnterGameCharacterInWorld");
  L.other.click();
  assert.deepEqual(L.calls.filter((c) => c[0] === "selectCharacter").at(-1), ["selectCharacter", OTHER.id]);
  assert.equal(L.scope.spawningCharId, OTHER.id);
  // The wasm re-arms kind=1 for the new pick (lifecycle.rs SelectCharacter).
  dispatch(L.D, ClientEventKind.PLAYER_SPAWNED, OTHER.id);
  assert.equal(L.scope.spawnedPlayerGuid, OTHER.id);
  assert.equal(L.other.textContent, "Spawned");
});
await check("SHELL-2 follow-up: the wasm hands the eager world to the next pick (source pins)", () => {
  const src = readFileSync(path.join(APP, "src", "session", "commands", "lifecycle.rs"), "utf8");
  const arm = src.slice(src.indexOf("SessionCommand::SelectCharacter { guid } =>"));
  const reassign = arm.indexOf("reassign_eager_world_player(w, guid)");
  assert.ok(reassign > 0, "the select re-assigns an existing eager world");
  const gate = arm.lastIndexOf("if !matches!(state, LoopState::InWorld { .. })", reassign);
  assert.ok(gate > 0 && gate < reassign, "only before PlayerCreate");
  const rearm = arm.indexOf("*local_player_kind1_emitted = false;", gate);
  assert.ok(rearm > gate && rearm < reassign, "kind=1 is re-armed for every pre-world select");
  assert.ok(arm.indexOf("*cached_player_description = None;", reassign) > reassign, "another character's description is dropped");
  assert.ok(reassign < arm.indexOf("*state = LoopState::EnteringWorld"), "decided before the state moves to the new guid");
  const lib = readFileSync(path.join(APP, "src", "lib.rs"), "utf8");
  assert.match(lib, /fn reassign_eager_world_player\(\s*w: &mut holtburger_world::WorldState,/);
});
await check("a second refusal (no kind=1 any more this session): released again", () => {
  const L = mountList();
  L.spawn.click();
  dispatch(L.D, ClientEventKind.CHARACTER_ERROR, 0x0d, "EnterGameCharacterInWorld");
  assert.equal(L.scope.spawningCharId, null, "index.html's spawningCharId cleared");
  assert.equal(L.spawn.disabled, false);
  L.spawn.click();
  assert.equal(L.calls.filter((c) => c[0] === "selectCharacter").length, 2);
});
await check("negative control: a CharacterError in the world leaves the latch alone", () => {
  const L = mountList();
  L.spawn.click();
  dispatch(L.D, ClientEventKind.PLAYER_SPAWNED, CHAR.id);
  L.scope.enteredWorld = true;
  dispatch(L.D, ClientEventKind.CHARACTER_ERROR, 0x05, "Logoff");
  assert.equal(L.scope.spawningCharId, null);
  assert.equal(L.scope.spawnedPlayerGuid, CHAR.id);
  assert.equal(L.spawn.disabled, true);
  assert.equal(L.spawn.textContent, "Spawned");
});

const rootEl = () => document.getElementById(CS.CHARSELECT_ROOT_ID);
function mountScreen(L, accountKey) {
  rootEl()?.remove();
  return CS.initCharacterSelect({
    getHandle: () => L.scope.handle,
    characterUl: L.characterUl,
    getServerName: () => "Test Shard",
    getAccountKey: () => accountKey,
    openWizard: () => {},
    onExit: () => {},
  });
}
await check("character screen: ENTER → 0x0D → retail dialog, ENTER works again", async () => {
  const L = mountList();
  const page = mountScreen(L, { server: "shard:9000", account: "acct" });
  page.show();
  await tick(5);
  const enter = rootEl().querySelector(".hcs-enter");
  enter.dispatchEvent(new FakeEvent("click", { button: 0 }));
  assert.equal(rootEl().querySelector(".hcs-status").textContent, "Entering game...");
  assert.equal(enter.disabled, true);
  dispatch(L.D, ClientEventKind.PLAYER_SPAWNED, CHAR.id);
  dispatch(L.D, ClientEventKind.CHARACTER_ERROR, 0x0d, "EnterGameCharacterInWorld");
  await tick(5);
  assert.equal(rootEl().dataset.open, "1", "the screen stays");
  const veil = rootEl().querySelector(".hcs-dialog-veil");
  assert.equal(veil.dataset.open, "1");
  assert.match(veil.textContent, /One of your characters is still in the world/);
  assert.notEqual(rootEl().querySelector(".hcs-status").textContent, "Entering game...");
  assert.equal(enter.disabled, false, "ENTER usable again");
  const ok = () => Array.from(veil.querySelectorAll("button")).find((b) => b.textContent === "OK");
  ok().dispatchEvent(new FakeEvent("click", { button: 0 }));
  page._select(OTHER.id);
  enter.dispatchEvent(new FakeEvent("click", { button: 0 }));
  assert.equal(veil.dataset.open, "0", "SHELL-2 follow-up: another character needs no reload");
  assert.deepEqual(L.calls.filter((c) => c[0] === "selectCharacter").at(-1), ["selectCharacter", OTHER.id]);
  assert.equal(L.calls.filter((c) => c[0] === "selectCharacter").length, 2, "the second ENTER reached the server");
  assert.equal(rootEl().querySelector(".hcs-status").textContent, "Entering game...");
  page.hide();
});
await check("character screen: a fatal code (0x15 server full) also ends the entering state", async () => {
  const L = mountList();
  const page = mountScreen(L, { server: "shard:9000", account: "acct" });
  page.show();
  await tick(5);
  rootEl().querySelector(".hcs-enter").dispatchEvent(new FakeEvent("click", { button: 0 }));
  dispatch(L.D, ClientEventKind.CHARACTER_ERROR, 0x15, "LogonServerFull");
  await tick(5);
  assert.match(rootEl().querySelector(".hcs-dialog-veil").textContent, /server is full currently/);
  assert.equal(page._state.entering, false);
  page.hide();
});

console.log("\nSHELL-7: blocked site data (the localStorage getter throws)");
await check("show() and later row changes do not throw; the terrain warm-up still runs", async () => {
  const L = mountList();
  let warm = 0;
  globalThis.liveScene3d = { warmTerrainAssets: () => { warm++; return Promise.resolve(true); }, clearSpawnPreview() {} };
  const saved = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() { throw new Error("SecurityError: The operation is insecure."); },
  });
  const uncaught = [];
  const onUncaught = (e) => uncaught.push(e);
  process.on("uncaughtException", onUncaught);
  try {
    const page = mountScreen(L, { server: "shard:9000", account: "blocked" });
    page.show();
    assert.ok(warm >= 1, "the location-independent warm-up started");
    // Two active rows so a row change reaches the 1.2 s preview timer.
    L.scope.handle.characterList = () => [CHAR, { id: 0x50000003, name: "Second", deleteTime: 0 }];
    page.refresh();
    page._select(0x50000003);
    await tick(1300);
    assert.equal(uncaught.length, 0, uncaught.map((e) => e.message).join("; "));
    page.hide();
  } finally {
    process.off("uncaughtException", onUncaught);
    Object.defineProperty(globalThis, "localStorage", saved);
    delete globalThis.liveScene3d;
  }
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
