// Reload the 1070 Chrome tab, clear caches, login, snapshot bar.

const { chromium } = require("playwright");
const fs = require("node:fs");

const CDP_URL = process.env.K1_CDP_URL || "http://127.0.0.1:9223";
const PAGE_URL = "http://localhost:7080/apps/holtburger-web/index.html";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

(async () => {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0];
  const pages = ctx.pages();
  let page = pages.find((p) =>
    p.url().startsWith("http://localhost:7080/apps/holtburger-web/")
  );
  if (!page) page = await ctx.newPage();
  console.log(`page: ${page.url()}`);

  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.clearBrowserCache");
  console.log("cache cleared");
  await page.evaluate(async () => {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const r of regs) await r.unregister();
    }
    if ("caches" in window) {
      const keys = await caches.keys();
      for (const k of keys) await caches.delete(k);
    }
  });
  await page.goto(`${PAGE_URL}?v=${Date.now()}`, { waitUntil: "domcontentloaded" });

  await page.waitForFunction(
    () => {
      const r = document.getElementById("results");
      return r && /PASS/.test(r.innerHTML);
    },
    { timeout: 30_000 }
  );
  console.log("smoke PASS");

  // Login
  await page.fill('input[name="account"]', "tailnet1");
  await page.fill('input[name="password"]', "tailnet1");
  await page.fill('input[name="bridge_url"]', "ws://127.0.0.1:8080/");
  await page.fill('input[name="server_host"]', "127.0.0.1");
  await page.fill('input[name="server_port"]', "9000");
  await page.click("#login-form button[type=submit]", { noWaitAfter: true });
  try {
    await page.waitForSelector("#selection:not([hidden])", { timeout: 25_000 });
  } catch (_) {
    console.log("first login timed out, waiting 12s and retrying...");
    await sleep(12_000);
    await page.click("#login-form button[type=submit]", { noWaitAfter: true });
    await page.waitForSelector("#selection:not([hidden])", { timeout: 25_000 });
  }
  console.log("login OK");

  // Spawn
  const buttons = page.locator("#character-ul button[data-id]");
  await buttons.first().click();
  await page.waitForFunction(
    () => /InWorld|Spawned/.test(document.getElementById("login-status")?.innerText ?? ""),
    { timeout: 25_000 }
  );
  console.log("spawned");

  // Teleport to Holtburg.
  await page.evaluate(() => window.__sessionHandle.sendChat("@telepoi holtburg"));
  await sleep(4000);

  // Snapshot the bar.
  const barInfo = await page.evaluate(() => {
    const bar = document.querySelector(".hb-bar");
    const slots = Array.from(
      document.querySelectorAll(".hb-bar [data-plugin-id]")
    ).map((el) => ({
      id: el.dataset.pluginId,
      icon: el.textContent || el.getAttribute("aria-label"),
    }));
    return { barFound: !!bar, slots };
  });
  console.log("bar:", JSON.stringify(barInfo, null, 2));

  // Snapshot.
  const sp = "/mnt/wbterminal1/tmp/claude-scratch/k1/k1-merged-bar.png";
  await page.screenshot({ path: sp, fullPage: false });
  console.log(`screenshot: ${sp}`);

  await browser.close();
})();
