// tests/challenger_pom_shader_compile.mjs
// Adversarial Challenger: POM Shader Compilation & WebGL Execution Matrix Test
// Runs real WebGL shader compilation and rendering under WebGL2 / SwiftShader
// across permutations of logdepth on/off, reversedZ on/off, CSM on/off, and quality presets.

import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..");
const SMOKE_PAGE = join(APP, "harness/glsl_smoke/challenger_pom_matrix_page.html");

console.log("======================================================================");
console.log(" CHALLENGER STRESS HARNESS: POM WebGL Shader Compilation Matrix");
console.log("======================================================================");

async function runPermutation(searchQuery) {
  const browser = await chromium.launch({
    executablePath: "/usr/bin/chromium",
    headless: true,
    args: [
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--no-sandbox",
    ],
  });

  try {
    const page = await browser.newPage();
    const pageErrors = [];
    const missing = [];

    page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 400)));

    await page.route("http://smoke.test/**", (route) => {
      const u = new URL(route.request().url());
      let file, type = "text/javascript";
      if (u.pathname === "/page.html") {
        file = SMOKE_PAGE;
        type = "text/html";
      } else if (u.pathname.startsWith("/three-addons/")) {
        file = join(APP, "node_modules/three/examples/jsm", u.pathname.slice(14));
      } else if (u.pathname.startsWith("/three/")) {
        file = join(APP, "node_modules/three/build", u.pathname.slice(7));
      } else if (u.pathname.startsWith("/app/")) {
        file = join(APP, u.pathname.slice(5));
      }

      if (!file || !existsSync(file)) {
        if (u.pathname !== "/favicon.ico") missing.push(u.pathname);
        return route.fulfill({ status: 404, body: `File not found: ${u.pathname}` });
      }

      try {
        return route.fulfill({ status: 200, contentType: type, body: readFileSync(file) });
      } catch (e) {
        missing.push(u.pathname);
        return route.fulfill({ status: 404, body: String(e) });
      }
    });

    await page.goto(`http://smoke.test/page.html${searchQuery}`);
    await page.waitForFunction(() => window.__smoke, null, { timeout: 60000 });
    const res = await page.evaluate(() => window.__smoke);

    res.pageErrors = pageErrors;
    res.missing = missing;
    return res;
  } finally {
    await browser.close();
  }
}

const permutations = [
  { name: "Permutation 1: LogDepth ON, CSM ON, Quality HIGH", query: "?depthMode=log&csm=1&quality=high" },
  { name: "Permutation 2: Reversed-Z ON, CSM ON, Quality HIGH", query: "?depthMode=reversed&csm=1&quality=high" },
  { name: "Permutation 3: Standard Depth (LogDepth OFF), CSM OFF, Quality HIGH", query: "?depthMode=standard&csm=0&quality=high" },
  { name: "Permutation 4: LogDepth ON, CSM ON, Quality ULTRA (32 steps, 50m Far LOD)", query: "?depthMode=log&csm=1&quality=ultra" },
  { name: "Permutation 5: LogDepth ON, CSM OFF, Quality MID (8 steps)", query: "?depthMode=log&csm=0&quality=mid" },
  { name: "Permutation 6: LogDepth ON, CSM OFF, Quality LOW (4 steps)", query: "?depthMode=log&csm=0&quality=low" },
];

let allPassed = true;
let totalChecks = 0;
let totalPassedChecks = 0;

for (const p of permutations) {
  console.log(`\n--- Running ${p.name} ---`);
  const r = await runPermutation(p.query);

  console.log(`  Renderer: ${r.renderer}, LogDepth: ${r.logarithmicDepthBuffer}, Programs Compiled: ${r.programsCompiled}`);

  let permOk = true;
  for (const c of r.results || []) {
    totalChecks++;
    if (c.ok) {
      totalPassedChecks++;
      console.log(`    [PASS] ${c.name}`);
    } else {
      permOk = false;
      allPassed = false;
      console.error(`    [FAIL] ${c.name} : ${c.detail}`);
    }
  }

  if (r.errors.length > 0 || r.pageErrors.length > 0) {
    permOk = false;
    allPassed = false;
    console.error("    [FAIL] Errors:", JSON.stringify([...r.errors, ...r.pageErrors]));
  }
  if (r.missing.length > 0) {
    permOk = false;
    allPassed = false;
    console.error("    [FAIL] Missing files:", r.missing);
  }

  if (permOk) {
    console.log(`  => ${p.name}: ALL CHECKS PASSED`);
  } else {
    console.error(`  => ${p.name}: FAILED`);
  }
}

console.log("\n======================================================================");
console.log(` TOTAL SHADER COMPILATION CHECKS: ${totalPassedChecks} / ${totalChecks} passed`);
console.log(` OVERALL VERDICT: ${allPassed ? "PASS" : "FAIL"}`);
console.log("======================================================================");

process.exit(allPassed ? 0 : 1);
