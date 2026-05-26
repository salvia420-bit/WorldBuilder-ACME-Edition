use crate::errors::WeenieError;
use crate::traits::{ProtocolPack, ProtocolUnpack};
use byteorder::{ByteOrder, LittleEndian};

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_helpers::assert_pack_unpack_parity;

    #[test]
    fn test_house_status_no_house_owned_roundtrip() {
        let fixture = hex::decode("02000000").unwrap();
        let data = HouseStatusEventData {
            error: WeenieError::BadParam,
        };
        assert_pack_unpack_parity(&fixture, &data);
    }
}
