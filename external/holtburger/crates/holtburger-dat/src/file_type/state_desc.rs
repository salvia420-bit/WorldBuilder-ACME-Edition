//! StateDesc — one named UI state for a UI element. Owns the list of
//! property overrides (`BaseProperty[]`, looked up via MasterProperty)
//! and media triggers (`MediaDesc[]`) that apply when this state is
//! active.
//!
//! Wire layout (DRW `<type name="StateDesc">`):
//!
//! ```text
//!   u32           state_id              (UIStateId enum)
//!   u8            pass_to_children       (bool, size=1 → 1 byte)
//!   u32           incorporation_flags    (IncorporationFlags mask)
//!   u8            _num_buckets          (always 0 in retail — written
//!                                        but unused on read)
//!   CompressedUInt num_properties
//!   [BaseProperty; num_properties]      (master-lookup form)
//!   CompressedUInt num_media
//!   [MediaDesc;    num_media]
//! ```
//!
//! Reading requires a [`crate::file_type::MasterProperty`] reference
//! so the BaseProperty entries can resolve their `u32 master_id` keys.

use crate::file_type::{BaseProperty, MasterProperty, MediaDesc};
use crate::utils::read_compressed_u32;
use binrw::io::Seek;
use std::io::Read;

/// Same sanity cap as `layout::LAYOUT_DICT_COUNT_CAP`. Surfaces a clear
/// error on misread CompressedUInt counts before HashMap::with_capacity
/// can OOM the process.
const STATE_COUNT_CAP: u32 = 65_536;

fn checked_count<R: Read + Seek>(
    reader: &mut R,
    raw: u32,
    field: &'static str,
) -> binrw::BinResult<usize> {
    if raw > STATE_COUNT_CAP {
        return Err(binrw::Error::Custom {
            pos: reader.stream_position().unwrap_or(0),
            err: Box::new(format!(
                "{field} count {raw} exceeds sanity cap {STATE_COUNT_CAP} (likely upstream desync)"
            )),
        });
    }
    Ok(raw as usize)
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct StateDesc {
    /// UIStateId enum (raw u32; see DRW's UIStateId table for canonical
    /// values like Normal=1, Normal_rollover=2, Highlight=6 …).
    pub state_id: u32,
    pub pass_to_children: bool,
    /// IncorporationFlags bitmask. Standard bits:
    /// PassToChildren=0x1, X=0x2, Y=0x4, Width=0x8, Height=0x10,
    /// ZLevel=0x20. ElementDesc gates conditional position/size
    /// fields on this mask.
    pub incorporation_flags: u32,
    pub properties: Vec<BaseProperty>,
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
        let _num_buckets = u8::read(reader)?;

        let raw_props = read_compressed_u32(reader)?;
        let num_properties = checked_count(reader, raw_props, "StateDesc.properties")?;
        let mut properties = Vec::with_capacity(num_properties);
        for _ in 0..num_properties {
            properties.push(BaseProperty::read_with_master(reader, master)?);
        }

        let raw_media = read_compressed_u32(reader)?;
        let num_media = checked_count(reader, raw_media, "StateDesc.media")?;
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
        bytes.push(0); // num_buckets
        bytes.push(0); // num_properties (CompressedUInt single-byte)
        bytes.push(0); // num_media

        // Build an empty master so BaseProperty::read_with_master is
        // satisfied at the type level; we don't actually invoke it.
        let master = MasterProperty {
            id: 0x39000001,
            enum_mapper: crate::file_type::EnumMapperData {
                base_enum_map: 0,
                unknown: 0,
                id_to_string_map: HashMap::new(),
            },
            properties: HashMap::new(),
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
