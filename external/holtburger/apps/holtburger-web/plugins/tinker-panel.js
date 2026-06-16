// Tinker panel — gmTinkerUI scaffolding. A two-slot floating panel
// (tool slot + target item slot) that lets the player explicitly stage
// a tinkering operation and fire it with the existing useWithTarget
// (Wave 5.A) wasm primitive. Distinct from tradeskill.js — that plugin
// listens for inventory-to-inventory drag-drop and fires immediately
// with no confirmation, mirroring retail's tool-on-item flow. This
// panel adds an explicit staging UI for users who want to inspect the
// pair before committing (and for cases like context-menu invocation
// where there's no item-on-item drag chain).
//
// Open paths:
//   window.__openTinkerPanel({ toolGuid?, targetGuid? })
//   window.__closeTinkerPanel()
//   window.__toggleTinkerPanel(opts?)
//
// Window events:
//   `hb:tinker-panel-opened`   detail: { toolGuid, targetGuid }
//   `hb:tinker-panel-closed`
//   `hb:tinker-panel-fired`    detail: { toolGuid, targetGuid }
//
// Wire path:
//   GameAction UseWithTarget → ACE Player_Use.HandleActionUseWithTarget
//   → Player_Crafting.UseObjectOnTarget (for tinkering tools). Outcome
//   surfaces as a chat-message (success/failure text) + InventoryChange
//   (target modified). There is no dedicated wire event analogous to
//   SalvageOperationsResult; the panel shows a "dispatched" toast and
//   auto-closes after a brief delay.
//
// References:
//   - plugins/tradeskill.js (sibling — silent drag-drop dispatcher)
//   - plugins/inventory.js:1170 (application/x-hb-inv-guid MIME)
//   - Source/ACE.Server/WorldObjects/Player_Use.cs (HandleActionUseWithTarget)
//   - Source/ACE.Server/WorldObjects/Player_Crafting.cs (UseObjectOnTarget)

import { setAcText } from "../ui/ac_font.js";

const OVERLAY_ID = "hb-tinker-panel";
const STYLE_ID = "hb-tinker-panel-style";
const INV_MIME = "application/x-hb-inv-guid";

const state = {
  overlayEl: null,
  toolSlotEl: null,
  targetSlotEl: null,
  fireBtn: null,
  toastEl: null,
  toolGuid: 0,
  targetGuid: 0,
  client: null,
  unsubInventory: null,
  keydownHandler: null,
  autoCloseTimer: null,
  pendingFire: false,
  warnedMissingSend: false,
};

function ensureStyles() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    #${OVERLAY_ID} {
      position: fixed;
      top: 80px;
      right: 32px;
      width: 320px;
      z-index: 60;
      display: none;
      flex-direction: column;
      font-family: var(--hb-font-serif);
      background: rgba(20, 14, 8, 0.96);
      border: 2px solid var(--hb-border-brass);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.7);
      color: var(--hb-text-cream);
      box-sizing: border-box;
    }
    #${OVERLAY_ID}[data-open="1"] { display: flex; }
    #${OVERLAY_ID} .hb-tk-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 10px;
      background: linear-gradient(180deg, rgba(60, 45, 22, 0.9), rgba(34, 24, 12, 0.9));
      border-bottom: 1px solid var(--hb-border-brass-dim);
    }
    #${OVERLAY_ID} .hb-tk-title {
      color: var(--hb-text-gold);
      font-size: 14px;
      letter-spacing: 0.04em;
      font-weight: 600;
    }
    #${OVERLAY_ID} .hb-tk-close {
      background: transparent;
      border: 1px solid var(--hb-border-brass-dim);
      color: var(--hb-text-cream);
      width: 22px;
      height: 22px;
      line-height: 18px;
      text-align: center;
      cursor: pointer;
      font-family: var(--hb-font-serif);
      font-size: 14px;
      padding: 0;
    }
    #${OVERLAY_ID} .hb-tk-close:hover {
      color: var(--hb-text-gold);
      border-color: var(--hb-border-brass);
    }
    #${OVERLAY_ID} .hb-tk-slots {
      display: grid;
      grid-template-columns: 1fr auto 1fr;
      gap: 10px;
      align-items: center;
      padding: 14px 14px 10px 14px;
    }
    #${OVERLAY_ID} .hb-tk-slot {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      padding: 8px 6px;
      border: 1px dashed var(--hb-border-brass-dim);
      background: rgba(10, 6, 2, 0.5);
      min-height: 64px;
      cursor: pointer;
      transition: background 80ms, border-color 80ms;
    }
    #${OVERLAY_ID} .hb-tk-slot[data-filled="1"] {
      border-style: solid;
      border-color: var(--hb-border-brass);
      background: rgba(40, 28, 16, 0.6);
    }
    #${OVERLAY_ID} .hb-tk-slot[data-drag-over="1"] {
      background: rgba(80, 60, 30, 0.5);
      border-color: var(--hb-text-gold);
    }
    #${OVERLAY_ID} .hb-tk-slot-label {
      font-size: 10px;
      color: var(--hb-text-label);
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }
    #${OVERLAY_ID} .hb-tk-slot-guid {
      font-size: 11px;
      color: var(--hb-text-cream);
      font-variant-numeric: tabular-nums;
      text-align: center;
    }
    #${OVERLAY_ID} .hb-tk-slot-empty {
      font-size: 11px;
      font-style: italic;
      color: var(--hb-text-muted);
      text-align: center;
    }
    #${OVERLAY_ID} .hb-tk-arrow {
      color: var(--hb-text-gold-dim);
      font-size: 18px;
      text-align: center;
      user-select: none;
    }
    #${OVERLAY_ID} .hb-tk-actions {
      display: flex;
      gap: 6px;
      padding: 8px 14px 12px 14px;
      justify-content: flex-end;
    }
    #${OVERLAY_ID} .hb-tk-clear,
    #${OVERLAY_ID} .hb-tk-fire {
      background: linear-gradient(180deg, rgba(60, 44, 24, 0.9) 0%, rgba(40, 28, 16, 0.9) 100%);
      border: 1px solid var(--hb-border-brass);
      color: var(--hb-text-cream);
      font-family: inherit;
      font-size: 12px;
      padding: 4px 14px;
      cursor: pointer;
    }
    #${OVERLAY_ID} .hb-tk-clear:hover:not([disabled]),
    #${OVERLAY_ID} .hb-tk-fire:hover:not([disabled]) {
      background: linear-gradient(180deg, rgba(80, 60, 30, 0.95) 0%, rgba(55, 40, 22, 0.95) 100%);
      color: var(--hb-text-gold);
    }
    #${OVERLAY_ID} .hb-tk-fire[disabled],
    #${OVERLAY_ID} .hb-tk-clear[disabled] {
      opacity: 0.4;
      cursor: not-allowed;
    }
    #${OVERLAY_ID} .hb-tk-toast {
      padding: 6px 14px 10px 14px;
      font-size: 11px;
      color: var(--hb-text-gold);
      text-align: center;
      border-top: 1px solid var(--hb-border-brass-deep);
      background: rgba(10, 6, 2, 0.5);
      display: none;
    }
    #${OVERLAY_ID}[data-toast="1"] .hb-tk-toast { display: block; }
  `;
  document.head.appendChild(s);
}

function makeSlot(role) {
  const slot = document.createElement("div");
  slot.className = "hb-tk-slot";
  slot.dataset.role = role;
  slot.dataset.filled = "0";
  slot.setAttribute("role", "button");
  slot.tabIndex = 0;

  const label = document.createElement("div");
  label.className = "hb-tk-slot-label";
  label.textContent = role === "tool" ? "Tool" : "Target";
  slot.appendChild(label);

  const content = document.createElement("div");
  content.className = "hb-tk-slot-empty";
  content.textContent = "drop item";
  slot.appendChild(content);

  // Drag-drop handlers — accept inventory items via x-hb-inv-guid.
  slot.addEventListener("dragenter", (ev) => {
    if (!ev.dataTransfer?.types?.includes(INV_MIME)) return;
    ev.preventDefault();
    slot.dataset.dragOver = "1";
  });
  slot.addEventListener("dragover", (ev) => {
    if (!ev.dataTransfer?.types?.includes(INV_MIME)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "link";
    slot.dataset.dragOver = "1";
  });
  slot.addEventListener("dragleave", () => {
    slot.dataset.dragOver = "0";
  });
  slot.addEventListener("drop", (ev) => {
    slot.dataset.dragOver = "0";
    const guidStr = ev.dataTransfer?.getData(INV_MIME);
    if (!guidStr) return;
    const guid = parseInt(guidStr, 10) >>> 0;
    if (!guid) return;
    ev.preventDefault();
    setSlotGuid(role, guid);
  });

  // Click to clear when filled.
  slot.addEventListener("click", () => {
    if (slot.dataset.filled === "1") setSlotGuid(role, 0);
  });
  slot.addEventListener("keydown", (ev) => {
    if (ev.key === "Delete" || ev.key === "Backspace") {
      if (slot.dataset.filled === "1") {
        ev.preventDefault();
        setSlotGuid(role, 0);
      }
    }
  });

  return slot;
}

function renderSlot(slot, guid) {
  while (slot.firstChild) slot.removeChild(slot.firstChild);
  const role = slot.dataset.role;
  const label = document.createElement("div");
  label.className = "hb-tk-slot-label";
  label.textContent = role === "tool" ? "Tool" : "Target";
  slot.appendChild(label);
  if (guid) {
    slot.dataset.filled = "1";
    slot.title = "Click to clear";
    const guidEl = document.createElement("div");
    guidEl.className = "hb-tk-slot-guid";
    guidEl.textContent = `0x${guid.toString(16).toUpperCase().padStart(8, "0")}`;
    slot.appendChild(guidEl);
  } else {
    slot.dataset.filled = "0";
    slot.title = "Drag an inventory item here";
    const empty = document.createElement("div");
    empty.className = "hb-tk-slot-empty";
    empty.textContent = "drop item";
    slot.appendChild(empty);
  }
}

function setSlotGuid(role, guid) {
  const g = (guid >>> 0) || 0;
  if (role === "tool") {
    if (g && g === state.targetGuid) return;
    state.toolGuid = g;
    if (state.toolSlotEl) renderSlot(state.toolSlotEl, g);
  } else if (role === "target") {
    if (g && g === state.toolGuid) return;
    state.targetGuid = g;
    if (state.targetSlotEl) renderSlot(state.targetSlotEl, g);
  }
  updateFireBtn();
}

function updateFireBtn() {
  if (!state.fireBtn) return;
  state.fireBtn.disabled = !(state.toolGuid && state.targetGuid);
}

function showToast(text, persist) {
  const overlay = state.overlayEl;
  const toast = state.toastEl;
  if (!overlay || !toast) return;
  setAcText(toast, text);
  overlay.setAttribute("data-toast", "1");
  if (!persist) {
    setTimeout(() => {
      try {
        if (overlay.dataset.toast === "1") overlay.removeAttribute("data-toast");
      } catch (_) {}
    }, 2200);
  }
}

function fireTinker() {
  if (!state.toolGuid || !state.targetGuid) return;
  const tool = state.toolGuid >>> 0;
  const target = state.targetGuid >>> 0;
  const client = state.client ?? window.__pluginClient ?? null;
  const handle = window.__sessionHandle ?? null;
  let sent = false;
  try {
    if (typeof client?.player?.useWithTarget === "function") {
      client.player.useWithTarget(tool, target);
      sent = true;
    } else if (typeof handle?.useWithTarget === "function") {
      handle.useWithTarget(tool, target);
      sent = true;
    }
  } catch (e) {
    console.warn("[tinker-panel] useWithTarget failed:", e);
  }

  if (!sent) {
    if (!state.warnedMissingSend) {
      state.warnedMissingSend = true;
      console.warn("[tinker-panel] no useWithTarget primitive available");
    }
    showToast("No tinker send primitive — outcome unavailable.", true);
    return;
  }

  state.pendingFire = true;
  showToast("Tinker dispatched — watch chat for outcome.", true);
  try {
    window.dispatchEvent(new CustomEvent("hb:tinker-panel-fired", {
      detail: { toolGuid: tool, targetGuid: target },
    }));
  } catch (_) {}

  // Auto-close shortly after dispatch. Outcome surfaces on chat-panel +
  // inventory delta (no dedicated wire event). Leave 1.75s for the
  // toast to be readable before closing.
  if (state.autoCloseTimer) {
    try { clearTimeout(state.autoCloseTimer); } catch (_) {}
  }
  state.autoCloseTimer = setTimeout(() => {
    state.autoCloseTimer = null;
    closePanel();
  }, 1750);
}

function onInventoryChanged() {
  // When the panel is mid-fire and the server acks with an inventory
  // delta, the tinker resolved (or the target was consumed). Switch
  // the toast to a "complete" line. The chat-message side has the
  // actual narrative; we just confirm something happened.
  if (!state.pendingFire) return;
  state.pendingFire = false;
  showToast("Inventory updated — tinker resolved.", true);
}

function ensurePanel() {
  if (state.overlayEl) return state.overlayEl;
  ensureStyles();
  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-label", "Tinker");
  overlay.setAttribute("data-open", "0");
  overlay.tabIndex = -1;

  const header = document.createElement("div");
  header.className = "hb-tk-header";
  const title = document.createElement("div");
  title.className = "hb-tk-title";
  title.textContent = "Tinker";
  header.appendChild(title);
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "hb-tk-close";
  closeBtn.textContent = "×";
  closeBtn.title = "Close";
  closeBtn.addEventListener("click", () => closePanel());
  header.appendChild(closeBtn);
  overlay.appendChild(header);

  const slots = document.createElement("div");
  slots.className = "hb-tk-slots";
  const toolSlot = makeSlot("tool");
  const arrow = document.createElement("div");
  arrow.className = "hb-tk-arrow";
  arrow.textContent = "→";
  const targetSlot = makeSlot("target");
  slots.appendChild(toolSlot);
  slots.appendChild(arrow);
  slots.appendChild(targetSlot);
  overlay.appendChild(slots);

  const actions = document.createElement("div");
  actions.className = "hb-tk-actions";
  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "hb-tk-clear";
  clearBtn.textContent = "Clear";
  clearBtn.addEventListener("click", () => {
    setSlotGuid("tool", 0);
    setSlotGuid("target", 0);
  });
  const fireBtn = document.createElement("button");
  fireBtn.type = "button";
  fireBtn.className = "hb-tk-fire";
  fireBtn.textContent = "Tinker";
  fireBtn.disabled = true;
  fireBtn.addEventListener("click", () => fireTinker());
  actions.appendChild(clearBtn);
  actions.appendChild(fireBtn);
  overlay.appendChild(actions);

  const toast = document.createElement("div");
  toast.className = "hb-tk-toast";
  overlay.appendChild(toast);

  document.body.appendChild(overlay);

  state.overlayEl = overlay;
  state.toolSlotEl = toolSlot;
  state.targetSlotEl = targetSlot;
  state.fireBtn = fireBtn;
  state.toastEl = toast;
  return overlay;
}

export function openPanel(opts) {
  const overlay = ensurePanel();
  state.warnedMissingSend = false;
  state.pendingFire = false;
  if (state.autoCloseTimer) {
    try { clearTimeout(state.autoCloseTimer); } catch (_) {}
    state.autoCloseTimer = null;
  }
  overlay.removeAttribute("data-toast");
  if (state.toastEl) setAcText(state.toastEl, "");
  const toolGuid = (opts?.toolGuid >>> 0) || 0;
  const targetGuid = (opts?.targetGuid >>> 0) || 0;
  state.toolGuid = toolGuid;
  state.targetGuid = targetGuid;
  if (state.toolSlotEl) renderSlot(state.toolSlotEl, toolGuid);
  if (state.targetSlotEl) renderSlot(state.targetSlotEl, targetGuid);
  updateFireBtn();
  overlay.dataset.open = "1";
  if (!state.keydownHandler) {
    state.keydownHandler = (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        closePanel();
      } else if (ev.key === "Enter" && state.toolGuid && state.targetGuid) {
        ev.preventDefault();
        fireTinker();
      }
    };
    overlay.addEventListener("keydown", state.keydownHandler);
  }
  try { overlay.focus({ preventScroll: true }); } catch (_) {}
  try {
    window.dispatchEvent(new CustomEvent("hb:tinker-panel-opened", {
      detail: { toolGuid, targetGuid },
    }));
  } catch (_) {}
}

export function closePanel() {
  const overlay = state.overlayEl;
  if (!overlay) return;
  if (overlay.dataset.open !== "1") return;
  overlay.dataset.open = "0";
  if (state.keydownHandler) {
    overlay.removeEventListener("keydown", state.keydownHandler);
    state.keydownHandler = null;
  }
  if (state.autoCloseTimer) {
    try { clearTimeout(state.autoCloseTimer); } catch (_) {}
    state.autoCloseTimer = null;
  }
  state.pendingFire = false;
  try {
    window.dispatchEvent(new CustomEvent("hb:tinker-panel-closed"));
  } catch (_) {}
}

export const manifest = {
  id: "tinker-panel",
  name: "Tinker",
  icon: "🔧",
  iconHidden: true,
  version: "0.1.0",
  description: "Tinker panel — two-slot staging UI for useWithTarget; gmTinkerUI scaffolding (no dedicated outcome event yet)",
};

export function mount(ctx) {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return () => {};
  }
  ensureStyles();
  const client = ctx?.client ?? window.__pluginClient ?? null;
  state.client = client;

  // Track inventory change as a proxy for tinker resolution (no
  // dedicated GameEventUseWithTargetResult on the wire).
  let unsub = null;
  try {
    if (typeof client?.events?.on === "function") {
      unsub = client.events.on("playerInventoryChanged", onInventoryChanged);
    }
  } catch (e) {
    console.warn("[tinker-panel] playerInventoryChanged subscribe failed:", e);
  }
  state.unsubInventory = unsub;

  return () => {
    try {
      if (typeof state.unsubInventory === "function") state.unsubInventory();
      else if (state.unsubInventory?.off) state.unsubInventory.off();
    } catch (_) {}
    state.unsubInventory = null;
    state.client = null;
  };
}

if (typeof window !== "undefined") {
  window.__openTinkerPanel = openPanel;
  window.__closeTinkerPanel = closePanel;
  window.__toggleTinkerPanel = (opts) => {
    if (state.overlayEl?.dataset.open === "1") closePanel();
    else openPanel(opts);
  };
}
