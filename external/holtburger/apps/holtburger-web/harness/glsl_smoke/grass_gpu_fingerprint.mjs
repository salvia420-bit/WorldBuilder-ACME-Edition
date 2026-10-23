// harness/glsl_smoke/grass_gpu_fingerprint.mjs — the GLSL FINGERPRINT LOCK of
// `?terrainGrassGpu` (2026-10-23, review tests-1; design contract
// docs/2026-10-23-grass-gpu-placement.md, Validation).
//
// WHY. The node tests hold the JS MIRRORS (sampleMirror, gpuContainsMirror,
// grassGpuPlaceMirror) to the real CPU path; none of them executes
// TERRAIN_FIELD_GLSL, INTERIOR_MASK_GLSL or the placement GLSL (only the hash
// is interpreted). The one check that runs the shipped GLSL against the CPU is
// the browser readback smoke (grass_gpu_smoke.mjs, orchestrator-only, outside
// the node gate). So a GLSL edit that breaks the semantics would pass every
// node test. The lock closes that gap cheaply: a sha256 over the shipped GLSL,
// recorded in grass_gpu_smoke.stamp.json by the smoke when it PASSES, and
// compared by test_terrain_grass_gpu.mjs in the node gate. Any GLSL edit fails
// the node gate until the smoke has been re-run (and passed) on the new text.
//
// WHAT IS HASHED, in order, each part separately (the stamp keeps the part
// hashes, so a mismatch names what moved):
//   hash      GRASS_GPU_HASH_GLSL
//   field     TERRAIN_FIELD_GLSL
//   mask      INTERIOR_MASK_GLSL
//   place     buildGrassPlaceGlsl()
//   vertex    injectTerrainGrassGpuShader() over STUB_SHADER, vertex stage
//   fragment  the same, fragment stage
// NORMALISED OUT: the generated GRASS_VARIANTS branch lines of hbGrassVariant
// ("if (code == N) { shape = vec4(...); look = vec4(...); return true; }") in
// every part that carries them, so a look-table tweak (heights, tints, keep,
// bare, a new grass code) does not trip the lock: the mirror reads the same
// table and the node parity tests already follow it. Line endings are
// normalised to LF; nothing else is.
//
// KNOWN WIDENING (accepted): the injected parts also contain the SHARED CPU
// grass snippets (the vertex look, the ground normal, the fragment tint),
// SCATTER_FADE_GLSL and the per-instance hash patch, so an edit there trips
// the lock too, although the CPU path is covered by its own tests. The smoke's
// frame compare runs that very shader, so re-running it is the right answer.
//
// NOT HASHED (known gap): the JS texel LAYOUT the GLSL reads. Which texel holds
// what is written by the JS writers (grass_interior_mask.js writeGpu, e.g. the
// world AABB in texel 5; the terrain_field_gpu.js mirror) and read back by the
// JS mirrors; the node tests tie mirror to writer, never GLSL to writer. A
// matching edit of writer + mirror with the GLSL untouched passes the node
// gate and this lock with the old stamp. Re-run the smoke after ANY layout
// edit, not only GLSL edits.
//
// IMPORT ORDER. terrain_grass.js and grass_gpu_place.js import each other (an
// ESM cycle, see grass_gpu_place.js IMPORT ORDER). This module imports
// terrain_grass.js FIRST (the app's order) and reads every imported binding
// only inside grassGpuGlslFingerprint(), never at module top level, so it
// loads in either order, alone or after a test has imported the modules.
//
// No three, no browser, no clocks: a pure function of the module sources.
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { injectTerrainGrassGpuShader } from "../../scene3d/terrain_grass.js";
import { GRASS_GPU_HASH_GLSL, buildGrassPlaceGlsl } from "../../scene3d/grass_gpu_place.js";
import { TERRAIN_FIELD_GLSL } from "../../scene3d/terrain_field_gpu.js";
import { INTERIOR_MASK_GLSL } from "../../scene3d/grass_interior_mask.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The stamp the smoke writes on PASS and the node gate reads. */
export const GRASS_GPU_STAMP_PATH = join(HERE, "grass_gpu_smoke.stamp.json");

/** The command that refreshes the stamp (orchestrator only: it starts a browser). */
export const GRASS_GPU_SMOKE_CMD = "capped-build node harness/glsl_smoke/grass_gpu_smoke.mjs";

/** Bumped when WHAT is hashed changes, so an old stamp cannot match by accident. */
export const GRASS_GPU_FINGERPRINT_VERSION = 1;

/**
 * A fixed, minimal onBeforeCompile shader carrying every seam the grass
 * injector and the per-instance hash patch splice at (common, main,
 * beginnormal_vertex, begin_vertex; normal_fragment_begin, color_fragment,
 * dithering_fragment). Fixed text rather than three's ShaderLib, so a three
 * upgrade alone never trips the lock; the smoke's frame compare is what runs
 * the injector against the real ShaderLib.
 */
export const STUB_SHADER = Object.freeze({
  vertexShader: [
    "#include <common>",
    "void main() {",
    "#include <beginnormal_vertex>",
    "#include <begin_vertex>",
    "#include <project_vertex>",
    "}",
  ].join("\n"),
  fragmentShader: [
    "#include <common>",
    "void main() {",
    "#include <normal_fragment_begin>",
    "#include <color_fragment>",
    "#include <dithering_fragment>",
    "}",
  ].join("\n"),
});

/** One generated GRASS_VARIANTS branch line (buildGrassPlaceGlsl's table). */
const VARIANT_LINE = /^[ \t]*if \(code == \d+\) \{ shape = vec4\([^\n]*\); look = vec4\([^\n]*\); return true; \}[ \t]*$/;

/**
 * `src` with CRLF -> LF and every generated variant branch line removed.
 * Exported for the node test (a look-table tweak must leave it unchanged).
 * @param {string} src
 * @returns {{text: string, variantLines: number}}
 */
export function normaliseGrassGpuGlsl(src) {
  let variantLines = 0;
  const kept = [];
  for (const line of String(src).replace(/\r\n?/g, "\n").split("\n")) {
    if (VARIANT_LINE.test(line)) { variantLines += 1; continue; }
    kept.push(line);
  }
  return { text: kept.join("\n"), variantLines };
}

const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * The fingerprint of the shipped grass GPU GLSL (see the header).
 * @returns {{fingerprint: string, version: number, parts: Object<string, string>,
 *   variantLines: Object<string, number>, bytes: number}}
 *   fingerprint = sha256 over the version and the part hashes in order;
 *   parts = per-part sha256 (normalised text); variantLines = the generated
 *   lines removed per part (place / vertex should hold one per grass code).
 */
export function grassGpuGlslFingerprint() {
  const shader = { vertexShader: STUB_SHADER.vertexShader, fragmentShader: STUB_SHADER.fragmentShader };
  injectTerrainGrassGpuShader(shader);
  const raw = [
    ["hash", GRASS_GPU_HASH_GLSL],
    ["field", TERRAIN_FIELD_GLSL],
    ["mask", INTERIOR_MASK_GLSL],
    ["place", buildGrassPlaceGlsl()],
    ["vertex", shader.vertexShader],
    ["fragment", shader.fragmentShader],
  ];
  const parts = {};
  const variantLines = {};
  let bytes = 0;
  const all = createHash("sha256");
  all.update(`grass-gpu-glsl-fingerprint v${GRASS_GPU_FINGERPRINT_VERSION}\n`);
  for (const [name, src] of raw) {
    if (typeof src !== "string" || src.length === 0) throw new Error(`grass GPU fingerprint: part ${name} is empty`);
    const n = normaliseGrassGpuGlsl(src);
    parts[name] = sha256(n.text);
    variantLines[name] = n.variantLines;
    bytes += n.text.length;
    all.update(`${name}:${parts[name]}\n`);
  }
  return { fingerprint: all.digest("hex"), version: GRASS_GPU_FINGERPRINT_VERSION, parts, variantLines, bytes };
}
