// harness/glsl_smoke/vertex_pull_smoke.mjs — handoff P4 SPIKE (GPU-resident statics
// §6 L3, 2026-10-22): one static bucket drawn as a three r184 BatchedMesh through the
// REAL scene3d/batched_runs.js (arm A, exactly as the app marks a bucket) and as a
// VERTEX-PULLED Mesh with no geometry attributes (arms B: global arena + per-corner
// pull stream in data textures, ONE drawArrays; plus the stream-as-attribute and
// indexed variants), in a real WebGL2 stack: local headless Chromium (ANGLE /
// SwiftShader), three r184 from node_modules. Page: vertex_pull_page.html; shared
// builders + GLSL: vertex_pull_lib.mjs; CPU half: tests/vertex_pull_spike.test.mjs;
// findings: docs/vertex-pull-spike-2026-10-22.md. Harness only — no runtime wiring,
// no flag.
//
// PASS = every B frame equals A's frame (max channel diff 0), A equals three's own
// multidraw (A_stock), no GL error, every program links, the no-drawRange geometry
// draws nothing (three's early return), and the facts the doc prices are recorded:
// vertex samplers per program vs MAX_VERTEX_TEXTURE_IMAGE_UNITS, bytes per corner,
// arena bytes. NOT part of the node gate (it launches a browser — one heavy job at a
// time, run it under `capped-build`):
//
//   capped-build node harness/glsl_smoke/vertex_pull_smoke.mjs
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
      if (u.pathname === "/page.html") { file = join(HERE, "vertex_pull_page.html"); type = "text/html"; }
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

const r = await run("");
const W = 128;
const ARMS = ["A", "A_stock", "B_packed", "B_pair", "B_attr", "B_index", "noRange"];
const arm = (k) => (r.arms && r.arms[k]) || { frame: [], calls: -1, triangles: -1, glError: -1, litPixels: 0 };

function diff(a, b) {
  let maxDiff = 0, differing = 0;
  const hist = new Map();
  if (a.length !== b.length) return { maxDiff: 255, differing: Math.max(a.length, b.length), hist: {} };
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (!d) continue;
    differing++;
    if (d > maxDiff) maxDiff = d;
    hist.set(d, (hist.get(d) || 0) + 1);
  }
  return { maxDiff, differing, hist: Object.fromEntries([...hist].sort((x, y) => x[0] - y[0])) };
}

if (r.fatal) console.log("FATAL in page:", r.fatal);
console.log("renderer:", r.renderer);
console.log("limits:", JSON.stringify(r.limits));
console.log("A setup:", JSON.stringify({ chunks: r.chunks, wrapper: r.wrapper, multiDraw: r.multiDraw, layout: r.layout }));
console.log("batchedRuns stats after A:", JSON.stringify(r.stats && { draws: r.stats.draws, instances: r.stats.instances, runs: r.stats.runs, noGain: r.stats.noGain, fallbacks: r.stats.fallbacks, errors: r.stats.errors }));
for (const k of ARMS) {
  const a = arm(k);
  console.log(`arm ${k.padEnd(8)} calls ${a.calls} triangles ${a.triangles} glError ${a.glError} lit ${a.litPixels}`);
}
const diffs = {};
for (const k of ["A_stock", "B_packed", "B_pair", "B_attr", "B_index"]) {
  diffs[k] = diff(arm("A").frame, arm(k).frame);
  console.log(`frame diff A vs ${k.padEnd(8)}: ${W * W} px, max channel diff ${diffs[k].maxDiff}, channels differing ${diffs[k].differing}, |d| histogram ${JSON.stringify(diffs[k].hist)}`);
}
console.log("samplers:", JSON.stringify(r.samplers));
console.log("bytes:", JSON.stringify(r.bytes));
console.log("work:", JSON.stringify(r.work));
console.log("programs:", JSON.stringify(r.programs));
console.log("errors:", JSON.stringify(r.errors), "pageErrors:", JSON.stringify(r.pageErrors), "missing:", JSON.stringify(r.missing));

const A = arm("A");
const s = r.samplers || {};
const maxVS = (r.limits && r.limits.maxVertexTextureImageUnits) || 0;
const vsCount = (k) => (s[k] && s[k].vertexSamplerCount) ?? -1;
const linkedAll = Array.isArray(r.programs) && r.programs.length >= 2 && r.programs.every((p) => p.linked);
const bArms = ["B_packed", "B_pair", "B_attr", "B_index"];
const checks = [
  ["no fatal, console errors, page errors or missing files", !r.fatal && r.errors.length === 0 && r.pageErrors.length === 0 && r.missing.length === 0],
  ["no GL error after any arm (and at the end)", ARMS.every((k) => arm(k).glError === 0) && r.glErrorEnd === 0],
  ["every program links", linkedAll && bArms.concat(["A"]).every((k) => s[k] && s[k].linked === true)],
  ["A is the app's path: chunks patched, wrapper on, WEBGL_multi_draw", r.chunks === true && r.wrapper === true && r.multiDraw === true],
  ["A drew instanced runs (runs < instances)", !!r.stats && r.stats.draws >= 2 && r.stats.runs < r.stats.instances],
  ["instance textures in BatchedMesh's layout (bit-equal data)", !!r.layout && r.layout.matricesEqualBatchedMesh === true && r.layout.colorsEqualBatchedMesh === true],
  ["frames are full size and lit", ARMS.slice(0, 6).every((k) => arm(k).frame.length === W * W * 4) && A.litPixels > 1000],
  ["A == A_stock (batched_runs is pixel-exact here too)", diffs.A_stock.maxDiff === 0],
  ["every B arm == A (max channel diff 0)", bArms.every((k) => diffs[k].maxDiff === 0)],
  ["every B arm is ONE draw call with A's triangle count", bArms.every((k) => arm(k).calls === 1 && arm(k).triangles === A.triangles)],
  ["noRange draws nothing (renderBufferDirect early return)", arm("noRange").calls === 0 && arm("noRange").litPixels === 0],
  ["B arms bind no geometry attribute but the attr arm's stream",
    ["B_packed", "B_pair", "B_index"].every((k) => s[k] && s[k].activeAttributes.length === 0)
    && !!s.B_attr && s.B_attr.activeAttributes.length === 1 && s.B_attr.activeAttributes[0] === "hbPullCorner"],
  ["vertex samplers recorded and within MAX_VERTEX_TEXTURE_IMAGE_UNITS",
    maxVS > 0 && ["A", ...bArms].every((k) => vsCount(k) >= 1 && vsCount(k) <= maxVS)
    // A: matrices, ids, colours. Texture streams: matrices, colours, arena, stream. Attr: no stream sampler.
    && vsCount("A") === 3 && vsCount("B_packed") === 4 && vsCount("B_pair") === 4 && vsCount("B_index") === 4 && vsCount("B_attr") === 3],
  ["bytes recorded (4 B packed / 8 B pair per corner, arena 32 B/vertex)",
    !!r.bytes && r.bytes.packed.bytesPerCorner === 4 && r.bytes.pair.bytesPerCorner === 8 && r.bytes.arena.bytesPerVertex === 32 && r.bytes.arena.payloadBytes > 0],
];
let ok = true;
for (const [name, pass] of checks) { console.log(`  [${pass ? "OK" : "FAIL"}] ${name}`); if (!pass) ok = false; }
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
