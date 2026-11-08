// tests/challenger_m3_browser_stress.mjs — Adversarial empirical in-browser test
// for Milestone M3 (VTank UI Restyle).
//
// Tests in a real headless Chromium browser:
// 1. Loads rynth_vt_preview.html
// 2. Traps any page errors or unhandled rejections
// 3. Tests rapid tab switches across all 8 tabs
// 4. Tests command bar toggle cycles
// 5. Tests stepper button clicks and boundary extremes
// 6. Tests element.textContent and DOM stability

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, "..");
const WORKSPACE_ROOT = path.resolve(APP_ROOT, "../..");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
};

// Start static server serving from APP_ROOT and WORKSPACE_ROOT
const server = http.createServer((req, res) => {
  const urlPath = req.url.split("?")[0];
  let filePath = path.join(APP_ROOT, urlPath);
  if (!fs.existsSync(filePath)) {
    filePath = path.join(WORKSPACE_ROOT, urlPath);
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.statusCode = 404;
    res.end("Not found");
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const targetUrl = `http://127.0.0.1:${port}/rynth_vt_preview.html`;

console.log(`Test server running at ${targetUrl}`);

const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-gpu", "--mute-audio"],
});

const page = await browser.newPage();
const pageErrors = [];
const consoleWarnings = [];

page.on("pageerror", (err) => {
  pageErrors.push(err);
  console.error("[PAGE ERROR]", err);
});
page.on("console", (msg) => {
  if (msg.type() === "error") {
    console.error("[CONSOLE ERROR]", msg.text());
  } else if (msg.type() === "warning") {
    consoleWarnings.push(msg.text());
  }
});

let failed = false;

try {
  await page.goto(targetUrl, { waitUntil: "networkidle" });
  await page.waitForSelector("#hb-rynth-vt", { timeout: 5000 });
  console.log("VTank panel loaded successfully in Chromium.");

  // Check initial title and monogram
  const title = await page.textContent(".hbk-title");
  console.log("Panel title:", title);
  if (title !== "RynthSuite — VTank") throw new Error(`Unexpected title: ${title}`);

  // Tab check
  const tabs = await page.$$eval(".hbk-tab", (els) => els.map((e) => e.textContent));
  console.log("Tab names:", tabs);
  const expectedTabs = ["Main", "Monsters", "Items", "Buffs", "Route", "Loot", "Meta", "Advanced"];
  if (JSON.stringify(tabs) !== JSON.stringify(expectedTabs)) {
    throw new Error(`Tab textContent mismatch: ${JSON.stringify(tabs)}`);
  }

  // Rapid tab switching test (100 switches)
  console.log("Starting rapid tab switching stress test (100 iterations)...");
  const tabIds = ["main", "monsters", "items", "buffs", "route", "loot", "meta", "advanced"];
  for (let i = 0; i < 100; i++) {
    const t = tabIds[i % tabIds.length];
    await page.click(`.hbk-tab[data-tab='${t}']`);
  }
  console.log("Rapid tab switching completed without crash.");

  // Check active tab state (99 % 8 = 3 -> buffs)
  const lastTab = tabIds[99 % tabIds.length];
  const activeTabSelected = await page.$eval(`.hbk-tab[data-tab='${lastTab}']`, (el) => el.getAttribute("aria-selected"));
  if (activeTabSelected !== "true") throw new Error(`${lastTab} tab not selected after cycling to it`);

  // Switch back to Main tab
  await page.click(".hbk-tab[data-tab='main']");

  // Toggle stress cycles on Command Bar
  console.log("Starting command bar toggle stress cycles (50 iterations)...");
  for (let i = 0; i < 50; i++) {
    await page.click(".rvt-tgl[data-switch='combat']");
    await page.click(".rvt-tgl[data-switch='buff']");
    await page.click(".rvt-tgl[data-switch='nav']");
    await page.click(".rvt-tgl[data-switch='loot']");
    await page.click(".rvt-tgl[data-switch='meta']");
  }
  console.log("Command bar toggles completed.");

  // Stepper click test in real browser
  console.log("Testing stepper buttons (▲ / ▼) on Main tab in real browser...");
  const monsterRangeInput = await page.$(".rvt-ranges input");
  const initVal = await monsterRangeInput.inputValue();
  console.log("MonsterRange initial value:", initVal);

  const upBtn = await page.$(".rvt-ranges .rvt-step-btn.is-up");
  const dnBtn = await page.$(".rvt-ranges .rvt-step-btn.is-down");

  if (!upBtn || !dnBtn) throw new Error("Stepper buttons not found in .rvt-ranges");

  await upBtn.click();
  const upVal = await monsterRangeInput.inputValue();
  console.log("After clicking up (▲):", upVal);
  // MonsterRange is float with step 0.1
  const step = Number(await monsterRangeInput.getAttribute("step")) || 0.1;
  const expectedUp = Math.round((Number(initVal) + step) * 1e6) / 1e6;
  if (Number(upVal) !== expectedUp) {
    throw new Error(`Stepper increment failed: expected ${expectedUp}, got ${upVal}`);
  }

  await dnBtn.click();
  await dnBtn.click();
  const dnVal = await monsterRangeInput.inputValue();
  console.log("After clicking down (▼) twice:", dnVal);
  const expectedDn = Math.round((Number(initVal) - step) * 1e6) / 1e6;
  if (Number(dnVal) !== expectedDn) {
    throw new Error(`Stepper decrement failed: expected ${expectedDn}, got ${dnVal}`);
  }

  // Test boundary extremes in browser
  console.log("Testing boundary clamping on steppers in browser...");
  // Set value to 1 (the min)
  await page.$eval(".rvt-ranges input", (el) => {
    el.value = "1";
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await dnBtn.click();
  const minClampVal = await monsterRangeInput.inputValue();
  console.log("At min 1, after clicking down:", minClampVal);
  if (Number(minClampVal) !== 1) {
    throw new Error(`Stepper failed to clamp at minimum 1: got ${minClampVal}`);
  }

  // Set value to 200 (the max)
  await page.$eval(".rvt-ranges input", (el) => {
    el.value = "200";
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await upBtn.click();
  const maxClampVal = await monsterRangeInput.inputValue();
  console.log("At max 200, after clicking up:", maxClampVal);
  if (Number(maxClampVal) !== 200) {
    throw new Error(`Stepper failed to clamp at maximum 200: got ${maxClampVal}`);
  }

  // Check decorative elements in browser
  const cornerCount = await page.$$eval(".rvt-corner", (els) => els.length);
  if (cornerCount !== 4) throw new Error(`Expected 4 corner brackets, got ${cornerCount}`);

  const radarExists = await page.$eval(".rvt-radar", (el) => !!el);
  if (!radarExists) throw new Error("Radar element not found in DOM");

  const wolfExists = await page.$eval(".rvt-vignette-wolf", (el) => !!el);
  if (!wolfExists) throw new Error("Wolf vignette not found in DOM");

  const castleExists = await page.$eval(".rvt-vignette-castle", (el) => !!el);
  if (!castleExists) throw new Error("Castle vignette not found in DOM");

  // Deep interactive testing across other tabs in Chromium
  console.log("Testing Monsters tab interactions...");
  await page.click(".hbk-tab[data-tab='monsters']");
  await page.waitForTimeout(100);
  const monsterRows = await page.$$eval(".rvt-mon-row", (els) => els.length);
  console.log(`Monsters tab loaded ${monsterRows} monster rows.`);
  const monFilter = await page.$(".rvt-filter");
  if (monFilter) {
    await monFilter.fill("Drudge");
    await page.waitForTimeout(100);
    const filteredRows = await page.$$eval(".rvt-mon-row:not([hidden])", (els) => els.length);
    console.log(`Filtered monster rows: ${filteredRows}`);
    await monFilter.fill("");
    await page.waitForTimeout(100);
  }

  console.log("Testing Buffs tab interactions...");
  await page.click(".hbk-tab[data-tab='buffs']");
  await page.waitForTimeout(100);
  const buffUpBtn = await page.$(".rvt-tab-body[data-tab='buffs'] .rvt-step-btn.is-up");
  if (buffUpBtn) {
    const rebuffInput = await page.$(".rvt-tab-body[data-tab='buffs'] input[type='number']");
    const rebuffValBefore = await rebuffInput.inputValue();
    await buffUpBtn.click();
    const rebuffValAfter = await rebuffInput.inputValue();
    console.log(`Buffs rebuff stepper: ${rebuffValBefore} -> ${rebuffValAfter}`);
  }

  console.log("Testing Loot tab interactions...");
  await page.click(".hbk-tab[data-tab='loot']");
  await page.waitForTimeout(100);
  const lootUpBtn = await page.$(".rvt-tab-body[data-tab='loot'] .rvt-step-btn.is-up");
  if (lootUpBtn) {
    const minValInput = await page.$(".rvt-tab-body[data-tab='loot'] input[type='number']");
    const minValBefore = await minValInput.inputValue();
    await lootUpBtn.click();
    const minValAfter = await minValInput.inputValue();
    console.log(`Loot minVal stepper: ${minValBefore} -> ${minValAfter}`);
  }

  console.log("Testing Route tab interactions...");
  await page.click(".hbk-tab[data-tab='route']");
  await page.waitForTimeout(100);
  const routePoints = await page.$$eval(".rvt-route-pt", (els) => els.length);
  console.log(`Route points count: ${routePoints}`);

  console.log("Testing Meta tab interactions...");
  await page.click(".hbk-tab[data-tab='meta']");
  await page.waitForTimeout(100);
  const metaRules = await page.$$eval(".rvt-meta-rule", (els) => els.length);
  console.log(`Meta rules count: ${metaRules}`);

  console.log("Testing Advanced tab interactions...");
  await page.click(".hbk-tab[data-tab='advanced']");
  await page.waitForTimeout(100);
  const advFilter = await page.$(".rvt-tab-body[data-tab='advanced'] input[type='search'], .rvt-tab-body[data-tab='advanced'] .rvt-filter");
  if (advFilter) {
    await advFilter.fill("Range");
    await page.waitForTimeout(100);
    const searchResults = await page.$$eval(".rvt-tab-body[data-tab='advanced'] .rvt-adv-row:not([hidden])", (els) => els.length);
    console.log(`Advanced tab search 'Range' matches: ${searchResults}`);
    await advFilter.fill("");
    await page.waitForTimeout(100);
  }

  console.log("All interactive tab tests passed!");

  console.log("All in-browser checks passed!");

} catch (err) {
  console.error("Test failed with exception:", err);
  failed = true;
} finally {
  await browser.close();
  server.close();
}

if (pageErrors.length > 0) {
  console.error(`Encountered ${pageErrors.length} unhandled page error(s) during execution!`);
  failed = true;
}

if (failed) {
  process.exit(1);
} else {
  console.log("IN-BROWSER STRESS TEST SUITE: ALL CHECKS PASSED!");
  process.exit(0);
}
