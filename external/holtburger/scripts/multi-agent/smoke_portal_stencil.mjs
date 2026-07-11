#!/usr/bin/env node
// smoke_portal_stencil.mjs — boot-health check for ?portalStencil=on (NOT a
// fidelity test; SwiftShader can't judge stencil pixels). Confirms: the app
// boots, the pass is wired, the feed runs without throwing, and no NEW console
// errors appear. Fidelity is the GTX-1070 eye-test.
import { chromium } from "playwright";
const tele = process.argv[2] || "@telepoi Holtburg";
const settle = +(process.argv[3] || 18000);
const acct = process.env.WB_ACCT || "tailnet1"; // account=password test convention; override via WB_ACCT
const BOOT =
  "http://127.0.0.1:8765/apps/holtburger-web/index.html" +
  "?renderer=3d&quality=low&agentic=low&hud=none&plugins=none" +
  "&diag=1&nosw=1&renderOnDemand=1&netDrainHz=30&portalStencil=on" +
  "&autoLogin=1&autoSpawn=first" +
  "&server_host=127.0.0.1&server_port=9000&bridge_url=ws://127.0.0.1:8080/" +
  `&account=${acct}&password=${acct}`;

const log = (...a) => console.log(...a);
const b = await chromium.launch({
  headless: true,
  args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--disable-dev-shm-usage"],
});
const p = await b.newPage();
const errs = [];
p.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 200)); });
p.on("pageerror", (e) => errs.push("PAGEERR " + String(e).slice(0, 200)));

await p.goto(BOOT, { waitUntil: "domcontentloaded", timeout: 45000 });
const dl = Date.now() + 130000;
let boot = null;
while (Date.now() < dl) {
  boot = await p.evaluate(() => window.__bootState).catch(() => null);
  if (boot === "in-world" || boot === "ready") break;
  await p.waitForTimeout(400);
}
log("bootState:", boot);
await p.waitForTimeout(6000);
// wired?
const wired = await p.evaluate(() => ({
  passOnPipeline: !!window.__atmospherePipeline?.portalStencilPass,
  passOnScene: !!window.liveScene3d?._portalStencilPass,
  hasExport: typeof window.__sessionHandle?.getVisiblePortalApertures === "function",
})).catch((e) => ({ err: String(e).slice(0, 120) }));
log("wired:", JSON.stringify(wired));

await p.evaluate(() => window.__sessionHandle?.sendChat?.("@god")).catch(() => {});
await p.waitForTimeout(1200);
await p.evaluate((t) => window.__sessionHandle?.sendChat?.(t), tele).catch(() => {});
// Drive a few on-demand renders so the composer actually runs the stencil pass.
const polls = Math.max(4, Math.round(settle / 3000));
for (let i = 0; i < polls; i++) {
  await p.waitForTimeout(3000);
  const r = await p.evaluate(() => {
    try { window.__renderOnce?.(); } catch (_) {}
    const pass = window.liveScene3d?._portalStencilPass;
    return {
      cur: (window.__sessionHandle?.getCurrentCellId?.() >>> 0)?.toString(16),
      passApertures: pass?._apertureCount ?? null,
      passCells: pass?._cells?.length ?? null,
      bootState: window.__bootState,
    };
  }).catch((e) => ({ err: String(e).slice(0, 120) }));
  log("POLL", i, JSON.stringify(r));
}
log("\nconsole errors (" + errs.length + " total, first 12):");
for (const e of errs.slice(0, 12)) log("  " + e);
await b.close();
process.exit(0);
