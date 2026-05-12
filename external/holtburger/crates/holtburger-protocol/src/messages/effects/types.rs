use crate::traits::{ProtocolPack, ProtocolUnpack};
use byteorder::{ByteOrder, LittleEndian, WriteBytesExt};
use holtburger_common::Guid;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlaySoundData {
    pub target: Guid,
    pub sound_id: u32,
    pub volume: f32,
}

impl ProtocolUnpack for PlaySoundData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        let target = Guid::unpack(data, offset)?;
        if *offset + 8 > data.len() {
            return None;
        }
        let sound_id = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        let volume = LittleEndian::read_f32(&data[*offset + 4..*offset + 8]);
        *offset += 8;
        Some(PlaySoundData {
            target,
            sound_id,
            volume,
        })
    }
}

impl ProtocolPack for PlaySoundData {
    fn pack(&self, buf: &mut Vec<u8>) {
        self.target.pack(buf);
        buf.write_u32::<LittleEndian>(self.sound_id).unwrap();
        buf.write_f32::<LittleEndian>(self.volume).unwrap();
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlayEffectData {
    pub target: Guid,
    pub script_id: u32,
    pub speed: f32,
}

impl ProtocolUnpack for PlayEffectData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        let target = Guid::unpack(data, offset)?;
        if *offset + 8 > data.len() {
            return None;
        }
        let script_id = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        let speed = LittleEndian::read_f32(&data[*offset + 4..*offset + 8]);
        *offset += 8;
        Some(PlayEffectData {
            target,
            script_id,
            speed,
        })
    }
}

impl ProtocolPack for PlayEffectData {
    fn pack(&self, buf: &mut Vec<u8>) {
        self.target.pack(buf);
        buf.write_u32::<LittleEndian>(self.script_id).unwrap();
        buf.write_f32::<LittleEndian>(self.speed).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messages::game_message::GameMessage;
    use crate::test_fixtures;
    use crate::test_helpers::assert_pack_unpack_parity;
    use crate::traits::ProtocolUnpack;

    #[test]
    fn test_play_sound_fixture() {
        let expected = PlaySoundData {
            target: Guid(0x50000001),
            sound_id: 100,
            volume: 0.8,
        };

        // Opcode (4) + Data (12)
        let data = &test_fixtures::SOUND[4..];
        assert_pack_unpack_parity::<PlaySoundData>(data, &expected);

        // Verify top-level dispatch
        let mut offset = 0;
        let GameMessage::PlaySound(msg) =
            GameMessage::unpack(test_fixtures::SOUND, &mut offset).unwrap()
        else {
            panic!("Expected PlaySound");
        };
        assert_eq!(*msg, expected);
    }

    /// Task F (ambient-sounds-chain 2026-05-12): explicit round-trip
    /// for the `GameMessageSound` wire shape ACE actually sends.
    ///
    /// Wire layout per
    /// `ace-server/Source/ACE.Server/Network/GameMessages/Messages/GameMessageSound.cs`:
    ///   `[u32 opcode = 0xF750][u32 guid][u32 sound_id][f32 volume]`
    /// (16 bytes total — matches the `base(..., messageSize: 16)` arg).
    ///
    /// Fixture values mirror ACE's `Lifestone.cs:58`
    /// (`new GameMessageSound(player.Guid, Sound.LifestoneOn, 1.0f)`)
    /// — Sound enum `0x51` per `ACE.Entity/Enum/Sound.cs:86`. This
    /// is the load-bearing in-Holtburg surface for the Lifestone
    /// (one of three lifestones in Holtburg per the
    /// holtburg-coverage-survey-2026-05-12.md count).
    #[test]
    fn test_play_sound_lifestone_on() {
        let expected = PlaySoundData {
            // Player GUID — ACE's 0x50000001..0x60000000 player range.
            target: Guid(0x50000042),
            // `Sound.LifestoneOn` per ACE Sound.cs.
            sound_id: 0x51,
            // ACE's literal `1.0f` for lifestone bind.
            volume: 1.0,
        };

        // Synthesize the wire bytes the way ACE writes them:
        //   `writer.Write(guid.Full)`        → u32 LE
        //   `writer.Write((uint)soundId)`    → u32 LE
        //   `writer.Write(volume)`           → f32 LE
        let mut bytes = Vec::with_capacity(12);
        bytes.extend_from_slice(&0x50000042u32.to_le_bytes());
        bytes.extend_from_slice(&0x51u32.to_le_bytes());
        bytes.extend_from_slice(&1.0f32.to_le_bytes());

        assert_pack_unpack_parity::<PlaySoundData>(&bytes, &expected);
    }

    /// Task F round-trip with scale<1.0 (combat hit cases — see
    /// ACE `Player_Combat.cs:168`,
    /// `Session.Network.EnqueueSend(new GameMessageSound(target.Guid, Sound.HitFlesh1, 0.5f))`).
    /// Verifies the f32 scale field round-trips cleanly at non-unit
    /// values, since the JS-side handler multiplies it by the per-
    /// SoundEntry volume.
    #[test]
    fn test_play_sound_combat_hit_half_scale() {
        let expected = PlaySoundData {
            target: Guid(0x10001234),
            // `Sound.HitFlesh1 = 0x30` per
            // ACE.Entity/Enum/Sound.cs:53. Distinct enum from
            // Ambient1 0x46 (line 75).
            sound_id: 0x30,
            volume: 0.5,
        };

        let mut bytes = Vec::with_capacity(12);
        bytes.extend_from_slice(&0x10001234u32.to_le_bytes());
        bytes.extend_from_slice(&0x30u32.to_le_bytes());
        bytes.extend_from_slice(&0.5f32.to_le_bytes());

        assert_pack_unpack_parity::<PlaySoundData>(&bytes, &expected);
    }

    /// Task F: synthesize a full 16-byte `GameMessageSound` packet
    /// (opcode + payload) and dispatch through `GameMessage::unpack`
    /// to confirm the recv-loop's `match message { GameMessage::PlaySound(data) => ... }`
    /// arm sees the same bytes ACE writes. The opcode is `0xF750` per
    /// `ACE.Server/Network/GameMessages/GameMessageOpcode.cs:60`.
    #[test]
    fn test_play_sound_full_packet_dispatch() {
        let mut packet = Vec::with_capacity(16);
        // Opcode 0xF750 — `GameMessageOpcode.Sound`.
        packet.extend_from_slice(&0xF750u32.to_le_bytes());
        // Lifestone case again, since it's the most-likely
        // first-observed in-Holtburg occurrence.
        packet.extend_from_slice(&0x50000042u32.to_le_bytes());
        packet.extend_from_slice(&0x51u32.to_le_bytes()); // LifestoneOn
        packet.extend_from_slice(&1.0f32.to_le_bytes());

        let mut offset = 0;
        let msg = GameMessage::unpack(&packet, &mut offset)
            .expect("PlaySound packet must unpack");
        match msg {
            GameMessage::PlaySound(data) => {
                assert_eq!(data.target, Guid(0x50000042));
                assert_eq!(data.sound_id, 0x51);
                assert_eq!(data.volume, 1.0);
            }
            other => panic!("Expected PlaySound dispatch, got {:?}", other),
        }
        assert_eq!(offset, 16, "Full packet must consume all 16 bytes");
    }

    #[test]
    fn test_play_effect_fixture() {
        let expected = PlayEffectData {
            target: Guid(0x50000001),
            script_id: 200,
            speed: 1.5,
        };

        // Opcode (4) + Data (12)
        let data = &test_fixtures::PLAY_EFFECT[4..];
        assert_pack_unpack_parity::<PlayEffectData>(data, &expected);

        // Verify top-level dispatch
        let mut offset = 0;
        let GameMessage::PlayEffect(msg) =
            GameMessage::unpack(test_fixtures::PLAY_EFFECT, &mut offset).unwrap()
        else {
            panic!("Expected PlayEffect");
        };
        assert_eq!(*msg, expected);
    }
}
