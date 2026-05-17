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
    .hb-sb-filters {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 10px;
      margin-bottom: 8px;
      font-size: 11px;
      color: rgba(255, 255, 255, 0.75);
    }
    .hb-sb-filter-group {
      display: flex;
      gap: 4px;
      align-items: center;
    }
    .hb-sb-filter-group label {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      cursor: pointer;
    }
    .hb-sb-filter-group input[type="checkbox"] {
      width: 11px;
      height: 11px;
      accent-color: rgba(160, 110, 255, 0.9);
    }
    .hb-sb-hint {
      font-size: 11px;
      color: rgba(255, 255, 255, 0.45);
      margin-bottom: 6px;
    }
    .hb-sb-list {
      display: flex;
      flex-direction: column;
      gap: 2px;
      max-height: 280px;
      overflow-y: auto;
    }
    .hb-sb-row {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 6px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 4px;
      font-size: 11px;
      cursor: pointer;
    }
    .hb-sb-row:hover {
      background: rgba(255, 255, 255, 0.1);
      border-color: rgba(255, 255, 255, 0.18);
    }
    .hb-sb-row.on-bar {
      border-color: rgba(160, 110, 255, 0.6);
    }
    .hb-sb-row.selected {
      background: rgba(160, 110, 255, 0.25);
      border-color: rgba(180, 130, 255, 0.7);
    }
    .hb-sb-row.hb-sb-row-selected {
      background: rgba(160, 110, 255, 0.25);
      border-color: rgba(180, 130, 255, 0.85);
    }
    .hb-sb-row-name { flex: 1; color: #fff; }
    .hb-sb-row-tag {
      font-size: 9px;
      padding: 1px 5px;
      background: rgba(0, 0, 0, 0.3);
      border-radius: 3px;
      color: rgba(255, 255, 255, 0.5);
    }
    .hb-sb-row-tag.school-1 { color: rgba(255, 140, 140, 0.9); }
    .hb-sb-row-tag.school-2 { color: rgba(140, 220, 140, 0.9); }
    .hb-sb-row-tag.school-3 { color: rgba(255, 200, 120, 0.9); }
    .hb-sb-row-tag.school-4 { color: rgba(140, 200, 255, 0.9); }
    .hb-sb-row-tag.school-5 { color: rgba(200, 140, 255, 0.9); }
    .hb-sb-empty {
      color: rgba(255, 255, 255, 0.4);
      font-style: italic;
      padding: 8px;
      text-align: center;
    }
    .hb-sb-detail {
      position: fixed;
      z-index: 200;
      max-width: 280px;
      padding: 8px 10px;
      background: rgba(28, 28, 32, 0.96);
      border: 1px solid rgba(160, 110, 255, 0.5);
      border-radius: 6px;
      color: #fff;
      font-size: 11px;
      line-height: 1.4;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.55);
      backdrop-filter: blur(6px);
    }
    .hb-sb-detail-name {
      font-weight: 600;
      font-size: 12px;
      margin-bottom: 4px;
    }
    .hb-sb-detail-meta {
      color: rgba(255, 255, 255, 0.65);
      margin-bottom: 6px;
      font-size: 10px;
    }
    .hb-sb-detail-desc {
      color: rgba(255, 255, 255, 0.85);
      margin-bottom: 4px;
    }
    .hb-sb-detail-comps {
      color: rgba(255, 255, 255, 0.5);
      font-size: 10px;
    }
  `;
  document.head.appendChild(style);
}

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
  name.textContent = meta.name;
  el.appendChild(name);

  const meta_str = document.createElement("div");
  meta_str.className = "hb-sb-detail-meta";
  const schoolName = SCHOOL_NAMES[meta.school] ?? "?";
  const durStr = meta.duration && meta.duration > 0
    ? ` · ${meta.duration >= 60 ? `${Math.round(meta.duration / 60)}m` : `${meta.duration}s`}`
    : "";
  meta_str.textContent =
    `${schoolName} · Level ${meta.level} · ${meta.mana} mana${durStr}` +
    (meta.untargeted ? " · self-cast" : " · targeted");
  el.appendChild(meta_str);

  if (meta.desc) {
    const desc = document.createElement("div");
    desc.className = "hb-sb-detail-desc";
    desc.textContent = meta.desc;
    el.appendChild(desc);
  }

  if (Array.isArray(meta.components) && meta.components.length > 0) {
    const comps = document.createElement("div");
    comps.className = "hb-sb-detail-comps";
    const names = meta.components.map((c) => resolveComponentName(c, componentNames));
    comps.textContent = `Components: ${names.join(", ")}`;
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

// Close popover on outside click or Esc.
if (typeof window !== "undefined") {
  window.addEventListener("mousedown", (ev) => {
    if (openDetail && !openDetail.contains(ev.target)) closeDetail();
  }, true);
  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") closeDetail();
  });
}

export const manifest = {
  id: "spellbook",
  name: "Spellbook",
  icon: "📖",
  version: "0.0.1",
  description: "Known spells. Double-click to add to magic combat bar (F5).",
};

export function activate(bodyEl, ctx) {
  ensureStyles();
  const client = ctx?.client ?? window.__pluginClient ?? null;

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
  bodyEl.appendChild(filterRow);

  // Phase H.3 — level filter check-bubbles (retail had I-VIII levels).
  const levelRow = document.createElement("div");
  levelRow.className = "hb-sb-filters";
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
  bodyEl.appendChild(levelRow);

  const hint = document.createElement("div");
  hint.className = "hb-sb-hint";
  hint.textContent = "Double-click a spell to add it to the magic combat bar.";
  bodyEl.appendChild(hint);

  const listEl = document.createElement("div");
  listEl.className = "hb-sb-list";
  bodyEl.appendChild(listEl);

  let catalog = null;
  let componentNames = null;
  let knownIds = new Set();
  // Phase J.1 — Delete-to-remove: when a row has focus and the user
  // presses Delete, prompt to forget the spell. Tracked separately
  // from the on-bar highlight.
  let selectedRowId = 0;

  function rerenderList() {
    listEl.innerHTML = "";
    if (!catalog) {
      const empty = document.createElement("div");
      empty.className = "hb-sb-empty";
      empty.textContent = "Loading spell catalog…";
      listEl.appendChild(empty);
      return;
    }
    const entries = [];
    for (const [idStr, meta] of Object.entries(catalog)) {
      const id = Number(idStr);
      if (!knownIds.has(id)) continue;
      if (!filters.schools.has(meta.school)) continue;
      if (!filters.levels.has(meta.level)) continue;
      entries.push([id, meta]);
    }
    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "hb-sb-empty";
      empty.textContent = knownIds.size === 0
        ? "No known spells yet — log in to populate."
        : "No spells match the current filter.";
      listEl.appendChild(empty);
      return;
    }

    const slotsNow = new Set(getSpellBarSlots().filter((v) => v > 0));

    for (const [id, meta] of entries) {
      const row = document.createElement("div");
      row.className = "hb-sb-row";
      if (slotsNow.has(id)) row.classList.add("on-bar");
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
      name.textContent = meta.name;
      row.appendChild(name);

      const schoolTag = document.createElement("span");
      schoolTag.className = `hb-sb-row-tag school-${meta.school}`;
      schoolTag.textContent = SCHOOL_NAMES[meta.school] ?? "?";
      row.appendChild(schoolTag);

      const manaTag = document.createElement("span");
      manaTag.className = "hb-sb-row-tag";
      manaTag.textContent = `${meta.mana}m`;
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
        showSpellDetail(meta, ev.clientX, ev.clientY, componentNames);
      });

      listEl.appendChild(row);
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

  let statsHandler = null;
  if (client?.events?.on) {
    statsHandler = () => refreshKnown();
    client.events.on("playerStatsUpdated", statsHandler);
  }
  const spellbarHandler = () => rerenderList();
  window.addEventListener("hb-spellbar-changed", spellbarHandler);

  // Phase J.1 — Delete key removes the currently-selected spell from
  // the spellbook. Confirms first so a stray keypress doesn't lose
  // the spell.
  function onDeleteKey(ev) {
    if (ev.key !== "Delete") return;
    if (!selectedRowId) return;
    // Skip if user is typing in an input/textarea elsewhere.
    const tag = ev.target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if (!bodyEl.isConnected) return; // panel closed
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

  return () => {
    if (statsHandler && client?.events?.off) {
      client.events.off("playerStatsUpdated", statsHandler);
    }
    window.removeEventListener("hb-spellbar-changed", spellbarHandler);
    window.removeEventListener("keydown", onDeleteKey);
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
