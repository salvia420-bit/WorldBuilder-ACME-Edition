//! Write-side error type for `holtburger-dat-write`.
//!
//! [`WriteError`] is the single error surface a `DatPack` impl (and the
//! `add_typed` container helpers) returns. It wraps the two error families a
//! pack path can hit on the way to bytes — `binrw::Error` (raw
//! serialization) and [`holtburger_dat::DatError`] (container / namespace /
//! duplicate-id) — and adds [`WriteError::InvariantViolation`], the
//! GAUGE-core variant.
//!
//! The invariant guards in `pack/` MUST fail closed by returning
//! `InvariantViolation` (never panic, never emit malformed bytes). The
//! variant carries the `type_id` and `file_id` of the offending record plus
//! a human-readable `reason` so a malformed mesh/placement record is
//! attributable at the call site, not silently written to disk.

use holtburger_dat::DatError;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum WriteError {
    /// Raw `binrw` (de)serialization failure while packing a record into its
    /// byte buffer.
    #[error("binrw serialization error: {0}")]
    BinRw(#[from] binrw::Error),

    /// Container-level failure — duplicate `(namespace, file_id)`, invalid
    /// namespace, IO, etc. Bridged from the underlying `holtburger-dat`
    /// container writers (`HbaWriter` / `HbaStreamWriter`).
    #[error("dat container error: {0}")]
    Dat(#[from] DatError),

    /// A pre-write invariant guard rejected the record (the GAUGE core).
    ///
    /// `type_id` is the `DatFileType` discriminant of the record, `file_id`
    /// is the record's own id, and `reason` is a user-readable description of
    /// which invariant failed (e.g. a forbidden stippling flag or a UV /
    /// vertex count mismatch). This is returned *before* any bytes are
    /// committed, so a violation never produces a malformed DAT entry.
    #[error("invariant violation for type 0x{type_id:08X} file 0x{file_id:08X}: {reason}")]
    InvariantViolation {
        type_id: u32,
        file_id: u32,
        reason: String,
    },
}

pub type Result<T> = std::result::Result<T, WriteError>;
