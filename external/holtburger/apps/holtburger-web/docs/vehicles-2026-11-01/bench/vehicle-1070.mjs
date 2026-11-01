// vehicle-1070.mjs — the vehicles eye-test tour on the 1070 (real GPU), for the owner to judge from pictures + video.
//
// MODE T (fleet runbook): the box's own hbprobe task launches test Chrome off-screen and muted (D:\Temp\hbbench\
// hbprobe-launch.bat, through hidden-run.vbs so nothing appears on the owner's screen); this laptop drives it over CDP.
// Needs the tunnel:  ssh -fN -L 9333:127.0.0.1:9333 -R 8765:127.0.0.1:8765 -R 8080:127.0.0.1:8080 young@100.127.215.75
// Account agentp10 (Developer), page loop at the off-screen 30 fps cap (?targetFps=30).
//
// Tour (EYETEST.md items): Holtburg → spawn the Hellcat → stand-in close-ups (#12) → board, the seated pilot (#1, #13)
// → take off (#2) → 300 km/h cruise in chase view, a banked turn (#3) → cockpit view (#5) → guns in cockpit and chase
// (#7) → boost to 400 km/h (#6) → land, exit (#9) → climb to the ceiling, bail, free fall, chute, touchdown (#10).
// Output: a CDP screencast of the whole tour (full page incl. the OSD and HUD) as JPEG frames + their timestamps, JPEG
// stills at each beat, the eval results (fps per second, corrections, first sight) and page console errors.
//   node vehicle-1070.mjs [--out DIR] [--no-launch] [--keep] [--quality high] [--window 1280,720]
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");
const BOX = "young@100.127.215.75";
const CDP = "http://127.0.0.1:9333";
const APP = "http://127.0.0.1:8765/apps/holtburger-web/index.html";
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const has = (k) => argv.includes(k);
const OUT = opt("--out", `/mnt/wbterminal1/tmp/claude-scratch/vehicles/1070-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);
const FRAMES = join(OUT, "frames");
mkdirSync(FRAMES, { recursive: true });
const t0 = Date.now();
const log = (...m) => console.log(`[1070 ${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ssh = (c) => execFileSync("ssh", ["-o", "BatchMode=yes", BOX, c], { encoding: "utf8", timeout: 60000 });
const res = { startedAt: new Date().toISOString(), out: OUT, stills: [], steps: {}, errors: [] };
const save = () => writeFileSync(join(OUT, "result.json"), JSON.stringify(res, null, 1));

// ---- launch test Chrome on the box (off-screen, muted; the gate decides)
if (!has("--no-launch")) {
  try { ssh("powershell -NoProfile -ExecutionPolicy Bypass -File D:\\Temp\\hbbench\\hbbench-kill.ps1"); } catch (_) { /* none */ }
  ssh(`echo hbb-veh-${Date.now()}> D:\\Temp\\hbbench\\profile.txt`);
  ssh(`echo ${opt("--window", "1280,720")}> D:\\Temp\\hbbench\\winsize.txt`);
  for (const f of ["angle.txt", "disablefeatures.txt", "extraflags.txt"]) ssh(`if exist D:\\Temp\\hbbench\\${f} del /q D:\\Temp\\hbbench\\${f}`);
  ssh('schtasks /create /tn hbprobe /tr "wscript.exe //B //Nologo D:\\Temp\\hbbench\\hidden-run.vbs D:\\Temp\\hbbench\\hbprobe-launch.bat" /sc once /st 00:00 /it /f >nul 2>nul & schtasks /run /tn hbprobe >nul');
  let up = false;
  for (let i = 0; i < 40 && !up; i++) { try { up = (await fetch(`${CDP}/json/version`)).ok; } catch (_) { /* not yet */ } if (!up) await sleep(1000); }
  if (!up) { log("test Chrome did not come up (gate refused? D:\\Temp\\hbbench\\gate.log)"); log(ssh("powershell -NoProfile -Command \"Get-Content D:\\Temp\\hbbench\\gate.log -Tail 3\"")); process.exit(1); }
}
const browser = await chromium.connectOverCDP(CDP);
const ctx = browser.contexts()[0];
const pg = ctx.pages().find((p) => p.url().includes("holtburger-web")) || ctx.pages()[0];
await ctx.addInitScript(() => {
  if (window.__hbConsoleErrors) return;
  const errs = (window.__hbConsoleErrors = []);
  const push = (type, text) => { if (errs.length < 500) errs.push({ t: Math.round(performance.now()), type, text: String(text).slice(0, 600) }); };
  const orig = console.error.bind(console);
  console.error = (...a) => { try { push("error", a.map((x) => (x && x.stack) || String(x)).join(" ")); } catch (_) {} return orig(...a); };
  window.addEventListener("error", (e) => push("pageerror", (e.error && e.error.stack) || e.message));
  window.addEventListener("unhandledrejection", (e) => push("rejection", (e.reason && (e.reason.stack || e.reason.message)) || e.reason));
});
const consoleLines = [];
pg.on("console", (m) => { const t = m.text(); if (/vehicle|\[vehicles\]/i.test(t) && consoleLines.length < 300) consoleLines.push(`${((Date.now() - t0) / 1000).toFixed(1)} ${t.slice(0, 300)}`); });

const url = `${APP}?autoLogin=1&account=agentp10&password=agentp10&autoSpawn=first&nosw=1&portalSpace=off&camDebug=on` +
  `&quality=${opt("--quality", "high")}&csm=off&renderScale=1&adaptiveRes=off&objRadius=3&vehicles=on&targetFps=30` + (opt("--flags", "") ? `&${opt("--flags", "")}` : "");
res.url = url.replace(/password=[^&]*/, "password=…");
await pg.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
res.gpu = await pg.evaluate(() => { const gl = document.createElement("canvas").getContext("webgl2"); const e = gl.getExtension("WEBGL_debug_renderer_info"); return gl.getParameter(e.UNMASKED_RENDERER_WEBGL); });
log("gpu", res.gpu);
if (!/1070/.test(res.gpu)) { log("NOT the GTX 1070 — stopping"); save(); process.exit(1); }
let ready = false;
for (let i = 0; i < 150 && !ready; i++) {
  ready = await pg.evaluate(() => !!window.liveScene3d && !!window.__sessionHandle && !!window.__vehicles && (window.__bootStateHistory || []).some((s) => (s.state || s) === "ready")).catch(() => false);
  if (!ready) await sleep(1000);
}
if (!ready) { res.boot = await pg.evaluate(() => window.__bootStateHistory).catch(() => null); log("boot FAILED", JSON.stringify(res.boot)); save(); process.exit(1); }
log("in world");
// the 1070's display turns off after 10 min idle (owner, 2026-11-01): hold a screen wake lock for the run so a dark
// display never throttles the test tab; it ends when the page navigates away (about:blank at the end)
log("wake lock", await pg.evaluate(async () => { try { window.__benchWake = await navigator.wakeLock.request("screen"); return "held"; } catch (e) { return String(e); } }).catch((e) => String(e)));

// ---- recording: CDP screencast (every composited frame, acked) + stills
const cdp = await ctx.newCDPSession(pg);
const frames = [];
let recording = true;
cdp.on("Page.screencastFrame", (e) => {
  cdp.send("Page.screencastFrameAck", { sessionId: e.sessionId }).catch(() => {});
  if (!recording) return;
  const f = `f${String(frames.length).padStart(6, "0")}.jpg`;
  writeFileSync(join(FRAMES, f), Buffer.from(e.data, "base64"));
  frames.push([f, e.metadata.timestamp]);
});
let still = async (name, note) => {
  try {
    const r = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 90 });
    const file = `${String(res.stills.length).padStart(2, "0")}-${name}.jpg`;
    writeFileSync(join(OUT, file), Buffer.from(r.data, "base64"));
    res.stills.push({ file, t: +((Date.now() - t0) / 1000).toFixed(1), note: note ?? null });
    log("still", file, note ?? "");
  } catch (e) { res.errors.push(`still ${name}: ${e.message}`); }
};
const chat = (c) => pg.evaluate((x) => window.__sessionHandle.sendChat(x), c);
const status = () => pg.evaluate(() => {
  const V = window.__vehicles, s = V.status(), p = s.pilot, h = window.__sessionHandle;
  const g = (x, y) => { try { return h.terrainHeightAt(x, y); } catch (_) { return null; } };
  const st = p?.state;
  return { piloting: V.piloting, falling: V.falling, fall: s.fall, mode: st?.mode ?? null, speed: st?.speed ?? null, bank: st?.bank ?? null,
    agl: st ? st.z - (g(st.x, st.y) ?? 0) : null, corr: p?.predictor?.corrections ?? null, vehicles: s.vehicles.length };
});
async function runEval(file, run, director) {
  await pg.evaluate((r) => { window.__vehicleRun = r; }, run);
  const src = readFileSync(join(HERE, file), "utf8");
  let done = false;
  const p = pg.evaluate(`(async () => { ${src}\n })()`).then((r) => { done = true; return r; }, (e) => { done = true; return { fatal: String(e) }; });
  const d = { t: Date.now(), seen: new Set(), at: {} };
  while (!done) {
    let s = null;
    try { s = await status(); } catch (_) { /* page busy */ }
    if (s && director) await director(s, d);
    await sleep(400);
  }
  return p;
}
const once = (d, key) => (d.seen.has(key) ? false : (d.seen.add(key), true));
const since = (d, key) => (d.at[key] ? (Date.now() - d.at[key]) / 1000 : -1);
const mark = (d, key) => { if (!d.at[key]) d.at[key] = Date.now(); };
// statics (trees / scenery) residency in the 7x7 object window around the player's landblock (the trees agent's metric)
res.trees = [];
const treeSample = async (label) => {
  try {
    const r = await pg.evaluate(() => {
      const s = window.liveScene3d, c = s.landblockLru?.getCurrentLbId?.();
      if (c == null || !s.staticsBakedLbs) return null;
      const x0 = (c >>> 24) & 255, y0 = (c >>> 16) & 255;
      let n = 0, b = 0;
      for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) { n++; if (s.staticsBakedLbs.has(((((x0 + dx) & 255) << 24) | (((y0 + dy) & 255) << 16)) >>> 0)) b++; }
      return { lb: c.toString(16), n, b };
    });
    if (r) res.trees.push({ t: +((Date.now() - t0) / 1000).toFixed(1), label, ...r });
  } catch (_) { /* page busy */ }
};
const setRun = (patch) => pg.evaluate((p) => Object.assign(window.__vehicleRun, p), patch);
const view = (v) => pg.evaluate((x) => window.__vehicles.setView(x), v);

await cdp.send("Page.startScreencast", { format: "jpeg", quality: 72, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1 });

try {
  // 1. Holtburg, a clean slate, spawn
  await chat("@teleloc 0xA9B40019 84 7.1 94");
  await sleep(14000);
  await chat("@vehicle despawn all");
  await sleep(1500);
  const tSpawn = Date.now();
  res.steps.spawn = await runEval("vehicle-spawn.eval.js", {});
  log("spawn", JSON.stringify(res.steps.spawn?.summary ?? res.steps.spawn?.fatal));
  // how long until the client has built the stand-in's rig (the spawn eval only waits 10 s), and what it fetched meanwhile
  for (let i = 0; i < 60; i++) {
    const has = await pg.evaluate(() => { const v = window.__vehicles.vehicles().slice(-1)[0]; return !!(v && window.liveScene3d.entityManager.entityMap.get(v.guid)); });
    if (has) break;
    await sleep(500);
  }
  res.standInSpawnSec = +((Date.now() - tSpawn) / 1000).toFixed(1);
  res.standInFetches = await pg.evaluate((since) => performance.getEntriesByType("resource")
    .filter((e) => e.startTime >= performance.now() - since)
    .sort((a, b) => b.duration - a.duration).slice(0, 12)
    .map((e) => ({ name: e.name.replace(/^.*\/apps\//, "").slice(-90), ms: Math.round(e.duration), kb: Math.round((e.transferSize || 0) / 1024), at: Math.round(e.startTime) })), Date.now() - tSpawn + 2000);
  log("stand-in rig built after", res.standInSpawnSec, "s");
  await sleep(4000);
  await still("parked-player-view", "the Hellcat stand-in parked 6 m ahead (player camera)");
  // stand-in close-ups (free camera)
  const vp = await pg.evaluate(() => { const v = window.__vehicles.vehicles().slice(-1)[0]; const p = window.liveScene3d.entityManager.entityMap.get(v.guid)?.root?.position; return p ? { x: p.x, y: p.y, z: p.z } : null; });
  if (vp) {
    await pg.evaluate((p) => window.__cam.orbit(p.x, p.y, p.z + 1, 9, 30, 12), vp); await sleep(1500);
    await still("standin-closeup-front", "stand-in (Drudge Balloon 0x020016F1 at 0.3) — 9 m around the vehicle origin (the balloon floats 5.7-12 m above it)");
    await pg.evaluate((p) => window.__cam.orbit(p.x, p.y, p.z + 1, 6, 160, 25), vp); await sleep(1500);
    await still("standin-closeup-high", "stand-in from above/behind — 6 m");
    await pg.evaluate(() => window.__cam.release()); await sleep(800);
  }
  // board and look at the seated pilot before take-off
  await pg.evaluate(() => window.__vehicles.board());
  for (let i = 0; i < 60; i++) { if ((await status()).piloting) break; await sleep(100); }
  // the boarding hop (board_hop.js, ~0.6-1.2 s): a burst of stills
  await sleep(150); await still("board-hop-1", "boarding hop: leaving the ground");
  await sleep(250); await still("board-hop-2", "boarding hop: mid-air");
  await sleep(300); await still("board-hop-3", "boarding hop: arriving at the seat");
  await sleep(2000);
  await still("boarded-chase", "just boarded: chase camera, pilot seated (retail Sitting) at seat offset (0,0,5.75) = in the balloon basket");
  // (free-camera close-ups do not work while seated: the vehicle's camera owner wins) — a cockpit look instead
  await pg.evaluate(() => window.__vehicles.setView("cockpit")); await sleep(2000);
  await still("boarded-cockpit", "parked, cockpit view from the seat (pilot rig hidden in cockpit)");
  await pg.evaluate(() => window.__vehicles.setView("chase")); await sleep(1500);
  // step out again: the flight eval boards on its own (and would teleport next to a parked vehicle if none is
  // boardable — a teleport while seated unseats the pilot)
  await pg.evaluate(() => window.__vehicles.exit(0));
  for (let i = 0; i < 30; i++) { if (!(await status()).piloting) break; await sleep(300); }
  await sleep(2500);

  // 2. flight: take off, 300 km/h cruise, a banked turn, cockpit, guns, boost to 400 km/h, land, exit
  res.steps.flight = await runEval("vehicle-flight.eval.js",
    { route: [{ heading: 111, metres: 2600 }, { heading: 291, metres: 3200 }], agl: 70, throttle: 1, boost: false, fire: false, maxSec: 300 },
    async (s, d) => {
      if (s.mode === 1 && once(d, "takeoff")) { await sleep(2000); await still("takeoff", "vertical take-off to the 30 m floor (#2)"); }
      if (s.mode === 2) { mark(d, "flight"); if (!d.at.tree || Date.now() - d.at.tree > 2000) { d.at.tree = Date.now(); await treeSample((s.speed ?? 0) > 100 ? "400" : "cruise"); } }
      if (since(d, "flight") > 12 && once(d, "cruise")) await still("cruise-chase", `cruise ${Math.round(s.speed * 3.6)} km/h, chase camera (#3)`);
      if (since(d, "flight") > 14 && Math.abs(s.bank ?? 0) > 0.6 && once(d, "bank")) { await still("bank-chase", `banked turn ${Math.round((s.bank * 180) / Math.PI)}°, chase camera (#3)`); mark(d, "banked"); }
      if (since(d, "banked") > 6 && Math.abs(s.bank ?? 0) < 0.15 && once(d, "cockpit")) {
        await view("cockpit"); await sleep(2500); await still("cockpit", "cockpit view (#5)");
        await setRun({ fire: true }); await sleep(900); await still("cockpit-guns", "guns from the cockpit: tracers along the nose (#7)");
        await sleep(1200); await setRun({ fire: false });
        await view("chase"); await sleep(2500);
        await setRun({ fire: true }); await sleep(900); await still("chase-guns", "guns in chase view (#7)");
        await sleep(1000); await setRun({ fire: false });
        await setRun({ boost: true }); mark(d, "boost");
      }
      if (since(d, "boost") > 0 && (s.speed ?? 0) > 105 && once(d, "fast1")) { await sleep(3000); await still("400kmh-chase", `boost ${Math.round(s.speed * 3.6)} km/h (#6): terrain / objects ahead`); }
      if (d.seen.has("fast1") && since(d, "boost") > 18 && once(d, "fast2")) await still("400kmh-chase-2", `boost ${Math.round(s.speed * 3.6)} km/h, later (#6)`);
      if (s.mode === 3 && once(d, "landing")) { await sleep(3000); await still("landing", "hold L: slowing, descending (#9)"); }
      if (s.mode === 0 && d.seen.has("landing") && once(d, "parked")) await still("landed-parked", "parked after landing (#9)");
      if (!s.piloting && d.seen.has("parked") && once(d, "exited")) { await sleep(2500); await still("exited", "exited beside the vehicle (#9)"); }
    });
  const f = res.steps.flight || {};
  log("flight", JSON.stringify(f.summary ?? f.fatal ?? null).slice(0, 600));
  if (!res.stills.some((x) => /exited/.test(x.file))) { await sleep(2500); await still("after-flight", "after the flight"); }

  // 3. bail-out: climb to the ceiling, bail, fall, chute, touchdown; the derelict glides away and crashes
  res.steps.bail = await runEval("vehicle-bail.eval.js", { climbAgl: 449, maxSec: 240 }, async (s, d) => {
    if (s.piloting && (s.agl ?? 0) > 200 && once(d, "climb")) await still("climb", `climbing, ${Math.round(s.agl)} m AGL`);
    if (s.piloting && (s.agl ?? 0) > 430 && once(d, "ceiling")) await still("ceiling", `at the ceiling, ${Math.round(s.agl)} m AGL`);
    if (s.falling && s.fall && !s.fall.chute && once(d, "fall")) { await sleep(2500); await still("freefall", "free fall after the bail (#10)"); }
    if (s.falling && s.fall?.chute && once(d, "chute")) { await sleep(2000); await still("chute", `under the chute, ${Math.round(s.fall.agl)} m AGL, canopy + fall camera (#10)`); mark(d, "chuteAt"); }
    if (since(d, "chuteAt") > 9 && s.falling && once(d, "chute2")) await still("chute-low", `under the chute, ${Math.round(s.fall?.agl ?? 0)} m AGL`);
    if (!s.falling && d.seen.has("chute") && once(d, "down")) { await sleep(2500); await still("touchdown", "landed on foot (#10)"); }
  });
  log("bail", JSON.stringify(res.steps.bail?.summary ?? res.steps.bail?.fatal ?? null).slice(0, 600));
  await sleep(4000);
  await still("end", "end of the tour");
} catch (e) {
  res.errors.push(String(e && e.stack || e));
  log("tour error", e.message);
}

recording = false;
try { await cdp.send("Page.stopScreencast"); } catch (_) { /* gone */ }
res.frames = frames.length;
writeFileSync(join(OUT, "frames.json"), JSON.stringify(frames));
res.consoleErrors = await pg.evaluate(() => window.__hbConsoleErrors || []).catch(() => null);
res.agentDiag = await pg.evaluate(() => ({
  cloudEdge: (() => { try { return window.__cloudEdgeResolve?.stats?.() ?? null; } catch (e) { return String(e); } })(),
  objRefire: (() => { try { return window.__objRefire?.() ?? null; } catch (e) { return String(e); } })(),
  farPolicy: (() => { try { return window.__farTerrainState?.()?.policyViolations ?? null; } catch (e) { return String(e); } })(),
})).catch(() => null);
const tb = res.trees.filter((x) => x.n);
res.treesSummary = tb.length ? { samples: tb.length, bakedFrac: +(tb.reduce((a, x) => a + x.b / x.n, 0) / tb.length).toFixed(3),
  cruise: (() => { const c = tb.filter((x) => x.label === "cruise"); return c.length ? +(c.reduce((a, x) => a + x.b / x.n, 0) / c.length).toFixed(3) : null; })(),
  fast: (() => { const c = tb.filter((x) => x.label === "400"); return c.length ? +(c.reduce((a, x) => a + x.b / x.n, 0) / c.length).toFixed(3) : null; })() } : null;
log("trees", JSON.stringify(res.treesSummary), "agentDiag", JSON.stringify(res.agentDiag).slice(0, 400));
res.vehicleConsole = consoleLines;
res.wire = await pg.evaluate(() => JSON.parse(window.__sessionHandle.vehicleWireStats())).catch(() => null);
save();
log(`frames ${frames.length}, stills ${res.stills.length}, errors ${res.errors.length}, console errors ${res.consoleErrors?.length ?? "?"}`);
if (!has("--keep")) {
  try { await pg.goto("about:blank"); } catch (_) { /* */ }
  await sleep(1500);
  try { ssh("powershell -NoProfile -ExecutionPolicy Bypass -File D:\\Temp\\hbbench\\hbbench-kill.ps1"); } catch (_) { /* */ }
  log("test Chrome closed");
}
log("out", OUT);
process.exit(0);
