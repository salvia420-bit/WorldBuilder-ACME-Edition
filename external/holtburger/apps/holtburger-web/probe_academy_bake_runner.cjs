// Playwright runner for probe_academy_bake.html — exercises
// buildEnvCellsForLandblock(mockScene3d, 0x86020000) end-to-end JS
// (mocked materialCache) WITHOUT requiring a live ACE login or the
// full renderer init. Validates that Phase 1's dynamic-indoor-LB-entry
// wiring populates scene3d.cellContainers3d cleanly for the AC
// Training Academy's 568 EnvCells.

const path = require("node:path");
const fs = require("node:fs");

const PLAYWRIGHT_CACHE =
  process.env.PLAYWRIGHT_CACHE ||
  "/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules";
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch (_) {
  ({ chromium } = require(path.join(PLAYWRIGHT_CACHE, "playwright")));
}

(async () => {
  const PAGE_URL =
    process.env.PROBE_PAGE_URL ||
    "http://127.0.0.1:8765/apps/holtburger-web/probe_academy_bake.html";
  const LOG_PATH = path.resolve(
    "/mnt/wbterminal1/holtburger-captures",
    `academy-bake-probe-${Date.now()}.log`
  );
  fs.writeFileSync(
    LOG_PATH,
    `# probe_academy_bake transcript ${new Date().toISOString()}\n`
  );
  console.log(`bake-probe log: ${LOG_PATH}`);

  const browser = await chromium.launch({
    args: [
      "--use-gl=swiftshader",
      "--disable-dev-shm-usage",
      "--no-sandbox",
      "--disable-gpu-sandbox",
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 800, height: 600 },
  });
  const page = await context.newPage();

  let resultJson = null;
  page.on("console", (msg) => {
    const text = msg.text();
    try {
      fs.appendFileSync(LOG_PATH, `[${msg.type()}] ${text}\n`);
    } catch (_) {}
    if (/__RESULT__/.test(text)) {
      const m = text.match(/__RESULT__\s+(\{.*\})/);
      if (m) {
        try {
          resultJson = JSON.parse(m[1]);
        } catch (_) {}
      }
    }
    // Echo a curated set of lines to the runner stdout.
    if (
      /__RESULT__|OVERALL|PROBE_|EXCEPTION|FAIL|\[probe-runner\]|EnvCell|cellContainers|totalVerts|academyCellCount|cellCount/i.test(
        text
      )
    ) {
      console.log(`[browser ${msg.type()}] ${text}`);
    }
  });
  page.on("pageerror", (err) => {
    console.error("[pageerror]", err.message);
    try {
      fs.appendFileSync(LOG_PATH, `[pageerror] ${err.message}\n`);
    } catch (_) {}
  });

  console.log(`launching → ${PAGE_URL}`);
  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });

  // Wait for the page to set its title to PROBE_DONE or PROBE_FAIL.
  const deadline = Date.now() + 120_000;
  let done = false;
  let terminalTitle = "";
  while (Date.now() < deadline) {
    const title = await page.title().catch(() => "");
    if (title === "PROBE_DONE" || title === "PROBE_FAIL") {
      done = true;
      terminalTitle = title;
      console.log(`probe terminal state: ${title}`);
      break;
    }
    await page.waitForTimeout(250);
  }
  if (!done) console.log("probe timed out (no PROBE_DONE/PROBE_FAIL)");

  const txt = await page.evaluate(() => {
    const e = document.getElementById("out");
    return e ? e.textContent : "(no #out)";
  }).catch((e) => `(eval err: ${e?.message ?? e})`);
  fs.appendFileSync(LOG_PATH, "\n# on-page out:\n" + txt + "\n");
  console.log("\n--- on-page out ---\n" + txt);

  await browser.close();
  console.log(`bake-probe log: ${LOG_PATH}`);

  // Exit 0 iff cellCount === 568. Per task spec.
  const cellCount = resultJson?.cellCount;
  const exitCode = cellCount === 568 ? 0 : 1;
  console.log(`exit code: ${exitCode} (cellCount=${cellCount}, terminalTitle=${terminalTitle})`);
  process.exit(exitCode);
})().catch((err) => {
  console.error("runner failed:", err);
  process.exit(1);
});
