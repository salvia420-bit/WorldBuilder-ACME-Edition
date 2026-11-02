// film-hellcat-1070.mjs — the Hellcat YouTube film on the 1070 (owner request 2026-11-02): Holtburg → the A'mun
// desert, two players shot from the air, the climb to the ceiling through the clouds, out over the western sea, back to
// Al-Arqas, bail out, free fall, chute, landing in the town.
//
// Three logged-in pages in the 1070's off-screen, muted test Chrome (MODE T, the hbprobe launcher; each page in its
// own off-screen window so its loop is never a hidden tab's): the pilot (agentp10) and two victims, the level-1
// characters "Funnel Probe" (agentp07) and "Funnel Probe Two" (agentp08), standing side by side on the sand 2 km
// south-east of Samsur, facing the Hellcat's approach from Holtburg (bearing 12°).
//   take A — the pilot page renders and records the whole flight (chase view; the cockpit view for the strafing pass);
//            the victims' pages run with ?nullRender=1.
//   take B — the attack again from the ground: victim 1's page renders and records, its camera parked 6 m behind the
//            player looking at the incoming Hellcat; the pilot flies the pass from 3 km out with ?nullRender=1.
// Recording: film mode's own WebCodecs recorder (scene3d/film/runtime/recorder.js, H.264 1920x1080) fed from the
// film hooks' postRender (the frame's final draw, same task) on a fixed 30 fps grid (a slow frame is held), drained
// over CDP while the take runs → <out>/take-X.h264 → ffmpeg → take-X.mp4. The canvas only: no HUD in the picture.
// Needs the ACE property vehicle_gun_players = true (the gun hits players; default false — set it back afterwards).
//
//   node film-hellcat-1070.mjs --take A|B [--out DIR] [--coverage 0.42] [--skytime 13] [--no-launch] [--keep]
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const VEH = resolve(HERE, "../../vehicles-2026-11-01/bench");
const require = createRequire(import.meta.url);
const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");
const BOX = "young@100.127.215.75";
const CDP = "http://127.0.0.1:9333";
const APP = "http://127.0.0.1:8765/apps/holtburger-web/index.html";
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const has = (k) => argv.includes(k);
const TAKE = (opt("--take", "A") || "A").toUpperCase();
const OUT = opt("--out", "/mnt/wbterminal2/film-projects/hellcat-2026-11-02/takes");
mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const log = (...m) => console.log(`[film ${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ssh = (c) => execFileSync("ssh", ["-o", "BatchMode=yes", BOX, c], { encoding: "utf8", timeout: 60000 });
const STEM = `take-${TAKE}${opt("--suffix", "")}`;
const res = { take: TAKE, startedAt: new Date().toISOString(), out: OUT, stills: [], errors: [] };
const save = () => writeFileSync(join(OUT, `${STEM}.json`), JSON.stringify(res, null, 1));

// ---- the set
// take A's site (flat sand, 30 m, 2 km SE of Samsur) left the Hellcat's 30 m floor 30 m above the targets: the nose
// angle swept -15 -> -25 deg in a second and the gun never lined up. This one (scratchpad killsite2.py) is a rise at
// 48 m with a valley 26 m lower along the last 60-200 m of the approach: at its floor the Hellcat fires at -2 deg.
const SITE = { x: Number(opt("--site-x", "30072")), y: Number(opt("--site-y", "24496")) };
const FROM = 12;                               // the Hellcat comes from bearing 12° (Holtburg is that way)
const TOWN = { x: 27636, y: 16956 };          // Al-Arqas (31.3S, 13.2E)
const HOLTBURG = "0xA9B40019 84 7.1 94";
const VICTIMS = [
  { account: "agentp07", name: "Funnel Probe", off: -1.8 },     // left of the pair, seen from the approach
  { account: "agentp08", name: "Funnel Probe Two", off: 1.8 },
];
// ground height from the world tier's bake (the retail land-height table per 24 m vertex, bilinear) for teleports
const WORLD = "/home/wbterminal/hb-serve/dist/current/world/";
const WH = readFileSync(WORLD + "world_height.u8"), WTAB = JSON.parse(readFileSync(WORLD + "world_meta.json", "utf8")).landHeightTable;
const groundAt = (x, y) => {
  const fx = x / 24, fy = y / 24, i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j, H = (a, b) => WTAB[WH[b * 2041 + a]];
  return H(i, j) * (1 - u) * (1 - v) + H(i + 1, j) * u * (1 - v) + H(i, j + 1) * (1 - u) * v + H(i + 1, j + 1) * u * v;
};
const perp = (FROM + 90) * Math.PI / 180;
for (const v of VICTIMS) v.pos = [SITE.x + Math.sin(perp) * v.off, SITE.y + Math.cos(perp) * v.off];
const teleloc = (x, y, z, headingDeg) => {
  const lbx = Math.floor(x / 192), lby = Math.floor(y / 192);
  const lx = x - lbx * 192, ly = y - lby * 192;
  const cell = ((lbx << 24) | (lby << 16) | (Math.floor(lx / 24) * 8 + Math.floor(ly / 24) + 1)) >>> 0;
  const hr = (headingDeg ?? 0) * Math.PI / 180; // ACE: rotation about +Z by -heading (Vehicle.YawOnly)
  return `@teleloc 0x${cell.toString(16).padStart(8, "0")} ${lx.toFixed(2)} ${ly.toFixed(2)} ${z.toFixed(2)} ${Math.cos(hr / 2).toFixed(6)} 0 0 ${(-Math.sin(hr / 2)).toFixed(6)}`;
};

// ---- launch the test Chrome (off-screen, muted; the gate decides) unless --no-launch
if (!has("--no-launch")) {
  try { ssh("powershell -NoProfile -ExecutionPolicy Bypass -File D:\\Temp\\hbbench\\hbbench-kill.ps1"); } catch (_) { /* none */ }
  ssh("echo fxkeep-film> D:\\Temp\\hbbench\\profile.txt"); // a kept profile: a warm shader cache across takes
  ssh("echo 1920,1200> D:\\Temp\\hbbench\\winsize.txt");
  for (const f of ["angle.txt", "disablefeatures.txt", "extraflags.txt", "uncapped.txt"]) ssh(`if exist D:\\Temp\\hbbench\\${f} del /q D:\\Temp\\hbbench\\${f}`);
  ssh('schtasks /create /tn hbprobe /tr "wscript.exe //B //Nologo D:\\Temp\\hbbench\\hidden-run.vbs D:\\Temp\\hbbench\\hbprobe-launch.bat" /sc once /st 00:00 /it /f >nul 2>nul & schtasks /run /tn hbprobe >nul');
  let up = false;
  for (let i = 0; i < 40 && !up; i++) { try { up = (await fetch(`${CDP}/json/version`)).ok; } catch (_) { /* not yet */ } if (!up) await sleep(1000); }
  if (!up) { log("test Chrome did not come up (gate refused?)"); process.exit(1); }
}
const browser = await chromium.connectOverCDP(CDP);
const ctx = browser.contexts()[0];
const bcdp = await browser.newBrowserCDPSession();

// ---- pages: the pilot and the victims, each in its own off-screen window
const urlFor = (account, render) => `${APP}?autoLogin=1&account=${account}&password=${account}&autoSpawn=first&nosw=1&portalSpace=off` +
  `&camDebug=on&vehicles=on&renderScale=1&adaptiveRes=off&skytime=${opt("--skytime", "13")}&cloudCoverage=${opt("--coverage", "0.42")}` +
  (render ? `&quality=high&targetFps=0` : `&quality=low&targetFps=${account === "agentp10" ? 30 : 10}&nullRender=1`);
const findPage = (account) => ctx.pages().find((p) => p.url().includes(`account=${account}&`));
async function openWindow(account, render) {
  let pg = findPage(account) || ctx.pages().find((p) => p.__hbRelogin === account);
  const wantRender = !!render;
  if (pg && pg.url().includes("account=") && pg.url().includes("nullRender=1") === !wantRender) return { pg, fresh: false };
  if (!pg) {
    const { targetId } = await bcdp.send("Target.createTarget", { url: "about:blank", newWindow: true, background: true });
    for (let i = 0; i < 50 && !pg; i++) { pg = ctx.pages().find((p) => p.url() === "about:blank" && !p.__hbClaimed); if (!pg) await sleep(100); }
    if (!pg) throw new Error(`no page for ${account}`);
    pg.__hbClaimed = true;
    try {
      const { windowId } = await bcdp.send("Browser.getWindowForTarget", { targetId });
      await bcdp.send("Browser.setWindowBounds", { windowId, bounds: { left: -32000, top: -32000, width: 1280, height: 800 } });
    } catch (e) { res.errors.push(`window ${account}: ${e.message}`); }
  }
  await pg.goto(urlFor(account, wantRender), { waitUntil: "domcontentloaded", timeout: 60000 });
  return { pg, fresh: true };
}
async function ready(pg, label) {
  for (let i = 0; i < 240; i++) {
    // "ready", or (the boot watchdog's scene-ready timeout can mark "error" after "in-world" with a working scene —
    // MEMORY measurement trap c) in-world with a populated scene
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
const chatOn = (pg, c) => pg.evaluate((x) => window.__sessionHandle.sendChat(x), c);

// takes: A the whole flight (pilot view), K the kills (pilot view), B the kills from behind victim 1, D the bail
const pilotRender = TAKE !== "B";
// pages whose render mode changes this take re-log in: blank them all first and wait out "Account In Use" once
{
  const wantRender = { agentp10: pilotRender, [VICTIMS[0].account]: TAKE === "B", [VICTIMS[1].account]: false };
  const stale = ctx.pages().filter((p) => { const m = /account=([a-z0-9]+)&/.exec(p.url()); return m && m[1] in wantRender && p.url().includes("nullRender=1") === wantRender[m[1]]; });
  if (stale.length) {
    for (const p of stale) { p.__hbRelogin = /account=([a-z0-9]+)&/.exec(p.url())[1]; await p.goto("about:blank").catch(() => {}); }
    log("re-login in a new render mode:", stale.map((p) => p.__hbRelogin).join(", "), "— waiting out Account In Use");
    await sleep(40000);
  }
}
const findPageOrBlank = (account) => findPage(account) || ctx.pages().find((p) => p.__hbRelogin === account);
// the main (launcher) window hosts the pilot
let pilot = findPageOrBlank("agentp10");
if (!pilot) {
  pilot = ctx.pages().find((p) => p.url() === "about:blank") || ctx.pages()[0];
  pilot.__hbClaimed = true;
  try {
    const c0 = await ctx.newCDPSession(pilot);
    const { windowId } = await c0.send("Browser.getWindowForTarget");
    await c0.send("Browser.setWindowBounds", { windowId, bounds: { left: -32000, top: -32000, width: 1920, height: 1200 } });
  } catch (_) { /* */ }
}
if (!pilot.url().includes("account=agentp10&") || pilot.url().includes("nullRender=1") === pilotRender) {
  await pilot.goto(urlFor("agentp10", pilotRender), { waitUntil: "domcontentloaded", timeout: 60000 });
}
const vpages = [];
for (const v of TAKE === "D" ? [] : VICTIMS) {
  const render = TAKE === "B" && v === VICTIMS[0];
  const { pg } = await openWindow(v.account, render);
  vpages.push(pg);
}
const recPage = TAKE === "B" ? vpages[0] : pilot;
// the recorded page draws exactly 1920 x 1080
const rcdp = await ctx.newCDPSession(recPage);
await rcdp.send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
for (const [pg, label] of [[pilot, "pilot"], ...vpages.map((p, i) => [p, VICTIMS[i].name])]) {
  if (!(await ready(pg, label))) { save(); process.exit(1); }
}
res.gpu = await recPage.evaluate(() => { const gl = document.createElement("canvas").getContext("webgl2"); const e = gl.getExtension("WEBGL_debug_renderer_info"); return gl.getParameter(e.UNMASKED_RENDERER_WEBGL); });
log("gpu", res.gpu);
if (!/1070/.test(res.gpu)) { log("NOT the GTX 1070 — stopping"); save(); process.exit(1); }
for (const pg of [pilot, ...vpages]) {
  await pg.evaluate(() => { try { window.__setWeather?.({ is_storm: false }); } catch (_) { /* */ } }).catch(() => {});
  await pg.evaluate(async () => { try { window.__benchWake = await navigator.wakeLock.request("screen"); } catch (_) { /* */ } }).catch(() => {});
}

// ---- the recorder (in the recorded page)
const REC_FPS = 30;
const startRec = () => recPage.evaluate(async ({ fps, bitrate }) => {
  const names = performance.getEntriesByType("resource").map((e) => e.name);
  const url = (p) => names.find((n) => n.includes(p)) || new URL(p.replace(/^\//, ""), location.href).href;
  const co = await import(url("/scene3d/film/runtime/camera_owner.js"));
  const rm = await import(url("/scene3d/film/runtime/recorder.js"));
  const canvas = window.liveScene3d.renderer.domElement;
  const rec = rm.createRecorder({ canvas, fps, bitrate, keyIntervalSec: 1 });
  const st = await rec.start();
  const hooks = co.ensureFilmHooks(window.liveScene3d);
  const v = (window.__hbVid = { rec, t0: null, lastK: -1, frames: 0, held: 0, unsub: null });
  v.unsub = hooks.addPostRender(() => {
    const now = performance.now();
    if (v.t0 === null) v.t0 = now;
    const k = Math.floor(((now - v.t0) * fps) / 1000 + 1e-6);
    if (k <= v.lastK) return;
    const times = [];
    for (let i = v.lastK + 1; i <= k; i++) times.push(i / fps);
    v.held += times.length - 1;
    v.lastK = k;
    v.frames += times.length;
    rec.grab(times.length === 1 ? times[0] : times);
  });
  return { ...st, canvas: [canvas.width, canvas.height] };
}, { fps: REC_FPS, bitrate: Number(opt("--bitrate", "6000000")) });
const H264 = join(OUT, `${STEM}.h264`);
if (existsSync(H264)) unlinkSync(H264);
let draining = false, drainedBytes = 0, drainStop = false;
const drainOnce = async () => {
  const d = await recPage.evaluate(() => window.__hbVid?.rec?.drain({ maxBytes: 6 << 20 }) ?? null).catch((e) => ({ error: String(e) }));
  if (!d || d.error) return d;
  for (const c of d.chunks || []) { const b = Buffer.from(c.b64, "base64"); appendFileSync(H264, b); drainedBytes += b.length; }
  return d;
};
const drainLoop = (async () => {
  while (!drainStop && has("--drain-live")) {
    if (!draining) { draining = true; try { await drainOnce(); } finally { draining = false; } }
    await sleep(600);
  }
})();
const stopRec = async () => {
  const st = await recPage.evaluate(async () => { const v = window.__hbVid; v.unsub?.(); const s = await v.rec.stop(); return { stats: s, t0: v.t0, frames: v.frames, held: v.held }; });
  drainStop = true;
  await drainLoop;
  for (let i = 0; i < 2000; i++) { const d = await drainOnce(); if (!d || d.error || d.done || !(d.chunks || []).length) { if (d?.error) res.errors.push(`drain: ${d.error}`); break; } }
  return st;
};
const rcdpShot = async (name, note) => {
  try {
    const r = await rcdp.send("Page.captureScreenshot", { format: "jpeg", quality: 88 });
    const file = `${STEM}-${String(res.stills.length).padStart(2, "0")}-${name}.jpg`;
    writeFileSync(join(OUT, file), Buffer.from(r.data, "base64"));
    res.stills.push({ file, t: +((Date.now() - t0) / 1000).toFixed(1), note: note ?? null });
  } catch (e) { res.errors.push(`still ${name}: ${e.message}`); }
};
const evalFile = (f) => { try { return readFileSync(resolve(HERE, f), "utf8"); } catch (_) { return readFileSync(resolve(VEH, f), "utf8"); } };
const runOn = async (pg, file, run) => { await pg.evaluate((r) => { window.__vehicleRun = r; }, run); return pg.evaluate(`(async () => { ${evalFile(file)}\n })()`); };

// ---- the victims to their marks, facing the approach
const placeVictims = async () => {
  for (let i = 0; i < VICTIMS.length; i++) {
    const v = VICTIMS[i], pg = vpages[i];
    await chatOn(pg, "@vehicle despawn").catch(() => {});
    await chatOn(pg, teleloc(v.pos[0], v.pos[1], groundAt(v.pos[0], v.pos[1]) + 0.6, FROM));
  }
  await sleep(12000);
  const where = [];
  for (let i = 0; i < VICTIMS.length; i++) {
    where.push(await vpages[i].evaluate(() => { const p = window.__cam?.world?.(); return p ? { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, z: Math.round(p.z * 10) / 10 } : null; }).catch(() => null));
  }
  log("victims at", JSON.stringify(where), "planned", JSON.stringify(VICTIMS.map((v) => v.pos.map((n) => Math.round(n * 10) / 10))));
  return where;
};

const RUN = {
  site: SITE, from: FROM, victims: VICTIMS.map((v) => v.name), victimPos: VICTIMS.map((v) => v.pos),
  cruiseAgl: 90, slowAtM: 2600, attackStartM: 1500, attackAgl: 32, attackThrottle: 0.45, coneDeg: 1.4, maxPasses: 3,
  holdCockpitSec: 2.5, climbHeading: 252, ceilingAgl: 4950, ceilingHoldSec: 8, town: TOWN, bailLeadM: 700,
  endAfterLandSec: 7, flyOnM: 900, maxSec: 900,
};

try {
  if (TAKE !== "D") res.victims = await placeVictims();
  if (TAKE === "A") {
    await chatOn(pilot, `@teleloc ${HOLTBURG}`);
    await sleep(Number(opt("--settle", "30000")));
    await chatOn(pilot, "@vehicle despawn all");
    await sleep(1500);
    res.spawn = await runOn(pilot, "vehicle-spawn.eval.js", {});
    log("spawn", JSON.stringify(res.spawn?.summary ?? res.spawn?.fatal));
    for (let i = 0; i < 60; i++) {
      const hasRig = await pilot.evaluate(() => { const v = window.__vehicles.vehicles().slice(-1)[0]; return !!(v && window.liveScene3d.entityManager.entityMap.get(v.guid)); });
      if (hasRig) break;
      await sleep(500);
    }
    await sleep(4000);
    res.rec = await startRec();
    log("recording", JSON.stringify(res.rec));
    await sleep(2500);
    const shots = setInterval(() => { rcdpShot("t", null).catch(() => {}); }, 20000);
    res.flight = await runOn(pilot, "film-hellcat.eval.js", { ...RUN, mode: "full" });
    clearInterval(shots);
    log("flight", JSON.stringify(res.flight?.summary ?? res.flight?.fatal ?? res.flight).slice(0, 1500));
  } else if (TAKE === "D") {
    // take D: the bail. Off the sand 1.3 km west of Al-Arqas, out over the western sea up to 2,600 m (above the deck),
    // back east, out ~700 m before the town, the free fall through the clouds, the chute, Al-Arqas
    const sx = Number(opt("--d-x", "26300")), sy = Number(opt("--d-y", "16950"));
    await chatOn(pilot, "@vehicle despawn all");
    await chatOn(pilot, teleloc(sx, sy, groundAt(sx, sy) + 0.6, 260));
    await sleep(Number(opt("--settle", "25000")));
    res.spawn = await runOn(pilot, "vehicle-spawn.eval.js", {});
    log("spawn", JSON.stringify(res.spawn?.summary ?? res.spawn?.fatal));
    for (let i = 0; i < 60; i++) {
      const hasRig = await pilot.evaluate(() => { const v = window.__vehicles.vehicles().slice(-1)[0]; return !!(v && window.liveScene3d.entityManager.entityMap.get(v.guid)); });
      if (hasRig) break;
      await sleep(500);
    }
    await sleep(3000);
    // the tunnel drains ~0.3 MB/s: record only from the turn back toward Al-Arqas (take A has the climb and the sea)
    let recOn = false;
    const watch = setInterval(async () => {
      const ph = await pilot.evaluate(() => window.__filmPhase ?? null).catch(() => null);
      if (!recOn && (ph === "turnToTown" || ph === "lineUp" || ph === "bail")) {
        recOn = true;
        try { res.rec = await startRec(); log("recording", JSON.stringify(res.rec)); } catch (e) { res.errors.push(`rec: ${e.message}`); }
      }
    }, 250);
    res.flight = await runOn(pilot, "film-hellcat.eval.js", { ...RUN, mode: "bail", climbHeading: 262, bailAgl: Number(opt("--bail-agl", "2600")),
      turnBackM: 4500, bailLeadM: 700, maxSec: 1200 });
    clearInterval(watch);
    log("flight", JSON.stringify(res.flight?.summary ?? res.flight?.fatal ?? res.flight).slice(0, 1500));
  } else if (TAKE === "K") {
    // take K: the kills from the cockpit — the pilot 2.6 km out on the approach line, the pass, on 900 m
    const sx = SITE.x + Math.sin(FROM * Math.PI / 180) * 2600, sy = SITE.y + Math.cos(FROM * Math.PI / 180) * 2600;
    await chatOn(pilot, "@vehicle despawn all");
    await chatOn(pilot, teleloc(sx, sy, groundAt(sx, sy) + 0.6, FROM + 180));
    await sleep(Number(opt("--settle", "20000")));
    res.spawn = await runOn(pilot, "vehicle-spawn.eval.js", {});
    log("spawn", JSON.stringify(res.spawn?.summary ?? res.spawn?.fatal));
    for (let i = 0; i < 60; i++) {
      const hasRig = await pilot.evaluate(() => { const v = window.__vehicles.vehicles().slice(-1)[0]; return !!(v && window.liveScene3d.entityManager.entityMap.get(v.guid)); });
      if (hasRig) break;
      await sleep(500);
    }
    await sleep(3000);
    let recOn = false;
    const watch = setInterval(async () => {
      const ph = await pilot.evaluate(() => window.__filmPhase ?? null).catch(() => null);
      if (!recOn && (ph === "attackStart" || ph === "firstFire")) {
        recOn = true;
        try { res.rec = await startRec(); log("recording", JSON.stringify(res.rec)); } catch (e) { res.errors.push(`rec: ${e.message}`); }
      }
    }, 250);
    res.flight = await runOn(pilot, "film-hellcat.eval.js", { ...RUN, mode: "attack", attackStartM: 1700, slowAtM: 2400, attackView: "cockpit", cruiseAgl: 70,
      attackThrottle: Number(opt("--attack-throttle", "0.38")), maxPasses: Number(opt("--max-passes", "4")), maxSec: 600 });
    clearInterval(watch);
    log("attack", JSON.stringify(res.flight?.summary ?? res.flight?.fatal ?? res.flight).slice(0, 1200));
    await sleep(Number(opt("--tail", "3000")));
  } else {
    // take B: the pilot 3 km out on the approach line; victim 1's page records from the attack's start
    const sx = SITE.x + Math.sin(FROM * Math.PI / 180) * 3000, sy = SITE.y + Math.cos(FROM * Math.PI / 180) * 3000;
    await chatOn(pilot, "@vehicle despawn all");
    await chatOn(pilot, teleloc(sx, sy, groundAt(sx, sy) + 0.6, FROM + 180));
    await sleep(Number(opt("--settle", "20000")));
    res.spawn = await runOn(pilot, "vehicle-spawn.eval.js", {});
    log("spawn", JSON.stringify(res.spawn?.summary ?? res.spawn?.fatal));
    for (let i = 0; i < 40; i++) {
      const ok = await pilot.evaluate(() => !!window.__vehicles.nearest()).catch(() => false);
      if (ok) break;
      await sleep(500);
    }
    // the camera behind victim 1, looking along its facing (the approach), a little above the head
    log("cam", JSON.stringify(await vpages[0].evaluate(({ az }) => window.__cam?.player?.(Number(az.d), Number(az.az), Number(az.el), Number(az.dz)) ?? null,
      { az: { d: opt("--cam-dist", "6"), az: String((FROM + 180) % 360), el: opt("--cam-el", "9"), dz: opt("--cam-dz", "1.7") } })));
    let recOn = false;
    const watch = setInterval(async () => {
      const ph = await pilot.evaluate(() => window.__filmPhase ?? null).catch(() => null);
      if (!recOn && (ph === "attackStart" || ph === "firstFire")) {
        recOn = true;
        try { res.rec = await startRec(); log("recording", JSON.stringify(res.rec)); } catch (e) { res.errors.push(`rec: ${e.message}`); }
      }
    }, 250);
    // start the recording a little before the attack phase begins (the Hellcat a speck on the horizon)
    res.flight = await runOn(pilot, "film-hellcat.eval.js", { ...RUN, mode: "attack", attackStartM: 2200, slowAtM: 3000, attackView: "chase", cruiseAgl: 70,
      attackThrottle: Number(opt("--attack-throttle", "0.38")), maxPasses: Number(opt("--max-passes", "1")), maxSec: 300 });
    clearInterval(watch);
    log("attack", JSON.stringify(res.flight?.summary ?? res.flight?.fatal ?? res.flight).slice(0, 1200));
    await sleep(Number(opt("--tail", "5000")));
    if (!recOn) { res.errors.push("the recording never started"); }
  }
  if (res.rec) {
    res.recStop = await stopRec();
    log("recording stopped", JSON.stringify({ ...res.recStop, drainedMB: Math.round(drainedBytes / 1048576) }));
    // events in video time
    const evs = (res.flight?.events || []).map((e) => ({ kind: e.kind, video: res.recStop.t0 != null ? Math.round((e.t - res.recStop.t0)) / 1000 : null, ...e }));
    res.videoEvents = evs.map((e) => ({ kind: e.kind, video: e.video }));
    log("events", JSON.stringify(res.videoEvents));
    try {
      execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(REC_FPS), "-i", H264, "-c", "copy", "-movflags", "+faststart", join(OUT, `${STEM}.mp4`)]);
      log("mp4", join(OUT, `${STEM}.mp4`));
    } catch (e) { res.errors.push(`ffmpeg: ${e.message}`); }
  }
} catch (e) {
  res.errors.push(`fatal: ${e.stack || e.message}`);
  log("FATAL", e.message);
} finally {
  drainStop = true;
  save();
}
if (!has("--keep")) {
  // re-home the pilot if it ended in the air (take B ends flying)
  try { await chatOn(pilot, "@vehicle despawn all"); } catch (_) { /* */ }
  for (const pg of [pilot, ...vpages]) { try { await pg.goto("about:blank"); } catch (_) { /* */ } }
  await sleep(1500);
  try { ssh("powershell -NoProfile -ExecutionPolicy Bypass -File D:\\Temp\\hbbench\\hbbench-kill.ps1"); } catch (_) { /* */ }
  log("test Chrome closed");
}
log("out", OUT, "errors", JSON.stringify(res.errors).slice(0, 600));
process.exit(0);
