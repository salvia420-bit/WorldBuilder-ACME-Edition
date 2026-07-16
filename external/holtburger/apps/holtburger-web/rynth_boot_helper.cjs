// Shared boot helper: reload-retry around single-shot autoLogin (the
// Account-In-Use kick dance — first connect kicks the stale char).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function bootInWorld(page, url, attempts = 4) {
  for (let a = 1; a <= attempts; a++) {
    await page.goto(url + `&v=${Date.now()}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    for (let i = 0; i < 60; i++) {
      const st = await page.evaluate(() => window.__bootState || "");
      if (st === "in-world" || st === "ready") return st;
      if (st === "error") break;
      await sleep(2000);
    }
    const hist = await page.evaluate(() => window.__bootStateHistory || window.__bootState);
    console.log(`boot attempt ${a} failed: ${JSON.stringify(hist).slice(0, 200)}`);
    await sleep(15_000);
  }
  return null;
}
module.exports = { bootInWorld, sleep };
