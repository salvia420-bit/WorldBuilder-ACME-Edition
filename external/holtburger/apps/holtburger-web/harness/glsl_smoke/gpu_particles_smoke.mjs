// harness/glsl_smoke/gpu_particles_smoke.mjs — GPU check for `?gpuParticles`
// (round 3 R3-7a, scene3d/particles/gpu_particles.js) in a real WebGL2 stack:
// local headless Chromium (ANGLE / SwiftShader), three r184 from node_modules,
// the app's own particle modules. gpu_particles_glsl.mjs (node) runs the
// scenarios flag off and flag on through the real ParticleManager and dumps the
// production GLSL header, the record / row tables and every gpu instance with
// its flag-off CPU reference; gpu_particles_page.html evaluates the PRODUCTION
// header on the GPU and reads the result back (RGBA32F), then compiles the real
// bucket materials through three. Verdicts (tests/helpers/gpu_particles_smoke_data.mjs):
//   S1 every kernel program and every production material (stock additive,
//      the alpha bucket, FX additive / alpha / glow for each tier-1 smoke x
//      tier-2 motion / shapes / clamp variant) compiles and links
//      (checkShaderErrors on), no page / GL error
//   S2 the kernel readback (instance matrix) vs the flag-off CPU matrices
//      within 1e-4 relative, every ParticleType 1..12, persistent and
//      parented, billboard modes 0 / 2 / 3 / 4 / 5 / the POJO sprite
//   S3 colours: op and fxAge within 1e-4, the row part of b exact
//   S4 the large-clock replays (+12,345.678 s on the hi/lo clock with no
//      rebase, +16,000 s through an epoch rebase) meet S2
//   S5 index 0, a zeroed record and translucency >= 1 collapse to zero
//   S6 the HB_FX_MOTION velocity row vs the analytic twin within 1e-4 relative
//   S7 the production materials place single instances within 1 px of the CPU
//      projection (coverage centroid, top-down orthographic camera, RGBA8);
//      one draw per bucket, as many as flag off. Camera + projection:
//      tests/helpers/gpu_particles_smoke_scene.mjs (shared with the node S7n
//      check; 2026-10-31: three's ortho frustum is view space, the page used to
//      pass world bounds and framed every case 8 to 40 px off)
// SwiftShader proves the GLSL semantics. The shader calls no driver sin / cos
// (2026-10-31: SwiftShader's are an order-5 polynomial, 1.3e-4 relative, which
// failed S2 / S4 / S6 at 2.2e-4 on Swarm amplitudes; hbGpSinCos uses + - *
// floor only); FXC reassociation is only proven by the same page on the 1070
// (owner session). tests/gpu_particles.test.mjs section S replays S2 / S4 / S6
// under SwiftShader's trig and S7 through three's real program in node.
// NOT part of the node gate (it launches a browser — one heavy job at a time,
// run it under `capped-build`):
//
//   capped-build node harness/glsl_smoke/gpu_particles_smoke.mjs
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
const require = createRequire(import.meta.url);
const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");
const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..", "..");

const dump = spawnSync(process.execPath, [join(HERE, "gpu_particles_glsl.mjs")], { cwd: APP, encoding: "utf8", maxBuffer: 256 << 20 });
if (dump.status !== 0) throw new Error(`gpu_particles_glsl.mjs failed: ${(dump.stderr || "").slice(-1200)}`);
const DATA_JSON = dump.stdout;
const data = JSON.parse(DATA_JSON);
const { evaluateSmoke } = await import("../../tests/helpers/gpu_particles_smoke_data.mjs");

async function run() {
  const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"] });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    const consoleErrors = [];
    const missing = [];
    page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 400)));
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 400)); });
    await page.route("http://smoke.test/**", (route) => {
      const u = new URL(route.request().url());
      let file = null, type = "text/javascript", body = null;
      if (u.pathname === "/page.html") { file = join(HERE, "gpu_particles_page.html"); type = "text/html"; }
      else if (u.pathname === "/data.json") { body = DATA_JSON; type = "application/json"; }
      else if (u.pathname.startsWith("/three/")) file = join(APP, "node_modules/three/build", u.pathname.slice(7));
      else if (u.pathname.startsWith("/app/")) file = join(APP, u.pathname.slice(5));
      if (body !== null) return route.fulfill({ status: 200, contentType: type, body });
      if (!file) { if (u.pathname !== "/favicon.ico") missing.push(u.pathname); return route.fulfill({ status: 404, body: "" }); }
      if (file.endsWith(".json")) type = "application/json";
      try { return route.fulfill({ status: 200, contentType: type, body: readFileSync(file) }); } catch (e) { missing.push(u.pathname); return route.fulfill({ status: 404, body: String(e) }); }
    });
    await page.goto("http://smoke.test/page.html");
    await page.waitForFunction(() => window.__smoke, null, { timeout: 900000 });
    const r = await page.evaluate(() => window.__smoke);
    r.pageErrors = [...pageErrors, ...consoleErrors, ...missing.map((m) => `404 ${m}`)];
    return r;
  } finally { await browser.close(); }
}

const r = await run();
const checks = evaluateSmoke(data, r);
console.log(`== gpuParticles smoke: ${data.cases.length} cases, ${data.cases.reduce((a, c) => a + c.entries.length, 0)} instances, renderer=${r.renderer}`);
for (const ch of checks) console.log(`  ${ch.ok ? "ok  " : "FAIL"} ${ch.name}${ch.ok ? "" : ` — ${ch.detail}`}`);
for (const ch of checks) if (ch.ok) console.log(`    ${ch.name.slice(0, 3)} ${ch.detail}`);
if (r.errors.length || (r.pageErrors || []).length) console.log("  errors:", JSON.stringify([...r.errors, ...(r.pageErrors || [])]).slice(0, 4000));
const ok = checks.length > 0 && checks.every((x) => x.ok);
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
