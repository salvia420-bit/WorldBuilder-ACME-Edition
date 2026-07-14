// spin-verify.mjs — does the player actually rotate headlessly? Tests setMovementInput(turn)
// vs keyboard, reading pose.heading + draw-calls before/after each. Tells us whether the
// steadyframe-sizing spin-average is real or a no-op (draw spread was ~4 → suspicious).
import fs from "node:fs";
const CDP_URL = "http://127.0.0.1:9333";
const SERVE = "http://127.0.0.1:8765/apps/holtburger-web/index.html";
const ACCOUNT = "tailnet1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  let pw; try { pw = require("playwright-core"); } catch (_) {
    const h = process.env.HOME; const hits = fs.readdirSync(`${h}/.npm/_npx`).map((d) => `${h}/.npm/_npx/${d}/node_modules/playwright-core`).filter((p) => fs.existsSync(p));
    pw = require(hits[0]); }
  const browser = await pw.chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0] ?? (await browser.newContext());
  const page = await ctx.newPage();
  const q = new URLSearchParams({ renderer: "3d", autoLogin: "1", account: ACCOUNT, password: ACCOUNT, autoSpawn: "first", nosw: "1" });
  await page.goto(`${SERVE}?${q}`, { timeout: 60000 });
  for (let i = 0; i < 240; i++) { const bs = await page.evaluate(() => window.__bootState).catch(() => null); if (bs === "in-world" || bs === "ready") break; if (bs === "error") { console.error("boot error"); process.exit(3);} await sleep(1000); }
  for (let i = 0; i < 90; i++) { if (await page.evaluate(() => !!(window.liveScene3d && window.liveScene3d.scene)).catch(() => false)) break; await sleep(1000); }
  await page.evaluate(() => { try { window.__sessionHandle.sendChat("@telepoi Cragstone"); } catch (_) {} });
  await sleep(12000);
  const hdg = () => page.evaluate(() => { try { const p = window.__sessionHandle.getLocalPlayerPose(); const h = p ? p.heading : null; const lb = p ? (p.landblockId>>>0) : null; if (p && p.free) p.free(); return { h, lb }; } catch (e) { return { err: String(e) }; } });
  const calls = () => page.evaluate(() => { const rr = window.liveScene3d.renderer; return rr.info.render.calls; });
  await page.evaluate(() => { window.liveScene3d.renderer.info.autoReset = false; });

  console.error("=== A: setMovementInput(0,0,1,false), re-issued every 200ms for 4s ===");
  let h0 = await hdg(); console.error("heading before:", JSON.stringify(h0));
  for (let i = 0; i < 20; i++) { await page.evaluate(() => { try { window.__sessionHandle.setMovementInput(0, 0, 1, false); } catch (_) {} }); await sleep(200); }
  await page.evaluate(() => { try { window.__sessionHandle.setMovementInput(0, 0, 0, false); } catch (_) {} });
  let h1 = await hdg(); console.error("heading after setMovementInput:", JSON.stringify(h1), "Δ=", (h1.h!=null&&h0.h!=null)?(h1.h-h0.h).toFixed(3):"?");

  console.error("=== B: focus canvas + hold keyboard 'q' (turn-left) 4s ===");
  await page.evaluate(() => { const c = document.querySelector("canvas"); if (c) c.focus(); });
  let h2 = await hdg();
  await page.keyboard.down("q"); await sleep(4000); await page.keyboard.up("q");
  let h3 = await hdg(); console.error("heading q before/after:", h2.h?.toFixed?.(3), "->", h3.h?.toFixed?.(3), "Δ=", (h3.h!=null&&h2.h!=null)?(h3.h-h2.h).toFixed(3):"?");

  console.error("=== C: hold 'e' (turn-right) 4s ===");
  let h4 = await hdg();
  await page.keyboard.down("e"); await sleep(4000); await page.keyboard.up("e");
  let h5 = await hdg(); console.error("heading e before/after:", h4.h?.toFixed?.(3), "->", h5.h?.toFixed?.(3), "Δ=", (h5.h!=null&&h4.h!=null)?(h5.h-h4.h).toFixed(3):"?");

  console.error("=== draw-calls sensitivity to facing (hold whichever turned) ===");
  console.error("lb stayed:", h0.lb === h5.lb, "(", h0.lb, "->", h5.lb, ")");
  try { await page.close(); } catch (_) {}
  process.exit(0);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
