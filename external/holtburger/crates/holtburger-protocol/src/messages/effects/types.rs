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

/// AdminEnvirons (0xEA60) payload — a single `EnvironChangeType` enum
/// value. Fog tint (0x00-0x06) or environment sound (0x65-0x7B); the
/// client decides the reaction (fog colors / sound-table lookup), the
/// server only names the change. ACE `GameMessageAdminEnvirons` writes
/// exactly this u32 (no target guid).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EnvironChangeData {
    pub change_type: u32,
}

impl ProtocolUnpack for EnvironChangeData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 4 > data.len() {
            return None;
        }
        let change_type = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        *offset += 4;
        Some(EnvironChangeData { change_type })
    }
}

impl ProtocolPack for EnvironChangeData {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.write_u32::<LittleEndian>(self.change_type).unwrap();
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

    /// CMT Wave 10 / Phase 31 (2026-05-26): explicit round-trip for the
    /// `GameMessageScript` wire shape that drives projectile Launch /
    /// Explode VFX. ACE constructs this packet from
    /// `Source/ACE.Server/WorldObjects/Player_Combat.cs` and
    /// `Source/ACE.Server/WorldObjects/Creature_Missile.cs:131`:
    ///
    ///   `proj.EnqueueBroadcast(new GameMessageScript(
    ///       proj.Guid, PlayScript.Launch, 0f));`
    ///
    /// Wire layout per
    /// `Source/ACE.Server/Network/GameMessages/Messages/GameMessageScript.cs:9`:
    ///   `[u32 opcode = 0xF755][u32 guid][u32 play_script_enum][f32 speed]`
    /// (16 bytes total — matches `base(..., messageSize: 16)`). The
    /// opcode is `GameMessageOpcode.PlayEffect = 0xF755` (note: NOT
    /// `0xF754 / PlayScriptId`, which is a retail-only opcode ACE
    /// declares but never emits — see `opcodes.rs` comment on the
    /// commented-out `PlayScriptId` line and `acclient.c:709942`).
    ///
    /// PlayScript enum values per `Source/ACE.Entity/Enum/PlayScript.cs`:
    ///   `Launch = 0x04`, `Explode = 0x05`, `Fizzle = 0x51`, etc.
    /// JS-side will look up names by ID in Wave 11; the Rust decode
    /// keeps the raw `u32` (no Rust enum mirror needed yet).
    ///
    /// Two fixtures exercised here:
    /// 1. The canonical "missile launch" case (`Launch / speed = 0.0`).
    /// 2. An "explode" case with non-zero speed (`Explode / speed = 1.0`).
    /// Both walk the full `GameMessage::unpack` → `PlayEffect(..)` arm
    /// and round-trip cleanly via `pack`. This is the load-bearing
    /// proof that the recv loop won't crash on PlayEffect (Wave 10's
    /// acceptance gate) and that Wave 11 can rely on the decoded
    /// `script_id` matching ACE's enum values bit-for-bit.
    #[test]
    fn test_play_effect_launch_explode_round_trip() {
        // Missile launch — `Creature_Missile.cs:131` literal arguments.
        // `PlayScript.Launch = 0x04` per ACE.Entity/Enum/PlayScript.cs.
        let launch = PlayEffectData {
            target: Guid(0x50000042),
            script_id: 0x04,
            speed: 0.0,
        };
        let mut bytes = Vec::with_capacity(12);
        bytes.extend_from_slice(&0x50000042u32.to_le_bytes());
        bytes.extend_from_slice(&0x04u32.to_le_bytes());
        bytes.extend_from_slice(&0.0f32.to_le_bytes());
        assert_pack_unpack_parity::<PlayEffectData>(&bytes, &launch);

        // Explode on impact with non-default scale.
        // `PlayScript.Explode = 0x05` per ACE.Entity/Enum/PlayScript.cs.
        let explode = PlayEffectData {
            target: Guid(0x50001234),
            script_id: 0x05,
            speed: 1.0,
        };
        let mut bytes = Vec::with_capacity(12);
        bytes.extend_from_slice(&0x50001234u32.to_le_bytes());
        bytes.extend_from_slice(&0x05u32.to_le_bytes());
        bytes.extend_from_slice(&1.0f32.to_le_bytes());
        assert_pack_unpack_parity::<PlayEffectData>(&bytes, &explode);

        // Full-packet (opcode + payload) dispatch — confirms the
        // recv loop's `GameMessage::PlayEffect(data) => ...` arm sees
        // the same bytes ACE writes.
        let mut packet = Vec::with_capacity(16);
        packet.extend_from_slice(&0xF755u32.to_le_bytes()); // PlayEffect opcode
        packet.extend_from_slice(&0x50000042u32.to_le_bytes());
        packet.extend_from_slice(&0x04u32.to_le_bytes()); // PlayScript.Launch
        packet.extend_from_slice(&0.0f32.to_le_bytes());

        let mut offset = 0;
        let msg = GameMessage::unpack(&packet, &mut offset)
            .expect("PlayEffect packet must unpack");
        match msg {
            GameMessage::PlayEffect(data) => {
                assert_eq!(data.target, Guid(0x50000042));
                assert_eq!(data.script_id, 0x04);
                assert_eq!(data.speed, 0.0);
            }
            other => panic!("Expected PlayEffect dispatch, got {:?}", other),
        }
        assert_eq!(offset, 16, "Full packet must consume all 16 bytes");
    }
}
