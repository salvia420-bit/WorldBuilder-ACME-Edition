#!/usr/bin/env node
// mode-test.mjs — does a lighter render mode still populate the scene graph that
// __diag reads (staticsGroup / buildingsGroup / entitiesGroup / cellContainers3d)?
//   node mode-test.mjs "<extra-flags>"   e.g. "wireframe=1" or "wireframe=1&nullRender=1"
import { chromium } from "playwright";
const extra = process.argv[2] || "";
const acct = "acadmp1ge522";
const BOOT =
  "http://127.0.0.1:8765/apps/holtburger-web/index.html" +
  "?renderer=3d&quality=low&agentic=low&eagerDungeons=on&hud=none&plugins=none" +
  "&diag=1&nosw=1&renderOnDemand=1&autoLogin=1&autoSpawn=first" +
  "&server_host=127.0.0.1&server_port=9000&bridge_url=ws://127.0.0.1:8080/" +
  `&account=${acct}&password=${acct}` + (extra ? "&" + extra : "");

const b = await chromium.launch({ headless: true, args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--disable-dev-shm-usage"] });
const p = await b.newPage();
const t0 = Date.now();
await p.goto(BOOT, { waitUntil: "domcontentloaded", timeout: 45000 });
let ready = false; const dl = Date.now() + 120000;
while (Date.now() < dl) { const s = await p.evaluate(() => window.__bootState).catch(() => null); if (s === "ready") { ready = true; break; } if (s === "error") break; await p.waitForTimeout(300); }
const bootMs = Date.now() - t0;
await p.evaluate(() => window.__sessionHandle?.sendChat?.("@god")).catch(() => {});
await p.waitForTimeout(1500);

// mixed/surface LB: Holtburg 0xA9B4 (12 buildings, scenery, surface npcs)
await p.evaluate(() => window.__sessionHandle?.sendChat?.("@teleloc 0xA9B40000 96.0 96.0 500.0"));
await p.waitForTimeout(15000);
const surf = await p.evaluate(() => ({
  cur: window.__diag?.pvs?.currentCell?.()?.lbHex ?? null,
  statics: window.liveScene3d?.staticsGroup?.children?.length ?? null,
  buildings: window.liveScene3d?.buildingsGroup?.children?.length ?? null,
  entities: window.liveScene3d?.entitiesGroup?.children?.length ?? null,
  runAll: !!window.__diag?.runAll,
}));

// dungeon 0x5849 interior cell — cellContainers3d census should reach ~561
await p.evaluate(() => window.__sessionHandle?.sendChat?.("@teleloc 0x58490101 83.43 -310.96 -95.99"));
await p.waitForTimeout(12000);
const dun = await p.evaluate(() => {
  const m = window.liveScene3d?.cellContainers3d;
  let cells = null;
  if (m instanceof Map) { let n = 0; for (const cid of m.keys()) if (((cid >>> 0) >>> 16) === 0x5849) n++; cells = n; }
  return { cur: window.__diag?.pvs?.currentCell?.()?.cellHex ?? null, cellsForLb: cells };
});

console.log(JSON.stringify({ mode: extra || "(full renderer)", ready, bootMs, surf, dun }, null, 2));
await b.close();
process.exit(0);
