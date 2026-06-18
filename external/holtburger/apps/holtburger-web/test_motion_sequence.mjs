// test_motion_sequence.mjs — JS-side gate for the animation consolidation
// (docs/animation-audit/ANIMATION-AUDIT.md §5/§7).
//
// The motion AUTHORITY (CSequence/update_internal playhead: frame advance,
// node-split, one-shot completion, wrap) now lives in RUST
// (src/motion_sequence.rs) and is proven by `cargo test --lib motion_sequence`
// (Parts A+C parity + one-shot completion). This file gates the one piece that
// STAYS in JS: the dumb per-part poser `poseRigAt` (port of UpdateParts) —
//   A. Poser correctness — writes the EXACT authored keyframe (pos + root
//      motion, W-first→xyzw quat) at a given GLOBAL frame index. No three.js.
//   B. Mixer parity — at each authored frame, `poseRigAt(F)` is numerically
//      identical to a real THREE.AnimationMixer playing the buildAnimationClip
//      output (the production path). This is the shadow-mode invariant.
//
// Part B dynamic-imports `three` + animation.js (bare-specifier); if `three`
// can't be located it SKIPs (not fails) — Part A still fully gates the poser.

import { poseRigAt, unifiedMotionMode } from "./scene3d/motion/motion_sequence.js";

let passed = 0, failed = 0, skipped = 0;
function check(name, ok, detail) {
  const s = ok ? "PASS" : "FAIL";
  console.log(`  [${s}] ${name}${detail ? " — " + detail : ""}`);
  if (ok) passed += 1; else failed += 1;
}
const approx = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps;

// ---- synthetic anim data: 2 parts, 4 frames, 10fps (dt 0.1, dur 0.4) --------
const PART_COUNT = 2, NUM_FRAMES = 4, FR = 10, STRIDE = 7;
function nquat(a) { const h = a / 2; return [Math.cos(h), 0, 0, Math.sin(h)]; } // (w,x,y,z) about +Z
const partFrames = new Float32Array(NUM_FRAMES * PART_COUNT * STRIDE);
for (let f = 0; f < NUM_FRAMES; f += 1) {
  for (let p = 0; p < PART_COUNT; p += 1) {
    const base = (f * PART_COUNT + p) * STRIDE;
    partFrames[base + 0] = f * 10 + p; // x
    partFrames[base + 1] = f;          // y
    partFrames[base + 2] = p;          // z
    const [qw, qx, qy, qz] = nquat(f * 0.3 + p * 0.1);
    partFrames[base + 3] = qw;
    partFrames[base + 4] = qx;
    partFrames[base + 5] = qy;
    partFrames[base + 6] = qz;
  }
}
const posFrames = new Float32Array(NUM_FRAMES * 3);
for (let f = 0; f < NUM_FRAMES; f += 1) posFrames[f * 3 + 0] = f * 0.5; // x root motion
const animData = {
  partCount: PART_COUNT, numFrames: NUM_FRAMES, framerate: FR,
  partFrames, posFrames, duration: NUM_FRAMES / FR, // 0.4
};
// The JS-cached descriptor the poser reads (animation.js buildSequenceDescriptor
// shape — partFrames/posFrames/partCount/numFrames are the fields poseRigAt uses).
const desc = { partCount: PART_COUNT, numFrames: NUM_FRAMES, partFrames, posFrames };

function stubPart() {
  return {
    position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    quaternion: { x: 0, y: 0, z: 0, w: 1, set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; } },
  };
}

console.log("poseRigAt — JS poser test (sequence math is cargo-tested in Rust)");
console.log("=== Part A: poser correctness (exact authored keyframe) ===");

// poseRigAt writes the exact authored pose (pos + root motion + quat reorder)
// at an explicit GLOBAL frame index — no sequence/selection logic involved.
{
  const parts = [stubPart(), stubPart()];
  poseRigAt(1, desc, parts); // global frame 1
  // part0 @ frame1: pos (1*10+0, 1, 0) + root (0.5,0,0) = (10.5,1,0)
  const p0 = parts[0];
  check("poser part0 position (pos + root motion)",
    approx(p0.position.x, 10.5) && approx(p0.position.y, 1) && approx(p0.position.z, 0),
    `(${p0.position.x},${p0.position.y},${p0.position.z})`);
  const [qw, qx, qy, qz] = nquat(1 * 0.3 + 0 * 0.1);
  check("poser part0 quaternion (W-first→xyzw)",
    approx(p0.quaternion.x, qx) && approx(p0.quaternion.y, qy) && approx(p0.quaternion.z, qz) && approx(p0.quaternion.w, qw),
    `xyzw=(${p0.quaternion.x.toFixed(3)},${p0.quaternion.y.toFixed(3)},${p0.quaternion.z.toFixed(3)},${p0.quaternion.w.toFixed(3)})`);
  // part1 @ frame1: pos (1*10+1, 1, 1) + root = (11.5,1,1)
  const p1 = parts[1];
  check("poser part1 position",
    approx(p1.position.x, 11.5) && approx(p1.position.y, 1) && approx(p1.position.z, 1));
}

// Defensive clamp: an out-of-range global frame clamps to the last frame.
{
  const parts = [stubPart(), stubPart()];
  poseRigAt(99, desc, parts); // clamp to frame 3
  // part0 @ frame3: pos (3*10+0, 3, 0) + root (1.5,0,0) = (31.5,3,0)
  check("poser clamps OOB frame to last",
    approx(parts[0].position.x, 31.5) && approx(parts[0].position.y, 3),
    `(${parts[0].position.x},${parts[0].position.y})`);
}

// Flag parsing.
check("unifiedMotion default off", unifiedMotionMode("") === "off");
check("unifiedMotion=shadow parses", unifiedMotionMode("?unifiedMotion=shadow") === "shadow");
check("unifiedMotion=attack parses", unifiedMotionMode("?x=1&unifiedMotion=attack") === "attack");

// ---- Part B: real-mixer parity (skips if three not locatable) ----------------
console.log("=== Part B: parity vs real THREE.AnimationMixer ===");
let THREE, anim;
try {
  THREE = await import("three");
  anim = await import("./scene3d/animation.js");
} catch (e) {
  console.log(`  [SKIP] three/animation.js not importable: ${String(e.message).slice(0, 80)}`);
  skipped += 1;
}

if (THREE && anim) {
  const sdesc = anim.buildSequenceDescriptor(animData);
  check("buildSequenceDescriptor returns raw frames",
    !!sdesc && sdesc.numFrames === NUM_FRAMES && sdesc.partFrames.length === partFrames.length);

  const clip = anim.buildAnimationClip(animData, ["part_0", "part_1"]);
  check("buildAnimationClip produced a clip", !!clip);

  // Mixer rig.
  const root = new THREE.Object3D();
  const rigParts = [];
  for (let p = 0; p < PART_COUNT; p += 1) {
    const g = new THREE.Object3D(); g.name = `part_${p}`; root.add(g); rigParts.push(g);
  }
  const mixer = new THREE.AnimationMixer(root);
  const action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopRepeat, Infinity);
  action.play();

  // For each authored frame F, sample the mixer at the MID-WINDOW time
  // (F+0.5)/FR so the discrete pick is unambiguously frame F (sampling exactly
  // on a keyframe boundary hits three.js InterpolateDiscrete's off-by-one) and
  // the poser at the same frame F must match per part. The Rust playhead's
  // frame SELECTION over time is covered by the cargo parity tests; this gates
  // that poseRigAt(F) writes the same pose the production mixer clip does.
  const seqParts = [stubPart(), stubPart()];
  let maxErr = 0, allMatch = true;
  for (let F = 0; F < NUM_FRAMES; F += 1) {
    mixer.setTime((F + 0.5) / FR);
    poseRigAt(F, sdesc, seqParts);
    for (let p = 0; p < PART_COUNT; p += 1) {
      const m = rigParts[p], s = seqParts[p];
      const dp = Math.max(Math.abs(m.position.x - s.position.x), Math.abs(m.position.y - s.position.y), Math.abs(m.position.z - s.position.z));
      const dq = Math.max(Math.abs(m.quaternion.x - s.quaternion.x), Math.abs(m.quaternion.y - s.quaternion.y), Math.abs(m.quaternion.z - s.quaternion.z), Math.abs(m.quaternion.w - s.quaternion.w));
      maxErr = Math.max(maxErr, dp, dq);
      if (dp > 1e-4 || dq > 1e-4) { allMatch = false; }
    }
  }
  check(`mixer vs poser per-part parity over ${NUM_FRAMES} authored frames`, allMatch, `maxErr=${maxErr.toExponential(2)}`);
}

console.log("===========================================================");
console.log(`Result: ${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`);
console.log("===========================================================");
process.exit(failed > 0 ? 1 : 0);
