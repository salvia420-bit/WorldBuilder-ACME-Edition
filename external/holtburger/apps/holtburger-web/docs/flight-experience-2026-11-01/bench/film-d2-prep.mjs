// film-d2-prep.mjs — before a take D (the bail into Al-Arqas) of the Hellcat film, reshoot D2 (2026-11-02):
//   1. close the victims' pages (agentp07 / agentp08: page.close() on THOSE pages only — never the last page);
//   2. a FRESH pilot page (lb_presence.js can keep stale "near terrain drawn" claims on a page reused across long
//      flights: sky holes in the ground): about:blank, wait out "Account In Use" (>= 45 s), log in again with the film
//      driver's own URL (rendering, ?nosw=1, no ?targetFps cap), wait until in world;
//   3. --survey: the pilot on foot to the town centre, settle, then film-town-survey.eval.js (a ray straight down on a
//      4 m grid: where a falling body can come down in the open) → <out>/take-D<suffix>-survey.json + .txt
//   4. --rehearse (reshoot D2-2): a short landing rehearsal on the SAME page, unrecorded - the Hellcat from the D start,
//      out over the sea to --rh-agl (600) m, back, bail --rh-lead m before the aim, the chute, touchdown at the take's
//      landing spot - so every program the canopy descent and the landing need is linked BEFORE the take (take D2 /
//      D2-t2: 313 ms / 2 x 630 ms synchronous links 1-2 s before touchdown, first sight of the oasis's effects). The
//      link probe's ledger (scene3d/shader_prewarm.js, armed through __stallArm) names every program linked; the report
//      goes to <out>/take-D<suffix>.rehearsal.json. Then the pilot stands at the landing spot --rh-stand ms.
//   5. --keepalive: every stage-keyed program whose material name matches --keepalive-re (ShaderMaterial / RawShaderMaterial: program_retention.js cannot keep
//      those - three mints new stage ids once the last material is disposed) in use by the scene right now has its
//      material's dispose() turned into a no-op for the session, so the flight away (entities despawn) cannot free it
//      and the return cannot relink it. Run after --rehearse, before the take.
// Attaches to the 1070's test Chrome over CDP (127.0.0.1:9333, the tunnel); never closes the browser. --launch starts
// the test Chrome (the hbprobe task, the film driver's own launch) when CDP is down.
//   node film-d2-prep.mjs [--launch] [--no-fresh] [--survey] [--survey-settle 30000] [--cx 27636 --cy 16956] [--suffix 2]
//                         [--rehearse --rh-agl 600 --rh-lead 565 --rh-turnback 2000 --rh-stand 20000 --aim-x X --aim-y Y]
//                         [--keepalive [--keepalive-re "^(portal-punch|portal-punch-mark|lifestone-crystal-glow)$"]]
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");
const CDP = "http://127.0.0.1:9333";
const APP = "http://127.0.0.1:8765/apps/holtburger-web/index.html";
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const has = (k) => argv.includes(k);
const OUT = opt("--out", "/mnt/wbterminal2/film-projects/hellcat-2026-11-02/takes");
const t0 = Date.now();
const log = (...m) => console.log(`[prep ${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// = film-hellcat-1070.mjs urlFor(account, render = true)
const urlFor = (account) => `${APP}?autoLogin=1&account=${account}&password=${account}&autoSpawn=first&nosw=1&portalSpace=off` +
  `&camDebug=on&vehicles=on&renderScale=1&adaptiveRes=off&skytime=${opt("--skytime", "13")}&cloudCoverage=${opt("--coverage", "0.42")}&quality=high&targetFps=0`;
const WORLD = "/home/wbterminal/hb-serve/dist/current/world/";
const WH = readFileSync(WORLD + "world_height.u8"), WTAB = JSON.parse(readFileSync(WORLD + "world_meta.json", "utf8")).landHeightTable;
const groundAt = (x, y) => {
  const fx = x / 24, fy = y / 24, i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j, H = (a, b) => WTAB[WH[b * 2041 + a]];
  return H(i, j) * (1 - u) * (1 - v) + H(i + 1, j) * u * (1 - v) + H(i, j + 1) * (1 - u) * v + H(i + 1, j + 1) * u * v;
};
const teleloc = (x, y, z, headingDeg) => {
  const lbx = Math.floor(x / 192), lby = Math.floor(y / 192);
  const lx = x - lbx * 192, ly = y - lby * 192;
  const cell = ((lbx << 24) | (lby << 16) | (Math.floor(lx / 24) * 8 + Math.floor(ly / 24) + 1)) >>> 0;
  const hr = (headingDeg ?? 0) * Math.PI / 180;
  return `@teleloc 0x${cell.toString(16).padStart(8, "0")} ${lx.toFixed(2)} ${ly.toFixed(2)} ${z.toFixed(2)} ${Math.cos(hr / 2).toFixed(6)} 0 0 ${(-Math.sin(hr / 2)).toFixed(6)}`;
};
async function ready(pg, label) {
  for (let i = 0; i < 240; i++) {
    const ok = await pg.evaluate(() => {
      if (!window.liveScene3d || !window.__sessionHandle || !window.__vehicles) return false;
      const h = (window.__bootStateHistory || []).map((s) => s.state || s);
      if (h.includes("ready")) return true;
      if (!h.includes("in-world")) return false;
      let meshes = 0;
      try { window.liveScene3d.scene.traverse((o) => { if (o.isMesh) meshes += 1; }); } catch (_) { return false; }
      return meshes > 300;
    }).catch(() => false);
    if (ok) { log(label, "in world"); return true; }
    await sleep(1000);
  }
  log(label, "boot FAILED"); return false;
}

const BOX = "young@100.127.215.75";
const ssh = (c) => execFileSync("ssh", ["-o", "BatchMode=yes", BOX, c], { encoding: "utf8", timeout: 60000 });
const cdpUp = async () => { try { return (await fetch(`${CDP}/json/version`)).ok; } catch (_) { return false; } };
if (has("--launch") && !(await cdpUp())) {
  // = film-hellcat-1070.mjs's launch: the kept profile (warm shader cache), off-screen, muted, the gate decides
  try { ssh("powershell -NoProfile -ExecutionPolicy Bypass -File D:\\Temp\\hbbench\\hbbench-kill.ps1"); } catch (_) { /* none */ }
  ssh("echo fxkeep-film> D:\\Temp\\hbbench\\profile.txt");
  ssh("echo 1920,1200> D:\\Temp\\hbbench\\winsize.txt");
  for (const f of ["angle.txt", "disablefeatures.txt", "extraflags.txt", "uncapped.txt"]) ssh(`if exist D:\\Temp\\hbbench\\${f} del /q D:\\Temp\\hbbench\\${f}`);
  ssh('schtasks /create /tn hbprobe /tr "wscript.exe //B //Nologo D:\\Temp\\hbbench\\hidden-run.vbs D:\\Temp\\hbbench\\hbprobe-launch.bat" /sc once /st 00:00 /it /f >nul 2>nul & schtasks /run /tn hbprobe >nul');
  let up = false;
  for (let i = 0; i < 40 && !up; i++) { up = await cdpUp(); if (!up) await sleep(1000); }
  if (!up) { log("test Chrome did not come up (gate refused?)"); process.exit(1); }
  log("test Chrome launched");
}
const browser = await chromium.connectOverCDP(CDP);
const ctx = browser.contexts()[0];
log("pages", ctx.pages().map((p) => p.url().slice(0, 120)));
let pilot = ctx.pages().find((p) => p.url().includes("account=agentp10&"));
for (const p of ctx.pages()) {
  const m = /account=(agentp0[78])&/.exec(p.url());
  if (!m) continue;
  if (ctx.pages().length < 2) { await p.goto("about:blank").catch(() => {}); log("blanked the page of", m[1]); continue; }
  await p.close().then(() => log("closed the page of", m[1])).catch((e) => log("close failed", m[1], e.message));
}
if (!pilot) {
  pilot = ctx.pages().find((p) => p.url() === "about:blank") || ctx.pages()[0];
  // the launcher's window is off-screen already; pinned there again all the same (= the film driver)
  try {
    const c0 = await ctx.newCDPSession(pilot);
    const { windowId } = await c0.send("Browser.getWindowForTarget");
    await c0.send("Browser.setWindowBounds", { windowId, bounds: { left: -32000, top: -32000, width: 1920, height: 1200 } });
    await c0.detach().catch(() => {});
  } catch (_) { /* */ }
}
if (!has("--no-fresh")) {
  await pilot.goto("about:blank").catch(() => {});
  log("the pilot page blanked — waiting out Account In Use (", Number(opt("--relogin-wait", "48000")) / 1000, "s)");
  await sleep(Number(opt("--relogin-wait", "48000")));
  await pilot.goto(urlFor("agentp10"), { waitUntil: "domcontentloaded", timeout: 60000 });
  if (!(await ready(pilot, "pilot (fresh)"))) process.exit(1);
  log("gpu", await pilot.evaluate(() => { const gl = document.createElement("canvas").getContext("webgl2"); const e = gl.getExtension("WEBGL_debug_renderer_info"); return gl.getParameter(e.UNMASKED_RENDERER_WEBGL); }));
  await pilot.evaluate(() => { try { window.__setWeather?.({ is_storm: false }); } catch (_) { /* */ } }).catch(() => {});
  if (Number(opt("--login-settle", "0")) > 0) { log("settling", Number(opt("--login-settle", "0")) / 1000, "s"); await sleep(Number(opt("--login-settle", "0"))); }
  log("pose after login", JSON.stringify(await pilot.evaluate(() => { const w = window.__cam?.world?.(); return w ? { x: Math.round(w.x), y: Math.round(w.y), z: Math.round(w.z) } : null; }).catch(() => null)));
}
log("pages now", ctx.pages().map((p) => p.url().slice(0, 140)));
if (has("--survey")) {
  const cx = Number(opt("--cx", "27636")), cy = Number(opt("--cy", "16956"));
  await pilot.evaluate((c) => window.__sessionHandle.sendChat(c), "@vehicle despawn all").catch(() => {});
  await pilot.evaluate((c) => window.__sessionHandle.sendChat(c), teleloc(cx, cy, groundAt(cx, cy) + 0.6, 72)).catch(() => {});
  log("the pilot on foot at the town centre; settling", Number(opt("--survey-settle", "30000")) / 1000, "s");
  await sleep(Number(opt("--survey-settle", "30000")));
  await pilot.evaluate((r) => { window.__vehicleRun = r; }, { cx, cy, half: Number(opt("--half", "150")), step: Number(opt("--step", "4")) });
  const tS = Date.now();
  const sv = await pilot.evaluate(`(async () => { ${readFileSync(resolve(HERE, "film-town-survey.eval.js"), "utf8")}\n })()`).catch((e) => ({ error: e.message }));
  log("survey", Date.now() - tS, "ms", JSON.stringify({ seen: sv.seen, cands: sv.cands, frame: sv.frame, open: (sv.open || []).slice(0, 12), error: sv.error ?? sv.fatal }));
  const stem = `take-D${opt("--suffix", "2")}-survey`;
  writeFileSync(join(OUT, `${stem}.json`), JSON.stringify(sv, null, 1));
  if (sv.rows) writeFileSync(join(OUT, `${stem}.txt`), `# ${cx},${cy} ±${sv.half} m, ${sv.step} m/char, north up; '#' >= 2.5 m above the ground, '+' 0.6-2.5 m, '.' open\n` + sv.rows.join("\n") + "\n");
  log("wrote", join(OUT, `${stem}.json`));
}
const evalFile = (f) => { try { return readFileSync(resolve(HERE, f), "utf8"); } catch (_) { return readFileSync(resolve(HERE, "../../vehicles-2026-11-01/bench", f), "utf8"); } };
const runOn = async (pg, file, run) => { await pg.evaluate((r) => { window.__vehicleRun = r; }, run); return pg.evaluate(`(async () => { ${evalFile(file)}\n })()`); };
const chat = (c) => pilot.evaluate((x) => window.__sessionHandle.sendChat(x), c);
// the link ledger's '+' entries (programs linked) from page time t0 on, with the eval's last event before each
const ledgerSince = (t0) => pilot.evaluate((t) => {
  const lp = window.__linkProbe;
  if (!lp || typeof lp.ledger !== "function") return { absent: true };
  const ev = window.__filmEvents || [];
  const phaseAt = (x) => { let k = null; for (const e of ev) if (e.t <= x) k = e.kind; return k; };
  const rows = lp.ledger().filter((e) => e.t >= t && e.op === "+").map((e) => ({ t: Math.round(e.t), phase: phaseAt(e.t), name: e.name, type: e.type, relink: !!e.relink, key: String(e.key || "").slice(0, 160) }));
  return { rows, stats: lp.ledgerStats?.() ?? null, link: lp.stats ? { linkStatus: lp.stats.linkStatus, linkProgramCalls: lp.stats.linkProgramCalls } : null };
}, t0).catch((e) => ({ error: e.message }));
if (has("--rehearse")) {
  const aim = { x: Number(opt("--aim-x", "27721")), y: Number(opt("--aim-y", "16998")) };
  const sx = Number(opt("--d-x", "26300")), sy = Number(opt("--d-y", "16950"));
  const rep = { startedAt: new Date().toISOString(), aim, rhAgl: Number(opt("--rh-agl", "600")), rhLead: Number(opt("--rh-lead", "565")) };
  // the take's canvas size (the film driver draws 1920 x 1080)
  const mc = await ctx.newCDPSession(pilot);
  await mc.send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  rep.arm = await pilot.evaluate(() => window.__stallArm?.({ thresholdMs: 80, ring: 256 }) ?? "absent").catch((e) => ({ error: e.message }));
  log("stall + link probe", JSON.stringify(rep.arm).slice(0, 200));
  const tStart = await pilot.evaluate(() => performance.now());
  rep.programsBefore = await pilot.evaluate(() => window.liveScene3d.renderer.info.programs.length);
  await chat("@vehicle despawn all").catch(() => {});
  await chat(teleloc(sx, sy, groundAt(sx, sy) + 0.6, 260));
  await sleep(Number(opt("--settle", "20000")));
  rep.spawn = await runOn(pilot, "vehicle-spawn.eval.js", {});
  log("spawn", JSON.stringify(rep.spawn?.summary ?? rep.spawn?.fatal));
  for (let i = 0; i < 60; i++) {
    const hasRig = await pilot.evaluate(() => { const v = window.__vehicles.vehicles().slice(-1)[0]; return !!(v && window.liveScene3d.entityManager.entityMap.get(v.guid)); });
    if (hasRig) break;
    await sleep(500);
  }
  await sleep(3000);
  const flight = await runOn(pilot, "film-hellcat.eval.js", { mode: "bail", site: aim, from: 12, victims: [], victimPos: [], climbHeading: 262,
    bailAgl: rep.rhAgl, turnBackM: Number(opt("--rh-turnback", "2000")), bailLeadM: rep.rhLead, bailExact: true, town: aim, maxSec: 420, endAfterLandSec: 7 })
    .catch((e) => ({ fatal: e.message }));
  rep.flight = { summary: flight?.summary ?? flight?.fatal, events: flight?.events, landing: flight?.landing, fallRows: (flight?.rows || []).filter((r) => r.phase === "fall" || r.phase === "chute") };
  log("rehearsal", JSON.stringify(rep.flight.summary).slice(0, 600));
  log("landing", JSON.stringify(rep.flight.landing));
  try { await chat("@vehicle despawn all"); } catch (_) { /* */ }
  await sleep(Number(opt("--rh-stand", "20000")));
  rep.ledger = await ledgerSince(tStart);
  rep.stall = await pilot.evaluate(() => window.__stallReport?.() ?? null).catch((e) => ({ error: e.message }));
  await pilot.evaluate(() => { try { window.__stallDisarm?.(); } catch (_) { /* */ } }).catch(() => {});
  rep.programsAfter = await pilot.evaluate(() => window.liveScene3d.renderer.info.programs.length);
  rep.retention = await pilot.evaluate(() => JSON.parse(JSON.stringify(window.__diag?.programs ?? null))).catch(() => null);
  rep.poseAfter = await pilot.evaluate(() => { const w = window.__cam?.world?.(); return w ? { x: w.x, y: w.y, z: w.z } : null; }).catch(() => null);
  await mc.detach().catch(() => {});
  const long = (rep.stall?.ring || []).map((r) => ({ t: Math.round(r.tStartMs), ms: r.intervalMs, render: r.renderMs, link: r.d?.linkPrograms ?? 0, programs: r.at?.programs }));
  log("programs", rep.programsBefore, "->", rep.programsAfter, "linked", (rep.ledger.rows || []).length, "relinks", (rep.ledger.rows || []).filter((r) => r.relink).length);
  log("long frames", JSON.stringify(long).slice(0, 1500));
  const byPhase = {};
  for (const r of rep.ledger.rows || []) { const k = `${r.phase}|${r.type}|${r.name}`; byPhase[k] = (byPhase[k] || 0) + 1; }
  log("linked by phase|type|name", JSON.stringify(byPhase).slice(0, 3000));
  writeFileSync(join(OUT, `take-D${opt("--suffix", "2")}.rehearsal.json`), JSON.stringify(rep, null, 1));
  log("wrote", join(OUT, `take-D${opt("--suffix", "2")}.rehearsal.json`));
}
if (has("--keepalive")) {
  // only the materials whose name matches --keepalive-re: the per-entity stage-keyed effects of the landing spot (the
  // rehearsal's ledger: portal-punch, lifestone-crystal-glow). NOT every stage-keyed material: the per-landblock terrain
  // ShaderMaterials would then leak (and their textures' JS data) over the flight
  const ka = await pilot.evaluate((reSrc) => {
    const re = new RegExp(reSrc);
    const L = window.liveScene3d, props = L.renderer.properties;
    const out = { wrapped: 0, already: 0, skipped: 0, by: {}, stageKeyedSeen: {} };
    const stageKeyed = (m, p) => m.isShaderMaterial || m.isRawShaderMaterial || (p && /^\d+,/.test(String(p.cacheKey || "")));
    L.scene.traverse((o) => {
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of mats) {
        if (!m || !m.isMaterial) continue;
        let p = null;
        try { p = props.get(m).currentProgram ?? null; } catch (_) { p = null; }
        if (!p || !stageKeyed(m, p)) { out.skipped++; continue; }
        const nm = String(m.name || "");
        out.stageKeyedSeen[nm.slice(0, 40) || "?"] = (out.stageKeyedSeen[nm.slice(0, 40) || "?"] || 0) + 1;
        if (!re.test(nm)) { out.skipped++; continue; }
        if (m.userData.__filmKeepAlive) { out.already++; continue; }
        m.userData.__filmKeepAlive = m.dispose;
        m.dispose = function () { /* kept for the film take: its stage ids and program stay linked */ };
        out.wrapped++;
        const k = `${m.type}|${m.name || o.name || "?"}`.slice(0, 80);
        out.by[k] = (out.by[k] || 0) + 1;
      }
    });
    return out;
  }, opt("--keepalive-re", "^(portal-punch|portal-punch-mark|lifestone-crystal-glow)$")).catch((e) => ({ error: e.message }));
  log("keepalive", JSON.stringify(ka).slice(0, 2500));
}
log("done (the test Chrome stays open)");
process.exit(0);
