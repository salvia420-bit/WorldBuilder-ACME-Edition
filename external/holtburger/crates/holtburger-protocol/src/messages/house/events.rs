use crate::errors::WeenieError;
use crate::messages::utils::{
    read_hashtable_header, read_string16, write_hashtable_header, write_string16,
};
use crate::traits::{ProtocolPack, ProtocolUnpack};
use byteorder::{ByteOrder, LittleEndian, WriteBytesExt};
use holtburger_common::position::WorldPosition;
use holtburger_common::Guid;
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq)]
pub struct HouseStatusEventData {
    pub error: WeenieError,
}

impl ProtocolUnpack for HouseStatusEventData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 4 > data.len() {
            return None;
        }
        let error_raw = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        *offset += 4;
        let error = WeenieError::from_repr(error_raw).unwrap_or(WeenieError::None);
        Some(HouseStatusEventData { error })
    }
}

impl ProtocolPack for HouseStatusEventData {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.extend_from_slice(&(self.error as u32).to_le_bytes());
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct HousePaymentEntry {
    pub num: i32,
    pub paid: i32,
    pub weenie_id: u32,
    pub name: String,
    pub plural_name: String,
}

impl ProtocolUnpack for HousePaymentEntry {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 12 > data.len() {
            return None;
        }
        let num = LittleEndian::read_i32(&data[*offset..*offset + 4]);
        let paid = LittleEndian::read_i32(&data[*offset + 4..*offset + 8]);
        let weenie_id = LittleEndian::read_u32(&data[*offset + 8..*offset + 12]);
        *offset += 12;
        let name = read_string16(data, offset)?;
        let plural_name = read_string16(data, offset)?;
        Some(HousePaymentEntry {
            num,
            paid,
            weenie_id,
            name,
            plural_name,
        })
    }
}

impl ProtocolPack for HousePaymentEntry {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.write_i32::<LittleEndian>(self.num).unwrap();
        buf.write_i32::<LittleEndian>(self.paid).unwrap();
        buf.write_u32::<LittleEndian>(self.weenie_id).unwrap();
        write_string16(buf, &self.name);
        write_string16(buf, &self.plural_name);
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct HouseDataEventData {
    pub buy_time: u32,
    pub rent_time: u32,
    pub house_type: u32,
    pub maintenance_free: u32,
    pub buy: Vec<HousePaymentEntry>,
    pub rent: Vec<HousePaymentEntry>,
    pub position: WorldPosition,
}

impl ProtocolUnpack for HouseDataEventData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 16 > data.len() {
            return None;
        }
        let buy_time = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        let rent_time = LittleEndian::read_u32(&data[*offset + 4..*offset + 8]);
        let house_type = LittleEndian::read_u32(&data[*offset + 8..*offset + 12]);
        let maintenance_free = LittleEndian::read_u32(&data[*offset + 12..*offset + 16]);
        *offset += 16;

        if *offset + 4 > data.len() {
            return None;
        }
        let buy_count = LittleEndian::read_u32(&data[*offset..*offset + 4]) as usize;
        *offset += 4;
        let mut buy = Vec::with_capacity(buy_count);
        for _ in 0..buy_count {
            buy.push(HousePaymentEntry::unpack(data, offset)?);
        }

        if *offset + 4 > data.len() {
            return None;
        }
        let rent_count = LittleEndian::read_u32(&data[*offset..*offset + 4]) as usize;
        *offset += 4;
        let mut rent = Vec::with_capacity(rent_count);
        for _ in 0..rent_count {
            rent.push(HousePaymentEntry::unpack(data, offset)?);
        }

        let position = WorldPosition::unpack(data, offset)?;
        Some(HouseDataEventData {
            buy_time,
            rent_time,
            house_type,
            maintenance_free,
            buy,
            rent,
            position,
        })
    }
}

impl ProtocolPack for HouseDataEventData {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.write_u32::<LittleEndian>(self.buy_time).unwrap();
        buf.write_u32::<LittleEndian>(self.rent_time).unwrap();
        buf.write_u32::<LittleEndian>(self.house_type).unwrap();
        buf.write_u32::<LittleEndian>(self.maintenance_free).unwrap();
        buf.write_u32::<LittleEndian>(self.buy.len() as u32).unwrap();
        for entry in &self.buy {
            entry.pack(buf);
        }
        buf.write_u32::<LittleEndian>(self.rent.len() as u32).unwrap();
        for entry in &self.rent {
            entry.pack(buf);
        }
        self.position.pack(buf);
    }
}

// PackableHashTable<ObjectGuid, uint> bucket count for RestrictionDB.
// Per ACE `RestrictionDBExtensions.headerNumBuckets` (the value the
// retail header carries) — the in-memory size (89) is unused on the
// wire.
const RESTRICTION_DB_BUCKETS: usize = 768;

#[derive(Debug, Clone, PartialEq)]
pub struct HouseProfileEventData {
    pub crystal_guid: Guid,
    pub dwelling_id: u32,
    pub owner_id: Guid,
    pub bitmask: u32,
    pub min_level: i32,
    pub max_level: i32,
    pub min_alleg_rank: i32,
    pub max_alleg_rank: i32,
    pub maintenance_free: u32,
    pub house_type: u32,
    pub owner_name: String,
    pub buy: Vec<HousePaymentEntry>,
    pub rent: Vec<HousePaymentEntry>,
}

impl ProtocolUnpack for HouseProfileEventData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        let crystal_guid = Guid::unpack(data, offset)?;
        if *offset + 36 > data.len() {
            return None;
        }
        let dwelling_id = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        let owner_id = Guid(LittleEndian::read_u32(&data[*offset + 4..*offset + 8]));
        let bitmask = LittleEndian::read_u32(&data[*offset + 8..*offset + 12]);
        let min_level = LittleEndian::read_i32(&data[*offset + 12..*offset + 16]);
        let max_level = LittleEndian::read_i32(&data[*offset + 16..*offset + 20]);
        let min_alleg_rank = LittleEndian::read_i32(&data[*offset + 20..*offset + 24]);
        let max_alleg_rank = LittleEndian::read_i32(&data[*offset + 24..*offset + 28]);
        let maintenance_free = LittleEndian::read_u32(&data[*offset + 28..*offset + 32]);
        let house_type = LittleEndian::read_u32(&data[*offset + 32..*offset + 36]);
        *offset += 36;

        let owner_name = read_string16(data, offset)?;

        if *offset + 4 > data.len() {
            return None;
        }
        let buy_count = LittleEndian::read_u32(&data[*offset..*offset + 4]) as usize;
        *offset += 4;
        let mut buy = Vec::with_capacity(buy_count);
        for _ in 0..buy_count {
            buy.push(HousePaymentEntry::unpack(data, offset)?);
        }

        if *offset + 4 > data.len() {
            return None;
        }
        let rent_count = LittleEndian::read_u32(&data[*offset..*offset + 4]) as usize;
        *offset += 4;
        let mut rent = Vec::with_capacity(rent_count);
        for _ in 0..rent_count {
            rent.push(HousePaymentEntry::unpack(data, offset)?);
        }

        Some(HouseProfileEventData {
            crystal_guid,
            dwelling_id,
            owner_id,
            bitmask,
            min_level,
            max_level,
            min_alleg_rank,
            max_alleg_rank,
            maintenance_free,
            house_type,
            owner_name,
            buy,
            rent,
        })
    }
}

impl ProtocolPack for HouseProfileEventData {
    fn pack(&self, buf: &mut Vec<u8>) {
        self.crystal_guid.pack(buf);
        buf.write_u32::<LittleEndian>(self.dwelling_id).unwrap();
        self.owner_id.pack(buf);
        buf.write_u32::<LittleEndian>(self.bitmask).unwrap();
        buf.write_i32::<LittleEndian>(self.min_level).unwrap();
        buf.write_i32::<LittleEndian>(self.max_level).unwrap();
        buf.write_i32::<LittleEndian>(self.min_alleg_rank).unwrap();
        buf.write_i32::<LittleEndian>(self.max_alleg_rank).unwrap();
        buf.write_u32::<LittleEndian>(self.maintenance_free).unwrap();
        buf.write_u32::<LittleEndian>(self.house_type).unwrap();
        write_string16(buf, &self.owner_name);
        buf.write_u32::<LittleEndian>(self.buy.len() as u32).unwrap();
        for entry in &self.buy {
            entry.pack(buf);
        }
        buf.write_u32::<LittleEndian>(self.rent.len() as u32).unwrap();
        for entry in &self.rent {
            entry.pack(buf);
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct HouseUpdateRestrictionsEventData {
    pub sequence: u32,
    pub object_guid: Guid,
    pub version: u32,
    pub open_status: u32,
    pub monarch_id: Guid,
    pub guests: BTreeMap<u32, u32>,
}

impl ProtocolUnpack for HouseUpdateRestrictionsEventData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 8 > data.len() {
            return None;
        }
        let sequence = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        *offset += 4;
        let object_guid = Guid::unpack(data, offset)?;

        if *offset + 12 > data.len() {
            return None;
        }
        let version = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        let open_status = LittleEndian::read_u32(&data[*offset + 4..*offset + 8]);
        *offset += 8;
        let monarch_id = Guid::unpack(data, offset)?;

        let (count, _) = read_hashtable_header(data, offset)?;
        let mut guests = BTreeMap::new();
        for _ in 0..count {
            if *offset + 8 > data.len() {
                return None;
            }
            let key = LittleEndian::read_u32(&data[*offset..*offset + 4]);
            let value = LittleEndian::read_u32(&data[*offset + 4..*offset + 8]);
            *offset += 8;
            guests.insert(key, value);
        }

        Some(HouseUpdateRestrictionsEventData {
            sequence,
            object_guid,
            version,
            open_status,
            monarch_id,
            guests,
        })
    }
}

impl ProtocolPack for HouseUpdateRestrictionsEventData {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.write_u32::<LittleEndian>(self.sequence).unwrap();
        self.object_guid.pack(buf);
        buf.write_u32::<LittleEndian>(self.version).unwrap();
        buf.write_u32::<LittleEndian>(self.open_status).unwrap();
        self.monarch_id.pack(buf);
        write_hashtable_header(buf, self.guests.len(), RESTRICTION_DB_BUCKETS);
        // ACE sorts via GuidComparer(actualNumBuckets=89): bucket = guid %
        // 89, ties broken by guid. We follow the same bucket-then-guid
        // total order so the on-wire byte layout matches a server pack.
        let mut entries: Vec<(&u32, &u32)> = self.guests.iter().collect();
        entries.sort_by(|a, b| {
            let lb = (*a.0 as usize) % 89;
            let rb = (*b.0 as usize) % 89;
            lb.cmp(&rb).then_with(|| a.0.cmp(b.0))
        });
        for (k, v) in entries {
            buf.write_u32::<LittleEndian>(*k).unwrap();
            buf.write_u32::<LittleEndian>(*v).unwrap();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_helpers::assert_pack_unpack_parity;
    use holtburger_common::math::{Quaternion, Vector3};

    #[test]
    fn test_house_status_no_house_owned_roundtrip() {
        let fixture = hex::decode("02000000").unwrap();
        let data = HouseStatusEventData {
            error: WeenieError::BadParam,
        };
        assert_pack_unpack_parity(&fixture, &data);
    }

    #[test]
    fn test_house_data_cottage_roundtrip() {
        let data = HouseDataEventData {
            buy_time: 0x6650_0000,
            rent_time: 0x6651_0000,
            house_type: 1,
            maintenance_free: 0,
            buy: vec![HousePaymentEntry {
                num: 10_000,
                paid: 10_000,
                weenie_id: 273,
                name: "Pyreal".to_string(),
                plural_name: "Pyreals".to_string(),
            }],
            rent: vec![HousePaymentEntry {
                num: 1_000,
                paid: 500,
                weenie_id: 273,
                name: "Pyreal".to_string(),
                plural_name: "Pyreals".to_string(),
            }],
            position: WorldPosition {
                landblock_id: 0x00A9_B400.into(),
                coords: Vector3 {
                    x: 60.0,
                    y: 80.0,
                    z: 24.0,
                },
                rotation: Quaternion {
                    w: 1.0,
                    x: 0.0,
                    y: 0.0,
                    z: 0.0,
                },
            },
        };

        let mut packed = Vec::new();
        data.pack(&mut packed);
        assert_pack_unpack_parity(&packed, &data);
    }

    #[test]
    fn test_house_profile_cottage_roundtrip() {
        let data = HouseProfileEventData {
            crystal_guid: Guid(0x8000_0042),
            dwelling_id: 0x000A_9B40,
            owner_id: Guid(0x5000_0001),
            bitmask: 1,
            min_level: -1,
            max_level: -1,
            min_alleg_rank: -1,
            max_alleg_rank: -1,
            maintenance_free: 0,
            house_type: 1,
            owner_name: "Bael'Zharon".to_string(),
            buy: vec![HousePaymentEntry {
                num: 10_000,
                paid: 10_000,
                weenie_id: 273,
                name: "Pyreal".to_string(),
                plural_name: "Pyreals".to_string(),
            }],
            rent: vec![HousePaymentEntry {
                num: 1_000,
                paid: 500,
                weenie_id: 273,
                name: "Pyreal".to_string(),
                plural_name: "Pyreals".to_string(),
            }],
        };
        let mut packed = Vec::new();
        data.pack(&mut packed);
        assert_pack_unpack_parity(&packed, &data);
    }

    #[test]
    fn test_house_update_restrictions_two_guests_roundtrip() {
        let mut guests = BTreeMap::new();
        guests.insert(0x5000_AAAA_u32, 0_u32);
        guests.insert(0x5000_BBBB_u32, 1_u32);
        let data = HouseUpdateRestrictionsEventData {
            sequence: 7,
            object_guid: Guid(0x8000_0042),
            version: 0x1000_0002,
            open_status: 0,
            monarch_id: Guid(0x5000_0001),
            guests,
        };
        let mut packed = Vec::new();
        data.pack(&mut packed);
        assert_pack_unpack_parity(&packed, &data);
    }
}
