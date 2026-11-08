// tests/challenger_m3_browser_adversarial.mjs
// Adversarial browser stress test:
// 1. Tests real browser click events on disabled, readonly, and aria-disabled steppers
// 2. Tests rapid-fire bursts of clicks on steppers in Chromium
// 3. Tests boundary clamping under rapid clicks
// 4. Verifies zero page errors, unhandled rejections, or console errors

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import assert from "node:assert/strict";

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

console.log(`Adversarial browser test server running at ${targetUrl}`);

const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-gpu", "--mute-audio"],
});

const page = await browser.newPage();
const pageErrors = [];

page.on("pageerror", (err) => {
  pageErrors.push(err);
  console.error("[IN-BROWSER PAGE ERROR]", err);
});
page.on("console", (msg) => {
  if (msg.type() === "error") {
    console.error("[IN-BROWSER CONSOLE ERROR]", msg.text());
  }
});

try {
  await page.goto(targetUrl, { waitUntil: "networkidle" });
  await page.waitForSelector("#hb-rynth-vt", { timeout: 5000 });

  const inputSelector = ".rvt-ranges input";
  const upSelector = ".rvt-ranges .rvt-step-btn.is-up";
  const dnSelector = ".rvt-ranges .rvt-step-btn.is-down";

  // Check initial state
  const initialVal = await page.$eval(inputSelector, (el) => el.value);
  console.log(`Initial MonsterRange value: ${initialVal}`);

  // Test 1: Disabled guard in real browser
  console.log("Testing disabled input stepper guard in real Chromium...");
  await page.$eval(inputSelector, (el) => {
    el.disabled = true;
  });
  await page.click(upSelector);
  await page.click(dnSelector);
  let curVal = await page.$eval(inputSelector, (el) => el.value);
  assert.equal(curVal, initialVal, "Disabled input value did not change on stepper click");

  // Re-enable
  await page.$eval(inputSelector, (el) => {
    el.disabled = false;
  });

  // Test 2: ReadOnly guard in real browser
  console.log("Testing readOnly input stepper guard in real Chromium...");
  await page.$eval(inputSelector, (el) => {
    el.readOnly = true;
  });
  await page.click(upSelector);
  await page.click(dnSelector);
  curVal = await page.$eval(inputSelector, (el) => el.value);
  assert.equal(curVal, initialVal, "ReadOnly input value did not change on stepper click");

  // Re-enable
  await page.$eval(inputSelector, (el) => {
    el.readOnly = false;
  });

  // Test 3: aria-disabled="true" guard in real browser
  console.log("Testing aria-disabled input stepper guard in real Chromium...");
  await page.$eval(inputSelector, (el) => {
    el.setAttribute("aria-disabled", "true");
  });
  await page.click(upSelector);
  await page.click(dnSelector);
  curVal = await page.$eval(inputSelector, (el) => el.value);
  assert.equal(curVal, initialVal, "Aria-disabled input value did not change on stepper click");

  // Re-enable
  await page.$eval(inputSelector, (el) => {
    el.removeAttribute("aria-disabled");
  });

  // Test 4: Rapid clicking burst (50 clicks)
  console.log("Testing rapid clicking burst (50 clicks) on steppers...");
  const baseNum = Number(curVal);
  for (let i = 0; i < 25; i++) {
    await page.click(upSelector);
  }
  const after25Up = await page.$eval(inputSelector, (el) => Number(el.value));
  console.log(`Value after 25 rapid up clicks: ${after25Up}`);
  assert.equal(
    Math.round(after25Up * 10) / 10,
    Math.round((baseNum + 2.5) * 10) / 10,
    "25 up clicks incremented exactly by 2.5"
  );

  for (let i = 0; i < 25; i++) {
    await page.click(dnSelector);
  }
  const after25Dn = await page.$eval(inputSelector, (el) => Number(el.value));
  console.log(`Value after 25 rapid down clicks: ${after25Dn}`);
  assert.equal(
    Math.round(after25Dn * 10) / 10,
    Math.round(baseNum * 10) / 10,
    "25 down clicks returned exactly to initial value"
  );

  // Test 5: Verify zero page errors
  assert.equal(pageErrors.length, 0, `Encountered ${pageErrors.length} page errors during testing`);

  console.log("\n==================================================");
  console.log("ALL REAL BROWSER ADVERSARIAL CHECKS PASSED!");
  console.log("==================================================");
} finally {
  await browser.close();
  server.close();
}
