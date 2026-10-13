// ui/ui_lock.js — input-options-4 (2026-10-13): retail's ONE global LockUI.
//
// RETAIL (acclient.c): PlayerModule::LockUI is `BYTE3(options2_) & 1` — the
// CharacterOptions2 bit 0x01000000, CharacterOption 0x33 (PlayerOption 51;
// holtburger-common character.rs LOCK_UI / LockUI, ACE CharacterOption.LockUI).
// PlayerModule::SetLockUI flips it only when it changes and fires
// OnChanged(51), which saves it with the character. Three writers, one state:
//   * gmRadarUI::ListenToElementMessage — the radar lock button 0x10000619:
//     SetLockUI(!LockUI) + UIElementManager::BroadcastGlobalMessage(0xD)
//   * ClientCommunicationSystem::DoLockUI — `@lockui` / `/lockui`, same toggle
//     (any argument prints "Please use @help lockui for proper usage.")
//   * Options → Character "Lock UI" (PlayerModule::SetOption → SetLockUI)
// Global message 0xD makes every floaty re-read it in UpdateLockedStatus
// (*_Locked border set, drag button hidden): gmFloatyToolbarUI,
// gmFloatyVitalsUI / gmFloatySideVitalsUI / gmFloatyPanelUI, gmFloatyPowerBarUI,
// gmFloatyMainChatUI, gmFloatyIndicatorsUI, gmFloatyExaminationUI,
// gmFloatyCombatPanelUI / gmFloatyEnvPanelUI, gmSmartBoxUI and gmRadarUI.
//
// HERE: this module owns that state. It is seeded from the server's options2
// (`isCharacterOptionEnabled(0x33)`, hydrated by PlayerDescription) on every
// `playerStatsUpdated`; every writer goes through setGlobalLock(), which sends
// SetSingleCharacterOption(0x33) and notifies subscribers plus a DOM
// GLOBAL_LOCK_EVENT. That event is deliberately NOT the per-window
// `hb-ui-lock-changed`: its listeners filter on `windowId >>> 0`, which would
// silently drop a broadcast. Windows opt in with `obeysGlobalLock: true`
// (ui/ac_window_position.js, ui/ac_floaty_frame.js, ui/ac_resize_corners.js);
// such a window is locked when the global lock OR its own per-window lock is
// set. Windows that never pass it (the RynthSuite HUD and VT panel) keep their
// own lock only, byte-identical to before.
//
// `?globalLockUI=off` restores the per-window-only behaviour.
//
// No DOM access at import time — unit-testable under plain node. The one
// import-time side effect is the `window.__uiLock` seam (app/slash_commands.js
// may not gain a static import, so `/lockui` reaches this module through it).

import { isCharacterOptionEnabled, setCharacterOption } from "./ac_character_options.js";

/** CharacterOption::LockUI (holtburger-common character.rs, ACE CharacterOption.cs). */
export const CHARACTER_OPTION_LOCK_UI = 0x33;
/** CharacterOptions2::LOCK_UI — PlayerModule::LockUI reads BYTE3(options2_) & 1. */
export const OPTIONS2_LOCK_UI = 0x01000000;
/** DOM event fired on `document` when the global lock changes: detail `{ locked, source }`. */
export const GLOBAL_LOCK_EVENT = "hb-ui-global-lock-changed";

// A local toggle is applied to the wasm stats snapshot asynchronously (the
// SetCharacterOption arm runs on the next recv-loop pass). A stats read in
// between still carries the old bit and must not undo the click; it is
// ignored until it agrees or this long has passed.
const PENDING_MS = 2000;

/** `?globalLockUI` — DEFAULT-ON; `off` / `0` / `false` keeps per-window locks only. */
export function globalLockUIEnabled(search) {
  try {
    const s = search ?? globalThis.location?.search ?? "";
    const v = new URLSearchParams(s).get("globalLockUI");
    return !(v === "off" || v === "0" || v === "false");
  } catch (_) { return true; }
}

/** PlayerModule::LockUI for a raw CharacterOptions2 word. */
export function lockUiFromOptions2(options2) {
  return (((Number(options2) >>> 0) >>> 24) & 1) === 1;
}

let _locked = false;
let _pending = null; // { value, until } after a local toggle
const _listeners = new Set();

function nowMs(t) {
  return Number.isFinite(t) ? t : Date.now();
}

function commit(locked, source) {
  _locked = locked;
  for (const fn of [..._listeners]) {
    try { fn(locked, source); } catch (_) {}
  }
  try {
    if (typeof document !== "undefined" && typeof document?.dispatchEvent === "function"
        && typeof CustomEvent === "function") {
      document.dispatchEvent(new CustomEvent(GLOBAL_LOCK_EVENT, { detail: { locked, source } }));
    }
  } catch (_) {}
}

/** PlayerModule::LockUI — the current global state. */
export function isGlobalLocked() {
  return _locked;
}

/**
 * Subscribe to global lock changes (BroadcastGlobalMessage 0xD). The callback
 * gets `(locked, source)` with source "local" or "server". Returns an
 * unsubscribe function.
 */
export function onGlobalLockChange(fn) {
  if (typeof fn !== "function") return () => {};
  _listeners.add(fn);
  return () => { _listeners.delete(fn); };
}

/**
 * PlayerModule::SetLockUI. A change sends SetSingleCharacterOption(0x33)
 * (retail OnChanged(51)) unless `opts.send === false` (the caller already
 * sent it), then notifies every obeying window. No change, no send.
 * @param {boolean} value
 * @param {{send?: boolean, nowMs?: number}} [opts]
 * @returns {boolean} the global state afterwards
 */
export function setGlobalLock(value, opts = {}) {
  if (!globalLockUIEnabled()) return _locked;
  const next = !!value;
  if (next === _locked) return _locked;
  _pending = { value: next, until: nowMs(opts?.nowMs) + PENDING_MS };
  if (opts?.send !== false && typeof window !== "undefined") {
    setCharacterOption(CHARACTER_OPTION_LOCK_UI, next);
  }
  commit(next, "local");
  return _locked;
}

/** The radar lock button / DoLockUI: SetLockUI(!LockUI). */
export function toggleGlobalLock(opts = {}) {
  return setGlobalLock(!_locked, opts);
}

/**
 * Adopt the server's LockUI bit (PlayerDescription options2, or the wasm
 * snapshot after an option write). A read that still disagrees with a
 * local toggle younger than PENDING_MS is ignored.
 * @returns {boolean} the global state afterwards
 */
export function applyServerLockState(on, t) {
  if (!globalLockUIEnabled()) return _locked;
  const v = !!on;
  if (_pending) {
    if (v === _pending.value || nowMs(t) >= _pending.until) _pending = null;
    else return _locked;
  }
  if (v !== _locked) commit(v, "server");
  return _locked;
}

/** Seed from a raw CharacterOptions2 word (bit 0x01000000). */
export function seedGlobalLockFromOptions2(options2, t) {
  return applyServerLockState(lockUiFromOptions2(options2), t);
}

/**
 * Read 0x33 from the live session (`SessionHandle.isCharacterOptionEnabled`)
 * and adopt it. Returns the global state, or null with no session.
 */
export function syncGlobalLockFromSession() {
  if (typeof window === "undefined") return null;
  const on = isCharacterOptionEnabled(CHARACTER_OPTION_LOCK_UI, null);
  if (on === null) return null;
  return applyServerLockState(on);
}

let _syncHooked = false;

/**
 * Hook the page's plugin bus once: every `playerStatsUpdated` re-reads 0x33,
 * so a character saved locked logs in locked. The hook goes through
 * index.html's `window.__pluginClientReady` (resolves at login, and at once
 * after it) — never through a plugin's own client handle, so a plugin's
 * subscribe/unsubscribe bookkeeping never sees this page-lifetime listener.
 * Idempotent; a no-op with `?globalLockUI=off`.
 */
export function ensureGlobalLockSync() {
  if (_syncHooked || !globalLockUIEnabled() || typeof window === "undefined" || !window) {
    return _syncHooked;
  }
  try {
    const ready = window.__pluginClientReady;
    if (typeof ready?.then === "function") {
      _syncHooked = true;
      ready.then((client) => {
        const bus = client?.events;
        if (!bus || typeof bus.on !== "function") { _syncHooked = false; return; }
        bus.on("playerStatsUpdated", () => { syncGlobalLockFromSession(); });
        syncGlobalLockFromSession();
      }, () => { _syncHooked = false; });
    }
  } catch (_) {}
  syncGlobalLockFromSession();
  return _syncHooked;
}

function readPerWindowLocked(windowId) {
  if (typeof windowId !== "number") return false;
  try {
    // Same key ui/ac_window_position.js persists under (hb.window.<id hex>).
    const raw = globalThis.localStorage?.getItem?.(`hb.window.${(windowId >>> 0).toString(16)}`);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    return !!(parsed && typeof parsed === "object" && parsed.locked);
  } catch (_) { return false; }
}

/**
 * Is this window locked? `(obeysGlobalLock && global) || per-window lock`.
 * The per-window flag comes from `opts.perWindowLocked` when given, else
 * from the window's persisted `hb.window.<id>` entry.
 * @param {number} windowId
 * @param {{obeysGlobalLock?: boolean, perWindowLocked?: boolean}} [opts]
 */
export function isWindowLocked(windowId, opts = {}) {
  const own = opts.perWindowLocked !== undefined
    ? !!opts.perWindowLocked
    : readPerWindowLocked(windowId);
  return (!!opts.obeysGlobalLock && globalLockUIEnabled() && _locked) || own;
}

/** Test hook: forget the global state and any pending local toggle. */
export function __resetGlobalLockForTest() {
  _locked = false;
  _pending = null;
}

// `/lockui` (app/slash_commands.js) and console access.
if (typeof window !== "undefined" && window && typeof window === "object") {
  try {
    window.__uiLock = Object.freeze({
      enabled: () => globalLockUIEnabled(),
      isLocked: isGlobalLocked,
      set: (v) => setGlobalLock(v),
      toggle: () => toggleGlobalLock(),
      sync: syncGlobalLockFromSession,
    });
  } catch (_) {}
}
