// Vitae panel — retail gmVitaeUI (layout 0x21000020, "Vitae") as a compact
// kit window that opens under the status-indicators strip when the Vitae
// indicator is clicked.
//
// HUD overhaul 2026-10-05 — rebuilt on the HUD kit (titlebar 0x06004CFA,
// close 0x06001393, meters) with retail's content. gmVitaeUI::Update
// (acclient.c) shows, for a penalty of P = 100 − round(vitae × 100):
//   ID_Vitae_Text_Vitae       — the penalty percentage
//   ID_Vitae_Text_Skills      — skills/vitals are reduced by the same P%
//   ID_Vitae_Text_Experience  — cpLeft = VitaeSystem::VitaeCPPoolThreshold(
//                               vitae, level) − VitaeCpPool (PropertyInt 0x81),
//                               level = DeathLevel (0x8B) falling back to Level (0x19)
//   ID_Vitae_Text_Full        — when there is no penalty
// The old popup printed the THRESHOLD as "CP threshold" with a developer
// note that pool progress was "pending wasm surface"; the pool and the death
// level are now read straight off the player's IntProperty bag
// (SessionHandle.objectIntProperty — ACE sends both [SendOnLogin] and
// re-sends VitaeCpPool on every XP award, Player_Xp.cs), so the panel shows
// the real experience still owed for the next 1% (ACE ReduceVitae steps by 1%).
//
// Programmatic API:
//   window.__showVitaeDetail({anchor}) / __hideVitaeDetail() / __toggleVitaeDetail({anchor})
// (status-indicators.js calls the toggle with its strip as the anchor).

import { makeTitlebar } from "../ui/hud_kit.js";

const OVERLAY_ID = "hb-vitae-detail";
const STYLE_ID = "hb-vitae-detail-style";
const PROP_VITAE_CP_POOL = 129;   // PropertyInt.VitaeCpPool (0x81)
const PROP_DEATH_LEVEL = 139;     // PropertyInt.DeathLevel (0x8B)

const state = {
  overlayEl: null,
  refs: null,
  client: null,
  unsubStats: null,
  unsubCharVitae: null,
  characterRef: null,
  onKey: null,
};

function ensureStyles() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    #${OVERLAY_ID} {
      top: 40px;
      left: 32px;
      width: 220px;   /* stays clear of the HP orb pane (x 260) at its default spot */
      z-index: 65;
      display: none;
    }
    #${OVERLAY_ID}[data-open="1"] { display: block; }
    #${OVERLAY_ID} .hbk-titlebar { cursor: default; }
    #${OVERLAY_ID} .hb-vd-body { padding: 8px 10px 10px; line-height: 1.4; }
    #${OVERLAY_ID} .hb-vd-headline { color: var(--hbk-gold-bright); font-size: 13px; margin-bottom: 4px; }
    #${OVERLAY_ID} .hb-vd-text { color: var(--hbk-text); font-size: 12px; margin: 2px 0; }
    #${OVERLAY_ID} .hb-vd-meter-label {
      display: flex; justify-content: space-between;
      margin: 8px 0 2px; font-size: 11px; color: var(--hbk-text-dim);
    }
    #${OVERLAY_ID} .hb-vd-meter-label b { font-weight: normal; color: var(--hbk-value); }
    #${OVERLAY_ID} .hb-vd-vitae { --hbk-meter-color: linear-gradient(180deg, #d84030, #6a1010); }
    #${OVERLAY_ID} .hb-vd-xp { --hbk-meter-color: linear-gradient(180deg, #f3d27a, #8a6a28); }
    #${OVERLAY_ID} .hb-vd-full { color: var(--hbk-text-dim); font-style: italic; }
  `;
  document.head.appendChild(s);
}

// VitaeSystem::VitaeCPPoolThreshold (acclient.c) / ACE Player_Xp.cs:433:
//   (level^2.5 × 2.5 + 20) × vitae^5 + 0.5
function vitaeCpPoolThreshold(vitae, level) {
  const v = Number(vitae);
  const lv = Number(level);
  if (!Number.isFinite(v) || !Number.isFinite(lv) || lv <= 0 || v <= 0 || v >= 1) return 0;
  return Math.floor((Math.pow(lv, 2.5) * 2.5 + 20.0) * Math.pow(v, 5.0) + 0.5);
}

/**
 * Pure model of gmVitaeUI::Update.
 * @returns {{pct:number, full:boolean, level:number|null, threshold:number,
 *            cpPool:number|null, cpLeft:number|null, progress:number|null}}
 */
function vitaeSummary({ vitae, level, deathLevel, cpPool } = {}) {
  const v = Number.isFinite(Number(vitae)) ? Number(vitae) : 1.0;
  const pct = Math.max(0, 100 - Math.floor(v * 100 + 0.5));
  if (pct <= 0) {
    return { pct: 0, full: true, level: null, threshold: 0, cpPool: null, cpLeft: null, progress: null };
  }
  const dl = Number(deathLevel);
  const lv = Number.isFinite(dl) && dl > 0 ? dl : (Number.isFinite(Number(level)) && Number(level) > 0 ? Number(level) : null);
  const threshold = lv ? vitaeCpPoolThreshold(v, lv) : 0;
  const pool = Number.isFinite(Number(cpPool)) && Number(cpPool) >= 0 ? Number(cpPool) : null;
  const cpLeft = threshold > 0 && pool != null ? Math.max(0, threshold - pool) : (threshold > 0 ? threshold : null);
  const progress = threshold > 0 && pool != null ? Math.max(0, Math.min(1, pool / threshold)) : null;
  return { pct, full: false, level: lv, threshold, cpPool: pool, cpLeft, progress };
}

function readVitae() {
  try {
    const ch = state.client?.character ?? state.client?.world?.character ?? state.characterRef;
    if (ch && typeof ch.vitae === "number") return ch.vitae;
  } catch (_) {}
  try {
    const handle = window.__sessionHandle;
    const stats = typeof handle?.playerStats === "function" ? handle.playerStats() : null;
    if (stats && typeof stats.vitae === "number") return stats.vitae;
  } catch (_) {}
  return 1.0;
}

function readPlayerInt(stype) {
  try {
    const handle = window.__sessionHandle;
    if (typeof handle?.objectIntProperty !== "function" || typeof handle?.playerGuid !== "function") return null;
    const guid = handle.playerGuid() >>> 0;
    if (!guid) return null;
    const v = handle.objectIntProperty(guid, stype);
    return Number.isFinite(v) ? v : null;
  } catch (_) { return null; }
}

function readLevel() {
  try {
    const handle = window.__sessionHandle;
    const stats = typeof handle?.playerStats === "function" ? handle.playerStats() : null;
    if (stats && typeof stats.level === "number") return stats.level;
  } catch (_) {}
  return null;
}

function render() {
  const r = state.refs;
  if (!r) return;
  const sum = vitaeSummary({
    vitae: readVitae(),
    level: readLevel(),
    deathLevel: readPlayerInt(PROP_DEATH_LEVEL),
    cpPool: readPlayerInt(PROP_VITAE_CP_POOL),
  });
  r.penaltyBox.style.display = sum.full ? "none" : "";
  r.fullEl.style.display = sum.full ? "" : "none";
  if (sum.full) return;
  r.headline.textContent = `Vitae penalty: ${sum.pct}%`;
  r.skills.textContent = `Your skills and maximum health, stamina and mana are reduced by ${sum.pct}%.`;
  r.vitaeValue.textContent = `${100 - sum.pct}%`;
  r.vitaeMeter.style.setProperty("--hbk-fill", `${100 - sum.pct}%`);
  if (sum.cpLeft == null) {
    r.xp.textContent = "Earn experience to recover your vitae.";
    r.xpRow.style.display = "none";
  } else {
    r.xp.textContent = `Earn ${sum.cpLeft.toLocaleString()} more experience to recover 1% vitae.`;
    r.xpRow.style.display = sum.progress == null ? "none" : "";
    if (sum.progress != null) {
      r.xpValue.textContent = `${Math.floor(sum.progress * 100)}%`;
      r.xpMeter.style.setProperty("--hbk-fill", `${(sum.progress * 100).toFixed(1)}%`);
    }
  }
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function ensurePanel() {
  if (state.overlayEl) return state.overlayEl;
  ensureStyles();
  const overlay = el("div", "hbk-window");
  overlay.id = OVERLAY_ID;
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-label", "Vitae");
  overlay.dataset.open = "0";

  const { bar } = makeTitlebar("Vitae", { onClose: () => hide() });
  overlay.appendChild(bar);

  const body = el("div", "hb-vd-body");
  const fullEl = el("div", "hb-vd-full", "You have no vitae penalty.");
  body.appendChild(fullEl);

  const penaltyBox = el("div");
  const headline = el("div", "hb-vd-headline");
  const skills = el("div", "hb-vd-text");
  penaltyBox.appendChild(headline);
  penaltyBox.appendChild(skills);

  const vitaeLabel = el("div", "hb-vd-meter-label");
  vitaeLabel.appendChild(el("span", null, "Vitae"));
  const vitaeValue = el("b");
  vitaeLabel.appendChild(vitaeValue);
  penaltyBox.appendChild(vitaeLabel);
  const vitaeMeter = el("div", "hbk-meter hb-vd-vitae");
  vitaeMeter.appendChild(el("div", "hbk-meter-fill"));
  penaltyBox.appendChild(vitaeMeter);

  const xp = el("div", "hb-vd-text");
  xp.style.marginTop = "8px";
  penaltyBox.appendChild(xp);
  const xpRow = el("div");
  const xpLabel = el("div", "hb-vd-meter-label");
  xpLabel.appendChild(el("span", null, "Recovery toward next 1%"));
  const xpValue = el("b");
  xpLabel.appendChild(xpValue);
  xpRow.appendChild(xpLabel);
  const xpMeter = el("div", "hbk-meter hb-vd-xp");
  xpMeter.appendChild(el("div", "hbk-meter-fill"));
  xpRow.appendChild(xpMeter);
  penaltyBox.appendChild(xpRow);

  body.appendChild(penaltyBox);
  overlay.appendChild(body);
  document.body.appendChild(overlay);
  state.overlayEl = overlay;
  state.refs = { fullEl, penaltyBox, headline, skills, vitaeValue, vitaeMeter, xp, xpRow, xpValue, xpMeter };
  return overlay;
}

function zoomOf(node) {
  const z = Number(node?.currentCSSZoom);
  return Number.isFinite(z) && z > 0 ? z : 1;
}

/** Open under (or above, near the bottom) the anchor — the indicator strip.
 *  Both are zoomed HUD roots: the anchor's screen rect ÷ our own zoom. */
function placeNearAnchor(anchor) {
  const ov = state.overlayEl;
  if (!ov || !anchor?.getBoundingClientRect) return;
  const z = zoomOf(ov);
  const a = anchor.getBoundingClientRect();
  const r = ov.getBoundingClientRect();
  const w = r.width / z;
  const h = r.height / z;
  const vw = window.innerWidth / z;
  const vh = window.innerHeight / z;
  let left = a.left / z;
  let top = a.bottom / z + 4;
  if (top + h > vh - 4 && a.top / z - h - 4 >= 0) top = a.top / z - h - 4;
  left = Math.max(0, Math.min(left, vw - w));
  ov.style.left = `${Math.round(left)}px`;
  ov.style.top = `${Math.round(top)}px`;
}

export function show(opts = {}) {
  const overlay = ensurePanel();
  // One popup under the indicator strip at a time (buffs-hud shares it).
  try { window.__buffsHudClose?.(); } catch (_) {}
  render();
  overlay.dataset.open = "1";
  const anchor = opts?.anchor ?? document.getElementById("hb-status-indicators");
  placeNearAnchor(anchor);
}

export function hide() {
  const overlay = state.overlayEl;
  if (!overlay) return;
  overlay.dataset.open = "0";
}

function toggle(opts) {
  if (state.overlayEl?.dataset.open === "1") hide();
  else show(opts);
}

function tryAttachCharacter() {
  if (state.unsubCharVitae) return true;
  try {
    const ch = state.client?.character ?? state.client?.world?.character ?? null;
    if (!ch || typeof ch.addEventListener !== "function") return false;
    const handler = () => { if (state.overlayEl?.dataset.open === "1") render(); };
    ch.addEventListener("vitaeChanged", handler);
    state.characterRef = ch;
    state.unsubCharVitae = () => {
      try { ch.removeEventListener("vitaeChanged", handler); } catch (_) {}
    };
    return true;
  } catch (_) { return false; }
}

export const manifest = {
  id: "vitae-detail",
  name: "Vitae Detail",
  icon: "💀",
  iconHidden: true,
  version: "0.2.0",
  description: "Retail gmVitaeUI — vitae penalty + experience owed for the next 1% (VitaeCPPoolThreshold − VitaeCpPool).",
};

export function mount(ctx) {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return () => {};
  }
  ensureStyles();
  state.client = ctx?.client ?? window.__pluginClient ?? null;

  const onStatsUpdated = () => {
    if (!state.client) state.client = window.__pluginClient ?? null;
    if (!state.unsubCharVitae) tryAttachCharacter();
    if (state.overlayEl?.dataset.open === "1") render();
  };
  const wire = (client) => {
    if (!client?.events?.on || state.unsubStats) return;
    state.client = client;
    client.events.on("playerStatsUpdated", onStatsUpdated);
    state.unsubStats = () => {
      try { client.events.off?.("playerStatsUpdated", onStatsUpdated); } catch (_) {}
    };
    tryAttachCharacter();
  };
  wire(state.client);
  if (!state.unsubStats && window.__pluginClientReady?.then) {
    window.__pluginClientReady.then((c) => wire(c ?? window.__pluginClient));
  }

  state.onKey = (ev) => {
    if (ev.key === "Escape" && state.overlayEl?.dataset.open === "1") hide();
  };
  window.addEventListener("keydown", state.onKey);

  return () => {
    try { if (typeof state.unsubStats === "function") state.unsubStats(); } catch (_) {}
    try { if (typeof state.unsubCharVitae === "function") state.unsubCharVitae(); } catch (_) {}
    if (state.onKey) window.removeEventListener("keydown", state.onKey);
    state.onKey = null;
    state.unsubStats = null;
    state.unsubCharVitae = null;
    state.characterRef = null;
    state.client = null;
    state.overlayEl?.remove();
    state.overlayEl = null;
    state.refs = null;
  };
}

if (typeof window !== "undefined") {
  window.__showVitaeDetail = show;
  window.__hideVitaeDetail = hide;
  window.__toggleVitaeDetail = toggle;
}

export const __test = Object.freeze({ vitaeCpPoolThreshold, vitaeSummary });
