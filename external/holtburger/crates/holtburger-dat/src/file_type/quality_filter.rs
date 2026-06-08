//! AC QualityFilter (a Table 0x0E-prefixed record, e.g. `0x0E010001` /
//! `0x0E010002`) — per-property-type stat allow-lists used by the client
//! quality/appraisal UI. Each list holds the stat enum values that pass
//! the filter for that property class.
//!
//! Format (mirrors `ACE.DatLoader/FileTypes/QualityFilter.cs::Unpack`):
//! ```text
//! [u32 id]
//! [u32 num_int] [u32 num_int64] [u32 num_bool] [u32 num_float]
//! [u32 num_did] [u32 num_iid]   [u32 num_string] [u32 num_position]
//! ( [u32] ) * num_int          // int_stat_filter
//! ( [u32] ) * num_int64        // int64_stat_filter
//! ( [u32] ) * num_bool         // bool_stat_filter
//! ( [u32] ) * num_float        // float_stat_filter
//! ( [u32] ) * num_did          // did_stat_filter
//! ( [u32] ) * num_iid          // iid_stat_filter
//! ( [u32] ) * num_string       // string_stat_filter
//! ( [u32] ) * num_position     // position_stat_filter
//! [u32 num_attribute] [u32 num_attribute_2nd] [u32 num_skill]
//! ( [u32] ) * num_attribute    // attribute_stat_filter
//! ( [u32] ) * num_attribute_2nd// attribute_2nd_stat_filter
//! ( [u32] ) * num_skill        // skill_stat_filter
//! ```
//!
//! Note the eight primary counts are read up front (as a block), then all
//! eight arrays; only afterwards are the three attribute/skill counts and
//! their arrays read. Read-only; no write path.

use binrw::{BinRead, BinResult};
use std::io::{Read, Seek};

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct QualityFilter {
    pub id: u32,
    pub int_stat_filter: Vec<u32>,
    pub int64_stat_filter: Vec<u32>,
    pub bool_stat_filter: Vec<u32>,
    pub float_stat_filter: Vec<u32>,
    pub did_stat_filter: Vec<u32>,
    pub iid_stat_filter: Vec<u32>,
    pub string_stat_filter: Vec<u32>,
    pub position_stat_filter: Vec<u32>,
    pub attribute_stat_filter: Vec<u32>,
    pub attribute_2nd_stat_filter: Vec<u32>,
    pub skill_stat_filter: Vec<u32>,
}

impl QualityFilter {
    pub fn read<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        Self::read_internal(reader)
    }

    pub fn unpack(data: &[u8]) -> Result<Self, binrw::Error> {
        let mut cursor = std::io::Cursor::new(data);
        Self::read_internal(&mut cursor)
    }

    fn read_internal<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let id = u32::read_le(reader)?;

        let num_int = u32::read_le(reader)?;
        let num_int64 = u32::read_le(reader)?;
        let num_bool = u32::read_le(reader)?;
        let num_float = u32::read_le(reader)?;
        let num_did = u32::read_le(reader)?;
        let num_iid = u32::read_le(reader)?;
        let num_string = u32::read_le(reader)?;
        let num_position = u32::read_le(reader)?;

        let int_stat_filter = read_u32_array(reader, num_int)?;
        let int64_stat_filter = read_u32_array(reader, num_int64)?;
        let bool_stat_filter = read_u32_array(reader, num_bool)?;
        let float_stat_filter = read_u32_array(reader, num_float)?;
        let did_stat_filter = read_u32_array(reader, num_did)?;
        let iid_stat_filter = read_u32_array(reader, num_iid)?;
        let string_stat_filter = read_u32_array(reader, num_string)?;
        let position_stat_filter = read_u32_array(reader, num_position)?;

        let num_attribute = u32::read_le(reader)?;
        let num_attribute_2nd = u32::read_le(reader)?;
        let num_skill = u32::read_le(reader)?;

        let attribute_stat_filter = read_u32_array(reader, num_attribute)?;
        let attribute_2nd_stat_filter = read_u32_array(reader, num_attribute_2nd)?;
        let skill_stat_filter = read_u32_array(reader, num_skill)?;

        Ok(Self {
            id,
            int_stat_filter,
            int64_stat_filter,
            bool_stat_filter,
            float_stat_filter,
            did_stat_filter,
            iid_stat_filter,
            string_stat_filter,
            position_stat_filter,
            attribute_stat_filter,
            attribute_2nd_stat_filter,
            skill_stat_filter,
        })
    }
}

impl BinRead for QualityFilter {
    type Args<'a> = ();

    fn read_options<R: Read + Seek>(
        reader: &mut R,
        _endian: binrw::Endian,
        _args: Self::Args<'_>,
    ) -> BinResult<Self> {
        Self::read_internal(reader)
    }
}

fn read_u32_array<R: Read + Seek>(reader: &mut R, count: u32) -> BinResult<Vec<u32>> {
    let mut out = Vec::with_capacity(count as usize);
    for _ in 0..count {
        out.push(u32::read_le(reader)?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unpacks_quality_filter() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&0x0E01_0001u32.to_le_bytes()); // id

        // 8 primary counts: int=2, int64=0, bool=1, float=0, did=0, iid=0,
        // string=0, position=1
        for &n in &[2u32, 0, 1, 0, 0, 0, 0, 1] {
            buf.extend_from_slice(&n.to_le_bytes());
        }
        // int_stat_filter (2)
        buf.extend_from_slice(&10u32.to_le_bytes());
        buf.extend_from_slice(&11u32.to_le_bytes());
        // bool_stat_filter (1)
        buf.extend_from_slice(&20u32.to_le_bytes());
        // position_stat_filter (1)
        buf.extend_from_slice(&30u32.to_le_bytes());

        // 3 attribute/skill counts: attribute=1, attribute2nd=0, skill=2
        for &n in &[1u32, 0, 2] {
            buf.extend_from_slice(&n.to_le_bytes());
        }
        // attribute_stat_filter (1)
        buf.extend_from_slice(&40u32.to_le_bytes());
        // skill_stat_filter (2)
        buf.extend_from_slice(&50u32.to_le_bytes());
        buf.extend_from_slice(&51u32.to_le_bytes());

        let qf = QualityFilter::unpack(&buf).unwrap();
        assert_eq!(qf.id, 0x0E01_0001);
        assert_eq!(qf.int_stat_filter, vec![10, 11]);
        assert!(qf.int64_stat_filter.is_empty());
        assert_eq!(qf.bool_stat_filter, vec![20]);
        assert!(qf.float_stat_filter.is_empty());
        assert_eq!(qf.position_stat_filter, vec![30]);
        assert_eq!(qf.attribute_stat_filter, vec![40]);
        assert!(qf.attribute_2nd_stat_filter.is_empty());
        assert_eq!(qf.skill_stat_filter, vec![50, 51]);
    }

    #[test]
    fn unpacks_empty_quality_filter() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&0x0E01_0002u32.to_le_bytes()); // id
        // 8 primary counts, all zero
        for _ in 0..8 {
            buf.extend_from_slice(&0u32.to_le_bytes());
        }
        // 3 attribute/skill counts, all zero
        for _ in 0..3 {
            buf.extend_from_slice(&0u32.to_le_bytes());
        }
        let qf = QualityFilter::unpack(&buf).unwrap();
        assert_eq!(qf.id, 0x0E01_0002);
        assert!(qf.int_stat_filter.is_empty());
        assert!(qf.skill_stat_filter.is_empty());
    }
}
