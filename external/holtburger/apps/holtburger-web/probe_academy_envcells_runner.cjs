// Minimal Playwright runner for probe_academy_envcells.html — exercises
// fetchEnvCellsInLandblock(0x86020000) directly via the wasm module
// WITHOUT requiring a live ACE login. This bypasses the renderer
// init / start_session path that crashes under current resource
// pressure.

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
    "http://127.0.0.1:8765/apps/holtburger-web/probe_academy_envcells.html";
  const DIAG_LOG_PATH = path.resolve(
    "/mnt/wbterminal1/holtburger-captures",
    `academy-diag-${Date.now()}.log`
  );
  fs.writeFileSync(
    DIAG_LOG_PATH,
    `# probe_academy_envcells diag transcript ${new Date().toISOString()}\n`
  );
  console.log(`diag transcript: ${DIAG_LOG_PATH}`);

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

  page.on("console", (msg) => {
    const text = msg.text();
    try {
      fs.appendFileSync(DIAG_LOG_PATH, `[${msg.type()}] ${text}\n`);
    } catch (_) {}
    if (/\[academy-diag\]|\[probe-runner\]|fetchEnv|EnvCell|landblock|error|Error/i.test(text)) {
      console.log(`[browser ${msg.type()}] ${text}`);
    }
  });
  page.on("pageerror", (err) => {
    console.error("[pageerror]", err.message);
    try {
      fs.appendFileSync(DIAG_LOG_PATH, `[pageerror] ${err.message}\n`);
    } catch (_) {}
  });

  console.log(`launching → ${PAGE_URL}`);
  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });

  // Wait for the page to set its title to PROBE_DONE or PROBE_FAIL.
  const deadline = Date.now() + 120_000;
  let done = false;
  while (Date.now() < deadline) {
    const title = await page.title().catch(() => "");
    if (title === "PROBE_DONE" || title === "PROBE_FAIL") {
      done = true;
      console.log(`probe terminal state: ${title}`);
      break;
    }
    await page.waitForTimeout(250);
  }
  if (!done) console.log("probe timed out (no PROBE_DONE/PROBE_FAIL)");

  // Dump the on-page <pre id="out"> as well for debugging.
  const txt = await page.evaluate(() => {
    const e = document.getElementById("out");
    return e ? e.textContent : "(no #out)";
  }).catch((e) => `(eval err: ${e?.message ?? e})`);
  fs.appendFileSync(DIAG_LOG_PATH, "\n# on-page out:\n" + txt + "\n");
  console.log("\n--- on-page out ---\n" + txt);

  await browser.close();
  console.log(`diag transcript: ${DIAG_LOG_PATH}`);
})().catch((err) => {
  console.error("runner failed:", err);
  process.exit(1);
});
