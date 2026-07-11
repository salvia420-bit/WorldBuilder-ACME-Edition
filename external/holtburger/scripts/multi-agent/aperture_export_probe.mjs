#!/usr/bin/env node
// aperture_export_probe.mjs — validate the new wasm export getVisiblePortalApertures.
// Boots headless (nullRender, light), teleports to a town, and calls the export with an
// orientation-free ortho box over the whole current LB. Confirms it returns real
// world-space door/window aperture polygons (the input the portal-stencil pass needs).
//   node aperture_export_probe.mjs "<@telepoi target>" [settleMs]
import { chromium } from "playwright";
const tele = process.argv[2] || "@telepoi Holtburg";
const settle = +(process.argv[3] || 24000);
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
p.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 160)); });
p.on("pageerror", (e) => errs.push("PAGEERR " + String(e).slice(0, 160)));

await p.goto(BOOT, { waitUntil: "domcontentloaded", timeout: 45000 });
const dl = Date.now() + 130000;
let boot = null;
while (Date.now() < dl) {
  boot = await p.evaluate(() => window.__bootState).catch(() => null);
  if (boot === "in-world" || boot === "ready") break;
  await p.waitForTimeout(400);
}
log("bootState:", boot);
// Confirm the freshly-built export is actually present in the loaded wasm.
const hasExport = await p.evaluate(
  () => typeof window.__sessionHandle?.getVisiblePortalApertures === "function"
).catch(() => false);
log("getVisiblePortalApertures present:", hasExport);

await p.waitForTimeout(6000);
await p.evaluate(() => window.__sessionHandle?.sendChat?.("@god")).catch(() => {});
await p.waitForTimeout(1500);
await p.evaluate((t) => window.__sessionHandle?.sendChat?.(t), tele).catch(() => {});

const polls = Math.max(4, Math.round(settle / 2500));
for (let i = 0; i < polls; i++) {
  await p.waitForTimeout(2500);
  let r;
  try {
    r = await p.evaluate(() => {
      const ls = window.liveScene3d, sh = window.__sessionHandle;
      if (!ls || !sh || typeof sh.getVisiblePortalApertures !== "function") return { e: "no export/ls" };
      const cur = (sh.getCurrentCellId ? sh.getCurrentCellId() : 0) >>> 0;
      const lbXByte = (cur >>> 24) & 0xff, lbYByte = (cur >>> 16) & 0xff;
      // orientation-free ortho box over the whole LB (AC Z-up), column-major MVP
      const cx = lbXByte * 192 + 96, cy = lbYByte * 192 + 96;
      const Rx = 160, Ry = 160, Rz = 600;
      const mvp = new Float32Array(16);
      mvp[0] = 1 / Rx; mvp[5] = 1 / Ry; mvp[10] = 1 / Rz;
      mvp[12] = -cx / Rx; mvp[13] = -cy / Ry; mvp[14] = 0; mvp[15] = 1;
      let arr;
      try { arr = sh.getVisiblePortalApertures(mvp, 0); } catch (e) { return { err: String(e).slice(0, 100) }; }
      // parse: [count, (nverts, x,y,z ...) x count]
      let k = 0; const count = arr[k++] | 0;
      let totalVerts = 0; let first = null;
      for (let a = 0; a < count; a++) {
        const nv = arr[k++] | 0; totalVerts += nv;
        const verts = [];
        for (let v = 0; v < nv; v++) { verts.push([arr[k++], arr[k++], arr[k++]]); }
        if (a === 0) first = { nv, v0: verts[0], v1: verts[1], v2: verts[2] };
      }
      return {
        cur: "0x" + cur.toString(16).padStart(8, "0"),
        floatsReturned: arr.length,
        apertureCount: count,
        totalVerts,
        firstAperture: first,
        cellsGroup: ls.cellsGroup?.children?.length ?? null,
      };
    });
  } catch (e) { log("POLL", i, "CRASH:", String(e).slice(0, 80)); break; }
  log("POLL", i, JSON.stringify(r));
}
if (errs.length) log("\nconsole errors (first 8):\n" + errs.slice(0, 8).join("\n"));
await b.close();
process.exit(0);
