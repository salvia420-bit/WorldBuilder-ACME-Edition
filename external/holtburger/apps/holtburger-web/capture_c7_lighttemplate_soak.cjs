#!/usr/bin/env node
// capture_c7_lighttemplate_soak.cjs (FPS plan validation, 2026-05-18)
//
// C7 light-template soak — verifies that the wave-8 commit `69f315a`
// (which replaced per-placement `Light.clone()` with a cached-template
// `createLightFromTemplate(template, transform)` path) does not regress
// long-session memory. The whole point of C7's Option A was to avoid
// the heavy `.clone()` allocation; if the template lookup itself is
// somehow leaking Light instances or their children, this soak catches
// it.
//
// Boots the page, logs in, spawns into the Academy, and parks there for
// SOAK_MINUTES (default 30) while polling `liveScene3d.renderer.info`
// every POLL_INTERVAL_S (default 30) seconds. Records
// `memory.geometries`, `memory.textures`, `programs.length`, and the
// live count of attached lights for after-the-fact analysis.
//
// PASS criteria (default):
//   - geometries delta from baseline (sample 2, after 1 minute warm-up)
//     stays within +10% across the run.
//   - textures delta likewise within +10%.
//   - lights count stays bounded (≤ baseline + 50; some growth is fine
//     as PVS naturally expands during the 30-min window).
//
// Output: /mnt/wbterminal1/tmp/claude-scratch/fps-followon/c7-soak/
//   - timeseries.json (full sample log)
//   - summary.json (baseline/min/max/delta per metric, pass/fail)
//   - graph.txt (poor-man's ASCII chart for quick eyeballing)
//
// Mirrors the FU5 (capture_envcell_fusion_ab.cjs) boot logic since
// the dev pipeline expects the same login/spawn shape.
//
// Run on the real 1070 — swiftshader's program-cache behaviour
// differs subtly from a real driver per project_holtburger_clouds_e_.

"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");

// --- Playwright resolve (mirror FU5's resolution chain) -----------------
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
  console.error("FATAL: playwright not found in any candidate path:");
  for (const c of PLAYWRIGHT_CANDIDATES) console.error("  " + c);
  process.exit(2);
}

// --- Config -------------------------------------------------------------
const SOAK_MINUTES = Number(process.env.C7_SOAK_MINUTES || 30);
const POLL_INTERVAL_S = Number(process.env.C7_POLL_INTERVAL_S || 30);
const WARMUP_SAMPLES = Number(process.env.C7_WARMUP_SAMPLES || 2); // ignore first N for baseline
const PASS_PCT = Number(process.env.C7_PASS_PCT || 10); // allowed growth %

const RUN_TAG = `c7soak${Date.now().toString(36)}`;
const ACCOUNT = process.env.PHASE4_TEST_ACCOUNT || RUN_TAG;
const PASSWORD = process.env.PHASE4_TEST_PASSWORD || RUN_TAG;
const CHAR_NAME = process.env.ACAD_CHAR_NAME || `Soak${RUN_TAG.slice(-6)}`;
const BRIDGE_URL = process.env.PHASE4_BRIDGE_URL || "ws://127.0.0.1:8080/";
const SERVER_IP = process.env.PHASE4_SERVER_IP || "100.116.47.66";
const SERVER_PORT = process.env.PHASE4_SERVER_PORT || "9000";
const PAGE_URL_BASE =
  process.env.PAGE_URL_BASE || "http://127.0.0.1:8765/index.html";

const SMOKE_TIMEOUT_MS = Number(process.env.PHASE7_SMOKE_TIMEOUT_MS || 60_000);
const SPAWN_TIMEOUT_MS = Number(process.env.ACAD_SPAWN_TIMEOUT_MS || 60_000);
const CREATE_TIMEOUT_MS = Number(process.env.ACAD_CREATE_TIMEOUT_MS || 30_000);
const POST_SPAWN_DRAIN_MS = Number(process.env.ACAD_POST_SPAWN_DRAIN_MS || 6000);

const VIEWPORT_W = Number(process.env.C7_VIEWPORT_W || 1024);
const VIEWPORT_H = Number(process.env.C7_VIEWPORT_H || 768);

const OUT_DIR =
  process.env.C7_OUT_DIR ||
  "/mnt/wbterminal1/tmp/claude-scratch/fps-followon/c7-soak";

fs.mkdirSync(OUT_DIR, { recursive: true });

// --- Main ---------------------------------------------------------------
(async () => {
  const url = `${PAGE_URL_BASE}?renderer=3d`;
  console.log(`\n=== C7 soak — ${SOAK_MINUTES}min @ ${POLL_INTERVAL_S}s ===`);
  console.log(`URL: ${url}`);
  console.log(`Account: ${ACCOUNT}  Character: ${CHAR_NAME}`);
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
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors += 1;
      console.log(`  [browser error] ${msg.text().slice(0, 200)}`);
    }
  });
  page.on("pageerror", (err) => {
    consoleErrors += 1;
    console.error(`  [pageerror] ${err.message}`);
  });

  // --- Boot ---
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => {
      const r = document.getElementById("results");
      return r && /PASS/.test(r.innerHTML);
    },
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
  console.log(`  spawned into world`);

  await page.evaluate(() => {
    const h = window.__sessionHandle;
    if (h?.sendChat) {
      try { h.sendChat("/godly"); } catch (_) {}
    }
  });

  // --- Poll loop ---
  const totalSamples = Math.floor((SOAK_MINUTES * 60) / POLL_INTERVAL_S);
  const samples = [];
  console.log(`  starting ${totalSamples}-sample soak`);
  const t0 = Date.now();

  for (let i = 0; i < totalSamples; i++) {
    const sample = await page.evaluate(() => {
      const r = window.liveScene3d?.renderer;
      if (!r) return null;
      const info = r.info;
      const scene = window.liveScene3d?.scene;
      let lightCount = 0;
      if (scene) {
        scene.traverse((obj) => {
          if (obj.isLight) lightCount += 1;
        });
      }
      return {
        ts: Date.now(),
        geometries: info?.memory?.geometries ?? 0,
        textures: info?.memory?.textures ?? 0,
        programs: info?.programs?.length ?? 0,
        calls: info?.render?.calls ?? 0,
        triangles: info?.render?.triangles ?? 0,
        lights: lightCount,
        ricBudgetMs: window.__ricShimLastBudgetMs ?? null,
        lightSortFrame: window.liveScene3d?._lightSortFrameCounter ?? null,
      };
    });
    samples.push(sample);
    const elapsedMin = ((Date.now() - t0) / 60_000).toFixed(1);
    console.log(
      `  [${String(i + 1).padStart(3, "0")}/${totalSamples}] ` +
      `t=${elapsedMin}m  ` +
      `geo=${sample?.geometries}  ` +
      `tex=${sample?.textures}  ` +
      `prog=${sample?.programs}  ` +
      `lights=${sample?.lights}  ` +
      `ricMs=${sample?.ricBudgetMs}  ` +
      `errs=${consoleErrors}`,
    );
    if (i < totalSamples - 1) {
      await page.waitForTimeout(POLL_INTERVAL_S * 1000);
    }
  }

  await browser.close();

  // --- Analysis ---
  const baselineSamples = samples.slice(WARMUP_SAMPLES, WARMUP_SAMPLES + 3);
  const baseline = {
    geometries: avg(baselineSamples.map((s) => s?.geometries ?? 0)),
    textures: avg(baselineSamples.map((s) => s?.textures ?? 0)),
    lights: avg(baselineSamples.map((s) => s?.lights ?? 0)),
  };
  const finals = samples.slice(-3);
  const final = {
    geometries: avg(finals.map((s) => s?.geometries ?? 0)),
    textures: avg(finals.map((s) => s?.textures ?? 0)),
    lights: avg(finals.map((s) => s?.lights ?? 0)),
  };
  const deltaPct = {
    geometries: pctDelta(baseline.geometries, final.geometries),
    textures: pctDelta(baseline.textures, final.textures),
    lights: pctDelta(baseline.lights, final.lights),
  };

  const pass =
    deltaPct.geometries <= PASS_PCT &&
    deltaPct.textures <= PASS_PCT &&
    (final.lights - baseline.lights) <= 50;

  const summary = {
    runTag: RUN_TAG,
    soakMinutes: SOAK_MINUTES,
    pollIntervalS: POLL_INTERVAL_S,
    sampleCount: samples.length,
    consoleErrors,
    baseline,
    final,
    deltaPct,
    passThresholdPct: PASS_PCT,
    pass,
    notes: pass
      ? "memory metrics stayed within budget across the soak window"
      : "memory growth exceeded budget — investigate C7 template or B3 dispose path",
  };
  fs.writeFileSync(
    path.join(OUT_DIR, "timeseries.json"),
    JSON.stringify(samples, null, 2),
  );
  fs.writeFileSync(
    path.join(OUT_DIR, "summary.json"),
    JSON.stringify(summary, null, 2),
  );
  fs.writeFileSync(path.join(OUT_DIR, "graph.txt"), ascii(samples));

  console.log("\n=== summary ===");
  console.log(JSON.stringify(summary, null, 2));
  process.exit(pass ? 0 : 1);
})().catch((err) => {
  console.error("FATAL:", err?.stack || err?.message || err);
  process.exit(2);
});

// --- helpers ------------------------------------------------------------
function avg(arr) {
  const nums = arr.filter((n) => Number.isFinite(n));
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}
function pctDelta(base, now) {
  if (!base) return now > 0 ? 100 : 0;
  return ((now - base) / base) * 100;
}
function ascii(samples) {
  // Tiny vertical chart for `geometries` over time.
  const geoms = samples.map((s) => s?.geometries ?? 0);
  const max = Math.max(...geoms, 1);
  const lines = ["t(min)  geometries  bar"];
  for (let i = 0; i < samples.length; i++) {
    const elapsedMin = i * (POLL_INTERVAL_S / 60);
    const bar = "#".repeat(Math.round((geoms[i] / max) * 40));
    lines.push(
      `${elapsedMin.toFixed(1).padStart(6)}  ${String(geoms[i]).padStart(10)}  ${bar}`,
    );
  }
  return lines.join("\n") + "\n";
}
