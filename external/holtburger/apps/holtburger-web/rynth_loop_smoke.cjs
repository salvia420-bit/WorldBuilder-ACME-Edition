// Phase-2 autonomous combat-loop smoke: two drudges, zero per-step driving.
const { chromium } = require("playwright");
const { bootInWorld, sleep } = require("./rynth_boot_helper.cjs");
const URL = "http://127.0.0.1:8765/apps/holtburger-web/index.html?nosw=1&nullRender=1&netDrainHz=30&autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first";
let browser;
(async () => {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  const page = await bootInWorld(browser, URL);
  if (!page) { console.log("FAIL boot"); await browser.close(); process.exit(1); }
  page.on("console", (m) => { const t = m.text(); if (/^\[combat\]/.test(t)) console.log(t); });
  await sleep(3000);

  await page.evaluate(async () => {
    const wh = await import("/apps/holtburger-web/rynth/webhost.js");
    const cl = await import("/apps/holtburger-web/rynth/combat_loop.js");
    const host = new wh.RynthWebHost(window.__sessionHandle);
    host.nearbyRangeM = 60;
    window.__rh = host;
    window.__cl = new cl.RynthCombatLoop(host);
    host.start(10);
  });
  await sleep(1000);
  await page.evaluate(() => { window.__rh.WriteToChat("@create 7"); window.__rh.WriteToChat("@create 7"); });
  await sleep(6000);
  // Pre-check: is ItemType hydrated on a drudge?
  const pre = await page.evaluate(() => {
    const h = window.__rh;
    for (const g of h.NearbyGuids()) {
      const n = h.TryGetObjectName(g);
      if (n && /drudge/i.test(n)) return { guid: g, itemType: h.TryGetObjectIntProperty(g, 1), wcid: h.TryGetObjectWcid(g) };
    }
    return null;
  });
  console.log("drudge pre-check: " + JSON.stringify(pre));
  await page.evaluate(() => window.__cl.startOn(window.__rh));

  let kills = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 150_000) {
    await sleep(5000);
    kills = await page.evaluate(() => window.__cl.kills).catch(() => -1);
    const st = await page.evaluate(() => {
      const cl = window.__cl, h = window.__rh;
      const t = cl.locked;
      const hf = t ? h.TryGetTargetHealthFraction(t) : "-";
      const pos = t ? h.TryGetObjectPosition(t) : null;
      const me = h.TryGetPlayerPose();
      const d = pos && me ? Math.hypot(pos.x - me.x, pos.y - me.y).toFixed(1) : "-";
      return `${cl.state} tgt=${t ? t.toString(16) : "-"} hf=${hf} d=${d}`;
    }).catch(() => "?");
    console.log(`t+${((Date.now() - t0) / 1000).toFixed(0)}s kills=${kills} state=${st}`);
    // Test-harness privilege: refill vitals between fights so mana policy
    // (a later contract feature) doesn't gate the loop proof.

    if (kills >= 2) break;
  }
  const chat = await page.evaluate(() => Array.from(document.querySelectorAll('#chat-log li')).slice(-30).map((li) => li.textContent.trim())).catch(() => []);
  console.log('CHAT TAIL:\n  ' + chat.filter((l) => !/Zojak/.test(l)).join('\n  '));
  await page.evaluate(() => { window.__cl.stop(); window.__rh.WriteToChat("@smite all"); window.__rh.stop(); }).catch(() => null);
  console.log(`AUTONOMOUS COMBAT LOOP: ${kills >= 2 ? "PASS" : "FAIL/PARTIAL"} (kills=${kills})`);
  await browser.close();
  process.exit(kills >= 2 ? 0 : 1);
})().catch(async (e) => { console.error("ERR " + e.message); try { await browser.close(); } catch (_) {} process.exit(1); });
