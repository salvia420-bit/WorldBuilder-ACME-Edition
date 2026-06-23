// Tree wind (Phase 1) — bbox base-pivot rig unit test.
//
// THE load-bearing correctness guard for AC's co-located-origin trees: every
// part sits at model origin (0,0,0), so a high canopy part MUST pivot about its
// own vertex base (Zmin), not the origin. A regression that pivots about the
// origin swings the canopy through a large arc — caught here.

import { partBBox, buildBboxRig, swayAmp, buildTreeWindClip } from "./scene3d/wind_rig.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}
const approx = (a, b, e = 1e-6) => Math.abs(a - b) < e;

// rotate a vec by a wxyz quat (mirrors wind_rig internal)
function qrot(q, v) {
  const [w, x, y, z] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

// ---- partBBox ----
const pos = new Float32Array([0, 0, 5.3, 2, 0, 21.8, -1, 1, 12]);
const bb = partBBox(pos);
check("partBBox minZ", approx(bb.minZ, 5.3), `got ${bb.minZ}`);
check("partBBox maxZ", approx(bb.maxZ, 21.8), `got ${bb.maxZ}`);
check("partBBox centroid", approx(bb.cz, (5.3 + 21.8) / 2));
check("partBBox empty → zeros", partBBox(null).minZ === 0 && partBBox(new Float32Array(0)).maxZ === 0);

// ---- a 3-part tall tree (like 0x02000258): trunk + branch + canopy ----
// trunk: narrow, spans full height 0..22 ; branch: 4..22 ; canopy: 5..22 broad
function box(minX, maxX, minY, maxY, minZ, maxZ) {
  return { minX, maxX, minY, maxY, minZ, maxZ, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, cz: (minZ + maxZ) / 2 };
}
const trunk = box(-0.3, 0.3, -0.3, 0.3, 0, 22);     // full height, narrow
const branch = box(-2, 2, -2, 2, 4, 22);
const canopy = box(-8, 8, -8, 8, 5, 22);            // high, broad
const identity = null;                               // identity rest frames
const { rigs, modelH } = buildBboxRig([trunk, branch, canopy], identity);

check("modelH ≈ 22", approx(modelH, 22, 1e-4), `got ${modelH}`);
check("trunk pivot.z = its base (0), not centroid", approx(rigs[0].pivot.z, 0), `got ${rigs[0].pivot.z}`);
check("canopy pivot.z = its base (5), NOT model origin 0", approx(rigs[2].pivot.z, 5), `got ${rigs[2].pivot.z}`);
check("trunk sways LESS than canopy (planted trunk)",
  rigs[0].weight < rigs[2].weight, `trunk=${rigs[0].weight} canopy=${rigs[2].weight}`);
check("trunk weight near the floor (full-height part suppressed)",
  rigs[0].weight <= 0.25, `got ${rigs[0].weight}`);

// ---- ★ THE SHEAR GUARD ----
// Build a wind frame for the canopy part and apply (R, O) to its pivot point.
// Correct rotate-about-pivot: R·pivot + O == pivot (pivot is the fixed point).
// A regression pivoting about origin (O==0) would move the pivot by a large arc.
const { frames, numParts, numFrames } = buildTreeWindClip(3, rigs, { fps: 30, loopSeconds: 4, ampDeg: 12, strength: 2 });
let maxFixedErr = 0, maxOriginArc = 0;
const canopyPivot = [rigs[2].pivot.x, rigs[2].pivot.y, rigs[2].pivot.z];
for (let f = 0; f < numFrames; f++) {
  const base = (f * numParts + 2) * 7; // part 2 = canopy
  const O = [frames[base], frames[base + 1], frames[base + 2]];
  const R = [frames[base + 3], frames[base + 4], frames[base + 5], frames[base + 6]];
  // rotate-about-pivot applied to the pivot itself → should return the pivot
  const mapped = qrot(R, canopyPivot);
  const fixed = [mapped[0] + O[0], mapped[1] + O[1], mapped[2] + O[2]];
  maxFixedErr = Math.max(maxFixedErr,
    Math.hypot(fixed[0] - canopyPivot[0], fixed[1] - canopyPivot[1], fixed[2] - canopyPivot[2]));
  // rotating the SAME point about the ORIGIN (the bug) moves it by an arc
  maxOriginArc = Math.max(maxOriginArc,
    Math.hypot(mapped[0] - canopyPivot[0], mapped[1] - canopyPivot[1], mapped[2] - canopyPivot[2]));
}
check("★ canopy pivots about its base: pivot is the FIXED point (R·piv+O==piv)",
  maxFixedErr < 1e-5, `maxErr=${maxFixedErr}`);
check("★ rotating about ORIGIN instead would swing the base by a large arc",
  maxOriginArc > 0.2, `arc=${maxOriginArc}`);

// ---- swayAmp monotonicity ----
const low = swayAmp(box(-1, 1, -1, 1, 0, 1), 0, 22);   // low part
const high = swayAmp(box(-1, 1, -1, 1, 20, 22), 0, 22); // high part
check("higher part sways more than lower", high > low, `low=${low} high=${high}`);

// ---- rest preservation: non-identity rest, zero wind → frame == rest ----
const rq = [Math.cos(0.4), 0, 0, Math.sin(0.4)];
const rigRest = [{ pivot: { x: 0, y: 0, z: 0 }, weight: 1, rest: { o: { x: 0, y: 0, z: 0 }, q: rq } }];
const fr0 = buildTreeWindClip(1, rigRest, { fps: 30, loopSeconds: 4, strength: 0 }).frames;
check("zero-wind preserves authored rest orientation (billboard fix)",
  approx(fr0[3], rq[0]) && approx(fr0[6], rq[3]), `got [${fr0.slice(3, 7).join(",")}]`);

console.log(`\nTree wind bbox-rig: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
