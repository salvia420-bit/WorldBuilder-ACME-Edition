// src/scene_wasm — the wasm-bindgen surface of the Rust scene core.
//
// Thin wrappers only: each exported class owns one `holtburger_scene` kernel
// and exposes (a) one call per frame, (b) pointers + lengths of its flat
// output buffers so JS reads them through typed-array views on wasm memory
// (scene3d/rust/scene_core.js re-creates views when memory grows), and
// (c) add/remove calls for the objects it tracks. No per-object-per-frame
// calls. The kernels and their tests live in crates/holtburger-scene.
//
// One file per lane; this file is the only shared edit point (orchestrator).

#[cfg(feature = "scene-anim-scenery")]
mod anim_scenery;
#[cfg(feature = "scene-cull")]
mod cull;
#[cfg(feature = "scene-particles")]
mod particles;
#[cfg(feature = "scene-rig")]
mod rig;
#[cfg(feature = "scene-terrain-fx")]
mod terrain_fx;
#[cfg(feature = "scene-world")]
mod world;

use wasm_bindgen::prelude::*;

/// Version of the scene-core JS contract. scene3d/rust/scene_core.js refuses a
/// pkg whose value differs from the one it expects (stale wasm → fall back to
/// the JS paths instead of calling missing or changed exports).
#[wasm_bindgen(js_name = sceneCoreAbi)]
pub fn scene_core_abi() -> u32 {
    1
}
