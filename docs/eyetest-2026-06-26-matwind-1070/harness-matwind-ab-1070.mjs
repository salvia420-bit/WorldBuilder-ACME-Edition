// matwind-ab-1070.mjs — RUNS ON THE GTX 1070 (young@desktop). Headless, REAL GPU via ANGLE/D3D11.
//
// Batched VISUAL A/B eye-test for the two default-ON bake features SwiftShader can't validate:
//   PAIR "material" (Phase 5): roughnessMap+aoMap detail bake — mat-off vs mat-on (windBake held OFF)
//   PAIR "wind"     (Phase 4): tree-wind from baked .windclip — wind-synth vs wind-bake (material held OFF)
//
// Deliverables (not perf): per-arm follow-cam screenshot + best-effort textured close-up + scene-graph
// introspection (program count, # materials carrying roughnessMap/aoMap, scenery mesh count) + console
// error/404 tally. Wind arms grab a 3-frame burst (~1.2s apart) so sway is visible in stills.
//
// App via laptop reverse tunnel 127.0.0.1:18765 -> serve.py:8765 ; wsbridge ws://100.116.47.66:8080 (tailscale).
// Fresh browser per arm (no GPU/material-cache leak). Same account every arm => 25s pre-login release gap.
//
//   node C:\Temp\matwind-ab-1070.mjs            (all 4 arms)
//   node C:\Temp\matwind-ab-1070.mjs --arms=mat-off,mat-on
//
// Artifacts on the 1070: C:\Temp\matwind-ab-report.json ; C:\Temp\matwind-<arm>-{follow,close,f0,f1,f2}.png

import { chromium } from "playwright-core";
import { writeFileSync, readFileSync, existsSync } from "node:fs";

const EXE = "C:\\Users\\young\\AppData\\Local\\ms-playwright\\chromium-1223\\chrome-win64\\chrome.exe";
const OUT = "C:\\Temp";
const APP = "http://127.0.0.1:18765/apps/holtburger-web/index.html";
const COMMON = {
  renderer: "3d", quality: "mid",
  autoLogin: "1", account: "phase4demo", password: "phase4demo", autoSpawn: "first",
  renderDiag: "on",
  server_host: "127.0.0.1", server_port: "9000", bridge_url: "ws://100.116.47.66:8080/",
};
const ARMS = [
  { key: "mat-off",    pair: "material", extra: { material: "off", windBake: "off" } },
  { key: "mat-on",     pair: "material", extra: { material: "on",  windBake: "off" } },
  { key: "wind-synth", pair: "wind",     extra: { windBake: "off", material: "off" } },
  { key: "wind-bake",  pair: "wind",     extra: { windBake: "on",  material: "off" } },
];

const ARM_FILTER = (process.argv.find(a => a.startsWith("--arms=")) || "").slice(7).split(",").map(s => s.trim()).filter(Boolean);
const PRELOGIN_GAP_MS = 25000;
const LOGIN_POLL_MS = 180000;
const TELE_POLL_MS  = 70000;
const SCENE_POLL_MS = 90000;   // wait for the teleport-destination LB to stream + first real frame
const SETTLE_MS     = 8000;    // small extra settle after scene-ready (statics/material-cache warm)
const VIEWPORT = { width: 1600, height: 900 };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

const REPORT_PATH = `${OUT}\\matwind-ab-report.json`;
const report = { ts: new Date().toISOString(), host: "GTX1070", app: APP, arms: [] };
if (existsSync(REPORT_PATH)) { try { const p = JSON.parse(readFileSync(REPORT_PATH, "utf8")); if (Array.isArray(p.arms)) report.arms = p.arms; } catch (e) {} }
function upsertArm(r) {
  const i = report.arms.findIndex(a => a.key === r.key);
  if (i >= 0) report.arms[i] = r; else report.arms.push(r);
  const order = ARMS.map(a => a.key);
  report.arms.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
}

// ---- in-page probes (no global THREE needed; use object methods + raw matrix elements) ----
function PROBE_SCENE() {
  // returns scene-graph introspection: program count, map-attach counts, scenery counts
  const s3 = window.liveScene3d;
  const scene = s3?.scene ?? s3?.rootScene ?? s3?.world ?? null;
  const r = s3?.renderer;
  const out = { hasScene: !!scene, hasRenderer: !!r };
  try { out.programs = r?.info?.programs?.length ?? null; out.geometries = r?.info?.memory?.geometries ?? null; out.textures = r?.info?.memory?.textures ?? null; } catch (e) {}
  if (!scene) return out;
  let meshes = 0, withRough = 0, withAo = 0, withMap = 0, chromeRisk = 0;
  let windNodes = 0, instancedMeshes = 0;
  const windDids = new Set();
  const seenMat = new Set();
  scene.traverse(o => {
    // winding trees are THREE.Group nodes named anim-scenery-0x<did> (peeled out of the frozen
    // instanced statics). Counting them = how many trees ACTUALLY wind vs stay frozen-instanced.
    if (typeof o.name === "string" && o.name.startsWith("anim-scenery-")) {
      windNodes++; const m = o.name.match(/0x[0-9a-f]+/i); if (m) windDids.add(m[0]);
    }
    if (o.isInstancedMesh) instancedMeshes++;
    if (!o.isMesh && !o.isInstancedMesh) return;
    meshes++;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m || seenMat.has(m.uuid)) continue; seenMat.add(m.uuid);
      if (m.map) withMap++;
      if (m.roughnessMap) withRough++;
      if (m.aoMap) withAo++;
      // a "chrome risk" = a PBR material that ended up near-mirror (low roughness + metalness)
      if (typeof m.roughness === "number" && m.roughness < 0.15 && (m.metalness ?? 0) > 0.5) chromeRisk++;
    }
  });
  out.meshes = meshes; out.uniqueMaterials = seenMat.size; out.instancedMeshes = instancedMeshes;
  out.withMap = withMap; out.withRoughnessMap = withRough; out.withAoMap = withAo; out.chromeRiskMats = chromeRisk;
  out.windNodes = windNodes; out.windDids = [...windDids];
  try { if (typeof window.animatedSceneryDiag === "function") out.animDiag = window.animatedSceneryDiag(); } catch (e) {}
  return out;
}

function FREEZE_AND_FRAME(mode) {
  // freeze the follow camera; for mode="close" reframe onto the nearest big textured mesh in front.
  const s3 = window.liveScene3d;
  const cs = s3?.cameraSwitcher;
  const cam = cs?.activeCamera ?? s3?.camera;
  const scene = s3?.scene ?? s3?.rootScene ?? s3?.world ?? null;
  if (cs && typeof cs.tick === "function" && !cs.__frozen) { cs.__origTick = cs.tick; cs.tick = () => {}; cs.__frozen = true; }
  // kill rain: non-storm + dry (big T-Td spread) + high pressure (__setWeather takes a partial state OBJECT)
  try { window.__setWeather && window.__setWeather({ is_storm: false, temperature_C: 18, dewpoint_C: -10, surface_pressure_hPa: 1030 }); } catch (e) {}
  if (!cam || !scene) return { reframed: false };

  if (mode === "trees") {
    // aim at the nearest cluster of ACTUALLY-WINDING trees (anim-scenery-* nodes), wherever they are
    cam.updateMatrixWorld?.();
    const e = cam.matrixWorld.elements; const camPos = { x: e[12], y: e[13], z: e[14] };
    const pts = [];
    scene.traverse(o => {
      if (typeof o.name === "string" && o.name.startsWith("anim-scenery-")) {
        o.updateMatrixWorld?.(); const me = o.matrixWorld.elements;
        pts.push({ x: me[12], y: me[13], z: me[14] });
      }
    });
    if (!pts.length) return { reframed: false, why: "no anim-scenery (winding) nodes in scene", windNodes: 0 };
    pts.sort((a, b) => ((a.x - camPos.x) ** 2 + (a.z - camPos.z) ** 2) - ((b.x - camPos.x) ** 2 + (b.z - camPos.z) ** 2));
    const K = Math.min(10, pts.length); const near = pts.slice(0, K);
    const C = near.reduce((s, p) => ({ x: s.x + p.x / K, y: s.y + p.y / K, z: s.z + p.z / K }), { x: 0, y: 0, z: 0 });
    // view the cluster from the town side (dir C->camPos), ~18m back + 7m up, look slightly down
    let dx = camPos.x - C.x, dz = camPos.z - C.z; let dl = Math.hypot(dx, dz) || 1;
    cam.position.set(C.x + (dx / dl) * 18, C.y + 7, C.z + (dz / dl) * 18);
    cam.lookAt(C.x, C.y + 2, C.z);
    cam.updateMatrixWorld?.();
    const nearDist = Math.hypot(near[0].x - camPos.x, near[0].z - camPos.z);
    return { reframed: true, mode: "trees", cluster: { x: +C.x.toFixed(1), y: +C.y.toFixed(1), z: +C.z.toFixed(1) }, nodesTotal: pts.length, nearestDist: +nearDist.toFixed(1) };
  }

  if (mode !== "close") return { reframed: false };
  // camera world position + forward (-Z col of matrixWorld), no THREE globals
  cam.updateMatrixWorld?.();
  const e = cam.matrixWorld.elements;
  const camPos = { x: e[12], y: e[13], z: e[14] };
  const fwd = { x: -e[8], y: -e[9], z: -e[10] };
  let best = null;
  scene.traverse(o => {
    if (!o.isMesh && !o.isInstancedMesh) return;
    // skip the player/entities/animated scenery so the close-up lands on building/static surfaces
    let p = o, skip = false;
    for (let i = 0; i < 6 && p; i++, p = p.parent) {
      const n = (p.name || "");
      if (/lifestone|life.?stone|portal|nameplate|sprite|entit|player|anim-scenery|billboard/i.test(n)) { skip = true; break; }
    }
    if (skip) return;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    if (!m || !m.map) return;                 // textured surfaces only
    // exclude luminous / translucent surfaces (lifestone, glows, glass) — they carry no baked detail
    if (m.transparent === true || (m.opacity != null && m.opacity < 0.95)) return;
    const em = m.emissive; if (em && (em.r > 0.05 || em.g > 0.05 || em.b > 0.05) && (m.emissiveIntensity ?? 1) > 0.05) return;
    const g = o.geometry; if (!g) return;
    if (!g.boundingSphere) { try { g.computeBoundingSphere(); } catch (_) {} }
    const bs = g.boundingSphere; if (!bs) return;
    const c = bs.center.clone().applyMatrix4(o.matrixWorld);   // Vector3 methods, no global THREE
    const me = o.matrixWorld.elements;
    const sx = Math.hypot(me[0], me[1], me[2]);
    const r = bs.radius * (isFinite(sx) ? sx : 1);
    if (!(r > 2 && r < 18)) return;            // building-wall sized, not props/facets
    const dx = c.x - camPos.x, dy = c.y - camPos.y, dz = c.z - camPos.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 3 || dist > 50) return;
    // favor BIG, near textured walls; framing flips the camera to the wall regardless of current facing
    const score = dist - r * 4;
    if (!best || score < best.score) best = { score, c: { x: c.x, y: c.y, z: c.z }, r };
  });
  if (!best) return { reframed: false, why: "no building-scale textured wall nearby" };
  // pull camera back along (camPos->C) reversed, frame the whole sphere
  const dx = camPos.x - best.c.x, dy = camPos.y - best.c.y, dz = camPos.z - best.c.z;
  const dlen = Math.hypot(dx, dy, dz) || 1;
  const back = best.r * 2.6;
  cam.position.set(best.c.x + (dx / dlen) * back, best.c.y + (dy / dlen) * back + best.r * 0.25, best.c.z + (dz / dlen) * back);
  cam.lookAt(best.c.x, best.c.y, best.c.z);
  cam.updateMatrixWorld?.();
  return { reframed: true, target: best.c, radius: +best.r.toFixed(2) };
}

async function waitForScene(page, out) {
  // poll until liveScene3d exists, scene has children, AND the renderer has advanced
  // frames (proves the world actually drew, not just init). Returns a readiness report.
  const t0 = Date.now(); let last = "", ready = false, lastFrame = -1, stableFrames = 0;
  while (Date.now() - t0 < SCENE_POLL_MS) {
    const s = await page.evaluate(() => {
      const s3 = window.liveScene3d;
      const r = s3?.renderer, scene = s3?.scene;
      const keys = Object.keys(window).filter(k => /scene|live|diag|wasm|hb/i.test(k)).slice(0, 25);
      return {
        present: !!s3, hasScene: !!scene, hasRenderer: !!r,
        children: scene?.children?.length ?? null,
        frame: (r?.info?.render?.frame) ?? null,
        geometries: r?.info?.memory?.geometries ?? null,
        textures: r?.info?.memory?.textures ?? null,
        programs: r?.info?.programs?.length ?? null,
        terrainMats: s3?.terrainMaterials?.length ?? null,
        globals: keys,
      };
    }).catch(e => ({ err: String(e.message) }));
    const tag = `present=${s.present} children=${s.children} frame=${s.frame} geo=${s.geometries} tMat=${s.terrainMats}`;
    if (tag !== last) { log(`  scene: ${tag}`); last = tag; if (s.globals) out.globals = s.globals; }
    if (s.present && s.children > 0 && Number.isFinite(s.frame)) {
      if (s.frame !== lastFrame) { lastFrame = s.frame; stableFrames++; }
      // require a few advancing frames + some geometry actually uploaded
      if (stableFrames >= 3 && (s.geometries ?? 0) > 5) { ready = true; out.sceneAtReady = s; break; }
    }
    await sleep(2500);
  }
  out.sceneReady = ready; out.sceneWaitSec = +((Date.now() - t0) / 1000).toFixed(1);
  if (!ready) out.sceneAtReady = await page.evaluate(() => { const s3 = window.liveScene3d; return { present: !!s3, keys: Object.keys(s3 || {}).slice(0, 50), bootState: window.__bootState }; }).catch(() => null);
  return ready;
}

async function bootInWorld(page, out, consoleBuf) {
  let t0 = Date.now(), inWorld = false, last = null, reloaded = false;
  while (Date.now() - t0 < LOGIN_POLL_MS) {
    const s = await page.evaluate(() => {
      const h = window.__sessionHandle; let pose = null, cell = 0;
      try { if (h?.getLocalPlayerPose) { const p = h.getLocalPlayerPose(); if (p) pose = { x: +(+p.x).toFixed(1), y: +(+p.y).toFixed(1) }; } } catch (e) {}
      try { if (h?.getCurrentCellId) cell = h.getCurrentCellId() >>> 0; } catch (e) {}
      return { boot: window.__bootState || "none", pose, cell };
    }).catch(() => ({ boot: "evalerr" }));
    if (s.boot !== last) { log(`  boot=${s.boot} pose=${s.pose ? s.pose.x + "," + s.pose.y : "-"} cell=0x${(s.cell || 0).toString(16)}`); last = s.boot; }
    if (s.boot === "in-world" && s.pose && s.cell !== 0) { inWorld = true; out.spawnCell = "0x" + s.cell.toString(16); break; }
    if (!reloaded && s.boot === "error" && (Date.now() - t0) < 55000) {
      log(`  boot=error early -> 20s + reload (session-release retry)`);
      await sleep(20000); try { await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }); } catch (e) {}
      reloaded = true; last = null; t0 = Date.now(); continue;
    }
    await sleep(2500);
  }
  out.inWorld = inWorld; out.loginSec = +((Date.now() - t0) / 1000).toFixed(1);
  return inWorld;
}

async function runArm(arm) {
  const q = new URLSearchParams({ ...COMMON, ...arm.extra });
  const url = `${APP}?${q.toString()}`;
  const out = { key: arm.key, pair: arm.pair, extra: arm.extra, url };
  log("=".repeat(70));
  log(`ARM ${arm.key} (${arm.pair}) — ${JSON.stringify(arm.extra)}`);
  log(`  pre-login gap ${PRELOGIN_GAP_MS / 1000}s (ACE release prior ${COMMON.account}) ...`);
  await sleep(PRELOGIN_GAP_MS);
  const browser = await chromium.launch({
    headless: true, executablePath: EXE,
    args: ["--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-gpu-rasterization", "--use-gl=angle",
           "--disable-dev-shm-usage", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"],
  });
  const consoleBuf = [];
  try {
    const page = await (await browser.newContext({ viewport: VIEWPORT })).newPage();
    page.on("console", m => { if (consoleBuf.length < 600) consoleBuf.push(`${m.type()}: ${m.text()}`.slice(0, 260)); });
    page.on("pageerror", e => consoleBuf.push(`pageerror: ${e.message}`.slice(0, 260)));
    page.on("requestfailed", r => { const u = r.url(); if (/\.(bin|texchan|windclip)/.test(u) || /suite/.test(u)) consoleBuf.push(`requestfailed: ${u.slice(-80)} ${r.failure()?.errorText || ""}`); });

    log(`goto ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    out.renderer = await page.evaluate(() => { try { const c = document.createElement("canvas"); const gl = c.getContext("webgl2") || c.getContext("webgl"); const d = gl.getExtension("WEBGL_debug_renderer_info"); return d ? String(gl.getParameter(d.UNMASKED_RENDERER_WEBGL)) : "no-ext"; } catch (e) { return "err:" + e.message; } }).catch(e => "err");
    log(`renderer: ${out.renderer}`);

    if (!await bootInWorld(page, out, consoleBuf)) { log(`  !! no in-world in ${out.loginSec}s`); out.consoleTail = consoleBuf.slice(-30); return out; }
    log(`  in-world ${out.loginSec}s cell ${out.spawnCell}`);

    await page.evaluate(() => { try { window.__sessionHandle?.sendChat?.("@telepoi Holtburg"); } catch (e) {} }).catch(() => {});
    const tt = Date.now(); let outdoor = false;
    while (Date.now() - tt < TELE_POLL_MS) {
      const c = await page.evaluate(() => { try { return (window.__sessionHandle?.getCurrentCellId?.() >>> 0) || 0; } catch (e) { return 0; } }).catch(() => 0);
      if (c && (c & 0xFFFF) < 0x0100) { outdoor = true; out.outdoorCell = "0x" + c.toString(16); break; }
      await sleep(2000);
    }
    out.outdoor = outdoor;
    log(outdoor ? `  outdoor ${out.outdoorCell}` : `  !! still indoor after telepoi`);

    log(`  wait-for-scene (LB stream + first frames, <=${SCENE_POLL_MS / 1000}s) ...`);
    const ready = await waitForScene(page, out);
    log(ready ? `  scene READY in ${out.sceneWaitSec}s` : `  !! scene NOT ready after ${out.sceneWaitSec}s (globals: ${JSON.stringify(out.globals)})`);
    log(`  settle ${SETTLE_MS / 1000}s ...`);
    await sleep(SETTLE_MS);

    // diag snapshot (after warm)
    out.diag = await page.evaluate(PROBE_SCENE).catch(e => ({ err: String(e.message) }));
    log(`  diag: ${JSON.stringify(out.diag)}`);

    // FOLLOW shot (frozen cam, identical framing across the pair)
    await page.evaluate(FREEZE_AND_FRAME, "follow").catch(() => {});
    await sleep(1500);
    try { await page.screenshot({ path: `${OUT}\\matwind-${arm.key}-follow.png` }); log(`  saved ${arm.key}-follow.png`); } catch (e) { log("  follow shot err", e.message); }

    if (arm.pair === "material") {
      // best-effort textured close-up
      const fr = await page.evaluate(FREEZE_AND_FRAME, "close").catch(e => ({ reframed: false, err: String(e.message) }));
      out.closeFrame = fr; log(`  close reframe: ${JSON.stringify(fr)}`);
      await sleep(1200);
      try { await page.screenshot({ path: `${OUT}\\matwind-${arm.key}-close.png` }); log(`  saved ${arm.key}-close.png`); } catch (e) {}
    } else {
      // wind: aim the camera AT the actual winding trees + clear the rain, then a 3-frame burst to expose sway
      const fr = await page.evaluate(FREEZE_AND_FRAME, "trees").catch(e => ({ reframed: false, err: String(e.message) }));
      out.treeFrame = fr; log(`  tree reframe: ${JSON.stringify(fr)}`);
      await sleep(4000); // let weather clear (rain particles drain) + camera settle
      for (let i = 0; i < 3; i++) {
        try { await page.screenshot({ path: `${OUT}\\matwind-${arm.key}-f${i}.png` }); } catch (e) {}
        await sleep(1200);
      }
      log(`  saved ${arm.key}-f0..f2.png (tree-framed sway burst)`);
    }

    // console tallies
    out.consoleErrors = consoleBuf.filter(l => /^error:|pageerror:|requestfailed:/.test(l)).length;
    out.suiteFailures = consoleBuf.filter(l => /requestfailed:|404|texchan.*(fail|error)|windclip.*(fail|error)|decode.*error/i.test(l)).length;
    // wind-attach summary lines (built vs dropped/re-frozen over the cap) — the user's "not all trees wind" signal
    out.windLog = consoleBuf.filter(l => /wind|anim.*scen|peel|DROPPED|re-frozen|\bcap\b|built \d|frozen \d/i.test(l)).slice(-20);
    out.consoleTail = consoleBuf.filter(l => /error|fail|404|texchan|windclip|suite|warn/i.test(l)).slice(-20);
    log(`  consoleErrors=${out.consoleErrors} suiteFailures=${out.suiteFailures} windLogLines=${out.windLog.length}`);
  } catch (e) {
    out.fatal = String(e && e.message || e); log(`  ARM FATAL: ${out.fatal}`); out.consoleTail = consoleBuf.slice(-30);
  } finally {
    try { await browser.close(); } catch (_) {}
    await sleep(2000);
  }
  return out;
}

async function main() {
  const arms = ARM_FILTER.length ? ARMS.filter(a => ARM_FILTER.includes(a.key)) : ARMS;
  log(`matwind A/B on GTX 1070 (headless real GPU). arms: ${arms.map(a => a.key).join(", ")}`);
  for (const arm of arms) {
    const r = await runArm(arm);
    upsertArm(r);
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  }
  log("=".repeat(78));
  log("MATWIND A/B SUMMARY (GTX 1070, outdoor Holtburg, headless)");
  log("arm         inWorld outdoor renderer  programs withMap rough ao  cErr sFail");
  for (const a of report.arms) {
    const d = a.diag || {};
    log(`${a.key.padEnd(11)} ${String(!!a.inWorld).padEnd(7)} ${String(!!a.outdoor).padEnd(7)} ${(a.renderer || "-").slice(0, 22).padEnd(22)} ${String(d.programs ?? "-").padEnd(8)} ${String(d.withMap ?? "-").padEnd(7)} ${String(d.withRoughnessMap ?? "-").padEnd(5)} ${String(d.withAoMap ?? "-").padEnd(3)} ${String(a.consoleErrors ?? "-").padEnd(4)} ${String(a.suiteFailures ?? "-")}`);
  }
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  log(`report -> ${REPORT_PATH}`);
  log("DONE");
}
main().catch(e => { log("TOP FATAL:", e?.stack?.slice(0, 500) || e); try { writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2)); } catch (_) {} }).finally(() => process.exit(0));
