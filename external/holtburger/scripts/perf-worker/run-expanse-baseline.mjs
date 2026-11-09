// run-expanse-baseline.mjs — Milestone 1 Expanse Traversal Benchmark on GTX 1070
// Runs offscreen muted Chrome on the 1070 GPU via CDP 9333 with clean profile in C:\tmp\hbbench\.
// Captures frame interval percentiles, hitch buckets (h50..h1000), stall probe attribution, and drainage/queue depths.

import { writeFileSync, mkdirSync } from "node:fs";
import { CDP, prepareLaunch, launchChrome, killBench, armKillOnSignal } from "./lib/hb_box.mjs";
import { connectAtLaunch, sizeWindow, waitBootReady, teleportSettle } from "./lib/hb_session.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...args) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args);

const PROFILE = "hbb-m1-baseline";
const TARGET_WINDOW = { w: 1280, h: 720 };
const APP_URL = "http://127.0.0.1:8765/apps/holtburger-web/index.html?autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first&renderer=3d&quality=mid&agentic=low&targetFps=0&nosw=1&camDebug=on";
const OUT_DIR = "/home/wbterminal/.agents/teamwork/teamwork_worker_m1_rep";

mkdirSync(OUT_DIR, { recursive: true });

// Arm signal kill so Ctrl-C cleans up bench Chrome on 1070
const disarmSignal = armKillOnSignal({ kill: killBench });

let browser = null;
let page = null;
let context = null;

try {
  log("Step 1: Preparing launch files in C:\\tmp\\hbbench\\ on 1070 host...");
  await prepareLaunch({ profile: PROFILE, windowOuter: `${TARGET_WINDOW.w},${TARGET_WINDOW.h}`, uncapped: true });

  log("Step 2: Launching offscreen muted Chrome via hidden task...");
  const launched = await launchChrome(CDP, { tries: 40 });
  if (!launched) {
    throw new Error("Failed to connect to Chrome CDP at " + CDP + " after launch");
  }
  log("Chrome CDP answered at " + CDP);

  log("Step 3: Connecting over CDP via Playwright...");
  const conn = await connectAtLaunch(CDP);
  browser = conn.browser;
  context = conn.ctx;
  page = conn.pg;
  page.setDefaultTimeout(60000);

  page.on("console", (msg) => {
    const text = msg.text();
    if (/error|fail|exception|boot|ready|login|gpu|renderer/i.test(text)) {
      log(`[browser-console:${msg.type()}]`, text.slice(0, 200));
    }
  });
  page.on("pageerror", (err) => {
    log("[browser-pageerror]", String(err?.message || err).slice(0, 300));
  });

  log("Step 4: Navigating to app URL...");
  log("URL:", APP_URL);
  await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 45000 });

  log("Step 5: Waiting for boot ready...");
  let bootOk = false;
  const bootDeadline = Date.now() + 150000;
  while (Date.now() < bootDeadline) {
    const st = await page.evaluate(() => ({
      bootState: window.__bootState,
      hasScene: !!window.liveScene3d,
      hasSession: !!window.__sessionHandle,
      history: window.__bootStateHistory || [],
    })).catch(() => null);

    if (st) {
      log(`  boot status: state=${st.bootState} hasScene=${st.hasScene} hasSession=${st.hasSession}`);
      if (st.hasScene && st.hasSession && (st.bootState === "ready" || st.bootState === "in-world" || st.history.some(s => (s.state || s) === "ready"))) {
        bootOk = true;
        break;
      }
    }
    await sleep(2000);
  }
  if (!bootOk) {
    throw new Error("Boot failed to reach ready/in-world state within timeout");
  }
  log("Boot ready achieved.");

  log("Step 6: Sizing window...");
  const sz = await sizeWindow(context, page, TARGET_WINDOW);
  log(`Window size: target=${sz.target} inner=${sz.inner} outer=${sz.outer} dpr=${sz.dpr} ok=${sz.ok}`);

  log("Step 7: Confirming real GPU execution on GTX 1070...");
  const gpu = await page.evaluate(() => {
    const canvas = document.querySelector("canvas") || window.liveScene3d?.renderer?.domElement;
    if (!canvas) return { error: "No canvas found" };
    const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
    if (!gl) return { error: "No WebGL context" };
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return {
      renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      webgl2: typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext,
    };
  });
  log("GPU Hardware Check:", JSON.stringify(gpu));
  if (gpu.error || !gpu.renderer || /swiftshader|llvmpipe|software/i.test(gpu.renderer)) {
    throw new Error(`INTEGRITY VIOLATION: Expected real GTX 1070 GPU but found: ${JSON.stringify(gpu)}`);
  }
  log(`CONFIRMED REAL GPU: ${gpu.renderer} (${gpu.vendor}) WebGL2=${gpu.webgl2}`);

  log("Step 8: Teleporting to Holtburg and settling...");
  const settle = await teleportSettle(page, "0xA9B40001 96 96 80", { landMs: 8000, quietMs: 12000, maxMs: 90000 });
  log(`Settle finished in ${settle.ms}ms: settled=${settle.settled} quiet=${settle.quiet}`);

  // Sleep 5s to allow settle plateau
  await sleep(5000);

  log("Step 9: Arming stall_probe.js and high-resolution frame recorder...");
  const armRes = await page.evaluate(() => {
    // 1. Arm stall probe with 50ms threshold and 512 ring buffer
    const stallArm = window.__stallArm ? window.__stallArm({ thresholdMs: 50, ring: 512 }) : { error: "window.__stallArm missing" };

    // 2. High-resolution rAF frame interval collector
    window.__fr = { buf: [], last: -1, running: true };
    function loop(t) {
      if (!window.__fr.running) return;
      if (window.__fr.last > 0) {
        const dt = t - window.__fr.last;
        if (dt > 0 && dt < 10000) window.__fr.buf.push(dt);
      }
      window.__fr.last = t;
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);

    return { stallArm };
  });
  log("Stall probe arm result:", JSON.stringify(armRes));

  // Capture pre-movement baseline snapshot
  const preSnapshot = await page.evaluate(() => {
    const lru = window.__landblockLru?.getStats ? window.__landblockLru.getStats() : null;
    const fw = window.__frameWork || null;
    const ls = window.liveScene3d;
    const ri = ls?.renderer?.info ? {
      geometries: ls.renderer.info.memory?.geometries,
      textures: ls.renderer.info.memory?.textures,
      calls: ls.renderer.info.render?.calls,
      triangles: ls.renderer.info.render?.triangles,
    } : null;
    return { lru, fw, ri, heapMB: performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null };
  });
  log("Pre-movement snapshot:", JSON.stringify(preSnapshot));

  log("Step 10: Beginning Expanse Traversal Benchmark...");
  const telemetrySamples = [];

  // Helper for telemetry sample
  async function takeSample(phase, legInfo) {
    const s = await page.evaluate((meta) => {
      const h = window.__sessionHandle;
      const p = h?.getLocalPlayerPose ? h.getLocalPlayerPose() : null;
      let pose = null;
      if (p) {
        pose = { x: +p.x.toFixed(1), y: +p.y.toFixed(1), z: +p.z.toFixed(1), lb: (p.landblockId >>> 0).toString(16), heading: +p.heading.toFixed(2) };
        try { p.free(); } catch (_) {}
      }
      const lru = window.__landblockLru?.getStats ? window.__landblockLru.getStats() : null;
      const bakes = window.__diag?.bakes ? {
        terrain: window.__diag.bakes.terrain?.size ?? null,
        statics: window.__diag.bakes.statics?.size ?? null,
        buildings: window.__diag.bakes.buildings?.size ?? null,
        envCells: window.__diag.bakes.envCells?.size ?? null,
      } : null;
      const ls = window.liveScene3d;
      const ri = ls?.renderer?.info ? {
        geometries: ls.renderer.info.memory?.geometries,
        textures: ls.renderer.info.memory?.textures,
        calls: ls.renderer.info.render?.calls,
        triangles: ls.renderer.info.render?.triangles,
      } : null;
      const fw = window.__frameWork ? {
        mode: window.__frameWork.mode,
        budgetMs: window.__frameWork.budgetMs,
      } : null;
      return {
        t: Date.now(),
        meta,
        pose,
        lru,
        bakes,
        ri,
        fw,
        heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
      };
    }, { phase, ...legInfo });
    telemetrySamples.push(s);
    return s;
  }

  // --- TRAVERSAL LEG 1: Continuous Physical Run (60 seconds) ---
  log("--- Traversal Leg 1: Sustained Physical Run (60s forward run across terrain) ---");
  await page.evaluate(() => {
    // Start continuous 'w' keydown
    const fire = (type) => document.dispatchEvent(new KeyboardEvent(type, { key: "w", code: "KeyW", bubbles: true, cancelable: true }));
    window.__walkActive = true;
    fire("keydown");
    window.__walkInterval = setInterval(() => {
      if (window.__walkActive) fire("keydown");
    }, 200);
  });

  const leg1Start = Date.now();
  const leg1End = leg1Start + 60000;
  while (Date.now() < leg1End) {
    await sleep(2500);
    const s = await takeSample("leg1-walk", { elapsedSec: ((Date.now() - leg1Start) / 1000).toFixed(1) });
    log(`[Leg 1 Walk ${s.meta.elapsedSec}s] lb=0x${s.pose?.lb} x=${s.pose?.x} y=${s.pose?.y} | resident=${s.lru?.resident} parked=${s.lru?.parked} liveGeom=${s.lru?.liveGeom} heap=${s.heapMB}MB`);
  }

  // Stop physical walk keydown
  await page.evaluate(() => {
    window.__walkActive = false;
    clearInterval(window.__walkInterval);
    document.dispatchEvent(new KeyboardEvent("keyup", { key: "w", code: "KeyW", bubbles: true, cancelable: true }));
  });
  log("Leg 1 completed.");

  // --- TRAVERSAL LEG 2: Multi-Landblock Horizon Crossings (60 seconds) ---
  // Traverse 5 consecutive landblocks westward across open expanse to deeply stress drainage & LRU park pool
  log("--- Traversal Leg 2: Multi-Landblock Expanse Crossing (5 consecutive landblock hops) ---");
  const hops = [
    { cellId: "0xA8B40001", label: "0xA8B4 (1 LB West)" },
    { cellId: "0xA7B40001", label: "0xA7B4 (2 LB West)" },
    { cellId: "0xA6B40001", label: "0xA6B4 (3 LB West)" },
    { cellId: "0xA5B40001", label: "0xA5B4 (4 LB West)" },
    { cellId: "0xA4B40001", label: "0xA4B4 (5 LB West)" },
  ];

  for (let i = 0; i < hops.length; i++) {
    const hop = hops[i];
    const cmd = `@teleloc ${hop.cellId} 96.0 96.0 150.0`;
    log(`Hop ${i + 1}/${hops.length}: Entering ${hop.label} via '${cmd}'`);
    await page.evaluate((c) => {
      try { window.__sessionHandle?.sendChat?.(c); } catch (_) {}
    }, cmd);

    // Dwell in the landblock for 12 seconds, sampling twice
    await sleep(6000);
    const s1 = await takeSample("leg2-hop", { hopIndex: i + 1, target: hop.label, dwellSec: 6 });
    log(`  [Hop ${i + 1} dwell 6s] lb=0x${s1.pose?.lb} | resident=${s1.lru?.resident} parked=${s1.lru?.parked} evicted=${s1.lru?.evicted} liveGeom=${s1.lru?.liveGeom} heap=${s1.heapMB}MB`);

    await sleep(6000);
    const s2 = await takeSample("leg2-hop", { hopIndex: i + 1, target: hop.label, dwellSec: 12 });
    log(`  [Hop ${i + 1} dwell 12s] lb=0x${s2.pose?.lb} | resident=${s2.lru?.resident} parked=${s2.lru?.parked} evicted=${s2.lru?.evicted} liveGeom=${s2.lru?.liveGeom} heap=${s2.heapMB}MB`);
  }

  log("Step 11: Traversal complete. Collecting full telemetry and stall reports...");

  // Stop frame recorder loop
  await page.evaluate(() => { window.__fr.running = false; });

  // Extract all telemetry
  const results = await page.evaluate(() => {
    const intervals = (window.__fr?.buf || []).slice();
    const stallRep = window.__stallReport ? window.__stallReport() : null;
    const stallSamp = window.__stallSamples ? window.__stallSamples() : [];
    const lru = window.__landblockLru?.getStats ? window.__landblockLru.getStats() : null;
    const fw = window.__frameWork || null;
    const ls = window.liveScene3d;
    const ri = ls?.renderer?.info ? {
      geometries: ls.renderer.info.memory?.geometries,
      textures: ls.renderer.info.memory?.textures,
      calls: ls.renderer.info.render?.calls,
      triangles: ls.renderer.info.render?.triangles,
    } : null;
    return { intervals, stallRep, stallSamp, lru, fw, ri, heapMB: performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null };
  });

  log(`Extracted ${results.intervals.length} raw frame intervals.`);
  log(`Stall report: ${results.stallRep?.long?.count} long frames recorded.`);

  // Calculate detailed frame statistics and hitch buckets
  const ivs = results.intervals.slice().sort((a, b) => a - b);
  const n = ivs.length;
  const sum = ivs.reduce((a, b) => a + b, 0);
  const meanMs = n ? sum / n : 0;
  const pct = (q) => n ? +ivs[Math.min(n - 1, Math.max(0, Math.floor(q * n)))].toFixed(2) : 0;

  const p50 = pct(0.50);
  const p90 = pct(0.90);
  const p95 = pct(0.95);
  const p99 = pct(0.99);
  const max = n ? +ivs[n - 1].toFixed(2) : 0;

  // Hitch counts & cumulative duration
  const h50List = ivs.filter((dt) => dt >= 50);
  const h100List = ivs.filter((dt) => dt >= 100);
  const h250List = ivs.filter((dt) => dt >= 250);
  const h500List = ivs.filter((dt) => dt >= 500);
  const h1000List = ivs.filter((dt) => dt >= 1000);

  const hitchStats = {
    h50: { count: h50List.length, pctOfFrames: +(h50List.length / n * 100).toFixed(2), totalMs: +h50List.reduce((a, b) => a + b, 0).toFixed(1) },
    h100: { count: h100List.length, pctOfFrames: +(h100List.length / n * 100).toFixed(2), totalMs: +h100List.reduce((a, b) => a + b, 0).toFixed(1) },
    h250: { count: h250List.length, pctOfFrames: +(h250List.length / n * 100).toFixed(2), totalMs: +h250List.reduce((a, b) => a + b, 0).toFixed(1) },
    h500: { count: h500List.length, pctOfFrames: +(h500List.length / n * 100).toFixed(2), totalMs: +h500List.reduce((a, b) => a + b, 0).toFixed(1) },
    h1000: { count: h1000List.length, pctOfFrames: +(h1000List.length / n * 100).toFixed(2), totalMs: +h1000List.reduce((a, b) => a + b, 0).toFixed(1) },
  };

  const finalReport = {
    benchmark: "Expanse Traversal Baseline",
    timestamp: new Date().toISOString(),
    hardware: {
      gpu: gpu.renderer,
      vendor: gpu.vendor,
      webgl2: gpu.webgl2,
      host: "young@100.127.215.75 (DESKTOP-4ANUDO2, NVIDIA GTX 1070)",
      profile: PROFILE,
      scratchDirectory: "C:\\tmp\\hbbench",
    },
    traversal: {
      totalWallDurationSec: +((sum) / 1000).toFixed(1),
      frameCount: n,
      legs: [
        "Leg 1: 60s continuous physical run (held 'w') crossing landblock boundaries",
        "Leg 2: 60s overland traversal crossing 5 consecutive landblocks (0xA8B4, 0xA7B4, 0xA6B4, 0xA5B4, 0xA4B4)",
      ],
      samplesTaken: telemetrySamples.length,
    },
    frameTimesMs: {
      mean: +meanMs.toFixed(2),
      p50,
      p90,
      p95,
      p99,
      max,
    },
    hitchBuckets: hitchStats,
    stallProbe: results.stallRep,
    drainageAndLru: {
      final: results.lru,
      preMovement: preSnapshot.lru,
    },
    frameWork: results.fw,
    sceneMemory: results.ri,
    telemetrySamples,
  };

  // Write raw output
  const rawPath = `${OUT_DIR}/baseline_raw.json`;
  writeFileSync(rawPath, JSON.stringify(finalReport, null, 2));
  log(`Saved raw baseline data to ${rawPath}`);

  // Print Summary Table
  log("==================================================================");
  log("               EXPANSE TRAVERSAL BASELINE SUMMARY                 ");
  log("==================================================================");
  log(`Hardware:      ${gpu.renderer}`);
  log(`Total Frames:  ${n} (${finalReport.traversal.totalWallDurationSec}s total duration)`);
  log(`Frame Times:   mean=${meanMs.toFixed(2)}ms | p50=${p50}ms | p90=${p90}ms | p95=${p95}ms | p99=${p99}ms | max=${max}ms`);
  log(`Hitches:       h50=${hitchStats.h50.count} (${hitchStats.h50.totalMs}ms) | h100=${hitchStats.h100.count} (${hitchStats.h100.totalMs}ms) | h250=${hitchStats.h250.count} (${hitchStats.h250.totalMs}ms) | h500=${hitchStats.h500.count} | h1000=${hitchStats.h1000.count}`);
  if (results.stallRep?.long) {
    log(`Stall Split:   insideRender=${results.stallRep.long.insideRenderMs}ms | outsideRender=${results.stallRep.long.outsideRenderMs}ms | total=${results.stallRep.long.totalMs}ms`);
    log(`Ranked Stalls: ${JSON.stringify(results.stallRep.rankedMs)}`);
  }
  if (results.lru) {
    log(`LRU Queues:    resident=${results.lru.resident} | parked=${results.lru.parked} | evicted=${results.lru.evicted} | liveGeom=${results.lru.liveGeom} (cap 8000) | parkPoolBytes=${results.lru.parkPoolBytes}`);
  }
  log("==================================================================");

} catch (err) {
  log("FATAL ERROR DURING BENCHMARK:", err);
  process.exitCode = 1;
} finally {
  log("Step 12: Cleanup and teardown...");
  try {
    if (page) {
      await page.evaluate(() => { try { window.__stallDisarm?.(); } catch (_) {} }).catch(() => {});
      await page.goto("about:blank").catch(() => {});
    }
  } catch (_) {}
  try {
    if (browser) await browser.close().catch(() => {});
  } catch (_) {}
  log("Killing test Chrome on 1070 host via killBench()...");
  killBench();
  disarmSignal();
  log("Teardown complete.");
}
