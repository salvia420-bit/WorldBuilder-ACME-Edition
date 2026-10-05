// scene3d/motion/motion_sequence.js
//
// Animation consolidation (docs/animation-audit/ANIMATION-AUDIT.md §5).
//
// The motion AUTHORITY — the `CSequence`/`update_internal` playhead — now
// lives in RUST (src/motion_sequence.rs, exported as the wasm `MotionSequence`
// class: `MotionSequence.fromDescriptor(...)`, `advance(dt)`, `globalFrameIndex`,
// `done`). This decision (audit §8 Q1 → Rust) keeps ALL sequence math (frame
// advance, node-split, one-shot completion, wrap-to-cycle) in one cargo-tested
// place instead of a JS re-implementation.
//
// What CANNOT move to Rust, and so stays here: the per-part POSE WRITE
// (`poseRigAt`) — it touches `THREE.Object3D` `.position`/`.quaternion`, the
// dumb `CPartArray::UpdateParts` step (acclient.c:326624). (The `?unifiedMotion`
// flag is parsed by entities.js `UNIFIED_MODE` — the only reader; the unused
// `unifiedMotionMode()` here was deleted 2026-10-05: it returned "off" by default,
// contradicting the shipped reader.) Rust hands JS one GLOBAL FRAME INDEX per entity
// per frame; this poser indexes the JS-cached keyframe buffer at that frame.

export const FLOATS_PER_PART_PER_FRAME = 7; // (x,y,z, qw,qx,qy,qz) — quat W-FIRST

// The dumb poser — port of CPartArray::UpdateParts (acclient.c:326601-326624).
// Writes each part's ABSOLUTE model-space pose (pos + per-frame root motion;
// quat W-FIRST → xyzw) at the GLOBAL frame index `f` (already includes the
// active node's frameOffset — the Rust `MotionSequence.globalFrameIndex`).
// `desc` is the JS-cached sequence descriptor (animation.js buildSequenceDescriptor):
// `{ partFrames, posFrames, partCount, numFrames }`. Reads the shared buffer
// directly — no weights, no blend. Mirrors buildAnimationClip's InterpolateDiscrete
// sampling, so it is numerically identical to the mixer at the same frame.
// `?renderRootMotion=on` keeps the raw baked locomotion stride (A/B escape,
// same flag animation.js buildAnimationClip reads).
let RENDER_ROOT_MOTION = false;
try {
  RENDER_ROOT_MOTION =
    new URLSearchParams(globalThis.location.search).get("renderRootMotion") === "on";
} catch (_) { /* non-browser (test) context — in-place default */ }

// Per-frame COMMON translation of all parts relative to frame 0, cached on the
// descriptor. Locomotion cycles bake the forward stride into the skeleton
// (every part moves ~uniformly forward per frame), while the body position is
// integrator-driven — so drawn raw, the model strides ahead of its root and
// snaps back every cycle (the "jut back while running"). Subtracting this is
// exactly buildAnimationClip's in-place fix (B1-render v2), which the mixer
// path had and the unified poser lacked.
function inPlaceDisplacement(desc) {
  if (desc._inPlaceDisp) return desc._inPlaceDisp;
  const { partFrames, partCount, numFrames } = desc;
  const disp = new Float32Array(numFrames * 3);
  if (partCount > 0 && numFrames > 0) {
    let c0x = 0, c0y = 0, c0z = 0;
    for (let p = 0; p < partCount; p += 1) {
      const b = p * FLOATS_PER_PART_PER_FRAME;
      c0x += partFrames[b]; c0y += partFrames[b + 1]; c0z += partFrames[b + 2];
    }
    c0x /= partCount; c0y /= partCount; c0z /= partCount;
    for (let f = 0; f < numFrames; f += 1) {
      let cx = 0, cy = 0, cz = 0;
      for (let p = 0; p < partCount; p += 1) {
        const b = (f * partCount + p) * FLOATS_PER_PART_PER_FRAME;
        cx += partFrames[b]; cy += partFrames[b + 1]; cz += partFrames[b + 2];
      }
      disp[f * 3 + 0] = cx / partCount - c0x;
      disp[f * 3 + 1] = cy / partCount - c0y;
      disp[f * 3 + 2] = cz / partCount - c0z;
    }
  }
  desc._inPlaceDisp = disp;
  return disp;
}

// `inPlace` (locomotion cycles): play the cycle in place like the mixer clip
// did — subtract the common stride drift and skip posFrames root motion.
// One-shots (attacks, deaths, links) keep their raw authored motion.
export function poseRigAt(globalFrame, desc, partGroups, inPlace = false) {
  if (!desc || !partGroups) return;
  const { partFrames, partCount, posFrames, numFrames } = desc;
  if (!partFrames || !partCount) return;
  let f = globalFrame | 0;
  if (f < 0) f = 0;
  if (numFrames && f >= numFrames) f = numFrames - 1; // defensive clamp
  let rx, ry, rz;
  if (inPlace && !RENDER_ROOT_MOTION) {
    const d = inPlaceDisplacement(desc);
    rx = -d[f * 3 + 0]; ry = -d[f * 3 + 1]; rz = -d[f * 3 + 2];
  } else {
    rx = posFrames ? posFrames[f * 3 + 0] : 0;
    ry = posFrames ? posFrames[f * 3 + 1] : 0;
    rz = posFrames ? posFrames[f * 3 + 2] : 0;
  }
  const n = Math.min(partCount, partGroups.length); // CLAMP (retail :326616-617)
  for (let p = 0; p < n; p += 1) {
    const g = partGroups[p];
    if (!g) continue;
    const base = (f * partCount + p) * FLOATS_PER_PART_PER_FRAME;
    if (g.position && typeof g.position.set === "function") {
      g.position.set(partFrames[base + 0] + rx, partFrames[base + 1] + ry, partFrames[base + 2] + rz);
    }
    if (g.quaternion && typeof g.quaternion.set === "function") {
      g.quaternion.set(partFrames[base + 4], partFrames[base + 5], partFrames[base + 6], partFrames[base + 3]);
    }
  }
}
