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
    // NOTE: keep the event tap ON so the real page->onEvent path is exercised.
    const host = new wh.RynthWebHost(window.__sessionHandle);
    host.GetCurrentCombatMode = () => 8;
    host.GetCastBusyState = () => 0;
    host.GetBusyState = () => 0;
    host.IsPlayerReady = () => true;
    host.s.playerEnchantments = () => [];        // no self buffs
    host.s.playerKnownSpells = () => new Uint32Array([1749]);
    const casts = [];
    host.CastSpell = (tgt, id) => casts.push([tgt, id]);
    const loop = new bl.RynthBuffLoop(host, [], { itemBuffs: [{ spellId: 1749, itemGuid: 0x1234 }], itemRecastMs: 1000 });
    loop.registryReady = true;
    loop.startOn(host); // subscribes _onChat to the real tap
    host.start(10);
    await sleep(1200);  // let a tick cast the item buff
    const afterCast = { casts: casts.slice(), itemPending: loop.status.itemPending };
    // A SELF-form line must NOT confirm (no-optimistic / wrong shape).
    window.__rynthOnEvent({ kind: 2, stringPayload: "You cast Impenetrability VI and gain nothing" });
    await sleep(200);
    const afterSelfLine = { itemConfirmed: loop.status.itemConfirmed, itemPending: loop.status.itemPending };
    // The "on <item>" form confirms.
    window.__rynthOnEvent({ kind: 2, stringPayload: "You cast Impenetrability VI on Sword of Lost Light" });
    await sleep(200);
    const afterOnLine = { itemConfirmed: loop.status.itemConfirmed, itemPending: loop.status.itemPending };
    loop.stop(); host.stop();
    return { afterCast, afterSelfLine, afterOnLine };
  });
  console.log("ITEM: " + JSON.stringify(r));
  const pass =
    r.afterCast.casts.length >= 1 && r.afterCast.casts[0][0] === 0x1234 && r.afterCast.itemPending === 1749 &&
    r.afterSelfLine.itemConfirmed === 0 && r.afterSelfLine.itemPending === 1749 &&   // self-form ignored
    r.afterOnLine.itemConfirmed === 1 && r.afterOnLine.itemPending === 0;            // on-form confirms
  console.log(`B7 ITEM ENCHANT: ${pass ? "PASS" : "FAIL"}`);
  await browser.close();
  process.exit(pass ? 0 : 1);
})().catch(async (e) => { console.error("ERR " + e.message); try { await browser.close(); } catch (_) {} process.exit(1); });
