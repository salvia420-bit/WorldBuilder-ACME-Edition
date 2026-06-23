// VFX Phase 0 — component substrate + deformation.windBend unit test.
//
// Locks: the windBend component faithfully wraps the shipped tree-wind math
// (byte-identical to buildBboxRig+buildTreeWindClip), the registry enforces the
// legacy-safety contract, and the two firewall corollaries (no light-count
// change, no per-instance cache key) are REJECTED at register time.

import { windBend } from "./scene3d/vfx/components/windBend.js";
import { validateComponent, getComponent, registerComponent } from "./scene3d/vfx/registry.js";
import { buildBboxRig, buildTreeWindClip } from "./scene3d/wind_rig.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}
function eqF32(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function box(minX, maxX, minY, maxY, minZ, maxZ) {
  return { minX, maxX, minY, maxY, minZ, maxZ, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, cz: (minZ + maxZ) / 2 };
}

// A 3-part tall tree (trunk / branch / canopy), like 0x02000258.
const partBoxes = [box(-0.3, 0.3, -0.3, 0.3, 0, 22), box(-2, 2, -2, 2, 4, 22), box(-8, 8, -8, 8, 5, 22)];
const hinge = [null, null, null];
const ctx = { numParts: 3, partBoxes, hingeFrames: hinge };
const cfg = { dirDeg: 135, strength: 1, phaseOffset: 0 };

const a = windBend.buildClip(ctx, cfg);
const rig = buildBboxRig(partBoxes, hinge).rigs;
const b = buildTreeWindClip(3, rig, cfg);

check("windBend registered as deformation.windBend", getComponent("deformation.windBend") === windBend);
check("buildClip returns {frames,numParts,numFrames,fps}",
  !!a && a.frames instanceof Float32Array && a.numParts === 3 && a.numFrames > 0 && a.fps === 30);
check("★ buildClip byte-identical to inline buildBboxRig+buildTreeWindClip (?treeWind unchanged)",
  eqF32(a.frames, b.frames), `lenA=${a.frames.length} lenB=${b.frames.length}`);

// 1c rewire: the live runtime calls buildClip({numParts, rig}, cfg) with its
// precomputed per-setupId rig. That must equal the partBoxes path AND the old
// inline buildTreeWindClip(numParts, rig, cfg) call → byte-identical swap.
const aRig = windBend.buildClip({ numParts: 3, rig }, cfg);
check("★ buildClip({numParts,rig}) == partBoxes path == inline buildTreeWindClip (runtime swap byte-identical)",
  eqF32(aRig.frames, a.frames) && eqF32(aRig.frames, b.frames));
check("validateComponent(windBend) clean", validateComponent(windBend).length === 0,
  validateComponent(windBend).join("; "));
check("legacy-safe manifest: lightCountDelta 0 + deterministic + cacheKeyScope none",
  windBend.lightCountDelta === 0 && windBend.deterministic === true && windBend.cacheKeyScope === "none");
check("reads are static/derived only", windBend.reads.length > 0 &&
  windBend.reads.every((r) => ["geometry", "surface", "setup", "weenieProps", "serverPose", "instanceHash", "clock", "drawCastSubstate", "weather"].includes(r)));
check("writes are render-only (partTransform)",
  windBend.writes.length === 1 && windBend.writes[0] === "partTransform");

// The registry must REJECT the two firewall violations (spec §1.2 corollaries 2 & 3).
let threwLight = false;
try {
  registerComponent({ id: "bad.lightcount", family: "emissive", mech: "light", channel: "light",
    deterministic: true, lightCountDelta: 1, cacheKeyScope: "none", reads: ["clock"], writes: ["materialUniform"] });
} catch (_) { threwLight = true; }
check("registry REJECTS lightCountDelta != 0 (no-relink rule)", threwLight);

let threwKey = false;
try {
  registerComponent({ id: "bad.instkey", family: "weathering", mech: "frag", channel: "tarnish",
    deterministic: true, lightCountDelta: 0, cacheKeyScope: "instance", reads: ["clock"], writes: ["materialUniform"] });
} catch (_) { threwKey = true; }
check("registry REJECTS cacheKeyScope=instance (shader-link explosion)", threwKey);

let threwWire = false;
try {
  registerComponent({ id: "bad.wire", family: "deformation", mech: "A", channel: "transform",
    deterministic: true, lightCountDelta: 0, cacheKeyScope: "none", reads: ["clock"], writes: ["wireValue"] });
} catch (_) { threwWire = true; }
check("registry REJECTS a non-render write (legacy-safety)", threwWire);

console.log(`\nVFX windBend component: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
