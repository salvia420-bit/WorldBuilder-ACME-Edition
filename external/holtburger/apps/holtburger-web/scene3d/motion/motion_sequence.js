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
// ?rustRig (2026-10-26, DEFAULT ON since that day, `=off` escape): the
// per-part pose is computed in Rust (crates/holtburger-scene src/rig.rs, one
// wasm call per rig) and written without three's quaternion onChange (the
// Euler re-derivation) — scene3d/rust/rig.js, docs/2026-10-26-rust-rig.md.
// Same doubles as the JS body below (pinned bit for bit); anything the kernel
// cannot take falls through to that body.
//
// ?rigPoseSkip (round 3 R3-2, 2026-10-30; DEFAULT OFF, `=on` opts in): skip
// re-posing a rig whose pose cannot have changed. Retail poses whole keyframes
// (CSequence::get_curr_animframe takes `_floor(frame_number)`,
// acclient.c:339745-339758) and so do we (`f = globalFrame | 0` below), so at
// display rates above an animation's DAT framerate most calls re-write the
// pose the rig already holds. See `poseRigSkipping` for the key and why it is
// exact.

import { rustRigEnabled, rustPoseRig } from "../rust/rig.js";
import { rustFlag } from "../rust/scene_core.js";

export const FLOATS_PER_PART_PER_FRAME = 7; // (x,y,z, qw,qx,qy,qz) — quat W-FIRST

let RUST_RIG = false;
try {
  RUST_RIG = rustRigEnabled();
} catch (_) { /* non-browser (test) context — JS poser */ }
/** Test seam: route poseRigAt through the Rust bridge (true) or the JS body. */
export function _setRustRigForTest(on) {
  RUST_RIG = !!on;
}

// ?rigPoseSkip — read once (`_setRigPoseSkipForTest` overrides).
let RIG_POSE_SKIP = false;
try {
  RIG_POSE_SKIP = rustFlag("rigPoseSkip", false) === true;
} catch (_) { /* non-browser (test) context — always pose */ }
/** `?rigPoseSkip` as this module reads it. */
export function rigPoseSkipEnabled() {
  return RIG_POSE_SKIP;
}
/** Test seam: force `?rigPoseSkip` on / off. */
export function _setRigPoseSkipForTest(on) {
  RIG_POSE_SKIP = !!on;
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
  if (RIG_POSE_SKIP) {
    poseRigSkipping(f, desc, partGroups, inPlace, partFrames, partCount, posFrames, numFrames);
    return;
  }
  posePartsAt(f, desc, partGroups, inPlace, partFrames, partCount, posFrames, RUST_RIG);
}

// poseRigAt's writes at the floored, clamped frame `f` (the flag-off body,
// shared by ?rigPoseSkip when it has to pose). `tryRust` offers the rig to the
// kernel first (flag off: ?rustRig). Returns the route actually taken: true
// when the kernel posed it, false when the JS body below did.
function posePartsAt(f, desc, partGroups, inPlace, partFrames, partCount, posFrames, tryRust) {
  // ?rustRig: the same branch choice, made here, handed to the kernel (2 =
  // exact in place, falling back to mean drift without root frames, as below).
  if (tryRust && rustPoseRig(desc, f, inPlace && !RENDER_ROOT_MOTION ? (IN_PLACE_EXACT ? 2 : 1) : 0,
      partGroups, Math.min(partCount, partGroups.length))) {
    return true;
  }
  if (inPlace && !RENDER_ROOT_MOTION && IN_PLACE_EXACT &&
      poseInPlaceExact(f, desc, partGroups, Math.min(partCount, partGroups.length))) {
    return false;
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
  return false;
}

// ---------------------------------------------------------------------------
// ?rigPoseSkip (R3-2; DEFAULT OFF) — skip the pose a rig already holds.
//
// A rig (one part array: EntityInstance.parts, one per entity, never replaced)
// skips its pose when BOTH hold.
//
// 1. THE KEY is unchanged. poseRigAt's stores are a pure function of:
//    - `f`, floored and clamped, and the branch `mode` (0 raw + posFrames, 1 in
//      place by mean drift, 2 in place exact) = inPlace x ?renderRootMotion x
//      ?inPlaceExact;
//    - the descriptor object (the mean-drift cache `_inPlaceDisp` lives on it)
//      and the five fields the poser and the Rust registration read:
//      partFrames, posFrames, rootFrames, partCount, numFrames. Buffers count
//      by identity: nothing writes into them after build, the contract
//      scene3d/rust/rig.js already registers them under;
//    - WHICH object fills each slot p < n = min(partCount, partGroups.length).
//      A slot past the last pose's n reads as empty, so a longer array with a
//      new part re-poses and a shorter one stores nothing new: n itself needs
//      no entry;
//    - the ROUTE the last pose actually TOOK, not the ?rustRig flag: the
//      kernel (raw stores, `part.rotation` not re-derived) or the JS body (the
//      setters, which re-derive it from the quaternion). The two store the same
//      doubles (pinned bit for bit) and differ only in that Euler. After a JS
//      body pose the Euler already comes from this quaternion, so either route
//      would store only what is there. After a KERNEL pose the call skips only
//      when it would take the kernel too. ?rustRig off says it would not. With
//      it on, the bridge can still decline a rig it took before: the
//      descriptor's registration was evicted and does not come back, or
//      SceneRigs.pose throws or returns a short count.
//    Same key => poseRigAt would store exactly what it stored last time.
//
//    THE ROUTE PROBE (?rustRig on). Whether the bridge takes a call depends on
//    the bridge's own state: which descriptors are registered, and the LRU
//    order its float cap evicts by. Flag-off asks it on every call, so every
//    would-be skip asks it too, whichever route posed last: `rustPoseRig`
//    with n = 1 (0 when n is 0) into an EMPTY part array. It (re-)registers
//    the descriptor, evicts and stamps the LRU as the flag-off call would,
//    runs the kernel on one part at this frame and mode, and stores into no
//    part. For a registered descriptor the kernel's pose returns
//    min(n, partCount) and its output holds every part of the largest one,
//    so it takes one part exactly when it takes n. Each skip thus makes the one
//    bridge call flag-off makes, and the bridge state cannot drift from
//    flag-off's. (Probing only after a kernel pose let it drift: a rig the JS
//    body posed last skipped its call, so under the cap a descriptor stayed
//    registered that flag-off had evicted, and a refused re-registration
//    later declined a call in flag-off only.)
//    - Taken: skip (the kernel would store what is there).
//    - Declined after a JS body pose: skip (the JS body would store and
//      re-derive only what is there).
//    - Declined after a kernel pose: pose through the JS body, with no second
//      bridge call, as flag-off does after a declined call.
//    ?rustRig off: no probe; flag-off makes no bridge call either.
//    Cost, node, 100 rigs x 17 parts, flag-off -> skip on with the frame
//    unchanged: kernel route ~88-115 -> ~30 us/frame (~0.15 us a probe); a
//    descriptor the bridge declines (the JS body poses it) ~280-340 -> ~16
//    (its probe is a ~0.02-0.03 us lookup; ~14 without it).
//
// 2. NOTHING ELSE WROTE THE PARTS since that pose. Other writers touch the same
//    fields between two poses: the jump-pose tween, the limp and its restore
//    (limbs.js), the ragdoll and the frozen corpse pose, the held-item grip pose
//    (`_applyChildPlacementFrames`), tests. Two mechanisms see them:
//    - WRITTEN: a hook on each part's quaternion and Euler change callbacks
//      (installed, under the flag only, the first time a slot shows the part).
//      Every three.js quaternion mutator fires that callback (set, copy, slerp,
//      setFrom*, multiply, Object3D.copy / applyMatrix4 / lookAt ...), and an
//      Euler write reaches the quaternion only through the Euler's. Raw
//      `_x/_y/_z/_w` stores bypass it; the only ones on entity parts are this
//      pose's own Rust route (scene3d/rust/rig.js). Every writer listed above
//      writes the quaternion through three, so the hook sees each of them;
//    - ANNOUNCED: `invalidateRigPose(parts)`, for a writer that stores
//      POSITIONS ONLY (no callback exists for a Vector3). The one today is
//      applyRagdoll's unswung parts; entities.js announces after its ragdoll
//      block. A NEW writer that moves rig-part positions without writing their
//      quaternions must announce too (docs: url-flags `rigPoseSkip`).
//    Then every store poseRigAt would make writes the value already there, so
//    skipping them leaves each position and quaternion, and so every matrix
//    three composes, bit-identical. (Re-reading the parts instead costs as
//    much as the Rust route's stores — node: 19-28 vs 21 ns a part — and
//    took the gain.) `window.__rigPoseSkip.verify(true)` adds that re-read as
//    a check: a would-be skip whose parts differ from the last pose counts a
//    `violation` and poses.
//
// A changed key field or slot, or a written / announced rig, runs the full pose
// (the flag-off code above). What a skip leaves out (nothing reads these): the
// bridge's `partsRaw` count and its output scratch beyond part 0; after a JS
// body pose, the JS body's re-derivation of `part.rotation`, which was derived
// from this same quaternion (any later quaternion or Euler write marks the
// rig). The bridge's registrations, evictions, LRU stamps and other counters
// see the same calls as flag-off's. A part
// that is not a three.js Object3D with a Quaternion and an Euler (test stubs,
// setter semantics), or one already hooked for another rig, makes its rig pose
// every call. The root transform is not poseRigAt's: it updates as before.
// Flag off: none of this runs, no hook or record exists.
// ---------------------------------------------------------------------------

const _skipRecs = new WeakMap(); // part array -> record
const _hookOwner = new WeakMap(); // part Object3D -> the record its hooks mark
const UNHOOKABLE = Object.freeze({}); // slot marker: never equals a part
const NO_PARTS = Object.freeze([]); // the route probe's part array: the bridge stores into none
let _verify = false;
const _skipStats = {
  posed: 0, // calls that ran the pose
  skipped: 0, // calls that skipped it
  keyChanged: 0, // posed: a key field differed (or the rig's first pose)
  written: 0, // posed: same key, the rig was written (hook) or announced
  slotChanged: 0, // posed: same key, a slot holds another object
  probed: 0, // would-be skips on ?rustRig that asked the bridge for this call's route
  routeChanged: 0, // posed: same key, the kernel posed last and this call takes the JS body
  hooked: 0, // parts given the change hooks
  unhookable: 0, // slots that keep their rig posing every call
  verified: 0, // verify mode: would-be skips re-read
  violations: 0, // verify mode: ... whose parts did not hold the last pose
};

// Test seam for the mutation checks (tests/rig_pose_skip.test.mjs): drop ONE
// key field. Production never sets it; each `||` is reached only when that
// field differs, the writer checks only when a write happens.
const K_F = 1, K_MODE = 2, K_DESC = 4, K_PF = 8, K_POS = 16, K_RF = 32, K_PC = 64,
  K_NF = 128, K_ROUTE = 256, K_SLOTS = 512, K_WRITTEN = 1024, K_ANNOUNCED = 2048;
const _KNOCK_FIELDS = {
  f: K_F, mode: K_MODE, desc: K_DESC, partFrames: K_PF, posFrames: K_POS, rootFrames: K_RF,
  partCount: K_PC, numFrames: K_NF, route: K_ROUTE, slots: K_SLOTS, written: K_WRITTEN,
  announced: K_ANNOUNCED,
};
let _knock = 0;
/** Test seam: drop one key field from the comparison (`null` restores it). */
export function _setRigPoseSkipKnockoutForTest(field) {
  if (field == null) { _knock = 0; return; }
  const k = _KNOCK_FIELDS[field];
  if (!k) throw new Error(`rigPoseSkip: unknown key field ${field}`);
  _knock = k;
}
/** The key fields the knockout seam accepts (tests enumerate them). */
export const RIG_POSE_SKIP_KEY_FIELDS = Object.freeze(Object.keys(_KNOCK_FIELDS));

/** Diag snapshot (`window.__rigPoseSkip.stats()`). */
export function rigPoseSkipStats() {
  return { enabled: RIG_POSE_SKIP, verify: _verify, ..._skipStats };
}
/** Verify mode (diag / tests): re-read every would-be skip; returns the mode. */
export function rigPoseSkipVerify(on) {
  if (on !== undefined) _verify = !!on;
  return _verify;
}
/** Test seam: zero the counters. */
export function _resetRigPoseSkipStatsForTest() {
  for (const k of Object.keys(_skipStats)) _skipStats[k] = 0;
}

/**
 * ?rigPoseSkip: a writer that stored rig-part positions WITHOUT writing their
 * quaternions announces it here (a quaternion / Euler write is seen by the
 * hooks), so the next poseRigAt on `parts` poses. No-op with the flag off: no
 * record exists for any part array.
 * @param {Array<object>} parts  the part array poseRigAt is given (inst.parts).
 */
export function invalidateRigPose(parts) {
  if (!parts) return;
  const rec = _skipRecs.get(parts);
  if (rec !== undefined && (_knock & K_ANNOUNCED) === 0) rec.dirty = true;
}

function poseRigSkipping(f, desc, partGroups, inPlace, partFrames, partCount, posFrames, numFrames) {
  const n = Math.min(partCount, partGroups.length);
  const mode = inPlace && !RENDER_ROOT_MOTION ? (IN_PLACE_EXACT ? 2 : 1) : 0;
  const rootFrames = desc.rootFrames;
  // Whether the pose below offers the rig to the kernel: ?rustRig, unless the
  // bridge already declined this call (the route probe).
  let tryRust = RUST_RIG;
  let rec = _skipRecs.get(partGroups);
  if (rec !== undefined) {
    if (
      rec.ok === true &&
      (rec.f === f || (_knock & K_F) !== 0) &&
      (rec.desc === desc || (_knock & K_DESC) !== 0) &&
      (rec.mode === mode || (_knock & K_MODE) !== 0) &&
      (rec.pf === partFrames || (_knock & K_PF) !== 0) &&
      (rec.pos === posFrames || (_knock & K_POS) !== 0) &&
      (rec.rf === rootFrames || (_knock & K_RF) !== 0) &&
      (rec.pc === partCount || (_knock & K_PC) !== 0) &&
      (rec.nf === numFrames || (_knock & K_NF) !== 0)
    ) {
      if (rec.dirty === true) {
        _skipStats.written += 1;
      } else if (!rigPoseSlotsHeld(rec, partGroups, n)) {
        _skipStats.slotChanged += 1;
      } else if (_verify && rec.snapOk !== true) {
        _skipStats.verified += 1; // verify just turned on: pose once for a snapshot
      } else if (_verify && !rigPoseVerified(rec, partGroups, n)) {
        _skipStats.violations += 1;
      } else if (!RUST_RIG) {
        // ?rustRig off: flag-off makes no bridge call; it runs the JS body.
        if (rec.rust !== true || (_knock & K_ROUTE) !== 0) {
          // The JS body posed last: it would store and re-derive only what is there.
          _skipStats.skipped += 1;
          return;
        }
        _skipStats.routeChanged += 1; // the kernel posed last; ?rustRig is off now
      } else {
        // ?rustRig on: flag-off's call asks the bridge first, so the skip asks it too,
        // whichever route posed last (the route probe: the bridge sees flag-off's
        // calls, so its registrations and LRU cannot drift from flag-off's). A throw
        // out of it leaves the record unusable, like one out of the pose.
        _skipStats.probed += 1;
        rec.ok = false;
        const took = rustPoseRig(desc, f, mode, NO_PARTS, n > 0 ? 1 : 0);
        rec.ok = true;
        if (took || rec.rust !== true || (_knock & K_ROUTE) !== 0) {
          // Taken: the kernel would store what is there. Declined after a JS body
          // pose: the JS body would store and re-derive what is there.
          _skipStats.skipped += 1;
          return;
        }
        // Declined after a kernel pose: flag-off runs the JS body now (one bridge
        // call, then the body, which re-derives part.rotation).
        _skipStats.routeChanged += 1;
        tryRust = false;
      }
    } else {
      _skipStats.keyChanged += 1;
    }
  } else {
    rec = {
      f: 0, mode: 0, desc: null, pf: null, pos: null, rf: null, pc: 0, nf: 0, rust: false,
      ok: false, dirty: false, n: -1, slots: [], snap: null, snapOk: false,
    };
    _skipRecs.set(partGroups, rec);
    if (typeof window !== "undefined" && window && !window.__rigPoseSkip) {
      try {
        window.__rigPoseSkip = { stats: rigPoseSkipStats, verify: rigPoseSkipVerify };
      } catch (_) { /* diag only */ }
    }
  }
  // A throw inside the pose leaves the record unusable, never half-updated.
  rec.ok = false;
  const rust = posePartsAt(f, desc, partGroups, inPlace, partFrames, partCount, posFrames, tryRust);
  _skipStats.posed += 1;
  rec.f = f;
  rec.desc = desc;
  rec.mode = mode;
  rec.pf = partFrames;
  rec.pos = posFrames;
  rec.rf = rootFrames;
  rec.pc = partCount;
  rec.nf = numFrames;
  rec.rust = rust; // the route this pose took (the key's route field)
  rigPoseSlots(rec, partGroups, n);
  if (_verify) rigPoseSnapshot(rec, partGroups, n);
  else rec.snapOk = false;
  // After the pose and the hooks: the JS route's own quaternion.set marked it.
  rec.dirty = false;
  rec.ok = true;
}

// Give a part the change hooks that mark `rec` written. False when the part
// cannot be hooked (not a three.js Object3D with a Quaternion and an Euler) or
// is already hooked for another rig.
function rigPoseHook(g, rec) {
  const owner = _hookOwner.get(g);
  if (owner !== undefined) return owner === rec;
  if (g.isObject3D !== true) return false;
  const q = g.quaternion;
  const r = g.rotation;
  if (!q || q.isQuaternion !== true || typeof q._onChange !== "function" || typeof q._onChangeCallback !== "function" ||
      !r || r.isEuler !== true || typeof r._onChange !== "function" || typeof r._onChangeCallback !== "function") {
    return false;
  }
  const qPrev = q._onChangeCallback;
  const rPrev = r._onChangeCallback;
  q._onChange(function rigPoseSkipQuaternionChanged() {
    if ((_knock & K_WRITTEN) === 0) rec.dirty = true;
    qPrev.call(q);
  });
  r._onChange(function rigPoseSkipRotationChanged() {
    if ((_knock & K_WRITTEN) === 0) rec.dirty = true;
    rPrev.call(r);
  });
  _hookOwner.set(g, rec);
  _skipStats.hooked += 1;
  return true;
}

// Record each slot, hooking a part the first time its slot shows it.
function rigPoseSlots(rec, partGroups, n) {
  if (rec.n !== n) {
    rec.n = n;
    // poseRigAt tolerates any numeric partCount; so does this (no RangeError).
    const len = n > 0 ? Math.ceil(n) : 0;
    const slots = new Array(len).fill(UNHOOKABLE);
    for (let p = 0, l = Math.min(len, rec.slots.length); p < l; p += 1) slots[p] = rec.slots[p];
    rec.slots = slots;
  }
  const slots = rec.slots;
  for (let p = 0; p < n; p += 1) {
    const g = partGroups[p];
    if (slots[p] === g) continue;
    if (!g || rigPoseHook(g, rec)) {
      slots[p] = g;
    } else {
      slots[p] = UNHOOKABLE;
      _skipStats.unhookable += 1;
    }
  }
}

// True when every slot p < n holds the object it held at the last pose. Past
// that pose's n a slot reads `undefined`: only an empty slot passes there.
function rigPoseSlotsHeld(rec, partGroups, n) {
  if ((_knock & K_SLOTS) !== 0) return true;
  const slots = rec.slots;
  for (let p = 0; p < n; p += 1) {
    if (partGroups[p] !== slots[p]) return false;
  }
  return true;
}

// Verify mode: what each part holds right after the pose (7 values a part).
function rigPoseSnapshot(rec, partGroups, n) {
  const len = n > 0 ? Math.ceil(n) * FLOATS_PER_PART_PER_FRAME : 0;
  if (rec.snap === null || rec.snap.length < len) rec.snap = new Float64Array(len);
  const snap = rec.snap;
  for (let p = 0, o = 0; p < n; p += 1, o += FLOATS_PER_PART_PER_FRAME) {
    const g = partGroups[p];
    if (!g || rec.slots[p] !== g) continue;
    const pos = g.position;
    const q = g.quaternion;
    snap[o] = pos.x; snap[o + 1] = pos.y; snap[o + 2] = pos.z;
    snap[o + 3] = q._x; snap[o + 4] = q._y; snap[o + 5] = q._z; snap[o + 6] = q._w;
  }
  rec.snapOk = true;
}

// Object.is for doubles: the sign of zero counts, NaN equals NaN (posing NaN
// over NaN stores nothing new).
function _sameF64(a, b) {
  return a === b ? a !== 0 || 1 / a === 1 / b : a !== a && b !== b;
}

// Verify mode: every part still holds its snapshot (taken by the last pose),
// Object.is-equal.
function rigPoseVerified(rec, partGroups, n) {
  _skipStats.verified += 1;
  const snap = rec.snap;
  for (let p = 0, o = 0; p < n; p += 1, o += FLOATS_PER_PART_PER_FRAME) {
    const g = partGroups[p];
    if (!g) continue;
    const pos = g.position;
    const q = g.quaternion;
    if (!_sameF64(pos.x, snap[o]) || !_sameF64(pos.y, snap[o + 1]) || !_sameF64(pos.z, snap[o + 2]) ||
        !_sameF64(q._x, snap[o + 3]) || !_sameF64(q._y, snap[o + 4]) || !_sameF64(q._z, snap[o + 5]) ||
        !_sameF64(q._w, snap[o + 6])) {
      return false;
    }
  }
  return true;
}
