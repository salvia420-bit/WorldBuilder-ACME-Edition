// harness/glsl_smoke/terrain_vfx_compile_smoke.mjs — compile check for the terrain
// program and every terrain-VFX particle material (2026-10-23).
//
//   capped-build node harness/glsl_smoke/terrain_vfx_compile_smoke.mjs
//
// The terrain-family blocks (sand / snow sparkle, lava crack glow, obsidian glass,
// mud prints) are gated by UNIFORMS, so they compile into EVERY terrain material
// whatever the flags: a GLSL error there blanks the ground for everyone. Node
// assembles the exact programs (terrain._terrainGlslForTest under each define
// set; each particle field built by its own factory with real three), then one
// headless Chromium tab (SwiftShader, orchestrator only) compiles them through
// three's normal ShaderMaterial path on a log-depth renderer. PASS = every
// program links with no shader error and no console / page error.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..", "..");
const require = createRequire(import.meta.url);
const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");
const THREE = await import(join(APP, "node_modules/three/build/three.module.js"));

// Every family on, so each factory builds its material (the terrain GLSL is the same either way).
globalThis.window = { location: { search: "?terrainSand=on&terrainSnow=on&terrainVolcano=on&terrainDirt=on&terrainObsidian=on" } };
const programs = [];
const terrain = await import(join(APP, "scene3d/terrain.js"));
const g = terrain._terrainGlslForTest();
for (const d of [{}, { HB_TERRAIN_TRAIL_MAP: "" }, { HB_TERRAIN_TRAIL_MAP: "", HB_TERRAIN_CSM: "" }, { HB_TERRAIN_TRAIL_MAP: "", HB_TERRAIN_CSM: "", HB_TERRAIN_CSM_DIRECT: "" }]) {
  programs.push({ name: "terrain " + (Object.keys(d).join("+") || "plain"), vertexShader: g.vertex, fragmentShader: g.fragment, defines: d, glslVersion: "GLSL3" });
}
const oracle = { sample: () => ({ hasHeight: true, height: 10, code: 10, cornerCodes: [10, 10, 10, 10], normal: { x: 0, y: 0, z: 1 } }), heightAt: () => 10 };
for (const [label, mod, fn] of [["sand streamers", "terrain_sand.js", "createSandStreamerField"], ["snow spindrift", "terrain_snow.js", "createSpindriftField"],
  ["dirt puffs", "terrain_dirt.js", "createPuffField"], ["dirt haze", "terrain_dirt.js", "createDustHazeField"],
  ["rock pebbles", "terrain_rock.js", "createPebbleField"], ["rock grit", "terrain_rock.js", "createGritField"]]) {
  try {
    const m = await import(join(APP, "scene3d", mod));
    const f = m[fn]({ THREE, parent: new THREE.Group(), oracle: () => oracle, count: 8, radiusM: 16, seed: 1 });
    const mat = f.mesh ? f.mesh.material : null;
    if (!mat) { programs.push({ name: label, error: "no material built" }); continue; }
    programs.push({ name: label, vertexShader: mat.vertexShader, fragmentShader: mat.fragmentShader, defines: mat.defines || {},
      glslVersion: mat.glslVersion === THREE.GLSL3 ? "GLSL3" : null, transparent: !!mat.transparent, instanced: !!(f.mesh && f.mesh.isInstancedMesh) });
    try { f.dispose && f.dispose(); } catch (_) {}
  } catch (e) { programs.push({ name: label, error: String((e && e.stack) || e).slice(0, 600) }); }
}
delete globalThis.window;
const programsJson = JSON.stringify(programs);

const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"] });
let r;
try {
  const page = await browser.newPage();
  const consoleErrors = [], pageErrors = [], missing = [];
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 600)));
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 600)); });
  await page.route("http://smoke.test/**", (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === "/page.html") return route.fulfill({ status: 200, contentType: "text/html", body: readFileSync(join(HERE, "terrain_vfx_compile_page.html")) });
    if (u.pathname === "/programs.json") return route.fulfill({ status: 200, contentType: "application/json", body: programsJson });
    if (u.pathname === "/favicon.ico") return route.fulfill({ status: 200, contentType: "image/x-icon", body: "" });
    if (u.pathname.startsWith("/three/")) {
      try { return route.fulfill({ status: 200, contentType: "text/javascript", body: readFileSync(join(APP, "node_modules/three/build", u.pathname.slice(7))) }); } catch (e) { /* fall through */ }
    }
    missing.push(u.pathname);
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto("http://smoke.test/page.html");
  await page.waitForFunction(() => window.__smoke, null, { timeout: 240000 });
  r = await page.evaluate(() => window.__smoke);
  Object.assign(r, { consoleErrors, pageErrors, missing });
} finally { await browser.close(); }

const bad = (r.results || []).filter((x) => x.buildError || x.shaderError || x.throw || !x.linked || x.diagnostics);
for (const x of r.results || []) console.log(`${x.linked && !x.shaderError && !x.diagnostics && !x.buildError ? "ok  " : "FAIL"} ${x.name}`);
for (const x of bad) console.log(JSON.stringify(x, null, 1).slice(0, 3000));
const pass = r.errors.length === 0 && r.pageErrors.length === 0 && r.missing.length === 0 && bad.length === 0
  && (r.results || []).length === programs.length && r.consoleErrors.length === 0;
if (r.consoleErrors.length) console.log("console errors:", JSON.stringify(r.consoleErrors.slice(0, 4)).slice(0, 1500));
console.log("renderer:", r.renderer, "| programs:", programs.length);
console.log(pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
