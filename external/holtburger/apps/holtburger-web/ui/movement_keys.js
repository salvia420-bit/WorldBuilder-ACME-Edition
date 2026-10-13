// ui/movement_keys.js — app-loop-2 (2026-10-13): the movement keys (and the
// two gameplay toggles that sit beside them) by PHYSICAL key, not by the
// character the active keyboard layout types.
//
// THE BUG: index.html's gameplay keystate + CommandInterpreter edge
// forwarder, camera.js's keystate mirror and picking.js's charge abort all
// resolved W/A/S/D/Q/E from `ev.key.toLowerCase()`. `ev.key` is the
// character the layout produces: AZERTY scrambled the cluster (physical W
// types 'z' and did nothing), Cyrillic / Greek / Hebrew layouts type
// non-Latin letters and could not move at all, and an Alt+Shift layout
// switch while W was held reported a different `ev.key` on the release, so
// the interpreter never got the release edge (stuck run). The combat toggle
// (`ev.key === "`"`) was a dead key on AZERTY and German layouts. The input
// funnel's held-key ledger and every rebindable action (keymap.js
// matchesBinding) already key on `ev.code`.
//
// RETAIL: CInputManager_WIN32::AddDevice sets the keyboard's data format to
// c_dfDIKeyboard (acclient.c, DirectInput scan codes), so every retail
// binding is a physical key position.
//
// The WASD/QE layout itself is unchanged (a deliberate modernization, survey
// A14 §8 — keymap.js RETAIL_ACTION_FIXED_KEYS). An event with an empty
// `code` (the virtual keypad's and the harness's synthetic
// `new KeyboardEvent(type, { key })`) still resolves from `ev.key`.
//
// FLAG: `?movementKeysByCode=off` (DEFAULT-ON) restores the `ev.key`
// resolution at every site.
//
// No imports, no DOM access at import time — unit-testable under plain node.

/** Read `?movementKeysByCode` (DEFAULT-ON — `off`/`0`/`false` disable). Never throws. */
export function readMovementKeysByCodeFlag(search) {
  try {
    const s =
      typeof search === "string"
        ? search
        : typeof window !== "undefined" && window.location
        ? window.location.search
        : "";
    const v = new URLSearchParams(s).get("movementKeysByCode");
    if (v == null) return true;
    const lc = v.toLowerCase();
    return !(lc === "off" || lc === "0" || lc === "false");
  } catch (_) {
    return true;
  }
}

let _byCode = null;
/** Cached flag accessor (parse once per page load). */
export function movementKeysByCodeOn() {
  if (_byCode === null) _byCode = readMovementKeysByCodeFlag();
  return _byCode;
}
/** Test seam. */
export function _resetMovementKeysByCodeForTest() {
  _byCode = null;
}

/**
 * KeyboardEvent.code → the logical movement key (the index.html
 * CMD_INTERP_ACTIONS / keyState names and camera.js `keys` names).
 * @type {ReadonlyMap<string, string>}
 */
export const MOVEMENT_KEY_CODES = new Map([
  ["KeyW", "w"],
  ["KeyS", "s"],
  ["KeyA", "a"],
  ["KeyD", "d"],
  ["KeyQ", "q"],
  ["KeyE", "e"],
]);
const MOVEMENT_KEYS = new Set(MOVEMENT_KEY_CODES.values());

const lowerKey = (ev) => (typeof ev.key === "string" ? ev.key.toLowerCase() : "");

/**
 * The movement key ('w' | 'a' | 's' | 'd' | 'q' | 'e') this keyboard event
 * is, or null. Space and Shift are NOT movement keys here — their `ev.key`
 * (" " / "Shift") is layout-invariant and the callers test it directly.
 * @param {KeyboardEvent|{key?: string, code?: string}} ev
 * @param {boolean} [byCode] defaults to `?movementKeysByCode`
 * @returns {string|null}
 */
export function movementKeyOf(ev, byCode = movementKeysByCodeOn()) {
  if (!ev || typeof ev !== "object") return null;
  if (byCode && ev.code) return MOVEMENT_KEY_CODES.get(ev.code) ?? null;
  const k = lowerKey(ev);
  return MOVEMENT_KEYS.has(k) ? k : null;
}

/**
 * The combat-mode toggle key (keymap.js RETAIL_ACTION_FIXED_KEYS 0x1000005A,
 * "Backquote" = retail DIK_GRAVE). Shift+Backquote is not it — the legacy
 * `ev.key === "`"` test never matched it on US QWERTY ('~').
 * @param {KeyboardEvent|{key?: string, code?: string, shiftKey?: boolean}} ev
 * @param {boolean} [byCode] defaults to `?movementKeysByCode`
 * @returns {boolean}
 */
export function isCombatToggleKey(ev, byCode = movementKeysByCodeOn()) {
  if (!ev || typeof ev !== "object") return false;
  if (byCode && ev.code) return ev.code === "Backquote" && !ev.shiftKey;
  return ev.key === "`";
}

/**
 * camera.js's camera-mode cycle key (C — kept free of every rebindable
 * default, keymap.js "C stays reserved").
 * @param {KeyboardEvent|{key?: string, code?: string}} ev
 * @param {boolean} [byCode] defaults to `?movementKeysByCode`
 * @returns {boolean}
 */
export function isCameraModeKey(ev, byCode = movementKeysByCodeOn()) {
  if (!ev || typeof ev !== "object") return false;
  if (byCode && ev.code) return ev.code === "KeyC";
  return lowerKey(ev) === "c";
}
