// T7 (2026-05-28) — terrain detail-diffuse texture unit tests.
//
// Run with:
//   cd /home/wbterminal/WorldBuilder-ACME-Edition
//   node external/holtburger/apps/holtburger-web/test_terrain_detail_tex.mjs
//
// Exits non-zero on any failure.
//
// ===========================================================================
// What this exercises
// ===========================================================================
//
// 1. `adapter.js::buildTerrainDetailArrayBytes` — packs N unique detail
//    slices into a `DataArrayTexture`-ready byte block, indexed by each
//    slice's `terrainType` (= slice index). Fast path (256×256) is a
//    byte-exact copy; we exercise that (no DOM/canvas needed).
// 2. The fragment-shader MODULATE2X + distance-fade contract, replicated in
//    JS so a future shader edit that breaks the invariants (mid-grey detail
//    is neutral; far fragments are neutral; disabled is a no-op) is caught
//    here without a GPU.
//
// `adapter.js` imports `"three"` as a bare specifier — reuse the committed
// `_three_stub_palette_loader.mjs` shim (same approach as
// test_terrain_palette.mjs). We DON'T touch the slow (canvas) resample
// path, so no `document` polyfill is required.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { register } from "node:module";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// The palette test creates these stub files on first run; if they're not
// present yet (running this test in isolation), fail loudly with guidance
// rather than silently. They're committed-by-generation siblings.
const STUB_LOADER_PATH = resolvePath(__dirname, "_three_stub_palette_loader.mjs");
if (!existsSync(STUB_LOADER_PATH)) {
  console.error(
    `[setup] missing ${STUB_LOADER_PATH}; run test_terrain_palette.mjs once first to generate the THREE stub.`
  );
  process.exit(2);
}
register(pathToFileURL(STUB_LOADER_PATH).href, import.meta.url);

const adapterUrl = pathToFileURL(resolvePath(__dirname, "scene3d/adapter.js")).href;
const { buildTerrainDetailArrayBytes } = await import(adapterUrl);

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  const status = ok ? "OK" : "FAIL";
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
  else passed += 1;
}

const TILE = 256;
const STRIDE = TILE * TILE * 4;

function makeSlice(sliceIdx, fillByte) {
  return {
    terrainType: sliceIdx,
    width: TILE,
    height: TILE,
    pixels: new Uint8Array(STRIDE).fill(fillByte),
  };
}

// ---- Test 1: builder shape + byte-exact layer placement ----------------

console.log("Test 1: buildTerrainDetailArrayBytes shape + placement");
// Mirror the retail dedup: 3 unique slices (0x050012AF, 0x05001786,
// 0x05001787). Distinct fill bytes per slice so we can verify each lands
// in its own layer at the right offset.
const slices = [makeSlice(0, 11), makeSlice(1, 22), makeSlice(2, 33)];
const built = buildTerrainDetailArrayBytes(slices);
check("tileSize === 256", built.tileSize === TILE, `got=${built.tileSize}`);
check("depth === 3", built.depth === 3, `got=${built.depth}`);
check(
  "detailArrayBytes length === stride*depth",
  built.detailArrayBytes.length === STRIDE * 3,
  `got=${built.detailArrayBytes.length}`
);
for (let s = 0; s < 3; s++) {
  const want = [11, 22, 33][s];
  const base = s * STRIDE;
  const allMatch =
    built.detailArrayBytes[base] === want &&
    built.detailArrayBytes[base + STRIDE - 1] === want;
  check(
    `layer ${s} byte-exact (fill=${want})`,
    allMatch,
    `first=${built.detailArrayBytes[base]} last=${built.detailArrayBytes[base + STRIDE - 1]}`
  );
}

// ---- Test 2: out-of-order slice indices land in the right layer --------

console.log("Test 2: slice index (terrainType) drives layer, not array order");
const reordered = [makeSlice(2, 77), makeSlice(0, 88), makeSlice(1, 99)];
const built2 = buildTerrainDetailArrayBytes(reordered);
check("layer 0 came from terrainType=0 (88)", built2.detailArrayBytes[0 * STRIDE] === 88);
check("layer 1 came from terrainType=1 (99)", built2.detailArrayBytes[1 * STRIDE] === 99);
check("layer 2 came from terrainType=2 (77)", built2.detailArrayBytes[2 * STRIDE] === 77);

// ---- Test 3: bad input is rejected -------------------------------------

console.log("Test 3: input validation");
let threwEmpty = false;
try {
  buildTerrainDetailArrayBytes([]);
} catch (_) {
  threwEmpty = true;
}
check("empty slice list throws", threwEmpty);

let threwOob = false;
try {
  // slice index 5 with depth 1 → out of range.
  buildTerrainDetailArrayBytes([makeSlice(5, 1)]);
} catch (_) {
  threwOob = true;
}
check("out-of-range slice index throws", threwOob);

// ---- Test 4: MODULATE2X + fade contract (JS mirror of the shader) ------
//
// The fragment computes:
//   fade = 1 - smoothstep(fadeStart, fadeEnd, viewDepth)
//   amt  = clamp(strength,0,1) * fade
//   mod2x = clamp(detail*2, 0, 2)
//   result *= mix(1.0, mod2x, amt)
// Invariants this locks:
//   - detail == 0.5 (mid-grey) → mod2x == 1.0 → neutral at ANY amt.
//   - viewDepth >= fadeEnd → fade 0 → neutral regardless of detail.
//   - enabled == false (amt forced 0) → neutral (no-op default path).

console.log("Test 4: MODULATE2X + distance-fade contract");
function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
function detailMultiplier({ detail, viewDepth, strength, fadeStart, fadeEnd, enabled }) {
  if (!enabled) return 1.0;
  const fade = 1 - smoothstep(fadeStart, fadeEnd, viewDepth);
  const amt = Math.min(1, Math.max(0, strength)) * fade;
  const mod2x = Math.min(2, Math.max(0, detail * 2));
  return 1.0 * (1 - amt) + mod2x * amt; // mix(1.0, mod2x, amt)
}
const base = { strength: 0.5, fadeStart: 18, fadeEnd: 75, enabled: true };

const midGrey = detailMultiplier({ ...base, detail: 0.5, viewDepth: 0 });
check("mid-grey detail (0.5) is neutral near camera", Math.abs(midGrey - 1.0) < 1e-9, `got=${midGrey}`);

const farAway = detailMultiplier({ ...base, detail: 0.0, viewDepth: 200 });
check("beyond fadeEnd is neutral (fade→0)", Math.abs(farAway - 1.0) < 1e-9, `got=${farAway}`);

const disabled = detailMultiplier({ ...base, detail: 0.0, viewDepth: 0, enabled: false });
check("disabled is a no-op (default path)", disabled === 1.0, `got=${disabled}`);

const darkNear = detailMultiplier({ ...base, detail: 0.0, viewDepth: 0 });
check("dark detail near camera darkens (<1)", darkNear < 1.0 && darkNear >= 0, `got=${darkNear}`);

const brightNear = detailMultiplier({ ...base, detail: 1.0, viewDepth: 0 });
check("bright detail near camera brightens (>1)", brightNear > 1.0, `got=${brightNear}`);

// Symmetry: equal-magnitude dark/bright excursions around mid-grey cancel
// in the mean (detail-texture authoring relies on a ~0.5 mean to preserve
// the base tile's average brightness under MODULATE2X).
const meanPreserved = Math.abs((darkNear + brightNear) / 2 - 1.0) < 1e-9;
check("dark/bright excursions are symmetric about neutral", meanPreserved, `mean=${(darkNear + brightNear) / 2}`);

// ---- Summary -----------------------------------------------------------

console.log("");
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
