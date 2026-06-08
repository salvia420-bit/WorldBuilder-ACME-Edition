use crate::file_type::setup_model::AnimationFrame;
use crate::graphics::Frame;
use binrw::{
    BinRead, BinResult, BinWrite,
    io::{Read, Seek, Write},
};

bitflags::bitflags! {
    #[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
    pub struct AnimationFlags: u32 {
        const POS_FRAMES = 0x1;
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Animation {
    pub id: u32,
    pub flags: AnimationFlags,
    pub num_parts: u32,
    pub num_frames: u32,
    pub pos_frames: Vec<Frame>,
    pub part_frames: Vec<AnimationFrame>,
}

impl Animation {
    pub fn read<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let id = u32::read_le(reader)?;
        // Retain unknown bits (matches gfx_obj.rs) so the flags word survives a
        // round-trip byte-for-byte: ACE stores the full `uint Flags` verbatim
        // and re-packs it. `from_bits_truncate` would silently drop every bit
        // beyond POS_FRAMES (0x1), breaking `unpack(pack(x)) == x` for any
        // retail record whose flags carry extra bits.
        let flags = AnimationFlags::from_bits_retain(u32::read_le(reader)?);
        let num_parts = u32::read_le(reader)?;
        let num_frames = u32::read_le(reader)?;

        let mut pos_frames = Vec::with_capacity(if flags.contains(AnimationFlags::POS_FRAMES) {
            num_frames as usize
        } else {
            0
        });
        if flags.contains(AnimationFlags::POS_FRAMES) {
            for _ in 0..num_frames {
                pos_frames.push(Frame::read_le(reader)?);
            }
        }

        let mut part_frames = Vec::with_capacity(num_frames as usize);
        for _ in 0..num_frames {
            part_frames.push(AnimationFrame::read(reader, num_parts)?);
        }

        Ok(Self {
            id,
            flags,
            num_parts,
            num_frames,
            pos_frames,
            part_frames,
        })
    }

    pub fn unpack(data: &[u8]) -> BinResult<Self> {
        let mut cursor = std::io::Cursor::new(data);
        Self::read(&mut cursor)
    }

    /// Serialize this Animation back into the canonical DAT body layout —
    /// `[u32 id][u32 flags][u32 num_parts][u32 num_frames]`
    /// `[Frame]*(POS_FRAMES?num_frames:0)[AnimationFrame]*num_frames` — the
    /// exact inverse of [`Animation::read`]. The header counts written are the
    /// stored `num_parts` / `num_frames` (matching the read side), so
    /// `unpack(pack(x)) == x` holds byte-for-byte.
    ///
    /// Fails closed (no malformed bytes) when the in-memory record is internally
    /// inconsistent with its own counts, since the reader re-derives the vector
    /// lengths from the header and an inconsistent record could not be re-read:
    /// - `pos_frames.len()` must equal `num_frames` when `POS_FRAMES` is set,
    ///   else 0;
    /// - `part_frames.len()` must equal `num_frames`;
    /// - every `part_frame.frames.len()` must equal `num_parts`.
    /// The richer attributable `InvariantViolation` is raised by the dat-write
    /// `pack/animation.rs` guard before this is reached; this is the
    /// last-line structural guard so the parser itself never emits a
    /// non-re-readable record.
    pub fn write<W: Write + Seek>(&self, writer: &mut W) -> BinResult<()> {
        let custom = |writer: &mut W, msg: String| binrw::Error::Custom {
            pos: writer.stream_position().unwrap_or(0),
            err: Box::new(AnimationWriteError(msg)),
        };

        let expected_pos = if self.flags.contains(AnimationFlags::POS_FRAMES) {
            self.num_frames as usize
        } else {
            0
        };
        if self.pos_frames.len() != expected_pos {
            return Err(custom(
                writer,
                format!(
                    "pos_frames.len()={} != expected {} (POS_FRAMES={}, num_frames={})",
                    self.pos_frames.len(),
                    expected_pos,
                    self.flags.contains(AnimationFlags::POS_FRAMES),
                    self.num_frames
                ),
            ));
        }
        if self.part_frames.len() != self.num_frames as usize {
            return Err(custom(
                writer,
                format!(
                    "part_frames.len()={} != num_frames={}",
                    self.part_frames.len(),
                    self.num_frames
                ),
            ));
        }
        for (i, pf) in self.part_frames.iter().enumerate() {
            if pf.frames.len() != self.num_parts as usize {
                return Err(custom(
                    writer,
                    format!(
                        "part_frames[{}].frames.len()={} != num_parts={}",
                        i,
                        pf.frames.len(),
                        self.num_parts
                    ),
                ));
            }
        }

        self.id.write_le(writer)?;
        self.flags.bits().write_le(writer)?;
        self.num_parts.write_le(writer)?;
        self.num_frames.write_le(writer)?;

        if self.flags.contains(AnimationFlags::POS_FRAMES) {
            for frame in &self.pos_frames {
                frame.write_le(writer)?;
            }
        }

        for pf in &self.part_frames {
            // AnimationFrame::write emits `frames` (num_parts of them) then the
            // hook count + hooks — the exact inverse of AnimationFrame::read.
            pf.write(writer)?;
        }

        Ok(())
    }

    /// Pack into a freshly allocated `Vec<u8>` — for byte-equal round-trip
    /// parity against retail Animations.
    pub fn pack(&self) -> BinResult<Vec<u8>> {
        let mut buf = std::io::Cursor::new(Vec::new());
        self.write(&mut buf)?;
        Ok(buf.into_inner())
    }
}

#[derive(Debug)]
struct AnimationWriteError(String);

impl std::fmt::Display for AnimationWriteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Animation write invariant: {}", self.0)
    }
}

impl std::error::Error for AnimationWriteError {}

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_common::{Quaternion, Vector3};
    use std::io::Cursor;

    #[test]
    fn animation_reads_pos_frames_and_empty_part_frames() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&0x0300_1234u32.to_le_bytes());
        bytes.extend_from_slice(&AnimationFlags::POS_FRAMES.bits().to_le_bytes());
        bytes.extend_from_slice(&1u32.to_le_bytes());
        bytes.extend_from_slice(&1u32.to_le_bytes());

        bytes.extend_from_slice(&1.0f32.to_le_bytes());
        bytes.extend_from_slice(&2.0f32.to_le_bytes());
        bytes.extend_from_slice(&3.0f32.to_le_bytes());
        bytes.extend_from_slice(&1.0f32.to_le_bytes());
        bytes.extend_from_slice(&0.0f32.to_le_bytes());
        bytes.extend_from_slice(&0.0f32.to_le_bytes());
        bytes.extend_from_slice(&0.0f32.to_le_bytes());

        bytes.extend_from_slice(&0.0f32.to_le_bytes());
        bytes.extend_from_slice(&0.0f32.to_le_bytes());
        bytes.extend_from_slice(&0.0f32.to_le_bytes());
        bytes.extend_from_slice(&1.0f32.to_le_bytes());
        bytes.extend_from_slice(&0.0f32.to_le_bytes());
        bytes.extend_from_slice(&0.0f32.to_le_bytes());
        bytes.extend_from_slice(&0.0f32.to_le_bytes());
        bytes.extend_from_slice(&0u32.to_le_bytes());

        let animation = Animation::read(&mut Cursor::new(bytes)).expect("animation should parse");

        assert_eq!(animation.id, 0x0300_1234);
        assert_eq!(animation.num_parts, 1);
        assert_eq!(animation.num_frames, 1);
        assert_eq!(animation.part_frames.len(), 1);
        assert_eq!(animation.part_frames[0].frames.len(), 1);
        assert!(animation.part_frames[0].hooks.is_empty());
        assert_eq!(
            animation.pos_frames,
            vec![Frame {
                origin: Vector3::new(1.0, 2.0, 3.0),
                orientation: Quaternion {
                    w: 1.0,
                    x: 0.0,
                    y: 0.0,
                    z: 0.0,
                },
            }]
        );
        assert_eq!(
            animation.part_frames[0].frames[0].orientation,
            Quaternion {
                w: 1.0,
                x: 0.0,
                y: 0.0,
                z: 0.0,
            }
        );
    }

    fn valid_anim_bytes() -> Vec<u8> {
        // id, flags=POS_FRAMES, num_parts=1, num_frames=1, one pos Frame
        // (Vector3 + Quaternion), one part_frame (1 Frame + 0 hooks).
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&0x0300_1234u32.to_le_bytes());
        bytes.extend_from_slice(&AnimationFlags::POS_FRAMES.bits().to_le_bytes());
        bytes.extend_from_slice(&1u32.to_le_bytes());
        bytes.extend_from_slice(&1u32.to_le_bytes());
        // pos Frame
        for f in [1.0f32, 2.0, 3.0, 1.0, 0.0, 0.0, 0.0] {
            bytes.extend_from_slice(&f.to_le_bytes());
        }
        // part_frame[0]: one Frame
        for f in [0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0] {
            bytes.extend_from_slice(&f.to_le_bytes());
        }
        // hook count = 0
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes
    }

    #[test]
    fn pack_is_exact_inverse_of_unpack() {
        let bytes = valid_anim_bytes();
        let anim = Animation::unpack(&bytes).expect("parse");
        let packed = anim.pack().expect("pack");
        assert_eq!(packed, bytes, "pack must be the exact byte inverse of unpack");
        let reparsed = Animation::unpack(&packed).expect("re-parse");
        assert_eq!(reparsed.id, anim.id);
        assert_eq!(reparsed.flags, anim.flags);
        assert_eq!(reparsed.num_parts, anim.num_parts);
        assert_eq!(reparsed.num_frames, anim.num_frames);
        assert_eq!(reparsed.pos_frames, anim.pos_frames);
        assert_eq!(reparsed.part_frames.len(), anim.part_frames.len());
    }

    #[test]
    fn flags_with_unknown_bits_round_trip_byte_for_byte() {
        // Retail flags word with POS_FRAMES (0x1) + an extra unknown bit (0x2).
        // `from_bits_retain` must preserve the full 0x3 so the packed flags word
        // equals the input byte-for-byte (from_bits_truncate would zero 0x2).
        let mut bytes = valid_anim_bytes();
        // Overwrite the flags word (offset 4..8) with 0x0000_0003.
        bytes[4..8].copy_from_slice(&0x0000_0003u32.to_le_bytes());
        let anim = Animation::unpack(&bytes).expect("parse");
        assert_eq!(
            anim.flags.bits(),
            0x0000_0003,
            "unknown flag bits must be retained, not truncated"
        );
        let packed = anim.pack().expect("pack");
        assert_eq!(
            packed, bytes,
            "flags word with unknown bits must round-trip byte-for-byte"
        );
        assert_eq!(&packed[4..8], &0x0000_0003u32.to_le_bytes());
    }

    #[test]
    fn write_rejects_pos_frames_count_mismatch_without_panic() {
        let bytes = valid_anim_bytes();
        let mut anim = Animation::unpack(&bytes).expect("parse");
        // POS_FRAMES set but pos_frames emptied → inconsistent with num_frames.
        anim.pos_frames.clear();
        let err = anim.pack().expect_err("inconsistent pos_frames must Err");
        assert!(
            format!("{err}").contains("pos_frames"),
            "error should attribute the pos_frames mismatch: {err}"
        );
    }

    #[test]
    fn write_rejects_part_frames_count_mismatch_without_panic() {
        let bytes = valid_anim_bytes();
        let mut anim = Animation::unpack(&bytes).expect("parse");
        anim.part_frames.clear(); // now 0 != num_frames=1
        let err = anim.pack().expect_err("inconsistent part_frames must Err");
        assert!(format!("{err}").contains("part_frames"), "{err}");
    }
}
