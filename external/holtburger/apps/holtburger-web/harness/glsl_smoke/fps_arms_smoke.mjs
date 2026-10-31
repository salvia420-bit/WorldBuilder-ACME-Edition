// harness/glsl_smoke/fps_arms_smoke.mjs — the three 2026-10-19 A/B arms in a real
// WebGL2 stack (local headless Chromium, ANGLE / SwiftShader, three r184 from
// node_modules): `?canvasDepth=off` (a depthless canvas; the frame drawn through
// canvas_depth.js's offscreen target must equal the depth-canvas frame, and a raw
// draw must NOT — the negative control), `?depthBandSort=on` (reversed-Z: near
// bands draw first across programs on three's real render lists, same pixels),
// `?freezeWorldRoots=on` (frozen containers: verify() clean every frame, same
// pixels, the late InstancedMesh included). NOT part of the node gate (it launches
// a browser — one heavy job at a time, run it under `capped-build`).
//
//   capped-build node harness/glsl_smoke/fps_arms_smoke.mjs
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
      if (u.pathname === "/page.html") { file = join(HERE, "fps_arms_page.html"); type = "text/html"; }
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

const diff = (a, b) => {
  let max = 0, n = 0;
  for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d) n++; if (d > max) max = d; }
  return { max, n };
};
// freezeWorldRoots is DEFAULT ON since 2026-10-30: the reference run turns it off explicitly so the
// A/B still compares unfrozen vs frozen containers (canvasDepth / depthBandSort keep their defaults).
const def = await run("?freezeWorldRoots=off");
const arms = await run("?canvasDepth=off&depthBandSort=on&freezeWorldRoots=on");
const clean = (r) => r.errors.length === 0 && r.pageErrors.length === 0;
let ok = clean(def) && clean(arms);
console.log("errors:", JSON.stringify({ def: [...def.errors, ...def.pageErrors], arms: [...arms.errors, ...arms.pageErrors] }));

// canvasDepth
{
  const d = diff(def.canvasDepth.frame, arms.canvasDepth.frame);
  const red = (p) => p[0] > 200 && p[2] < 60, blue = (p) => p[2] > 200 && p[0] < 60;
  const pass = def.canvasDepth.contextDepth === true && arms.canvasDepth.contextDepth === false &&
    def.canvasDepth.redirected === false && arms.canvasDepth.redirected === true &&
    red(def.canvasDepth.overlap) && red(arms.canvasDepth.overlap) && blue(arms.canvasDepth.rawOverlap) &&
    d.max <= 2 && def.canvasDepth.glError === 0 && arms.canvasDepth.glError === 0;
  console.log(`canvasDepth: context depth ${def.canvasDepth.contextDepth} -> ${arms.canvasDepth.contextDepth}, overlap ${JSON.stringify(def.canvasDepth.overlap)} / ${JSON.stringify(arms.canvasDepth.overlap)}, raw draw on the depthless canvas ${JSON.stringify(arms.canvasDepth.rawOverlap)}, frame max diff ${d.max} (${d.n} channels) — ${pass ? "PASS" : "FAIL"}`);
  ok = ok && pass;
}
// depthBandSort
{
  const d = diff(def.band.frame, arms.band.frame);
  const near = (o) => o.indexOf("near-A") < 2 && o.indexOf("near-B") < 2;
  const grouped = (o) => Math.abs(o.indexOf("near-A") - o.indexOf("far-A")) === 1 && Math.abs(o.indexOf("near-B") - o.indexOf("far-B")) === 1;
  const pass = def.band.reversed === true && arms.band.reversed === true && def.band.installed && arms.band.installed &&
    def.band.stats.banded === 0 && arms.band.stats.banded > 0 &&
    grouped(def.band.order) && near(arms.band.order) && d.max === 0 &&
    def.band.glError === 0 && arms.band.glError === 0;
  console.log(`depthBandSort: default order ${def.band.order.join(",")} | banded ${arms.band.order.join(",")} (banded sorts ${arms.band.stats.banded}), frame max diff ${d.max} — ${pass ? "PASS" : "FAIL"}`);
  ok = ok && pass;
}
// freezeWorldRoots
{
  const d = diff(def.freeze.frame, arms.freeze.frame);
  const lit = (f) => { let n = 0; for (let i = 0; i < f.length; i += 4) if (f[i] + f[i + 1] + f[i + 2] > 200) n++; return n; };
  const pass = def.freeze.frozen === 0 && arms.freeze.frozen === 7 && def.freeze.mismatches === 0 && arms.freeze.mismatches === 0 &&
    arms.freeze.checked > 0 && d.max === 0 && lit(arms.freeze.frame) > 100 && def.freeze.glError === 0 && arms.freeze.glError === 0;
  console.log(`freezeWorldRoots: frozen ${def.freeze.frozen} -> ${arms.freeze.frozen}, verify mismatches ${def.freeze.mismatches} / ${arms.freeze.mismatches} (${arms.freeze.checked} checks), lit px ${lit(arms.freeze.frame)}, frame max diff ${d.max} — ${pass ? "PASS" : "FAIL"}`);
  ok = ok && pass;
}
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
