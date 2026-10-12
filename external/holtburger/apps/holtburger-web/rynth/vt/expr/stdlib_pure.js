// rynth/vt/expr/stdlib_pure.js — the pure meta/monster function library
// (PLAN §3.4, U5 §5.6 groups A-F, G-T, H-T). Host-backed functions (world
// objects, character, actions, chat, quests, fellowship, settings) are
// registered by CMD (cmd/stdlib_host.js); vtgetmetastate & co and the ui*
// view functions by META. Nothing here touches the host or the clock except
// through call.now() (the runtime's injected clock).
//
// Reference semantics (UB, U5 §5.2): lists and dicts are objects; listadd,
// listinsert, listremove, listremoveat, listpop, listclear, dictadditem,
// dictremovekey and dictclear MUTATE their argument and return it (corpus
// lum / blodetetdict3 / missingLegendaries rely on this); listcopy,
// listreverse, listfilter, listmap, listsort, dictkeys, dictvalues and
// dictcopy return new objects. Templates bind $0 (index), $1 (item) and $2
// (accumulator / right item) in a CHILD scope via call.evalText.
//
// Missing-value conventions follow RynthAi/UB: getvar/getpvar/getgvar of a
// missing name → 0; a list/dict accessor on a non-list/dict → 0, -1, "" or
// None like the C# reference; arity misuse is an evaluation error.

import { V, truthy, toStr, toNum, equals, isErr, formatNumber, parseNumber, coordsToString } from "./values.js";
import { getRegex } from "./regex.js";
import { templateArg } from "./evaluator.js";

const LIST_RANGE_MAX = 100_000;

// ── small helpers ───────────────────────────────────────────────────────

function asList(v) {
  return v !== null && typeof v === "object" && v.t === "list" ? v : null;
}
function asDict(v) {
  return v !== null && typeof v === "object" && v.t === "dict" ? v : null;
}
function asSw(v) {
  return v !== null && typeof v === "object" && v.t === "sw" ? v : null;
}
function int(v) {
  const n = Math.trunc(toNum(v));
  return Number.isFinite(n) ? n : 0;
}
function name0(args) {
  return toStr(args[0]).trim();
}
function fmtNum(n) {
  return n === 0 ? 0 : n; // never -0
}

// A literal-ish lazy argument (formats like `yyyy-MM-dd`, `0.00`, `N3`):
// a backtick literal's content; a dynamic argument ($var, call, …) is
// evaluated; anything else is taken as raw text (C# Tmpl).
function literalArg(call, args, i) {
  const raw = String(call.raw[i] ?? "");
  if (raw.length >= 2 && raw[0] === "`" && raw[raw.length - 1] === "`") return templateArg(call, i);
  if (/[$[`]/.test(raw) && typeof args[i] === "function") {
    const v = args[i]();
    return isErr(v) ? v : toStr(v);
  }
  return raw;
}

// ── .NET numeric format subset (cstrf) ─────────────────────────────────

function groupThousands(intDigits) {
  return intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function fixedAbs(n, d) {
  const a = Math.abs(n);
  if (a >= 1e21) return formatNumber(a);
  return a.toFixed(d);
}

function signed(n, body) {
  return n < 0 && /[1-9]/.test(body) ? `-${body}` : body;
}

function formatCustom(n, fmt) {
  const first = fmt.search(/[0#]/);
  let last = -1;
  for (let i = fmt.length - 1; i >= 0; i--) {
    if (fmt[i] === "0" || fmt[i] === "#") {
      last = i;
      break;
    }
  }
  if (first < 0) return null;
  const prefix = fmt.slice(0, first);
  const suffix = fmt.slice(last + 1);
  const body = fmt.slice(first, last + 1);
  const pct = (prefix + suffix).includes("%");
  const dot = body.indexOf(".");
  const intPat = dot >= 0 ? body.slice(0, dot) : body;
  const fracPat = dot >= 0 ? body.slice(dot + 1) : "";
  const minInt = (intPat.match(/0/g) || []).length;
  const minDec = (fracPat.match(/0/g) || []).length;
  const maxDec = minDec + (fracPat.match(/#/g) || []).length;
  const grouping = intPat.includes(",");
  const v = pct ? n * 100 : n;
  const fixed = fixedAbs(v, maxDec);
  let [ip, fp = ""] = fixed.split(".");
  while (fp.length > minDec && fp.endsWith("0")) fp = fp.slice(0, -1);
  if (ip === "0" && minInt === 0) ip = "";
  ip = ip.padStart(minInt, "0");
  if (grouping) ip = groupThousands(ip);
  const num = fp ? `${ip}.${fp}` : ip;
  const neg = v < 0 && /[1-9]/.test(num);
  return `${neg ? "-" : ""}${prefix}${num}${suffix}`; // .NET puts the sign before a literal prefix
}

export function formatDotNet(n, fmt) {
  const x = Number(n);
  const f = String(fmt ?? "").trim();
  if (!Number.isFinite(x)) return formatNumber(x);
  let m;
  if (f === "" || /^[gGrR]$/.test(f)) return formatNumber(x);
  if ((m = /^[gG](\d{1,2})$/.exec(f))) {
    const p = Math.max(1, Number(m[1]));
    const e = x === 0 ? 0 : Math.floor(Math.log10(Math.abs(x)));
    if (e >= -5 && e < p) return formatNumber(Number(x.toPrecision(p)));
    const [mant, ex] = x.toExponential(p - 1).split("e");
    const mt = mant.includes(".") ? mant.replace(/0+$/, "").replace(/\.$/, "") : mant;
    const ev = Number(ex);
    return `${mt}E${ev < 0 ? "-" : "+"}${String(Math.abs(ev)).padStart(2, "0")}`;
  }
  if ((m = /^[nN](\d{0,2})$/.exec(f))) {
    const d = m[1] === "" ? 2 : Number(m[1]);
    const [ip, fp] = fixedAbs(x, d).split(".");
    return signed(x, fp ? `${groupThousands(ip)}.${fp}` : groupThousands(ip));
  }
  if ((m = /^[fF](\d{0,2})$/.exec(f))) {
    const d = m[1] === "" ? 2 : Number(m[1]);
    return signed(x, fixedAbs(x, d));
  }
  if ((m = /^[pP](\d{0,2})$/.exec(f))) {
    const d = m[1] === "" ? 2 : Number(m[1]);
    const [ip, fp] = fixedAbs(x * 100, d).split(".");
    return signed(x, `${fp ? `${groupThousands(ip)}.${fp}` : groupThousands(ip)} %`);
  }
  if ((m = /^([eE])(\d{0,2})$/.exec(f))) {
    const d = m[2] === "" ? 6 : Number(m[2]);
    const [mant, ex] = Math.abs(x).toExponential(d).split("e");
    const ev = Number(ex);
    return signed(x, `${mant}${m[1]}${ev < 0 ? "-" : "+"}${String(Math.abs(ev)).padStart(3, "0")}`);
  }
  if (/[0#]/.test(f)) {
    const r = formatCustom(x, f);
    if (r !== null) return r;
  }
  return formatNumber(x); // C#: FormatException → "G"
}

// ── .NET DateTime format subset (getdatetimelocal / getdatetimeutc) ──────

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const STANDARD = {
  d: "MM/dd/yyyy",
  D: "dddd, dd MMMM yyyy",
  f: "dddd, dd MMMM yyyy HH:mm",
  F: "dddd, dd MMMM yyyy HH:mm:ss",
  g: "MM/dd/yyyy HH:mm",
  G: "MM/dd/yyyy HH:mm:ss",
  m: "MMMM dd",
  M: "MMMM dd",
  s: "yyyy'-'MM'-'dd'T'HH':'mm':'ss",
  t: "HH:mm",
  T: "HH:mm:ss",
  u: "yyyy'-'MM'-'dd HH':'mm':'ss'Z'",
  y: "yyyy MMMM",
  Y: "yyyy MMMM",
};

function pad(n, w) {
  return String(Math.trunc(Math.abs(n))).padStart(w, "0");
}

export function formatDateDotNet(ms, fmt, utc) {
  const d = new Date(Number(ms) || 0);
  const g = utc
    ? { y: d.getUTCFullYear(), M: d.getUTCMonth(), d: d.getUTCDate(), w: d.getUTCDay(), H: d.getUTCHours(), m: d.getUTCMinutes(), s: d.getUTCSeconds(), f: d.getUTCMilliseconds() }
    : { y: d.getFullYear(), M: d.getMonth(), d: d.getDate(), w: d.getDay(), H: d.getHours(), m: d.getMinutes(), s: d.getSeconds(), f: d.getMilliseconds() };
  let f = String(fmt ?? "");
  if (f === "") f = STANDARD.G;
  else if (f.length === 1 && STANDARD[f]) f = STANDARD[f];
  else if (f === "o" || f === "O") return utc ? d.toISOString().replace("Z", "0000Z") : d.toISOString();
  else if (f.length === 2 && f[0] === "%") f = f[1];
  const offMin = utc ? 0 : -d.getTimezoneOffset();
  let out = "";
  for (let i = 0; i < f.length; ) {
    const c = f[i];
    if (c === "'" || c === '"') {
      const j = f.indexOf(c, i + 1);
      out += j < 0 ? f.slice(i + 1) : f.slice(i + 1, j);
      i = j < 0 ? f.length : j + 1;
      continue;
    }
    if (c === "\\") {
      out += f[i + 1] ?? "";
      i += 2;
      continue;
    }
    let n = 1;
    while (f[i + n] === c) n++;
    const h12 = g.H % 12 === 0 ? 12 : g.H % 12;
    switch (c) {
      case "y":
        out += n === 2 ? pad(g.y % 100, 2) : n === 1 ? String(g.y % 100) : pad(g.y, n);
        break;
      case "M":
        out += n >= 4 ? MONTHS[g.M] : n === 3 ? MONTHS[g.M].slice(0, 3) : n === 2 ? pad(g.M + 1, 2) : String(g.M + 1);
        break;
      case "d":
        out += n >= 4 ? DAYS[g.w] : n === 3 ? DAYS[g.w].slice(0, 3) : n === 2 ? pad(g.d, 2) : String(g.d);
        break;
      case "H":
        out += n >= 2 ? pad(g.H, 2) : String(g.H);
        break;
      case "h":
        out += n >= 2 ? pad(h12, 2) : String(h12);
        break;
      case "m":
        out += n >= 2 ? pad(g.m, 2) : String(g.m);
        break;
      case "s":
        out += n >= 2 ? pad(g.s, 2) : String(g.s);
        break;
      case "f":
      case "F": {
        let digits = pad(g.f, 3).padEnd(Math.max(3, n), "0").slice(0, n);
        if (c === "F") digits = digits.replace(/0+$/, "");
        out += digits;
        break;
      }
      case "t":
        out += n >= 2 ? (g.H < 12 ? "AM" : "PM") : g.H < 12 ? "A" : "P";
        break;
      case "z": {
        const sign = offMin < 0 ? "-" : "+";
        const oh = Math.floor(Math.abs(offMin) / 60);
        const om = Math.abs(offMin) % 60;
        out += n === 1 ? `${sign}${oh}` : n === 2 ? `${sign}${pad(oh, 2)}` : `${sign}${pad(oh, 2)}:${pad(om, 2)}`;
        break;
      }
      case "K":
        out += utc ? "Z" : `${offMin < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(offMin) / 60), 2)}:${pad(Math.abs(offMin) % 60, 2)}`;
        break;
      default:
        out += c.repeat(n);
    }
    i += n;
  }
  return out;
}

// ── coordinates ─────────────────────────────────────────────────────────

const COORD_RE = /(\d{1,3}(?:\.\d+)?)\s*([ns])[\s,]*(\d{1,3}(?:\.\d+)?)\s*([ew])(?:[\s,]*(-?\d+(?:\.\d*)?|-?\.\d+)\s*z)?/i;

// "41.53N, 34.46E[, 0.47Z]" (UB display form) or the RynthAi object string
// "NS|EW|Z" (full precision) → coords Value, else null.
export function parseCoordText(text) {
  const s = String(text ?? "").trim();
  if (s.includes("|")) {
    const parts = s.split("|");
    const ns = parseNumber(parts[0]);
    const ew = parseNumber(parts[1]);
    const z = parts.length > 2 ? parseNumber(parts[2]) : 0;
    if (ns !== null && ew !== null && z !== null) return V.coords(ns, ew, z);
  }
  const m = COORD_RE.exec(s);
  if (!m) return null;
  const ns = Number(m[1]) * (m[2].toLowerCase() === "n" ? 1 : -1);
  const ew = Number(m[3]) * (m[4].toLowerCase() === "e" ? 1 : -1);
  const z = m[5] !== undefined ? Number(m[5]) : 0;
  return V.coords(ns, ew, z);
}

function coordsOf(v) {
  if (v !== null && typeof v === "object" && v.t === "coords") return v;
  if (typeof v === "string") return parseCoordText(v);
  return null;
}

// ── stopwatches ─────────────────────────────────────────────────────────

function swElapsedMs(sw, now) {
  return sw.accMs + (sw.startMs === null ? 0 : Math.max(0, now - sw.startMs));
}

// ── variables ($0/$1/$2 template scope aware for the session kind) ──────

function varFns(kind, prefix, getName) {
  const has = (call, n) => (kind === "session" ? call.rt.hasVar(n, call.scope) : call.rt.vars.has(kind, n));
  const get = (call, n) => {
    if (kind === "session") return call.rt.getVar(n, call.scope);
    const v = call.rt.vars.get(kind, n);
    return v === undefined ? 0 : v;
  };
  const set = (call, n, v) => (kind === "session" ? call.rt.setVar(n, v, call.scope) : call.rt.vars.set(kind, n, v));
  const fns = [
    [`set${prefix}`, (args, call) => set(call, getName(args), args[1] ?? ""), { minArgs: 2, maxArgs: 2 }],
    [`get${prefix}`, (args, call) => get(call, getName(args)), { minArgs: 1, maxArgs: 1 }],
    [`test${prefix}`, (args, call) => has(call, getName(args)), { minArgs: 1, maxArgs: 1 }],
    [
      `touch${prefix}`,
      (args, call) => {
        const n = getName(args);
        if (has(call, n)) return true;
        set(call, n, 0);
        return false;
      },
      { minArgs: 1, maxArgs: 1 },
    ],
    [`clear${prefix}`, (args, call) => call.rt.vars.clear(kind, getName(args)), { minArgs: 1, maxArgs: 1 }],
    [
      `clearall${prefix}s`,
      (_args, call) => {
        call.rt.vars.clearAll(kind);
        return true;
      },
      { maxArgs: 0 },
    ],
  ];
  return fns;
}

// ── list helpers ────────────────────────────────────────────────────────

function indexOfItem(items, item, fromEnd = false) {
  if (fromEnd) {
    for (let i = items.length - 1; i >= 0; i--) if (equals(items[i], item)) return i;
    return -1;
  }
  for (let i = 0; i < items.length; i++) if (equals(items[i], item)) return i;
  return -1;
}

function defaultCompare(a, b) {
  const na = typeof a === "number" ? a : parseNumber(typeof a === "string" ? a : "");
  const nb = typeof b === "number" ? b : parseNumber(typeof b === "string" ? b : "");
  if (na !== null && nb !== null) return na - nb;
  const sa = toStr(a);
  const sb = toStr(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

// ── the table ───────────────────────────────────────────────────────────

const lazy = (o = {}) => ({ ...o, lazy: true });
const m1 = (fn) => (args) => fmtNum(fn(toNum(args[0])));

const PURE = [
  // A. control / dynamic
  ["iif", (a) => (truthy(a[0]()) ? a[1]() : a.length > 2 ? a[2]() : ""), lazy({ minArgs: 2, maxArgs: 3 })],
  ["if", (a) => (truthy(a[0]()) ? a[1]() : a.length > 2 ? a[2]() : ""), lazy({ minArgs: 2, maxArgs: 3 })],
  [
    "ifthen",
    (a, call) => {
      const chosen = truthy(a[0]()) ? a[1]() : a.length > 2 ? a[2]() : "";
      const text = toStr(chosen);
      return text.trim() === "" ? "" : call.evalText(text);
    },
    lazy({ minArgs: 2, maxArgs: 3 }),
  ],
  [
    "exec",
    (a, call) => {
      const text = toStr(a[0]);
      return text.trim() === "" ? "" : call.evalText(text);
    },
    { minArgs: 1, maxArgs: 1 },
  ],
  [
    "delayexec",
    (a, call) => {
      call.rt.delay(toNum(a[0]), toStr(a[1]));
      return 1;
    },
    { minArgs: 2, maxArgs: 2 },
  ],
  ["tostring", (a) => toStr(a[0]), { maxArgs: 1 }],
  ["cstr", (a) => toStr(a[0]), { maxArgs: 1 }],
  [
    "cstrf",
    (a, call) => {
      const fmt = literalArg(call, a, 1);
      if (isErr(fmt)) return fmt;
      const n = a[0]();
      return formatDotNet(toNum(n), fmt);
    },
    lazy({ minArgs: 2, maxArgs: 2 }),
  ],
  ["cnumber", (a) => fmtNum(toNum(a[0])), { maxArgs: 1 }],
  ["strlen", (a) => toStr(a[0]).length, { maxArgs: 1 }],
  ["ord", (a) => {
    const s = toStr(a[0]);
    return s.length ? s.charCodeAt(0) : 0;
  }, { maxArgs: 1 }],
  ["chr", (a) => {
    const c = int(a[0]);
    return c >= 0 && c <= 0xffff ? String.fromCharCode(c) : "";
  }, { maxArgs: 1 }],
  [
    "hexstr",
    (a) => {
      const n = int(a[0]);
      const b = BigInt.asUintN(64, BigInt(n));
      return `0x${b.toString(16).toUpperCase()}`;
    },
    { maxArgs: 1 },
  ],
  [
    "getregexmatch",
    (a, call) => {
      const pattern = toStr(a[1]);
      if (pattern === "") return "";
      const rx = getRegex(pattern, "i", { log: call.log });
      if (!rx) return "";
      const m = rx.exec(toStr(a[0]));
      return m ? m[0] : "";
    },
    { minArgs: 2, maxArgs: 2 },
  ],
  ["isfalse", (a) => !truthy(a[0]), { maxArgs: 1 }],
  ["istrue", (a) => truthy(a[0]), { maxArgs: 1 }],
  [
    "getobjectinternaltype",
    (a) => {
      const v = a.length ? a[0] : null;
      if (v === null || v === undefined) return 0;
      if (typeof v === "number" || typeof v === "boolean") return 1;
      if (typeof v === "string") return 3;
      if (v.t === "err") return 0;
      return 7; // list, dict, world object, coordinates, stopwatch (UB "object")
    },
    { maxArgs: 1 },
  ],
  [
    "randint",
    (a) => {
      const lo = int(a[0]);
      const hi = int(a[1]);
      if (hi <= lo) return lo;
      return lo + Math.floor(Math.random() * (hi - lo));
    },
    { minArgs: 2, maxArgs: 2 },
  ],

  // B. math
  ["floor", m1(Math.floor), { maxArgs: 1 }],
  ["ceiling", m1(Math.ceil), { maxArgs: 1 }],
  ["round", m1((x) => Math.sign(x) * Math.round(Math.abs(x))), { maxArgs: 1 }], // midpoint away from zero
  ["abs", m1(Math.abs), { maxArgs: 1 }],
  ["acos", m1(Math.acos), { maxArgs: 1 }],
  ["asin", m1(Math.asin), { maxArgs: 1 }],
  ["atan", m1(Math.atan), { maxArgs: 1 }],
  ["atan2", (a) => fmtNum(Math.atan2(toNum(a[0]), toNum(a[1]))), { minArgs: 2, maxArgs: 2 }],
  ["cos", m1(Math.cos), { maxArgs: 1 }],
  ["cosh", m1(Math.cosh), { maxArgs: 1 }],
  ["sin", m1(Math.sin), { maxArgs: 1 }],
  ["sinh", m1(Math.sinh), { maxArgs: 1 }],
  ["sqrt", m1(Math.sqrt), { maxArgs: 1 }],
  ["tan", m1(Math.tan), { maxArgs: 1 }],
  ["tanh", m1(Math.tanh), { maxArgs: 1 }],

  // C. variables (session / persistent / global)
  ...varFns("session", "var", name0),
  ...varFns("p", "pvar", name0),
  ...varFns("g", "gvar", name0),

  // D. lists (reference)
  ["listcreate", (a) => V.list(a.slice())],
  ["listadd", (a) => {
    const l = asList(a[0]);
    if (!l) return 0;
    l.items.push(a[1]);
    return l;
  }, { minArgs: 2, maxArgs: 2 }],
  ["listinsert", (a) => {
    const l = asList(a[0]);
    const i = int(a[2]);
    if (!l || i < 0 || i > l.items.length) return 0;
    l.items.splice(i, 0, a[1]);
    return l;
  }, { minArgs: 3, maxArgs: 3 }],
  ["listremove", (a) => {
    const l = asList(a[0]);
    if (!l) return 0;
    const i = indexOfItem(l.items, a[1]);
    if (i >= 0) l.items.splice(i, 1);
    return l;
  }, { minArgs: 2, maxArgs: 2 }],
  ["listremoveat", (a) => {
    const l = asList(a[0]);
    const i = int(a[1]);
    if (!l || i < 0 || i >= l.items.length) return 0;
    l.items.splice(i, 1);
    return l;
  }, { minArgs: 2, maxArgs: 2 }],
  ["listgetitem", (a) => {
    const l = asList(a[0]);
    const i = int(a[1]);
    return l && i >= 0 && i < l.items.length ? l.items[i] : null;
  }, { minArgs: 2, maxArgs: 2 }],
  ["listcontains", (a) => {
    const l = asList(a[0]);
    return !!l && indexOfItem(l.items, a[1]) >= 0;
  }, { minArgs: 2, maxArgs: 2 }],
  ["listindexof", (a) => {
    const l = asList(a[0]);
    return l ? indexOfItem(l.items, a[1]) : -1;
  }, { minArgs: 2, maxArgs: 2 }],
  ["listlastindexof", (a) => {
    const l = asList(a[0]);
    return l ? indexOfItem(l.items, a[1], true) : -1;
  }, { minArgs: 2, maxArgs: 2 }],
  ["listcopy", (a) => {
    const l = asList(a[0]);
    return V.list(l ? l.items.slice() : []);
  }, { minArgs: 1, maxArgs: 1 }],
  ["listreverse", (a) => {
    const l = asList(a[0]);
    return V.list(l ? l.items.slice().reverse() : []);
  }, { minArgs: 1, maxArgs: 1 }],
  ["listpop", (a) => {
    const l = asList(a[0]);
    if (!l || l.items.length === 0) return null;
    let i = a.length > 1 ? int(a[1]) : -1;
    if (i < 0) i += l.items.length;
    if (i < 0 || i >= l.items.length) return null;
    return l.items.splice(i, 1)[0];
  }, { minArgs: 1, maxArgs: 2 }],
  ["listcount", (a) => {
    const l = asList(a[0]);
    return l ? l.items.length : 0;
  }, { minArgs: 1, maxArgs: 1 }],
  ["listclear", (a) => {
    const l = asList(a[0]);
    if (!l) return V.list([]);
    l.items.length = 0;
    return l;
  }, { minArgs: 1, maxArgs: 1 }],
  ["listfromrange", (a) => {
    const s = int(a[0]);
    const e = int(a[1]);
    if (Math.abs(e - s) + 1 > LIST_RANGE_MAX) return V.err(`listfromrange[] would create more than ${LIST_RANGE_MAX} items`);
    const items = [];
    if (s <= e) for (let i = s; i <= e; i++) items.push(i);
    else for (let i = s; i >= e; i--) items.push(i);
    return V.list(items);
  }, { minArgs: 2, maxArgs: 2 }],
  ["listfilter", (a, call) => {
    const l = asList(a[0]());
    const tmpl = templateArg(call, 1);
    const out = [];
    if (!l || tmpl.trim() === "") return V.list(out);
    const items = l.items.slice();
    for (let i = 0; i < items.length; i++) {
      const v = call.evalText(tmpl, { 0: i, 1: items[i] });
      if (isErr(v)) return v;
      if (truthy(v)) out.push(items[i]);
    }
    return V.list(out);
  }, lazy({ minArgs: 2, maxArgs: 2 })],
  ["listmap", (a, call) => {
    const l = asList(a[0]());
    const tmpl = templateArg(call, 1);
    const out = [];
    if (!l || tmpl.trim() === "") return V.list(out);
    const items = l.items.slice();
    for (let i = 0; i < items.length; i++) {
      const v = call.evalText(tmpl, { 0: i, 1: items[i] });
      if (isErr(v)) return v;
      out.push(v);
    }
    return V.list(out);
  }, lazy({ minArgs: 2, maxArgs: 2 })],
  ["listreduce", (a, call) => {
    const l = asList(a[0]());
    const tmpl = templateArg(call, 1);
    let acc = 0;
    if (!l || tmpl.trim() === "") return acc;
    const items = l.items.slice();
    for (let i = 0; i < items.length; i++) {
      const v = call.evalText(tmpl, { 0: i, 1: items[i], 2: acc });
      if (isErr(v)) return v;
      acc = v;
    }
    return acc;
  }, lazy({ minArgs: 2, maxArgs: 2 })],
  ["listsort", (a, call) => {
    const l = asList(a[0]());
    const copy = l ? l.items.slice() : [];
    const tmpl = a.length > 1 ? templateArg(call, 1) : "";
    if (tmpl.trim() === "") return V.list(copy.sort(defaultCompare));
    let failure = null;
    copy.sort((x, y) => {
      if (failure) return 0;
      const v = call.evalText(tmpl, { 1: x, 2: y });
      if (isErr(v)) {
        failure = v;
        return 0;
      }
      const n = toNum(v);
      return Number.isNaN(n) ? 0 : n;
    });
    return failure || V.list(copy);
  }, lazy({ minArgs: 1, maxArgs: 2 })],

  // E. dictionaries (reference, case-sensitive keys)
  ["dictcreate", (a) => {
    const m = new Map();
    for (let i = 0; i + 1 < a.length; i += 2) m.set(toStr(a[i]), a[i + 1]);
    return V.dict(m);
  }],
  ["dictgetitem", (a) => {
    const d = asDict(a[0]);
    const k = toStr(a[1]);
    return d && d.map.has(k) ? d.map.get(k) : null;
  }, { minArgs: 2, maxArgs: 2 }],
  ["dictadditem", (a) => {
    const d = asDict(a[0]);
    if (!d) return false;
    const k = toStr(a[1]);
    const overwrote = d.map.has(k);
    d.map.set(k, a[2]);
    return overwrote;
  }, { minArgs: 3, maxArgs: 3 }],
  ["dicthaskey", (a) => {
    const d = asDict(a[0]);
    return !!d && d.map.has(toStr(a[1]));
  }, { minArgs: 2, maxArgs: 2 }],
  ["dictremovekey", (a) => {
    const d = asDict(a[0]);
    return !!d && d.map.delete(toStr(a[1]));
  }, { minArgs: 2, maxArgs: 2 }],
  ["dictkeys", (a) => {
    const d = asDict(a[0]);
    return V.list(d ? [...d.map.keys()] : []);
  }, { minArgs: 1, maxArgs: 1 }],
  ["dictvalues", (a) => {
    const d = asDict(a[0]);
    return V.list(d ? [...d.map.values()] : []);
  }, { minArgs: 1, maxArgs: 1 }],
  ["dictsize", (a) => {
    const d = asDict(a[0]);
    return d ? d.map.size : 0;
  }, { minArgs: 1, maxArgs: 1 }],
  ["dictclear", (a) => {
    const d = asDict(a[0]);
    if (!d) return V.dict();
    d.map.clear();
    return d;
  }, { minArgs: 1, maxArgs: 1 }],
  ["dictcopy", (a) => {
    const d = asDict(a[0]);
    return V.dict(new Map(d ? d.map : []));
  }, { minArgs: 1, maxArgs: 1 }],

  // F. stopwatches (reference; the runtime clock)
  ["stopwatchcreate", () => V.sw(), { maxArgs: 0 }],
  ["stopwatchstart", (a, call) => {
    const sw = asSw(a[0]);
    if (sw && sw.startMs === null) sw.startMs = call.now();
    return sw || a[0];
  }, { minArgs: 1, maxArgs: 1 }],
  ["stopwatchstop", (a, call) => {
    const sw = asSw(a[0]);
    if (sw && sw.startMs !== null) {
      sw.accMs = swElapsedMs(sw, call.now());
      sw.startMs = null;
    }
    return sw || a[0];
  }, { minArgs: 1, maxArgs: 1 }],
  ["stopwatchelapsedseconds", (a, call) => {
    const sw = asSw(a[0]);
    return sw ? swElapsedMs(sw, call.now()) / 1000 : 0;
  }, { minArgs: 1, maxArgs: 1 }],

  // G-T. local / UTC time (runtime clock)
  ["getdatetimelocal", (a, call) => {
    const fmt = a.length ? literalArg(call, a, 0) : "";
    return isErr(fmt) ? fmt : formatDateDotNet(call.now(), fmt, false);
  }, lazy({ maxArgs: 1 })],
  ["getdatetimeutc", (a, call) => {
    const fmt = a.length ? literalArg(call, a, 0) : "";
    return isErr(fmt) ? fmt : formatDateDotNet(call.now(), fmt, true);
  }, lazy({ maxArgs: 1 })],
  ["getunixtime", (_a, call) => Math.floor(call.now() / 1000), { maxArgs: 0 }],

  // H-T. coordinates (map degrees; distances ×240 → metres)
  ["coordinategetns", (a) => {
    const c = coordsOf(a[0]);
    return c ? c.ns : 0;
  }, { minArgs: 1, maxArgs: 1 }],
  ["coordinategetwe", (a) => {
    const c = coordsOf(a[0]);
    return c ? c.ew : 0;
  }, { minArgs: 1, maxArgs: 1 }],
  ["coordinategetz", (a) => {
    const c = coordsOf(a[0]);
    return c ? c.z : 0;
  }, { minArgs: 1, maxArgs: 1 }],
  ["coordinatetostring", (a) => {
    const c = coordsOf(a[0]);
    return c ? coordsToString(c) : "";
  }, { minArgs: 1, maxArgs: 1 }],
  // Unescaped commas split "41.53N, 34.46E" into two arguments: re-join them.
  ["coordinateparse", (a) => parseCoordText(a.map((x) => toStr(x)).join(", ")), { minArgs: 1 }],
  ["coordinatedistancewithz", (a) => {
    const p = coordsOf(a[0]);
    const q = coordsOf(a[1]);
    if (!p || !q) return 0;
    const dn = (p.ns - q.ns) * 240;
    const de = (p.ew - q.ew) * 240;
    const dz = (p.z - q.z) * 240;
    return Math.sqrt(dn * dn + de * de + dz * dz);
  }, { minArgs: 2, maxArgs: 2 }],
  ["coordinatedistanceflat", (a) => {
    const p = coordsOf(a[0]);
    const q = coordsOf(a[1]);
    if (!p || !q) return 0;
    const dn = (p.ns - q.ns) * 240;
    const de = (p.ew - q.ew) * 240;
    return Math.sqrt(dn * dn + de * de);
  }, { minArgs: 2, maxArgs: 2 }],
];

export const PURE_FUNCTION_NAMES = Object.freeze(PURE.map((row) => row[0]));

export function registerPureStdlib(registry) {
  for (const [name, impl, opts] of PURE) registry.define(name, impl, opts || {});
}
