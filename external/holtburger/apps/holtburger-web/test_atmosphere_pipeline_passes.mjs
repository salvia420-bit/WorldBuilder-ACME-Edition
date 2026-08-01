// Atmosphere composer pass-config test (2026-08).
//
// `createAtmosphereComposer` cannot be imported under plain node: it pulls in
// `@takram/three-atmosphere` and every pass it builds wants a live WebGL
// context. So this suite locks the two cheap-but-invisible pass settings the
// module applies in TWO layers:
//
//   (A) the pmndrs BEHAVIOUR the settings rely on, exercised against the real
//       installed `postprocessing` (no GL needed for either construction), so
//       a package bump that renames/re-defaults the property fails here rather
//       than silently reverting the saving; and
//   (B) the SOURCE of atmosphere_pipeline.js, so removing the line fails too.
//
// Both settings must be render-identical:
//   1. skyRenderPass.needsDepthBlit = false — the blit is wiped one pass later
//      by worldRenderPass's clearDepth, and nothing in between reads composer
//      depth.
//   2. bloom.luminancePass.resolution.scale = 0.5 — the luminance prepass's
//      only consumer is mipmapBlurPass, whose first level halves the input
//      anyway.

import * as THREE from "three";
import { RenderPass, BloomEffect } from "postprocessing";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(
  path.join(HERE, "scene3d", "atmosphere_pipeline.js"),
  "utf8"
);

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

console.log("atmosphere composer pass config");
console.log("=========================");

// ---- (A) pmndrs behaviour the fixes depend on ------------------------------
const rp = new RenderPass(new THREE.Scene(), new THREE.PerspectiveCamera());
check("pmndrs RenderPass still ctor-defaults needsDepthBlit = true (the waste)",
  rp.needsDepthBlit === true, `got ${rp.needsDepthBlit}`);
rp.needsDepthBlit = false;
check("needsDepthBlit is a plain writable property (the opt-out works)",
  rp.needsDepthBlit === false, `got ${rp.needsDepthBlit}`);

const bloom = new BloomEffect({
  intensity: 1.0,
  luminanceThreshold: 0.85,
  luminanceSmoothing: 0.1,
  mipmapBlur: true,
  radius: 0.85,
});
check("pmndrs BloomEffect exposes .luminancePass.resolution",
  !!(bloom.luminancePass && bloom.luminancePass.resolution));
check("★ BloomEffect still ctor-defaults its LuminancePass to scale 1.0 (full res)",
  bloom.luminancePass.resolution.scale === 1.0,
  `got ${bloom.luminancePass.resolution.scale}`);

// The scale setter must resize the pass's render target, not just store a
// number — Resolution dispatches "change" and LuminancePass listens.
bloom.luminancePass.setSize(1920, 1080);
const fullW = bloom.luminancePass.renderTarget.width;
const fullH = bloom.luminancePass.renderTarget.height;
check("baseline: luminance RT tracks the full drawing-buffer size",
  fullW === 1920 && fullH === 1080, `got ${fullW}x${fullH}`);
bloom.luminancePass.resolution.scale = 0.5;
check("★ scale = 0.5 actually HALVES the luminance render target",
  bloom.luminancePass.renderTarget.width === 960 &&
  bloom.luminancePass.renderTarget.height === 540,
  `got ${bloom.luminancePass.renderTarget.width}x${bloom.luminancePass.renderTarget.height}`);
// …and keeps tracking later composer resizes at the reduced scale.
bloom.setSize(1280, 720);
check("★ the half-res scale survives a later composer setSize",
  bloom.luminancePass.renderTarget.width === 640 &&
  bloom.luminancePass.renderTarget.height === 360,
  `got ${bloom.luminancePass.renderTarget.width}x${bloom.luminancePass.renderTarget.height}`);

// ---- (B) the module actually applies them ----------------------------------
check("★ atmosphere_pipeline.js sets skyRenderPass.needsDepthBlit = false",
  /skyRenderPass\.needsDepthBlit\s*=\s*false\s*;/.test(SRC));
check("★ atmosphere_pipeline.js sets bloom.luminancePass.resolution.scale = 0.5",
  /bloom\.luminancePass\.resolution\.scale\s*=\s*0\.5\s*;/.test(SRC));

// The sky blit is only dead BECAUSE the world pass clears depth right after —
// if that ever stops being unconditional, the opt-out has to be revisited.
check("worldRenderPass still clears depth (what makes the sky blit dead)",
  /worldRenderPass\.clearDepth\s*=\s*true\s*;/.test(SRC));
// …and nothing may re-enable the blit further down the file.
check("nothing re-enables skyRenderPass.needsDepthBlit",
  !/skyRenderPass\.needsDepthBlit\s*=\s*true/.test(SRC));

console.log("=========================");
console.log(`atmosphere composer pass config: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
