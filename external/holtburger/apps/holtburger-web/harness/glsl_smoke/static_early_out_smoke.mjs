// harness/glsl_smoke/static_early_out_smoke.mjs — pixel proof for `?staticEarlyOut`
// (handoff P2 / L0, scene3d/static_batch_x.js applyStaticEarlyOut) and improvement
// hunt B9a (building buckets marked for ?batchedRuns, scene3d/buildings.js), in a
// real WebGL2 stack: local headless Chromium (ANGLE / SwiftShader), three r184 from
// node_modules, the REAL chunk batcher, building batcher, floor-bias material,
// batched_runs.js and batched_indirect_per_camera.js (static_early_out_page.html).
// Five arms, one page each, same placements, three frames with a camera pan
// (2026-10-23: both flags are default on now, so every arm names its pair and
// `bare` is the pre-flip default; `default` is a bare URL, = eo + stable):
//   bare     ?staticEarlyOut=off&batchedRunsStable=off   per-instance cull; B9a runs on buildings
//   ?staticEarlyOut=on                     opaque buckets on three's early-out
//   ?batchedRuns=off                       stock chunks, nothing regrouped (B9a reference)
//   ?staticEarlyOut=on&batchedRunsStable=on  + the L1 per-draw compare skip
// All four frames must be identical. NOT part of the node gate (it launches a
// browser — one heavy job at a time, run it under `capped-build`):
//
//   capped-build node harness/glsl_smoke/static_early_out_smoke.mjs
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const require = createRequire(import.meta.url);
const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");
const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..", "..");

async function run(search) {
  const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"] });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    const missing = [];
    page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));
    await page.route("http://smoke.test/**", (route) => {
      const u = new URL(route.request().url());
      let file, type = "text/javascript";
      if (u.pathname === "/page.html") { file = join(HERE, "static_early_out_page.html"); type = "text/html"; }
      else if (u.pathname.startsWith("/three-addons/")) file = join(APP, "node_modules/three/examples/jsm", u.pathname.slice(14));
      else if (u.pathname.startsWith("/three/")) file = join(APP, "node_modules/three/build", u.pathname.slice(7));
      else if (u.pathname.startsWith("/app/")) file = join(APP, u.pathname.slice(5));
      if (!file) { if (u.pathname !== "/favicon.ico") missing.push(u.pathname); return route.fulfill({ status: 404, body: "" }); }
      try { return route.fulfill({ status: 200, contentType: type, body: readFileSync(file) }); } catch (e) { missing.push(u.pathname); return route.fulfill({ status: 404, body: String(e) }); }
    });
    await page.goto(`http://smoke.test/page.html${search}`);
    await page.waitForFunction(() => window.__smoke, null, { timeout: 180000 });
    const r = await page.evaluate(() => window.__smoke);
    r.pageErrors = pageErrors;
    r.missing = missing;
    return r;
  } finally { await browser.close(); }
}

const summary = (r) => ({
  chunks: r.chunks, wrapper: r.wrapper, multiDraw: r.multiDraw, glError: r.glError, litPixels: r.litPixels,
  earlyOutFlag: r.earlyOutFlag, earlyOutCalls: r.earlyOutCalls, obrCalls: r.obrCalls,
  building: r.building, regrouped: r.regrouped, earlyOut: r.earlyOut, buckets: r.buckets,
  runDraws: r.stats && r.stats.draws, stableSkips: r.stats && r.stats.stableSkips, frameTotals: r.frameTotals,
  programs: r.programs && r.programs.length, errors: r.errors, pageErrors: r.pageErrors, missing: r.missing, renderer: r.renderer,
});
const OFF = "staticEarlyOut=off&batchedRunsStable=off";
const arms = {
  bare: await run(`?${OFF}`),
  eo: await run("?staticEarlyOut=on&batchedRunsStable=off"),
  runsOff: await run(`?batchedRuns=off&${OFF}`),
  eoStable: await run("?staticEarlyOut=on&batchedRunsStable=on"),
  default: await run(""),
};
for (const [k, r] of Object.entries(arms)) console.log(`${k}:`, JSON.stringify(summary(r)));

function diff(a, b) {
  if (!Array.isArray(a.frame) || !Array.isArray(b.frame) || a.frame.length !== b.frame.length) return { maxDiff: 255, differing: -1 };
  let maxDiff = 0, differing = 0;
  for (let i = 0; i < a.frame.length; i++) { const d = Math.abs(a.frame[i] - b.frame[i]); if (d) differing++; if (d > maxDiff) maxDiff = d; }
  return { maxDiff, differing };
}
const dEo = diff(arms.bare, arms.eo);
const dRuns = diff(arms.bare, arms.runsOff);
const dStable = diff(arms.bare, arms.eoStable);
const dDefault = diff(arms.bare, arms.default);
console.log(`frame diff bare vs eo: ${JSON.stringify(dEo)}; bare vs runsOff: ${JSON.stringify(dRuns)}; bare vs eoStable: ${JSON.stringify(dStable)}`);

const linked = (r) => Array.isArray(r.programs) && r.programs.length >= 1 && r.programs.every((p) => p.linked);
const clean = (r) => r.errors.length === 0 && r.pageErrors.length === 0 && r.missing.length === 0 && r.glError === 0 && linked(r) && r.litPixels > 800;
const bldRegrouped = (r) => !!r.building && Object.keys(r.regrouped || {}).some((n) => n === r.building.name);
const fails = [];
for (const [k, r] of Object.entries(arms)) if (!clean(r)) fails.push(`${k}: not clean (errors/pageErrors/missing/glError/programs/litPixels)`);
// B9a: the building bucket is marked in every arm and drawn as instanced runs
// wherever the run half is live; the stock arm regroups nothing.
if (!(arms.bare.building && arms.bare.building.marked === true && arms.bare.building.pOFC === true)) fails.push("bare: building bucket not marked / not on today's cull");
if (!bldRegrouped(arms.bare)) fails.push("bare: building bucket was not drawn as instanced runs (B9a)");
if (arms.runsOff.chunks !== false || (arms.runsOff.stats && arms.runsOff.stats.draws) !== 0) fails.push("runsOff: something regrouped");
// The early-out arms: flag read, opaque + clip chunk buckets and the building
// bucket on the early-out, the translucent bucket still sorted, and three's
// early-out actually entered on frames 2-3.
for (const k of ["eo", "eoStable", "default"]) {
  const r = arms[k];
  if (r.earlyOutFlag !== true) fails.push(`${k}: flag not read`);
  if (!(r.earlyOut && r.earlyOut.buckets >= 2)) fails.push(`${k}: < 2 chunk buckets on the early-out`);
  if (!(r.building && r.building.pOFC === false && r.building.marked === true)) fails.push(`${k}: building bucket not on the early-out`);
  if (!(Array.isArray(r.buckets) && r.buckets.some((b) => b.sorted && !b.earlyOut))) fails.push(`${k}: no sorted, culled translucent bucket`);
  if (!(r.earlyOutCalls >= 6)) fails.push(`${k}: three's early-out entered ${r.earlyOutCalls}x (want >= 6: 3 buckets x frames 2-3)`);
  if (!bldRegrouped(r)) fails.push(`${k}: building bucket not drawn as runs`);
  // Superset drawn: more ranges asked for than the culled arm, same pixels.
  if (!(r.frameTotals && arms.bare.frameTotals && r.frameTotals.subDraws > arms.bare.frameTotals.subDraws)) fails.push(`${k}: no extra ranges submitted (did the early-out arm cull?)`);
}
if (arms.bare.earlyOutCalls !== 0) fails.push("bare: three's early-out entered with the flag off");
if (!(arms.eoStable.stats && arms.eoStable.stats.stableSkips > 0)) fails.push("eoStable: batchedRunsStable never skipped (L1 not reached by early-out buckets)");
if (dEo.maxDiff !== 0) fails.push(`pixels: bare vs ?staticEarlyOut=on differ (max ${dEo.maxDiff}, ${dEo.differing} channels)`);
if (dRuns.maxDiff !== 0) fails.push(`pixels: bare vs ?batchedRuns=off differ (max ${dRuns.maxDiff}, ${dRuns.differing} channels) — B9a`);
if (dStable.maxDiff !== 0) fails.push(`pixels: bare vs eo+stable differ (max ${dStable.maxDiff})`);
if (!(arms.default.stats && arms.default.stats.stableSkips > 0)) fails.push("default: a bare URL did not reach the L1 skip (are both flags default on?)");
if (dDefault.maxDiff !== 0) fails.push(`pixels: bare vs the default URL differ (max ${dDefault.maxDiff})`);
for (const f of fails) console.log("  FAIL", f);
console.log(fails.length === 0 ? "PASS" : "FAIL");
process.exit(fails.length === 0 ? 0 : 1);
