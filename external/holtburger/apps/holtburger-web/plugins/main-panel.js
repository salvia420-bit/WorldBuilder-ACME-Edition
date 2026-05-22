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

const OVERLAY_ID = "hb-main-panel";
const STYLE_ID = "hb-main-panel-style";

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
      border-image: url("./sprites/acsprites/panel.png") 6 / 6px / 0 stretch;
      box-shadow: var(--hb-shadow-panel);
      color: var(--hb-text-cream);
      display: none;
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
    console.warn(`[main-panel] no view registered: ${id}`);
    stack.pop();
    _mountCurrent();
    return;
  }
  _runCleanup();
  const name = (typeof view.nameFor === "function") ? view.nameFor(ctx) : (view.name ?? id);
  titleName.textContent = name;
  try {
    currentCleanup = view.mount(bodyEl, ctx) || null;
  } catch (e) {
    console.error(`[main-panel] view mount error (${id})`, e);
  }
  overlay.dataset.stackDepth = String(stack.length);
  show();
}

// Replace current view (reset stack to single entry).
export function showView(id, ctx = {}) {
  stack = [{ id, ctx }];
  _mountCurrent();
}

// Push view onto stack (preserves previous so closeView returns to it).
export function pushView(id, ctx = {}) {
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
  backBtn.textContent = "←";
  backBtn.title = "Back to previous";
  backBtn.addEventListener("click", () => closeView());
  titleEl.appendChild(backBtn);
  titleName = document.createElement("span");
  titleName.className = "hb-mp-title-name";
  titleName.textContent = "Panel";
  titleEl.appendChild(titleName);
  closeBtn = document.createElement("span");
  closeBtn.className = "hb-mp-close";
  closeBtn.textContent = "×";
  closeBtn.title = "Close";
  closeBtn.addEventListener("click", () => hide());
  titleEl.appendChild(closeBtn);
  overlay.appendChild(titleEl);

  bodyEl = document.createElement("div");
  bodyEl.className = "hb-mp-body";
  overlay.appendChild(bodyEl);

  document.body.appendChild(overlay);

  // Expose the panel API on window for plugin interop + ad-hoc console use.
  window.__mainPanel = { registerView, showView, pushView, closeView, toggleView, isOpen, currentViewId };

  return () => {
    delete window.__mainPanel;
    _runCleanup();
    overlay.remove();
  };
}
