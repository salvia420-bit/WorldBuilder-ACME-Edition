// trade-panel — floating peer-to-peer trade window.
//
// AC Trade (2026-05-25, Discord deficiency #3). Subscribes to the
// `tradeUpdated` bus event (emitted by index.html's kind=23 arm) and
// renders the live snapshot from `handle.playerTrade()`. Snapshot is
// null pre-open and post-close, so the panel auto-shows / auto-hides
// as the trade state machine transitions.
//
// Retail "Trade Window" layout (mirrored loosely — DAT layout port is
// a future wave): two side-by-side grids — "You" on the left, partner
// name on the right — each 4 cols × 3 rows (12 slots). Accept /
// Decline / Reset buttons across the bottom. X-close in the header.
//
// Drag-drop: drop an inventory item onto the "You" grid → wires
// `handle.addToTrade(itemGuid, 0)`. Mime is `application/x-hb-inv-guid`
// to match inventory.js's dragstart payload (see inventory.js:734).
//
// Keyboard: Esc closes via `handle.closeTrade()`.
//
// Debug entry points (no UI gating yet — see CHORIZITE_PORTING_PLAN
// §13 for the radial-menu wiring follow-on):
//   window.__openTradePanel() — calls handle.openTrade(targetGuid)
//     against the currently-selected entity, or logs "no target".
//   window.__closeTradePanel() — closes the trade.

import { setAcText } from "../ui/ac_font.js";
import { fetchIconDataUrl as fetchIconDataUrlShared } from "../ui/ac_icon_cache.js";

const OVERLAY_ID = "hb-trade-panel";
const STYLE_ID = "hb-trade-panel-style";
const GRID_COLS = 4;
const GRID_ROWS = 3;
const GRID_SLOTS = GRID_COLS * GRID_ROWS;

let overlayEl = null;
let onKeyDownHandler = null;

// Wave 15 — icon cache consolidated into `ui/ac_icon_cache.js`. Local
// thin wrapper preserves the historical `[trade-panel]` warn label.
async function fetchIconDataUrl(iconId) {
  return fetchIconDataUrlShared(iconId, "trade-panel");
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    #${OVERLAY_ID} {
      position: fixed;
      top: 90px;
      left: 50%;
      transform: translateX(-50%);
      width: 360px;
      height: 280px;
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
    }
    #${OVERLAY_ID}[data-open="1"] { display: flex; flex-direction: column; }
    #${OVERLAY_ID} .htp-header {
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
    #${OVERLAY_ID} .htp-title {
      flex: 1 1 auto;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      text-shadow: 0 1px 0 rgba(0,0,0,.85);
    }
    #${OVERLAY_ID} .htp-close {
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
    #${OVERLAY_ID} .htp-close:hover {
      background: var(--hb-overlay-hover);
      color: var(--hb-text-cream-bright);
      border-color: var(--hb-border-brass);
    }
    #${OVERLAY_ID} .htp-body {
      flex: 1 1 auto;
      display: flex;
      flex-direction: row;
      gap: 4px;
      padding: 6px;
      overflow: hidden;
    }
    #${OVERLAY_ID} .htp-side {
      flex: 1 1 50%;
      display: flex;
      flex-direction: column;
      border: 1px solid var(--hb-border-brass-dim);
      background: rgba(0,0,0,0.25);
    }
    #${OVERLAY_ID} .htp-side.htp-drop-active {
      border-color: var(--hb-text-gold);
      background: rgba(80, 60, 20, 0.35);
    }
    #${OVERLAY_ID} .htp-side-header {
      flex: 0 0 18px;
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 0 4px;
      background: rgba(0,0,0,0.45);
      border-bottom: 1px solid var(--hb-border-brass-dim);
      font-size: 11px;
    }
    #${OVERLAY_ID} .htp-side-name {
      flex: 1 1 auto;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #${OVERLAY_ID} .htp-accept-dot {
      flex: 0 0 8px;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: transparent;
      border: 1px solid var(--hb-border-brass-dim);
    }
    #${OVERLAY_ID} .htp-accept-dot[data-on="1"] {
      background: #4caf50;
      border-color: #6bcf6b;
      box-shadow: 0 0 4px rgba(76, 175, 80, 0.7);
    }
    #${OVERLAY_ID} .htp-grid {
      flex: 1 1 auto;
      display: grid;
      grid-template-columns: repeat(${GRID_COLS}, 1fr);
      grid-template-rows: repeat(${GRID_ROWS}, 1fr);
      gap: 2px;
      padding: 3px;
      box-sizing: border-box;
    }
    #${OVERLAY_ID} .htp-slot {
      background: rgba(0, 0, 0, 0.45);
      border: 1px solid var(--hb-border-brass-dim);
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
      box-sizing: border-box;
      font-size: 14px;
      line-height: 1;
      min-height: 0;
      min-width: 0;
    }
    #${OVERLAY_ID} .htp-slot[data-empty="1"] {
      background: rgba(0, 0, 0, 0.25);
      border-style: dashed;
      border-color: var(--hb-border-brass-dim);
    }
    #${OVERLAY_ID} .htp-slot img {
      width: 100%;
      height: 100%;
      image-rendering: pixelated;
      object-fit: contain;
    }
    #${OVERLAY_ID} .htp-stack {
      position: absolute;
      bottom: 0;
      right: 0;
      background: rgba(0, 0, 0, 0.75);
      color: var(--hb-text-cream-bright);
      font-size: 8px;
      line-height: 1;
      padding: 1px 2px;
      font-variant-numeric: tabular-nums;
    }
    #${OVERLAY_ID} .htp-footer {
      flex: 0 0 30px;
      display: flex;
      align-items: center;
      justify-content: space-around;
      gap: 6px;
      padding: 0 8px 6px;
    }
    #${OVERLAY_ID} .htp-btn {
      flex: 1 1 0;
      background: transparent;
      border: 1px solid var(--hb-border-brass-dim);
      color: var(--hb-text-cream);
      font-family: inherit;
      font-size: 11px;
      padding: 4px 0;
      cursor: pointer;
    }
    #${OVERLAY_ID} .htp-btn:hover {
      background: var(--hb-overlay-hover);
      border-color: var(--hb-border-brass);
      color: var(--hb-text-cream-bright);
    }
    #${OVERLAY_ID} .htp-btn-accept[data-on="1"] {
      background: rgba(120, 90, 20, 0.5);
      border-color: var(--hb-text-gold);
      color: var(--hb-text-gold);
    }
  `;
  document.head.appendChild(s);
}

function fmtGuid(guid) {
  return `0x${(guid >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}

function buildOverlay() {
  ensureStyles();
  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;

  const header = document.createElement("div");
  header.className = "htp-header";
  const title = document.createElement("div");
  title.className = "htp-title";
  setAcText(title, "Trade Window", { color: "#f0c87c" });
  header.appendChild(title);
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "htp-close";
  closeBtn.title = "Close (Esc)";
  setAcText(closeBtn, "X");
  closeBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    requestClose();
  });
  header.appendChild(closeBtn);
  overlay.appendChild(header);

  const body = document.createElement("div");
  body.className = "htp-body";

  // "You" side — drop-zone for inventory drags.
  const mySide = document.createElement("div");
  mySide.className = "htp-side htp-mine";
  const myHeader = document.createElement("div");
  myHeader.className = "htp-side-header";
  const myName = document.createElement("div");
  myName.className = "htp-side-name";
  setAcText(myName, "You", { color: "#f0c87c" });
  myHeader.appendChild(myName);
  const myDot = document.createElement("div");
  myDot.className = "htp-accept-dot";
  myDot.title = "You accepted";
  myHeader.appendChild(myDot);
  mySide.appendChild(myHeader);
  const myGrid = document.createElement("div");
  myGrid.className = "htp-grid";
  mySide.appendChild(myGrid);
  body.appendChild(mySide);

  // Drag-drop wiring on the "You" side only (you can't drop into the
  // partner's grid — that's mirrored from the server).
  mySide.addEventListener("dragenter", onMyDragEnter);
  mySide.addEventListener("dragover", onMyDragOver);
  mySide.addEventListener("dragleave", onMyDragLeave);
  mySide.addEventListener("drop", onMyDrop);

  // Partner side — read-only mirror of the server-pushed AddToTrade
  // events with `trade_side=PartnerSide`.
  const partnerSide = document.createElement("div");
  partnerSide.className = "htp-side htp-partner";
  const partnerHeader = document.createElement("div");
  partnerHeader.className = "htp-side-header";
  const partnerName = document.createElement("div");
  partnerName.className = "htp-side-name";
  setAcText(partnerName, "Partner", { color: "#f0c87c" });
  partnerHeader.appendChild(partnerName);
  const partnerDot = document.createElement("div");
  partnerDot.className = "htp-accept-dot";
  partnerDot.title = "Partner accepted";
  partnerHeader.appendChild(partnerDot);
  partnerSide.appendChild(partnerHeader);
  const partnerGrid = document.createElement("div");
  partnerGrid.className = "htp-grid";
  partnerSide.appendChild(partnerGrid);
  body.appendChild(partnerSide);

  overlay.appendChild(body);

  // Footer: Accept / Decline / Reset buttons.
  const footer = document.createElement("div");
  footer.className = "htp-footer";
  const acceptBtn = document.createElement("button");
  acceptBtn.type = "button";
  acceptBtn.className = "htp-btn htp-btn-accept";
  setAcText(acceptBtn, "Accept");
  acceptBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    window.__sessionHandle?.acceptTrade?.();
  });
  footer.appendChild(acceptBtn);
  const declineBtn = document.createElement("button");
  declineBtn.type = "button";
  declineBtn.className = "htp-btn htp-btn-decline";
  setAcText(declineBtn, "Decline");
  declineBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    window.__sessionHandle?.declineTrade?.();
  });
  footer.appendChild(declineBtn);
  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "htp-btn htp-btn-reset";
  setAcText(resetBtn, "Reset");
  resetBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    window.__sessionHandle?.resetTrade?.();
  });
  footer.appendChild(resetBtn);
  overlay.appendChild(footer);

  overlay._titleEl = title;
  overlay._myNameEl = myName;
  overlay._myDotEl = myDot;
  overlay._myGridEl = myGrid;
  overlay._mySideEl = mySide;
  overlay._partnerNameEl = partnerName;
  overlay._partnerDotEl = partnerDot;
  overlay._partnerGridEl = partnerGrid;
  overlay._acceptBtnEl = acceptBtn;

  document.body.appendChild(overlay);
  return overlay;
}

function renderSlots(gridEl, items) {
  gridEl.innerHTML = "";
  for (let i = 0; i < GRID_SLOTS; i++) {
    const slot = document.createElement("div");
    slot.className = "htp-slot";
    const it = items[i];
    if (!it) {
      slot.dataset.empty = "1";
    } else {
      slot.dataset.guid = String(it.guid);
      slot.title = it.name || fmtGuid(it.guid);
      slot.textContent = "·";
      if (it.iconId) {
        fetchIconDataUrl(it.iconId).then((url) => {
          if (!url || !slot.isConnected) return;
          slot.textContent = "";
          const img = document.createElement("img");
          img.src = url;
          img.alt = it.name || "";
          slot.appendChild(img);
        });
      }
      if (it.stackSize > 1) {
        const badge = document.createElement("div");
        badge.className = "htp-stack";
        setAcText(badge, String(it.stackSize), { color: "#f0e8d0" });
        slot.appendChild(badge);
      }
    }
    gridEl.appendChild(slot);
  }
}

function renderSnapshot(snapshot) {
  if (!overlayEl) return;
  if (!snapshot) {
    hidePanel();
    return;
  }
  // Pull arrays of items via getter — wasm wrappers return Vec<TradeItemJs>.
  let myItems = [];
  let partnerItems = [];
  try {
    myItems = Array.from(snapshot.myItems || []);
  } catch (_) {}
  try {
    partnerItems = Array.from(snapshot.partnerItems || []);
  } catch (_) {}
  renderSlots(overlayEl._myGridEl, myItems);
  renderSlots(overlayEl._partnerGridEl, partnerItems);

  const partnerLabel = snapshot.partnerName || fmtGuid(snapshot.partnerGuid || 0);
  setAcText(overlayEl._partnerNameEl, partnerLabel, { color: "#f0c87c" });

  overlayEl._myDotEl.dataset.on = snapshot.myAccepted ? "1" : "0";
  overlayEl._partnerDotEl.dataset.on = snapshot.partnerAccepted ? "1" : "0";
  overlayEl._acceptBtnEl.dataset.on = snapshot.myAccepted ? "1" : "0";
  setAcText(
    overlayEl._acceptBtnEl,
    snapshot.myAccepted ? "Accepted" : "Accept",
    { color: snapshot.myAccepted ? "#f0c87c" : "#f0e8d0" },
  );

  showPanel();
}

function showPanel() {
  if (!overlayEl) return;
  overlayEl.dataset.open = "1";
  if (!onKeyDownHandler) {
    onKeyDownHandler = (ev) => {
      if (overlayEl?.dataset.open !== "1") return;
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        requestClose();
      }
    };
    document.addEventListener("keydown", onKeyDownHandler, true);
  }
}

function hidePanel() {
  if (!overlayEl) return;
  overlayEl.dataset.open = "0";
  if (onKeyDownHandler) {
    document.removeEventListener("keydown", onKeyDownHandler, true);
    onKeyDownHandler = null;
  }
}

function requestClose() {
  // Server-driven close: the kind=23 TradeUpdated with snapshot=None
  // will hide the panel; we just fire the wire request.
  const handle = window.__sessionHandle;
  if (handle?.closeTrade) {
    try {
      handle.closeTrade();
    } catch (e) {
      console.warn("[trade-panel] closeTrade failed:", e);
    }
  } else {
    hidePanel();
  }
}

function onMyDragEnter(ev) {
  if (ev.dataTransfer?.types?.includes("application/x-hb-inv-guid")) {
    ev.preventDefault();
    overlayEl?._mySideEl?.classList.add("htp-drop-active");
  }
}
function onMyDragOver(ev) {
  if (ev.dataTransfer?.types?.includes("application/x-hb-inv-guid")) {
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";
  }
}
function onMyDragLeave(ev) {
  if (ev.target === overlayEl?._mySideEl) {
    overlayEl?._mySideEl?.classList.remove("htp-drop-active");
  }
}
function onMyDrop(ev) {
  overlayEl?._mySideEl?.classList.remove("htp-drop-active");
  const guidStr = ev.dataTransfer?.getData("application/x-hb-inv-guid");
  if (!guidStr) return;
  ev.preventDefault();
  const guid = parseInt(guidStr, 10) >>> 0;
  if (!guid) return;
  const handle = window.__sessionHandle;
  if (handle?.addToTrade) {
    try {
      handle.addToTrade(guid, 0);
    } catch (e) {
      console.warn("[trade-panel] addToTrade failed:", e);
    }
  }
}

function onTradeUpdated() {
  const handle = window.__sessionHandle;
  if (!handle?.playerTrade) {
    hidePanel();
    return;
  }
  let snapshot = null;
  try {
    snapshot = handle.playerTrade();
  } catch (e) {
    console.warn("[trade-panel] playerTrade getter failed:", e);
    hidePanel();
    return;
  }
  if (!overlayEl) overlayEl = buildOverlay();
  renderSnapshot(snapshot);
}

// Subscribe at module-load. Mirror container-panel's pattern — poll
// for the bus until login wires it.
let _subscribeTimer = null;
function trySubscribe() {
  const client = window.__pluginClient ?? null;
  if (!client?.events?.on) return false;
  client.events.on("tradeUpdated", onTradeUpdated);
  client.events.on("kind:23", onTradeUpdated);
  return true;
}
if (typeof window !== "undefined") {
  if (!trySubscribe()) {
    _subscribeTimer = setInterval(() => {
      if (trySubscribe()) {
        clearInterval(_subscribeTimer);
        _subscribeTimer = null;
      }
    }, 500);
  }

  // Debug entry — open a trade against the currently-selected entity.
  // Selection lookup mirrors radial-menu / examine-target: prefer
  // window.__selectedEntityGuid (set by picking.js click handler),
  // fall back to window.__lastSelectedGuid for legacy paths.
  window.__openTradePanel = () => {
    const handle = window.__sessionHandle;
    if (!handle?.openTrade) {
      console.warn("[trade-panel] no session handle");
      return;
    }
    const targetGuid =
      (window.__selectedEntityGuid >>> 0) ||
      (window.__lastSelectedGuid >>> 0) ||
      0;
    if (!targetGuid) {
      console.warn("[trade-panel] no target selected — click an entity first");
      return;
    }
    try {
      handle.openTrade(targetGuid);
      console.log(`[trade-panel] openTrade(${fmtGuid(targetGuid)})`);
    } catch (e) {
      console.warn("[trade-panel] openTrade failed:", e);
    }
  };
  window.__closeTradePanel = () => requestClose();
}

export const manifest = {
  id: "trade-panel",
  name: "Trade",
  icon: "T",
  iconHidden: true,
  version: "0.1.0",
  description: "Peer-to-peer trade window — auto-opens on kind=23 TradeUpdated",
};
