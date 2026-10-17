// harness/glsl_smoke/reversed_z_smoke.mjs — GPU check for `?reversedZ=on`
// (scene3d/shader_logdepth.js "REVERSED-Z") in a real WebGL2 stack: local
// headless Chromium (ANGLE / SwiftShader), three r184 + postprocessing 6.39.1
// from node_modules, the app's own shader_logdepth.js + portal_punch.js. Runs
// reversed_z_page.html twice (?mode=log, ?mode=reversed) and checks, into a
// FLOAT depth target like the composer's:
//   S1 depthFunc Always draws (three r184 maps it to NEVER under reversed)
//   S2 0.3 m at 1 km resolves in both draw orders
//   S3 the depth texel decodes to the true distance (37 m)
//   S4 the portal punch resets depth so an interior behind the facade draws
//   S5 the floor-bias twin wins its coplanar tie
//   S6 transparent draws sort back-to-front (r184 keys on clip z)
//   S7 every program links (checkShaderErrors on)
// NOT part of the node gate (it launches a browser — one heavy job at a time,
// run it under `capped-build`):
//
//   capped-build node harness/glsl_smoke/reversed_z_smoke.mjs
//
// If SwiftShader lacks EXT_clip_control the reversed arm reports it and the
// run FAILS loudly (the client would fall back to the log buffer) — rerun on
// a GPU-backed Chromium then.
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
      if (u.pathname === "/page.html") { file = join(HERE, "reversed_z_page.html"); type = "text/html"; }
      else if (u.pathname.startsWith("/three/")) file = join(APP, "node_modules/three/build", u.pathname.slice(7));
      else if (u.pathname.startsWith("/pp/")) file = join(APP, "node_modules/postprocessing/build", u.pathname.slice(4));
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

let ok = true;
for (const mode of ["log", "reversed"]) {
  const r = await run(`?mode=${mode}`);
  console.log(`== mode=${mode} renderer=${r.renderer} clipControl=${r.clipControl} reversed=${r.reversed} fixes=${JSON.stringify(r.fixes)}`);
  for (const c of r.checks || []) console.log(`  ${c.ok ? "ok  " : "FAIL"} ${c.name}${c.ok ? "" : ` — ${c.detail}`}`);
  if (r.errors.length || r.pageErrors.length) console.log("  errors:", JSON.stringify([...r.errors, ...r.pageErrors]).slice(0, 2000));
  ok = ok && (r.checks || []).length >= 7 && r.checks.every((c) => c.ok) && !r.errors.length && !r.pageErrors.length;
}
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
