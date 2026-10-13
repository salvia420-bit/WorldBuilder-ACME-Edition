// House panel — housing status + the slumlord Buy / Maintenance flow + guests.
//
// HUD overhaul 2026-10-05 — rebuilt on the shared HUD kit.
//
// Retail splits housing over two layouts: RootHouse_Field (0x21000025, a
// 300×600 list of house text lines in the panel) and gmSlumlordUI
// (0x2100000E, an 800×110 strip with Buy / Maintenance tabs, the
// requirements text on the left, a drop list for the payment items, the
// owner name and a Buy / Maintenance button). The slumlord strip opens when
// the server sends HouseProfile (you used a house's covenant crystal).
//
// Ours folds both into one draggable kit window (id 0x100001E5 =
// RootHouse_Field) with kit tabs:
//   House        — status, dwelling, then gmHouseUI::DisplayHouseData's
//                  lines (hud-ui-1): purchase price, Rent paid/num, Bought,
//                  period end, next due, location (map coords, not a hex
//                  landblock), access + guest counts, the green "already
//                  paid" / red maintenance warning, the 30-day re-buy wait;
//                  Query House / Abandon House.
//   Buy          — the slumlord (auto-filled from HouseProfile.crystalGuid,
//   Maintenance    or "Use Selected" from your target), its owner / type,
//                  the requirements (Buy: "num name, …", Maintenance:
//                  "paid/num name, …" — gmSlumlordUI::RefreshHouse), and a
//                  drop well for the payment items dragged from your pack
//                  (no more typing GUIDs); Buy (only once the staged items
//                  cover the price — UpdateButtons) / Pay Maintenance.
//   Guests       — add / boot by name, remove all (kit confirm modal).
// When a HouseProfile arrives (you used a slumlord) the window opens on Buy
// — or Maintenance if the house is yours — like retail's slumlord strip.
// A window opened that way closes once you are more than 9 m from the
// crystal, or the crystal is gone (messages-objects-3; slumlord_range.js;
// `?slumlordRange=off` keeps it open). Opening it by hand never range-closes.
//
// Wire (unchanged): buyHouse(slumlord, Uint32Array items) 0x021C,
// houseQuery() 0x021E, abandonHouse() 0x021F, rentHouse(slumlord, items)
// 0x0221, addPermanentGuest(name) 0x0245, bootSpecificHouseGuest(name)
// 0x024A, removeAllPermanentGuests() 0x025E. Receive: sync getters
// playerHouseStatus / Data / Profile / Restrictions (no bus event — polled).
//
// Exposes window.__openHousePanel(tab?), __closeHousePanel(), __toggleHousePanel().

import { setAcText } from "../ui/ac_font.js";
import { modalConfirmCallback } from "./modal-dialog.js";
import { DropItemFlags } from "./drop_item_flags.js";
import {
  createKitWindow, COMMERCE_WINDOW_ID, KIT_COLOR, kitButton, fillSlotIcon,
  wireDropTarget, inventoryRows, objectDisplayName, selectedTargetGuid, getHandle, devHex,
} from "./commerce_window.js";
import {
  houseTypeName, mapCoordsText, fmtNumber,
  composeHousePaymentText, composeHousePaymentText2, houseRentSchedule, houseRentWarning,
  housePurchaseWaitText, houseTimeText, houseStagedPaidInFull,
} from "./commerce_logic.js";
import { landblockToWorld } from "./ground_container_rules.js";
import { slumlordRangeVerdict, SLUMLORD_RANGE_POLL_MS } from "./slumlord_range.js";

const OVERLAY_ID = "hb-house-panel";
const STYLE_ID = "hb-house-panel-style";

// ACE WeenieError codes carried by HouseStatus (0x0226).
const WEENIE_ERROR_NONE = 0x0000;
const WEENIE_ERROR_BAD_PARAM = 0x0002;
const WEENIE_ERROR_HOUSE_EVICTED = 0x045F;
// PropertyInt.HousePurchaseTimestamp — gmHouseUI::DisplayPurchaseTimeText
// reads PlayerDesc InqInt(0xC7).
const PROP_INT_HOUSE_PURCHASE_TIMESTAMP = 199;

const TABS = [
  { id: "house", label: "House" },
  { id: "buy", label: "Buy" },
  { id: "maintenance", label: "Maintenance" },
  { id: "guests", label: "Guests" },
];

let win = null;
let refs = null;
let currentTab = "house";
let slumlordGuid = 0;
const payment = { buy: [], maintenance: [] }; // [{guid,wcid,name,iconId,stackSize,itemType,value}]
let statusPollTimer = null;
// Rec #182 — last-seen snapshot signature so the poll only re-renders (and
// emits `houseStatusUpdated`) when the house data actually changed.
let _lastHouseSnapSig = "";
// messages-objects-3: the crystal a HouseProfile open registered for the
// range close (0 = none, e.g. a manual open), its 1 s timer, and whether
// the crystal has had a position since.
let rangeCrystalGuid = 0;
let rangeTimer = null;
let rangeCrystalSeen = false;

function ensureStyles() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    #${OVERLAY_ID} { width: 360px; height: 330px; }
    #${OVERLAY_ID} .hhp-tabs .hbk-tab { flex: 1 1 0; }
    #${OVERLAY_ID} .hhp-page { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
    #${OVERLAY_ID} .hhp-page[hidden] { display: none; }
    #${OVERLAY_ID} .hhp-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 6px 10px; }
    #${OVERLAY_ID} .hhp-kv { display: flex; justify-content: space-between; gap: 10px; min-height: 18px; align-items: center; }
    #${OVERLAY_ID} .hhp-kv > :first-child { color: var(--hbk-text-dim); flex: 0 0 auto; }
    #${OVERLAY_ID} .hhp-kv > :last-child { text-align: right; min-width: 0; overflow: hidden; }
    #${OVERLAY_ID} .hhp-note { color: var(--hbk-text-dim); font-size: 11px; line-height: 14px; padding: 4px 0; }
    #${OVERLAY_ID} .hhp-note.is-faint { color: var(--hbk-text-faint); font-style: italic; }
    #${OVERLAY_ID} .hhp-slumlord { display: flex; align-items: center; gap: 6px; padding: 2px 0 4px; }
    #${OVERLAY_ID} .hhp-slumlord-name { flex: 1 1 auto; min-width: 0; overflow: hidden; }
    #${OVERLAY_ID} .hhp-well { height: 96px; min-height: 60px; overflow-y: auto; margin: 4px 0; }
    #${OVERLAY_ID} .hhp-well .hb-cw-grid { gap: 3px; }
    #${OVERLAY_ID} .hhp-well .hbk-slot { cursor: pointer; }
    #${OVERLAY_ID} .hhp-field { display: flex; gap: 6px; align-items: center; padding: 3px 0; }
    #${OVERLAY_ID} .hhp-field input.hbk-input { flex: 1 1 auto; min-width: 0; }
    #${OVERLAY_ID} .hhp-due-soon { color: #e0c050; }
    #${OVERLAY_ID} .hhp-due-overdue { color: var(--hbk-warn); }
    #${OVERLAY_ID} .hhp-text { font-size: 11px; line-height: 14px; padding: 2px 0; color: var(--hbk-text); overflow-wrap: anywhere; }
    #${OVERLAY_ID} .hhp-text-label { color: var(--hbk-text-dim); }
    #${OVERLAY_ID} .hhp-note.is-paid { color: var(--hbk-value); }
    #${OVERLAY_ID} .hhp-note.is-unpaid { color: var(--hbk-warn); }
  `;
  document.head.appendChild(s);
}

function el(tag, cls, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
}

function kvRow(parent, label, value, color = KIT_COLOR.text) {
  const row = el("div", "hhp-kv", parent);
  const a = el("span", "", row);
  setAcText(a, label, { color: KIT_COLOR.dim });
  const b = el("span", "", row);
  setAcText(b, value, { color, fit: true });
  b.title = value;
  return row;
}

// A label + a value that wraps (payment lists run long; kvRow fits its
// value onto one line).
function textRow(parent, label, value) {
  const row = el("div", "hhp-text", parent);
  const a = el("span", "hhp-text-label", row);
  a.textContent = `${label}: `;
  const b = el("span", "", row);
  b.textContent = value;
  return row;
}

function noteRow(parent, text, cls = "") {
  const n = el("div", cls ? `hhp-note ${cls}` : "hhp-note", parent);
  n.textContent = text;
  return n;
}

// ─── Snapshots (wasm boxes copied to plain objects, then freed) ───────

function readSnap(getter) {
  const h = getHandle();
  if (typeof h?.[getter] !== "function") return null;
  let o = null;
  try { o = h[getter](); } catch (e) { console.warn(`[house-panel] ${getter} threw:`, e); return null; }
  if (!o) return null;
  const out = {};
  for (const k of ["errorCode", "isHouseOwner", "buyTime", "houseType", "landblockId", "maintenanceFree",
    "posX", "posY", "posZ", "rentTime", "bitmask", "crystalGuid", "dwellingId", "ownerId", "ownerName",
    "guestCount", "isOpen", "monarchId", "objectGuid", "storageCount", "version", "seq"]) {
    try { if (o[k] !== undefined) out[k] = o[k]; } catch (_) {}
  }
  // hud-ui-1: the HousePayment lists (HouseData / HouseProfile) as plain
  // `{num, paid, weenieId, name, pluralName}` rows; absent on a stale pkg/.
  for (const k of ["buy", "rent"]) {
    try {
      const v = o[k];
      if (v && typeof v.length === "number") out[k] = Array.from(v, (p) => ({ ...p }));
    } catch (_) {}
  }
  try { o.free?.(); } catch (_) {}
  return out;
}

function paymentsSig(list) {
  return Array.isArray(list) ? list.map((p) => `${p.weenieId >>> 0}/${p.paid | 0}/${p.num | 0}`).join(",") : "-";
}

function readAll() {
  return {
    status: readSnap("playerHouseStatus"),
    data: readSnap("playerHouseData"),
    profile: readSnap("playerHouseProfile"),
    restrictions: readSnap("playerHouseRestrictions"),
  };
}

function signatureOf(s) {
  return [
    (s.status?.errorCode >>> 0) || 0,
    (s.data?.landblockId >>> 0) || 0,
    (s.data?.buyTime >>> 0) || 0,
    (s.data?.rentTime >>> 0) || 0,
    s.data?.maintenanceFree ? 1 : 0,
    paymentsSig(s.data?.buy),
    paymentsSig(s.data?.rent),
    paymentsSig(s.profile?.buy),
    paymentsSig(s.profile?.rent),
    (s.profile?.dwellingId >>> 0) || 0,
    (s.profile?.ownerId >>> 0) || 0,
    (s.profile?.crystalGuid >>> 0) || 0,
    (s.restrictions?.version >>> 0) || 0,
    (s.restrictions?.guestCount >>> 0) || 0,
  ].join(":");
}

function localGuid() {
  try { return (window.getLocalPlayerGuid?.() ?? 0) >>> 0; } catch (_) { return 0; }
}

// PlayerDesc PropertyInt 199 (HousePurchaseTimestamp) — ACE sends it on
// login; an unset property reads 0 like retail's failed InqInt. null when
// there is no player / no `objectIntProperty` export (stale pkg/): retail
// skips the line when the PlayerDesc interface is missing.
function housePurchaseTimestamp() {
  const h = getHandle();
  const me = localGuid();
  if (!me || typeof h?.objectIntProperty !== "function") return null;
  try { return Number(h.objectIntProperty(me, PROP_INT_HOUSE_PURCHASE_TIMESTAMP)) || 0; } catch (_) { return null; }
}

// ─── Build ────────────────────────────────────────────────────────────

function buildPanel() {
  ensureStyles();
  win = createKitWindow({
    id: OVERLAY_ID,
    title: "Housing",
    windowId: COMMERCE_WINDOW_ID.HOUSE,
    defaultPos: {
      left: "0px", right: "0px", bottom: "auto",
      top: `max(4px, min(120px, calc(100 * var(--hb-hud-vh, 1vh) - 338px)))`,
    },
    className: "hb-house",
    // Any close (X, Esc, range) ends the range registration, as retail's
    // hide unregisters it.
    onHide: () => { stopPoll(); stopSlumlordRange(); },
  });
  win.root.style.marginLeft = "auto";
  win.root.style.marginRight = "auto";

  const tabs = el("div", "hbk-tabs hhp-tabs", win.body);
  tabs.setAttribute("role", "tablist");
  const tabEls = {};
  for (const t of TABS) {
    const b = el("button", "hbk-tab", tabs);
    b.type = "button";
    b.setAttribute("role", "tab");
    setAcText(b, t.label, { color: KIT_COLOR.text });
    b.addEventListener("click", () => { currentTab = t.id; render(); });
    tabEls[t.id] = b;
  }

  const pages = {};
  for (const t of TABS) {
    const p = el("div", "hhp-page", win.body);
    p.dataset.page = t.id;
    pages[t.id] = p;
  }

  // House page.
  const houseInfo = el("div", "hhp-scroll hbk-scroll", pages.house);
  const houseFooter = el("div", "hbk-footer", pages.house);
  const abandonBtn = kitButton("Abandon House", "hbk-btn-small hbk-brown", onAbandon);
  abandonBtn.title = "Give up your house (cannot be undone)";
  const queryBtn = kitButton("Query House", "hbk-btn", onQuery);
  queryBtn.title = "Ask the server for your house details";
  houseFooter.append(abandonBtn, queryBtn);

  // Buy + Maintenance pages share a builder.
  const slum = {};
  for (const which of ["buy", "maintenance"]) {
    const page = pages[which];
    const scroll = el("div", "hhp-scroll hbk-scroll", page);
    const slumRow = el("div", "hhp-slumlord", scroll);
    const slumName = el("div", "hhp-slumlord-name", slumRow);
    const useSel = kitButton("Use Selected", "hbk-btn-small", () => {
      const g = selectedTargetGuid();
      if (!g) { win.toast("Select the house's covenant crystal first", "err"); return; }
      slumlordGuid = g;
      render();
    });
    useSel.title = "Use your current target as the house's covenant crystal";
    slumRow.appendChild(useSel);
    const info = el("div", "", scroll);
    const well = el("div", "hhp-well hbk-scroll hb-cw-drop", scroll);
    wireDropTarget(well, DropItemFlags.CONTAINER, (guid) => stagePayment(which, guid));
    const footer = el("div", "hbk-footer", page);
    const clear = kitButton("Clear", "hbk-btn-small", () => { payment[which] = []; render(); });
    const go = kitButton(which === "buy" ? "Buy" : "Pay Maintenance", "hbk-btn", () => onPay(which));
    footer.append(clear, go);
    slum[which] = { slumName, info, well, clear, go };
  }

  // Guests page.
  const guestScroll = el("div", "hhp-scroll hbk-scroll", pages.guests);
  const guestInfo = el("div", "", guestScroll);
  el("div", "hbk-divider", guestScroll);
  const addField = el("div", "hhp-field", guestScroll);
  const addInput = el("input", "hbk-input", addField);
  addInput.type = "text";
  addInput.placeholder = "Player name";
  addInput.spellcheck = false;
  addInput.autocomplete = "off";
  const addBtn = kitButton("Add Guest", "hbk-btn", () => onAddGuest(addInput));
  addField.appendChild(addBtn);
  addInput.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); onAddGuest(addInput); } });
  const bootField = el("div", "hhp-field", guestScroll);
  const bootInput = el("input", "hbk-input", bootField);
  bootInput.type = "text";
  bootInput.placeholder = "Player name";
  bootInput.spellcheck = false;
  bootInput.autocomplete = "off";
  const bootBtn = kitButton("Boot", "hbk-btn", () => onBootGuest(bootInput));
  bootBtn.title = "Remove this player from your house";
  bootField.appendChild(bootBtn);
  const guestNote = el("div", "hhp-note is-faint", guestScroll);
  guestNote.textContent = "Guests can enter your house even when it is private.";
  const guestFooter = el("div", "hbk-footer", pages.guests);
  const removeAll = kitButton("Remove All Guests", "hbk-btn-small hbk-brown", onRemoveAllGuests);
  guestFooter.appendChild(removeAll);

  refs = { tabs: tabEls, pages, houseInfo, abandonBtn, queryBtn, slum, guestInfo };
}

// ─── Render ──────────────────────────────────────────────────────────

function render() {
  if (!refs) return;
  const snap = readAll();
  for (const t of TABS) {
    const active = t.id === currentTab;
    refs.tabs[t.id].setAttribute("aria-selected", active ? "true" : "false");
    setAcText(refs.tabs[t.id], t.label, { color: active ? KIT_COLOR.gold : KIT_COLOR.text });
    refs.pages[t.id].hidden = !active;
  }
  renderHouse(snap);
  renderSlumlord("buy", snap);
  renderSlumlord("maintenance", snap);
  renderGuests(snap);
}

/**
 * housing-2 (2026-10-08, round 4): retail gmHouseUI keeps ONE house record
 * — HouseData (0x0225) sets it (gmHouseUI::Update(HouseData*),
 * acclient.c:219536) and HouseStatus (0x0226), a failed house transaction
 * (CM_House::DispatchUI_Recv_HouseStatus :707289 →
 * SendNotice_FailedHouseTransaction), deletes it (Update(eError) :219577).
 * ACE answers Query House with HouseData when you own one and HouseStatus
 * (BadParam) when you don't; eviction sends HouseStatus(HouseEvicted). So
 * owner = HouseData present (the wasm recv loop clears the other snapshot
 * when one arrives); a status is only ever a failure / no-house notice.
 * `?houseOwnerFromData=off` restores the old "status code 0 = owner" rule.
 */
export function houseOwnerFromDataEnabled() {
  try {
    const v = new URLSearchParams(globalThis.location?.search ?? "").get("houseOwnerFromData");
    return !(v === "off" || v === "0" || v === "false");
  } catch (_) { return true; }
}

export function ownership(snap) {
  if (houseOwnerFromDataEnabled()) {
    if (snap?.data) return { owner: true, text: "You own a house", color: KIT_COLOR.value };
    if (!snap?.status) return { owner: false, text: "Not looked up yet — press Query House.", color: KIT_COLOR.dim };
    const failed = snap.status.errorCode >>> 0;
    if (failed === WEENIE_ERROR_HOUSE_EVICTED) return { owner: false, text: "You were evicted", color: KIT_COLOR.warn };
    return { owner: false, text: "You do not own a house", color: KIT_COLOR.dim };
  }
  if (!snap.status) return { owner: false, text: "Not looked up yet — press Query House.", color: KIT_COLOR.dim };
  const code = snap.status.errorCode >>> 0;
  if (code === WEENIE_ERROR_NONE) return { owner: true, text: "You own a house", color: KIT_COLOR.value };
  if (code === WEENIE_ERROR_HOUSE_EVICTED) return { owner: false, text: "You were evicted", color: KIT_COLOR.warn };
  if (code === WEENIE_ERROR_BAD_PARAM) return { owner: false, text: "You do not own a house", color: KIT_COLOR.dim };
  return { owner: false, text: "Unknown", color: KIT_COLOR.dim };
}

function renderHouse(snap) {
  const host = refs.houseInfo;
  host.replaceChildren();
  const own = ownership(snap);
  kvRow(host, "Status", own.text, own.color);
  const d = own.owner ? snap.data : null;
  let warning = null;
  if (d) {
    kvRow(host, "Dwelling", houseTypeName(d.houseType), KIT_COLOR.gold);
    // hud-ui-1: gmHouseUI::DisplayHouseData (acclient.c:219515) order —
    // BuyPayment, RentPayment, BuyTime, RentTimes, Location, WarningText
    // (below the access rows), PurchaseTimeText (last). The lists are
    // absent on a stale pkg/: no price / rent rows and no paid verdict.
    if (Array.isArray(d.buy)) textRow(host, "Purchase price", composeHousePaymentText(d.buy) || "None");
    if (Array.isArray(d.rent)) textRow(host, "Rent", composeHousePaymentText2(d.rent) || "None");
    kvRow(host, "Bought", houseTimeText(d.buyTime));
    // DisplayRentTimes (:219228): the period is 30 days (90 for an
    // apartment) from RentTime, the START of the current period; next due
    // is one period later again once the rent is paid (or free).
    const sched = houseRentSchedule(d);
    kvRow(host, "Period ends", houseTimeText(sched.periodEnds));
    if (sched.nextDue !== null) kvRow(host, "Next due", houseTimeText(sched.nextDue));
    const coords = mapCoordsText(d.landblockId, Number(d.posX), Number(d.posY));
    if (coords) kvRow(host, "Location", coords);
    warning = houseRentWarning(d);
  } else if (snap.profile && own.owner) {
    kvRow(host, "Dwelling", houseTypeName(snap.profile.houseType), KIT_COLOR.gold);
  }
  if (snap.restrictions) {
    kvRow(host, "Access", snap.restrictions.isOpen ? "Open to the public" : "Private");
    const g = snap.restrictions.guestCount >>> 0;
    const st = snap.restrictions.storageCount >>> 0;
    kvRow(host, "Guests", `${fmtNumber(g)} (${fmtNumber(st)} with storage)`);
  }
  // DisplayWarningText (:219354): RentPaid / RentNotPaid colour.
  if (warning) noteRow(host, warning.text, warning.level === "paid" ? "is-paid" : "is-unpaid");
  // DisplayPurchaseTimeText (:219403) — shown with or without a house.
  const purchaseTime = housePurchaseTimestamp();
  if (purchaseTime !== null) noteRow(host, housePurchaseWaitText(purchaseTime, !!d));
  if (!own.owner) {
    const note = el("div", "hhp-note", host);
    note.textContent = "To buy a house, use its covenant crystal — the Buy tab opens with the house filled in. Drag the payment items from your pack, then press Buy.";
  }
  refs.abandonBtn.disabled = !own.owner;
}

function renderSlumlord(which, snap) {
  const r = refs.slum[which];
  const prof = snap.profile;
  const fromProfile = prof && (prof.crystalGuid >>> 0) === (slumlordGuid >>> 0);
  if (slumlordGuid) {
    setAcText(r.slumName, objectDisplayName(slumlordGuid, "Covenant crystal"), { color: KIT_COLOR.gold, fit: true });
  } else {
    setAcText(r.slumName, "No house selected", { color: KIT_COLOR.faint, fit: true });
  }
  r.info.replaceChildren();
  // hud-ui-1: the profile's list for this page (null = unknown: another
  // crystal, or a stale pkg/ without the lists).
  let required = null;
  if (fromProfile) {
    kvRow(r.info, "Dwelling", houseTypeName(prof.houseType), KIT_COLOR.text);
    const ownerId = prof.ownerId >>> 0;
    const mine = ownerId && ownerId === localGuid();
    kvRow(r.info, "Owner", ownerId ? (mine ? "You" : (prof.ownerName || "Someone else")) : "For sale",
      ownerId ? (mine ? KIT_COLOR.value : KIT_COLOR.text) : KIT_COLOR.value);
    if (prof.maintenanceFree) kvRow(r.info, "Maintenance", "Free this period", KIT_COLOR.value);
    // gmSlumlordUI::RefreshHouse (acclient.c:250255): the Buy page shows
    // HouseProfile::ComposeText(Buy_House) ("num name, …"), the Maintenance
    // page ComposeText2(Rent_House) ("paid/num name, …").
    const reqList = which === "buy" ? prof.buy : prof.rent;
    if (Array.isArray(reqList)) {
      required = reqList;
      const text = which === "buy" ? composeHousePaymentText(reqList) : composeHousePaymentText2(reqList);
      textRow(r.info, which === "buy" ? "Price" : "Rent", text || "None");
    }
  }
  const note = el("div", "hhp-note", r.info);
  note.textContent = which === "buy"
    ? "Drag the purchase items from your pack into the box below."
    : "Drag the maintenance payment from your pack into the box below.";

  r.well.replaceChildren();
  const list = payment[which];
  if (list.length === 0) {
    const hint = el("div", "hb-cw-hint", r.well);
    hint.textContent = "Drop payment items here";
  } else {
    const grid = el("div", "hb-cw-grid", r.well);
    list.forEach((it, i) => {
      const slot = el("div", "hbk-slot", grid);
      // hud-ui-3: retail composite icon (commerce_window.slotIconMeta).
      fillSlotIcon(slot, { guid: it.guid, iconId: it.iconId, itemType: it.itemType }, it.name);
      if ((it.stackSize || 1) > 1) {
        const st = el("span", "hbk-stack", slot);
        st.textContent = fmtNumber(it.stackSize);
      }
      slot.title = `${it.name}${(it.stackSize || 1) > 1 ? ` (${fmtNumber(it.stackSize)})` : ""} — click to take back`;
      slot.addEventListener("click", () => { payment[which].splice(i, 1); render(); });
    });
  }
  r.clear.disabled = list.length === 0;
  let canPay = !!slumlordGuid && list.length > 0;
  r.go.title = "";
  // gmSlumlordUI::UpdateButtons (acclient.c:249621): Buy only for an
  // unowned house whose buy list the staged items pay in full
  // (HouseProfile::IsPaidInFull(Buy_House) after CleanItemLists zeroed the
  // server's paid); Maintenance whenever an item is staged.
  if (canPay && which === "buy" && required) {
    canPay = !(prof.ownerId >>> 0) && houseStagedPaidInFull(required, list);
    if (!canPay) r.go.title = (prof.ownerId >>> 0) ? "This house is already owned" : "Place the full purchase price first";
  }
  r.go.disabled = !canPay;
}

function renderGuests(snap) {
  const host = refs.guestInfo;
  host.replaceChildren();
  if (snap.restrictions) {
    kvRow(host, "Access", snap.restrictions.isOpen ? "Open to the public" : "Private");
    kvRow(host, "Guests", fmtNumber(snap.restrictions.guestCount >>> 0));
  } else {
    const n = el("div", "hhp-note is-faint", host);
    n.textContent = "Guest list not loaded — press Query House on the House tab.";
  }
}

// ─── Actions ─────────────────────────────────────────────────────────

function stagePayment(which, guid) {
  const g = guid >>> 0;
  const item = inventoryRows().find((r) => r.guid === g);
  if (!item) {
    win.toast("You can only pay with items you are carrying", "err");
    return;
  }
  if ((item.equipMask >>> 0) !== 0) {
    win.toast(`Unequip ${item.name} first`, "err");
    return;
  }
  if (payment[which].some((p) => p.guid === g)) return;
  // wcid / itemType / value: what the item pays toward the slumlord's list
  // (housePaymentContribution — the Buy button's paid-in-full check).
  payment[which].push({
    guid: g, wcid: item.wcid >>> 0, name: item.name, iconId: item.iconId, stackSize: item.stackSize,
    itemType: item.itemType >>> 0, value: item.value ?? 0,
  });
  render();
}

function onPay(which) {
  const items = payment[which].map((p) => p.guid >>> 0);
  if (!slumlordGuid || items.length === 0) return;
  const buying = which === "buy";
  const house = objectDisplayName(slumlordGuid, "this house");
  modalConfirmCallback({
    title: buying ? "Purchase House" : "Pay Maintenance",
    message: buying
      ? `Buy ${house} with the ${items.length} item${items.length === 1 ? "" : "s"} you placed? They will be consumed.`
      : `Pay maintenance on ${house} with the ${items.length} item${items.length === 1 ? "" : "s"} you placed?`,
    confirmLabel: buying ? "Buy" : "Pay",
    onConfirm: () => {
      const h = getHandle();
      const fn = buying ? h?.buyHouse : h?.rentHouse;
      if (typeof fn !== "function") {
        win.toast("Not connected", "err");
        return;
      }
      try {
        fn.call(h, slumlordGuid >>> 0, Uint32Array.from(items));
        payment[which] = [];
        render();
        win.toast(buying ? "Purchase sent…" : "Payment sent…");
      } catch (e) {
        console.warn(`[house-panel] ${buying ? "buyHouse" : "rentHouse"} failed:`, e);
      }
    },
  });
}

function onQuery() {
  const h = getHandle();
  if (!h?.houseQuery) return;
  try {
    h.houseQuery();
    win.toast("Asking about your house…");
  } catch (e) {
    console.warn("[house-panel] houseQuery failed:", e);
  }
}

function onAbandon() {
  modalConfirmCallback({
    title: "Abandon House",
    message: "Abandon your house? This cannot be undone.",
    confirmLabel: "Abandon",
    onConfirm: () => {
      const h = getHandle();
      try { h?.abandonHouse?.(); } catch (e) { console.warn("[house-panel] abandonHouse failed:", e); }
    },
  });
}

function onAddGuest(input) {
  const name = String(input.value ?? "").trim();
  if (!name) { win.toast("Type a player name", "err"); return; }
  const h = getHandle();
  if (!h?.addPermanentGuest) return;
  try {
    h.addPermanentGuest(name);
    input.value = "";
    win.toast(`Invited ${name}`);
  } catch (e) {
    console.warn("[house-panel] addPermanentGuest failed:", e);
  }
}

function onBootGuest(input) {
  const name = String(input.value ?? "").trim();
  if (!name) { win.toast("Type a player name", "err"); return; }
  modalConfirmCallback({
    title: "Boot Guest",
    message: `Remove ${name} from your house?`,
    confirmLabel: "Boot",
    onConfirm: () => {
      const h = getHandle();
      try {
        h?.bootSpecificHouseGuest?.(name);
        input.value = "";
      } catch (e) {
        console.warn("[house-panel] bootSpecificHouseGuest failed:", e);
      }
    },
  });
}

function onRemoveAllGuests() {
  modalConfirmCallback({
    title: "Remove All Guests",
    message: "Clear your entire guest list? This cannot be undone.",
    confirmLabel: "Remove All",
    onConfirm: () => {
      const h = getHandle();
      try { h?.removeAllPermanentGuests?.(); } catch (e) { console.warn("[house-panel] removeAllPermanentGuests failed:", e); }
    },
  });
}

// ─── Lifecycle ───────────────────────────────────────────────────────

function startPoll() {
  if (statusPollTimer) return;
  // 1 Hz: the house getters have no bus event (see header).
  statusPollTimer = setInterval(() => {
    const sig = signatureOf(readAll());
    if (sig === _lastHouseSnapSig) return;
    _lastHouseSnapSig = sig;
    render();
    try { window.__pluginClient?.events?.emit?.("houseStatusUpdated", {}); } catch (_) {}
  }, 1000);
}

function stopPoll() {
  if (statusPollTimer) {
    clearInterval(statusPollTimer);
    statusPollTimer = null;
  }
}

function openPanel(tab) {
  if (!win) buildPanel();
  if (tab && TABS.some((t) => t.id === tab)) currentTab = tab;
  _lastHouseSnapSig = signatureOf(readAll());
  render();
  win.open();
  startPoll();
}

function closePanel() {
  win?.close();
}

// ─── Slumlord range close (messages-objects-3) ───────────────────────

/**
 * messages-objects-3 (2026-10-13): when a HouseProfile shows gmSlumlordUI,
 * retail registers a 9 m, once-a-second range check on the crystal
 * (RecvNotice_UpdateHouseProfile, acclient.c:250593) and hides the window
 * in OnObjectRangeExit (:249388) — the math is in slumlord_range.js. Only
 * that path registers; a manual open does not. `?slumlordRange=off`
 * disables the close.
 */
export function slumlordRangeEnabled() {
  try {
    const v = new URLSearchParams(globalThis.location?.search ?? "").get("slumlordRange");
    return !(v === "off" || v === "0" || v === "false");
  } catch (_) { return true; }
}

// Positions come from the wasm object store (`objectPosition` — the
// CObjectMaint that ObjectsInRange reads) in the landblock-world frame, as
// the ground-container check does: no scene needed (?nullRender), and a
// crystal the server deleted is gone. Null = unknown.
function objectWorldPos(h, guid) {
  if (!guid || typeof h?.objectPosition !== "function") return null;
  try { return landblockToWorld(Array.from(h.objectPosition(guid >>> 0) || [])); } catch (_) { return null; }
}

function playerWorldPos(h) {
  try {
    const pose = typeof h?.getLocalPlayerPose === "function" ? h.getLocalPlayerPose() : null;
    if (pose) {
      const p = landblockToWorld([pose.landblockId, pose.x, pose.y, pose.z]);
      try { pose.free?.(); } catch (_) {}
      if (p) return p;
    }
  } catch (_) {}
  return objectWorldPos(h, localGuid());
}

// `[radius, height]` of a body (CPartArray::GetRadius / GetHeight × scale);
// empty when unknown (stale pkg/, Setup not resident yet).
function partDims(h, guid) {
  if (!guid || typeof h?.objectPartDims !== "function") return [];
  try { return Array.from(h.objectPartDims(guid >>> 0) || []); } catch (_) { return []; }
}

/**
 * One CHECK_LORD_INTERVAL sweep (the 1 s timer runs it; tests call it).
 * Closes the window when the registered crystal is out of range or gone.
 * @returns {"off"|"unknown"|"ok"|"close"} "off" = nothing registered.
 */
export function slumlordRangeTick() {
  if (!rangeCrystalGuid) return "off";
  if (!win?.isOpen()) { stopSlumlordRange(); return "off"; }
  const g = rangeCrystalGuid;
  const h = getHandle();
  const pp = playerWorldPos(h);
  if (!pp) return "unknown";
  const cp = objectWorldPos(h, g);
  if (!cp) {
    // ObjectsInRange is 0 for a missing object, but only once we have seen
    // the crystal: its position may not have arrived yet.
    if (!rangeCrystalSeen) return "unknown";
    console.info(`[slumlord-range] crystal ${devHex(g)} is gone — closing`);
    closePanel();
    return "close";
  }
  rangeCrystalSeen = true;
  const v = slumlordRangeVerdict({ crystalDims: partDims(h, g), playerDims: partDims(h, localGuid()) }, cp, pp);
  if (v.inRange) return "ok";
  console.info(
    `[slumlord-range] crystal ${devHex(g)} out of range ` +
    `(${v.mode} distance ${v.dist.toFixed(2)}m > ${v.range.toFixed(2)}m) — closing`,
  );
  closePanel();
  return "close";
}

function startSlumlordRange(crystalGuid) {
  stopSlumlordRange();
  if (!slumlordRangeEnabled() || !(crystalGuid >>> 0)) return;
  rangeCrystalGuid = crystalGuid >>> 0;
  rangeTimer = setInterval(() => {
    try { slumlordRangeTick(); } catch (_) {}
  }, SLUMLORD_RANGE_POLL_MS);
}

function stopSlumlordRange() {
  if (rangeTimer) {
    clearInterval(rangeTimer);
    rangeTimer = null;
  }
  rangeCrystalGuid = 0;
  rangeCrystalSeen = false;
}

// Slumlord watcher — retail opens gmSlumlordUI on the HouseProfile event
// (you used a covenant crystal). The profile has no bus event, so watch
// its identity at 1 Hz (one cheap getter) and open the window when it
// changes: Buy for a house that isn't yours, Maintenance for your own.
// messages-objects-3: retail re-shows (and re-registers the range check)
// on EVERY HouseProfile, so the wasm `seq` receipt counter is part of the
// identity — using the same crystal again after walking off reopens the
// window. A stale pkg/ (no seq) keeps the old dwelling:crystal:owner key.
let _profileSig = null;
export function watchProfile() {
  const p = readSnap("playerHouseProfile");
  const sig = p
    ? `${p.dwellingId >>> 0}:${p.crystalGuid >>> 0}:${p.ownerId >>> 0}${Number.isFinite(p.seq) ? `#${p.seq >>> 0}` : ""}`
    : "";
  if (_profileSig === null) { _profileSig = sig; return; } // first look: no auto-open
  if (sig === _profileSig) return;
  _profileSig = sig;
  if (!p || !(p.crystalGuid >>> 0)) return;
  if ((p.crystalGuid >>> 0) !== (slumlordGuid >>> 0)) {
    payment.buy = [];
    payment.maintenance = [];
  }
  slumlordGuid = p.crystalGuid >>> 0;
  const mine = (p.ownerId >>> 0) && (p.ownerId >>> 0) === localGuid();
  openPanel(mine ? "maintenance" : "buy");
  startSlumlordRange(slumlordGuid);
}

if (typeof window !== "undefined") {
  window.__openHousePanel = (tab) => openPanel(typeof tab === "string" ? tab : undefined);
  window.__closeHousePanel = closePanel;
  window.__toggleHousePanel = () => {
    if (win?.isOpen()) closePanel();
    else openPanel();
  };
  const startWatch = () => {
    if (window.__hbHouseProfileWatch) return;
    window.__hbHouseProfileWatch = setInterval(() => {
      if (!getHandle()) return;
      try { watchProfile(); } catch (_) {}
    }, 1000);
  };
  if (window.__pluginClientReady?.then) window.__pluginClientReady.then(startWatch, startWatch);
  else startWatch();
}

export const manifest = {
  id: "house-panel",
  name: "House",
  icon: "H",
  iconHidden: true,
  version: "0.2.0",
  description: "Housing — status, buy / maintenance via the covenant crystal, guests",
};
