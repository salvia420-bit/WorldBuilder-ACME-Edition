const { chromium } = require("playwright");
const { bootInWorld, sleep } = require("./rynth_boot_helper.cjs");
const URL = "http://127.0.0.1:8765/apps/holtburger-web/index.html?nosw=1&nullRender=1&netDrainHz=30&autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first";
let browser;
(async () => {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  const page = await bootInWorld(browser, URL);
  if (!page) { console.log("FAIL boot"); await browser.close(); process.exit(1); }
  page.on("console", (m) => { const t = m.text(); if (/^\[vitals\]|^\[kernel\]/.test(t)) console.log(t); });
  await sleep(3000);

  // (1) Deterministic B15/B16 threshold-matrix test through the seam.
  const matrix = await page.evaluate(async () => {
    const wh = await import("/apps/holtburger-web/rynth/webhost.js");
    const vt = await import("/apps/holtburger-web/rynth/vitals.js");
    const host = new wh.RynthWebHost(window.__sessionHandle, { noEventTap: true });
    const v = new vt.RynthVitals(host);
    v._knownSet = new Set([6, 1177, 1664, 1676]); // pretend all recovery spells known
    const D = (f, inCombat) => { const a = v._decide(f, inCombat); return a ? a.reason.split(" ")[0] : null; };
    return {
      emergency: D({ hp: 25, stam: 50, mana: 80 }, false),        // B15 -> EMERGENCY
      emergencyNoStam: D({ hp: 25, stam: 10, mana: 80 }, false),  // no stam headroom -> heal (idle topOff 95)
      combatHeal: D({ hp: 55, stam: 90, mana: 90 }, true),         // <60 combat -> heal
      idleNoHeal: D({ hp: 55, stam: 90, mana: 90 }, false),        // idle topOff 95: 55<95 -> heal
      combatStam: D({ hp: 90, stam: 25, mana: 90 }, true),         // <30 combat -> restam
      combatMana: D({ hp: 90, stam: 90, mana: 35 }, true),         // <40 combat, stam>15 -> getmana
      idleTopOff: D({ hp: 96, stam: 96, mana: 96 }, false),        // all >95 idle -> null
      // Mana floor is only reachable when restam is off (else stam<30 -> restam first).
      manaFloorBlock: (() => { const old = v.cfg.restamAtCombat; v.cfg.restamAtCombat = 0;
        const r = D({ hp: 90, stam: 12, mana: 35 }, true); v.cfg.restamAtCombat = old; return r; })(), // stam12<15 floor -> null
      allFull: D({ hp: 100, stam: 100, mana: 100 }, true),         // nothing
    };
  });
  console.log("MATRIX: " + JSON.stringify(matrix));
  const mPass =
    matrix.emergency === "EMERGENCY" && matrix.combatHeal === "heal" &&
    matrix.idleNoHeal === "heal" && matrix.combatStam === "restam" &&
    matrix.combatMana === "getmana" && matrix.idleTopOff === null &&
    matrix.manaFloorBlock === null && matrix.allFull === null;

  // (2) Live: install the kernel with vitals, @sethealth low, watch a heal fire.
  await page.evaluate(async () => {
    const wh = await import("/apps/holtburger-web/rynth/webhost.js");
    const cl = await import("/apps/holtburger-web/rynth/combat_loop.js");
    const vt = await import("/apps/holtburger-web/rynth/vitals.js");
    const kn = await import("/apps/holtburger-web/rynth/kernel.js");
    const host = new wh.RynthWebHost(window.__sessionHandle);
    host.nearbyRangeM = 60;
    window.__rh = host;
    window.__kn = new kn.RynthBotKernel(host, {
      combat: new cl.RynthCombatLoop(host),
      vitals: new vt.RynthVitals(host, { thresholds: { healAtCombat: 60, topOffHp: 95 } }),
    });
    host.start(10);
    window.__kn.start();
  });
  await sleep(1000);
  const known = await page.evaluate(() => Array.from(window.__sessionHandle.playerKnownSpells() || []).map(Number).includes(6));
  console.log(`knows Heal Self I (spell 6): ${known}`);
  await page.evaluate(() => window.__rh.WriteToChat("@sethealth 5"));
  let healed = false, hpTrace = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 40_000) {
    await sleep(2500);
    const s = await page.evaluate(() => window.__kn.status.vitals).catch(() => null);
    if (s) { hpTrace.push(Math.round(s.hp)); if (s.actions >= 1) healed = true; }
    if (healed) break;
  }
  console.log(`hp trace: ${JSON.stringify(hpTrace)} healActions=${healed}`);
  await page.evaluate(() => { window.__rh.WriteToChat("@sethealth 65535"); window.__kn.stop(); window.__rh.stop(); }).catch(() => null); await sleep(1500);
  const livePass = known ? healed : true; // if char can't heal, live test is N/A
  console.log(`B15/B16 MATRIX: ${mPass ? "PASS" : "FAIL"} · LIVE HEAL: ${known ? (healed ? "PASS" : "FAIL") : "N/A (no Heal Self)"}`);
  await browser.close();
  process.exit(mPass && livePass ? 0 : 1);
})().catch(async (e) => { console.error("ERR " + e.message); try { await browser.close(); } catch (_) {} process.exit(1); });
