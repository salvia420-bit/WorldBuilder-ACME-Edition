// rynth/vt/formats/af.js — metaf `.af` reader/writer (W1-3 FMT, PLAN §3.6,
// Appendix B; format U5 §6.3, checked against the metaf source
// metaf-project Core/RegexPlus.cs + Operations/** + Navigation/**).
//
//   STATE: {name}                       ~~ anything after "~~" is a comment
//   	IF:	<Cond op> [args]               conditions; All/Any children follow,
//   			<child op> …                 indented deeper (metaf: tabs)
//   		DO:	<Act op> [args]            actions; DoAll children follow deeper
//   NAV: <tag> <circular|linear|follow|once>
//   	pnt x y z | rcl x y z {Recall Name} | pau x y z ms | cht x y z {text}
//   	vnd x y z GUIDHEX {name} | ptl|tlk x y z ox oy oz class {name}
//   	chk x y z | jmp x y z heading {True|False} delayMs | prt x y z GUIDHEX
//   	flw GUIDHEX {name}                 (follow navs only)
//   NAVDATA: <name> <lineCount> ~~ {    RynthAi's verbatim uTank2 block (read only)
//
// Reader (lenient; every oddity is a warning, never a silent drop):
//   * indentation is a COLUMN (tabs expand to the next multiple of 4), so tab-,
//     space- and RynthAi-indented files nest the same way; a child belongs to
//     the nearest preceding All/Any/Not/DoAll with a smaller column;
//   * strings: metaf `{…}` with `{{`/`}}` escapes first; a string that is not
//     valid metaf (RynthAi wrote braces raw) falls back to brace-depth counting;
//   * `Not <op>` on one line (metaf) or `Not` + one indented child (RynthAi);
//   * `~~ @disabled` before an IF: ⇒ that rule is `enabled:false`;
//   * unknown keywords ⇒ {t:"Never"|"None", unknownKeyword} + warning (RynthAi
//     extras such as SecsOnSpellLE / MainHealthLE are unknown here);
//   * argument orders are metaf's (e.g. `SecsOnSpellGE secs spellId`,
//     `MobsInDist_Priority count dist priority`);
//   * NAV sections: nav_file.parseAfNavs for pnt/rcl/pau/cht/ptl/chk/jmp/prt
//     (one line at a time, so every point lines up with its source line), then
//     the fixes nav_file cannot make (V-15): `vnd` → type 5 with its hex vendor
//     guid, `tlk` → type 7 with its object position/class/name (metaf layout),
//     `flw` → MetaNav.followTarget + routeType 3, hex `prt` guids, metaf string
//     escapes. navText is produced by nav_file.writeNav from raw lines built
//     from the source tokens (number text kept as written); an empty NAV body
//     ⇒ navText "".
// Writer: proper metaf — every string argument braced (and escaped), rule and
// state order preserved (rules grouped per state in order of first
// appearance), NAV: sections in node syntax; a route metaf cannot express (an
// unknown recall spell id, an unparseable point) is written as a NAVDATA:
// block instead (lossless; read back by this module and RynthAi).

import { parseAfNavs, parseNav, writeNav, RECALL_SPELL_NAMES } from "../../nav_file.js";
import {
  condByKw,
  actByKw,
  newRuleId,
  NAV_HEADER,
  ROUTE_TYPE_NAMES,
  ROUTE_TYPE_BY_NAME,
  navTextInfo,
  followNavText,
  isNavTag,
  sanitizeNavTag,
  findNav,
  orderFields,
} from "./meta_schema.js";

const MAX_DEPTH = 64;

// ── lexing ─────────────────────────────────────────────────────────────────
/** Column of the first non-blank character (tabs → next multiple of 4). */
function indentOf(line) {
  let col = 0;
  for (const ch of line) {
    if (ch === "\t") col = (Math.floor(col / 4) + 1) * 4;
    else if (ch === " ") col++;
    else break;
  }
  return col;
}

// metaf string at s[i] === "{": `{{`→`{`, `}}`→`}`, a single `}` closes; it
// must be followed by whitespace, a comment or the end of the line.
function readStrict(s, i) {
  let out = "";
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === "{") {
      if (s[j + 1] === "{") {
        out += "{";
        j += 2;
        continue;
      }
      return null;
    }
    if (c === "}") {
      if (s[j + 1] === "}") {
        out += "}";
        j += 2;
        continue;
      }
      const next = s[j + 1];
      if (next === undefined || next === " " || next === "\t" || (next === "~" && s[j + 2] === "~")) return { value: out, end: j + 1 };
      return null;
    }
    out += c;
    j++;
  }
  return null;
}
// RynthAi / hand-written: braces balanced by depth, content kept raw.
function readDepth(s, i) {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === "{") depth++;
    else if (s[j] === "}") {
      depth--;
      if (depth === 0) return { value: s.slice(i + 1, j), end: j + 1 };
    }
  }
  return { value: s.slice(i + 1), end: s.length, unterminated: true };
}

/**
 * Tokenise the argument text of one line: `{strings}` and bare words, up to
 * a `~~` comment outside strings. → { tokens: [{str:boolean, value}], warnings }
 */
function lexArgs(s) {
  const tokens = [];
  const warnings = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    if (c === "~" && s[i + 1] === "~") break;
    if (c === "{") {
      let r = readStrict(s, i);
      if (!r) {
        r = readDepth(s, i);
        if (r.unterminated) warnings.push("unterminated {string}");
      }
      tokens.push({ str: true, value: r.value });
      i = r.end;
      continue;
    }
    let j = i;
    while (j < s.length && s[j] !== " " && s[j] !== "\t" && s[j] !== "{" && !(s[j] === "~" && s[j + 1] === "~")) j++;
    tokens.push({ str: false, value: s.slice(i, j) });
    i = j;
  }
  return { tokens, warnings };
}

const KW_RE = /^([A-Za-z_][A-Za-z0-9_]*)/;

// ── argument specs (metaf orders) ──────────────────────────────────────────
// s string · i integer · d number · hex8 full uint32 hex · block landblock hex
// (4 or 8 digits) · word bare literal · s? optional string
const COND_AF = {
  ChatMatch: [["re", "s"]],
  MainSlotsLE: [["n", "i"]],
  SecsInStateGE: [["secs", "i"]],
  PSecsInStateGE: [["secs", "i"]],
  BuPercentGE: [["pct", "i"]],
  ItemCountLE: [["count", "i"], ["name", "s"]],
  ItemCountGE: [["count", "i"], ["name", "s"]],
  MobsInDist_Name: [["count", "i"], ["dist", "d"], ["re", "s"]],
  MobsInDist_Priority: [["count", "i"], ["dist", "d"], ["priority", "i"]],
  NoMobsInDist: [["dist", "d"]],
  BlockE: [["value", "block"]],
  CellE: [["value", "hex8"]],
  SecsOnSpellGE: [["secs", "i"], ["spellId", "i"]],
  DistToRteGE: [["dist", "d"]],
  Expr: [["expr", "s"]],
  ChatCapture: [["re", "s"], ["colors", "s"]],
};
const ACT_AF = {
  SetState: [["state", "s"]],
  Chat: [["text", "s"]],
  EmbedNav: [["tag", "word"], ["displayName", "s"], ["_xf", "s?"]],
  CallState: [["state", "s"], ["ret", "s"]],
  DoExpr: [["expr", "s"]],
  ChatExpr: [["expr", "s"]],
  SetWatchdog: [["dist", "d"], ["secs", "d"], ["state", "s"]],
  GetOpt: [["opt", "s"], ["var", "s"]],
  SetOpt: [["opt", "s"], ["expr", "s"]],
  CreateView: [["view", "s"], ["xml", "s"]],
  DestroyView: [["view", "s"]],
};

function parseHex(s) {
  const t = String(s).trim().replace(/^0x/i, "");
  return /^[0-9A-Fa-f]{1,8}$/.test(t) ? parseInt(t, 16) >>> 0 : NaN;
}

function convertArg(tok, type) {
  const v = tok.value;
  switch (type) {
    case "s":
    case "s?":
      return { ok: true, value: v };
    case "word":
      return { ok: !tok.str && v.length > 0, value: v };
    case "i": {
      const n = Number(v.trim());
      return { ok: v.trim() !== "" && Number.isFinite(n), value: Number.isFinite(n) ? Math.trunc(n) : 0 };
    }
    case "d": {
      const n = Number(v.trim());
      return { ok: v.trim() !== "" && Number.isFinite(n), value: Number.isFinite(n) ? n : 0 };
    }
    case "hex8": {
      const n = parseHex(v);
      return { ok: Number.isFinite(n), value: Number.isFinite(n) ? n : 0 };
    }
    case "block": {
      // `BlockE XXXX0000` (metaf) or `BlockE XXXX` (landblock only, Appendix B).
      const t = v.trim().replace(/^0x/i, "");
      const n = parseHex(t);
      if (!Number.isFinite(n)) return { ok: false, value: 0 };
      return { ok: true, value: t.length <= 4 ? (n << 16) >>> 0 : n };
    }
    default:
      return { ok: false, value: 0 };
  }
}

/**
 * One operation (keyword + args) of `kind` "cond"|"act" from a line's text.
 * → { node, container } — container = the node that takes indented children
 * (All/Any/DoAll, a child-less Not, or the innermost compound of a `Not …`
 * chain), else null.
 */
function parseOp(text, kind, where, warn, depth = 0) {
  const s = String(text ?? "").replace(/^\s+/, "");
  const m = KW_RE.exec(s);
  const unknown = (kw, raw) => {
    warn(`${where}: unknown ${kind === "cond" ? "condition" : "action"} keyword ${JSON.stringify(kw)} — loaded as ${kind === "cond" ? "Never" : "None"}`);
    return { node: { t: kind === "cond" ? "Never" : "None", unknownKeyword: kw, _af: raw.replace(/\s*~~.*$/, "").trim() }, container: null };
  };
  if (!m) {
    if (!s.trim() || s.startsWith("~~")) return { node: null, container: null };
    return unknown(s.split(/\s+/)[0], s);
  }
  const kw = m[1];
  const row = kind === "cond" ? condByKw(kw) : actByKw(kw);
  if (!row) return unknown(kw, s);
  const rest = s.slice(kw.length);
  if (row.kw !== kw) warn(`${where}: keyword ${kw} read as ${row.kw}`);
  const node = { t: row.kw };
  if (row.kw === "Not") {
    node.children = [];
    const inner = rest.replace(/^\s+/, "");
    if (inner && !inner.startsWith("~~")) {
      if (depth >= MAX_DEPTH) {
        warn(`${where}: Not chain deeper than ${MAX_DEPTH}`);
        return { node, container: null };
      }
      const r = parseOp(inner, kind, where, warn, depth + 1);
      if (r.node) node.children.push(r.node);
      return { node, container: r.container };
    }
    return { node, container: node };
  }
  const { tokens, warnings } = lexArgs(rest);
  for (const w of warnings) warn(`${where}: ${w}`);
  if (row.compound) {
    node.children = [];
    if (tokens.length) warn(`${where}: ${row.kw} takes no arguments (ignored: ${tokens.map((t) => t.value).join(" ")})`);
    return { node, container: node };
  }
  const spec = (kind === "cond" ? COND_AF : ACT_AF)[row.kw] || [];
  // RynthAi's writer emits ChatMatch / Expr UNBRACED (U5 §9 B19): a bare
  // first token takes the rest of the line (up to a comment) as the string,
  // so `Expr testvar[a] && getvar[b]==1` is not cut at the first space.
  if (kind === "cond" && (row.kw === "ChatMatch" || row.kw === "Expr") && tokens.length && !tokens[0].str) {
    warn(`${where}: ${row.kw} argument is not a {string} (RynthAi form; read to the end of the line)`);
    node[spec[0][0]] = stripComment(rest).trim();
    return { node: orderFields(node, kind), container: null };
  }
  let k = 0;
  for (const [field, type] of spec) {
    const tok = tokens[k];
    if (!tok) {
      if (type !== "s?") {
        warn(`${where}: ${row.kw} is missing its ${field} argument`);
        node[field] = type === "s" || type === "word" ? "" : 0;
      }
      continue;
    }
    k++;
    const r = convertArg(tok, type);
    if (!r.ok) warn(`${where}: ${row.kw} ${field} ${JSON.stringify(tok.value)} is not a valid ${type === "word" ? "tag" : type}`);
    if (field === "_xf") {
      warn(`${where}: EmbedNav point transform {${tok.value}} is not supported (ignored)`);
      continue;
    }
    node[field] = r.value;
  }
  if (k < tokens.length) warn(`${where}: ${row.kw} has extra arguments (ignored: ${tokens.slice(k).map((t) => t.value).join(" ")})`);
  return { node: orderFields(node, kind), container: null };
}

// Attach indented child lines (each {no, indent, text}) under `root`.
function buildTree(root, rootIndent, childLines, kind, warn) {
  const stack = [{ indent: rootIndent, container: root.container }];
  for (const rec of childLines) {
    while (stack.length > 1 && rec.indent <= stack[stack.length - 1].indent) stack.pop();
    const top = stack[stack.length - 1];
    const where = `line ${rec.no}`;
    const r = parseOp(rec.text, kind, where, warn);
    if (!r.node) continue;
    if (!top.container) {
      warn(`${where}: indented ${kind === "cond" ? "condition" : "action"} has no ${kind === "cond" ? "All/Any/Not" : "DoAll"} above it (ignored)`);
      continue;
    }
    if (top.container.t === "Not" && top.container.children.length >= 1) {
      warn(`${where}: Not takes exactly one condition (extra ignored)`);
      continue;
    }
    if (stack.length > MAX_DEPTH) {
      warn(`${where}: nesting deeper than ${MAX_DEPTH} (ignored)`);
      continue;
    }
    top.container.children.push(r.node);
    if (r.container) stack.push({ indent: rec.indent, container: r.container });
  }
}

const STRUCT_RE = /^(STATE:|IF:|DO:|NAV:|NAVDATA:)/;

function stripComment(s) {
  // ~~ outside {strings} starts a comment (brace-aware).
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "{") depth++;
    else if (c === "}") depth = Math.max(0, depth - 1);
    else if (c === "~" && s[i + 1] === "~" && depth === 0) return s.slice(0, i);
  }
  return s;
}

// ── NAV sections ───────────────────────────────────────────────────────────
const signed32 = (n) => (Number(n) || 0) | 0;
const isNum = (s) => typeof s === "string" && s.trim() !== "" && Number.isFinite(Number(s.trim()));
const oneLine = (s) => String(s ?? "").replace(/\r\n|\r|\n/g, " ");

// nav_file.parseAfNavs on ONE node line (so the result lines up with it).
function delegatePoint(lineText) {
  try {
    const out = parseAfNavs(`NAV: x circular ~~ {\n\t${lineText}\n~~ }\n`);
    const p = out && out.x && out.x.points ? out.x.points[0] : null;
    return p || null;
  } catch {
    return null;
  }
}

// One NAV: node line → { point } | { follow } | { skip }.
function navNode(rec, warn) {
  const where = `line ${rec.no}`;
  const { tokens, warnings } = lexArgs(rec.text);
  for (const w of warnings) warn(`${where}: ${w}`);
  if (!tokens.length) return { skip: true };
  const kw = tokens[0].str ? "" : tokens[0].value;
  const args = tokens.slice(1);
  const val = (i) => (args[i] ? args[i].value.trim() : "");
  const xyz = () => {
    if (![0, 1, 2].every((i) => args[i] && !args[i].str && isNum(args[i].value))) return null;
    return [val(0), val(1), val(2)];
  };
  const bad = (msg) => {
    warn(`${where}: ${kw || "?"} ${msg} (point skipped)`);
    return { skip: true };
  };
  if (kw === "flw") {
    const g = parseHex(val(0));
    if (!Number.isFinite(g) || !args[1]) return bad("needs GUIDHEX {name}");
    return { follow: { guid: g, name: args[1].value } };
  }
  const c = xyz();
  const head = (type) => [String(type), c[0], c[1], c[2], "0"];
  const pt = (type, raw, extra = {}) => ({ point: { type, ew: Number(c[0]), ns: Number(c[1]), z: Number(c[2]), flag: "0", ...extra, raw } });
  switch (kw) {
    case "pnt":
    case "chk": {
      if (!c) return bad("needs x y z");
      const p = delegatePoint(rec.text);
      if (!p) return bad("is malformed");
      return pt(kw === "pnt" ? 0 : 8, head(kw === "pnt" ? 0 : 8));
    }
    case "pau": {
      if (!c || !isNum(val(3))) return bad("needs x y z ms");
      const p = delegatePoint(rec.text);
      if (!p) return bad("is malformed");
      return pt(3, [...head(3), val(3)], { pauseMs: p.pauseMs });
    }
    case "cht": {
      if (!c || !args[3]) return bad("needs x y z {text}");
      const text = oneLine(args[3].value);
      return pt(4, [...head(4), text], { chat: text });
    }
    case "rcl": {
      if (!c || !args[3]) return bad("needs x y z {Recall Name}");
      const p = delegatePoint(rec.text);
      // nav_file maps the name with depth-counted braces; re-map escaped names.
      let spellId = p && p.spellId ? p.spellId : 0;
      if (!spellId) {
        const p2 = delegatePoint(`rcl ${c[0]} ${c[1]} ${c[2]} {${args[3].value}}`);
        spellId = p2 && p2.spellId ? p2.spellId : 0;
      }
      if (!spellId) warn(`${where}: unknown recall spell name {${args[3].value}} (spell id 0)`);
      return pt(2, [...head(2), String(spellId)], { spellId });
    }
    case "prt": {
      const g = parseHex(val(3));
      if (!c || !Number.isFinite(g)) return bad("needs x y z GUIDHEX");
      return pt(1, [...head(1), String(signed32(g))], { guid: g });
    }
    case "vnd": {
      const g = parseHex(val(3));
      if (!c || !Number.isFinite(g) || !args[4]) return bad("needs x y z GUIDHEX {name}");
      const name = oneLine(args[4].value);
      return pt(5, [...head(5), String(signed32(g)), name], { vendorId: g, name });
    }
    case "ptl":
    case "tlk": {
      const ok = c && [3, 4, 5].every((i) => isNum(val(i))) && /^[-+]?\d+$/.test(val(6)) && args[7];
      if (!ok) return bad("needs x y z ox oy oz class {name}");
      if (kw === "ptl" && !delegatePoint(rec.text)) return bad("is malformed");
      const type = kw === "ptl" ? 6 : 7;
      const name = oneLine(args[7].value);
      const cls = parseInt(val(6), 10);
      // VTank always stores "True" here (metaf NPortal_NPC.cs / NNPCTalk.cs).
      const raw = [...head(type), name, String(cls), "True", val(3), val(4), val(5)];
      return pt(type, raw, { name, objectClass: cls, isTie: true, exitEW: Number(val(3)), exitNS: Number(val(4)), exitZ: Number(val(5)) });
    }
    case "jmp": {
      const shift = args[4] ? args[4].value.trim() : "";
      if (!c || !isNum(val(3)) || !/^(true|false)$/i.test(shift) || !isNum(val(5))) return bad("needs x y z heading {True|False} delayMs");
      const p = delegatePoint(rec.text);
      if (!p) return bad("is malformed");
      const hold = /^true$/i.test(shift);
      return pt(9, [...head(9), val(3), hold ? "True" : "False", val(5)], { headingDeg: Number(val(3)), holdShift: hold, delayMs: Number(val(5)) });
    }
    default:
      warn(`${where}: unknown nav node type ${JSON.stringify(kw)} (skipped)`);
      return { skip: true };
  }
}

function parseNavSection(lines, i, out, warn) {
  const rec = lines[i];
  const head = stripComment(rec.text.slice("NAV:".length)).trim();
  const parts = head.split(/\s+/).filter(Boolean);
  const tag = parts[0] || "";
  const typeName = (parts[1] || "circular").toLowerCase();
  let routeType = ROUTE_TYPE_BY_NAME[typeName];
  if (!routeType) {
    warn(`line ${rec.no}: unknown NAV type ${JSON.stringify(parts[1] || "")} (circular)`);
    routeType = 1;
  }
  if (tag && !isNavTag(tag)) warn(`line ${rec.no}: NAV tag ${JSON.stringify(tag)} is not a metaf literal`);
  i++;
  const points = [];
  let follow = null;
  while (i < lines.length) {
    const r = lines[i];
    if (r.blank) {
      i++;
      continue;
    }
    if (/^(NAV:|NAVDATA:|STATE:)/.test(r.text)) break;
    if (/^(IF:|DO:)/.test(r.text)) {
      warn(`line ${r.no}: ${r.text.slice(0, 3)} inside a NAV section (STATE:/IF:/DO: must come before the first NAV:)`);
      break;
    }
    const n = navNode(r, warn);
    if (n.point) points.push(n.point);
    else if (n.follow) {
      if (follow) warn(`line ${r.no}: a follow nav takes one flw node (extra ignored)`);
      else follow = n.follow;
    }
    i++;
  }
  if (!tag) {
    warn(`line ${rec.no}: NAV section without a tag (ignored)`);
    return i;
  }
  if (tag === "__proto__") {
    warn(`line ${rec.no}: NAV tag __proto__ is reserved (ignored)`);
    return i;
  }
  if (findNav(out, tag)) warn(`line ${rec.no}: NAV ${tag} defined twice (the last one wins)`);
  const nav = { displayName: "", routeType, navText: "" };
  if (follow || routeType === 3) {
    if (points.length) warn(`line ${rec.no}: NAV ${tag}: points in a follow nav ignored`);
    if (follow) {
      nav.routeType = 3;
      nav.followTarget = follow;
      nav.navText = followNavText(follow);
    } else warn(`line ${rec.no}: follow NAV ${tag} has no flw node (empty)`);
  } else if (points.length) {
    nav.navText = writeNav({ header: NAV_HEADER, routeType, points, eol: "\r\n", trailingEol: true });
  }
  out[tag] = nav;
  return i;
}

// RynthAi `NAVDATA: <name> <count> ~~ {` + count verbatim uTank2 lines.
function parseNavData(lines, i, out, warn, rawLines) {
  const rec = lines[i];
  const body = stripComment(rec.text.slice("NAVDATA:".length)).trim();
  const sp = body.lastIndexOf(" ");
  const tag = sp > 0 ? body.slice(0, sp).trim() : body;
  const count = sp > 0 ? parseInt(body.slice(sp + 1), 10) || 0 : 0;
  i++;
  const navLines = [];
  for (let k = 0; k < count && i < lines.length; k++, i++) navLines.push(rawLines[lines[i].idx]);
  if (navLines.length < count) warn(`line ${rec.no}: NAVDATA ${tag} ended after ${navLines.length} of ${count} lines`);
  if (i < lines.length && lines[i].text.trim() === "~~ }") i++;
  if (!tag) return i;
  if (tag === "__proto__") {
    warn(`line ${rec.no}: NAVDATA tag __proto__ is reserved (ignored)`);
    return i;
  }
  const text = navLines.join("\r\n") + "\r\n";
  const info = navTextInfo(text);
  const nav = { displayName: "", routeType: [1, 2, 3, 4].includes(info.routeType) ? info.routeType : 1, navText: "" };
  if (!info.ok) warn(`line ${rec.no}: NAVDATA ${tag} is not uTank2 NAV text (empty route)`);
  else if (info.follow) {
    nav.followTarget = info.follow;
    nav.navText = text;
  } else if (!info.empty) {
    const parsed = parseAfNavs(`NAVDATA: ${tag.replace(/\s+/g, "_")} ${navLines.length} ~~ {\n${navLines.join("\n")}\n~~ }\n`);
    const p = parsed[tag.replace(/\s+/g, "_")];
    if (p && p.warning) warn(`line ${rec.no}: NAVDATA ${tag}: ${p.warning}`);
    nav.navText = p ? writeNav(p) : text;
  }
  out[tag] = nav;
  return i;
}

// ── reader ─────────────────────────────────────────────────────────────────
function baseName(fileName) {
  const f = String(fileName ?? "")
    .split(/[\\/]/)
    .pop();
  return f.replace(/\.(af|met|json)$/i, "");
}

function walkActs(act, fn, depth = 0) {
  if (!act || typeof act !== "object" || depth > MAX_DEPTH) return;
  fn(act);
  if (Array.isArray(act.children)) for (const ch of act.children) walkActs(ch, fn, depth + 1);
}

/**
 * Parse metaf `.af` text. → { ok: true, meta, warnings } | { ok: false, warnings, error }
 * Never throws (like parseMet).
 */
export function parseAf(text, opts = {}) {
  try {
    return parseAfText(text, opts);
  } catch (e) {
    return { ok: false, warnings: [], error: `.af parse failed: ${e && e.message ? e.message : e}` };
  }
}

function parseAfText(text, opts) {
  const fileName = opts && typeof opts === "object" ? opts.fileName : undefined;
  const warnings = [];
  if (typeof text !== "string") return { ok: false, warnings, error: ".af data must be text" };
  const warn = (m) => warnings.push(m);
  const rawLines = text.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/);
  const lines = rawLines.map((raw, idx) => {
    const t = raw.replace(/^\s+/, "");
    const blank = !t || t.startsWith("~~");
    return { no: idx + 1, idx, indent: indentOf(raw), text: t, blank, disabled: /^~~\s*@disabled\b/i.test(t) };
  });
  const rules = [];
  const ids = new Set();
  const navs = {};
  let state = null;
  let pendingDisabled = false;
  let i = 0;
  while (i < lines.length) {
    const rec = lines[i];
    if (rec.blank) {
      if (rec.disabled) pendingDisabled = true;
      i++;
      continue;
    }
    if (rec.text.startsWith("STATE:")) {
      const { tokens } = lexArgs(rec.text.slice("STATE:".length));
      const name = tokens.length ? tokens[0].value : "";
      if (!tokens.length || !tokens[0].str) warn(`line ${rec.no}: STATE: name should be a {string}`);
      if (!name.trim()) warn(`line ${rec.no}: empty state name`);
      state = name;
      pendingDisabled = false;
      i++;
      continue;
    }
    if (rec.text.startsWith("NAVDATA:")) {
      i = parseNavData(lines, i, navs, warn, rawLines);
      continue;
    }
    if (rec.text.startsWith("NAV:")) {
      i = parseNavSection(lines, i, navs, warn);
      continue;
    }
    if (rec.text.startsWith("IF:")) {
      i = parseRule(lines, i, state, pendingDisabled, rules, ids, warn);
      pendingDisabled = false;
      continue;
    }
    if (rec.text.startsWith("DO:")) warn(`line ${rec.no}: DO: without an IF: (skipped)`);
    else warn(`line ${rec.no}: unexpected line ${JSON.stringify(rec.text.slice(0, 40))} (skipped)`);
    i++;
  }
  if (!rules.length && !Object.keys(navs).length) return { ok: false, warnings, error: "no STATE:/IF:/DO: rules or NAV: sections found — not a metaf file" };
  // Link EmbedNav citations ↔ NAV sections (display names come from the citation).
  const cited = new Set();
  for (const r of rules) {
    walkActs(r.act, (a) => {
      if (a.t !== "EmbedNav") return;
      const nav = findNav(navs, a.tag);
      if (!nav) {
        warn(`rule ${r.id}: EmbedNav cites nav "${a.tag}" which is never defined`);
        return;
      }
      cited.add(nav);
      if (!nav.displayName) nav.displayName = a.displayName || "";
    });
  }
  for (const tag of Object.keys(navs)) {
    if (!cited.has(navs[tag])) {
      warn(`NAV ${tag} is never used by an EmbedNav`);
      if (!navs[tag].displayName) navs[tag].displayName = tag;
    }
  }
  const source = { kind: "af" };
  if (fileName) source.fileName = String(fileName);
  const meta = { v: 1, name: baseName(fileName), source, rules, navs, warnings: warnings.slice() };
  return { ok: true, meta, warnings };
}

// The lines indented under an IF:/DO: line. Blank/comment lines are consumed
// only when more children follow them, so a `~~ @disabled` marker for the
// NEXT rule is left for the caller.
function collectChildren(lines, i, rootIndent) {
  const kids = [];
  while (i < lines.length) {
    let j = i;
    while (j < lines.length && lines[j].blank) j++;
    if (j >= lines.length) break;
    const r = lines[j];
    if (STRUCT_RE.test(r.text) || r.indent <= rootIndent) break;
    kids.push(r);
    i = j + 1;
  }
  return { kids, next: i };
}

function parseRule(lines, i, state, disabled, rules, ids, warn) {
  const ifRec = lines[i];
  const condText = ifRec.text.slice(3);
  const where = `line ${ifRec.no}`;
  let condRoot = parseOp(condText, "cond", where, warn);
  let virtual = false;
  if (!condRoot.node) {
    // "IF:" alone on its line: the next deeper line is the condition.
    virtual = true;
    const holder = { t: "__root", children: [] };
    condRoot = { node: holder, container: holder };
  }
  const ck = collectChildren(lines, i + 1, ifRec.indent);
  i = ck.next;
  buildTree(condRoot, ifRec.indent, ck.kids, "cond", warn);
  let cond = condRoot.node;
  if (virtual) {
    if (cond.children.length > 1) warn(`${where}: IF: has ${cond.children.length} conditions (the first is used)`);
    cond = cond.children[0] || null;
    if (!cond) {
      warn(`${where}: IF: without a condition (Never)`);
      cond = { t: "Never" };
    }
  }
  // DO:
  while (i < lines.length && lines[i].blank) i++;
  let act = { t: "None" };
  if (i < lines.length && lines[i].text.startsWith("DO:")) {
    const doRec = lines[i];
    const dw = `line ${doRec.no}`;
    let actRoot = parseOp(doRec.text.slice(3), "act", dw, warn);
    let vAct = false;
    if (!actRoot.node) {
      vAct = true;
      const holder = { t: "__root", children: [] };
      actRoot = { node: holder, container: holder };
    }
    const ak = collectChildren(lines, i + 1, doRec.indent);
    i = ak.next;
    buildTree(actRoot, doRec.indent, ak.kids, "act", warn);
    act = actRoot.node;
    if (vAct) {
      if (act.children.length > 1) warn(`${dw}: DO: has ${act.children.length} actions (the first is used)`);
      act = act.children[0] || { t: "None" };
    }
  } else warn(`${where}: IF: without a DO: (action None)`);
  if (state === null) {
    warn(`${where}: rule outside a STATE: block (state Default)`);
    state = "Default";
  }
  const id = newRuleId(ids);
  ids.add(id);
  rules.push({ id, state, enabled: !disabled, cond, act });
  return i;
}

// ── writer ─────────────────────────────────────────────────────────────────
/** A metaf string argument: braces doubled, line breaks flattened. */
function q(s) {
  return `{${String(s ?? "")
    .replace(/\r\n|\r|\n/g, " ")
    .replace(/\{/g, "{{")
    .replace(/\}/g, "}}")}}`;
}
function fmtI(n) {
  // metaf / VTank read integers with Int32.Parse (clamped like met.js).
  const v = Math.trunc(Number(n) || 0);
  return String(v > 2147483647 ? 2147483647 : v < -2147483648 ? -2147483648 : v);
}
function fmtD(n) {
  const v = Number(n);
  return String(Number.isFinite(v) ? v : 0);
}
function hex8(n) {
  return ((Number(n) || 0) >>> 0).toString(16).toUpperCase().padStart(8, "0");
}
function fmtArg(type, v) {
  switch (type) {
    case "s":
      return q(v);
    case "i":
      return fmtI(v);
    case "d":
      return fmtD(v);
    case "hex8":
    case "block":
      return hex8(v);
    default:
      return String(v ?? "");
  }
}

function opText(node, kind, tagOf) {
  if (!node || typeof node !== "object") return kind === "cond" ? "Never" : "None";
  if (node.unknownKeyword !== undefined) {
    const orig = node._af || node.unknownKeyword;
    return `${kind === "cond" ? "Never" : "None"} ~~ unknown ${kind === "cond" ? "condition" : "action"}: ${String(orig).replace(/[\r\n]+/g, " ")}`;
  }
  const row = kind === "cond" ? condByKw(node.t) : actByKw(node.t);
  if (!row) return kind === "cond" ? "Never" : "None";
  if (row.kw === "EmbedNav") return `EmbedNav ${tagOf(node.tag)} ${q(node.displayName ?? "")}`;
  const spec = (kind === "cond" ? COND_AF : ACT_AF)[row.kw];
  if (!spec) return row.kw;
  return [row.kw, ...spec.filter(([f]) => f[0] !== "_").map(([f, type]) => fmtArg(type, node[f]))].join(" ");
}

// [{depth, text}] for a condition tree (Not shares its line and depth).
function condLines(node, depth, tagOf, guard = 0) {
  if (guard > MAX_DEPTH) return [{ depth, text: "Never ~~ (nesting too deep)" }];
  if (node && node.t === "Not" && node.unknownKeyword === undefined) {
    const ch = Array.isArray(node.children) ? node.children : [];
    if (!ch.length) return [{ depth, text: "Not ~~ (no operand)" }];
    const inner = condLines(ch[0], depth, tagOf, guard + 1);
    inner[0] = { depth, text: `Not ${inner[0].text}` };
    return inner;
  }
  const out = [{ depth, text: opText(node, "cond", tagOf) }];
  if (node && (node.t === "All" || node.t === "Any") && node.unknownKeyword === undefined) {
    for (const ch of Array.isArray(node.children) ? node.children : []) out.push(...condLines(ch, depth + 1, tagOf, guard + 1));
  }
  return out;
}
function actLines(node, depth, tagOf, guard = 0) {
  if (guard > MAX_DEPTH) return [{ depth, text: "None ~~ (nesting too deep)" }];
  const out = [{ depth, text: opText(node, "act", tagOf) }];
  if (node && node.t === "DoAll" && node.unknownKeyword === undefined) {
    for (const ch of Array.isArray(node.children) ? node.children : []) out.push(...actLines(ch, depth + 1, tagOf, guard + 1));
  }
  return out;
}

// A route as metaf node lines, or null when metaf cannot express it.
function navNodeLines(nav) {
  const navText = String(nav.navText ?? "");
  const ft = nav.followTarget && typeof nav.followTarget === "object" ? nav.followTarget : null;
  const info = navTextInfo(navText);
  if (info.follow || ft) {
    const t = info.follow || ft;
    return [`\tflw ${hex8(t.guid)} ${q(t.name)}`];
  }
  if (info.empty) return [];
  if (!info.ok) return null;
  const parsed = parseNav(navText);
  if (parsed.warning || parsed.points.length !== parsed.pointCount) return null;
  const out = [];
  for (const p of parsed.points) {
    const raw = Array.isArray(p.raw) && p.raw.length >= 5 ? p.raw.map((s) => String(s).trim()) : null;
    // metaf node syntax has no flag/colour line (it requires "0"): keep any
    // other value losslessly through the NAVDATA fallback.
    if (raw && raw[4] !== "0") return null;
    const num = (i, v) => (raw && raw[i] !== undefined ? raw[i] : fmtD(v));
    const xyz = `${num(1, p.ew)} ${num(2, p.ns)} ${num(3, p.z)}`;
    switch (p.type) {
      case 0:
        out.push(`\tpnt ${xyz}`);
        break;
      case 1:
        out.push(`\tprt ${xyz} ${hex8(p.guid)}`);
        break;
      case 2: {
        const name = RECALL_SPELL_NAMES[p.spellId];
        if (!name) return null;
        out.push(`\trcl ${xyz} ${q(name)}`);
        break;
      }
      case 3:
        out.push(`\tpau ${xyz} ${num(5, p.pauseMs)}`);
        break;
      case 4:
        out.push(`\tcht ${xyz} ${q(raw ? (p.raw[5] ?? "") : p.chat)}`);
        break;
      case 5:
        out.push(`\tvnd ${xyz} ${hex8(p.vendorId)} ${q(p.name)}`);
        break;
      case 6:
      case 7:
        out.push(`\t${p.type === 6 ? "ptl" : "tlk"} ${xyz} ${num(8, p.exitEW)} ${num(9, p.exitNS)} ${num(10, p.exitZ)} ${fmtI(p.objectClass)} ${q(p.name)}`);
        break;
      case 8:
        out.push(`\tchk ${xyz}`);
        break;
      case 9:
        out.push(`\tjmp ${xyz} ${num(5, p.headingDeg)} ${q(p.holdShift ? "True" : "False")} ${num(7, p.delayMs)}`);
        break;
      default:
        return null;
    }
  }
  return out;
}

/**
 * Serialise a Meta to metaf `.af` text (CRLF). States keep the order of their
 * first rule; rules keep their order within a state; disabled rules carry a
 * `~~ @disabled` marker.
 */
export function writeAf(meta) {
  const m = meta && typeof meta === "object" ? meta : {};
  const rules = Array.isArray(m.rules) ? m.rules.filter((r) => r && typeof r === "object") : [];
  const navs = m.navs && typeof m.navs === "object" ? m.navs : {};
  // Tags → metaf literals (unique, case-insensitive).
  const tagMap = new Map();
  // "__proto__" cannot be a key of the plain-object `navs` a reader builds.
  const usedLower = new Set(["__proto__"]);
  const literalFor = (tag) => {
    const key = String(tag ?? "");
    if (tagMap.has(key)) return tagMap.get(key);
    const navKey = Object.keys(navs).find((k) => k === key) ?? Object.keys(navs).find((k) => k.toLowerCase() === key.toLowerCase());
    if (navKey !== undefined && navKey !== key && tagMap.has(navKey)) {
      tagMap.set(key, tagMap.get(navKey));
      return tagMap.get(key);
    }
    let base = isNavTag(key) ? key : sanitizeNavTag(key) || "nav";
    let t = base;
    for (let k = 2; usedLower.has(t.toLowerCase()); k++) t = `${base}_${k}`;
    usedLower.add(t.toLowerCase());
    tagMap.set(key, t);
    if (navKey !== undefined && navKey !== key) tagMap.set(navKey, t);
    return t;
  };
  const navOrder = [];
  const seenNav = new Set();
  for (const r of rules) {
    walkActs(r.act, (a) => {
      if (a.t !== "EmbedNav") return;
      const key = String(a.tag ?? "");
      const navKey = Object.keys(navs).find((k) => k === key) ?? Object.keys(navs).find((k) => k.toLowerCase() === key.toLowerCase());
      literalFor(navKey ?? key);
      if (navKey !== undefined && !seenNav.has(navKey)) {
        seenNav.add(navKey);
        navOrder.push(navKey);
      }
    });
  }
  for (const k of Object.keys(navs)) {
    if (!seenNav.has(k)) {
      seenNav.add(k);
      navOrder.push(k);
      literalFor(k);
    }
  }
  const out = [];
  out.push("~~ Written by holtburger-web RynthSuite in metaf syntax (https://github.com/JJEII/metaf).");
  out.push("~~ Load it in VTank with metaf, or import it back into the RynthSuite meta library.");
  out.push("");
  const states = [];
  const byState = new Map();
  for (const r of rules) {
    const s = String(r.state ?? "");
    if (!byState.has(s)) {
      byState.set(s, []);
      states.push(s);
    }
    byState.get(s).push(r);
  }
  for (const s of states) {
    out.push(`STATE: ${q(s)} ~~ {`);
    for (const r of byState.get(s)) {
      if (r.enabled === false) out.push("\t~~ @disabled");
      const c = condLines(r.cond, 2, literalFor);
      out.push(`\tIF:\t${c[0].text}`);
      for (const l of c.slice(1)) out.push(`${"\t".repeat(l.depth)}${l.text}`);
      const a = actLines(r.act, 3, literalFor);
      out.push(`\t\tDO:\t${a[0].text}`);
      for (const l of a.slice(1)) out.push(`${"\t".repeat(l.depth)}${l.text}`);
    }
    out.push("~~ }");
  }
  if (navOrder.length) {
    out.push("");
    out.push("~~========================= ONLY NAVS APPEAR BELOW THIS LINE =========================~~");
    out.push("");
    for (const key of navOrder) {
      const nav = navs[key] && typeof navs[key] === "object" ? navs[key] : { routeType: 1, navText: "" };
      const tag = literalFor(key);
      const nodes = navNodeLines(nav);
      if (nodes) {
        const info = navTextInfo(String(nav.navText ?? ""));
        // The navText header is what NAV runs and what writeMet embeds;
        // MetaNav.routeType only types a route without text.
        const rt = info.follow || nav.followTarget ? 3 : info.ok && [1, 2, 3, 4].includes(info.routeType) ? info.routeType : [1, 2, 3, 4].includes(nav.routeType) ? nav.routeType : 1;
        out.push(`NAV: ${tag} ${ROUTE_TYPE_NAMES[rt] || "circular"} ~~ {`);
        out.push(...nodes);
        out.push("~~ }");
      } else {
        const navLines = String(nav.navText ?? "").replace(/(\r\n|\r|\n)$/, "").split(/\r\n|\r|\n/);
        out.push("~~ metaf has no node syntax for this route (e.g. an unknown recall spell id): lossless RynthAi NAVDATA block");
        out.push(`NAVDATA: ${tag} ${navLines.length} ~~ {`);
        out.push(...navLines);
        out.push("~~ }");
      }
    }
  }
  return out.join("\r\n") + "\r\n";
}

export default { parseAf, writeAf };
