const { chromium } = require("playwright");
const { bootInWorld, sleep } = require("./rynth_boot_helper.cjs");
const URL = "http://127.0.0.1:8765/apps/holtburger-web/index.html?nosw=1&nullRender=1&netDrainHz=30&autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first";
let browser;
(async () => {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  const page = await bootInWorld(browser, URL);
  if (!page) { console.log("FAIL boot"); await browser.close(); process.exit(1); }
  await sleep(3000);
  const r = await page.evaluate(async () => {
    const wh = await import("/apps/holtburger-web/rynth/webhost.js");
    const cl = await import("/apps/holtburger-web/rynth/combat_loop.js");
    const host = new wh.RynthWebHost(window.__sessionHandle);
    const loop = new cl.RynthCombatLoop(host, { priorities: { olthoi: 20, rat: 5 } });

    // T8: verify the formula at two priorities via name-stubbed lookups.
    host.TryGetObjectName = (g) => (g === 1 ? "Olthoi Warrior" : g === 2 ? "Big Rat" : "Cow");
    const t8olthoi = loop._priorityTerm(1);  // (20-1)*5 = 95
    const t8rat = loop._priorityTerm(2);     // (5-1)*5 = 20
    const t8cow = loop._priorityTerm(3);     // 0

    // P12: controlled fight. Lock a synthetic target; stub its live health
    // fraction low; feed 3 melee damageDealt events (dmg 10, severity 0.1
    // => learned MaxHP 100, avg dmg 10). remHP = 0.05*100 = 5 <= 10*0.8=8
    // => predict kill.
    loop.locked = 0xABCD;
    host.TryGetTargetHealthFraction = () => 0.05;
    loop.startOn(host); // subscribes _onCombatEvent to the real tap
    for (let i = 0; i < 3; i++) {
      window.__rynthOnEvent({
        kind: 19,
        stringPayload: JSON.stringify({ type: "damageDealt", defenderName: "T", damage: 10, severity: 0.1 }),
        u32Payload: 0, u32Payload2: 0,
      });
    }
    await new Promise((r) => setTimeout(r, 100));
    const m = loop.damageModel.get(0xABCD);
    const predicted = loop._predictKill();
    loop.stop();
    return { t8olthoi, t8rat, t8cow, model: m, predicted, lifetimeHits: loop.lifetimeHits, lifetimeMaxHp: loop.lifetimeMaxHpLearned };
  });
  console.log("P12/T8: " + JSON.stringify(r));
  const t8pass = r.t8olthoi === 95 && r.t8rat === 20 && r.t8cow === 0;
  const p12pass = r.model && r.model.hits === 3 && r.model.maxHp === 100 && r.predicted === true && r.lifetimeHits === 3;
  console.log(`T8 PRIORITY: ${t8pass ? "PASS" : "FAIL"} · P12 LEARN+PREDICT: ${p12pass ? "PASS" : "FAIL"}`);
  await browser.close();
  process.exit(t8pass && p12pass ? 0 : 1);
})().catch(async (e) => { console.error("ERR " + e.message); try { await browser.close(); } catch (_) {} process.exit(1); });
