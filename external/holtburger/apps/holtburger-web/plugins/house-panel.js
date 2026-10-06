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
//   House        — status, dwelling, location (map coords, not a hex
//                  landblock), purchase date, maintenance due (coloured),
//                  access + guest counts; Query House / Abandon House.
//   Buy          — the slumlord (auto-filled from HouseProfile.crystalGuid,
//   Maintenance    or "Use Selected" from your target), its owner / type,
//                  and a drop well for the payment items dragged from your
//                  pack (no more typing GUIDs); Buy / Pay Maintenance.
//   Guests       — add / boot by name, remove all (kit confirm modal).
// When a HouseProfile arrives (you used a slumlord) the window opens on Buy
// — or Maintenance if the house is yours — like retail's slumlord strip.
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
  wireDropTarget, inventoryRows, objectDisplayName, selectedTargetGuid, getHandle,
} from "./commerce_window.js";
import {
  houseTypeName, mapCoordsText, rentDueInfo, fmtNumber,
} from "./commerce_logic.js";

const OVERLAY_ID = "hb-house-panel";
const STYLE_ID = "hb-house-panel-style";

// ACE WeenieError codes carried by HouseStatus (0x0226).
const WEENIE_ERROR_NONE = 0x0000;
const WEENIE_ERROR_BAD_PARAM = 0x0002;
const WEENIE_ERROR_HOUSE_EVICTED = 0x045F;

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
const payment = { buy: [], maintenance: [] }; // [{guid,name,iconId,stackSize}]
let statusPollTimer = null;
// Rec #182 — last-seen snapshot signature so the poll only re-renders (and
// emits `houseStatusUpdated`) when the house data actually changed.
let _lastHouseSnapSig = "";

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
    "guestCount", "isOpen", "monarchId", "objectGuid", "storageCount", "version"]) {
    try { if (o[k] !== undefined) out[k] = o[k]; } catch (_) {}
  }
  try { o.free?.(); } catch (_) {}
  return out;
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
    onHide: () => stopPoll(),
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

function ownership(snap) {
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
  if (d) {
    kvRow(host, "Dwelling", houseTypeName(d.houseType), KIT_COLOR.gold);
    const coords = mapCoordsText(d.landblockId, Number(d.posX), Number(d.posY));
    if (coords) kvRow(host, "Location", coords);
    if (d.buyTime >>> 0) {
      kvRow(host, "Purchased", new Date((d.buyTime >>> 0) * 1000).toLocaleDateString());
    }
    const due = rentDueInfo(d.rentTime, !!d.maintenanceFree);
    kvRow(host, "Maintenance", due.text,
      due.level === "overdue" ? KIT_COLOR.warn : due.level === "soon" ? "#e0c050" : KIT_COLOR.value);
  } else if (snap.profile && own.owner) {
    kvRow(host, "Dwelling", houseTypeName(snap.profile.houseType), KIT_COLOR.gold);
  }
  if (snap.restrictions) {
    kvRow(host, "Access", snap.restrictions.isOpen ? "Open to the public" : "Private");
    const g = snap.restrictions.guestCount >>> 0;
    const st = snap.restrictions.storageCount >>> 0;
    kvRow(host, "Guests", `${fmtNumber(g)} (${fmtNumber(st)} with storage)`);
  }
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
  if (fromProfile) {
    kvRow(r.info, "Dwelling", houseTypeName(prof.houseType), KIT_COLOR.text);
    const ownerId = prof.ownerId >>> 0;
    const mine = ownerId && ownerId === localGuid();
    kvRow(r.info, "Owner", ownerId ? (mine ? "You" : (prof.ownerName || "Someone else")) : "For sale",
      ownerId ? (mine ? KIT_COLOR.value : KIT_COLOR.text) : KIT_COLOR.value);
    if (prof.maintenanceFree) kvRow(r.info, "Maintenance", "Free this period", KIT_COLOR.value);
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
      fillSlotIcon(slot, it.iconId, it.name);
      if ((it.stackSize || 1) > 1) {
        const st = el("span", "hbk-stack", slot);
        st.textContent = fmtNumber(it.stackSize);
      }
      slot.title = `${it.name}${(it.stackSize || 1) > 1 ? ` (${fmtNumber(it.stackSize)})` : ""} — click to take back`;
      slot.addEventListener("click", () => { payment[which].splice(i, 1); render(); });
    });
  }
  r.clear.disabled = list.length === 0;
  r.go.disabled = !slumlordGuid || list.length === 0;
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
  payment[which].push({ guid: g, name: item.name, iconId: item.iconId, stackSize: item.stackSize });
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

// Slumlord watcher — retail opens gmSlumlordUI on the HouseProfile event
// (you used a covenant crystal). The profile has no bus event, so watch
// its identity at 1 Hz (one cheap getter) and open the window when it
// changes: Buy for a house that isn't yours, Maintenance for your own.
let _profileSig = null;
function watchProfile() {
  const p = readSnap("playerHouseProfile");
  const sig = p ? `${p.dwellingId >>> 0}:${p.crystalGuid >>> 0}:${p.ownerId >>> 0}` : "";
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
