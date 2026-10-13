use crate::traits::{ProtocolPack, ProtocolUnpack};
use byteorder::{ByteOrder, LittleEndian, WriteBytesExt};
use holtburger_common::ConfirmationType;

#[derive(Debug, Clone, PartialEq)]
pub struct PingRequestActionData;

impl ProtocolUnpack for PingRequestActionData {
    fn unpack(_data: &[u8], _offset: &mut usize) -> Option<Self> {
        Some(Self)
    }
}

impl ProtocolPack for PingRequestActionData {
    fn pack(&self, _buf: &mut Vec<u8>) {}
}

#[derive(Debug, Clone, PartialEq)]
pub struct LoginCompleteActionData;

impl ProtocolUnpack for LoginCompleteActionData {
    fn unpack(_data: &[u8], _offset: &mut usize) -> Option<Self> {
        Some(Self)
    }
}

impl ProtocolPack for LoginCompleteActionData {
    fn pack(&self, _buf: &mut Vec<u8>) {}
}

#[derive(Debug, Clone, PartialEq)]
pub struct TeleToLifestoneActionData;

impl ProtocolUnpack for TeleToLifestoneActionData {
    fn unpack(_data: &[u8], _offset: &mut usize) -> Option<Self> {
        Some(Self)
    }
}

impl ProtocolPack for TeleToLifestoneActionData {
    fn pack(&self, _buf: &mut Vec<u8>) {}
}

#[derive(Debug, Clone, PartialEq)]
pub struct TeleToPklArenaActionData;

impl ProtocolUnpack for TeleToPklArenaActionData {
    fn unpack(_data: &[u8], _offset: &mut usize) -> Option<Self> {
        Some(Self)
    }
}

impl ProtocolPack for TeleToPklArenaActionData {
    fn pack(&self, _buf: &mut Vec<u8>) {}
}

/// `@pkarena` / `@pka` (retail `ClientCommunicationSystem::DoPKArena` →
/// `CM_Character::Event_TeleToPKArena`, opcode 0x0027, acclient.c:698364).
#[derive(Debug, Clone, PartialEq)]
pub struct TeleToPkArenaActionData;

impl ProtocolUnpack for TeleToPkArenaActionData {
    fn unpack(_data: &[u8], _offset: &mut usize) -> Option<Self> {
        Some(Self)
    }
}

impl ProtocolPack for TeleToPkArenaActionData {
    fn pack(&self, _buf: &mut Vec<u8>) {}
}

#[derive(Debug, Clone, PartialEq)]
pub struct TeleToMarketPlaceActionData;

impl ProtocolUnpack for TeleToMarketPlaceActionData {
    fn unpack(_data: &[u8], _offset: &mut usize) -> Option<Self> {
        Some(Self)
    }
}

impl ProtocolPack for TeleToMarketPlaceActionData {
    fn pack(&self, _buf: &mut Vec<u8>) {}
}

#[derive(Debug, Clone, PartialEq)]
pub struct TeleToMansionActionData;

impl ProtocolUnpack for TeleToMansionActionData {
    fn unpack(_data: &[u8], _offset: &mut usize) -> Option<Self> {
        Some(Self)
    }
}

impl ProtocolPack for TeleToMansionActionData {
    fn pack(&self, _buf: &mut Vec<u8>) {}
}

#[derive(Debug, Clone, PartialEq)]
pub struct SuicideActionData;

impl ProtocolUnpack for SuicideActionData {
    fn unpack(_data: &[u8], _offset: &mut usize) -> Option<Self> {
        Some(Self)
    }
}

impl ProtocolPack for SuicideActionData {
    fn pack(&self, _buf: &mut Vec<u8>) {}
}

#[derive(Debug, Clone, PartialEq)]
pub struct EnterPkLiteActionData;

impl ProtocolUnpack for EnterPkLiteActionData {
    fn unpack(_data: &[u8], _offset: &mut usize) -> Option<Self> {
        Some(Self)
    }
}

impl ProtocolPack for EnterPkLiteActionData {
    fn pack(&self, _buf: &mut Vec<u8>) {}
}

/// chat-errors-8 (2026-10-13): C2S `Character_QueryAge` (0x01C2) — retail
/// `CM_Character::Event_QueryAge(i_target)` (acclient.c:697985) packs the
/// opcode and one `u32`. `ClientCommunicationSystem::DoAge` (:422037) passes
/// the selected object only for a PSR, so a player always sends 0. ACE
/// (`GameActionQueryAge.cs`) reads the field as an empty `String16L` + pad
/// and ignores it.
#[derive(Debug, Clone, PartialEq)]
pub struct QueryAgeActionData {
    pub target: u32,
}

impl ProtocolUnpack for QueryAgeActionData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 4 > data.len() {
            return None;
        }
        let target = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        *offset += 4;
        Some(Self { target })
    }
}

impl ProtocolPack for QueryAgeActionData {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.write_u32::<LittleEndian>(self.target).unwrap();
    }
}

/// chat-errors-8: C2S `Character_QueryBirth` (0x01C4) — retail
/// `CM_Character::Event_QueryBirth(i_target)` (acclient.c:698035);
/// `ClientCommunicationSystem::DoBirth` (:410915) always passes 0. ACE
/// (`GameActionQueryBirth.cs`) answers with a Broadcast chat line.
#[derive(Debug, Clone, PartialEq)]
pub struct QueryBirthActionData {
    pub target: u32,
}

impl ProtocolUnpack for QueryBirthActionData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 4 > data.len() {
            return None;
        }
        let target = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        *offset += 4;
        Some(Self { target })
    }
}

impl ProtocolPack for QueryBirthActionData {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.write_u32::<LittleEndian>(self.target).unwrap();
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ConfirmationResponseActionData {
    pub confirmation_type: ConfirmationType,
    pub context: u32,
    pub accepted: bool,
}

impl ProtocolUnpack for ConfirmationResponseActionData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 12 > data.len() {
            return None;
        }
        let confirmation_type =
            ConfirmationType::from_repr(LittleEndian::read_u32(&data[*offset..*offset + 4]))?;
        *offset += 4;
        let context = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        *offset += 4;
        let accepted = LittleEndian::read_i32(&data[*offset..*offset + 4]) != 0;
        *offset += 4;
        Some(Self {
            confirmation_type,
            context,
            accepted,
        })
    }
}

impl ProtocolPack for ConfirmationResponseActionData {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.write_u32::<LittleEndian>(self.confirmation_type as u32)
            .unwrap();
        buf.write_u32::<LittleEndian>(self.context).unwrap();
        buf.write_i32::<LittleEndian>(i32::from(self.accepted))
            .unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messages::game_action::{GameAction, GameActionMessage};
    use crate::test_fixtures as fixtures;
    use crate::test_helpers::assert_pack_unpack_parity;

    #[test]
    fn test_confirmation_response_parity() {
        let action = GameActionMessage {
            sequence: 0x55667788,
            action: GameAction::ConfirmationResponse(Box::new(ConfirmationResponseActionData {
                confirmation_type: ConfirmationType::CraftInteraction,
                context: 0xDEADBEEF,
                accepted: true,
            })),
        };
        assert_pack_unpack_parity(fixtures::ACTION_CONFIRMATION_RESPONSE, &action);
    }

    #[test]
    fn test_confirmation_response_fellowship_fixture() {
        let action = GameActionMessage {
            sequence: 0xCAFEBABE,
            action: GameAction::ConfirmationResponse(Box::new(ConfirmationResponseActionData {
                confirmation_type: ConfirmationType::Fellowship,
                context: 0xABCDEF01,
                accepted: true,
            })),
        };

        let fixture = hex::decode("BEBAFECA750200000400000001EFCDAB01000000").unwrap();
        assert_pack_unpack_parity(&fixture, &action);
    }

    #[test]
    fn test_tele_to_lifestone_fixture() {
        let action = GameActionMessage {
            sequence: 0x11111111,
            action: GameAction::TeleToLifestone(Box::new(TeleToLifestoneActionData)),
        };

        // Generated from ACE: SyntheticProtocolTests.GenerateChatAndRecallActionFixtures
        let fixture = hex::decode("1111111163000000").unwrap();
        assert_pack_unpack_parity(&fixture, &action);
    }

    #[test]
    fn test_tele_to_pkl_arena_fixture() {
        let action = GameActionMessage {
            sequence: 0x22222222,
            action: GameAction::TeleToPklArena(Box::new(TeleToPklArenaActionData)),
        };

        let fixture = hex::decode("2222222226000000").unwrap();
        assert_pack_unpack_parity(&fixture, &action);
    }

    #[test]
    fn test_tele_to_pk_arena_fixture() {
        let action = GameActionMessage {
            sequence: 0x22222222,
            action: GameAction::TeleToPkArena(Box::new(TeleToPkArenaActionData)),
        };

        let fixture = hex::decode("2222222227000000").unwrap();
        assert_pack_unpack_parity(&fixture, &action);
    }

    #[test]
    fn test_tele_to_mansion_fixture() {
        let action = GameActionMessage {
            sequence: 0x22222222,
            action: GameAction::TeleToMansion(Box::new(TeleToMansionActionData)),
        };

        // Generated from ACE: SyntheticProtocolTests.GenerateChatAndRecallActionFixtures
        let fixture = hex::decode("2222222278020000").unwrap();
        assert_pack_unpack_parity(&fixture, &action);
    }

    #[test]
    fn test_tele_to_marketplace_fixture() {
        let action = GameActionMessage {
            sequence: 0x33333333,
            action: GameAction::TeleToMarketPlace(Box::new(TeleToMarketPlaceActionData)),
        };

        let fixture = hex::decode("333333338d020000").unwrap();
        assert_pack_unpack_parity(&fixture, &action);
    }

    #[test]
    fn test_suicide_fixture() {
        let action = GameActionMessage {
            sequence: 0x33333333,
            action: GameAction::Suicide(Box::new(SuicideActionData)),
        };

        // Generated from ACE: SyntheticProtocolTests.GenerateChatAndRecallActionFixtures
        let fixture = hex::decode("3333333379020000").unwrap();
        assert_pack_unpack_parity(&fixture, &action);
    }

    #[test]
    fn test_enter_pkl_fixture() {
        let action = GameActionMessage {
            sequence: 0x44444444,
            action: GameAction::EnterPkLite(Box::new(EnterPkLiteActionData)),
        };

        // Generated from ACE: SyntheticProtocolTests.GenerateChatAndRecallActionFixtures
        let fixture = hex::decode("444444448F020000").unwrap();
        assert_pack_unpack_parity(&fixture, &action);
    }

    /// chat-errors-8: `/age` → opcode 0x01C2 + `u32 target` 0 (retail
    /// Event_QueryAge for a non-PSR player).
    #[test]
    fn test_query_age_packs_opcode_and_zero_target() {
        let action = GameActionMessage {
            sequence: 0x55555555,
            action: GameAction::QueryAge(Box::new(QueryAgeActionData { target: 0 })),
        };
        let mut packed = Vec::new();
        action.pack(&mut packed);
        assert_eq!(
            packed,
            vec![0x55, 0x55, 0x55, 0x55, 0xC2, 0x01, 0, 0, 0, 0, 0, 0]
        );
        let fixture = hex::decode("55555555C201000000000000").unwrap();
        assert_pack_unpack_parity(&fixture, &action);
    }

    /// chat-errors-8: `/birth` → opcode 0x01C4 + `u32 target` 0 (retail
    /// DoBirth always passes 0).
    #[test]
    fn test_query_birth_packs_opcode_and_zero_target() {
        let action = GameActionMessage {
            sequence: 0x66666666,
            action: GameAction::QueryBirth(Box::new(QueryBirthActionData { target: 0 })),
        };
        let mut packed = Vec::new();
        action.pack(&mut packed);
        assert_eq!(
            packed,
            vec![0x66, 0x66, 0x66, 0x66, 0xC4, 0x01, 0, 0, 0, 0, 0, 0]
        );
        let fixture = hex::decode("66666666C401000000000000").unwrap();
        assert_pack_unpack_parity(&fixture, &action);
        // A truncated body does not unpack.
        let mut offset = 0;
        assert!(GameActionMessage::unpack(&fixture[..10], &mut offset).is_none());
    }
}
