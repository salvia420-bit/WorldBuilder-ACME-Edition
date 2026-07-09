#!/usr/bin/env node
// diag_cells.mjs — is cellContainers3d populated + flipped visible under a full
// render loop, and does tickPortalStencil's collection match? Diagnoses passCells:0.
import { chromium } from "playwright";
const tele = process.argv[2] || "@telepoi Holtburg";
const settle = +(process.argv[3] || 22000);
const acct = process.env.WB_ACCT || "tailnet1"; // account=password test convention; override via WB_ACCT
const BOOT =
  "http://127.0.0.1:8765/apps/holtburger-web/index.html" +
  "?renderer=3d&quality=low&agentic=low&hud=none&plugins=none" +
  "&diag=1&nosw=1&targetFps=3&portalStencil=on&autoLogin=1&autoSpawn=first&kickDance=1" +
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
await p.waitForTimeout(5000);
await p.evaluate(() => window.__sessionHandle?.sendChat?.("@god")).catch(() => {});
await p.waitForTimeout(1200);
await p.evaluate((t) => window.__sessionHandle?.sendChat?.(t), tele).catch(() => {});
const polls = Math.max(4, Math.round(settle / 3000));
for (let i = 0; i < polls; i++) {
  await p.waitForTimeout(3000);
  let r;
  try {
    r = await p.evaluate(() => {
      const ls = window.liveScene3d, sh = window.__sessionHandle;
      const reg = ls?.cellContainers3d;
      const isMap = reg instanceof Map;
      let regSize = 0, regVisible = 0, regIntVis = 0;
      if (isMap) {
        regSize = reg.size;
        for (const [cid, c] of reg) {
          if (c?.visible) { regVisible++; if (((cid >>> 0) & 0xffff) >= 0x100) regIntVis++; }
        }
      }
      const cg = ls?.cellsGroup;
      let cgN = cg?.children?.length ?? 0, cgVis = 0;
      if (cg?.children) for (const c of cg.children) if (c.visible) cgVis++;
      const pass = ls?._portalStencilPass;
      return {
        indoor: sh?.isCurrentCellIndoor ? !!sh.isCurrentCellIndoor() : null,
        cur: (sh?.getCurrentCellId?.() >>> 0)?.toString(16),
        cellContainers3d_isMap: isMap, regSize, regVisible, regIntVis,
        cellsGroup_children: cgN, cellsGroup_visible: cgVis,
        passApertures: pass?._apertureCount ?? null,
        passCells: pass?._cells?.length ?? null,
        hasWork: pass?.hasWork ?? null,
      };
    });
  } catch (e) { log("POLL", i, "CRASH:", String(e).slice(0, 80)); break; }
  log("POLL", i, JSON.stringify(r));
}
log("console errors:", errs.length, errs.slice(0, 6));
await b.close();
process.exit(0);
