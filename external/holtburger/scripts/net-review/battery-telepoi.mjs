#!/usr/bin/env node
// battery-telepoi.mjs — full @telepoi cycle timing battery (2026-07-10).
// Teleports through EVERY point_of_interest, timing land + stream-settle per
// stop, for cycle-speed A/Bs across variations (e.g. ?warmPark=on vs default)
// and across boxes (laptop SwiftShader/nullRender vs the 1070 real GPU).
//
// Modes:
//   --mode local  (default) — boot.mjs launchAndEnter (laptop headless).
//   --mode cdp    — connectOverCDP to an ALREADY-RUNNING off-screen Chrome
//                   (the 1070 MODE2i recipe; driver runs on the laptop over
//                   the -L 9333 tunnel; serve+bridge ride -R 8765/-R 8080).
// Common: --pois <file> (one name per line) --query "warmPark=on"
//         --label armA --out out.json --dwellMax 25 --shots <dir> (cdp only)
//         --cdp http://127.0.0.1:9333 --account tailnet1
//         --settleWorkMin 5 --settleFloorMs 3000 (settle-guard knobs, below)
//         --sessionLostStops 3 --recvDeadMs 15000 (liveness-abort knobs, below)
//
// Exit codes: 0 all POIs accounted for · 1 partial · 2 setup/boot failure ·
// 3 renderer-death abort or maxStops cap WITH POIs remaining (wrapper should
// --resume) · 4 SESSION LOST (see the liveness-abort block below; summary
// carries abortReason:"session-lost" — do NOT resume into it).
//
// Settle criterion: (terrainBakedLbs.size, staticsGroup.children.length,
// cellContainers3d.size) unchanged across 3 consecutive 500 ms samples —
// covers outdoor towns AND indoor dungeon POIs. Max --dwellMax s per stop.
//
// Settle-GUARD (session 11, 2026-07-10 — extends 1113 finding 5 + the s10
// false-settle finding, docs/1118.md §2): the 3×500 ms stability window is
// gated so it can only START counting once the bake pipe has actually
// delivered work (workDelta≥--settleWorkMin) OR a grace floor
// (--settleFloorMs) has elapsed with work still ≈0 — a cold/backlogged pipe
// no longer "settles" in ~0.5 s before its first delta. Each row records
// settleGuard ("work"|"floor"|null-when-work-telemetry-absent) + lowWork.
// ⚠ settleMs under the guard is NOT comparable to pre-guard arms — a
// genuinely-idle stop now floors at ~settleFloorMs+1.5 s instead of ~0.5 s;
// filter/segment by settleGuard (and sessionIdx, below) when A/Bing across
// the s11 boundary. See the reducer block above the main loop.
//
// sessionIdx (session 11): every row is stamped with the 0-based index of
// the driver invocation that produced it; --resume continues from
// (max prior sessionIdx)+1, so renderer-death relaunches segment cleanly and
// arm medians can be compared session-age-matched (summary.settleMedBySession).
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const MODE = arg("mode", "local");
const POIS_FILE = arg("pois", "");
const EXTRA_QUERY = arg("query", "");
const LABEL = arg("label", MODE);
const OUT = arg("out", "");
const SHOTS = arg("shots", "");
const DWELL_MAX_S = Number(arg("dwellMax", "25"));
const CDP_URL = arg("cdp", "http://127.0.0.1:9333");
const ACCOUNT = arg("account", "tailnet1");
// Settle-guard knobs (session 11, 2026-07-10 — see header + the reducer block
// before the main loop). WORK_MIN = streamed-work deltas that count as "the
// pipe has started"; FLOOR_MS = grace before a still-work≈0 stop is accepted
// as genuinely idle (same-LB / no-move-dup destinations stream ~zero work and
// must still settle, just not instantly-and-falsely).
const SETTLE_WORK_MIN = Number(arg("settleWorkMin", "5"));
const SETTLE_FLOOR_MS = Number(arg("settleFloorMs", "3000"));
// Driver-v2 knobs (2026-07-11 s13, all additive/back-compat):
//   --landPollMs   land-wait poll granularity (was hardcoded 250; finer poll
//                  halves the landMs quantization bias). The land WINDOW stays
//                  ~12s wall-clock — iteration count scales with the poll.
//   --quietGapMs   inter-SESSION gap, applied on --resume ONLY (between a prior
//                  session's teardown and this relaunch), so a resumed boot
//                  doesn't land mid-grace. Not applied before a fresh arm.
//   --maxStops     fixed-length sessions: after K stops the driver closes and
//                  exits for-relaunch (exit 3 → wrapper --resume), so
//                  settleMedBySession[j] is age-matched across arms by
//                  construction. 0 = unlimited (current behavior).
//   --settleMode   settle criterion. "default" = the s11 scene-count stability
//                  guard (unchanged). "workplateau" is a Tier-2 TODO (below).
const LAND_POLL_MS = Number(arg("landPollMs", "100"));
const QUIET_GAP_MS = Number(arg("quietGapMs", "65000"));
const MAX_STOPS = Number(arg("maxStops", "0"));
const SETTLE_MODE = arg("settleMode", "default");
// ── Session-liveness abort (2026-07-26; mitigation (b) of the armSlim
// teleport wedge, RESULTS-matcache-falsifier-2026-07-26.md execution-log
// item 5). ACE's `account_login_boots_in_use=1` evicts the incumbent session
// when the SAME account logs in a second time; from that moment every battery
// packet is discarded by the endpoint check (NetworkManager.cs:152-155) and
// the WS↔UDP bridge hands the page no close signal — so `@telepoi` silently
// does nothing and the land loop records stop after stop as `no-move dup`.
// That cost 19 consecutive POIs (Sawato→Zaikhal) of worthless route on
// 2026-07-25 before anyone noticed.
//
// `no-move dup` is ALSO a legitimate class (Hotel Swank / Swank / NightClub
// resolve to identical points_of_interest rows — ~4 per healthy full route),
// so the no-move count alone cannot separate "duplicate destination" from "we
// lost the server". The discriminator is a provably server-driven liveness
// signal: `SessionHandle.sessionLastRecvAgeMs()` — ms since the most recent
// INBOUND WS frame, stamped in exactly one place, the transport recv arm on
// `SessionEvent::Message` (apps/holtburger-web/src/lib.rs:38956). Nothing
// client-side can refresh it; it needs no JS drain, so a `?nullRender=1`
// session reports it truthfully; it is one wasm call per poll.
// (`sessionLastPingRttMs()` is NOT usable here — it is a last-MEASURED value
// that freezes at its last good number instead of ageing, so a dead session
// is indistinguishable from a healthy one. Pose is out too: landblockId
// legitimately lags/freezes.)
//
// Abort when SESSION_LOST_STOPS consecutive no-move stops each failed to see
// a single inbound frame within RECV_DEAD_MS across the WHOLE stop (~12 s of
// land polling ⇒ the freshest frame the stop ever saw was already stale when
// the stop began). A no-move stop with traffic still flowing — the legit dup —
// resets the streak, so healthy routes are recorded exactly as before.
const SESSION_LOST_STOPS = Number(arg("sessionLostStops", "3"));
const RECV_DEAD_MS = Number(arg("recvDeadMs", "15000"));

if (!POIS_FILE) { console.error("--pois <file> required"); process.exit(2); }
// --settleMode workplateau (Tier-2): NOT IMPLEMENTED. The s11 settle-guard keys
// stability on (terr,stat,cells) scene-count stability, not on a bake-work
// plateau; deriving a robust work-plateau criterion would change settle
// semantics (explicitly out of scope for this pass). Accept the flag but fail
// loudly rather than silently mis-measure. TODO(s14+): add a work-plateau mode
// (work delta ≈0 across N samples once the pipe has started) behind this value.
if (SETTLE_MODE !== "default") {
  if (SETTLE_MODE === "workplateau") {
    console.error("--settleMode workplateau: NOT IMPLEMENTED (Tier-2 TODO); use --settleMode default");
  } else {
    console.error(`--settleMode ${SETTLE_MODE}: unknown (only 'default' is implemented)`);
  }
  process.exit(2);
}
let POIS = fs.readFileSync(POIS_FILE, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);

// --resume: continue an aborted arm. Reads OUT (if present), keeps its rows,
// and only visits the POIs not yet attempted — a renderer death mid-cycle
// (SwiftShader under teleport churn) then costs one relaunch, not the arm.
// The wrapper loop re-invokes with the same --out until exit != 3.
const RESUME = process.argv.includes("--resume");
let priorRows = [];
if (RESUME && OUT && fs.existsSync(OUT)) {
  try {
    const prev = JSON.parse(fs.readFileSync(OUT, "utf8"));
    priorRows = Array.isArray(prev.rows) ? prev.rows : [];
    // kind:"abort" rows are die-stop telemetry, NOT completed stops — the poi
    // must be retried on resume (boot rows have no poi and are harmless here).
    const done = new Set(priorRows.filter((r) => r.kind !== "abort").map((r) => r.poi));
    POIS = POIS.filter((p) => !done.has(p));
    console.error(`[battery] resume: ${priorRows.length} prior rows kept, ${POIS.length} POIs remain`);
  } catch (_) { priorRows = []; }
}
// sessionIdx (session 11, 2026-07-10): 0-based index of THIS driver invocation
// / browser session. A renderer death aborts the arm (exit 3) and the wrapper
// re-invokes with --resume, so one invocation == one session and this stamp is
// constant for the whole run. Pre-feature prior rows (no sessionIdx) are the
// session-0 bucket; a fresh (non-resume) run is 0. See summary.settleMedBySession.
for (const r of priorRows) if (r.sessionIdx == null) r.sessionIdx = 0;
const SESSION_IDX = priorRows.length ? Math.max(...priorRows.map((r) => r.sessionIdx)) + 1 : 0;
if (POIS.length === 0) {
  console.log("BATTERY SUMMARY: nothing to do (all POIs already recorded)");
  process.exit(0);
}

// Inter-session quiet-gap (2026-07-11 s13): on --resume only, wait out ACE's
// ~25s session grace since the prior session's teardown before relaunching, so
// the next boot doesn't land mid-grace (the retired kick-dance's job, done
// right). A fresh (non-resume) arm waits nothing.
if (RESUME && priorRows.length) {
  console.error(`[battery] resume quiet-gap: ${QUIET_GAP_MS}ms before launch`);
  await new Promise((r) => setTimeout(r, QUIET_GAP_MS));
}

// ── results state + kind-aware finalizer (hoisted so the boot-stall path can
// flush a timed kind:"boot" row before exit — T10: stalls were invisible) ──
const rows = [];            // rows produced by THIS session (boot + stops)
let aborted = null;
let stopsCapped = false;
// Session-liveness abort state (2026-07-26). `aborted` is deliberately LEFT
// ALONE by this path: it means renderer-death to every downstream parser and
// drives exit 3 / wrapper --resume, which is the wrong response to a booted
// session. The new class gets its own fields + exit 4.
let abortReason = null;     // null | "session-lost"
let sessionLost = null;     // null | { reason, stops, sincePoi, atPoi, recvMinMs }
let liveState = { streak: 0, firstPoi: null };
let cycleT0 = Date.now();   // reset at the POI-loop start; guards finalize pre-loop
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const mx = (a) => (a.length ? Math.max(...a) : null);

function finalize() {
  const allRows = [...priorRows, ...rows];
  // Kind-aware: legacy rows have no `kind` and are stops; boot rows are excluded
  // from every stop metric so counts stay back-compat with the pre-boot-row shape.
  const stopRows = allRows.filter((r) => r.kind !== "boot" && r.kind !== "abort");
  const bootRows = allRows.filter((r) => r.kind === "boot");
  const ok = stopRows.filter((r) => r.landed);
  const priorStop = priorRows.filter((r) => r.kind !== "boot" && r.kind !== "abort").length;
  const totalPois = priorStop + POIS.length;
  const cycleMs = Date.now() - cycleT0;
  const sess = [...new Set(stopRows.map((r) => r.sessionIdx ?? 0))].sort((a, b) => a - b);
  const summary = {
    label: LABEL, mode: MODE, query: EXTRA_QUERY || null,
    pois: totalPois,
    aborted, stopsCapped, attempted: stopRows.length,
    landed: ok.length, cycleMs,
    activeMsSum: ok.reduce((a, r) => a + (r.landMs ?? 0) + (r.settleMs ?? 0), 0),
    landMedianMs: med(ok.map((r) => r.landMs)),
    settleMedianMs: med(ok.map((r) => r.settleMs)),
    settleCapped: ok.filter((r) => r.settleMs >= DWELL_MAX_S * 1000).length,
    sameLb: ok.filter((r) => r.sameLb).length,
    noMove: stopRows.filter((r) => r.noMove).length,
    // ── Session-liveness abort columns (2026-07-26, ALL additive; every field
    // above keeps its meaning). `abortReason` is null on a healthy run;
    // "session-lost" means the run was cut short because SESSION_LOST_STOPS
    // consecutive no-move stops saw ZERO inbound server frames — ACE had
    // booted us and `@telepoi` was going nowhere. `sessionLost` carries the
    // detail (first + last dead POI, streak length, freshest recv age seen).
    // `deadNoMoveStops` counts every stop classified dead even when the run
    // was not aborted, and `recvAgeMed/MaxMs` are the per-stop freshest-frame
    // ages (null on a pkg without `sessionLastRecvAgeMs`).
    abortReason, sessionLost,
    sessionLostStops: SESSION_LOST_STOPS, recvDeadMs: RECV_DEAD_MS,
    deadNoMoveStops: stopRows.filter((r) => r.sessionLive === false).length,
    recvAgeMedMs: med(stopRows.map((r) => r.recvMinMs).filter((v) => v != null)),
    recvAgeMaxMs: mx(stopRows.map((r) => r.recvMinMs).filter((v) => v != null)),
    workDeltaMedian: med(ok.map((r) => r.workDelta).filter((v) => v != null)),
    reclaimDeltaMedian: med(ok.map((r) => r.reclaimDelta).filter((v) => v != null)),
    // wasm linear-memory per-stop residency (docs/1122.md §5.6, S15): med/max
    // over landed stops, both instances; null when no stop reported a value
    // (legacy pkg / worker absent).
    wasmMemMainMedMB: med(ok.map((r) => r.wasmMemMainMB).filter((v) => v != null)),
    wasmMemMainMaxMB: mx(ok.map((r) => r.wasmMemMainMB).filter((v) => v != null)),
    wasmMemWorkerMedMB: med(ok.map((r) => r.wasmMemWorkerMB).filter((v) => v != null)),
    wasmMemWorkerMaxMB: mx(ok.map((r) => r.wasmMemWorkerMB).filter((v) => v != null)),
    // S5-soak relay-extension aggregates (2026-07-25): renderer JS-heap peak,
    // per-instance shard/surface cache residency, and pressure/queue extremes.
    // All null when no row carried the field (legacy pkg / pre-extension rows).
    // Renamed from jsHeapPeak* (RETRACTION-jsheap-step-2026-07-26): the old
    // column carried Blink's quantized/20-min-cached value on every run before
    // 2026-07-26 and must not be compared against. jsV8Peak* is precise (the
    // harness now launches with --enable-precise-memory-info) but is V8-heap
    // ONLY — ArrayBuffer externals live in matMB/palMB/entMB.
    jsV8PeakMedMB: med(ok.map((r) => r.jsV8PeakMB).filter((v) => v != null)),
    jsV8PeakMaxMB: mx(ok.map((r) => r.jsV8PeakMB).filter((v) => v != null)),
    shardMainMaxMB: mx(ok.map((r) => r.shardMainMB).filter((v) => v != null)),
    shardWkrMaxMB: mx(ok.map((r) => r.shardWkrMB).filter((v) => v != null)),
    surfMainMaxMB: mx(ok.map((r) => r.surfMainMB).filter((v) => v != null)),
    surfWkrMaxMB: mx(ok.map((r) => r.surfWkrMB).filter((v) => v != null)),
    pressureMaxMain: mx(ok.map((r) => r.pressureMain).filter((v) => v != null)),
    pressureMaxWkr: mx(ok.map((r) => r.pressureWkr).filter((v) => v != null)),
    maxQueueMsMaxMain: mx(ok.map((r) => r.maxQueueMsMain).filter((v) => v != null)),
    maxQueueMsMaxWkr: mx(ok.map((r) => r.maxQueueMsWkr).filter((v) => v != null)),
    settleWorkMin: SETTLE_WORK_MIN, settleFloorMs: SETTLE_FLOOR_MS,
    lowWorkSettles: ok.filter((r) => r.lowWork).length,
    settleGuardWork: ok.filter((r) => r.settleGuard === "work").length,
    settleGuardFloor: ok.filter((r) => r.settleGuard === "floor").length,
    // Boot accounting (session 13, additive): timed per-session boot rows +
    // outcome census, so a boot stall is a DATA row, not a silent exit(2).
    landPollMs: LAND_POLL_MS, quietGapMs: QUIET_GAP_MS, maxStops: MAX_STOPS,
    boots: bootRows.length,
    bootMedMs: med(bootRows.map((r) => r.bootMs).filter((v) => v != null)),
    bootOutcomes: {
      inWorld: bootRows.filter((r) => r.outcome === "in-world").length,
      stall: bootRows.filter((r) => r.outcome === "stall").length,
      error: bootRows.filter((r) => r.outcome === "error").length,
    },
    sessions: sess.length,
    settleMedBySession: sess.map((sidx) => {
      const seg = ok.filter((r) => (r.sessionIdx ?? 0) === sidx);
      return {
        sessionIdx: sidx, n: seg.length,
        settleMedMs: med(seg.map((r) => r.settleMs)),
        reclaimMedMs: med(seg.map((r) => r.reclaimDelta).filter((v) => v != null)),
      };
    }),
    final: allRows[allRows.length - 1] ?? null,
  };
  if (OUT) fs.writeFileSync(OUT, JSON.stringify({ summary, rows: allRows }, null, 2));
  console.log(JSON.stringify(summary));
  console.log(`BATTERY SUMMARY: ${LABEL} pois=${summary.landed}/${summary.pois} ` +
    `active=${(summary.activeMsSum / 1000).toFixed(1)}s landMed=${summary.landMedianMs}ms ` +
    `settleMed=${summary.settleMedianMs}ms capped=${summary.settleCapped} ` +
    `sameLb=${summary.sameLb} noMove=${summary.noMove} workMed=${summary.workDeltaMedian} reclaimMed=${summary.reclaimDeltaMedian} ` +
    `sessions=${summary.sessions} sessionIdx=${SESSION_IDX} lowWork=${summary.lowWorkSettles} ` +
    `boots=${summary.boots}(iw=${summary.bootOutcomes.inWorld}/stall=${summary.bootOutcomes.stall}/err=${summary.bootOutcomes.error}) bootMed=${summary.bootMedMs}ms` +
    (stopsCapped ? ` STOPS-CAPPED(${MAX_STOPS})` : "") +
    (aborted ? ` ABORTED(${aborted})` : "") +
    (sessionLost
      ? ` SESSION-LOST(${sessionLost.stops} dead no-move stops ${sessionLost.sincePoi}→${sessionLost.atPoi}; ` +
        `freshest inbound frame ${sessionLost.recvMinMs}ms old ≥ ${RECV_DEAD_MS}ms — ` +
        `another login almost certainly booted this account)`
      : ""));
  return summary;
}

const bootT0 = Date.now();
let page, helpers, closeFn;
let bootMs = null, bootOutcome = "stall";
let rendererCrashed = false; // set by the local-mode page 'crash' listener (s13)
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
    finalize(); // FLUSH the boot row before exit (T10: stalls were invisible)
    console.log("BATTERY SUMMARY: SKIP boot-stalled");
    await r.helpers.close(); process.exit(2);
  }
  bootOutcome = "in-world";
  rows.push({ kind: "boot", sessionIdx: SESSION_IDX, mode: MODE, bootMs, outcome: bootOutcome });
  page = r.page; helpers = r.helpers; closeFn = () => helpers.close();
  // s13 crash disambiguation: playwright fires 'crash' when the RENDERER
  // PROCESS dies (Chromium OOM-kill / SwiftShader abort); an eval-timeout
  // with rendererCrashed=false is a HANG (wedged main thread), a different
  // bug class. The abort label below uses this instead of guessing.
  r.page.on("crash", () => { rendererCrashed = true; });
} else {
  // cdp: attach to the interactive-session Chrome on the 1070. NEVER close
  // the browser (a person's machine) — close only OUR page.
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  let pw;
  try { pw = require("playwright-core"); } catch (_) {
    // runbook fallback: the npx cache install
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
  // Poll in-world; ⚠ helper attach waits need 'ready', but the battery only
  // uses sendChat/getLocalPlayerPose, live at 'in-world'.
  let inWorld = false, bootErr = false;
  for (let i = 0; i < 240; i++) {
    // eslint-disable-next-line no-await-in-loop
    const bs = await page.evaluate(() => window.__bootState).catch(() => null);
    if (bs === "in-world" || bs === "ready") { inWorld = true; break; }
    if (bs === "error") { bootErr = true; break; }
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(1000);
  }
  bootMs = Date.now() - bootT0;
  bootOutcome = inWorld ? "in-world" : (bootErr ? "error" : "stall");
  if (!inWorld) {
    rows.push({ kind: "boot", sessionIdx: SESSION_IDX, mode: MODE, bootMs, outcome: bootOutcome });
    finalize(); // FLUSH the boot row before exit
    console.log("BATTERY SUMMARY: SKIP boot-stalled (cdp)");
    await page.close(); process.exit(2);
  }
  rows.push({ kind: "boot", sessionIdx: SESSION_IDX, mode: MODE, bootMs, outcome: bootOutcome });
  // Real-GPU assert (MODE2i contract): SSH-launched Chrome silently falls
  // back to no-GL; only the interactive-session launch gives ANGLE/D3D11.
  const gpu = await page.evaluate(() => {
    try {
      const c = document.createElement("canvas");
      const gl = c.getContext("webgl2") || c.getContext("webgl");
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      return gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
    } catch (e) { return "ERR:" + e; }
  }).catch(() => "ERR:eval");
  console.error(`[battery] UNMASKED_RENDERER = ${gpu}`);
  if (!/NVIDIA|GTX|Direct3D/i.test(String(gpu))) {
    finalize(); // flush the (in-world) boot row before the GPU-skip exit
    console.log(`BATTERY SUMMARY: SKIP not-real-GPU (${gpu})`);
    await page.close(); process.exit(2);
  }
  helpers = { evalInPage: (fn, ...a) => page.evaluate(fn, ...a) };
  closeFn = () => page.close(); // page only; the browser stays for its owner
}

for (let i = 0; i < 90; i++) {
  if (await helpers.evalInPage(() => !!(window.liveScene3d && window.liveScene3d.scene))) break;
  await page.waitForTimeout(1000);
}
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

// Crash/hang hardening (2026-07-10, learned on the first full cycle): a
// SwiftShader renderer death mid-cycle either THROWS from evaluate ("Target
// crashed" — arm 1, stop 43) or HANGS it forever (arm 2, stop 13). Race
// every evaluate against a 15 s timer, and on any failure abort the arm but
// WRITE THE PARTIAL JSON — 40 comparable stops beat 0.
const EVAL_TIMEOUT_MS = 15_000;
const raced = (p) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(
    () => rej(new Error(rendererCrashed
      ? "renderer-crash (page crash event fired)"
      : "eval-timeout (main-thread hang; no crash event)")),
    EVAL_TIMEOUT_MS
  )),
]);
const sample = () => raced(helpers.evalInPage(() => {
  const s = window.liveScene3d;
  let pose = null; try { pose = window.__sessionHandle.getLocalPlayerPose(); } catch (_) {}
  const st = s?.landblockLru?.getStats?.() ?? {};
  return {
    lb: pose?.landblockId != null ? (pose.landblockId >>> 0) : null,
    // In-LB position: lets a same-LB teleport (Hotel → Hotel Swank) count
    // as landed-no-move instead of a land-timeout failure.
    px: Number.isFinite(pose?.x) ? Math.round(pose.x * 10) / 10 : null,
    py: Number.isFinite(pose?.y) ? Math.round(pose.y * 10) / 10 : null,
    terr: s?.terrainBakedLbs?.size ?? 0,
    stat: s?.staticsGroup?.children?.length ?? 0,
    cells: s?.cellContainers3d?.size ?? 0,
    lru: st.resident ?? null, parked: st.parked ?? null,
    parkedTotal: st.parkedTotal ?? null, unparkedTotal: st.unparkedTotal ?? null,
    evicted: st.evicted ?? null,
    // Session liveness (2026-07-26): ms since the most recent INBOUND WS
    // frame. Stamped in exactly one place — the wasm transport recv arm on
    // `SessionEvent::Message` (src/lib.rs:38956) — so it is provably
    // server-driven and cannot be refreshed by anything the client does.
    // null on a pkg without the accessor (fail-soft ⇒ the liveness abort
    // never arms); 4294967295 (u32::MAX) means "nothing has EVER arrived /
    // post-disconnect" and is passed through as the huge value it is.
    recvAge: (() => {
      try {
        const h = window.__sessionHandle;
        if (typeof h?.sessionLastRecvAgeMs !== "function") return null;
        return h.sessionLastRecvAgeMs() >>> 0;
      } catch (_) { return null; }
    })(),
    // Streamed-work + reclaim-gate telemetry (2026-07-10 follow-up #4):
    // settle-stability alone can't tell settled from streaming-starved.
    work: (typeof window.__bakeWorkerSeq === "function") ? window.__bakeWorkerSeq() : null,
    centerJumps: st.centerJumps ?? null, gateHeldTicks: st.gateHeldTicks ?? null,
    // Session 7 TN-storm-fix telemetry (passive; null on a pre-fix page):
    // dual-state merges + in-flight reclaim deferrals — a nonzero merge
    // count with evicted flat is the fix WORKING (the merge replaced a
    // would-have-been true-dispose).
    trackMerged: st.trackMergedWhileParked ?? null,
    reclaimDeferred: st.reclaimDeferredInFlight ?? null,
    // S5-soak relay extension (2026-07-25, HANDOFF-s4-battery-s5-preview move 1):
    // renderer-process JS heap, sampled on EVERY poll so the stop row can
    // carry a PEAK — the cold-spike killer was invisible to the once-post-
    // settle wasm sample (wasm main read only 120–680 MB at death). Chrome-
    // only API; null elsewhere. Bytes here; MB conversion at row time.
    jsu: (typeof performance !== "undefined" && performance.memory)
      ? performance.memory.usedJSHeapSize : null,
    // MaterialCache-retainer discriminator (2026-07-25, RESULTS-s5-soak): the
    // materials map is never evicted and each entry retains a full RGBA copy
    // (adapter.js surfacePixelsToTexture "Always copy"); linear growth from
    // stop 1 confirms it as the late-session JS-heap killer, flat-across-the-
    // jump refutes it. Spread into every stop row as `mats`/`texs`.
    mats: s?.materialCache?.materials?.size ?? null,
    texs: s?.materialCache?.textures?.size ?? null,
    // `?matBudgetMB=N` falsifier columns (2026-07-25, next-move 1). `mats`
    // alone cannot tell "bounded at cap" from "nothing to evict yet", so
    // carry the estimated bytes, the armed budget (null = unbounded, i.e.
    // the unauthored baseline arm) and the cumulative eviction count from
    // the same `__diag.materialCache()` snapshot the eviction loop uses.
    // Fail-soft: null on any page whose cache predates `materialCacheStats`.
    ...(() => {
      try {
        const st2 = s?.materialCache?.materialCacheStats?.();
        if (!st2) return { matMB: null, matBudgetMB: null, matEvict: null };
        return {
          matMB: Math.round(st2.bytes / 1048576),
          matBudgetMB: st2.budgetMB ?? null,
          matEvict: st2.evictions ?? null,
        };
      } catch (_) {
        return { matMB: null, matBudgetMB: null, matEvict: null };
      }
    })(),
    // Entity-owned recolored-texture columns (2026-07-26,
    // RESULTS-matcache-falsifier next-move 1). `matMB` above cannot see this
    // pool at all — entity-owned textures are per-WEARER and live outside all
    // four bounded MaterialCache maps — and the `?matBudgetMB=64`
    // intervention refuted those maps as the 3.6 GB retainer while the step
    // kept firing at Swank. `entMB` = live entity-owned bytes, `entHi` = the
    // high-water mark (so a burst that has since been disposed still shows up
    // in a once-per-stop sample). Additive + fail-soft exactly like matMB:
    // null on any page whose scene3d predates `__diag.entityOwned`.
    ...(() => {
      try {
        const es = window.__diag?.entityOwned?.();
        if (!es) return { entMB: null, entHi: null };
        return {
          entMB: Math.round(es.liveBytes / 1048576),
          entHi: Math.round(es.hiWaterBytes / 1048576),
        };
      } catch (_) {
        return { entMB: null, entHi: null };
      }
    })(),
    // Paletted (recolored) surface-cache columns (2026-07-26). THE lead
    // Swank suspect: `palettedMaterials`/`palettedTextures` are keyed by
    // outfit SIGNATURE and are never charged to the `_matLru` that
    // `matMB`/`matBudgetMB` bound — so the falsifier's budget intervention
    // could not touch them. They WERE capped by COUNT (256), which thrashed
    // (evicting on signature count while the bytes were still small) and the
    // shared recolor degenerated into per-wearer duplication; as of the same
    // day they have their own BYTE budget, `?palBudgetMB=N` (default 64 MiB;
    // `off` restores the count cap). The confirming pattern at Swank is
    // `palEvict` spiking + `palMB` (and the heap) climbing while `matMB`
    // stays flat.
    //
    // ⚠ `palHiMB` IS THE GATING NUMBER for the 64 MiB default: settling well
    // under 64 ⇒ bring the default down; `palEvict` still spiking at 64 ⇒
    // raise it. Fail-soft nulls like matMB.
    ...(() => {
      try {
        const ps = window.__diag?.palettedCache?.();
        if (!ps) return { palSigs: null, palMB: null, palHiMB: null, palEvict: null };
        return {
          palSigs: ps.signatures ?? null,
          palMB: Math.round(ps.bytes / 1048576),
          palHiMB: Math.round(ps.hiWaterBytes / 1048576),
          palEvict: ps.evictions ?? null,
        };
      } catch (_) {
        return { palSigs: null, palMB: null, palHiMB: null, palEvict: null };
      }
    })(),
  };
}));
const chat = (c) => raced(helpers.evalInPage((cmd) => { try { window.__sessionHandle.sendChat(cmd); } catch (_) {} }, c));

// wasm linear-memory per-stop sample (docs/1122.md §5.6, S15): both wasm
// instances via the `__diag.datDecode()` relay — the SAME accessor ci-smoke
// S5b reads (main instance = `r.main.wasmMemoryBytes`, worker instance =
// `r.worker.wasmMemoryBytes` through the bake-worker relay). Fully fail-soft
// and MUST NOT abort or slow a stop: a legacy pkg (field absent), an absent
// worker (`r.worker == null`), an evaluate error, or a wedged main thread all
// yield {main:null, worker:null}. Bounded by its OWN short race (not the 15 s
// eval guard) so a hang here can't stretch a stop; the timeout resolves to
// nulls rather than rejecting, so it never enters the arm-abort path. Rounded
// to whole MB to match the S5b report.
const WASM_MEM_TIMEOUT_MS = 3000;
// S5-soak field-list extension (2026-07-25, HANDOFF-s4-battery-s5-preview move 1
// + DESIGN-surface-budget §3 rig note): same fail-soft once-post-settle relay
// read, now also carrying per-instance shardCacheBytes / surfaceCacheBytes /
// surfaceDecodeTotal+Dids and the decodeAdmission gate view
// (pressureLevel/effectiveMaxJobs/queued/maxQueueMs/peakLiveJobs), so the
// cold-spike killer and any budget thrash are directly observable rather than
// inferred. Every field independently null on a legacy pkg / absent worker.
const NULL_DIAG = { main: null, worker: null, ext: null };
async function sampleWasmMemMB() {
  try {
    const ev = helpers.evalInPage(async () => {
      try {
        if (typeof window.__diag?.datDecode !== "function") return { main: null, worker: null, ext: null };
        const r = await window.__diag.datDecode();
        const toMb = (b) => (typeof b === "number" && Number.isFinite(b)) ? Math.round(b / 1048576) : null;
        const num = (v) => (typeof v === "number" && Number.isFinite(v)) ? v : null;
        const inst = (i) => (i == null) ? null : {
          shardMB: toMb(i.shardCacheBytes),
          surfMB: toMb(i.surfaceCacheBytes),
          sdTot: num(i.surfaceDecodeTotal), sdDids: num(i.surfaceDecodeDids),
          pressure: num(i.decodeAdmission?.pressureLevel),
          effJobs: num(i.decodeAdmission?.effectiveMaxJobs),
          queued: num(i.decodeAdmission?.queued),
          maxQueueMs: num(i.decodeAdmission?.maxQueueMs),
          peakLiveJobs: num(i.decodeAdmission?.peakLiveJobs),
        };
        return {
          main: toMb(r?.main?.wasmMemoryBytes), worker: toMb(r?.worker?.wasmMemoryBytes),
          ext: { main: inst(r?.main), worker: inst(r?.worker) },
        };
      } catch (_) { return { main: null, worker: null, ext: null }; }
    });
    // Swallow a LATE rejection (evalInPage failing after the timeout already
    // won the race) — otherwise it is an unhandledRejection, which kills the
    // whole driver on modern node. A rejection BEFORE the timeout still
    // rejects the race and lands in the catch below.
    ev.catch(() => {});
    return await Promise.race([
      ev,
      new Promise((res) => setTimeout(() => res(NULL_DIAG), WASM_MEM_TIMEOUT_MS)),
    ]);
  } catch (_) {
    return NULL_DIAG;
  }
}

// <settle-guard> (session 11, 2026-07-10 — extends 1113 finding 5; docs/1118.md
// §2 false-settle finding). Pure per-sample reducer for the settle window,
// factored out so /tmp harnesses can drive it with synthetic sample sequences.
// state = {stable, last, guard}; returns {state, settledMs|null}. The GATE:
// the stability counter may only accumulate once the bake pipe has actually
// begun (workDelta since teleport ≥ workMin) OR a grace floor (floorMs) has
// elapsed with work still ≈0 (a genuinely-idle same-LB / no-move-dup stop —
// those stream ~zero work and must still settle, just not falsely-at-0.5s).
// Fail-soft: when work telemetry is null (pre-__bakeWorkerSeq page, or a
// null-work before/after sample) the gate opens immediately → today's
// pre-guard behavior, unchanged. gate.reason ("work"|"floor") is null on the
// fail-soft path; callers latch the last non-null reason as the row's
// settleGuard, and lowWork := settleGuard === "floor".
function settleStep(state, s, beforeWork, elapsedMs, opts) {
  const gate =
    (beforeWork == null || s.work == null) ? { open: true, reason: null }        // fail-soft
    : (s.work - beforeWork) >= opts.workMin ? { open: true, reason: "work" }
    : elapsedMs >= opts.floorMs             ? { open: true, reason: "floor" }
    : { open: false, reason: null };
  // Window not open yet: reset the run so the counter starts fresh once it is.
  if (!gate.open) return { state: { stable: 0, last: null, guard: null }, settledMs: null };
  const key = `${s.terr}|${s.stat}|${s.cells}`;
  const stable = key === state.last ? state.stable + 1 : 0;
  const next = { stable, last: key, guard: gate.reason };
  // Same 3-consecutive-stable-sample criterion; the −1500 backs out the dwell.
  if (stable >= 3) return { state: next, settledMs: elapsedMs - 1500 };
  return { state: next, settledMs: null };
}
// </settle-guard>

// <liveness-abort> (2026-07-26 — mitigation (b) of the armSlim teleport wedge;
// see the SESSION_LOST_STOPS block at the top for the WHY and for why
// `sessionLastRecvAgeMs()` is the signal). Pure per-stop reducer, factored out
// exactly like settleStep so it can be driven with synthetic stop sequences by
// scripts/net-review/test_battery_liveness_abort.mjs (no browser, no boot).
//
//   state = { streak, firstPoi }
//   stop  = { poi, noMove, recvMinMs }   recvMinMs = the SMALLEST recvAge seen
//           across every sample of that stop (before + land + settle) — i.e.
//           the freshest inbound server frame the stop ever observed. null =
//           no telemetry (legacy pkg / eval failure).
//   opts  = { stops, deadMs }
//
// Per-stop classification:
//   landed (noMove false)         → alive by construction        → reset
//   no-move, recvMinMs == null    → UNKNOWN; fail-soft           → reset
//                                   (never abort on a missing instrument)
//   no-move, recvMinMs <  deadMs  → LEGIT DUPLICATE POI: the server is still
//                                   talking to us (Hotel Swank / Swank /
//                                   NightClub class, ~4 per healthy route)
//                                                                → reset
//   no-move, recvMinMs >= deadMs  → dead window                  → streak++
// Abort fires the moment the streak reaches opts.stops. Returns
// { state, live, abort }, where `live` is the tri-state the stop row records
// as `sessionLive` and `abort` is null or the summary's `sessionLost` object.
function livenessStep(state, stop, opts) {
  const live = stop.recvMinMs == null ? null : (stop.recvMinMs < opts.deadMs);
  if (!stop.noMove || live !== false) {
    return { state: { streak: 0, firstPoi: null }, live, abort: null };
  }
  const streak = state.streak + 1;
  const next = { streak, firstPoi: state.firstPoi ?? stop.poi };
  const abort = streak >= opts.stops
    ? { reason: "session-lost", stops: streak, sincePoi: next.firstPoi,
        atPoi: stop.poi, recvMinMs: stop.recvMinMs }
    : null;
  return { state: next, live, abort };
}
// </liveness-abort>

// rows / aborted / cycleT0 are hoisted above the boot section (so a boot stall
// can flush). Reset cycleT0 to the active-cycle start here.
cycleT0 = Date.now();
// Land-wait window stays ~12s wall-clock; only the poll granularity changes with
// --landPollMs (finer poll → less landMs quantization bias).
const LAND_MAX_MS = 12_000;
const LAND_ITERS = Math.max(1, Math.ceil(LAND_MAX_MS / LAND_POLL_MS));
for (const poi of POIS) {
  // JS-heap PEAK over every poll in this stop (before + land + settle): the
  // cold-spike killer is likely JS-side and a single post-settle sample
  // misses the transient. Bytes accumulated; MB at row time. Hoisted OUTSIDE
  // the try so the abort path can flush a kind:"abort" row carrying the peak
  // observed up to the crash — the die-stop was previously invisible.
  let jsPeak = null;
  const seeJsu = (s) => {
    if (s && typeof s.jsu === "number") jsPeak = jsPeak == null ? s.jsu : Math.max(jsPeak, s.jsu);
  };
  // Freshest inbound server frame observed anywhere in this stop (MIN of the
  // recv AGE, so smaller = more alive). Sampled on every poll for the same
  // reason jsPeak is: a single post-settle read would miss a stop that was
  // alive at the start and dead by the end (and, for a no-move stop, there is
  // no post-settle read at all — the settle loop is skipped).
  let recvMin = null;
  const seeRecv = (s) => {
    if (s && typeof s.recvAge === "number") recvMin = recvMin == null ? s.recvAge : Math.min(recvMin, s.recvAge);
  };
  try {
  const before = await sample();
  seeJsu(before); seeRecv(before);
  const t0 = Date.now();
  await chat("@telepoi " + poi);
  // land = landblock changed (high-16 OR full id — dungeons can share hi16)
  // OR the in-LB position moved >8 units (a same-LB hop). Duplicate POIs
  // (Hotel / Hotel Swank / HotelSwank, Night Club / NightClub) are IDENTICAL
  // destinations in points_of_interest (verified in ace_world 2026-07-10),
  // so a back-to-back duplicate produces ZERO observable movement — the
  // land window expiring with no movement is recorded as noMove (a
  // landed-no-move duplicate, NOT a failure; every name on the list comes
  // from `@telepoi list`, so an unknown-POI no-op can't be the cause).
  let landed = false, landMs = null, sameLb = false, noMove = false;
  for (let i = 0; i < LAND_ITERS; i++) {
    await page.waitForTimeout(LAND_POLL_MS);
    const s = await sample();
    seeJsu(s); seeRecv(s);
    if (s.lb != null && before.lb != null && s.lb !== before.lb) { landed = true; landMs = Date.now() - t0; break; }
    if (s.px != null && before.px != null
        && Math.hypot(s.px - before.px, s.py - before.py) > 8) {
      landed = true; sameLb = true; landMs = Date.now() - t0; break;
    }
  }
  if (!landed) noMove = true;
  let settleMs = null, endStats = null, settleGuard = null, lowWork = false;
  if (landed) {
    const s0 = Date.now();
    let st = { stable: 0, last: null, guard: null };
    for (let i = 0; i < (DWELL_MAX_S * 2); i++) {
      await page.waitForTimeout(500);
      const s = await sample();
      seeJsu(s); seeRecv(s);
      endStats = s;
      const step = settleStep(st, s, before.work, Date.now() - s0,
        { workMin: SETTLE_WORK_MIN, floorMs: SETTLE_FLOOR_MS });
      st = step.state;
      // Latch the last non-fail-soft gate reason as the row's settleGuard, so
      // a stop that settled work-starved reads "floor" (lowWork) and a real
      // streamed stop reads "work"; null == guard inactive (no work telemetry).
      if (st.guard != null) settleGuard = st.guard;
      if (step.settledMs != null) { settleMs = step.settledMs; break; }
    }
    if (settleMs == null) settleMs = DWELL_MAX_S * 1000; // never settled: cap
    lowWork = settleGuard === "floor";
    if (SHOTS && page.screenshot) {
      try {
        await page.screenshot({ path: path.join(SHOTS, `${poi.replace(/[^A-Za-z0-9-]/g, "_")}.png`) });
      } catch (_) {}
    }
  }
  // wasm linear-memory per-stop column (docs/1122.md §5.6, S15). Sampled once
  // AFTER settle for a landed stop; null for an unlanded (no-move) stop. Fully
  // fail-soft — never aborts or slows the stop (see sampleWasmMemMB).
  let wasmMemMainMB = null, wasmMemWorkerMB = null, diagExt = null;
  if (landed) {
    const wm = await sampleWasmMemMB();
    wasmMemMainMB = wm.main; wasmMemWorkerMB = wm.worker; diagExt = wm.ext;
  }
  // Flattened per-instance relay-extension columns (all null on legacy pkg /
  // absent worker / unlanded stop) — see sampleWasmMemMB's header comment.
  const dm = diagExt?.main ?? null, dw = diagExt?.worker ?? null;
  const jsV8PeakMB = jsPeak != null ? Math.round(jsPeak / 1048576) : null;
  // Per-stop deltas (before → settled): streamed-work = bake-worker requests
  // issued; reclaimOps = evictions + parks (the ping-pong metric — baseline
  // ~75/stop pre-gate, target <10).
  const workDelta = (endStats?.work != null && before.work != null)
    ? endStats.work - before.work : null;
  const reclaimDelta = (endStats?.evicted != null && before.evicted != null)
    ? (endStats.evicted - before.evicted)
      + ((endStats.parkedTotal ?? 0) - (before.parkedTotal ?? 0))
    : null;
  // Session-liveness verdict for THIS stop (2026-07-26). Pure reducer, see the
  // <liveness-abort> block: a no-move stop that saw NO inbound server frame for
  // the whole stop advances the dead streak; anything else (landed, a no-move
  // with traffic = the legit duplicate POI, or no telemetry at all) resets it.
  const lv = livenessStep(liveState, { poi, noMove, recvMinMs: recvMin },
    { stops: SESSION_LOST_STOPS, deadMs: RECV_DEAD_MS });
  liveState = lv.state;
  rows.push({ kind: "stop", poi, sessionIdx: SESSION_IDX, landed, sameLb, noMove, landMs, settleMs,
    settleGuard, lowWork, workDelta, reclaimDelta, ...(endStats ?? {}),
    // AFTER the endStats spread so they can never be clobbered by a sample key.
    recvMinMs: recvMin, sessionLive: lv.live, deadStreak: lv.state.streak,
    wasmMemMainMB, wasmMemWorkerMB,
    jsV8PeakMB,
    shardMainMB: dm?.shardMB ?? null, shardWkrMB: dw?.shardMB ?? null,
    surfMainMB: dm?.surfMB ?? null, surfWkrMB: dw?.surfMB ?? null,
    sdTotMain: dm?.sdTot ?? null, sdDidsMain: dm?.sdDids ?? null,
    sdTotWkr: dw?.sdTot ?? null, sdDidsWkr: dw?.sdDids ?? null,
    pressureMain: dm?.pressure ?? null, pressureWkr: dw?.pressure ?? null,
    effJobsMain: dm?.effJobs ?? null, effJobsWkr: dw?.effJobs ?? null,
    queuedMain: dm?.queued ?? null, queuedWkr: dw?.queued ?? null,
    maxQueueMsMain: dm?.maxQueueMs ?? null, maxQueueMsWkr: dw?.maxQueueMs ?? null,
    peakLiveJobsMain: dm?.peakLiveJobs ?? null, peakLiveJobsWkr: dw?.peakLiveJobs ?? null });
  console.error(`[battery] ${poi}: landed=${landed}${sameLb ? " (same-LB)" : ""}${noMove ? " (no-move dup)" : ""} ` +
    `land=${landMs}ms settle=${settleMs}ms guard=${settleGuard}${lowWork ? " (lowWork)" : ""} ` +
    `lru=${endStats?.lru} parked=${endStats?.parked} work+${workDelta} reclaim+${reclaimDelta} ` +
    `jsV8=${jsV8PeakMB}MB press=${dm?.pressure ?? "-"}/${dw?.pressure ?? "-"} ` +
    `shard=${dm?.shardMB ?? "-"}/${dw?.shardMB ?? "-"}MB surf=${dm?.surfMB ?? "-"}/${dw?.surfMB ?? "-"}MB ` +
    `mats=${endStats?.mats ?? "-"}@${endStats?.matMB ?? "-"}MB/${endStats?.matBudgetMB ?? "unbounded"} evict=${endStats?.matEvict ?? "-"} ` +
    `ent=${endStats?.entMB ?? "-"}MB hi=${endStats?.entHi ?? "-"}MB ` +
    `pal=${endStats?.palSigs ?? "-"}@${endStats?.palMB ?? "-"}MB hi=${endStats?.palHiMB ?? "-"}MB palEvict=${endStats?.palEvict ?? "-"} ` +
    `recv=${recvMin ?? "-"}ms live=${lv.live ?? "?"}${lv.state.streak ? ` deadStreak=${lv.state.streak}` : ""}`);
  // Session lost: ACE booted this account (a second login on the same account)
  // and the bridge never told the page — every further @telepoi would be
  // recorded as a bogus `no-move dup`. Stop the run NOW with a named reason
  // rather than "completing" a worthless route. Exit 4, NOT 3: a wrapper that
  // --resumes would just re-login into the same fight.
  if (lv.abort) {
    sessionLost = lv.abort;
    abortReason = lv.abort.reason;
    console.error(`[battery] SESSION LOST at ${poi}: ${lv.abort.stops} consecutive no-move stops ` +
      `(${lv.abort.sincePoi}→${lv.abort.atPoi}) with ZERO inbound server frames ` +
      `(freshest ${lv.abort.recvMinMs}ms old ≥ recvDeadMs=${RECV_DEAD_MS}). ` +
      `Almost certainly a second login on account '${ACCOUNT}' (ACE account_login_boots_in_use). ` +
      `Aborting — writing partial results.`);
    break;
  }
  // --maxStops K: fixed-length sessions. After K stops in THIS session close and
  // exit for-relaunch (exit 3 → wrapper --resume), so every session holds K
  // stops and settleMedBySession[j] is age-matched across arms by construction.
  if (MAX_STOPS && rows.filter((r) => r.kind === "stop").length >= MAX_STOPS) {
    stopsCapped = true;
    console.error(`[battery] maxStops=${MAX_STOPS} reached — closing session for relaunch`);
    break;
  }
  } catch (e) {
    aborted = `${poi}: ${e?.message ?? e}`;
    // kind:"abort" row (2026-07-25 S5 soak): best-effort telemetry from the
    // DYING stop — the crash stop never reached rows.push, so the killer's
    // last observed JS-heap peak was invisible. Excluded from stop metrics
    // (finalize filters it out) and from the --resume done-set (the poi is
    // retried on relaunch, same as before this row existed).
    rows.push({ kind: "abort", poi, sessionIdx: SESSION_IDX, aborted,
      jsV8PeakMB: jsPeak != null ? Math.round(jsPeak / 1048576) : null,
      rendererCrashed });
    console.error(`[battery] ABORT at ${poi}: ${aborted} — writing partial results ` +
      `(die-stop jsV8Peak=${jsPeak != null ? Math.round(jsPeak / 1048576) : null}MB)`);
    break;
  }
}

const summary = finalize();
try { await raced(closeFn()); } catch (_) { /* dead browser — exit anyway */ }
// no-move duplicates are accounted-for stops, not misses (see the land loop).
// Exit 3 both on a renderer-death abort AND on a clean maxStops cap with POIs
// still remaining, so the wrapper relaunches (--resume) a fresh session.
// Exit 4 for a lost session — a DISTINCT code so the wrapper's `ec == 3 →
// --resume` arm does not fire (resuming would re-login into the same eviction
// fight and record more bogus no-move dups); summary.abortReason tells the
// operator why. Checked first: the liveness abort never sets `aborted`.
process.exit(
  sessionLost ? 4
  : aborted ? 3
  : (stopsCapped && summary.attempted < summary.pois) ? 3
  : (summary.landed + summary.noMove) === summary.pois ? 0 : 1
);
