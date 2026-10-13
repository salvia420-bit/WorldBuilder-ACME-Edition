//! maps-chargen-barber-1 (2026-10-13): C2S `Character_FinishBarber`
//! (`GameAction` 0x0311) — the barber page's Apply.
//!
//! Retail `gmBarberUI::ListenToElementMessage` (Apply, element 0x100005A6,
//! acclient.c:270299-270316) calls `CM_Character::Event_FinishBarber` with
//! the same 16 values `GameEventStartBarber` (0x0075) delivered: base
//! palette, head object, hair texture + default, eyes texture + default,
//! nose texture + default, mouth texture + default, skin / hair / eyes
//! palette, setup, option1, option2 (always 0). ACE reads them in that order
//! (`Player_Character.HandleActionFinishBarber`, Player_Character.cs:409-425),
//! so the action body IS the StartBarber layout and reuses its pack/unpack.

use super::events::StartBarberEventData;

/// `GameAction::FinishBarber` (0x0311) body: the 16 u32 of
/// [`StartBarberEventData`], in the same order.
pub type FinishBarberActionData = StartBarberEventData;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messages::game_action::{GameAction, GameActionMessage};
    use crate::messages::game_message::GameMessage;
    use crate::traits::{ProtocolPack, ProtocolUnpack};
    use byteorder::{ByteOrder, LittleEndian};

    fn sample() -> FinishBarberActionData {
        FinishBarberActionData {
            palette_base_did: 0x0400_007E,
            head_object_did: 0x0100_47F6,
            hair_texture: 0x0500_10B7,
            default_hair_texture: 0x0500_10B6,
            eyes_texture_did: 0x0500_1101,
            default_eyes_texture_did: 0x0500_1100,
            nose_texture_did: 0x0500_1201,
            default_nose_texture_did: 0x0500_1200,
            mouth_texture_did: 0x0500_1301,
            default_mouth_texture_did: 0x0500_1300,
            skin_palette_did: 0x0400_1001,
            hair_palette_did: 0x0400_1002,
            eyes_palette_did: 0x0400_1003,
            setup_table_id: 0x0200_0001,
            option1: 1,
            option2: 0,
        }
    }

    #[test]
    fn finish_barber_packs_opcode_and_sixteen_u32_in_ace_read_order() {
        let data = sample();
        let msg = GameMessage::GameAction(Box::new(GameActionMessage {
            sequence: 7,
            action: GameAction::FinishBarber(Box::new(data.clone())),
        }));
        let mut buf = Vec::new();
        msg.pack(&mut buf);
        // [u32 0xF7B1][u32 sequence][u32 0x0311][16 × u32]
        assert_eq!(buf.len(), 12 + 64, "header + 16 u32 body");
        assert_eq!(LittleEndian::read_u32(&buf[0..4]), 0xF7B1);
        assert_eq!(LittleEndian::read_u32(&buf[4..8]), 7);
        assert_eq!(LittleEndian::read_u32(&buf[8..12]), 0x0311);
        let body: Vec<u32> = (0..16)
            .map(|i| LittleEndian::read_u32(&buf[12 + 4 * i..16 + 4 * i]))
            .collect();
        // Player_Character.cs:409-425 read order.
        assert_eq!(body, data.to_fields().to_vec());
        assert_eq!(body[0], 0x0400_007E, "requestedPaletteBaseId");
        assert_eq!(body[1], 0x0100_47F6, "requestedHeadObjectDID");
        assert_eq!(body[2], 0x0500_10B7, "requestedCharacterHairTexture");
        assert_eq!(body[13], 0x0200_0001, "requestedSetupTableId");
        assert_eq!(body[14], 1, "option_bound");
        assert_eq!(body[15], 0, "option_unk");
    }

    #[test]
    fn finish_barber_round_trips_and_matches_start_barber_body() {
        let data = sample();
        let msg = GameMessage::GameAction(Box::new(GameActionMessage {
            sequence: 3,
            action: GameAction::FinishBarber(Box::new(data.clone())),
        }));
        let mut buf = Vec::new();
        msg.pack(&mut buf);
        let mut off = 0;
        let back = GameMessage::unpack(&buf, &mut off).expect("unpack FinishBarber");
        assert_eq!(off, buf.len());
        assert_eq!(back, msg);

        // The action body is byte-identical to a StartBarber event body.
        let mut start_body = Vec::new();
        data.pack(&mut start_body);
        assert_eq!(&buf[12..], &start_body[..]);

        let fields = data.to_fields();
        assert_eq!(FinishBarberActionData::from_fields(&fields), data);
    }
}
