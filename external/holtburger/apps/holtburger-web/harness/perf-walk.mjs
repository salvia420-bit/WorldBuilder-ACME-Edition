// harness/perf-walk.mjs — ALL-FLAGS-ON functionality + performance smoke.
//
// Unlike the nullRender harness (boot.mjs), this does a REAL render so FPS /
// frame-spikes / draw-calls are meaningful. It logs in on tailnet1/tailnet1
// with the entire unified-pipeline flag set ON, walks for N seconds (default
// 300 = 5 min) driving real WASD, and polls metrics every 5s:
//   - FPS + frame-time spikes (in-page rAF recorder)
//   - draw calls / triangles / programs / scene+mesh nodes (window.__diag.render)
//   - JS heap (performance.memory) + total Chrome process RSS (ps)
//   - syncPhysicsTick diag (window.__syncTickDiag)
//   - console errors / pageerrors  (the functionality canary)
//
// CAVEAT: this box renders WebGL in SOFTWARE (SwiftShader) — absolute FPS/GPU
// are NOT representative of the GTX 1070. Draw-calls, node counts, heap, spikes,
// CPU pressure and FUNCTIONALITY (does all-on stay in-world for 5 min?) ARE
// meaningful here. Run on the 1070 for real GPU/FPS.
//
//   node harness/perf-walk.mjs [--seconds=300] [--headed]
//
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { PLAYWRIGHT_CACHE } from "./lib/boot.mjs";

const require = createRequire(import.meta.url);
const arg = (k, d) => {
  const h = process.argv.find((a) => a.startsWith(`--${k}=`));
  return h ? h.slice(k.length + 3) : d;
};
const DURATION_S = Number(process.env.WALK_SECONDS || arg("seconds", "300"));
const SAMPLE_MS = 5000;
const HEADED = process.argv.includes("--headed");
const SCRATCH = (() => {
  for (const d of ["/mnt/wbterminal1/tmp/claude-scratch", "/tmp/claude-scratch"]) {
    try { mkdirSync(d, { recursive: true }); return d; } catch {}
  }
  return "/tmp";
})();

// ── Every unified-pipeline flag ON + renderDiag/syncTickDiag. NO nullRender. ──
const FLAGS = [
  "renderer=3d", "autoLogin=1", "account=tailnet1", "password=tailnet1",
  "autoSpawn=first", "server_host=127.0.0.1", "server_port=9000",
  "renderDiag=on", "syncTickDiag=1",
  // A1/A2/A6/A8/A13 spine
  "unifiedTick=on", "posePublishPostTick=on", "syncPhysicsTick=on", "wireStatePacks=stage1",
  "worldLifecycle=on", "maintPrune=on", "unifiedTransition=on", "remoteInterp=on", "stickyRetail=on",
  // A14 input/jump/run
  "inputFunnel=on", "wasmPursuit=on", "jumpParity=on", "retailRunKeys=on",
  // A4/A5 anim
  "hookDrain=on", "mtQueue=on", "rootMotionObject=1", "getLink=on",
  // A9/A10 surface/rig
  "surfaceUnified=on", "surfaceParityV2=on", "placementId=on",
  // A11 particle
  "blockingParticleParity=on", "scriptQueue=on", "particleOwner=on",
  "defaultScriptSpawn=on", "particleDegrade=retail",
  // A12 camera + A8-M4
  "retailCamZoom=on", "camStiffness=0.5", "mouseSmooth=0.5", "preCreateBuffer=on",
  // exercise the entity-light pool (Problem-A path)
  "entityLights=on",
];
const URL = "http://127.0.0.1:8765/apps/holtburger-web/?" + FLAGS.join("&");

function loadChromium() {
  for (const p of ["playwright", `${PLAYWRIGHT_CACHE}/playwright`, `${PLAYWRIGHT_CACHE}/playwright-core`]) {
    try { return require(p).chromium; } catch {}
  }
  throw new Error("playwright chromium not loadable (run: npx -y playwright@1.59.1 install chromium)");
}

function chromeRssMB() {
  // Sum RSS (KB) of all chromium-family processes → MB.
  const r = spawnSync("sh", ["-c",
    `ps -eo rss=,comm=,args= | awk 'tolower($0) ~ /chrom|headless_shell/ && $0 !~ /awk|perf-walk/ {s+=$1} END{print s+0}'`],
    { encoding: "utf8" });
  return Math.round((Number((r.stdout || "0").trim()) || 0) / 1024);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pctile = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

async function main() {
  console.log(`[perf-walk] ${DURATION_S}s walk, all unified-pipeline flags ON, REAL render (software GL).`);
  console.log(`[perf-walk] scratch=${SCRATCH}`);
  const chromium = loadChromium();
  const browser = await chromium.launch({
    headless: !HEADED,
    args: [
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist",
      "--enable-precise-memory-info",
    ],
    env: { ...process.env, DISPLAY: process.env.DISPLAY || ":0" },
  });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 720 });

  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300)); });
  page.on("pageerror", (e) => pageErrors.push(String(e.message || e).slice(0, 300)));

  // rAF frame-time recorder, installed before any app script runs.
  await page.addInitScript(() => {
    window.__perf = { frames: [], last: null };
    const loop = () => {
      const now = performance.now();
      if (window.__perf.last != null) window.__perf.frames.push(now - window.__perf.last);
      window.__perf.last = now;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });

  console.log("[perf-walk] navigating…");
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 90000 });

  // Wait for in-world (mirror boot.mjs's detection).
  let inWorld = false;
  try {
    await page.waitForFunction(() => {
      const hist = Array.isArray(window.__bootStateHistory) ? window.__bootStateHistory : [];
      const reached = window.__bootState === "in-world" || hist.some((e) => e && e.state === "in-world");
      if (!reached) return false;
      const h = window.__sessionHandle;
      if (!h || typeof h.getLocalPlayerPose !== "function") return false;
      try { return h.getLocalPlayerPose() != null; } catch { return false; }
    }, { timeout: 90000, polling: 200 });
    inWorld = true;
  } catch { inWorld = false; }
  console.log(`[perf-walk] inWorld=${inWorld}  (errors so far: ${consoleErrors.length + pageErrors.length})`);

  // Focus the canvas so keyboard input reaches the app, then start walking.
  try { await page.click("canvas", { timeout: 3000 }); } catch { try { await page.click("body"); } catch {} }

  const samples = [];
  const t0 = Date.now();
  const tEnd = t0 + DURATION_S * 1000;
  let i = 0;
  if (inWorld) await page.keyboard.down("w");

  while (Date.now() < tEnd) {
    const loopStart = Date.now();
    if (inWorld) {
      // movement variety: turn, occasional jump, occasional stop/start.
      try {
        if (i % 3 === 1) { await page.keyboard.down("a"); await sleep(600); await page.keyboard.up("a"); }
        else if (i % 3 === 2) { await page.keyboard.down("d"); await sleep(600); await page.keyboard.up("d"); }
        if (i % 6 === 4) await page.keyboard.press("Space");
        if (i % 8 === 7) { await page.keyboard.up("w"); await sleep(1200); await page.keyboard.down("w"); }
      } catch {}
    }
    const s = await page.evaluate(() => {
      const h = window.__sessionHandle;
      let pose = null, lb = null;
      try { pose = h?.getLocalPlayerPose?.() ?? null; lb = pose?.landblock ?? pose?.lb ?? null; } catch {}
      const m = performance.memory;
      return {
        t: Math.round(performance.now()),
        diag: window.__diag?.render ? { ...window.__diag.render } : null,
        sync: window.__syncTickDiag ? { ...window.__syncTickDiag } : null,
        heapMB: m ? +(m.usedJSHeapSize / 1048576).toFixed(1) : null,
        frames: window.__perf?.frames.length || 0,
        bootState: window.__bootState ?? null,
        lb,
      };
    }).catch((e) => ({ evalError: String(e.message || e) }));
    s.rssMB = chromeRssMB();
    s.elapsed = Math.round((Date.now() - t0) / 1000);
    samples.push(s);
    if (i % 2 === 0)
      console.log(`  t=${s.elapsed}s frames=${s.frames} draws=${s.diag?.calls ?? "-"} nodes=${s.diag?.sceneNodes ?? "-"} progs=${s.diag?.programs ?? "-"} heap=${s.heapMB ?? "-"}MB rss=${s.rssMB}MB lb=${s.lb ?? "-"} err=${consoleErrors.length + pageErrors.length}`);
    const spent = Date.now() - loopStart;
    if (spent < SAMPLE_MS) await sleep(SAMPLE_MS - spent);
    i++;
  }
  if (inWorld) { try { await page.keyboard.up("w"); } catch {} }

  // Pull the full frame-time series and compute FPS stats.
  const frames = await page.evaluate(() => window.__perf?.frames || []).catch(() => []);
  const finalPose = await page.evaluate(() => {
    try { return window.__sessionHandle?.getLocalPlayerPose?.() ?? null; } catch { return null; }
  }).catch(() => null);

  const dts = frames.filter((d) => d > 0 && d < 5000);
  const fps = dts.length ? 1000 / (dts.reduce((a, b) => a + b, 0) / dts.length) : null;
  const spikes33 = dts.filter((d) => d > 33).length;
  const spikes100 = dts.filter((d) => d > 100).length;
  const spikes500 = dts.filter((d) => d > 500).length;

  const col = (k) => samples.map((s) => s.diag?.[k]).filter((v) => typeof v === "number");
  const rng = (a) => (a.length ? { min: Math.min(...a), max: Math.max(...a), avg: Math.round(a.reduce((x, y) => x + y, 0) / a.length) } : null);
  const heaps = samples.map((s) => s.heapMB).filter((v) => typeof v === "number");
  const rss = samples.map((s) => s.rssMB).filter((v) => v > 0);
  const lastSync = [...samples].reverse().find((s) => s.sync)?.sync || null;
  const lbs = [...new Set(samples.map((s) => s.lb).filter((v) => v != null))];

  const report = {
    ts: new Date().toISOString(),
    durationS: DURATION_S,
    url: URL,
    inWorld,
    finalPose,
    landblocksVisited: lbs,
    fps: fps ? +fps.toFixed(1) : null,
    frameMs: { p50: pctile(dts, 50), p95: pctile(dts, 95), p99: pctile(dts, 99), worst: dts.length ? Math.max(...dts) : null },
    spikes: { gt33ms: spikes33, gt100ms: spikes100, gt500ms: spikes500, totalFrames: dts.length },
    drawCalls: rng(col("calls")),
    triangles: rng(col("triangles")),
    programs: rng(col("programs")),
    geometries: rng(col("geometries")),
    textures: rng(col("textures")),
    sceneNodes: rng(col("sceneNodes")),
    meshNodes: rng(col("meshNodes")),
    jsHeapMB: heaps.length ? { start: heaps[0], peak: Math.max(...heaps), end: heaps[heaps.length - 1] } : null,
    chromeRssMB: rss.length ? { start: rss[0], peak: Math.max(...rss), end: rss[rss.length - 1] } : null,
    syncPhysicsTick: lastSync,
    consoleErrors: consoleErrors.slice(0, 12),
    pageErrors: pageErrors.slice(0, 12),
    errorCount: consoleErrors.length + pageErrors.length,
    samples,
  };
  const out = `${SCRATCH}/perf-walk-allon-${DURATION_S}s.json`;
  writeFileSync(out, JSON.stringify(report, null, 2));

  console.log("\n" + "=".repeat(70));
  console.log("  ALL-FLAGS-ON PERF WALK — SUMMARY");
  console.log("=".repeat(70));
  console.log(`  in-world          : ${inWorld}`);
  console.log(`  landblocks        : ${lbs.length} visited ${lbs.length ? "(" + lbs.slice(0, 6).join(",") + (lbs.length > 6 ? "…" : "") + ")" : ""}`);
  console.log(`  FPS (software GL) : ${report.fps}  | frame ms p50=${report.frameMs.p50} p95=${report.frameMs.p95} p99=${report.frameMs.p99} worst=${report.frameMs.worst}`);
  console.log(`  spikes            : >33ms=${spikes33}  >100ms=${spikes100}  >500ms=${spikes500}  (of ${dts.length} frames)`);
  console.log(`  draw calls        : ${JSON.stringify(report.drawCalls)}`);
  console.log(`  scene/mesh nodes  : ${JSON.stringify(report.sceneNodes)} / ${JSON.stringify(report.meshNodes)}`);
  console.log(`  programs (shaders): ${JSON.stringify(report.programs)}`);
  console.log(`  triangles         : ${JSON.stringify(report.triangles)}`);
  console.log(`  JS heap MB        : ${JSON.stringify(report.jsHeapMB)}`);
  console.log(`  Chrome RSS MB     : ${JSON.stringify(report.chromeRssMB)}`);
  console.log(`  syncPhysicsTick   : ${JSON.stringify(lastSync)}`);
  console.log(`  console/pageerror : ${report.errorCount}`);
  if (report.errorCount) report.consoleErrors.concat(report.pageErrors).slice(0, 8).forEach((e) => console.log(`      ! ${e}`));
  console.log(`\n  full JSON → ${out}`);
  console.log("=".repeat(70));

  await browser.close();
  process.exit(0);
}

main().catch((e) => { console.error("[perf-walk] fatal:", e && e.stack ? e.stack : e); process.exit(1); });
