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
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const wh = await import("/apps/holtburger-web/rynth/webhost.js");
    const vt = await import("/apps/holtburger-web/rynth/vitals.js");
    const host = new wh.RynthWebHost(window.__sessionHandle, { noEventTap: true });
    // Stub a weak-heal livelock: HP stuck at 50% (not emergency, < topOff 95),
    // full stam/mana, magic mode, clear gates, cast is a no-op.
    let casts = 0;
    host.s.playerStats = () => ({ vitals: [1, 50, 100, 100, 3, 100, 100, 100, 5, 100, 100, 100] });
    host.GetCurrentCombatMode = () => 8;
    host.GetCastBusyState = () => 0;
    host.GetBusyState = () => 0;
    host.IsPlayerReady = () => true;
    host.CastSpell = () => { casts++; };
    const v = new vt.RynthVitals(host, { thresholds: { topOffHp: 95, topOffStam: 0, topOffMana: 0, healAtCombat: 0, getManaAtCombat: 0, restamAtCombat: 0 } });
    v._knownSet = new Set([6, 1177, 1664, 1676]);
    const trace = [];
    for (let i = 0; i < 10; i++) {
      const owned = v.step(false); // idle
      trace.push({ i, owned, parked: [...v.status.parked], casts });
      await sleep(450); // clear the 400ms cast-interval gate
    }
    return { trace, finalParked: v.status.parked, casts };
  });
  const parkedAt = r.trace.findIndex((t) => t.parked.includes("hp"));
  const lateReleased = r.trace.slice(parkedAt + 1).some((t) => t.owned === false);
  console.log(`casts=${r.casts} parkedAtStep=${parkedAt} finalParked=${JSON.stringify(r.finalParked)} yieldedAfterPark=${lateReleased}`);
  // Valve fires after ~6 casts (NO_PROGRESS_LIMIT), then step() yields (owned=false).
  const pass = parkedAt >= 5 && parkedAt <= 7 && r.finalParked.includes("hp") && lateReleased;
  console.log(`VITALS GIVE-UP VALVE: ${pass ? "PASS" : "FAIL"}`);
  await browser.close();
  process.exit(pass ? 0 : 1);
})().catch(async (e) => { console.error("ERR " + e.message); try { await browser.close(); } catch (_) {} process.exit(1); });
