// rynth/vt/formats/utl_eval.js — VT Classic Looter rule evaluation (W1-3 FMT,
// PLAN §3.6, §2.2 P8; port of RynthAi Loot/VTankLootEvaluator.cs, U7a §5.9).
//
// evaluateUtl(profile, item, opts?) walks the rules in file order. A rule
// matches when ALL its conditions match (no conditions ⇒ matches). Each
// condition is three-valued: true, false, or PENDING — the item has not been
// appraised yet (`item.hasAppraisal === false`) and a value the node needs is
// unknown (an accessor returned null/undefined). The first rule that is not
// definitely false decides: matched ⇒ its action; pending ⇒ `pending:true`
// (the loot loop holds the item and asks again after the appraisal). Once
// appraised, an absent property reads as 0 / 0.0 / "" (C# Values(key, 0)).
//
// UtlItemCtx (PLAN §3.6; null = unknown):
//   { name, objectClass, hasAppraisal, intProp(id), floatProp(id), strProp(id),
//     boolProp(id), didProp(id), spellIds(), charSkillBuffed(id), charSkillBase(id) }
// Optional extensions read when present: spellNames() → string[] (Spell Name
// Match / Spell Match; without it those nodes are optimistic, as C# with no
// host), charLevel(), charPackSlotsFree(), palettes() → [{subId}|number].
// Keys are passed through untouched (VTank keys are the AC STypeInt /
// STypeFloat / STypeString ids, same as C#).
//
// C# fidelity notes (kept, reported in `unsupported`): colour nodes 14-16 need
// portal.dat ⇒ optimistic true; DamagePercentGE and CalcedBuffedTinkedTarget-
// MeleeGE ⇒ false; Buffed* read the raw item values; CustomExpression is
// ignored; an unknown node type or unparseable data ⇒ the rule does not match.
// Fixed: max damage is STypeInt DAMAGE (44) — C# read 54 (WEAPON_ENCUMBRANCE);
// a ',' in a double is a decimal comma (VTClassic) — C# dropped it as grouping.
//
// Regexes are .NET patterns, matched case-insensitively. opts.getRegex
// (EXPR's translator, injected by INT-2 — C2 forbids importing expr/) is used
// when given; otherwise a small built-in translation + cache.

import { UTL_ACTIONS, DISABLED_RULE, utlActionCode, utlNodeType } from "./utl.js";

const PENDING = Symbol("pending");
const DAMAGE = 44; // STypeInt DAMAGE (max damage)
const DAMAGE_VARIANCE = 22; // STypeFloat DAMAGE_VARIANCE
const ELEMENTAL_DAMAGE_MOD = 152; // STypeFloat ELEMENTAL_DAMAGE_MOD
const RATINGS = [370, 371, 372, 373, 374, 375, 376, 379]; // GearDamage … GearMaxHealth (C# MatchTotalRatingsGE)

const ACTION_RESULT = { 1: "keep", 2: "salvage", 3: "sell", 4: "read", 10: "keepUpTo" };

// ── regex (built-in .NET subset) ───────────────────────────────────────────
const RX_CACHE = new Map();
const RX_MAX = 512;
function builtinRegex(pattern) {
  const key = String(pattern ?? "");
  if (RX_CACHE.has(key)) return RX_CACHE.get(key);
  let src = key.replace(/^\(\?i\)/, "");
  src = src.replace(/\(\?'([A-Za-z_][A-Za-z0-9_]*)'/g, "(?<$1>").replace(/\\A/g, "^").replace(/\\[Zz]/g, "$");
  let rx = null;
  try {
    rx = new RegExp(src, "i");
  } catch {
    rx = null;
  }
  if (RX_CACHE.size >= RX_MAX) RX_CACHE.delete(RX_CACHE.keys().next().value);
  RX_CACHE.set(key, rx);
  return rx;
}

function safeRegex(make) {
  try {
    const rx = make();
    return rx instanceof RegExp ? rx : null;
  } catch {
    return null;
  }
}

// ── value access ───────────────────────────────────────────────────────────
function call(item, fn, ...args) {
  if (!item || typeof item[fn] !== "function") return null;
  try {
    const v = item[fn](...args);
    return v === null || v === undefined ? null : v;
  } catch {
    return null;
  }
}
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

class BadData extends Error {}
function int(d, i) {
  const t = String((d && d[i]) ?? "").trim();
  if (!/^[-+]?\d+$/.test(t)) throw new BadData(`data ${i + 1} ${JSON.stringify(t)} is not an integer`);
  return parseInt(t, 10);
}
// A ',' is a decimal comma, not a group separator: VTank writes doubles with
// "G" (no grouping) and VTClassic's HaxConvertDouble (Constants.cs) reads
// ',' as '.'. C# ReadDouble's AllowThousands turned "0,95" into 95.
function dbl(d, i) {
  const t = String((d && d[i]) ?? "")
    .trim()
    .replace(",", ".");
  const n = Number(t);
  if (!t || !Number.isFinite(n)) throw new BadData(`data ${i + 1} ${JSON.stringify(t)} is not a number`);
  return n;
}

/**
 * Evaluate a loot profile against one item.
 * → { action: "keep"|"salvage"|"sell"|"read"|"keepUpTo"|null, keepCount?, rule?, pending?, unsupported? }
 */
export function evaluateUtl(profile, item, opts = {}) {
  const unsupported = new Set();
  const injected = opts && typeof opts.getRegex === "function" ? opts.getRegex : null;
  const getRegex = injected ? (p) => safeRegex(() => injected(String(p ?? ""), "i")) : builtinRegex;
  const appraised = !!(item && item.hasAppraisal);
  const note = (s) => unsupported.add(s);
  // Unknown value: pending before the appraisal, the default after it.
  const need = (v, dflt) => (v === null || v === undefined ? (appraised ? dflt : PENDING) : v);
  const regex = (p) => {
    const rx = getRegex(p);
    if (!rx) note(`bad regular expression ${JSON.stringify(String(p))}`);
    return rx;
  };
  const numP = (fn, key) => {
    const v = call(item, fn, key);
    if (v === null) return need(null, 0);
    const n = Number(v);
    return Number.isFinite(n) ? n : need(null, 0);
  };
  const intP = (key) => numP("intProp", key);
  const floatP = (key) => numP("floatProp", key);
  const strP = (key) => {
    let v = call(item, "strProp", key);
    if ((v === null || v === undefined) && Number(key) === 1 && item && typeof item.name === "string") v = item.name;
    return need(v === null ? null : String(v), "");
  };
  const spellIds = () => {
    const v = call(item, "spellIds");
    return need(Array.isArray(v) ? v : null, []);
  };
  const spellNames = () => {
    if (!item || typeof item.spellNames !== "function") return undefined; // capability absent
    const v = call(item, "spellNames");
    return need(Array.isArray(v) ? v : null, []);
  };
  const maxDamage = () => intP(DAMAGE);

  // One node → true | false | PENDING.
  const evalNode = (c) => {
    const type = Number(c && c.type);
    const d = Array.isArray(c && c.data) ? c.data : [];
    switch (type) {
      case 0: {
        // SpellNameMatch
        const names = spellNames();
        if (names === undefined) {
          note("SpellNameMatch (no spell names)");
          return true;
        }
        if (names === PENDING) return PENDING;
        const rx = regex(d[0]);
        return !!rx && names.some((n) => typeof n === "string" && n && rx.test(n));
      }
      case 1: {
        const key = int(d, 1);
        const s = strP(key);
        if (s === PENDING) return PENDING;
        const rx = regex(d[0]);
        return !!rx && rx.test(s);
      }
      case 2:
      case 3:
      case 12:
      case 13: {
        const val = int(d, 0);
        const x = intP(int(d, 1));
        if (x === PENDING) return PENDING;
        return type === 2 ? x <= val : type === 3 ? x >= val : type === 12 ? x === val : x !== val;
      }
      case 4:
      case 5: {
        const val = dbl(d, 0);
        const x = floatP(int(d, 1));
        if (x === PENDING) return PENDING;
        return type === 4 ? x <= val : x >= val;
      }
      case 6:
        note("DamagePercentGE (VTank always false)");
        return false;
      case 7: {
        const want = int(d, 0);
        const oc = item && isNum(item.objectClass) ? item.objectClass : null;
        const v = need(oc, 0);
        return v === PENDING ? PENDING : v === want;
      }
      case 8: {
        const ids = spellIds();
        return ids === PENDING ? PENDING : ids.length >= int(d, 0);
      }
      case 9: {
        const count = int(d, 2);
        const names = spellNames();
        if (names === undefined) {
          note("SpellMatch (no spell names)");
          return true;
        }
        if (names === PENDING) return PENDING;
        const pos = regex(d[0]);
        if (!pos) return false;
        const neg = String(d[1] ?? "").trim() ? regex(d[1]) : null;
        let n = 0;
        for (const name of names) {
          if (typeof name !== "string" || !name) continue;
          if (pos.test(name) && (!neg || !neg.test(name)) && ++n >= count) return true;
        }
        return false;
      }
      case 10:
      case 2000: {
        const threshold = dbl(d, 0);
        const max = maxDamage();
        if (max === PENDING) return PENDING;
        if (max === 0) return false;
        const variance = floatP(DAMAGE_VARIANCE);
        if (variance === PENDING) return PENDING;
        const min = max - variance * max;
        return type === 10 ? min >= threshold : (min + max) / 2 >= threshold;
      }
      case 11: {
        const flag = int(d, 0);
        const x = intP(int(d, 1));
        return x === PENDING ? PENDING : (x & flag) !== 0;
      }
      case 14:
      case 15:
      case 16:
        note(`${utlNodeType(type).name} (needs portal.dat; optimistic)`);
        return true;
      case 17: {
        const slot = int(d, 0);
        const palette = int(d, 1) >>> 0;
        if (!item || typeof item.palettes !== "function") {
          note("SlotExactPalette (no palette data; optimistic)");
          return true;
        }
        const pal = call(item, "palettes");
        const v = need(Array.isArray(pal) ? pal : null, []);
        if (v === PENDING) return PENDING;
        if (!v.length) return true; // C#: no palette data ⇒ true
        if (slot < 0 || slot >= v.length) return false;
        const sub = typeof v[slot] === "object" && v[slot] !== null ? v[slot].subId : v[slot];
        return ((Number(sub) >>> 0) & 0x00ffffff) === (palette & 0x00ffffff);
      }
      case 1000:
        return charCheck("charSkillBuffed", [int(d, 1)], (v) => v >= int(d, 0), "CharacterSkillGE");
      case 1001:
        return charCheck("charPackSlotsFree", [], (v) => v >= int(d, 0), "CharacterMainPackEmptySlotsGE");
      case 1002:
        return charCheck("charLevel", [], (v) => v >= int(d, 0), "CharacterLevelGE");
      case 1003:
        return charCheck("charLevel", [], (v) => v <= int(d, 0), "CharacterLevelLE");
      case 1004:
        return charCheck("charSkillBase", [int(d, 0)], (v) => v >= int(d, 1) && v <= int(d, 2), "CharacterBaseSkill");
      case 2001: {
        const threshold = dbl(d, 0);
        const max = maxDamage();
        if (max === PENDING) return PENDING;
        if (max === 0) return false;
        let bonus = call(item, "floatProp", ELEMENTAL_DAMAGE_MOD);
        bonus = isNum(bonus) && bonus >= 1 ? bonus : 1;
        return max * bonus >= threshold;
      }
      case 2003: {
        const val = dbl(d, 0);
        const x = intP(int(d, 1));
        return x === PENDING ? PENDING : x >= val;
      }
      case 2005: {
        const val = dbl(d, 0);
        const x = floatP(int(d, 1));
        return x === PENDING ? PENDING : x >= val;
      }
      case 2006: {
        const val = dbl(d, 0);
        const max = maxDamage();
        return max === PENDING ? PENDING : max >= val;
      }
      case 2007: {
        const threshold = dbl(d, 0);
        let total = 0;
        for (const k of RATINGS) {
          const v = intP(k);
          if (v === PENDING) return PENDING;
          total += v;
        }
        return total >= threshold;
      }
      case 2008:
        note("CalcedBuffedTinkedTargetMeleeGE (not implemented; false)");
        return false;
      case DISABLED_RULE:
        return String(d[0] ?? "false").trim().toLowerCase() !== "true";
      default:
        note(`unknown node type ${type} (rule does not match)`);
        return false;
    }
  };
  // Character data is not appraisal-gated: unknown ⇒ optimistic (C# null ctx).
  function charCheck(fn, args, test, what) {
    const v = call(item, fn, ...args);
    if (!isNum(v)) {
      note(`${what} (no character data; optimistic)`);
      return true;
    }
    return test(v);
  }

  const rules = profile && Array.isArray(profile.rules) ? profile.rules : [];
  const finish = (res) => {
    if (unsupported.size) res.unsupported = [...unsupported];
    return res;
  };
  for (const rule of rules) {
    if (!rule || typeof rule !== "object" || rule.enabled === false) continue;
    if (typeof rule.customExpr === "string" && rule.customExpr.trim()) note("CustomExpression (ignored)");
    let state = true;
    try {
      for (const c of Array.isArray(rule.conditions) ? rule.conditions : []) {
        const r = evalNode(c);
        if (r === false) {
          state = false;
          break;
        }
        if (r === PENDING) state = PENDING;
      }
    } catch (e) {
      if (!(e instanceof BadData)) throw e;
      note(`rule "${rule.name}": ${e.message} (rule does not match)`);
      state = false;
    }
    if (state === false) continue;
    if (state === PENDING) return finish({ action: null, pending: true, rule: String(rule.name ?? "") });
    const code = utlActionCode(rule.action);
    let action = ACTION_RESULT[code];
    if (!action) {
      note(`action ${JSON.stringify(rule.action)} (looted as Keep)`);
      action = "keep";
    }
    const res = { action, rule: String(rule.name ?? "") };
    if (code === UTL_ACTIONS.KeepUpTo) res.keepCount = Math.max(0, Math.trunc(Number(rule.keepCount) || 0));
    return finish(res);
  }
  return finish({ action: null });
}

/**
 * Loot decision for an evaluateUtl result.
 * keep/salvage/sell/read → "pickup"; keepUpTo → "pickup" iff
 * inventoryCount(rule) < keepCount (a missing counter counts 0); no match →
 * "skip"; pending → "pending".
 */
export function lootVerdict(result, opts = {}) {
  const inventoryCount = opts && typeof opts === "object" ? opts.inventoryCount : undefined;
  if (!result || typeof result !== "object") return "skip";
  if (result.pending) return "pending";
  if (!result.action) return "skip";
  if (result.action === "keepUpTo") {
    let have = 0;
    if (typeof inventoryCount === "function") {
      try {
        const n = Number(inventoryCount(result.rule));
        have = Number.isFinite(n) ? n : 0;
      } catch {
        have = 0;
      }
    }
    return have < (Number(result.keepCount) || 0) ? "pickup" : "skip";
  }
  return "pickup";
}

export default { evaluateUtl, lootVerdict };
