// harness/perf-ratchet.mjs — stored perf HISTORY plus an automatic ratchet
// over hb-results-v2 runs (test-tooling-8, 2026-10-13). Library + CLI.
//
// WHY IT EXISTS
// -------------
// Per run, the measurement is already strict (moving-bench's frame-indexed
// path + REJECT-not-average, flag-bench's interleaved fresh-profile arms,
// report.mjs's @scale tags + mandatory controlSpread). But every comparison
// was an A/B someone asked for — the only diff tool is the pairwise
// scripts/perf-worker/diff-perf.sh — and nothing kept results. A default-ON
// change that adds draws, triangles or programs at the pinned anchor was
// caught only if someone happened to bench it. This keeps every run and holds
// each new one to its own recent past.
//
// THE RULES (after WebAC tools/perf-ratchet-lib.ts findBaselines /
// compareRuns / compareToHistory, AGPL-3.0 — each came from a real false
// alarm there; re-derived for hb-results-v2, not transliterated)
//  1. COMPARABLE only on an identical key: bench + protocol + renderer string
//     + wasmProfile + arm + page query (credentials dropped) + taint[] + spec
//     (anchor, mode, frames, laps) + pathChecksum. Another GPU, a dev wasm
//     (~4x tax), another anchor or a changed path is another population and
//     never a baseline (WebAC's Eastham-vs-Holtburg landmine: 39k vs 15k
//     draws, pure scene difference). commit + distGeneratedAt are RECORDED
//     and surface as taint notes when they moved — never keyed.
//  2. BASELINE = per-metric MEDIAN of the last RATCHET_HISTORY (3) USABLE
//     comparable runs whose own ratchet verdict was not "regression": one
//     regressed run can never bless the next, one outlier never sets the bar.
//     REJECT arms / INVALID runs are kept as evidence, never compared, never
//     baselines (PR-10). A metric missing from any baseline is not compared
//     (no partial medians).
//  3. REGRESSION = worse than tolerance against that median (10% for counts,
//     25% for *Ms) AND worse than EVERY baseline's own recorded value. A value
//     the same code already produced is inside the measured spread = noise
//     (WebAC: same-code SwiftShader runs moved geometries +32%, renderJs p50
//     +72%). With a single baseline rule 3 reduces to the tolerance test.
//     A zero baseline is compared on an absolute COUNT_SLACK instead (0 -> 1
//     is not a 100% regression).
//  4. SOFTWARE (SwiftShader / llvmpipe / WARP ...) or UNKNOWN renderer: only
//     *@submitted and *@resident COUNTS compare. Frame and CPU time there say
//     nothing about a GPU, so *Ms metrics compare only between real-GPU runs.
//  5. INTENDED cost change: by rule 2 a higher level never blesses itself, so
//     the operator rebases ONCE — ingest with `--accept` (moving-bench
//     `--historyAccept`). The run is stamped "accepted" and the baseline
//     window stops at it: the new level is the bar from the next run on.
//
// METRIC SCALARS: a bare-number metric is compared as-is; a `*Ms` stat object
// on p50 and p95; a count stat object (draws@submitted, per-frame) on its mean
// (p50 if no mean). Everything is lower-is-better except names ending in
// Fps/fps/Rate and the run-length count `frames`.
//
// HISTORY: <dir>/history.jsonl — one record per (run, arm), append-only.
//   dir = --history=DIR | $HB_PERF_HISTORY | /mnt/wbterminal2/hb-perf-history
// (external drive: the system disk is ~87% full); created lazily on the first
// append. Each run is compared FIRST, then appended WITH its verdict, because
// rule 2 reads that verdict back. Re-ingesting a run (same key + ts) is a
// no-op ("duplicate").
//
// CLI
//   node harness/perf-ratchet.mjs <results.json>... [--history=DIR]
//        [--dry-run] [--json] [--accept] [--min-baselines=N]
//       ratchet each hb-results-v2 file against history, then append it.
//       exit 0 = ok / no-baseline, 1 = regression, 2 = usage or I/O error.
//   node harness/perf-ratchet.mjs --list [--history=DIR]
//       one line per comparability key: runs, usable, regressions, newest.
//   `moving-bench.mjs --history[=DIR]` runs the ingest step itself.
//
// Pure node (fs + crypto). No browser, no network.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HISTORY_SCHEMA = "hb-perf-history-v1";
export const HISTORY_FILE = "history.jsonl";
export const DEFAULT_HISTORY_DIR = "/mnt/wbterminal2/hb-perf-history";
/** How many recent comparable runs the baseline is the median of. */
export const RATCHET_HISTORY = 3;
export const COUNT_TOLERANCE = 0.10;
export const MS_TOLERANCE = 0.25;
/** Absolute growth a zero-baseline count may show before it is "worse". */
export const COUNT_SLACK = 2;
/** Statistics compared on a `*Ms` stat object. */
export const MS_STATS = Object.freeze(["p50", "p95"]);
/** Page-query keys that identify WHO ran, not WHAT ran. */
const CREDENTIAL_PARAMS = new Set(["account", "password"]);

// ---------------------------------------------------------------------------
// classification
// ---------------------------------------------------------------------------

/** Software rasterizers: frame time there says nothing about a real GPU. */
export function isSoftwareRenderer(renderer) {
  return /swiftshader|llvmpipe|softpipe|swrast|software|basic render driver/i.test(String(renderer ?? ""));
}

/** Real GPU = a recorded renderer string that is not a software one. */
export function isRealGpu(renderer) {
  if (typeof renderer !== "string") return false;
  const r = renderer.trim();
  if (!r || /^(unknown|null|n\/a)$/i.test(r)) return false;
  return !isSoftwareRenderer(r);
}

/** "<name>@<tag>[@<tag>]" (report.mjs validated it at write time). */
function splitKey(key) {
  const [name, ...tags] = String(key).split("@");
  return { name, tags };
}

export function isMsMetric(key) {
  return /Ms$/.test(splitKey(key).name);
}

export function higherIsBetter(key) {
  const { name } = splitKey(key);
  return name === "frames" || /(?:Fps|fps|Rate)$/.test(name);
}

/**
 * Whether one metric is compared for a renderer, and at what tolerance.
 * @returns {{compare: boolean, why?: string, tolerance?: number}}
 */
export function metricPolicy(key, renderer, { countTolerance = COUNT_TOLERANCE, msTolerance = MS_TOLERANCE } = {}) {
  const realGpu = isRealGpu(renderer);
  if (isMsMetric(key)) {
    return realGpu
      ? { compare: true, tolerance: msTolerance }
      : { compare: false, why: "frame/CPU time compares only between real-GPU runs" };
  }
  if (!realGpu) {
    const { tags } = splitKey(key);
    if (!tags.includes("submitted") && !tags.includes("resident")) {
      return { compare: false, why: "software/unknown renderer: only *@submitted / *@resident counts compare" };
    }
  }
  return { compare: true, tolerance: countTolerance };
}

/**
 * Flatten a metrics object into comparable scalars:
 * Map(label -> {key, value}). Labels are the key itself for a number, or
 * `<key>.<stat>` for a stat object.
 */
export function metricScalars(metrics) {
  const out = new Map();
  for (const [key, value] of Object.entries(metrics || {})) {
    if (typeof value === "number") {
      if (Number.isFinite(value)) out.set(key, { key, value });
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const stats = isMsMetric(key)
      ? MS_STATS
      : [Number.isFinite(value.mean) ? "mean" : "p50"];
    for (const s of stats) {
      if (Number.isFinite(value[s])) out.set(`${key}.${s}`, { key, value: value[s] });
    }
  }
  return out;
}

export function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ---------------------------------------------------------------------------
// comparability key + history records
// ---------------------------------------------------------------------------

/** The page query with credentials dropped, params sorted. */
export function normalizedQuery(url) {
  let u;
  try { u = new URL(String(url)); } catch { return String(url ?? ""); }
  return [...u.searchParams]
    .filter(([k]) => !CREDENTIAL_PARAMS.has(k))
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("&");
}

function specKey(spec) {
  if (!spec || typeof spec !== "object") return null;
  const a = spec.anchor;
  return {
    anchor: a && typeof a === "object" ? [a.x ?? null, a.y ?? null, a.z ?? null] : null,
    mode: spec.mode ?? null,
    frames: spec.frames ?? null,
    laps: spec.laps ?? null,
  };
}

/**
 * Rule 1. `parts` is built in a FIXED field order so the JSON string is a
 * stable key; `keyId` is a short hash for display.
 */
export function comparabilityKey(results, arm) {
  const parts = {
    bench: results.bench ?? null,
    protocol: results.protocol ?? null,
    renderer: results.platform?.renderer ?? null,
    wasmProfile: results.wasmProfile ?? "unknown",
    arm: arm?.arm ?? null,
    query: normalizedQuery(results.url),
    taint: [...(Array.isArray(results.taint) ? results.taint : [])].map(String).sort(),
    spec: specKey(arm?.spec),
    pathChecksum: arm?.pathChecksum ?? null,
  };
  const key = JSON.stringify(parts);
  const keyId = createHash("sha1").update(key).digest("hex").slice(0, 12);
  return { key, keyId, parts };
}

/** One history record per arm of an hb-results-v2 object (ratchet unset). */
export function toHistoryRecords(results, { source = null } = {}) {
  if (!results || results.schema !== "hb-results-v2") {
    throw new Error(`perf-ratchet: not an hb-results-v2 object (schema=${JSON.stringify(results?.schema)})`);
  }
  if (!Array.isArray(results.arms) || results.arms.length === 0) {
    throw new Error("perf-ratchet: results carry no arms");
  }
  return results.arms.map((arm) => {
    const { key, keyId, parts } = comparabilityKey(results, arm);
    return {
      schema: HISTORY_SCHEMA,
      key,
      keyId,
      comparable: parts,
      ts: results.ts ?? null,
      bench: results.bench ?? null,
      arm: arm.arm,
      renderer: results.platform?.renderer ?? null,
      box: results.platform?.box ?? null,
      wasmProfile: results.wasmProfile ?? "unknown",
      commit: results.commit ?? null,
      distGeneratedAt: results.distGeneratedAt ?? null,
      armVerdict: arm.verdict ?? null,
      runVerdict: results.verdict ?? null,
      usable: arm.verdict === "USABLE" && results.verdict !== "INVALID",
      metrics: arm.metrics || {},
      source,
      ratchet: null,
    };
  });
}

// ---------------------------------------------------------------------------
// the ratchet
// ---------------------------------------------------------------------------

/**
 * Rule 2: the `n` most recent comparable, USABLE, non-regression runs older
 * than `current`, newest first. An "accepted" run (an operator rebase after an
 * INTENDED cost change, `--accept`) ends the window: nothing older than it is
 * a baseline, so the new level is the bar from the next run on.
 */
export function findBaselines(history, current, n = RATCHET_HISTORY) {
  const sorted = (history || [])
    .filter((r) => r && r.key === current.key && r.usable === true
      && r.ratchet?.verdict !== "regression"
      && typeof r.ts === "string" && typeof current.ts === "string" && r.ts < current.ts)
    .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  const out = [];
  for (const r of sorted) {
    out.push(r);
    if (out.length >= Math.max(1, n) || r.ratchet?.verdict === "accepted") break;
  }
  return out;
}

const round = (v, d = 4) => (Number.isFinite(v) ? +v.toFixed(d) : v);

function provenanceTaint(baselines, current) {
  const notes = [];
  const dists = [...new Set(baselines.map((b) => b.distGeneratedAt).filter((d) => d != null))];
  if (current.distGeneratedAt == null) notes.push("distGeneratedAt unknown for this run");
  else if (dists.some((d) => d !== current.distGeneratedAt)) {
    notes.push(`dist changed since baseline (${dists.join(", ")} -> ${current.distGeneratedAt})`);
  }
  const commits = [...new Set(baselines.map((b) => b.commit).filter((c) => c != null))];
  if (current.commit != null && commits.some((c) => c !== current.commit)) {
    notes.push(`commit moved since baseline (${commits.join(", ")} -> ${current.commit})`);
  }
  return notes;
}

/**
 * Rules 2-4 for one record against its baselines (findBaselines output).
 * @returns {{verdict: "ok"|"regression"|"no-baseline"|"unusable",
 *   realGpu: boolean, baselineCount: number, baselineTs: string[],
 *   regressions: object[], noise: object[], within: object[],
 *   improved: object[], skipped: object[], taint: string[]}}
 */
export function compareToHistory(baselines, current, opts = {}) {
  const minBaselines = Math.max(1, opts.minBaselines ?? 1);
  const countSlack = opts.countSlack ?? COUNT_SLACK;
  const realGpu = isRealGpu(current.renderer);
  const base = {
    realGpu,
    baselineCount: baselines.length,
    baselineTs: baselines.map((b) => b.ts),
    regressions: [], noise: [], within: [], improved: [], skipped: [],
    taint: [],
  };
  if (!current.usable) {
    return { ...base, verdict: "unusable", baselineCount: 0, baselineTs: [] };
  }
  if (baselines.length < minBaselines) return { ...base, verdict: "no-baseline" };
  base.taint = provenanceTaint(baselines, current);

  const cur = metricScalars(current.metrics);
  const bases = baselines.map((b) => metricScalars(b.metrics));
  for (const [label, { key, value }] of cur) {
    const policy = metricPolicy(key, current.renderer, opts);
    if (!policy.compare) { base.skipped.push({ metric: label, why: policy.why }); continue; }
    const seen = bases.map((m) => m.get(label)?.value);
    if (seen.some((v) => !Number.isFinite(v))) {
      base.skipped.push({ metric: label, why: "absent from a baseline (no partial medians)" });
      continue;
    }
    const med = median(seen);
    const hib = higherIsBetter(key);
    let delta;
    let worse;
    let absolute = false;
    if (med <= 0) {
      if (isMsMetric(key)) { base.skipped.push({ metric: label, why: "zero baseline" }); continue; }
      // Relative change is meaningless at zero: an absolute floor instead.
      absolute = true;
      delta = hib ? med - value : value - med;
      worse = delta > countSlack;
    } else {
      // Positive delta = worse, whichever direction is better.
      delta = hib ? 1 - value / med : value / med - 1;
      worse = delta > policy.tolerance;
    }
    const f = {
      metric: label, baseline: round(med), current: round(value), delta: round(delta),
      ...(absolute ? { absolute: true, slack: countSlack } : { tolerance: policy.tolerance }),
    };
    if (!worse) {
      if (!absolute && delta < -policy.tolerance) base.improved.push(f);
      else base.within.push(f);
      continue;
    }
    // Rule 3: no worse than a value one of the baselines itself recorded.
    const insideSpread = baselines.length > 1
      && (hib ? value >= Math.min(...seen) : value <= Math.max(...seen));
    (insideSpread ? base.noise : base.regressions).push(f);
  }
  return { ...base, verdict: base.regressions.length ? "regression" : "ok" };
}

/**
 * Ratchet every arm of one hb-results-v2 object against `history` (records
 * as read back from history.jsonl). Pure: returns the records with their
 * `ratchet` filled, and the subset to append (duplicates are not appended).
 * `accept: true` stamps every compared USABLE arm "accepted" (keeping what it
 * would have said in `acceptedFrom`) — the rebase findBaselines stops at.
 */
export function ratchetResults(results, history, { source = null, n = RATCHET_HISTORY, accept = false, ...opts } = {}) {
  const records = toHistoryRecords(results, { source });
  const toAppend = [];
  for (const rec of records) {
    const pool = (history || []).concat(toAppend);
    if (pool.some((r) => r && r.key === rec.key && r.ts === rec.ts)) {
      rec.ratchet = { verdict: "duplicate", realGpu: isRealGpu(rec.renderer), baselineCount: 0, baselineTs: [],
        regressions: [], noise: [], within: [], improved: [], skipped: [], taint: [] };
      continue;
    }
    rec.ratchet = compareToHistory(findBaselines(pool, rec, n), rec, opts);
    if (accept && rec.ratchet.verdict !== "unusable") {
      rec.ratchet = { ...rec.ratchet, verdict: "accepted", acceptedFrom: rec.ratchet.verdict };
    }
    toAppend.push(rec);
  }
  return { records, toAppend };
}

// ---------------------------------------------------------------------------
// history I/O
// ---------------------------------------------------------------------------

/** --history=DIR wins, then $HB_PERF_HISTORY, then the external-drive default. */
export function resolveHistoryDir(explicit, env = process.env) {
  if (typeof explicit === "string" && explicit.length) return explicit;
  return (env && env.HB_PERF_HISTORY) || DEFAULT_HISTORY_DIR;
}

/** Read history.jsonl; a missing file is an empty history. */
export function readHistory(dir) {
  const file = path.join(dir, HISTORY_FILE);
  if (!existsSync(file)) return { file, records: [], badLines: 0 };
  const records = [];
  let badLines = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && r.schema === HISTORY_SCHEMA && typeof r.key === "string") records.push(r);
      else badLines += 1;
    } catch { badLines += 1; }
  }
  return { file, records, badLines };
}

/** Append records (creates the directory lazily). Returns the file path. */
export function appendHistory(dir, records) {
  const file = path.join(dir, HISTORY_FILE);
  if (!records || records.length === 0) return file;
  mkdirSync(dir, { recursive: true });
  appendFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return file;
}

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

const pctOrAbs = (f) => (f.absolute
  ? `${f.delta > 0 ? "+" : ""}${f.delta} abs > slack ${f.slack}`
  : `${f.delta > 0 ? "+" : ""}${(f.delta * 100).toFixed(1)}% vs ${(f.tolerance * 100).toFixed(0)}% tol`);

/** Human-readable block for one ratcheted record. */
export function formatRatchet(rec) {
  const r = rec.ratchet || {};
  const head = `[ratchet] ${rec.bench} arm=${rec.arm} key=${rec.keyId} renderer=${rec.renderer ?? "?"} `
    + `wasm=${rec.wasmProfile} -> ${String(r.verdict || "?").toUpperCase()}`;
  const lines = [head];
  if (r.verdict === "unusable") lines.push("    (REJECT/INVALID run: recorded as evidence, never compared or used as a baseline)");
  if (r.verdict === "duplicate") lines.push("    (already in history: same key + ts; not appended)");
  if (r.verdict === "no-baseline") lines.push(`    (${r.baselineCount} comparable baseline(s) in history; this run seeds it)`);
  if (r.verdict === "accepted") lines.push(`    (operator-accepted rebase, would have been ${String(r.acceptedFrom).toUpperCase()}: older runs are no longer baselines)`);
  if (r.baselineCount && r.verdict !== "no-baseline") {
    lines.push(`    baseline: median of ${r.baselineCount} (${r.baselineTs.join(", ")})${r.realGpu ? "" : "  [software/unknown renderer: counts only]"}`);
  }
  for (const f of r.regressions || []) lines.push(`    ! ${f.metric}  ${f.current} vs ${f.baseline} (${pctOrAbs(f)}; worse than every baseline)`);
  for (const f of r.noise || []) lines.push(`    ~ ${f.metric}  ${f.current} vs ${f.baseline} (${pctOrAbs(f)}; inside the baselines' spread = noise)`);
  for (const f of r.improved || []) lines.push(`    + ${f.metric}  ${f.current} vs ${f.baseline} (${pctOrAbs(f)})`);
  if ((r.within || []).length) lines.push(`    = ${r.within.length} metric(s) within tolerance`);
  if ((r.skipped || []).length) {
    const why = new Map();
    for (const s of r.skipped) why.set(s.why, (why.get(s.why) || []).concat(s.metric));
    for (const [w, ms] of why) lines.push(`    - skipped (${w}): ${ms.join(", ")}`);
  }
  for (const t of r.taint || []) lines.push(`    taint: ${t}`);
  return lines.join("\n");
}

/** One line per comparability key. */
export function summarizeHistory(records) {
  const byKey = new Map();
  for (const r of records) {
    const e = byKey.get(r.key) || { keyId: r.keyId, bench: r.bench, arm: r.arm, renderer: r.renderer, wasmProfile: r.wasmProfile, runs: 0, usable: 0, regressions: 0, newest: null };
    e.runs += 1;
    if (r.usable) e.usable += 1;
    if (r.ratchet?.verdict === "regression") e.regressions += 1;
    if (!e.newest || (r.ts && r.ts > e.newest)) e.newest = r.ts;
    byKey.set(r.key, e);
  }
  return [...byKey.values()].sort((a, b) => (a.newest < b.newest ? 1 : -1));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opt = { files: [], history: null, dryRun: false, json: false, list: false, accept: false, minBaselines: 1 };
  for (const a of argv) {
    if (a === "--dry-run") opt.dryRun = true;
    else if (a === "--accept") opt.accept = true;
    else if (a === "--json") opt.json = true;
    else if (a === "--list") opt.list = true;
    else if (a.startsWith("--history=")) opt.history = a.slice("--history=".length);
    else if (a.startsWith("--min-baselines=")) opt.minBaselines = Number(a.slice("--min-baselines=".length));
    else if (a === "-h" || a === "--help") opt.help = true;
    else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else opt.files.push(a);
  }
  if (!Number.isInteger(opt.minBaselines) || opt.minBaselines < 1) throw new Error("--min-baselines must be an integer >= 1");
  return opt;
}

const USAGE = "usage: node harness/perf-ratchet.mjs <results.json>... [--history=DIR] [--dry-run] [--json] [--accept] [--min-baselines=N]\n"
  + "       node harness/perf-ratchet.mjs --list [--history=DIR]\n"
  + `history dir: --history=DIR | $HB_PERF_HISTORY | ${DEFAULT_HISTORY_DIR}`;

export function main(argv, env = process.env) {
  let opt;
  try { opt = parseArgs(argv); } catch (e) { console.error(`perf-ratchet: ${e.message}\n${USAGE}`); return 2; }
  if (opt.help) { console.log(USAGE); return 0; }
  const dir = resolveHistoryDir(opt.history, env);
  const { records: history, badLines, file } = readHistory(dir);
  if (badLines) console.warn(`perf-ratchet: ${badLines} unreadable line(s) in ${file} skipped`);
  if (opt.list) {
    const rows = summarizeHistory(history);
    if (opt.json) console.log(JSON.stringify(rows, null, 2));
    else if (!rows.length) console.log(`perf-ratchet: no history at ${file}`);
    else for (const e of rows) {
      console.log(`${e.keyId}  ${e.bench}  arm=${e.arm}  ${e.wasmProfile}  runs=${e.runs} usable=${e.usable} regressions=${e.regressions}  newest=${e.newest}  renderer=${e.renderer ?? "?"}`);
    }
    return 0;
  }
  if (!opt.files.length) { console.error(USAGE); return 2; }

  let pool = history;
  let regression = false;
  const all = [];
  for (const f of opt.files) {
    let obj;
    try { obj = JSON.parse(readFileSync(f, "utf8")); } catch (e) {
      console.error(`perf-ratchet: cannot read ${f}: ${e.message}`);
      return 2;
    }
    let out;
    try { out = ratchetResults(obj, pool, { source: path.resolve(f), minBaselines: opt.minBaselines, accept: opt.accept }); } catch (e) {
      console.error(`perf-ratchet: ${f}: ${e.message}`);
      return 2;
    }
    if (!opt.dryRun) {
      try { appendHistory(dir, out.toAppend); } catch (e) {
        console.error(`perf-ratchet: cannot append to ${path.join(dir, HISTORY_FILE)}: ${e.message} `
          + "(set HB_PERF_HISTORY or --history=DIR)");
        return 2;
      }
    }
    pool = pool.concat(out.toAppend);
    for (const rec of out.records) {
      all.push(rec);
      if (rec.ratchet?.verdict === "regression") regression = true;
      if (!opt.json) console.log(formatRatchet(rec));
    }
  }
  if (opt.json) console.log(JSON.stringify(all.map((r) => ({ keyId: r.keyId, arm: r.arm, ts: r.ts, ratchet: r.ratchet })), null, 2));
  if (!opt.json) console.log(`perf-ratchet: ${opt.dryRun ? "dry run, nothing appended" : `history ${path.join(dir, HISTORY_FILE)}`}`);
  return regression ? 1 : 0;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) process.exit(main(process.argv.slice(2)));
