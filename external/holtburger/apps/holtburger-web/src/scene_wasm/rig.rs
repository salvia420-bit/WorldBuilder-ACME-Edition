// src/scene_wasm/rig.rs — lane B glue: `SceneRigs` over holtburger_scene::rig.
//
// JS side: scene3d/rust/rig.js (`?rustRig=on`). Lane notes and the reasons
// for the shape (one `pose` call per posed ENTITY per frame, not one per
// frame; the pose without the local matrix): docs/2026-10-26-rust-rig.md.
//
//   const rigs = new SceneRigs();
//   const id = rigs.registerDescriptor(partCount, numFrames, partFrames,
//       posFrames, hasPosFrames, rootFrames, hasRootFrames);   // once per descriptor
//   const n = rigs.pose(id, frame, mode, nParts);                // per entity per frame
//   // read n * 7 f64 at rigs.outPtr() (WasmF64View); re-read the pointer
//   // after any registerDescriptor (the only call that can move it)
//   rigs.unregister(id);                                          // descriptor collected
//
// `mode`: 0 raw (+ posFrames root motion), 1 in place by mean drift, 2 in
// place exact (falls back to 1 without valid rootFrames). `pose` writes
// px py pz qx qy qz qw per part; `poseMatrices` (not used by the bridge;
// parity-pinned for the stages that move matrices to Rust) also writes the
// local matrix's e0 e1 e2 e4 e5 e6 e8 e9 e10 (holtburger_scene::rig).

use holtburger_scene::rig::{MATRIX_FLOATS_PER_PART, POSE_FLOATS_PER_PART, RigDescriptor, RigSet};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
#[derive(Default)]
pub struct SceneRigs {
    set: RigSet,
}

#[wasm_bindgen]
impl SceneRigs {
    #[wasm_bindgen(constructor)]
    pub fn new() -> SceneRigs {
        SceneRigs { set: RigSet::new() }
    }

    /// Copy one sequence descriptor's clip buffers in. Pass empty arrays (and
    /// `false`) for an absent `posFrames` / `rootFrames`. Returns the id, or 0
    /// when the shape cannot be posed (the bridge keeps it on the JS path).
    #[wasm_bindgen(js_name = registerDescriptor)]
    #[allow(clippy::too_many_arguments)]
    pub fn register_descriptor(
        &mut self,
        part_count: u32,
        num_frames: u32,
        part_frames: Vec<f32>,
        pos_frames: Vec<f32>,
        has_pos_frames: bool,
        root_frames: Vec<f32>,
        has_root_frames: bool,
    ) -> u32 {
        let pos = if has_pos_frames { Some(pos_frames) } else { None };
        let root = if has_root_frames { Some(root_frames) } else { None };
        match RigDescriptor::new(part_count, num_frames, part_frames, pos, root) {
            Some(d) => self.set.register(d),
            None => 0,
        }
    }

    pub fn unregister(&mut self, id: u32) -> bool {
        self.set.unregister(id)
    }

    /// Pose `n` parts of descriptor `id` at `frame` (`poseStride` f64 per
    /// part); returns the parts written (0 = unknown id / mode → JS path).
    pub fn pose(&mut self, id: u32, frame: u32, mode: u32, n: u32) -> u32 {
        self.set.pose(id, frame, mode, n)
    }

    /// `pose` plus each part's local matrix (`matrixStride` f64 per part).
    #[wasm_bindgen(js_name = poseMatrices)]
    pub fn pose_matrices(&mut self, id: u32, frame: u32, mode: u32, n: u32) -> u32 {
        self.set.pose_matrices(id, frame, mode, n)
    }

    /// Byte pointer of the f64 pose output in wasm memory.
    #[wasm_bindgen(js_name = outPtr)]
    pub fn out_ptr(&self) -> *const f64 {
        self.set.out().as_ptr()
    }

    /// Length of the pose output in f64 elements.
    #[wasm_bindgen(js_name = outLen)]
    pub fn out_len(&self) -> u32 {
        self.set.out().len() as u32
    }

    /// f64 per part written by `pose`.
    #[wasm_bindgen(getter, js_name = poseStride)]
    pub fn pose_stride(&self) -> u32 {
        POSE_FLOATS_PER_PART as u32
    }

    /// f64 per part written by `poseMatrices`.
    #[wasm_bindgen(getter, js_name = matrixStride)]
    pub fn matrix_stride(&self) -> u32 {
        MATRIX_FLOATS_PER_PART as u32
    }

    /// Live descriptors (diag).
    #[wasm_bindgen(getter, js_name = descriptorCount)]
    pub fn descriptor_count(&self) -> u32 {
        self.set.len() as u32
    }

    /// f32 values held by the live descriptors (diag / the bridge's cap).
    #[wasm_bindgen(getter, js_name = floatCount)]
    pub fn float_count(&self) -> u32 {
        self.set.float_count() as u32
    }
}
