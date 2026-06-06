// js-waterfall-capture.cjs — measure the cold-boot JS module loading waterfall.
//
// Loads index.html (renderer=3d, no login required — the eager scene3d import +
// the static plugin graph both load at page parse, which is the 58s "193 JS"
// bucket from the network capture) and reports, for the .js requests:
//   - count
//   - wall-clock span (first JS request start → last JS response end)
//   - MAX CONCURRENT in-flight requests  ← the "one at a time vs parallel" metric
// Also captures console/page errors as a regression gate.
//
// Run on the buildbox with a dev server already serving the tree:
//   NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
//   CAP_URL="http://127.0.0.1:8765/apps/holtburger-web/index.html?renderer=3d" \
//   node diag/js-waterfall-capture.cjs

const path = require("node:path");
const PLAYWRIGHT_CACHE =
  process.env.PLAYWRIGHT_CACHE ||
  "/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules";
let chromium;
try { ({ chromium } = require("playwright")); }
catch (_) { ({ chromium } = require(path.join(PLAYWRIGHT_CACHE, "playwright"))); }

const URL = process.env.CAP_URL
  || "http://127.0.0.1:8765/apps/holtburger-web/index.html?renderer=3d";
const SETTLE_MS = parseInt(process.env.SETTLE_MS || "20000", 10);
const LABEL = process.env.LABEL || "capture";

function maxConcurrent(intervals) {
  // sweep line over [start,end) events
  const ev = [];
  for (const [s, e] of intervals) { ev.push([s, 1]); ev.push([e, -1]); }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]); // end (-1) before start (+1) at ties
  let cur = 0, max = 0;
  for (const [, d] of ev) { cur += d; if (cur > max) max = cur; }
  return max;
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--use-gl=swiftshader", "--disable-background-timer-throttling"],
  });
  // Fresh context = cold cache. Dev server also sends no-cache for JS.
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const page = await context.newPage();

  const reqs = new Map(); // url -> {start, end, type}
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  const t0 = Date.now();
  const isJs = (u) => /\.js(\?|$)/.test(u) || /\.mjs(\?|$)/.test(u);
  page.on("request", (r) => {
    reqs.set(r.url(), { start: Date.now() - t0, end: null, type: r.resourceType() });
  });
  const finish = (r) => { const e = reqs.get(r.url()); if (e) e.end = Date.now() - t0; };
  page.on("requestfinished", finish);
  page.on("requestfailed", finish);

  try {
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch (e) {
    console.log(`[${LABEL}] goto error: ${e.message}`);
  }
  // Let the eager idle imports + module graph fully settle.
  await page.waitForTimeout(SETTLE_MS);

  // Boot state probe (regression signal — did the wasm/page come up?)
  const bootState = await page.evaluate(() => {
    try { return window.__bootState || window.__bootStatus || "(no __bootState)"; }
    catch (_) { return "(eval failed)"; }
  });

  const entries = [...reqs.entries()];
  const jsEntries = entries.filter(([u]) => isJs(u)).map(([, v]) => v).filter((v) => v.end != null);
  const jsIntervals = jsEntries.map((v) => [v.start, v.end]);
  const span = jsEntries.length
    ? Math.max(...jsEntries.map((v) => v.end)) - Math.min(...jsEntries.map((v) => v.start))
    : 0;

  console.log(`\n=== [${LABEL}] ===`);
  console.log(`url: ${URL}`);
  console.log(`total requests: ${entries.length}`);
  console.log(`JS requests (finished): ${jsEntries.length}`);
  console.log(`JS wall-clock span: ${span} ms`);
  console.log(`JS MAX CONCURRENT in-flight: ${maxConcurrent(jsIntervals)}`);
  console.log(`console errors: ${consoleErrors.length}`);
  console.log(`page errors: ${pageErrors.length}`);
  if (consoleErrors.length) console.log("  first error:", consoleErrors[0].slice(0, 200));
  if (pageErrors.length) console.log("  first pageerror:", pageErrors[0].slice(0, 200));
  console.log(`bootState: ${typeof bootState === "object" ? JSON.stringify(bootState).slice(0, 200) : bootState}`);

  await browser.close();
  process.exit(0);
})();
