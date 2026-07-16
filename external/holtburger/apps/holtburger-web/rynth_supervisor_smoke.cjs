// Supervisor smoke: boot 1 supervised bot, force a stalled snapshot
// (kill the worker tick), verify the supervisor detects it and rebuilds.
const path = require("path");
const sup = require(path.join(
  "/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/rynth/supervisor.cjs"
));
const { chromium } = require("playwright");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  const cfg = { account: "tailnet1", password: "tailnet1", buffs: [2, 24] };
  const log = (m) => console.log(`[sup] ${m}`);

  let page = await sup.bootBot(browser, cfg, log);
  if (!page) { console.log("FAIL: initial boot"); await browser.close(); process.exit(1); }
  await sleep(4000);
  const h1 = await sup.health(page);
  console.log(`health#1: alive=${h1.alive} snapAge=${h1.snapAge} action=${h1.status && h1.status.action}`);

  // Force the failure the supervisor guards: stop the tick -> snapshot
  // freezes. Real disconnects manifest the same way (no fresh snapshot).
  await page.evaluate(() => window.__rh.stop());
  console.log("killed tick — snapshot will go stale");
  await sleep(9000);
  const h2 = await sup.health(page);
  const detected = !h2.alive || h2.snapAge > 8000;
  console.log(`health#2: snapAge=${h2.snapAge} -> ${detected ? "STALE (detected)" : "still fresh?!"}`);

  // Supervisor rebuild.
  if (detected) {
    await page.close().catch(() => null);
    page = await sup.bootBot(browser, cfg, log);
  }
  await sleep(4000);
  const h3 = page ? await sup.health(page) : { alive: false, snapAge: Infinity };
  console.log(`health#3 (post-rebuild): alive=${h3.alive} snapAge=${h3.snapAge} action=${h3.status && h3.status.action}`);

  const pass = h1.alive && detected && h3.alive && h3.snapAge < 8000;
  console.log(`SUPERVISOR: ${pass ? "PASS" : "FAIL"} (boot -> stall-detect -> auto-relogin recovered)`);
  if (page) await page.evaluate(() => { try { window.__kn.stop(); window.__rh.stop(); } catch (_) {} }).catch(() => null);
  await browser.close();
  process.exit(pass ? 0 : 1);
})().catch(async (e) => { console.error("ERR " + e.message); process.exit(1); });
