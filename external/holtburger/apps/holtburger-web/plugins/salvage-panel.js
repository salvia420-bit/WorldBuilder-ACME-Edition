// Salvage panel — floating, item-list-based scaffold for the
// gmSalvageUI flow. Opens when something invokes
// `window.__openSalvagePanel(toolGuid)` (typically a tinkering-tool
// `useObject` from inventory), accumulates a list of items the player
// has selected, fires a single batch salvage operation, and surfaces
// the per-material `SalvageOperationsResult` event as a results toast.
//
// Receive-side: SG-C2 (index.html:10278) decodes
// GameEventSalvageOperationsResult kind=52 and emits
// `client.events.salvageResult` with { skill, augBonus, results }.
// This plugin subscribes via the plugin-client bus.
//
// Send-side: ACE's GameActionCreateTinkeringTool (opcode 0x027D, see
// Source/ACE.Server/Network/GameAction/Actions/GameActionCreateTinkeringTool.cs)
// takes (u32 toolGuid, u32 count, u32[] itemGuids) and dispatches to
// Player_Crafting.HandleSalvaging. A matching wasm export is not yet
// wired; the salvage button falls back to per-item useWithTarget as a
// best-effort, with a one-shot console warning when neither primitive
// is available — same pattern as tradeskill.js.
//
// Open/close globals exposed for index.html boot wiring and external
// invokers (inventory `useObject` on a tinkering tool, picking, etc.):
//   window.__openSalvagePanel(toolGuid)
//   window.__closeSalvagePanel()
//   window.__toggleSalvagePanel(toolGuid?)
//
// Window events:
//   `hb:salvage-panel-opened`   detail: { toolGuid }
//   `hb:salvage-panel-closed`
//   `hb:salvage-panel-add-item` detail: { itemGuid, label? }
//
// References:
//   - acclient.txt gmSalvageUI (Wave 6.D backlog scaffolding)
//   - Source/ACE.Entity/Enum/MaterialType.cs (0x01–0x4D)
//   - Source/ACE.Server/WorldObjects/Player_Crafting.cs:142
//     HandleSalvaging(tool, items)
//   - index.html:10278 SG-C2 SalvageOperationsResult decode

import { setAcText } from "../ui/ac_font.js";

const OVERLAY_ID = "hb-salvage-panel";
const STYLE_ID = "hb-salvage-panel-style";

// MaterialType enum (ACE.Entity.Enum.MaterialType). Values 0x00–0x4D
// match the on-wire u32 in SalvageOperationsResult.stringPayload
// (decoded at index.html:10288 as the leading "<material>:..." token).
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

function materialName(id) {
  return MATERIAL_NAMES[id >>> 0] ?? `Material 0x${(id >>> 0).toString(16).toUpperCase()}`;
}

// ─── Per-item appraisal read-through (material/workmanship/value) ──
//
// Gap-analysis addition: the retail salvage panel shows a per-item
// material/workmanship/value summary before the player commits. The
// ONLY source of that data on this client is the AppraisalSnapshot
// `handle.getObjectAppraisal(guid)` already surfaces for tooltips/
// examine (see examine-target.js, inventory_helpers.js's
// formatAppraisalTooltip) — `properties.ints.MaterialType` (key 131),
// `.ItemWorkmanship` (105), `.Value` (19). It is populated once the
// item has actually been appraised (Identify round-trip); an
// un-appraised item simply has no snapshot yet, so the row omits the
// meta/value line entirely for that item rather than guessing.
//
// NOT available anywhere in this client: the predicted salvage YIELD
// (units of material a given item will actually produce). That
// calculation lives server-authoritatively and, client-side, only in
// `crates/holtburger-world/src/crafting/salvage.rs`
// (`predict_salvage_preview` / `SalvageItemInput`) — that module is
// not wired to a wasm export (no `sessionhandle_*` binding calls it),
// so JS has no way to invoke it. Per the "no invented fields" rule,
// this panel does NOT fabricate an estimated-units figure; it shows
// the item's own appraised Value (in pyreals) instead, which retail
// also surfaces on the item's tooltip. If/when a preview export lands,
// wire true predicted-units here instead of Value.
function getAppraisalIntsFor(guid) {
  try {
    const handle = window.__sessionHandle ?? window.__pluginClient?._handle ?? null;
    if (typeof handle?.getObjectAppraisal !== "function") return null;
    const json = handle.getObjectAppraisal(guid >>> 0);
    if (typeof json !== "string" || json.length === 0) return null;
    const snapshot = JSON.parse(json);
    return snapshot?.properties?.ints ?? null;
  } catch (_) {
    return null;
  }
}

const state = {
  overlayEl: null,
  listEl: null,
  emptyEl: null,
  countEl: null,
  toastListEl: null,
  totalRowEl: null,
  totalLabelEl: null,
  totalValueEl: null,
  fireBtn: null,
  closeBtn: null,
  toolGuid: 0,
  items: /** @type {{guid:number,label?:string}[]} */ ([]),
  unsubscribeSalvage: null,
  client: null,
  keydownHandler: null,
  autoCloseTimer: null,
  warnedMissingSend: false,
  awaitingConfirm: false,
};

// ─── Module-scoped one-warning flag ─────────────────────────────
// Same pattern as tradeskill.js: log a missing wasm-send warning at
// most once per session, then silently no-op.

function ensureStyles() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    #${OVERLAY_ID} {
      position: fixed;
      top: 60px;
      right: 32px;
      width: 360px;
      max-height: 520px;
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
    #${OVERLAY_ID} .hb-sv-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 10px;
      background: linear-gradient(180deg, rgba(60, 45, 22, 0.9), rgba(34, 24, 12, 0.9));
      border-bottom: 1px solid var(--hb-border-brass-dim);
      flex: 0 0 auto;
    }
    #${OVERLAY_ID} .hb-sv-title {
      color: var(--hb-text-gold);
      font-size: 14px;
      letter-spacing: 0.04em;
      font-weight: 600;
    }
    #${OVERLAY_ID} .hb-sv-close {
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
    #${OVERLAY_ID} .hb-sv-close:hover {
      color: var(--hb-text-gold);
      border-color: var(--hb-border-brass);
    }
    #${OVERLAY_ID} .hb-sv-tool {
      padding: 4px 10px;
      font-size: 10px;
      color: var(--hb-text-label);
      background: rgba(0, 0, 0, 0.25);
      border-bottom: 1px solid var(--hb-border-brass-deep);
      flex: 0 0 auto;
      font-variant-numeric: tabular-nums;
    }
    #${OVERLAY_ID} .hb-sv-list {
      flex: 1 1 auto;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 4px 6px;
      min-height: 80px;
    }
    #${OVERLAY_ID} .hb-sv-empty {
      color: var(--hb-text-muted-2);
      font-style: italic;
      font-size: 12px;
      text-align: center;
      padding: 28px 12px;
    }
    #${OVERLAY_ID} .hb-sv-row {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px;
      padding: 3px 6px;
      border-bottom: 1px solid rgba(120, 90, 50, 0.18);
      font-size: 11px;
    }
    #${OVERLAY_ID} .hb-sv-row-label {
      flex: 1 1 auto;
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--hb-text-cream);
    }
    #${OVERLAY_ID} .hb-sv-row-meta {
      flex: 1 1 100%;
      order: 3;
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--hb-text-muted);
      font-size: 10px;
      font-variant-numeric: tabular-nums;
      padding-left: 2px;
    }
    #${OVERLAY_ID} .hb-sv-row-value {
      flex: 0 0 auto;
      color: var(--hb-text-gold);
      font-size: 10px;
      font-variant-numeric: tabular-nums;
    }
    #${OVERLAY_ID} .hb-sv-row-guid {
      flex: 0 0 auto;
      color: var(--hb-text-muted);
      font-size: 10px;
      font-variant-numeric: tabular-nums;
    }
    #${OVERLAY_ID} .hb-sv-total {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      padding: 4px 10px;
      font-size: 11px;
      color: var(--hb-text-cream);
      background: rgba(0, 0, 0, 0.2);
      border-top: 1px solid var(--hb-border-brass-dim);
      flex: 0 0 auto;
    }
    #${OVERLAY_ID} .hb-sv-total-label {
      color: var(--hb-text-muted);
      font-size: 10px;
    }
    #${OVERLAY_ID} .hb-sv-total-value {
      color: var(--hb-text-gold);
      font-variant-numeric: tabular-nums;
    }
    #${OVERLAY_ID} .hb-sv-row-rm {
      flex: 0 0 auto;
      background: transparent;
      border: 1px solid var(--hb-border-brass-dim);
      color: var(--hb-text-cream);
      font-family: inherit;
      font-size: 10px;
      padding: 0 4px;
      cursor: pointer;
    }
    #${OVERLAY_ID} .hb-sv-row-rm:hover {
      color: var(--hb-text-gold);
      border-color: var(--hb-border-brass);
    }
    #${OVERLAY_ID} .hb-sv-actions {
      display: flex;
      gap: 6px;
      padding: 6px 10px;
      border-top: 1px solid var(--hb-border-brass-deep);
      background: rgba(0, 0, 0, 0.25);
      flex: 0 0 auto;
    }
    #${OVERLAY_ID} .hb-sv-count {
      flex: 1 1 auto;
      font-size: 10px;
      color: var(--hb-text-muted);
      align-self: center;
      font-variant-numeric: tabular-nums;
    }
    #${OVERLAY_ID} .hb-sv-fire {
      background: linear-gradient(180deg, rgba(60, 44, 24, 0.9) 0%, rgba(40, 28, 16, 0.9) 100%);
      border: 1px solid var(--hb-border-brass);
      color: var(--hb-text-cream);
      font-family: inherit;
      font-size: 12px;
      padding: 4px 12px;
      cursor: pointer;
    }
    #${OVERLAY_ID} .hb-sv-fire:hover:not([disabled]) {
      background: linear-gradient(180deg, rgba(80, 60, 30, 0.95) 0%, rgba(55, 40, 22, 0.95) 100%);
      color: var(--hb-text-gold);
    }
    #${OVERLAY_ID} .hb-sv-fire[disabled] {
      opacity: 0.4;
      cursor: not-allowed;
    }
    #${OVERLAY_ID} .hb-sv-results {
      max-height: 140px;
      overflow-y: auto;
      padding: 4px 10px;
      border-top: 1px solid var(--hb-border-brass-dim);
      background: rgba(10, 6, 2, 0.5);
      flex: 0 0 auto;
      display: none;
    }
    #${OVERLAY_ID}[data-results="1"] .hb-sv-results { display: block; }
    #${OVERLAY_ID} .hb-sv-toast {
      padding: 3px 0;
      font-size: 11px;
      color: var(--hb-text-gold);
      border-bottom: 1px solid rgba(180, 140, 60, 0.18);
      font-variant-numeric: tabular-nums;
    }
    #${OVERLAY_ID} .hb-sv-toast:last-child { border-bottom: none; }
    #${OVERLAY_ID} .hb-sv-list::-webkit-scrollbar,
    #${OVERLAY_ID} .hb-sv-results::-webkit-scrollbar { width: 8px; }
    #${OVERLAY_ID} .hb-sv-list::-webkit-scrollbar-track,
    #${OVERLAY_ID} .hb-sv-results::-webkit-scrollbar-track {
      background: rgba(0, 0, 0, 0.4);
    }
    #${OVERLAY_ID} .hb-sv-list::-webkit-scrollbar-thumb,
    #${OVERLAY_ID} .hb-sv-results::-webkit-scrollbar-thumb {
      background: var(--hb-border-brass-deep);
      border: 1px solid var(--hb-border-brass-dim);
    }
  `;
  document.head.appendChild(s);
}

function ensurePanel() {
  if (state.overlayEl) return state.overlayEl;
  ensureStyles();

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-label", "Salvage");
  overlay.setAttribute("data-open", "0");
  overlay.tabIndex = -1;

  const header = document.createElement("div");
  header.className = "hb-sv-header";
  const title = document.createElement("div");
  title.className = "hb-sv-title";
  title.textContent = "Salvage";
  header.appendChild(title);
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "hb-sv-close";
  closeBtn.textContent = "×";
  closeBtn.title = "Close";
  closeBtn.addEventListener("click", () => closePanel());
  header.appendChild(closeBtn);
  overlay.appendChild(header);

  const toolRow = document.createElement("div");
  toolRow.className = "hb-sv-tool";
  toolRow.textContent = "Tool: —";
  overlay.appendChild(toolRow);

  const listEl = document.createElement("div");
  listEl.className = "hb-sv-list";
  const emptyEl = document.createElement("div");
  emptyEl.className = "hb-sv-empty";
  emptyEl.textContent = "Drop items here to add them to the salvage queue.";
  listEl.appendChild(emptyEl);
  overlay.appendChild(listEl);

  // Running-total row — sum of appraised item Value across the queue.
  // Hidden (no rows / nothing appraised yet) until renderList() has
  // something to show; see updateTotalRow().
  const totalRow = document.createElement("div");
  totalRow.className = "hb-sv-total";
  totalRow.style.display = "none";
  const totalLabel = document.createElement("div");
  totalLabel.className = "hb-sv-total-label";
  const totalValue = document.createElement("div");
  totalValue.className = "hb-sv-total-value";
  totalRow.appendChild(totalLabel);
  totalRow.appendChild(totalValue);
  overlay.appendChild(totalRow);

  const actions = document.createElement("div");
  actions.className = "hb-sv-actions";
  const count = document.createElement("div");
  count.className = "hb-sv-count";
  count.textContent = "0 items";
  const fireBtn = document.createElement("button");
  fireBtn.type = "button";
  fireBtn.className = "hb-sv-fire";
  fireBtn.textContent = "Salvage";
  fireBtn.disabled = true;
  fireBtn.addEventListener("click", () => fireSalvage());
  actions.appendChild(count);
  actions.appendChild(fireBtn);
  overlay.appendChild(actions);

  const results = document.createElement("div");
  results.className = "hb-sv-results";
  overlay.appendChild(results);

  document.body.appendChild(overlay);

  state.overlayEl = overlay;
  state.listEl = listEl;
  state.emptyEl = emptyEl;
  state.countEl = count;
  state.fireBtn = fireBtn;
  state.closeBtn = closeBtn;
  state.toastListEl = results;
  state.totalRowEl = totalRow;
  state.totalLabelEl = totalLabel;
  state.totalValueEl = totalValue;
  return overlay;
}

function setToolDisplay() {
  const overlay = state.overlayEl;
  if (!overlay) return;
  const toolRow = overlay.querySelector(".hb-sv-tool");
  if (!toolRow) return;
  if (state.toolGuid) {
    setAcText(toolRow, `Tool: 0x${state.toolGuid.toString(16).toUpperCase().padStart(8, "0")}`);
  } else {
    setAcText(toolRow, "Tool: —");
  }
}

// Builds the per-item "material · workmanship" secondary line + the
// right-aligned appraised-value chip from a live AppraisalSnapshot.
// Returns { metaText, value } where either half may be null when the
// underlying property isn't present in the snapshot yet — the caller
// omits whatever half is missing rather than rendering a placeholder
// number. `value` is the item's own appraised `Value` (pyreals), NOT
// a predicted salvage yield (see getAppraisalIntsFor's doc comment —
// that figure has no wasm export to source it from).
function describeItemAppraisal(guid) {
  const ints = getAppraisalIntsFor(guid);
  if (!ints) return { metaText: null, value: null };
  const bits = [];
  const mat = ints.MaterialType;
  if (mat != null) bits.push(materialName(mat));
  const wkm = Number(ints.ItemWorkmanship);
  if (Number.isFinite(wkm) && wkm > 0) bits.push(`Wkm ${wkm}`);
  const val = Number(ints.Value);
  return {
    metaText: bits.length > 0 ? bits.join(" · ") : null,
    value: Number.isFinite(val) ? val : null,
  };
}

function updateTotalRow(appraisedCount, totalValue) {
  const row = state.totalRowEl;
  if (!row) return;
  if (state.items.length === 0) {
    row.style.display = "none";
    return;
  }
  row.style.display = "flex";
  if (state.totalLabelEl) {
    const suffix = appraisedCount < state.items.length
      ? ` (${appraisedCount}/${state.items.length} appraised)`
      : "";
    setAcText(state.totalLabelEl, `Est. value${suffix}`, { fit: true });
  }
  if (state.totalValueEl) {
    setAcText(state.totalValueEl, `${totalValue}p`, { fit: true });
  }
}

function renderList() {
  const listEl = state.listEl;
  if (!listEl) return;
  while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
  let totalValue = 0;
  let appraisedCount = 0;
  if (state.items.length === 0) {
    listEl.appendChild(state.emptyEl);
  } else {
    for (let i = 0; i < state.items.length; i++) {
      const it = state.items[i];
      const row = document.createElement("div");
      row.className = "hb-sv-row";
      const labelEl = document.createElement("div");
      labelEl.className = "hb-sv-row-label";
      labelEl.textContent = it.label || `Item 0x${it.guid.toString(16).toUpperCase().padStart(8, "0")}`;
      const guidEl = document.createElement("div");
      guidEl.className = "hb-sv-row-guid";
      guidEl.textContent = `0x${it.guid.toString(16).toUpperCase().padStart(8, "0")}`;
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "hb-sv-row-rm";
      rm.textContent = "×";
      rm.title = "Remove";
      rm.addEventListener("click", () => removeItem(i));
      row.appendChild(labelEl);
      row.appendChild(guidEl);
      row.appendChild(rm);

      // Material/workmanship/value summary — sourced from the live
      // AppraisalSnapshot (see describeItemAppraisal). Un-appraised
      // items (no Examine round-trip yet) get no meta line and don't
      // count toward the running total, rather than a fabricated "0".
      const { metaText, value } = describeItemAppraisal(it.guid);
      if (metaText || value != null) {
        const metaEl = document.createElement("div");
        metaEl.className = "hb-sv-row-meta";
        const parts = [];
        if (metaText) parts.push(metaText);
        setAcText(metaEl, parts.join(" · "), { fit: true });
        row.appendChild(metaEl);
      }
      if (value != null) {
        const valueEl = document.createElement("div");
        valueEl.className = "hb-sv-row-value";
        setAcText(valueEl, `${value}p`, { fit: true });
        row.appendChild(valueEl);
        totalValue += value;
        appraisedCount++;
      }
      listEl.appendChild(row);
    }
  }
  if (state.countEl) {
    setAcText(state.countEl, `${state.items.length} item${state.items.length === 1 ? "" : "s"}`);
  }
  if (state.fireBtn) {
    state.fireBtn.disabled = state.items.length === 0 || !state.toolGuid;
  }
  updateTotalRow(appraisedCount, totalValue);
}

export function addItem(itemGuid, label) {
  const g = (itemGuid >>> 0);
  if (!g) return;
  if (state.items.some((it) => it.guid === g)) return;
  state.items.push({ guid: g, label });
  renderList();
}

function removeItem(idx) {
  if (idx < 0 || idx >= state.items.length) return;
  state.items.splice(idx, 1);
  renderList();
}

function appendResultToast(material, units, workmanship) {
  const list = state.toastListEl;
  const overlay = state.overlayEl;
  if (!list || !overlay) return;
  overlay.setAttribute("data-results", "1");
  const row = document.createElement("div");
  row.className = "hb-sv-toast";
  const wkText = Number.isFinite(workmanship) && workmanship > 0
    ? ` · workmanship ${workmanship.toFixed(2)}`
    : "";
  row.textContent = `${units} × ${materialName(material)}${wkText}`;
  list.appendChild(row);
  list.scrollTop = list.scrollHeight;
}

function onSalvageResult(detail) {
  if (!state.overlayEl || state.overlayEl.dataset.open !== "1") return;
  const results = Array.isArray(detail?.results) ? detail.results : [];
  if (results.length === 0) return;
  for (const r of results) {
    appendResultToast(r.material >>> 0, r.units | 0, Number(r.workmanship));
  }
  // Auto-close on salvage success — let the user see the toast briefly,
  // then dismiss. Re-open is a fresh panel.
  if (state.autoCloseTimer) {
    try { clearTimeout(state.autoCloseTimer); } catch (_) {}
  }
  state.autoCloseTimer = setTimeout(() => {
    state.autoCloseTimer = null;
    closePanel();
  }, 1750);
}

// R12: the actual destructive send-ladder, now taking explicit args so it can
// be invoked only after the salvage-confirm bus returns a "confirm".
function commitSalvage(tool, itemGuids) {
  const client = state.client ?? window.__pluginClient ?? null;
  const handle = window.__sessionHandle ?? null;
  let sent = false;

  // Preferred: batched send via dedicated wasm export. Neither shape
  // exists today; the fallback below approximates per-item until
  // GameActionCreateTinkeringTool (0x027D) is exposed.
  try {
    if (typeof client?.player?.salvageItems === "function") {
      client.player.salvageItems(tool, itemGuids);
      sent = true;
    } else if (typeof handle?.createTinkeringTool === "function") {
      handle.createTinkeringTool(tool, itemGuids);
      sent = true;
    } else if (typeof client?.player?.useWithTarget === "function") {
      for (const item of itemGuids) {
        client.player.useWithTarget(item, tool);
      }
      sent = true;
    } else if (typeof handle?.useWithTarget === "function") {
      for (const item of itemGuids) {
        handle.useWithTarget(item, tool);
      }
      sent = true;
    }
  } catch (e) {
    console.warn("[salvage-panel] fire failed:", e);
  }

  if (!sent && !state.warnedMissingSend) {
    state.warnedMissingSend = true;
    console.warn("[salvage-panel] no salvage send primitive available (need wasm salvageItems / createTinkeringTool export)");
  }

  // Server reply lands on `salvageResult`; the listener calls
  // appendResultToast + schedules auto-close. If the call did not
  // dispatch, leave the panel open so the user can retry.
}

// R12: fireSalvage now emits a confirmation REQUEST instead of sending. The
// salvage-confirm bus shows the modal; onConfirmResult (mount) commits only on
// an explicit "confirm". If the bus is absent the catch commits directly so the
// flow never dead-ends.
function fireSalvage() {
  if (state.items.length === 0 || !state.toolGuid) return;
  const tool = state.toolGuid >>> 0;
  const items = state.items.map((it) => ({ guid: it.guid >>> 0, label: it.label }));
  state.awaitingConfirm = true;
  try {
    window.dispatchEvent(new CustomEvent("hb:salvage-confirm-request", {
      detail: {
        toolGuid: tool,
        toolLabel: `0x${tool.toString(16).toUpperCase().padStart(8, "0")}`,
        items,
      },
    }));
  } catch (_) {
    state.awaitingConfirm = false;
    commitSalvage(tool, items.map((i) => i.guid));
  }
}

export function openPanel(toolGuid) {
  const overlay = ensurePanel();
  state.toolGuid = (toolGuid >>> 0) || 0;
  state.items = [];
  state.warnedMissingSend = false;
  state.awaitingConfirm = false;
  if (state.autoCloseTimer) {
    try { clearTimeout(state.autoCloseTimer); } catch (_) {}
    state.autoCloseTimer = null;
  }
  overlay.removeAttribute("data-results");
  if (state.toastListEl) {
    while (state.toastListEl.firstChild) {
      state.toastListEl.removeChild(state.toastListEl.firstChild);
    }
  }
  setToolDisplay();
  renderList();
  overlay.dataset.open = "1";
  if (!state.keydownHandler) {
    state.keydownHandler = (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        closePanel();
      }
    };
    overlay.addEventListener("keydown", state.keydownHandler);
  }
  try { overlay.focus({ preventScroll: true }); } catch (_) {}
  try {
    window.dispatchEvent(new CustomEvent("hb:salvage-panel-opened", {
      detail: { toolGuid: state.toolGuid },
    }));
  } catch (_) {}
}

export function closePanel() {
  const overlay = state.overlayEl;
  if (!overlay) return;
  if (overlay.dataset.open !== "1") return;
  overlay.dataset.open = "0";
  state.awaitingConfirm = false;
  if (state.keydownHandler) {
    overlay.removeEventListener("keydown", state.keydownHandler);
    state.keydownHandler = null;
  }
  if (state.autoCloseTimer) {
    try { clearTimeout(state.autoCloseTimer); } catch (_) {}
    state.autoCloseTimer = null;
  }
  try {
    window.dispatchEvent(new CustomEvent("hb:salvage-panel-closed"));
  } catch (_) {}
}

export const manifest = {
  id: "salvage-panel",
  name: "Salvage",
  icon: "⚒",
  iconHidden: true,
  version: "0.1.0",
  description: "Salvage panel — collect items, fire batch salvage, surface material results (scaffold; needs CreateTinkeringTool wasm export to fully wire)",
};

export function mount(ctx) {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return () => {};
  }
  ensureStyles();
  const client = ctx?.client ?? window.__pluginClient ?? null;
  state.client = client;

  // Subscribe to the SG-C2 salvageResult event surfaced by
  // index.html:10297. Defensive try/catch around the unsubscribe
  // return — some bus shapes return the unsubscribe directly, some
  // return an `{ off }` object.
  let unsub = null;
  try {
    const handler = (detail) => onSalvageResult(detail);
    if (typeof client?.events?.on === "function") {
      unsub = client.events.on("salvageResult", handler);
    }
  } catch (e) {
    console.warn("[salvage-panel] salvageResult subscribe failed:", e);
  }
  state.unsubscribeSalvage = unsub;

  function onAddItemEvent(ev) {
    const d = ev?.detail ?? {};
    addItem(d.itemGuid, d.label);
  }
  window.addEventListener("hb:salvage-panel-add-item", onAddItemEvent);

  // R12: commit only after the salvage-confirm bus returns a "confirm",
  // guarded by awaitingConfirm so a stray result can't fire a phantom send.
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
    try {
      if (typeof state.unsubscribeSalvage === "function") state.unsubscribeSalvage();
      else if (state.unsubscribeSalvage?.off) state.unsubscribeSalvage.off();
    } catch (_) {}
    state.unsubscribeSalvage = null;
    state.client = null;
  };
}

if (typeof window !== "undefined") {
  window.__openSalvagePanel = openPanel;
  window.__closeSalvagePanel = closePanel;
  window.__toggleSalvagePanel = (toolGuid) => {
    if (state.overlayEl?.dataset.open === "1") closePanel();
    else openPanel(toolGuid ?? state.toolGuid);
  };
  window.__addSalvagePanelItem = addItem;
}
