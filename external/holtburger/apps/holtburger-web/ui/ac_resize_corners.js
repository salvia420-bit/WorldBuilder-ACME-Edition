// 4-corner resize hotspots for floaty windows. Mirrors retail
// gmFloaty*UI corner-resize behaviour: each corner is an 8×8
// transparent square with a directional cursor, pointerdown captures
// the pointer, and pointermove computes new left/top/width/height
// based on which corner is dragged. Min/max clamps come from caller
// options.
//
// onSizeChange debounces to 120 ms so consumers wiring localStorage
// or persistWindowSize don't hammer storage on every move event.
//
// Returns `{ dispose(), getCorners(), setLocked(bool) }`. When locked,
// the corner handles set pointer-events:none + visibility:hidden so
// they neither resize nor display — matches the lock-toggle behaviour
// the floaty frame already implements for drag.
//
// References:
//   - plugins/chat-panel.js:683-711 (bespoke single-corner pattern this
//     module replaces)
//   - ui/ac_window_position.js#persistWindowSize (companion that takes
//     the {width, height} commit from onSizeChange)
//   - ui/ac_window_position.js#onAnyLockChange (lock-state event source)

import { onAnyLockChange } from "./ac_window_position.js";

const CORNER_KEYS = ["tl", "tr", "bl", "br"];

const CORNER_STYLES = {
  tl: {
    css: "top:0;left:0;cursor:nwse-resize;",
    affectsLeft: true,
    affectsTop: true,
    widthSign: -1,
    heightSign: -1,
  },
  tr: {
    css: "top:0;right:0;cursor:nesw-resize;",
    affectsLeft: false,
    affectsTop: true,
    widthSign: 1,
    heightSign: -1,
  },
  bl: {
    css: "bottom:0;left:0;cursor:nesw-resize;",
    affectsLeft: true,
    affectsTop: false,
    widthSign: -1,
    heightSign: 1,
  },
  br: {
    css: "bottom:0;right:0;cursor:nwse-resize;",
    affectsLeft: false,
    affectsTop: false,
    widthSign: 1,
    heightSign: 1,
  },
};

/**
 * Attach 4-corner resize hotspots to a positioned element. The element
 * MUST be position: absolute or fixed (we read getBoundingClientRect
 * and write style.left/top/width/height). Corner divs are inserted
 * as children with z-index:6 so they sit above the panel's interior.
 *
 * @param {HTMLElement} element
 * @param {object} opts
 * @param {number} [opts.windowId] — when provided, the resizer
 *   subscribes to `hb-ui-lock-changed` (via onAnyLockChange) for that
 *   windowId and auto-toggles setLocked. Use the same WINDOW_ID constant
 *   the matching attachWindowPosition call uses so corner-resize and
 *   drag share one lock state.
 * @param {number} [opts.minWidth=120]
 * @param {number} [opts.minHeight=80]
 * @param {number} [opts.maxWidth]
 * @param {number} [opts.maxHeight]
 * @param {number} [opts.size=8]               — handle dimensions (px)
 * @param {(detail: {width:number, height:number}) => void} [opts.onSizeChange]
 *   — debounced 120 ms after the last pointermove.
 * @param {boolean} [opts.initialLocked=false]
 * @returns {{dispose():void, getCorners():Record<string,HTMLDivElement>,
 *            setLocked(locked:boolean):void, isLocked():boolean}}
 */
export function attachCornerResizers(element, opts) {
  if (!element || typeof element !== "object") {
    throw new Error("attachCornerResizers requires an element");
  }
  const minW = opts?.minWidth ?? 120;
  const minH = opts?.minHeight ?? 80;
  const maxW = opts?.maxWidth ?? null;
  const maxH = opts?.maxHeight ?? null;
  const size = opts?.size ?? 8;
  const onSizeChange = typeof opts?.onSizeChange === "function" ? opts.onSizeChange : null;

  // Element must position children we add — if static, fall back to
  // relative so the corner divs stay glued to its bounding box.
  const computed = window.getComputedStyle(element);
  if (computed.position === "static") {
    element.style.position = "relative";
  }

  const corners = {};
  let locked = !!opts?.initialLocked;
  let drag = null;
  let sizeChangeTimer = 0;

  function clamp(value, min, max) {
    let v = value;
    if (min != null) v = Math.max(min, v);
    if (max != null) v = Math.min(max, v);
    return v;
  }

  function scheduleSizeChange(width, height) {
    if (!onSizeChange) return;
    try { clearTimeout(sizeChangeTimer); } catch (_) {}
    sizeChangeTimer = setTimeout(() => {
      sizeChangeTimer = 0;
      try { onSizeChange({ width, height }); } catch (_) {}
    }, 120);
  }

  for (const key of CORNER_KEYS) {
    const spec = CORNER_STYLES[key];
    const div = document.createElement("div");
    div.className = `hb-resize-corner hb-resize-corner-${key}`;
    div.dataset.corner = key;
    div.style.cssText =
      `position:absolute;width:${size}px;height:${size}px;` +
      `pointer-events:auto;z-index:6;background:transparent;${spec.css}`;
    if (locked) {
      div.style.pointerEvents = "none";
      div.style.visibility = "hidden";
    }
    element.appendChild(div);
    corners[key] = div;

    div.addEventListener("pointerdown", (ev) => {
      if (locked) return;
      if (ev.button != null && ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      const rect = element.getBoundingClientRect();
      drag = {
        corner: key,
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
      if (!drag || drag.corner !== key) return;
      const dx = ev.clientX - drag.startX;
      const dy = ev.clientY - drag.startY;
      let newW = drag.w0 + spec.widthSign * dx;
      let newH = drag.h0 + spec.heightSign * dy;
      newW = clamp(newW, minW, maxW);
      newH = clamp(newH, minH, maxH);
      const actualDw = newW - drag.w0;
      const actualDh = newH - drag.h0;
      element.style.width = `${newW}px`;
      element.style.height = `${newH}px`;
      // For left/top-affecting corners, the element origin moves so
      // the OPPOSITE corner stays pinned. We rewrite left/top using
      // the actual (clamped) delta so a clamp at min size doesn't
      // continue to drag the element away from the cursor.
      if (spec.affectsLeft) {
        element.style.left = `${drag.x0 - actualDw * spec.widthSign}px`;
        element.style.right = "auto";
      }
      if (spec.affectsTop) {
        element.style.top = `${drag.y0 - actualDh * spec.heightSign}px`;
        element.style.bottom = "auto";
      }
      scheduleSizeChange(newW, newH);
    });
    function endDrag(ev) {
      if (!drag || drag.corner !== key) return;
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
    for (const key of CORNER_KEYS) {
      const div = corners[key];
      if (!div) continue;
      div.style.pointerEvents = locked ? "none" : "auto";
      div.style.visibility = locked ? "hidden" : "";
    }
  }

  // Auto-sync with attachWindowPosition's lock state when a windowId
  // is supplied. The same hb-ui-lock-changed bus that attachFloatyFrame
  // listens to also drives the resizer here, so flipping the lock
  // button hides the corners + blocks edge-drag in one motion.
  let unsubLockChange = null;
  if (typeof opts?.windowId === "number") {
    try {
      unsubLockChange = onAnyLockChange((detail) => {
        if (!detail) return;
        if ((detail.windowId >>> 0) !== (opts.windowId >>> 0)) return;
        setLocked(!!detail.locked);
      });
    } catch (e) {
      console.warn("[ac-resize-corners] lock-change subscribe failed:", e);
    }
  }

  function dispose() {
    try { clearTimeout(sizeChangeTimer); } catch (_) {}
    if (typeof unsubLockChange === "function") {
      try { unsubLockChange(); } catch (_) {}
      unsubLockChange = null;
    }
    for (const key of CORNER_KEYS) {
      const div = corners[key];
      if (!div) continue;
      try {
        if (div.parentNode === element) element.removeChild(div);
      } catch (_) {}
    }
  }

  return {
    dispose,
    getCorners: () => ({ ...corners }),
    setLocked,
    isLocked: () => locked,
  };
}
