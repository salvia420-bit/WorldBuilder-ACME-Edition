const COMBAT_BAR_STORAGE_KEY = "holtburger_combat_bar_v1";
const SPELL_BAR_SLOTS = 8;

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
  if (window.__combatBarState) {
    window.__combatBarState.spellBarSlots = merged.spellBarSlots || [];
  } else {
    window.__combatBarState = { spellBarSlots: merged.spellBarSlots || [] };
  }
  window.dispatchEvent(new CustomEvent("hb-spellbar-changed"));
}

function getSpellBarSlots() {
  const state = readCombatBarState();
  const slots = Array.isArray(state.spellBarSlots) ? state.spellBarSlots : [];
  const padded = [];
  for (let i = 0; i < SPELL_BAR_SLOTS; i++) {
    const v = slots[i];
    padded.push(typeof v === "number" && v > 0 ? v : 0);
  }
  return padded;
}

function setSpellBarSlot(index, spellId) {
  if (index < 0 || index >= SPELL_BAR_SLOTS) return;
  const slots = getSpellBarSlots();
  slots[index] = spellId | 0;
  const state = readCombatBarState();
  state.spellBarSlots = slots;
  writeCombatBarState(state);
}

function addToFirstEmptySlot(spellId) {
  const slots = getSpellBarSlots();
  const empty = slots.findIndex((v) => v === 0);
  if (empty === -1) {
    slots[SPELL_BAR_SLOTS - 1] = spellId;
  } else {
    slots[empty] = spellId;
  }
  const state = readCombatBarState();
  state.spellBarSlots = slots;
  writeCombatBarState(state);
  return empty === -1 ? SPELL_BAR_SLOTS - 1 : empty;
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
  `;
  document.head.appendChild(style);
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
    minLevel: 1,
    maxLevel: 999,
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

  const hint = document.createElement("div");
  hint.className = "hb-sb-hint";
  hint.textContent = "Double-click a spell to add it to the magic combat bar.";
  bodyEl.appendChild(hint);

  const listEl = document.createElement("div");
  listEl.className = "hb-sb-list";
  bodyEl.appendChild(listEl);

  let catalog = null;
  let knownIds = new Set();

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
      if (meta.level < filters.minLevel || meta.level > filters.maxLevel) continue;
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
      row.title = `${meta.name} — ${meta.untargeted ? "self-cast" : "targeted"}, ${meta.mana} mana, lvl ${meta.level}`;

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

      row.addEventListener("dblclick", () => {
        const slot = addToFirstEmptySlot(id);
        row.classList.add("on-bar");
        row.style.background = "rgba(160, 110, 255, 0.3)";
        setTimeout(() => { row.style.background = ""; }, 200);
        console.log(`[spellbook] added ${meta.name} (id=${id}) to slot ${slot}`);
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

  let statsHandler = null;
  if (client?.events?.on) {
    statsHandler = () => refreshKnown();
    client.events.on("playerStatsUpdated", statsHandler);
  }
  const spellbarHandler = () => rerenderList();
  window.addEventListener("hb-spellbar-changed", spellbarHandler);

  return () => {
    if (statsHandler && client?.events?.off) {
      client.events.off("playerStatsUpdated", statsHandler);
    }
    window.removeEventListener("hb-spellbar-changed", spellbarHandler);
  };
}

export { getSpellBarSlots, setSpellBarSlot, SPELL_BAR_SLOTS, loadCatalog };
