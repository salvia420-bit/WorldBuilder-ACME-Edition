// rynth/vt/formats/met.js — VTank `.met` reader/writer (W1-3 FMT, PLAN §3.6,
// Appendix B; grammar U5 §6.1, verified against all 17 corpus files and the
// metaf source, metaf-project Operations/{Conditions,Actions}/*.cs).
//
//   file  := [UTF-8 BOM] "1" EOL "CondAct" EOL table
//   table := ncols EOL colname{ncols} EOL coltype{ncols} EOL nrows EOL value{ncols*nrows}
//   value := "n" | "i" EOL int | "d" EOL double | "s" EOL line
//          | "ba" EOL nbytes EOL <nbytes raw bytes, no EOL after>   | "TABLE" EOL table
//   root columns: CType(i) AType(i) CData(value) AData(value) State(s)
//
// The file is read as BYTES (a Uint8Array): `ba` counts are byte counts, so a
// multi-byte name or a CreateView XML that runs straight into the next line
// ("s" right after the XML — VTank requires that, metaf ACreateView.cs) only
// parse correctly on bytes. Decoding: TextDecoder("utf-8").
//
// A `ba` count is taken on the CRLF file (metaf AEmbedNav.ExportToMet sums
// `line.Length + 2`, ACreateView "2 chars for a newline") and a git LF copy
// keeps it, so in a bare-LF file every bare LF counts 2, read and written
// (Reader.baEnd / crlfLength). An LF file whose counts are plain byte lengths
// (holtburger's LF export before it counted CRLF) loads through a raw-count
// retry. CRLF files only ever take the byte-count path.
//
// Fixed RynthAi bugs (U5 §9): ChatCapture is CType 28 (B1); CallState is
// TABLE{st,ret} (B2); an EMPTY embedded nav is kept as navText "" (B3); no
// start state is chosen here (META starts every load in Default, B4).
//
// Byte stability ("keep originals"): writeMet emits VTank's canonical
// encoding for every keyword (metaf's ExportToMet forms; all 17 corpus files
// are canonical). A leaf whose bytes were NOT canonical (another key order, a
// "d" where VTank writes "i", "5.0", an unknown CType/AType …) keeps its
// original bytes in a `_met` hint ({ type?, data: binary string }) on the
// Cond/Act node. writeMet re-emits those bytes only while decoding them still
// yields the node's current fields (an edited node is written canonically),
// so the hint can never resurrect stale data. File-level facts live in
// `meta.source` (`bom: true`; `eol: "\n"` for a bare-LF file). JSON-safe.
//
// Disabled rules (`enabled:false`, a web/RynthAi extension) have no `.met`
// representation: writeMet omits them.

import {
  condByMet,
  actByMet,
  condByKw,
  actByKw,
  newRuleId,
  navTextInfo,
  navTagFor,
  emptyNavText,
  followNavText,
  findNav,
  sameNode,
  orderFields,
} from "./meta_schema.js";

const dec = new TextDecoder("utf-8");
const enc = new TextEncoder();
const MAX_DEPTH = 64;

class MetError extends Error {
  constructor(msg, pos) {
    super(`${msg} (byte ${pos})`);
    this.pos = pos;
  }
}

// ── generic byte reader ────────────────────────────────────────────────────
class Reader {
  constructor(bytes, start = 0, end = bytes.length) {
    this.b = bytes;
    this.p = start;
    this.end = end;
    this.crlf = 0;
    this.lf = 0;
    // true for a bare-LF file: `ba` counts are VTank's CRLF character counts.
    this.crlfCounts = false;
  }
  line() {
    if (this.p >= this.end) throw new MetError("unexpected end of file", this.p);
    const b = this.b;
    const s = this.p;
    let i = s;
    while (i < this.end && b[i] !== 10) i++;
    let e = i;
    if (i < this.end) {
      i++;
      if (e > s && b[e - 1] === 13) {
        e--;
        this.crlf++;
      } else this.lf++;
    }
    this.p = i;
    return dec.decode(b.subarray(s, e));
  }
  int(what) {
    const at = this.p;
    const t = this.line().trim();
    if (!/^[-+]?\d+$/.test(t)) throw new MetError(`expected an integer ${what}, found ${JSON.stringify(t.slice(0, 40))}`, at);
    return parseInt(t, 10);
  }
  value(depth) {
    // value(level + 1) reads a Cond/Act at nesting `level`; levels up to
    // MAX_DEPTH + 1 (writeMet's inert placeholders under a level-MAX_DEPTH
    // compound) are readable.
    if (depth > MAX_DEPTH + 2) throw new MetError(`tables nested deeper than ${MAX_DEPTH}`, this.p);
    const start = this.p;
    const tag = this.line().trim();
    let v;
    switch (tag) {
      case "n":
        v = { k: "n" };
        break;
      case "i": {
        const at = this.p;
        const raw = this.line();
        if (!/^\s*[-+]?\d+\s*$/.test(raw)) throw new MetError(`bad integer ${JSON.stringify(raw.slice(0, 40))}`, at);
        v = { k: "i", raw, n: parseInt(raw, 10) };
        break;
      }
      case "d": {
        const at = this.p;
        const raw = this.line();
        const n = Number(raw.trim());
        if (!raw.trim() || !Number.isFinite(n)) throw new MetError(`bad double ${JSON.stringify(raw.slice(0, 40))}`, at);
        v = { k: "d", raw, n };
        break;
      }
      case "s":
        v = { k: "s", v: this.line() };
        break;
      case "ba": {
        const n = this.int("byte count");
        const e = this.baEnd(n);
        v = { k: "ba", bytes: this.b.subarray(this.p, e) };
        this.p = e;
        break;
      }
      case "TABLE":
        v = this.table(depth + 1);
        break;
      default:
        throw new MetError(`unknown value type ${JSON.stringify(tag.slice(0, 20))}`, start);
    }
    v.start = start;
    v.end = this.p;
    return v;
  }
  // End (exclusive) of a `ba` of count `n` starting at this.p. With
  // crlfCounts each bare LF counts as the CRLF VTank counted (inverse of
  // crlfLength); a count that lands between the two halves of that CRLF
  // cannot come from a CRLF file and is an error.
  baEnd(n) {
    if (!this.crlfCounts) {
      if (n < 0 || this.p + n > this.end) throw new MetError(`byte array of ${n} bytes runs past the end of the file`, this.p);
      return this.p + n;
    }
    if (n < 0) throw new MetError(`byte array of ${n} characters runs past the end of the file`, this.p);
    const b = this.b;
    const s = this.p;
    let i = s;
    let c = 0;
    while (c < n) {
      if (i >= this.end) throw new MetError(`byte array of ${n} characters runs past the end of the file`, s);
      c += b[i] === 10 && (i === s || b[i - 1] !== 13) ? 2 : 1;
      i++;
    }
    if (c !== n) throw new MetError(`byte array of ${n} characters ends inside a line break`, s);
    return i;
  }
  table(depth) {
    const nc = this.int("column count");
    if (nc < 0 || nc > 64) throw new MetError(`bad column count ${nc}`, this.p);
    const cols = [];
    for (let i = 0; i < nc; i++) cols.push(this.line());
    const types = [];
    for (let i = 0; i < nc; i++) types.push(this.line());
    const nr = this.int("row count");
    // Every value takes at least one byte, and VTank never writes a row of
    // zero values: a count the rest of the file cannot hold is corrupt (it
    // would loop and allocate without bound).
    if (nr < 0 || (nr > 0 && (nc === 0 || nr * nc > this.end - this.p))) throw new MetError(`bad row count ${nr}`, this.p);
    const rows = [];
    for (let r = 0; r < nr; r++) {
      const row = [];
      for (let c = 0; c < nc; c++) row.push(this.value(depth));
      rows.push(row);
    }
    return { k: "TABLE", cols, types, rows };
  }
}

// ── binary-string hints (JSON-safe exact bytes) ────────────────────────────
function toBin(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 4096) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 4096));
  return s;
}
function fromBin(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}
function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ── value accessors (lenient; VTank/metaf types first) ─────────────────────
function numOf(v) {
  if (!v) return NaN;
  if (v.k === "i" || v.k === "d") return v.n;
  if (v.k === "s" && v.v.trim() && Number.isFinite(Number(v.v.trim()))) return Number(v.v.trim());
  return NaN;
}
function strOf(v) {
  if (!v) return "";
  if (v.k === "s") return v.v;
  if (v.k === "i" || v.k === "d") return v.raw.trim();
  if (v.k === "ba") return dec.decode(v.bytes);
  return "";
}
function isKv(v) {
  return v && v.k === "TABLE" && v.cols.length === 2;
}
/** A keyed TABLE{k,v} → Map(key → value); keys are the row's first cell as text. */
function kvMap(v) {
  const m = new Map();
  if (!isKv(v)) return m;
  for (const row of v.rows) {
    const key = strOf(row[0]);
    if (!m.has(key)) m.set(key, row[1]);
  }
  return m;
}
function kvGet(m, key) {
  if (m.has(key)) return m.get(key);
  const low = key.toLowerCase();
  for (const [k, val] of m) if (k.toLowerCase() === low) return val;
  return undefined;
}

// ── per-keyword .met encodings (canonical = metaf ExportToMet) ─────────────
// zero: `i 0` · s/i: one scalar · kv: TABLE{k,v} with [key, valueType, field]
const ZERO = { kind: "zero" };
const MANY = { kind: "compound" };
const COND_MET = {
  Never: ZERO,
  Always: ZERO,
  All: MANY,
  Any: MANY,
  ChatMatch: { kind: "s", field: "re" },
  MainSlotsLE: { kind: "i", field: "n" },
  SecsInStateGE: { kind: "i", field: "secs" },
  NavEmpty: ZERO,
  Death: ZERO,
  VendorOpen: ZERO,
  VendorClosed: ZERO,
  ItemCountLE: { kind: "kv", keys: [["n", "s", "name"], ["c", "i", "count"]] },
  ItemCountGE: { kind: "kv", keys: [["n", "s", "name"], ["c", "i", "count"]] },
  MobsInDist_Name: { kind: "kv", keys: [["n", "s", "re"], ["c", "i", "count"], ["r", "d", "dist"]] },
  MobsInDist_Priority: { kind: "kv", keys: [["p", "i", "priority"], ["c", "i", "count"], ["r", "d", "dist"]] },
  NeedToBuff: ZERO,
  NoMobsInDist: { kind: "kv", keys: [["r", "d", "dist"]] },
  BlockE: { kind: "i", field: "value", u32: true },
  CellE: { kind: "i", field: "value", u32: true },
  IntoPortal: ZERO,
  ExitPortal: ZERO,
  Not: MANY,
  PSecsInStateGE: { kind: "i", field: "secs" },
  SecsOnSpellGE: { kind: "kv", keys: [["sid", "i", "spellId"], ["sec", "i", "secs"]] },
  BuPercentGE: { kind: "i", field: "pct" },
  DistToRteGE: { kind: "kv", keys: [["dist", "d", "dist"]] },
  Expr: { kind: "kv", keys: [["e", "s", "expr"]] },
  ChatCapture: { kind: "kv", keys: [["p", "s", "re"], ["c", "s", "colors"]] },
};
const ACT_MET = {
  None: ZERO,
  SetState: { kind: "s", field: "state" },
  Chat: { kind: "s", field: "text" },
  DoAll: MANY,
  EmbedNav: { kind: "embednav" },
  CallState: { kind: "kv", keys: [["st", "s", "state"], ["ret", "s", "ret"]] },
  Return: ZERO,
  DoExpr: { kind: "kv", keys: [["e", "s", "expr"]] },
  ChatExpr: { kind: "kv", keys: [["e", "s", "expr"]] },
  SetWatchdog: { kind: "kv", keys: [["s", "s", "state"], ["r", "d", "dist"], ["t", "d", "secs"]] },
  ClearWatchdog: { kind: "kv", keys: [] },
  GetOpt: { kind: "kv", keys: [["o", "s", "opt"], ["v", "s", "var"]] },
  SetOpt: { kind: "kv", keys: [["o", "s", "opt"], ["v", "s", "expr"]] },
  CreateView: { kind: "kv", keys: [["n", "s", "view"], ["x", "ba", "xml"]] },
  DestroyView: { kind: "kv", keys: [["n", "s", "view"]] },
  DestroyAllViews: { kind: "kv", keys: [] },
};

function intField(n) {
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

// Decode one leaf's data value into `node` fields per spec. Lenient: a scalar
// where a one-key TABLE is expected (Appendix B "assumed" shapes) is accepted.
function decodeFields(node, spec, v, warn) {
  switch (spec.kind) {
    case "zero":
      return;
    case "s":
      node[spec.field] = strOf(v);
      return;
    case "i": {
      const n = numOf(v);
      if (!Number.isFinite(n)) warn(`${node.t}: expected a number, found ${v.k}`);
      node[spec.field] = spec.u32 ? intField(n) >>> 0 : intField(n);
      return;
    }
    case "kv": {
      if (!isKv(v)) {
        if (spec.keys.length === 1 && v.k !== "TABLE") {
          const [, type, field] = spec.keys[0];
          node[field] = type === "s" || type === "ba" ? strOf(v) : type === "i" ? intField(numOf(v)) : finiteOr0(numOf(v));
        } else if (spec.keys.length) {
          warn(`${node.t}: expected a keyed table, found ${v.k}`);
          for (const [, type, field] of spec.keys) node[field] = type === "s" || type === "ba" ? "" : 0;
        }
        return;
      }
      const m = kvMap(v);
      for (const [key, type, field] of spec.keys) {
        const val = kvGet(m, key);
        if (val === undefined) {
          warn(`${node.t}: missing key "${key}"`);
          node[field] = type === "s" || type === "ba" ? "" : 0;
        } else if (type === "s" || type === "ba") node[field] = strOf(val);
        else if (type === "i") node[field] = intField(numOf(val));
        else node[field] = finiteOr0(numOf(val));
      }
      return;
    }
    default:
  }
}
function finiteOr0(n) {
  return Number.isFinite(n) ? n : 0;
}

// ── decode (generic value tree → Meta model) ───────────────────────────────
class DecodeCtx {
  constructor(bytes, eol, { scratch = false } = {}) {
    this.bytes = bytes;
    this.eol = eol;
    this.scratch = scratch;
    this.warnings = [];
    this.navs = {};
    this.usedTags = new Set();
    this.routeCounter = { n: 0 };
  }
  warn(msg) {
    if (!this.scratch) this.warnings.push(msg);
  }
  raw(v) {
    return this.bytes.subarray(v.start, v.end);
  }
}

function decodeCond(type, v, ctx, depth, where) {
  const row = condByMet(type);
  if (!row) {
    ctx.warn(`${where}: unknown condition type ${type} — loaded as Never`);
    return { t: "Never", unknownKeyword: `CType ${type}`, _met: { type, data: toBin(ctx.raw(v)) } };
  }
  const node = { t: row.kw };
  const spec = COND_MET[row.kw];
  if (spec.kind === "compound") {
    node.children = [];
    if (!v || v.k !== "TABLE") ctx.warn(`${where}: ${row.kw} data is not a table`);
    else {
      if (depth > MAX_DEPTH) throw new MetError(`conditions nested deeper than ${MAX_DEPTH}`, v.start);
      for (const r of v.rows) node.children.push(decodeCond(numOf(r[0]), r[1], ctx, depth + 1, `${where} > ${row.kw}`));
      if (row.kw === "Not" && node.children.length !== 1) ctx.warn(`${where}: Not has ${node.children.length} children (VTank uses the first)`);
    }
  } else {
    decodeFields(node, spec, v, (m) => ctx.warn(`${where}: ${m}`));
  }
  const out = orderFields(node, "cond");
  hintIfNonCanonical(out, type, v, ctx, (n, e) => encodeCond(n, e, null));
  return out;
}

function decodeAct(type, v, ctx, depth, where) {
  const row = actByMet(type);
  if (!row) {
    ctx.warn(`${where}: unknown action type ${type} — loaded as None`);
    return { t: "None", unknownKeyword: `AType ${type}`, _met: { type, data: toBin(ctx.raw(v)) } };
  }
  const node = { t: row.kw };
  const spec = ACT_MET[row.kw];
  if (spec.kind === "compound") {
    node.children = [];
    if (!v || v.k !== "TABLE") ctx.warn(`${where}: DoAll data is not a table`);
    else {
      if (depth > MAX_DEPTH) throw new MetError(`actions nested deeper than ${MAX_DEPTH}`, v.start);
      for (const r of v.rows) node.children.push(decodeAct(numOf(r[0]), r[1], ctx, depth + 1, `${where} > DoAll`));
    }
  } else if (spec.kind === "embednav") {
    const nav = decodeEmbedNav(node, v, ctx, where);
    if (!ctx.scratch) {
      node.tag = navTagFor(node.displayName, ctx.usedTags, ctx.routeCounter);
      ctx.navs[node.tag] = nav;
    } else node._nav = nav; // verification only
  } else {
    decodeFields(node, spec, v, (m) => ctx.warn(`${where}: ${m}`));
  }
  const out = orderFields(node, "act");
  const navs = ctx.scratch ? null : ctx.navs;
  hintIfNonCanonical(out, type, v, ctx, (n, e) => encodeAct(n, e, navs));
  return out;
}

// EmbedNav AData: ba = displayName EOL pointCount EOL <uTank2 NAV text>.
function decodeEmbedNav(node, v, ctx, where) {
  node.displayName = "";
  if (!v || v.k !== "ba") {
    ctx.warn(`${where}: EmbedNav data is not a byte array — empty route`);
    return { displayName: "", routeType: 1, navText: "" };
  }
  const text = dec.decode(v.bytes);
  const l1 = lineAt(text, 0);
  const l2 = lineAt(text, l1.next);
  node.displayName = l1.line;
  const rest = text.slice(l2.next);
  const info = navTextInfo(rest);
  if (!info.ok) ctx.warn(`${where}: embedded nav "${node.displayName}" is not uTank2 NAV text`);
  const nav = { displayName: node.displayName, routeType: [1, 2, 3, 4].includes(info.routeType) ? info.routeType : 1, navText: "" };
  if (info.follow) {
    nav.navText = rest;
    nav.followTarget = { name: info.follow.name, guid: info.follow.guid };
  } else if (!info.empty) nav.navText = rest;
  return nav;
}
function lineAt(text, from) {
  const i = text.indexOf("\n", from);
  if (i < 0) return { line: text.slice(from).replace(/\r$/, ""), next: text.length };
  return { line: text.slice(from, i).replace(/\r$/, ""), next: i + 1 };
}

// Attach a `_met` hint when the canonical encoding of the decoded node is
// not byte-identical to what the file holds.
function hintIfNonCanonical(node, type, v, ctx, encode) {
  if (ctx.scratch) return;
  const orig = ctx.raw(v);
  let canon = null;
  try {
    canon = joinChunks(encode(node, ctx.eol));
  } catch {
    canon = null;
  }
  if (!canon || !bytesEqual(canon, orig)) node._met = { type, data: toBin(orig) };
}

// ── encode (Meta model → bytes) ────────────────────────────────────────────
function str(s) {
  return String(s ?? "").replace(/\r\n|\r|\n/g, " ");
}
function fmtNum(n) {
  return String(Number.isFinite(n) ? n : 0);
}
// VTank (and metaf) read every "i" value with Int32.Parse: an out-of-range
// integer would make the file unloadable (and "1e+21" unreadable here too).
function int32(v) {
  const n = Math.trunc(Number(v) || 0);
  return n > 2147483647 ? 2147483647 : n < -2147483648 ? -2147483648 : n;
}
function line(chunks, text, eol) {
  chunks.push(enc.encode(text + eol));
}
// The `ba` count VTank expects for `b` in a bare-LF file: its length once each
// bare LF is the CRLF VTank wrote (see Reader.baEnd).
function crlfLength(b) {
  let n = b.length;
  for (let i = 0; i < b.length; i++) if (b[i] === 10 && (i === 0 || b[i - 1] !== 13)) n++;
  return n;
}
function encScalar(chunks, type, value, eol) {
  switch (type) {
    case "s":
      line(chunks, "s", eol);
      line(chunks, str(value), eol);
      return;
    case "i":
      line(chunks, "i", eol);
      line(chunks, String(int32(value)), eol);
      return;
    case "d":
      line(chunks, "d", eol);
      line(chunks, fmtNum(Number(value)), eol);
      return;
    case "ba": {
      const b = enc.encode(String(value ?? ""));
      line(chunks, "ba", eol);
      line(chunks, String(eol === "\n" ? crlfLength(b) : b.length), eol);
      chunks.push(b);
      return;
    }
    default:
      line(chunks, "n", eol);
  }
}
function tableHead(chunks, cols, nrows, eol) {
  line(chunks, "TABLE", eol);
  tableBodyHead(chunks, cols, nrows, eol);
}
// The column/row header of a table (the root CondAct table has no "TABLE" tag).
function tableBodyHead(chunks, cols, nrows, eol) {
  line(chunks, String(cols.length), eol);
  for (const c of cols) line(chunks, c, eol);
  for (let i = 0; i < cols.length; i++) line(chunks, "n", eol);
  line(chunks, String(nrows), eol);
}
function encodeFields(node, spec, eol, chunks) {
  switch (spec.kind) {
    case "zero":
      line(chunks, "i", eol);
      line(chunks, "0", eol);
      return;
    case "s":
      encScalar(chunks, "s", node[spec.field], eol);
      return;
    case "i":
      line(chunks, "i", eol);
      line(chunks, String(spec.u32 ? (Number(node[spec.field]) || 0) | 0 : int32(node[spec.field])), eol);
      return;
    case "kv":
      tableHead(chunks, ["k", "v"], spec.keys.length, eol);
      for (const [key, type, field] of spec.keys) {
        encScalar(chunks, "s", key, eol);
        encScalar(chunks, type, node[field], eol);
      }
      return;
    default:
  }
}

// Re-emit a `_met` hint when it still decodes to this node's semantics. In a
// bare-LF meta the hint is read with CRLF `ba` counts only, so a byte-count
// hint from an older LF export is re-encoded with VTank's counts.
function hinted(node, isCond, navs, eol) {
  const h = node && node._met;
  if (!h || typeof h.data !== "string") return null;
  const metType = Number.isInteger(h.type) ? h.type : isCond ? condByKw(node.t)?.met : actByKw(node.t)?.met;
  if (!Number.isInteger(metType)) return null;
  const bytes = fromBin(h.data);
  if (node.unknownKeyword !== undefined) {
    // Unknown types carry their data only; keep it while the node stays inert.
    return (isCond ? node.t === "Never" : node.t === "None") ? { type: metType, bytes } : null;
  }
  try {
    const r = new Reader(bytes);
    r.crlfCounts = eol === "\n";
    const v = r.value(0);
    if (r.p !== bytes.length) return null;
    const ctx = new DecodeCtx(bytes, "\r\n", { scratch: true });
    const back = isCond ? decodeCond(metType, v, ctx, 0, "") : decodeAct(metType, v, ctx, 0, "");
    const same = isCond ? sameNode(back, node) : sameActTree(back, node, navs);
    return same ? { type: metType, bytes } : null;
  } catch {
    return null;
  }
}

// Action-tree equality for hint verification: an EmbedNav (at any DoAll
// depth) is unchanged when its display name and its route content are.
function sameActTree(back, node, navs) {
  if (!back || !node || back.t !== node.t) return false;
  if (node.t === "EmbedNav") {
    const nav = findNav(navs, String(node.tag ?? ""));
    const want = back._nav;
    if (!nav || !want || back.displayName !== node.displayName) return false;
    return (
      (nav.routeType || 1) === want.routeType &&
      String(nav.navText ?? "") === want.navText &&
      sameNode(nav.followTarget || null, want.followTarget || null)
    );
  }
  const shallow = (n) => {
    const o = { ...n };
    delete o.children;
    return o;
  };
  if (!sameNode(shallow(back), shallow(node))) return false;
  const a = Array.isArray(back.children) ? back.children : [];
  const b = Array.isArray(node.children) ? node.children : [];
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!sameActTree(a[i], b[i], navs)) return false;
  return true;
}

// A child deeper than MAX_DEPTH (validateMeta's limit) is written inert —
// type 0 (Never / None), `i 0` — like writeAf: a pathological or cyclic tree
// never overflows the stack and the output stays readable by parseMet.
function inertChild(out, eol) {
  line(out, "i", eol);
  line(out, "0", eol);
  encodeFields({}, ZERO, eol, out);
}

function encodeCond(node, eol, chunks, depth = 0) {
  const out = chunks || [];
  const row = condByKw(node && node.t);
  const spec = row ? COND_MET[row.kw] : ZERO;
  if (spec.kind === "compound") {
    const kids = Array.isArray(node.children) ? node.children : [];
    tableHead(out, ["K", "V"], kids.length, eol);
    for (const ch of kids) {
      if (depth + 1 > MAX_DEPTH) {
        inertChild(out, eol);
        continue;
      }
      const t = condTypeOf(ch, eol);
      line(out, "i", eol);
      line(out, String(t.type), eol);
      if (t.bytes) out.push(t.bytes);
      else encodeCond(ch, eol, out, depth + 1);
    }
  } else encodeFields(node || {}, spec, eol, out);
  return out;
}

function encodeAct(node, eol, navs, chunks, depth = 0) {
  const out = chunks || [];
  const row = actByKw(node && node.t);
  const spec = row ? ACT_MET[row.kw] : ZERO;
  if (spec.kind === "compound") {
    const kids = Array.isArray(node.children) ? node.children : [];
    tableHead(out, ["K", "V"], kids.length, eol);
    for (const ch of kids) {
      if (depth + 1 > MAX_DEPTH) {
        inertChild(out, eol);
        continue;
      }
      const t = actTypeOf(ch, navs, eol);
      line(out, "i", eol);
      line(out, String(t.type), eol);
      if (t.bytes) out.push(t.bytes);
      else encodeAct(ch, eol, navs, out, depth + 1);
    }
  } else if (spec.kind === "embednav") encodeEmbedNav(node, eol, navs, out);
  else encodeFields(node || {}, spec, eol, out);
  return out;
}

// EmbedNav: ba = displayName, point count, nav text (CRLF; empty ⇒ the
// header-only route VTank embeds for "[None]").
function encodeEmbedNav(node, eol, navs, out) {
  const nav = navs ? findNav(navs, String(node.tag ?? "")) : node._nav || null;
  const display = str(node.displayName ?? (nav && nav.displayName) ?? "");
  const routeType = nav && [1, 2, 3, 4].includes(nav.routeType) ? nav.routeType : 1;
  let navText = nav && typeof nav.navText === "string" ? nav.navText : "";
  const ft = nav && nav.followTarget && typeof nav.followTarget === "object" ? nav.followTarget : null;
  if (!navText.trim() && (routeType === 3 || ft) && ft) navText = followNavText(ft, eol);
  let count = 0;
  if (!navText.trim()) navText = emptyNavText(routeType, eol);
  else {
    navText = navText.replace(/\r\n|\r|\n/g, eol);
    if (!navText.endsWith(eol)) navText += eol;
    const info = navTextInfo(navText);
    count = info.follow ? 1 : info.pointCount;
  }
  encScalar(out, "ba", `${display}${eol}${count}${eol}${navText}`, eol);
}

function condTypeOf(node, eol) {
  const h = hinted(node, true, null, eol);
  if (h) return h;
  const row = condByKw(node && node.t);
  return { type: row ? row.met : 0, bytes: null };
}
function actTypeOf(node, navs, eol) {
  const h = hinted(node, false, navs, eol);
  if (h) return h;
  const row = actByKw(node && node.t);
  return { type: row ? row.met : 0, bytes: null };
}

function joinChunks(chunks) {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

const ROOT_COLS = ["CType", "AType", "CData", "AData", "State"];

function baseName(fileName) {
  const f = String(fileName ?? "")
    .split(/[\\/]/)
    .pop();
  return f.replace(/\.(met|af|json)$/i, "");
}

/**
 * Parse a VTank `.met` file.
 * → { ok: true, meta: Meta, warnings } | { ok: false, warnings, error }
 * Rules keep file order; ids are "r1".."rN"; every rule is enabled.
 */
export function parseMet(bytes, opts = {}) {
  const fileName = opts && typeof opts === "object" ? opts.fileName : undefined;
  const warnings = [];
  let b = bytes;
  if (typeof b === "string") b = enc.encode(b);
  else if (b instanceof ArrayBuffer) b = new Uint8Array(b);
  else if (b && !(b instanceof Uint8Array) && ArrayBuffer.isView(b)) b = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  if (!(b instanceof Uint8Array)) return { ok: false, warnings, error: ".met data must be a Uint8Array" };
  const bom = b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
  const body = bom ? b.subarray(3) : b;
  if (!body.length) return { ok: false, warnings, error: "empty .met file" };
  // A bare-LF file is read with VTank's CRLF `ba` counts, then once more with
  // plain byte counts (an LF file holtburger wrote before it counted CRLF).
  const lfFile = bareLfHeader(body);
  const res = parseBody(body, bom, fileName, lfFile, false);
  if (res.ok || !lfFile) return res;
  const raw = parseBody(body, bom, fileName, false, true);
  return raw.ok ? raw : res;
}

// The "1" header line ends in a bare LF (a git LF copy or an LF export).
function bareLfHeader(body) {
  const i = body.indexOf(10);
  return i > 0 && body[i - 1] !== 13;
}

// parseMet on the BOM-less body; `crlfCounts` reads `ba` counts as CRLF
// character counts, `byteCounts` marks the raw-count retry of an LF file.
function parseBody(body, bom, fileName, crlfCounts, byteCounts) {
  const warnings = [];
  try {
    const r = new Reader(body);
    r.crlfCounts = crlfCounts;
    const ver = r.line().trim();
    const name = r.line().trim();
    if (ver !== "1" || name !== "CondAct") return { ok: false, warnings, error: "not a VTank .met file (expected \"1\" / \"CondAct\" header)" };
    const t = r.table(1);
    if (t.cols.length !== 5) return { ok: false, warnings, error: `the CondAct table has ${t.cols.length} columns (expected 5)` };
    if (t.cols.join(",") !== ROOT_COLS.join(",")) warnings.push(`unexpected CondAct column names ${t.cols.join(",")}`);
    if (r.p < body.length) warnings.push(`${body.length - r.p} trailing byte(s) after the CondAct table ignored`);
    const eol = r.lf > 0 && r.crlf === 0 ? "\n" : "\r\n";
    if (byteCounts) warnings.push(`"ba" lengths are LF byte counts, not VTank's CRLF character counts (an older LF export)${eol === "\n" ? "; saving writes VTank's counts" : ""}`);
    const ctx = new DecodeCtx(body, eol);
    const rules = [];
    const ids = new Set();
    t.rows.forEach((row, i) => {
      const where = `row ${i + 1}`;
      const ctype = numOf(row[0]);
      const atype = numOf(row[1]);
      if (!Number.isInteger(ctype) || !Number.isInteger(atype)) throw new MetError(`${where}: CType/AType are not integers`, row[0].start);
      const cond = decodeCond(ctype, row[2], ctx, 0, where);
      const act = decodeAct(atype, row[3], ctx, 0, where);
      if (row[4].k !== "s") ctx.warn(`${where}: State is not a string`);
      const id = newRuleId(ids);
      ids.add(id);
      rules.push({ id, state: strOf(row[4]), enabled: true, cond, act });
    });
    warnings.push(...ctx.warnings);
    const source = { kind: "met" };
    if (fileName) source.fileName = String(fileName);
    if (bom) source.bom = true;
    if (eol !== "\r\n") source.eol = eol;
    const meta = { v: 1, name: baseName(fileName), source, rules, navs: ctx.navs, warnings: warnings.slice() };
    return { ok: true, meta, warnings };
  } catch (e) {
    return { ok: false, warnings, error: e instanceof MetError ? e.message : `.met parse failed: ${e && e.message ? e.message : e}` };
  }
}

/**
 * Serialise a Meta to VTank `.met` bytes (CRLF; BOM when `meta.source.bom`).
 * Disabled rules are omitted (VTank has no enabled flag). Byte-stable for a
 * meta read by parseMet and not edited since.
 */
export function writeMet(meta) {
  const m = meta && typeof meta === "object" ? meta : {};
  const src = m.source && typeof m.source === "object" ? m.source : {};
  const eol = src.eol === "\n" ? "\n" : "\r\n";
  const navs = m.navs && typeof m.navs === "object" ? m.navs : {};
  const rules = (Array.isArray(m.rules) ? m.rules : []).filter((r) => r && typeof r === "object" && r.enabled !== false);
  const out = [];
  if (src.bom === true) out.push(new Uint8Array([0xef, 0xbb, 0xbf]));
  line(out, "1", eol);
  line(out, "CondAct", eol);
  tableBodyHead(out, ROOT_COLS, rules.length, eol);
  for (const r of rules) {
    const c = condTypeOf(r.cond || { t: "Never" }, eol);
    const a = actTypeOf(r.act || { t: "None" }, navs, eol);
    line(out, "i", eol);
    line(out, String(c.type), eol);
    line(out, "i", eol);
    line(out, String(a.type), eol);
    if (c.bytes) out.push(c.bytes);
    else encodeCond(r.cond || { t: "Never" }, eol, out);
    if (a.bytes) out.push(a.bytes);
    else encodeAct(r.act || { t: "None" }, eol, navs, out);
    encScalar(out, "s", r.state, eol);
  }
  return joinChunks(out);
}

export default { parseMet, writeMet };
