// RynthLootPolicy — pure, host-free loot rule evaluator (Phase-2 dark core).
//
// A VTank-semantics first-match evaluator over an item property bag, plus a
// port of Mag-LootParser's TierCalculator. This module is PURE: no host, no
// clock, no state — one call maps (itemBag, profile) -> a verdict. It is NOT
// wired into RynthLootLoop (deferred); the loop keeps its single Value(19)
// floor. This is the general-purpose policy layer the director can opt into
// later without changing the executor.
//
// Semantics mirrored (see docs/rynth-integration/netwasm-spike/LootScoring):
//   - First match wins; a profile is scanned in strict list order
//     (CorpseOpenController.cs:1394-1424). Rule priority is NOT used.
//   - Within a rule, ALL conditions must hold (AND). Zero conditions => the
//     rule matches unconditionally (VTankLootEvaluator.cs:143).
//   - Value(19) is the one property RynthLootLoop's own appraisal gate
//     already guarantees the caller has waited for (loot_loop.js
//     APPRAISE_TIMEOUT_MS / HasAppraisalData — LootScoring finding #1); a
//     still-missing Value legitimately degrades to 0, exactly like
//     Cache.Get*Property miss (AcStubs.cs:104-114). Every OTHER property this
//     module reads (workmanship/wield-*, armorLevel, the 370-379 ratings,
//     max-damage/variance) streams on the SAME appraisal response as Value —
//     but nothing upstream holds an item for THEM, so on a freshly-shifted
//     corpse item they are indistinguishable from "genuinely absent" (a
//     trophy item with no tier). Review 03 C2: silently reading these as 0
//     is an under-loot bug, not a feature — see the presence model below.
//   - Unmatched => verdict "leave" (no-loot => leave on corpse,
//     CorpseOpenController.cs:1373-1379). VTank has no "leave" action; we add
//     one as an explicit skip so a profile can positively drop an item.
//
// PRESENCE MODEL (03 C2 fix): a bag counts as fully appraised once its
// caller has observed Value(19) (`bag.appraised === true` is an explicit
// override for a caller that knows better, e.g. a test fixture). Every node
// type in APPRAISAL_GATED_TYPES (tierGE, armorLevelGE, medianDamageGE,
// totalRatingsGE — the exact "tier/armor/rating" rules 03 C2 named) treats
// its property as UNKNOWN, not 0, on an unappraised bag: matchRule scans the
// whole rule looking for an already-KNOWN failing condition (which fails the
// rule outright, appraisal or not — AND-short-circuit is still sound), and
// if none is found, the rule — and the whole evaluate() scan, since
// first-match-wins means a later rule's outcome cannot be trusted either
// until this one resolves — reports back PENDING rather than a verdict. A
// caller wiring this in must treat `pending:true` exactly like loot_loop's
// own Value gate: hold the item, request/await appraisal, re-evaluate next
// tick. valueGE is deliberately NOT gated here (see above): loot_loop
// already solved that one upstream, so re-gating it here would double the
// hold with no new information.
//
// SURVIVAL INVARIANT: evaluate() never throws. A malformed condition (unknown
// type, bad param) degrades to a non-match for that rule and the scan
// continues — mirroring VTank's per-rule try/catch (VTankLootEvaluator.cs:
// 145-158), and honoring "no throws into the director loop".
//
// Presets: greedy | selective | survival. The `greedy` preset with minValue=0
// reproduces RynthLootLoop's shipped behavior byte-for-byte: keep iff
// Value(19) >= minValue, else leave — INCLUDING for a fractional minValue
// (03 C1 fix: valueGE now compares the raw Number, matching loot_loop.js's
// plain `value < this.minValue` float compare exactly; the previous `| 0`
// truncation on the threshold made greedy(100.5) keep a Value-100 item that
// the live loop would skip — untested because the parity suite only sampled
// integer mins. The 32-bit truncation in `toInt`/`getInt` above is unrelated:
// it is C#'s own int32 semantics for an item's *own* Value/int properties,
// which are always integers on the wire; only the caller-supplied threshold
// was ever wrongly truncated).
//
// VERDICT → ACTION (03 C3 fix): the only existing precedent for turning a
// verdict into an executor action is loot_loop.js's netBrain shadow
// (`csPickup = Verdict==="keep"||Verdict==="salvage"`), which silently drops
// `sell`. That mapping is harmless there only because the shadow's one
// hand-built rule never emits "sell" — it is NOT a valid template for a real
// wire. VERDICT_ACTION_MAP below is the canonical map a future wiring must
// use instead.

// ── STypeInt property ids (Chorizite.Common/Enums/PropertyInt.cs) ───────────
const P_VALUE = 19;             // :42
const P_ARMOR_LEVEL = 28;       // :60
const P_WORKMANSHIP = 105;      // :214
const P_MATERIAL = 131;         // :266
const P_WIELD_REQ = 158;        // :320
const P_WIELD_SKILL = 159;      // :322
const P_WIELD_DIFF = 160;       // :324
const P_TINKERED = 171;         // :346  NumTimesTinkered
// LootScoring VTank keys (netwasm-spike): 54 == MAX_DAMAGE, float 22 ==
// DamageVariance (LootScoring.cs:254,:288). Named for the ported node only.
const P_MAX_DAMAGE = 54;
const PF_DAMAGE_VARIANCE = 22;
// TotalRatings int keys 370-376 + 379 (377/378 excluded, LootScoring.cs:232).
const RATING_KEYS = [370, 371, 372, 373, 374, 375, 376, 379];

// WieldRequirement (Chorizite.Common/Enums/WieldRequirement.cs)
const WR_RAW_SKILL = 2;   // :7
const WR_LEVEL = 7;       // :17

// SkillId weapon/magic ids for the wield-skill-type ladders
// (Chorizite.Common/Enums/SkillId.cs) — TierCalculator.cs:30-117.
const SK_WAR_MAGIC = 0x22;         // 34
const SK_TWOHAND = 0x29;           // 41
const SK_VOID_MAGIC = 0x2B;        // 43
const SK_HEAVY = 0x2C;             // 44
const SK_LIGHT = 0x2D;             // 45
const SK_FINESSE = 0x2E;           // 46
const SK_MISSILE = 0x2F;           // 47
const MELEE_SKILLS = new Set([SK_TWOHAND, SK_HEAVY, SK_LIGHT, SK_FINESSE]);
const MAGIC_SKILLS = new Set([SK_WAR_MAGIC, SK_VOID_MAGIC]);

// Cantrip level tokens for the optional pre-resolved spell ladder in tier().
const CANTRIP_MAJOR = 1;
const CANTRIP_EPIC = 2;
const CANTRIP_LEGENDARY = 3;

// ── property-bag reads ──────────────────────────────────────────────────────
// The bag is a plain object; `int`/`double` are maps keyed by SType id (number
// OR string keys accepted — JSON stringifies them). A few common properties may
// be supplied as top-level conveniences; the typed maps take precedence.
const INT_CONVENIENCE = { [P_VALUE]: "value", [P_ARMOR_LEVEL]: "armorLevel", [P_MATERIAL]: "material" };

// C# `int` truncation semantics (32-bit signed).
function toInt(v) {
  return v == null ? 0 : Number(v) | 0;
}

function hasInt(bag, key) {
  const m = bag.int;
  if (m && (Object.prototype.hasOwnProperty.call(m, key) || Object.prototype.hasOwnProperty.call(m, String(key))))
    return true;
  const c = INT_CONVENIENCE[key];
  return !!(c && bag[c] != null);
}

function getInt(bag, key, def) {
  const m = bag.int;
  if (m) {
    if (Object.prototype.hasOwnProperty.call(m, key)) return toInt(m[key]);
    const sk = String(key);
    if (Object.prototype.hasOwnProperty.call(m, sk)) return toInt(m[sk]);
  }
  const c = INT_CONVENIENCE[key];
  if (c && bag[c] != null) return toInt(bag[c]);
  return def;
}

function getDouble(bag, key, def) {
  const m = bag.double;
  if (m) {
    if (Object.prototype.hasOwnProperty.call(m, key)) return Number(m[key]);
    const sk = String(key);
    if (Object.prototype.hasOwnProperty.call(m, sk)) return Number(m[sk]);
  }
  return def;
}

function spellCount(bag) {
  if (bag.spellCount != null) return bag.spellCount | 0;
  if (Array.isArray(bag.spells)) return bag.spells.length;
  return 0;
}

// isAppraised(bag): has this item's non-Value properties actually streamed?
// Value(19) is universal (every AC object has one, even 0) and is exactly
// the property loot_loop's own appraisal gate waits on — so "Value has been
// observed" is the honest, already-anchored signal that a full appraisal
// response landed, not just a bare spawn/ObjDesc. `bag.appraised === true`
// is an explicit override for a caller (or test) that knows the bag is
// complete without needing to stuff a Value key in it.
function isAppraised(bag) {
  return bag.appraised === true || hasInt(bag, P_VALUE);
}

// ── TierCalculator port (Mag-LootParser/TierCalculator.cs) ───────────────────
// Single-item tier: -1 for a tinkered/actively-enchanted item, 0 when no tier
// can be derived (no workmanship, i.e. a non-lootgen "trophy" item), else 1..8.
// The C# iterates a set and returns the max; a bag is one item, so tier(bag)
// is that one item's contribution.
//
// The spell buff/cantrip ladder (TierCalculator.cs:151-170) needs a spell table
// (SpellTools.GetSpell) we do not carry here. A caller that HAS resolved levels
// may pass `bag.spellTiers = [{ buff: 1..8 }, { cantrip: 1|2|3 }, ...]` and the
// ladder is applied exactly as in the source; absent, that block is skipped
// (property-only tier). This is the module's one documented deviation.
function tier(bag) {
  if (!bag || typeof bag !== "object") return 0;
  // Tinkered OR carrying active enchantments => not lootgen-classifiable.
  if ((hasInt(bag, P_TINKERED) && getInt(bag, P_TINKERED, 0) > 0) || (bag.activeSpellCount | 0) > 0)
    return -1;

  let t = 0;
  // Exclude trophy items: no ItemWorkmanship => bypass the wield/workmanship
  // AND spell ladders (the C# spell block is itself guarded by workmanship).
  if (!hasInt(bag, P_WORKMANSHIP)) return t;

  const wieldReq = getInt(bag, P_WIELD_REQ, 0);
  const wieldSkill = getInt(bag, P_WIELD_SKILL, 0);

  if (wieldReq === WR_RAW_SKILL && hasInt(bag, P_WIELD_DIFF)) {
    const diff = getInt(bag, P_WIELD_DIFF, 0);
    // Melee ladder (TierCalculator.cs:30-59)
    if (MELEE_SKILLS.has(wieldSkill)) {
      if (diff === 250 && t < 2) t = 2;
      else if (diff === 300 && t < 3) t = 3;
      else if (diff === 325 && t < 4) t = 4;
      else if (diff === 350 && t < 5) t = 5;
      else if ((diff === 370 || diff === 400) && t < 6) t = 6;
      else if (diff === 420 && t < 7) t = 7;
      else if (diff === 430) t = 8;
    }
    // Missile ladder (:62-91)
    if (wieldSkill === SK_MISSILE) {
      if (diff === 250 && t < 2) t = 2;
      else if (diff === 270 && t < 3) t = 3;
      else if (diff === 290 && t < 4) t = 4;
      else if (diff === 315 && t < 5) t = 5;
      else if ((diff === 335 || diff === 360) && t < 6) t = 6;
      else if (diff === 375 && t < 7) t = 7;
      else if (diff === 385) t = 8;
    }
    // Magic ladder (:94-117)
    if (MAGIC_SKILLS.has(wieldSkill)) {
      if (diff === 290 && t < 4) t = 4;
      else if (diff === 310 && t < 5) t = 5;
      else if ((diff === 330 || diff === 355) && t < 6) t = 6;
      else if (diff === 375 && t < 7) t = 7;
      else if (diff === 385) t = 8;
    }
  }

  // Wield-by-Level ladder (:120-132)
  if (wieldReq === WR_LEVEL && hasInt(bag, P_WIELD_DIFF)) {
    const diff = getInt(bag, P_WIELD_DIFF, 0);
    if (diff === 150 && t < 7) t = 7;
    else if (diff === 180) t = 8;
  }

  // Workmanship ladder (:134-146)
  const wk = getInt(bag, P_WORKMANSHIP, 0);
  if (wk >= 1 && wk <= 5 && t < 1) t = 1;
  else if (wk === 6 && t < 2) t = 2;
  else if (wk === 7 && t < 3) t = 3;
  else if (wk === 8 && t < 4) t = 4;
  else if (wk === 9 && t < 5) t = 5;
  else if (wk === 10 && t < 6) t = 6;

  // Optional pre-resolved spell ladder (:151-170). Only when workmanship exists
  // (already guaranteed here) and the caller supplied resolved levels.
  if (Array.isArray(bag.spellTiers)) {
    for (const sp of bag.spellTiers) {
      const buff = sp ? sp.buff | 0 : 0;
      if (buff === 1 && t < 1) t = 1;
      else if (buff === 2 && t < 1) t = 1;
      else if (buff === 3 && t < 1) t = 1;
      else if (buff === 4 && t < 2) t = 2;
      else if (buff === 5 && t < 2) t = 2;
      else if (buff === 6 && t < 3) t = 3;
      else if (buff === 7 && t < 5) t = 5;
      else if (buff === 8 && t < 7) t = 7;
      const cantrip = sp ? sp.cantrip | 0 : 0;
      if (cantrip === CANTRIP_MAJOR && t < 2) t = 2;
      else if (cantrip === CANTRIP_EPIC && t < 7) t = 7;
      else if (cantrip === CANTRIP_LEGENDARY && t < 8) t = 8;
    }
  }

  return t;
}

// ── VTank node-type evaluators (numeric-property subset) ─────────────────────
// Each returns a boolean; a throw here is caught by matchRule and fails the
// rule (VTankLootEvaluator.cs:145-158 parity).
const NODES = {
  // Value(19) >= min — the loop's floor rule (LootScoring finding #2 shape).
  // 03 C1: compare the RAW threshold, not `c.min | 0` — loot_loop.js's own
  // `value < this.minValue` is a plain float compare with no rounding, so a
  // fractional minValue (e.g. 100.5) must be honored exactly, not truncated
  // toward keeping more than the live loop would (see header note).
  valueGE: (bag, c) => getInt(bag, P_VALUE, 0) >= Number(c.min),
  objClass: (bag, c) => (bag.objClass | 0) === (c.objClass | 0),
  intGE: (bag, c) => getInt(bag, c.key, 0) >= (c.value | 0),
  intLE: (bag, c) => getInt(bag, c.key, 0) <= (c.value | 0),
  intE: (bag, c) => getInt(bag, c.key, 0) === (c.value | 0),
  // (flag & prop) != 0 — LongValKeyFlagExists (LootScoring.cs:326).
  intFlag: (bag, c) => (getInt(bag, c.key, 0) & (c.flag | 0)) !== 0,
  tierGE: (bag, c) => tier(bag) >= (c.min | 0),
  armorLevelGE: (bag, c) => getInt(bag, P_ARMOR_LEVEL, 0) >= (c.min | 0),
  // BuffedMedianDamageGE (LootScoring.cs:453-461): maxDamage==0 => false.
  medianDamageGE: (bag, c) => {
    const maxD = getInt(bag, P_MAX_DAMAGE, 0);
    if (maxD === 0) return false;
    const variance = getDouble(bag, PF_DAMAGE_VARIANCE, 0.0);
    const minD = maxD - variance * maxD;
    return (minD + maxD) / 2.0 >= Number(c.min);
  },
  // MatchTotalRatingsGE (LootScoring.cs:476-483).
  totalRatingsGE: (bag, c) => {
    let total = 0;
    for (const k of RATING_KEYS) total += getInt(bag, k, 0);
    return total >= (c.min | 0);
  },
  spellCountGE: (bag, c) => spellCount(bag) >= (c.min | 0),
  materialIn: (bag, c) => {
    const mat = getInt(bag, P_MATERIAL, 0);
    return Array.isArray(c.materials) && c.materials.includes(mat);
  },
};

const VERDICTS = new Set(["keep", "salvage", "sell", "leave"]);

// Canonical verdict → executor-action map (03 C3). A future wire MUST
// consume this — not the netBrain shadow's inert `keep||salvage` — so a
// `sell`-tagged item ("grab it now, vendor it later", the entire rationale
// for having a sell verdict at all) is actually picked up instead of quietly
// left on the corpse.
const VERDICT_ACTION_MAP = Object.freeze({
  keep: "pickup",
  salvage: "pickup",
  sell: "pickup",
  leave: "skip",
});

// actionForVerdict(verdict) -> "pickup" | "skip". Unknown/garbage verdicts
// degrade to "skip" (survival invariant: never invent a pickup from data we
// don't recognize).
function actionForVerdict(verdict) {
  return VERDICT_ACTION_MAP[verdict] || "skip";
}

// Node types whose property is NOT guaranteed by loot_loop's own appraisal
// gate (that gate only covers Value(19) — see header PRESENCE MODEL). On an
// unappraised bag these must report "unknown", not a false 0-comparison.
const APPRAISAL_GATED_TYPES = new Set(["tierGE", "armorLevelGE", "medianDamageGE", "totalRatingsGE"]);

// Evaluate one rule: all conditions must hold (AND); unknown node type or a
// throwing condition fails the rule outright (survival — VTankLootEvaluator.
// cs:145-158 parity). An appraisal-gated condition on an unappraised bag is
// UNKNOWN rather than false: the rule can still be defeated by another,
// already-KNOWN failing condition in the same AND (order doesn't matter —
// every condition is checked), but if no known condition fails and at least
// one was unknown, the rule's outcome is PENDING, not a verdict.
// Returns { match: boolean, pending: boolean }.
function matchRule(bag, rule) {
  const conds = (rule && (rule.all || rule.conditions)) || [];
  let pending = false;
  for (const c of conds) {
    const type = c && c.type;
    const fn = type ? NODES[type] : null;
    if (!fn) return { match: false, pending: false }; // unknown node type => definite fail, no throw
    if (APPRAISAL_GATED_TYPES.has(type) && !isAppraised(bag)) {
      pending = true;
      continue; // can't resolve yet; keep scanning for a definite (known) false
    }
    let ok = false;
    try {
      ok = !!fn(bag, c);
    } catch {
      ok = false; // bad data line => rule fails (VTankLootEvaluator.cs:155-158)
    }
    if (!ok) return { match: false, pending: false }; // known false wins regardless of any unknown
  }
  return { match: !pending, pending };
}

/**
 * evaluate(itemBag, profile[, opts])
 *   -> { verdict, matched, pending, ruleIndex, ruleName, action }
 *
 * `profile` may be an array of rules, a { rules } object, or a preset NAME
 * ("greedy"|"selective"|"survival"), in which case `opts` parameterizes it.
 * verdict ∈ { keep, salvage, sell, leave }; unmatched => "leave".
 *
 * `pending` (03 C2): true when the scan hit a rule it cannot yet resolve —
 * one of its appraisal-gated conditions (tier/armor/rating/damage; see
 * APPRAISAL_GATED_TYPES) read UNKNOWN on this bag and no earlier condition
 * in that same rule was a known, definite false. When `pending` is true the
 * `verdict`/`action` fields are a SAFE DEFAULT ("leave"/"skip"), not a real
 * decision — a wiring caller must treat this exactly like loot_loop's own
 * Value(19) appraisal hold: do not act on the item yet, keep/re-request its
 * appraisal, and re-evaluate once more properties have streamed. The scan
 * stops at the first pending rule (first-match-wins means a later rule's
 * verdict can't be trusted either until the earlier one resolves).
 */
function evaluate(itemBag, profile, opts = {}) {
  const bag = itemBag || {};
  let rules;
  if (typeof profile === "string") rules = preset(profile, opts).rules;
  else if (Array.isArray(profile)) rules = profile;
  else rules = (profile && profile.rules) || [];

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    if (!rule) continue;
    const r = matchRule(bag, rule);
    if (r.pending) {
      return {
        verdict: "leave",
        matched: false,
        pending: true,
        ruleIndex: i,
        ruleName: rule.name || `#${i}`,
        action: "",
      };
    }
    if (r.match) {
      let action = String(rule.action || "keep").toLowerCase();
      if (!VERDICTS.has(action)) action = "keep"; // unknown action => keep (matched => loot)
      return {
        verdict: action,
        matched: true,
        pending: false,
        ruleIndex: i,
        ruleName: rule.name || `#${i}`,
        action,
      };
    }
  }
  return { verdict: "leave", matched: false, pending: false, ruleIndex: -1, ruleName: "", action: "" };
}

// ── presets (general-purpose; parameterized; no content literals) ────────────
// greedy: the loop's shipped policy — keep iff Value(19) >= minValue, else
// leave. minValue defaults to 0 => keep everything (byte-for-byte with today).
function greedy(opts = {}) {
  const minValue = opts.minValue ?? 0;
  return { rules: [{ name: "value-floor", action: "keep", all: [{ type: "valueGE", min: minValue }] }] };
}

// selective: a value/tier/rating/armor keep-ladder for a discerning grinder.
// Everything unmatched is left on the corpse.
function selective(opts = {}) {
  const minValue = opts.minValue ?? 250;
  const keepTier = opts.keepTier ?? 4;
  const minRatings = opts.minRatings ?? 100;
  const minArmor = opts.minArmor ?? 200;
  return {
    rules: [
      { name: "high-tier", action: "keep", all: [{ type: "tierGE", min: keepTier }] },
      { name: "valuable", action: "keep", all: [{ type: "valueGE", min: minValue }] },
      { name: "ratings", action: "keep", all: [{ type: "totalRatingsGE", min: minRatings }] },
      { name: "armor", action: "keep", all: [{ type: "armorLevelGE", min: minArmor }] },
    ],
  };
}

// survival: minimize pack pressure — keep only the clearly worthwhile.
function survival(opts = {}) {
  const minValue = opts.minValue ?? 5000;
  const keepTier = opts.keepTier ?? 6;
  return {
    rules: [
      { name: "high-value", action: "keep", all: [{ type: "valueGE", min: minValue }] },
      { name: "top-tier", action: "keep", all: [{ type: "tierGE", min: keepTier }] },
    ],
  };
}

const PRESET_BUILDERS = { greedy, selective, survival };

function preset(name, opts = {}) {
  const b = PRESET_BUILDERS[name];
  if (!b) throw new Error(`unknown loot preset "${name}"`);
  return b(opts);
}

export {
  evaluate, tier, preset, greedy, selective, survival, NODES, PRESET_BUILDERS,
  VERDICT_ACTION_MAP, actionForVerdict, isAppraised, APPRAISAL_GATED_TYPES,
};
export default {
  evaluate, tier, preset, greedy, selective, survival,
  VERDICT_ACTION_MAP, actionForVerdict,
};
