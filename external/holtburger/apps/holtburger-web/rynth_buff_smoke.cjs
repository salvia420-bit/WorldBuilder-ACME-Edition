// Phase-3 buff-loop smoke: maintain level-1 self-buffs autonomously.
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

  const desired = await page.evaluate(async () => {
    const wh = await import("/apps/holtburger-web/rynth/webhost.js");
    const bl = await import("/apps/holtburger-web/rynth/buff_loop.js");
    const host = new wh.RynthWebHost(window.__sessionHandle);
    window.__rh = host;
    const known = Array.from(window.__sessionHandle.playerKnownSpells() || []).map(Number);
    const want = [2, 24, 1349, 1421].filter((id) => known.includes(id)); // Str/Armor/End/Focus Self I
    window.__bl = new bl.RynthBuffLoop(host, want);
    host.start(10);
    window.__bl.startOn(host);
    return want;
  });
  console.log(`desired buffs (known-filtered): ${JSON.stringify(desired)}`);
  if (desired.length < 2) { console.log("FAIL: char knows <2 of the test buffs"); await browser.close(); process.exit(1); }

  let st = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 90_000) {
    await sleep(4000);
    st = await page.evaluate(() => window.__bl.status).catch(() => null);
    console.log(`t+${((Date.now() - t0) / 1000).toFixed(0)}s ${JSON.stringify(st)}`);
    if (st && st.active === st.desired) break;
  }
  const reg = await page.evaluate(() =>
    (window.__sessionHandle.playerEnchantments() || []).map((e) => `${e.spellId}/cat${e.spellCategory}/${Math.round(e.duration)}s`)
  ).catch(() => []);
  console.log(`registry: ${JSON.stringify(reg)}`);
  const pass = st && st.desired >= 2 && st.active === st.desired;
  console.log(`BUFF LOOP: ${pass ? "PASS" : "FAIL/PARTIAL"}`);
  await page.evaluate(() => { window.__bl.stop(); window.__rh.stop(); }).catch(() => null);
  await browser.close();
  process.exit(pass ? 0 : 1);
})().catch(async (e) => { console.error("ERR " + e.message); try { await browser.close(); } catch (_) {} process.exit(1); });
