// Top-of-screen HP / Stamina / Mana overlay.
//
// Pre-2026-05-17 this lived directly in `index.html` (Phase H.2) —
// a `#vitals-hud-overlay` div appended to document.body + a local
// `renderVitalsHud()` function called from the kind=8 stats
// dispatcher. The user flagged that as a violation of the
// "everything is a plugin" framework. This file is the extraction:
// same DOM presentation, but mounted through the bar's per-slot
// `mount()` lifecycle, subscribed to `client.events.playerStatsUpdated`
// for refresh, and registered with `iconHidden: true` so it doesn't
// claim a bar slot.
//
// Layout-driven positions: retail's gmFloatyVitalsUI (LayoutDesc
// 0x2100006C) packs three 150×16 horizontal bars inside a 160×58
// frame. Element-id map confirmed by vitals_hud_layout_dump 2026-05-24:
//   0x100005F9 — root panel (160×58, has 19 children: 16 frame
//                corners/edges + 3 vital bars)
//   0x100000E6 — HP bar (type=7 meter, 150×16 at 5,5)
//   0x100000EC — Stamina bar (type=7 meter, 150×16 at 5,21)
//   0x100000EE — Mana bar (type=7 meter, 150×16 at 5,37)
// Each bar shares the same inner 3-slice sprite layout:
//   0x100000E8 — left rim cap   (10×16 at 0,0)
//   0x100000E9 — middle fill    (130×16 at 10,0)
//   0x100000EA — right rim cap  (10×16 at 140,0)
//   0x100004A9 — fill marker    (varies; retail's "cursor" inside
//                                the meter, x/w differs per bar)

import { loadLayout, findElementById, getCachedLayout } from "../ui/ac_layout.js";

const OVERLAY_ID = "hb-vitals-hud";

// Vital-type codes match `crates/holtburger-protocol/src/messages/
// movement/types.rs::VitalsKind` + the original index.html mapping.
const VITAL_SHORT = { 1: "HP", 3: "ST", 5: "MN" };
const VITAL_CLASS = { 1: "health", 3: "stamina", 5: "mana" };

/** gmFloatyVitalsUI — retail layout that drives the vitals HUD.
 *  Element-id constants for the consumer; full purpose-map in the
 *  head comment above. */
const VITALS_LAYOUT_ID = 0x2100006C;
const VITALS_ELEMS = {
  root: 0x100005F9,
  hp:   0x100000E6,
  st:   0x100000EC,
  mn:   0x100000EE,
};
// Per-vital-type → retail element_id for the bar row.
const VITAL_ELEM_BY_TYPE = { 1: VITALS_ELEMS.hp, 3: VITALS_ELEMS.st, 5: VITALS_ELEMS.mn };

let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = "hb-vitals-hud-style";
  // Mirrors the prior `#vitals-hud-overlay` CSS verbatim so the
  // pre-plugin presentation is byte-identical.
  style.textContent = `
    /* Retail composes the 3 vials as one UIElement_Meter group with a
       brass-frame wrapper around the whole cluster (not per-vial frames).
       Wrapper uses the panel 9-slice for the beveled outer chrome;
       padding pushes the vials in just enough that the sprite rims sit
       inside the brass corners. */
    #${OVERLAY_ID} {
      position: fixed;
      top: 6px;
      left: 260px;
      z-index: 50;
      /* Retail layout (gmFloatyVitalsUI 0x2100006C) positions the 3
         bar rows absolutely inside the root panel at (5,5/21/37).
         When applyVitalsLayout() runs, it sets position:absolute on
         each row + applies retail (x,y,w,h). The container holds
         box dims (160×58 from layout root); padding stays at 0 so
         row offsets land at retail-exact positions inside the
         border-image chrome. */
      box-sizing: content-box;
      padding: 0;
      background: linear-gradient(180deg, var(--hb-bg-stone-top) 0%, var(--hb-bg-stone-bottom) 100%);
      border: 6px solid transparent;
      border-image: url("./sprites/acsprites/panel.png") 6 / 6px / 0 stretch;
      box-shadow: var(--hb-shadow-panel);
      font-family: var(--hb-font-serif);
      pointer-events: none;
    }
    #${OVERLAY_ID}[hidden] { display: none; }
    #${OVERLAY_ID} .hud-vital {
      position: relative;
      display: flex;
      align-items: center;
      gap: 0;
      font-variant-numeric: tabular-nums;
    }
    /* HP/ST/MN labels removed per direction 2026-05-22 — retail doesn't
       label its vials. The sprite already carries the brass rim + beveled
       liquid-in-vial gradient; we don't add any extra border that would
       compress the sprite vertically or hide the bevel. */
    #${OVERLAY_ID} .hud-vital-label { display: none; }
    #${OVERLAY_ID} .hud-vital-bar {
      position: relative;
      width: 250px;
      height: 16px;
      background: transparent;
      overflow: hidden;
      border: none;
    }
    #${OVERLAY_ID} .hud-vital-fill {
      position: absolute;
      top: 0; left: 0; bottom: 0;
      transition: width 120ms linear;
    }
    /* Real retail DAT sprites — extracted 2026-05-22 from layout
       0x2100006C (gmFloatyVitalsUI) via WB.Terminal. 100x16 RGBA with
       brass top/bottom rim already baked in. */
    #${OVERLAY_ID} .hud-vital.health .hud-vital-fill {
      background: url("./data/ui-sprites/0x06007482.png") 0/100% 100% no-repeat;
    }
    #${OVERLAY_ID} .hud-vital.stamina .hud-vital-fill {
      background: url("./data/ui-sprites/0x06007488.png") 0/100% 100% no-repeat;
    }
    #${OVERLAY_ID} .hud-vital.mana .hud-vital-fill {
      background: url("./data/ui-sprites/0x0600748E.png") 0/100% 100% no-repeat;
    }
    #${OVERLAY_ID} .hud-vital-nums {
      position: absolute;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      min-width: 0;
      font-size: 10px;
      font-family: var(--hb-font-serif);
      color: var(--hb-text-cream-bright);
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.95), 0 0 2px rgba(0, 0, 0, 0.85);
      pointer-events: none;
    }
  `;
  document.head.appendChild(style);
}

// Build a single row's DOM (one vital). Returns the row + direct
// references to the mutable fields so subsequent updates can avoid
// an innerHTML rebuild.
function buildVitalRow(type) {
  const cls = VITAL_CLASS[type] || "";
  const short = VITAL_SHORT[type] || "?";

  const rowEl = document.createElement("div");
  rowEl.className = `hud-vital ${cls}`.trim();

  // Labels and numeric readouts render in the retail AC bitmap font
  // once the font runtime loads; until then they show as the page's
  // default-styled text. `<ac-text>` is defined in `ui/ac_font.js`.
  const labelEl = document.createElement("ac-text");
  labelEl.className = "hud-vital-label";
  labelEl.textContent = short;
  rowEl.appendChild(labelEl);

  const barEl = document.createElement("div");
  barEl.className = "hud-vital-bar";
  const fillEl = document.createElement("div");
  fillEl.className = "hud-vital-fill";
  fillEl.style.width = "0%";
  barEl.appendChild(fillEl);
  rowEl.appendChild(barEl);

  const numsEl = document.createElement("ac-text");
  numsEl.className = "hud-vital-nums";
  numsEl.textContent = "";
  rowEl.appendChild(numsEl);

  return {
    rowEl,
    fillEl,
    numsEl,
    // Track last-applied values so we can skip writes when unchanged.
    // `null` sentinel forces the first paint to write.
    lastPctStr: null,
    lastNumsStr: null,
  };
}

// Build-once / mutate-many. We stash a per-type Map of row refs on the
// overlay element itself (`overlay.__vitalRefs`) so the renderer stays
// pure-functional from the caller's perspective. Dynamic bar count is
// handled by adding rows for new types and removing rows whose type
// disappeared from the packet.
function renderVitals(overlay, vitals) {
  if (!vitals || vitals.length === 0) {
    overlay.hidden = true;
    return;
  }

  let refs = overlay.__vitalRefs;
  if (!refs) {
    refs = new Map();
    overlay.__vitalRefs = refs;
  }

  // Wire layout from `lib.rs`: vitals packs `[type, current, base,
  // buffed_max] × N`. Same loop as the old index.html block, but we
  // mutate per-field instead of regenerating innerHTML.
  const seen = new Set();
  let addedNewRow = false;
  for (let i = 0; i + 3 < vitals.length; i += 4) {
    const type = vitals[i];
    const current = vitals[i + 1];
    const buffedMax = vitals[i + 3];
    const pct = buffedMax > 0
      ? Math.max(0, Math.min(100, (current / buffedMax) * 100))
      : 0;
    const pctStr = `${pct.toFixed(1)}%`;
    const numsStr = `${current} / ${buffedMax}`;

    let entry = refs.get(type);
    if (!entry) {
      entry = buildVitalRow(type);
      refs.set(type, entry);
      overlay.appendChild(entry.rowEl);
      addedNewRow = true;
    }

    if (entry.lastPctStr !== pctStr) {
      entry.fillEl.style.width = pctStr;
      entry.lastPctStr = pctStr;
    }
    if (entry.lastNumsStr !== numsStr) {
      entry.numsEl.textContent = numsStr;
      entry.lastNumsStr = numsStr;
    }
    seen.add(type);
  }

  // Drop rows whose type no longer appears in the packet. Cheap to
  // walk — at most 3 entries in practice (HP/ST/MN).
  for (const [type, entry] of refs) {
    if (!seen.has(type)) {
      entry.rowEl.remove();
      refs.delete(type);
    }
  }

  // Re-apply gmFloatyVitalsUI layout to the newly-added bar rows so
  // their position/size mirror the retail layout. Cached after the
  // first successful apply, so this is a sync no-op when wasm + the
  // local shard have already landed.
  if (addedNewRow) {
    applyVitalsLayout({ overlay, rowsByType: refs });
  }

  overlay.hidden = false;
}

// Apply gmFloatyVitalsUI 0x2100006C to the vitals overlay + each bar row.
//
// Mounts BEFORE `init_resource_source` populates `window.__hbWasm`
// (vitals-hud is bar-mounted at page load like radar). Retry every
// 2s up to 8 times if `loadLayout` returns null. Render still works
// from CSS defaults during the retry window — layout-driven sizing
// only refines positions/dimensions.
function applyVitalsLayout(refs, attempt = 0) {
  const apply = (layout) => {
    if (!layout) {
      if (attempt < 8) {
        setTimeout(() => applyVitalsLayout(refs, attempt + 1), 2000);
      }
      return;
    }
    let applied = 0;
    // Root frame — size the overlay to the retail dimensions.
    const root = findElementById(layout, VITALS_ELEMS.root);
    if (root && refs.overlay) {
      // The overlay's screen anchor (top/left) is a Holtburger UX
      // choice and is NOT touched by layout — only width/height.
      if (typeof root.width === "number") {
        refs.overlay.style.width = `${root.width}px`;
      }
      if (typeof root.height === "number") {
        refs.overlay.style.height = `${root.height}px`;
      }
      applied += 1;
    }
    // Per-vital bar rows — explicit (left, top, width, height).
    // Retail's gmFloatyVitalsUI uses absolute positioning inside the
    // root (it's a fixed-layout panel, not a flexbox). Clear the
    // overlay's `flex-direction: column` defaults won't fight us
    // because position:absolute takes elements out of flow.
    if (refs.rowsByType) {
      for (const [type, entry] of refs.rowsByType) {
        const elemId = VITAL_ELEM_BY_TYPE[type];
        if (!elemId) continue;
        const desc = findElementById(layout, elemId);
        if (!desc || !entry?.rowEl) continue;
        entry.rowEl.style.position = "absolute";
        if (typeof desc.x === "number") entry.rowEl.style.left = `${desc.x}px`;
        if (typeof desc.y === "number") entry.rowEl.style.top = `${desc.y}px`;
        if (typeof desc.width === "number") entry.rowEl.style.width = `${desc.width}px`;
        if (typeof desc.height === "number") entry.rowEl.style.height = `${desc.height}px`;
        // The inner `.hud-vital-bar` needs to inherit the row width
        // (its CSS default is a fixed 250px). Make it fill the row
        // since the row is now retail-sized.
        const barEl = entry.rowEl.querySelector(".hud-vital-bar");
        if (barEl) {
          barEl.style.width = "100%";
          barEl.style.height = "100%";
        }
        applied += 1;
      }
    }
    try {
      window.__diag?.layout?.onVitalsApplied?.({ applied });
    } catch (_) {}
  };
  const cached = getCachedLayout(VITALS_LAYOUT_ID);
  if (cached) { apply(cached); return; }
  loadLayout(VITALS_LAYOUT_ID).then(apply).catch(() => {});
}

export const manifest = {
  id: "vitals-hud",
  name: "Vitals",
  // No bar icon — the overlay IS the presentation. iconHidden tells
  // `mountBar` to skip the bar-button render but still call `mount`.
  icon: "❤",
  iconHidden: true,
  version: "0.1.0",
  description: "Top-of-screen HP/Stamina/Mana bars (always visible)",
};

export function mount(ctx) {
  ensureStyles();
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();
  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.hidden = true;
  document.body.appendChild(overlay);

  // Size the overlay to retail dimensions on first mount. Bar rows
  // are positioned by `renderVitals` as they're added; layout sticks
  // because `applyVitalsLayout` accepts the rowsByType map and the
  // layout is cached after the first success.
  applyVitalsLayout({ overlay, rowsByType: overlay.__vitalRefs });

  // The plugin-client is created post-login (window.__pluginClient
  // is set inside the loginForm submit handler in index.html). Bar
  // mount runs at page load, BEFORE login, so `ctx.client` is null
  // at this point. Poll for it briefly, then subscribe.
  let pollTimer = null;
  let unsubscribe = null;

  function tryHook() {
    const client = ctx?.client ?? window.__pluginClient ?? null;
    if (!client?.events?.on || !client?.player) {
      return false;
    }
    const render = () => {
      try {
        const stats = client.player.stats;
        renderVitals(overlay, stats?.vitals);
      } catch (e) {
        // Stats accessor can throw before the player biota lands —
        // hide the overlay until the next event.
        overlay.hidden = true;
      }
    };
    client.events.on("playerStatsUpdated", render);
    unsubscribe = () => client.events.off("playerStatsUpdated", render);
    render();
    return true;
  }

  if (!tryHook()) {
    pollTimer = setInterval(() => {
      if (tryHook()) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }, 500);
  }

  return () => {
    if (pollTimer) clearInterval(pollTimer);
    if (unsubscribe) unsubscribe();
    overlay.remove();
  };
}
