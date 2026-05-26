use crate::errors::WeenieError;
use crate::messages::utils::{read_string16, write_string16};
use crate::traits::{ProtocolPack, ProtocolUnpack};
use byteorder::{ByteOrder, LittleEndian, WriteBytesExt};
use holtburger_common::position::WorldPosition;

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
}
