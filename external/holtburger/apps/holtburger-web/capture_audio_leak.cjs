// Audio resource-leak capture (Task #16, 2026-05-13).
//
// The audio chain shipped 2026-05-12 wires:
//   - AudioManager (scene3d/audio/audio_manager.js): Web Audio API
//     wrapper, HRTF PannerNode + GainNode + AudioBufferSourceNode per
//     play() call, unbounded `_bufferCache: Map<did, Promise<AudioBuffer>>`.
//   - SoundTableCache (scene3d/audio/sound_table_cache.js): unbounded
//     `cached: Map<did, SoundTableJs>`.
//   - AmbientRuntime (scene3d/audio/ambient_runtime.js): per-rAF tick
//     that rolls probabilistic ambient sounds + maintains continuous
//     loops keyed by sType.
//   - AnimationHook sound fires (entities.js:1136-1160, sky_dome.js:1249-1271)
//     setTimeout-scheduled per-hook plays.
//   - GameMessageSound (0xF750) handler (index.html:6275+) — server
//     pushed sound on entity GUID.
//
// User concern: audio "triggers a lot" — cumulative buffer/node
// accumulation during long captures. We park the player + sample
// `performance.memory.usedJSHeapSize` + audioManager.playCount +
// audioManager._bufferCache.size + ambientRuntime.tickCount over a
// 120-second sit. A "leak" means MONOTONE growth in heap; V8's JIT +
// rAF allocs make small jitter normal.
//
// Pass criteria:
//   - Growth rate < 1 MB/min → no actionable leak (Path B in plan)
//   - Growth rate 1-5 MB/min → suspicious but not actionable per plan
//   - Growth rate > 5 MB/min → fix per Step 3 Path A
//
// We also track absolute counts (PlayCount, audio buffer cache size,
// SoundTableCache size) that may grow even when heap doesn't — those
// flag a slow leak that V8 GC compensates for.
//
// Boot pattern mirrors capture_academy_envcells.cjs (canonical
// academy-spawn).

const path = require("node:path");
const fs = require("node:fs");

const PLAYWRIGHT_CACHE =
  process.env.PLAYWRIGHT_CACHE ||
  "/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules";

let chromium;
try {
  // eslint-disable-next-line global-require
  ({ chromium } = require("playwright"));
} catch (_) {
  try {
    // eslint-disable-next-line global-require
    ({ chromium } = require(path.join(PLAYWRIGHT_CACHE, "playwright")));
  } catch (e) {
    console.error("FAIL: playwright not found");
    process.exit(2);
  }
}

(async () => {
  const RUN_TAG = process.env.AUDIO_LEAK_RUN_TAG || `aud${Date.now().toString(36)}`;
  const ACCOUNT = process.env.PHASE4_TEST_ACCOUNT || RUN_TAG;
  const PASSWORD = process.env.PHASE4_TEST_PASSWORD || RUN_TAG;
  const CHAR_NAME = process.env.AUDIO_LEAK_CHAR_NAME || `Aud${RUN_TAG.slice(-6)}`;
  const BRIDGE_URL = process.env.PHASE4_BRIDGE_URL || "ws://127.0.0.1:8080/";
  const SERVER_IP = process.env.PHASE4_SERVER_IP || "100.116.47.66";
  const SERVER_PORT = process.env.PHASE4_SERVER_PORT || "9000";
  const PAGE_URL =
    process.env.PHASE4_PAGE_URL ||
    "http://127.0.0.1:8765/apps/holtburger-web/index.html?renderer=3d";
  const SMOKE_TIMEOUT_MS = Number(process.env.PHASE7_SMOKE_TIMEOUT_MS || 60_000);
  const SPAWN_TIMEOUT_MS = Number(process.env.ACAD_SPAWN_TIMEOUT_MS || 60_000);
  const CREATE_TIMEOUT_MS = Number(process.env.ACAD_CREATE_TIMEOUT_MS || 30_000);
  const POST_SPAWN_DRAIN_MS = Number(process.env.ACAD_POST_SPAWN_DRAIN_MS || 6000);
  const GODMODE_CHAT = process.env.ACAD_GODMODE_CHAT || "/godly";
  const ENABLE_GODMODE = process.env.ACAD_ENABLE_GODMODE !== "0";

  // Park duration + sample interval. 120 s total, 10 s sampling cadence.
  const PARK_DURATION_MS = Number(process.env.AUDIO_PARK_DURATION_MS || 120_000);
  const SAMPLE_INTERVAL_MS = Number(process.env.AUDIO_SAMPLE_INTERVAL_MS || 10_000);
  // Pre-sample warmup — let AmbientRuntime fetch Region + prime caches
  // so baseline already includes the steady-state allocations. Without
  // this the t=0 baseline would mistakenly include "cold cache" entries.
  const WARMUP_MS = Number(process.env.AUDIO_WARMUP_MS || 8_000);
  // Stress mode: fire __playWave() N times per sample to exercise the
  // PannerNode/Source path. Off by default; set AUDIO_STRESS_PLAYS=5
  // to fire 5 plays/second for the full 120 s.
  const STRESS_PLAYS_PER_SEC = Number(process.env.AUDIO_STRESS_PLAYS || 0);
  // A Wave DID known to exist in dist/. Default: lifestone-on
  // (0x0a000266) per memory `ambient_sounds_done_2026-05-12`.
  const STRESS_WAVE_DID = Number(process.env.AUDIO_STRESS_WAVE || 0x0a000266);

  const startTs = Date.now();
  const TRAJECTORY_PATH = path.resolve(
    "/mnt/wbterminal1/holtburger-captures",
    `audio-leak-trajectory-${startTs}.json`
  );
  const SCREENSHOT_PATH = path.resolve(
    "/mnt/wbterminal1/holtburger-captures",
    `audio-leak-${startTs}.png`
  );
  const DIAG_LOG_PATH = path.resolve(
    "/mnt/wbterminal1/holtburger-captures",
    `audio-leak-diag-${startTs}.log`
  );
  fs.writeFileSync(DIAG_LOG_PATH, `# audio leak diag ${new Date().toISOString()}\n`);

  console.log(`launching chromium → ${PAGE_URL}`);
  console.log(`account: ${ACCOUNT}, character: ${CHAR_NAME}`);
  console.log(`park: ${PARK_DURATION_MS}ms, sample interval: ${SAMPLE_INTERVAL_MS}ms, warmup: ${WARMUP_MS}ms`);
  console.log(`stress: ${STRESS_PLAYS_PER_SEC} plays/sec, wave did: 0x${STRESS_WAVE_DID.toString(16)}`);
  console.log(`trajectory: ${TRAJECTORY_PATH}`);
  console.log(`screenshot: ${SCREENSHOT_PATH}`);

  // js-flags=--expose-gc lets window.gc() in chromium. Playwright passes
  // it via launch args. With expose-gc we can force GC before each
  // sample so heap deltas reflect actual retained memory rather than
  // accumulated short-lived garbage. If gc() isn't reachable we fall
  // back to noisy samples.
  const browser = await chromium.launch({
    args: [
      "--use-gl=swiftshader",
      "--disable-dev-shm-usage",
      "--no-sandbox",
      "--disable-gpu-sandbox",
      "--disable-features=PaintHoldingCrossOrigin,PaintHolding",
      "--js-flags=--expose-gc",
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1024 },
  });
  const page = await context.newPage();

  let consoleErrors = 0;
  const consoleErrorMessages = [];
  page.on("console", (msg) => {
    const text = msg.text();
    try {
      fs.appendFileSync(DIAG_LOG_PATH, `[${msg.type()}] ${text}\n`);
    } catch (_) {}
    if (msg.type() === "error") {
      consoleErrors += 1;
      if (consoleErrorMessages.length < 10) consoleErrorMessages.push(text);
      console.log(`[browser error] ${text}`);
    } else if (/\[H3\/|task-d|task-F|ambient|audio/i.test(text)) {
      // Surface audio-related logs but don't dump everything.
      if (consoleErrorMessages.length < 50) {
        console.log(`[browser ${msg.type()}] ${text.slice(0, 200)}`);
      }
    }
  });
  page.on("pageerror", (err) => {
    consoleErrors += 1;
    console.error("[pageerror]", err.message);
    if (consoleErrorMessages.length < 10) consoleErrorMessages.push(err.message);
  });

  // === Boot the page and wait for smoke PASS ============================
  try {
    await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => {
        const r = document.getElementById("results");
        return r && /PASS/.test(r.innerHTML);
      },
      { timeout: SMOKE_TIMEOUT_MS }
    );
    console.log("in-page smoke: PASS");
  } catch (e) {
    console.error(`FAIL: smoke timeout: ${e.message || e}`);
    await browser.close();
    process.exit(1);
  }

  // === Login ============================================================
  try {
    await page.fill('input[name="account"]', ACCOUNT);
    await page.fill('input[name="password"]', PASSWORD);
    await page.fill('input[name="bridge_url"]', BRIDGE_URL);
    await page.fill('input[name="server_host"]', SERVER_IP);
    await page.fill('input[name="server_port"]', SERVER_PORT);
    await page.click('#login-form button[type=submit]');
    await page.waitForSelector("#selection:not([hidden])", { timeout: 90_000 });
    console.log(`logged in as ${ACCOUNT}`);
  } catch (e) {
    console.error(`FAIL: login: ${e.message || e}`);
    await browser.close();
    process.exit(1);
  }

  await page.waitForTimeout(500);

  // === Create character if needed =======================================
  const initialCount = await page.locator('#character-ul button[data-id]').count();
  if (initialCount === 0) {
    console.log(`creating character "${CHAR_NAME}"`);
    await page.fill('#create-form input[name="char_name"]', CHAR_NAME);
    await page.click('#create-button');
    await page.waitForFunction(
      () => {
        const s = document.getElementById("create-status");
        return s && /Created\b/.test(s.innerText);
      },
      { timeout: CREATE_TIMEOUT_MS }
    );
    await page.waitForFunction(
      () => document.querySelectorAll('#character-ul button[data-id]').length > 0,
      { timeout: 10_000 }
    );
    console.log("character created");
  }

  // === Spawn ============================================================
  const spawnButtons = page.locator('#character-ul button[data-id]');
  if ((await spawnButtons.count()) === 0) {
    console.error("FAIL: no spawnable characters");
    await browser.close();
    process.exit(1);
  }
  await spawnButtons.first().click();
  await page.waitForFunction(
    () => {
      const s = document.getElementById("login-status");
      return s && /InWorld|Spawned/.test(s.innerText);
    },
    { timeout: SPAWN_TIMEOUT_MS }
  );
  console.log("spawned");

  await page.waitForTimeout(POST_SPAWN_DRAIN_MS);

  // Wait for init3D to finish wiring liveScene3d + audioManager. The
  // 3D scene boots on the kind=7 EnteredWorld event; audio block fires
  // after sky_dome construction. Race-tolerate with a poll.
  console.log("polling for liveScene3d.audioManager to appear (init3D may still be wiring)...");
  let initReady = false;
  const initDeadline = Date.now() + 45_000;
  while (Date.now() < initDeadline) {
    const ready = await page.evaluate(() => {
      const ls = window.liveScene3d;
      return !!(ls && ls.audioManager && ls.soundTableCache && ls.ambientRuntime);
    });
    if (ready) {
      initReady = true;
      break;
    }
    await page.waitForTimeout(500);
  }
  if (!initReady) {
    const state = await page.evaluate(() => {
      const ls = window.liveScene3d;
      return {
        hasLs: !!ls,
        lsKeys: ls ? Object.keys(ls) : null,
        hasAm: !!ls?.audioManager,
        hasStc: !!ls?.soundTableCache,
        hasAr: !!ls?.ambientRuntime,
      };
    });
    console.error(`FAIL: liveScene3d audio wiring never appeared. State: ${JSON.stringify(state)}`);
    await browser.close();
    process.exit(1);
  }
  console.log("liveScene3d audio wiring present.");

  // === /godly ===========================================================
  if (ENABLE_GODMODE && GODMODE_CHAT) {
    const godResult = await page.evaluate((line) => {
      const h = window.__sessionHandle;
      if (h && typeof h.sendChat === "function") {
        try {
          h.sendChat(line);
          return "sent";
        } catch (e) {
          return `err: ${e.message || e}`;
        }
      }
      return "no handle";
    }, GODMODE_CHAT);
    console.log(`/godly: ${godResult}`);
    await page.waitForTimeout(1500);
  }

  // === Trigger user-gesture so AudioContext unlocks =====================
  // The AudioManager is gated on first pointerdown/keydown — without it
  // play() is a no-op so the ambient runtime would just bump skipCount
  // and we wouldn't actually measure node allocations. Synthetic
  // keypress lights up the audio context.
  await page.evaluate(() => {
    // Simulate a keydown on document so the window-level handler in
    // index.js fires notifyUserGesture().
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "F1" }));
    // Also try pointerdown via window in case the keydown listener
    // already got removed.
    window.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "mouse" }));
  });

  // Verify audio context unlocked.
  const audioReady = await page.evaluate(() => {
    const ls = window.liveScene3d;
    const out = {
      liveScene3dPresent: !!ls,
      liveScene3dKeys: ls ? Object.keys(ls).slice(0, 30) : null,
      hasAudioManager: !!ls?.audioManager,
      hasAmbientRuntime: !!ls?.ambientRuntime,
      hasSoundTableCache: !!ls?.soundTableCache,
    };
    if (!ls || !ls.audioManager) {
      out.ready = false;
      out.reason = "no audioManager";
      return out;
    }
    const am = ls.audioManager;
    out.ready = !!am._ctx;
    out.ctxState = am._ctx ? am._ctx.state : "no ctx";
    out.gestureNotified = !!am._userGestureNotified;
    return out;
  });
  console.log(`audio state: ${JSON.stringify(audioReady)}`);

  if (!audioReady.ready) {
    // Try to wait + retry once — init3D timing race.
    console.log("audio not ready first try; waiting 3s for late init...");
    await page.waitForTimeout(3000);
    // Re-dispatch user gesture.
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "F1" }));
      window.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "mouse" }));
    });
    await page.waitForTimeout(1000);
    const audioReady2 = await page.evaluate(() => {
      const ls = window.liveScene3d;
      if (!ls || !ls.audioManager) return { ready: false, reason: "still no audioManager", liveScene3dKeys: ls ? Object.keys(ls).slice(0, 30) : null };
      const am = ls.audioManager;
      return {
        ready: !!am._ctx,
        ctxState: am._ctx ? am._ctx.state : "no ctx",
        gestureNotified: !!am._userGestureNotified,
      };
    });
    console.log(`audio state retry: ${JSON.stringify(audioReady2)}`);
    if (!audioReady2.ready) {
      console.error("FAIL: AudioContext did not initialise after retry");
      await browser.close();
      process.exit(1);
    }
  }

  // === Warmup ===========================================================
  // Let AmbientRuntime fetch Region 0x13000000 + prime SoundTableCache
  // so baseline already includes those allocations. Otherwise t=0
  // would include the cold-cache fetch's network response + decode.
  console.log(`warmup: ${WARMUP_MS}ms (allow Region fetch + cache prime)`);
  await page.waitForTimeout(WARMUP_MS);

  // === gc() probe — check if --expose-gc reached chromium ===============
  const gcAvailable = await page.evaluate(() => {
    try {
      if (typeof window.gc === "function") {
        window.gc();
        return true;
      }
    } catch (_) {}
    return false;
  });
  console.log(`window.gc() reachable: ${gcAvailable}`);

  // === Stress play timer (optional) =====================================
  // Multi-DID rotation — exercise buffer cache growth + decode path.
  // AC Wave DIDs known to exist in dist/. lifestone-on, plus a few
  // generic forge/spell sounds. Bad DIDs are absorbed by fetchWave/
  // decodeAudioData with silent null cache + skipCount++.
  const STRESS_WAVE_DIDS = (process.env.AUDIO_STRESS_WAVES || "0x0a000266,0x0a000272,0x0a000300,0x0a000400,0x0a000500,0x0a000600,0x0a000700,0x0a000800")
    .split(",").map((s) => parseInt(s.trim(), 16) >>> 0).filter((n) => n > 0);
  let stressIntervalHandle = null;
  if (STRESS_PLAYS_PER_SEC > 0) {
    // Use page.evaluate with setInterval inside the page so plays
    // happen in the page's JS context (where audioManager lives).
    await page.evaluate(({ playsPerSec, waveDids }) => {
      let counter = 0;
      window.__audioStressInterval = setInterval(() => {
        try {
          const ls = window.liveScene3d;
          if (!ls || !ls.audioManager) return;
          // Vary position so panner has work to do.
          const t = Date.now() / 1000;
          const pos = {
            x: Math.cos(t) * 5,
            y: Math.sin(t) * 5,
            z: 0,
          };
          // Round-robin across DIDs to exercise buffer cache.
          const did = waveDids[counter % waveDids.length];
          counter += 1;
          ls.audioManager.play(did, pos).catch(() => {});
        } catch (_) {}
      }, 1000 / playsPerSec);
    }, { playsPerSec: STRESS_PLAYS_PER_SEC, waveDids: STRESS_WAVE_DIDS });
    console.log(`stress: firing ${STRESS_PLAYS_PER_SEC} plays/sec across ${STRESS_WAVE_DIDS.length} DIDs for full park`);
  }

  // === Sampling loop ====================================================
  const samples = [];
  const collectSample = async (label) => {
    // Force GC first if available so the heap reading reflects retained
    // (not short-lived) memory. Without gc() the reading is noisier but
    // monotonic growth still detectable over 120 s.
    const sample = await page.evaluate((forceGc) => {
      if (forceGc && typeof window.gc === "function") {
        try {
          window.gc();
          window.gc(); // double-gc — major + minor passes
        } catch (_) {}
      }
      const mem = (performance && performance.memory) ? performance.memory : null;
      const ls = window.liveScene3d;
      const am = ls?.audioManager ?? null;
      const stc = ls?.soundTableCache ?? null;
      const ar = ls?.ambientRuntime ?? null;
      const em = ls?.entityManager ?? null;
      let arStats = null;
      try { arStats = ar ? ar.stats() : null; } catch (_) {}
      let stcStats = null;
      try { stcStats = stc ? stc.stats() : null; } catch (_) {}
      return {
        ts: Date.now(),
        // Heap
        usedHeap: mem ? mem.usedJSHeapSize : -1,
        totalHeap: mem ? mem.totalJSHeapSize : -1,
        heapLimit: mem ? mem.jsHeapSizeLimit : -1,
        // AudioManager direct counters
        playCount: am ? am.playCount : -1,
        skipCount: am ? am.skipCount : -1,
        bufferCacheSize: am && am._bufferCache ? am._bufferCache.size : -1,
        ctxState: am && am._ctx ? am._ctx.state : "noctx",
        // AudioContext destination — Web Audio's PannerNode tree feeds
        // into ctx.destination via the master gain. We can't query
        // "active pannerCount" directly but `ctx.currentTime` + the
        // `destination.numberOfInputs` (always 1 — single master gain)
        // are sanity reads.
        ctxCurrentTime: am && am._ctx ? am._ctx.currentTime : -1,
        destNumInputs: am && am._ctx ? am._ctx.destination.numberOfInputs : -1,
        // SoundTableCache
        stbCached: stcStats ? stcStats.cached : -1,
        stbPending: stcStats ? stcStats.pending : -1,
        stbHits: stcStats ? stcStats.hits : -1,
        stbMisses: stcStats ? stcStats.misses : -1,
        // AmbientRuntime
        arTicks: arStats ? arStats.tickCount : -1,
        arActiveStb: arStats ? (arStats.activeStbId === null ? "null" : "0x" + (arStats.activeStbId >>> 0).toString(16)) : "noruntime",
        arContinuousLoops: arStats ? arStats.continuousLoops.length : -1,
        arProbTimers: arStats ? arStats.timers.length : -1,
        arContinuousStarts: arStats ? arStats.continuousStartCount : -1,
        arProbFires: arStats ? arStats.probabilisticFireCount : -1,
        arSkippedNoRegion: arStats ? arStats.skippedNoRegion : -1,
        arSkippedIndoor: arStats ? arStats.skippedIndoor : -1,
        arTerrainMisses: arStats ? arStats.terrainSampleMisses : -1,
        // EntityManager sanity
        entityCount: em && em.entityMap ? em.entityMap.size : -1,
        // SoundTriggered (Task F) stats if present
        sndTrigStats: window.__soundTriggeredStats || null,
      };
    }, gcAvailable);
    sample.label = label;
    sample.tRelMs = sample.ts - parkStartTs;
    samples.push(sample);
    console.log(
      `[t=${(sample.tRelMs / 1000).toFixed(1)}s] ${label}: ` +
      `heap=${(sample.usedHeap / 1024 / 1024).toFixed(2)}MB / ${(sample.totalHeap / 1024 / 1024).toFixed(2)}MB, ` +
      `playCount=${sample.playCount}, bufCache=${sample.bufferCacheSize}, ` +
      `arTicks=${sample.arTicks}, arContinuous=${sample.arContinuousLoops}, ` +
      `arProbFires=${sample.arProbFires}, stbCached=${sample.stbCached}, ` +
      `entities=${sample.entityCount}`
    );
    return sample;
  };

  // === Park =============================================================
  const parkStartTs = Date.now();
  console.log(`=== parking for ${PARK_DURATION_MS}ms with ${SAMPLE_INTERVAL_MS}ms sampling ===`);
  await collectSample("baseline");

  const parkDeadline = parkStartTs + PARK_DURATION_MS;
  let sampleIdx = 1;
  while (Date.now() < parkDeadline) {
    const nextSample = parkStartTs + sampleIdx * SAMPLE_INTERVAL_MS;
    const waitMs = Math.max(0, nextSample - Date.now());
    if (waitMs > 0) await page.waitForTimeout(waitMs);
    if (Date.now() >= parkDeadline) break;
    await collectSample(`t${sampleIdx}`);
    sampleIdx += 1;
  }
  await collectSample("final");

  // Stop stress timer.
  if (stressIntervalHandle !== null || STRESS_PLAYS_PER_SEC > 0) {
    await page.evaluate(() => {
      if (window.__audioStressInterval) {
        clearInterval(window.__audioStressInterval);
        window.__audioStressInterval = null;
      }
    });
  }

  // === Analysis =========================================================
  const baseline = samples[0];
  const final = samples[samples.length - 1];
  const elapsedSec = (final.ts - baseline.ts) / 1000;
  const heapDeltaMb = (final.usedHeap - baseline.usedHeap) / 1024 / 1024;
  const heapGrowthMbPerMin = (heapDeltaMb / elapsedSec) * 60;
  let minHeap = Infinity;
  let maxHeap = 0;
  for (const s of samples) {
    if (s.usedHeap < minHeap) minHeap = s.usedHeap;
    if (s.usedHeap > maxHeap) maxHeap = s.usedHeap;
  }
  const bufferCacheDelta = final.bufferCacheSize - baseline.bufferCacheSize;
  const playsDelta = final.playCount - baseline.playCount;
  const probFiresDelta = final.arProbFires - baseline.arProbFires;
  const stbCachedDelta = final.stbCached - baseline.stbCached;

  console.log("");
  console.log("=== TRAJECTORY ANALYSIS ===");
  console.log(`elapsed: ${elapsedSec.toFixed(1)}s`);
  console.log(`heap baseline: ${(baseline.usedHeap / 1024 / 1024).toFixed(2)} MB`);
  console.log(`heap final:    ${(final.usedHeap / 1024 / 1024).toFixed(2)} MB`);
  console.log(`heap min/max:  ${(minHeap / 1024 / 1024).toFixed(2)} / ${(maxHeap / 1024 / 1024).toFixed(2)} MB`);
  console.log(`heap delta:    ${heapDeltaMb >= 0 ? "+" : ""}${heapDeltaMb.toFixed(3)} MB over ${elapsedSec.toFixed(1)}s`);
  console.log(`growth rate:   ${heapGrowthMbPerMin >= 0 ? "+" : ""}${heapGrowthMbPerMin.toFixed(3)} MB/min`);
  console.log(`plays in window:       ${playsDelta}`);
  console.log(`prob fires in window:  ${probFiresDelta}`);
  console.log(`bufferCache growth:    ${bufferCacheDelta >= 0 ? "+" : ""}${bufferCacheDelta} entries`);
  console.log(`stbCached growth:      ${stbCachedDelta >= 0 ? "+" : ""}${stbCachedDelta} entries`);
  console.log(`destNumInputs:         ${baseline.destNumInputs} → ${final.destNumInputs}`);
  console.log(`entityCount baseline/final: ${baseline.entityCount} / ${final.entityCount}`);
  console.log(`gc() forced:           ${gcAvailable}`);
  console.log(`stress plays/sec:      ${STRESS_PLAYS_PER_SEC}`);

  // Verdict per plan thresholds.
  let verdict;
  if (heapGrowthMbPerMin > 5.0) {
    verdict = "LEAK_LIKELY (heap growth > 5 MB/min)";
  } else if (heapGrowthMbPerMin > 1.0) {
    verdict = "SUSPICIOUS (heap growth 1-5 MB/min, not actionable per plan)";
  } else {
    verdict = "NO_ACTIONABLE_LEAK (heap growth < 1 MB/min)";
  }
  console.log(`verdict: ${verdict}`);

  // Write trajectory
  fs.writeFileSync(
    TRAJECTORY_PATH,
    JSON.stringify({
      runTag: RUN_TAG,
      account: ACCOUNT,
      stressPlaysPerSec: STRESS_PLAYS_PER_SEC,
      stressWaveDid: STRESS_WAVE_DID,
      parkDurationMs: PARK_DURATION_MS,
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      warmupMs: WARMUP_MS,
      gcAvailable,
      verdict,
      analysis: {
        elapsedSec,
        heapBaselineBytes: baseline.usedHeap,
        heapFinalBytes: final.usedHeap,
        heapMinBytes: minHeap,
        heapMaxBytes: maxHeap,
        heapDeltaMb,
        heapGrowthMbPerMin,
        playsDelta,
        probFiresDelta,
        bufferCacheDelta,
        stbCachedDelta,
      },
      samples,
    }, null, 2)
  );
  console.log(`trajectory written: ${TRAJECTORY_PATH}`);

  await page.screenshot({ path: SCREENSHOT_PATH, fullPage: false });
  console.log(`screenshot: ${SCREENSHOT_PATH}`);

  await browser.close();

  if (consoleErrors > 0) {
    console.log(`note: ${consoleErrors} browser console error(s) during run`);
  }
  console.log(`final verdict: ${verdict}`);
  // Exit 0 regardless — this is a measurement capture, not a pass/fail
  // gate. The trajectory file carries the answer.
  process.exit(0);
})().catch((err) => {
  console.error("capture failed:", err);
  process.exit(1);
});
