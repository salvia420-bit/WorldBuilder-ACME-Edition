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
//
// HUD rec #81 — Retail property IDs for PlayerModule
// InqChatWindowOption / SetChatWindowOption (from
// acclient_2013.bndb_pseudo_c.txt:212787+):
//   0x10000086 = X position
//   0x10000087 = Y position
//   0x10000088 = width
//   0x10000089 = height
//   0x1000008A = locked
// When ACE exposes these as generic per-window props, swap the
// localStorage path here for the wire round-trip without changing
// callers; the keys above are the canonical mapping.

const STORAGE_PREFIX = "hb.window.";
const LOCK_EVENT = "hb-ui-lock-changed";
// Rec #79 — pixel band within which an absolute-position drag-release
// snaps to the matching viewport edge. Matches the retail floaty
// docking feel: <20 px from an edge dock; outside the band stay free.
const EDGE_SNAP_PX = 20;

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

  // R11: position writes must NOT clobber width/height written under the same
  // key by persistWindowSize (the CHAT window 0x10000600 has dual writers).
  // Read-modify-merge: keep the persisted size, overwrite only x/y/locked.
  function persistPosition() {
    const cur = readPersisted(storageKey) || {};
    writePersisted(storageKey, {
      x: state.x, y: state.y, locked: state.locked,
      width: cur.width ?? null, height: cur.height ?? null,
    });
  }

  let drag = null;
  let saveDebounce = 0;
  function scheduleSave() {
    clearTimeout(saveDebounce);
    saveDebounce = setTimeout(() => { persistPosition(); }, 120);
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
        // Rec #79 — snap to screen edge on release when within
        // EDGE_SNAP_PX. Only when clampToViewport is on so a caller
        // that opted out of clamping doesn't get implicit docking.
        // Docked windows persist via the same scheduleSave + the
        // clampStateToViewport pass on next mount, so a viewport
        // resize re-anchors them to the same edge.
        let nx = parseFloat(element.style.left) || 0;
        let ny = parseFloat(element.style.top) || 0;
        if (clampToViewport) {
          const r = element.getBoundingClientRect();
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          if (nx < EDGE_SNAP_PX) nx = 0;
          else if (nx + r.width > vw - EDGE_SNAP_PX) nx = Math.max(0, vw - r.width);
          if (ny < EDGE_SNAP_PX) ny = 0;
          else if (ny + r.height > vh - EDGE_SNAP_PX) ny = Math.max(0, vh - r.height);
          element.style.left = `${nx}px`;
          element.style.top  = `${ny}px`;
        }
        state.x = nx;
        state.y = ny;
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
      persistPosition();
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
      persistPosition();
      fireLockChanged();
    },
    resetPosition() {
      state.x = null;
      state.y = null;
      persistPosition();
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
      width: typeof parsed.width === "number" ? parsed.width : null,
      height: typeof parsed.height === "number" ? parsed.height : null,
    };
  } catch (_) { return null; }
}

function writePersisted(key, state) {
  try {
    localStorage.setItem(key, JSON.stringify({
      x: state.x,
      y: state.y,
      locked: state.locked,
      width: state.width ?? null,
      height: state.height ?? null,
    }));
  } catch (_) {}
}

/**
 * Persist a window's size (width/height) alongside its position. The
 * shared localStorage entry (`hb.window.<windowId hex>`) is extended
 * in-place — readers that only know about {x,y,locked} silently
 * ignore the new fields, and writers that touch position-only paths
 * preserve them.
 *
 * Callers managing their own resize logic (ac_resize_corners.js,
 * chat-panel.js bespoke handles) invoke this once on mount and feed
 * the resulting `commit(width, height)` from inside their resize-end
 * handler. The optional `observe()` attaches a ResizeObserver that
 * auto-persists on any size change — useful for CSS-resize boxes.
 *
 * `minW/minH/maxW/maxH` are advisory clamps applied before persist.
 * Any may be `null` to skip that bound. Defaults: minW=120, minH=80,
 * no upper bound.
 *
 * @param {HTMLElement} element
 * @param {number} windowId — same uint as attachWindowPosition.
 * @param {object} [opts]
 * @param {number} [opts.minW=120]
 * @param {number} [opts.minH=80]
 * @param {number} [opts.maxW]
 * @param {number} [opts.maxH]
 * @returns {{
 *   getSize: () => {width:number|null, height:number|null},
 *   commit: (w:number|null, h:number|null) => void,
 *   observe: () => () => void,
 *   reset: () => void,
 * }}
 */
export function persistWindowSize(element, windowId, opts) {
  if (!element) throw new Error("persistWindowSize requires an element");
  if (typeof windowId !== "number") {
    throw new Error("persistWindowSize requires windowId (uint)");
  }
  const minW = opts?.minW ?? 120;
  const minH = opts?.minH ?? 80;
  const maxW = opts?.maxW ?? null;
  const maxH = opts?.maxH ?? null;
  const storageKey = STORAGE_PREFIX + (windowId >>> 0).toString(16);

  let size = (() => {
    const persisted = readPersisted(storageKey);
    if (!persisted) return { width: null, height: null };
    return { width: persisted.width, height: persisted.height };
  })();
  applySize(element, size);

  let saveDebounce = 0;
  function persist() {
    clearTimeout(saveDebounce);
    saveDebounce = setTimeout(() => {
      // Merge into the canonical entry so x/y/locked written by
      // attachWindowPosition are not stomped.
      const cur = readPersisted(storageKey) || { x: null, y: null, locked: false };
      cur.width = size.width;
      cur.height = size.height;
      writePersisted(storageKey, cur);
    }, 120);
  }

  function clamp(value, min, max) {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    let v = value;
    if (min != null) v = Math.max(min, v);
    if (max != null) v = Math.min(max, v);
    return v;
  }

  function commit(w, h) {
    size.width = clamp(w, minW, maxW);
    size.height = clamp(h, minH, maxH);
    applySize(element, size);
    persist();
  }

  function observe() {
    if (typeof ResizeObserver === "undefined") return () => {};
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const r = entry.contentRect;
        commit(r.width, r.height);
      }
    });
    ro.observe(element);
    return () => { try { ro.disconnect(); } catch (_) {} };
  }

  function reset() {
    size = { width: null, height: null };
    element.style.removeProperty("width");
    element.style.removeProperty("height");
    const cur = readPersisted(storageKey) || { x: null, y: null, locked: false };
    cur.width = null;
    cur.height = null;
    writePersisted(storageKey, cur);
  }

  return {
    getSize: () => ({ width: size.width, height: size.height }),
    commit,
    observe,
    reset,
  };
}

function applySize(element, size) {
  if (size.width != null) element.style.width = `${size.width}px`;
  if (size.height != null) element.style.height = `${size.height}px`;
}

const EDGE_SPECS = {
  top:    { css: "top:0;left:0;right:0;height:5px;cursor:ns-resize;",  axis: "h", sign: -1, affectsOrigin: true },
  bottom: { css: "bottom:0;left:0;right:0;height:5px;cursor:ns-resize;", axis: "h", sign: 1, affectsOrigin: false },
  left:   { css: "top:0;bottom:0;left:0;width:5px;cursor:ew-resize;",  axis: "w", sign: -1, affectsOrigin: true },
  right:  { css: "top:0;bottom:0;right:0;width:5px;cursor:ew-resize;", axis: "w", sign: 1, affectsOrigin: false },
};

/**
 * Attach 5-px transparent edge-drag handles for resizing a positioned
 * floaty. Complements attachCornerResizers (4-corner version); use the
 * edges when you want a wider hit zone than the 8×8 corner divs (e.g.
 * chat-panel right-edge grab) or when only one axis should resize.
 *
 * Each edge mutates element.style.width / height. Top/left edges also
 * shift element.style.left/top so the OPPOSITE edge stays pinned —
 * same anchoring math attachCornerResizers uses. Min/max clamps stop
 * the drag at the bound; the per-edge actual-delta math prevents the
 * panel from continuing to track the cursor once clamped.
 *
 * `opts.windowId` opts into the shared hb-ui-lock-changed bus so
 * locking the floaty hides every edge handle in one motion. onSizeChange
 * debounces 120 ms after the last pointermove (same cadence as
 * attachCornerResizers + persistWindowSize so handlers compose).
 *
 * @param {HTMLElement} element
 * @param {object} opts
 * @param {Array<"top"|"bottom"|"left"|"right">} opts.edges
 * @param {number} [opts.windowId]
 * @param {number} [opts.minWidth=120]
 * @param {number} [opts.minHeight=80]
 * @param {number} [opts.maxWidth]
 * @param {number} [opts.maxHeight]
 * @param {(detail:{width:number,height:number}) => void} [opts.onSizeChange]
 * @returns {{dispose():void, setLocked(b:boolean):void, isLocked():boolean,
 *            getHandles():Record<string,HTMLDivElement>}}
 */
export function attachEdgeResizers(element, opts) {
  if (!element || typeof element !== "object") {
    throw new Error("attachEdgeResizers requires an element");
  }
  const edges = Array.isArray(opts?.edges) ? opts.edges.slice() : [];
  if (edges.length === 0) {
    throw new Error("attachEdgeResizers requires opts.edges (e.g. ['bottom','right'])");
  }
  const minW = opts?.minWidth ?? 120;
  const minH = opts?.minHeight ?? 80;
  const maxW = opts?.maxWidth ?? null;
  const maxH = opts?.maxHeight ?? null;
  const onSizeChange = typeof opts?.onSizeChange === "function" ? opts.onSizeChange : null;

  const computed = window.getComputedStyle(element);
  if (computed.position === "static") {
    element.style.position = "relative";
  }

  const handles = {};
  let locked = !!opts?.initialLocked;
  let drag = null;
  let sizeChangeTimer = 0;

  function clamp(v, min, max) {
    let r = v;
    if (min != null) r = Math.max(min, r);
    if (max != null) r = Math.min(max, r);
    return r;
  }

  function scheduleSizeChange(width, height) {
    if (!onSizeChange) return;
    try { clearTimeout(sizeChangeTimer); } catch (_) {}
    sizeChangeTimer = setTimeout(() => {
      sizeChangeTimer = 0;
      try { onSizeChange({ width, height }); } catch (_) {}
    }, 120);
  }

  for (const edge of edges) {
    const spec = EDGE_SPECS[edge];
    if (!spec) continue;
    const div = document.createElement("div");
    div.className = `hb-resize-edge hb-resize-edge-${edge}`;
    div.dataset.edge = edge;
    div.style.cssText =
      `position:absolute;background:transparent;pointer-events:auto;z-index:5;${spec.css}`;
    if (locked) {
      div.style.pointerEvents = "none";
      div.style.visibility = "hidden";
    }
    element.appendChild(div);
    handles[edge] = div;

    div.addEventListener("pointerdown", (ev) => {
      if (locked) return;
      if (ev.button != null && ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      const rect = element.getBoundingClientRect();
      drag = {
        edge,
        startX: ev.clientX,
        startY: ev.clientY,
        x0: rect.left,
        y0: rect.top,
        w0: rect.width,
        h0: rect.height,
      };
      try { div.setPointerCapture(ev.pointerId); } catch (_) {}
    });
    div.addEventListener("pointermove", (ev) => {
      if (!drag || drag.edge !== edge) return;
      const dx = ev.clientX - drag.startX;
      const dy = ev.clientY - drag.startY;
      let newW = drag.w0;
      let newH = drag.h0;
      if (spec.axis === "w") newW = drag.w0 + spec.sign * dx;
      else newH = drag.h0 + spec.sign * dy;
      newW = clamp(newW, minW, maxW);
      newH = clamp(newH, minH, maxH);
      const actualDw = newW - drag.w0;
      const actualDh = newH - drag.h0;
      element.style.width = `${newW}px`;
      element.style.height = `${newH}px`;
      if (spec.affectsOrigin) {
        if (spec.axis === "w") {
          element.style.left = `${drag.x0 - actualDw * spec.sign}px`;
          element.style.right = "auto";
        } else {
          element.style.top = `${drag.y0 - actualDh * spec.sign}px`;
          element.style.bottom = "auto";
        }
      }
      scheduleSizeChange(newW, newH);
    });
    function endDrag(ev) {
      if (!drag || drag.edge !== edge) return;
      drag = null;
      try { div.releasePointerCapture(ev.pointerId); } catch (_) {}
    }
    div.addEventListener("pointerup", endDrag);
    div.addEventListener("pointercancel", endDrag);
  }

  function setLocked(next) {
    const want = !!next;
    if (want === locked) return;
    locked = want;
    for (const edge of Object.keys(handles)) {
      const div = handles[edge];
      div.style.pointerEvents = locked ? "none" : "auto";
      div.style.visibility = locked ? "hidden" : "";
    }
  }

  let unsubLock = null;
  if (typeof opts?.windowId === "number") {
    try {
      unsubLock = onAnyLockChange((detail) => {
        if (!detail) return;
        if ((detail.windowId >>> 0) !== (opts.windowId >>> 0)) return;
        setLocked(!!detail.locked);
      });
    } catch (e) {
      console.warn("[ac-window-position] edge lock-change subscribe failed:", e);
    }
  }

  function dispose() {
    try { clearTimeout(sizeChangeTimer); } catch (_) {}
    if (typeof unsubLock === "function") {
      try { unsubLock(); } catch (_) {}
      unsubLock = null;
    }
    for (const edge of Object.keys(handles)) {
      const div = handles[edge];
      try {
        if (div.parentNode === element) element.removeChild(div);
      } catch (_) {}
    }
  }

  return {
    dispose,
    setLocked,
    isLocked: () => locked,
    getHandles: () => ({ ...handles }),
  };
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
