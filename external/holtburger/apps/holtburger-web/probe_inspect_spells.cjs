// Inspect the current spell_book cache + recent events. Do NOT
// reload the page or change anything.
const { chromium } = require("playwright");
(async () => {
  const browser = await chromium.connectOverCDP(
    process.env.K1_CDP_URL || "http://127.0.0.1:9223"
  );
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) =>
    p.url().startsWith("http://localhost:7080/apps/holtburger-web/")
  );
  if (!page) throw new Error("no holtburger tab");
  const state = await page.evaluate(() => {
    const known = window.__pluginClient?.player?.knownSpells?.();
    const knownArr = known ? Array.from(known) : null;
    const direct = window.__sessionHandle?.playerKnownSpells?.();
    const directArr = direct ? Array.from(direct) : null;
    // What does the wasm console.log say?
    return {
      hasSessionHandle: !!window.__sessionHandle,
      hasPluginClient: !!window.__pluginClient,
      knownSpellsLen: knownArr?.length ?? null,
      knownSpells: knownArr?.slice(0, 20),
      directSpellsLen: directArr?.length ?? null,
      directSpells: directArr?.slice(0, 20),
      spellbookOpen: !!document.querySelector(".hb-sb-row"),
      spellbookRows: Array.from(
        document.querySelectorAll(".hb-sb-row")
      ).slice(0, 5).map((r) => r.dataset.spellId),
      spellbookEmptyMsg: document.querySelector(".hb-sb-empty")?.textContent,
      pageUrl: location.href,
      // Snapshot any recent chat lines we can read.
      recentChat: Array.from(
        document.querySelectorAll(".chat-line, .chat-message")
      ).slice(-15).map((el) => el.innerText.slice(0, 100)),
    };
  });
  console.log(JSON.stringify(state, null, 2));
  await browser.close();
})();
