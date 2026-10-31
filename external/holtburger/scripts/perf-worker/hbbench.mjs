// hbbench.mjs — interleaved fresh-profile 1070 bench against a FROZEN snapshot server.
//   node hbbench.mjs --arms arms.json --reps 2 --port 8766 --out DIR [--uncapped]
//   node hbbench.mjs --arms docs/reengineering/queue-1070/<batch>.json --item <ID> ...   (arms inside a queue item)
//   node hbbench.mjs --arms <queue.json> --check-snapshot /mnt/wbterminal2/hb-snap/<B0>   (M1-PRE: the queue's
//        b0Snapshot.requiredReaders found in the snapshot's OWN files; exit 0/1; touches nothing else)
// --uncapped: Chrome runs without the vblank cap (box launcher reads D:\Temp\hbbench\uncapped.txt;
// deploy box/*.bat to D:\Temp\hbbench\ first) — fps then tracks the slowest stage continuously.
// arms.json: [{name, quality, flags, chrome?: {angle?, disableFeatures?, extraFlags?}}]. Per run: boot -> Holtburg -> settle -> FIRST TURN (12 s
// third-person 360 sweep) -> orbit warm-up -> STILL 20 s + MOVING 20 s (orbit) -> cold teleport tour
// (poi:Shoushi 35 s, back 35 s).
//
// HARNESS V2 (2026-10-30, round 3 R3-0 — docs/2026-10-29-round3-gpu-driven.md §3 R3-0 item 2, §4, §5).
// Default ON; `--compat v1` reproduces the pre-v2 page side exactly for runs that must pool with v1
// data (RC-BENCH v2 reps 2-3): the pre-v2 URL, 1280,720 outer window, 12 deg/s orbit, no in-page
// probe, no DayGroup, and NOTHING added between the settle and the end of the tour (the pin read-back,
// wasm check and server-state census move after the tour; box samples only before launch and after
// the tour). tests/hb_v2.test.mjs replays runOne against a fake page and pins that step sequence to
// the pre-v2 hbbench.mjs's, call for call.
// Everything below is recorded in each arm-rep JSON (schema "hbbench-run-v2"):
//   * pins: `skytime=13` + a fixed clear DayGroup (index 0 "Sunny", via setGameDayOverride — no URL
//     flag exists), `renderScale=1`, `adaptiveRes=off`, `targetFps=0`, and `gpuGovernor=off` once
//     R3-11's flag has a url-flags.md row (detected at start; recorded as governorFlag); an arm that
//     names one of them in its flags keeps its own (`armOverride`);
//   * window: per-arm INNER size (`arm.window` "W,H", default 1920,1080 = budget resolution; "1280,720"
//     for continuity with history), set exactly through CDP Browser.setWindowBounds after launch;
//     innerWidth x innerHeight, outer size and devicePixelRatio recorded;
//   * box samples before the first segment, between segments and after the last: box/hbwho.ps1
//     (idle, gpu3d_other, browsers ...) PLUS the top processes by CPU in core-equivalents with ours
//     marked (bench 1's Seagate Toolkit hog was invisible to boxwatch; plan §1.1);
//   * asserts: release wasm (the wasm the page actually loaded, walked by harness/lib/wasm_profile.mjs;
//     a dev wasm on the server aborts the run before any arm), the URL pins, GTX 1070 adapter
//     string (throws, as before), the DayGroup and skytime read back from the page;
//   * in-page probe (lib/hb_page.mjs pageInstallProbe) on the first turn, still, moving and tour
//     segments: per frame renderer.info calls/triangles + camera heading (12 heading bins, L1),
//     renderJs (a renderer.render timing wrapper), multidraw ranges next to info.calls
//     (__batchedRuns.frame() batched calls / ranges asked / issued, terrain-batch ranges), render
//     walks per frame and per pass (scene | layer mask | target) with empty walks counted. Per-frame
//     columns go to <arm>-r<rep>.frames.json, summaries + heading bins into the run JSON;
//   * server-state pin: entity count + entity part-mesh census after settle and after the tour;
//     an arm-rep whose entity count differs from the reference arm's by > 10% is flagged (rule V);
//   * arm.gate: a page expression that must be true after settle or the arm-rep is skipped as
//     INVALID (M1b-OCC O-rigs: `__occlusionCull.mode === 'rigs'` and `stats.cellsSkipped > 0`, so a
//     snapshot that predates `=rigs` cannot pass as an A/A); hbreport --queue also refuses a rep that
//     skipped the gate;
//   * a queue item's `removedArms` (arms of a deleted flag, each with a `removed` note; e.g. the
//     ?rustEntityWorld / ?uploadWarmDraw arms, deleted 2026-10-30 after D1) never run: loadArms reads
//     `arms` only. hbreport still reads their gate / predict, for the runs already stored;
//   * arm.spot (teleloc / poi:), arm.stillCam (player camera for the M1c parked pose), arm.skytime,
//     arm.dayGroup ("none" = no override), arm.readyWhen ("live-scene" for ?nullRender=1).
// Analyse: python3 -I scripts/perf-worker/hbreport.py bench <OUT> [--box-events <queue.json>].
import { mkdirSync, writeFileSync, readFileSync, lstatSync, realpathSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// 2026-10-20: every URL pins ?targetFps=0 — the page's 60/30 VTank frame cap
// engages under connectOverCDP's focus emulation (lib/bench-url.mjs says why).
import { uncappedBenchUrl } from "./lib/bench-url.mjs";
import {
  HARNESS_V2, V2_DEFAULTS, V1_DEFAULTS, benchUrlBase, redactUrl, urlPins, urlPinProblems, parseWindow, governorFlagDocumented,
  dayYearForGroup, DAY_GROUP_DAT_NAMES, frameStats, loadArms, rotation, relDelta, summarizeProbeSegment, runAssertProblems, buildAsserts,
  snapshotReaderProblems,
} from "./lib/hb_v2.mjs";
import { CDP, killBench, prepareLaunch, launchChrome, boxSample, armKillOnSignal } from "./lib/hb_box.mjs";
import { waitAccountFree, connectAtLaunch, sizeWindow, waitBootReady, teleportSettle, wasmProfileOf, servedWasmUrl } from "./lib/hb_session.mjs";
import { pageInstallProbe, pageServerState, pageApplyPins, pageGateValue, pageGateInfo } from "./lib/hb_page.mjs";

const HOLT_SPOT = "0xA9B40001 96 96 80";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** CLI options (pure). */
export function parseArgs(argv) {
  const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const compat = opt("--compat", null);
  if (compat !== null && compat !== "v1") throw new Error(`--compat: only v1 is known (got ${compat})`);
  return {
    arms: opt("--arms"), item: opt("--item", null), reps: +opt("--reps", 2), port: opt("--port", "8766"),
    tour: opt("--tour", "poi:Shoushi"), hold: +opt("--hold", 35000), uncapped: argv.includes("--uncapped"),
    out: opt("--out", `/mnt/wbterminal1/tmp/claude-scratch/perf/hbbench-${Date.now()}`), compat,
    window: opt("--window", null), skytime: opt("--skytime", null), dayGroup: opt("--daygroup", null),
    ref: opt("--ref", null), noProbe: argv.includes("--no-probe"), noFirstTurn: argv.includes("--no-first-turn"),
    allowDevWasm: argv.includes("--allow-dev-wasm"), noBoxSamples: argv.includes("--no-box-samples"),
    checkSnapshot: opt("--check-snapshot", null),
  };
}

/** Box-sample points of a v2 arm-rep: before launch, around every segment, after the tour. */
export const V2_BOX_SAMPLES = Object.freeze(["pre-launch", "pre-firstTurn", "pre-still", "still-moving", "post-moving", "post-tour"]);
/** `--compat v1`: only outside the pre-v2 step sequence (before Chrome starts, after the tour). */
export const V1_BOX_SAMPLES = Object.freeze(["pre-launch", "post-tour"]);

/** Everything one arm-rep will do, decided before anything runs (pure; the suite pins it). */
export function planArm(arm, o) {
  const compat = o.compat || null;
  const app = `http://127.0.0.1:${o.port || "8766"}/apps/holtburger-web/index.html`;
  const url = uncappedBenchUrl(benchUrlBase(app, arm, { compat, skytime: o.skytime != null ? o.skytime : null, governorFlag: !!o.governorFlag }));
  let window;
  if (compat === "v1") window = { outer: V1_DEFAULTS.window, target: null };
  else {
    const t = parseWindow(arm.window || o.window || V2_DEFAULTS.window);
    window = { outer: `${t.w},${t.h}`, target: t };
  }
  let dayGroup = null;
  const dgIn = arm.dayGroup != null ? arm.dayGroup : o.dayGroup != null ? o.dayGroup : V2_DEFAULTS.dayGroup;
  if (compat !== "v1" && dgIn !== "none") {
    const idx = Number(dgIn);
    if (!Number.isInteger(idx) || idx < 0 || idx > 19) throw new Error(`dayGroup must be 0..19 or "none" (got ${dgIn})`);
    dayGroup = { ...dayYearForGroup(idx), datName: DAY_GROUP_DAT_NAMES[idx] };
  }
  return {
    app, url, compat, window, dayGroup,
    orbitDegPerSec: compat === "v1" ? V1_DEFAULTS.orbitDegPerSec : Number(arm.orbitDegPerSec || V2_DEFAULTS.orbitDegPerSec),
    probe: compat !== "v1" && !o.noProbe && arm.probe !== false,
    spot: arm.spot || HOLT_SPOT,
    stillCam: arm.stillCam || null,
    readyWhen: arm.readyWhen || "boot-ready",
    gate: arm.gate || null,
    gateInfo: arm.gateInfo || null,
    // v2 additions that touch the page between the settle and the end of the tour; compat v1 runs
    // none of them there (the read-back and the census run after the tour instead).
    boxSampleAt: o.noBoxSamples ? [] : compat === "v1" ? [...V1_BOX_SAMPLES] : [...V2_BOX_SAMPLES],
    pinsBeforeSegments: compat !== "v1",
    settledServerState: compat !== "v1",
    exposeOrbit: compat !== "v1",
    governorFlag: !!o.governorFlag,
    pins: urlPins(url, arm),
  };
}

/** The I/O runOne uses; the suite swaps in fakes (no browser, no ssh). */
export const RUN_DEPS = Object.freeze({
  waitAccountFree, killBench, prepareLaunch, launchChrome, connectAtLaunch, sizeWindow, waitBootReady, teleportSettle, wasmProfileOf, boxSample,
  sleep: (ms) => sleep(ms), writeFile: (path, text) => writeFileSync(path, text),
});

// The rAF frame recorder of every timed segment (unchanged since v1).
const FRAMES = async ({ ms, orbit }) => {
  const d = []; let last = null; const tS = performance.now();
  await new Promise((res) => { const f = (now) => { if (last !== null) d.push(now - last); last = now; if (orbit) window.__cam.orbit(orbit.x, orbit.y, orbit.z, orbit.dist, orbit.az + (now - tS) / 1000 * orbit.degPerSec, orbit.el); if (now - tS >= ms) return res(); requestAnimationFrame(f); }; requestAnimationFrame(f); });
  return d;
};

/**
 * One arm-rep. `deps` (default RUN_DEPS) is every side effect: the suite replays this against a fake
 * page and pins the step sequence (compat v1 = the pre-v2 one, call for call; v2 = spot, readyWhen,
 * gate, stillCam, DayGroup and box samples where planArm says).
 */
export async function runOne(arm, rep, ctx, deps = RUN_DEPS) {
  const d = { ...RUN_DEPS, ...deps };
  const { o, OUT, log } = ctx;
  const plan = planArm(arm, o);
  const res = { schema: "hbbench-run-v2", harness: HARNESS_V2, compat: plan.compat, arm: arm.name, rep, flags: arm.flags, quality: arm.quality,
    url: redactUrl(plan.url), plan: { window: plan.window, dayGroup: plan.dayGroup, orbitDegPerSec: plan.orbitDegPerSec, probe: plan.probe, spot: plan.spot, stillCam: plan.stillCam, readyWhen: plan.readyWhen, gate: plan.gate, boxSampleAt: plan.boxSampleAt },
    startedAt: new Date().toISOString(), box: [] };
  const frames = {};
  const sample = async (label) => { if (plan.boxSampleAt.includes(label)) res.box.push(await d.boxSample(label)); };
  res.accountFree = await d.waitAccountFree();
  d.killBench();
  let browser = null;
  const errors = [];
  try {
    await d.prepareLaunch({ profile: `hbb-bench-${arm.name}-${rep}-${Date.now()}`, windowOuter: plan.window.outer, uncapped: o.uncapped, chrome: arm.chrome });
    // --uncapped (2026-10-19): the launcher adds --disable-frame-rate-limit --disable-gpu-vsync, so a
    // frame that takes 9 ms reads 111 fps instead of snapping to 60 on the box's 120 Hz grid.
    res.uncapped = o.uncapped;
    await sample("pre-launch");
    if (!(await d.launchChrome(CDP))) throw new Error("test Chrome never answered on CDP (hbgate refused? see D:\\Temp\\hbbench\\gate.log)");
    const c = await d.connectAtLaunch(CDP);
    browser = c.browser;
    const pg = c.pg;
    pg.on("pageerror", (e) => errors.push(String(e?.message ?? e).slice(0, 200)));
    pg.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
    if (plan.window.target) res.window = await d.sizeWindow(c.ctx, pg, plan.window.target);
    // `url` is planArm's `const url = uncappedBenchUrl(...)` (tests/frame_cap.test.mjs reads every
    // driver's goto() for that builder).
    const { url } = plan;
    await pg.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    res.gpu = await pg.evaluate(() => { const gl = document.createElement("canvas").getContext("webgl2"); const e = gl.getExtension("WEBGL_debug_renderer_info"); return gl.getParameter(e.UNMASKED_RENDERER_WEBGL); });
    if (!/1070/.test(res.gpu)) throw new Error("not on 1070");
    await pg.evaluate(async () => { try { window.__benchWake = await navigator.wakeLock.request("screen"); } catch (_) {} });
    const boot = await d.waitBootReady(pg, { readyWhen: plan.readyWhen });
    res.bootMs = boot.ms;
    if (!boot.ok) throw new Error("boot never ready");
    await d.sleep(5000);
    if (plan.dayGroup) res.pinsBoot = await pg.evaluate(pageApplyPins, { dayGroup: plan.dayGroup });
    res.settle = await d.teleportSettle(pg, plan.spot);
    res.serverState = {};
    if (plan.settledServerState) res.serverState.settled = await pg.evaluate(pageServerState).catch((e) => ({ error: String(e?.message ?? e) }));
    if (plan.gate) {
      const v = await pg.evaluate(pageGateValue, plan.gate).catch((e) => `evaluate failed: ${e?.message ?? e}`);
      const info = plan.gateInfo ? await pg.evaluate(pageGateInfo, plan.gateInfo).catch(() => null) : null;
      res.gate = { expr: plan.gate, value: v, info, ok: v === true };
      if (v !== true) throw new Error(`gate failed: ${plan.gate} -> ${JSON.stringify(v)}`);
    }
    // Pins read back + asserts: v2 right before the segments (the DayGroup override is re-applied, in
    // case the teleport dropped it); compat v1 after the tour, so its step sequence stays the pre-v2 one.
    const readPins = async (dg) => {
      res.pins = await pg.evaluate(pageApplyPins, dg ? { dayGroup: dg } : {});
      const wasm = [];
      for (const w of res.pins.wasm || []) wasm.push(await d.wasmProfileOf(w.url.replace(/^https?:\/\/[^/]+/, `http://127.0.0.1:${o.port}`)));
      if (!wasm.length) wasm.push({ ...(await d.wasmProfileOf(servedWasmUrl(plan.app))), source: "served-file (page listed no .wasm resource)" });
      res.asserts = buildAsserts({ plan, gpu: res.gpu, pins: res.pins, wasm, sized: res.window });
      res.assertProblems = runAssertProblems(res).problems;
      if (res.assertProblems.length) log(`  ASSERT ${arm.name} r${rep}: ${res.assertProblems.join("; ")}`);
    };
    if (plan.pinsBeforeSegments) await readPins(plan.dayGroup);
    if (plan.probe) res.probeInstall = await pg.evaluate(pageInstallProbe, {});
    const probeOn = plan.probe && res.probeInstall && res.probeInstall.installed;
    const seg = async (label, fn) => {
      if (probeOn) await pg.evaluate((l) => window.__hbProbe.begin(l), label);
      const fr = await fn();
      if (probeOn) {
        const p = await pg.evaluate(() => window.__hbProbe.end());
        if (p) { frames[label] = p; (res.probe ||= {})[label] = summarizeProbeSegment(p); }
      }
      return fr;
    };
    await sample("pre-firstTurn");
    // FIRST TURN: the first third-person 360-degree sweep after the world settles (cold views:
    // first-sight programs, uploads). --no-first-turn skips it.
    if (!o.noFirstTurn) {
      res.firstTurn = frameStats(await seg("firstTurn", () => pg.evaluate(async (ms) => {
        try { window.__cam.release(); } catch (_) {}
        const d = []; let last = null; const t0 = performance.now();
        await new Promise((res) => { const f = (now) => { if (last !== null) d.push(now - last); last = now; window.__cam.player(8, ((now - t0) / ms) * 360, 12, 1.5); if (now - t0 >= ms) return res(); requestAnimationFrame(f); }; requestAnimationFrame(f); });
        return d;
      }, 12000)));
      await d.sleep(2000);
    }
    const pose = await pg.evaluate(() => window.__cam.world());
    const orbit = { x: pose.x, y: pose.y, z: pose.z + 1.5, dist: 70, az: 45, el: 22, degPerSec: plan.orbitDegPerSec };
    res.orbit = orbit;
    if (plan.exposeOrbit) await pg.evaluate((o2) => { window.__hbOrbit = o2; }, orbit);
    await pg.evaluate(FRAMES, { ms: 25000, orbit });
    if (plan.stillCam) await pg.evaluate((s) => window.__cam.player(s.dist ?? 8, s.az ?? 180, s.el ?? 12, s.dz ?? 1.5), plan.stillCam);
    else await pg.evaluate((o2) => window.__cam.orbit(o2.x, o2.y, o2.z, o2.dist, o2.az, o2.el), orbit);
    await d.sleep(3000);
    await sample("pre-still");
    res.still = frameStats(await seg("still", () => pg.evaluate(FRAMES, { ms: 20000, orbit: null })));
    await sample("still-moving");
    res.moving = frameStats(await seg("moving", () => pg.evaluate(FRAMES, { ms: 20000, orbit })));
    await sample("post-moving");
    res.draws = await pg.evaluate(async () => { const r = window.liveScene3d.renderer, p = r.info.autoReset; r.info.autoReset = false; r.info.reset(); let f = 0; await new Promise((res) => { const t = performance.now(); const k = (n) => { f++; if (n - t > 2000) return res(); requestAnimationFrame(k); }; requestAnimationFrame(k); }); const c = r.info.render.calls; r.info.autoReset = p; return Math.round(c / f); });
    // cold teleport tour, camera following the player
    const fr = await seg("tour", async () => {
      await pg.evaluate(() => { try { window.__cam.release(); } catch (_) {} window.__hbF = []; window.__hbRec = true; const f = (n) => { if (!window.__hbRec) return; window.__hbF.push(n); requestAnimationFrame(f); }; requestAnimationFrame(f); });
      const go = o.tour.startsWith("poi:") ? `@telepoi ${o.tour.slice(4)}` : `@teleloc ${o.tour.split(",").join(" ")}`;
      await pg.evaluate((cmd) => window.__sessionHandle.sendChat(cmd), go);
      await d.sleep(o.hold);
      await pg.evaluate((cmd) => window.__sessionHandle.sendChat(cmd), `@teleloc ${HOLT_SPOT}`);
      await d.sleep(o.hold);
      return pg.evaluate(() => { window.__hbRec = false; return window.__hbF; });
    });
    res.tour = frameStats(fr.slice(1).map((t, i) => t - fr[i]));
    res.extra = await pg.evaluate(() => ({ asyncLink: window.__asyncLink ? { ...window.__asyncLink.stats } : null, occ: window.__occlusionCull?.stats ?? null, programs: window.liveScene3d.renderer.info.programs.length }));
    // ---- everything below runs after the timed part ----
    await sample("post-tour");
    if (!plan.pinsBeforeSegments) await readPins(null);
    // read-only: did the DayGroup / sky pin survive the tour's two teleports?
    res.pinsEnd = await pg.evaluate(pageApplyPins, {}).then((p) => ({ dayGroup: p.dayGroup, skyTimePin: p.skyTimePin, timeOfDay: p.timeOfDay })).catch(() => null);
    res.serverState.end = await pg.evaluate(pageServerState).catch((e) => ({ error: String(e?.message ?? e) }));
    if (probeOn) res.probeUninstall = await pg.evaluate(() => window.__hbProbe ? window.__hbProbe.uninstall() : null).catch(() => null);
  } catch (e) { res.error = String(e?.message ?? e); }
  finally {
    try {
      res.errors = errors.slice(0, 30);
      res.endedAt = new Date().toISOString();
      d.writeFile(join(OUT, `${arm.name}-r${rep}.json`), JSON.stringify(res, null, 1));
      if (Object.keys(frames).length) d.writeFile(join(OUT, `${arm.name}-r${rep}.frames.json`), JSON.stringify({ arm: arm.name, rep, segments: frames }));
    } finally {
      // a failed write (disk full, OUT gone) must not leave the test Chrome logged in on the box
      try { if (browser) await browser.close(); } catch (_) {}
      d.killBench();
    }
  }
  return res;
}

/** The entity count the server-state pin compares: the settled census (v2), else the post-tour one (compat v1). */
export function pinEntities(r) {
  const s = r && r.serverState;
  if (!s) return undefined;
  if (s.settled && Number.isFinite(s.settled.entities)) return s.settled.entities;
  return s.end && Number.isFinite(s.end.entities) ? s.end.entities : undefined;
}

/** Does the app's url-flags.md document R3-11's gpuGovernor flag yet? (then every URL pins it off) */
export function detectGovernorFlag() {
  try { return governorFlagDocumented(readFileSync(new URL("../../apps/holtburger-web/docs/url-flags.md", import.meta.url), "utf8")); } catch (_) { return false; }
}

/** The live tree hb-mksnap.sh snapshots (its SRC): a "snapshot" that IS this tree is refused. */
export const LIVE_ROOT = process.env.HB_LIVE_ROOT || "/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger";

/** Node file access for snapshotReaderProblems. */
export const SNAPSHOT_IO = Object.freeze({
  realpath: (p) => realpathSync(p),
  lstat: (p) => { try { const st = lstatSync(p); return { isSymlink: st.isSymbolicLink(), isDir: st.isDirectory() }; } catch (_) { return null; } },
  readText: (p) => readFileSync(p, "utf8"),
  readdir: (p) => readdirSync(p),
});

/**
 * `--check-snapshot DIR` (the M1-PRE step): DIR = the frozen B0 snapshot (scripts/perf-worker/hb-mksnap.sh
 * output, served on :8766). Checks the queue's `b0Snapshot.requiredReaders` against the snapshot's own
 * files (lib/hb_v2.mjs snapshotReaderProblems). Touches nothing but local files.
 */
export function checkSnapshot(dir, queueJson, io = SNAPSHOT_IO, { liveRoot = LIVE_ROOT } = {}) {
  return snapshotReaderProblems(dir, queueJson && queueJson.b0Snapshot, io, { liveRoot });
}

async function main(argv) {
  const o = parseArgs(argv);
  o.governorFlag = detectGovernorFlag();
  if (!o.arms) throw new Error("--arms <file> is required");
  const armsJson = JSON.parse(readFileSync(o.arms, "utf8"));
  if (o.checkSnapshot) {
    const r = checkSnapshot(o.checkSnapshot, armsJson);
    for (const f of r.found) console.log(`  ok   ${f.flag}: ${f.file}`);
    for (const p of r.problems) console.log(`  FAIL ${p}`);
    console.log(r.ok ? `B0 snapshot ${o.checkSnapshot}: every required reader is in the snapshot's own files` : `B0 snapshot ${o.checkSnapshot}: NOT usable as B0 (${r.problems.length} problem(s))`);
    process.exit(r.ok ? 0 : 1);
  }
  const ARMS = loadArms(armsJson, o.item);
  const OUT = o.out;
  mkdirSync(OUT, { recursive: true });
  const t0 = Date.now();
  const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
  for (const a of ARMS) planArm(a, o); // throws on a bad arm before anything touches the box
  const app = `http://127.0.0.1:${o.port}/apps/holtburger-web/index.html`;
  const served = await wasmProfileOf(servedWasmUrl(app));
  const meta = { schema: "hbbench-meta-v2", harness: HARNESS_V2, argv, startedAt: new Date(t0).toISOString(), compat: o.compat, port: o.port,
    item: o.item, arms: ARMS, reps: o.reps, servedWasm: served, ref: o.ref || ARMS[0].name, governorFlag: o.governorFlag };
  writeFileSync(join(OUT, "run.json"), JSON.stringify(meta, null, 1));
  log(`served wasm: ${served.profile} (${served.reason}; ${served.size} B)`);
  if (served.profile !== "release" && !o.allowDevWasm) {
    log("ABORT: the served wasm is not a release build (rule V: dev wasm invalidates every timing). --allow-dev-wasm to run anyway.");
    process.exit(3);
  }
  // From here on every arm launches the test Chrome on the box: Ctrl-C kills it before exiting.
  armKillOnSignal();
  const ctx = { o, OUT, log };
  const all = [];
  const refName = meta.ref;
  let refEntities = null;
  for (let rep = 1; rep <= o.reps; rep++) {
    for (const arm of rotation(ARMS, rep)) {
      log(`run ${arm.name} r${rep}`);
      const r = await runOne(arm, rep, ctx);
      all.push(r);
      const ent = pinEntities(r);
      if (arm.name === refName && refEntities === null && Number.isFinite(ent)) refEntities = ent;
      if (refEntities !== null && Number.isFinite(ent)) {
        const d = relDelta(refEntities, ent);
        r.serverPin = { ref: refName, refEntities, entities: ent, delta: d === null ? null : +d.toFixed(3), ok: d !== null && d <= 0.1 };
        if (!r.serverPin.ok) log(`  WARN server-state pin: ${ent} entities vs ${refEntities} in ${refName} (${(100 * d).toFixed(1)}% > 10%)`);
        writeFileSync(join(OUT, `${arm.name}-r${rep}.json`), JSON.stringify(r, null, 1));
      }
      const f = (x) => x ? `${x.fps}fps p99 ${x.p99} low1 ${x.low1}` : "-";
      const idle = r.box.filter((b) => b.who && Number.isFinite(b.who.idle)).map((b) => b.who.idle);
      const g3 = r.box.filter((b) => b.who && Number.isFinite(b.who.gpu3d_other)).map((b) => b.who.gpu3d_other);
      const hog = r.box.flatMap((b) => (b.top || []).filter((t) => !t.ours)).reduce((m, t) => (!m || t.cores > m.cores ? t : m), null);
      const boxs = r.box.length ? `box idle ${idle.length ? Math.min(...idle) : "?"}s gpu3d_other ${g3.length ? Math.max(...g3) : "?"}% top-other ${hog ? `${hog.name} ${hog.cores}` : "-"}` : "box -";
      const sp = r.probe?.still;
      log(`  ${r.error ? "ERROR " + r.error : "ok"} | firstTurn ${r.firstTurn ? `${r.firstTurn.fps}fps jank ${r.firstTurn.jankMs} h100 ${r.firstTurn.h100} max ${r.firstTurn.max}` : "-"} | still ${f(r.still)} | moving ${f(r.moving)} | draws ${r.draws}${sp ? ` (probe calls ${sp.calls?.mean} real ${sp.realDraws?.mean} renderJs ${sp.renderJs?.p50} ms walks ${sp.walks?.mean})` : ""} | tour ${r.tour ? `fps ${r.tour.fps} jank ${r.tour.jankMs} h100 ${r.tour.h100} h250 ${r.tour.h250} max ${r.tour.max} low1 ${r.tour.low1} low01 ${r.tour.low01}` : "-"} | errs ${r.errors.length} | ${boxs}`);
      writeFileSync(join(OUT, "summary.json"), JSON.stringify(all, null, 1));
    }
  }
  log("out", OUT);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main(process.argv.slice(2)).then(() => process.exit(0), (e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
}
