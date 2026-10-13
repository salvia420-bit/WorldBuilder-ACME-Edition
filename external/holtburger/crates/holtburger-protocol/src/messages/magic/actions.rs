use crate::traits::{ProtocolPack, ProtocolUnpack};
use byteorder::{ByteOrder, LittleEndian, WriteBytesExt};
use holtburger_common::Guid;

#[derive(Debug, Clone, PartialEq)]
pub struct CastTargetedSpellActionData {
    pub target: Guid,
    pub spell_id: u32,
}

impl ProtocolUnpack for CastTargetedSpellActionData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 8 > data.len() {
            return None;
        }
        let target = Guid::unpack(data, offset)?;
        let spell_id = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        *offset += 4;
        Some(CastTargetedSpellActionData { target, spell_id })
    }
}

impl ProtocolPack for CastTargetedSpellActionData {
    fn pack(&self, buf: &mut Vec<u8>) {
        self.target.pack(buf);
        buf.write_u32::<LittleEndian>(self.spell_id).unwrap();
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct CastUntargetedSpellActionData {
    pub spell_id: u32,
}

impl ProtocolUnpack for CastUntargetedSpellActionData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 4 > data.len() {
            return None;
        }
        let spell_id = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        *offset += 4;
        Some(CastUntargetedSpellActionData { spell_id })
    }
}

impl ProtocolPack for CastUntargetedSpellActionData {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.write_u32::<LittleEndian>(self.spell_id).unwrap();
    }
}

/// Phase J — `GameAction::RemoveSpellFromBook` payload (C2S). The
/// client tells ACE to drop `spell_id` from the player's spellbook.
/// ACE handles the removal server-side and may broadcast a
/// `GameEventMagicRemoveSpell` (opcode 0x01A8) back.
#[derive(Debug, Clone, PartialEq)]
pub struct RemoveSpellFromBookActionData {
    pub spell_id: u32,
}

impl ProtocolUnpack for RemoveSpellFromBookActionData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 4 > data.len() {
            return None;
        }
        let spell_id = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        *offset += 4;
        Some(RemoveSpellFromBookActionData { spell_id })
    }
}

impl ProtocolPack for RemoveSpellFromBookActionData {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.write_u32::<LittleEndian>(self.spell_id).unwrap();
    }
}

/// input-options-2 (2026-10-13) — `GameAction::AddSpellFavorite` (0x01E3)
/// payload: put `spell_id` on spell bar `list` (0..7) at list position
/// `index`. Retail `CM_Character::Event_AddSpellFavorite(i_spid, i_index,
/// i_list)` (acclient.c:697556), sent by
/// `SpellCastSubMenu::AddSpellToPlayerModule`. ACE
/// `GameActionAddSpellFavorite` reads the three u32 in this order and
/// `CharacterExtensions.AddSpellToBar` inserts at `min(index, count)`.
#[derive(Debug, Clone, PartialEq)]
pub struct AddSpellFavoriteActionData {
    pub spell_id: u32,
    pub index: u32,
    pub list: u32,
}

impl ProtocolUnpack for AddSpellFavoriteActionData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 12 > data.len() {
            return None;
        }
        let spell_id = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        let index = LittleEndian::read_u32(&data[*offset + 4..*offset + 8]);
        let list = LittleEndian::read_u32(&data[*offset + 8..*offset + 12]);
        *offset += 12;
        Some(AddSpellFavoriteActionData {
            spell_id,
            index,
            list,
        })
    }
}

impl ProtocolPack for AddSpellFavoriteActionData {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.write_u32::<LittleEndian>(self.spell_id).unwrap();
        buf.write_u32::<LittleEndian>(self.index).unwrap();
        buf.write_u32::<LittleEndian>(self.list).unwrap();
    }
}

/// input-options-2 — `GameAction::RemoveSpellFavorite` (0x01E4) payload:
/// take `spell_id` off spell bar `list`. Retail
/// `CM_Character::Event_RemoveSpellFavorite(i_spid, i_list)`
/// (acclient.c:698135), sent by
/// `SpellCastSubMenu::RemoveSpellFromPlayerModule`. ACE
/// `GameActionRemoveSpellFavorite` → `TryRemoveSpellFromBar`.
#[derive(Debug, Clone, PartialEq)]
pub struct RemoveSpellFavoriteActionData {
    pub spell_id: u32,
    pub list: u32,
}

impl ProtocolUnpack for RemoveSpellFavoriteActionData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 8 > data.len() {
            return None;
        }
        let spell_id = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        let list = LittleEndian::read_u32(&data[*offset + 4..*offset + 8]);
        *offset += 8;
        Some(RemoveSpellFavoriteActionData { spell_id, list })
    }
}

impl ProtocolPack for RemoveSpellFavoriteActionData {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.write_u32::<LittleEndian>(self.spell_id).unwrap();
        buf.write_u32::<LittleEndian>(self.list).unwrap();
    }
}

/// input-options-2 — `GameAction::SpellbookFilter` (0x0286) payload: the
/// whole spellbook filter word (retail `SpellbookFilter` bits). Retail
/// `CM_Character::Event_SpellbookFilterEvent(i_options)`
/// (acclient.c:698239), sent by `gmSpellbookUI::UpdateFilter` on every
/// change. ACE `GameActionSpellbookFilter` → `HandleSpellbookFilters`.
#[derive(Debug, Clone, PartialEq)]
pub struct SpellbookFilterActionData {
    pub filters: u32,
}

impl ProtocolUnpack for SpellbookFilterActionData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 4 > data.len() {
            return None;
        }
        let filters = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        *offset += 4;
        Some(SpellbookFilterActionData { filters })
    }
}

impl ProtocolPack for SpellbookFilterActionData {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.write_u32::<LittleEndian>(self.filters).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messages::game_action::{GameAction, GameActionMessage};
    use crate::test_helpers::assert_pack_unpack_parity;

    #[test]
    fn test_cast_targeted_spell_parity() {
        let expected = CastTargetedSpellActionData {
            target: Guid(0x50000001),
            spell_id: 1234,
        };
        // Generated from ACE: SyntheticProtocolTests.DumpSpells
        let fixture = hex::decode("01000050D2040000").unwrap();
        assert_pack_unpack_parity(&fixture, &expected);
    }

    #[test]
    fn test_cast_untargeted_spell_parity() {
        let expected = CastUntargetedSpellActionData { spell_id: 1234 };
        // Generated from ACE: SyntheticProtocolTests.DumpSpells
        let fixture = hex::decode("D2040000").unwrap();
        assert_pack_unpack_parity(&fixture, &expected);
    }

    /// input-options-2: the three opcodes resolve (Chorizite GameActionType
    /// Character_AddSpellFavorite / _RemoveSpellFavorite /
    /// _SpellbookFilterEvent; retail writes 483 / 484 / 646).
    #[test]
    fn test_spell_favorite_opcodes_resolve() {
        use crate::opcodes::GameActionOpcode;
        assert_eq!(
            GameActionOpcode::from_repr(0x01E3),
            Some(GameActionOpcode::AddSpellFavorite)
        );
        assert_eq!(
            GameActionOpcode::from_repr(0x01E4),
            Some(GameActionOpcode::RemoveSpellFavorite)
        );
        assert_eq!(
            GameActionOpcode::from_repr(0x0286),
            Some(GameActionOpcode::SpellbookFilter)
        );
    }

    /// input-options-2: AddSpellFavorite = opcode 0x01E3 + u32 spell, u32
    /// index, u32 list (retail Event_AddSpellFavorite / ACE
    /// GameActionAddSpellFavorite order).
    #[test]
    fn test_add_spell_favorite_wire_layout() {
        let action = GameActionMessage {
            sequence: 0x11223344,
            action: GameAction::AddSpellFavorite(Box::new(AddSpellFavoriteActionData {
                spell_id: 0x0000_04D2,
                index: 3,
                list: 7,
            })),
        };
        let mut packed = Vec::new();
        action.pack(&mut packed);
        assert_eq!(
            packed,
            vec![
                0x44, 0x33, 0x22, 0x11, // sequence
                0xE3, 0x01, 0x00, 0x00, // 0x01E3
                0xD2, 0x04, 0x00, 0x00, // spell 1234
                0x03, 0x00, 0x00, 0x00, // index
                0x07, 0x00, 0x00, 0x00, // list
            ]
        );
        let fixture = hex::decode("44332211E3010000D20400000300000007000000").unwrap();
        assert_pack_unpack_parity(&fixture, &action);
        assert_pack_unpack_parity(
            &fixture[8..],
            &AddSpellFavoriteActionData { spell_id: 1234, index: 3, list: 7 },
        );
        // A truncated body does not unpack.
        let mut offset = 0;
        assert!(GameActionMessage::unpack(&fixture[..18], &mut offset).is_none());
    }

    /// input-options-2: RemoveSpellFavorite = opcode 0x01E4 + u32 spell,
    /// u32 list.
    #[test]
    fn test_remove_spell_favorite_wire_layout() {
        let action = GameActionMessage {
            sequence: 0x01,
            action: GameAction::RemoveSpellFavorite(Box::new(RemoveSpellFavoriteActionData {
                spell_id: 1234,
                list: 2,
            })),
        };
        let mut packed = Vec::new();
        action.pack(&mut packed);
        assert_eq!(
            packed,
            vec![
                0x01, 0x00, 0x00, 0x00, // sequence
                0xE4, 0x01, 0x00, 0x00, // 0x01E4
                0xD2, 0x04, 0x00, 0x00, // spell 1234
                0x02, 0x00, 0x00, 0x00, // list
            ]
        );
        let fixture = hex::decode("01000000E4010000D204000002000000").unwrap();
        assert_pack_unpack_parity(&fixture, &action);
    }

    /// input-options-2: SpellbookFilter = opcode 0x0286 + the u32 filter
    /// word (0x3FFF = retail Default_SpellbookFilter, Level_9 bit kept).
    #[test]
    fn test_spellbook_filter_wire_layout() {
        let action = GameActionMessage {
            sequence: 0x02,
            action: GameAction::SpellbookFilter(Box::new(SpellbookFilterActionData {
                filters: 0x3FFF,
            })),
        };
        let mut packed = Vec::new();
        action.pack(&mut packed);
        assert_eq!(
            packed,
            vec![
                0x02, 0x00, 0x00, 0x00, // sequence
                0x86, 0x02, 0x00, 0x00, // 0x0286
                0xFF, 0x3F, 0x00, 0x00, // filters
            ]
        );
        let fixture = hex::decode("0200000086020000FF3F0000").unwrap();
        assert_pack_unpack_parity(&fixture, &action);
    }
}
