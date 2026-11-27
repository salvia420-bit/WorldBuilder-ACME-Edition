// scene3d/vehicle/economy_hud.js — Town Control, Prospecting, Industry & Logistics DOM HUD (`#hb-economy-hud`)
// Zero Canvas2D, zero innerHTML, dirty-checked DOM updates, guaranteed 0 DOM writes after dispose().
// Uses `id="hb-economy-hud"` so `[id^=hb-]` hides it cleanly in screenshots when requested.

export const ECONOMY_HUD_ID = "hb-economy-hud";
export const ECONOMY_HUD_STYLE_ID = "hb-economy-hud-style";

const CONTROL_STATE_NAMES = Object.freeze({
  0: "UNCLAIMED",
  1: "HELD",
  2: "BREACHING",
  3: "CONTESTED",
  4: "RECEIVERSHIP",
});

const SIEGE_KIND_NAMES = Object.freeze({
  1: "BREACH STARTED",
  2: "CONTESTED HOLD",
  3: "SUPPLY DEPOSITED",
  4: "STARVATION WARNING",
  5: "SIEGE COLLAPSED",
  6: "TOWN CAPTURED",
  7: "RECEIVERSHIP",
});

const CSS = `
#${ECONOMY_HUD_ID}{position:fixed;right:16px;top:64px;z-index:58;pointer-events:none;width:296px;
  font:600 11.5px/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#e6f4ff;
  text-shadow:0 1px 2px rgba(0,0,0,.92)}
#${ECONOMY_HUD_ID} .hb-econ-panel{background:rgba(10,16,24,.84);border:1.5px solid rgba(112,188,236,.46);
  border-radius:8px;padding:8px 11px;box-shadow:0 6px 18px rgba(0,0,0,.55);display:flex;flex-direction:column;gap:6px}
#${ECONOMY_HUD_ID} .hb-econ-hdr{display:flex;justify-content:space-between;align-items:center;
  border-bottom:1px solid rgba(112,188,236,.28);padding-bottom:4px}
#${ECONOMY_HUD_ID} .hb-econ-title{font-size:11px;font-weight:800;letter-spacing:.09em;color:#8ad4f8;text-transform:uppercase}
#${ECONOMY_HUD_ID} .hb-econ-badge{padding:1px 6px;border-radius:4px;font-size:10px;font-weight:800;
  border:1px solid rgba(112,188,236,.45);background:rgba(18,42,64,.88);color:#d6f2ff}
#${ECONOMY_HUD_ID} .hb-econ-badge.warn{background:rgba(86,54,14,.90);border-color:#ffbc48;color:#fff4dc}
#${ECONOMY_HUD_ID} .hb-econ-badge.crit{background:rgba(116,28,24,.90);border-color:#ff6a5a;color:#ffecea}
#${ECONOMY_HUD_ID} .hb-econ-badge.ok{background:rgba(16,74,50,.90);border-color:#4ae598;color:#eafff4}
#${ECONOMY_HUD_ID} .hb-econ-sec{display:flex;flex-direction:column;gap:2px;border-top:1px solid rgba(112,188,236,.16);padding-top:4px}
#${ECONOMY_HUD_ID} .hb-econ-lbl{font-size:10px;font-weight:800;letter-spacing:.07em;color:#74b9dc;text-transform:uppercase}
#${ECONOMY_HUD_ID} .hb-econ-row{display:flex;justify-content:space-between;gap:8px;font-size:11px;color:#cae6f8}
#${ECONOMY_HUD_ID} .hb-econ-val{font-weight:800;color:#f2f9ff;text-align:right}
`;

function mkEl(doc, tag, cls = "", id = "") {
  const n = doc.createElement(tag);
  if (!n.style) n.style = {};
  if (cls) n.className = cls;
  if (id) n.id = id;
  return n;
}

function append(parent, child) {
  if (parent && child && typeof parent.appendChild === "function") parent.appendChild(child);
  return child;
}

function toFiniteNumber(v, fallback = 0) {
  if (v === null || v === undefined || typeof v === "boolean" || typeof v === "object") return fallback;
  if (typeof v === "string" && v.trim() === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function fmtNum(v) {
  return Math.round(toFiniteNumber(v, 0)).toLocaleString("en-US");
}

function fmtFixed(v, digits = 2, fallback = 0) {
  return toFiniteNumber(v, fallback).toFixed(digits);
}

function fmtId(v) {
  if (typeof v === "bigint") return v >= 0n ? v.toString() : "0";
  if (typeof v === "number") return Number.isFinite(v) ? String(Math.trunc(v)) : "0";
  if (typeof v === "string") {
    const s = v.trim();
    return /^\d+$/.test(s) ? s : "0";
  }
  return "0";
}

function fmtClock(sec) {
  const n = toFiniteNumber(sec, 0);
  const s = n > 0 ? Math.floor(n) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`
    : `${m}:${String(r).padStart(2, "0")}`;
}

export function createEconomyHud(deps = {}) {
  const doc = deps.document ?? (typeof document !== "undefined" ? document : null);

  let rootEl = null;
  let styleEl = null;
  let badgeEl = null;
  let townLineEl = null;
  let siegeLineEl = null;
  let treasuryLineEl = null;
  let eventLineEl = null;
  let surveyLineEl = null;
  let facilityLineEl = null;
  let convoyLineEl = null;
  let orderLineEl = null;

  let disposed = false;
  let showing = false;
  const cache = Object.create(null);

  function setTxt(node, key, val) {
    if (!node || cache[key] === val) return;
    cache[key] = val;
    node.textContent = val;
  }

  function setCls(node, key, val) {
    if (!node || cache[key] === val) return;
    cache[key] = val;
    node.className = val;
  }

  function setDisplay(val) {
    if (!rootEl || !rootEl.style || cache._disp === val) return;
    cache._disp = val;
    rootEl.style.display = val;
  }

  function ensure() {
    if (disposed || !doc || rootEl) return;
    if (typeof doc.getElementById === "function" && !doc.getElementById(ECONOMY_HUD_STYLE_ID) && doc.head) {
      styleEl = mkEl(doc, "style", "", ECONOMY_HUD_STYLE_ID);
      styleEl.textContent = CSS;
      append(doc.head, styleEl);
    }
    rootEl = mkEl(doc, "div", "", ECONOMY_HUD_ID);
    rootEl.style.display = showing ? "block" : "none";
    append(doc.body, rootEl);

    const panel = append(rootEl, mkEl(doc, "div", "hb-econ-panel"));
    const hdr = append(panel, mkEl(doc, "div", "hb-econ-hdr"));
    const title = append(hdr, mkEl(doc, "span", "hb-econ-title"));
    title.textContent = "ECONOMY / SIEGE";
    badgeEl = append(hdr, mkEl(doc, "span", "hb-econ-badge"));
    badgeEl.textContent = "IDLE";

    const townSec = append(panel, mkEl(doc, "div", "hb-econ-sec"));
    const townLbl = append(townSec, mkEl(doc, "div", "hb-econ-lbl"));
    townLbl.textContent = "TOWN CONTROL";
    townLineEl = append(townSec, mkEl(doc, "div", "hb-econ-row"));
    siegeLineEl = append(townSec, mkEl(doc, "div", "hb-econ-row"));
    treasuryLineEl = append(townSec, mkEl(doc, "div", "hb-econ-row"));
    eventLineEl = append(townSec, mkEl(doc, "div", "hb-econ-row"));

    const indSec = append(panel, mkEl(doc, "div", "hb-econ-sec"));
    const indLbl = append(indSec, mkEl(doc, "div", "hb-econ-lbl"));
    indLbl.textContent = "GEOLOGY & INDUSTRY";
    surveyLineEl = append(indSec, mkEl(doc, "div", "hb-econ-row"));
    facilityLineEl = append(indSec, mkEl(doc, "div", "hb-econ-row"));

    const logSec = append(panel, mkEl(doc, "div", "hb-econ-sec"));
    const logLbl = append(logSec, mkEl(doc, "div", "hb-econ-lbl"));
    logLbl.textContent = "LOGISTICS & ORDERS";
    convoyLineEl = append(logSec, mkEl(doc, "div", "hb-econ-row"));
    orderLineEl = append(logSec, mkEl(doc, "div", "hb-econ-row"));
  }

  function update(snapshot = null) {
    if (disposed || !doc) return;
    const s = snapshot && typeof snapshot === "object" ? snapshot : {};
    const towns = Array.isArray(s.towns) ? s.towns : [];
    const siegeEvents = Array.isArray(s.siegeEvents) ? s.siegeEvents : [];
    const surveys = Array.isArray(s.surveys) ? s.surveys : [];
    const facilities = Array.isArray(s.facilities) ? s.facilities : [];
    const convoys = Array.isArray(s.convoys) ? s.convoys : [];
    const orders = Array.isArray(s.orders) ? s.orders : [];

    ensure();
    if (!rootEl) return;
    setDisplay(showing ? "block" : "none");

    const town = towns[towns.length - 1] || null;
    if (town && typeof town === "object") {
      const stCode = Math.trunc(toFiniteNumber(town.controlState, 0));
      const stName = CONTROL_STATE_NAMES[stCode] || `STATE ${stCode}`;
      const badgeCls = stCode === 1
        ? "hb-econ-badge ok"
        : (stCode === 2 || stCode === 3 ? "hb-econ-badge crit" : (stCode === 4 ? "hb-econ-badge warn" : "hb-econ-badge"));
      setCls(badgeEl, "badgeCls", badgeCls);
      setTxt(badgeEl, "badgeTxt", stName);
      setTxt(townLineEl, "town", `Town #${fmtId(town.townId)} · Owner ${fmtId(town.ownerMonarchId)} · Atk ${fmtId(town.attackerMonarchId)}`);
      setTxt(siegeLineEl, "siege", `Hold ${fmtClock(town.holdElapsedSec)}/8:00:00 · Sup ${fmtClock(town.supplyMeterSec)}/90:00`);
      setTxt(treasuryLineEl, "treas", `Till ${fmtNum(town.treasuryPyreals)}p · Esc ${fmtNum(town.escrowPyreals)}p · x${fmtFixed(town.tariffBuyMul, 2, 1)}`);
    } else {
      setCls(badgeEl, "badgeCls", "hb-econ-badge");
      setTxt(badgeEl, "badgeTxt", `${towns.length} TOWNS`);
      setTxt(townLineEl, "town", "No town telemetry");
      setTxt(siegeLineEl, "siege", "Hold 0:00 · Supply 0:00");
      setTxt(treasuryLineEl, "treas", "Till 0p · Escrow 0p");
    }

    const ev = siegeEvents[siegeEvents.length - 1] || null;
    if (ev && typeof ev === "object") {
      const evKind = Math.trunc(toFiniteNumber(ev.kind, 0));
      setTxt(
        eventLineEl,
        "ev",
        `Evt: ${SIEGE_KIND_NAMES[evKind] || evKind} #${fmtId(ev.townId)} (${fmtNum(ev.treasurySpoils)}p)`
      );
    } else {
      setTxt(eventLineEl, "ev", "Evt: none");
    }

    const sv = surveys[surveys.length - 1] || null;
    if (sv && typeof sv === "object") {
      const attn = (Math.trunc(toFiniteNumber(sv.flags, 0)) & 0x01) ? " [EM-ATTN]" : "";
      const gradePct = toFiniteNumber(sv.gradeBps, 0) / 100;
      setTxt(
        surveyLineEl,
        "sv",
        `Dep #${fmtId(sv.depositId)}: ${fmtFixed(sv.depthM, 0, 0)}m · ${fmtFixed(gradePct, 1, 0)}% · ${fmtFixed(sv.apiGravity, 1, 0)}°API${attn}`
      );
    } else {
      setTxt(surveyLineEl, "sv", `Surveys: ${surveys.length}`);
    }

    let netKw = 0;
    for (const f of facilities) {
      if (f && typeof f === "object") netKw += toFiniteNumber(f.powerWatts, 0) / 1000;
    }
    const fac = facilities[facilities.length - 1] || null;
    setTxt(
      facilityLineEl,
      "fac",
      fac && typeof fac === "object"
        ? `Fac(${facilities.length}): #${fmtId(fac.facilityGuid)} k=${fmtId(fac.kind)} ${Math.round(toFiniteNumber(fac.progressPct, 0))}% · Net ${fmtFixed(netKw, 1, 0)} kW`
        : "Fac: 0 active"
    );

    const cv = convoys[convoys.length - 1] || null;
    let cvText = "Convoys: 0 active";
    if (cv && typeof cv === "object") {
      const vc = Math.trunc(toFiniteNumber(cv.vehicleClass, 0));
      const cvClass = vc === 4 ? " SHIP" : (vc === 3 ? " TRUCK" : "");
      const hasFuel = typeof cv.fuelLiters === "string"
        ? (cv.fuelLiters.trim().length > 0 && Number.isFinite(Number(cv.fuelLiters)))
        : (typeof cv.fuelLiters === "number" && Number.isFinite(cv.fuelLiters));
      const cvFuel = hasFuel ? ` · ${fmtFixed(cv.fuelLiters, 0, 0)}L` : "";
      cvText = `Convoy(${convoys.length}): #${fmtId(cv.convoyId)} ${cv.lodState === 1 ? "MICRO" : "MACRO"}${cvClass} ${fmtId(cv.originTownId)}->${fmtId(cv.destTownId)}${cvFuel}`;
    }
    setTxt(convoyLineEl, "cv", cvText);

    const ord = orders[orders.length - 1] || null;
    setTxt(
      orderLineEl,
      "ord",
      ord && typeof ord === "object"
        ? `Order(${orders.length}): #${fmtId(ord.orderId)} w${fmtId(ord.itemWcid)} x${fmtId(ord.quantity)} (${fmtNum(ord.rewardPyreals)}p)`
        : "Orders: 0 active"
    );
  }

  function show(snapshot = null) {
    if (disposed) return;
    showing = true;
    ensure();
    setDisplay("block");
    if (snapshot) update(snapshot);
  }

  function hide() {
    showing = false;
    setDisplay("none");
  }

  function toggle(snapshot = null) {
    if (showing) hide();
    else show(snapshot);
    return showing;
  }

  function isVisible() {
    return showing && !disposed;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    showing = false;
    try { rootEl?.parentNode?.removeChild?.(rootEl); } catch (_) {}
    try { styleEl?.parentNode?.removeChild?.(styleEl); } catch (_) {}
    rootEl = null;
    styleEl = null;
    badgeEl = null;
    townLineEl = null;
    siegeLineEl = null;
    treasuryLineEl = null;
    eventLineEl = null;
    surveyLineEl = null;
    facilityLineEl = null;
    convoyLineEl = null;
    orderLineEl = null;
  }

  return { show, hide, toggle, isVisible, update, dispose };
}
