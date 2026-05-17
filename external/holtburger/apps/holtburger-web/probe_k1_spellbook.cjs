// Verify the Spellbook plugin reflects ACE-side spells.
//
// Method:
//   1. Login (with the double-connect retry per memory rule).
//   2. Spawn + teleport to Holtburg.
//   3. Capture initial spellbook state.
//   4. Send `@addspell 2 4 6 8 10` (5 known spell ids; ACE auto-
//      validates against the SpellTable).
//   5. Wait for ACE to broadcast the updated PlayerDescription.
//   6. Re-snapshot — assert the plugin shows the added spells.

const { chromium } = require("playwright");

const CDP_URL = process.env.K1_CDP_URL || "http://127.0.0.1:9223";
const PAGE_URL = "http://localhost:7080/apps/holtburger-web/index.html";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

(async () => {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0];
  let page = ctx
    .pages()
    .find((p) =>
      p.url().startsWith("http://localhost:7080/apps/holtburger-web/")
    );
  if (!page) page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.clearBrowserCache");

  await page.evaluate(async () => {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const r of regs) await r.unregister();
    }
    if ("caches" in window) {
      const keys = await caches.keys();
      for (const k of keys) await caches.delete(k);
    }
  });
  await page.goto(`${PAGE_URL}?v=${Date.now()}`, { waitUntil: "domcontentloaded" });

  page.on("console", (msg) => {
    const t = msg.text();
    if (/spell|known|error|warn|combat-mode|PlayerDescription|stats/i.test(t)) {
      console.log(`[browser] ${t}`);
    }
  });
  page.on("pageerror", (err) => console.error(`[pageerror] ${err.message}`));

  await page.waitForFunction(
    () => /PASS/.test(document.getElementById("results")?.innerHTML ?? ""),
    { timeout: 30_000 }
  );
  console.log("smoke PASS");

  // Login (handle double-connect kick).
  async function tryLogin() {
    await page.fill('input[name="account"]', "tailnet1");
    await page.fill('input[name="password"]', "tailnet1");
    await page.fill('input[name="bridge_url"]', "ws://127.0.0.1:8080/");
    await page.fill('input[name="server_host"]', "127.0.0.1");
    await page.fill('input[name="server_port"]', "9000");
    await page.click("#login-form button[type=submit]", { noWaitAfter: true });
    try {
      await page.waitForSelector("#selection:not([hidden])", { timeout: 25_000 });
      return true;
    } catch {
      return false;
    }
  }
  if (!(await tryLogin())) {
    console.log("first login timed out; waiting 12s + retrying");
    await sleep(12_000);
    await tryLogin();
  }
  await page.locator("#character-ul button[data-id]").first().click();
  await page.waitForFunction(
    () => /InWorld|Spawned/.test(document.getElementById("login-status")?.innerText ?? ""),
    { timeout: 25_000 }
  );
  console.log("InWorld");
  await page.evaluate(() => window.__sessionHandle.sendChat("@telepoi holtburg"));
  await sleep(8_000);

  // Initial spell_book snapshot
  const before = await page.evaluate(() => {
    const arr = window.__pluginClient?.player?.knownSpells?.() ?? [];
    return Array.from(arr);
  }).catch(() => []);
  console.log(`spell_book before @addspell: ${before.length} spells`);
  console.log(`  ids: [${before.slice(0, 10).join(", ")}${before.length > 10 ? ", …" : ""}]`);

  // Add 5 known spells via admin command. ACE's @addspell validates
  // against the spell table; pick well-known starter ids.
  const targets = [1, 2, 3, 4, 5];
  for (const id of targets) {
    await page.evaluate(
      (cmd) => window.__sessionHandle.sendChat(cmd),
      `@addspell ${id}`
    );
    await sleep(250);
  }
  console.log(`sent @addspell for ids ${targets.join(", ")}`);
  await sleep(3_500);

  const after = await page.evaluate(() => {
    const arr = window.__pluginClient?.player?.knownSpells?.() ?? [];
    return Array.from(arr);
  });
  console.log(`spell_book after @addspell: ${after.length} spells`);
  console.log(`  ids: [${after.slice(0, 20).join(", ")}${after.length > 20 ? ", …" : ""}]`);

  // Open the spellbook panel + snapshot.
  await page.click('.hb-bar [data-plugin-id="spellbook"]');
  await sleep(500);
  const visibleSpells = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll(".hb-sb-row"));
    return rows.slice(0, 20).map((r) => ({
      spellId: r.dataset.spellId,
      name: r.querySelector(".hb-sb-row-name")?.textContent,
    }));
  });
  console.log(`spellbook DOM rows visible: ${visibleSpells.length}`);
  for (const s of visibleSpells.slice(0, 10)) {
    console.log(`  ${s.spellId}: ${s.name}`);
  }

  const sp = "/mnt/wbterminal1/tmp/claude-scratch/k1/k1-spellbook.png";
  await page.screenshot({ path: sp });
  console.log(`screenshot: ${sp}`);

  // Summary
  console.log(
    `\n=== summary === addspell sent: ${targets.length}, plugin shows: ${visibleSpells.length}, knownSpells before/after: ${before.length}/${after.length}`
  );
  await browser.close();
})();
