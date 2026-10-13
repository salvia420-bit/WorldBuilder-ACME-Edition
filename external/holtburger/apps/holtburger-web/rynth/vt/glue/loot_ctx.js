// rynth/vt/glue/loot_ctx.js — the VT Classic Looter (.utl) verdict hook for
// the loot loop (PLAN §3.14 `loot.classify`, §3.15 step 12; INT-2).
//
// makeLootClassify({ profile, getHost, getRegex, log }) → classify(guid, {host,
// now}) → "pickup" | "skip" | "pending" | null, built from:
//   * buildUtlItemCtx(host, guid) — the UtlItemCtx of formats/utl_eval.js over
//     host reads (int/float/string/bool/DID properties, HasAppraisalData,
//     appraisal spell ids + names, character skills/level/pack room);
//   * evaluateUtl(profile, ctx, { getRegex }) + lootVerdict(result, {
//     inventoryCount }) — KeepUpTo counts the inventory items (stack-aware)
//     that the SAME rule matches.
//
// Decal synthetic property keys (FMT review §5.2, binding): VTank .utl files
// (and UB metas) address some properties through Decal's LongValueKey /
// DoubleValueKey enums, whose values in the 0x0D000000 / 0x0A000000 blocks
// are NOT AC STypeInt / STypeFloat ids. The ones with evidence are mapped
// below; any other key in those blocks reads as unknown (pending before the
// appraisal, 0 after — the evaluator's rule) and is logged once.
//   0x0D000000 Type          → the weenie class id (C# ExpressionEngine.cs:2008; Discord)
//   0x0D000002 Container     → InstanceId 2 (CMD stdlib_host D-15)
//   0x0D000021 DamageType    → STypeInt 45  (Decal order: EquipSkill, DamageType, MaxDamage)
//   0x0D000022 MaxDamage     → STypeInt 44  (Discord metas: maxDamage = wobjectgetintprop[…,218103842])
//   0x0A000000…06 *Prot      → STypeFloat ArmorModVs Slash 13, Pierce 14, Bludgeon 15,
//                              Acid 18, Lightning 19, Fire 17, Cold 16 (Decal order)
//   0x0A000009 Workmanship   → STypeFloat 280 (C# ExpressionEngine.cs:2030; CMD D-15)
//   0x0A00000B Variance      → STypeFloat 22  (Discord: minDamage = max*(1-Variance))
//   0x0A00000C AttackBonus   → STypeFloat 62 WeaponOffense (Decal order; values ~1.16 seen)
//   0x0A00000E DamageBonus   → STypeFloat 63 DamageMod (Decal order)

import { evaluateUtl, lootVerdict } from "../formats/index.js";
import { objectClassFrom } from "../cmd/index.js";

const LONG_BLOCK = 0x0d000000;
const DOUBLE_BLOCK = 0x0a000000;

/** Decal LongValueKey (synthetic) → a reader spec. */
export const DECAL_LONG_KEYS = Object.freeze({
  [LONG_BLOCK + 0x00]: { wcid: true },
  [LONG_BLOCK + 0x02]: { iid: 2 },
  [LONG_BLOCK + 0x21]: { int: 45 },
  [LONG_BLOCK + 0x22]: { int: 44 },
});
/** Decal DoubleValueKey (synthetic) → STypeFloat. */
export const DECAL_DOUBLE_KEYS = Object.freeze({
  [DOUBLE_BLOCK + 0x00]: 13,
  [DOUBLE_BLOCK + 0x01]: 14,
  [DOUBLE_BLOCK + 0x02]: 15,
  [DOUBLE_BLOCK + 0x03]: 18,
  [DOUBLE_BLOCK + 0x04]: 19,
  [DOUBLE_BLOCK + 0x05]: 17,
  [DOUBLE_BLOCK + 0x06]: 16,
  [DOUBLE_BLOCK + 0x09]: 280,
  [DOUBLE_BLOCK + 0x0b]: 22,
  [DOUBLE_BLOCK + 0x0c]: 62,
  [DOUBLE_BLOCK + 0x0e]: 63,
});

const isLongSynthetic = (k) => k >= LONG_BLOCK && k < LONG_BLOCK + 0x01000000;
const isDoubleSynthetic = (k) => k >= DOUBLE_BLOCK && k < DOUBLE_BLOCK + 0x01000000;
const finite = (x) => typeof x === "number" && Number.isFinite(x);

function call(h, name, ...args) {
  const f = h && h[name];
  if (typeof f !== "function") return undefined;
  try {
    return f.apply(h, args);
  } catch {
    return undefined;
  }
}

const unknownWarned = new Set();
function warnUnknown(log, kind, key) {
  const tag = `${kind}:${key}`;
  if (unknownWarned.has(tag)) return;
  if (unknownWarned.size > 256) unknownWarned.clear();
  unknownWarned.add(tag);
  try {
    log?.(`loot profile reads Decal ${kind} key 0x${(key >>> 0).toString(16).toUpperCase()} — not mapped on web (reads as unknown)`);
  } catch {
    /* logging is best effort */
  }
}

/**
 * The UtlItemCtx for `guid` (formats/utl_eval.js). Every accessor returns
 * null when the value is unknown.
 */
export function buildUtlItemCtx(host, guid, { log = null } = {}) {
  const g = Number(guid) >>> 0;
  let appraisal;
  const ap = () => {
    if (appraisal === undefined) {
      const a = call(host, "TryGetObjectAppraisal", g);
      appraisal = a && typeof a === "object" ? a : null;
    }
    return appraisal;
  };
  let stats;
  const playerStats = () => {
    if (stats === undefined) stats = call(host, "TryGetPlayerStats") || null;
    return stats;
  };
  const num = (v) => {
    const n = typeof v === "boolean" ? (v ? 1 : 0) : Number(v);
    return v === null || v === undefined || !finite(n) ? null : n;
  };
  const hasAppraisal = call(host, "HasAppraisalData", g) === true;
  const ctx = {
    name: String(call(host, "TryGetObjectName", g) ?? ""),
    objectClass: objectClassFrom(call(host, "TryGetObjectIntProperty", g, 1), call(host, "TryGetObjectDescFlags", g)),
    hasAppraisal,
    intProp(id) {
      const k = Number(id) >>> 0;
      if (isLongSynthetic(k)) {
        const spec = DECAL_LONG_KEYS[k];
        if (!spec) {
          warnUnknown(log, "LongValueKey", k);
          return null;
        }
        if (spec.wcid) return num(call(host, "TryGetObjectWcid", g));
        if (spec.iid) return num(call(host, "TryGetObjectInstanceIdProperty", g, spec.iid));
        return num(call(host, "TryGetObjectIntProperty", g, spec.int));
      }
      return num(call(host, "TryGetObjectIntProperty", g, k));
    },
    floatProp(id) {
      const k = Number(id) >>> 0;
      if (isDoubleSynthetic(k)) {
        const sk = DECAL_DOUBLE_KEYS[k];
        if (sk === undefined) {
          warnUnknown(log, "DoubleValueKey", k);
          return null;
        }
        return num(call(host, "TryGetObjectDoubleProperty", g, sk));
      }
      return num(call(host, "TryGetObjectDoubleProperty", g, k));
    },
    strProp(id) {
      const v = call(host, "TryGetObjectStringProperty", g, Number(id) >>> 0);
      return v === null || v === undefined ? null : String(v);
    },
    boolProp(id) {
      const v = call(host, "TryGetObjectBoolProperty", g, Number(id) >>> 0);
      return v === null || v === undefined ? null : !!v;
    },
    didProp(id) {
      return num(call(host, "TryGetObjectDataIdProperty", g, Number(id) >>> 0));
    },
    spellIds() {
      const a = ap();
      if (!a) return hasAppraisal ? [] : null;
      const sb = Array.isArray(a.spellBook) ? a.spellBook : [];
      return sb.map((x) => (Number(x) & 0x7fffffff) >>> 0).filter(Boolean);
    },
    charSkillBuffed(id) {
      return num(playerStats()?.skills?.[Number(id)]?.current);
    },
    charSkillBase(id) {
      return num(playerStats()?.skills?.[Number(id)]?.base);
    },
    charLevel() {
      return num(playerStats()?.level);
    },
    charPackSlotsFree() {
      const room = typeof host?.TryGetPackRoomCached === "function" ? call(host, "TryGetPackRoomCached") : call(host, "TryGetPackRoom");
      return num(room?.main?.free);
    },
  };
  // Spell names only when the host can name a spell (else the evaluator
  // treats Spell Name Match as optimistic, as C# without a host).
  if (typeof host?.TryGetSpellRecord === "function") {
    ctx.spellNames = () => {
      const ids = ctx.spellIds();
      if (ids === null) return null;
      const out = [];
      for (const id of ids) {
        const r = call(host, "TryGetSpellRecord", id);
        if (r && r.name) out.push(String(r.name));
      }
      return out;
    };
  }
  return ctx;
}

/**
 * classify(guid, { host }) for RynthLootLoop (INT-1 hook). Never throws (the
 * loop also guards it). `getHost` is a fallback when the loop passes none.
 */
export function makeLootClassify({ profile, getHost = null, getRegex = null, log = null } = {}) {
  if (!profile || typeof profile !== "object") return null;
  const opts = typeof getRegex === "function" ? { getRegex } : {};
  return function classify(guid, info = {}) {
    try {
      const host = (info && info.host) || (typeof getHost === "function" ? getHost() : null);
      if (!host) return null;
      const res = evaluateUtl(profile, buildUtlItemCtx(host, guid, { log }), opts);
      return lootVerdict(res, {
        inventoryCount: (ruleName) => {
          const inv = typeof host.TryGetPlayerInventoryCached === "function" ? call(host, "TryGetPlayerInventoryCached") : call(host, "TryGetPlayerInventory");
          let n = 0;
          for (const row of Array.isArray(inv) ? inv : []) {
            const r = evaluateUtl(profile, buildUtlItemCtx(host, row.guid, { log }), opts);
            if (r && r.rule === ruleName && !r.pending) {
              const s = Number(row.stackSize);
              n += finite(s) && s > 0 ? s : 1;
            }
          }
          return n;
        },
      });
    } catch (e) {
      try {
        log?.(`loot profile failed on 0x${(Number(guid) >>> 0).toString(16)}: ${e && e.message ? e.message : e}`);
      } catch {
        /* ignore */
      }
      return null;
    }
  };
}

export default makeLootClassify;
