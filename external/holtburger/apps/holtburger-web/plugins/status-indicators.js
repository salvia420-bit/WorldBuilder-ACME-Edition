// Top-left status indicators strip — port of retail gmFloatyIndicatorsUI
// (layout 0x21000071, 30 elements, 32 image DIDs). Retail size 150x30
// with a 5px brass 9-slice frame + a row of 20x20 indicator icons.
//
// Indicators (from acclient.h gmUIElement_*Indicator sub-classes):
//   - gmUIElement_BurdenIndicator      — carrying weight load (0-300%)
//   - gmUIElement_EffectsIndicator     — active spell/buff effects
//   - gmUIElement_LinkStatusIndicator  — network latency / connectivity
//   - gmUIElement_MiniGameIndicator    — chess / minigame active
//   - gmUIElement_PortalStormIndicator — overpopulation warning
//   - gmUIElement_VitaeIndicator       — death penalty (XP debt)
//
// Sprites all from layout 0x21000071's image DID set (extracted DAT
// commit 8f069a2). Each indicator has multiple state variants (active /
// inactive / warning levels). First pass: 6 indicators rendered with
// their canonical sprite, no state wiring. Real state hooks (player
// events for vitae level, burden %, link RTT, etc.) are follow-on.

const OVERLAY_ID = "hb-status-indicators";
const WIDTH = 150;
const HEIGHT = 30;
const ICON_SIZE = 20;

// 6 indicators with (active, inactive) sprite pairs picked by-eye from
// the 0x06007498-A6 + 0x06004CE8 ranges. Re-bind these once we identify
// each sprite's exact state mapping via acclient.c reads.
const INDICATORS = [
  { id: "burden",     name: "Burden",       active: "0x06007498", inactive: "0x06007498" },
  { id: "effects",    name: "Effects",      active: "0x060074A0", inactive: "0x060074A1" },
  { id: "linkstatus", name: "Link Status",  active: "0x06004CE8", inactive: "0x06004CE8" },
  { id: "minigame",   name: "Mini-Game",    active: "0x0600749C", inactive: "0x0600749D" },
  { id: "portalstorm",name: "Portal Storm", active: "0x0600749E", inactive: "0x0600749F" },
  { id: "vitae",      name: "Vitae",        active: "0x06007499", inactive: "0x060074A4" },
];

let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = "hb-status-indicators-style";
  style.textContent = `
    #${OVERLAY_ID} {
      position: fixed;
      top: 4px;
      left: 32px;          /* clear the ≡ pill (20px + 8px gap) */
      z-index: 50;
      width: ${WIDTH}px;
      height: ${HEIGHT}px;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 4px 6px;
      pointer-events: none;
      font-family: var(--hb-font-serif);
      background: linear-gradient(180deg, var(--hb-bg-stone-top) 0%, var(--hb-bg-stone-bottom) 100%);
      border: 5px solid transparent;
      border-image: url("./sprites/acsprites/panel.png") 5 / 5px / 0 stretch;
      box-shadow: var(--hb-shadow-panel);
    }
    #${OVERLAY_ID} .hb-indicator {
      position: relative;
      width: ${ICON_SIZE}px;
      height: ${ICON_SIZE}px;
      background-repeat: no-repeat;
      background-size: contain;
      background-position: center;
      pointer-events: auto;
      cursor: help;
      filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.6));
      transition: filter 120ms ease, opacity 120ms ease;
      opacity: 0.55;       /* default dim = inactive */
      image-rendering: pixelated;
    }
    #${OVERLAY_ID} .hb-indicator.active {
      opacity: 1;
      filter: drop-shadow(0 0 4px rgba(255, 220, 120, 0.6)) drop-shadow(0 1px 1px rgba(0, 0, 0, 0.8));
    }
    #${OVERLAY_ID} .hb-indicator:hover {
      filter: brightness(1.3) drop-shadow(0 1px 1px rgba(0, 0, 0, 0.8));
    }
    /* Tooltip on hover — small dark popup below the indicator. */
    #${OVERLAY_ID} .hb-indicator-tip {
      position: absolute;
      top: calc(100% + 4px);
      left: 50%;
      transform: translateX(-50%);
      padding: 2px 6px;
      font-size: 10px;
      font-family: var(--hb-font-serif);
      color: var(--hb-text-cream);
      background: rgba(10, 8, 4, 0.95);
      border: 1px solid var(--hb-border-brass);
      white-space: nowrap;
      pointer-events: none;
      opacity: 0;
      transition: opacity 120ms ease;
      z-index: 60;
    }
    #${OVERLAY_ID} .hb-indicator:hover .hb-indicator-tip {
      opacity: 1;
    }
  `;
  document.head.appendChild(style);
}

export const manifest = {
  id: "status-indicators",
  name: "Status Indicators",
  icon: "⚠",
  iconHidden: true,
  version: "0.1.0",
  description: "Top-left status icons (gmFloatyIndicatorsUI 0x21000071)",
};

export function mount(_ctx) {
  ensureStyles();
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;

  for (const ind of INDICATORS) {
    const el = document.createElement("div");
    el.className = "hb-indicator";
    el.dataset.indicator = ind.id;
    // Start in inactive state.
    el.style.backgroundImage = `url("./data/ui-sprites/${ind.inactive}.png")`;
    const tip = document.createElement("span");
    tip.className = "hb-indicator-tip";
    tip.textContent = ind.name;
    el.appendChild(tip);
    overlay.appendChild(el);
  }

  document.body.appendChild(overlay);

  // Wire setActive(indicatorId, bool) onto window for ad-hoc toggling
  // until real player-event subscriptions land. Useful for debugging.
  window.__setStatusIndicator = (id, active) => {
    const el = overlay.querySelector(`[data-indicator="${id}"]`);
    if (!el) return false;
    const ind = INDICATORS.find((i) => i.id === id);
    if (!ind) return false;
    el.classList.toggle("active", !!active);
    el.style.backgroundImage = `url("./data/ui-sprites/${active ? ind.active : ind.inactive}.png")`;
    return true;
  };

  return () => {
    delete window.__setStatusIndicator;
    overlay.remove();
  };
}
