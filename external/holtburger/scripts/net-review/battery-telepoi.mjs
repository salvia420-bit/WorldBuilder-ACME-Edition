#!/usr/bin/env node
// battery-telepoi.mjs — full @telepoi cycle timing battery (2026-07-10).
// Teleports through EVERY point_of_interest, timing land + stream-settle per
// stop, for cycle-speed A/Bs across variations (e.g. ?warmPark=on vs default)
// and across boxes (laptop SwiftShader/nullRender vs the 1070 real GPU).
//
// Modes:
//   --mode local  (default) — boot.mjs launchAndEnter (laptop headless).
//   --mode cdp    — connectOverCDP to an ALREADY-RUNNING off-screen Chrome
//                   (the 1070 MODE2i recipe; driver runs on the laptop over
//                   the -L 9333 tunnel; serve+bridge ride -R 8765/-R 8080).
// Common: --pois <file> (one name per line) --query "warmPark=on"
//         --label armA --out out.json --dwellMax 25 --shots <dir> (cdp only)
//         --cdp http://127.0.0.1:9333 --account tailnet1
//
// Settle criterion: (terrainBakedLbs.size, staticsGroup.children.length,
// cellContainers3d.size) unchanged across 3 consecutive 500 ms samples —
// covers outdoor towns AND indoor dungeon POIs. Max --dwellMax s per stop.
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const MODE = arg("mode", "local");
const POIS_FILE = arg("pois", "");
const EXTRA_QUERY = arg("query", "");
const LABEL = arg("label", MODE);
const OUT = arg("out", "");
const SHOTS = arg("shots", "");
const DWELL_MAX_S = Number(arg("dwellMax", "25"));
const CDP_URL = arg("cdp", "http://127.0.0.1:9333");
const ACCOUNT = arg("account", "tailnet1");

if (!POIS_FILE) { console.error("--pois <file> required"); process.exit(2); }
let POIS = fs.readFileSync(POIS_FILE, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);

// --resume: continue an aborted arm. Reads OUT (if present), keeps its rows,
// and only visits the POIs not yet attempted — a renderer death mid-cycle
// (SwiftShader under teleport churn) then costs one relaunch, not the arm.
// The wrapper loop re-invokes with the same --out until exit != 3.
const RESUME = process.argv.includes("--resume");
let priorRows = [];
if (RESUME && OUT && fs.existsSync(OUT)) {
  try {
    const prev = JSON.parse(fs.readFileSync(OUT, "utf8"));
    priorRows = Array.isArray(prev.rows) ? prev.rows : [];
    const done = new Set(priorRows.map((r) => r.poi));
    POIS = POIS.filter((p) => !done.has(p));
    console.error(`[battery] resume: ${priorRows.length} prior rows kept, ${POIS.length} POIs remain`);
  } catch (_) { priorRows = []; }
}
if (POIS.length === 0) {
  console.log("BATTERY SUMMARY: nothing to do (all POIs already recorded)");
  process.exit(0);
}

let page, helpers, closeFn;
if (MODE === "local") {
  const BOOT_MJS = process.env.BOOT_MJS ||
    "/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/harness/lib/boot.mjs";
  const boot = await import(pathToFileURL(BOOT_MJS).href);
  const query = { nosw: "1" };
  if (EXTRA_QUERY) for (const [k, v] of new URLSearchParams(EXTRA_QUERY)) query[k] = v;
  const r = await boot.launchAndEnter({ query, timeoutMs: 120_000 });
  if (!r.inWorld) { console.log("BATTERY SUMMARY: SKIP boot-stalled"); await r.helpers.close(); process.exit(2); }
  page = r.page; helpers = r.helpers; closeFn = () => helpers.close();
} else {
  // cdp: attach to the interactive-session Chrome on the 1070. NEVER close
  // the browser (a person's machine) — close only OUR page.
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  let pw;
  try { pw = require("playwright-core"); } catch (_) {
    // runbook fallback: the npx cache install
    const home = process.env.HOME;
    const hits = fs.readdirSync(`${home}/.npm/_npx`).map((d) => `${home}/.npm/_npx/${d}/node_modules/playwright-core`).filter((p) => fs.existsSync(p));
    if (!hits.length) { console.error("playwright-core not found"); process.exit(2); }
    pw = require(hits[0]);
  }
  const browser = await pw.chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0] ?? (await browser.newContext());
  page = await ctx.newPage();
  const q = new URLSearchParams({
    renderer: "3d", autoLogin: "1", account: ACCOUNT, password: ACCOUNT,
    autoSpawn: "first", kickDance: "1", nosw: "1",
  });
  if (EXTRA_QUERY) for (const [k, v] of new URLSearchParams(EXTRA_QUERY)) q.set(k, v);
  await page.goto(`http://127.0.0.1:8765/apps/holtburger-web/index.html?${q}`, { timeoutMs: 60_000 });
  // Poll in-world; ⚠ helper attach waits need 'ready', but the battery only
  // uses sendChat/getLocalPlayerPose, live at 'in-world'.
  let inWorld = false;
  for (let i = 0; i < 240; i++) {
    // eslint-disable-next-line no-await-in-loop
    const bs = await page.evaluate(() => window.__bootState).catch(() => null);
    if (bs === "in-world" || bs === "ready") { inWorld = true; break; }
    if (bs === "error") break;
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(1000);
  }
  if (!inWorld) { console.log("BATTERY SUMMARY: SKIP boot-stalled (cdp)"); await page.close(); process.exit(2); }
  // Real-GPU assert (MODE2i contract): SSH-launched Chrome silently falls
  // back to no-GL; only the interactive-session launch gives ANGLE/D3D11.
  const gpu = await page.evaluate(() => {
    try {
      const c = document.createElement("canvas");
      const gl = c.getContext("webgl2") || c.getContext("webgl");
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      return gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
    } catch (e) { return "ERR:" + e; }
  }).catch(() => "ERR:eval");
  console.error(`[battery] UNMASKED_RENDERER = ${gpu}`);
  if (!/NVIDIA|GTX|Direct3D/i.test(String(gpu))) {
    console.log(`BATTERY SUMMARY: SKIP not-real-GPU (${gpu})`);
    await page.close(); process.exit(2);
  }
  helpers = { evalInPage: (fn, ...a) => page.evaluate(fn, ...a) };
  closeFn = () => page.close(); // page only; the browser stays for its owner
}

for (let i = 0; i < 90; i++) {
  if (await helpers.evalInPage(() => !!(window.liveScene3d && window.liveScene3d.scene))) break;
  await page.waitForTimeout(1000);
}
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

// Crash/hang hardening (2026-07-10, learned on the first full cycle): a
// SwiftShader renderer death mid-cycle either THROWS from evaluate ("Target
// crashed" — arm 1, stop 43) or HANGS it forever (arm 2, stop 13). Race
// every evaluate against a 15 s timer, and on any failure abort the arm but
// WRITE THE PARTIAL JSON — 40 comparable stops beat 0.
const EVAL_TIMEOUT_MS = 15_000;
const raced = (p) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error("eval-timeout (renderer dead?)")), EVAL_TIMEOUT_MS)),
]);
const sample = () => raced(helpers.evalInPage(() => {
  const s = window.liveScene3d;
  let pose = null; try { pose = window.__sessionHandle.getLocalPlayerPose(); } catch (_) {}
  const st = s?.landblockLru?.getStats?.() ?? {};
  return {
    lb: pose?.landblockId != null ? (pose.landblockId >>> 0) : null,
    terr: s?.terrainBakedLbs?.size ?? 0,
    stat: s?.staticsGroup?.children?.length ?? 0,
    cells: s?.cellContainers3d?.size ?? 0,
    lru: st.resident ?? null, parked: st.parked ?? null,
    parkedTotal: st.parkedTotal ?? null, unparkedTotal: st.unparkedTotal ?? null,
    evicted: st.evicted ?? null,
  };
}));
const chat = (c) => raced(helpers.evalInPage((cmd) => { try { window.__sessionHandle.sendChat(cmd); } catch (_) {} }, c));

const rows = [];
let aborted = null;
const cycleT0 = Date.now();
for (const poi of POIS) {
  try {
  const before = await sample();
  const t0 = Date.now();
  await chat("@telepoi " + poi);
  // land = landblock changed (high-16 OR full id — dungeons can share hi16)
  let landed = false, landMs = null;
  for (let i = 0; i < 48; i++) {
    await page.waitForTimeout(250);
    const s = await sample();
    if (s.lb != null && before.lb != null && s.lb !== before.lb) { landed = true; landMs = Date.now() - t0; break; }
  }
  let settleMs = null, last = null, stable = 0, endStats = null;
  if (landed) {
    const s0 = Date.now();
    for (let i = 0; i < (DWELL_MAX_S * 2); i++) {
      await page.waitForTimeout(500);
      const s = await sample();
      const key = `${s.terr}|${s.stat}|${s.cells}`;
      stable = key === last ? stable + 1 : 0;
      last = key;
      endStats = s;
      if (stable >= 3) { settleMs = Date.now() - s0 - 1500; break; }
    }
    if (settleMs == null) settleMs = DWELL_MAX_S * 1000; // never settled: cap
    if (SHOTS && page.screenshot) {
      try {
        await page.screenshot({ path: path.join(SHOTS, `${poi.replace(/[^A-Za-z0-9-]/g, "_")}.png`) });
      } catch (_) {}
    }
  }
  rows.push({ poi, landed, landMs, settleMs, ...(endStats ?? {}) });
  console.error(`[battery] ${poi}: landed=${landed} land=${landMs}ms settle=${settleMs}ms lru=${endStats?.lru} parked=${endStats?.parked}`);
  } catch (e) {
    aborted = `${poi}: ${e?.message ?? e}`;
    console.error(`[battery] ABORT at ${poi}: ${aborted} — writing partial results`);
    break;
  }
}
const cycleMs = Date.now() - cycleT0;

const allRows = [...priorRows, ...rows];
const ok = allRows.filter((r) => r.landed);
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const summary = {
  label: LABEL, mode: MODE, query: EXTRA_QUERY || null,
  pois: priorRows.length + POIS.length,
  aborted, attempted: allRows.length,
  landed: ok.length, cycleMs,
  // Restart-proof cycle figure: active teleport+settle time summed over all
  // rows (excludes boot/relaunch overhead, comparable across resumed arms).
  activeMsSum: ok.reduce((a, r) => a + (r.landMs ?? 0) + (r.settleMs ?? 0), 0),
  landMedianMs: med(ok.map((r) => r.landMs)),
  settleMedianMs: med(ok.map((r) => r.settleMs)),
  settleCapped: ok.filter((r) => r.settleMs >= DWELL_MAX_S * 1000).length,
  final: allRows[allRows.length - 1] ?? null,
};
if (OUT) fs.writeFileSync(OUT, JSON.stringify({ summary, rows: allRows }, null, 2));
console.log(JSON.stringify(summary));
console.log(`BATTERY SUMMARY: ${LABEL} pois=${summary.landed}/${summary.pois} ` +
  `active=${(summary.activeMsSum / 1000).toFixed(1)}s landMed=${summary.landMedianMs}ms ` +
  `settleMed=${summary.settleMedianMs}ms capped=${summary.settleCapped}` +
  (aborted ? ` ABORTED(${aborted})` : ""));
try { await raced(closeFn()); } catch (_) { /* dead browser — exit anyway */ }
process.exit(aborted ? 3 : summary.landed === summary.pois ? 0 : 1);
