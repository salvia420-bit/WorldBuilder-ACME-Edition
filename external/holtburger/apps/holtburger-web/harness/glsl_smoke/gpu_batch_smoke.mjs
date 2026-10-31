// harness/glsl_smoke/gpu_batch_smoke.mjs — R3-3 GPU batch kit, legacy vs kit
// in a real WebGL2 stack: local headless Chromium (ANGLE / SwiftShader), three
// r184 from node_modules, the app's own modules (scene3d/gpu_batch/*,
// animated_scenery.js, materials.js, adapter.js). Page: gpu_batch_page.html;
// arm code: gpu_batch_lib.mjs (dry-run in node by
// tests/gpu_batch_smoke_lib.test.mjs). docs/2026-10-29-round3-gpu-driven.md
// §R3-3 "Proof".
//
// PASS =
//   layers  every level of every admitted layer reads back BYTE-EQUAL to the
//           same level of the 2D texture three built for it (albedo sRGB,
//           normal linear, NPOT sizes, the scratch path), no GL error;
//   texel   the census anim-scenery scene rendered with ?animSceneryBatch off
//           and on (two page loads, identical poses): frame max channel
//           diff 0; the on load really batched (4 setups active, 3 ARRAY + 3
//           SAME draws, fewer draw calls), the off load did not. One setup is
//           BUNDLE-shaped (the ?geomBundles default: indexed parts sharing
//           the model's vertex stream, through the real geom_bundles.js): its
//           merged draws are compacted and index-remapped, and must draw the
//           same pixels;
//           The kit budget after the on load's final renders: every
//           merged-geometry ticket landed through three's upload callbacks
//           (openTickets 0), and the S1 upload timings (ms / maxMs / timed per
//           kind, geometry phases) are finite numbers, layers and geometry
//           timed (printed: SwiftShader CPU ms, not a 1070 number);
//   f32     the kit's camera-relative composition (row redirect + landblock
//           origin + camera anchor) vs absolute instance matrices near the
//           origin: max channel diff <= 1 (1/255). At x ~ 32.4 km the diff
//           is REPORTED, not gated (there the absolute f32 matrix is the
//           imprecise side: ~4-8 mm, tests/gpu_batch_rows.test.mjs §5);
//   every program links, no page error, no console error.
// NOT part of the node gate (it launches a browser — one heavy job at a time,
// run it under `capped-build`):
//
//   capped-build node harness/glsl_smoke/gpu_batch_smoke.mjs
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
      if (u.pathname === "/page.html") { file = join(HERE, "gpu_batch_page.html"); type = "text/html"; }
      else if (u.pathname.startsWith("/three/")) file = join(APP, "node_modules/three/build", u.pathname.slice(7));
      else if (u.pathname.startsWith("/three-addons/")) file = join(APP, "node_modules/three/examples/jsm", u.pathname.slice(14)); // materials.js -> static_atlas.js imports three/addons (2026-10-31)
      else if (u.pathname.startsWith("/app/")) file = join(APP, u.pathname.slice(5));
      if (file && file.endsWith(".json")) type = "application/json";
      if (!file) { if (u.pathname !== "/favicon.ico") missing.push(u.pathname); return route.fulfill({ status: 404, body: "" }); }
      try { return route.fulfill({ status: 200, contentType: type, body: readFileSync(file) }); } catch (e) { missing.push(u.pathname); return route.fulfill({ status: 404, body: String(e) }); }
    });
    await page.goto(`http://smoke.test/page.html${search}`);
    // Interval polling (2026-10-31): the default rAF polling never fires once this page stops producing frames
    // after its work, so the wait timed out although window.__smoke was set within ~2 s.
    await page.waitForFunction(() => window.__smoke, null, { timeout: 180000, polling: 250 });
    const r = await page.evaluate(() => window.__smoke);
    r.pageErrors = pageErrors;
    r.missing = missing;
    return r;
  } finally { await browser.close(); }
}

function diff(a, b) {
  let maxDiff = 0, differing = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { const d = Math.abs(a[i] - b[i]); if (d) differing++; if (d > maxDiff) maxDiff = d; }
  return { maxDiff: a.length === b.length ? maxDiff : 255, differing };
}
const linked = (r) => Array.isArray(r.programs) && r.programs.length >= 1 && r.programs.every((p) => p.linked);
const clean = (r) => r.errors.length === 0 && r.pageErrors.length === 0 && r.glError === 0;
const fails = [];
const check = (name, ok, detail) => { console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${ok ? "" : " — " + detail}`); if (!ok) fails.push(name); };

// --- layers -------------------------------------------------------------------
const L = await run("?arm=layers");
console.log(`layers: ${JSON.stringify({ renderer: L.renderer, bptc: L.bptc, maxAnisotropy: L.maxAnisotropy, ...L.layers, summary: undefined })}`);
check("layers: 20 textures admitted, levels byte-equal to the 2D textures", L.layers && L.layers.textures === 20 && L.layers.mismatchedLevels === 0,
  JSON.stringify(L.layers && { textures: L.layers.textures, mismatched: L.layers.mismatchedLevels, first: L.layers.firstMismatch }));
check("layers: the scratch path (admitPixels) byte-equal to a legacy texture", L.layers && L.layers.scratch === 10 && L.layers.scratchMismatch === 0,
  JSON.stringify(L.layers && { scratch: L.layers.scratch, mismatched: L.layers.scratchMismatch }));
check("layers: clean", clean(L) && L.layers.glError === 0, JSON.stringify({ errors: L.errors, pageErrors: L.pageErrors, glError: L.glError, missing: L.missing }));

// --- texel ----------------------------------------------------------------------
const off = await run("?arm=texel");
const on = await run("?arm=texel&animSceneryBatch=on");
const td = diff(on.frame || [], off.frame || []);
console.log(`texel off: ${JSON.stringify({ calls: off.calls, lit: off.lit, built: off.built, batch: off.batch })}`);
console.log(`texel on:  ${JSON.stringify({ calls: on.calls, lit: on.lit, built: on.built, batch: on.batch && { byStatus: on.batch.byStatus, draws: on.batch.draws, arrayDraws: on.batch.arrayDraws, sameDraws: on.batch.sameDraws, unitReasons: on.batch.unitReasons } })}`);
console.log(`texel frame diff: ${(on.frame || []).length / 4} px, max channel diff ${td.maxDiff}, channels differing ${td.differing}`);
check("texel: the off load never armed the batch", off.batch === null && off.built === 10, JSON.stringify({ batch: off.batch, built: off.built }));
check("texel: the on load batched (4 active incl. the bundle setup, 3 ARRAY + 3 SAME draws)", on.batch && on.batch.byStatus.active === 4 && on.batch.arrayDraws === 3 && on.batch.sameDraws === 3,
  JSON.stringify(on.batch && { byStatus: on.batch.byStatus, arrayDraws: on.batch.arrayDraws, sameDraws: on.batch.sameDraws, reasons: on.batch.unitReasons }));
check("texel: the bundle setup came from the HBG1 bundle (6 indexed buckets over one 45-vertex stream; 2 batch draws, compacted: merged = referenced vertices)",
  off.bundle && on.bundle && off.bundle.buckets === 6 && off.bundle.sharedStream && off.bundle.indexed && on.bundle.indexed
    && on.bundle.batchDraws === 2 && on.bundle.mergedVertices === on.bundle.referencedVertices && on.bundle.referencedVertices === 48,
  JSON.stringify({ off: off.bundle, on: on.bundle }));
check("texel: fewer draw calls with the batch", on.calls < off.calls, `${on.calls} vs ${off.calls}`);
check("texel: the scene is on screen", off.lit > 1500 && on.lit > 1500, `${off.lit} / ${on.lit} lit px`);
check("texel: legacy vs kit frame max channel diff 0", td.maxDiff === 0, `max ${td.maxDiff}, ${td.differing} channels`);
const kb = on.kitBudget;
console.log(`texel on kit budget: ${JSON.stringify(kb && { ms: kb.ms, maxMs: kb.maxMs, timed: kb.timed, phaseMs: kb.phaseMs, byKind: kb.byKind, maxFrameBytes: kb.maxFrameBytes, tickets: kb.tickets, landed: kb.landed, dropped: kb.dropped, openTickets: kb.openTickets })}`);
const nums = (o) => !!o && Object.values(o).every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0);
check("texel: the on load's geometry tickets all landed (three's upload callbacks); upload timings are numbers, layers + geometry timed",
  off.kitBudget === null && kb && kb.openTickets === 0 && kb.landed >= 4 && kb.timed.layer > 0 && kb.timed.geometry > 0
    && nums(kb.ms) && nums(kb.maxMs) && nums(kb.timed) && nums(kb.phaseMs),
  JSON.stringify({ off: off.kitBudget, on: kb && { openTickets: kb.openTickets, tickets: kb.tickets, landed: kb.landed, timed: kb.timed, ms: kb.ms, phaseMs: kb.phaseMs } }));
check("texel: clean, every program linked", clean(off) && clean(on) && linked(off) && linked(on),
  JSON.stringify({ off: { errors: off.errors, pageErrors: off.pageErrors, glError: off.glError }, on: { errors: on.errors, pageErrors: on.pageErrors, glError: on.glError, unlinked: (on.programs || []).filter((p) => !p.linked) } }));

// --- f32 ------------------------------------------------------------------------
const F = await run("?arm=f32");
for (const a of F.f32 || []) console.log(`f32 x=${a.baseX}: max channel diff ${a.maxDiff}, channels differing ${a.differing}, > 1/255: ${a.over1}, lit ${a.litA}/${a.litB}`);
const near = (F.f32 || []).find((a) => a.baseX === 150);
check("f32: kit composition vs absolute matrices near the origin: max diff <= 1/255", near && near.maxDiff <= 1 && near.litA > 1500, JSON.stringify(near));
check("f32: clean, every program linked", clean(F) && linked(F), JSON.stringify({ errors: F.errors, pageErrors: F.pageErrors, glError: F.glError }));

console.log(fails.length === 0 ? "PASS" : `FAIL (${fails.length}): ${fails.join("; ")}`);
process.exit(fails.length === 0 ? 0 : 1);
