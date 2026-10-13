// tests/combat_mode_pending.test.mjs — combat-magic-5 (2026-10-13).
//
// Retail ClientCombatSystem::SetCombatMode (acclient.c:408787) parks a
// player-requested combat-mode change while the player is not in the ready
// position (`pendingCombatMode = mode; return;` :408852), and UseTime
// (:409086) applies it once PlayerInReadyPosition (:408485) says ready. ACE
// fails an in-progress cast on every mode change (Player_Combat.cs
// HandleActionChangeCombatMode_Inner), so sending at once lost the spell.
//
// Pins ui/combat_mode_pending.js: the pure park, the readiness rule, the
// user-path wiring (cap, teleport, logout, death, ?combatModePark=off), and by
// source the four user call sites plus rynth's untouched wasm path.
//
// Run: node tests/combat_mode_pending.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  COMBAT_MODE_NON_COMBAT, COMBAT_MODE_MELEE, COMBAT_MODE_MISSILE, COMBAT_MODE_MAGIC,
  COMBAT_MODE_TOGGLE, COMBAT_MODE_PARK_CAP_MS,
  playerInReadyPosition, createCombatModePark, combatModeParkEnabled,
  readCombatModeReadiness, requestCombatModeChange, pollParkedCombatMode,
  clearParkedCombatMode, parkedCombatMode, _configureCombatModeParkForTests,
} from "../ui/combat_mode_pending.js";
import { PORTAL_COMBAT_REFUSAL } from "../ui/portal_busy.js";

const src = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

// ── the pure park (WebAC CombatModeChange.ts PendingCombatMode shape) ──────

test("ready: request returns true and nothing is parked", () => {
  const p = createCombatModePark();
  assert.equal(p.request(COMBAT_MODE_MELEE, true, 0), true);
  assert.equal(p.pending, 0);
  assert.equal(p.poll(true, 0), 0);
});

test("not ready: parked; poll(false) → 0, poll(true) → the mode exactly once", () => {
  const p = createCombatModePark();
  assert.equal(p.request(COMBAT_MODE_NON_COMBAT, false, 0), false);
  assert.equal(p.pending, COMBAT_MODE_NON_COMBAT);
  assert.equal(p.poll(false, 100), 0);
  assert.equal(p.poll(true, 200), COMBAT_MODE_NON_COMBAT);
  assert.equal(p.poll(true, 300), 0, "applied once");
  assert.equal(p.pending, 0);
});

test("a second request while parked replaces it (mode and send)", () => {
  const p = createCombatModePark();
  const a = () => "a";
  const b = () => "b";
  p.request(COMBAT_MODE_MELEE, false, 0, a);
  p.request(COMBAT_MODE_MAGIC, false, 10, b);
  const e = p.release(true, 20);
  assert.equal(e.mode, COMBAT_MODE_MAGIC);
  assert.equal(e.send, b);
});

test("a request made while ready drops the parked one (the newest wins)", () => {
  const p = createCombatModePark();
  p.request(COMBAT_MODE_MELEE, false, 0);
  assert.equal(p.request(COMBAT_MODE_NON_COMBAT, true, 10), true);
  assert.equal(p.pending, 0);
});

test("the ~3 s cap releases a request whose player never becomes ready", () => {
  assert.equal(COMBAT_MODE_PARK_CAP_MS, 3000);
  const p = createCombatModePark();
  p.request(COMBAT_MODE_TOGGLE, false, 1000);
  assert.equal(p.poll(false, 1000 + COMBAT_MODE_PARK_CAP_MS - 1), 0, "not yet");
  assert.equal(p.poll(false, 1000 + COMBAT_MODE_PARK_CAP_MS), COMBAT_MODE_TOGGLE, "capped");
});

test("clear() drops the parked request", () => {
  const p = createCombatModePark();
  p.request(COMBAT_MODE_MELEE, false, 0);
  p.clear();
  assert.equal(p.pending, 0);
  assert.equal(p.poll(true, 1e9), 0);
});

// ── PlayerInReadyPosition ──────────────────────────────────────────────────

test("PlayerInReadyPosition: motions pending is never ready, in any mode", () => {
  for (const mode of [0, COMBAT_MODE_NON_COMBAT, COMBAT_MODE_MELEE, COMBAT_MODE_MISSILE, COMBAT_MODE_MAGIC]) {
    assert.equal(playerInReadyPosition({ mode, motionsPending: true }), false, `mode ${mode}`);
    assert.equal(playerInReadyPosition({ mode, motionsPending: false }), true, `mode ${mode}`);
  }
});

test("PlayerInReadyPosition: missile needs forward_command == Ready", () => {
  assert.equal(playerInReadyPosition({ mode: COMBAT_MODE_MISSILE, forwardReady: false }), false);
  assert.equal(playerInReadyPosition({ mode: COMBAT_MODE_MISSILE, forwardReady: true }), true);
  // Only missile reads the forward slot (retail cases 1/2/8 never do).
  assert.equal(playerInReadyPosition({ mode: COMBAT_MODE_MELEE, forwardReady: false }), true);
  assert.equal(playerInReadyPosition({ mode: COMBAT_MODE_NON_COMBAT, forwardReady: false }), true);
});

test("PlayerInReadyPosition: magic waits for an outstanding cast", () => {
  assert.equal(playerInReadyPosition({ mode: COMBAT_MODE_MAGIC, castOutstanding: true }), false);
  assert.equal(playerInReadyPosition({ mode: COMBAT_MODE_NON_COMBAT, castOutstanding: true }), true);
});

// ── readiness from the live client (handle + __hbWasm riders) ──────────────

const fwd = (occ) => (occ & 0x3) << 4; // castArbitrationDiag bits 4-5

test("missile mode with forward held is not ready (castArbitrationDiag forward slot)", () => {
  const h = { combatMode: () => COMBAT_MODE_MISSILE };
  for (const occ of [1, 2, 3]) {
    const wasm = { movementPendingMotionsDiag: () => 0, castArbitrationDiag: () => fwd(occ) | 0x1 };
    assert.equal(readCombatModeReadiness(h, wasm), false, `occupancy ${occ}`);
  }
  const idle = { movementPendingMotionsDiag: () => 0, castArbitrationDiag: () => 0x7 };
  assert.equal(readCombatModeReadiness(h, idle), true, "empty slot = Ready");
  // The same held forward in Melee is ready (retail case 2 ignores it).
  const run = { movementPendingMotionsDiag: () => 0, castArbitrationDiag: () => fwd(2) };
  assert.equal(readCombatModeReadiness({ combatMode: () => COMBAT_MODE_MELEE }, run), true);
});

test("a pending minterp motion is not ready (movementPendingMotionsDiag > 0)", () => {
  const h = { combatMode: () => COMBAT_MODE_NON_COMBAT };
  assert.equal(readCombatModeReadiness(h, { movementPendingMotionsDiag: () => 2 }), false);
  assert.equal(readCombatModeReadiness(h, { movementPendingMotionsDiag: () => 0 }), true);
});

test("magic mode: an outstanding cast (busy count or cast move lock) is not ready", () => {
  const wasm = { movementPendingMotionsDiag: () => 0 };
  assert.equal(readCombatModeReadiness({ combatMode: () => 8, getBusyState: () => 1 }, wasm), false);
  assert.equal(readCombatModeReadiness({ combatMode: () => 8, castMoveLockActive: () => true }, wasm), false);
  assert.equal(readCombatModeReadiness({ combatMode: () => 8, getBusyState: () => 0 }, wasm), true);
  // A use outstanding in Peace does not park (retail reads motions only).
  assert.equal(readCombatModeReadiness({ combatMode: () => 1, getBusyState: () => 1 }, wasm), true);
});

test("a stale pkg / throwing getters read as ready (the old send-at-once path)", () => {
  assert.equal(readCombatModeReadiness({}, {}), true);
  assert.equal(readCombatModeReadiness(null, null), true);
  const boom = () => { throw new Error("boom"); };
  assert.equal(readCombatModeReadiness(
    { combatMode: () => 8, getBusyState: boom, castMoveLockActive: boom },
    { movementPendingMotionsDiag: boom, castArbitrationDiag: boom },
  ), true);
});

test("?combatModePark: default on; off / 0 / false disable", () => {
  assert.equal(combatModeParkEnabled(""), true);
  assert.equal(combatModeParkEnabled("?combatModePark=on"), true);
  for (const v of ["off", "0", "false", "OFF"]) {
    assert.equal(combatModeParkEnabled(`?combatModePark=${v}`), false, v);
  }
});

// ── the user-path wiring ───────────────────────────────────────────────────

// A Magic-mode player; `pending` = the minterp queue, `busy` = getBusyState.
function rig() {
  let t = 0;
  const pollers = [];
  _configureCombatModeParkForTests({
    now: () => t,
    schedule: (fn) => { pollers.push(fn); return pollers.length; },
    cancel: () => {},
  });
  const state = { pending: 0, mode: COMBAT_MODE_MAGIC, busy: 0 };
  const handle = {
    combatMode: () => state.mode,
    getBusyState: () => state.busy,
    playerGuid: () => 0x50000001,
  };
  globalThis.__sessionHandle = handle;
  globalThis.__hbWasm = { movementPendingMotionsDiag: () => state.pending, castArbitrationDiag: () => 0 };
  return {
    state, handle,
    advance(ms) { t += ms; },
    scheduled: () => pollers.length,
  };
}

function cleanup() {
  clearParkedCombatMode();
  delete globalThis.__sessionHandle;
  delete globalThis.__hbWasm;
  delete globalThis.__pluginClient;
  delete globalThis.__isPortalSpaceActive;
  delete globalThis.location;
  _configureCombatModeParkForTests();
}

test("ready: the send runs synchronously, exactly as before", () => {
  const r = rig();
  try {
    let sent = 0;
    assert.equal(requestCombatModeChange(COMBAT_MODE_TOGGLE, () => { sent += 1; }), true);
    assert.equal(sent, 1);
    assert.equal(parkedCombatMode(), 0);
    assert.equal(r.scheduled(), 0, "no poll scheduled");
  } finally { cleanup(); }
});

test("ready: an immediate send that throws reaches the caller (its try/catch)", () => {
  rig();
  try {
    assert.throws(() => requestCombatModeChange(COMBAT_MODE_MELEE, () => { throw new Error("closed"); }), /closed/);
  } finally { cleanup(); }
});

test("a toggle during a spell windup waits for the cast, then sends once", () => {
  const r = rig();
  try {
    r.state.pending = 2; // the windup stomp is on the minterp queue
    r.state.busy = 1;    // our cast awaits its UseDone
    let sent = 0;
    assert.equal(requestCombatModeChange(COMBAT_MODE_TOGGLE, () => { sent += 1; }), false);
    assert.equal(sent, 0, "parked, not sent");
    assert.equal(parkedCombatMode(), COMBAT_MODE_TOGGLE);
    r.advance(500);
    assert.equal(pollParkedCombatMode(), 0);
    r.state.pending = 0; // windup done, cast gesture not stomped yet
    r.advance(100);
    assert.equal(pollParkedCombatMode(), 0, "the cast is still outstanding");
    r.state.busy = 0;    // UseDone
    r.advance(100);
    assert.equal(pollParkedCombatMode(), COMBAT_MODE_TOGGLE);
    assert.equal(sent, 1);
    assert.equal(pollParkedCombatMode(), 0);
    assert.equal(sent, 1, "exactly once");
  } finally { cleanup(); }
});

test("the cap sends a request whose player never becomes ready", () => {
  const r = rig();
  try {
    r.state.pending = 1;
    let sent = 0;
    requestCombatModeChange(COMBAT_MODE_NON_COMBAT, () => { sent += 1; });
    r.advance(COMBAT_MODE_PARK_CAP_MS - 1);
    assert.equal(pollParkedCombatMode(), 0);
    r.advance(1);
    assert.equal(pollParkedCombatMode(), COMBAT_MODE_NON_COMBAT);
    assert.equal(sent, 1);
  } finally { cleanup(); }
});

test("a second press while parked replaces the parked send", () => {
  const r = rig();
  try {
    r.state.pending = 1;
    const log = [];
    requestCombatModeChange(COMBAT_MODE_MELEE, () => log.push("melee"));
    requestCombatModeChange(COMBAT_MODE_NON_COMBAT, () => log.push("peace"));
    r.state.pending = 0;
    pollParkedCombatMode();
    assert.deepEqual(log, ["peace"]);
  } finally { cleanup(); }
});

test("teleport: portal space drops the parked request with retail's refusal line", () => {
  const r = rig();
  const lines = [];
  const savedChat = globalThis.__appendChatLine;
  globalThis.__appendChatLine = (t, c) => lines.push([t, c]);
  try {
    r.state.pending = 1;
    let sent = 0;
    requestCombatModeChange(COMBAT_MODE_TOGGLE, () => { sent += 1; });
    globalThis.__isPortalSpaceActive = () => true;
    r.state.pending = 0;
    assert.equal(pollParkedCombatMode(), 0);
    assert.equal(sent, 0);
    assert.equal(parkedCombatMode(), 0);
    assert.deepEqual(lines, [[PORTAL_COMBAT_REFUSAL, 9]]);
  } finally {
    globalThis.__appendChatLine = savedChat;
    cleanup();
  }
});

test("logout: a new (or no) session handle drops the parked request", () => {
  const r = rig();
  try {
    r.state.pending = 1;
    let sent = 0;
    requestCombatModeChange(COMBAT_MODE_TOGGLE, () => { sent += 1; });
    globalThis.__sessionHandle = null;
    r.state.pending = 0;
    assert.equal(pollParkedCombatMode(), 0);
    assert.equal(sent, 0);
    assert.equal(parkedCombatMode(), 0);
  } finally { cleanup(); }
});

test("death: our own death on the plugin bus drops it; someone else's does not", () => {
  const r = rig();
  const handlers = new Map();
  globalThis.__pluginClient = {
    events: {
      on(n, fn) { handlers.set(n, fn); },
      off(n) { handlers.delete(n); },
    },
  };
  try {
    r.state.pending = 1;
    let sent = 0;
    requestCombatModeChange(COMBAT_MODE_MELEE, () => { sent += 1; });
    const onDeath = handlers.get("death");
    assert.equal(typeof onDeath, "function", "subscribed while parked");
    // plugins/api.js emits CustomEvent{detail: payload}.
    onDeath({ detail: { victimGuid: 0x50000099, killerGuid: 0x50000001 } });
    assert.equal(parkedCombatMode(), COMBAT_MODE_MELEE, "a kill we made keeps it");
    onDeath({ detail: { victimGuid: 0x50000001, killerGuid: 0x80000001 } });
    assert.equal(parkedCombatMode(), 0, "our death drops it");
    r.state.pending = 0;
    pollParkedCombatMode();
    assert.equal(sent, 0);
  } finally { cleanup(); }
});

test("a request made from inside the released send goes straight out (no re-park)", () => {
  const r = rig();
  try {
    r.state.pending = 1;
    let inner = 0;
    requestCombatModeChange(COMBAT_MODE_TOGGLE, () => {
      // combat-bar's stale-pkg fallback calls api.js toggleCombatMode, which
      // requests again; the player may still be busy at the cap.
      requestCombatModeChange(COMBAT_MODE_TOGGLE, () => { inner += 1; });
    });
    r.advance(COMBAT_MODE_PARK_CAP_MS);
    assert.equal(pollParkedCombatMode(), COMBAT_MODE_TOGGLE);
    assert.equal(inner, 1);
    assert.equal(parkedCombatMode(), 0);
  } finally { cleanup(); }
});

test("?combatModePark=off sends at once even mid-cast", () => {
  const r = rig();
  globalThis.location = { search: "?combatModePark=off" };
  try {
    r.state.pending = 3;
    r.state.busy = 1;
    let sent = 0;
    assert.equal(requestCombatModeChange(COMBAT_MODE_TOGGLE, () => { sent += 1; }), true);
    assert.equal(sent, 1);
    assert.equal(parkedCombatMode(), 0);
  } finally { cleanup(); }
});

test("the module installs the global the inline key handler and combat-bar call", () => {
  assert.equal(globalThis.__requestCombatModeChange, requestCombatModeChange);
  assert.equal(typeof globalThis.__parkedCombatMode, "function");
});

// ── wiring (source pins: the call sites need a DOM / the wasm session) ─────

test("the four user paths route through the park; the portal refusal stays first", () => {
  const html = src("index.html");
  assert.match(html, /window\.__requestCombatModeChange\(-1, sendToggle, \{ handle \}\)/);
  assert.match(html, /window\.__refuseCombatModeInPortalSpace\(\)/);
  const api = src("plugins/api.js");
  assert.match(api, /import \{ requestCombatModeChange, COMBAT_MODE_TOGGLE \} from "\.\.\/ui\/combat_mode_pending\.js";/);
  // The C8 intent stamp rides inside the send: stamped when it actually goes out.
  assert.match(api, /requestCombatModeChange\(COMBAT_MODE_TOGGLE, \(\) => \{[^}]*?noteCombatModeRequest\(null\);\s*host\.ToggleCombatMode\(\);/);
  const tb = src("plugins/target-bar.js");
  assert.match(tb, /requestCombatModeChange\(canSet \? next : COMBAT_MODE_TOGGLE, send, \{ handle \}\)/);
  const cb = src("plugins/combat-bar.js");
  assert.match(cb, /window\.__requestCombatModeChange\(targetMode, send, \{ handle \}\)/);
  assert.doesNotMatch(cb, /from "\.\.\/ui\/combat_mode_pending\.js"/, "combat-bar's import list stays pinned");
  for (const rel of ["plugins/api.js", "plugins/combat-bar.js", "plugins/target-bar.js"]) {
    assert.match(src(rel), /if \(refuseCombatModeInPortalSpace\(\)\) return;/, rel);
  }
});

test("rynth keeps calling the wasm exports directly (bot unaffected)", () => {
  const wh = src("rynth/webhost.js");
  assert.match(wh, /ChangeCombatMode: \["setCombatMode"\]/);
  assert.match(wh, /ToggleCombatMode: \["toggleCombatMode"\]/);
  assert.doesNotMatch(wh, /combat_mode_pending|__requestCombatModeChange/);
});
