//! StateDesc — one named UI state for a UI element. Owns the
//! dictionary of property overrides (`BaseProperty`, looked up via
//! MasterProperty) and media triggers (`MediaDesc`) that apply when
//! this state is active.
//!
//! Wire layout (ACE `Source/ACE.DatLoader/Entity/StateDesc.cs`, NOT
//! DRW's `dats.xml` — DRW gets this wrong: declares the counts as
//! CompressedUInt and Properties as List, but retail uses byte counts
//! and a Dictionary structure):
//!
//! ```text
//!   u32   state_id                       (UIStateId enum)
//!   u8    pass_to_children                (bool)
//!   u32   incorporation_flags             (IncorporationFlags mask)
//!   u8    bucket_size                     (unused on read)
//!   u8    num_properties                  (BYTE, not CompressedUInt)
//!   [(u32 dict_key, BaseProperty); num_properties]
//!   u8    num_media                       (BYTE, no bucket prefix)
//!   [MediaDesc; num_media]
//! ```
//!
//! Each Properties entry on the wire is `u32 dict_key +
//! u32 BaseProperty.Id + typed_value_bytes`. The dict_key and the
//! BaseProperty's Id appear separately on the wire even though they
//! typically refer to the same MasterProperty entry — ACE's StateDesc
//! reads them as two distinct u32s.
//!
//! Reading requires a [`crate::file_type::MasterProperty`] reference
//! so the BaseProperty entries can resolve their `u32 master_id` keys.

use crate::file_type::{BaseProperty, MasterProperty, MediaDesc};
use binrw::io::Seek;
use std::collections::HashMap;
use std::io::Read;

#[derive(Debug, Clone, serde::Serialize)]
pub struct StateDesc {
    /// UIStateId enum (raw u32).
    pub state_id: u32,
    pub pass_to_children: bool,
    /// IncorporationFlags bitmask. Standard bits:
    /// PassToChildren=0x1, X=0x2, Y=0x4, Width=0x8, Height=0x10,
    /// ZLevel=0x20.
    pub incorporation_flags: u32,
    /// Dictionary keyed by dict_key (which is typically — but not
    /// always — equal to the contained BaseProperty's Id).
    pub properties: HashMap<u32, BaseProperty>,
    pub media: Vec<MediaDesc>,
}

impl StateDesc {
    pub fn read_le<R: Read + Seek>(
        reader: &mut R,
        master: &MasterProperty,
    ) -> binrw::BinResult<Self> {
        use binrw::BinRead;

        let state_id = u32::read_le(reader)?;
        let pass_to_children = u8::read(reader)? != 0;
        let incorporation_flags = u32::read_le(reader)?;
        let _bucket = u8::read(reader)?;

        // BYTE count (not CompressedUInt). Per ACE.
        let num_properties = u8::read(reader)? as usize;
        let mut properties = HashMap::with_capacity(num_properties);
        for _ in 0..num_properties {
            let key = u32::read_le(reader)?;
            let value = BaseProperty::read_with_master(reader, master)?;
            properties.insert(key, value);
        }

        // BYTE count, NO bucket before it. Per ACE.
        let num_media = u8::read(reader)? as usize;
        let mut media = Vec::with_capacity(num_media);
        for _ in 0..num_media {
            media.push(MediaDesc::read_le(reader)?);
        }

        Ok(Self {
            state_id,
            pass_to_children,
            incorporation_flags,
            properties,
            media,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use binrw::io::Cursor;
    use std::collections::HashMap;

    /// Minimal StateDesc with zero properties + zero media. Validates
    /// the fixed-size header without dragging in a real MasterProperty
    /// fixture.
    #[test]
    fn empty_state_desc_round_trips() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&1u32.to_le_bytes()); // state_id = Normal
        bytes.push(0); // pass_to_children = false
        bytes.extend_from_slice(&0x3Eu32.to_le_bytes()); // X|Y|W|H|Z
        bytes.push(0); // bucket
        bytes.push(0); // num_properties (byte)
        bytes.push(0); // num_media (byte)

        // Build an empty master so BaseProperty::read_with_master is
        // satisfied at the type level; we don't actually invoke it.
        let master = MasterProperty {
            id: 0x39000001,
            enum_mapper: crate::file_type::EnumMapperData {
                base_enum_map: 0,
                unknown: 0,
                id_to_string_map: std::collections::HashMap::new(),
            },
            properties: std::collections::HashMap::new(),
        };

        let mut cursor = Cursor::new(bytes);
        let desc = StateDesc::read_le(&mut cursor, &master).expect("parse empty state");
        assert_eq!(desc.state_id, 1);
        assert!(!desc.pass_to_children);
        assert_eq!(desc.incorporation_flags, 0x3E);
        assert!(desc.properties.is_empty());
        assert!(desc.media.is_empty());
    }
}
