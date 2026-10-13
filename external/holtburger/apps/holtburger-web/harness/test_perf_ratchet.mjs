// harness/test_perf_ratchet.mjs — Tier-5 test for the perf history ratchet
// (harness/perf-ratchet.mjs), the custom-section wasm profile detector
// (harness/lib/wasm_profile.mjs) and moving-bench's provenance probe
// (test-tooling-8, 2026-10-13).
//
// Pure Node. Run: node harness/test_perf_ratchet.mjs — exit 0/1.
// No browser, no network: hb-results-v2 objects are synthetic but built with
// the real report writer (lib/report.mjs), wasm modules are hand-assembled
// bytes (checked with WebAssembly.validate), and the page probe runs in a
// node:vm context with stub GL/fetch. Temp dirs are removed on exit.
//
// WHAT IT PINS (the verifier's test plan, plus the CLI contract)
//   1. another renderer or another anchor is never a baseline
//   2. a run whose own ratchet verdict was "regression" is never a baseline
//      (one regressed run cannot bless the next)
//   3. the baseline is the per-metric median of the last 3 comparable runs
//   4. a value inside the baselines' recorded spread is noise, not regression
//   5. on SwiftShader a frameMs blow-up is ignored while draws@submitted +15%
//      is flagged; on a real GPU the frameMs blow-up IS flagged
//   6. wasmProfile: a `name` (or .debug_*) custom section = DEV-WASM, none =
//      release; size is only a fallback (> 12 MB) for unwalkable bytes
//   7. history JSONL round-trip, duplicate ingest, CLI exit codes
//   plus: --accept rebases the window; moving-bench's page probe (run in
//   node:vm) and toResultsV2 provenance; programs@resident without --linkProbe

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { createReport } from "./lib/report.mjs";
import {
  wasmCustomSectionNames, classifyWasmProfile, detectWasmProfile, DEV_SIZE_FALLBACK_BYTES,
} from "./lib/wasm_profile.mjs";
import {
  isSoftwareRenderer, isRealGpu, metricPolicy, metricScalars, median, normalizedQuery,
  comparabilityKey, toHistoryRecords, findBaselines, compareToHistory, ratchetResults,
  readHistory, appendHistory, resolveHistoryDir, formatRatchet, summarizeHistory,
  DEFAULT_HISTORY_DIR, HISTORY_FILE, RATCHET_HISTORY,
} from "./perf-ratchet.mjs";
import { provenanceProbeSource, provenanceFields, toResultsV2 } from "./moving-bench.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
const ok = (cond, label) => {
  if (cond) { passed++; }
  else { failed++; console.error(`  FAIL ${label}`); }
};
const throwsWith = (fn, needle, label) => {
  try { fn(); ok(false, `${label} (expected throw containing "${needle}")`); }
  catch (e) { ok(String(e.message).includes(needle), `${label} (got: ${String(e.message).slice(0, 100)})`); }
};

const SWIFTSHADER = "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)";
const GTX1070 = "ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 (0x00001B81) Direct3D11 vs_5_0 ps_5_0, D3D11)";
const HOLTBURGER = { x: 25171, y: 20344, z: 42 };
const BASE_URL = "http://127.0.0.1:8765/apps/holtburger-web/index.html?nosw=1&quality=mid&renderDiag=on"
  + "&camDebug=on&vfxGauge=on&autoLogin=1&account=agentp07&password=agentp07&autoSpawn=first&agent=1"
  + "&renderOnDemand=1&netDrainHz=30";

const ts = (i) => `2026-10-13T00:00:${String(i).padStart(2, "0")}.000Z`;

/** Metrics in the exact shape moving-bench's toResultsV2 emits. */
function metrics({ draws = 400, ktris = 800, inst = 5400, frame = 16, cpu = 8, relinks = null } = {}) {
  const m = {
    "frameMs@moving": { n: 600, p50: frame, p95: +(frame * 1.3).toFixed(2), mean: frame },
    "cpuMs@moving": { n: 600, p50: cpu, p95: +(cpu * 1.5).toFixed(2), mean: cpu },
    "draws@submitted": { n: 600, p50: draws, mean: draws, min: draws, max: draws },
    "ktris@submitted": { n: 600, p50: ktris, mean: ktris },
    "instances@resident": inst,
  };
  if (relinks != null) m["programsRelinked@moving"] = relinks;
  return m;
}

/** One hb-results-v2 run, built with the real writer. */
function run(i, {
  renderer = SWIFTSHADER, wasmProfile = "release", anchor = HOLTBURGER, arm = "(default)",
  armVerdict = "USABLE", url = BASE_URL, taint = [], commit = "abc", dist = "2026-10-12T04:53:00-02:30",
  ...m
} = {}) {
  return createReport({
    bench: "MOVE-FIX", protocol: "PC-3", url, ts: ts(i), wasmProfile, commit,
    distGeneratedAt: dist, platform: { box: null, renderer }, taint,
  })
    .addArm({
      arm, verdict: armVerdict,
      rejectReasons: armVerdict === "REJECT" ? ["SHORT (10/600 frames)"] : [],
      metrics: metrics(m),
      spec: { mode: "orbit", frames: 600, laps: 1, anchor, dist: 26 },
      pathChecksum: "c0ffee",
    })
    .setVerdict(armVerdict === "USABLE" ? "EXPLORATORY" : "INVALID")
    .toJSON();
}

/** history records with an already-decided ratchet verdict. */
function rec(i, opts = {}, verdict = "ok") {
  const [r] = toHistoryRecords(run(i, opts));
  r.ratchet = { verdict };
  return r;
}
const current = (i, opts) => toHistoryRecords(run(i, opts))[0];
const find = (list, metric) => list.find((f) => f.metric === metric);

// ── classification primitives ──────────────────────────────────────────────
{
  ok(isSoftwareRenderer(SWIFTSHADER) && isSoftwareRenderer("llvmpipe (LLVM 15.0.7, 256 bits)"), "SwiftShader/llvmpipe are software");
  ok(isSoftwareRenderer("ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11)"), "WARP (Basic Render Driver) is software");
  ok(!isSoftwareRenderer(GTX1070) && isRealGpu(GTX1070), "GTX 1070 is a real GPU");
  ok(!isRealGpu(null) && !isRealGpu("") && !isRealGpu("unknown"), "unknown renderer is NOT a real GPU (counts only)");
  ok(metricPolicy("frameMs@moving", SWIFTSHADER).compare === false, "frameMs not compared on SwiftShader");
  ok(metricPolicy("cpuMs@moving", SWIFTSHADER).compare === false, "cpuMs not compared on SwiftShader");
  ok(metricPolicy("draws@submitted", SWIFTSHADER).tolerance === 0.10, "draws@submitted compared at 10% on SwiftShader");
  ok(metricPolicy("instances@resident", null).compare === true, "@resident counts compared on an unknown renderer");
  ok(metricPolicy("programsRelinked@moving", SWIFTSHADER).compare === false, "non-submitted/resident count skipped on SwiftShader");
  ok(metricPolicy("frameMs@moving", GTX1070).tolerance === 0.25, "frameMs compared at 25% on a real GPU");
  ok(median([3, 1, 2]) === 2 && median([4, 1, 3, 2]) === 2.5, "median odd/even");
  const s = metricScalars(metrics({ draws: 410, frame: 20 }));
  ok(s.get("draws@submitted.mean").value === 410 && !s.has("draws@submitted.p50"), "count stat object compared on its mean");
  ok(s.get("frameMs@moving.p50").value === 20 && s.has("frameMs@moving.p95"), "*Ms stat object compared on p50 + p95");
  ok(s.get("instances@resident").value === 5400, "bare-number count compared as-is");
}

// ── comparability key ───────────────────────────────────────────────────────
{
  const a = comparabilityKey(run(1), run(1).arms[0]);
  const otherAccount = run(1, { url: BASE_URL.replace(/agentp07/g, "agentp08") });
  ok(comparabilityKey(otherAccount, otherAccount.arms[0]).key === a.key, "credentials (account/password) do not split the key");
  ok(!normalizedQuery(BASE_URL).includes("password"), "normalized query drops the password");
  const raf = run(1, { url: BASE_URL.replace("&renderOnDemand=1", "") });
  ok(comparabilityKey(raf, raf.arms[0]).key !== a.key, "sampling mode (renderOnDemand) splits the key");
  const dev = run(1, { wasmProfile: "DEV-WASM" });
  ok(comparabilityKey(dev, dev.arms[0]).key !== a.key, "wasmProfile splits the key (dev wasm ~4x tax)");
  const tainted = run(1, { taint: ["linkProbe"] });
  ok(comparabilityKey(tainted, tainted.arms[0]).key !== a.key, "taint[] splits the key");
  const moved = run(1, { commit: "def", dist: "2026-10-13T00:00:00Z" });
  ok(comparabilityKey(moved, moved.arms[0]).key === a.key, "commit/distGeneratedAt are recorded, NOT keyed");
  ok(/^[0-9a-f]{12}$/.test(a.keyId), "keyId is a short hash");
  throwsWith(() => toHistoryRecords({ schema: "hb-results-v1", arms: [] }), "not an hb-results-v2", "non-v2 input refused");
}

// ── 1. another renderer / another anchor is never a baseline ───────────────
{
  const history = [
    rec(1, { draws: 400 }),
    rec(2, { draws: 300, renderer: GTX1070 }),
    rec(3, { draws: 300, anchor: { x: 23000, y: 10000, z: 60 } }), // another town
  ];
  const cur = current(9, { draws: 400 });
  const b = findBaselines(history, cur);
  ok(b.length === 1 && b[0].ts === ts(1), "only the same-renderer, same-anchor run is a baseline");
  const v = compareToHistory(b, cur);
  ok(v.verdict === "ok" && find(v.within, "draws@submitted.mean").baseline === 400, "compared against the comparable run only");
  ok(findBaselines(history, current(0, { draws: 400 })).length === 0, "a baseline must be OLDER than the current run");
  ok(compareToHistory([], cur).verdict === "no-baseline", "empty history = no-baseline");
}

// ── 2. a regression run never becomes a baseline ───────────────────────────
{
  const history = [rec(1, { draws: 400 }), rec(2, { draws: 500 }, "regression")];
  const cur = current(3, { draws: 505 });
  const b = findBaselines(history, cur);
  ok(b.length === 1 && b[0].ts === ts(1), "the 'regression'-verdict run is skipped");
  ok(compareToHistory(b, cur).verdict === "regression", "505 is still judged against 400, not blessed by the 500 run");
  ok(findBaselines([rec(1, { armVerdict: "REJECT" }, "unusable")], cur).length === 0, "a REJECT arm is never a baseline");
  const unusable = compareToHistory([rec(1)], current(4, { armVerdict: "REJECT" }));
  ok(unusable.verdict === "unusable" && unusable.baselineCount === 0, "a REJECT arm is never compared");

  // The same story through the ingest path: verdicts are stored and read back.
  let hist = [];
  const ingest = (r) => { const o = ratchetResults(r, hist); hist = hist.concat(o.toAppend); return o.records[0].ratchet; };
  ok(ingest(run(1, { draws: 400 })).verdict === "no-baseline", "first run seeds the history");
  ok(ingest(run(2, { draws: 500 })).verdict === "regression", "+25% draws is a regression");
  ok(hist[1].ratchet.verdict === "regression", "the appended record carries its verdict");
  const third = ingest(run(3, { draws: 505 }));
  ok(third.verdict === "regression" && third.baselineTs.join() === ts(1), "next run is held to the pre-regression baseline");
}

// ── 3. baseline = per-metric median of the last 3 ──────────────────────────
{
  const history = [
    rec(1, { draws: 999, ktris: 9999 }), // oldest: outside the window of 3
    rec(2, { draws: 380, ktris: 820 }),
    rec(3, { draws: 420, ktris: 780 }),
    rec(4, { draws: 400, ktris: 800 }),
  ];
  const cur = current(5, { draws: 400, ktris: 800 });
  const b = findBaselines(history, cur);
  ok(b.length === RATCHET_HISTORY && b.map((x) => x.ts).join() === [ts(4), ts(3), ts(2)].join(), "last 3, newest first");
  const v = compareToHistory(b, cur);
  ok(find(v.within, "draws@submitted.mean").baseline === 400, "draws baseline = median(380, 420, 400)");
  ok(find(v.within, "ktris@submitted.mean").baseline === 800, "ktris baseline = median(820, 780, 800)");
  ok(v.verdict === "ok" && v.baselineCount === 3, "outlier oldest run (999) never entered the median");
  // A metric absent from one baseline is not compared (no partial medians).
  // (Real GPU, so the count's policy would otherwise compare it.)
  const partial = [rec(2, { renderer: GTX1070 }), rec(3, { renderer: GTX1070 }), rec(4, { renderer: GTX1070, relinks: 0 })];
  const v2 = compareToHistory(partial, current(5, { relinks: 9, renderer: GTX1070 }));
  const skippedRelinks = find(v2.skipped, "programsRelinked@moving");
  ok(!find(v2.regressions, "programsRelinked@moving") && skippedRelinks && /partial/.test(skippedRelinks.why),
    "partial-history metric never compared");
}

// ── 4. inside the baselines' spread = noise ────────────────────────────────
{
  const b = [rec(3, { draws: 400 }), rec(2, { draws: 400 }), rec(1, { draws: 470 })];
  const noisy = compareToHistory(b, current(4, { draws: 460 }));
  const f = find(noisy.noise, "draws@submitted.mean");
  ok(f && f.baseline === 400 && f.delta > 0.10, "+15% vs the median but <= a recorded 470 -> noise");
  ok(noisy.verdict === "ok" && noisy.regressions.length === 0, "noise does not fail the run");
  const real = compareToHistory(b, current(4, { draws: 480 }));
  ok(real.verdict === "regression" && find(real.regressions, "draws@submitted.mean"), "worse than EVERY baseline -> regression");
  // With a single baseline the spread rule cannot apply (WebAC: reduces to the tolerance test).
  ok(compareToHistory([rec(1, { draws: 470 })], current(4, { draws: 520 })).verdict === "regression", "single baseline: tolerance only");
}

// ── 5. SwiftShader: counts only; real GPU: frame time too ──────────────────
{
  const sw = [rec(1), rec(2), rec(3)];
  const v = compareToHistory(sw, current(4, { frame: 40, cpu: 30, draws: 460 }));
  ok(v.verdict === "regression", "SwiftShader run regresses on draws");
  ok(find(v.regressions, "draws@submitted.mean") && find(v.regressions, "draws@submitted.mean").delta === 0.15, "draws@submitted +15% flagged");
  ok(!find(v.regressions, "frameMs@moving.p50") && find(v.skipped, "frameMs@moving.p50"), "frameMs +150% ignored on SwiftShader");
  ok(find(v.skipped, "cpuMs@moving.p50"), "cpuMs ignored on SwiftShader");
  ok(!v.realGpu, "verdict records the software-renderer mode");
  const onlyFrame = compareToHistory(sw, current(4, { frame: 40 }));
  ok(onlyFrame.verdict === "ok", "a frameMs-only blow-up on SwiftShader is not a regression");

  const gpu = [rec(1, { renderer: GTX1070 }), rec(2, { renderer: GTX1070 }), rec(3, { renderer: GTX1070 })];
  const g = compareToHistory(gpu, current(4, { renderer: GTX1070, frame: 22 }));
  ok(g.realGpu && g.verdict === "regression" && find(g.regressions, "frameMs@moving.p50"), "real GPU: frameMs p50 +37.5% flagged");
  const gOk = compareToHistory(gpu, current(4, { renderer: GTX1070, frame: 19 }));
  ok(gOk.verdict === "ok", "real GPU: frameMs +18.75% is inside the 25% *Ms tolerance");
  // Zero-baseline counts use an absolute slack (0 -> 1 is not +100%).
  const zero = [rec(1, { renderer: GTX1070, relinks: 0 }), rec(2, { renderer: GTX1070, relinks: 0 })];
  ok(compareToHistory(zero, current(3, { renderer: GTX1070, relinks: 1 })).verdict === "ok", "relinks 0 -> 1 within slack");
  const relink = compareToHistory(zero, current(3, { renderer: GTX1070, relinks: 5 }));
  ok(relink.verdict === "regression" && find(relink.regressions, "programsRelinked@moving").absolute, "relinks 0 -> 5 regresses (absolute)");
  const better = compareToHistory(sw, current(4, { draws: 300 }));
  ok(find(better.improved, "draws@submitted.mean"), "a -25% draws run is reported as improved");
}

// ── rule 5: an operator --accept rebases the window ────────────────────────
{
  let hist = [];
  const ingest = (r, accept = false) => { const o = ratchetResults(r, hist, { accept }); hist = hist.concat(o.toAppend); return o.records[0].ratchet; };
  ingest(run(1, { draws: 400 })); ingest(run(2, { draws: 404 })); ingest(run(3, { draws: 398 }));
  ok(ingest(run(4, { draws: 480 })).verdict === "regression", "an intended +20% first reads as a regression");
  const acc = ingest(run(5, { draws: 482 }), true);
  ok(acc.verdict === "accepted" && acc.acceptedFrom === "regression", "--accept stamps the run, keeping what it would have said");
  const next = ingest(run(6, { draws: 485 }));
  ok(next.verdict === "ok" && next.baselineTs.join() === ts(5), "the window stops at the accepted run (485 vs 482 = ok)");
  ok(ratchetResults(run(7, { armVerdict: "REJECT" }), hist, { accept: true }).records[0].ratchet.verdict === "unusable",
    "--accept never turns a REJECT arm into a baseline");
  ok(/operator-accepted rebase/.test(formatRatchet({ ...hist[4] })), "formatRatchet explains an accepted run");
}

// ── provenance taint (recorded, never keyed) ───────────────────────────────
{
  const v = compareToHistory([rec(1, { commit: "aaa", dist: "D1" })], current(2, { commit: "bbb", dist: "D2" }));
  ok(v.taint.some((t) => t.includes("dist changed")) && v.taint.some((t) => t.includes("commit moved")), "dist/commit movement surfaces as taint");
  const text = formatRatchet({ ...current(2), ratchet: v });
  ok(text.includes("taint: dist changed") && text.includes("-> OK"), "formatRatchet prints verdict + taint");
}

// ── 6. wasmProfile from custom sections ────────────────────────────────────
const leb = (n) => { const out = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); return out; };
function wasmBytes(customs) {
  // header + a type section with one `() -> ()` functype (so it validates)
  const out = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x04, 0x01, 0x60, 0x00, 0x00];
  for (const [name, extra = 0] of customs) {
    const nb = [...Buffer.from(name, "utf8")];
    const payload = [...leb(nb.length), ...nb, ...new Array(extra).fill(0x2a)];
    out.push(0x00, ...leb(payload.length), ...payload);
  }
  return Uint8Array.from(out);
}
{
  const dev = wasmBytes([["name"], ["producers", 40], ["target_features", 200]]);
  const rel = wasmBytes([["producers", 40], ["target_features", 200]]);
  const dbg = wasmBytes([[".debug_info", 300], ["producers"]]);
  ok(WebAssembly.validate(dev) && WebAssembly.validate(rel) && WebAssembly.validate(dbg), "synthetic modules are valid wasm");
  ok(wasmCustomSectionNames(dev).join() === "name,producers,target_features", "walker lists custom sections in order (2-byte LEB size)");
  ok(detectWasmProfile(dev).profile === "DEV-WASM", "`name` custom section -> DEV-WASM");
  ok(detectWasmProfile(rel).profile === "release", "no name/.debug_* -> release");
  ok(detectWasmProfile(dbg).profile === "DEV-WASM", ".debug_* custom section -> DEV-WASM");
  const trunc = detectWasmProfile(dev.subarray(0, dev.length - 5));
  ok(trunc.profile === "release" && /size-fallback/.test(trunc.reason) && /past the end/.test(trunc.reason), "truncated module falls back to size, says why");
  ok(classifyWasmProfile({ size: DEV_SIZE_FALLBACK_BYTES + 1 }).profile === "DEV-WASM", "size fallback: > 12 MB -> DEV-WASM");
  ok(classifyWasmProfile({ size: 7182909 }).profile === "release", "size fallback: today's 7.18 MB release is release (the old 6 MB band said dev)");
  ok(classifyWasmProfile({}).profile === "unknown", "nothing probed -> unknown, never a guess");
  throwsWith(() => wasmCustomSectionNames(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])), "bad magic", "non-wasm refused");

  // Real data when present (pkg/ is gitignored, so optional): the walker must
  // get through a real multi-MB module without falling back to size.
  const real = path.join(HERE, "..", "pkg", "holtburger_web_bg.wasm");
  if (existsSync(real)) {
    const r = detectWasmProfile(readFileSync(real));
    ok(Array.isArray(r.customSections) && ["release", "DEV-WASM"].includes(r.profile), `real pkg/ wasm walked (${r.profile}, ${r.size} B: ${r.reason})`);
  } else {
    console.log("  (skip) no pkg/holtburger_web_bg.wasm — real-module walk not exercised");
  }
}

// ── moving-bench provenance probe (runs the page expression in node:vm) ────
async function probeInVm({ live = true, entry = true, wasm, manifestOk = true }) {
  const calls = { fetch: [], lost: 0, created: 0 };
  const gl = {
    RENDERER: 0x1f01,
    getExtension: (n) => (n === "WEBGL_debug_renderer_info" ? { UNMASKED_RENDERER_WEBGL: 0x9246 }
      : n === "WEBGL_lose_context" ? { loseContext: () => { calls.lost++; } } : null),
    getParameter: (p) => (p === 0x9246 ? SWIFTSHADER : "WebKit WebGL"),
  };
  const ctx = vm.createContext({
    window: live ? { liveScene3d: { renderer: { getContext: () => gl } } } : {},
    document: { createElement: () => { calls.created++; return { getContext: () => gl }; } },
    performance: { getEntriesByType: () => (entry ? [{ name: "http://h/apps/holtburger-web/pkg/holtburger_web_bg.wasm?v=wasmrev-x" }] : []) },
    location: { href: "http://h/apps/holtburger-web/index.html?nosw=1" },
    URL, TextDecoder,
    fetch: async (url, opts) => {
      calls.fetch.push([String(url), opts && opts.cache]);
      if (String(url).includes(".wasm")) return { ok: true, status: 200, arrayBuffer: async () => wasm.slice().buffer };
      return manifestOk ? { ok: true, json: async () => ({ generated_at: "2026-10-12T04:53:00-02:30" }) } : { ok: false, status: 404 };
    },
  });
  const out = await vm.runInContext(provenanceProbeSource(), ctx);
  return { out, calls };
}
{
  new vm.Script(provenanceProbeSource()); // compiles (the walker source embeds cleanly)
  ok(true, "provenance probe source compiles");
  const devWasm = wasmBytes([["name"], ["producers"]]);
  const a = await probeInVm({ wasm: devWasm });
  ok(a.out.renderer === SWIFTSHADER && a.calls.created === 0, "renderer read from the live renderer's own context");
  ok(a.out.wasm && a.out.wasm.sections.join() === "name,producers", "page-side walker read the loaded module's sections");
  ok(a.calls.fetch[0][0].endsWith("?v=wasmrev-x") && a.calls.fetch[0][1] === "force-cache", "fetches the Resource Timing URL the page loaded, from cache");
  ok(a.calls.fetch[1][0] === "http://h/dist/manifest.json" && a.out.distGeneratedAt === "2026-10-12T04:53:00-02:30", "dist stamp from ../../dist/manifest.json");
  const fa = provenanceFields(a.out);
  ok(fa.wasmProfile === "DEV-WASM" && fa.renderer === SWIFTSHADER && fa.provenanceErrors.length === 0, "provenanceFields: DEV-WASM + renderer");

  const b = await probeInVm({ live: false, entry: false, wasm: wasmBytes([["producers"]]), manifestOk: false });
  ok(b.calls.created === 1 && b.calls.lost === 1, "no live renderer -> throwaway context, lost again at once");
  ok(b.calls.fetch[0][0] === "http://h/apps/holtburger-web/pkg/holtburger_web_bg.wasm", "no timing entry -> pkg/ URL fallback");
  const fb = provenanceFields(b.out);
  ok(fb.wasmProfile === "release" && fb.distGeneratedAt === null, "release wasm; manifest 404 -> dist null");
  const fn = provenanceFields(null);
  ok(fn.wasmProfile === "unknown" && fn.renderer === null && fn.provenanceErrors.length === 1, "failed probe -> unknown, error recorded");

  // toResultsV2 folds provenance into the header; history keys on it.
  const rep = {
    ts: ts(1), arm: "(default)", url: BASE_URL, spec: { mode: "orbit", frames: 600, laps: 1, anchor: HOLTBURGER },
    pathChecksum: "c0ffee", realisedChecksum: "c0ffee", frames: { requested: 600, measured: 600, warm: 600 },
    cpuMs: { n: 600, p50: 8 }, rafMs: { n: 600, p50: 16 }, missedGauge: 0,
    workload: { draws: { n: 600, mean: 400, p50: 400 }, ktris: { n: 600, mean: 800 }, residentInstances: 5400, batchedMeshes: 29, staticBatchC: 17 },
    lb: { churnFrames: 0 }, walkDelta: null, errors: [], verdict: "USABLE", rejectReasons: [],
    ...fa, commit: "0123456789ab",
  };
  const v2 = toResultsV2(rep);
  ok(v2.wasmProfile === "DEV-WASM" && v2.platform.renderer === SWIFTSHADER, "v2 header carries wasmProfile + platform.renderer");
  ok(v2.commit === "0123456789ab" && v2.distGeneratedAt === "2026-10-12T04:53:00-02:30", "v2 header carries commit + distGeneratedAt");
  ok(v2.arms[0].wasmProbe && v2.arms[0].wasmProbe.reason.includes("name"), "arm records how the profile was decided");
  const [h] = toHistoryRecords(v2);
  ok(h.comparable.renderer === SWIFTSHADER && h.comparable.wasmProfile === "DEV-WASM" && h.usable, "history record keys on the probed provenance");
  ok(!("programs@resident" in v2.arms[0].metrics), "no rig program count -> no programs@resident (never a 0)");

  // programs@resident on DEFAULT runs (no ledger): the rig's bare count.
  const withProg = toResultsV2({ ...rep, workload: { ...rep.workload, programs: 812 } });
  ok(withProg.arms[0].metrics["programs@resident"] === 812 && !("programsRelinked@moving" in withProg.arms[0].metrics),
    "bare renderer.info.programs count -> programs@resident without --linkProbe");
  ok(!("programs@resident" in toResultsV2({ ...rep, workload: { ...rep.workload, programs: -1 } }).arms[0].metrics),
    "unreadable count (-1) -> no key");
  const ledger = toResultsV2({ ...rep, workload: { ...rep.workload, programs: 812 }, link: { relinks: 2, created: 3, released: 1, programs: 815 } });
  ok(ledger.arms[0].metrics["programs@resident"] === 815 && ledger.arms[0].metrics["programsRelinked@moving"] === 2,
    "with the ledger, its own end-of-lap count wins");
  const sw = metricScalars(withProg.arms[0].metrics);
  ok(sw.get("programs@resident").value === 812 && metricPolicy("programs@resident", SWIFTSHADER).compare,
    "programs@resident is ratcheted even on SwiftShader");
}

// ── 7. history I/O + CLI ───────────────────────────────────────────────────
{
  ok(resolveHistoryDir("/x", { HB_PERF_HISTORY: "/y" }) === "/x", "--history=DIR wins");
  ok(resolveHistoryDir(null, { HB_PERF_HISTORY: "/y" }) === "/y", "$HB_PERF_HISTORY next");
  ok(resolveHistoryDir(null, {}) === DEFAULT_HISTORY_DIR && DEFAULT_HISTORY_DIR.startsWith("/mnt/wbterminal2/"), "external-drive default");

  const tmp = mkdtempSync(path.join(tmpdir(), "hb-ratchet-"));
  try {
    const dir = path.join(tmp, "hist"); // not created yet: appendHistory makes it lazily
    ok(readHistory(dir).records.length === 0, "missing history = empty");
    const o1 = ratchetResults(run(1), []);
    appendHistory(dir, o1.toAppend);
    const back = readHistory(dir);
    ok(back.records.length === 1 && back.records[0].ratchet.verdict === "no-baseline", "JSONL round-trip keeps the verdict");
    writeFileSync(path.join(dir, HISTORY_FILE), readFileSync(path.join(dir, HISTORY_FILE), "utf8") + "{broken\n");
    ok(readHistory(dir).badLines === 1 && readHistory(dir).records.length === 1, "a broken line is counted and skipped");
    const dup = ratchetResults(run(1), readHistory(dir).records);
    ok(dup.toAppend.length === 0 && dup.records[0].ratchet.verdict === "duplicate", "re-ingesting the same run is a no-op");
    ok(summarizeHistory(readHistory(dir).records)[0].runs === 1, "summary counts runs per key");

    // CLI: exit 0 seed, 1 regression, 0 duplicate; --dry-run never appends.
    const CLI = path.join(HERE, "perf-ratchet.mjs");
    const cliDir = path.join(tmp, "cli");
    const f1 = path.join(tmp, "r1.json"); writeFileSync(f1, JSON.stringify(run(1)));
    const f2 = path.join(tmp, "r2.json"); writeFileSync(f2, JSON.stringify(run(2, { draws: 470 })));
    const cli = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
    const c1 = cli([f1], { HB_PERF_HISTORY: cliDir });
    ok(c1.status === 0 && /NO-BASELINE/.test(c1.stdout), `CLI seeds history via $HB_PERF_HISTORY (exit ${c1.status})`);
    const cDry = cli([f2, `--history=${cliDir}`, "--dry-run"]);
    ok(cDry.status === 1 && readHistory(cliDir).records.length === 1, "--dry-run reports the regression, appends nothing");
    const c2 = cli([f2, `--history=${cliDir}`]);
    ok(c2.status === 1 && /REGRESSION/.test(c2.stdout) && /draws@submitted\.mean/.test(c2.stdout), `CLI exit 1 on regression (exit ${c2.status})`);
    const c3 = cli([f2, `--history=${cliDir}`]);
    ok(c3.status === 0 && /DUPLICATE/.test(c3.stdout) && readHistory(cliDir).records.length === 2, "CLI re-ingest is a no-op");
    const cl = cli(["--list", `--history=${cliDir}`]);
    ok(cl.status === 0 && /runs=2 usable=2 regressions=1/.test(cl.stdout), "--list summarizes the key");
    ok(cli([], { HB_PERF_HISTORY: cliDir }).status === 2 && cli(["--bogus"]).status === 2, "usage errors exit 2");

    // wasm_profile CLI (ci-smoke S0 reads --profile-only).
    const wf = path.join(tmp, "dev.wasm"); writeFileSync(wf, wasmBytes([["name"]]));
    const w = spawnSync(process.execPath, [path.join(HERE, "lib", "wasm_profile.mjs"), "--profile-only", wf], { encoding: "utf8" });
    ok(w.status === 0 && w.stdout.trim() === "DEV-WASM", "wasm_profile --profile-only prints the profile word");
    const wm = spawnSync(process.execPath, [path.join(HERE, "lib", "wasm_profile.mjs"), path.join(tmp, "missing.wasm")], { encoding: "utf8" });
    ok(wm.status === 1, "wasm_profile exits 1 on an unreadable file (ci-smoke falls back to size)");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(`perf-ratchet: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log("PERF-RATCHET ✅");
  process.exit(0);
} else {
  console.error("PERF-RATCHET ❌");
  process.exit(1);
}
