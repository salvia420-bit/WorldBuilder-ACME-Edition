#!/usr/bin/env node
// scripts/lint-url-flags.mjs — W3 net-fixwave (2026-07-10): URL-flag reader ↔
// docs lint. The era produced 5+ reader/docs mismatches; the standing footgun
// classes are (a) a reader coded `!== "off"` that ignores the documented
// `0`/`false` spellings, (b) defaults guarded on `location.search` PRESENCE
// (bare URL ≠ any-flag URL — A08-5's envcellFusion), and (c) flags with a
// reader but no docs row (or a docs row with no reader).
//
// Mechanical, dependency-free, deliberately heuristic: it parses
// `apps/holtburger-web/docs/url-flags.md` table rows and sweeps
// `index.html` + `scene3d/**/*.js` for `URLSearchParams….get("flag")` reader
// sites, then reports:
//   UNDOCUMENTED  reader exists, no docs row
//   NO-READER     docs row exists, no reader found in the swept tree
//                 (wasm-side readers and js_sys reads are NOT swept — waive)
//   OFF-SPELLING  the reader's statement tests `!== "off"` (or `=== "off"`)
//                 without also handling `0`/`false`
//   PRESENCE-GUARD the read sits inside an `if (…location.search…)` block —
//                 review that the absent-flag default matches the flagged one
//
// Exit 1 when any finding is not in the WAIVERS list below. Run:
//   node scripts/lint-url-flags.mjs [--app apps/holtburger-web] [--verbose]
import fs from "node:fs";
import path from "node:path";

const argIdx = process.argv.indexOf("--app");
const APP = argIdx >= 0 ? process.argv[argIdx + 1] : "apps/holtburger-web";
const VERBOSE = process.argv.includes("--verbose");
const ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const appDir = path.join(ROOT, APP);

// ── waivers: known-good exceptions, each with a reason ──────────────────────
const WAIVERS = {
  UNDOCUMENTED: {
    // account/password/autoSpawn etc. are boot CREDENTIAL params, not
    // behavior flags; documented in the headless-login runbooks instead.
    account: "boot credential param (headless-login contract)",
    password: "boot credential param",
    autoSpawn: "boot param (headless-login contract)",
    autoLogin: "boot param (headless-login contract)",
    kickDance: "boot param (headless-login contract)",
    character: "boot param (character picker)",
    server: "boot param (server picker)",
    agent: "boot param (wire-agent mode)",
  },
  "NO-READER": {
    // wasm-side readers (js_sys::Reflect / init args) — not in the JS sweep.
    surfaceNegCache:
      "JS tier read in materials.js IS swept; row also describes the wasm memo",
  },
  "OFF-SPELLING": {
    // `=== "1"`-style OPT-INS and numeric flags — no off-spelling needed.
    spawnTrace: 'opt-in `=== "1"`',
    noSpawnTimeSlice: 'opt-in `=== "1"` (inverted flag)',
    noEnvcellTimeSlice: 'opt-in `=== "1"` (inverted flag)',
    nullRender: "presence/on opt-in (frozen-render contract)",
    wireframe: "multi-value (on/fill/off) — handled by a value switch",
  },
  "PRESENCE-GUARD": {
    // W3 adjudication 2026-07-10: all 14 guarded readers were read by eye —
    // in every one the OUTER fallback equals the inner absent-param default
    // (e.g. `let x = true; if (search) x = get(...) !== "off"` — true either
    // way; or an `=== "on"` allowlist over an outer false). The ONLY
    // divergent case in the tree was envcellFusion (outer false, inner
    // ON-when-absent — A08-5), FIXED this wave. New divergences will surface
    // here un-waived.
    cellBugParity: '=== "retail" allowlist, outer false — consistent',
    cellStaticBias: "outer true == inner absent-default",
    foliageStrictSeason: "on/1/true/yes allowlist, outer false — consistent",
    freezeStaticMatrix: "outer true == inner absent-default",
    indoorPvsRing: "numeric; outer default == inner absent-default",
    noEnvcellTimeSlice: "outer true (slice on) == inner absent-default",
    noStaticsTimeSlice: "outer true (slice on) == inner absent-default",
    profileStatics: "opt-in over outer false — consistent",
    pvsBakeCap: "numeric; outer default == inner absent-default",
    pvsStreamQueue: "structured default duplicated outside the guard",
    sealedCull: "outer true == inner absent-default",
    sealedEvict: "outer true == inner absent-default",
    staticsRingTimeSlice: "outer true == inner absent-default",
    bakePrewarm: "outer true == inner absent-default",
  },
};

// ── collect files ───────────────────────────────────────────────────────────
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      if (["node_modules", "pkg", "dist", "legacy"].includes(e.name)) continue;
      walk(p);
    } else if (/\.(js|mjs|html)$/.test(e.name)) {
      files.push(p);
    }
  }
})(path.join(appDir, "scene3d"));
files.push(path.join(appDir, "index.html"));

// ── docs rows ───────────────────────────────────────────────────────────────
const docsPath = path.join(appDir, "docs", "url-flags.md");
const docs = fs.readFileSync(docsPath, "utf8");
const docFlags = new Map(); // name → accepted-col text
for (const m of docs.matchAll(/^\| `([A-Za-z_][A-Za-z0-9_]*)`(?:=[^`]*)? \|([^|]*)\|/gm)) {
  docFlags.set(m[1], m[2].trim());
}

// ── reader sweep ────────────────────────────────────────────────────────────
const readers = new Map(); // name → [{file, line, stmt, presenceGuard}]
const GET_RE = /\.get\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\)/g;
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    // Only URLSearchParams-context reads: a ±10-line window must mention
    // URLSearchParams or location.search (readers often stash the params
    // object in a variable a few lines above the .get()).
    const ctx = lines.slice(Math.max(0, i - 10), i + 3).join("\n");
    if (!/URLSearchParams|location\.search/.test(ctx)) continue;
    for (const m of lines[i].matchAll(GET_RE)) {
      const name = m[1];
      // Statement window for classification: this line + next 3 (chained
      // ternaries / comparisons often wrap).
      const stmt = lines.slice(i, Math.min(lines.length, i + 4)).join("\n");
      // Presence-guard heuristic: an enclosing `if (` within the previous
      // 6 lines that tests location.search truthiness (not just `|| ""`).
      const pre = lines.slice(Math.max(0, i - 6), i).join("\n");
      const presenceGuard =
        /if\s*\([^)]*location\.search[^)]*\)/.test(pre) &&
        !/location\.search\s*\|\|/.test(pre);
      const list = readers.get(name) || [];
      list.push({ file: path.relative(ROOT, f), line: i + 1, stmt, presenceGuard });
      readers.set(name, list);
    }
  }
}

// Second idiom: regex-literal readers on location.search, e.g.
// /[?&]entDrainBudget=(?:off|0|false)(?:&|$)/.test(location.search).
const RX_RE = /\[\?&\]([A-Za-z_][A-Za-z0-9_]*)[=)]/g;
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (!/\.test\(/.test(lines[i]) && !/\.test\(/.test(lines[i + 1] || "")) continue;
    for (const m of lines[i].matchAll(RX_RE)) {
      const name = m[1];
      const stmt = lines.slice(i, Math.min(lines.length, i + 3)).join("\n");
      const list = readers.get(name) || [];
      list.push({ file: path.relative(ROOT, f), line: i + 1, stmt, presenceGuard: false });
      readers.set(name, list);
    }
  }
}

// ── classify ────────────────────────────────────────────────────────────────
const findings = []; // {kind, flag, detail}
for (const [name, sites] of readers) {
  if (!docFlags.has(name)) {
    findings.push({
      kind: "UNDOCUMENTED",
      flag: name,
      detail: sites.map((s) => `${s.file}:${s.line}`).join(", "),
    });
  }
  // Docs contract for this flag: does the accepted-spellings column
  // promise `0`/`false`? Only a reader that DIVERGES from its own row is
  // a failure — an off-only reader whose row also says only `off` is
  // consistent (merely stylistically narrow).
  const docsAccepted = docFlags.get(name) || "";
  const docsPromiseZeroFalse = /`0`|`false`|\b0\b\/|\/0\b|false/.test(docsAccepted);
  for (const s of sites) {
    const testsOff = /[!=]==?\s*["']off["']/.test(s.stmt);
    const testsZeroFalse = /["']0["']|["']false["']/.test(s.stmt);
    const allowList = /===?\s*["'](on|1|true)["']/.test(s.stmt);
    if (testsOff && !testsZeroFalse && !allowList && docsPromiseZeroFalse) {
      findings.push({
        kind: "OFF-SPELLING",
        flag: name,
        detail: `${s.file}:${s.line} tests "off" only but docs promise 0/false ("${docsAccepted.slice(0, 40)}")`,
      });
    }
    if (s.presenceGuard) {
      findings.push({
        kind: "PRESENCE-GUARD",
        flag: name,
        detail: `${s.file}:${s.line} read inside if(location.search) — bare-URL default may diverge`,
      });
    }
  }
}
for (const name of docFlags.keys()) {
  if (!readers.has(name)) {
    findings.push({ kind: "NO-READER", flag: name, detail: "no JS reader found in sweep" });
  }
}

// ── report ──────────────────────────────────────────────────────────────────
const active = [];
const waived = [];
const STRICT = process.argv.includes("--strict");
for (const f of findings) {
  if (f.kind === "UNDOCUMENTED" && !STRICT) {
    // ~60 readers predate the docs contract; backfilling their rows is the
    // owed follow-up (tracked by this count). `--strict` fails on them so
    // CI can ratchet once the backfill lands.
    waived.push(f);
  } else if (f.kind === "NO-READER") {
    // Informational only: wasm-side readers (js_sys), helper fns with
    // dynamic names (_readSpawnSliceFlag), and quality.js's flag-name
    // string lists are all legitimate idioms this sweep cannot prove.
    waived.push(f);
  } else if (WAIVERS[f.kind] && Object.prototype.hasOwnProperty.call(WAIVERS[f.kind], f.flag)) {
    waived.push(f);
  } else {
    active.push(f);
  }
}
console.log(
  `lint-url-flags: ${docFlags.size} documented flags, ${readers.size} distinct JS readers, ` +
    `${findings.length} raw findings (${waived.length} waived/informational; ` +
    `${findings.filter((f) => f.kind === "UNDOCUMENTED").length} undocumented readers owed docs rows — run --strict to fail on them)`,
);
if (VERBOSE) {
  console.log("\n— census (flag → reader sites) —");
  for (const [name, sites] of [...readers].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(
      `  ${name}${docFlags.has(name) ? "" : "  [UNDOCUMENTED]"} → ` +
        sites.map((s) => `${s.file}:${s.line}`).join(", "),
    );
  }
  for (const f of waived) console.log(`  WAIVED ${f.kind} ${f.flag}: ${WAIVERS[f.kind][f.flag]}`);
}
for (const f of active.sort((a, b) => a.kind.localeCompare(b.kind) || a.flag.localeCompare(b.flag))) {
  console.log(`${f.kind}  ${f.flag}  ${f.detail}`);
}
process.exit(active.length ? 1 : 0);
