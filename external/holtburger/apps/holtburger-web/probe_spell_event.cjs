// Trace the event flow: install a listener on `playerStatsUpdated`,
// send @addspell, check whether the event fires + whether the
// spellbook's catalog has loaded by the time it does.
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

  // Install listener + zero counters.
  await page.evaluate(() => {
    window.__statsFires = 0;
    window.__lastStatsTs = 0;
    if (window.__statsListener && window.__pluginClient?.events?.off) {
      window.__pluginClient.events.off("playerStatsUpdated", window.__statsListener);
    }
    window.__statsListener = () => {
      window.__statsFires += 1;
      window.__lastStatsTs = Date.now();
    };
    window.__pluginClient?.events?.on?.("playerStatsUpdated", window.__statsListener);
  });

  const before = await page.evaluate(() => ({
    spells: Array.from(window.__pluginClient?.player?.knownSpells?.() ?? []),
    statsFires: window.__statsFires,
  }));
  console.log("BEFORE:", JSON.stringify(before));

  console.log("\nsending @addspell 7");
  await page.evaluate(() => window.__sessionHandle.sendChat("@addspell 7"));
  await sleep(3_500);

  const after = await page.evaluate(() => {
    const sbPlugin = document.querySelector(".hb-bar [data-plugin-id='spellbook']");
    const emptyMsg = document.querySelector(".hb-sb-empty")?.textContent;
    const rowCount = document.querySelectorAll(".hb-sb-row").length;
    return {
      spells: Array.from(window.__pluginClient?.player?.knownSpells?.() ?? []),
      statsFires: window.__statsFires,
      lastStatsTs: window.__lastStatsTs,
      panelExists: !!sbPlugin,
      panelEmpty: emptyMsg,
      panelRows: rowCount,
    };
  });
  console.log("AFTER:", JSON.stringify(after, null, 2));

  // Now open + check spellbook panel.
  await page.click(".hb-bar [data-plugin-id='spellbook']").catch(() => null);
  await sleep(900);
  const panelState = await page.evaluate(() => {
    const empty = document.querySelector(".hb-sb-empty");
    const rows = Array.from(document.querySelectorAll(".hb-sb-row")).map((r) => ({
      id: r.dataset.spellId,
      name: r.querySelector(".hb-sb-row-name")?.textContent,
    }));
    return {
      emptyMsg: empty?.textContent,
      emptyVisible: empty && empty.offsetParent !== null,
      rowCount: rows.length,
      rows: rows.slice(0, 10),
    };
  });
  console.log("\nPANEL:", JSON.stringify(panelState, null, 2));

  await browser.close();
})();
