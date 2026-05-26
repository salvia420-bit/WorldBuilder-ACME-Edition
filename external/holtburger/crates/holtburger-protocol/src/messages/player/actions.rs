use crate::messages::utils::{read_string16, write_string16};
use crate::traits::{ProtocolPack, ProtocolUnpack};
use byteorder::{ByteOrder, LittleEndian, WriteBytesExt};
use holtburger_common::CharacterOption;
use holtburger_common::Guid;

#[derive(Debug, Clone, PartialEq)]
pub struct RaiseAttributeActionData {
    pub attribute_type: u32,
    pub xp_spent: u32,
}

impl ProtocolUnpack for RaiseAttributeActionData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 8 > data.len() {
            return None;
        }
        let attribute_type = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        *offset += 4;
        let xp_spent = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        *offset += 4;
        Some(Self {
            attribute_type,
            xp_spent,
        })
    }
}

impl ProtocolPack for RaiseAttributeActionData {
    fn pack(&self, writer: &mut Vec<u8>) {
        writer
            .write_u32::<LittleEndian>(self.attribute_type)
            .unwrap();
        writer.write_u32::<LittleEndian>(self.xp_spent).unwrap();
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct RaiseVitalActionData {
    pub vital_type: u32,
    pub xp_spent: u32,
}

impl ProtocolUnpack for RaiseVitalActionData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 8 > data.len() {
            return None;
        }
        let vital_type = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        *offset += 4;
        let xp_spent = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        *offset += 4;
        Some(Self {
            vital_type,
            xp_spent,
        })
    }
}

impl ProtocolPack for RaiseVitalActionData {
    fn pack(&self, writer: &mut Vec<u8>) {
        writer.write_u32::<LittleEndian>(self.vital_type).unwrap();
        writer.write_u32::<LittleEndian>(self.xp_spent).unwrap();
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct RaiseSkillActionData {
    pub skill_type: u32,
    pub xp_spent: u32,
}

impl ProtocolUnpack for RaiseSkillActionData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 8 > data.len() {
            return None;
        }
        let skill_type = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        *offset += 4;
        let xp_spent = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        *offset += 4;
        Some(Self {
            skill_type,
            xp_spent,
        })
    }
}

impl ProtocolPack for RaiseSkillActionData {
    fn pack(&self, writer: &mut Vec<u8>) {
        writer.write_u32::<LittleEndian>(self.skill_type).unwrap();
        writer.write_u32::<LittleEndian>(self.xp_spent).unwrap();
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct TrainSkillActionData {
    pub skill_type: u32,
    pub credits_spent: i32,
}

impl ProtocolUnpack for TrainSkillActionData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 8 > data.len() {
            return None;
        }
        let skill_type = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        *offset += 4;
        let credits_spent = LittleEndian::read_i32(&data[*offset..*offset + 4]);
        *offset += 4;
        Some(Self {
            skill_type,
            credits_spent,
        })
    }
}

impl ProtocolPack for TrainSkillActionData {
    fn pack(&self, writer: &mut Vec<u8>) {
        writer.write_u32::<LittleEndian>(self.skill_type).unwrap();
        writer
            .write_i32::<LittleEndian>(self.credits_spent)
            .unwrap();
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SetSingleCharacterOptionActionData {
    pub option: CharacterOption,
    pub value: bool,
}

impl ProtocolUnpack for SetSingleCharacterOptionActionData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 8 > data.len() {
            return None;
        }
        let option_raw = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        *offset += 4;
        let value = LittleEndian::read_u32(&data[*offset..*offset + 4]) != 0;
        *offset += 4;
        Some(Self {
            option: CharacterOption::from_repr(option_raw)?,
            value,
        })
    }
}

impl ProtocolPack for SetSingleCharacterOptionActionData {
    fn pack(&self, writer: &mut Vec<u8>) {
        writer
            .write_u32::<LittleEndian>(self.option as u32)
            .unwrap();
        writer
            .write_u32::<LittleEndian>(u32::from(self.value))
            .unwrap();
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SwearAllegianceActionData {
    pub target_guid: Guid,
}

impl ProtocolUnpack for SwearAllegianceActionData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        let target_guid = Guid::unpack(data, offset)?;
        Some(Self { target_guid })
    }
}

impl ProtocolPack for SwearAllegianceActionData {
    fn pack(&self, writer: &mut Vec<u8>) {
        self.target_guid.pack(writer);
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct BreakAllegianceActionData {
    pub target_guid: Guid,
}

impl ProtocolUnpack for BreakAllegianceActionData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        let target_guid = Guid::unpack(data, offset)?;
        Some(Self { target_guid })
    }
}

impl ProtocolPack for BreakAllegianceActionData {
    fn pack(&self, writer: &mut Vec<u8>) {
        self.target_guid.pack(writer);
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct AddPlayerPermissionActionData {
    pub player_name: String,
}

impl ProtocolUnpack for AddPlayerPermissionActionData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        let player_name = read_string16(data, offset)?;
        Some(Self { player_name })
    }
}

impl ProtocolPack for AddPlayerPermissionActionData {
    fn pack(&self, writer: &mut Vec<u8>) {
        write_string16(writer, &self.player_name);
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct RemovePlayerPermissionActionData {
    pub player_name: String,
}

impl ProtocolUnpack for RemovePlayerPermissionActionData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        let player_name = read_string16(data, offset)?;
        Some(Self { player_name })
    }
}

impl ProtocolPack for RemovePlayerPermissionActionData {
    fn pack(&self, writer: &mut Vec<u8>) {
        write_string16(writer, &self.player_name);
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct AddFriendActionData {
    pub friend_name: String,
}

impl ProtocolUnpack for AddFriendActionData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        let friend_name = read_string16(data, offset)?;
        Some(Self { friend_name })
    }
}

impl ProtocolPack for AddFriendActionData {
    fn pack(&self, writer: &mut Vec<u8>) {
        write_string16(writer, &self.friend_name);
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct RemoveFriendActionData {
    pub friend_guid: Guid,
}

impl ProtocolUnpack for RemoveFriendActionData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        let friend_guid = Guid::unpack(data, offset)?;
        Some(Self { friend_guid })
    }
}

impl ProtocolPack for RemoveFriendActionData {
    fn pack(&self, writer: &mut Vec<u8>) {
        self.friend_guid.pack(writer);
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ModifyCharacterSquelchActionData {
    pub add: bool,
    pub target_guid: Guid,
    pub target_name: String,
    /// `ChatMessageType` bitmask. 0xFFFFFFFF squelches every category
    /// (retail UX shortcut for "squelch everything"); ACE persists it
    /// per-character in SquelchManager.
    pub message_type: u32,
}

impl ProtocolUnpack for ModifyCharacterSquelchActionData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 4 > data.len() {
            return None;
        }
        let add = LittleEndian::read_u32(&data[*offset..*offset + 4]) != 0;
        *offset += 4;
        let target_guid = Guid::unpack(data, offset)?;
        let target_name = read_string16(data, offset)?;
        if *offset + 4 > data.len() {
            return None;
        }
        let message_type = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        *offset += 4;
        Some(Self {
            add,
            target_guid,
            target_name,
            message_type,
        })
    }
}

impl ProtocolPack for ModifyCharacterSquelchActionData {
    fn pack(&self, writer: &mut Vec<u8>) {
        writer
            .write_u32::<LittleEndian>(u32::from(self.add))
            .unwrap();
        self.target_guid.pack(writer);
        write_string16(writer, &self.target_name);
        writer
            .write_u32::<LittleEndian>(self.message_type)
            .unwrap();
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SetAllegianceNameActionData {
    pub new_name: String,
}

impl ProtocolUnpack for SetAllegianceNameActionData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        let new_name = read_string16(data, offset)?;
        Some(Self { new_name })
    }
}

impl ProtocolPack for SetAllegianceNameActionData {
    fn pack(&self, writer: &mut Vec<u8>) {
        write_string16(writer, &self.new_name);
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SetAllegianceOfficerActionData {
    pub target_name: String,
    pub officer_level: u32,
}

impl ProtocolUnpack for SetAllegianceOfficerActionData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        let target_name = read_string16(data, offset)?;
        if *offset + 4 > data.len() {
            return None;
        }
        let officer_level = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        *offset += 4;
        Some(Self {
            target_name,
            officer_level,
        })
    }
}

impl ProtocolPack for SetAllegianceOfficerActionData {
    fn pack(&self, writer: &mut Vec<u8>) {
        write_string16(writer, &self.target_name);
        writer
            .write_u32::<LittleEndian>(self.officer_level)
            .unwrap();
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct AllegianceChatGagActionData {
    pub target_name: String,
    /// ACE reads `Convert.ToBoolean(ReadUInt32())` — wire is a u32, 0 = unmute, nonzero = mute.
    pub gag_on: bool,
}

impl ProtocolUnpack for AllegianceChatGagActionData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        let target_name = read_string16(data, offset)?;
        if *offset + 4 > data.len() {
            return None;
        }
        let gag_on = LittleEndian::read_u32(&data[*offset..*offset + 4]) != 0;
        *offset += 4;
        Some(Self {
            target_name,
            gag_on,
        })
    }
}

impl ProtocolPack for AllegianceChatGagActionData {
    fn pack(&self, writer: &mut Vec<u8>) {
        write_string16(writer, &self.target_name);
        writer
            .write_u32::<LittleEndian>(u32::from(self.gag_on))
            .unwrap();
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ModifyAccountSquelchActionData {
    pub add: bool,
    pub account_name: String,
}

impl ProtocolUnpack for ModifyAccountSquelchActionData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 4 > data.len() {
            return None;
        }
        let add = LittleEndian::read_u32(&data[*offset..*offset + 4]) != 0;
        *offset += 4;
        let account_name = read_string16(data, offset)?;
        Some(Self { add, account_name })
    }
}

impl ProtocolPack for ModifyAccountSquelchActionData {
    fn pack(&self, writer: &mut Vec<u8>) {
        writer
            .write_u32::<LittleEndian>(u32::from(self.add))
            .unwrap();
        write_string16(writer, &self.account_name);
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ModifyGlobalSquelchActionData {
    pub add: bool,
    /// `ChatMessageType` bitmask. 0xFFFFFFFF squelches every category
    /// (retail UX shortcut). ACE persists account-wide via SquelchManager.
    pub message_type: u32,
}

impl ProtocolUnpack for ModifyGlobalSquelchActionData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 8 > data.len() {
            return None;
        }
        let add = LittleEndian::read_u32(&data[*offset..*offset + 4]) != 0;
        *offset += 4;
        let message_type = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        *offset += 4;
        Some(Self { add, message_type })
    }
}

impl ProtocolPack for ModifyGlobalSquelchActionData {
    fn pack(&self, writer: &mut Vec<u8>) {
        writer
            .write_u32::<LittleEndian>(u32::from(self.add))
            .unwrap();
        writer
            .write_u32::<LittleEndian>(self.message_type)
            .unwrap();
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct TitleSetActionData {
    pub title_id: u32,
}

impl ProtocolUnpack for TitleSetActionData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 4 > data.len() {
            return None;
        }
        let title_id = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        *offset += 4;
        Some(Self { title_id })
    }
}

impl ProtocolPack for TitleSetActionData {
    fn pack(&self, writer: &mut Vec<u8>) {
        writer.write_u32::<LittleEndian>(self.title_id).unwrap();
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct RecallAllegianceHometownActionData {}

impl ProtocolUnpack for RecallAllegianceHometownActionData {
    fn unpack(_data: &[u8], _offset: &mut usize) -> Option<Self> {
        Some(Self {})
    }
}

impl ProtocolPack for RecallAllegianceHometownActionData {
    fn pack(&self, _writer: &mut Vec<u8>) {}
}

#[derive(Debug, Clone, PartialEq)]
pub struct AddAllegianceBanActionData {
    pub target_name: String,
}

impl ProtocolUnpack for AddAllegianceBanActionData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        let target_name = read_string16(data, offset)?;
        Some(Self { target_name })
    }
}

impl ProtocolPack for AddAllegianceBanActionData {
    fn pack(&self, writer: &mut Vec<u8>) {
        write_string16(writer, &self.target_name);
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct RemoveAllegianceBanActionData {
    pub target_name: String,
}

impl ProtocolUnpack for RemoveAllegianceBanActionData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        let target_name = read_string16(data, offset)?;
        Some(Self { target_name })
    }
}

impl ProtocolPack for RemoveAllegianceBanActionData {
    fn pack(&self, writer: &mut Vec<u8>) {
        write_string16(writer, &self.target_name);
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct BreakAllegianceBootActionData {
    pub target_name: String,
    /// ACE reads `Convert.ToBoolean(ReadUInt32())` — wire is a u32, 0 = leave on, nonzero = boot the entire account.
    pub account_boot: bool,
}

impl ProtocolUnpack for BreakAllegianceBootActionData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        let target_name = read_string16(data, offset)?;
        if *offset + 4 > data.len() {
            return None;
        }
        let account_boot = LittleEndian::read_u32(&data[*offset..*offset + 4]) != 0;
        *offset += 4;
        Some(Self {
            target_name,
            account_boot,
        })
    }
}

impl ProtocolPack for BreakAllegianceBootActionData {
    fn pack(&self, writer: &mut Vec<u8>) {
        write_string16(writer, &self.target_name);
        writer
            .write_u32::<LittleEndian>(u32::from(self.account_boot))
            .unwrap();
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct DoAllegianceLockActionActionData {
    /// `AllegianceLockAction` enum value (ACE): 0=Undef, 1=Off, 2=On, 3=Toggle,
    /// 4=Check, 5=CheckApproved, 6=ClearApproved. ACE casts the raw u32 to the enum.
    pub lock_action: u32,
}

impl ProtocolUnpack for DoAllegianceLockActionActionData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 4 > data.len() {
            return None;
        }
        let lock_action = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        *offset += 4;
        Some(Self { lock_action })
    }
}

impl ProtocolPack for DoAllegianceLockActionActionData {
    fn pack(&self, writer: &mut Vec<u8>) {
        writer.write_u32::<LittleEndian>(self.lock_action).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messages::game_action::{GameAction, GameActionMessage};
    use crate::test_fixtures as fixtures;
    use crate::test_helpers::assert_pack_unpack_parity;
    use byteorder::{LittleEndian, WriteBytesExt};
    use holtburger_common::CharacterOption;

    #[test]
    fn test_raise_attribute_parity() {
        let action = GameActionMessage {
            sequence: 0x55,
            action: GameAction::RaiseAttribute(Box::new(RaiseAttributeActionData {
                attribute_type: 1, // Strength
                xp_spent: 1000,
            })),
        };
        assert_pack_unpack_parity(fixtures::ACTION_RAISE_ATTRIBUTE, &action);
    }

    #[test]
    fn test_raise_vital_parity() {
        let action = GameActionMessage {
            sequence: 0x66,
            action: GameAction::RaiseVital(Box::new(RaiseVitalActionData {
                vital_type: 2, // Health
                xp_spent: 500,
            })),
        };
        assert_pack_unpack_parity(fixtures::ACTION_RAISE_VITAL, &action);
    }

    #[test]
    fn test_raise_skill_parity() {
        let action = GameActionMessage {
            sequence: 0x77,
            action: GameAction::RaiseSkill(Box::new(RaiseSkillActionData {
                skill_type: 6, // Melee Defense
                xp_spent: 2500,
            })),
        };
        assert_pack_unpack_parity(fixtures::ACTION_RAISE_SKILL, &action);
    }

    #[test]
    fn test_train_skill_parity() {
        let action = GameActionMessage {
            sequence: 0x88,
            action: GameAction::TrainSkill(Box::new(TrainSkillActionData {
                skill_type: 14, // Arcane Lore
                credits_spent: 4,
            })),
        };
        let mut expected = Vec::new();
        expected.write_u32::<LittleEndian>(0x88).unwrap(); // sequence
        expected.write_u32::<LittleEndian>(0x0047).unwrap(); // action_type
        expected.write_u32::<LittleEndian>(14).unwrap(); // skill_type
        expected.write_i32::<LittleEndian>(4).unwrap(); // credits_spent

        let mut packed = Vec::new();
        action.pack(&mut packed);
        assert_eq!(packed, expected);

        let mut offset = 0;
        let unpacked = GameActionMessage::unpack(&packed, &mut offset).unwrap();
        assert_eq!(unpacked, action);
    }

    #[test]
    fn test_set_single_character_option_parity() {
        let action = GameActionMessage {
            sequence: 0x11223344,
            action: GameAction::SetSingleCharacterOption(Box::new(
                SetSingleCharacterOptionActionData {
                    option: CharacterOption::UseCraftingChanceOfSuccessDialog,
                    value: true,
                },
            )),
        };
        assert_pack_unpack_parity(fixtures::ACTION_SET_SINGLE_CHARACTER_OPTION, &action);
    }

    #[test]
    fn test_swear_allegiance_parity() {
        let action = GameActionMessage {
            sequence: 0x11223344,
            action: GameAction::SwearAllegiance(Box::new(SwearAllegianceActionData {
                target_guid: Guid(0x5000_0042),
            })),
        };

        let fixture = hex::decode("443322111D00000042000050").unwrap();
        assert_pack_unpack_parity(&fixture, &action);
    }

    #[test]
    fn test_break_allegiance_parity() {
        let action = GameActionMessage {
            sequence: 0x11223344,
            action: GameAction::BreakAllegiance(Box::new(BreakAllegianceActionData {
                target_guid: Guid(0x5000_0042),
            })),
        };

        let fixture = hex::decode("443322111E00000042000050").unwrap();
        assert_pack_unpack_parity(&fixture, &action);
    }

    #[test]
    fn test_add_player_permission_parity() {
        let action = GameActionMessage {
            sequence: 0x01020304,
            action: GameAction::AddPlayerPermission(Box::new(AddPlayerPermissionActionData {
                player_name: "Bestie".to_string(),
            })),
        };

        let fixture = hex::decode("04030201190200000600426573746965").unwrap();
        assert_pack_unpack_parity(&fixture, &action);
    }

    #[test]
    fn test_remove_player_permission_parity() {
        let action = GameActionMessage {
            sequence: 0x05060708,
            action: GameAction::RemovePlayerPermission(Box::new(
                RemovePlayerPermissionActionData {
                    player_name: "Bestie".to_string(),
                },
            )),
        };

        let fixture = hex::decode("080706051A0200000600426573746965").unwrap();
        assert_pack_unpack_parity(&fixture, &action);
    }
}
