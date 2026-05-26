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

const iconCache = new Map();
async function fetchIconDataUrl(iconId) {
  if (!iconId) return null;
  const cached = iconCache.get(iconId);
  if (cached !== undefined) {
    if (cached instanceof Promise) return cached;
    return cached;
  }
  const wasm = window.__hbWasm ?? null;
  if (!wasm?.fetch_surface_pixels) {
    iconCache.set(iconId, false);
    return false;
  }
  const p = (async () => {
    try {
      const r = await wasm.fetch_surface_pixels(iconId >>> 0);
      if (!r || !r.width || !r.height || !r.pixels?.length) return false;
      const canvas = document.createElement("canvas");
      canvas.width = r.width;
      canvas.height = r.height;
      const cx = canvas.getContext("2d");
      const img = cx.createImageData(r.width, r.height);
      img.data.set(r.pixels);
      cx.putImageData(img, 0, 0);
      return canvas.toDataURL("image/png");
    } catch (e) {
      console.warn(`[spell-research] icon ${iconId} fetch failed:`, e);
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
  knownIds: [],
  unsubscribe: null,
  pollTimer: null,
  hookedHandle: null,
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
  const filters = getFilters();
  const ids = state.knownIds;
  state.listEl.innerHTML = "";

  if (ids.length === 0) {
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

  if (rows.length === 0) {
    state.emptyEl.style.display = "";
    setAcText(state.emptyEl, "No spells match the current filter.");
  } else {
    state.emptyEl.style.display = "none";
    for (const { id, meta } of rows) {
      state.listEl.appendChild(makeRow(id, meta));
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

  const header = document.createElement("div");
  header.className = "hb-sr-header";
  const title = document.createElement("div");
  title.className = "hb-sr-title";
  title.textContent = "Spell Research";
  const closeBtn = document.createElement("button");
  closeBtn.className = "hb-sr-close";
  closeBtn.type = "button";
  closeBtn.textContent = "×";
  closeBtn.title = "Close";
  closeBtn.addEventListener("click", () => closePanel());
  header.appendChild(title);
  header.appendChild(closeBtn);
  overlay.appendChild(header);

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

  schoolSel.addEventListener("change", () => render());
  levelSel.addEventListener("change", () => render());
  searchInput.addEventListener("input", () => render());

  return overlay;
}

export function openPanel() {
  const overlay = ensurePanel();
  overlay.dataset.open = "1";
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
}

if (typeof window !== "undefined") {
  window.__openSpellResearchPanel = openPanel;
  window.__closeSpellResearchPanel = closePanel;
}
