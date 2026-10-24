// harness/glsl_smoke/terrain_no_drawid_smoke.mjs — compile + image check for
// `?terrainNoDrawId` (scene3d/terrain_batch.js, NO-gl_DrawID PROGRAM) in a real
// WebGL2 stack: local headless Chromium (ANGLE / SwiftShader), three r184 from
// node_modules, the REAL terrain_batch.js and batched_runs.js. The page
// (terrain_no_drawid_page.html) absorbs a 4x4 ring of synthetic landblocks through
// a lifecycle that makes layer slots and instance ids diverge (evict 7 ->
// optimize() -> re-absorb 7), parks one row and culls one off-screen LB, then
// draws twice. The `=on` frame (matrix by per-vertex aLbIid, no gl_DrawID in the
// program) must equal the default frame (today's gl_DrawID program) bit for bit.
// NOT part of the node gate (it launches a browser — one heavy job at a time, run
// it under `capped-build`).
//
//   capped-build node harness/glsl_smoke/terrain_no_drawid_smoke.mjs
//
// SwiftShader runs ANGLE's front-end translator (where EmulateGLDrawID lives) but
// not the D3D11 HLSL compiler, so a 1070 readback of the same pair is the
// definitive pixel check for the D3D path; this smoke proves the program
// compiles, links and draws identically, and that the =on program has no
// gl_DrawID and no batchingIdTexture.
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
      if (u.pathname === "/page.html") { file = join(HERE, "terrain_no_drawid_page.html"); type = "text/html"; }
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

const prog = (r) => (r.programs || []).find((p) => p.name === "terrain-batch") || null;
const summary = (r) => {
  const p = prog(r);
  return {
    chunks: r.chunks, multiDraw: r.multiDraw, glError: r.glError, litPixels: r.litPixels, colours: r.colours,
    absorbedAll: r.absorbedAll, absorbCount: r.absorbCount,
    stats: r.stats && {
      noDrawId: r.stats.noDrawId, requested: r.stats.noDrawIdRequested, fallback: r.stats.noDrawIdFallback,
      instances: r.stats.instances, parkedRows: r.stats.parkedRows, passthrough: r.stats.passthrough,
      optimizes: r.stats.optimizes, iidWrites: r.stats.iidWrites, iidWriteFails: r.stats.iidWriteFails,
    },
    verify: r.verify, draws: r.draws,
    program: p && { linked: p.linked, vsNamesDrawId: p.vsNamesDrawId, vsHasALbIid: p.vsHasALbIid,
      batchingTexture: p.uniforms.includes("batchingTexture"), batchingIdTexture: p.uniforms.includes("batchingIdTexture"),
      translated: p.translated },
    programs: (r.programs || []).length, errors: r.errors, warns: r.warns, pageErrors: r.pageErrors, renderer: r.renderer,
  };
};

const on = await run("?terrainNoDrawId=on");
console.log("terrainNoDrawId on: ", JSON.stringify(summary(on)));
const off = await run("?terrainNoDrawId=off"); // default on since 2026-10-23
const def = await run("");
console.log("terrainNoDrawId off:", JSON.stringify(summary(off)));
let maxDiff = 0, differing = 0;
for (let i = 0; i < on.frame.length; i++) { const d = Math.abs(on.frame[i] - off.frame[i]); if (d) differing++; if (d > maxDiff) maxDiff = d; }
console.log(`frame diff: ${on.frame.length / 4} px, max channel diff ${maxDiff}, channels differing ${differing}`);

const pOn = prog(on), pOff = prog(off);
const clean = (r) => r.errors.length === 0 && r.pageErrors.length === 0 && r.glError === 0
  && !r.warns.some((w) => w.includes("[terrain_batch]"));
// ANGLE's translation (only when the browser exposes WEBGL_debug_shaders): if the
// =off translation shows the draw-ID emulation, the =on one must not.
const translatedOk = !(pOff && pOff.translated && pOff.translated.drawId) || (pOn && pOn.translated && pOn.translated.drawId === false);
const checks = {
  chunksPatchedBothArms: on.chunks === true && off.chunks === true,
  multiDraw: on.multiDraw === true && off.multiDraw === true,
  everyAbsorbOk: on.absorbedAll === true && off.absorbedAll === true && on.absorbCount === 24,
  onProgramLive: !!on.stats && on.stats.noDrawId === true && on.stats.noDrawIdRequested === true && on.stats.noDrawIdFallback === null,
  defaultIsOn: !!def.stats && def.stats.noDrawId === true && def.stats.noDrawIdRequested === true && clean(def),
  offProgramToday: !!off.stats && off.stats.noDrawId === false && off.stats.noDrawIdRequested === false,
  sameLifecycle: !!on.stats && !!off.stats && on.stats.optimizes >= 1 && off.stats.optimizes === on.stats.optimizes
    && on.stats.instances === off.stats.instances && on.stats.parkedRows === 1 && off.stats.parkedRows === 1
    && on.stats.passthrough === 0 && off.stats.passthrough === 0,
  iidsWrittenAndDiverged: !!on.verify && on.verify.bad === 0 && on.verify.checked === on.stats.instances
    && on.verify.slotNeIid >= 4 && on.stats.iidWrites === 24 && on.stats.iidWriteFails === 0,
  // 15 visible rows per draw (16 in view - 1 parked; the 17th is culled). The
  // running totals may hold one draw or both (the frame key is the document
  // timeline), but the two arms must agree.
  rangesDrawn: on.draws.batchedCalls >= 1 && on.draws.subDraws >= 15 && on.draws.subDraws % 15 === 0
    && on.draws.subDraws === off.draws.subDraws && on.draws.batchedCalls === off.draws.batchedCalls,
  programsLinked: !!pOn && !!pOff && pOn.linked === true && pOff.linked === true,
  onNoDrawId: !!pOn && pOn.vsNamesDrawId === false && pOn.vsHasALbIid === true
    && pOn.uniforms.includes("batchingTexture") && !pOn.uniforms.includes("batchingIdTexture"),
  offHasDrawId: !!pOff && pOff.vsNamesDrawId === true && pOff.uniforms.includes("batchingIdTexture"),
  translatedOk,
  clean: clean(on) && clean(off),
  content: on.litPixels > 128 * 128 * 0.5 && on.colours >= 8,
  pixelIdentical: maxDiff === 0,
};
console.log("checks:", JSON.stringify(checks));
const ok = Object.values(checks).every(Boolean);
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
