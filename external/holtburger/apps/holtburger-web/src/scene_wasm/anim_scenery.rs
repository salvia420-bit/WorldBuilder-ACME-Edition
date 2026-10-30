// src/scene_wasm/anim_scenery.rs — lane D glue: `SceneAnimScenery` over
// holtburger_scene::anim_scenery (the per-DID template pose of the DAT-animated
// scenery: mixer step, SetOmega orbit, GPU pose-table rows).
//
// JS side: scene3d/rust/anim_scenery.js (`?rustAnimScenery=on`). Lane notes:
// docs/2026-10-26-rust-anim-terrain.md.
//
//   const k = new SceneAnimScenery();
//   const h = k.registerGroup(key, frames, numParts, numFrames, fps, closedLoop,
//                             hasOmega, ax, ay, az, rad);       // a DID group is built
//   const row = k.registerRow(key, partIdx, post16 | [], init16 | []);  // poseRowFor allocated a row
//   const nRows = k.advance(dt, omegaHz);                         // ONCE per frame
//   // then read, through views (re-read the pointers after every call):
//   //   partsPtr/partsLen   f64, per group at partsOffset(h): partStride per part
//   //   groupPtr/groupLen   f64, per group at slotOf(h) * groupStride
//   //   rowsPtr/rowsLen     f32, rowFloats per row (row index k = table row k + 1)
//   //   rowsWrittenPtr/Len  u8, 1 = advance wrote row k this frame
//   k.unregisterGroup(h);                                         // the DID group was disposed

use holtburger_scene::anim_scenery::{AnimScenery, GROUP_STRIDE, Omega, PART_STRIDE, ROW_FLOATS};
use holtburger_scene::math::{Mat4, Vec3};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
#[derive(Default)]
pub struct SceneAnimScenery {
    k: AnimScenery,
}

fn mat16(v: &[f64]) -> Option<Mat4> {
    if v.len() < 16 {
        return None;
    }
    let mut e = [0.0f64; 16];
    e.copy_from_slice(&v[..16]);
    Some(Mat4::from_elements(e))
}

#[wasm_bindgen]
impl SceneAnimScenery {
    #[wasm_bindgen(constructor)]
    pub fn new() -> SceneAnimScenery {
        SceneAnimScenery { k: AnimScenery::new() }
    }

    /// Register one group from the same inputs `buildSceneryAnimationClip`
    /// got (`frames`: fetchAnimation's f32 layout, 7 per (frame, part)). `key`
    /// is the numeric animation DID, 0 for a wind group. The omega is
    /// `parseSetOmega`'s unit axis + rad (ignored unless `has_omega`).
    /// Returns the handle, or 0 when the clip builder would return null.
    #[wasm_bindgen(js_name = registerGroup)]
    #[allow(clippy::too_many_arguments)]
    pub fn register_group(
        &mut self,
        key: u32,
        frames: &[f32],
        num_parts: u32,
        num_frames: u32,
        fps: f64,
        closed_loop: bool,
        has_omega: bool,
        ax: f64,
        ay: f64,
        az: f64,
        rad: f64,
    ) -> u32 {
        let omega = if has_omega { Some(Omega { axis: Vec3::new(ax, ay, az), rad }) } else { None };
        self.k.register_group(key, frames, num_parts as usize, num_frames as usize, fps, closed_loop, omega)
    }

    #[wasm_bindgen(js_name = unregisterGroup)]
    pub fn unregister_group(&mut self, handle: u32) -> bool {
        self.k.unregister_group(handle)
    }

    /// f64 index of the group's first part in the parts buffer (0xFFFFFFFF
    /// for an unknown handle).
    #[wasm_bindgen(js_name = partsOffset)]
    pub fn parts_offset(&self, handle: u32) -> u32 {
        self.k.parts_offset(handle)
    }

    /// The group's slot: its block in the group buffer is at slot * groupStride.
    #[wasm_bindgen(js_name = slotOf)]
    pub fn slot_of(&self, handle: u32) -> u32 {
        self.k.slot_of(handle)
    }

    /// The next pose-table row. `post` / `init`: 16 f64 (Matrix4.elements) or
    /// empty for none. Returns the 0-based row index (table row = index + 1).
    #[wasm_bindgen(js_name = registerRow)]
    pub fn register_row(&mut self, key: u32, part: u32, post: &[f64], init: &[f64]) -> u32 {
        self.k.register_row(key, part as usize, mat16(post), mat16(init))
    }

    #[wasm_bindgen(js_name = clearRows)]
    pub fn clear_rows(&mut self) {
        self.k.clear_rows();
    }

    pub fn clear(&mut self) {
        self.k.clear();
    }

    /// ONE frame for every group and row; returns the rows written.
    pub fn advance(&mut self, dt: f64, omega_hz: f64) -> u32 {
        self.k.advance(dt, omega_hz)
    }

    #[wasm_bindgen(js_name = partsPtr)]
    pub fn parts_ptr(&self) -> u32 {
        self.k.parts_out().as_ptr() as u32
    }
    #[wasm_bindgen(js_name = partsLen)]
    pub fn parts_len(&self) -> u32 {
        self.k.parts_out().len() as u32
    }
    #[wasm_bindgen(js_name = groupPtr)]
    pub fn group_ptr(&self) -> u32 {
        self.k.group_out().as_ptr() as u32
    }
    #[wasm_bindgen(js_name = groupLen)]
    pub fn group_len(&self) -> u32 {
        self.k.group_out().len() as u32
    }
    #[wasm_bindgen(js_name = rowsPtr)]
    pub fn rows_ptr(&self) -> u32 {
        self.k.rows_out().as_ptr() as u32
    }
    #[wasm_bindgen(js_name = rowsLen)]
    pub fn rows_len(&self) -> u32 {
        self.k.rows_out().len() as u32
    }
    #[wasm_bindgen(js_name = rowsWrittenPtr)]
    pub fn rows_written_ptr(&self) -> u32 {
        self.k.rows_written().as_ptr() as u32
    }
    #[wasm_bindgen(js_name = rowsWrittenLen)]
    pub fn rows_written_len(&self) -> u32 {
        self.k.rows_written().len() as u32
    }

    #[wasm_bindgen(getter, js_name = groupCount)]
    pub fn group_count(&self) -> u32 {
        self.k.group_count() as u32
    }
    #[wasm_bindgen(getter, js_name = rowCount)]
    pub fn row_count(&self) -> u32 {
        self.k.row_count() as u32
    }
    #[wasm_bindgen(getter, js_name = partStride)]
    pub fn part_stride(&self) -> u32 {
        PART_STRIDE as u32
    }
    #[wasm_bindgen(getter, js_name = groupStride)]
    pub fn group_stride(&self) -> u32 {
        GROUP_STRIDE as u32
    }
    #[wasm_bindgen(getter, js_name = rowFloats)]
    pub fn row_floats(&self) -> u32 {
        ROW_FLOATS as u32
    }
}
