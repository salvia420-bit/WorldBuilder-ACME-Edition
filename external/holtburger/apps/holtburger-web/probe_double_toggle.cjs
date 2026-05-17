// Capture wasm console output across two toggle presses.
const { chromium } = require("playwright");
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
(async () => {
  const browser = await chromium.connectOverCDP(
    process.env.K1_CDP_URL || "http://127.0.0.1:9223"
  );
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) =>
    p.url().startsWith("http://localhost:7080/apps/holtburger-web/")
  );
  if (!page) throw new Error("no holtburger tab");
  page.on("console", (msg) => {
    const t = msg.text();
    if (/combat-mode|stance|CombatMode|Tester\./i.test(t)) {
      console.log(`[browser] ${t}`);
    }
  });

  const s0 = await page.evaluate(() => window.__getCurrentStanceLabel?.() ?? null);
  console.log(`\nstance state: ${s0}`);

  console.log("\nfirst toggle (Peace → Melee expected)");
  await page.evaluate(() => window.__pluginClient.player.toggleCombatMode());
  await sleep(2500);
  const s1 = await page.evaluate(() => window.__getCurrentStanceLabel?.() ?? null);
  console.log(`stance: ${s1}`);

  console.log("\nsecond toggle (Melee → Peace expected)");
  await page.evaluate(() => window.__pluginClient.player.toggleCombatMode());
  await sleep(2500);
  const s2 = await page.evaluate(() => window.__getCurrentStanceLabel?.() ?? null);
  console.log(`stance: ${s2}`);

  console.log("\nthird toggle (Peace → Melee expected)");
  await page.evaluate(() => window.__pluginClient.player.toggleCombatMode());
  await sleep(2500);
  const s3 = await page.evaluate(() => window.__getCurrentStanceLabel?.() ?? null);
  console.log(`stance: ${s3}`);
  await browser.close();
})();
