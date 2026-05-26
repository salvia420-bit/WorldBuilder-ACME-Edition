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

// ACE WeenieError codes for the HouseStatus event (0x0226) — see
// `crates/holtburger-protocol/src/errors.rs` for the full enum.
// HouseStatus only ever carries `BadParam` (no house owned) or
// `HouseEvicted` (player was kicked) in retail-emulating ACE flows.
const WEENIE_ERROR_NONE = 0x0000;
const WEENIE_ERROR_BAD_PARAM = 0x0002;
const WEENIE_ERROR_HOUSE_EVICTED = 0x045F;

// ACE HouseType enum (Source/ACE.Entity/Enum/HouseType.cs):
// 0 = Undef, 1 = Cottage, 2 = Villa, 3 = Mansion, 4 = Apartment.
const HOUSE_TYPE_NAMES = ["Undef", "Cottage", "Villa", "Mansion", "Apartment"];

// AC rent is a weekly maintenance period — 7 * 24 * 60 * 60 = 604800 sec.
// `RentTime` (Unix ts) marks when the current period began; the next due
// time is RentTime + MAINTENANCE_PERIOD_SECONDS.
const MAINTENANCE_PERIOD_SECONDS = 7 * 24 * 60 * 60;

let overlayEl = null;
let statusEl = null;
let dataLinesEl = null;
let statusUnsubscribe = null;
let statusPollTimer = null;

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
    #${OVERLAY_ID} .hbhp-status-line {
      font-size: 11px;
      color: var(--hb-text-cream-bright);
      padding: 2px 0;
      font-family: monospace;
    }
    #${OVERLAY_ID} .hbhp-status-line[data-owner="0"] {
      color: var(--hb-text-dim, #7a6b50);
    }
    #${OVERLAY_ID} .hbhp-data-lines {
      display: none;
      flex-direction: column;
      gap: 2px;
      margin-top: 4px;
      padding-top: 4px;
      border-top: 1px solid var(--hb-border-brass-dim);
    }
    #${OVERLAY_ID} .hbhp-data-lines[data-visible="1"] {
      display: flex;
    }
    #${OVERLAY_ID} .hbhp-data-line {
      font-size: 10.5px;
      color: var(--hb-text-cream);
      font-family: monospace;
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

function formatHouseType(t) {
  return HOUSE_TYPE_NAMES[t >>> 0] ?? `Type ${t}`;
}

function formatUnixTimestamp(ts) {
  if (!ts) return "—";
  try {
    return new Date((ts >>> 0) * 1000).toUTCString().replace("GMT", "UTC");
  } catch {
    return String(ts);
  }
}

function renderStatus() {
  if (!statusEl) return;
  const handle = getHandle();
  let snap = null;
  if (handle?.playerHouseStatus) {
    try {
      snap = handle.playerHouseStatus();
    } catch (e) {
      console.warn("[house-panel] playerHouseStatus threw:", e);
    }
  }
  let isOwner = false;
  if (!snap) {
    setAcText(statusEl, "Status: not queried yet.");
    statusEl.dataset.owner = "0";
  } else {
    const code = snap.errorCode >>> 0;
    let text;
    if (code === WEENIE_ERROR_BAD_PARAM) {
      text = "No house owned.";
      statusEl.dataset.owner = "0";
    } else if (code === WEENIE_ERROR_HOUSE_EVICTED) {
      text = "Evicted from house.";
      statusEl.dataset.owner = "0";
    } else if (code === WEENIE_ERROR_NONE) {
      text = "House: owner.";
      statusEl.dataset.owner = "1";
      isOwner = true;
    } else {
      text = `Status: WeenieError 0x${code.toString(16).padStart(4, "0")}`;
      statusEl.dataset.owner = "0";
    }
    setAcText(statusEl, text);
  }

  if (!dataLinesEl) return;
  let dataSnap = null;
  if (isOwner && handle?.playerHouseData) {
    try {
      dataSnap = handle.playerHouseData();
    } catch (e) {
      console.warn("[house-panel] playerHouseData threw:", e);
    }
  }
  let profileSnap = null;
  if (handle?.playerHouseProfile) {
    try {
      profileSnap = handle.playerHouseProfile();
    } catch (e) {
      console.warn("[house-panel] playerHouseProfile threw:", e);
    }
  }
  let restrictionsSnap = null;
  if (handle?.playerHouseRestrictions) {
    try {
      restrictionsSnap = handle.playerHouseRestrictions();
    } catch (e) {
      console.warn("[house-panel] playerHouseRestrictions threw:", e);
    }
  }
  const lines = [];
  if (dataSnap) {
    lines.push(`Dwelling: ${formatHouseType(dataSnap.houseType)}`);
    const lb = (dataSnap.landblockId >>> 0).toString(16).padStart(8, "0").toUpperCase();
    lines.push(`House ID: 0x${lb}`);
    const rentDueTs = (dataSnap.rentTime >>> 0) + MAINTENANCE_PERIOD_SECONDS;
    lines.push(`Rent due: ${formatUnixTimestamp(rentDueTs)}`);
    lines.push(`Maintenance period: 7 days`);
    if (dataSnap.maintenanceFree) {
      lines.push(`Maintenance: FREE (admin)`);
    }
  }
  if (profileSnap) {
    if (profileSnap.ownerName) {
      lines.push(`Owner: ${profileSnap.ownerName}`);
    }
    if (!dataSnap) {
      lines.push(`Dwelling: ${formatHouseType(profileSnap.houseType)}`);
    }
  }
  if (restrictionsSnap) {
    lines.push(`Access: ${restrictionsSnap.isOpen ? "Open to public" : "Private"}`);
    lines.push(`Guests: ${restrictionsSnap.guestCount} (${restrictionsSnap.storageCount} w/ storage)`);
  }
  if (lines.length === 0) {
    dataLinesEl.dataset.visible = "0";
    dataLinesEl.replaceChildren();
    return;
  }
  const children = lines.map((text) => {
    const div = document.createElement("div");
    div.className = "hbhp-data-line";
    setAcText(div, text);
    return div;
  });
  dataLinesEl.replaceChildren(...children);
  dataLinesEl.dataset.visible = "1";
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

  // Status — Wave L2 receive-side snapshot of `GameEvent::HouseStatus`
  // (opcode 0x0226). Sync getter on the session handle; refreshed on
  // `playerStatsUpdated` events + a 1Hz fallback poll so the panel
  // doesn't go stale if the player Query'd before opening it.
  //
  // Wave M2 (2026-05-26): when the player is the owner, additionally
  // render `GameEvent::HouseData` (opcode 0x0225) fields below the
  // status line — dwelling type, house id (landblock), next rent-due
  // timestamp, maintenance period.
  const statusSection = makeSection("Status");
  statusEl = document.createElement("div");
  statusEl.className = "hbhp-status-line";
  setAcText(statusEl, "Status: not queried yet.");
  statusEl.dataset.owner = "0";
  statusSection.appendChild(statusEl);
  dataLinesEl = document.createElement("div");
  dataLinesEl.className = "hbhp-data-lines";
  dataLinesEl.dataset.visible = "0";
  statusSection.appendChild(dataLinesEl);
  body.appendChild(statusSection);

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
  // Wave L2: drive `renderStatus()` from the existing
  // `playerStatsUpdated` bus event (house ownership state often
  // coincides with stat refreshes) + a 1Hz fallback for the QueryHouse
  // landing case. Both no-op when the wasm handle isn't ready.
  renderStatus();
  const client = window.__pluginClient;
  if (client?.events?.on && !statusUnsubscribe) {
    const handler = () => renderStatus();
    client.events.on("playerStatsUpdated", handler);
    statusUnsubscribe = () => {
      try { client.events.off("playerStatsUpdated", handler); } catch {}
    };
  }
  if (!statusPollTimer) {
    statusPollTimer = setInterval(renderStatus, 1000);
  }
}

function closePanel() {
  if (overlayEl) {
    overlayEl.dataset.open = "0";
  }
  if (statusUnsubscribe) {
    statusUnsubscribe();
    statusUnsubscribe = null;
  }
  if (statusPollTimer) {
    clearInterval(statusPollTimer);
    statusPollTimer = null;
  }
  if (dataLinesEl) {
    dataLinesEl.dataset.visible = "0";
    dataLinesEl.replaceChildren();
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
