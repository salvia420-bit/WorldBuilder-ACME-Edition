//! PAGE-RESAMPLE — the bake/transcode-side normalization of texture members
//! to ARRAY-PAGE dims (T22 deviation D2; T00 re-key 2026-08-09 §4).
//!
//! WHY THIS EXISTS
//! ---------------
//! `scene3d/pool_class_key.js` keys the pool class's texture axis on an
//! ARRAY-PAGE TIER — a square pow2 page 256²/512²/1024²/2048², the clamp-ceil
//! of the max TEXREF-declared dimension:
//!
//! ```text
//!   t = clamp(ceil(log2(max(TEXREF w, TEXREF h))), 8, 11)
//! ```
//!
//! One class = one material = one `sampler2DArray` = ONE `texStorage3D`
//! allocation, whose (format, w, h) is fixed at allocation. Two members can
//! therefore share a class only if they can share LAYERS of that one page.
//! The re-key's correctness half is the rule this module implements:
//!
//! > a member whose native dims ≠ its page dims is stored RESAMPLED to page
//! > dims at bake/transcode time.
//!
//! After that normalization "any two members of a class share any layer of
//! the class's one allocation" is a THEOREM of the key rather than a hope,
//! every layer is fully covered (UV 0..1 spans the whole layer), and wrap,
//! full mip chains and aniso all stay legal — no subrects, no `fract()`
//! tricks, no mip bleed.
//!
//! T22 shipped the KEY and exported the predicate (`pageDimsOf` /
//! `needsResample`); it could not ship the resample because the resample
//! belongs to the texture pipeline (ST5/ST6), not to pools. This module is
//! that half.
//!
//! PARITY IS PINNED, NOT ASSUMED
//! -----------------------------
//! T22 owns `pool_class_key.js` and this task must not edit it, so the
//! arithmetic here MIRRORS it and `tests/page_resample.rs` pins the two
//! together by running the real JS module under `node` over an exhaustive
//! dimension grid and diffing against these functions. A drift in either
//! side turns that test red. The shared constants are named identically
//! (`PAGE_TIER_MIN`/`PAGE_TIER_MAX`) on both sides.
//!
//! THE KERNEL, AND WHY IT IS AN AREA (BOX) FILTER
//! ----------------------------------------------
//! `resample_planar` is an exact-rational AREA filter computed in integer
//! arithmetic — no floats anywhere, so the output is bit-identical on every
//! machine and every run (the house determinism rule; `bake-source.sha256`
//! and friends are worthless over a nondeterministic kernel).
//!
//! The area filter is also the semantically RIGHT kernel here, not a
//! compromise:
//!
//!  * **integer upscale** (the dominant case — most resampled members are
//!    small textures paying the 256² floor) degenerates EXACTLY to texel
//!    replication: dest pixel `i` lies wholly inside source pixel `i/k`, so
//!    the weight is 1. Replication adds no blur, and a box mip chain over a
//!    k× replicated image reproduces the ORIGINAL image exactly at level
//!    log2(k) — the page costs VRAM, never sharpness. A bilinear/Lanczos
//!    "upscale" would blur content that the GPU would otherwise magnify
//!    identically to the native texture.
//!  * **integer downscale** (the clamp cases: 4096² and larger → 2048²)
//!    degenerates exactly to the box average, which is what mip generation
//!    does anyway.
//!  * fractional ratios (non-pow2 sources like 1096² or 2560×1920) get a
//!    correct coverage-weighted average with no special-casing.
//!
//! Channels are resampled independently and NOT alpha-weighted — the same
//! choice `basisu -resample`'s own box filter makes, so a member that skips
//! this module and gets resampled by the encoder instead lands in the same
//! place.

use serde::Serialize;

// ---------------------------------------------------------------------------
// the page tier (MIRROR of scene3d/pool_class_key.js — pinned by tests)
// ---------------------------------------------------------------------------

/// Array-page tier bounds: log2 of the page edge. 8 = 256², 11 = 2048².
pub const PAGE_TIER_MIN: u32 = 8;
pub const PAGE_TIER_MAX: u32 = 11;

/// `ceil(log2(v))` for `v >= 1`; 0 for `v <= 1`.
fn ceil_log2(v: u32) -> u32 {
    if v <= 1 { 0 } else { u32::BITS - (v - 1).leading_zeros() }
}

/// Page tier for a declared max dimension —
/// `t = clamp(ceil(log2(maxDim)), 8, 11)`.
///
/// Mirrors `pageTierOf()`: a zero/absent dimension floors to 1 (⇒ tier 8),
/// and anything past 2048 CLAMPS to 11 (⇒ a downscale, which is why the
/// re-key's "upscale-only by construction" sentence is true only up to the
/// clamp — see `PageAction::Downscale`).
pub fn page_tier_of(max_dim: u32) -> u32 {
    let d = max_dim.max(1);
    ceil_log2(d).clamp(PAGE_TIER_MIN, PAGE_TIER_MAX)
}

/// Square page edge in texels for a tier (256/512/1024/2048).
pub fn page_edge_of(tier: u32) -> u32 {
    1u32 << tier.clamp(PAGE_TIER_MIN, PAGE_TIER_MAX)
}

/// Page dims a member is stored at. `None` is the UNTEXTURED class (no page,
/// no array, no resample).
///
/// Exact mirror of `pageDimsOf(rec)` for the boolean `hasTex` that
/// `axisRecordOf` always produces: the UNTEXTURED verdict comes from
/// `hasTex`, NOT from the dims. So `hasTex: false` is null whatever the dims
/// say, and a declared `hasTex` member with all-zero dims still pages (to
/// the 256² floor) rather than vanishing. Both combinations are unreachable
/// from `axisRecordOf` today — it sets `hasTex` exactly when a width is
/// present — but the parity test pins them anyway, because "unreachable
/// today" is not "unreachable".
pub fn page_dims_of(has_tex: bool, w: u32, h: u32) -> Option<(u32, u32)> {
    if !has_tex {
        return None;
    }
    let e = page_edge_of(page_tier_of(w.max(h)));
    Some((e, e))
}

/// True when the member's native dims differ from its page (⇒ resampled).
/// This is the count the bake drives to ZERO. Mirrors `needsResample()`.
pub fn needs_resample(has_tex: bool, w: u32, h: u32) -> bool {
    match page_dims_of(has_tex, w, h) {
        None => false,
        Some((pw, ph)) => w != pw || h != ph,
    }
}

/// Bake-side convenience: a record read out of a DAT / KTX2 header is
/// textured exactly when it has a dimension. Zero-by-zero is "no texture
/// here" and plans to nothing.
pub fn needs_resample_dims(w: u32, h: u32) -> bool {
    needs_resample(w > 0 || h > 0, w, h)
}

/// The TEXREF `dims` byte for a page: `(t << 4) | t`. Kept next to the tier
/// arithmetic so the pack encoder and the predicate cannot drift.
pub fn dims_byte_of(w: u32, h: u32) -> u8 {
    ((ceil_log2(w) as u8) << 4) | (ceil_log2(h) as u8 & 0x0F)
}

/// What the resample does to one member — the plan row's verdict.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PageAction {
    /// Native dims already equal the page: stored verbatim, byte-identical.
    Identity,
    /// Every axis grows (the common case: the 256² floor + squaring).
    Upscale,
    /// At least one axis shrinks — only reachable past the tier clamp
    /// (source > 2048 on its long edge) or from a mixed aspect such as
    /// 2560×1920 → 2048².
    Downscale,
}

/// One member's resample verdict. Deterministic function of `(w, h)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct PagePlan {
    pub src_w: u32,
    pub src_h: u32,
    pub page_w: u32,
    pub page_h: u32,
    pub tier: u32,
    pub action: PageAction,
}

/// Plan one member from measured dims. `None` for the untextured class
/// (all-zero dims — nothing to page and nothing to resample).
pub fn plan_page(w: u32, h: u32) -> Option<PagePlan> {
    let (pw, ph) = page_dims_of(w > 0 || h > 0, w, h)?;
    let action = if w == pw && h == ph {
        PageAction::Identity
    } else if pw >= w && ph >= h {
        PageAction::Upscale
    } else {
        PageAction::Downscale
    };
    Some(PagePlan {
        src_w: w,
        src_h: h,
        page_w: pw,
        page_h: ph,
        tier: page_tier_of(w.max(h)),
        action,
    })
}

// ---------------------------------------------------------------------------
// the kernel
// ---------------------------------------------------------------------------

/// Per-dest-pixel source spans with exact integer coverage weights.
///
/// Source pixel `x` occupies `[x*dst_len, (x+1)*dst_len)`; dest pixel `i`
/// occupies `[i*src_len, (i+1)*src_len)` — same unit scale (`src_len *
/// dst_len` total), so every overlap is an integer and the weights of one
/// dest pixel sum to exactly `src_len`.
fn coverage(src_len: u32, dst_len: u32) -> Vec<Vec<(u32, u32)>> {
    let (s, d) = (src_len as u64, dst_len as u64);
    let mut out = Vec::with_capacity(dst_len as usize);
    for i in 0..d {
        let (lo, hi) = (i * s, (i + 1) * s);
        // First and last source pixel touched by this dest span.
        let x0 = lo / d;
        let x1 = ((hi + d - 1) / d).min(s); // exclusive
        let mut row = Vec::with_capacity((x1 - x0) as usize);
        for x in x0..x1 {
            let a = (x * d).max(lo);
            let b = ((x + 1) * d).min(hi);
            if b > a {
                row.push((x as u32, (b - a) as u32));
            }
        }
        out.push(row);
    }
    out
}

/// Exact-rational area resample of an interleaved 8-bit image.
///
/// `channels` is 1..=4 (the corpus is RGB8/RGBA8; the extra arities keep the
/// kernel usable for single-plane payloads such as NRA). Panics on a
/// mis-sized input rather than producing a half-image — a bake that resamples
/// garbage is worse than a bake that stops.
pub fn resample_planar(
    src: &[u8],
    src_w: u32,
    src_h: u32,
    dst_w: u32,
    dst_h: u32,
    channels: usize,
) -> Vec<u8> {
    assert!((1..=4).contains(&channels), "channels must be 1..=4, got {channels}");
    assert!(src_w > 0 && src_h > 0 && dst_w > 0 && dst_h > 0, "zero dimension");
    assert_eq!(
        src.len(),
        src_w as usize * src_h as usize * channels,
        "source buffer is {} B, expected {}x{}x{}",
        src.len(),
        src_w,
        src_h,
        channels
    );
    if src_w == dst_w && src_h == dst_h {
        return src.to_vec();
    }

    let cx = coverage(src_w, dst_w);
    let cy = coverage(src_h, dst_h);

    // Horizontal pass: src_h rows × dst_w cols, undivided sums (max
    // 255 * src_w ≤ 255 * 65535 — u32 is ample).
    let mut inter = vec![0u32; src_h as usize * dst_w as usize * channels];
    for y in 0..src_h as usize {
        let srow = &src[y * src_w as usize * channels..][..src_w as usize * channels];
        let drow = &mut inter[y * dst_w as usize * channels..][..dst_w as usize * channels];
        for (i, taps) in cx.iter().enumerate() {
            for c in 0..channels {
                let mut acc = 0u32;
                for &(x, w) in taps {
                    acc += srow[x as usize * channels + c] as u32 * w;
                }
                drow[i * channels + c] = acc;
            }
        }
    }

    // Vertical pass + the single normalization. Round half away from zero.
    let norm = src_w as u64 * src_h as u64;
    let half = norm / 2;
    let mut out = vec![0u8; dst_w as usize * dst_h as usize * channels];
    for (j, taps) in cy.iter().enumerate() {
        let drow = &mut out[j * dst_w as usize * channels..][..dst_w as usize * channels];
        for i in 0..dst_w as usize {
            for c in 0..channels {
                let mut acc = 0u64;
                for &(y, w) in taps {
                    acc += inter[(y as usize * dst_w as usize + i) * channels + c] as u64
                        * w as u64;
                }
                let v = (acc + half) / norm;
                drow[i * channels + c] = v.min(255) as u8;
            }
        }
    }
    out
}

/// Resample an image to its PAGE dims. `None` when it is already there
/// (`PageAction::Identity`) — the caller stores the source verbatim, which
/// keeps identity members BYTE-IDENTICAL to the corpus they derive from.
pub fn resample_to_page(
    src: &[u8],
    src_w: u32,
    src_h: u32,
    channels: usize,
) -> Option<(u32, u32, Vec<u8>)> {
    let plan = plan_page(src_w, src_h)?;
    if plan.action == PageAction::Identity {
        return None;
    }
    Some((
        plan.page_w,
        plan.page_h,
        resample_planar(src, src_w, src_h, plan.page_w, plan.page_h, channels),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tier_matches_the_rekey_table() {
        // clamp-ceil, both ends.
        assert_eq!(page_tier_of(0), 8);
        assert_eq!(page_tier_of(1), 8);
        assert_eq!(page_tier_of(256), 8);
        assert_eq!(page_tier_of(257), 9);
        assert_eq!(page_tier_of(512), 9);
        assert_eq!(page_tier_of(1024), 10);
        assert_eq!(page_tier_of(1096), 11);
        assert_eq!(page_tier_of(2048), 11);
        assert_eq!(page_tier_of(4096), 11); // CLAMPS — a downscale
        assert_eq!(page_edge_of(8), 256);
        assert_eq!(page_edge_of(11), 2048);
    }

    #[test]
    fn page_dims_and_the_predicate() {
        assert_eq!(page_dims_of(false, 512, 512), None); // untextured wins
        assert_eq!(page_dims_of(true, 0, 0), Some((256, 256))); // floors, per JS
        assert_eq!(page_dims_of(true, 512, 512), Some((512, 512)));
        assert_eq!(page_dims_of(true, 512, 1024), Some((1024, 1024)));
        assert_eq!(page_dims_of(true, 32, 32), Some((256, 256)));
        assert_eq!(page_dims_of(true, 4096, 4096), Some((2048, 2048)));
        assert!(!needs_resample_dims(512, 512));
        assert!(needs_resample_dims(512, 1024));
        assert!(needs_resample_dims(128, 128));
        assert!(needs_resample_dims(4096, 4096));
        assert!(!needs_resample_dims(0, 0));
        assert!(!needs_resample(false, 128, 128));
        // The dims byte for a page is (t<<4)|t.
        assert_eq!(dims_byte_of(1024, 1024), (10 << 4) | 10);
        assert_eq!(dims_byte_of(1024, 256), (10 << 4) | 8);
    }

    #[test]
    fn plan_actions() {
        assert_eq!(plan_page(512, 512).unwrap().action, PageAction::Identity);
        assert_eq!(plan_page(64, 64).unwrap().action, PageAction::Upscale);
        assert_eq!(plan_page(512, 1024).unwrap().action, PageAction::Upscale);
        assert_eq!(plan_page(4096, 4096).unwrap().action, PageAction::Downscale);
        assert_eq!(plan_page(2560, 1920).unwrap().action, PageAction::Downscale);
        assert_eq!(plan_page(0, 0), None);
    }

    #[test]
    fn integer_upscale_is_exact_replication() {
        // 2x2 → 8x8 (k = 4): every dest texel equals its source texel.
        let src: Vec<u8> = vec![10, 20, 30, 40];
        let out = resample_planar(&src, 2, 2, 8, 8, 1);
        for y in 0..8usize {
            for x in 0..8usize {
                let want = src[(y / 4) * 2 + (x / 4)];
                assert_eq!(out[y * 8 + x], want, "at ({x},{y})");
            }
        }
    }

    #[test]
    fn integer_downscale_is_the_box_average() {
        // 4x4 → 2x2: each dest is the mean of its 2x2 quad.
        let src: Vec<u8> = (0..16).map(|v| (v * 16) as u8).collect();
        let out = resample_planar(&src, 4, 4, 2, 2, 1);
        let mean = |a: [usize; 4]| -> u8 {
            let s: u32 = a.iter().map(|&i| src[i] as u32).sum();
            ((s + 2) / 4) as u8
        };
        assert_eq!(out[0], mean([0, 1, 4, 5]));
        assert_eq!(out[1], mean([2, 3, 6, 7]));
        assert_eq!(out[2], mean([8, 9, 12, 13]));
        assert_eq!(out[3], mean([10, 11, 14, 15]));
    }

    #[test]
    fn replicate_then_box_mip_round_trips_to_the_original() {
        // The claim the header makes: a k× replicated page, box-reduced by
        // k (= what mip generation does), reproduces the source EXACTLY.
        let src: Vec<u8> = (0..64u32).map(|v| (v * 3 + 7) as u8).collect(); // 8x8
        let page = resample_planar(&src, 8, 8, 256, 256, 1);
        let back = resample_planar(&page, 256, 256, 8, 8, 1);
        assert_eq!(back, src);
    }

    #[test]
    fn weights_are_conservative_on_a_flat_image() {
        // A constant image must survive ANY ratio unchanged (the weights of
        // one dest pixel sum to exactly the normalizer).
        for (sw, sh, dw, dh) in [
            (1096u32, 1096u32, 2048u32, 2048u32),
            (2560, 1920, 2048, 2048),
            (300, 6, 512, 512),
            (4096, 4096, 2048, 2048),
        ] {
            let src = vec![137u8; (sw * sh) as usize];
            let out = resample_planar(&src, sw, sh, dw, dh, 1);
            assert!(out.iter().all(|&v| v == 137), "{sw}x{sh} → {dw}x{dh} drifted");
        }
    }

    #[test]
    fn channels_are_independent_and_interleaved() {
        // 1x1 RGBA → 4x4 RGBA: replication, channel order preserved.
        let src = vec![1u8, 2, 3, 4];
        let out = resample_planar(&src, 1, 1, 4, 4, 4);
        assert_eq!(out.len(), 4 * 4 * 4);
        assert!(out.chunks(4).all(|p| p == [1, 2, 3, 4]));
    }

    #[test]
    fn deterministic_across_runs() {
        let src: Vec<u8> = (0..(37 * 53 * 4)).map(|v| (v % 251) as u8).collect();
        let a = resample_planar(&src, 37, 53, 256, 256, 4);
        let b = resample_planar(&src, 37, 53, 256, 256, 4);
        assert_eq!(a, b);
    }

    #[test]
    fn identity_is_byte_identical_and_skipped() {
        let src: Vec<u8> = (0..(512 * 512 * 3)).map(|v| (v % 255) as u8).collect();
        assert!(resample_to_page(&src, 512, 512, 3).is_none());
        let same = resample_planar(&src, 512, 512, 512, 512, 3);
        assert_eq!(same, src);
    }
}
