// harness/glsl_smoke/heat_haze_smoke.mjs — browser smoke for the heat shimmer +
// mirage GLSL (2026-10-23; scene3d/vfx/heat_haze_glsl.js, heat_haze_effect.js).
//
//   capped-build node harness/glsl_smoke/heat_haze_smoke.mjs [--png DIR]
//
// One headless Chromium tab (SwiftShader), orchestrator only (laptop rules).
// heat_haze_page.html compiles the SHIPPED GLSL in a pmndrs EffectPass over a
// log-depth scene and reads back four arms (off / disc / ground / mirage). PASS =
// every program links, no console / page / GL errors, and per arm:
//   - the SKY never changes (the depth gate);
//   - disc and ground change the far ground; ground leaves the bottom rows
//     (nearest ground, < groundNear) alone;
//   - the mirage changes the rows just below the horizon and nothing in the
//     bottom quarter (it only starts at 160 m).
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..", "..");
const require = createRequire(import.meta.url);
const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");
const PNG_DIR = (() => { const i = process.argv.indexOf("--png"); return i >= 0 ? process.argv[i + 1] : null; })();

const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"] });
let r;
try {
  const page = await browser.newPage();
  const pageErrors = [], consoleErrors = [], glWarnings = [], missing = [];
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 600)));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 1200));
    else if (/GL_INVALID|WebGL: INVALID/.test(m.text())) glWarnings.push(m.text().slice(0, 400));
  });
  await page.route("http://smoke.test/**", (route) => {
    const u = new URL(route.request().url());
    let file, type = "text/javascript";
    if (u.pathname === "/page.html") { file = join(HERE, "heat_haze_page.html"); type = "text/html"; }
    else if (u.pathname === "/favicon.ico") return route.fulfill({ status: 200, contentType: "image/x-icon", body: "" });
    else if (u.pathname.startsWith("/three/")) file = join(APP, "node_modules/three/build", u.pathname.slice(7));
    else if (u.pathname.startsWith("/pp/")) file = join(APP, "node_modules/postprocessing/build", u.pathname.slice(4));
    else if (u.pathname.startsWith("/app/")) file = join(APP, u.pathname.slice(5));
    if (!file) { missing.push(u.pathname); return route.fulfill({ status: 404, body: "" }); }
    try { return route.fulfill({ status: 200, contentType: type, body: readFileSync(file) }); } catch (e) { missing.push(u.pathname); return route.fulfill({ status: 404, body: String(e) }); }
  });
  await page.goto(`http://smoke.test/page.html${PNG_DIR ? "?png=1" : ""}`);
  await page.waitForFunction(() => window.__smoke, null, { timeout: 120000 });
  r = await page.evaluate(() => window.__smoke);
  Object.assign(r, { pageErrors, consoleErrors, glWarnings, missing });
} finally { await browser.close(); }

if (PNG_DIR && r.png) {
  mkdirSync(PNG_DIR, { recursive: true });
  for (const [name, url] of Object.entries(r.png)) writeFileSync(join(PNG_DIR, `${name}.png`), Buffer.from(url.slice(22), "base64"));
  r.pngDir = PNG_DIR;
}
delete r.png;

const A = r.arms || {};
const f = (arm, band) => (A[arm] && A[arm][band] ? A[arm][band].frac : -1);
const n = (arm, band) => (A[arm] && A[arm][band] ? A[arm][band].changed : -1);
const checks = {
  pageRan: !!r && Array.isArray(r.errors) && r.errors.length === 0,
  programsLinked: (r.programs || []).length > 0 && r.programs.every((p) => p.linked && !p.diagnostics),
  noConsoleErrors: r.consoleErrors.length === 0 && r.pageErrors.length === 0 && r.glWarnings.length === 0 && r.missing.length === 0,
  noGlError: r.glError === 0,
  horizonFound: r.horizonRow > 20 && r.horizonRow < 175,
  skyNeverWarps: ["disc", "ground", "mirage"].every((a) => f(a, "sky") === 0),
  // The striped plain is uniform along x, so a sideways warp only moves the
  // posts and the thin lines: count pixels, not a fraction.
  discWarpsFarGround: n("disc", "nearHorizon") + n("disc", "mid") >= 100,
  groundWarpsFar: f("ground", "nearHorizon") > 0.05,
  groundSparesUnderfoot: f("ground", "bottom") < 0.01,
  mirageAtHorizon: f("mirage", "nearHorizon") > 0.05,
  mirageSparesNear: f("mirage", "bottom") === 0,
};
const pass = Object.values(checks).every(Boolean);
console.log(JSON.stringify({ renderer: r.renderer, horizonRow: r.horizonRow, arms: A, programs: r.programs, errors: r.errors, consoleErrors: r.consoleErrors, glWarnings: r.glWarnings, missing: r.missing, pngDir: r.pngDir }, null, 1));
console.log("checks:", JSON.stringify(checks));
console.log(pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
