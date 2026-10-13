// harness/test_suite_hygiene.mjs — shrink-only ratchet on PURE-PIN suites.
//
// WHY (2026-10-13, test-tooling-7)
// --------------------------------
// At authoring, 260 of the 649 scanned suites read application source TEXT
// (readFileSync over scene3d/, app/, src/, index.html, …, or the
// concatenating harness/app_source.cjs / wasm_source.cjs). Most of them also
// EXECUTE real code (an import, splice_module, import_edited, a hand-rolled
// new Function splice). 23 do not: they only regex-match the source, and some
// say outright that they re-implement the logic under test
// (tests/jump_charge_parity.test.cjs, a Tier-1 entry). A pin like that
// passes as long as the text exists SOMEWHERE — it cannot see whether the
// code runs, or what it does when it runs. WebAC measured the
// cost: 304 of 543 files only grepped source, and a deliberate display
// regression passed all 10,252 tests. They froze the set with a shrink-only
// baseline. This is the same ratchet (after WebAC
// tests/verify-test-suite-hygiene.ts, AGPL-3.0), with a more lenient rule.
//
// PURE-PIN — all three must hold:
//   1. it READS APP SOURCE: an fs read (readFileSync / readFile / readdir…)
//      plus a non-import string literal naming app source — a path through
//      scene3d/ app/ src/ plugins/ ui/ rynth/ ending in .js/.mjs/.cjs/.rs/
//      .html (or a bare directory), join-style split segments
//      (join(HERE, "scene3d", "statics.js")), index.html — or it uses
//      harness/app_source.cjs / wasm_source.cjs;
//   2. it IMPORTS NO APP CODE: no static / dynamic import or require that
//      resolves into those directories or pkg*/;
//   3. it EXECUTES NOTHING LIFTED: no splice_module.mjs / import_edited.mjs /
//      lib/boot.mjs, no new Function / vm / eval / Worker / WebAssembly, no
//      browser driver, no computed import()/require() (other than loading
//      three itself).
// Deliberately conservative: any execution signal clears the file, and a
// JSON / docs / DAT / fixture read never counts as reading app source.
//
// RATCHET (harness/source-pin-baseline.json — the grandfathered set). FAILS:
//   (a) a PURE-PIN suite NOT in the baseline (a new pin-only suite);
//   (b) a baseline entry that no longer qualifies (it now executes code, or
//       was deleted) — drop it so the pattern can never creep back;
//   (c) the baseline is not sorted + duplicate-free.
// HB_REGEN_SOURCE_PIN=1 rewrites the baseline to (baseline ∩ current
// pure pins): it only ever SHRINKS. Adding an entry is never automatic — it
// is a hand edit a reviewer sees in the diff, and should not happen. (One
// reviewed exception, 2026-10-13: eight suites that pin Rust source text —
// Node cannot execute Rust, so the remedy for a NEW one is a cargo #[test]
// next to the code; the failure text says so for a .rs / wasm_source read.)
// Existing suites (rynth ones included) are only READ here, never edited.
//
// A "re-implement" banner on a suite that executes no app code (a pin, or a
// test of a private copy) is reported as INFO only.
//
// Pure Node, no fixtures. Run: node harness/test_suite_hygiene.mjs — exit 0/1.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// harness/ → apps/holtburger-web/ (the app root; every suite path is relative to it).
const APP_ROOT = path.resolve(HERE, "..");
export const BASELINE_PATH = path.join(HERE, "source-pin-baseline.json");
// Self-exclusion: this file's self-check strings name app paths and fs reads.
const SELF = "harness/test_suite_hygiene.mjs";

// Same naming conventions as run-js-headless.mjs unregisteredSuites(), plus
// the root `test_*.cjs` smokes and the root rynth `*_test.cjs` suites.
const SCAN = [
  { dir: "", match: (n) => /^test_.*\.(?:mjs|cjs)$/.test(n) || /_test\.cjs$/.test(n) },
  { dir: "rynth", match: (n) => /^test_.*\.mjs$/.test(n) },
  { dir: "harness", match: (n) => /^test_.*\.mjs$/.test(n) },
  { dir: "tests", match: (n) => /\.(?:mjs|cjs)$/.test(n) && (n.startsWith("test_") || n.includes(".test.")) },
];

const APP_DIRS = new Set(["scene3d", "app", "src", "plugins", "ui", "rynth"]);
const CODE_EXT = /\.(?:m?js|cjs|rs|html)$/i;
const PKG_DIR = /^pkg(?:-[\w.-]+)?$/;

// ---------------------------------------------------------------------------
// Lightweight JS scanner: drop comments, collect string literals.
// ---------------------------------------------------------------------------

// Words after which a `/` starts a regex literal, not a division.
const REGEX_AFTER_WORD = new Set([
  "return", "typeof", "case", "of", "in", "void", "delete", "throw", "new",
  "else", "do", "yield", "await", "instanceof",
]);

function regexAllowed(code) {
  let j = code.length - 1;
  while (j >= 0 && /\s/.test(code[j])) j--;
  if (j < 0) return true;
  const c = code[j];
  if (/[\w$]/.test(c)) {
    let k = j;
    while (k >= 0 && /[\w$]/.test(code[k])) k--;
    return REGEX_AFTER_WORD.has(code.slice(k + 1, j + 1));
  }
  // After a value: `)`, `]`, a string/template placeholder, `.` → division.
  return !(c === ")" || c === "]" || c === '"' || c === "`" || c === ".");
}

/**
 * @param {string} src
 * @returns {{code: string, strings: string[]}}
 *   code    — the source with comments removed, every '…' / "…" literal
 *             replaced by `"S<index>"`, each template text segment by
 *             `S<index>` (template `${}` expressions stay code), and regex
 *             literals by `/RE/`.
 *   strings — the literal contents, indexed by those placeholders.
 */
export function scanSource(src) {
  const strings = [];
  let code = "";
  let i = 0;
  const n = src.length;
  if (src.startsWith("#!")) while (i < n && src[i] !== "\n") i++;
  const tpl = []; // brace depth of each open `${ … }` template expression
  let inTemplate = false;
  while (i < n) {
    if (inTemplate) {
      let seg = "";
      while (i < n) {
        const c = src[i];
        if (c === "\\") { seg += src.slice(i, i + 2); i += 2; continue; }
        if (c === "`") { i++; inTemplate = false; code += `S${strings.length}\``; break; }
        if (c === "$" && src[i + 1] === "{") { i += 2; tpl.push(0); inTemplate = false; code += `S${strings.length}\${`; break; }
        seg += c;
        i++;
      }
      strings.push(seg);
      continue;
    }
    const c = src[i];
    const c2 = src[i + 1];
    if (c === "/" && c2 === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && c2 === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      code += " ";
      continue;
    }
    if (c === "'" || c === '"') {
      let s = "";
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== "\n") {
        if (src[j] === "\\") { s += src.slice(j, j + 2); j += 2; continue; }
        s += src[j];
        j++;
      }
      i = j + 1;
      code += `"S${strings.length}"`;
      strings.push(s);
      continue;
    }
    if (c === "`") {
      code += "`";
      i++;
      inTemplate = true;
      continue;
    }
    if (c === "/" && regexAllowed(code)) {
      // Regex literal: escapes and [classes] may hold `/` and quotes.
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n && src[j] !== "\n") {
        const r = src[j];
        if (r === "\\") { j += 2; continue; }
        if (r === "[") inClass = true;
        else if (r === "]") inClass = false;
        else if (r === "/" && !inClass) { closed = true; break; }
        j++;
      }
      if (closed) {
        i = j + 1;
        while (i < n && /[a-z]/i.test(src[i])) i++;
        code += "/RE/";
        continue;
      }
      // Not a regex after all (no closing `/` on the line) — a division.
    }
    if (tpl.length && c === "{") tpl[tpl.length - 1]++;
    if (tpl.length && c === "}") {
      if (tpl[tpl.length - 1] === 0) {
        tpl.pop();
        code += "}";
        i++;
        inTemplate = true;
        continue;
      }
      tpl[tpl.length - 1]--;
    }
    code += c;
    i++;
  }
  return { code, strings };
}

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

const LIT = String.raw`(?:"S(\d+)"|\`S(\d+)\`)`;
const SPEC_RES = [
  new RegExp(String.raw`\bfrom\s*` + LIT, "g"),                       // import … from "x" / export … from "x"
  new RegExp(String.raw`\bimport\s*` + LIT, "g"),                      // import "x";
  new RegExp(String.raw`\bimport\s*\(\s*` + LIT + String.raw`\s*[,)]`, "g"), // import("x")
  new RegExp(String.raw`\brequire\s*\(\s*` + LIT + String.raw`\s*\)`, "g"),  // require("x")
];
// import(expr) / require(expr) with a computed specifier — almost always an
// app module through pathToFileURL / path.join (or a data: URL of edited
// source); counted as executing. The one common exception is loading three
// itself (`import("file://" + threePath)`), which runs no app code.
const CALL_IMPORT = /\b(?:import|require)\s*\(/g;
const LITERAL_ARG = new RegExp(String.raw`^\s*` + LIT + String.raw`\s*(?:,|$)`);
const THREE_ONLY = /three/i;
const APP_MENTION = /\b(?:scene3d|plugins|rynth|pkg)\b|(?:^|[\/"'`])(?:app|ui|src)\//;

/** First computed import()/require() argument that is not three, or null. */
function computedImport(code, strings) {
  CALL_IMPORT.lastIndex = 0;
  let m;
  while ((m = CALL_IMPORT.exec(code)) !== null) {
    let depth = 1;
    let j = m.index + m[0].length;
    const start = j;
    while (j < code.length && depth > 0) {
      if (code[j] === "(") depth++;
      else if (code[j] === ")") depth--;
      j++;
    }
    const arg = code.slice(start, j - 1);
    if (LITERAL_ARG.test(arg)) continue;
    const expanded = arg.replace(/"S(\d+)"|S(\d+)/g, (_, a, b) => JSON.stringify(strings[Number(a ?? b)] ?? ""));
    if (THREE_ONLY.test(expanded) && !APP_MENTION.test(expanded)) continue;
    // `const THREE = await import("file://" + tp)`.
    if (/\bTHREE\s*=\s*(?:await\s+)?$/.test(code.slice(Math.max(0, m.index - 40), m.index))) continue;
    return arg.trim().slice(0, 60);
  }
  return null;
}
const FS_READ = /\b(?:readFileSync|readFile|readdirSync|readdir|createReadStream)\s*\(/;
const EXEC_CODE = [
  [/\bnew\s+(?:Async)?Function\s*\(/, "new Function"],
  [/(?<![\w$.])Function\s*\(/, "Function()"],
  [/(?<![\w$.])eval\s*\(/, "eval"],
  [/\b(?:runInNewContext|runInThisContext|runInContext|compileFunction)\s*\(/, "vm.runIn*"],
  [/\bnew\s+(?:vm\s*\.\s*)?(?:Script|SourceTextModule)\s*\(/, "vm.Script"],
  [/\bnew\s+Worker\s*\(/, "new Worker"],
  [/\bWebAssembly\s*\.\s*(?:instantiate|instantiateStreaming|compile|Module|Instance)\b/, "WebAssembly"],
];
const EXECUTOR_HELPER = /(?:^|\/)(?:splice_module|import_edited)\.mjs$|(?:^|\/)lib\/boot\.mjs$/;
const BROWSER_DRIVER = /^(?:playwright(?:-core)?|@playwright\/test|puppeteer(?:-core)?|chrome-remote-interface)(?:\/|$)/;
const SOURCE_HELPER = /(?:^|\/)(?:app_source|wasm_source)\.cjs$/;
const SOURCE_HELPER_CALL = /\b(?:readAppSource|readAppModule|readWasmSource)\s*\(/;
const REIMPLEMENT = /\bre-?implement(?:s|ed|ing|ation)?\b/i;

/** `rel` normalised from the suite's directory; null when it leaves the app root. */
function resolveRel(fromRel, rel) {
  const p = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), rel));
  return p.startsWith("../") || p === ".." ? null : p;
}

/** Does this resolved app-relative path land on app source? */
function isAppSourcePath(p) {
  const rel = p.replace(/^(?:\.\/|\/)+/, "");
  if (rel === "index.html") return true;
  const segs = rel.split("/");
  if (segs.length < 2 || !APP_DIRS.has(segs[0])) return false;
  const last = segs[segs.length - 1];
  return last === "" || CODE_EXT.test(last) || !last.includes(".");
}

/** A string literal that names app source (null when it does not). */
function appSourceLiteral(lit, suiteRel) {
  if (!lit || lit.includes("node_modules/") || /^[a-z][\w+.-]*:/i.test(lit)) return null;
  // As written (cwd = app root) and resolved from the suite's own directory.
  if (isAppSourcePath(lit)) return lit;
  const local = resolveRel(suiteRel, lit);
  if (local && /^\.{0,2}\//.test(lit) && isAppSourcePath(local)) return lit;
  if (local && path.posix.dirname(suiteRel) !== "." && !lit.includes("/") && CODE_EXT.test(lit)
      && isAppSourcePath(local)) return lit;
  // Anywhere in a longer path: `${HB}/apps/holtburger-web/scene3d/x.js`,
  // `crates/holtburger-world/src/spatial/scene.rs`.
  const segs = lit.split("/");
  for (let k = 1; k < segs.length - 1; k++) {
    if (APP_DIRS.has(segs[k])) {
      const last = segs[segs.length - 1];
      if (CODE_EXT.test(last)) return lit;
    }
  }
  return null;
}

/** Does an import specifier pull in app code (or an executor helper)? */
function specExecutes(spec, suiteRel) {
  if (EXECUTOR_HELPER.test(spec)) return `uses ${path.posix.basename(spec)}`;
  if (BROWSER_DRIVER.test(spec)) return `drives a browser (${spec})`;
  if (!spec.startsWith("./") && !spec.startsWith("../")) return null;
  if (/\.json$/i.test(spec)) return null;
  const p = resolveRel(suiteRel, spec);
  if (!p) return null;
  const head = p.split("/")[0];
  if (APP_DIRS.has(head) || PKG_DIR.test(head)) return `imports ${p}`;
  return null;
}

/**
 * Classify one suite's source.
 * @param {string} src
 * @param {string} [suiteRel]  path relative to the app root (resolves `./x`)
 * @returns {{pin: boolean, reads: string|null, executes: string|null, reimplement: boolean}}
 *   pin        — PURE-PIN: reads app source and executes no app code
 *   reads      — evidence it reads app source (null = it does not)
 *   executes   — evidence it runs app code (null = it does not)
 */
export function classifySuite(src, suiteRel = "tests/synthetic.test.mjs") {
  const { code, strings } = scanSource(src);
  const specIdx = new Set();
  const specs = [];
  for (const re of SPEC_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code)) !== null) {
      const idx = Number(m[1] ?? m[2]);
      specIdx.add(idx);
      specs.push(strings[idx]);
    }
  }

  let executes = null;
  for (const s of specs) {
    executes = specExecutes(s, suiteRel);
    if (executes) break;
  }
  if (!executes) {
    const arg = computedImport(code, strings);
    if (arg !== null) executes = `computed import(${arg})`;
  }
  if (!executes) {
    for (const [re, label] of EXEC_CODE) {
      if (re.test(code)) { executes = label; break; }
    }
  }

  let reads = null;
  if (specs.some((s) => SOURCE_HELPER.test(s)) || SOURCE_HELPER_CALL.test(code)) {
    // Name the helper(s) so readsRustOnly() can tell a crate-text pin apart.
    const app = specs.some((s) => /(?:^|\/)app_source\.cjs$/.test(s)) || /\b(?:readAppSource|readAppModule)\s*\(/.test(code);
    const wasm = specs.some((s) => /(?:^|\/)wasm_source\.cjs$/.test(s)) || /\breadWasmSource\s*\(/.test(code);
    reads = app && wasm ? "harness app_source + wasm_source" : wasm ? "harness wasm_source" : "harness app_source";
  } else if (FS_READ.test(code)) {
    const lits = strings.filter((_, k) => !specIdx.has(k));
    for (const lit of lits) {
      reads = appSourceLiteral(lit, suiteRel);
      if (reads) break;
    }
    if (!reads) {
      // join-style: join(HERE, "scene3d", "statics.js").
      const dir = lits.find((s) => APP_DIRS.has(s.replace(/^(?:\.{1,2}\/)+/, "").replace(/\/$/, "")));
      const file = dir && lits.find((s) => CODE_EXT.test(s));
      if (file) reads = `${dir} + ${file}`;
    }
  }

  return { pin: !!reads && !executes, reads, executes, reimplement: REIMPLEMENT.test(src) };
}

/**
 * Does a classifySuite() `reads` evidence string name Rust source only (a .rs
 * path, or the wasm_source.cjs crate-text helper)? splice_module /
 * import_edited cannot run Rust, so such a pin needs a different remedy:
 * a cargo #[test] next to the code.
 */
export function readsRustOnly(reads) {
  if (!reads) return false;
  if (/\bapp_source\b/.test(reads)) return false;
  return /\.rs\b/.test(reads) || /\bwasm_source\b/.test(reads);
}

// ---------------------------------------------------------------------------
// Tree scan + baseline
// ---------------------------------------------------------------------------

/** Every suite path the scan visits (relative to the app root, sorted). */
export function listSuites(appRoot = APP_ROOT) {
  const out = [];
  for (const { dir, match } of SCAN) {
    let names = [];
    try { names = readdirSync(path.join(appRoot, dir)); } catch (_) { continue; }
    for (const n of names) if (match(n)) out.push(dir ? `${dir}/${n}` : n);
  }
  return out.sort();
}

/** Classification of every scanned suite except this one. */
export function classifyTree(appRoot = APP_ROOT) {
  const rows = new Map();
  for (const rel of listSuites(appRoot)) {
    if (rel === SELF) continue;
    rows.set(rel, classifySuite(readFileSync(path.join(appRoot, rel), "utf8"), rel));
  }
  return rows;
}

export function readBaseline() {
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
}

export function writeBaseline(files) {
  const body = {
    comment:
      "Grandfathered PURE-PIN suites: they read app source text and execute no app code. "
      + "Ratchet enforced by harness/test_suite_hygiene.mjs. Entries may only be REMOVED "
      + "(rewrite a suite to execute the real code, then drop its entry, or run with "
      + "HB_REGEN_SOURCE_PIN=1). Never add entries: a new pin-only suite is the defect. "
      + "The one exception is a reviewed hand edit (2026-10-13: eight Rust-source text pins, "
      + "which Node cannot execute); a new Rust-behaviour check belongs in a cargo #[test] "
      + "next to the code instead.",
    files: [...new Set(files)].sort(),
  };
  writeFileSync(BASELINE_PATH, JSON.stringify(body, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  let passed = 0;
  let failed = 0;
  const ok = (cond, label, detail) => {
    if (cond) { passed++; return; }
    failed++;
    console.error(`  FAIL ${label}`);
    if (detail) console.error(detail);
  };

  // ── detector self-checks: each rule fires (and stays quiet) where intended ──
  {
    const pin = (src, rel) => classifySuite(src, rel).pin;
    const FS = `import { readFileSync } from "node:fs";\nimport assert from "node:assert/strict";\n`;
    const PIN_SRC = `${FS}const src = readFileSync("scene3d/x.js", "utf8");\nassert.match(src, /foo\\(\\)/);\n`;

    ok(pin(PIN_SRC), "self-check: readFileSync('scene3d/x.js') + assert.match is PURE-PIN");
    ok(!pin(`${PIN_SRC}const mod = await import("../scene3d/x.js");\n`),
      "self-check: the same plus await import('../scene3d/x.js') is NOT flagged");
    ok(!pin(`${PIN_SRC}import { spliceModule } from "../harness/lib/splice_module.mjs";\n`),
      "self-check: the same plus splice_module.mjs is NOT flagged");
    ok(!pin(`${PIN_SRC}import { importEdited } from "../harness/lib/import_edited.mjs";\n`),
      "self-check: the same plus import_edited.mjs is NOT flagged");
    ok(!pin(`${FS}const fx = JSON.parse(readFileSync("tests/fixtures/ws01_player_mt_fromReady.json", "utf8"));\n`
      + `assert.ok(fx);\n`), "self-check: a JSON fixture read is NOT flagged");
    ok(!pin(`${FS}const fx = JSON.parse(readFileSync("plugins/catalog.json", "utf8"));\n`),
      "self-check: a JSON read under an app dir is NOT flagged");
    ok(!pin(`import assert from "node:assert/strict";\n// pins scene3d/x.js via readFileSync — comment only\n`
      + `assert.equal(1 + 1, 2);\n`), "self-check: a suite with no fs reads is NOT flagged");
    ok(!pin(`${FS}const doc = readFileSync("docs/url-flags.md", "utf8");\nassert.match(doc, /x/);\n`),
      "self-check: a docs/*.md read is NOT flagged");

    ok(pin(`${FS}import { join } from "node:path";\n`
      + `const src = readFileSync(join(__dirname, "scene3d", "statics.js"), "utf8");\n`),
      "self-check: join-style split segments (\"scene3d\", \"statics.js\") are PURE-PIN");
    ok(pin(`const SRC = require("../harness/app_source.cjs").readAppSource();\n`
      + `require("node:assert").match(SRC, /x/);\n`, "tests/x.test.cjs"),
      "self-check: harness/app_source.cjs alone is PURE-PIN");
    ok(pin(`${FS}const lib = readFileSync(\`\${APP}/src/lib.rs\`, "utf8");\n`),
      "self-check: a template-literal path to src/lib.rs is PURE-PIN");
    ok(pin(`${FS}const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");\n`, "tests/x.test.mjs"),
      "self-check: ../index.html from tests/ is PURE-PIN");
    ok(pin(`${FS}const k = readFileSync(new URL("./kernel.js", import.meta.url), "utf8");\n`, "rynth/test_x.mjs"),
      "self-check: ./kernel.js read from rynth/ is PURE-PIN");
    ok(!pin(`${FS}import { kernel } from "./kernel.js";\nconst k = readFileSync(new URL("./kernel.js", import.meta.url), "utf8");\n`,
      "rynth/test_x.mjs"), "self-check: importing ./kernel.js from rynth/ counts as executing");
    ok(!pin(`${PIN_SRC}const fn = new Function("a", body);\n`),
      "self-check: a hand-rolled new Function splice counts as executing");
    ok(!pin(`${PIN_SRC}const mod = await import(pathToFileURL(join(APP, "scene3d/x.js")).href);\n`),
      "self-check: a computed import() counts as executing");
    ok(!pin(`${PIN_SRC}const init = require("../pkg/holtburger_web.js");\n`),
      "self-check: requiring pkg/ counts as executing");
    ok(!pin(`${PIN_SRC}const mod = await import(\n  "../scene3d/x.js"\n);\n`),
      "self-check: a multi-line literal import() is still an import of app code");
    ok(pin(`${PIN_SRC}const THREE = await import("file://" + tp);\n`)
      && pin(`${PIN_SRC}const T = await import(pathToFileURL(threePath).href);\n`),
      "self-check: loading three alone is not executing app code");
    // Scanner robustness: a regex literal holding quotes / `//` must not
    // desynchronise the string scan and hide (or invent) a read.
    ok(pin(`${FS}const re = /["']\\/\\/x/;\nconst src = readFileSync("app/client_events.js", "utf8");\n`),
      "self-check: a quote-bearing regex literal does not hide a later read");
    ok(!pin(`${FS}const re = /readFileSync\\("scene3d\\/x\\.js"\\)/;\nconst f = readFileSync("data/x.json");\n`),
      "self-check: an app path inside a regex literal is not a read");

    const r = classifySuite(`${PIN_SRC}// We re-implement the routing contract here.\n`);
    ok(r.pin && r.reimplement, "self-check: a 're-implement' banner is detected (INFO only)");

    // Remedy routing: a Rust-text pin is pointed at a cargo #[test], a JS pin
    // at splice_module / import_edited.
    const reads = (src, rel) => classifySuite(src, rel).reads;
    ok(readsRustOnly(reads(`${FS}const lib = readFileSync(new URL("../src/lib.rs", import.meta.url), "utf8");\n`))
      && readsRustOnly(reads(`${FS}import path from "node:path";\nconst s = readFileSync(path.join(APP, "src", "lib.rs"), "utf8");\n`))
      && readsRustOnly(reads(`const { readWasmSource } = require("../harness/wasm_source.cjs");\nconst W = readWasmSource();\n`, "tests/x.test.cjs")),
      "self-check: .rs reads / wasm_source.cjs route to the cargo #[test] remedy");
    ok(!readsRustOnly(reads(PIN_SRC))
      && !readsRustOnly(reads(`const SRC = require("../harness/app_source.cjs").readAppSource();\n`, "tests/x.test.cjs"))
      && !readsRustOnly(null),
      "self-check: JS / app_source reads route to the splice_module / import_edited remedy");
  }

  // ── the scan itself is live (a broken path would make every check hollow) ──
  const suites = listSuites();
  ok(suites.includes(SELF), "scan visits harness/ (sees this file)");
  ok(suites.length >= 300, `scan found ${suites.length} suites (expected >= 300)`);

  const rows = classifyTree();
  const pins = [...rows].filter(([, r]) => r.pin).map(([f]) => f).sort();
  const readers = [...rows].filter(([, r]) => r.reads);

  // ── baseline shape ──
  let baseline = readBaseline();
  ok(Array.isArray(baseline.files), "source-pin-baseline.json has a files[] array");
  const files = baseline.files ?? [];
  ok(JSON.stringify(files) === JSON.stringify([...new Set(files)].sort()),
    "source-pin-baseline.json is sorted and duplicate-free");

  const pinSet = new Set(pins);
  if (process.env.HB_REGEN_SOURCE_PIN === "1") {
    const kept = files.filter((f) => pinSet.has(f));
    writeBaseline(kept);
    console.log(`HB_REGEN_SOURCE_PIN=1: baseline rewritten, ${files.length - kept.length} stale entr${files.length - kept.length === 1 ? "y" : "ies"} removed (shrink-only; nothing added)`);
    baseline = readBaseline();
  }
  const baseFiles = baseline.files ?? [];
  const baseSet = new Set(baseFiles);

  // ── (a) no NEW pure-pin suite ──
  const fresh = pins.filter((f) => !baseSet.has(f));
  const freshRust = fresh.filter((f) => readsRustOnly(rows.get(f).reads));
  const freshJs = fresh.filter((f) => !readsRustOnly(rows.get(f).reads));
  ok(fresh.length === 0, `no new PURE-PIN suites (${fresh.length} found)`,
    fresh.length === 0 ? "" :
      "    New suites must EXECUTE the shipped code, not only regex-match its text.\n"
      + (freshJs.length === 0 ? "" :
        "    JS / HTML source: import the module and assert behaviour; for a function\n"
        + "    buried in a module that cannot load headless, lift it with\n"
        + "    harness/lib/splice_module.mjs (spliceModule + harness/lib/scene3d_stubs.mjs),\n"
        + "    or load the real module with a one-line test seam via\n"
        + "    harness/lib/import_edited.mjs (importEdited). If the logic is inline in\n"
        + "    index.html / a module that cannot load, extract it into a small importable\n"
        + "    module and have the caller use it.\n"
        + freshJs.map((f) => `      ${f} — reads ${rows.get(f).reads}; executes nothing`).join("\n") + "\n")
      + (freshRust.length === 0 ? "" :
        "    Rust source (.rs): splice_module / import_edited cannot run Rust. Add a cargo\n"
        + "    #[test] next to the code instead (a `#[cfg(test)] mod tests` in the .rs file;\n"
        + "    the CI rust job and harness/cargo-tests.mjs run lib tests), then drop the\n"
        + "    JS text pin.\n"
        + freshRust.map((f) => `      ${f} — reads ${rows.get(f).reads}; executes nothing (add a cargo #[test])`).join("\n")));

  // ── (b) shrink-only: every baseline entry still qualifies ──
  const stale = baseFiles.filter((f) => !pinSet.has(f));
  ok(stale.length === 0, `baseline only shrinks (${stale.length} stale entr${stale.length === 1 ? "y" : "ies"})`,
    stale.length === 0 ? "" :
      "    These harness/source-pin-baseline.json entries no longer qualify as PURE-PIN\n"
      + "    (rewritten to execute code, or deleted). Remove them so the pattern cannot\n"
      + "    come back:  HB_REGEN_SOURCE_PIN=1 node harness/test_suite_hygiene.mjs\n"
      + stale.map((f) => `      ${f} — ${rows.has(f) ? `now ${rows.get(f).executes ?? "reads no app source"}` : "file not found"}`).join("\n"));

  // ── INFO: suites that say they re-implement the logic, and run none of it ──
  const banners = [...rows].filter(([, r]) => r.reimplement && !r.executes)
    .map(([f, r]) => `${f} (${r.pin ? "pure pin" : "reads no app source"})`);
  console.log(`suite hygiene: ${rows.size} suites scanned, ${readers.length} read app source, `
    + `${pins.length} pure pins (${baseFiles.length} grandfathered)`);
  if (banners.length) {
    console.log(`INFO: ${banners.length} suites say they re-implement the logic under test and execute `
      + `no app code (they test a copy that can drift from the shipped code):`);
    for (const b of banners) console.log(`  ${b}`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
