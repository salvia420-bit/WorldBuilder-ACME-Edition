// Phase 0.2 — DetailMaterial unit test.
//
// Verifies that `MaterialCache._materialFromFlags` correctly wires the
// detail-tile composite when the `Detail (0x20000)` surface_type bit is
// set AND a `detailTileCache` is provided to the cache constructor.
//
// Specifically asserts:
//   1. `pickDetailTileKey(category)` returns the expected key for each
//      Phase 1.4 SurfaceCategory enum value.
//   2. Without a detail tile cache, materials produced for Detail-flagged
//      surfaces are plain `MeshStandardMaterial` (no shader patch).
//   3. With a detail tile cache, Detail-flagged surfaces install an
//      `onBeforeCompile` callback that injects detail uniforms.
//   4. With a detail tile cache AND `forceDetail: true`, every textured
//      surface gets the patch even if the bit isn't set.
//   5. The injected fragment shader is syntactically well-formed —
//      uniforms declared, `vMapUv * uDetailScale` sample present, the
//      `mix(diffuseColor.rgb, _modulated, uDetailBlend)` composite
//      lands AFTER `#include <map_fragment>` and BEFORE any lighting
//      include (so PBR shading sees the modulated diffuse).
//   6. Detail tile picker fallback: an unknown category resolves to
//      "generic-rough", and a missing tile in the cache falls back to
//      "generic-rough" before giving up.
//
// Run (with the same three.js the existing tests use):
//
//   cd apps/holtburger-web/
//   THREE_PATH=/tmp/three-test/node_modules/three/build/three.module.js \
//     node test_visfid_p02_detail_material.mjs

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath, join as joinPath } from "node:path";
import { existsSync, readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

let failed = 0;
function check(name, ok, detail) {
  const status = ok ? "OK" : "FAIL";
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
}

// ---- locate `three` --------------------------------------------------
function locateThree() {
  if (process.env.THREE_PATH && existsSync(process.env.THREE_PATH)) {
    return process.env.THREE_PATH;
  }
  return null;
}

const threePath = locateThree();
if (!threePath) {
  console.log(
    "Phase 0.2 DetailMaterial ESM test: SKIP (three not located).",
  );
  console.log(
    "  hint: `THREE_PATH=/abs/path/to/three.module.js node test_visfid_p02_detail_material.mjs`",
  );
  process.exit(0);
}

const threeUrl = "file://" + threePath;
const THREE = await import(threeUrl);

console.log("Phase 0.2 — DetailMaterial ESM test");
console.log(`three loaded from: ${threePath}`);
console.log("=========================");

// Load `scene3d/materials.js` source + strip bare imports so it runs
// in a closure with THREE injected. Mirrors the test_f7_8 pattern.
const matPath = resolvePath(__dirname, "scene3d", "materials.js");
if (!existsSync(matPath)) {
  check("materials.js exists", false, matPath);
  process.exit(failed > 0 ? 1 : 0);
}
const matSrc = readFileSync(matPath, "utf8");
const patched = matSrc
  .replace(/^\s*import\s+\*\s+as\s+THREE\s+from\s+["']three["'];?\s*$/m, "")
  .replace(
    /^\s*import\s+\{\s*surfacePixelsToTexture\s*\}\s+from\s+["'].\/adapter\.js["'];?\s*$/m,
    "",
  )
  .replace(/^\s*export\s+function\s+/gm, "function ")
  .replace(/^\s*export\s+class\s+/gm, "class ")
  .replace(/^\s*export\s+const\s+/gm, "const ");

const factory = new Function(
  "THREE",
  `${patched}\n; return { MaterialCache, SURFACE_TYPE, SURFACE_CATEGORY, pickDetailTileKey };`,
);
const { MaterialCache, SURFACE_TYPE, SURFACE_CATEGORY, pickDetailTileKey } =
  factory(THREE);

// Synthetic stub texture used as the diffuse map.
const stubDiffuse = new THREE.DataTexture(
  new Uint8Array([255, 255, 255, 255]),
  1,
  1,
  THREE.RGBAFormat,
  THREE.UnsignedByteType,
);
stubDiffuse.needsUpdate = true;

// Synthetic stub detail tile cache. Real cache is built by
// `loadDetailTileCache` from adapter.js (loads PNG via THREE.TextureLoader);
// for this Node test we just pre-populate a Map with DataTextures named
// after each tile key.
function makeStubTile(name) {
  const t = new THREE.DataTexture(
    new Uint8Array([127, 127, 127, 255]),
    1,
    1,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  t.name = `scene3d-detail-${name}`;
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.needsUpdate = true;
  return t;
}
const detailTileCache = new Map([
  ["generic-rough", makeStubTile("generic-rough")],
  ["stone-grain", makeStubTile("stone-grain")],
  ["wood-grain", makeStubTile("wood-grain")],
  ["fabric-weave", makeStubTile("fabric-weave")],
  ["sand-grain", makeStubTile("sand-grain")],
]);

// ---- Stage 1: pickDetailTileKey for every Phase 1.4 category --------
check(
  "pickDetailTileKey(Stone) = stone-grain",
  pickDetailTileKey(SURFACE_CATEGORY.Stone) === "stone-grain",
  `got=${pickDetailTileKey(SURFACE_CATEGORY.Stone)}`,
);
check(
  "pickDetailTileKey(Brick) = stone-grain (Phase 1.4 lumps brick into stone)",
  pickDetailTileKey(SURFACE_CATEGORY.Brick) === "stone-grain",
  `got=${pickDetailTileKey(SURFACE_CATEGORY.Brick)}`,
);
check(
  "pickDetailTileKey(Tile) = stone-grain",
  pickDetailTileKey(SURFACE_CATEGORY.Tile) === "stone-grain",
  `got=${pickDetailTileKey(SURFACE_CATEGORY.Tile)}`,
);
check(
  "pickDetailTileKey(Metal) = stone-grain (hard granular)",
  pickDetailTileKey(SURFACE_CATEGORY.Metal) === "stone-grain",
  `got=${pickDetailTileKey(SURFACE_CATEGORY.Metal)}`,
);
check(
  "pickDetailTileKey(Lava) = stone-grain",
  pickDetailTileKey(SURFACE_CATEGORY.Lava) === "stone-grain",
  `got=${pickDetailTileKey(SURFACE_CATEGORY.Lava)}`,
);
check(
  "pickDetailTileKey(Wood) = wood-grain",
  pickDetailTileKey(SURFACE_CATEGORY.Wood) === "wood-grain",
  `got=${pickDetailTileKey(SURFACE_CATEGORY.Wood)}`,
);
check(
  "pickDetailTileKey(Sand) = sand-grain",
  pickDetailTileKey(SURFACE_CATEGORY.Sand) === "sand-grain",
  `got=${pickDetailTileKey(SURFACE_CATEGORY.Sand)}`,
);
check(
  "pickDetailTileKey(Snow) = sand-grain",
  pickDetailTileKey(SURFACE_CATEGORY.Snow) === "sand-grain",
  `got=${pickDetailTileKey(SURFACE_CATEGORY.Snow)}`,
);
check(
  "pickDetailTileKey(Foliage) = fabric-weave",
  pickDetailTileKey(SURFACE_CATEGORY.Foliage) === "fabric-weave",
  `got=${pickDetailTileKey(SURFACE_CATEGORY.Foliage)}`,
);
check(
  "pickDetailTileKey(Cloth) = fabric-weave",
  pickDetailTileKey(SURFACE_CATEGORY.Cloth) === "fabric-weave",
  `got=${pickDetailTileKey(SURFACE_CATEGORY.Cloth)}`,
);
check(
  "pickDetailTileKey(Water) = generic-rough (fall-through)",
  pickDetailTileKey(SURFACE_CATEGORY.Water) === "generic-rough",
  `got=${pickDetailTileKey(SURFACE_CATEGORY.Water)}`,
);
check(
  "pickDetailTileKey(Dirt) = generic-rough",
  pickDetailTileKey(SURFACE_CATEGORY.Dirt) === "generic-rough",
  `got=${pickDetailTileKey(SURFACE_CATEGORY.Dirt)}`,
);
check(
  "pickDetailTileKey(Generic) = generic-rough",
  pickDetailTileKey(SURFACE_CATEGORY.Generic) === "generic-rough",
  `got=${pickDetailTileKey(SURFACE_CATEGORY.Generic)}`,
);
check(
  "pickDetailTileKey(undefined) = generic-rough (no category at all)",
  pickDetailTileKey(undefined) === "generic-rough",
  `got=${pickDetailTileKey(undefined)}`,
);

// ---- Stage 2: no cache → no shader patch ----------------------------
const cacheNoTiles = new MaterialCache();
const matNoTiles = cacheNoTiles._materialFromFlags(
  SURFACE_TYPE.Detail | SURFACE_TYPE.Base1Image,
  stubDiffuse,
  SURFACE_CATEGORY.Stone,
);
check(
  "no detail cache: material has no onBeforeCompile patch",
  typeof matNoTiles.onBeforeCompile !== "function" ||
    matNoTiles.userData?.detailEnabled !== true,
  `detailEnabled=${matNoTiles.userData?.detailEnabled}`,
);

// ---- Stage 3: cache + Detail flag → patch wired ---------------------
const cacheWithTiles = new MaterialCache({ detailTileCache });
const matStone = cacheWithTiles._materialFromFlags(
  SURFACE_TYPE.Detail | SURFACE_TYPE.Base1Image,
  stubDiffuse,
  SURFACE_CATEGORY.Stone,
);
check(
  "with cache + Detail bit: onBeforeCompile installed",
  typeof matStone.onBeforeCompile === "function",
  `onBeforeCompile typeof=${typeof matStone.onBeforeCompile}`,
);
check(
  "with cache + Detail bit: userData.detailEnabled=true",
  matStone.userData?.detailEnabled === true,
  `detailEnabled=${matStone.userData?.detailEnabled}`,
);
check(
  "with cache + Detail bit + Stone category: detailKey=stone-grain",
  matStone.userData?.detailKey === "stone-grain",
  `detailKey=${matStone.userData?.detailKey}`,
);
check(
  "detail uniforms: scale=8.0, blend=0.6 (defaults for stone)",
  matStone.userData?.detailUniforms?.scale === 8.0 &&
    matStone.userData?.detailUniforms?.blend === 0.6,
  JSON.stringify(matStone.userData?.detailUniforms),
);

// Wood gets the tighter scale.
const matWood = cacheWithTiles._materialFromFlags(
  SURFACE_TYPE.Detail | SURFACE_TYPE.Base1Image,
  stubDiffuse,
  SURFACE_CATEGORY.Wood,
);
check(
  "Wood category: detail uniforms scale=4.0 (looser so stripes read)",
  matWood.userData?.detailUniforms?.scale === 4.0,
  `scale=${matWood.userData?.detailUniforms?.scale}`,
);
check(
  "Wood category: detailKey=wood-grain",
  matWood.userData?.detailKey === "wood-grain",
  `detailKey=${matWood.userData?.detailKey}`,
);

// Sand gets the tighter scale.
const matSand = cacheWithTiles._materialFromFlags(
  SURFACE_TYPE.Detail | SURFACE_TYPE.Base1Image,
  stubDiffuse,
  SURFACE_CATEGORY.Sand,
);
check(
  "Sand category: scale=12.0 (tighter so grain reads fine)",
  matSand.userData?.detailUniforms?.scale === 12.0,
  `scale=${matSand.userData?.detailUniforms?.scale}`,
);
check(
  "Sand category: detailKey=sand-grain",
  matSand.userData?.detailKey === "sand-grain",
  `detailKey=${matSand.userData?.detailKey}`,
);

// ---- Stage 4: no Detail bit, no force → no patch --------------------
const matNoFlag = cacheWithTiles._materialFromFlags(
  SURFACE_TYPE.Base1Image, // diffuse-only, no Detail bit
  stubDiffuse,
  SURFACE_CATEGORY.Stone,
);
check(
  "no Detail bit + no force: no shader patch",
  matNoFlag.userData?.detailEnabled !== true,
  `detailEnabled=${matNoFlag.userData?.detailEnabled}`,
);

// ---- Stage 5: forceDetail=true wires the patch regardless ----------
const cacheForce = new MaterialCache({ detailTileCache, forceDetail: true });
const matForced = cacheForce._materialFromFlags(
  SURFACE_TYPE.Base1Image, // diffuse-only, no Detail bit
  stubDiffuse,
  SURFACE_CATEGORY.Stone,
);
check(
  "forceDetail=true: patch wired even without Detail bit",
  matForced.userData?.detailEnabled === true,
  `detailEnabled=${matForced.userData?.detailEnabled}`,
);
check(
  "forceDetail=true: detailForced=true marks the override",
  matForced.userData?.detailForced === true,
  `detailForced=${matForced.userData?.detailForced}`,
);

// ---- Stage 6: invoke onBeforeCompile + inspect injected GLSL -------
// Three.js calls this with a `shader` object carrying { uniforms,
// fragmentShader, vertexShader }. We synthesise a minimal one carrying
// the `void main() {` and `#include <map_fragment>` markers the patch
// targets, then assert the patched output.
const stubShader = {
  uniforms: {},
  fragmentShader: [
    "varying vec2 vMapUv;",
    "void main() {",
    "  vec4 diffuseColor = vec4(1.0);",
    "  #include <map_fragment>",
    "  #include <lights_fragment_begin>",
    "  gl_FragColor = diffuseColor;",
    "}",
  ].join("\n"),
  vertexShader: "void main() {}",
};
matStone.onBeforeCompile(stubShader);
check(
  "shader patch: uDetailMap uniform installed",
  stubShader.uniforms.uDetailMap?.value === detailTileCache.get("stone-grain"),
  `uDetailMap.value.name=${stubShader.uniforms.uDetailMap?.value?.name}`,
);
check(
  "shader patch: uDetailScale uniform = 8.0",
  stubShader.uniforms.uDetailScale?.value === 8.0,
  `uDetailScale=${stubShader.uniforms.uDetailScale?.value}`,
);
check(
  "shader patch: uDetailBlend uniform = 0.6",
  stubShader.uniforms.uDetailBlend?.value === 0.6,
  `uDetailBlend=${stubShader.uniforms.uDetailBlend?.value}`,
);
check(
  "shader patch: declares uniform sampler2D uDetailMap",
  stubShader.fragmentShader.includes("uniform sampler2D uDetailMap;"),
  "missing declaration",
);
check(
  "shader patch: declares uniform float uDetailScale",
  stubShader.fragmentShader.includes("uniform float uDetailScale;"),
  "missing declaration",
);
check(
  "shader patch: samples texture2D(uDetailMap, vMapUv * uDetailScale)",
  /vMapUv\s*\*\s*uDetailScale/.test(stubShader.fragmentShader) &&
    /texture2D\(uDetailMap,\s*_dUv\)/.test(stubShader.fragmentShader),
  "tile-scale sample missing",
);
check(
  "shader patch: composites via mix(diffuseColor.rgb, _modulated, uDetailBlend)",
  /mix\(diffuseColor\.rgb,\s*_modulated,\s*uDetailBlend\)/.test(
    stubShader.fragmentShader,
  ),
  "mix() composite missing",
);
const fragIdxMap = stubShader.fragmentShader.indexOf("#include <map_fragment>");
const fragIdxLights = stubShader.fragmentShader.indexOf(
  "#include <lights_fragment_begin>",
);
const fragIdxMix = stubShader.fragmentShader.indexOf(
  "mix(diffuseColor.rgb, _modulated, uDetailBlend)",
);
check(
  "shader patch: composite lands AFTER map_fragment, BEFORE lights_fragment_begin",
  fragIdxMap >= 0 &&
    fragIdxMix > fragIdxMap &&
    (fragIdxLights < 0 || fragIdxMix < fragIdxLights),
  `map=${fragIdxMap}, mix=${fragIdxMix}, lights=${fragIdxLights}`,
);

// ---- Stage 7: diffuse map preserved (NOT replaced) -----------------
check(
  "anti-pattern check: material.map === stubDiffuse (diffuse not replaced)",
  matStone.map === stubDiffuse,
  `map.uuid=${matStone.map?.uuid}, stub.uuid=${stubDiffuse.uuid}`,
);
check(
  "anti-pattern check: material is still MeshStandardMaterial (PBR pipeline intact)",
  matStone instanceof THREE.MeshStandardMaterial,
  `ctor=${matStone.constructor?.name}`,
);

// ---- Stage 8: missing tile falls back to generic-rough -------------
// Pre-populate a cache where 'sand-grain' is missing — picker should
// fall through to 'generic-rough' rather than fail.
const sparseCache = new Map([
  ["generic-rough", makeStubTile("generic-rough")],
  ["stone-grain", makeStubTile("stone-grain")],
]);
const cacheSparse = new MaterialCache({ detailTileCache: sparseCache });
const matSandSparse = cacheSparse._materialFromFlags(
  SURFACE_TYPE.Detail | SURFACE_TYPE.Base1Image,
  stubDiffuse,
  SURFACE_CATEGORY.Sand,
);
check(
  "missing sand-grain tile: falls back to generic-rough sampler in shader",
  matSandSparse.userData?.detailEnabled === true &&
    matSandSparse.userData?.detailTextureName === "scene3d-detail-generic-rough",
  `detailTextureName=${matSandSparse.userData?.detailTextureName}`,
);

// ---- summary --------------------------------------------------------
console.log("=========================");
if (failed === 0) {
  console.log("PASS: all Phase 0.2 DetailMaterial checks green.");
  process.exit(0);
} else {
  console.log(`FAIL: ${failed} check(s) failed.`);
  process.exit(1);
}
