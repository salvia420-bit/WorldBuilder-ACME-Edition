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
  // Heal the character's server-side physics first: the saved position
  // carries a corrupted Z (94.005 vs ground 94) that wedges the motion
  // pipeline every login (stance swaps + swings never complete). An
  // explicit teleport resets physics and rewrites clean coords.
  await page.evaluate(() => window.__rh.WriteToChat("@teleloc 0xA9B40019 84.0 15.0 94.05"));
  await sleep(6000);
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

  // ACE silently reverts Melee if a bow/wand is wielded (Player_Combat.cs
  // _Inner Melee case) — use the suggested-mode toggle (equipment-derived,
  // always accepted) and fight in whatever mode results.
  await page.evaluate(() => window.__sessionHandle.toggleCombatMode());
  let cm = 1;
  for (let i = 0; i < 16; i++) { await sleep(500); cm = await page.evaluate(() => window.__rh.GetCurrentCombatMode()); if (cm > 1) break; }
  console.log(`combatMode after toggle: ${cm}`);

  await page.evaluate((g) => window.__rh.StickToObject(g), drudge);
  await sleep(4000); // let the stick close the 5m gap before the first swing
  let killed = false, lastHealth = -1, swings = 0;
  const t0 = Date.now();
  let lastSwingAt = 0;
  while (Date.now() - t0 < 90_000) {
    // Report-11 pacing: one attack in flight at a time; re-issue only
    // after a patience window (melee completion has no UseDone).
    if (Date.now() - lastSwingAt > 9_000) {
      await page.evaluate(async (arg) => {
        const [g, mode] = arg;
        const s = window.__sessionHandle;
        if (mode === 2) return window.__rh.MeleeAttack(g, 2, 0.6);
        if (mode === 4 && s.missileAttack) return s.missileAttack(g, 2, 0.6);
        if (mode === 8) {
          const known = s.playerKnownSpells ? Array.from(s.playerKnownSpells() || []).map(Number) : [];
          // Prefer a level-1 war bolt (27 Flame, 28 Frost, 58 Acid, 64 Shock,
          // 75 Lightning, 86 Force, 92 Whirling Blade); else first known.
          const war = [27, 28, 58, 64, 75, 86, 92].find((id) => known.includes(id));
          if (!window.__warPicked) { window.__warPicked = true; console.log(`known spells: ${known.slice(0, 20).join(",")} -> war=${war}`); }
          if (war) return window.__rh.CastSpell(g, war);
          if (known.length) return window.__rh.CastSpell(g, known[0]);
        }
        return window.__rh.MeleeAttack(g, 2, 0.6);
      }, [drudge, cm]).catch(() => null);
      swings++;
      lastSwingAt = Date.now();
    }
    await page.evaluate((g) => window.__rh.QueryHealth(g), drudge).catch(() => null);
    await sleep(1500);
    const s = await page.evaluate((g) => { const h = window.__rh; const p = h.TryGetObjectPosition(g); const me = h.TryGetPlayerPose(); const d = p && me ? Math.hypot(p.x - me.x, p.y - me.y).toFixed(2) : null; return { pos: p, hf: h.TryGetTargetHealthFraction(g), dist: d }; }, drudge).catch(() => null);
    if (!s) { console.log("eval failed mid-fight"); break; }
    if (s.hf >= 0) lastHealth = s.hf;
    console.log(`t+${((Date.now()-t0)/1000).toFixed(0)}s swings=${swings}: hf=${s.hf} dist=${s.dist} pos=${s.pos ? "yes" : "GONE"}`);
    if (!s.pos || s.hf === 0) { killed = true; break; }
  }
  await page.evaluate(() => { const h = window.__rh; h.StopStick(); h.ChangeCombatMode(1); h.WriteToChat("@smite all"); h.stop(); }).catch(() => null);
  const chat = await page.evaluate(() => Array.from(document.querySelectorAll('#chat-log li')).slice(-15).map((li) => li.textContent.trim())).catch(() => []);
  console.log('CHAT TAIL:\n  ' + chat.join('\n  '));
  console.log(`RESULT: swings=${swings} lastHealth=${lastHealth} killed=${killed}`);
  const pass = cm > 1 && (killed || (lastHealth >= 0 && lastHealth < 1));
  console.log(`COMBAT SMOKE: ${pass ? "PASS" : "FAIL/PARTIAL"}`);
  await browser.close();
  process.exit(pass ? 0 : 1);
})().catch(async (e) => { console.error("ERR " + e.message); try { await browser.close(); } catch (_) {} process.exit(1); });
