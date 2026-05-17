// Cache-bust + nav to the full-fidelity URL; then disconnect so the
// user can drive the page themselves.
const { chromium } = require("playwright");
(async () => {
  const browser = await chromium.connectOverCDP(
    process.env.K1_CDP_URL || "http://127.0.0.1:9223"
  );
  const ctx = browser.contexts()[0];
  let page = ctx.pages().find((p) =>
    p.url().startsWith("http://localhost:7080/apps/holtburger-web/")
  );
  if (!page) page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.clearBrowserCache");
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
  const url =
    "http://localhost:7080/apps/holtburger-web/index.html" +
    `?renderer=3d&quality=ultra&clouds=on&atmosphere=on&v=${Date.now()}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  console.log(`page now at: ${url}`);
  await browser.close();
})();
