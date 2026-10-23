// harness/glsl_smoke/pool_runs_smoke.mjs — pixel proof for `?poolRuns`
// (scene3d/pool_registry.js + pool_producer.js, handoff F1, 2026-10-22) in a
// real WebGL2 stack: local headless Chromium (ANGLE / SwiftShader), three r184
// from node_modules, and the REAL pooled world (initPoolWorld +
// addSingletonsToPools: class pages, makeArrayMaterial, aLayer, the content
// key) imported standalone through the /app/ route, drawn through the REAL
// batched_runs.js. 24 placements of 3 models over 6 surfaces in two LBs of one
// sector, each LB with its OWN geometry objects (the per-LB decode).
//   default arm:     content keys share the cross-LB copies; the opaque and
//                    ?clipMapOpaque pools are marked and draw instanced runs
//                    (runs < instances); the translucent pool sorts and the
//                    blending cut-out pool stays on three's draw (orderBound);
//   ?poolRuns=off:   HEAD's pools — object-identity keys, nothing marked,
//                    batchedRuns issues no run draw.
// The two frames must be identical. NOT part of the node gate (it launches a
// browser — one heavy job at a time, run it under `capped-build`):
//
//   capped-build node harness/glsl_smoke/pool_runs_smoke.mjs
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
      if (u.pathname === "/page.html") { file = join(HERE, "pool_runs_page.html"); type = "text/html"; }
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
  world: r.world, pooled: r.pooled, passthrough: r.passthrough, pools: r.pools,
  chunks: r.chunks, wrapper: r.wrapper, multiDraw: r.multiDraw, glError: r.glError, litPixels: r.litPixels,
  runDraws: r.stats.draws, instances: r.stats.instances, runs: r.stats.runs, noGain: r.stats.noGain,
  programs: r.programs, errors: r.errors, pageErrors: r.pageErrors, missing: r.missing, renderer: r.renderer,
});
const on = await run("");
on.pools = on.pools || { runs: {} };
console.log("poolRuns on: ", JSON.stringify(summary(on)));
const off = await run("?poolRuns=off");
off.pools = off.pools || { runs: {} };
console.log("poolRuns off:", JSON.stringify(summary(off)));
let maxDiff = 0, differing = 0;
const n = Math.min(on.frame.length, off.frame.length);
for (let i = 0; i < n; i++) { const d = Math.abs(on.frame[i] - off.frame[i]); if (d) differing++; if (d > maxDiff) maxDiff = d; }
console.log(`frame diff: ${n / 4} px, max channel diff ${maxDiff}, channels differing ${differing}`);
const linked = (r) => r.programs.length >= 1 && r.programs.every((p) => p.linked);
const clean = (r) => r.errors.length === 0 && r.pageErrors.length === 0 && r.missing.length === 0 && r.glError === 0 && linked(r);
const ok =
  // both arms: same stack, everything pooled, four pools, clean compile + draw, same pixels
  clean(on) && clean(off) && on.frame.length === 128 * 128 * 4 && off.frame.length === on.frame.length &&
  on.world === true && off.world === true && on.chunks === true && off.chunks === true &&
  on.wrapper === true && on.multiDraw === true &&
  on.pooled === 24 && off.pooled === 24 && on.passthrough === 0 && off.passthrough === 0 &&
  on.pools.count === 4 && off.pools.count === 4 &&
  on.litPixels > 1000 && maxDiff === 0 &&
  // default arm: opaque + clipMap pools marked, the blending cut-out counted, runs drawn,
  // cross-LB copies shared by content
  on.pools.runs.marked === 2 && on.pools.runs.orderBound === 1 && on.pools.runs.live === 2 &&
  on.pools.contentShared > 0 && on.pools.contentCollisions === 0 &&
  on.stats.draws >= 2 && on.stats.runs < on.stats.instances &&
  on.pools.geometryAdds < off.pools.geometryAdds &&
  // =off arm: HEAD's pools — no marker, object-identity keys, no run draw
  off.pools.runs.marked === 0 && off.pools.runs.enabled === false && off.pools.contentHashed === 0 &&
  off.stats.draws === 0;
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
