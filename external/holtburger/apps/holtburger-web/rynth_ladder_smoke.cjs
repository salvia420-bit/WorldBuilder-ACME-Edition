// B4/B5 tier-ladder smoke: give the buff loop Strength Self I (id 2); if the
// char knows a higher tier in family 1, the ladder upgrades to it.
const { chromium } = require("playwright");
const { bootInWorld, sleep } = require("./rynth_boot_helper.cjs");
const URL = "http://127.0.0.1:8765/apps/holtburger-web/index.html?nosw=1&nullRender=1&netDrainHz=30&autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first";
let browser;
(async () => {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  const page = await bootInWorld(browser, URL);
  if (!page) { console.log("FAIL boot"); await browser.close(); process.exit(1); }
  page.on("console", (m) => { const t = m.text(); if (/^\[buff\]/.test(t)) console.log(t); });
  await sleep(3000);
  const r = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const wh = await import("/apps/holtburger-web/rynth/webhost.js");
    const bl = await import("/apps/holtburger-web/rynth/buff_loop.js");
    await bl.loadSpellLadders(); // preload the table
    const host = new wh.RynthWebHost(window.__sessionHandle, { noEventTap: true });
    // Deterministic: inject a known-spell book with three Strength Self tiers
    // (I=2, IV=1330, VI=1332 — all category 1 per the table).
    host.s.playerKnownSpells = () => new Uint32Array([2, 1330, 1332, 6, 27]);
    // B4: raw desired Strength Self I -> should upgrade to the highest known (VI=1332).
    const loop = new bl.RynthBuffLoop(host, [2]);
    loop._buildLadders();
    const b4 = loop.desired[0];
    // B5: cap the achieved tier for family 1 at 4 -> must pick IV=1330, not VI.
    const loop2 = new bl.RynthBuffLoop(host, [2]);
    loop2._familyAchievedTier.set(1, 4);
    loop2._buildLadders();
    const b5 = loop2.desired[0];
    return { b4, b5, tableHas1332: (await fetch("/apps/holtburger-web/rynth/spell_ladders.json").then(r=>r.json()))["1332"] };
  });
  console.log("LADDER: " + JSON.stringify(r));
  // B4: Str Self I (2) upgrades to VI (1332). B5: with tier cap 4, picks IV (1330).
  const pass = r.b4 === 1332 && r.b5 === 1330;
  console.log(`B4 upgrade 2->${r.b4} (expect 1332) · B5 cap@4 2->${r.b5} (expect 1330)`);
  console.log(`B4/B5 TIER LADDER: ${pass ? "PASS" : "FAIL"}`);
  await browser.close();
  process.exit(pass ? 0 : 1);
})().catch(async (e) => { console.error("ERR " + e.message); try { await browser.close(); } catch (_) {} process.exit(1); });
