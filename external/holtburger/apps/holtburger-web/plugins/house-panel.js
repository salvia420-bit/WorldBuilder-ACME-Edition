// House panel — MVP send-side housing.
//
// Wave M-1 (2026-05-26): 4 send-side opcodes — BuyHouse (0x021C),
// HouseQuery (0x021E), AbandonHouse (0x021F), RentHouse (0x0221).
// Empty payload for Query/Abandon; Buy/Rent take slumlord guid +
// PackableList<uint> of payment-item guids.
//
// Guest perms / storage perms / boot / list-available are deferred
// to a future wave. So is the receive-side HouseProfile (0x021D) /
// HouseData (0x0225) snapshot — `Query My House` fires the request;
// the response surfaces in chat / kind=… events but isn't rendered
// here yet.
//
// UX MVP (per PR scope): user manually types the slumlord GUID + a
// comma-separated list of item GUIDs. A proper slumlord-NPC picker +
// inventory-item picker is Wave M+.
//
// Exposes:
//   window.__openHousePanel()
//   window.__closeHousePanel()

import { setAcText } from "../ui/ac_font.js";

const OVERLAY_ID = "hb-house-panel";
const STYLE_ID = "hb-house-panel-style";

let overlayEl = null;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    #${OVERLAY_ID} {
      position: fixed;
      top: 80px;
      left: 50%;
      transform: translateX(-50%);
      width: 340px;
      max-height: 80vh;
      z-index: 70;
      display: none;
      pointer-events: auto;
      font-family: var(--hb-font-serif);
      color: var(--hb-text-cream);
      background: rgba(20, 14, 8, 0.94);
      border: 1px solid var(--hb-border-brass);
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.6);
      user-select: none;
      box-sizing: border-box;
      flex-direction: column;
    }
    #${OVERLAY_ID}[data-open="1"] { display: flex; }
    #${OVERLAY_ID} .hbhp-header {
      flex: 0 0 22px;
      display: flex;
      align-items: center;
      padding: 0 6px 0 8px;
      background: var(--hb-overlay-active);
      border-bottom: 1px solid var(--hb-border-brass);
      color: var(--hb-text-gold);
      font-size: 12px;
      letter-spacing: 0.02em;
    }
    #${OVERLAY_ID} .hbhp-title {
      flex: 1 1 auto;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      text-shadow: 0 1px 0 rgba(0,0,0,.85);
    }
    #${OVERLAY_ID} .hbhp-close {
      flex: 0 0 auto;
      background: transparent;
      border: 1px solid var(--hb-border-brass-dim);
      color: var(--hb-text-cream);
      font-family: inherit;
      font-size: 10px;
      line-height: 1;
      padding: 1px 6px;
      cursor: pointer;
    }
    #${OVERLAY_ID} .hbhp-close:hover {
      background: var(--hb-overlay-hover);
      color: var(--hb-text-cream-bright);
      border-color: var(--hb-border-brass);
    }
    #${OVERLAY_ID} .hbhp-body {
      flex: 1 1 auto;
      overflow-y: auto;
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    #${OVERLAY_ID} .hbhp-section {
      border: 1px solid var(--hb-border-brass-dim);
      background: rgba(0, 0, 0, 0.25);
      padding: 6px 8px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    #${OVERLAY_ID} .hbhp-section-title {
      color: var(--hb-text-gold);
      font-size: 12px;
      letter-spacing: 0.02em;
      text-shadow: 0 1px 0 rgba(0,0,0,.85);
      margin-bottom: 2px;
    }
    #${OVERLAY_ID} .hbhp-row {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    #${OVERLAY_ID} .hbhp-row label {
      flex: 0 0 96px;
      font-size: 11px;
      color: var(--hb-text-cream);
    }
    #${OVERLAY_ID} .hbhp-row input {
      flex: 1 1 auto;
      background: rgba(0, 0, 0, 0.45);
      border: 1px solid var(--hb-border-brass-dim);
      color: var(--hb-text-cream-bright);
      font-family: monospace;
      font-size: 11px;
      padding: 3px 5px;
      min-width: 0;
    }
    #${OVERLAY_ID} .hbhp-row input:focus {
      border-color: var(--hb-text-gold);
      outline: none;
    }
    #${OVERLAY_ID} .hbhp-btn {
      background: transparent;
      border: 1px solid var(--hb-border-brass-dim);
      color: var(--hb-text-cream);
      font-family: inherit;
      font-size: 11px;
      padding: 5px 10px;
      cursor: pointer;
      align-self: flex-end;
      margin-top: 2px;
    }
    #${OVERLAY_ID} .hbhp-btn:hover {
      background: var(--hb-overlay-hover);
      border-color: var(--hb-border-brass);
      color: var(--hb-text-cream-bright);
    }
    #${OVERLAY_ID} .hbhp-btn-danger {
      border-color: rgba(180, 60, 40, 0.6);
      color: #e8a890;
    }
    #${OVERLAY_ID} .hbhp-btn-danger:hover {
      background: rgba(80, 20, 10, 0.4);
      border-color: rgba(220, 90, 60, 0.9);
      color: #ffd5c0;
    }
    #${OVERLAY_ID} .hbhp-placeholder {
      font-size: 10.5px;
      color: var(--hb-text-dim, #7a6b50);
      font-style: italic;
      padding: 4px 6px;
      border-top: 1px solid var(--hb-border-brass-dim);
      margin-top: 2px;
    }
  `;
  document.head.appendChild(s);
}

function parseGuid(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  // Accept 0x-prefixed hex or plain decimal.
  const n = s.startsWith("0x") || s.startsWith("0X")
    ? parseInt(s.slice(2), 16)
    : parseInt(s, 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return n >>> 0;
}

function parseGuidList(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return [];
  const out = [];
  for (const part of s.split(",")) {
    const g = parseGuid(part);
    if (g === null) return null;
    out.push(g);
  }
  return out;
}

function getHandle() {
  return window.__sessionHandle ?? window.__pluginClient?.handle ?? null;
}

function makeSection(titleText) {
  const section = document.createElement("div");
  section.className = "hbhp-section";
  const title = document.createElement("div");
  title.className = "hbhp-section-title";
  setAcText(title, titleText, { color: "#f0c87c" });
  section.appendChild(title);
  return section;
}

function makeInputRow(labelText, placeholder, defaultValue) {
  const row = document.createElement("div");
  row.className = "hbhp-row";
  const label = document.createElement("label");
  setAcText(label, labelText);
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = placeholder;
  input.value = defaultValue ?? "";
  input.spellcheck = false;
  input.autocomplete = "off";
  row.appendChild(label);
  row.appendChild(input);
  return { row, input };
}

function buildPanel() {
  ensureStyles();
  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;

  const header = document.createElement("div");
  header.className = "hbhp-header";
  const title = document.createElement("div");
  title.className = "hbhp-title";
  setAcText(title, "House", { color: "#f0c87c" });
  header.appendChild(title);
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "hbhp-close";
  closeBtn.title = "Close";
  setAcText(closeBtn, "X");
  closeBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    closePanel();
  });
  header.appendChild(closeBtn);
  overlay.appendChild(header);

  const body = document.createElement("div");
  body.className = "hbhp-body";

  // Buy House
  const buySection = makeSection("Buy House");
  const buySlumlord = makeInputRow("Slumlord GUID", "0x80000000");
  const buyItems = makeInputRow("Items (GUIDs)", "0x50000001,0x50000002");
  buySection.appendChild(buySlumlord.row);
  buySection.appendChild(buyItems.row);
  const buyBtn = document.createElement("button");
  buyBtn.type = "button";
  buyBtn.className = "hbhp-btn";
  setAcText(buyBtn, "Buy");
  buyBtn.addEventListener("click", () => {
    const slumlord = parseGuid(buySlumlord.input.value);
    if (slumlord === null) {
      console.warn("[house-panel] buy: invalid slumlord GUID");
      return;
    }
    const items = parseGuidList(buyItems.input.value);
    if (items === null) {
      console.warn("[house-panel] buy: invalid item GUID list");
      return;
    }
    if (!window.confirm("Purchase house for these items?")) return;
    const handle = getHandle();
    if (!handle?.buyHouse) {
      console.warn("[house-panel] no session handle");
      return;
    }
    try {
      handle.buyHouse(slumlord, items);
      console.log(`[house-panel] buyHouse(slumlord=0x${slumlord.toString(16).padStart(8, "0")}, items=${items.length})`);
    } catch (e) {
      console.warn("[house-panel] buyHouse failed:", e);
    }
  });
  buySection.appendChild(buyBtn);
  body.appendChild(buySection);

  // Rent House
  const rentSection = makeSection("Rent House");
  const rentSlumlord = makeInputRow("Slumlord GUID", "0x80000000");
  const rentItems = makeInputRow("Items (GUIDs)", "0x50000001,0x50000002");
  rentSection.appendChild(rentSlumlord.row);
  rentSection.appendChild(rentItems.row);
  const rentBtn = document.createElement("button");
  rentBtn.type = "button";
  rentBtn.className = "hbhp-btn";
  setAcText(rentBtn, "Rent");
  rentBtn.addEventListener("click", () => {
    const slumlord = parseGuid(rentSlumlord.input.value);
    if (slumlord === null) {
      console.warn("[house-panel] rent: invalid slumlord GUID");
      return;
    }
    const items = parseGuidList(rentItems.input.value);
    if (items === null) {
      console.warn("[house-panel] rent: invalid item GUID list");
      return;
    }
    if (!window.confirm("Pay rent with these items?")) return;
    const handle = getHandle();
    if (!handle?.rentHouse) {
      console.warn("[house-panel] no session handle");
      return;
    }
    try {
      handle.rentHouse(slumlord, items);
      console.log(`[house-panel] rentHouse(slumlord=0x${slumlord.toString(16).padStart(8, "0")}, items=${items.length})`);
    } catch (e) {
      console.warn("[house-panel] rentHouse failed:", e);
    }
  });
  rentSection.appendChild(rentBtn);
  body.appendChild(rentSection);

  // Query House
  const querySection = makeSection("Query House");
  const queryBtn = document.createElement("button");
  queryBtn.type = "button";
  queryBtn.className = "hbhp-btn";
  setAcText(queryBtn, "Query My House");
  queryBtn.addEventListener("click", () => {
    const handle = getHandle();
    if (!handle?.houseQuery) {
      console.warn("[house-panel] no session handle");
      return;
    }
    try {
      handle.houseQuery();
      console.log("[house-panel] houseQuery()");
    } catch (e) {
      console.warn("[house-panel] houseQuery failed:", e);
    }
  });
  querySection.appendChild(queryBtn);
  body.appendChild(querySection);

  // Abandon House
  const abandonSection = makeSection("Abandon House");
  const abandonBtn = document.createElement("button");
  abandonBtn.type = "button";
  abandonBtn.className = "hbhp-btn hbhp-btn-danger";
  setAcText(abandonBtn, "Abandon House");
  abandonBtn.addEventListener("click", () => {
    if (!window.confirm("Abandon your house? This cannot be undone.")) return;
    const handle = getHandle();
    if (!handle?.abandonHouse) {
      console.warn("[house-panel] no session handle");
      return;
    }
    try {
      handle.abandonHouse();
      console.log("[house-panel] abandonHouse()");
    } catch (e) {
      console.warn("[house-panel] abandonHouse failed:", e);
    }
  });
  abandonSection.appendChild(abandonBtn);
  body.appendChild(abandonSection);

  // Placeholder for the future receive-side fold-out.
  const placeholder = document.createElement("div");
  placeholder.className = "hbhp-placeholder";
  placeholder.textContent = "House profile + guest perms + storage perms — coming in a future wave";
  body.appendChild(placeholder);

  overlay.appendChild(body);
  return overlay;
}

function openPanel() {
  if (!overlayEl) {
    overlayEl = buildPanel();
    document.body.appendChild(overlayEl);
  }
  overlayEl.dataset.open = "1";
}

function closePanel() {
  if (overlayEl) {
    overlayEl.dataset.open = "0";
  }
}

if (typeof window !== "undefined") {
  window.__openHousePanel = openPanel;
  window.__closeHousePanel = closePanel;
}

export const manifest = {
  id: "house-panel",
  name: "House",
  icon: "H",
  iconHidden: true,
  version: "0.1.0",
  description: "Housing MVP — Buy / Query / Abandon / Rent (send-side only)",
};
