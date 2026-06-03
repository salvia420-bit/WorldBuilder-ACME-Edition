#!/usr/bin/env node
//
// fleet.mjs — multi-session-per-chromium orchestrator for the wire-agent
//
// Boots N wire-agent sessions in ONE chromium browser context (vs N
// separate chromiums). Each session gets its own page, its own wasm
// session handle, its own scene-graph; they share the V8 runtime, JIT
// caches, and chrome's process overhead. Empirically ~30-40% less RSS
// per agent vs N separate browsers, and faster spin-up because we pay
// the chromium launch cost once.
//
// Use cases:
//   1. Density baseline ("can 4/8/16 agents fit on this VM?")
//   2. Batch landblock validation (each agent in a different LB)
//   3. Coordinated multi-player scenarios (PvP/fellowship/trade) when
//      sessions need to share a JS-level orchestrator that observes
//      both ends without going through the wire.
//
// NOT what multi-session unlocks:
//   - Diagnostics for "WB.Terminal says X exists, in-game X is missing"
//     — that's an observed-vs-expected diff problem; the lever is an
//     in-browser oracle + failure-mode taxonomy, not parallel sessions.
//
// Usage:
//   node fleet.mjs --agents=4
//   node fleet.mjs --agents=4 --flags="netDrainHz=30&nullRender=1"
//   node fleet.mjs --agents=8 --flags="renderScale=0.5" --label=density-8

import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { totalmem } from "node:os";

// --- args ------------------------------------------------------------
function parseArgs(argv) {
  const args = { agents: 4, flags: "", label: "", base: "http://127.0.0.1:8765" };
  for (const arg of argv.slice(2)) {
    const m = arg.match(/^--([a-z]+)=(.*)$/);
    if (!m) continue;
    if (m[1] === "agents") args.agents = parseInt(m[2], 10);
    else args.label = m[1] === "label" ? m[2] : args.label;
    if (m[1] === "flags") args.flags = m[2];
    if (m[1] === "base") args.base = m[2];
  }
  return args;
}

const args = parseArgs(process.argv);

// Clamp agent count to what this box's RAM can hold. Each wire-agent page + its
// swiftshader renderer is ~1-1.5GiB; on an 8GB laptop >3 over-commits swap and
// froze the box (2026-06-03 OOM). Big boxes (1070/cloud) are left untouched.
// Run inside the wireagent cgroup (capped-wireagent) for the hard backstop.
const _totalGiB = totalmem() / 1024 ** 3;
const _agentCap = _totalGiB <= 9 ? 3 : args.agents;
if (args.agents > _agentCap) {
  console.warn(`[fleet] clamping agents ${args.agents} -> ${_agentCap} (only ${_totalGiB.toFixed(1)}GiB RAM; >${_agentCap} over-commits here)`);
  args.agents = _agentCap;
}

const TS = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = `/mnt/wbterminal1/tmp/claude-scratch/multi-agent/${args.label || "run"}-${TS}`;
await mkdir(OUT, { recursive: true });

// Worker-fleet preset: composes wire-agent with all five companion flags.
// Caller can extend or override via --flags="...".
const PRESET = "autoLogin=1&autoSpawn=first&renderer=3d&quality=low"
  + "&kickDance=1&agentic=low&wireframe=1&hud=none&plugins=none"
  + "&renderOnDemand=1&netDrainHz=30";

// Rotating accounts to avoid ACE's 45s logout window on rapid relogin
// of the same character. Password = accountname for all (Config.js
// AllowAutoAccountCreation: true + DefaultAccessLevel: 4).
const ACCOUNTS = ["phase4demo", "phase4demo_2a6", "acadmp1ge522", "tailnet1"];

// Headless-shell Chromium with the SwiftShader-enabling launch args.
const CHROME = "/home/wbterminal/.cache/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-linux64/chrome-headless-shell";
const CHROME_ARGS = [
  "--use-gl=swiftshader",
  "--enable-unsafe-swiftshader",
  "--disable-gpu-sandbox",
  "--ignore-gpu-blocklist",
  "--no-sandbox",
];

// --- launch ----------------------------------------------------------
const t_launch = Date.now();
const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: CHROME_ARGS,
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
console.log(`[fleet] chromium launched in ${Date.now() - t_launch}ms`);

// Always tear down the headless chromium — on Ctrl-C, `kill`/earlyoom SIGTERM,
// or an uncaught error — so a killed fleet run never orphans ~1.5GiB
// chrome-headless-shell processes that accumulate across runs.
let _closing = false;
const _teardown = async (code) => {
  if (_closing) return;
  _closing = true;
  try { await browser.close(); } catch { /* already gone */ }
  if (code !== undefined) process.exit(code);
};
process.on("SIGINT", () => _teardown(130));
process.on("SIGTERM", () => _teardown(143));
process.on("uncaughtException", (e) => { console.error("[fleet] uncaught:", e); _teardown(1); });

const agents = [];
for (let i = 0; i < args.agents; i++) {
  const acct = ACCOUNTS[i % ACCOUNTS.length];
  const url = `${args.base}/apps/holtburger-web/index.html?${PRESET}`
    + `&account=${acct}&password=${acct}`
    + (args.flags ? `&${args.flags}` : "");
  const page = await ctx.newPage();
  const consoleLines = [];
  page.on("console", (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
  page.on("pageerror", (e) => consoleLines.push(`[pageerror] ${e.message}`));
  agents.push({ id: i, acct, url, page, consoleLines, t0: 0, tBoot: -1, ready: false });
}

// Kick off all N boots in parallel, then wait for each to reach "ready".
const t_boot = Date.now();
await Promise.all(agents.map(async (a) => {
  a.t0 = Date.now();
  try {
    await a.page.goto(a.url, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch (e) {
    a.error = "goto: " + e.message;
    return;
  }
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const s = await a.page.evaluate(() => window.__bootState).catch(() => null);
    if (s === "ready") { a.ready = true; break; }
    if (s === "error") { a.error = "boot state = error"; break; }
    await a.page.waitForTimeout(200);
  }
  a.tBoot = Date.now() - a.t0;
}));
console.log(`[fleet] all ${args.agents} boots complete in ${Date.now() - t_boot}ms (wall)`);

// Settle: give each agent ~2s for the async _spawnImpl chain to drain
// the KIND_SPAWN backlog into entityMap before snapshotting. Without
// this, fast-booting agents show entityMapSize=0 even though spawns
// are in flight (entities.js:802 _spawnImpl awaits animation cache +
// material preload). 2s is generous for ~10 nearby NPCs; bump if you
// see partial counts.
await Promise.all(agents.filter((a) => a.ready).map((a) => a.page.waitForTimeout(2000)));

// Per-agent post-boot capture: scene state + screenshot.
for (const a of agents) {
  if (!a.ready) {
    console.log(`  agent[${a.id}] (${a.acct}) FAILED: ${a.error ?? "unknown"}`);
    await writeFile(join(OUT, `agent-${a.id}.console.log`), a.consoleLines.join("\n"));
    continue;
  }
  const stats = await a.page.evaluate(() => {
    const em = window.liveScene3d?.entityManager;
    return {
      bootState: window.__bootState,
      entityMapSize: em?.entityMap?.size ?? -1,
      spawnCount: em?.spawnCount ?? -1,
      frameCount: window.liveScene3d?.renderer?.info?.render?.frame ?? -1,
      sessionHandleExists: !!window.__sessionHandle,
      renderOnceExists: typeof window.__renderOnce === "function",
      netDrainAttached: !!window.__netDrainInterval,
    };
  });
  await a.page.screenshot({ path: join(OUT, `agent-${a.id}.png`), fullPage: false });
  await writeFile(join(OUT, `agent-${a.id}.console.log`), a.consoleLines.slice(-200).join("\n"));
  a.stats = stats;
  console.log(`  agent[${a.id}] (${a.acct}) boot=${a.tBoot}ms entities=${stats.entityMapSize} spawns=${stats.spawnCount}`);
}

// Aggregate report.
const successful = agents.filter((a) => a.ready);
const failed = agents.filter((a) => !a.ready);
const bootTimes = successful.map((a) => a.tBoot).sort((x, y) => x - y);
const median = bootTimes.length ? bootTimes[Math.floor(bootTimes.length / 2)] : -1;
const max = bootTimes.length ? bootTimes[bootTimes.length - 1] : -1;
const min = bootTimes.length ? bootTimes[0] : -1;

const report = {
  ts: TS,
  args,
  preset: PRESET,
  agentCount: args.agents,
  successful: successful.length,
  failed: failed.length,
  bootMs: { median, min, max },
  agents: agents.map((a) => ({
    id: a.id, acct: a.acct, tBoot: a.tBoot, ready: a.ready,
    error: a.error ?? null, stats: a.stats ?? null,
  })),
};
await writeFile(join(OUT, "report.json"), JSON.stringify(report, null, 2));

console.log(`\n[fleet] results: ${successful.length}/${args.agents} ready`);
console.log(`[fleet] boot median=${median}ms min=${min}ms max=${max}ms`);
console.log(`[fleet] OUT=${OUT}`);

await browser.close();
process.exit(failed.length > 0 ? 1 : 0);
