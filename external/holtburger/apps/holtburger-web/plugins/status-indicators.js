// Top-left status indicators strip — port of retail gmFloatyIndicatorsUI
// (layout 0x21000071, root 0x10000610, 150×30: a 5-px floaty frame around a
// row of 20×20 indicator buttons).
//
// HUD overhaul 2026-10-05 — rebuilt against the committed layout dump
// (data/retail-layouts/0x21000071.json). The previous strip drew the WRONG
// sprites for half its slots (vitae used the link "uncertain" plug and the
// heavily-encumbered backpack; burden used the link "good" plug), dimmed
// every icon to 55% opacity on top of retail's own ghosted art, and pinned a
// 150-px frame around 120 px of icons — the "cramped, unclear icons in a
// frame" in the before shot. Now:
//
//   * every slot draws the exact StateDesc sprite retail draws for its state
//     (table below, one row per indicator element);
//   * the retail floaty frame (corner 0x06006129 + edges 0x0600612A-D, the
//     *_Locked set 0x060074BF-C6 when the window is locked) hugs the icons;
//   * one kit-styled hover tooltip says what each icon means in words, with
//     live detail (ping, burden %, vitae %, effect counts);
//   * Positive/Negative Effects open the effects window (buffs-hud), Vitae
//     opens the vitae panel (vitae-detail) — anchored under this strip.
//
// Retail behaviour matched (acclient.c):
//   gmUIElement_BurdenIndicator::Update      — InqLoad <1.0 → Unencumbered (14),
//                                               ≥2.0 → Heavily_encumbered (16),
//                                               else Encumbered (15)
//   gmUIElement_VitaeIndicator::Update       — vitae._smod.val < 1.0 → Normal, else Ghosted
//   gmUIElement_EffectsIndicator::Update     — m_cHelpful/HarmfulEnchantments > 0 → Normal
//   gmUIElement_LinkStatusIndicator::UpdateLinkState / UseTime
//                                             — ≤5 s good, ≤20 s uncertain, ≤40 s bad
//                                               (flashes uncertain↔bad every 0.75 s),
//                                               else disconnected
//   gmFloatyIndicatorsUI::ListenToElementMessage — LogoffButton (0x100000FA) →
//     CM_UI::SendNotice_EndCharacterSession. NOT ported: the wasm session has no
//     logout/LogOffCharacter surface yet, and a dead button is worse than none,
//     so the frame is sized to the six indicators instead of retail's seven
//     buttons.
//
// rec #197 (kept): read_order 23 is the LogoffButton, not a
// PortalStormIndicator — acclient.h declares gmUIElement_PortalStormIndicator
// but no extracted layout places it. Portal-storm warnings surface as a CSS
// screen-edge pulse (#hb-portal-storm-pulse) instead of a phantom slot.

import { attachWindowPosition, WINDOW_ID } from "../ui/ac_window_position.js";
import { ETF } from "../ui/enchantment_constants.js";

const OVERLAY_ID = "hb-status-indicators";
const SP = "./data/ui-sprites";
const ICON_SIZE = 20;
// Retail packs the 20-px buttons edge to edge; a 2-px gutter keeps the dark
// icon backgrounds from merging into one smear at HUD scale >1 (modern
// liberty, HUD overhaul 2026-10-05).
const ICON_GAP = 2;
const FRAME = 5;
// rec #197 — full-viewport overlay id for the portal-storm warning pulse.
const PORTAL_STORM_PULSE_ID = "hb-portal-storm-pulse";

/** gmFloatyIndicatorsUI element ids (layout 0x21000071, read_order 17-22). */
const STATUS_ELEMS = Object.freeze({
  linkstatus: 0x100000F8,
  buffs:      0x100000F5,
  debuffs:    0x100000F6,
  vitae:      0x100000F4,
  burden:     0x100000F7,
  minigame:   0x100000F3,
});

// Indicator table, LEFT→RIGHT in retail read_order. `active`/`inactive` are
// the Normal / Ghosted StateDesc images; `states` lists every extra state
// image the element owns (sprite ids verbatim from
// data/retail-layouts/0x21000071.json, verified against the exported PNGs):
//   LinkStatus  Connection_good 0x06007498 · _uncertain 0x06007499 ·
//               _bad 0x0600749A · _disconnected 0x0600749A
//   Positive    Normal 0x0600749C · Ghosted 0x0600749D
//   Negative    Normal 0x0600749E · Ghosted 0x0600749F
//   Vitae       Normal 0x060074A0 · Ghosted 0x060074A1
//   Burden      Unencumbered 0x060074A2 · Encumbered 0x060074A3 ·
//               Heavily_encumbered 0x060074A4
//   MiniGame    Normal 0x060074A5 · Ghosted 0x060074A6
// (PressedOverlay 0x0600749B is the green dashed frame retail draws over a
// pressed button — used for :active on the clickable slots.)
const INDICATORS = Object.freeze([
  Object.freeze({
    id: "linkstatus", name: "Connection", active: "0x06007498", inactive: "0x06007498",
    states: Object.freeze({
      good: "0x06007498", uncertain: "0x06007499", bad: "0x0600749A", disconnected: "0x0600749A",
    }),
  }),
  Object.freeze({ id: "buffs",    name: "Positive Effects", active: "0x0600749C", inactive: "0x0600749D", clickable: true }),
  Object.freeze({ id: "debuffs",  name: "Negative Effects", active: "0x0600749E", inactive: "0x0600749F", clickable: true }),
  Object.freeze({ id: "vitae",    name: "Vitae",            active: "0x060074A0", inactive: "0x060074A1", clickable: true }),
  Object.freeze({
    id: "burden", name: "Burden", active: "0x060074A3", inactive: "0x060074A2",
    states: Object.freeze({
      unencumbered: "0x060074A2", encumbered: "0x060074A3", "heavily-encumbered": "0x060074A4",
    }),
  }),
  Object.freeze({ id: "minigame", name: "Mini-Game",        active: "0x060074A5", inactive: "0x060074A6" }),
]);

// ─── Pure state machines (exported via __test) ──────────────────────────

/** gmUIElement_BurdenIndicator::Update — load = burden / capacity. */
function burdenStateFor(ratio) {
  const r = Number(ratio);
  if (!Number.isFinite(r) || r < 1.0) return "unencumbered";
  if (r >= 2.0) return "heavily-encumbered";
  return "encumbered";
}

/** gmUIElement_VitaeIndicator::Update — Normal iff vitae < 1.0. */
function vitaeActive(vitae) {
  const v = Number(vitae);
  return Number.isFinite(v) && v < 1.0;
}

const LINK_NO_DATA = 0xFFFFFFF0;

/**
 * gmUIElement_LinkStatusIndicator::UpdateLinkState — retail tiers off the
 * seconds since the server last spoke (≤5 good / ≤20 uncertain / ≤40 bad /
 * else disconnected). Modern liberty: a measured keepalive RTT can only make
 * a "good" link look worse (>1 s uncertain, >3 s bad), never better, so a
 * laggy-but-chatty connection still warns.
 *
 * @param {number} ageMs  ms since the last inbound packet (u32::MAX = none)
 * @param {number} rttMs  last ping RTT in ms (u32::MAX = none)
 * @param {object} [th]   threshold overrides (window.__linkStatusThresholds)
 * @returns {"good"|"uncertain"|"bad"|"disconnected"}
 */
function linkTierFor(ageMs, rttMs, th = {}) {
  const goodMs = th.goodMs ?? 5000;
  const uncertainMs = th.uncertainMs ?? 20000;
  const badMs = th.badMs ?? 40000;
  // Legacy names (middlingMs / poorMs) were RTT thresholds — keep honouring them.
  const rttWarn = th.rttWarnMs ?? th.middlingMs ?? 1000;
  const rttBad = th.rttBadMs ?? th.poorMs ?? 3000;
  const age = Number(ageMs);
  const rtt = Number(rttMs);
  const ageKnown = Number.isFinite(age) && age >= 0 && age < LINK_NO_DATA;
  const rttKnown = Number.isFinite(rtt) && rtt >= 0 && rtt < LINK_NO_DATA;
  let tier;
  if (!ageKnown) {
    if (!rttKnown) return "disconnected";
    tier = "good";
  } else if (age <= goodMs) tier = "good";
  else if (age <= uncertainMs) tier = "uncertain";
  else if (age <= badMs) tier = "bad";
  else return "disconnected";
  if (rttKnown && tier === "good") {
    if (rtt > rttBad) tier = "bad";
    else if (rtt > rttWarn) tier = "uncertain";
  }
  return tier;
}

const LINK_TIER_LABEL = Object.freeze({
  good: "Good",
  uncertain: "Unstable",
  bad: "Poor",
  disconnected: "Disconnected",
});

function classifyEnchKind(e) {
  const t = (e?.type ?? e?.statModType ?? 0) | 0;
  if ((t & ETF.COOLDOWN) !== 0) return "cooldown";
  if ((t & ETF.BENEFICIAL) !== 0) return "buff";
  const v = Number(e?.statValue ?? e?.statModValue ?? 0);
  if ((t & ETF.ADDITIVE) !== 0) return v >= 0 ? "buff" : "debuff";
  if ((t & ETF.MULTIPLICATIVE) !== 0) return v >= 1.0 ? "buff" : "debuff";
  return "buff";
}

// ─── Styles ─────────────────────────────────────────────────────────────

/** Retail floaty-window frame (gmFloaty*UI *Corner / *Border elements):
 *  0x06006129 corners + 0x0600612A/B/C/D edges, *_Locked set when locked. */
function floatyFrameCss(sel) {
  const u = (id) => `url("${SP}/${id}.png")`;
  return `
    ${sel} {
      background:
        ${u("0x06006129")} left top / 5px 5px no-repeat,
        ${u("0x06006129")} right top / 5px 5px no-repeat,
        ${u("0x06006129")} left bottom / 5px 5px no-repeat,
        ${u("0x06006129")} right bottom / 5px 5px no-repeat,
        ${u("0x0600612A")} left top / 10px 5px repeat-x,
        ${u("0x0600612C")} left bottom / 10px 5px repeat-x,
        ${u("0x0600612B")} left top / 5px 10px repeat-y,
        ${u("0x0600612D")} right top / 5px 10px repeat-y,
        ${u("0x06004CC2")} left top / 48px 48px repeat,
        #0b0c10;
      image-rendering: pixelated;
    }
    ${sel}.is-locked {
      background:
        ${u("0x060074C3")} left top / 5px 5px no-repeat,
        ${u("0x060074C4")} right top / 5px 5px no-repeat,
        ${u("0x060074C5")} left bottom / 5px 5px no-repeat,
        ${u("0x060074C6")} right bottom / 5px 5px no-repeat,
        ${u("0x060074BF")} left top / 10px 5px repeat-x,
        ${u("0x060074C1")} left bottom / 10px 5px repeat-x,
        ${u("0x060074C0")} left top / 5px 10px repeat-y,
        ${u("0x060074C2")} right top / 5px 10px repeat-y,
        ${u("0x06004CC2")} left top / 48px 48px repeat,
        #0b0c10;
    }`;
}

function spriteRules() {
  const rules = [];
  for (const ind of INDICATORS) {
    const sel = `#${OVERLAY_ID} .hb-indicator[data-indicator="${ind.id}"]`;
    rules.push(`${sel} { background-image: url("${SP}/${ind.inactive}.png"); }`);
    rules.push(`${sel}.active { background-image: url("${SP}/${ind.active}.png"); }`);
    for (const [state, sprite] of Object.entries(ind.states || {})) {
      rules.push(`${sel}[data-state="${state}"] { background-image: url("${SP}/${sprite}.png"); }`);
    }
  }
  return rules.join("\n    ");
}

let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = "hb-status-indicators-style";
  const width = FRAME * 2 + INDICATORS.length * ICON_SIZE + (INDICATORS.length - 1) * ICON_GAP;
  style.textContent = `
    #${OVERLAY_ID} {
      position: fixed;
      top: 4px;
      left: 32px;          /* clear the ≡ pill (20px + 8px gap) */
      z-index: 50;
      width: ${width}px;
      height: ${FRAME * 2 + ICON_SIZE}px;
      box-sizing: border-box;
      padding: ${FRAME}px;
      display: flex;
      gap: ${ICON_GAP}px;
      pointer-events: auto;
      user-select: none;
      font-family: var(--hbk-font, var(--hb-font-serif));
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.55);
    }
    ${floatyFrameCss(`#${OVERLAY_ID}`)}
    #${OVERLAY_ID} .hb-indicator {
      position: relative;
      flex: 0 0 ${ICON_SIZE}px;
      width: ${ICON_SIZE}px;
      height: ${ICON_SIZE}px;
      background-repeat: no-repeat;
      background-size: ${ICON_SIZE}px ${ICON_SIZE}px;
      background-position: center;
      box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.7);
      cursor: help;
      outline: none;
      transition: filter 120ms ease;
    }
    #${OVERLAY_ID} .hb-indicator:hover,
    #${OVERLAY_ID} .hb-indicator:focus-visible { filter: brightness(1.25); }
    #${OVERLAY_ID} .hb-indicator:focus-visible { box-shadow: 0 0 0 1px var(--hbk-gold, #d9b45a); }
    #${OVERLAY_ID} .hb-indicator.is-clickable { cursor: pointer; }
    /* Retail PressedOverlay (0x0600749B) while a clickable slot is held. */
    #${OVERLAY_ID} .hb-indicator.is-clickable:active::after {
      content: "";
      position: absolute; inset: 0;
      background: url("${SP}/0x0600749B.png") center / 100% 100% no-repeat;
    }
    /* gmUIElement_LinkStatusIndicator::UseTime — the "bad" state flashes
       between the uncertain and bad sprites every 0.75 s. */
    #${OVERLAY_ID} .hb-indicator[data-indicator="linkstatus"][data-state="bad"] {
      animation: hb-si-link-flash 1.5s steps(1, end) infinite;
    }
    @keyframes hb-si-link-flash {
      0%   { background-image: url("${SP}/0x0600749A.png"); }
      50%  { background-image: url("${SP}/0x06007499.png"); }
    }
    ${spriteRules()}
    /* One shared tooltip (kit .hbk-tooltip look) under the strip. */
    #${OVERLAY_ID} .hb-si-tip {
      position: absolute;
      top: calc(100% + 3px);
      left: 0;
      z-index: 60;
      min-width: 120px;
      max-width: 240px;
      padding: 4px 7px;
      background: url("${SP}/0x06004CC2.png") repeat, #0b0c10;
      border: 1px solid var(--hbk-gold-dim, #8a7544);
      box-shadow: 0 3px 10px rgba(0, 0, 0, 0.8);
      color: var(--hbk-text, #e8dfc8);
      font-size: 11px;
      line-height: 1.35;
      white-space: normal;
      pointer-events: none;
      display: none;
      image-rendering: auto;
    }
    #${OVERLAY_ID} .hb-si-tip.is-open { display: block; }
    #${OVERLAY_ID} .hb-si-tip-title { color: var(--hbk-gold-bright, #f3d27a); font-size: 12px; }
    #${OVERLAY_ID} .hb-si-tip-detail { color: var(--hbk-text, #e8dfc8); }
    #${OVERLAY_ID} .hb-si-tip-hint { color: var(--hbk-text-faint, #77705f); font-style: italic; font-size: 10px; }
    /* Lock toggle — a 9×9 brass stud on the top-right corner, shown on
       hover (and always while locked, so the state is discoverable). */
    #${OVERLAY_ID} .hb-status-lock-button {
      position: absolute;
      top: -4px;
      right: -4px;
      width: 9px;
      height: 9px;
      box-sizing: border-box;
      border: 1px solid #000;
      border-radius: 2px;
      background: linear-gradient(180deg, #f3d27a 0%, #8a6a28 100%);
      cursor: pointer;
      opacity: 0;
      transition: opacity 120ms ease;
      z-index: 5;
    }
    #${OVERLAY_ID}:hover .hb-status-lock-button,
    #${OVERLAY_ID} .hb-status-lock-button[data-locked="1"] { opacity: 0.9; }
    #${OVERLAY_ID} .hb-status-lock-button:hover { opacity: 1; filter: brightness(1.2); }
    #${OVERLAY_ID} .hb-status-lock-button[data-locked="1"] {
      background: linear-gradient(180deg, #b08a3c 0%, #4e3f1f 100%);
    }
    /* rec #197 — portal-storm screen-edge alert pulse. Fixed full-viewport
       overlay, click-through, inset red glow that flashes once per trigger.
       Stays at opacity 0 until JS adds .active (which replays the keyframe). */
    #${PORTAL_STORM_PULSE_ID} {
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 2147483000;
      opacity: 0;
      box-shadow: inset 0 0 80px 24px rgba(200, 32, 16, 0.7);
    }
    #${PORTAL_STORM_PULSE_ID}.active {
      animation: hb-portal-storm-pulse 1.6s ease-out 1;
    }
    @keyframes hb-portal-storm-pulse {
      0%   { opacity: 0; }
      18%  { opacity: 1; }
      100% { opacity: 0; }
    }
  `;
  document.head.appendChild(style);
}

// rec #197 — CSS-only portal-storm alert. Levels >= 2 (Imminent / Active)
// fire the pulse; lower levels clear it.
function firePortalStormPulse(level) {
  let el = document.getElementById(PORTAL_STORM_PULSE_ID);
  if (Number(level) < 2) {
    if (el) el.classList.remove("active");
    return;
  }
  if (!el) {
    el = document.createElement("div");
    el.id = PORTAL_STORM_PULSE_ID;
    document.body.appendChild(el);
  }
  // Replay the keyframe: drop the class, force a reflow, re-add it.
  el.classList.remove("active");
  void el.offsetWidth;
  el.classList.add("active");
}

export const manifest = {
  id: "status-indicators",
  name: "Status Indicators",
  icon: "⚠",
  iconHidden: true,
  version: "0.2.0",
  description: "Top-left status icons (gmFloatyIndicatorsUI 0x21000071)",
};

export function mount(_ctx) {
  ensureStyles();
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.setAttribute("role", "toolbar");
  overlay.setAttribute("aria-label", "Status indicators");

  // Live per-indicator facts the tooltip renders from. Updated by the
  // state setters below; the tooltip re-reads on hover + on every change.
  const facts = {
    linkstatus: { tier: "disconnected", rttMs: null, ageMs: null },
    buffs: { count: null },
    debuffs: { count: null },
    vitae: { vitae: 1.0 },
    burden: { ratio: null, state: "unencumbered" },
    minigame: { active: false },
  };

  const tip = document.createElement("div");
  tip.className = "hb-si-tip";
  tip.setAttribute("role", "tooltip");
  const tipTitle = document.createElement("div");
  tipTitle.className = "hb-si-tip-title";
  const tipDetail = document.createElement("div");
  tipDetail.className = "hb-si-tip-detail";
  const tipHint = document.createElement("div");
  tipHint.className = "hb-si-tip-hint";
  tip.appendChild(tipTitle);
  tip.appendChild(tipDetail);
  tip.appendChild(tipHint);
  let hoveredId = null;

  function tooltipFor(id) {
    const f = facts[id] || {};
    switch (id) {
      case "linkstatus": {
        const parts = [];
        if (Number.isFinite(f.rttMs)) parts.push(`Ping ${Math.round(f.rttMs)} ms`);
        if (Number.isFinite(f.ageMs)) parts.push(`last packet ${(f.ageMs / 1000).toFixed(1)} s ago`);
        return {
          title: `Connection: ${LINK_TIER_LABEL[f.tier] ?? "Unknown"}`,
          detail: parts.length ? parts.join(" · ") : "No data from the server yet.",
          hint: "",
        };
      }
      case "buffs":
      case "debuffs": {
        const n = f.count;
        const noun = id === "buffs" ? "positive" : "negative";
        const detail = n == null
          ? (indicatorEls[id]?.classList.contains("active") ? `Active ${noun} effects.` : `No ${noun} effects.`)
          : n > 0 ? `${n} ${noun} effect${n === 1 ? "" : "s"} active.` : `No ${noun} effects.`;
        return {
          title: id === "buffs" ? "Positive Effects" : "Negative Effects",
          detail,
          hint: "Click to show the effects list.",
        };
      }
      case "vitae": {
        const pct = Math.max(0, Math.round((1 - Number(f.vitae ?? 1)) * 100));
        return {
          title: "Vitae",
          detail: pct > 0 ? `Vitae penalty: ${pct}%` : "No vitae penalty.",
          hint: "Click for details.",
        };
      }
      case "burden": {
        const label = f.state === "heavily-encumbered" ? "Heavily encumbered"
          : f.state === "encumbered" ? "Encumbered" : "Unencumbered";
        const pct = Number.isFinite(f.ratio) ? ` (${Math.round(f.ratio * 100)}% burden)` : "";
        return {
          title: "Burden",
          detail: `${label}${pct}`,
          hint: f.state === "unencumbered" ? "" : "Carrying over 100% slows you down.",
        };
      }
      case "minigame":
        return {
          title: "Mini-Game",
          detail: f.active ? "A game is in progress." : "No game in progress.",
          hint: "",
        };
      default:
        return { title: id, detail: "", hint: "" };
    }
  }

  function renderTip() {
    if (!hoveredId) {
      tip.classList.remove("is-open");
      return;
    }
    const el = indicatorEls[hoveredId];
    const t = tooltipFor(hoveredId);
    tipTitle.textContent = t.title;
    tipDetail.textContent = t.detail;
    tipHint.textContent = t.hint;
    tipHint.style.display = t.hint ? "" : "none";
    // Align under the hovered icon (offsetLeft is in the strip's own,
    // already-zoomed CSS px — no screen/HUD conversion needed).
    const left = Number(el?.offsetLeft) || 0;
    tip.style.left = `${Math.max(0, left - FRAME)}px`;
    tip.classList.add("is-open");
  }
  function refreshTipIf(id) {
    if (hoveredId === id) renderTip();
  }

  const indicatorEls = {};
  for (const ind of INDICATORS) {
    const el = document.createElement("div");
    el.className = "hb-indicator";
    el.dataset.indicator = ind.id;
    el.dataset.elementId = `0x${STATUS_ELEMS[ind.id].toString(16).toUpperCase()}`;
    el.setAttribute("aria-label", ind.name);
    if (ind.clickable) {
      el.classList.add("is-clickable");
      el.setAttribute("role", "button");
      el.tabIndex = 0;
    }
    el.addEventListener("mouseenter", () => { hoveredId = ind.id; renderTip(); });
    el.addEventListener("mouseleave", () => {
      if (hoveredId === ind.id) { hoveredId = null; renderTip(); }
    });
    el.addEventListener("focus", () => { hoveredId = ind.id; renderTip(); });
    el.addEventListener("blur", () => {
      if (hoveredId === ind.id) { hoveredId = null; renderTip(); }
    });
    if (ind.clickable) {
      const activate = () => {
        hoveredId = null;
        renderTip();
        if (ind.id === "vitae") {
          window.__toggleVitaeDetail?.({ anchor: overlay });
        } else if (typeof window.__buffsHudToggle === "function") {
          window.__buffsHudToggle(ind.id, { anchor: overlay });
        }
      };
      el.addEventListener("click", activate);
      el.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          activate();
        }
      });
    }
    overlay.appendChild(el);
    indicatorEls[ind.id] = el;
  }
  overlay.appendChild(tip);

  // Lock toggle. attachWindowPosition wires the click to the persisted lock
  // flag + hb-ui-lock-changed; locked windows draw retail's *_Locked frame.
  const lockButton = document.createElement("div");
  lockButton.className = "hb-status-lock-button";
  lockButton.dataset.locked = "0";
  lockButton.title = "Lock position";
  overlay.appendChild(lockButton);

  document.body.appendChild(overlay);
  const applyLocked = (locked) => {
    lockButton.dataset.locked = locked ? "1" : "0";
    lockButton.title = locked ? "Unlock position" : "Lock position";
    overlay.classList.toggle("is-locked", !!locked);
  };
  // The whole frame is the drag handle (retail floaties drag by their
  // border); icons + the lock stud keep their own clicks.
  const positionCtl = attachWindowPosition(overlay, {
    windowId: WINDOW_ID.STATUS_INDICATORS,
    dragHandle: overlay,
    ignoreSelector: ".hb-indicator, .hb-status-lock-button",
    lockButton,
    onLockChange: applyLocked,
  });
  applyLocked(positionCtl?.isLocked?.() === true);

  function setIndicatorActive(id, active) {
    const el = indicatorEls[id];
    if (!el) return;
    el.classList.toggle("active", !!active);
    refreshTipIf(id);
  }

  // Debug / cross-plugin hook (buffs-hud drives the effect indicators with
  // its tie-break-resolved counts): __setStatusIndicator(id, active, {count}).
  window.__setStatusIndicator = (id, active, info) => {
    if (!indicatorEls[id]) return false;
    if ((id === "buffs" || id === "debuffs") && Number.isFinite(info?.count)) {
      facts[id].count = info.count | 0;
    }
    if (id === "minigame") facts.minigame.active = !!active;
    setIndicatorActive(id, active);
    return true;
  };

  // ── Link status (gmUIElement_LinkStatusIndicator) ────────────────────
  // Two signals off the wasm session: ms since the last inbound packet
  // (retail's GetConnectionStatus staleness) and the keepalive ping RTT.
  // 1 Hz poll; retail re-evaluates every 4 s (UseTime) — 1 Hz just makes
  // the hover tooltip's numbers live.
  const linkEl = indicatorEls.linkstatus;
  function pollLink() {
    const handle = window.__sessionHandle;
    let ageMs = 0xFFFFFFFF;
    let rttMs = 0xFFFFFFFF;
    try {
      if (typeof handle?.sessionLastRecvAgeMs === "function") ageMs = handle.sessionLastRecvAgeMs() >>> 0;
      if (typeof handle?.sessionLastPingRttMs === "function") rttMs = handle.sessionLastPingRttMs() >>> 0;
    } catch (_) {}
    const tier = linkTierFor(ageMs, rttMs, window.__linkStatusThresholds || {});
    const f = facts.linkstatus;
    f.ageMs = ageMs < LINK_NO_DATA ? ageMs : null;
    f.rttMs = rttMs < LINK_NO_DATA ? rttMs : null;
    if (tier !== f.tier) {
      f.tier = tier;
      if (linkEl) linkEl.dataset.state = tier;
    }
    refreshTipIf("linkstatus");
  }
  if (linkEl) linkEl.dataset.state = facts.linkstatus.tier;
  const linkPollTimer = setInterval(pollLink, 1000);

  // ── Burden / vitae / effects / mini-game ─────────────────────────────
  function applyBurden(ratio) {
    const el = indicatorEls.burden;
    if (!el) return;
    const r = Number(ratio);
    const st = burdenStateFor(r);
    facts.burden.ratio = Number.isFinite(r) ? r : null;
    facts.burden.state = st;
    el.dataset.state = st;
    // `over` = past 100% capacity (the slow-down threshold); kept for any
    // sibling CSS that keyed off it.
    el.dataset.over = st === "unencumbered" ? "0" : "1";
    el.classList.toggle("active", st !== "unencumbered");
    refreshTipIf("burden");
  }

  function applyVitae(vitae) {
    const el = indicatorEls.vitae;
    if (!el) return;
    const v = Number(vitae);
    facts.vitae.vitae = Number.isFinite(v) ? v : 1.0;
    const on = vitaeActive(v);
    el.dataset.state = on ? "penalty" : "none";
    el.classList.toggle("active", on);
    refreshTipIf("vitae");
  }

  function applyEnchantmentSnapshot(snapshot) {
    if (!Array.isArray(snapshot)) return;
    let nBuff = 0;
    let nDebuff = 0;
    for (const e of snapshot) {
      const k = classifyEnchKind(e);
      if (k === "buff") nBuff += 1;
      else if (k === "debuff") nDebuff += 1;
    }
    facts.buffs.count = nBuff;
    facts.debuffs.count = nDebuff;
    setIndicatorActive("buffs", nBuff > 0);
    setIndicatorActive("debuffs", nDebuff > 0);
  }

  const eventUnsubs = [];
  let clientPollTimer = null;

  function tryWireClient() {
    const client = window.__pluginClient ?? null;
    if (!client?.events?.on) return false;

    const onVitaeChanged = (evt) => applyVitae(Number(evt?.detail?.vitae ?? 1.0));
    const onStatsUpdated = () => {
      const ch = client.character ?? client.world?.character ?? null;
      if (ch && typeof ch.vitae === "number") applyVitae(ch.vitae);
      // gmUIElement_BurdenIndicator::RecvNotice_LoadChanged — our wasm
      // bundles the load recompute into kind=8 playerStatsUpdated.
      try {
        const handle = window.__sessionHandle;
        if (handle && typeof handle.playerBurden === "number") {
          applyBurden(handle.playerBurden);
        } else if (typeof handle?.playerBurden === "function") {
          applyBurden(handle.playerBurden());
        }
      } catch (_) {}
    };
    client.events.on("playerStatsUpdated", onStatsUpdated);
    eventUnsubs.push(() => client.events.off?.("playerStatsUpdated", onStatsUpdated));

    // The typed Character lands lazily (PLAYER_SPAWNED + ObjectCreate);
    // attach its vitaeChanged listener on the first stats tick it exists.
    let charAttached = false;
    const tryAttachChar = () => {
      if (charAttached) return;
      const ch = client.character ?? client.world?.character ?? null;
      if (!ch || typeof ch.addEventListener !== "function") return;
      ch.addEventListener("vitaeChanged", onVitaeChanged);
      eventUnsubs.push(() => ch.removeEventListener?.("vitaeChanged", onVitaeChanged));
      charAttached = true;
      if (typeof ch.vitae === "number") applyVitae(ch.vitae);
    };
    client.events.on("playerStatsUpdated", tryAttachChar);
    eventUnsubs.push(() => client.events.off?.("playerStatsUpdated", tryAttachChar));

    // gmUIElement_EffectsIndicator::RecvNotice_EnchantmentsChanged.
    const refreshEnchIndicators = () => {
      let snap = null;
      try {
        snap = client.player?.enchantments?.();
        if (snap) applyEnchantmentSnapshot(snap);
      } catch (_) {
      } finally {
        // Fresh wasm-bindgen PlayerEnchantmentJs boxes on every pull (this
        // runs per stats batch and per enchantment delta) — only counted
        // above, never retained, so release them now.
        if (Array.isArray(snap)) {
          for (const r of snap) { try { r?.free?.(); } catch (_) { /* already freed */ } }
        }
      }
    };
    const world = client.world;
    if (world && typeof world.addEventListener === "function") {
      world.addEventListener("enchantmentAdded", refreshEnchIndicators);
      world.addEventListener("enchantmentRemoved", refreshEnchIndicators);
      world.addEventListener("enchantmentsChanged", refreshEnchIndicators);
      eventUnsubs.push(() => {
        world.removeEventListener("enchantmentAdded", refreshEnchIndicators);
        world.removeEventListener("enchantmentRemoved", refreshEnchIndicators);
        world.removeEventListener("enchantmentsChanged", refreshEnchIndicators);
      });
    }
    client.events.on("playerStatsUpdated", refreshEnchIndicators);
    eventUnsubs.push(() => client.events.off?.("playerStatsUpdated", refreshEnchIndicators));

    // Portal storm (Misc_PortalStorm* 0x02C9-0x02CC) — no bus event is
    // surfaced yet; pre-subscribed so the pulse fires the day it lands.
    const onPortalStorm = (evt) => {
      firePortalStormPulse(Number(evt?.detail?.level ?? evt?.detail?.extent ?? 0));
    };
    client.events.on("portalStormChanged", onPortalStorm);
    eventUnsubs.push(() => client.events.off?.("portalStormChanged", onPortalStorm));

    // Mini-game (chess) — no emitter yet; `miniGameChanged {active}`.
    const onMiniGame = (evt) => {
      facts.minigame.active = !!(evt?.detail?.active);
      setIndicatorActive("minigame", facts.minigame.active);
    };
    client.events.on("miniGameChanged", onMiniGame);
    eventUnsubs.push(() => client.events.off?.("miniGameChanged", onMiniGame));

    onStatsUpdated();
    tryAttachChar();
    refreshEnchIndicators();
    return true;
  }

  if (!tryWireClient()) {
    if (typeof window !== "undefined" && window.__pluginClientReady?.then) {
      window.__pluginClientReady.then(() => { tryWireClient(); });
    } else {
      clientPollTimer = setInterval(() => {
        if (tryWireClient()) {
          clearInterval(clientPollTimer);
          clientPollTimer = null;
        }
      }, 500);
    }
  }

  return () => {
    clearInterval(linkPollTimer);
    if (clientPollTimer) clearInterval(clientPollTimer);
    for (const fn of eventUnsubs) {
      try { fn(); } catch (_) {}
    }
    eventUnsubs.length = 0;
    delete window.__setStatusIndicator;
    overlay.remove();
    document.getElementById(PORTAL_STORM_PULSE_ID)?.remove();
  };
}

// ─── Test-only helpers ────────────────────────────────────────────────
export const __test = Object.freeze({
  classifyEnchKind,
  burdenStateFor,
  linkTierFor,
  /** Burden indicator lit (Encumbered or worse) — retail load ≥ 1.0. */
  isBurdenActive(ratio) { return burdenStateFor(ratio) !== "unencumbered"; },
  /** Past 100% capacity — the same threshold (retail state 15+). */
  isBurdenOver(ratio) { return burdenStateFor(ratio) !== "unencumbered"; },
  /** Vitae ratio → indicator active flag. <1.0 = active (death penalty). */
  isVitaeActive(vitae) { return vitaeActive(vitae); },
  INDICATORS,
  STATUS_ELEMS,
});
