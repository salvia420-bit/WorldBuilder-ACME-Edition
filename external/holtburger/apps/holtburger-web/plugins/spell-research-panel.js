// Spell Research panel — read-only metadata view of the player's known
// spells with rich filtering (school + level + name) and per-row
// description expansion. Enriched derivative of retail AC's "Magic"
// character-panel tab; AC players historically asked for component +
// duration + school filtering in one view but didn't get it.
//
// Wasm source: `window.__sessionHandle.playerKnownSpells()` (Wave H/I).
// Data: `./data/spells-catalog.json` (bundled metadata) +
// `./data/spell-components.json` (Comp_N → display name).
//
// IIFE-style: module load wires up the close-button-only DOM (no
// auto-open) and exposes `window.__openSpellResearchPanel()` /
// `window.__closeSpellResearchPanel()`. Filter/render is lazy — the
// panel only subscribes to playerStatsUpdated once it's opened.

import { setAcText } from "../ui/ac_font.js";
import {
  fetchIconDataUrl as fetchIconDataUrlShared,
  getIconImmediate as getIconImmediateShared,
} from "../ui/ac_icon_cache.js";
import { castSpellViaHandle } from "../ui/ac_cast_spell.js";

const OVERLAY_ID = "hb-spell-research-panel";
const STYLE_ID = "hb-spell-research-style";

const SCHOOL_NAMES = {
  0: "—",
  1: "War",
  2: "Life",
  3: "Item",
  4: "Creature",
  5: "Void",
};

const LEVEL_ROMAN = ["—", "I", "II", "III", "IV", "V", "VI", "VII", "VIII"];

const SCHOOL_GHOST_COLOR = {
  1: "#b85a3a",
  2: "#5ab85a",
  3: "#d8c060",
  4: "#9a7ad0",
  5: "#8a3a8a",
};
function schoolGhostColor(school) {
  return SCHOOL_GHOST_COLOR[school] ?? "var(--hb-text-gold)";
}

// Module-level caches — shared across open/close cycles.
let spellCatalog = null;
let spellCatalogPromise = null;
function loadSpellCatalog() {
  if (spellCatalog) return Promise.resolve(spellCatalog);
  if (spellCatalogPromise) return spellCatalogPromise;
  spellCatalogPromise = fetch("./data/spells-catalog.json", { cache: "force-cache" })
    .then((r) => r.json())
    .then((d) => {
      spellCatalog = d?.spells ?? d ?? {};
      return spellCatalog;
    })
    .catch((e) => {
      console.warn("[spell-research] catalog load failed", e);
      spellCatalog = {};
      return spellCatalog;
    });
  return spellCatalogPromise;
}

let componentNames = null;
let componentNamesPromise = null;
function loadComponentNames() {
  if (componentNames) return Promise.resolve(componentNames);
  if (componentNamesPromise) return componentNamesPromise;
  componentNamesPromise = fetch("./data/spell-components.json", { cache: "force-cache" })
    .then((r) => r.json())
    .then((j) => {
      componentNames = j?.components || {};
      return componentNames;
    })
    .catch(() => {
      componentNames = {};
      return componentNames;
    });
  return componentNamesPromise;
}

// Rec #93 — group a spell's component list by component typeName so
// the spell row can render a "Cost: 1× Scarab, 2× Herb" line. Each
// component referenced in the spell's `components` array is consumed
// once per cast (per ACE.Server SpellComponentManager) — counts here
// reflect that one-per-cast usage. componentNames is the loaded
// spell-components.json map: { "1": {name, typeName, ...}, ... }.
function formatComponentCost(components) {
  if (!Array.isArray(components) || components.length === 0) return "";
  if (!componentNames) return "";
  const byType = new Map();
  for (const c of components) {
    let id;
    if (typeof c === "number") id = String(c);
    else if (typeof c === "string") {
      const m = c.match(/^Comp_(\d+)$/);
      id = m ? m[1] : null;
    }
    if (!id) continue;
    const record = componentNames[id];
    const typeName = record?.typeName || "Misc";
    byType.set(typeName, (byType.get(typeName) || 0) + 1);
  }
  if (byType.size === 0) return "";
  // Stable ordering — Scarab first (mana power), then everything else
  // alphabetised. Matches the retail Magic-tab grouping intuition.
  const TYPE_ORDER = ["Scarab", "Herb", "Powder", "Potion", "Talisman", "Taper"];
  const sorted = [...byType.entries()].sort((a, b) => {
    const ia = TYPE_ORDER.indexOf(a[0]);
    const ib = TYPE_ORDER.indexOf(b[0]);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a[0].localeCompare(b[0]);
  });
  return sorted.map(([typeName, n]) => `${n}× ${typeName}`).join(", ");
}

function resolveComponentName(comp) {
  if (typeof comp === "number") {
    return componentNames?.[String(comp)] ?? `Comp_${comp}`;
  }
  if (typeof comp === "string") {
    const m = comp.match(/^Comp_(\d+)$/);
    if (m) {
      const id = m[1];
      return componentNames?.[id] ?? comp;
    }
    return comp;
  }
  return String(comp);
}

// Wave 15 — icon cache consolidated into `ui/ac_icon_cache.js`. Local
// thin wrappers preserve the historical `[spell-research]` warn label
// AND the dragstart drag-ghost path's synchronous cache peek (replaces
// pre-Wave 15 `iconCache.get(meta.icon)` at L526; now delegates to the
// shared `getIconImmediate` so the ghost still uses the cached URL when
// the panel had previously fetched it OR the boot-time bulk preload
// (?preloadIcons=1) had populated it).
async function fetchIconDataUrl(iconId) {
  return fetchIconDataUrlShared(iconId, "spell-research");
}
function iconCacheGetSync(iconId) {
  return getIconImmediateShared(iconId);
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    #${OVERLAY_ID} {
      position: fixed;
      top: 60px;
      right: 32px;
      width: 440px;
      height: 500px;
      z-index: 60;
      display: none;
      flex-direction: column;
      font-family: var(--hb-font-serif);
      background: rgba(20, 14, 8, 0.96);
      border: 2px solid var(--hb-border-brass);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.7);
      color: var(--hb-text-cream);
      box-sizing: border-box;
    }
    #${OVERLAY_ID}[data-open="1"] { display: flex; }
    #${OVERLAY_ID} .hb-sr-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 10px;
      background: linear-gradient(180deg, rgba(60, 45, 22, 0.9), rgba(34, 24, 12, 0.9));
      border-bottom: 1px solid var(--hb-border-brass-dim);
      flex: 0 0 auto;
    }
    #${OVERLAY_ID} .hb-sr-title {
      color: var(--hb-text-gold);
      font-size: 14px;
      letter-spacing: 0.04em;
      font-weight: 600;
    }
    #${OVERLAY_ID} .hb-sr-close {
      background: transparent;
      border: 1px solid var(--hb-border-brass-dim);
      color: var(--hb-text-cream);
      width: 22px;
      height: 22px;
      line-height: 18px;
      text-align: center;
      cursor: pointer;
      font-family: var(--hb-font-serif);
      font-size: 14px;
      padding: 0;
    }
    #${OVERLAY_ID} .hb-sr-close:hover {
      color: var(--hb-text-gold);
      border-color: var(--hb-border-brass);
    }
    #${OVERLAY_ID} .hb-sr-filters {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 4px 6px;
      padding: 6px 10px;
      background: rgba(0, 0, 0, 0.25);
      border-bottom: 1px solid var(--hb-border-brass-deep);
      flex: 0 0 auto;
    }
    #${OVERLAY_ID} .hb-sr-filters label {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 10px;
      color: var(--hb-text-label);
    }
    #${OVERLAY_ID} .hb-sr-filters select,
    #${OVERLAY_ID} .hb-sr-filters input {
      flex: 1 1 auto;
      background: rgba(10, 6, 2, 0.85);
      border: 1px solid var(--hb-border-brass-dim);
      color: var(--hb-text-cream);
      font-family: var(--hb-font-serif);
      font-size: 11px;
      padding: 2px 4px;
      box-sizing: border-box;
      min-width: 0;
    }
    #${OVERLAY_ID} .hb-sr-filters select:focus,
    #${OVERLAY_ID} .hb-sr-filters input:focus {
      outline: none;
      border-color: var(--hb-text-gold);
    }
    #${OVERLAY_ID} .hb-sr-search {
      grid-column: 1 / -1;
    }
    #${OVERLAY_ID} .hb-sr-count {
      grid-column: 1 / -1;
      font-size: 10px;
      color: var(--hb-text-muted);
      text-align: right;
    }
    #${OVERLAY_ID} .hb-sr-list {
      flex: 1 1 auto;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 4px 6px;
    }
    #${OVERLAY_ID} .hb-sr-empty {
      color: var(--hb-text-muted-2);
      font-style: italic;
      font-size: 12px;
      text-align: center;
      padding: 40px 12px;
    }
    #${OVERLAY_ID} .hb-sr-row {
      border: 1px solid transparent;
      border-bottom: 1px solid rgba(120, 90, 50, 0.18);
      padding: 4px 6px;
      cursor: pointer;
      transition: background 80ms, border-color 80ms;
    }
    #${OVERLAY_ID} .hb-sr-row:hover {
      background: rgba(80, 60, 30, 0.25);
      border-color: var(--hb-border-brass-dim);
    }
    #${OVERLAY_ID} .hb-sr-row[data-expanded="1"] {
      background: rgba(60, 45, 22, 0.35);
      border-color: var(--hb-border-brass-dim);
    }
    #${OVERLAY_ID} .hb-sr-row[data-focused="1"] {
      border-left: 3px solid var(--hb-text-gold);
      background: rgba(100, 75, 30, 0.32);
    }
    #${OVERLAY_ID} .hb-sr-row-main {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    #${OVERLAY_ID} .hb-sr-icon {
      width: 32px;
      height: 32px;
      flex: 0 0 32px;
      background: rgba(0, 0, 0, 0.6);
      border: 1px solid var(--hb-border-brass-deep);
      text-align: center;
      line-height: 30px;
      font-size: 16px;
      color: var(--hb-text-gold-dim);
    }
    #${OVERLAY_ID} .hb-sr-icon img {
      width: 100%;
      height: 100%;
      image-rendering: pixelated;
      object-fit: contain;
      display: block;
    }
    #${OVERLAY_ID} .hb-sr-text {
      flex: 1 1 auto;
      min-width: 0;
    }
    #${OVERLAY_ID} .hb-sr-name {
      color: var(--hb-text-cream-bright);
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #${OVERLAY_ID} .hb-sr-meta {
      color: var(--hb-text-muted);
      font-size: 10px;
      margin-top: 1px;
    }
    #${OVERLAY_ID} .hb-sr-tag {
      color: var(--hb-text-gold-dim);
      font-variant-numeric: tabular-nums;
    }
    #${OVERLAY_ID} .hb-sr-sep {
      color: var(--hb-text-muted-3);
      margin: 0 4px;
    }
    #${OVERLAY_ID} .hb-sr-comp {
      color: var(--hb-text-cream);
      font-style: italic;
    }
    #${OVERLAY_ID} .hb-sr-detail {
      display: none;
      margin-top: 6px;
      padding: 6px 8px;
      background: rgba(10, 6, 2, 0.6);
      border-left: 2px solid var(--hb-border-brass-dim);
      font-size: 11px;
      color: var(--hb-text-body);
      line-height: 1.4;
    }
    #${OVERLAY_ID} .hb-sr-row[data-expanded="1"] .hb-sr-detail {
      display: block;
    }
    #${OVERLAY_ID} .hb-sr-list::-webkit-scrollbar {
      width: 8px;
    }
    #${OVERLAY_ID} .hb-sr-list::-webkit-scrollbar-track {
      background: rgba(0, 0, 0, 0.4);
    }
    #${OVERLAY_ID} .hb-sr-list::-webkit-scrollbar-thumb {
      background: var(--hb-border-brass-deep);
      border: 1px solid var(--hb-border-brass-dim);
    }
    #${OVERLAY_ID} .hb-sr-stance-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-right: 6px;
      background: #6a6a6a;
      box-shadow: 0 0 2px rgba(0, 0, 0, 0.8);
      flex: 0 0 8px;
    }
    #${OVERLAY_ID} .hb-sr-stance-dot[data-ready="1"] {
      background: #ffd76a;
      box-shadow: 0 0 4px #ffd76a, 0 0 1px #fff;
    }
    #${OVERLAY_ID} .hb-sr-title-row {
      display: flex;
      align-items: center;
      flex: 1 1 auto;
      min-width: 0;
    }
    #${OVERLAY_ID} .hb-sr-toast {
      position: absolute;
      left: 10px;
      right: 10px;
      bottom: 6px;
      padding: 4px 6px;
      font-size: 11px;
      text-align: center;
      background: rgba(0, 0, 0, 0.78);
      border: 1px solid var(--hb-border-brass);
      color: var(--hb-text-gold);
      pointer-events: none;
    }
    .hb-sr-drag-ghost {
      position: absolute;
      top: -1000px;
      left: -1000px;
      width: 32px;
      height: 32px;
      box-sizing: border-box;
      border: 1px solid var(--hb-text-cream);
      border-radius: 4px;
      background-color: rgba(0, 0, 0, 0.7);
      background-position: center;
      background-size: contain;
      background-repeat: no-repeat;
      filter: drop-shadow(0 0 4px var(--hb-text-gold));
      image-rendering: pixelated;
      pointer-events: none;
    }
  `;
  document.head.appendChild(s);
}

const state = {
  overlayEl: null,
  listEl: null,
  emptyEl: null,
  countEl: null,
  schoolSel: null,
  levelSel: null,
  searchInput: null,
  stanceDotEl: null,
  knownIds: [],
  unsubscribe: null,
  pollTimer: null,
  hookedHandle: null,
  rows: [],
  focusIdx: -1,
  keydownHandler: null,
};

function formatDuration(secs) {
  if (!Number.isFinite(secs) || secs <= 0) return null;
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

function getFilters() {
  const schoolRaw = state.schoolSel?.value ?? "all";
  const levelRaw = state.levelSel?.value ?? "all";
  const search = (state.searchInput?.value ?? "").trim().toLowerCase();
  return {
    school: schoolRaw === "all" ? null : Number(schoolRaw),
    level: levelRaw === "all" ? null : Number(levelRaw),
    search,
  };
}

function passesFilter(meta, filters) {
  if (!meta) return false;
  if (filters.school !== null && meta.school !== filters.school) return false;
  if (filters.level !== null && meta.level !== filters.level) return false;
  if (filters.search && !(meta.name ?? "").toLowerCase().includes(filters.search)) return false;
  return true;
}

function getCurrentStanceLow() {
  try {
    const fn = window.__getCurrentStanceLow;
    return typeof fn === "function" ? (fn() >>> 0) : 0;
  } catch (_) { return 0; }
}

function getSelectedTargetGuid() {
  try {
    const em = window.liveScene3d?.entityManager;
    return (em?.getSelectedTarget?.() ?? 0) >>> 0;
  } catch (_) { return 0; }
}

function toast(text) {
  const ov = state.overlayEl;
  if (!ov) return;
  const old = ov.querySelector(".hb-sr-toast");
  if (old) old.remove();
  const t = document.createElement("div");
  t.className = "hb-sr-toast";
  t.textContent = text;
  ov.appendChild(t);
  setTimeout(() => { try { t.remove(); } catch (_) {} }, 1750);
}

function refreshStanceDot() {
  if (!state.stanceDotEl) return;
  const ready = getCurrentStanceLow() !== 0;
  state.stanceDotEl.dataset.ready = ready ? "1" : "0";
  state.stanceDotEl.title = ready
    ? "Combat stance active — double-click to cast"
    : "Enter a combat stance to cast";
}

function castFromRow(id, meta) {
  if (getCurrentStanceLow() === 0) {
    toast("Enter a magic combat stance first.");
    return;
  }
  const untargeted = meta?.untargeted === true;
  let targetGuid = 0;
  if (!untargeted) {
    targetGuid = getSelectedTargetGuid();
    if (!targetGuid) {
      toast("Click an entity first.");
      return;
    }
  }
  try {
    // Rec #176 — shared spell-cast dispatcher (ui/ac_cast_spell.js)
    // routes plugin-client → wasm sessionHandle in one place; matches
    // hotbar.js + combat-bar.js to keep error handling and null-checks
    // identical across every HUD-driven cast site.
    if (!castSpellViaHandle(id, untargeted ? null : targetGuid)) {
      toast("Cast unavailable — no session.");
      return;
    }
    const targetStr = untargeted ? "0" : `0x${targetGuid.toString(16).toUpperCase()}`;
    console.log(`[research/cast] spellId=${id} untargeted=${untargeted} target=${targetStr}`);
  } catch (e) {
    console.warn(`[research/cast] spellId=${id} failed:`, e);
    toast(`Cast failed: ${e?.message ?? e}`);
  }
}

function makeRow(id, meta) {
  const compNames = Array.isArray(meta.components)
    ? meta.components.map((c) => resolveComponentName(c))
    : [];
  const duration = formatDuration(meta.duration);
  const schoolName = SCHOOL_NAMES[meta.school] ?? "—";
  const levelRoman = LEVEL_ROMAN[meta.level] ?? "—";

  const row = document.createElement("div");
  row.className = "hb-sr-row";
  row.dataset.spellId = String(id);
  row.dataset.expanded = "0";
  row.draggable = true;
  row.title = "Double-click to cast · drag to bar slot";

  row.addEventListener("dragstart", (ev) => {
    ev.dataTransfer.effectAllowed = "copy";
    ev.dataTransfer.setData("application/x-hb-spell-id", String(id));
    ev.dataTransfer.setData("text/plain", meta.name || `Spell ${id}`);
    row.style.opacity = "0.5";

    const ghost = document.createElement("div");
    ghost.className = "hb-sr-drag-ghost";
    // Wave 15 — sync cache peek via shared module. Falls back to the
    // school color when the URL isn't resolved yet (matches the
    // pre-Wave 15 `iconCache.get(meta.icon)` short-circuit).
    const cached = meta.icon ? iconCacheGetSync(meta.icon) : null;
    if (typeof cached === "string" && cached) {
      ghost.style.backgroundImage = `url(${cached})`;
    } else {
      ghost.style.backgroundColor = schoolGhostColor(meta.school);
    }
    document.body.appendChild(ghost);
    try {
      ev.dataTransfer.setDragImage(ghost, 16, 16);
    } catch (_) {}
    // setTimeout(0) lets the browser snapshot the ghost before we remove it.
    setTimeout(() => { try { ghost.remove(); } catch (_) {} }, 0);
  });
  row.addEventListener("dragend", () => {
    row.style.opacity = "";
  });

  const main = document.createElement("div");
  main.className = "hb-sr-row-main";

  const iconEl = document.createElement("div");
  iconEl.className = "hb-sr-icon";
  iconEl.textContent = "✦";
  if (meta.icon) {
    fetchIconDataUrl(meta.icon).then((url) => {
      if (!url || !iconEl.isConnected) return;
      iconEl.textContent = "";
      const img = document.createElement("img");
      img.src = url;
      img.alt = meta.name || "";
      iconEl.appendChild(img);
    });
  }

  const text = document.createElement("div");
  text.className = "hb-sr-text";

  const name = document.createElement("div");
  name.className = "hb-sr-name";
  name.textContent = meta.name || `Spell ${id}`;
  text.appendChild(name);

  const meta1 = document.createElement("div");
  meta1.className = "hb-sr-meta";
  const lvlTag = `<span class="hb-sr-tag">L${meta.level ?? "?"} ${levelRoman}</span>`;
  const schoolTag = `<span class="hb-sr-tag">${schoolName}</span>`;
  const manaTag = Number.isFinite(meta.mana)
    ? `<span class="hb-sr-tag">mana ${meta.mana}</span>`
    : "";
  const durationTag = duration
    ? `<span class="hb-sr-tag">duration ${duration}</span>`
    : "";
  const tagParts = [lvlTag, schoolTag];
  if (manaTag) tagParts.push(manaTag);
  if (durationTag) tagParts.push(durationTag);
  meta1.innerHTML = tagParts.join('<span class="hb-sr-sep">·</span>');
  text.appendChild(meta1);

  if (compNames.length > 0) {
    const meta2 = document.createElement("div");
    meta2.className = "hb-sr-meta";
    const compHtml = compNames
      .map((n) => `<span class="hb-sr-comp">${escapeHtml(n)}</span>`)
      .join(", ");
    meta2.innerHTML = `components: ${compHtml}`;
    text.appendChild(meta2);
    // Rec #93 — per-cast component cost line, grouped by component
    // typeName (Scarab / Herb / Powder / Potion / Talisman / Taper)
    // pulled from spell-components.json. Each component listed in the
    // spell is consumed once per cast, so the count = how many
    // distinct components of that type the spell pulls. Rendered in
    // the muted hb-sr-meta color so it sits visually below the names.
    const costStr = formatComponentCost(meta.components);
    if (costStr) {
      const meta3 = document.createElement("div");
      meta3.className = "hb-sr-meta hb-sr-cost";
      meta3.style.opacity = "0.78";
      meta3.textContent = `Cost: ${costStr}`;
      text.appendChild(meta3);
    }
  }

  main.appendChild(iconEl);
  main.appendChild(text);
  row.appendChild(main);

  const detail = document.createElement("div");
  detail.className = "hb-sr-detail";
  detail.textContent = meta.desc || "(no description in catalog)";
  row.appendChild(detail);

  row.addEventListener("click", () => {
    const open = row.dataset.expanded === "1";
    row.dataset.expanded = open ? "0" : "1";
  });

  row.addEventListener("dblclick", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    castFromRow(id, meta);
  });

  return row;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function render() {
  if (!state.listEl) return;
  refreshStanceDot();
  const filters = getFilters();
  const ids = state.knownIds;
  state.listEl.innerHTML = "";

  if (ids.length === 0) {
    state.rows = [];
    state.focusIdx = -1;
    state.emptyEl.style.display = "";
    setAcText(state.emptyEl, "No spells learned. Learn a spell tome to research.");
    if (state.countEl) state.countEl.textContent = "0 known";
    return;
  }

  const rows = [];
  for (const id of ids) {
    const meta = spellCatalog?.[String(id)];
    if (!meta) continue;
    if (!passesFilter(meta, filters)) continue;
    rows.push({ id, meta });
  }

  rows.sort((a, b) => {
    const sd = (a.meta.school ?? 0) - (b.meta.school ?? 0);
    if (sd !== 0) return sd;
    const ld = (a.meta.level ?? 0) - (b.meta.level ?? 0);
    if (ld !== 0) return ld;
    return (a.meta.name ?? "").localeCompare(b.meta.name ?? "");
  });

  state.rows = rows;
  if (state.focusIdx >= rows.length) state.focusIdx = rows.length - 1;
  if (state.focusIdx < 0 && rows.length > 0) state.focusIdx = 0;

  if (rows.length === 0) {
    state.focusIdx = -1;
    state.emptyEl.style.display = "";
    setAcText(state.emptyEl, "No spells match the current filter.");
  } else {
    state.emptyEl.style.display = "none";
    for (let i = 0; i < rows.length; i++) {
      const { id, meta } = rows[i];
      const el = makeRow(id, meta);
      if (i === state.focusIdx) el.dataset.focused = "1";
      state.listEl.appendChild(el);
    }
  }

  if (state.countEl) {
    state.countEl.textContent = `${rows.length} of ${ids.length} known`;
  }
}

function refreshKnown() {
  const handle = window.__sessionHandle ?? null;
  if (handle?.playerKnownSpells) {
    try {
      const arr = handle.playerKnownSpells();
      state.knownIds = Array.from(arr || []);
    } catch (e) {
      console.warn("[spell-research] playerKnownSpells failed:", e);
      state.knownIds = [];
    }
  } else {
    state.knownIds = [];
  }
  if (state.overlayEl?.dataset.open === "1") render();
}

function tryHook() {
  const client = window.__pluginClient ?? null;
  const handle = window.__sessionHandle ?? null;
  if (!handle?.playerKnownSpells) return false;
  if (state.hookedHandle === handle) return true;

  if (state.unsubscribe) {
    try { state.unsubscribe(); } catch {}
    state.unsubscribe = null;
  }
  if (client?.events?.on) {
    const h = () => refreshKnown();
    client.events.on("playerStatsUpdated", h);
    state.unsubscribe = () => {
      try { client.events.off?.("playerStatsUpdated", h); } catch {}
    };
  }
  state.hookedHandle = handle;
  refreshKnown();
  return true;
}

function ensurePanel() {
  ensureStyles();
  if (state.overlayEl) return state.overlayEl;

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.dataset.open = "0";
  overlay.tabIndex = -1;

  const header = document.createElement("div");
  header.className = "hb-sr-header";
  const titleRow = document.createElement("div");
  titleRow.className = "hb-sr-title-row";
  const stanceDot = document.createElement("div");
  stanceDot.className = "hb-sr-stance-dot";
  stanceDot.dataset.ready = "0";
  stanceDot.title = "Enter a combat stance to cast";
  const title = document.createElement("div");
  title.className = "hb-sr-title";
  title.textContent = "Spell Research";
  titleRow.appendChild(stanceDot);
  titleRow.appendChild(title);
  const closeBtn = document.createElement("button");
  closeBtn.className = "hb-sr-close";
  closeBtn.type = "button";
  closeBtn.textContent = "×";
  closeBtn.title = "Close";
  closeBtn.addEventListener("click", () => closePanel());
  header.appendChild(titleRow);
  header.appendChild(closeBtn);
  overlay.appendChild(header);
  state.stanceDotEl = stanceDot;

  const filters = document.createElement("div");
  filters.className = "hb-sr-filters";

  const schoolLabel = document.createElement("label");
  schoolLabel.textContent = "School";
  const schoolSel = document.createElement("select");
  for (const [val, label] of [
    ["all", "All"],
    ["1", "War"],
    ["2", "Life"],
    ["3", "Item"],
    ["4", "Creature"],
    ["5", "Void"],
  ]) {
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = label;
    schoolSel.appendChild(opt);
  }
  schoolLabel.appendChild(schoolSel);
  filters.appendChild(schoolLabel);

  const levelLabel = document.createElement("label");
  levelLabel.textContent = "Level";
  const levelSel = document.createElement("select");
  const lvlOpts = [["all", "All"]];
  for (let i = 1; i <= 8; i++) lvlOpts.push([String(i), LEVEL_ROMAN[i]]);
  for (const [val, label] of lvlOpts) {
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = label;
    levelSel.appendChild(opt);
  }
  levelLabel.appendChild(levelSel);
  filters.appendChild(levelLabel);

  const searchLabel = document.createElement("label");
  searchLabel.className = "hb-sr-search";
  searchLabel.textContent = "Name";
  const searchInput = document.createElement("input");
  searchInput.type = "text";
  searchInput.placeholder = "search…";
  searchInput.autocomplete = "off";
  searchInput.spellcheck = false;
  searchLabel.appendChild(searchInput);
  filters.appendChild(searchLabel);

  const countEl = document.createElement("div");
  countEl.className = "hb-sr-count";
  countEl.textContent = "0 known";
  filters.appendChild(countEl);

  overlay.appendChild(filters);

  const listEl = document.createElement("div");
  listEl.className = "hb-sr-list";
  const emptyEl = document.createElement("div");
  emptyEl.className = "hb-sr-empty";
  listEl.appendChild(emptyEl);
  overlay.appendChild(listEl);

  document.body.appendChild(overlay);

  state.overlayEl = overlay;
  state.listEl = listEl;
  state.emptyEl = emptyEl;
  state.countEl = countEl;
  state.schoolSel = schoolSel;
  state.levelSel = levelSel;
  state.searchInput = searchInput;

  const onFilterChange = () => {
    state.focusIdx = 0;
    render();
  };
  schoolSel.addEventListener("change", onFilterChange);
  levelSel.addEventListener("change", onFilterChange);
  searchInput.addEventListener("input", onFilterChange);

  return overlay;
}

function scrollFocusedIntoView() {
  if (!state.listEl || state.focusIdx < 0) return;
  const el = state.listEl.children[state.focusIdx];
  if (el && typeof el.scrollIntoView === "function") {
    el.scrollIntoView({ block: "nearest" });
  }
}

function moveFocus(delta) {
  const n = state.rows.length;
  if (n === 0) return;
  // Wrap-around: ArrowDown past last → first; ArrowUp before first → last.
  let next = state.focusIdx + delta;
  if (next < 0) next = ((next % n) + n) % n;
  else if (next >= n) next = next % n;
  state.focusIdx = next;
  render();
  scrollFocusedIntoView();
}

function setFocus(idx) {
  const n = state.rows.length;
  if (n === 0) return;
  state.focusIdx = Math.max(0, Math.min(n - 1, idx));
  render();
  scrollFocusedIntoView();
}

function onPanelKeydown(ev) {
  if (state.overlayEl?.dataset.open !== "1") return;
  if (ev.target === state.searchInput) {
    if (ev.key === "Escape") {
      ev.preventDefault();
      closePanel();
    }
    return;
  }
  switch (ev.key) {
    case "ArrowDown":
      ev.preventDefault();
      moveFocus(1);
      break;
    case "ArrowUp":
      ev.preventDefault();
      moveFocus(-1);
      break;
    case "PageDown":
      ev.preventDefault();
      moveFocus(10);
      break;
    case "PageUp":
      ev.preventDefault();
      moveFocus(-10);
      break;
    case "Home":
      ev.preventDefault();
      setFocus(0);
      break;
    case "End":
      ev.preventDefault();
      setFocus(state.rows.length - 1);
      break;
    case "Enter": {
      if (state.focusIdx < 0 || state.focusIdx >= state.rows.length) return;
      ev.preventDefault();
      const r = state.rows[state.focusIdx];
      castFromRow(r.id, r.meta);
      break;
    }
    case "Escape":
      ev.preventDefault();
      closePanel();
      break;
    default:
      break;
  }
}

export function openPanel() {
  const overlay = ensurePanel();
  overlay.dataset.open = "1";
  state.focusIdx = 0;
  if (!state.keydownHandler) {
    state.keydownHandler = onPanelKeydown;
    overlay.addEventListener("keydown", state.keydownHandler);
  }
  try { overlay.focus({ preventScroll: true }); } catch (_) {}
  Promise.all([loadSpellCatalog(), loadComponentNames()]).then(() => {
    if (!tryHook() && !state.pollTimer) {
      state.pollTimer = setInterval(() => {
        if (tryHook()) {
          clearInterval(state.pollTimer);
          state.pollTimer = null;
        }
      }, 500);
    }
    render();
  });
}

export function closePanel() {
  if (!state.overlayEl) return;
  state.overlayEl.dataset.open = "0";
  if (state.keydownHandler) {
    state.overlayEl.removeEventListener("keydown", state.keydownHandler);
    state.keydownHandler = null;
  }
}

if (typeof window !== "undefined") {
  window.__openSpellResearchPanel = openPanel;
  window.__closeSpellResearchPanel = closePanel;
  window.__toggleSpellResearchPanel = () => {
    if (state.overlayEl?.dataset.open === "1") closePanel();
    else openPanel();
  };
}
