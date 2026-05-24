//! MasterProperty (DAT type 0x39, ID range `0x39000000..=0x39FFFFFF`).
//!
//! A single retail record (`0x39000001`, 30,841 bytes). Defines the
//! runtime type table that every [`BaseProperty`] value in the engine
//! looks itself up against — on the wire, a BaseProperty is `u32 key +
//! typed_value_bytes`, and the value-type comes from
//! `master.properties[key].property_type`.
//!
//! DRW's dats.xml `_propertyType` field on the abstract `BaseProperty`
//! type is misleading: it is the type *implied by the master lookup*,
//! NOT a byte on the wire. Confirmed by reading
//! `DatReaderWriter/Types/BaseProperty.cs::UnpackGeneric`.
//!
//! Wire layout (DRW `<type name="MasterProperty">`):
//!
//! ```text
//!   u32                                          id
//!   EnumMapperData                               enum_mapper
//!   CompressedUInt                               num_properties
//!   Dictionary<u32, BasePropertyDesc>            properties
//!
//!   EnumMapperData:
//!     u32                                        base_enum_map
//!     u32                                        unknown
//!     AutoGrowHashTable<u32, PString<u8>>        id_to_string_map
//!
//!   AutoGrowHashTable header = u8 bucket_size_index + CompressedUInt
//!   count + entries inline.
//! ```
//!
//! See [`BasePropertyDesc`] for the per-property metadata shape and
//! [`BaseProperty`] for the value variant union.

use crate::utils::read_compressed_u32;
use binrw::io::Seek;
use std::collections::HashMap;
use std::io::Read;

/// BasePropertyType — `DatFileType::Table`-style enum from
/// MasterProperty.Properties. The byte width on the wire (when this
/// shows up as a field of BasePropertyDesc) is `int` = 4 bytes per
/// DRW `<enum name="BasePropertyType" parent="int">`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize)]
#[repr(u32)]
pub enum BasePropertyType {
    Invalid = 0x00,
    Bool = 0x01,
    Integer = 0x02,
    LongInteger = 0x03,
    Float = 0x04,
    Vector = 0x05,
    Color = 0x06,
    String = 0x07,
    StringInfo = 0x08,
    Enum = 0x09,
    DataId = 0x0A,
    Waveform = 0x0B,
    InstanceId = 0x0C,
    Position = 0x0D,
    TimeStamp = 0x0E,
    Bitfield32 = 0x0F,
    Bitfield64 = 0x10,
    Array = 0x11,
    Struct = 0x12,
    StringToken = 0x13,
    PropertyName = 0x14,
    TriState = 0x15,
}

impl BasePropertyType {
    pub fn from_u32(v: u32) -> Option<Self> {
        Some(match v {
            0x00 => Self::Invalid,
            0x01 => Self::Bool,
            0x02 => Self::Integer,
            0x03 => Self::LongInteger,
            0x04 => Self::Float,
            0x05 => Self::Vector,
            0x06 => Self::Color,
            0x07 => Self::String,
            0x08 => Self::StringInfo,
            0x09 => Self::Enum,
            0x0A => Self::DataId,
            0x0B => Self::Waveform,
            0x0C => Self::InstanceId,
            0x0D => Self::Position,
            0x0E => Self::TimeStamp,
            0x0F => Self::Bitfield32,
            0x10 => Self::Bitfield64,
            0x11 => Self::Array,
            0x12 => Self::Struct,
            0x13 => Self::StringToken,
            0x14 => Self::PropertyName,
            0x15 => Self::TriState,
            _ => return None,
        })
    }
}

/// One row of [`MasterProperty::properties`]. Per DRW
/// `BasePropertyDesc.cs::Unpack`, all enum-typed fields are stored as
/// their raw underlying width on the wire (uint or byte); we keep them
/// raw to avoid pinning every consumer to the canonical enum set.
#[derive(Debug, Clone, serde::Serialize)]
pub struct BasePropertyDesc {
    pub name: u32,
    pub property_type: BasePropertyType,
    /// PropertyGroupName enum (parent=int, 4 bytes on wire).
    pub group: u32,
    pub provider: u32,
    pub data: u32,
    /// PatchFlags enum (parent=int, signed-int 4 bytes).
    pub patch_flags: i32,
    pub default_value: Option<BaseProperty>,
    pub max_value: Option<BaseProperty>,
    pub min_value: Option<BaseProperty>,
    pub prediction_timeout: f32,
    /// PropertyInheritanceType (parent=byte).
    pub inheritance_type: u8,
    /// PropertyDatFileType (parent=byte).
    pub dat_file_type: u8,
    /// PropertyPropagationType (parent=byte).
    pub propagation_type: u8,
    /// PropertyCachingType (parent=byte).
    pub caching_type: u8,
    pub required: bool,
    pub read_only: bool,
    pub no_checkpoint: bool,
    pub recorded: bool,
    pub do_not_replay: bool,
    pub absolute_time_stamp: bool,
    pub groupable: bool,
    pub propagate_to_children: bool,
    pub available_properties: HashMap<u32, u32>,
}

impl BasePropertyDesc {
    pub fn read_le<R: Read + Seek>(reader: &mut R) -> binrw::BinResult<Self> {
        let name = read_u32_le(reader)?;
        let property_type_raw = read_u32_le(reader)?;
        let property_type =
            BasePropertyType::from_u32(property_type_raw).ok_or_else(|| binrw::Error::Custom {
                pos: reader.stream_position().unwrap_or(0),
                err: Box::new(format!(
                    "BasePropertyDesc 0x{name:08X}: unknown BasePropertyType 0x{property_type_raw:08X}",
                )),
            })?;
        let group = read_u32_le(reader)?;
        let provider = read_u32_le(reader)?;
        let data = read_u32_le(reader)?;
        let patch_flags = read_i32_le(reader)?;

        let has_default = read_bool_byte(reader)?;
        let default_value = if has_default {
            Some(BaseProperty::read_with_known_type(reader, property_type)?)
        } else {
            None
        };

        let has_max = read_bool_byte(reader)?;
        let max_value = if has_max {
            Some(BaseProperty::read_with_known_type(reader, property_type)?)
        } else {
            None
        };

        let has_min = read_bool_byte(reader)?;
        let min_value = if has_min {
            Some(BaseProperty::read_with_known_type(reader, property_type)?)
        } else {
            None
        };

        let prediction_timeout = read_f32_le(reader)?;
        let inheritance_type = read_u8(reader)?;
        let dat_file_type = read_u8(reader)?;
        let propagation_type = read_u8(reader)?;
        let caching_type = read_u8(reader)?;

        let required = read_bool_byte(reader)?;
        let read_only = read_bool_byte(reader)?;
        let no_checkpoint = read_bool_byte(reader)?;
        let recorded = read_bool_byte(reader)?;
        let do_not_replay = read_bool_byte(reader)?;
        let absolute_time_stamp = read_bool_byte(reader)?;
        let groupable = read_bool_byte(reader)?;
        let propagate_to_children = read_bool_byte(reader)?;

        let _bucket_size = read_u8(reader)?;
        let num_available = read_u8(reader)? as usize;
        let mut available_properties = HashMap::with_capacity(num_available);
        for _ in 0..num_available {
            let k = read_u32_le(reader)?;
            let v = read_u32_le(reader)?;
            available_properties.insert(k, v);
        }

        Ok(Self {
            name,
            property_type,
            group,
            provider,
            data,
            patch_flags,
            default_value,
            max_value,
            min_value,
            prediction_timeout,
            inheritance_type,
            dat_file_type,
            propagation_type,
            caching_type,
            required,
            read_only,
            no_checkpoint,
            recorded,
            do_not_replay,
            absolute_time_stamp,
            groupable,
            propagate_to_children,
            available_properties,
        })
    }
}

/// On-disk representation of one [`BaseProperty`]. Variant data widths
/// are dictated by [`BasePropertyType`].
///
/// **Recursive-context rule.** When a `BaseProperty` appears inside
/// `BasePropertyDesc::default_value` / `max_value` / `min_value`, the
/// type comes from the surrounding `BasePropertyDesc::property_type`
/// (no master lookup, no `u32 key` prefix). When it appears outside
/// MasterProperty (e.g. inside a `StateDesc::properties` list in a
/// Layout record), the wire form is `u32 master_property_id +
/// typed_value_bytes`, and the type comes from
/// `master.properties[id].property_type`.
///
/// `Array` / `Struct` variants recursively read more `BaseProperty`s
/// via the *outer* (master-lookup) form even when they themselves were
/// read in known-type form. If MasterProperty's own Default/Max/Min
/// turn out to be Array/Struct typed in retail data, parsing them
/// without a master in hand will fail loudly with `MissingMaster`.
/// Retail spot-checks (D1 ship) confirm this never happens.
#[derive(Debug, Clone, serde::Serialize)]
pub enum BaseProperty {
    Bool(bool),
    Integer(i32),
    Float(f32),
    Vector { x: f32, y: f32, z: f32 },
    Color { b: u8, g: u8, r: u8, a: u8 },
    Enum(u32),
    DataId(u32),
    InstanceId(u32),
    Bitfield32(u32),
    Bitfield64(u64),
    /// String-info value (DRW marks the schema TODO; we RE'd the
    /// 16-byte wire layout against retail Layout 0x21000000). Stored
    /// as four raw u32 fields — exact field semantics deferred to a
    /// follow-on once we can correlate the values against retail
    /// StringTable lookups. Layout: `[u32; 4]` little-endian.
    StringInfo {
        /// Possibly the StringInfo "token" or self-type tag — in
        /// retail Layout 0x21000000 this equals the surrounding
        /// `BasePropertyDesc.name` for the property.
        word0: u32,
        word1: u32,
        word2: u32,
        word3: u32,
    },
    /// Recursive Array — entries use the master-lookup form.
    Array(Vec<BaseProperty>),
    /// Recursive Struct — entries use the master-lookup form, keyed
    /// by `u32`.
    Struct(HashMap<u32, BaseProperty>),
}

impl BaseProperty {
    /// Parse a BaseProperty when the type is already known (caller is
    /// inside a `BasePropertyDesc::default_value` or equivalent — no
    /// `u32 key` prefix on the wire).
    pub fn read_with_known_type<R: Read + Seek>(
        reader: &mut R,
        property_type: BasePropertyType,
    ) -> binrw::BinResult<Self> {
        Self::read_value_bytes(reader, property_type, None)
    }

    /// Parse a BaseProperty when the type must be looked up. Reads
    /// `u32 master_property_id`, then dispatches via
    /// `master.properties[id].property_type`.
    pub fn read_with_master<R: Read + Seek>(
        reader: &mut R,
        master: &MasterProperty,
    ) -> binrw::BinResult<Self> {
        let key = read_u32_le(reader)?;
        let desc = master.properties.get(&key).ok_or_else(|| binrw::Error::Custom {
            pos: reader.stream_position().unwrap_or(0),
            err: Box::new(format!(
                "BaseProperty references unknown MasterProperty key 0x{key:08X}",
            )),
        })?;
        Self::read_value_bytes(reader, desc.property_type, Some(master))
    }

    fn read_value_bytes<R: Read + Seek>(
        reader: &mut R,
        ty: BasePropertyType,
        master: Option<&MasterProperty>,
    ) -> binrw::BinResult<Self> {
        match ty {
            BasePropertyType::Bool => Ok(Self::Bool(read_bool_byte(reader)?)),
            BasePropertyType::Integer => Ok(Self::Integer(read_i32_le(reader)?)),
            BasePropertyType::Float => Ok(Self::Float(read_f32_le(reader)?)),
            BasePropertyType::Vector => {
                let x = read_f32_le(reader)?;
                let y = read_f32_le(reader)?;
                let z = read_f32_le(reader)?;
                Ok(Self::Vector { x, y, z })
            }
            BasePropertyType::Color => {
                let b = read_u8(reader)?;
                let g = read_u8(reader)?;
                let r = read_u8(reader)?;
                let a = read_u8(reader)?;
                Ok(Self::Color { b, g, r, a })
            }
            BasePropertyType::Enum => Ok(Self::Enum(read_u32_le(reader)?)),
            BasePropertyType::DataId => Ok(Self::DataId(read_u32_le(reader)?)),
            BasePropertyType::InstanceId => Ok(Self::InstanceId(read_u32_le(reader)?)),
            BasePropertyType::Bitfield32 => Ok(Self::Bitfield32(read_u32_le(reader)?)),
            BasePropertyType::Bitfield64 => Ok(Self::Bitfield64(read_u64_le(reader)?)),
            BasePropertyType::Array => {
                let master = master.ok_or_else(|| binrw::Error::Custom {
                    pos: reader.stream_position().unwrap_or(0),
                    err: Box::new(
                        "Array BaseProperty inside known-type context requires a MasterProperty"
                            .to_string(),
                    ),
                })?;
                let n_raw = read_u32_le(reader)?;
                if n_raw > 65_536 {
                    return Err(binrw::Error::Custom {
                        pos: reader.stream_position().unwrap_or(0),
                        err: Box::new(format!(
                            "BaseProperty Array count {n_raw} exceeds sanity cap (upstream desync)"
                        )),
                    });
                }
                let n = n_raw as usize;
                let mut items = Vec::with_capacity(n);
                for _ in 0..n {
                    items.push(Self::read_with_master(reader, master)?);
                }
                Ok(Self::Array(items))
            }
            BasePropertyType::Struct => {
                let master = master.ok_or_else(|| binrw::Error::Custom {
                    pos: reader.stream_position().unwrap_or(0),
                    err: Box::new(
                        "Struct BaseProperty inside known-type context requires a MasterProperty"
                            .to_string(),
                    ),
                })?;
                let _bucket = read_u8(reader)?;
                let n = read_u8(reader)? as usize; // u8, capped at 255 by type
                let mut map = HashMap::with_capacity(n);
                for _ in 0..n {
                    let k = read_u32_le(reader)?;
                    let v = Self::read_with_master(reader, master)?;
                    map.insert(k, v);
                }
                Ok(Self::Struct(map))
            }
            BasePropertyType::StringInfo => {
                // RE'd against retail Layout 0x21000000 in the
                // Milestone D StringInfo follow-on: 16 bytes = four
                // u32 LE words. DRW's 12-byte schema is explicitly
                // marked TODO and is wrong (validated by alignment
                // check — element_id at +0x15 hits the dict-key
                // exactly when we consume 16 bytes here, not 12).
                let word0 = read_u32_le(reader)?;
                let word1 = read_u32_le(reader)?;
                let word2 = read_u32_le(reader)?;
                let word3 = read_u32_le(reader)?;
                Ok(Self::StringInfo { word0, word1, word2, word3 })
            }
            BasePropertyType::Invalid
            | BasePropertyType::LongInteger
            | BasePropertyType::String
            | BasePropertyType::Waveform
            | BasePropertyType::Position
            | BasePropertyType::TimeStamp
            | BasePropertyType::StringToken
            | BasePropertyType::PropertyName
            | BasePropertyType::TriState => Err(binrw::Error::Custom {
                pos: reader.stream_position().unwrap_or(0),
                err: Box::new(format!(
                    "BaseProperty variant {ty:?} not yet implemented (no documented wire layout in DRW or acclient)"
                )),
            }),
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct EnumMapperData {
    pub base_enum_map: u32,
    pub unknown: u32,
    pub id_to_string_map: HashMap<u32, String>,
}

impl EnumMapperData {
    pub fn read_le<R: Read + Seek>(reader: &mut R) -> binrw::BinResult<Self> {
        let base_enum_map = read_u32_le(reader)?;
        let unknown = read_u32_le(reader)?;

        // id_to_string_map: AutoGrowHashTable<u32, PString<u8>>
        let _bucket = read_u8(reader)?;
        let n = read_compressed_u32(reader)? as usize;
        let mut id_to_string_map = HashMap::with_capacity(n);
        for _ in 0..n {
            let key = read_u32_le(reader)?;
            let val = read_pstring_byte_compressed(reader)?;
            id_to_string_map.insert(key, val);
        }

        Ok(Self {
            base_enum_map,
            unknown,
            id_to_string_map,
        })
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct MasterProperty {
    pub id: u32,
    pub enum_mapper: EnumMapperData,
    pub properties: HashMap<u32, BasePropertyDesc>,
}

impl MasterProperty {
    pub fn read_le<R: Read + Seek>(reader: &mut R) -> binrw::BinResult<Self> {
        let id = read_u32_le(reader)?;
        let enum_mapper = EnumMapperData::read_le(reader)?;

        // Properties dictionary header: u8 bucket_size + CompressedUInt count.
        // This bucket lives on MasterProperty itself (per DRW
        // `MasterProperty.cs::Unpack` line 33), NOT on EnumMapperData.
        let _properties_bucket_size = read_u8(reader)?;
        let num_properties = read_compressed_u32(reader)? as usize;
        let mut properties = HashMap::with_capacity(num_properties);
        for i in 0..num_properties {
            let key_pos = reader.stream_position().unwrap_or(0);
            let key = read_u32_le(reader)?;
            let desc = BasePropertyDesc::read_le(reader).map_err(|e| binrw::Error::Custom {
                pos: key_pos,
                err: Box::new(format!(
                    "while reading property #{i} (key=0x{key:08X}) starting at 0x{key_pos:X}: {e}"
                )),
            })?;
            properties.insert(key, desc);
        }
        Ok(Self {
            id,
            enum_mapper,
            properties,
        })
    }
}

// ---- Small endian-fixed reader helpers ------------------------------
//
// These wrap binrw::BinRead::read_le for the primitive types. Keeping
// them here (rather than chaining .read_le through binrw's derive) lets
// MasterProperty avoid pulling in binrw's #[derive] for every field —
// the recursive BaseProperty enum is the wrong shape for derive
// anyway.

fn read_u8<R: Read + Seek>(reader: &mut R) -> binrw::BinResult<u8> {
    use binrw::BinRead;
    u8::read(reader)
}

fn read_u32_le<R: Read + Seek>(reader: &mut R) -> binrw::BinResult<u32> {
    use binrw::BinRead;
    u32::read_le(reader)
}

fn read_u64_le<R: Read + Seek>(reader: &mut R) -> binrw::BinResult<u64> {
    use binrw::BinRead;
    u64::read_le(reader)
}

fn read_i32_le<R: Read + Seek>(reader: &mut R) -> binrw::BinResult<i32> {
    use binrw::BinRead;
    i32::read_le(reader)
}

fn read_f32_le<R: Read + Seek>(reader: &mut R) -> binrw::BinResult<f32> {
    use binrw::BinRead;
    f32::read_le(reader)
}

fn read_bool_byte<R: Read + Seek>(reader: &mut R) -> binrw::BinResult<bool> {
    Ok(read_u8(reader)? != 0)
}

fn read_pstring_byte_compressed<R: Read + Seek>(reader: &mut R) -> binrw::BinResult<String> {
    let len = read_compressed_u32(reader)? as usize;
    let mut buf = vec![0u8; len];
    reader.read_exact(&mut buf)?;
    let (decoded, _, _) = encoding_rs::WINDOWS_1252.decode(&buf);
    Ok(decoded.into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use binrw::io::Cursor;

    #[test]
    fn property_type_round_trip() {
        for variant in [
            BasePropertyType::Invalid,
            BasePropertyType::Bool,
            BasePropertyType::Float,
            BasePropertyType::Vector,
            BasePropertyType::Color,
            BasePropertyType::Bitfield64,
            BasePropertyType::TriState,
        ] {
            assert_eq!(BasePropertyType::from_u32(variant as u32), Some(variant));
        }
        assert_eq!(BasePropertyType::from_u32(0xFF), None);
    }

    /// Hand-built minimal BasePropertyDesc with no default/max/min so we
    /// don't have to commit to a value-variant fixture. Validates the
    /// fixed-size scaffolding.
    fn minimal_base_property_desc_bytes() -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&0xCAFE_BABEu32.to_le_bytes()); // name
        out.extend_from_slice(&(BasePropertyType::Integer as u32).to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes()); // group = Invalid
        out.extend_from_slice(&0u32.to_le_bytes()); // provider
        out.extend_from_slice(&0u32.to_le_bytes()); // data
        out.extend_from_slice(&0i32.to_le_bytes()); // patch_flags
        out.push(0); // has_default = false
        out.push(0); // has_max = false
        out.push(0); // has_min = false
        out.extend_from_slice(&0f32.to_le_bytes()); // prediction_timeout
        out.push(0); // inheritance_type
        out.push(0); // dat_file_type
        out.push(0); // propagation_type
        out.push(0); // caching_type
        out.extend_from_slice(&[0u8; 8]); // 8 boolean flags
        out.push(0); // bucket_size
        out.push(0); // num_available_properties
        out
    }

    #[test]
    fn minimal_base_property_desc_round_trip() {
        let bytes = minimal_base_property_desc_bytes();
        let mut cursor = Cursor::new(&bytes);
        let desc = BasePropertyDesc::read_le(&mut cursor).expect("parse desc");
        assert_eq!(desc.name, 0xCAFE_BABE);
        assert_eq!(desc.property_type, BasePropertyType::Integer);
        assert!(desc.default_value.is_none());
        assert!(desc.available_properties.is_empty());
        assert_eq!(cursor.position() as usize, bytes.len(), "no bytes leftover");
    }

    #[test]
    fn base_property_known_type_decodes_simple_variants() {
        // Bool
        let mut c = Cursor::new(vec![0x01u8]);
        match BaseProperty::read_with_known_type(&mut c, BasePropertyType::Bool).unwrap() {
            BaseProperty::Bool(v) => assert!(v),
            _ => panic!("expected Bool"),
        }
        // Integer
        let int_bytes = (-42i32).to_le_bytes().to_vec();
        let mut c = Cursor::new(int_bytes);
        match BaseProperty::read_with_known_type(&mut c, BasePropertyType::Integer).unwrap() {
            BaseProperty::Integer(v) => assert_eq!(v, -42),
            _ => panic!("expected Integer"),
        }
        // Color (DRW order: blue, green, red, alpha)
        let mut c = Cursor::new(vec![0x10u8, 0x20, 0x30, 0xFF]);
        match BaseProperty::read_with_known_type(&mut c, BasePropertyType::Color).unwrap() {
            BaseProperty::Color { b, g, r, a } => {
                assert_eq!((b, g, r, a), (0x10, 0x20, 0x30, 0xFF));
            }
            _ => panic!("expected Color"),
        }
    }
}
