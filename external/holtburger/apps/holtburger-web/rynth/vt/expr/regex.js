// rynth/vt/expr/regex.js — .NET → JS regex translation + an LRU cache
// (PLAN §3.4, U5 §5.7). No imports, no side effects at load.
//
// Metas are written for .NET Regex. Translation:
//   (?i) (?m) (?s) inline options        → JS flags (an option group placed
//                                          mid-pattern, or scoped (?i:…), is
//                                          applied to the whole pattern: a
//                                          documented approximation + warning)
//   (?'name'…)                           → (?<name>…)
//   duplicate (?<name>…) groups           → renamed name__2, name__3 … and MERGED
//                                          back into `groups.name` on every exec
//                                          (real corpus: BuffOnTell7s ChatCapture)
//   \A → ^      \Z, \z → $                (subjects lose their trailing "\n",
//                                          as .NET `$` matches before it)
//   (?#comment)                           → removed
//   atomic (?>…), possessive *+ ++ ?+ }+, conditionals (?(…), \G, balancing
//   groups, class subtraction [a-[b]], (?x)  → rejected (no match + one warning)
// getRegex caches 2048 translated patterns (RegexCache.MaxEntries); a bad
// pattern caches null and warns once per pattern.

const MAX_ENTRIES = 2048;
const cache = new Map(); // key → RegExp | null   (insertion order = LRU order)
const warned = new Set();
let defaultLog = (m) => console.log(`[vt:expr] ${m}`);

// RegExp subclass: strips trailing newlines from the subject and merges
// renamed duplicate named groups back under their .NET name.
class VtRegExp extends RegExp {
  constructor(source, flags, groupMap) {
    super(source, flags);
    this.vtGroupMap = groupMap && typeof groupMap === "object" ? groupMap : null;
  }
  exec(subject) {
    const s = String(subject ?? "").replace(/[\r\n]+$/, "");
    const m = super.exec(s);
    if (m && m.groups && this.vtGroupMap) {
      for (const name of Object.keys(this.vtGroupMap)) {
        const aliases = this.vtGroupMap[name];
        if (!Array.isArray(aliases) || aliases.length < 2) continue;
        if (m.groups[name] === undefined) {
          for (let i = 1; i < aliases.length; i++) {
            if (m.groups[aliases[i]] !== undefined) {
              m.groups[name] = m.groups[aliases[i]];
              break;
            }
          }
        }
        for (let i = 1; i < aliases.length; i++) delete m.groups[aliases[i]];
      }
    }
    return m;
  }
}

function addFlag(flags, f) {
  return flags.includes(f) ? flags : flags + f;
}

const QUANT_END = new Set(["*", "+", "?", "}"]);

// translateRegex(pattern) → { ok, source?, flags?, groupMap?, warning? }
export function translateRegex(pattern) {
  const p = String(pattern ?? "");
  let out = "";
  let flags = "";
  const warnings = [];
  const nameCount = new Map();
  const groupMap = {};
  let inClass = false;
  let lastWasQuant = false; // previous emitted atom was a quantifier
  const reject = (why) => ({ ok: false, warning: `unsupported .NET regex construct (${why}) in /${p}/` });
  for (let i = 0; i < p.length; ) {
    const c = p[i];
    if (c === "\\") {
      const d = p[i + 1];
      if (d === undefined) return reject("trailing backslash");
      if (!inClass) {
        if (d === "A") {
          out += "^";
          i += 2;
          lastWasQuant = false;
          continue;
        }
        if (d === "Z" || d === "z") {
          out += "$";
          i += 2;
          lastWasQuant = false;
          continue;
        }
        if (d === "G") return reject("\\G");
        if (d === "p" || d === "P") flags = addFlag(flags, "u");
      }
      out += c + d;
      i += 2;
      lastWasQuant = false;
      continue;
    }
    if (inClass) {
      if (c === "-" && p[i + 1] === "[") return reject("character class subtraction");
      if (c === "]") inClass = false;
      out += c;
      i++;
      continue;
    }
    if (c === "[") {
      inClass = true;
      out += c;
      i++;
      // a leading ']' or '^]' is literal inside a class
      if (p[i] === "^") {
        out += "^";
        i++;
      }
      if (p[i] === "]") {
        out += "\\]";
        i++;
      }
      lastWasQuant = false;
      continue;
    }
    if (c === "+" && lastWasQuant) return reject("possessive quantifier");
    if (c === "(" && p[i + 1] === "?") {
      const rest = p.slice(i + 2);
      if (rest.startsWith("#")) {
        const end = p.indexOf(")", i);
        if (end < 0) return reject("unterminated comment");
        i = end + 1;
        continue;
      }
      if (rest.startsWith(">")) return reject("atomic group");
      if (rest.startsWith("(")) return reject("conditional");
      // inline options (?imsx-imsx) or scoped (?imsx-imsx:
      const opt = /^([imnsx]*)(?:-([imnsx]*))?([:)])/.exec(rest);
      if (opt && (opt[1] || opt[2] !== undefined)) {
        const on = opt[1] || "";
        if (on.includes("x")) return reject("(?x) ignore-whitespace option");
        if (on.includes("n")) warnings.push("(?n) explicit-capture option ignored");
        if (opt[2]) warnings.push(`(?-${opt[2]}) option removal ignored`);
        for (const f of on) if (f === "i" || f === "m" || f === "s") flags = addFlag(flags, f);
        const scoped = opt[3] === ":";
        if ((scoped || i > 0) && on) warnings.push(`inline option (?${on}${scoped ? ":" : ""}) applied to the whole pattern`);
        if (scoped) out += "(?:";
        i += 2 + opt[0].length;
        lastWasQuant = false;
        continue;
      }
      // named groups: (?<name> / (?'name'  (not lookbehind (?<= (?<!)
      let nm = null;
      let consumed = 0;
      const angle = /^<([A-Za-z_][A-Za-z0-9_]*)>/.exec(rest);
      const quote = /^'([A-Za-z_][A-Za-z0-9_]*)'/.exec(rest);
      if (angle) {
        nm = angle[1];
        consumed = angle[0].length;
      } else if (quote) {
        nm = quote[1];
        consumed = quote[0].length;
      } else if (/^<[^=!]/.test(rest) || /^'/.test(rest)) {
        return reject("balancing or numbered group name");
      }
      if (nm) {
        const k = (nameCount.get(nm) || 0) + 1;
        nameCount.set(nm, k);
        const jsName = k === 1 ? nm : `${nm}__${k}`;
        if (!groupMap[nm]) groupMap[nm] = [nm];
        if (k > 1) groupMap[nm].push(jsName);
        out += `(?<${jsName}>`;
        i += 2 + consumed;
        lastWasQuant = false;
        continue;
      }
    }
    out += c;
    i++;
    if (c === "{") {
      // a {n}, {n,}, {n,m} quantifier ends at its '}'
      const q = /^\d+(?:,\d*)?\}/.exec(p.slice(i));
      if (q) {
        out += q[0];
        i += q[0].length;
        lastWasQuant = true;
        // lazy marker is fine; possessive checked on the next char
        continue;
      }
      lastWasQuant = false;
      continue;
    }
    lastWasQuant = QUANT_END.has(c) && c !== "}";
    if (c === "?" && out.length >= 2 && QUANT_END.has(out[out.length - 2])) lastWasQuant = false; // lazy `*?` etc.
  }
  if (inClass) return reject("unterminated character class");
  const dupNames = Object.keys(groupMap).filter((k) => groupMap[k].length > 1);
  const map = {};
  for (const k of dupNames) map[k] = groupMap[k];
  try {
    // eslint-disable-next-line no-new
    new RegExp(out, flags);
  } catch (e) {
    return { ok: false, warning: `invalid regex /${p}/: ${e && e.message ? e.message : e}` };
  }
  const res = { ok: true, source: out, flags, groupMap: map };
  if (warnings.length) res.warning = `${warnings.join("; ")} in /${p}/`;
  return res;
}

function warnOnce(pattern, msg, log) {
  if (warned.has(pattern)) return;
  if (warned.size > 4096) warned.clear();
  warned.add(pattern);
  try {
    (typeof log === "function" ? log : defaultLog)(msg);
  } catch {
    /* never break a match on a logger */
  }
}

// getRegex(pattern, flags = "") → RegExp | null — translated, LRU-cached; a bad
// pattern gives null (no match) and ONE warning per pattern. Optional third
// argument { log } routes that warning (ExprRuntime passes its logger).
export function getRegex(pattern, flags = "", { log } = {}) {
  const pat = String(pattern ?? "");
  const fl = String(flags ?? "");
  const key = `${fl}\u0000${pat}`;
  if (cache.has(key)) {
    const hit = cache.get(key);
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  let rx = null;
  const tr = translateRegex(pat);
  if (!tr.ok) {
    warnOnce(pat, tr.warning, log);
  } else {
    let f = tr.flags;
    for (const ch of fl) f = addFlag(f, ch);
    try {
      rx = new VtRegExp(tr.source, f, tr.groupMap);
      if (tr.warning) warnOnce(pat, tr.warning, log);
    } catch (e) {
      rx = null;
      warnOnce(pat, `invalid regex /${pat}/: ${e && e.message ? e.message : e}`, log);
    }
  }
  cache.set(key, rx);
  if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
  return rx;
}

// Test/diagnostic helpers (not part of the §3.4 barrel).
export function regexCacheSize() {
  return cache.size;
}
export function clearRegexCache() {
  cache.clear();
  warned.clear();
}
export function setRegexLog(fn) {
  if (typeof fn === "function") defaultLog = fn;
}
export const REGEX_CACHE_MAX = MAX_ENTRIES;
