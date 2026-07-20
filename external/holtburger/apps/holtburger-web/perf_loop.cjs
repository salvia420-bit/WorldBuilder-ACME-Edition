#!/usr/bin/env node
// perf_loop.cjs — the driver for the explorer-mode performance loop.
//
//   The AI explorer roams (DISCOVERY, prompt-driven). This driver turns its
//   roaming into a self-feeding, prompt-PROOF improvement loop that hands THIS
//   Claude Code session a ranked offender to fix each turn, and then judges the
//   fix deterministically. The prompt decides only WHICH content gets sampled;
//   every verdict below is made by measurement, never by the model.
//
// Subcommands:
//   soak    --minutes N [--out F] [--emit MS] [--url U]   tap a live/booted page,
//             append driver-stamped [perfsample] lines to a JSONL. (DISCOVERY)
//   rank    --in F [--league F] [--json F]                jsonl -> ranked league
//             md + json; updates perf/loop-state.json topOffender. (pure, no browser)
//   measure --route F --runs N --out F [--label L] [--render wireframe|default]
//             replay a tour on the CURRENT build, N times, fresh profile per run;
//             writes per-run {routeMs,p95,draw,tri}. Run once per build. (MEASURE)
//   gate    --base F --cand F [--metric routeMs|p95] [--min PCT]
//             ACCEPT / REGRESSION / INCONCLUSIVE; appends to the tried ledger. (pure)
//   status                                               print loop-state for this session.
//
// Browser subcommands need Playwright on NODE_PATH:
//   /home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules
// Pure subcommands (rank/gate/status) need nothing and never touch the live soak.

const fs = require("fs");
const path = require("path");
const A = require("./perf/perf_aggregate.cjs");
const { SAMPLER_FN } = require("./perf/perf_sampler.cjs");

const HERE = __dirname;
const STATE_FILE = path.join(HERE, "perf", "loop-state.json");
const DEFAULT_LEAGUE = path.join(HERE, "docs", "rynth-integration", "perf-league.md");
// Base measurement URL: NO nullRender (we need real frames), nosw, autoLogin.
const BASE_URL = "http://127.0.0.1:8765/apps/holtburger-web/index.html";
const ACCOUNT = "tailnet1";

// ── tiny arg parser ─────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith("--")) { const k = t.slice(2); const v = (argv[i + 1] && !argv[i + 1].startsWith("--")) ? argv[++i] : true; a[k] = v; }
    else a._.push(t);
  }
  return a;
}
function die(msg) { console.error("perf_loop: " + msg); process.exit(1); }
function readJson(f, fallback) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return fallback; } }
function writeJson(f, obj) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(obj, null, 2)); }
function nowIso() { return new Date().toISOString(); }
function loadState() { return readJson(STATE_FILE, { updatedAt: null, topOffender: null, tried: [], lastVerdict: null, league: null, baselineRoute: null }); }
function saveState(s) { s.updatedAt = nowIso(); writeJson(STATE_FILE, s); }

// ── lazy Playwright (browser subcommands only) ──────────────────────────────
function loadPlaywright() {
  try { return require("playwright"); }
  catch (e) {
    die("Playwright not found. Run with:\n  NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules node perf_loop.cjs " + process.argv.slice(2).join(" "));
  }
}
function assertReleaseWasm() {
  const w = path.join(HERE, "pkg", "holtburger_web_bg.wasm");
  try {
    const mb = fs.statSync(w).size / 1e6;
    if (mb > 8) die("pkg wasm is " + mb.toFixed(1) + "MB — looks like a DEV build (~4× perf tax). Rebuild --release before measuring.");
    return mb;
  } catch (e) { die("no pkg/holtburger_web_bg.wasm — build the wasm first."); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Attach a [perfsample] console tap that stamps arrival wall-time. Returns the
// live array of stamped samples (the driver clock is the ONLY trusted clock).
function tapSamples(page) {
  const samples = [];
  const markers = [];
  page.on("console", (m) => {
    const txt = m.text();
    if (txt.startsWith("[perfsample] ")) {
      try { const s = JSON.parse(txt.slice(13)); s.wallT = Date.now(); samples.push(s); } catch (e) {}
    } else if (txt.startsWith("[perftour] ")) {
      markers.push({ txt: txt.slice(11), wallT: Date.now() });
    }
  });
  return { samples, markers };
}

// ── soak: tap a booted/live page into a JSONL (DISCOVERY) ────────────────────
async function cmdSoak(args) {
  const { chromium } = loadPlaywright();
  const minutes = parseFloat(args.minutes || "30");
  const emitMs = parseInt(args.emit || "10000", 10);
  const out = args.out || path.join(HERE, "perf", "samples-" + Date.now() + ".jsonl");
  const url = (args.url || (BASE_URL + "?nosw=1&nullRender=0&netDrainHz=30&autoLogin=1&account=" + ACCOUNT + "&password=" + ACCOUNT + "&autoSpawn=first"));
  const { bootInWorld } = require("./rynth_boot_helper.cjs");

  console.log("[soak] booting " + url);
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  const page = await bootInWorld(browser, url);
  const tap = tapSamples(page);
  await page.evaluate(SAMPLER_FN, { emitMs });
  console.log("[soak] sampler installed, emit every " + emitMs + "ms -> " + out);

  const stream = fs.createWriteStream(out, { flags: "a" });
  const flush = () => { while (tap.samples.length) stream.write(JSON.stringify(tap.samples.shift()) + "\n"); };
  const iv = setInterval(flush, 5000);
  const stop = async () => { clearInterval(iv); flush(); stream.end(); try { await page.evaluate(() => window.__perfSampler && window.__perfSampler.stop()); } catch (e) {} await browser.close(); };
  process.on("SIGINT", async () => { console.log("\n[soak] SIGINT — flushing"); await stop(); process.exit(0); });

  await sleep(minutes * 60_000);
  await stop();
  console.log("[soak] done -> " + out);
}

// ── rank: jsonl -> league md/json + loop-state topOffender (pure) ───────────
function cmdRank(args) {
  const inF = args.in || die("rank needs --in <samples.jsonl>");
  const text = fs.readFileSync(inF, "utf8");
  const { samples, dropped } = A.parseSamples(text);
  const ranked = A.rankByLandblock(samples, { minSamples: parseInt(args.minSamples || "2", 10) });
  if (!ranked.length) die("no landblocks met minSamples — soak longer or lower --minSamples");

  const leagueMd = args.league || DEFAULT_LEAGUE;
  const md = A.renderLeagueMarkdown(ranked, { source: path.basename(inF), total: samples.length, dropped, stamp: nowIso() });
  fs.mkdirSync(path.dirname(leagueMd), { recursive: true });
  fs.writeFileSync(leagueMd, md);
  const leagueJson = args.json || leagueMd.replace(/\.md$/, ".json");
  writeJson(leagueJson, { generatedAt: nowIso(), source: path.basename(inF), samples: samples.length, dropped, ranked });

  const state = loadState();
  const top = ranked[0];
  state.topOffender = { lb: top.lb, p95_med: top.p95_med, p95_worst: top.p95_worst, draw_med: top.draw_med, tri_med: top.tri_med, dwellSec: top.dwellSec, samples: top.samples };
  state.league = path.relative(HERE, leagueMd);
  state.next = "Profile landblock " + top.lb + " (p95 " + top.p95_med + "ms, " + top.draw_med + " draws/f, " + top.tri_med + " tris/f); implement a Rust-first fix in a worktree; then `measure` old vs new on the tour and `gate`.";
  saveState(state);

  console.log(md);
  console.log("\n[rank] " + ranked.length + " landblocks · " + samples.length + " samples (" + dropped + " dropped)");
  console.log("[rank] league -> " + path.relative(HERE, leagueMd) + " · json -> " + path.relative(HERE, leagueJson));
  console.log("[rank] loop-state topOffender -> " + top.lb);
}

// ── tour: auto-build a replayable perf-tour from samples (fork #1, pure) ─────
function cmdTour(args) {
  const inF = args.in || die("tour needs --in <samples.jsonl>");
  const { samples } = A.parseSamples(fs.readFileSync(inF, "utf8"));
  const ranked = A.rankByLandblock(samples, { minSamples: parseInt(args.minSamples || "2", 10) });
  const name = args.name || "perf-tour-v1";
  const tour = A.buildTour(ranked, { top: parseInt(args.top || "3", 10), control: parseInt(args.control || "1", 10), name });
  if (!tour.waypoints.length) die("no waypoints — samples predate pose emission, or no pose captured. Soak more.");
  const out = args.out || path.join(HERE, "rynth", "testdata", name + ".json");
  writeJson(out, tour);
  const state = loadState();
  state.baselineRoute = path.relative(HERE, out);
  saveState(state);
  console.log("[tour] " + tour.waypoints.length + " waypoints (offenders " + tour.offenders.join(",") + " + control " + tour.control.join(",") + ")" + (tour.dropped.length ? " · dropped " + tour.dropped.join(",") + " (no pose)" : ""));
  tour.waypoints.forEach((w, i) => console.log("  " + (i + 1) + ". " + w.forLb + " p95 " + w.p95 + "ms @ 0x" + (w.lb >>> 0).toString(16) + " (" + w.x.toFixed(0) + "," + w.y.toFixed(0) + ")"));
  console.log("[tour] -> " + path.relative(HERE, out) + " · loop-state baselineRoute set");
}

// ── measure: replay a tour N times on the current build (MEASURE) ────────────
async function cmdMeasure(args) {
  const routeF = args.route || die("measure needs --route <route.json>");
  const runs = parseInt(args.runs || "3", 10);
  const out = args.out || die("measure needs --out <arm.json>");
  const label = args.label || path.basename(out, ".json");
  const render = args.render === "default" ? "default" : "wireframe"; // wireframe = CPU/submission path
  const mb = assertReleaseWasm();
  const { chromium } = loadPlaywright();
  const { bootInWorld } = require("./rynth_boot_helper.cjs");

  const rf = readJson(routeF, null) || die("cannot read route " + routeF);
  const route = rf.route || rf; // accept {name,route} or a bare route
  // Two route kinds: a recorded leg route (followRoute) or an auto-built perf
  // tour of waypoints (goto-chain, fork #1).
  const isWaypoints = route.kind === "waypoints" || (Array.isArray(route.waypoints) && !route.legs);
  const legs = isWaypoints ? null : (route.legs || die("route has no legs"));
  const waypoints = isWaypoints ? route.waypoints : null;
  const fmt = route.schemaVersion || 2;
  const from = route.from || (legs && legs[0]) || (waypoints && waypoints[0]);
  const startCmd = "@teleloc 0x" + (from.lb >>> 0).toString(16) + " " + from.x + " " + from.y + " " + from.z;

  const wf = render === "wireframe" ? "&wireframe=1" : "";
  // Uncapped fps so improvements are visible above any kiosk cap; real frames.
  const url = BASE_URL + "?nosw=1&nullRender=0" + wf + "&netDrainHz=30&autoLogin=1&account=" + ACCOUNT + "&password=" + ACCOUNT + "&autoSpawn=first";

  console.log("[measure] " + label + " · " + render + " · release wasm " + mb.toFixed(1) + "MB · " + runs + " runs of " + (rf.name || path.basename(routeF)));
  const runMetrics = [];
  for (let r = 0; r < runs; r++) {
    // Fresh launch per run = fresh throwaway profile = cold shader cache parity.
    const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-gpu"] });
    try {
      const page = await bootInWorld(browser, url);
      const tap = tapSamples(page);
      await page.evaluate(SAMPLER_FN, { emitMs: 3000 });
      // Warmup + teleport to route start; let streaming settle before timing.
      await page.evaluate((c) => window.__bot.host.WriteToChat(c), startCmd);
      await sleep(12000);
      const t0 = tap.samples.length; // ignore warmup samples
      // Time via console markers, NOT the evaluate round-trip (starves on busy renderer).
      await page.evaluate(({ legs, waypoints, fmt }) => {
        console.log("[perftour] start");
        var done = (r) => console.log("[perftour] done " + JSON.stringify(r));
        if (waypoints) {
          // Goto-chain (fork #1): walk each offender waypoint in order.
          (async () => {
            var ok = 0;
            for (var i = 0; i < waypoints.length; i++) {
              var w = waypoints[i];
              try { var r = await window.__bot.goto({ lb: w.lb, x: w.x, y: w.y, z: w.z }); if (r && r.ok !== false) ok++; } catch (e) {}
            }
            return ok;
          })().then((ok) => done({ ok: ok > 0, wps: ok + "/" + waypoints.length })).catch((e) => done({ ok: false, err: String(e && e.message) }));
        } else {
          window.__bot.followRoute(legs, { label: "perf-tour", fmt })
            .then((res) => done({ ok: res && res.ok, legs: res && res.legsWalked }))
            .catch((e) => done({ ok: false, err: String(e && e.message) }));
        }
      }, { legs, waypoints, fmt });
      // Wait for the done marker (up to the route timeout).
      const deadline = Date.now() + 16 * 60_000;
      while (Date.now() < deadline && !tap.markers.some((m) => m.txt.startsWith("done"))) await sleep(1000);
      const startM = tap.markers.find((m) => m.txt === "start");
      const doneM = tap.markers.find((m) => m.txt.startsWith("done"));
      if (!doneM) { console.log("[measure] run " + (r + 1) + " NO done marker (timeout) — skipped"); continue; }
      const routeMs = doneM.wallT - (startM ? startM.wallT : doneM.wallT);
      const during = tap.samples.slice(t0);
      const p95pool = A._internal.sortedNums(during.map((s) => s.dt && s.dt.p95));
      const m = {
        run: r + 1,
        routeMs,
        p95: A._internal.quantile(p95pool, 50),
        draw: A._internal.median(during.map((s) => s.draw)),
        tri: A._internal.median(during.map((s) => s.tri)),
        samples: during.length,
        done: JSON.parse(doneM.txt.slice(5)),
      };
      runMetrics.push(m);
      console.log("[measure] run " + (r + 1) + "/" + runs + ": route " + (routeMs / 1000).toFixed(1) + "s · p95 " + m.p95 + "ms · " + m.draw + " draws/f");
    } finally { await browser.close(); }
    await sleep(75_000); // Account-In-Use: ACE server-side logout takes ~40s+
  }
  writeJson(out, { label, render, wasmMB: mb, route: rf.name || path.basename(routeF), at: nowIso(), runs: runMetrics });
  console.log("[measure] " + runMetrics.length + "/" + runs + " runs -> " + out);
}

// ── gate: judge candidate vs baseline (pure) ────────────────────────────────
function cmdGate(args) {
  const baseF = args.base || die("gate needs --base <arm.json>");
  const candF = args.cand || die("gate needs --cand <arm.json>");
  const base = readJson(baseF, null) || die("cannot read " + baseF);
  const cand = readJson(candF, null) || die("cannot read " + candF);
  const g = A.gate(base.runs, cand.runs, { metric: args.metric || "routeMs", minPct: parseFloat(args.min || "3") });
  console.log("\n=== GATE: " + g.verdict + " ===");
  console.log(JSON.stringify(g, null, 2));

  const state = loadState();
  state.lastVerdict = { at: nowIso(), base: base.label, cand: cand.label, result: g };
  state.tried = state.tried || [];
  state.tried.push({ at: nowIso(), lb: (state.topOffender && state.topOffender.lb) || null, cand: cand.label, verdict: g.verdict, improvePct: g.improvePct });
  saveState(state);
  console.log("\n[gate] recorded to loop-state (tried ledger now " + state.tried.length + " entries)");
  if (g.verdict !== "ACCEPT") process.exitCode = 2;
}

// ── status: what this session should do next ────────────────────────────────
function cmdStatus() {
  const s = loadState();
  console.log("=== perf loop state (" + (s.updatedAt || "never") + ") ===");
  console.log("league:        " + (s.league || "—"));
  console.log("baselineRoute: " + (s.baselineRoute || "—"));
  if (s.topOffender) console.log("TOP OFFENDER:  " + s.topOffender.lb + "  p95 " + s.topOffender.p95_med + "ms · " + s.topOffender.draw_med + " draws/f · " + s.topOffender.tri_med + " tris/f · dwell " + s.topOffender.dwellSec + "s");
  if (s.lastVerdict) console.log("last verdict:  " + s.lastVerdict.result.verdict + " (" + s.lastVerdict.cand + ", " + s.lastVerdict.result.improvePct + "%)");
  console.log("tried ledger:  " + ((s.tried && s.tried.length) || 0) + " candidate(s)");
  if (s.next) console.log("\nNEXT: " + s.next);
}

// ── main ────────────────────────────────────────────────────────────────────
(async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));
  try {
    if (cmd === "soak") await cmdSoak(args);
    else if (cmd === "rank") cmdRank(args);
    else if (cmd === "tour") cmdTour(args);
    else if (cmd === "measure") await cmdMeasure(args);
    else if (cmd === "gate") cmdGate(args);
    else if (cmd === "status") cmdStatus();
    else {
      console.log("usage: perf_loop.cjs <soak|rank|tour|measure|gate|status> [opts]  (see header)");
      if (cmd) process.exitCode = 1;
    }
  } catch (e) { die((e && e.stack) || String(e)); }
})();
