//! holtburger-scene — the per-frame scene kernels of holtburger-web, in Rust.
//!
//! The 1070 profiles (2026-10-23, ultra, running) put the main thread at
//! ~20.6 ms/frame, ~60% of it JavaScript: three.js's draw loop and scene walk,
//! plus our own per-frame systems (particles, rig posing, culling, animated
//! scenery, terrain VFX). This crate takes over the systems, and later the
//! static world's transforms, visibility and draw lists. Plan, measurements and
//! lane status: apps/holtburger-web/docs/2026-10-26-rust-scene-core.md.
//!
//! # The contract every module follows
//!
//! - **Rust owns the data, JS owns the three.js objects.** A kernel keeps its
//!   state in flat Rust arrays, does a whole frame's work in ONE call, and
//!   writes its results into flat `f32`/`u32` output buffers. JS reads those
//!   buffers through typed-array views on wasm memory
//!   (`scene3d/rust/scene_core.js`) and copies them into the three.js objects
//!   that draw (instance attributes, `matrixWorld`, `visible`). Never one wasm
//!   call per object per frame.
//! - **Bit-for-bit with the JS it replaces.** The math is f64, in exactly the
//!   operation order of the JS (three.js r184 for the shared helpers in
//!   [`math`]), so results match before the f32 store. Only values that pass
//!   through `sin`/`cos`/`atan2`/`exp`/`pow` may differ, by at most one f32 ulp
//!   (V8 uses fdlibm, Rust native uses the platform libm). Parity tests pin
//!   both: exact where no transcendental function is involved, 1 ulp where one
//!   is.
//! - **No clocks, no global RNG, no I/O.** Time comes in as an argument (the
//!   JS side's latched `currentTime()` / frame time). Randomness comes from an
//!   explicit [`rng::Rng`], which parity tests replace with the exact stream
//!   the JS reference drew, so call ORDER is pinned too.
//! - **Natively testable.** Everything here builds and tests on the host
//!   (`cargo test -p holtburger-scene`); the wasm wrapper is a thin layer in
//!   apps/holtburger-web/src/scene_wasm/.
//! - **Every kernel ships behind a URL flag with an `=off` escape**, and the
//!   JS path it replaces stays intact until the flag has been measured on the
//!   1070.

pub mod math;
pub mod rng;

// Lane modules. Each lane owns exactly its own file(s); this list is the only
// shared edit point and is maintained by the orchestrator. One cargo feature
// per lane (all default), so a finished lane builds while others are mid-edit.
#[cfg(feature = "lane-anim-scenery")]
pub mod anim_scenery;
#[cfg(feature = "lane-cull")]
pub mod cull;
#[cfg(feature = "lane-particles")]
pub mod particles;
#[cfg(feature = "lane-rig")]
pub mod rig;
#[cfg(feature = "lane-terrain-fx")]
pub mod terrain_fx;
#[cfg(feature = "lane-world")]
pub mod world;
