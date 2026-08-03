#!/usr/bin/env node
// scripts/lint-harness-params.mjs — G1 harness-param tripwire (2026-07-11 s13,
// A10). Fail-loud lint that would have caught the dead kick-dance param: a URL
// query key EMITTED by the headless harness / driver scripts that NO consumer
// in the web client READS is dead weight at best and a silent behavioral no-op
// at worst (that dead param's flake-chase burned a session). This sweep is the
// CI ratchet that stops the next one.
//
// READER set (what the client can consume) = the UNION of:
//   (R1) `URLSearchParams….get("NAME")` reads in index.html + scene3d/**/*.js
//   (R2) regex-literal readers `/[?&]NAME=…/.test(location.search)` in the same
//   (R3) every flag documented in apps/holtburger-web/docs/url-flags.md — this
//        row set covers wasm-side readers (js_sys::Reflect / init args) the JS
//        sweep can't see, so a documented flag is treated as consumable
//   (R4) a small explicit allow-list of boot params that are neither .get()-read
//        in the swept tree nor documented as behavior flags (each justified)
//
// EMITTER set (what the drivers put on the URL) = query keys found in:
//   apps/holtburger-web/harness/** + scripts/net-review/** + scripts/multi-agent/**
//   + scripts/perf-worker/**  (all *.mjs/*.cjs/*.js/*.sh, node_modules skipped)
//   via  (E1) `[?&]NAME=` fragments inside string literals,
//        (E2) standalone quoted `"NAME=value"` tokens (array-of-flags idiom),
//        (E3) top-level keys of `BASE_QUERY = {…}` and `new URLSearchParams({…})`
//             query objects (boot.mjs + battery-telepoi cdp query).
//
// FAIL (exit 1) listing every emitted param with no reader. Run:
//   node scripts/lint-harness-params.mjs [--docs <path>] [--verbose]
// --docs overrides the url-flags.md path (CI / self-test against a corrected
// docs copy). Wired into ci-smoke.sh static section as L3.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const APP = path.join(ROOT, "apps", "holtburger-web");
const VERBOSE = process.argv.includes("--verbose");
const docsIdx = process.argv.indexOf("--docs");
const DOCS_PATH = docsIdx >= 0
  ? path.resolve(process.argv[docsIdx + 1])
  : path.join(APP, "docs", "url-flags.md");

// ── R4: boot params consumed by the login/bridge path but not behavior flags.
// Each is a genuine client consumer that the R1–R3 sweep can miss (dynamic
// picker reads, credential plumbing). NOT a launder-list for dead params.
const READER_ALLOW = {
  character: "boot param — character-picker selection (dynamic read)",
  server: "boot param — server-picker selection (dynamic read)",
};

// ── EMIT allow-list: query keys that ride a NON-app URL (test-driver HTTP
// endpoints on the firefox/chrome CDP driver), not the holtburger app URL, so
// the web client is not their consumer. Each justified.
const EMIT_ALLOW = {
  fn: "CDP-driver /eval?fn= endpoint (base64 fn), not an app flag",
  url: "CDP-driver /goto?url= endpoint, not an app flag",
  n: "CDP-driver /console?n= endpoint, not an app flag",
  ignoreCache: "CDP-driver /reload?ignoreCache= endpoint, not an app flag",
  v: "index.html <script src=…?v=wave-…> cache-bust marker (browser cache key, not JS/wasm-read); appears in run-all help text",
};

// ── collect READER-set files (R1/R2 sweep) ──────────────────────────────────
const readerFiles = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      if (["node_modules", "pkg", "dist", "legacy"].includes(e.name)) continue;
      walk(p);
    } else if (/\.(js|mjs)$/.test(e.name)) {
      readerFiles.push(p);
    }
  }
})(path.join(APP, "scene3d"));
readerFiles.push(path.join(APP, "index.html"));

const readers = new Set();
const GET_RE = /\.get\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\)/g; // R1
const RX_RE = /\[\?&\]([A-Za-z_][A-Za-z0-9_]*)[=)]/g;               // R2
for (const f of readerFiles) {
  const src = fs.readFileSync(f, "utf8");
  for (const m of src.matchAll(GET_RE)) readers.add(m[1]);
  for (const m of src.matchAll(RX_RE)) readers.add(m[1]);
}

// ── R3: documented flags ────────────────────────────────────────────────────
const docs = fs.readFileSync(DOCS_PATH, "utf8");
for (const m of docs.matchAll(/^\| `([A-Za-z_][A-Za-z0-9_]*)`(?:=[^`]*)? \|/gm)) {
  readers.add(m[1]);
}
// ── R5: wasm-side readers — the Rust flag-parse idiom is
// `trimmed.split('&').any(|kv| kv == "flagName=on")` (+ `?flagName` in docs),
// invisible to the JS sweep. Harvest flag tokens straight from src/lib.rs so a
// wasm-only flag (unifiedTick, wireStatePacks, slideCast, …) counts as read
// without needing a docs-table backfill first.
const libRs = path.join(APP, "src", "lib.rs");
if (fs.existsSync(libRs)) {
  const rs = fs.readFileSync(libRs, "utf8");
  for (const m of rs.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)=(?:on|off|[0-9A-Za-z.\-]*)"/g)) readers.add(m[1]);
  // 2026-08-03 review, finding F7: this second sweep used to run
  //     /[?&]([A-Za-z_][A-Za-z0-9_]*)\b/g
  // over the WHOLE 3 MB lib.rs. In Rust `?` is the try operator and `&` is the
  // borrow operator, so it harvested every borrowed identifier as a "reader":
  // 39 genuine flag tokens vs 511 injected non-flags (`str`, `self`, `mut`,
  // `Sized`, `key`, `bytes`, `format`, `log`, `e`, `S`, `keys`, `cell`,
  // `heights`, `codes`, `tables`, …). Any emitted param whose name collided
  // with a Rust local was therefore marked "has a reader" and silently
  // dropped from the DEAD-PARAM report.
  //
  // `?flagName` only means a URL param inside a string literal or a comment,
  // so restrict the scan to exactly those regions.
  const litsAndComments = [
    ...rs.matchAll(/"(?:[^"\\\n]|\\.)*"/g),   // double-quoted string literals
    ...rs.matchAll(/\/\/[^\n]*/g),            // line comments
  ].map((m) => m[0]).join("\n");
  // Even inside comments, `&mut self` / `&dyn Trait` / `&Rc<T>` are Rust, not
  // URL params. Two cheap shape discriminators remove the rest of the noise:
  // every URL flag in this client is lowercase-initial camelCase with no
  // underscore (`texBc7`, `fogLerp`, `nullRender`), so PascalCase types and
  // snake_case locals cannot be flags; and Rust keywords never are.
  const RUST_KEYWORDS = new Set([
    "mut", "self", "dyn", "ref", "move", "impl", "fn", "let", "in", "as", "if",
    "else", "match", "loop", "while", "for", "return", "use", "mod", "pub",
    "crate", "super", "type", "where", "trait", "enum", "struct", "const",
    "static", "unsafe", "async", "await", "box",
  ]);
  for (const m of litsAndComments.matchAll(/[?&]([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
    const name = m[1];
    if (!/^[a-z][A-Za-z0-9]*$/.test(name)) continue;   // no snake_case / PascalCase
    if (RUST_KEYWORDS.has(name)) continue;
    readers.add(name);
  }
}
// ── R4 ──
for (const k of Object.keys(READER_ALLOW)) readers.add(k);

// ── collect EMITTER-set files ───────────────────────────────────────────────
const emitDirs = [
  path.join(APP, "harness"),
  path.join(ROOT, "scripts", "net-review"),
  path.join(ROOT, "scripts", "multi-agent"),
  path.join(ROOT, "scripts", "perf-worker"),
];
const emitFiles = [];
for (const root of emitDirs) {
  if (!fs.existsSync(root)) continue;
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (["node_modules", "pkg", "dist"].includes(e.name)) continue;
        walk(p);
      } else if (/\.(mjs|cjs|js)$/.test(e.name)) {
        emitFiles.push(p);
      }
    }
  })(root);
}

// Top-level object keys of `BASE_QUERY = {…}` / `new URLSearchParams({…})`
// (E3): char-walk so the maxRetries spread's nested `{…}` doesn't truncate.
function objectQueryKeys(src) {
  const keys = new Set();
  const starts = [];
  for (const m of src.matchAll(/BASE_QUERY\s*=\s*\{/g)) starts.push(m.index + m[0].length - 1);
  for (const m of src.matchAll(/new URLSearchParams\(\s*\{/g)) starts.push(m.index + m[0].length - 1);
  for (const open of starts) {
    let depth = 0;
    for (let i = open; i < src.length; i += 1) {
      const c = src[i];
      if (c === "{") depth += 1;
      else if (c === "}") { depth -= 1; if (depth === 0) break; }
      else if (depth === 1) {
        // a top-level `key:` at this position
        const rest = src.slice(i);
        const km = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(rest);
        if (km) {
          // guard: the char before must be a delimiter, not part of a longer token
          const prev = src[i - 1];
          if (prev === "{" || prev === "," || prev === "\n" || prev === " " || prev === "\t" || prev === "\r") {
            keys.add(km[1]);
          }
        }
      }
    }
  }
  return keys;
}

const emitters = new Map(); // name → Set(file)
const EM_FRAG = /[?&]([A-Za-z_][A-Za-z0-9_]*)=/g;             // E1
const addEmit = (name, rel) => {
  const s = emitters.get(name) || new Set();
  s.add(rel);
  emitters.set(name, s);
};
// Strip comments so example URLs in `//`/`/* */` prose don't read as emissions
// (the `[^:]` guard keeps `http://` intact). String literals are preserved.
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
for (const f of emitFiles) {
  const raw = fs.readFileSync(f, "utf8");
  const src = stripComments(raw);
  const rel = path.relative(ROOT, f);
  for (const m of src.matchAll(EM_FRAG)) addEmit(m[1], rel);   // E1
  for (const k of objectQueryKeys(src)) addEmit(k, rel);        // E3
}

// ── classify ────────────────────────────────────────────────────────────────
const dead = [];
for (const [name, filesSet] of [...emitters].sort((a, b) => a[0].localeCompare(b[0]))) {
  if (readers.has(name)) continue;
  if (Object.prototype.hasOwnProperty.call(EMIT_ALLOW, name)) continue;
  dead.push({ name, files: [...filesSet].sort() });
}

console.log(
  `lint-harness-params: ${emitters.size} distinct emitted params, ${readers.size} reader-set entries ` +
    `(${readerFiles.length} JS/HTML reader files + docs rows), ${emitFiles.length} emitter files scanned.`,
);
if (VERBOSE) {
  console.log("\n— emitted params (→ files) —");
  for (const [name, s] of [...emitters].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${name}${readers.has(name) ? "" : "  [NO-READER]"} → ${[...s].sort().join(", ")}`);
  }
}
for (const d of dead) {
  console.log(`DEAD-PARAM  ${d.name}  emitted-but-no-reader in: ${d.files.join(", ")}`);
}
if (dead.length) {
  console.log(
    `\nFAIL: ${dead.length} emitted URL param(s) have no reader in the web client. ` +
      `Either the client dropped the reader (delete the emitter) or a reader/docs row is missing.`,
  );
}
process.exit(dead.length ? 1 : 0);
