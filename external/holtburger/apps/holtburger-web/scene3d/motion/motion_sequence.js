// scene3d/motion/motion_sequence.js
//
// Animation consolidation (docs/animation-audit/ANIMATION-AUDIT.md §5): a JS port
// of retail's single motion authority — `CSequence` +
// `CSequence::update_internal` (acclient.c:340659) + `CPartArray::UpdateParts`
// (acclient.c:326601) — that REPLACES (not blends) per-part pose each frame.
//
// Step 0: single cyclic node over the concatenated boundary buffer.
// Step 1: MULTI-NODE — node-split a bake by the wasm per-segment descriptor
// (segmentStarts/Counts/Framerates from EntityAnimationData), so a one-shot link
// (windup→strike→recover) can be chained before `firstCyclic` and the swing drives
// the WHOLE body, then resumes the stance cycle by list-advance (retail
// GetObjectSequence acclient.c:337842). Nodes slice a SHARED partFrames buffer via
// `frameOffset`, so node-splitting is allocation-free and bit-identical to the
// single concatenated node (proven in test_motion_sequence.mjs).
//
// Dependency-light by design: NO `three` import. The poser duck-types each part as
// `{ position:{set(x,y,z)}, quaternion:{set(x,y,z,w)} }`, driving a real
// THREE.Object3D in-app AND a plain stub in the headless harness.

export const FLOATS_PER_PART_PER_FRAME = 7; // (x,y,z, qw,qx,qy,qz) — quat W-FIRST

// Discrete key lookup === three.js InterpolateDiscrete: the last key whose time is
// <= t (key 0 before the first time, last key at/after the end). This is retail's
// `(long)floor(frame_number)` snap generalized to non-uniform per-segment times.
function lastKeyLeq(times, t, n) {
  if (n <= 1 || t <= times[0]) return 0;
  if (t >= times[n - 1]) return n - 1;
  let f = 0;
  for (let i = 1; i < n; i += 1) {
    if (times[i] <= t) f = i; else break;
  }
  return f;
}

function uniformTimes(numFrames, framerate) {
  const fr = framerate > 0 ? framerate : 30;
  const out = new Float32Array(numFrames);
  for (let f = 0; f < numFrames; f += 1) out[f] = f / fr;
  return out;
}

// One AnimData segment as a window into a SHARED partFrames/posFrames buffer.
// `frameOffset` = first global frame; the node's local frame f → global
// (frameOffset + f). `times` are LOCAL (rebased to 0 at segment start). `cyclic`
// marks the looping region (retail `first_cyclic`); one-shots are cyclic=false.
export class MotionNode {
  constructor({ partFrames, posFrames, partCount, frameOffset, numFrames, times, duration, cyclic = true }) {
    this.partFrames = partFrames;
    this.posFrames = posFrames && posFrames.length >= (frameOffset + numFrames) * 3 ? posFrames : null;
    this.partCount = partCount;
    this.frameOffset = frameOffset | 0;
    this.numFrames = numFrames | 0;
    this.times = times;
    this.duration = duration > 0 ? duration : (times && times.length ? times[times.length - 1] : 0);
    this.cyclic = cyclic;
  }
}

// Retail CSequence: ordered node list `[one-shot…][firstCyclic..cyclic]` with one
// time cursor.
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
  advance(dt) {
    if (!this.nodes.length) return this;
    let remaining = dt;
    let guard = 0;
    while (remaining > 0 && guard < 4096) {
      guard += 1;
      const node = this.nodes[this.nodeIndex];
      if (!node || node.duration <= 0) {
        if (this.nodes.length === 1) break; // lone zero-duration node: nothing to advance
        this._advanceNode();
        continue;
      }
      const room = node.duration - this.time;
      if (remaining < room) {
        this.time += remaining;
        remaining = 0;
      } else {
        remaining -= room;
        this.time = 0;
        if (this.nodes.length === 1 && node.cyclic) {
          // Single cyclic node loops in place; fold huge dt modulo its duration.
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
      this.nodeIndex = this.firstCyclicIndex < this.nodes.length ? this.firstCyclicIndex : 0;
    }
  }

  // The discrete LOCAL frame within the current node (retail get_curr_animframe,
  // acclient.c:339757). poseRig adds the node's frameOffset for the global index.
  currentFrameIndex() {
    const node = this.node;
    if (!node) return 0;
    return lastKeyLeq(node.times, this.time, node.numFrames);
  }
}

// Build a MotionSequence from one wasm boundary descriptor. When per-segment
// metadata is present (segmentStarts/Counts/Framerates), node-split the bake into
// one MotionNode per AnimData segment (allocation-free windows into the shared
// buffer). Otherwise (legacy / single-segment) build one node over the whole
// buffer — bit-identical to Step 0. `cyclic` defaults true (a cycle bake); the
// caller chains a link bake's non-cyclic nodes before this for an attack (Step-1
// Layer 2). Returns null when no cycle resolved.
export function sequenceFromAnimationData(desc, { cyclic = true } = {}) {
  if (!desc || typeof desc.numFrames !== "number" || desc.numFrames === 0) return null;
  const total = desc.numFrames;
  const globalTimes =
    desc.frameTimes && desc.frameTimes.length === total
      ? desc.frameTimes
      : uniformTimes(total, desc.framerate);
  const globalDuration =
    typeof desc.duration === "number" && desc.duration > 0
      ? desc.duration
      : desc.framerate > 0
        ? total / desc.framerate
        : globalTimes[total - 1];

  const starts = desc.segmentStarts;
  const counts = desc.segmentCounts;
  const haveSegments =
    starts && counts && starts.length === counts.length && starts.length >= 1;

  // Single-node path (Step 0): no segment metadata, or a lone segment.
  if (!haveSegments || starts.length === 1) {
    const node = new MotionNode({
      partFrames: desc.partFrames,
      posFrames: desc.posFrames,
      partCount: desc.partCount,
      frameOffset: 0,
      numFrames: total,
      times: globalTimes,
      duration: globalDuration,
      cyclic,
    });
    return new MotionSequence([node], 0);
  }

  // Multi-node: one window per segment, LOCAL times rebased to 0, duration spanning
  // to the next segment's start (last segment → global duration). Cumulative timing
  // across nodes therefore equals the single concatenated node exactly.
  const nodes = [];
  for (let i = 0; i < starts.length; i += 1) {
    const segStart = starts[i] | 0;
    const segCount = counts[i] | 0;
    if (segCount <= 0) continue;
    const startT = globalTimes[segStart];
    const endIdx = segStart + segCount;
    const endT = endIdx < total ? globalTimes[endIdx] : globalDuration;
    const localTimes = new Float32Array(segCount);
    for (let f = 0; f < segCount; f += 1) localTimes[f] = globalTimes[segStart + f] - startT;
    nodes.push(new MotionNode({
      partFrames: desc.partFrames,
      posFrames: desc.posFrames,
      partCount: desc.partCount,
      frameOffset: segStart,
      numFrames: segCount,
      times: localTimes,
      duration: endT - startT,
      cyclic,
    }));
  }
  if (!nodes.length) return null;
  return new MotionSequence(nodes, 0);
}

// Chain a one-shot link sequence (its nodes non-cyclic) before a cycle sequence
// (its nodes cyclic), with firstCyclic = the first cycle node — retail
// GetObjectSequence's add_motion(link) → add_motion(cycle) (acclient.c:337842).
// This is the Step-1 attack assembly: the swing plays once full-body, then the
// stance cycle resumes by list-advance. Either arg may be null.
export function chainOneShotThenCycle(linkSeq, cycleSeq) {
  const linkNodes = linkSeq ? linkSeq.nodes.map((n) => { n.cyclic = false; return n; }) : [];
  const cycleNodes = cycleSeq ? cycleSeq.nodes.map((n) => { n.cyclic = true; return n; }) : [];
  const nodes = [...linkNodes, ...cycleNodes];
  if (!nodes.length) return null;
  return new MotionSequence(nodes, linkNodes.length);
}

// The dumb poser — port of CPartArray::UpdateParts (acclient.c:326601-326624):
// for the current discrete frame, write each part's ABSOLUTE model-space pose
// (pos + per-frame root motion; quat W-FIRST → xyzw). Mirrors buildAnimationClip
// exactly → numerically identical to the mixer's InterpolateDiscrete clip. No
// weights, no blend. Reads the SHARED buffer at the node's global frame.
export function poseRig(sequence, partGroups) {
  const node = sequence && sequence.node;
  if (!node || !partGroups) return;
  const f = node.frameOffset + sequence.currentFrameIndex();
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
