// harness/load_test/browser_swarm.mjs
// Phase 1: Multi-browser real GPU holtburger-web capacity test.
// Spawns 1, 2, 3, ... concurrent real Chromium GPU holtburger-web sessions on this host,
// each logging in on its own account (webbot0001..), applying @god / @neversaydie on /
// @attackable off, teleporting OUT of the Training Hall to distinct dry outdoor landblocks,
// and actively running across landblocks while collecting per-client FPS, frame times,
// draw calls, JS heap, WASM memory, Chrome RSS, GPU VRAM, and ACE server metrics.
// Stops safely before host/container OOM or VRAM exhaustion.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  ProcessSampler,
  readHostAndGpu,
  queryAceStats,
  resetAcePerf,
} from "./metrics_collector.mjs";

const PW = process.env.HB_PLAYWRIGHT_CORE || "/workspace/wb/mnt1/ac-refs/webac/node_modules/playwright-core";
const CHROME = process.env.HB_CHROME || "/workspace/wb/ms-playwright/chromium-1254/chrome-linux64/chrome";
const { chromium } = createRequire(import.meta.url)(PW);

const arg = (k, d) => {
  const h = process.argv.find((a) => a.startsWith(`--${k}=`));
  return h ? h.slice(k.length + 3) : d;
};

const MAX_CLIENTS = Number(arg("max", "12"));
const HOLD_SECS = Number(arg("hold", "25"));
const QUALITY = arg("quality", "default"); // default (gpu-probe) | low | mid | high | ultra
const PREFIX = arg("prefix", "webbot");
const VIEWPORT_W = Number(arg("w", "1280"));
const VIEWPORT_H = Number(arg("h", "720"));
const OUT_JSON = arg("out", "/tmp/hb_browser_swarm.json");
const SHARED_BROWSER = process.argv.includes("--shared-browser"); // default: 1 browser process per player (realistic separate client)
const NO_PROVISION = process.argv.includes("--no-provision");
const LOADTEST_BIN = process.env.ACE_LOADTEST_BIN || "/workspace/wb/cargo-target/release/ace-loadtest";

// Verified dry outdoor landblocks across Osteth/Direlands (spaced apart so each browser loads
// distinct terrain/scenery packs and distinct ACE landblock clusters).
const OUTDOOR_SPAWNS = [
  { name: "Holtburg",    cmd: "@tele 42.1N, 33.6E" },
  { name: "Yaraq",       cmd: "@tele 21.5S, 1.8W"  },
  { name: "Shoushi",     cmd: "@tele 33.5S, 72.8E" },
  { name: "Lytelthorpe", cmd: "@tele 1.0N, 51.3E"  },
  { name: "Rithwic",     cmd: "@tele 10.8N, 58.3E" },
  { name: "Samsur",      cmd: "@tele 3.0S, 19.3E"  },
  { name: "Al-Arqas",    cmd: "@tele 31.3S, 13.0E" },
  { name: "Nanto",       cmd: "@tele 52.2S, 82.5E" },
  { name: "Hebian-To",   cmd: "@tele 39.2S, 82.8E" },
  { name: "Sawato",      cmd: "@tele 28.8S, 59.3E" },
  { name: "GlendenWood", cmd: "@tele 29.8N, 27.1E" },
  { name: "Cragstone",   cmd: "@tele 26.0N, 47.0E" },
  { name: "Arwic",       cmd: "@tele 33.5N, 56.8E" },
  { name: "Mayoi",       cmd: "@tele 61.8S, 82.4E" },
  { name: "Tufa",        cmd: "@tele 14.3S, 5.5E"  },
  { name: "Qalaba'r",    cmd: "@tele 74.5S, 19.3E" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pctile = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(2);
};

function makeLoginUrl(account) {
  const q = new URLSearchParams({
    nosw: "1",
    autoLogin: "1",
    account,
    password: account,
    autoSpawn: "first",
    bridge_url: "ws://127.0.0.1:8080/",
    server_host: "127.0.0.1",
    server_port: "9000",
    renderDiag: "on",
    portalSpace: "off",
    atmosphereLut: "bake",
  });
  if (QUALITY !== "default") q.set("quality", QUALITY);
  return `http://127.0.0.1:8765/apps/holtburger-web/index.html?${q}`;
}

async function launchBrowser() {
  return chromium.launch({
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
      `--window-size=${VIEWPORT_W},${VIEWPORT_H}`,
    ],
  });
}

async function spawnClient(idx, sharedBrowser) {
  const account = `${PREFIX}${String(idx).padStart(4, "0")}`;
  const spawnLoc = OUTDOOR_SPAWNS[(idx - 1) % OUTDOOR_SPAWNS.length];
  const tStart = Date.now();
  const browser = sharedBrowser || (await launchBrowser());
  const context = await browser.newContext({ viewport: { width: VIEWPORT_W, height: VIEWPORT_H } });
  const page = await context.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
  });
  page.on("pageerror", (e) => pageErrors.push(String(e?.message || e).slice(0, 200)));

  await page.addInitScript(() => {
    window.__loadPerf = { frames: [], last: null };
    const loop = () => {
      const now = performance.now();
      if (window.__loadPerf.last != null) {
        const dt = now - window.__loadPerf.last;
        // Record all real frames including multi-second stalls (up to 60s)
        if (dt > 0 && dt < 60000) window.__loadPerf.frames.push(dt);
      }
      window.__loadPerf.last = now;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });

  await page.goto(makeLoginUrl(account), { waitUntil: "domcontentloaded", timeout: 90000 });

  // Wait for in-world + liveScene3d + non-null pose
  let inWorld = false;
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const st = await page.evaluate(() => {
      const hist = Array.isArray(window.__bootStateHistory) ? window.__bootStateHistory : [];
      const reached = window.__bootState === "in-world" || hist.some((x) => x && x.state === "in-world");
      const h = window.__sessionHandle;
      let hasPose = false;
      try {
        const p = h?.getLocalPlayerPose?.();
        if (p) { hasPose = true; p.free?.(); }
      } catch {}
      return { reached, hasPose, live: !!window.liveScene3d, state: window.__bootState };
    }).catch(() => ({}));
    if (st.reached && st.hasPose && st.live) {
      inWorld = true;
      break;
    }
    await sleep(500);
  }

  if (!inWorld) {
    return {
      idx, account, spawnLoc, browser: sharedBrowser ? null : browser, context, page,
      inWorld: false, outdoor: false, bootMs: Date.now() - tStart,
      consoleErrors, pageErrors, lbsVisited: new Set(), movedM: 0, lastGlobal: null,
    };
  }

  // Apply godmode, immortal, unattackable, and teleport OUT of Training Hall
  await page.evaluate((teleCmd) => {
    const h = window.__sessionHandle;
    if (!h) return;
    h.sendChat("@god");
    h.sendChat("@neversaydie on");
    h.sendChat("@attackable off");
    setTimeout(() => h.sendChat(teleCmd), 1200);
  }, spawnLoc.cmd);

  // Wait up to 15s for outdoor pose confirmation
  let outdoor = false;
  let initialPose = null;
  const tpDeadline = Date.now() + 15000;
  while (Date.now() < tpDeadline) {
    await sleep(600);
    const p = await page.evaluate(() => {
      try {
        const pose = window.__sessionHandle?.getLocalPlayerPose?.();
        if (!pose) return null;
        const r = { lb: pose.landblockId >>> 0, x: pose.x, y: pose.y, z: pose.z };
        pose.free?.();
        return r;
      } catch { return null; }
    }).catch(() => null);
    if (p && ((p.lb & 0x7FFF) < 0x0100)) {
      outdoor = true;
      initialPose = p;
      break;
    }
  }

  // Start continuous movement (assert cameraSwitcher.keys.w so blur in shared-browser never stalls us)
  try { await page.click("canvas", { timeout: 2000 }); } catch {}
  try {
    await page.evaluate(() => {
      const k = window.liveScene3d?.cameraSwitcher?.keys;
      if (k) k.w = true;
    });
  } catch {}
  try { await page.keyboard.down("w"); } catch {}

  const lbsVisited = new Set();
  let lastGlobal = null;
  if (initialPose) {
    const lbHex = (initialPose.lb >>> 16) & 0xFFFF;
    lbsVisited.add(lbHex);
    lastGlobal = {
      gx: ((lbHex >> 8) & 0xFF) * 192 + initialPose.x,
      gy: (lbHex & 0xFF) * 192 + initialPose.y,
    };
  }

  return {
    idx, account, spawnLoc, browser: sharedBrowser ? null : browser, context, page,
    inWorld: true, outdoor, bootMs: Date.now() - tStart,
    consoleErrors, pageErrors, lbsVisited, movedM: 0, stepMovedM: 0, lastGlobal,
  };
}

async function resetClientPerf(c) {
  c.stepMovedM = 0;
  await c.page.evaluate(() => {
    if (window.__loadPerf) { window.__loadPerf.frames.length = 0; window.__loadPerf.last = null; }
    // Re-assert forward run across all tabs (including unfocused tabs in --shared-browser)
    const k = window.liveScene3d?.cameraSwitcher?.keys;
    if (k) { k.w = true; k.e = false; k.q = false; }
  }).catch(() => {});
}

async function steerClient(c, stepTick) {
  // Ensure forward run stays asserted even after another tab steals focus (window blur clears keys)
  await c.page.evaluate(() => {
    const k = window.liveScene3d?.cameraSwitcher?.keys;
    if (k) k.w = true;
  }).catch(() => {});

  const p = await c.page.evaluate(() => {
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
    c.lbsVisited.add(lbHex);
    const gx = ((lbHex >> 8) & 0xFF) * 192 + p.x;
    const gy = (lbHex & 0xFF) * 192 + p.y;
    if (c.lastGlobal) {
      const dist = Math.hypot(gx - c.lastGlobal.gx, gy - c.lastGlobal.gy);
      if (dist < 400) {
        c.movedM += dist;
        c.stepMovedM += dist;
      }
      if (dist < 4.0) stuck = true;
    }
    c.lastGlobal = { gx, gy };
  }

  // Real turning uses Q/E in holtburger-web (A/D is strafe!). If stuck on a building/slope,
  // perform a larger evasive turn; otherwise gently curve periodically to explore landblocks.
  const turnMs = stuck ? 700 : (stepTick % 5 === 2 ? 220 : 0);
  if (turnMs > 0) {
    // Keep a consistent turn direction per client when stuck so it rotates cleanly out of corners
    // instead of oscillating left/right into the same wall.
    const turnKey = stuck ? (c.idx % 2 === 0 ? "e" : "q") : ((c.idx + stepTick) % 2 === 0 ? "e" : "q");
    await c.page.evaluate((tk) => {
      const k = window.liveScene3d?.cameraSwitcher?.keys;
      if (k) { k[tk] = true; k.w = true; }
    }, turnKey).catch(() => {});
    await sleep(turnMs);
    await c.page.evaluate((tk) => {
      const k = window.liveScene3d?.cameraSwitcher?.keys;
      if (k) { k[tk] = false; k.w = true; }
    }, turnKey).catch(() => {});
  }
}

async function sampleClient(c) {
  return c.page.evaluate(() => {
    const frames = window.__loadPerf?.frames ? [...window.__loadPerf.frames] : [];
    const rInfo = window.liveScene3d?.renderer?.info;
    const em = window.liveScene3d?.entityManager;
    let entities = null;
    let remotePlayers = null;
    if (em?.entityMap instanceof Map) {
      entities = em.entityMap.size;
      let pc = 0;
      for (const guid of em.entityMap.keys()) {
        if ((((guid >>> 0) & 0xF0000000) >>> 0) === 0x50000000) pc++;
      }
      remotePlayers = pc;
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
        pose = { lb: (p.landblockId >>> 16) & 0xFFFF, indoor: ((p.landblockId >>> 0) & 0x7FFF) >= 0x0100, x: +p.x.toFixed(1), y: +p.y.toFixed(1) };
        p.free?.();
      }
    } catch {}
    const dr = window.__diag?.render;
    const q = window.liveScene3d?.quality;
    return {
      frames,
      calls: dr?.calls ?? rInfo?.render?.calls ?? null,
      triangles: dr?.triangles ?? rInfo?.render?.triangles ?? null,
      textures: dr?.textures ?? rInfo?.memory?.textures ?? null,
      geometries: dr?.geometries ?? rInfo?.memory?.geometries ?? null,
      entities,
      remotePlayers,
      heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
      wasmMB,
      qualityPreset: q?.preset ?? null,
      qualitySource: q?.source ?? null,
      bootState: window.__bootState ?? null,
      pose,
    };
  }).catch((e) => ({ evalError: String(e?.message || e), frames: [] }));
}

async function main() {
  console.log(`[browser-swarm] max=${MAX_CLIENTS} hold=${HOLD_SECS}s quality=${QUALITY} viewport=${VIEWPORT_W}x${VIEWPORT_H} sharedBrowser=${SHARED_BROWSER}`);
  if (!NO_PROVISION && fs.existsSync(LOADTEST_BIN)) {
    console.log(`[browser-swarm] pre-provisioning ${MAX_CLIENTS} accounts/characters (${PREFIX}0001..${PREFIX}${String(MAX_CLIENTS).padStart(4, "0")}) via ace-loadtest --provision-only...`);
    execFileSync(
      LOADTEST_BIN,
      [
        "--provision-only",
        "--players", String(MAX_CLIENTS),
        "--ramp-interval-ms", "60",
        "--account-prefix", PREFIX,
      ],
      { stdio: ["ignore", "ignore", "inherit"], timeout: 120000 }
    );
    await sleep(500);
  }
  const sharedBrowser = SHARED_BROWSER ? await launchBrowser() : null;
  const procSampler = new ProcessSampler();
  procSampler.sample();

  const clients = [];
  const results = [];
  let stopReason = "reached_max";

  try {
    for (let n = 1; n <= MAX_CLIENTS; n++) {
      // Pre-launch safety check before opening another GPU Chrome instance
      const preHost = readHostAndGpu();
      if (preHost.vramUsedMB != null && preHost.vramUsedMB > 7600) {
        stopReason = `vram_ceiling (${preHost.vramUsedMB}/${preHost.vramTotalMB} MiB)`;
        console.log(`[browser-swarm] STOPPING before client #${n}: ${stopReason}`);
        break;
      }
      if (preHost.cgroupMemMB != null && preHost.cgroupMaxMB != null && preHost.cgroupMemMB > preHost.cgroupMaxMB - 2200) {
        stopReason = `cgroup_mem_ceiling (${preHost.cgroupMemMB}/${preHost.cgroupMaxMB} MiB)`;
        console.log(`[browser-swarm] STOPPING before client #${n}: ${stopReason}`);
        break;
      }
      if (preHost.hostMemAvailMB != null && preHost.hostMemAvailMB < 650) {
        stopReason = `host_mem_avail_ceiling (${preHost.hostMemAvailMB} MiB avail)`;
        console.log(`[browser-swarm] STOPPING before client #${n}: ${stopReason}`);
        break;
      }

      console.log(`\n=== LAUNCHING REAL HOLTBURGER-WEB CLIENT #${n} (${PREFIX}${String(n).padStart(4, "0")}) ===`);
      let client;
      try {
        client = await spawnClient(n, sharedBrowser);
      } catch (e) {
        stopReason = `launch_error at client #${n}: ${e.message}`;
        console.error(`[browser-swarm] ${stopReason}`);
        break;
      }
      clients.push(client);
      console.log(`  client #${n}: inWorld=${client.inWorld} outdoor=${client.outdoor} bootMs=${client.bootMs} loc=${client.spawnLoc.name} errs=${client.consoleErrors.length + client.pageErrors.length}`);

      if (!client.inWorld) {
        stopReason = `client_boot_failed at #${n}`;
        console.log(`[browser-swarm] client #${n} failed to enter world — recording and stopping.`);
      }

      // Reset perf accumulators across all active clients & ACE, then hold for HOLD_SECS while moving
      await Promise.all(clients.map(resetClientPerf));
      await resetAcePerf();
      procSampler.sample();

      const tHoldStart = Date.now();
      let tick = 0;
      let oomAbort = false;
      while (Date.now() - tHoldStart < HOLD_SECS * 1000) {
        await sleep(3000);
        tick++;
        await Promise.all(clients.map((c) => c.inWorld ? steerClient(c, tick) : Promise.resolve()));
        const hCheck = readHostAndGpu();
        if ((hCheck.cgroupMemMB != null && hCheck.cgroupMaxMB != null && hCheck.cgroupMemMB > hCheck.cgroupMaxMB - 1500) ||
            (hCheck.vramUsedMB != null && hCheck.vramUsedMB > 7900)) {
          stopReason = `safety_guard_triggered_during_hold at N=${n} (cgroup=${hCheck.cgroupMemMB}MB vram=${hCheck.vramUsedMB}MB)`;
          console.log(`[browser-swarm] ${stopReason}`);
          oomAbort = true;
          break;
        }
      }

      const host = readHostAndGpu();
      const procs = procSampler.sample();
      const ace = await queryAceStats();
      const perClient = [];
      for (const c of clients) {
        const s = await sampleClient(c);
        const crashed = !!s.evalError || !c.inWorld;
        const avgDt = s.frames.length ? s.frames.reduce((a, b) => a + b, 0) / s.frames.length : null;
        perClient.push({
          idx: c.idx,
          account: c.account,
          loc: c.spawnLoc.name,
          inWorld: c.inWorld && !crashed,
          crashed,
          outdoor: !crashed && c.outdoor && !(s.pose?.indoor ?? true),
          bootMs: c.bootMs,
          qualityPreset: s.qualityPreset ?? null,
          qualitySource: s.qualitySource ?? null,
          fps: !crashed && avgDt ? +(1000 / avgDt).toFixed(1) : 0,
          ftP50Ms: pctile(s.frames, 50),
          ftP95Ms: pctile(s.frames, 95),
          ftP99Ms: pctile(s.frames, 99),
          ftMaxMs: pctile(s.frames, 100),
          stalls5s: s.frames.filter((d) => d >= 5000).length,
          frameCount: s.frames.length,
          calls: s.calls,
          triangles: s.triangles,
          heapMB: s.heapMB,
          wasmMB: s.wasmMB,
          entities: s.entities,
          movedM: +c.movedM.toFixed(1),
          stepMovedM: +c.stepMovedM.toFixed(1),
          lbsVisited: c.lbsVisited.size,
          pose: s.pose,
          errors: c.consoleErrors.length + c.pageErrors.length,
          evalError: s.evalError || null,
        });
      }

      const aliveClients = perClient.filter((p) => !p.crashed);
      const crashedCount = perClient.length - aliveClients.length;
      const movingCount = aliveClients.filter((p) => p.stepMovedM >= 5.0).length;
      const allFps = perClient.map((p) => p.fps);
      const meanFps = allFps.length ? +(allFps.reduce((a, b) => a + b, 0) / allFps.length).toFixed(1) : 0;
      const minFps = allFps.length ? Math.min(...allFps) : 0;
      const meanP95 = aliveClients.map((p) => p.ftP95Ms).filter((x) => x != null);
      const avgP95Ms = meanP95.length ? +(meanP95.reduce((a, b) => a + b, 0) / meanP95.length).toFixed(1) : null;

      const stepRec = {
        n,
        aliveCount: aliveClients.length,
        crashedCount,
        movingCount,
        resolvedQuality: aliveClients[0]?.qualityPreset ?? null,
        meanFps,
        minFps,
        avgP95Ms,
        outdoorCount: aliveClients.filter((p) => p.outdoor).length,
        totalLbsVisited: perClient.reduce((a, b) => a + b.lbsVisited, 0),
        chromeRssMB: procs.chrome.rssMB,
        chromeCpuPct: procs.chrome.cpuPct,
        chromeProcs: procs.chrome.procs,
        vramUsedMB: host.vramUsedMB,
        gpuUtilPct: host.gpuUtilPct,
        cgroupMemMB: host.cgroupMemMB,
        hostMemAvailMB: host.hostMemAvailMB,
        swapUsedMB: host.swapUsedMB,
        ace,
        procs,
        host,
        perClient,
      };
      results.push(stepRec);

      console.log(
        `  [N=${n}] q=${stepRec.resolvedQuality} alive=${stepRec.aliveCount}/${n} crash=${crashedCount} mov=${movingCount}/${n} ` +
        `meanFPS=${meanFps} minFPS=${minFps} avgP95=${avgP95Ms}ms | outdoor=${stepRec.outdoorCount}/${n} lbsVis=${stepRec.totalLbsVisited} | ` +
        `ChromeRSS=${procs.chrome.rssMB}MB ChromeCPU=${procs.chrome.cpuPct}% | VRAM=${host.vramUsedMB}/${host.vramTotalMB}MB GPU=${host.gpuUtilPct}% | ` +
        `cgroupMem=${host.cgroupMemMB}MB avail=${host.hostMemAvailMB}MB | ACE_LBs=${ace?.activeLandblocks} ACE_tick=${ace?.updateWorldAvgMs}ms`
      );

      if (oomAbort || !client.inWorld || crashedCount > 0 || aliveClients.length === 0 || meanFps < 8.0) {
        if (!client.inWorld) stopReason = `client_boot_failed at #${n}`;
        else if (crashedCount > 0) stopReason = `client_crashed (${crashedCount} crashed at N=${n})`;
        else if (aliveClients.length === 0) stopReason = `all_clients_dead at N=${n}`;
        else if (meanFps < 8.0) stopReason = `fps_below_8 (${meanFps} fps at N=${n})`;
        break;
      }
    }
  } finally {
    console.log(`\n[browser-swarm] closing ${clients.length} browser clients (stopReason=${stopReason})...`);
    for (const c of clients) {
      try { await c.page.keyboard.up("w"); } catch {}
      try { await c.page.evaluate(() => window.__sessionHandle?.disconnect?.()); } catch {}
      try { await c.context.close(); } catch {}
      if (c.browser) { try { await c.browser.close(); } catch {} }
    }
    if (sharedBrowser) { try { await sharedBrowser.close(); } catch {} }
  }

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify({ config: { MAX_CLIENTS, HOLD_SECS, QUALITY, VIEWPORT_W, VIEWPORT_H, SHARED_BROWSER }, stopReason, results }, null, 2));
  console.log(`[browser-swarm] saved results to ${OUT_JSON}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
