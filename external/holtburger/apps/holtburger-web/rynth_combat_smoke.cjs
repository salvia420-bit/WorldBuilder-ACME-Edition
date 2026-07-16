// Seam-driven combat proof, step-split for crash isolation.
const { chromium } = require("playwright");
const { bootInWorld, sleep } = require("./rynth_boot_helper.cjs");
const URL = "http://127.0.0.1:8765/apps/holtburger-web/index.html?nosw=1&nullRender=1&netDrainHz=30&autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first";
let browser;
(async () => {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  const page = await bootInWorld(browser, URL);
  if (!page) { console.log("FAIL boot"); await browser.close(); process.exit(1); }
  page.on("console", (m) => { const t = m.text(); if (/error|crash|oom/i.test(t)) console.log(`[con] ${t.slice(0, 150)}`); });
  await sleep(3000);

  await page.evaluate(async () => {
    const mod = await import("/apps/holtburger-web/rynth/webhost.js");
    const host = new mod.RynthWebHost(window.__sessionHandle);
    host.nearbyRangeM = 60;
    host.start(10);
    window.__rh = host;
  });
  await sleep(1000);
  const before = await page.evaluate(() => window.__rh.NearbyGuids());
  console.log(`before: ${before.length} nearby`);

  await page.evaluate(() => window.__rh.WriteToChat("@create 7"));
  console.log("sent @create 7");
  let drudge = 0;
  for (let i = 0; i < 20 && !drudge; i++) {
    await sleep(1500);
    drudge = await page.evaluate((prev) => {
      const host = window.__rh;
      for (const g of host.NearbyGuids()) {
        if (prev.includes(g)) continue;
        const name = host.TryGetObjectName(g);
        if (name && /drudge/i.test(name)) return g;
      }
      return 0;
    }, before).catch((e) => { console.log(`poll ${i} err: ${e.message.slice(0, 60)}`); return 0; });
  }
  if (!drudge) { console.log("FAIL: no drudge"); await browser.close(); process.exit(1); }
  const meta = await page.evaluate((g) => ({ name: window.__rh.TryGetObjectName(g), wcid: window.__rh.TryGetObjectWcid(g) }), drudge);
  console.log(`drudge: ${drudge} ${JSON.stringify(meta)}`);

  await page.evaluate(() => window.__rh.ChangeCombatMode(2));
  let cm = 0;
  for (let i = 0; i < 10; i++) { await sleep(500); cm = await page.evaluate(() => window.__rh.GetCurrentCombatMode()); if (cm === 2) break; }
  console.log(`combatMode: ${cm}`);

  await page.evaluate((g) => window.__rh.StickToObject(g), drudge);
  let killed = false, lastHealth = -1, swings = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 60_000) {
    await page.evaluate((g) => window.__rh.MeleeAttack(g, 2, 0.6), drudge).catch(() => null);
    swings++;
    await sleep(2500);
    const s = await page.evaluate((g) => ({ pos: window.__rh.TryGetObjectPosition(g), hf: window.__rh.TryGetTargetHealthFraction(g) }), drudge).catch(() => null);
    if (!s) { console.log("eval failed mid-fight"); break; }
    if (s.hf >= 0) lastHealth = s.hf;
    console.log(`swing ${swings}: hf=${s.hf} pos=${s.pos ? "yes" : "GONE"}`);
    if (!s.pos || s.hf === 0) { killed = true; break; }
  }
  await page.evaluate(() => { const h = window.__rh; h.StopStick(); h.ChangeCombatMode(1); h.WriteToChat("@smite all"); h.stop(); }).catch(() => null);
  console.log(`RESULT: swings=${swings} lastHealth=${lastHealth} killed=${killed}`);
  const pass = cm === 2 && (killed || (lastHealth >= 0 && lastHealth < 1));
  console.log(`COMBAT SMOKE: ${pass ? "PASS" : "FAIL/PARTIAL"}`);
  await browser.close();
  process.exit(pass ? 0 : 1);
})().catch(async (e) => { console.error("ERR " + e.message); try { await browser.close(); } catch (_) {} process.exit(1); });
