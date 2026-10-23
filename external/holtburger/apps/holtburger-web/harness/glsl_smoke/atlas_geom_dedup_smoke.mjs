// harness/glsl_smoke/atlas_geom_dedup_smoke.mjs — pixel proof for P1a
// `?atlasGeomDedup` (scene3d/static_atlas.js) in a real WebGL2 stack: local
// headless Chromium (ANGLE / SwiftShader), three r184 from node_modules, and the
// REAL atlas module (makeArrayMaterial + DataArrayTexture layers + aLayer + the
// nra array) imported standalone through the /app/ route, drawn through the
// REAL batched_runs.js. 20 placements (3 models incl. a one-vertex variant,
// 4 surfaces, one alpha-tested `?clipMapOpaque` bucket) over several LBs.
//   default arm: repeats share a gid → batchedRuns draws instanced runs
//                (runs < instances);
//   =off arm:    one gid per placement → batchedRuns noGain, three's multidraw.
// The two frames must be identical. NOT part of the node gate (it launches a
// browser — one heavy job at a time, run it under `capped-build`):
//
//   capped-build node harness/glsl_smoke/atlas_geom_dedup_smoke.mjs
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
      if (u.pathname === "/page.html") { file = join(HERE, "atlas_geom_dedup_page.html"); type = "text/html"; }
      else if (u.pathname.startsWith("/three-addons/")) file = join(APP, "node_modules/three/examples/jsm", u.pathname.slice(14));
      else if (u.pathname.startsWith("/three/")) file = join(APP, "node_modules/three/build", u.pathname.slice(7));
      else if (u.pathname.startsWith("/app/")) file = join(APP, u.pathname.slice(5));
      if (!file) { if (u.pathname !== "/favicon.ico") missing.push(u.pathname); return route.fulfill({ status: 404, body: "" }); }
      try { return route.fulfill({ status: 200, contentType: type, body: readFileSync(file) }); } catch (e) { missing.push(u.pathname); return route.fulfill({ status: 404, body: String(e) }); }
    });
    await page.goto(`http://smoke.test/page.html${search}`);
    await page.waitForFunction(() => window.__smoke, null, { timeout: 120000 });
    const r = await page.evaluate(() => window.__smoke);
    r.pageErrors = pageErrors;
    r.missing = missing;
    return r;
  } finally { await browser.close(); }
}

const summary = (r) => ({
  geomDedup: r.geomDedup, atlas: r.atlas, passthrough: r.passthrough,
  chunks: r.chunks, wrapper: r.wrapper, multiDraw: r.multiDraw, glError: r.glError, litPixels: r.litPixels,
  runDraws: r.stats.draws, instances: r.stats.instances, runs: r.stats.runs, noGain: r.stats.noGain,
  programs: r.programs, errors: r.errors, pageErrors: r.pageErrors, missing: r.missing, renderer: r.renderer,
});
const on = await run("");
on.atlas = on.atlas || {}; // a page that threw early still yields a FAIL verdict, not a crash
console.log("atlasGeomDedup on: ", JSON.stringify(summary(on)));
const off = await run("?atlasGeomDedup=off");
off.atlas = off.atlas || {};
console.log("atlasGeomDedup off:", JSON.stringify(summary(off)));
let maxDiff = 0, differing = 0;
const n = Math.min(on.frame.length, off.frame.length);
for (let i = 0; i < n; i++) { const d = Math.abs(on.frame[i] - off.frame[i]); if (d) differing++; if (d > maxDiff) maxDiff = d; }
console.log(`frame diff: ${n / 4} px, max channel diff ${maxDiff}, channels differing ${differing}`);
const linked = (r) => r.programs.length >= 1 && r.programs.every((p) => p.linked);
const clean = (r) => r.errors.length === 0 && r.pageErrors.length === 0 && r.missing.length === 0 && r.glError === 0 && linked(r);
const ok =
  // both arms: same stack, everything atlased, clean compile + draw, same pixels
  clean(on) && clean(off) && on.frame.length === 128 * 128 * 4 && off.frame.length === on.frame.length &&
  on.chunks === true && off.chunks === true && on.wrapper === true && on.multiDraw === true &&
  on.passthrough === 0 && off.passthrough === 0 && on.atlas.atlased === 20 && off.atlas.atlased === 20 &&
  on.litPixels > 1000 && maxDiff === 0 &&
  // default arm: geometry shared, buckets drawn as runs, runs < instances
  on.geomDedup === true && on.atlas.dedupBuckets >= 2 && on.atlas.collisions === 0 &&
  on.atlas.liveGeometries < on.atlas.liveInstances && on.atlas.liveInstances === 20 &&
  on.stats.draws >= 2 && on.stats.runs < on.stats.instances &&
  // =off arm: today's F2 — one geometry per placement, every bucket noGain
  off.geomDedup === false && off.atlas.dedupBuckets === 0 &&
  off.atlas.liveGeometries === off.atlas.liveInstances && off.atlas.liveInstances === 20 &&
  off.stats.draws === 0 && off.stats.noGain >= 2;
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
