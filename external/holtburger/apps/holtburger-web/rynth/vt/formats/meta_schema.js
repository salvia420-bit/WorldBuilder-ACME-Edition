// rynth/vt/formats/meta_schema.js — the VTank meta keyword schema and the
// shared Meta model helpers (W1-3 FMT, PLAN §3.2, §3.6, Appendix B).
//
// Three numbering schemes exist for meta keywords (U5 §1.2); only two matter
// here and they are kept side by side in ONE table per kind:
//   * the metaf keyword — the canonical type id of every Cond/Act (`t`);
//   * the VTank `.met` CType / AType number — corpus-verified, and checked
//     against the metaf source (metaf-project Core/Enums.cs CTypeID/ATypeID).
// The keyword ↔ number maps are asserted to be bijections when this module
// loads (a programming error throws; nothing else runs at load).
//
// Field names per keyword are Appendix B's JSON fields. `fields[].type`:
//   "s" string · "i" integer · "d" finite number · "u32" uint32 (cell ids).
// `compound`: "many" (All / Any / DoAll — `children` array) or "one" (Not —
// `children[0]`).
//
// Model helpers shared by met.js / af.js (and usable by INT-2): rule ids,
// emptyMeta, validateMeta, newCond/newAct, embedded-nav text helpers and the
// EmbedNav tag rule. No imports, no side effects.

const fld = (name, type) => Object.freeze({ name, type });
const NOFIELDS = Object.freeze([]);

// [kw, .met number, GUIDE label (G:247-292), fields, compound]
const COND_ROWS = [
  ["Never", 0, "Never", NOFIELDS, null],
  ["Always", 1, "Always", NOFIELDS, null],
  ["All", 2, "All", NOFIELDS, "many"],
  ["Any", 3, "Any", NOFIELDS, "many"],
  ["ChatMatch", 4, "Chat Message", [fld("re", "s")], null],
  ["MainSlotsLE", 5, "Pack Slots <=", [fld("n", "i")], null],
  ["SecsInStateGE", 6, "Seconds in State >=", [fld("secs", "i")], null],
  ["NavEmpty", 7, "Navroute Empty", NOFIELDS, null],
  ["Death", 8, "Character Death", NOFIELDS, null],
  ["VendorOpen", 9, "Any Vendor Open", NOFIELDS, null],
  ["VendorClosed", 10, "Vendor Closed", NOFIELDS, null],
  ["ItemCountLE", 11, "Inventory Item Count <=", [fld("name", "s"), fld("count", "i")], null],
  ["ItemCountGE", 12, "Inventory Item Count >=", [fld("name", "s"), fld("count", "i")], null],
  ["MobsInDist_Name", 13, "Monster Name Count Within Distance", [fld("re", "s"), fld("count", "i"), fld("dist", "d")], null],
  ["MobsInDist_Priority", 14, "Monster Priority Count Within Distance", [fld("count", "i"), fld("dist", "d"), fld("priority", "i")], null],
  ["NeedToBuff", 15, "Need to Buff", NOFIELDS, null],
  ["NoMobsInDist", 16, "No Monsters Within Distance", [fld("dist", "d")], null],
  ["BlockE", 17, "Landblock ==", [fld("value", "u32")], null],
  ["CellE", 18, "Landcell ==", [fld("value", "u32")], null],
  ["IntoPortal", 19, "Portalspace Entered", NOFIELDS, null],
  ["ExitPortal", 20, "Portalspace Exited", NOFIELDS, null],
  ["Not", 21, "Not", NOFIELDS, "one"],
  ["PSecsInStateGE", 22, "Seconds in state (P) >=", [fld("secs", "i")], null],
  ["SecsOnSpellGE", 23, "Time Left On Spell >=", [fld("spellId", "i"), fld("secs", "i")], null],
  ["BuPercentGE", 24, "Burden Percent >=", [fld("pct", "i")], null],
  ["DistToRteGE", 25, "Dist Any Route Pt >=", [fld("dist", "d")], null],
  ["Expr", 26, "Expression", [fld("expr", "s")], null],
  // 27 is unused (metaf: "ClientDialogPopup … not in vt now"; RynthAi mis-maps it, U5 B1)
  ["ChatCapture", 28, "Chat Message Capture", [fld("re", "s"), fld("colors", "s")], null],
];

const ACT_ROWS = [
  ["None", 0, "None", NOFIELDS, null],
  ["SetState", 1, "Set Meta State", [fld("state", "s")], null],
  ["Chat", 2, "Chat Command", [fld("text", "s")], null],
  ["DoAll", 3, "All", NOFIELDS, "many"],
  ["EmbedNav", 4, "Load Embedded Navroute", [fld("tag", "s"), fld("displayName", "s")], null],
  ["CallState", 5, "Call Meta State", [fld("state", "s"), fld("ret", "s")], null],
  ["Return", 6, "Return From Call", NOFIELDS, null],
  ["DoExpr", 7, "Expression Action", [fld("expr", "s")], null],
  ["ChatExpr", 8, "Chat Expression", [fld("expr", "s")], null],
  ["SetWatchdog", 9, "Set Watchdog", [fld("state", "s"), fld("dist", "d"), fld("secs", "d")], null],
  ["ClearWatchdog", 10, "Clear Watchdog", NOFIELDS, null],
  ["GetOpt", 11, "Get VT Option", [fld("opt", "s"), fld("var", "s")], null],
  ["SetOpt", 12, "Set VT Option", [fld("opt", "s"), fld("expr", "s")], null],
  ["CreateView", 13, "Create View", [fld("view", "s"), fld("xml", "s")], null],
  ["DestroyView", 14, "Destroy View", [fld("view", "s")], null],
  ["DestroyAllViews", 15, "Destroy All Views", NOFIELDS, null],
];

function freezeRows(rows) {
  return Object.freeze(
    rows.map(([kw, met, label, fields, compound]) => Object.freeze({ kw, met, label, fields: Object.freeze(fields.slice()), compound })),
  );
}

/** Conditions: `{ kw, met, label, fields, compound }` in `.met` number order. */
export const COND_KW = freezeRows(COND_ROWS);
/** Actions: `{ kw, met, label, fields, compound }` in `.met` number order. */
export const ACT_KW = freezeRows(ACT_ROWS);

// The keyword ↔ number maps must be bijections (U5 §1.6, MetaSchema.cs:110-135).
function indexTable(table, what) {
  const byMet = new Map();
  const byKw = new Map();
  const byKwLower = new Map();
  for (const r of table) {
    if (!Number.isInteger(r.met) || r.met < 0) throw new Error(`meta_schema: ${what} ${r.kw} has a bad .met number`);
    if (byMet.has(r.met)) throw new Error(`meta_schema: ${what} .met number ${r.met} is not unique`);
    if (byKwLower.has(r.kw.toLowerCase())) throw new Error(`meta_schema: ${what} keyword ${r.kw} is not unique`);
    byMet.set(r.met, r);
    byKw.set(r.kw, r);
    byKwLower.set(r.kw.toLowerCase(), r);
  }
  for (const r of table) {
    if (byMet.get(r.met) !== r || byKw.get(r.kw) !== r) throw new Error(`meta_schema: ${what} table is not a bijection at ${r.kw}`);
  }
  return { byMet, byKw, byKwLower };
}
const COND_IDX = indexTable(COND_KW, "condition");
const ACT_IDX = indexTable(ACT_KW, "action");

function lookupKw(idx, kw) {
  if (typeof kw !== "string") return null;
  return idx.byKw.get(kw) || idx.byKwLower.get(kw.toLowerCase()) || null;
}
function lookupMet(idx, n) {
  const k = typeof n === "string" && /^\s*-?\d+\s*$/.test(n) ? parseInt(n, 10) : n;
  return Number.isInteger(k) ? idx.byMet.get(k) || null : null;
}

/** Condition row by `.met` CType number, or null. */
export function condByMet(n) {
  return lookupMet(COND_IDX, n);
}
/** Condition row by metaf keyword (exact, then case-insensitive), or null. */
export function condByKw(kw) {
  return lookupKw(COND_IDX, kw);
}
/** Action row by `.met` AType number, or null. */
export function actByMet(n) {
  return lookupMet(ACT_IDX, n);
}
/** Action row by metaf keyword (exact, then case-insensitive), or null. */
export function actByKw(kw) {
  return lookupKw(ACT_IDX, kw);
}

// ── rule ids ───────────────────────────────────────────────────────────────
const RULE_ID_RE = /^r(\d+)$/;

/**
 * Next stable rule id "r<n>" for a meta whose rules already use `existing`
 * (a Set, an array of ids, or an array of rules). n = 1 + the highest
 * numeric suffix in use, so a deleted rule's id is never handed to a new rule
 * (META keys fired flags by id; reuse would inherit a stale flag).
 */
export function newRuleId(existing) {
  const ids = [];
  if (existing instanceof Set) ids.push(...existing);
  else if (Array.isArray(existing)) for (const e of existing) ids.push(e && typeof e === "object" ? e.id : e);
  let max = 0;
  const used = new Set();
  for (const id of ids) {
    if (typeof id !== "string") continue;
    used.add(id);
    const m = RULE_ID_RE.exec(id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  let n = max + 1;
  while (used.has(`r${n}`)) n++;
  return `r${n}`;
}

// ── model factories ────────────────────────────────────────────────────────
/** A new empty meta (no rules, no navs). */
export function emptyMeta(name) {
  return { v: 1, name: typeof name === "string" ? name : "", source: { kind: "json" }, rules: [], navs: {}, warnings: [] };
}

function defaultFor(type) {
  return type === "s" ? "" : 0;
}
function newNode(row) {
  const n = { t: row.kw };
  if (row.compound) n.children = [];
  for (const f of row.fields) n[f.name] = defaultFor(f.type);
  return n;
}
/** A condition node of keyword `t` with Appendix-B default fields; null for an unknown keyword. */
export function newCond(t) {
  const row = condByKw(t);
  return row ? newNode(row) : null;
}
/** An action node of keyword `t` with Appendix-B default fields; null for an unknown keyword. */
export function newAct(t) {
  const row = actByKw(t);
  return row ? newNode(row) : null;
}

/**
 * The same node with its keys in schema order: `t`, the Appendix-B fields,
 * `children`, then anything else (unknownKeyword, format hints). Parsers use
 * it so a node reads the same whichever file format it came from.
 */
export function orderFields(node, kind) {
  if (!node || typeof node !== "object") return node;
  const row = kind === "act" ? actByKw(node.t) : condByKw(node.t);
  const out = { t: node.t };
  if (row) for (const f of row.fields) if (node[f.name] !== undefined) out[f.name] = node[f.name];
  if (node.children !== undefined) out.children = node.children;
  for (const k of Object.keys(node)) if (!(k in out)) out[k] = node[k];
  return out;
}

// ── validation ─────────────────────────────────────────────────────────────
const MAX_DEPTH = 64;

function checkField(f, v) {
  switch (f.type) {
    case "s":
      return typeof v === "string";
    case "i":
      // VTank stores these as Int32 (Int32.Parse in VTank and metaf).
      return typeof v === "number" && Number.isInteger(v) && v >= -2147483648 && v <= 2147483647;
    case "d":
      return typeof v === "number" && Number.isFinite(v);
    case "u32":
      return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
    default:
      return false;
  }
}

function validateNode(node, kind, where, depth, errors, navs) {
  if (depth > MAX_DEPTH) {
    errors.push(`${where}: nesting deeper than ${MAX_DEPTH}`);
    return;
  }
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    errors.push(`${where}: missing ${kind}`);
    return;
  }
  const row = kind === "condition" ? condByKw(node.t) : actByKw(node.t);
  if (!row || row.kw !== node.t) {
    errors.push(`${where}: unknown ${kind} keyword ${JSON.stringify(node.t)}`);
    return;
  }
  if (node.unknownKeyword !== undefined) {
    // An unrecognised keyword loaded as Never/None: inert, nothing else to check.
    if (typeof node.unknownKeyword !== "string") errors.push(`${where}: unknownKeyword must be a string`);
    return;
  }
  for (const f of row.fields) {
    if (!checkField(f, node[f.name])) errors.push(`${where}: ${node.t}.${f.name} must be ${FIELD_TYPE_TEXT[f.type]}`);
  }
  if (row.compound) {
    if (!Array.isArray(node.children)) {
      errors.push(`${where}: ${node.t} needs a children array`);
      return;
    }
    if (row.compound === "one" && node.children.length !== 1) errors.push(`${where}: Not needs exactly one child condition (has ${node.children.length})`);
    node.children.forEach((ch, i) => validateNode(ch, kind, `${where} > ${node.t}[${i}]`, depth + 1, errors, navs));
  } else if (node.children !== undefined && node.children !== null && !(Array.isArray(node.children) && node.children.length === 0)) {
    errors.push(`${where}: ${node.t} cannot have children`);
  }
  if (kind === "action" && node.t === "EmbedNav") {
    const tag = typeof node.tag === "string" ? node.tag.trim() : "";
    if (!tag) errors.push(`${where}: EmbedNav needs a tag`);
    else if (!findNav(navs, tag)) errors.push(`${where}: EmbedNav cites route "${tag}" which the meta does not contain`);
  }
}
const FIELD_TYPE_TEXT = { s: "a string", i: "an integer (Int32)", d: "a finite number", u32: "a uint32" };

function validateNav(tag, nav, errors) {
  const where = `navs.${tag}`;
  if (!nav || typeof nav !== "object" || Array.isArray(nav)) {
    errors.push(`${where}: not an object`);
    return;
  }
  if (typeof nav.displayName !== "string") errors.push(`${where}.displayName must be a string`);
  if (![1, 2, 3, 4].includes(nav.routeType)) errors.push(`${where}.routeType must be 1-4`);
  if (typeof nav.navText !== "string") errors.push(`${where}.navText must be a string`);
  else if (nav.navText.trim() && !/^\uFEFF?uTank2 NAV/i.test(nav.navText)) errors.push(`${where}.navText is not uTank2 NAV text`);
  if (nav.followTarget !== undefined && nav.followTarget !== null) {
    const ft = nav.followTarget;
    if (typeof ft !== "object" || typeof ft.name !== "string" || !Number.isFinite(ft.guid)) errors.push(`${where}.followTarget must be {name, guid}`);
  }
}

/** Structural check of a Meta (PLAN §3.2). → { ok, errors: string[] } */
export function validateMeta(meta) {
  const errors = [];
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return { ok: false, errors: ["meta is not an object"] };
  if (meta.v !== 1) errors.push("meta.v must be 1");
  if (typeof meta.name !== "string") errors.push("meta.name must be a string");
  if (!meta.source || typeof meta.source !== "object" || !["met", "af", "json"].includes(meta.source.kind)) errors.push('meta.source.kind must be "met", "af" or "json"');
  const navs = meta.navs && typeof meta.navs === "object" && !Array.isArray(meta.navs) ? meta.navs : null;
  if (!navs) errors.push("meta.navs must be an object");
  else for (const tag of Object.keys(navs)) validateNav(tag, navs[tag], errors);
  if (!Array.isArray(meta.rules)) {
    errors.push("meta.rules must be an array");
    return { ok: false, errors };
  }
  const ids = new Set();
  meta.rules.forEach((r, i) => {
    const where = `rule #${i + 1}${r && typeof r.id === "string" ? ` (${r.id})` : ""}`;
    if (!r || typeof r !== "object") {
      errors.push(`${where}: not an object`);
      return;
    }
    if (typeof r.id !== "string" || !r.id) errors.push(`${where}: missing id`);
    else if (ids.has(r.id)) errors.push(`${where}: duplicate id ${r.id}`);
    else ids.add(r.id);
    if (typeof r.state !== "string" || !r.state.trim()) errors.push(`${where}: state must be a non-empty string`);
    if (r.enabled !== undefined && typeof r.enabled !== "boolean") errors.push(`${where}: enabled must be a boolean`);
    validateNode(r.cond, "condition", `${where} cond`, 0, errors, navs || {});
    validateNode(r.act, "action", `${where} act`, 0, errors, navs || {});
  });
  if (meta.warnings !== undefined && !Array.isArray(meta.warnings)) errors.push("meta.warnings must be an array");
  return { ok: errors.length === 0, errors };
}

/** meta.navs lookup: exact tag, then case-insensitive (the META EmbedNav rule). */
export function findNav(navs, tag) {
  if (!navs || typeof navs !== "object" || typeof tag !== "string") return null;
  if (Object.prototype.hasOwnProperty.call(navs, tag)) return navs[tag];
  const low = tag.toLowerCase();
  for (const k of Object.keys(navs)) if (k.toLowerCase() === low) return navs[k];
  return null;
}

// ── semantic equality (format-hint verification) ───────────────────────────
/**
 * Deep equality over the semantic content of a Cond/Act tree (or any plain
 * data): keys starting with "_" (format hints such as `_met`) and `id` are
 * ignored; numbers compare by value.
 */
export function sameNode(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameNode(a[i], b[i])) return false;
    return true;
  }
  const keys = (o) => Object.keys(o).filter((k) => k[0] !== "_" && k !== "id" && o[k] !== undefined);
  const ka = keys(a);
  const kb = keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.prototype.hasOwnProperty.call(b, k) || !sameNode(a[k], b[k])) return false;
  return true;
}

// ── embedded nav text (uTank2 NAV 1.2) helpers ─────────────────────────────
export const NAV_HEADER = "uTank2 NAV 1.2";
/** metaf NAV: section type names ↔ RouteState.routeType. */
export const ROUTE_TYPE_NAMES = Object.freeze({ 1: "circular", 2: "linear", 3: "follow", 4: "once" });
export const ROUTE_TYPE_BY_NAME = Object.freeze({ circular: 1, linear: 2, follow: 3, once: 4 });

/** Normalise any line endings to CRLF (VTank's on-disk form). */
export function toCrlf(text) {
  return String(text ?? "").replace(/\r\n|\r|\n/g, "\r\n");
}

/** The `.nav` text of an empty route of `routeType` (what VTank embeds for "[None]"). */
export function emptyNavText(routeType = 1, eol = "\r\n") {
  return `${NAV_HEADER}${eol}${routeType}${eol}0${eol}`;
}

/** The `.nav` text of a Follow route (no point-count line; metaf NFollow.cs, signed Int32 guid). */
export function followNavText(target, eol = "\r\n") {
  const name = String((target && target.name) ?? "").replace(/[\r\n]+/g, " ");
  const guid = (Number(target && target.guid) || 0) | 0;
  return `${NAV_HEADER}${eol}3${eol}${name}${eol}${guid}${eol}`;
}

/**
 * Header facts of an embedded nav text.
 * → { ok, empty, routeType, pointCount, follow: {name, guid}|null }
 * `empty` = no text, or a non-Follow route with 0 points.
 */
export function navTextInfo(navText) {
  const text = typeof navText === "string" ? navText.replace(/^\uFEFF/, "") : "";
  if (!text.trim()) return { ok: true, empty: true, routeType: 0, pointCount: 0, follow: null };
  const lines = text.split(/\r\n|\r|\n/);
  if (!(lines[0] || "").toLowerCase().includes(NAV_HEADER.toLowerCase())) {
    return { ok: false, empty: false, routeType: 0, pointCount: 0, follow: null };
  }
  const routeType = parseInt(lines[1], 10);
  if (routeType === 3) {
    const guid = parseInt(lines[3], 10);
    return { ok: lines.length >= 4 && Number.isFinite(guid), empty: false, routeType: 3, pointCount: 1, follow: { name: lines[2] ?? "", guid: Number.isFinite(guid) ? guid >>> 0 : 0 } };
  }
  const pointCount = parseInt(lines[2], 10);
  const ok = Number.isFinite(routeType) && Number.isFinite(pointCount);
  return { ok, empty: ok && pointCount === 0, routeType: ok ? routeType : 0, pointCount: ok ? pointCount : 0, follow: null };
}

// ── EmbedNav tags ──────────────────────────────────────────────────────────
const LITERAL_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** True when `s` is a metaf literal (a valid `NAV:` / `EmbedNav` tag). */
export function isNavTag(s) {
  return typeof s === "string" && LITERAL_RE.test(s);
}

/** Any string → a metaf literal: non [A-Za-z0-9_] → "_", leading digit prefixed with "_". */
export function sanitizeNavTag(s) {
  let t = String(s ?? "").replace(/[^A-Za-z0-9_]/g, "_");
  if (!t) return "";
  if (/^[0-9]/.test(t)) t = `_${t}`;
  return t;
}

/**
 * The tag for a `.met` EmbedNav (Appendix B): the cleaned display name
 * (brackets/spaces trimmed, ".nav" and a metaf "nav<n>__" prefix removed),
 * made a metaf literal, or "Route<n>" for "[None]"/empty names; made unique
 * case-insensitively within `used` (a Set of lower-cased tags, updated).
 * `counter` = { n } (shared Route<n> counter, updated).
 */
export function navTagFor(displayName, used, counter) {
  let clean = String(displayName ?? "").replace(/^[\s[\]]+|[\s[\]]+$/g, "");
  clean = clean.replace(/\.nav$/i, "").replace(/^nav\d+_+/i, "");
  clean = clean.replace(/^[\s[\]]+|[\s[\]]+$/g, "");
  let base = clean && clean.toLowerCase() !== "none" ? sanitizeNavTag(clean) : "";
  // "__proto__" would hit the prototype setter of the plain-object meta.navs.
  const taken = (t) => t.toLowerCase() === "__proto__" || !!(used && used.has(t.toLowerCase()));
  if (!base) {
    const c = counter && typeof counter === "object" ? counter : { n: 0 };
    do base = `Route${c.n++}`;
    while (taken(base));
  }
  let tag = base;
  for (let k = 2; taken(tag); k++) tag = `${base}_${k}`;
  if (used) used.add(tag.toLowerCase());
  return tag;
}
