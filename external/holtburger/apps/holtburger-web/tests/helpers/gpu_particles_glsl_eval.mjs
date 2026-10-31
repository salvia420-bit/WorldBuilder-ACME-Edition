// tests/helpers/gpu_particles_glsl_eval.mjs — evaluates the `?gpuParticles`
// vertex header (scene3d/particles/gpu_particles.js GP_GLSL_HEADER) AS WRITTEN,
// and (2026-10-31, smoke fix) a WHOLE vertex program as three r184 builds it
// (prefix + ShaderChunks + the onBeforeCompile chain, captured from the real
// WebGLRenderer over tests/helpers/fake_webgl2.mjs), in node, with f32 rounding
// after every float operation. A tree-walking interpreter for exactly the
// GLSL ES 3.00 subset those sources use:
//   preprocessor  #if / #elif with defined( A ) / defined A, integer
//                 arithmetic, comparisons and logic, #ifdef, #ifndef, #else,
//                 #endif, object-like and function-like #define, #undef,
//                 #version (ignored), // comments
//   globals       precision statements (skipped), struct definitions (as
//                 types), uniform / in / out declarations (several
//                 declarators), function definitions (overloads by arity /
//                 parameter types), prototypes
//   statements    declarations (qualifiers, several declarators), expression
//                 statements, = += -= *= /= (also into swizzles and [ ]),
//                 if / else (blocks or single statements), return
//   expressions   ?:, || && ! == != < > <= >=, + - * / (scalar, vector,
//                 broadcast, matrix x vector, vector x matrix, matrix x
//                 matrix; int / int truncates), unary -, calls, swizzles,
//                 [ ] on vectors / matrices (read and assign)
//   types         float int bool vec2 vec3 vec4 ivec2 mat3 mat4 (+ declared
//                 structs, parse only)
//   builtins      float int vec2 vec3 vec4 ivec2 mat3 mat4 texelFetch floor
//                 abs min max clamp sin cos sqrt dot cross normalize
// Anything else throws (the header grew a construct this subset does not know:
// extend it, do not loosen the check that uses it), and so does a texelFetch
// outside its texture (undefined in GLSL; never aliased onto the next texture
// row, which would hide a row-boundary addressing bug). The builtins round like
// tests/helpers/gpu_particles_f32.mjs (dot / cross / normalize in its order),
// so a header and a twin that agree statement by statement agree bit for bit.
// `opts.builtins` replaces builtins by name (the driver-trig replay:
// SWIFTSHADER_TRIG below is SwiftShader's sin / cos, the ones the 2026-10-31
// smoke ran on).
//
// Used by tests/gpu_particles.test.mjs (G5: the shader text == the f32 twin;
// S: the smoke's node half — the production program's coverage centroid and
// the kernel verdicts under SwiftShader's trig).

const f = Math.fround;

// ------------------------------------------------------------------ preprocess

// Split a function-like macro's argument list at top-level commas; returns
// [args, index after the closing parenthesis] or null.
function macroArgs(s, open) {
  const args = [];
  let depth = 0, cur = "";
  for (let i = open + 1; i < s.length; i++) {
    const ch = s[i];
    if (ch === "(") depth++;
    if (ch === ")") {
      if (depth === 0) { args.push(cur.trim()); return [args, i + 1]; }
      depth--;
    }
    if (ch === "," && depth === 0) { args.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  return null;
}

function preprocess(src, defines) {
  // name -> { body, params: null (object-like) | [names] }
  const defs = new Map();
  for (const d of defines) defs.set(d, { body: "", params: null });
  const out = [];
  const stack = []; // { active, taken, parent }
  const active = () => stack.every((s) => s.active);
  // macro expansion with rescanning (C semantics; a macro never re-expands itself)
  const expand = (line, hide = new Set(), depth = 0) => {
    if (depth > 16) throw new Error(`macro expansion too deep: ${line.slice(0, 80)}`);
    let res = "";
    const re = /(?<![\w.])[A-Za-z_]\w*/g; // never inside a numeric literal (1e-4)
    let at = 0, m;
    while ((m = re.exec(line)) !== null) {
      const id = m[0];
      const d = defs.get(id);
      if (!d || hide.has(id)) continue;
      if (d.params === null) {
        res += line.slice(at, m.index) + expand(d.body, new Set([...hide, id]), depth + 1);
        at = re.lastIndex;
        continue;
      }
      let j = re.lastIndex;
      while (j < line.length && /\s/.test(line[j])) j++;
      if (line[j] !== "(") continue; // a function-like macro name without arguments stays
      const a = macroArgs(line, j);
      if (!a) throw new Error(`unterminated macro call ${id}`);
      const [args, end] = a;
      if (args.length !== d.params.length && !(d.params.length === 0 && args.length === 1 && args[0] === "")) {
        throw new Error(`macro ${id}: ${args.length} arguments for ${d.params.length}`);
      }
      const body = d.body.replace(/(?<![\w.])[A-Za-z_]\w*/g, (p) => {
        const k = d.params.indexOf(p);
        return k === -1 ? p : `( ${expand(args[k], hide, depth + 1)} )`;
      });
      res += line.slice(at, m.index) + expand(body, new Set([...hide, id]), depth + 1);
      at = end;
      re.lastIndex = end;
    }
    return res + line.slice(at);
  };
  const evalIf = (expr) => {
    // defined( A ) / defined A, macros, integers, ! && || == != < > <= >= + - * / %
    let js = expr.replace(/defined\s*\(\s*(\w+)\s*\)|defined\s+(\w+)/g, (_, a, b) => (defs.has(a || b) ? " 1 " : " 0 "));
    js = expand(js).replace(/(?<![\w.])[A-Za-z_]\w*/g, " 0 "); // C: an identifier left after expansion is 0
    if (!/^[\s()0-9&|!=<>+\-*\/%]*$/.test(js)) throw new Error(`#if: unsupported expression ${expr}`);
    return !!Function(`return (${js});`)();
  };
  for (const raw of src.split("\n")) {
    const line = raw.replace(/\/\/.*$/, "");
    const m = /^\s*#\s*(\w+)\s*(.*)$/.exec(line);
    if (m) {
      const [, dir, rest] = m;
      const live = active();
      if (dir === "if") { const a = live && evalIf(rest); stack.push({ active: a, taken: a }); }
      else if (dir === "ifdef") { const a = defs.has(rest.trim()); stack.push({ active: a, taken: a }); }
      else if (dir === "ifndef") { const a = !defs.has(rest.trim()); stack.push({ active: a, taken: a }); }
      else if (dir === "elif") {
        const s = stack[stack.length - 1];
        if (!s) throw new Error("#elif without #if");
        const outer = stack.slice(0, -1).every((x) => x.active);
        if (s.taken || !outer) s.active = false;
        else { s.active = evalIf(rest); s.taken = s.active; }
      }
      else if (dir === "else") { const s = stack[stack.length - 1]; s.active = !s.taken; s.taken = true; }
      else if (dir === "endif") stack.pop();
      else if (!live) { out.push(""); continue; }
      else if (dir === "version") { /* the program's first line: GLSL ES 3.00 assumed */ }
      else if (dir === "define") {
        const fn = /^(\w+)\(([^)]*)\)\s*(.*)$/.exec(rest);
        if (fn) defs.set(fn[1], { body: fn[3].trim(), params: fn[2].split(",").map((x) => x.trim()).filter((x) => x !== "") });
        else {
          const d = /^(\w+)\s*(.*)$/.exec(rest);
          if (!d) throw new Error(`#define: ${rest}`);
          defs.set(d[1], { body: d[2].trim(), params: null });
        }
      } else if (dir === "undef") defs.delete(rest.trim());
      else throw new Error(`unsupported directive #${dir}`);
      out.push("");
      continue;
    }
    if (!active()) { out.push(""); continue; }
    out.push(expand(line));
  }
  if (stack.length) throw new Error("unterminated #if");
  return out.join("\n");
}

// ------------------------------------------------------------------ tokens

const TYPES0 = ["float", "int", "bool", "vec2", "vec3", "vec4", "ivec2", "mat3", "mat4", "void", "sampler2D"];
const QUALS = new Set(["uniform", "highp", "mediump", "lowp", "in", "out", "const", "flat", "smooth", "centroid", "invariant"]);

function tokenize(src) {
  const re = /\s+|(\d+\.\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?|\d+[eE][+-]?\d+|\d+)|([A-Za-z_]\w*)|(\+=|-=|\*=|\/=|==|!=|<=|>=|&&|\|\||[-+*\/<>=!?:;,(){}\[\].])/y;
  const toks = [];
  let m;
  re.lastIndex = 0;
  while (re.lastIndex < src.length) {
    const at = re.lastIndex;
    m = re.exec(src);
    if (!m || m.index !== at) throw new Error(`tokenize: unexpected ${JSON.stringify(src.slice(at, at + 20))}`);
    if (m[1] !== undefined) toks.push({ k: "num", v: m[1] });
    else if (m[2] !== undefined) toks.push({ k: "id", v: m[2] });
    else if (m[3] !== undefined) toks.push({ k: "op", v: m[3] });
  }
  toks.push({ k: "eof", v: "" });
  return toks;
}

// ------------------------------------------------------------------ parser

function parse(src) {
  const T = tokenize(src);
  let i = 0;
  const TYPES = new Set(TYPES0);
  const peek = (o = 0) => T[i + o];
  const next = () => T[i++];
  const isOp = (v, o = 0) => T[i + o].k === "op" && T[i + o].v === v;
  const expect = (v) => { const t = next(); if (t.v !== v) throw new Error(`parse: expected ${v}, got ${t.v} at token ${i}`); return t; };
  const isType = (o = 0) => T[i + o].k === "id" && TYPES.has(T[i + o].v);
  const quals = () => { const q = []; while (peek().k === "id" && QUALS.has(peek().v)) q.push(next().v); return q; };

  const globals = [];
  const funcs = new Map(); // name -> [overloads]
  const structs = new Map();
  while (peek().k !== "eof") {
    if (peek().k === "id" && peek().v === "precision") {
      next(); next(); next(); expect(";"); // precision <qualifier> <type>;
      continue;
    }
    if (peek().k === "id" && peek().v === "struct") {
      next();
      const sname = next().v;
      expect("{");
      const members = [];
      while (!isOp("}")) {
        quals();
        const mt = next().v;
        for (;;) { members.push({ type: mt, name: next().v }); if (isOp(",")) { next(); continue; } break; }
        expect(";");
      }
      expect("}");
      expect(";");
      structs.set(sname, members);
      TYPES.add(sname);
      continue;
    }
    const q = quals();
    if (!isType()) throw new Error(`parse: expected a type at global scope, got ${peek().v}`);
    const type = next().v;
    const name = next().v;
    if (isOp("(")) {
      next();
      const params = [];
      while (!isOp(")")) {
        quals();
        const pt = next().v;
        if (pt === "void" && isOp(")")) break;
        const pn = next().v;
        params.push({ type: pt, name: pn });
        if (isOp(",")) next();
      }
      expect(")");
      if (isOp(";")) { next(); continue; } // a prototype
      if (!funcs.has(name)) funcs.set(name, []);
      funcs.get(name).push({ type, name, params, body: block() });
    } else {
      let nm = name;
      for (;;) {
        let init = null;
        if (isOp("=")) { next(); init = assign(); }
        globals.push({ type, name: nm, quals: q, init });
        if (isOp(",")) { next(); nm = next().v; continue; }
        break;
      }
      expect(";");
    }
  }
  return { globals, funcs, structs };

  function block() {
    expect("{");
    const stmts = [];
    while (!isOp("}")) stmts.push(statement());
    expect("}");
    return { s: "block", stmts };
  }
  function statement() {
    if (isOp("{")) return block();
    const t = peek();
    if (t.k === "id" && t.v === "if") {
      next(); expect("(");
      const cond = expr();
      expect(")");
      const then = statement();
      let els = null;
      if (peek().k === "id" && peek().v === "else") { next(); els = statement(); }
      return { s: "if", cond, then, els };
    }
    if (t.k === "id" && t.v === "return") {
      next();
      if (isOp(";")) { next(); return { s: "return", e: null }; }
      const e = expr();
      expect(";");
      return { s: "return", e };
    }
    let qn = 0;
    while (T[i + qn].k === "id" && QUALS.has(T[i + qn].v)) qn++;
    if (isType(qn) && peek(qn + 1).k === "id") {
      i += qn;
      const type = next().v;
      const decls = [];
      for (;;) {
        const name = next().v;
        let init = null;
        if (isOp("=")) { next(); init = assign(); }
        decls.push({ s: "decl", type, name, init });
        if (isOp(",")) { next(); continue; }
        break;
      }
      expect(";");
      return decls.length === 1 ? decls[0] : { s: "decls", decls };
    }
    const e = expr();
    expect(";");
    return { s: "expr", e };
  }
  function expr() { return assign(); }
  function assign() {
    const l = ternary();
    if (peek().k === "op" && ["=", "+=", "-=", "*=", "/="].includes(peek().v)) {
      const op = next().v;
      return { e: "assign", op, target: l, value: assign() };
    }
    return l;
  }
  function ternary() {
    const c = binary(0);
    if (isOp("?")) { next(); const a = assign(); expect(":"); const b = assign(); return { e: "ternary", c, a, b }; }
    return c;
  }
  function binary(level) {
    const LV = [["||"], ["&&"], ["==", "!="], ["<", ">", "<=", ">="], ["+", "-"], ["*", "/"]];
    if (level === LV.length) return unary();
    let l = binary(level + 1);
    while (peek().k === "op" && LV[level].includes(peek().v)) {
      const op = next().v;
      l = { e: "bin", op, l, r: binary(level + 1) };
    }
    return l;
  }
  function unary() {
    if (isOp("-") || isOp("!")) { const op = next().v; return { e: "un", op, x: unary() }; }
    return postfix(primary());
  }
  function primary() {
    const t = next();
    if (t.k === "num") return { e: "num", int: !/[.eE]/.test(t.v), v: Number(t.v) };
    if (t.k === "op" && t.v === "(") { const x = expr(); expect(")"); return x; }
    if (t.k === "id") {
      if (isOp("(")) {
        next();
        const args = [];
        while (!isOp(")")) { args.push(assign()); if (isOp(",")) next(); }
        expect(")");
        return { e: "call", name: t.v, args };
      }
      if (t.v === "true" || t.v === "false") return { e: "bool", v: t.v === "true" };
      return { e: "id", name: t.v };
    }
    throw new Error(`parse: unexpected ${t.v}`);
  }
  function postfix(x) {
    for (;;) {
      if (isOp(".")) { next(); x = { e: "member", x, name: next().v }; continue; }
      if (isOp("[")) { next(); const idx = expr(); expect("]"); x = { e: "index", x, idx }; continue; }
      return x;
    }
  }
}

// ------------------------------------------------------------------ values

const V = (t, v) => ({ t, v });
const SW = { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3 };
const vecT = (n, int) => (int ? `ivec${n}` : `vec${n}`);
const isVec = (t) => /^i?vec[234]$/.test(t);
const isMat = (t) => t === "mat3" || t === "mat4";

function zero(type) {
  switch (type) {
    case "float": return V("float", 0);
    case "int": return V("int", 0);
    case "bool": return V("bool", false);
    case "vec2": case "vec3": case "vec4": return V(type, new Array(+type[3]).fill(0));
    case "ivec2": return V("ivec2", [0, 0]);
    case "mat3": return V("mat3", [[0, 0, 0], [0, 0, 0], [0, 0, 0]]);
    case "mat4": return V("mat4", [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
    default: throw new Error(`no zero for ${type}`);
  }
}
const copy = (x) => (Array.isArray(x.v) ? V(x.t, x.v.map((c) => (Array.isArray(c) ? c.slice() : c))) : V(x.t, x.v));
const comps = (x) => (typeof x.v === "number" ? [x.v] : isMat(x.t) ? x.v.flat() : x.v);

function arith(op, a, b) {
  const sa = typeof a.v === "number", sb = typeof b.v === "number";
  const int = a.t === "int" && b.t === "int";
  const one = (x, y) => {
    if (int) {
      if (op === "+") return x + y;
      if (op === "-") return x - y;
      if (op === "*") return Math.imul(x, y);
      if (op === "/") return Math.trunc(x / y);
    }
    if (op === "+") return f(x + y);
    if (op === "-") return f(x - y);
    if (op === "*") return f(x * y);
    if (op === "/") return f(x / y);
    throw new Error(op);
  };
  if (sa && sb) return V(int ? "int" : "float", one(a.v, b.v));
  if (isMat(a.t) || isMat(b.t)) return matArith(op, a, b);
  if (sa) return V(b.t, b.v.map((y) => one(a.v, y)));
  if (sb) return V(a.t, a.v.map((x) => one(x, b.v)));
  if (a.v.length !== b.v.length) throw new Error(`${a.t} ${op} ${b.t}`);
  return V(a.t, a.v.map((x, k) => one(x, b.v[k])));
}

// matrices are arrays of columns; products accumulate in index order, f32 per operation
function matArith(op, a, b) {
  const ma = isMat(a.t), mb = isMat(b.t);
  const n = (ma ? a : b).v.length;
  const colDot = (m, v, r) => { let s = f(m[0][r] * v[0]); for (let c = 1; c < n; c++) s = f(s + f(m[c][r] * v[c])); return s; };
  const rowDot = (v, col) => { let s = f(v[0] * col[0]); for (let r = 1; r < n; r++) s = f(s + f(v[r] * col[r])); return s; };
  if (op === "*" && ma && mb) {
    if (a.t !== b.t) throw new Error(`${a.t} * ${b.t}`);
    return V(a.t, b.v.map((col) => Array.from({ length: n }, (_, r) => colDot(a.v, col, r))));
  }
  if (op === "*" && ma && isVec(b.t)) {
    if (b.v.length !== n) throw new Error(`${a.t} * ${b.t}`);
    return V(b.t, Array.from({ length: n }, (_, r) => colDot(a.v, b.v, r)));
  }
  if (op === "*" && mb && isVec(a.t)) {
    if (a.v.length !== n) throw new Error(`${a.t} * ${b.t}`);
    return V(a.t, b.v.map((col) => rowDot(a.v, col)));
  }
  const one = (x, y) => {
    if (op === "+") return f(x + y);
    if (op === "-") return f(x - y);
    if (op === "*") return f(x * y);
    if (op === "/") return f(x / y);
    throw new Error(op);
  };
  if (ma && mb) { if (a.t !== b.t) throw new Error(`${a.t} ${op} ${b.t}`); return V(a.t, a.v.map((col, c) => col.map((x, r) => one(x, b.v[c][r])))); }
  if (ma && typeof b.v === "number") return V(a.t, a.v.map((col) => col.map((x) => one(x, b.v))));
  if (mb && typeof a.v === "number") return V(b.t, b.v.map((col) => col.map((y) => one(a.v, y))));
  throw new Error(`matrix ${op} unsupported: ${a.t} ${b.t}`);
}

function construct(type, args) {
  const flat = args.flatMap(comps);
  const int = type === "ivec2" || type === "int";
  const cv = (x) => (int ? Math.trunc(x) : f(x));
  if (type === "float") return V("float", f(flat[0]));
  if (type === "int") return V("int", Math.trunc(flat[0]));
  if (isVec(type)) {
    const n = +type[type.length - 1];
    if (flat.length === 1) return V(type, new Array(n).fill(cv(flat[0])));
    if (flat.length !== n) throw new Error(`${type}: ${flat.length} components`);
    return V(type, flat.map(cv));
  }
  if (isMat(type)) {
    const n = type === "mat3" ? 3 : 4;
    if (args.length === 1 && typeof args[0].v === "number") {
      const d = f(args[0].v);
      return V(type, Array.from({ length: n }, (_, c) => Array.from({ length: n }, (__, r) => (r === c ? d : 0))));
    }
    if (args.length === 1 && isMat(args[0].t)) {
      // mat3( mat4 ) / mat4( mat3 ): the upper-left block, identity elsewhere
      const m = args[0].v;
      return V(type, Array.from({ length: n }, (_, c) => Array.from({ length: n }, (__, r) => (c < m.length && r < m.length ? m[c][r] : (r === c ? 1 : 0)))));
    }
    if (flat.length !== n * n) throw new Error(`${type}: ${flat.length} components`);
    return V(type, Array.from({ length: n }, (_, c) => flat.slice(c * n, c * n + n).map(f)));
  }
  throw new Error(`construct ${type}`);
}

const fDot = (a, b) => { let s = f(a[0] * b[0]); for (let k = 1; k < a.length; k++) s = f(s + f(a[k] * b[k])); return s; };

// ------------------------------------------------------------------ interpreter

class Ret { constructor(v) { this.v = v; } }

const isScalarT = (t) => t === "float" || t === "int" || t === "bool";
const toValue = (type, raw) => {
  // a JS input (number / bool / array / column-major flat matrix) as a GLSL value of `type`
  if (type === "bool") return V("bool", !!raw);
  if (type === "int") return V("int", Math.trunc(Number(raw)));
  if (type === "float") return V("float", f(Number(raw)));
  const a = Array.from(raw, Number);
  if (isMat(type)) {
    const n = type === "mat3" ? 3 : 4;
    if (a.length !== n * n) throw new Error(`${type} input: ${a.length} floats`);
    return V(type, Array.from({ length: n }, (_, c) => a.slice(c * n, c * n + n).map(f)));
  }
  if (isVec(type)) {
    const n = +type[type.length - 1];
    if (a.length !== n) throw new Error(`${type} input: ${a.length} floats`);
    return V(type, type.startsWith("i") ? a.map(Math.trunc) : a.map(f));
  }
  throw new Error(`no input conversion for ${type}`);
};
const fromValue = (x) => (x === undefined || x === null ? x : typeof x.v === "number" || typeof x.v === "boolean" ? x.v : isMat(x.t) ? x.v.flat() : x.v.slice());

/**
 * The interpreter over one preprocessed source. `opts.builtins` = { name:
 * (argValues) => value } replaces / adds builtins (GLSL values are { t, v }).
 * Returns `run(entry, env)` → the globals map after the entry ran, where `env` =
 * { instanceColor?: [3] (header mode), attributes?: { name: [..] },
 *   uniforms?: { name: number | bool | [..] (matrices column-major) },
 *   textures: { name: { data: Float32Array RGBA, width } } }.
 */
function compileProgram(src, defines, opts = {}) {
  const ast = parse(preprocess(src, defines));
  let env = null;
  let globals = null;
  const builtins = {
    texelFetch([s, p]) {
      const tex = s.v;
      const [x, y] = p.v;
      const d = tex.data;
      // GLSL ES 3.00: an out-of-range texelFetch is undefined (ANGLE / D3D11
      // read zero). A flat (y * width + x) read would alias a negative x onto
      // the previous texture row and hide an addressing bug at a row boundary.
      const h = Math.floor(d.length / (tex.width * 4));
      if (!(Number.isInteger(x) && Number.isInteger(y) && x >= 0 && x < tex.width && y >= 0 && y < h)) {
        throw new Error(`texelFetch out of range: (${x}, ${y}) of ${tex.width} x ${h}`);
      }
      const o = (y * tex.width + x) * 4;
      return V("vec4", [d[o], d[o + 1], d[o + 2], d[o + 3]]);
    },
    floor: ([x]) => (typeof x.v === "number" ? V(x.t, Math.floor(x.v)) : V(x.t, x.v.map(Math.floor))),
    abs: ([x]) => V(x.t, typeof x.v === "number" ? Math.abs(x.v) : x.v.map(Math.abs)),
    min: ([a, b]) => V(a.t, Math.min(a.v, b.v)),
    max: ([a, b]) => V(a.t, Math.max(a.v, b.v)),
    clamp: ([x, lo, hi]) => V(x.t, Math.min(Math.max(x.v, lo.v), hi.v)),
    sin: ([x]) => V("float", f(Math.sin(f(x.v)))),
    cos: ([x]) => V("float", f(Math.cos(f(x.v)))),
    sqrt: ([x]) => V("float", f(Math.sqrt(x.v))),
    dot: ([a, b]) => V("float", fDot(a.v, b.v)),
    cross: ([a, b]) => {
      const x = a.v, y = b.v;
      return V("vec3", [f(f(x[1] * y[2]) - f(x[2] * y[1])), f(f(x[2] * y[0]) - f(x[0] * y[2])), f(f(x[0] * y[1]) - f(x[1] * y[0]))]);
    },
    normalize: ([a]) => { const l = f(Math.sqrt(fDot(a.v, a.v))); return V(a.t, a.v.map((c) => f(c / l))); },
  };
  for (const t of ["float", "int", "vec2", "vec3", "vec4", "ivec2", "mat3", "mat4"]) builtins[t] = (args) => construct(t, args);
  if (opts.builtins) for (const [k, fn] of Object.entries(opts.builtins)) builtins[k] = fn;
  // which builtins the evaluated code called (the "no driver transcendental" check)
  const calls = new Map();

  function lookup(scope, name) {
    for (let s = scope; s; s = s.parent) if (s.vars.has(name)) return s.vars;
    if (globals.has(name)) return globals;
    throw new Error(`undefined ${name}`);
  }
  function evalExpr(x, scope) {
    switch (x.e) {
      case "num": return x.int ? V("int", x.v) : V("float", f(x.v));
      case "bool": return V("bool", x.v);
      case "id": {
        if (x.name === "instanceColor" && env.instanceColor && !(env.attributes && "instanceColor" in env.attributes)) return V("vec3", env.instanceColor.map(f));
        return lookup(scope, x.name).get(x.name);
      }
      case "member": {
        const b = evalExpr(x.x, scope);
        const idx = [...x.name].map((ch) => { if (!(ch in SW)) throw new Error(`swizzle ${x.name}`); return SW[ch]; });
        if (!isVec(b.t)) throw new Error(`swizzle .${x.name} of ${b.t}`);
        const int = b.t.startsWith("i");
        if (idx.length === 1) return V(int ? "int" : "float", b.v[idx[0]]);
        return V(vecT(idx.length, int), idx.map((k) => b.v[k]));
      }
      case "index": {
        const b = evalExpr(x.x, scope);
        const k = evalExpr(x.idx, scope).v;
        if (isMat(b.t)) return V(b.t === "mat3" ? "vec3" : "vec4", b.v[k].slice());
        return V(b.t.startsWith("i") ? "int" : "float", b.v[k]);
      }
      case "un": {
        const v = evalExpr(x.x, scope);
        if (x.op === "!") return V("bool", !v.v);
        if (typeof v.v === "number") return V(v.t, v.t === "int" ? -v.v : f(-v.v));
        if (isMat(v.t)) return V(v.t, v.v.map((col) => col.map((c) => f(-c))));
        return V(v.t, v.v.map((c) => f(-c)));
      }
      case "bin": {
        if (x.op === "&&") return V("bool", evalExpr(x.l, scope).v && evalExpr(x.r, scope).v);
        if (x.op === "||") return V("bool", evalExpr(x.l, scope).v || evalExpr(x.r, scope).v);
        const a = evalExpr(x.l, scope), b = evalExpr(x.r, scope);
        if (["==", "!=", "<", ">", "<=", ">="].includes(x.op) && (!isScalarT(a.t) || !isScalarT(b.t))) throw new Error(`comparison ${x.op} of ${a.t} / ${b.t} unsupported`);
        switch (x.op) {
          case "==": return V("bool", a.v === b.v);
          case "!=": return V("bool", a.v !== b.v);
          case "<": return V("bool", a.v < b.v);
          case ">": return V("bool", a.v > b.v);
          case "<=": return V("bool", a.v <= b.v);
          case ">=": return V("bool", a.v >= b.v);
          default: return arith(x.op, a, b);
        }
      }
      case "ternary": return evalExpr(evalExpr(x.c, scope).v ? x.a : x.b, scope);
      case "assign": {
        let val = evalExpr(x.value, scope);
        if (x.op !== "=") val = arith(x.op[0], evalExpr(x.target, scope), val);
        store(x.target, val, scope);
        return val;
      }
      case "call": {
        const args = x.args.map((a) => evalExpr(a, scope));
        const fns = ast.funcs.get(x.name);
        if (fns) return callFn(pickOverload(x.name, fns, args), args);
        const b = builtins[x.name];
        if (!b) throw new Error(`unknown function ${x.name}`);
        calls.set(x.name, (calls.get(x.name) || 0) + 1);
        return b(args);
      }
      default: throw new Error(`expr ${x.e}`);
    }
  }
  function pickOverload(name, fns, args) {
    // GLSL ES 3.00: no implicit conversion at a call, the parameter types match exactly
    const fit = fns.filter((fn) => fn.params.length === args.length && fn.params.every((p, k) => p.type === args[k].t));
    if (fit.length !== 1) throw new Error(`${fit.length} overloads of ${name}(${args.map((a) => a.t).join(", ")})`);
    return fit[0];
  }
  function store(target, val, scope) {
    if (target.e === "id") { lookup(scope, target.name).set(target.name, copy(val)); return; }
    if (target.e === "member" && target.x.e === "id") {
      // a swizzle store: vColor.rgb *= color
      const cur = lookup(scope, target.x.name).get(target.x.name);
      const idx = [...target.name].map((ch) => { if (!(ch in SW)) throw new Error(`swizzle ${target.name}`); return SW[ch]; });
      if (!isVec(cur.t) || new Set(idx).size !== idx.length) throw new Error(`unsupported swizzle store .${target.name} of ${cur.t}`);
      const comps2 = typeof val.v === "number" ? idx.map(() => val.v) : val.v;
      if (comps2.length !== idx.length) throw new Error(`swizzle store .${target.name}: ${comps2.length} components`);
      idx.forEach((k, q) => { cur.v[k] = comps2[q]; });
      return;
    }
    if (target.e === "index") {
      const k = evalExpr(target.idx, scope).v;
      if (target.x.e === "id") {
        const box = lookup(scope, target.x.name);
        const cur = box.get(target.x.name);
        if (isMat(cur.t)) cur.v[k] = val.v.slice(); else cur.v[k] = val.v;
        return;
      }
      if (target.x.e === "index" && target.x.x.e === "id") {
        const box = lookup(scope, target.x.x.name);
        const cur = box.get(target.x.x.name);
        cur.v[evalExpr(target.x.idx, scope).v][k] = val.v;
        return;
      }
    }
    throw new Error(`unsupported assignment target ${target.e}`);
  }
  function exec(st, scope) {
    switch (st.s) {
      case "block": {
        const inner = { vars: new Map(), parent: scope };
        for (const s of st.stmts) { const r = exec(s, inner); if (r instanceof Ret) return r; }
        return undefined;
      }
      case "decl": scope.vars.set(st.name, st.init ? copy(evalExpr(st.init, scope)) : zero(st.type)); return undefined;
      case "decls": for (const d of st.decls) exec(d, scope); return undefined;
      case "expr": evalExpr(st.e, scope); return undefined;
      case "if": {
        if (evalExpr(st.cond, scope).v) return exec(st.then, scope);
        return st.els ? exec(st.els, scope) : undefined;
      }
      case "return": return new Ret(st.e ? evalExpr(st.e, scope) : null);
      default: throw new Error(`stmt ${st.s}`);
    }
  }
  function callFn(fn, args) {
    const scope = { vars: new Map(), parent: null };
    fn.params.forEach((p, k) => scope.vars.set(p.name, copy(args[k])));
    const r = exec(fn.body, scope);
    return r instanceof Ret ? r.v : null;
  }
  function initGlobals(e) {
    env = e;
    globals = new Map();
    globals.set("gl_Position", zero("vec4"));
    for (const g of ast.globals) {
      if (g.type === "sampler2D") {
        const tex = e.textures && e.textures[g.name];
        if (!tex) throw new Error(`no texture bound to ${g.name}`);
        globals.set(g.name, V("sampler2D", tex));
      } else if (g.quals.includes("in") && e.attributes && g.name in e.attributes) {
        globals.set(g.name, toValue(g.type, e.attributes[g.name]));
      } else if (g.quals.includes("uniform") && e.uniforms && g.name in e.uniforms) {
        globals.set(g.name, toValue(g.type, e.uniforms[g.name]));
      } else if (g.init) {
        globals.set(g.name, copy(evalExpr(g.init, null)));
      } else globals.set(g.name, zero(g.type));
    }
  }
  return {
    ast,
    calls,
    run(entry, e) {
      initGlobals(e);
      const fns = ast.funcs.get(entry);
      if (!fns || fns.length !== 1) throw new Error(`no single ${entry}()`);
      callFn(fns[0], []);
      return globals;
    },
    fromValue,
  };
}

/**
 * Compile the header for one define set. Returns `run(env)` →
 * `{ m: Float32Array(16) column-major hbGpIm, c: [3] hbGpIc }`, where `env` =
 * `{ instanceColor: [r, g, b], textures: { uGpRec: { data, width }, uGpRow: { data, width } } }`.
 * `opts.builtins` replaces builtins (see compileProgram); `run.calls` counts
 * the builtin calls made so far.
 */
export function compileGpHeader(header, { fxColor = false, fxMotion = false, builtins = null } = {}) {
  const defines = ["USE_INSTANCING", "USE_INSTANCING_COLOR"];
  if (fxColor) defines.push("HB_GP_FXCOLOR");
  if (fxMotion) defines.push("HB_FX_MOTION");
  const P = compileProgram(header, defines, { builtins });
  if (!P.ast.funcs.has("hbGpEval")) throw new Error("no hbGpEval");
  const run = function run(e) {
    const g = P.run("hbGpEval", e);
    const im = g.get("hbGpIm"), ic = g.get("hbGpIc");
    return { m: Float32Array.from(im.v.flat()), c: ic.v.slice() };
  };
  run.calls = P.calls;
  return run;
}

/**
 * Compile a WHOLE vertex (or fragment) program as the GL receives it (its own
 * #version / #define prefix; no defines injected). Returns `run(env)` →
 * `{ get(name) }`: a global after main() (gl_Position, varyings) as a number /
 * bool / array (matrices column-major). `env` as compileProgram's. `run.calls`
 * counts the builtin calls made so far.
 */
export function compileGlslProgram(src, { builtins = null } = {}) {
  const P = compileProgram(src, [], { builtins });
  const run = function run(e) {
    const g = P.run("main", e);
    return { get: (name) => { if (!g.has(name)) throw new Error(`no global ${name}`); return fromValue(g.get(name)); } };
  };
  run.calls = P.calls;
  return run;
}

// ------------------------------------------------------------------ driver trig

/**
 * SwiftShader's sin / cos (src/Pipeline/ShaderCore.cpp `Sin` / `Cos` / `Sin5`,
 * google/swiftshader master, read 2026-10-31): mirror into [-1/4, 1/4] turns,
 * then an order-5 polynomial for sin(2 pi x), exact at 0, pi/6, pi/3, pi/2
 * (C = (47 - 9 sqrt 3) / 5 = 6.28240 vs 2 pi = 6.28319: 1.3e-4 relative near
 * 0, 1.9e-4 absolute worst, inside Vulkan's 2^-11). The 2026-10-31 smoke
 * (ANGLE / SwiftShader Vulkan) read back exactly what this model gives. f32 per
 * operation, MulAdd unfused (fusing changes no verdict).
 */
const SS_A = f((36288 - 20736 * Math.sqrt(3)) / 5), SS_B = f(288 * Math.sqrt(3) - 540), SS_C = f((47 - 9 * Math.sqrt(3)) / 5);
const SS_PI2 = f(1 / (2 * 3.1415926535)), SS_Q = f(0.25);
const ssRound = (x) => { const r = Math.round(x); return Math.abs(x % 1) === 0.5 ? 2 * Math.round(x / 2) : r; }; // round half to even
const ssSin5 = (z) => { const z2 = f(z * z); return f(f(f(f(f(SS_A * z2) + SS_B) * z2) + SS_C) * z); };
export function swiftShaderSin(x) {
  x = f(x);
  const x2 = f(f(x * -SS_PI2) + SS_Q);
  return ssSin5(f(SS_Q - Math.abs(f(x2 - ssRound(x2)))));
}
export function swiftShaderCos(x) {
  x = f(x);
  const x2 = f(x * SS_PI2);
  return ssSin5(f(SS_Q - Math.abs(f(x2 - ssRound(x2)))));
}
export const SWIFTSHADER_TRIG = Object.freeze({
  sin: ([x]) => V("float", swiftShaderSin(x.v)),
  cos: ([x]) => V("float", swiftShaderCos(x.v)),
});
