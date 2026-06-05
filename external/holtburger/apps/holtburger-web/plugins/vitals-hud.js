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
// === Wave 3.C — per-vital events (2026-05-28) ===
// The plugin now ALSO subscribes to `vitalChangedHealth/Stamina/Mana`
// (kind=42/43/44, see src/lib.rs + index.html drainEvents) for smooth
// per-bar animation. The coalesced `playerStatsUpdated` (kind=8)
// remains the fallback path so first-paint after login (when only
// kind=8 fires from the snapshot-publish hook) still works, and any
// state we don't read from the snapshot (e.g. derived/buffed_max
// recomputed by an attribute change) still rebuilds the row. The
// per-vital fast path mutates ONLY the bar that moved.
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

import { applyLayoutRegions } from "../ui/ac_layout.js";
import { attachDefaultTopDragHandle, WINDOW_ID } from "../ui/ac_window_position.js";

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
    /* P1-19 (cross-find vitals-labels-hidden): show 1-char vital label
       inline before the bar — matches retail gmFloatyVitalsUI layout
       0x2100006C which carries label text alongside each meter. */
    #${OVERLAY_ID} .hud-vital-label {
      display: inline-block;
      width: 12px;
      margin-right: 4px;
      font-size: 11px;
      font-family: var(--hb-font-serif);
      color: var(--hb-text-cream-bright);
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.85);
      text-align: center;
      vertical-align: middle;
      pointer-events: none;
    }
    #${OVERLAY_ID} .hud-vital-bar {
      position: relative;
      /* P1-19 (cross-find vitals-bar-width-mismatch): retail HealthMeter /
         StaminaMeter / ManaMeter in layout 0x2100006C all carry width=150
         (verified via the layout JSON dump). Was 250px. */
      width: 150px;
      height: 16px;
      background: transparent;
      overflow: hidden;
      border: none;
      vertical-align: middle;
      display: inline-block;
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
    /* P1-19 (cross-find vitals-nums-position): right-anchor numeric
       readout so it doesn't overlap the bar fill animation. Was
       center-anchored which hid the % progress under the digits. */
    #${OVERLAY_ID} .hud-vital-nums {
      position: absolute;
      right: 4px;
      top: 50%;
      transform: translateY(-50%);
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

// === Wave 3.C — per-vital granular paint (2026-05-28) ===
//
// Mutate a single vital row in place given the wire-side (current,
// buffedMax) tuple from kind=42/43/44. Called from the per-vital bus
// subscription so only the bar that moved repaints. If no row exists
// yet for `type` (e.g. the per-vital event arrived before the first
// kind=8 snapshot built the row), this is a no-op — the next kind=8
// `playerStatsUpdated` will build it via `renderVitals`.
//
// Mirrors the per-row mutation block inside `renderVitals` to stay
// byte-identical at the DOM level. Only the rebuild / cleanup paths
// from the full renderer are skipped.
function applyVitalDelta(overlay, type, current, buffedMax) {
  const refs = overlay.__vitalRefs;
  if (!refs) return; // First-paint race; kind=8 will build the row.
  const entry = refs.get(type);
  if (!entry) return; // Row not in the packet yet — wait for kind=8.

  const pct = buffedMax > 0
    ? Math.max(0, Math.min(100, (current / buffedMax) * 100))
    : 0;
  const pctStr = `${pct.toFixed(1)}%`;
  const numsStr = `${current} / ${buffedMax}`;

  if (entry.lastPctStr !== pctStr) {
    entry.fillEl.style.width = pctStr;
    entry.lastPctStr = pctStr;
  }
  if (entry.lastNumsStr !== numsStr) {
    entry.numsEl.textContent = numsStr;
    entry.lastNumsStr = numsStr;
  }
  // The overlay may still be hidden if the first snapshot hasn't
  // landed (hidden=true sentinel set by renderVitals on empty
  // input). Reveal it now — we have authoritative wire data.
  if (overlay.hidden) overlay.hidden = false;
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
function applyVitalsLayout(refs) {
  // Build the {element_id → DOM ref} map for applyLayoutRegions.
  // Root sizes the overlay; per-vital rows size each HP/ST/MN strip.
  const elemRefs = { [VITALS_ELEMS.root]: refs.overlay };
  if (refs.rowsByType) {
    for (const [type, entry] of refs.rowsByType) {
      const elemId = VITAL_ELEM_BY_TYPE[type];
      if (!elemId || !entry?.rowEl) continue;
      elemRefs[elemId] = entry.rowEl;
    }
  }
  applyLayoutRegions(VITALS_LAYOUT_ID, elemRefs, {
    // mountBar-early-mount (retry default).
    beforeApplyEl: (el) => {
      // Per-row absolute positioning so the layout-driven left/top
      // wins over the overlay's flex-column flow. The row class is
      // `hud-vital ${type}` (per addVitalRow), not `hud-vital-row`.
      if (el.classList.contains("hud-vital")) {
        el.style.position = "absolute";
      }
    },
    afterApply: (_layout, applied) => {
      // The inner .hud-vital-bar needs to fill its row (CSS default
      // is fixed 250-px). Apply after rows have their new widths.
      if (refs.rowsByType) {
        for (const [, entry] of refs.rowsByType) {
          const barEl = entry?.rowEl?.querySelector(".hud-vital-bar");
          if (barEl) { barEl.style.width = "100%"; barEl.style.height = "100%"; }
        }
      }
      try { window.__diag?.layout?.onVitalsApplied?.({ applied }); } catch (_) {}
    },
  });
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
  attachDefaultTopDragHandle(overlay, WINDOW_ID.VITALS);

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

    // === Wave 3.C — per-vital granular subscriptions (2026-05-28) ===
    // Vital types match `holtburger_common::stats::VitalType` (Health=1,
    // Stamina=3, Mana=5) and the VITAL_SHORT / VITAL_CLASS maps above.
    // Each handler paints exactly one bar — full `render()` only fires
    // on the coalesced kind=8 fallback.
    const onHealth = (e) => {
      applyVitalDelta(overlay, 1, e.detail?.current ?? 0, e.detail?.buffedMax ?? 0);
    };
    const onStamina = (e) => {
      applyVitalDelta(overlay, 3, e.detail?.current ?? 0, e.detail?.buffedMax ?? 0);
    };
    const onMana = (e) => {
      applyVitalDelta(overlay, 5, e.detail?.current ?? 0, e.detail?.buffedMax ?? 0);
    };
    client.events.on("vitalChangedHealth", onHealth);
    client.events.on("vitalChangedStamina", onStamina);
    client.events.on("vitalChangedMana", onMana);

    unsubscribe = () => {
      client.events.off("playerStatsUpdated", render);
      client.events.off("vitalChangedHealth", onHealth);
      client.events.off("vitalChangedStamina", onStamina);
      client.events.off("vitalChangedMana", onMana);
    };
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
