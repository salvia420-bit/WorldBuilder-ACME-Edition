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
// applies the VTank/RynthAi values to a user profile in one action. The one
// exception is the block of rows made live on 2026-10-19 (the former "Not on
// web" rows): by the owner's decision they take VTank's / RynthAi's defaults.
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

  // ── Made live 2026-10-19 (the former "Not on web" rows) ──────────────────
  // Owner decision 2026-10-19: these take VTank's / RynthAi's defaults (helper
  // healing, worn-armor Impenetrability + banes, reading unknown scrolls,
  // combining salvage, the missile-ammo refill, following around corners, the
  // FPS limit and the steep-ground tint start ON) — the D3 "every new
  // behaviour is off" rule does not cover them.
  // Looting
  // 4 m = the loop's old literal reach (loot_loop.js REACH_M), so opening
  // corpses keeps today's timing; RynthAi ships 2, VTank 3.36 (0.014 lbf).
  float("CorpseApproachRangeMin", ["CorpseApproachRange-Min"], "m", 4, 0.5, 20, "advanced", "Looting",
    "Corpse approach range (min)", "loot", { vtUnit: "lbf",
      help: "Walk to within this of a corpse before opening it (the server walks the last steps itself; 1 m at the least)." }),
  bool("LootOnlyRareCorpses", ["LootOnlyRareCorpses"], false, "advanced", "Looting", "Loot only rare corpses", "loot",
    { help: "Loot only the corpse of a rare you discovered (\"<you> has discovered the …!\"); every other corpse is left." }),
  bool("LootFellowCorpses", ["LootFellowCorpses"], false, "advanced", "Looting", "Loot fellows' corpses", "loot",
    { help: "Also loot your fellows' kills: at once when they share loot with you, else once 100 s have passed. Off: your own kills only." }),
  bool("LootAllCorpses", ["LootAllCorpses"], false, "advanced", "Looting", "Loot everyone's corpses", "loot",
    { help: "Also loot anyone's kills once 100 s have passed (the server decides when they open). Off: your own kills only." }),
  bool("ReadUnknownScrolls", ["ReadUnknownScrolls"], true, "advanced", "Looting", "Read unknown scrolls", "loot",
    { help: "Loot and read scrolls of spells you don't know but the server lets you learn (ACE: a level 1, 7 or 8 scroll by anyone; otherwise the school trained and your buffed skill ≥ the spell's difficulty − 50). Scrolls your loot profile keeps are kept, not read." }),
  bool("CombineSalvage", ["CombineSalvage"], true, "advanced", "Looting", "Combine salvage", "loot",
    { help: "After a corpse, partial salvage bags of one material are combined with your Ust, within the loot profile's workmanship bands. (Items a Salvage rule takes are always salvaged with the Ust.)" }),
  // Combat
  bool("TargetLock", ["TargetLock"], false, "advanced", "Combat", "Target lock", "combat",
    { help: "Attack the monster you have selected (when it is a valid target in range) and stay on it." }),
  // VTank reads it beside AttackDistance (a landblock fraction); the key
  // differs from that lbf name because canonical keys never convert (§4.6).
  float("AttackMinDistance", ["AttackMinimumDistance"], "m", 0, 0, 200, "advanced", "Combat", "Attack minimum distance", "combat",
    { vtUnit: "lbf", help: "Monsters nearer than this are not engaged (0 = no minimum)." }),
  float("MonsterDisengageRange", ["MonsterDisengageRange"], "m", 0, 0, 200, "advanced", "Combat",
    "Monster disengage range (0 = auto)", "combat",
    { help: "An engaged target is kept and fought out to this range, so it isn't dropped the moment it steps past Monster Range (0 = Monster Range + 3 m)." }),
  int("TargetNoProgressTimeoutSec", ["TargetNoProgressTimeoutSec"], "s", 0, 0, 300, "advanced", "Combat",
    "Target no-progress timeout (0 = off)", "combat",
    { help: "Blacklist a target (for the Blacklist timeout) after this long engaged without damaging it." }),
  int("SpellDiffExcessThresholdHunt", ["SpellDiffExcessThreshold-Hunt"], undefined, 25, -1000, 1000, "advanced", "Combat",
    "Spell difficulty excess (VTank war spells)", "planner",
    { help: "VTank war-spell mode casts the highest spell whose difficulty + this is within your buffed school skill: higher is safer, negative attempts higher spells. Legacy mode uses Min skill for spell tier." }),
  bool("DoJiggle", ["DoJiggle"], false, "advanced", "Combat", "Jiggle (strafe between casts)", "combat",
    { help: "Strafe briefly left or right between spell casts in magic combat, so incoming projectiles miss." }),
  // Helpers — VTank's "… others at" (Vitals page) and HelperDistance* rows
  bool("DoHelp", ["DoHelp"], true, "vitals", "Helpers", "Help fellows", "helpers",
    { help: "Heal, restam and infuse fellowship members whose vitals drop below the 'others' levels, within the helper distances." }),
  int("HealOthersAt", ["Recharge-Helper-HitP"], "pct", 50, 0, 100, "vitals", "Helpers", "Heal others at", "helpers"),
  int("RestamOthersAt", ["Recharge-Helper-Stam"], "pct", 10, 0, 100, "vitals", "Helpers", "Restam others at", "helpers"),
  int("InfuseOthersAt", ["Recharge-Helper-Mana"], "pct", 10, 0, 100, "vitals", "Helpers", "Infuse others at", "helpers"),
  float("HelperHealDistance", ["HelperDistanceHitP"], "m", 30, 0, 200, "vitals", "Helpers", "Heal others within", "helpers",
    { vtUnit: "lbf" }),
  float("HelperRestamDistance", ["HelperDistanceStam"], "m", 30, 0, 200, "vitals", "Helpers", "Restam others within", "helpers",
    { vtUnit: "lbf" }),
  float("HelperInfuseDistance", ["HelperDistanceMana"], "m", 30, 0, 200, "vitals", "Helpers", "Infuse others within", "helpers",
    { vtUnit: "lbf" }),
  bool("UseHealersHeart", ["UseHealersHeart"], true, "vitals", "Helpers", "Use Healer's Heart", "helpers",
    { help: "A Healer's Heart on the Items tab heals fellows before any spell." }),
  bool("JumpOutWandCasting", ["JumpOutWandCasting"], false, "vitals", "Helpers", "Jump out of heart casting", "helpers",
    { help: "Jump right after using a Healer's Heart, so the heal goes out at once." }),
  // Buffing — worn armor (ACE puts a self-cast Impenetrability / bane on every
  // worn armor and clothing piece and shield: WorldObject_Magic.cs
  // TryCastItemEnchantment_WithRedirects)
  { key: "BuffProfileBanes", vt: ["BuffProfile_Banes", "BuffProfile-Banes"], type: "string", dflt: "ALFCBPS",
    page: "advanced", group: "Buffing", label: "Banes on worn armor", consumer: "buff", codec: "banes",
    help: "Banes cast on yourself, which the server puts on every worn armor and clothing piece and shield: A acid, L lightning, F flame, C cold, B bludgeon, P pierce, S slash (All / None, or VTank's 1-8)." },
  bool("BuffArmorImpen", [], true, "advanced", "Buffing", "Impenetrability on worn armor", "buff",
    { help: "Cast Impenetrability on yourself, which the server puts on every worn armor and clothing piece and shield." }),
  // Navigation
  float("NavFarStopDistance", ["NavFarStopRange"], "m", 0, 0, 100000, "advanced", "Navigation",
    "Nav far-stop range (0 = off)", "nav",
    { vtUnit: "lbf", help: "Hold the route while its next waypoint (or the Follow leader) is farther than this — you ran far off course — and walk on once back within it (0 = never)." }),
  bool("FollowAroundCorners", ["FollowAroundCorners"], true, "advanced", "Navigation", "Follow around corners", "nav",
    { help: "Follow routes run the leader's own path, corner by corner; off: straight at the leader." }),
  float("DoorIdentifyRange", ["DoorIDRange"], "m", 20, 0, 200, "advanced", "Navigation", "Door ID range", "doors",
    { vtUnit: "lbf", help: "Doors within this range are examined (locked? how hard to pick?) before Open doors / Auto unlock doors reach them." }),
  // Crafting
  bool("EnableMissileCrafting", ["EnableMissileCrafting"], true, "advanced", "Crafting", "Refill missile ammo", "ammo",
    { help: "While the bot fights with a bow, crossbow or atlatl and the ammo slot is empty: wield matching ammo from your pack, else fletch it from heads and shafts (Fletching trained, ≥ 50 % success)." }),
  // Run
  bool("StartMacroOnLogin", ["StartMacroOnLogin"], false, "options", "Run", "Start on login", "login",
    { help: "Start the bot when this character logs in with this profile active — the HUD's START, once per login (not on a ?bot=1 or ?botVt=off page). STOP still stops it. The one piece of run state a profile carries." }),
  // Display
  bool("EnableFPSLimit", ["EnableFPSLimit"], true, "advanced", "Display", "Limit frame rate", "display",
    { help: "Cap the 3D frame rate: the focused rate while the game window has focus, the background rate while it doesn't. A ?targetFps= URL flag wins." }),
  int("TargetFPSFocused", ["TargetFPSFocused"], undefined, 60, 10, 240, "advanced", "Display", "Target FPS (focused)", "display"),
  int("TargetFPSBackground", ["TargetFPSBackground"], undefined, 30, 5, 60, "advanced", "Display", "Target FPS (background)",
    "display"),
  // VTank's route display widths (2026-10-19): scene3d/route_overlay.js draws
  // the route in the world (Route tab › Show path); 1 = a hairline … 16,
  // 0.02 m per step (the default 6 = 0.12 m).
  int("NavRingThickness", ["NavRingThickness"], undefined, 6, 1, 16, "advanced", "Navigation", "Route ring thickness",
    "overlay", { help: "Width of the waypoint rings the route draws in the world (Route tab › Show path): 1 = a hairline … 16." }),
  int("NavLineThickness", ["NavLineThickness"], undefined, 6, 1, 16, "advanced", "Navigation", "Route line thickness",
    "overlay", { help: "Width of the lines between waypoints the route draws in the world (Route tab › Show path): 1 = a hairline … 16." }),
  bool("ShowTerrainPassability", ["ShowTerrainPassability"], true, "advanced", "Navigation", "Show steep ground", "overlay",
    { help: "Tint ground too steep to walk up (the game's walkable-slope limit) red around you, whether or not a route is shown (Route tab › Steep)." }),
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
    case "string": {
      if (row.codec === "banes") {
        const letters = baneLetters(raw);
        return letters === null
          ? { ok: false, error: `${row.key}: expected All, None, VTank's 2-8 or letters from ALFCBPS, got "${String(raw)}"` }
          : { ok: true, value: letters };
      }
      return { ok: true, value: String(raw) };
    }
    default:
      return { ok: false, error: `${row.key}: unsupported type ${row.type}` };
  }
}

/** VTank's bane letters, in its order: Acid, Lightning, Flame (fire), Cold,
 *  Bludgeon, Pierce, Slash. */
export const BANE_LETTERS = "ALFCBPS";
/** VTank's BuffProfile_Banes enum (1 = Custom: the BuffProfile-Banes letters). */
const BANE_ENUM = Object.freeze({ 2: "ALFCBPS", 3: "", 4: "B", 5: "BPS", 6: "BPSA", 7: "BPSAC", 8: "ALFC" });

/** A bane profile in any form VTank writes — its enum (2 All … 8 ALFC), All /
 *  None, or the letters themselves (any case, any order, spaces or commas) —
 *  → the canonical letters in BANE_LETTERS order ("" = none); null when it
 *  is none of those (1 "Custom" names no letters of its own). */
export function baneLetters(raw) {
  if (raw === null || raw === undefined || typeof raw === "object") return null;
  if (typeof raw === "boolean") return raw ? BANE_LETTERS : "";
  const s = String(raw).trim();
  if (!s || /^none$/i.test(s)) return "";
  if (/^all$/i.test(s)) return BANE_LETTERS;
  const n = parseNumber(s);
  if (n !== null) return Object.prototype.hasOwnProperty.call(BANE_ENUM, n) ? BANE_ENUM[n] : null;
  const up = s.toUpperCase().replace(/[\s,;+]/g, "");
  if (!/^[ALFCBPS]+$/.test(up)) return null;
  return [...BANE_LETTERS].filter((c) => up.includes(c)).join("");
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
