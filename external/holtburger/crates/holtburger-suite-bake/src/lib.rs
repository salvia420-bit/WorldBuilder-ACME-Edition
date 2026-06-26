//! holtburger-suite-bake — the per-DID binary-sidecar producer for the Phase-4 bake
//! migration (A07 / SL-24). Emits `dist/suite/0x{DID:08X}.<type>.bin` artifacts that the
//! wasm `mod suite_fetch` fetches and the JS `suite_assets.js` decodes (one decoder per
//! `type_tag`). This crate owns the reusable BINARY CONTAINER framing + determinism; the
//! per-type codecs (windclip in P4.3, texchan in Phase-5) layer their `payload` on top.
//!
//! Deterministic by construction: identical `(type_tag, payload)` ⇒ byte-identical output
//! (no `HashMap`, fixed field order, LE everywhere). The trailing FNV-1a/64 content hash
//! (via the shared `bake_fingerprint` primitive) is the **advisory** "forgot to re-bake"
//! gate — never gates a rendered pixel.

use holtburger_common::bake_fingerprint::{fnv1a_fold, FNV1A_OFFSET};

/// Container magic — "Holtburger Suite Bake", container format v1.
pub const MAGIC: [u8; 4] = *b"HSB1";
pub const CONTAINER_VERSION: u16 = 1;
/// `type_tag` must fit a u8 length prefix and stay ASCII (it keys the JS decoder + the URL).
pub const MAX_TYPE_TAG: usize = 16;

/// Advisory FNV-1a/64 over a payload: fold 4-byte LE words, zero-padding the tail. Same
/// primitive + discipline as the scenery placements-hash, so a `.bin.sha256` sidecar can
/// carry a `content-hash` line the client recomputes. Advisory only.
pub fn content_hash(payload: &[u8]) -> u64 {
    let mut h = FNV1A_OFFSET;
    for chunk in payload.chunks(4) {
        let mut w = [0u8; 4];
        w[..chunk.len()].copy_from_slice(chunk);
        h = fnv1a_fold(h, u32::from_le_bytes(w));
    }
    h
}

/// A per-DID binary sidecar: a typed, length-framed payload + advisory content hash.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SuiteBlob {
    /// Selects the JS decoder + the artifact filename suffix, e.g. "windclip". ASCII, ≤16B.
    pub type_tag: String,
    /// The per-type codec's bytes (e.g. windclip frame-major f32 LE). Opaque here.
    pub payload: Vec<u8>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum BlobError {
    BadMagic,
    BadVersion,
    Truncated,
    TagTooLong,
    NonAscii,
    HashMismatch,
}

fn take<'a>(bytes: &'a [u8], o: &mut usize, n: usize) -> Result<&'a [u8], BlobError> {
    if *o + n > bytes.len() {
        return Err(BlobError::Truncated);
    }
    let s = &bytes[*o..*o + n];
    *o += n;
    Ok(s)
}

impl SuiteBlob {
    pub fn new(type_tag: impl Into<String>, payload: Vec<u8>) -> Self {
        Self { type_tag: type_tag.into(), payload }
    }

    /// Deterministic encode. Layout (all LE):
    /// `MAGIC[4] | version:u16 | tag_len:u8 | tag[tag_len] | payload_len:u32 | payload | content_hash:u64`.
    pub fn encode(&self) -> Result<Vec<u8>, BlobError> {
        let tag = self.type_tag.as_bytes();
        if tag.len() > MAX_TYPE_TAG {
            return Err(BlobError::TagTooLong);
        }
        if !self.type_tag.is_ascii() {
            return Err(BlobError::NonAscii);
        }
        let mut out = Vec::with_capacity(4 + 2 + 1 + tag.len() + 4 + self.payload.len() + 8);
        out.extend_from_slice(&MAGIC);
        out.extend_from_slice(&CONTAINER_VERSION.to_le_bytes());
        out.push(tag.len() as u8);
        out.extend_from_slice(tag);
        out.extend_from_slice(&(self.payload.len() as u32).to_le_bytes());
        out.extend_from_slice(&self.payload);
        out.extend_from_slice(&content_hash(&self.payload).to_le_bytes());
        Ok(out)
    }

    /// Parse + verify (magic, version, length framing, advisory content hash).
    pub fn decode(bytes: &[u8]) -> Result<Self, BlobError> {
        let mut o = 0usize;
        if take(bytes, &mut o, 4)? != MAGIC {
            return Err(BlobError::BadMagic);
        }
        let ver = u16::from_le_bytes(take(bytes, &mut o, 2)?.try_into().unwrap());
        if ver != CONTAINER_VERSION {
            return Err(BlobError::BadVersion);
        }
        let tag_len = take(bytes, &mut o, 1)?[0] as usize;
        let tag = take(bytes, &mut o, tag_len)?;
        let type_tag = core::str::from_utf8(tag).map_err(|_| BlobError::NonAscii)?.to_string();
        if !type_tag.is_ascii() {
            return Err(BlobError::NonAscii);
        }
        let plen = u32::from_le_bytes(take(bytes, &mut o, 4)?.try_into().unwrap()) as usize;
        let payload = take(bytes, &mut o, plen)?.to_vec();
        let stored = u64::from_le_bytes(take(bytes, &mut o, 8)?.try_into().unwrap());
        if stored != content_hash(&payload) {
            return Err(BlobError::HashMismatch);
        }
        Ok(Self { type_tag, payload })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> SuiteBlob {
        // payload not a multiple of 4 → exercises the zero-pad tail in content_hash
        SuiteBlob::new("windclip", vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    }

    #[test]
    fn round_trips() {
        let b = sample();
        let dec = SuiteBlob::decode(&b.encode().unwrap()).unwrap();
        assert_eq!(dec, b);
    }

    #[test]
    fn encode_is_deterministic() {
        assert_eq!(sample().encode().unwrap(), sample().encode().unwrap());
    }

    #[test]
    fn content_hash_stable_and_payload_sensitive() {
        assert_eq!(content_hash(&[1, 2, 3, 4, 5]), content_hash(&[1, 2, 3, 4, 5]));
        assert_ne!(content_hash(&[1, 2, 3, 4, 5]), content_hash(&[1, 2, 3, 4, 6]));
        assert_eq!(content_hash(&[]), FNV1A_OFFSET); // empty payload = unfolded seed
    }

    #[test]
    fn decode_rejects_corruption() {
        let good = sample().encode().unwrap();
        // bad magic
        let mut m = good.clone();
        m[0] = b'X';
        assert_eq!(SuiteBlob::decode(&m), Err(BlobError::BadMagic));
        // truncated
        assert_eq!(SuiteBlob::decode(&good[..good.len() - 3]), Err(BlobError::Truncated));
        // flipped payload byte → content-hash mismatch (advisory gate fires)
        let mut h = good.clone();
        let pi = 4 + 2 + 1 + "windclip".len() + 4; // first payload byte
        h[pi] ^= 0xFF;
        assert_eq!(SuiteBlob::decode(&h), Err(BlobError::HashMismatch));
    }

    #[test]
    fn rejects_overlong_tag() {
        let b = SuiteBlob::new("this_tag_is_definitely_too_long", vec![0]);
        assert_eq!(b.encode(), Err(BlobError::TagTooLong));
    }
}
