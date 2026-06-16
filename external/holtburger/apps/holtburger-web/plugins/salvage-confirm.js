// Salvage confirmation modal — reusable Are-You-Sure prompt before a
// salvage operation destroys the source item(s). Pattern mirrors
// lifestone-popup.js: pure (nextStateForAction + decideSalvageAction)
// helpers + DOM mount, so tests can drive the state machine without
// loading the DOM.
//
// Triggering sites (tradeskill.js's `requireConfirm` flow, salvage-
// panel.js's batch Salvage button) opt in via the window-event API
// `hb:salvage-confirm-request` rather than coupling to this plugin
// directly. Resolution surfaces on `hb:salvage-confirm-result`.
//
// Programmatic API:
//   window.__showSalvageConfirm({ toolGuid, toolLabel?, items, onConfirm, onCancel })
//   window.__hideSalvageConfirm()
//
// `items` is one of:
//   - { itemGuid: number, itemLabel?: string } (single-item drag-drop)
//   - Array<{ guid: number, label?: string }> (batch from salvage-panel)
//
// Window events:
//   `hb:salvage-confirm-request`  detail: { toolGuid, toolLabel?, items }
//                                 — open the modal
//   `hb:salvage-confirm-result`   detail: { kind: "confirm"|"cancel",
//                                           toolGuid, items }
//                                 — resolution; trigger sites subscribe
//                                   if they didn't pass onConfirm/onCancel
//                                   callbacks directly.
//
// References:
//   - plugins/lifestone-popup.js (state-machine pattern)
//   - plugins/tradeskill.js (sibling confirm popup with requireConfirm)
//   - plugins/salvage-panel.js (sibling batch UI)

const OVERLAY_ID = "hb-salvage-confirm";
const STYLE_ID = "hb-salvage-confirm-style";

// ─── Pure state machine ──────────────────────────────────────────
// Exported so test_salvage_confirm.mjs can exercise the dispatch
// decisions without DOM. Identical-shape to lifestone-popup.js for
// consistency across confirm-modal plugins.

/**
 * Reduce a confirm-modal state given an event.
 *
 * @param {{ kind: "idle" }|
 *         { kind: "open", toolGuid: number,
 *           items: Array<{guid:number,label?:string}> }} prev
 * @param {{ type: "request", toolGuid: number, toolLabel?: string,
 *           items: Array<{guid:number,label?:string}> }|
 *         { type: "confirm" }|
 *         { type: "cancel" }} event
 */
export function nextStateForAction(prev, event) {
  if (event.type === "request") {
    const items = Array.isArray(event.items) ? event.items : [];
    return {
      state: {
        kind: "open",
        toolGuid: (event.toolGuid >>> 0) || 0,
        items: items.map((it) => ({
          guid: (it.guid >>> 0) || 0,
          label: it.label,
        })),
      },
      action: { kind: "none" },
    };
  }
  if (prev.kind !== "open") {
    return { state: prev, action: { kind: "none" } };
  }
  if (event.type === "confirm") {
    return {
      state: { kind: "idle" },
      action: {
        kind: "confirm",
        toolGuid: prev.toolGuid,
        items: prev.items.slice(),
      },
    };
  }
  if (event.type === "cancel") {
    return {
      state: { kind: "idle" },
      action: {
        kind: "cancel",
        toolGuid: prev.toolGuid,
        items: prev.items.slice(),
      },
    };
  }
  return { state: prev, action: { kind: "none" } };
}

/**
 * Pure helper that picks the right callback for a resolved action.
 * Real dispatch happens in mount() — this exists for tests + clarity.
 *
 * @param {{ kind:"confirm"|"cancel"|"none",
 *           toolGuid?: number,
 *           items?: Array<{guid:number}> }} action
 * @param {{ onConfirm?: Function, onCancel?: Function }} callbacks
 */
export function decideSalvageAction(action, callbacks) {
  if (action.kind === "confirm") {
    if (typeof callbacks?.onConfirm !== "function") {
      return { called: null, args: [] };
    }
    return { called: "onConfirm", args: [{ toolGuid: action.toolGuid, items: action.items }] };
  }
  if (action.kind === "cancel") {
    if (typeof callbacks?.onCancel !== "function") {
      return { called: null, args: [] };
    }
    return { called: "onCancel", args: [{ toolGuid: action.toolGuid, items: action.items }] };
  }
  return { called: null, args: [] };
}

// ─── DOM helpers ─────────────────────────────────────────────────

function ensureStyles() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    #${OVERLAY_ID} {
      position: fixed;
      left: 50%;
      top: 38%;
      transform: translate(-50%, -50%);
      z-index: 70;
      min-width: 280px;
      max-width: 380px;
      padding: 14px 18px 12px 18px;
      background: rgba(20, 14, 8, 0.96);
      border: 1px solid var(--hb-border-brass, #b08a4a);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.7);
      font-family: var(--hb-font-serif, serif);
      color: var(--hb-text-cream, #e8d8b0);
      pointer-events: auto;
      display: none;
    }
    #${OVERLAY_ID}[data-open="1"] { display: block; }
    #${OVERLAY_ID} .hb-sc-title {
      font-size: 13px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--hb-text-gold, #d4af37);
      margin: 0 0 8px 0;
      padding-bottom: 6px;
      border-bottom: 1px solid var(--hb-border-brass-dim, rgba(176, 138, 74, 0.4));
      text-align: center;
    }
    #${OVERLAY_ID} .hb-sc-body {
      font-size: 12px;
      margin-bottom: 10px;
      line-height: 1.45;
    }
    #${OVERLAY_ID} .hb-sc-item-list {
      margin: 6px 0 6px 0;
      padding: 4px 0 4px 12px;
      max-height: 120px;
      overflow-y: auto;
      font-size: 11px;
      color: var(--hb-text-muted, #b0a080);
      list-style: disc;
    }
    #${OVERLAY_ID} .hb-sc-warn {
      font-size: 11px;
      color: var(--hb-text-warn, #d6a060);
      font-style: italic;
      margin-top: 4px;
    }
    #${OVERLAY_ID} .hb-sc-row {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
    }
    #${OVERLAY_ID} button.hb-sc-btn {
      padding: 6px 14px;
      background: linear-gradient(180deg, rgba(60, 44, 24, 0.9) 0%, rgba(40, 28, 16, 0.9) 100%);
      border: 1px solid var(--hb-border-brass, #b08a4a);
      color: var(--hb-text-cream, #e8d8b0);
      font-family: inherit;
      font-size: 12px;
      cursor: pointer;
    }
    #${OVERLAY_ID} button.hb-sc-btn:hover {
      background: linear-gradient(180deg, rgba(80, 60, 30, 0.95) 0%, rgba(55, 40, 22, 0.95) 100%);
      color: var(--hb-text-gold, #d4af37);
    }
  `;
  document.head.appendChild(s);
}

const state = {
  overlayEl: null,
  titleEl: null,
  bodyEl: null,
  itemListEl: null,
  warnEl: null,
  okBtn: null,
  cancelBtn: null,
  current: { kind: "idle" },
  callbacks: null,
  keydownHandler: null,
};

function formatGuid(g) {
  return `0x${(g >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}

function renderBody(toolLabel, items) {
  if (!state.bodyEl || !state.itemListEl) return;
  while (state.itemListEl.firstChild) state.itemListEl.removeChild(state.itemListEl.firstChild);
  const toolName = toolLabel ? toolLabel : "the salvage tool";
  if (items.length === 1) {
    const it = items[0];
    const itemName = it.label || formatGuid(it.guid);
    state.bodyEl.textContent =
      `Are you sure you want to apply ${toolName} to ${itemName}? The item may be destroyed.`;
    state.itemListEl.style.display = "none";
  } else if (items.length > 1) {
    state.bodyEl.textContent =
      `Are you sure you want to apply ${toolName} to ${items.length} items?`;
    state.itemListEl.style.display = "";
    for (const it of items) {
      const li = document.createElement("li");
      li.textContent = it.label || formatGuid(it.guid);
      state.itemListEl.appendChild(li);
    }
  } else {
    state.bodyEl.textContent = `Confirm salvage operation with ${toolName}?`;
    state.itemListEl.style.display = "none";
  }
}

function ensurePopup() {
  if (state.overlayEl) return state.overlayEl;
  ensureStyles();
  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-label", "Confirm salvage");
  overlay.setAttribute("data-open", "0");

  const title = document.createElement("div");
  title.className = "hb-sc-title";
  title.textContent = "Confirm Salvage";
  overlay.appendChild(title);

  const body = document.createElement("div");
  body.className = "hb-sc-body";
  overlay.appendChild(body);

  const list = document.createElement("ul");
  list.className = "hb-sc-item-list";
  overlay.appendChild(list);

  const warn = document.createElement("div");
  warn.className = "hb-sc-warn";
  warn.textContent = "Salvaged items are consumed.";
  overlay.appendChild(warn);

  const row = document.createElement("div");
  row.className = "hb-sc-row";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "hb-sc-btn";
  cancelBtn.dataset.action = "cancel";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => dispatch({ type: "cancel" }));
  const okBtn = document.createElement("button");
  okBtn.type = "button";
  okBtn.className = "hb-sc-btn";
  okBtn.dataset.action = "confirm";
  okBtn.textContent = "Salvage";
  okBtn.addEventListener("click", () => dispatch({ type: "confirm" }));
  row.appendChild(cancelBtn);
  row.appendChild(okBtn);
  overlay.appendChild(row);

  document.body.appendChild(overlay);

  state.overlayEl = overlay;
  state.titleEl = title;
  state.bodyEl = body;
  state.itemListEl = list;
  state.warnEl = warn;
  state.okBtn = okBtn;
  state.cancelBtn = cancelBtn;
  return overlay;
}

function dispatch(event) {
  const { state: next, action } = nextStateForAction(state.current, event);
  state.current = next;
  if (state.overlayEl) {
    state.overlayEl.dataset.open = next.kind === "open" ? "1" : "0";
  }
  if (action.kind === "none") return;

  const callbacks = state.callbacks;
  const decision = decideSalvageAction(action, callbacks ?? {});
  if (decision.called === "onConfirm" || decision.called === "onCancel") {
    try {
      callbacks[decision.called](...decision.args);
    } catch (e) {
      console.warn(`[salvage-confirm] ${decision.called} threw:`, e);
    }
  }
  // Always also emit the bus event so unrelated subscribers can react
  // (e.g. salvage-panel re-enables its Salvage button after cancel).
  try {
    window.dispatchEvent(new CustomEvent("hb:salvage-confirm-result", {
      detail: {
        kind: action.kind,
        toolGuid: action.toolGuid,
        items: action.items,
      },
    }));
  } catch (_) {}
  if (action.kind === "confirm" || action.kind === "cancel") {
    state.callbacks = null;
  }
}

export function show(opts) {
  ensurePopup();
  const items = Array.isArray(opts?.items)
    ? opts.items.map((it) => ({ guid: (it.guid >>> 0) || 0, label: it.label }))
    : opts?.itemGuid != null
      ? [{ guid: (opts.itemGuid >>> 0) || 0, label: opts?.itemLabel }]
      : [];
  state.callbacks = {
    onConfirm: opts?.onConfirm,
    onCancel: opts?.onCancel,
  };
  renderBody(opts?.toolLabel, items);
  dispatch({
    type: "request",
    toolGuid: opts?.toolGuid,
    toolLabel: opts?.toolLabel,
    items,
  });
  if (!state.keydownHandler) {
    state.keydownHandler = (ev) => {
      if (state.current.kind !== "open") return;
      if (ev.key === "Escape") {
        ev.preventDefault();
        dispatch({ type: "cancel" });
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        dispatch({ type: "confirm" });
      }
    };
    document.addEventListener("keydown", state.keydownHandler);
  }
  try { state.okBtn?.focus({ preventScroll: true }); } catch (_) {}
}

export function hide() {
  if (state.current.kind !== "open") return;
  dispatch({ type: "cancel" });
}

export const manifest = {
  id: "salvage-confirm",
  name: "Salvage Confirm",
  icon: "⚠",
  iconHidden: true,
  version: "0.1.0",
  description: "Are-You-Sure modal before a salvage operation destroys the source items.",
};

export function mount() {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return () => {};
  }
  ensureStyles();

  function onRequest(ev) {
    const d = ev?.detail ?? {};
    show({
      toolGuid: d.toolGuid,
      toolLabel: d.toolLabel,
      items: d.items,
      // Bus-event consumers read the resolution via
      // `hb:salvage-confirm-result`; no callback wiring needed here.
    });
  }
  window.addEventListener("hb:salvage-confirm-request", onRequest);

  return () => {
    window.removeEventListener("hb:salvage-confirm-request", onRequest);
    if (state.keydownHandler) {
      document.removeEventListener("keydown", state.keydownHandler);
      state.keydownHandler = null;
    }
  };
}

if (typeof window !== "undefined") {
  window.__showSalvageConfirm = show;
  window.__hideSalvageConfirm = hide;
}
