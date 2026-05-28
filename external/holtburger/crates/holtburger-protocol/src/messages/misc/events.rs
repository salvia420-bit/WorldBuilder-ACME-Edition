use crate::errors::WeenieError;
use crate::messages::utils::{read_string16, write_string16};
use crate::traits::{ProtocolPack, ProtocolUnpack};
use byteorder::{ByteOrder, LittleEndian};
use holtburger_common::ConfirmationType;

#[derive(Debug, Clone, PartialEq)]
pub struct WeenieErrorEventData {
    pub error: WeenieError,
}

impl ProtocolUnpack for WeenieErrorEventData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 4 > data.len() {
            return None;
        }
        let error_raw = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        *offset += 4;
        let error = WeenieError::from_repr(error_raw).unwrap_or(WeenieError::None);
        Some(WeenieErrorEventData { error })
    }
}

impl ProtocolPack for WeenieErrorEventData {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.extend_from_slice(&(self.error as u32).to_le_bytes());
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct WeenieErrorWithStringEventData {
    pub error: WeenieError,
    pub parameter: String,
}

impl ProtocolUnpack for WeenieErrorWithStringEventData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 4 > data.len() {
            return None;
        }
        let error_raw = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        *offset += 4;
        let error = WeenieError::from_repr(error_raw).unwrap_or(WeenieError::None);
        let parameter = read_string16(data, offset)?;
        Some(WeenieErrorWithStringEventData { error, parameter })
    }
}

impl ProtocolPack for WeenieErrorWithStringEventData {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.extend_from_slice(&(self.error as u32).to_le_bytes());
        write_string16(buf, &self.parameter);
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct UseDoneEventData {
    pub error: WeenieError,
}

impl ProtocolUnpack for UseDoneEventData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 4 > data.len() {
            return None;
        }
        let error_raw = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        *offset += 4;
        let error = WeenieError::from_repr(error_raw).unwrap_or(WeenieError::None);
        Some(UseDoneEventData { error })
    }
}

impl ProtocolPack for UseDoneEventData {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.extend_from_slice(&(self.error as u32).to_le_bytes());
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct CharacterConfirmationRequestEventData {
    pub confirmation_type: ConfirmationType,
    pub context: u32,
    pub text: String,
}

impl ProtocolUnpack for CharacterConfirmationRequestEventData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 8 > data.len() {
            return None;
        }
        let confirmation_type =
            ConfirmationType::from_repr(LittleEndian::read_u32(&data[*offset..*offset + 4]))?;
        *offset += 4;
        let context = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        *offset += 4;
        let text = read_string16(data, offset)?;
        Some(Self {
            confirmation_type,
            context,
            text,
        })
    }
}

impl ProtocolPack for CharacterConfirmationRequestEventData {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.extend_from_slice(&(self.confirmation_type as u32).to_le_bytes());
        buf.extend_from_slice(&self.context.to_le_bytes());
        write_string16(buf, &self.text);
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct CharacterConfirmationDoneEventData {
    pub confirmation_type: ConfirmationType,
    pub context: u32,
}

impl ProtocolUnpack for CharacterConfirmationDoneEventData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 8 > data.len() {
            return None;
        }
        let confirmation_type =
            ConfirmationType::from_repr(LittleEndian::read_u32(&data[*offset..*offset + 4]))?;
        *offset += 4;
        let context = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        *offset += 4;
        Some(Self {
            confirmation_type,
            context,
        })
    }
}

impl ProtocolPack for CharacterConfirmationDoneEventData {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.extend_from_slice(&(self.confirmation_type as u32).to_le_bytes());
        buf.extend_from_slice(&self.context.to_le_bytes());
    }
}

// === Wave 6.C — Portal Storm dispatch (2026-05-28) ===
//
// Per ACE source `~/ace-server/Source/ACE.Server/Network/GameEvent/
// Events/GameEventPortalStorm{Brewing,Imminent,,Subsided}.cs`:
//
//   GameEventPortalStormBrewing  (0x02C9) — Writer.Write(extent: f32)
//                                            default extent = 0.4f
//   GameEventPortalStormImminent (0x02CA) — Writer.Write(extent: f32)
//                                            default extent = 0.6f
//   GameEventPortalStorm         (0x02CB) — no payload (size = 4)
//   GameEventPortalStormSubsided (0x02CC) — no payload (size = 4)
//
// The two unit-sized events still need EventData stubs because the
// `game_event.rs` dispatcher uses `Box<...EventData>` uniformly for
// all variants that carry payload structs. For Storm + Subsided we
// use unit-like empty structs so the boxed-data shape stays
// consistent with the rest of the enum, and `pack`/`unpack` do
// nothing (the bytes are exactly the outer 4-byte event header).
//
// Chorizite XML cross-check: `Misc_PortalStormBrewing` /
// `Misc_PortalStormImminent` declare a single `<field type="float"
// name="Extent">`; `Misc_PortalStorm` / `Misc_PortalStormSubsided`
// declare no fields. ACE + Chorizite + retail agree.

/// Wave 6.C (2026-05-28): payload for `MiscPortalStormBrewing` (0x02C9).
/// Single f32 `extent` (ACE default = 0.4) — "less than or equal to 0
/// resets the timer, otherwise sets it" per Chorizite XML annotation.
#[derive(Debug, Clone, PartialEq)]
pub struct MiscPortalStormBrewingEventData {
    pub extent: f32,
}

impl ProtocolUnpack for MiscPortalStormBrewingEventData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 4 > data.len() {
            return None;
        }
        let extent = LittleEndian::read_f32(&data[*offset..*offset + 4]);
        *offset += 4;
        Some(MiscPortalStormBrewingEventData { extent })
    }
}

impl ProtocolPack for MiscPortalStormBrewingEventData {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.extend_from_slice(&self.extent.to_le_bytes());
    }
}

/// Wave 6.C (2026-05-28): payload for `MiscPortalStormImminent` (0x02CA).
/// Wire shape mirrors `MiscPortalStormBrewing`: single f32 `extent`
/// (ACE default = 0.6).
#[derive(Debug, Clone, PartialEq)]
pub struct MiscPortalStormImminentEventData {
    pub extent: f32,
}

impl ProtocolUnpack for MiscPortalStormImminentEventData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 4 > data.len() {
            return None;
        }
        let extent = LittleEndian::read_f32(&data[*offset..*offset + 4]);
        *offset += 4;
        Some(MiscPortalStormImminentEventData { extent })
    }
}

impl ProtocolPack for MiscPortalStormImminentEventData {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.extend_from_slice(&self.extent.to_le_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messages::game_event::{GameEvent, GameEventMessage};
    use crate::messages::game_message::GameMessage;
    use crate::test_fixtures;
    use crate::test_helpers::assert_pack_unpack_parity;
    use holtburger_common::ConfirmationType;
    use holtburger_common::Guid;

    #[test]
    fn test_weenie_error_fixture() {
        let expected = GameMessage::GameEvent(Box::new(GameEventMessage {
            target: Guid(0x50000001),
            sequence: 0x0E,
            event: GameEvent::WeenieError(Box::new(WeenieErrorEventData {
                error: WeenieError::BadParam,
            })),
        }));
        let data = test_fixtures::WEENIE_ERROR;
        let mut offset = 0;
        let unpacked = GameMessage::unpack(data, &mut offset).unwrap();
        assert_eq!(unpacked, expected);

        // Verify parity now that we use a valid error ID
        let mut packed = Vec::new();
        unpacked.pack(&mut packed);
        assert_eq!(packed, data);
    }

    #[test]
    fn test_weenie_error_with_string_fixture() {
        let expected = GameMessage::GameEvent(Box::new(GameEventMessage {
            target: Guid(0x50000001),
            sequence: 0x0E,
            event: GameEvent::WeenieErrorWithString(Box::new(WeenieErrorWithStringEventData {
                error: WeenieError::BadParam,
                parameter: "Test error".to_string(),
            })),
        }));
        let data = test_fixtures::WEENIE_ERROR_WITH_STRING;
        let mut offset = 0;
        let unpacked = GameMessage::unpack(data, &mut offset).unwrap();
        assert_eq!(unpacked, expected);

        // Verify parity
        let mut packed = Vec::new();
        unpacked.pack(&mut packed);
        assert_eq!(packed, data);
    }

    #[test]
    fn test_character_confirmation_request_fixture() {
        let expected = GameMessage::GameEvent(Box::new(GameEventMessage {
            target: Guid::NULL,
            sequence: 0x0E,
            event: GameEvent::CharacterConfirmationRequest(Box::new(
                CharacterConfirmationRequestEventData {
                    confirmation_type: ConfirmationType::CraftInteraction,
                    context: 0xDEADBEEF,
                    text: "Craft this item? Success chance is 42%.".to_string(),
                },
            )),
        }));
        assert_pack_unpack_parity(test_fixtures::CHARACTER_CONFIRMATION_REQUEST, &expected);
    }

    #[test]
    fn test_character_confirmation_done_fixture() {
        let expected = GameMessage::GameEvent(Box::new(GameEventMessage {
            target: Guid::NULL,
            sequence: 0x0F,
            event: GameEvent::CharacterConfirmationDone(Box::new(
                CharacterConfirmationDoneEventData {
                    confirmation_type: ConfirmationType::CraftInteraction,
                    context: 0xDEADBEEF,
                },
            )),
        }));
        assert_pack_unpack_parity(test_fixtures::CHARACTER_CONFIRMATION_DONE, &expected);
    }

    // === Wave 6.C — Portal Storm dispatch (2026-05-28) ===
    //
    // Synth round-trip tests for the 4 Misc_PortalStorm* events.
    // Wire shapes locked against ACE source (see EventData doc
    // comments above for the GameEventPortalStorm*.cs citations).

    fn pack_portal_storm_message(event: GameEvent) -> Vec<u8> {
        let msg = GameMessage::GameEvent(Box::new(GameEventMessage {
            target: Guid::NULL,
            sequence: 0x42,
            event,
        }));
        let mut buf = Vec::new();
        msg.pack(&mut buf);
        buf
    }

    #[test]
    fn test_misc_portal_storm_brewing_round_trip() {
        let original = GameMessage::GameEvent(Box::new(GameEventMessage {
            target: Guid::NULL,
            sequence: 0x42,
            event: GameEvent::MiscPortalStormBrewing(Box::new(
                MiscPortalStormBrewingEventData { extent: 0.4 },
            )),
        }));
        let packed = pack_portal_storm_message(GameEvent::MiscPortalStormBrewing(Box::new(
            MiscPortalStormBrewingEventData { extent: 0.4 },
        )));
        let mut offset = 0;
        let unpacked = GameMessage::unpack(&packed, &mut offset).unwrap();
        assert_eq!(unpacked, original);
        // Wire layout (16 bytes header + 4 bytes f32 payload = 20):
        //   4 GameOpcode::GameEvent outer opcode
        //   4 target.Guid (u32)
        //   4 sequence (u32)
        //   4 GameEventOpcode::MiscPortalStormBrewing (u32)
        //   4 extent (f32)
        assert_eq!(packed.len(), 20);
    }

    #[test]
    fn test_misc_portal_storm_imminent_round_trip() {
        let original = GameMessage::GameEvent(Box::new(GameEventMessage {
            target: Guid::NULL,
            sequence: 0x42,
            event: GameEvent::MiscPortalStormImminent(Box::new(
                MiscPortalStormImminentEventData { extent: 0.6 },
            )),
        }));
        let packed = pack_portal_storm_message(GameEvent::MiscPortalStormImminent(Box::new(
            MiscPortalStormImminentEventData { extent: 0.6 },
        )));
        let mut offset = 0;
        let unpacked = GameMessage::unpack(&packed, &mut offset).unwrap();
        assert_eq!(unpacked, original);
        assert_eq!(packed.len(), 20);
    }

    #[test]
    fn test_misc_portal_storm_round_trip() {
        // No-payload variant; 16-byte outer header only (4 outer opcode +
        // 4 target + 4 sequence + 4 event type).
        let original = GameMessage::GameEvent(Box::new(GameEventMessage {
            target: Guid::NULL,
            sequence: 0x42,
            event: GameEvent::MiscPortalStorm,
        }));
        let packed = pack_portal_storm_message(GameEvent::MiscPortalStorm);
        let mut offset = 0;
        let unpacked = GameMessage::unpack(&packed, &mut offset).unwrap();
        assert_eq!(unpacked, original);
        assert_eq!(packed.len(), 16);
    }

    #[test]
    fn test_misc_portal_storm_subsided_round_trip() {
        let original = GameMessage::GameEvent(Box::new(GameEventMessage {
            target: Guid::NULL,
            sequence: 0x42,
            event: GameEvent::MiscPortalStormSubsided,
        }));
        let packed = pack_portal_storm_message(GameEvent::MiscPortalStormSubsided);
        let mut offset = 0;
        let unpacked = GameMessage::unpack(&packed, &mut offset).unwrap();
        assert_eq!(unpacked, original);
        assert_eq!(packed.len(), 16);
    }

    #[test]
    fn test_misc_portal_storm_brewing_default_extent() {
        // ACE default = 0.4f per GameEventPortalStormBrewing.cs:8.
        // Verify the exact bit pattern (0x3ECCCCCD) round-trips.
        let original = GameMessage::GameEvent(Box::new(GameEventMessage {
            target: Guid::NULL,
            sequence: 0,
            event: GameEvent::MiscPortalStormBrewing(Box::new(
                MiscPortalStormBrewingEventData { extent: 0.4 },
            )),
        }));
        let mut buf = Vec::new();
        original.pack(&mut buf);
        // Last 4 bytes are the f32 extent in little-endian. 0.4f32 =
        // 0x3ECCCCCD per IEEE-754.
        assert_eq!(&buf[buf.len() - 4..], &0.4f32.to_le_bytes());
        // Imminent default = 0.6f per GameEventPortalStormImminent.cs:8.
        let original_imm = GameMessage::GameEvent(Box::new(GameEventMessage {
            target: Guid::NULL,
            sequence: 0,
            event: GameEvent::MiscPortalStormImminent(Box::new(
                MiscPortalStormImminentEventData { extent: 0.6 },
            )),
        }));
        let mut buf_imm = Vec::new();
        original_imm.pack(&mut buf_imm);
        assert_eq!(&buf_imm[buf_imm.len() - 4..], &0.6f32.to_le_bytes());
    }
}
