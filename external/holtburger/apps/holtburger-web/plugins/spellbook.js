// Spellbook view — Phase G (catalog + known-spell intersection),
// Phase J (delete-from-spellbook RemoveSpellFromBook 0x01A8 wire round-
// trip + component name table), Phase K (multi-tab spell-bars).
//
// Wave 2 PR-Z refactor 2026-05-22: was an `activate(bodyEl, ctx)`
// bar-plugin slot (📖 icon, F5 hotkey). Now a registered view of
// plugins/main-panel.js — the shared right-side pane. Toggled via the
// S key (and F5 for retail muscle-memory).
//
// Preserved wiring (DO NOT regress):
//   - loadCatalog() fetches ./data/spells-catalog.json (Phase G)
//   - loadComponentNames() fetches ./data/spell-components.json (J.2)
//   - client.player.knownSpells() populates the list (Phase G + wasm)
//   - School filter check-bubbles (War/Life/Item/Creature/Void) — H.2
//   - Level filter check-bubbles I-VIII — H.3
//   - Spell rows draggable via "application/x-hb-spell-id" mime — H.5
//   - Double-click row → add to first empty magic-bar slot — Phase G
//   - Right-click row → detail popover (name/school/mana/comps) — H.4
//   - Delete-from-spellbook → RemoveSpellFromBook 0x01A8 — J.1
//   - Multi-tab spell-bars (7 numbered tabs × 8 slots) — Phase I.2
//   - Subscriptions: playerStatsUpdated + hb-spellbar-changed, torn
//     down on view-swap cleanup.
//
// Real DAT sprites (extracted from gmSpellbookUI layout 0x21000032):
//   0x06002722 — dark stone/slate horizontal backdrop strip. Used as
//                the filter-row header band.
//   0x06004CDA — passive (dark-red, gold-bordered) button strip.
//                Used as inactive spell-bar tab background.
//   0x06004CDB — active/hover (bright-red, gold-bordered) button strip.
//                Used as the currently-selected spell-bar tab background.
//   0x06004CC2 — gray placeholder spacer (already in use elsewhere; not
//                wired here — left as a TODO in case future Phase K
//                wave-3 spell-component pouch needs it).
//
// Helpers re-exported at the bottom remain in scope for combat-bar.js:
//   getSpellBarSlots, setSpellBarSlot, getActiveSpellBar,
//   setActiveSpellBar, SPELL_BAR_SLOTS, SPELL_BAR_TABS, loadCatalog.
// Their signatures are UNCHANGED — combat-bar.js does not need to be
// touched as part of PR-Z.

import { setAcText } from "../ui/ac_font.js";
import { resolveLocalBinding, matchesBinding, LOCAL_ACTION_IDS } from "../ui/keymap.js";

const COMBAT_BAR_STORAGE_KEY = "holtburger_combat_bar_v1";
const SPELL_BAR_SLOTS = 8;
// Phase I.2 — number of numbered spell-bar tabs (retail had 7).
const SPELL_BAR_TABS = 7;

let catalogPromise = null;
function loadCatalog() {
  if (!catalogPromise) {
    catalogPromise = fetch("./data/spells-catalog.json", { cache: "force-cache" })
      .then((r) => r.json())
      .then((j) => j.spells || {})
      .catch((e) => {
        console.warn("[spellbook] catalog load failed:", e);
        return {};
      });
  }
  return catalogPromise;
}

// Phase J.2 — spell-component ID → name. Loaded once and shared.
let componentNamesPromise = null;
function loadComponentNames() {
  if (!componentNamesPromise) {
    componentNamesPromise = fetch("./data/spell-components.json", { cache: "force-cache" })
      .then((r) => r.json())
      .then((j) => j.components || {})
      .catch(() => ({}));
  }
  return componentNamesPromise;
}
function resolveComponentName(comp, componentNames) {
  // `comp` may be a numeric ID, a "Comp_<id>" string from the spell
  // catalog, or already a resolved name. Returns the human label.
  if (typeof comp === "number") {
    return componentNames?.[String(comp)] ?? `Component #${comp}`;
  }
  if (typeof comp === "string") {
    const m = comp.match(/^Comp_(\d+)$/);
    if (m) {
      const id = m[1];
      return componentNames?.[id] ?? `Component #${id}`;
    }
    return comp;
  }
  return String(comp);
}

const SCHOOL_NAMES = {
  1: "War",
  2: "Life",
  3: "Item",
  4: "Creature",
  5: "Void",
};

function readCombatBarState() {
  try {
    const raw = localStorage.getItem(COMBAT_BAR_STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

function writeCombatBarState(merged) {
  try {
    localStorage.setItem(COMBAT_BAR_STORAGE_KEY, JSON.stringify(merged));
  } catch {}
  // Mirror the ACTIVE tab's slots onto window state so picking.js
  // (and the combat-bar's magic-mode renderer) sees the right list
  // without knowing about tabs.
  const activeSlots = getSpellBarSlots();
  if (window.__combatBarState) {
    window.__combatBarState.spellBarSlots = activeSlots;
    window.__combatBarState.activeSpellBar = merged.activeSpellBar ?? 0;
  } else {
    window.__combatBarState = {
      spellBarSlots: activeSlots,
      activeSpellBar: merged.activeSpellBar ?? 0,
    };
  }
  window.dispatchEvent(new CustomEvent("hb-spellbar-changed"));
}

// Phase I.2 — pull the array-of-tabs out of localStorage, migrating
// the old single-bar shape (`spellBarSlots: number[]`) into the new
// shape (`spellBars: number[][]`) on first read.
function readSpellBars(state) {
  if (Array.isArray(state.spellBars) && state.spellBars.length > 0) {
    // Pad each tab to SPELL_BAR_SLOTS for safety.
    return state.spellBars.map((tab) => {
      const t = Array.isArray(tab) ? tab : [];
      const padded = [];
      for (let i = 0; i < SPELL_BAR_SLOTS; i++) {
        const v = t[i];
        padded.push(typeof v === "number" && v > 0 ? v : 0);
      }
      return padded;
    }).slice(0, SPELL_BAR_TABS);
  }
  // Legacy: a single `spellBarSlots` array becomes tab 0.
  const legacy = Array.isArray(state.spellBarSlots) ? state.spellBarSlots : [];
  const tab0 = [];
  for (let i = 0; i < SPELL_BAR_SLOTS; i++) {
    const v = legacy[i];
    tab0.push(typeof v === "number" && v > 0 ? v : 0);
  }
  return [tab0];
}

function getActiveSpellBar() {
  const state = readCombatBarState();
  const idx = typeof state.activeSpellBar === "number" ? state.activeSpellBar : 0;
  return Math.max(0, Math.min(SPELL_BAR_TABS - 1, idx));
}

function setActiveSpellBar(idx) {
  const state = readCombatBarState();
  state.activeSpellBar = Math.max(0, Math.min(SPELL_BAR_TABS - 1, idx));
  // Ensure spellBars exists (migrating legacy if needed).
  state.spellBars = readSpellBars(state);
  delete state.spellBarSlots; // drop legacy field on first write
  writeCombatBarState(state);
}

function getSpellBarSlots(barIdx) {
  const state = readCombatBarState();
  const bars = readSpellBars(state);
  const idx = (typeof barIdx === "number")
    ? Math.max(0, Math.min(SPELL_BAR_TABS - 1, barIdx))
    : getActiveSpellBar();
  return bars[idx] || new Array(SPELL_BAR_SLOTS).fill(0);
}

function setSpellBarSlot(slotIndex, spellId, barIdx) {
  if (slotIndex < 0 || slotIndex >= SPELL_BAR_SLOTS) return;
  const state = readCombatBarState();
  const bars = readSpellBars(state);
  const tab = (typeof barIdx === "number")
    ? Math.max(0, Math.min(SPELL_BAR_TABS - 1, barIdx))
    : getActiveSpellBar();
  // Pad bars list out to `tab+1` if shorter.
  while (bars.length <= tab) {
    bars.push(new Array(SPELL_BAR_SLOTS).fill(0));
  }
  bars[tab][slotIndex] = spellId | 0;
  state.spellBars = bars;
  delete state.spellBarSlots;
  writeCombatBarState(state);
}

function addToFirstEmptySlot(spellId, barIdx) {
  const tab = (typeof barIdx === "number") ? barIdx : getActiveSpellBar();
  const slots = getSpellBarSlots(tab);
  const empty = slots.findIndex((v) => v === 0);
  const writeIdx = empty === -1 ? SPELL_BAR_SLOTS - 1 : empty;
  setSpellBarSlot(writeIdx, spellId, tab);
  return writeIdx;
}

let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = "hb-spellbook-style";
  style.textContent = `
    /* Spellbook view — mounts inside main-panel's body slot. The
       main-panel owns position/frame/title; we just lay out our
       content (tab strip + filters + spell list) inside parentEl. */
    .hb-sb-root {
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      box-sizing: border-box;
      pointer-events: auto;
      font-family: var(--hb-font-serif);
      color: var(--hb-text-cream);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    /* Spell-bar tab strip — real DAT 0x06004CDA (passive) /
       0x06004CDB (active) brass-bordered red button textures.
       7 numbered tabs (Phase I.2). */
    .hb-sb-tabs {
      flex: 0 0 auto;
      display: flex;
      gap: 2px;
      padding: 4px 4px 0;
      border-bottom: 1px solid var(--hb-border-brass-dim);
    }
    .hb-sb-tab {
      flex: 1;
      height: 22px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      font-family: var(--hb-font-serif);
      font-weight: 600;
      color: var(--hb-text-cream);
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.9);
      background: url("./data/ui-sprites/0x06004CDA.png") center/100% 100% no-repeat;
      border: none;
      cursor: pointer;
      user-select: none;
      letter-spacing: 0.04em;
    }
    .hb-sb-tab:hover { filter: brightness(1.25); }
    .hb-sb-tab.active {
      background: url("./data/ui-sprites/0x06004CDB.png") center/100% 100% no-repeat;
      color: var(--hb-text-gold);
    }
    /* Filter band — uses DAT 0x06002722 as a dark stone backdrop
       strip behind the school/level check-bubbles. */
    .hb-sb-filters-band {
      flex: 0 0 auto;
      padding: 6px 8px 4px;
      background: url("./data/ui-sprites/0x06002722.png") center/cover no-repeat;
      border-bottom: 1px solid var(--hb-border-brass-dim);
    }
    .hb-sb-filters {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 10px;
      font-size: 10px;
      color: var(--hb-text-cream-bright);
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.9);
    }
    .hb-sb-filter-group {
      display: flex;
      gap: 6px;
      align-items: center;
      flex-wrap: wrap;
    }
    .hb-sb-filter-group label {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      cursor: pointer;
    }
    .hb-sb-filter-group input[type="checkbox"] {
      width: 10px;
      height: 10px;
      accent-color: var(--hb-text-gold);
    }
    .hb-sb-hint {
      flex: 0 0 auto;
      font-size: 9px;
      color: var(--hb-text-muted);
      padding: 3px 8px;
      background: rgba(0, 0, 0, 0.3);
      border-bottom: 1px solid var(--hb-border-brass-dim);
      font-style: italic;
    }
    /* Spell list — fills remaining vertical space inside the
       main-panel body. */
    .hb-sb-list {
      flex: 1 1 auto;
      display: flex;
      flex-direction: column;
      gap: 2px;
      overflow-y: auto;
      padding: 4px 4px;
      scrollbar-width: thin;
      scrollbar-color: var(--hb-border-brass) rgba(0, 0, 0, 0.5);
    }
    .hb-sb-row {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 3px 6px;
      background: rgba(0, 0, 0, 0.35);
      border: 1px solid var(--hb-border-brass-dim);
      font-size: 10px;
      cursor: pointer;
      transition: background 80ms ease, border-color 80ms ease;
    }
    .hb-sb-row:hover {
      background: var(--hb-overlay-hover);
      border-color: var(--hb-border-brass);
    }
    .hb-sb-row.on-bar {
      border-color: rgba(160, 110, 255, 0.65);
      box-shadow: 0 0 4px rgba(160, 110, 255, 0.25);
    }
    .hb-sb-row.selected {
      background: var(--hb-overlay-active);
      border-color: var(--hb-text-gold);
    }
    .hb-sb-row-name {
      flex: 1;
      color: var(--hb-text-cream);
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.85);
    }
    .hb-sb-row-tag {
      font-size: 8px;
      padding: 1px 5px;
      background: rgba(0, 0, 0, 0.45);
      border: 1px solid var(--hb-border-brass-dim);
      color: var(--hb-text-cream);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      font-variant-numeric: tabular-nums;
    }
    .hb-sb-row-tag.school-1 { color: rgba(255, 140, 140, 0.95); }
    .hb-sb-row-tag.school-2 { color: rgba(140, 220, 140, 0.95); }
    .hb-sb-row-tag.school-3 { color: rgba(255, 200, 120, 0.95); }
    .hb-sb-row-tag.school-4 { color: rgba(140, 200, 255, 0.95); }
    .hb-sb-row-tag.school-5 { color: rgba(200, 140, 255, 0.95); }
    .hb-sb-empty {
      color: var(--hb-text-muted);
      font-style: italic;
      padding: 16px 12px;
      text-align: center;
      font-size: 10px;
    }
    /* Right-click detail popover — floats over the page; positioned
       at click coords. Lives outside the main-panel pane so it can
       extend off the panel edge. */
    .hb-sb-detail {
      position: fixed;
      z-index: 200;
      max-width: 280px;
      padding: 8px 10px;
      background: rgba(28, 22, 14, 0.97);
      border: 1px solid var(--hb-border-brass);
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.65);
      color: var(--hb-text-cream);
      font-family: var(--hb-font-serif);
      font-size: 11px;
      line-height: 1.4;
    }
    .hb-sb-detail-name {
      font-weight: 600;
      font-size: 12px;
      margin-bottom: 4px;
      color: var(--hb-text-gold);
    }
    .hb-sb-detail-meta {
      color: var(--hb-text-cream-bright);
      margin-bottom: 6px;
      font-size: 10px;
    }
    .hb-sb-detail-desc {
      color: var(--hb-text-cream);
      margin-bottom: 4px;
    }
    .hb-sb-detail-comps {
      color: var(--hb-text-muted);
      font-size: 9px;
    }
  `;
  document.head.appendChild(style);
}

// Right-click popover lifecycle — at most one open at a time. Lives
// outside the view mount, so it can position freely over the page.
// The mount() returned cleanup closes any open popover so view-swap
// doesn't leave it dangling on screen.
let openDetail = null;
function closeDetail() {
  if (openDetail) {
    openDetail.remove();
    openDetail = null;
  }
}

function showSpellDetail(meta, anchorX, anchorY, componentNames) {
  closeDetail();
  const el = document.createElement("div");
  el.className = "hb-sb-detail";

  const name = document.createElement("div");
  name.className = "hb-sb-detail-name";
  setAcText(name, meta.name);
  el.appendChild(name);

  const meta_str = document.createElement("div");
  meta_str.className = "hb-sb-detail-meta";
  const schoolName = SCHOOL_NAMES[meta.school] ?? "?";
  const durStr = meta.duration && meta.duration > 0
    ? ` · ${meta.duration >= 60 ? `${Math.round(meta.duration / 60)}m` : `${meta.duration}s`}`
    : "";
  setAcText(
    meta_str,
    `${schoolName} · Level ${meta.level} · ${meta.mana} mana${durStr}` +
      (meta.untargeted ? " · self-cast" : " · targeted"),
  );
  el.appendChild(meta_str);

  if (meta.desc) {
    const desc = document.createElement("div");
    desc.className = "hb-sb-detail-desc";
    setAcText(desc, meta.desc);
    el.appendChild(desc);
  }

  if (Array.isArray(meta.components) && meta.components.length > 0) {
    const comps = document.createElement("div");
    comps.className = "hb-sb-detail-comps";
    const names = meta.components.map((c) => resolveComponentName(c, componentNames));
    setAcText(comps, `Components: ${names.join(", ")}`);
    el.appendChild(comps);
  }

  // Position near the click; clamp to viewport.
  const W = 280, H = 120;
  let left = anchorX + 8;
  let top = anchorY + 8;
  if (left + W > window.innerWidth) left = window.innerWidth - W - 8;
  if (top + H > window.innerHeight) top = anchorY - H - 8;
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  document.body.appendChild(el);
  openDetail = el;
}

// Manifest kept for backward-compat / debug, but iconHidden + no
// activate — the bar slot was removed in PR-Z. The view is mounted
// via main-panel.registerView("spellbook", view) in index.html.
export const manifest = {
  id: "spellbook",
  name: "Spellbook",
  icon: "📖",
  iconHidden: true,
  version: "0.2.0",
  description: "Known spells — main-panel view (S / F5 hotkey).",
};

export const view = {
  name: "Spellbook",
  nameFor: () => "Spellbook",
  mount: (parentEl, ctx) => doMount(parentEl, ctx),
};

function doMount(parentEl, ctx) {
  ensureStyles();
  const client = ctx?.client ?? window.__pluginClient ?? null;

  const root = document.createElement("div");
  root.className = "hb-sb-root";

  // ── Spell-bar tab strip (Phase I.2) ────────────────────────────
  // 7 numbered tabs. Clicking a tab activates it so the magic
  // combat-bar mirrors that tab's slots. Highlighting follows.
  const tabsEl = document.createElement("div");
  tabsEl.className = "hb-sb-tabs";
  const tabBtns = [];
  for (let i = 0; i < SPELL_BAR_TABS; i++) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hb-sb-tab";
    setAcText(btn, String(i + 1));
    btn.dataset.tabIdx = String(i);
    btn.title = `Spell bar ${i + 1}`;
    btn.addEventListener("click", () => {
      setActiveSpellBar(i);
      // writeCombatBarState fires hb-spellbar-changed → rerenderList
      // updates the .on-bar highlights to match the new active tab.
      refreshTabActiveClass();
    });
    tabsEl.appendChild(btn);
    tabBtns.push(btn);
  }
  function refreshTabActiveClass() {
    const active = getActiveSpellBar();
    for (let i = 0; i < tabBtns.length; i++) {
      tabBtns[i].classList.toggle("active", i === active);
    }
  }
  refreshTabActiveClass();
  root.appendChild(tabsEl);

  // ── Filter band — school + level check-bubbles ────────────────
  const filtersBand = document.createElement("div");
  filtersBand.className = "hb-sb-filters-band";

  const filters = {
    schools: new Set([1, 2, 3, 4, 5]),
    levels: new Set([1, 2, 3, 4, 5, 6, 7, 8]),
  };

  const filterRow = document.createElement("div");
  filterRow.className = "hb-sb-filters";
  const schoolGroup = document.createElement("div");
  schoolGroup.className = "hb-sb-filter-group";
  for (const sid of [1, 2, 3, 4, 5]) {
    const lbl = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = true;
    cb.addEventListener("change", () => {
      if (cb.checked) filters.schools.add(sid);
      else filters.schools.delete(sid);
      rerenderList();
    });
    lbl.appendChild(cb);
    lbl.appendChild(document.createTextNode(SCHOOL_NAMES[sid]));
    schoolGroup.appendChild(lbl);
  }
  filterRow.appendChild(schoolGroup);
  filtersBand.appendChild(filterRow);

  // Phase H.3 — level filter check-bubbles (retail had I-VIII levels).
  const levelRow = document.createElement("div");
  levelRow.className = "hb-sb-filters";
  levelRow.style.marginTop = "3px";
  const levelGroup = document.createElement("div");
  levelGroup.className = "hb-sb-filter-group";
  const ROMAN = { 1: "I", 2: "II", 3: "III", 4: "IV", 5: "V", 6: "VI", 7: "VII", 8: "VIII" };
  for (const lv of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const lbl = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = true;
    cb.addEventListener("change", () => {
      if (cb.checked) filters.levels.add(lv);
      else filters.levels.delete(lv);
      rerenderList();
    });
    lbl.appendChild(cb);
    lbl.appendChild(document.createTextNode(ROMAN[lv]));
    levelGroup.appendChild(lbl);
  }
  levelRow.appendChild(levelGroup);
  filtersBand.appendChild(levelRow);

  root.appendChild(filtersBand);

  // ── Hint band ──────────────────────────────────────────────────
  const hint = document.createElement("div");
  hint.className = "hb-sb-hint";
  setAcText(hint, "Double-click a spell to add it to the magic combat bar. Drag to a specific slot. Right-click for details. Delete to forget.");
  root.appendChild(hint);

  // ── List ───────────────────────────────────────────────────────
  const listEl = document.createElement("div");
  listEl.className = "hb-sb-list";
  root.appendChild(listEl);

  parentEl.appendChild(root);

  let catalog = null;
  let componentNames = null;
  let knownIds = new Set();
  // Phase J.1 — Delete-to-remove: when a row has focus and the user
  // presses Delete, prompt to forget the spell.
  let selectedRowId = 0;

  // Perf F4 (2026-05-18) — diffed render. Build each row ONCE per
  // spell id, keep refs in `rowMap`, and on filter/spellbar change
  // toggle `display` + `on-bar` rather than tearing the list down
  // and re-wiring drag/click/dblclick/contextmenu listeners. The
  // persistent empty-state element below is reused too.
  const rowMap = new Map(); // id (number) -> { row, meta }
  const emptyEl = document.createElement("div");
  emptyEl.className = "hb-sb-empty";
  emptyEl.style.display = "none";
  listEl.appendChild(emptyEl);

  function buildRow(id, meta) {
    const row = document.createElement("div");
    row.className = "hb-sb-row";
    row.dataset.spellId = String(id);
    row.draggable = true;
    row.title = `${meta.name} — ${meta.untargeted ? "self-cast" : "targeted"}, ${meta.mana} mana, lvl ${meta.level}`;
    row.addEventListener("dragstart", (ev) => {
      // Phase H.5 — drag spell to populate a combat-bar slot.
      // dataTransfer carries the spell ID; combat-bar's row handlers
      // read it from "application/x-hb-spell-id".
      ev.dataTransfer.effectAllowed = "copy";
      ev.dataTransfer.setData("application/x-hb-spell-id", String(id));
      ev.dataTransfer.setData("text/plain", meta.name);
    });

    const name = document.createElement("span");
    name.className = "hb-sb-row-name";
    setAcText(name, meta.name);
    row.appendChild(name);

    const schoolTag = document.createElement("span");
    schoolTag.className = `hb-sb-row-tag school-${meta.school}`;
    // School-tinted text — pass concrete color so the AC-font canvas
    // matches the CSS .school-N color (red/green/orange/blue/purple).
    const schoolColor = {
      1: "rgb(255, 140, 140)",
      2: "rgb(140, 220, 140)",
      3: "rgb(255, 200, 120)",
      4: "rgb(140, 200, 255)",
      5: "rgb(200, 140, 255)",
    }[meta.school];
    setAcText(schoolTag, SCHOOL_NAMES[meta.school] ?? "?", schoolColor ? { color: schoolColor } : undefined);
    row.appendChild(schoolTag);

    const manaTag = document.createElement("span");
    manaTag.className = "hb-sb-row-tag";
    setAcText(manaTag, `${meta.mana}m`);
    row.appendChild(manaTag);

    // Phase J.1 — single-click selects (highlights) the row.
    row.addEventListener("click", () => {
      selectedRowId = id;
      for (const r of listEl.querySelectorAll(".hb-sb-row.selected")) {
        r.classList.remove("selected");
      }
      row.classList.add("selected");
    });

    row.addEventListener("dblclick", () => {
      const slot = addToFirstEmptySlot(id);
      row.classList.add("on-bar");
      row.style.background = "rgba(160, 110, 255, 0.3)";
      setTimeout(() => { row.style.background = ""; }, 200);
      console.log(`[spellbook] added ${meta.name} (id=${id}) to slot ${slot}`);
    });

    row.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      // Read the latest meta from the closure-captured slot so
      // detail popover uses fresh component names.
      const slot = rowMap.get(id);
      showSpellDetail(slot ? slot.meta : meta, ev.clientX, ev.clientY, componentNames);
    });

    return row;
  }

  function rerenderList() {
    if (!catalog) {
      // Loading state — hide all known rows + show the loader.
      for (const { row } of rowMap.values()) row.style.display = "none";
      setAcText(emptyEl, "Loading spell catalog…");
      emptyEl.style.display = "";
      return;
    }

    // 1) Materialize the desired set: catalogued + known, plus
    //    uncatalogued-but-known placeholders.
    const cataloguedIds = new Set(Object.keys(catalog).map((k) => Number(k)));
    const desired = new Map(); // id -> meta
    for (const [idStr, meta] of Object.entries(catalog)) {
      const id = Number(idStr);
      if (!knownIds.has(id)) continue;
      desired.set(id, meta);
    }
    // Spells the character knows but our 26-entry starter catalog
    // doesn't have a name/school for. Always show them with a
    // placeholder so the user knows they're learned.
    for (const id of knownIds) {
      if (!cataloguedIds.has(id)) {
        desired.set(id, {
          name: `Spell #${id}`,
          school: 0,
          level: 0,
          untargeted: true,
          mana: 0,
          _uncatalogued: true,
        });
      }
    }

    // 2) Drop rows that no longer belong (e.g. spell forgotten).
    for (const [id, slot] of rowMap) {
      if (!desired.has(id)) {
        slot.row.remove();
        rowMap.delete(id);
      }
    }

    // 3) Build any new rows; toggle display on existing ones.
    //    `slotsNow` reflects the active spell-bar tab.
    const slotsNow = new Set(getSpellBarSlots().filter((v) => v > 0));
    let visibleCount = 0;
    for (const [id, meta] of desired) {
      let slot = rowMap.get(id);
      if (!slot) {
        const row = buildRow(id, meta);
        slot = { row, meta };
        rowMap.set(id, slot);
        listEl.appendChild(row);
      } else {
        slot.meta = meta;
      }
      const { row } = slot;

      // Filter pass — uncatalogued placeholders bypass school/level
      // (school=0/level=0 wouldn't match any active filter set).
      const passes = meta._uncatalogued
        ? true
        : (filters.schools.has(meta.school) && filters.levels.has(meta.level));

      row.style.display = passes ? "" : "none";
      if (passes) visibleCount++;

      // on-bar class follows the live spell-bar contents.
      if (slotsNow.has(id)) row.classList.add("on-bar");
      else row.classList.remove("on-bar");
    }

    // 4) Empty-state message.
    if (visibleCount === 0) {
      setAcText(
        emptyEl,
        knownIds.size === 0
          ? "No spells known."
          : "No spells match the current filter.",
      );
      emptyEl.style.display = "";
    } else {
      emptyEl.style.display = "none";
    }
  }

  function refreshKnown() {
    if (client?.player?.knownSpells) {
      try {
        const arr = client.player.knownSpells();
        knownIds = new Set(Array.from(arr));
      } catch (e) {
        console.warn("[spellbook] knownSpells failed:", e);
      }
    } else {
      knownIds = new Set();
    }
    rerenderList();
  }

  rerenderList();
  loadCatalog().then((c) => {
    catalog = c;
    refreshKnown();
  });
  // Phase J.2 — fetch component names in parallel.
  loadComponentNames().then((m) => { componentNames = m; });

  // ── Live subscriptions ─────────────────────────────────────────
  let statsHandler = null;
  if (client?.events?.on) {
    statsHandler = () => refreshKnown();
    client.events.on("playerStatsUpdated", statsHandler);
  }
  const spellbarHandler = () => {
    refreshTabActiveClass();
    rerenderList();
  };
  window.addEventListener("hb-spellbar-changed", spellbarHandler);

  // Phase J.1 — Delete key removes the currently-selected spell from
  // the spellbook. Confirms first so a stray keypress doesn't lose
  // the spell.
  function onDeleteKey(ev) {
    if (!matchesBinding(ev, resolveLocalBinding(LOCAL_ACTION_IDS.DELETE_SPELL, "Delete"))) return;
    if (!selectedRowId) return;
    // Skip if user is typing in an input/textarea elsewhere.
    const tag = ev.target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if (!root.isConnected) return; // panel closed
    const meta = catalog?.[String(selectedRowId)];
    const name = meta?.name ?? `spell ${selectedRowId}`;
    if (!window.confirm(`Remove ${name} from your spellbook?`)) return;
    try {
      client?.player?.forgetSpell?.(selectedRowId);
    } catch (e) {
      console.warn(`[spellbook] forget(${selectedRowId}) failed: ${e?.message ?? e}`);
    }
    // Optimistic local refresh; ACE will broadcast MagicRemoveSpell
    // which lands as a stats refresh and re-pulls knownSpells.
    knownIds.delete(selectedRowId);
    selectedRowId = 0;
    rerenderList();
  }
  window.addEventListener("keydown", onDeleteKey);

  // Popover lifecycle handlers — close on outside click or Esc.
  // Scoped to mount() so they go away when the view swaps.
  function onPopoverMouseDown(ev) {
    if (openDetail && !openDetail.contains(ev.target)) closeDetail();
  }
  function onPopoverEsc(ev) {
    if (matchesBinding(ev, resolveLocalBinding(LOCAL_ACTION_IDS.CLOSE, "Escape"))) closeDetail();
  }
  window.addEventListener("mousedown", onPopoverMouseDown, true);
  window.addEventListener("keydown", onPopoverEsc);

  // ── Cleanup — torn down on view swap or container close ───────
  return () => {
    if (statsHandler && client?.events?.off) {
      client.events.off("playerStatsUpdated", statsHandler);
    }
    window.removeEventListener("hb-spellbar-changed", spellbarHandler);
    window.removeEventListener("keydown", onDeleteKey);
    window.removeEventListener("mousedown", onPopoverMouseDown, true);
    window.removeEventListener("keydown", onPopoverEsc);
    closeDetail();
    root.remove();
  };
}

export {
  getSpellBarSlots,
  setSpellBarSlot,
  getActiveSpellBar,
  setActiveSpellBar,
  SPELL_BAR_SLOTS,
  SPELL_BAR_TABS,
  loadCatalog,
};
