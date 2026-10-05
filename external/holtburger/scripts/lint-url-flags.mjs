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
    // 2026-10-05 — the sites the mechanical presenceVerdict cannot prove,
    // read by eye. (The 14 above now verify mechanically; kept for history.)
    diag: "index.js eventLogEnabled: bare URL → early `return false`; absent diag+eventLog → `=== \"on\" || === \"1\"` → false — consistent",
    eventLog: "same IIFE as `diag` (index.js eventLogEnabled) — consistent",
    lbLruDebug: "index.js: `let lbLruDebug = false` ~12 lines above the guard; inner `=== \"1\"` → absent false — consistent",
  },
  // KNOWN BUGS — real reader divergences the lint has PROVEN, left in the app
  // because app code is out of scope for the change that wired this gate
  // (2026-10-05). These are NOT known-good; each names the fix. The gate stays
  // green on them so it can block NEW regressions, and an entry whose finding
  // disappears is reported as STALE so the list cannot outlive its bug.
  "PRESENCE-DIVERGENT": {
    particleOwner:
      "BUG scene3d/particles/owner_registry.js:56 — `if (globalThis.location?.search)` guard: a bare URL " +
      "(no query) reads OFF while any query reads ON (docs row: default ON). Fix: drop the presence " +
      "guard / default `on = true`.",
    blockingParticleParity:
      "BUG scene3d/statics.js:4287 `_blockingParticleParityOn` — same presence-guard shape: bare URL → " +
      "false, any query → ON (docs: default ON). Observationally inert for statics today (comment above " +
      "it), but the walkers disagree. Fix: `return true` fallback.",
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
    if (!/URLSearchParams|location\??\.search/.test(ctx)) continue;
    for (const m of lines[i].matchAll(GET_RE)) {
      const name = m[1];
      // Statement window for classification: this line + next 3 (chained
      // ternaries / comparisons often wrap).
      const stmt = lines.slice(i, Math.min(lines.length, i + 4)).join("\n");
      // Presence-guard heuristic: an enclosing `if (` within the previous
      // 6 lines that tests location.search truthiness (not just `|| ""`).
      const pre = lines.slice(Math.max(0, i - 6), i).join("\n");
      // 2026-10-05: `location?.search` (optional chaining) counts too — the
      // `location\.search`-only regex missed `globalThis.location?.search`
      // guards entirely (scene3d/particles/owner_registry.js particleOwner).
      const presenceGuard =
        /if\s*\([^)]*location\??\.search[^)]*\)/.test(pre) &&
        !/location\??\.search\s*(?:\|\||\?\?)/.test(pre);
      const list = readers.get(name) || [];
      list.push({
        file: path.relative(ROOT, f), line: i + 1, stmt, presenceGuard,
        // context for the presence-guard verdict (below)
        preCtx: presenceGuard ? lines.slice(Math.max(0, i - 8), i).join("\n") : "",
        postCtx: presenceGuard ? lines.slice(i, Math.min(lines.length, i + 18)).join("\n") : "",
      });
      readers.set(name, list);
    }
  }
}

// ── presence-guard verdict (2026-10-05) ─────────────────────────────────────
// A read inside `if (location.search) { … }` only diverges when the INNER
// branch makes an UNCONDITIONAL decision from the param (`return get(x) !==
// "off"` / `on = get(x) === "on"`) whose absent-param answer differs from the
// OUTER fallback the bare URL takes. Every other shape is consistent by
// construction: a raw capture (`const v = get(x)`) or a conditional
// assignment (`if (v === "off") on = false`) leaves the outer default in
// force when the param is absent. This turns the old "read every site by eye"
// waiver list into a mechanical check that only surfaces the real divergences
// (particleOwner was one the regex never even saw). Unprovable shapes stay
// findings, so the heuristic can never hide a site it does not understand.
function presenceVerdict(s, name) {
  const all = s.preCtx + "\n" + s.postCtx;
  const at = s.preCtx.length + 1 + Math.max(0, s.postCtx.search(new RegExp(`get\\(\\s*["']${name}["']`)));
  // The whole statement holding the read: back to the previous `;`/`{`/`}`,
  // forward to the next `;`.
  const start = Math.max(all.lastIndexOf(";", at), all.lastIndexOf("{", at), all.lastIndexOf("}", at)) + 1;
  const end = all.indexOf(";", at);
  const stmt = all.slice(start, end >= 0 ? end : all.length).replace(/\/\/[^\n]*/g, "").trim();
  const decides = /[!=]==?\s*["'][^"']*["']/.test(stmt);
  const unconditional = /^(?:return\b|[A-Za-z_$][\w$.]*\s*=(?!=))/.test(stmt);
  if (!decides || !unconditional) {
    return { verdict: "consistent", why: "raw capture / conditional assignment — absent param keeps the outer default" };
  }
  // Absent-param value of `get(x)…<op> "tok"`: undefined/null never equals a
  // literal, so `!==`/`!=` yields true and `===`/`==` yields false. Only a
  // single comparison (no &&/||/?:) is evaluated; anything richer is unknown.
  const cmps = stmt.match(/[!=]==?\s*["'][^"']*["']/g) || [];
  if (cmps.length !== 1 || /&&|\|\||\?(?!\.)/.test(stmt.replace(/\?\./g, ""))) {
    return { verdict: "unknown", why: "compound expression — could not prove the inner/outer defaults; read the site" };
  }
  let inner = cmps[0].startsWith("!");
  if (/^(?:return\s*)?!\s*\(/.test(stmt.replace(/^[A-Za-z_$][\w$.]*\s*=\s*/, ""))) inner = !inner;
  // Outer (bare-URL) default: `let x = bool;` before the guard, an early
  // `if (… !…location…search) return bool;`, or a `return bool;` after it.
  const letM = /(?:let|var)\s+[\w$]+\s*=\s*(true|false)\s*;(?![^]*(?:let|var)\s+[\w$]+\s*=\s*(?:true|false)\s*;)/.exec(s.preCtx);
  const earlyM = /if\s*\([^)]*!\s*[\w$.]*location\??\.search[^)]*\)\s*return\s+(true|false)\s*;/.exec(s.preCtx);
  const after = all.slice(end >= 0 ? end : at);
  const retM = /\}\s*(?:catch\s*(?:\([^)]*\))?\s*\{[^}]*\}\s*)?(?:\/\/[^\n]*\s*)*return\s+(true|false)\s*;/.exec(after);
  const pick = earlyM || letM || retM;
  if (!pick) return { verdict: "unknown", why: "could not find the bare-URL fallback — read the site" };
  const outer = pick[1] === "true";
  if (inner === outer) return { verdict: "consistent", why: `absent=${inner} == bare-URL=${outer}` };
  return {
    verdict: "divergent",
    why: `absent param resolves ${inner ? "ON" : "OFF"} on any URL WITH a query, but a bare URL (no query at all) resolves ${outer ? "ON" : "OFF"}`,
  };
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
      const v = presenceVerdict(s, name);
      if (v.verdict !== "consistent") {
        findings.push({
          kind: v.verdict === "divergent" ? "PRESENCE-DIVERGENT" : "PRESENCE-GUARD",
          flag: name,
          detail: `${s.file}:${s.line} read inside if(location.search) — ${v.why}`,
        });
      }
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
// Known-bug allowlist hygiene: an entry whose finding no longer fires means
// the bug was fixed (or the reader moved) — fail so the entry gets removed
// instead of silently pre-waiving the next regression of that flag.
const staleBugWaivers = Object.keys(WAIVERS["PRESENCE-DIVERGENT"]).filter(
  (flag) => !findings.some((f) => f.kind === "PRESENCE-DIVERGENT" && f.flag === flag),
);
for (const flag of staleBugWaivers) {
  console.log(`STALE-WAIVER  ${flag}  PRESENCE-DIVERGENT no longer fires — remove it from WAIVERS (bug fixed?)`);
}
const knownBugs = waived.filter((f) => f.kind === "PRESENCE-DIVERGENT");
if (knownBugs.length) {
  console.log(`(${knownBugs.length} KNOWN-BUG divergence(s) allowlisted: ${knownBugs.map((f) => f.flag).join(", ")} — see WAIVERS["PRESENCE-DIVERGENT"])`);
}
process.exit(active.length || staleBugWaivers.length ? 1 : 0);
