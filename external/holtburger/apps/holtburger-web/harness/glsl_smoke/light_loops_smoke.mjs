// harness/glsl_smoke/light_loops_smoke.mjs — compile + image check for `?lightLoops`
// (scene3d/light_loops.js) in a real WebGL2 stack: local headless Chromium (ANGLE /
// SwiftShader), three r184 from node_modules, one MeshStandardMaterial lit by 16 point +
// 2 spot + 2 directional + 1 hemisphere lights, plain and with a retail-light-clamp-shaped
// RE_Direct wrapper (materials.js `_installLightClampShaderPatch`). NOT part of the node gate
// (it launches a browser — one heavy job at a time, run it under `capped-build`).
//
//   capped-build node harness/glsl_smoke/light_loops_smoke.mjs            # patch on: links? errors?
//   capped-build node harness/glsl_smoke/light_loops_smoke.mjs --compare  # on vs ?lightLoops=off: frame diff
//
// 2026-10-06 result: both programs link with no errors; --compare: 4096 px, max channel diff 0.
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
      if (u.pathname === "/page.html") { file = join(HERE, "light_loops_page.html"); type = "text/html"; }
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

const on = await run("");
const summary = (r) => ({ patch: r.patch, renderMs: r.renderMs, programs: r.programs, errors: r.errors, pageErrors: r.pageErrors, renderer: r.renderer });
console.log("patch on:", JSON.stringify(summary(on)));
let ok = on.errors.length === 0 && on.pageErrors.length === 0 && on.programs.length >= 2 && on.programs.every((p) => p.linked) && on.patch.installed;
if (process.argv.includes("--compare")) {
  const off = await run("?lightLoops=off");
  console.log("patch off:", JSON.stringify(summary(off)));
  let maxDiff = 0, differing = 0;
  for (let i = 0; i < on.frame.length; i++) { const d = Math.abs(on.frame[i] - off.frame[i]); if (d) differing++; if (d > maxDiff) maxDiff = d; }
  console.log(`frame diff: ${on.frame.length / 4} px, max channel diff ${maxDiff}, channels differing ${differing}`);
  ok = ok && off.programs.every((p) => p.linked) && maxDiff <= 1;
}
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
