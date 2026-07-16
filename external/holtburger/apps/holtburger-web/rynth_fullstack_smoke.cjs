// Full-stack integration: createGrindBot -> kill + loot + buff + vitals +
// control, all through the single entrypoint, one run.
const { chromium } = require("playwright");
const { bootInWorld, sleep } = require("./rynth_boot_helper.cjs");
const URL = "http://127.0.0.1:8765/apps/holtburger-web/index.html?nosw=1&nullRender=1&netDrainHz=30&autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first";
let browser;
(async () => {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  const page = await bootInWorld(browser, URL);
  if (!page) { console.log("FAIL boot"); await browser.close(); process.exit(1); }
  page.on("console", (m) => { const t = m.text(); if (/^\[(kernel|combat|loot|buff|vitals|ctl)\]/.test(t)) console.log(t); });
  await sleep(3000);

  const caps = await page.evaluate(async () => {
    const m = await import("/apps/holtburger-web/rynth/bot.js");
    const known = Array.from(window.__sessionHandle.playerKnownSpells() || []).map(Number);
    const buffs = [2, 24, 1349, 1421].filter((id) => known.includes(id));
    const bot = await m.createGrindBot(window.__sessionHandle, {
      buffs, priorities: { skulker: 5 }, loot: { minValue: 0 },
      vitals: { healAtCombat: 0, getManaAtCombat: 0, restamAtCombat: 0, topOffHp: 0, topOffStam: 0, topOffMana: 0, emergencyHp: 0 },
      control: { prefix: "!bot" }, hz: 10,
    });
    window.__bot = bot;
    return { capCount: bot.capabilities().length, buffs };
  });
  console.log(`bot up: ${caps.capCount} capabilities, buffs=${JSON.stringify(caps.buffs)}`);
  // Start healthy (a prior smoke may have persisted low HP) — @heal self.
  await page.evaluate(() => window.__bot.host.WriteToChat("@sethealth 65535"));
  await sleep(2500);
  await page.evaluate(() => { window.__bot.host.WriteToChat("@create 7"); window.__bot.host.WriteToChat("@create 7"); });

  // Watch the integrated grind: 2 kills + loot + buffs.
  let st = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 150_000) {
    await sleep(5000);
    st = await page.evaluate(() => window.__bot.status()).catch(() => null);
    console.log(`t+${((Date.now() - t0) / 1000).toFixed(0)}s ${JSON.stringify(st)}`);
    if (st && st.kills >= 2 && st.looted >= 1 && st.buffs && st.buffs.active === st.buffs.desired) break;
  }
  const grindPass = st && st.kills >= 2 && st.looted >= 1 && st.buffs && st.buffs.active === st.buffs.desired;

  // Control channel through the real event tap.
  const ctl = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__rynthOnEvent({ kind: 2, stringPayload: 'Owner tells you, "!bot pause"' });
    await sleep(500);
    const paused = window.__bot.kernel.action;
    const wasPaused = !window.__bot.kernel._running;
    window.__rynthOnEvent({ kind: 2, stringPayload: 'Owner tells you, "!bot resume"' });
    await sleep(500);
    return { wasPaused, resumed: window.__bot.kernel._running };
  });
  console.log(`control: ${JSON.stringify(ctl)}`);

  // Wiring assertion: the entrypoint instantiated every module and status
  // aggregates them. (Vital FIRING is proven in rynth_vitals_smoke.cjs.)
  const wiring = await page.evaluate(() => ({
    combat: !!window.__bot.combat, buff: !!window.__bot.buff, loot: !!window.__bot.loot,
    vitals: !!window.__bot.vitals, channel: !!window.__bot.channel,
    statusHasVitals: window.__bot.status().vitals !== undefined,
  }));
  console.log(`wiring: ${JSON.stringify(wiring)}`);
  const vitalsFired = wiring.combat && wiring.buff && wiring.loot && wiring.vitals && wiring.channel && wiring.statusHasVitals;

  await page.evaluate(() => { window.__bot.host.WriteToChat("@sethealth 65535"); window.__bot.host.WriteToChat("@smite all"); window.__bot.stop(); }).catch(() => null);
  await sleep(1500);
  const ctlPass = ctl.wasPaused && ctl.resumed;
  const pass = grindPass && ctlPass && vitalsFired && caps.capCount >= 40;
  console.log(`FULL-STACK: grind=${grindPass ? "PASS" : "FAIL"} control=${ctlPass ? "PASS" : "FAIL"} wiring=${vitalsFired ? "PASS" : "FAIL"} -> ${pass ? "PASS" : "FAIL"}`);
  await browser.close();
  process.exit(pass ? 0 : 1);
})().catch(async (e) => { console.error("ERR " + e.message); try { await browser.close(); } catch (_) {} process.exit(1); });
