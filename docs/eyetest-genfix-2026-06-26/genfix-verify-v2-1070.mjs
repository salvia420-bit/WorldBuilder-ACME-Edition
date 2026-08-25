// genfix-verify-v2-1070.mjs — refined per-location validation on the real GTX 1070.
// Fixes v1 flaws: (1) wait for liveScene3d + stable frames before each capture (v1 town hit "no liveScene3d");
// (2) 30s settle for EnvCell + entity streaming; (3) confirm teleport landed in the TARGET LB, retry once
// (v1 arena drop y=-1560 was rejected by ACE → drifted); (4) per-current-LB cell counting via cellContainers3d
// to isolate each location's interior from resident geometry.
//   ssh -R 18765:127.0.0.1:8765 <user>@<gpu-box-ip> '"C:\Program Files\nodejs\node.exe" C:\Temp\genfix-verify-v2-1070.mjs'
// Artifacts: C:\Temp\genfix-v2-report.json + C:\Temp\gf2-<loc>.png

import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";

const EXE = "C:\\Users\\<user>\\AppData\\Local\\ms-playwright\\chromium-1223\\chrome-win64\\chrome.exe";
const OUT = "C:\\Temp";
const APP = "http://127.0.0.1:18765/apps/holtburger-web/index.html";
const COMMON = {
  renderer: "3d", quality: "mid", nosw: "1",
  autoLogin: "1", account: "<test-account>", password: "<test-account>", autoSpawn: "first",
  renderDiag: "on", server_host: "127.0.0.1", server_port: "9000", bridge_url: "ws://<server-ip>:8080/",
};
const LOCS = [
  { key: "town-holtburg",   how: "telepoi", arg: "Holtburg",   expect: "portals(oriented)+NPCs+buildings+ambient" },
  { key: "cottage-interior", how: "teleloc", cell: "0xA9B40100", x: 88, y: 131, z: 67,    expect: "cottage interior walls + stabs" },
  { key: "arena-0x00B4",    how: "teleloc", cell: "0x00B4016A", x: 37.49, y: 0.5, z: 0.1, expect: "810 generator monsters render in a deep interior" },
  { key: "holtdungeon-0x01F6", how: "teleloc", cell: "0x01F60175", x: 79.1, y: 0.5, z: -11.99, expect: "127 dungeon monsters + interior" },
];

const LOGIN_POLL_MS = 180000, TELE_POLL_MS = 60000, SETTLE_MS = 30000, SCENE_POLL_MS = 40000, PRELOGIN_GAP_MS = 25000;
const VIEWPORT = { width: 1600, height: 900 };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const report = { ts: new Date().toISOString(), host: "GTX1070", app: APP, locs: [] };

function CAPTURE() {
  const s3 = window.liveScene3d; if (!s3) return { err: "no liveScene3d" };
  const grp = (name) => { const o = s3[name]; if (!o) return { present: false };
    let meshes = 0, vis = 0; o.traverse(x => { if (x.isMesh || x.isInstancedMesh) { meshes++; if (x.visible) vis += (x.isInstancedMesh ? (x.count || 1) : 1); } });
    return { children: o.children?.length ?? 0, meshes, vis }; };
  const h = window.__sessionHandle; let cell = 0, pose = null, indoor = null;
  try { cell = h.getCurrentCellId() >>> 0; } catch (e) {}
  try { const p = h.getLocalPlayerPose(); if (p) pose = { x: +(+p.x).toFixed(1), y: +(+p.y).toFixed(1), z: +(+p.z).toFixed(1) }; } catch (e) {}
  try { indoor = !!h.isCurrentCellIndoor?.(); } catch (e) {}
  const curLB = cell >>> 16;
  // per-current-LB interior cells loaded + visible (cellContainers3d is a Map cellId->container)
  let curLbCells = 0, curLbCellVisMeshes = 0, totalCellContainers = 0;
  const cc = s3.cellContainers3d;
  if (cc && typeof cc.forEach === "function") cc.forEach((container, cid) => {
    totalCellContainers++;
    if (((cid >>> 0) >>> 16) === curLB) { curLbCells++; container.traverse(x => { if ((x.isMesh || x.isInstancedMesh) && x.visible) curLbCellVisMeshes++; }); }
  });
  // entity material health
  const ents = s3.entitiesGroup; let entRoots = 0, entMeshes = 0, withMap = 0, basic = 0; const matTypes = {};
  if (ents) {
    for (const c of ents.children) if ((c.name || "").startsWith("entity")) entRoots++;
    ents.traverse(x => { if (!(x.isMesh || x.isInstancedMesh)) return; entMeshes++;
      const mats = Array.isArray(x.material) ? x.material : [x.material];
      for (const m of mats) { if (!m) continue; matTypes[m.type] = (matTypes[m.type] || 0) + 1; if (m.map) withMap++; if (m.type === "MeshBasicMaterial") basic++; } });
  }
  return { cell: "0x" + cell.toString(16), pose, indoor, curLbCells, curLbCellVisMeshes, totalCellContainers,
    statics: grp("staticsGroup"), buildings: grp("buildingsGroup"), cells: grp("cellsGroup"), entities: grp("entitiesGroup"),
    entRoots, entMeshes, entWithMap: withMap, entBasic: basic, entMatTypes: matTypes,
    renderFrame: s3.renderer?.info?.render?.frame ?? null, geometries: s3.renderer?.info?.memory?.geometries ?? 0 };
}

async function ensureScene(page) {
  const t0 = Date.now(); let lastFrame = -1, stable = 0;
  while (Date.now() - t0 < SCENE_POLL_MS) {
    const s = await page.evaluate(() => { const s3 = window.liveScene3d; return { present: !!s3, children: s3?.scene?.children?.length ?? 0, frame: s3?.renderer?.info?.render?.frame ?? null, geo: s3?.renderer?.info?.memory?.geometries ?? 0 }; }).catch(() => ({}));
    if (s.present && s.children > 0 && Number.isFinite(s.frame)) { if (s.frame !== lastFrame) { lastFrame = s.frame; stable++; } if (stable >= 3 && s.geo > 5) return true; }
    await sleep(2000);
  }
  return false;
}
async function bootInWorld(page) {
  const t0 = Date.now(); let last = null;
  while (Date.now() - t0 < LOGIN_POLL_MS) {
    const s = await page.evaluate(() => { const h = window.__sessionHandle; let cell = 0; try { if (h?.getCurrentCellId) cell = h.getCurrentCellId() >>> 0; } catch (e) {} return { boot: window.__bootState || "none", cell }; }).catch(() => ({ boot: "evalerr" }));
    if (s.boot !== last) { log(`  boot=${s.boot} cell=0x${(s.cell || 0).toString(16)}`); last = s.boot; }
    if (s.boot === "in-world" && s.cell !== 0) return true;
    await sleep(2500);
  }
  return false;
}
async function teleportConfirm(page, loc) {
  const cmd = loc.how === "telepoi" ? `@telepoi ${loc.arg}` : `@teleloc ${loc.cell} ${loc.x} ${loc.y} ${loc.z}`;
  const want = loc.how === "teleloc" ? (parseInt(loc.cell, 16) >>> 0) >>> 16 : null;
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
  log(`genfix-verify-v2 on GTX 1070. pre-login gap ${PRELOGIN_GAP_MS / 1000}s ...`); await sleep(PRELOGIN_GAP_MS);
  const browser = await chromium.launch({ headless: true, executablePath: EXE, args: ["--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-gpu-rasterization", "--use-gl=angle", "--disable-dev-shm-usage", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"] });
  const consoleBuf = [];
  try {
    const page = await (await browser.newContext({ viewport: VIEWPORT })).newPage();
    page.on("console", m => { if (consoleBuf.length < 2000) consoleBuf.push(`${m.type()}: ${m.text()}`.slice(0, 240)); });
    page.on("pageerror", e => consoleBuf.push(`pageerror: ${e.message}`.slice(0, 240)));
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    report.renderer = await page.evaluate(() => { try { const c = document.createElement("canvas"); const gl = c.getContext("webgl2") || c.getContext("webgl"); const d = gl.getExtension("WEBGL_debug_renderer_info"); return d ? String(gl.getParameter(d.UNMASKED_RENDERER_WEBGL)) : "no-ext"; } catch (e) { return "err"; } }).catch(() => "err");
    report.realGpu = /NVIDIA|GTX 1070/i.test(report.renderer); log(`renderer: ${report.renderer}`);
    if (!await bootInWorld(page)) { report.fatal = "boot timeout"; report.consoleTail = consoleBuf.slice(-25); return; }
    await page.evaluate(() => { try { window.__sessionHandle?.sendChat?.("@god"); } catch (e) {} }).catch(() => {}); await sleep(2000);
    await ensureScene(page);

    for (const loc of LOCS) {
      const rec = { key: loc.key, expect: loc.expect };
      const errBefore = consoleBuf.filter(l => /^error:|pageerror:/.test(l)).length;
      rec.landedCell = await teleportConfirm(page, loc);
      log(`  landed=${rec.landedCell} — settle ${SETTLE_MS / 1000}s + wait-scene`);
      await sleep(SETTLE_MS);
      rec.sceneReady = await ensureScene(page);
      rec.cap = await page.evaluate(CAPTURE).catch(e => ({ err: String(e.message) }));
      rec.errDuring = consoleBuf.filter(l => /^error:|pageerror:/.test(l)).length - errBefore;
      try { await page.screenshot({ path: `${OUT}\\gf2-${loc.key}.png` }); rec.png = `gf2-${loc.key}.png`; } catch (e) {}
      const c = rec.cap || {};
      log(`  >>> ${loc.key}: cell=${c.cell} indoor=${c.indoor} curLbCells=${c.curLbCells} curLbCellVisMeshes=${c.curLbCellVisMeshes} entRoots=${c.entRoots} entMeshes=${c.entMeshes} basic=${c.entBasic} withMap=${c.entWithMap} staticsVis=${c.statics?.vis} err=${rec.errDuring}`);
      report.locs.push(rec); writeFileSync(`${OUT}\\genfix-v2-report.json`, JSON.stringify(report, null, 2));
    }
    report.consoleErrors = consoleBuf.filter(l => /^error:|pageerror:/.test(l)).length;
    report.consoleTail = consoleBuf.filter(l => /error|fail|white|fallback|missing|portal|envcell/i.test(l)).slice(-25);
  } catch (e) { report.fatal = String(e && e.message || e); log(`FATAL: ${report.fatal}`); }
  finally { try { await browser.close(); } catch (_) {} }
  writeFileSync(`${OUT}\\genfix-v2-report.json`, JSON.stringify(report, null, 2));
  log("=".repeat(70)); log(`GENFIX-V2 SUMMARY realGpu=${report.realGpu}`);
  for (const l of report.locs) { const c = l.cap || {}; log(`  ${l.key.padEnd(20)} landed=${(l.landedCell || "MISS").padEnd(12)} cell=${(c.cell || "?").padEnd(12)} indoor=${String(c.indoor).padEnd(5)} curLbCells=${c.curLbCells ?? "-"} cellVisMeshes=${c.curLbCellVisMeshes ?? "-"} entRoots=${c.entRoots ?? "-"} basic=${c.entBasic ?? "-"} err=${l.errDuring}`); }
  log("DONE");
}
main().catch(e => { report.topFatal = e?.stack?.slice(0, 400) || String(e); }).finally(() => { try { writeFileSync(`${OUT}\\genfix-v2-report.json`, JSON.stringify(report, null, 2)); } catch (_) {} process.exit(0); });
