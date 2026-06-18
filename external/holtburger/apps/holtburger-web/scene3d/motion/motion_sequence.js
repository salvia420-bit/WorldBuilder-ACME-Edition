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
// dumb `CPartArray::UpdateParts` step (acclient.c:326624) — and the URL-flag
// parse (`unifiedMotionMode`). Rust hands JS one GLOBAL FRAME INDEX per entity
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
export function poseRigAt(globalFrame, desc, partGroups) {
  if (!desc || !partGroups) return;
  const { partFrames, partCount, posFrames, numFrames } = desc;
  if (!partFrames || !partCount) return;
  let f = globalFrame | 0;
  if (f < 0) f = 0;
  if (numFrames && f >= numFrames) f = numFrames - 1; // defensive clamp
  const rx = posFrames ? posFrames[f * 3 + 0] : 0;
  const ry = posFrames ? posFrames[f * 3 + 1] : 0;
  const rz = posFrames ? posFrames[f * 3 + 2] : 0;
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

// `?unifiedMotion` capability flag (docs/url-flags.md): off | shadow | per-class
// (attack/death/door/cast/locomotion) | on. Default off.
export function unifiedMotionMode(search) {
  try {
    const s =
      typeof search === "string"
        ? search
        : (typeof window !== "undefined" && window.location && window.location.search) || "";
    const v = new URLSearchParams(s).get("unifiedMotion");
    if (v == null) return "off";
    return String(v).toLowerCase();
  } catch (_) {
    return "off";
  }
}
