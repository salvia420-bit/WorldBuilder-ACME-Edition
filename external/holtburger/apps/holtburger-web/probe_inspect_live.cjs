const { chromium } = require("playwright");
(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
  const ctx = browser.contexts()[0];
  const pages = ctx.pages();
  console.log("pages:");
  for (const p of pages) console.log("  -", p.url());
  const page = pages.find(p => p.url().includes("holtburger-web")) || pages[0];
  if (!page) { console.log("no holtburger tab"); await browser.close(); return; }
  const state = await page.evaluate(() => {
    const sh = window.__sessionHandle;
    const pc = window.__pluginClient;
    return {
      url: location.href,
      hasSessionHandle: !!sh,
      hasSetCombatMode: typeof sh?.setCombatMode === "function",
      hasFetchAnim: typeof sh?.fetchEntityAnimationKeyframes === "function",
      enteredWorld: !!window.__enteredWorld,
      localGuid: typeof window.getLocalPlayerGuid === "function" ? window.getLocalPlayerGuid() : null,
      stanceLabel: window.__getCurrentStanceLabel?.() ?? null,
      currentCell: sh?.getCurrentCellId?.()?.toString(16) ?? null,
      entityMapSize: window.entityMap?.size ?? 0,
      barSlots: Array.from(document.querySelectorAll(".hb-bar [data-plugin-id]")).map(el => el.dataset.pluginId),
      vitalsHudPresent: !!document.getElementById("hb-vitals-hud"),
      spellsCount: pc?.player?.knownSpells?.()?.length ?? null,
    };
  });
  console.log(JSON.stringify(state, null, 2));
  await browser.close();
})();
