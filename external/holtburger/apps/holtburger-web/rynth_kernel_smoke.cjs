// The grind-bot proof: kernel orchestrates combat -> loot -> buffs, unattended.
const { chromium } = require("playwright");
const { bootInWorld, sleep } = require("./rynth_boot_helper.cjs");
const URL = "http://127.0.0.1:8765/apps/holtburger-web/index.html?nosw=1&nullRender=1&netDrainHz=30&autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first";
let browser;
(async () => {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  const page = await bootInWorld(browser, URL);
  if (!page) { console.log("FAIL boot"); await browser.close(); process.exit(1); }
  page.on("console", (m) => { const t = m.text(); if (/^\[(kernel|combat|loot|buff)\]/.test(t)) console.log(t); });
  await sleep(3000);

  await page.evaluate(async () => {
    const wh = await import("/apps/holtburger-web/rynth/webhost.js");
    const cl = await import("/apps/holtburger-web/rynth/combat_loop.js");
    const bl = await import("/apps/holtburger-web/rynth/buff_loop.js");
    const ll = await import("/apps/holtburger-web/rynth/loot_loop.js");
    const kn = await import("/apps/holtburger-web/rynth/kernel.js");
    const host = new wh.RynthWebHost(window.__sessionHandle);
    host.nearbyRangeM = 60;
    const known = Array.from(window.__sessionHandle.playerKnownSpells() || []).map(Number);
    const buffs = [2, 24, 1349, 1421].filter((id) => known.includes(id));
    window.__rh = host;
    window.__kn = new kn.RynthBotKernel(host, {
      combat: new cl.RynthCombatLoop(host),
      buff: new bl.RynthBuffLoop(host, buffs),
      loot: new ll.RynthLootLoop(host),
    });
    host.start(10);
    window.__kn.start();
  });
  await sleep(2000);
  await page.evaluate(() => { window.__rh.WriteToChat("@create 7"); window.__rh.WriteToChat("@create 7"); });

  let st = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 180_000) {
    await sleep(5000);
    st = await page.evaluate(() => {
      const k = window.__kn.status;
      const h = window.__rh;
      let corpses = 0, sample = "";
      for (const g of h.NearbyGuids()) {
        if (h.TryGetObjectWcid(g) === 21) { corpses++; if (!sample) sample = g.toString(16); }
      }
      k.corpsesSeen = corpses; k.corpseSample = sample;
      return k;
    }).catch(() => null);
    console.log(`t+${((Date.now() - t0) / 1000).toFixed(0)}s ${JSON.stringify(st)}`);
    if (st && st.kills >= 2 && st.looted >= 1 && st.action === "Idle" && st.buffs && st.buffs.active === st.buffs.desired) break;
  }
  const pass = st && st.kills >= 2 && st.looted >= 1 && st.buffs && st.buffs.active === st.buffs.desired;
  console.log(`GRIND BOT (kernel): ${pass ? "PASS" : "FAIL/PARTIAL"}`);
  await page.evaluate(() => { window.__kn.stop(); window.__rh.WriteToChat("@smite all"); window.__rh.stop(); }).catch(() => null);
  await browser.close();
  process.exit(pass ? 0 : 1);
})().catch(async (e) => { console.error("ERR " + e.message); try { await browser.close(); } catch (_) {} process.exit(1); });
