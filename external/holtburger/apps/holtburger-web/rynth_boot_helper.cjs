// Shared boot helper: reload-retry around single-shot autoLogin (the
// Account-In-Use kick dance). Uses a FRESH page per attempt (a crashed
// renderer poisons the old page object). Success = boot-state gate AND
// __sessionHandle attached. Returns the live Page or null.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function bootInWorld(browser, url, attempts = 4) {
  for (let a = 1; a <= attempts; a++) {
    let page = null;
    try {
      page = await browser.newPage();
      await page.goto(url + `&v=${Date.now()}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      let ok = false;
      for (let i = 0; i < 60; i++) {
        const st = await page.evaluate(() => window.__bootState || "");
        if (st === "in-world" || st === "ready") { ok = true; break; }
        if (st === "error") break;
        await sleep(2000);
      }
      if (ok) {
        await page.waitForFunction(() => !!window.__sessionHandle, { timeout: 90_000 });
        return page;
      }
      const hist = await page.evaluate(() => window.__bootStateHistory || window.__bootState);
      console.log(`boot attempt ${a} failed: ${JSON.stringify(hist).slice(0, 200)}`);
    } catch (e) {
      console.log(`boot attempt ${a} threw: ${String(e.message).slice(0, 120)}`);
    }
    if (page) await page.close().catch(() => null);
    await sleep(15_000);
  }
  return null;
}
module.exports = { bootInWorld, sleep };
