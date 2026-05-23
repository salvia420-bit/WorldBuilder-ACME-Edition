// Buffs / debuffs HUD — popup strip of active enchantments, wired to
// the status-indicators "buffs" / "debuffs" slots (retail's Beneficial
// Spells / Harmful Spells indicators).
//
// PR-JJ 2026-05-23:
//   - Hidden by default; the user clicks the buffs (blue starburst,
//     0x0600749C/D) or debuffs (red starburst, 0x0600749E/F) status
//     indicator to toggle the strip. Clicking the same indicator
//     again closes it. Clicking the other one swaps the filter.
//   - Strip mounts below the status-indicators bar (top:40px ish so
//     it doesn't collide with vitals at left:260px).
//   - The two status indicators light up (active state) when their
//     respective enchantment count > 0 — driven by this plugin via
//     `window.__setStatusIndicator(id, bool)` (exposed by
//     status-indicators.js).
//
// Classification (buff vs debuff): no IS_BENEFICIAL flag on
// spells-catalog.json yet, so we use a name-keyword heuristic that
// covers the canonical retail debuff name family (Weakness / Harm /
// Slow / Bane / etc.). Anything not matched is treated as a buff —
// safe default for the visible-spells-strip use case. Refine when
// we extract IS_BENEFICIAL from SpellTable.
//
// Wasm source: `handle.playerEnchantments()` (new PR-JJ getter) —
// re-pulled on every `playerStatsUpdated` event from the plugin bus.

const OVERLAY_ID = "hb-buffs-hud";
const STYLE_ID = "hb-buffs-hud-style";

// Debuff name-keyword heuristic. Case-insensitive substring match.
const DEBUFF_PATTERNS = [
  "weakness", "harm", "slow", "bane", "vulnerability", "foolishness",
  "feeblemind", "bafflement", "senility", "frailty", "imperil",
  "defenselessness", "lethargy", "helplessness", "hopelessness",
  "halt", "confound", "curse", "drain", "leaden", "weariness",
  "sluggish", "blight", "abasement", "humiliation", "stoic", "vapid",
  "myopia", "fester", "fragile", "decay",
];

function classifyBuffDebuff(spellName) {
  if (!spellName) return "buff";
  const lower = spellName.toLowerCase();
  for (const p of DEBUFF_PATTERNS) {
    if (lower.includes(p)) return "debuff";
  }
  return "buff";
}

// Spell catalog cache.
let spellCatalog = null;
let spellCatalogPromise = null;
function loadSpellCatalog() {
  if (spellCatalog) return Promise.resolve(spellCatalog);
  if (spellCatalogPromise) return spellCatalogPromise;
  spellCatalogPromise = fetch("./data/spells-catalog.json")
    .then((r) => r.json())
    .then((d) => {
      spellCatalog = d?.spells ?? d ?? {};
      return spellCatalog;
    })
    .catch((e) => {
      console.warn("[buffs-hud] spell catalog load failed", e);
      spellCatalog = {};
      return spellCatalog;
    });
  return spellCatalogPromise;
}

// Icon cache.
const iconCache = new Map();
async function fetchIconDataUrl(iconId) {
  if (!iconId) return null;
  const cached = iconCache.get(iconId);
  if (cached !== undefined) {
    if (cached instanceof Promise) return cached;
    return cached;
  }
  const wasm = window.__hbWasm ?? window.__wasm ?? null;
  if (!wasm?.fetch_surface_pixels) {
    iconCache.set(iconId, false);
    return false;
  }
  const p = (async () => {
    try {
      const r = await wasm.fetch_surface_pixels(iconId >>> 0);
      if (!r || !r.width || !r.height || !r.pixels?.length) return false;
      const canvas = document.createElement("canvas");
      canvas.width = r.width; canvas.height = r.height;
      const cx = canvas.getContext("2d");
      const img = cx.createImageData(r.width, r.height);
      img.data.set(r.pixels);
      cx.putImageData(img, 0, 0);
      return canvas.toDataURL("image/png");
    } catch (e) {
      console.warn(`[buffs-hud] icon ${iconId} fetch failed:`, e);
      return false;
    }
  })();
  iconCache.set(iconId, p);
  const url = await p;
  iconCache.set(iconId, url);
  return url;
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    #${OVERLAY_ID} {
      position: fixed;
      top: 40px;
      left: 32px;
      z-index: 51;
      pointer-events: auto;
      display: none;
      gap: 3px;
      padding: 4px 6px;
      max-width: 520px;
      flex-wrap: wrap;
      font-family: var(--hb-font-serif);
      background: rgba(20, 14, 8, 0.92);
      border: 1px solid var(--hb-border-brass);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.55);
    }
    #${OVERLAY_ID}[data-open="1"] { display: flex; }
    #${OVERLAY_ID} .hb-buff {
      width: 24px;
      height: 24px;
      position: relative;
      background: rgba(0, 0, 0, 0.55);
      border: 1px solid var(--hb-border-brass-dim);
      box-sizing: border-box;
      font-size: 14px;
      line-height: 24px;
      text-align: center;
      color: var(--hb-text-cream);
      cursor: help;
      user-select: none;
      transition: border-color 80ms;
    }
    #${OVERLAY_ID} .hb-buff:hover { border-color: var(--hb-text-gold); }
    #${OVERLAY_ID} .hb-buff.debuff { border-color: rgba(180, 60, 60, 0.6); }
    #${OVERLAY_ID} .hb-buff.debuff:hover { border-color: rgba(220, 80, 80, 1); }
    #${OVERLAY_ID} .hb-buff img {
      width: 100%; height: 100%;
      image-rendering: pixelated;
      object-fit: contain;
    }
    #${OVERLAY_ID} .hb-buff-time {
      position: absolute;
      bottom: -1px; left: -1px; right: -1px;
      background: rgba(0, 0, 0, 0.85);
      color: var(--hb-text-cream-bright);
      font-size: 7px;
      line-height: 8px;
      font-family: var(--hb-font-serif);
      letter-spacing: -0.02em;
      font-variant-numeric: tabular-nums;
      text-align: center;
      padding: 1px 0;
      pointer-events: none;
    }
    #${OVERLAY_ID} .hb-buff-layer {
      position: absolute;
      top: -1px; right: -1px;
      background: var(--hb-text-gold);
      color: #000;
      font-size: 7px;
      line-height: 8px;
      padding: 0 1px;
      pointer-events: none;
      border-bottom-left-radius: 2px;
    }
    #${OVERLAY_ID} .hb-buff-empty {
      color: var(--hb-text-muted-3);
      font-style: italic;
      font-size: 10px;
      padding: 2px 8px;
    }
  `;
  document.head.appendChild(s);
}

function fmtRemaining(secs) {
  if (!Number.isFinite(secs) || secs <= 0) return "∞";
  if (secs < 60) return `${Math.ceil(secs)}s`;
  if (secs < 3600) {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }
  return `${Math.floor(secs / 3600)}h`;
}

function nowSeconds() {
  return Date.now() / 1000;
}

function remainingSeconds(ench) {
  if (!ench.duration || ench.duration <= 0) return Infinity;
  const elapsed = nowSeconds() - ench.startTime;
  return ench.duration - elapsed;
}

// Module-scope state — single overlay per page.
let state = {
  overlayEl: null,
  filter: null,            // "buff" | "debuff" | null (all)
  enchantments: [],        // last-known snapshot (for in-place tick re-render)
  getCasterName: () => null,
};

function classifyEnch(ench) {
  const meta = spellCatalog?.[String(ench.spellId)] || {};
  return classifyBuffDebuff(meta.name);
}

function render() {
  const ov = state.overlayEl;
  if (!ov) return;
  const all = state.enchantments;
  const filter = state.filter;
  const list = filter
    ? all.filter((e) => classifyEnch(e) === filter)
    : all;

  ov.innerHTML = "";
  if (list.length === 0) {
    const empty = document.createElement("div");
    empty.className = "hb-buff-empty";
    empty.textContent = filter === "debuff"
      ? "No harmful spells active."
      : filter === "buff"
        ? "No beneficial spells active."
        : "No active spells.";
    ov.appendChild(empty);
    return;
  }

  // Longest-remaining first.
  const sorted = list.slice().sort((a, b) => {
    const ra = remainingSeconds(a);
    const rb = remainingSeconds(b);
    if (ra === Infinity && rb === Infinity) return 0;
    if (ra === Infinity) return -1;
    if (rb === Infinity) return 1;
    return rb - ra;
  });

  for (const ench of sorted) {
    const meta = spellCatalog?.[String(ench.spellId)] || {};
    const kind = classifyEnch(ench);
    const cell = document.createElement("div");
    cell.className = "hb-buff" + (kind === "debuff" ? " debuff" : "");
    cell.dataset.spellId = String(ench.spellId);
    cell.textContent = kind === "debuff" ? "☠" : "✦";
    if (meta.icon) {
      fetchIconDataUrl(meta.icon).then((url) => {
        if (!url || !cell.isConnected) return;
        cell.textContent = "";
        const img = document.createElement("img");
        img.src = url;
        img.alt = meta.name || "";
        cell.appendChild(img);
      });
    }
    if (ench.layer > 0) {
      const layer = document.createElement("div");
      layer.className = "hb-buff-layer";
      layer.textContent = String(ench.layer);
      cell.appendChild(layer);
    }
    const time = document.createElement("div");
    time.className = "hb-buff-time";
    time.textContent = fmtRemaining(remainingSeconds(ench));
    cell.appendChild(time);

    const casterName = state.getCasterName?.(ench.casterGuid)
      || `0x${(ench.casterGuid >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
    cell.title =
      `${meta.name || `Spell ${ench.spellId}`} (${kind})\n` +
      `Caster: ${casterName}\n` +
      `Power: ${ench.powerLevel}` +
      (ench.duration > 0
        ? `\nRemaining: ${fmtRemaining(remainingSeconds(ench))}`
        : `\nDuration: permanent`);
    ov.appendChild(cell);
  }
}

function syncIndicators() {
  if (typeof window.__setStatusIndicator !== "function") return;
  let nBuff = 0;
  let nDebuff = 0;
  for (const e of state.enchantments) {
    if (classifyEnch(e) === "debuff") nDebuff++;
    else nBuff++;
  }
  window.__setStatusIndicator("buffs", nBuff > 0);
  window.__setStatusIndicator("debuffs", nDebuff > 0);
}

function toggleStrip(which) {
  const ov = state.overlayEl;
  if (!ov) return;
  const isOpen = ov.dataset.open === "1";
  if (isOpen && state.filter === which) {
    // Same indicator clicked → close.
    ov.dataset.open = "0";
    state.filter = null;
  } else {
    state.filter = which || null;
    ov.dataset.open = "1";
    render();
  }
}

export const manifest = {
  id: "buffs-hud",
  name: "Buffs",
  icon: "✦",
  iconHidden: true,
  version: "0.2.0",
  description: "Active-spells strip — toggled by the Beneficial/Harmful status indicators",
};

export function mount(ctx) {
  ensureStyles();
  loadSpellCatalog();
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();
  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.dataset.open = "0";
  document.body.appendChild(overlay);
  state.overlayEl = overlay;

  // Expose toggle so status-indicators.js can drive us.
  window.__buffsHudToggle = (which) => toggleStrip(which);

  let pollTimer = null;
  let unsubscribe = null;
  let tickTimer = null;

  function tryHook() {
    const client = ctx?.client ?? window.__pluginClient ?? null;
    const handle = window.__sessionHandle ?? null;
    if (!client?.events?.on || !handle?.playerEnchantments) return false;

    state.getCasterName = (guid) => {
      try {
        const ent = handle.entityByGuid?.(guid >>> 0);
        return ent?.name || null;
      } catch { return null; }
    };

    const refresh = () => {
      try {
        const list = handle.playerEnchantments() || [];
        state.enchantments = list;
        syncIndicators();
        if (overlay.dataset.open === "1") render();
      } catch (e) {
        state.enchantments = [];
        syncIndicators();
      }
    };

    client.events.on("playerStatsUpdated", refresh);
    unsubscribe = () => client.events.off?.("playerStatsUpdated", refresh);
    refresh();
    // 1Hz tick keeps remaining-time labels honest while open.
    tickTimer = setInterval(() => {
      if (overlay.dataset.open === "1") render();
    }, 1000);
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
    if (tickTimer) clearInterval(tickTimer);
    if (unsubscribe) unsubscribe();
    delete window.__buffsHudToggle;
    overlay.remove();
    state.overlayEl = null;
  };
}

// Debug helper — pop synthetic enchantments and open the strip.
if (typeof window !== "undefined") {
  window.__buffsHudDebug = function (filter) {
    ensureStyles();
    loadSpellCatalog();
    if (!state.overlayEl) {
      state.overlayEl = document.createElement("div");
      state.overlayEl.id = OVERLAY_ID;
      state.overlayEl.dataset.open = "0";
      document.body.appendChild(state.overlayEl);
    }
    const now = Date.now() / 1000;
    state.enchantments = [
      { spellId: 1158, spellCategory: 12, layer: 0, powerLevel: 200, startTime: now - 30, duration: 600, casterGuid: 0xDEADBEEF },  // Strength Self VI (buff)
      { spellId: 6,    spellCategory: 5,  layer: 0, powerLevel: 50,  startTime: now - 5,  duration: 60,  casterGuid: 0xDEADBEEF },  // Heal Self I (buff)
      { spellId: 2192, spellCategory: 22, layer: 0, powerLevel: 400, startTime: now,      duration: 0,   casterGuid: 0xCAFE0001 },  // Cantrip (∞ buff)
      { spellId: 3,    spellCategory: 13, layer: 1, powerLevel: 25,  startTime: now - 2,  duration: 30,  casterGuid: 0xBAD0CA57 },  // Weakness Other I (debuff)
    ];
    state.getCasterName = (g) => `Debug 0x${g.toString(16).toUpperCase()}`;
    syncIndicators();
    state.filter = filter || null;
    state.overlayEl.dataset.open = "1";
    render();
  };
}
