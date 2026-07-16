// Phase-3 loot smoke: combat loop kills a drudge, loot loop takes the corpse.
const { chromium } = require("playwright");
const { bootInWorld, sleep } = require("./rynth_boot_helper.cjs");
const URL = "http://127.0.0.1:8765/apps/holtburger-web/index.html?nosw=1&nullRender=1&netDrainHz=30&autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first";
let browser;
(async () => {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  const page = await bootInWorld(browser, URL);
  if (!page) { console.log("FAIL boot"); await browser.close(); process.exit(1); }
  page.on("console", (m) => { const t = m.text(); if (/^\[(combat|loot)\]/.test(t)) console.log(t); });
  await sleep(3000);

  await page.evaluate(async () => {
    const wh = await import("/apps/holtburger-web/rynth/webhost.js");
    const cl = await import("/apps/holtburger-web/rynth/combat_loop.js");
    const ll = await import("/apps/holtburger-web/rynth/loot_loop.js");
    const host = new wh.RynthWebHost(window.__sessionHandle);
    host.nearbyRangeM = 60;
    window.__rh = host;
    window.__cl = new cl.RynthCombatLoop(host);
    window.__ll = new ll.RynthLootLoop(host);
    host.start(10);
  });
  await sleep(1000);
  const invBefore = await page.evaluate(() => (window.__sessionHandle.playerInventory() || []).length);
  await page.evaluate(() => { window.__rh.WriteToChat("@create 7"); window.__cl.startOn(window.__rh); });

  // Phase A: one kill.
  let kills = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 90_000 && kills < 1) {
    await sleep(3000);
    kills = await page.evaluate(() => window.__cl.kills).catch(() => 0);
  }
  console.log(`kills=${kills}`);
  if (!kills) { console.log("FAIL: no kill to loot"); await browser.close(); process.exit(1); }
  await page.evaluate(() => { window.__cl.stop(); window.__rh.StopStick(); });
  await sleep(2000);

  // Phase B: loot the corpse.
  await page.evaluate(() => window.__ll.startOn(window.__rh));
  let looted = 0, empty = 0;
  const t1 = Date.now();
  while (Date.now() - t1 < 60_000) {
    await sleep(3000);
    ({ looted, empty } = await page.evaluate(() => ({ looted: window.__ll.lootedCount, empty: window.__ll.emptyCorpses })).catch(() => ({ looted: 0, empty: 0 })));
    if (looted >= 1 || empty >= 1) break;
  }
  const invAfter = await page.evaluate(() => (window.__sessionHandle.playerInventory() || []).length);
  console.log(`RESULT: looted=${looted} emptyCorpses=${empty} inventory ${invBefore} -> ${invAfter}`);
  const pass = looted >= 1 && invAfter > invBefore;
  const partial = empty >= 1 && looted === 0;
  console.log(`LOOT LOOP: ${pass ? "PASS" : partial ? "PARTIAL (corpse empty — flow OK)" : "FAIL"}`);
  await page.evaluate(() => { window.__ll.stop(); window.__rh.WriteToChat("@smite all"); window.__rh.stop(); }).catch(() => null);
  await browser.close();
  process.exit(pass || partial ? 0 : 1);
})().catch(async (e) => { console.error("ERR " + e.message); try { await browser.close(); } catch (_) {} process.exit(1); });
