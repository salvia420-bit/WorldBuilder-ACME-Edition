// drone-live.mjs — the 1070 driver for the Drone Deploy smoke (PLAN §9.4 step 6, SPEC §12.3 step 6) and the
// eye test (PLAN §9.6 / §10). Local ACE only: the login pins server_host=127.0.0.1 through the tunneled ws
// bridge; never the owner's Coldeve profile or session. The test Chrome is on-screen (owner-authorized
// 2026-10-24) and always MUTED, in its own profile (hbb-drone), reached over CDP :9333 through the existing
// tunnel (ssh -fN -L 9333 -R 8765 -R 8080 young@100.127.215.75).
//
// Run from anywhere; the laptop's oom-guard wants browser drivers inside the memory cap:
//   capped-wireagent node drone-live.mjs launch            start the test Chrome (schtasks + hidden-run.vbs)
//   capped-wireagent node drone-live.mjs boot [--flags 'a=b&c=d'] [--account A] [--character Name]
//   capped-wireagent node drone-live.mjs smoke [--quick]   deploy → fly → recall → idle, with the send counter
//   capped-wireagent node drone-live.mjs eval <file.js>    evaluate a file's body as an async fn in the page; prints JSON
//   capped-wireagent node drone-live.mjs shot <name> [--full]  canvas (or full-page) screenshot → live/shots/<name>.jpg
//   capped-wireagent node drone-live.mjs logout            about:blank, then wait for ACE's [LOGOUT]
//   capped-wireagent node drone-live.mjs kill              close the test Chrome by its profile, delete the task + profile
// Passwords are read at runtime from scripts/perf-worker/hbbench.mjs (never copied).
import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOLT = join(HERE, "../../../../..");                       // external/holtburger
const SHOTS = join(HERE, "shots");
const BOX = "young@100.127.215.75";
const CDP = "http://127.0.0.1:9333";
const APP = process.env.DL_APP || "http://127.0.0.1:8765/apps/holtburger-web/index.html";  // DL_APP: another server
const TASK = "HBDRONE";
const PROFILE = "hbb-drone";
const ACE_LOG = "/home/wbterminal/ace-server/Source/ACE.Server/bin/Release/net10.0/ACE_Log.txt";

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const has = (k) => argv.includes(k);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ssh = (c, timeout = 60000) => execFileSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", BOX, c], { encoding: "utf8", timeout });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// The local ACE test-account passwords live in the repo's existing harness scripts (project convention); read them
// at runtime, never copy them: tailnet1 in scripts/perf-worker/hbbench.mjs, phase4demo in harness/vistest-1070-round1-7.mjs.
function password(account) {
  for (const f of ["scripts/perf-worker/hbbench.mjs", "apps/holtburger-web/harness/vistest-1070-round1-7.mjs"]) {
    let src = "";
    try { src = readFileSync(join(HOLT, f), "utf8"); } catch (_) { continue; }
    const m = src.match(new RegExp(`account=${account}&password=([^&"\`]+)`));
    if (m) return m[1];
  }
  throw new Error(`password for ${account} not found in the harness scripts`);
}
function aceLogTail(bytes = 262144) {
  const size = statSync(ACE_LOG).size, fd = openSync(ACE_LOG, "r");
  const buf = Buffer.alloc(Math.min(bytes, size)); readSync(fd, buf, 0, buf.length, size - buf.length); closeSync(fd);
  return buf.toString("utf8");
}
function accountState(account) {
  const ev = aceLogTail().split("\n").filter((l) => new RegExp(`\\[(LOGIN|LOGOUT)\\] Account ${account} `).test(l));
  const last = ev[ev.length - 1] || "";
  return { loggedIn: /\[LOGIN\]/.test(last), last: last.slice(0, 160) };
}
async function waitAccountFree(account, maxMs = 150000) {
  const end = Date.now() + maxMs;
  while (Date.now() < end) { if (!accountState(account).loggedIn) return true; await sleep(2000); }
  return false;
}
async function page() {
  const browser = await chromium.connectOverCDP(CDP);
  const ctx = browser.contexts()[0];
  const pg = ctx.pages().find((p) => p.url().includes("holtburger-web")) || ctx.pages()[0];
  return { browser, ctx, pg };
}
function collect(pg) {
  const errors = [], warns = [];
  pg.on("pageerror", (e) => errors.push("pageerror: " + String(e).slice(0, 400)));
  pg.on("console", (m) => {
    if (m.type() === "error") errors.push("console.error: " + m.text().slice(0, 400));
    else if (m.type() === "warning" && /\[drone/.test(m.text())) warns.push(m.text().slice(0, 300));
  });
  return { errors, warns };
}
// Outbound game actions: WebSocket frames carry [port u16 BE][AC packet]; a game action is 0xF7B1 (LE) + u32
// sequence + u32 opcode. Same counter as recon/probe/scripts/probe2.mjs.
const INSTALL_SEND_COUNTER = () => {
  if (window.__dlSend) return true;
  const orig = WebSocket.prototype.send;
  const C = { frames: 0, actions: {} };
  window.__dlSend = { C, orig, reset() { C.frames = 0; C.actions = {}; }, read() { return JSON.parse(JSON.stringify(C)); } };
  WebSocket.prototype.send = function (data) {
    try {
      C.frames += 1;
      const u8 = data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
      if (u8) for (let i = 0; i + 12 <= u8.length; i += 1) {
        if (u8[i] === 0xB1 && u8[i + 1] === 0xF7 && u8[i + 2] === 0 && u8[i + 3] === 0) {
          const op = (u8[i + 8] | (u8[i + 9] << 8) | (u8[i + 10] << 16) | (u8[i + 11] << 24)) >>> 0;
          const k = "0x" + op.toString(16).toUpperCase().padStart(4, "0");
          C.actions[k] = (C.actions[k] || 0) + 1; i += 11;
        }
      }
    } catch (_) {}
    return orig.call(this, data);
  };
  return true;
};
const REMOVE_SEND_COUNTER = () => { if (window.__dlSend) { WebSocket.prototype.send = window.__dlSend.orig; delete window.__dlSend; } return true; };

async function waitFor(pg, fn, arg, { timeoutMs = 30000, everyMs = 250, label = "condition" } = {}) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try { last = await pg.evaluate(fn, arg); if (last && last.ok) return last; } catch (e) { last = { error: String(e).slice(0, 200) }; }
    if (last && last.fail) break;
    await sleep(everyMs);
  }
  throw new Error(`timeout waiting for ${label}: ${JSON.stringify(last)?.slice(0, 400)}`);
}

if (cmd === "launch") {
  // Upload the launcher (CRLF), then run it hidden in the interactive session.
  const bat = readFileSync(join(HERE, "box/drone-launch.bat"), "utf8").replace(/\r?\n/g, "\r\n");
  const tmp = join(HERE, ".drone-launch.crlf.bat");
  writeFileSync(tmp, bat);
  execFileSync("scp", ["-o", "BatchMode=yes", tmp, `${BOX}:D:/Temp/hbbench/drone-launch.bat`], { timeout: 60000 });
  execFileSync("rm", ["-f", tmp]);
  const running = ssh(`powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"Name='chrome.exe'\\" | Where-Object { $_.CommandLine -like '*${PROFILE}*' } | Measure-Object).Count"`).trim();
  if (Number(running) > 0) { log(`test Chrome already running (${running} processes)`); }
  else {
    ssh(`schtasks /create /tn ${TASK} /tr "wscript.exe //B //Nologo D:\\Temp\\hbbench\\hidden-run.vbs D:\\Temp\\hbbench\\drone-launch.bat" /sc once /st 00:00 /it /f & schtasks /run /tn ${TASK}`);
    log("launched; waiting for CDP");
  }
  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch(`${CDP}/json/version`); if (r.ok) { const j = await r.json(); log("CDP up:", j.Browser); break; } } catch (_) {}
    await sleep(1000);
  }
  process.exit(0);
}

if (cmd === "kill") {
  try {
    const { browser, pg } = await page();
    await pg.goto("about:blank").catch(() => {});
    await browser.close().catch(() => {});
  } catch (_) {}
  const out = ssh(`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='chrome.exe'\\" | Where-Object { $_.CommandLine -like '*${PROFILE}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Seconds 2; Remove-Item -Recurse -Force D:\\Temp\\hbbench\\${PROFILE} -ErrorAction SilentlyContinue; schtasks /delete /tn ${TASK} /f 2>$null; 'left=' + (Get-CimInstance Win32_Process -Filter \\"Name='chrome.exe'\\" | Where-Object { $_.CommandLine -like '*${PROFILE}*' } | Measure-Object).Count"`);
  log("kill:", out.trim().split(/\r?\n/).pop());
  process.exit(0);
}

if (cmd === "logout") {
  const account = opt("--account", "tailnet1");
  const { pg } = await page();
  await pg.goto("about:blank");
  log("about:blank; waiting for ACE [LOGOUT]");
  const ok = await waitAccountFree(account, 60000);
  log(ok ? "logged out" : "still logged in after 60 s", accountState(account).last);
  process.exit(ok ? 0 : 1);
}

if (cmd === "boot") {
  // --charlist stops at the character list (autoSpawn=0); --password-file reads a local (non-repo) password file for
  // accounts that are not in hbbench.mjs (ACE auto-creates an account on its first login).
  const account = opt("--account", "tailnet1");
  const character = has("--charlist") ? "0" : opt("--character", "");
  const flags = opt("--flags", "nosw=1&drone=on&droneDebug=on");
  const pwFile = opt("--password-file", "");
  if (accountState(account).loggedIn) {
    log("account in use; waiting for its logout", accountState(account).last);
    if (!(await waitAccountFree(account))) { log("account still in use; refusing to log in (would boot both sessions)"); process.exit(2); }
  }
  const pw = pwFile ? readFileSync(pwFile, "utf8").trim() : password(account);
  const q = new URLSearchParams({
    autoLogin: "1", account, password: pw, autoSpawn: character || "first", camDebug: "on",
    quality: "high", csm: "off", renderScale: "1", adaptiveRes: "off",
    bridge_url: "ws://127.0.0.1:8080/", server_host: "127.0.0.1", server_port: "9000",
  });
  for (const [k, v] of new URLSearchParams(flags)) q.set(k, v);
  const { pg } = await page();
  const { errors } = collect(pg);
  try { const s = await pg.context().newCDPSession(pg); const { windowId } = await s.send("Browser.getWindowForTarget"); await s.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "maximized" } }); } catch (_) {}
  await pg.goto(`${APP}?${q}`);
  log("navigated; waiting for ready");
  const r = await waitFor(pg, (charlist) => {
    const h = (window.__bootStateHistory || []).map((e) => e.state);
    if (h.includes("error")) return { ok: false, fail: true, h: h.slice(-6), msg: (window.__bootStateHistory || []).slice(-1)[0]?.message };
    if (charlist) return { ok: h.includes("char-list-ready"), h: h.slice(-6) };
    return { ok: window.__sceneReadyEverFired === true || h.includes("ready"), h: h.slice(-6) };
  }, character === "0", { timeoutMs: 120000, everyMs: 1000, label: character === "0" ? "character list" : "boot ready" });
  const gpu = await pg.evaluate(() => {
    try { const gl = document.createElement("canvas").getContext("webgl2"); const e = gl.getExtension("WEBGL_debug_renderer_info"); return gl.getParameter(e.UNMASKED_RENDERER_WEBGL); } catch (e) { return String(e); }
  });
  const who = await pg.evaluate(() => ({ guid: "0x" + ((window.getLocalPlayerGuid?.() ?? 0) >>> 0).toString(16), hud: !!window.__droneHud, drone: !!window.__drone,
    muted: null, url: location.search.replace(/password=[^&]+/, "password=<redacted>") }));
  log("ready", JSON.stringify(r.h), "gpu:", gpu);
  log("page:", JSON.stringify(who));
  log("errors so far:", errors.length, JSON.stringify(errors.slice(0, 5)));
  process.exit(0);
}

if (cmd === "eval") {
  const file = argv[1];
  const body = readFileSync(file, "utf8");
  const { pg } = await page();
  const { errors } = collect(pg);
  // --shots <prefix> [--every ms] [--count n]: canvas shots while the script runs, from this one driver process
  // (the laptop's oom-guard allows a single driver at a time).
  const shotPrefix = opt("--shots", ""), every = Number(opt("--every", "8000")), count = Number(opt("--count", "4"));
  let done = false;
  const shooter = (async () => {
    if (!shotPrefix) return;
    mkdirSync(SHOTS, { recursive: true });
    for (let i = 1; i <= count && !done; i += 1) {
      await sleep(every);
      if (done) break;
      const path = join(SHOTS, `${shotPrefix}-${i}.jpg`);
      await pg.locator("#canvas").screenshot({ path, type: "jpeg", quality: 82 }).then(() => log("shot", path), (e) => log("shot failed", String(e).slice(0, 160)));
    }
  })();
  const r = await pg.evaluate(`(async () => { ${body} })()`);
  done = true;
  await shooter;
  console.log(JSON.stringify(r, null, 1));
  if (errors.length) console.log("errors:", JSON.stringify(errors));
  process.exit(0);
}

if (cmd === "shot") {
  const name = argv[1] || "shot";
  mkdirSync(SHOTS, { recursive: true });
  const { pg } = await page();
  const path = join(SHOTS, `${name}.jpg`);
  if (has("--full")) await pg.screenshot({ path, type: "jpeg", quality: 82 });
  else await pg.locator("#canvas").screenshot({ path, type: "jpeg", quality: 82 });
  log("shot", path);
  process.exit(0);
}

if (cmd === "smoke") {
  const quick = !has("--slow");
  const { pg } = await page();
  const { errors, warns } = collect(pg);
  const report = { at: new Date().toISOString(), quick, steps: [] };
  const step = (name, data) => { report.steps.push({ name, ...data }); log(name, JSON.stringify(data).slice(0, 600)); };

  step("preflight", await pg.evaluate(() => ({ bootState: window.__bootState, ready: window.__sceneReadyEverFired === true,
    hud: !!window.__droneHud, launcher: !!document.getElementById("hb-drone-hud-launcher"), drone: !!window.__drone,
    fault: window.__inputFunnel?.snapshot?.().fault ?? null })));
  step("load", await pg.evaluate(async () => { try { const api = await window.__droneHud.load(); return { ok: !!api, version: window.__drone?.version, status: window.__drone?.status?.() }; } catch (e) { return { ok: false, error: String(e) }; } }));
  await pg.evaluate(INSTALL_SEND_COUNTER);

  // Idle baseline, then the cycle: the same counter, compared by opcode.
  await pg.evaluate(() => window.__dlSend.reset());
  const BASE_MS = 15000;
  await sleep(BASE_MS);
  const idle = await pg.evaluate(() => window.__dlSend.read());
  step("idle-baseline", { ms: BASE_MS, sends: idle });

  await pg.evaluate(() => window.__dlSend.reset());
  const t0 = Date.now();
  step("deploy", await pg.evaluate((quick) => window.__drone.deploy({ quick }), quick));
  const flying = await waitFor(pg, () => { const s = window.__drone.status(); return { ok: s.state === "flying", state: s.state, beat: s.beat }; }, null, { timeoutMs: 20000, everyMs: 100, label: "flying" });
  step("flying", { afterMs: Date.now() - t0, ...flying, status: await pg.evaluate(() => window.__drone.status()) });
  mkdirSync(SHOTS, { recursive: true });
  await pg.locator("#canvas").screenshot({ path: join(SHOTS, "smoke-fpv.jpg"), type: "jpeg", quality: 80 }).catch(() => {});
  step("sticks", await pg.evaluate(() => window.__drone.debug.setSticks({ pitch: 0.5 }, 3000)));
  await sleep(3500);
  step("after-sticks", { status: await pg.evaluate(() => window.__drone.status()) });
  step("recall", await pg.evaluate(() => window.__drone.recall()));
  const idleAgain = await waitFor(pg, () => { const s = window.__drone.status(); return { ok: s.state === "idle", state: s.state, beat: s.beat }; }, null, { timeoutMs: 60000, everyMs: 200, label: "idle" });
  const cycleMs = Date.now() - t0;
  step("idle", { afterMs: cycleMs, ...idleAgain });
  const cycle = await pg.evaluate(() => window.__dlSend.read());
  step("cycle-sends", { ms: cycleMs, sends: cycle });

  const post = await pg.evaluate(() => {
    const ev = window.__drone.debug.events({ limit: 200 });
    const states = (ev.events || []).filter((e) => e.message === "state").map((e) => e.state);
    return { states, fault: window.__inputFunnel?.snapshot?.().fault ?? null, owned: window.__drone.status().camera?.owned,
      film: !!window.liveScene3d?.film, filmViewer: !!window.liveScene3d?.filmViewer, osd: !!document.getElementById("hb-drone-osd"),
      droneGroup: !!window.liveScene3d?.scene?.getObjectByName?.("drone-world"), status: window.__drone.status() };
  });
  step("post", post);
  await pg.evaluate(REMOVE_SEND_COUNTER);

  // Verdicts. Outbound: every opcode in the cycle other than the 0x01E9 ping is a failure; the ping count is
  // compared to the idle rate.
  const extra = Object.entries(cycle.actions).filter(([k]) => k !== "0x01E9");
  const want = ["deploying", "flying", "returning", "landing", "stowing", "idle"];
  const seqOk = JSON.stringify(post.states.slice(-want.length)) === JSON.stringify(want);
  report.verdict = {
    stateSequence: seqOk ? "PASS" : `FAIL ${JSON.stringify(post.states)}`,
    consoleErrors: errors.length === 0 ? "PASS" : `FAIL ${errors.length}`,
    outbound: extra.length === 0 ? "PASS" : `FAIL ${JSON.stringify(extra)}`,
    pingRate: { idlePerMin: +((idle.actions["0x01E9"] || 0) * 60000 / BASE_MS).toFixed(1), cyclePerMin: +((cycle.actions["0x01E9"] || 0) * 60000 / cycleMs).toFixed(1) },
    gateReopened: post.fault === null ? "PASS" : `FAIL fault=${post.fault}`,
    cameraReleased: post.owned === false && !post.film && !post.filmViewer ? "PASS" : `FAIL owned=${post.owned} film=${post.film} viewer=${post.filmViewer}`,
    cleanScene: !post.osd && !post.droneGroup ? "PASS" : `FAIL osd=${post.osd} droneGroup=${post.droneGroup}`,
  };
  report.errors = errors; report.warns = warns;
  writeFileSync(join(HERE, `smoke-${report.at.replace(/[:.]/g, "-")}.json`), JSON.stringify(report, null, 1));
  log("VERDICT", JSON.stringify(report.verdict, null, 1));
  if (errors.length) log("errors:", JSON.stringify(errors.slice(0, 10), null, 1));
  if (warns.length) log("drone warns:", JSON.stringify(warns.slice(0, 10), null, 1));
  process.exit(0);
}

if (cmd === "tour") {
  // A full (non-quick unless --quick) cycle with timed full-page screenshots of every beat, pilot view, a short
  // flight and the recall/stow: the eye-test look (PLAN §10 E2–E5). Shots → live/shots/<prefix>-NN-<what>.jpg.
  const prefix = opt("--prefix", "tour");
  const quick = has("--quick");
  mkdirSync(SHOTS, { recursive: true });
  const { pg } = await page();
  const { errors, warns } = collect(pg);
  const t0 = Date.now();
  let n = 0;
  const snap = async (what) => {
    const st = await pg.evaluate(() => { const s = window.__drone?.status?.(); return s ? { state: s.state, beat: s.beat, owned: s.camera?.owned, craft: s.craft ? { aglM: s.craft.aglM, distHomeM: s.craft.distHomeM, speed: s.craft.speed } : null } : null; });
    const name = `${prefix}-${String(n++).padStart(2, "0")}-${what}`;
    await pg.screenshot({ path: join(SHOTS, `${name}.jpg`), type: "jpeg", quality: 80 });
    log(`${((Date.now() - t0) / 1000).toFixed(2)}s`, name, JSON.stringify(st));
  };
  const at = async (sec) => { const w = t0 + sec * 1000 - Date.now(); if (w > 0) await sleep(w); };
  await pg.evaluate(async () => { await window.__droneHud.load(); return true; });
  await snap("idle");
  const sp = quick ? 1.5 : 1;
  const T = (s) => s / sp;
  await pg.evaluate((quick) => window.__drone.deploy({ quick }), quick);
  const marks = quick
    ? [[0.4, "place-kneel"], [0.75, "place-drone-down"], [1.6, "goggles-at-face"], [2.4, "tablet-up"], [3.2, "liftoff"], [3.75, "first-fpv"], [4.6, "flying"]]
    : [[0.45, "pack-reach"], [0.75, "pack-drone-in-hand"], [2.05, "place-drone-down"], [2.9, "place-standing"], [3.6, "goggles-at-face"], [4.7, "tablet-up"], [5.6, "liftoff"], [6.5, "first-fpv"], [7.6, "flying"]];
  for (const [s, what] of marks) { await at(s); await snap(what); }
  await waitFor(pg, () => ({ ok: window.__drone.status().state === "flying" }), null, { timeoutMs: 15000, everyMs: 100, label: "flying" });
  await pg.evaluate(() => window.__drone.pilotView(true)); await sleep(900); await snap("pilot-view");
  await pg.evaluate(() => window.__drone.pilotView(false)); await sleep(700); await snap("back-to-fpv");
  await pg.evaluate(() => window.__drone.debug.setSticks({ throttle: 1, pitch: -0.4 }, 2500)); await sleep(2700); await snap("climb-back");
  await pg.evaluate(() => window.__drone.debug.setSticks({ pitch: 1 }, 2000)); await sleep(2300); await snap("fly-forward");
  await pg.evaluate(() => window.__drone.recall()); await sleep(1500); await snap("returning");
  const tr = Date.now();
  for (const [st, what] of [["landing", "landing"], ["stowing", "stow-start"]]) {
    await waitFor(pg, (s) => ({ ok: window.__drone.status().state === s }), st, { timeoutMs: 60000, everyMs: 100, label: st }).catch(() => {});
    await snap(what);
  }
  await sleep(T(1500)); await snap("stow-goggles-off");
  await sleep(T(1700)); await snap("stow-pickup");
  await waitFor(pg, () => ({ ok: window.__drone.status().state === "idle" }), null, { timeoutMs: 30000, everyMs: 200, label: "idle" }).catch(() => {});
  await snap("idle-after");
  log("recall→idle", ((Date.now() - tr) / 1000).toFixed(1), "s; errors", errors.length, JSON.stringify(errors.slice(0, 5)), "warns", JSON.stringify(warns.slice(0, 5)));
  process.exit(0);
}

if (cmd === "eye") {
  // The measurable eye-test items (PLAN §10): E1 launcher + Shift+F11, E3 camera continuity across the cut,
  // E5 movement right after the stow, E6 damage abort latency, E7 frame times (first deploy, flying vs standing),
  // E8 the hum on the effects bus (an AnalyserNode: the 1070 is muted), E9 outbound actions over a full cycle.
  const { pg } = await page();
  const { errors, warns } = collect(pg);
  const R = { at: new Date().toISOString(), steps: {} };
  const put = (k, v) => { R.steps[k] = v; log(k, JSON.stringify(v).slice(0, 900)); };
  const status = () => pg.evaluate(() => window.__drone?.status?.() ?? null);
  const until = (state, ms = 30000) => waitFor(pg, (s) => ({ ok: window.__drone?.status?.().state === s, at: window.__drone?.status?.().state }), state, { timeoutMs: ms, everyMs: 50, label: state });
  await pg.evaluate(async () => { await window.__droneHud.load(); return true; });
  await pg.evaluate(INSTALL_SEND_COUNTER);
  // Page-side recorders: rAF frame times and the render camera per frame (AC-free: three world position + quaternion).
  await pg.evaluate(() => {
    if (window.__dlRec) return true;
    const cam = () => window.liveScene3d?.cameraSwitcher?.persp ?? window.liveScene3d?.camera ?? null;
    const R = { on: false, rows: [], last: 0 };
    const tick = (t) => {
      if (R.on) {
        const c = cam(); const s = window.__drone?.status?.();
        R.rows.push([t - (R.last || t), c ? c.position.x : 0, c ? c.position.y : 0, c ? c.position.z : 0,
          c ? c.quaternion.x : 0, c ? c.quaternion.y : 0, c ? c.quaternion.z : 0, c ? c.quaternion.w : 1, s?.state ?? "", s?.camera?.owned ? 1 : 0]);
      }
      R.last = t; requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    window.__dlRec = { start() { R.rows = []; R.on = true; }, stop() { R.on = false; return R.rows; } };
    return true;
  });
  const recStart = () => pg.evaluate(() => window.__dlRec.start());
  const recStop = () => pg.evaluate(() => window.__dlRec.stop());
  const ftStats = (rows) => {
    const dts = rows.map((r) => r[0]).filter((d) => d > 0).sort((a, b) => a - b);
    if (!dts.length) return null;
    const mean = dts.reduce((a, b) => a + b, 0) / dts.length;
    return { frames: dts.length, fps: +(1000 / mean).toFixed(1), meanMs: +mean.toFixed(2), p95Ms: +dts[Math.floor(dts.length * 0.95)].toFixed(1), maxMs: +dts[dts.length - 1].toFixed(1), over50: dts.filter((d) => d > 50).length };
  };
  const camJumps = (rows) => {
    // Largest per-frame camera move / turn among consecutive OWNED frames (the cut itself is excluded).
    let maxM = 0, maxDeg = 0;
    for (let i = 1; i < rows.length; i += 1) {
      const a = rows[i - 1], b = rows[i];
      if (!(a[9] && b[9])) continue;
      maxM = Math.max(maxM, Math.hypot(b[1] - a[1], b[2] - a[2], b[3] - a[3]));
      const dot = Math.min(1, Math.abs(a[4] * b[4] + a[5] * b[5] + a[6] * b[6] + a[7] * b[7]));
      maxDeg = Math.max(maxDeg, (2 * Math.acos(dot) * 180) / Math.PI);
    }
    return { maxStepM: +maxM.toFixed(3), maxTurnDeg: +maxDeg.toFixed(2) };
  };

  // E1: placement, tooltip, Shift+F11 (deploys, never toggles fullscreen), then abort.
  put("E1-launcher", await pg.evaluate(() => {
    const d = document.getElementById("hb-drone-hud-launcher")?.getBoundingClientRect();
    const r = document.getElementById("hb-rynth-hud-launcher")?.getBoundingClientRect();
    const b = document.getElementById("hb-drone-hud-launcher");
    return { drone: d ? [d.x, d.y, d.width, d.height].map(Math.round) : null, rynth: r ? [r.x, r.y, r.width, r.height].map(Math.round) : null,
      belowRynth: !!(d && r && Math.abs(d.x - r.x) < 2 && d.y > r.y), inAddons: !!b?.closest?.(".hb-hotbar-addons"), tip: b?._hbTip?.() ?? null };
  }));
  const ih0 = await pg.evaluate(() => [innerWidth, innerHeight]);
  await pg.bringToFront().catch(() => {});   // CDP key events reach the page without a click (a click could pick or hit the HUD)
  await pg.keyboard.press("Shift+F11");
  await sleep(300);
  const afterKey = await pg.evaluate(() => ({ state: window.__drone.status().state, fullscreen: !!document.fullscreenElement, size: [innerWidth, innerHeight] }));
  put("E1-shiftF11", { ...afterKey, sizeBefore: ih0, deployedByHotkey: afterKey.state !== "idle", fullscreenToggled: afterKey.fullscreen || afterKey.size[1] !== ih0[1] });
  if (afterKey.state !== "idle") { await pg.evaluate(() => window.__drone.abort("user")); await until("idle", 20000).catch(() => {}); }
  await sleep(1500);

  // E7 baseline: standing still, 5 s.
  await recStart(); await sleep(5000);
  put("E7-standing", ftStats(await recStop()));

  // First full deploy of the page: frame times through the gestures and the cut (E7), camera continuity (E3).
  await pg.evaluate(() => window.__dlSend.reset());
  await recStart();
  put("deploy", await pg.evaluate(() => window.__drone.deploy({ quick: false })));
  await until("flying", 20000);
  await sleep(600);
  const depRows = await recStop();
  put("E7-first-deploy", ftStats(depRows));
  put("E3-cut-continuity", camJumps(depRows));
  // Flying (cine): frame times + continuity under stick input.
  await recStart();
  await pg.evaluate(() => window.__drone.debug.setSticks({ pitch: 0.6, yaw: 0.3 }, 4000));
  await sleep(4300);
  const flyRows = await recStop();
  put("E7-flying", ftStats(flyRows));
  put("E4-flying-continuity", camJumps(flyRows));
  // E8: the hum on the effects bus while flying (analyser on the bus node; the page is muted at the OS level only).
  put("E8-hum", await pg.evaluate(async () => {
    const bus = window.liveScene3d?.audioManager?.getEffectBus?.();
    if (!bus) return { ok: false, reason: "no effect bus (no AudioContext yet?)" };
    const an = bus.ctx.createAnalyser(); an.fftSize = 2048; bus.node.connect(an);
    window.__drone.debug.setSticks({ throttle: 0.8 }, 1500);
    await new Promise((r) => setTimeout(r, 900));
    const buf = new Float32Array(an.fftSize); an.getFloatTimeDomainData(buf);
    let s = 0; for (const v of buf) s += v * v;
    try { bus.node.disconnect(an); } catch (_) {}
    return { ok: true, ctxState: bus.ctx.state, rms: +Math.sqrt(s / buf.length).toFixed(5), sliderGain: bus.sliderGain() };
  }));
  await sleep(800);
  // E6: damage abort while flying → camera back and input live within one frame.
  await recStart();
  await pg.evaluate(() => window.__drone.debug.trigger("damage"));
  await sleep(400);
  const abRows = await recStop();
  const firstReleased = abRows.findIndex((r) => r[9] === 0);
  put("E6-damage", { framesUntilReleased: firstReleased, state: (await status()).state, fault: await pg.evaluate(() => window.__inputFunnel?.snapshot?.().fault ?? null), lastAbort: (await status()).lastAbort });
  await until("idle", 20000).catch(() => {});
  const cycle1 = await pg.evaluate(() => window.__dlSend.read());
  put("E9-cycle1-sends", cycle1);

  // Second cycle (quick): full recall + stow, then E5 movement.
  await sleep(1500);
  await pg.evaluate(() => window.__dlSend.reset());
  const t2 = Date.now();
  await pg.evaluate(() => window.__drone.deploy({ quick: true }));
  await until("flying", 20000);
  await pg.evaluate(() => window.__drone.debug.setSticks({ pitch: 0.5 }, 2000)); await sleep(2300);
  await pg.evaluate(() => window.__drone.recall());
  await until("idle", 60000);
  const cycle2 = await pg.evaluate(() => window.__dlSend.read());
  put("E9-cycle2-sends", { ms: Date.now() - t2, ...cycle2 });
  put("E5-clean", await pg.evaluate(() => {
    const live = window.liveScene3d, g = (window.getLocalPlayerGuid?.() ?? 0) >>> 0;
    const inst = live?.entityManager?.entityMap?.get(g);
    let onRig = 0; for (const p of inst?.parts ?? []) for (const ch of p.children) if (ch.userData?.__attachedChildOf != null && !ch.userData?.surfaceDid) onRig += 1;
    return { droneGroup: !!live?.scene?.getObjectByName?.("drone-world"), propsOnRig: onRig, osd: !!document.getElementById("hb-drone-osd"), fault: window.__inputFunnel?.snapshot?.().fault ?? null };
  }));
  // E5: walk forward 1.2 s with W right after the stow.
  const pos0 = await pg.evaluate(() => { const g = (window.getLocalPlayerGuid?.() ?? 0) >>> 0; const r = window.liveScene3d.entityManager.entityMap.get(g)?.root?.position; return r ? [r.x, r.y, r.z] : null; });
  await pg.evaluate(() => window.__dlSend.reset());
  await pg.bringToFront().catch(() => {});
  await pg.keyboard.down("KeyW"); await sleep(1200); await pg.keyboard.up("KeyW"); await sleep(600);
  const pos1 = await pg.evaluate(() => { const g = (window.getLocalPlayerGuid?.() ?? 0) >>> 0; const r = window.liveScene3d.entityManager.entityMap.get(g)?.root?.position; return r ? [r.x, r.y, r.z] : null; });
  const walkSends = await pg.evaluate(() => window.__dlSend.read());
  put("E5-walk", { movedM: pos0 && pos1 ? +Math.hypot(pos1[0] - pos0[0], pos1[1] - pos0[1]).toFixed(2) : null, sends: walkSends });
  await pg.evaluate(REMOVE_SEND_COUNTER);

  const idleRate = (c, ms) => +(((c.actions?.["0x01E9"] || 0) * 60000) / Math.max(1, ms)).toFixed(1);
  const extra = (c) => Object.entries(c.actions || {}).filter(([k]) => k !== "0x01E9");
  const s = R.steps;
  R.verdict = {
    E1: s["E1-launcher"].belowRynth && s["E1-launcher"].inAddons && s["E1-shiftF11"].deployedByHotkey && !s["E1-shiftF11"].fullscreenToggled ? "PASS" : "CHECK",
    E3: s["E3-cut-continuity"].maxTurnDeg <= 6 && s["E3-cut-continuity"].maxStepM <= 0.5 ? "PASS" : "CHECK",
    E5: s["E5-clean"].droneGroup === false && s["E5-clean"].propsOnRig === 0 && s["E5-clean"].fault === null && (s["E5-walk"].movedM ?? 0) > 0.5 ? "PASS" : "CHECK",
    E6: s["E6-damage"].framesUntilReleased >= 0 && s["E6-damage"].framesUntilReleased <= 2 && s["E6-damage"].fault === null ? "PASS" : "CHECK",
    E7: s["E7-flying"] && s["E7-standing"] && s["E7-flying"].fps >= 0.95 * s["E7-standing"].fps && s["E7-first-deploy"].maxMs <= 50 && errors.length === 0 ? "PASS" : "CHECK",
    E8: s["E8-hum"].ok && s["E8-hum"].rms > 0.0005 ? "PASS (graph audible on the bus; output muted)" : "CHECK",
    E9: extra(s["E9-cycle1-sends"]).length === 0 && extra(s["E9-cycle2-sends"]).length === 0 ? "PASS" : "CHECK",
    pingsPerMin: { cycle2: idleRate(s["E9-cycle2-sends"], s["E9-cycle2-sends"].ms) },
  };
  R.errors = errors; R.warns = warns;
  writeFileSync(join(HERE, `eye-${R.at.replace(/[:.]/g, "-")}.json`), JSON.stringify(R, null, 1));
  log("VERDICT", JSON.stringify(R.verdict, null, 1));
  if (errors.length) log("errors:", JSON.stringify(errors.slice(0, 8), null, 1));
  if (warns.length) log("drone warns:", JSON.stringify(warns.slice(0, 8), null, 1));
  process.exit(0);
}

if (cmd === "perf") {
  // Frame rate + a CDP CPU profile per state: standing, FPV hover, FPV flying (cine sticks), pilot view, then
  // stand again after the stow. The rAF recorder keeps dt only (no per-frame __drone.status()).
  const secs = Number(opt("--secs", "5"));
  const { pg } = await page();
  const { errors } = collect(pg);
  const cdp = await pg.context().newCDPSession(pg);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 250 });
  await pg.evaluate(async () => { await window.__droneHud.load(); return true; });
  await pg.evaluate(() => {
    if (window.__dlFt) return true;
    const F = { on: false, dts: [], last: 0 };
    const tick = (t) => { if (F.on && F.last) F.dts.push(t - F.last); F.last = t; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    window.__dlFt = { start() { F.dts = []; F.on = true; }, stop() { F.on = false; return F.dts; } };
    return true;
  });
  const stats = (dts) => {
    const s = [...dts].sort((a, b) => a - b); if (!s.length) return null;
    const mean = s.reduce((a, b) => a + b, 0) / s.length;
    return { frames: s.length, fps: +(1000 / mean).toFixed(1), p50Ms: +s[Math.floor(s.length / 2)].toFixed(1), p95Ms: +s[Math.floor(s.length * 0.95)].toFixed(1), maxMs: +s[s.length - 1].toFixed(1), over50: s.filter((d) => d > 50).length };
  };
  const profile = async (label) => {
    await pg.evaluate(() => window.__dlFt.start());
    await cdp.send("Profiler.start");
    await sleep(secs * 1000);
    const { profile: p } = await cdp.send("Profiler.stop");
    const ft = stats(await pg.evaluate(() => window.__dlFt.stop()));
    // self time per function and per file from the sample counts
    const byId = new Map(p.nodes.map((n) => [n.id, n]));
    const total = p.samples.length || 1;
    const selfFn = new Map(), selfFile = new Map();
    for (const n of p.nodes) {
      const cf = n.callFrame; const file = (cf.url || "(native)").split("/").slice(-2).join("/").replace(/\?.*$/, "");
      const fk = `${cf.functionName || "(anon)"} @ ${file}:${cf.lineNumber + 1}`;
      selfFn.set(fk, (selfFn.get(fk) || 0) + (n.hitCount || 0));
      selfFile.set(file, (selfFile.get(file) || 0) + (n.hitCount || 0));
    }
    const top = (m, k) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([name, c]) => `${(100 * c / total).toFixed(1)}% ${name}`);
    const r = { label, ft, topFiles: top(selfFile, 14), topFns: top(selfFn, 22) };
    writeFileSync(join(HERE, `perf-${label}.json`), JSON.stringify({ ...r, rawNodes: p.nodes.length }, null, 1));
    log(label, JSON.stringify(ft));
    for (const l of r.topFiles) log("   file", l);
    for (const l of r.topFns.slice(0, 14)) log("   fn  ", l);
    void byId;
    return r;
  };
  await profile("standing");
  await pg.evaluate(() => window.__drone.deploy({ quick: true }));
  await waitFor(pg, () => ({ ok: window.__drone.status().state === "flying" }), null, { timeoutMs: 20000, everyMs: 100, label: "flying" });
  await sleep(500);
  await profile("fpv-hover");
  await pg.evaluate((ms) => window.__drone.debug.setSticks({ pitch: 0.5, yaw: 0.25 }, ms), secs * 1000 + 500);
  await profile("fpv-flying");
  await pg.evaluate(() => window.__drone.pilotView(true)); await sleep(500);
  await profile("pilot-view");
  await pg.evaluate(() => window.__drone.pilotView(false)); await sleep(300);
  await pg.evaluate(() => window.__drone.recall({ instant: true }));
  await waitFor(pg, () => ({ ok: window.__drone.status().state === "idle" }), null, { timeoutMs: 60000, everyMs: 200, label: "idle" }).catch(() => {});
  await sleep(1000);
  await profile("standing-after");
  log("errors:", errors.length, JSON.stringify(errors.slice(0, 5)));
  process.exit(0);
}

if (cmd === "cold") {
  // First deploy of a fresh page (E7 "no first-deploy frame over 50 ms"): long-animation-frame entries with their
  // script attribution + a CDP CPU profile from the click to 3 s of flight. --noload: deploy straight through the
  // launcher path (the drone module is imported by the click), else __droneHud.load() runs first.
  const { pg } = await page();
  const { errors } = collect(pg);
  const cdp = await pg.context().newCDPSession(pg);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 250 });
  await pg.evaluate(() => {
    window.__dlLoaf = [];
    try {
      new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__dlLoaf.push({ start: e.startTime, dur: e.duration, block: e.blockingDuration,
        render: e.renderStart ? e.startTime + e.duration - e.renderStart : 0,
        scripts: (e.scripts || []).map((s) => ({ dur: Math.round(s.duration), inv: s.invoker, fn: s.sourceFunctionName, url: (s.sourceURL || "").split("/").slice(-2).join("/"), pos: s.sourceCharPosition })) }); })
        .observe({ type: "long-animation-frame", buffered: false });
    } catch (e) { window.__dlLoaf.push({ error: String(e) }); }
    return true;
  });
  const prewarm = await pg.evaluate(() => ({ sceneReady: window.__sceneReadyEverFired === true, hud: !!window.__droneHud }));
  log("prewarm state", JSON.stringify(prewarm));
  if (!has("--noload")) await pg.evaluate(async () => { await window.__droneHud.load(); return true; });
  const t0 = await pg.evaluate(() => performance.now());
  await cdp.send("Profiler.start");
  if (has("--noload")) await pg.evaluate(() => window.__toggleDroneHud()); else await pg.evaluate(() => window.__drone.deploy({ quick: false }));
  await waitFor(pg, () => ({ ok: window.__drone?.status?.().state === "flying" }), null, { timeoutMs: 30000, everyMs: 100, label: "flying" });
  await sleep(3000);
  const { profile: p } = await cdp.send("Profiler.stop");
  const loaf = await pg.evaluate((t0) => window.__dlLoaf.filter((e) => e.start >= t0 - 50), t0);
  const total = p.samples.length || 1;
  const selfFn = new Map();
  for (const n of p.nodes) {
    const cf = n.callFrame; const file = (cf.url || "(native)").split("/").slice(-2).join("/").replace(/\?.*$/, "");
    const fk = `${cf.functionName || "(anon)"} @ ${file}:${cf.lineNumber + 1}`;
    selfFn.set(fk, (selfFn.get(fk) || 0) + (n.hitCount || 0));
  }
  const topFns = [...selfFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, c]) => `${(100 * c / total).toFixed(1)}% ${k}`);
  const big = loaf.filter((e) => e.dur > 50).sort((a, b) => b.dur - a.dur);
  writeFileSync(join(HERE, "cold-deploy.json"), JSON.stringify({ prewarm, loaf, topFns, t0 }, null, 1));
  writeFileSync("/mnt/wbterminal2/drone-fix/cold-profile.cpuprofile", JSON.stringify(p));   // raw profile (large; scratch drive)
  log("long animation frames > 50 ms:", big.length, "max", big[0] ? Math.round(big[0].dur) : 0, "ms");
  for (const e of big.slice(0, 12)) log(`  +${Math.round(e.start - t0)}ms dur ${Math.round(e.dur)} render ${Math.round(e.render)} ::`, JSON.stringify(e.scripts.filter((s) => s.dur > 5).slice(0, 4)));
  for (const l of topFns.slice(0, 18)) log("   fn", l);
  await pg.evaluate(() => window.__drone.recall({ instant: true }));
  await waitFor(pg, () => ({ ok: window.__drone.status().state === "idle" }), null, { timeoutMs: 60000, everyMs: 200, label: "idle" }).catch(() => {});
  log("errors:", errors.length);
  process.exit(0);
}

if (cmd === "record") {
  // A full drone cycle recorded as a video: CDP Page.startScreencast (the whole page: HUD + OSD), JPEG frames at
  // --width (default 1280), then ffmpeg (concat demuxer with each frame's real duration) → H.264 mp4.
  //   capped-wireagent node drone-live.mjs record --out <file.mp4> [--width 1280] [--quick]
  const out = opt("--out", join(HERE, "drone-cycle.mp4"));
  const width = Number(opt("--width", "1280"));
  const quick = has("--quick");
  const dir = join("/mnt/wbterminal2/drone-fix/rec", String(Date.now()));
  mkdirSync(dir, { recursive: true });
  const { pg } = await page();
  const { errors } = collect(pg);
  const cdp = await pg.context().newCDPSession(pg);
  const frames = [];
  cdp.on("Page.screencastFrame", async (f) => {
    const name = `f${String(frames.length).padStart(5, "0")}.jpg`;
    writeFileSync(join(dir, name), Buffer.from(f.data, "base64"));
    frames.push({ name, ts: f.metadata?.timestamp ?? 0 });
    try { await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }); } catch (_) {}
  });
  await pg.evaluate(async () => { await window.__droneHud.load(); return true; });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 82, maxWidth: width, maxHeight: Math.round(width * 9 / 16) + 40, everyNthFrame: 1 });
  const S = (fn, a) => pg.evaluate(fn, a);
  const until = (s, ms) => waitFor(pg, (st) => ({ ok: window.__drone.status().state === st }), s, { timeoutMs: ms, everyMs: 100, label: s });
  await sleep(1500);
  await S((q) => window.__drone.deploy({ quick: q }), quick);
  await until("flying", 20000);
  await sleep(1500);
  await S(() => window.__drone.debug.setSticks({ throttle: 0.7, pitch: -0.5 }, 3000)); await sleep(3300);   // climb back from the pilot
  await S(() => window.__drone.debug.setSticks({ yaw: 1 }, 2000)); await sleep(2300);                      // turn round
  await S(() => window.__drone.debug.setSticks({ pitch: 0.8, throttle: 0.3 }, 4000)); await sleep(4300);   // fly out
  await S(() => window.__drone.debug.setSticks({ yaw: -1, pitch: 0.4 }, 2000)); await sleep(2300);         // bank round
  await S(() => window.__drone.debug.setSticks({ yaw: 1 }, 2000)); await sleep(2300);
  await S(() => window.__drone.pilotView(true)); await sleep(2500);
  await S(() => window.__drone.pilotView(false)); await sleep(1500);
  await S(() => window.__drone.recall());
  await until("idle", 90000).catch(() => {});
  await sleep(1500);
  await cdp.send("Page.stopScreencast");
  await sleep(500);
  // concat list with real per-frame durations (last frame 0.1 s)
  const lines = [];
  for (let i = 0; i < frames.length; i += 1) {
    const d = i + 1 < frames.length ? Math.max(0.005, frames[i + 1].ts - frames[i].ts) : 0.1;
    lines.push(`file '${join(dir, frames[i].name)}'`, `duration ${d.toFixed(4)}`);
  }
  lines.push(`file '${join(dir, frames[frames.length - 1].name)}'`);
  writeFileSync(join(dir, "list.txt"), lines.join("\n") + "\n");
  const dur = frames.length > 1 ? frames[frames.length - 1].ts - frames[0].ts : 0;
  log(`frames ${frames.length} over ${dur.toFixed(1)} s (${(frames.length / Math.max(dur, 0.001)).toFixed(1)} fps); encoding`);
  execFileSync("/home/wbterminal/bin/ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(dir, "list.txt"),
    "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=30", "-c:v", "libx264", "-preset", "medium", "-crf", "22", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out], { stdio: "inherit", timeout: 600000 });
  log("wrote", out, "errors:", errors.length);
  process.exit(0);
}

console.log("usage: drone-live.mjs launch|boot|smoke|tour|eye|perf|cold|record|eval <file>|shot <name>|logout|kill");
process.exit(1);
