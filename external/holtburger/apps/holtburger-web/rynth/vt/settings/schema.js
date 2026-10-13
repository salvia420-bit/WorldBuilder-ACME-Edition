// rynth/vt/settings/schema.js — the frozen VTank option schema (PLAN §3.5, §4.2,
// §4.6; U7a §2).
//
// One row per option. The canonical `key` is the storage key (profile JSON,
// VtOptions.getValue) and is always in canonical units: distances in METRES
// (= AC world units = VTank "yards"), durations in seconds for `*Sec` keys,
// percentages 0-100. `vt` lists the VTank option names (first = display);
// a row whose `vtUnit` is "lbf" stores a landblock fraction under its VTank
// name, so the VTank-name accessor converts (×240 on set, ÷240 on get) and the
// canonical key never does (§4.6).
//
// Defaults reproduce today's bot (D3): every new behaviour is off, every
// literal the loops hard-code today (40 m scan, 30 m corpse range, 300 s
// rebuff window, the vitals.js thresholds) is the default. PRESETS.vtank
// applies the VTank/RynthAi values to a user profile in one action.
//
// Name resolution (findRow): exact key → exact VTank name → (unless
// exactCase) case-insensitive VTank name → case-insensitive key → legacy C#
// lowercase aliases (with the three C# alias bugs fixed, U7a §6.2).
//
// Pure data + pure functions; no imports, no side effects.

/** Metres per VTank landblock-fraction unit (1 landblock = 192 m of terrain
 *  plus margin; VTank scales distance options by 240, U7a §2.6). */
export const LBF_M = 240;

/** HUD/vitals.js threshold field ↔ canonical key (the 9 vitals cells). */
export const VITALS_FIELD_KEYS = Object.freeze({
  healAtCombat: "HealAt",
  getManaAtCombat: "GetManaAt",
  restamAtCombat: "RestamAt",
  topOffHp: "TopOffHP",
  topOffMana: "TopOffMana",
  topOffStam: "TopOffStam",
  emergencyHp: "EmergencyHP",
  emergencyStamFloor: "EmergencyStamFloor",
  manaRechargeStamFloor: "ManaRechargeStamFloor",
});

// ── row builders (keep the table below readable) ───────────────────────────
function bool(key, vt, dflt, page, group, label, consumer, extra = {}) {
  return { key, vt, type: "bool", dflt, page, group, label, consumer, ...extra };
}
function num(type, key, vt, unit, dflt, min, max, page, group, label, consumer, extra = {}) {
  return { key, vt, type, unit, dflt, min, max, page, group, label, consumer, ...extra };
}
const int = (...a) => num("int", ...a);
const float = (...a) => num("float", ...a);
function inertBool(key, vt, dflt, label, help) {
  return bool(key, vt, dflt, "advanced", "Not on web", label, "inert", { help });
}

const MIN_SKILL_DEFAULTS = [35, 85, 135, 185, 235, 285, 335, 435];

const ROWS = [
  // ── Options page (G:14-42) ───────────────────────────────────────────────
  bool("EnableCombat", ["EnableCombat"], true, "options", "Subsystems", "Enable Combat", "combat",
    { cell: true, help: "Attack and debuff targets. Healing, navigation and looting continue when off (G:21)." }),
  bool("EnableBuffing", ["EnableBuffing"], true, "options", "Subsystems", "Enable Buffing", "buff",
    { cell: true, help: "Self buffs. Turning it on with no buff loop starts the profile's buff list (or auto)." }),
  float("MonsterRange", ["AttackDistance"], "m", 40, 1, 200, "options", "Ranges", "Monster Range", "combat",
    { vtUnit: "lbf", cell: true, help: "Maximum range at which targets are engaged (G:14)." }),
  float("RingRange", ["RingDistance"], "m", 5, 1, 50, "options", "Ranges", "Ring Range", "planner",
    { vtUnit: "lbf", help: "Range ring spells are expected to carry (G:15)." }),
  float("ApproachRange", ["ApproachDistance"], "m", 4, 0, 200, "options", "Ranges", "Approach Range", "planner",
    { vtUnit: "lbf", help: "With navigation on and a route loaded, run toward monsters inside this range (G:16)." }),
  float("FollowNavMin", ["NavCloseStopRange"], "m", 3, 0.5, 20, "options", "Ranges", "Follow/Nav Min", "nav",
    { vtUnit: "lbf", help: "Waypoint arrival radius; effective arrival = max(1.5, value) (G:17, D16)." }),
  bool("EnableAutostack", ["Autostack"], false, "options", "Inventory", "Enable Autostack", "inventory_mgr"),
  bool("EnableAutocram", ["Autocram"], false, "options", "Inventory", "Enable Autocram", "inventory_mgr"),
  bool("UseDispelItems", ["UseDispelItems"], false, "options", "Dispel", "Use Dispel Items", "supplies"),
  bool("CastDispelSelf", ["CastDispelSelf"], false, "options", "Dispel", "Cast dispel self", "supplies"),
  bool("AutoFellowMgmt", ["AutoFellowManagement"], false, "options", "Fellowship", "Auto Fellow Mgmt.", "fellow"),
  bool("ManaChargesWhenOff", ["ManaChargesWhenOff"], false, "options", "Mana", "M. Charges when off", "mana_stones"),
  bool("BoostNavPriority", ["NavPriorityBoost"], false, "options", "Priority", "Boost Nav. Priority", "nav"),
  bool("BoostLootPriority", ["LootPriorityBoost"], false, "options", "Priority", "Boost Loot Priority", "kernel"),
  bool("PeaceModeWhenIdle", ["IdlePeaceMode"], false, "options", "Idle", "Peace Mode When Idle", "idle"),
  bool("RebuffWhenIdle", ["IdleBuffTopOff"], false, "options", "Idle", "Rebuff When Idle", "idle"),
  bool("SummonPets", ["SummonPets"], false, "options", "Pets", "Summon Pets", "pets"),
  bool("CustomPetRangeEnabled", ["CustomPetRangeEnabled"], false, "options", "Pets", "Custom Pet Range (enable)", "pets"),
  float("CustomPetRange", ["CustomPetRange"], "m", 5, 1, 50, "options", "Pets", "Custom Pet Range", "pets"),
  int("PetMinMonsters", ["PetMonsterDensity"], "count", 1, 1, 20, "options", "Pets", "Pet Min. Monsters", "pets"),

  // ── Profiles / Meta pages (G:56-58) ──────────────────────────────────────
  bool("EnableNavigation", ["EnableNav"], false, "profiles", "Subsystems", "Enable Auto-Navigation", "nav"),
  bool("EnableLooting", ["EnableLooting"], true, "profiles", "Subsystems", "Enable Looting", "loot", { cell: true }),
  bool("ShowEditor", ["ShowEditor"], false, "profiles", "Profiles", "Show Editor", "inert",
    { help: "No function (deprecated in VTank, G:58)." }),
  bool("EnableMeta", ["EnableMeta"], false, "meta", "Subsystems", "Enable Meta", "meta"),

  // ── Vitals page (G:60-66; vitals.js DEFAULTS) ───────────────────────────
  int("HealAt", ["Recharge-Norm-HitP"], "pct", 60, 0, 100, "vitals", "Vitals", "Heal at (combat)", "vitals", { cell: true }),
  int("GetManaAt", ["Recharge-Norm-Mana"], "pct", 40, 0, 100, "vitals", "Vitals", "Mana at (combat)", "vitals", { cell: true }),
  int("RestamAt", ["Recharge-Norm-Stam"], "pct", 30, 0, 100, "vitals", "Vitals", "Stamina at (combat)", "vitals", { cell: true }),
  int("TopOffHP", ["Recharge-NoTarg-HitP"], "pct", 95, 0, 100, "vitals", "Vitals", "Top off HP (no target)", "vitals", { cell: true }),
  int("TopOffMana", ["Recharge-NoTarg-Mana"], "pct", 95, 0, 100, "vitals", "Vitals", "Top off mana (no target)", "vitals", { cell: true }),
  int("TopOffStam", ["Recharge-NoTarg-Stam"], "pct", 95, 0, 100, "vitals", "Vitals", "Top off stamina (no target)", "vitals", { cell: true }),
  int("EmergencyHP", [], "pct", 30, 0, 100, "vitals", "Vitals", "Emergency HP", "vitals", { cell: true }),
  int("EmergencyStamFloor", [], "pct", 20, 0, 100, "vitals", "Vitals", "Emergency stamina floor", "vitals", { cell: true }),
  int("ManaRechargeStamFloor", [], "pct", 15, 0, 100, "vitals", "Vitals", "Mana recharge stamina floor", "vitals", { cell: true }),

  // ── Advanced page ─────────────────────────────────────────────────────────
  int("RebuffSecondsRemaining", ["RebufTimeRemainingSeconds"], "s", 300, 30, 1800, "advanced", "Buffing",
    "Rebuff when seconds remaining below", "buff", { cell: true }),
  int("IdleRebuffWindowSec", [], "s", 600, 0, 3600, "advanced", "Buffing", "Idle rebuff window", "idle",
    { help: "Rebuff When Idle recasts buffs with less than RebuffSecondsRemaining + this window left." }),
  // RynthAi GetHighestBuffSpellTier (rynth/skill_cap.js; the loops' opts.skillCap).
  bool("BuffTierSkillCap", [], false, "advanced", "Buffing", "Cap buff/vital tiers by magic skill", "buff",
    { help: "Self buffs and vital spells use the highest known tier the buffed skill of their school reaches "
      + "(BuffMinSkillLevelTier1-8) instead of the highest known tier." }),
  ...MIN_SKILL_DEFAULTS.map((d, i) =>
    int(`BuffMinSkillLevelTier${i + 1}`, [], undefined, d, 1, 500, "advanced", "Buffing",
      `Min skill for buff tier ${i + 1}`, "buff")),
  int("LootMinValue", [], undefined, 0, 0, 1e9, "advanced", "Looting", "Loot minimum value", "loot", { cell: true }),
  float("CorpseApproachRangeMax", ["CorpseApproachRange-Max"], "m", 30, 1, 60, "advanced", "Looting",
    "Corpse approach range (max)", "loot", { vtUnit: "lbf", cell: true }),
  float("MeleeAttackPower", ["MeleeAttackPower"], "power", 0.6, 0, 1, "advanced", "Combat", "Melee attack power", "combat",
    { cell: true }),
  float("MissileAttackPower", ["MissileAttackPower"], "power", 0.6, 0, 1, "advanced", "Combat", "Missile attack power",
    "combat", { cell: true }),
  { key: "AttackHeight", vt: ["AttackHeight"], type: "enum", values: [1, 2, 3], dflt: 2, page: "advanced",
    group: "Combat", label: "Attack height (1 low, 2 medium, 3 high)", consumer: "combat", cell: true },
  int("BlacklistAttempts", ["BlacklistMonsterAttemptCount"], "count", 3, 1, 20, "advanced", "Combat",
    "Blacklist after attempts", "combat", { cell: true }),
  int("BlacklistTimeoutSec", ["BlacklistMonsterTimeoutSeconds"], "s", 30, 5, 120, "advanced", "Combat",
    "Blacklist timeout", "combat", { cell: true, scale: 1000 }),
  { key: "WarSpellMode", vt: [], type: "enum", values: ["legacy", "vtank"], dflt: "legacy", page: "advanced",
    group: "Combat", label: "War spell selection", consumer: "planner",
    help: "legacy = today's bolt picker; vtank = Monsters-tab damage type / streak / ring rules." },
  bool("AllowUntargetedRings", [], false, "advanced", "Combat", "Allow untargeted rings", "planner",
    { help: "Safety gate: ring spells are cast untargeted. Leave off until verified on your server." }),
  bool("SwitchWandsToDebuff", ["SwitchWandsToDebuff"], false, "advanced", "Combat", "Switch wands to debuff", "planner"),
  int("MinRingTargets", ["MinRingTargets"], "count", 4, 1, 20, "advanced", "Combat", "Minimum ring targets", "planner"),
  ...MIN_SKILL_DEFAULTS.map((d, i) =>
    int(`MinSkillLevelTier${i + 1}`, [], undefined, d, 1, 500, "advanced", "Combat",
      `Min skill for spell tier ${i + 1}`, "planner")),
  bool("BoostNavStrict", [], false, "advanced", "Navigation", "Boost nav: strict", "nav",
    { help: "Boosted navigation never stops to fight (VTank-literal); gentle mode fights back when attacked." }),
  int("PostPortalDelaySec", ["PostPortalDelaySec"], "s", 4, 0, 30, "advanced", "Navigation", "Post-portal delay", "nav"),
  bool("OpenDoors", ["OpenDoors"], false, "advanced", "Navigation", "Open doors", "doors"),
  float("OpenDoorRange", ["DoorOpenRange"], "m", 5, 0.5, 70, "advanced", "Navigation", "Door open range", "doors",
    { vtUnit: "lbf" }),
  bool("AutoUnlockDoors", ["AutoUnlockDoors"], false, "advanced", "Navigation", "Auto unlock doors", "doors"),
  bool("EnableManaTapping", ["EnableManaTapping"], false, "advanced", "Mana", "Enable mana tapping", "mana_stones"),
  bool("RefillWornMana", ["RefillWornMana"], false, "advanced", "Mana", "Refill worn mana", "mana_stones"),
  int("RefillWornManaItemManaPercent", ["RefillWornMana-Item-ManaPercent"], "pct", 25, 1, 100, "advanced", "Mana",
    "Refill worn item below mana %", "mana_stones"),
  int("ManaTankMinimumMana", ["ManaTankMinimumMana"], undefined, 2500, 100, 99999, "advanced", "Mana",
    "Mana tank minimum mana", "mana_stones"),
  int("ManaStoneLootCount", ["ManaStoneLootCount"], "count", 5, 0, 999, "advanced", "Mana", "Mana stones to keep",
    "mana_stones"),
  int("MinimumHealKitSuccessChance", ["MinimumHealKitSuccessChance"], "pct", 0, 0, 100, "advanced", "Consumables",
    "Minimum heal kit success chance", "supplies"),
  bool("SplitPeas", ["SplitPeas"], false, "advanced", "Consumables", "Split peas", "inventory_mgr"),
  int("GrenadeMinMonsters", [], "count", 0, 0, 20, "advanced", "Consumables", "Grenade minimum monsters (0 = off)",
    "supplies"),
  bool("PetAutoRefill", ["PetAutoRefill"], true, "advanced", "Pets", "Pet auto refill", "pets"),

  // ── Inert rows: stored and round-tripped (opt / meta), greyed in the UI ──
  inertBool("LootOnlyRareCorpses", ["LootOnlyRareCorpses"], false, "Loot only rare corpses"),
  inertBool("LootFellowCorpses", ["LootFellowCorpses"], false, "Loot fellow corpses"),
  inertBool("LootAllCorpses", ["LootAllCorpses"], false, "Loot all corpses"),
  float("CorpseApproachRangeMin", ["CorpseApproachRange-Min"], "m", 2, 0.5, 20, "advanced", "Not on web",
    "Corpse approach range (min)", "inert", { vtUnit: "lbf" }),
  float("NavFarStopDistance", ["NavFarStopRange"], "m", 0, 0, 1000, "advanced", "Not on web",
    "Nav far-stop range (0 = off)", "inert", { vtUnit: "lbf", help: "VTank default unverified." }),
  float("DoorIdentifyRange", ["DoorIDRange"], "m", 20, 0, 200, "advanced", "Not on web", "Door ID range", "inert",
    { vtUnit: "lbf", help: "VTank default unverified." }),
  float("HelperHealDistance", ["HelperDistanceHitP"], "m", 30, 0, 200, "advanced", "Not on web",
    "Helper heal distance", "inert", { vtUnit: "lbf", help: "VTank default unverified." }),
  inertBool("FollowAroundCorners", ["FollowAroundCorners"], false, "Follow around corners"),
  inertBool("ReadUnknownScrolls", ["ReadUnknownScrolls"], false, "Read unknown scrolls"),
  inertBool("CombineSalvage", ["CombineSalvage"], true, "Combine salvage"),
  inertBool("EnableMissileCrafting", ["EnableMissileCrafting"], true, "Enable missile crafting"),
  inertBool("StartMacroOnLogin", ["StartMacroOnLogin"], false, "Start macro on login",
    "Run state is owned by the operator stop (RUN/STOP), never by a profile."),
  { key: "BuffProfileBanes", vt: ["BuffProfile_Banes"], type: "string", dflt: "", page: "advanced", group: "Not on web",
    label: "Bane buff profile", consumer: "inert" },
  int("SpellDiffExcessThresholdHunt", ["SpellDiffExcessThreshold-Hunt"], undefined, 25, -1000, 1000, "advanced",
    "Not on web", "Spell difficulty excess threshold (hunt)", "inert"),
  inertBool("JumpOutWandCasting", ["JumpOutWandCasting"], false, "Jump out of wand casting"),
  inertBool("DoJiggle", ["DoJiggle"], false, "Jiggle"),
  float("AttackMinimumDistance", ["AttackMinimumDistance"], "m", 0, 0, 200, "advanced", "Not on web",
    "Attack minimum distance", "inert"),
  inertBool("TargetLock", ["TargetLock"], false, "Target lock"),
  int("HealOthersAt", ["HealOthersAt"], "pct", 50, 0, 100, "advanced", "Not on web", "Heal others at", "inert"),
  int("RestamOthersAt", ["RestamOthersAt"], "pct", 10, 0, 100, "advanced", "Not on web", "Restam others at", "inert"),
  int("InfuseOthersAt", ["InfuseOthersAt"], "pct", 10, 0, 100, "advanced", "Not on web", "Infuse others at", "inert"),
  float("MonsterDisengageRange", ["MonsterDisengageRange"], "m", 0, 0, 200, "advanced", "Not on web",
    "Monster disengage range (0 = auto)", "inert"),
  int("TargetNoProgressTimeoutSec", ["TargetNoProgressTimeoutSec"], "s", 0, 0, 300, "advanced", "Not on web",
    "Target no-progress timeout", "inert"),
  inertBool("EnableFPSLimit", ["EnableFPSLimit"], true, "Enable FPS limit"),
  int("TargetFPSFocused", ["TargetFPSFocused"], undefined, 60, 10, 240, "advanced", "Not on web", "Target FPS (focused)",
    "inert"),
  int("TargetFPSBackground", ["TargetFPSBackground"], undefined, 30, 5, 60, "advanced", "Not on web",
    "Target FPS (background)", "inert"),
  int("NavRingThickness", ["NavRingThickness"], undefined, 6, 1, 16, "advanced", "Not on web", "Nav ring thickness",
    "inert"),
  int("NavLineThickness", ["NavLineThickness"], undefined, 6, 1, 16, "advanced", "Not on web", "Nav line thickness",
    "inert"),
  inertBool("ShowTerrainPassability", ["ShowTerrainPassability"], true, "Show terrain passability"),
];

function freezeRow(r) {
  const row = { ...r };
  if (row.unit === undefined) delete row.unit;
  row.vt = Object.freeze([...(row.vt || [])]);
  if (row.values) row.values = Object.freeze([...row.values]);
  if (row.consumer === "inert" && !row.help) row.help = "Not implemented on web (stored and round-tripped only).";
  return Object.freeze(row);
}

/** The schema. Every row: { key, vt, type, unit?, vtUnit?, dflt, min?, max?,
 *  values?, page, group, label, consumer, cell?, scale?, help? }. */
export const SCHEMA = Object.freeze(ROWS.map(freezeRow));

/** Legacy C# lowercase aliases (MetaManager VtOptionMap + RynthAi field
 *  names) → canonical key. The three C# alias bugs are fixed here
 *  (navclosestoprange, switchwandstodebuff, lootonlyrarecorpses, U7a §6.2);
 *  aliases equal to a VTank name resolve through that name first anyway. */
export const LEGACY_ALIASES = Object.freeze({
  navclosestoprange: "FollowNavMin",
  switchwandstodebuff: "SwitchWandsToDebuff",
  lootonlyrarecorpses: "LootOnlyRareCorpses",
  opendoorrange: "OpenDoorRange",
  combinesalvage: "CombineSalvage",
  enablecombinesalvage: "CombineSalvage",
  mchargeswhenoff: "ManaChargesWhenOff",
  manastonekeepcount: "ManaStoneLootCount",
  manatapminmana: "ManaTankMinimumMana",
  corpseapproachrangemax: "CorpseApproachRangeMax",
  corpseapproachrangemin: "CorpseApproachRangeMin",
});

/** Profile list names and their "nothing configured" values. An empty
 *  `monsters` list = the CMB model's own [DEFAULT]-only list. */
export const LIST_KEYS = Object.freeze(["monsters", "items", "consumables", "buffs", "legacyPriorities"]);
export const REF_KEYS = Object.freeze(["navProfile", "metaName", "lootProfile"]);
export const LIST_DEFAULTS = Object.freeze({
  monsters: Object.freeze([]),
  items: Object.freeze([]),
  consumables: Object.freeze([]),
  buffs: Object.freeze({ spec: null, disabled: Object.freeze([]), itemSpells: Object.freeze({}) }),
  legacyPriorities: Object.freeze({}),
});

/** "Apply VTank defaults" (Profiles tab, `/rs settings preset vtank`): the
 *  VTank/RynthAi values that differ from today's defaults on purpose (D3). */
export const PRESETS = Object.freeze({
  vtank: Object.freeze({
    EnableAutostack: true,
    EnableAutocram: true,
    PeaceModeWhenIdle: true,
    FollowNavMin: 1.5,
    WarSpellMode: "vtank",
    PetAutoRefill: true,
  }),
});

// ── lookup index ──────────────────────────────────────────────────────────
/** Build a name index over a row list (the default SCHEMA, or a test schema). */
export function buildIndex(rows = SCHEMA) {
  const byKey = new Map();
  const byKeyCI = new Map();
  const byVt = new Map();
  const byVtCI = new Map();
  for (const row of rows) {
    byKey.set(row.key, row);
    byKeyCI.set(row.key.toLowerCase(), row);
    for (const n of row.vt || []) {
      byVt.set(n, row);
      byVtCI.set(n.toLowerCase(), row);
    }
  }
  // alias → { row, viaVt }: an alias that is a lower-case spelling of one of
  // the row's VTank names (navclosestoprange) converts like that name, so an
  // exact-case lookup (which reaches the alias step) and a case-insensitive
  // one (which reaches the VTank-name step first) agree on the unit.
  const aliases = new Map();
  for (const [a, key] of Object.entries(LEGACY_ALIASES)) {
    const row = byKey.get(key);
    if (row) aliases.set(a, { row, viaVt: (row.vt || []).some((n) => n.toLowerCase() === a) });
  }
  return { rows, byKey, byKeyCI, byVt, byVtCI, aliases };
}

let defaultIndex = null;
function schemaIndex() {
  if (!defaultIndex) defaultIndex = buildIndex(SCHEMA);
  return defaultIndex;
}

/** findRow over a prebuilt index (VtOptions keeps one per schema). */
export function findRowIn(index, name, { exactCase = false } = {}) {
  if (typeof name !== "string") return null;
  const n = name.trim();
  if (!n) return null;
  let row = index.byKey.get(n);
  if (row) return { row, viaVt: false };
  row = index.byVt.get(n);
  if (row) return { row, viaVt: true };
  if (exactCase) {
    const a = index.aliases.get(n);
    return a ? { row: a.row, viaVt: a.viaVt } : null;
  }
  const lower = n.toLowerCase();
  row = index.byVtCI.get(lower);
  if (row) return { row, viaVt: true };
  row = index.byKeyCI.get(lower);
  if (row) return { row, viaVt: false };
  const a = index.aliases.get(lower);
  return a ? { row: a.row, viaVt: a.viaVt } : null;
}

/** Resolve an option name → { row, viaVt } | null. Order: exact key → VTank
 *  names (case-insensitive unless exactCase) → case-insensitive key → legacy
 *  C# lowercase aliases. viaVt = addressed by a VTank name (lbf converts). */
export function findRow(name, { exactCase = false } = {}) {
  return findRowIn(schemaIndex(), name, { exactCase });
}

// ── coercion / presentation ───────────────────────────────────────────────
const TRUE_WORDS = new Set(["true", "on", "yes", "1"]);
const FALSE_WORDS = new Set(["false", "off", "no", "0"]);
const NUMERIC_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const HEX_RE = /^[+-]?0x[0-9a-f]+$/i;

function parseNumber(raw) {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "boolean") return raw ? 1 : 0;
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (NUMERIC_RE.test(s)) return Number(s);
  if (HEX_RE.test(s)) {
    const neg = s.startsWith("-");
    const v = parseInt(s.replace(/^[+-]/, ""), 16);
    return neg ? -v : v;
  }
  return null;
}

/** Round a landblock-fraction conversion to 0.1 mm so `0.1666667` reads 40 m. */
const roundLbf = (m) => Math.round(m * 1e4) / 1e4;

/**
 * Parse a raw value (command text, meta Value, UI input) into the row's
 * canonical value. bool: true/false/on/off/yes/no/1/0 (any case), other
 * numeric ≠ 0; int: rounded; numbers clamp to [min,max]; lbf ×240 only when
 * addressed by a VTank name (viaVt) and row.vtUnit === "lbf".
 * → { ok: true, value, clamped? } | { ok: false, error }
 */
export function coerce(row, raw, { viaVt = false } = {}) {
  if (!row || typeof row !== "object") return { ok: false, error: "unknown option" };
  if (raw === undefined || raw === null) return { ok: false, error: `${row.key}: missing value` };
  if (typeof raw === "object") return { ok: false, error: `${row.key}: not a plain value` };
  switch (row.type) {
    case "bool": {
      if (typeof raw === "boolean") return { ok: true, value: raw };
      if (typeof raw === "number") {
        return Number.isFinite(raw) ? { ok: true, value: raw !== 0 } : { ok: false, error: `${row.key}: expected true/false` };
      }
      const s = String(raw).trim().toLowerCase();
      if (TRUE_WORDS.has(s)) return { ok: true, value: true };
      if (FALSE_WORDS.has(s)) return { ok: true, value: false };
      const n = parseNumber(s);
      if (n !== null) return { ok: true, value: n !== 0 };
      return { ok: false, error: `${row.key}: expected true/false, got "${String(raw)}"` };
    }
    case "int":
    case "float": {
      let n = parseNumber(raw);
      if (n === null) return { ok: false, error: `${row.key}: expected a number, got "${String(raw)}"` };
      if (viaVt && row.vtUnit === "lbf") n = roundLbf(n * LBF_M);
      if (row.type === "int") n = Math.round(n);
      let clamped = false;
      if (typeof row.min === "number" && n < row.min) { n = row.min; clamped = true; }
      if (typeof row.max === "number" && n > row.max) { n = row.max; clamped = true; }
      if (Object.is(n, -0)) n = 0;
      return clamped ? { ok: true, value: n, clamped: true } : { ok: true, value: n };
    }
    case "enum": {
      const values = row.values || [];
      const numeric = values.length > 0 && values.every((v) => typeof v === "number");
      if (numeric) {
        const n = parseNumber(raw);
        if (n !== null && values.includes(n)) return { ok: true, value: n };
      } else {
        const s = String(raw).trim().toLowerCase();
        const hit = values.find((v) => String(v).toLowerCase() === s);
        if (hit !== undefined) return { ok: true, value: hit };
      }
      return { ok: false, error: `${row.key}: expected one of ${values.join("/")}, got "${String(raw)}"` };
    }
    case "string":
      return { ok: true, value: String(raw) };
    default:
      return { ok: false, error: `${row.key}: unsupported type ${row.type}` };
  }
}

/** Canonical value → the unit of the name it was addressed by (lbf ÷240). */
export function present(row, value, { viaVt = false } = {}) {
  if (row && viaVt && row.vtUnit === "lbf" && typeof value === "number") return value / LBF_M;
  return value;
}

/** { key: dflt } for every row. */
export function defaults() {
  const o = {};
  for (const row of SCHEMA) o[row.key] = row.dflt;
  return o;
}

/** Display name of a row (first VTank name, else the key). */
export function displayName(row) {
  return (row && row.vt && row.vt[0]) || (row ? row.key : "");
}
