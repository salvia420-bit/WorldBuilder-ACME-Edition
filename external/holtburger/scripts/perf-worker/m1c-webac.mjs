// m1c-webac.mjs — M1c-WEBAC, the W arm (2026-10-30, round 3 R3-1 / M1c): WebAC (jakemmarsh/webac, its
// Vite dev server on this laptop) on the 1070, parked at 0xA9B40001 (96, 96, 80) yaw 0, its IDLE phase
// measured the way WebAC's own tools/measure-perf.ts measures it, but over raw CDP: playwright-core's
// connectOverCDP (and so `measure-perf.ts --attach`) hangs on the box's Chrome 156 (lib/cdp_raw.mjs).
// One rep per invocation; our H arms (hbbench.mjs --item M1c-WEBAC) run between reps.
//
//   node scripts/perf-worker/m1c-webac.mjs --rep N --out DIR [--url-base http://127.0.0.1:3000]
//        [--bridge ws://127.0.0.1:9090] [--secs 20] [--dry-run] [--capped] [--no-box-samples]
//        [--no-seed-draw-distance] [--no-cooldown] [--load-timeout 1800] [--settle-cap 120]
//   node scripts/perf-worker/m1c-webac.mjs --predict-hour DIR/W-rN.json [--at ISO]
//        (no box: ACE's in-game hour at another time, from a W rep's reading; for the rep whose H arm
//        runs BEFORE its W arm)
// Credentials: M1C_ACCOUNT / M1C_PASSWORD from the environment at run time; unset = the bench's own
// account (lib/hb_v2.mjs benchUrlBase's defaults, read at run time, never copied into a file). Every
// log line and the run JSON carry the URL with `password=***`.
//
// Sources: apps/holtburger-web/docs/reengineering/queue-1070/batch-R3-M1-2026-10-30.json item M1c-WEBAC
// (recipe steps 0-12, protocolExceptions); docs/2026-10-29-webac-openac-renderer-lessons.md §5.1 (the
// DAT-iteration shim, the URL, parking, the caveats); /mnt/wbterminal1/ac-refs/webac
// tools/measure-perf.ts + tools/perf-ratchet-lib.ts (the idle measurement and its statistics, ported
// below with the same page expressions, the same order and the same rounding).
//
// Steps of one rep (`--dry-run` prints them and touches nothing):
//   preflight      laptop: vite answers (and serves the three DATs), WebAC's bridge /healthz answers,
//                  ACE holds UDP :9000, the -L 9333 forward is up and NO Chrome answers on it yet, the
//                  rep's W JSON does not exist. Refuses (exit 2) with the recipe's exact start commands.
//   account        ACE's log says the account is out of the world, then >= 65 s since its last logout.
//   box.check      one ssh: no Chrome on C:\Temp\hbm1c-webac is running (a dedicated W profile since 2026-10-30, never the owner's MODE P cdpwb-wls;
//                  session: never killed from here), and the box reaches vite + bridge through -R.
//   box.launcher   writes D:\Temp\hbbench\m1c-webac-launch.bat (hbgate first; muted; off-screen at
//                  -32000,-32000, never minimized; 1920,1080; the PERSISTENT profile; uncapped like H).
//   launch         kill-on-signal armed, then hb_box launchChrome through task hbm1cwebac + hidden-run.vbs.
//   cdp/window     raw CDP to the one about:blank tab (+ the browser endpoint for Browser.*), INNER
//                  1920x1080 by lib/hb_session.mjs sizeWindow (the H arms' own sizing, emulation fallback).
//   renderer       UNMASKED_RENDERER on the blank tab must name the GTX 1070 and D3D11, before any login.
//   shim           Page.addScriptToEvaluateOnNewDocument: the lessons doc's DAT-iteration shim verbatim
//                  (portal 2074 / cell 982 / language 994), and measure-perf's draw-distance seed (8).
//   navigate       http://127.0.0.1:3000/?ace&bridge=...&account=...&password=...&degmul=1 (never ?nocache).
//   load           first-load DAT stream into OPFS (~1.27 GB on a cold profile), progress every 30 s;
//                  gate: acDebug.collisionState().x > 0 AND window.__ac.sceneManager.
//   streams        measure-perf's 10 s "letting object streams settle".
//   park           @teleloc 0xA9B40001 96 96 80 (skipped within 10 m, measure-perf's same-spot rule),
//                  landed check, acDebug.setPlayerYaw(0).
//   settle         scene mesh count stable to 1 % over 4 polls (measure-perf waitForSceneSettle).
//   sky            ACE's in-game hour from acDebug.timeOfDay() (null + why when not server-synced).
//   measure        measure-perf's idle phase: renderer, draw distance, location, render timer,
//                  frameStats start, yaw 0, drain, rAF + renderer.info every frame for --secs, means
//                  over 30-degree heading sectors, renderJs p50/p95, census.
//   write          <out>/W-r<N>.json: measure-perf's JSON shape (hbreport.py m1c reads phases[idle].avgFps,
//                  render.idle.drawCalls, renderJs.idle.p50Ms, viewport, renderSampling) + raw samples,
//                  drawDistance, degmul and an `m1c` block (profile, window, sky, park, settle, box ...).
//   teardown       about:blank (WebAC's unload closes the ACE session), close the tab, kill ONLY the
//                  WebAC Chrome by its user-data-dir (roots must be muted + off-screen + CDP 9333), check
//                  that CDP :9333 no longer answers, wait for ACE's [LOGOUT] + the 65 s gap, so the H arm
//                  can log in next.
// Exit: 0 ok, 1 run failure (<out>/W-r<N>.failed.json), 2 refused / usage, 3 wrong adapter, 4 CDP :9333
// still answers after the kill (do NOT start the H arm).
//
// 1070 rules: off-screen + muted, never on the owner's screen, never their Chrome, one real-world tab
// (the WebAC tab never runs next to one of ours), never kill by image name. Nothing runs at import.
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import net from "node:net";
import { CDP, ACE_LOG, ssh, sshRetry, launchChrome, killChromeByProfile, chromeProfilePattern, profileKillScript, parseKillLine, boxSample, armKillOnSignal } from "./lib/hb_box.mjs";
import { boxSampleScript, encodePowerShell, benchUrlBase, urlParams, parseWindow, frameStats, DAY_GROUP_DAT_NAMES } from "./lib/hb_v2.mjs";
import { waitAccountFree, sizeWindow } from "./lib/hb_session.mjs";

export const ITEM = "M1c-WEBAC";
export const SCHEMA = "m1c-webac-w-v1";
/** The WebAC profile: FIXED and PERSISTENT (its OPFS holds the ~1.27 GB DAT cache), unlike our fresh-profile arms. */
export const PROFILE = "C:\\Temp\\hbm1c-webac";
export const LAUNCHER = "D:\\Temp\\hbbench\\m1c-webac-launch.bat";
export const TASK = "hbm1cwebac";
/** A kill ROOT must carry all of these (the owner's MODE P Chrome on the same profile carries none of the last two). */
export const ROOT_FLAGS = Object.freeze(["--remote-debugging-port=9333", "--mute-audio", "--window-position=-32000,-32000"]);
export const TELELOC = "@teleloc 0xA9B40001 96 96 80";
/** The park spot in WebAC's world plane (x = east, north = AC y = collisionState().z): landblock * 192 + local. */
export const SPOT_WORLD = Object.freeze({ x: 0xa9 * 192 + 96, north: 0xb4 * 192 + 96 });
export const DAT_FILES = Object.freeze(["client_portal.dat", "client_cell_1.dat", "client_local_English.dat"]);
export const WEBAC_DIR = "/mnt/wbterminal1/ac-refs/webac";
export const QUEUE_PATH = fileURLToPath(new URL("../../apps/holtburger-web/docs/reengineering/queue-1070/batch-R3-M1-2026-10-30.json", import.meta.url));
export const LESSONS_PATH = fileURLToPath(new URL("../../apps/holtburger-web/docs/2026-10-29-webac-openac-renderer-lessons.md", import.meta.url));
/** WebAC's retail-default Landscape Draw Distance (packages/renderer/src/world/LandscapeDrawDistance.ts SHIPPED_DEFAULT). */
export const SHIPPED_DEFAULT_LANDSCAPE_DRAW_DISTANCE = 8;

export const DEFAULTS = Object.freeze({
  urlBase: "http://127.0.0.1:3000", bridge: "ws://127.0.0.1:9090", secs: 20, window: "1920,1080", degmul: 1,
  drawDistance: 8, loadTimeoutS: 1800, settleCapS: 120, nearSkipM: 10, landTolM: 5, cooldownS: 65, acePort: 9000,
  accountWaitS: 150, boxSampleMs: 2000,
});

/**
 * The DAT-iteration shim, VERBATIM from the lessons doc §5.1 step 6 (tests/m1c_webac.test.mjs compares
 * it with the doc). ACE has DAT patching off and terminates a client that reports older iterations; the
 * base DATs report portal 2072.
 */
export const DAT_SHIM = "(()=>{let c=null;const F={portal:2074,cell:982,language:994};Object.defineProperty(window,'__aceConnection',{configurable:true,get(){return c},set(v){c=v;if(!v)return;let o=v,d;while(o&&!(d=Object.getOwnPropertyDescriptor(o,'datIterations')))o=Object.getPrototypeOf(o);if(d&&d.set){Object.defineProperty(v,'datIterations',{configurable:true,get:()=>d.get.call(v),set:x=>d.set.call(v,{...x,...F})})}else{let val=v.datIterations;Object.defineProperty(v,'datIterations',{configurable:true,get:()=>val,set:x=>{val={...x,...F}}})}}})})()";

/** measure-perf's `--draw-distance` seed (its addInitScript body), only on the WebAC origin. */
export function drawDistanceSeed(origin, dd = DEFAULTS.drawDistance) {
  return `(() => { try { if (location.origin !== ${JSON.stringify(origin)}) return; const dd = ${Number(dd)}; const key = 'ac_options_settings_v1'; let cur = {}; try { cur = JSON.parse(localStorage.getItem(key) ?? '{}'); } catch { } localStorage.setItem(key, JSON.stringify({ ...cur, landscapeDrawDistance: dd })); } catch (e) { } })()`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errText = (e) => String((e && e.message) || e).slice(0, 300);

// ------------------------------------------------------------------------------------------------
// Arguments, credentials, URL, redaction
// ------------------------------------------------------------------------------------------------

export const USAGE = "usage: node scripts/perf-worker/m1c-webac.mjs --rep N --out DIR [--url-base http://127.0.0.1:3000] [--bridge ws://127.0.0.1:9090] [--secs 20] [--dry-run] [--capped] [--no-box-samples] [--no-seed-draw-distance] [--no-cooldown] [--load-timeout S] [--settle-cap S]\n       node scripts/perf-worker/m1c-webac.mjs --predict-hour W-rN.json [--at ISO]\n  env: M1C_ACCOUNT / M1C_PASSWORD (unset = the bench account)";

const VALUE_FLAGS = new Set(["--rep", "--out", "--url-base", "--bridge", "--secs", "--load-timeout", "--settle-cap", "--predict-hour", "--at"]);
const BOOL_FLAGS = new Set(["--dry-run", "--capped", "--no-box-samples", "--no-seed-draw-distance", "--no-cooldown", "--help"]);

/** CLI options (pure). Throws on anything unknown or malformed, before anything runs. */
export function parseArgs(argv) {
  const v = {}, b = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.has(a)) {
      const x = argv[i + 1];
      if (x === undefined || x.startsWith("--")) throw new Error(`${a} needs a value`);
      v[a] = x; i++;
    } else if (BOOL_FLAGS.has(a)) b.add(a);
    else throw new Error(`unknown argument ${JSON.stringify(a)}`);
  }
  if (b.has("--help")) return { help: true };
  if (v["--predict-hour"] !== undefined) return { predictHour: v["--predict-hour"], at: v["--at"] ?? null };
  if (v["--rep"] === undefined) throw new Error("--rep N is required");
  if (!/^[1-9]\d?$/.test(v["--rep"])) throw new Error(`--rep must be an integer 1..99 (got ${v["--rep"]})`);
  if (v["--out"] === undefined) throw new Error("--out DIR is required");
  const num = (k, d, lo, hi) => {
    if (v[k] === undefined) return d;
    const n = Number(v[k]);
    if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${k} must be a number in ${lo}..${hi} (got ${v[k]})`);
    return n;
  };
  const urlBase = String(v["--url-base"] ?? DEFAULTS.urlBase).replace(/\/+$/, "");
  if (!/^https?:\/\/[^/?#\s]+$/.test(urlBase)) throw new Error(`--url-base must be http(s)://host:port with no path or query (got ${urlBase})`);
  const bridge = String(v["--bridge"] ?? DEFAULTS.bridge);
  if (!/^wss?:\/\/[^/?#\s&]+\/?$/.test(bridge)) throw new Error(`--bridge must be ws(s)://host:port (got ${bridge})`);
  return {
    rep: Number(v["--rep"]), out: resolve(v["--out"]), urlBase, bridge, secs: num("--secs", DEFAULTS.secs, 1, 600),
    dryRun: b.has("--dry-run"), uncapped: !b.has("--capped"), boxSamples: !b.has("--no-box-samples"),
    seedDrawDistance: !b.has("--no-seed-draw-distance"), cooldown: !b.has("--no-cooldown"),
    loadTimeoutS: num("--load-timeout", DEFAULTS.loadTimeoutS, 60, 7200), settleCapS: num("--settle-cap", DEFAULTS.settleCapS, 10, 600),
    cdp: CDP, window: DEFAULTS.window, degmul: DEFAULTS.degmul, drawDistance: DEFAULTS.drawDistance, acePort: DEFAULTS.acePort,
  };
}

/** The bench's own default login, read from lib/hb_v2.mjs at run time (single source; never copied here). */
export function benchDefaults() {
  const p = urlParams(benchUrlBase("http://127.0.0.1/", {}, {}));
  return { account: p.get("account"), password: p.get("password") };
}

/** Credentials from the environment (M1C_ACCOUNT / M1C_PASSWORD); unset = the bench account. */
export function credentials(env = process.env) {
  const bench = benchDefaults();
  const account = env.M1C_ACCOUNT || bench.account;
  let password = env.M1C_PASSWORD || null;
  let source = env.M1C_PASSWORD ? "env M1C_PASSWORD" : null;
  if (!password) {
    if (account !== bench.account) throw new Error(`M1C_PASSWORD is required for M1C_ACCOUNT=${account} (only the bench account has a default)`);
    password = bench.password;
    source = "bench default (lib/hb_v2.mjs benchUrlBase)";
  }
  if (!/^[A-Za-z0-9_.+-]{1,64}$/.test(account)) throw new Error("M1C_ACCOUNT: letters, digits and _ . + - only");
  return { account, password, accountSource: env.M1C_ACCOUNT ? "env M1C_ACCOUNT" : "bench default", passwordSource: source };
}

/** The WebAC URL of the recipe (lessons doc §5.1 step 7): ?ace&bridge=…&account=…&password=…&degmul=1. */
export function buildWebacUrl({ urlBase = DEFAULTS.urlBase, bridge = DEFAULTS.bridge, account, password, degmul = DEFAULTS.degmul }) {
  if (!account || !password) throw new Error("buildWebacUrl: account and password are required");
  if (/[?&#]nocache\b/.test(urlBase)) throw new Error("never ?nocache (it re-downloads 1.27 GB of DATs)");
  return `${String(urlBase).replace(/\/+$/, "")}/?ace&bridge=${bridge}&account=${encodeURIComponent(account)}&password=${encodeURIComponent(password)}&degmul=${degmul}`;
}

/** Password-free text for logs and files: `password=***`, plus the literal (and URI-encoded) password. */
export function redact(text, { password = null, account = null } = {}) {
  let s = String(text).replace(/(password=)[^&#\s"']*/gi, "$1***");
  if (password && String(password).length >= 3 && password !== account) {
    for (const p of new Set([String(password), encodeURIComponent(String(password))])) s = s.split(p).join("***");
  }
  return s;
}

/** ws(s)://host:port -> http(s)://host:port/healthz (WebAC's bridge answers /healthz on its WS port). */
export function bridgeHealthUrl(bridge) {
  const u = new URL(String(bridge));
  return `${u.protocol === "wss:" ? "https:" : "http:"}//${u.host}/healthz`;
}

// ------------------------------------------------------------------------------------------------
// The recipe's start commands (read from the queue file, so a refusal prints the recipe exactly)
// ------------------------------------------------------------------------------------------------

/** Laptop setup + start commands of the M1c-WEBAC recipe, verbatim from the queue item. */
export function recipeStartCommands(queueJson) {
  const item = (queueJson && Array.isArray(queueJson.items) ? queueJson.items : []).find((i) => i.id === ITEM);
  const r = (item && item.recipe) || [];
  const pick = (re) => r.find((s) => re.test(s));
  const out = [];
  const npm = pick(/npm install/);
  const dat = pick(/^mkdir dat && ln -s/);
  const bridge = pick(/bridge\.ts 9090/);
  const vite = pick(/npx vite --host/);
  const tunnel = pick(/^Tunnel: add -R 3000/);
  if (npm) out.push(npm);
  if (dat) out.push(`cd ${WEBAC_DIR} && ${dat}`);
  if (bridge) out.push(`cd ${WEBAC_DIR} && ${bridge.replace(/^[^:]*?\):\s*|^Bridge[^:]*:\s*/, "")}`);
  if (vite) out.push(`cd ${WEBAC_DIR} && ${vite.replace(/^Dev server:\s*/, "")}`);
  if (tunnel) out.push(tunnel);
  return out;
}

/** The queue file's start commands, or a pointer to them when the file cannot be read. */
export function startCommands(readText = (p) => readFileSync(p, "utf8")) {
  try { const c = recipeStartCommands(JSON.parse(readText(QUEUE_PATH))); if (c.length) return c; } catch (_) { /* fall through */ }
  return [`(see the M1c-WEBAC recipe in ${QUEUE_PATH})`];
}

// ------------------------------------------------------------------------------------------------
// Box side: launcher, box check, box sample (the scripts are pure text; the suite pins them)
// ------------------------------------------------------------------------------------------------

/** Chrome switches of the W launch: hbprobe-launch.bat's MODE T set with the persistent profile. */
export function chromeArgs({ profile = PROFILE, window = DEFAULTS.window, uncapped = true } = {}) {
  const { w, h } = parseWindow(window);
  chromeProfilePattern(profile); // validates the path
  return ["--remote-debugging-port=9333", "--use-angle=d3d11", "--ignore-gpu-blocklist", "--mute-audio", `--user-data-dir=${profile}`,
    "--window-position=-32000,-32000", `--window-size=${w},${h}`, "--no-first-run", "--no-default-browser-check",
    "--disable-features=CalculateNativeWinOcclusion", "--disable-renderer-backgrounding", "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows", ...(uncapped ? ["--disable-frame-rate-limit", "--disable-gpu-vsync"] : [])];
}

/** D:\Temp\hbbench\m1c-webac-launch.bat (CRLF). hbgate.ps1 first (the owner rule), noflash.ps1 after. */
export function launcherBat(o = {}) {
  const profile = o.profile || PROFILE;
  return [
    "@echo off",
    "rem m1c-webac-launch.bat - written by scripts/perf-worker/m1c-webac.mjs before every M1c W rep; edit the .mjs, not this file.",
    "rem MODE T: off-screen at -32000,-32000 and never minimized, muted, CDP 9333, and the PERSISTENT WebAC profile",
    `rem ${profile} whose OPFS keeps the 1.27 GB DAT cache between reps. Owner gate first, as in hbprobe-launch.bat.`,
    "powershell -NoProfile -ExecutionPolicy Bypass -File D:\\Temp\\hbbench\\hbgate.ps1",
    "if errorlevel 1 exit /b 1",
    `start "" "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" ${chromeArgs({ ...o, profile }).join(" ")} about:blank`,
    "start \"\" /b powershell -NoProfile -ExecutionPolicy Bypass -File D:\\Temp\\hbbench\\noflash.ps1 -Seconds 3600",
  ].join("\r\n") + "\r\n";
}

/** PowerShell that writes the launcher bytes exactly (base64, no quoting games) and reports its size. */
export function launcherWriteScript(batText, path = LAUNCHER) {
  const b64 = Buffer.from(batText, "ascii").toString("base64");
  return [
    "$ErrorActionPreference = 'Stop'",
    `[IO.File]::WriteAllBytes('${path}', [Convert]::FromBase64String('${b64}'))`,
    `"M1CBAT bytes=$((Get-Item '${path}').Length)"`,
  ].join("\n");
}

/** The box check (one ssh): the profile-kill selection in dry-run mode + whether the box reaches vite and the bridge. */
export function boxCheckScript({ urlBase = DEFAULTS.urlBase, bridge = DEFAULTS.bridge } = {}) {
  const iwr = (name, u) => `try { $${name} = [int](Invoke-WebRequest -UseBasicParsing -TimeoutSec 15 -Uri '${u}').StatusCode } catch { $${name} = 0; try { $${name} = [int]$_.Exception.Response.StatusCode } catch { } }`;
  return [
    profileKillScript(PROFILE, { dryRun: true }),
    "$ProgressPreference = 'SilentlyContinue'",
    iwr("vite", `${urlBase}/`),
    iwr("bridge", bridgeHealthUrl(bridge)),
    "\"M1CNET vite=$vite bridge=$bridge\"",
  ].join("\n");
}

/** `M1CNET vite=200 bridge=200` -> numbers. */
export function parseNetLine(stdout) {
  const line = String(stdout || "").split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith("M1CNET "));
  if (!line) return null;
  const o = {};
  for (const t of line.slice(7).split(/\s+/)) { const [k, v] = t.split("="); o[k] = Number(v); }
  return o;
}

/**
 * The per-segment box sample with the W Chrome marked as OURS (boxSampleScript's roots rule swapped for
 * the hbm1c-webac profile). hbwho.ps1's own `browsers` / `gpu3d_other` still count it as theirs.
 */
export function wBoxSampleScript({ windowMs = DEFAULTS.boxSampleMs } = {}) {
  const base = boxSampleScript({ windowMs });
  const needle = "$_.CommandLine -like '*D:\\Temp\\hbbench\\*'";
  if (!base.includes(needle)) return { script: base, oursRule: "bench profiles only (boxSampleScript changed): the W Chrome reads as not ours" };
  const repl = `$_.CommandLine -match '${chromeProfilePattern(PROFILE)}'`;
  return { script: base.replace(needle, () => repl), oursRule: "the hbm1c-webac Chrome and its children" };
}

// ------------------------------------------------------------------------------------------------
// The measurement: measure-perf.ts's page expressions (same text, a /*m1c:tag*/ prefix added) and
// perf-ratchet-lib.ts's statistics, ported 1:1
// ------------------------------------------------------------------------------------------------

/** measure-perf rendererString (also the pre-navigation adapter check). */
export const PAGE_RENDERER = `/*m1c:renderer*/ (() => {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') ?? c.getContext('webgl');
    if (!gl) return 'no-webgl';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'masked';
  })()`;

/** Load / gate state: collisionState().x, __ac.sceneManager, the UI screen, OPFS bytes (progress). Never echoes the URL. */
export const PAGE_LOAD_STATE = `/*m1c:loadState*/ (async () => {
    const out = { x: null, loginComplete: null, sceneManager: false, screen: null, opfsBytes: null, readyState: document.readyState, visibility: document.visibilityState };
    try { const dbg = window.acDebug; const cs = dbg && dbg.collisionState ? dbg.collisionState() : null; if (cs) { out.x = cs.x; out.loginComplete = !!cs.loginComplete; } } catch (e) { out.csError = String(e && e.message || e).slice(0, 120); }
    try { out.sceneManager = !!(window.__ac && window.__ac.sceneManager); } catch (e) { }
    try { const ui = window.__ac && window.__ac.gameUI && window.__ac.gameUI.ui; out.screen = ui && ui.currentScreen ? String(ui.currentScreen) : null; } catch (e) { }
    try { if (navigator.storage && navigator.storage.estimate) { const e = await navigator.storage.estimate(); out.opfsBytes = typeof e.usage === 'number' ? e.usage : null; } } catch (e) { }
    return out;
  })()`;

/** measure-perf worldPos (+ loginComplete: ACE holds a teleporting player Hidden until LoginComplete). */
export const PAGE_WORLD_POS = `/*m1c:worldPos*/ (() => {
    const dbg = window.acDebug;
    const cs = dbg && dbg.collisionState ? dbg.collisionState() : null;
    return cs ? { x: cs.x, north: cs.z, loginComplete: !!cs.loginComplete } : null;
  })()`;

export const pageAdmin = (cmd) => `/*m1c:admin*/ (() => { const d = window.acDebug; if (!d || typeof d.admin !== 'function') return false; d.admin(${JSON.stringify(String(cmd))}); return true; })()`;

/** measure-perf setYaw. */
export const pageSetYaw = (yaw) => `/*m1c:setYaw*/ (() => {
    const dbg = window.acDebug;
    if (!dbg || typeof dbg.setPlayerYaw !== 'function') return false;
    dbg.setPlayerYaw(${Number(yaw)});
    return true;
  })()`;

/** measure-perf waitForSceneSettle countMeshes. */
export const PAGE_COUNT_MESHES = `/*m1c:countMeshes*/ (() => {
    const sm = window.__ac && window.__ac.sceneManager;
    if (!sm || !sm.scene) return -1;
    let n = 0;
    sm.scene.traverse((o) => { if (o.isMesh) n++; });
    return n;
  })()`;

/** acDebug.timeOfDay() + dayGroup() (main.ts acDebug: timeOfDay = skybox phase, gameClock = server PortalYearTicks or null). */
export const PAGE_SKY = `/*m1c:sky*/ (() => {
    const d = window.acDebug;
    const out = { timeOfDay: null, dayLengthSeconds: null, gameClock: null, sunBrightness: null, dayGroup: null, why: null };
    if (!d || typeof d.timeOfDay !== 'function') { out.why = 'acDebug.timeOfDay is not exposed'; return out; }
    try { const t = d.timeOfDay(); out.timeOfDay = t.timeOfDay; out.dayLengthSeconds = t.dayLengthSeconds; out.gameClock = t.gameClock ?? null; out.sunBrightness = t.sunBrightness ?? null; } catch (e) { out.why = 'acDebug.timeOfDay() threw: ' + String(e && e.message || e).slice(0, 120); }
    try { if (typeof d.dayGroup === 'function') { const g = d.dayGroup(); out.dayGroup = { name: g.name, index: g.index, absoluteDay: g.absoluteDay, pinned: g.pinned }; } } catch (e) { }
    return out;
  })()`;

/** measure-perf's landscapeDrawDistance read (localStorage) + the live loadRadius (window.__ac.landscapeDrawDistance). */
export const PAGE_DRAW_DISTANCE = `/*m1c:drawDistance*/ (() => {
    let stored = null;
    try { const v = JSON.parse(localStorage.getItem('ac_options_settings_v1') ?? '{}').landscapeDrawDistance; stored = typeof v === 'number' ? v : null; } catch { stored = null; }
    let live = null;
    try { const v = window.__ac && window.__ac.landscapeDrawDistance; live = typeof v === 'number' ? v : null; } catch (e) { }
    return { stored, live };
  })()`;

/** measure-perf playerLocation (raw collisionState; rounding + landblock in node, as there). */
export const PAGE_LOCATION = `/*m1c:location*/ (() => {
    const dbg = window.acDebug;
    const cs = dbg && dbg.collisionState ? dbg.collisionState() : null;
    return cs ? { x: cs.x, y: cs.y, z: cs.z } : null;
  })()`;

/** measure-perf installRenderTimer. */
export const PAGE_INSTALL_RENDER_TIMER = `/*m1c:installRenderTimer*/ (() => {
    const sm = window.__ac && window.__ac.sceneManager; const r = sm && sm.renderer;
    if (!r) return false;
    if (r.__perfPatched) return true;
    const orig = r.render.bind(r);
    window.__perfRenderMs = [];
    r.render = function (a, b) { const t = performance.now(); const out = orig(a, b); window.__perfRenderMs.push(performance.now() - t); return out; };
    r.__perfPatched = true;
    return true;
  })()`;

/** measure-perf drainRenderTimer's page half (the raw samples come back; stats in node, same quantiles). */
export const PAGE_DRAIN_RENDER_TIMER = `/*m1c:drainRenderTimer*/ (() => { const a = window.__perfRenderMs || []; window.__perfRenderMs = []; return a; })()`;

/** measure-perf renderInfo. */
export const PAGE_RENDER_INFO = `/*m1c:renderInfo*/ (() => {
    const ac = window.__ac;
    const info = ac && ac.sceneManager && ac.sceneManager.renderer && ac.sceneManager.renderer.info;
    if (!info) return null;
    const fs = window.acDebug && window.acDebug.frameStats ? window.acDebug.frameStats() : undefined;
    return {
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs ? info.programs.length : 0,
      frameStats: fs ? { frames: fs.frames, rawDtTotal: fs.rawDtTotal, droppedFrames: fs.droppedFrames } : undefined,
    };
  })()`;

/** measure-perf samplePhase: frame deltas + renderer.info and camera yaw every frame for `ms`. */
export const pageSamplePhase = (ms) => `/*m1c:samplePhase*/ new Promise((resolve) => {
    const deltas = [];
    const infoSamples = [];
    let last = -1;
    const start = performance.now();
    requestAnimationFrame(function tick(t) {
      if (last >= 0) deltas.push(t - last);
      last = t;
      const ac = window.__ac;
      const info = ac && ac.sceneManager && ac.sceneManager.renderer && ac.sceneManager.renderer.info;
      const cam = ac && ac.cameraController;
      if (info) infoSamples.push({
        atMs: Math.round(t - start),
        drawCalls: info.render.calls,
        triangles: info.render.triangles,
        geometries: info.memory.geometries,
        yaw: cam && typeof cam.yaw === 'number' ? cam.yaw : undefined,
      });
      if (t - start < ${Number(ms)}) requestAnimationFrame(tick);
      else resolve({ deltas, infoSamples });
    });
  })`;

/** measure-perf sceneCensus. */
export const PAGE_SCENE_CENSUS = `/*m1c:sceneCensus*/ (() => {
    const sm = window.__ac && window.__ac.sceneManager;
    if (!sm || !sm.scene || !sm.camera) return null;
    const cp = sm.camera.position; const v = cp.clone();
    const categories = {}; let meshes = 0, instanced = 0;
    sm.scene.traverse((o) => {
      if (!o.isMesh) return;
      meshes++; if (o.isInstancedMesh) instanced++;
      let n = o; while (n && !n.name) n = n.parent;
      const nm = ((n && n.name) || '?').replace(/[0-9a-fx]{6,}/g, '#').replace(/part_\\d+/, 'part');
      if (o.isInstancedMesh && o.boundingSphere) v.copy(o.boundingSphere.center);
      else o.getWorldPosition(v);
      const d = v.distanceTo(cp);
      const b = categories[nm] || (categories[nm] = { total: 0, beyond300: 0, beyond600: 0 });
      b.total++; if (d > 300) b.beyond300++; if (d > 600) b.beyond600++;
    });
    return { meshes, instanced, categories };
  })()`;

/** The real viewport and visibility (measure-perf's page.viewportSize() is null on an attached tab, so it wrote its 1568x775 constant). */
export const PAGE_VIEWPORT = `/*m1c:viewport*/ (() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, outerWidth, outerHeight, visibility: document.visibilityState, focus: document.hasFocus() }))()`;

/** measure-perf stats(). */
export function phaseStats(phase, deltas) {
  const sorted = [...deltas].sort((a, b) => a - b);
  const total = deltas.reduce((s, d) => s + d, 0);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return {
    phase,
    durationMs: Math.round(total),
    frames: deltas.length,
    avgFps: Math.round((deltas.length / total) * 1000 * 10) / 10,
    p50Ms: Math.round(q(0.5) * 100) / 100,
    p95Ms: Math.round(q(0.95) * 100) / 100,
    p99Ms: Math.round(q(0.99) * 100) / 100,
    maxMs: Math.round(sorted[sorted.length - 1] * 100) / 100,
    longFramePct: Math.round((deltas.filter((d) => d > 33.34).length / deltas.length) * 1000) / 10,
    hitch50: deltas.filter((d) => d > 50).length,
    hitch100: deltas.filter((d) => d > 100).length,
  };
}

/** measure-perf drainRenderTimer's statistics. */
export function renderJsStats(samples) {
  if (!samples || !samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return { frames: samples.length, p50Ms: Math.round(q(0.5) * 100) / 100, p95Ms: Math.round(q(0.95) * 100) / 100 };
}

/** perf-ratchet-lib HEADING_BINS / headingBin. */
export const HEADING_BINS = 12;
export function headingBin(yaw) {
  const turn = 2 * Math.PI;
  const norm = ((yaw % turn) + turn) % turn;
  return Math.min(HEADING_BINS - 1, Math.floor((norm / turn) * HEADING_BINS));
}

/** perf-ratchet-lib summarizeInfoSamples: the phase mean over 30-degree heading sectors (plain mean without yaw). */
export function summarizeInfoSamples(samples) {
  if (!samples.length) return null;
  const metrics = ["drawCalls", "triangles", "geometries"];
  const out = { sampleCount: samples.length, spread: {} };
  const binned = samples.every((s) => typeof s.yaw === "number" && Number.isFinite(s.yaw));
  const groups = [];
  if (binned) {
    const bins = new Map();
    for (const smp of samples) {
      const b = headingBin(smp.yaw);
      let g = bins.get(b);
      if (!g) bins.set(b, (g = []));
      g.push(smp);
    }
    groups.push(...bins.values());
  } else {
    groups.push(samples);
  }
  out.headingBins = binned ? groups.length : undefined;
  for (const m of metrics) {
    const vals = samples.map((s) => s[m]);
    const binMeans = groups.map((g) => g.reduce((a, s) => a + s[m], 0) / g.length);
    out[m] = Math.round(binMeans.reduce((a, b) => a + b, 0) / binMeans.length);
    out.spread[m] = { min: vals.reduce((a, x) => Math.min(a, x), Infinity), max: vals.reduce((a, x) => Math.max(a, x), -Infinity) };
  }
  return out;
}

/** perf-ratchet-lib estimateRealGpu (REAL_GPU_US_PER_DRAW_CALL = 8.5). */
export function estimateRealGpu(drawCalls) {
  const frameMs = (drawCalls * 8.5) / 1000;
  return { frameMs: Math.round(frameMs * 10) / 10, fps: frameMs > 0 ? Math.round((1000 / frameMs) * 10) / 10 : Infinity };
}

/** perf-ratchet-lib droppedFrameWarnings. */
export function droppedFrameWarnings(start, snapshots) {
  const warnings = [];
  let prev = start ?? { frames: 0, rawDtTotal: 0, droppedFrames: 0 };
  for (const s of snapshots) {
    const fs = s.frameStats;
    if (!fs) continue;
    const frames = fs.frames - prev.frames;
    const dropped = fs.droppedFrames - prev.droppedFrames;
    prev = fs;
    if (frames > 0 && dropped >= frames) {
      warnings.push(`${s.phase}: all ${frames} frames dropped their physics substeps (dt > HugeQuantum) — camera input never applied, so this phase measured a static scene; its numbers are not trustworthy`);
    }
  }
  return warnings;
}

/** perf-ratchet-lib landblockOf. */
export function landblockOf(x, y) {
  const lbx = Math.max(0, Math.min(0xff, Math.floor(x / 192)));
  const lby = Math.max(0, Math.min(0xff, Math.floor(y / 192)));
  return `0x${(((((lbx << 8) | lby) << 16) | 0xffff) >>> 0).toString(16).padStart(8, "0")}`;
}

/** measure-perf playerLocation's node half (collisionState is Y-up: z = AC north, y = height). */
export function locationOf(cs) {
  if (!cs) return null;
  const r = (n) => Math.round(n * 10) / 10;
  return { x: r(cs.x), y: r(cs.z), z: r(cs.y), landblock: landblockOf(cs.x, cs.z) };
}

/** measure-perf mergeInfo: per-frame scene costs from the phase mean, memory counters from the point read. */
export function mergeInfo(point, mean) {
  if (!point) return null;
  if (!mean) return point;
  return { ...point, drawCalls: mean.drawCalls, triangles: mean.triangles, geometries: mean.geometries };
}

/** measure-perf waitForSceneSettle's rule, one poll: stable = within max(1, 1 %) of the previous; 3 stable steps = 4 polls. */
export function settleStep(st, n) {
  const stable = st.prev > 0 && n > 0 && Math.abs(n - st.prev) <= Math.max(1, st.prev * 0.01);
  const stablePolls = stable ? st.stablePolls + 1 : 0;
  return { prev: n, stablePolls, plateau: stablePolls >= 3 };
}

/** The UNMASKED_RENDERER the W arm needs: the GTX 1070 through ANGLE's D3D11 backend. */
export function rendererOk(s) {
  return /GTX 1070/i.test(String(s || "")) && /D3D11|Direct3D ?11/i.test(String(s || ""));
}

/**
 * Our skytime argument for an hour: hour > 1 as hours, else the 0-1 fraction (index.html reads v > 1 as
 * hours and v <= 1 as the fraction, and ignores 24 and above, so 23.995+ wraps to 0).
 */
export function skytimeArg(hour) {
  if (hour === null || hour === undefined || !Number.isFinite(hour)) return null;
  const h = ((Math.round(hour * 100) / 100) % 24 + 24) % 24;
  return h > 1 ? h.toFixed(2) : (h / 24).toFixed(4);
}

/** ACE's in-game hour from acDebug.timeOfDay(): only a server-synced sky clock is ACE's (gameClock non-null). */
export function skyReading(raw, atIso) {
  const r = raw || {};
  const base = { measuredAt: atIso, timeOfDay: r.timeOfDay ?? null, dayLengthSeconds: r.dayLengthSeconds ?? null, gameClock: r.gameClock ?? null, sunBrightness: r.sunBrightness ?? null };
  const dg = r.dayGroup && Number.isInteger(r.dayGroup.index) ? { ...r.dayGroup, ourDatName: DAY_GROUP_DAT_NAMES[r.dayGroup.index] ?? null } : (r.dayGroup || null);
  if (dg && dg.ourDatName != null) dg.namesAgree = dg.ourDatName === dg.name;
  let why = r.why || null;
  if (!why && !Number.isFinite(r.timeOfDay)) why = "acDebug.timeOfDay() returned no numeric timeOfDay";
  if (!why && (r.gameClock === null || r.gameClock === undefined)) why = "WebAC's sky clock has not synced to ACE's TimeSync yet (gameClock null): its timeOfDay is a local default, not ACE's hour";
  const hour = why ? null : Math.round(r.timeOfDay * 24 * 100) / 100;
  return { ...base, hour, skytimeArg: skytimeArg(hour), why, dayGroup: dg };
}

/** ACE's hour at another time from one W reading (ACE's PortalYearTicks run at wall-clock rate). */
export function predictHour(sky, atMs) {
  if (!sky || sky.hour === null || sky.hour === undefined || !sky.measuredAt || !Number.isFinite(sky.dayLengthSeconds) || sky.dayLengthSeconds <= 0) return null;
  const dtS = (atMs - Date.parse(sky.measuredAt)) / 1000;
  const h = (((sky.hour + (dtS / sky.dayLengthSeconds) * 24) % 24) + 24) % 24;
  return { hour: Math.round(h * 100) / 100, skytimeArg: skytimeArg(Math.round(h * 100) / 100), fromHour: sky.hour, fromAt: sky.measuredAt, dtS: Math.round(dtS) };
}

/** Teleport landed: within `tol` m of the park spot and ACE no longer holding the player Hidden. */
export function parkLanded(pos, tol = DEFAULTS.landTolM) {
  return !!pos && Math.hypot(pos.x - SPOT_WORLD.x, pos.north - SPOT_WORLD.north) <= tol && pos.loginComplete !== false;
}

/** The ACE log's last [LOGIN] / [LOGOUT] line of `account`, with its laptop-local timestamp (ms). */
export function lastAccountEvent(text, account) {
  const re = new RegExp(`^(\\d{4})-(\\d\\d)-(\\d\\d) (\\d\\d):(\\d\\d):(\\d\\d),(\\d{3}) .*\\[(LOGIN|LOGOUT)\\] Account ${account.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} `);
  let last = null;
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = re.exec(line);
    if (m) last = { kind: m[8], at: new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]).getTime() };
  }
  return last;
}

/** How long to hold so >= gapMs separates the account's last logout from the next login (0 when already so). */
export function cooldownRemainingMs(ev, nowMs, gapMs = DEFAULTS.cooldownS * 1000) {
  if (!ev || ev.kind !== "LOGOUT") return 0;
  return Math.max(0, gapMs - (nowMs - ev.at));
}

/**
 * The W run JSON: measure-perf's result object (same fields, same order) for the idle phase alone, plus
 * the raw samples, drawDistance, degmul and the `m1c` block. Pure; the suite round-trips it through
 * hbreport.py m1c.
 */
export function buildWResult(m) {
  const idle = m.idle;
  const mean = summarizeInfoSamples(idle.infoSamples);
  const allPhasesMeanSampled = !!mean;
  const render = { idle: mergeInfo(m.renderInfoAfter, mean) };
  const renderSamples = { idle: idle.infoSamples };
  const renderSampling = !allPhasesMeanSampled ? undefined
    : Object.values(renderSamples).every((ss) => ss.every((x) => typeof x.yaw === "number")) ? "frame-heading-binned" : "frame-mean";
  const estimated = Object.fromEntries(Object.entries(render).map(([k, ri]) => [k, ri ? estimateRealGpu(ri.drawCalls) : null]));
  const warnings = droppedFrameWarnings(m.frameStatsStart, [{ phase: "idle", frameStats: render.idle?.frameStats }]);
  return {
    utc: m.utc,
    url: m.urlRedacted,
    viewport: { width: m.viewport.width, height: m.viewport.height },
    headed: false,
    attached: true,
    renderer: m.renderer,
    warnings,
    location: m.location ?? undefined,
    phaseSecs: m.secs,
    renderSampling,
    landscapeDrawDistance: m.landscapeDrawDistance,
    reset: m.reset,
    phases: [phaseStats("idle", idle.deltas)],
    render,
    renderJs: { idle: renderJsStats(m.renderJsSamples) },
    renderSamples,
    census: m.census,
    estimatedRealGpu: estimated,
    drawDistance: m.drawDistanceLive,
    degmul: m.degmul,
    rawSamples: { idle: { frameDeltasMs: idle.deltas, renderJsMs: m.renderJsSamples } },
    m1c: { ...m.m1c, frameStatsHbbench: frameStats(idle.deltas) },
  };
}

// ------------------------------------------------------------------------------------------------
// Side effects (one object, so the suite swaps in fakes: no box, no browser, no network)
// ------------------------------------------------------------------------------------------------

function aceTailDefault(bytes = 262144) {
  const size = statSync(ACE_LOG).size, fd = openSync(ACE_LOG, "r");
  const b = Buffer.alloc(Math.min(bytes, size));
  readSync(fd, b, 0, b.length, size - b.length); closeSync(fd);
  return b.toString("utf8");
}

export const DEPS = Object.freeze({
  env: process.env,
  log: (m) => console.log(m),
  now: () => Date.now(),
  sleep: (ms) => sleep(ms),
  /** HTTP probe of a laptop URL: {status, ok, type, length}; the body is never read. */
  http: async (url, { method = "GET", timeoutMs = 8000 } = {}) => {
    const r = await fetch(url, { method, cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    try { await r.body?.cancel(); } catch (_) { /* no body */ }
    return { status: r.status, ok: r.ok, type: r.headers.get("content-type") || "", length: Number(r.headers.get("content-length") || 0) };
  },
  tcpOpen: (host, port, timeoutMs = 3000) => new Promise((res) => {
    const s = net.connect({ host, port });
    const done = (v) => { try { s.destroy(); } catch (_) { /* gone */ } res(v); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  }),
  /** Is a UDP port bound on this laptop (ACE)? null when `ss` cannot tell. */
  udpBound: (port) => { try { return execFileSync("ss", ["-H", "-uln", `sport = :${port}`], { encoding: "utf8", timeout: 5000 }).trim().length > 0; } catch (_) { return null; } },
  waitAccountFree: (account, maxMs) => waitAccountFree(account, maxMs),
  readAceTail: () => aceTailDefault(),
  /** One box command (async, retried); the kill uses `boxSync` so a signal handler can run it. */
  box: (cmd, o) => sshRetry(cmd, o),
  boxSync: (cmd) => ssh(cmd),
  launchChrome: (cdp, o) => launchChrome(cdp, o),
  cdpJson: async (cdp, path) => (await fetch(`${cdp}${path}`, { signal: AbortSignal.timeout(8000) })).json(),
  cdpConnect: async (wsUrl) => (await import("./lib/cdp_raw.mjs")).cdpConnect(wsUrl),
  sizeWindow: (ctx, pg, target, o) => sizeWindow(ctx, pg, target, o),
  boxSample: (label, o) => boxSample(label, o),
  armKillOnSignal: (o) => armKillOnSignal(o),
  exists: (p) => existsSync(p),
  mkdir: (p) => mkdirSync(p, { recursive: true }),
  writeFile: (p, t) => writeFileSync(p, t),
  readText: (p) => readFileSync(p, "utf8"),
});

const encodedPs = (script) => `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodePowerShell(script)}`;

function withTimeout(p, ms, what) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: timed out after ${Math.round(ms / 1000)} s`)), ms); })]).finally(() => clearTimeout(t));
}

/** Runtime.evaluate (awaitPromise, by value) of an expression or a function (cdp_raw rawSession's rule). */
export async function pageEval(conn, expr, arg, timeoutMs = 60000) {
  const expression = typeof expr === "function" ? `(${expr.toString()})(${arg === undefined ? "" : JSON.stringify(arg)})` : String(expr);
  const tag = (/^\/\*m1c:(\w+)\*\//.exec(expression) || [, "fn"])[1];
  const r = await withTimeout(conn.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }), timeoutMs, `evaluate ${tag}`);
  if (r && r.exceptionDetails) {
    const dd = r.exceptionDetails;
    throw new Error(`page exception in ${tag}: ${String(dd.exception?.description || dd.text || "").slice(0, 300)}`);
  }
  return r && r.result ? r.result.value : undefined;
}

// ------------------------------------------------------------------------------------------------
// Preflight
// ------------------------------------------------------------------------------------------------

/** Laptop preflight (no box contact). {ok, problems, warnings, checks, commands}. */
export async function preflight(o, d) {
  const problems = [], warnings = [], checks = {};
  const base = o.urlBase;
  try {
    const r = await d.http(`${base}/`);
    checks.vite = r.status;
    if (!r.ok || !/text\/html/i.test(r.type)) problems.push(`vite dev server at ${base}/ answered ${r.status} ${r.type || "(no type)"} (want 200 text/html)`);
  } catch (e) { problems.push(`vite dev server at ${base}/ does not answer (${errText(e)})`); }
  if (checks.vite === 200) {
    for (const f of DAT_FILES) {
      try {
        const r = await d.http(`${base}/${f}`, { method: "HEAD" });
        if (!r.ok || /text\/html/i.test(r.type) || !(r.length > 4096)) problems.push(`vite does not serve ${f} as a DAT (${r.status} ${r.type} ${r.length} B): the ${WEBAC_DIR}/dat/ links are missing`);
      } catch (e) { problems.push(`HEAD ${base}/${f} failed (${errText(e)})`); }
    }
  }
  const hz = bridgeHealthUrl(o.bridge);
  try {
    const r = await d.http(hz);
    checks.bridge = r.status;
    if (!r.ok) problems.push(`WebAC's bridge ${hz} answered ${r.status} (want 200)`);
  } catch (e) { problems.push(`WebAC's bridge does not answer at ${hz} (${errText(e)})`); }
  const udp = d.udpBound(o.acePort);
  checks.aceUdp = udp;
  if (udp === false) problems.push(`ACE does not hold UDP :${o.acePort} on this laptop (start it: memory/ace-live.md)`);
  else if (udp === null) warnings.push(`could not check ACE's UDP :${o.acePort} (ss unavailable)`);
  const cu = new URL(o.cdp);
  const bound = await d.tcpOpen(cu.hostname, Number(cu.port || 80), 3000);
  checks.cdpForward = bound;
  if (!bound) problems.push(`nothing listens on ${o.cdp}: the box tunnel's -L 9333 forward is down`);
  else {
    let ver = null;
    try { ver = await d.cdpJson(o.cdp, "/json/version"); } catch (_) { ver = null; }
    if (ver && ver.Browser) problems.push(`a Chrome already answers on ${o.cdp} (${ver.Browser}): one test Chrome at a time (ours or W); close it by its user-data-dir first`);
  }
  const wFile = join(o.out, `W-r${o.rep}.json`);
  if (d.exists(wFile)) problems.push(`${wFile} exists: never overwrite a rep (move it, or pick the next --rep)`);
  return { ok: problems.length === 0, problems, warnings, checks, commands: problems.length ? startCommands(d.readText) : [] };
}

// ------------------------------------------------------------------------------------------------
// The plan (--dry-run) and one rep
// ------------------------------------------------------------------------------------------------

/** Every step of a rep, as text (the --dry-run output). Pure. */
export function planLines(o) {
  const url = buildWebacUrl({ urlBase: o.urlBase, bridge: o.bridge, account: o.creds.account, password: o.creds.password, degmul: o.degmul });
  const red = redact(url, o.creds);
  const L = [
    `[m1c] DRY RUN: ${ITEM} W arm rep ${o.rep}; nothing below runs, no box / network / file is touched`,
    `[m1c] account ${o.creds.account} (${o.creds.accountSource}), password from ${o.creds.passwordSource}`,
    `step preflight: laptop: GET ${o.urlBase}/ (vite), HEAD ${DAT_FILES.map((f) => `/${f}`).join(" ")}, GET ${bridgeHealthUrl(o.bridge)}, ACE UDP :${o.acePort}, ${o.cdp} forward up with no Chrome on it, ${join(o.out, `W-r${o.rep}.json`)} absent`,
    `step account: waitAccountFree(${o.creds.account}, ${DEFAULTS.accountWaitS} s) then ${o.cooldown ? `>= ${DEFAULTS.cooldownS} s since its last [LOGOUT]` : "no cool-down (--no-cooldown)"}`,
    `step box.check: ssh: no chrome.exe on --user-data-dir=${PROFILE} (refuse, never kill: it may be the owner's MODE P), box GET ${o.urlBase}/ and ${bridgeHealthUrl(o.bridge)} through -R 3000 / -R 9090`,
    `step box.sample: ${o.boxSamples ? "pre-launch, pre-idle, post-idle (box/hbwho.ps1 + top CPU, the W Chrome marked ours)" : "off (--no-box-samples)"}`,
    `step box.launcher: write ${LAUNCHER}:`,
    ...launcherBat({ uncapped: o.uncapped, window: o.window }).trimEnd().split("\r\n").map((l) => `    ${l}`),
    `step launch: armKillOnSignal (kill = the ${PROFILE} Chrome only), then schtasks ${TASK} -> hidden-run.vbs -> ${LAUNCHER}; wait for ${o.cdp}/json/version`,
    `step cdp: raw CDP to the about:blank page target + the browser endpoint (no Playwright); Page / Runtime enabled, focus emulation on (as Playwright's attach)`,
    `step window: INNER ${o.window.replace(",", "x")} via lib/hb_session.mjs sizeWindow (Browser.setWindowBounds; emulation fallback); record inner, outer, dpr`,
    `step renderer: about:blank UNMASKED_RENDERER must name GTX 1070 and D3D11, else refuse (exit 3) before any login`,
    `step shim: Page.addScriptToEvaluateOnNewDocument(DAT-iteration shim, ${DAT_SHIM.length} chars, lessons doc 5.1 step 6)${o.seedDrawDistance ? ` + measure-perf's draw-distance seed (${o.drawDistance})` : ""}`,
    `step navigate: Page.navigate ${red}`,
    `step load: poll every 5 s up to ${o.loadTimeoutS} s (first load streams ~1.27 GB into OPFS; progress every 30 s); gate acDebug.collisionState().x > 0 && window.__ac.sceneManager`,
    `step streams: wait 10 s (measure-perf's in-world settle)`,
    `step park: ${TELELOC} unless within ${DEFAULTS.nearSkipM} m; landed within ${DEFAULTS.landTolM} m of (${SPOT_WORLD.x}, ${SPOT_WORLD.north}) in 40 s; acDebug.setPlayerYaw(0)`,
    `step settle: mesh count within max(1, 1 %) over 4 polls 2 s apart, cap ${o.settleCapS} s`,
    `step sky: acDebug.timeOfDay() / dayGroup() -> ACE's hour (null + why unless server-synced)`,
    `step measure: measure-perf idle: renderer, draw distance, location, render timer, frameStats start, setPlayerYaw(0), drain, ${o.secs} s rAF + renderer.info per frame, heading-sector means, renderJs p50/p95, census`,
    `step write: ${join(o.out, `W-r${o.rep}.json`)} (failure: W-r${o.rep}.failed.json)`,
    `step teardown: about:blank, close the tab, kill chrome.exe on --user-data-dir=${PROFILE} (roots with ${ROOT_FLAGS.join(" ")}), ${o.cdp} must stop answering, waitAccountFree + ${DEFAULTS.cooldownS} s gap`,
    `[m1c] then the H arms: ${hArmCommand(o, "<ACE hour from W>")}`,
  ];
  return L;
}

/** The recipe's H-arm command for this rep. */
export function hArmCommand(o, skytime) {
  return `node scripts/perf-worker/hbbench.mjs --arms apps/holtburger-web/docs/reengineering/queue-1070/batch-R3-M1-2026-10-30.json --item ${ITEM} --reps 1 --port 8766 --uncapped --skytime ${skytime} --out ${join(o.out, `H-r${o.rep}`)}`;
}

/**
 * One W rep. Returns {code, file?, result?, problems?}. `depsIn` overrides DEPS (the suite: fakes only).
 * Step ids go to `res.m1c.steps` and the log in order (the suite pins the order).
 */
export async function runRep(o, depsIn = {}) {
  const d = { ...DEPS, ...depsIn };
  const creds = o.creds;
  const secrets = { password: creds.password, account: creds.account };
  const log = (m) => d.log(redact(`[m1c] ${m}`, secrets));
  const url = buildWebacUrl({ urlBase: o.urlBase, bridge: o.bridge, account: creds.account, password: creds.password, degmul: o.degmul });
  const urlRedacted = redact(url, secrets);
  const steps = [];
  const step = (id, what) => { steps.push({ id, at: new Date(d.now()).toISOString() }); log(`step ${id}: ${what}`); };
  const wFile = join(o.out, `W-r${o.rep}.json`), failFile = join(o.out, `W-r${o.rep}.failed.json`);
  const t0 = d.now();
  const m1c = { schema: SCHEMA, tool: "scripts/perf-worker/m1c-webac.mjs", item: ITEM, arm: "W", rep: o.rep, profile: PROFILE, profilePersistent: true,
    account: creds.account, urlBase: o.urlBase, bridge: o.bridge, degmulUrl: o.degmul, secs: o.secs,
    vsync: o.uncapped ? { uncapped: true, chromeFlags: ["--disable-frame-rate-limit", "--disable-gpu-vsync"] } : { uncapped: false, chromeFlags: [] },
    chromeArgs: chromeArgs({ uncapped: o.uncapped, window: o.window }), startedAt: new Date(t0).toISOString(), steps, problems: [], box: [], consoleErrors: [], datCacheLog: [] };

  // ---- before anything touches the box -------------------------------------------------------
  step("preflight", "laptop checks (vite, DATs, bridge, ACE, CDP forward, output)");
  const pf = await preflight(o, d);
  m1c.preflight = pf.checks;
  for (const w of pf.warnings) log(`WARN ${w}`);
  if (!pf.ok) {
    for (const p of pf.problems) log(`REFUSED: ${p}`);
    log("start what is missing with the recipe's commands (batch-R3-M1-2026-10-30.json M1c-WEBAC):");
    for (const c of pf.commands) log(`  ${c}`);
    return { code: 2, problems: pf.problems };
  }
  step("account", `wait until ACE has ${creds.account} out of the world`);
  const free = await d.waitAccountFree(creds.account, DEFAULTS.accountWaitS * 1000);
  m1c.accountFreeBefore = free;
  if (free === false) { log(`REFUSED: ACE still has ${creds.account} in the world after ${DEFAULTS.accountWaitS} s (another client on the account?)`); return { code: 2, problems: ["account in use"] }; }
  if (free === null) log("WARN ACE's log is unreadable: cannot confirm the account is free");
  if (o.cooldown) await holdCooldown(d, creds.account, log, m1c, "before");
  step("box.check", `no ${PROFILE} Chrome running; the box reaches vite and the bridge`);
  let chk;
  try { chk = await d.box(encodedPs(boxCheckScript({ urlBase: o.urlBase, bridge: o.bridge })), { timeout: 90000 }); } catch (e) { log(`REFUSED: box check failed (${errText(e)})`); return { code: 2, problems: ["box check failed"] }; }
  const running = parseKillLine(chk), netc = parseNetLine(chk);
  m1c.boxCheck = { running, net: netc };
  const boxProblems = [];
  if (running.error) boxProblems.push(`box check unreadable: ${running.error}`);
  else if (running.matched > 0) boxProblems.push(`a Chrome on ${PROFILE} is already running on the box (${running.browsers} browser process(es), muted ${running.muted}, off-screen ${running.offscreen}): it may be the owner's MODE P session. Never killed from here: ask the owner, or close it by its user-data-dir once they agree`);
  if (!netc) boxProblems.push("box check printed no M1CNET line");
  else {
    if (netc.vite !== 200) boxProblems.push(`the box gets ${netc.vite} from ${o.urlBase}/: add -R 3000:127.0.0.1:3000 to the box ssh`);
    if (netc.bridge !== 200) boxProblems.push(`the box gets ${netc.bridge} from ${bridgeHealthUrl(o.bridge)}: add -R 9090:127.0.0.1:9090 to the box ssh`);
  }
  if (boxProblems.length) {
    for (const p of boxProblems) log(`REFUSED: ${p}`);
    if (netc && (netc.vite !== 200 || netc.bridge !== 200)) for (const c of startCommands(d.readText).filter((c) => /^Tunnel/.test(c))) log(`  ${c}`);
    return { code: 2, problems: boxProblems };
  }

  // ---- from here on the box Chrome may exist: every exit path tears it down --------------------
  const st = { launched: false, page: null, browser: null, targetId: null, disarm: null };
  const killW = () => (st.launched ? killChromeByProfile(PROFILE, { requireFlags: [...ROOT_FLAGS], run: d.boxSync }) : { skipped: "no Chrome launched by this run" });
  const sample = async (label) => {
    if (!o.boxSamples) return;
    const { script, oursRule } = wBoxSampleScript();
    const s = await d.boxSample(label, { script, run: d.box });
    m1c.box.push({ ...s, oursRule, note: "hbwho.ps1 counts the W Chrome as a browser of theirs and its GPU time in gpu3d_other" });
  };
  let code = 0, result = null, failure = null;
  const refuseAdapter = (r, when) => { code = 3; throw new Error(`REFUSED: renderer ${JSON.stringify(r)} ${when} is not the GTX 1070 on D3D11 (wrong adapter: rule V)`); };
  try {
    await sample("pre-launch");
    step("box.launcher", `write ${LAUNCHER}`);
    const bat = launcherBat({ uncapped: o.uncapped, window: o.window });
    const wrote = await d.box(encodedPs(launcherWriteScript(bat)), { timeout: 60000 });
    const bytes = Number((/M1CBAT bytes=(\d+)/.exec(String(wrote)) || [])[1]);
    if (bytes !== bat.length) throw new Error(`launcher write: box reports ${bytes} bytes, wrote ${bat.length}`);
    step("launch", `kill-on-signal armed; schtasks ${TASK} -> ${LAUNCHER}`);
    st.disarm = d.armKillOnSignal({ kill: () => { const r = killW(); return r; }, log: (m) => d.log(`[m1c] ${m} (W: ${PROFILE} only)`) });
    st.launched = true;
    if (!(await d.launchChrome(o.cdp, { task: TASK, launcher: LAUNCHER, run: d.box }))) throw new Error("the W Chrome never answered on CDP (hbgate refused? see D:\\Temp\\hbbench\\gate.log; or the -L 9333 forward)");

    step("cdp", "raw CDP to the about:blank page target");
    const ver = await d.cdpJson(o.cdp, "/json/version");
    m1c.browserVersion = ver && ver.Browser;
    st.browser = await d.cdpConnect(ver.webSocketDebuggerUrl);
    const pages = ((await d.cdpJson(o.cdp, "/json/list")) || []).filter((t) => t.type === "page");
    const target = pages.find((p) => /^about:blank/.test(p.url));
    if (!target) throw new Error(`the fresh W Chrome has no about:blank tab (pages: ${pages.map((p) => redact(p.url, secrets)).join(", ") || "none"})`);
    // A persistent profile can open extra tabs (a what's-new page, a restored tab): close them, so the
    // WebAC tab is the only real-world tab on the box (an http(s) one is recorded as a problem).
    const extra = pages.filter((p) => p !== target);
    m1c.extraTabsClosed = extra.map((p) => redact(p.url, secrets).slice(0, 120));
    for (const p of extra) {
      if (/^https?:/i.test(p.url)) m1c.problems.push(`an http(s) tab was open in the fresh W Chrome (${redact(p.url, secrets).slice(0, 80)}); closed`);
      try { await withTimeout(st.browser.send("Target.closeTarget", { targetId: p.id }), 10000, "closeTarget"); } catch (e) { log(`WARN could not close extra tab ${p.id}: ${errText(e)}`); }
    }
    st.targetId = target.id;
    st.page = await d.cdpConnect(target.webSocketDebuggerUrl);
    const page = st.page;
    page.on("Page.javascriptDialogOpening", (p) => { page.send("Page.handleJavaScriptDialog", { accept: p && p.type === "beforeunload" }).catch(() => {}); });
    page.on("Runtime.consoleAPICalled", (p) => {
      const text = (p.args || []).map((a) => (a.value !== undefined ? String(a.value) : a.description || "")).join(" ");
      if (p.type === "error" && m1c.consoleErrors.length < 30) m1c.consoleErrors.push(redact(text, secrets).slice(0, 200));
      if (/^\[AC:DatCache\]/.test(text) && m1c.datCacheLog.length < 20) { m1c.datCacheLog.push(text.slice(0, 160)); log(`  page: ${text.slice(0, 160)}`); }
    });
    page.on("Runtime.exceptionThrown", (p) => { if (m1c.consoleErrors.length < 30) m1c.consoleErrors.push(redact(`exception: ${p?.exceptionDetails?.exception?.description || p?.exceptionDetails?.text || ""}`, secrets).slice(0, 200)); });
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    // Playwright's attach (measure-perf --attach) turns focus emulation on for every page; keep that state.
    await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    m1c.cdp = { client: "raw CDP (lib/cdp_raw.mjs)", domains: ["Page", "Runtime"], focusEmulation: true, notReplicated: "Playwright's Network.enable / Log.enable / worker auto-attach" };

    step("window", `INNER ${o.window}`);
    const ctxShim = { newCDPSession: async () => ({
      send: (method, params = {}) => (method.startsWith("Browser.") ? st.browser.send(method, method === "Browser.getWindowForTarget" ? { targetId: target.id, ...params } : params) : page.send(method, params)),
      on: (ev, fn) => page.on(ev, fn), detach: async () => {} }) };
    const pgShim = { evaluate: (fn, arg) => pageEval(page, fn, arg) };
    const { w, h } = parseWindow(o.window);
    const sized = await d.sizeWindow(ctxShim, pgShim, { w, h });
    m1c.window = sized;
    if (!sized.ok) m1c.problems.push(`window not at INNER ${w}x${h} (${JSON.stringify(sized.inner)})`);

    step("renderer", "UNMASKED_RENDERER on the blank tab (before any login)");
    const pre = await pageEval(page, PAGE_RENDERER);
    m1c.rendererPreNav = pre;
    if (!rendererOk(pre)) refuseAdapter(pre, "on the blank tab, before any login");

    step("shim", "DAT-iteration shim (and the draw-distance seed) before navigating");
    const shimId = await page.send("Page.addScriptToEvaluateOnNewDocument", { source: DAT_SHIM });
    m1c.shim = { identifier: shimId && shimId.identifier, chars: DAT_SHIM.length, iterations: { portal: 2074, cell: 982, language: 994 } };
    if (o.seedDrawDistance) {
      const seedId = await page.send("Page.addScriptToEvaluateOnNewDocument", { source: drawDistanceSeed(new URL(o.urlBase).origin, o.drawDistance) });
      m1c.drawDistanceSeed = { value: o.drawDistance, identifier: seedId && seedId.identifier };
    }

    step("navigate", urlRedacted);
    const nav = await withTimeout(page.send("Page.navigate", { url }), 120000, "Page.navigate");
    if (nav && nav.errorText) throw new Error(`navigation failed: ${nav.errorText}`);

    step("load", `first-load DAT stream + world entry (gate: collisionState().x > 0 and __ac.sceneManager; up to ${o.loadTimeoutS} s)`);
    const tl = d.now();
    let ls = null, lastLog = -Infinity, opfsStart = null;
    for (;;) {
      ls = await pageEval(page, PAGE_LOAD_STATE).catch((e) => ({ error: errText(e) }));
      if (ls && opfsStart === null && Number.isFinite(ls.opfsBytes)) opfsStart = ls.opfsBytes;
      const el = d.now() - tl;
      if (ls && ls.x > 0 && ls.sceneManager) break;
      if (ls && ls.screen === "character-create") throw new Error("the account has no character (WebAC is at character-create): use an account with one");
      if (el >= o.loadTimeoutS * 1000) throw new Error(`not in world after ${o.loadTimeoutS} s (last state ${JSON.stringify(ls)})`);
      if (el - lastLog >= 30000) {
        lastLog = el;
        const mb = ls && Number.isFinite(ls.opfsBytes) ? `${(ls.opfsBytes / 1048576).toFixed(0)} MB in origin storage` : "storage ?";
        log(`  loading ${Math.round(el / 1000)} s: ${mb}, screen ${ls && ls.screen}, collision x ${ls && ls.x}, sceneManager ${ls && ls.sceneManager}${ls && ls.error ? `, ${ls.error}` : ""}`);
      }
      await d.sleep(5000);
    }
    m1c.load = { ms: d.now() - tl, opfsBytesStart: opfsStart, opfsBytesEnd: ls.opfsBytes ?? null, gate: { x: ls.x, sceneManager: ls.sceneManager, loginComplete: ls.loginComplete },
      warmProfile: m1c.datCacheLog.length > 0 && m1c.datCacheLog.every((l) => /served from OPFS cache/.test(l)) };
    log(`  in world after ${Math.round(m1c.load.ms / 1000)} s (${m1c.load.warmProfile ? "warm: DATs from OPFS" : "DATs downloaded or unknown"})`);

    step("streams", "10 s (measure-perf: letting object streams settle)");
    await d.sleep(10000);

    step("park", TELELOC);
    const before = await pageEval(page, PAGE_WORLD_POS);
    const distBefore = before ? Math.round(Math.hypot(before.x - SPOT_WORLD.x, before.north - SPOT_WORLD.north) * 10) / 10 : null;
    const park = { spot: TELELOC, world: SPOT_WORLD, before, distBefore, teleloc: null, landed: null, landMs: null };
    m1c.park = park;
    if (distBefore !== null && distBefore <= DEFAULTS.nearSkipM) park.teleloc = "skipped-near"; // measure-perf: a same-position teleport breaks CreateObject registration
    else {
      if (!(await pageEval(page, pageAdmin(TELELOC)))) throw new Error("acDebug.admin is not available (dev server? Developer-level account?)");
      park.teleloc = "sent";
      const tp = d.now();
      let pos = null;
      while (d.now() - tp < 40000) {
        await d.sleep(2000);
        pos = await pageEval(page, PAGE_WORLD_POS);
        if (parkLanded(pos)) break;
      }
      park.landed = pos;
      park.landMs = d.now() - tp;
      if (!parkLanded(pos)) throw new Error(`${TELELOC} never landed within ${DEFAULTS.landTolM} m in 40 s (at ${JSON.stringify(pos)}): Developer-level account?`);
    }
    park.yawApplied = await pageEval(page, pageSetYaw(0));
    if (!park.yawApplied) m1c.problems.push("acDebug.setPlayerYaw unavailable: heading not pinned");

    step("settle", `mesh count stable to 1 % over 4 polls (cap ${o.settleCapS} s)`);
    const ts = d.now();
    let ss = { prev: -1, stablePolls: 0, plateau: false };
    const polls = [];
    while (d.now() - ts < o.settleCapS * 1000) {
      await d.sleep(2000);
      const n = await pageEval(page, PAGE_COUNT_MESHES);
      polls.push(n);
      ss = settleStep(ss, n);
      if (ss.plateau) break;
    }
    const settle = { meshes: ss.prev, settleMs: d.now() - ts, plateau: ss.plateau, polls };
    m1c.settle = settle;
    log(`  scene settle: ${settle.meshes} meshes after ${Math.round(settle.settleMs / 1000)} s${settle.plateau ? "" : " *** never plateaued: streaming may still be filling the scene"}`);
    if (!settle.plateau) m1c.problems.push(`scene never plateaued in ${o.settleCapS} s`);

    step("sky", "ACE's in-game hour");
    m1c.sky = skyReading(await pageEval(page, PAGE_SKY), new Date(d.now()).toISOString());
    log(`  ACE hour ${m1c.sky.hour ?? "null"}${m1c.sky.why ? ` (${m1c.sky.why})` : ` -> H arms --skytime ${m1c.sky.skytimeArg}`}; day group ${m1c.sky.dayGroup ? `#${m1c.sky.dayGroup.index} ${m1c.sky.dayGroup.name}` : "?"}`);

    await sample("pre-idle");
    step("measure", `measure-perf idle phase, ${o.secs} s`);
    const vp = await pageEval(page, PAGE_VIEWPORT);
    if (vp.visibility !== "visible") throw new Error(`the WebAC tab is ${vp.visibility}: rAF is throttled (never minimize the window)`);
    const renderer = await pageEval(page, PAGE_RENDERER);
    if (!rendererOk(renderer)) refuseAdapter(renderer, "at measurement time");
    const dd = await pageEval(page, PAGE_DRAW_DISTANCE);
    const landscapeDrawDistance = dd && dd.stored !== null ? dd.stored : SHIPPED_DEFAULT_LANDSCAPE_DRAW_DISTANCE;
    if ((dd && dd.live !== null ? dd.live : landscapeDrawDistance) !== o.drawDistance) m1c.problems.push(`draw distance ${JSON.stringify(dd)} is not ${o.drawDistance}`);
    const location = locationOf(await pageEval(page, PAGE_LOCATION));
    const timerOk = await pageEval(page, PAGE_INSTALL_RENDER_TIMER);
    if (!timerOk) m1c.problems.push("renderer.render timer unavailable: renderJs will be null");
    const frameStatsStart = ((await pageEval(page, PAGE_RENDER_INFO)) || {}).frameStats ?? null;
    const yawApplied = await pageEval(page, pageSetYaw(0));
    await pageEval(page, PAGE_DRAIN_RENDER_TIMER);
    const idle = await pageEval(page, pageSamplePhase(o.secs * 1000), undefined, o.secs * 1000 + 120000);
    const renderInfoAfter = await pageEval(page, PAGE_RENDER_INFO);
    const renderJsSamples = await pageEval(page, PAGE_DRAIN_RENDER_TIMER);
    const census = await pageEval(page, PAGE_SCENE_CENSUS);
    if (!idle || !Array.isArray(idle.deltas) || idle.deltas.length < 2) throw new Error("the idle phase recorded no frames (hidden tab?)");
    await sample("post-idle");
    m1c.skyAfter = skyReading(await pageEval(page, PAGE_SKY).catch(() => null), new Date(d.now()).toISOString());

    step("write", wFile);
    result = buildWResult({
      utc: new Date(d.now()).toISOString(), urlRedacted, viewport: vp, renderer, location, secs: o.secs, landscapeDrawDistance,
      reset: { telepoi: "skipped-flag", yaw: 0, settle: { meshes: settle.meshes, settleMs: settle.settleMs, plateau: settle.plateau } },
      idle, renderInfoAfter, frameStatsStart, renderJsSamples: Array.isArray(renderJsSamples) ? renderJsSamples : [], census,
      drawDistanceLive: dd && dd.live !== null ? dd.live : landscapeDrawDistance, degmul: o.degmul,
      m1c: { ...m1c, viewport: vp, devicePixelRatio: vp.dpr, drawDistanceRead: dd, yawAppliedBeforeIdle: yawApplied, endedAt: new Date(d.now()).toISOString() },
    });
    d.mkdir(o.out);
    d.writeFile(wFile, redact(JSON.stringify(result, null, 1), secrets));
    const idleP = result.phases[0];
    log(`  W idle: ${idleP.avgFps} fps p50 ${idleP.p50Ms} ms p95 ${idleP.p95Ms} ms, draws ${result.render.idle?.drawCalls} (${result.renderSampling}), renderJs p50 ${result.renderJs.idle?.p50Ms ?? "-"} ms, viewport ${vp.width}x${vp.height} dpr ${vp.dpr}${m1c.problems.length ? `; problems: ${m1c.problems.join("; ")}` : ""}`);
  } catch (e) {
    failure = errText(e);
    code = code || 1;
    log(code === 3 ? failure : `FAILED: ${failure}`);
  } finally {
    const tdn = {};
    try {
      if (st.page) {
        step("teardown.tab", "about:blank (WebAC's unload closes the ACE session), close the tab");
        try { await withTimeout(st.page.send("Page.navigate", { url: "about:blank" }), 15000, "about:blank"); } catch (e) { tdn.blank = errText(e); }
        await d.sleep(3000);
        try { if (st.browser && st.targetId) await withTimeout(st.browser.send("Target.closeTarget", { targetId: st.targetId }), 10000, "closeTarget"); } catch (e) { tdn.close = errText(e); }
        try { st.page.close(); } catch (_) { /* gone */ }
        try { if (st.browser) st.browser.close(); } catch (_) { /* gone */ }
      }
      if (st.launched) {
        step("teardown.kill", `kill chrome.exe on ${PROFILE} only`);
        tdn.kill = killW();
        log(`  kill: ${JSON.stringify(tdn.kill)}`);
        let closed = false;
        for (let i = 0; i < 20 && !closed; i++) {
          try { const v = await d.cdpJson(o.cdp, "/json/version"); if (!v || !v.Browser) closed = true; } catch (_) { closed = true; }
          if (!closed) await d.sleep(1000);
        }
        tdn.cdpClosed = closed;
        if (!closed) { log(`FAILED: a Chrome still answers on ${o.cdp} after the kill: do NOT start the H arm (it would attach to it); kill it by its user-data-dir`); code = 4; }
      }
      step("teardown.account", `wait for ACE's [LOGOUT] of ${creds.account}`);
      tdn.accountFree = await d.waitAccountFree(creds.account, DEFAULTS.accountWaitS * 1000);
      if (tdn.accountFree === false) log(`WARN ACE still has ${creds.account} in the world after ${DEFAULTS.accountWaitS} s`);
      if (o.cooldown) await holdCooldown(d, creds.account, log, tdn, "after");
      if (st.launched) { try { await d.box(`schtasks /delete /tn ${TASK} /f >nul 2>nul`, { timeout: 30000, tries: 1 }); } catch (_) { /* best effort */ } }
    } finally {
      if (st.disarm) { try { st.disarm(); } catch (_) { /* gone */ } }
    }
    m1c.teardown = tdn;
    if (failure !== null || code === 3) {
      try {
        d.mkdir(o.out);
        d.writeFile(failFile, redact(JSON.stringify({ ...m1c, error: failure, code, endedAt: new Date(d.now()).toISOString() }, null, 1), secrets));
        log(`  diagnostics: ${failFile}`);
      } catch (e) { log(`WARN could not write ${failFile}: ${errText(e)}`); }
    } else if (result) {
      try { result.m1c.teardown = tdn; d.writeFile(wFile, redact(JSON.stringify(result, null, 1), secrets)); } catch (e) { log(`WARN could not add the teardown record to ${wFile}: ${errText(e)}`); }
    }
  }
  if (result && code === 0) {
    log(`wrote ${wFile}`);
    log(`next, the H arms of rep ${o.rep}: ${hArmCommand(o, result.m1c.sky.skytimeArg ?? "<no ACE hour: see m1c.sky.why>")}`);
    const g = result.m1c.sky.dayGroup;
    if (g && Number.isInteger(g.index) && g.index !== 0) log(`  note: W's day group is #${g.index} ${g.name}; the H arms pin DayGroup 0 (Sunny) unless given --daygroup ${g.index}`);
  }
  return { code, file: result && code === 0 ? wFile : null, result, failure };
}

/** Hold until >= 65 s separate the account's last [LOGOUT] from now (the queue's login cool-down). */
async function holdCooldown(d, account, log, rec, when) {
  let ev = null;
  try { ev = lastAccountEvent(d.readAceTail(), account); } catch (_) { ev = null; }
  const ms = cooldownRemainingMs(ev, d.now());
  rec[`cooldown_${when}`] = { lastEvent: ev ? { kind: ev.kind, at: new Date(ev.at).toISOString() } : null, heldMs: ms };
  if (ms > 0) { log(`  login cool-down: holding ${Math.ceil(ms / 1000)} s (>= ${DEFAULTS.cooldownS} s since ${account}'s last logout)`); await d.sleep(ms); }
}

/** CLI entry (returns the exit code). */
export async function main(argv, depsIn = {}) {
  const d = { ...DEPS, ...depsIn };
  let o;
  try { o = parseArgs(argv); } catch (e) { d.log(`[m1c] ${e.message}`); d.log(USAGE); return 2; }
  if (o.help) { d.log(USAGE); return 0; }
  if (o.predictHour) {
    let j;
    try { j = JSON.parse(d.readText(o.predictHour)); } catch (e) { d.log(`[m1c] cannot read ${o.predictHour}: ${errText(e)}`); return 2; }
    const at = o.at ? Date.parse(o.at) : d.now();
    if (!Number.isFinite(at)) { d.log(`[m1c] --at must be an ISO time (got ${o.at})`); return 2; }
    const p = predictHour(j && j.m1c && j.m1c.sky, at);
    if (!p) { d.log(`[m1c] ${o.predictHour} has no usable ACE hour (m1c.sky.why: ${j && j.m1c && j.m1c.sky && j.m1c.sky.why})`); return 1; }
    d.log(`[m1c] ACE hour at ${new Date(at).toISOString()}: ${p.hour} (from ${p.fromHour} at ${p.fromAt}, ${p.dtS} s later) -> --skytime ${p.skytimeArg}`);
    return 0;
  }
  try { o.creds = credentials(d.env); } catch (e) { d.log(`[m1c] ${e.message}`); return 2; }
  if (o.dryRun) { for (const l of planLines(o)) d.log(redact(l, o.creds)); return 0; }
  const r = await runRep(o, d);
  return r.code;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
}
