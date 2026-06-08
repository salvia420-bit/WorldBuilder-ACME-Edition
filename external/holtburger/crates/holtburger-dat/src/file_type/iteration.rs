//! AC Iteration (file ID `0xFFFF0001`) — the DAT "versioning" record.
//! Stored in `client_cell.dat`, `client_portal.dat`, and
//! `client_local_English.dat` at the well-known index `0xFFFF0001`.
//! Used during connect to compare client vs. server DAT iteration so the
//! client knows what (if anything) needs patching.
//!
//! Format (mirrors `ACE.DatLoader/FileTypes/Iteration.cs::Unpack`):
//! ```text
//! [i32 ints[0]]
//! [i32 ints[1]]
//! [bool sorted]      // a single byte, 0 / 1
//! <align to next 4-byte (DWORD) boundary>
//! ```
//!
//! Note there is no leading `id` field in the record body — the file ID
//! is the directory index. Read-only; no write path.

use crate::utils::align_boundary;
use binrw::{BinRead, BinResult};
use std::io::{Read, Seek};

/// Well-known DAT directory index for the Iteration record.
pub const FILE_ID: u32 = 0xFFFF_0001;

#[derive(Debug, Clone, serde::Serialize)]
pub struct Iteration {
    /// The two iteration integers, in file order.
    pub ints: Vec<i32>,
    /// Whether the iteration list is sorted (single-byte boolean).
    pub sorted: bool,
}

impl Iteration {
    pub const FILE_ID: u32 = FILE_ID;

    pub fn read<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        Self::read_internal(reader)
    }

    pub fn unpack(data: &[u8]) -> Result<Self, binrw::Error> {
        let mut cursor = std::io::Cursor::new(data);
        Self::read_internal(&mut cursor)
    }

    fn read_internal<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let a = i32::read_le(reader)?;
        let b = i32::read_le(reader)?;
        let sorted = u8::read_le(reader)? != 0;
        align_boundary(reader, 4)?;
        Ok(Self {
            ints: vec![a, b],
            sorted,
        })
    }
}

impl BinRead for Iteration {
    type Args<'a> = ();

    fn read_options<R: Read + Seek>(
        reader: &mut R,
        _endian: binrw::Endian,
        _args: Self::Args<'_>,
    ) -> BinResult<Self> {
        Self::read_internal(reader)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unpacks_sorted_iteration_and_aligns() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&252i32.to_le_bytes()); // ints[0]
        buf.extend_from_slice(&1i32.to_le_bytes()); // ints[1]
        buf.push(1); // sorted = true
        // After 9 bytes the DWORD-align pad should consume 3 trailing bytes.
        buf.extend_from_slice(&[0u8, 0u8, 0u8]);
        // A trailing sentinel that must NOT be consumed.
        buf.extend_from_slice(&0xDEADBEEFu32.to_le_bytes());

        let mut cursor = std::io::Cursor::new(&buf);
        let it = Iteration::read(&mut cursor).unwrap();
        assert_eq!(it.ints, vec![252, 1]);
        assert!(it.sorted);
        // Cursor must sit on a 4-byte boundary at the sentinel.
        assert_eq!(cursor.position(), 12);
        assert_eq!(u32::read_le(&mut cursor).unwrap(), 0xDEADBEEF);
    }

    #[test]
    fn unpacks_unsorted_iteration() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&(-5i32).to_le_bytes());
        buf.extend_from_slice(&42i32.to_le_bytes());
        buf.push(0); // sorted = false
        let it = Iteration::unpack(&buf).unwrap();
        assert_eq!(it.ints, vec![-5, 42]);
        assert!(!it.sorted);
    }
}
