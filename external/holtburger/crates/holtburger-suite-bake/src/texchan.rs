//! texchan — the Phase-5 per-surface material-detail codec that rides inside a [`SuiteBlob`]
//! (`type_tag = "texchan"`, the name pre-reserved by the crate doc + the windclip wrong-tag
//! test). It carries the offline-baked detail channels for ONE surface — the normal map
//! (`holtburger_dat::normal_from_luminance`, RGB8), the micro-roughness map
//! (`roughness_from_luminance`, R8) and the cavity/AO map (`ao_from_luminance`, R8) — so the
//! browser decoder is a zero-transform `Uint8Array` view per present channel.
//!
//! Layering (mirrors windclip): the **container** ([`SuiteBlob`]) owns magic / version /
//! advisory content-hash; this **codec** owns only the `payload` framing. Errors stay separate
//! ([`TexChanError`] vs [`super::BlobError`]) so the two layers never conflate.
//!
//! Keyed by **surface content-hash, not DID** (surfaces are shared across many DIDs → dedup);
//! the S1 generators are per-pixel (no global normalisation) so a cropped/atlased sub-region
//! bakes identical bytes — load-bearing for that dedup key.
//!
//! # Payload wire format (all little-endian)
//! ```text
//! off  size  field
//! 0    4     width        : u32
//! 4    4     height       : u32
//! 8    4     channel_mask : u32   (bit0 normal RGB8, bit1 roughness R8, bit2 ao R8)
//! 12   4     encoding     : u32   (0 = raw u8 channels; reserved for BC/DXT — deferred)
//! --- channels present iff their mask bit is set, in ASCENDING bit order ---
//! normal    : width*height*3 bytes (RGB8, tangent-space, same pack as normal_from_luminance)
//! roughness : width*height   bytes (R8)
//! ao        : width*height   bytes (R8, aoMap convention: 255 = unoccluded)
//! ```
//! total = `16 + popcount-weighted channel bytes`. Channels are u8 (the JS side reads byte
//! views) so there is no 4-byte alignment requirement — unlike windclip's f32 body.
//!
//! ## Determinism / fingerprint
//! Fixed field order, LE, ascending channel order, no map iteration ⇒ identical [`TexChan`] ⇒
//! byte-identical payload. [`fingerprint`] folds header ints + raw channel bytes via FNV-1a/64
//! (the shared [`fnv1a_fold`]); it is the `.texchan-hash` sidecar value (S5 emits it).

use holtburger_common::bake_fingerprint::{fnv1a_fold, FNV1A_OFFSET};

use crate::{BlobError, SuiteBlob};

/// The `type_tag` this codec rides under inside a [`SuiteBlob`] (keys the JS decoder + URL).
pub const TEXCHAN_TAG: &str = "texchan";

const HEADER_LEN: usize = 16;
const NORMAL_BPP: usize = 3;
const ROUGH_BPP: usize = 1;
const AO_BPP: usize = 1;

/// `encoding` header value for raw (uncompressed) u8 channels. BC/DXT would bump this — the
/// Phase-5 plan defers compression until VRAM forces it, so only raw is accepted for now.
const ENCODING_RAW: u32 = 0;

const CH_NORMAL: u32 = 1 << 0;
const CH_ROUGHNESS: u32 = 1 << 1;
const CH_AO: u32 = 1 << 2;
const CH_ALL_KNOWN: u32 = CH_NORMAL | CH_ROUGHNESS | CH_AO;

/// A decoded material-detail clip for one surface: width/height + up to three optional
/// channels. A `Some` channel's length is exactly `width*height*bpp` (RGB8 normal = 3,
/// R8 roughness/AO = 1). `None` = that channel was not baked for this surface (the consumer
/// falls back to runtime generation / the per-category base). All-u8 ⇒ derives `Eq`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TexChan {
    pub width: u32,
    pub height: u32,
    /// Tangent-space normal map, RGB8 (`width*height*3`), same pack as `normal_from_luminance`.
    pub normal: Option<Vec<u8>>,
    /// Micro-roughness map, R8 (`width*height`).
    pub roughness: Option<Vec<u8>>,
    /// Cavity/AO map, R8 (`width*height`); aoMap convention 255 = unoccluded.
    pub ao: Option<Vec<u8>>,
}

/// Codec-layer error (distinct from the container's [`BlobError`]).
#[derive(Debug, PartialEq, Eq)]
pub enum TexChanError {
    /// Fewer bytes than the header-implied length (or a header read ran off the end).
    Truncated,
    /// A `width*height*bpp` size computation overflowed `usize`.
    BadCounts,
    /// More bytes than the header-implied length.
    TrailingBytes,
    /// `encoding` was not [`ENCODING_RAW`] (a compressed payload this build can't decode).
    BadEncoding,
    /// `channel_mask` carried a bit outside [`CH_ALL_KNOWN`].
    BadMask,
    /// The [`SuiteBlob`] `type_tag` was not `"texchan"`.
    WrongTag,
    /// The container layer ([`SuiteBlob::decode`]) rejected the bytes (magic/version/hash).
    Container(BlobError),
}

fn pixel_count(w: u32, h: u32) -> Result<usize, TexChanError> {
    (w as usize)
        .checked_mul(h as usize)
        .ok_or(TexChanError::BadCounts)
}

fn chan_len(px: usize, bpp: usize) -> Result<usize, TexChanError> {
    px.checked_mul(bpp).ok_or(TexChanError::BadCounts)
}

/// Total payload length the header implies, every step overflow-checked.
fn expected_payload_len(w: u32, h: u32, mask: u32) -> Result<usize, TexChanError> {
    let px = pixel_count(w, h)?;
    let mut total = HEADER_LEN;
    if mask & CH_NORMAL != 0 {
        total = total
            .checked_add(chan_len(px, NORMAL_BPP)?)
            .ok_or(TexChanError::BadCounts)?;
    }
    if mask & CH_ROUGHNESS != 0 {
        total = total
            .checked_add(chan_len(px, ROUGH_BPP)?)
            .ok_or(TexChanError::BadCounts)?;
    }
    if mask & CH_AO != 0 {
        total = total
            .checked_add(chan_len(px, AO_BPP)?)
            .ok_or(TexChanError::BadCounts)?;
    }
    Ok(total)
}

/// Bounds-checked cursor read, mirroring `windclip::take` (codec-layer error flavor).
fn take<'a>(bytes: &'a [u8], o: &mut usize, n: usize) -> Result<&'a [u8], TexChanError> {
    if *o + n > bytes.len() {
        return Err(TexChanError::Truncated);
    }
    let s = &bytes[*o..*o + n];
    *o += n;
    Ok(s)
}

fn read_u32(bytes: &[u8], o: &mut usize) -> Result<u32, TexChanError> {
    Ok(u32::from_le_bytes(take(bytes, o, 4)?.try_into().unwrap()))
}

impl TexChan {
    /// The channel-presence bitmask for this clip (derived from which fields are `Some`).
    pub fn channel_mask(&self) -> u32 {
        let mut m = 0u32;
        if self.normal.is_some() {
            m |= CH_NORMAL;
        }
        if self.roughness.is_some() {
            m |= CH_ROUGHNESS;
        }
        if self.ao.is_some() {
            m |= CH_AO;
        }
        m
    }

    /// Encode just the codec **payload** (no container framing): header, then the present
    /// channels in ascending bit order. Deterministic by construction (fixed order, LE, raw
    /// u8). Debug-asserts each present channel's length matches `width*height*bpp`.
    pub fn encode_payload(&self) -> Vec<u8> {
        let mask = self.channel_mask();
        let total =
            expected_payload_len(self.width, self.height, mask).expect("real dims fit usize");
        let px = pixel_count(self.width, self.height).expect("real dims fit usize");
        let mut out = Vec::with_capacity(total);
        out.extend_from_slice(&self.width.to_le_bytes());
        out.extend_from_slice(&self.height.to_le_bytes());
        out.extend_from_slice(&mask.to_le_bytes());
        out.extend_from_slice(&ENCODING_RAW.to_le_bytes());
        if let Some(n) = &self.normal {
            debug_assert_eq!(n.len(), px * NORMAL_BPP, "normal len must == w*h*3");
            out.extend_from_slice(n);
        }
        if let Some(r) = &self.roughness {
            debug_assert_eq!(r.len(), px * ROUGH_BPP, "roughness len must == w*h");
            out.extend_from_slice(r);
        }
        if let Some(a) = &self.ao {
            debug_assert_eq!(a.len(), px * AO_BPP, "ao len must == w*h");
            out.extend_from_slice(a);
        }
        debug_assert_eq!(out.len(), total);
        out
    }

    /// Encode to full container bytes: wrap [`encode_payload`](Self::encode_payload) in a
    /// `SuiteBlob{type_tag:"texchan"}`. Infallible: the fixed tag is ASCII and ≤ `MAX_TYPE_TAG`.
    pub fn encode(&self) -> Vec<u8> {
        SuiteBlob::new(TEXCHAN_TAG, self.encode_payload())
            .encode()
            .expect("\"texchan\" tag is ASCII and within MAX_TYPE_TAG")
    }

    /// Parse a codec **payload** (container already stripped). Reads the header, rejects an
    /// unknown encoding / mask, recomputes the implied length (overflow-checked), rejects
    /// short / long buffers, then slices the present channels via a `take()` cursor.
    pub fn decode_payload(bytes: &[u8]) -> Result<TexChan, TexChanError> {
        let mut o = 0usize;
        let width = read_u32(bytes, &mut o)?;
        let height = read_u32(bytes, &mut o)?;
        let mask = read_u32(bytes, &mut o)?;
        let encoding = read_u32(bytes, &mut o)?;
        if encoding != ENCODING_RAW {
            return Err(TexChanError::BadEncoding);
        }
        if mask & !CH_ALL_KNOWN != 0 {
            return Err(TexChanError::BadMask);
        }
        let expected = expected_payload_len(width, height, mask)?;
        if bytes.len() < expected {
            return Err(TexChanError::Truncated);
        }
        if bytes.len() > expected {
            return Err(TexChanError::TrailingBytes);
        }
        let px = pixel_count(width, height)?;
        let normal = if mask & CH_NORMAL != 0 {
            Some(take(bytes, &mut o, chan_len(px, NORMAL_BPP)?)?.to_vec())
        } else {
            None
        };
        let roughness = if mask & CH_ROUGHNESS != 0 {
            Some(take(bytes, &mut o, chan_len(px, ROUGH_BPP)?)?.to_vec())
        } else {
            None
        };
        let ao = if mask & CH_AO != 0 {
            Some(take(bytes, &mut o, chan_len(px, AO_BPP)?)?.to_vec())
        } else {
            None
        };
        Ok(TexChan {
            width,
            height,
            normal,
            roughness,
            ao,
        })
    }

    /// Codec-layer view of an already-decoded container: assert the tag, then parse the payload.
    pub fn from_blob(blob: &SuiteBlob) -> Result<TexChan, TexChanError> {
        if blob.type_tag != TEXCHAN_TAG {
            return Err(TexChanError::WrongTag);
        }
        Self::decode_payload(&blob.payload)
    }

    /// Decode full container bytes: [`SuiteBlob::decode`] → [`from_blob`](Self::from_blob) →
    /// [`decode_payload`](Self::decode_payload).
    pub fn decode(bytes: &[u8]) -> Result<TexChan, TexChanError> {
        let blob = SuiteBlob::decode(bytes).map_err(TexChanError::Container)?;
        Self::from_blob(&blob)
    }
}

/// The `texchan-hash` sidecar value: FNV-1a/64 over the header ints + every present channel's
/// raw bytes (4-byte LE words, zero-padded tail), folded in ascending channel order. Structure-
/// aware (independent of container framing); deterministic. No `-0.0` concern — channels are u8.
pub fn fingerprint(tc: &TexChan) -> u64 {
    let mut h = FNV1A_OFFSET;
    h = fnv1a_fold(h, tc.width);
    h = fnv1a_fold(h, tc.height);
    h = fnv1a_fold(h, tc.channel_mask());
    for ch in [&tc.normal, &tc.roughness, &tc.ao] {
        if let Some(buf) = ch {
            for chunk in buf.chunks(4) {
                let mut w = [0u8; 4];
                w[..chunk.len()].copy_from_slice(chunk);
                h = fnv1a_fold(h, u32::from_le_bytes(w));
            }
        }
    }
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 4x2 surface (8 px), all three channels with distinct deterministic values so a
    /// transposed/misordered field would change the bytes.
    fn sample() -> TexChan {
        let (w, h) = (4u32, 2u32);
        let px = (w * h) as usize;
        let normal: Vec<u8> = (0..px * NORMAL_BPP)
            .map(|i| (i as u8).wrapping_mul(3).wrapping_add(7))
            .collect();
        let roughness: Vec<u8> = (0..px).map(|i| (i as u8).wrapping_mul(17)).collect();
        let ao: Vec<u8> = (0..px).map(|i| 255u8.wrapping_sub((i as u8).wrapping_mul(11))).collect();
        TexChan {
            width: w,
            height: h,
            normal: Some(normal),
            roughness: Some(roughness),
            ao: Some(ao),
        }
    }

    #[test]
    fn payload_layout_size_matches_formula() {
        let c = sample();
        let payload = c.encode_payload();
        // 16 + 8*3 + 8 + 8
        let expected = 16 + 8 * 3 + 8 + 8;
        assert_eq!(payload.len(), expected);
        assert_eq!(&payload[0..4], &4u32.to_le_bytes());
        assert_eq!(&payload[4..8], &2u32.to_le_bytes());
        assert_eq!(&payload[8..12], &(CH_NORMAL | CH_ROUGHNESS | CH_AO).to_le_bytes());
        assert_eq!(&payload[12..16], &ENCODING_RAW.to_le_bytes());
    }

    #[test]
    fn payload_round_trips() {
        let c = sample();
        let dec = TexChan::decode_payload(&c.encode_payload()).unwrap();
        assert_eq!(dec, c);
        assert_eq!(dec.channel_mask(), CH_NORMAL | CH_ROUGHNESS | CH_AO);
    }

    #[test]
    fn payload_round_trips_partial_channels() {
        // Normal only — roughness + ao absent. mask must reflect that.
        let c = TexChan {
            width: 4,
            height: 2,
            normal: Some(vec![9u8; 4 * 2 * 3]),
            roughness: None,
            ao: None,
        };
        let dec = TexChan::decode_payload(&c.encode_payload()).unwrap();
        assert_eq!(dec, c);
        assert_eq!(dec.channel_mask(), CH_NORMAL);
        // payload = header + only the normal channel
        assert_eq!(c.encode_payload().len(), 16 + 4 * 2 * 3);
    }

    #[test]
    fn blob_round_trips_through_container() {
        let c = sample();
        let dec = TexChan::decode(&c.encode()).unwrap();
        assert_eq!(dec, c);
        let blob = SuiteBlob::decode(&c.encode()).unwrap();
        assert_eq!(blob.type_tag, TEXCHAN_TAG);
    }

    #[test]
    fn encode_is_deterministic() {
        let c = sample();
        assert_eq!(c.encode_payload(), c.encode_payload());
        assert_eq!(c.encode(), c.encode());
        assert_eq!(sample().encode(), sample().encode());
    }

    #[test]
    fn fingerprint_stable_and_sensitive() {
        let c = sample();
        assert_eq!(fingerprint(&c), fingerprint(&c));
        // a single channel byte change flips the fingerprint
        let mut c2 = c.clone();
        c2.roughness.as_mut().unwrap()[3] ^= 0xFF;
        assert_ne!(fingerprint(&c), fingerprint(&c2));
        // dropping a channel changes the mask → flips the fingerprint
        let mut c3 = c.clone();
        c3.ao = None;
        assert_ne!(fingerprint(&c), fingerprint(&c3));
        // container advisory hash stable over the payload
        assert_eq!(
            crate::content_hash(&c.encode_payload()),
            crate::content_hash(&c.encode_payload())
        );
    }

    #[test]
    fn decode_rejects_truncation_trailing_mask_and_encoding() {
        let c = sample();
        let good = c.encode_payload();
        // short → Truncated
        assert_eq!(
            TexChan::decode_payload(&good[..good.len() - 1]),
            Err(TexChanError::Truncated)
        );
        // header-only short buffer → Truncated
        assert_eq!(TexChan::decode_payload(&good[..8]), Err(TexChanError::Truncated));
        // trailing → TrailingBytes
        let mut long = good.clone();
        long.push(0);
        assert_eq!(TexChan::decode_payload(&long), Err(TexChanError::TrailingBytes));
        // unknown mask bit → BadMask (checked before length)
        let mut bad_mask = good.clone();
        bad_mask[8..12].copy_from_slice(&(CH_NORMAL | (1 << 5)).to_le_bytes());
        assert_eq!(TexChan::decode_payload(&bad_mask), Err(TexChanError::BadMask));
        // unknown encoding → BadEncoding
        let mut bad_enc = good.clone();
        bad_enc[12..16].copy_from_slice(&1u32.to_le_bytes());
        assert_eq!(TexChan::decode_payload(&bad_enc), Err(TexChanError::BadEncoding));
    }

    #[test]
    fn from_blob_rejects_wrong_tag_and_decode_rejects_container_corruption() {
        let c = sample();
        let other = SuiteBlob::new("windclip", c.encode_payload());
        assert_eq!(TexChan::from_blob(&other), Err(TexChanError::WrongTag));
        let mut bad = c.encode();
        bad[0] = b'X'; // clobber magic
        assert_eq!(
            TexChan::decode(&bad),
            Err(TexChanError::Container(BlobError::BadMagic))
        );
    }
}
