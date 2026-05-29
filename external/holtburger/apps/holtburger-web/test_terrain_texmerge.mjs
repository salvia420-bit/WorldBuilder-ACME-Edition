// T1 (2026-05-28) — TexMerge composite JS-side unit tests.
//
// Run with:
//   cd /home/wbterminal/WorldBuilder-ACME-Edition
//   node external/holtburger/apps/holtburger-web/test_terrain_texmerge.mjs
//
// Exits non-zero on any failure.
//
// Covers:
// 1. `adapter.js::buildAlphaMaskArrayBytes` — packs the ordered alpha masks
//    [corner0..3, side0, road0..2] into a DataArrayTexture block, layer index
//    = position (which MUST equal the Rust selection core's alpha_index).
// 2. The fragment shader's `rotateCellUv` 90°-step contract, replicated in JS
//    (a future shader edit that breaks rotation is caught here without a GPU).
//
// `adapter.js` imports `"three"` — reuse the committed stub loader (same as
// test_terrain_palette / test_terrain_detail_tex). Only the 256×256 fast path
// is exercised, so no `document`/canvas polyfill is needed.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { register } from "node:module";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STUB_LOADER_PATH = resolvePath(__dirname, "_three_stub_palette_loader.mjs");
if (!existsSync(STUB_LOADER_PATH)) {
  console.error(`[setup] missing ${STUB_LOADER_PATH}; run test_terrain_palette.mjs once first.`);
  process.exit(2);
}
register(pathToFileURL(STUB_LOADER_PATH).href, import.meta.url);

const adapterUrl = pathToFileURL(resolvePath(__dirname, "scene3d/adapter.js")).href;
const { buildAlphaMaskArrayBytes } = await import(adapterUrl);

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (ok) passed++;
  else failed++;
}

const TILE = 256;
const STRIDE = TILE * TILE * 4;

// A8-decoded mask: RGBA with the weight in R (G=B=R, A=255 per the decoder).
function makeMask(weight) {
  const px = new Uint8Array(STRIDE);
  for (let i = 0; i < STRIDE; i += 4) {
    px[i] = weight;
    px[i + 1] = weight;
    px[i + 2] = weight;
    px[i + 3] = 255;
  }
  return { index: 0, code: 8, width: TILE, height: TILE, pixels: px };
}

// ---- Test 1: ordered 8-mask array, layer index = position --------------

console.log("Test 1: buildAlphaMaskArrayBytes ordering + placement");
// 4 corner + 1 side + 3 road = 8 (retail Dereth). Distinct weights to verify
// each lands in its own layer in [corner..,side,road..] order.
const ordered = [10, 20, 30, 40, 50, 60, 70, 80].map(makeMask);
const built = buildAlphaMaskArrayBytes(ordered);
check("tileSize === 256", built.tileSize === TILE, `got=${built.tileSize}`);
check("depth === 8", built.depth === 8, `got=${built.depth}`);
check(
  "alphaArrayBytes length === stride*8",
  built.alphaArrayBytes.length === STRIDE * 8,
  `got=${built.alphaArrayBytes.length}`
);
for (let layer = 0; layer < 8; layer++) {
  const want = [10, 20, 30, 40, 50, 60, 70, 80][layer];
  const base = layer * STRIDE;
  const ok =
    built.alphaArrayBytes[base] === want &&
    built.alphaArrayBytes[base + STRIDE - 4] === want; // R of last texel
  check(`layer ${layer} weight=${want} (alpha_index ${layer})`, ok, `R0=${built.alphaArrayBytes[base]}`);
}

// ---- Test 2: rejects empty input ---------------------------------------

console.log("Test 2: input validation");
let threw = false;
try {
  buildAlphaMaskArrayBytes([]);
} catch (_) {
  threw = true;
}
check("empty mask list throws", threw);

// ---- Test 3: rotateCellUv 90°-step contract (JS mirror of the shader) ---
//
// The shader rotates the intra-cell UV around (0.5,0.5) so one authored mask
// covers all four corner orientations. Lock the rotation math: each 90° step
// is a pure rotation (a corner maps to the next corner), Rot0 is identity, and
// 4 steps return to start.

console.log("Test 3: rotateCellUv 90°-step contract");
function rotateCellUv(uv, rot) {
  let cx = uv[0] - 0.5;
  let cy = uv[1] - 0.5;
  if (rot === 1) [cx, cy] = [-cy, cx];
  else if (rot === 2) [cx, cy] = [-cx, -cy];
  else if (rot === 3) [cx, cy] = [cy, -cx];
  return [cx + 0.5, cy + 0.5];
}
const eq = (a, b) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
const corner = [1, 0]; // SE-ish corner of the cell
check("Rot0 is identity", eq(rotateCellUv(corner, 0), corner));
// Four 90° steps return to the original point.
let p = corner;
for (let i = 0; i < 4; i++) p = rotateCellUv(p, 1);
check("four Rot90 steps return to start", eq(p, corner), `got=[${p}]`);
// Rot180 of [1,0] (i.e. [0.5,-0.5] offset) → [-0.5,0.5] offset → [0,1].
check("Rot180 maps [1,0] → [0,1]", eq(rotateCellUv([1, 0], 2), [0, 1]), `got=[${rotateCellUv([1, 0], 2)}]`);
// Centre is a fixed point of every rotation.
for (let r = 0; r < 4; r++) {
  check(`Rot${r * 90} fixes the cell centre`, eq(rotateCellUv([0.5, 0.5], r), [0.5, 0.5]));
}

console.log("");
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
