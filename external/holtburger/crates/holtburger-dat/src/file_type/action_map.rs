//! ActionMap (DAT type 0x26, ID range `0x26000000..=0x2600FFFF`).
//!
//! Keyboard/input-action binding table — maps engine-side action IDs
//! to user-bindable key combinations. Retail has a single record
//! (0x26000000, 12,303 bytes).
//!
//! Wire layout (per ACE `Source/ACE.DatLoader/FileTypes/ActionMap.cs`
//! — DRW's `dats.xml` body is empty for this type, so ACE is the
//! only documented source):
//!
//! ```text
//!   u32   id
//!   u8    bucket
//!   u8    num_input_maps
//!   N × {
//!     u32 key
//!     u8  bucket
//!     u8  num_values
//!     M × {
//!       u32             values_key
//!       ActionMapValue              // 25 bytes (see below)
//!     }
//!   }
//!   u32   string_table_data_id     // canonically 0x23000005
//!   u8    bucket
//!   u8    num_conflicts
//!   P × {
//!     u32 key
//!     InputMapConflictsValue        // 4 (input_map u32) + List<u32>
//!                                   //    (i32 count + count × u32)
//!   }
//!
//!   ActionMapValue (25 bytes):
//!     u8                       unknown_byte
//!     u32                      unknown_int_1
//!     u32                      unknown_int_2
//!     u32                      toggle_type
//!     UserBindingValue              // 12 bytes (3 × u32):
//!                                   //   action_class, action_name, description
//!
//!   ActionMapValue.UserBindingValue.action_name and .description are
//!   both hashed string keys into the StringTable referenced by the
//!   top-level `string_table_data_id` (typically 0x23000005).
//! ```

use binrw::io::Seek;
use std::collections::HashMap;
use std::io::Read;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct UserBindingValue {
    pub action_class: u32,
    /// String hash for the action name; resolves against the
    /// StringTable at `ActionMap::string_table_data_id`.
    pub action_name: u32,
    pub description: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct ActionMapValue {
    pub unknown_byte: u8,
    pub unknown_int_1: u32,
    pub unknown_int_2: u32,
    pub toggle_type: u32,
    pub user_binding: UserBindingValue,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct InputMapConflictsValue {
    pub input_map: u32,
    pub conflicting_input_maps: Vec<u32>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ActionMap {
    pub id: u32,
    /// Outer key → (inner key → ActionMapValue). Two-level dictionary.
    pub input_maps: HashMap<u32, HashMap<u32, ActionMapValue>>,
    /// StringTable DataID for resolving `UserBindingValue.action_name`
    /// and `.description` hashes. Canonically 0x23000005 in retail.
    pub string_table_data_id: u32,
    pub conflicting_maps: HashMap<u32, InputMapConflictsValue>,
}

impl ActionMap {
    /// Parse from raw bytes. Mirrors Font/Texture/StringTable unpack.
    pub fn unpack(data: &[u8]) -> binrw::BinResult<Self> {
        let mut cursor = binrw::io::Cursor::new(data);
        Self::read_le(&mut cursor)
    }

    pub fn read_le<R: Read + Seek>(reader: &mut R) -> binrw::BinResult<Self> {
        use binrw::BinRead;

        let id = u32::read_le(reader)?;
        let _bucket = u8::read(reader)?;
        let num_input_maps = u8::read(reader)? as usize;

        let mut input_maps = HashMap::with_capacity(num_input_maps);
        for _ in 0..num_input_maps {
            let key = u32::read_le(reader)?;
            let _bucket = u8::read(reader)?;
            let num_values = u8::read(reader)? as usize;
            let mut values = HashMap::with_capacity(num_values);
            for _ in 0..num_values {
                let values_key = u32::read_le(reader)?;
                values.insert(values_key, read_action_map_value(reader)?);
            }
            input_maps.insert(key, values);
        }

        let string_table_data_id = u32::read_le(reader)?;

        let _bucket = u8::read(reader)?;
        let num_conflicts = u8::read(reader)? as usize;
        let mut conflicting_maps = HashMap::with_capacity(num_conflicts);
        for _ in 0..num_conflicts {
            let key = u32::read_le(reader)?;
            let input_map = u32::read_le(reader)?;
            // ACE `List<uint>.Unpack` reads i32 count + count × u32.
            // Rust review 2026-08-03 (F5): see `file_type/palette.rs` — negative
            // count sign-extended into `with_capacity`.
            let conflict_count = i32::read_le(reader)?.max(0) as usize;
            let mut conflicting_input_maps =
                Vec::with_capacity(crate::utils::safe_capacity(reader, conflict_count, 4)?);
            for _ in 0..conflict_count {
                conflicting_input_maps.push(u32::read_le(reader)?);
            }
            conflicting_maps.insert(
                key,
                InputMapConflictsValue {
                    input_map,
                    conflicting_input_maps,
                },
            );
        }

        Ok(Self {
            id,
            input_maps,
            string_table_data_id,
            conflicting_maps,
        })
    }
}

fn read_action_map_value<R: Read + Seek>(reader: &mut R) -> binrw::BinResult<ActionMapValue> {
    use binrw::BinRead;
    let unknown_byte = u8::read(reader)?;
    let unknown_int_1 = u32::read_le(reader)?;
    let unknown_int_2 = u32::read_le(reader)?;
    let toggle_type = u32::read_le(reader)?;
    let user_binding = UserBindingValue {
        action_class: u32::read_le(reader)?,
        action_name: u32::read_le(reader)?,
        description: u32::read_le(reader)?,
    };
    Ok(ActionMapValue {
        unknown_byte,
        unknown_int_1,
        unknown_int_2,
        toggle_type,
        user_binding,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use binrw::io::Cursor;

    /// Hand-built minimal ActionMap: id + outer header (bucket=0, count=0)
    /// + string_table_data_id + conflicts header (bucket=0, count=0).
    /// Validates the fixed-size scaffolding.
    #[test]
    fn minimal_action_map_round_trips() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&0x26000000u32.to_le_bytes());
        bytes.push(0); // bucket
        bytes.push(0); // num_input_maps
        bytes.extend_from_slice(&0x23000005u32.to_le_bytes()); // string table
        bytes.push(0); // bucket
        bytes.push(0); // num_conflicts

        let mut cursor = Cursor::new(&bytes);
        let am = ActionMap::read_le(&mut cursor).expect("parse");
        assert_eq!(am.id, 0x26000000);
        assert!(am.input_maps.is_empty());
        assert_eq!(am.string_table_data_id, 0x23000005);
        assert!(am.conflicting_maps.is_empty());
        assert_eq!(cursor.position() as usize, bytes.len(), "no leftover bytes");
    }
}
