// src/motion_sequence.rs
//
// The single motion authority for the animation consolidation
// (docs/animation-audit/ANIMATION-AUDIT.md §5), ported from JS
// (scene3d/motion/motion_sequence.js) into the wasm core per the
// "interpreter in Rust" decision (audit §8 Q1). This owns the ONE
// playhead: retail `CSequence` + `CSequence::update_internal`
// (acclient.c:340659) + the frame-index half of `CPartArray::UpdateParts`
// (acclient.c:326611 `get_curr_animframe`).
//
// What stays in JS: the per-part POSE WRITE (`poseRig`) — it touches
// `THREE.Object3D` `.position`/`.quaternion`, the one thing that cannot
// live in Rust. Rust hands JS a single GLOBAL FRAME INDEX per entity per
// frame; JS indexes its already-cached keyframe buffer (the
// `EntityAnimationData.partFrames` snapshot) and writes the flat rig. The
// keyframe floats never re-cross the boundary per frame — only a u32.
//
// Layering (this crate's `_impl` convention): the struct + all logic are
// gated `cfg(any(target_arch = "wasm32", test))` and unit-tested NATIVELY
// (no GPU, no browser, no wasm runtime). The `#[wasm_bindgen]` surface is
// wasm32-only and is a thin JS-named wrapper over the `*_impl` methods.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

// One AnimData segment as a window into the SHARED (JS-side) keyframe
// buffer. `frame_offset` = first GLOBAL frame; a local frame f maps to the
// global frame `frame_offset + f`. `times` are LOCAL (rebased to 0 at the
// segment start). `cyclic` marks the looping region (retail `first_cyclic`);
// one-shot link nodes are `cyclic == false`. Holds NO keyframe floats —
// only the timing structure needed to run the playhead.
#[cfg(any(target_arch = "wasm32", test))]
#[derive(Clone)]
struct MotionNode {
    frame_offset: u32,
    num_frames: u32,
    times: Vec<f32>, // LOCAL, length == num_frames
    duration: f32,
    cyclic: bool,
}

// Discrete key lookup === three.js `InterpolateDiscrete` / retail
// `(long)floor(frame_number)` (acclient.c:339757): the last key whose time
// is <= t (key 0 before the first time; last key at/after the end).
// Generalized to the non-uniform per-segment `frame_times` the bake carries.
#[cfg(any(target_arch = "wasm32", test))]
fn last_key_leq(times: &[f32], t: f32, n: u32) -> u32 {
    let n = n as usize;
    if n <= 1 || times.is_empty() || t <= times[0] {
        return 0;
    }
    if t >= times[n - 1] {
        return (n - 1) as u32;
    }
    let mut f = 0u32;
    let mut i = 1usize;
    while i < n {
        if times[i] <= t {
            f = i as u32;
        } else {
            break;
        }
        i += 1;
    }
    f
}

#[cfg(any(target_arch = "wasm32", test))]
fn uniform_times(num_frames: u32, framerate: f32) -> Vec<f32> {
    let fr = if framerate > 0.0 { framerate } else { 30.0 };
    (0..num_frames).map(|f| f as f32 / fr).collect()
}

// Retail `CSequence`: an ordered node list `[one-shot…][firstCyclic..cyclic]`
// with one playhead (`node_index` + `time` within the current node). When
// the wrap target (`first_cyclic`) is itself cyclic, running off the end of
// the list LOOPS (acclient.c:340563-566); when the sequence is a pure
// one-shot (no cyclic region) it COMPLETES — `done` latches and the playhead
// CLAMPS at the final frame, so JS hands the rig back to the stance cycle
// (or, once a cycle is chained after the one-shot, the cycle resumes by
// list-advance — retail's `first_cyclic` fallback).
#[cfg(any(target_arch = "wasm32", test))]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
#[allow(dead_code)] // fields read via methods; some accessors are wasm-only
pub struct MotionSequence {
    nodes: Vec<MotionNode>,
    first_cyclic_index: usize,
    node_index: usize,
    time: f32,
    done: bool,
}

#[cfg(any(target_arch = "wasm32", test))]
#[allow(dead_code)]
impl MotionSequence {
    fn new(nodes: Vec<MotionNode>, first_cyclic_index: usize) -> MotionSequence {
        MotionSequence {
            nodes,
            first_cyclic_index,
            node_index: 0,
            time: 0.0,
            done: false,
        }
    }

    // Build a stateful sequence from one motion's bake descriptor. Empty
    // `frame_times` → uniform from `framerate`; empty segment arrays (or a
    // lone segment) → ONE node over the whole buffer (Step 0, bit-identical
    // to the concatenated clip). Otherwise NODE-SPLIT one window per AnimData
    // segment, LOCAL times rebased to 0, each node's duration spanning to the
    // next segment's start (last → global duration) so cumulative timing
    // equals the single concatenated node exactly. `cyclic` = a looping cycle
    // (true) vs a one-shot link (false). Mirrors JS `sequenceFromAnimationData`.
    fn build_impl(
        num_frames: u32,
        framerate: f32,
        duration: f32,
        frame_times: &[f32],
        seg_starts: &[u32],
        seg_counts: &[u32],
        cyclic: bool,
    ) -> Option<MotionSequence> {
        if num_frames == 0 {
            return None;
        }
        let total = num_frames as usize;
        let global_times: Vec<f32> = if frame_times.len() == total {
            frame_times.to_vec()
        } else {
            uniform_times(num_frames, framerate)
        };
        let global_duration = if duration > 0.0 {
            duration
        } else if framerate > 0.0 {
            num_frames as f32 / framerate
        } else {
            *global_times.last().unwrap_or(&0.0)
        };

        let have_segments = !seg_starts.is_empty() && seg_starts.len() == seg_counts.len();

        // Single-node path (Step 0): no segment metadata, or a lone segment.
        if !have_segments || seg_starts.len() == 1 {
            let node = MotionNode {
                frame_offset: 0,
                num_frames,
                times: global_times,
                duration: global_duration,
                cyclic,
            };
            return Some(MotionSequence::new(vec![node], 0));
        }

        // Multi-node: one window per segment.
        let mut nodes = Vec::with_capacity(seg_starts.len());
        for i in 0..seg_starts.len() {
            let seg_start = seg_starts[i];
            let seg_count = seg_counts[i];
            if seg_count == 0 {
                continue;
            }
            let s = seg_start as usize;
            let start_t = *global_times.get(s).unwrap_or(&0.0);
            let end_idx = s + seg_count as usize;
            let end_t = if end_idx < total {
                global_times[end_idx]
            } else {
                global_duration
            };
            let local_times: Vec<f32> = (0..seg_count as usize)
                .map(|f| global_times[s + f] - start_t)
                .collect();
            nodes.push(MotionNode {
                frame_offset: seg_start,
                num_frames: seg_count,
                times: local_times,
                duration: end_t - start_t,
                cyclic,
            });
        }
        if nodes.is_empty() {
            return None;
        }
        Some(MotionSequence::new(nodes, 0))
    }

    // Chain a one-shot link (its nodes forced non-cyclic) BEFORE a cycle
    // (forced cyclic), `first_cyclic` = the first cycle node — retail
    // `GetObjectSequence` `add_motion(link)` → `add_motion(cycle)`
    // (acclient.c:337842). The swing plays once full-body, then the stance
    // cycle resumes by list-advance. NOTE: when link and cycle come from
    // SEPARATE bakes (different JS buffers), the JS poser must map node
    // groups → buffers via `node_index` vs `first_cyclic_index`; `frame_offset`
    // alone is buffer-ambiguous across two bakes.
    fn chain_impl(link: &MotionSequence, cycle: &MotionSequence) -> Option<MotionSequence> {
        let mut nodes: Vec<MotionNode> = Vec::with_capacity(link.nodes.len() + cycle.nodes.len());
        for n in &link.nodes {
            let mut nn = n.clone();
            nn.cyclic = false;
            nodes.push(nn);
        }
        let first_cyclic = nodes.len();
        for n in &cycle.nodes {
            let mut nn = n.clone();
            nn.cyclic = true;
            nodes.push(nn);
        }
        if nodes.is_empty() {
            return None;
        }
        Some(MotionSequence::new(nodes, first_cyclic))
    }

    fn reset_impl(&mut self) {
        self.node_index = 0;
        self.time = 0.0;
        self.done = false;
    }

    // Port of `CSequence::update_internal` (acclient.c:340659): advance the
    // cursor by dt; on running off a node's end carry the remainder into the
    // next node; running off the END of the list either wraps to `first_cyclic`
    // (loop) or — for a pure one-shot — latches `done` and clamps the final
    // frame (see `advance_node`).
    fn advance_impl(&mut self, dt: f32) {
        if self.nodes.is_empty() || self.done {
            return;
        }
        let mut remaining = dt;
        let mut guard = 0u32;
        while remaining > 0.0 && guard < 4096 {
            guard += 1;
            let (dur, cyclic) = {
                let node = &self.nodes[self.node_index];
                (node.duration, node.cyclic)
            };
            if dur <= 0.0 {
                if self.nodes.len() == 1 {
                    break; // lone zero-duration node: nothing to advance
                }
                if !self.advance_node() {
                    break;
                }
                continue;
            }
            let room = dur - self.time;
            if remaining < room {
                self.time += remaining;
                remaining = 0.0;
            } else {
                remaining -= room;
                self.time = 0.0;
                if self.nodes.len() == 1 && cyclic {
                    // Single cyclic node loops in place; fold huge dt modulo dur.
                    if remaining >= dur {
                        remaining %= dur;
                    }
                } else if !self.advance_node() {
                    break;
                }
            }
        }
    }

    // Advance to the next node. Returns false when the sequence COMPLETED
    // (pure one-shot ran off the end, playhead clamped at the final frame) —
    // the caller stops advancing.
    fn advance_node(&mut self) -> bool {
        let next = self.node_index + 1;
        if next < self.nodes.len() {
            self.node_index = next;
            self.time = 0.0;
            return true;
        }
        // Ran off the end of the list.
        let target = if self.first_cyclic_index < self.nodes.len() {
            self.first_cyclic_index
        } else {
            0
        };
        if self.nodes[target].cyclic {
            self.node_index = target;
            self.time = 0.0;
            true
        } else {
            // Pure one-shot: latch done, clamp at the final frame (holds it).
            self.done = true;
            self.node_index = self.nodes.len() - 1;
            self.time = self.nodes[self.node_index].duration;
            false
        }
    }

    // The discrete LOCAL frame within the current node (retail
    // `get_curr_animframe`, acclient.c:339757).
    fn current_local_frame(&self) -> u32 {
        match self.nodes.get(self.node_index) {
            Some(node) => last_key_leq(&node.times, self.time, node.num_frames),
            None => 0,
        }
    }

    // The GLOBAL frame index into the shared (JS-cached) keyframe buffer:
    // the active node's `frame_offset` + the local frame. This is the one
    // u32 JS reads per entity per frame to drive `poseRig`.
    fn global_frame_index_impl(&self) -> u32 {
        match self.nodes.get(self.node_index) {
            Some(node) => node.frame_offset + self.current_local_frame(),
            None => 0,
        }
    }
}

// ---- wasm-bindgen surface (wasm32-only, thin JS-named wrappers) -----------
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl MotionSequence {
    // `MotionSequence.fromDescriptor(numFrames, framerate, duration,
    // frameTimes, segmentStarts, segmentCounts, cyclic)`. Pass empty typed
    // arrays for absent `frameTimes`/segments. Returns `undefined` if no
    // frames. Mirrors JS `sequenceFromAnimationData`.
    #[wasm_bindgen(js_name = fromDescriptor)]
    pub fn from_descriptor(
        num_frames: u32,
        framerate: f32,
        duration: f32,
        frame_times: Vec<f32>,
        segment_starts: Vec<u32>,
        segment_counts: Vec<u32>,
        cyclic: bool,
    ) -> Option<MotionSequence> {
        MotionSequence::build_impl(
            num_frames,
            framerate,
            duration,
            &frame_times,
            &segment_starts,
            &segment_counts,
            cyclic,
        )
    }

    // `MotionSequence.chainOneShotThenCycle(link, cycle)`.
    #[wasm_bindgen(js_name = chainOneShotThenCycle)]
    pub fn chain_one_shot_then_cycle(
        link: &MotionSequence,
        cycle: &MotionSequence,
    ) -> Option<MotionSequence> {
        MotionSequence::chain_impl(link, cycle)
    }

    pub fn advance(&mut self, dt: f32) {
        self.advance_impl(dt);
    }

    pub fn reset(&mut self) {
        self.reset_impl();
    }

    #[wasm_bindgen(getter, js_name = globalFrameIndex)]
    pub fn global_frame_index(&self) -> u32 {
        self.global_frame_index_impl()
    }

    #[wasm_bindgen(getter)]
    pub fn done(&self) -> bool {
        self.done
    }

    // The active node index — JS uses this with `firstCyclicIndex` to pick
    // the right keyframe buffer for a chained (link+cycle) sequence.
    #[wasm_bindgen(getter, js_name = nodeIndex)]
    pub fn node_index(&self) -> u32 {
        self.node_index as u32
    }

    #[wasm_bindgen(getter, js_name = firstCyclicIndex)]
    pub fn first_cyclic_index(&self) -> u32 {
        self.first_cyclic_index as u32
    }

    #[wasm_bindgen(getter, js_name = nodeCount)]
    pub fn node_count(&self) -> u32 {
        self.nodes.len() as u32
    }
}

// ---- native parity tests (no GPU, no browser, no wasm runtime) ------------
// The oracle is `test_motion_sequence.mjs` (Parts A + C); these reproduce its
// exact numeric expectations against the Rust port, plus the one-shot
// completion semantics the JS module lacked (it looped one-shots forever).
#[cfg(test)]
mod tests {
    use super::*;

    // Part A: frame progression + wrap on a single cyclic node — 4 frames @
    // 10fps, dur 0.4 (test_motion_sequence.mjs:65-78).
    #[test]
    fn part_a_frame_progression_and_wrap() {
        let mut seq = MotionSequence::build_impl(4, 10.0, 0.4, &[], &[], &[], true).unwrap();
        assert_eq!(seq.nodes.len(), 1);
        seq.reset_impl();
        assert_eq!(seq.global_frame_index_impl(), 0);
        seq.advance_impl(0.05);
        assert_eq!(seq.global_frame_index_impl(), 0, "t=0.05");
        seq.advance_impl(0.10);
        assert_eq!(seq.global_frame_index_impl(), 1, "t=0.15");
        seq.advance_impl(0.20);
        assert_eq!(seq.global_frame_index_impl(), 3, "t=0.35");
        seq.advance_impl(0.10);
        assert_eq!(seq.global_frame_index_impl(), 0, "t=0.45 wraps");
        // Huge dt folds modulo duration (100.07 % 0.4 = 0.07 → frame 0).
        seq.reset_impl();
        seq.advance_impl(100.07);
        assert_eq!(seq.global_frame_index_impl(), 0, "huge dt modulo");
        assert!(!seq.done, "cyclic never completes");
    }

    // Part C: 2-segment node-split === single concatenated node at every
    // sample time, including across the loop wrap (test_motion_sequence.mjs:
    // 162-204). frameTimes [0,0.1,0.2,0.4], dur 0.6; seg0 frames 0,1 @10fps,
    // seg1 frames 2,3 @5fps.
    #[test]
    fn part_c_node_split_parity() {
        let ftimes = [0.0f32, 0.1, 0.2, 0.4];
        let dur = 0.6;
        let mut single =
            MotionSequence::build_impl(4, 10.0, dur, &ftimes, &[], &[], true).unwrap();
        let mut multi =
            MotionSequence::build_impl(4, 10.0, dur, &ftimes, &[0, 2], &[2, 2], true).unwrap();
        assert_eq!(single.nodes.len(), 1, "single node");
        assert_eq!(multi.nodes.len(), 2, "two nodes");

        let samples = [
            0.0f32, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.39, 0.45, 0.55, 0.6, 0.65, 1.27,
        ];
        for &t in &samples {
            single.reset_impl();
            single.advance_impl(t);
            multi.reset_impl();
            multi.advance_impl(t);
            assert_eq!(
                single.global_frame_index_impl(),
                multi.global_frame_index_impl(),
                "global frame mismatch at t={t}"
            );
        }
    }

    // The one-shot completion the JS module never had: a non-cyclic single
    // node latches `done` and CLAMPS the final frame instead of looping.
    #[test]
    fn one_shot_latches_done_and_clamps_last_frame() {
        let mut seq = MotionSequence::build_impl(4, 10.0, 0.4, &[], &[], &[], false).unwrap();
        seq.advance_impl(0.25); // mid → frame 2
        assert_eq!(seq.global_frame_index_impl(), 2);
        assert!(!seq.done, "not done mid-clip");
        seq.advance_impl(1.0); // past end → done, clamp at last frame (3)
        assert!(seq.done, "done after end");
        assert_eq!(seq.global_frame_index_impl(), 3, "clamps last frame");
        // Further advances are inert.
        seq.advance_impl(5.0);
        assert_eq!(seq.global_frame_index_impl(), 3);
        assert!(seq.done);
    }

    // chainOneShotThenCycle: link (one-shot, non-cyclic) before cycle
    // (cyclic), firstCyclic at the boundary; plays the link then RESUMES the
    // cycle by list-advance and loops there forever (never `done`).
    #[test]
    fn chain_one_shot_then_cycle_resumes_and_loops() {
        let link = MotionSequence::build_impl(4, 10.0, 0.4, &[], &[], &[], false).unwrap();
        let cycle = MotionSequence::build_impl(4, 10.0, 0.4, &[], &[], &[], true).unwrap();
        let mut chained = MotionSequence::chain_impl(&link, &cycle).unwrap();
        assert_eq!(chained.nodes.len(), 2);
        assert_eq!(chained.first_cyclic_index, 1);
        assert!(!chained.nodes[0].cyclic, "link node non-cyclic");
        assert!(chained.nodes[1].cyclic, "cycle node cyclic");

        chained.advance_impl(0.2); // mid link
        assert_eq!(chained.node_index, 0, "still in link");
        chained.advance_impl(0.3); // 0.5 total: past link(0.4) → 0.1 into cycle
        assert_eq!(chained.node_index, 1, "resumed cycle");
        assert!(!chained.done, "chained-with-cycle never completes");
        chained.advance_impl(10.0); // loops in the cycle
        assert!(!chained.done);
        assert_eq!(chained.node_index, 1);
    }

    // build returns None on an empty bake.
    #[test]
    fn empty_bake_is_none() {
        assert!(MotionSequence::build_impl(0, 10.0, 0.0, &[], &[], &[], true).is_none());
    }
}
