use crate::messages::utils::{read_string16, write_string16};
use crate::traits::{ProtocolPack, ProtocolUnpack};
use byteorder::{ByteOrder, LittleEndian, WriteBytesExt};

/// Retail's verbatim answer when no third-party API is loaded.
/// `ClientAdminSystem::Handle_Admin__Recv_QueryPluginList` (acclient.c
/// `0x6B5EE0`) seeds its `pluginList` local with this literal and only
/// overwrites it under `APIManager::APIIsReady()`; the trailing period is
/// part of the string. An empty plugin set MUST send this, never `""`.
pub const NO_PLUGIN_API_PLUGIN_LIST: &str = "3rd party API not in use.";

/// C2S GameAction `0x02AF` — reply to GameEvent `0x02AE`
/// ([`crate::messages::admin::events::AdminQueryPluginListEventData`]).
///
/// Wire order is fixed by retail's packer
/// `CM_Admin::Event_QueryPluginListResponse(uint i_context, PStringBase<char>* i_pluginList)`
/// (acclient.c `0x6ADAE0`): opcode DWORD, then `context`, then a
/// DWORD-align step (a no-op at this offset), then the string. The string
/// is a `PStringBase<char>` — 8-bit, so `write_string16` (u16 length,
/// WINDOWS-1252 bytes, pad to 4), NOT the unicode form; retail converts its
/// wide `pluginList` with `to_spstring` before packing. ACE names the
/// opcode `Evt_Admin__QueryPluginListResponse_ID` (id 687,
/// `ACE.Entity/PacketOpCodeNames.cs:430`) and ships no handler.
///
/// `context` MUST be echoed unmodified — it is the admin's correlation
/// token and the only field tying a reply to its query.
#[derive(Debug, Clone, PartialEq)]
pub struct QueryPluginListResponseActionData {
    pub context: u32,
    pub plugin_list: String,
}

impl QueryPluginListResponseActionData {
    /// `plugin_list` empty/absent ⇒ [`NO_PLUGIN_API_PLUGIN_LIST`].
    pub fn new(context: u32, plugin_list: Option<&str>) -> Self {
        let plugin_list = match plugin_list {
            Some(s) if !s.is_empty() => s.to_string(),
            _ => NO_PLUGIN_API_PLUGIN_LIST.to_string(),
        };
        Self {
            context,
            plugin_list,
        }
    }
}

impl ProtocolUnpack for QueryPluginListResponseActionData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 4 > data.len() {
            return None;
        }
        let context = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        *offset += 4;
        let plugin_list = read_string16(data, offset)?;
        Some(Self {
            context,
            plugin_list,
        })
    }
}

impl ProtocolPack for QueryPluginListResponseActionData {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.write_u32::<LittleEndian>(self.context).unwrap();
        write_string16(buf, &self.plugin_list);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messages::game_action::{GameAction, GameActionMessage};
    use crate::test_helpers::assert_pack_unpack_parity;

    #[test]
    fn test_query_plugin_list_response_default_parity() {
        let action = GameActionMessage {
            sequence: 0x1122_3344,
            action: GameAction::QueryPluginListResponse(Box::new(
                QueryPluginListResponseActionData::new(0xDEAD_BEEF, None),
            )),
        };

        // sequence | 0x02AF | context | u16 len 0x19 | cp1252 bytes | 1 pad byte
        let fixture = hex::decode(
            "44332211AF020000EFBEADDE190033726420706172747920415049206E6F7420696E207573652E00",
        )
        .unwrap();
        assert_pack_unpack_parity(&fixture, &action);
    }

    #[test]
    fn test_query_plugin_list_response_manifest_parity() {
        let action = GameActionMessage {
            sequence: 0x5566_7788,
            action: GameAction::QueryPluginListResponse(Box::new(
                QueryPluginListResponseActionData::new(
                    0x00C0_FFEE,
                    Some("rynth-bar@1.2.0,chat-panel@0.4.1"),
                ),
            )),
        };

        // 32-byte string ⇒ 2 pad bytes (the u16 length prefix is inside the
        // DWORD-alignment run, matching PStringBase<char>::Pack).
        let fixture = hex::decode(
            "88776655AF020000EEFFC000200072796E74682D62617240312E322E302C636861742D70616E656C40302E342E310000",
        )
        .unwrap();
        assert_pack_unpack_parity(&fixture, &action);
    }

    #[test]
    fn test_empty_plugin_list_falls_back_to_retail_string() {
        assert_eq!(
            QueryPluginListResponseActionData::new(1, Some("")).plugin_list,
            NO_PLUGIN_API_PLUGIN_LIST
        );
        assert_eq!(
            QueryPluginListResponseActionData::new(1, None).plugin_list,
            NO_PLUGIN_API_PLUGIN_LIST
        );
    }
}
