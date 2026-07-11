// Wire-agent harness — Holtburg cottage PVS, OUTSIDE variant.
//
// Validates that the Phase 4 PView port (2026-05-25) makes EnvCells
// visible from outdoor LandCells via frustum culling on EnvCell
// AABBs. Boots holtburger-web, @telepoi Holtburg, walks the player
// around outside the cottages, then snapshots the runtime visible
// set.
//
// Acceptance criterion (post Phase 4):
//   At least one EnvCell (cell idx >= 0x0100) must be observable in
//   `cellContainers3d.visible` after teleport + walk. The exact set
//   depends on camera direction. The previous expectation (full
//   17-cell PVS match against the 0xA9B40100 oracle) was wrong —
//   from outdoors looking around, only the cottages in the frustum
//   should be visible, NOT necessarily the same 17 the oracle lists
//   for cell 0xA9B40100's interior PVS.
//
// Pre-Phase-4: zero EnvCells were ever flagged visible from outdoor
// LandCells (no portal-graph edges from LandCell to EnvCell). The
// new outdoor branch in `compute_visibility_with_frustum` iterates
// every loaded EnvCell AABB and keeps those the camera frustum
// intersects — the WB.EnvCellManager strategy.
//
// Exit codes (for diag-run-all):
//   0 = diff.ok === true
//   1 = diff.ok === false (the documented gap)
//   2 = harness couldn't reach the diff (oracle fetch failed, helper missing)
//
// Run from `apps/holtburger-web/`:
//   NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
//   node scripts/diag/run-diag-pvs-holtburg-cottage.cjs

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

const ORACLE_URL = "/apps/holtburger-web/oracles/pvs/0xA9B40100.json";
const BASE_URL =
  process.env.HOLTBURGER_BASE_URL || "http://127.0.0.1:8765";
const URL =
  `${BASE_URL}/apps/holtburger-web/index.html?` +
  "autoLogin=1&account=acadmp1ge522&password=acadmp1ge522&autoSpawn=first" +
  "&renderer=3d&quality=low&agentic=low" +
  "&wireframe=1&hud=none&plugins=none&netDrainHz=30&diag=1";
const CHROME =
  process.env.CHROME_PATH ||
  "/home/wbterminal/.cache/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-linux64/chrome-headless-shell";
const OUT_ROOT =
  process.env.HOLTBURGER_DIAG_OUT ||
  "/mnt/wbterminal1/tmp/claude-scratch/holtburger-diag-runs";

(async () => {
  const TS = new Date().toISOString().replace(/[:.]/g, "-");
  const OUT = path.join(OUT_ROOT, `pvs-holtburg-cottage-outside-${TS}`);
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
  console.log("[boot] ready. Settling 6s…");
  await page.waitForTimeout(6000);

  console.log("[chat] @telepoi Holtburg");
  await page.evaluate(() => {
    const h = window.liveScene3d?.sessionHandle ?? window.__sessionHandle;
    if (h?.sendChat) h.sendChat("@telepoi Holtburg");
  });
  await page.waitForTimeout(8000);

  console.log("[walk] focus + W for 12s");
  await page.mouse.click(640, 360);
  await page.waitForTimeout(300);
  await page.keyboard.down("KeyW");
  await page.waitForTimeout(12000);
  await page.keyboard.up("KeyW");
  await page.waitForTimeout(1500);

  const afterWalk = await page.evaluate(() => ({
    currentCell: window.__diag?.pvs?.currentCell() ?? null,
    visibleCount: window.__diag?.pvs?.visibleCells().size ?? 0,
    isIndoor: (() => {
      try { return !!window.liveScene3d?.sessionHandle?.isCurrentCellIndoor?.(); } catch (_) { return null; }
    })(),
  }));
  console.log(`[probe] cell=${afterWalk.currentCell?.cellHex} isIndoor=${afterWalk.isIndoor} visible=${afterWalk.visibleCount}`);

  // Phase 4 acceptance criterion: at least one EnvCell visible.
  // We don't compare against a specific cell's PVS (that's the
  // inside variant's job) — just verify the LandCell→EnvCell
  // visibility bridge produces results.
  const observed = await page.evaluate(() => {
    const live = window.liveScene3d;
    if (!(live?.cellContainers3d instanceof Map)) return { count: 0, envCellCount: 0, sample: [] };
    let envCellCount = 0;
    const sample = [];
    for (const [cellId, container] of live.cellContainers3d) {
      if (container?.visible) {
        const idx = cellId & 0xffff;
        if (idx >= 0x0100) {
          envCellCount++;
          if (sample.length < 5) sample.push("0x" + (cellId >>> 0).toString(16).padStart(8, "0"));
        }
      }
    }
    return { envCellCount, sample };
  });

  // ALSO keep the legacy oracle-diff for diagnostic value (it's
  // expected to show extras now since we may see cells outside the
  // 0xA9B40100 PVS — that's correct retail behaviour, not a bug).
  const diag = await page.evaluate(async (oracleUrl) => {
    if (typeof window.__diag?.pvs?.observedVsBaked !== "function") {
      return { error: "__diag.pvs.observedVsBaked missing" };
    }
    return await window.__diag.pvs.observedVsBaked(oracleUrl);
  }, ORACLE_URL);

  await writeFile(path.join(OUT, "probe.json"), JSON.stringify(afterWalk, null, 2));
  await writeFile(path.join(OUT, "observed.json"), JSON.stringify(observed, null, 2));
  await writeFile(path.join(OUT, "diag.json"), JSON.stringify(diag, null, 2));
  await writeFile(path.join(OUT, "console.log"), consoleLines.join("\n"));

  const pass = !diag.error && observed.envCellCount > 0;

  console.log("\n=== observed EnvCells ===");
  console.log(`  envCellCount: ${observed.envCellCount}   sample: ${observed.sample.join(", ")}`);
  console.log("\n=== oracle diff (informational only — outdoor doesn't need to match interior PVS) ===");
  console.log(`  observedCount: ${diag.observedCount}   oracleCount: ${diag.oracleCount}   missing: ${diag.missing?.length ?? 0}   extra: ${diag.extra?.length ?? 0}`);
  console.log("\n=== Verdict ===");
  console.log(`  pass criterion: at least one EnvCell visible from outdoors → ${pass}`);
  if (pass) {
    console.log(`  → PASS. LandCell→EnvCell visibility bridge works (Phase 4 PView port).`);
  } else if (observed.envCellCount === 0) {
    console.log(`  → FAIL. Zero EnvCells visible from outdoor camera. Either:`);
    console.log(`    - Camera not pointed at any cottage (try different walk path)`);
    console.log(`    - getRenderSetWithFrustum not wired through to tickCellVisibility3D`);
    console.log(`    - cell_aabbs snapshot empty (publish_cell_scene_snapshot bug)`);
  }
  console.log(`\nOUT=${OUT}`);
  await browser.close();

  if (diag?.error) process.exit(2);
  process.exit(pass ? 0 : 1);
})();
