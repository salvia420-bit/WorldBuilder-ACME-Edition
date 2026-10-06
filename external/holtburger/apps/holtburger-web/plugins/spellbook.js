// Spellbook view — Phase G (catalog + known-spell intersection),
// Phase J (delete-from-spellbook RemoveSpellFromBook 0x01A8 wire round-
// trip + component name table), Phase K (multi-tab spell-bars).
//
// A registered view of plugins/main-panel.js (F5, F2 alt). HUD overhaul
// 2026-10-05 rebuilt the view on the retail gmSpellbookUI anatomy
// (LayoutDesc 0x21000032, 300×337) with the shared hbk-* kit:
//
//   0x10000294 RootSpellbook_Field  dark field 0x06004CC2
//   0x10000295 SpellBook_SpellList  280×224 — ItemSlot_SpellbookEntry rows
//              (0x10000343, 280×32: field 0x06001396 / selected 0x06001397,
//              icon 32×32 at x=0, text at x=42) + rope scrollbar 0x10000296
//   0x10000297 FilterBox            300×113 slate 0x06002722:
//              "Schools:" 0x100002A3 + Creature 0x10000298 / Item 0x10000299
//              / Life 0x1000029A / War 0x1000029B / Void 0x100005C0;
//              "Levels:" 0x100002A4 + I..VIII 0x1000029C..0x100002A2,
//              0x1000054E; DeleteSpell_Button 0x100002A5 ("Delete")
//
// Layout is a flex column: the filter box keeps its height and the list
// yields, so the VIII row can never be clipped (the pre-overhaul absolute
// geometry assumed a 337-px body and lost its last filter row in the real
// ~325-px one). Rows are fixed 32 px and virtualised (2026-07-04 perf fix).
//
// Behaviour (decomp-matched, acclient.c):
//   * gmSpellbookUI::GetSortedInsertionPlace — ascending SpellBase
//     _display_order.
//   * gmSpellbookUI::IsFilteredOut — one filter bit per school/level
//     button (PlayerModule spellbook filters); persisted per browser.
//   * gmSpellbookUI::ListenToElementMessage — double-click adds the spell
//     to the active spell bar (CM_Magic::SendNotice_AddSpellShortcut);
//     single click selects; the Delete button / Delete key remove it after
//     a confirmation (DeleteSpell → DeleteSpellDialogCallback).
//   * Drag a row onto any bar slot — `application/x-hb-spell-id` mime.
//   * Right-click — detail card (school / level / duration / mana /
//     description / components).
//   * "Components" swaps the list for the carried spell components
//     (rec #46 pouch; retail had a sibling gmSpellComponentUI panel).
//
// Helpers re-exported at the bottom remain in scope for combat-bar.js:
//   getSpellBarSlots, setSpellBarSlot, getActiveSpellBar,
//   setActiveSpellBar, SPELL_BAR_SLOTS, SPELL_BAR_TABS, loadCatalog.

import { setAcText, COMPACT_FONT_ID } from "../ui/ac_font.js";
import { resolveLocalBinding, matchesBinding, LOCAL_ACTION_IDS } from "../ui/keymap.js";
import { getInputFunnel, inputFunnelV2On } from "../ui/input-funnel.js";
import { getIconImmediate, fetchIconDataUrl } from "../ui/ac_icon_cache.js";
import { hudPoint, hudViewport } from "../ui/hud_scale.js";

const COMBAT_BAR_STORAGE_KEY = "holtburger_combat_bar_v1";
// Task C follow-up (2026-07-01): retail-corrected counts, verified
// against a live retail capture of the spellcasting panel
// (Spell-Casting-Panel-Live.jpg): the tab row reads I..VIII = EIGHT
// tabs (the earlier "retail had 7" note was wrong), and the icon strip
// holds 18 slot cells (orb ~40px + 18×34px + Cast ≈ the capture's
// 717px width; hotkey digits 1-9 badge the first nine). Storage
// migrates transparently — readSpellBars pads every tab to
// SPELL_BAR_SLOTS and older 8-slot arrays just gain empty cells.
const SPELL_BAR_SLOTS = 18;
const SPELL_BAR_TABS = 8;

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

// Wave F.1 (2026-05-27) — DAT-driven spell record lookup, replacing
// the LSD-derived `data/spells-catalog.json` with byte-correct retail
// data from `client_portal.dat` (file 0x0E00000E, parsed by
// `holtburger_dat::file_type::spell_table::SpellBase` and exposed via
// the wasm-bindgen export `SessionHandle::getSpellRecord(spell_id)`).
//
// The wasm path is preferred when `getSpellRecord` is available AND
// WorldBootstrap has been loaded (i.e., post-EnteredWorld). The
// catalog JSON is kept as a fallback for sessions that aren't logged
// in (settings panel preview, plugin dev mode) and for spells the
// SpellTable doesn't have records for (custom/server-defined).
//
// JSON catalog shape mapping (legacy):
//   { name, school, level, untargeted, mana, icon, desc, duration, components }
// Wasm record shape (Wave F.1, expanded):
//   { id, name, school, schoolName, isUntargeted, isSelfTargeted, baseMana,
//     iconId, description, components, bitfield, flags{...}, ... }
//
// We coerce the wasm record into the legacy shape so existing UI code
// keeps working without changes. The richer wasm-only fields (flags,
// duration, recovery, etc.) flow through unchanged for new consumers.
//
// Perf fix (2026-07-04, spellbook hang on @addallspells accounts) —
// spell records are immutable for the life of a session (WorldBootstrap
// / spell_table is fixed post-EnteredWorld), so every id's coerced
// record is memoized here. Without this, rerenderList() re-crossed the
// wasm serde-wasm-bindgen boundary (Map construction) once PER SPELL on
// every single render — filter-toggle, playerStatsUpdated tick, or
// re-open — which is what turned a ~2,000-spell dev/Developer-account
// spellbook into a multi-minute freeze. Only successful lookups (raw
// truthy) and confirmed misses (handle present, raw falsy) are cached;
// the "no session handle yet" case is intentionally left uncached so a
// pre-login/pre-EnteredWorld probe doesn't permanently poison the
// cache before the wasm session is actually ready.
const spellRecordCache = new Map(); // spellId (number) -> record | null
function spellRecordFromWasm(spellId) {
  if (spellRecordCache.has(spellId)) return spellRecordCache.get(spellId);
  // SessionHandle is exposed by index.html during start_session.
  const handle = window.__sessionHandle;
  if (!handle?.getSpellRecord) return null;
  let raw;
  try {
    raw = handle.getSpellRecord(spellId);
  } catch (e) {
    return null;
  }
  if (!raw) {
    spellRecordCache.set(spellId, null);
    return null;
  }
  // getSpellRecord crosses the wasm boundary via serde-wasm-bindgen,
  // which emits JS **Map**s for JSON objects (live-verified
  // 2026-07-01: `getSpellRecord(6) instanceof Map`, `.get("name") ===
  // "Heal Self I"`). The plain-object reads below (`raw.name` …)
  // returned undefined on a Map, so the wasm-preferred hybrid merge
  // silently produced empty records and every consumer was actually
  // living off the LSD JSON fallback (masked because the JSON carries
  // the same core fields). Normalize the Map (+ the nested `flags`
  // Map) so the DAT-correct record really wins.
  if (raw instanceof Map) {
    raw = Object.fromEntries(raw);
    if (raw.flags instanceof Map) raw.flags = Object.fromEntries(raw.flags);
  }
  // Coerce to legacy spells-catalog.json shape so existing UI code
  // keeps working without changes.
  const record = {
    // Legacy keys preserved (UI consumes these in many places):
    name:        raw.name,
    school:      raw.school,
    level:       raw.roughLevel ?? 0,
    levelRoman:  raw.levelRoman ?? "",
    untargeted:  !!raw.isSelfTargeted,
    mana:        raw.baseMana,
    icon:        raw.iconId,
    desc:        raw.description,
    duration:    raw.duration ?? 0,
    components:  Array.isArray(raw.components) ? raw.components : [],
    // New Wave F.1 fields available to consumers that want them:
    _waveF1:     true,
    bitfield:    raw.bitfield,
    flags:       raw.flags,
    isFastCast:  raw.isFastCast,
    isBeneficial: raw.isBeneficial,
    metaSpellType: raw.metaSpellType,
    metaSpellTypeName: raw.metaSpellTypeName,
    baseRangeConstant: raw.baseRangeConstant,
    baseRangeMod: raw.baseRangeMod,
    power:       raw.power,
    category:    raw.category,
    casterEffect: raw.casterEffect,
    targetEffect: raw.targetEffect,
    fizzleEffect: raw.fizzleEffect,
    recoveryInterval: raw.recoveryInterval,
    recoveryAmount: raw.recoveryAmount,
    displayOrder: raw.displayOrder,
  };
  spellRecordCache.set(spellId, record);
  return record;
}

// Build a catalog-shaped lookup from the union of (a) the legacy JSON
// catalog (fallback / pre-login), and (b) per-id wasm records overriding
// the JSON entries when available. Lazy-resolves wasm records on demand
// — we don't enumerate the 6,266-spell DAT at startup; the spellbook UI
// only ever asks about a player's known-spell list (typically 30-300
// entries by mid-game).
function makeHybridCatalog(jsonCatalog) {
  return new Proxy(jsonCatalog || {}, {
    get(target, key) {
      // Numeric-string keys are spell IDs; non-numeric are JSON metadata
      // like `_comment`. Pass non-numeric through unmodified.
      const spellId = Number(key);
      if (!Number.isFinite(spellId) || spellId <= 0 || String(spellId) !== key) {
        return target[key];
      }
      // Prefer wasm record when available (post-EnteredWorld).
      const fromWasm = spellRecordFromWasm(spellId);
      const fromJson = target[key];
      if (fromWasm && fromJson) {
        // Merge: wasm wins on **all** DAT-correct fields including
        // `level`. Wave J4.A (2026-05-27) ports the ACE-canonical
        // `SpellFormula.Level` (first-component scarab lookup) into
        // the Rust `rough_level()`, so the wasm record's `roughLevel`
        // — which arrives as `level` in the coerced legacy shape —
        // is the correct tier (1-8). The pre-J4.A workaround that
        // preferred the JSON name-suffix `level` (parsed from
        // "Strength Other I" → 1) is no longer needed; the wasm
        // already gets the right answer.
        return { ...fromWasm };
      }
      if (fromWasm) return fromWasm;
      return fromJson;
    },
    has(target, key) {
      const spellId = Number(key);
      if (Number.isFinite(spellId) && spellId > 0) {
        if (spellRecordFromWasm(spellId)) return true;
      }
      return key in target;
    },
    // `Object.keys` / `Object.entries` still enumerate the JSON catalog
    // (~6,266 spells in v1, but pruned to ~3.7k playable in retail).
    // The Wave F.1 wasm lookup is a per-id overlay, not an enumeration
    // replacement (the SpellTable is enormous to iterate in JS — we
    // don't materialize it; we look up on demand).
    ownKeys(target) { return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, key) {
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
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
  // catalog, or already a resolved name. Returns the human label —
  // spell-components.json rows are `{ name, typeName, ... }` objects, so
  // return `.name` (HUD overhaul 2026-10-05: the row object used to leak
  // through as "[object Object]").
  let id = null;
  if (typeof comp === "number") id = String(comp);
  else if (typeof comp === "string") {
    const m = comp.match(/^Comp_(\d+)$/);
    if (!m) return comp;
    id = m[1];
  } else {
    return String(comp);
  }
  const rec = componentNames?.[id];
  if (rec && typeof rec === "object") return rec.name ?? `Component #${id}`;
  return typeof rec === "string" ? rec : `Component #${id}`;
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
    // Pad each tab to SPELL_BAR_SLOTS for safety. Task C v2
    // (2026-07-02): also dedupe WITHIN each tab — retail never allows
    // the same spell twice on one tab; earlier builds could stack
    // duplicates via repeated spellbook double-clicks. First
    // occurrence wins, later copies become empty cells.
    return state.spellBars.map((tab) => {
      const t = Array.isArray(tab) ? tab : [];
      const padded = [];
      const seen = new Set();
      for (let i = 0; i < SPELL_BAR_SLOTS; i++) {
        const v = t[i];
        const id = typeof v === "number" && v > 0 ? v : 0;
        if (id && seen.has(id)) {
          padded.push(0);
        } else {
          if (id) seen.add(id);
          padded.push(id);
        }
      }
      return padded;
    }).slice(0, SPELL_BAR_TABS);
  }
  // Legacy: a single `spellBarSlots` array becomes tab 0.
  const legacy = Array.isArray(state.spellBarSlots) ? state.spellBarSlots : [];
  const tab0 = [];
  const seen0 = new Set();
  for (let i = 0; i < SPELL_BAR_SLOTS; i++) {
    const v = legacy[i];
    const id = typeof v === "number" && v > 0 ? v : 0;
    tab0.push(id && !seen0.has(id) ? (seen0.add(id), id) : 0);
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
  const id = spellId | 0;
  // Task C v2 (2026-07-02) — per-tab uniqueness, enforced structurally:
  // writing a spell into a cell clears it from any OTHER cell on the
  // same tab, so "drop a duplicate" degrades to "move the existing
  // binding". Retail never allowed the same spell twice on one tab.
  if (id > 0) {
    for (let i = 0; i < bars[tab].length; i++) {
      if (i !== slotIndex && (bars[tab][i] | 0) === id) bars[tab][i] = 0;
    }
  }
  bars[tab][slotIndex] = id;
  state.spellBars = bars;
  delete state.spellBarSlots;
  writeCombatBarState(state);
}

function addToFirstEmptySlot(spellId, barIdx) {
  const tab = (typeof barIdx === "number") ? barIdx : getActiveSpellBar();
  const slots = getSpellBarSlots(tab);
  // Per-tab uniqueness (Task C v2): if the spell is already on this
  // tab, keep it where it is and report that index — no duplicate.
  const existing = slots.findIndex((v) => (v | 0) === (spellId | 0));
  if (existing !== -1) return existing;
  const empty = slots.findIndex((v) => v === 0);
  const writeIdx = empty === -1 ? SPELL_BAR_SLOTS - 1 : empty;
  setSpellBarSlot(writeIdx, spellId, tab);
  return writeIdx;
}

// ─── Pure helpers (HUD overhaul 2026-10-05; exported for node tests) ──

// Retail spellbook filter word (PlayerModule::GetSpellbookFilters, read by
// gmSpellbookUI::IsFilteredOut, acclient.c): one bit per school button and
// per level button. Persisted per browser here (retail kept it in the
// character's PlayerModule).
const SCHOOL_BIT = { 4: 0x1, 3: 0x2, 2: 0x4, 1: 0x8, 5: 0x2000 }; // Creature, Item, Life, War, Void
const LEVEL_BIT = { 1: 0x10, 2: 0x20, 3: 0x40, 4: 0x80, 5: 0x100, 6: 0x200, 7: 0x400, 8: 0x800 };
const FILTER_ALL = 0x2FFF;
const FILTER_LS_KEY = "hb.spellbook.filterMask.v1";
// Retail FilterBox button order (0x10000298.. = Creature, Item, Life, War,
// Void — the pre-overhaul code labelled 0x10000298 "War").
const SCHOOL_ORDER = [4, 3, 2, 1, 5];
const ROMAN = { 1: "I", 2: "II", 3: "III", 4: "IV", 5: "V", 6: "VI", 7: "VII", 8: "VIII" };

/** gmSpellbookUI::IsFilteredOut — true when `meta` is hidden by `mask`.
 *  Uncatalogued spells (no school/level) always show — a liberty so a
 *  learned-but-unknown id is never invisible. */
export function isSpellFilteredOut(meta, mask) {
  if (!meta || meta._uncatalogued) return false;
  const sb = SCHOOL_BIT[meta.school];
  const lb = LEVEL_BIT[meta.level];
  if (!sb || !lb) return true;
  return !(mask & sb) || !(mask & lb);
}

/** gmSpellbookUI::GetSortedInsertionPlace — ascending SpellBase
 *  `_display_order`, name as the tie-break (and for JSON-only records
 *  that carry no display order). */
export function compareSpells(a, b) {
  const da = Number.isFinite(a?.displayOrder) ? a.displayOrder : Number.MAX_SAFE_INTEGER;
  const db = Number.isFinite(b?.displayOrder) ? b.displayOrder : Number.MAX_SAFE_INTEGER;
  if (da !== db) return da - db;
  return String(a?.name ?? "").localeCompare(String(b?.name ?? ""));
}

/** Spell duration (seconds) → "30 sec" / "15 min" / "1.5 hr"; "" for
 *  instant (≤ 0). */
export function formatSpellDuration(sec) {
  const s = Number(sec);
  if (!Number.isFinite(s) || s <= 0) return "";
  if (s < 60) return `${Math.round(s)} sec`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  const h = s / 3600;
  return `${Number.isInteger(h) ? h : h.toFixed(1)} hr`;
}

/** Secondary row text: "Level III · 15 min · 30 mana" (school is drawn
 *  separately in its tint). */
export function spellMetaLine(meta) {
  if (!meta || meta._uncatalogued) return "Unknown spell";
  const parts = [];
  const roman = meta.levelRoman || ROMAN[meta.level];
  if (roman) parts.push(`Level ${roman}`);
  const dur = formatSpellDuration(meta.duration);
  if (dur) parts.push(dur);
  if (Number.isFinite(meta.mana) && meta.mana > 0) parts.push(`${meta.mana} mana`);
  return parts.join(" · ");
}

function readFilterMask() {
  try {
    const raw = localStorage.getItem(FILTER_LS_KEY);
    if (raw == null || raw === "") return FILTER_ALL;
    const v = Number(raw);
    return Number.isInteger(v) && v >= 0 ? (v & FILTER_ALL) : FILTER_ALL;
  } catch (_) { return FILTER_ALL; }
}
function writeFilterMask(mask) {
  try { localStorage.setItem(FILTER_LS_KEY, String(mask & FILTER_ALL)); } catch (_) {}
}

const SCHOOL_TINT = {
  1: "#ff8c80", // War
  2: "#8cdc8c", // Life
  3: "#ffc878", // Item
  4: "#8cc8ff", // Creature
  5: "#c88cff", // Void
};

let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const SP = "./data/ui-sprites";
  const style = document.createElement("style");
  style.id = "hb-spellbook-style";
  style.textContent = `
    /* Spellbook — gmSpellbookUI 0x21000032 (RootSpellbook_Field
       0x10000294 300×337: SpellList 0x10000295 over FilterBox 0x10000297).
       Flex column so the filter box never clips: only the list yields
       height. HUD overhaul 2026-10-05. */
    .hb-sb-root {
      position: absolute; inset: 0;
      display: flex; flex-direction: column;
      box-sizing: border-box; overflow: hidden;
      pointer-events: auto; user-select: none;
      color: var(--hbk-text); font-family: var(--hbk-font); font-size: 12px;
      background: url("${SP}/0x06004CC2.png") repeat, var(--hbk-ink, #0b0c10);
    }
    .hb-sb-tabs { flex: 0 0 auto; }
    .hb-sb-tabs .hbk-tab { padding: 1px 2px 2px; letter-spacing: 0; }
    .hb-sb-list { flex: 1 1 auto; min-height: 64px; position: relative; outline: none; }
    .hb-sb-spacer { flex: 0 0 auto; }
    /* ItemSlot_SpellbookEntry 0x10000343 — 280×32 field 0x06001396,
       selected 0x06001397; icon 32×32 at x=0, text at x=42. */
    .hb-sb-row {
      flex: 0 0 32px; height: 32px; box-sizing: border-box;
      display: flex; align-items: center; gap: 8px; padding: 0 8px 0 0;
      background: url("${SP}/0x06001396.png") center / 100% 100% no-repeat;
      cursor: pointer;
    }
    .hb-sb-row:hover { filter: brightness(1.18); }
    .hb-sb-row.selected { background-image: url("${SP}/0x06001397.png"); }
    .hb-sb-icon {
      position: relative; flex: 0 0 32px; width: 32px; height: 32px;
      background: #000 center / 100% 100% no-repeat; image-rendering: pixelated;
      box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.8);
    }
    .hb-sb-slotnum {
      position: absolute; right: 1px; bottom: 0;
      font: 10px/1 var(--hbk-font); color: #fff;
      text-shadow: 0 0 2px #000, 1px 1px 0 #000;
    }
    .hb-sb-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; justify-content: center; gap: 1px; }
    .hb-sb-row-name { height: 16px; overflow: hidden; display: flex; align-items: center; }
    .hb-sb-row-sub { height: 11px; overflow: hidden; display: flex; align-items: center; gap: 4px; }
    .hb-sb-row-sub > span { display: flex; align-items: center; min-width: 0; }
    .hb-sb-row-sub > .hb-sb-meta { flex: 1 1 auto; overflow: hidden; }
    .hb-sb-empty { padding: 24px 12px; }
    .hb-sb-comp-row { min-height: 20px; }
    .hb-sb-comp-row .hbk-grow { display: flex; align-items: center; }
    /* FilterBox 0x10000297 — 0x06002722 slate. */
    .hb-sb-filters {
      flex: 0 0 auto; display: flex; flex-direction: column; gap: 2px;
      padding: 4px 8px 5px 10px; box-sizing: border-box;
      background: url("${SP}/0x06002722.png") center / 100% 100% no-repeat, #1a1a1a;
      border-top: 1px solid var(--hbk-gold-dim);
    }
    .hb-sb-flabel { height: 12px; display: flex; align-items: center; }
    .hb-sb-frow { display: flex; align-items: center; flex-wrap: wrap; justify-content: space-between; gap: 2px 6px; padding-left: 4px; }
    .hb-sb-fopt { display: inline-flex; align-items: center; gap: 2px; min-height: 15px; cursor: pointer; }
    .hb-sb-fopt input.hbk-check { margin: 0 2px 0 0; }
    .hb-sb-filters[data-mode="components"] .hb-sb-fsec { display: none; }
    .hb-sb-factions { display: flex; align-items: center; gap: 6px; margin-top: 3px; }
    .hb-sb-count { flex: 1 1 auto; min-width: 0; overflow: hidden; display: flex; align-items: center; }
    .hb-sb-delete { min-width: 76px; }
    /* Right-click detail card — its own zoomed HUD root (#hb-sb-detail). */
    #hb-sb-detail { max-width: 260px; line-height: 1.35; }
    #hb-sb-detail .hb-sb-detail-name { color: var(--hbk-gold-bright); font-size: 13px; margin-bottom: 2px; }
    #hb-sb-detail .hb-sb-detail-meta { color: var(--hbk-text-dim); font-size: 11px; margin-bottom: 4px; }
    #hb-sb-detail .hb-sb-detail-desc { color: var(--hbk-text); font-size: 12px; margin-bottom: 4px; }
    #hb-sb-detail .hb-sb-detail-comps { color: var(--hbk-text-faint); font-size: 11px; }
  `;
  document.head.appendChild(style);
}

// Right-click detail card lifecycle — at most one open at a time, closed
// by the mount() cleanup so a view swap never leaves it on screen.
let openDetail = null;
function closeDetail() {
  if (openDetail) {
    openDetail.remove();
    openDetail = null;
  }
}

function manaConvNote(meta) {
  // Mana Conversion note (Task C step 3, 2026-07-01): the listed cost is
  // BaseMana; when Mana Conversion is trained+ and the spell lacks
  // SpellFlags.IgnoresManaConversion, ACE rolls a per-cast reduction
  // (Creature_Magic.cs GetManaCost). Skills are the stride-6 [id, cur,
  // base, ranks, training, next_cost] rows; ManaConversion = 16.
  try {
    if (meta?.flags?.ignoresManaConv === true) return "";
    const snap = window.__sessionHandle?.playerStats?.();
    const skills = snap?.skills;
    try { snap?.free?.(); } catch (_) {}
    if (!skills) return "";
    for (let s = 0; s + 5 < skills.length; s += 6) {
      if (skills[s] === 16) return skills[s + 4] >= 2 ? " (Mana Conversion may reduce)" : "";
    }
  } catch (_) {}
  return "";
}

function showSpellDetail(meta, ev, componentNames) {
  closeDetail();
  const card = document.createElement("div");
  card.id = "hb-sb-detail";
  card.className = "hbk-tooltip";

  const name = document.createElement("div");
  name.className = "hb-sb-detail-name";
  name.textContent = meta.name;
  card.appendChild(name);

  const metaEl = document.createElement("div");
  metaEl.className = "hb-sb-detail-meta";
  const school = SCHOOL_NAMES[meta.school] ?? "Unknown school";
  const bits = [school, spellMetaLine(meta) + manaConvNote(meta)];
  bits.push(meta.untargeted ? "Self" : "Targeted");
  metaEl.textContent = bits.filter(Boolean).join(" · ");
  card.appendChild(metaEl);

  if (meta.desc) {
    const desc = document.createElement("div");
    desc.className = "hb-sb-detail-desc";
    desc.textContent = meta.desc;
    card.appendChild(desc);
  }
  if (Array.isArray(meta.components) && meta.components.length > 0) {
    const comps = document.createElement("div");
    comps.className = "hb-sb-detail-comps";
    const names = meta.components.map((c) => resolveComponentName(c, componentNames));
    comps.textContent = `Components: ${names.join(", ")}`;
    card.appendChild(comps);
  }

  // The card is a zoomed HUD root (id `hb-*`), so position it in HUD px:
  // pointer → hudPoint, clamp against hudViewport (ui/hud_scale.js).
  document.body.appendChild(card);
  const p = hudPoint(ev);
  const vp = hudViewport();
  const w = card.offsetWidth || 260;
  const h = card.offsetHeight || 120;
  let left = p.x + 10;
  let top = p.y + 10;
  if (left + w > vp.width - 4) left = Math.max(4, p.x - w - 10);
  if (top + h > vp.height - 4) top = Math.max(4, vp.height - h - 4);
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
  openDetail = card;
}

async function confirmForget(name) {
  const msg = `Remove ${name} from your spellbook? This cannot be undone.`;
  try {
    if (typeof window.__modalConfirm === "function") {
      return !!(await window.__modalConfirm({
        title: "Delete Spell", message: msg, confirmLabel: "Delete", cancelLabel: "Cancel",
      }));
    }
  } catch (_) { /* fall through */ }
  if (typeof window.confirm === "function") return window.confirm(msg);
  return true;
}

// Manifest kept for backward-compat / debug, but iconHidden + no
// activate — the view is mounted via main-panel.registerView("spellbook").
export const manifest = {
  id: "spellbook",
  name: "Spellbook",
  icon: "📖",
  iconHidden: true,
  version: "0.2.0",
  description: "Known spells — main-panel view (F5 / F2).",
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
  root.dataset.el = "0x10000294";

  // ── Spell-bar tab strip (Phase I.2 — Holtburger chrome). P3-42: retail
  //    parity (DEFAULT-ON, `?retailParity=off` shows it) hides it —
  //    retail's spellbook has no bar selector; the bars stay reachable
  //    from the combat bar. ─────────────────────────────────────────
  const retailParity = (() => {
    try { return new URLSearchParams(window.location.search).get("retailParity") !== "off"; }
    catch (_) { return true; }
  })();
  const tabsEl = document.createElement("div");
  tabsEl.className = "hbk-tabs hb-sb-tabs";
  if (retailParity) tabsEl.style.display = "none";
  const tabBtns = [];
  for (let i = 0; i < SPELL_BAR_TABS; i++) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hbk-tab";
    btn.textContent = ROMAN[i + 1] ?? String(i + 1);
    btn.dataset.tabIdx = String(i);
    btn.title = `Spell bar ${i + 1}`;
    btn.addEventListener("click", () => { setActiveSpellBar(i); refreshTabActiveClass(); });
    tabsEl.appendChild(btn);
    tabBtns.push(btn);
  }
  function refreshTabActiveClass() {
    const active = getActiveSpellBar();
    for (let i = 0; i < tabBtns.length; i++) {
      tabBtns[i].setAttribute("aria-selected", i === active ? "true" : "false");
    }
  }
  refreshTabActiveClass();
  root.appendChild(tabsEl);

  // ── Spell list (0x10000295 + rope scrollbar 0x10000296) ──────────
  const listEl = document.createElement("div");
  listEl.className = "hbk-scroll hbk-list hb-sb-list";
  listEl.dataset.el = "0x10000295";
  listEl.setAttribute("role", "listbox");
  root.appendChild(listEl);

  // ── Filter box (0x10000297) ─────────────────────────────────────
  const filtersEl = document.createElement("div");
  filtersEl.className = "hb-sb-filters";
  filtersEl.dataset.el = "0x10000297";
  filtersEl.dataset.mode = "spells";
  let filterMask = readFilterMask();

  function filterLabel(text, elId) {
    const l = document.createElement("div");
    l.className = "hb-sb-flabel hb-sb-fsec";
    l.dataset.el = elId;
    setAcText(l, text, { color: "#f3d27a", fontId: COMPACT_FONT_ID });
    return l;
  }
  function filterOption(text, bit, elId) {
    const lbl = document.createElement("label");
    lbl.className = "hb-sb-fopt";
    lbl.dataset.el = elId;
    lbl.dataset.bit = String(bit);
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "hbk-check";
    cb.checked = !!(filterMask & bit);
    cb.addEventListener("change", () => {
      filterMask = cb.checked ? (filterMask | bit) : (filterMask & ~bit);
      writeFilterMask(filterMask);
      listEl.scrollTop = 0; // retail UpdateFilter → ScrollToShow(0)
      rerenderList();
    });
    const t = document.createElement("span");
    setAcText(t, text, { color: "#e8dfc8", fontId: COMPACT_FONT_ID });
    lbl.append(cb, t);
    return lbl;
  }
  const SCHOOL_EL = { 4: "0x10000298", 3: "0x10000299", 2: "0x1000029A", 1: "0x1000029B", 5: "0x100005C0" };
  const LEVEL_EL = { 1: "0x1000029C", 2: "0x1000029D", 3: "0x1000029E", 4: "0x1000029F",
    5: "0x100002A0", 6: "0x100002A1", 7: "0x100002A2", 8: "0x1000054E" };
  filtersEl.appendChild(filterLabel("Schools:", "0x100002A3"));
  const schoolRow = document.createElement("div");
  schoolRow.className = "hb-sb-frow hb-sb-fsec";
  for (const sid of SCHOOL_ORDER) schoolRow.appendChild(filterOption(SCHOOL_NAMES[sid], SCHOOL_BIT[sid], SCHOOL_EL[sid]));
  filtersEl.appendChild(schoolRow);
  filtersEl.appendChild(filterLabel("Levels:", "0x100002A4"));
  const levelRow = document.createElement("div");
  levelRow.className = "hb-sb-frow hb-sb-fsec";
  for (let lv = 1; lv <= 8; lv++) levelRow.appendChild(filterOption(ROMAN[lv], LEVEL_BIT[lv], LEVEL_EL[lv]));
  filtersEl.appendChild(levelRow);

  const actions = document.createElement("div");
  actions.className = "hb-sb-factions";
  const countEl = document.createElement("span");
  countEl.className = "hb-sb-count";
  const compBtn = document.createElement("button");
  compBtn.type = "button";
  compBtn.className = "hbk-btn-small hbk-brown hb-sb-comp-toggle";
  compBtn.textContent = "Components";
  compBtn.title = "Show the spell components you carry";
  // Retail DeleteSpell_Button 0x100002A5 (red 0x06004CDA) + label
  // 0x100002A6 "Delete" — kit hbk-btn is the same sprite family.
  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "hbk-btn hb-sb-delete";
  deleteBtn.dataset.el = "0x100002A5";
  deleteBtn.textContent = "Delete";
  deleteBtn.disabled = true;
  deleteBtn.title = "Remove the selected spell from your spellbook (Delete key)";
  actions.append(countEl, compBtn, deleteBtn);
  filtersEl.appendChild(actions);
  root.appendChild(filtersEl);

  parentEl.appendChild(root);

  let catalog = null;
  let componentNames = null;
  let knownIds = new Set();
  let selectedRowId = 0;
  let mode = "spells"; // or "components"

  // Perf (2026-07-04, @addallspells accounts with ~2,000 spells): only the
  // windowed slice of rows (visible + overscan) exists in the DOM; spacers
  // carry the scroll height of the rest. Rows are a fixed 32 px (retail
  // ItemSlot_SpellbookEntry), so no measuring is needed.
  const ROW_H = 32;
  const OVERSCAN_ROWS = 8;
  const rowMap = new Map(); // id -> { row, meta }
  let filteredIds = [];

  const emptyEl = document.createElement("div");
  emptyEl.className = "hbk-empty hb-sb-empty";
  emptyEl.style.display = "none";
  const topSpacerEl = document.createElement("div");
  topSpacerEl.className = "hb-sb-spacer hb-sb-spacer-top";
  const bottomSpacerEl = document.createElement("div");
  bottomSpacerEl.className = "hb-sb-spacer hb-sb-spacer-bottom";
  listEl.append(emptyEl, topSpacerEl, bottomSpacerEl);

  function computeMeta(id) {
    const meta = catalog ? catalog[String(id)] : null;
    if (meta) return meta;
    return { name: `Spell #${id}`, school: 0, level: 0, untargeted: true, mana: 0, _uncatalogued: true };
  }

  function selectRow(id) {
    selectedRowId = id;
    for (const [rid, slot] of rowMap) {
      const on = rid === id;
      slot.row.classList.toggle("selected", on);
      slot.row.setAttribute("aria-selected", on ? "true" : "false");
    }
    deleteBtn.disabled = !id || mode !== "spells";
  }

  function buildRow(id, meta) {
    const row = document.createElement("div");
    row.className = "hb-sb-row";
    row.dataset.spellId = String(id);
    row.setAttribute("role", "option");
    row.draggable = true;
    row.title = `${meta.name}\nDouble-click: add to spell bar · Drag: place on a bar · Right-click: details`;

    const icon = document.createElement("div");
    icon.className = "hb-sb-icon";
    const iconDid = (meta?.icon >>> 0) || 0;
    const cached = iconDid ? getIconImmediate(iconDid) : null;
    if (cached) icon.style.backgroundImage = `url("${cached}")`;
    else if (iconDid) {
      fetchIconDataUrl(iconDid, "spellbook").then((url) => {
        if (url && icon.isConnected) icon.style.backgroundImage = `url("${url}")`;
      }).catch(() => {});
    }
    const slotNum = document.createElement("span");
    slotNum.className = "hb-sb-slotnum";
    icon.appendChild(slotNum);
    row.appendChild(icon);

    const text = document.createElement("div");
    text.className = "hb-sb-text";
    const name = document.createElement("span");
    name.className = "hb-sb-row-name";
    setAcText(name, meta.name, { color: "#eadfc4", fit: true });
    const sub = document.createElement("div");
    sub.className = "hb-sb-row-sub";
    if (SCHOOL_NAMES[meta.school]) {
      const sch = document.createElement("span");
      sch.className = "hb-sb-school";
      setAcText(sch, SCHOOL_NAMES[meta.school], { color: SCHOOL_TINT[meta.school], fontId: COMPACT_FONT_ID });
      sub.appendChild(sch);
    }
    const metaLine = document.createElement("span");
    metaLine.className = "hb-sb-meta";
    setAcText(metaLine, spellMetaLine(meta), { color: "#a8a090", fontId: COMPACT_FONT_ID, fit: true });
    sub.appendChild(metaLine);
    text.append(name, sub);
    row.appendChild(text);

    row.addEventListener("dragstart", (ev) => {
      // Phase H.5 — drag a spell onto a combat-bar / hotbar slot.
      ev.dataTransfer.effectAllowed = "copy";
      ev.dataTransfer.setData("application/x-hb-spell-id", String(id));
      ev.dataTransfer.setData("text/plain", meta.name);
      try {
        const url = iconDid ? getIconImmediate(iconDid) : null;
        if (url) {
          const img = new Image();
          img.src = url;
          img.width = 32; img.height = 32;
          ev.dataTransfer.setDragImage(img, 16, 16);
        }
      } catch (_) {}
    });
    row.addEventListener("click", () => selectRow(id));
    // gmSpellbookUI::ListenToElementMessage (acclient.c): a double-click
    // (dwParam1 == 10) on a list entry fires
    // CM_Magic::SendNotice_AddSpellShortcut — add to the active spell tab.
    row.addEventListener("dblclick", () => {
      const slot = addToFirstEmptySlot(id);
      console.log(`[spellbook] added ${meta.name} (id=${id}) to slot ${slot}`);
    });
    row.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      const slot = rowMap.get(id);
      showSpellDetail(slot ? slot.meta : meta, ev, componentNames);
    });
    return row;
  }

  function updateWindow() {
    const total = filteredIds.length;
    if (total === 0) {
      for (const [, slot] of rowMap) slot.row.remove();
      rowMap.clear();
      topSpacerEl.style.height = "0px";
      bottomSpacerEl.style.height = "0px";
      return;
    }
    const viewportH = listEl.clientHeight || 224;
    const firstVisible = Math.floor(listEl.scrollTop / ROW_H);
    const visibleCount = Math.ceil(viewportH / ROW_H) + 1;
    const startIdx = Math.max(0, firstVisible - OVERSCAN_ROWS);
    const endIdx = Math.min(total, firstVisible + visibleCount + OVERSCAN_ROWS);
    const windowIds = filteredIds.slice(startIdx, endIdx);
    const windowSet = new Set(windowIds);
    for (const [id, slot] of rowMap) {
      if (!windowSet.has(id)) { slot.row.remove(); rowMap.delete(id); }
    }
    // Shortcut number overlay (retail ItemSlot_Icon_ShortcutNum) for
    // spells on the active bar.
    const barSlots = getSpellBarSlots();
    const slotOf = new Map();
    barSlots.forEach((v, i) => { if (v > 0 && !slotOf.has(v)) slotOf.set(v, i); });
    const frag = document.createDocumentFragment();
    for (const id of windowIds) {
      const meta = computeMeta(id);
      let slot = rowMap.get(id);
      if (!slot) {
        slot = { row: buildRow(id, meta), meta };
        rowMap.set(id, slot);
      } else {
        slot.meta = meta;
      }
      const on = id === selectedRowId;
      slot.row.classList.toggle("selected", on);
      slot.row.setAttribute("aria-selected", on ? "true" : "false");
      const idx = slotOf.get(id);
      slot.row.classList.toggle("on-bar", idx != null);
      const num = slot.row.querySelector(".hb-sb-slotnum");
      if (num) num.textContent = idx != null && idx < 9 ? String(idx + 1) : (idx != null ? "•" : "");
      frag.appendChild(slot.row);
    }
    listEl.insertBefore(frag, bottomSpacerEl);
    topSpacerEl.style.height = `${startIdx * ROW_H}px`;
    bottomSpacerEl.style.height = `${(total - endIdx) * ROW_H}px`;
  }

  let scrollRafPending = false;
  function onListScroll() {
    if (mode !== "spells" || scrollRafPending) return;
    scrollRafPending = true;
    requestAnimationFrame(() => { scrollRafPending = false; updateWindow(); });
  }
  listEl.addEventListener("scroll", onListScroll);

  function setCount(text) {
    setAcText(countEl, text, { color: "#c8bfa8", fontId: COMPACT_FONT_ID, fit: true });
  }

  function rerenderList() {
    if (mode !== "spells") { renderComponents(); return; }
    if (!catalog) {
      filteredIds = [];
      updateWindow();
      emptyEl.textContent = "Loading spells…";
      emptyEl.style.display = "";
      setCount("");
      return;
    }
    const metas = [];
    for (const id of knownIds) {
      const meta = computeMeta(id);
      if (!isSpellFilteredOut(meta, filterMask)) metas.push({ id, meta });
    }
    metas.sort((a, b) => compareSpells(a.meta, b.meta) || a.id - b.id);
    filteredIds = metas.map((m) => m.id);
    if (selectedRowId && !knownIds.has(selectedRowId)) selectRow(0);
    if (filteredIds.length === 0) {
      emptyEl.textContent = knownIds.size === 0
        ? "Your spellbook is empty. Learn spells from scrolls."
        : "No spells match the selected schools and levels.";
      emptyEl.style.display = "";
    } else {
      emptyEl.style.display = "none";
    }
    setCount(knownIds.size
      ? `${filteredIds.length} of ${knownIds.size} spell${knownIds.size === 1 ? "" : "s"}`
      : "");
    updateWindow();
  }

  function refreshKnown({ force = false } = {}) {
    let next = new Set();
    if (client?.player?.knownSpells) {
      try {
        next = new Set(Array.from(client.player.knownSpells() ?? []));
      } catch (e) {
        console.warn("[spellbook] knownSpells failed:", e);
        next = knownIds;
      }
    }
    // playerStatsUpdated fires on every vital tick — skip the re-sort when
    // the known set did not change.
    const same = next.size === knownIds.size && [...next].every((id) => knownIds.has(id));
    knownIds = next;
    if (same && !force) {
      if (mode === "spells") updateWindow(); else rerenderList();
      return;
    }
    rerenderList();
  }

  // ── Components mode (rec #46 component pouch, retail gmSpellComponentUI
  //    0x21000033 lives as a sibling panel; here it shares the list area).
  function componentCounts() {
    if (!componentNames) return null;
    let inv = null;
    try { inv = window.__sessionHandle?.playerInventory?.() ?? null; } catch (_) { return null; }
    const items = inv ? (Array.isArray(inv) ? inv : Array.from(inv)) : [];
    const nameSet = new Set();
    for (const v of Object.values(componentNames)) {
      if (v && typeof v.name === "string") nameSet.add(v.name);
    }
    const counts = new Map();
    for (const it of items) {
      const itName = it?.name;
      if (typeof itName !== "string" || !nameSet.has(itName)) continue;
      counts.set(itName, (counts.get(itName) || 0) + ((it?.stackSize >>> 0) || 1));
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }
  function renderComponents() {
    for (const el of [...listEl.querySelectorAll(".hb-sb-comp-row")]) el.remove();
    const rows = componentCounts();
    if (!rows) {
      emptyEl.textContent = "Loading components…";
      emptyEl.style.display = "";
      setCount("");
      return;
    }
    emptyEl.textContent = "You are not carrying any spell components.";
    emptyEl.style.display = rows.length ? "none" : "";
    setCount(rows.length ? `${rows.length} component type${rows.length === 1 ? "" : "s"}` : "");
    const frag = document.createDocumentFragment();
    for (const [name, n] of rows) {
      const r = document.createElement("div");
      r.className = "hbk-row hb-sb-comp-row";
      const nm = document.createElement("span");
      nm.className = "hbk-grow";
      setAcText(nm, name, { color: "#eadfc4", fit: true });
      const ct = document.createElement("span");
      setAcText(ct, String(n), { color: "#8aef6d" });
      r.append(nm, ct);
      frag.appendChild(r);
    }
    listEl.insertBefore(frag, bottomSpacerEl);
  }
  function setMode(next) {
    mode = next;
    filtersEl.dataset.mode = next;
    compBtn.textContent = next === "spells" ? "Components" : "Spells";
    compBtn.title = next === "spells" ? "Show the spell components you carry" : "Back to the spell list";
    listEl.scrollTop = 0;
    if (next === "spells") {
      for (const el of [...listEl.querySelectorAll(".hb-sb-comp-row")]) el.remove();
    } else {
      filteredIds = [];
      updateWindow();
    }
    deleteBtn.disabled = !selectedRowId || next !== "spells";
    rerenderList();
  }
  compBtn.addEventListener("click", () => setMode(mode === "spells" ? "components" : "spells"));

  rerenderList();
  loadCatalog().then((c) => {
    // Wave F.1 — the JSON catalog wrapped in a Proxy that prefers
    // wasm-decoded SpellBase records once WorldBootstrap is loaded.
    catalog = makeHybridCatalog(c);
    if (root.isConnected) refreshKnown({ force: true });
  });
  loadComponentNames().then((m) => {
    componentNames = m;
    if (root.isConnected && mode === "components") rerenderList();
  });

  // ── Live subscriptions ───────────────────────────────────────────
  let statsRaf = 0;
  const statsHandler = () => {
    if (statsRaf) return;
    statsRaf = requestAnimationFrame(() => {
      statsRaf = 0;
      if (root.isConnected) refreshKnown();
    });
  };
  if (client?.events?.on) client.events.on("playerStatsUpdated", statsHandler);
  const spellbarHandler = () => {
    refreshTabActiveClass();
    if (mode === "spells") updateWindow();
  };
  window.addEventListener("hb-spellbar-changed", spellbarHandler);

  // Phase J.1 — Delete key OR the Delete button removes the selected
  // spell (RemoveSpellFromBook 0x01A8) after a confirmation, like retail
  // gmSpellbookUI::DeleteSpell → DeleteSpellDialogCallback.
  let forgetting = false;
  async function forgetSelected() {
    if (!selectedRowId || forgetting || !root.isConnected || mode !== "spells") return;
    const id = selectedRowId;
    const meta = computeMeta(id);
    forgetting = true;
    let ok = false;
    try { ok = await confirmForget(meta.name); } finally { forgetting = false; }
    if (!ok || !root.isConnected) return;
    try {
      const handle = window.__sessionHandle ?? null;
      if (handle && typeof handle.removeSpellFromBook === "function") {
        handle.removeSpellFromBook(id >>> 0);
      }
    } catch (e) {
      console.warn(`[spellbook] forget(${id}) failed: ${e?.message ?? e}`);
    }
    // Optimistic local refresh; ACE's MagicRemoveSpell lands as a stats
    // refresh and re-pulls knownSpells.
    knownIds.delete(id);
    selectRow(0);
    rerenderList();
  }
  function onDeleteKey(ev) {
    if (!matchesBinding(ev, resolveLocalBinding(LOCAL_ACTION_IDS.DELETE_SPELL, "Delete"))) return;
    if (!selectedRowId) return;
    const tag = ev.target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    void forgetSelected();
  }
  // P-unification (2026-07-28): the forget-spell key is an ACTION on the
  // ONE input funnel — priority 10 puts it ahead of combat-bar's
  // MagicCombat "Previous Spell" (both default to Delete).
  let unbindDeleteKey = null;
  if (inputFunnelV2On()) {
    unbindDeleteKey = getInputFunnel().bindAction(
      LOCAL_ACTION_IDS.DELETE_SPELL,
      "Delete",
      onDeleteKey,
      {
        when: () => !!selectedRowId && mode === "spells",
        priority: 10,
        source: "spellbook",
      },
    );
  } else {
    window.addEventListener("keydown", onDeleteKey);
  }
  deleteBtn.addEventListener("click", () => {
    if (deleteBtn.disabled) return;
    void forgetSelected();
  });

  // Detail card lifecycle — close on outside click or Esc.
  function onPopoverMouseDown(ev) {
    if (openDetail && !openDetail.contains(ev.target)) closeDetail();
  }
  function onPopoverEsc(ev) {
    if (matchesBinding(ev, resolveLocalBinding(LOCAL_ACTION_IDS.CLOSE, "Escape"))) closeDetail();
  }
  window.addEventListener("mousedown", onPopoverMouseDown, true);
  window.addEventListener("keydown", onPopoverEsc);

  return () => {
    if (client?.events?.off) client.events.off("playerStatsUpdated", statsHandler);
    if (statsRaf) cancelAnimationFrame(statsRaf);
    window.removeEventListener("hb-spellbar-changed", spellbarHandler);
    if (unbindDeleteKey) unbindDeleteKey();
    else window.removeEventListener("keydown", onDeleteKey);
    window.removeEventListener("mousedown", onPopoverMouseDown, true);
    window.removeEventListener("keydown", onPopoverEsc);
    listEl.removeEventListener("scroll", onListScroll);
    closeDetail();
    root.remove();
  };
}

export {
  getSpellBarSlots,
  setSpellBarSlot,
  getActiveSpellBar,
  setActiveSpellBar,
  addToFirstEmptySlot,
  SPELL_BAR_SLOTS,
  SPELL_BAR_TABS,
  loadCatalog,
};
