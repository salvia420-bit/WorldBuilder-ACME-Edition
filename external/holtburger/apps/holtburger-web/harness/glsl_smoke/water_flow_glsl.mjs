// harness/glsl_smoke/water_flow_glsl.mjs "<?search>" — prints, as JSON on
// stdout, the terrain program terrain.js ASSEMBLES for that URL (the live
// ?radialFog pair the material compiles) and the cross-LB batched variant
// terrain_batch.js derives from it. Helper for water_flow_smoke.mjs: the
// water features are compile-time (read at module load), so each URL needs
// its own process. Node only — no browser here.
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { register } from "node:module";
import { readFileSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, "..", "..");
const search = process.argv[2] ?? "";
globalThis.window = { location: { search }, addEventListener() {}, removeEventListener() {} };
register(pathToFileURL(resolve(APP, "_three_stub_palette_loader.mjs")).href, import.meta.url);
const T = await import(pathToFileURL(resolve(APP, "scene3d/terrain.js")).href);
const W = await import(pathToFileURL(resolve(APP, "scene3d/terrain_water_flow.js")).href);
const R = await import(pathToFileURL(resolve(APP, "scene3d/terrain_round.js")).href);
const { vertex, fragment } = T._terrainGlslForTest();
const src = readFileSync(resolve(APP, "scene3d/terrain_batch.js"), "utf8")
  .replace(/^\s*import\s+.*$/gm, "")
  .replace(/^\s*export\s+function\s+/gm, "function ")
  .replace(/^\s*export\s+const\s+/gm, "const ");
const build = new Function("THREE", "window", "TERRAIN_FX_LIGHT_UNIFORMS", src + "\n; return _buildBatchedGlsl;")({}, undefined, undefined);
const b = build(vertex, fragment);
process.stdout.write(JSON.stringify({
  search,
  flow: W.WATER_FLOW.flow,
  bank: W.WATER_FLOW.bank,
  cols: W.waterTypesCols(R.terrainRoundTypesCols()),
  vertex,
  fragment,
  batchedVertex: b ? b.vertexShader : null,
  batchedFragment: b ? b.fragmentShader : null,
}));
