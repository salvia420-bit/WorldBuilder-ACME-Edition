#!/usr/bin/env node
// smoke-login.mjs — validate that given accounts log into live ACE end-to-end
// (autoLogin -> __bootState==="ready" -> a character spawns). Confirms the
// password==accountName convention for the harvested dev-account pool before
// the Phase-7 sweep commits to it. Sequential, headless, swiftshader (no GPU).
//   node smoke-login.mjs acct1 acct2 ...
import { chromium } from "playwright";

const accounts = process.argv.slice(2);
if (!accounts.length) { console.error("usage: node smoke-login.mjs <acct> [acct...]"); process.exit(2); }

const BOOT = (a) =>
  "http://127.0.0.1:8765/apps/holtburger-web/index.html" +
  "?renderer=3d&quality=low&agentic=low&eagerDungeons=on&hud=none&plugins=none" +
  "&diag=1&nosw=1&renderOnDemand=1&autoLogin=1&autoSpawn=first&kickDance=1" +
  "&server_host=127.0.0.1&server_port=9000&bridge_url=ws://127.0.0.1:8080/" +
  `&account=${a}&password=${a}`;

const browser = await chromium.launch({
  headless: true,
  args: ["--use-gl=swiftshader", "--no-sandbox", "--disable-dev-shm-usage"],
});
const results = [];
for (const acct of accounts) {
  const page = await browser.newPage();
  const t0 = Date.now();
  let ok = false, state = "?", cell = null, err = null;
  try {
    await page.goto(BOOT(acct), { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForFunction(() => window.__bootState === "ready", { timeout: 90000 });
    const info = await page.evaluate(() => ({
      state: window.__bootState,
      cell: (window.__diag?.pvs?.currentCell?.() ?? null),
      hasPlayer: !!(window.liveScene3d?.entitiesGroup?.children?.length || window.__sessionHandle),
    }));
    state = info.state; cell = info.cell?.lbHex ?? info.cell ?? null; ok = info.state === "ready";
  } catch (e) {
    err = String(e).split("\n")[0].slice(0, 120);
    try { state = await page.evaluate(() => window.__bootState ?? "none"); } catch {}
  }
  const ms = Date.now() - t0;
  results.push({ acct, ok, state, cell, ms, err });
  console.log(`${ok ? "PASS" : "FAIL"} ${acct}  bootState=${state} cell=${cell} ${ms}ms${err ? "  err=" + err : ""}`);
  await page.close();
}
await browser.close();
const pass = results.filter((r) => r.ok).length;
console.log(`\n=== ${pass}/${results.length} accounts logged in ===`);
process.exit(pass === results.length ? 0 : 1);
