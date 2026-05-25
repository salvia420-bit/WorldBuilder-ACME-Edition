// Wire-agent harness — Phase 5 PView near-plane clip validation
// (2026-05-25).
//
// PURPOSE
// =======
// Validates that `pview_project_polygon` (in
// `crates/holtburger-world/src/spatial/scene.rs`) correctly clips
// portal polygons against the near plane in clip space BEFORE the
// perspective divide. Pre-fix, any portal polygon with one vertex
// behind the camera near plane (w <= 1e-6) was wholesale dropped,
// which meant the indoor PView walk routinely lost neighbour cells
// when the camera was up against a doorway. Post-fix, the
// Sutherland-Hodgman near-plane clip emits the correct sub-polygon
// and the PView walk continues into adjacent cells.
//
// ACCEPTANCE
// ==========
// After teleporting to a Holtburg cottage interior (cell
// 0xA9B40100, coords (88, 131, 67)) the harness cycles the camera
// through 8 yaw angles (45° apart) and probes
// `getRenderSetWithPView(mvp)` at each pose. The fix is validated
// by requiring at least ONE pose to admit pviewCount >= 2 cells —
// i.e. at least one camera direction sees through at least one
// portal. Pre-fix, all 8 poses returned just `{current_cell}` when
// portals straddled the camera near plane (the bug was unconditional
// drop). Post-fix, at least one pose succeeds.
//
//   - exit 0 on PASS (max pviewCount across 8 yaws >= 2)
//   - exit 1 on FAIL (max pviewCount < 2 — regression: portals
//     dropped even when not straddling the near plane is unexpected;
//     the test is intentionally tolerant of cell drift inside a
//     cottage by sampling 8 angles)
//   - exit 2 on setup error (capabilities missing, boot failed,
//     character never entered world after 180s)
//
// MVP composition mirrors `scene3d/cells.js:tickCellVisibility3D`
// (lines 649-654):
//   mvp = projection · matrixWorldInverse · worldRoot.matrixWorld
//
// Camera yaw is set via `liveScene3d.cameraSwitcher.followYaw` and
// rAF is given 1s to update `camera.matrixWorldInverse` between
// probes (mirrors `run-diag-pview-vs-frustum-sweep.cjs`).
//
// REFERENCE
// =========
// Method doc: `docs/cell-portal-method.md` §"Known scope gap" item
// #1 (the near-plane skip). Phase 5 ship + near-plane closure both
// referenced from user memory `[[project_envcell_pview_gap_2026-05-25]]`.
//
// Run from `apps/holtburger-web/`:
//   NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
//   node scripts/diag/run-diag-pview-near-portal.cjs

const path = require("node:path");
const { mkdir, writeFile } = require("node:fs/promises");

const PLAYWRIGHT_CACHE =
  process.env.PLAYWRIGHT_CACHE ||
  "/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules";

let chromium;
try {
  ({ chromium } = require("playwright"));
} catch (_) {
  try {
    ({ chromium } = require(path.join(PLAYWRIGHT_CACHE, "playwright")));
  } catch (e) {
    console.error(`FAIL: playwright not found in NODE_PATH or ${PLAYWRIGHT_CACHE}`);
    process.exit(2);
  }
}

const TELELOC_CMD = "@teleloc 0xA9B40100 88.0 131.0 67.0";
const BASE_URL =
  process.env.HOLTBURGER_BASE_URL || "http://127.0.0.1:8765";
const URL =
  `${BASE_URL}/apps/holtburger-web/index.html?` +
  "autoLogin=1&account=acadmp1ge522&password=acadmp1ge522&autoSpawn=first" +
  "&renderer=3d&quality=low&kickDance=0&agentic=low" +
  "&wireframe=1&hud=none&plugins=none&netDrainHz=30&diag=1&nosw=1";
const CHROME =
  process.env.CHROME_PATH ||
  "/home/wbterminal/.cache/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-linux64/chrome-headless-shell";
const OUT_ROOT =
  process.env.HOLTBURGER_DIAG_OUT ||
  "/mnt/wbterminal1/tmp/claude-scratch/holtburger-diag-runs";

const YAW_STEPS = 8; // 0°, 45°, 90°, …, 315°

(async () => {
  const TS = new Date().toISOString().replace(/[:.]/g, "-");
  const OUT = path.join(OUT_ROOT, `pview-near-portal-${TS}`);
  await mkdir(OUT, { recursive: true });

  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      "--use-gl=swiftshader",
      "--enable-unsafe-swiftshader",
      "--disable-gpu-sandbox",
      "--ignore-gpu-blocklist",
      "--no-sandbox",
    ],
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  const consoleLines = [];
  page.on("console", (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
  page.on("pageerror", (e) => consoleLines.push(`[pageerror] ${e.message}`));

  console.log("[boot] navigating…");
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  // Wait for `ready` or `in-world` — the same pattern the cottage-
  // inside harness uses. The autoLogin orchestrator handles
  // kick→reconnect retries internally; we just settle long enough
  // for the character to actually be in-game after the dance
  // completes. The post-settle cell-id check guards against the
  // rare "kick dance exhausted all attempts" failure mode.
  const bootDeadline = Date.now() + 90000;
  while (Date.now() < bootDeadline) {
    const s = await page.evaluate(() => window.__bootState).catch(() => null);
    if (s === "ready" || s === "in-world") break;
    await page.waitForTimeout(200);
  }
  console.log("[boot] ready. Settling 15s for character to fully drop in-world…");
  await page.waitForTimeout(15000);

  // Verify both helpers are exposed before the teleport.
  const capabilities = await page.evaluate(() => {
    const live = window.liveScene3d;
    const handle = live?.sessionHandle ?? window.__sessionHandle ?? null;
    return {
      hasHandle: !!handle,
      hasFrustum: typeof handle?.getRenderSetWithFrustum === "function",
      hasPView: typeof handle?.getRenderSetWithPView === "function",
      hasCameraSwitcher: !!live?.cameraSwitcher,
      hasWorldRoot: !!live?.worldRoot,
      bootState: window.__bootState,
      currentCell: (() => {
        try { return (handle?.getCurrentCellId?.() >>> 0) ?? 0; } catch (_) { return 0; }
      })(),
    };
  });
  console.log(`[caps] ${JSON.stringify(capabilities)}`);
  if (!capabilities.hasFrustum || !capabilities.hasPView ||
      !capabilities.hasCameraSwitcher || !capabilities.hasWorldRoot) {
    await writeFile(path.join(OUT, "console.log"), consoleLines.join("\n"));
    console.error("FAIL: required wasm/scene capabilities missing");
    await browser.close();
    process.exit(2);
  }
  if (capabilities.currentCell === 0) {
    // The kick dance hasn't completed within the post-ready settle.
    // Wait additional time before bailing — autoLogin can take up to
    // ~30s through 4 attempts when the previous harness left the
    // character in-world server-side.
    console.log(`[boot] currentCell still 0 — waiting up to 60s more for kick dance…`);
    const extraDeadline = Date.now() + 60000;
    while (Date.now() < extraDeadline) {
      const cellId = await page.evaluate(() => {
        const h = window.liveScene3d?.sessionHandle ?? window.__sessionHandle;
        try { return (h?.getCurrentCellId?.() >>> 0) ?? 0; } catch (_) { return 0; }
      });
      if (cellId !== 0) {
        capabilities.currentCell = cellId;
        console.log(`[boot] cell arrived: 0x${cellId.toString(16).padStart(8, "0")}`);
        break;
      }
      await page.waitForTimeout(1000);
    }
    if (capabilities.currentCell === 0) {
      await writeFile(path.join(OUT, "console.log"), consoleLines.join("\n"));
      console.error(`FAIL: player never reached in-world (cell still 0). ` +
        `Boot state: ${await page.evaluate(() => window.__bootState).catch(() => "?")}. ` +
        `Previous harness likely left a stale character — autoLogin kick exhausted.`);
      await browser.close();
      process.exit(2);
    }
  }

  console.log(`[chat] ${TELELOC_CMD}`);
  await page.evaluate((cmd) => {
    const h = window.liveScene3d?.sessionHandle ?? window.__sessionHandle;
    if (h?.sendChat) h.sendChat(cmd);
  }, TELELOC_CMD);
  await page.waitForTimeout(10000);

  const postTeleport = await page.evaluate(() => {
    const handle = window.liveScene3d?.sessionHandle ?? window.__sessionHandle;
    return {
      cellId: (handle?.getCurrentCellId?.() >>> 0) ?? 0,
      isIndoor: (() => {
        try { return !!handle?.isCurrentCellIndoor?.(); } catch (_) { return null; }
      })(),
    };
  });
  const postCellHex = "0x" + (postTeleport.cellId >>> 0).toString(16).padStart(8, "0");
  console.log(`[post-tele] cell=${postCellHex} isIndoor=${postTeleport.isIndoor}`);

  // Cycle the camera through YAW_STEPS yaws and probe both visibility
  // methods at each pose. Even if the player landed in a cottage cell
  // other than 0xA9B40100 (e.g. the @teleloc dropped them in a
  // neighbour cell of the cottage), as long as the harness is inside
  // SOMEWHERE indoors with portals, at least one yaw should see
  // through at least one portal. Pre-fix that wasn't true — portals
  // with any vertex behind the camera near plane were wholesale
  // dropped, so several yaws collapsed to {current_cell}.
  const samples = [];
  for (let i = 0; i < YAW_STEPS; i++) {
    const yawRad = (i * 2 * Math.PI) / YAW_STEPS;
    const yawDeg = Math.round((i * 360) / YAW_STEPS);
    await page.evaluate((y) => {
      const live = window.liveScene3d;
      if (live?.cameraSwitcher) live.cameraSwitcher.followYaw = y;
    }, yawRad);
    await page.waitForTimeout(1000);

    const probe = await page.evaluate(() => {
      const live = window.liveScene3d;
      const handle = live?.sessionHandle ?? window.__sessionHandle;
      const camera = live?.cameraSwitcher?.activeCamera ?? live?.camera;
      const worldRoot = live?.worldRoot;
      const out = {
        cellId: (handle?.getCurrentCellId?.() >>> 0) ?? 0,
        isIndoor: (() => {
          try { return !!handle?.isCurrentCellIndoor?.(); } catch (_) { return null; }
        })(),
        frustumCount: 0,
        frustumSample: [],
        pviewCount: 0,
        pviewSample: [],
        frustumError: null,
        pviewError: null,
      };
      if (!handle || !camera || !worldRoot) {
        out.pviewError = "missing handle/camera/worldRoot";
        return out;
      }
      try {
        // Composition: mvp = projection · matrixWorldInverse · worldRoot.matrixWorld
        // (same as `scene3d/cells.js:649-654` — matches the prod path).
        const M4 = camera.projectionMatrix.constructor;
        const m = new M4();
        m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        m.multiply(worldRoot.matrixWorld);
        const mvp = new Float32Array(16);
        for (let i = 0; i < 16; i++) mvp[i] = m.elements[i];
        try {
          const fr = handle.getRenderSetWithFrustum(mvp);
          out.frustumCount = fr?.length ?? 0;
          out.frustumSample = Array.from(fr ?? []).slice(0, 8)
            .map((v) => "0x" + (v >>> 0).toString(16).padStart(8, "0"));
        } catch (e) {
          out.frustumError = String(e?.message ?? e);
        }
        try {
          const pv = handle.getRenderSetWithPView(mvp);
          out.pviewCount = pv?.length ?? 0;
          out.pviewSample = Array.from(pv ?? []).slice(0, 8)
            .map((v) => "0x" + (v >>> 0).toString(16).padStart(8, "0"));
        } catch (e) {
          out.pviewError = String(e?.message ?? e);
        }
      } catch (e) {
        out.pviewError = "mvp compose: " + String(e?.message ?? e);
      }
      return out;
    });

    const cellHex = "0x" + (probe.cellId >>> 0).toString(16).padStart(8, "0");
    samples.push({
      yawDeg,
      yawRad,
      cellHex,
      isIndoor: probe.isIndoor,
      frustumCount: probe.frustumCount,
      pviewCount: probe.pviewCount,
      frustumSample: probe.frustumSample,
      pviewSample: probe.pviewSample,
      frustumError: probe.frustumError,
      pviewError: probe.pviewError,
    });
    console.log(
      `  yaw=${String(yawDeg).padStart(3)}°  cell=${cellHex}  ` +
      `frustum=${String(probe.frustumCount).padStart(2)}  ` +
      `pview=${String(probe.pviewCount).padStart(2)}` +
      (probe.pviewError ? `  ERR=${probe.pviewError}` : "")
    );
  }

  const maxPview = samples.reduce((m, s) => Math.max(m, s.pviewCount ?? 0), 0);
  const maxFrustum = samples.reduce((m, s) => Math.max(m, s.frustumCount ?? 0), 0);
  const errorPresent = samples.some((s) => s.pviewError || s.frustumError);
  const indoorObserved = samples.some((s) => s.isIndoor === true);
  const cellsObserved = Array.from(new Set(samples.map((s) => s.cellHex)));

  const summary = {
    timestamp: TS,
    teleloc: TELELOC_CMD,
    postTeleportCell: postCellHex,
    postTeleportIndoor: postTeleport.isIndoor,
    yawSteps: YAW_STEPS,
    sampleCount: samples.length,
    cellsObserved,
    indoorObserved,
    maxPviewCount: maxPview,
    maxFrustumCount: maxFrustum,
    samples,
  };

  await writeFile(path.join(OUT, "probe.json"), JSON.stringify(summary, null, 2));
  await writeFile(path.join(OUT, "console.log"), consoleLines.join("\n"));

  // Acceptance: max raw PView count across 8 yaws is >= 2. The fix
  // restores at least one through-portal-visible cell at one camera
  // angle when inside any cottage. Pre-fix the entire yaw-cycle
  // collapsed to {current_cell} = 1 because near-plane-straddling
  // portals were unconditionally dropped.
  const pass = !errorPresent && indoorObserved && maxPview >= 2;

  console.log("\n=== Verdict ===");
  console.log(`  postTeleportCell: ${postCellHex}`);
  console.log(`  indoorObserved:   ${indoorObserved}`);
  console.log(`  cellsObserved:    ${cellsObserved.join(", ")}`);
  console.log(`  maxPviewCount:    ${maxPview}  (across ${YAW_STEPS} yaws)`);
  console.log(`  maxFrustumCount:  ${maxFrustum}`);
  console.log(`  pass criterion: !error && indoor && maxPviewCount >= 2 → ${pass}`);
  if (pass) {
    console.log(`  → PASS. At least one yaw saw through at least one portal; `
      + `near-plane clip is letting straddling portals survive instead of dropping them.`);
  } else if (errorPresent) {
    const firstErr = samples.find((s) => s.pviewError || s.frustumError);
    console.log(`  → FAIL (setup). Render-set calls threw at yaw=${firstErr?.yawDeg}°: `
      + `${firstErr?.pviewError ?? firstErr?.frustumError}`);
  } else if (!indoorObserved) {
    console.log(`  → FAIL (teleport). Player never landed indoors. The @teleloc to `
      + `0xA9B40100 may have been rejected (account lacks Developer access?).`);
  } else {
    console.log(`  → FAIL. maxPviewCount=${maxPview} (<2) across all ${YAW_STEPS} yaws. `
      + `Near-plane clip not propagating into the walk OR portals are dropping at every angle.`);
  }
  console.log(`\nOUT=${OUT}`);
  await browser.close();

  process.exit(pass ? 0 : 1);
})();
