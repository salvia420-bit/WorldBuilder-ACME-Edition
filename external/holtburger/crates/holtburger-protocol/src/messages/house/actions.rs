use crate::traits::{ProtocolPack, ProtocolUnpack};
use byteorder::{ByteOrder, LittleEndian, WriteBytesExt};
use holtburger_common::Guid;

// Buy / Rent share the wire shape: u32 slumlord_guid + PackableList<uint>
// (u32 count + count × u32 item_guid). Mirrors ACE's
// GameActionHouseBuyHouse.Handle / GameActionHouseRentHouse.Handle which
// both do ReadUInt32() + ReadListUInt32().

#[derive(Debug, Clone, PartialEq)]
pub struct BuyHouseActionData {
    pub slumlord_guid: Guid,
    pub item_guids: Vec<Guid>,
}

impl ProtocolUnpack for BuyHouseActionData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        let slumlord_guid = Guid::unpack(data, offset)?;
        if *offset + 4 > data.len() {
            return None;
        }
        let count = LittleEndian::read_u32(&data[*offset..*offset + 4]) as usize;
        *offset += 4;
        let mut item_guids = Vec::with_capacity(count);
        for _ in 0..count {
            item_guids.push(Guid::unpack(data, offset)?);
        }
        Some(Self {
            slumlord_guid,
            item_guids,
        })
    }
}

impl ProtocolPack for BuyHouseActionData {
    fn pack(&self, buf: &mut Vec<u8>) {
        self.slumlord_guid.pack(buf);
        buf.write_u32::<LittleEndian>(self.item_guids.len() as u32)
            .unwrap();
        for g in &self.item_guids {
            g.pack(buf);
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct HouseQueryActionData {}

impl ProtocolUnpack for HouseQueryActionData {
    fn unpack(_data: &[u8], _offset: &mut usize) -> Option<Self> {
        Some(Self {})
    }
}

impl ProtocolPack for HouseQueryActionData {
    fn pack(&self, _buf: &mut Vec<u8>) {}
}

#[derive(Debug, Clone, PartialEq)]
pub struct AbandonHouseActionData {}

impl ProtocolUnpack for AbandonHouseActionData {
    fn unpack(_data: &[u8], _offset: &mut usize) -> Option<Self> {
        Some(Self {})
    }
}

impl ProtocolPack for AbandonHouseActionData {
    fn pack(&self, _buf: &mut Vec<u8>) {}
}

#[derive(Debug, Clone, PartialEq)]
pub struct RentHouseActionData {
    pub slumlord_guid: Guid,
    pub item_guids: Vec<Guid>,
}

impl ProtocolUnpack for RentHouseActionData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        let slumlord_guid = Guid::unpack(data, offset)?;
        if *offset + 4 > data.len() {
            return None;
        }
        let count = LittleEndian::read_u32(&data[*offset..*offset + 4]) as usize;
        *offset += 4;
        let mut item_guids = Vec::with_capacity(count);
        for _ in 0..count {
            item_guids.push(Guid::unpack(data, offset)?);
        }
        Some(Self {
            slumlord_guid,
            item_guids,
        })
    }
}

impl ProtocolPack for RentHouseActionData {
    fn pack(&self, buf: &mut Vec<u8>) {
        self.slumlord_guid.pack(buf);
        buf.write_u32::<LittleEndian>(self.item_guids.len() as u32)
            .unwrap();
        for g in &self.item_guids {
            g.pack(buf);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_helpers::assert_pack_unpack_parity;

    #[test]
    fn test_buy_house_with_items_roundtrip() {
        // slumlord=0x80000042, 2 item guids: 0x50000001 + 0x50000002
        let fixture = hex::decode(
            "42000080020000000100005002000050",
        )
        .unwrap();
        let data = BuyHouseActionData {
            slumlord_guid: Guid(0x80000042),
            item_guids: vec![Guid(0x50000001), Guid(0x50000002)],
        };
        assert_pack_unpack_parity(&fixture, &data);
    }

    #[test]
    fn test_rent_house_empty_items_roundtrip() {
        // slumlord=0x80000099, 0 item guids
        let fixture = hex::decode("9900008000000000").unwrap();
        let data = RentHouseActionData {
            slumlord_guid: Guid(0x80000099),
            item_guids: vec![],
        };
        assert_pack_unpack_parity(&fixture, &data);
    }

    #[test]
    fn test_house_query_empty_roundtrip() {
        let fixture: [u8; 0] = [];
        let data = HouseQueryActionData {};
        assert_pack_unpack_parity(&fixture, &data);
    }

    #[test]
    fn test_abandon_house_empty_roundtrip() {
        let fixture: [u8; 0] = [];
        let data = AbandonHouseActionData {};
        assert_pack_unpack_parity(&fixture, &data);
    }
}
