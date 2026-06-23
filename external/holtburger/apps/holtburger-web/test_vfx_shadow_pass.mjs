// VFX Phase 1 — shadow/depth-pass exclusion test (spec §8). Three-free.
//
// Locks the invariant that a getCachedVariant color patch (emissive/weathering
// frag effects) reaches the COLOR pass ONLY and never corrupts the shadow/depth
// WRITE:
//   (1) three.js r184 builds the shadow depth material by copying ONLY a fixed
//       property allowlist from the color material — so even a fully VFX-patched
//       color material projects to an UNPATCHED depth material;
//   (2) the only way to leak the patch is to assign the variant as
//       customDepthMaterial/customDistanceMaterial — assertNoVfxDepthLeak()
//       catches that and frag_install must satisfy it;
//   (3) materials.js getCachedVariant actually stamps the __vfxColorPassOnly
//       tag the guard relies on, and the substrate never sets a custom depth
//       material (source assertions, no three needed).

import fs from "node:fs";
import path from "node:path";
import {
  DEPTH_PASS_COPY_KEYS,
  VFX_COLOR_PASS_TAG,
  isVfxColorVariant,
  assertNoVfxDepthLeak,
  projectDepthMaterial,
  assertDepthMaterialUnpatched,
} from "./scene3d/vfx/shadow_guard.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

// A mock VFX color variant exactly as getCachedVariant + a frag builder leaves
// it: an onBeforeCompile chain, a customProgramCacheKey, the __vfx* userData
// tags, plus a few PBR fields the patch drives (emissive*). Also the harmless
// allowlist fields three copies (map/side/alphaTest/visible).
const patchedColor = {
  type: "MeshStandardMaterial",
  name: "vfx-variant(emissive.glint|weathering.tarnish)",
  visible: true,
  side: 2,
  map: { isTexture: true },
  alphaTest: 0,
  emissive: { r: 0, g: 0, b: 0 },
  emissiveIntensity: 1.5,
  roughness: 0.4,
  metalness: 1.0,
  onBeforeCompile: function chainedOnBeforeCompile() {},
  customProgramCacheKey: function () { return "hb|...|vglint+tarnish"; },
  userData: { __cacheOwned: true, __vfxSetKey: "emissive.glint+weathering.tarnish", __vfxColorPassOnly: true },
};

// A base (unpatched) material — no VFX tags, default onBeforeCompile.
const baseColor = { type: "MeshStandardMaterial", visible: true, side: 2, map: { isTexture: true }, userData: {} };

// A legitimate NON-VFX custom depth material (e.g. an alpha-cutout helper) —
// allowed; the guard must NOT false-positive on it.
const plainDepth = { type: "MeshDepthMaterial", userData: {} };

// ---- (1) classification ----
check("isVfxColorVariant true for a patched variant (__vfxColorPassOnly)", isVfxColorVariant(patchedColor));
check("isVfxColorVariant true via __vfxSetKey fallback",
  isVfxColorVariant({ userData: { __vfxSetKey: "x" } }));
check("isVfxColorVariant false for the base material", !isVfxColorVariant(baseColor));
check("isVfxColorVariant false for a plain depth material", !isVfxColorVariant(plainDepth));
check("isVfxColorVariant false for null/undefined", !isVfxColorVariant(null) && !isVfxColorVariant(undefined));

// ---- (2) the depth material three would build is UNPATCHED ----
const depthMat = projectDepthMaterial(patchedColor, {});
check("projected depth material copies the allowlist (map/side/alphaTest)",
  depthMat.map === patchedColor.map && depthMat.side === patchedColor.side && depthMat.alphaTest === 0);
check("projected depth material did NOT receive onBeforeCompile", !("onBeforeCompile" in depthMat));
check("projected depth material did NOT receive customProgramCacheKey", !("customProgramCacheKey" in depthMat));
check("projected depth material did NOT receive userData (no __vfx* tags)", !("userData" in depthMat));
check("projected depth material did NOT receive emissive/metalness", !("emissive" in depthMat) && !("metalness" in depthMat));
check("assertDepthMaterialUnpatched clean for a fully patched color material",
  assertDepthMaterialUnpatched(patchedColor).length === 0);
check("allowlist excludes every patch-bearing key",
  !DEPTH_PASS_COPY_KEYS.includes("onBeforeCompile") &&
  !DEPTH_PASS_COPY_KEYS.includes("customProgramCacheKey") &&
  !DEPTH_PASS_COPY_KEYS.includes("userData") &&
  !DEPTH_PASS_COPY_KEYS.includes("emissive"));

// ---- (3) the leak guard ----
check("assertNoVfxDepthLeak clean for the default (no custom depth material)",
  assertNoVfxDepthLeak({ name: "tree-batch", castShadow: true, receiveShadow: true }).length === 0);
check("assertNoVfxDepthLeak clean for a plain (non-VFX) customDepthMaterial",
  assertNoVfxDepthLeak({ name: "x", customDepthMaterial: plainDepth }).length === 0);
check("assertNoVfxDepthLeak FLAGS a VFX variant set as customDepthMaterial",
  assertNoVfxDepthLeak({ name: "bad", customDepthMaterial: patchedColor }).length === 1);
check("assertNoVfxDepthLeak FLAGS a VFX variant set as customDistanceMaterial (point lights)",
  assertNoVfxDepthLeak({ name: "bad", customDistanceMaterial: patchedColor }).length === 1);
check("assertNoVfxDepthLeak tolerates null", assertNoVfxDepthLeak(null).length === 0);

// ---- (3b) source assertions: tie the guard to the shipped substrate ----
const matSrc = fs.readFileSync(path.resolve("scene3d/materials.js"), "utf8");
check("materials.js getCachedVariant stamps the __vfxColorPassOnly tag the guard reads",
  /__vfxColorPassOnly\s*:\s*true/.test(matSrc));
check("materials.js never assigns customDepthMaterial/customDistanceMaterial (depth pass stays three's internal default)",
  !/\.customDepthMaterial\s*=/.test(matSrc) && !/\.customDistanceMaterial\s*=/.test(matSrc));
check("VFX_COLOR_PASS_TAG matches the tag materials.js stamps",
  VFX_COLOR_PASS_TAG === "__vfxColorPassOnly" && matSrc.includes(VFX_COLOR_PASS_TAG));

console.log(`\nVFX shadow-pass exclusion: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
