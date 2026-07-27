// Spellbook view — Phase G (catalog + known-spell intersection),
// Phase J (delete-from-spellbook RemoveSpellFromBook 0x01A8 wire round-
// trip + component name table), Phase K (multi-tab spell-bars).
//
// Wave 2 PR-Z refactor 2026-05-22: was an `activate(bodyEl, ctx)`
// bar-plugin slot (📖 icon, F5 hotkey). Now a registered view of
// plugins/main-panel.js — the shared right-side pane. Toggled via the
// S key (and F5 for retail muscle-memory).
//
// Layout-port 2026-05-24: wired retail gmSpellbookUI (LayoutDesc
// 0x21000032, 300×337 inside main-panel's 300×337 body slot) — sizes
// and positions for spell grid, scrollbar, filter panel, school
// checkboxes (War/Life/Item/Creature/Void), level checkboxes I-VIII,
// section labels, and the multi-state action button come from the DAT.
// The 7 numbered spell-bar tabs at top are Holtburger Phase I.2 chrome
// that has no retail analog — kept as-is. School/level checkbox text
// is hand-tuned (v1 fetch_layout serializes geometry only — StateDesc
// + BaseProperty text content is a follow-on).
//
// Element-id map (confirmed by spellbook_layout_dump 2026-05-24):
//   0x10000294 — root panel (300×337)
//   0x10000295 — spell grid area  (0,0)   280×224
//   0x10000296 — right scrollbar  (280,0) 16×224
//   0x10000297 — filter panel     (0,224) 300×113, type=3 (3D bevel)
//     0x100002A3 — "School:" label (12,6)  90×19
//     0x100002A4 — "Level:" label  (12,39) 90×19
//     School row (y=22):
//       0x10000298 War      (17,22) 90×14
//       0x10000299 Life     (87,22)
//       0x1000029A Item    (137,22)
//       0x1000029B Creature(187,22)
//       0x100005C0 Void    (237,22)
//     Level rows (y=55/72/89):
//       0x1000029C I    (17,55) 90×14
//       0x1000029D II   (82,55)
//       0x1000029E III (147,55)
//       0x1000029F IV   (17,72)
//       0x100002A0 V    (82,72)
//       0x100002A1 VI  (147,72)
//       0x100002A2 VII  (17,89)
//       0x1000054E VIII (82,89)
//     0x100002A5 multi-state button (187,61) 100×32, 2 states (Delete/Forget)
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
import { loadLayout, findElementById, getCachedLayout } from "../ui/ac_layout.js";
import { getIconImmediate } from "../ui/ac_icon_cache.js";

// gmSpellbookUI — retail layout that drives the spellbook panel.
// Element-id map confirmed by spellbook_layout_dump 2026-05-24.
const SPELLBOOK_LAYOUT_ID = 0x21000032;
const SB_ELEM_GRID        = 0x10000295;  // spell list / grid area
const SB_ELEM_SCROLLBAR   = 0x10000296;  // right-side scrollbar
const SB_ELEM_FILTERS     = 0x10000297;  // filter panel below grid
const SB_ELEM_LBL_SCHOOL  = 0x100002A3;  // "School:" label
const SB_ELEM_LBL_LEVEL   = 0x100002A4;  // "Level:" label
const SB_ELEM_SCHOOL = {
  1: 0x10000298,  // War
  2: 0x10000299,  // Life
  3: 0x1000029A,  // Item
  4: 0x1000029B,  // Creature
  5: 0x100005C0,  // Void
};
const SB_ELEM_LEVEL = {
  1: 0x1000029C,
  2: 0x1000029D,
  3: 0x1000029E,
  4: 0x1000029F,
  5: 0x100002A0,
  6: 0x100002A1,
  7: 0x100002A2,
  8: 0x1000054E,
};
const SB_ELEM_ACTION_BTN  = 0x100002A5;  // multi-state action button (Delete/Forget)

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

let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = "hb-spellbook-style";
  style.textContent = `
    /* Spellbook view — mounts inside main-panel's body slot (300×337).
       The main-panel owns position/frame/title; we just lay out our
       content inside parentEl. Retail gmSpellbookUI 0x21000032 places
       the spell grid at (0,0) 280×224, the scrollbar at (280,0) 16×224,
       and the filter panel at (0,224) 300×113. We add the Holtburger
       Phase I.2 spell-bar tab strip on top of the grid area.

       NOTE: applySpellbookLayout() overrides per-element x/y/w/h from
       the LayoutDesc — these CSS rules are the fallback when the
       layout fails to load. */
    .hb-sb-root {
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      box-sizing: border-box;
      pointer-events: auto;
      font-family: var(--hb-font-serif);
      color: var(--hb-text-cream);
      overflow: hidden;
    }
    /* Spell-bar tab strip — real DAT 0x06004CDA (passive) /
       0x06004CDB (active) brass-bordered red button textures.
       7 numbered tabs (Phase I.2 — Holtburger chrome above retail's
       spell-grid area). */
    .hb-sb-tabs {
      position: absolute;
      top: 0;
      left: 0;
      right: 16px;
      height: 22px;
      box-sizing: border-box;
      display: flex;
      gap: 2px;
      padding: 4px 4px 0;
      border-bottom: 1px solid var(--hb-border-brass-dim);
    }
    .hb-sb-tab {
      flex: 1;
      height: 18px;
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
    /* Spell list — retail 0x10000295 puts this at (0,0) 280×224.
       We inset top by 22px to clear the Holtburger Phase I.2 tab strip,
       and right by 0 (the scrollbar 0x10000296 sits at x=280, our
       browser-managed scrollbar collapses into the same column). */
    .hb-sb-list {
      position: absolute;
      top: 22px;
      left: 0;
      width: 280px;
      height: 202px;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      gap: 2px;
      overflow-y: auto;
      padding: 4px 4px;
      scrollbar-width: thin;
      scrollbar-color: var(--hb-border-brass) rgba(0, 0, 0, 0.5);
    }
    /* Scrollbar element — retail 0x10000296 (280,0) 16×224. We let the
       browser render the actual scrollbar inside .hb-sb-list (scrollbar-
       width: thin) and surface this as a decorative brass-trim slot so
       the layout-port verifier can confirm the slot's geometry. */
    .hb-sb-scrollbar {
      position: absolute;
      top: 22px;
      left: 280px;
      width: 16px;
      height: 202px;
      box-sizing: border-box;
      border-left: 1px solid var(--hb-border-brass-dim);
      background: rgba(0, 0, 0, 0.4);
      pointer-events: none;
    }
    /* Filter panel — retail 0x10000297 (0,224) 300×113, type=3 (3D bevel).
       Uses DAT 0x06002722 as a dark stone backdrop. Sub-elements
       (school/level checkboxes, labels, action button) are positioned
       absolutely inside via applySpellbookLayout(). */
    .hb-sb-filters-band {
      position: absolute;
      top: 224px;
      left: 0;
      width: 300px;
      height: 113px;
      box-sizing: border-box;
      padding: 0;
      background: url("./data/ui-sprites/0x06002722.png") center/cover no-repeat;
      border-top: 1px solid var(--hb-border-brass);
    }
    /* Component pouch — rec #46. Compact 2-column strip below the
       filter band showing the player's component counts. Display
       toggled in JS based on inventory snapshot. */
    .hb-sb-components {
      position: absolute;
      top: 337px;
      left: 0;
      width: 300px;
      max-height: 70px;
      box-sizing: border-box;
      padding: 4px 6px;
      background: rgba(10, 6, 2, 0.72);
      border-top: 1px solid var(--hb-border-brass-dim);
      font-family: var(--hb-font-serif);
      font-size: 10px;
      color: var(--hb-text-cream);
      overflow-y: auto;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1px 8px;
    }
    .hb-sb-comp-row {
      display: flex;
      justify-content: space-between;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .hb-sb-comp-row .name { color: var(--hb-text-muted-2, #b0a080); }
    .hb-sb-comp-row .count { color: var(--hb-text-gold, #d4af37); margin-left: 6px; }
    .hb-sb-filter-label {
      position: absolute;
      width: 90px;
      height: 19px;
      box-sizing: border-box;
      font-size: 11px;
      font-family: var(--hb-font-serif);
      color: var(--hb-text-gold);
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.9);
      letter-spacing: 0.04em;
      pointer-events: none;
      display: flex;
      align-items: center;
    }
    .hb-sb-filter-cb {
      position: absolute;
      width: 90px;
      height: 14px;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      gap: 3px;
      font-size: 10px;
      color: var(--hb-text-cream-bright);
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.9);
      cursor: pointer;
      pointer-events: auto;
    }
    .hb-sb-filter-cb input[type="checkbox"] {
      width: 10px;
      height: 10px;
      accent-color: var(--hb-text-gold);
      margin: 0;
    }
    /* Retail-parity brass toggle — replaces the native browser
       checkbox with a 10×10 brass-bordered button that paints filled
       (gold sprite) when on / dim when off. CSS-only — no DAT
       extraction needed because the spellbook's own sprite-set is the
       same brass-trim used by .hb-sb-action-btn. */
    body[data-retail-parity="1"] .hb-sb-filter-cb input[type="checkbox"] {
      appearance: none;
      -webkit-appearance: none;
      width: 10px;
      height: 10px;
      box-sizing: border-box;
      background: rgba(0, 0, 0, 0.55);
      border: 1px solid var(--hb-border-brass-dim);
      cursor: pointer;
      position: relative;
      padding: 0;
      transition: background 80ms ease, border-color 80ms ease;
    }
    body[data-retail-parity="1"] .hb-sb-filter-cb input[type="checkbox"]:hover {
      border-color: var(--hb-border-brass);
    }
    body[data-retail-parity="1"] .hb-sb-filter-cb input[type="checkbox"]:checked {
      background: var(--hb-text-gold);
      border-color: var(--hb-text-gold);
      box-shadow: 0 0 2px rgba(255, 220, 120, 0.55) inset;
    }
    body[data-retail-parity="1"] .hb-sb-filter-cb input[type="checkbox"]:checked::after {
      content: "";
      position: absolute;
      inset: 1px;
      background: linear-gradient(135deg,
        var(--hb-bg-stone-bottom) 0%,
        var(--hb-text-gold) 50%,
        var(--hb-bg-stone-top) 100%);
    }
    /* Multi-state action button — retail 0x100002A5 (187,61) 100×32.
       2 states (idle / hover-or-disabled). Used as "Forget Spell"
       trigger for the currently-selected row (Phase J.1 wire — was
       previously bound to the Delete key only). */
    .hb-sb-action-btn {
      position: absolute;
      width: 100px;
      height: 32px;
      box-sizing: border-box;
      font-family: var(--hb-font-serif);
      font-size: 10px;
      font-weight: 600;
      color: var(--hb-text-gold);
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.95);
      background: url("./data/ui-sprites/0x06004CDA.png") center/100% 100% no-repeat;
      border: none;
      cursor: pointer;
      user-select: none;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      pointer-events: auto;
    }
    .hb-sb-action-btn:hover {
      background: url("./data/ui-sprites/0x06004CDB.png") center/100% 100% no-repeat;
      color: var(--hb-text-cream-bright);
    }
    .hb-sb-action-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      filter: grayscale(0.6);
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
  // Mana Conversion note (Task C step 3, 2026-07-01): the listed cost
  // is BaseMana; when the player has Mana Conversion trained+ and the
  // spell doesn't carry SpellFlags.IgnoresManaConversion, ACE rolls a
  // per-cast reduction (Creature_Magic.cs GetManaCost) — annotate
  // rather than fake an exact number. skills[] layout is the flat
  // [id, current, base, trained_state, xp] × N (character-info.js);
  // ManaConversion = 16, Trained = 2.
  let manaNote = "";
  try {
    const skills = window.__sessionHandle?.playerStats?.()?.skills;
    if (skills && skills.length && !(meta?.flags?.ignoresManaConv === true)) {
      for (let s = 0; s + 4 < skills.length; s += 5) {
        if (skills[s] === 16) {
          if (skills[s + 3] >= 2) manaNote = " (Mana Conv. may reduce)";
          break;
        }
      }
    }
  } catch (_) {}
  setAcText(
    meta_str,
    `${schoolName} · Level ${meta.level} · ${meta.mana} mana${manaNote}${durStr}` +
      (meta.untargeted ? " · self-cast" : " · targeted"),
  );
  el.appendChild(meta_str);

  if (meta.desc) {
    const desc = document.createElement("div");
    desc.className = "hb-sb-detail-desc";
    setAcText(desc, meta.desc);
    el.appendChild(desc);
  }

  // Wave F.1 follow-on (2026-05-27) — SpellCategoryDB name lookup.
  // Shows the stacking-group name (e.g. "StrengthRaising") so the
  // player can see at a glance which spells conflict for the
  // refresh-overwrites-existing-buff rule.
  if (meta.category != null && typeof window?.getSpellCategoryName === "function") {
    try {
      const catName = window.getSpellCategoryName(meta.category >>> 0);
      if (catName) {
        const catRow = document.createElement("div");
        catRow.className = "hb-sb-detail-meta";
        setAcText(catRow, `Category: ${catName} (#${meta.category})`);
        el.appendChild(catRow);
      }
    } catch (_) {}
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

// Apply gmSpellbookUI 0x21000032 layout to the spellbook plugin's
// sub-elements. Each ref gets explicit left/top/width/height from the
// LayoutDesc. School/level checkbox labels stay hand-tuned (v1
// fetch_layout serializes geometry only — StateDesc/BaseProperty text
// content is a follow-on).
//
// The spellbook view mounts via user-initiated showView("spellbook")
// AFTER wasm is ready, so no retry loop is needed (unlike radar /
// chat-panel which mount during early boot). The cached-layout fast
// path keeps re-opens synchronous.
function applySpellbookLayout(refs) {
  const apply = (layout) => {
    if (!layout) return;
    let applied = 0;
    const pairs = [
      [SB_ELEM_GRID,       refs.listEl],
      [SB_ELEM_SCROLLBAR,  refs.scrollbarEl],
      [SB_ELEM_FILTERS,    refs.filtersBandEl],
    ];
    for (const [id, el] of pairs) {
      if (!el) continue;
      const desc = findElementById(layout, id);
      if (!desc) continue;
      // Clear CSS `right`/`bottom` anchors that fight explicit positions.
      el.style.right = "";
      el.style.bottom = "";
      if (typeof desc.x === "number") el.style.left = `${desc.x}px`;
      if (typeof desc.y === "number") el.style.top = `${desc.y}px`;
      if (typeof desc.width === "number") el.style.width = `${desc.width}px`;
      if (typeof desc.height === "number") el.style.height = `${desc.height}px`;
      applied += 1;
    }

    // Filter-panel children (school + level checkboxes, labels, action
    // button) live INSIDE filtersBandEl whose position is `(0,224)`.
    // Their layout x/y is relative to that parent — applyBoxRelative
    // sets explicit left/top/width/height. Box-sizing: border-box on
    // the targets keeps the row baseline aligned with the layout grid.
    const labelPairs = [
      [SB_ELEM_LBL_SCHOOL, refs.lblSchoolEl],
      [SB_ELEM_LBL_LEVEL,  refs.lblLevelEl],
    ];
    for (const [id, el] of labelPairs) {
      if (!el) continue;
      const desc = findElementById(layout, id);
      if (!desc) continue;
      applyBoxRelative(el, desc);
      applied += 1;
    }
    for (const [sid, cbEl] of Object.entries(refs.schoolCbEls)) {
      const elemId = SB_ELEM_SCHOOL[Number(sid)];
      if (!elemId || !cbEl) continue;
      const desc = findElementById(layout, elemId);
      if (!desc) continue;
      applyBoxRelative(cbEl, desc);
      applied += 1;
    }
    for (const [lv, cbEl] of Object.entries(refs.levelCbEls)) {
      const elemId = SB_ELEM_LEVEL[Number(lv)];
      if (!elemId || !cbEl) continue;
      const desc = findElementById(layout, elemId);
      if (!desc) continue;
      applyBoxRelative(cbEl, desc);
      applied += 1;
    }
    if (refs.actionBtnEl) {
      const desc = findElementById(layout, SB_ELEM_ACTION_BTN);
      if (desc) {
        applyBoxRelative(refs.actionBtnEl, desc);
        applied += 1;
      }
    }

    try {
      window.__diag?.layout?.onSpellbookApplied?.({ applied });
    } catch (_) {}
  };
  const cached = getCachedLayout(SPELLBOOK_LAYOUT_ID);
  if (cached) { apply(cached); return; }
  loadLayout(SPELLBOOK_LAYOUT_ID).then(apply).catch(() => {});
}

function applyBoxRelative(el, layoutEl) {
  el.style.right = "";
  el.style.bottom = "";
  if (typeof layoutEl.x === "number") el.style.left = `${layoutEl.x}px`;
  if (typeof layoutEl.y === "number") el.style.top = `${layoutEl.y}px`;
  if (typeof layoutEl.width === "number") el.style.width = `${layoutEl.width}px`;
  if (typeof layoutEl.height === "number") el.style.height = `${layoutEl.height}px`;
}

function doMount(parentEl, ctx) {
  ensureStyles();
  const client = ctx?.client ?? window.__pluginClient ?? null;

  const root = document.createElement("div");
  root.className = "hb-sb-root";

  // ── Spell-bar tab strip (Phase I.2 — Holtburger chrome, no retail
  //    analog in gmSpellbookUI 0x21000032) ────────────────────────
  // 7 numbered tabs. Clicking a tab activates it so the magic
  // combat-bar mirrors that tab's slots. Highlighting follows.
  // P3-42 (cross-find SB-01): retail-parity (DEFAULT-ON — `!== "off"`
  // reader) hides this strip; `?retailParity=off` shows it — retail's
  // spellbook has no 7-bar tab selector. The slot data persistence stays in place; SPELL_BAR_TABS
  // can still be cycled via combat-bar.js shortcuts.
  const retailParity = (() => {
    try { return new URLSearchParams(window.location.search).get("retailParity") !== "off"; }
    catch (_) { return false; }
  })();
  const tabsEl = document.createElement("div");
  tabsEl.className = "hb-sb-tabs";
  if (retailParity) tabsEl.style.display = "none";
  // P3-44 (cross-find SB brass toggle) — flip a body data-attr so the
  // sprite-style filter checkbox CSS rules above kick in only when
  // retail parity is enabled.
  if (retailParity) {
    try { document.body.dataset.retailParity = "1"; } catch (_) {}
  }
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

  // ── List (retail 0x10000295) ──────────────────────────────────
  const listEl = document.createElement("div");
  listEl.className = "hb-sb-list";
  root.appendChild(listEl);

  // ── Scrollbar slot (retail 0x10000296, decorative) ────────────
  const scrollbarEl = document.createElement("div");
  scrollbarEl.className = "hb-sb-scrollbar";
  root.appendChild(scrollbarEl);

  // ── Filter band (retail 0x10000297) — school + level checkboxes,
  //    section labels, and multi-state action button. Sub-elements
  //    positioned absolutely from their LayoutDesc x/y. ───────────
  const filtersBand = document.createElement("div");
  filtersBand.className = "hb-sb-filters-band";

  const filters = {
    schools: new Set([1, 2, 3, 4, 5]),
    levels: new Set([1, 2, 3, 4, 5, 6, 7, 8]),
  };

  // Section labels.
  const lblSchoolEl = document.createElement("div");
  lblSchoolEl.className = "hb-sb-filter-label";
  setAcText(lblSchoolEl, "School:", { color: "#f0d8a0" });
  filtersBand.appendChild(lblSchoolEl);

  const lblLevelEl = document.createElement("div");
  lblLevelEl.className = "hb-sb-filter-label";
  setAcText(lblLevelEl, "Level:", { color: "#f0d8a0" });
  filtersBand.appendChild(lblLevelEl);

  // School checkboxes — 5 of them (War/Life/Item/Creature/Void).
  const schoolCbEls = {};
  for (const sid of [1, 2, 3, 4, 5]) {
    const lbl = document.createElement("label");
    lbl.className = "hb-sb-filter-cb";
    lbl.dataset.schoolId = String(sid);
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
    filtersBand.appendChild(lbl);
    schoolCbEls[sid] = lbl;
  }

  // Level checkboxes — Phase H.3 — I-VIII.
  const levelCbEls = {};
  const ROMAN = { 1: "I", 2: "II", 3: "III", 4: "IV", 5: "V", 6: "VI", 7: "VII", 8: "VIII" };
  for (const lv of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const lbl = document.createElement("label");
    lbl.className = "hb-sb-filter-cb";
    lbl.dataset.levelId = String(lv);
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
    filtersBand.appendChild(lbl);
    levelCbEls[lv] = lbl;
  }

  // Multi-state action button — retail 0x100002A5 "Forget Spell".
  // Disabled unless a row is selected.
  const actionBtnEl = document.createElement("button");
  actionBtnEl.type = "button";
  actionBtnEl.className = "hb-sb-action-btn";
  setAcText(actionBtnEl, "Forget", { color: "#f0d8a0" });
  actionBtnEl.disabled = true;
  actionBtnEl.title = "Remove the selected spell from your spellbook (also: Delete key)";
  filtersBand.appendChild(actionBtnEl);

  root.appendChild(filtersBand);

  // Rec #46 — component-pouch widget (retail gmSpellbookUI lower-left).
  // Compact two-column strip of "Component: N" rows for any spell
  // component the player carries. Refreshed each playerStatsUpdated;
  // hidden when the inventory snapshot has no components.
  const componentPouchEl = document.createElement("div");
  componentPouchEl.className = "hb-sb-components";
  componentPouchEl.style.display = "none";
  root.appendChild(componentPouchEl);

  parentEl.appendChild(root);

  // Apply retail layout AFTER elements are in the DOM so any future
  // relative-anchor logic (none in spellbook v1, but mirrors the
  // inventory port's pattern) can read computed styles.
  applySpellbookLayout({
    listEl,
    scrollbarEl,
    filtersBandEl: filtersBand,
    lblSchoolEl,
    lblLevelEl,
    schoolCbEls,
    levelCbEls,
    actionBtnEl,
  });

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
  //
  // Perf fix (2026-07-04, spellbook hang on @addallspells accounts) —
  // `rowMap` used to hold one built row per KNOWN spell (all of them,
  // simultaneously, in the DOM). On a Developer-account test character
  // with ~2,000+ known spells that meant ~2,000 wasm lookups (now moot,
  // see spellRecordCache above) PLUS ~6,000 synchronous <ac-text>
  // canvas rasters (3 per row) in one microtask — a multi-minute
  // freeze. `rowMap` now only ever holds rows for the currently
  // *windowed* (visible + overscan) slice of the filtered id list;
  // everything else is represented purely as an id in `filteredIds`
  // and re-materialized into a row on demand as the user scrolls.
  // Retail's own gmSpellbookUI (0x10000295, 280×224 with a real
  // scrollbar 0x10000296) only ever paints the rows that fit its fixed
  // grid area per frame — this mirrors that behavior instead of
  // retail's "build everything up front" anti-pattern.
  const rowMap = new Map(); // id (number) -> { row, meta } — WINDOWED rows only
  let filteredIds = []; // full filtered/sorted id list, recomputed by rerenderList()
  let rowHeight = 0; // measured from the first built row; 0 = not yet measured
  const ROW_HEIGHT_FALLBACK = 28; // px incl. the 2px `gap` — matches .hb-sb-row's
                                  // padding/border/font-size until we can measure
  const LIST_ROW_GAP = 2; // must match `.hb-sb-list { gap: 2px; }` above
  const OVERSCAN_ROWS = 10;

  const emptyEl = document.createElement("div");
  emptyEl.className = "hb-sb-empty";
  emptyEl.style.display = "none";
  listEl.appendChild(emptyEl);

  // Spacers hold the scroll-height contributed by rows that are NOT
  // currently built, so `.hb-sb-list`'s native scrollbar stays the
  // correct length even though only a small window of rows exists in
  // the DOM at any time. Real rows are always kept between these two.
  const topSpacerEl = document.createElement("div");
  topSpacerEl.className = "hb-sb-spacer hb-sb-spacer-top";
  topSpacerEl.style.flex = "0 0 auto";
  topSpacerEl.style.height = "0px";
  listEl.appendChild(topSpacerEl);
  const bottomSpacerEl = document.createElement("div");
  bottomSpacerEl.className = "hb-sb-spacer hb-sb-spacer-bottom";
  bottomSpacerEl.style.flex = "0 0 auto";
  bottomSpacerEl.style.height = "0px";
  listEl.appendChild(bottomSpacerEl);

  // Uncatalogued-spell placeholder + filter-pass helpers — pulled out
  // of rerenderList so updateWindow() can build/refresh a row's meta
  // on demand (scrolled-out rows aren't recomputed until they scroll
  // back into the window).
  function computeMeta(id) {
    const meta = catalog ? catalog[String(id)] : null;
    if (meta) return meta;
    // Uncatalogued (neither wasm DAT nor JSON has a record): show a
    // placeholder so the user knows they've learned the spell.
    return {
      name: `Spell #${id}`,
      school: 0,
      level: 0,
      untargeted: true,
      mana: 0,
      _uncatalogued: true,
    };
  }
  function passesFilters(meta) {
    // Uncatalogued placeholders bypass school/level (school=0/level=0
    // wouldn't match any active filter set).
    return meta._uncatalogued
      ? true
      : (filters.schools.has(meta.school) && filters.levels.has(meta.level));
  }

  function buildRow(id, meta) {
    const row = document.createElement("div");
    row.className = "hb-sb-row";
    row.dataset.spellId = String(id);
    row.draggable = true;
    row.title = `${meta.name} — ${meta.untargeted ? "self-cast" : "targeted"}, ${meta.mana} mana, lvl ${meta.level}`;
    row.addEventListener("dragstart", (ev) => {
      // Phase H.5 — drag spell to populate a combat-bar slot.
      ev.dataTransfer.effectAllowed = "copy";
      ev.dataTransfer.setData("application/x-hb-spell-id", String(id));
      ev.dataTransfer.setData("text/plain", meta.name);
      // Wave C / PR9 (2026-06-06): icon-driven Image ghost so the drag
      // cursor reads as the spell icon. Source: meta.icon (the coerced
      // wasm/JSON record's icon-DID field — see spellRecordFromWasm
      // above, which maps raw.iconId -> record.icon) routed through
      // the icon cache.
      //
      // Fix (2026-07-04): this previously called a nonexistent
      // `window.__iconCache.getUrl` (no such global is ever set — see
      // ac_icon_cache.js, which exports named functions instead) AND
      // read the wrong field (`meta.iconId`, which is undefined on the
      // coerced record; the real field is `meta.icon`), so the guard
      // always short-circuited and drag ghosts silently never
      // rendered. Use the real synchronous API — getIconImmediate
      // returns a cached data-URL or null without kicking off a fetch,
      // so this stays cheap even when the icon hasn't been decoded
      // yet (fails soft: no ghost image, drag still works).
      try {
        const iconDid = (meta?.icon >>> 0) || 0;
        const url = iconDid ? getIconImmediate(iconDid) : null;
        if (url) {
          const img = new Image();
          img.src = url;
          img.width = 32; img.height = 32;
          ev.dataTransfer.setDragImage(img, 16, 16);
        }
      } catch (_) {}
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
      // Enable the multi-state action button now that a row is picked
      // (retail 0x100002A5 'Forget Spell').
      actionBtnEl.disabled = false;
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

  // Rebuild/refresh the small window of rows that actually intersect
  // the `.hb-sb-list` viewport (+ OVERSCAN_ROWS above/below), sizing
  // the top/bottom spacers so the scrollbar length still reflects the
  // FULL `filteredIds` count. Called by rerenderList() (filters/known-
  // spells changed) and by the rAF-throttled scroll listener (position
  // changed only). Cheap either way — bounded by window size, not N.
  function updateWindow() {
    const total = filteredIds.length;
    if (total === 0) {
      for (const [, slot] of rowMap) slot.row.remove();
      rowMap.clear();
      topSpacerEl.style.height = "0px";
      bottomSpacerEl.style.height = "0px";
      return;
    }

    const rh = rowHeight || ROW_HEIGHT_FALLBACK;
    const viewportH = listEl.clientHeight || 202;
    const scrollTop = listEl.scrollTop;
    const firstVisible = Math.floor(scrollTop / rh);
    const visibleCount = Math.ceil(viewportH / rh) + 1;
    const startIdx = Math.max(0, firstVisible - OVERSCAN_ROWS);
    const endIdx = Math.min(total, firstVisible + visibleCount + OVERSCAN_ROWS);

    // Drop rows that fell out of the window (or out of filteredIds
    // entirely — same diffing path covers both a scroll and a
    // filter/known-spells change).
    const windowIds = filteredIds.slice(startIdx, endIdx);
    const windowSet = new Set(windowIds);
    for (const [id, slot] of rowMap) {
      if (!windowSet.has(id)) {
        slot.row.remove();
        rowMap.delete(id);
      }
    }

    // `slotsNow` reflects the active spell-bar tab's on-bar highlight.
    const slotsNow = new Set(getSpellBarSlots().filter((v) => v > 0));

    // Build any rows newly entering the window; refresh meta + selected/
    // on-bar state on ones that were already built. Re-append in the
    // fragment in id order so DOM order always matches list order
    // regardless of scroll direction.
    const frag = document.createDocumentFragment();
    for (const id of windowIds) {
      const meta = computeMeta(id);
      let slot = rowMap.get(id);
      if (!slot) {
        const row = buildRow(id, meta);
        slot = { row, meta };
        rowMap.set(id, slot);
      } else {
        slot.meta = meta;
      }
      const { row } = slot;
      row.classList.toggle("selected", id === selectedRowId);
      row.classList.toggle("on-bar", slotsNow.has(id));
      frag.appendChild(row); // moves if already in listEl
    }
    listEl.insertBefore(frag, bottomSpacerEl);

    topSpacerEl.style.height = `${startIdx * rh}px`;
    bottomSpacerEl.style.height = `${(total - endIdx) * rh}px`;

    // Measure the real row height off the first built row once, then
    // re-run with the corrected height so the window range + spacer
    // sizes aren't left keyed off the fallback estimate. Guarded by
    // `rowHeight` being nonzero on the second pass so this can't loop.
    if (!rowHeight) {
      const anyRow = rowMap.values().next().value?.row;
      const measured = anyRow ? anyRow.getBoundingClientRect().height : 0;
      if (measured > 0) {
        rowHeight = measured + LIST_ROW_GAP;
        updateWindow();
      }
    }
  }

  let scrollRafPending = false;
  function onListScroll() {
    if (scrollRafPending) return;
    scrollRafPending = true;
    requestAnimationFrame(() => {
      scrollRafPending = false;
      updateWindow();
    });
  }
  listEl.addEventListener("scroll", onListScroll);

  function rerenderList() {
    if (!catalog) {
      // Loading state — tear down any built rows + show the loader.
      filteredIds = [];
      updateWindow();
      setAcText(emptyEl, "Loading spell catalog…");
      emptyEl.style.display = "";
      return;
    }

    // Materialize the filtered id list from the player's known-spells
    // set. Wave F.1: we no longer iterate `Object.entries(catalog)` —
    // the wasm-record overlay isn't enumerable, and the JSON catalog
    // has ~6,266 entries we don't want to scan. Instead, look up each
    // known spell ID directly against the hybrid catalog (Proxy
    // handles wasm preference + JSON fallback; memoized per spellId
    // via spellRecordCache, so this is O(knownIds) cheap lookups, not
    // O(knownIds) wasm crossings). Order follows `knownIds`' insertion
    // order, same as the pre-virtualization DOM order.
    filteredIds = [];
    for (const id of knownIds) {
      const meta = computeMeta(id);
      if (passesFilters(meta)) filteredIds.push(id);
    }

    // Empty-state message.
    if (filteredIds.length === 0) {
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

    // Build/refresh only the rows intersecting the current scroll
    // window (+ overscan) — see updateWindow() above. This is the fix
    // for the multi-minute freeze on @addallspells accounts: instead
    // of ~2,000+ rows (each 3 synchronous <ac-text> canvas rasters),
    // only the ~15-25 rows that fit the 202px-tall .hb-sb-list plus a
    // small overscan margin are ever built at once.
    updateWindow();
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
    // Wave F.1 — wrap the legacy JSON catalog in a Proxy that prefers
    // wasm-decoded SpellBase records when available (post-EnteredWorld
    // with WorldBootstrap loaded). Falls back to the JSON catalog for
    // pre-login UI states and for spells the SpellTable doesn't have.
    catalog = makeHybridCatalog(c);
    refreshKnown();
  });
  // Phase J.2 — fetch component names in parallel.
  loadComponentNames().then((m) => {
    componentNames = m;
    // Rec #46: as soon as the component table lands, populate the
    // pouch strip — playerStatsUpdated may already have fired before
    // the catalog load completed.
    try { refreshComponentPouch(); } catch (_) {}
  });

  // Rec #46 — sum the player's spell-component stacks and render
  // them into componentPouchEl. Matches inventory items to
  // components by name; the spell-components.json table carries the
  // canonical retail name for each id. Hidden when no components.
  function refreshComponentPouch() {
    const el = componentPouchEl;
    if (!el || !componentNames) return;
    let inv = null;
    try {
      const handle = window.__sessionHandle;
      if (typeof handle?.playerInventory === "function") {
        inv = handle.playerInventory();
      }
    } catch (_) { return; }
    if (!inv || (Array.isArray(inv) && inv.length === 0)) {
      el.style.display = "none";
      return;
    }
    const items = Array.isArray(inv) ? inv : Array.from(inv);
    const nameSet = new Set();
    for (const v of Object.values(componentNames)) {
      if (v && typeof v.name === "string") nameSet.add(v.name);
    }
    if (nameSet.size === 0) {
      el.style.display = "none";
      return;
    }
    const counts = new Map();
    for (const it of items) {
      const itName = it?.name;
      if (typeof itName !== "string" || !nameSet.has(itName)) continue;
      const stack = (it?.stackSize >>> 0) || 1;
      counts.set(itName, (counts.get(itName) || 0) + stack);
    }
    while (el.firstChild) el.removeChild(el.firstChild);
    if (counts.size === 0) {
      el.style.display = "none";
      return;
    }
    el.style.display = "grid";
    // Sort by descending count, then name — keeps the pyreal pile
    // at the top where retail users expect it.
    const rows = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    for (const [name, n] of rows) {
      const row = document.createElement("div");
      row.className = "hb-sb-comp-row";
      const nameEl = document.createElement("span");
      nameEl.className = "name";
      setAcText(nameEl, name);
      const countEl = document.createElement("span");
      countEl.className = "count";
      setAcText(countEl, String(n));
      row.appendChild(nameEl);
      row.appendChild(countEl);
      el.appendChild(row);
    }
  }

  // ── Live subscriptions ─────────────────────────────────────────
  let statsHandler = null;
  if (client?.events?.on) {
    statsHandler = () => {
      refreshKnown();
      try { refreshComponentPouch(); } catch (_) {}
    };
    client.events.on("playerStatsUpdated", statsHandler);
  }
  const spellbarHandler = () => {
    refreshTabActiveClass();
    rerenderList();
  };
  window.addEventListener("hb-spellbar-changed", spellbarHandler);

  // Phase J.1 — Delete key OR multi-state action button removes the
  // currently-selected spell from the spellbook. Confirms first so a
  // stray click/keypress doesn't lose the spell.
  function forgetSelected() {
    if (!selectedRowId) return;
    if (!root.isConnected) return; // panel closed
    // P3-42 (cross-find SB-08): retail confirms via a brass-themed
    // ConfirmationResponse dialog (opcode 0x0275), not the browser
    // chrome window.confirm(). Until the ConfirmationResponse path
    // is wired, fall back to window.confirm() so the player has at
    // least one stop-sign before an irreversible drop (HUD rec #33).
    if (typeof window !== "undefined" && typeof window.confirm === "function") {
      if (!window.confirm("Forget this spell? This action cannot be undone.")) return;
    }
    try {
      const handle = window.__sessionHandle ?? null;
      if (handle && typeof handle.removeSpellFromBook === "function") {
        handle.removeSpellFromBook(selectedRowId >>> 0);
      }
    } catch (e) {
      console.warn(`[spellbook] forget(${selectedRowId}) failed: ${e?.message ?? e}`);
    }
    // Optimistic local refresh; ACE will broadcast MagicRemoveSpell
    // which lands as a stats refresh and re-pulls knownSpells.
    knownIds.delete(selectedRowId);
    selectedRowId = 0;
    actionBtnEl.disabled = true;
    rerenderList();
  }
  function onDeleteKey(ev) {
    if (!matchesBinding(ev, resolveLocalBinding(LOCAL_ACTION_IDS.DELETE_SPELL, "Delete"))) return;
    if (!selectedRowId) return;
    // Skip if user is typing in an input/textarea elsewhere.
    const tag = ev.target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    forgetSelected();
  }
  window.addEventListener("keydown", onDeleteKey);
  actionBtnEl.addEventListener("click", () => {
    if (actionBtnEl.disabled) return;
    forgetSelected();
  });

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
