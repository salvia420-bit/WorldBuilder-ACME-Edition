// ui/hud_focus.js — input-options-1 (2026-10-13): mouse-clicked HUD controls
// must not keep the keyboard.
//
// THE BUG: hotbar slots, the toolbar's selected-object field, the radar lock,
// the clickable status indicators and the emote-palette rows are role=button
// divs with tabIndex 0 and their own Enter/Space keydown handler. A mouse
// click leaves them focused. ui/input-funnel.js is a document CAPTURE
// listener: Space runs the jump and preventDefaults, but the event still
// reaches the focused widget (target phase), which acted on it again. So
// after clicking a potion, every jump drank another one; after clicking the
// target name, every jump examined; Enter fired the slot instead of opening
// chat (chat-panel's document listener skips a defaultPrevented Enter).
//
// RETAIL: panels never take keyboard focus. Every key goes through
// CInputManager → ACCmdInterp::OnAction (acclient.c:435951) and the action
// maps; a UI click never moves the keyboard anywhere.
//
// THE FIX, two halves, applied by each widget:
//   * `hudKeyActivates(ev)` — the widget's keydown acts only on a fresh
//     Enter/Space nobody has consumed. The funnel preventDefaults the jump
//     and every matched action in the capture phase, so a gameplay key can
//     never reach the widget a second time.
//   * `releaseMouseFocus(el)` — a pointer click (`detail > 0`), the end of a
//     native drag, or a press released somewhere else blurs the widget, so
//     the next Enter opens chat. Keyboard activation goes through keydown
//     (or a synthetic `el.click()`, whose `detail` is 0), so a control the
//     player TABBED to keeps its focus.
// `:focus-visible` is deliberately NOT the test: Chromium starts matching it
// on a mouse-focused element as soon as any non-modifier key is pressed, so
// it cannot tell a click from a Tab inside a keydown handler.
//
// No imports, no DOM access at import time — unit-testable under plain node.

/**
 * True when this keydown should activate a focused HUD control: Enter or
 * Space, not OS autorepeat, and not already consumed (`defaultPrevented`) by
 * the gameplay funnel or anyone else ahead of the widget.
 * @param {KeyboardEvent} ev
 * @returns {boolean}
 */
export function hudKeyActivates(ev) {
  if (!ev || typeof ev !== "object") return false;
  if (ev.key !== "Enter" && ev.key !== " ") return false;
  if (ev.defaultPrevented) return false;
  if (ev.repeat) return false;
  return true;
}

// ── Global actions yield to a focused HUD control (review I-ui-input-R2) ──
//
// The funnel's document-capture listener runs BEFORE the focused control's
// own keydown (target phase) and before panels that register their capture
// listener later (the radial menu). A global action bound to a key the
// control also handles therefore ran first and fired too: Backspace on the
// tinker 'Use' slot also ran Select Closest Compass Item; Home in the
// Options tab strip / Spell Research list also ran Select Last Attacker;
// radial-menu type-ahead (P N , . - =) also cycled the selection behind it.
// An action whose `when` calls `hudOwnsKey(ev)` stands down for those keys:
// the funnel then leaves the key unclaimed and the control gets it.

/** Keys a focused HUD control handles itself: activation (Enter / Space),
 *  list and tab navigation, slot clearing (Backspace / Delete), close.
 *  Printable keys are NOT here — no focused control types into the HUD
 *  (text entry is the funnel's own deferral); the radial menu's type-ahead
 *  is covered by its open state instead. */
const HUD_CONTROL_KEYS = new Set([
  "Enter", " ", "Home", "End", "PageUp", "PageDown",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Backspace", "Delete", "Escape",
]);

/** Explicit ARIA widget roles: a control with one handles its own keys. */
const HUD_WIDGET_ROLES = new Set([
  "button", "tab", "tablist", "listbox", "option", "menu", "menubar",
  "menuitem", "menuitemcheckbox", "menuitemradio", "grid", "gridcell",
  "tree", "treeitem", "treegrid", "slider", "spinbutton", "radio",
  "radiogroup", "switch", "combobox",
]);

function isHudControl(el, doc) {
  if (!el || typeof el !== "object" || typeof el.getAttribute !== "function") return false;
  if (doc && (el === doc.body || el === doc.documentElement)) return false;
  // Detached (panel torn down mid-focus) — it can never get the key.
  if (el.isConnected === false) return false;
  // Opted into keyboard focus: an explicit tabindex (role=button divs, list
  // overlays, window roots) or an explicit widget role (role=tab buttons).
  // A native <button> merely left focused by a mouse click has neither.
  if (el.getAttribute("tabindex") != null) return true;
  const role = String(el.getAttribute("role") || "").trim().toLowerCase();
  return HUD_WIDGET_ROLES.has(role);
}

/** True while the right-click context ("radial") menu is open — it owns the
 *  keyboard (arrows, Home/End, Enter, type-ahead) through its own capture
 *  listener, registered after the funnel's (plugins/radial-menu.js). */
export function radialMenuOpen(win = globalThis.window) {
  try {
    return win?.__radialMenuOpen === true;
  } catch (_) {
    return false;
  }
}

/**
 * True when a focused HUD control or the open radial menu owns this keydown,
 * so a global gameplay action bound to the same key must stand down.
 * @param {KeyboardEvent} [ev]
 * @param {{doc?: Document, win?: object}} [opts]  test seams
 * @returns {boolean}
 */
export function hudOwnsKey(ev, opts = {}) {
  if (radialMenuOpen(opts.win ?? globalThis.window)) return true;
  if (!ev || typeof ev !== "object" || !HUD_CONTROL_KEYS.has(ev.key)) return false;
  try {
    const doc = opts.doc ?? (typeof document !== "undefined" ? document : null);
    if (isHudControl(ev.target, doc)) return true;
    return !!doc && isHudControl(doc.activeElement, doc);
  } catch (_) {
    return false;
  }
}

function docOf(el) {
  try {
    if (el && el.ownerDocument) return el.ownerDocument;
  } catch (_) {}
  return typeof document !== "undefined" ? document : null;
}

function blurIfFocused(el) {
  try {
    const doc = docOf(el);
    if (doc && doc.activeElement !== el) return;
    if (typeof el.blur === "function") el.blur();
  } catch (_) {
    // Focus housekeeping must never break the control's own click.
  }
}

/**
 * Keep a mouse click from parking keyboard focus on `el`.
 *
 *   click (detail > 0)  → blur after the click (a keyboard / synthetic
 *                         `el.click()` has detail 0 and keeps focus)
 *   dragend / pointercancel → blur (a drag source never sees its click)
 *   pointerdown released OUTSIDE `el` → blur (no click will follow)
 *   right / middle press released anywhere → blur (no click for button ≠ 0)
 *
 * Register it AFTER the control's own click handler so the action runs first.
 * @param {HTMLElement} el
 * @returns {() => void} dispose
 */
export function releaseMouseFocus(el) {
  if (!el || typeof el.addEventListener !== "function") return () => {};
  let armed = false;
  let armedDoc = null;
  const disarm = () => {
    if (!armed) return;
    armed = false;
    try { armedDoc?.removeEventListener?.("pointerup", onDocUp, true); } catch (_) {}
    armedDoc = null;
  };
  const onDocUp = (ev) => {
    disarm();
    // A PRIMARY release over the control: its own click follows and blurs it.
    // A right / middle release gets no `click` (only auxclick / contextmenu),
    // and Chromium/Firefox focus a tabIndex control on ANY mousedown button —
    // so a non-primary release blurs here or the slot keeps Enter (chat).
    // Touch/pen report button 0; a missing button (synthetic) counts as 0.
    const button = ev && typeof ev.button === "number" ? ev.button : 0;
    const t = ev?.target;
    try {
      if (button === 0 && t && typeof el.contains === "function" && el.contains(t)) return;
    } catch (_) {}
    blurIfFocused(el);
  };
  const onDown = () => {
    if (armed) return;
    const doc = docOf(el);
    if (!doc || typeof doc.addEventListener !== "function") return;
    armed = true;
    armedDoc = doc;
    doc.addEventListener("pointerup", onDocUp, true);
  };
  const onClick = (ev) => {
    disarm();
    if (ev && ev.detail > 0) blurIfFocused(el);
  };
  const onEnd = () => {
    disarm();
    blurIfFocused(el);
  };
  el.addEventListener("pointerdown", onDown);
  el.addEventListener("click", onClick);
  el.addEventListener("dragend", onEnd);
  el.addEventListener("pointercancel", onEnd);
  return () => {
    disarm();
    try {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("click", onClick);
      el.removeEventListener("dragend", onEnd);
      el.removeEventListener("pointercancel", onEnd);
    } catch (_) {}
  };
}
