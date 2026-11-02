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
//   take A3 (2026-11-02 reshoot of take A's frozen journey + climb): the pilot page ONLY (victim pages are closed),
//            boarded at Holtburg exactly like take A, the eval's "tour" mode: cruise SSW at 90 m AGL / 400 km/h toward
//            the site, the climb at the full rate on 252° from 2.5 km short of it, the 5,000 m ceiling held 40 s out
//            over the western sea, then the recording stops and the aircraft is despawned (the pilot re-homed to
//            Holtburg) BEFORE the encoder flush and the post-take drain. No stills while recording (a screenshot is a
//            readback + a tunnel transfer in the middle of the take). The recorded page runs at a 30 fps runtime cap
//            while recording (--rec-cap, see REC_CAP: uncapped, the GPU-bound page starves the encoder at altitude).
// Every take now also logs the recorded page's frame pacing (recStop.pace: postRender interval histogram + every gap
// >= 40 ms in video time) and the eval rows carry the recorder's grid counters (vf / vh) and predictor corrections.
//   take B (reshoot B2, 2026-11-02) — what take B taught:
//     * the dying player's OWN page goes to portal space (a black screen) animLength + 1 s after the death (ACE
//       Player_Death: the corpse, then TeleportOnDeath) — take B's "18-frame hold" inside the cut was that black screen
//       (md5 runs: no hold at all before 42.1 s, then 27-29-frame runs of the dark frame). So the ground view now records
//       on VICTIM 2's page (the green one; --rec-victim 2, the default) with its camera parked 6 m behind the BLUE player
//       (victim 1, the first target, as in take K); the gun holds after one kill (maxKills 1) so the recording player
//       lives, and the page stops its own grab 3 s after the kill (film-ground-probe.eval.js);
//     * the observer sight radius did not "get lost by the teleport": ACE applies vehicle_observer_sight_radius only in
//       the OBSERVER's own cell change (handle_visible_cells); a moving Hellcat reaches a standing player only through its
//       own fixed 112.5 m clamp (handle_visible_cells_non_player). Take B's victim 1 had logged in AFTER the property was
//       set (03:55:42; caps granted 03:56:04) and still saw the Hellcat at ~112 m. So the recording player sidesteps
//       ~1 m across a 24 m cell line when the Hellcat is ~380 m out (the pilot page broadcasts its position); the
//       victims are still placed, logged out and back in AT their marks first (--relogin, the reshoot brief);
//     * a near test before the take (--near-test M, 0 = skip): the Hellcat parked M m out on the approach line must
//       stay unseen by the recording page until that sidestep (validates the above, calibrates the sidestep, pre-warms
//       the Hellcat's model on the recording page);
//     * the eval's events are stamped with the PILOT page's performance.now(); take B converted them with the
//       recorded page's t0 (another page, another time origin: ~1.3 s off). Converted via performance.timeOrigin now.
//     * (B2 run 2) victims that log in already AT their marks (an earlier run placed them and logged them out there)
//       are not teleported + re-logged again (--force-place does); blank off-screen pages are reused for the victims
//       before a new window is opened, stray pages are closed after; the take's sidestep length is recomputed from
//       where the player stands after the near test; a near test without a sight stops the run (--near-required 0);
//       the pre-admit (--pre-admit N pairs): ACE admits only the 24 nearest NEW objects per wide-sight cell change,
//       and ~140 creatures stand inside 380 m of this site — run 2's near test saw the crowd's nearest 24, not the
//       Hellcat — so the recording player crosses the line back and forth until nothing new arrives, first.
//
//   take D (reshoot D2, 2026-11-02): the pilot page only (the victims' pages are closed, as for A3); the run-in aims at
//     --aim-x/--aim-y and bails --bail-lead m before it (--bail-exact 1, the default: the eval waits out the last
//     < 0.25 s so the bail happens AT the lead). Take D's body came down 119 m W / 40 m S of Al-Arqas's gazetteer
//     centre on the dune: the town's buildings stand in the green hollow EAST of that point (landblock 0x9058). The
//     server's fall (VehicleBailout.StepFall) is deterministic — a replay of take D's bail lands within 3 m of where
//     the body did — so the lead comes from a replay over the bake's terrain heights; the open ground from
//     film-d2-prep.mjs --survey / the batched building footprints. The aircraft is despawned before the flush; the
//     landing (res.landing) is logged against the town centre and the aim.
//     Prep (fresh pilot page + survey): node film-d2-prep.mjs --survey
//     D2-2: prep = node film-d2-prep.mjs [--launch] --login-settle 60000 --rehearse --keepalive (a fresh page, an
//     unrecorded 600 m bail onto the same spot so every near-ground program is linked before the take); with
//     --stall-probe the take also saves res.linked (the link ledger's programs linked while recording, in video time)
//   node film-hellcat-1070.mjs --take A|K|B|D|A3 [--out DIR] [--coverage 0.42] [--skytime 13] [--no-launch] [--keep]
//     D:  [--aim-x X --aim-y Y] [--bail-lead 580] [--bail-exact 1] [--bail-agl 2600] [--settle MS] [--d-x X --d-y Y]
//     A3: [--settle MS] [--prewarm] [--rig-settle MS] [--climb-at M] [--hold-sec S] [--max-sec S] [--rec-cap 30]
//     B:  [--rec-victim 2] [--relogin 1] [--near-test 320] [--step-at 380] [--step2-at 330] [--rec-at 760]
//         [--stop-after-kill 3000] [--settle-login 60000] [--site-x X --site-y Y]
//     any take: [--rec-cap N] (default 30 = the 30 fps runtime cap + sequential sampler; 0 = uncapped, the wall-clock grid)
//               [--suffix S] (output stem take-<TAKE><S>)
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync, unlinkSync, statSync, openSync, readSync, closeSync } from "node:fs";
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
  // non-recorded pages: the pilot needs 30 for flight control; a standing victim needs no more than 5 (B2: CPU headroom
  // for the recorded page on the 1070)
  (render ? `&quality=high&targetFps=0` : `&quality=low&targetFps=${account === "agentp10" ? 30 : 5}&nullRender=1`);
const findPage = (account) => ctx.pages().find((p) => p.url().includes(`account=${account}&`));
async function openWindow(account, render) {
  let pg = findPage(account) || ctx.pages().find((p) => p.__hbRelogin === account);
  const wantRender = !!render;
  if (pg && pg.url().includes("account=") && pg.url().includes("nullRender=1") === !wantRender) return { pg, fresh: false };
  if (!pg) {
    // B2: an unclaimed about:blank page first (an earlier take's blanked victim window, already off-screen) — no new
    // window that could flash on the 1070's desktop before it is moved; pinned off-screen again all the same
    pg = ctx.pages().find((p) => p.url() === "about:blank" && !p.__hbClaimed && !p.__hbRelogin && p !== pilot) || null;
    if (pg) {
      pg.__hbClaimed = true;
      try {
        const c = await ctx.newCDPSession(pg);
        const { windowId } = await c.send("Browser.getWindowForTarget");
        await c.send("Browser.setWindowBounds", { windowId, bounds: { left: -32000, top: -32000, width: 1280, height: 800 } });
        await c.detach().catch(() => {});
      } catch (e) { res.errors.push(`window (reused) ${account}: ${e.message}`); }
      log("reusing a blank off-screen page for", account);
    }
  }
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

// takes: A the whole flight (pilot view), K the kills (pilot view), B the kills from behind victim 1, D the bail,
// A3 the journey + the climb again (pilot view, no victims)
const pilotRender = TAKE !== "B";
const NO_VICTIMS = TAKE === "D" || TAKE === "A3";
// take B: which victim's page renders and records (0-based; --rec-victim 1 = the blue one's own page, as take B was)
const REC_IDX = TAKE === "B" ? Math.min(1, Math.max(0, Number(opt("--rec-victim", "2")) - 1)) : -1;
res.recVictim = REC_IDX >= 0 ? VICTIMS[REC_IDX].name : null;
// take B: every page that is not one of the three accounts' is closed AFTER the victims' pages are opened (blank
// off-screen pages are reused for them first; see openWindow)
// A3 (and D, reshoot D2) need no victims: close their pages (THOSE pages only) so they do not compete with the
// recorded page
if (NO_VICTIMS) {
  for (const p of ctx.pages()) {
    const m = /account=(agentp0[78])&/.exec(p.url());
    if (!m) continue;
    // never the last page (that would close the test Chrome): blank it instead
    if (ctx.pages().length < 2) { await p.goto("about:blank").catch(() => {}); log("blanked the page of", m[1]); continue; }
    try { await p.close(); log("closed the page of", m[1]); } catch (e) { res.errors.push(`close ${m[1]}: ${e.message}`); }
  }
}
// pages whose render mode changes this take re-log in: blank them all first and wait out "Account In Use" once
{
  const wantRender = NO_VICTIMS ? { agentp10: pilotRender } :{ agentp10: pilotRender, [VICTIMS[0].account]: REC_IDX === 0, [VICTIMS[1].account]: REC_IDX === 1 };
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
for (const v of NO_VICTIMS ? [] : VICTIMS) {
  const render = TAKE === "B" && v === VICTIMS[REC_IDX];
  const { pg } = await openWindow(v.account, render);
  vpages.push(pg);
}
if (TAKE === "B") {
  // nothing else open on the 1070 while the take runs (CPU headroom for the recorded page); never the last page
  for (const p of ctx.pages()) {
    if (p === pilot || vpages.includes(p)) continue;
    if (ctx.pages().length < 2) break;
    try { const u = p.url(); await p.close(); log("closed a stray page", u.slice(0, 80)); } catch (e) { res.errors.push(`close stray: ${e.message}`); }
  }
}
const recPage = TAKE === "B" ? vpages[REC_IDX] : pilot;
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
// --rec-cap N (default 30 for EVERY take since the A3 finding below — orchestrator 2026-11-02; 0 = uncapped, the old
// wall-clock grid): the recorded page's runtime frame cap (window.__setFrameCap,
// the vsync timeline gate) while recording. WHY (take A3, 2026-11-02): uncapped, the page saturates the 1070's GPU
// and the encoder's input copies starve behind it — in-page bench at 5 km AGL: 14 encoded fps of 30 (NVENC itself at
// 2-5 %), the queue grew to 3,429 frames in the take and the page collapsed to 2-10 fps (stalls up to 5.7 s) from
// 3.5 km up. Capped at 30 the encoder keeps up (28 enc fps, queue steady at ~15-20; 40 fps cap: 20 enc fps, growing).
// Under a cap the grid sampler is SEQUENTIAL: each rendered frame takes the next slot; holds are inserted only when
// the clock runs >= 1.5 slots ahead and a frame is dropped only when it comes >= 0.5 slot early. The wall-clock grid
// (k = floor(t·fps)) turns ±jitter of a 30 fps cadence into drop + hold pairs (77 held of 239 in the bench, 2 with
// the sequential sampler). Uncapped takes keep the wall-clock grid.
const REC_CAP = Number(opt("--rec-cap", "30"));
const startRecPage = () => recPage.evaluate(async ({ fps, bitrate, seq }) => {
  const names = performance.getEntriesByType("resource").map((e) => e.name);
  const url = (p) => names.find((n) => n.includes(p)) || new URL(p.replace(/^\//, ""), location.href).href;
  const co = await import(url("/scene3d/film/runtime/camera_owner.js"));
  const rm = await import(url("/scene3d/film/runtime/recorder.js"));
  const canvas = window.liveScene3d.renderer.domElement;
  const rec = rm.createRecorder({ canvas, fps, bitrate, keyIntervalSec: 1 });
  const st = await rec.start();
  const hooks = co.ensureFilmHooks(window.liveScene3d);
  // pace: postRender intervals (ms) binned <17 / <25 / <34 / <50 / <100 / >=100, and every gap >= 40 ms as
  // [video ms, gap ms] — a gap over the 33.3 ms grid step is a held (re-stamped) frame in the take
  const v = (window.__hbVid = { rec, t0: null, lastK: -1, frames: 0, held: 0, unsub: null, last: null, pace: { hist: [0, 0, 0, 0, 0, 0], gaps: [] } });
  v.unsub = hooks.addPostRender(() => {
    const now = performance.now();
    if (v.t0 === null) v.t0 = now;
    if (v.last !== null) {
      const dt = now - v.last;
      v.pace.hist[dt < 17 ? 0 : dt < 25 ? 1 : dt < 34 ? 2 : dt < 50 ? 3 : dt < 100 ? 4 : 5]++;
      if (dt >= 40 && v.pace.gaps.length < 5000) v.pace.gaps.push([Math.round(now - v.t0), Math.round(dt)]);
    }
    v.last = now;
    const ideal = ((now - v.t0) * fps) / 1000;
    let k;
    if (seq) {
      k = v.lastK + 1;
      const d = ideal - k;
      if (d < -0.5) return;
      if (d >= 1.5) k = Math.round(ideal);
    } else {
      k = Math.floor(ideal + 1e-6);
      if (k <= v.lastK) return;
    }
    const times = [];
    for (let i = v.lastK + 1; i <= k; i++) times.push(i / fps);
    v.held += times.length - 1;
    v.lastK = k;
    v.frames += times.length;
    rec.grab(times.length === 1 ? times[0] : times);
  });
  return { ...st, canvas: [canvas.width, canvas.height], sampler: seq ? "sequential" : "wall-clock" };
}, { fps: REC_FPS, bitrate: Number(opt("--bitrate", "6000000")), seq: REC_CAP > 0 });
// the runtime cap on the recorded page (true = set); 0 restores uncapped
const setRecCap = (fps) => recPage.evaluate((f) => ({ ok: window.__setFrameCap?.(f) ?? null, state: window.__frameCapState?.() ?? null }), fps).catch((e) => ({ error: e.message }));
// preCapped: the take set the cap itself earlier (take B: before the spawn), no settle wait here
const startRec = async ({ preCapped = false } = {}) => {
  if (REC_CAP > 0 && !preCapped) { res.recCap = await setRecCap(REC_CAP); log("rec cap", JSON.stringify(res.recCap)); await sleep(1500); }
  return startRecPage();
};
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
// stopGrab: no more frames + the encoder flushed (page side); drainAll: the buffered take over CDP (after the action)
const stopGrab = () => recPage.evaluate(async () => {
  const v = window.__hbVid; v.unsub?.(); v.unsub = null;
  const s = await v.rec.stop();
  return { stats: s, t0: v.t0, frames: v.frames, held: v.held, pace: v.pace };
});
const drainAll = async () => {
  drainStop = true;
  await drainLoop;
  for (let i = 0; i < 2000; i++) { const d = await drainOnce(); if (!d || d.error || d.done || !(d.chunks || []).length) { if (d?.error) res.errors.push(`drain: ${d.error}`); break; } }
};
const stopRec = async () => { const st = await stopGrab(); await drainAll(); return st; };
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

// a page's player: world position + heading (deg CW from north)
const poseOf = (pg) => pg.evaluate(() => {
  const w = window.__cam?.world?.();
  const p = window.__sessionHandle?.getLocalPlayerPose?.();
  let hdg = null;
  if (p) { hdg = (((-p.heading * 180) / Math.PI) % 360 + 360) % 360; try { p.free?.(); } catch (_) { /* */ } }
  return w ? { x: Math.round(w.x * 100) / 100, y: Math.round(w.y * 100) / 100, z: Math.round(w.z * 100) / 100, hdg: hdg == null ? null : Math.round(hdg * 10) / 10 } : null;
}).catch(() => null);
// B2: are the victims (just logged in) already at their marks, facing the approach? (placed and logged out there by
// an earlier run: logging in now IS the brief's "log in AT the marks" — no second teleport + re-login cycle)
const victimsAtMarks = async () => {
  const at = [];
  for (const pg of vpages) at.push(await poseOf(pg));
  const hdgOff = (h) => (h == null ? 999 : Math.abs((((h - FROM) % 360) + 540) % 360 - 180));
  const ok = at.length === VICTIMS.length && at.every((p, i) => p && Math.hypot(p.x - VICTIMS[i].pos[0], p.y - VICTIMS[i].pos[1]) < 0.6 && hdgOff(p.hdg) < 15);
  return { ok, at };
};
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
  let placedNow = false;
  if (!NO_VICTIMS) {
    let atMarks = false;
    if (TAKE === "B" && !has("--force-place")) {
      const m = await victimsAtMarks();
      res.loginAt = m.at;
      atMarks = m.ok;
      log(atMarks ? "victims logged in AT their marks (placed + logged out there earlier): no teleport, no re-login" : "victims not at their marks: placing", JSON.stringify(m.at));
    }
    if (!atMarks) { res.victims = await placeVictims(); placedNow = true; }
  }
  if (TAKE === "A3") {
    // take A3: spawn and board exactly like take A; no victims, no stills while recording
    await chatOn(pilot, `@teleloc ${HOLTBURG}`);
    await sleep(Number(opt("--settle", "30000")));
    if (has("--prewarm")) {
      // a cold shader cache (fresh profile): the flight's one-time work — the altitude policy's world tier and far
      // forests, the cloud deck from inside and above, the high band's march variant — happens BEFORE the take. The
      // parked ?camDebug free camera drives the altitude policy like a flight does (url-flags flightView); looking
      // along the route (193.7° SSW), then released to the player
      const p0 = await pilot.evaluate(() => window.__cam.world());
      res.prewarm = [];
      for (const [dz, sec] of [[400, 12], [1500, 15], [2600, 15], [5000, 15]]) {
        const info = await pilot.evaluate(({ p, dz }) => {
          const h = 193.7 * Math.PI / 180;
          return window.__cam.set(p.x, p.y, p.z + dz, p.x + Math.sin(h) * 4000, p.y + Math.cos(h) * 4000, p.z + dz - 700);
        }, { p: p0, dz }).catch((e) => ({ error: e.message }));
        await sleep(sec * 1000);
        const fps = await pilot.evaluate(() => new Promise((r) => { let n = 0; const t = performance.now(); const f = () => { n++; if (performance.now() - t < 2000) requestAnimationFrame(f); else r(Math.round(n / ((performance.now() - t) / 1000))); }; requestAnimationFrame(f); })).catch(() => null);
        res.prewarm.push({ dz, parked: info?.parked ?? null, fps });
        log("prewarm", dz, "m", "fps", fps);
      }
      log("prewarm released", await pilot.evaluate(() => (window.__cam.release(), window.__cam.parked)));
      await sleep(10000);
    }
    await chatOn(pilot, "@vehicle despawn all");
    await sleep(1500);
    res.spawn = await runOn(pilot, "vehicle-spawn.eval.js", {});
    log("spawn", JSON.stringify(res.spawn?.summary ?? res.spawn?.fatal));
    for (let i = 0; i < 60; i++) {
      const hasRig = await pilot.evaluate(() => { const v = window.__vehicles.vehicles().slice(-1)[0]; return !!(v && window.liveScene3d.entityManager.entityMap.get(v.guid)); });
      if (hasRig) break;
      await sleep(500);
    }
    await sleep(Number(opt("--rig-settle", "4000")));
    res.rec = await startRec();
    log("recording", JSON.stringify(res.rec));
    await sleep(2500);
    res.flight = await runOn(pilot, "film-hellcat.eval.js", { ...RUN, mode: "tour", cruiseAgl: 90, climbAtM: Number(opt("--climb-at", "2500")),
      climbHeading: 252, ceilingAgl: 4950, ceilingHoldSec: Number(opt("--hold-sec", "40")), maxSec: Number(opt("--max-sec", "330")) });
    log("flight", JSON.stringify(res.flight?.summary ?? res.flight?.fatal ?? res.flight).slice(0, 1500));
    // the end of the ceiling hold = the end of the take: stop grabbing at once, then the aircraft out of the sky and
    // the pilot home, THEN the encoder flush and the drain (take A3 #1 flushed a 3,400-frame backlog for 7.8 min
    // first, and the derelict drifted to the map's west edge meanwhile)
    await recPage.evaluate(() => { const v = window.__hbVid; v?.unsub?.(); if (v) v.unsub = null; }).catch((e) => res.errors.push(`unsub: ${e.message}`));
    try {
      await chatOn(pilot, "@vehicle despawn all"); await sleep(2000);
      await chatOn(pilot, `@teleloc ${HOLTBURG}`); await sleep(3000);
      log("despawned, the pilot re-homed to Holtburg");
    } catch (e) { res.errors.push(`re-home: ${e.message}`); }
    if (res.rec) { try { res.recStop = await stopGrab(); } catch (e) { res.errors.push(`stop: ${e.message}`); } }
  } else if (TAKE === "A") {
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
        // D2: --stall-probe — scene3d/stall_probe.js on the recorded page for the take (every frame >= 80 ms with the
        // counters that moved across it: shader link ms, transcode ms, texture / buffer uploads, the residual).
        // Take D2 #1 had 163 + 313 ms frames 12 m / 7 m above the oasis that a parked-camera replay did not reproduce
        if (has("--stall-probe")) {
          res.stallArm = await recPage.evaluate(() => window.__stallArm?.({ thresholdMs: 80, ring: 256 }) ?? "absent").catch((e) => ({ error: e.message }));
          log("stall probe armed", JSON.stringify(res.stallArm).slice(0, 300));
        }
      }
    }, 250);
    // D2 (2026-11-02): take D's body came down 119 m W / 40 m S of the town centre, on the dune above the oasis — the
    // run-in aims at --aim-x/--aim-y (default the gazetteer centre) and bails --bail-lead m before it. The landing is
    // predictable: the server's VehicleBailout.StepFall is deterministic (a replay of take D's bail lands within 3 m of
    // where the body did) — free fall ~444 m along the heading (tau 4 s at 111 m/s), then the canopy glides 8 m/s
    const aim = { x: Number(opt("--aim-x", String(TOWN.x))), y: Number(opt("--aim-y", String(TOWN.y))) };
    res.aim = { ...aim, bailLeadM: Number(opt("--bail-lead", "580")) };
    res.flight = await runOn(pilot, "film-hellcat.eval.js", { ...RUN, mode: "bail", climbHeading: 262, bailAgl: Number(opt("--bail-agl", "2600")),
      turnBackM: 4500, bailLeadM: res.aim.bailLeadM, bailExact: opt("--bail-exact", "1") !== "0", town: aim, maxSec: 1200 });
    clearInterval(watch);
    log("flight", JSON.stringify(res.flight?.summary ?? res.flight?.fatal ?? res.flight).slice(0, 1500));
    // the end of the take: stop grabbing at once, the derelict out of the sky, THEN the encoder flush + the drain
    await recPage.evaluate(() => { const v = window.__hbVid; v?.unsub?.(); if (v) v.unsub = null; }).catch((e) => res.errors.push(`unsub: ${e.message}`));
    if (has("--stall-probe")) {
      // the ring's frame times are the page's performance.now(): video seconds = (t - recStop.t0) / 1000 (t0 below)
      res.stall = await recPage.evaluate(() => { const r = window.__stallReport?.() ?? null; try { window.__stallDisarm?.(); } catch (_) { /* */ } return r; }).catch((e) => ({ error: e.message }));
      log("stall report", JSON.stringify(res.stall).slice(0, 1500));
      // D2-2: every program linked while recording (the link probe's ledger; the rehearsal in film-d2-prep.mjs should
      // have linked them all before the take) — t = page ms, video seconds = (t - recStop.t0) / 1000
      res.linked = await recPage.evaluate((t0) => {
        const lp = window.__linkProbe;
        if (!lp || typeof lp.ledger !== "function") return { absent: true };
        const rows = lp.ledger().filter((e) => e.op === "+" && (t0 == null || e.t >= t0))
          .map((e) => ({ t: Math.round(e.t), video: t0 == null ? null : Math.round(e.t - t0) / 1000, name: e.name, type: e.type, relink: !!e.relink, key: String(e.key || "").slice(0, 160) }));
        return { rows, stats: lp.ledgerStats?.() ?? null, linkStatus: lp.stats?.linkStatus ?? null };
      }, await recPage.evaluate(() => window.__hbVid?.t0 ?? null).catch(() => null)).catch((e) => ({ error: e.message }));
      log("linked while recording", JSON.stringify((res.linked?.rows || []).map((r) => [r.video, r.type, r.name, r.relink])).slice(0, 1500));
    }
    try { await chatOn(pilot, "@vehicle despawn all"); await sleep(2000); log("despawned"); } catch (e) { res.errors.push(`despawn: ${e.message}`); }
    // where the body came down (the eval's landing + the pose now), against the gazetteer centre and the aim
    const at = await poseOf(pilot);
    const rel = (p, c) => (p && c ? { east: Math.round((p.x - c.x) * 10) / 10, north: Math.round((p.y - c.y) * 10) / 10, dist: Math.round(Math.hypot(p.x - c.x, p.y - c.y) * 10) / 10 } : null);
    res.landing = { evalLanding: res.flight?.landing ?? null, poseAfter: at, fromTownCentre: rel(at, TOWN), fromAim: rel(at, aim),
      falling: await pilot.evaluate(() => !!window.__vehicles?.falling).catch(() => null), piloting: await pilot.evaluate(() => !!window.__vehicles?.piloting).catch(() => null) };
    log("landing", JSON.stringify(res.landing));
    if (res.rec) { try { res.recStop = await stopGrab(); } catch (e) { res.errors.push(`stop: ${e.message}`); } }
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
    // take B (B2): the ground view on victim REC_IDX's page, the camera behind the blue player (see the header)
    const DEG = Math.PI / 180;
    const onLine = (m) => [SITE.x + Math.sin(FROM * DEG) * m, SITE.y + Math.cos(FROM * DEG) * m];
    const CHANNEL = `hb-film-${STEM}`;
    const NEAR = Number(opt("--near-test", "320"));
    const STEP_AT = Number(opt("--step-at", "380")), STEP2_AT = Number(opt("--step2-at", "330"));
    const REC_AT = Number(opt("--rec-at", "760")), STOP_AFTER_KILL = Number(opt("--stop-after-kill", "3000"));
    const STEP_DIR = opt("--step-dir", "left"), BACK_DIR = STEP_DIR === "left" ? "right" : "left";
    const ACE_LOG = "/home/wbterminal/ace-server/Source/ACE.Server/bin/Release/net10.0/ACE_Log.txt";
    // the distance along a bearing from p to the next 24 m cell line (either axis)
    const cellMargin = (p, bearingDeg) => {
      const ux = Math.sin(bearingDeg * DEG), uy = Math.cos(bearingDeg * DEG);
      const along = (c, u) => (u > 1e-6 ? (Math.floor(c / 24 + 1) * 24 - c) / u : u < -1e-6 ? (c - Math.floor(c / 24) * 24) / -u : Infinity);
      return Math.min(along(p.x, ux), along(p.y, uy));
    };
    const stepBearing = (hdg) => (hdg ?? FROM) + (STEP_DIR === "left" ? -90 : 90);
    // the ACE log since now: corpse lines are the truth for kills
    let logPos = 0;
    try { logPos = statSync(ACE_LOG).size; } catch (_) { /* */ }
    res.aceLog = [];
    const readAceLog = () => {
      try {
        const size = statSync(ACE_LOG).size;
        if (size <= logPos) return [];
        const fd = openSync(ACE_LOG, "r"), buf = Buffer.alloc(Math.min(size - logPos, 1 << 20));
        readSync(fd, buf, 0, buf.length, logPos); closeSync(fd);
        logPos += buf.length;
        const lines = buf.toString("utf8").split("\n").filter((l) => /\[CORPSE\]|\[VEHICLE\].*(spawned|despawn|boarded|left)/.test(l)).map((l) => l.slice(0, 220));
        res.aceLog.push(...lines);
        return lines;
      } catch (_) { return []; }
    };

    // (b) the victims log out AT their marks and back in (the reshoot brief; the near test below shows what it does)
    if (placedNow && opt("--relogin", "1") !== "0") {
      for (let i = 0; i < vpages.length; i++) { vpages[i].__hbRelogin = VICTIMS[i].account; await vpages[i].goto("about:blank").catch(() => {}); }
      log("victims logged out at their marks — waiting out Account In Use (45 s)");
      // meanwhile the pilot walks to the near-test point on the approach line
      if (NEAR > 0) {
        const [nx, ny] = onLine(NEAR);
        await chatOn(pilot, "@vehicle despawn all");
        await chatOn(pilot, teleloc(nx, ny, groundAt(nx, ny) + 0.6, FROM + 180));
      }
      await sleep(45000);
      for (let i = 0; i < vpages.length; i++) await vpages[i].goto(urlFor(VICTIMS[i].account, i === REC_IDX), { waitUntil: "domcontentloaded", timeout: 60000 });
      for (let i = 0; i < vpages.length; i++) { if (!(await ready(vpages[i], `${VICTIMS[i].name} (re-login)`))) throw new Error(`re-login of ${VICTIMS[i].account} failed`); }
      for (const pg of vpages) {
        await pg.evaluate(() => { try { window.__setWeather?.({ is_storm: false }); } catch (_) { /* */ } }).catch(() => {});
        await pg.evaluate(async () => { try { window.__benchWake = await navigator.wakeLock.request("screen"); } catch (_) { /* */ } }).catch(() => {});
      }
    } else if (NEAR > 0) {
      const [nx, ny] = onLine(NEAR);
      await chatOn(pilot, "@vehicle despawn all");
      await chatOn(pilot, teleloc(nx, ny, groundAt(nx, ny) + 0.6, FROM + 180));
    }
    log("settling", Number(opt("--settle-login", "60000")) / 1000, "s");
    await sleep(Number(opt("--settle-login", "60000")));
    res.marks = [];
    for (let i = 0; i < vpages.length; i++) res.marks.push({ name: VICTIMS[i].name, planned: VICTIMS[i].pos.map((n) => Math.round(n * 100) / 100), plannedHdg: FROM, at: await poseOf(vpages[i]) });
    log("victims at their marks after the re-login", JSON.stringify(res.marks.map((m) => m.at)));
    res.probeInstall = await runOn(recPage, "film-ground-probe.eval.js", { channel: CHANNEL, victims: VICTIMS.map((v) => v.name), pilotName: "Probe 912" });
    log("ground probe", JSON.stringify(res.probeInstall));

    // (B2 run 2) the pre-admit: ACE admits at most 24 NEW objects per wide-sight cell change, nearest first
    // (ObjectMaint.AddVisibleObjects, WideSightNewPerCall). This site has ~140 creatures (+ their gear) inside 380 m:
    // run 2's near-test crossing admitted only the 24 nearest (creatures 133-244 m out) and deferred the Hellcat at
    // 320 m. Crossing the line back and forth until nothing new arrives leaves the Hellcat (and its seated pilot) the
    // only new candidates at the take's one sidestep. Visible objects stay visible (only occlusion removes them).
    res.preAdmit = [];
    for (let i = 0; i < Number(opt("--pre-admit", "5")); i++) {
      const r = await recPage.evaluate(async ({ a, b, ms }) => {
        const P = window.__groundProbe, w = (t) => new Promise((res) => setTimeout(res, t));
        const n0 = P.farCount(); P.step(a, ms, "preA"); await w(2200);
        const n1 = P.farCount(); P.step(b, ms, "preB"); await w(2200);
        return { n0, n1, n2: P.farCount(), me: P.me() };
      }, { a: STEP_DIR, b: BACK_DIR, ms: 450 }).catch((e) => ({ error: e.message }));
      res.preAdmit.push(r);
      log("pre-admit pair", i + 1, JSON.stringify(r));
      if (r.error || r.n2 <= r.n0) break;
    }

    // the near test: the Hellcat parked NEAR m out, unseen until the recording player crosses a cell line
    let stepMs = Number(opt("--step-ms", "0")) || 450;
    if (NEAR > 0) {
      res.near = { at: NEAR };
      await recPage.evaluate(() => window.__groundProbe.arm({ stepAtM: 0 }));
      res.near.spawn = (await runOn(pilot, "vehicle-spawn.eval.js", {}))?.summary ?? null;
      log("near test: spawned", JSON.stringify(res.near.spawn));
      await sleep(6000);
      let rep = await recPage.evaluate(() => window.__groundProbe.report());
      res.near.beforeStep = { seen: rep.seen, pilotBody: rep.pilotBody, me: rep.me };
      log("near test, standing still 6 s:", rep.seen ? `the Hellcat SEEN (${rep.seen.dist2d} m)` : "the Hellcat unseen", "/", rep.pilotBody ? "the pilot seen" : "the pilot unseen");
      // calibration: a sidestep away from the line and back (no crossing)
      const cal = await recPage.evaluate(async ({ away, back }) => {
        const P = window.__groundProbe, w = (ms) => new Promise((r) => setTimeout(r, ms));
        const a = P.me(); P.step(away, 400, "calAway"); await w(1600); const b = P.me(); P.step(back, 400, "calBack"); await w(1600);
        return { a, b, c: P.me() };
      }, { away: BACK_DIR, back: STEP_DIR });
      const dCal = cal.a && cal.b ? Math.hypot(cal.b.x - cal.a.x, cal.b.y - cal.a.y) : 0;
      const hdg = (await poseOf(recPage))?.hdg ?? FROM;
      const margin = cal.c ? cellMargin(cal.c, stepBearing(hdg)) : null;
      if (!Number(opt("--step-ms", "0")) && dCal > 0.1 && margin != null) stepMs = Math.round(Math.min(1500, Math.max(200, (400 * (margin + 0.45)) / dCal)));
      res.near.calibration = { ...cal, moved400ms: Math.round(dCal * 100) / 100, hdg, marginM: margin == null ? null : Math.round(margin * 100) / 100, stepMs };
      log("sidestep calibration", JSON.stringify(res.near.calibration));
      if (dCal <= 0.1) res.errors.push("near test: the calibration sidestep did not move the player (synthetic keys refused?)");
      // the crossing
      rep = await recPage.evaluate(async ({ dir, ms }) => {
        const P = window.__groundProbe, w = (t) => new Promise((r) => setTimeout(r, t));
        P.step(dir, ms, "nearCross");
        const t0 = performance.now();
        while (performance.now() - t0 < 6000 && !P.report().seen) await w(50);
        await w(1000);
        return P.report();
      }, { dir: STEP_DIR, ms: stepMs });
      const cross = rep.steps.find((s) => s.why === "nearCross");
      res.near.cross = { step: cross, seen: rep.seen, seenEntity: rep.seenEntity, pilotBody: rep.pilotBody, latencyMs: rep.seen && cross ? Math.round(rep.seen.t - cross.tDown) : null };
      log("near test, after the sidestep:", rep.seen ? `the Hellcat SEEN at ${rep.seen.dist2d} m, ${res.near.cross.latencyMs} ms after the key` : "the Hellcat STILL unseen", JSON.stringify({ moved: cross?.moved, after: cross?.after }));
      // back across the line, the aircraft away
      await recPage.evaluate(({ dir, ms }) => window.__groundProbe.step(dir, ms, "nearBack"), { dir: BACK_DIR, ms: stepMs });
      await sleep(2500);
      await chatOn(pilot, "@vehicle despawn all");
      await sleep(3000);
      res.near.after = await poseOf(recPage);
      res.near.marginAfter = res.near.after ? Math.round(cellMargin(res.near.after, stepBearing(res.near.after.hdg)) * 100) / 100 : null;
      log("near test done; the recording player at", JSON.stringify(res.near.after), "margin to the line", res.near.marginAfter, "m");
      readAceLog();
      // the take's step from where the player stands NOW (the way back need not land where the calibration left it)
      const mv = res.near.calibration.moved400ms;
      if (!Number(opt("--step-ms", "0")) && mv > 0.1 && res.near.marginAfter != null) {
        stepMs = Math.round(Math.min(1500, Math.max(200, (400 * (res.near.marginAfter + 0.45)) / mv)));
        res.near.stepMsTake = stepMs;
        log("the take's sidestep", stepMs, "ms for", res.near.marginAfter, "m to the line");
      }
      // the near test is the take's premise: no sight after the crossing = the take would show the Hellcat at ~112 m
      if (!res.near.cross.seen && opt("--near-required", "1") !== "0") throw new Error("near test: the Hellcat stayed unseen after the sidestep (rerun with --near-required 0 to shoot anyway)");
    }

    // the take: the pilot 3 km out on the approach line
    const [sx, sy] = onLine(3000);
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
    // the camera 6 m behind the BLUE player (victim 1) looking along the approach, a little above the head
    const blue = await poseOf(vpages[0]);
    const camArgs = { d: Number(opt("--cam-dist", "6")), az: (FROM + 180) % 360, el: Number(opt("--cam-el", "9")), dz: Number(opt("--cam-dz", "1.7")), b: blue, own: REC_IDX === 0 };
    res.cam = await recPage.evaluate((a) => (a.own ? window.__cam.player(a.d, a.az, a.el, a.dz) : window.__cam.orbit(a.b.x, a.b.y, a.b.z + a.dz, a.d, a.az, a.el)), camArgs).catch((e) => ({ error: e.message }));
    log("cam behind", VICTIMS[0].name, JSON.stringify(res.cam));
    if (REC_CAP > 0) { res.recCap = await setRecCap(REC_CAP); log("rec cap (through the approach)", JSON.stringify(res.recCap)); }
    res.recMarkBefore = await poseOf(recPage);
    res.arm = await recPage.evaluate((cfg) => window.__groundProbe.arm(cfg),
      { stepAtM: STEP_AT, step2AtM: STEP2_AT, stepDir: STEP_DIR, step2Dir: BACK_DIR, stepMs, retryMs: 1000, stopAfterKillMs: STOP_AFTER_KILL });
    log("probe armed", JSON.stringify(res.arm), "step", STEP_DIR, stepMs, "ms at", STEP_AT, "m");
    let recOn = false, busy = false, stopAt = null, logKillAt = null, aborted = false;
    readAceLog();
    const watch = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        if (!recOn) {
          const d = await pilot.evaluate((s) => { const p = window.__vehicles?.status?.().pilot?.state; return p ? Math.hypot(p.x - s.x, p.y - s.y) : null; }, SITE).catch(() => null);
          if (d != null && d <= REC_AT) {
            recOn = true;
            try { res.rec = await startRec({ preCapped: REC_CAP > 0 }); res.rec.atM = Math.round(d); log("recording at", Math.round(d), "m", JSON.stringify(res.rec)); } catch (e) { res.errors.push(`rec: ${e.message}`); }
          }
          return;
        }
        // the death broadcast (WorldObjects.Player) — ACE picks one of several templates ("...'s perforated corpse falls
        // before ...", "...'s death is preceded by a sharp, stabbing pain, courtesy of ..."): match the logger + the name
        if (!logKillAt && readAceLog().some((l) => /\(ACE\.Server\.WorldObjects\.Player\) \[CORPSE\] \+?Funnel Probe's /.test(l))) { logKillAt = Date.now(); log("ACE: the death of", VICTIMS[0].name); }
        const st = await recPage.evaluate(() => window.__groundProbe.status()).catch(() => null);
        if (st?.stopped && !stopAt) { stopAt = Date.now(); log("the page stopped its grab", JSON.stringify(st)); }
        if (!st?.stopped && !stopAt && logKillAt && Date.now() - logKillAt > STOP_AFTER_KILL + 1500) {
          await recPage.evaluate(() => { const v = window.__hbVid; if (v?.unsub) { v.unsub(); v.unsub = null; } }).catch(() => {});
          res.errors.push("the probe missed the kill: the grab stopped from the ACE log");
          stopAt = Date.now();
        }
        if (stopAt && !aborted && Date.now() - stopAt > 800) { aborted = true; await pilot.evaluate(() => { window.__filmAbort = true; }).catch(() => {}); }
      } finally { busy = false; }
    }, 250);
    try {
      res.flight = await runOn(pilot, "film-hellcat.eval.js", { ...RUN, mode: "attack", attackStartM: 2200, slowAtM: 3000, attackView: "chase", cruiseAgl: 70,
        attackThrottle: Number(opt("--attack-throttle", "0.38")), maxPasses: Number(opt("--max-passes", "1")), maxSec: 300, channel: CHANNEL, maxKills: Number(opt("--max-kills", "1")) });
      log("attack", JSON.stringify(res.flight?.summary ?? res.flight?.fatal ?? res.flight).slice(0, 1200));
    } finally {
      clearInterval(watch);
      while (busy) await sleep(50);
      // the grab ends here at the latest (no kill: the flight ended), then the aircraft out of the sky BEFORE the flush
      if (res.rec) res.grabEnd = await recPage.evaluate(() => { const v = window.__hbVid; if (v?.unsub) { v.unsub(); v.unsub = null; return "driver"; } return "probe"; }).catch((e) => `error ${e.message}`);
      try { await chatOn(pilot, "@vehicle despawn all"); await sleep(2000); log("despawned"); } catch (e) { res.errors.push(`despawn: ${e.message}`); }
    }
    readAceLog();
    res.probe = await recPage.evaluate(() => window.__groundProbe.report()).catch((e) => ({ error: e.message }));
    log("probe", JSON.stringify({ seen: res.probe?.seen, steps: (res.probe?.steps || []).map((s) => ({ why: s.why, pilotDist: s.pilotDist, moved: s.moved })), kills: res.probe?.kills, stopped: res.probe?.stopped }).slice(0, 1500));
    if (!recOn) res.errors.push("the recording never started");
    if (res.rec) { try { res.recStop = await stopGrab(); } catch (e) { res.errors.push(`stop: ${e.message}`); } }
  }
  if (res.rec) {
    if (res.recStop) await drainAll();
    else res.recStop = await stopRec();
    if (REC_CAP > 0) log("rec cap restored", JSON.stringify(await setRecCap(0)));
    const { pace, ...stopLog } = res.recStop;
    log("recording stopped", JSON.stringify({ ...stopLog, drainedMB: Math.round(drainedBytes / 1048576) }));
    if (pace) log("pace", JSON.stringify({ hist: pace.hist, gaps: pace.gaps.length, worst: pace.gaps.reduce((m, g) => Math.max(m, g[1]), 0) }));
    // events in video time. The eval's events carry the PILOT page's performance.now(), the recorder's t0 the RECORDED
    // page's: two pages, two time origins (take B: ~1.3 s apart) — convert through performance.timeOrigin
    const origin = async (pg) => pg.evaluate(() => performance.timeOrigin).catch(() => null);
    res.clock = { pilotOrigin: await origin(pilot), recOrigin: await origin(recPage) };
    const evOffset = recPage === pilot || res.clock.pilotOrigin == null || res.clock.recOrigin == null ? 0 : res.clock.pilotOrigin - res.clock.recOrigin;
    res.clock.evalOffsetMs = Math.round(evOffset * 10) / 10;
    const vt = (t) => (res.recStop.t0 != null && t != null ? Math.round(t + evOffset - res.recStop.t0) / 1000 : null);
    const evs = (res.flight?.events || []).map((e) => ({ kind: e.kind, video: vt(e.t), ...e }));
    res.videoEvents = evs.map((e) => ({ kind: e.kind, video: e.video }));
    // take B: the recording page's own observations (same clock as t0): the first sight, the sidesteps, the kill as it
    // reached this page (kill1 = the probe's; the pilot page's own detection stays as kill1Pilot), the grab's stop
    if (res.probe) {
      for (const e of res.videoEvents) if (/^kill\d$/.test(e.kind)) e.kind += "Pilot";
      const pv = (t) => (res.recStop.t0 != null && t != null ? Math.round(t - res.recStop.t0) / 1000 : null);
      const P = res.probe;
      if (P.seen) res.videoEvents.push({ kind: "firstSight", video: pv(P.seen.t) });
      if (P.seenEntity) res.videoEvents.push({ kind: "firstSightEntity", video: pv(P.seenEntity.t) });
      for (const s of P.steps || []) res.videoEvents.push({ kind: s.why || "step", video: pv(s.tDown) });
      for (const k of P.kills || []) res.videoEvents.push({ kind: k.kind, video: pv(k.t) });
      if (P.pilotBody) res.videoEvents.push({ kind: "pilotBody", video: pv(P.pilotBody.t) });
      if (P.stopped) res.videoEvents.push({ kind: "grabStopped", video: pv(P.stopped.t) });
      res.videoEvents.sort((a, b) => (a.video ?? -1e9) - (b.video ?? -1e9));
    }
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
