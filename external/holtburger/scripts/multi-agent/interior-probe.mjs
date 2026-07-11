#!/usr/bin/env node
// interior-probe.mjs — diagnose what's cleanly observable inside a dungeon for
// PVS-structural verification: teleport into an interior cell, wait, set the
// oracle, run the per-LB diff, and report the per-LB-filtered placements/spawns
// observed (vs cumulative scene groups + raw entity streaming).
//   node interior-probe.mjs <lbHex> <cellId8hex> <x> <y> <z> <oraclePath> [settleMs]
import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
const [lb, cell, x, y, z, oraclePath, settleArg, preCell] = process.argv.slice(2);
const settle = +(settleArg || 25000);
const lbId = (parseInt(lb, 16) << 16) >>> 0;
const oracle = JSON.parse(await readFile(oraclePath, "utf8"));
const acct = "acadmp1ge522";
const BOOT =
  "http://127.0.0.1:8765/apps/holtburger-web/index.html" +
  "?renderer=3d&quality=low&agentic=low&eagerDungeons=on&hud=none&plugins=none" +
  "&diag=1&nosw=1&renderOnDemand=1&autoLogin=1&autoSpawn=first" +
  "&server_host=127.0.0.1&server_port=9000&bridge_url=ws://127.0.0.1:8080/" +
  `&account=${acct}&password=${acct}`;

const b = await chromium.launch({ headless: true, args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--disable-dev-shm-usage"] });
const p = await b.newPage();
await p.goto(BOOT, { waitUntil: "domcontentloaded", timeout: 45000 });
const dl = Date.now() + 120000;
while (Date.now() < dl) { const s = await p.evaluate(() => window.__bootState).catch(() => null); if (s === "ready") break; await p.waitForTimeout(300); }
await p.evaluate(() => window.__sessionHandle?.sendChat?.("@god")).catch(() => {});
await p.waitForTimeout(1500);
// Optionally reproduce the sweep condition: an OUTDOOR teleport first.
if (preCell) {
  await p.evaluate((c) => window.__sessionHandle?.sendChat?.(`@teleloc ${c} 96.0 96.0 500.0`), preCell);
  await p.waitForTimeout(15000);
}
await p.evaluate(({ cell, x, y, z }) => window.__sessionHandle?.sendChat?.(`@teleloc ${cell} ${x} ${y} ${z}`), { cell, x, y, z });
await p.waitForTimeout(settle);
const out = await p.evaluate(({ oracle, lbId }) => {
  if (window.__diag?.setExpected) window.__diag.setExpected(oracle);
  const r = window.__diag?.runAll?.(lbId);
  const cur = (() => { try { return window.__diag?.pvs?.currentCell?.(); } catch { return null; } })();
  const ls = window.liveScene3d;
  return {
    currentCell: cur,
    summary: r?.summary ?? null,
    placements: r?.surfaces?.placements ? { expected: r.surfaces.placements.expected, observed: r.surfaces.placements.observed, summary: r.surfaces.placements.summary } : null,
    spawns: r?.surfaces?.spawns ? { expectedCount: r.surfaces.spawns.expectedCount, observedCount: r.surfaces.spawns.observedCount, ok: r.surfaces.spawns.ok } : null,
    raw: { cellsGroup: ls?.cellsGroup?.children?.length ?? null, staticsGroup: ls?.staticsGroup?.children?.length ?? null, entitiesGroup: ls?.entitiesGroup?.children?.length ?? null },
    envCellLoadedLbs: (() => { try { const s = ls?.envCellLoadedLbs; return s ? (Array.isArray(s) ? s.length : (s.size ?? Array.from(s).length)) : null; } catch { return null; } })(),
    // per-LB loaded cell census from cellContainers3d (cellId = (lb<<16)|idx)
    observedCellsForLb: (() => { try {
      const m = ls?.cellContainers3d; if (!(m instanceof Map)) return null;
      const lbHi = (lbId >>> 16); let n = 0;
      for (const cid of m.keys()) if (((cid >>> 0) >>> 16) === lbHi) n++;
      return n;
    } catch { return null; } })(),
  };
}, { oracle, lbId });
console.log(JSON.stringify({ lb, oracleInterior: oracle.interior, oracleCounts: oracle.counts, ...out }, null, 2));
await b.close();
process.exit(0);
