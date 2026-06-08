//! `holtburger-dat-write` — a `DatEasyWriter`-equivalent write path for
//! holtburger DAT records (E12 design §B).
//!
//! Today the holtburger write story is fragmented: only a handful of the 52
//! file types have any pack/write method, and their signatures diverge
//! (`pack<W: Write+Seek>` vs `write<W: Write+Seek>` vs
//! `pack(&self) -> Result<Vec<u8>>`). The container writers
//! (`HbaWriter` / `HbaStreamWriter`) accept only raw `Vec<u8>` with no
//! type awareness, so callers must serialize externally and hand-supply the
//! `type_id`.
//!
//! This crate consolidates that behind one [`DatPack`] trait:
//!
//! - [`DatPack::pack`] returns a fresh `Vec<u8>` regardless of the
//!   underlying method's signature (each impl wraps a `Cursor<Vec<u8>>`),
//!   and runs the type's invariant guards *before* returning — fail closed.
//! - [`DatPack::type_id`] returns the record's `DatFileType` discriminant
//!   (never a hardcoded magic number).
//! - [`DatPack::id`] returns the record's own file id.
//!
//! On top of that, [`hba_ext`] layers `add_typed` onto both `HbaWriter` and
//! `HbaStreamWriter`, mirroring C# `DatEasyWriter.Save<T>`: it calls
//! `obj.pack()?` then forwards `(namespace, obj.id(), obj.type_id(), bytes)`
//! to the existing raw `add`. The raw `add(Vec<u8>)` path is unchanged
//! (`add_typed` is purely additive).
//!
//! **Scope (E12b):** the `DatPack` trait + the two guarded types `GfxObj`
//! and `SetupModel` + the `add_typed` helpers. Region / Surface / Texture /
//! Palette / RenderSurface writers, ID/iteration allocation, and namespace
//! auto-routing are E12c and explicitly out of scope here.

pub mod error;
pub mod hba_ext;
pub mod pack;

pub use error::{Result, WriteError};

/// One trait that turns a typed DAT record into correctly-laid-out bytes,
/// with invariant guards, behind a single uniform signature.
///
/// Each impl lives in [`pack`] and delegates byte production to the type's
/// existing `pack`/`write` method in `holtburger-dat` (no serialization
/// logic is duplicated here), then validates the type's invariants and
/// fails closed via [`WriteError::InvariantViolation`] rather than emitting
/// malformed bytes.
pub trait DatPack {
    /// Serialize this record into a fresh byte buffer.
    ///
    /// Implementations MUST validate their invariants (E12 design §B.5) and
    /// return [`WriteError::InvariantViolation`] on any violation — never
    /// panic, never return malformed bytes. Whether validation runs before
    /// or after the byte production is an impl detail, but a violation must
    /// surface as `Err` and no partial/bad buffer may escape.
    fn pack(&self) -> Result<Vec<u8>>;

    /// The `DatFileType` discriminant for this record's file type.
    ///
    /// Sourced from `holtburger_dat::DatFileType` — never a hardcoded
    /// magic number.
    fn type_id(&self) -> u32;

    /// This record's own file id (the DAT entry key).
    fn id(&self) -> u32;
}
