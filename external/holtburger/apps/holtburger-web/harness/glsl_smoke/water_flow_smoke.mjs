// harness/glsl_smoke/water_flow_smoke.mjs — GPU check for `?waterFlow` /
// `?waterBank` (scene3d/terrain_water_flow.js) in a real WebGL2 stack: local
// headless Chromium (ANGLE / SwiftShader), three r184 from node_modules, and
// the terrain program terrain.js ACTUALLY assembles (per-LB pair + the batched
// pair terrain_batch.js derives; water_flow_glsl.mjs dumps both per URL).
// water_flow_page.html compiles them and measures the water's motion between
// two frames 0.3 s apart (top-down orthographic, screen +x = AC east, +y = AC
// north). Checks, default session (both on):
//   W1 every program compiles and links (checkShaderErrors on), no page error
//   W2 an east flow moves the pattern east (~3.9 px), per-LB TexMerge path
//   W3 a north flow moves it north, bilinear corner path
//   W4 a west flow moves it west
//   W5 zero flow + no eddy is exactly still (no flow-map pulse)
//   W6 zero flow + the eddy drifts a little, no further than the eddy speed
//   W7 the BATCHED program (BatchedMesh, sampler2DArray, slot fetches) moves
//      east / north exactly like the per-LB one
//   W8 uWaterFlow.x = 0 (live off) falls back to the old west-south-west drift
//   W9 whitewater brightens the water
//   W10 swell weight 255 moves the surface, weight 0 holds it still (per-LB
//      and batched): the vertex stage really reads the weights
// and with ?waterFlow=off&waterBank=off: the old drift, and the swell ignores
// the weights (the per-vertex code gate).
// NOT part of the node gate (it launches a browser — one heavy job at a time,
// run it under `capped-build`):
//
//   capped-build node harness/glsl_smoke/water_flow_smoke.mjs
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
const require = createRequire(import.meta.url);
const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");
const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..", "..");

const VARIANTS = ["", "?waterFlow=off&waterBank=off"];
const GLSL = VARIANTS.map((s) => {
  const r = spawnSync(process.execPath, [join(HERE, "water_flow_glsl.mjs"), s], { cwd: APP, encoding: "utf8", maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`water_flow_glsl.mjs ${JSON.stringify(s)} failed: ${(r.stderr || "").slice(-600)}`);
  return r.stdout;
});

async function run(v) {
  const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"] });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));
    await page.route("http://smoke.test/**", (route) => {
      const u = new URL(route.request().url());
      if (u.pathname === "/page.html") return route.fulfill({ status: 200, contentType: "text/html", body: readFileSync(join(HERE, "water_flow_page.html")) });
      if (u.pathname.startsWith("/three/")) {
        try { return route.fulfill({ status: 200, contentType: "text/javascript", body: readFileSync(join(APP, "node_modules/three/build", u.pathname.slice(7))) }); } catch (e) { return route.fulfill({ status: 404, body: String(e) }); }
      }
      const m = u.pathname.match(/^\/glsl\/(\d+)\.json$/);
      if (m && GLSL[Number(m[1])]) return route.fulfill({ status: 200, contentType: "application/json", body: GLSL[Number(m[1])] });
      return route.fulfill({ status: 404, body: "" });
    });
    await page.goto(`http://smoke.test/page.html?v=${v}`);
    await page.waitForFunction(() => window.__smoke, null, { timeout: 600000 });
    const r = await page.evaluate(() => window.__smoke);
    r.pageErrors = pageErrors;
    return r;
  } finally { await browser.close(); }
}

const within = (x, lo, hi) => typeof x === "number" && x >= lo && x <= hi;
let ok = true;
for (let v = 0; v < VARIANTS.length; v++) {
  const r = await run(v);
  const A = r.arms || {};
  const checks = [];
  const c = (name, cond, detail) => checks.push({ name, ok: !!cond, detail });
  const mv = (k) => A[k] || {};
  c("W1 every program compiles and links, no page error", !r.errors.length && !r.pageErrors.length && r.programs >= 2,
    `programs=${r.programs}`);
  for (const [k, a] of Object.entries(A)) if (a.error) c(`arm ${k} ran`, false, a.error);
  if (r.flow) {
    c("W2 east flow -> pattern moves east (per-LB, TexMerge)", within(mv("east_merge").dx, 3, 5) && within(mv("east_merge").dy, -1, 1), JSON.stringify(mv("east_merge")));
    c("W3 north flow -> pattern moves north (per-LB, bilinear corners)", within(mv("north_bilinear").dy, 3, 5) && within(mv("north_bilinear").dx, -1, 1), JSON.stringify(mv("north_bilinear")));
    c("W4 west flow -> pattern moves west", within(mv("west_merge").dx, -5, -3) && within(mv("west_merge").dy, -1, 1), JSON.stringify(mv("west_merge")));
    c("W5 zero flow, no eddy: exactly still (no pulse)", mv("still_zero").dx === 0 && mv("still_zero").dy === 0 && within(mv("still_zero").meanAbsDiff, 0, 0.5), JSON.stringify(mv("still_zero")));
    c("W6 zero flow + eddy: slow drift (<= 2 px in 0.3 s)", within(mv("still_eddy").dx, -2, 2) && within(mv("still_eddy").dy, -2, 2), JSON.stringify(mv("still_eddy")));
    c("W7 batched program: east", within(mv("east_batched").dx, 3, 5) && within(mv("east_batched").dy, -1, 1), JSON.stringify(mv("east_batched")));
    c("W7 batched program: north (bilinear)", within(mv("north_batched_bilinear").dy, 3, 5) && within(mv("north_batched_bilinear").dx, -1, 1), JSON.stringify(mv("north_batched_bilinear")));
    c("W8 uWaterFlow.x = 0 -> the old west-south-west drift", within(mv("flow_uniform_off").dx, -3, -1) && within(mv("flow_uniform_off").dy, -2, 0), JSON.stringify(mv("flow_uniform_off")));
    c("W9 whitewater brightens the water", r.foamLift > 2, `lift=${r.foamLift}`);
    c("W10 swell weight 255 moves the surface", mv("swell_w255").meanAbsDiff > 0.5, JSON.stringify(mv("swell_w255")));
    c("W10 swell weight 0 holds it still", within(mv("swell_w0").meanAbsDiff, 0, 0.05), JSON.stringify(mv("swell_w0")));
    c("W10 batched: weight 255 moves", mv("swell_w255_batched").meanAbsDiff > 0.5, JSON.stringify(mv("swell_w255_batched")));
    c("W10 batched: weight 0 still", within(mv("swell_w0_batched").meanAbsDiff, 0, 0.05), JSON.stringify(mv("swell_w0_batched")));
  } else {
    c("off: the old west-south-west drift (per-LB)", within(mv("legacy_merge").dx, -3, -1) && within(mv("legacy_merge").dy, -2, 0), JSON.stringify(mv("legacy_merge")));
    c("off: the old drift (batched)", within(mv("legacy_batched").dx, -3, -1) && within(mv("legacy_batched").dy, -2, 0), JSON.stringify(mv("legacy_batched")));
    c("off: the per-vertex code gate swells regardless of the weights", mv("swell_w0").meanAbsDiff > 0.5 && mv("swell_w0_batched").meanAbsDiff > 0.5,
      JSON.stringify([mv("swell_w0"), mv("swell_w0_batched")]));
  }
  console.log(`== ${JSON.stringify(VARIANTS[v] || "default")} flow=${r.flow} bank=${r.bank} cols=${r.cols} renderer=${r.renderer}`);
  for (const ch of checks) console.log(`  ${ch.ok ? "ok  " : "FAIL"} ${ch.name}${ch.ok ? "" : ` — ${ch.detail}`}`);
  for (const [k, a] of Object.entries(A)) {
    if (!a.error) console.log(`    ${k.padEnd(24)} shift (${a.dx}, ${a.dy}) px  meanAbsDiff ${a.meanAbsDiff}  mean ${a.mean}  contrast ${a.contrast}`);
  }
  if (r.errors.length || r.pageErrors.length) console.log("  errors:", JSON.stringify([...r.errors, ...r.pageErrors]).slice(0, 3000));
  ok = ok && checks.length > 0 && checks.every((x) => x.ok);
}
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
