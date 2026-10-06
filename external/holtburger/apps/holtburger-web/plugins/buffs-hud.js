// =============================================================================
// Buffs / debuffs / cooldowns HUD — Wave F.2 (2026-05-27)
// =============================================================================
//
// Renders the local player's active enchantments + shared cooldowns as a
// strip of icon cells. Pre-Wave-F.2 this was a name-keyword-heuristic
// stub blocked on the wasm payload not carrying the `StatMod` tuple
// (`type` / `statKey` / `statValue`). Wave F.2 extends
// `PlayerEnchantmentJs` to surface the full tuple, which:
//   1. Lets PR 4's `Character.applyEnchantment` cooldown discriminator
//      (`Character.cs:619`, `type & 0x1000000`) route real wire data
//      (previously only worked on synthetic test payloads).
//   2. Lets us color buffs vs debuffs — primarily via the spell record's
//      own `isBeneficial` bit (retail's actual discriminator, see A3 fix
//      below), falling back to the `EnchantmentTypeFlags.BENEFICIAL` bit
//      (0x2000000) from the wire when no spell record is available,
//      replacing the brittle name-keyword heuristic.
//   3. Lets us show "+10 STR" / "-5 STR" tooltips from `statKey` + `statValue`.
//
// Architecture:
//   - Subscribes to `client.world` enchantment events (PR 4: emit deltas)
//     OR falls back to polling `client.character.allEnchantments` on
//     `playerStatsUpdated`.
//   - Renders three logical groups: buffs, debuffs, cooldowns. The
//     status-indicators plugin's two indicator icons (Beneficial /
//     Harmful) drive a filter toggle that shows only that group.
//   - Tiebreak: when `client.character` is present we use
//     `getActiveEnchantments()` which honors the Character.cs:232-239
//     tiebreak (Power desc → Level8AuraSelfSpells → set-spells beat
//     non-set → SpellId desc within set, StartTime desc within non-set).
//     Fallback path (no Character) iterates the wasm snapshot directly.
//
// Icons + names: prefers `wasm.getSpellRecord(spellId)` (Wave F.1 — byte-
// correct retail spell record from `client_portal.dat`). Falls back to
// `data/spells-catalog.json` pre-login.
//
// Citations:
//   - `Enchantment.cs:NN` references `external/chorizite/ACPlugin/API/Enchantment.cs`
//   - `Character.cs:NN` references `external/chorizite/ACPlugin/API/WorldObjects/Character.cs`
//   - handoff §3 refs `external/holtburger/docs/chorizite-reading-guide-summary-2026-05-27.md` §3
//
// Wave F.2 file layout:
//   - Module top: constants (EnchantmentTypeFlags + STAT_KEY_TO_NAME tables)
//   - Classification: `classifyEnchantment(ench)` returns 'buff'|'debuff'|'cooldown'
//   - Stat-mod formatting: `formatStatMod(ench)` returns "+10 STR" / "x1.25 STR" / ...
//   - Render (HUD overhaul 2026-10-05): `buildOverlay()` builds the floaty
//     (tab strip Positive/Negative/Cooldowns + icon grid + kit tooltip);
//     `renderAll()` keyed-reconciles one cell per (kind, layeredId)
//   - Mount: subscribes to events, exposes `__buffsHudToggle` / `__buffsHudClose`
// =============================================================================

import { fetchIconDataUrl as fetchIconDataUrlShared } from "../ui/ac_icon_cache.js";
import { clearPlaceholderGlyph } from "../ui/ac_html.js";
import { attachWindowPosition, WINDOW_ID } from "../ui/ac_window_position.js";
import { ETF } from "../ui/enchantment_constants.js";

const OVERLAY_ID = "hb-buffs-hud";
const STYLE_ID = "hb-buffs-hud-style";

// Rec #174 — EnchantmentTypeFlags moved to ui/enchantment_constants.js
// so buffs-hud + status-indicators share one authoritative definition.

// ─── StatKey label tables ───
// Per `Enchantment.StatKey` doc (`Enchantment.cs:85-87`): the key is
// AttributeId | VitalId | SkillId | PropertyInt depending on which
// EnchantmentTypeFlags bit is set. Short ALL-CAPS abbreviations match
// retail-AC's vitals HUD convention (`STR`, `END`, etc.).
const ATTRIBUTE_NAME = Object.freeze({
  1: "STR", 2: "END", 3: "COO", 4: "QCK", 5: "FOC", 6: "SEL",
});
const VITAL_NAME = Object.freeze({
  1: "HP", 2: "HP", 3: "STAM", 4: "STAM", 5: "MANA", 6: "MANA",
});
// Top retail skills used most often in buffs — long-tail fallback prints
// the raw id. Source: `holtburger_common::stats::SkillType` /
// `Chorizite.Common/Enums/SkillId.cs`.
const SKILL_NAME = Object.freeze({
  6: "Melee D",  7: "Missile D", 14: "Run",   15: "Jump",
  20: "Magic D", 24: "Mana C",   31: "Loyalty",
  41: "War M",   42: "Life M",   43: "Item E", 44: "Creat E",
  45: "Void M",  46: "Heavy W",  47: "Light W", 48: "Finesse",
  49: "Missile", 50: "Two-Hand",
  51: "Healing", 52: "Lock",    53: "Sneak", 54: "Salvg",
  55: "App I",   56: "Arcane",  57: "App M",
  // Resistance skills (43-49 range in some encodings):
  60: "Slash P", 61: "Pierce P", 62: "Bludg P", 63: "Acid P",
  64: "Fire P",  65: "Cold P",   66: "Elec P",
});

// ─── Constants ───
// Wire's start_time is RELATIVE and ≤ 0 — NOT an epoch timestamp (the
// old "seconds since the AC Derethian epoch" claim here and in
// `pkg/holtburger_web.d.ts` was wrong; P4.2 follow-up F2). ACE sets
// StartTime = 0 at cast and decrements it per 5 s heartbeat
// (`enchantment.StartTime -= heartbeatInterval`,
// PropertiesEnchantmentRegistryExtensions.cs:251), so an enchantment
// re-sent aged N seconds (relog registry dump) arrives with
// start_time = −N. ACE's own remaining-lifetime formula, evaluated at
// send time, is
//   remaining = Duration + StartTime        (EnchantmentManager.cs:188)
// (the `Enchantment.cs:100-104` "− StartTime" formula previously cited
// here does not exist — those lines are Beneficial-flag plumbing). We
// still stamp our own wall-clock `receivedAt` (Unix seconds) the moment
// we first observe a given (layeredId, startTime) pair — see
// `stampReceivedAt` below — as the "send time" anchor, then age the
// ACE remaining from it; bug A1's Date.now()-vs-start_time diff stays
// dead, and an aged re-send no longer restarts at full duration (F1).
function nowSeconds() {
  return Date.now() / 1000;
}

// ─── receivedAt tracking (Wave F.2 fix — A1/A2) ───
// Keyed by layeredId for the local player; per-entity buckets keyed by
// GUID for remote entities (Wave 4.B `entityEnchantments`). Each cache
// entry is `{ startTime, receivedAt }`: as long as the wire's
// `startTime` for that layered slot is unchanged we carry the original
// `receivedAt` forward (monotonic countdown across refreshes); if the
// server re-sends a new `startTime` for the same slot (recast /
// refreshed buff) we treat it as a fresh arrival and re-stamp `receivedAt`.
const receivedAtSelf = new Map();          // layeredId -> {startTime, receivedAt}
const receivedAtByEntity = new Map();      // guid -> Map(layeredId -> {startTime, receivedAt})

// `playerEnchantments()` / `entityEnchantments()` hand back a fresh array
// of wasm-bindgen `PlayerEnchantmentJs` boxes on every call. They ARE
// finalizer-registered, so an unfreed box is reclaimed eventually rather
// than leaked outright — but the JS wrapper is tiny next to the Rust
// allocation, so the GC has no reason to hurry and the wasm heap's
// high-water mark only ever goes up. Call this once the rows have been
// normalized into plain objects.
//
// Safe iff the caller retains no reference INTO a row. Both call sites go
// through `normalizeEnchantment`, which copies every field out.
function freeWasmRows(rows) {
  if (!Array.isArray(rows)) return;
  for (const r of rows) { try { r?.free?.(); } catch (_) { /* already freed */ } }
}

function stampReceivedAt(record, cache) {
  if (!record) return record;
  const key = record.layeredId >>> 0;
  const prior = cache.get(key);
  if (prior && prior.startTime === record.startTime) {
    record.receivedAt = prior.receivedAt;
  } else {
    record.receivedAt = nowSeconds();
    cache.set(key, { startTime: record.startTime, receivedAt: record.receivedAt });
  }
  return record;
}

// Drop cache entries for layeredIds no longer present in the active
// map/bucket so `receivedAtSelf`/per-entity caches don't grow forever.
function pruneReceivedAtCache(cache, activeMap) {
  for (const key of cache.keys()) {
    if (!activeMap.has(key)) cache.delete(key);
  }
}

function remainingSeconds(ench) {
  // Duration < 0 or duration === 0 (cantrip / equipment) → permanent.
  if (!Number.isFinite(ench.duration) || ench.duration < 0) return Infinity;
  if (ench.duration === 0) return Infinity;  // permanent (cantrip / equipment)
  // `receivedAt` is stamped by `stampReceivedAt` on ingestion; fall back
  // to "now" (0 elapsed) for records that bypassed that path (e.g. a
  // raw object handed straight to this function, as in unit tests).
  const receivedAt = Number.isFinite(ench.receivedAt) ? ench.receivedAt : nowSeconds();
  const elapsed = nowSeconds() - receivedAt;
  // F1: remaining-at-receive = duration + startTime (ACE
  // EnchantmentManager.cs:188; startTime ≤ 0 — 0 fresh, −age when
  // re-sent aged). Clamp positive values to 0: ACE never sends > 0, and
  // clamping keeps synthetic/legacy fixtures on the old duration-only
  // path (retail clamps out-of-range refs rather than failing).
  const startTime = Math.min(0, Number(ench.startTime) || 0);
  return ench.duration + startTime - elapsed;
}

function fmtRemaining(secs) {
  // Permanent (∞) — distinct from expired (bug A2: these used to render
  // identically). Only the actual permanent sentinel gets the glyph.
  if (secs === Infinity) return "∞";
  // Expired (or unparseable) — show a zeroed timer rather than ∞.
  if (!Number.isFinite(secs) || secs <= 0) return "0:00";
  if (secs < 60) return `${Math.ceil(secs)}s`;
  if (secs < 3600) {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }
  return `${Math.floor(secs / 3600)}h`;
}

// ─── Set-spell (equipment set) discriminator ───
//
// P4.2 follow-up (2026-07-28, live-verified against vanilla ACE): the
// wire's `has_spell_set_id` is NOT a usable "this is a set spell" flag.
// ACE declares `public ushort HasSpellSetID = 1;` with the comment
// "// default true?" (`Network/Structure/Enchantment.cs:18`) and never
// assigns it anywhere else, so EVERY enchantment ACE sends carries
// `hasSpellSetId = 1` and a trailing `SpellSetID` u32 that is `0` for
// ordinary (non-equipment-set) spells. Live capture of a running
// Strength Self I: `{spellId: 2, hasSpellSetId: 1, spellSetId: 0}` —
// which lit the gold `set-spell` border and printed a bogus
// "Set: id 0" tooltip line on every single buff.
//
// The real discriminator is therefore the id itself: a set spell has a
// non-zero `EquipmentSet` id. `hasSpellSetId` is still honored as the
// "field was present on the wire" gate so a server that DOES zero it
// can't smuggle a stale id through.
function isSetSpell(ench) {
  if (!ench) return false;
  if (!ench.hasSpellSetId) return false;
  return ((ench.spellSetId ?? 0) >>> 0) !== 0;
}

// ─── Classification: buff vs debuff vs cooldown ───
//
// Per handoff §3 row "Critical semantics" #1: cooldown bit
// `EnchantmentTypeFlags.COOLDOWN = 0x1000000`. PR 4's character.js
// already routes these into `sharedCooldowns` — but we may also see
// cooldown-flagged entries in the snapshot via the same path. We
// double-check the bit here as a defensive cross-check.
//
// Buff vs debuff: PRIMARY signal is the spell record's own
// `isBeneficial` bit (retail's `gmEffectsUI::SpellEffectMatchesUIType`
// keys off `CSpellBase._bitfield & 4`, not the enchantment wire flag).
// We already surface that value via `spellRecord(spellId).isBeneficial`
// (Wave F.1). FALLBACK (spell record unavailable, e.g. pre-login
// catalog) is the `EnchantmentTypeFlags.BENEFICIAL = 0x2000000` bit,
// then the `statValue` sign for additive (>0 = buff, <0 = debuff) or
// its distance from 1.0 for multiplicative (>1 = buff, <1 = debuff).
// The wire-flag fallback is necessary because the BENEFICIAL bit is
// occasionally unset on legitimate buffs from older spells (per ACE PRs).
export function classifyEnchantment(ench) {
  const type = (ench?.type ?? ench?.statModType ?? 0) | 0;

  if ((type & ETF.COOLDOWN) !== 0) return "cooldown";

  // Authoritative signal: the spell record's own IsBeneficial bit.
  const record = ench?.spellId != null ? spellRecord(ench.spellId) : null;
  if (record && typeof record.isBeneficial === "boolean") {
    return record.isBeneficial ? "buff" : "debuff";
  }

  // WS15 (2026-07-12): DoT PropertyInts (NetherOverTime 330 / DamageOverTime
  // 318) are always debuffs. Their positive per-tick "value" would otherwise
  // trip the additive-sign heuristic below into a false "buff" whenever the
  // spell record is unavailable (pre-login catalog / record-lookup miss).
  const dotKey = (ench?.statKey ?? ench?.statModKey ?? 0) | 0;
  if (dotKey === 330 || dotKey === 318) return "debuff";

  // Fallback: enchantment wire flag (unreliable on some older spells).
  if ((type & ETF.BENEFICIAL) !== 0) return "buff";

  // Further fallback: stat-mod sign.
  const val = Number(ench?.statValue ?? ench?.statModValue ?? 0);
  if ((type & ETF.ADDITIVE) !== 0) {
    return val >= 0 ? "buff" : "debuff";
  }
  if ((type & ETF.MULTIPLICATIVE) !== 0) {
    return val >= 1.0 ? "buff" : "debuff";
  }
  // Unknown — default to buff (safer than hiding the icon entirely).
  return "buff";
}

// ─── Stat-mod text formatting ───
//
// Returns a short "stat: delta" string like "+10 STR" or "x1.25 STR".
// Empty string if we can't determine a meaningful label from the
// (type, statKey, statValue) tuple.
export function formatStatMod(ench) {
  if (!ench) return "";
  const type = (ench.type ?? ench.statModType ?? 0) | 0;
  const key = (ench.statKey ?? ench.statModKey ?? 0) | 0;
  const val = Number(ench.statValue ?? ench.statModValue ?? 0);

  // WS15 (2026-07-12): void/life damage-over-time enchantments modify the
  // NetherOverTime (330) / DamageOverTime (318) PropertyInts. The stat
  // "value" is damage-per-tick, not a stat delta — render a DoT label
  // instead of the misleading "+N id 330" (the "+" reads as a buff).
  const DOT_KEY_NAME = { 318: "DoT", 330: "Nether DoT" };
  if (DOT_KEY_NAME[key]) {
    const perTick = Math.abs(Math.round(val));
    return perTick > 0 ? `${perTick}/tick ${DOT_KEY_NAME[key]}` : DOT_KEY_NAME[key];
  }

  // Stat-name lookup keyed by the type flags.
  let name = null;
  if ((type & ETF.ATTRIBUTE) !== 0) name = ATTRIBUTE_NAME[key];
  else if ((type & ETF.SECOND_ATT) !== 0) name = VITAL_NAME[key];
  else if ((type & ETF.SKILL) !== 0) name = SKILL_NAME[key];
  if (!name) name = `id ${key}`;

  // Sign / format by additive vs multiplicative.
  if ((type & ETF.ADDITIVE) !== 0) {
    const intVal = Math.round(val);
    const sign = intVal >= 0 ? "+" : "";
    return `${sign}${intVal} ${name}`;
  }
  if ((type & ETF.MULTIPLICATIVE) !== 0) {
    return `x${val.toFixed(2)} ${name}`;
  }
  return name;
}

// ─── Spell record lookup (Wave F.1) ───
//
// Reads from `wasm.getSpellRecord(spellId)` first (byte-correct retail
// data from `client_portal.dat`); falls back to `data/spells-catalog.json`
// for pre-login sessions. Returns the legacy-shaped record
// `{name, icon, desc, level, ...}` so the rest of the plugin doesn't
// branch on the source.
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

// P4.2 follow-up (2026-07-28): per-spellId memo of the normalized wasm
// record. `buildCell`/`sortEffects` + `classifyEnchantment` all call `spellRecord`
// for every enchantment on every 1 Hz repaint; the lookup crosses the
// wasm boundary and allocates a fresh Map each time. Only successful
// wasm lookups are memoized — a pre-SpellTable-load miss must stay
// retryable (same rule as `plugins/spellbook.js` spellRecordFromWasm).
const wasmSpellRecordCache = new Map();  // spellId -> normalized record

function spellRecord(spellId) {
  const id = spellId >>> 0;
  const memo = wasmSpellRecordCache.get(id);
  if (memo) return memo;
  const handle = window.__sessionHandle;
  // Try wasm first (Wave F.1).
  if (handle?.getSpellRecord) {
    try {
      let raw = handle.getSpellRecord(id);
      // P4.2 follow-up (2026-07-28): `getSpellRecord` builds a
      // `serde_json::Value::Object` and ships it through
      // `serde_wasm_bindgen::to_value` (`apps/holtburger-web/
      // src/lib.rs` — `match serde_wasm_bindgen::to_value(&json)`),
      // whose default serializer emits a JS **Map**, not a plain
      // object. Live-verified this session: `getSpellRecord(2)
      // instanceof Map === true`, `.get("name") === "Strength Self I"`,
      // `.get("isBeneficial") === true`.
      //
      // Reading `raw.name` / `raw.iconId` / `raw.isBeneficial` off a
      // Map yields `undefined`, so this plugin was silently rendering
      // "Spell 2" with the fallback glyph and — because the old code
      // collapsed the result with `!!raw.isBeneficial` — telling
      // `classifyEnchantment` that EVERY enchantment was NOT beneficial.
      // That is what filed Strength Self I as `kind-debuff` and left
      // the buff row reading "No beneficial spells active.".
      // (Same root cause + same fix as the 2026-07-01 pass over
      // spellbook.js / ui/ac_entity_icon.js / examine-target.js; this
      // file was missed then.)
      if (raw instanceof Map) {
        raw = Object.fromEntries(raw);
        if (raw.flags instanceof Map) raw.flags = Object.fromEntries(raw.flags);
      }
      if (raw) {
        const rec = {
          name: raw.name,
          icon: raw.iconId,
          desc: raw.description,
          school: raw.schoolName,
          level: raw.roughLevel ?? 0,
          // Keep "unknown" distinguishable from "harmful": the
          // classifier only trusts this when it is a real boolean, and
          // falls back to the wire's BENEFICIAL bit otherwise. The old
          // `!!raw.isBeneficial` turned every unknown into `false`.
          isBeneficial: typeof raw.isBeneficial === "boolean"
            ? raw.isBeneficial
            : undefined,
        };
        if (typeof rec.name === "string") wasmSpellRecordCache.set(id, rec);
        return rec;
      }
    } catch (_) { /* fall through */ }
  }
  // JSON catalog fallback.
  const meta = spellCatalog?.[String(spellId)] || null;
  if (meta) {
    return {
      name: meta.name,
      icon: meta.icon,
      desc: meta.desc,
      school: meta.school,
      level: meta.level,
      isBeneficial: undefined,  // catalog has no beneficial flag
    };
  }
  return null;
}

// Thin wrapper around the shared icon cache — preserves the
// `[buffs-hud]` warn label on failure.
async function fetchIconDataUrl(iconId) {
  return fetchIconDataUrlShared(iconId, "buffs-hud");
}

// ─── Styles ───
//
// HUD overhaul 2026-10-05 — retail gmEffectsUI as a compact floaty: the
// retail floaty frame (0x06006129 + 0x0600612A-D) around a kit tab strip
// (Positive / Negative / Cooldowns) and a 5-column grid of 32-px spell icons,
// each with its remaining time UNDER the icon (the old strip burned a 7-px
// countdown and a gold layer badge into 24-px cells and leaned on the
// browser's native title tooltip, with the caster's hex guid in it). One kit
// tooltip names the spell, its effect, school, caster and time left. Five
// columns keep the window inside x < 230 at its default spot under the
// status strip, clear of the vitals orbs (HP pane at x 260) and the radar.
const SP = "./data/ui-sprites";
const GRID_COLS = 5;
const CELL = 32;
const CELL_GAP = 4;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  const u = (id) => `url("${SP}/${id}.png")`;
  const gridW = GRID_COLS * CELL + (GRID_COLS - 1) * CELL_GAP;
  s.textContent = `
    #${OVERLAY_ID} {
      position: fixed;
      top: 40px;
      left: 32px;
      z-index: 51;
      display: none;
      flex-direction: column;
      box-sizing: border-box;
      padding: 5px;
      width: fit-content;
      min-width: ${gridW + 20}px;
      max-width: ${gridW + 34}px;   /* + a thin scrollbar when very long */
      color: var(--hbk-text, #e8dfc8);
      font-family: var(--hbk-font, var(--hb-font-serif));
      font-size: 11px;
      user-select: none;
      pointer-events: auto;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.6);
      background:
        ${u("0x06006129")} left top / 5px 5px no-repeat,
        ${u("0x06006129")} right top / 5px 5px no-repeat,
        ${u("0x06006129")} left bottom / 5px 5px no-repeat,
        ${u("0x06006129")} right bottom / 5px 5px no-repeat,
        ${u("0x0600612A")} left top / 10px 5px repeat-x,
        ${u("0x0600612C")} left bottom / 10px 5px repeat-x,
        ${u("0x0600612B")} left top / 5px 10px repeat-y,
        ${u("0x0600612D")} right top / 5px 10px repeat-y,
        ${u("0x06004CC2")} left top / 48px 48px repeat,
        #0b0c10;
      image-rendering: pixelated;
    }
    #${OVERLAY_ID}[data-open="1"] { display: flex; }
    #${OVERLAY_ID} .hb-bh-head {
      display: flex; align-items: stretch; gap: 4px;
      cursor: move;
    }
    #${OVERLAY_ID} .hb-bh-head .hbk-tabs { flex: 1 1 auto; min-width: 0; padding: 0; }
    #${OVERLAY_ID} .hb-bh-head .hbk-tab {
      padding: 1px 4px 2px; font-size: 10px; letter-spacing: 0.02em;
      text-transform: none;
    }
    #${OVERLAY_ID} .hb-bh-tab-count { margin-left: 3px; color: var(--hbk-text-faint, #77705f); }
    #${OVERLAY_ID} .hbk-tab[aria-selected="true"] .hb-bh-tab-count { color: var(--hbk-gold, #d9b45a); }
    #${OVERLAY_ID} .hb-bh-tab-cooldown[hidden] { display: none; }
    #${OVERLAY_ID} .hb-bh-close {
      flex: 0 0 16px; width: 16px; height: 17px; align-self: center;
      border: 0; padding: 0; cursor: pointer;
      background: ${u("0x06001393")} center / 100% 100% no-repeat;
    }
    #${OVERLAY_ID} .hb-bh-close:hover,
    #${OVERLAY_ID} .hb-bh-close:focus-visible { background-image: ${u("0x06001394")}; }
    #${OVERLAY_ID} .hb-bh-grid {
      display: grid;
      grid-template-columns: repeat(${GRID_COLS}, ${CELL}px);
      column-gap: ${CELL_GAP}px;
      row-gap: 3px;
      padding: 5px 5px 2px;
      max-height: calc(60 * var(--hb-hud-vh, 1vh));
      overflow-y: auto;
      overflow-x: hidden;
      scrollbar-width: thin;
      scrollbar-color: var(--hbk-gold-dim, #8a7544) #0a0806;
    }
    #${OVERLAY_ID} .hb-bh-empty {
      padding: 10px 4px 8px; text-align: center;
      color: var(--hbk-text-faint, #77705f); font-style: italic;
    }
    #${OVERLAY_ID} .hb-buff {
      position: relative;
      width: ${CELL}px;
      cursor: help;
    }
    #${OVERLAY_ID} .hb-buff-icon {
      position: relative;
      width: ${CELL}px; height: ${CELL}px;
      box-sizing: border-box;
      background: linear-gradient(180deg, #17181c, #0b0c0e);
      border: 1px solid #000;
      box-shadow: inset 1px 1px 0 rgba(255, 255, 255, 0.07);
      display: flex; align-items: center; justify-content: center;
      color: var(--hbk-text-dim, #a8a090); font-size: 15px;
    }
    #${OVERLAY_ID} .hb-buff-icon img {
      position: absolute; inset: 0; width: 100%; height: 100%;
      image-rendering: pixelated; pointer-events: none;
    }
    /* Harmful effects get a red inner rim, cooldowns are dimmed, item-set
       spells a gold one — the colour coding the old border tints carried. */
    #${OVERLAY_ID} .hb-buff.kind-debuff .hb-buff-icon { box-shadow: inset 0 0 0 1px rgba(220, 60, 50, 0.9); }
    #${OVERLAY_ID} .hb-buff.kind-cooldown .hb-buff-icon { filter: grayscale(0.6) brightness(0.8); }
    #${OVERLAY_ID} .hb-buff.set-spell .hb-buff-icon { box-shadow: inset 0 0 0 1px var(--hbk-gold, #d9b45a), 0 0 4px rgba(243, 210, 122, 0.5); }
    #${OVERLAY_ID} .hb-buff:hover .hb-buff-icon { border-color: var(--hbk-gold-dim, #8a7544); filter: brightness(1.15); }
    #${OVERLAY_ID} .hb-buff-time {
      height: 11px;
      margin-top: 1px;
      text-align: center;
      font-size: 10px;
      line-height: 11px;
      color: var(--hbk-text, #e8dfc8);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
      text-shadow: 0 1px 0 #000;
      image-rendering: auto;
    }
    #${OVERLAY_ID} .hb-buff.is-expiring .hb-buff-time { color: var(--hbk-warn, #ff6a50); }
    #${OVERLAY_ID} .hb-buff.is-permanent .hb-buff-time { color: var(--hbk-text-faint, #77705f); }
    #${OVERLAY_ID} .hb-bh-tip {
      position: absolute;
      z-index: 5;
      width: 200px;
      padding: 4px 7px;
      box-sizing: border-box;
      background: ${u("0x06004CC2")} repeat, #0b0c10;
      border: 1px solid var(--hbk-gold-dim, #8a7544);
      box-shadow: 0 3px 10px rgba(0, 0, 0, 0.8);
      font-size: 11px;
      line-height: 1.35;
      pointer-events: none;
      display: none;
      image-rendering: auto;
    }
    #${OVERLAY_ID} .hb-bh-tip.is-open { display: block; }
    #${OVERLAY_ID} .hb-bh-tip-name { color: var(--hbk-gold-bright, #f3d27a); font-size: 12px; }
    #${OVERLAY_ID} .hb-bh-tip-kind { color: var(--hbk-text-faint, #77705f); font-style: italic; }
    #${OVERLAY_ID} .hb-bh-tip-mod { color: var(--hbk-value, #8aef6d); }
    #${OVERLAY_ID} .hb-bh-tip.kind-debuff .hb-bh-tip-mod { color: var(--hbk-warn, #ff6a50); }
    #${OVERLAY_ID} .hb-bh-tip-line { color: var(--hbk-text-dim, #a8a090); }
  `;
  document.head.appendChild(s);
}

// ─── Module-scope state ───
const state = {
  overlayEl: null,
  // HUD overhaul 2026-10-05 — window parts (buildOverlay) + keyed cells.
  gridEl: null,
  emptyEl: null,
  tipEl: null,
  tabEls: null,
  posCtl: null,
  /** @type {Map<string, {el: HTMLElement, timeEl: HTMLElement, ench: object, kind: string}>} */
  cells: new Map(),
  hoveredKey: null,
  filter: null,           // "buff" | "debuff" | "cooldown" | null (all)
  /** @type {Map<number, object>} keyed by layeredId; values are normalized records */
  enchantments: new Map(),
  /** @type {Map<number, object>} keyed by layeredId; cooldown records */
  cooldowns: new Map(),
  /** Optional Character ref — when present we use its tiebreak. */
  character: null,
  getCasterName: () => null,
  // === Wave 4.B — remote-entity enchantment cache (2026-05-28) ===
  // Per-GUID cache of normalized enchantment lists for non-self
  // entities. Populated by `refreshEntityFromSnapshot()` on every
  // `entityEnchantmentsUpdated` (kind=46) drain. Read by
  // `getEntityEnchantments(guid)` / `getEntityBuffSummary(guid)` —
  // the latter is what `nameplate_sprite.js` calls to drive the
  // per-target buff badge.
  //
  // Same shape as `enchantments` above (normalized records) but
  // keyed by entity GUID at the top level. Each value is a Map
  // (layeredId → record) so the per-(spell_id, layer) tiebreak
  // matches the self-path semantics.
  /** @type {Map<number, Map<number, object>>} guid → (layeredId → record) */
  entityEnchantments: new Map(),
  /** @type {Set<(guid:number)=>void>} listeners notified on entity change */
  entityChangeListeners: new Set(),
};

// ─── Normalization ───
//
// Accepts both the snake_case wire shape (raw `playerEnchantments()`
// elements) and the camelCase PR-4 Character.applyEnchantment shape.
// Produces a single normalized record the renderer expects.
function normalizeEnchantment(e) {
  if (!e) return null;
  const spellId   = (e.spellId ?? e.spell_id ?? 0) >>> 0;
  const layer     = (e.layer ?? 0) | 0;
  return {
    layeredId:     ((spellId << 16) | (layer & 0xFFFF)) >>> 0,
    spellId,
    layer,
    spellCategory: (e.spellCategory ?? e.spell_category ?? 0) | 0,
    power:         (e.power ?? e.powerLevel ?? e.power_level ?? 0) | 0,
    startTime:     Number(e.startTime ?? e.start_time ?? 0),
    duration:      Number(e.duration ?? 0),
    casterGuid:    (e.casterGuid ?? e.caster_guid ?? 0) >>> 0,
    type:          (e.type ?? e.statModType ?? e.stat_mod_type ?? 0) | 0,
    statKey:       (e.statKey ?? e.statModKey ?? e.stat_mod_key ?? 0) | 0,
    statValue:     Number(e.statValue ?? e.statModValue ?? e.stat_mod_value ?? 0),
    hasSpellSetId: (e.hasSpellSetId ?? e.has_spell_set_id ?? 0) | 0,
    spellSetId:    (e.spellSetId ?? e.spell_set_id ?? 0) | 0,
  };
}

// ─── Active-set sync ───
//
// Two source paths:
//   (a) When PR 4's `client.character` is present: read
//       `character.getActiveEnchantments()` (returns tiebreak-resolved
//       per-category winners) + `character.sharedCooldowns.values()`.
//   (b) Fallback: read raw `handle.playerEnchantments()` and classify
//       in-band (no tiebreak; one icon per layered slot).
function refreshFromCharacter(character) {
  state.enchantments.clear();
  state.cooldowns.clear();
  if (!character) return;
  // Apply the load-bearing tiebreak from PR 4 — returns the
  // highest-Power winner per (category, layer). Cooldowns live on
  // sharedCooldowns separately.
  const winners = character.getActiveEnchantments();
  for (const e of winners) {
    if (!e) continue;
    stampReceivedAt(e, receivedAtSelf);
    state.enchantments.set(e.layeredId >>> 0, e);
  }
  for (const cd of character.sharedCooldowns.values()) {
    if (!cd) continue;
    state.cooldowns.set(cd.layeredId >>> 0, {
      ...cd,
      // Mark as cooldown for the classifier.
      type: (cd.type ?? 0) | ETF.COOLDOWN,
    });
  }
  pruneReceivedAtCache(receivedAtSelf, state.enchantments);
}

function refreshFromSnapshot(snapshot) {
  state.enchantments.clear();
  state.cooldowns.clear();
  if (!Array.isArray(snapshot)) return;
  for (const raw of snapshot) {
    const n = normalizeEnchantment(raw);
    if (!n) continue;
    if ((n.type & ETF.COOLDOWN) !== 0) {
      state.cooldowns.set(n.layeredId, n);
    } else {
      stampReceivedAt(n, receivedAtSelf);
      // Per-category tiebreak: keep the highest-Power entry.
      const prev = [...state.enchantments.values()].find(
        (p) => p.spellCategory === n.spellCategory
              && p.layer === n.layer
              && p.spellCategory !== 0,
      );
      if (prev && prev.power >= n.power) continue;
      if (prev) state.enchantments.delete(prev.layeredId);
      state.enchantments.set(n.layeredId, n);
    }
  }
  pruneReceivedAtCache(receivedAtSelf, state.enchantments);
}

// === Wave 4.B — per-entity enchantment ingestion (2026-05-28) ===
//
// Refresh `state.entityEnchantments[guid]` from a raw wasm snapshot
// produced by `handle.entityEnchantments(guid)`. Mirror semantics of
// `refreshFromSnapshot` (per-category tiebreak; cooldown vs non-cooldown
// split) but scoped to a single non-self GUID. Empty array → entry is
// removed entirely so consumers can short-circuit on `Map.has(guid)`.
function refreshEntityFromSnapshot(guid, snapshot) {
  const g = (guid >>> 0);
  if (!Array.isArray(snapshot) || snapshot.length === 0) {
    state.entityEnchantments.delete(g);
    receivedAtByEntity.delete(g);
  } else {
    const bucket = new Map();
    let cache = receivedAtByEntity.get(g);
    if (!cache) {
      cache = new Map();
      receivedAtByEntity.set(g, cache);
    }
    for (const raw of snapshot) {
      const n = normalizeEnchantment(raw);
      if (!n) continue;
      stampReceivedAt(n, cache);
      // Cooldowns on remote entities are extremely rare (the cooldown
      // bucket is normally local-player-only via SharedCooldowns), but
      // we route them into the same bucket so the consumer can choose
      // to display or hide them. The nameplate badge skips cooldowns
      // (only renders buff + debuff counts).
      const prev = [...bucket.values()].find(
        (p) => p.spellCategory === n.spellCategory
              && p.layer === n.layer
              && p.spellCategory !== 0,
      );
      if (prev && prev.power >= n.power) continue;
      if (prev) bucket.delete(prev.layeredId);
      bucket.set(n.layeredId, n);
    }
    if (bucket.size === 0) {
      state.entityEnchantments.delete(g);
      receivedAtByEntity.delete(g);
    } else {
      state.entityEnchantments.set(g, bucket);
      pruneReceivedAtCache(cache, bucket);
    }
  }
  // Notify listeners (nameplate sprite etc.) so they can refresh just
  // the affected target's badge without a global repaint.
  for (const fn of state.entityChangeListeners) {
    try { fn(g); } catch (e) { console.warn("[buffs-hud] entity listener threw", e); }
  }
}

/**
 * Public helper: get the normalized enchantment list for an entity.
 * Returns an empty array when the entity has no cached enchantments
 * (never spawned with a buff, or buffs were purged).
 *
 * Useful for plugins that want raw enchantment data — for nameplate
 * badge rendering use `getEntityBuffSummary(guid)` instead, which
 * returns the buff/debuff/cooldown counts already classified.
 *
 * @param {number} guid Entity GUID (u32).
 * @returns {object[]} Normalized enchantment records (see normalizeEnchantment).
 */
export function getEntityEnchantments(guid) {
  const bucket = state.entityEnchantments.get(guid >>> 0);
  return bucket ? [...bucket.values()] : [];
}

/**
 * Public helper: get classified buff/debuff/cooldown counts for an
 * entity. Returns `{ buffs, debuffs, cooldowns, total }` with int
 * counts. Used by the nameplate sprite to drive its buff badge —
 * a small "+N" / "-N" indicator above the target's name.
 *
 * Pure function over `state.entityEnchantments[guid]`; safe to call
 * every nameplate-LOD tick.
 *
 * @param {number} guid Entity GUID (u32).
 * @returns {{buffs:number, debuffs:number, cooldowns:number, total:number, hasSet:boolean}}
 */
export function getEntityBuffSummary(guid) {
  const list = getEntityEnchantments(guid);
  let buffs = 0;
  let debuffs = 0;
  let cooldowns = 0;
  let hasSet = false;
  for (const e of list) {
    const k = classifyEnchantment(e);
    if (k === "buff") buffs += 1;
    else if (k === "debuff") debuffs += 1;
    else cooldowns += 1;
    if (isSetSpell(e)) hasSet = true;
  }
  return { buffs, debuffs, cooldowns, total: list.length, hasSet };
}

/**
 * Subscribe to per-entity enchantment changes. The callback fires
 * after every `entityEnchantmentsUpdated` (kind=46) drain with the
 * affected GUID; callers can selectively refresh just that target's
 * UI (nameplate badge, target frame, etc.) without polling.
 *
 * Returns a `dispose` function — call it on cleanup to remove the
 * listener.
 *
 * @param {(guid:number)=>void} fn Callback receiving the changed GUID.
 * @returns {()=>void} Dispose function.
 */
export function onEntityEnchantmentsChange(fn) {
  if (typeof fn !== "function") return () => {};
  state.entityChangeListeners.add(fn);
  return () => state.entityChangeListeners.delete(fn);
}

/**
 * Hard reset of the per-entity cache. Called on disconnect /
 * re-login to drop stale entries that survived the connection.
 */
export function clearEntityEnchantments() {
  state.entityEnchantments.clear();
  receivedAtByEntity.clear();
  for (const fn of state.entityChangeListeners) {
    try { fn(0); } catch (_) {}
  }
}

// ─── Render ───
//
// Keyed reconcile: a cell per (kind, layeredId) is created once and then
// only its time label / classes are touched on the 1 Hz tick. The old path
// rebuilt every cell (and re-requested every icon) each second, which
// flickered the strip and killed any hover in progress.

const KIND_LABEL = Object.freeze({
  buff: "Positive effect",
  debuff: "Negative effect",
  cooldown: "Cooldown",
});
const EXPIRING_SECS = 30;

function spellDisplayName(ench) {
  const meta = spellRecord(ench.spellId) || {};
  return meta.name || `Spell ${ench.spellId}`;
}

/** gmEffectsUI::GetSortedInsertionPlace — retail keeps the list sorted by
 *  spell name (strcmp), so icons hold their places while timers run. */
function sortEffects(list) {
  return list.slice().sort((a, b) => {
    const na = spellDisplayName(a).toLowerCase();
    const nb = spellDisplayName(b).toLowerCase();
    if (na < nb) return -1;
    if (na > nb) return 1;
    return (a.layeredId >>> 0) - (b.layeredId >>> 0);
  });
}

function casterLabel(ench) {
  const guid = ench.casterGuid >>> 0;
  if (!guid) return null;
  try {
    const local = (window.getLocalPlayerGuid?.() ?? 0) >>> 0;
    if (local && guid === local) return "You";
  } catch (_) {}
  return state.getCasterName?.(guid) || null;
}

function buildCell(key, ench, kind) {
  const cell = document.createElement("div");
  cell.className = `hb-buff kind-${kind}`;
  cell.dataset.key = key;
  cell.dataset.spellId = String(ench.spellId);
  cell.dataset.kind = kind;
  const iconBox = document.createElement("div");
  iconBox.className = "hb-buff-icon";
  // Placeholder glyph while the icon loads (cleared by clearPlaceholderGlyph).
  iconBox.textContent = kind === "debuff" ? "☠" : kind === "cooldown" ? "⏲" : "✦";
  cell.appendChild(iconBox);
  const time = document.createElement("div");
  time.className = "hb-buff-time";
  cell.appendChild(time);
  const meta = spellRecord(ench.spellId) || {};
  if (meta.icon) {
    fetchIconDataUrl(meta.icon).then((url) => {
      if (!url || !cell.isConnected) return;
      clearPlaceholderGlyph(iconBox);
      const img = document.createElement("img");
      img.src = url;
      img.alt = meta.name || `Spell ${ench.spellId}`;
      iconBox.appendChild(img);
    });
  }
  cell.addEventListener("mouseenter", () => { state.hoveredKey = key; renderTip(); });
  cell.addEventListener("mouseleave", () => {
    if (state.hoveredKey === key) { state.hoveredKey = null; renderTip(); }
  });
  return { el: cell, timeEl: time, ench, kind };
}

function updateCell(entry, ench, kind) {
  entry.ench = ench;
  entry.kind = kind;
  const remaining = remainingSeconds(ench);
  const text = fmtRemaining(remaining);
  if (entry.timeEl.textContent !== text) entry.timeEl.textContent = text;
  const permanent = remaining === Infinity;
  entry.el.classList.toggle("is-permanent", permanent);
  entry.el.classList.toggle("is-expiring", !permanent && remaining <= EXPIRING_SECS);
  entry.el.classList.toggle("set-spell", isSetSpell(ench));
  entry.el.setAttribute?.("aria-label", `${spellDisplayName(ench)}, ${permanent ? "permanent" : `${text} left`}`);
}

function tooltipLines(ench, kind) {
  const meta = spellRecord(ench.spellId) || {};
  const remaining = remainingSeconds(ench);
  const lines = [];
  const mod = formatStatMod(ench);
  if (mod) lines.push({ cls: "hb-bh-tip-mod", text: mod });
  if (meta.school) lines.push({ cls: "hb-bh-tip-line", text: meta.school });
  const caster = casterLabel(ench);
  if (caster) lines.push({ cls: "hb-bh-tip-line", text: `Cast by ${caster}` });
  if (isSetSpell(ench)) lines.push({ cls: "hb-bh-tip-line", text: "Item set bonus" });
  lines.push({
    cls: "hb-bh-tip-line",
    text: remaining === Infinity ? "Permanent" : `${fmtRemaining(remaining)} remaining`,
  });
  return { name: meta.name || `Spell ${ench.spellId}`, kind: KIND_LABEL[kind] || "", lines };
}

function renderTip() {
  const tip = state.tipEl;
  if (!tip) return;
  const entry = state.hoveredKey ? state.cells.get(state.hoveredKey) : null;
  if (!entry || !entry.el.isConnected) {
    tip.classList.remove("is-open");
    return;
  }
  const t = tooltipLines(entry.ench, entry.kind);
  tip.className = `hb-bh-tip is-open kind-${entry.kind}`;
  tip.textContent = "";
  const name = document.createElement("div");
  name.className = "hb-bh-tip-name";
  name.textContent = t.name;
  tip.appendChild(name);
  if (t.kind) {
    const k = document.createElement("div");
    k.className = "hb-bh-tip-kind";
    k.textContent = t.kind;
    tip.appendChild(k);
  }
  for (const l of t.lines) {
    const d = document.createElement("div");
    d.className = l.cls;
    d.textContent = l.text;
    tip.appendChild(d);
  }
  // Place under the hovered icon, inside the window's own (zoomed) CSS px;
  // flip to the cell's right edge in the right half so it stays on-screen.
  const cell = entry.el;
  const grid = state.gridEl;
  const ov = state.overlayEl;
  const left = (Number(cell.offsetLeft) || 0);
  const top = (Number(cell.offsetTop) || 0) - (Number(grid?.scrollTop) || 0) + (Number(cell.offsetHeight) || CELL) + 2;
  const ovW = Number(ov?.offsetWidth) || 0;
  const tipW = Number(tip.offsetWidth) || 200;
  tip.style.top = `${top}px`;
  tip.style.left = `${Math.max(0, ovW && left + tipW > ovW ? left + CELL - tipW : left)}px`;
}

function collectEntries() {
  const all = [...state.enchantments.values()];
  const buffs = [];
  const debuffs = [];
  for (const e of all) {
    if (classifyEnchantment(e) === "debuff") debuffs.push(e);
    else buffs.push(e);
  }
  const cooldowns = [...state.cooldowns.values()];
  return { buff: buffs, debuff: debuffs, cooldown: cooldowns };
}

export function renderAll() {
  const ov = state.overlayEl;
  if (!ov || !state.gridEl) return;
  const groups = collectEntries();
  // Tab strip — counts + selection + Cooldowns tab only when relevant.
  for (const kind of ["buff", "debuff", "cooldown"]) {
    const tab = state.tabEls?.[kind];
    if (!tab) continue;
    const n = groups[kind].length;
    if (tab.countEl) tab.countEl.textContent = n ? String(n) : "";
    tab.el.setAttribute?.("aria-selected", state.filter === kind ? "true" : "false");
    if (kind === "cooldown") tab.el.hidden = n === 0 && state.filter !== "cooldown";
  }
  const kinds = state.filter ? [state.filter] : ["buff", "debuff", "cooldown"];
  const wanted = [];
  for (const kind of kinds) {
    for (const ench of sortEffects(groups[kind] || [])) {
      wanted.push({ key: `${kind}:${ench.layeredId >>> 0}`, ench, kind });
    }
  }
  const keep = new Set(wanted.map((w) => w.key));
  for (const [key, entry] of state.cells) {
    if (!keep.has(key)) {
      entry.el.remove();
      state.cells.delete(key);
    }
  }
  const grid = state.gridEl;
  let i = 0;
  for (const w of wanted) {
    let entry = state.cells.get(w.key);
    if (!entry) {
      entry = buildCell(w.key, w.ench, w.kind);
      state.cells.set(w.key, entry);
    }
    updateCell(entry, w.ench, w.kind);
    const at = grid.children ? grid.children[i] : null;
    if (at !== entry.el) grid.insertBefore ? grid.insertBefore(entry.el, at ?? null) : grid.appendChild(entry.el);
    i += 1;
  }
  if (state.emptyEl) {
    const noun = state.filter === "debuff" ? "negative effects"
      : state.filter === "cooldown" ? "cooldowns"
        : state.filter === "buff" ? "positive effects" : "active effects";
    state.emptyEl.textContent = `No ${noun}.`;
    state.emptyEl.style.display = wanted.length ? "none" : "";
  }
  renderTip();
}

function syncIndicators() {
  if (typeof window.__setStatusIndicator !== "function") return;
  let nBuff = 0;
  let nDebuff = 0;
  for (const e of state.enchantments.values()) {
    const kind = classifyEnchantment(e);
    if (kind === "debuff") nDebuff++;
    else if (kind === "buff") nBuff++;
  }
  window.__setStatusIndicator("buffs", nBuff > 0, { count: nBuff });
  window.__setStatusIndicator("debuffs", nDebuff > 0, { count: nDebuff });
}

// `window.__buffsHudToggle` is called with the status INDICATOR id —
// "buffs" / "debuffs" (plural) — while the rows are keyed by kind (singular);
// normalize both spellings (P4.2 follow-up, 2026-07-28).
const FILTER_ALIASES = Object.freeze({
  buffs: "buff", buff: "buff",
  debuffs: "debuff", debuff: "debuff",
  cooldowns: "cooldown", cooldown: "cooldown",
});
function normalizeFilter(which) {
  if (which == null || which === "") return null;
  return FILTER_ALIASES[String(which)] ?? null;
}

function zoomOf(el) {
  const z = Number(el?.currentCSSZoom);
  return Number.isFinite(z) && z > 0 ? z : 1;
}

/** Open under (or, near the screen bottom, above) the status-indicator
 *  strip that was clicked — unless the player has dragged the window
 *  somewhere of their own. Both are zoomed HUD roots, so the anchor's
 *  screen rect is converted with OUR zoom. */
function placeNearAnchor(anchor) {
  const ov = state.overlayEl;
  if (!ov || !anchor?.getBoundingClientRect) return;
  const saved = state.posCtl?.getState?.();
  if (saved && saved.x != null && saved.y != null) return;
  const z = zoomOf(ov);
  const a = anchor.getBoundingClientRect();
  const vw = window.innerWidth / z;
  const vh = window.innerHeight / z;
  const w = (ov.getBoundingClientRect().width || 0) / z;
  const h = (ov.getBoundingClientRect().height || 0) / z;
  let left = a.left / z;
  let top = a.bottom / z + 4;
  if (top + h > vh - 4 && a.top / z - h - 4 >= 0) top = a.top / z - h - 4;
  left = Math.max(0, Math.min(left, vw - w));
  ov.style.left = `${Math.round(left)}px`;
  ov.style.top = `${Math.round(top)}px`;
  ov.style.right = "auto";
  ov.style.bottom = "auto";
}

function setFilter(which) {
  state.filter = which || null;
  renderAll();
}

function openStrip(which, opts = {}) {
  const ov = state.overlayEl;
  if (!ov) return;
  state.filter = which || null;
  ov.dataset.open = "1";
  // One popup under the indicator strip at a time (vitae-detail shares it).
  try { window.__hideVitaeDetail?.(); } catch (_) {}
  renderAll();
  placeNearAnchor(opts.anchor);
}

function closeStrip() {
  const ov = state.overlayEl;
  if (!ov) return;
  ov.dataset.open = "0";
  state.hoveredKey = null;
  renderTip();
}

function toggleStrip(rawWhich, opts = {}) {
  const which = normalizeFilter(rawWhich);
  const ov = state.overlayEl;
  if (!ov) return;
  const isOpen = ov.dataset.open === "1";
  if (isOpen && state.filter === which) {
    closeStrip();
    state.filter = null;
  } else {
    openStrip(which, opts);
  }
}

/** Build the effects window DOM (frame, tab strip, grid, tooltip). */
function buildOverlay() {
  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.dataset.open = "0";
  overlay.setAttribute?.("role", "dialog");
  overlay.setAttribute?.("aria-label", "Active effects");

  const head = document.createElement("div");
  head.className = "hb-bh-head";
  const tabs = document.createElement("div");
  tabs.className = "hbk-tabs";
  tabs.setAttribute?.("role", "tablist");
  const tabEls = {};
  for (const [kind, label] of [["buff", "Positive"], ["debuff", "Negative"], ["cooldown", "Cooldowns"]]) {
    const t = document.createElement("button");
    t.type = "button";
    t.className = `hbk-tab hb-bh-tab-${kind}`;
    t.setAttribute?.("role", "tab");
    const name = document.createElement("span");
    name.textContent = label;
    const count = document.createElement("span");
    count.className = "hb-bh-tab-count";
    t.appendChild(name);
    t.appendChild(count);
    t.addEventListener("click", () => setFilter(kind));
    tabs.appendChild(t);
    tabEls[kind] = { el: t, countEl: count };
  }
  head.appendChild(tabs);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "hb-bh-close";
  close.title = "Close";
  close.setAttribute?.("aria-label", "Close");
  close.addEventListener("click", (ev) => { ev.stopPropagation?.(); closeStrip(); });
  head.appendChild(close);
  overlay.appendChild(head);

  const grid = document.createElement("div");
  grid.className = "hb-bh-grid";
  overlay.appendChild(grid);
  const empty = document.createElement("div");
  empty.className = "hb-bh-empty";
  overlay.appendChild(empty);
  const tip = document.createElement("div");
  tip.className = "hb-bh-tip";
  tip.setAttribute?.("role", "tooltip");
  overlay.appendChild(tip);

  document.body.appendChild(overlay);
  state.overlayEl = overlay;
  state.gridEl = grid;
  state.emptyEl = empty;
  state.tipEl = tip;
  state.tabEls = tabEls;
  state.cells.clear();
  try {
    // Drag by the frame / tab-strip background / empty grid space.
    state.posCtl = attachWindowPosition(overlay, {
      windowId: WINDOW_ID.BUFFS,
      dragHandle: overlay,
      ignoreSelector: "button, .hb-buff",
    });
  } catch (_) { state.posCtl = null; }
  return overlay;
}

export const manifest = {
  id: "buffs-hud",
  name: "Buffs",
  icon: "✦",
  iconHidden: true,
  version: "0.4.0",  // HUD overhaul 2026-10-05 — retail gmEffectsUI floaty
  description: "Active effects window — positive / negative effects and cooldowns with time left",
};

export function mount(ctx) {
  ensureStyles();
  loadSpellCatalog();

  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();
  const overlay = buildOverlay();

  // Hooks for status-indicators.js (indicator click → open filtered under
  // the strip) and vitae-detail.js (one popup under the strip at a time).
  window.__buffsHudToggle = (which, opts) => toggleStrip(which, opts);
  window.__buffsHudClose = () => closeStrip();

  let pollTimer = null;
  const unsubs = [];
  let tickTimer = null;
  let watchdogTimer = null;
  let boundHandle = null;   // the SessionHandle the current subs were wired against

  function teardownSubs() {
    for (const u of unsubs) { try { u(); } catch (_) { /* idempotent */ } }
    unsubs.length = 0;
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  }

  function tryHook() {
    const client = ctx?.client ?? window.__pluginClient ?? null;
    const handle = window.__sessionHandle ?? null;
    if (!handle?.playerEnchantments) return false;

    // P4.2 follow-up (2026-07-28) — do NOT latch on the session handle
    // alone. The plugin bar mounts pre-login with `client: null`
    // (index.html: `mountBar({ client: null, root, slots })`), so
    // `ctx.client` is null for the entire session and the only event
    // source is `window.__pluginClient`, which index.html creates a few
    // statements AFTER `window.__sessionHandle`. The old code returned
    // true as soon as the handle existed, cleared the 500 ms poll, and
    // — whenever the poll landed in that window, or a kick-dance /
    // reconnect retry rebuilt the client — left the strip with ZERO
    // subscriptions for the rest of the session: the one-shot
    // `refresh()` painted whatever was already running and no live cast
    // ever reached the HUD, because the 1 Hz tick only re-rendered
    // existing state and never re-pulled the wire snapshot. Only a page
    // reload (fresh mount) recovered. Refuse to latch until there is a
    // real event source to subscribe to.
    const world = client?.world ?? null;
    const canSubscribe = !!world?.addEventListener
      || typeof client?.events?.on === "function";
    if (!canSubscribe) return false;

    // Re-entrant: the reconnect watchdog below calls us again with a
    // new handle, so drop whatever the previous pass wired up first.
    teardownSubs();
    boundHandle = handle;

    // Always resolve the CURRENT handle at call time. A kick-dance /
    // relog inside the same page swaps `window.__sessionHandle`; a
    // captured reference would keep querying the dead session forever.
    const liveHandle = () => window.__sessionHandle ?? handle;

    state.getCasterName = (guid) => {
      try {
        const ent = liveHandle()?.entityByGuid?.(guid >>> 0);
        return ent?.name || null;
      } catch { return null; }
    };

    // Prefer the typed Character if present.
    const character = client?.character ?? client?.world?.character ?? null;
    state.character = character;

    const refresh = () => {
      try {
        if (state.character && typeof state.character.getActiveEnchantments === "function") {
          refreshFromCharacter(state.character);
        } else {
          const list = liveHandle()?.playerEnchantments() || [];
          refreshFromSnapshot(list);
          // `normalizeEnchantment` copies every field into a plain object
          // and keeps no reference to the box, so the wasm side can go
          // back now. This runs on a 2 s cadence for the whole session —
          // the one place in this plugin where deferring to the finalizer
          // actually accumulates. (Freeing here, not inside
          // refreshFromSnapshot: __buffsHudDebug feeds it plain objects.)
          freeWasmRows(list);
        }
        syncIndicators();
        if (overlay.dataset.open === "1") renderAll();
      } catch (e) {
        console.warn("[buffs-hud] refresh failed", e);
      }
    };

    // Primary: PR 4's `client.world` bus events.
    if (world?.addEventListener) {
      const evRefresh = () => refresh();
      world.addEventListener("enchantmentAdded", evRefresh);
      world.addEventListener("enchantmentRemoved", evRefresh);
      world.addEventListener("enchantmentsChanged", evRefresh);
      unsubs.push(() => {
        world.removeEventListener("enchantmentAdded", evRefresh);
        world.removeEventListener("enchantmentRemoved", evRefresh);
        world.removeEventListener("enchantmentsChanged", evRefresh);
      });
    }

    // Fallback / belt-and-braces: also subscribe to playerStatsUpdated
    // — covers the case where world isn't yet bound or events haven't
    // been wired by PR 4 in some test contexts.
    if (client?.events?.on) {
      client.events.on("playerStatsUpdated", refresh);
      unsubs.push(() => client.events.off?.("playerStatsUpdated", refresh));
    }

    // === Wave 4.B — remote-entity enchantment subscription (2026-05-28) ===
    //
    // Subscribe to the new `entityEnchantmentsUpdated` event the recv
    // loop emits from the pre-route hook (kind=46). The payload carries
    // `{ guid, count }` — we pull a fresh snapshot from the wasm side
    // for that GUID and fold it into `state.entityEnchantments[guid]`.
    //
    // Why a separate path from playerStatsUpdated: the local player's
    // stats don't change when a remote target gets buffed, so we don't
    // want to re-fetch the self-snapshot for every drudge that gets
    // hit with Weakness. Per-target route keeps the cadence honest.
    if (client?.events?.on) {
      const onEntityEnch = (payload) => {
        // BUGFIX 2026-08-04 — this handler was DEAD ON ARRIVAL. The plugin bus
        // delivers a CustomEvent, not the raw payload: `events.emit(name, p)`
        // does `bus.dispatchEvent(new CustomEvent(name, { detail: p }))` and
        // `events.on(name, h)` does a bare `bus.addEventListener(name, h)`
        // (plugins/api.js:463-475), so `h` receives the EVENT. Reading
        // `payload.guid` therefore always yielded `undefined` → `guid === 0` →
        // the `if (!guid) return` below fired on EVERY kind=46, for the whole
        // session. `refreshEntityFromSnapshot` has exactly one live call site
        // (this one), so `state.entityEnchantments` was NEVER populated in a
        // real session: remote buff/debuff state — the monster-debuff badge on
        // the nameplate (`scene3d/nameplate_sprite.js` reads it through
        // `__buffsHudGetEntitySummary`) — simply never appeared. The sibling
        // subscriptions were unaffected because `refresh`/`evRefresh` ignore
        // their argument entirely, which is why this went unnoticed.
        // `?? payload` keeps the exported `refreshEntityFromSnapshot` /
        // `__buffsHudDebug` plain-object callers working.
        const d = payload?.detail ?? payload;
        const guid = (d?.guid ?? 0) >>> 0;
        if (!guid) return;
        try {
          const snapshot = liveHandle()?.entityEnchantments?.(guid) || [];
          refreshEntityFromSnapshot(guid, snapshot);
          freeWasmRows(snapshot);   // normalized copies retained, boxes not
        } catch (e) {
          console.warn("[buffs-hud] entityEnchantments fetch failed", e);
        }
      };
      client.events.on("entityEnchantmentsUpdated", onEntityEnch);
      unsubs.push(() => client.events.off?.("entityEnchantmentsUpdated", onEntityEnch));
    }

    refresh();
    // 1 Hz tick keeps remaining-time labels honest while open. Every
    // other tick (0.5 Hz) also RE-PULLS the wire snapshot so a dropped
    // or never-delivered event can't strand the strip on stale state —
    // `playerEnchantments()` returns a clone of a handful of rows, and
    // the reconcile has to run even while the strip is closed because
    // the Beneficial / Harmful status indicators are driven off the
    // same `syncIndicators()` call inside `refresh()`.
    let tick = 0;
    tickTimer = setInterval(() => {
      tick += 1;
      if (tick % 2 === 0) refresh();
      else if (overlay.dataset.open === "1") renderAll();
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

  // Reconnect watchdog — a kick-dance retry or an in-page relog swaps
  // `window.__sessionHandle` (index.html nulls it, then assigns the new
  // one) without re-running plugin `mount()`. Re-wire against the new
  // handle and drop the per-slot receipt stamps / remote-entity cache
  // so timers restart from the fresh server snapshot instead of ageing
  // off the dead session's receipt times.
  watchdogTimer = setInterval(() => {
    // `boundHandle === null` means the initial hook hasn't landed yet —
    // that case belongs to `pollTimer`, not here.
    if (!boundHandle) return;
    const cur = window.__sessionHandle ?? null;
    if (!cur || cur === boundHandle) return;
    receivedAtSelf.clear();
    clearEntityEnchantments();
    tryHook();
  }, 1000);

  return () => {
    if (pollTimer) clearInterval(pollTimer);
    if (watchdogTimer) clearInterval(watchdogTimer);
    watchdogTimer = null;
    boundHandle = null;
    teardownSubs();
    delete window.__buffsHudToggle;
    delete window.__buffsHudClose;
    overlay.remove();
    state.overlayEl = null;
    state.gridEl = null;
    state.emptyEl = null;
    state.tipEl = null;
    state.tabEls = null;
    state.posCtl = null;
    state.cells.clear();
    state.hoveredKey = null;
    state.character = null;
    state.enchantments.clear();
    state.cooldowns.clear();
    receivedAtSelf.clear();
  };
}

// ─── Debug helper ───
//
// Pop synthetic enchantments and open the strip. Mirrors retail buffs:
// permanent buff, temp buff, set-spell, debuff, cooldown. Validates the
// 3-row layout + classification + tiebreak in a manual smoke check.
if (typeof window !== "undefined") {
  window.__buffsHudDebug = function (filter) {
    ensureStyles();
    loadSpellCatalog();
    if (!state.overlayEl) buildOverlay();   // mount-lite path for debug
    const now = Date.now() / 1000;
    const samples = [
      // Strength Self VI — additive +60 STR, beneficial.
      { spellId: 1158, spellCategory: 12, layer: 0, power: 200,
        startTime: now - 30, duration: 600, casterGuid: 0xDEADBEEF,
        type: ETF.BENEFICIAL | ETF.ADDITIVE | ETF.ATTRIBUTE | ETF.SINGLE_STAT,
        statKey: 1, statValue: 60 },
      // Quickness Other VI — multiplicative buff (set-spell).
      { spellId: 1161, spellCategory: 14, layer: 0, power: 200,
        startTime: now - 5, duration: 1800, casterGuid: 0xCAFE0001,
        type: ETF.BENEFICIAL | ETF.MULTIPLICATIVE | ETF.ATTRIBUTE,
        statKey: 4, statValue: 1.25, hasSpellSetId: 1, spellSetId: 42 },
      // Cantrip — permanent equipment buff (no BENEFICIAL bit but +5 STR).
      { spellId: 2192, spellCategory: 22, layer: 0, power: 400,
        startTime: now, duration: -1, casterGuid: 0xCAFE0001,
        type: ETF.ADDITIVE | ETF.ATTRIBUTE,
        statKey: 1, statValue: 5 },
      // Weakness Other VI — additive -60 STR (debuff).
      { spellId: 3, spellCategory: 13, layer: 0, power: 200,
        startTime: now - 2, duration: 120, casterGuid: 0xBAD0CA57,
        type: ETF.ADDITIVE | ETF.ATTRIBUTE,
        statKey: 1, statValue: -60 },
      // Cooldown — Item cooldown bucket (e.g. lifestone tie).
      { spellId: 666, spellCategory: 0, layer: 0, power: 0,
        startTime: now, duration: 60, casterGuid: 0,
        type: ETF.COOLDOWN, statKey: 0x101 /* lifestone-tie cooldown id */, statValue: 0 },
    ];
    refreshFromSnapshot(samples);
    state.getCasterName = (g) => `Debug 0x${g.toString(16).toUpperCase()}`;
    syncIndicators();
    openStrip(normalizeFilter(filter));
  };
}

// ─── Test exports ───
// Internal helpers exposed for `tests/buffs_hud.test.cjs`. NOT part of
// the public plugin API.
export const __test = Object.freeze({
  ETF,
  ATTRIBUTE_NAME,
  VITAL_NAME,
  SKILL_NAME,
  normalizeEnchantment,
  refreshFromSnapshot,
  refreshFromCharacter,
  // === Wave 4.B — remote-entity helpers exposed for tests (2026-05-28) ===
  refreshEntityFromSnapshot,
  state,
  remainingSeconds,
  fmtRemaining,
  // HUD overhaul 2026-10-05 — retail gmEffectsUI name ordering + tooltip model.
  sortEffects,
  tooltipLines,
});

// === Wave 4.B — global access for nameplate sprite (2026-05-28) ===
//
// `scene3d/nameplate_sprite.js` runs outside the plugin import graph
// (it's loaded by the 3D bootstrap, not the plugin loader), so the
// canonical per-entity buff-summary accessor needs to live on `window`
// where the sprite layer can find it. Mirrors the
// `window.__buffsHudToggle` and `window.__setStatusIndicator` pattern
// from elsewhere in the plugin.
if (typeof window !== "undefined") {
  window.__buffsHudGetEntitySummary = (guid) => getEntityBuffSummary(guid);
  window.__buffsHudGetEntityEnchantments = (guid) => getEntityEnchantments(guid);
  window.__buffsHudOnEntityChange = (fn) => onEntityEnchantmentsChange(fn);
}
