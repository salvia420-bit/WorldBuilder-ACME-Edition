// 2026-07-31 — terrain WATER animation regression tests.
//
// Run with:
//   cd /home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web
//   node test_terrain_water.mjs
//
// Exits non-zero on any failure.
//
// Water has TWO simultaneous animations that must both survive every code
// path: the VERTICAL SWELL (vertex displacement) and the SURFACE MOVEMENT
// (fragment UV scroll + sheen normal). Each check below locks one of the
// bugs found on 2026-07-31 (see docs/2026-07-31-water-fix-report.md):
//
//   1. The TexMerge composite (DEFAULT ON) replaced the bilinear result
//      wholesale while sampling every slot at the UNSCROLLED cellUv, so the
//      surface scroll was dead world-wide.
//   2. The tint breath was gated on uDisplacementEnabled (== subdivLevel>=2),
//      so it died at quality low/mid despite being a pure per-pixel effect.
//   3. The swell was a raw per-vertex sine, which is NOT linear along a cell
//      edge — so the fine/coarse subdiv LOD boundary that follows the player
//      tore open water. It is now lattice-locked (bilinear over the 24 m
//      control grid), which IS linear along an edge.
//   4. terrainplan s4's water sheen sat inside `uPbrEnabled && !acGouraud`,
//      and retail Gouraud is default-ON and wins that test, so the
//      default-on uWaterEnvEnabled gate did nothing at all.
//   5. Every water site must read the SHARED uWaterCodeMask (via
//      isWaterCode), never a hardcoded terrain-code range.
//
// Most checks are GLSL SOURCE assertions (no GPU needed) plus a JS
// re-implementation of the lattice wave that proves the LOD-crack property
// numerically. Shader source is read from the module's exported strings where
// possible and otherwise from the file text, exactly like
// test_terrain_texmerge.mjs reads adapter.js through the three stub.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { register } from "node:module";
import { existsSync, readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STUB_LOADER_PATH = resolvePath(__dirname, "_three_stub_palette_loader.mjs");
if (!existsSync(STUB_LOADER_PATH)) {
  console.error(`[setup] missing ${STUB_LOADER_PATH}; run test_terrain_palette.mjs once first.`);
  process.exit(2);
}
register(pathToFileURL(STUB_LOADER_PATH).href, import.meta.url);

const TERRAIN_PATH = resolvePath(__dirname, "scene3d/terrain.js");
const SRC = readFileSync(TERRAIN_PATH, "utf8");
const terrainUrl = pathToFileURL(TERRAIN_PATH).href;
const {
  computeCodeBitmask,
  sharedTerrainTimeSec,
  PHASE_2_2_WATER_CODES,
  WATER_SURFACE_CODES,
} = await import(terrainUrl);

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (ok) passed++;
  else failed++;
}

// Slice the two GLSL template literals out of the module source so the
// assertions below can distinguish "present in the vertex stage" from
// "present in the fragment stage" (a helper declared in one is NOT visible in
// the other — the bug that once rendered the whole terrain black).
function glslBlock(marker) {
  const lines = SRC.split("\n");
  const i = lines.indexOf(marker);
  if (i < 0) throw new Error("missing GLSL marker: " + marker);
  let j = i + 1;
  while (j < lines.length && lines[j] !== "`;") j++;
  return lines.slice(i + 1, j).join("\n");
}
const VERT = glslBlock("const TERRAIN_VERTEX_GLSL = `");
const FRAG = glslBlock("const TERRAIN_FRAGMENT_GLSL = `");

console.log("Test 1: both water animations exist and are independently gated");
// The swell rides uDisplacementEnabled; the surface motion rides
// uWaterScrollEnabled. Neither may be nested inside the other's gate, or one
// effect silently disables the other (the whole point of the spec's "the two
// effects must work TOGETHER").
check(
  "vertex swell is gated on uDisplacementEnabled",
  /if \(uDisplacementEnabled > 0\.5 && code >= 0 && code < 32\)/.test(VERT)
);
check(
  "fragment scroll is gated on uWaterScrollEnabled, NOT uDisplacementEnabled",
  /vec2 waterCellUv = cellUv;\s*\n\s*if \(uWaterScrollEnabled > 0\.5\) \{/.test(FRAG)
);
check(
  "fragment stage never gates anything on uDisplacementEnabled any more",
  !/uDisplacementEnabled/.test(FRAG.replace(/\/\/[^\n]*/g, "")),
  "the tint breath used to, which killed it at quality low/mid"
);
check(
  "the tint breath rides the surface-animation gate",
  /if \(uWaterScrollEnabled > 0\.5 && waterW > 0\.0\) \{/.test(FRAG)
);

console.log("\nTest 2: TexMerge composite scrolls its water slots (the headline bug)");
// The composite ends in `result = merged;` — it OVERWRITES the bilinear
// blend. If its own samples do not honour the scrolled UV, the surface
// motion is dead everywhere texMerge is on, which is the default.
const mergeBlock = FRAG.slice(
  FRAG.indexOf("if (uTexMergeEnabled > 0.5) {"),
  FRAG.indexOf("result = merged;")
);
check(
  "TexMerge block still overwrites result (premise of this test)",
  FRAG.includes("result = merged;")
);
check(
  "merge BASE slot picks waterCellUv when its layer is water",
  /vec3 merged = texture\(uAtlas, atlasUvFor\(clamp\(baseLayer, 0, 32\),\s*\n\s*isWaterCode\(baseLayer\) \? waterCellUv : cellUv\)\)\.rgb;/.test(
    mergeBlock
  )
);
check(
  "merge OVERLAY slots pick waterCellUv when their layer is water",
  /vec3 overlayCol = texture\(uAtlas, atlasUvFor\(clamp\(layer, 0, 32\),\s*\n\s*isWaterCode\(layer\) \? waterCellUv : cellUv\)\)\.rgb;/.test(
    mergeBlock
  )
);
check(
  "the alpha MASK still samples the UNSCROLLED cellUv",
  /maskUvFor\(cellUv, rot\)/.test(mergeBlock),
  "a drifting mask would smear the cell's authored coverage shape"
);
check(
  "no merge-slot atlas sample is left on a bare cellUv",
  !/texture\(uAtlas, atlasUvFor\(clamp\((?:baseLayer|layer), 0, 32\), cellUv\)\)/.test(
    mergeBlock
  )
);

console.log("\nTest 3: the scrolled UV is derived AFTER the POM march");
// POM offsets cellUv before every sampler. Deriving waterCellUv before POM
// left the water tile off-registration against albedo / nra / masks.
const iPom = FRAG.indexOf("if (uPomEnabled > 0.5");
const iScroll = FRAG.indexOf("vec2 waterCellUv = cellUv;");
check("POM block precedes the scroll derivation", iPom > 0 && iScroll > iPom,
  `pom@${iPom} scroll@${iScroll}`);
check(
  "POM is bypassed on any water-touching cell",
  /if \(uPomEnabled > 0\.5 && vViewDepth < uPomFadeEnd && !cellTouchesWater\)/.test(FRAG),
  "the BC7 arm derives real height for water layers; marching it makes flow swim"
);

console.log("\nTest 4: one shared water-code test drives every water site");
check("isWaterCode helper exists in the fragment stage and reads the SURFACE mask",
  /bool isWaterCode\(int c\) \{\s*\n\s*return c >= 0 && c < 32 && \(uWaterSurfaceCodeMask & \(1 << c\)\) != 0;/.test(FRAG));
check("the fragment stage does NOT read the swell mask",
  !/uWaterCodeMask/.test(FRAG.replace(/\/\/[^\n]*/g, "")),
  "swell set = retail SurfChar; surface set = the art. They are not the same question");
check("the vertex stage drives the swell from uWaterCodeMask",
  /\(uWaterCodeMask & bit\) != 0/.test(VERT));
check(
  "no hardcoded water-code RANGE survives in either stage",
  !/t\d\d >= 16 && t\d\d <= 23/.test(FRAG) && !/code >= 16 && code <= 23/.test(VERT)
);
// Corner classification + the bilinear water fraction are each computed once.
check("per-corner water flags computed once (wc00..wc11)",
  (FRAG.match(/bool wc00 = isWaterCode\(t00\);/g) || []).length === 1);
check("bilinear waterW computed once and reused",
  (FRAG.match(/float waterW = clamp\(/g) || []).length === 1);
for (const site of [
  ["scroll UV selection", /vec2 uv00 = wc00 \? waterCellUv : cellUv;/],
  ["tint", /result \*= mix\(vec3\(1\.0\), tint, waterW\);/],
  ["sheen weighting", /iblSpec \+= waterSpec \* waterW \* sheenFade;/],
  ["POM bypass", /!cellTouchesWater/],
]) {
  check(`${site[0]} reads the shared classification`, site[1].test(FRAG));
}

console.log("\nTest 5: water sheen runs in BOTH shading modes");
// It used to live inside `if (uPbrEnabled > 0.5 && !acGouraud)`. Retail
// Gouraud is default-ON and wins that test, so it never ran.
const iPbrBlock = FRAG.indexOf("if (uPbrEnabled > 0.5 && !acGouraud) {");
const iSheen = FRAG.indexOf("if (uWaterEnvEnabled > 0.5 && waterW > 0.0 && sheenFade > 0.001) {");
check("sheen block exists", iSheen > 0);
check("sheen sits OUTSIDE the pbr/!acGouraud block", iSheen > iPbrBlock,
  "and after it, so iblSpec from the generic material term is already resolved");
check(
  "sheen is not nested under uPbrEnabled",
  iSheen > FRAG.indexOf("// === 2026-07-31 (water-fix) — WATER SURFACE SHEEN")
);
check("sheen scrolls in world space off the shared clock",
  /vec2 wuv = vWorldPos\.xy \* 0\.30 \+ vec2\(uTime \* 0\.35, uTime \* 0\.22\);/.test(FRAG));
// The noise normal is point-sampled with no derivative-aware filter, so past
// a few tens of metres one pixel spans many wave periods and the specular
// aliases into long streaks across the whole sea (observed live, attributed by
// forcing uWaterEnvEnabled=0). The fade is the fix, not decoration.
check("sheen is distance-faded (anti-alias, live-observed streaks)",
  /float sheenFade = 1\.0 - smoothstep\(30\.0, 160\.0, vViewDepth\);/.test(FRAG));
check("the wave normal flattens with distance",
  /\(wh0 - whx\) \* 1\.4 \* sheenFade/.test(FRAG) && /\(wh0 - why\) \* 1\.4 \* sheenFade/.test(FRAG));
check("the env reflection blurs up the mip chain with distance",
  /textureLod\(uEnvCube, reflW, mix\(4\.0, 0\.6, sheenFade\)\)/.test(FRAG));
check("sheen adds no light and clones no per-instance program key (VFX invariant)",
  !/customProgramCacheKey/.test(SRC) && !/new THREE\.\w*Light\(/.test(SRC));

console.log("\nTest 6: the swell is LOD-crack-free (lattice lock), numerically");
// JS mirror of TERRAIN_VERTEX_GLSL's waterSwellAt / waterSwellLattice.
const swellAt = (t, x, y) =>
  Math.sin(t * 0.5 + x * 0.045) * 0.15 + Math.sin(t * 0.7 + y * 0.062) * 0.1;
const swellLattice = (t, x, y) => {
  const cx = Math.floor(x / 24) * 24;
  const cy = Math.floor(y / 24) * 24;
  const fx = (x - cx) / 24;
  const fy = (y - cy) / 24;
  const s00 = swellAt(t, cx, cy);
  const s10 = swellAt(t, cx + 24, cy);
  const s01 = swellAt(t, cx, cy + 24);
  const s11 = swellAt(t, cx + 24, cy + 24);
  return (
    (s00 * (1 - fx) + s10 * fx) * (1 - fy) + (s01 * (1 - fx) + s11 * fx) * fy
  );
};
check("GLSL and this JS mirror share the same constants",
  /sin\(uTime \* 0\.5 \+ wxy\.x \* 0\.045\) \* 0\.15/.test(VERT) &&
  /sin\(uTime \* 0\.7 \+ wxy\.y \* 0\.062\) \* 0\.10/.test(VERT));
check("swell is evaluated on the 24 m control lattice",
  /vec2 c0 = floor\(wxy \/ 24\.0\) \* 24\.0;/.test(VERT));

// THE crack test. A coarse (factor-1) LB has vertices only every 24 m along
// the shared seam; a fine (factor-8) neighbour has one every 3 m. The coarse
// side renders the straight chord between its two lattice vertices. If the
// fine side's intermediate vertices do not land exactly on that chord, the
// surface tears. Lattice-locked bilinear restricted to an axis-aligned edge
// is linear, so the error must be 0 (to float noise), for every t.
let maxLatticeCrack = 0;
let maxRawCrack = 0;
const rawAt = (t, x, y) =>
  Math.sin(t * 0.5 + x * 0.1) * 0.15 + Math.sin(t * 0.7 + y * 0.13) * 0.1; // the OLD wave
for (const t of [0, 1.7, 13.25, 60, 601.5]) {
  // Seam at y = 33408 (LB row 174 * 192), x running along one 24 m cell edge.
  for (let cell = 0; cell < 8; cell++) {
    const x0 = 33408 + cell * 24;
    const y = 33600;
    for (let k = 1; k < 8; k++) {
      const x = x0 + (k * 24) / 8;
      const f = k / 8;
      const chordL = swellLattice(t, x0, y) * (1 - f) + swellLattice(t, x0 + 24, y) * f;
      maxLatticeCrack = Math.max(maxLatticeCrack, Math.abs(swellLattice(t, x, y) - chordL));
      const chordR = rawAt(t, x0, y) * (1 - f) + rawAt(t, x0 + 24, y) * f;
      maxRawCrack = Math.max(maxRawCrack, Math.abs(rawAt(t, x, y) - chordR));
    }
  }
}
check("lattice swell: fine vertices land ON the coarse chord (crack ~ 0)",
  maxLatticeCrack < 1e-9, `maxGap=${maxLatticeCrack.toExponential(2)} m`);
check("the OLD raw per-vertex sine really did crack (regression premise)",
  maxRawCrack > 0.05, `maxGap=${maxRawCrack.toFixed(3)} m`);

// Phase continuity across an LB seam: 192 is a multiple of 24, so the LB
// boundary is always a lattice line and both neighbours agree exactly.
check("LB seam (192 m) is a lattice line",
  192 % 24 === 0 && Math.abs(swellLattice(3.5, 33408, 33600) - swellAt(3.5, 33408, 33600)) < 1e-12);
// Amplitude stays inside the 0.4 m plan cap.
let maxAmp = 0;
for (let t = 0; t < 40; t += 0.05)
  for (let x = 0; x < 400; x += 17)
    maxAmp = Math.max(maxAmp, Math.abs(swellLattice(t, x, x * 0.7)));
check("swell envelope stays under the 0.4 m plan cap", maxAmp <= 0.4,
  `max=${maxAmp.toFixed(3)} m`);

console.log("\nTest 7: the swell gate no longer depends on subdivision level");
check("resolveTerrainRingOpts drives displacementEnabled from ?waterWave",
  /const displacementEnabled = readWaterWaveFlag\(\);/.test(SRC));
check("no subdivLevel >= 2 gate survives",
  !/displacementEnabled = subdivLevel >= 2/.test(SRC));
check("readWaterWaveFlag defaults ON with an off/0/false escape",
  /function readWaterWaveFlag\(\)[\s\S]{0,400}?lv === "off" \|\| lv === "0" \|\| lv === "false"/.test(SRC));
// Both readers must default ON outside a browser (the Node harness path).
check("readWaterWaveFlag returns true with no window (Node)",
  /if \(typeof window === "undefined" \|\| !window\.location\) return true;[\s\S]{0,200}?get\("waterWave"\)/.test(SRC));

console.log("\nTest 8: fresh materials are phase-locked (rebake / LRU unpark)");
check("uTime is seeded from the shared clock, not 0.0",
  /uTime: \{ value: sharedTerrainTimeSec\(scene3d\) \}/.test(SRC));
check("sharedTerrainTimeSec prefers the frameTime snapshot",
  sharedTerrainTimeSec({ frameTime: { tsSec: 1234.5 } }) === 1234.5);
check("sharedTerrainTimeSec falls back to a live clock",
  sharedTerrainTimeSec(null) > 0);
check("sharedTerrainTimeSec ignores a non-finite snapshot",
  sharedTerrainTimeSec({ frameTime: { tsSec: NaN } }) > 0);

console.log("\nTest 9: the two water masks");
const mask = computeCodeBitmask(PHASE_2_2_WATER_CODES);
const smask = computeCodeBitmask(WATER_SURFACE_CODES);
check("default SWELL set is retail's SurfChar 16..20",
  mask === ((1 << 16) | (1 << 17) | (1 << 18) | (1 << 19) | (1 << 20)),
  "0x" + (mask >>> 0).toString(16));
check("default SURFACE set adds 22 FauxWaterRunning",
  smask === (mask | (1 << 22)), "0x" + (smask >>> 0).toString(16));
check("the surface set is a strict SUPERSET of the swell set",
  (smask & mask) === mask && smask !== mask);
check("22 flows but does not bob",
  (smask & (1 << 22)) !== 0 && (mask & (1 << 22)) === 0);
check("23 SeaSlime is in neither set by default",
  (smask & (1 << 23)) === 0 && (mask & (1 << 23)) === 0);
check("both masks are wired through opts + the material",
  /waterSurfaceCodeMask,/.test(SRC) &&
  /uWaterSurfaceCodeMask: \{/.test(SRC) &&
  /Number\.isInteger\(opts\.waterSurfaceCodeMask\)/.test(SRC),
  "with a fallback to the swell mask so an older opts object degrades safely");
check("road layer 32 is outside the mask domain", (mask & 0xffff) === 0 && mask >= 0);
for (const c of [16, 17, 18, 19, 20]) {
  check(`code ${c} is water`, (mask & (1 << c)) !== 0);
}
for (const c of [0, 11, 21, 24, 31]) {
  check(`code ${c} is not water`, (mask & (1 << c)) === 0);
}

console.log("\nTest 10: the batched-mesh GLSL anchors still match exactly once");
// terrain_batch.js derives its cross-LB variant by anchored string
// replacement against these EXACT lines; a drifted anchor silently disables
// batching. Water edits sit right next to several of them.
for (const [label, anchor] of [
  ["vertex decls", "in float vertexHue;"],
  ["vertex worldXy", "  vec2 worldXy = uLbOriginXy + position.xy;"],
  ["vertex placement",
    "  vWorldPos = (modelMatrix * vec4(displacedPos, 1.0)).xyz;\n  vec4 mvPos = modelViewMatrix * vec4(displacedPos, 1.0);"],
  ["frag uVertexTypes decl", "uniform sampler2D uVertexTypes;"],
  ["frag vertexTypeAt", "  return int(texelFetch(uVertexTypes, ivec2(iu, iv), 0).r * 255.0 + 0.5);"],
  ["frag vertexRoadAt", "  return texelFetch(uVertexTypes, ivec2(iu, iv), 0).g > 0.125 ? 1.0 : 0.0;"],
  ["frag uMergeData decl", "uniform highp sampler2D uMergeData;"],
  ["frag merge base fetch", "vec4 baseTexel = texelFetch(uMergeData, ivec2(colBase, iv), 0);"],
  ["frag merge slot fetch", "vec4 t = texelFetch(uMergeData, ivec2(colBase + s, iv), 0);"],
  ["frag merge validity", "  if (uTexMergeEnabled > 0.5) {\n    int colBase = iu * 6;"],
  ["frag road gate",
    "  if (uRoadEnabled > 0.5 && !(uTexMergeEnabled > 0.5 && uRoadSlotsEnabled > 0.5)) {"],
]) {
  check(`anchor "${label}" matches once`, SRC.split(anchor).length - 1 === 1);
}

console.log("\nTest 11: no backtick inside either GLSL literal");
// A stray backtick terminates the template literal — esbuild + Firefox both
// reject it and it has bitten this file repeatedly (it bit this change too).
check("vertex GLSL is backtick-free", !VERT.includes("`"));
check("fragment GLSL is backtick-free", !FRAG.includes("`"));

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
