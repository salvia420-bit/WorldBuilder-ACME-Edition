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

import { setAcText } from "../ui/ac_font.js";
import { loadLayout, findElementById, getCachedLayout } from "../ui/ac_layout.js";

const OVERLAY_ID = "hb-status-indicators";
const WIDTH = 150;
const HEIGHT = 30;
const ICON_SIZE = 20;

/** gmFloatyIndicatorsUI — retail layout 0x21000071 (150×30, 23 children).
 *  Element-id map confirmed by status_indicators_layout_dump 2026-05-24
 *  + acclient.c GetUIElementType() returns:
 *    0x10000610 — root (150×30)
 *    chrome (16 elements, read_order 1-16) — 4 corner pieces + 4 edges
 *      in 2 variants (frame fill type=3 + frame border type=2). Not
 *      addressable from JS — purely decorative 9-slice frame; we
 *      already render the frame via CSS border-image.
 *    indicator slots (7 elements, read_order 17-23, all 20×20 at y=5):
 *      0x100000F8 x=5   type=268435459 (LinkStatus, 6 states)
 *      0x100000F5 x=25  type=268435458 (Effects, 3 states) — buffs
 *      0x100000F6 x=45  type=268435458 (Effects, 3 states) — debuffs
 *      0x100000F4 x=65  type=268435462 (Vitae, 3 states)
 *      0x100000F7 x=85  type=268435457 (Burden, 5 states)
 *      0x100000F3 x=105 type=268435460 (MiniGame, 3 states)
 *      0x100000FA x=125 type=0 (generic 2-state) — likely PortalStorm
 *
 *  acclient.h class hierarchy for the 6 retail indicator subtypes:
 *    gmUIElement_BurdenIndicator      268435457 (0x10000001)
 *    gmUIElement_EffectsIndicator     268435458 (0x10000002) ×2
 *    gmUIElement_LinkStatusIndicator  268435459 (0x10000003)
 *    gmUIElement_MiniGameIndicator    268435460 (0x10000004)
 *    gmUIElement_PortalStormIndicator 268435461 (0x10000005)
 *    gmUIElement_VitaeIndicator       268435462 (0x10000006)
 */
const STATUS_INDICATORS_LAYOUT_ID = 0x21000071;
const STATUS_ELEMS = {
  linkstatus:  0x100000F8,
  buffs:       0x100000F5,
  debuffs:     0x100000F6,
  vitae:       0x100000F4,
  burden:      0x100000F7,
  minigame:    0x100000F3,
  portalstorm: 0x100000FA,
};

// 7 indicators with (active, inactive) sprite pairs, ordered LEFT→RIGHT
// to match retail layout 0x21000071 read_order.
//
// PR-JJ 2026-05-23 corrections: two prior-agent mislabels were caught
// by visual sprite inspection (blue/red starburst pair):
//   - "Mini-Game" (0x0600749C/D, blue starburst) was actually the
//     **beneficial-spells** (buffs) indicator. Retail's
//     MiniGameIndicator is the chess overlay — distinct sprite.
//   - "Portal Storm" (0x0600749E/F, red starburst) was actually the
//     **harmful-spells** (debuffs) indicator.
// Renamed to `buffs` / `debuffs`; the buffs-hud plugin drives both
// indicators' active state from `handle.playerEnchantments()` and
// owns click-to-toggle of the active-spells strip.
//
// PR-LL 2026-05-24: layout wiring + retail-correct slot order. Added
// `minigame` and `portalstorm` slots (real retail subclasses); dropped
// the prior speculative `linkup` slot whose sprite (0x060074A0/A1) had
// no retail UIElementType backing. Order now matches retail read_order
// 17→23 — left-to-right: linkstatus, buffs, debuffs, vitae, burden,
// minigame, portalstorm. Sprite DIDs for the new minigame/portalstorm
// slots are placeholders (re-using the linkup pair) until extracted
// from retail StateDesc — show/hide logic stays no-op until real game
// events land.
const INDICATORS = [
  { id: "linkstatus",  name: "Link Status",       active: "0x06004CE8", inactive: "0x06004CE8" },
  { id: "buffs",       name: "Beneficial Spells", active: "0x0600749C", inactive: "0x0600749D" },
  { id: "debuffs",     name: "Harmful Spells",    active: "0x0600749E", inactive: "0x0600749F" },
  { id: "vitae",       name: "Vitae",             active: "0x06007499", inactive: "0x060074A4" },
  { id: "burden",      name: "Burden",            active: "0x06007498", inactive: "0x06007498" },
  { id: "minigame",    name: "Mini-Game",         active: "0x060074A0", inactive: "0x060074A1" },
  { id: "portalstorm", name: "Portal Storm",      active: "0x060074A0", inactive: "0x060074A1" },
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
      /* Indicators are absolute-positioned per gmFloatyIndicatorsUI
         0x21000071. Layout-driven coords replace the prior flexbox
         + gap auto-flow once applyStatusIndicatorsLayout resolves.
         Frame chrome is rendered by the ::before pseudo (below) so
         absolute children's coordinates match retail layout 1:1
         (a child top of 5px lands at retail (5,5) — INSIDE the 5px
         brass frame). Putting the chrome on the parent's border
         property would shift absolute children inward by the border
         width. */
      pointer-events: none;
      font-family: var(--hb-font-serif);
      box-shadow: var(--hb-shadow-panel);
    }
    #${OVERLAY_ID}::before {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
      background: linear-gradient(180deg, var(--hb-bg-stone-top) 0%, var(--hb-bg-stone-bottom) 100%);
      border: 5px solid transparent;
      border-image: url("./sprites/acsprites/panel.png") 5 / 5px / 0 stretch;
      box-sizing: border-box;
    }
    #${OVERLAY_ID} .hb-indicator {
      position: absolute;
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

// Apply gmFloatyIndicatorsUI 0x21000071 layout to each indicator slot.
// status-indicators mounts during early boot via mountBar() — eor/local
// shards may not be available yet, so we retry every 2s up to 8 times
// (~16s total) before giving up. Same pattern as radar.js.
function applyStatusIndicatorsLayout(refs, attempt = 0) {
  const apply = (layout) => {
    if (!layout) {
      if (attempt < 8) {
        setTimeout(() => applyStatusIndicatorsLayout(refs, attempt + 1), 2000);
      }
      return;
    }
    let applied = 0;
    for (const [id, el] of Object.entries(refs)) {
      if (!el) continue;
      const elemId = STATUS_ELEMS[id];
      if (!elemId) continue;
      const desc = findElementById(layout, elemId);
      if (!desc) continue;
      // Explicit "none" override — the CSS rule sets `position:
      // absolute` only; there's no centering translate to compete with,
      // but stay defensive in case future tweaks add one.
      el.style.transform = "none";
      if (typeof desc.x === "number") el.style.left = `${desc.x}px`;
      if (typeof desc.y === "number") el.style.top = `${desc.y}px`;
      if (typeof desc.width === "number") el.style.width = `${desc.width}px`;
      if (typeof desc.height === "number") el.style.height = `${desc.height}px`;
      applied += 1;
    }
    try {
      window.__diag?.layout?.onStatusIndicatorsApplied?.({ applied });
    } catch (_) {}
  };
  const cached = getCachedLayout(STATUS_INDICATORS_LAYOUT_ID);
  if (cached) { apply(cached); return; }
  loadLayout(STATUS_INDICATORS_LAYOUT_ID).then(apply).catch(() => {});
}

export function mount(_ctx) {
  ensureStyles();
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;

  const indicatorEls = {};
  for (const ind of INDICATORS) {
    const el = document.createElement("div");
    el.className = "hb-indicator";
    el.dataset.indicator = ind.id;
    // Start in inactive state.
    el.style.backgroundImage = `url("./data/ui-sprites/${ind.inactive}.png")`;
    const tip = document.createElement("span");
    tip.className = "hb-indicator-tip";
    setAcText(tip, ind.name);
    el.appendChild(tip);
    // PR-JJ 2026-05-23: buffs/debuffs indicators are clickable —
    // they toggle the buffs-hud strip filtered to the matching type.
    // Other indicators stay click-passive for now (future work:
    // burden → encumbrance breakdown, vitae → vitae-pool details).
    if (ind.id === "buffs" || ind.id === "debuffs") {
      el.style.cursor = "pointer";
      el.addEventListener("click", () => {
        if (typeof window.__buffsHudToggle === "function") {
          window.__buffsHudToggle(ind.id);
        }
      });
    }
    overlay.appendChild(el);
    indicatorEls[ind.id] = el;
  }

  document.body.appendChild(overlay);

  // Apply retail layout positions for sub-elements. mountBar() runs
  // BEFORE wasm is ready, so applyStatusIndicatorsLayout has an 8 × 2s
  // retry loop matching the radar plugin's pattern.
  applyStatusIndicatorsLayout(indicatorEls);

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

  // PR-SS / PR-SS.1 2026-05-23: link-status latency tint. Polls
  // 1Hz. Two signals:
  //   1. `sessionLastPingRttMs()` (PR-SS.1) — real measured RTT from
  //      keepalive PingRequest↔PingResponse round-trip. Preferred
  //      when available — the truer "link health" metric.
  //   2. `sessionLastRecvAgeMs()` (PR-SS) — fallback staleness of
  //      ANY inbound packet. Useful before the first ping completes
  //      (~5s post-EnteredWorld) and as a "server stopped talking
  //      to us" backstop even when RTT is stale.
  // Tier picked from MAX(rtt, recvAge) so either degraded signal
  // surfaces. Sprite re-tinted via CSS filter — no extra art.
  // Thresholds via `window.__linkStatusThresholds = {middlingMs,
  // poorMs}` for demo / testing.
  const linkEl = overlay.querySelector('[data-indicator="linkstatus"]');
  const linkTip = linkEl?.querySelector(".hb-indicator-tip");
  let linkLastTier = null;
  let linkLastTipText = null;
  const linkPollTimer = setInterval(() => {
    if (!linkEl) return;
    const handle = window.__sessionHandle;
    let ageMs = 0xFFFFFFFF;
    let rttMs = 0xFFFFFFFF;
    try {
      if (typeof handle?.sessionLastRecvAgeMs === "function") {
        ageMs = handle.sessionLastRecvAgeMs() >>> 0;
      }
      if (typeof handle?.sessionLastPingRttMs === "function") {
        rttMs = handle.sessionLastPingRttMs() >>> 0;
      }
    } catch {}
    const th = window.__linkStatusThresholds || {};
    const middling = th.middlingMs ?? 500;
    const poor = th.poorMs ?? 2000;
    // Pick the worse signal. u32::MAX (0xFFFFFFFF) means "no data"
    // for that signal — ignore it unless both are MAX.
    const rttKnown = rttMs < 0xFFFFFFF0;
    const ageKnown = ageMs < 0xFFFFFFF0;
    let metric;
    if (rttKnown && ageKnown) metric = Math.max(rttMs, ageMs);
    else if (rttKnown) metric = rttMs;
    else if (ageKnown) metric = ageMs;
    else metric = 0xFFFFFFFF;
    let tier;
    if (metric >= 0xFFFFFFF0 || metric > poor) tier = "poor";
    else if (metric > middling) tier = "middling";
    else tier = "ok";
    if (tier !== linkLastTier) {
      linkLastTier = tier;
      // CSS filter: keep green-chain sprite as-is for ok; tint to
      // yellow / red for middling / poor. hue-rotate values picked by
      // eye against the source green (~hue 120°) — yellow ≈ -60°,
      // red ≈ -120°. Saturate boosts the tinted color.
      if (tier === "ok") {
        linkEl.style.filter = "";
        linkEl.style.opacity = "1";
      } else if (tier === "middling") {
        linkEl.style.filter = "hue-rotate(-60deg) saturate(1.4)";
        linkEl.style.opacity = "1";
      } else {
        linkEl.style.filter = "hue-rotate(-120deg) saturate(1.8) brightness(1.1)";
        linkEl.style.opacity = "1";
      }
    }
    // Tooltip refreshes every tick so the ms value is live (not just
    // on tier change). Show both signals when available so users can
    // tell whether degradation is RTT (uplink slow) or recv staleness
    // (downlink silent).
    if (linkTip) {
      const rttStr = rttKnown ? `${rttMs} ms` : "—";
      const ageStr = ageKnown ? `${ageMs} ms` : "—";
      const next = `Link: ${tier}  (rtt ${rttStr} · last recv ${ageStr})`;
      if (next !== linkLastTipText) {
        linkLastTipText = next;
        setAcText(linkTip, next);
      }
    }
  }, 1000);

  return () => {
    clearInterval(linkPollTimer);
    delete window.__setStatusIndicator;
    overlay.remove();
  };
}
