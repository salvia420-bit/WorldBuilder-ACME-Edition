// rynth/vt/expr/parser.js — recursive-descent parser for the VTank/UB
// expression language (PLAN §3.4, normative; D14 whitespace, D37 precedence).
//
// Precedence, low → high (all left-associative except `=`):
//   ;   (sequence; value = last statement; empty statements allowed)
//   =   (UB assignment, only directly after `$name`, right-assoc, returns the value)
//   ||   &&   |   ^   &   (bitwise)
//   == != < <= > >=      (ONE level: `1<2==1` is `(1<2)==1`)
//   #                    (regex match; subject # pattern)
//   << >>
//   + -                  (D37: one level)
//   * / %                (D37: one level)
//   unary - ~ !
//   postfix: name[args] call, x{key} / x{a:b} index (UB `$d{key}`, `list{0}`, `str{10:}`)
//   primary: number, text, backtick string, $name, ( … )
//
// A parse error is reported, never silently truncated (C# B15). In meta mode
// a bare word is a literal String; in monster mode it is looked up through
// resolveIdent at evaluation time (G:119) — both produce a "word" node so the
// `refs` set is uniform. A text token that trims to a decimal / 0x number is a
// Number in both modes.

import { lex } from "./lexer.js";

const NUM_RE = /^-?(?:\d+(?:\.\d*)?|\.\d+)$/;
const HEX_RE = /^(-?)0x([0-9a-f]+)$/i;
const CMP_OPS = new Set(["==", "!=", "<", "<=", ">", ">="]);
const TERMINATORS = new Set([";", ")", "]", "}", ",", ":"]);
const MAX_NEST = 256;
const DYNAMIC_WORDS = new Set(["range", "hasshield", "metastate"]);

function numberOf(t) {
  if (NUM_RE.test(t)) return Number(t);
  const h = HEX_RE.exec(t);
  if (h) {
    const v = parseInt(h[2], 16);
    return h[1] === "-" ? -v : v;
  }
  return null;
}

class ParseError extends Error {
  constructor(msg, pos) {
    super(msg);
    this.pos = pos;
  }
}

class Parser {
  constructor(src, tokens) {
    this.src = src;
    this.toks = tokens;
    this.p = 0;
    this.nest = 0;
    this.refs = new Set();
    this.hasCall = false;
    this.hasVar = false;
  }

  peek(o = 0) {
    return this.toks[this.p + o] || null;
  }
  isOp(v, o = 0) {
    const t = this.peek(o);
    return !!t && t.type === "op" && t.v === v;
  }
  posOf(t) {
    return t ? t.s : this.src.length;
  }
  fail(msg, t = this.peek()) {
    throw new ParseError(msg, this.posOf(t));
  }
  describe(t) {
    if (!t) return "end of expression";
    if (t.type === "op") return `'${t.v}'`;
    if (t.type === "bt") return "a backtick string";
    return `'${t.trim}'`;
  }
  enter(t) {
    if (++this.nest > MAX_NEST) this.fail(`brackets nested deeper than ${MAX_NEST}`, t);
  }
  leave() {
    this.nest--;
  }
  expectOp(v, what) {
    if (!this.isOp(v)) this.fail(`expected '${v}' ${what}, found ${this.describe(this.peek())}`);
    return this.toks[this.p++];
  }
  atTerminator() {
    const t = this.peek();
    return !t || (t.type === "op" && TERMINATORS.has(t.v));
  }

  // ;  — returns null for an empty sequence (caller decides if that is legal)
  parseSeq() {
    const items = [];
    if (!this.atTerminator()) items.push(this.parseAssign());
    while (this.isOp(";")) {
      this.p++;
      if (!this.atTerminator()) items.push(this.parseAssign());
    }
    if (items.length === 0) return null;
    if (items.length === 1) return items[0];
    return { k: "seq", items };
  }

  // =  (right-assoc, only after $name; the primary handles `$name =` too so
  // `a && $x=5` parses as `a && ($x=5)`)
  parseAssign() {
    return this.parseOr();
  }

  parseOr() {
    let a = this.parseAnd();
    while (this.isOp("||")) {
      this.p++;
      const b = this.operand(() => this.parseAnd(), "||");
      a = { k: "or", a, b };
    }
    return a;
  }
  parseAnd() {
    let a = this.parseBitOr();
    while (this.isOp("&&")) {
      this.p++;
      const b = this.operand(() => this.parseBitOr(), "&&");
      a = { k: "and", a, b };
    }
    return a;
  }
  parseBitOr() {
    return this.binaryLevel(["|"], () => this.parseBitXor());
  }
  parseBitXor() {
    return this.binaryLevel(["^"], () => this.parseBitAnd());
  }
  parseBitAnd() {
    return this.binaryLevel(["&"], () => this.parseCmp());
  }
  parseCmp() {
    let a = this.parseRegex();
    for (;;) {
      const t = this.peek();
      if (!t || t.type !== "op" || !CMP_OPS.has(t.v)) return a;
      this.p++;
      const b = this.operand(() => this.parseRegex(), t.v);
      a = { k: "bin", op: t.v, a, b };
    }
  }
  parseRegex() {
    return this.binaryLevel(["#"], () => this.parseShift());
  }
  parseShift() {
    return this.binaryLevel(["<<", ">>"], () => this.parseAdd());
  }
  parseAdd() {
    return this.binaryLevel(["+", "-"], () => this.parseMul());
  }
  parseMul() {
    return this.binaryLevel(["*", "/", "%"], () => this.parseUnary());
  }
  binaryLevel(ops, next) {
    let a = next();
    for (;;) {
      const t = this.peek();
      if (!t || t.type !== "op" || !ops.includes(t.v)) return a;
      this.p++;
      const b = this.operand(next, t.v);
      a = { k: "bin", op: t.v, a, b };
    }
  }
  // The right operand of a binary operator must exist (dangling operator ⇒ error).
  operand(fn, op) {
    if (this.atTerminator()) this.fail(`operator '${op}' is missing its right operand`);
    return fn();
  }

  parseUnary() {
    const t = this.peek();
    if (t && t.type === "op" && (t.v === "-" || t.v === "~" || t.v === "!")) {
      this.p++;
      if (this.atTerminator()) this.fail(`unary '${t.v}' is missing its operand`);
      return { k: "un", op: t.v, x: this.parseUnary() };
    }
    return this.parsePostfix();
  }

  parsePostfix() {
    let x = this.parsePrimary();
    while (this.isOp("{")) {
      const open = this.toks[this.p++];
      this.enter(open);
      let a = null;
      let b = null;
      let slice = false;
      if (!this.isOp(":")) a = this.parseSeq();
      if (this.isOp(":")) {
        this.p++;
        slice = true;
        if (!this.isOp("}")) b = this.parseSeq();
      }
      if (!slice && !a) this.fail("empty index '{}'", open);
      this.expectOp("}", "to close the index");
      this.leave();
      x = { k: "index", x, key: a, slice, a, b };
    }
    return x;
  }

  parsePrimary() {
    const t = this.peek();
    if (!t) this.fail("expected an operand, found end of expression");
    if (t.type === "bt") {
      this.p++;
      return { k: "str", v: t.v };
    }
    if (t.type === "text") {
      this.p++;
      if (this.isOp("[")) return this.parseCall(t);
      const n = numberOf(t.trim);
      if (n !== null) return { k: "num", v: n };
      const lower = t.trim.toLowerCase();
      this.refs.add(lower);
      return { k: "word", v: t.text, name: t.trim, lower };
    }
    // operators
    if (t.v === "$") {
      this.p++;
      const nt = this.peek();
      if (!nt || (nt.type !== "text" && nt.type !== "bt")) this.fail("expected a variable name after '$'", nt);
      this.p++;
      const name = nt.type === "text" ? nt.trim : nt.v;
      this.hasVar = true;
      if (this.isOp("=")) {
        const eq = this.toks[this.p++];
        if (this.atTerminator()) this.fail("assignment is missing its value", eq);
        return { k: "assign", name, x: this.parseAssign() };
      }
      return { k: "var", name };
    }
    if (t.v === "(") {
      this.p++;
      this.enter(t);
      const inner = this.parseSeq();
      if (!inner) this.fail("empty parentheses", t);
      this.expectOp(")", "to close '('");
      this.leave();
      return inner;
    }
    this.fail(`unexpected ${this.describe(t)}`);
    return null; // unreachable
  }

  parseCall(nameTok) {
    const open = this.toks[this.p++]; // '['
    this.enter(open);
    const name = nameTok.trim.toLowerCase();
    this.refs.add(name);
    this.hasCall = true;
    const args = [];
    const raw = [];
    if (this.isOp("]")) {
      this.p++;
      this.leave();
      return { k: "call", name, args, raw, pos: nameTok.s };
    }
    let argStart = open.e;
    for (;;) {
      const node = this.parseSeq();
      const t = this.peek();
      if (!t || t.type !== "op" || (t.v !== "," && t.v !== "]")) {
        this.fail(t ? `expected ',' or ']' in the arguments of ${name}[], found ${this.describe(t)}` : `unbalanced '[': ${name}[ is never closed`, t || open);
      }
      args.push(node);
      raw.push(this.src.slice(argStart, t.s).trim());
      this.p++;
      if (t.v === "]") break;
      argStart = t.e;
    }
    this.leave();
    return { k: "call", name, args, raw, pos: nameTok.s };
  }
}

// parse(src, { mode }) → { ok: true, ast, refs, dynamic, mode, src } | { ok: false, error, pos }
//   refs    = lowercased bare words + called function names (+ every setting_* word, lowercased)
//   dynamic = monster mode: refs ∩ {range, hasshield, metastate}, any setting_* word, any
//             function call or $variable (their value can change between scans)
export function parse(src, { mode = "meta" } = {}) {
  const text = String(src ?? "");
  const m = mode === "monster" ? "monster" : "meta";
  const lx = lex(text);
  if (!lx.ok) return { ok: false, error: lx.error, pos: lx.pos };
  const ps = new Parser(text, lx.tokens);
  try {
    const ast = ps.parseSeq() || { k: "empty" };
    if (ps.p < ps.toks.length) {
      const t = ps.toks[ps.p];
      const what = t.type === "op" && (t.v === "]" || t.v === ")" || t.v === "}") ? `unbalanced '${t.v}'` : `unexpected ${ps.describe(t)}`;
      return { ok: false, error: what, pos: t.s };
    }
    const refs = ps.refs;
    let dynamic = false;
    if (m === "monster") {
      dynamic = ps.hasCall || ps.hasVar;
      for (const r of refs) {
        if (DYNAMIC_WORDS.has(r) || r.startsWith("setting_")) dynamic = true;
      }
    }
    return { ok: true, ast, refs, dynamic, mode: m, src: text };
  } catch (e) {
    if (e instanceof ParseError) return { ok: false, error: e.message, pos: e.pos };
    if (e instanceof RangeError) return { ok: false, error: "expression too deeply nested", pos: 0 };
    return { ok: false, error: `parse failure: ${e && e.message ? e.message : e}`, pos: 0 };
  }
}
