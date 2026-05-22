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

const OVERLAY_ID = "hb-vitals-hud";

// Vital-type codes match `crates/holtburger-protocol/src/messages/
// movement/types.rs::VitalsKind` + the original index.html mapping.
const VITAL_SHORT = { 1: "HP", 3: "ST", 5: "MN" };
const VITAL_CLASS = { 1: "health", 3: "stamina", 5: "mana" };

let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = "hb-vitals-hud-style";
  // Mirrors the prior `#vitals-hud-overlay` CSS verbatim so the
  // pre-plugin presentation is byte-identical.
  style.textContent = `
    #${OVERLAY_ID} {
      position: fixed;
      top: 6px;
      left: 260px;
      z-index: 50;
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 0;
      background: transparent;
      border: none;
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
    #${OVERLAY_ID} .hud-vital-label {
      font-weight: 600;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--hb-text-cream);
      width: 24px;
      text-align: right;
      padding-right: 6px;
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.8);
    }
    #${OVERLAY_ID} .hud-vital-bar {
      position: relative;
      width: 250px;
      height: 16px;
      background: rgba(0, 0, 0, 0.7);
      border-radius: 0;
      overflow: hidden;
      border: 1px solid var(--hb-border-brass);
      box-shadow:
        inset 0 0 4px rgba(0, 0, 0, 0.9),
        0 0 0 1px var(--hb-border-brass-deep),
        0 1px 2px rgba(0, 0, 0, 0.6);
    }
    #${OVERLAY_ID} .hud-vital-fill {
      position: absolute;
      top: 0; left: 0; bottom: 0;
      transition: width 120ms linear;
      box-shadow:
        inset 0 1px 2px rgba(255, 255, 255, 0.35),
        inset 0 -2px 3px rgba(0, 0, 0, 0.45);
    }
    #${OVERLAY_ID} .hud-vital.health .hud-vital-fill {
      background: linear-gradient(180deg, #ff5a5a 0%, #c81818 60%, #6a0a0a 100%);
    }
    #${OVERLAY_ID} .hud-vital.stamina .hud-vital-fill {
      background: linear-gradient(180deg, #ffd070 0%, #d89028 60%, #6a4818 100%);
    }
    #${OVERLAY_ID} .hud-vital.mana .hud-vital-fill {
      background: linear-gradient(180deg, #5aa0ff 0%, #2860d0 60%, #0a2870 100%);
    }
    #${OVERLAY_ID} .hud-vital-nums {
      position: absolute;
      right: 8px;
      top: 50%;
      transform: translateY(-50%);
      min-width: 0;
      font-size: 11px;
      font-family: var(--hb-font-serif);
      color: var(--hb-text-cream-bright);
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.95), 0 0 2px rgba(0, 0, 0, 0.8);
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

  const labelEl = document.createElement("span");
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

  const numsEl = document.createElement("span");
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

  overlay.hidden = false;
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
