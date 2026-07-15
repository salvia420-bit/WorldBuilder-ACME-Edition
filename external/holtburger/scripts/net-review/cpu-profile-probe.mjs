// cpu-profile-probe — STOP GUESSING WHAT THE 25ms IS. Sample it.
//
// WHY THIS EXISTS. Four sessions have named a cause for the frame's CPU cost
// from deltas rather than from a profile, and every one of them died:
//   "the win is fill rate"            -> refuted (it was CPU submission)
//   "~66us/draw => needsUpdate churn" -> dissolved (a broken denominator)
//   "BatchedMesh's per-frame walk"    -> refuted by its own A/B (1.6ms, noise)
// And now the draw-count model itself is wobbling: ?walkInInstance cuts TRUE
// draws 7,562 -> 2,762 (-63%) and renderCPU only moves ~25.0 vs ~28.5ms (-13%).
// A 63% cut in the thing we believe is the cost should not buy 13%. So either
// the draws are not the cost, or they are only part of it.
//
// Chrome's sampling profiler answers this directly and nobody in this chain has
// run one. This probe takes a V8 CPU profile of a settled Holtburg and prints
// the top SELF-time functions, plus the share attributable to three's
// render/submit path. No hypothesis, no arms — just where the cycles go.
//
// Read the output as: "self" = time IN that function excluding callees. The
// question it settles is whether renderCPU is dominated by WebGL binding calls
// (draw submission), by renderList/projectObject (scene walk, scales with NODE
// count not draw count), by material/program resolution, or by app JS.
//
// EXTRA_Q="walkInInstance=on" profiles the instanced arm — compare the two
// profiles rather than their totals.
import fs from "node:fs";
import { settleAt, WEATHER_OFF } from "./settle.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const hits = fs.readdirSync(`${process.env.HOME}/.npm/_npx`)
    .map((d) => `${process.env.HOME}/.npm/_npx/${d}/node_modules/playwright-core`)
    .filter((p) => fs.existsSync(p));
  const pw = require(hits[0]);
  const browser = await pw.chromium.connectOverCDP("http://127.0.0.1:9333");
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();

  const q = new URLSearchParams({
    renderer: "3d", autoLogin: "1", account: "tailnet1", password: "tailnet1",
    autoSpawn: "first", nosw: "1", particleInstancing: "off", ...WEATHER_OFF,
    ...(process.env.EXTRA_Q ? Object.fromEntries(new URLSearchParams(process.env.EXTRA_Q)) : {}),
  });
  const bail = async (msg, code) => {
    console.error(`[cp] ${msg}`);
    await page.close().catch(() => {});
    process.exit(code);
  };

  await page.goto(`http://127.0.0.1:8765/apps/holtburger-web/index.html?${q}`, { timeout: 60000 });
  for (let i = 0; i < 240; i++) {
    const bs = await page.evaluate(() => window.__bootState).catch(() => null);
    if (bs === "in-world" || bs === "ready") break;
    if (bs === "error") await bail("boot error (account still held? wait 150s)", 3);
    await sleep(1000);
  }
  for (let i = 0; i < 90; i++) {
    if (await page.evaluate(() => !!(window.liveScene3d?.scene)).catch(() => false)) break;
    await sleep(1000);
  }
  const gpu = await page.evaluate(() => {
    try {
      const c = document.createElement("canvas");
      const gl = c.getContext("webgl2") || c.getContext("webgl");
      return gl.getParameter(gl.getExtension("WEBGL_debug_renderer_info").UNMASKED_RENDERER_WEBGL);
    } catch (e) { return `err:${e.message}`; }
  }).catch(() => null);
  console.error(`[cp] GPU: ${gpu}`);
  if (!/GTX 1070/.test(gpu || "")) await bail(`not the 1070 GPU (${gpu})`, 5);

  const s = await settleAt(page, process.env.POI || "Holtburg",
    { log: (m) => console.error(`[cp] ${m}`), pinPose: process.env.PIN_POSE || null });
  if (!s.settled) await bail("not settled; abort", 4);

  const SECS = +(process.env.PROFILE_S || 12);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 100 }); // 100us — fine enough for a 25ms frame
  await cdp.send("Profiler.start");
  console.error(`[cp] profiling ${SECS}s …`);
  await sleep(SECS * 1000);
  const { profile } = await cdp.send("Profiler.stop");

  // Self time per node: V8 gives hitCount per node and a sample interval.
  const byNode = new Map();
  for (const n of profile.nodes) byNode.set(n.id, n);
  const totalHits = profile.nodes.reduce((a, n) => a + (n.hitCount || 0), 0);
  const durUs = profile.endTime - profile.startTime;
  const usPerHit = totalHits ? durUs / totalHits : 0;

  const key = (n) => {
    const f = n.callFrame;
    const fn = f.functionName || "(anonymous)";
    const url = (f.url || "").split("/").pop() || "(native)";
    return `${fn} @ ${url}:${f.lineNumber + 1}`;
  };
  const self = new Map();
  for (const n of profile.nodes) {
    if (!n.hitCount) continue;
    const k = key(n);
    self.set(k, (self.get(k) || 0) + n.hitCount);
  }
  const rows = [...self.entries()].sort((a, b) => b[1] - a[1]);
  const frames = await page.evaluate(() => window.__cpFrames || 0).catch(() => 0);

  console.error(`[cp] ==========================================================`);
  console.error(`[cp] ${totalHits} samples over ${(durUs / 1000).toFixed(0)}ms (~${usPerHit.toFixed(0)}us/sample)`);
  console.error(`[cp] TOP SELF-TIME (share of ALL JS+native samples, main thread):`);
  for (const [k, hits] of rows.slice(0, 25)) {
    const pct = (100 * hits / totalHits).toFixed(1);
    console.error(`[cp]   ${String(pct).padStart(5)}%  ${k}`);
  }
  // Bucket by module so the shape is readable at a glance.
  const buckets = { "three (render/submit)": 0, "app scene3d": 0, "wasm/holtburger": 0, "(program/idle)": 0, other: 0 };
  for (const [k, hits] of rows) {
    if (/three\.(module|core)\.js/.test(k)) buckets["three (render/submit)"] += hits;
    else if (/holtburger_web|wasm/.test(k)) buckets["wasm/holtburger"] += hits;
    else if (/\.js:\d+/.test(k) && /(index|statics|entities|materials|particle|terrain|cells|adapter|atmosphere)/.test(k)) buckets["app scene3d"] += hits;
    else if (/\(program\)|\(idle\)|\(garbage collector\)/.test(k)) buckets["(program/idle)"] += hits;
    else buckets.other += hits;
  }
  console.error(`[cp] ---- by bucket ----`);
  for (const [b, hits] of Object.entries(buckets)) {
    console.error(`[cp]   ${b.padEnd(24)} ${(100 * hits / totalHits).toFixed(1)}%`);
  }
  console.error(`[cp] NOTE self-time excludes callees. "(program)" is typically native/GPU-driver`);
  console.error(`[cp] work reached through WebGL binding calls — if THAT dominates, the frame really`);
  console.error(`[cp] is submission-bound and the draw count matters; if the scene walk dominates, it is not.`);

  fs.writeFileSync(process.env.OUT || "/mnt/wbterminal2/tmp/cpu-profile.json",
    JSON.stringify({ poi: process.env.POI || "Holtburg", gpu, extraQ: process.env.EXTRA_Q || "", settle: s, frames, totalHits, durUs, top: rows.slice(0, 60), buckets }, null, 2));
  if (process.env.RAW) fs.writeFileSync(process.env.RAW, JSON.stringify(profile));
  await page.close();
  process.exit(0);
})();
