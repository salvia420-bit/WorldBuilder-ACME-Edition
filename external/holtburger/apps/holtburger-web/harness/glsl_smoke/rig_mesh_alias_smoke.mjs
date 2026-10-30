// harness/glsl_smoke/rig_mesh_alias_smoke.mjs — pixel check for `?rigMeshAlias`
// (scene3d/setup_rig.js `installRigMeshAlias`) in a real WebGL2 stack: local
// headless Chromium (ANGLE / SwiftShader), three r184 from node_modules. Lit
// entity-shaped rigs animated over 12 frames (rig_mesh_alias_page.html); three
// of them are read back. The `?rigMeshAlias=on` frames must equal the flag-off
// frames pixel for pixel (max channel diff 0), with the alias actually in use
// on the on arm and not installed on the off arm. NOT part of the node gate (it
// launches a browser — one heavy job at a time, run it under `capped-build`).
//
//   capped-build node harness/glsl_smoke/rig_mesh_alias_smoke.mjs
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
      if (u.pathname === "/page.html") { file = join(HERE, "rig_mesh_alias_page.html"); type = "text/html"; }
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
  flag: r.flag, glError: r.glError, litPixels: r.litPixels, renderMs: r.renderMs,
  parts: r.stats.parts, aliased: r.stats.aliased, unaliased: r.stats.unaliased, shared: r.stats.shared,
  aliasedNow: r.aliasedNow, programs: r.programs.length, errors: r.errors, pageErrors: r.pageErrors, renderer: r.renderer,
});
const off = await run("");
console.log("rigMeshAlias off:", JSON.stringify(summary(off)));
const on = await run("?rigMeshAlias=on");
console.log("rigMeshAlias on: ", JSON.stringify(summary(on)));
let maxDiff = 0, differing = 0;
const n = Math.min(on.frame.length, off.frame.length);
for (let i = 0; i < n; i++) { const d = Math.abs(on.frame[i] - off.frame[i]); if (d) differing++; if (d > maxDiff) maxDiff = d; }
console.log(`frame diff: 3 frames × ${n / 12} px, max channel diff ${maxDiff}, channels differing ${differing}`);
const linked = (r) => r.programs.length >= 1 && r.programs.every((p) => p.linked);
const ok = on.flag === true && off.flag === false
  && on.frame.length === off.frame.length
  && on.stats.parts > 0 && on.stats.aliased > 0 && on.stats.shared > 0 && on.stats.unaliased > 0 && on.aliasedNow > 0
  && off.stats.parts === 0 && off.aliasedNow === 0
  && on.errors.length === 0 && on.pageErrors.length === 0 && off.errors.length === 0 && off.pageErrors.length === 0
  && on.glError === 0 && off.glError === 0 && linked(on) && linked(off)
  && on.litPixels > 1500 && maxDiff === 0;
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
