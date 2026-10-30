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
// dumb `CPartArray::UpdateParts` step (acclient.c:326624). (The
// `?unifiedMotion` gate is gone, 2026-10-05: this playhead is the only
// animation driver — the three.js AnimationMixer was retired.) Rust hands JS one GLOBAL FRAME INDEX per entity
// per frame; this poser indexes the JS-cached keyframe buffer at that frame.
//
// ?rustRig (2026-10-26, DEFAULT OFF, `=on` opts in): the per-part pose is
// computed in Rust (crates/holtburger-scene src/rig.rs, one wasm call per
// rig) and written without three's quaternion onChange (the Euler
// re-derivation) — scene3d/rust/rig.js, docs/2026-10-26-rust-rig.md. Same
// doubles as the JS body below (pinned bit for bit); anything the kernel
// cannot take falls through to that body.

import { rustRigEnabled, rustPoseRig } from "../rust/rig.js";

export const FLOATS_PER_PART_PER_FRAME = 7; // (x,y,z, qw,qx,qy,qz) — quat W-FIRST

let RUST_RIG = false;
try {
  RUST_RIG = rustRigEnabled();
} catch (_) { /* non-browser (test) context — JS poser */ }
/** Test seam: route poseRigAt through the Rust bridge (true) or the JS body. */
export function _setRustRigForTest(on) {
  RUST_RIG = !!on;
}

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

// ?inPlaceExact (2026-10-24, DEFAULT ON; `=off` restores the mean-drift
// subtraction below). The bake folds the clip's cumulative root motion (R, T)
// into every part (lib.rs fold_root_motion_into_parts) and now also ships that
// frame per keyframe (`desc.rootFrames`, [tx,ty,tz, qw,qx,qy,qz]). In place =
// undo exactly it: part = R⁻¹·(p − T), quat = R⁻¹·q — retail draws the raw part
// frames relative to the object (CPartArray::UpdateParts, acclient.c:326601)
// and moves the OBJECT by the root motion. The mean-of-all-parts subtraction
// also removed the authored body motion: on the human run (0x03000002) the
// planted foot sat 9-14 cm off the ground (authored 1-4 cm) and the 11 cm
// pelvis bob shrank to 3.6 cm, phase-inverted (live 1070 + DAT, 2026-10-24).
let IN_PLACE_EXACT = true;
try {
  const v = new URLSearchParams(globalThis.location.search).get("inPlaceExact")?.toLowerCase();
  IN_PLACE_EXACT = !(v === "off" || v === "0" || v === "false");
} catch (_) { /* non-browser (test) context — exact default */ }
/** Test seam. */
export function _setInPlaceExactForTest(on) {
  IN_PLACE_EXACT = !!on;
}

// The exact in-place pose for frame `f` from the folded root row. Returns
// false when the descriptor carries no root frames (older wasm) so the caller
// falls back to the mean-drift subtraction.
function poseInPlaceExact(f, desc, partGroups, n) {
  const rf = desc.rootFrames;
  const { partFrames, partCount, numFrames } = desc;
  if (!rf || rf.length !== numFrames * 7) return false;
  const r = f * 7;
  const tx = rf[r], ty = rf[r + 1], tz = rf[r + 2];
  // R⁻¹ = conj(R) for a unit quaternion (w-first).
  const iw = rf[r + 3], ix = -rf[r + 4], iy = -rf[r + 5], iz = -rf[r + 6];
  const ident = Math.abs(ix) < 1e-7 && Math.abs(iy) < 1e-7 && Math.abs(iz) < 1e-7;
  for (let p = 0; p < n; p += 1) {
    const g = partGroups[p];
    if (!g) continue;
    const base = (f * partCount + p) * FLOATS_PER_PART_PER_FRAME;
    let px = partFrames[base + 0] - tx, py = partFrames[base + 1] - ty, pz = partFrames[base + 2] - tz;
    let qw = partFrames[base + 3], qx = partFrames[base + 4], qy = partFrames[base + 5], qz = partFrames[base + 6];
    if (!ident) {
      // v' = v + 2w(u×v) + 2u×(u×v), u = (ix, iy, iz), w = iw.
      const cx = iy * pz - iz * py, cy = iz * px - ix * pz, cz = ix * py - iy * px;
      const ccx = iy * cz - iz * cy, ccy = iz * cx - ix * cz, ccz = ix * cy - iy * cx;
      px += 2 * (iw * cx + ccx); py += 2 * (iw * cy + ccy); pz += 2 * (iw * cz + ccz);
      // q' = R⁻¹ ⊗ q (Hamilton, w-first).
      const w2 = iw * qw - ix * qx - iy * qy - iz * qz;
      const x2 = iw * qx + ix * qw + iy * qz - iz * qy;
      const y2 = iw * qy - ix * qz + iy * qw + iz * qx;
      const z2 = iw * qz + ix * qy - iy * qx + iz * qw;
      qw = w2; qx = x2; qy = y2; qz = z2;
    }
    if (g.position && typeof g.position.set === "function") g.position.set(px, py, pz);
    if (g.quaternion && typeof g.quaternion.set === "function") g.quaternion.set(qx, qy, qz, qw);
  }
  return true;
}

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
  // ?rustRig: the same branch choice, made here, handed to the kernel (2 =
  // exact in place, falling back to mean drift without root frames, as below).
  if (RUST_RIG && rustPoseRig(desc, f, inPlace && !RENDER_ROOT_MOTION ? (IN_PLACE_EXACT ? 2 : 1) : 0,
      partGroups, Math.min(partCount, partGroups.length))) {
    return;
  }
  if (inPlace && !RENDER_ROOT_MOTION && IN_PLACE_EXACT &&
      poseInPlaceExact(f, desc, partGroups, Math.min(partCount, partGroups.length))) {
    return;
  }
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
