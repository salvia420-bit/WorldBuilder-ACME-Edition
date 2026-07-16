// Melee-mode kill path: unwield the wand so the suggested combat mode is
// Melee (HandCombat), then verify the combat loop's MeleeAttack branch
// lands melee damage on a drudge (the magic path is already verified).
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
  // Normalize position (drift) + full HP.
  await page.evaluate(() => { window.__sessionHandle.sendChat("@telepoi Holtburg"); });
  await sleep(7000);
  await page.evaluate(() => window.__sessionHandle.sendChat("@sethealth 65535"));
  await sleep(1500);

  const setup = await page.evaluate(async () => {
    const s = window.__sessionHandle;
    const guid = s.playerGuid();
    const wielded = (s.entityWieldedItems ? s.entityWieldedItems(guid) : []).map(w => ({ guid: w.guid, atk: w.attackType }));
    // Unwield everything wieldable (removes the wand -> suggested mode = Melee).
    for (const w of wielded) { if (s.unwieldToPack) s.unwieldToPack(w.guid); }
    return { wieldedCount: wielded.length, unwielded: wielded.map(w => w.guid) };
  });
  console.log(`unwielded ${setup.wieldedCount} items`);
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
  await sleep(500);
  await page.evaluate(() => window.__rh.WriteToChat("@create 7"));
  await sleep(3000);
  await page.evaluate(() => window.__cl.startOn(window.__rh));

  let mode = 0, meleeDamage = false, killed = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 90_000) {
    await sleep(3000);
    const st = await page.evaluate(() => {
      const cl = window.__cl;
      const chat = Array.from(document.querySelectorAll('#chat-log li')).slice(-8).map(li => li.textContent.trim());
      return { mode: window.__rh.GetCurrentCombatMode(), kills: cl.kills, chat };
    }).catch(() => null);
    if (!st) break;
    mode = st.mode;
    if (st.kills >= 1) killed = true;
    // Melee AttackerNotification: "You <verb> Drudge Skulker for N points"
    // in melee is distinct from the "with <spell>" magic line.
    if (st.chat.some(l => /You \w+ Drudge Skulker for \d+ points of damage/.test(l))) meleeDamage = true;
    if (killed || meleeDamage) break;
  }
  console.log(`mode=${mode} (2=Melee) meleeDamage=${meleeDamage} killed=${killed}`);
  await page.evaluate(() => { window.__cl.stop(); window.__rh.StopStick(); window.__rh.WriteToChat("@smite all"); }).catch(() => null);
  // RESTORE gear — re-wield everything wieldable so the character isn't left
  // naked for subsequent smokes (magic-mode smokes need the caster back).
  await sleep(1500);
  await page.evaluate(async () => {
    const s = window.__sessionHandle;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (const it of (s.playerInventory ? s.playerInventory() : [])) {
      const g = Number(it.guid ?? it.itemGuid ?? 0);
      if (!g) continue;
      let vl = 0; try { vl = s.objectIntProperty ? (s.objectIntProperty(g, 9) ?? 0) : 0; } catch (_) {}
      if (vl && s.wieldFromPack) { s.wieldFromPack(g, vl >>> 0); await sleep(350); }
    }
    await sleep(1500);
    window.__rh.stop();
  }).catch(() => null);
  // PASS: fought in melee mode (2) and either landed melee damage or killed.
  const pass = mode === 2 && (meleeDamage || killed);
  console.log(`MELEE-MODE KILL PATH: ${pass ? "PASS" : "FAIL"}`);
  await browser.close();
  process.exit(pass ? 0 : 1);
})().catch(async (e) => { console.error("ERR " + e.message); try { await browser.close(); } catch (_) {} process.exit(1); });
