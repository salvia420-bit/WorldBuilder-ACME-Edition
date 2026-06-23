// VFX Phase 0 / 1b — dormant material substrate smoke test.
//
// The VFX_GLOBALS shared uniforms + getCachedVariant + vfxVariants Map are
// inert until a frag/MECH-B component uses them. This just confirms they exist,
// export cleanly, and don't break MaterialCache construction.

import { VFX_GLOBALS, MaterialCache } from "./scene3d/materials.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

check("VFX_GLOBALS exports the 5 shared uniforms",
  !!VFX_GLOBALS && !!VFX_GLOBALS.uTime && "value" in VFX_GLOBALS.uTime &&
  !!VFX_GLOBALS.uWindDir?.value && !!VFX_GLOBALS.uWetness && !!VFX_GLOBALS.uFrost && !!VFX_GLOBALS.uCamPos);
check("uTime starts at 0 (driven by the Phase-1 oscillator tick)", VFX_GLOBALS.uTime.value === 0);
check("uWindDir is a Vector2-like {value:{x,y}}",
  typeof VFX_GLOBALS.uWindDir.value.x === "number" && typeof VFX_GLOBALS.uWindDir.value.y === "number");
check("MaterialCache.getCachedVariant method exists",
  typeof MaterialCache.prototype.getCachedVariant === "function");

let ctorOk = false, mapOk = false;
try {
  const mc = new MaterialCache({ wireframeMode: true }); // wireframe = lightest construct
  ctorOk = true;
  mapOk = mc.vfxVariants instanceof Map && mc.vfxVariants.size === 0;
} catch (e) { console.log("    ctor err:", e.message); }
check("MaterialCache constructs without error (no substrate regression)", ctorOk);
check("vfxVariants is an empty Map after construct", mapOk);

console.log(`\nVFX material substrate: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
