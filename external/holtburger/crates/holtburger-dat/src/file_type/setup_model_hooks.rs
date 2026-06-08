//! Typed per-hook metadata for `AnimationHook` (enhancement E10).
//!
//! [`AnimationHook`] keeps the wire form of an animation hook —
//! `hook_type` / `direction` / opaque `data` bytes — which round-trips
//! byte-equal but discards the *meaning* of each hook's fields. This module
//! ports melt's per-hook subclasses (`ACE.DatLoader/Entity/AnimationHooks/*.cs`,
//! 24 subclasses) into a single Rust enum, [`AnimationHookData`], with one
//! variant per `AnimationHookType` and the variant's distinct named fields
//! preserved (NO flattening to a generic blob — every DataID / identity field
//! is kept as an explicit record).
//!
//! The enum is a *decode* of the existing wire payload, not a replacement for
//! it: [`AnimationHook::decode`](crate::file_type::setup_model::AnimationHook::decode)
//! parses `data` into a variant, and [`AnimationHookData::encode_payload`]
//! re-serializes the variant back to the exact payload bytes (minus the
//! trailing 0..3 alignment pad, which the wire layer owns). This keeps the
//! byte-equal round-trip guarantee of `AnimationHook::read`/`write` intact
//! while exposing typed access.
//!
//! Byte layout, field order, and endianness match melt's `Unpack` methods
//! exactly:
//!
//! | type | melt subclass             | payload fields                                   |
//! |-----:|---------------------------|--------------------------------------------------|
//! |   0  | (base) NoOp               | —                                                |
//! |   1  | `SoundHook`               | `u32 id`                                         |
//! |   2  | `SoundTableHook`          | `u32 sound_type`                                 |
//! |   3  | `AttackHook`              | `AttackCone`                                     |
//! |   4  | (base) AnimationDone      | —                                                |
//! |   5  | `ReplaceObjectHook`       | `AnimPartChange { u8 part_index, u32 part_id }`  |
//! |   6  | `EtherealHook`            | `i32 ethereal`                                  |
//! |   7  | `TransparentPartHook`     | `u32 part, f32 start/end/time`                  |
//! |   8  | `LuminousHook`            | `f32 start/end/time`                            |
//! |   9  | `LuminousPartHook`        | `u32 part, f32 start/end/time`                  |
//! |  10  | `DiffuseHook`             | `f32 start/end/time`                            |
//! |  11  | `DiffusePartHook`         | `u32 part, f32 start/end/time`                  |
//! |  12  | `ScaleHook`               | `f32 end, f32 time`                             |
//! |  13  | `CreateParticleHook`      | `CreateParticleHookPayload`                      |
//! |  14  | `DestroyParticleHook`     | `u32 emitter_id`                                |
//! |  15  | `StopParticleHook`        | `u32 emitter_id`                                |
//! |  16  | `NoDrawHook`              | `u32 no_draw`                                   |
//! |  17  | (base) DefaultScript      | —                                                |
//! |  18  | `DefaultScriptPartHook`   | `u32 part_index`                                |
//! |  19  | `CallPESHook`             | `u32 pes, f32 pause`                            |
//! |  20  | `TransparentHook`         | `f32 start/end/time`                            |
//! |  21  | `SoundTweakedHook`        | `u32 sound_id, f32 priority/probability/volume` |
//! |  22  | `SetOmegaHook`            | `Vector3 axis`                                  |
//! |  23  | `TextureVelocityHook`     | `f32 u_speed, f32 v_speed`                      |
//! |  24  | `TextureVelocityPartHook` | `u32 part_index, f32 u_speed/v_speed`           |
//! |  25  | `SetLightHook`            | `i32 lights_on`                                 |
//! |  26  | `CreateBlockingParticle`  | `CreateParticleHookPayload`                      |

use super::setup_model::{AnimationHook, CreateParticleHookPayload};
use binrw::{
    BinRead, BinResult, BinWrite,
    io::{Cursor, Read, Seek, Write},
};
use holtburger_common::Vector3;

/// `AttackCone` — payload of an `AttackHook` (type 3).
///
/// Mirrors melt `AnimationHooks/AttackHook.cs` → `Entity/AttackCone.cs`:
/// `u32 part_index` then six `f32`s (`left_x`, `left_y`, `right_x`, `right_y`,
/// `radius`, `height`). The `left`/`right` pairs are `Vec2D`s in retail.
/// Total payload: 28 bytes.
#[derive(Debug, Clone, PartialEq, BinRead, BinWrite, serde::Serialize)]
#[br(little)]
#[bw(little)]
pub struct AttackCone {
    pub part_index: u32,
    pub left_x: f32,
    pub left_y: f32,
    pub right_x: f32,
    pub right_y: f32,
    pub radius: f32,
    pub height: f32,
}

/// `AnimPartChange` — payload of a `ReplaceObjectHook` (type 5).
///
/// Mirrors melt `Entity/AnimationPartChange.cs`: a `part_index` followed by a
/// packed DataID of known type `0x01000000` (a GfxObj part-id). Retail packs
/// `part_index` as a single byte (`acclient.c:471699`,
/// `AnimPartChange::UnPack`) — the existing wire layer reads exactly that, so
/// we keep the `u8`. The `part_id` is the fully-resolved DataID (the wire form
/// is a 2- or 4-byte compressed id; we store the decoded `u32` so the identity
/// is preserved rather than the compressed bytes).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct AnimPartChange {
    /// Index into the parent `SetupModel.parts` table.
    pub part_index: u8,
    /// Decoded GfxObj DataID (`0x01000000`-based). `0x01000000` here means
    /// "the wire id was 0", which is still an explicit, preserved identity.
    pub part_id: u32,
}

impl AnimPartChange {
    /// Decode from the wire payload bytes of a ReplaceObject hook:
    /// `[u8 part_index][u16 hi (| u16 lo if hi & 0x8000)]`. Mirrors
    /// `ReadAsDataIDOfKnownType(0x01000000)` (melt `BinaryReaderExtensions.cs`).
    fn read<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let part_index = u8::read_le(reader)?;
        let part_id = read_packed_known_id(reader, 0x0100_0000)?;
        Ok(Self {
            part_index,
            part_id,
        })
    }

    /// Re-encode to the wire payload bytes. The compressed-id form is chosen
    /// to match the value range exactly as retail's packer does (high bit set
    /// only when the offset exceeds 0x7FFF), so a decode→encode round-trip of
    /// a real hook reproduces the original bytes.
    fn write<W: Write + Seek>(&self, writer: &mut W) -> BinResult<()> {
        self.part_index.write_le(writer)?;
        write_packed_known_id(writer, 0x0100_0000, self.part_id)?;
        Ok(())
    }
}

/// `ReadAsDataIDOfKnownType` (melt `BinaryReaderExtensions.cs:45`):
/// read `u16 hi`; if `hi & 0x8000`, read `u16 lo` and the value is
/// `known + (((hi & 0x3FFF) << 16) | lo)`, else `known + hi`.
fn read_packed_known_id<R: Read + Seek>(reader: &mut R, known: u32) -> BinResult<u32> {
    let hi = u16::read_le(reader)?;
    if (hi & 0x8000) != 0 {
        let lo = u16::read_le(reader)?;
        let higher = ((hi as u32) & 0x3FFF) << 16;
        Ok(known.wrapping_add(higher | (lo as u32)))
    } else {
        Ok(known.wrapping_add(hi as u32))
    }
}

/// Inverse of [`read_packed_known_id`]. Offsets that fit in 15 bits use the
/// compact 2-byte form; larger ones set the 0x8000 flag and use 4 bytes.
fn write_packed_known_id<W: Write + Seek>(writer: &mut W, known: u32, id: u32) -> BinResult<()> {
    let offset = id.wrapping_sub(known);
    if offset <= 0x7FFF {
        (offset as u16).write_le(writer)?;
    } else {
        let hi = 0x8000u16 | (((offset >> 16) & 0x3FFF) as u16);
        let lo = (offset & 0xFFFF) as u16;
        hi.write_le(writer)?;
        lo.write_le(writer)?;
    }
    Ok(())
}

/// Three `f32`s shared by the colour-ramp hooks (`Luminous`, `Diffuse`,
/// `Transparent`): a `start` value, an `end` value, and a `time` to ramp over.
#[derive(Debug, Clone, Copy, PartialEq, BinRead, BinWrite, serde::Serialize)]
#[br(little)]
#[bw(little)]
pub struct Ramp {
    pub start: f32,
    pub end: f32,
    pub time: f32,
}

/// A [`Ramp`] scoped to a single model part (`LuminousPart`, `DiffusePart`,
/// `TransparentPart`). `part` indexes into `SetupModel.parts`.
#[derive(Debug, Clone, Copy, PartialEq, BinRead, BinWrite, serde::Serialize)]
#[br(little)]
#[bw(little)]
pub struct PartRamp {
    pub part: u32,
    pub start: f32,
    pub end: f32,
    pub time: f32,
}

/// `TextureVelocity` payload: U/V scroll speeds.
#[derive(Debug, Clone, Copy, PartialEq, BinRead, BinWrite, serde::Serialize)]
#[br(little)]
#[bw(little)]
pub struct TextureVelocity {
    pub u_speed: f32,
    pub v_speed: f32,
}

/// `TextureVelocityPart` payload: U/V scroll speeds scoped to one part.
#[derive(Debug, Clone, Copy, PartialEq, BinRead, BinWrite, serde::Serialize)]
#[br(little)]
#[bw(little)]
pub struct TextureVelocityPart {
    pub part_index: u32,
    pub u_speed: f32,
    pub v_speed: f32,
}

/// `CallPES` payload: a ParticleEmitterSystem id and a pause duration.
#[derive(Debug, Clone, Copy, PartialEq, BinRead, BinWrite, serde::Serialize)]
#[br(little)]
#[bw(little)]
pub struct CallPes {
    pub pes: u32,
    pub pause: f32,
}

/// `Scale` payload: target scale and the time to reach it.
#[derive(Debug, Clone, Copy, PartialEq, BinRead, BinWrite, serde::Serialize)]
#[br(little)]
#[bw(little)]
pub struct Scale {
    pub end: f32,
    pub time: f32,
}

/// `SoundTweaked` payload.
///
/// Field order matches **retail** `SoundTweakedHook::UnPack`
/// (`acclient.c:343123` — `prob, prio, vol` on disk after the id), which the
/// existing wire layer cites; melt's `SoundTweakedHook.cs` mislabels the
/// first two floats as `Priority, Probability`. We name them in retail
/// (on-disk) order so a consumer reading `probability` gets the float the
/// `PlayProbability` gate actually fires on. See the long note in
/// `setup_model.rs` for the citation trail.
#[derive(Debug, Clone, Copy, PartialEq, BinRead, BinWrite, serde::Serialize)]
#[br(little)]
#[bw(little)]
pub struct SoundTweaked {
    pub sound_id: u32,
    /// On-disk float at offset 4 (`acclient.c:343129`).
    pub probability: f32,
    /// On-disk float at offset 8 (`acclient.c:343134`).
    pub priority: f32,
    /// On-disk float at offset 12 (`acclient.c:343138`).
    pub volume: f32,
}

/// Typed per-hook metadata — one variant per `AnimationHookType` (0..=26).
///
/// Decoded from [`AnimationHook`]'s opaque `data` via
/// [`AnimationHook::decode`]; re-encoded via [`Self::encode_payload`]. Every
/// variant carries the hook's distinct fields explicitly; DataID / identity
/// fields (`emitter_info_id`, `part_id`, `id`, `pes`, …) are preserved as
/// named records, never flattened.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub enum AnimationHookData {
    /// type 0 — no payload.
    NoOp,
    /// type 1 — `SoundHook { id }`.
    Sound { id: u32 },
    /// type 2 — `SoundTableHook { sound_type }`.
    SoundTable { sound_type: u32 },
    /// type 3 — `AttackHook { cone }`.
    Attack { cone: AttackCone },
    /// type 4 — no payload.
    AnimationDone,
    /// type 5 — `ReplaceObjectHook { ap_change }`.
    ReplaceObject { ap_change: AnimPartChange },
    /// type 6 — `EtherealHook { ethereal }`.
    Ethereal { ethereal: i32 },
    /// type 7 — `TransparentPartHook`.
    TransparentPart { ramp: PartRamp },
    /// type 8 — `LuminousHook`.
    Luminous { ramp: Ramp },
    /// type 9 — `LuminousPartHook`.
    LuminousPart { ramp: PartRamp },
    /// type 10 — `DiffuseHook`.
    Diffuse { ramp: Ramp },
    /// type 11 — `DiffusePartHook`.
    DiffusePart { ramp: PartRamp },
    /// type 12 — `ScaleHook`.
    Scale { scale: Scale },
    /// type 13 — `CreateParticleHook`.
    CreateParticle { particle: CreateParticleHookPayload },
    /// type 14 — `DestroyParticleHook { emitter_id }`.
    DestroyParticle { emitter_id: u32 },
    /// type 15 — `StopParticleHook { emitter_id }`.
    StopParticle { emitter_id: u32 },
    /// type 16 — `NoDrawHook { no_draw }`.
    NoDraw { no_draw: u32 },
    /// type 17 — no payload.
    DefaultScript,
    /// type 18 — `DefaultScriptPartHook { part_index }`.
    DefaultScriptPart { part_index: u32 },
    /// type 19 — `CallPESHook`.
    CallPes { call: CallPes },
    /// type 20 — `TransparentHook`.
    Transparent { ramp: Ramp },
    /// type 21 — `SoundTweakedHook`.
    SoundTweaked { sound: SoundTweaked },
    /// type 22 — `SetOmegaHook { axis }`.
    SetOmega { axis: Vector3 },
    /// type 23 — `TextureVelocityHook`.
    TextureVelocity { velocity: TextureVelocity },
    /// type 24 — `TextureVelocityPartHook`.
    TextureVelocityPart { velocity: TextureVelocityPart },
    /// type 25 — `SetLightHook { lights_on }`.
    SetLight { lights_on: i32 },
    /// type 26 — `CreateBlockingParticle` (same payload as CreateParticle).
    CreateBlockingParticle { particle: CreateParticleHookPayload },
}

impl AnimationHookData {
    /// The `AnimationHookType` discriminator this variant serializes as.
    pub fn hook_type(&self) -> u32 {
        match self {
            Self::NoOp => 0,
            Self::Sound { .. } => 1,
            Self::SoundTable { .. } => 2,
            Self::Attack { .. } => 3,
            Self::AnimationDone => 4,
            Self::ReplaceObject { .. } => 5,
            Self::Ethereal { .. } => 6,
            Self::TransparentPart { .. } => 7,
            Self::Luminous { .. } => 8,
            Self::LuminousPart { .. } => 9,
            Self::Diffuse { .. } => 10,
            Self::DiffusePart { .. } => 11,
            Self::Scale { .. } => 12,
            Self::CreateParticle { .. } => 13,
            Self::DestroyParticle { .. } => 14,
            Self::StopParticle { .. } => 15,
            Self::NoDraw { .. } => 16,
            Self::DefaultScript => 17,
            Self::DefaultScriptPart { .. } => 18,
            Self::CallPes { .. } => 19,
            Self::Transparent { .. } => 20,
            Self::SoundTweaked { .. } => 21,
            Self::SetOmega { .. } => 22,
            Self::TextureVelocity { .. } => 23,
            Self::TextureVelocityPart { .. } => 24,
            Self::SetLight { .. } => 25,
            Self::CreateBlockingParticle { .. } => 26,
        }
    }

    /// Decode a hook payload (the bytes *after* `hook_type`/`direction`, with
    /// the trailing alignment pad already stripped) into a typed variant.
    ///
    /// `hook_type` selects the variant; `payload` is read in melt byte order.
    /// Returns `Err` for an unknown discriminator.
    pub fn decode(hook_type: u32, payload: &[u8]) -> BinResult<Self> {
        let mut c = Cursor::new(payload);
        let value = match hook_type {
            0 => Self::NoOp,
            1 => Self::Sound {
                id: u32::read_le(&mut c)?,
            },
            2 => Self::SoundTable {
                sound_type: u32::read_le(&mut c)?,
            },
            3 => Self::Attack {
                cone: AttackCone::read_le(&mut c)?,
            },
            4 => Self::AnimationDone,
            5 => Self::ReplaceObject {
                ap_change: AnimPartChange::read(&mut c)?,
            },
            6 => Self::Ethereal {
                ethereal: i32::read_le(&mut c)?,
            },
            7 => Self::TransparentPart {
                ramp: PartRamp::read_le(&mut c)?,
            },
            8 => Self::Luminous {
                ramp: Ramp::read_le(&mut c)?,
            },
            9 => Self::LuminousPart {
                ramp: PartRamp::read_le(&mut c)?,
            },
            10 => Self::Diffuse {
                ramp: Ramp::read_le(&mut c)?,
            },
            11 => Self::DiffusePart {
                ramp: PartRamp::read_le(&mut c)?,
            },
            12 => Self::Scale {
                scale: Scale::read_le(&mut c)?,
            },
            13 => Self::CreateParticle {
                particle: CreateParticleHookPayload::read_le(&mut c)?,
            },
            14 => Self::DestroyParticle {
                emitter_id: u32::read_le(&mut c)?,
            },
            15 => Self::StopParticle {
                emitter_id: u32::read_le(&mut c)?,
            },
            16 => Self::NoDraw {
                no_draw: u32::read_le(&mut c)?,
            },
            17 => Self::DefaultScript,
            18 => Self::DefaultScriptPart {
                part_index: u32::read_le(&mut c)?,
            },
            19 => Self::CallPes {
                call: CallPes::read_le(&mut c)?,
            },
            20 => Self::Transparent {
                ramp: Ramp::read_le(&mut c)?,
            },
            21 => Self::SoundTweaked {
                sound: SoundTweaked::read_le(&mut c)?,
            },
            22 => Self::SetOmega {
                axis: Vector3::read_le(&mut c)?,
            },
            23 => Self::TextureVelocity {
                velocity: TextureVelocity::read_le(&mut c)?,
            },
            24 => Self::TextureVelocityPart {
                velocity: TextureVelocityPart::read_le(&mut c)?,
            },
            25 => Self::SetLight {
                lights_on: i32::read_le(&mut c)?,
            },
            26 => Self::CreateBlockingParticle {
                particle: CreateParticleHookPayload::read_le(&mut c)?,
            },
            other => {
                return Err(binrw::Error::Custom {
                    pos: 0,
                    err: Box::new(format!("Unsupported AnimationHook type: 0x{other:08X}")),
                });
            }
        };
        Ok(value)
    }

    /// Re-encode this variant's payload (the bytes *after*
    /// `hook_type`/`direction`, WITHOUT the trailing alignment pad — the wire
    /// layer owns the pad). Mirrors melt's `Pack` field order.
    pub fn encode_payload(&self) -> BinResult<Vec<u8>> {
        let mut out = Vec::new();
        let mut c = Cursor::new(&mut out);
        match self {
            Self::NoOp | Self::AnimationDone | Self::DefaultScript => {}
            Self::Sound { id } => id.write_le(&mut c)?,
            Self::SoundTable { sound_type } => sound_type.write_le(&mut c)?,
            Self::Attack { cone } => cone.write_le(&mut c)?,
            Self::ReplaceObject { ap_change } => ap_change.write(&mut c)?,
            Self::Ethereal { ethereal } => ethereal.write_le(&mut c)?,
            Self::TransparentPart { ramp } | Self::LuminousPart { ramp } | Self::DiffusePart { ramp } => {
                ramp.write_le(&mut c)?
            }
            Self::Luminous { ramp } | Self::Diffuse { ramp } | Self::Transparent { ramp } => {
                ramp.write_le(&mut c)?
            }
            Self::Scale { scale } => scale.write_le(&mut c)?,
            Self::CreateParticle { particle } | Self::CreateBlockingParticle { particle } => {
                particle.write_le(&mut c)?
            }
            Self::DestroyParticle { emitter_id } | Self::StopParticle { emitter_id } => {
                emitter_id.write_le(&mut c)?
            }
            Self::NoDraw { no_draw } => no_draw.write_le(&mut c)?,
            Self::DefaultScriptPart { part_index } => part_index.write_le(&mut c)?,
            Self::CallPes { call } => call.write_le(&mut c)?,
            Self::SoundTweaked { sound } => sound.write_le(&mut c)?,
            Self::SetOmega { axis } => axis.write_le(&mut c)?,
            Self::TextureVelocity { velocity } => velocity.write_le(&mut c)?,
            Self::TextureVelocityPart { velocity } => velocity.write_le(&mut c)?,
            Self::SetLight { lights_on } => lights_on.write_le(&mut c)?,
        }
        Ok(out)
    }

    /// Build a wire [`AnimationHook`] from this typed variant plus a direction.
    /// The wire `data` is the encoded payload padded to a 4-byte boundary,
    /// matching retail `PackObj::ALIGN_PTR` (only ReplaceObject ever pads).
    pub fn to_hook(&self, direction: i32) -> BinResult<AnimationHook> {
        let mut data = self.encode_payload()?;
        let pad_len = (4 - (data.len() % 4)) % 4;
        data.extend(std::iter::repeat_n(0u8, pad_len));
        Ok(AnimationHook {
            hook_type: self.hook_type(),
            direction,
            data,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_common::Quaternion;

    /// Decode a typed variant straight from a wire `AnimationHook` (parsed by
    /// `AnimationHook::read`), then re-encode and assert the payload bytes
    /// match the wire `data` minus its alignment pad. This is the round-trip
    /// guarantee for one hook category.
    fn assert_category_round_trip(hook_type: u32, direction: i32, payload: &[u8]) -> AnimationHookData {
        // Build the on-wire bytes: [hook_type][direction][payload][pad].
        let mut wire = Vec::new();
        wire.extend_from_slice(&hook_type.to_le_bytes());
        wire.extend_from_slice(&direction.to_le_bytes());
        wire.extend_from_slice(payload);
        let pad_len = (4 - (payload.len() % 4)) % 4;
        wire.extend(std::iter::repeat_n(0u8, pad_len));

        let hook = AnimationHook::read(&mut Cursor::new(&wire[..]))
            .expect("wire hook should parse");
        assert_eq!(hook.hook_type, hook_type);
        assert_eq!(hook.direction, direction);

        let decoded = hook.decode().expect("decode typed variant");
        assert_eq!(decoded.hook_type(), hook_type, "discriminator preserved");

        // encode_payload reproduces the payload (no pad).
        let re = decoded.encode_payload().expect("re-encode payload");
        assert_eq!(re, payload, "payload bytes round-trip");

        // to_hook reproduces the full wire hook (with pad), byte-equal.
        let rebuilt = decoded.to_hook(direction).expect("rebuild wire hook");
        let mut out = Vec::new();
        rebuilt.write(&mut Cursor::new(&mut out)).expect("write");
        assert_eq!(out, wire, "full wire hook round-trips byte-equal");

        decoded
    }

    #[test]
    fn empty_hooks_noop_animdone_defaultscript() {
        assert_eq!(assert_category_round_trip(0, 0, &[]), AnimationHookData::NoOp);
        assert_eq!(
            assert_category_round_trip(4, 0, &[]),
            AnimationHookData::AnimationDone
        );
        assert_eq!(
            assert_category_round_trip(17, 0, &[]),
            AnimationHookData::DefaultScript
        );
    }

    #[test]
    fn sound_hooks_preserve_ids() {
        // type 1 Sound { id }
        let mut p = Vec::new();
        p.extend_from_slice(&0x0900_1234u32.to_le_bytes());
        assert_eq!(
            assert_category_round_trip(1, 1, &p),
            AnimationHookData::Sound { id: 0x0900_1234 }
        );

        // type 2 SoundTable { sound_type }
        let mut p = Vec::new();
        p.extend_from_slice(&7u32.to_le_bytes());
        assert_eq!(
            assert_category_round_trip(2, -1, &p),
            AnimationHookData::SoundTable { sound_type: 7 }
        );
    }

    #[test]
    fn sound_tweaked_uses_retail_field_order() {
        // [id, probability@4, priority@8, volume@12] on disk.
        let mut p = Vec::new();
        p.extend_from_slice(&0x0900_ABCDu32.to_le_bytes());
        p.extend_from_slice(&0.25f32.to_le_bytes()); // probability
        p.extend_from_slice(&2.0f32.to_le_bytes()); // priority
        p.extend_from_slice(&0.8f32.to_le_bytes()); // volume
        let decoded = assert_category_round_trip(21, 0, &p);
        match decoded {
            AnimationHookData::SoundTweaked { sound } => {
                assert_eq!(sound.sound_id, 0x0900_ABCD);
                assert_eq!(sound.probability, 0.25);
                assert_eq!(sound.priority, 2.0);
                assert_eq!(sound.volume, 0.8);
            }
            other => panic!("expected SoundTweaked, got {other:?}"),
        }
    }

    #[test]
    fn attack_hook_preserves_cone() {
        let mut p = Vec::new();
        p.extend_from_slice(&3u32.to_le_bytes()); // part_index
        for v in [0.1f32, 0.2, 0.3, 0.4, 1.5, 2.5] {
            p.extend_from_slice(&v.to_le_bytes());
        }
        let decoded = assert_category_round_trip(3, 0, &p);
        match decoded {
            AnimationHookData::Attack { cone } => {
                assert_eq!(cone.part_index, 3);
                assert_eq!(cone.left_x, 0.1);
                assert_eq!(cone.left_y, 0.2);
                assert_eq!(cone.right_x, 0.3);
                assert_eq!(cone.right_y, 0.4);
                assert_eq!(cone.radius, 1.5);
                assert_eq!(cone.height, 2.5);
            }
            other => panic!("expected Attack, got {other:?}"),
        }
    }

    #[test]
    fn replace_object_preserves_dataid_compact_and_extended() {
        // Compact id: part_index=7, packed hi=0x1234 (no high bit).
        // Decoded part_id = 0x01000000 + 0x1234.
        let mut p = Vec::new();
        p.push(7u8);
        p.extend_from_slice(&0x1234u16.to_le_bytes());
        let decoded = assert_category_round_trip(5, 0, &p);
        match decoded {
            AnimationHookData::ReplaceObject { ap_change } => {
                assert_eq!(ap_change.part_index, 7);
                assert_eq!(ap_change.part_id, 0x0100_0000 + 0x1234);
            }
            other => panic!("expected ReplaceObject, got {other:?}"),
        }

        // Extended id: hi=0x8001 (high bit set) → offset = (0x0001 << 16) | lo.
        let mut p = Vec::new();
        p.push(9u8);
        p.extend_from_slice(&0x8001u16.to_le_bytes());
        p.extend_from_slice(&0x2345u16.to_le_bytes());
        let decoded = assert_category_round_trip(5, 1, &p);
        match decoded {
            AnimationHookData::ReplaceObject { ap_change } => {
                assert_eq!(ap_change.part_index, 9);
                assert_eq!(ap_change.part_id, 0x0100_0000 + ((0x0001 << 16) | 0x2345));
            }
            other => panic!("expected ReplaceObject, got {other:?}"),
        }
    }

    #[test]
    fn scalar_int_hooks_round_trip() {
        // Ethereal (i32, signed)
        let mut p = Vec::new();
        p.extend_from_slice(&(-1i32).to_le_bytes());
        assert_eq!(
            assert_category_round_trip(6, 0, &p),
            AnimationHookData::Ethereal { ethereal: -1 }
        );
        // SetLight (i32)
        let mut p = Vec::new();
        p.extend_from_slice(&1i32.to_le_bytes());
        assert_eq!(
            assert_category_round_trip(25, 0, &p),
            AnimationHookData::SetLight { lights_on: 1 }
        );
        // NoDraw (u32)
        let mut p = Vec::new();
        p.extend_from_slice(&1u32.to_le_bytes());
        assert_eq!(
            assert_category_round_trip(16, 0, &p),
            AnimationHookData::NoDraw { no_draw: 1 }
        );
        // DefaultScriptPart (u32)
        let mut p = Vec::new();
        p.extend_from_slice(&4u32.to_le_bytes());
        assert_eq!(
            assert_category_round_trip(18, 0, &p),
            AnimationHookData::DefaultScriptPart { part_index: 4 }
        );
    }

    #[test]
    fn particle_emitter_id_hooks_round_trip() {
        // DestroyParticle (type 14) and StopParticle (type 15) — emitter_id u32.
        let mut p = Vec::new();
        p.extend_from_slice(&0xDEAD_BEEFu32.to_le_bytes());
        assert_eq!(
            assert_category_round_trip(14, 0, &p),
            AnimationHookData::DestroyParticle {
                emitter_id: 0xDEAD_BEEF
            }
        );
        let mut p = Vec::new();
        p.extend_from_slice(&0x0000_0042u32.to_le_bytes());
        assert_eq!(
            assert_category_round_trip(15, 0, &p),
            AnimationHookData::StopParticle { emitter_id: 0x42 }
        );
    }

    #[test]
    fn create_particle_hooks_preserve_dataid() {
        // 40-byte payload: emitter_info_id, part_index, Frame, emitter_id.
        let mut p = Vec::new();
        p.extend_from_slice(&0x3200_0001u32.to_le_bytes()); // emitter_info_id (ParticleEmitter DID)
        p.extend_from_slice(&5u32.to_le_bytes()); // part_index
        // Frame: origin(3 f32) + quaternion(4 f32)
        for v in [1.0f32, 2.0, 3.0, 1.0, 0.0, 0.0, 0.0] {
            p.extend_from_slice(&v.to_le_bytes());
        }
        p.extend_from_slice(&0x99u32.to_le_bytes()); // emitter_id
        assert_eq!(p.len(), 40);

        let decoded = assert_category_round_trip(13, 0, &p);
        match &decoded {
            AnimationHookData::CreateParticle { particle } => {
                assert_eq!(particle.emitter_info_id, 0x3200_0001);
                assert_eq!(particle.part_index, 5);
                assert_eq!(particle.emitter_id, 0x99);
                assert_eq!(particle.offset.origin, Vector3::new(1.0, 2.0, 3.0));
                assert_eq!(
                    particle.offset.orientation,
                    Quaternion {
                        w: 1.0,
                        x: 0.0,
                        y: 0.0,
                        z: 0.0
                    }
                );
            }
            other => panic!("expected CreateParticle, got {other:?}"),
        }

        // type 26 CreateBlockingParticle uses the identical payload.
        let decoded = assert_category_round_trip(26, 0, &p);
        match decoded {
            AnimationHookData::CreateBlockingParticle { particle } => {
                assert_eq!(particle.emitter_info_id, 0x3200_0001);
                assert_eq!(particle.emitter_id, 0x99);
            }
            other => panic!("expected CreateBlockingParticle, got {other:?}"),
        }
    }

    #[test]
    fn ramp_hooks_round_trip() {
        // Luminous (8), Diffuse (10), Transparent (20): 3 f32 (no part).
        let mut p = Vec::new();
        for v in [0.0f32, 1.0, 0.5] {
            p.extend_from_slice(&v.to_le_bytes());
        }
        for ty in [8u32, 10, 20] {
            let decoded = assert_category_round_trip(ty, 0, &p);
            let ramp = match decoded {
                AnimationHookData::Luminous { ramp }
                | AnimationHookData::Diffuse { ramp }
                | AnimationHookData::Transparent { ramp } => ramp,
                other => panic!("expected ramp hook for type {ty}, got {other:?}"),
            };
            assert_eq!(ramp, Ramp { start: 0.0, end: 1.0, time: 0.5 });
        }
    }

    #[test]
    fn part_ramp_hooks_round_trip() {
        // TransparentPart (7), LuminousPart (9), DiffusePart (11): part + 3 f32.
        let mut p = Vec::new();
        p.extend_from_slice(&2u32.to_le_bytes());
        for v in [0.0f32, 1.0, 0.25] {
            p.extend_from_slice(&v.to_le_bytes());
        }
        for ty in [7u32, 9, 11] {
            let decoded = assert_category_round_trip(ty, 0, &p);
            let ramp = match decoded {
                AnimationHookData::TransparentPart { ramp }
                | AnimationHookData::LuminousPart { ramp }
                | AnimationHookData::DiffusePart { ramp } => ramp,
                other => panic!("expected part-ramp hook for type {ty}, got {other:?}"),
            };
            assert_eq!(
                ramp,
                PartRamp {
                    part: 2,
                    start: 0.0,
                    end: 1.0,
                    time: 0.25
                }
            );
        }
    }

    #[test]
    fn scale_and_callpes_round_trip() {
        // Scale (12): end, time.
        let mut p = Vec::new();
        p.extend_from_slice(&2.0f32.to_le_bytes());
        p.extend_from_slice(&0.5f32.to_le_bytes());
        assert_eq!(
            assert_category_round_trip(12, 0, &p),
            AnimationHookData::Scale {
                scale: Scale { end: 2.0, time: 0.5 }
            }
        );

        // CallPES (19): pes id + pause.
        let mut p = Vec::new();
        p.extend_from_slice(&0x3400_0007u32.to_le_bytes());
        p.extend_from_slice(&1.5f32.to_le_bytes());
        assert_eq!(
            assert_category_round_trip(19, 0, &p),
            AnimationHookData::CallPes {
                call: CallPes {
                    pes: 0x3400_0007,
                    pause: 1.5
                }
            }
        );
    }

    #[test]
    fn omega_and_texture_velocity_round_trip() {
        // SetOmega (22): Vector3 axis.
        let mut p = Vec::new();
        for v in [0.0f32, 0.0, 1.0] {
            p.extend_from_slice(&v.to_le_bytes());
        }
        assert_eq!(
            assert_category_round_trip(22, 0, &p),
            AnimationHookData::SetOmega {
                axis: Vector3::new(0.0, 0.0, 1.0)
            }
        );

        // TextureVelocity (23): u_speed, v_speed.
        let mut p = Vec::new();
        p.extend_from_slice(&0.1f32.to_le_bytes());
        p.extend_from_slice(&0.2f32.to_le_bytes());
        assert_eq!(
            assert_category_round_trip(23, 0, &p),
            AnimationHookData::TextureVelocity {
                velocity: TextureVelocity {
                    u_speed: 0.1,
                    v_speed: 0.2
                }
            }
        );

        // TextureVelocityPart (24): part_index, u_speed, v_speed.
        let mut p = Vec::new();
        p.extend_from_slice(&3u32.to_le_bytes());
        p.extend_from_slice(&0.3f32.to_le_bytes());
        p.extend_from_slice(&0.4f32.to_le_bytes());
        assert_eq!(
            assert_category_round_trip(24, 0, &p),
            AnimationHookData::TextureVelocityPart {
                velocity: TextureVelocityPart {
                    part_index: 3,
                    u_speed: 0.3,
                    v_speed: 0.4
                }
            }
        );
    }

    #[test]
    fn decode_rejects_unknown_hook_type() {
        let err = AnimationHookData::decode(0x9999, &[]);
        assert!(err.is_err(), "unknown hook type should error");
    }
}
