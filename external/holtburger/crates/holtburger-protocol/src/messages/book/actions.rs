use crate::messages::utils::{read_string16, write_string16};
use crate::traits::{ProtocolPack, ProtocolUnpack};
use holtburger_common::Guid;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BookPageDataActionData {
    pub guid: Guid,
    pub page_index: i32,
}

impl ProtocolUnpack for BookPageDataActionData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        Some(Self {
            guid: Guid::unpack(data, offset)?,
            page_index: i32::unpack(data, offset)?,
        })
    }
}

impl ProtocolPack for BookPageDataActionData {
    fn pack(&self, buf: &mut Vec<u8>) {
        self.guid.pack(buf);
        self.page_index.pack(buf);
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BookDataActionData {
    pub object_guid: Guid,
}

impl ProtocolUnpack for BookDataActionData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        Some(Self {
            object_guid: Guid::unpack(data, offset)?,
        })
    }
}

impl ProtocolPack for BookDataActionData {
    fn pack(&self, buf: &mut Vec<u8>) {
        self.object_guid.pack(buf);
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BookAddPageActionData {
    pub object_guid: Guid,
}

impl ProtocolUnpack for BookAddPageActionData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        Some(Self {
            object_guid: Guid::unpack(data, offset)?,
        })
    }
}

impl ProtocolPack for BookAddPageActionData {
    fn pack(&self, buf: &mut Vec<u8>) {
        self.object_guid.pack(buf);
    }
}

// Wire shape mirrors `GameActionBookModifyPage.Handle` — `{bookGuid, page,
// text}`. Retail had no `ignore_author` field on the modify path; ACE
// re-reads it server-side from the book entity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BookModifyPageActionData {
    pub object_guid: Guid,
    pub page_num: i32,
    pub text: String,
}

impl ProtocolUnpack for BookModifyPageActionData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        let object_guid = Guid::unpack(data, offset)?;
        let page_num = i32::unpack(data, offset)?;
        let text = read_string16(data, offset)?;
        Some(Self {
            object_guid,
            page_num,
            text,
        })
    }
}

impl ProtocolPack for BookModifyPageActionData {
    fn pack(&self, buf: &mut Vec<u8>) {
        self.object_guid.pack(buf);
        self.page_num.pack(buf);
        write_string16(buf, &self.text);
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BookDeletePageActionData {
    pub object_guid: Guid,
    pub page_num: i32,
}

impl ProtocolUnpack for BookDeletePageActionData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        Some(Self {
            object_guid: Guid::unpack(data, offset)?,
            page_num: i32::unpack(data, offset)?,
        })
    }
}

impl ProtocolPack for BookDeletePageActionData {
    fn pack(&self, buf: &mut Vec<u8>) {
        self.object_guid.pack(buf);
        self.page_num.pack(buf);
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetInscriptionActionData {
    pub object_guid: Guid,
    pub inscription: String,
}

impl ProtocolUnpack for SetInscriptionActionData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        let object_guid = Guid::unpack(data, offset)?;
        let inscription = read_string16(data, offset)?;
        Some(Self {
            object_guid,
            inscription,
        })
    }
}

impl ProtocolPack for SetInscriptionActionData {
    fn pack(&self, buf: &mut Vec<u8>) {
        self.object_guid.pack(buf);
        write_string16(buf, &self.inscription);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messages::game_action::{GameAction, GameActionMessage};
    use crate::messages::game_message::GameMessage;
    use crate::test_helpers::assert_pack_unpack_parity;

    #[test]
    fn test_book_page_data_action_fixture() {
        // Generated from ACE: SyntheticProtocolTests.DumpBookProtocolFixtures
        let fixture = hex::decode("B1F7000011000000AE0000004433221101000000").unwrap();
        let expected = GameMessage::GameAction(Box::new(GameActionMessage {
            sequence: 0x11,
            action: GameAction::BookPageData(Box::new(BookPageDataActionData {
                guid: Guid(0x11223344),
                page_index: 1,
            })),
        }));
        assert_pack_unpack_parity(&fixture, &expected);
    }
}
