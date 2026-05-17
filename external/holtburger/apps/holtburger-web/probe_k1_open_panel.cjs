// Open the Combat panel + snapshot the merged UI.
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
  await page.click('.hb-bar [data-plugin-id="combat-bar"]');
  await new Promise((r) => setTimeout(r, 600));
  const sp = "/mnt/wbterminal1/tmp/claude-scratch/k1/k1-merged-panel.png";
  await page.screenshot({ path: sp, fullPage: false });
  console.log(`screenshot: ${sp}`);
  await browser.close();
})();
