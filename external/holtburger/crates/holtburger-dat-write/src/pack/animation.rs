//! `impl DatPack for Animation` — delegates to the new `Animation::pack`
//! (E12 design §B, WRITE-NEW type 0x03) and enforces the count-consistency
//! invariants.
//!
//! `Animation` carries explicit `num_parts` / `num_frames` header counts that
//! the reader uses to re-derive every vector length. A record whose vectors
//! disagree with those counts could not be re-read after writing, so the guard
//! fails closed BEFORE `Animation::pack` runs:
//!
//! - `pos_frames.len()` MUST equal `num_frames` when `POS_FRAMES` is set, else
//!   `0`;
//! - `part_frames.len()` MUST equal `num_frames`;
//! - every `part_frame.frames.len()` MUST equal `num_parts`.
//!
//! (The underlying `Animation::write` re-checks these as a last line of
//! defence and would also `Err`, but the guard here surfaces an attributable
//! [`WriteError::InvariantViolation`] with the offending type/file id.)

use holtburger_dat::DatFileType;
use holtburger_dat::file_type::Animation;
use holtburger_dat::file_type::animation::AnimationFlags;

use crate::DatPack;
use crate::error::{Result, WriteError};

impl DatPack for Animation {
    fn pack(&self) -> Result<Vec<u8>> {
        // Fail closed: enforce header/vector count consistency before bytes.
        validate(self)?;

        Ok(Animation::pack(self)?)
    }

    fn type_id(&self) -> u32 {
        DatFileType::Animation as u32
    }

    fn id(&self) -> u32 {
        self.id
    }
}

fn validate(anim: &Animation) -> Result<()> {
    let type_id = DatFileType::Animation as u32;
    let file_id = anim.id;

    let expected_pos = if anim.flags.contains(AnimationFlags::POS_FRAMES) {
        anim.num_frames as usize
    } else {
        0
    };
    if anim.pos_frames.len() != expected_pos {
        return Err(violation(
            type_id,
            file_id,
            format!(
                "pos_frames.len()={} != expected {} (POS_FRAMES={}, num_frames={})",
                anim.pos_frames.len(),
                expected_pos,
                anim.flags.contains(AnimationFlags::POS_FRAMES),
                anim.num_frames
            ),
        ));
    }

    if anim.part_frames.len() != anim.num_frames as usize {
        return Err(violation(
            type_id,
            file_id,
            format!(
                "part_frames.len()={} != num_frames={}",
                anim.part_frames.len(),
                anim.num_frames
            ),
        ));
    }

    for (i, pf) in anim.part_frames.iter().enumerate() {
        if pf.frames.len() != anim.num_parts as usize {
            return Err(violation(
                type_id,
                file_id,
                format!(
                    "part_frames[{}].frames.len()={} != num_parts={}",
                    i,
                    pf.frames.len(),
                    anim.num_parts
                ),
            ));
        }
    }

    Ok(())
}

fn violation(type_id: u32, file_id: u32, reason: String) -> WriteError {
    WriteError::InvariantViolation {
        type_id,
        file_id,
        reason,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_common::{Quaternion, Vector3};
    use holtburger_dat::file_type::setup_model::AnimationFrame;
    use holtburger_dat::graphics::Frame;

    fn frame(x: f32) -> Frame {
        Frame {
            origin: Vector3::new(x, x + 1.0, x + 2.0),
            orientation: Quaternion {
                w: 1.0,
                x: 0.0,
                y: 0.0,
                z: 0.0,
            },
        }
    }

    fn anim(num_parts: u32, num_frames: u32, pos: bool) -> Animation {
        let flags = if pos {
            AnimationFlags::POS_FRAMES
        } else {
            AnimationFlags::empty()
        };
        let pos_frames = if pos {
            (0..num_frames).map(|i| frame(i as f32)).collect()
        } else {
            vec![]
        };
        let part_frames = (0..num_frames)
            .map(|_| AnimationFrame {
                frames: (0..num_parts).map(|p| frame(p as f32)).collect(),
                hooks: vec![],
            })
            .collect();
        Animation {
            id: 0x0300_1234,
            flags,
            num_parts,
            num_frames,
            pos_frames,
            part_frames,
        }
    }

    #[test]
    fn animation_pack_round_trips_byte_and_structurally_equal() {
        let a = anim(2, 3, true);

        let bytes = DatPack::pack(&a).expect("valid Animation must pack");

        let reparsed = Animation::unpack(&bytes).expect("packed bytes must re-unpack");
        assert_eq!(reparsed.id, a.id);
        assert_eq!(reparsed.flags, a.flags);
        assert_eq!(reparsed.num_parts, a.num_parts);
        assert_eq!(reparsed.num_frames, a.num_frames);
        assert_eq!(reparsed.pos_frames, a.pos_frames);
        assert_eq!(reparsed.part_frames.len(), a.part_frames.len());
        for (l, r) in reparsed.part_frames.iter().zip(a.part_frames.iter()) {
            assert_eq!(l.frames, r.frames);
            assert_eq!(l.hooks.len(), r.hooks.len());
        }

        assert_eq!(bytes, a.pack().expect("underlying pack"));

        let bytes2 = DatPack::pack(&reparsed).expect("re-parsed must pack");
        assert_eq!(bytes, bytes2, "Animation pack must be byte-for-byte idempotent");

        assert_eq!(DatPack::type_id(&a), DatFileType::Animation as u32);
        assert_eq!(DatPack::id(&a), 0x0300_1234);
    }

    #[test]
    fn animation_without_pos_frames_round_trips() {
        let a = anim(1, 2, false);
        let bytes = DatPack::pack(&a).expect("no-pos Animation must pack");
        let reparsed = Animation::unpack(&bytes).expect("re-unpack");
        assert!(reparsed.pos_frames.is_empty());
        assert_eq!(reparsed.part_frames.len(), 2);
        let bytes2 = DatPack::pack(&reparsed).expect("re-pack");
        assert_eq!(bytes, bytes2);
    }

    #[test]
    fn negative_pos_frames_count_mismatch_is_rejected() {
        let mut a = anim(1, 2, true);
        a.pos_frames.pop(); // now 1 != num_frames=2 under POS_FRAMES
        let err = DatPack::pack(&a).expect_err("pos_frames mismatch must be rejected");
        match err {
            WriteError::InvariantViolation { type_id, file_id, reason } => {
                assert_eq!(type_id, DatFileType::Animation as u32);
                assert_eq!(file_id, 0x0300_1234);
                assert!(reason.contains("pos_frames"), "reason: {reason}");
            }
            other => panic!("expected InvariantViolation, got {other:?}"),
        }
    }

    #[test]
    fn negative_part_frames_count_mismatch_is_rejected() {
        let mut a = anim(1, 2, false);
        a.part_frames.pop(); // now 1 != num_frames=2
        let err = DatPack::pack(&a).expect_err("part_frames mismatch must be rejected");
        match err {
            WriteError::InvariantViolation { reason, .. } => {
                assert!(reason.contains("part_frames.len()"), "reason: {reason}");
            }
            other => panic!("expected InvariantViolation, got {other:?}"),
        }
    }

    #[test]
    fn negative_part_frame_inner_frame_count_mismatch_is_rejected() {
        let mut a = anim(2, 1, false);
        // num_parts=2 but the single part_frame has only 1 inner Frame.
        a.part_frames[0].frames.pop();
        let err = DatPack::pack(&a).expect_err("inner frame count mismatch must be rejected");
        match err {
            WriteError::InvariantViolation { reason, .. } => {
                assert!(reason.contains("!= num_parts"), "reason: {reason}");
            }
            other => panic!("expected InvariantViolation, got {other:?}"),
        }
    }
}
