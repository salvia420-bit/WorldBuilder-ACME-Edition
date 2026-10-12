// rynth/vt/combat/monster_vars.js — the VTank monster-expression variables
// (PLAN W1-7 CMB, M23, G:125-134), with the C# mis-wirings fixed (U6 §5.1:
// RynthAi read typeid/species/maxhp from the wrong STypes and hard-coded
// hasshield to 0).
//
//   true / false   Bool
//   name           TryGetObjectName
//   typeid         the WCID (Decal "Type" convention, D31)
//   species        CreatureType display name: the live object's CreatureType
//                  (PropertyInt 2, merged by an appraisal) → learned per wcid →
//                  offline creature_species.json; "" when unknown (X-partial)
//   maxhp          appraisal creatureProfile.health_max (live guid, then the
//                  per-wcid profile); "" when unknown, so `maxhp<1000` does not
//                  match a monster we never appraised (U6 §5.3)
//   range          DYNAMIC world-frame metres (= VTank yards); "" when unknown
//   hasshield      DYNAMIC host.HasShield (any wielded Armor); "" when unknown
//   setting_<Name> DYNAMIC options.get(Name, {exactCase:true, vtUnits:true}),
//                  then case-insensitive with ONE warning per name (G:133 says
//                  case-sensitive); an unknown option = literal text
//   metastate      DYNAMIC current meta state
//
// species / maxhp ask for an appraisal only when an entry actually references
// them (resolveIdent is only called for words present in the expression), at
// most 2 RequestId per second overall and once per guid per 60 s.

import { creatureTypeName, isSpeciesLoaded, loadCreatureSpecies } from "./creature_profiles.js";

const APPRAISAL_RATE_PER_S = 2;
const APPRAISAL_PER_GUID_MS = 60_000;
const PINT_CREATURE_TYPE = 2;

/**
 * deps: { host, options (VtOptions), creatures (CreatureProfiles),
 *         getMetaState: () => string, now, log,
 *         typeName: (ct) => string|null — default creature_profiles creatureTypeName }
 * Returns (guid, ctx) => MonsterVars = { get(name), staticReady(name) }.
 */
export function makeMonsterVars({ host = null, options = null, creatures = null, getMetaState = null, now = Date.now, log, typeName = null } = {}) {
  const clock = typeof now === "function" ? now : Date.now;
  const say = typeof log === "function" ? log : (m) => console.log(`[vt:monster_vars] ${m}`);
  const recent = []; // RequestId timestamps (global budget)
  const perGuid = new Map(); // guid -> last request
  const warnedCase = new Set();

  const call = (name, ...args) => {
    const f = host && host[name];
    if (typeof f !== "function") return undefined;
    try {
      return f.apply(host, args);
    } catch (_) {
      return undefined;
    }
  };

  // ≤ APPRAISAL_RATE_PER_S requests per second overall, ≤ 1 per guid per 60 s.
  const requestAppraisal = (g) => {
    const t = clock();
    while (recent.length && t - recent[0] >= 1000) recent.shift();
    if (recent.length >= APPRAISAL_RATE_PER_S) return false;
    const last = perGuid.get(g);
    if (last != null && t - last < APPRAISAL_PER_GUID_MS) return false;
    if (perGuid.size >= 1024) perGuid.clear();
    perGuid.set(g, t);
    recent.push(t);
    if (typeof (host && host.TryGetCreatureInfo) === "function") call("TryGetCreatureInfo", g, { requestAppraisal: true });
    else call("RequestId", g);
    return true;
  };

  const nameOfType = typeof typeName === "function" ? typeName : creatureTypeName;
  const ctName = (ct) => {
    if (!(Number(ct) > 0)) return null;
    try {
      return nameOfType(ct) || null;
    } catch (_) {
      return null;
    }
  };

  const settingValue = (rest) => {
    if (!options || typeof options.get !== "function" || !rest) return undefined;
    let r;
    try {
      r = options.get(rest, { exactCase: true, vtUnits: true });
    } catch (_) {
      r = null;
    }
    if (r && r.ok) return r.value;
    try {
      r = options.get(rest, { vtUnits: true });
    } catch (_) {
      r = null;
    }
    if (r && r.ok) {
      if (!warnedCase.has(rest)) {
        warnedCase.add(rest);
        say(`setting_${rest}: matched case-insensitively (VTank setting names are case-sensitive)`);
      }
      return r.value;
    }
    return undefined;
  };

  return function varsFor(guid, ctx) {
    const g = Number(guid) >>> 0;
    const memo = new Map();
    let info; // TryGetCreatureInfo row (lazy, once)
    const creatureInfo = () => {
      if (info === undefined) info = call("TryGetCreatureInfo", g) || null;
      return info;
    };
    const wcid = () => {
      const w = Number(call("TryGetObjectWcid", g)) >>> 0;
      return w || 0;
    };
    const compute = (lower) => {
      switch (lower) {
        case "true":
          return true;
        case "false":
          return false;
        case "name": {
          const n = call("TryGetObjectName", g);
          return typeof n === "string" ? n : "";
        }
        case "typeid": {
          const w = wcid();
          return w || "";
        }
        case "species": {
          let ct = call("TryGetObjectIntProperty", g, PINT_CREATURE_TYPE);
          if (!(typeof ct === "number" && ct > 0)) {
            const ci = creatureInfo();
            ct = ci && typeof ci.creatureType === "number" ? ci.creatureType : null;
          }
          let s = ct ? ctName(ct) : null;
          if (!s && creatures && typeof creatures.species === "function") {
            try {
              s = creatures.species(wcid());
            } catch (_) {
              s = null;
            }
          }
          if (s) return s;
          if (typeof typeName !== "function" && !isSpeciesLoaded()) {
            loadCreatureSpecies(); // offline table still loading: no appraisal for that
            return "";
          }
          requestAppraisal(g);
          return "";
        }
        case "maxhp": {
          const ci = creatureInfo();
          if (ci && typeof ci.maxHp === "number" && ci.maxHp > 0) return ci.maxHp;
          if (creatures && typeof creatures.maxHp === "function") {
            try {
              const hp = creatures.maxHp(wcid());
              if (typeof hp === "number" && hp > 0) return hp;
            } catch (_) {
              /* unknown */
            }
          }
          requestAppraisal(g);
          return "";
        }
        case "range": {
          let d = call("TryGetObjectDistance", g);
          if (typeof d !== "number") {
            const ci = creatureInfo();
            d = ci && typeof ci.dist === "number" ? ci.dist : null;
          }
          return typeof d === "number" && Number.isFinite(d) ? d : "";
        }
        case "hasshield": {
          const v = call("HasShield", g);
          return typeof v === "boolean" ? v : "";
        }
        case "metastate": {
          if (typeof getMetaState !== "function") return "";
          try {
            const s = getMetaState();
            return s == null ? "" : String(s);
          } catch (_) {
            return "";
          }
        }
        default:
          return undefined;
      }
    };
    return {
      /** Value of a monster variable, or undefined when `name` is not one (literal text). */
      get(name) {
        const raw = String(name ?? "").trim();
        if (!raw) return undefined;
        const lower = raw.toLowerCase();
        if (lower.startsWith("setting_")) {
          if (memo.has(raw)) return memo.get(raw);
          const v = settingValue(raw.slice("setting_".length));
          memo.set(raw, v);
          return v;
        }
        if (memo.has(lower)) return memo.get(lower);
        const v = compute(lower);
        memo.set(lower, v);
        return v;
      },
      /** Has the static variable resolved (safe to cache a verdict that reads it)? */
      staticReady(name) {
        const lower = String(name ?? "").trim().toLowerCase();
        switch (lower) {
          case "name":
          case "typeid":
          case "species":
          case "maxhp": {
            const v = this.get(lower);
            return v !== "" && v !== undefined && v !== null;
          }
          case "true":
          case "false":
            return true;
          default:
            return false;
        }
      },
    };
  };
}
