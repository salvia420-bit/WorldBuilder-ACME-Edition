// Tree wind (Phase 1) — synthetic clip generator unit test.
//
// buildTreeWindClip is the pure core that feeds buildSceneryAnimationClip. This
// locks: output layout, determinism (no Math.random), seamless loop, per-part
// phase divergence, amplitude scaling, rest-frame composition, and that the
// generated frames actually drive a THREE mixer.

import * as THREE from "three";
import { buildTreeWindClip } from "./scene3d/wind_rig.js";
import { buildSceneryAnimationClip } from "./scene3d/animated_scenery.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}
const approx = (a, b, e = 1e-6) => Math.abs(a - b) < e;

// ---- layout ----
const NP = 3, opts = { fps: 30, loopSeconds: 4 };
const { frames, numParts, numFrames, fps } = buildTreeWindClip(NP, null, opts);
check("numParts echoed", numParts === NP);
check("numFrames = fps*loop + 1 (period == duration)", numFrames === 30 * 4 + 1, `got ${numFrames}`);
check("frames length = numParts*numFrames*7", frames.length === NP * numFrames * 7, `got ${frames.length}`);
check("fps echoed", fps === 30);

// ---- determinism (no Math.random) ----
const a = buildTreeWindClip(NP, null, opts).frames;
const b = buildTreeWindClip(NP, null, opts).frames;
let identical = a.length === b.length;
for (let i = 0; i < a.length && identical; i++) if (a[i] !== b[i]) identical = false;
check("two calls byte-identical (deterministic)", identical);

// ---- seamless loop: frame[0] == frame[numFrames-1] per part ----
let seamMax = 0;
for (let p = 0; p < NP; p++) {
  for (let k = 0; k < 7; k++) {
    const v0 = frames[(0 * NP + p) * 7 + k];
    const vN = frames[((numFrames - 1) * NP + p) * 7 + k];
    seamMax = Math.max(seamMax, Math.abs(v0 - vN));
  }
}
check("loop seamless: frame0 == frame(N-1)", seamMax < 1e-5, `maxΔ=${seamMax}`);

// ---- per-part phase divergence (parts don't move in lockstep) ----
const qwP0 = frames[(5 * NP + 0) * 7 + 3];
const qwP1 = frames[(5 * NP + 1) * 7 + 3];
check("parts have distinct phase (qw differs at a mid frame)", !approx(qwP0, qwP1, 1e-4),
  `p0=${qwP0} p1=${qwP1}`);

// ---- amplitude scales with strength ----
function maxAngle(fr, np, nf) {
  let m = 0;
  for (let f = 0; f < nf; f++) for (let p = 0; p < np; p++) {
    const qw = fr[(f * np + p) * 7 + 3];
    m = Math.max(m, 2 * Math.acos(Math.min(1, Math.abs(qw)))); // angle from quat
  }
  return m;
}
const weak = buildTreeWindClip(NP, null, { ...opts, strength: 0.5 });
const strong = buildTreeWindClip(NP, null, { ...opts, strength: 2 });
check("higher strength → larger max sway angle",
  maxAngle(strong.frames, NP, numFrames) > maxAngle(weak.frames, NP, numFrames) * 2.5,
  `strong=${maxAngle(strong.frames, NP, numFrames).toFixed(4)} weak=${maxAngle(weak.frames, NP, numFrames).toFixed(4)}`);

// ---- strength 0 → identity motion = each part's REST frame ----
const restQ = [Math.cos(0.3), 0, 0, Math.sin(0.3)]; // a 0.6 rad Z-rotation rest
const rig = [{ pivot: { x: 0, y: 0, z: 0 }, weight: 1, rest: { o: { x: 1, y: 2, z: 3 }, q: restQ } }];
const z0 = buildTreeWindClip(1, rig, { ...opts, strength: 0 }).frames;
check("strength 0 preserves rest quat (wxyz)",
  approx(z0[3], restQ[0]) && approx(z0[4], restQ[1]) && approx(z0[5], restQ[2]) && approx(z0[6], restQ[3]),
  `got [${z0.slice(3, 7).join(",")}]`);
check("strength 0 preserves rest origin",
  approx(z0[0], 1) && approx(z0[1], 2) && approx(z0[2], 3), `got [${z0.slice(0, 3).join(",")}]`);

// ---- the generated frames drive a real mixer without throwing ----
const clip = buildSceneryAnimationClip(THREE, frames, NP, numFrames, fps);
let mixerOk = clip instanceof THREE.AnimationClip;
try {
  const root = new THREE.Group();
  for (let i = 0; i < NP; i++) { const g = new THREE.Group(); g.name = `part${i}`; root.add(g); }
  const mixer = new THREE.AnimationMixer(root);
  mixer.clipAction(clip).play();
  mixer.update(0.5);
  const p0 = root.getObjectByName("part0");
  mixerOk = mixerOk && !!p0 && Number.isFinite(p0.quaternion.x);
} catch (e) { mixerOk = false; console.log("    mixer err:", e.message); }
check("buildSceneryAnimationClip + mixer play the wind clip", mixerOk);

console.log(`\nTree wind clip-gen: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
