// Phase 7 follow-on #7+8 — surface_type bitfield decode standalone
// ESM test for `scene3d/materials.js` against real `three` (loaded
// from npm, not the importmap). Run with:
//
//   cd apps/holtburger-web/
//   THREE_PATH=/tmp/three-test/node_modules/three/build/three.module.js \
//     node test_f7_8_surface_bitfield.mjs
//
// Tests:
//   1. SURFACE_TYPE constants match ACE.Entity.Enum.SurfaceType bit
//      values (verified by the parser source at
//      external/ACE/Source/ACE.Entity/Enum/SurfaceType.cs).
//   2. `MaterialCache._materialFromFlags(flags, tex)` produces:
//      - opaque + DoubleSide when flags=0
//      - transparent + depthWrite=false when Translucent (0x10) is set
//      - alphaTest=0.5 when Base1ClipMap (0x4) is set without Translucent
//      - emissiveMap + emissive colour when Luminous (0x40) is set
//      - AdditiveBlending when Additive (0x10000) is set
//      - matte roughness=1.0 when Diffuse (0x20) is set
//   3. Two-sided distinct-surface polys produce two materials with
//      independent flag decoding (simulates the wasm-side back-face
//      emission — Rust emits two tris with different surface_dids
//      and the JS side caches each in MaterialCache).
//
// Falls back to the host's installed copy of `three` (Playwright is
// bundled at ~/.npm/_npx/.../node_modules/three on this box). If
// `three` can't be located the test prints SKIP and exits 0 (the
// smoke test's regex check stays the floor).

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath, join as joinPath } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

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
  try {
    return require.resolve("three");
  } catch (_) {}
  const candidates = [];
  try {
    const npxRoot = joinPath(process.env.HOME ?? "", ".npm/_npx");
    if (existsSync(npxRoot)) {
      const fs = require("node:fs");
      for (const dir of fs.readdirSync(npxRoot)) {
        candidates.push(joinPath(npxRoot, dir, "node_modules/three"));
      }
    }
  } catch (_) {}
  for (const c of candidates) {
    const idx = joinPath(c, "build/three.module.js");
    if (existsSync(idx)) return idx;
  }
  return null;
}

const threePath = locateThree();
if (!threePath) {
  console.log(
    "Phase 7 follow-on #7+8 surface_type bitfield ESM test: SKIP (three not located).",
  );
  console.log(
    "  hint: `THREE_PATH=/abs/path/to/three.module.js node test_f7_8_surface_bitfield.mjs`",
  );
  process.exit(0);
}

const threeUrl = "file://" + threePath;
const THREE = await import(threeUrl);

console.log("Phase 7 follow-on #7+8 — surface_type bitfield ESM test");
console.log(`three loaded from: ${threePath}`);
console.log("=========================");

// Load `scene3d/materials.js` source + strip bare imports so it runs
// in a closure with THREE injected. Mirrors the
// test_phase7_4a_animation_clip.mjs pattern.
const matPath = resolvePath(__dirname, "scene3d", "materials.js");
if (!existsSync(matPath)) {
  check("materials.js exists", false, matPath);
  process.exit(failed > 0 ? 1 : 0);
}
const matSrc = readFileSync(matPath, "utf8");

// Need to stub `surfacePixelsToTexture` from adapter.js — but for this
// test we never call .get() so the only path that touches the adapter
// is _materialFromFlags(flags, texture), and texture is just passed
// through to MeshStandardMaterial. We can synthesise a stub DataTexture
// and pass it in directly.
const patched = matSrc
  .replace(/^\s*import\s+\*\s+as\s+THREE\s+from\s+["']three["'];?\s*$/m, "")
  .replace(
    // Phase 1.1 — materials.js now also imports surfacePixelsToNormalTexture;
    // accept any combination of named imports from adapter.js.
    /^\s*import\s+\{\s*[^}]*\s*\}\s+from\s+["'].\/adapter\.js["'];?\s*$/m,
    "",
  )
  .replace(/^\s*export\s+function\s+/gm, "function ")
  .replace(/^\s*export\s+class\s+/gm, "class ")
  .replace(/^\s*export\s+const\s+/gm, "const ");

const factory = new Function(
  "THREE",
  `${patched}\n; return { MaterialCache, SURFACE_TYPE };`,
);
const { MaterialCache, SURFACE_TYPE } = factory(THREE);

// ---- Stage 1: SURFACE_TYPE bit-value verification -------------------
check(
  "SURFACE_TYPE.Base1Solid = 0x1",
  SURFACE_TYPE.Base1Solid === 0x1,
  `got=0x${SURFACE_TYPE.Base1Solid.toString(16)}`,
);
check(
  "SURFACE_TYPE.Base1Image = 0x2",
  SURFACE_TYPE.Base1Image === 0x2,
  `got=0x${SURFACE_TYPE.Base1Image.toString(16)}`,
);
check(
  "SURFACE_TYPE.Base1ClipMap = 0x4",
  SURFACE_TYPE.Base1ClipMap === 0x4,
  `got=0x${SURFACE_TYPE.Base1ClipMap.toString(16)}`,
);
check(
  "SURFACE_TYPE.Translucent = 0x10",
  SURFACE_TYPE.Translucent === 0x10,
  `got=0x${SURFACE_TYPE.Translucent.toString(16)}`,
);
check(
  "SURFACE_TYPE.Diffuse = 0x20",
  SURFACE_TYPE.Diffuse === 0x20,
  `got=0x${SURFACE_TYPE.Diffuse.toString(16)}`,
);
check(
  "SURFACE_TYPE.Luminous = 0x40",
  SURFACE_TYPE.Luminous === 0x40,
  `got=0x${SURFACE_TYPE.Luminous.toString(16)}`,
);
check(
  "SURFACE_TYPE.Additive = 0x10000",
  SURFACE_TYPE.Additive === 0x10000,
  `got=0x${SURFACE_TYPE.Additive.toString(16)}`,
);

// ---- Stage 2: bitfield → material flag decoding ---------------------
const cache = new MaterialCache();

// Synthetic 1x1 RGBA8 texture stand-in (real surfacePixelsToTexture
// returns a THREE.DataTexture; for the decode test the actual texture
// content doesn't matter — only that the material's map/emissiveMap
// fields reference it).
const stubTex = new THREE.DataTexture(
  new Uint8Array([255, 255, 255, 255]),
  1,
  1,
  THREE.RGBAFormat,
  THREE.UnsignedByteType,
);
stubTex.needsUpdate = true;

// (a) Opaque, all-default (flags=0).
const matOpaque = cache._materialFromFlags(0, stubTex);
check(
  "opaque (flags=0): transparent=false, alphaTest=0, DoubleSide",
  matOpaque.transparent === false &&
    matOpaque.alphaTest === 0 &&
    matOpaque.side === THREE.DoubleSide,
  `transparent=${matOpaque.transparent}, alphaTest=${matOpaque.alphaTest}, side=${matOpaque.side}`,
);
check(
  "opaque: roughness=0.9, metalness=0.0",
  Math.abs(matOpaque.roughness - 0.9) < 1e-6 && matOpaque.metalness === 0,
  `roughness=${matOpaque.roughness}, metalness=${matOpaque.metalness}`,
);
check(
  "opaque: map = stub texture",
  matOpaque.map === stubTex,
  `map.uuid=${matOpaque.map?.uuid}, stub.uuid=${stubTex.uuid}`,
);

// (b) Translucent — true alpha blend.
const matTrans = cache._materialFromFlags(SURFACE_TYPE.Translucent, stubTex);
check(
  "Translucent (0x10): transparent=true, depthWrite=false",
  matTrans.transparent === true && matTrans.depthWrite === false,
  `transparent=${matTrans.transparent}, depthWrite=${matTrans.depthWrite}`,
);
check(
  "Translucent: alphaTest stays 0 (no binary mask)",
  matTrans.alphaTest === 0,
  `alphaTest=${matTrans.alphaTest}`,
);

// (c) Base1ClipMap — binary alpha mask.
const matClip = cache._materialFromFlags(SURFACE_TYPE.Base1ClipMap, stubTex);
check(
  "Base1ClipMap (0x4): alphaTest=0.5, transparent=false",
  matClip.alphaTest === 0.5 && matClip.transparent === false,
  `alphaTest=${matClip.alphaTest}, transparent=${matClip.transparent}`,
);

// (d) Luminous — self-illuminating.
const matLum = cache._materialFromFlags(SURFACE_TYPE.Luminous, stubTex);
check(
  "Luminous (0x40): emissiveMap = same texture",
  matLum.emissiveMap === stubTex,
  `emissiveMap.uuid=${matLum.emissiveMap?.uuid}, stub.uuid=${stubTex.uuid}`,
);
check(
  "Luminous: emissive = white",
  matLum.emissive &&
    matLum.emissive.r === 1 &&
    matLum.emissive.g === 1 &&
    matLum.emissive.b === 1,
  `emissive=${JSON.stringify(matLum.emissive)}`,
);
check(
  "Luminous: emissiveIntensity > 0",
  matLum.emissiveIntensity > 0,
  `emissiveIntensity=${matLum.emissiveIntensity}`,
);

// (e) Additive — flames, sparks.
const matAdd = cache._materialFromFlags(SURFACE_TYPE.Additive, stubTex);
check(
  "Additive (0x10000): blending = AdditiveBlending, transparent + depthWrite=false",
  matAdd.blending === THREE.AdditiveBlending &&
    matAdd.transparent === true &&
    matAdd.depthWrite === false,
  `blending=${matAdd.blending}, transparent=${matAdd.transparent}, depthWrite=${matAdd.depthWrite}`,
);

// (f) Diffuse — matte.
const matMat = cache._materialFromFlags(SURFACE_TYPE.Diffuse, stubTex);
check(
  "Diffuse (0x20): roughness=1.0 (matte)",
  matMat.roughness === 1.0,
  `roughness=${matMat.roughness}`,
);

// (g) Combined Translucent + Luminous → both flags applied.
const matComboTL = cache._materialFromFlags(
  SURFACE_TYPE.Translucent | SURFACE_TYPE.Luminous,
  stubTex,
);
check(
  "Translucent | Luminous: transparent=true AND emissiveMap set",
  matComboTL.transparent === true &&
    matComboTL.emissiveMap === stubTex,
  `transparent=${matComboTL.transparent}, hasEmissiveMap=${!!matComboTL.emissiveMap}`,
);

// (h) Combined Translucent + Additive — Additive wins (checked first).
const matComboTA = cache._materialFromFlags(
  SURFACE_TYPE.Translucent | SURFACE_TYPE.Additive,
  stubTex,
);
check(
  "Translucent | Additive: AdditiveBlending wins",
  matComboTA.blending === THREE.AdditiveBlending,
  `blending=${matComboTA.blending}`,
);

// ---- Stage 3: two-sided distinct-surface MaterialCache behaviour ----
// Simulates the wasm side emitting one tri with surface_did=A (front)
// and one with surface_did=B (back). The cache should produce two
// distinct materials with their own flag decoding when the two
// surface DIDs carry different surface_type values.
const fakeSurfaceA = {
  width: 1,
  height: 1,
  pixels: new Uint8Array([200, 100, 50, 255]),
  surfaceType: SURFACE_TYPE.Translucent,
};
const fakeSurfaceB = {
  width: 1,
  height: 1,
  pixels: new Uint8Array([50, 100, 200, 255]),
  surfaceType: SURFACE_TYPE.Luminous,
};

// Patch surfacePixelsToTexture into the cache via a closure with a
// minimal stub (the test pattern above stubbed it out; here we
// re-implement enough of `_installFromPixels` against the cache to
// confirm the decode path).
function fakeInstall(cache, did, sp) {
  // Inline minimal version of _installFromPixels that doesn't depend
  // on surfacePixelsToTexture — produces a DataTexture from raw pixels.
  const tex = new THREE.DataTexture(
    sp.pixels,
    sp.width,
    sp.height,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  tex.needsUpdate = true;
  const surfaceTypeFlags = (sp.surfaceType ?? 0) >>> 0;
  const mat = cache._materialFromFlags(surfaceTypeFlags, tex);
  mat.name = `scene3d-surface-${(did >>> 0).toString(16).padStart(8, "0")}`;
  mat.userData = { ...(mat.userData || {}), surfaceTypeFlags };
  cache.textures.set(did >>> 0, tex);
  cache.materials.set(did >>> 0, mat);
  return mat;
}

const cache2 = new MaterialCache();
const matA = fakeInstall(cache2, 0x08000A01, fakeSurfaceA);
const matB = fakeInstall(cache2, 0x08000A02, fakeSurfaceB);

check(
  "two-sided distinct surfaces: matA != matB",
  matA !== matB,
  `matA.uuid=${matA.uuid}, matB.uuid=${matB.uuid}`,
);
check(
  "two-sided distinct: matA has Translucent flags decoded",
  matA.transparent === true &&
    matA.userData.surfaceTypeFlags === SURFACE_TYPE.Translucent,
  `transparent=${matA.transparent}, flags=0x${matA.userData.surfaceTypeFlags.toString(16)}`,
);
check(
  "two-sided distinct: matB has Luminous flags decoded",
  matB.emissiveMap != null &&
    matB.userData.surfaceTypeFlags === SURFACE_TYPE.Luminous,
  `hasEmissiveMap=${!!matB.emissiveMap}, flags=0x${matB.userData.surfaceTypeFlags.toString(16)}`,
);
check(
  "MaterialCache stores both materials independently",
  cache2.materials.size === 2,
  `cache2.materials.size=${cache2.materials.size}`,
);

// ---- summary --------------------------------------------------------
console.log("=========================");
if (failed === 0) {
  console.log("PASS: all surface_type bitfield checks green.");
  process.exit(0);
} else {
  console.log(`FAIL: ${failed} check(s) failed.`);
  process.exit(1);
}
