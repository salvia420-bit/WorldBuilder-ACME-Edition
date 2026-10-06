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

// HUD overhaul 2026-10-05 — wears the shared retail DialogBox chrome
// (`.hb-dlg`, plugins/modal-dialog.js) with kit buttons, a gold divider
// and a scrolling item list; Enter confirms / Esc cancels (and no longer
// leak to the game), Tab / ←→ cycle the buttons, and an unnamed item
// reads "an unnamed item" instead of a raw 0x… guid.
import { ensureDialogChromeStyles } from "./modal-dialog.js";

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
  ensureDialogChromeStyles();
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    #${OVERLAY_ID} { z-index: 70; max-width: min(380px, calc(94 * var(--hb-hud-vw, 1vw))); }
    #${OVERLAY_ID} .hb-sc-item-list {
      flex: 0 1 auto;
      min-height: 0;
      max-height: 120px;
      margin: 6px 0 0;
      padding: 2px 0;
      list-style: none;
      border: 1px solid var(--hbk-gold-deep, #4e3f1f);
      background: rgba(0, 0, 0, 0.35);
      font-size: 11px;
    }
    #${OVERLAY_ID} .hb-sc-item-list > li { min-height: 16px; padding: 0 6px; }
    #${OVERLAY_ID} .hb-sc-warn {
      margin-top: 8px;
      color: var(--hbk-warn, #ff6a50);
      font-size: 11px;
      font-style: italic;
      text-align: center;
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
  restoreFocusEl: null,
};

function itemName(it) {
  const label = typeof it?.label === "string" ? it.label.trim() : "";
  return label || "an unnamed item";
}

function renderBody(toolLabel, items) {
  if (!state.bodyEl || !state.itemListEl) return;
  while (state.itemListEl.firstChild) state.itemListEl.removeChild(state.itemListEl.firstChild);
  const toolName = toolLabel ? toolLabel : "the salvage tool";
  if (items.length === 1) {
    const it = items[0];
    const name = itemName(it);
    state.bodyEl.textContent =
      `Apply ${toolName} to ${name}? The item will be destroyed.`;
    state.itemListEl.style.display = "none";
  } else if (items.length > 1) {
    state.bodyEl.textContent =
      `Apply ${toolName} to these ${items.length} items? They will be destroyed.`;
    state.itemListEl.style.display = "";
    for (const it of items) {
      const li = document.createElement("li");
      li.textContent = itemName(it);
      li.className = "hbk-row";
      state.itemListEl.appendChild(li);
    }
  } else {
    state.bodyEl.textContent = `Salvage with ${toolName}?`;
    state.itemListEl.style.display = "none";
  }
}

function ensurePopup() {
  if (state.overlayEl) return state.overlayEl;
  ensureStyles();
  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.className = "hb-dlg";
  overlay.setAttribute("role", "alertdialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Confirm salvage");
  overlay.setAttribute("data-open", "0");
  overlay.tabIndex = -1;

  const title = document.createElement("div");
  title.className = "hb-dlg-title";
  title.textContent = "Confirm Salvage";
  overlay.appendChild(title);

  const divider = document.createElement("div");
  divider.className = "hbk-divider";
  overlay.appendChild(divider);

  const body = document.createElement("div");
  body.className = "hb-dlg-msg hb-sc-body";
  overlay.appendChild(body);

  const list = document.createElement("ul");
  list.className = "hb-sc-item-list hbk-list hbk-scroll";
  overlay.appendChild(list);

  const warn = document.createElement("div");
  warn.className = "hb-sc-warn";
  warn.textContent = "Salvaged items are consumed.";
  overlay.appendChild(warn);

  const row = document.createElement("div");
  row.className = "hb-dlg-actions hb-sc-row";
  const okBtn = document.createElement("button");
  okBtn.type = "button";
  okBtn.className = "hbk-btn hb-sc-btn";
  okBtn.dataset.action = "confirm";
  okBtn.textContent = "Salvage";
  okBtn.addEventListener("click", () => dispatch({ type: "confirm" }));
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "hbk-btn hb-sc-btn";
  cancelBtn.dataset.action = "cancel";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => dispatch({ type: "cancel" }));
  row.appendChild(okBtn);
  row.appendChild(cancelBtn);
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
  const restore = state.restoreFocusEl;
  state.restoreFocusEl = null;
  try {
    if (restore && restore.isConnected) restore.focus({ preventScroll: true });
    else if (state.overlayEl?.contains(document.activeElement)) document.activeElement.blur();
  } catch (_) {}

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
        ev.stopPropagation();
        dispatch({ type: "cancel" });
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        ev.stopPropagation();
        // Enter confirms — unless the player tabbed onto Cancel.
        dispatch({ type: document.activeElement === state.cancelBtn ? "cancel" : "confirm" });
      } else if (ev.key === "Tab" || ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
        ev.preventDefault();
        ev.stopPropagation();
        const next = document.activeElement === state.okBtn ? state.cancelBtn : state.okBtn;
        try { next?.focus({ preventScroll: true }); } catch (_) {}
      }
    };
    // Capture phase so Enter/Esc never reach the chat / game handlers.
    document.addEventListener("keydown", state.keydownHandler, true);
  }
  try {
    const ae = document.activeElement;
    state.restoreFocusEl = (ae && ae !== document.body && !state.overlayEl?.contains(ae)) ? ae : null;
  } catch (_) { state.restoreFocusEl = null; }
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
  version: "0.2.0",
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
      document.removeEventListener("keydown", state.keydownHandler, true);
      state.keydownHandler = null;
    }
  };
}

if (typeof window !== "undefined") {
  window.__showSalvageConfirm = show;
  window.__hideSalvageConfirm = hide;
}
