// matwind2-1070.mjs — CORRECTED 1070 test (RUNS ON THE GTX 1070). Headless real GPU via ANGLE/D3D11.
//
// Fixes the v1 mistakes (per user + Explore agents):
//  • MATERIAL: test on a SPAWNED WEAPON (texchan target is item weenies, not buildings). Spawn the
//    UNPALETTED Weeping Staff (24205) — unpaletted items route through _installFromPixels→_attachRoughnessMap
//    (paletted items use a separate inline builder that SKIPS texchan). Also spawn the PALETTED Atlan Sword
//    (46088) to confirm the skip. DECISIVE check = roughnessMap/aoMap counted ON THE SPAWNED ITEM's meshes.
//  • WIND: v1 measured motion only by screenshot diff at a bad frame cadence + likely framed FROZEN trees.
//    Now: IN-PAGE motion verification (sample an anim-scenery node's deep-child world pos across RAF ticks)
//    + frame ONE near anim-scenery node up close + tight 5-frame burst @450ms (sway period ~1.33s).
//  • @create spawns IN THE WORLD (InFrontOf+EnterWorld), Developer access (phase4demo has it — @telepoi worked).
//  • No global THREE assumed (use matrixWorld.elements + Vector3 methods on existing objects).
//
//   node C:\Temp\matwind2-1070.mjs   (or --arms=staff-off,staff-on,wind-verify)
// Artifacts: C:\Temp\matwind2-report.json ; C:\Temp\m2-<arm>-*.png

import { chromium } from "playwright-core";
import { writeFileSync, readFileSync, existsSync } from "node:fs";

const EXE = "C:\\Users\\young\\AppData\\Local\\ms-playwright\\chromium-1223\\chrome-win64\\chrome.exe";
const OUT = "C:\\Temp";
const APP = "http://127.0.0.1:18765/apps/holtburger-web/index.html";
const COMMON = {
  renderer: "3d", quality: "mid",
  autoLogin: "1", account: "phase4demo", password: "phase4demo", autoSpawn: "first",
  renderDiag: "on", server_host: "127.0.0.1", server_port: "9000", bridge_url: "ws://100.116.47.66:8080/",
};
const ARMS = [
  { key: "staff-off", kind: "item", wcid: 24205, itemName: "Weeping Staff (unpaletted)", extra: { material: "off", windBake: "off" } },
  { key: "staff-on",  kind: "item", wcid: 24205, itemName: "Weeping Staff (unpaletted)", extra: { material: "on",  windBake: "off" }, also: { wcid: 46088, itemName: "Atlan Sword (paletted)" } },
  { key: "wind-verify", kind: "wind", extra: { windBake: "on", material: "off" } },
];

const ARM_FILTER = (process.argv.find(a => a.startsWith("--arms=")) || "").slice(7).split(",").map(s => s.trim()).filter(Boolean);
const PRELOGIN_GAP_MS = 25000, LOGIN_POLL_MS = 180000, TELE_POLL_MS = 70000, SCENE_POLL_MS = 90000, SETTLE_MS = 8000;
const VIEWPORT = { width: 1600, height: 900 };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

const REPORT_PATH = `${OUT}\\matwind2-report.json`;
const report = { ts: new Date().toISOString(), host: "GTX1070", app: APP, arms: [] };
if (existsSync(REPORT_PATH)) { try { const p = JSON.parse(readFileSync(REPORT_PATH, "utf8")); if (Array.isArray(p.arms)) report.arms = p.arms; } catch (e) {} }
function upsertArm(r) { const i = report.arms.findIndex(a => a.key === r.key); if (i >= 0) report.arms[i] = r; else report.arms.push(r); }

// ---- in-page helpers (stringified into page.evaluate) ----
function CLEAR_WEATHER_AND_FREEZE() {
  const s3 = window.liveScene3d, cs = s3?.cameraSwitcher;
  if (cs && typeof cs.tick === "function" && !cs.__frozen) { cs.__origTick = cs.tick; cs.tick = () => {}; cs.__frozen = true; }
  try { window.__setWeather && window.__setWeather({ is_storm: false, temperature_C: 18, dewpoint_C: -12, surface_pressure_hPa: 1030 }); } catch (e) {}
  return true;
}
// snapshot every mesh uuid currently in the scene (to diff after @create)
function MESH_UUIDS() {
  const s3 = window.liveScene3d, scene = s3?.scene; const ids = [];
  if (scene) scene.traverse(o => { if (o.isMesh || o.isInstancedMesh) ids.push(o.uuid); });
  return ids;
}
// find meshes that are NEW since the snapshot; return their world pos + material map state
function NEW_ITEM(prevIds) {
  const prev = new Set(prevIds);
  const s3 = window.liveScene3d, scene = s3?.scene; if (!scene) return { found: false };
  const fresh = [];
  scene.traverse(o => {
    if ((o.isMesh || o.isInstancedMesh) && !prev.has(o.uuid)) {
      o.updateMatrixWorld?.(); const e = o.matrixWorld.elements;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      let rough = 0, ao = 0, hasMap = 0; const matInfo = [];
      for (const m of mats) { if (!m) continue; if (m.roughnessMap) rough++; if (m.aoMap) ao++; if (m.map) hasMap++;
        matInfo.push({ type: m.type, roughness: m.roughness, metalness: m.metalness, hasMap: !!m.map, hasRough: !!m.roughnessMap, hasAo: !!m.aoMap }); }
      // ancestor name chain (to spot entity_<guid> roots)
      let p = o, chain = []; for (let i = 0; i < 5 && p; i++, p = p.parent) if (p.name) chain.push(p.name);
      fresh.push({ uuid: o.uuid.slice(0, 8), name: o.name || "", chain, pos: { x: +e[12].toFixed(1), y: +e[13].toFixed(1), z: +e[14].toFixed(1) }, rough, ao, hasMap, matInfo });
    }
  });
  return { found: fresh.length > 0, count: fresh.length, meshes: fresh };
}
// frame the camera close on a world point (item or tree), no global THREE
function FRAME_POINT(pt, dist) {
  const s3 = window.liveScene3d, cam = s3?.cameraSwitcher?.activeCamera ?? s3?.camera; if (!cam) return false;
  const d = dist || 2.5;
  cam.position.set(pt.x + d, pt.y + d * 0.6, pt.z + d);
  cam.lookAt(pt.x, pt.y, pt.z);
  cam.updateMatrixWorld?.();
  return true;
}
// WIND: collect anim-scenery nodes; verify motion in-page by sampling a deep child's world pos twice
function WIND_FIND() {
  const s3 = window.liveScene3d, scene = s3?.scene, cam = s3?.cameraSwitcher?.activeCamera ?? s3?.camera;
  if (!scene || !cam) return { ok: false };
  cam.updateMatrixWorld?.(); const ce = cam.matrixWorld.elements; const camPos = { x: ce[12], y: ce[13], z: ce[14] };
  const nodes = [];
  scene.traverse(o => { if (typeof o.name === "string" && o.name.startsWith("anim-scenery-")) { o.updateMatrixWorld?.(); const e = o.matrixWorld.elements; nodes.push({ node: o, pos: { x: e[12], y: e[13], z: e[14] } }); } });
  if (!nodes.length) return { ok: false, windNodes: 0 };
  nodes.sort((a, b) => ((a.pos.x - camPos.x) ** 2 + (a.pos.z - camPos.z) ** 2) - ((b.pos.x - camPos.x) ** 2 + (b.pos.z - camPos.z) ** 2));
  // sample deep-child world positions NOW (caller waits, then calls WIND_SAMPLE2)
  window.__windProbe = nodes.slice(0, 8).map(n => {
    let leaf = n.node; while (leaf.children && leaf.children.length) leaf = leaf.children[0];
    leaf.updateMatrixWorld?.(); const e = leaf.matrixWorld.elements;
    return { name: n.node.name, leaf, p0: { x: e[12], y: e[13], z: e[14] } };
  });
  const near = nodes[0].pos;
  return { ok: true, windNodes: nodes.length, nearest: { x: +near.x.toFixed(1), y: +near.y.toFixed(1), z: +near.z.toFixed(1) }, nearestDist: +Math.hypot(near.x - camPos.x, near.z - camPos.z).toFixed(1) };
}
function WIND_SAMPLE2() {
  const pr = window.__windProbe || []; let maxDelta = 0; const deltas = [];
  for (const w of pr) { const l = w.leaf; l.updateMatrixWorld?.(); const e = l.matrixWorld.elements;
    const dx = e[12] - w.p0.x, dy = e[13] - w.p0.y, dz = e[14] - w.p0.z; const d = Math.hypot(dx, dy, dz);
    deltas.push(+d.toFixed(4)); if (d > maxDelta) maxDelta = d; }
  return { maxDelta: +maxDelta.toFixed(4), deltas, moving: maxDelta > 0.002 };
}

async function bootInWorld(page, out) {
  let t0 = Date.now(), inWorld = false, last = null, reloaded = false;
  while (Date.now() - t0 < LOGIN_POLL_MS) {
    const s = await page.evaluate(() => { const h = window.__sessionHandle; let pose = null, cell = 0;
      try { if (h?.getLocalPlayerPose) { const p = h.getLocalPlayerPose(); if (p) pose = { x: +(+p.x).toFixed(1), y: +(+p.y).toFixed(1) }; } } catch (e) {}
      try { if (h?.getCurrentCellId) cell = h.getCurrentCellId() >>> 0; } catch (e) {}
      return { boot: window.__bootState || "none", pose, cell }; }).catch(() => ({ boot: "evalerr" }));
    if (s.boot !== last) { log(`  boot=${s.boot} cell=0x${(s.cell || 0).toString(16)}`); last = s.boot; }
    if (s.boot === "in-world" && s.pose && s.cell !== 0) { inWorld = true; out.spawnCell = "0x" + s.cell.toString(16); break; }
    if (!reloaded && s.boot === "error" && (Date.now() - t0) < 55000) { log(`  boot=error → reload retry`); await sleep(20000); try { await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }); } catch (e) {} reloaded = true; last = null; t0 = Date.now(); continue; }
    await sleep(2500);
  }
  out.inWorld = inWorld; return inWorld;
}
async function waitForScene(page) {
  const t0 = Date.now(); let lastFrame = -1, stable = 0;
  while (Date.now() - t0 < SCENE_POLL_MS) {
    const s = await page.evaluate(() => { const s3 = window.liveScene3d, r = s3?.renderer, sc = s3?.scene;
      return { present: !!s3, children: sc?.children?.length ?? 0, frame: r?.info?.render?.frame ?? null, geo: r?.info?.memory?.geometries ?? 0 }; }).catch(() => ({}));
    if (s.present && s.children > 0 && Number.isFinite(s.frame)) { if (s.frame !== lastFrame) { lastFrame = s.frame; stable++; } if (stable >= 3 && s.geo > 5) return true; }
    await sleep(2500);
  }
  return false;
}
async function teleportOutdoor(page) {
  await page.evaluate(() => { try { window.__sessionHandle?.sendChat?.("@telepoi Holtburg"); } catch (e) {} }).catch(() => {});
  const tt = Date.now();
  while (Date.now() - tt < TELE_POLL_MS) { const c = await page.evaluate(() => { try { return (window.__sessionHandle?.getCurrentCellId?.() >>> 0) || 0; } catch (e) { return 0; } }).catch(() => 0); if (c && (c & 0xFFFF) < 0x0100) return "0x" + c.toString(16); await sleep(2000); }
  return null;
}
async function spawnAndCapture(page, arm, spec, tag) {
  // returns the introspection for one @create
  const prev = await page.evaluate(MESH_UUIDS).catch(() => []);
  log(`  @create ${spec.wcid} (${spec.itemName}) — ${prev.length} meshes before`);
  await page.evaluate((w) => { try { window.__sessionHandle?.sendChat?.(`@create ${w}`); } catch (e) {} }, spec.wcid).catch(() => {});
  let info = { found: false };
  for (let i = 0; i < 8; i++) { await sleep(2000); info = await page.evaluate(NEW_ITEM, prev).catch(() => ({ found: false })); if (info.found) break; }
  const rec = { wcid: spec.wcid, itemName: spec.itemName, ...info };
  if (!info.found) { log(`  !! no new mesh after @create ${spec.wcid}`); return rec; }
  // pick the new mesh with the most submeshes/material info as the item; frame the cluster centroid of new meshes
  const cx = info.meshes.reduce((s, m) => s + m.pos.x / info.meshes.length, 0);
  const cy = info.meshes.reduce((s, m) => s + m.pos.y / info.meshes.length, 0);
  const cz = info.meshes.reduce((s, m) => s + m.pos.z / info.meshes.length, 0);
  const totalRough = info.meshes.reduce((s, m) => s + m.rough, 0), totalAo = info.meshes.reduce((s, m) => s + m.ao, 0);
  rec.itemPos = { x: +cx.toFixed(1), y: +cy.toFixed(1), z: +cz.toFixed(1) }; rec.itemRough = totalRough; rec.itemAo = totalAo;
  log(`  item: ${info.count} new meshes, roughnessMap=${totalRough} aoMap=${totalAo} | mat: ${JSON.stringify(info.meshes[0]?.matInfo?.[0] || {})}`);
  await page.evaluate(FRAME_POINT, { x: cx, y: cy, z: cz }, 2.5).catch(() => {});
  await sleep(1500);
  try { await page.screenshot({ path: `${OUT}\\m2-${arm.key}-${tag}.png` }); log(`  saved m2-${arm.key}-${tag}.png`); } catch (e) {}
  return rec;
}

async function runArm(arm) {
  const q = new URLSearchParams({ ...COMMON, ...arm.extra });
  const url = `${APP}?${q.toString()}`;
  const out = { key: arm.key, kind: arm.kind, extra: arm.extra, url };
  log("=".repeat(70)); log(`ARM ${arm.key} (${arm.kind}) ${JSON.stringify(arm.extra)}`);
  log(`  pre-login gap ${PRELOGIN_GAP_MS / 1000}s ...`); await sleep(PRELOGIN_GAP_MS);
  const browser = await chromium.launch({ headless: true, executablePath: EXE, args: ["--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-gpu-rasterization", "--use-gl=angle", "--disable-dev-shm-usage", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"] });
  const consoleBuf = [];
  try {
    const page = await (await browser.newContext({ viewport: VIEWPORT })).newPage();
    page.on("console", m => { if (consoleBuf.length < 800) consoleBuf.push(`${m.type()}: ${m.text()}`.slice(0, 260)); });
    page.on("pageerror", e => consoleBuf.push(`pageerror: ${e.message}`.slice(0, 260)));
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    out.renderer = await page.evaluate(() => { try { const c = document.createElement("canvas"); const gl = c.getContext("webgl2") || c.getContext("webgl"); const d = gl.getExtension("WEBGL_debug_renderer_info"); return d ? String(gl.getParameter(d.UNMASKED_RENDERER_WEBGL)).slice(0, 60) : "no-ext"; } catch (e) { return "err"; } }).catch(() => "err");
    log(`  renderer: ${out.renderer}`);
    if (!await bootInWorld(page, out)) { out.consoleTail = consoleBuf.slice(-20); return out; }
    out.outdoorCell = await teleportOutdoor(page); log(`  outdoor ${out.outdoorCell}`);
    log(`  wait-for-scene ...`); out.sceneReady = await waitForScene(page); log(`  scene ready=${out.sceneReady}`);
    await sleep(SETTLE_MS);
    await page.evaluate(CLEAR_WEATHER_AND_FREEZE).catch(() => {});
    await sleep(2500); // let rain drain

    if (arm.kind === "item") {
      out.items = [];
      out.items.push(await spawnAndCapture(page, arm, { wcid: arm.wcid, itemName: arm.itemName }, "staff"));
      if (arm.also) out.items.push(await spawnAndCapture(page, arm, arm.also, "sword"));
    } else { // wind-verify
      const wf = await page.evaluate(WIND_FIND).catch(e => ({ ok: false, err: String(e.message) }));
      out.windFind = wf; log(`  wind find: ${JSON.stringify(wf)}`);
      if (wf.ok) {
        await sleep(180); // let RAF advance ~10 frames between samples
        const s2 = await page.evaluate(WIND_SAMPLE2).catch(e => ({ err: String(e.message) }));
        out.windMotion = s2; log(`  >>> WIND MOTION: maxDelta=${s2.maxDelta} moving=${s2.moving} deltas=${JSON.stringify(s2.deltas)}`);
        // frame the nearest node up close + tight burst @450ms (sway period ~1.33s)
        await page.evaluate(FRAME_POINT, wf.nearest, 6).catch(() => {});
        await sleep(1200);
        for (let i = 0; i < 5; i++) { try { await page.screenshot({ path: `${OUT}\\m2-windverify-f${i}.png` }); } catch (e) {} await sleep(450); }
        log(`  saved m2-windverify-f0..f4.png (tight burst @450ms)`);
      }
      // also grab the build/dropped cap log
      out.windLog = consoleBuf.filter(l => /anim-scenery|tree-wind|DROPPED|built \d/i.test(l)).slice(-6);
    }
    out.consoleErrors = consoleBuf.filter(l => /^error:|pageerror:/.test(l)).length;
    out.consoleTail = consoleBuf.filter(l => /error|fail|create|spawn|texchan|rough/i.test(l)).slice(-15);
    log(`  consoleErrors=${out.consoleErrors}`);
  } catch (e) { out.fatal = String(e && e.message || e); log(`  FATAL: ${out.fatal}`); }
  finally { try { await browser.close(); } catch (_) {} await sleep(2000); }
  return out;
}

async function main() {
  const arms = ARM_FILTER.length ? ARMS.filter(a => ARM_FILTER.includes(a.key)) : ARMS;
  log(`matwind2 CORRECTED test on GTX 1070. arms: ${arms.map(a => a.key).join(", ")}`);
  for (const arm of arms) { const r = await runArm(arm); upsertArm(r); writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2)); }
  log("=".repeat(78)); log("MATWIND2 SUMMARY");
  for (const a of report.arms) {
    if (a.kind === "item") for (const it of (a.items || [])) log(`  ${a.key.padEnd(10)} ${it.itemName.padEnd(26)} newMeshes=${it.count ?? 0} roughnessMap=${it.itemRough ?? "-"} aoMap=${it.itemAo ?? "-"}`);
    else log(`  ${a.key.padEnd(10)} windNodes=${a.windFind?.windNodes} MOVING=${a.windMotion?.moving} maxDelta=${a.windMotion?.maxDelta}`);
  }
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2)); log(`report -> ${REPORT_PATH}`); log("DONE");
}
main().catch(e => { log("TOP FATAL:", e?.stack?.slice(0, 400) || e); try { writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2)); } catch (_) {} }).finally(() => process.exit(0));
