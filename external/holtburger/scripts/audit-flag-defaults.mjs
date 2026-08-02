#!/usr/bin/env node
// scripts/audit-flag-defaults.mjs — 2026-08-02
//
// Reports every URL flag's ACTUAL default, derived from the reader expression
// in code — never from a docs cell and never from an in-code comment — and
// diffs that against what `apps/holtburger-web/docs/url-flags.md` claims.
//
// `docs/url-flags.md` is the ONE canonical flags doc (no parallel ledger).
// This script is the audit that keeps it honest; it writes NOTHING, it prints.
// Companion to `lint-url-flags.mjs`, which checks documented-vs-reader
// EXISTENCE; this one checks documented-vs-reader DEFAULT POLARITY, and finds
// in-code comments that contradict their own reader.
//
// The footgun it exists to kill: a reader coded `!== "off"` resolves ON when
// the param is absent — the opposite of a comment saying "default OFF". Only
// an exact match (`=== "on"` / `=== "1"`) is a real opt-in.
//
//   node scripts/audit-flag-defaults.mjs [--app apps/holtburger-web]
//                                        [--off]      only the default-OFF docket
//                                        [--mismatch] only mismatches (exit 1 if any)
//                                        [--all]      full per-flag table (TSV)
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const appIdx = argv.indexOf("--app");
const APP = appIdx >= 0 ? argv[appIdx + 1] : "apps/holtburger-web";
const ONLY_OFF = argv.includes("--off");
const ONLY_MISMATCH = argv.includes("--mismatch");
const ALL = argv.includes("--all");
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const appDir = path.join(ROOT, APP);

// ── docs table parse ────────────────────────────────────────────────────────
const docsPath = path.join(appDir, "docs", "url-flags.md");
const docsLines = fs.readFileSync(docsPath, "utf8").split("\n");
const docRows = new Map(); // name → {values, defaultCol, readerCol, effect, where, section, line}
let section = "(preamble)";
for (let i = 0; i < docsLines.length; i += 1) {
  const h = /^#{2,3}\s+(.*)$/.exec(docsLines[i]);
  if (h) { section = h[1].trim(); continue; }
  const m = /^\| `([A-Za-z_][A-Za-z0-9_]*)`(?:=[^|`]*)?\s*\|(.*)$/.exec(docsLines[i]);
  if (!m || docRows.has(m[1])) continue;
  // Split on UNESCAPED pipes only. Rows legitimately carry `\|` inside a cell
  // (`` `on`\|`off` ``); splitting on those shifts every later column left and
  // makes the Default cell read as a Values fragment — which is how an earlier
  // pass of this audit "found" four mismatches that did not exist.
  const c = m[2].split(/(?<!\\)\|/).map((x) => x.trim());
  docRows.set(m[1], {
    values: c[0] || "", defaultCol: c[1] || "", readerCol: c[2] || "",
    effect: c[3] || "", where: c[4] || "", section, line: i + 1,
  });
}

// ── reader sweep (same idioms as lint-url-flags.mjs, wider tree) ───────────
const files = [];
const SKIP = new Set(["node_modules", "pkg", "dist", "legacy"]);
function walk(d) {
  if (!fs.existsSync(d)) return;
  if (!fs.statSync(d).isDirectory()) { files.push(d); return; }
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(p); }
    else if (/\.(js|mjs|html)$/.test(e.name)) files.push(p);
  }
}
for (const t of ["scene3d", "index.html", "plugins", "rynth", "netbrain"]) walk(path.join(appDir, t));

const readers = new Map(); // name → [{file,line,stmt,comment,idiom}]
const GET_RE = /\.get\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\)/g;
const RX_RE = /\[\?&\]([A-Za-z_][A-Za-z0-9_]*)[=)]/g;
const SRC = new Map(files.map((f) => [f, fs.readFileSync(f, "utf8").split("\n")]));

// Extract the comparisons that apply to THIS flag specifically. Naive window
// matching cross-contaminates (`dungeonStreamGate`'s window also contains
// `eagerDungeons === "on"`), so: same-line comparisons on the `.get()` itself,
// plus a one/two-hop variable chase (`const v = get(f)` … `const s =
// v.toLowerCase()` … `s !== "off"`), which is the dominant idiom in vfx_flags.js.
function flagOps(name, lines, i) {
  const ops = [];
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const line = lines[i];
  const direct = new RegExp(`(?:get|_strFlag|_numFlag)\\(\\s*["']${esc}["']\\s*\\)\\s*(===?|!==?)\\s*["']([^"']*)["']`, "g");
  for (const m of line.matchAll(direct)) ops.push([m[1], m[2]]);
  const cap = new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*[^;]*(?:get|_strFlag)\\(\\s*["']${esc}["']\\s*\\)`).exec(line);
  if (cap) {
    const vars = new Set([cap[1]]);
    for (const l of lines.slice(i, Math.min(lines.length, i + 12))) {
      // Two passes per line: `const s = v.toLowerCase(); on = s !== "off"` puts
      // the hop and the comparison on the SAME line, so a single pass over a
      // pre-taken snapshot of `vars` would miss `s`.
      for (let pass = 0; pass < 2; pass += 1) {
        for (const v of [...vars]) {
          const hop = new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${v}\\s*\\.\\s*(?:toLowerCase|trim)\\(\\)`).exec(l);
          if (hop) vars.add(hop[1]);
          if (pass === 0) continue;
          const cmp = new RegExp(`\\b${v}\\b\\s*(===?|!==?)\\s*["']([^"']*)["']`, "g");
          for (const m of l.matchAll(cmp)) ops.push([m[1], m[2]]);
        }
      }
    }
  }
  return ops;
}

function record(name, f, i, lines, idiom, stmtOverride) {
  const stmt = stmtOverride ?? lines.slice(i, Math.min(lines.length, i + 4)).join("\n");
  const comment = lines.slice(Math.max(0, i - 6), i)
    .filter((l) => /^\s*(\/\/|\*|\/\*)/.test(l)).join(" ");
  const list = readers.get(name) || [];
  list.push({ file: path.relative(appDir, f), line: i + 1, stmt, comment, idiom, ops: flagOps(name, lines, i) });
  readers.set(name, list);
}

// ── idiom 1+2: direct `params.get("flag")` and `/[?&]flag=/.test(search) ────
for (const [f, lines] of SRC) {
  for (let i = 0; i < lines.length; i += 1) {
    const ctx = lines.slice(Math.max(0, i - 10), i + 3).join("\n");
    if (/URLSearchParams|location\.search/.test(ctx))
      for (const m of lines[i].matchAll(GET_RE)) record(m[1], f, i, lines, "direct");
    if (/\.test\(/.test(lines[i]) || /\.test\(/.test(lines[i + 1] || ""))
      for (const m of lines[i].matchAll(RX_RE)) record(m[1], f, i, lines, "regex");
  }
}

// ── idiom 3: GENERIC flag-reader helpers ───────────────────────────────────
// A helper like `_terrainStrictFlag(name, presetKey, dflt, warn)` or
// `macroNumFlag(name, dflt, lo, hi, search)` reads `.get(<variable>)`, so the
// literal flag name only appears at the CALL site. Auto-detect the helpers
// (a fn whose body reads location.search/URLSearchParams via a VARIABLE key),
// then attribute every string literal passed as their first argument.
const helpers = new Map(); // fnName → {file, semanticsStmt}
const FN_RE = /(?:function\s+([A-Za-z_$][\w$]*)\s*\(|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:function\s*)?\()/;
for (const [f, lines] of SRC) {
  for (let i = 0; i < lines.length; i += 1) {
    const m = FN_RE.exec(lines[i]);
    if (!m) continue;
    const fnName = m[1] || m[2];
    const body = lines.slice(i, Math.min(lines.length, i + 30)).join("\n");
    if (!/URLSearchParams|location\.search/.test(body)) continue;
    // key must be a VARIABLE, not a literal: `.get(name)` / `.get(flag)`
    if (!/\.get\(\s*[A-Za-z_$][\w$]*\s*\)/.test(body)) continue;
    helpers.set(fnName, { file: path.relative(appDir, f), semantics: body });
  }
}
for (const [f, lines] of SRC) {
  for (let i = 0; i < lines.length; i += 1) {
    for (const [fnName, h] of helpers) {
      const call = new RegExp(`\\b${fnName}\\(\\s*["']([A-Za-z_][A-Za-z0-9_]*)["']`, "g");
      for (const m of lines[i].matchAll(call)) {
        // classify from the HELPER's body, not the call site
        record(m[1], f, i, lines, `via ${fnName}()`, h.semantics);
      }
    }
  }
}

// ── idiom 4: quality.js flag BAGS (`const X_FLAGS = new Set([...])`) ───────
// `parseOverrides(params)` iterates these sets and reads each name off the URL.
for (const [f, lines] of SRC) {
  const src = lines.join("\n");
  if (!/parseOverrides/.test(src)) continue;
  for (const m of src.matchAll(/const\s+(\w*_FLAGS)\s*=\s*new Set\(\[([\s\S]*?)\]\)/g)) {
    const bag = m[1];
    const lineNo = src.slice(0, m.index).split("\n").length;
    const kind = /BOOL/.test(bag) ? 'bag parseBool ("on"/"true"/"1" → true; absent → preset default)'
      : "bag numeric (absent → preset default)";
    // strip comments first — bag bodies carry prose that quotes flag values
    // (`an exact \`=== "on"\` match`), which would otherwise register as members
    const body = m[2].replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    for (const s of body.matchAll(/["']([A-Za-z_][A-Za-z0-9_]*)["']/g))
      record(s[1], f, lineNo - 1, lines, `via parseOverrides ${bag}`, kind);
  }
}

// ── classify the ACTUAL default from the reader expression ─────────────────
function classify(sites) {
  if (!sites?.length) return { def: "—", kind: "no reader found" };
  // A flag read ONLY through quality.js's parseOverrides bag has no polarity of
  // its own — its absent-value default is the quality PRESET entry for the
  // active tier, not an on/off constant. Report it as preset-driven.
  if (sites.every((s) => /parseOverrides/.test(s.idiom || "")))
    return { def: "preset", kind: "quality-preset key (absent → PRESETS[tier] value)" };

  // Flag-scoped comparison evidence beats window heuristics. Two spellings of
  // "default ON": the `!== "off"` opt-out, and the safer explicit DISABLE
  // check (`if (get(f) === "off") enabled = false`) over a `true` initialiser.
  // CAVEAT: an `=== "off"` reader over a FALSE initialiser would be misread as
  // ON. None exist in the tree today; if one lands, the reader is confusing
  // enough that it should be rewritten rather than special-cased here.
  const ops = sites.flatMap((s) => s.ops || []);
  const OFFV = /^(off|0|false|no|)$/i;
  const ONV = /^(on|1|true|yes)$/i;
  if (ops.length) {
    const eqOn = ops.some(([op, v]) => !op.startsWith("!") && ONV.test(v));
    const eqOff = ops.some(([op, v]) => !op.startsWith("!") && OFFV.test(v));
    const neOff = ops.some(([op, v]) => op.startsWith("!") && OFFV.test(v));
    const neOn = ops.some(([op, v]) => op.startsWith("!") && ONV.test(v));
    // TRISTATE: `=on` forces true, `=off` forces false, ABSENT falls through to
    // a code/preset default. The whole terrain-VFX family reads this way; it is
    // neither an opt-in nor an opt-out and must not be reported as either.
    if (eqOn && eqOff) return { def: "tri", kind: "tristate `=on`/`=off`; ABSENT ⇒ code/quality-preset default" };
    if (neOff) return { def: "ON", kind: 'opt-OUT `!== "off"` — ABSENT RESOLVES ON' };
    if (eqOff) return { def: "ON", kind: 'explicit DISABLE check (`=== "off"` over a true default) — absent resolves ON' };
    if (neOn) return { def: "ON", kind: 'INVERTED opt-in (`!== "1"`) — flag absent ⇒ FEATURE ON; `?flag=1` disables it' };
    if (eqOn) return { def: "OFF", kind: "opt-IN exact-match — absent resolves OFF" };
  }
  const optOut = sites.some((s) => /!==?\s*["'](off|0|false|2d)["']/.test(s.stmt));
  const optIn = sites.some((s) => /===?\s*["'](on|1|true|yes|retail)["']/.test(s.stmt));
  const numeric = sites.some((s) => /(parseFloat|parseInt|Number)\s*\(/.test(s.stmt));
  if (optOut && optIn) return { def: "ON*", kind: 'multi-value (`!== "off"` opt-out + an allowlist site)' };
  if (optOut) return { def: "ON", kind: 'opt-OUT `!== "off"` — ABSENT RESOLVES ON' };
  if (optIn) return { def: "OFF", kind: "opt-IN exact-match — absent resolves OFF" };
  if (numeric) return { def: "num", kind: "numeric with code fallback" };
  if (sites.some((s) => /\?\?|\|\||\bif\s*\(/.test(s.stmt))) return { def: "val", kind: "string/enum with code fallback" };
  return { def: "?", kind: "UNCLASSIFIED — read the site" };
}
function docPolarity(cell) {
  const t = cell.replace(/\*/g, "").trim().toLowerCase();
  // A numeric default cell ("0.4", "`0`/`off`/`false` disables", "32") carries
  // no boolean polarity — `0.4` must not read as OFF just because it starts
  // with a zero.
  if (/^`?[\d.]+`?\b/.test(t)) return null;
  if (/^(off|false|0|none|disabled|absent)\b/.test(t)) return "OFF";
  if (/^(on|true|1|enabled)\b/.test(t) || /\bdefault-on\b/.test(t)) return "ON";
  if (/\bon\b/.test(t) && !/\boff\b/.test(t)) return "ON";
  if (/\boff\b/.test(t) && !/\bon\b/.test(t)) return "OFF";
  return null;
}

const rows = [];
for (const name of [...new Set([...docRows.keys(), ...readers.keys()])].sort((a, b) => a.localeCompare(b))) {
  const doc = docRows.get(name);
  const sites = readers.get(name);
  const { def, kind } = classify(sites);
  const dp = doc ? docPolarity(doc.defaultCol) : null;
  const cp = def === "ON" || def === "ON*" ? "ON" : def === "OFF" ? "OFF" : null;
  // `no*` flags invert: the docs Default cell describes the FEATURE ("SW on"),
  // the reader describes the FLAG (`nosw === "1"`, absent ⇒ off). Opposite
  // polarity is CORRECT for these, not a mismatch.
  const invertedName = /^no[A-Z]/.test(name) || /^no(sw|health)$/i.test(name);
  let mismatch = null;
  if (dp && cp && dp !== cp && !invertedName) mismatch = `DEFAULT-POLARITY: docs cell says ${dp}, reader resolves ${cp}`;
  else if (doc && !sites) mismatch = "STALE-ROW: documented but no reader in the swept tree";
  else if (!doc && sites) mismatch = "UNDOCUMENTED: reader exists, no url-flags.md row";
  // Compare the comment's CLAIM against the flag's CLASSIFIED default, not
  // against a raw regex over the statement window — the window catches prose
  // about neighbouring flags and general rules. Skipped when a comment is
  // visibly self-correcting ("the old default-off note here was stale") or is
  // explaining the idiom rather than this flag ("for a default-OFF flag only
  // `=== \"on\"` may enable"), both of which are real comments in this tree.
  const commentMismatches = [];
  for (const s of sites || []) {
    if (/\bstale\b|\bthe mirror of\b|\bfor a default-/i.test(s.comment)) continue;
    const claimsOff = /default[- ](?:is[- ])?off|off by default|strict opt[- ]in|disabled by default/i.test(s.comment);
    const claimsOn = /default[- ](?:is[- ])?on|on by default|opt[- ]out|enabled by default/i.test(s.comment);
    if (claimsOff && def === "ON")
      commentMismatches.push(`${s.file}:${s.line} comment claims default-OFF / "strict opt-in", but the reader resolves ON when absent`);
    else if (claimsOn && def === "OFF")
      commentMismatches.push(`${s.file}:${s.line} comment claims default-ON, but the reader is an exact-match opt-IN (absent ⇒ OFF)`);
  }
  rows.push({ name, doc, sites, def, kind, mismatch, commentMismatches });
}

// ── report ──────────────────────────────────────────────────────────────────
const off = rows.filter((r) => r.def === "OFF");
const on = rows.filter((r) => r.def === "ON" || r.def === "ON*");
const mism = rows.filter((r) => r.mismatch);
const cmism = rows.filter((r) => r.commentMismatches.length);

if (ALL) {
  console.log("flag\tactual_default\treader_semantics\tdocs_default_cell\tfirst_reader_site");
  for (const r of rows)
    console.log([r.name, r.def, r.kind, r.doc?.defaultCol || "—",
      r.sites ? `${r.sites[0].file}:${r.sites[0].line}` : "—"].join("\t"));
  process.exit(0);
}
if (ONLY_OFF) {
  console.log(`# DEFAULT-OFF docket — ${off.length} flags whose reader is an exact-match opt-in\n`);
  for (const r of off)
    console.log(`${r.name}\t${r.sites[0].file}:${r.sites[0].line}\t${(r.doc?.effect || "(undocumented)").slice(0, 120)}`);
  process.exit(0);
}
if (!ONLY_MISMATCH) {
  console.log(
    `audit-flag-defaults: ${rows.length} flags · ${docRows.size} docs rows · ${readers.size} reader names\n` +
      `  default-ON (opt-out readers): ${on.length}\n` +
      `  default-OFF (exact-match opt-ins): ${off.length}\n` +
      `  numeric/enum/value: ${rows.filter((r) => ["num", "val", "?"].includes(r.def)).length}\n`,
  );
}
const polarity = mism.filter((r) => r.mismatch.startsWith("DEFAULT-POLARITY"));
const undoc = mism.filter((r) => r.mismatch.startsWith("UNDOCUMENTED"));
const stale = mism.filter((r) => r.mismatch.startsWith("STALE-ROW"));
console.log(`## DEFAULT-POLARITY mismatches (docs cell vs reader) — ${polarity.length}`);
for (const r of polarity)
  console.log(`  ${r.name}: ${r.mismatch} | docs "${r.doc.defaultCol.slice(0, 50)}" | ${r.sites[0].file}:${r.sites[0].line}`);
console.log(`\n## UNDOCUMENTED readers — ${undoc.length}`);
for (const r of undoc) console.log(`  ${r.name} (${r.def}) ${r.sites.map((s) => `${s.file}:${s.line}`).join(", ")}`);
console.log(`\n## STALE docs rows (no reader) — ${stale.length}`);
for (const r of stale) console.log(`  ${r.name} (url-flags.md:${r.doc.line}, §${r.doc.section})`);
console.log(`\n## In-code COMMENT vs reader mismatches — ${cmism.length}`);
for (const r of cmism) for (const c of r.commentMismatches) console.log(`  ${r.name}: ${c}`);

if (ONLY_MISMATCH && (polarity.length || cmism.length)) process.exit(1);
