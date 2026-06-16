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
import {
  loadLayout, findElementById, getCachedLayout,
  getElementStates, getStateMediaByType,
} from "../ui/ac_layout.js";
import { attachDefaultTopDragHandle, WINDOW_ID } from "../ui/ac_window_position.js";
import { fetchIconDataUrl } from "../ui/ac_icon_cache.js";

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
  attachDefaultTopDragHandle(overlay, WINDOW_ID.STATUS_INDICATORS);

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

  // P2-37 closure (2026-06-05) — walk layout 0x21000071's LinkStatus
  // element (0x100000F8) for its per-state Image media, then resolve
  // each state's `0x06xxxxxx` sprite DID to a data URL via the icon
  // cache. The map drives a real sprite swap on tier change; the
  // hue-rotate fallback below keeps things visible until the map lands
  // (or for the small number of state ids we don't have a mapping for).
  // States: retail LinkStatus carries 6 states. Without per-state
  // semantics extracted, we sort the state ids and pick first / middle /
  // last as our 3-tier ok/middling/poor proxies. That mirrors retail's
  // "best→worst" ordering within the StateDesc array; any future
  // refinement (e.g. tying tier→state via UIStateId enum) lands as
  // a tier→state lookup table here.
  const linkStateUrls = { ok: null, middling: null, poor: null };
  let linkStateMapReady = false;
  async function buildLinkStateMap() {
    const layout = getCachedLayout(STATUS_INDICATORS_LAYOUT_ID)
      ?? (await loadLayout(STATUS_INDICATORS_LAYOUT_ID).catch(() => null));
    if (!layout) return;
    const desc = findElementById(layout, STATUS_ELEMS.linkstatus);
    if (!desc) return;
    const states = getElementStates(desc);
    const stateIds = Object.keys(states).sort((a, b) => Number(a) - Number(b));
    if (stateIds.length === 0) return;
    // Pick state ids for the 3 tiers. First=ok, last=poor, middle=middling.
    const okId = stateIds[0];
    const poorId = stateIds[stateIds.length - 1];
    const middlingId = stateIds[Math.floor((stateIds.length - 1) / 2)] || okId;
    const resolve = async (sid) => {
      const did = getStateMediaByType(states[sid], "Image")?.file;
      if (!did) return null;
      try {
        return await fetchIconDataUrl(did >>> 0, "link-status");
      } catch (_) {
        return null;
      }
    };
    const [okUrl, middlingUrl, poorUrl] = await Promise.all([
      resolve(okId), resolve(middlingId), resolve(poorId),
    ]);
    if (okUrl) linkStateUrls.ok = okUrl;
    if (middlingUrl) linkStateUrls.middling = middlingUrl;
    if (poorUrl) linkStateUrls.poor = poorUrl;
    linkStateMapReady = !!(okUrl || middlingUrl || poorUrl);
    try {
      const resolvedCount = ["ok", "middling", "poor"].filter((k) => !!linkStateUrls[k]).length;
      window.__diag?.layout?.onLinkStatusStateMap?.({
        states: stateIds.length,
        resolved: resolvedCount,
      });
      // HUD rec #60 — warn when fewer than 3 tier sprites resolved; the
      // fallback hue-rotate filter will be in use, which debuggers should
      // notice rather than seeing a "tinted" indicator and assuming bug.
      if (resolvedCount < 3) {
        console.warn(
          `[status-indicators] link-state sprites partially resolved ` +
          `(${resolvedCount}/3 tiers); falling back to hue-rotate on the ok sprite`,
        );
      }
    } catch (_) {}
    // Re-apply current tier so the sprite swaps in immediately.
    if (linkEl && linkLastTier && linkStateUrls[linkLastTier]) {
      linkEl.style.backgroundImage = `url("${linkStateUrls[linkLastTier]}")`;
      linkEl.style.filter = "";
    }
  }
  // Fire-and-forget; the swap can land async without blocking the poll.
  void buildLinkStateMap();

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
      // P2-37 (cross-find indicators-states-link-01) — when the state
      // map is ready (StateDesc-driven sprites extracted from layout
      // 0x21000071), swap the real per-tier sprite. Falls back to the
      // hue-rotate placeholder until the async layout walk completes
      // (or for tiers whose state-id we couldn't resolve a sprite for).
      const stateUrl = linkStateMapReady ? linkStateUrls[tier] : null;
      if (stateUrl) {
        linkEl.style.backgroundImage = `url("${stateUrl}")`;
        linkEl.style.filter = "";
        linkEl.style.opacity = "1";
      } else if (tier === "ok") {
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

  // Wave 1.F (2026-05-28) — state wiring for vitae / burden / buffs /
  // debuffs / minigame / portalstorm. linkstatus already drives itself
  // via the 1Hz poll loop above. Indicators with no upstream emit site
  // remain at inactive default; their hypothesized hooks are documented
  // inline so a downstream wave can flip them on once the wire lands.
  //
  // Canonical state machines (Chorizite ACBindings):
  //   - gmUIElement_BurdenIndicator      RecvNotice_LoadChanged(float) — 5 states (light → overburdened)
  //   - gmUIElement_VitaeIndicator       RecvNotice_VitaeChanged()      — 3 states (visible when vitae<1.0)
  //   - gmUIElement_EffectsIndicator     RecvNotice_EnchantmentsChanged — 3 states (count>0 = active)
  //   - gmUIElement_PortalStormIndicator RecvNotice_PortalStormLevel(f) — 2 states (extent>0 = warn)
  //   - gmUIElement_LinkStatusIndicator  UpdateLinkState                — 4 states (already wired above)
  //   - gmUIElement_MiniGameIndicator    chess overlay                   — 3 states (no emit yet)
  //
  // Subscription pattern: pull the plugin client lazily — status-indicators
  // mounts during bar mount, BEFORE login completes + `window.__pluginClient`
  // exists. Same poll-for-client pattern as vitals-hud.js:324-355.
  const eventUnsubs = [];
  let clientPollTimer = null;

  // Shared sprite-flip helper. Mirrors `window.__setStatusIndicator`'s
  // active/inactive sprite swap so event-driven updates match the visual
  // path that buffs-hud uses today (otherwise vitae/buff/debuff would
  // never swap to their `active` DID even though .active class flipped).
  function setIndicatorActive(id, active) {
    const el = indicatorEls[id];
    if (!el) return;
    const ind = INDICATORS.find((i) => i.id === id);
    if (!ind) return;
    el.classList.toggle("active", !!active);
    el.style.backgroundImage = `url("./data/ui-sprites/${active ? ind.active : ind.inactive}.png")`;
  }

  // Burden thresholds mirror ACE.EncumbranceSystem.GetBurdenState — the
  // wasm `playerBurden` getter already returns the encumbrance/capacity
  // ratio (0.0 unloaded → 1.0 capped → 2.0 over-encumbered → ...). The
  // canonical 5-state ramp from acclient.c gmUIElement_BurdenIndicator
  // is light/moderate/heavy/very-heavy/over but we have a single sprite
  // here, so we collapse to a simple "active when carrying significant
  // load (>=50%)" gate. The CSS .active class brightens the icon; an
  // additional `over` data attribute is set when ratio>=1.0 so future
  // styles can tint it red.
  function applyBurden(ratio) {
    const el = indicatorEls.burden;
    if (!el) return;
    // 0.50 is the gentlest threshold that visibly distinguishes "carrying
    // a real load" from "empty backpack"; matches the 2-state collapse
    // documented above. ACE's GetBurdenState() returns 1..5 — when we
    // later have 5 distinct sprites this can become a state index.
    const active = ratio >= 0.5;
    setIndicatorActive("burden", active);
    el.dataset.over = ratio >= 1.0 ? "1" : "0";
  }

  // Vitae: 1.0 = no vitae, <1.0 = active death penalty (counter-intuitive
  // per handoff §3 row 4 / Character.cs:80-88). Active when ratio<1.0.
  function applyVitae(vitae) {
    const el = indicatorEls.vitae;
    if (!el) return;
    const active = vitae < 1.0;
    setIndicatorActive("vitae", active);
  }

  // Buff/debuff fallback: emit our own indicator state from raw enchantment
  // events. buffs-hud (when loaded) ALSO drives these via __setStatusIndicator,
  // so this is belt-and-braces — bus-event subscription means the indicator
  // still updates even if the buffs-hud plugin isn't loaded.
  //
  // EnchantmentTypeFlags (mirrors plugins/buffs-hud.js:ETF):
  const ETF_COOLDOWN    = 0x1000000;
  const ETF_BENEFICIAL  = 0x2000000;
  const ETF_ADDITIVE    = 0x0008000;
  const ETF_MULTIPLICATIVE = 0x0004000;
  function classifyEnchKind(e) {
    const t = (e?.type ?? e?.statModType ?? 0) | 0;
    if ((t & ETF_COOLDOWN) !== 0) return "cooldown";
    if ((t & ETF_BENEFICIAL) !== 0) return "buff";
    const v = Number(e?.statValue ?? e?.statModValue ?? 0);
    if ((t & ETF_ADDITIVE) !== 0) return v >= 0 ? "buff" : "debuff";
    if ((t & ETF_MULTIPLICATIVE) !== 0) return v >= 1.0 ? "buff" : "debuff";
    return "buff";
  }
  function applyEnchantmentSnapshot(snapshot) {
    if (!Array.isArray(snapshot)) return;
    let nBuff = 0, nDebuff = 0;
    for (const e of snapshot) {
      const k = classifyEnchKind(e);
      if (k === "buff") nBuff += 1;
      else if (k === "debuff") nDebuff += 1;
    }
    setIndicatorActive("buffs", nBuff > 0);
    setIndicatorActive("debuffs", nDebuff > 0);
  }

  function tryWireClient() {
    const client = window.__pluginClient ?? null;
    if (!client?.events?.on) return false;

    // Vitae — preferred path is `client.character` (typed Character with
    // its own vitaeChanged event); pre-Character-spawn fall back to
    // re-reading on every playerStatsUpdated.
    const onVitaeChanged = (evt) => {
      const v = Number(evt?.detail?.vitae ?? 1.0);
      applyVitae(v);
    };
    const onStatsUpdated = () => {
      // Vitae fallback: when typed Character isn't ready yet,
      // playerStatsUpdated still fires kind=8 and we can re-bind to
      // the typed Character once it lands.
      const ch = client.character ?? client.world?.character ?? null;
      if (ch && typeof ch.vitae === "number") applyVitae(ch.vitae);
      // Burden: read the wasm getter on every stats refresh. Mirrors
      // gmUIElement_BurdenIndicator::RecvNotice_LoadChanged from
      // ACBindings — the retail event fires whenever EncumbranceSystem
      // recomputes; our wasm side bundles that into kind=8.
      try {
        const handle = window.__sessionHandle;
        if (handle && typeof handle.playerBurden === "number") {
          applyBurden(handle.playerBurden);
        } else if (handle?.playerBurden && typeof handle.playerBurden === "function") {
          // Defensive: depending on wasm-bindgen output the property
          // surfaces as a getter (number) or a method (function).
          applyBurden(handle.playerBurden());
        }
      } catch (_) {}
    };
    client.events.on("playerStatsUpdated", onStatsUpdated);
    eventUnsubs.push(() => client.events.off?.("playerStatsUpdated", onStatsUpdated));

    // Attach vitae listener to Character once it's available. The typed
    // Character is set lazily on PLAYER_SPAWNED + ObjectCreate; we wait
    // for the FIRST playerStatsUpdated and re-check each subsequent one
    // until it's there, then attach.
    let charAttached = false;
    const tryAttachChar = () => {
      if (charAttached) return;
      const ch = client.character ?? client.world?.character ?? null;
      if (!ch || typeof ch.addEventListener !== "function") return;
      ch.addEventListener("vitaeChanged", onVitaeChanged);
      eventUnsubs.push(() => ch.removeEventListener?.("vitaeChanged", onVitaeChanged));
      charAttached = true;
      // Seed initial state.
      if (typeof ch.vitae === "number") applyVitae(ch.vitae);
    };
    client.events.on("playerStatsUpdated", tryAttachChar);
    eventUnsubs.push(() => client.events.off?.("playerStatsUpdated", tryAttachChar));

    // Buffs/debuffs — subscribe to world-state's per-enchantment events.
    // World-state's bus is `client.world` (it extends EventTarget). We
    // refresh on any add/remove using the full snapshot via
    // playerEnchantments() so the count stays in sync (avoids drift
    // from buffs-hud's parallel __setStatusIndicator calls).
    const refreshEnchIndicators = () => {
      try {
        const snap = client.player?.enchantments?.();
        if (snap) applyEnchantmentSnapshot(snap);
      } catch (_) {}
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
    // Belt-and-braces: also refresh on every stats update (catches the
    // first snapshot before world-state runs its diff).
    client.events.on("playerStatsUpdated", refreshEnchIndicators);
    eventUnsubs.push(() => client.events.off?.("playerStatsUpdated", refreshEnchIndicators));

    // Portal storm — Chorizite.ACProtocol opcodes Misc_PortalStormBrewing
    // (0x02C9), Misc_PortalStormImminent (0x02CA), Misc_PortalStorm (0x02CB),
    // Misc_PortalStormSubsided (0x02CC) are parsed in
    // crates/holtburger-protocol but NOT surfaced to JS as bus events yet
    // (see plugins/api.js coverage row #8 / data/chorizite/chorizite-acprotocol-opcodes.json).
    // When the wire surfaces, the bus name will likely be `portalStormChanged`
    // with `{level: 0..4}` mirroring gmUIElement_PortalStormIndicator's
    // RecvNotice_PortalStormLevel(float). Pre-emptively subscribe so the
    // indicator lights up the moment that wire lands without another edit.
    const onPortalStorm = (evt) => {
      const lvl = Number(evt?.detail?.level ?? evt?.detail?.extent ?? 0);
      setIndicatorActive("portalstorm", lvl > 0);
    };
    client.events.on("portalStormChanged", onPortalStorm);
    eventUnsubs.push(() => client.events.off?.("portalStormChanged", onPortalStorm));

    // Mini-game — Chorizite gmUIElement_MiniGameIndicator drives off the
    // chess-board UI open/close. No wire event today (chess isn't wired
    // server-side either). When chess lands, dispatch `miniGameChanged`
    // on the client bus with `{active: bool}` and this subscription will
    // flip the indicator. Documented hook only — no current emitter.
    const onMiniGame = (evt) => {
      const active = !!(evt?.detail?.active);
      setIndicatorActive("minigame", active);
    };
    client.events.on("miniGameChanged", onMiniGame);
    eventUnsubs.push(() => client.events.off?.("miniGameChanged", onMiniGame));

    // Initial seed — read whatever state is already cached so the
    // indicators are correct on a re-mount after the world has hydrated.
    onStatsUpdated();
    tryAttachChar();
    refreshEnchIndicators();

    return true;
  }

  // P3-41 — replace 500ms client-discovery poll with one-shot await on
  // the global pluginClient bootstrap promise. Falls back to the poll
  // when the promise isn't installed yet.
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
  };
}

// ─── Test-only helpers (Wave 1.F) ──────────────────────────────────────
// Exposed so the test_status_indicators.mjs harness can drive the
// pure-state-machine logic without booting a browser. Kept out of the
// production path — `mount()` is the only consumer in the wild.
export const __test = Object.freeze({
  /** Classify an enchantment as buff/debuff/cooldown — mirrors the
   *  module-private classifyEnchKind() with the same ETF flag literals. */
  classifyEnchKind(e) {
    const ETF_COOLDOWN = 0x1000000;
    const ETF_BENEFICIAL = 0x2000000;
    const ETF_ADDITIVE = 0x0008000;
    const ETF_MULTIPLICATIVE = 0x0004000;
    const t = (e?.type ?? e?.statModType ?? 0) | 0;
    if ((t & ETF_COOLDOWN) !== 0) return "cooldown";
    if ((t & ETF_BENEFICIAL) !== 0) return "buff";
    const v = Number(e?.statValue ?? e?.statModValue ?? 0);
    if ((t & ETF_ADDITIVE) !== 0) return v >= 0 ? "buff" : "debuff";
    if ((t & ETF_MULTIPLICATIVE) !== 0) return v >= 1.0 ? "buff" : "debuff";
    return "buff";
  },
  /** Burden ratio → indicator active flag. >=0.5 = active. */
  isBurdenActive(ratio) { return Number(ratio) >= 0.5; },
  /** Burden ratio → over-encumbered data attr. >=1.0 = over. */
  isBurdenOver(ratio) { return Number(ratio) >= 1.0; },
  /** Vitae ratio → indicator active flag. <1.0 = active (death penalty). */
  isVitaeActive(vitae) { return Number(vitae) < 1.0; },
  /** Indicator id list — used by tests to assert all 7 are present. */
  INDICATORS,
});
