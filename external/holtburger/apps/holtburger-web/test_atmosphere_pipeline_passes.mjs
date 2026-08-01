// Atmosphere composer pass-config test (2026-08).
//
// `createAtmosphereComposer` cannot be imported under plain node: it pulls in
// `@takram/three-atmosphere` and every pass it builds wants a live WebGL
// context. So this suite locks the cheap-but-invisible pass settings the
// module applies in TWO layers:
//
//   (A) the pmndrs BEHAVIOUR the settings rely on, exercised against the real
//       installed `postprocessing` (no GL needed for construction), so a
//       package bump that renames/re-defaults the property fails here rather
//       than silently reverting the saving; and
//   (B) the SOURCE of atmosphere_pipeline.js, so removing the line fails too.
//
// Setting locked here (render-identical):
//   skyRenderPass.needsDepthBlit = false — the blit is wiped one pass later by
//   worldRenderPass's clearDepth, and nothing in between reads composer depth.

import * as THREE from "three";
import { RenderPass } from "postprocessing";
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

// ---- (A) pmndrs behaviour the fix depends on -------------------------------
const rp = new RenderPass(new THREE.Scene(), new THREE.PerspectiveCamera());
check("pmndrs RenderPass still ctor-defaults needsDepthBlit = true (the waste)",
  rp.needsDepthBlit === true, `got ${rp.needsDepthBlit}`);
rp.needsDepthBlit = false;
check("needsDepthBlit is a plain writable property (the opt-out works)",
  rp.needsDepthBlit === false, `got ${rp.needsDepthBlit}`);

// ---- (B) the module actually applies it ------------------------------------
check("★ atmosphere_pipeline.js sets skyRenderPass.needsDepthBlit = false",
  /skyRenderPass\.needsDepthBlit\s*=\s*false\s*;/.test(SRC));

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
