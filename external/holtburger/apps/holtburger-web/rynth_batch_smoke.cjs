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
    await bl.loadSpellLadders();
    const host = new wh.RynthWebHost(window.__sessionHandle, { noEventTap: true });
    host.GetCurrentCombatMode = () => 8;
    host.GetCastBusyState = () => 0;
    host.GetBusyState = () => 0;
    host.IsPlayerReady = () => true;
    // Registry: buff A (spell 2, fam 1) EXPIRING (dur short); buff B (spell 6,
    // fam ?) FRESH (long). Mutable so a cast "lands" and re-reads fresh.
    const nowS = Date.now() / 1000;
    // Use categories from the ladder table for 2 and 6.
    const tab = await fetch("/apps/holtburger-web/rynth/spell_ladders.json").then(x=>x.json());
    const famA = tab["2"][0], famB = (tab["6"] && tab["6"][0]) || 999;
    const reg = [
      { spellId: 2, spellCategory: famA, startTime: nowS, duration: 100 },   // expiring (<300)
      { spellId: 6, spellCategory: famB, startTime: nowS, duration: 1700 },  // fresh (>300)
    ];
    host.s.playerEnchantments = () => reg.map(e => ({ spellId: e.spellId, spellCategory: e.spellCategory, startTime: e.startTime, duration: e.duration }));
    host.s.playerKnownSpells = () => new Uint32Array([2, 6]);
    const casts = [];
    host.CastSpell = (tgt, id) => {
      casts.push(id);
      // "land" it: refresh that entry to a full fresh duration.
      const e = reg.find(x => x.spellId === id);
      if (e) { e.startTime = Date.now() / 1000; e.duration = 1800; }
    };
    const loop = new bl.RynthBuffLoop(host, [2, 6], { noShowCooldownMs: 60000 });
    loop.registryReady = true; // skip B1 gate for the test
    loop._buildLadders();      // resolve ladders (2->best known, 6->best known)
    loop._refresh();
    // Drive several ticks past the confirm windows.
    for (let i = 0; i < 12; i++) { loop.tick(); await sleep(700); }
    return { casts, resolvedDesired: loop.desired, famA, famB, forcedFlag: loop._forceRebuffing };
  });
  console.log("BATCH: " + JSON.stringify(r));
  // B11/B12: BOTH buffs recast in the aligning pass (even the fresh one),
  // i.e. both resolved desired ids appear in the cast list.
  const d = r.resolvedDesired;
  const castedBoth = d.every(id => r.casts.includes(id));
  const pass = castedBoth && r.casts.length >= 2;
  console.log(`B10-B12 BATCH REBUFF: ${pass ? "PASS" : "FAIL"} (cast ${JSON.stringify(r.casts)}, desired ${JSON.stringify(d)})`);
  await browser.close();
  process.exit(pass ? 0 : 1);
})().catch(async (e) => { console.error("ERR " + e.message); try { await browser.close(); } catch (_) {} process.exit(1); });
