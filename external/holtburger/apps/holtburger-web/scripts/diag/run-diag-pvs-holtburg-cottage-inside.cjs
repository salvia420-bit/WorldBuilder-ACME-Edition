// Wire-agent harness — Holtburg cottage PVS, INSIDE variant.
//
// Validates the Phase 3 visible_cells fix (commit 344d0b6d, lib.rs
// ~L10149). Uses `@teleloc 0xA9B40100 88 131 67` to land the player
// inside Holtburg cottage cell 0xA9B40100, then runs
// `__diag.pvs.observedVsBaked` against the same oracle the outside
// variant uses.
//
// With the fix in place: PASS — 17/17 oracle cells visible,
// missing=[], extra=[], ok=true. Without it (pre-fix): would have
// shown missing=13 (BFS-1 reaches only 4 of the 17 direct-portal
// neighbors).
//
// Cottage 0xA9B40100 in Holtburg (LB 0xA9B4) per `get-dungeon-info`:
//   - origin: (84.09, 131.54, 66)
//   - portals: 6 (4 to outdoor LandCells via 0xFFFF sentinel,
//     2 to neighbor EnvCells 0x0102 / 0x0103, 1 to 0x0110)
//   - 22 static objects (chairs, NPCs)
// Safe teleport coords (interior, above floor): (88, 131, 67).
//
// Exit codes (for diag-run-all):
//   0 = diff.ok === true
//   1 = diff.ok === false
//   2 = harness couldn't reach the diff
//
// Run from `apps/holtburger-web/`:
//   NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
//   node scripts/diag/run-diag-pvs-holtburg-cottage-inside.cjs

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

(async () => {
  const TS = new Date().toISOString().replace(/[:.]/g, "-");
  const OUT = path.join(OUT_ROOT, `pvs-holtburg-cottage-inside-${TS}`);
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

  console.log(`[chat] ${TELELOC_CMD}`);
  await page.evaluate((cmd) => {
    const h = window.liveScene3d?.sessionHandle ?? window.__sessionHandle;
    if (h?.sendChat) h.sendChat(cmd);
  }, TELELOC_CMD);
  await page.waitForTimeout(10000);

  const probe = await page.evaluate(() => {
    const live = window.liveScene3d;
    const handle = live?.sessionHandle ?? window.__sessionHandle ?? null;
    return {
      currentCell: window.__diag?.pvs?.currentCell() ?? null,
      isIndoor: (() => {
        try { return !!handle?.isCurrentCellIndoor?.(); } catch (_) { return null; }
      })(),
      visibleCount: window.__diag?.pvs?.visibleCells().size ?? 0,
      cellsLoaded: (live?.cellContainers3d instanceof Map) ? live.cellContainers3d.size : 0,
    };
  });
  console.log(`[probe] cell=${probe.currentCell?.cellHex} isIndoor=${probe.isIndoor} visible=${probe.visibleCount} loaded=${probe.cellsLoaded}`);

  const diag = await page.evaluate(async (oracleUrl) => {
    if (typeof window.__diag?.pvs?.observedVsBaked !== "function") {
      return { error: "observedVsBaked missing" };
    }
    return await window.__diag.pvs.observedVsBaked(oracleUrl);
  }, ORACLE_URL);

  await writeFile(path.join(OUT, "probe.json"), JSON.stringify(probe, null, 2));
  await writeFile(path.join(OUT, "diag.json"), JSON.stringify(diag, null, 2));
  await writeFile(path.join(OUT, "console.log"), consoleLines.join("\n"));

  console.log("\n=== observedVsBaked diff ===");
  console.log(JSON.stringify(diag, null, 2));
  console.log("\n=== Verdict ===");
  if (diag.error) {
    console.log(`  ERROR: ${diag.error}`);
  } else {
    console.log(`  Oracle: ${diag.oracleCount}   Observed: ${diag.observedCount}   missing: ${diag.missing?.length ?? 0}   extra: ${diag.extra?.length ?? 0}   ok: ${diag.ok}`);
    if (probe.currentCell?.cellHex?.toLowerCase() !== "0xa9b40100"
        && (probe.currentCell?.cellIdx ?? 0) < 0x0100) {
      console.log(`  WARN: player NOT in an EnvCell — teleport may have failed (account needs Developer access).`);
    } else if (diag.ok) {
      console.log(`  → PASS. visible_cells consumption reaches the full DAT-baked PVS.`);
    } else {
      console.log(`  → FAIL. Phase 3 fix may not be propagating, or teleport landed somewhere unexpected.`);
    }
  }
  console.log(`\nOUT=${OUT}`);
  await browser.close();

  if (diag?.error) process.exit(2);
  process.exit(diag?.ok === true ? 0 : 1);
})();
