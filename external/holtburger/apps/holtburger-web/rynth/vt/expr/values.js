// rynth/vt/expr/values.js — the VTank/UB expression value model (PLAN §3.2,
// §3.4). Leaf module: no imports, no side effects.
//
// A Value is one of
//   number | string | boolean | null (None)
//   { t: "list", items: Value[] }            REFERENCE (UB semantics)
//   { t: "dict", map: Map<string, Value> }   REFERENCE, case-sensitive keys
//   { t: "wobj", guid, name }
//   { t: "coords", ns, ew, z }               map degrees; z in nav units (m/240)
//   { t: "sw", startMs, accMs }              stopwatch (reference)
//   { t: "err", msg }                        evaluation error (never thrown)
//
// Coercion rules (pinned by tests/rynth_vt_expr.test.mjs):
//   truthy:  false for None, "", 0, "0", "false" (any case), Bool false, an
//            empty list and Err; everything else is true (Q9).
//   toStr:   Bool "1"/"0"; numbers like .NET "G" (shortest round-trip, upper
//            case E, exponent form outside 1e-5 .. 1e15); None "".
//   equals:  numeric when both sides parse as numbers (after trim), Bool vs
//            Number uses 1/0, wobj vs wobj by guid, None is 0 against a
//            number/Bool (the `finder[]==0` "not found" idiom) and "" against
//            text, else case-insensitive string compare (G:147).

export const V = Object.freeze({
  none: null,
  num: (n) => Number(n),
  str: (s) => (s == null ? "" : String(s)),
  bool: (b) => !!b,
  list: (items = []) => ({ t: "list", items: Array.isArray(items) ? items : [] }),
  dict: (src = null) => ({ t: "dict", map: toMap(src) }),
  wobj: (guid, name = "") => ({ t: "wobj", guid: Number(guid) >>> 0, name: name == null ? "" : String(name) }),
  coords: (ns, ew, z = 0) => ({ t: "coords", ns: Number(ns) || 0, ew: Number(ew) || 0, z: Number(z) || 0 }),
  sw: () => ({ t: "sw", startMs: null, accMs: 0 }),
  err: (msg) => ({ t: "err", msg: String(msg) }),
});

function toMap(src) {
  if (src instanceof Map) return src;
  const m = new Map();
  if (Array.isArray(src)) {
    for (const [k, v] of src) m.set(String(k), v);
  } else if (src && typeof src === "object") {
    for (const k of Object.keys(src)) m.set(k, src[k]);
  }
  return m;
}

function tagOf(v) {
  return v !== null && typeof v === "object" ? v.t : undefined;
}

export function isErr(v) {
  return tagOf(v) === "err";
}
export function isList(v) {
  return tagOf(v) === "list";
}
export function isDict(v) {
  return tagOf(v) === "dict";
}
export function isWobj(v) {
  return tagOf(v) === "wobj";
}
export function isCoords(v) {
  return tagOf(v) === "coords";
}
export function isSw(v) {
  return tagOf(v) === "sw";
}

// ── numbers ──────────────────────────────────────────────────────────────

const DEC_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
const HEX_RE = /^([+-]?)0x([0-9a-f]+)$/i;

// Strict numeric parse of a string (after trim): decimal (optional exponent,
// like .NET NumberStyles.Float) or 0x hex. Returns null when not a number.
export function parseNumber(s) {
  if (typeof s !== "string") return null;
  const t = s.trim();
  if (t === "") return null;
  if (DEC_RE.test(t)) return Number(t);
  const h = HEX_RE.exec(t);
  if (h) {
    const n = parseInt(h[2], 16);
    return h[1] === "-" ? -n : n;
  }
  return null;
}

// Numeric view of a value, or null when it has none (used by `+` and `==`).
export function numericOf(v) {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") return parseNumber(v);
  return null;
}

// Numeric coercion for arithmetic/comparison operators: non-numeric → 0.
export function toNum(v) {
  const n = numericOf(v);
  return n === null ? 0 : n;
}

// .NET double.ToString("G", InvariantCulture) (.NET Core 3.0+: shortest
// round-trip digits; fixed notation when the decimal exponent is in
// (-5, 15), otherwise d.dddE+XX with at least two exponent digits).
export function formatNumber(n) {
  if (typeof n !== "number") n = Number(n);
  if (Number.isNaN(n)) return "NaN";
  if (n === Infinity) return "Infinity";
  if (n === -Infinity) return "-Infinity";
  if (n === 0) return "0"; // also -0 (UB prints 0)
  const exp = n.toExponential(); // shortest round-trip mantissa
  const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(exp);
  if (!m) return String(n);
  const e = Number(m[4]);
  if (e > -5 && e < 15) return String(n); // JS is fixed-point in this range
  const mant = m[3] ? `${m[2]}.${m[3]}` : m[2];
  const ae = Math.abs(e);
  return `${m[1]}${mant}E${e < 0 ? "-" : "+"}${ae < 10 ? "0" : ""}${ae}`;
}

// ── strings ──────────────────────────────────────────────────────────────

function hex8(n) {
  return (Number(n) >>> 0).toString(16).toUpperCase().padStart(8, "0");
}

function fixed2(n) {
  const s = (Number(n) || 0).toFixed(2);
  return s === "-0.00" ? "0.00" : s;
}

export function coordsToString(c) {
  const ns = Number(c.ns) || 0;
  const ew = Number(c.ew) || 0;
  const nsS = ns >= 0 ? `${fixed2(ns)}N` : `${fixed2(-ns)}S`;
  const ewS = ew >= 0 ? `${fixed2(ew)}E` : `${fixed2(-ew)}W`;
  return `${nsS}, ${ewS}, ${fixed2(Number(c.z) || 0)}Z`;
}

export function toStr(v, _depth = 0) {
  if (v === null || v === undefined) return "";
  switch (typeof v) {
    case "string":
      return v;
    case "number":
      return formatNumber(v);
    case "boolean":
      return v ? "1" : "0";
    default:
      break;
  }
  if (_depth > 16) return "...";
  switch (v.t) {
    case "list":
      return `[${v.items.map((x) => toStr(x, _depth + 1)).join(",")}]`;
    case "dict": {
      const parts = [];
      for (const [k, x] of v.map) parts.push(`${k}=>${toStr(x, _depth + 1)}`);
      return `{${parts.join(",")}}`;
    }
    case "wobj":
      return `[WorldObject] 0x${hex8(v.guid)}: ${v.name ?? ""}`;
    case "coords":
      return coordsToString(v);
    case "sw":
      return "[Stopwatch]";
    case "err":
      return `ERR: ${v.msg}`;
    default:
      return String(v);
  }
}

export function typeName(v) {
  if (v === null || v === undefined) return "None";
  switch (typeof v) {
    case "number":
      return "Number";
    case "string":
      return "String";
    case "boolean":
      return "Boolean";
    default:
      break;
  }
  switch (v.t) {
    case "list":
      return "List";
    case "dict":
      return "Dictionary";
    case "wobj":
      return "WorldObject";
    case "coords":
      return "Coordinates";
    case "sw":
      return "Stopwatch";
    case "err":
      return "Error";
    default:
      return "Unknown";
  }
}

// ── truthiness / equality ────────────────────────────────────────────────

export function truthy(v) {
  if (v === null || v === undefined) return false;
  switch (typeof v) {
    case "boolean":
      return v;
    case "number":
      return v !== 0;
    case "string":
      return v !== "" && v !== "0" && v.toLowerCase() !== "false";
    default:
      break;
  }
  if (v.t === "err") return false;
  if (v.t === "list") return v.items.length > 0;
  return true;
}

// Boolean view of a string for Bool-vs-String equality ("true"/"false" any
// case, else numeric); null when the string is neither.
function boolNumOfString(s) {
  const t = s.trim().toLowerCase();
  if (t === "true") return 1;
  if (t === "false") return 0;
  return parseNumber(t);
}

export function equals(a, b) {
  if (a === undefined) a = null;
  if (b === undefined) b = null;
  if (isErr(a) || isErr(b)) return false;
  const ta = tagOf(a);
  const tb = tagOf(b);
  if (ta === "wobj" || tb === "wobj") {
    if (ta === "wobj" && tb === "wobj") return a.guid === b.guid;
    const w = ta === "wobj" ? a : b;
    const o = ta === "wobj" ? b : a;
    const n = numericOf(o);
    if (n !== null) return n === w.guid;
    return toStr(w).toLowerCase() === toStr(o).toLowerCase();
  }
  if (ta === "coords" && tb === "coords") return a.ns === b.ns && a.ew === b.ew && a.z === b.z;
  if (ta !== undefined && ta === tb && (ta === "list" || ta === "dict" || ta === "sw") && a === b) return true;
  // None (null) is 0 against a number / Bool / numeric string and "" against
  // other text: CMD's finders return None for "not found" where RynthAi/UB
  // returned 0, and metas test that with `==0` (corpus ColRings
  // `wobjectfindnearestbytemplatetype[34441]==0`, blodetetdict3
  // `wobjectgetselection[]!=0`; C# ExpressionReference "== 0 → true if none").
  if (a === null || b === null) {
    const o = a === null ? b : a;
    if (o === null) return true;
    if (typeof o === "boolean") return o === false;
    const n = numericOf(o);
    if (n !== null) return n === 0;
    return toStr(o) === "";
  }
  if (typeof a === "boolean" || typeof b === "boolean") {
    const bv = typeof a === "boolean" ? a : b;
    const o = typeof a === "boolean" ? b : a;
    if (typeof o === "boolean") return o === bv;
    const n = typeof o === "string" ? boolNumOfString(o) : numericOf(o);
    if (n !== null) return n === (bv ? 1 : 0);
    return toStr(o).toLowerCase() === (bv ? "1" : "0");
  }
  const na = numericOf(a);
  const nb = numericOf(b);
  if (na !== null && nb !== null) return na === nb;
  return toStr(a).toLowerCase() === toStr(b).toLowerCase();
}

// ── logging helper (C3: identical messages rate-limited to one per 10 s) ──

export function makeLog(log, now = Date.now, prefix = "[vt:expr]") {
  const base = typeof log === "function" ? log : (m) => console.log(`${prefix} ${m}`);
  const seen = new Map();
  return (msg) => {
    const m = String(msg);
    let t = 0;
    try {
      t = Number(now()) || 0;
    } catch {
      t = 0;
    }
    const last = seen.get(m);
    if (last !== undefined && t - last < 10_000) return;
    if (seen.size > 256) seen.clear();
    seen.set(m, t);
    try {
      base(m);
    } catch {
      /* a broken logger must never break evaluation */
    }
  };
}
