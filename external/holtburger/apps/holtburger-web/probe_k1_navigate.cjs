// One-shot CDP nav: point the 1070 Chrome's holtburger tab at the
// full-fidelity URL so the user can interactive-test.

const { chromium } = require("playwright");

const CDP_URL = process.env.K1_CDP_URL || "http://127.0.0.1:9223";
const TARGET = process.env.K1_TARGET_URL
  || "http://localhost:7080/apps/holtburger-web/index.html"
     + "?renderer=3d&quality=ultra&clouds=on&atmosphere=on";

(async () => {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0];
  const pages = ctx.pages();
  const HOLTBURGER_PREFIX = "http://localhost:7080/apps/holtburger-web/";
  let page = pages.find((p) => p.url().startsWith(HOLTBURGER_PREFIX));
  if (!page) {
    console.log("no existing holtburger tab — opening a new one");
    page = await ctx.newPage();
  } else {
    console.log(`reusing holtburger tab @ ${page.url()}`);
  }
  console.log(`navigating to: ${TARGET}`);
  await page.goto(TARGET, { waitUntil: "domcontentloaded" });
  // Give the smoke + scene-init time to settle.
  await page.waitForTimeout(2500);
  console.log("page url now:", page.url());
  await browser.close();
})();
