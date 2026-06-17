// Shared FloatyFrame component — retail 8-piece 9-slice border chrome
// with `_Locked` twin sprites.
//
// Every `gmFloaty*UI` class in retail draws its border via 8
// UIElement child pointers (m_pTopBorder, m_pTopLeftCorner, etc.)
// plus an 8-piece `_Locked` set used when the window is locked. See
// acclient.h:54849-55141 for the per-class field layout and
// `Chorizite.NativeClientBootstrapper/AcClient/UIElementId.cs` for
// the `ToolbarTopLeftCorner = 0x1000062B`, `ToolbarTopLeftCorner_Locked
// = 0x10000623` style ID conventions.
//
// IMPORTANT: the `unlocked` / `locked` arrays carry **sprite asset
// DIDs** (`0x06xxxxxx`), not the `0x1000062X` UIElement IDs you see
// in Chorizite's UIElementId.cs. Those Chorizite values index INTO
// the layout's element tree — each chrome UIElement has its own
// StateDesc whose MediaDesc.Image.file holds the actual `0x06xxxxxx`
// sprite DID. Use `resolveFrameSpritesFromLayout(layout, baseId)` to
// extract them after a `fetch_layout()` call (StateDesc emission is
// live as of lib.rs G3-reland 2026-06-05).
//
// Piece order in both arrays:
//   [0] top-left corner
//   [1] top border
//   [2] top-right corner
//   [3] left border
//   [4] bottom-left corner
//   [5] bottom border
//   [6] bottom-right corner
//   [7] right border
// (8 elements total; the 9th cell of the 9-slice is the body fill,
// which each caller handles via its own background.)
//
// Usage:
//   attachFloatyFrame(element, {
//     unlocked: [TL, T, TR, L, BL, B, BR, R],
//     locked:   [TL, T, TR, L, BL, B, BR, R],
//     cornerSize: 8,           // px
//     borderThickness: 6,      // px
//     windowId: 0x100006xx,    // optional — listen for lock changes
//   });
//
// Callers that already use `attachWindowPosition` get automatic
// locked/unlocked swap via the `hb-ui-lock-changed` event. Callers
// that don't (yet) wire window persistence can call
// `frame.setLocked(bool)` directly.

import { fetchIconDataUrl } from "./ac_icon_cache.js";

const PIECE_NAMES = Object.freeze([
  "tl", "t", "tr", "l", "bl", "b", "br", "r",
]);

// Resolve a sprite DID to a CSS background `url(...)` value. Uses the
// shared icon cache so we can load chrome sprites at runtime from the
// DAT (via fetch_icon_pixels) without needing pre-baked PNGs in
// data/ui-sprites/. Returns null if the fetch fails — caller can
// then render a transparent fallback or skip the piece.
async function resolveSpriteCss(did) {
  if (!did) return null;
  const url = await fetchIconDataUrl(did, "floaty-frame");
  if (!url || url === false) return null;
  return `url('${url}')`;
}

/**
 * Render and manage 8-piece chrome on `element`. Pieces are absolutely
 * positioned children prepended to the element; the element should
 * already have `position: relative` (or be positioned by a window
 * adapter) so the children anchor correctly.
 *
 * @param {HTMLElement} element
 * @param {object} options
 * @param {number[]} options.unlocked  — 8 sprite DIDs (TL, T, TR, L, BL, B, BR, R)
 * @param {number[]} options.locked    — 8 sprite DIDs in same order
 * @param {number} [options.cornerSize=8]      — corner piece size in px
 * @param {number} [options.borderThickness=6] — edge piece thickness in px
 * @param {number} [options.windowId]  — if provided, the frame subscribes
 *   to `hb-ui-lock-changed` events for this windowId and swaps sprites
 *   automatically on lock toggle.
 * @returns {object} `{ setLocked(locked: boolean), dispose() }`
 */
export function attachFloatyFrame(element, options) {
  if (!element || !options) {
    throw new Error("attachFloatyFrame requires an element + options");
  }
  const {
    unlocked, locked,
    cornerSize = 8,
    borderThickness = 6,
    windowId,
  } = options;
  if (!Array.isArray(unlocked) || unlocked.length !== 8) {
    throw new Error("attachFloatyFrame: options.unlocked must be 8 sprite DIDs");
  }
  if (!Array.isArray(locked) || locked.length !== 8) {
    throw new Error("attachFloatyFrame: options.locked must be 8 sprite DIDs");
  }

  const computed = window.getComputedStyle(element);
  if (computed.position === "static") {
    element.style.position = "relative";
  }

  const pieces = {};
  for (const name of PIECE_NAMES) {
    const div = document.createElement("div");
    div.className = `hb-floaty-frame-${name}`;
    div.style.position = "absolute";
    div.style.pointerEvents = "none";
    div.style.backgroundRepeat = "no-repeat";
    div.style.backgroundSize = "100% 100%";
    div.style.zIndex = "1";
    pieces[name] = div;
  }

  // Corner placement
  const c = `${cornerSize}px`;
  pieces.tl.style.cssText += `top:0;left:0;width:${c};height:${c};`;
  pieces.tr.style.cssText += `top:0;right:0;width:${c};height:${c};`;
  pieces.bl.style.cssText += `bottom:0;left:0;width:${c};height:${c};`;
  pieces.br.style.cssText += `bottom:0;right:0;width:${c};height:${c};`;
  // Edge placement — stretched between corners
  const t = `${borderThickness}px`;
  pieces.t.style.cssText += `top:0;left:${c};right:${c};height:${t};`;
  pieces.b.style.cssText += `bottom:0;left:${c};right:${c};height:${t};`;
  pieces.l.style.cssText += `top:${c};bottom:${c};left:0;width:${t};`;
  pieces.r.style.cssText += `top:${c};bottom:${c};right:0;width:${t};`;

  // Insert pieces first so they sit BEHIND any existing children
  // (caller's chrome / slots / text).
  for (const name of PIECE_NAMES) {
    element.insertBefore(pieces[name], element.firstChild);
  }

  let isLocked = false;
  async function applySprites(lockedSet) {
    const set = lockedSet ? locked : unlocked;
    const urls = await Promise.all(set.map((did) => resolveSpriteCss(did)));
    for (let i = 0; i < PIECE_NAMES.length; i++) {
      const piece = pieces[PIECE_NAMES[i]];
      if (urls[i]) {
        piece.style.backgroundImage = urls[i];
      } else {
        piece.style.backgroundImage = "none";
      }
    }
  }
  // Fire-and-forget: the frame DOM is in place immediately; the sprite
  // data URLs land asynchronously and paint over.
  void applySprites(false);

  let lockHandler = null;
  if (typeof windowId === "number") {
    lockHandler = (ev) => {
      if (!ev?.detail) return;
      if ((ev.detail.windowId >>> 0) !== (windowId >>> 0)) return;
      isLocked = !!ev.detail.locked;
      void applySprites(isLocked);
    };
    document.addEventListener("hb-ui-lock-changed", lockHandler);
  }

  return {
    setLocked(locked) {
      const next = !!locked;
      if (next === isLocked) return;
      isLocked = next;
      void applySprites(next);
    },
    isLocked() { return isLocked; },
    dispose() {
      if (lockHandler) {
        document.removeEventListener("hb-ui-lock-changed", lockHandler);
        lockHandler = null;
      }
      for (const name of PIECE_NAMES) {
        if (pieces[name].parentNode === element) {
          element.removeChild(pieces[name]);
        }
      }
    },
  };
}

/**
 * UIElement IDs (NOT sprite asset DIDs) for the toolbar/hotbar chrome,
 * verified against Chorizite `UIElementId.cs`. Pass these to
 * `resolveFrameSpritesFromLayout` to extract the actual sprite DIDs
 * for use with `attachFloatyFrame`.
 *
 * Conventional 16-piece slots:
 *   ToolbarTopLeftCorner       = 0x1000062B
 *   ToolbarTopBorder           = 0x1000062C
 *   ToolbarTopRightCorner      = 0x1000062D
 *   ToolbarLeftBorder          = 0x1000062E
 *   ToolbarBottomLeftCorner    = 0x1000062F
 *   ToolbarBottomBorder        = 0x10000630
 *   ToolbarBottomRightCorner   = 0x10000631
 *   ToolbarRightBorder         = 0x10000632
 *   (and the `_Locked` twins at 0x10000623..0x1000062A, in the same
 *    TL/T/TR/L/BL/B/BR/R order)
 */
export const TOOLBAR_FRAME_UI_IDS = Object.freeze({
  unlocked: Object.freeze([
    0x1000062B, 0x1000062C, 0x1000062D, 0x1000062E,
    0x1000062F, 0x10000630, 0x10000631, 0x10000632,
  ]),
  locked: Object.freeze([
    0x10000623, 0x10000624, 0x10000625, 0x10000626,
    0x10000627, 0x10000628, 0x10000629, 0x1000062A,
  ]),
});

/**
 * HUD rec #153 — gmFloatyPanelUI (main-panel, layout 0x2100006E) 8-piece
 * chrome UIElement IDs in the canonical TL/T/TR/L/BL/B/BR/R order, with the
 * `_Locked` twins. Lifted verbatim from main-panel.js's element-id map. Feed
 * into `resolveFrameSpritesFromLayout` + `attachFloatyFrame` to paint the
 * retail sprite frame over the placeholder CSS border-image.
 */
export const MAIN_PANEL_FRAME_UI_IDS = Object.freeze({
  unlocked: Object.freeze([
    0x10000653, 0x10000654, 0x10000655, 0x10000656,
    0x10000657, 0x10000658, 0x10000659, 0x1000065A,
  ]),
  locked: Object.freeze([
    0x1000065B, 0x1000065C, 0x1000065D, 0x1000065E,
    0x1000065F, 0x10000660, 0x10000661, 0x10000662,
  ]),
});

/**
 * Walk a `fetch_layout` result to extract the `0x06xxxxxx` sprite DID
 * for each chrome UIElement. Returns an `{ unlocked, locked }` shape
 * ready to feed into `attachFloatyFrame`. Each element's sprite is
 * pulled from its default-state MediaDesc.Image.file.
 *
 * Returns null if any required UIElement is missing or has no Image
 * media — caller should fall back to a CSS approximation in that case.
 *
 * @param {object} layout     — return value of `fetch_layout(...)` parsed
 *   (so `{ id, elements: [...] }`)
 * @param {{unlocked:number[], locked:number[]}} uiIds — 8 + 8 UIElement IDs
 *   in the canonical TL/T/TR/L/BL/B/BR/R order.
 */
export function resolveFrameSpritesFromLayout(layout, uiIds) {
  if (!layout || !Array.isArray(layout.elements)) return null;
  const byId = new Map();
  walkElements(layout.elements, (el) => {
    if (typeof el.element_id === "number") byId.set(el.element_id >>> 0, el);
  });
  const resolveOne = (uiId) => {
    const el = byId.get(uiId >>> 0);
    if (!el) return null;
    // Prefer default-state media; fall back to any state with Image.
    const defaultState = el.state_desc;
    const fromDefault = mediaImageFile(defaultState);
    if (fromDefault != null) return fromDefault;
    const states = el.states || {};
    for (const k of Object.keys(states)) {
      const f = mediaImageFile(states[k]);
      if (f != null) return f;
    }
    return null;
  };
  const unlocked = uiIds.unlocked.map(resolveOne);
  const locked = uiIds.locked.map(resolveOne);
  if (unlocked.some((v) => v == null) || locked.some((v) => v == null)) {
    return null;
  }
  return { unlocked, locked };
}

function walkElements(elements, visit) {
  for (const el of elements) {
    if (!el) continue;
    visit(el);
    if (Array.isArray(el.children) && el.children.length > 0) {
      walkElements(el.children, visit);
    }
  }
}

function mediaImageFile(stateDesc) {
  if (!stateDesc || !Array.isArray(stateDesc.media)) return null;
  for (const m of stateDesc.media) {
    if (m && typeof m === "object" && m.Image && typeof m.Image.file === "number") {
      return m.Image.file >>> 0;
    }
  }
  return null;
}
