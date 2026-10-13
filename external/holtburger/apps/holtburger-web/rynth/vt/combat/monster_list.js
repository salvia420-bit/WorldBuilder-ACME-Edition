// rynth/vt/combat/monster_list.js — the VTank Monsters tab model (PLAN W1-7
// CMB, §2.4 M1/M16/M22-M25, G:68-150).
//
// One ordered list; DEFAULT is pinned at index 0 (undeletable, never matched
// by name or expression, always the fallback). Entries 1..n are evaluated in
// order; the FIRST entry that evaluates to true, or to the monster's name,
// is used (G:103). ONE resolver serves every column, the combat scan and the
// meta MobsInDist_Priority condition (U6 §1.4 — RynthAi had four
// inconsistent matchers).
//
// Match rule for an entry whose text evaluates to v (monster mode, unknown
// identifiers are literal strings, G:119):
//   v is a Bool or Number        → truthy(v)
//   v is anything else (String…) → equalsCI(v, name)
//   always also                  → equalsCI(entry.text.trim(), name)
// A bare name like "Blood Shreth" evaluates to the literal string
// "Blood Shreth", which is TRUTHY — applying truthy() to strings would make
// every plain-name entry match every monster, so strings match only by name
// (G:103 "evaluates to true, or to the monster's name"). The raw-text clause
// rescues names containing operator characters ("Drudge-Lord" parses as a
// subtraction) and entries whose expression does not parse.
//
// Caching (M25, U6 §5.3): a STATIC entry (no range/hasshield/metastate/
// setting_*/calls/$vars) has its verdict cached per (list revision, guid),
// but only once every static variable it references (name, typeid, species,
// maxhp) has resolved — species/maxhp arrive asynchronously via appraisal, and
// a verdict taken while they were unknown would freeze a wrong answer. The
// cache remembers the name it was taken for and is dropped when the guid
// names another object (ACE recycles dynamic guids).
// Dynamic entries are re-evaluated once per scan (memo per snapshot seq).
//
// The expression engine is INJECTED (C2: no import of rynth/vt/expr):
//   parse(text, { mode: "monster" }) → { ok, ast, refs: Set, dynamic } | { ok: false, error }
//   evaluate(parsed, resolveIdent)   → Value (never throws)
//   resolveIdent(lowerWord, originalWord) → Value | undefined (undefined = literal)

import { ELEMENTS, normalizeElement } from "./spell_tables.js";

/** @typedef {import("./spell_tables.js").Element} Element */

export const MONSTER_COLUMNS = Object.freeze(["F", "B", "G", "I", "Y", "V", "A", "R", "S", "WC", "FC", "Cp", "DC", "Cs"]);

const elementOf = (s) => normalizeElement(s);

export const DEFAULT_TEXT = "DEFAULT";

export const DEFAULT_ENTRY = Object.freeze({
  text: DEFAULT_TEXT,
  enabled: true,
  priority: 1,
  F: false, B: false, G: false, I: false, Y: false, V: false,
  A: true, R: false, S: false,
  WC: false, FC: false, Cp: false, DC: false, Cs: false,
  damageType: "Auto",
  exVuln: "None",
  weapon: 0,
  offhand: 0,
  petDmg: "PAuto",
  arc: false,
});

// G:125-134 — `/vt listmonstervariables` (M26 prints this with DYNAMIC tags).
export const MONSTER_VARIABLES = Object.freeze([
  Object.freeze({ name: "true", dynamic: false, doc: "always evaluates to true" }),
  Object.freeze({ name: "false", dynamic: false, doc: "always evaluates to false" }),
  Object.freeze({ name: "name", dynamic: false, doc: "the monster's name" }),
  Object.freeze({ name: "typeid", dynamic: false, doc: "the monster's weenie class id (WCID) — 'Type' when propertydumped" }),
  Object.freeze({ name: "species", dynamic: false, doc: "the name of the monster's species, such as 'Drudge'" }),
  Object.freeze({ name: "maxhp", dynamic: false, doc: "the maximum number of hit points this monster has when it first spawns (needs an appraisal)" }),
  Object.freeze({ name: "range", dynamic: true, doc: "the range in yards (metres) to this target" }),
  Object.freeze({ name: "hasshield", dynamic: true, doc: "true if the target has equipped anything of objectclass armor, false otherwise" }),
  Object.freeze({ name: "setting_x", dynamic: true, doc: "the value of macro setting x, e.g. setting_DoJiggle (case-sensitive)" }),
  Object.freeze({ name: "metastate", dynamic: true, doc: "the current meta state" }),
]);

// Static monster variables whose value may still be unknown (appraisal).
const STATIC_VARS = new Set(["name", "typeid", "species", "maxhp"]);
const DYNAMIC_VARS = new Set(["range", "hasshield", "metastate"]);

const bool = (v, d) => (v === undefined || v === null ? d : v === true || v === 1 || v === "1" || (typeof v === "string" && v.trim().toLowerCase() === "true"));
const u32 = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n >>> 0 : 0;
};

function clampPriority(p, dflt) {
  const n = Math.round(Number(p));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(-1, Math.min(4, n));
}

function isDefaultText(text) {
  return String(text ?? "").trim().toUpperCase() === DEFAULT_TEXT;
}

/** Fill defaults and coerce every field of a (possibly partial) entry. */
export function normalizeEntry(e) {
  const src = e && typeof e === "object" ? e : {};
  const out = {
    text: typeof src.text === "string" ? src.text : src.text == null ? "" : String(src.text),
    enabled: bool(src.enabled, true),
    priority: clampPriority(src.priority, 1),
  };
  for (const c of MONSTER_COLUMNS) out[c] = bool(src[c], c === "A");
  const dt = src.damageType == null || String(src.damageType).trim().toLowerCase() === "auto" ? "Auto" : elementOf(src.damageType) ?? "Auto";
  out.damageType = dt;
  out.exVuln = src.exVuln == null || String(src.exVuln).trim().toLowerCase() === "none" ? "None" : elementOf(src.exVuln) ?? "None";
  out.weapon = u32(src.weapon);
  out.offhand = u32(src.offhand);
  out.petDmg = src.petDmg == null || String(src.petDmg).trim().toLowerCase() === "pauto" ? "PAuto" : elementOf(src.petDmg) ?? "PAuto";
  out.arc = bool(src.arc, false);
  if (isDefaultText(out.text)) {
    out.text = DEFAULT_TEXT;
    out.enabled = true; // DEFAULT cannot be disabled
  }
  return out;
}

function sameEntry(a, b) {
  for (const k of Object.keys(DEFAULT_ENTRY)) if (a[k] !== b[k]) return false;
  return true;
}

// Case-insensitive property read (RynthAi JSON is PropertyNameCaseInsensitive).
function prop(o, name) {
  if (!o || typeof o !== "object") return undefined;
  if (name in o) return o[name];
  const want = name.toLowerCase();
  for (const k of Object.keys(o)) if (k.toLowerCase() === want) return o[k];
  return undefined;
}

/**
 * RynthAi MonsterRule (LegacyUiSettings.cs:406-427) → entry (U6 §1.5 import
 * map). text = MatchExpression || Name; with both, the expression AND an
 * exact name test (VTank names match exactly — RynthAi's substring rule is
 * not carried over). A = UseArc || UseBolt (UseBolt defaults true in C#).
 */
export function fromRynthAiRule(rule) {
  const r = rule && typeof rule === "object" ? rule : {};
  const name = String(prop(r, "Name") ?? "").trim();
  const expr = String(prop(r, "MatchExpression") ?? "").trim();
  let text;
  if (isDefaultText(name)) text = DEFAULT_TEXT;
  else if (expr && name) text = `(${expr}) && name==\`${name.replace(/`/g, "\\`")}\``;
  else text = expr || name;
  const useArc = bool(prop(r, "UseArc"), false);
  const useBolt = bool(prop(r, "UseBolt"), true);
  const dt = prop(r, "DamageType");
  return normalizeEntry({
    text,
    enabled: true,
    priority: prop(r, "Priority") ?? 1,
    F: prop(r, "Fester"),
    B: prop(r, "Broadside"),
    G: prop(r, "GravityWell"),
    I: prop(r, "Imperil"),
    Y: prop(r, "Yield"),
    V: prop(r, "Vuln"),
    A: useArc || useBolt,
    R: prop(r, "UseRing"),
    S: prop(r, "UseStreak"),
    damageType: dt,
    exVuln: prop(r, "ExVuln"),
    weapon: prop(r, "WeaponId"),
    offhand: prop(r, "OffhandId"),
    petDmg: prop(r, "PetDamage"),
    arc: useArc,
  });
}

/**
 * Legacy HUD/director priorities {name: p} → entries (P clamped to 0..4).
 * Note: the legacy map matched by name SUBSTRING; a VTank entry matches the
 * exact name (or an expression the user writes).
 */
export function fromLegacyPriorities(map) {
  const out = [];
  if (!map || typeof map !== "object") return out;
  for (const [name, p] of Object.entries(map)) {
    const text = String(name).trim();
    if (!text || isDefaultText(text)) continue;
    const n = Number(p);
    out.push(normalizeEntry({ text, priority: Number.isFinite(n) ? Math.max(0, Math.min(4, Math.round(n))) : 1 }));
  }
  return out;
}

const defaultTruthy = (v) => {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v !== "" && v !== "0" && v.toLowerCase() !== "false";
  return !(v && v.t === "err");
};
const defaultEqualsCI = (a, b) => {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (typeof a === "object" || typeof b === "object") return false;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
};

const CACHE_GUIDS_MAX = 4096;

export class MonsterList {
  constructor({ entries = [], parse = null, evaluate = null, truthy = null, equalsCI = null, varsFor = null, log } = {}) {
    this._parse = typeof parse === "function" ? parse : null;
    this._evaluate = typeof evaluate === "function" ? evaluate : null;
    this._truthy = typeof truthy === "function" ? truthy : defaultTruthy;
    this._equalsCI = typeof equalsCI === "function" ? equalsCI : defaultEqualsCI;
    this._varsFor = typeof varsFor === "function" ? varsFor : null;
    this.log = typeof log === "function" ? log : (m) => console.log(`[vt:monsters] ${m}`);
    this._rev = 0;
    this._entries = [Object.freeze({ ...DEFAULT_ENTRY })];
    this._parsed = [null];
    this._static = new Map(); // guid -> { name, v: Map(entryIndex -> bool) }
    this._memo = { seq: undefined, map: new Map() }; // per-scan resolution memo
    this._warned = new Set();
    this.setEntries(entries);
  }

  get rev() {
    return this._rev;
  }

  /** Replace the list. DEFAULT is kept at index 0 (an existing DEFAULT row keeps its columns; none ⇒ the stock one). */
  setEntries(entries) {
    const list = Array.isArray(entries) ? entries.map(normalizeEntry) : [];
    let def = null;
    const rest = [];
    for (const e of list) {
      if (isDefaultText(e.text)) {
        if (!def) def = e;
        continue; // a second DEFAULT row is dropped
      }
      rest.push(e);
    }
    this._entries = [Object.freeze(def || { ...DEFAULT_ENTRY }), ...rest.map((e) => Object.freeze(e))];
    this._parsed = this._entries.map((e, i) => (i === 0 ? null : this._parseEntry(e)));
    this._bump();
  }

  _parseEntry(e) {
    if (!this._parse) return null;
    try {
      const p = this._parse(e.text, { mode: "monster" });
      if (p && p.ok) return p;
      const key = `parse:${e.text}`;
      if (!this._warned.has(key)) {
        this._warned.add(key);
        this.log(`monster entry "${e.text}" does not parse (${(p && p.error) || "error"}) — matching it by name only`);
      }
      return p && typeof p === "object" ? p : { ok: false };
    } catch (_) {
      return { ok: false };
    }
  }

  _bump() {
    this._rev++;
    this._static = new Map();
    this._memo = { seq: undefined, map: new Map() };
  }

  /** Copies, DEFAULT first. */
  entries() {
    return this._entries.map((e) => ({ ...e }));
  }

  /** Exactly one entry and it deep-equals DEFAULT_ENTRY (an edited DEFAULT row is NOT default-only). */
  isDefaultOnly() {
    return this._entries.length === 1 && sameEntry(this._entries[0], DEFAULT_ENTRY);
  }

  /** Drop every cached verdict (e.g. a creature profile learned species/maxhp, a setting changed). */
  invalidate() {
    this._bump();
  }

  /**
   * The entry governing `guid` now: { entry, index } (index 0 = DEFAULT).
   * ctx = { seq, now } — seq is the host snapshot seq (per-scan memo key).
   */
  resolve(guid, ctx = {}) {
    const g = Number(guid) >>> 0;
    const seq = ctx && ctx.seq != null ? ctx.seq : undefined;
    if (seq !== undefined) {
      if (this._memo.seq !== seq) this._memo = { seq, map: new Map() };
      const hit = this._memo.map.get(g);
      if (hit) return hit;
    }
    let result = null;
    try {
      result = this._resolve(g, ctx);
    } catch (e) {
      const key = `resolve:${e && e.message}`;
      if (!this._warned.has(key)) {
        this._warned.add(key);
        this.log(`monster list resolve failed: ${e && e.message}`);
      }
    }
    if (!result) result = { entry: this._entries[0], index: 0 };
    if (seq !== undefined) this._memo.map.set(g, result);
    return result;
  }

  _resolve(g, ctx) {
    const n = this._entries.length;
    if (n === 1) return { entry: this._entries[0], index: 0 };
    let vars = null;
    const getVars = () => {
      if (vars === null) {
        let v = null;
        try {
          v = this._varsFor ? this._varsFor(g, ctx) : null;
        } catch (_) {
          v = null;
        }
        vars = v && typeof v.get === "function" ? v : NO_VARS;
      }
      return vars;
    };
    let statics = this._static.get(g);
    // ACE recycles dynamic guids (GuidManager recycleTime, 6 h): a cached
    // verdict belongs to the object that had this guid then — drop it when
    // the guid now names another object.
    if (statics && statics.name !== safeGet(getVars(), "name")) {
      this._static.delete(g);
      statics = undefined;
    }
    for (let i = 1; i < n; i++) {
      const e = this._entries[i];
      if (!e.enabled) continue;
      let verdict;
      if (statics && statics.v.has(i)) verdict = statics.v.get(i);
      else {
        const v = getVars();
        const p = this._parsed[i];
        const st = this._staticState(p, v);
        // An entry that reads a static variable still unknown (species/maxhp
        // before the appraisal) does not match yet: "" would coerce to 0 in a
        // numeric compare, so `maxhp<1000` would otherwise catch every
        // unappraised monster (U6 §5.3). Re-evaluated on the next scan.
        verdict = st.ready ? this._evalEntry(e, p, v) : false;
        if (st.cacheable) {
          if (!statics) {
            if (this._static.size >= CACHE_GUIDS_MAX) this._static.clear();
            statics = { name: safeGet(v, "name"), v: new Map() };
            this._static.set(g, statics);
          }
          statics.v.set(i, verdict);
        }
      }
      if (verdict) return { entry: e, index: i };
    }
    return { entry: this._entries[0], index: 0 };
  }

  // ready: every static monster variable the entry reads has resolved.
  // cacheable: ready, static (no dynamic variable/call), and the name — read
  // by the raw-text clause — is known.
  _staticState(p, vars) {
    const nameReady = safeReady(vars, "name");
    if (!p || !p.ok) return { ready: true, cacheable: nameReady }; // unparsed / no engine: decided by the name alone
    const refs = p.refs instanceof Set ? p.refs : new Set(Array.isArray(p.refs) ? p.refs : []);
    let ready = true;
    let dynamic = p.dynamic === true;
    for (const r of refs) {
      const w = String(r).toLowerCase();
      if (DYNAMIC_VARS.has(w) || w.startsWith("setting_")) dynamic = true;
      else if (STATIC_VARS.has(w) && !safeReady(vars, w)) ready = false;
    }
    return { ready, cacheable: ready && !dynamic && nameReady };
  }

  _evalEntry(e, p, vars) {
    const name = safeGet(vars, "name");
    const nameStr = typeof name === "string" ? name : name == null ? "" : String(name);
    if (nameStr && this._equalsCI(String(e.text).trim(), nameStr)) return true;
    if (!p || !p.ok || !this._evaluate) return false;
    let v;
    try {
      v = this._evaluate(p, (lower, original) => {
        try {
          return vars.get(original != null ? String(original) : String(lower));
        } catch (_) {
          return undefined;
        }
      });
    } catch (_) {
      return false;
    }
    if (typeof v === "boolean" || typeof v === "number") return this._truthy(v);
    if (v && typeof v === "object") return false; // err / list / dict / wobj never name a monster
    return nameStr !== "" && this._equalsCI(v, nameStr);
  }

  priorityOf(guid, ctx = {}) {
    return this.resolve(guid, ctx).entry.priority;
  }
}

const NO_VARS = Object.freeze({ get: () => undefined, staticReady: () => false });

function safeGet(vars, name) {
  try {
    return vars.get(name);
  } catch (_) {
    return undefined;
  }
}
function safeReady(vars, name) {
  try {
    return typeof vars.staticReady === "function" ? vars.staticReady(name) === true : false;
  } catch (_) {
    return false;
  }
}

export { ELEMENTS as MONSTER_ELEMENTS };
