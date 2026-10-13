// tests/house_query_login.test.mjs — hud-ui-4 (2026-10-13).
//
// Retail CPlayerSystem::InitializePlayer (acclient.c:400740) ends with
// CM_House::Event_QueryHouse (:400811), once per player_initialized, right
// after the LoginComplete notification. holtburger only sent HouseQuery
// (0x021E) from the House panel's button, so the map's "Your house" marker
// (plugins/map-panel.js, playerHouseData) and the House page stayed empty for
// the whole session unless someone pressed Query House. app/client_events.js
// now sends it from the kind=7 EnteredWorld arm through app/
// house_query_login.js: once per SessionHandle (a death respawn or teleport
// sends nothing, a relog with a new handle asks again), `?houseQueryAtLogin=
// off` (or 0 / false) skips it, and a stale pkg/ without houseQuery is a no-op.
//
// Also pins what the House page shows once the login query is answered: ACE
// HandleActionQueryHouse replies HouseStatus(BadParam) without a house
// ("You do not own a house", not "Not looked up yet") and HouseData with one.
//
// Run: node tests/house_query_login.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// house-panel.js arms a 1 Hz HouseProfile watcher when `window` exists at
// import time; import it first so the test process can exit.
const { ownership } = await import("../plugins/house-panel.js");

// Browser-ish globals (same minimal set as tests/login_portal_space.test.mjs).
globalThis.window = globalThis;
globalThis.location = { search: "", href: "http://test/index.html", reload() {} };
globalThis.sessionStorage = { getItem: () => null, setItem() {} };
globalThis.requestIdleCallback = () => {};
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ style: {}, setAttribute() {}, textContent: "" }),
  body: { appendChild() {} },
};

const { houseQueryAtLoginEnabled, maybeQueryHouseAtLogin } = await import("../app/house_query_login.js");
const { dispatchClientEvent } = await import("../app/client_events.js");
const { ClientEventKind } = await import("../scene3d/client_event_kinds.js");

const WEENIE_ERROR_BAD_PARAM = 0x0002;

/** A SessionHandle stand-in that counts houseQuery() sends. */
function stubHandle(extra = {}) {
  const h = { calls: 0, houseQuery() { h.calls += 1; }, ...extra };
  return h;
}

function makeDeps(handle) {
  const state = { spawningCharId: null, spawnedPlayerGuid: null, enteredWorld: false, lastPredictionTime: 0 };
  const D = {
    loginStatus: { innerHTML: "" }, postSpawn: { hidden: true }, teleportBtn: { disabled: true },
    chatPanel: { hidden: true }, chatInput: { disabled: true }, chatSendBtn: { disabled: true },
    setBootState() {}, setLocalPlayerGuid() {}, getLocalPlayerGuid: () => state.spawnedPlayerGuid,
    populateSkyDescFromRegion: async () => 0, ensureTerrainAroundLandblock() {}, ensureBuildingAabbsAroundLandblock() {},
    ensureCellContainersForLandblock() {}, __resetEntDrainPending() {},
    handle,
    // A handler error fails the test instead of being swallowed by evtGuard.
    EVT_GUARD_ON: false, CMD_INTERP_ON: false, CAST_MOVE_ON: false,
  };
  for (const k of Object.keys(state)) {
    Object.defineProperty(D, k, { get: () => state[k], set: (v) => { state[k] = v; }, enumerable: true });
  }
  return D;
}

function enteredWorldEvt() {
  const e = { kind: ClientEventKind.ENTERED_WORLD, u32Payload: 0x50000001, u32Payload2: 0, stringPayload: "" };
  e.free = () => {};
  return e;
}

/** Dispatch kind=7 with the console muted (spawn-kick / Sky-B log lines). */
function enterWorld(D) {
  const log0 = console.log;
  const warn0 = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try { dispatchClientEvent(enteredWorldEvt(), D); } finally { console.log = log0; console.warn = warn0; }
}

function withSearch(search, fn) {
  const prev = location.search;
  location.search = search;
  try { return fn(); } finally { location.search = prev; }
}

// ── the helper ────────────────────────────────────────────────────────────

test("?houseQueryAtLogin: default on, off / 0 / false disable it", () => {
  assert.equal(houseQueryAtLoginEnabled(""), true);
  assert.equal(houseQueryAtLoginEnabled("?houseQueryAtLogin=on"), true);
  assert.equal(houseQueryAtLoginEnabled("?other=1"), true);
  for (const v of ["off", "0", "false"]) {
    assert.equal(houseQueryAtLoginEnabled(`?houseQueryAtLogin=${v}`), false, v);
  }
  // No argument reads location.search.
  withSearch("?houseQueryAtLogin=off", () => assert.equal(houseQueryAtLoginEnabled(), false));
  withSearch("", () => assert.equal(houseQueryAtLoginEnabled(), true));
});

test("once per handle: three login / respawn / teleport calls send one query", () => {
  const h = stubHandle();
  const sent = [maybeQueryHouseAtLogin(h, ""), maybeQueryHouseAtLogin(h, ""), maybeQueryHouseAtLogin(h, "")];
  assert.deepEqual(sent, [true, false, false]);
  assert.equal(h.calls, 1);
  // A relog builds a new SessionHandle: it asks again.
  const h2 = stubHandle();
  assert.equal(maybeQueryHouseAtLogin(h2, ""), true);
  assert.equal(h2.calls, 1);
  assert.equal(h.calls, 1, "the old handle is not asked again");
});

test("?houseQueryAtLogin=off sends nothing", () => {
  const h = stubHandle();
  for (const v of ["off", "0", "false"]) {
    assert.equal(maybeQueryHouseAtLogin(h, `?houseQueryAtLogin=${v}`), false, v);
  }
  assert.equal(h.calls, 0);
});

test("no handle / a stale pkg without houseQuery / a closed channel never throw", () => {
  assert.equal(maybeQueryHouseAtLogin(null, ""), false);
  assert.equal(maybeQueryHouseAtLogin(undefined, ""), false);
  assert.equal(maybeQueryHouseAtLogin(42, ""), false);
  assert.equal(maybeQueryHouseAtLogin({}, ""), false, "stale pkg/: no houseQuery export");
  assert.equal(maybeQueryHouseAtLogin({ houseQuery: 1 }, ""), false);
  // SessionHandle.houseQuery throws when the command channel is closed.
  let n = 0;
  const dead = { houseQuery() { n += 1; throw new Error("houseQuery: cmd channel closed"); } };
  const warn0 = console.warn;
  const warns = [];
  console.warn = (...a) => { warns.push(a.join(" ")); };
  try {
    assert.equal(maybeQueryHouseAtLogin(dead, ""), false);
    assert.equal(maybeQueryHouseAtLogin(dead, ""), false, "a dead session is not retried");
  } finally { console.warn = warn0; }
  assert.equal(n, 1);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /\[houseQuery\] login query failed/);
});

// ── the kind=7 EnteredWorld arm ───────────────────────────────────────────

test("EnteredWorld sends one HouseQuery per session: respawns and teleports repeat nothing", () => {
  const h = stubHandle();
  window.__sessionHandle = h;
  try {
    const D = makeDeps(h);
    enterWorld(D); // login
    assert.equal(D.enteredWorld, true);
    assert.equal(h.calls, 1, "the login entry asks once");
    enterWorld(D); // death respawn (kind=7 refires)
    enterWorld(D);
    assert.equal(h.calls, 1, "kind=7 refires do not repeat it");
    // Relog / session takeover: a new handle and a new login scope.
    const h2 = stubHandle();
    window.__sessionHandle = h2;
    const D2 = makeDeps(h2);
    enterWorld(D2);
    enterWorld(D2);
    assert.equal(h2.calls, 1, "the new session asks once");
    assert.equal(h.calls, 1);
  } finally {
    delete window.__sessionHandle;
  }
});

test("EnteredWorld falls back to D.handle when window.__sessionHandle is unset", () => {
  delete window.__sessionHandle;
  const h = stubHandle();
  enterWorld(makeDeps(h));
  assert.equal(h.calls, 1);
});

test("EnteredWorld with ?houseQueryAtLogin=off sends nothing", () => {
  const h = stubHandle();
  window.__sessionHandle = h;
  try {
    withSearch("?houseQueryAtLogin=off", () => enterWorld(makeDeps(h)));
    assert.equal(h.calls, 0);
  } finally {
    delete window.__sessionHandle;
  }
});

test("EnteredWorld with a stale pkg (no houseQuery) or a throwing houseQuery still enters the world", () => {
  const stale = {};
  window.__sessionHandle = stale;
  try {
    const D = makeDeps(stale);
    enterWorld(D); // EVT_GUARD_ON=false: any throw fails here
    assert.equal(D.enteredWorld, true);
    const dead = { houseQuery() { throw new Error("houseQuery: cmd channel closed"); } };
    window.__sessionHandle = dead;
    const D2 = makeDeps(dead);
    enterWorld(D2);
    assert.equal(D2.enteredWorld, true);
    assert.match(D2.loginStatus.innerHTML, /InWorld as GUID 0x50000001/, "the arm ran to its end");
  } finally {
    delete window.__sessionHandle;
  }
});

test("source pin: the query is sent from the ENTERED_WORLD arm, after the movement gate opens", () => {
  const src = readFileSync(path.join(APP, "app/client_events.js"), "utf8");
  const armStart = src.indexOf("evt.kind === ClientEventKind.ENTERED_WORLD");
  const armEnd = src.indexOf("evt.kind === ClientEventKind.CHARACTER_CREATED");
  assert.ok(armStart > 0 && armEnd > armStart);
  const call = src.indexOf("maybeQueryHouseAtLogin(", armStart);
  assert.ok(call > armStart && call < armEnd, "maybeQueryHouseAtLogin is called inside the kind=7 arm");
  assert.ok(src.indexOf("D.enteredWorld = true;", armStart) < call, "after the evtGuard gate flip");
  assert.equal(src.split("maybeQueryHouseAtLogin(").length - 1, 1, "one call site");
});

// ── what the House page shows after the login query ──────────────────────

test("after the login query, the House page reads the answer instead of 'Not looked up yet'", () => {
  // A wasm-snapshot stand-in: ACE's reply lands in latest_house_status /
  // latest_house_data, which the panel reads through these getters.
  function sessionWith(reply) {
    let status;
    let data;
    const h = stubHandle({
      playerHouseStatus: () => status,
      playerHouseData: () => data,
    });
    const base = h.houseQuery;
    h.houseQuery = () => { base(); ({ status, data } = reply()); };
    return h;
  }
  const snapOf = (h) => ({ status: h.playerHouseStatus(), data: h.playerHouseData() });

  // No house: HouseStatus(BadParam).
  const homeless = sessionWith(() => ({ status: { errorCode: WEENIE_ERROR_BAD_PARAM, isHouseOwner: false }, data: undefined }));
  withSearch("", () => {
    assert.match(ownership(snapOf(homeless)).text, /Not looked up yet/, "before the query");
    assert.equal(maybeQueryHouseAtLogin(homeless, ""), true);
    const own = ownership(snapOf(homeless));
    assert.equal(own.owner, false);
    assert.equal(own.text, "You do not own a house");
  });

  // Owner: HouseData.
  const owner = sessionWith(() => ({
    status: undefined,
    data: { houseType: 1, landblockId: 0xA9B40019, posX: 100, posY: 50, posZ: 0, buyTime: 1_700_000_000, rentTime: 1_700_000_000, maintenanceFree: false },
  }));
  withSearch("", () => {
    assert.equal(maybeQueryHouseAtLogin(owner, ""), true);
    const own = ownership(snapOf(owner));
    assert.equal(own.owner, true);
    assert.equal(own.text, "You own a house");
  });
});
