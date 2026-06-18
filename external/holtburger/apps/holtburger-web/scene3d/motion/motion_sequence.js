// scene3d/motion/motion_sequence.js
//
// Step 0 of the animation consolidation (docs/animation-audit/ANIMATION-AUDIT.md §5):
// a JS port of retail's single motion authority — `CSequence` +
// `CSequence::update_internal` (acclient.c:340659) + `CPartArray::UpdateParts`
// (acclient.c:326601) — that REPLACES (not blends) per-part pose each frame.
//
// This is the primitive that ends the whack-a-mole: instead of N concurrent
// three.js AnimationMixer actions weight-summed into "upper-body-only" swings,
// one MotionSequence owns a single frame cursor and the dumb poser writes the
// discrete authored keyframe to the flat rig — exactly what retail's
// `get_curr_animframe → Frame::combine` loop does.
//
// Dependency-light by design: NO `three` import. The poser duck-types each part
// as `{ position: {set(x,y,z)}, quaternion: {set(x,y,z,w)} }`, so it drives a
// real `THREE.Object3D` in-app AND a plain stub in the headless parity harness.
//
// Step 0 scope: a locomotion cycle is ONE cyclic node over the concatenated
// `partFrames` buffer the wasm boundary already ships (EntityAnimationData,
// src/lib.rs:15510). Multi-node one-shot chains (attack link before firstCyclic)
// arrive in Step 1 with the wasm per-segment descriptor — the node list + wrap
// logic here already model that shape.

export const FLOATS_PER_PART_PER_FRAME = 7; // (x,y,z, qw,qx,qy,qz) — quat W-FIRST, matches animation.js

// Discrete key lookup, identical to three.js InterpolateDiscrete: the last key
// whose time is <= t (key 0 before the first time, last key at/after the end).
// This is retail's `(long)floor(frame_number)` snap generalized to the
// non-uniform per-segment `frameTimes`.
function lastKeyLeq(times, t, n) {
  if (t <= times[0]) return 0;
  if (t >= times[n - 1]) return n - 1;
  // Linear scan is fine (cycles are tens of frames); swap for binary if needed.
  let f = 0;
  for (let i = 1; i < n; i += 1) {
    if (times[i] <= t) f = i; else break;
  }
  return f;
}

// One AnimData segment: a contiguous run of `numFrames` keyframes with its own
// timing. `cyclic` marks the looping region (retail `first_cyclic`).
export class MotionNode {
  constructor({ partFrames, frameTimes, posFrames, partCount, numFrames, framerate, duration, cyclic = true }) {
    this.partFrames = partFrames;
    this.partCount = partCount;
    this.numFrames = numFrames;
    this.cyclic = cyclic;
    this.posFrames =
      posFrames && posFrames.length === numFrames * 3 ? posFrames : null;
    // Per-frame absolute times, mirroring buildAnimationClip: prefer wasm
    // frameTimes, else uniform i/framerate.
    if (frameTimes && frameTimes.length === numFrames) {
      this.times = frameTimes;
    } else {
      const fr = framerate > 0 ? framerate : 30;
      this.times = new Float32Array(numFrames);
      for (let f = 0; f < numFrames; f += 1) this.times[f] = f / fr;
    }
    // Duration precedence mirrors buildAnimationClip (wasm duration → frames/rate
    // → last key time) so the node wraps where the mixer's clip wraps.
    this.duration =
      typeof duration === "number" && duration > 0
        ? duration
        : framerate > 0
          ? numFrames / framerate
          : this.times[numFrames - 1];
  }
}

// Retail CSequence: an ordered node list `[one-shot…][firstCyclic..cyclic]` with
// a single time cursor. Step 0 builds a one-node cyclic sequence; the structure
// generalizes to prepended one-shots (Step 1).
export class MotionSequence {
  constructor(nodes, firstCyclicIndex = 0) {
    this.nodes = nodes || [];
    this.firstCyclicIndex = firstCyclicIndex;
    this.nodeIndex = 0;
    this.time = 0; // time within the current node
  }

  reset() {
    this.nodeIndex = 0;
    this.time = 0;
    return this;
  }

  get node() {
    return this.nodes[this.nodeIndex] || null;
  }

  // Port of CSequence::update_internal (acclient.c:340659): advance the cursor by
  // dt; on running off a node's end, carry the remainder into the next node;
  // running off the END of the list wraps to firstCyclic (acclient.c:340563-566).
  // One-shot (non-cyclic) nodes advance to the next node; a lone cyclic node
  // loops in place (modulo duration).
  advance(dt) {
    if (!this.nodes.length) return this;
    let remaining = dt;
    // Guard against pathological dt blowing the loop on a zero-duration node.
    let guard = 0;
    while (remaining > 0 && guard < 1024) {
      guard += 1;
      const node = this.nodes[this.nodeIndex];
      if (!node || node.duration <= 0) {
        this._advanceNode();
        if (this.nodeIndex === this.firstCyclicIndex && this.nodes.length === 1) break;
        continue;
      }
      const room = node.duration - this.time;
      if (remaining < room) {
        this.time += remaining;
        remaining = 0;
      } else {
        // Consume the rest of this node, carry the overshoot into the next.
        remaining -= room;
        this.time = 0;
        if (this.nodes.length === 1 && node.cyclic) {
          // Single cyclic node: loop in place. The while-loop re-enters with
          // time=0 and consumes `remaining` against the same node — but to
          // avoid re-looping huge dt frame-by-frame, fold remaining modulo dur.
          if (remaining >= node.duration) remaining = remaining % node.duration;
        } else {
          this._advanceNode();
        }
      }
    }
    return this;
  }

  _advanceNode() {
    this.nodeIndex += 1;
    this.time = 0;
    if (this.nodeIndex >= this.nodes.length) {
      // Off the end of the list → wrap to the cyclic region (retail first_cyclic).
      this.nodeIndex = this.firstCyclicIndex < this.nodes.length ? this.firstCyclicIndex : 0;
    }
  }

  // The discrete frame the current cursor lands on within the current node —
  // retail get_curr_animframe (acclient.c:339757): part_frames[floor(frame_number)].
  currentFrameIndex() {
    const node = this.node;
    if (!node) return 0;
    return lastKeyLeq(node.times, this.time, node.numFrames);
  }
}

// Build a single-cyclic-node sequence from the wasm boundary descriptor
// (EntityAnimationData / AnimationCache fields). For Step 0 the concatenated
// buffer IS the cyclic node; per-segment chains come later.
export function sequenceFromAnimationData(desc) {
  if (!desc || typeof desc.numFrames !== "number" || desc.numFrames === 0) return null;
  const node = new MotionNode({
    partFrames: desc.partFrames,
    frameTimes: desc.frameTimes,
    posFrames: desc.posFrames,
    partCount: desc.partCount,
    numFrames: desc.numFrames,
    framerate: desc.framerate,
    duration: desc.duration,
    cyclic: true,
  });
  return new MotionSequence([node], 0);
}

// The dumb poser — port of CPartArray::UpdateParts (acclient.c:326601-326624):
// for the current discrete frame, write each part's ABSOLUTE model-space pose.
// Mirrors buildAnimationClip EXACTLY (pos + per-frame root motion; quat
// W-FIRST → xyzw) so the result is numerically identical to the mixer's
// InterpolateDiscrete clip. No weights, no blend.
//
// `partGroups[i]` is the rig group for part i (a THREE.Object3D in-app, a stub
// in tests), each exposing `.position.set(x,y,z)` and `.quaternion.set(x,y,z,w)`.
export function poseRig(sequence, partGroups) {
  const node = sequence && sequence.node;
  if (!node || !partGroups) return;
  const f = sequence.currentFrameIndex();
  const { partFrames, partCount, posFrames } = node;
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
      // (qw,qx,qy,qz) → (qx,qy,qz,qw)
      g.quaternion.set(partFrames[base + 4], partFrames[base + 5], partFrames[base + 6], partFrames[base + 3]);
    }
  }
}

// `?unifiedMotion` capability flag (docs/url-flags.md). Default OFF in Step 0 —
// shadow mode computes the sequence pose for comparison without switching any
// production entity off the mixer. Later steps accept per-class values
// (attack/death/door/cast/locomotion) and finally `on`.
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
