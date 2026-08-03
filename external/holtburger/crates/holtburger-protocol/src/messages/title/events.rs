use crate::messages::utils::require_fixed_stride;
use crate::traits::{ProtocolPack, ProtocolUnpack};
use byteorder::{ByteOrder, LittleEndian, WriteBytesExt};

/// Mirrors `ACE.Server.Network.GameEvent.Events.GameEventCharacterTitle`.
/// Wire shape: `[u32 unknown_const=1, u32 current_title_id, u32 num_titles,
/// u32 title_id[num_titles]]`. The leading `1u32` is asserted on unpack
/// and re-emitted on pack — we don't store it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CharacterTitleEventData {
    pub current_title_id: u32,
    pub title_ids: Vec<u32>,
}

impl ProtocolUnpack for CharacterTitleEventData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 12 > data.len() {
            return None;
        }
        let unknown_const = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        if unknown_const != 1 {
            log::warn!(
                "CharacterTitle: leading constant expected 1, got {} (continuing)",
                unknown_const
            );
        }
        let current_title_id = LittleEndian::read_u32(&data[*offset + 4..*offset + 8]);
        let num_titles = LittleEndian::read_u32(&data[*offset + 8..*offset + 12]) as usize;
        *offset += 12;

        // Rust review 2026-08-03 (F-sweep): `num_titles * 4` wrapped 32-bit
        // usize on wasm32, so the guard passed for counts >= 0x40000000 and the
        // `with_capacity` below reserved multi-GB. See `utils::require_fixed_stride`.
        require_fixed_stride(data, *offset, num_titles, 4)?;
        let mut title_ids = Vec::with_capacity(num_titles);
        for _ in 0..num_titles {
            title_ids.push(LittleEndian::read_u32(&data[*offset..*offset + 4]));
            *offset += 4;
        }

        Some(Self {
            current_title_id,
            title_ids,
        })
    }
}

impl ProtocolPack for CharacterTitleEventData {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.write_u32::<LittleEndian>(1).unwrap();
        buf.write_u32::<LittleEndian>(self.current_title_id).unwrap();
        buf.write_u32::<LittleEndian>(self.title_ids.len() as u32)
            .unwrap();
        for id in &self.title_ids {
            buf.write_u32::<LittleEndian>(*id).unwrap();
        }
    }
}

/// Mirrors `ACE.Server.Network.GameEvent.Events.GameEventUpdateTitle`.
/// Wire shape: `[u32 title_id, u32 set_as_display_title]`. The bool is
/// sent as u32 (0/1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateTitleEventData {
    pub title_id: u32,
    pub set_as_display: bool,
}

impl ProtocolUnpack for UpdateTitleEventData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 8 > data.len() {
            return None;
        }
        let title_id = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        let set_as_display = LittleEndian::read_u32(&data[*offset + 4..*offset + 8]) != 0;
        *offset += 8;
        Some(Self {
            title_id,
            set_as_display,
        })
    }
}

impl ProtocolPack for UpdateTitleEventData {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.write_u32::<LittleEndian>(self.title_id).unwrap();
        buf.write_u32::<LittleEndian>(u32::from(self.set_as_display))
            .unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messages::{GameEvent, GameEventMessage};
    use holtburger_common::Guid;

    fn round_trip(msg: &GameEventMessage) {
        let mut packed = Vec::new();
        msg.pack(&mut packed);
        let mut offset = 0;
        let unpacked = GameEventMessage::unpack(&packed, &mut offset).expect("unpack failed");
        assert_eq!(offset, packed.len(), "extra bytes left after unpack");
        assert_eq!(&unpacked, msg, "round-trip mismatch");
    }

    #[test]
    fn character_title_round_trip_three_titles() {
        let event = CharacterTitleEventData {
            current_title_id: 7,
            title_ids: vec![1, 7, 42, 1337],
        };
        let msg = GameEventMessage {
            target: Guid(0x5000_0001),
            sequence: 1,
            event: GameEvent::CharacterTitle(Box::new(event)),
        };
        round_trip(&msg);
    }

    #[test]
    fn update_title_round_trip() {
        let event = UpdateTitleEventData {
            title_id: 0x1234,
            set_as_display: true,
        };
        let msg = GameEventMessage {
            target: Guid(0x5000_0001),
            sequence: 2,
            event: GameEvent::UpdateTitle(Box::new(event)),
        };
        round_trip(&msg);

        let event2 = UpdateTitleEventData {
            title_id: 0x5678,
            set_as_display: false,
        };
        let msg2 = GameEventMessage {
            target: Guid(0x5000_0001),
            sequence: 3,
            event: GameEvent::UpdateTitle(Box::new(event2)),
        };
        round_trip(&msg2);
    }
}
