// walk-stall-attrib.mjs — WHAT IS IN THE 1.1-1.4 SECOND TASKS?
//
// THE QUESTION. A 30 s walk loses 3.4-6.3 s of main thread to 10-16 long tasks
// (worst single task 1.1-1.4 s); standing loses ZERO. Six candidate causes have
// been priced and are dead or small — shadows (0.02 ms/frame, shadowMap.enabled
// is false), the staticsGroup matrix freeze (no win), renderer.sortObjects=false
// (loses), the 196 MB atlas re-upload (0.12 ms/frame of CPU), the bake geometry
// path (0.04 ms/frame), renderer.compile (0.7 ms/frame). Together they explain
// ~390 ms of 6,320 ms. ~94% of the stall time is unattributed.
//
// THE METHOD — attribution, not another candidate. Run the CDP sampling profiler
// across the walk, record every longtask's [startTime, duration], then bucket
// each profiler SAMPLE by whether it lands inside a stall window. Aggregating
// self-time INSIDE the stalls says what the stall IS. This is the instrument the
// chain has never had: cpu-profile-probe.mjs profiles a settled pose, where the
// stalls do not exist.
//
// CLOCK ALIGNMENT (the one subtle bit). Profiler.stop returns startTime/endTime
// and timeDeltas in MICROSECONDS on its own monotonic clock; longtask entries use
// performance.now() MILLISECONDS. We stamp performance.now() immediately after
// Profiler.start and treat that as the profile's t0, so
//     sample_js_ms = t0_js + (cumulative timeDeltas)/1000
// Skew is one CDP round trip (a few ms) against 1,100+ ms stalls — harmless here,
// but do NOT reuse this alignment to reason about sub-10 ms events.
//
// V8 SYNTHETIC NODES ARE THE POINT: "(garbage collector)", "(program)" (V8's own
// compiler/runtime) and "(idle)" are real answers. If the stall is GC, this prints
// it. Do not narrate a cause the samples do not show.
//
// USAGE   node walk-stall-attrib.mjs
//         POI=Arwic WALK_MS=45000 node walk-stall-attrib.mjs
// Tunnel + interactive-GPU chrome required — see walk-bake-probe.mjs's header.
// READ walk.mjs's HEADER FIRST (abort-if-you-didn't-walk, the 150 s login slot).

import fs from "node:fs";
import { assertRealGpu, phase } from "./walk.mjs";

const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);
const _pw = fs.readdirSync(`${process.env.HOME}/.npm/_npx`)
  .map((d) => `${process.env.HOME}/.npm/_npx/${d}/node_modules/playwright-core`)
  .filter((p) => fs.existsSync(p));
if (!_pw.length) throw new Error("playwright-core not found under ~/.npm/_npx");
const { chromium } = require(_pw[0]);

const CDP = process.env.CDP || "http://127.0.0.1:9333";
const POI = process.env.POI || "Holtburg";
const WALK_MS = Number(process.env.WALK_MS || 30000);
const SETTLE_MS = Number(process.env.SETTLE_MS || 25000);
const INTERVAL_US = Number(process.env.INTERVAL_US || 200);
const OUT = process.env.OUT || "/mnt/wbterminal2/tmp/walk-stall-attrib.json";
const BASE = "http://127.0.0.1:8765/apps/holtburger-web/index.html";
const log = (...a) => console.error("[stall]", ...a);

const browser = await chromium.connectOverCDP(CDP);
const page = await browser.contexts()[0].newPage();
try {
  await page.goto("about:blank");
  const gpu = await assertRealGpu(page);
  log("GPU:", gpu);

  const url = `${BASE}?${new URLSearchParams({
    nosw: "1", autoLogin: "1", account: "phase4demo", password: "phase4demo",
    autoSpawn: "first", agent: "1",
    bridge_url: "ws://127.0.0.1:8080/", server_host: "127.0.0.1", server_port: "9000",
  })}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => window.__sessionHandle && window.liveScene3d, null, { timeout: 120000, polling: 500 });
  await page.evaluate(async (poi) => {
    const h = window.__sessionHandle;
    h.sendChat(`@telepoi ${poi}`);
    const t0 = Date.now(); const lb0 = h.getLocalPlayerPose()?.landblockId;
    while (Date.now() - t0 < 30000) {
      await new Promise((r) => setTimeout(r, 500));
      if (h.getLocalPlayerPose()?.landblockId !== lb0) break;
    }
  }, POI);
  log(`settling ${SETTLE_MS} ms at ${POI}…`);
  await page.waitForTimeout(SETTLE_MS);

  // record long tasks with their windows (keep them across the walk)
  await page.evaluate(() => {
    window.__stalls = [];
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        window.__stalls.push({
          start: e.startTime, dur: e.duration,
          attribution: (e.attribution || []).map((a) => `${a.name}/${a.containerType}${a.containerName ? ":" + a.containerName : ""}`),
        });
      }
    }).observe({ entryTypes: ["longtask"] });
  });

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: INTERVAL_US });
  await cdp.send("Profiler.start");
  const t0js = await page.evaluate(() => performance.now());   // profile t0 in page clock

  const walk = await phase(page, "walk", { walkMs: WALK_MS, log });

  const { profile } = await cdp.send("Profiler.stop");
  const stalls = await page.evaluate(() => window.__stalls);

  // ---- align samples to the page clock ----
  const nodeById = new Map(profile.nodes.map((n) => [n.id, n]));
  const label = (n) => {
    const cf = n.callFrame;
    const fn = cf.functionName || "(anon)";
    const file = (cf.url || "").split("/").pop();
    return file ? `${fn} ${file}:${cf.lineNumber}` : fn;
  };
  const bucketOf = (n) => {
    const u = n.callFrame.url || "";
    const fn = n.callFrame.functionName || "";
    if (/^\(garbage collector\)$/.test(fn)) return "GC";
    if (/^\(program\)$/.test(fn)) return "V8 (program/compile)";
    if (/^\(idle\)$/.test(fn)) return "idle";
    if (/three/.test(u)) return "three";
    if (/holtburger_web|\.wasm/.test(u)) return "wasm/rust";
    if (/scene3d|index\.html|plugins/.test(u)) return "app";
    if (u === "") return "native";
    return "other";
  };

  const times = [];
  let acc = 0;
  for (const d of profile.timeDeltas) { acc += d; times.push(acc); }   // µs since profile.startTime
  const sampleJsMs = times.map((us) => t0js + us / 1000);

  const inStall = (t) => stalls.find((s) => t >= s.start && t <= s.start + s.dur);

  const agg = { stall: new Map(), normal: new Map() };
  const bucketAgg = { stall: new Map(), normal: new Map() };
  const perStall = new Map();
  let nStall = 0, nNormal = 0;

  for (let i = 0; i < profile.samples.length; i++) {
    const n = nodeById.get(profile.samples[i]);
    if (!n) continue;
    const t = sampleJsMs[i];
    const s = inStall(t);
    const where = s ? "stall" : "normal";
    if (s) nStall++; else nNormal++;
    const L = label(n), B = bucketOf(n);
    agg[where].set(L, (agg[where].get(L) || 0) + 1);
    bucketAgg[where].set(B, (bucketAgg[where].get(B) || 0) + 1);
    if (s) {
      const k = `${s.start.toFixed(0)}+${s.dur.toFixed(0)}ms`;
      if (!perStall.has(k)) perStall.set(k, new Map());
      const m = perStall.get(k);
      m.set(L, (m.get(L) || 0) + 1);
    }
  }

  const ms = (hits) => +(hits * INTERVAL_US / 1000).toFixed(0);
  const top = (m, total, k = 15) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k)
    .map(([fn, h]) => ({ fn, pct: +(100 * h / (total || 1)).toFixed(1), ms: ms(h) }));

  const biggest = [...perStall.entries()].sort((a, b) =>
    Number(b[0].split("+")[1].replace("ms", "")) - Number(a[0].split("+")[1].replace("ms", "")))[0];

  const result = {
    gpu, poi: POI,
    walk: {
      distYds: walk.distYds, lbsVisited: walk.lbsVisited, fps_median: walk.fps_median,
      frameMs_p99: walk.frameMs_p99, frameMs_max: walk.frameMs_max,
      longTasks: walk.longTasks, longTaskMsTotal: walk.longTaskMsTotal, longTaskMax: walk.longTaskMax,
    },
    stallWindows: stalls.map((s) => ({ start: +s.start.toFixed(0), dur: +s.dur.toFixed(0), attribution: s.attribution })),
    samples: { inStall: nStall, outside: nNormal, intervalUs: INTERVAL_US,
      stallMsSampled: ms(nStall), outsideMsSampled: ms(nNormal) },
    bucketsInStall: [...bucketAgg.stall.entries()].sort((a, b) => b[1] - a[1])
      .map(([b, h]) => ({ bucket: b, pct: +(100 * h / (nStall || 1)).toFixed(1), ms: ms(h) })),
    bucketsOutside: [...bucketAgg.normal.entries()].sort((a, b) => b[1] - a[1])
      .map(([b, h]) => ({ bucket: b, pct: +(100 * h / (nNormal || 1)).toFixed(1), ms: ms(h) })),
    topInStall: top(agg.stall, nStall, 20),
    topOutside: top(agg.normal, nNormal, 10),
    biggestStall: biggest ? { window: biggest[0], top: top(biggest[1], [...biggest[1].values()].reduce((a, b) => a + b, 0), 15) } : null,
  };

  console.log(JSON.stringify(result, null, 2));
  try { fs.writeFileSync(OUT, JSON.stringify(result, null, 2)); log("wrote", OUT); } catch (e) { log("write failed:", e.message); }
} finally {
  await page.close().catch(() => {});
  await browser.close().catch(() => {});
}
