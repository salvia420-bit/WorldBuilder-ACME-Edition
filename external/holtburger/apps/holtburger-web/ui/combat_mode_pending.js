// ui/combat_mode_pending.js — retail's parked combat-mode request
// (combat-magic-5, 2026-10-13).
//
// RETAIL (acclient.c):
//   ClientCombatSystem::SetCombatMode (:408787), for a player-requested
//   change, runs the CompatibleCombatMode and teleportInProgress checks, then
//     if (!PlayerInReadyPosition(this, 0)) { pendingCombatMode = mode; return; }
//   ClientCombatSystem::UseTime (:409086) applies it once the player is ready:
//     if (pendingCombatMode && PlayerInReadyPosition(this, 0))
//       { SetCombatMode(pendingCombatMode, 1); pendingCombatMode = 0; }
//   PlayerInReadyPosition (:408485), by the CURRENT combat mode:
//     Peace (1) / Magic (8) → !motions_pending
//     Melee (2)             → a CombatTable && !motions_pending
//     Missile (4)           → a missile style && forward_command == Ready
//                             (0x41000003) && !motions_pending
//   ToggleCombatMode (:409413) reads the unchanged combatMode, so a second
//   press while a change is parked asks for the same mode again.
//
// WHY: ACE runs `if (CombatMode == Magic && MagicState.IsCasting) FailCast();
// HandleActionCancelAttack();` on every mode change
// (Player_Combat.cs HandleActionChangeCombatMode_Inner). Holtburger sent the
// change at once, so the combat key pressed during a spell windup lost the
// spell. Retail lets the cast finish and then changes stance.
//
// OURS:
//   motions_pending → the wasm `movementPendingMotionsDiag()` rider on
//     `window.__hbWasm`: the local registry minterp's pending completion-node
//     count (the queue term only, not the MoveTo-projection / interpolation
//     carriers). A wire stomp (windup, cast gesture, swing) raises it and the
//     completion clock drains it.
//   Magic also waits while one of our casts is outstanding
//     (SessionHandle.castMoveLockActive(), or getBusyState() > 0 = retail
//     m_cBusy): the server's windup stomp lands one round trip after the send,
//     and between two stomps the queue can briefly read 0.
//   Missile forward_command == Ready → `castArbitrationDiag()` bits 4-5 == 0
//     (the interpreted forward slot is empty, which is retail's Ready).
//   Not ported: Melee's CombatTable test (every player has one) and the
//     missile style list. A style swap is itself a pending motion, and ACE's
//     BowNoAmmo / CrossBowNoAmmo stances are not in the 2013 list, so a
//     request there would park until the cap.
//   An unknown current mode uses the Peace rule (retail's default case is
//     "not ready"; a stale pkg/ without the exports reads ready = the old
//     send-at-once path).
//   A request is never stranded: after COMBAT_MODE_PARK_CAP_MS it is sent
//   anyway. It is dropped on logout (the session handle changed, compared
//   by sessionIdentity() so the rejection_feedback.js Proxy on the global
//   and a caller's raw handle are the same session), on death
//   (the plugin bus "death" for our guid) and in portal space (retail's
//   UseTime re-enters SetCombatMode, which refuses there with the
//   ui/portal_busy.js line).
//
// Only the USER paths park: the index.html combat key, the combat-bar and
// target-bar stance buttons, and plugins/api.js player.toggleCombatMode. The
// wasm setCombatMode / toggleCombatMode exports that rynth/webhost.js calls
// are untouched, so the bot sends at once as before. Each caller hands over
// its own send, and the intent stamp (ui/ac_combat_mode_intent.js) lives in
// that send, so it happens when the request actually goes out.
//
// `?combatModePark=off` (or 0 / false) sends at once, as before.

import { portalSpaceActive, refuseCombatModeInPortalSpace } from "./portal_busy.js";

export const COMBAT_MODE_NON_COMBAT = 1;
export const COMBAT_MODE_MELEE = 2;
export const COMBAT_MODE_MISSILE = 4;
export const COMBAT_MODE_MAGIC = 8;
/** An untyped toggle (the wasm toggleCombatMode picks the mode when sent). */
export const COMBAT_MODE_TOGGLE = -1;

/** Safety cap: a parked request is sent anyway after this long. */
export const COMBAT_MODE_PARK_CAP_MS = 3000;
/** Poll period while a request is parked (UseTime runs once per frame). */
export const COMBAT_MODE_PARK_POLL_MS = 33;

/**
 * ClientCombatSystem::PlayerInReadyPosition (acclient.c:408485) with
 * `_considerAttackingReady = 0`, by the CURRENT combat mode.
 *
 * @param {object} s
 * @param {number} s.mode              current mode (1/2/4/8; 0 = unknown)
 * @param {boolean} s.motionsPending   CPhysicsObj::motions_pending
 * @param {boolean} [s.forwardReady]   interpreted forward_command == Ready (missile)
 * @param {boolean} [s.castOutstanding] one of our casts awaits its UseDone (magic)
 */
export function playerInReadyPosition({
  mode = 0,
  motionsPending = false,
  forwardReady = true,
  castOutstanding = false,
} = {}) {
  if (motionsPending) return false;
  if (mode === COMBAT_MODE_MISSILE) return forwardReady !== false;
  if (mode === COMBAT_MODE_MAGIC) return !castOutstanding;
  return true;
}

/**
 * ClientCombatSystem::pendingCombatMode, pure. `request` is SetCombatMode's
 * ready step, `poll` / `release` is UseTime's. The newest request wins: a
 * second request while one is parked replaces it, and a request made while
 * ready drops the parked one.
 *
 * @param {{capMs?: number}} [opts]
 */
export function createCombatModePark({ capMs = COMBAT_MODE_PARK_CAP_MS } = {}) {
  let pending = 0; // 0 = none (UNDEF_COMBAT_MODE)
  let send = null; // the caller's send for it
  let parkedAt = 0;
  const release = (ready, nowMs = 0) => {
    if (!pending) return null;
    if (!ready && !(nowMs - parkedAt >= capMs)) return null;
    const entry = { mode: pending, send };
    pending = 0;
    send = null;
    return entry;
  };
  return {
    /** True = apply now; false = parked until the player is ready. */
    request(mode, ready, nowMs = 0, onSend = null) {
      const m = Number(mode) | 0;
      if (ready || !m) {
        pending = 0;
        send = null;
        return true;
      }
      pending = m;
      send = onSend;
      parkedAt = nowMs;
      return false;
    },
    /** The parked mode and its send to apply now (ready or capped), else null. */
    release,
    /** The parked mode to apply now (ready or capped), else 0. */
    poll(ready, nowMs = 0) {
      return release(ready, nowMs)?.mode ?? 0;
    },
    clear() {
      pending = 0;
      send = null;
    },
    get pending() {
      return pending;
    },
  };
}

// ── wiring ──────────────────────────────────────────────────────────────────

const W = () => (typeof window !== "undefined" ? window : globalThis);

let _flag = null;
/** `?combatModePark` — DEFAULT-ON; `off` / `0` / `false` sends at once. */
export function combatModeParkEnabled(search) {
  if (typeof search === "string") {
    const v = new URLSearchParams(search).get("combatModePark")?.toLowerCase();
    return !(v === "off" || v === "0" || v === "false");
  }
  if (_flag === null) {
    try { _flag = combatModeParkEnabled(globalThis.location?.search ?? ""); } catch (_) { _flag = true; }
  }
  return _flag;
}

/**
 * PlayerInReadyPosition from the live client: the handle's confirmed
 * combatMode() and the wasm riders on `window.__hbWasm`. A missing export
 * reads as ready (the old send-at-once path).
 */
export function readCombatModeReadiness(handle, wasm) {
  const ns = wasm === undefined ? W().__hbWasm : wasm;
  let mode = 0;
  try {
    if (typeof handle?.combatMode === "function") mode = handle.combatMode() >>> 0;
  } catch (_) { mode = 0; }
  let motionsPending = false;
  try {
    const n = ns?.movementPendingMotionsDiag?.();
    motionsPending = Number.isFinite(n) && n > 0;
  } catch (_) { motionsPending = false; }
  let forwardReady = true;
  if (mode === COMBAT_MODE_MISSILE) {
    try {
      const d = ns?.castArbitrationDiag?.();
      if (Number.isFinite(d)) forwardReady = ((d >>> 4) & 0x3) === 0;
    } catch (_) { forwardReady = true; }
  }
  let castOutstanding = false;
  if (mode === COMBAT_MODE_MAGIC) {
    try { castOutstanding = handle?.castMoveLockActive?.() === true; } catch (_) { castOutstanding = false; }
    if (!castOutstanding) {
      try {
        const b = handle?.getBusyState?.();
        castOutstanding = Number.isFinite(b) && b > 0;
      } catch (_) { castOutstanding = false; }
    }
  }
  return playerInReadyPosition({ mode, motionsPending, forwardReady, castOutstanding });
}

/**
 * The registered symbol a wrapping Proxy over the session handle answers with
 * its raw target (plugins/rejection_feedback.js). `Symbol.for`, so the two
 * modules share it without an import.
 */
export const RAW_SESSION_HANDLE = Symbol.for("holtburger.rawSessionHandle");

/**
 * The session's identity: the raw wasm handle under any wrapping Proxy.
 * plugins/rejection_feedback.js replaces `window.__sessionHandle` with a Proxy
 * ~100 ms after login, while index.html's key handler keeps the raw `handle`,
 * so comparing the objects themselves would read every parked request as a
 * logout.
 */
export function sessionIdentity(h) {
  let cur = h ?? null;
  for (let i = 0; i < 4 && cur != null; i++) {
    let inner;
    try { inner = cur[RAW_SESSION_HANDLE]; } catch (_) { break; }
    if (inner == null || inner === cur) break;
    cur = inner;
  }
  return cur;
}

const _park = createCombatModePark();
// sessionIdentity() of the handle the parked request belongs to.
let _parkHandle = null;
let _timer = null;
let _releasing = false;
let _deathBus = null;
let _onDeath = null;
const _defaultNow = () =>
  (typeof performance !== "undefined" && typeof performance.now === "function")
    ? performance.now()
    : Date.now();
let _now = _defaultNow;
let _schedule = (fn) => setTimeout(fn, COMBAT_MODE_PARK_POLL_MS);
let _cancel = (id) => clearTimeout(id);

function startPolling() {
  if (_timer == null) _timer = _schedule(pollParkedCombatMode);
}

function stopPolling() {
  if (_timer != null) {
    try { _cancel(_timer); } catch (_) { /* best effort */ }
    _timer = null;
  }
}

// A parked request dies with the player (the "death" bus event for our guid).
function watchDeath() {
  const bus = W().__pluginClient?.events;
  if (!bus || typeof bus.on !== "function" || bus === _deathBus) return;
  if (_deathBus && _onDeath) {
    try { _deathBus.off?.("death", _onDeath); } catch (_) { /* old bus */ }
  }
  _onDeath = (ev) => {
    if (!_park.pending) return;
    const p = ev?.detail ?? ev;
    let me = 0;
    try { me = (W().__sessionHandle?.playerGuid?.() ?? 0) >>> 0; } catch (_) { me = 0; }
    if (me && ((p?.victimGuid ?? 0) >>> 0) === me) clearParkedCombatMode();
  };
  try {
    bus.on("death", _onDeath);
    _deathBus = bus;
  } catch (_) { _onDeath = null; }
}

/**
 * The user-path entry: send now when the player is in the ready position,
 * else park `send` until they are (or until the cap). Exceptions from an
 * immediate send reach the caller, as before. Returns true when sent now.
 *
 * @param {number} mode   COMBAT_MODE_* or COMBAT_MODE_TOGGLE
 * @param {() => void} send  the caller's wire send (and its intent stamp)
 * @param {{handle?: object}} [opts]
 */
export function requestCombatModeChange(mode, send, opts = {}) {
  if (typeof send !== "function") return false;
  // A send that itself requests (combat-bar's api.js toggle fallback) goes
  // straight out: it is already the parked request being applied.
  if (_releasing || !combatModeParkEnabled()) {
    send();
    return true;
  }
  const handle = opts.handle ?? W().__sessionHandle ?? null;
  if (_park.request(mode, readCombatModeReadiness(handle), _now(), send)) {
    stopPolling();
    _parkHandle = null;
    send();
    return true;
  }
  _parkHandle = sessionIdentity(handle);
  watchDeath();
  startPolling();
  return false;
}

/** UseTime's half: apply the parked request when ready. Returns the mode sent, or 0. */
export function pollParkedCombatMode() {
  _timer = null;
  if (!_park.pending) return 0;
  const handle = W().__sessionHandle ?? null;
  if (sessionIdentity(handle) !== _parkHandle) {
    // Logout / relog: the request belonged to the old session. (The raw
    // handle a caller parked with and the rejection_feedback.js Proxy on the
    // global are the same session.)
    clearParkedCombatMode();
    return 0;
  }
  if (portalSpaceActive()) {
    refuseCombatModeInPortalSpace();
    clearParkedCombatMode();
    return 0;
  }
  const entry = _park.release(readCombatModeReadiness(handle), _now());
  if (!entry) {
    startPolling();
    return 0;
  }
  _parkHandle = null;
  _releasing = true;
  try {
    entry.send?.();
  } catch (e) {
    console.warn("[combat-mode] parked combat-mode change failed:", e);
  } finally {
    _releasing = false;
  }
  return entry.mode;
}

/** Drop any parked request (death / teleport / logout). */
export function clearParkedCombatMode() {
  _park.clear();
  _parkHandle = null;
  stopPolling();
}

/** The parked mode (COMBAT_MODE_* / COMBAT_MODE_TOGGLE), or 0. */
export function parkedCombatMode() {
  return _park.pending;
}

/** Test hook: inject the clock / scheduler and re-read the flag. */
export function _configureCombatModeParkForTests({ now, schedule, cancel } = {}) {
  clearParkedCombatMode();
  _flag = null;
  _now = typeof now === "function" ? now : _defaultNow;
  _schedule = typeof schedule === "function" ? schedule : (fn) => setTimeout(fn, COMBAT_MODE_PARK_POLL_MS);
  _cancel = typeof cancel === "function" ? cancel : (id) => clearTimeout(id);
  _deathBus = null;
  _onDeath = null;
}

if (typeof globalThis !== "undefined") {
  // index.html's inline key handler cannot import, and plugins/combat-bar.js
  // keeps its import list fixed (the spliced plugin tests pin it); both call
  // this global.
  globalThis.__requestCombatModeChange = requestCombatModeChange;
  globalThis.__parkedCombatMode = parkedCombatMode;
}
