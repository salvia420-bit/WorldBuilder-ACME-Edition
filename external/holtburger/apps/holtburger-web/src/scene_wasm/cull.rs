// src/scene_wasm/cull.rs — lane C glue: `SceneStaticsCull` over
// holtburger_scene::cull::StaticsCull.
//
// JS side: scene3d/rust/cull.js (`?rustCull=on`). Lane notes (the cut, the
// registry, why JS still sweeps `visible`): docs/2026-10-26-rust-cull.md.
//
//   const k = new SceneStaticsCull();
//   // when nodes come, go or change (batched, once per walk at most):
//   k.applySlots(Float64Array [slot, hasSphere, cx, cy, cz, r, ...]);
//   // per walk: write the input block through a WasmF64View at inPtr()
//   //   [0..16) FrustumCuller._mvp.elements, [16..19) _camAc,
//   //   19 coordinateSystem, 20 reversedDepth, 21 distance on, 22 horizon
//   const n = k.frame();            // 0xFFFFFFFF: no frustum (three would throw)
//   // then read ceil(n / 32) u32 at bitsPtr() (bit i = slot i visible),
//   // re-reading the pointer after every frame() / applySlots().

use holtburger_scene::cull::{IN_LEN, RECORD_LEN, StaticsCull};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
#[derive(Default)]
pub struct SceneStaticsCull {
    inner: StaticsCull,
}

#[wasm_bindgen]
impl SceneStaticsCull {
    #[wasm_bindgen(constructor)]
    pub fn new() -> SceneStaticsCull {
        SceneStaticsCull { inner: StaticsCull::new() }
    }

    /// Byte address of the f64 input block (stable for the object's life).
    #[wasm_bindgen(js_name = inPtr)]
    pub fn in_ptr(&self) -> u32 {
        self.inner.input().as_ptr() as u32
    }

    /// Length of the input block in f64.
    #[wasm_bindgen(js_name = inLen)]
    pub fn in_len(&self) -> u32 {
        IN_LEN as u32
    }

    /// f64 per registration record.
    #[wasm_bindgen(js_name = recordLen)]
    pub fn record_len(&self) -> u32 {
        RECORD_LEN as u32
    }

    /// Apply registration records `[slot, hasSphere, cx, cy, cz, r]*` in
    /// order. Returns the number applied, or 0xFFFFFFFF (nothing applied) for
    /// a malformed batch.
    #[wasm_bindgen(js_name = applySlots)]
    pub fn apply_slots(&mut self, records: &[f64]) -> u32 {
        match self.inner.apply_records(records) {
            Some(n) => n as u32,
            None => u32::MAX,
        }
    }

    /// One walk (see the header). Returns the slot count, or 0xFFFFFFFF when
    /// no frustum can be built (bits untouched).
    pub fn frame(&mut self) -> u32 {
        match self.inner.frame() {
            Some(n) => n as u32,
            None => u32::MAX,
        }
    }

    /// Byte address of the visibility bits (u32 words).
    #[wasm_bindgen(js_name = bitsPtr)]
    pub fn bits_ptr(&self) -> u32 {
        self.inner.bits().as_ptr() as u32
    }

    /// Length of the visibility bits in u32 words.
    #[wasm_bindgen(js_name = bitsLen)]
    pub fn bits_len(&self) -> u32 {
        self.inner.bits().len() as u32
    }

    /// Slots known (highest registered slot + 1).
    #[wasm_bindgen(getter, js_name = slotCount)]
    pub fn slot_count(&self) -> u32 {
        self.inner.slot_count() as u32
    }

    /// Spheres the last frame tested (diag).
    #[wasm_bindgen(getter, js_name = spheresTested)]
    pub fn spheres_tested(&self) -> u32 {
        self.inner.last_counts().0
    }

    /// Spheres the last frame found visible (diag).
    #[wasm_bindgen(getter, js_name = spheresVisible)]
    pub fn spheres_visible(&self) -> u32 {
        self.inner.last_counts().1
    }

    /// The last frame's 24 plane coefficients (a copy; diag / verify).
    pub fn planes(&self) -> Vec<f64> {
        self.inner.frustum().to_array().to_vec()
    }

    /// Forget every slot.
    pub fn clear(&mut self) {
        self.inner.clear();
    }
}
