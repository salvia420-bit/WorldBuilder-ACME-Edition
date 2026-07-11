#!/usr/bin/env node
// town_interior_visibility_probe.mjs — GROUND TRUTH for "building interiors show
// only NPCs from outside" (issue 1). Boots headless, teleports to a town, then
// asks, orientation-independently: are building-interior EnvCells LOADED, and does
// the outdoor render-set path ADMIT them?
//
// Orientation-free test: build an orthographic frustum covering the whole current
// landblock (192 m box + tall z) in AC world space and feed it to
// getRenderSetWithFrustum. That returns every outdoor-exit cell whose AABB is in
// the box, independent of camera facing. Compare to the set of loaded interior
// cells (cellContainers3d, idx >= 0x100). loaded>0 && admitted==0 => bug reproduced.
//
// Usage: node town_interior_visibility_probe.mjs "<@telepoi target or @teleloc ...>" [settleMs]
import { chromium } from "playwright";
const tele = process.argv[2] || "@telepoi Yaraq";
const settle = +(process.argv[3] || 30000);
const acct = process.env.WB_ACCT || "tailnet1"; // account=password test convention; override via WB_ACCT
const BOOT =
  "http://127.0.0.1:8765/apps/holtburger-web/index.html" +
  "?renderer=3d&quality=low&agentic=low&hud=none&plugins=none" +
  "&diag=1&nosw=1&nullRender=1&renderOnDemand=1&netDrainHz=30&autoLogin=1&autoSpawn=first" +
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
await p.evaluate(() => window.__sessionHandle?.sendChat?.("@god")).catch(() => {});
await p.waitForTimeout(1500);
await p.evaluate((t) => window.__sessionHandle?.sendChat?.(t), tele).catch(() => {});

// Resilient incremental poll: tiny evaluates every ~2.5s, log each immediately.
// A dense town can OOM the tab; polling means a crash never costs prior data.
const polls = Math.max(4, Math.round(settle / 2500));
for (let i = 0; i < polls; i++) {
  await p.waitForTimeout(2500);
  let r;
  try {
    r = await p.evaluate(() => {
      const ls = window.liveScene3d, sh = window.__sessionHandle;
      if (!ls || !sh) return { e: "no ls/sh" };
      const cur = (sh.getCurrentCellId ? sh.getCurrentCellId() : 0) >>> 0;
      const lbHi = cur >>> 16;
      const lbXByte = (cur >>> 24) & 0xff, lbYByte = (cur >>> 16) & 0xff;
      const m = ls.cellContainers3d instanceof Map ? ls.cellContainers3d : null;
      let loadedInterior = 0, loadedLb = 0;
      if (m) for (const c0 of m.keys()) { const c = c0 >>> 0; if ((c >>> 16) === lbHi) { loadedLb++; if ((c & 0xffff) >= 0x100) loadedInterior++; } }
      // ortho box over whole LB (AC space), orientation-free
      const cx = lbXByte * 192 + 96, cy = lbYByte * 192 + 96;
      const Rx = 160, Ry = 160, Rz = 600;
      const mvp = new Float32Array(16);
      mvp[0] = 1 / Rx; mvp[5] = 1 / Ry; mvp[10] = 1 / Rz;
      mvp[12] = -cx / Rx; mvp[13] = -cy / Ry; mvp[14] = 0; mvp[15] = 1;
      let admitted = -1;
      try { const s = sh.getRenderSetWithFrustum(mvp); admitted = Array.from(s, v => v >>> 0).filter(c => (c >>> 16) === lbHi && (c & 0xffff) >= 0x100).length; } catch (e) { admitted = "ERR:" + String(e).slice(0, 60); }
      return {
        cur: "0x" + cur.toString(16).padStart(8, "0"),
        indoor: sh.isCurrentCellIndoor ? !!sh.isCurrentCellIndoor() : null,
        loadedLb, loadedInterior, admittedInterior: admitted,
        ents: ls.entitiesGroup?.children?.length ?? null,
        cells: ls.cellsGroup?.children?.length ?? null,
      };
    });
  } catch (e) { console.log("POLL", i, "CRASH:", String(e).slice(0, 80)); break; }
  console.log("POLL", i, JSON.stringify(r));
}

let out = null;
try { out = await p.evaluate(() => {
  const ls = window.liveScene3d;
  const sh = window.__sessionHandle;
  if (!ls || !sh) return { fatal: "no liveScene3d / sessionHandle" };
  const cur = sh.getCurrentCellId ? sh.getCurrentCellId() >>> 0 : 0;
  const isIndoor = sh.isCurrentCellIndoor ? !!sh.isCurrentCellIndoor() : null;
  const lbHi = cur >>> 16;
  const lbXByte = (cur >>> 24) & 0xff;
  const lbYByte = (cur >>> 16) & 0xff;

  // --- census of loaded cells for the current LB ---
  const m = ls.cellContainers3d instanceof Map ? ls.cellContainers3d : null;
  const loadedInterior = [];   // idx >= 0x100
  const visibleInterior = [];  // .visible === true
  let loadedThisLb = 0;
  if (m) {
    for (const [cid, cont] of m.entries()) {
      const c = cid >>> 0;
      if ((c >>> 16) !== lbHi) continue;
      loadedThisLb++;
      const idx = c & 0xffff;
      if (idx >= 0x100) {
        loadedInterior.push(c);
        if (cont && cont.visible === true) visibleInterior.push(c);
      }
    }
  }

  // --- real-camera render set (whatever direction we happen to face) ---
  const camera = ls.camera, worldRoot = ls.worldRoot;
  let camSet = null;
  try {
    if (sh.getRenderSetWithFrustum && camera && worldRoot) {
      const M4 = camera.projectionMatrix.constructor;
      const mm = new M4();
      mm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      mm.multiply(worldRoot.matrixWorld);
      const mvp = new Float32Array(16);
      for (let i = 0; i < 16; i++) mvp[i] = mm.elements[i];
      camSet = Array.from(sh.getRenderSetWithFrustum(mvp), (v) => v >>> 0);
    }
  } catch (e) { camSet = "ERR " + String(e).slice(0, 120); }

  // --- ORIENTATION-FREE test: ortho box covering the whole LB in AC space ---
  // clip = M * [x,y,z,1]; box center (cx,cy,cz), half-extents (Rx,Ry,Rz).
  const cx = lbXByte * 192 + 96, cy = lbYByte * 192 + 96, cz = 0;
  const Rx = 160, Ry = 160, Rz = 600;
  const mvpBox = new Float32Array(16); // column-major
  mvpBox[0] = 1 / Rx; mvpBox[5] = 1 / Ry; mvpBox[10] = 1 / Rz;
  mvpBox[12] = -cx / Rx; mvpBox[13] = -cy / Ry; mvpBox[14] = -cz / Rz; mvpBox[15] = 1;
  let boxSet = null;
  try {
    boxSet = Array.from(sh.getRenderSetWithFrustum(mvpBox), (v) => v >>> 0);
  } catch (e) { boxSet = "ERR " + String(e).slice(0, 120); }
  const admittedInterior = Array.isArray(boxSet)
    ? boxSet.filter((c) => (c >>> 16) === lbHi && (c & 0xffff) >= 0x100)
    : boxSet;

  const hex = (n) => "0x" + (n >>> 0).toString(16).padStart(8, "0");
  return {
    currentCell: hex(cur),
    isIndoor,
    lb: hex(lbHi << 16).slice(0, 6),
    groups: {
      cells: ls.cellsGroup?.children?.length ?? null,
      entities: ls.entitiesGroup?.children?.length ?? null,
      terrain: ls.terrainGroup?.children?.length ?? null,
      buildings: ls.buildingsGroup?.children?.length ?? null,
      statics: ls.staticsGroup?.children?.length ?? null,
    },
    lbCensus: {
      loadedCellsThisLb: loadedThisLb,
      loadedInteriorCount: loadedInterior.length,
      visibleInteriorCount: visibleInterior.length,
      sampleLoadedInterior: loadedInterior.slice(0, 8).map(hex),
      sampleVisibleInterior: visibleInterior.slice(0, 8).map(hex),
    },
    outdoorPath: {
      cameraRenderSetInteriorCount: Array.isArray(camSet)
        ? camSet.filter((c) => (c >>> 16) === lbHi && (c & 0xffff) >= 0x100).length
        : camSet,
      boxAdmittedInteriorCount: Array.isArray(admittedInterior) ? admittedInterior.length : admittedInterior,
      boxAdmittedInteriorSample: Array.isArray(admittedInterior) ? admittedInterior.slice(0, 8).map(hex) : admittedInterior,
    },
  };
}); } catch (e) { log("final evaluate crashed (polls above hold the data):", String(e).slice(0, 100)); }

log("FINAL:", JSON.stringify(out, null, 2));
if (errs.length) log("\nconsole errors (first 10):\n" + errs.slice(0, 10).join("\n"));
await b.close();
process.exit(0);
