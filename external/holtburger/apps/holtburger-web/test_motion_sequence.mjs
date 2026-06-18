// test_motion_sequence.mjs — Step 0 gate for the animation consolidation
// (docs/animation-audit/ANIMATION-AUDIT.md §5/§7).
//
// Proves the new MotionSequence + dumb poser (scene3d/motion/motion_sequence.js):
//   A. Pure-logic — advance() crosses frames at the right rate + wraps to
//      firstCyclic; the poser writes the EXACT authored keyframe (pos + root
//      motion, W-first→xyzw quat). No three.js needed.
//   B. Mixer parity — for a pure cyclic clip, the sequence poser is numerically
//      identical to the production path (a real THREE.AnimationMixer playing the
//      buildAnimationClip output). This is the shadow-mode invariant that lets a
//      later step switch entities off the mixer with confidence.
//
// Part B dynamic-imports `three` + animation.js (bare-specifier); if `three`
// can't be located it SKIPs (not fails) — Part A still fully gates the port.

import {
  sequenceFromAnimationData,
  chainOneShotThenCycle,
  poseRig,
  unifiedMotionMode,
} from "./scene3d/motion/motion_sequence.js";

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

function stubPart() {
  return {
    position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    quaternion: { x: 0, y: 0, z: 0, w: 1, set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; } },
  };
}

console.log("Step 0 — MotionSequence + poser test");
console.log("=== Part A: pure-logic correctness ===");

// Frame progression + wrap (single cyclic node).
{
  const seq = sequenceFromAnimationData(animData);
  check("descriptor → sequence built", !!seq && seq.nodes.length === 1);
  seq.reset();
  check("reset → frame 0", seq.currentFrameIndex() === 0);
  seq.advance(0.05); check("t=0.05 → frame 0", seq.currentFrameIndex() === 0, `f=${seq.currentFrameIndex()}`);
  seq.advance(0.10); check("t=0.15 → frame 1", seq.currentFrameIndex() === 1, `f=${seq.currentFrameIndex()}`);
  seq.advance(0.20); check("t=0.35 → frame 3", seq.currentFrameIndex() === 3, `f=${seq.currentFrameIndex()}`);
  seq.advance(0.10); check("t=0.45 → wraps to frame 0", seq.currentFrameIndex() === 0, `f=${seq.currentFrameIndex()}`);
  // Huge dt folds modulo duration (no runaway loop).
  seq.reset(); seq.advance(100.07); // 100.07 % 0.4 = 0.07 → frame 0
  check("huge dt folds modulo duration", seq.currentFrameIndex() === 0, `f=${seq.currentFrameIndex()}`);
}

// Poser writes exact authored pose (pos + root motion + quat reorder).
{
  const seq = sequenceFromAnimationData(animData);
  seq.reset(); seq.advance(0.15); // frame 1
  const parts = [stubPart(), stubPart()];
  poseRig(seq, parts);
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
  const desc = anim.buildSequenceDescriptor(animData);
  check("buildSequenceDescriptor returns raw frames", !!desc && desc.numFrames === NUM_FRAMES && desc.partFrames.length === partFrames.length);

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

  // Sequence rig (stubs) + sequence.
  const seqParts = [stubPart(), stubPart()];
  const seq = sequenceFromAnimationData(desc);

  // Sample mid-frame times across >1 loop; compare per-part pose.
  const samples = [0.005, 0.03, 0.07, 0.12, 0.18, 0.26, 0.33, 0.39, 0.41, 0.47, 0.55, 0.78, 0.83];
  let maxErr = 0, allMatch = true;
  for (const t of samples) {
    mixer.setTime(t);                 // absolute: resets to 0, advances t (wraps via LoopRepeat)
    seq.reset(); seq.advance(t);
    poseRig(seq, seqParts);
    for (let p = 0; p < PART_COUNT; p += 1) {
      const m = rigParts[p], s = seqParts[p];
      const dp = Math.max(Math.abs(m.position.x - s.position.x), Math.abs(m.position.y - s.position.y), Math.abs(m.position.z - s.position.z));
      const dq = Math.max(Math.abs(m.quaternion.x - s.quaternion.x), Math.abs(m.quaternion.y - s.quaternion.y), Math.abs(m.quaternion.z - s.quaternion.z), Math.abs(m.quaternion.w - s.quaternion.w));
      maxErr = Math.max(maxErr, dp, dq);
      if (dp > 1e-4 || dq > 1e-4) { allMatch = false; }
    }
  }
  check(`mixer vs sequence per-part parity over ${samples.length} sample times`, allMatch, `maxErr=${maxErr.toExponential(2)}`);
}

// ---- Part C: multi-node node-split parity (the Step-1 descriptor) ------------
// A node-split bake (one MotionNode per AnimData segment, windows into the SHARED
// buffer) must reproduce the single concatenated node's frame + pose at every
// time, including across the loop wrap. This proves the wasm segment descriptor
// (segmentStarts/Counts) is faithful end-to-end: Rust segments → JS nodes → pose.
console.log("=== Part C: multi-node (segment-split) parity ===");
{
  const F = 4, P = 2;
  const pf = new Float32Array(F * P * 7);
  for (let f = 0; f < F; f += 1) {
    for (let p = 0; p < P; p += 1) {
      const b = (f * P + p) * 7;
      pf[b + 0] = f * 7 + p; pf[b + 1] = f; pf[b + 2] = p;
      const [qw, qx, qy, qz] = nquat(f * 0.25 + p * 0.13);
      pf[b + 3] = qw; pf[b + 4] = qx; pf[b + 5] = qy; pf[b + 6] = qz;
    }
  }
  // Cumulative times for a 2-segment bake: seg0 frames 0,1 @ 10fps (dt .1);
  // seg1 frames 2,3 @ 5fps (dt .2). Matches build_concatenated_motion_frames.
  const ftimes = Float32Array.from([0, 0.1, 0.2, 0.4]);
  const dur = 0.6;
  const descNoSeg = { partCount: P, numFrames: F, framerate: 10, partFrames: pf, frameTimes: ftimes, duration: dur };
  const descSeg = {
    ...descNoSeg,
    segmentStarts: Uint32Array.from([0, 2]),
    segmentCounts: Uint32Array.from([2, 2]),
    segmentFramerates: Float32Array.from([10, 5]),
  };
  const single = sequenceFromAnimationData(descNoSeg);
  const multi = sequenceFromAnimationData(descSeg);
  check("single-segment desc → 1 node", single.nodes.length === 1, `nodes=${single.nodes.length}`);
  check("segment desc → 2 nodes", multi.nodes.length === 2, `nodes=${multi.nodes.length}`);

  const rigA = [stubPart(), stubPart()];
  const rigB = [stubPart(), stubPart()];
  const samples = [0.0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.39, 0.45, 0.55, 0.6, 0.65, 1.27];
  let allMatch = true, maxErr = 0;
  for (const t of samples) {
    single.reset().advance(t); poseRig(single, rigA);
    multi.reset().advance(t); poseRig(multi, rigB);
    for (let p = 0; p < P; p += 1) {
      const dp = Math.max(Math.abs(rigA[p].position.x - rigB[p].position.x), Math.abs(rigA[p].position.y - rigB[p].position.y), Math.abs(rigA[p].position.z - rigB[p].position.z));
      const dq = Math.max(Math.abs(rigA[p].quaternion.x - rigB[p].quaternion.x), Math.abs(rigA[p].quaternion.y - rigB[p].quaternion.y), Math.abs(rigA[p].quaternion.z - rigB[p].quaternion.z), Math.abs(rigA[p].quaternion.w - rigB[p].quaternion.w));
      maxErr = Math.max(maxErr, dp, dq);
      if (dp > 1e-6 || dq > 1e-6) allMatch = false;
    }
  }
  check(`node-split === concatenated pose over ${samples.length} times (+wrap)`, allMatch, `maxErr=${maxErr.toExponential(2)}`);

  // chainOneShotThenCycle: link (one-shot) before cycle, firstCyclic at the boundary.
  const linkSeq = sequenceFromAnimationData(descNoSeg, { cyclic: false });
  const cycleSeq = sequenceFromAnimationData(descNoSeg);
  const chained = chainOneShotThenCycle(linkSeq, cycleSeq);
  check("chainOneShotThenCycle: 2 nodes, firstCyclic=1, link non-cyclic",
    chained.nodes.length === 2 && chained.firstCyclicIndex === 1 && chained.nodes[0].cyclic === false && chained.nodes[1].cyclic === true);
}

console.log("===========================================================");
console.log(`Result: ${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`);
console.log("===========================================================");
process.exit(failed > 0 ? 1 : 0);
