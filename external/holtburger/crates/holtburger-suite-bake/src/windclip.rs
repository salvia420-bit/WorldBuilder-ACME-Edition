//! windclip — the P4.3 per-DID tree-wind codec that rides inside a [`SuiteBlob`]
//! (`type_tag = "windclip"`). It carries the *exact* output of the JS golden math
//! (`wind_rig.js` `buildBboxRig` → `buildTreeWindClip`) so the browser decoder is a
//! zero-transform `Float32Array` view: K phase-bucketed clips per DID, each a frame-major
//! `[ox,oy,oz, qw,qx,qy,qz]` (AC quaternion order **wxyz**) block, plus the geometry-derived
//! rig the consumer may re-synthesize per bucket from.
//!
//! Layering (D2): the **container** ([`SuiteBlob`]) owns magic / version / advisory
//! content-hash; this **codec** owns only the `payload` framing. Errors are kept separate
//! ([`WindClipError`] vs [`super::BlobError`]) so the two layers never conflate.
//!
//! # Payload wire format (all little-endian)
//! ```text
//! off  size  field
//! 0    4     num_parts  : u32
//! 4    4     num_frames : u32
//! 8    4     k          : u32   (phase-bucket count; D1 default 4 = live K)
//! 12   4     fps        : f32   (f32, lossless for any opts.fps; D1 default 30)
//! --- k bucket blocks, BUCKET-MAJOR, b = 0..k ---
//! 16 + b*BS   bucket[b] : (num_frames*num_parts*7) x f32, FRAME-MAJOR then part-major
//!                         value(f,p,c) = data[(f*num_parts + p)*7 + c]
//!                         c: 0=ox 1=oy 2=oz 3=qw 4=qx 5=qy 6=qz   (AC wxyz)
//!             BS = num_frames*num_parts*7*4 bytes
//! --- rig, p = 0..num_parts, 44 bytes each ---
//! 16 + k*BS + p*44 : pivot.x,y,z, weight, rest_o.x,y,z, rest_q.w,x,y,z   (11 x f32)
//! ```
//! total = `16 + k*num_frames*num_parts*7*4 + num_parts*44` (always %4 == 0).
//!
//! ## Bucket-order contract (load-bearing)
//! Bucket `b` MUST be produced at `windParams.phaseOffset = (b/k)*2π`, emitted in ascending
//! `b`. The runtime selects block `b = floor(hash01(key)*K) % K` and expects exactly that
//! phase baked in; emit out of order and every instance's sway phase mismatches.
//!
//! ## Determinism / fingerprint
//! The body stores RAW IEEE-754 f32 LE (no `{:.6}` truncation — that regime is JSONL-only
//! and lossy, A12 §4). [`fingerprint`] folds `to_bits()` via FNV-1a/64 through the shared
//! [`fingerprint_f32_bits`] in the `Lossless` regime (keeps `-0.0 → +0.0` so a re-bake that
//! emits `+0.0` where the last one emitted `-0.0` does not false-positive the advisory gate).

use holtburger_common::bake_fingerprint::{
    fingerprint_f32_bits, fnv1a_fold, FloatCanon, FNV1A_OFFSET,
};

use crate::{BlobError, SuiteBlob};

/// The `type_tag` this codec rides under inside a [`SuiteBlob`] (keys the JS decoder + URL).
pub const WINDCLIP_TAG: &str = "windclip";

/// Per-part rest pose + sway weighting, baked from geometry (deterministic). Mirrors
/// `wind_rig.js` `buildBboxRig().rigs[p]`: model-space `pivot`, `swayAmp` `weight`, and the
/// `rest` frame `{o, q:[w,x,y,z]}` (AC quaternion order). Rides the `.bin` so the consumer
/// can re-synthesize per-bucket phase from rig + live wind (firewall: weather stays runtime).
#[derive(Clone, Debug, PartialEq)]
pub struct RigPart {
    /// model-space part base = (modelBox.cx, modelBox.cy, modelBox.minZ).
    pub pivot: [f32; 3],
    /// swayAmp(modelBox, modelMinZ, modelH) ∈ [0.1, 1].
    pub weight: f32,
    /// rest origin offset (rest.o).
    pub rest_o: [f32; 3],
    /// rest quaternion, AC order **wxyz** (rest.q = [w, x, y, z]).
    pub rest_q: [f32; 4],
}

impl RigPart {
    /// Flatten to the 11-float wire order: pivot.xyz, weight, rest_o.xyz, rest_q.wxyz.
    #[inline]
    fn as_array(&self) -> [f32; 11] {
        [
            self.pivot[0], self.pivot[1], self.pivot[2],
            self.weight,
            self.rest_o[0], self.rest_o[1], self.rest_o[2],
            self.rest_q[0], self.rest_q[1], self.rest_q[2], self.rest_q[3],
        ]
    }
}

/// A decoded windclip: K phase-bucketed clips + the per-part rig.
///
/// `buckets.len() == k`; each `buckets[b].len() == num_frames*num_parts*7`, FRAME-MAJOR
/// (`[(f*num_parts + p)*7 + c]`). `rig.len() == num_parts`. `f32` only ⇒ derives
/// `PartialEq` (not `Eq`).
#[derive(Clone, Debug, PartialEq)]
pub struct WindClip {
    pub num_parts: u32,
    pub num_frames: u32,
    pub fps: f32,
    /// K buckets, ascending `b`; bucket `b` baked at `phaseOffset = (b/k)*2π`.
    pub buckets: Vec<Vec<f32>>,
    /// One [`RigPart`] per part (len == `num_parts`).
    pub rig: Vec<RigPart>,
}

/// Codec-layer error (distinct from the container's [`BlobError`]).
#[derive(Debug, PartialEq, Eq)]
pub enum WindClipError {
    /// Fewer bytes than the header-implied length (or a header read ran off the end).
    Truncated,
    /// `k == 0`, or a `num_frames*num_parts*7` size computation overflowed `usize`.
    BadCounts,
    /// More bytes than the header-implied length.
    TrailingBytes,
    /// The [`SuiteBlob`] `type_tag` was not `"windclip"`.
    WrongTag,
    /// The container layer ([`SuiteBlob::decode`]) rejected the bytes (magic/version/hash).
    Container(BlobError),
}

const HEADER_LEN: usize = 16;
const FLOATS_PER_PART_PER_FRAME: usize = 7;
const RIG_FLOATS_PER_PART: usize = 11;
const RIG_BYTES_PER_PART: usize = RIG_FLOATS_PER_PART * 4; // 44

/// Floats per bucket = `num_frames * num_parts * 7`, with overflow → [`WindClipError::BadCounts`].
fn frame_floats(num_frames: u32, num_parts: u32) -> Result<usize, WindClipError> {
    (num_frames as usize)
        .checked_mul(num_parts as usize)
        .and_then(|x| x.checked_mul(FLOATS_PER_PART_PER_FRAME))
        .ok_or(WindClipError::BadCounts)
}

/// Total payload length the header implies, with every step overflow-checked.
fn expected_payload_len(num_parts: u32, num_frames: u32, k: u32) -> Result<usize, WindClipError> {
    let ff = frame_floats(num_frames, num_parts)?;
    let bs = ff.checked_mul(4).ok_or(WindClipError::BadCounts)?;
    let buckets = (k as usize).checked_mul(bs).ok_or(WindClipError::BadCounts)?;
    let rig = (num_parts as usize)
        .checked_mul(RIG_BYTES_PER_PART)
        .ok_or(WindClipError::BadCounts)?;
    HEADER_LEN
        .checked_add(buckets)
        .and_then(|x| x.checked_add(rig))
        .ok_or(WindClipError::BadCounts)
}

/// Bounds-checked cursor read, mirroring `lib.rs::take` (codec-layer error flavor).
fn take<'a>(bytes: &'a [u8], o: &mut usize, n: usize) -> Result<&'a [u8], WindClipError> {
    if *o + n > bytes.len() {
        return Err(WindClipError::Truncated);
    }
    let s = &bytes[*o..*o + n];
    *o += n;
    Ok(s)
}

fn read_u32(bytes: &[u8], o: &mut usize) -> Result<u32, WindClipError> {
    Ok(u32::from_le_bytes(take(bytes, o, 4)?.try_into().unwrap()))
}

fn read_f32(bytes: &[u8], o: &mut usize) -> Result<f32, WindClipError> {
    Ok(f32::from_le_bytes(take(bytes, o, 4)?.try_into().unwrap()))
}

impl WindClip {
    /// Encode just the codec **payload** (no container framing): header ints, then the K
    /// bucket f32 arrays in stored order, then the rig records. Deterministic by
    /// construction — fixed field order, LE throughout, no map iteration. Raw f32 bits
    /// (no truncation, no `-0.0` collapse in the body; collapse is fingerprint-only).
    pub fn encode_payload(&self) -> Vec<u8> {
        let k = self.buckets.len() as u32;
        debug_assert_eq!(self.rig.len(), self.num_parts as usize, "rig len must == num_parts");
        let ff = frame_floats(self.num_frames, self.num_parts)
            .expect("real part/frame counts fit usize");
        let total = expected_payload_len(self.num_parts, self.num_frames, k)
            .expect("real counts fit usize");
        let mut out = Vec::with_capacity(total);
        out.extend_from_slice(&self.num_parts.to_le_bytes());
        out.extend_from_slice(&self.num_frames.to_le_bytes());
        out.extend_from_slice(&k.to_le_bytes());
        out.extend_from_slice(&self.fps.to_le_bytes());
        for bucket in &self.buckets {
            debug_assert_eq!(bucket.len(), ff, "each bucket len must == num_frames*num_parts*7");
            for &v in bucket {
                out.extend_from_slice(&v.to_le_bytes());
            }
        }
        for part in &self.rig {
            for v in part.as_array() {
                out.extend_from_slice(&v.to_le_bytes());
            }
        }
        debug_assert_eq!(out.len(), total);
        out
    }

    /// Encode to the full container bytes: wrap [`encode_payload`](Self::encode_payload) in a
    /// `SuiteBlob{type_tag:"windclip"}` (adds magic/version/framing + advisory content-hash).
    /// Infallible: the fixed tag is ASCII and ≤ `MAX_TYPE_TAG`.
    pub fn encode(&self) -> Vec<u8> {
        SuiteBlob::new(WINDCLIP_TAG, self.encode_payload())
            .encode()
            .expect("\"windclip\" tag is ASCII and within MAX_TYPE_TAG")
    }

    /// Parse a codec **payload** (container already stripped). Reads the header, recomputes
    /// the implied length (overflow-checked → [`BadCounts`](WindClipError::BadCounts)),
    /// rejects short ([`Truncated`](WindClipError::Truncated)) / long
    /// ([`TrailingBytes`](WindClipError::TrailingBytes)) buffers, then slices the K buckets +
    /// rig via a `take()` cursor.
    pub fn decode_payload(bytes: &[u8]) -> Result<WindClip, WindClipError> {
        let mut o = 0usize;
        let num_parts = read_u32(bytes, &mut o)?;
        let num_frames = read_u32(bytes, &mut o)?;
        let k = read_u32(bytes, &mut o)?;
        let fps = read_f32(bytes, &mut o)?;
        if k == 0 {
            return Err(WindClipError::BadCounts);
        }
        let ff = frame_floats(num_frames, num_parts)?;
        let expected = expected_payload_len(num_parts, num_frames, k)?;
        if bytes.len() < expected {
            return Err(WindClipError::Truncated);
        }
        if bytes.len() > expected {
            return Err(WindClipError::TrailingBytes);
        }
        let mut buckets = Vec::with_capacity(k as usize);
        for _ in 0..k {
            let mut bucket = Vec::with_capacity(ff);
            for _ in 0..ff {
                bucket.push(read_f32(bytes, &mut o)?);
            }
            buckets.push(bucket);
        }
        let mut rig = Vec::with_capacity(num_parts as usize);
        for _ in 0..num_parts {
            let pivot = [
                read_f32(bytes, &mut o)?,
                read_f32(bytes, &mut o)?,
                read_f32(bytes, &mut o)?,
            ];
            let weight = read_f32(bytes, &mut o)?;
            let rest_o = [
                read_f32(bytes, &mut o)?,
                read_f32(bytes, &mut o)?,
                read_f32(bytes, &mut o)?,
            ];
            let rest_q = [
                read_f32(bytes, &mut o)?,
                read_f32(bytes, &mut o)?,
                read_f32(bytes, &mut o)?,
                read_f32(bytes, &mut o)?,
            ];
            rig.push(RigPart { pivot, weight, rest_o, rest_q });
        }
        Ok(WindClip { num_parts, num_frames, fps, buckets, rig })
    }

    /// Codec-layer view of an already-decoded container: assert the tag, then parse the
    /// payload. The container's magic/version/advisory-hash were validated by
    /// [`SuiteBlob::decode`] before this.
    pub fn from_blob(blob: &SuiteBlob) -> Result<WindClip, WindClipError> {
        if blob.type_tag != WINDCLIP_TAG {
            return Err(WindClipError::WrongTag);
        }
        Self::decode_payload(&blob.payload)
    }

    /// Decode full container bytes: [`SuiteBlob::decode`] (container, advisory hash) →
    /// [`from_blob`](Self::from_blob) (tag) → [`decode_payload`](Self::decode_payload).
    pub fn decode(bytes: &[u8]) -> Result<WindClip, WindClipError> {
        let blob = SuiteBlob::decode(bytes).map_err(WindClipError::Container)?;
        Self::from_blob(&blob)
    }
}

/// The `windclip-hash` sidecar value: FNV-1a/64 over the header ints + every f32 folded as
/// `Lossless` bits (raw `to_bits`, `-0.0 → +0.0`). Distinct from the container's
/// [`content_hash`](crate::content_hash), which folds the raw payload bytes — this one is
/// `-0.0`-stable so it survives benign zero-sign noise between re-bakes. Iteration is fixed:
/// header, then buckets 0..k (each in stored frame-major order), then rig parts 0..n. No map.
pub fn fingerprint(clip: &WindClip) -> u64 {
    let mut h = FNV1A_OFFSET;
    h = fnv1a_fold(h, clip.num_parts);
    h = fnv1a_fold(h, clip.num_frames);
    h = fnv1a_fold(h, clip.buckets.len() as u32);
    h = fnv1a_fold(h, fingerprint_f32_bits(clip.fps, FloatCanon::Lossless));
    for bucket in &clip.buckets {
        for &v in bucket {
            h = fnv1a_fold(h, fingerprint_f32_bits(v, FloatCanon::Lossless));
        }
    }
    for part in &clip.rig {
        for v in part.as_array() {
            h = fnv1a_fold(h, fingerprint_f32_bits(v, FloatCanon::Lossless));
        }
    }
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A small but non-degenerate synthetic clip with distinct, deterministic values so a
    /// transposed/misordered field would change the bytes. num_parts=2, num_frames=3, k=4.
    fn sample() -> WindClip {
        let num_parts = 2u32;
        let num_frames = 3u32;
        let k = 4u32;
        let ff = (num_frames * num_parts * 7) as usize; // 42
        let buckets: Vec<Vec<f32>> = (0..k)
            .map(|b| {
                (0..ff)
                    .map(|i| (b as f32) * 100.0 + (i as f32) * 0.25 - 1.5)
                    .collect()
            })
            .collect();
        let rig: Vec<RigPart> = (0..num_parts)
            .map(|p| RigPart {
                pivot: [p as f32, p as f32 + 0.5, p as f32 - 0.25],
                weight: 0.1 + 0.3 * p as f32,
                rest_o: [10.0 + p as f32, 20.0, -30.0 - p as f32],
                rest_q: [1.0, 0.0, 0.0, 0.0],
            })
            .collect();
        WindClip { num_parts, num_frames, fps: 30.0, buckets, rig }
    }

    #[test]
    fn payload_layout_size_matches_formula() {
        let c = sample();
        let payload = c.encode_payload();
        // 16 + k*num_frames*num_parts*7*4 + num_parts*44
        let expected = 16 + 4 * 3 * 2 * 7 * 4 + 2 * 44;
        assert_eq!(payload.len(), expected);
        assert_eq!(payload.len() % 4, 0);
        // header echo, LE
        assert_eq!(&payload[0..4], &2u32.to_le_bytes());
        assert_eq!(&payload[4..8], &3u32.to_le_bytes());
        assert_eq!(&payload[8..12], &4u32.to_le_bytes());
        assert_eq!(&payload[12..16], &30.0f32.to_le_bytes());
    }

    #[test]
    fn payload_round_trips() {
        let c = sample();
        let dec = WindClip::decode_payload(&c.encode_payload()).unwrap();
        assert_eq!(dec, c);
    }

    #[test]
    fn blob_round_trips_through_container() {
        let c = sample();
        let dec = WindClip::decode(&c.encode()).unwrap();
        assert_eq!(dec, c);
        // and the container tag is what the JS decoder keys on
        let blob = SuiteBlob::decode(&c.encode()).unwrap();
        assert_eq!(blob.type_tag, WINDCLIP_TAG);
    }

    #[test]
    fn encode_is_deterministic() {
        let c = sample();
        assert_eq!(c.encode_payload(), c.encode_payload());
        assert_eq!(c.encode(), c.encode());
        // same logical clip built twice → byte-identical container
        assert_eq!(sample().encode(), sample().encode());
    }

    #[test]
    fn content_hash_and_fingerprint_stable_and_sensitive() {
        let c = sample();
        // container advisory hash is stable + matches a fresh recompute over the payload
        assert_eq!(crate::content_hash(&c.encode_payload()), crate::content_hash(&c.encode_payload()));
        // codec fingerprint stable, and changes when a single float changes
        assert_eq!(fingerprint(&c), fingerprint(&c));
        let mut c2 = c.clone();
        c2.buckets[1][5] += 1.0;
        assert_ne!(fingerprint(&c), fingerprint(&c2));
        // -0.0 vs +0.0 in the body must NOT change the (Lossless, zero-collapsing) fingerprint
        let mut cz = c.clone();
        cz.rig[0].rest_q = [1.0, -0.0, 0.0, -0.0];
        let mut cp = c.clone();
        cp.rig[0].rest_q = [1.0, 0.0, 0.0, 0.0];
        assert_eq!(fingerprint(&cz), fingerprint(&cp));
    }

    #[test]
    fn decode_rejects_bad_counts_truncation_and_trailing() {
        let c = sample();
        let good = c.encode_payload();
        // k == 0 → BadCounts
        let mut zero_k = good.clone();
        zero_k[8..12].copy_from_slice(&0u32.to_le_bytes());
        assert_eq!(WindClip::decode_payload(&zero_k), Err(WindClipError::BadCounts));
        // short buffer → Truncated
        assert_eq!(
            WindClip::decode_payload(&good[..good.len() - 4]),
            Err(WindClipError::Truncated),
        );
        // header-only short buffer (can't even read the 16-byte header) → Truncated
        assert_eq!(WindClip::decode_payload(&good[..8]), Err(WindClipError::Truncated));
        // extra trailing bytes → TrailingBytes
        let mut long = good.clone();
        long.extend_from_slice(&[0u8; 4]);
        assert_eq!(WindClip::decode_payload(&long), Err(WindClipError::TrailingBytes));
    }

    #[test]
    fn from_blob_rejects_wrong_tag_and_decode_rejects_container_corruption() {
        let c = sample();
        // wrong tag at the codec layer
        let other = SuiteBlob::new("texchan", c.encode_payload());
        assert_eq!(WindClip::from_blob(&other), Err(WindClipError::WrongTag));
        // container corruption surfaces as Container(_)
        let mut bad = c.encode();
        bad[0] = b'X'; // clobber magic
        assert_eq!(WindClip::decode(&bad), Err(WindClipError::Container(BlobError::BadMagic)));
    }
}
