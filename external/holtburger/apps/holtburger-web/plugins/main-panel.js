// Shared main-panel container — the retail-AC "one pane, many functions"
// architecture (gmFloatyPanelUI 0x2100006E + content swap).
//
// User direction 2026-05-22: "when there is an action of examining and
// inventory is open, it will transition instantly in the same ui main
// to the examine pane. same pane being used for diverse functions."
//
// One fixed-position brass-framed pane on the right side of screen.
// Holds ONE view at a time (Inventory / Examine / Skills / Magic /
// Allegiance / Fellowship / Options / Map / Journal / ...). Switching
// views is an instant content swap — the pane stays put.
//
// View stack lets close-view return to the previous view (so you can
// examine an inventory item and have "back" return to the inventory).
// Closing when the stack is empty hides the pane entirely.
//
// Per the examine architecture doc (apps/holtburger-web/docs/
// examine-architecture-2026-05-22.md), this matches retail's
// gmInventoryUI + gmExaminationUI relationship — different
// gmXxxUI instances mount into the same container slot.

import { setAcText, HEADING_FONT_ID } from "../ui/ac_font.js";
import { loadLayout, findElementById, getCachedLayout } from "../ui/ac_layout.js";
import { attachWindowPosition, WINDOW_ID } from "../ui/ac_window_position.js";
import {
  attachFloatyFrame, resolveFrameSpritesFromLayout, MAIN_PANEL_FRAME_UI_IDS,
} from "../ui/ac_floaty_frame.js";

const OVERLAY_ID = "hb-main-panel";
const STYLE_ID = "hb-main-panel-style";

// gmFloatyPanelUI — retail's outer frame-chrome wrapper that hosts the
// 16 swappable per-UI content states (Inventory / Spellbook / Magic /
// Skills / Allegiance / Map / Options / etc.). Element-id map confirmed
// by main_panel_layout_dump 2026-05-24 against the DAT:
//
//   0x100005FE — outer root (310×372, includes the 5px border on all sides)
//                StateDesc carries 2 states (locked / unlocked) which v1
//                fetch_layout doesn't yet surface (G3 in
//                docs/layout-port-plan-2026-05-24.md). Locked-state
//                element refs below are the second-image slots that
//                light up when the UI is locked.
//
//   --- Frame chrome (8 type=3 default + 8 type=2/9 locked) ---
//   0x10000653 — (0,0)     5×5   top-left corner
//   0x10000654 — (5,0)     300×5 top edge
//   0x10000655 — (305,0)   5×5   top-right corner
//   0x10000656 — (0,5)     5×362 left edge
//   0x10000657 — (0,367)   5×5   bottom-left corner
//   0x10000658 — (5,367)   300×5 bottom edge
//   0x10000659 — (305,367) 5×5   bottom-right corner
//   0x1000065A — (305,5)   5×362 right edge
//   0x1000065B — top-left corner (locked variant)
//   0x1000065C — top edge (locked variant)
//   0x1000065D — top-right corner (locked variant)
//   0x1000065E — left edge (locked variant)
//   0x1000065F — bottom-left corner (locked variant)
//   0x10000660 — bottom edge (locked variant)
//   0x10000661 — bottom-right corner (locked variant)
//   0x10000662 — right edge (locked variant)
//
//   --- Body slot (the content area where child UIs swap in) ---
//   0x10000180 — (5,5) 300×362 — THE content slot. Per-state children
//                below are 0-position 300×362 siblings — each is the
//                drop-target for one of the per-panel UIs that retail
//                swaps in (Inventory, Spellbook, Map, ...). v1
//                fetch_layout doesn't yet expose which state maps to
//                which gmXxxUI (StateDesc dependency, G3).
//   0x10000181..0x1000018F + 0x10000559 + 0x10000190 — 16 0-position
//                300×362 content states inside the body slot. Reference-
//                only constants below (the body slot itself is what we
//                size; the state-children mount their own DOM into it).
//
// NOTE on title bar + close button:
//   gmFloatyPanelUI provides ONLY the frame chrome (the 5-px border
//   wrapping the body slot). It does NOT contain title-bar or close-
//   button elements — those are part of the per-panel layouts that
//   mount INSIDE the body slot (e.g. gmCharacterInfoUI 0x2100001A
//   has its own 0x100000FE 276×25 title bar + 0x100000FC 24×25
//   close button as children of the 300×362 content area).
//
//   Holtburger diverges from retail here: instead of letting each
//   per-panel layout draw its own title bar + close button, main-panel
//   draws ONE shared title bar (25px strip at top of body) + close
//   button, and child views mount BELOW it in the remaining 300×337
//   space. This is documented in plugins/character-info.js (note that
//   its hand-tuned positions are offset to account for main-panel's
//   25-px title strip already consuming the top of the body).
//
//   So this port leaves the title bar + close button DOM/CSS exactly
//   as-is. Only the outer body-slot geometry is layout-driven.
const MAIN_PANEL_LAYOUT_ID = 0x2100006E;
const MP_ELEM_ROOT          = 0x100005FE; // 310×372 outer (includes 5-px borders)
const MP_ELEM_BODY          = 0x10000180; // (5,5) 300×362 — content slot
// Reference-only element_ids — drawn via CSS today, kept here so a
// future per-edge sprite port (locked vs unlocked frame variations,
// state-driven content swap) doesn't have to re-derive from the dump.
// Frame chrome (default state corners + edges, 8 elements):
//   0x10000653/4/5/6/7/8/9/0x1000065A — TL T TR L BL B BR R
// Frame chrome (locked state, 8 elements):
//   0x1000065B/C/D/E/F/0x10000660/1/2 — TL T TR L BL B BR R
// Per-state content drop-targets (16 zero-position siblings inside
// MP_ELEM_BODY, type=0 unconfigured in v1 fetch_layout):
//   0x10000181..0x10000190 + 0x10000559

// View registry — id → { name?, nameFor?(ctx), mount(bodyEl, ctx) → cleanup? }
const views = new Map();

// Container DOM refs (populated in mount()).
let overlay = null;
let titleEl = null;
let titleName = null;
let bodyEl = null;
let backBtn = null;
let closeBtn = null;

// View stack — { id, ctx } per entry. Top is current view.
let stack = [];
let currentCleanup = null;

// Deprecated shim (kept for any straggling caller; new code should use
// `attachWindowPosition` from `ui/ac_window_position.js`). 2026-06-05
// consolidation reused the new adapter's enhanced impl (viewport
// clamping, interactive-child guard, debounced save, lock-event
// broadcast) and added the `legacyKey` migration so prior
// `hb_panel_pos_<id>` saves carry forward. The string panelId resolves
// to a synthetic windowId for callers that don't yet have a layout
// root DID handy.
const DRAG_BUTTON_SELECTOR = ".hb-mp-close,.hb-mp-back,button,input,select,textarea,[data-drag-ignore]";
export function installDragPersistence(rootEl, handleEl, panelId) {
  if (!rootEl || !handleEl) return () => {};
  // Map known panelIds to verified windowIds; fall back to a hash for
  // unknown callers. Hash uses a u32 with the 0xFFFE prefix to avoid
  // collisions with real layout DIDs.
  const KNOWN = { "main-panel": WINDOW_ID.MAIN_PANEL, "chat-panel": WINDOW_ID.CHAT };
  let windowId = KNOWN[panelId];
  if (typeof windowId !== "number") {
    // Simple FNV-1a 32 of the panelId for the synthetic case.
    let h = 0x811c9dc5;
    for (let i = 0; i < panelId.length; i++) {
      h ^= panelId.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    windowId = (0xFFFE0000 | (h & 0xFFFF)) >>> 0;
  }
  attachWindowPosition(rootEl, {
    windowId,
    dragHandle: handleEl,
    ignoreSelector: DRAG_BUTTON_SELECTOR,
    legacyKey: `hb_panel_pos_${panelId}`,
  });
  return () => { /* attachWindowPosition has no teardown handle today */ };
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    #${OVERLAY_ID} {
      position: fixed;
      top: 160px;
      right: 8px;
      z-index: 50;
      width: 300px;
      height: 362px;
      box-sizing: border-box;
      pointer-events: none;
      font-family: var(--hb-font-serif);
      background: url("./data/ui-sprites/0x06004D0A.png") center/cover no-repeat,
                  linear-gradient(180deg, var(--hb-bg-stone-top) 0%, var(--hb-bg-stone-bottom) 100%);
      border: 6px solid transparent;
      box-shadow: var(--hb-shadow-panel);
      color: var(--hb-text-cream);
      display: none;
    }
    /* HUD rec #153 — placeholder 9-slice chrome. Suppressed once the DAT
       sprite frame (attachFloatyFrame) attaches and adds .hb-floaty-framed,
       so the retail 8-piece chrome paints over it cleanly. */
    #${OVERLAY_ID}:not(.hb-floaty-framed) {
      border-image: url("./sprites/acsprites/panel.png") 6 / 6px / 0 stretch;
    }
    #${OVERLAY_ID}[data-open="1"] { display: block; }
    #${OVERLAY_ID} .hb-mp-title {
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 25px;
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 0 6px;
      background: url("./data/ui-sprites/0x06004CFA.png") center/100% 100% no-repeat;
      font-size: 11px;
      color: var(--hb-text-cream-bright);
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.9);
      pointer-events: auto;
      user-select: none;
    }
    #${OVERLAY_ID} .hb-mp-back {
      width: 18px; height: 14px;
      font-size: 10px;
      line-height: 14px;
      text-align: center;
      color: var(--hb-text-cream);
      background: rgba(0, 0, 0, 0.45);
      border: 1px solid var(--hb-border-brass-dim);
      cursor: pointer;
      user-select: none;
      visibility: hidden;
    }
    #${OVERLAY_ID}[data-stack-depth="2"] .hb-mp-back,
    #${OVERLAY_ID}[data-stack-depth="3"] .hb-mp-back,
    #${OVERLAY_ID}[data-stack-depth="4"] .hb-mp-back { visibility: visible; }
    #${OVERLAY_ID} .hb-mp-back:hover { background: var(--hb-overlay-active); color: var(--hb-text-gold); }
    #${OVERLAY_ID} .hb-mp-title-name {
      flex: 1;
      letter-spacing: 0.04em;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #${OVERLAY_ID} .hb-mp-close {
      width: 14px; height: 14px;
      background: var(--hb-border-brass);
      color: var(--hb-bg-stone-bottom);
      font-size: 9px;
      line-height: 14px;
      text-align: center;
      cursor: pointer;
    }
    #${OVERLAY_ID} .hb-mp-close:hover { background: var(--hb-text-gold); }
    #${OVERLAY_ID} .hb-mp-body {
      position: absolute;
      top: 25px;
      left: 0; right: 0; bottom: 0;
      overflow: hidden;
      pointer-events: auto;
    }
  `;
  document.head.appendChild(style);
}

// Register a view. Idempotent — re-registering overwrites.
//   id          : string view id ("inventory", "examine", ...)
//   view        : { name?: string, nameFor?(ctx) → string,
//                   mount(bodyEl, ctx) → cleanup-fn? }
export function registerView(id, view) {
  views.set(id, view);
}

function _runCleanup() {
  if (currentCleanup) {
    try { currentCleanup(); } catch (e) { console.error("[main-panel] cleanup error", e); }
    currentCleanup = null;
  }
  if (bodyEl) bodyEl.innerHTML = "";
}

function _mountCurrent() {
  if (!stack.length) {
    hide();
    return;
  }
  const { id, ctx } = stack[stack.length - 1];
  const view = views.get(id);
  if (!view) {
    // View not registered — leave the previous view intact instead of
    // destroying the panel. The caller should have checked first.
    console.warn(`[main-panel] no view registered: ${id} (showing not-yet-built placeholder)`);
    _runCleanup();
    setAcText(titleName, id.charAt(0).toUpperCase() + id.slice(1), { fontId: HEADING_FONT_ID });
    bodyEl.innerHTML = `<div style="padding:24px;color:var(--hb-text-muted);font-style:italic;text-align:center;font-size:11px;">View "${id}" not built yet.</div>`;
    currentCleanup = null;
    overlay.dataset.stackDepth = String(stack.length);
    show();
    return;
  }
  _runCleanup();
  const name = (typeof view.nameFor === "function") ? view.nameFor(ctx) : (view.name ?? id);
  setAcText(titleName, name, { fontId: HEADING_FONT_ID });
  try {
    currentCleanup = view.mount(bodyEl, ctx) || null;
  } catch (e) {
    console.error(`[main-panel] view mount error (${id})`, e);
  }
  overlay.dataset.stackDepth = String(stack.length);
  show();
}

// Replace current view (reset stack to single entry). Refuses to swap
// to a missing view — keeps the previous view shown.
export function showView(id, ctx = {}) {
  if (!views.has(id)) {
    // R10 (BAND-C1): warn-and-return — do NOT clobber the stack with an
    // unregistered id (toggleView routes unregistered hotkeys here; before
    // R2/R3/R4 the live blast radius was {emote, social, house}). Keeping the
    // current view avoids the "View not built yet" placeholder flash.
    console.warn(`[main-panel] showView: no view "${id}"; keeping current`);
    return;
  }
  stack = [{ id, ctx }];
  _mountCurrent();
}

// Push view onto stack (preserves previous so closeView returns to it).
export function pushView(id, ctx = {}) {
  if (!views.has(id)) {
    console.warn(`[main-panel] pushView: no view "${id}"; staying on current`);
    return;
  }
  stack.push({ id, ctx });
  _mountCurrent();
}

// Pop current view; show previous if any, else hide.
export function closeView() {
  _runCleanup();
  stack.pop();
  if (stack.length > 0) _mountCurrent();
  else hide();
}

// Toggle: if panel is open and showing this view (top of stack), close;
// otherwise show this view as the new root.
export function toggleView(id, ctx = {}) {
  if (overlay?.dataset.open === "1" && stack.length > 0 && stack[stack.length - 1].id === id) {
    closeView();
  } else {
    showView(id, ctx);
  }
}

export function isOpen() {
  return overlay?.dataset.open === "1";
}

export function currentViewId() {
  return stack.length > 0 ? stack[stack.length - 1].id : null;
}

// Wave D.1 follow-on (2026-05-27) — dynamically retitle the panel
// without re-mounting the view. Mirrors `gmInventoryUI::RecvNotice_NewParentContainer`
// (ACBindings `gmInventoryUI.cs:218-223`) which retitles the inventory
// window when the player switches the active parent container (e.g.
// "Inventory of <player>" → "Contents of <pack name>"). Falls back
// silently if the panel isn't mounted (titleName=null).
export function setTitle(text) {
  if (!titleName) return false;
  setAcText(titleName, text, { fontId: HEADING_FONT_ID });
  return true;
}

function show() { overlay.dataset.open = "1"; }
function hide() {
  _runCleanup();
  stack = [];
  overlay.dataset.open = "0";
  overlay.dataset.stackDepth = "0";
}

export const manifest = {
  id: "main-panel",
  name: "Main Panel",
  icon: "🪟",
  iconHidden: true,
  version: "0.1.0",
  description: "Shared right-side pane — inventory / examine / skills / ...",
};

// Apply gmFloatyPanelUI 0x2100006E layout to the main-panel container.
//
// CONSERVATIVE SCOPE — main-panel is THE shared container for inventory /
// spellbook / character-info / options / map / journal / contracts /
// allegiance / fellowship / examine / vendor-ui. EVERY child plugin
// assumes a 300×362 body slot (see inventory.js, character-info.js etc.
// for hand-tuned positions inside that area). Resizing the body would
// break ALL of them.
//
// Retail's gmFloatyPanelUI 0x2100006E body slot (0x10000180) is
// EXACTLY 300×362 — identical to our existing CSS dims. So applying
// retail geometry is a no-op-by-numbers but makes the DAT the
// source-of-truth for future maintenance.
//
// What this DOESN'T touch (the layout doesn't carry these elements):
//   - Title bar (.hb-mp-title 25px strip) — Holtburger-owned chrome
//   - Back button (.hb-mp-back) — Holtburger-owned chrome
//   - Close button (.hb-mp-close) — Holtburger-owned chrome
// In retail, title-bar + close-button are part of each per-panel layout
// (gmInventoryUI / gmCharacterInfoUI / etc.) that mounts INSIDE the
// 300×362 body slot — gmFloatyPanelUI itself is frame-chrome only. We
// diverge by drawing one shared title strip at the top of the body and
// letting child views render below it (in the remaining 300×337). See
// the head-comment block for details.
//
// What this also DOESN'T touch (intentional, see G3 in
// docs/layout-port-plan-2026-05-24.md):
//   - Frame chrome corners + edges (16 elements) — currently rendered
//     via CSS `border-image: url(panel.png) 6 / 6px / 0 stretch`. The
//     per-edge layout positions are documented in the element-id map
//     above for the future port that swaps to per-edge sprites,
//     particularly once StateDesc (G3) surfaces the locked-state
//     switch (border switches to a different sprite when UI is locked).
//
// Mount-order note: main-panel mounts via mountBar() which runs BEFORE
// wasm is ready. Mirror radar.js's 8 × 2s retry loop so the layout
// gets applied once the eor/local shards land.
function applyMainPanelLayout(refs, attempt = 0) {
  const apply = (layout) => {
    if (!layout) {
      if (attempt < 8) {
        setTimeout(() => applyMainPanelLayout(refs, attempt + 1), 2000);
      }
      return;
    }
    let applied = 0;
    const divergences = [];

    // Outer root — 310×372 in retail (5-px borders on each side wrap
    // the 300×362 body). Holtburger overlay CSS is 300×362 with
    // box-sizing:border-box and a 6-px border-image, so:
    //   - overlay OUTER (border-box outer) = 300×362
    //   - overlay INNER (content area)     = 288×350 (6px border each side)
    // Retail's inner area (after the 5-px frame) would be 300×362
    // (matching the body element 0x10000180). The right-side and bottom
    // edges of child plugins end up clipped by ~12 px horizontally
    // and ~12 px vertically vs retail because of the wider Holtburger
    // border-image. This is a long-standing layout-mismatch; resolving
    // it would require widening the overlay to 312×374 AND re-checking
    // every child view's clipping behaviour — out of scope for this
    // conservative port.
    const root = findElementById(layout, MP_ELEM_ROOT);
    if (root && refs.overlayEl) {
      const wantW = typeof root.width === "number" ? root.width : null;
      const wantH = typeof root.height === "number" ? root.height : null;
      if (wantW !== null && wantH !== null) {
        // Measured outer (computed style) of the overlay.
        const cs = window.getComputedStyle(refs.overlayEl);
        const outerW = parseFloat(cs.width);
        const outerH = parseFloat(cs.height);
        const borderW = parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
        const borderH = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
        // Holtburger CSS gives 300×362 outer + 6-px border each side =
        // 288×350 inner. Retail 310×372 outer + 5-px border each side =
        // 300×362 inner. Difference per axis = 12 px (288 vs 300).
        divergences.push({
          field: "root-outer",
          retail: { outerW: wantW, outerH: wantH, borderEachSide: 5, innerW: 300, innerH: 362 },
          holtburger: { outerW, outerH, borderTotal: { w: borderW, h: borderH }, innerW: outerW - borderW, innerH: outerH - borderH },
          note: "Holtburger 300×362 outer + 6-px border = 288×350 inner. Retail 310×372 outer + 5-px border = 300×362 inner. Child plugins were hand-tuned for 300-wide; right/bottom edges may clip in Holtburger.",
        });
      }
      applied += 1;

      // HUD rec #153 — attach the retail 8-piece gmFloatyPanelUI chrome from
      // the DAT. Sprite DIDs resolve via fetch_layout's StateDesc emission
      // (G3-reland 2026-06-05). Idempotent via the hb-floaty-framed class so
      // the retry loop doesn't double-attach; the placeholder border-image
      // is suppressed by the :not(.hb-floaty-framed) CSS rule once this runs.
      // windowId wires the locked/unlocked sprite swap to the
      // hb-ui-lock-changed events installDragPersistence already publishes.
      if (!refs.overlayEl.classList.contains("hb-floaty-framed")) {
        const sprites = resolveFrameSpritesFromLayout(layout, MAIN_PANEL_FRAME_UI_IDS);
        if (sprites) {
          attachFloatyFrame(refs.overlayEl, {
            unlocked: sprites.unlocked,
            locked: sprites.locked,
            cornerSize: 5,
            borderThickness: 5,
            windowId: WINDOW_ID.MAIN_PANEL,
          });
          refs.overlayEl.classList.add("hb-floaty-framed");
          applied += 1;
          try {
            window.__diag?.layout?.onMainPanelFloatyFrame?.({
              unlocked: sprites.unlocked, locked: sprites.locked,
            });
          } catch (_) {}
        }
      }
    }

    // Body slot — (5,5) 300×362 inside the outer. The CSS positions
    // our .hb-mp-body at top:25 (below the title strip) and stretches
    // left/right/bottom to 0 — so its effective inner dimensions
    // depend on the overlay being 300×362. Retail's body 300×362
    // matches our overlay dims (because Holtburger inlines title +
    // border into the overlay rather than wrapping outside it).
    //
    // Acceptance: body width 300 + height 362 — confirm match;
    // log divergence otherwise.
    const body = findElementById(layout, MP_ELEM_BODY);
    if (body && refs.bodyEl) {
      const wantW = typeof body.width === "number" ? body.width : null;
      const wantH = typeof body.height === "number" ? body.height : null;
      if (wantW === 300 && wantH === 362) {
        // Retail matches. Set explicit width/height for parity with
        // other layout-driven plugins; the CSS still positions via
        // top:25 / left:0 / right:0 / bottom:0 so this is belt-and-
        // suspenders.
        //
        // IMPORTANT: don't clear `right` / `bottom` here — those
        // anchors are what enable the body to fill the overlay
        // minus the 25-px title strip. Setting explicit width/height
        // would break the fill-to-bottom behavior if the overlay is
        // resized (as options-panel.js does). Skip explicit dims;
        // record the match.
        applied += 1;
      } else {
        divergences.push({
          field: "body",
          retail: { w: wantW, h: wantH },
          holtburger: { w: 300, h: 362 },
          note: "Body slot dims differ — child plugins assume 300×362; NOT applying.",
        });
      }
    }

    try {
      window.__diag?.layout?.onMainPanelApplied?.({
        applied,
        divergences,
        bodyDims: [body?.width, body?.height],
        rootDims: [root?.width, root?.height],
      });
    } catch (_) {}
  };
  const cached = getCachedLayout(MAIN_PANEL_LAYOUT_ID);
  if (cached) { apply(cached); return; }
  loadLayout(MAIN_PANEL_LAYOUT_ID).then(apply).catch(() => {});
}

export function mount(_ctx) {
  ensureStyles();
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();

  overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.dataset.open = "0";
  overlay.dataset.stackDepth = "0";

  titleEl = document.createElement("div");
  titleEl.className = "hb-mp-title";
  backBtn = document.createElement("span");
  backBtn.className = "hb-mp-back";
  setAcText(backBtn, "←");
  backBtn.title = "Back to previous";
  backBtn.addEventListener("click", () => closeView());
  titleEl.appendChild(backBtn);
  titleName = document.createElement("span");
  titleName.className = "hb-mp-title-name";
  setAcText(titleName, "Panel", { fontId: HEADING_FONT_ID });
  titleEl.appendChild(titleName);
  closeBtn = document.createElement("span");
  closeBtn.className = "hb-mp-close";
  setAcText(closeBtn, "×");
  closeBtn.title = "Close";
  closeBtn.addEventListener("click", () => hide());
  titleEl.appendChild(closeBtn);
  overlay.appendChild(titleEl);

  bodyEl = document.createElement("div");
  bodyEl.className = "hb-mp-body";
  overlay.appendChild(bodyEl);

  document.body.appendChild(overlay);

  // Drag-by-titlebar + localStorage position persistence (Improvement C,
  // 2026-05-29). Restore last-saved position on mount, then save on
  // drag-stop. Drag suppression for clicks on titlebar buttons (back /
  // close) — they have their own listeners and pointer-events:auto.
  installDragPersistence(overlay, titleEl, "main-panel");

  // Apply retail gmFloatyPanelUI 0x2100006E layout — body-slot dims
  // (300×362) matched against the DAT as source-of-truth. Conservative
  // (doesn't change visible geometry); see applyMainPanelLayout()
  // head-comment for the title-bar / close-button / chrome divergences
  // intentionally kept out of this port.
  applyMainPanelLayout({ overlayEl: overlay, bodyEl });

  // Expose the panel API on window for plugin interop + ad-hoc console use.
  // Wave D.1 follow-on (2026-05-27): `setTitle(text)` lets the active view
  // re-title the shared title bar without re-mounting. Mirrors retail's
  // `RecvNotice_NewParentContainer` (`gmInventoryUI.cs:218-223`) which
  // mutates `m_titleText` when the active container changes (e.g.
  // selecting a side pack swaps "Inventory of <player>" →
  // "Contents of <pack name>"). Returns true if applied, false if the
  // panel isn't mounted yet.
  window.__mainPanel = { registerView, showView, pushView, closeView, toggleView, isOpen, currentViewId, setTitle };

  return () => {
    delete window.__mainPanel;
    _runCleanup();
    overlay.remove();
  };
}
