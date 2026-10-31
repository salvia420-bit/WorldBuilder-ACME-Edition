// harness/glsl_smoke/entity_batch_smoke.mjs — R3-4 stage A `?entityBatch`,
// legacy vs batch in a real WebGL2 stack: local headless Chromium (ANGLE /
// SwiftShader), three r184 from node_modules, the app's own modules (the REAL
// scene3d/entities.js EntityManager spawning the rigs of entity_batch_lib.mjs,
// scene3d/gpu_batch/*, materials.js, adapter.js). Page: entity_batch_page.html.
// docs/2026-10-29-round3-gpu-driven.md §R3-4 "Proof" (HOW: SwiftShader smoke).
//
// PASS =
//   layers   every level of every layer the batch admitted (value-keyed
//            palette composites through the admitPixels scratch, or copied
//            from the legacy texture's own levels when three already held it
//            (2026-10-31), and cache textures by identity) reads back
//            BYTE-EQUAL to the same level of the member's own 2D texture;
//            equal composites shared a layer;
//   arms     each arm loaded twice (flag off / `&entityBatch=on`, identical
//            poses): the on load really batched (fewer draw calls, the arm's
//            expected statuses), and the frames match: 0 structural
//            difference (the same lit pixel count +- 0.1%) and at most 2/255
//            on at most 0.1% of the pixels (part x root composed in f32 on
//            the GPU instead of per-mesh modelView):
//              humans  a plain human + three recolored ones (two with equal
//                      composites), ClipMap paletted parts (alpha ref 100/255);
//              clamp   cache materials carrying the retail light clamp chain;
//              mixed   a translucent and a luminous surface: legacy leaves
//                      inside a batched rig;
//              front   `?perPolyCull` FrontSide parts (the front class);
//              flash   a selection-flashed rig (demoted: drawn legacy, lit);
//   overlap  the first frame the batch draws next to the legacy leaves equals
//            the same frame with the batch meshes hidden (<= 2/255 on <=
//            0.1%: the overlap is invisible);
//   pom      (2026-10-31) the arms' gates on cache materials carrying
//            materials.js's POM patch (+ light clamp), camera inside the POM
//            band (3.8 m): POM classes drew (height layers + POM extension
//            rows admitted, verify() clean incl. the POM rows, a `|pom1`
//            program linked), and `layers&pom=1`: every R8 height layer, every
//            level, byte-equal to the member's own 2D height texture;
//   every program links, no page error, no console error, no GL error, no
//   missing module.
// NOT part of the node gate (it launches a browser — one heavy job at a time,
// run it under `capped-build`):
//
//   capped-build node harness/glsl_smoke/entity_batch_smoke.mjs
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
      if (u.pathname === "/page.html") { file = join(HERE, "entity_batch_page.html"); type = "text/html"; }
      else if (u.pathname.startsWith("/three-addons/")) file = join(APP, "node_modules/three/examples/jsm", u.pathname.slice(14)); // three/addons (2026-10-31)
      else if (u.pathname.startsWith("/three/")) file = join(APP, "node_modules/three/build", u.pathname.slice(7));
      else if (u.pathname.startsWith("/app/")) file = join(APP, u.pathname.slice(5));
      if (file && file.endsWith(".json")) type = "application/json";
      if (!file) { if (u.pathname !== "/favicon.ico") missing.push(u.pathname); return route.fulfill({ status: 404, body: "" }); }
      try { return route.fulfill({ status: 200, contentType: type, body: readFileSync(file) }); } catch (e) { missing.push(u.pathname); return route.fulfill({ status: 404, body: String(e) }); }
    });
    await page.goto(`http://smoke.test/page.html${search}`);
    // Interval polling (2026-10-31): the page stubs requestAnimationFrame, so the default rAF polling never fires.
    await page.waitForFunction(() => window.__smoke, null, { timeout: 240000, polling: 250 });
    const r = await page.evaluate(() => window.__smoke);
    r.pageErrors = pageErrors;
    r.missing = missing;
    return r;
  } finally { await browser.close(); }
}

function diff(a, b) {
  let maxDiff = 0, over2 = 0, differing = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 4) {
    let px = 0;
    for (let c = 0; c < 3; c += 1) { const d = Math.abs(a[i + c] - b[i + c]); if (d > px) px = d; }
    if (px) differing += 1;
    if (px > 2) over2 += 1;
    if (px > maxDiff) maxDiff = px;
  }
  return { maxDiff: a.length === b.length ? maxDiff : 255, over2, differing, pixels: n / 4 };
}
function lit(px) { let n = 0; for (let i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] > 3 * 0x14) n += 1; return n; }
const modulesMissing = (r) => (r.missing || []).filter((p) => /\.(m?js)$/.test(p));
const linked = (r) => Array.isArray(r.programs) && r.programs.length >= 1 && r.programs.every((p) => p.linked);
const clean = (r) => r.errors.length === 0 && r.pageErrors.length === 0 && r.glError === 0 && modulesMissing(r).length === 0;
const fails = [];
const check = (name, ok, detail) => { console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${ok ? "" : " — " + detail}`); if (!ok) fails.push(name); };
const err = (r) => JSON.stringify({ errors: r.errors, pageErrors: r.pageErrors, glError: r.glError, missing: modulesMissing(r), unlinked: (r.programs || []).filter((p) => !p.linked).map((p) => p.key) });

// --- layers ---------------------------------------------------------------------
const L = await run("?arm=layers");
console.log(`layers: ${JSON.stringify({ renderer: L.renderer, status: L.status, layers: L.layers })}`);
check("layers: every admitted layer level reads back byte-equal to the member's 2D texture", L.layers && L.layers.layers >= 16 && L.layers.value >= 16 && L.layers.mismatched === 0,
  JSON.stringify(L.layers));
check("layers: equal composites share (16 value keys for 4 recolored rigs, 2 palettes)", L.stats && L.stats.layers.valueKeys === 16 && L.stats.layers.joins >= 8, JSON.stringify(L.stats && L.stats.layers));
check("layers: clean", clean(L), err(L));
// POM height layers (R8 pages): the same readback on the POM material cache.
const LP = await run("?arm=layers&pom=1");
console.log(`layers+pom: ${JSON.stringify({ status: LP.status, layers: LP.layers, pomLayers: LP.stats && LP.stats.layers.pom })}`);
check("layers+pom: every R8 height layer level reads back byte-equal to the member's 2D height texture", LP.layers && LP.layers.pom >= 8 && LP.layers.mismatched === 0,
  JSON.stringify(LP.layers));
check("layers+pom: clean", clean(LP), err(LP));

// --- arms -------------------------------------------------------------------------
// Every field of an arm is read below (tests/entity_batch_lifecycle.test.mjs 7b checks it).
const ARMS = {
  humans: { status: ["active", "active", "active", "active"], fewerCalls: true },
  clamp: { status: ["active", "active"], fewerCalls: true },
  mixed: { status: ["active", "active"], legacyLeaves: true, fewerCalls: true },
  front: { status: ["active", "active"], fewerCalls: true },
  flash: { status: ["demoted", "active"], fewerCalls: true }, // one rig still batched
  pom: { status: ["active", "active"], fewerCalls: true, pom: true }, // POM classes (height layers + extension rows)
};
for (const [arm, want] of Object.entries(ARMS)) {
  const off = await run(`?arm=${arm}`);
  const on = await run(`?arm=${arm}&entityBatch=on`);
  const d = diff(on.frame || [], off.frame || []);
  const lo = lit(off.frame || []), ln = lit(on.frame || []);
  console.log(`${arm}: off calls ${off.calls}, on calls ${on.calls}, status ${JSON.stringify(on.status)}, draws ${on.stats && on.stats.draws}, routes ${JSON.stringify(on.stats && on.stats.leafRoutes)}, lit ${lo}/${ln}, diff ${JSON.stringify(d)}`);
  check(`${arm}: the on load batched as expected`, JSON.stringify(on.status) === JSON.stringify(want.status) && (!want.fewerCalls || on.calls < off.calls),
    JSON.stringify({ status: on.status, calls: [off.calls, on.calls], fallbacks: on.stats && on.stats.fallbacks, demotes: on.stats && on.stats.demoteReasons }));
  if (want.legacyLeaves) check(`${arm}: translucent + luminous leaves stayed legacy`, on.stats && on.stats.leafRoutes.translucent >= 2 && (on.stats.leafRoutes["map:emissiveMap"] || on.stats.leafRoutes.luminous) >= 2, JSON.stringify(on.stats && on.stats.leafRoutes));
  check(`${arm}: verify() clean (part rows, state rows, slots, park)`, on.verify && on.verify.rowMismatches === 0 && on.verify.stateMismatches === 0 && on.verify.parkMismatches === 0 && on.verify.attrMismatches === 0, JSON.stringify(on.verify));
  if (want.pom) {
    // (three puts the custom key last in a program cache key: the page's 120-char program keys never reach it,
    // so the class keys come from stats().programKeys; every program linked is the arm's "clean" gate below.)
    check(`${arm}: POM parts batched (height layers + extension rows, POM rows verified, a POM class program)`,
      on.stats && on.stats.layers.pom >= 8 && on.verify && on.verify.pomMismatches === 0 && (on.stats.programKeys || []).some((k) => /\|pom1$/.test(k)),
      JSON.stringify({ layers: on.stats && on.stats.layers, verify: on.verify, keys: on.stats && on.stats.programKeys }));
  }
  check(`${arm}: the rigs are on screen`, lo > 1500, `${lo} lit px`);
  check(`${arm}: no structural difference (lit pixels within 0.1%)`, Math.abs(ln - lo) <= Math.ceil(0.001 * d.pixels), `${lo} vs ${ln}`);
  check(`${arm}: <= 2/255 on <= 0.1% of the pixels`, d.over2 <= Math.floor(0.001 * d.pixels), JSON.stringify(d));
  check(`${arm}: clean, every program linked`, clean(off) && clean(on) && linked(off) && linked(on), JSON.stringify({ off: err(off), on: err(on) }));
}

// --- overlap ------------------------------------------------------------------------
const O = await run("?arm=overlap&entityBatch=on");
const od = O.overlap && O.overlap.a ? diff(O.overlap.a, O.overlap.b) : null;
console.log(`overlap: ${JSON.stringify({ frames: O.overlap && O.overlap.frames, overlapRigs: O.overlap && O.overlap.overlapRigs, built: O.overlap && O.overlap.built, diff: od })}`);
check("overlap: batch + legacy drawn together == legacy alone (<= 2/255 on <= 0.1%)", od && O.overlap.overlapRigs >= 1 && O.overlap.built === 4 && od.over2 <= Math.floor(0.001 * od.pixels) && lit(O.overlap.b) > 1500,
  JSON.stringify({ overlap: O.overlap && { frames: O.overlap.frames, overlapRigs: O.overlap.overlapRigs, built: O.overlap.built }, diff: od }));
check("overlap: clean", clean(O) && linked(O), err(O));

console.log(fails.length === 0 ? "PASS" : `FAIL (${fails.length}): ${fails.join("; ")}`);
process.exit(fails.length === 0 ? 0 : 1);
