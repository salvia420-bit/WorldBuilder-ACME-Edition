//! `impl DatPack for <Type>` — one module per writable file type.
//!
//! Each impl delegates byte production to the type's existing
//! `pack`/`write` method in `holtburger-dat` and adds the type's invariant
//! guards (E12 design §B.5). E12b ships `GfxObj` and `SetupModel`; E12c
//! slice-1 adds the three remaining already-pack-capable WRAP types
//! (`EnvCell`, `MotionKinematics`, `PhysicsScript`) plus three WRITE-NEW
//! material/identity types whose inverse pack paths were authored next to
//! their parsers (`Palette`, `SurfaceTexture`, `Surface`).

pub mod gfx_obj;
pub mod setup_model;

// E12c slice-1 — WRAP types (delegate to the type's existing pack/write).
pub mod env_cell;
pub mod motion_kinematics;
pub mod physics_script;

// E12c slice-1 — WRITE-NEW types (delegate to the inverse pack authored in
// holtburger-dat next to the parser).
pub mod palette;
pub mod surface;
pub mod surface_texture;

// E12c slice-2 — WRITE-NEW raster / animation types (inverse pack authored in
// holtburger-dat next to the parser).
pub mod animation;
pub mod render_texture;
pub mod texture;
