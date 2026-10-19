// rynth/vt/bridge/bridge_options.js — the VT bridge's settings side (PLAN
// W1-10, §3.16; G:1-66).
//
// The panel's command bar (Run Macro, the five subsystem switches, the
// profile select — G:7, G:20-21, G:51-57, G:237), the Main tab (VTank's
// Options page G:14-42 + the Vitals page G:60-66, with the player's live
// vitals) and the Advanced tab (the rows no other tab shows; a filter
// searches every SCHEMA row): pure view-models over VtOptions + the commands
// the panel drives. PANEL_LAYOUT is the one table that says which tab shows
// which setting. Everything here works WITHOUT a bot (the page session's
// VtOptions), which is how a player edits a profile before pressing START.
//
// This file also hosts the bridge's tiny shared helpers (safe / ok / fail /
// command), imported by the other bridge files — the package has no util
// module and C2 keeps them in-package.
//
// Discipline (rynth/hud_bridge.js): nothing throws, every command resolves to
// { ok, error?, … }, every read of a service is guarded (fakes and older
// layers lack members).

// ── shared helpers ─────────────────────────────────────────────────────────

/** fn() or dflt when it throws / returns undefined. */
export function safe(fn, dflt = null) {
  try {
    const v = fn();
    return v === undefined ? dflt : v;
  } catch {
    return dflt;
  }
}

export function errText(e) {
  if (e == null) return "failed";
  if (typeof e === "string") return e || "failed";
  return String(e.message || e) || "failed";
}

export const ok = (extra = {}) => ({ ok: true, ...extra });
export const fail = (error, extra = {}) => ({ ok: false, error: errText(error), ...extra });

/** A service result → the bridge's { ok, … } shape. */
export function asResult(r, okExtra = null) {
  if (r && typeof r === "object" && typeof r.ok === "boolean") {
    if (!r.ok) return { ...r, error: errText(r.error || "refused") };
    return okExtra ? { ...r, ...okExtra } : r;
  }
  return ok(okExtra ? { value: r, ...okExtra } : { value: r });
}

/** Wrap a command: ALWAYS a Promise, never a rejection, never a throw. */
export function command(fn) {
  return (...args) =>
    Promise.resolve()
      .then(() => fn(...args))
      .then((r) => asResult(r), (e) => fail(e));
}

export const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
export const isFn = (f) => typeof f === "function";

/** JSON-ish deep copy for plain data (lists, rules, entries). */
export function clone(v) {
  if (v === null || v === undefined || typeof v !== "object") return v;
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return Array.isArray(v) ? v.slice() : { ...v };
  }
}

// ── schema rows → editor rows ──────────────────────────────────────────────

const PAGE_ORDER = ["options", "profiles", "vitals", "meta", "route", "advanced"];
const UNIT_TEXT = Object.freeze({ m: "m", pct: "%", s: "s", ms: "ms", count: "", power: "0-1" });

/** A schema row (VtOptions.list() item) → the panel's typed-editor row. */
export function rowView(item) {
  const row = item && item.row ? item.row : item || {};
  const value = item && "value" in item ? item.value : row.dflt;
  const out = {
    key: String(row.key ?? item?.key ?? ""),
    label: String(row.label ?? row.key ?? ""),
    vtName: String(item?.vtName ?? (Array.isArray(row.vt) && row.vt[0]) ?? row.key ?? ""),
    vtNames: Array.isArray(row.vt) ? row.vt.slice() : [],
    type: row.type || "string",
    unit: row.unit ?? null,
    unitText: row.unit ? UNIT_TEXT[row.unit] ?? row.unit : "",
    lbf: row.vtUnit === "lbf",
    value: clone(value),
    dflt: clone(row.dflt),
    min: num(row.min),
    max: num(row.max),
    values: Array.isArray(row.values) ? row.values.slice() : null,
    inert: row.consumer === "inert" || item?.inert === true,
    web: !Array.isArray(row.vt) || row.vt.length === 0,
    help: row.help ? String(row.help) : "",
    page: String(row.page ?? ""),
    group: String(row.group ?? ""),
    isDefault: sameValue(value, row.dflt),
  };
  return out;
}

function sameValue(a, b) {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** All rows of the session/layer options (one VtOptions.list() call). */
export function allRows(options) {
  const list = safe(() => options?.list?.(), null);
  return Array.isArray(list) ? list.map(rowView) : [];
}

/** Rows grouped by `group`, groups in first-appearance order. */
export function groupRows(rows) {
  const groups = [];
  const at = new Map();
  for (const r of rows) {
    const g = r.group || "Other";
    if (!at.has(g)) {
      at.set(g, { group: g, rows: [] });
      groups.push(at.get(g));
    }
    at.get(g).rows.push(r);
  }
  return groups;
}

// ── run state (Run Macro, G:7) ─────────────────────────────────────────────

/** Cheap run-state read: no wasm, no OperatorControl.state() recompute. */
export function runState(bot) {
  if (!bot) return { phase: "no-bot", running: false, held: false };
  const held = safe(() => bot.kernel?.operatorHeld === true, false);
  return { phase: held ? "stopped" : "running", running: !held, held };
}

export function forceRebuffState(bot) {
  const buff = safe(() => bot?.buff ?? null);
  return {
    available: !!(buff && isFn(buff.forceRebuff)),
    cancellable: !!(buff && isFn(buff.cancelForceRebuff)),
    active: !!safe(() => (typeof buff?.forceRebuffing === "boolean" ? buff.forceRebuffing : buff?._forceRebuffing === true), false),
  };
}

// ── panel layout: which tab shows which setting ────────────────────────────
//
// The command bar carries the five subsystem switches (VTank scattered them
// over Options, Profiles and Meta); Main is VTank's Options page plus the
// Vitals page; Buffs and Loot show the few knobs that belong to them. Every
// row not placed here — today's advanced page, and any row a later schema
// adds — lands on the Advanced tab, so nothing can go missing.

/** Command-bar switch id → canonical key (G:20-21, G:56-57, G:237). */
export const SUBSYSTEM_KEYS = Object.freeze({
  combat: "EnableCombat",
  buff: "EnableBuffing",
  nav: "EnableNavigation",
  loot: "EnableLooting",
  meta: "EnableMeta",
});

/** Main tab: ranges, behaviour switches and pets (G:14-42 minus the subsystems;
 *  2026-10-19: + the attack minimum / disengage ranges, Target lock and Start
 *  on login, made live that day). */
export const MAIN_LAYOUT = Object.freeze({
  ranges: Object.freeze(["MonsterRange", "RingRange", "ApproachRange", "FollowNavMin", "AttackMinDistance", "MonsterDisengageRange"]),
  behaviour: Object.freeze([
    "BoostNavPriority", "BoostLootPriority", "PeaceModeWhenIdle", "RebuffWhenIdle", "EnableAutostack", "EnableAutocram",
    "UseDispelItems", "CastDispelSelf", "AutoFellowMgmt", "ManaChargesWhenOff", "TargetLock", "StartMacroOnLogin",
  ]),
  pets: Object.freeze(["SummonPets", "CustomPetRangeEnabled", "CustomPetRange", "PetMinMonsters"]),
});

/** Main tab: the vitals matrix (G:60-66) — top-off and in-combat levels per
 *  vital, the "others" levels and distances VTank's helper heals fellows at
 *  (2026-10-19) with its switches, plus the emergency Stamina→Health rule and
 *  the Stamina→Mana floor (rynth/vitals.js B15/B16). */
export const VITALS_KEYS = Object.freeze({
  topOff: Object.freeze({ hp: "TopOffHP", st: "TopOffStam", mn: "TopOffMana" }),
  combat: Object.freeze({ hp: "HealAt", st: "RestamAt", mn: "GetManaAt" }),
  others: Object.freeze({ hp: "HealOthersAt", st: "RestamOthersAt", mn: "InfuseOthersAt" }),
  othersRange: Object.freeze({ hp: "HelperHealDistance", st: "HelperRestamDistance", mn: "HelperInfuseDistance" }),
  helpers: Object.freeze(["DoHelp", "UseHealersHeart", "JumpOutWandCasting"]),
  emergencyHp: "EmergencyHP",
  emergencyStamFloor: "EmergencyStamFloor",
  manaRechargeStamFloor: "ManaRechargeStamFloor",
});

export const BUFFS_TAB_KEYS = Object.freeze(["RebuffSecondsRemaining", "BuffTierSkillCap"]);
/** Drawn by the Buffs tab's item-buff matrix (its "Worn armor" row), not as rows. */
const BUFFS_MATRIX_KEYS = Object.freeze(["BuffArmorImpen", "BuffProfileBanes"]);
/** Loot tab knobs: the value floor and corpse ranges, whose corpses (VTank's
 *  ownership rule), and what happens after a corpse (2026-10-19). */
export const LOOT_TAB_KEYS = Object.freeze([
  "LootMinValue", "CorpseApproachRangeMax", "CorpseApproachRangeMin",
  "LootFellowCorpses", "LootAllCorpses", "LootOnlyRareCorpses", "ReadUnknownScrolls", "CombineSalvage",
]);
/** Never drawn: Show Editor has no function (deprecated in VTank too, G:58). */
const HIDDEN_KEYS = Object.freeze(["ShowEditor"]);

const HOME = new Map();
const home = (keys, where) => {
  for (const k of keys) HOME.set(k, where);
};
home(Object.values(SUBSYSTEM_KEYS), "bar");
home([...MAIN_LAYOUT.ranges, ...MAIN_LAYOUT.behaviour, ...MAIN_LAYOUT.pets], "main");
home([
  ...Object.values(VITALS_KEYS.topOff), ...Object.values(VITALS_KEYS.combat),
  ...Object.values(VITALS_KEYS.others), ...Object.values(VITALS_KEYS.othersRange), ...VITALS_KEYS.helpers,
  VITALS_KEYS.emergencyHp, VITALS_KEYS.emergencyStamFloor, VITALS_KEYS.manaRechargeStamFloor,
], "main");
home(BUFFS_TAB_KEYS, "buffs");
home(BUFFS_MATRIX_KEYS, "buffs");
home(LOOT_TAB_KEYS, "loot");
home(["ShowTerrainPassability"], "route"); // the Route tab's "Steep" switch
home(HIDDEN_KEYS, "hidden");

/** Where the panel shows a setting: "bar" | "main" | "buffs" | "loot" | "route" | "hidden" | "advanced". */
export function settingHome(key) {
  return HOME.get(String(key)) || "advanced";
}

// ── live vitals (no bot needed) ────────────────────────────────────────────

// SessionHandle.playerStats().vitals: stride-4 [type, current, base, max];
// types = rynth/vitals.js VITAL_HEALTH 1 / STAMINA 3 / MANA 5 (the same read
// as rynth/hud_bridge.js readPlayerVitals; C2 keeps the bridge self-contained).
const VITAL_SLOT = Object.freeze({ 1: "hp", 3: "st", 5: "mn" });

/** { hp, st, mn } → { cur, max } | null. The wasm stats box is copied, then freed. */
export function readVitals(handle) {
  const out = { hp: null, st: null, mn: null };
  const v = safe(() => {
    const box = handle?.playerStats?.();
    try {
      return Array.from(box?.vitals || []).map(Number);
    } finally {
      try {
        if (box && typeof box.free === "function") box.free();
      } catch {
        /* already freed */
      }
    }
  }, []) || [];
  for (let i = 0; i + 3 < v.length; i += 4) {
    const slot = VITAL_SLOT[v[i]];
    if (slot && v[i + 3] > 0) out[slot] = { cur: Math.max(0, v[i + 1]), max: v[i + 3] };
  }
  return out;
}

// ── view-models ────────────────────────────────────────────────────────────

/** Active profile summary (the command bar's profile select and read-only chip). */
export function profileSummary(options) {
  const a = safe(() => options?.profiles?.active?.(), null);
  if (!a) return null;
  const kind = String(a.kind ?? "default");
  return {
    name: String(a.name ?? "Default"),
    kind,
    writable: a.writable !== false && kind !== "default",
    label: kind === "char" ? `[Char] ${a.name}` : String(a.name ?? "Default"),
    readOnly: kind === "default",
  };
}

const PROFILE_LIST_TTL_MS = 2000;

/**
 * The command bar (every tab, every refresh): the five subsystem switches,
 * the profile list for the select (ProfileStore.list() walks storage keys, so
 * it is reused for a moment — `cache` is the caller's { at, options, list }),
 * and the Mine Only state. `live` = { navStatus } from the snapshot's single
 * bot.vt read: a paused route shows its switch as paused.
 */
export function headerView(options, { now = Date.now(), cache = null, navStatus = null } = {}) {
  const value = (k) => safe(() => options?.getValue?.(k), null);
  const switches = {};
  for (const [id, key] of Object.entries(SUBSYSTEM_KEYS)) {
    switches[id] = { key, on: !!value(key), available: !!options };
  }
  if (navStatus && navStatus.paused) switches.nav.paused = String(navStatus.paused.reason || navStatus.paused);
  let list;
  if (cache && cache.options === options && now - cache.at < PROFILE_LIST_TTL_MS) list = cache.list;
  else {
    list = (safe(() => options?.profiles?.list?.(), []) || []).map((p) => ({
      name: String(p.name ?? ""),
      kind: String(p.kind ?? ""),
      label: String(p.label ?? p.name ?? ""),
    }));
    if (cache) Object.assign(cache, { at: now, options, list });
  }
  const active = profileSummary(options);
  return {
    switches,
    profiles: list,
    active,
    mineOnly: !!(active && (active.kind === "char" || active.kind === "bychar")),
    presets: ["vtank"],
  };
}

/** Main tab: ranges, the vitals matrix (with the player's live vitals), behaviour switches, pets. */
export function mainTabView(options, live = null) {
  const byKey = new Map(allRows(options).map((r) => [r.key, r]));
  const pick = (keys) => keys.map((k) => byKey.get(k)).filter(Boolean);
  const trio = (o) => ({ hp: byKey.get(o.hp) || null, st: byKey.get(o.st) || null, mn: byKey.get(o.mn) || null });
  return {
    available: byKey.size > 0,
    ranges: pick(MAIN_LAYOUT.ranges),
    behaviour: pick(MAIN_LAYOUT.behaviour),
    pets: pick(MAIN_LAYOUT.pets),
    vitals: {
      topOff: trio(VITALS_KEYS.topOff),
      combat: trio(VITALS_KEYS.combat),
      others: trio(VITALS_KEYS.others),
      othersRange: trio(VITALS_KEYS.othersRange),
      helpers: pick(VITALS_KEYS.helpers),
      emergencyHp: byKey.get(VITALS_KEYS.emergencyHp) || null,
      emergencyStamFloor: byKey.get(VITALS_KEYS.emergencyStamFloor) || null,
      manaRechargeStamFloor: byKey.get(VITALS_KEYS.manaRechargeStamFloor) || null,
      live: live && typeof live === "object" ? live : { hp: null, st: null, mn: null },
    },
  };
}

/** The rows of `keys` (in that order) — the Buffs and Loot tabs' own knobs. */
export function rowsFor(options, keys) {
  const byKey = new Map(allRows(options).map((r) => [r.key, r]));
  return keys.map((k) => byKey.get(k)).filter(Boolean);
}

/**
 * Advanced tab: every row no other tab shows, grouped, inert ("Not on web")
 * last. With a filter it searches EVERY row (name, label, VTank name, group)
 * and says where each one normally lives (`home`).
 */
export function advancedTabView(options, filter = "") {
  const f = String(filter ?? "").trim().toLowerCase();
  const all = allRows(options).map((r) => ({ ...r, home: settingHome(r.key) }));
  const rows = f ? all.filter((r) => advancedMatch(r, f)) : all.filter((r) => r.home === "advanced");
  const order = (r) => {
    const i = PAGE_ORDER.indexOf(r.page);
    return i < 0 ? PAGE_ORDER.length : i;
  };
  const sorted = rows.map((r, i) => [r, i]).sort((a, b) => order(a[0]) - order(b[0]) || a[1] - b[1]).map((x) => x[0]);
  const live = sorted.filter((r) => !r.inert);
  const inert = sorted.filter((r) => r.inert);
  return {
    filter: f,
    searching: !!f,
    groups: groupRows(live),
    inert: groupRows(inert),
    count: live.length,
    inertCount: inert.length,
    total: all.length,
  };
}

// ── commands ───────────────────────────────────────────────────────────────

/**
 * opt + profiles namespaces. `getOptions()` resolves the layer's VtOptions,
 * else the page session's (works with no bot).
 */
export function createOptionsCommands({ getOptions }) {
  const need = () => {
    const o = getOptions();
    if (!o) throw new Error("no VTank settings yet — log in first (the page session appears with the character)");
    return o;
  };
  const opt = {
    list: command((filter) => ok({ rows: allRows(need()).filter((r) => !filter || advancedMatch(r, filter)) })),
    get: command((name) => {
      const r = need().get(String(name ?? ""), { vtUnits: false });
      return r && r.ok ? ok({ key: r.key ?? r.row?.key, value: r.value, row: r.row ? rowView({ row: r.row, value: r.value }) : null }) : asResult(r);
    }),
    set: command((name, value) => asResult(need().set(String(name ?? ""), value, { source: "ui" }))),
    applyPreset: command((name) => asResult(need().applyPreset(String(name ?? "vtank")))),
  };
  const profiles = {
    list: command(() => {
      const o = need();
      return ok({ profiles: safe(() => o.profiles.list(), []) || [], active: profileSummary(o) });
    }),
    select: command((name, kind) => asResult(need().selectProfile(name, kind))),
    saveAs: command((name, mineOnly = false) => asResult(need().saveAs(String(name ?? "").trim(), { mineOnly: !!mineOnly }))),
    remove: command((name, kind) => {
      const o = need();
      const a = safe(() => o.profiles.active(), null);
      const isActive =
        a && (kind ? a.kind === kind : true) && String(a.name).toLowerCase() === String(name ?? "").toLowerCase();
      // Removing the active profile: select Default first so the loops get
      // Default's values through the authority (ProfileStore.remove alone
      // would switch silently, without a push or an onChange).
      if (isActive) {
        const s = o.selectProfile("Default", "default");
        if (s && s.ok === false) return asResult(s);
      }
      if (!o.profiles || !isFn(o.profiles.remove)) return fail("profiles cannot be removed here");
      return asResult(o.profiles.remove(name, kind));
    }),
    setMineOnly: command((on) => asResult(need().setMineOnly(!!on))),
    importHud: command(() => asResult(need().importHud())),
  };
  return { opt, profiles };
}

function advancedMatch(r, filter) {
  const f = String(filter).trim().toLowerCase();
  if (!f) return true;
  return [r.key, r.label, r.group, r.page, ...r.vtNames].some((s) => String(s).toLowerCase().includes(f));
}
