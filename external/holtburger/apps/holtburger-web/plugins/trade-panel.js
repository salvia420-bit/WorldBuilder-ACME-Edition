// trade-panel — the Secure Trade window (retail gmSecureTradeUI, layout
// 0x2100000D).
//
// HUD overhaul 2026-10-05 — rebuilt on the shared HUD kit.
//
// Retail: an 800×110 strip split into two 400×110 halves divided by a
// bevel (0x06004CB8) — the PARTNER on the left (name, "trade accepted"
// indicator, total-items label, one 32-px item row with a rope scroll),
// YOU on the right with the green-arrow Trade button (0x06004CBC, 46×30)
// pointing at the partner, a small green Clear All (0x06001DC6) in the
// middle and the close (0x060012AA) at the far right.
//
// Ours keeps that two-halves arrangement (partner left, you right) in a
// draggable kit window: each half has its own name, item count, accept
// badge and a wrapping 32-px slot grid; your half is the drop target for
// inventory drags. The footer carries a plain-English status line ("Waiting
// for Bob to accept.") so the accept state can't be misread, the green
// Clear All, and the retail green-arrow Trade toggle.
//
// Retail behaviour mirrored:
//   • Trade is a TOGGLE (gmSecureTradeUI::ListenToElementMessage): pressed
//     = you accepted (AcceptTheTrade); pressing again un-accepts
//     (DeclineTheTrade). It is ghosted while neither side has offered
//     anything (UpdateTradeButtonState, state 13).
//   • Any change to the offer clears both acceptances server-side
//     (RecvNotice_ClearTradeAcceptance → Reset) — the snapshot carries it.
//   • Drops: only items you carry (DragItemAcceptable: "You can only trade
//     items you are carrying"), never the same item twice.
//   • Range: the partner is registered at range 5.0 with use-cylinders
//     (RecvNotice_RegisterTrade); OnObjectRangeExit closes the
//     negotiation (CloseTradeNegotiations). The old 24-m decline was not
//     retail.
//
// Wire (DO NOT regress): snapshot via `tradeUpdated` / `kind:23` bus event →
// handle.playerTrade() (null = closed); addToTrade(itemGuid, 0) on drop
// (mime `application/x-hb-inv-guid`, DropItemFlags.TRADE); acceptTrade /
// declineTrade / resetTrade / closeTrade.
//
// Debug: window.__openTradePanel() opens a trade with the selected target;
// window.__closeTradePanel() closes it.

import { setAcText } from "../ui/ac_font.js";
import { DropItemFlags } from "./drop_item_flags.js";
import {
  createKitWindow, COMMERCE_WINDOW_ID, KIT_COLOR, fillSlotIcon, wireDropTarget,
  inventoryRows, entityWorldPos, localPlayerWorldPos, selectedTargetGuid,
  objectDisplayName, objectIconId, chatNotice,
} from "./commerce_window.js";
import { tradeStatus, isOutOfRange, TRADE_RANGE, fmtNumber } from "./commerce_logic.js";

const OVERLAY_ID = "hb-trade-panel";
const STYLE_ID = "hb-trade-panel-style";
const SP = "./data/ui-sprites";
const TRADE_RANGE_POLL_MS = 500;

let win = null;
let refs = null;
let lastSnap = null;
let currentPartnerGuid = 0;
let rangeTimerId = 0;
let rangeBreachFired = false;

function ensureStyles() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    #${OVERLAY_ID} { width: 620px; }
    #${OVERLAY_ID} .htp-halves {
      flex: 1 1 auto; min-height: 0;
      display: grid; grid-template-columns: minmax(0, 1fr) 5px minmax(0, 1fr);
      padding: 6px 6px 4px;
    }
    /* Retail TradeOtherRightSideBevel 0x06004CB8 between the halves. */
    #${OVERLAY_ID} .htp-bevel {
      background: url("${SP}/0x06004CB8.png") center top / 5px 10px repeat-y;
      margin: 0 3px;
    }
    #${OVERLAY_ID} .htp-half { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
    #${OVERLAY_ID} .htp-head { display: flex; align-items: center; gap: 6px; min-height: 18px; padding: 0 2px; }
    #${OVERLAY_ID} .htp-name { flex: 1 1 auto; min-width: 0; overflow: hidden; }
    #${OVERLAY_ID} .htp-badge {
      flex: 0 0 auto; display: inline-flex; align-items: center; gap: 4px;
      padding: 1px 6px; border: 1px solid #3a2f18; border-radius: 2px;
      background: rgba(0, 0, 0, 0.45);
    }
    #${OVERLAY_ID} .htp-badge::before {
      content: ""; width: 8px; height: 8px; border-radius: 50%;
      background: #2a2418; box-shadow: inset 0 0 0 1px #000;
    }
    #${OVERLAY_ID} .htp-badge.is-on {
      border-color: #4f8a2a; background: rgba(40, 90, 20, 0.35);
      box-shadow: 0 0 6px rgba(110, 200, 60, 0.35);
    }
    #${OVERLAY_ID} .htp-badge.is-on::before { background: #8aef6d; box-shadow: 0 0 5px #8aef6d; }
    #${OVERLAY_ID} .htp-count { padding: 0 2px; min-height: 14px; }
    #${OVERLAY_ID} .htp-well { flex: 1 1 auto; min-height: 76px; height: 116px; overflow-y: auto; }
    #${OVERLAY_ID} .htp-well .hb-cw-grid { gap: 3px; }
    #${OVERLAY_ID} .htp-footer { justify-content: flex-start; gap: 8px; }
    #${OVERLAY_ID} .htp-status { flex: 1 1 auto; min-width: 0; color: var(--hbk-text); font-size: 12px; }
    #${OVERLAY_ID} .htp-status.is-ready { color: var(--hbk-value); }
    #${OVERLAY_ID} .htp-clear {
      background-image: url("${SP}/0x06001DC6.png");
      min-width: 60px; min-height: 14px; color: #f0f6e0;
    }
    /* Retail TradeSelfTradeButton: the green arrow 0x06004CBC (hover
       0x06004CBD) pointing LEFT at the partner, label beside it. */
    #${OVERLAY_ID} .htp-trade {
      display: inline-flex; align-items: center; gap: 4px;
      height: 30px; padding: 0 8px 0 0; border: 0; background: transparent;
      cursor: pointer;
    }
    #${OVERLAY_ID} .htp-trade .htp-arrow {
      width: 46px; height: 30px; flex: 0 0 46px;
      background: url("${SP}/0x06004CBC.png") center / 100% 100% no-repeat;
    }
    #${OVERLAY_ID} .htp-trade:hover .htp-arrow,
    #${OVERLAY_ID} .htp-trade:focus-visible .htp-arrow { background-image: url("${SP}/0x06004CBD.png"); }
    #${OVERLAY_ID} .htp-trade.is-pressed .htp-arrow {
      background-image: url("${SP}/0x06004CBD.png");
      filter: drop-shadow(0 0 5px rgba(140, 240, 100, 0.85)) brightness(1.15);
    }
    #${OVERLAY_ID} .htp-trade:disabled { cursor: default; }
    #${OVERLAY_ID} .htp-trade:disabled .htp-arrow { filter: grayscale(1) brightness(0.55); }
  `;
  document.head.appendChild(s);
}

function el(tag, cls, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
}

function buildHalf(parent, who) {
  const half = el("div", `htp-half htp-${who}`, parent);
  const head = el("div", "htp-head", half);
  const name = el("div", "htp-name", head);
  const badge = el("div", "htp-badge", head);
  const badgeText = el("span", "", badge);
  const count = el("div", "htp-count", half);
  const well = el("div", "htp-well hbk-scroll hb-cw-drop", half);
  return { half, name, badge, badgeText, count, well };
}

function buildOverlay() {
  ensureStyles();
  win = createKitWindow({
    id: OVERLAY_ID,
    title: "Secure Trade",
    windowId: COMMERCE_WINDOW_ID.TRADE,
    // Upper middle, clear of the vitals row (y≈130) and the radar.
    defaultPos: {
      left: "0px", right: "0px", bottom: "auto",
      top: `max(4px, min(150px, calc(100 * var(--hb-hud-vh, 1vh) - 240px)))`,
    },
    className: "hb-trade",
    // Close button / Esc end the negotiation on the server too.
    onRequestClose: () => requestClose(),
    onHide: () => {
      stopRangeWatcher();
      currentPartnerGuid = 0;
      rangeBreachFired = false;
    },
  });
  // Centred by default via left:0/right:0 + auto margins (no transform —
  // attachWindowPosition converts to left/top px on the first drag).
  win.root.style.marginLeft = "auto";
  win.root.style.marginRight = "auto";

  const halves = el("div", "htp-halves", win.body);
  const partner = buildHalf(halves, "partner");
  el("div", "htp-bevel", halves);
  const mine = buildHalf(halves, "mine");

  const footer = el("div", "hbk-footer htp-footer", win.body);
  const status = el("div", "htp-status", footer);
  const clearBtn = el("button", "hbk-btn-small htp-clear", footer);
  clearBtn.type = "button";
  clearBtn.title = "Take back everything you offered (resets both acceptances)";
  setAcText(clearBtn, "Clear All", { color: "#f0f6e0" });
  clearBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    try { window.__sessionHandle?.resetTrade?.(); } catch (e) { console.warn("[trade-panel] resetTrade failed:", e); }
  });
  const tradeBtn = el("button", "htp-trade", footer);
  tradeBtn.type = "button";
  el("span", "htp-arrow", tradeBtn);
  const tradeLabel = el("span", "", tradeBtn);
  tradeBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    onTradeButton();
  });

  // Drops: your half, or anywhere on the window (it's the only drop that
  // makes sense here).
  const onDrop = (guid) => offerItem(guid);
  wireDropTarget(mine.well, DropItemFlags.TRADE, onDrop);
  wireDropTarget(win.root, DropItemFlags.TRADE, onDrop);

  refs = { partner, mine, status, clearBtn, tradeBtn, tradeLabel };
}

function onTradeButton() {
  const h = window.__sessionHandle;
  if (!h) return;
  try {
    if (lastSnap?.myAccepted) h.declineTrade?.();
    else h.acceptTrade?.();
  } catch (e) {
    console.warn("[trade-panel] accept/decline failed:", e);
  }
}

function offerItem(guid) {
  const g = guid >>> 0;
  const mineGuids = new Set((lastSnap?.myItems || []).map((i) => i.guid >>> 0));
  if (mineGuids.has(g)) {
    win?.toast("That item is already in the trade.", "err");
    return;
  }
  const item = inventoryRows().find((r) => r.guid === g);
  if (!item) {
    win?.toast("You can only trade items you are carrying", "err");
    return;
  }
  if ((item.equipMask >>> 0) !== 0) {
    win?.toast(`Unequip ${item.name} before trading it`, "err");
    return;
  }
  const h = window.__sessionHandle;
  try { h?.addToTrade?.(g, 0); }
  catch (e) { console.warn("[trade-panel] addToTrade failed:", e); }
}

function toRows(list) {
  const out = [];
  try {
    for (const it of Array.from(list || [])) {
      out.push({
        guid: it.guid >>> 0,
        name: it.name || "",
        iconId: it.iconId >>> 0,
        stackSize: it.stackSize ?? 1,
      });
    }
  } catch (_) {}
  return out;
}

function renderWell(well, items, emptyText) {
  well.replaceChildren();
  if (items.length === 0) {
    const hint = el("div", "hb-cw-hint", well);
    hint.textContent = emptyText;
    return;
  }
  const grid = el("div", "hb-cw-grid", well);
  for (const it of items) {
    const name = it.name || objectDisplayName(it.guid);
    const slot = el("div", "hbk-slot", grid);
    fillSlotIcon(slot, it.iconId || objectIconId(it.guid), name);
    if ((it.stackSize || 1) > 1) {
      const st = el("span", "hbk-stack", slot);
      st.textContent = fmtNumber(it.stackSize);
    }
    slot.title = (it.stackSize || 1) > 1 ? `${name} (${fmtNumber(it.stackSize)})` : name;
    slot.dataset.guid = String(it.guid);
  }
}

function renderHalf(r, label, items, accepted, emptyText) {
  setAcText(r.name, label, { color: KIT_COLOR.gold, fit: true });
  r.badge.classList.toggle("is-on", !!accepted);
  setAcText(r.badgeText, accepted ? "Accepted" : "Not accepted", {
    color: accepted ? KIT_COLOR.value : KIT_COLOR.faint,
  });
  r.badge.title = accepted ? `${label} accepted the trade` : `${label} has not accepted yet`;
  setAcText(r.count, `Items offered: ${items.length}`, { color: KIT_COLOR.dim });
  renderWell(r.well, items, emptyText);
}

function renderSnapshot(snapshot) {
  if (!snapshot) {
    lastSnap = null;
    win?.close();
    return;
  }
  if (!win) buildOverlay();
  const myItems = toRows(snapshot.myItems);
  const partnerItems = toRows(snapshot.partnerItems);
  const partnerGuid = (snapshot.partnerGuid >>> 0) || 0;
  const partnerName = snapshot.partnerName || objectDisplayName(partnerGuid, "Your partner");
  lastSnap = {
    myItems, partnerItems,
    myAccepted: !!snapshot.myAccepted,
    partnerAccepted: !!snapshot.partnerAccepted,
    partnerName, partnerGuid,
  };
  if (partnerGuid !== currentPartnerGuid) rangeBreachFired = false;
  currentPartnerGuid = partnerGuid;

  win.setTitle(`Trading with ${partnerName}`);
  renderHalf(refs.partner, partnerName, partnerItems, lastSnap.partnerAccepted,
    `Nothing offered by ${partnerName} yet.`);
  renderHalf(refs.mine, "You", myItems, lastSnap.myAccepted,
    "Drag items here from your pack to offer them.");

  const st = tradeStatus({
    myCount: myItems.length,
    partnerCount: partnerItems.length,
    myAccepted: lastSnap.myAccepted,
    partnerAccepted: lastSnap.partnerAccepted,
    partnerName,
  });
  refs.status.textContent = st.text;
  refs.status.classList.toggle("is-ready", lastSnap.partnerAccepted && !lastSnap.myAccepted);
  refs.tradeBtn.disabled = st.buttonDisabled;
  refs.tradeBtn.classList.toggle("is-pressed", st.buttonPressed);
  refs.tradeBtn.setAttribute("aria-pressed", st.buttonPressed ? "true" : "false");
  refs.tradeBtn.title = st.buttonPressed
    ? "You accepted. Click again to withdraw your acceptance."
    : "Accept this trade";
  setAcText(refs.tradeLabel, st.buttonPressed ? "Accepted" : "Trade", {
    color: st.buttonPressed ? KIT_COLOR.value : KIT_COLOR.text,
  });
  refs.clearBtn.disabled = myItems.length === 0;

  win.open();
  startRangeWatcher();
}

// Range enforcement — retail closes the negotiation once the partner
// leaves 5.0 cylinder units (see header). We poll at 2 Hz (retail 1 Hz).
function startRangeWatcher() {
  if (rangeTimerId) return;
  rangeTimerId = setInterval(checkPartnerRange, TRADE_RANGE_POLL_MS);
}

function stopRangeWatcher() {
  if (!rangeTimerId) return;
  try { clearInterval(rangeTimerId); } catch (_) {}
  rangeTimerId = 0;
}

function checkPartnerRange() {
  if (!win?.isOpen() || rangeBreachFired || !currentPartnerGuid) return;
  const me = localPlayerWorldPos();
  const them = entityWorldPos(currentPartnerGuid);
  if (!me || !them) return;
  if (!isOutOfRange(me, them, TRADE_RANGE)) return;
  rangeBreachFired = true;
  chatNotice(`${lastSnap?.partnerName || "Your trade partner"} is too far away. The trade was closed.`);
  requestClose();
}

function requestClose() {
  // Retail's close button hides the window at once (SetVisible(0)) and
  // ends the negotiation; the kind=23 snapshot=None reply then confirms.
  // Hiding locally too means a stale window can never get stuck open when
  // the server has nothing to close.
  const handle = window.__sessionHandle;
  if (handle?.closeTrade) {
    try { handle.closeTrade(); } catch (e) { console.warn("[trade-panel] closeTrade failed:", e); }
  }
  lastSnap = null;
  win?.close();
}

function onTradeUpdated() {
  const handle = window.__sessionHandle;
  if (!handle?.playerTrade) {
    win?.close();
    return;
  }
  let snapshot = null;
  try {
    snapshot = handle.playerTrade();
  } catch (e) {
    console.warn("[trade-panel] playerTrade getter failed:", e);
    win?.close();
    return;
  }
  renderSnapshot(snapshot);
}

// Subscribe at module-load; wait for the plugin bus.
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
    if (window.__pluginClientReady?.then) {
      window.__pluginClientReady.then(() => { trySubscribe(); });
    } else {
      _subscribeTimer = setInterval(() => {
        if (trySubscribe()) {
          clearInterval(_subscribeTimer);
          _subscribeTimer = null;
        }
      }, 500);
    }
  }

  // Open a trade with the currently-selected entity.
  window.__openTradePanel = () => {
    const handle = window.__sessionHandle;
    if (!handle?.openTrade) {
      console.warn("[trade-panel] no session handle");
      return;
    }
    const targetGuid = selectedTargetGuid();
    if (!targetGuid) {
      console.warn("[trade-panel] no target selected — click a player first");
      return;
    }
    try {
      handle.openTrade(targetGuid);
    } catch (e) {
      console.warn("[trade-panel] openTrade failed:", e);
    }
  };
  window.__closeTradePanel = () => requestClose();
  // Verifier hook: render a synthetic snapshot without a server.
  window.__tradePanelDebug = {
    render: (snap) => renderSnapshot(snap ?? {
      partnerGuid: 0x50000002, partnerName: "Bob the Trader",
      myAccepted: false, partnerAccepted: true,
      myItems: [{ guid: 1, name: "Pyreal", iconId: 0, stackSize: 250 }],
      partnerItems: [{ guid: 2, name: "Iron Sword", iconId: 0, stackSize: 1 },
        { guid: 3, name: "Healing Kit", iconId: 0, stackSize: 1 }],
    }),
    close: () => win?.close(),
  };
}

export const manifest = {
  id: "trade-panel",
  name: "Trade",
  icon: "T",
  iconHidden: true,
  version: "0.2.0",
  description: "Secure Trade window — auto-opens on kind=23 TradeUpdated",
};
