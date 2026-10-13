// rynth/vt/formats/utl.js — VT Classic Looter `.utl` profiles (W1-3 FMT,
// PLAN §3.6, §2.2 P8; U7a §5.9). Port of the RynthSuite LootSdk
// VTankLootParser / VTankLootWriter / VTankNodeTypes, with fixes.
//
//   v1:  "UTL" EOL version EOL ruleCount EOL rule*  [SalvageCombine block]
//   v0:  ruleCount EOL rule*                          (headerless legacy form)
//   rule := name EOL [customExpression EOL (v1)] info EOL [keepCount EOL (KeepUpTo)]
//           ( [lengthCode EOL (v1)] dataLine{arity} )*
//   info := priority ";" actionCode (";" nodeType)*     Keep 1 · Salvage 2 · Sell 3 · Read 4 · KeepUpTo 10
//   SalvageCombine := "SalvageCombine" EOL version EOL enabled(0/1) EOL defaultBands EOL
//                     n EOL (material EOL bands EOL){n} "0" EOL
//
// The v1 length code is the byte length of the node's data lines, each
// counted with a CRLF (verified on all 55,922 nodes of the 48 corpus files);
// the writer recomputes it, so an edited node always gets the right code.
// Unknown node types read exactly `lengthCode` bytes (v1), else C#'s
// next-rule heuristic, and keep their data verbatim.
//
// Model (PLAN §3.6 UtlProfile): { version, rules: [{ name, enabled, priority,
// action, keepCount?, customExpr?, conditions: [{ type, typeName, data }] }],
// salvageCombine? }. `enabled` mirrors the DisabledRule (9999) node: parse
// derives it, write reconciles the node with it (C# VTankLootRule.Enabled).
// Byte stability: `_fmt` = { eol, trailingEol, bom?, trailer } keeps the
// file's line ending and every line after the last counted rule (a stale rule
// count, the SalvageCombine block); writeUtl re-emits the trailer only while
// it still parses to the current `salvageCombine`. A truncated last rule is
// dropped with a warning and its lines stay in the trailer; a header count
// that disagrees with the rules read is kept (`declaredCount`) until the rule
// list changes length.

const NODE_ROWS = [
  [0, "SpellNameMatch", 1, "Spell Name Match", ["pattern"]],
  [1, "StringValueMatch", 2, "String Value Match", ["pattern", "key"]],
  [2, "LongValKeyLE", 2, "Long Key ≤", ["value", "key"]],
  [3, "LongValKeyGE", 2, "Long Key ≥", ["value", "key"]],
  [4, "DoubleValKeyLE", 2, "Double Key ≤", ["value", "key"]],
  [5, "DoubleValKeyGE", 2, "Double Key ≥", ["value", "key"]],
  [6, "DamagePercentGE", 1, "Damage % ≥", ["value"]],
  [7, "ObjectClass", 1, "Object Class", ["objectClass"]],
  [8, "SpellCountGE", 1, "Spell Count ≥", ["count"]],
  [9, "SpellMatch", 3, "Spell Match", ["matchRegex", "noMatchRegex", "count"]],
  [10, "MinDamageGE", 1, "Min Damage ≥", ["value"]],
  [11, "LongValKeyFlagExists", 2, "Long Key Has Flag", ["flag", "key"]],
  [12, "LongValKeyE", 2, "Long Key =", ["value", "key"]],
  [13, "LongValKeyNE", 2, "Long Key ≠", ["value", "key"]],
  [14, "AnySimilarColor", 5, "Any Similar Color", ["r", "g", "b", "maxDiffH", "maxDiffSV"]],
  [15, "SimilarColorArmorType", 6, "Similar Color (Armor Type)", ["r", "g", "b", "maxDiffH", "maxDiffSV", "armorGroup"]],
  [16, "SlotSimilarColor", 6, "Slot Similar Color", ["r", "g", "b", "maxDiffH", "maxDiffSV", "slot"]],
  [17, "SlotExactPalette", 2, "Slot Exact Palette", ["slot", "palette"]],
  [1000, "CharacterSkillGE", 2, "Char Skill ≥ (buffed)", ["value", "skillId"]],
  [1001, "CharacterMainPackEmptySlotsGE", 1, "Char Pack Slots ≥", ["count"]],
  [1002, "CharacterLevelGE", 1, "Char Level ≥", ["value"]],
  [1003, "CharacterLevelLE", 1, "Char Level ≤", ["value"]],
  [1004, "CharacterBaseSkill", 3, "Char Base Skill in [min,max]", ["skillId", "min", "max"]],
  [2000, "BuffedMedianDamageGE", 1, "Buffed Median Damage ≥", ["value"]],
  [2001, "BuffedMissileDamageGE", 1, "Buffed Missile Damage ≥", ["value"]],
  [2003, "BuffedLongValKeyGE", 2, "Buffed Long Key ≥", ["value", "key"]],
  [2005, "BuffedDoubleValKeyGE", 2, "Buffed Double Key ≥", ["value", "key"]],
  [2006, "CalcdBuffedTinkedDamageGE", 1, "Buffed Tinked Damage ≥", ["value"]],
  [2007, "TotalRatingsGE", 1, "Total Ratings ≥", ["value"]],
  [2008, "CalcedBuffedTinkedTargetMeleeGE", 3, "Tinked Target Melee ≥", ["dot", "def", "atk"]],
  [9999, "DisabledRule", 1, "Disabled Rule", ["disabled"]],
];

/** The 31 VTank loot node types: { id, name, arity, label, fields } (VTankNodeTypes.cs). */
export const UTL_NODE_TYPES = Object.freeze(
  NODE_ROWS.map(([id, name, arity, label, fields]) => Object.freeze({ id, name, arity, label, fields: Object.freeze(fields.slice()) })),
);
const NODE_BY_ID = new Map(UTL_NODE_TYPES.map((n) => [n.id, n]));

/** Node type row by id, or null. */
export function utlNodeType(id) {
  return NODE_BY_ID.get(Number(id)) || null;
}

export const UTL_ACTIONS = Object.freeze({ Keep: 1, Salvage: 2, Sell: 3, Read: 4, KeepUpTo: 10 });
const ACTION_BY_CODE = new Map(Object.entries(UTL_ACTIONS).map(([k, v]) => [v, k]));
export const DISABLED_RULE = 9999;

/** Action name or numeric string → VTank action code (NaN when unknown). */
export function utlActionCode(action) {
  if (typeof action === "number") return Number.isInteger(action) ? action : NaN;
  const s = String(action ?? "").trim();
  if (Object.prototype.hasOwnProperty.call(UTL_ACTIONS, s)) return UTL_ACTIONS[s];
  for (const k of Object.keys(UTL_ACTIONS)) if (k.toLowerCase() === s.toLowerCase()) return UTL_ACTIONS[k];
  return /^[-+]?\d+$/.test(s) ? parseInt(s, 10) : NaN;
}
function actionName(code) {
  return ACTION_BY_CODE.get(code) || String(code);
}

const intOf = (s) => {
  const t = String(s ?? "").trim();
  return /^[-+]?\d+$/.test(t) ? parseInt(t, 10) : NaN;
};
const ENC = new TextEncoder();
const utf8Len = (s) => ENC.encode(String(s ?? "")).length;
/** VTank v1 length code of a node's data lines (bytes, each line + CRLF). */
export function utlLengthCode(data) {
  let n = 0;
  for (const l of Array.isArray(data) ? data : []) n += utf8Len(l) + 2;
  return n;
}

function isDisabledNode(c) {
  return c && Number(c.type) === DISABLED_RULE && String((c.data && c.data[0]) ?? "").trim().toLowerCase() === "true";
}

// C# IsStartOfNextRule: the line at `infoOffset` looks like "int;int…".
function looksLikeRuleStart(lines, i, v1) {
  const info = lines[i + (v1 ? 2 : 1)];
  if (info === undefined || !info.includes(";")) return false;
  const p = info.trim().split(";");
  return p.length >= 2 && Number.isFinite(intOf(p[0])) && Number.isFinite(intOf(p[1]));
}

class Truncated extends Error {}

function parseRule(lines, idx, v1, warn, where) {
  const take = () => {
    if (idx >= lines.length) throw new Truncated();
    return lines[idx++];
  };
  const name = take();
  const customExpr = v1 ? take() : undefined;
  const parts = take().trim().split(";");
  let priority = intOf(parts[0]);
  if (!Number.isFinite(priority)) {
    warn(`${where} "${name}": bad priority ${JSON.stringify(parts[0])} (0)`);
    priority = 0;
  }
  let code = intOf(parts[1]);
  if (!Number.isFinite(code)) {
    warn(`${where} "${name}": bad action ${JSON.stringify(parts[1] ?? "")} (Keep)`);
    code = 1;
  }
  const rule = { name, enabled: true, priority, action: actionName(code) };
  if (code === UTL_ACTIONS.KeepUpTo) {
    const kc = intOf(take());
    if (!Number.isFinite(kc)) warn(`${where} "${name}": bad KeepUpTo count (0)`);
    rule.keepCount = Number.isFinite(kc) ? kc : 0;
  }
  if (v1) rule.customExpr = customExpr;
  rule.conditions = [];
  for (const p of parts.slice(2)) {
    const type = intOf(p);
    if (!Number.isFinite(type)) {
      if (p.trim()) warn(`${where} "${name}": node type ${JSON.stringify(p)} is not a number (skipped)`);
      continue;
    }
    const lengthCode = v1 ? intOf(take()) : NaN;
    const row = NODE_BY_ID.get(type);
    const data = [];
    if (row) {
      for (let d = 0; d < row.arity; d++) data.push(take());
    } else if (Number.isFinite(lengthCode) && lengthCode >= 0) {
      warn(`${where} "${name}": unknown node type ${type} (data kept verbatim)`);
      let got = 0;
      while (got < lengthCode) {
        const l = take();
        data.push(l);
        got += utf8Len(l) + 2;
      }
    } else {
      warn(`${where} "${name}": unknown node type ${type} (data kept verbatim)`);
      while (idx < lines.length && !looksLikeRuleStart(lines, idx, v1) && lines[idx].trim().toLowerCase() !== "salvagecombine") data.push(lines[idx++]);
    }
    rule.conditions.push({ type, typeName: row ? row.name : `Unknown(${type})`, data });
  }
  rule.enabled = !rule.conditions.some(isDisabledNode);
  return { rule, next: idx };
}

function parseSalvage(lines, at) {
  // lines[at] === "SalvageCombine"
  let i = at + 1;
  const sc = { version: String(lines[i] ?? "").trim(), enabled: false, defaultBands: "", materials: [] };
  i++;
  const en = intOf(lines[i]);
  if (Number.isFinite(en)) {
    sc.enabled = en !== 0;
    i++;
  }
  if (i < lines.length) {
    sc.defaultBands = String(lines[i]).trim();
    i++;
  }
  const n = intOf(lines[i]);
  if (Number.isFinite(n)) {
    i++;
    for (let k = 0; k < n && i + 1 < lines.length; k++) {
      const mat = intOf(lines[i]);
      if (!Number.isFinite(mat)) break;
      sc.materials.push({ material: mat, bands: String(lines[i + 1]).trim() });
      i += 2;
    }
  }
  return sc;
}
function salvageFromTrailer(trailer) {
  const at = trailer.findIndex((l) => l.trim().toLowerCase() === "salvagecombine");
  return at < 0 ? null : parseSalvage(trailer, at);
}

/**
 * Parse `.utl` text. → { ok: true, profile, warnings } | { ok: false, warnings, error }
 */
export function parseUtl(text) {
  const warnings = [];
  const warn = (m) => warnings.push(m);
  if (typeof text !== "string") return { ok: false, warnings, error: ".utl data must be text" };
  const bom = text.charCodeAt(0) === 0xfeff;
  const src = bom ? text.slice(1) : text;
  const eol = src.includes("\r\n") ? "\r\n" : "\n";
  const trailingEol = /\n$/.test(src);
  const lines = src.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (trailingEol) lines.pop();
  if (!lines.length || (lines.length === 1 && !lines[0].trim())) return { ok: false, warnings, error: "empty .utl file" };
  let version;
  let ruleCount;
  let idx;
  if (lines[0].trim() === "UTL") {
    version = intOf(lines[1]);
    ruleCount = intOf(lines[2]);
    if (!Number.isFinite(version)) return { ok: false, warnings, error: "invalid .utl file: bad version line" };
    if (!Number.isFinite(ruleCount) || ruleCount < 0) return { ok: false, warnings, error: "invalid .utl file: bad rule count" };
    idx = 3;
  } else {
    ruleCount = intOf(lines[0]);
    if (!Number.isFinite(ruleCount) || ruleCount < 0) return { ok: false, warnings, error: "not a .utl file (expected \"UTL\" or a rule count on line 1)" };
    version = 0;
    idx = 1;
  }
  const v1 = version >= 1;
  const rules = [];
  while (rules.length < ruleCount && idx < lines.length) {
    const where = `rule ${rules.length + 1}`;
    try {
      const r = parseRule(lines, idx, v1, warn, where);
      rules.push(r.rule);
      idx = r.next;
    } catch (e) {
      if (!(e instanceof Truncated)) throw e;
      warn(`${where}: the file ends inside this rule (dropped; its lines are kept)`);
      break;
    }
  }
  if (rules.length < ruleCount) warn(`the rule count says ${ruleCount} but ${rules.length} rule(s) were read`);
  const trailer = lines.slice(idx);
  const scAt = trailer.findIndex((l) => l.trim().toLowerCase() === "salvagecombine");
  const junk = (scAt < 0 ? trailer : trailer.slice(0, scAt)).filter((l) => l.trim()).length;
  if (junk) warn(`${junk} line(s) after the last counted rule ignored (kept for export)`);
  const profile = { version: v1 ? version : 0, rules };
  const sc = scAt < 0 ? null : parseSalvage(trailer, scAt);
  if (sc) profile.salvageCombine = sc;
  profile._fmt = { eol, trailingEol, trailer };
  if (rules.length !== ruleCount) Object.assign(profile._fmt, { declaredCount: ruleCount, readCount: rules.length });
  if (bom) profile._fmt.bom = true;
  return { ok: true, profile, warnings };
}

function oneLine(s) {
  return String(s ?? "").replace(/\r\n|\r|\n/g, " ");
}

// The rule's conditions with the DisabledRule node reconciled to `enabled`.
function conditionsFor(rule) {
  const conds = (Array.isArray(rule.conditions) ? rule.conditions : []).filter((c) => c && typeof c === "object");
  const marked = conds.some(isDisabledNode);
  if (rule.enabled === false && !marked) {
    const at = conds.findIndex((c) => Number(c.type) === DISABLED_RULE);
    if (at >= 0) {
      const out = conds.slice();
      out[at] = { ...conds[at], data: ["true"] };
      return out;
    }
    return [...conds, { type: DISABLED_RULE, typeName: "DisabledRule", data: ["true"] }];
  }
  if (rule.enabled !== false && marked) return conds.filter((c) => !isDisabledNode(c));
  return conds;
}

/** Serialise a UtlProfile to `.utl` text (VTank CRLF unless the source used LF). */
export function writeUtl(profile) {
  const p = profile && typeof profile === "object" ? profile : {};
  const fmt = p._fmt && typeof p._fmt === "object" ? p._fmt : {};
  const eol = fmt.eol === "\n" ? "\n" : "\r\n";
  const version = Number.isInteger(p.version) && p.version >= 0 ? p.version : 1;
  const v1 = version >= 1;
  const rules = (Array.isArray(p.rules) ? p.rules : []).filter((r) => r && typeof r === "object");
  const out = [];
  if (v1) out.push("UTL", String(version));
  // A stale header count (a truncated or hand-edited file) is kept while the
  // rule list is the one that was read; any edit writes the true count.
  const stale = Number.isInteger(fmt.declaredCount) && fmt.readCount === rules.length;
  out.push(String(stale ? fmt.declaredCount : rules.length));
  for (const r of rules) {
    const conds = conditionsFor(r);
    let code = utlActionCode(r.action);
    if (!Number.isFinite(code)) code = 1;
    out.push(oneLine(r.name));
    if (v1) out.push(oneLine(r.customExpr ?? ""));
    out.push([String(Math.trunc(Number(r.priority) || 0)), String(code), ...conds.map((c) => String(Math.trunc(Number(c.type) || 0)))].join(";"));
    if (code === UTL_ACTIONS.KeepUpTo) out.push(String(Math.trunc(Number(r.keepCount) || 0)));
    for (const c of conds) {
      const data = (Array.isArray(c.data) ? c.data : []).map(oneLine);
      if (v1) out.push(String(utlLengthCode(data)));
      out.push(...data);
    }
  }
  const trailer = Array.isArray(fmt.trailer) ? fmt.trailer.map(String) : null;
  const sc = p.salvageCombine && typeof p.salvageCombine === "object" ? p.salvageCombine : null;
  if (trailer && sameSalvage(salvageFromTrailer(trailer), sc)) out.push(...trailer);
  else if (sc) {
    const mats = Array.isArray(sc.materials) ? sc.materials : [];
    out.push("SalvageCombine", oneLine(sc.version ?? "0"), sc.enabled ? "1" : "0", oneLine(sc.defaultBands ?? ""), String(mats.length));
    for (const m of mats) out.push(String(Math.trunc(Number(m && m.material) || 0)), oneLine(m && m.bands));
    out.push("0");
  }
  const body = out.join(eol) + (fmt.trailingEol === false ? "" : eol);
  return fmt.bom ? `\uFEFF${body}` : body;
}

function sameSalvage(a, b) {
  if (!a || !b) return !a && !b;
  if (String(a.version ?? "") !== String(b.version ?? "") || !!a.enabled !== !!b.enabled || String(a.defaultBands ?? "") !== String(b.defaultBands ?? "")) return false;
  const ma = Array.isArray(a.materials) ? a.materials : [];
  const mb = Array.isArray(b.materials) ? b.materials : [];
  if (ma.length !== mb.length) return false;
  for (let i = 0; i < ma.length; i++) if (Number(ma[i].material) !== Number(mb[i] && mb[i].material) || String(ma[i].bands) !== String(mb[i] && mb[i].bands)) return false;
  return true;
}

/** A new, empty v1 profile (the Profiles-tab rule editor's starting point). */
export function newUtlProfile() {
  return { version: 1, rules: [] };
}

/** Structural check of a UtlProfile. → { ok, errors: string[] } */
export function validateUtl(profile) {
  const errors = [];
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return { ok: false, errors: ["profile is not an object"] };
  if (profile.version !== 0 && profile.version !== 1) errors.push("version must be 0 or 1");
  if (!Array.isArray(profile.rules)) {
    errors.push("rules must be an array");
    return { ok: false, errors };
  }
  const hasNl = (s) => /[\r\n]/.test(String(s));
  profile.rules.forEach((r, i) => {
    const where = `rule #${i + 1}`;
    if (!r || typeof r !== "object") {
      errors.push(`${where}: not an object`);
      return;
    }
    if (typeof r.name !== "string") errors.push(`${where}: name must be a string`);
    else if (hasNl(r.name)) errors.push(`${where}: name must be one line`);
    if (r.enabled !== undefined && typeof r.enabled !== "boolean") errors.push(`${where}: enabled must be a boolean`);
    if (!Number.isInteger(r.priority)) errors.push(`${where}: priority must be an integer`);
    const code = utlActionCode(r.action);
    if (!Number.isFinite(code) || !ACTION_BY_CODE.has(code)) errors.push(`${where}: unknown action ${JSON.stringify(r.action)}`);
    if (code === UTL_ACTIONS.KeepUpTo && !(Number.isInteger(r.keepCount) && r.keepCount >= 0)) errors.push(`${where}: KeepUpTo needs a keepCount ≥ 0`);
    if (r.customExpr !== undefined && r.customExpr !== null) {
      if (typeof r.customExpr !== "string" || hasNl(r.customExpr)) errors.push(`${where}: customExpr must be one line of text`);
      else if (profile.version === 0 && r.customExpr.trim()) errors.push(`${where}: a custom expression needs a version 1 profile`);
    }
    if (!Array.isArray(r.conditions)) {
      errors.push(`${where}: conditions must be an array`);
      return;
    }
    r.conditions.forEach((c, k) => {
      const cw = `${where} condition #${k + 1}`;
      if (!c || typeof c !== "object") {
        errors.push(`${cw}: not an object`);
        return;
      }
      const row = NODE_BY_ID.get(c.type);
      if (!row) {
        errors.push(`${cw}: unknown node type ${JSON.stringify(c.type)}`);
        return;
      }
      if (!Array.isArray(c.data) || c.data.some((d) => typeof d !== "string")) errors.push(`${cw}: data must be an array of strings`);
      else {
        if (c.data.length !== row.arity) errors.push(`${cw}: ${row.name} takes ${row.arity} data line(s), has ${c.data.length}`);
        if (c.data.some(hasNl)) errors.push(`${cw}: data lines must be single lines`);
      }
    });
  });
  if (profile.salvageCombine !== undefined && profile.salvageCombine !== null) {
    const sc = profile.salvageCombine;
    if (typeof sc !== "object" || !Array.isArray(sc.materials)) errors.push("salvageCombine.materials must be an array");
  }
  return { ok: errors.length === 0, errors };
}

export default { parseUtl, writeUtl, UTL_NODE_TYPES, newUtlProfile, validateUtl };
