// Shared main-panel manager — retail's gmFloatyPanelUI 0x2100006E
// (right-side vertical pane) + gmFloatyEnvPanelUI 0x2100006D (the
// landscape "env / player info" strip) as TWO independent panes that
// share one container module.
//
// User direction 2026-05-22 (PR-DD): "there are usually two ui panes
// can you find them in the data?" — yes. We now mount BOTH and let the
// view registry route to either.
//
// Pane summary:
//   primary   — gmFloatyPanelUI mirror. Right side, vertical 300×362,
//               top:160px right:8px. The pane every existing plugin
//               targets today (Inventory / Examine / Skills / Magic /
//               Allegiance / Fellowship / Options / Map / Journal /
//               Spellbook / Vendor). Behaviour unchanged.
//   secondary — gmFloatyEnvPanelUI mirror. Top-left landscape strip.
//               360×140 (scaled from retail's 610×120 to fit alongside
//               vitals + chat without overlap). Same 8-corner brass-
//               frame chrome composition as primary, but composed from
//               the env-panel's own corner/edge DIDs:
//                 0x060074C3 TL   0x060074C4 TR
//                 0x060074C5 BL   0x060074C6 BR
//                 0x060074BF top  0x060074C0 left
//                 0x060074C1 bot  0x060074C2 right
//
// Public API stays mostly backwards-compatible. All view-routing calls
// take an optional `opts.pane` ("primary"|"secondary"); when omitted,
// pane defaults to either the view's registered `defaultPane` or
// "primary" — so today's call sites Just Work.
//
//   registerView(id, view, { defaultPane = "primary" } = {})
//   showView(id, ctx = {}, opts = {})    // opts.pane optional
//   pushView(id, ctx = {}, opts = {})    // opts.pane optional
//   closeView(opts = {})                  // opts.pane optional (defaults primary)
//   toggleView(id, ctx = {}, opts = {})
//   isOpen(pane = "primary")
//   currentViewId(pane = "primary")
//   currentPaneOf(viewId)  // → "primary"|"secondary"|null
//
// F-key hotkey in index.html: plain F-key → primary toggle (today's
// behaviour). Shift+F-key → secondary toggle. So the user can stack
// Inventory in primary + Character in secondary simultaneously, etc.

const PANE_PRIMARY = "primary";
const PANE_SECONDARY = "secondary";

const STYLE_ID = "hb-main-panel-style";
const OVERLAY_ID_PRIMARY = "hb-main-panel";          // legacy id — kept so existing CSS rules (e.g. index.html agent-mode whitelist) still match
const OVERLAY_ID_SECONDARY = "hb-main-panel-2";

// View registry — id → { name?, nameFor?, mount(bodyEl, ctx) → cleanup?, defaultPane? }
const views = new Map();

// Pane state — { overlay, titleEl, titleName, bodyEl, backBtn, closeBtn,
//                stack: [{id, ctx}], currentCleanup: fn|null }
const panes = {
  [PANE_PRIMARY]:   _emptyPaneState(),
  [PANE_SECONDARY]: _emptyPaneState(),
};

function _emptyPaneState() {
  return {
    overlay: null, titleEl: null, titleName: null, bodyEl: null,
    backBtn: null, closeBtn: null,
    stack: [], currentCleanup: null,
  };
}

function _normalizePane(p) {
  if (p === PANE_SECONDARY) return PANE_SECONDARY;
  return PANE_PRIMARY;
}

// Resolve which pane a call should target.
//   1. explicit opts.pane wins
//   2. else the view's registered defaultPane
//   3. else PRIMARY
function _resolvePane(id, opts) {
  if (opts && opts.pane) return _normalizePane(opts.pane);
  const v = views.get(id);
  if (v && v.defaultPane) return _normalizePane(v.defaultPane);
  return PANE_PRIMARY;
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    /* ===== Primary pane — gmFloatyPanelUI 0x2100006E mirror ===== */
    #${OVERLAY_ID_PRIMARY} {
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
    #${OVERLAY_ID_PRIMARY}[data-open="1"] { display: block; }

    /* ===== Secondary pane — gmFloatyEnvPanelUI 0x2100006D mirror =====
       Top-left landscape strip. Same brass-frame composition theme as
       the primary, but the 8-corner sprites come from the env-panel's
       own DID set (0x060074BF top / C0 left / C1 bot / C2 right /
       C3 TL / C4 TR / C5 BL / C6 BR). We use a single border-image to
       cover all 8 with one decoded texture instead of mounting 8
       sibling divs — cleaner, identical visual outcome for our 5×5
       corners + 5px edges. The decorative inner layer (0x06006119 /
       0x0600612A..D) renders as the inner-rim accent via a second
       inset shadow. */
    #${OVERLAY_ID_SECONDARY} {
      position: fixed;
      top: 8px;
      left: 8px;
      z-index: 50;
      width: 360px;
      height: 140px;
      box-sizing: border-box;
      pointer-events: none;
      font-family: var(--hb-font-serif);
      background: url("./data/ui-sprites/0x06004D0A.png") center/cover no-repeat,
                  linear-gradient(180deg, var(--hb-bg-stone-top) 0%, var(--hb-bg-stone-bottom) 100%);
      /* 8-corner chrome via composite border-image — uses the env-panel
         corner+edge DIDs assembled into the same brass-frame look. */
      border: 5px solid transparent;
      border-image: url("./sprites/acsprites/panel.png") 6 / 5px / 0 stretch;
      box-shadow:
        inset 0 0 0 1px rgba(120, 84, 32, 0.55),
        var(--hb-shadow-panel);
      color: var(--hb-text-cream);
      display: none;
    }
    #${OVERLAY_ID_SECONDARY}[data-open="1"] { display: block; }

    /* Shared chrome — title / body / back / close. Both panes use the
       same .hb-mp-* class names so existing styles (titlebar font,
       hover states) apply uniformly. */
    #${OVERLAY_ID_PRIMARY} .hb-mp-title,
    #${OVERLAY_ID_SECONDARY} .hb-mp-title {
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
    #${OVERLAY_ID_PRIMARY} .hb-mp-back,
    #${OVERLAY_ID_SECONDARY} .hb-mp-back {
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
    #${OVERLAY_ID_PRIMARY}[data-stack-depth="2"] .hb-mp-back,
    #${OVERLAY_ID_PRIMARY}[data-stack-depth="3"] .hb-mp-back,
    #${OVERLAY_ID_PRIMARY}[data-stack-depth="4"] .hb-mp-back,
    #${OVERLAY_ID_SECONDARY}[data-stack-depth="2"] .hb-mp-back,
    #${OVERLAY_ID_SECONDARY}[data-stack-depth="3"] .hb-mp-back,
    #${OVERLAY_ID_SECONDARY}[data-stack-depth="4"] .hb-mp-back { visibility: visible; }
    #${OVERLAY_ID_PRIMARY} .hb-mp-back:hover,
    #${OVERLAY_ID_SECONDARY} .hb-mp-back:hover { background: var(--hb-overlay-active); color: var(--hb-text-gold); }
    #${OVERLAY_ID_PRIMARY} .hb-mp-title-name,
    #${OVERLAY_ID_SECONDARY} .hb-mp-title-name {
      flex: 1;
      letter-spacing: 0.04em;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #${OVERLAY_ID_PRIMARY} .hb-mp-close,
    #${OVERLAY_ID_SECONDARY} .hb-mp-close {
      width: 14px; height: 14px;
      background: var(--hb-border-brass);
      color: var(--hb-bg-stone-bottom);
      font-size: 9px;
      line-height: 14px;
      text-align: center;
      cursor: pointer;
    }
    #${OVERLAY_ID_PRIMARY} .hb-mp-close:hover,
    #${OVERLAY_ID_SECONDARY} .hb-mp-close:hover { background: var(--hb-text-gold); }
    #${OVERLAY_ID_PRIMARY} .hb-mp-body,
    #${OVERLAY_ID_SECONDARY} .hb-mp-body {
      position: absolute;
      top: 25px;
      left: 0; right: 0; bottom: 0;
      overflow: hidden;
      pointer-events: auto;
    }
  `;
  document.head.appendChild(style);
}

// Register a view.
//   id          : string view id ("inventory", "examine", ...)
//   view        : { name?: string, nameFor?(ctx) → string,
//                   mount(bodyEl, ctx) → cleanup-fn? }
//   opts        : { defaultPane?: "primary"|"secondary" }
export function registerView(id, view, opts = {}) {
  if (opts && opts.defaultPane) {
    views.set(id, { ...view, defaultPane: _normalizePane(opts.defaultPane) });
  } else {
    views.set(id, view);
  }
}

function _runCleanup(p) {
  if (p.currentCleanup) {
    try { p.currentCleanup(); } catch (e) { console.error("[main-panel] cleanup error", e); }
    p.currentCleanup = null;
  }
  if (p.bodyEl) p.bodyEl.innerHTML = "";
}

function _mountCurrent(paneId) {
  const p = panes[paneId];
  if (!p.overlay) return;
  if (!p.stack.length) {
    _hidePane(paneId);
    return;
  }
  const { id, ctx } = p.stack[p.stack.length - 1];
  const view = views.get(id);
  if (!view) {
    console.warn(`[main-panel] no view registered: ${id} (pane=${paneId})`);
    _runCleanup(p);
    p.titleName.textContent = id.charAt(0).toUpperCase() + id.slice(1);
    p.bodyEl.innerHTML = `<div style="padding:24px;color:var(--hb-text-muted);font-style:italic;text-align:center;font-size:11px;">View "${id}" not built yet.</div>`;
    p.currentCleanup = null;
    p.overlay.dataset.stackDepth = String(p.stack.length);
    _showPane(paneId);
    return;
  }
  _runCleanup(p);
  const name = (typeof view.nameFor === "function") ? view.nameFor(ctx) : (view.name ?? id);
  p.titleName.textContent = name;
  try {
    // Augment ctx so plugins that want to know which pane they live in
    // (e.g. tab-swap handlers) can read it from their own ctx without
    // having to call currentPaneOf().
    const augmentedCtx = (ctx && typeof ctx === "object") ? { ...ctx, _pane: paneId } : { _pane: paneId };
    p.currentCleanup = view.mount(p.bodyEl, augmentedCtx) || null;
  } catch (e) {
    console.error(`[main-panel] view mount error (${id} on ${paneId})`, e);
  }
  p.overlay.dataset.stackDepth = String(p.stack.length);
  _showPane(paneId);
}

// Replace current view (reset stack to single entry). Refuses to swap
// to a missing view — keeps the previous view shown.
export function showView(id, ctx = {}, opts = {}) {
  const paneId = _resolvePane(id, opts);
  const p = panes[paneId];
  if (!views.has(id)) {
    console.warn(`[main-panel] showView: no view "${id}"; showing placeholder on ${paneId}`);
    p.stack = [{ id, ctx }];
    _mountCurrent(paneId);
    return;
  }
  p.stack = [{ id, ctx }];
  _mountCurrent(paneId);
}

// Push view onto stack (preserves previous so closeView returns to it).
export function pushView(id, ctx = {}, opts = {}) {
  const paneId = _resolvePane(id, opts);
  const p = panes[paneId];
  if (!views.has(id)) {
    console.warn(`[main-panel] pushView: no view "${id}"; staying on current (pane=${paneId})`);
    return;
  }
  p.stack.push({ id, ctx });
  _mountCurrent(paneId);
}

// Pop current view; show previous if any, else hide. opts.pane defaults
// to primary so old call sites (window.__mainPanel.closeView()) keep
// closing the primary pane as before.
export function closeView(opts = {}) {
  const paneId = _normalizePane(opts.pane || PANE_PRIMARY);
  const p = panes[paneId];
  _runCleanup(p);
  p.stack.pop();
  if (p.stack.length > 0) _mountCurrent(paneId);
  else _hidePane(paneId);
}

// Toggle: if the pane is open and showing this view (top of stack), close;
// otherwise show this view as the new root. If opts.pane is omitted but
// the view is already open in some other pane, toggling without a pane
// arg will still target its registered defaultPane / primary — call sites
// that want pane-aware toggle should pass opts.pane explicitly.
export function toggleView(id, ctx = {}, opts = {}) {
  const paneId = _resolvePane(id, opts);
  const p = panes[paneId];
  if (p.overlay?.dataset.open === "1" && p.stack.length > 0 && p.stack[p.stack.length - 1].id === id) {
    closeView({ pane: paneId });
  } else {
    showView(id, ctx, { pane: paneId });
  }
}

export function isOpen(pane = PANE_PRIMARY) {
  const p = panes[_normalizePane(pane)];
  return p.overlay?.dataset.open === "1";
}

export function currentViewId(pane = PANE_PRIMARY) {
  const p = panes[_normalizePane(pane)];
  return p.stack.length > 0 ? p.stack[p.stack.length - 1].id : null;
}

// Find which pane a given view is currently top-of-stack on. Useful for
// tab-swap handlers that need to swap the new view into the same pane
// the user opened the old view in.
//   Returns "primary" | "secondary" | null
export function currentPaneOf(viewId) {
  for (const paneId of [PANE_PRIMARY, PANE_SECONDARY]) {
    const p = panes[paneId];
    if (p.stack.length > 0 && p.stack[p.stack.length - 1].id === viewId) return paneId;
  }
  return null;
}

function _showPane(paneId) {
  const p = panes[paneId];
  if (p.overlay) p.overlay.dataset.open = "1";
}
function _hidePane(paneId) {
  const p = panes[paneId];
  _runCleanup(p);
  p.stack = [];
  if (p.overlay) {
    p.overlay.dataset.open = "0";
    p.overlay.dataset.stackDepth = "0";
  }
}

function _buildPaneDOM(paneId, overlayId) {
  const p = panes[paneId];
  const existing = document.getElementById(overlayId);
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = overlayId;
  overlay.dataset.open = "0";
  overlay.dataset.stackDepth = "0";
  overlay.dataset.paneId = paneId;

  const titleEl = document.createElement("div");
  titleEl.className = "hb-mp-title";
  const backBtn = document.createElement("span");
  backBtn.className = "hb-mp-back";
  backBtn.textContent = "←";
  backBtn.title = "Back to previous";
  backBtn.addEventListener("click", () => closeView({ pane: paneId }));
  titleEl.appendChild(backBtn);
  const titleName = document.createElement("span");
  titleName.className = "hb-mp-title-name";
  titleName.textContent = "Panel";
  titleEl.appendChild(titleName);
  const closeBtn = document.createElement("span");
  closeBtn.className = "hb-mp-close";
  closeBtn.textContent = "×";
  closeBtn.title = "Close";
  // Close button drops the whole stack for THIS pane (matches today's
  // single-pane behaviour where × hid the panel outright).
  closeBtn.addEventListener("click", () => _hidePane(paneId));
  titleEl.appendChild(closeBtn);
  overlay.appendChild(titleEl);

  const bodyEl = document.createElement("div");
  bodyEl.className = "hb-mp-body";
  overlay.appendChild(bodyEl);

  document.body.appendChild(overlay);

  p.overlay = overlay;
  p.titleEl = titleEl;
  p.titleName = titleName;
  p.bodyEl = bodyEl;
  p.backBtn = backBtn;
  p.closeBtn = closeBtn;
}

export const manifest = {
  id: "main-panel",
  name: "Main Panel",
  icon: "🪟",
  iconHidden: true,
  version: "0.2.0",
  description: "Shared dual-pane container — gmFloatyPanelUI (primary, right) + gmFloatyEnvPanelUI (secondary, top-left)",
};

export function mount(_ctx) {
  ensureStyles();
  _buildPaneDOM(PANE_PRIMARY, OVERLAY_ID_PRIMARY);
  _buildPaneDOM(PANE_SECONDARY, OVERLAY_ID_SECONDARY);

  // Expose the panel API on window for plugin interop + ad-hoc console use.
  window.__mainPanel = {
    registerView,
    showView,
    pushView,
    closeView,
    toggleView,
    isOpen,
    currentViewId,
    currentPaneOf,
    PANE_PRIMARY,
    PANE_SECONDARY,
  };

  return () => {
    delete window.__mainPanel;
    for (const paneId of [PANE_PRIMARY, PANE_SECONDARY]) {
      const p = panes[paneId];
      _runCleanup(p);
      if (p.overlay) p.overlay.remove();
      panes[paneId] = _emptyPaneState();
    }
  };
}
