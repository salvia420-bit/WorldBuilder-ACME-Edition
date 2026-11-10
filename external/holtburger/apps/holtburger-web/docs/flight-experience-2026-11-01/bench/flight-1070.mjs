// flight-1070.mjs — the flight-experience tour on the 1070 (real GPU): one arm = one fresh off-screen, muted test
// Chrome, one login, one flight, the ?residencyLog record + stills + a CDP screencast, then Chrome is closed.
//
// MODE T (fleet runbook): the box's hidden hbprobe task launches Chrome off-screen and muted; this laptop drives it
// over CDP. Tunnel first:
//   ssh -o ExitOnForwardFailure=yes -fN -L 9333:127.0.0.1:9333 -R 8765:127.0.0.1:8765 -R 8080:127.0.0.1:8080 young@100.127.215.75
// Account agentp10 (Developer), page loop at the off-screen 30 fps cap (?targetFps=30), fixed noon (?skytime=12).
// --uncapped --onscreen (owner OK 2026-11-01, 01:30-05:30 NST only; refused outside): the window maximized on the
// owner's screen (still muted), ?targetFps=0 + the launcher's --disable-frame-rate-limit --disable-gpu-vsync.
//
// Route (plan file, default plan-fx-tour.json): Holtburg → take off → 225° over the densest forest near Holtburg
// (lane B tall-tree counts) at 300 km/h → 45° back at 400 km/h across Holtburg (the town pass) → land, exit.
//
//   node flight-1070.mjs --label A-baseline [--flags "lbFade=on&flightResidency=on"] [--plan plan-fx-tour.json]
//        [--window 1600,900] [--no-video] [--keep] [--no-launch]
// Output: /mnt/wbterminal1/tmp/claude-scratch/flight-experience/1070-<label>/ (result.json, residency.json, stills,
// frames/ + frames.json for bench/../../vehicles-2026-11-01/bench/frames_to_mp4.py).
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
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
const LABEL = opt("--label", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
const UNCAPPED = has("--uncapped");
const ONSCREEN = has("--onscreen");
// the owner's on-screen / uncapped window: 01:30-05:30 Newfoundland time (2026-11-01). Refuse outside it.
// --owner-ok: the owner opened on-screen uncapped testing live ("onscreen 1070 uncapped fps testing now available",
// 2026-11-02 00:17 NST) — the time window is not checked then.
if ((UNCAPPED || ONSCREEN) && !has("--owner-ok")) {
  const nst = new Date(Date.now() - 3.5 * 3600 * 1000); // NST = UTC-3:30
  const mins = nst.getUTCHours() * 60 + nst.getUTCMinutes();
  if (!(mins >= 90 && mins < 330)) { console.log(`refusing --uncapped / --onscreen outside 01:30-05:30 NST (now ${nst.toISOString().slice(11, 16)} NST); --owner-ok when the owner opened it live`); process.exit(2); }
}
const OUT = opt("--out", `/mnt/wbterminal1/tmp/claude-scratch/flight-experience/1070-${LABEL}`);
const FRAMES = join(OUT, "frames");
mkdirSync(FRAMES, { recursive: true });
const plan = JSON.parse(readFileSync(resolve(HERE, opt("--plan", "plan-fx-tour.json")), "utf8"));
const t0 = Date.now();
const log = (...m) => console.log(`[fx1070 ${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ssh = (c) => execFileSync("ssh", ["-o", "BatchMode=yes", BOX, c], { encoding: "utf8", timeout: 60000 });
const res = { label: LABEL, startedAt: new Date().toISOString(), out: OUT, plan: plan.name, stills: [], steps: {}, errors: [] };
const save = () => writeFileSync(join(OUT, "result.json"), JSON.stringify(res, null, 1));

// ---- launch test Chrome on the box (off-screen, muted, fresh profile; the gate decides)
if (!has("--no-launch")) {
  try { ssh("powershell -NoProfile -ExecutionPolicy Bypass -File D:\\Temp\\hbbench\\hbbench-kill.ps1"); } catch (_) { /* none */ }
  // --profile-dir NAME: reuse a Chrome profile (a WARM shader cache, as a returning player has); default = fresh
  const PROF = opt("--profile-dir", "") ? `fxkeep-${opt("--profile-dir", "").replace(/[^A-Za-z0-9-]/g, "")}` : `hbb-fx-${LABEL.replace(/[^A-Za-z0-9-]/g, "")}-${Date.now()}`;
  ssh(`echo ${PROF}> D:\\Temp\\hbbench\\profile.txt`);
  ssh(`echo ${opt("--window", "1600,900")}> D:\\Temp\\hbbench\\winsize.txt`);
  for (const f of ["angle.txt", "disablefeatures.txt", "extraflags.txt", "uncapped.txt"]) ssh(`if exist D:\\Temp\\hbbench\\${f} del /q D:\\Temp\\hbbench\\${f}`);
  // --uncapped (owner OK 2026-11-01: on-screen uncapped runs 01:30-05:30 NST only): the launcher adds
  // --disable-frame-rate-limit --disable-gpu-vsync, and the URL pins ?targetFps=0
  // --vsync: the app cap off (?targetFps=0) but Chrome keeps vsync and its frame-rate limit — what the owner plays with
  if (UNCAPPED && !has("--vsync")) ssh("echo 1> D:\\Temp\\hbbench\\uncapped.txt");
  ssh('schtasks /create /tn hbprobe /tr "wscript.exe //B //Nologo D:\\Temp\\hbbench\\hidden-run.vbs D:\\Temp\\hbbench\\hbprobe-launch.bat" /sc once /st 00:00 /it /f >nul 2>nul & schtasks /run /tn hbprobe >nul');
  let up = false;
  for (let i = 0; i < 40 && !up; i++) { try { up = (await fetch(`${CDP}/json/version`)).ok; } catch (_) { /* not yet */ } if (!up) await sleep(1000); }
  if (!up) { log("test Chrome did not come up (gate refused? D:\\Temp\\hbbench\\gate.log)"); try { log(ssh("powershell -NoProfile -Command \"Get-Content D:\\Temp\\hbbench\\gate.log -Tail 3\"")); } catch (_) { /* */ } process.exit(1); }
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
  const ow = console.warn.bind(console);
  console.warn = (...a) => { try { const s = a.map((x) => (x && x.stack) || String(x)).join(" "); if (/lbFade|far_terrain|world_terrain|far_forest|residency|shader|GLSL|program/i.test(s)) push("warn", s); } catch (_) {} return ow(...a); };
  window.addEventListener("error", (e) => push("pageerror", (e.error && e.error.stack) || e.message));
  window.addEventListener("unhandledrejection", (e) => push("rejection", (e.reason && (e.reason.stack || e.reason.message)) || e.reason));
});

// --no-rlog: no residency sampler (~1-2 % of the main thread) — for pure frame-rate runs
const flags = [...(has("--no-rlog") ? [] : ["residencyLog=on"]), "skytime=12", ...(plan.flags ? [plan.flags] : []), ...(opt("--flags", "") ? [opt("--flags", "")] : [])].join("&");
const url = `${APP}?autoLogin=1&account=agentp10&password=agentp10&autoSpawn=first&nosw=1&portalSpace=off&camDebug=on` +
  `&quality=${opt("--quality", "high")}&csm=off&renderScale=1&adaptiveRes=off&vehicles=on&targetFps=${UNCAPPED ? 0 : 30}&${flags}`;
res.url = url.replace(/password=[^&]*/, "password=…");
log("url", res.url);
// --onscreen: the window from -32000,-32000 to the owner's screen, maximized, in front (still muted: the launcher's
// --mute-audio stays). Only inside the owner's 01:30-05:30 window (checked above).
if (ONSCREEN) {
  try {
    const c0 = await ctx.newCDPSession(pg);
    const { windowId } = await c0.send("Browser.getWindowForTarget");
    await c0.send("Browser.setWindowBounds", { windowId, bounds: { left: 0, top: 0, width: 1600, height: 900, windowState: "normal" } });
    await sleep(300);
    await c0.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "maximized" } });
    await pg.bringToFront();
    res.window = await c0.send("Browser.getWindowBounds", { windowId });
    log("on-screen", JSON.stringify(res.window));
  } catch (e) { res.errors.push(`onscreen: ${e.message}`); log("on-screen failed", e.message); }
}
await pg.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
res.gpu = await pg.evaluate(() => { const gl = document.createElement("canvas").getContext("webgl2"); const e = gl.getExtension("WEBGL_debug_renderer_info"); return gl.getParameter(e.UNMASKED_RENDERER_WEBGL); });
log("gpu", res.gpu);
if (!/1070/.test(res.gpu)) { log("NOT the GTX 1070 — stopping"); save(); process.exit(1); }
let ready = false;
for (let i = 0; i < 180 && !ready; i++) {
  ready = await pg.evaluate(() => {
    if (!window.liveScene3d || !window.__sessionHandle || !window.__vehicles) return false;
    const me = (window.getLocalPlayerGuid?.() ?? 0) >>> 0;
    if (!me || !window.liveScene3d.entityManager?.entityMap?.get(me)) return false;
    const h = (window.__bootStateHistory || []).map((s) => s.state || s);
    if (!h.includes("in-world")) return false;
    let meshes = 0;
    try { window.liveScene3d.scene.traverse((o) => { if (o.isMesh) meshes += 1; }); } catch (_) { return false; }
    return meshes > 300;
  }).catch(() => false);
  if (!ready) await sleep(1000);
}
if (!ready) { res.boot = await pg.evaluate(() => window.__bootStateHistory).catch(() => null); log("boot FAILED", JSON.stringify(res.boot)); save(); process.exit(1); }
log("in world");
// --storm: force the storm DayGroup look (weather_state.js __setWeather) to exercise the storm clouds in flight
if (has("--storm")) { try { log("storm", await pg.evaluate(() => (window.__setWeather({ is_storm: true }), window.__getWeather().is_storm))); } catch (e) { res.errors.push(`storm: ${e.message}`); } }
// --fair: force fair weather (the server's DayGroup may be stormy at the time of a run)
if (has("--fair")) { try { log("fair", await pg.evaluate(() => (window.__setWeather({ is_storm: false }), !window.__getWeather().is_storm))); } catch (e) { res.errors.push(`fair: ${e.message}`); } }
log("wake lock", await pg.evaluate(async () => { try { window.__benchWake = await navigator.wakeLock.request("screen"); return "held"; } catch (e) { return String(e); } }).catch((e) => String(e)));

// ---- recording
const cdp = await ctx.newCDPSession(pg);
const frames = [];
let recording = !has("--no-video");
cdp.on("Page.screencastFrame", (e) => {
  cdp.send("Page.screencastFrameAck", { sessionId: e.sessionId }).catch(() => {});
  if (!recording) return;
  const f = `f${String(frames.length).padStart(6, "0")}.jpg`;
  writeFileSync(join(FRAMES, f), Buffer.from(e.data, "base64"));
  frames.push([f, e.metadata.timestamp]);
});
const still = async (name, note) => {
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
  return { piloting: V.piloting, mode: st?.mode ?? null, speed: st?.speed ?? null, bank: st?.bank ?? null, x: st?.x ?? null, y: st?.y ?? null,
    agl: st ? st.z - (g(st.x, st.y) ?? 0) : null };
});
const evalFile = (f) => { try { return readFileSync(resolve(HERE, f), "utf8"); } catch (_) { return readFileSync(resolve(VEH, f), "utf8"); } };
async function runEval(file, run, director) {
  await pg.evaluate((r) => { window.__vehicleRun = r; }, run);
  let done = false;
  const p = pg.evaluate(`(async () => { ${evalFile(file)}\n })()`).then((r) => { done = true; return r; }, (e) => { done = true; return { fatal: String(e) }; });
  const d = { t: Date.now(), seen: new Set(), at: {} };
  while (!done) {
    let s = null;
    try { s = await status(); } catch (_) { /* page busy */ }
    if (s && director) await director(s, d);
    await sleep(400);
  }
  return p;
}
// self time by function and by file, and inclusive time by function, from a CDP CPU profile
function summarizeProfile(pf) {
  const byId = new Map(pf.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of pf.nodes) for (const c of n.children || []) parent.set(c, n.id);
  const self = new Map();
  for (let i = 0; i < pf.samples.length; i += 1) {
    const dt = (pf.timeDeltas[i + 1] ?? pf.timeDeltas[i] ?? 0) / 1000;
    self.set(pf.samples[i], (self.get(pf.samples[i]) || 0) + dt);
  }
  const totalMs = [...self.values()].reduce((a, b) => a + b, 0);
  const label = (n) => { const c = n.callFrame; const f = (c.url || "").split("/").pop().split("?")[0] || "(native)"; return { fn: `${c.functionName || "(anon)"} @ ${f}:${c.lineNumber + 1}`, file: f }; };
  const fnSelf = new Map(), fileSelf = new Map(), incl = new Map();
  for (const [id, ms] of self) {
    const n = byId.get(id); if (!n) continue;
    const l = label(n);
    fnSelf.set(l.fn, (fnSelf.get(l.fn) || 0) + ms);
    fileSelf.set(l.file, (fileSelf.get(l.file) || 0) + ms);
    // inclusive: each sample counts once for every distinct function on its stack
    const seen = new Set();
    for (let cur = id; cur != null; cur = parent.get(cur)) {
      const m = byId.get(cur); if (!m) break;
      const k = label(m).fn;
      if (seen.has(k)) continue;
      seen.add(k);
      incl.set(k, (incl.get(k) || 0) + ms);
    }
  }
  const top = (m, k) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([name, ms]) => ({ name, ms: Math.round(ms), pct: +(100 * ms / totalMs).toFixed(1) }));
  return { totalMs: Math.round(totalMs), selfByFile: top(fileSelf, 25), selfByFn: top(fnSelf, 40), inclusiveByFn: top(incl, 60) };
}
const once = (d, key) => (d.seen.has(key) ? false : (d.seen.add(key), true));
const since = (d, key) => (d.at[key] ? (Date.now() - d.at[key]) / 1000 : -1);
const mark = (d, key) => { if (!d.at[key]) d.at[key] = Date.now(); };

if (recording) await cdp.send("Page.startScreencast", { format: "jpeg", quality: 72, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1 });

try {
  await chat(`@teleloc ${plan.start || "0xA9B40019 84 7.1 94"}`);
  await sleep(plan.settleMs ?? 15000);
  await chat("@vehicle despawn all");
  await sleep(1500);
  res.steps.spawn = await runEval("vehicle-spawn.eval.js", {});
  log("spawn", JSON.stringify(res.steps.spawn?.summary ?? res.steps.spawn?.fatal));
  for (let i = 0; i < 60; i++) {
    const hasRig = await pg.evaluate(() => { const v = window.__vehicles.vehicles().slice(-1)[0]; return !!(v && window.liveScene3d.entityManager.entityMap.get(v.guid)); });
    if (hasRig) break;
    await sleep(500);
  }
  await sleep(3000);
  await pg.evaluate(() => window.__residency?.clear?.()); // the record starts at the flight
  // the exact rAF frame-interval record (Q5 / Q7): on foot standing by the parked aircraft from here, the flight
  // from the take-off mark on. Under the 30 fps cap rAF still ticks at the display rate (the cap skips renders),
  // so these numbers mean frames only with --uncapped (?targetFps=0).
  try {
    await pg.evaluate(() => {
      const rec = (window.__fxFrameRec = { t0: performance.now(), dts: [], last: 0, on: true, takeoffIdx: -1 });
      const f = (t) => { if (!rec.on) return; if (rec.last) rec.dts.push(t - rec.last); rec.last = t; requestAnimationFrame(f); };
      requestAnimationFrame(f);
    });
  } catch (e) { res.errors.push(`frameRec: ${e.message}`); }
  if (has("--profile-foot")) {
    // a 6 s CPU profile of the on-foot reference segment (standing next to the aircraft)
    try {
      await sleep(2000);
      await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 500 }); await cdp.send("Profiler.start");
      await sleep(6000);
      const { profile } = await cdp.send("Profiler.stop");
      writeFileSync(join(OUT, "cpu-foot.cpuprofile"), JSON.stringify(profile));
      res.profileFoot = summarizeProfile(profile);
      log("foot profile", JSON.stringify(res.profileFoot.selfByFile.slice(0, 6)));
      await sleep(2000);
    } catch (e) { res.errors.push(`foot profile: ${e.message}`); await sleep(10000); }
  } else await sleep(10000); // 10 s standing on foot next to the aircraft: the on-foot reference segment
  await still("parked", "parked at Holtburg, before take-off");
  const stillsAt = plan.stillsAtSec || [12, 25, 40, 55, 70, 85, 100];
  // --profile START,DUR: a sampled CPU profile of the page's main thread from START s to START+DUR s of flight
  // (several windows: "40,8;200,8")
  const profs = opt("--profile", "") ? opt("--profile", "").split(";").map((w) => w.split(",").map(Number)) : [];
  res.profiles = [];
  res.steps.flight = await runEval("flight.eval.js", plan.flight, async (s, d) => {
    for (let i = 0; i < profs.length; i += 1) {
      const [p0, pd] = profs[i];
      if (s.mode === 2 && since(d, "flight") > p0 && once(d, `profStart${i}`)) {
        try { await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 500 }); await cdp.send("Profiler.start"); log(`profiler ${i} on`, `${Math.round(s.agl ?? 0)} m AGL`); }
        catch (e) { res.errors.push(`profiler start: ${e.message}`); }
      }
      if (d.seen.has(`profStart${i}`) && since(d, "flight") > p0 + pd && once(d, `profStop${i}`)) {
        try {
          const { profile } = await cdp.send("Profiler.stop");
          writeFileSync(join(OUT, `cpu-${i}.cpuprofile`), JSON.stringify(profile));
          const sum = summarizeProfile(profile);
          res.profiles.push({ window: [p0, pd], agl: s.agl ?? null, ...sum });
          log(`profiler ${i} off`, JSON.stringify(sum.selfByFile.slice(0, 6)));
        } catch (e) { res.errors.push(`profiler stop: ${e.message}`); }
      }
    }
    // --ab ARMS --ab-agl M [--ab-fair ARMS]: the cloud-march A/B (fps-ab-1070.mjs) mid-flight, in THIS process (the
    // laptop's one-heavy-job rule: a second node job alongside the run is refused). The page's autopilot keeps flying
    // while the director waits; when the arms are done the route is ended early (window.__vehicleRun.stop).
    if (opt("--ab", "") && s.mode === 2 && (s.agl ?? 0) >= Number(opt("--ab-agl", "4800")) && once(d, "ab")) {
      log("ab: at", Math.round(s.agl ?? 0), "m AGL, settling");
      await sleep(Number(opt("--ab-settle", "25000")));
      try {
        const { runAb } = await import("./fps-ab-1070.mjs");
        res.ab = { storm: await runAb({ pg, cdp, out: join(OUT, "ab-1"), arms: opt("--ab", "").split(","), sec: 8, settle: 3500, log }) };
        if (opt("--ab-fair", "")) {
          res.ab.fair = await runAb({ pg, cdp, out: join(OUT, "ab-2-fair"), arms: opt("--ab-fair", "").split(","), sec: 8, settle: 3500,
            weather: "fair", weatherSettle: 15000, log });
        }
      } catch (e) { res.errors.push(`ab: ${e.message}`); }
      save();
      try { await pg.evaluate(() => { if (window.__vehicleRun) window.__vehicleRun.stop = true; }); } catch (_) { /* */ }
    }
    if (s.mode === 2 && once(d, "frameRec")) {
      try { await pg.evaluate(() => { const r = window.__fxFrameRec; if (r && r.takeoffIdx < 0) r.takeoffIdx = r.dts.length; }); }
      catch (e) { res.errors.push(`frameRec mark: ${e.message}`); }
    }
    if (s.mode === 2 && since(d, "flight") > 60 && once(d, "drawInfo")) {
      // renderer stats at cruise: draws / triangles / programs (autoReset: the last frame's counts)
      try {
        res.drawInfo = await pg.evaluate(async () => {
          const r = window.liveScene3d?.renderer; const i = r?.info;
          if (!i) return null;
          // the composer renders several passes per frame: count one whole frame (autoReset off, reset, one rAF)
          const was = i.autoReset;
          i.autoReset = false; i.reset();
          await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
          const frame = { calls: i.render.calls, triangles: i.render.triangles };
          i.autoReset = was;
          let meshes = 0, visible = 0;
          try { window.liveScene3d.scene.traverse((o) => { if (o.isMesh) { meshes += 1; if (o.visible) visible += 1; } }); } catch (_) { /* */ }
          return { frameCalls: frame.calls, frameTriangles: frame.triangles,
            programs: i.programs?.length ?? null, geometries: i.memory.geometries, textures: i.memory.textures, meshes, visibleMeshes: visible,
            entities: window.liveScene3d.entityManager?.entityMap?.size ?? null };
        });
        log("drawInfo", JSON.stringify(res.drawInfo));
      } catch (e) { res.errors.push(`drawInfo: ${e.message}`); }
    }
    if (s.mode === 2) {
      mark(d, "flight");
      for (const t of stillsAt) {
        if (since(d, "flight") > t && once(d, `s${t}`)) await still(`flight-${t}s`, `${Math.round((s.speed ?? 0) * 3.6)} km/h, ${Math.round(s.agl ?? 0)} m AGL`);
      }
    }
    if (s.mode === 3 && once(d, "landing")) await still("landing", "landing");
  });
  const f = res.steps.flight || {};
  log("flight", JSON.stringify(f.summary ?? f.fatal ?? null).slice(0, 800));
  try {
    res.frames = await pg.evaluate(() => {
      const rec = window.__fxFrameRec;
      if (!rec) return null;
      rec.on = false;
      const ti = rec.takeoffIdx >= 0 ? rec.takeoffIdx : rec.dts.length;
      const foot = rec.dts.slice(0, Math.min(ti, rec.dts.length));
      const all = rec.dts.slice(ti);
      // the first minute of flight is excluded for the max (Q5: "no frame > 100 ms after the first minute")
      let acc = 0, i60 = all.length;
      for (let i = 0; i < all.length; i++) { acc += all[i]; if (acc > 60000) { i60 = i; break; } }
      const pct = (a, p) => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); return +b[Math.min(b.length - 1, Math.floor(p / 100 * b.length))].toFixed(2); };
      const after = all.slice(i60);
      const sum = all.reduce((x, y) => x + y, 0);
      return {
        n: all.length, seconds: +(sum / 1000).toFixed(1), fpsMean: +(all.length / (sum / 1000)).toFixed(1),
        p50: pct(all, 50), p95: pct(all, 95), p99: pct(all, 99), max: all.length ? +Math.max(...all).toFixed(1) : null,
        after60: { n: after.length, p50: pct(after, 50), p99: pct(after, 99), max: after.length ? +Math.max(...after).toFixed(1) : null,
          over100: after.filter((x) => x > 100).length, over50: after.filter((x) => x > 50).length,
          fpsMean: after.length ? +(after.length / (after.reduce((x, y) => x + y, 0) / 1000)).toFixed(1) : null },
        over33: all.filter((x) => x > 33.4).length,
        // on foot by the parked aircraft (standing; the boarding and taxi at its end): the Q7 reference
        onFoot: foot.length ? { n: foot.length, fpsMean: +(foot.length / (foot.reduce((x, y) => x + y, 0) / 1000)).toFixed(1),
          p50: pct(foot, 50), p99: pct(foot, 99), max: +Math.max(...foot).toFixed(1) } : null,
      };
    });
    log("frames", JSON.stringify(res.frames));
  } catch (e) { res.errors.push(`frames: ${e.message}`); }
  // plan.fall: spawn again, climb to plan.fall.climbAgl, bail out (the vehicles bench's fall-pose eval): stills at
  // free fall / canopy / landed and every 20 s, the cloud high-band switch state on the way
  if (plan.fall) {
    await chat("@vehicle despawn all");
    await sleep(1500);
    res.steps.spawn2 = await runEval("vehicle-spawn.eval.js", {});
    await sleep(4000);
    res.steps.fall = await runEval("vehicle-fall-pose.eval.js", plan.fall, async (s, d) => {
      let ph = null;
      try { ph = await pg.evaluate(() => window.__fallPoseProbe?.phase ?? null); } catch (_) { ph = null; }
      if (ph && once(d, `ph-${ph}`)) await still(`fall-${ph}`, ph);
      mark(d, "fallStart");
      const k = Math.floor(since(d, "fallStart") / 20);
      if (k > 0 && once(d, `fs${k}`)) {
        let cl = null;
        try { cl = await pg.evaluate(() => (window.__cloudHighBand ? window.__cloudHighBand() : null)); } catch (_) { cl = null; }
        (res.cloudHighBand = res.cloudHighBand || []).push({ t: k * 20, agl: s.agl ?? null, ...cl });
        await still(`fall-run-${k * 20}s`, `${Math.round(s.agl ?? 0)} m AGL, mode ${s.mode}`);
      }
    });
    log("fall", JSON.stringify(res.steps.fall?.checks ?? res.steps.fall?.fatal ?? null).slice(0, 1200));
  }
  await sleep(2000);
} catch (e) {
  res.errors.push(String(e && e.stack || e));
  log("tour error", e.message);
}

recording = false;
try { await cdp.send("Page.stopScreencast"); } catch (_) { /* gone */ }
res.screencastFrames = frames.length;
writeFileSync(join(OUT, "frames.json"), JSON.stringify(frames));
// the residency record (events as columns), written to its own file
try {
  const dump = await pg.evaluate(() => {
    const R = window.__residency;
    if (!R) return null;
    const d = R.dump();
    return JSON.stringify({ ...d, flips10: R.flips(10), flips30: R.flips(30) });
  });
  if (dump) {
    writeFileSync(join(OUT, "residency.json"), dump);
    const d = JSON.parse(dump);
    res.residency = { seconds: d.summary.seconds, events: d.summary.events, toggles: d.summary.toggles, flips10: { obj: d.flips10.objects.flips, ter: d.flips10.terrain.flips },
      holes: { frames: d.holes.holeFrames, lbFrames: d.holes.holeLbFrames, ahead: d.holes.holeAheadLbFrames, spans: d.holes.spans, spanMax: d.holes.spanMax },
      lead: { terrain: d.lead.terrain, objects: d.lead.objects }, cover: d.summary.cover, fps: d.summary.fps, frameP99Max: d.summary.frameP99Max,
      frameMaxAfter60s: d.summary.frameMaxAfter60s, bakes: d.summary.bakes, loafTop: (d.summary.loaf || []).slice(0, 6) };
  } else res.errors.push("no __residency (flag not applied?)");
} catch (e) { res.errors.push(`residency dump: ${e.message}`); }
res.diag = await pg.evaluate(() => ({
  lbPresence: (() => { try { return window.__lbPresence?.() ?? null; } catch (e) { return String(e); } })(),
  far: (() => { try { const s = window.__farTerrainState?.(); return s ? { ring: s.ring, fog: s.fog, nearEff: s.nearEffectiveRadiusLb } : null; } catch (e) { return String(e); } })(),
  objRefire: (() => { try { return window.__objRefire?.() ?? null; } catch (e) { return String(e); } })(),
  worldTier: (() => { try { return window.__worldTerrain?.() ?? null; } catch (e) { return String(e); } })(),
  farForest: (() => { try { return window.__farForest?.() ?? null; } catch (e) { return String(e); } })(),
  airframes: (() => { try { return window.__vehicles?.status?.()?.airframes ?? null; } catch (e) { return String(e); } })(),
})).catch(() => null);
res.consoleErrors = await pg.evaluate(() => window.__hbConsoleErrors || []).catch(() => null);
save();
log("residency", JSON.stringify(res.residency ?? null).slice(0, 1500));
log(`screencast frames ${frames.length}, stills ${res.stills.length}, errors ${res.errors.length}, console errors ${res.consoleErrors?.length ?? "?"}`);
// a run that ends in the air (plan exit / land false): despawn the aircraft and teleport the character back to the
// start before Chrome closes. Otherwise the server unseats the body onto the ground below — the ocean west of the
// coast after a long westward leg: an invalid spawn, so the next login lands in the sanctuary with a client pose that
// no longer matches and its @teleloc / vehicle spawn fail (run U9b, 2026-11-02).
if (plan.flight && plan.flight.exit === false && plan.flight.land === false && !has("--keep")) {
  try {
    await chat("@vehicle despawn all"); await sleep(2000);
    await chat(`@teleloc ${plan.start || "0xA9B40019 84 7.1 94"}`); await sleep(5000);
    log("re-homed (the run ended in the air)");
  } catch (e) { res.errors.push(`re-home: ${e.message}`); }
}
if (!has("--keep")) {
  try { await pg.goto("about:blank"); } catch (_) { /* */ }
  await sleep(1500);
  try { ssh("powershell -NoProfile -ExecutionPolicy Bypass -File D:\\Temp\\hbbench\\hbbench-kill.ps1"); } catch (_) { /* */ }
  log("test Chrome closed");
}
// never leave the uncapped switch behind for a later MODE T launch
if (UNCAPPED && !has("--keep")) { try { ssh("if exist D:\\Temp\\hbbench\\uncapped.txt del /q D:\\Temp\\hbbench\\uncapped.txt"); } catch (_) { /* */ } }
log("out", OUT);
process.exit(0);
