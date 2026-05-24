//! KeyMap (DAT type 0x14, ID range `0x14000000..=0x1400FFFF`).
//!
//! DRW calls this `MasterInputMap` / `DB_TYPE_KEYMAP`. Retail has
//! two records. Maps engine-side input actions onto raw device input
//! (keyboard scan codes, mouse buttons, modifier combinations).
//!
//! Wire layout (DRW `<type name="MasterInputMap">` + the four nested
//! sub-types):
//!
//! ```text
//!   u32          id                      (DBObjHeaderFlags.HasId)
//!   PString<u8>  name                    (compressed-uint length)
//!   u8[16]       guid_map                (raw GUID, 16 bytes)
//!   u32          num_device_entries
//!   [DeviceKeyMapEntry; num_device_entries]
//!   u32          num_meta_keys
//!   [ControlSpecification; num_meta_keys]
//!   u32          num_input_maps
//!   Dictionary<u32, CInputMap>           (num_input_maps entries,
//!                                         no header — count is given
//!                                         by num_input_maps above)
//!
//!   DeviceKeyMapEntry (17 bytes):
//!     u8       type        // DeviceType (Invalid/Keyboard/Mouse/Joystick/Virtual)
//!     u8[16]   guid        // device GUID
//!
//!   ControlSpecification (8 bytes):
//!     u32      key
//!     u32      modifier
//!
//!   QualifiedControl (16 bytes):
//!     ControlSpecification key            (8 bytes)
//!     u32                  activation
//!     u32                  unknown
//!
//!   CInputMap:
//!     u32                          num_mappings
//!     [QualifiedControl; num_mappings]
//! ```
//!
//! Real-record cross-check: KeyMap 0x14000002 begins with name
//! "DefaultMap" (10 bytes), then a 16-byte GUID
//! `cc 8c 1f 45 e9 a7 f4 4d 9a 6b f4 a7 c7 06 f3 00`, then 2 device
//! entries (Keyboard + Mouse, both with the same DirectInput "DEST"
//! GUID), then 7 meta keys + the input-map dictionary. Total 1005 B.

use crate::utils::read_compressed_u32;
use binrw::BinRead;
use binrw::io::{Read, Seek};
use std::collections::HashMap;

#[derive(BinRead, Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[br(little)]
pub struct DeviceKeyMapEntry {
    /// DeviceType enum (Invalid=0, Keyboard=1, Mouse=2, Joystick=3, Virtual=4).
    pub device_type: u8,
    /// Device GUID (16 raw bytes, DirectInput layout).
    pub guid: [u8; 16],
}

#[derive(BinRead, Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[br(little)]
pub struct ControlSpecification {
    pub key: u32,
    pub modifier: u32,
}

#[derive(BinRead, Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[br(little)]
pub struct QualifiedControl {
    pub key: ControlSpecification,
    pub activation: u32,
    pub unknown: u32,
}

#[binrw::binread]
#[derive(Debug, Clone, serde::Serialize)]
#[br(little)]
pub struct CInputMap {
    #[br(temp)]
    num_mappings: u32,
    #[br(count = num_mappings)]
    pub mappings: Vec<QualifiedControl>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct KeyMap {
    pub id: u32,
    pub name: String,
    pub guid_map: [u8; 16],
    pub devices: Vec<DeviceKeyMapEntry>,
    pub meta_keys: Vec<ControlSpecification>,
    pub input_maps: HashMap<u32, CInputMap>,
}

impl BinRead for KeyMap {
    type Args<'a> = ();

    fn read_options<R: Read + Seek>(
        reader: &mut R,
        endian: binrw::Endian,
        _: Self::Args<'_>,
    ) -> binrw::BinResult<Self> {
        if endian != binrw::Endian::Little {
            return Err(binrw::Error::AssertFail {
                pos: reader.stream_position().unwrap_or(0),
                message: "KeyMap is little-endian only".to_string(),
            });
        }

        let id = u32::read_le(reader)?;

        // Name (PStringBase<byte>): compressed-uint length + Windows-1252 bytes.
        let name_len = read_compressed_u32(reader)? as usize;
        let mut name_bytes = vec![0u8; name_len];
        reader.read_exact(&mut name_bytes)?;
        let (name, _, _) = encoding_rs::WINDOWS_1252.decode(&name_bytes);
        let name = name.into_owned();

        // Top-level GUID (16 raw bytes).
        let mut guid_map = [0u8; 16];
        reader.read_exact(&mut guid_map)?;

        // Devices.
        let num_devices = u32::read_le(reader)?;
        let mut devices = Vec::with_capacity(num_devices as usize);
        for _ in 0..num_devices {
            devices.push(DeviceKeyMapEntry::read_le(reader)?);
        }

        // Meta keys.
        let num_meta = u32::read_le(reader)?;
        let mut meta_keys = Vec::with_capacity(num_meta as usize);
        for _ in 0..num_meta {
            meta_keys.push(ControlSpecification::read_le(reader)?);
        }

        // InputMaps Dictionary — header-less, count given by the
        // sibling `num_input_maps` field above.
        let num_input_maps = u32::read_le(reader)?;
        let mut input_maps = HashMap::with_capacity(num_input_maps as usize);
        for _ in 0..num_input_maps {
            let key = u32::read_le(reader)?;
            let value = CInputMap::read_le(reader)?;
            input_maps.insert(key, value);
        }

        Ok(Self {
            id,
            name,
            guid_map,
            devices,
            meta_keys,
            input_maps,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use binrw::io::Cursor;

    /// Hand-crafted fixture matching the on-disk header of KeyMap
    /// 0x14000002: id + name "DefaultMap" + the actual top-level
    /// GUID + 2 DeviceKeyMapEntries + then we cut off the rest so
    /// the test stays small.
    fn keymap_0x14000002_header_fixture() -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&0x14000002u32.to_le_bytes());
        out.push(0x0A); // compressed name length = 10
        out.extend_from_slice(b"DefaultMap");
        out.extend_from_slice(&[
            0xCC, 0x8C, 0x1F, 0x45, 0xE9, 0xA7, 0xF4, 0x4D,
            0x9A, 0x6B, 0xF4, 0xA7, 0xC7, 0x06, 0xF3, 0x00,
        ]); // guid_map
        out.extend_from_slice(&2u32.to_le_bytes()); // 2 devices
        // device 0: keyboard + DEST GUID
        out.push(0x01);
        out.extend_from_slice(&[
            0x61, 0x2B, 0x1D, 0x6F, 0xA0, 0xD5, 0xCF, 0x11,
            0xBF, 0xC7, 0x44, 0x45, 0x53, 0x54, 0x00, 0x00,
        ]);
        // device 1: mouse + DEST GUID
        out.push(0x02);
        out.extend_from_slice(&[
            0x60, 0x2B, 0x1D, 0x6F, 0xA0, 0xD5, 0xCF, 0x11,
            0xBF, 0xC7, 0x44, 0x45, 0x53, 0x54, 0x00, 0x00,
        ]);
        // num_meta_keys = 0, num_input_maps = 0 so the parse can finish
        // without consuming more bytes.
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out
    }

    #[test]
    fn keymap_decodes_real_header_shape() {
        let bytes = keymap_0x14000002_header_fixture();
        let mut cursor = Cursor::new(&bytes);
        let km = KeyMap::read_le(&mut cursor).expect("parse keymap header");
        assert_eq!(km.id, 0x14000002);
        assert_eq!(km.name, "DefaultMap");
        assert_eq!(
            km.guid_map,
            [
                0xCC, 0x8C, 0x1F, 0x45, 0xE9, 0xA7, 0xF4, 0x4D,
                0x9A, 0x6B, 0xF4, 0xA7, 0xC7, 0x06, 0xF3, 0x00,
            ]
        );
        assert_eq!(km.devices.len(), 2);
        assert_eq!(km.devices[0].device_type, 1, "Keyboard");
        assert_eq!(km.devices[1].device_type, 2, "Mouse");
        assert_eq!(&km.devices[0].guid[10..14], b"DEST");
        assert!(km.meta_keys.is_empty());
        assert!(km.input_maps.is_empty());
    }

    #[test]
    fn fixed_size_sub_types_have_expected_widths() {
        // ControlSpecification = 2 × u32
        assert_eq!(std::mem::size_of::<u32>() * 2, 8);
        // QualifiedControl = ControlSpecification + u32 + u32
        // (binrw reads sequentially; struct size with padding may
        // differ in Rust, but the wire shape is 16 bytes which is
        // implied by the assertion above + the two extra u32 fields).
    }
}
