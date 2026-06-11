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
//      - alpha blend (transparent, depthWrite off) when Alpha (0x100) set
//      - AdditiveBlending when Additive (0x10000) is set
//      - flat grayscale emissive when the luminosity FLOAT > 0 (NOT the
//        0x40 bit, which retail never sets — census 2026-05-28: 0/6152)
//      - albedo color scaled by the diffuse FLOAT (NOT the 0x20 bit)
//   3. Two-sided distinct-surface polys produce two materials with
//      independent flag decoding (simulates the wasm-side back-face
//      emission — Rust emits two tris with different surface_dids
//      and the JS side caches each in MaterialCache).
//   4. A10-M1 — `?surfaceUnified=on` routes the cache path through the
//      single `applySurfaceRenderState`; 70/70 flag×float combos prove the
//      cache path == the unified fn byte-identical.
//   5. A10-M2 — `?surfaceUnified=on` threads the render-state flags through
//      the entity-owned (F.41 recolour) path `_buildEntityOwnedFromPixels`:
//      default-off stays plain opaque (rollback); ON, an Additive/Translucent/
//      luminous recolour decodes correctly and matches the unified decode for
//      the same flags+floats; `surfaceType===0` recolours stay a no-op.
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
  `${patched}\n; return { MaterialCache, SURFACE_TYPE, applySurfaceRenderState, readSurfaceUnifiedFlag };`,
);
const { MaterialCache, SURFACE_TYPE, applySurfaceRenderState, readSurfaceUnifiedFlag } =
  factory(THREE);

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

// (d) Self-illumination — driven by the luminosity FLOAT, not the 0x40
// bit. Retail sets the bit on 0/6152 surfaces but 762 carry luminosity>0
// (census 2026-05-28); acclient.c SetSurface @454688 reads the float.
const fl = (flags, floats) =>
  cache._materialFromFlags(flags, stubTex, undefined, undefined, undefined, undefined, floats);
// The 0x40 bit ALONE (no float) must NOT self-illuminate any more.
const matLumBitOnly = fl(SURFACE_TYPE.Luminous, undefined);
check(
  "Luminous bit alone (no float): emissive stays black (inert)",
  matLumBitOnly.emissive &&
    matLumBitOnly.emissive.r === 0 &&
    matLumBitOnly.emissive.g === 0 &&
    matLumBitOnly.emissive.b === 0,
  `emissive=${JSON.stringify(matLumBitOnly.emissive)}`,
);
// luminosity float > 0 drives flat grayscale emissive, NO emissiveMap.
const matLum = fl(0, { luminosity: 0.5 });
check(
  "luminosity float>0: emissive=white, intensity=clamp(lum)",
  matLum.emissive &&
    matLum.emissive.r === 1 &&
    matLum.emissive.g === 1 &&
    matLum.emissive.b === 1 &&
    Math.abs(matLum.emissiveIntensity - 0.5) < 1e-6,
  `emissive=${JSON.stringify(matLum.emissive)}, intensity=${matLum.emissiveIntensity}`,
);
check(
  // A10-M1 (2026-06-11): the cache path attaches the diffuse texture as
  // emissiveMap so retail's texture×emissive (FF combiner, acclient.c:454691-
  // 454697 + 454429-454432) is reproduced — a coloured luminous surface glows
  // in its own colour instead of washing to white. (Superseded the old
  // "NO emissiveMap" reading; see A10 §3 row 2.)
  "luminosity float>0 WITH texture: emissiveMap = the diffuse texture",
  matLum.emissiveMap === stubTex,
  `emissiveMap=${matLum.emissiveMap?.uuid}, stub=${stubTex.uuid}`,
);
check(
  "luminosity float clamps to 2.0",
  fl(0, { luminosity: 9.0 }).emissiveIntensity === 2.0,
  `intensity=${fl(0, { luminosity: 9.0 }).emissiveIntensity}`,
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

// (f) Diffuse reflectance — driven by the diffuse FLOAT, not the 0x20 bit.
// Retail sets the bit on 0/6152 surfaces; the float scales albedo color
// (acclient.c SetSurface @454458).
const matDiffBitOnly = fl(SURFACE_TYPE.Diffuse, undefined);
check(
  "Diffuse bit alone (no float): color stays white (inert)",
  matDiffBitOnly.color &&
    matDiffBitOnly.color.r === 1 &&
    matDiffBitOnly.color.g === 1 &&
    matDiffBitOnly.color.b === 1,
  `color=${JSON.stringify(matDiffBitOnly.color)}`,
);
const matDiff = fl(0, { diffuse: 0.5 });
check(
  "diffuse float (0.5): albedo color scaled to ~0.5 grayscale",
  matDiff.color &&
    Math.abs(matDiff.color.r - 0.5) < 1e-6 &&
    Math.abs(matDiff.color.g - 0.5) < 1e-6 &&
    Math.abs(matDiff.color.b - 0.5) < 1e-6,
  `color=${JSON.stringify(matDiff.color)}`,
);
check(
  "diffuse float ~1.0: color left white (no-op)",
  (() => {
    const m = fl(0, { diffuse: 1.0 });
    return m.color.r === 1 && m.color.g === 1 && m.color.b === 1;
  })(),
  "color should remain white at diffuse=1.0",
);

// (f2) Alpha (0x100) — texture-alpha blend (new branch; 253 retail surfaces).
const matAlpha = fl(SURFACE_TYPE.Alpha, undefined);
check(
  "Alpha (0x100): transparent=true, depthWrite=false, opacity=1 (texture alpha)",
  matAlpha.transparent === true &&
    matAlpha.depthWrite === false &&
    matAlpha.opacity === 1,
  `transparent=${matAlpha.transparent}, depthWrite=${matAlpha.depthWrite}, opacity=${matAlpha.opacity}`,
);

// (f3) InvAlpha (0x200) — inverse alpha blend. Pre-2026-05-28 this fell
// through to opaque despite materialCanCastShadow classifying it transparent.
// First cut routes it through the alpha-blend branch (acclient.c @454478).
const matInvAlpha = fl(SURFACE_TYPE.InvAlpha, undefined);
check(
  "InvAlpha (0x200): transparent=true, depthWrite=false (not opaque)",
  matInvAlpha.transparent === true && matInvAlpha.depthWrite === false,
  `transparent=${matInvAlpha.transparent}, depthWrite=${matInvAlpha.depthWrite}`,
);

// (g) Combined Translucent bit + luminosity float → both applied.
const matComboTL = fl(SURFACE_TYPE.Translucent, { luminosity: 0.4 });
check(
  "Translucent + lum float: transparent=true AND emissive white + emissiveMap=texture",
  matComboTL.transparent === true &&
    matComboTL.emissive.r === 1 &&
    matComboTL.emissiveMap === stubTex,
  `transparent=${matComboTL.transparent}, emissive=${JSON.stringify(matComboTL.emissive)}, hasMap=${!!matComboTL.emissiveMap}`,
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
  // Retail self-illum is float-driven, not bit-driven — give B a
  // luminosity float (the 0x40 bit is inert now).
  surfaceType: 0,
  luminosity: 0.7,
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
  const surfaceFloats = {
    translucency: sp.translucency ?? 0,
    luminosity: sp.luminosity ?? 0,
    diffuse: sp.diffuse ?? 0,
  };
  const mat = cache._materialFromFlags(
    surfaceTypeFlags, tex, undefined, undefined, undefined, undefined, surfaceFloats,
  );
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
  "two-sided distinct: matB self-illuminates from its luminosity float (texture-modulated emissiveMap)",
  matB.emissive &&
    matB.emissive.r === 1 &&
    matB.emissiveMap === cache2.textures.get(0x08000A02) &&
    Math.abs(matB.emissiveIntensity - 0.7) < 1e-6,
  `emissive=${JSON.stringify(matB.emissive)}, hasMap=${!!matB.emissiveMap}, intensity=${matB.emissiveIntensity}`,
);
check(
  "MaterialCache stores both materials independently",
  cache2.materials.size === 2,
  `cache2.materials.size=${cache2.materials.size}`,
);

// ---- Stage 4: A10-M1 single-decoder prop-equality -------------------
// The unified `applySurfaceRenderState` (materials.js) is the JS analogue of
// retail's sole `D3DPolyRender::SetSurface`. With `?surfaceUnified=on` BOTH
// decode sites delegate to it. This stage asserts byte-identical render-state
// props across the flag×float matrix between:
//   (A) `_materialFromFlags` with the flag ON (it builds a fresh material then
//       calls the unified function), and
//   (B) the unified function applied directly to a default material
//       (the shape the paletted/entity path delegates with).
// The render-state props compared are exactly those the decoder owns:
// transparent, depthWrite, blending, blendSrc, blendDst, blendEquation,
// opacity, alphaTest, emissive(.getHex), emissiveIntensity, emissiveMap,
// color(.getHex). (Normal-map/POM/CSM/detail gates are off on a bare cache,
// so they don't perturb the comparison.)

// Fake a default-off then default-on `window.location.search` so
// `readSurfaceUnifiedFlag()` flips. Restored after the stage.
const _prevWindow = globalThis.window;
function setUnifiedFlag(on) {
  globalThis.window = { location: { search: on ? "?surfaceUnified=on" : "" } };
}

setUnifiedFlag(true);
check(
  "?surfaceUnified=on → readSurfaceUnifiedFlag() true",
  readSurfaceUnifiedFlag() === true,
  `got=${readSurfaceUnifiedFlag()}`,
);
setUnifiedFlag(false);
check(
  "no flag → readSurfaceUnifiedFlag() false (default off)",
  readSurfaceUnifiedFlag() === false,
  `got=${readSurfaceUnifiedFlag()}`,
);

const DECODER_PROPS = [
  "transparent",
  "depthWrite",
  "blending",
  "blendSrc",
  "blendDst",
  "blendEquation",
  "opacity",
  "alphaTest",
  "emissiveIntensity",
];
function snapshotDecoderProps(mat) {
  const snap = {};
  for (const k of DECODER_PROPS) snap[k] = mat[k];
  snap.emissive = mat.emissive ? mat.emissive.getHex() : null;
  snap.color = mat.color ? mat.color.getHex() : null;
  // Compare emissiveMap by identity-to-the-input-texture (true/false), since the
  // two paths legitimately reference the same `stubTex`.
  snap.emissiveMapIsTex = mat.emissiveMap === stubTex;
  return snap;
}
function propsEqual(a, b) {
  for (const k of Object.keys(a)) {
    if (a[k] !== b[k]) return { ok: false, k, a: a[k], b: b[k] };
  }
  return { ok: true };
}

const F = SURFACE_TYPE;
const FLAG_COMBOS = [
  0,
  F.Translucent,
  F.Base1ClipMap,
  F.Alpha,
  F.InvAlpha,
  F.Additive,
  F.Additive | F.Alpha,
  F.Translucent | F.Additive,
  F.Luminous,
  F.Translucent | F.Luminous,
];
const FLOAT_COMBOS = [
  undefined,
  { luminosity: 0.5 },
  { luminosity: 9.0 },
  { diffuse: 0.5 },
  { diffuse: 1.0 },
  { translucency: 0.3 },
  { translucency: 0.3, luminosity: 0.6, diffuse: 0.4 },
];

const cacheU = new MaterialCache();
let comboFails = 0;
let comboCount = 0;
for (const flags of FLAG_COMBOS) {
  for (const floats of FLOAT_COMBOS) {
    comboCount += 1;
    // (A) cache path with the flag ON.
    setUnifiedFlag(true);
    const matA = cacheU._materialFromFlags(
      flags >>> 0, stubTex, undefined, undefined, undefined, undefined, floats,
    );
    // (B) unified function applied directly to a default material — the shape
    // the paletted/entity path delegates with.
    const matB = new THREE.MeshStandardMaterial({
      map: stubTex,
      roughness: 0.9,
      metalness: 0.0,
      side: THREE.DoubleSide,
      transparent: false,
      alphaTest: 0,
    });
    applySurfaceRenderState(
      matB,
      {
        flags: flags >>> 0,
        translucency: floats?.translucency ?? 0,
        luminosity: floats?.luminosity ?? 0,
        diffuse: floats?.diffuse ?? 0,
      },
      { texture: stubTex },
    );
    setUnifiedFlag(false);
    const cmp = propsEqual(snapshotDecoderProps(matA), snapshotDecoderProps(matB));
    if (!cmp.ok) {
      comboFails += 1;
      console.log(
        `  [FAIL] combo flags=0x${(flags >>> 0).toString(16)} floats=${JSON.stringify(floats)}` +
          ` — prop ${cmp.k}: cache=${cmp.a} unified=${cmp.b}`,
      );
    }
  }
}
check(
  `A10-M1 prop-equality: ${comboCount - comboFails}/${comboCount} flag×float combos byte-identical (cache path == unified fn)`,
  comboFails === 0,
  comboFails === 0 ? "" : `${comboFails} combo(s) diverged`,
);

// Spot-check the load-bearing fix: a luminous combo under the unified decoder
// attaches the emissiveMap (the dyed-luminous wash-to-white fix).
{
  setUnifiedFlag(true);
  const matLumU = cacheU._materialFromFlags(
    F.Luminous, stubTex, undefined, undefined, undefined, undefined, { luminosity: 0.6 },
  );
  setUnifiedFlag(false);
  check(
    "A10-M1 unified: luminous surface attaches emissiveMap=texture",
    matLumU.emissiveMap === stubTex,
    `emissiveMap=${matLumU.emissiveMap?.uuid}`,
  );
}

// Default-off rollback: with no flag the cache path is unchanged (still attaches
// emissiveMap because that fix predates M1; the point is the inline ladder runs).
{
  setUnifiedFlag(false);
  const matOff = cacheU._materialFromFlags(
    F.Additive | F.Alpha, stubTex, undefined, undefined, undefined, undefined, undefined,
  );
  check(
    "A10-M1 default-off: cache path inline ladder still resolves Alpha+Additive (CustomBlending)",
    matOff.blending === THREE.CustomBlending &&
      matOff.blendSrc === THREE.SrcAlphaFactor &&
      matOff.blendDst === THREE.OneFactor,
    `blending=${matOff.blending}, src=${matOff.blendSrc}, dst=${matOff.blendDst}`,
  );
}

// ---- Stage 4b: A10-M1 OFF-vs-ON parity (the real regression lens) -------
// FIXUP A10-M1 (2026-06-11): Stage 4 above compares matA (cache, flag ON) vs
// matB (unified fn applied directly) — but BOTH pass through the same decoder,
// so they agree even when the decoder diverges from the LEGACY (flag-OFF) path.
// The load-bearing invariant is OFF-vs-ON parity: flipping ?surfaceUnified on
// must NOT change a material's render-state props (except the intended dyed-
// luminous emissiveMap fix, which lands on the paletted path, not the cache).
// In particular the float-driven luminosity-emissive and diffuse-tint are
// BIT-INDEPENDENT (census: 762 surfaces carry luminosity>0 and 6150 carry
// diffuse>0 with ZERO surface-type bits) — so flags=0 + nonzero-float cells are
// the regression the original `if (flags === 0) return;` early-return masked.
// Here we compare the legacy cache path (flag OFF, inline ladder) against the
// cache path (flag ON, unified decoder) across the SAME flag×float matrix.
{
  const cacheOff = new MaterialCache();
  let offOnFails = 0;
  let offOnCount = 0;
  for (const flags of FLAG_COMBOS) {
    for (const floats of FLOAT_COMBOS) {
      offOnCount += 1;
      // Legacy: flag OFF → the inline `opts` ladder in _materialFromFlags.
      setUnifiedFlag(false);
      const matLegacy = cacheOff._materialFromFlags(
        flags >>> 0, stubTex, undefined, undefined, undefined, undefined, floats,
      );
      // Unified: flag ON → the single applySurfaceRenderState decoder.
      setUnifiedFlag(true);
      const matUnified = cacheOff._materialFromFlags(
        flags >>> 0, stubTex, undefined, undefined, undefined, undefined, floats,
      );
      setUnifiedFlag(false);
      const cmp = propsEqual(
        snapshotDecoderProps(matLegacy), snapshotDecoderProps(matUnified),
      );
      if (!cmp.ok) {
        offOnFails += 1;
        console.log(
          `  [FAIL] OFF-vs-ON flags=0x${(flags >>> 0).toString(16)} floats=${JSON.stringify(floats)}` +
            ` — prop ${cmp.k}: legacy=${cmp.a} unified=${cmp.b}`,
        );
      }
    }
  }
  check(
    `A10-M1 OFF-vs-ON parity: ${offOnCount - offOnFails}/${offOnCount} flag×float combos identical (legacy cache == unified cache)`,
    offOnFails === 0,
    offOnFails === 0 ? "" : `${offOnFails} combo(s) diverged`,
  );
}

// Pinpoint regression cells the FIXUP repairs: flags=0 + nonzero float must NOT
// drop the float-driven emissive/diffuse under the unified decoder. (Pre-fixup
// these returned early: emissiveIntensity 1/color white instead of the float.)
{
  const cachePin = new MaterialCache();
  // flags=0 + luminosity>0: emissive must scale by the float (NOT 1.0 default).
  setUnifiedFlag(true);
  const lumPin = cachePin._materialFromFlags(
    0, stubTex, undefined, undefined, undefined, undefined, { luminosity: 0.6 },
  );
  setUnifiedFlag(false);
  check(
    "A10-M1 fixup: flags=0 + luminosity 0.6 → emissive scaled by float + emissiveMap (not dropped)",
    Math.abs(lumPin.emissiveIntensity - 0.6) < 1e-6 &&
      lumPin.emissive.getHex() === 0xffffff &&
      lumPin.emissiveMap === stubTex,
    `intensity=${lumPin.emissiveIntensity}, emissive=0x${lumPin.emissive.getHex().toString(16)}, hasMap=${lumPin.emissiveMap === stubTex}`,
  );
  // flags=0 + diffuse!=1: albedo color must dim by the float (NOT stay white).
  setUnifiedFlag(true);
  const diffPin = cachePin._materialFromFlags(
    0, stubTex, undefined, undefined, undefined, undefined, { diffuse: 0.5 },
  );
  setUnifiedFlag(false);
  check(
    "A10-M1 fixup: flags=0 + diffuse 0.5 → albedo color dimmed by float (not left white)",
    Math.abs(diffPin.color.r - 0.5) < 1e-6 &&
      Math.abs(diffPin.color.g - 0.5) < 1e-6 &&
      Math.abs(diffPin.color.b - 0.5) < 1e-6,
    `color=0x${diffPin.color.getHex().toString(16)}`,
  );
  // flags=0 + no float: stays opaque/full-bright (the genuine fail-soft case).
  setUnifiedFlag(true);
  const plainPin = cachePin._materialFromFlags(
    0, stubTex, undefined, undefined, undefined, undefined, undefined,
  );
  setUnifiedFlag(false);
  check(
    "A10-M1 fixup: flags=0 + no float → stays opaque, default emissive/color (fail-soft preserved)",
    plainPin.transparent === false &&
      plainPin.emissiveIntensity === 1 &&
      plainPin.color.getHex() === 0xffffff,
    `transparent=${plainPin.transparent}, intensity=${plainPin.emissiveIntensity}, color=0x${plainPin.color.getHex().toString(16)}`,
  );
}

// ---- Stage 5: A10-M2 entity-owned (F.41 recolour) path threads flags ----
// `_buildEntityOwnedFromPixels` (the F.41 entity recolour path) historically
// built a plain opaque MeshStandardMaterial — a recoloured NPC/gear surface with
// Translucent/Additive/ClipMap/luminosity rendered flat-opaque (A10 §3 row 3).
// Under `?surfaceUnified=on` it now runs the same `applySurfaceRenderState`
// decoder as every other surface (retail: D3DPolyRender::SetSurface is the SOLE
// funnel, acclient.c:454385). Default OFF keeps the legacy plain-opaque material.
//
// The factory stripped the bare `./adapter.js` import, so inject a minimal
// `surfacePixelsToTexture` global the closure can resolve. We also need a real
// `MaterialCache` instance to call the private method on.
globalThis.surfacePixelsToTexture = (pixels, w, h) => {
  const t = new THREE.DataTexture(
    pixels, w, h, THREE.RGBAFormat, THREE.UnsignedByteType,
  );
  t.needsUpdate = true;
  return t;
};

function makeSP({ surfaceType = 0, translucency = 0, luminosity = 0, diffuse = 0 }) {
  return {
    width: 1,
    height: 1,
    pixels: new Uint8Array([128, 128, 128, 255]),
    surfaceType,
    translucency,
    luminosity,
    diffuse,
    free() {},
  };
}

const cacheM2 = new MaterialCache();

// (5a) Default OFF — entity-owned recolour stays plain opaque even with an
// Additive surfaceType (legacy / rollback behaviour preserved).
setUnifiedFlag(false);
const m2Off = cacheM2._buildEntityOwnedFromPixels(
  0x09000A01, makeSP({ surfaceType: SURFACE_TYPE.Additive }),
);
check(
  "A10-M2 default-off: entity-owned Additive surface stays plain opaque (legacy)",
  m2Off &&
    m2Off.transparent === false &&
    m2Off.blending === THREE.NormalBlending &&
    m2Off.userData.surfaceTypeFlags === SURFACE_TYPE.Additive,
  `transparent=${m2Off?.transparent}, blending=${m2Off?.blending}`,
);

// (5b) Flag ON — Additive recolour now blends additively (the row-3 fix).
setUnifiedFlag(true);
const m2Add = cacheM2._buildEntityOwnedFromPixels(
  0x09000A02, makeSP({ surfaceType: SURFACE_TYPE.Additive }),
);
check(
  "A10-M2 unified: entity-owned Additive surface → AdditiveBlending, transparent, depthWrite off",
  m2Add &&
    m2Add.blending === THREE.AdditiveBlending &&
    m2Add.transparent === true &&
    m2Add.depthWrite === false,
  `blending=${m2Add?.blending}, transparent=${m2Add?.transparent}, depthWrite=${m2Add?.depthWrite}`,
);

// (5c) Flag ON — Translucent recolour blends + honours the translucency float.
const m2Trans = cacheM2._buildEntityOwnedFromPixels(
  0x09000A03, makeSP({ surfaceType: SURFACE_TYPE.Translucent, translucency: 0.25 }),
);
check(
  "A10-M2 unified: entity-owned Translucent (T=0.25) → transparent, opacity=0.75",
  m2Trans &&
    m2Trans.transparent === true &&
    m2Trans.depthWrite === false &&
    Math.abs(m2Trans.opacity - 0.75) < 1e-6,
  `transparent=${m2Trans?.transparent}, opacity=${m2Trans?.opacity}`,
);

// (5d) Flag ON — luminous recolour WITH a render-state bit set (here Translucent)
// self-illuminates AND attaches the recoloured texture as emissiveMap (the
// FF-modulate reading carried from M1). This is the dyed-luminous wash-to-white
// fix now reaching the recolour path too. (A pure luminosity float with flags=0
// is a decoder no-op — see 5e and the M1 `flags===0` early-return contract — so
// the bit-bearing case is what exercises the luminous branch through M2.)
const m2Lum = cacheM2._buildEntityOwnedFromPixels(
  0x09000A04, makeSP({ surfaceType: SURFACE_TYPE.Translucent, luminosity: 0.6 }),
);
check(
  "A10-M2 unified: entity-owned luminous → emissive white, intensity=0.6, emissiveMap=its own texture",
  m2Lum &&
    m2Lum.emissive &&
    m2Lum.emissive.r === 1 &&
    Math.abs(m2Lum.emissiveIntensity - 0.6) < 1e-6 &&
    m2Lum.emissiveMap === m2Lum.map,
  `emissive=${JSON.stringify(m2Lum?.emissive)}, intensity=${m2Lum?.emissiveIntensity}, mapMatch=${m2Lum?.emissiveMap === m2Lum?.map}`,
);

// (5e) Flag ON — surfaceType 0 (plain opaque recolour) is a decoder no-op, so it
// stays byte-identical to the default-off material (the common NPC-dye case must
// not regress).
const m2Plain = cacheM2._buildEntityOwnedFromPixels(
  0x09000A05, makeSP({ surfaceType: 0 }),
);
check(
  "A10-M2 unified: surfaceType=0 recolour stays plain opaque (decoder no-op)",
  m2Plain &&
    m2Plain.transparent === false &&
    m2Plain.blending === THREE.NormalBlending &&
    m2Plain.alphaTest === 0 &&
    m2Plain.emissiveIntensity === 1 &&
    m2Plain.emissiveMap === null,
  `transparent=${m2Plain?.transparent}, blending=${m2Plain?.blending}, emissiveMap=${m2Plain?.emissiveMap}`,
);

// (5f) Equivalence: the entity-owned ON-path render-state props match the cache
// path's unified decode for the same flags+floats (the unification invariant —
// retail has ONE decision point for ALL surfaces).
setUnifiedFlag(true);
for (const [st, fl2] of [
  [SURFACE_TYPE.Additive, {}],
  [SURFACE_TYPE.Translucent, { translucency: 0.25 }],
  [SURFACE_TYPE.Base1ClipMap, {}],
  [SURFACE_TYPE.Alpha, {}],
  [0, { luminosity: 0.6 }],
]) {
  const eoMat = cacheM2._buildEntityOwnedFromPixels(
    0x09001000 + st, makeSP({ surfaceType: st, ...fl2 }),
  );
  // Reference material: a default opaque material run through the unified fn with
  // the SAME inputs (its own texture as emissiveMap source).
  const refMat = new THREE.MeshStandardMaterial({
    map: eoMat.map,
    roughness: 0.9,
    metalness: 0.0,
    side: THREE.DoubleSide,
    transparent: false,
  });
  applySurfaceRenderState(
    refMat,
    {
      flags: st,
      translucency: fl2.translucency ?? 0,
      luminosity: fl2.luminosity ?? 0,
      diffuse: fl2.diffuse ?? 0,
    },
    { texture: eoMat.map },
  );
  const cmp2 = (() => {
    for (const k of DECODER_PROPS) {
      if (eoMat[k] !== refMat[k]) return { ok: false, k, a: eoMat[k], b: refMat[k] };
    }
    if ((eoMat.emissive?.getHex() ?? null) !== (refMat.emissive?.getHex() ?? null))
      return { ok: false, k: "emissive" };
    if ((eoMat.emissiveMap === eoMat.map) !== (refMat.emissiveMap === eoMat.map))
      return { ok: false, k: "emissiveMap" };
    return { ok: true };
  })();
  check(
    `A10-M2 equivalence: entity-owned ON == unified decode for surfaceType=0x${st.toString(16)}`,
    cmp2.ok,
    cmp2.ok ? "" : `prop ${cmp2.k}: entity=${cmp2.a} unified=${cmp2.b}`,
  );
}
setUnifiedFlag(false);
delete globalThis.surfacePixelsToTexture;

// restore
if (_prevWindow === undefined) delete globalThis.window;
else globalThis.window = _prevWindow;

// ---- summary --------------------------------------------------------
console.log("=========================");
if (failed === 0) {
  console.log("PASS: all surface_type bitfield checks green.");
  process.exit(0);
} else {
  console.log(`FAIL: ${failed} check(s) failed.`);
  process.exit(1);
}
