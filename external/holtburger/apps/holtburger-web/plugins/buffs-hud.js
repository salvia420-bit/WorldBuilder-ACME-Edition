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
//   - Render: `renderRow(group)` builds icon cells; `renderAll()` drives all 3 rows
//   - Mount: subscribes to events, exposes `__buffsHudToggle` for status-indicators
// =============================================================================

import { setAcText } from "../ui/ac_font.js";
import { fetchIconDataUrl as fetchIconDataUrlShared } from "../ui/ac_icon_cache.js";
import { clearPlaceholderGlyph } from "../ui/ac_html.js";
import { attachDefaultTopDragHandle, WINDOW_ID } from "../ui/ac_window_position.js";
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
// record. `renderCell` + `classifyEnchantment` both call `spellRecord`
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
function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    /* P3-32 (cross-find gap-027): single ListBox container — icons
       wrap horizontally at the overlay level (was column-stacked rows
       with row-internal horizontal wrap). flex-wrap is set so a long
       enchantment list breaks to multiple rows naturally. */
    #${OVERLAY_ID} {
      position: fixed;
      top: 40px;
      left: 32px;
      z-index: 51;
      pointer-events: auto;
      display: none;
      flex-direction: row;
      flex-wrap: wrap;
      gap: 3px;
      padding: 4px 6px;
      max-width: 520px;
      font-family: var(--hb-font-serif);
      background: rgba(20, 14, 8, 0.92);
      border: 1px solid var(--hb-border-brass);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.55);
    }
    #${OVERLAY_ID}[data-open="1"] { display: flex; }
    /* P3-32 (cross-find gap-027 + buffs-identity-01): retail
       gmEffectsUI displays one ListBox of all active enchantments
       (border tint differentiates beneficial / harmful / cooldown).
       display:contents on .hb-buff-row flattens the three category
       rows into a single flex flow at the overlay level, matching
       retail. Kind borders + tooltips carry the categorization
       signal. The row label is hidden — retail uses the tooltip +
       sort order to convey category. */
    #${OVERLAY_ID} .hb-buff-row {
      display: contents;
    }
    #${OVERLAY_ID} .hb-buff-row-label {
      display: none;
    }
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
    #${OVERLAY_ID} .hb-buff.kind-buff      { border-color: rgba(80, 180, 80, 0.55); }
    #${OVERLAY_ID} .hb-buff.kind-buff:hover { border-color: rgba(120, 220, 120, 1); }
    #${OVERLAY_ID} .hb-buff.kind-debuff      { border-color: rgba(180, 60, 60, 0.6); }
    #${OVERLAY_ID} .hb-buff.kind-debuff:hover { border-color: rgba(220, 80, 80, 1); }
    #${OVERLAY_ID} .hb-buff.kind-cooldown    { border-color: rgba(120, 120, 180, 0.55); opacity: 0.7; }
    #${OVERLAY_ID} .hb-buff.set-spell { box-shadow: 0 0 4px var(--hb-text-gold); border-color: var(--hb-text-gold); }
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

// ─── Module-scope state ───
const state = {
  overlayEl: null,
  rowsEl: { buff: null, debuff: null, cooldown: null },
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
function renderCell(ench, kind) {
  const cell = document.createElement("div");
  cell.className = `hb-buff kind-${kind}`;
  cell.dataset.spellId = String(ench.spellId);
  cell.dataset.kind = kind;
  if (isSetSpell(ench)) cell.classList.add("set-spell");

  const meta = spellRecord(ench.spellId) || {};
  // Initial fallback glyph while icon loads.
  cell.textContent = kind === "debuff" ? "☠" : kind === "cooldown" ? "⏲" : "✦";
  const iconId = meta.icon;
  if (iconId) {
    fetchIconDataUrl(iconId).then((url) => {
      if (!url || !cell.isConnected) return;
      // Glyph only — the layer badge and the remaining-time label are
      // appended below this promise and must survive it (a `textContent`
      // clear here erased the countdown on every buff whose icon landed
      // after the synchronous appends, i.e. all of them).
      clearPlaceholderGlyph(cell);
      const img = document.createElement("img");
      img.src = url;
      img.alt = meta.name || `Spell ${ench.spellId}`;
      cell.appendChild(img);
    });
  }

  if (ench.layer > 0) {
    const layer = document.createElement("div");
    layer.className = "hb-buff-layer";
    setAcText(layer, String(ench.layer));
    cell.appendChild(layer);
  }

  const remaining = remainingSeconds(ench);
  const time = document.createElement("div");
  time.className = "hb-buff-time";
  setAcText(time, fmtRemaining(remaining));
  cell.appendChild(time);

  // ─── Tooltip ───
  const casterName = state.getCasterName?.(ench.casterGuid)
    || `0x${(ench.casterGuid >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
  const modText = formatStatMod(ench);
  const lines = [
    `${meta.name || `Spell ${ench.spellId}`} (${kind})`,
  ];
  if (modText) lines.push(modText);
  if (meta.school) lines.push(`School: ${meta.school}`);
  lines.push(`Caster: ${casterName}`);
  lines.push(`Power: ${ench.power}`);
  if (ench.duration > 0 || ench.duration < 0) {
    if (ench.duration < 0) {
      lines.push(`Duration: permanent`);
    } else {
      lines.push(`Remaining: ${fmtRemaining(remaining)}`);
    }
  } else {
    lines.push(`Duration: permanent`);
  }
  if (isSetSpell(ench)) {
    lines.push(`Set: id ${ench.spellSetId}`);
  }
  cell.title = lines.join("\n");

  return cell;
}

function renderRow(rowEl, list, kind, emptyMsg) {
  if (!rowEl) return;
  rowEl.innerHTML = "";
  if (list.length === 0) {
    const empty = document.createElement("div");
    empty.className = "hb-buff-empty";
    setAcText(empty, emptyMsg);
    rowEl.appendChild(empty);
    return;
  }
  // Sort: longest-remaining first; permanent (∞) first.
  const sorted = list.slice().sort((a, b) => {
    const ra = remainingSeconds(a);
    const rb = remainingSeconds(b);
    if (ra === Infinity && rb === Infinity) return 0;
    if (ra === Infinity) return -1;
    if (rb === Infinity) return 1;
    return rb - ra;
  });
  for (const ench of sorted) {
    rowEl.appendChild(renderCell(ench, kind));
  }
}

export function renderAll() {
  const ov = state.overlayEl;
  if (!ov) return;
  const all = [...state.enchantments.values()];
  const cooldowns = [...state.cooldowns.values()];
  const buffs = all.filter((e) => classifyEnchantment(e) === "buff");
  const debuffs = all.filter((e) => classifyEnchantment(e) === "debuff");

  // Filter logic — when filter active, hide non-matching rows.
  const showBuff     = !state.filter || state.filter === "buff";
  const showDebuff   = !state.filter || state.filter === "debuff";
  const showCooldown = !state.filter || state.filter === "cooldown";

  for (const r of Object.values(state.rowsEl)) {
    if (r) r.style.display = "none";
  }

  // P3-32: show = "contents", not "flex" — the stylesheet's
  // display:contents on .hb-buff-row (the retail single-flow
  // flattening) loses to any inline display, so an inline "flex"
  // here silently re-nested the category rows on every refresh.
  if (showBuff && state.rowsEl.buff) {
    state.rowsEl.buff.style.display = "contents";
    renderRow(state.rowsEl.buff, buffs, "buff",
              "No beneficial spells active.");
  }
  if (showDebuff && state.rowsEl.debuff) {
    state.rowsEl.debuff.style.display = "contents";
    renderRow(state.rowsEl.debuff, debuffs, "debuff",
              "No harmful spells active.");
  }
  if (showCooldown && state.rowsEl.cooldown) {
    state.rowsEl.cooldown.style.display = cooldowns.length === 0 && state.filter !== "cooldown"
      ? "none"   // hide if empty AND we aren't explicitly filtering to it
      : "contents";
    renderRow(state.rowsEl.cooldown, cooldowns, "cooldown",
              "No active cooldowns.");
  }
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
  window.__setStatusIndicator("buffs", nBuff > 0);
  window.__setStatusIndicator("debuffs", nDebuff > 0);
}

// P4.2 follow-up (2026-07-28): the only production caller of
// `window.__buffsHudToggle` is `plugins/status-indicators.js:367-369`,
// which passes the INDICATOR id — `"buffs"` / `"debuffs"` (plural,
// `status-indicators.js:111-112`). `renderAll` compares against the
// ROW kinds `"buff"` / `"debuff"` / `"cooldown"` (singular), so a
// plural filter matched no row and `showBuff`/`showDebuff`/
// `showCooldown` all evaluated false: clicking the Beneficial Spells
// indicator opened the strip with all three rows `display:none`
// (live-verified: `filter:"buffs"` → every row hidden). Normalize here
// so both spellings resolve to the row kind.
const FILTER_ALIASES = Object.freeze({
  buffs: "buff", buff: "buff",
  debuffs: "debuff", debuff: "debuff",
  cooldowns: "cooldown", cooldown: "cooldown",
});
function normalizeFilter(which) {
  if (which == null || which === "") return null;
  return FILTER_ALIASES[String(which)] ?? null;
}

function toggleStrip(rawWhich) {
  const which = normalizeFilter(rawWhich);
  const ov = state.overlayEl;
  if (!ov) return;
  const isOpen = ov.dataset.open === "1";
  if (isOpen && state.filter === which) {
    ov.dataset.open = "0";
    state.filter = null;
  } else {
    state.filter = which || null;
    ov.dataset.open = "1";
    renderAll();
  }
}

export const manifest = {
  id: "buffs-hud",
  name: "Buffs",
  icon: "✦",
  iconHidden: true,
  version: "0.3.0",  // Wave F.2 — full StatMod + cooldown + Wave-F.1-icons
  description: "Active-spells strip — buffs, debuffs, cooldowns with statMod display",
};

export function mount(ctx) {
  ensureStyles();
  loadSpellCatalog();

  // Build overlay + the 3 row containers.
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();
  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.dataset.open = "0";

  const mkRow = (kind, labelText) => {
    const row = document.createElement("div");
    row.className = `hb-buff-row hb-buff-row-${kind}`;
    const label = document.createElement("span");
    label.className = "hb-buff-row-label";
    setAcText(label, labelText);
    row.appendChild(label);
    return row;
  };
  state.rowsEl.buff = mkRow("buff", "Buffs");
  state.rowsEl.debuff = mkRow("debuff", "Debuffs");
  state.rowsEl.cooldown = mkRow("cooldown", "Cooldowns");
  overlay.appendChild(state.rowsEl.buff);
  overlay.appendChild(state.rowsEl.debuff);
  overlay.appendChild(state.rowsEl.cooldown);
  document.body.appendChild(overlay);
  attachDefaultTopDragHandle(overlay, WINDOW_ID.BUFFS);
  state.overlayEl = overlay;

  // Expose toggle for status-indicators.js.
  window.__buffsHudToggle = (which) => toggleStrip(which);

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
        const guid = (payload?.guid ?? 0) >>> 0;
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
    overlay.remove();
    state.overlayEl = null;
    state.rowsEl.buff = null;
    state.rowsEl.debuff = null;
    state.rowsEl.cooldown = null;
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
    if (!state.overlayEl) {
      // Mount-lite path for debug — usually mount() will have been called.
      const overlay = document.createElement("div");
      overlay.id = OVERLAY_ID;
      overlay.dataset.open = "0";
      const mkRow = (kind, labelText) => {
        const row = document.createElement("div");
        row.className = `hb-buff-row hb-buff-row-${kind}`;
        const label = document.createElement("span");
        label.className = "hb-buff-row-label";
        setAcText(label, labelText);
        row.appendChild(label);
        return row;
      };
      state.rowsEl.buff = mkRow("buff", "Buffs");
      state.rowsEl.debuff = mkRow("debuff", "Debuffs");
      state.rowsEl.cooldown = mkRow("cooldown", "Cooldowns");
      overlay.appendChild(state.rowsEl.buff);
      overlay.appendChild(state.rowsEl.debuff);
      overlay.appendChild(state.rowsEl.cooldown);
      document.body.appendChild(overlay);
      state.overlayEl = overlay;
    }
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
    state.filter = filter || null;
    state.overlayEl.dataset.open = "1";
    renderAll();
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
