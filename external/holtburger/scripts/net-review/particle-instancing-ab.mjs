// particle-instancing-ab.mjs — the ONLY valid ?particleInstancing A/B.
//
// Cross-page-load A/B cannot work here (see settle.mjs §4): two runs with the
// same pinned pose, same flags, both properly settled still differ ~25% (draws
// 1590.3 vs 1996), because the emitter plateau is stochastic (2451/2502/2505/2579
// from a constant 138 anchors) and emission is RNG-driven. So: settle ONCE, then
// flip the gate at runtime (window.__setParticleInstancing) and measure both arms
// against the IDENTICAL scene.
//
// A/B/A: measure OFF, ON, then OFF again. If the two OFF legs disagree, the
// scene drifted under us and the whole comparison is void — report and bail
// rather than publish a number. That check is the point; without it a single
// A/B just relocates the same confound.
import fs from "node:fs";
import { settleAt, WEATHER_OFF, worldState } from "./settle.mjs";

const CDP_URL = "http://127.0.0.1:9333";
const SERVE = "http://127.0.0.1:8765/apps/holtburger-web/index.html";
const ACCOUNT = "tailnet1";
const POI = process.env.POI || "Cragstone";
const OUT = process.argv[2] || "/mnt/wbterminal2/tmp/inst-ab.json";
const SAMPLE_S = Number(process.env.SAMPLE_S || 8);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function drawsOver(page, seconds) {
  await page.evaluate(() => {
    const rr = window.liveScene3d.renderer;
    rr.info.autoReset = false; rr.info.reset();
    window.__abC0 = rr.info.render.calls; window.__abF = 0;
    if (!window.__abLoop) { window.__abLoop = true; const l = () => { window.__abF++; requestAnimationFrame(l); }; requestAnimationFrame(l); }
  });
  await sleep(seconds * 1000);
  return page.evaluate(() => {
    const rr = window.liveScene3d.renderer;
    const f = Math.max(1, window.__abF);
    const d = +((rr.info.render.calls - window.__abC0) / f).toFixed(1);
    rr.info.autoReset = true;
    return { draws: d, frames: f };
  });
}

(async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const home = process.env.HOME;
  let pw;
  try { pw = require("playwright-core"); }
  catch (_) {
    const hits = fs.readdirSync(`${home}/.npm/_npx`).map((d) => `${home}/.npm/_npx/${d}/node_modules/playwright-core`).filter((p) => fs.existsSync(p));
    pw = require(hits[0]);
  }
  const browser = await pw.chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0] ?? (await browser.newContext());
  const page = await ctx.newPage();
  // Start on the per-mesh path; the runtime hook drives both arms from here.
  const q = new URLSearchParams({ renderer: "3d", autoLogin: "1", account: ACCOUNT, password: ACCOUNT,
    autoSpawn: "first", nosw: "1", buildingBatch: "off", particleInstancing: "off", ...WEATHER_OFF });
  if (process.env.EXTRA_QUERY) for (const [k, v] of new URLSearchParams(process.env.EXTRA_QUERY)) q.set(k, v);
  console.error(`[ab] query: ${q}`);
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e?.message ?? e)));
  await page.goto(`${SERVE}?${q}`, { timeout: 60000 });
  for (let i = 0; i < 240; i++) {
    const bs = await page.evaluate(() => window.__bootState).catch(() => null);
    if (bs === "in-world" || bs === "ready") break;
    if (bs === "error") { console.error("[ab] boot error"); process.exit(3); }
    await sleep(1000);
  }
  for (let i = 0; i < 90; i++) { if (await page.evaluate(() => !!(window.liveScene3d?.scene)).catch(() => false)) break; await sleep(1000); }

  const settle = await settleAt(page, POI, { log: (m) => console.error(`[ab] ${m}`), pinPose: process.env.PIN_POSE || null });
  if (!settle.settled) { console.error("[ab] NOT settled — aborting rather than publishing a number"); process.exit(4); }

  const hasHook = await page.evaluate(() => typeof window.__setParticleInstancing === "function");
  if (!hasHook) { console.error("[ab] window.__setParticleInstancing missing — is the statics manager opted in?"); process.exit(5); }

  const flip = (on) => page.evaluate((v) => window.__setParticleInstancing(v), on);
  const legs = [];
  for (const [label, on] of [["A(off)", false], ["B(on)", true], ["A'(off)", false]]) {
    const diagAtFlip = await flip(on);
    await sleep(3000); // let the tick rebuild/teardown buckets before sampling
    const d = await drawsOver(page, SAMPLE_S);
    // diag AS MEASURED — buckets are built lazily on the next tick, so the
    // flip() return is stale and would read buckets=0 even when they populate.
    const diag = await page.evaluate(() => window.__particleInstancingDiag());
    const st = await worldState(page);
    legs.push({ label, on, ...d, diagAtFlip, diag, state: st });
    console.error(`[ab] ${label.padEnd(8)} draws/frame=${String(d.draws).padStart(7)} | instEmitters=${diag.instEmitters} buckets=${diag.buckets} instances=${diag.instances} meshesInScene=${diag.meshesInScene} liveParticles=${st.liveParticles}`);
    if (on && diag.buckets === 0) console.error(`[ab] !! ON leg has NO buckets — particles are not being drawn at all; the saving is FAKE`);
  }

  const [a1, b, a2] = legs;
  const drift = Math.abs(a2.draws - a1.draws) / Math.max(1, a1.draws);
  console.error(`[ab] ---`);
  console.error(`[ab] OFF-leg drift: ${a1.draws} -> ${a2.draws} (${(drift * 100).toFixed(1)}%)`);
  if (drift > 0.10) {
    console.error(`[ab] !! scene drifted >10% between the two OFF legs — comparison VOID, do not quote a number`);
  } else {
    const offAvg = (a1.draws + a2.draws) / 2;
    console.error(`[ab] VALID: OFF=${offAvg.toFixed(1)} (avg of two legs, drift ${(drift * 100).toFixed(1)}%) -> ON=${b.draws} ` +
                  `= -${(offAvg - b.draws).toFixed(1)} draws (-${(100 * (1 - b.draws / offAvg)).toFixed(1)}%) on ONE identical scene`);
  }
  console.error(`[ab] pageerrors=${errs.length}`);
  fs.writeFileSync(OUT, JSON.stringify({ poi: POI, settle, legs, driftPct: +(drift * 100).toFixed(1), errs }, null, 2));
  await page.close();
  process.exit(0);
})();
