// harness/glsl_smoke/batched_runs_smoke.mjs — compile + image check for `?batchedRuns`
// (scene3d/batched_runs.js) in a real WebGL2 stack: local headless Chromium (ANGLE /
// SwiftShader), three r184 from node_modules. Two BatchedMeshes of boxes and balls with
// per-instance colours (so both patched chunks, batching_vertex and color_vertex, run):
// one opted in (drawn as per-geometry instanced runs through the run-layout texture), one
// not (three's layout through the PATCHED chunk). The frame must equal the
// `?batchedRuns=off` frame (stock chunks, stock draws). NOT part of the node gate (it
// launches a browser — one heavy job at a time, run it under `capped-build`).
//
//   capped-build node harness/glsl_smoke/batched_runs_smoke.mjs
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
    page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));
    await page.route("http://smoke.test/**", (route) => {
      const u = new URL(route.request().url());
      let file, type = "text/javascript";
      if (u.pathname === "/page.html") { file = join(HERE, "batched_runs_page.html"); type = "text/html"; }
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
  } finally { await browser.close(); }
}

const summary = (r) => ({
  chunks: r.chunks, wrapper: r.wrapper, multiDraw: r.multiDraw, glError: r.glError, litPixels: r.litPixels,
  runDraws: r.stats.draws, instances: r.stats.instances, runs: r.stats.runs, programs: r.programs,
  errors: r.errors, pageErrors: r.pageErrors, renderer: r.renderer,
});
const on = await run("");
console.log("batchedRuns on: ", JSON.stringify(summary(on)));
const off = await run("?batchedRuns=off");
console.log("batchedRuns off:", JSON.stringify(summary(off)));
let maxDiff = 0, differing = 0;
for (let i = 0; i < on.frame.length; i++) { const d = Math.abs(on.frame[i] - off.frame[i]); if (d) differing++; if (d > maxDiff) maxDiff = d; }
console.log(`frame diff: ${on.frame.length / 4} px, max channel diff ${maxDiff}, channels differing ${differing}`);
const linked = (r) => r.programs.length >= 1 && r.programs.every((p) => p.linked);
const ok = on.chunks === true && on.wrapper === true && on.multiDraw === true
  && on.stats.draws >= 2 && on.stats.runs < on.stats.instances  // two frames, regrouped
  && off.chunks === false && off.stats.draws === 0
  && on.errors.length === 0 && on.pageErrors.length === 0 && off.errors.length === 0 && off.pageErrors.length === 0
  && on.glError === 0 && off.glError === 0 && linked(on) && linked(off)
  && on.litPixels > 500 && maxDiff === 0;
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
