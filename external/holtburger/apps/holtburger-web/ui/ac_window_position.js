// Shared m_eWindowID-keyed localStorage adapter for floaty windows.
//
// Retail's gmFloaty*UI classes each carry an `unsigned int m_eWindowID`
// (acclient.h:54547-55124) and persist their position/lock state via
// PlayerModule::InqChatWindowOption / SetChatWindowOption (acclient.c
// 11209-11210). This module mirrors that contract on the client side:
//
//   • position (`x`, `y`) and `locked` flag stored under
//     `hb.window.<windowId>` in localStorage
//   • drag handle on a caller-supplied element initiates the move
//   • lock toggle fires a `hb-ui-lock-changed` CustomEvent on `document`
//     so any other panel that wants to react to global lock state can
//     subscribe via `onAnyLockChange`
//
// The server round-trip (replace localStorage with a PlayerModule
// equivalent) is a follow-on once ACE exposes the chat-window-option
// columns to non-chat windows; the API surface stays the same.

const STORAGE_PREFIX = "hb.window.";
const LOCK_EVENT = "hb-ui-lock-changed";

/**
 * Attach m_eWindowID-keyed position persistence + drag + lock to a
 * floaty window root element.
 *
 * @param {HTMLElement} element  — the floaty's outer wrapper. `style.left`
 *   and `style.top` are mutated; `style.right` and `style.bottom` are
 *   cleared once the user has moved the window so the saved coords win.
 * @param {object} options
 * @param {number} options.windowId  — uint (retail `m_eWindowID`).
 *   Used as the localStorage key; must be unique per floaty class.
 * @param {HTMLElement} [options.dragHandle]  — element that initiates
 *   drag on pointerdown. Drag is disabled while `locked === true`.
 * @param {HTMLElement} [options.lockButton]  — element that toggles
 *   the lock flag on click.
 * @param {object} [options.defaultPos]  — CSS values applied when no
 *   persisted position exists: `{ left, top, right, bottom }`.
 * @param {(locked: boolean) => void} [options.onLockChange]  — fired
 *   when this window's lock toggles (after persistence + event dispatch).
 * @param {string} [options.ignoreSelector]  — CSS selector; pointerdown
 *   targets matching it (e.g. `button,input,.hb-mp-close`) won't start
 *   a drag. Lets a tab-strip or titlebar double as a drag handle while
 *   still letting embedded buttons receive their own clicks.
 * @param {string} [options.legacyKey]  — pre-consolidation localStorage
 *   key in the old `hb_panel_pos_<id>` `{left, top}` shape. Read once,
 *   migrated to the new key, then deleted.
 * @param {boolean} [options.clampToViewport=true]  — clamp restored
 *   coords to the current viewport so a window-shrink doesn't strand
 *   a panel off-screen.
 * @returns {object} A control surface — `getState`, `isLocked`,
 *   `setLocked`, `resetPosition`.
 */
export function attachWindowPosition(element, options) {
  if (!element || !options) {
    throw new Error("attachWindowPosition requires an element + options");
  }
  const {
    windowId, dragHandle, lockButton, defaultPos, onLockChange,
    ignoreSelector, legacyKey,
    clampToViewport = true,
  } = options;
  if (typeof windowId !== "number") {
    throw new Error("attachWindowPosition requires options.windowId (uint)");
  }
  const storageKey = STORAGE_PREFIX + (windowId >>> 0).toString(16);

  let state = readPersisted(storageKey);
  if (!state && legacyKey) {
    const migrated = readLegacyPanelPos(legacyKey);
    if (migrated) {
      state = { x: migrated.left, y: migrated.top, locked: false };
      writePersisted(storageKey, state);
      try { localStorage.removeItem(legacyKey); } catch (_) {}
    }
  }
  if (!state) state = { x: null, y: null, locked: false };

  if (clampToViewport) clampStateToViewport(state, element);
  applyPosition(element, state, defaultPos);

  let drag = null;
  let saveDebounce = 0;
  function scheduleSave() {
    clearTimeout(saveDebounce);
    saveDebounce = setTimeout(() => { writePersisted(storageKey, state); }, 120);
  }
  if (dragHandle) {
    dragHandle.style.cursor = dragHandle.style.cursor || "move";
    dragHandle.addEventListener("pointerdown", (ev) => {
      if (state.locked) return;
      // Skip drag when the pointerdown lands on an interactive child
      // (button / input / specified selector). Lets the same element
      // serve as both a tabstrip and a drag-handle.
      if (ignoreSelector && ev.target?.closest?.(ignoreSelector)
          && ev.target !== dragHandle) return;
      if (ev.button != null && ev.button !== 0) return;
      ev.preventDefault();
      const rect = element.getBoundingClientRect();
      drag = { ox: ev.clientX - rect.left, oy: ev.clientY - rect.top };
      // Switch to absolute left/top before drag so subsequent moves
      // measure from the unanchored position.
      element.style.left = `${rect.left}px`;
      element.style.top = `${rect.top}px`;
      element.style.right = "auto";
      element.style.bottom = "auto";
      try { dragHandle.setPointerCapture(ev.pointerId); } catch (_) {}
    });
    dragHandle.addEventListener("pointermove", (ev) => {
      if (!drag) return;
      const x = ev.clientX - drag.ox;
      const y = ev.clientY - drag.oy;
      element.style.left = `${x}px`;
      element.style.top = `${y}px`;
    });
    dragHandle.addEventListener("pointerup", (ev) => {
      if (drag) {
        state.x = parseFloat(element.style.left) || 0;
        state.y = parseFloat(element.style.top) || 0;
        scheduleSave();
      }
      drag = null;
      try { dragHandle.releasePointerCapture(ev.pointerId); } catch (_) {}
    });
    dragHandle.addEventListener("pointercancel", () => { drag = null; });
  }

  function fireLockChanged() {
    try {
      document.dispatchEvent(new CustomEvent(LOCK_EVENT, {
        detail: { windowId, locked: state.locked },
      }));
    } catch (_) {}
    if (typeof onLockChange === "function") {
      try { onLockChange(state.locked); } catch (_) {}
    }
  }

  if (lockButton) {
    lockButton.addEventListener("click", () => {
      state.locked = !state.locked;
      writePersisted(storageKey, state);
      fireLockChanged();
    });
  }

  // Initial lock state notification so subscribers (and the caller via
  // onLockChange) can render the right lock sprite/state on mount.
  if (state.locked && typeof onLockChange === "function") {
    try { onLockChange(true); } catch (_) {}
  }

  return {
    getState: () => ({ x: state.x, y: state.y, locked: state.locked }),
    isLocked: () => state.locked,
    setLocked(locked) {
      const next = !!locked;
      if (next === state.locked) return;
      state.locked = next;
      writePersisted(storageKey, state);
      fireLockChanged();
    },
    resetPosition() {
      state.x = null;
      state.y = null;
      writePersisted(storageKey, state);
      applyPosition(element, state, defaultPos);
    },
  };
}

function applyPosition(element, state, defaultPos) {
  if (state.x !== null && state.y !== null) {
    element.style.left = `${state.x}px`;
    element.style.top = `${state.y}px`;
    element.style.right = "auto";
    element.style.bottom = "auto";
    return;
  }
  if (defaultPos) {
    if (defaultPos.left != null) element.style.left = defaultPos.left;
    if (defaultPos.top != null) element.style.top = defaultPos.top;
    if (defaultPos.right != null) element.style.right = defaultPos.right;
    if (defaultPos.bottom != null) element.style.bottom = defaultPos.bottom;
  }
}

function readLegacyPanelPos(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.left === "number" && typeof parsed.top === "number") {
      return { left: parsed.left, top: parsed.top };
    }
    return null;
  } catch (_) { return null; }
}

function clampStateToViewport(state, element) {
  if (state.x == null || state.y == null) return;
  const r = element.getBoundingClientRect();
  const w = r.width || 300;
  const h = r.height || 200;
  const maxLeft = Math.max(0, window.innerWidth - w);
  const maxTop = Math.max(0, window.innerHeight - h);
  state.x = Math.max(0, Math.min(state.x, maxLeft));
  state.y = Math.max(0, Math.min(state.y, maxTop));
}

function readPersisted(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return {
      x: typeof parsed.x === "number" ? parsed.x : null,
      y: typeof parsed.y === "number" ? parsed.y : null,
      locked: !!parsed.locked,
    };
  } catch (_) { return null; }
}

function writePersisted(key, state) {
  try {
    localStorage.setItem(key, JSON.stringify({
      x: state.x, y: state.y, locked: state.locked,
    }));
  } catch (_) {}
}

/**
 * Subscribe to lock-state changes from any window. Returns an
 * unsubscribe function.
 *
 * @param {(detail: {windowId: number, locked: boolean}) => void} callback
 */
export function onAnyLockChange(callback) {
  const handler = (ev) => {
    try { callback(ev.detail); } catch (_) {}
  };
  document.addEventListener(LOCK_EVENT, handler);
  return () => document.removeEventListener(LOCK_EVENT, handler);
}

const DEFAULT_DRAG_STYLE_ID = "hb-window-drag-handle-style";

function ensureDefaultDragStyles() {
  if (document.getElementById(DEFAULT_DRAG_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = DEFAULT_DRAG_STYLE_ID;
  style.textContent = `
    .hb-window-drag-handle {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 6px;
      cursor: move;
      z-index: 100;
      pointer-events: auto;
      background: transparent;
    }
  `;
  document.head.appendChild(style);
}

/**
 * Convenience wrapper for the common case: a floaty window with no
 * native drag handle gets a thin (6px) transparent strip along the
 * top edge that can be grabbed to move the window. Persistence + the
 * lock-changed event work the same as `attachWindowPosition`.
 *
 * @param {HTMLElement} overlay     — the floaty root element.
 * @param {number} windowId         — uint `m_eWindowID` (see WINDOW_ID).
 * @param {object} [options]
 * @param {object} [options.defaultPos]  — passed through to attachWindowPosition.
 * @returns {object} the attachWindowPosition control surface.
 */
export function attachDefaultTopDragHandle(overlay, windowId, options = {}) {
  ensureDefaultDragStyles();
  let handle = overlay.querySelector(":scope > .hb-window-drag-handle");
  if (!handle) {
    handle = document.createElement("div");
    handle.className = "hb-window-drag-handle";
    overlay.appendChild(handle);
  }
  return attachWindowPosition(overlay, {
    windowId,
    dragHandle: handle,
    ...options,
  });
}

/**
 * Known window IDs in our codebase. Retail's m_eWindowID values for
 * the gmFloaty*UI classes aren't fully documented, so we use each
 * panel's layout root element_id as a stable surrogate — it's already
 * unique across panels and tracked in the DAT.
 *
 * NOTE: keep this in sync with `RADAR_ELEMS.root` (etc.) on the
 * plugin side. A finding/refactor would centralize these, but for now
 * each plugin owns its element_id constants.
 */
export const WINDOW_ID = Object.freeze({
  RADAR:             0x100006D3, // gmRadarUI root
  HOTBAR:            0x10000602, // gmFloatyToolbarUI root (verified)
  VITALS:            0x100005F9, // gmFloatyVitalsUI root (verified)
  CHAT:              0x10000600, // gmFloatyMainChatUI root (verified)
  STATUS_INDICATORS: 0x10000610, // gmFloatyIndicatorsUI root (verified)
  COMBAT_HUD:        0x1000004B, // gmCombatUI root (verified)
  MAIN_PANEL:        0x100005FE, // gmFloatyPanelUI root (verified)
  // gmFloatyExaminationUI 0x2100006B; root element_id is the 310×400
  // popup at (20, 20) confirmed by examine_target_layout_dump 2026-05-24.
  EXAMINE:           0x100005F2, // gmFloatyExaminationUI root (verified)
  // gmEffectsUI's m_eWindowID isn't extracted from a layout yet — use a
  // synthetic high-bit u32 (0xFFFF0001) so localStorage keys don't
  // collide with real layout DIDs. Swap to the real value once
  // gmEffectsUI's layout is parsed.
  BUFFS:             0xFFFF0001, // gmEffectsUI (synthetic — TODO swap)
});
