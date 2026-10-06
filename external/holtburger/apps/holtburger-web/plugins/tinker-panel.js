// Tinker panel — a two-slot staging window (tool → target) that fires the
// existing useWithTarget primitive.
//
// HUD overhaul 2026-10-05 — rebuilt on the shared HUD kit.
//
// Retail has no tinkering WINDOW: you drag the salvage bag (or tool) onto
// the item, the client asks for confirmation and sends UseWithTarget
// (tradeskill.js mirrors that silent drag path). This panel is the modern
// convenience on top: two big kit slots you can drop onto — "Use" (the
// salvage / tool) and "On" (the item being worked) — with the items' icons
// and names (never hex ids), an Apply button, and a status line that
// follows the outcome (dispatch → inventory change). Draggable, persisted
// (synthetic window id 0xFFFF0020, no retail layout exists), Esc closes.
//
// Wire path: GameAction UseWithTarget → ACE Player_Use.HandleActionUseWithTarget
// → Player_Crafting.UseObjectOnTarget. There is no dedicated result event;
// the narrative arrives in chat and the target changes in inventory.
//
// Open paths:
//   window.__openTinkerPanel({ toolGuid?, targetGuid? })
//   window.__closeTinkerPanel()
//   window.__toggleTinkerPanel(opts?)
// Window events: hb:tinker-panel-opened {toolGuid,targetGuid},
//   hb:tinker-panel-closed, hb:tinker-panel-fired {toolGuid,targetGuid}

import { setAcText } from "../ui/ac_font.js";
import { DropItemFlags } from "./drop_item_flags.js";
import {
  createKitWindow, COMMERCE_WINDOW_ID, KIT_COLOR, kitButton, fillSlotIcon,
  wireDropTarget, inventoryRows, objectDisplayName, objectIconId,
} from "./commerce_window.js";

const OVERLAY_ID = "hb-tinker-panel";
const STYLE_ID = "hb-tinker-panel-style";

const state = {
  win: null,
  refs: null,
  toolGuid: 0,
  targetGuid: 0,
  client: null,
  unsubInventory: null,
  pendingFire: false,
  warnedMissingSend: false,
};

function ensureStyles() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    #${OVERLAY_ID} { width: 340px; }
    #${OVERLAY_ID} .htk-slots {
      display: grid; grid-template-columns: minmax(0, 1fr) 28px minmax(0, 1fr);
      align-items: start; gap: 4px; padding: 10px 10px 6px;
    }
    #${OVERLAY_ID} .htk-target {
      display: flex; flex-direction: column; align-items: center; gap: 4px;
      padding: 6px 4px 8px; min-height: 104px;
      cursor: pointer;
    }
    #${OVERLAY_ID} .htk-target .hbk-slot { width: 48px; height: 48px; }
    #${OVERLAY_ID} .htk-target.is-drop-target .hbk-slot { box-shadow: 0 0 0 1px var(--hbk-gold-bright), 0 0 8px rgba(243, 210, 122, 0.6); }
    #${OVERLAY_ID} .htk-role { min-height: 14px; }
    #${OVERLAY_ID} .htk-name {
      width: 100%; min-height: 28px; text-align: center;
      color: var(--hbk-text); font-size: 12px; line-height: 14px;
      overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    }
    #${OVERLAY_ID} .htk-name.is-empty { color: var(--hbk-text-faint); font-style: italic; font-size: 11px; }
    #${OVERLAY_ID} .htk-arrow {
      align-self: center; margin-top: -10px;
      color: var(--hbk-gold); font-size: 20px; text-align: center; text-shadow: 0 1px 0 #000;
    }
    #${OVERLAY_ID} .htk-status { padding: 2px 10px 6px; min-height: 30px; color: var(--hbk-text-dim); font-size: 11px; line-height: 13px; }
    #${OVERLAY_ID} .htk-status.is-good { color: var(--hbk-value); }
    #${OVERLAY_ID} .htk-status.is-bad { color: var(--hbk-warn); }
  `;
  document.head.appendChild(s);
}

function el(tag, cls, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
}

function makeTarget(parent, role) {
  const box = el("div", "htk-target hb-cw-drop", parent);
  box.dataset.role = role;
  box.tabIndex = 0;
  box.setAttribute("role", "button");
  const roleEl = el("div", "htk-role", box);
  setAcText(roleEl, role === "tool" ? "Use" : "On", { color: KIT_COLOR.gold });
  const slot = el("div", "hbk-slot", box);
  const name = el("div", "htk-name", box);
  wireDropTarget(box, DropItemFlags.CONTAINER, (guid) => setFromDrop(role, guid));
  box.addEventListener("click", () => {
    if ((role === "tool" ? state.toolGuid : state.targetGuid)) setSlotGuid(role, 0);
  });
  box.addEventListener("keydown", (ev) => {
    if ((ev.key === "Delete" || ev.key === "Backspace")) {
      ev.preventDefault();
      setSlotGuid(role, 0);
    }
  });
  return { box, slot, name };
}

function setFromDrop(role, guid) {
  const g = guid >>> 0;
  const item = inventoryRows().find((r) => r.guid === g);
  if (!item) {
    state.win?.toast("You can only tinker with items you are carrying", "err");
    return;
  }
  const other = role === "tool" ? state.targetGuid : state.toolGuid;
  if (g === other) {
    state.win?.toast("Pick two different items", "err");
    return;
  }
  setSlotGuid(role, g);
}

function renderTarget(t, guid, role) {
  if (guid) {
    const name = objectDisplayName(guid);
    fillSlotIcon(t.slot, objectIconId(guid), name);
    t.name.textContent = name;
    t.name.classList.remove("is-empty");
    t.box.title = `${name} — click to clear`;
  } else {
    fillSlotIcon(t.slot, 0, " ");
    t.name.textContent = role === "tool" ? "Drop the salvage or tool here" : "Drop the item to work on here";
    t.name.classList.add("is-empty");
    t.box.title = "Drag an item from your pack here";
  }
}

function setStatus(text, kind = "") {
  const r = state.refs;
  if (!r) return;
  r.status.textContent = text;
  r.status.classList.toggle("is-good", kind === "good");
  r.status.classList.toggle("is-bad", kind === "bad");
}

function setSlotGuid(role, guid) {
  const g = (guid >>> 0) || 0;
  if (role === "tool") {
    if (g && g === state.targetGuid) return;
    state.toolGuid = g;
    if (state.refs) renderTarget(state.refs.tool, g, "tool");
  } else {
    if (g && g === state.toolGuid) return;
    state.targetGuid = g;
    if (state.refs) renderTarget(state.refs.target, g, "target");
  }
  state.pendingFire = false;
  updateButtons();
}

function updateButtons() {
  const r = state.refs;
  if (!r) return;
  const ready = !!(state.toolGuid && state.targetGuid);
  r.fireBtn.disabled = !ready;
  r.clearBtn.disabled = !(state.toolGuid || state.targetGuid);
  if (!state.pendingFire) {
    setStatus(ready
      ? `Apply ${objectDisplayName(state.toolGuid)} to ${objectDisplayName(state.targetGuid)}.`
      : "Drag the salvage or tool into Use, and the item to improve into On.");
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
    setStatus("Tinkering is not available right now.", "bad");
    return;
  }
  state.pendingFire = true;
  setStatus("Working… the outcome appears in chat.", "");
  try {
    window.dispatchEvent(new CustomEvent("hb:tinker-panel-fired", { detail: { toolGuid: tool, targetGuid: target } }));
  } catch (_) {}
}

function onInventoryChanged() {
  // The server acks a resolved tinker with an inventory delta (tool
  // consumed / target modified). Refresh the slots: a consumed tool
  // leaves its slot.
  if (!state.pendingFire) return;
  state.pendingFire = false;
  const owned = new Set(inventoryRows().map((r) => r.guid));
  if (state.toolGuid && !owned.has(state.toolGuid)) setSlotGuid("tool", 0);
  if (state.targetGuid && !owned.has(state.targetGuid)) setSlotGuid("target", 0);
  if (state.refs?.target && state.targetGuid) renderTarget(state.refs.target, state.targetGuid, "target");
  setStatus("Done — see chat for the result.", "good");
}

function ensurePanel() {
  if (state.win) return state.win;
  ensureStyles();
  const win = createKitWindow({
    id: OVERLAY_ID,
    title: "Tinkering",
    windowId: COMMERCE_WINDOW_ID.TINKER,
    defaultPos: {
      left: "auto", bottom: "auto",
      right: `max(4px, min(316px, calc(100 * var(--hb-hud-vw, 1vw) - 348px)))`,
      top: `max(4px, min(200px, calc(100 * var(--hb-hud-vh, 1vh) - 220px)))`,
    },
    className: "hb-tinker",
    onHide: () => {
      state.pendingFire = false;
      try { window.dispatchEvent(new CustomEvent("hb:tinker-panel-closed")); } catch (_) {}
    },
  });
  state.win = win;
  const slots = el("div", "htk-slots", win.body);
  const tool = makeTarget(slots, "tool");
  const arrow = el("div", "htk-arrow", slots);
  arrow.textContent = "→";
  const target = makeTarget(slots, "target");
  const status = el("div", "htk-status", win.body);
  const footer = el("div", "hbk-footer", win.body);
  const clearBtn = kitButton("Clear", "hbk-btn-small", () => {
    setSlotGuid("tool", 0);
    setSlotGuid("target", 0);
  });
  const fireBtn = kitButton("Apply", "hbk-btn", () => fireTinker());
  fireBtn.title = "Use the left item on the right item (Enter)";
  footer.appendChild(clearBtn);
  footer.appendChild(fireBtn);
  win.root.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && state.toolGuid && state.targetGuid && !ev.target?.closest?.("button")) {
      ev.preventDefault();
      fireTinker();
    }
  });
  state.refs = { tool, target, status, clearBtn, fireBtn };
  return win;
}

export function openPanel(opts) {
  const win = ensurePanel();
  state.warnedMissingSend = false;
  state.pendingFire = false;
  state.toolGuid = 0;
  state.targetGuid = 0;
  setSlotGuid("tool", (opts?.toolGuid >>> 0) || 0);
  setSlotGuid("target", (opts?.targetGuid >>> 0) || 0);
  win.open();
  try {
    window.dispatchEvent(new CustomEvent("hb:tinker-panel-opened", {
      detail: { toolGuid: state.toolGuid, targetGuid: state.targetGuid },
    }));
  } catch (_) {}
}

export function closePanel() {
  if (!state.win?.isOpen()) return;
  state.win.close();
}

export const manifest = {
  id: "tinker-panel",
  name: "Tinker",
  icon: "🔧",
  iconHidden: true,
  version: "0.2.0",
  description: "Tinkering window — two-slot staging (Use → On) for useWithTarget",
};

export function mount(ctx) {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return () => {};
  }
  ensureStyles();
  const client = ctx?.client ?? window.__pluginClient ?? null;
  state.client = client;
  try {
    client?.events?.on?.("playerInventoryChanged", onInventoryChanged);
    state.unsubInventory = () => client?.events?.off?.("playerInventoryChanged", onInventoryChanged);
  } catch (e) {
    console.warn("[tinker-panel] playerInventoryChanged subscribe failed:", e);
  }
  return () => {
    try { state.unsubInventory?.(); } catch (_) {}
    state.unsubInventory = null;
    state.client = null;
  };
}

if (typeof window !== "undefined") {
  window.__openTinkerPanel = openPanel;
  window.__closeTinkerPanel = closePanel;
  window.__toggleTinkerPanel = (opts) => {
    if (state.win?.isOpen()) closePanel();
    else openPanel(opts);
  };
}
