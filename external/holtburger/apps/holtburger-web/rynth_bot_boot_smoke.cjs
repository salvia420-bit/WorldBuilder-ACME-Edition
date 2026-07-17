#!/usr/bin/env node
// rynth_bot_boot_smoke.cjs — LIVE E2E smoke for the ?bot=1 client auto-boot
// (index.html EnteredWorld handler, 2026-07-17) + the webhost economy plane:
// navigates with ?bot=1&botAi=off, waits for window.__bot to exist WITHOUT
// any harness-side createGrindBot call, then reads inventory/coins/burden/
// free-slots through the live host.
//
// LAPTOP-RUN ONLY. Needs: serve.py :8765, wsbridge :8080, local ACE,
// Playwright on NODE_PATH.
const { chromium } = require("playwright");
const { bootInWorld, sleep } = require("./rynth_boot_helper.cjs");

const URL =
  "http://127.0.0.1:8765/apps/holtburger-web/index.html?nosw=1&nullRender=1&netDrainHz=30&autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first&bot=1&botAi=off";

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}

(async () => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-gpu"] });
    const consoleErrors = [];
    const page = await bootInWorld(browser, URL);
    if (!page) { console.log("FAIL boot"); process.exit(1); }
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));

    // The auto-boot fires on the EnteredWorld event; give it a few seconds.
    let s = null;
    for (let i = 0; i < 20; i++) {
      s = await page.evaluate(() => {
        const b = window.__bot;
        if (!b) return null;
        const h = b.host;
        return {
          kernelRunning: b.kernel?.running === true,
          hasAi: b.ai !== undefined, // botAi=off -> no ai wiring expected
          inventoryCount: h?.TryGetPlayerInventory?.().length ?? -1,
          coins: h?.TryGetCoins?.() ?? null,
          burden: h?.TryGetBurden?.() ?? null,
          freeSlots: h?.TryGetFreeSlots?.() ?? null,
          equipped: h?.TryGetEquipment?.().map((i) => i.name) ?? null,
        };
      });
      if (s && s.inventoryCount > 0) break;
      await sleep(1500);
    }
    check("?bot=1 auto-booted the bot (no harness createGrindBot)", !!s, "window.__bot never appeared");
    if (s) {
      check("kernel running", s.kernelRunning === true);
      check("botAi=off skipped the director", s.hasAi === false, `bot.ai=${JSON.stringify(s.hasAi)}`);
      check("live inventory streamed", s.inventoryCount > 0, `count=${s.inventoryCount}`);
      check("coins readable", typeof s.coins === "number" && s.coins >= 0, `coins=${s.coins}`);
      // Integer percent; a near-empty admin char legitimately rounds to 0.
      check("burden readable", typeof s.burden === "number" && s.burden >= 0 && s.burden <= 300, `burden=${s.burden}`);
      // Aggregate across main pack + side packs (e.g. 102 + 24-slot sack).
      check("free slots readable", typeof s.freeSlots === "number" && s.freeSlots > 0 && s.freeSlots <= 500, `freeSlots=${s.freeSlots}`);
      check("equipment readable", Array.isArray(s.equipped), `equipped=${JSON.stringify(s.equipped)}`);
      console.log(`live: coins=${s.coins} burden=${s.burden} freeSlots=${s.freeSlots} inv=${s.inventoryCount} worn=${JSON.stringify(s.equipped)}`);
    }
    await page.evaluate(() => { try { window.__bot?.stop?.(); } catch {} });
    check("no console errors", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
  } catch (e) {
    check("smoke ran", false, String((e && e.message) || e));
  } finally {
    try { await browser?.close(); } catch {}
  }
  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
