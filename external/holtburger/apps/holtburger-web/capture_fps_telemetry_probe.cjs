#!/usr/bin/env node
// capture_fps_telemetry_probe.cjs (FPS plan validation, 2026-05-18)
//
// FPS telemetry probe — scrapes the diagnostic globals exposed by the
// wave 1–8 perf work and dumps a time series for after-the-fact
// validation. Specifically:
//
//   window.__ricShimLastBudgetMs       — A7 (commit ed3bb34) — the
//     last actual elapsed time the takram rIC shim allowed in a single
//     microtask callback. We expect this to stay BELOW 30 ms in steady
//     state and below 50 ms even under transient load. Spikes above 50
//     trigger the shim's one-time warn.
//
//   scene3d._lightSortFrameCounter     — C6 (commit cb8527f) —
//     monotonic frame counter for `capActiveLightsByDistance`.
//     `Δcounter / Δtime` tells us how often the light sort actually
//     runs. We expect this to advance ~60 / s when scene is rendering
//     and dungeon lights are active.
//
//   scene3d._lightSortLastFrame        — C6 — frame index of last
//     actual sort. `counter - lastFrame` shows the throttle gap; should
//     stay ≤ 4 (the LIGHT_SORT_INTERVAL constant in lighting.js).
//
//   liveScene3d.renderer.info.render.calls + .triangles — render-pass
//     cost baseline, useful for cross-referencing the rIC budget under
//     load.
//
// Boots the page, logs in, spawns into the Academy, parks there for
// PROBE_MINUTES (default 10) while polling every POLL_INTERVAL_S
// (default 5) seconds.
//
// Output: /mnt/wbterminal1/tmp/claude-scratch/fps-followon/telemetry/
//   - timeseries.json
//   - summary.json (avg / p50 / p95 / max per metric)
//
// PASS criteria (default):
//   - ricBudgetMs p95 ≤ 50 (the overrun-warn threshold)
//   - lightSortGap p95 ≤ 4 (LIGHT_SORT_INTERVAL)
//   - no console errors
//
// Run on the real 1070; swiftshader's draw-pass scheduling makes the
// rIC budget less load-bearing on the local laptop.

"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");

// --- Playwright resolve -------------------------------------------------
let chromium;
const PLAYWRIGHT_CANDIDATES = [
  process.env.PLAYWRIGHT_CACHE,
  "/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright",
  "/home/wbterminal/.npm/node_modules/playwright",
  path.join(os.homedir(), "AppData/Roaming/npm/node_modules/playwright"),
  "playwright",
].filter(Boolean);
for (const candidate of PLAYWRIGHT_CANDIDATES) {
  try {
    chromium = require(candidate).chromium;
    break;
  } catch (_e) { /* try next */ }
}
if (!chromium) {
  console.error("FATAL: playwright not found");
  process.exit(2);
}

// --- Config -------------------------------------------------------------
const PROBE_MINUTES = Number(process.env.TELEM_PROBE_MINUTES || 10);
const POLL_INTERVAL_S = Number(process.env.TELEM_POLL_INTERVAL_S || 5);

const RUN_TAG = `telem${Date.now().toString(36)}`;
const ACCOUNT = process.env.PHASE4_TEST_ACCOUNT || RUN_TAG;
const PASSWORD = process.env.PHASE4_TEST_PASSWORD || RUN_TAG;
const CHAR_NAME = process.env.ACAD_CHAR_NAME || `Telem${RUN_TAG.slice(-6)}`;
const BRIDGE_URL = process.env.PHASE4_BRIDGE_URL || "ws://127.0.0.1:8080/";
const SERVER_IP = process.env.PHASE4_SERVER_IP || "100.116.47.66";
const SERVER_PORT = process.env.PHASE4_SERVER_PORT || "9000";
const PAGE_URL_BASE =
  process.env.PAGE_URL_BASE || "http://127.0.0.1:8765/index.html";

const SMOKE_TIMEOUT_MS = Number(process.env.PHASE7_SMOKE_TIMEOUT_MS || 60_000);
const SPAWN_TIMEOUT_MS = Number(process.env.ACAD_SPAWN_TIMEOUT_MS || 60_000);
const CREATE_TIMEOUT_MS = Number(process.env.ACAD_CREATE_TIMEOUT_MS || 30_000);
const POST_SPAWN_DRAIN_MS = Number(process.env.ACAD_POST_SPAWN_DRAIN_MS || 6000);

const VIEWPORT_W = Number(process.env.TELEM_VIEWPORT_W || 1024);
const VIEWPORT_H = Number(process.env.TELEM_VIEWPORT_H || 768);

const OUT_DIR =
  process.env.TELEM_OUT_DIR ||
  "/mnt/wbterminal1/tmp/claude-scratch/fps-followon/telemetry";

fs.mkdirSync(OUT_DIR, { recursive: true });

// --- Main ---------------------------------------------------------------
(async () => {
  const url = `${PAGE_URL_BASE}?renderer=3d`;
  console.log(`\n=== FPS telemetry probe — ${PROBE_MINUTES}min @ ${POLL_INTERVAL_S}s ===`);
  console.log(`URL: ${url}`);
  console.log(`Output: ${OUT_DIR}`);

  const browser = await chromium.launch({
    args: [
      "--use-gl=swiftshader",
      "--disable-dev-shm-usage",
      "--no-sandbox",
      "--disable-gpu-sandbox",
    ],
  });
  const context = await browser.newContext({
    viewport: { width: VIEWPORT_W, height: VIEWPORT_H },
  });
  const page = await context.newPage();

  let consoleErrors = 0;
  const ricOverrunWarns = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (msg.type() === "error") {
      consoleErrors += 1;
      console.log(`  [browser error] ${text.slice(0, 200)}`);
    } else if (/_ric_shim|overrun|lightSort/i.test(text)) {
      ricOverrunWarns.push(text);
      console.log(`  [browser ${msg.type()}] ${text.slice(0, 200)}`);
    }
  });
  page.on("pageerror", (err) => {
    consoleErrors += 1;
    console.error(`  [pageerror] ${err.message}`);
  });

  // --- Boot ---
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => /PASS/.test(document.getElementById("results")?.innerHTML || ""),
    { timeout: SMOKE_TIMEOUT_MS },
  );
  console.log(`  smoke PASS`);

  // --- Login ---
  await page.fill('input[name="account"]', ACCOUNT);
  await page.fill('input[name="password"]', PASSWORD);
  await page.fill('input[name="bridge_url"]', BRIDGE_URL);
  await page.fill('input[name="server_host"]', SERVER_IP);
  await page.fill('input[name="server_port"]', SERVER_PORT);
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector("#selection:not([hidden])", { timeout: 90_000 });
  console.log(`  logged in`);

  // --- Create + spawn ---
  const initialCount = await page.locator('#character-ul button[data-id]').count();
  if (initialCount === 0) {
    await page.fill('#create-form input[name="char_name"]', CHAR_NAME);
    await page.click('#create-button');
    await page.waitForFunction(
      () => /Created\b/.test(
        document.getElementById("create-status")?.innerText || "",
      ),
      { timeout: CREATE_TIMEOUT_MS },
    );
    await page.waitForFunction(
      () => document.querySelectorAll('#character-ul button[data-id]').length > 0,
      { timeout: 10_000 },
    );
    console.log(`  character created`);
  }
  await page.locator('#character-ul button[data-id]').first().click();
  await page.waitForFunction(
    () => /InWorld|Spawned/.test(
      document.getElementById("login-status")?.innerText || "",
    ),
    { timeout: SPAWN_TIMEOUT_MS },
  );
  await page.waitForTimeout(POST_SPAWN_DRAIN_MS);
  console.log(`  spawned`);

  await page.evaluate(() => {
    const h = window.__sessionHandle;
    if (h?.sendChat) {
      try { h.sendChat("/godly"); } catch (_) {}
    }
  });

  // --- Poll loop ---
  const totalSamples = Math.floor((PROBE_MINUTES * 60) / POLL_INTERVAL_S);
  const samples = [];
  console.log(`  starting ${totalSamples}-sample probe`);
  const t0 = Date.now();

  for (let i = 0; i < totalSamples; i++) {
    const sample = await page.evaluate(() => {
      const live = window.liveScene3d;
      const info = live?.renderer?.info;
      const sortFrame = live?._lightSortFrameCounter ?? null;
      const sortLast = live?._lightSortLastFrame ?? null;
      const sortGap =
        Number.isFinite(sortFrame) && Number.isFinite(sortLast)
          ? sortFrame - sortLast
          : null;
      return {
        ts: Date.now(),
        ricBudgetMs: window.__ricShimLastBudgetMs ?? null,
        lightSortFrameCounter: sortFrame,
        lightSortLastFrame: sortLast,
        lightSortGap: sortGap,
        lightSortLastCount: live?._lightSortLastCount ?? null,
        renderCalls: info?.render?.calls ?? 0,
        renderTriangles: info?.render?.triangles ?? 0,
      };
    });
    samples.push(sample);
    const elapsedMin = ((Date.now() - t0) / 60_000).toFixed(1);
    console.log(
      `  [${String(i + 1).padStart(3, "0")}/${totalSamples}] ` +
      `t=${elapsedMin}m  ` +
      `ric=${sample.ricBudgetMs}  ` +
      `sortGap=${sample.lightSortGap}  ` +
      `calls=${sample.renderCalls}  ` +
      `tris=${sample.renderTriangles}  ` +
      `errs=${consoleErrors}`,
    );
    if (i < totalSamples - 1) {
      await page.waitForTimeout(POLL_INTERVAL_S * 1000);
    }
  }

  await browser.close();

  // --- Analysis ---
  const ricMs = samples.map((s) => s.ricBudgetMs).filter(Number.isFinite);
  const sortGap = samples.map((s) => s.lightSortGap).filter(Number.isFinite);
  const calls = samples.map((s) => s.renderCalls).filter(Number.isFinite);

  const ricStats = stats(ricMs);
  const sortGapStats = stats(sortGap);
  const callStats = stats(calls);

  const pass =
    consoleErrors === 0 &&
    (ricStats.p95 == null || ricStats.p95 <= 50) &&
    (sortGapStats.p95 == null || sortGapStats.p95 <= 4);

  const summary = {
    runTag: RUN_TAG,
    probeMinutes: PROBE_MINUTES,
    pollIntervalS: POLL_INTERVAL_S,
    sampleCount: samples.length,
    consoleErrors,
    ricOverrunWarnsObserved: ricOverrunWarns.length,
    metrics: {
      ricBudgetMs: ricStats,
      lightSortGap: sortGapStats,
      renderCalls: callStats,
    },
    pass,
    passThresholds: {
      ricBudgetMs_p95_max: 50,
      lightSortGap_p95_max: 4,
      consoleErrors_max: 0,
    },
    notes: pass
      ? "telemetry within expected bounds for A7 + C6 gates"
      : "see metrics — A7 or C6 gate may be misbehaving",
  };
  fs.writeFileSync(
    path.join(OUT_DIR, "timeseries.json"),
    JSON.stringify(samples, null, 2),
  );
  fs.writeFileSync(
    path.join(OUT_DIR, "summary.json"),
    JSON.stringify(summary, null, 2),
  );
  if (ricOverrunWarns.length) {
    fs.writeFileSync(
      path.join(OUT_DIR, "overrun-warns.txt"),
      ricOverrunWarns.join("\n"),
    );
  }

  console.log("\n=== summary ===");
  console.log(JSON.stringify(summary, null, 2));
  process.exit(pass ? 0 : 1);
})().catch((err) => {
  console.error("FATAL:", err?.stack || err?.message || err);
  process.exit(2);
});

// --- helpers ------------------------------------------------------------
function stats(arr) {
  if (!arr.length) return null;
  const sorted = arr.slice().sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: sorted[0],
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    max: sorted[sorted.length - 1],
    avg: sorted.reduce((a, b) => a + b, 0) / sorted.length,
  };
}
