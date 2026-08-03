// Task #7 — animated scenery (flags/foliage): clip-builder unit test.
//
// buildSceneryAnimationClip is the novel, pure core: it converts the flat
// fetchAnimation bundle (per-(frame,part) [origin xyz, quat wxyz]) into a
// THREE.AnimationClip with per-part position + quaternion KeyframeTracks
// (reordering AC wxyz → THREE xyzw). The node-builder + bake wiring need the
// wasm rebuild + a 1070 visual A/B; this locks the clip math.

import * as THREE from "three";
import { buildSceneryAnimationClip } from "./scene3d/animated_scenery.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}
const approx = (a, b) => Math.abs(a - b) < 1e-6;

// numParts=2, numFrames=3, fps=30. Frame-major then part-major, 7 floats each.
const numParts = 2, numFrames = 3, fps = 30;
const frames = new Float32Array(numParts * numFrames * 3 * 0 + numParts * numFrames * 7);
function setFrame(f, p, ox, oy, oz, qw, qx, qy, qz) {
  const b = (f * numParts + p) * 7;
  frames[b] = ox; frames[b + 1] = oy; frames[b + 2] = oz;
  frames[b + 3] = qw; frames[b + 4] = qx; frames[b + 5] = qy; frames[b + 6] = qz;
}
// part 0 — moves in +x, identity rotation
setFrame(0, 0, 1, 0, 0, 1, 0, 0, 0);
setFrame(1, 0, 2, 0, 0, 1, 0, 0, 0);
setFrame(2, 0, 3, 0, 0, 1, 0, 0, 0);
// part 1 — fixed origin, rotating quat (distinct wxyz to prove reorder)
setFrame(0, 1, 9, 8, 7, 0.1, 0.2, 0.3, 0.4);
setFrame(1, 1, 9, 8, 7, 0.5, 0.6, 0.7, 0.8);
setFrame(2, 1, 9, 8, 7, 0.11, 0.22, 0.33, 0.44);

const clip = buildSceneryAnimationClip(THREE, frames, numParts, numFrames, fps);

check("returns a THREE.AnimationClip", clip instanceof THREE.AnimationClip);
check("4 tracks (2 parts × position+quaternion)", clip.tracks.length === 4,
  `got ${clip.tracks.length}`);
// Default = closedLoop: the SYNTHETIC wind clip repeats frame 0 as its closing
// frame (wind_rig.js), so its period is (numFrames-1)/fps.
check("duration = (numFrames-1)/fps", approx(clip.duration, 2 / 30),
  `got ${clip.duration}`);
// closedLoop:false = a DAT 0x03 Animation — n frames each held 1/fps, no
// duplicated closing frame, so the loop is numFrames/fps (matches the
// entity-side builder in animation.js).
const openClip = buildSceneryAnimationClip(
  THREE, frames, numParts, numFrames, fps, { closedLoop: false });
check("closedLoop:false duration = numFrames/fps", approx(openClip.duration, 3 / 30),
  `got ${openClip.duration}`);
check("closedLoop:false keeps the same tracks/times", openClip.tracks.length === 4 &&
  approx(openClip.tracks[0].times[2], 2 / 30));

const byName = Object.fromEntries(clip.tracks.map((t) => [t.name, t]));
check("track names part0/part1 .position/.quaternion",
  ["part0.position", "part0.quaternion", "part1.position", "part1.quaternion"]
    .every((n) => byName[n]));

const p0pos = byName["part0.position"];
check("part0.position times = [0, 1/30, 2/30]",
  approx(p0pos.times[0], 0) && approx(p0pos.times[1], 1 / 30) && approx(p0pos.times[2], 2 / 30));
check("part0.position x ramps 1→2→3",
  approx(p0pos.values[0], 1) && approx(p0pos.values[3], 2) && approx(p0pos.values[6], 3),
  `got ${p0pos.values[0]},${p0pos.values[3]},${p0pos.values[6]}`);

// Quaternion reorder: input wxyz (0.1,0.2,0.3,0.4) → track xyzw (0.2,0.3,0.4,0.1)
const p1q = byName["part1.quaternion"];
check("part1.quaternion frame0 reordered AC wxyz→THREE xyzw",
  approx(p1q.values[0], 0.2) && approx(p1q.values[1], 0.3) &&
  approx(p1q.values[2], 0.4) && approx(p1q.values[3], 0.1),
  `got [${p1q.values.slice(0, 4).join(",")}]`);
check("part1.quaternion frame1 reordered",
  approx(p1q.values[4], 0.6) && approx(p1q.values[5], 0.7) &&
  approx(p1q.values[6], 0.8) && approx(p1q.values[7], 0.5));
check("part1.position is the fixed (9,8,7) each frame",
  approx(byName["part1.position"].values[0], 9) &&
  approx(byName["part1.position"].values[3], 9) &&
  approx(byName["part1.position"].values[7], 8));

// Degenerate inputs → null (soft-degrade to frozen)
check("numFrames=0 → null", buildSceneryAnimationClip(THREE, frames, numParts, 0, fps) === null);
check("numParts=0 → null", buildSceneryAnimationClip(THREE, frames, 0, numFrames, fps) === null);
check("short frames buffer → null",
  buildSceneryAnimationClip(THREE, new Float32Array(3), numParts, numFrames, fps) === null);
check("null frames → null", buildSceneryAnimationClip(THREE, null, numParts, numFrames, fps) === null);

// Mixer can actually play it (binds the part names without throwing).
const root = new THREE.Group();
for (let i = 0; i < numParts; i++) { const g = new THREE.Group(); g.name = `part${i}`; root.add(g); }
let mixerOk = true;
try {
  const mixer = new THREE.AnimationMixer(root);
  mixer.clipAction(clip).play();
  mixer.update(1 / 30);
  // part0 should have advanced toward x≈2 at t=1/30 (frame 1).
  const part0 = root.getObjectByName("part0");
  mixerOk = part0 && approx(part0.position.x, 2);
} catch (e) { mixerOk = false; console.log("    mixer err:", e.message); }
check("mixer plays clip + drives part0.position.x to 2 at t=1/30", mixerOk);

console.log(`\nAnimated scenery clip-builder: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
