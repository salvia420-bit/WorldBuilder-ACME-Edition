// harness/load_test/live_observer_bench.mjs
// Phase 2 (Crowd around Holtburg) & Phase 3 (World-wide Dispersed Landblock Loading):
// Launches ONE real GPU holtburger-web Chromium client (teleported out of Training Hall
// to Holtburg courtyard with @god, @neversaydie on, @attackable off), spawns `ace-loadtest`
// stepping through player counts (`--steps 10,25,50,...`), resets ACE perf counters at each
// hold plateau, and collects synchronized metrics across:
//   - Live holtburger-web client (FPS, frame-time p50/p95/p99/max, draw calls, triangles,
//     rendered entities & remote player rigs, JS heap MB, WASM memory MB, console errors)
//   - ace-loadtest swarm (in-world, god, unattackable, outdoor, moving, LB crossings,
//     unique LBs visited, S2C ObjectCreate rate, ACE Ping RTT p50/p95/p99/max, drops/errors)
//   - ACE.Server (`allstats` + `netstats`: UpdateGameWorld Hz & ms, Physics/MT/ST tick ms,
//     active/dormant LBs, creatures, total objects, GC pause %, DB queue, C2S/S2C pkts/retrans)
//   - Process (/proc CPU%, RSS, threads, FDs) for ACE, wsbridge, MariaDB, serve.py, Chrome
//   - Host & GTX 1070 GPU (cgroup RAM, host avail RAM, swap, GPU util%, VRAM used MB)

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  ProcessSampler,
  readHostAndGpu,
  queryAceStats,
  resetAcePerf,
  readAceLogSize,
  scanAceLogWarnings,
} from "./metrics_collector.mjs";

const PW = process.env.HB_PLAYWRIGHT_CORE || "/workspace/wb/mnt1/ac-refs/webac/node_modules/playwright-core";
const CHROME = process.env.HB_CHROME || "/workspace/wb/ms-playwright/chromium-1254/chrome-linux64/chrome";
const { chromium } = createRequire(import.meta.url)(PW);

const arg = (k, d) => {
  const h = process.argv.find((a) => a.startsWith(`--${k}=`));
  return h ? h.slice(k.length + 3) : d;
};

const MODE = arg("mode", "dispersed"); // dispersed | crowd | mixed
const STEPS_STR = arg("steps", "10,25,50,75,100,125");
const HOLD_SECS = Number(arg("hold", "35"));
const RAMP_MS = Number(arg("ramp-ms", "150"));
const SPEED = arg("speed", "12.0");
const CROWD_COUNT = arg("crowd-count", "20");
// Default arena: 0xCC76 (verified flat 0m delta, dry 3x3 neighborhood, 0 buildings) for
// unobstructed full-frustum visible-crowd rendering; override with --center-lb=A9B4 for Holtburg.
const CENTER_LB = arg("center-lb", "CC76").replace(/^0x/i, "").toUpperCase();
const CENTER_X = Number(arg("center-x", "96.0"));
const CENTER_Y = Number(arg("center-y", "96.0"));
const CENTER_Z = Number(arg("center-z", "22.0"));
const CROWD_R_MIN = Number(arg("crowd-radius-min", "8.0"));
const CROWD_R_MAX = Number(arg("crowd-radius-max", "28.0"));
const CAM_DIST = Number(arg("cam-dist", "72.0"));
const CAM_EL = Number(arg("cam-el", "34.0"));
const CAM_AZ = Number(arg("cam-az", "180.0"));
const LOGIN_TIMEOUT_SECS = Number(arg("login-timeout", "60"));
const WARMUP_SECS = Number(arg("warmup-secs", "24"));
const ACCOUNT_PREFIX = arg("prefix", "loadbot");
const OBSERVER_ACCOUNT = arg("observer", "tailnet1");
const QUALITY = arg("quality", "default");
const DIRECT_UDP = process.argv.includes("--direct-udp");
const NO_OBSERVER = process.argv.includes("--no-observer");
const OBSERVER_WALK = !process.argv.includes("--observer-static");
const OUT_JSON = arg("out", `/tmp/hb_loadtest_${MODE}.json`);
const LOADTEST_BIN = process.env.ACE_LOADTEST_BIN || "/workspace/wb/cargo-target/release/ace-loadtest";

const CENTER_LB_NUM = parseInt(CENTER_LB, 16);
const CENTER_CELL_HEX = (((CENTER_LB_NUM << 16) | 0x0024) >>> 0).toString(16).toUpperCase().padStart(8, "0");
const CENTER_GX = ((CENTER_LB_NUM >> 8) & 0xFF) * 192 + CENTER_X;
const CENTER_GY = (CENTER_LB_NUM & 0xFF) * 192 + CENTER_Y;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pctile = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(2);
};

async function bootObserver() {
  const q = new URLSearchParams({
    nosw: "1",
    autoLogin: "1",
    account: OBSERVER_ACCOUNT,
    password: OBSERVER_ACCOUNT,
    autoSpawn: "first",
    bridge_url: "ws://127.0.0.1:8080/",
    server_host: "127.0.0.1",
    server_port: "9000",
    renderDiag: "on",
    camDebug: "on",
    portalSpace: "off",
    atmosphereLut: "bake",
  });
  if (QUALITY !== "default") q.set("quality", QUALITY);
  const url = `http://127.0.0.1:8765/apps/holtburger-web/index.html?${q}`;

  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      "--headless=new",
      "--use-gl=angle",
      "--use-angle=gl-egl",
      "--ignore-gpu-blocklist",
      "--enable-gpu-rasterization",
      "--mute-audio",
      "--window-position=-32000,-32000",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--enable-precise-memory-info",
      "--window-size=1280,720",
    ],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 220)); });
  page.on("pageerror", (e) => pageErrors.push(String(e?.message || e).slice(0, 220)));

  await page.addInitScript(() => {
    window.__obsPerf = { frames: [], last: null };
    const loop = () => {
      const now = performance.now();
      if (window.__obsPerf.last != null) {
        const dt = now - window.__obsPerf.last;
        // Record all real frames including multi-second stalls (up to 60s)
        if (dt > 0 && dt < 60000) window.__obsPerf.frames.push(dt);
      }
      window.__obsPerf.last = now;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });

  console.log(`[observer] booting live holtburger-web (${OBSERVER_ACCOUNT}, quality=${QUALITY}, arena=0x${CENTER_LB})...`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  const deadline = Date.now() + 90000;
  let inWorld = false;
  while (Date.now() < deadline) {
    const st = await page.evaluate(() => {
      const hist = Array.isArray(window.__bootStateHistory) ? window.__bootStateHistory : [];
      const reached = window.__bootState === "in-world" || hist.some((x) => x && x.state === "in-world");
      let hasPose = false;
      try { const p = window.__sessionHandle?.getLocalPlayerPose?.(); if (p) { hasPose = true; p.free?.(); } } catch {}
      return { reached, hasPose, live: !!window.liveScene3d };
    }).catch(() => ({}));
    if (st.reached && st.hasPose && st.live) { inWorld = true; break; }
    await sleep(500);
  }
  if (!inWorld) throw new Error("Observer holtburger-web client failed to reach in-world");

  // Put observer at arena center with godmode + immortal + unattackable
  const teleCmd = `@teleloc 0x${CENTER_CELL_HEX} ${CENTER_X.toFixed(1)} ${CENTER_Y.toFixed(1)} ${CENTER_Z.toFixed(1)}`;
  await page.evaluate((cmd) => {
    const h = window.__sessionHandle;
    h.sendChat("@god");
    h.sendChat("@neversaydie on");
    h.sendChat("@attackable off");
    setTimeout(() => h.sendChat(cmd), 1200);
  }, teleCmd);

  // Wait for cold-boot terrain/statics/shaders to settle so N=0 baseline isn't skewed by cold streaming
  console.log(`[observer] waiting ${WARMUP_SECS}s for cold-boot streaming/shaders to settle...`);
  await sleep(WARMUP_SECS * 1000);
  try { await page.click("canvas", { timeout: 2000 }); } catch {}

  // In Crowd/Mixed mode, park an elevated camera overlooking the entire arena so ~100% of
  // orbiting players sit inside the camera frustum simultaneously (testing real GPU/CPU rendering).
  let camInfo = null;
  if (MODE === "crowd" || MODE === "mixed") {
    camInfo = await page.evaluate(({ gx, gy, gz, dist, az, el }) => {
      if (window.__cam?.orbit) {
        return window.__cam.orbit(gx, gy, gz + 1.0, dist, az, el);
      }
      return null;
    }, { gx: CENTER_GX, gy: CENTER_GY, gz: CENTER_Z, dist: CAM_DIST, az: CAM_AZ, el: CAM_EL }).catch(() => null);
  }

  const initInfo = await page.evaluate(() => {
    const p = window.__sessionHandle?.getLocalPlayerPose?.();
    let pose = null;
    if (p) {
      pose = { lb: "0x" + (((p.landblockId >>> 16) & 0xFFFF).toString(16).toUpperCase()), indoor: ((p.landblockId >>> 0) & 0x7FFF) >= 0x0100, x: +p.x.toFixed(1), y: +p.y.toFixed(1), z: +p.z.toFixed(1) };
      p.free?.();
    }
    const q = window.liveScene3d?.quality;
    return { pose, qualityPreset: q?.preset ?? null, qualitySource: q?.source ?? null };
  }).catch(() => ({}));
  console.log(`[observer] ready quality=${initInfo.qualityPreset}(${initInfo.qualitySource}) pose=${JSON.stringify(initInfo.pose)} camParked=${!!camInfo?.parked} errs=${consoleErrors.length + pageErrors.length}`);

  const lbsVisited = new Set();
  let lastGlobal = null;
  if (initInfo.pose) {
    const lbVal = parseInt(initInfo.pose.lb, 16);
    lbsVisited.add(lbVal);
    lastGlobal = { gx: ((lbVal >> 8) & 0xFF) * 192 + initInfo.pose.x, gy: (lbVal & 0xFF) * 192 + initInfo.pose.y };
  }

  return {
    browser, context, page, consoleErrors, pageErrors,
    qualityPreset: initInfo.qualityPreset ?? null,
    qualitySource: initInfo.qualitySource ?? null,
    camParked: !!camInfo?.parked,
    lbsVisited, movedM: 0, lastGlobal,
  };
}

async function resetObserverPerf(obs) {
  if (!obs) return;
  await obs.page.evaluate(() => {
    if (window.__obsPerf) { window.__obsPerf.frames.length = 0; window.__obsPerf.last = null; }
  }).catch(() => {});
}

async function steerObserver(obs, tick) {
  if (!obs) return;
  await obs.page.evaluate(() => {
    const k = window.liveScene3d?.cameraSwitcher?.keys;
    if (k) k.w = true;
  }).catch(() => {});
  const p = await obs.page.evaluate(() => {
    try {
      const pose = window.__sessionHandle?.getLocalPlayerPose?.();
      if (!pose) return null;
      const r = { lb: pose.landblockId >>> 0, x: pose.x, y: pose.y, z: pose.z };
      pose.free?.();
      return r;
    } catch { return null; }
  }).catch(() => null);

  let stuck = false;
  if (p) {
    const lbHex = (p.lb >>> 16) & 0xFFFF;
    obs.lbsVisited.add(lbHex);
    const gx = ((lbHex >> 8) & 0xFF) * 192 + p.x;
    const gy = (lbHex & 0xFF) * 192 + p.y;
    if (obs.lastGlobal) {
      const dist = Math.hypot(gx - obs.lastGlobal.gx, gy - obs.lastGlobal.gy);
      if (dist < 400) obs.movedM += dist;
      if (dist < 4.0) stuck = true;
    }
    obs.lastGlobal = { gx, gy };
  }

  // Real turning uses Q/E in holtburger-web (A/D is strafe!). If stuck, turn strongly; else gentle curve.
  const turnMs = stuck ? 700 : (tick % 5 === 2 ? 220 : 0);
  if (turnMs > 0) {
    // Keep a consistent turn direction when stuck so the observer rotates cleanly out of corners
    // instead of oscillating left/right into the same wall.
    const turnKey = stuck ? "e" : (tick % 2 === 0 ? "e" : "q");
    await obs.page.evaluate((tk) => {
      const k = window.liveScene3d?.cameraSwitcher?.keys;
      if (k) { k[tk] = true; k.w = true; }
    }, turnKey).catch(() => {});
    await sleep(turnMs);
    await obs.page.evaluate((tk) => {
      const k = window.liveScene3d?.cameraSwitcher?.keys;
      if (k) { k[tk] = false; k.w = true; }
    }, turnKey).catch(() => {});
  }
}

async function sampleObserver(obs) {
  if (!obs) return null;
  const s = await obs.page.evaluate(() => {
    const frames = window.__obsPerf?.frames ? [...window.__obsPerf.frames] : [];
    const rInfo = window.liveScene3d?.renderer?.info;
    const em = window.liveScene3d?.entityManager;
    let entities = null;
    let remotePlayers = null;
    let visiblePlayers = null;
    if (em?.entityMap instanceof Map) {
      entities = em.entityMap.size;
      let pc = 0, vpc = 0;
      for (const [guid, inst] of em.entityMap.entries()) {
        if ((((guid >>> 0) & 0xF0000000) >>> 0) === 0x50000000) {
          pc++;
          if (inst?.root?.visible !== false) vpc++;
        }
      }
      remotePlayers = pc;
      visiblePlayers = vpc;
    }
    let wasmMB = null;
    try {
      const mem = window.__hbWasmMemory ?? window.__hbSharedWasm?.memory ?? null;
      if (mem?.buffer?.byteLength) wasmMB = +(mem.buffer.byteLength / 1048576).toFixed(1);
    } catch {}
    let pose = null;
    try {
      const p = window.__sessionHandle?.getLocalPlayerPose?.();
      if (p) {
        pose = { lb: "0x" + (((p.landblockId >>> 16) & 0xFFFF).toString(16).toUpperCase()), indoor: ((p.landblockId >>> 0) & 0x7FFF) >= 0x0100, x: +p.x.toFixed(1), y: +p.y.toFixed(1) };
        p.free?.();
      }
    } catch {}
    const dr = window.__diag?.render;
    const q = window.liveScene3d?.quality;
    return {
      frames,
      calls: dr?.calls ?? rInfo?.render?.calls ?? null,
      triangles: dr?.triangles ?? rInfo?.render?.triangles ?? null,
      batchedCalls: dr?.batchedCalls ?? null,
      subDraws: dr?.subDraws ?? null,
      issuedSubDraws: dr?.issuedSubDraws ?? null,
      textures: dr?.textures ?? rInfo?.memory?.textures ?? null,
      geometries: dr?.geometries ?? rInfo?.memory?.geometries ?? null,
      sceneNodes: dr?.sceneNodes ?? null,
      entities,
      remotePlayers,
      visiblePlayers,
      heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
      wasmMB,
      qualityPreset: q?.preset ?? null,
      qualitySource: q?.source ?? null,
      bootState: window.__bootState ?? null,
      pose,
    };
  }).catch((e) => ({ evalError: String(e?.message || e), frames: [] }));

  const dts = s.frames || [];
  const avgDt = dts.length ? dts.reduce((a, b) => a + b, 0) / dts.length : null;
  return {
    fps: avgDt ? +(1000 / avgDt).toFixed(1) : 0,
    ftP50Ms: pctile(dts, 50),
    ftP95Ms: pctile(dts, 95),
    ftP99Ms: pctile(dts, 99),
    ftMaxMs: pctile(dts, 100),
    spikes33ms: dts.filter((d) => d > 33.3).length,
    spikes100ms: dts.filter((d) => d > 100).length,
    stalls5s: dts.filter((d) => d >= 5000).length,
    frameCount: dts.length,
    calls: s.calls,
    triangles: s.triangles,
    batchedCalls: s.batchedCalls,
    subDraws: s.subDraws,
    issuedSubDraws: s.issuedSubDraws,
    textures: s.textures,
    geometries: s.geometries,
    entities: s.entities,
    remotePlayers: s.remotePlayers,
    visiblePlayers: s.visiblePlayers,
    heapMB: s.heapMB,
    wasmMB: s.wasmMB,
    qualityPreset: s.qualityPreset ?? obs.qualityPreset,
    qualitySource: s.qualitySource ?? obs.qualitySource,
    camParked: obs.camParked,
    movedM: +obs.movedM.toFixed(1),
    lbsVisited: obs.lbsVisited.size,
    bootState: s.bootState,
    pose: s.pose,
    consoleErrors: obs.consoleErrors.length,
    pageErrors: obs.pageErrors.length,
    evalError: s.evalError || null,
  };
}

function readLastJsonLine(filePath) {
  try {
    const lines = fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/).filter(Boolean);
    if (!lines.length) return null;
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
}

async function main() {
  const steps = STEPS_STR.split(",").map((x) => Number(x.trim())).filter((n) => n > 0);
  const tag = `${MODE}_${Date.now()}`;
  const jsonLog = `/tmp/ace_loadtest_${tag}.jsonl`;
  const phaseFile = `/tmp/ace_loadtest_${tag}.phase`;
  try { fs.unlinkSync(phaseFile); } catch {}
  try { fs.unlinkSync(jsonLog); } catch {}

  const procSampler = new ProcessSampler();
  procSampler.sample();

  let obs = null;
  if (!NO_OBSERVER) {
    obs = await bootObserver();
  }

  // Baseline measurement (0 swarm bots, observer only)
  let aceLogCursor = readAceLogSize();
  await resetObserverPerf(obs);
  await resetAcePerf();
  procSampler.sample();
  await sleep(10000);
  const baseWarns = scanAceLogWarnings(aceLogCursor);
  aceLogCursor = baseWarns.endOffset;
  const baseline = {
    step: 0,
    observer: await sampleObserver(obs),
    ace: await queryAceStats(),
    aceLogWarnings: baseWarns.counts,
    procs: procSampler.sample(),
    host: readHostAndGpu(),
    swarm: null,
  };
  console.log(
    `[BASELINE N=0] q=${baseline.observer?.qualityPreset ?? "-"} obsFPS=${baseline.observer?.fps ?? "-"} p95=${baseline.observer?.ftP95Ms ?? "-"}ms ` +
    `calls=${baseline.observer?.calls ?? "-"} tris=${baseline.observer?.triangles ?? "-"} ents=${baseline.observer?.entities ?? "-"} rPl=${baseline.observer?.remotePlayers ?? "-"} vPl=${baseline.observer?.visiblePlayers ?? "-"} | ` +
    `ACE LBs=${baseline.ace?.activeLandblocks} tick=${baseline.ace?.updateWorldAvgMs}ms (${baseline.ace?.updateWorldHzWall ?? baseline.ace?.updateWorldHz}Hz) CPU=${baseline.procs.ace.cpuPct}%`
  );

  // Launch ace-loadtest
  const binArgs = [
    "--mode", MODE,
    "--steps", steps.join(","),
    "--hold-secs", String(HOLD_SECS),
    "--ramp-interval-ms", String(RAMP_MS),
    "--speed", String(SPEED),
    "--crowd-count", String(CROWD_COUNT),
    "--center-lb", CENTER_LB,
    "--center-x", String(CENTER_X),
    "--center-y", String(CENTER_Y),
    "--crowd-radius-min", String(CROWD_R_MIN),
    "--crowd-radius-max", String(CROWD_R_MAX),
    "--login-timeout-secs", String(LOGIN_TIMEOUT_SECS),
    "--account-prefix", ACCOUNT_PREFIX,
    "--json-log", jsonLog,
    "--phase-file", phaseFile,
  ];
  if (DIRECT_UDP) binArgs.push("--direct-udp");
  console.log(`[bench] spawning ${LOADTEST_BIN} ${binArgs.join(" ")}`);

  const child = spawn(LOADTEST_BIN, binArgs, { stdio: ["ignore", "pipe", "pipe"] });
  let stdoutBuf = "";
  child.stdout.on("data", (d) => { stdoutBuf += d.toString("utf8"); });
  child.stderr.on("data", (d) => { process.stderr.write(d); });

  let childExited = false;
  let childCode = null;
  child.on("exit", (code) => { childExited = true; childCode = code; });

  const stepResults = [baseline];
  const recordedSteps = new Set();

  // In dispersed mode, actively walk & explore landblocks (using Q/E turn + stuck recovery);
  // in crowd mode, keep the elevated debug camera parked overlooking the entire arena.
  let observerMoving = false;
  if (obs && OBSERVER_WALK && MODE === "dispersed") {
    try {
      await obs.page.evaluate(() => {
        const k = window.liveScene3d?.cameraSwitcher?.keys;
        if (k) k.w = true;
      });
      await obs.page.keyboard.down("w");
      observerMoving = true;
    } catch {}
  }

  try {
    let lastPhase = "";
    let holdStartedAt = 0;
    let holdStep = 0;
    let sampledThisHold = false;
    let steerTick = 0;

    while (!childExited) {
      await sleep(500);
      let phase = "";
      try { phase = fs.readFileSync(phaseFile, "utf8").trim(); } catch {}

      if (phase && phase !== lastPhase) {
        lastPhase = phase;
        if (phase.startsWith("hold:")) {
          holdStep = Number(phase.split(":")[1]);
          holdStartedAt = Date.now();
          sampledThisHold = false;
          // Reset observer & ACE perf at the start of the steady-state plateau!
          await resetObserverPerf(obs);
          await resetAcePerf();
          procSampler.sample();
          console.log(`[bench] entered steady-state HOLD for step=${holdStep}; perf counters reset.`);
        }
      }

      // Actively steer observer across landblocks in dispersed mode (every 3s)
      if (obs && observerMoving && lastPhase.startsWith("hold:")) {
        steerTick++;
        if (steerTick % 6 === 0) {
          await steerObserver(obs, steerTick / 6);
        }
      }

      // Sample ~3 seconds before hold ends so we capture the full steady-state plateau
      if (holdStep > 0 && !sampledThisHold && !recordedSteps.has(holdStep) &&
          Date.now() - holdStartedAt >= Math.max(5000, (HOLD_SECS - 4) * 1000)) {
        sampledThisHold = true;
        recordedSteps.add(holdStep);

        const obsSnap = await sampleObserver(obs);
        const aceSnap = await queryAceStats();
        const procsSnap = procSampler.sample();
        const hostSnap = readHostAndGpu();
        const swarmSnap = readLastJsonLine(jsonLog);
        const stepWarns = scanAceLogWarnings(aceLogCursor);
        aceLogCursor = stepWarns.endOffset;

        const rec = {
          step: holdStep,
          observer: obsSnap,
          ace: aceSnap,
          aceLogWarnings: stepWarns.counts,
          procs: procsSnap,
          host: hostSnap,
          swarm: swarmSnap,
        };
        stepResults.push(rec);

        console.log(
          `\n>>> [STEP N=${holdStep}] ` +
          `swarm(inw=${swarmSnap?.in_world} god=${swarmSnap?.god_ok} imm=${swarmSnap?.immortal_ok} unatt=${swarmSnap?.unattackable_ok} out=${swarmSnap?.outdoor_ok} mov=${swarmSnap?.moving} lbsVis=${swarmSnap?.unique_lbs_visited} cross=${swarmSnap?.total_lb_crossings} recon=${swarmSnap?.total_reconciliations} rttP50=${swarmSnap?.ping_p50_ms}ms rttP95=${swarmSnap?.ping_p95_ms}ms fail=${swarmSnap?.login_failures} disc=${swarmSnap?.disconnects} full=${swarmSnap?.rejected_full} death=${swarmSnap?.deaths}) | ` +
          `ACE(online=${aceSnap?.playersOnline} actLBs=${aceSnap?.activeLandblocks} grps=${aceSnap?.landblockGroups} creat=${aceSnap?.worldCreatures} objs=${aceSnap?.worldTotalObjects} tickAvg=${aceSnap?.updateWorldAvgMs}ms tickLong=${aceSnap?.updateWorldLongMs}ms hz=${aceSnap?.updateWorldHzWall ?? aceSnap?.updateWorldHz} ST=${aceSnap?.tickStAvgMs}ms[pl=${aceSnap?.playerTickAvgMs} hb=${aceSnap?.worldObjHeartbeatAvgMs}] gcPause=${aceSnap?.gcPausePct}% dbQ=${aceSnap?.dbQueueCount} cpu=${procsSnap.ace.cpuPct}% rss=${procsSnap.ace.rssMB}MB warns=${JSON.stringify(stepWarns.counts)}) | ` +
          `wsb(cpu=${procsSnap.wsbridge.cpuPct}% rss=${procsSnap.wsbridge.rssMB}MB fds=${procsSnap.wsbridge.fds}) | ` +
          `obs(fps=${obsSnap?.fps ?? "-"} p95=${obsSnap?.ftP95Ms ?? "-"}ms calls=${obsSnap?.calls ?? "-"} tris=${obsSnap?.triangles ?? "-"} ents=${obsSnap?.entities ?? "-"} rPl=${obsSnap?.remotePlayers ?? "-"} vPl=${obsSnap?.visiblePlayers ?? "-"} mov=${obsSnap?.movedM ?? "-"}m lbs=${obsSnap?.lbsVisited ?? "-"} heap=${obsSnap?.heapMB ?? "-"}MB wasm=${obsSnap?.wasmMB ?? "-"}MB) | ` +
          `host(cgroup=${hostSnap.cgroupMemMB}MB avail=${hostSnap.hostMemAvailMB}MB swap=${hostSnap.swapUsedMB}MB vram=${hostSnap.vramUsedMB}MB gpu=${hostSnap.gpuUtilPct}%)\n`
        );
      }

      // Emergency OOM safety guard
      const hCheck = readHostAndGpu();
      if (hCheck.cgroupMemMB != null && hCheck.cgroupMaxMB != null && hCheck.cgroupMemMB > hCheck.cgroupMaxMB - 1200) {
        console.error(`[bench] EMERGENCY CGROUP MEMORY GUARD (${hCheck.cgroupMemMB}/${hCheck.cgroupMaxMB}MB) — sending SIGINT to ace-loadtest!`);
        child.kill("SIGINT");
        break;
      }
    }
  } finally {
    if (obs) {
      if (observerMoving) {
        try {
          await obs.page.evaluate(() => {
            const k = window.liveScene3d?.cameraSwitcher?.keys;
            if (k) { k.w = false; k.e = false; k.q = false; }
          });
          await obs.page.keyboard.up("w");
        } catch {}
      }
      try { await obs.page.evaluate(() => window.__sessionHandle?.disconnect?.()); } catch {}
      try { await obs.context.close(); } catch {}
      try { await obs.browser.close(); } catch {}
    }
    if (!childExited) {
      child.kill("SIGINT");
      await sleep(3000);
    }
    try { fs.unlinkSync(phaseFile); } catch {}
  }

  let swarmFinalSummary = null;
  try { swarmFinalSummary = JSON.parse(stdoutBuf); } catch {}

  const report = {
    config: {
      MODE, steps, HOLD_SECS, RAMP_MS, SPEED, CROWD_COUNT,
      CENTER_LB, CENTER_X, CENTER_Y, CENTER_Z, CROWD_R_MIN, CROWD_R_MAX,
      CAM_DIST, CAM_EL, CAM_AZ, LOGIN_TIMEOUT_SECS, WARMUP_SECS,
      ACCOUNT_PREFIX, DIRECT_UDP, NO_OBSERVER, QUALITY,
    },
    childExitCode: childCode,
    stepResults,
    swarmFinalSummary,
    jsonlPath: jsonLog,
  };
  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));
  console.log(`[bench] wrote complete report to ${OUT_JSON}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
