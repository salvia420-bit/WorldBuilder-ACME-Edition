#!/usr/bin/env node
// battery-outdoor-run.mjs — 5-min-RUN outdoor stress battery (2026-07-13).
//
// Sibling of battery-telepoi.mjs (do NOT modify that one). Where the telepoi
// battery times land+stream-settle per stop, THIS battery drives a sustained
// held-W RUN across open terrain: for every OUTDOOR POI it teleports in,
// settles, hops the avatar to a precomputed obstacle-free "clear start" away
// from town buildings, then holds 'w' to RUN unimpeded for --runS seconds
// (default 300) while streaming perf metrics (fps / p50 / p95 / longtasks /
// draw-calls / mesh / heap / wire / wasm-mem / streaming LRU) into
// samples.jsonl. This exercises the CONTINUOUS-traversal streaming path (cold
// terrain fill, LOD churn, PVS updates, residency eviction) that a teleport-
// and-sit battery never touches.
//
// Corridors come from gen-outdoor-run-plans.py (outdoor-run-plans.json): each
// plan gives a heading, a clear-start cell+xyz+quat, a corridor length, and a
// flip quat. Non-usable POIs (no obstacle-free corridor >= minCorridorM) are
// RECORDED as kind:"skip" rows, not silently dropped.
//
// Run mechanics (Node orchestrates via Playwright's TRUSTED page.keyboard —
// synthetic KeyboardEvent dispatch is unreliable here; see the key-helper block):
//   * hold 'w' (run forward); re-assert keyboard.down each tick (the app clears
//     keyState on a window "blur" event, so re-asserting self-heals).
//   * PING-PONG: on reaching corridorEnd-40 m, @teleloc in place with flipQuat
//     (180° about) and keep running back down the corridor; count flips.
//   * STUCK GUARD: <4 m of 2D motion over 6 s -> sidestep (d, then a) 1.2 s with
//     'w' still held; after 3 consecutive stalls @teleloc ~30 m ahead along the
//     heading at pose.z+2 (gravity settles) and reset; count stuckEvents/nudges.
//
// Modes (same as battery-telepoi):
//   --mode local (default) boot.mjs launchAndEnter (laptop headless SwiftShader)
//   --mode cdp   connectOverCDP to an ALREADY-RUNNING off-screen Chrome on the
//                1070 (:9333 tunnel); keeps the real-GPU assert; NEVER closes
//                the browser, only OUR page.
//
// ⚠ LAPTOP (no-GPU / SwiftShader): physical walking needs the wireframe frame
//   rate — pass --query "wireframe=1". walk-west proved held-W runs at ~5 fps
//   wireframe; textured SwiftShader (<1 fps) STARVES per-frame movement input
//   and the avatar never moves. On the 1070 (real GPU) run textured.
//
// Duration: 50 POIs x (settle + 300 s run) ~= 4.5-5 h/arm. Use --maxStops for
// fixed-length relaunchable sessions and/or a --pois name-subset file. Exit 3
// (renderer-death abort OR clean maxStops cap with POIs remaining) => wrapper
// relaunches with --resume.
//
// Flags:
//   --mode local|cdp   --plans <outdoor-run-plans.json>  --pois <name-subset>
//   --query "wireframe=1"  --label armA  --out out.json  --samplesOut <dir>
//   --runS 300  --sampleMs 2000  --dwellMax 25  --maxStops 0  --shots <dir>
//   --resume  --landPollMs 100  --quietGapMs 65000
//   --settleWorkMin 5  --settleFloorMs 3000
//   --cdp http://127.0.0.1:9333  --account tailnet1
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const MODE = arg("mode", "local");
const PLANS_FILE = arg("plans", "./outdoor-run-plans.json");
const POIS_FILE = arg("pois", "");
const EXTRA_QUERY = arg("query", "");
const LABEL = arg("label", MODE);
const OUT = arg("out", "");
const SAMPLES_OUT = arg("samplesOut", "");
const SHOTS = arg("shots", "");
const RUN_S = Number(arg("runS", "300"));
const SAMPLE_MS = Number(arg("sampleMs", "2000"));
const DWELL_MAX_S = Number(arg("dwellMax", "25"));
const CDP_URL = arg("cdp", "http://127.0.0.1:9333");
const ACCOUNT = arg("account", "tailnet1");
const SETTLE_WORK_MIN = Number(arg("settleWorkMin", "5"));
const SETTLE_FLOOR_MS = Number(arg("settleFloorMs", "3000"));
const LAND_POLL_MS = Number(arg("landPollMs", "100"));
const QUIET_GAP_MS = Number(arg("quietGapMs", "65000"));
const MAX_STOPS = Number(arg("maxStops", "0"));

const LB_M = 192.0;
const PING_PONG_MARGIN_M = 40.0;   // flip when s >= corridorM - this
const STUCK_CHECK_MS = 6000;
const STUCK_MOVE_MIN_M = 4.0;      // <this 2D move over STUCK_CHECK_MS = stalled
const SIDESTEP_MS = 1200;
const STUCK_STREAK_NUDGE = 3;      // consecutive stalls -> @teleloc nudge
const NUDGE_AHEAD_M = 30.0;
// sample-to-sample move > this = a teleport/resync (excluded from distance). AC
// run is ~17 m/s so a normal 2 s-sample step is ~35 m; ping-pong/nudge teleports
// are already excluded via lastWorld=null, so this only catches large resyncs.
const TELE_JUMP_M = 100.0;
const TELEOK_TOL_M = 15.0;         // clear-start pose-verify tolerance

if (!PLANS_FILE || !fs.existsSync(PLANS_FILE)) { console.error(`--plans not found: ${PLANS_FILE}`); process.exit(2); }
const PLANS_DOC = JSON.parse(fs.readFileSync(PLANS_FILE, "utf8"));
let PLANS = Array.isArray(PLANS_DOC.plans) ? PLANS_DOC.plans : [];
// Optional name-subset file (one POI name per line) — same shape as the telepoi
// battery's --pois.
if (POIS_FILE) {
  const want = new Set(fs.readFileSync(POIS_FILE, "utf8").split("\n").map((s) => s.trim()).filter(Boolean).map((s) => s.toLowerCase()));
  PLANS = PLANS.filter((p) => want.has(String(p.poi).toLowerCase()));
}

const OUT_DIR = SAMPLES_OUT || (OUT ? path.dirname(OUT) : ".");
if (OUT_DIR) fs.mkdirSync(OUT_DIR, { recursive: true });
const SAMPLES_PATH = path.join(OUT_DIR, `${LABEL.replace(/[^A-Za-z0-9_-]/g, "_")}-samples.jsonl`);

// --resume: continue an aborted arm. Keep prior rows, skip POIs already recorded
// (kind run|skip). Wrapper re-invokes with the same --out until exit != 3.
const RESUME = process.argv.includes("--resume");
let priorRows = [];
if (RESUME && OUT && fs.existsSync(OUT)) {
  try {
    const prev = JSON.parse(fs.readFileSync(OUT, "utf8"));
    priorRows = Array.isArray(prev.rows) ? prev.rows : [];
    const done = new Set(priorRows.filter((r) => r.kind === "run" || r.kind === "skip").map((r) => r.poi));
    PLANS = PLANS.filter((p) => !done.has(p.poi));
    console.error(`[outdoor] resume: ${priorRows.length} prior rows kept, ${PLANS.length} POIs remain`);
  } catch (_) { priorRows = []; }
}
for (const r of priorRows) if (r.sessionIdx == null) r.sessionIdx = 0;
const SESSION_IDX = priorRows.length ? Math.max(...priorRows.map((r) => r.sessionIdx ?? 0)) + 1 : 0;
if (PLANS.length === 0) {
  console.log("BATTERY SUMMARY: nothing to do (all POIs already recorded)");
  process.exit(0);
}
if (RESUME && priorRows.length) {
  console.error(`[outdoor] resume quiet-gap: ${QUIET_GAP_MS}ms before launch`);
  await new Promise((r) => setTimeout(r, QUIET_GAP_MS));
}

// ── results state + finalizer (hoisted so a boot stall can flush) ──
const rows = [];
let aborted = null;
let stopsCapped = false;
let cycleT0 = Date.now();
const jsonl = fs.createWriteStream(SAMPLES_PATH, { flags: "a" });
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const mx = (a) => (a.length ? Math.max(...a) : null);
const avg = (a) => (a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : null);

function finalize() {
  const allRows = [...priorRows, ...rows];
  const runRows = allRows.filter((r) => r.kind === "run");
  const skipRows = allRows.filter((r) => r.kind === "skip");
  const bootRows = allRows.filter((r) => r.kind === "boot");
  const landed = runRows.filter((r) => r.landed);
  const cycleMs = Date.now() - cycleT0;
  const sess = [...new Set(runRows.map((r) => r.sessionIdx ?? 0))].sort((a, b) => a - b);
  const summary = {
    label: LABEL, mode: MODE, query: EXTRA_QUERY || null,
    plans: PLANS_DOC.plans ? PLANS_DOC.plans.length : null,
    runS: RUN_S, sampleMs: SAMPLE_MS,
    aborted, stopsCapped,
    attempted: runRows.length, skipped: skipRows.length,
    landed: landed.length,
    teleOk: landed.filter((r) => r.teleOk).length,
    cycleMs,
    // per-POI run-phase fps: median of per-stop mean fps
    fpsMedian: med(landed.map((r) => r.fpsMean).filter((v) => v != null)),
    fpsP50Median: med(landed.map((r) => r.fpsP50).filter((v) => v != null)),
    fpsP95Median: med(landed.map((r) => r.fpsP95).filter((v) => v != null)),
    worstFrameMsMax: mx(landed.map((r) => r.worstFrameMs).filter((v) => v != null)),
    settleMedianMs: med(landed.map((r) => r.settleMs).filter((v) => v != null)),
    distanceTotalM: +landed.reduce((a, r) => a + (r.distanceM ?? 0), 0).toFixed(1),
    avgSpeedMedianMps: med(landed.map((r) => r.avgSpeedMps).filter((v) => v != null)),
    flipsTotal: landed.reduce((a, r) => a + (r.flips ?? 0), 0),
    stuckTotal: landed.reduce((a, r) => a + (r.stuckEvents ?? 0), 0),
    nudgeTotal: landed.reduce((a, r) => a + (r.nudges ?? 0), 0),
    headingErrMedianDeg: med(landed.map((r) => r.headingErrDeg).filter((v) => v != null)),
    ltTotal: landed.reduce((a, r) => a + (r.ltCount ?? 0), 0),
    heapEndMedMB: med(landed.map((r) => r.heapEndMB).filter((v) => v != null)),
    wasmMemMainMedMB: med(landed.map((r) => r.wasmMemMainMB).filter((v) => v != null)),
    wasmMemWorkerMedMB: med(landed.map((r) => r.wasmMemWorkerMB).filter((v) => v != null)),
    boots: bootRows.length,
    bootMedMs: med(bootRows.map((r) => r.bootMs).filter((v) => v != null)),
    bootOutcomes: {
      inWorld: bootRows.filter((r) => r.outcome === "in-world").length,
      stall: bootRows.filter((r) => r.outcome === "stall").length,
      error: bootRows.filter((r) => r.outcome === "error").length,
    },
    sessions: sess.length,
    fpsMedBySession: sess.map((sidx) => {
      const seg = landed.filter((r) => (r.sessionIdx ?? 0) === sidx);
      return { sessionIdx: sidx, n: seg.length, fpsMed: med(seg.map((r) => r.fpsMean).filter((v) => v != null)) };
    }),
    samplesPath: SAMPLES_PATH,
    final: allRows[allRows.length - 1] ?? null,
  };
  if (OUT) fs.writeFileSync(OUT, JSON.stringify({ summary, rows: allRows }, null, 2));
  console.log(JSON.stringify(summary));
  console.log(`BATTERY SUMMARY: ${LABEL} run=${summary.landed}/${summary.attempted} skip=${summary.skipped} ` +
    `teleOk=${summary.teleOk} fpsMed=${summary.fpsMedian} p95Med=${summary.fpsP95Median} worstMs=${summary.worstFrameMsMax} ` +
    `distTot=${summary.distanceTotalM}m spdMed=${summary.avgSpeedMedianMps} flips=${summary.flipsTotal} ` +
    `stuck=${summary.stuckTotal} nudge=${summary.nudgeTotal} hdErrMed=${summary.headingErrMedianDeg}deg ` +
    `sessions=${summary.sessions} sessionIdx=${SESSION_IDX} ` +
    `boots=${summary.boots}(iw=${summary.bootOutcomes.inWorld}/stall=${summary.bootOutcomes.stall}/err=${summary.bootOutcomes.error})` +
    (stopsCapped ? ` STOPS-CAPPED(${MAX_STOPS})` : "") + (aborted ? ` ABORTED(${aborted})` : ""));
  return summary;
}

// ── boot (same shape as battery-telepoi) ──
const bootT0 = Date.now();
let page, helpers, closeFn;
let bootMs = null, bootOutcome = "stall";
let rendererCrashed = false;
if (MODE === "local") {
  const BOOT_MJS = process.env.BOOT_MJS ||
    "/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/harness/lib/boot.mjs";
  const boot = await import(pathToFileURL(BOOT_MJS).href);
  const query = { nosw: "1" };
  if (EXTRA_QUERY) for (const [k, v] of new URLSearchParams(EXTRA_QUERY)) query[k] = v;
  const r = await boot.launchAndEnter({ query, timeoutMs: 120_000 });
  bootMs = r.inWorldMs != null ? r.inWorldMs : (Date.now() - bootT0);
  if (!r.inWorld) {
    let bs = null; try { bs = await r.page.evaluate(() => window.__bootState); } catch (_) {}
    bootOutcome = bs === "error" ? "error" : "stall";
    rows.push({ kind: "boot", sessionIdx: SESSION_IDX, mode: MODE, bootMs, outcome: bootOutcome });
    finalize();
    console.log("BATTERY SUMMARY: SKIP boot-stalled");
    await r.helpers.close(); process.exit(2);
  }
  bootOutcome = "in-world";
  rows.push({ kind: "boot", sessionIdx: SESSION_IDX, mode: MODE, bootMs, outcome: bootOutcome });
  page = r.page; helpers = r.helpers; closeFn = () => helpers.close();
  r.page.on("crash", () => { rendererCrashed = true; });
} else {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  let pw;
  try { pw = require("playwright-core"); } catch (_) {
    const home = process.env.HOME;
    const hits = fs.readdirSync(`${home}/.npm/_npx`).map((d) => `${home}/.npm/_npx/${d}/node_modules/playwright-core`).filter((p) => fs.existsSync(p));
    if (!hits.length) { console.error("playwright-core not found"); process.exit(2); }
    pw = require(hits[0]);
  }
  const browser = await pw.chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0] ?? (await browser.newContext());
  page = await ctx.newPage();
  const q = new URLSearchParams({
    renderer: "3d", autoLogin: "1", account: ACCOUNT, password: ACCOUNT,
    autoSpawn: "first", nosw: "1",
  });
  if (EXTRA_QUERY) for (const [k, v] of new URLSearchParams(EXTRA_QUERY)) q.set(k, v);
  await page.goto(`http://127.0.0.1:8765/apps/holtburger-web/index.html?${q}`, { timeoutMs: 60_000 });
  let inWorld = false, bootErr = false;
  for (let i = 0; i < 240; i++) {
    const bs = await page.evaluate(() => window.__bootState).catch(() => null);
    if (bs === "in-world" || bs === "ready") { inWorld = true; break; }
    if (bs === "error") { bootErr = true; break; }
    await page.waitForTimeout(1000);
  }
  bootMs = Date.now() - bootT0;
  bootOutcome = inWorld ? "in-world" : (bootErr ? "error" : "stall");
  if (!inWorld) {
    rows.push({ kind: "boot", sessionIdx: SESSION_IDX, mode: MODE, bootMs, outcome: bootOutcome });
    finalize();
    console.log("BATTERY SUMMARY: SKIP boot-stalled (cdp)");
    await page.close(); process.exit(2);
  }
  rows.push({ kind: "boot", sessionIdx: SESSION_IDX, mode: MODE, bootMs, outcome: bootOutcome });
  const gpu = await page.evaluate(() => {
    try {
      const c = document.createElement("canvas");
      const gl = c.getContext("webgl2") || c.getContext("webgl");
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      return gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
    } catch (e) { return "ERR:" + e; }
  }).catch(() => "ERR:eval");
  console.error(`[outdoor] UNMASKED_RENDERER = ${gpu}`);
  if (!/NVIDIA|GTX|Direct3D/i.test(String(gpu))) {
    finalize();
    console.log(`BATTERY SUMMARY: SKIP not-real-GPU (${gpu})`);
    await page.close(); process.exit(2);
  }
  helpers = { evalInPage: (fn, ...a) => page.evaluate(fn, ...a) };
  closeFn = () => page.close();
}

// wait for liveScene3d (late — ~35 s after in-world)
for (let i = 0; i < 90; i++) {
  if (await helpers.evalInPage(() => !!(window.liveScene3d && window.liveScene3d.scene))) break;
  await page.waitForTimeout(1000);
}
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

// Install the rAF frame recorder + longtask observer (post-boot; we only need
// RUN-phase frames/longtasks). Idempotent.
await helpers.evalInPage(() => {
  if (!window.__fr) {
    window.__fr = { buf: [], last: -1 };
    const loop = (now) => {
      const f = window.__fr;
      if (f.last >= 0) { const dt = now - f.last; if (dt > 0 && dt < 60000) f.buf.push(dt); }
      f.last = now;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
  if (!window.__perf) {
    window.__perf = { longtasks: [] };
    try {
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          window.__perf.longtasks.push({ start: Math.round(e.startTime), dur: Math.round(e.duration) });
          if (window.__perf.longtasks.length > 40000) window.__perf.longtasks.shift();
        }
      });
      po.observe({ entryTypes: ["longtask"] });
    } catch (e) { /* longtask unsupported */ }
  }
});

// Movement input = Playwright's TRUSTED page.keyboard (CDP Input.dispatchKeyEvent),
// NOT synthetic KeyboardEvent dispatch. Empirically (probe 2026-07-13) trusted
// keys drive the avatar reliably; the app's keyState is also cleared on a window
// "blur" event, so we RE-ASSERT keyboard.down every tick to self-heal (Playwright
// re-fires keydown with repeat=true, keeping keyState.<k> true). Both modes use a
// real Playwright Page, so page.keyboard works for local AND cdp.
const holdKey = async (k) => { try { await page.keyboard.down(k); } catch (_) {} };
const releaseAllKeys = async () => { for (const k of ["w", "a", "s", "d", "q", "e"]) { try { await page.keyboard.up(k); } catch (_) {} } };
const tapSidestep = async (k, ms) => { try { await page.keyboard.down(k); await page.waitForTimeout(ms); await page.keyboard.up(k); } catch (_) {} };

// ── eval hardening: race every evaluate against a timer; on failure abort but
// WRITE PARTIAL JSON (from battery-telepoi). ──
const EVAL_TIMEOUT_MS = 15_000;
const raced = (p) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(
    () => rej(new Error(rendererCrashed
      ? "renderer-crash (page crash event fired)"
      : "eval-timeout (main-thread hang; no crash event)")),
    EVAL_TIMEOUT_MS)),
]);

// LIGHT sample — pose + streaming counters only, for the land-wait (10 Hz) and
// settle (2 Hz) phases. The FULL snapshot below does a whole-scene traverse,
// renderer.info reads and an __fr frame-buffer drain every call; polling that
// at 10 Hz on a ~5 fps SwiftShader main thread both slows settling and makes
// settleMs incomparable with battery-telepoi (whose sample() is this light
// shape). Bonus: not draining __fr during settle means the run's first full
// snapshot (s0, discarded from aggregates) flushes the buffer, so run-phase
// frame stats start clean.
const lightSample = () => raced(helpers.evalInPage(() => {
  const ls = window.liveScene3d;
  let pose = null;
  try {
    const p = window.__sessionHandle.getLocalPlayerPose();
    if (p) {
      pose = { lb: p.landblockId >>> 0,
               x: Number.isFinite(p.x) ? p.x : null, y: Number.isFinite(p.y) ? p.y : null,
               z: Number.isFinite(p.z) ? p.z : null,
               heading: Number.isFinite(p.heading) ? p.heading : null };
      try { p.free(); } catch (_) {} // wasm-owned struct — free every time
    }
  } catch (_) {}
  return {
    t: Date.now(), pose,
    terr: ls?.terrainBakedLbs?.size ?? 0, stat: ls?.staticsGroup?.children?.length ?? 0,
    cells: ls?.cellContainers3d?.size ?? 0,
    work: (typeof window.__bakeWorkerSeq === "function") ? window.__bakeWorkerSeq() : null,
  };
}));

// FULL snapshot (run phase only): walk-west's perf snapshot() UNION
// battery-telepoi's sample() streaming/LRU fields, so ONE eval yields fps,
// draw-calls, mesh, heap, wire/lod/pvs, pose AND the residency/work telemetry.
const snapshot = () => raced(helpers.evalInPage(() => {
  const d = window.__diag || {};
  const ls = window.liveScene3d;
  const rr = ls && ls.renderer;
  let ri = null;
  if (rr && rr.info) {
    rr.info.autoReset = false; // three.js zeroes render.* per frame; read cumulative
    ri = { cumCalls: rr.info.render.calls, cumTris: rr.info.render.triangles,
           programs: rr.info.programs ? rr.info.programs.length : null,
           geometries: rr.info.memory ? rr.info.memory.geometries : null,
           textures: rr.info.memory ? rr.info.memory.textures : null };
  }
  let mesh = null;
  const scene = ls && ls.scene;
  if (scene) {
    let total = 0, visChain = 0;
    scene.traverse((o) => {
      if (o.isMesh || o.isInstancedMesh || o.isBatchedMesh) {
        total++;
        let vis = o.visible; let p = o.parent;
        while (vis && p) { if (!p.visible) { vis = false; break; } p = p.parent; }
        if (vis) visChain++;
      }
    });
    mesh = { total, visChain };
  }
  let wire = null, pvsVis = null, lod = null, pose = null;
  try { wire = d.wire && d.wire.summary ? d.wire.summary() : null; } catch (_) {}
  try { pvsVis = d.pvs && d.pvs.visibleCells ? d.pvs.visibleCells().size : null; } catch (_) {}
  try { lod = d.lod && d.lod.summary ? d.lod.summary() : null; } catch (_) {}
  try {
    const p = window.__sessionHandle.getLocalPlayerPose();
    if (p) {
      pose = { lb: p.landblockId >>> 0,
               x: Number.isFinite(p.x) ? p.x : null, y: Number.isFinite(p.y) ? p.y : null,
               z: Number.isFinite(p.z) ? p.z : null,
               heading: Number.isFinite(p.heading) ? p.heading : null, ground: p.isOnGround };
      try { p.free(); } catch (_) {} // wasm-owned struct — free every time
    }
  } catch (_) {}
  // drain rAF frame deltas
  const f = window.__fr || { buf: [] };
  const dts = f.buf; f.buf = [];
  dts.sort((a, c) => a - c);
  const n = dts.length;
  const pct = (q) => n ? +dts[Math.min(n - 1, Math.floor(q * n))].toFixed(1) : null;
  const sum = dts.reduce((a, c) => a + c, 0);
  const frame = { n, meanMs: n ? +(sum / n).toFixed(1) : null, p50: pct(0.5), p95: pct(0.95),
                  max: n ? +dts[n - 1].toFixed(1) : null, fps: sum ? +(n * 1000 / sum).toFixed(2) : null };
  // streaming / residency (battery-telepoi sample())
  const stt = ls?.landblockLru?.getStats?.() ?? {};
  return {
    t: Date.now(), boot: window.__bootState,
    heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
    frame, ri, mesh, wire, pvsVis, lod, pose,
    ltLen: (window.__perf && window.__perf.longtasks) ? window.__perf.longtasks.length : 0,
    terr: ls?.terrainBakedLbs?.size ?? 0, stat: ls?.staticsGroup?.children?.length ?? 0,
    cells: ls?.cellContainers3d?.size ?? 0,
    lru: stt.resident ?? null, parked: stt.parked ?? null, parkedTotal: stt.parkedTotal ?? null,
    unparkedTotal: stt.unparkedTotal ?? null, evicted: stt.evicted ?? null,
    work: (typeof window.__bakeWorkerSeq === "function") ? window.__bakeWorkerSeq() : null,
  };
}));
const chat = (c) => raced(helpers.evalInPage((cmd) => { try { window.__sessionHandle.sendChat(cmd); } catch (_) {} }, c));
const blurUi = () => helpers.evalInPage(() => { try { const el = document.activeElement; if (el && el !== document.body && el.blur) el.blur(); } catch (_) {} }).catch(() => {});

// wasm linear-memory per-stop sample (fail-soft; own short race — from battery).
const WASM_MEM_TIMEOUT_MS = 3000;
async function sampleWasmMemMB() {
  try {
    const ev = helpers.evalInPage(async () => {
      try {
        if (typeof window.__diag?.datDecode !== "function") return { main: null, worker: null };
        const r = await window.__diag.datDecode();
        const toMb = (b) => (typeof b === "number" && Number.isFinite(b)) ? Math.round(b / 1048576) : null;
        return { main: toMb(r?.main?.wasmMemoryBytes), worker: toMb(r?.worker?.wasmMemoryBytes) };
      } catch (_) { return { main: null, worker: null }; }
    });
    ev.catch(() => {});
    return await Promise.race([ev, new Promise((res) => setTimeout(() => res({ main: null, worker: null }), WASM_MEM_TIMEOUT_MS))]);
  } catch (_) { return { main: null, worker: null }; }
}

// settle-guard reducer — verbatim from battery-telepoi (session 11).
function settleStep(state, s, beforeWork, elapsedMs, opts) {
  const gate =
    (beforeWork == null || s.work == null) ? { open: true, reason: null }
    : (s.work - beforeWork) >= opts.workMin ? { open: true, reason: "work" }
    : elapsedMs >= opts.floorMs ? { open: true, reason: "floor" }
    : { open: false, reason: null };
  if (!gate.open) return { state: { stable: 0, last: null, guard: null }, settledMs: null };
  const key = `${s.terr}|${s.stat}|${s.cells}`;
  const stable = key === state.last ? state.stable + 1 : 0;
  const next = { stable, last: key, guard: gate.reason };
  if (stable >= 3) return { state: next, settledMs: elapsedMs - 1500 };
  return { state: next, settledMs: null };
}

// world XY from a pose (landblock-local x/y + landblockId).
const poseWorld = (pose) => {
  if (!pose || pose.lb == null || pose.x == null || pose.y == null) return null;
  const lbX = (pose.lb >>> 24) & 0xFF, lbY = (pose.lb >>> 16) & 0xFF;
  return { wx: lbX * LB_M + pose.x, wy: lbY * LB_M + pose.y };
};
// outdoor cell id for an arbitrary world XY (matches the generator).
const outdoorCell = (wx, wy) => {
  const lbX = Math.floor(wx / LB_M), lbY = Math.floor(wy / LB_M);
  const cX = Math.floor((wx - lbX * LB_M) / 24.0), cY = Math.floor((wy - lbY * LB_M) / 24.0);
  return (((lbX << 24) | (lbY << 16) | (cX * 8 + cY + 1)) >>> 0);
};
const angErrDeg = (aDeg, bDeg) => { let d = Math.abs(((aDeg - bDeg) % 360 + 540) % 360 - 180); return +d.toFixed(1); };

cycleT0 = Date.now();
const LAND_MAX_MS = 12_000;
const LAND_ITERS = Math.max(1, Math.ceil(LAND_MAX_MS / LAND_POLL_MS));

for (const plan of PLANS) {
  const poi = plan.poi;
  if (!plan.usable) {
    rows.push({ kind: "skip", poi, sessionIdx: SESSION_IDX, reason: plan.reason ?? "not usable" });
    console.error(`[outdoor] ${poi}: SKIP (${plan.reason ?? "not usable"})`);
    continue;
  }
  try {
    // 1) @telepoi -> land-wait -> settle (lightSample: see its comment)
    const before = await lightSample();
    const t0 = Date.now();
    await chat("@telepoi " + poi);
    let landed = false, landMs = null;
    for (let i = 0; i < LAND_ITERS; i++) {
      await page.waitForTimeout(LAND_POLL_MS);
      const s = await lightSample();
      if (s.pose?.lb != null && before.pose?.lb != null && s.pose.lb !== before.pose.lb) { landed = true; landMs = Date.now() - t0; break; }
      if (s.pose?.x != null && before.pose?.x != null && Math.hypot(s.pose.x - before.pose.x, s.pose.y - before.pose.y) > 8) { landed = true; landMs = Date.now() - t0; break; }
    }
    let settleMs = null, settleGuard = null;
    if (landed) {
      const s0 = Date.now();
      let stt2 = { stable: 0, last: null, guard: null };
      for (let i = 0; i < (DWELL_MAX_S * 2); i++) {
        await page.waitForTimeout(500);
        const s = await lightSample();
        const step = settleStep(stt2, s, before.work, Date.now() - s0, { workMin: SETTLE_WORK_MIN, floorMs: SETTLE_FLOOR_MS });
        stt2 = step.state;
        if (stt2.guard != null) settleGuard = stt2.guard;
        if (step.settledMs != null) { settleMs = step.settledMs; break; }
      }
      if (settleMs == null) settleMs = DWELL_MAX_S * 1000;
    }

    // 2) @teleloc to clear-start -> verify pose + heading
    const cs = plan.clearStart;
    let teleOk = false, headingErrDeg = null;
    if (landed) {
      await blurUi();
      await releaseAllKeys();
      await chat(`@teleloc ${cs.cell} ${cs.x} ${cs.y} ${cs.z} ${plan.quat.w} 0 0 ${plan.quat.z}`);
      await page.waitForTimeout(2500);
      const s = await lightSample();
      const w = poseWorld(s.pose);
      if (w) {
        const dist = Math.hypot(w.wx - cs.worldX, w.wy - cs.worldY);
        teleOk = dist <= TELEOK_TOL_M;
        if (s.pose.heading != null) {
          const measDeg = ((s.pose.heading * 180 / Math.PI) % 360 + 360) % 360;
          headingErrDeg = angErrDeg(measDeg, plan.headingDeg);
          if (headingErrDeg > 20) console.error(`[outdoor] ${poi}: heading err ${headingErrDeg}deg (meas ${measDeg.toFixed(0)} vs plan ${plan.headingDeg}) — quat convention check`);
        }
        if (!teleOk) console.error(`[outdoor] ${poi}: teleOk=false (pose ${dist.toFixed(1)}m from clearStart)`);
      }
    }

    // 3) RUN phase: hold 'w', sample, ping-pong, stuck-guard.
    const runSamples = [];
    let distanceM = 0, flips = 0, stuckEvents = 0, nudges = 0;
    let heapStartMB = null, heapEndMB = null;
    let ltStartIdx = 0, workStart = null, reclaimStart = null;
    let lastWorld = null, lastStuckWorld = null, lastStuckAt = 0, stuckStreak = 0;
    let origin = null;                 // world XY the corridor-s is measured from
    let hu = { x: Math.sin(plan.headingDeg * Math.PI / 180), y: Math.cos(plan.headingDeg * Math.PI / 180) };
    const corridorM = plan.corridorM;
    if (landed) {
      await blurUi();
      const s0 = await snapshot();
      ltStartIdx = s0.ltLen ?? 0;
      workStart = s0.work; reclaimStart = { evicted: s0.evicted ?? 0, parkedTotal: s0.parkedTotal ?? 0 };
      heapStartMB = s0.heapMB;
      const w0 = poseWorld(s0.pose);
      origin = w0; lastWorld = w0; lastStuckWorld = w0; lastStuckAt = Date.now();
      await holdKey("w");
      const runEnd = Date.now() + RUN_S * 1000;
      while (Date.now() < runEnd) {
        await page.waitForTimeout(SAMPLE_MS);
        await holdKey("w");                // re-assert every tick (self-heals a window-blur keyState reset)
        const s = await snapshot();
        s.phase = "run"; s.poi = poi;
        jsonl.write(JSON.stringify(s) + "\n");
        runSamples.push(s);
        heapEndMB = s.heapMB ?? heapEndMB;
        const w = poseWorld(s.pose);
        if (w && lastWorld) {
          const step = Math.hypot(w.wx - lastWorld.wx, w.wy - lastWorld.wy);
          if (step < TELE_JUMP_M) distanceM += step;  // exclude teleport/nudge jumps
        }
        if (w) lastWorld = w;
        // corridor-s along the current heading unit
        let s_along = null;
        if (w && origin) s_along = (w.wx - origin.wx) * hu.x + (w.wy - origin.wy) * hu.y;
        // PING-PONG: near the far end, 180 in place and run back
        if (w && s_along != null && s_along >= corridorM - PING_PONG_MARGIN_M) {
          const cell = `0x${outdoorCell(w.wx, w.wy).toString(16).toUpperCase().padStart(8, "0")}`;
          const zNow = s.pose?.z != null ? +(s.pose.z + 0.05).toFixed(3) : cs.z;
          await chat(`@teleloc ${cell} ${(w.wx % LB_M).toFixed(3)} ${(w.wy % LB_M).toFixed(3)} ${zNow} ${plan.flipQuat.w} 0 0 ${plan.flipQuat.z}`);
          hu = { x: -hu.x, y: -hu.y };
          origin = w;                       // measure s from this (far) end now
          flips++;
          await holdKey("w");
          await page.waitForTimeout(1500);
          lastWorld = null;                 // don't count the (tiny) turn as distance
        }
        // STUCK GUARD every ~6 s
        if (Date.now() - lastStuckAt >= STUCK_CHECK_MS) {
          const moved = (w && lastStuckWorld) ? Math.hypot(w.wx - lastStuckWorld.wx, w.wy - lastStuckWorld.wy) : 999;
          if (moved < STUCK_MOVE_MIN_M) {
            stuckEvents++; stuckStreak++;
            const key = (stuckStreak % 2 === 1) ? "d" : "a";
            await tapSidestep(key, SIDESTEP_MS);   // 'w' stays held at CDP level
            if (stuckStreak >= STUCK_STREAK_NUDGE && w) {
              // @teleloc ~30 m ahead along the current heading at pose.z+2 (gravity settles)
              const nx = w.wx + hu.x * NUDGE_AHEAD_M, ny = w.wy + hu.y * NUDGE_AHEAD_M;
              const cell = `0x${outdoorCell(nx, ny).toString(16).toUpperCase().padStart(8, "0")}`;
              const zN = s.pose?.z != null ? +(s.pose.z + 2).toFixed(3) : cs.z;
              await chat(`@teleloc ${cell} ${(nx % LB_M).toFixed(3)} ${(ny % LB_M).toFixed(3)} ${zN} ${plan.quat.w} 0 0 ${plan.quat.z}`);
              nudges++; stuckStreak = 0;
              await holdKey("w");
              lastWorld = null;
            }
          } else { stuckStreak = 0; }
          lastStuckWorld = w ?? lastStuckWorld; lastStuckAt = Date.now();
        }
      }
      await releaseAllKeys();
    }

    // 4) end-of-run aggregates + wasm mem
    let wasmMemMainMB = null, wasmMemWorkerMB = null;
    if (landed) { const wm = await sampleWasmMemMB(); wasmMemMainMB = wm.main; wasmMemWorkerMB = wm.worker; }
    const endSnap = runSamples[runSamples.length - 1] || {};
    const fpsArr = runSamples.map((r) => r.frame?.fps).filter((v) => v != null);
    const p50Arr = runSamples.map((r) => r.frame?.p50).filter((v) => v != null);
    const p95Arr = runSamples.map((r) => r.frame?.p95).filter((v) => v != null);
    const worstFrameMs = mx(runSamples.map((r) => r.frame?.max).filter((v) => v != null));
    // longtasks over the run: pull the slice since ltStartIdx and bucket it.
    let ltOverRun = [];
    if (landed) {
      ltOverRun = await helpers.evalInPage((idx) => (window.__perf ? window.__perf.longtasks.slice(idx) : []), ltStartIdx).catch(() => []);
    }
    const ltBucket = (lo, hi) => ltOverRun.filter((e) => e.dur >= lo && (hi == null || e.dur < hi)).length;
    const workDelta = (endSnap.work != null && workStart != null) ? endSnap.work - workStart : null;
    const reclaimDelta = (endSnap.evicted != null && reclaimStart != null)
      ? (endSnap.evicted - reclaimStart.evicted) + ((endSnap.parkedTotal ?? 0) - (reclaimStart.parkedTotal ?? 0)) : null;
    const avgSpeedMps = (landed && RUN_S > 0) ? +(distanceM / RUN_S).toFixed(2) : null;

    if (SHOTS && page.screenshot) {
      try { await page.screenshot({ path: path.join(SHOTS, `${poi.replace(/[^A-Za-z0-9-]/g, "_")}.png`) }); } catch (_) {}
    }

    rows.push({
      kind: "run", poi, sessionIdx: SESSION_IDX,
      landed, landMs, settleMs, settleGuard, teleOk, headingErrDeg,
      headingDeg: plan.headingDeg, corridorM,
      runS: RUN_S, distanceM: +distanceM.toFixed(1), avgSpeedMps, flips, stuckEvents, nudges,
      fpsMean: avg(fpsArr), fpsP50: med(p50Arr), fpsP95: med(p95Arr), worstFrameMs,
      ltCount: ltOverRun.length,
      ltBuckets: { "50-100": ltBucket(50, 100), "100-250": ltBucket(100, 250), "250-500": ltBucket(250, 500), "500-1000": ltBucket(500, 1000), "1000+": ltBucket(1000, null) },
      heapStartMB, heapEndMB, workDelta, reclaimDelta,
      wasmMemMainMB, wasmMemWorkerMB,
      runSamples: runSamples.length,
      endStats: { terr: endSnap.terr, stat: endSnap.stat, cells: endSnap.cells, lru: endSnap.lru, parked: endSnap.parked, parkedTotal: endSnap.parkedTotal, evicted: endSnap.evicted, cumCalls: endSnap.ri?.cumCalls ?? null, meshTotal: endSnap.mesh?.total ?? null },
    });
    console.error(`[outdoor] ${poi}: landed=${landed} teleOk=${teleOk} hdErr=${headingErrDeg}deg land=${landMs}ms settle=${settleMs}ms ` +
      `dist=${distanceM.toFixed(0)}m spd=${avgSpeedMps} flips=${flips} stuck=${stuckEvents} nudges=${nudges} ` +
      `fps=${avg(fpsArr)} p95=${med(p95Arr)} worst=${worstFrameMs}ms lt=${ltOverRun.length} heap=${heapStartMB}->${heapEndMB}MB`);

    if (MAX_STOPS && rows.filter((r) => r.kind === "run").length >= MAX_STOPS) {
      stopsCapped = true;
      console.error(`[outdoor] maxStops=${MAX_STOPS} reached — closing session for relaunch`);
      break;
    }
  } catch (e) {
    aborted = `${poi}: ${e?.message ?? e}`;
    console.error(`[outdoor] ABORT at ${poi}: ${aborted} — writing partial results`);
    try { await releaseAllKeys(); } catch (_) {}
    break;
  }
}

try { jsonl.end(); } catch (_) {}
const summary = finalize();
try { await raced(closeFn()); } catch (_) { /* dead browser — exit anyway */ }
const attemptedAll = summary.attempted + summary.skipped;
process.exit(
  aborted ? 3
  : (stopsCapped && attemptedAll < (PLANS_DOC.plans ? PLANS_DOC.plans.length : attemptedAll)) ? 3
  : summary.landed === summary.attempted ? 0 : 1
);
