// EX-03 — standalone gmFloatyExaminationUI 0x2100006B floaty.
//
// Promotes the examine UI from a main-panel view (300×337 inside the
// shared right-side pane) to a retail-faithful 310×400 floating window
// with its own FloatyFrame chrome, drag/lock window-position adapter,
// title bar with 14×14 close button at (284, 8), and ESC-to-close.
//
// Owns the OUTER chrome only. The body content (header, paperdoll,
// stats, inscription, bus subscriptions) is built by `mountExamineBody`
// from `./examine-target.js` — the same builder the main-panel view
// uses. That keeps every render-side detail in one place; the floaty
// just provides a different parent.
//
// Element-id map (gmFloatyExaminationUI 0x2100006B), verified by
// examine_target_layout_dump 2026-05-24:
//   0x100005F2 — popup root (310×400 at 20,20 inside 800×600 canvas)
//   0x10000673..0x1000067A — 8 frame pieces (TL T TR L BL B BR R)
//   0x1000067B..0x10000682 — 8 _Locked frame pieces (same order)
//   0x1000012D — title backdrop (300×20 at 5,5)
//   0x10000528 — title separator (300×5 at 5,25)
//   0x100005F3 — close button (14×14 at 284,8, 2 states)
//
// HUD overhaul 2026-10-05 — retail floaty chrome: the title band is the
// dark field 0x06004CC2 (DisplayedNameText) with the examined thing's
// name centred in gold, the 14×14 X button 0x06006215 (hover 0x06006216),
// the 0x0600612A separator under it; the window shrinks to fit short /
// zoomed viewports (max-height in HUD vh, body scrolls) and opens
// centred instead of at a fixed 80 px that ran off a 720-px screen at
// HUD scale ≥ 1.5. Esc closes it unless a menu / dialog consumed Esc
// first (they stop propagation in the capture phase).
//
// Opt-out: `?examineFloaty=0` reverts to the legacy main-panel view
// (window.__mainPanel.pushView("examine", ctx)). On by default so
// retail behavior is the path of least surprise.

import {
  loadLayout, findElementById, getCachedLayout,
} from "../ui/ac_layout.js";
import {
  attachWindowPosition, WINDOW_ID,
} from "../ui/ac_window_position.js";
import {
  attachFloatyFrame, resolveFrameSpritesFromLayout,
} from "../ui/ac_floaty_frame.js";
import { mountExamineBody, examineTitleFor } from "./examine-target.js";

const OVERLAY_ID = "hb-examine-floaty";
const STYLE_ID   = "hb-examine-floaty-style";

const EXAMINE_LAYOUT_ID = 0x2100006B;
const EXAMINE_POPUP_ROOT = 0x100005F2;
const EXAMINE_CLOSE_BTN  = 0x100005F3; // 14×14 at (284, 8)
const EXAMINE_TITLE_BAND = 0x1000012D; // 300×20 at (5, 5)

// 16 frame elements per the layout dump (8 unlocked, then 8 locked,
// each in TL/T/TR/L/BL/B/BR/R order).
const EXAMINE_FRAME_UI_IDS = Object.freeze({
  unlocked: Object.freeze([
    0x10000673, 0x10000674, 0x10000675, 0x10000676,
    0x10000677, 0x10000678, 0x10000679, 0x1000067A,
  ]),
  locked: Object.freeze([
    0x1000067B, 0x1000067C, 0x1000067D, 0x1000067E,
    0x1000067F, 0x10000680, 0x10000681, 0x10000682,
  ]),
});

const FLOATY_WIDTH  = 310;
const FLOATY_HEIGHT = 400;

let styleInjected = false;
function ensureStyles() {
  if (styleInjected) return;
  styleInjected = true;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    #${OVERLAY_ID} {
      position: fixed;
      top: 80px;
      left: calc(50% - ${FLOATY_WIDTH / 2}px);
      z-index: 60;
      width: ${FLOATY_WIDTH}px;
      height: ${FLOATY_HEIGHT}px;
      max-height: calc(100 * var(--hb-hud-vh, 1vh) - 16px);
      box-sizing: border-box;
      pointer-events: auto;
      font-family: var(--hbk-font);
      background: url("./data/ui-sprites/0x0600128A.png") 0 0 / 220px 77px repeat, #1d1912;
      color: var(--hbk-text);
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.7);
      display: none;
    }
    #${OVERLAY_ID}[data-open="1"] { display: block; }
    /* Pre-FloatyFrame fallback chrome — visible during the brief window
       between mount and resolveFrameSpritesFromLayout completing. The
       8-piece sprite chrome paints over this once loaded. */
    #${OVERLAY_ID}:not(.hb-floaty-framed) {
      border: 5px solid transparent;
      border-image: url("./sprites/acsprites/panel.png") 5 / 5px / 0 stretch;
    }
    /* Title band — retail 0x1000012D DisplayedNameText (300×20 at 5,5)
       on the dark field 0x06004CC2. Also the drag handle. */
    #${OVERLAY_ID} .hb-exa-floaty-title {
      position: absolute;
      top: 5px;
      left: 5px;
      width: 300px;
      height: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0 22px;
      box-sizing: border-box;
      background: url("./data/ui-sprites/0x06004CC2.png") repeat, #0b0c10;
      color: var(--hbk-gold-bright);
      font-size: 12px;
      letter-spacing: 0.03em;
      text-shadow: 0 1px 0 #000;
      cursor: move;
      user-select: none;
      z-index: 2;
    }
    #${OVERLAY_ID} .hb-exa-floaty-title-name {
      flex: 0 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    /* Close button — retail 0x100005F3 (14×14 at 284,8), sprite 0x06006215. */
    #${OVERLAY_ID} .hb-exa-floaty-close {
      position: absolute;
      top: 8px;
      left: 284px;
      width: 14px;
      height: 14px;
      padding: 0;
      border: 0;
      background: url("./data/ui-sprites/0x06006215.png") center / 100% 100% no-repeat;
      cursor: pointer;
      image-rendering: pixelated;
      z-index: 3;
    }
    #${OVERLAY_ID} .hb-exa-floaty-close:hover,
    #${OVERLAY_ID} .hb-exa-floaty-close:focus-visible { background-image: url("./data/ui-sprites/0x06006216.png"); }
    #${OVERLAY_ID} .hb-exa-floaty-close:active { filter: brightness(0.8); }
    /* Title separator — retail 0x10000528 TopSeperator (300×5 at 5,25),
       sprite 0x0600612A tiled. */
    #${OVERLAY_ID} .hb-exa-floaty-title-sep {
      position: absolute;
      top: 25px;
      left: 5px;
      width: 300px;
      height: 5px;
      background: url("./data/ui-sprites/0x0600612A.png") 0 0 / 10px 5px repeat-x;
      z-index: 2;
      pointer-events: none;
    }
    /* Body slot — below the separator; mountExamineBody fills it with
       its .hb-exa-root (flex column with its own scroll area), so the
       window can shrink without clipping content. */
    #${OVERLAY_ID} .hb-exa-floaty-body {
      position: absolute;
      top: 30px;
      left: 5px;
      right: 5px;
      bottom: 5px;
      overflow: hidden;
      box-sizing: border-box;
    }
  `;
  document.head.appendChild(style);
}

// Resolve frame chrome sprites + close-button sprite. Falls back
// silently if any piece is missing; the CSS border-image is still
// painted underneath.
function applyExamineFloatyLayout(overlay, refs) {
  const apply = (layout) => {
    if (!layout) return;
    const popup = findElementById(layout, EXAMINE_POPUP_ROOT);
    if (!popup) return;

    // Title band — retail 0x1000012D (popup-relative 5,5 → root-relative
    // 5,5 because our overlay is the popup root).
    const titleDesc = findElementById(popup, EXAMINE_TITLE_BAND)
      || findElementById(layout, EXAMINE_TITLE_BAND);
    if (titleDesc && refs.titleEl) {
      if (typeof titleDesc.x === "number") refs.titleEl.style.left = `${titleDesc.x}px`;
      if (typeof titleDesc.y === "number") refs.titleEl.style.top = `${titleDesc.y}px`;
      if (typeof titleDesc.width === "number") refs.titleEl.style.width = `${titleDesc.width}px`;
      if (typeof titleDesc.height === "number") refs.titleEl.style.height = `${titleDesc.height}px`;
    }

    // Close button — retail 0x100005F3 (popup-relative 284,8 → 14×14).
    const closeDesc = findElementById(popup, EXAMINE_CLOSE_BTN)
      || findElementById(layout, EXAMINE_CLOSE_BTN);
    if (closeDesc && refs.closeBtn) {
      if (typeof closeDesc.x === "number") refs.closeBtn.style.left = `${closeDesc.x}px`;
      if (typeof closeDesc.y === "number") refs.closeBtn.style.top = `${closeDesc.y}px`;
      if (typeof closeDesc.width === "number") refs.closeBtn.style.width = `${closeDesc.width}px`;
      if (typeof closeDesc.height === "number") refs.closeBtn.style.height = `${closeDesc.height}px`;
    }

    // FloatyFrame chrome — 8-piece sprite swap. Skips silently when
    // sprites aren't extractable from this layout build.
    if (!overlay.classList.contains("hb-floaty-framed")) {
      const sprites = resolveFrameSpritesFromLayout(layout, EXAMINE_FRAME_UI_IDS);
      if (sprites) {
        attachFloatyFrame(overlay, {
          unlocked: sprites.unlocked,
          locked: sprites.locked,
          cornerSize: 5,
          borderThickness: 5,
          windowId: WINDOW_ID.EXAMINE,
        });
        overlay.classList.add("hb-floaty-framed");
      }
    }

    try {
      window.__diag?.layout?.onExamineFloatyApplied?.({
        framed: overlay.classList.contains("hb-floaty-framed"),
      });
    } catch (_) {}
  };
  const cached = getCachedLayout(EXAMINE_LAYOUT_ID);
  if (cached) { apply(cached); return; }
  loadLayout(EXAMINE_LAYOUT_ID).then(apply).catch(() => {});
}

// Floaty state — single instance, swap-on-open (closing first if open).
const state = {
  overlay: null,
  titleNameEl: null,
  closeBtn: null,
  bodyEl: null,
  cleanup: null,
  escHandler: null,
};

function buildOverlay() {
  ensureStyles();
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.dataset.open = "0";

  const titleEl = document.createElement("div");
  titleEl.className = "hb-exa-floaty-title";
  const titleName = document.createElement("div");
  titleName.className = "hb-exa-floaty-title-name";
  titleEl.appendChild(titleName);
  overlay.appendChild(titleEl);

  const titleSep = document.createElement("div");
  titleSep.className = "hb-exa-floaty-title-sep";
  overlay.appendChild(titleSep);

  const closeBtn = document.createElement("button");
  closeBtn.className = "hb-exa-floaty-close";
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.title = "Close";
  overlay.appendChild(closeBtn);

  const bodyEl = document.createElement("div");
  bodyEl.className = "hb-exa-floaty-body";
  overlay.appendChild(bodyEl);

  document.body.appendChild(overlay);

  attachWindowPosition(overlay, {
    windowId: WINDOW_ID.EXAMINE,
    dragHandle: titleEl,
    ignoreSelector: ".hb-exa-floaty-close,button,input,select,textarea,[data-drag-ignore]",
    defaultPos: {
      left: `calc(50% - ${FLOATY_WIDTH / 2}px)`,
      top: `max(8px, calc(50% - ${FLOATY_HEIGHT / 2}px))`,
    },
  });

  state.overlay = overlay;
  state.titleNameEl = titleName;
  state.closeBtn = closeBtn;
  state.bodyEl = bodyEl;

  closeBtn.addEventListener("click", () => closeFloaty());

  applyExamineFloatyLayout(overlay, { titleEl, closeBtn });

  return { overlay, titleName, closeBtn, bodyEl };
}

function runCleanup() {
  if (state.cleanup) {
    try { state.cleanup(); } catch (e) {
      console.error("[examine-floaty] body cleanup error", e);
    }
    state.cleanup = null;
  }
  if (state.bodyEl) state.bodyEl.innerHTML = "";
  if (state.escHandler) {
    document.removeEventListener("keydown", state.escHandler);
    state.escHandler = null;
  }
}

export function openFloaty(ctx = {}) {
  // R9: if a main-panel examine view is up, close it first so we don't show
  // the same appraisal twice. Guard on the "examine" id ONLY — never collapse
  // inventory/options/map, which share the main pane.
  if (window.__mainPanel?.currentViewId?.() === "examine") {
    window.__mainPanel.closeView?.();
  }
  if (!state.overlay) buildOverlay();
  runCleanup();
  const setTitle = (text) => {
    if (!state.titleNameEl) return;
    state.titleNameEl.textContent = text || "Examine";
    state.titleNameEl.title = text || "";
  };
  setTitle(examineTitleFor(ctx));
  try {
    state.cleanup = mountExamineBody(state.bodyEl, ctx, { setTitle }) || null;
  } catch (e) {
    console.error("[examine-floaty] body mount error", e);
  }
  state.overlay.dataset.open = "1";
  // ESC closes the floaty.
  state.escHandler = (ev) => {
    if (ev.key === "Escape") {
      ev.stopPropagation();
      closeFloaty();
    }
  };
  document.addEventListener("keydown", state.escHandler);
  try {
    window.__diag?.examine?.onFloatyOpen?.({ ctx });
  } catch (_) {}
}

export function closeFloaty() {
  runCleanup();
  if (state.overlay) state.overlay.dataset.open = "0";
  try {
    window.__diag?.examine?.onFloatyClose?.();
  } catch (_) {}
}

export function isOpen() {
  return state.overlay?.dataset.open === "1";
}

export const manifest = {
  id: "examine-floaty",
  name: "Examine Floaty",
  icon: "🔎",
  iconHidden: true,
  version: "0.2.0",
  description: "gmFloatyExaminationUI 0x2100006B — standalone 310×400 examine window",
};

// URL param: `?examineFloaty=0` reverts to the legacy main-panel view.
function floatyEnabled() {
  try {
    const params = new URLSearchParams(window.location?.search ?? "");
    const v = params.get("examineFloaty");
    if (v === "0" || v === "false" || v === "off") return false;
  } catch (_) {}
  return true;
}

export function mount(_ctx) {
  // Take over `window.__showExamineFor` when the floaty path is enabled.
  // Falls back to the legacy main-panel view (examine-target.js installs
  // its own __showExamineFor in mount(); ours overrides because plugin
  // mount order puts examine-floaty after examine-target in the registry).
  const enabled = floatyEnabled();
  if (enabled) {
    window.__showExamineFor = (guid, opts = {}) => {
      openFloaty({
        guid: (guid >>> 0),
        name: opts.name,
        fromEntity: !opts.fromInventory,
        fromInventory: !!opts.fromInventory,
        srcLi: opts.srcLi,
      });
    };
    window.__examineFloaty = { open: openFloaty, close: closeFloaty, isOpen };
  }

  return () => {
    runCleanup();
    if (state.overlay) {
      state.overlay.remove();
      state.overlay = null;
    }
    if (enabled) {
      delete window.__examineFloaty;
      // Leave __showExamineFor to whatever examine-target.js installed.
    }
  };
}
