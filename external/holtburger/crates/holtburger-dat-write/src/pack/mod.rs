//! `impl DatPack for <Type>` — one module per writable file type.
//!
//! Each impl delegates byte production to the type's existing
//! `pack`/`write` method in `holtburger-dat` and adds the type's invariant
//! guards (E12 design §B.5). E12b ships `GfxObj` and `SetupModel`; the
//! remaining writable types are E12c.

pub mod gfx_obj;
pub mod setup_model;
