use crate::traits::{ProtocolPack, ProtocolUnpack};
use byteorder::{ByteOrder, LittleEndian, WriteBytesExt};

/// S2C GameEvent `0x02AE` — an admin asks this client to enumerate its
/// loaded third-party plugins. Answer with GameAction `0x02AF`
/// ([`crate::messages::admin::actions::QueryPluginListResponseActionData`])
/// echoing `context` verbatim.
///
/// Payload is a bare `u32 context`. Chorizite's protocol.xml carries the
/// 0x02AE fields as a self-closed `TODO`, so the width comes from retail:
/// `CM_Admin::DispatchUI_Recv_QueryPluginList` (acclient.c `0x6AD940`)
/// gates on `*(_DWORD *)buf == 686` and passes `*((_DWORD *)buf + 1)` —
/// exactly one DWORD past the event opcode — into
/// `ClientAdminSystem::Handle_Admin__Recv_QueryPluginList(unsigned int context)`.
/// ACE names the opcode `Evt_Admin__Recv_QueryPluginList_ID` (id 686,
/// `ACE.Entity/PacketOpCodeNames.cs:429`) and ships no handler.
#[derive(Debug, Clone, PartialEq)]
pub struct AdminQueryPluginListEventData {
    pub context: u32,
}

impl ProtocolUnpack for AdminQueryPluginListEventData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 4 > data.len() {
            return None;
        }
        let context = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        *offset += 4;
        Some(Self { context })
    }
}

impl ProtocolPack for AdminQueryPluginListEventData {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.write_u32::<LittleEndian>(self.context).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messages::game_event::{GameEvent, GameEventMessage};
    use crate::test_helpers::assert_pack_unpack_parity;
    use holtburger_common::Guid;

    #[test]
    fn test_admin_query_plugin_list_parity() {
        let event = GameEventMessage {
            target: Guid(0x50000001),
            sequence: 7,
            event: GameEvent::AdminQueryPluginList(Box::new(AdminQueryPluginListEventData {
                context: 0xDEAD_BEEF,
            })),
        };

        // target | sequence | 0x02AE | context — 16 bytes, no trailing payload.
        let fixture = hex::decode("0100005007000000AE020000EFBEADDE").unwrap();
        assert_pack_unpack_parity(&fixture, &event);
    }
}
