// Salvage panel — the Salvage window (retail gmSalvageUI, layout 0x2100000C).
//
// HUD overhaul 2026-10-05 — rebuilt on the shared HUD kit.
//
// Retail: an 800×110 strip with "WARNING: Items in this panel will be
// destroyed!" across the top, a 32-px item list with a rope scrollbar, the
// red 64×22 Salvage button (0x06004C4C) and the close (0x060012AA). It is
// opened by USING a salvaging tool (UsingItem → SendNotice_OpenSalvagePanel,
// gmSalvageUI::OpenSalvagePanel remembers the tool id), filled by dragging
// items onto it, and gmSalvageUI::Salvage sends
// CM_Inventory::Event_CreateTinkeringTool(tool, items) then FLUSHES the list
// and stays open for the next batch.
//
// Ours: a draggable kit window docked just left of the main panel (so
// inventory → salvage drags are short) with the retail warning line, the
// tool you are using (icon + name, never a hex id), a drop well listing each
// item with its icon, material · workmanship and appraised value, the
// running total, a Results section for the SalvageOperationsResult reply
// ("12 × Iron (workmanship 5.42)"), and Clear List / Salvage in the footer.
// Dropping a pack adds its contents (gmSalvageUI::AddNewItem →
// _AddContainedItems). After a confirmed salvage the list flushes and the
// window stays open, like retail.
//
// Receive-side: index.html's SG-C2 decode of GameEventSalvageOperationsResult
// emits `client.events.salvageResult` { skill, augBonus, results }.
// Send-side ladder (unchanged): client.player.salvageItems → wasm
// createTinkeringTool(tool, Uint32Array items) (GameAction 0x027D) →
// per-item useWithTarget fallback. Destructive sends go through the
// salvage-confirm modal first (R12: `hb:salvage-confirm-request` →
// `hb:salvage-confirm-result`).
//
// Globals (index.html / inventory.js wiring):
//   window.__openSalvagePanel(toolGuid)   window.__closeSalvagePanel()
//   window.__toggleSalvagePanel(toolGuid?) window.__addSalvagePanelItem(guid, label?)
// Window events: hb:salvage-panel-opened {toolGuid}, hb:salvage-panel-closed,
//   hb:salvage-panel-add-item {itemGuid, label?} (inbound).

import { setAcText } from "../ui/ac_font.js";
import { DropItemFlags } from "./drop_item_flags.js";
import {
  createKitWindow, COMMERCE_WINDOW_ID, KIT_COLOR, kitButton, fillSlotIcon,
  wireDropTarget, inventoryRows, objectDisplayName, objectIconId,
} from "./commerce_window.js";
import { fmtNumber } from "./commerce_logic.js";

const OVERLAY_ID = "hb-salvage-panel";
const STYLE_ID = "hb-salvage-panel-style";
const ITEM_TYPE_CONTAINER = 0x00000200;

// MaterialType enum (ACE.Entity.Enum.MaterialType), 0x01–0x4D.
const MATERIAL_NAMES = Object.freeze({
  0x00: "Unknown",
  0x01: "Ceramic", 0x02: "Porcelain",
  0x03: "Cloth", 0x04: "Linen", 0x05: "Satin", 0x06: "Silk",
  0x07: "Velvet", 0x08: "Wool",
  0x09: "Gem", 0x0A: "Agate", 0x0B: "Amber", 0x0C: "Amethyst",
  0x0D: "Aquamarine", 0x0E: "Azurite", 0x0F: "Black Garnet",
  0x10: "Black Opal", 0x11: "Bloodstone", 0x12: "Carnelian",
  0x13: "Citrine", 0x14: "Diamond", 0x15: "Emerald",
  0x16: "Fire Opal", 0x17: "Green Garnet", 0x18: "Green Jade",
  0x19: "Hematite", 0x1A: "Imperial Topaz", 0x1B: "Jet",
  0x1C: "Lapis Lazuli", 0x1D: "Lavender Jade", 0x1E: "Malachite",
  0x1F: "Moonstone", 0x20: "Onyx", 0x21: "Opal", 0x22: "Peridot",
  0x23: "Red Garnet", 0x24: "Red Jade", 0x25: "Rose Quartz",
  0x26: "Ruby", 0x27: "Sapphire", 0x28: "Smokey Quartz",
  0x29: "Sunstone", 0x2A: "Tiger Eye", 0x2B: "Tourmaline",
  0x2C: "Turquoise", 0x2D: "White Jade", 0x2E: "White Quartz",
  0x2F: "White Sapphire", 0x30: "Yellow Garnet",
  0x31: "Yellow Topaz", 0x32: "Zircon",
  0x33: "Ivory", 0x34: "Leather", 0x35: "Armoredillo Hide",
  0x36: "Gromnie Hide", 0x37: "Reed Shark Hide",
  0x38: "Metal", 0x39: "Brass", 0x3A: "Bronze", 0x3B: "Copper",
  0x3C: "Gold", 0x3D: "Iron", 0x3E: "Pyreal", 0x3F: "Silver",
  0x40: "Steel",
  0x41: "Stone", 0x42: "Alabaster", 0x43: "Granite",
  0x44: "Marble", 0x45: "Obsidian", 0x46: "Sandstone",
  0x47: "Serpentine",
  0x48: "Wood", 0x49: "Ebony", 0x4A: "Mahogany", 0x4B: "Oak",
  0x4C: "Pine", 0x4D: "Teak",
});

export function materialName(id) {
  return MATERIAL_NAMES[id >>> 0] ?? "Unknown material";
}

// Per-item appraisal read-through (material / workmanship / value). Only
// populated once the item has been appraised (Identify round-trip); an
// un-appraised item shows "Not yet appraised" instead of a guessed number.
// The predicted salvage YIELD lives server-side (and in
// crates/holtburger-world/src/crafting/salvage.rs, not exported to JS), so
// it is deliberately not invented here.
function getAppraisalIntsFor(guid) {
  try {
    const handle = window.__sessionHandle ?? window.__pluginClient?._handle ?? null;
    if (typeof handle?.getObjectAppraisal !== "function") return null;
    const json = handle.getObjectAppraisal(guid >>> 0);
    if (typeof json !== "string" || json.length === 0) return null;
    return JSON.parse(json)?.properties?.ints ?? null;
  } catch (_) {
    return null;
  }
}

function describeItemAppraisal(guid) {
  const ints = getAppraisalIntsFor(guid);
  if (!ints) return { metaText: null, value: null };
  const bits = [];
  if (ints.MaterialType != null) bits.push(materialName(ints.MaterialType));
  const wkm = Number(ints.ItemWorkmanship);
  if (Number.isFinite(wkm) && wkm > 0) bits.push(`workmanship ${wkm}`);
  const val = Number(ints.Value);
  return {
    metaText: bits.length ? bits.join(" · ") : null,
    value: Number.isFinite(val) ? val : null,
  };
}

const state = {
  win: null,
  refs: null,
  toolGuid: 0,
  items: /** @type {{guid:number,label?:string,iconId?:number}[]} */ ([]),
  results: [],
  client: null,
  unsubscribeSalvage: null,
  warnedMissingSend: false,
  awaitingConfirm: false,
};

function ensureStyles() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    #${OVERLAY_ID} { width: 420px; }
    #${OVERLAY_ID} .hsv-warning { padding: 5px 8px 2px; min-height: 16px; }
    #${OVERLAY_ID} .hb-cw-body > .hbk-divider { margin: 2px 8px; }
    #${OVERLAY_ID} .hsv-tool { display: flex; align-items: center; gap: 8px; padding: 4px 8px; }
    #${OVERLAY_ID} .hsv-tool-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
    #${OVERLAY_ID} .hsv-well { margin: 2px 8px; height: 156px; min-height: 64px; flex: 1 1 auto; overflow-y: auto; }
    #${OVERLAY_ID} .hsv-row { min-height: 30px; gap: 6px; }
    #${OVERLAY_ID} .hsv-row .hbk-slot { width: 24px; height: 24px; flex: 0 0 24px; }
    #${OVERLAY_ID} .hsv-row-text { display: flex; flex-direction: column; min-width: 0; flex: 1 1 auto; }
    #${OVERLAY_ID} .hsv-row-meta { font-size: 10px; color: var(--hbk-text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #${OVERLAY_ID} .hsv-row-meta.is-unknown { color: var(--hbk-text-faint); font-style: italic; }
    #${OVERLAY_ID} .hsv-row-value { flex: 0 0 auto; }
    #${OVERLAY_ID} .hsv-row .hbk-icon-btn { width: 18px; height: 18px; font-size: 12px; }
    #${OVERLAY_ID} .hsv-results { margin: 4px 8px 0; display: none; }
    #${OVERLAY_ID} .hsv-results.is-on { display: block; }
    #${OVERLAY_ID} .hsv-results-list { max-height: 72px; overflow-y: auto; padding: 2px 6px; }
    #${OVERLAY_ID} .hsv-result { padding: 1px 0; color: var(--hbk-value); font-size: 12px; }
    #${OVERLAY_ID} .hsv-summary { flex: 1 1 auto; min-width: 0; color: var(--hbk-text-dim); font-size: 11px; }
  `;
  document.head.appendChild(s);
}

function el(tag, cls, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
}

function ensurePanel() {
  if (state.win) return state.win;
  ensureStyles();
  const win = createKitWindow({
    id: OVERLAY_ID,
    title: "Salvage",
    windowId: COMMERCE_WINDOW_ID.SALVAGE,
    // Just left of the 300-px main panel (inventory) so drags are short.
    defaultPos: {
      left: "auto", bottom: "auto",
      right: `max(4px, min(316px, calc(100 * var(--hb-hud-vw, 1vw) - 428px)))`,
      top: `max(4px, min(160px, calc(100 * var(--hb-hud-vh, 1vh) - 300px)))`,
    },
    className: "hb-salvage",
    onHide: () => {
      state.awaitingConfirm = false;
      try { window.dispatchEvent(new CustomEvent("hb:salvage-panel-closed")); } catch (_) {}
    },
  });
  state.win = win;
  const body = win.body;

  // Retail SalvageWarning_Text.
  const warning = el("div", "hsv-warning", body);
  setAcText(warning, "WARNING: Items in this panel will be destroyed!", { color: KIT_COLOR.warn, fit: true });

  const toolRow = el("div", "hsv-tool", body);
  const toolSlot = el("div", "hbk-slot", toolRow);
  const toolText = el("div", "hsv-tool-text", toolRow);
  const toolName = el("div", "", toolText);
  const toolHint = el("div", "hbk-muted", toolText);
  toolHint.style.fontSize = "11px";

  el("div", "hbk-divider", body);

  const well = el("div", "hsv-well hbk-scroll hb-cw-drop", body);

  const results = el("div", "hsv-results", body);
  const resultsTitle = el("div", "hbk-section-title", results);
  setAcText(resultsTitle, "Results", { color: KIT_COLOR.gold });
  const resultsList = el("div", "hsv-results-list hbk-scroll", results);

  const footer = el("div", "hbk-footer", body);
  const summary = el("div", "hsv-summary", footer);
  const clearBtn = kitButton("Clear List", "hbk-btn-small", () => { state.items = []; renderList(); });
  footer.appendChild(clearBtn);
  const fireBtn = kitButton("Salvage", "hbk-btn", () => fireSalvage());
  fireBtn.disabled = true;
  footer.appendChild(fireBtn);

  const onDrop = (guid) => addFromDrop(guid);
  wireDropTarget(well, DropItemFlags.SALVAGE, onDrop);
  wireDropTarget(win.root, DropItemFlags.SALVAGE, onDrop);

  state.refs = { toolSlot, toolName, toolHint, well, results, resultsList, summary, clearBtn, fireBtn };
  return win;
}

function renderTool() {
  const r = state.refs;
  if (!r) return;
  if (state.toolGuid) {
    const name = objectDisplayName(state.toolGuid, "Salvaging tool");
    fillSlotIcon(r.toolSlot, objectIconId(state.toolGuid), name);
    setAcText(r.toolName, `Using: ${name}`, { color: KIT_COLOR.gold, fit: true });
    r.toolHint.textContent = "Drag items or whole packs from your inventory below.";
  } else {
    fillSlotIcon(r.toolSlot, 0, "?");
    setAcText(r.toolName, "No salvaging tool", { color: KIT_COLOR.dim, fit: true });
    r.toolHint.textContent = "Use a salvaging tool from your pack to start.";
  }
}

function renderList() {
  const r = state.refs;
  if (!r) return;
  r.well.replaceChildren();
  let totalValue = 0;
  let appraised = 0;
  if (state.items.length === 0) {
    const hint = el("div", "hb-cw-hint", r.well);
    hint.textContent = state.toolGuid
      ? "Drag items from your pack here to salvage them."
      : "Use a salvaging tool to begin.";
  } else {
    const list = el("div", "hbk-list", r.well);
    state.items.forEach((it, i) => {
      const row = el("div", "hbk-row hsv-row", list);
      const slot = el("div", "hbk-slot", row);
      const name = it.label || objectDisplayName(it.guid);
      fillSlotIcon(slot, it.iconId || objectIconId(it.guid), name);
      const text = el("div", "hsv-row-text", row);
      const nm = el("div", "", text);
      setAcText(nm, name, { color: KIT_COLOR.text, fit: true });
      const meta = el("div", "hsv-row-meta", text);
      const { metaText, value } = describeItemAppraisal(it.guid);
      if (metaText) meta.textContent = metaText;
      else { meta.textContent = "Not yet appraised"; meta.classList.add("is-unknown"); }
      if (value != null) {
        const v = el("div", "hsv-row-value", row);
        setAcText(v, `${fmtNumber(value)} p`, { color: KIT_COLOR.gold });
        totalValue += value;
        appraised += 1;
      }
      const rm = el("button", "hbk-icon-btn", row);
      rm.type = "button";
      rm.textContent = "×";
      rm.title = "Take this item back out";
      rm.addEventListener("click", (ev) => { ev.stopPropagation(); removeItem(i); });
      row.title = name;
    });
  }
  const n = state.items.length;
  let summary = n ? `${n} item${n === 1 ? "" : "s"}` : "Nothing to salvage";
  if (n && appraised) {
    summary += ` · value ${fmtNumber(totalValue)} p`;
    if (appraised < n) summary += ` (${appraised}/${n} appraised)`;
  }
  r.summary.textContent = summary;
  r.fireBtn.disabled = n === 0 || !state.toolGuid;
  r.clearBtn.disabled = n === 0;
}

export function addItem(itemGuid, label, iconId) {
  const g = (itemGuid >>> 0);
  if (!g || g === state.toolGuid) return;
  if (state.items.some((it) => it.guid === g)) return;
  state.items.push({ guid: g, label, iconId: iconId >>> 0 });
  renderList();
}

// Drag-in path with retail gmSalvageUI::DragItemAcceptable rules.
function addFromDrop(guid) {
  if (!state.toolGuid) {
    state.win?.toast("Use a salvaging tool first", "err");
    return;
  }
  const inv = inventoryRows();
  const item = inv.find((i) => i.guid === (guid >>> 0));
  if (!item) {
    state.win?.toast("You can only salvage items that you own!", "err");
    return;
  }
  if (item.guid === state.toolGuid) return;
  if ((item.equipMask >>> 0) !== 0) {
    state.win?.toast(`Unequip ${item.name} before salvaging it`, "err");
    return;
  }
  // A pack adds its contents (gmSalvageUI::_AddContainedItems).
  if ((item.itemType & ITEM_TYPE_CONTAINER) !== 0) {
    const contents = inv.filter((i) => i.containerId === item.guid && i.equipMask === 0 && i.guid !== state.toolGuid);
    if (contents.length === 0) {
      state.win?.toast(`${item.name} is empty`, "err");
      return;
    }
    for (const c of contents) addItem(c.guid, c.name, c.iconId);
    state.win?.toast(`Added the contents of ${item.name}`);
    return;
  }
  addItem(item.guid, item.name, item.iconId);
}

function removeItem(idx) {
  if (idx < 0 || idx >= state.items.length) return;
  state.items.splice(idx, 1);
  renderList();
}

function appendResult(material, units, workmanship) {
  const r = state.refs;
  if (!r) return;
  const wk = Number.isFinite(workmanship) && workmanship > 0 ? ` (workmanship ${workmanship.toFixed(2)})` : "";
  const line = `${fmtNumber(units)} × ${materialName(material)}${wk}`;
  state.results.push(line);
  r.results.classList.add("is-on");
  const row = el("div", "hsv-result", r.resultsList);
  row.textContent = `You obtain ${line}`;
  r.resultsList.scrollTop = r.resultsList.scrollHeight;
}

function onSalvageResult(detail) {
  if (!state.win?.isOpen()) return;
  const results = Array.isArray(detail?.results) ? detail.results : [];
  for (const r of results) appendResult(r.material >>> 0, r.units | 0, Number(r.workmanship));
}

// R12: the destructive send-ladder, only after the confirm modal returns
// "confirm". gmSalvageUI::Salvage then flushes the list and keeps the
// window open for the next batch.
function commitSalvage(tool, itemGuids) {
  const client = state.client ?? window.__pluginClient ?? null;
  const handle = window.__sessionHandle ?? null;
  let sent = false;
  try {
    if (typeof client?.player?.salvageItems === "function") {
      client.player.salvageItems(tool, itemGuids);
      sent = true;
    } else if (typeof handle?.createTinkeringTool === "function") {
      handle.createTinkeringTool(tool, Uint32Array.from(itemGuids));
      sent = true;
    } else if (typeof client?.player?.useWithTarget === "function") {
      for (const item of itemGuids) client.player.useWithTarget(item, tool);
      sent = true;
    } else if (typeof handle?.useWithTarget === "function") {
      for (const item of itemGuids) handle.useWithTarget(item, tool);
      sent = true;
    }
  } catch (e) {
    console.warn("[salvage-panel] fire failed:", e);
  }
  if (!sent) {
    if (!state.warnedMissingSend) {
      state.warnedMissingSend = true;
      console.warn("[salvage-panel] no salvage send primitive available (need wasm salvageItems / createTinkeringTool export)");
    }
    state.win?.toast("Salvaging is not available right now", "err");
    return;
  }
  const sentSet = new Set(itemGuids.map((g) => g >>> 0));
  state.items = state.items.filter((it) => !sentSet.has(it.guid));
  renderList();
  state.win?.toast("Salvaging…");
}

function fireSalvage() {
  if (state.items.length === 0 || !state.toolGuid) return;
  const tool = state.toolGuid >>> 0;
  const items = state.items.map((it) => ({ guid: it.guid >>> 0, label: it.label || objectDisplayName(it.guid) }));
  state.awaitingConfirm = true;
  try {
    window.dispatchEvent(new CustomEvent("hb:salvage-confirm-request", {
      detail: { toolGuid: tool, toolLabel: objectDisplayName(tool, "salvaging tool"), items },
    }));
  } catch (_) {
    state.awaitingConfirm = false;
    commitSalvage(tool, items.map((i) => i.guid));
  }
}

export function openPanel(toolGuid) {
  const win = ensurePanel();
  // gmSalvageUI::OpenSalvagePanel — remember the tool, flush the list.
  state.toolGuid = (toolGuid >>> 0) || 0;
  state.items = [];
  state.results = [];
  state.warnedMissingSend = false;
  state.awaitingConfirm = false;
  state.refs.resultsList.replaceChildren();
  state.refs.results.classList.remove("is-on");
  renderTool();
  renderList();
  win.open();
  try {
    window.dispatchEvent(new CustomEvent("hb:salvage-panel-opened", { detail: { toolGuid: state.toolGuid } }));
  } catch (_) {}
}

export function closePanel() {
  if (!state.win?.isOpen()) return;
  state.win.close();
}

export const manifest = {
  id: "salvage-panel",
  name: "Salvage",
  icon: "⚒",
  iconHidden: true,
  version: "0.2.0",
  description: "Salvage window — drag items in, confirm, see the material results (gmSalvageUI)",
};

export function mount(ctx) {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return () => {};
  }
  ensureStyles();
  const client = ctx?.client ?? window.__pluginClient ?? null;
  state.client = client;

  // The plugin bus dispatches a CustomEvent — the payload is ev.detail.
  // (Pre-2026-10-05 this read `.results` off the Event itself, so the
  // material results never reached the window.)
  const onResult = (ev) => onSalvageResult(ev?.detail ?? ev);
  try {
    client?.events?.on?.("salvageResult", onResult);
    state.unsubscribeSalvage = () => client?.events?.off?.("salvageResult", onResult);
  } catch (e) {
    console.warn("[salvage-panel] salvageResult subscribe failed:", e);
  }

  function onAddItemEvent(ev) {
    const d = ev?.detail ?? {};
    addItem(d.itemGuid, d.label);
  }
  window.addEventListener("hb:salvage-panel-add-item", onAddItemEvent);

  // R12: commit only after the salvage-confirm bus returns "confirm".
  function onConfirmResult(ev) {
    const d = ev?.detail ?? {};
    if (!state.awaitingConfirm) return;
    state.awaitingConfirm = false;
    if (d.kind !== "confirm") return;
    const items = (Array.isArray(d.items) ? d.items : [])
      .map((it) => (it.guid >>> 0)).filter(Boolean);
    if (!items.length || !(d.toolGuid >>> 0)) return;
    commitSalvage(d.toolGuid >>> 0, items);
  }
  window.addEventListener("hb:salvage-confirm-result", onConfirmResult);

  return () => {
    window.removeEventListener("hb:salvage-panel-add-item", onAddItemEvent);
    window.removeEventListener("hb:salvage-confirm-result", onConfirmResult);
    try { state.unsubscribeSalvage?.(); } catch (_) {}
    state.unsubscribeSalvage = null;
    state.client = null;
  };
}

if (typeof window !== "undefined") {
  window.__openSalvagePanel = openPanel;
  window.__closeSalvagePanel = closePanel;
  window.__toggleSalvagePanel = (toolGuid) => {
    if (state.win?.isOpen()) closePanel();
    else openPanel(toolGuid ?? state.toolGuid);
  };
  window.__addSalvagePanelItem = addItem;
}
