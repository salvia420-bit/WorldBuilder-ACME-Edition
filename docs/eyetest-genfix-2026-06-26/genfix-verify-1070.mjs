// genfix-verify-1070.mjs — validates the per-landblock-faithful data fixes RENDER on the real GTX 1070.
// Headless real GPU via ANGLE/D3D11. Boots ONCE, then teleports between locations and captures
// scene-graph + entity material health + a screenshot at each. Live-ACE path (spawns arrive over
// the wire from the same ACE DB we staged from), so a populated dungeon/town here validates the
// RENDER pipeline (interiors, monsters, portals, no white-box / barren) against known-populated LBs.
//
//   "C:\Program Files\nodejs\node.exe" C:\Temp\genfix-verify-1070.mjs
// Run from the laptop with a reverse tunnel so the box's chromium reaches laptop serve.py:
//   ssh -R 18765:127.0.0.1:8765 <user>@<gpu-box-ip> '"C:\Program Files\nodejs\node.exe" C:\Temp\genfix-verify-1070.mjs'
// Artifacts: C:\Temp\genfix-report.json + C:\Temp\gf-<loc>.png

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
// Each location: teleport via @telepoi (POI) or @teleloc <cellHex> <x> <y> <z>, then capture.
const LOCS = [
  { key: "town-holtburg", how: "telepoi", arg: "Holtburg", expect: "portals(oriented)+NPCs+ambient+buildings" },
  { key: "cottage-interior", how: "teleloc", cell: "0xA9B40100", x: 88, y: 131, z: 67, expect: "interior walls + stabs (known-good drop)" },
  { key: "dungeon-0x00B4", how: "teleloc", cell: "0x00B4016A", x: 30, y: -1560, z: 0.1, expect: "810 generator monsters + deep interior" },
  { key: "combat-0xAB94", how: "teleloc", cell: "0xAB940000", x: 96, y: 96, z: 120, expect: "outdoor monsters render (no white-box)" },
];

const LOGIN_POLL_MS = 180000, TELE_POLL_MS = 70000, SETTLE_MS = 14000, PRELOGIN_GAP_MS = 25000;
const VIEWPORT = { width: 1600, height: 900 };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const report = { ts: new Date().toISOString(), host: "GTX1070", app: APP, locs: [] };

// ---- in-page capture (stringified into page.evaluate) ----
function CAPTURE() {
  const s3 = window.liveScene3d; if (!s3) return { err: "no liveScene3d" };
  const grp = (name) => {
    const o = s3[name]; if (!o) return { present: false };
    let meshes = 0, vis = 0; o.traverse(x => { if (x.isMesh || x.isInstancedMesh) { meshes++; if (x.visible) vis += (x.isInstancedMesh ? (x.count || 1) : 1); } });
    return { present: true, children: o.children?.length ?? 0, meshes, vis };
  };
  // entity material health (white-box = MeshBasicMaterial / white emissive / no map fallback)
  const ents = s3.entitiesGroup; let entRoots = 0, entMeshes = 0, withMap = 0, whiteBoxish = 0; const matTypes = {};
  if (ents) {
    for (const c of ents.children) { const n = c.name || ""; if (n.startsWith("entity")) entRoots++; }
    ents.traverse(x => {
      if (!(x.isMesh || x.isInstancedMesh)) return; entMeshes++;
      const mats = Array.isArray(x.material) ? x.material : [x.material];
      for (const m of mats) {
        if (!m) continue; matTypes[m.type] = (matTypes[m.type] || 0) + 1;
        if (m.map) withMap++;
        const col = m.color ? (m.color.r + m.color.g + m.color.b) / 3 : 0;
        const isBasic = m.type === "MeshBasicMaterial";
        const whiteNoMap = !m.map && col > 0.92;
        if (isBasic || whiteNoMap) whiteBoxish++;
      }
    });
  }
  const h = window.__sessionHandle; let cell = 0, pose = null, indoor = null;
  try { cell = h.getCurrentCellId() >>> 0; } catch (e) {}
  try { const p = h.getLocalPlayerPose(); if (p) pose = { x: +(+p.x).toFixed(1), y: +(+p.y).toFixed(1), z: +(+p.z).toFixed(1) }; } catch (e) {}
  try { indoor = !!h.isCurrentCellIndoor?.(); } catch (e) {}
  return {
    cell: "0x" + cell.toString(16), pose, indoor,
    statics: grp("staticsGroup"), buildings: grp("buildingsGroup"), cells: grp("cellsGroup"), entities: grp("entitiesGroup"),
    entRoots, entMeshes, entWithMap: withMap, entWhiteBoxish: whiteBoxish, entMatTypes: matTypes,
    sceneChildren: s3.scene?.children?.length ?? 0, renderFrame: s3.renderer?.info?.render?.frame ?? null,
    geometries: s3.renderer?.info?.memory?.geometries ?? 0,
  };
}

async function bootInWorld(page) {
  const t0 = Date.now(); let last = null;
  while (Date.now() - t0 < LOGIN_POLL_MS) {
    const s = await page.evaluate(() => {
      const h = window.__sessionHandle; let cell = 0;
      try { if (h?.getCurrentCellId) cell = h.getCurrentCellId() >>> 0; } catch (e) {}
      return { boot: window.__bootState || "none", cell };
    }).catch(() => ({ boot: "evalerr" }));
    if (s.boot !== last) { log(`  boot=${s.boot} cell=0x${(s.cell || 0).toString(16)}`); last = s.boot; }
    if (s.boot === "in-world" && s.cell !== 0) return true;
    await sleep(2500);
  }
  return false;
}
async function teleportTo(page, loc) {
  const cmd = loc.how === "telepoi" ? `@telepoi ${loc.arg}` : `@teleloc ${loc.cell} ${loc.x} ${loc.y} ${loc.z}`;
  log(`  ${loc.key}: ${cmd}`);
  await page.evaluate((c) => { try { window.__sessionHandle?.sendChat?.(c); } catch (e) {} }, cmd).catch(() => {});
  const want = loc.how === "teleloc" ? (parseInt(loc.cell, 16) >>> 0) : null;
  const t0 = Date.now();
  while (Date.now() - t0 < TELE_POLL_MS) {
    const c = await page.evaluate(() => { try { return (window.__sessionHandle?.getCurrentCellId?.() >>> 0) || 0; } catch (e) { return 0; } }).catch(() => 0);
    if (loc.how === "telepoi") { if (c && (c & 0xffff) < 0x100) return "0x" + c.toString(16); }
    else { if (c && (c >>> 16) === (want >>> 16)) return "0x" + c.toString(16); } // landed in the target LB
    await sleep(2000);
  }
  return null;
}

async function main() {
  const q = new URLSearchParams(COMMON);
  const url = `${APP}?${q.toString()}`;
  log(`genfix-verify on GTX 1070. pre-login gap ${PRELOGIN_GAP_MS / 1000}s ...`);
  await sleep(PRELOGIN_GAP_MS);
  const browser = await chromium.launch({ headless: true, executablePath: EXE, args: ["--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-gpu-rasterization", "--use-gl=angle", "--disable-dev-shm-usage", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"] });
  const consoleBuf = [];
  try {
    const page = await (await browser.newContext({ viewport: VIEWPORT })).newPage();
    page.on("console", m => { if (consoleBuf.length < 1500) consoleBuf.push(`${m.type()}: ${m.text()}`.slice(0, 240)); });
    page.on("pageerror", e => consoleBuf.push(`pageerror: ${e.message}`.slice(0, 240)));
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    report.renderer = await page.evaluate(() => { try { const c = document.createElement("canvas"); const gl = c.getContext("webgl2") || c.getContext("webgl"); const d = gl.getExtension("WEBGL_debug_renderer_info"); return d ? String(gl.getParameter(d.UNMASKED_RENDERER_WEBGL)) : "no-ext"; } catch (e) { return "err"; } }).catch(() => "err");
    log(`renderer: ${report.renderer}`);
    report.realGpu = /NVIDIA|GTX 1070/i.test(report.renderer);
    if (!await bootInWorld(page)) { report.fatal = "boot timeout"; report.consoleTail = consoleBuf.slice(-25); return; }
    await page.evaluate(() => { try { window.__sessionHandle?.sendChat?.("@god"); } catch (e) {} }).catch(() => {}); // no fall damage
    await sleep(2000);

    for (const loc of LOCS) {
      const rec = { key: loc.key, expect: loc.expect };
      const errBefore = consoleBuf.filter(l => /^error:|pageerror:/.test(l)).length;
      rec.landedCell = await teleportTo(page, loc);
      log(`  landed=${rec.landedCell} — settle ${SETTLE_MS / 1000}s`);
      await sleep(SETTLE_MS);
      rec.cap = await page.evaluate(CAPTURE).catch(e => ({ err: String(e.message) }));
      rec.errDuring = consoleBuf.filter(l => /^error:|pageerror:/.test(l)).length - errBefore;
      try { await page.screenshot({ path: `${OUT}\\gf-${loc.key}.png` }); rec.png = `gf-${loc.key}.png`; } catch (e) {}
      const c = rec.cap || {};
      log(`  >>> ${loc.key}: cell=${c.cell} indoor=${c.indoor} entRoots=${c.entRoots} entMeshes=${c.entMeshes} whiteBoxish=${c.entWhiteBoxish} withMap=${c.entWithMap} cells.meshes=${c.cells?.meshes} statics.vis=${c.statics?.vis} errDuring=${rec.errDuring}`);
      report.locs.push(rec);
      writeFileSync(`${OUT}\\genfix-report.json`, JSON.stringify(report, null, 2));
    }
    report.consoleErrors = consoleBuf.filter(l => /^error:|pageerror:/.test(l)).length;
    report.consoleTail = consoleBuf.filter(l => /error|fail|white|fallback|missing|spawn|portal|envcell|cell/i.test(l)).slice(-25);
  } catch (e) { report.fatal = String(e && e.message || e); log(`FATAL: ${report.fatal}`); }
  finally { try { await browser.close(); } catch (_) {} }

  writeFileSync(`${OUT}\\genfix-report.json`, JSON.stringify(report, null, 2));
  log("=".repeat(70)); log("GENFIX-VERIFY SUMMARY"); log(`renderer realGpu=${report.realGpu}`);
  for (const l of report.locs) { const c = l.cap || {}; log(`  ${l.key.padEnd(18)} cell=${(c.cell || "?").padEnd(12)} indoor=${c.indoor} entRoots=${c.entRoots ?? "-"} entMeshes=${c.entMeshes ?? "-"} whiteBox=${c.entWhiteBoxish ?? "-"} cellMeshes=${c.cells?.meshes ?? "-"} staticsVis=${c.statics?.vis ?? "-"} err=${l.errDuring}`); }
  log("DONE");
}
main().catch(e => { report.topFatal = e?.stack?.slice(0, 400) || String(e); }).finally(() => { try { writeFileSync(`${OUT}\\genfix-report.json`, JSON.stringify(report, null, 2)); } catch (_) {} process.exit(0); });
