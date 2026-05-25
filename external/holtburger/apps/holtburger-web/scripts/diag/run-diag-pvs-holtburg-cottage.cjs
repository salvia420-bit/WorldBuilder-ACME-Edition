// Wire-agent harness — Holtburg cottage PVS, OUTSIDE variant.
//
// Documents the LandCell↔EnvCell edge gap (shortfall #3 in
// docs/cell-portal-method.md §"Known scope gap"). Boots holtburger-web,
// @telepoi Holtburg, walks the player around outside the cottages,
// then runs `__diag.pvs.observedVsBaked(oracleUrl)` against the
// 0xA9B40100 oracle.
//
// Today (2026-05-25): expected to FAIL. observedCount=0, missing=17,
// ok=false — because outdoor LandCells have no portal-graph edges
// into adjacent EnvCells. Will pass when retail PView's screen-space
// portal-polygon clipping is ported (substantial work).
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
  "&renderer=3d&quality=low&kickDance=0&agentic=low" +
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

  const diag = await page.evaluate(async (oracleUrl) => {
    if (typeof window.__diag?.pvs?.observedVsBaked !== "function") {
      return { error: "__diag.pvs.observedVsBaked missing (Phase 1 helper not loaded?)" };
    }
    return await window.__diag.pvs.observedVsBaked(oracleUrl);
  }, ORACLE_URL);

  await writeFile(path.join(OUT, "probe.json"), JSON.stringify(afterWalk, null, 2));
  await writeFile(path.join(OUT, "diag.json"), JSON.stringify(diag, null, 2));
  await writeFile(path.join(OUT, "console.log"), consoleLines.join("\n"));

  console.log("\n=== observedVsBaked diff ===");
  console.log(JSON.stringify(diag, null, 2));
  console.log("\n=== Gap shape ===");
  if (diag.error) {
    console.log(`  ERROR: ${diag.error}`);
  } else {
    console.log(`  Oracle (cell ${diag.oracleCellHex ?? "?"}): ${diag.oracleCount} cells`);
    console.log(`  Observed (cellContainers3d.visible): ${diag.observedCount} cells`);
    console.log(`  Missing: ${diag.missing?.length ?? 0}   Extra: ${diag.extra?.length ?? 0}   ok: ${diag.ok}`);
    if ((diag.missing?.length ?? 0) > 0 && diag.observedCount === 0) {
      console.log(`  → LandCell↔EnvCell edge gap (shortfall #3 — open).`);
    }
  }
  console.log(`\nOUT=${OUT}`);
  await browser.close();

  if (diag?.error) process.exit(2);
  process.exit(diag?.ok === true ? 0 : 1);
})();
