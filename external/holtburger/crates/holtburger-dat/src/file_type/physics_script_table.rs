//! AC PhysicsScriptTable (DatFileType 0x34) — maps a `PlayScript`
//! enum key (u32) onto a weighted list of PhysicsScript IDs. The
//! client's particle-system uses this to pick one PhysicsScript
//! (0x33...) for a given play-script event, with `mod` acting as a
//! per-entry weight / selection threshold.
//!
//! ID range: `0x34000000..=0x3400FFFF`. The retail EOR table at
//! `0x34000004` carries 139 entries and is referenced by
//! `DatReaderWriter.Tests/DBObjs/PhysicsScriptTableTests.cs` as the
//! canonical shape.
//!
//! Format (mirrors `DatReaderWriter/dats.xml`'s `PhysicsScriptTable`,
//! `PhysicsScriptTableData`, and `ScriptAndModData` types):
//! ```text
//! [u32 id]
//! [u32 num_entries]
//! Entry × num_entries:
//!   [u32 play_script_key]                  // PlayScript enum
//!   [u32 num_scripts]                      // PhysicsScriptTableData header
//!   ScriptAndModData × num_scripts:
//!     [f32 mod]                            // weight / selection threshold
//!     [u32 script_id]                      // QualifiedDataId<PhysicsScript> -> u32
//! ```
//!
//! Note `ScriptAndModData` has `mod` (f32) FIRST, then `script_id`
//! (u32) — schema and `ACE.Server.Physics/ScriptAndModData.cs` both
//! agree. The Dictionary wire form emits no inner header; the outer
//! `num_entries` u32 prefixed before the pair stream is what bounds
//! it.

use binrw::{
    BinRead, BinResult,
    io::{Read, Seek},
};
use std::collections::HashMap;

/// One `(mod, script_id)` pair inside a `PhysicsScriptTableData`. The
/// schema name in `dats.xml` is `ScriptAndModData`; ACE calls the
/// fields `Mod` and `ScriptID` respectively.
#[derive(Debug, Clone, serde::Serialize)]
pub struct PhysicsScriptTableEntry {
    /// Weight / selection threshold for this PhysicsScript reference.
    pub mod_value: f32,
    /// PhysicsScript DAT ID (0x33000000..=0x3300FFFF).
    pub script_id: u32,
}

impl PhysicsScriptTableEntry {
    pub fn read<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let mod_value = f32::read_le(reader)?;
        let script_id = u32::read_le(reader)?;
        Ok(Self {
            mod_value,
            script_id,
        })
    }
}

/// The value side of one `PhysicsScriptTable` dictionary entry — a
/// flat list of `(mod, script_id)` pairs. Schema name:
/// `PhysicsScriptTableData`.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct PhysicsScriptTableData {
    pub scripts: Vec<PhysicsScriptTableEntry>,
}

impl PhysicsScriptTableData {
    pub fn read<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let num_scripts = u32::read_le(reader)? as usize;
        let mut scripts = Vec::with_capacity(num_scripts);
        for _ in 0..num_scripts {
            scripts.push(PhysicsScriptTableEntry::read(reader)?);
        }
        Ok(Self { scripts })
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct PhysicsScriptTable {
    pub id: u32,
    /// Keyed by `PlayScript` enum (u32). Use the raw u32 here so we
    /// don't need to ship the whole `PlayScript` enum just to parse.
    pub script_table: HashMap<u32, PhysicsScriptTableData>,
}

impl PhysicsScriptTable {
    pub fn read<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let id = u32::read_le(reader)?;
        let num_entries = u32::read_le(reader)? as usize;
        let mut script_table = HashMap::with_capacity(num_entries);
        for _ in 0..num_entries {
            let key = u32::read_le(reader)?;
            let value = PhysicsScriptTableData::read(reader)?;
            script_table.insert(key, value);
        }
        Ok(Self { id, script_table })
    }

    pub fn unpack(data: &[u8]) -> Result<Self, binrw::Error> {
        let mut cursor = std::io::Cursor::new(data);
        Self::read(&mut cursor)
    }
}
