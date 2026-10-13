// rynth/vt/expr/evaluator.js — FunctionRegistry + ExprRuntime (PLAN §3.4).
//
// ExprRuntime.evaluate() NEVER throws: every failure (parse error, unknown
// function, arity, budget, depth, an impl that throws or returns an Err) ends
// the evaluation and comes back as { t: "err", msg } — an error is never
// silently truncated or turned into "" (C# B15/M3). lastError records it.
//
// Semantics (pinned by tests/rynth_vt_expr.test.mjs):
//   `&&` / `||` short-circuit and yield Bool; `iif`/`if`/`ifthen` are lazy.
//   `+` adds when both sides are numeric (Number, Bool or a numeric string),
//   else concatenates; `- * /` numeric (`/` by 0 → 0); `%` integer modulo of
//   truncated operands (by 0 → 0); `< <= > >=` numeric (non-numeric → 0);
//   `==`/`!=` via values.equals; `#` = case-insensitive .NET regex match
//   (left = subject, right = pattern; bad pattern → false + one warning).
//   Bitwise `& | ^ ~ << >>` work on truncated 64-bit integers (RynthAi uses
//   long), so uint32 masks such as 0x80000000 stay positive.
//   `$x` ≡ getvar[x]: the template child scope ($0/$1/$2) first, then the
//   session variable; a missing variable is 0 (UB doc; U5 §5.3).
//   Templates (listmap/listfilter/listreduce/listsort) and exec/ifthen run
//   through call.evalText(text, extraScope): a nested evaluation sharing the
//   caller's node budget, one level deeper (max depth 64).
// Budgets per top-level evaluate: 20 000 node visits, depth 64, bracket
// nesting 256 (parser). Every clock read goes through the injected `now`
// (the wall clock is only the constructor's default).

import { parse } from "./parser.js";
import { lex } from "./lexer.js";
import { V, truthy, toStr, toNum, numericOf, equals, isErr, typeName, makeLog } from "./values.js";
import { getRegex } from "./regex.js";
import { VarStore } from "./vars.js";

class EvalError extends Error {}

const PARSE_CACHE_MAX = 512;
const DELAY_QUEUE_MAX = 10_000;

function clip(s, n = 80) {
  const t = String(s ?? "");
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function msgOf(e) {
  if (e instanceof EvalError) return e.message;
  if (e instanceof RangeError) return "expression too deeply nested";
  return `internal error: ${e && e.message ? e.message : e}`;
}

// ── FunctionRegistry ──────────────────────────────────────────────────────

export class FunctionRegistry {
  constructor({ log } = {}) {
    this._fns = new Map();
    this.log = makeLog(log);
  }

  // Impl(args, call) → Value. args = Value[] (eager) or Array<() => Value> (lazy).
  define(name, impl, opts = {}) {
    const key = String(name ?? "").trim().toLowerCase();
    if (!key || typeof impl !== "function") {
      this.log(`functions: ignoring an invalid definition for "${name}"`);
      return false;
    }
    if (this._fns.has(key)) this.log(`functions: "${key}" redefined (the new definition replaces the old one)`);
    const o = opts || {};
    this._fns.set(key, {
      impl,
      lazy: !!o.lazy,
      minArgs: Number.isFinite(o.minArgs) ? o.minArgs : 0,
      maxArgs: Number.isFinite(o.maxArgs) ? o.maxArgs : Infinity,
    });
    return true;
  }

  has(name) {
    return this._fns.has(String(name ?? "").trim().toLowerCase());
  }

  get(name) {
    return this._fns.get(String(name ?? "").trim().toLowerCase()) || null;
  }

  names() {
    return [...this._fns.keys()].sort();
  }

  /** A function library registers how to release what its functions engaged
   *  in the game (setmotion's held movement keys, cmd/stdlib_host.js). */
  onRelease(fn) {
    if (typeof fn !== "function") return;
    if (!this._release) this._release = [];
    this._release.push(fn);
  }

  /** Run every release hook (the meta engine: operator hold, portal space,
   *  detach). Never throws. */
  release(reason) {
    for (const fn of this._release || []) {
      try {
        fn(reason);
      } catch (e) {
        this.log(`functions: a release hook failed: ${e && e.message ? e.message : e}`);
      }
    }
  }
}

// ── bitwise helpers (64-bit, truncated) ─────────────────────────────────

function toBig(v) {
  const n = Math.trunc(toNum(v));
  if (!Number.isFinite(n)) return 0n;
  return BigInt.asIntN(64, BigInt(n));
}
function fromBig(b) {
  return Number(BigInt.asIntN(64, b));
}

// ── ExprRuntime ─────────────────────────────────────────────────────────

export class ExprRuntime {
  constructor({
    functions = null,
    vars = null,
    mode = "meta",
    resolveIdent = null,
    now = Date.now,
    nodeBudget = 20000,
    maxDepth = 64,
    log,
  } = {}) {
    this.now = typeof now === "function" ? now : Date.now;
    this.log = makeLog(log, () => this._safeNow());
    this.functions = functions || new FunctionRegistry({ log });
    this.vars = vars || new VarStore({ now: this.now, log });
    this.mode = mode === "monster" ? "monster" : "meta";
    this.resolveIdent = typeof resolveIdent === "function" ? resolveIdent : null;
    this.nodeBudget = Number.isFinite(nodeBudget) && nodeBudget > 0 ? nodeBudget : 20000;
    this.maxDepth = Number.isFinite(maxDepth) && maxDepth > 0 ? maxDepth : 64;
    this._parseCache = new Map();
    this._queue = [];
    this._seq = 0;
    this._lastError = null;
    this._frame = null;
  }

  _safeNow() {
    try {
      const t = Number(this.now());
      return Number.isFinite(t) ? t : 0;
    } catch {
      return 0;
    }
  }

  get lastError() {
    return this._lastError;
  }

  // Number of delayexec entries waiting.
  get pendingDelayed() {
    return this._queue.length;
  }

  _err(msg) {
    this._lastError = { msg, at: this._safeNow() };
    return V.err(msg);
  }

  _parseCached(text, mode) {
    const key = `${mode}\u0000${text}`;
    const hit = this._parseCache.get(key);
    if (hit) {
      this._parseCache.delete(key);
      this._parseCache.set(key, hit);
      return hit;
    }
    const p = parse(text, { mode });
    this._parseCache.set(key, p);
    if (this._parseCache.size > PARSE_CACHE_MAX) this._parseCache.delete(this._parseCache.keys().next().value);
    return p;
  }

  // evaluate(srcOrParsed, { scope, resolveIdent }) → Value (never throws)
  evaluate(srcOrParsed, { scope = null, resolveIdent = null } = {}) {
    let parsed;
    if (srcOrParsed !== null && typeof srcOrParsed === "object") parsed = srcOrParsed;
    else parsed = this._parseCached(String(srcOrParsed ?? ""), this.mode);
    if (!parsed || parsed.ok === false) {
      const pos = parsed && Number.isFinite(parsed.pos) ? parsed.pos : 0;
      const why = parsed && parsed.error ? parsed.error : "not a parsed expression";
      return this._err(`parse error at ${pos}: ${why}`);
    }
    if (!parsed.ast) return this._err("not a parsed expression");
    const outer = this._frame;
    const frame = {
      counter: outer ? outer.counter : { n: 0 },
      depth: outer ? outer.depth + 1 : 0,
      resolveIdent: typeof resolveIdent === "function" ? resolveIdent : this.resolveIdent,
      mode: parsed.mode === "monster" ? "monster" : parsed.mode === "meta" ? "meta" : this.mode,
    };
    if (frame.depth > this.maxDepth) return this._err(`maximum evaluation depth (${this.maxDepth}) exceeded`);
    const sc = this._normScope(scope);
    this._frame = frame;
    try {
      const v = this._ev(parsed.ast, sc, frame);
      return v === undefined ? null : v;
    } catch (e) {
      return this._err(msgOf(e));
    } finally {
      this._frame = outer;
    }
  }

  _normScope(scope) {
    if (!scope) return null;
    if (scope instanceof Map) {
      for (const k of scope.keys()) {
        if (typeof k !== "string" || k !== k.toLowerCase()) {
          return new Map([...scope].map(([key, v]) => [String(key).toLowerCase(), v]));
        }
      }
      return scope;
    }
    if (typeof scope === "object") return new Map(Object.keys(scope).map((k) => [k.toLowerCase(), scope[k]]));
    return null;
  }

  // ── variables ($x ≡ getvar[x]) ─────────────────────────────────────────
  getVar(name, scope = null) {
    const key = String(name ?? "").trim();
    const lower = key.toLowerCase();
    if (scope && scope.has(lower)) return scope.get(lower);
    const v = this.vars.get("session", key);
    return v === undefined ? 0 : v;
  }

  hasVar(name, scope = null) {
    const key = String(name ?? "").trim();
    if (scope && scope.has(key.toLowerCase())) return true;
    return this.vars.has("session", key);
  }

  setVar(name, value, scope = null) {
    const key = String(name ?? "").trim();
    const lower = key.toLowerCase();
    const v = value === undefined ? null : value;
    if (scope && scope.has(lower)) scope.set(lower, v);
    else this.vars.set("session", key, v);
    return v;
  }

  // ── delayexec queue (pumped only by pump(now)) ────────────────────────
  delay(ms, text) {
    const d = Math.max(0, toNum(ms) || 0);
    if (this._queue.length >= DELAY_QUEUE_MAX) {
      this.log(`delayexec queue full (${DELAY_QUEUE_MAX}); dropping "${clip(text)}"`);
      return;
    }
    this._queue.push({ due: this._safeNow() + d, seq: this._seq++, text: String(text ?? "") });
  }

  // Runs every entry due at nowMs, in (due time, insertion) order; entries
  // scheduled while pumping wait for the next pump. Returns the count run.
  pump(nowMs) {
    try {
      if (this._queue.length === 0) return 0;
      const t = Number.isFinite(nowMs) ? nowMs : this._safeNow();
      const due = this._queue.filter((e) => e.due <= t);
      if (due.length === 0) return 0;
      due.sort((a, b) => a.due - b.due || a.seq - b.seq);
      const run = new Set(due);
      this._queue = this._queue.filter((e) => !run.has(e));
      for (const e of due) {
        const v = this.evaluate(e.text);
        if (isErr(v)) this.log(`delayexec "${clip(e.text)}" failed: ${v.msg}`);
      }
      return due.length;
    } catch (e) {
      this.log(`delayexec pump failed: ${e && e.message ? e.message : e}`);
      return 0;
    }
  }

  clearDelayed() {
    this._queue = [];
  }

  // ── evaluation core ─────────────────────────────────────────────────────
  _ev(node, scope, fr) {
    if (++fr.counter.n > this.nodeBudget) throw new EvalError(`expression budget exceeded (${this.nodeBudget} node visits)`);
    switch (node.k) {
      case "num":
      case "str":
        return node.v;
      case "empty":
        return "";
      case "word":
        if (fr.mode === "monster") {
          if (fr.resolveIdent) {
            const v = fr.resolveIdent(node.lower, node.name);
            if (v !== undefined) return v;
          }
          if (node.lower === "true") return true;
          if (node.lower === "false") return false;
        }
        return node.v;
      case "var":
        return this.getVar(node.name, scope);
      case "assign": {
        const v = this._ev(node.x, scope, fr);
        return this.setVar(node.name, v, scope);
      }
      case "seq": {
        let v = "";
        for (const it of node.items) v = this._ev(it, scope, fr);
        return v;
      }
      case "and":
        if (!truthy(this._ev(node.a, scope, fr))) return false;
        return truthy(this._ev(node.b, scope, fr));
      case "or":
        if (truthy(this._ev(node.a, scope, fr))) return true;
        return truthy(this._ev(node.b, scope, fr));
      case "un":
        return this._unary(node.op, this._ev(node.x, scope, fr));
      case "bin":
        return this._binary(node.op, this._ev(node.a, scope, fr), this._ev(node.b, scope, fr));
      case "call":
        return this._call(node, scope, fr);
      case "index":
        return this._index(node, scope, fr);
      default:
        throw new EvalError(`unknown expression node "${node && node.k}"`);
    }
  }

  _unary(op, x) {
    switch (op) {
      case "-": {
        const r = -toNum(x);
        return r === 0 ? 0 : r;
      }
      case "!":
        return !truthy(x);
      case "~":
        return fromBig(~toBig(x));
      default:
        throw new EvalError(`unknown unary operator ${op}`);
    }
  }

  _binary(op, a, b) {
    switch (op) {
      case "+": {
        const na = numericOf(a);
        const nb = numericOf(b);
        if (na !== null && nb !== null) return na + nb;
        return toStr(a) + toStr(b);
      }
      case "-":
        return toNum(a) - toNum(b);
      case "*":
        return toNum(a) * toNum(b);
      case "/": {
        const d = toNum(b);
        return d === 0 ? 0 : toNum(a) / d;
      }
      case "%": {
        const x = Math.trunc(toNum(a));
        const y = Math.trunc(toNum(b));
        if (y === 0 || !Number.isFinite(x) || !Number.isFinite(y)) return 0;
        const r = x % y;
        return r === 0 ? 0 : r;
      }
      case "==":
        return equals(a, b);
      case "!=":
        return !equals(a, b);
      case "<":
        return toNum(a) < toNum(b);
      case "<=":
        return toNum(a) <= toNum(b);
      case ">":
        return toNum(a) > toNum(b);
      case ">=":
        return toNum(a) >= toNum(b);
      case "#": {
        const rx = getRegex(toStr(b), "i", { log: this.log });
        return rx ? rx.test(toStr(a)) : false;
      }
      case "&":
        return fromBig(toBig(a) & toBig(b));
      case "|":
        return fromBig(toBig(a) | toBig(b));
      case "^":
        return fromBig(toBig(a) ^ toBig(b));
      case "<<":
        return fromBig(toBig(a) << (toBig(b) & 63n));
      case ">>":
        return fromBig(toBig(a) >> (toBig(b) & 63n));
      default:
        throw new EvalError(`unknown operator ${op}`);
    }
  }

  _index(node, scope, fr) {
    const x = this._ev(node.x, scope, fr);
    if (node.slice) {
      const a = node.a ? Math.trunc(toNum(this._ev(node.a, scope, fr))) : null;
      const b = node.b ? Math.trunc(toNum(this._ev(node.b, scope, fr))) : null;
      const isL = x !== null && typeof x === "object" && x.t === "list";
      const len = isL ? x.items.length : toStr(x).length;
      const norm = (i, dflt) => {
        if (i === null || !Number.isFinite(i)) return dflt;
        const j = i < 0 ? len + i : i;
        return Math.max(0, Math.min(len, j));
      };
      const s = norm(a, 0);
      const e = norm(b, len);
      if (isL) return V.list(e > s ? x.items.slice(s, e) : []);
      return e > s ? toStr(x).slice(s, e) : "";
    }
    const key = this._ev(node.key, scope, fr);
    if (x !== null && typeof x === "object") {
      if (x.t === "dict") {
        const k = toStr(key);
        return x.map.has(k) ? x.map.get(k) : null;
      }
      if (x.t === "list") {
        let i = Math.trunc(toNum(key));
        if (i < 0) i += x.items.length;
        return i >= 0 && i < x.items.length ? x.items[i] : null;
      }
      throw new EvalError(`cannot index a ${typeName(x)}`);
    }
    if (x === null) return null;
    const s = toStr(x);
    let i = Math.trunc(toNum(key));
    if (i < 0) i += s.length;
    return i >= 0 && i < s.length ? s[i] : "";
  }

  _call(node, scope, fr) {
    const def = this.functions.get(node.name);
    if (!def) throw new EvalError(`Call to unknown function "${node.name}"`);
    const argc = node.args.length;
    if (argc < def.minArgs) {
      throw new EvalError(`${node.name}[] expects at least ${def.minArgs} argument${def.minArgs === 1 ? "" : "s"}, got ${argc}`);
    }
    if (argc > def.maxArgs) {
      throw new EvalError(`${node.name}[] expects at most ${def.maxArgs} argument${def.maxArgs === 1 ? "" : "s"}, got ${argc}`);
    }
    let args;
    if (def.lazy) {
      args = node.args.map((a) => () => (a ? this._ev(a, scope, fr) : ""));
    } else {
      args = new Array(argc);
      for (let i = 0; i < argc; i++) args[i] = node.args[i] ? this._ev(node.args[i], scope, fr) : "";
    }
    const call = this._makeCall(node, scope, fr);
    let ret;
    try {
      ret = def.impl(args, call);
    } catch (e) {
      if (e instanceof EvalError) throw e;
      if (e instanceof RangeError) throw new EvalError("expression too deeply nested");
      throw new EvalError(`${node.name}[] failed: ${e && e.message ? e.message : e}`);
    }
    if (ret === undefined) return null;
    if (isErr(ret)) throw new EvalError(ret.msg);
    return ret;
  }

  _makeCall(node, scope, fr) {
    const rt = this;
    return {
      name: node.name,
      raw: node.raw,
      rt,
      scope,
      mode: fr.mode,
      log: rt.log,
      now: () => rt._safeNow(),
      // Evaluates `text` one level deeper (shared budget) in a CHILD scope:
      // the caller's scope plus extraScope ($0/$1/$2 for templates). Returns
      // a Value; failures come back as an Err value (the impl returns it,
      // which ends the whole evaluation).
      evalText(text, extraScope = null) {
        try {
          return rt._evalText(String(text ?? ""), scope, extraScope, fr);
        } catch (e) {
          return V.err(msgOf(e));
        }
      },
    };
  }

  _evalText(text, scope, extraScope, fr) {
    if (fr.depth + 1 > this.maxDepth) throw new EvalError(`maximum evaluation depth (${this.maxDepth}) exceeded`);
    const parsed = this._parseCached(text, fr.mode);
    if (!parsed.ok) throw new EvalError(`parse error at ${parsed.pos}: ${parsed.error} in "${clip(text)}"`);
    let child = scope;
    if (extraScope) {
      child = new Map(scope || []);
      const entries = extraScope instanceof Map ? extraScope.entries() : Object.entries(extraScope);
      for (const [k, v] of entries) child.set(String(k).toLowerCase(), v);
    }
    const inner = { counter: fr.counter, depth: fr.depth + 1, resolveIdent: fr.resolveIdent, mode: fr.mode };
    const prev = this._frame;
    this._frame = inner;
    try {
      const v = this._ev(parsed.ast, child, inner);
      return v === undefined ? null : v;
    } finally {
      this._frame = prev;
    }
  }
}

// Template text of a lazy argument (C# Tmpl): the content of a single
// backtick literal, else the raw (trimmed) argument source.
export function templateArg(call, i) {
  const raw = call && Array.isArray(call.raw) ? String(call.raw[i] ?? "") : "";
  if (raw.length >= 2 && raw[0] === "`" && raw[raw.length - 1] === "`") {
    const lx = lex(raw);
    if (lx.ok && lx.tokens.length === 1 && lx.tokens[0].type === "bt") return lx.tokens[0].v;
  }
  return raw;
}
