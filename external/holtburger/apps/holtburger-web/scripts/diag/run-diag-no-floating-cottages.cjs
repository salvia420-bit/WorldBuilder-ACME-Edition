// Wire-agent harness — verifies no high-altitude EnvCell renders
// from outdoor Holtburg town square.
//
// Background. Phase 6 outdoor-exit filter (`compute_visibility_with_frustum`
// in scene.rs + the parallel snapshot path in lib.rs's
// `getRenderSetWithFrustum`) culls EnvCells lacking an outdoor-exit
// portal (other_cell_id low-16 ≥ 0xFFFE) when the camera is outdoor.
//
// Pre-fix symptom: high-Z attic / roof cells in Holtburg LB 0xA9B4
// (cells 0xA9B40158, 0xA9B40166, 0xA9B4016B, …) at world Y ~193-197
// rendered as "floating dungeons in the sky" because their AABBs
// intersected the camera frustum even though no portal-graph path
// from outdoor LandCell reached them.
//
// Post-fix expectation:
//   - After `@telepoi Holtburg` (outdoor LandCell 0xA9B40019), camera
//     at world Y ~94, the visible cell set MAY include ground-floor
//     cottages (which have 0xFFFF portals).
//   - The visible cell set MUST NOT include cells whose first mesh
//     world position has Y > camera.position.y + 50 (i.e., 50+ metres
//     above the camera) — those are the attic / roof cells the filter
//     should now cull.
//
// Acceptance: visibleHighCount == 0. visibleCount > 0 (we still see
// at least the LandCell area + some ground-floor cottages). Exit 0
// on PASS, 1 on FAIL, 2 on setup error.

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

const BASE_URL =
  process.env.HOLTBURGER_BASE_URL || "http://127.0.0.1:8765";
const URL =
  `${BASE_URL}/apps/holtburger-web/index.html?` +
  "autoLogin=1&account=acadmp1ge522&password=acadmp1ge522&autoSpawn=first" +
  "&renderer=3d&quality=low&agentic=low" +
  "&wireframe=1&hud=none&plugins=none&netDrainHz=30&diag=1&nosw=1";
const CHROME =
  process.env.CHROME_PATH ||
  "/home/wbterminal/.cache/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-linux64/chrome-headless-shell";
const OUT_ROOT =
  process.env.HOLTBURGER_DIAG_OUT ||
  "/mnt/wbterminal1/tmp/claude-scratch/holtburger-diag-runs";

const HIGH_Y_THRESHOLD = 50; // metres above camera before we call it "floating"

(async () => {
  const TS = new Date().toISOString().replace(/[:.]/g, "-");
  const OUT = path.join(OUT_ROOT, `no-floating-cottages-${TS}`);
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
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const s = await page.evaluate(() => window.__bootState).catch(() => null);
    if (s === "ready" || s === "in-world") break;
    await page.waitForTimeout(200);
  }
  console.log("[boot] ready. Settling 8s…");
  await page.waitForTimeout(8000);

  console.log("[chat] @telepoi Holtburg");
  await page.evaluate(() => {
    const h = window.liveScene3d?.sessionHandle ?? window.__sessionHandle;
    if (h?.sendChat) h.sendChat("@telepoi Holtburg");
  });
  await page.waitForTimeout(10000);

  const report = await page.evaluate((highYThreshold) => {
    const hex = (n) => "0x" + ((n >>> 0).toString(16).padStart(8, "0"));
    const live = window.liveScene3d;
    if (!(live?.cellContainers3d instanceof Map)) {
      return { error: "no cellContainers3d" };
    }
    const camera = live.cameraSwitcher?.activeCamera ?? live.camera ?? null;
    const camY = camera?.position?.y ?? 0;

    let visibleCount = 0;
    const visibleHigh = [];
    for (const [cellId, container] of live.cellContainers3d) {
      if (!container.visible) continue;
      visibleCount++;
      container.updateWorldMatrix(true, false);
      // Take a mesh world Y from the first descendant mesh.
      let meshY = null;
      container.traverse((o) => {
        if (meshY !== null) return;
        if (o.isMesh && o.geometry) {
          o.updateWorldMatrix(true, false);
          meshY = o.matrixWorld.elements[13];
        }
      });
      if (meshY === null) continue;
      if (meshY > camY + highYThreshold) {
        visibleHigh.push({
          cellHex: hex(cellId),
          lbHex: "0x" + ((cellId & 0xffff0000) >>> 0).toString(16).padStart(8, "0").slice(0, 4),
          meshY,
          camY,
          delta: meshY - camY,
        });
      }
    }
    visibleHigh.sort((a, b) => b.meshY - a.meshY);

    return {
      camY,
      camPos: camera?.position ? { x: camera.position.x, y: camera.position.y, z: camera.position.z } : null,
      totalCellsLoaded: live.cellContainers3d.size,
      visibleCount,
      visibleHighCount: visibleHigh.length,
      visibleHighSample: visibleHigh.slice(0, 10),
    };
  }, HIGH_Y_THRESHOLD);

  await writeFile(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
  await writeFile(path.join(OUT, "console.log"), consoleLines.join("\n").slice(-100000));

  console.log("\n=== Report ===");
  console.log(`camera at ${JSON.stringify(report.camPos)}`);
  console.log(`cells loaded: ${report.totalCellsLoaded}`);
  console.log(`cells visible: ${report.visibleCount}`);
  console.log(`cells visible AND above (camY + ${HIGH_Y_THRESHOLD}): ${report.visibleHighCount}`);
  if (report.visibleHighCount > 0) {
    console.log(`\nFloating cells (BUG):`);
    for (const h of report.visibleHighSample) {
      console.log(`  ${h.cellHex}  meshY=${h.meshY.toFixed(1)}  (camY=${h.camY.toFixed(1)}, delta=${h.delta.toFixed(1)}m)`);
    }
  }

  const pass = !report.error && report.visibleHighCount === 0 && report.visibleCount > 0;
  console.log(`\n=== Verdict ===\n  pass: ${pass}`);
  if (!pass && report.visibleCount === 0) {
    console.log(`  → FAIL: no cells visible at all. Phase 4/5/6 may have over-culled.`);
  } else if (!pass) {
    console.log(`  → FAIL: ${report.visibleHighCount} cell(s) floating ${HIGH_Y_THRESHOLD}m+ above camera. Phase 6 outdoor-exit filter not working.`);
  } else {
    console.log(`  → PASS: ${report.visibleCount} cells visible, none floating > ${HIGH_Y_THRESHOLD}m above camera.`);
  }

  console.log(`\nOUT=${OUT}`);
  await browser.close();
  if (report?.error) process.exit(2);
  process.exit(pass ? 0 : 1);
})();
