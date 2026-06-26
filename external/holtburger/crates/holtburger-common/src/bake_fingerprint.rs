//! bake_fingerprint — the ONE determinism primitive shared by every per-DID/per-LB
//! bake producer (scenery, P4 suite/windclip, …) AND the client-side advisory gates.
//!
//! Extracted (Phase-4 P4.0b) from the byte-identical copies that lived in
//! `holtburger-scenery-bake` (`fnv1a_fold`/`wire_f32_bits`) and the wasm
//! `mod scenery_fetch` inline twin, so every bake artifact's freeze-hash is identical
//! bit-for-bit on the producer and the client regardless of platform. No deps beyond
//! core/alloc (`format!`); wasm-safe. Pure.
//!
//! A fingerprint is **advisory**: a mismatch means the shipped artifact diverged from a
//! fresh bake of the same inputs (the "edited the baker but forgot to re-bake" trap). It
//! MUST NEVER drive a procedural re-derive / alter a rendered pixel.

/// FNV-1a/64 offset basis + prime (the standard constants; identical to the values the
/// scenery bake folds through, so a placement fingerprint matches bit-for-bit).
pub const FNV1A_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
pub const FNV1A_PRIME: u64 = 0x0000_0100_0000_01b3;

/// Fold one `u32` word (little-endian bytes) into a running FNV-1a/64 hash. Seed with
/// [`FNV1A_OFFSET`]. The single primitive both producer and client fold through.
#[inline]
pub fn fnv1a_fold(mut h: u64, word: u32) -> u64 {
    for byte in word.to_le_bytes() {
        h ^= byte as u64;
        h = h.wrapping_mul(FNV1A_PRIME);
    }
    h
}

/// How a float's bits are canonicalised before folding — it MUST match how the consumer
/// reconstructs the value, or the advisory gate false-positives.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FloatCanon {
    /// Post-`{:.6}` (+ `-0.0 → 0.0`) truncation bits — the value a JSONL `{:.6}` text
    /// field round-trips to. The scenery placements + the P4 descriptor `{:.6}` scalars
    /// (tipFlex shaft frame, anchor center/radius, wind config) ride this regime.
    SixDp,
    /// Raw IEEE-754 f32 bits (with `-0.0 → 0.0`) — for binary artifacts that carry the
    /// exact f32, so the consumer reconstructs it losslessly (the P4 windclip `.bin`).
    Lossless,
}

/// Canonicalise one f32 to the bits the consumer reconstructs, per `canon`.
#[inline]
pub fn fingerprint_f32_bits(v: f32, canon: FloatCanon) -> u32 {
    // Collapse both zero encodings first so a signed -0.0 hashes identically to +0.0.
    let v = if v == 0.0 { 0.0 } else { v };
    match canon {
        // `{:.6}` is locale-free in Rust (always `.`), so byte-stable across machines;
        // reparsing recovers exactly the f32 the client gets from serde_json. Lossy for
        // f32 (an arbitrary f32 needs up to 9 sig-digits), so the fingerprint hashes the
        // post-truncation value, not the raw in-memory f32.
        FloatCanon::SixDp => {
            let truncated: f32 = format!("{v:.6}").parse().unwrap_or(v);
            truncated.to_bits()
        }
        FloatCanon::Lossless => v.to_bits(),
    }
}

/// The scenery-side `{:.6}` wire-bits alias. By construction
/// `wire_f32_bits(v) == fingerprint_f32_bits(v, FloatCanon::SixDp)`, so the existing
/// `placements_fingerprint` value is preserved exactly when scenery folds through this.
#[inline]
pub fn wire_f32_bits(v: f32) -> u32 {
    fingerprint_f32_bits(v, FloatCanon::SixDp)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_f32_bits_is_the_sixdp_alias() {
        for v in [0.0_f32, 1.0, -1.5, 0.7071068, 1.234_567_9, 192.0, -0.000001, 1e6] {
            assert_eq!(wire_f32_bits(v), fingerprint_f32_bits(v, FloatCanon::SixDp));
        }
    }

    #[test]
    fn sixdp_matches_scenery_quaternion_rule() {
        // The doc's worked example: a 0.7071068 quaternion component round-trips
        // 0x3f3504f4 → "0.707107" → 0x3f3504f7 under the {:.6}+reparse rule.
        let raw = f32::from_bits(0x3f3504f4);
        assert_eq!(format!("{raw:.6}"), "0.707107");
        assert_eq!(wire_f32_bits(raw), 0x3f3504f7);
    }

    #[test]
    fn neg_zero_collapses_in_both_regimes() {
        assert_eq!(wire_f32_bits(-0.0), wire_f32_bits(0.0));
        assert_eq!(fingerprint_f32_bits(-0.0, FloatCanon::Lossless), 0u32); // +0.0 bits
        assert_eq!(fingerprint_f32_bits(-0.0, FloatCanon::Lossless),
                   fingerprint_f32_bits(0.0, FloatCanon::Lossless));
    }

    #[test]
    fn lossless_preserves_exact_bits_sixdp_truncates() {
        let v = 1.234_567_9_f32;
        assert_eq!(fingerprint_f32_bits(v, FloatCanon::Lossless), v.to_bits());
        // SixDp truncates to "1.234568" → a different bit pattern than the raw f32.
        let trunc: f32 = "1.234568".parse().unwrap();
        assert_eq!(fingerprint_f32_bits(v, FloatCanon::SixDp), trunc.to_bits());
        assert_ne!(fingerprint_f32_bits(v, FloatCanon::SixDp), v.to_bits());
    }

    #[test]
    fn fnv1a_fold_is_deterministic_and_order_sensitive() {
        let a = fnv1a_fold(fnv1a_fold(FNV1A_OFFSET, 0x1234_5678), 0x9abc_def0);
        let b = fnv1a_fold(fnv1a_fold(FNV1A_OFFSET, 0x1234_5678), 0x9abc_def0);
        assert_eq!(a, b);                                  // deterministic
        let swapped = fnv1a_fold(fnv1a_fold(FNV1A_OFFSET, 0x9abc_def0), 0x1234_5678);
        assert_ne!(a, swapped);                            // order-sensitive
        assert_ne!(fnv1a_fold(FNV1A_OFFSET, 0), FNV1A_OFFSET); // folding changes the hash
    }
}
