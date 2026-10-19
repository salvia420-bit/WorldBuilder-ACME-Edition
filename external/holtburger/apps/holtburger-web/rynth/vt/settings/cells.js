// rynth/vt/settings/cells.js — live cells over a bot object (PLAN §4.4).
//
// For keys whose runtime storage already exists in a loop, the loop field IS
// the storage (D4: no shadow copy): get() reads the field, set() writes it the
// same way the HUD / director / operator control do. A missing loop (or a
// field a loop does not have yet) reads `undefined`, and VtOptions then falls
// back to the profile value — so this works against today's loops and the
// INT-1 versions alike.
//
//   EnableCombat/Looting/Buffing  loop.enabled !== false; set via
//                                 bot.control.setEnabled (operator_stop.js),
//                                 fallback loop.enabled = v; Buffing true with
//                                 no loop ⇒ bot.setBuffs(profile spec ?? "auto")
//   MonsterRange                  combat.monsterRangeM (+ host.nearbyRangeM =
//                                 max(base, MonsterRange+5, ApproachRange+5,
//                                 MonsterDisengageRange+5), each term only when
//                                 that range exceeds its schema default (40 /
//                                 4 m; the disengage one only past Monster
//                                 Range: Default never moves a configured
//                                 base), base = host.nearbyRangeM
//                                 at creation, 0 = unlimited ⇒ untouched;
//                                 combat.invalidateScan())
//   HealAt … ManaRechargeStamFloor vitals.cfg[field]
//   LootMinValue / CorpseApproachRangeMax   loot.minValue / loot.corpseRangeM
//   RebuffSecondsRemaining        buff.rebuffSecondsRemaining
//   Melee/MissileAttackPower, AttackHeight  combat.meleePower / missileAccuracy / attackHeight
//   BlacklistAttempts / BlacklistTimeoutSec combat.blacklistAttempts / blacklistTimeoutMs ÷ 1000
//   list buffs                    { spec: bot.buffSpec ?? null } / bot.setBuffs(spec)
//   list legacyPriorities         combat.priorities (assigned a copy)
//
// set(key, value, ctx) — ctx (supplied by VtOptions) = { getValue(key),
// recordList(name), buffSpec() /* the spec the bot is about to have, or undefined */ }.
// Never throws; → { ok: true, pending?, spec? } | { ok: false, error } (`pending` =
// the bot.setBuffs() promise, `spec` = the spec handed to it).

import { VITALS_FIELD_KEYS, findRow } from "./schema.js";

const LOOPS = {
  combat: (b) => b?.combat ?? b?.kernel?.combat ?? null,
  loot: (b) => b?.loot ?? b?.kernel?.loot ?? null,
  buff: (b) => b?.buff ?? b?.kernel?.buff ?? null,
  vitals: (b) => b?.vitals ?? b?.kernel?.vitals ?? null,
};

const ENABLE = { EnableCombat: "combat", EnableLooting: "loot", EnableBuffing: "buff" };

/** canonical key → [loop, field, scale?] */
const FIELDS = {
  MonsterRange: ["combat", "monsterRangeM"],
  LootMinValue: ["loot", "minValue"],
  CorpseApproachRangeMax: ["loot", "corpseRangeM"],
  RebuffSecondsRemaining: ["buff", "rebuffSecondsRemaining"],
  MeleeAttackPower: ["combat", "meleePower"],
  MissileAttackPower: ["combat", "missileAccuracy"],
  AttackHeight: ["combat", "attackHeight"],
  BlacklistAttempts: ["combat", "blacklistAttempts"],
  BlacklistTimeoutSec: ["combat", "blacklistTimeoutMs", 1000],
};

const VITALS = {};
for (const [field, key] of Object.entries(VITALS_FIELD_KEYS)) VITALS[key] = field;

/** Cell keys that are new in this project: the profile owns them, so they are
 *  always pushed with their resolved value (§4.5) and re-pushed when their
 *  loop appears or is replaced (VtOptions.syncCells). */
export const PROFILE_OWNED_CELLS = Object.freeze(["MonsterRange", "CorpseApproachRangeMax", "RebuffSecondsRemaining"]);
/** Legacy cells NO boot path carries to a rebuilt bot: the takeover carry-over
 *  (boot.js captureLiveSettings) and hudBootOverrides() cover the enable flags,
 *  priorities, loot floor, buffs and vitals, but a new bot always starts these
 *  at the combat_loop ctor defaults. A later attach (legacy:false) therefore
 *  re-pushes the value the active profile / Default overlay STORES — else the
 *  2 s autosave would drop it from the profile (nothing stored ⇒ no push, so
 *  Default with an empty overlay stays byte-identical). */
export const BOOT_UNCARRIED_CELLS = Object.freeze([
  "MeleeAttackPower", "MissileAttackPower", "AttackHeight", "BlacklistAttempts", "BlacklistTimeoutSec",
]);
export const CELL_LISTS = Object.freeze(["buffs", "legacyPriorities"]);
export const CELL_KEYS = Object.freeze([...Object.keys(ENABLE), ...Object.keys(FIELDS), ...Object.keys(VITALS)]);

const ALL = new Set([...CELL_KEYS, ...CELL_LISTS]);

function safe(fn, dflt = undefined) {
  try {
    const v = fn();
    return v === undefined ? dflt : v;
  } catch {
    return dflt;
  }
}

const errText = (e) => String(e && e.message ? e.message : e);

/** The schema defaults of the two ranges that derive host.nearbyRangeM. */
const RANGE_DFLT = Object.freeze({
  monster: Number(findRow("MonsterRange")?.row?.dflt ?? 40),
  approach: Number(findRow("ApproachRange")?.row?.dflt ?? 4),
});

function sameSpec(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (Number(a[i]) !== Number(b[i])) return false;
  return true;
}

/**
 * @param bot the createGrindBot() object (or a fake with the same fields)
 * → { has(key), get(key), set(key, value, ctx?), keys(), owner(key), refreshDerived(ctx?) }
 */
export function createLiveCells(bot) {
  const nearbyBase = safe(() => {
    const v = Number(bot?.host?.nearbyRangeM);
    return Number.isFinite(v) ? v : 60;
  }, 60);

  const loopOf = (name) => safe(() => LOOPS[name](bot), null) || null;

  function owner(key) {
    if (ENABLE[key]) return loopOf(ENABLE[key]);
    if (FIELDS[key]) return loopOf(FIELDS[key][0]);
    if (VITALS[key]) return loopOf("vitals");
    if (key === "legacyPriorities") return loopOf("combat");
    if (key === "buffs") return bot || null;
    return null;
  }

  function get(key) {
    try {
      if (ENABLE[key]) {
        const loop = loopOf(ENABLE[key]);
        return loop ? loop.enabled !== false : undefined;
      }
      if (FIELDS[key]) {
        const [name, field, scale] = FIELDS[key];
        const loop = loopOf(name);
        const v = loop ? loop[field] : undefined;
        if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
        return scale ? v / scale : v;
      }
      if (VITALS[key]) {
        const cfg = loopOf("vitals")?.cfg;
        const v = cfg ? cfg[VITALS[key]] : undefined;
        return typeof v === "number" && Number.isFinite(v) ? v : undefined;
      }
      if (key === "legacyPriorities") {
        const combat = loopOf("combat");
        if (!combat) return undefined;
        const p = combat.priorities;
        return p && typeof p === "object" ? p : {};
      }
      if (key === "buffs") {
        if (!bot || typeof bot !== "object" || !("buffSpec" in bot)) return undefined;
        const s = bot.buffSpec;
        return { spec: s === "auto" || Array.isArray(s) ? s : null };
      }
    } catch {
      /* a broken bot surface reads as "no cell value" */
    }
    return undefined;
  }

  function refreshDerived(ctx = {}) {
    try {
      const host = bot?.host;
      if (!host || !(nearbyBase > 0)) return; // 0 = every tracked entity: never narrow it
      const combat = loopOf("combat");
      let mr = combat ? Number(combat.monsterRangeM) : NaN;
      if (!Number.isFinite(mr)) mr = Number(ctx.getValue?.("MonsterRange"));
      let ar = Number(ctx.getValue?.("ApproachRange"));
      if (!Number.isFinite(mr)) mr = 0;
      if (!Number.isFinite(ar)) ar = 0;
      // Only a range beyond the schema default (the old literals the bot
      // shipped with) widens the scan: at Default a configured nearbyRangeM
      // below MonsterRange+5 stays exactly as configured (V-2, review regress-2).
      // A Monster disengage range beyond Monster Range widens it too, so the
      // engaged target stays visible out to it (2026-10-19; 0 = auto, +3 m,
      // inside the margin).
      let dr = Number(ctx.getValue?.("MonsterDisengageRange"));
      if (!Number.isFinite(dr)) dr = 0;
      const need = Math.max(
        mr > RANGE_DFLT.monster ? mr + 5 : 0,
        ar > RANGE_DFLT.approach ? ar + 5 : 0,
        dr > mr && dr > RANGE_DFLT.monster ? dr + 5 : 0,
      );
      const want = Math.max(nearbyBase, need);
      if (host.nearbyRangeM !== want) host.nearbyRangeM = want;
    } catch {
      /* ignore */
    }
  }

  function setEnable(key, v, ctx) {
    const sub = ENABLE[key];
    const on = v === true;
    const loop = loopOf(sub);
    const ctl = safe(() => bot.control, null);
    if (loop && ctl && typeof ctl.setEnabled === "function") {
      const r = safe(() => ctl.setEnabled(sub, on), null);
      if (r && r.ok !== false) return { ok: true };
    }
    if (loop) {
      try {
        loop.enabled = on;
        return { ok: true };
      } catch (e) {
        return { ok: false, error: `${key}: ${errText(e)}` };
      }
    }
    if (key === "EnableBuffing" && on && bot && typeof bot.setBuffs === "function") {
      const rs = safe(() => ctx.recordList?.("buffs")?.spec, null);
      const spec = rs === "auto" || Array.isArray(rs) ? rs : "auto";
      try {
        const p = bot.setBuffs(Array.isArray(spec) ? spec.slice() : spec);
        if (p && typeof p.catch === "function") p.catch(() => {});
        return { ok: true, pending: p, spec };
      } catch (e) {
        return { ok: false, error: `${key}: ${errText(e)}` };
      }
    }
    return { ok: true }; // no loop: the profile keeps the value
  }

  function set(key, value, ctx = {}) {
    try {
      if (ENABLE[key]) return setEnable(key, value, ctx);
      if (FIELDS[key]) {
        const [name, field, scale] = FIELDS[key];
        const n = Number(value);
        if (!Number.isFinite(n)) return { ok: false, error: `${key}: not a number` };
        const loop = loopOf(name);
        if (loop) loop[field] = scale ? Math.round(n * scale) : n;
        if (key === "MonsterRange") {
          if (loop && typeof loop.invalidateScan === "function") safe(() => loop.invalidateScan());
          refreshDerived(ctx);
        }
        return { ok: true };
      }
      if (VITALS[key]) {
        const n = Number(value);
        if (!Number.isFinite(n)) return { ok: false, error: `${key}: not a number` };
        const vit = loopOf("vitals");
        if (vit && vit.cfg && typeof vit.cfg === "object") vit.cfg[VITALS[key]] = n;
        return { ok: true };
      }
      if (key === "legacyPriorities") {
        const combat = loopOf("combat");
        if (combat) combat.priorities = { ...(value && typeof value === "object" ? value : {}) };
        return { ok: true };
      }
      if (key === "buffs") {
        const spec = value && typeof value === "object" ? value.spec : null;
        if (spec !== "auto" && !Array.isArray(spec)) return { ok: true }; // no buff list in the profile: leave the bot's
        if (!bot || typeof bot.setBuffs !== "function") return { ok: true };
        // bot.setBuffs() is async and serialised (bot.buffSpec changes when a
        // call's turn runs): compare with the spec the bot is GOING to have
        // (ctx.buffSpec, VtOptions' in-flight push) so a revert to the value
        // bot.buffSpec still shows is not swallowed.
        const ahead = typeof ctx.buffSpec === "function" ? safe(() => ctx.buffSpec(), undefined) : undefined;
        if (sameSpec(ahead !== undefined ? ahead : safe(() => bot.buffSpec, null), spec)) return { ok: true };
        const p = bot.setBuffs(Array.isArray(spec) ? spec.slice() : spec);
        if (p && typeof p.catch === "function") p.catch(() => {});
        return { ok: true, pending: p, spec: Array.isArray(spec) ? spec.slice() : spec };
      }
      return { ok: false, error: `no live cell for ${key}` };
    } catch (e) {
      return { ok: false, error: `${key}: ${errText(e)}` };
    }
  }

  return {
    has: (key) => ALL.has(key),
    get,
    set,
    keys: () => [...ALL],
    owner,
    refreshDerived,
  };
}
