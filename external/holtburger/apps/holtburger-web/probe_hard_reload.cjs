// Force a no-cache reload — bypasses Chrome's HTTP cache so the new
// pkg/holtburger_web_bg.wasm is fetched, not the in-memory copy.
const { chromium } = require("playwright");
(async () => {
  const browser = await chromium.connectOverCDP(
    process.env.K1_CDP_URL || "http://127.0.0.1:9223"
  );
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) =>
    p.url().startsWith("http://localhost:7080/apps/holtburger-web/")
  );
  if (!page) throw new Error("no holtburger tab");
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.clearBrowserCache");
  await cdp.send("Network.clearBrowserCookies");
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
  // Reload with cache bypass.
  await cdp.send("Page.reload", { ignoreCache: true });
  console.log("reloaded with ignoreCache=true");
  await browser.close();
})();
