// genfix-verify-laptop.mjs — per-location SCENE-GRAPH validation on the laptop (software GL, nullRender).
// Counts are GPU-independent: the streaming path (world_stream → loadEnvCells/loadSpawns/bakeStatics)
// builds the scene graph regardless of render(), so nullRender=1 gives valid entRoots / cell counts
// while avoiding the cost of SwiftShader-rendering a full AC scene on an 8GB box. Pixel fidelity is
// already covered by the real-GPU 1070 v1 run; this answers "do the 810 arena monsters + interior
// cells actually surface from the staged data?". Small PVS ring bounds memory.
//   NODE_PATH-free: this file sits beside node_modules/playwright-core so the bare import resolves.
// Run: node /home/wbterminal/.npm/_npx/e41f203b7505f1fb/genfix-laptop.mjs

import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";

const EXE = "/mnt/wbterminal2/ms-playwright/chromium-1217/chrome-linux64/chrome";
const OUT = "/tmp/claude-1000/-home-wbterminal/34fa34ff-29fc-4c04-a325-d3ad7e660cd9/scratchpad";
const APP = "http://127.0.0.1:8765/apps/holtburger-web/index.html";
const COMMON = {
  renderer: "3d", quality: "low", nosw: "1", nullRender: "1", pvsRingRadius: "1",
  autoLogin: "1", account: "phase4demo", password: "phase4demo", autoSpawn: "first",
  server_host: "127.0.0.1", server_port: "9000", bridge_url: "ws://127.0.0.1:8080/",
};
const LOCS = [
  { key: "town-holtburg",      how: "telepoi", arg: "Holtburg" },
  { key: "cottage-interior",   how: "teleloc", cell: "0xA9B40100", x: 88, y: 131, z: 67 },
  { key: "arena-0x00B4",       how: "teleloc", cell: "0x00B4016A", x: 37.49, y: 0.5, z: 0.1 },
  { key: "holtdungeon-0x01F6", how: "teleloc", cell: "0x01F60175", x: 79.1, y: 0.5, z: -11.99 },
];
const LOGIN_POLL_MS = 180000, TELE_POLL_MS = 60000, SETTLE_MS = 30000, PRELOGIN_GAP_MS = 25000;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const report = { ts: new Date().toISOString(), host: "laptop-swiftshader-nullRender", app: APP, locs: [] };

function CAPTURE() {
  const s3 = window.liveScene3d; if (!s3) return { err: "no liveScene3d" };
  const grp = (name) => { const o = s3[name]; if (!o) return { present: false };
    let meshes = 0; o.traverse(x => { if (x.isMesh || x.isInstancedMesh) meshes += (x.isInstancedMesh ? (x.count || 1) : 1); });
    return { children: o.children?.length ?? 0, meshes }; };
  const h = window.__sessionHandle; let cell = 0, pose = null, indoor = null;
  try { cell = h.getCurrentCellId() >>> 0; } catch (e) {}
  try { const p = h.getLocalPlayerPose(); if (p) pose = { x: +(+p.x).toFixed(1), y: +(+p.y).toFixed(1), z: +(+p.z).toFixed(1) }; } catch (e) {}
  try { indoor = !!h.isCurrentCellIndoor?.(); } catch (e) {}
  const curLB = cell >>> 16;
  let curLbCells = 0, curLbCellMeshes = 0, totalCellContainers = 0;
  const cc = s3.cellContainers3d;
  if (cc && typeof cc.forEach === "function") cc.forEach((container, cid) => {
    totalCellContainers++;
    if (((cid >>> 0) >>> 16) === curLB) { curLbCells++; container.traverse(x => { if (x.isMesh || x.isInstancedMesh) curLbCellMeshes++; }); }
  });
  const ents = s3.entitiesGroup; let entRoots = 0, entMeshes = 0, withMap = 0, basic = 0; const matTypes = {};
  // count entity roots by current LB (entity world pos under rotated worldRoot → use local pos of root)
  let curLbEntRoots = 0;
  if (ents) {
    for (const c of ents.children) { const n = c.name || ""; if (!n.startsWith("entity")) continue; entRoots++;
      const px = c.position?.x ?? 0, py = c.position?.y ?? 0; const elx = (Math.floor(px / 192)) & 0xff, ely = (Math.floor(py / 192)) & 0xff;
      if (((elx << 8) | ely) === curLB) curLbEntRoots++; }
    ents.traverse(x => { if (!(x.isMesh || x.isInstancedMesh)) return; entMeshes++;
      const mats = Array.isArray(x.material) ? x.material : [x.material];
      for (const m of mats) { if (!m) continue; matTypes[m.type] = (matTypes[m.type] || 0) + 1; if (m.map) withMap++; if (m.type === "MeshBasicMaterial") basic++; } });
  }
  // ── built-in wire-agent __diag layer (purpose-built, cheat-free) ──
  // placements.walk(lbId) walks statics+buildings+entities for the LB; entityTypes
  // .coverageByLb(lbId) gives the per-LB class distribution (Monster/Npc/Portal/...).
  let diagWalk = null, diagTypes = null;
  try {
    const lbId = (curLB << 16) >>> 0;
    const w = window.__diag?.placements?.walk?.(lbId);
    if (Array.isArray(w)) { diagWalk = { _total: w.length }; for (const p of w) diagWalk[p.source] = (diagWalk[p.source] || 0) + 1; }
    else if (w) diagWalk = { err: w.error || "non-array" };
    const ct = window.__diag?.entityTypes?.coverageByLb?.(lbId);
    if (ct) diagTypes = ct.byClass || ct.byCanonical || ct;
  } catch (e) { diagWalk = { err: String(e.message) }; }
  return { cell: "0x" + cell.toString(16), pose, indoor, curLbCells, curLbCellMeshes, totalCellContainers,
    statics: grp("staticsGroup"), buildings: grp("buildingsGroup"), cells: grp("cellsGroup"), entities: grp("entitiesGroup"),
    entRoots, curLbEntRoots, entMeshes, entWithMap: withMap, entBasic: basic, entMatTypes: matTypes,
    diagWalk, diagTypes };
}

async function bootInWorld(page) {
  const t0 = Date.now(); let last = null;
  while (Date.now() - t0 < LOGIN_POLL_MS) {
    const s = await page.evaluate(() => { const h = window.__sessionHandle; let cell = 0; try { if (h?.getCurrentCellId) cell = h.getCurrentCellId() >>> 0; } catch (e) {} return { boot: window.__bootState || "none", cell, scene: !!window.liveScene3d }; }).catch(() => ({ boot: "evalerr" }));
    if (s.boot !== last) { log(`  boot=${s.boot} cell=0x${(s.cell || 0).toString(16)} scene=${s.scene}`); last = s.boot; }
    if ((s.boot === "in-world" || s.boot === "ready") && s.cell !== 0 && s.scene) return true;
    await sleep(2500);
  }
  return false;
}
async function teleportConfirm(page, loc) {
  const cmd = loc.how === "telepoi" ? `@telepoi ${loc.arg}` : `@teleloc ${loc.cell} ${loc.x} ${loc.y} ${loc.z}`;
  const want = loc.how === "teleloc" ? ((parseInt(loc.cell, 16) >>> 0) >>> 16) : null;
  for (let attempt = 0; attempt < 2; attempt++) {
    log(`  ${loc.key}: ${cmd}${attempt ? " (retry)" : ""}`);
    await page.evaluate((c) => { try { window.__sessionHandle?.sendChat?.(c); } catch (e) {} }, cmd).catch(() => {});
    const t0 = Date.now();
    while (Date.now() - t0 < TELE_POLL_MS) {
      const c = await page.evaluate(() => { try { return (window.__sessionHandle?.getCurrentCellId?.() >>> 0) || 0; } catch (e) { return 0; } }).catch(() => 0);
      if (loc.how === "telepoi") { if (c && (c & 0xffff) < 0x100) return "0x" + c.toString(16); }
      else { if (c && (c >>> 16) === want) return "0x" + c.toString(16); }
      await sleep(2000);
    }
  }
  return null;
}

async function main() {
  const url = `${APP}?${new URLSearchParams(COMMON)}`;
  log(`genfix-verify-laptop (software GL, nullRender). pre-login gap ${PRELOGIN_GAP_MS / 1000}s ...`); await sleep(PRELOGIN_GAP_MS);
  const browser = await chromium.launch({ headless: true, executablePath: EXE, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--disable-gpu-sandbox", "--disable-dev-shm-usage", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--js-flags=--max-old-space-size=2048"] });
  const consoleBuf = [];
  try {
    const page = await (await browser.newContext({ viewport: { width: 1024, height: 640 } })).newPage();
    page.on("console", m => { if (consoleBuf.length < 2000) consoleBuf.push(`${m.type()}: ${m.text()}`.slice(0, 240)); });
    page.on("pageerror", e => consoleBuf.push(`pageerror: ${e.message}`.slice(0, 240)));
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    if (!await bootInWorld(page)) { report.fatal = "boot timeout"; report.consoleTail = consoleBuf.slice(-30); return; }
    await page.evaluate(() => { try { window.__sessionHandle?.sendChat?.("@god"); } catch (e) {} }).catch(() => {}); await sleep(2000);
    for (const loc of LOCS) {
      const rec = { key: loc.key };
      const errBefore = consoleBuf.filter(l => /^error:|pageerror:/.test(l)).length;
      rec.landedCell = await teleportConfirm(page, loc);
      log(`  landed=${rec.landedCell} — settle ${SETTLE_MS / 1000}s`); await sleep(SETTLE_MS);
      rec.cap = await page.evaluate(CAPTURE).catch(e => ({ err: String(e.message) }));
      rec.errDuring = consoleBuf.filter(l => /^error:|pageerror:/.test(l)).length - errBefore;
      const c = rec.cap || {};
      log(`  >>> ${loc.key}: cell=${c.cell} indoor=${c.indoor} curLbCells=${c.curLbCells} curLbCellMeshes=${c.curLbCellMeshes} curLbEntRoots=${c.curLbEntRoots} entRoots=${c.entRoots} staticsMeshes=${c.statics?.meshes} err=${rec.errDuring}`);
      log(`        diag.walk=${JSON.stringify(c.diagWalk)} diag.types=${JSON.stringify(c.diagTypes)}`);
      report.locs.push(rec); writeFileSync(`${OUT}/genfix-laptop-report.json`, JSON.stringify(report, null, 2));
    }
    report.consoleErrors = consoleBuf.filter(l => /^error:|pageerror:/.test(l)).length;
    report.consoleTail = consoleBuf.filter(l => /error|fail|white|fallback|missing|portal|envcell|setup/i.test(l)).slice(-25);
  } catch (e) { report.fatal = String(e && e.message || e); log(`FATAL: ${report.fatal}`); }
  finally { try { await browser.close(); } catch (_) {} }
  writeFileSync(`${OUT}/genfix-laptop-report.json`, JSON.stringify(report, null, 2));
  log("=".repeat(70)); log("GENFIX-LAPTOP SUMMARY");
  for (const l of report.locs) { const c = l.cap || {}; log(`  ${l.key.padEnd(20)} landed=${(l.landedCell || "MISS").padEnd(12)} indoor=${String(c.indoor).padEnd(5)} curLbCells=${c.curLbCells ?? "-"} curLbEntRoots=${c.curLbEntRoots ?? "-"} entRoots=${c.entRoots ?? "-"} basic=${c.entBasic ?? "-"} err=${l.errDuring}`); }
  log("DONE");
}
main().catch(e => { report.topFatal = e?.stack?.slice(0, 400) || String(e); }).finally(() => { try { writeFileSync(`${OUT}/genfix-laptop-report.json`, JSON.stringify(report, null, 2)); } catch (_) {} process.exit(0); });
