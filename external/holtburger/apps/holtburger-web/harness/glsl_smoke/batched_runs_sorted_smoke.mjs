// harness/glsl_smoke/batched_runs_sorted_smoke.mjs — pixel identity for `?batchedRunsSorted`
// (order-keeping consecutive runs for SORTED BatchedMeshes) and `?batchedRunsStable` (the L1
// compare skip), scene3d/batched_runs.js, 2026-10-22. Real WebGL2 stack: local headless
// Chromium (ANGLE / SwiftShader), three r184 from node_modules.
//
// The scene (batched_runs_sorted_page.html): two translucent, blended (opacity 0.5,
// depthWrite off), SORTED, DoubleSide BatchedMeshes of overlapping quads and boxes with
// per-instance colours, laid out in depth layers so three's stable sort leaves same-geometry
// instances adjacent (consecutive repeats) — one opted in, one not — plus one opaque unsorted
// bucket on three's early-out (per-object culling off) for the stable arm. Five arms, one
// browser, one page at a time:
//   on         bare URL — sorted buckets as consecutive instanced runs
//   sortedOff  ?batchedRunsSorted=off — sorted buckets on three's draw, patched chunks
//   stock      ?batchedRuns=off — stock chunks, stock draws (the reference frame)
//   stable     ?batchedRunsStable=on — L1 skip live (the opaque bucket's 2nd frame)
//   reverse    ?batchedRuns=off&smokeReverse=1 — CONTROL: three draws the sorted buckets in
//              the reversed order; the frame must DIFFER from stock, which proves the scene
//              is blend-order-sensitive (so the zero diffs above actually test order).
// PASS: on / sortedOff / stable frames equal the stock frame exactly (max channel diff 0);
// the reverse frame differs; the run paths were actually taken (sorted runs < sorted ranges,
// stable skips >= 1); no shader / GL / page errors; every program linked.
// NOT part of the node gate (it launches a browser — one heavy job at a time):
//
//   capped-build node harness/glsl_smoke/batched_runs_sorted_smoke.mjs
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const require = createRequire(import.meta.url);
const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");
const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..", "..");

async function run(browser, search) {
  const page = await browser.newPage();
  try {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));
    await page.route("http://smoke.test/**", (route) => {
      const u = new URL(route.request().url());
      let file, type = "text/javascript";
      if (u.pathname === "/page.html") { file = join(HERE, "batched_runs_sorted_page.html"); type = "text/html"; }
      else if (u.pathname.startsWith("/three/")) file = join(APP, "node_modules/three/build", u.pathname.slice(7));
      else if (u.pathname.startsWith("/app/")) file = join(APP, u.pathname.slice(5));
      if (!file) return route.fulfill({ status: 404, body: "" });
      try { return route.fulfill({ status: 200, contentType: type, body: readFileSync(file) }); } catch (e) { return route.fulfill({ status: 404, body: String(e) }); }
    });
    await page.goto(`http://smoke.test/page.html${search}`);
    await page.waitForFunction(() => window.__smoke, null, { timeout: 120000 });
    const r = await page.evaluate(() => window.__smoke);
    r.pageErrors = pageErrors;
    return r;
  } finally { await page.close(); }
}

const ARMS = {
  on: "",
  sortedOff: "?batchedRunsSorted=off",
  stock: "?batchedRuns=off",
  stable: "?batchedRunsStable=on",
  reverse: "?batchedRuns=off&smokeReverse=1",
};
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"] });
const R = {};
try {
  for (const [name, search] of Object.entries(ARMS)) R[name] = await run(browser, search);
} finally { await browser.close(); }

const summary = (r) => ({
  chunks: r.chunks, wrapper: r.wrapper, multiDraw: r.multiDraw, glError: r.glError, drawnPixels: r.drawnPixels,
  draws: r.stats.draws, runs: r.stats.runs, instances: r.stats.instances,
  sortedDraws: r.stats.sortedDraws, sortedInstances: r.stats.sortedInstances, sortedRuns: r.stats.sortedRuns, sortedNoGain: r.stats.sortedNoGain,
  stableOn: r.stats.stableOn, stableSkips: r.stats.stableSkips, stableAuditFails: r.stats.stableAuditFails,
  programs: r.programs.length, errors: r.errors, pageErrors: r.pageErrors, renderer: r.renderer,
});
for (const [name, r] of Object.entries(R)) console.log(`${name.padEnd(9)}`, JSON.stringify(summary(r)));
function diff(a, b) {
  let maxDiff = 0, differing = 0;
  for (let i = 0; i < a.frame.length; i++) { const d = Math.abs(a.frame[i] - b.frame[i]); if (d) differing++; if (d > maxDiff) maxDiff = d; }
  return { maxDiff, differing };
}
const dOn = diff(R.on, R.stock), dSo = diff(R.sortedOff, R.stock), dSt = diff(R.stable, R.stock), dRev = diff(R.reverse, R.stock);
console.log(`on vs stock:        max channel diff ${dOn.maxDiff}, channels differing ${dOn.differing}`);
console.log(`sortedOff vs stock: max channel diff ${dSo.maxDiff}, channels differing ${dSo.differing}`);
console.log(`stable vs stock:    max channel diff ${dSt.maxDiff}, channels differing ${dSt.differing}`);
console.log(`CONTROL reverse vs stock (must differ): max channel diff ${dRev.maxDiff}, channels differing ${dRev.differing}`);

const clean = (r) => r.errors.length === 0 && r.pageErrors.length === 0 && r.glError === 0
  && r.programs.length >= 1 && r.programs.every((p) => p.linked);
const ok = Object.values(R).every(clean)
  && R.on.chunks === true && R.on.wrapper === true && R.on.multiDraw === true
  // two frames x two-pass: the opted-in sorted bucket drew as consecutive runs, regrouped
  && R.on.stats.sortedDraws >= 2 && R.on.stats.sortedRuns < R.on.stats.sortedInstances
  && R.on.stats.draws >= 2                                   // the opaque bucket's unsorted runs
  && R.sortedOff.chunks === true && R.sortedOff.stats.sortedDraws === 0 && R.sortedOff.stats.draws >= 2
  && R.stock.chunks === false && R.stock.stats.draws === 0 && R.stock.stats.sortedDraws === 0
  && R.stable.stats.stableOn === true && R.stable.stats.stableSkips >= 1 && R.stable.stats.stableAuditFails === 0
  && R.stable.stats.sortedDraws >= 2
  && R.on.drawnPixels > 500                                  // something drew (~1.6-2k px expected [D])
  && dOn.maxDiff === 0 && dSo.maxDiff === 0 && dSt.maxDiff === 0
  && dRev.differing > 0;
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
