// Inspect the live state of the Combat plugin panel + toggle wire.
const { chromium } = require("playwright");
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
(async () => {
  const browser = await chromium.connectOverCDP(
    process.env.K1_CDP_URL || "http://127.0.0.1:9223"
  );
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) =>
    p.url().startsWith("http://localhost:7080/apps/holtburger-web/")
  );
  if (!page) throw new Error("no holtburger tab");

  // Snapshot what's currently in the panel (if open).
  let panel = await page.evaluate(() => {
    const panelEl = document.querySelector(".hb-panel, .hb-bar-panel");
    if (!panelEl) return { open: false };
    return {
      open: true,
      innerHTML: panelEl.innerHTML.slice(0, 2000),
      rowClasses: Array.from(panelEl.querySelectorAll(".hb-cb-row")).map(
        (r) => r.className
      ),
      hasHeightRow: !!panelEl.querySelector(".hb-cb-heights"),
      hasPowerRow: !!panelEl.querySelector(".hb-cb-power-row"),
      hasRepeat: !!Array.from(panelEl.querySelectorAll(".hb-cb-toggle")).find(
        (el) => /repeat/i.test(el.textContent)
      ),
      hasCharge: !!Array.from(panelEl.querySelectorAll(".hb-cb-toggle")).find(
        (el) => /charge/i.test(el.textContent)
      ),
    };
  });
  console.log("PANEL_NOW:", JSON.stringify(panel, null, 2));

  // Force-close then re-open the Combat slot to reproduce issue #2.
  await page.click('.hb-bar [data-plugin-id="combat-bar"]').catch(() => null);
  await sleep(300);
  await page.click('.hb-bar [data-plugin-id="combat-bar"]').catch(() => null);
  await sleep(500);
  const panelAfter = await page.evaluate(() => {
    const panelEl = document.querySelector(".hb-panel, .hb-bar-panel");
    if (!panelEl) return { open: false };
    return {
      open: true,
      childCount: panelEl.children.length,
      rowCount: panelEl.querySelectorAll(".hb-cb-row").length,
      stanceVisible: !!panelEl.querySelector(".hb-cb-stance-row"),
      heightVisible: !!panelEl.querySelector(".hb-cb-heights"),
      powerVisible: !!panelEl.querySelector(".hb-cb-power-row"),
      repeatCount: Array.from(panelEl.querySelectorAll(".hb-cb-toggle")).length,
      meterVisible: !!panelEl.querySelector(".hb-cb-power-meter"),
      feedVisible: !!panelEl.querySelector(".hb-cb-feed"),
      innerHTML: panelEl.innerHTML.slice(0, 800),
    };
  });
  console.log("\nAFTER_X_THEN_REOPEN:", JSON.stringify(panelAfter, null, 2));

  // Toggle test — current stance, fire, wait, then read.
  const stanceBefore = await page.evaluate(() =>
    window.__getCurrentStanceLabel?.()
  );
  console.log(`\nstance BEFORE toggle: ${stanceBefore}`);
  let errMsg = null;
  try {
    await page.evaluate(() =>
      window.__pluginClient.player.toggleCombatMode()
    );
  } catch (e) {
    errMsg = e.message;
  }
  console.log(`toggle fired (err=${errMsg})`);
  await sleep(2500);
  const stanceAfter = await page.evaluate(() =>
    window.__getCurrentStanceLabel?.()
  );
  console.log(`stance AFTER toggle: ${stanceAfter}`);

  await browser.close();
})();
