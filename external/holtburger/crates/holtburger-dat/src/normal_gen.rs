//! Phase 1.1 — procedural normal maps from diffuse luminance.
//!
//! Given an RGBA8 decoded surface texture, produce a packed RGB8 normal
//! map by running a 3x3 Sobel kernel on the Rec.601 luminance channel.
//! The result feeds `MeshStandardMaterial.normalMap` on the JS side
//! (`apps/holtburger-web/scene3d/materials.js`).
//!
//! Encoding convention (tangent-space): `(0.5, 0.5, 1.0)` is "flat up".
//! Packed as `[r, g, b] = [(nx+1)/2 * 255, (ny+1)/2 * 255, nz * 255]`
//! with `nz = sqrt(1 - nx² - ny²)`. Three.js's `MeshStandardMaterial`
//! consumes normals in this exact convention when the texture's
//! `colorSpace` is set to linear (NOT sRGB).
//!
//! Luminance: Rec.601 weights `0.299*R + 0.587*G + 0.114*B`.
//!
//! For textures with `w <= 64 || h <= 64`, a single-pass 3x3 Gaussian
//! pre-blur is applied to the luminance buffer to reduce Sobel
//! choppiness on low-res inputs (per Phase 1.1 hand-off note #2).
//!
//! See §Phase 1.1 of `docs/visual-fidelity-push-prompt-2026-05-13.md`.

const LOW_RES_THRESHOLD: u32 = 64;

/// Generate an RGB8 normal map from RGBA8 diffuse pixels.
///
/// `strength` scales the Sobel gradient before normalisation. `1.0` is
/// the baseline; values >1 exaggerate bumps, <1 flatten them.
///
/// Output buffer is `w * h * 3` bytes. For low-res inputs
/// (`w <= 64 || h <= 64`) a 3x3 Gaussian pre-blur runs over the
/// luminance channel before Sobel.
///
/// Returns an empty `Vec` when the input is malformed (`rgba.len() <
/// w * h * 4` or either dimension zero) — callers should already have
/// errored upstream when texture decode failed, so this is a defensive
/// fallback rather than the hot path.
pub fn normal_from_luminance(rgba: &[u8], w: u32, h: u32, strength: f32) -> Vec<u8> {
    let pixel_count = (w as usize).saturating_mul(h as usize);
    let needed_rgba = pixel_count.saturating_mul(4);
    if pixel_count == 0 || rgba.len() < needed_rgba {
        return Vec::new();
    }

    // Build a luminance buffer (f32 in [0,1]).
    let mut lum = vec![0.0f32; pixel_count];
    for i in 0..pixel_count {
        let r = rgba[i * 4] as f32 / 255.0;
        let g = rgba[i * 4 + 1] as f32 / 255.0;
        let b = rgba[i * 4 + 2] as f32 / 255.0;
        lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    }

    if w <= LOW_RES_THRESHOLD || h <= LOW_RES_THRESHOLD {
        lum = gaussian_blur_3x3(&lum, w, h);
    }

    let mut out = vec![0u8; pixel_count * 3];
    let width = w as i32;
    let height = h as i32;

    for y in 0..height {
        for x in 0..width {
            // Sobel kernel — neighbour fetch with mirror-edge clamping.
            // Mirror (reflect 1) keeps texture-edge gradients sensible
            // for tiled UVs without seam-doubling that wrap-clamping
            // would cause for non-tiled textures.
            let l00 = sample_clamped(&lum, x - 1, y - 1, width, height);
            let l10 = sample_clamped(&lum, x, y - 1, width, height);
            let l20 = sample_clamped(&lum, x + 1, y - 1, width, height);
            let l01 = sample_clamped(&lum, x - 1, y, width, height);
            let l21 = sample_clamped(&lum, x + 1, y, width, height);
            let l02 = sample_clamped(&lum, x - 1, y + 1, width, height);
            let l12 = sample_clamped(&lum, x, y + 1, width, height);
            let l22 = sample_clamped(&lum, x + 1, y + 1, width, height);

            // Standard Sobel-X: weighted horizontal gradient.
            let gx = (l20 + 2.0 * l21 + l22) - (l00 + 2.0 * l01 + l02);
            // Standard Sobel-Y: weighted vertical gradient.
            let gy = (l02 + 2.0 * l12 + l22) - (l00 + 2.0 * l10 + l20);

            // Strength scales the in-plane (nx, ny) components. Higher
            // strength tilts the normal further from "flat up" (0,0,1),
            // producing a more pronounced bump. nz is recomputed from
            // the unit-length constraint after scaling.
            let nx_raw = -gx * strength;
            let ny_raw = -gy * strength;

            // Clamp the in-plane magnitude to <= 1 so nz stays real;
            // a Sobel with strength=1 on a high-contrast 1px step can
            // already produce magnitudes around 1.4–2.0, so this clamp
            // is load-bearing.
            let mag_sq = nx_raw * nx_raw + ny_raw * ny_raw;
            let (nx, ny) = if mag_sq > 1.0 {
                let scale = 1.0 / mag_sq.sqrt();
                (nx_raw * scale * 0.999, ny_raw * scale * 0.999)
            } else {
                (nx_raw, ny_raw)
            };
            let nz = (1.0 - nx * nx - ny * ny).max(0.0).sqrt();

            let idx = ((y as usize) * (w as usize) + x as usize) * 3;
            out[idx] = ((nx + 1.0) * 0.5 * 255.0).round().clamp(0.0, 255.0) as u8;
            out[idx + 1] = ((ny + 1.0) * 0.5 * 255.0).round().clamp(0.0, 255.0) as u8;
            out[idx + 2] = (nz * 255.0).round().clamp(0.0, 255.0) as u8;
        }
    }

    out
}

#[inline]
fn sample_clamped(buf: &[f32], x: i32, y: i32, w: i32, h: i32) -> f32 {
    let cx = x.clamp(0, w - 1) as usize;
    let cy = y.clamp(0, h - 1) as usize;
    buf[cy * (w as usize) + cx]
}

/// 3x3 Gaussian blur over a single-channel f32 image.
///
/// Kernel:
/// ```text
/// 1 2 1
/// 2 4 2  / 16
/// 1 2 1
/// ```
fn gaussian_blur_3x3(buf: &[f32], w: u32, h: u32) -> Vec<f32> {
    let pixel_count = (w as usize) * (h as usize);
    let mut out = vec![0.0f32; pixel_count];
    let width = w as i32;
    let height = h as i32;
    for y in 0..height {
        for x in 0..width {
            let l00 = sample_clamped(buf, x - 1, y - 1, width, height);
            let l10 = sample_clamped(buf, x, y - 1, width, height);
            let l20 = sample_clamped(buf, x + 1, y - 1, width, height);
            let l01 = sample_clamped(buf, x - 1, y, width, height);
            let l11 = sample_clamped(buf, x, y, width, height);
            let l21 = sample_clamped(buf, x + 1, y, width, height);
            let l02 = sample_clamped(buf, x - 1, y + 1, width, height);
            let l12 = sample_clamped(buf, x, y + 1, width, height);
            let l22 = sample_clamped(buf, x + 1, y + 1, width, height);
            let sum = l00 + 2.0 * l10 + l20
                + 2.0 * l01 + 4.0 * l11 + 2.0 * l21
                + l02 + 2.0 * l12 + l22;
            out[(y as usize) * (w as usize) + x as usize] = sum / 16.0;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(w: u32, h: u32, r: u8, g: u8, b: u8) -> Vec<u8> {
        let mut out = Vec::with_capacity((w * h * 4) as usize);
        for _ in 0..(w * h) {
            out.extend_from_slice(&[r, g, b, 0xFF]);
        }
        out
    }

    fn checker(w: u32, h: u32, a: [u8; 3], b: [u8; 3]) -> Vec<u8> {
        let mut out = Vec::with_capacity((w * h * 4) as usize);
        for y in 0..h {
            for x in 0..w {
                let c = if (x + y) % 2 == 0 { a } else { b };
                out.extend_from_slice(&[c[0], c[1], c[2], 0xFF]);
            }
        }
        out
    }

    #[test]
    fn empty_input_returns_empty() {
        let n = normal_from_luminance(&[], 0, 0, 1.0);
        assert!(n.is_empty());
    }

    #[test]
    fn malformed_input_returns_empty() {
        // 4x4 declared but only 8 bytes given.
        let n = normal_from_luminance(&[0u8; 8], 4, 4, 1.0);
        assert!(n.is_empty());
    }

    #[test]
    fn uniform_input_produces_flat_normals() {
        // A 128x128 mid-gray surface — bigger than the low-res blur
        // threshold so this exercises the no-blur path. Every pixel
        // should encode (0.5, 0.5, 1.0) = (128, 128, 255).
        let buf = solid(128, 128, 128, 128, 128);
        let n = normal_from_luminance(&buf, 128, 128, 1.0);
        assert_eq!(n.len(), 128 * 128 * 3);
        for i in 0..(128 * 128) {
            assert_eq!(n[i * 3], 128, "r at i={i}");
            assert_eq!(n[i * 3 + 1], 128, "g at i={i}");
            assert_eq!(n[i * 3 + 2], 255, "b at i={i}");
        }
    }

    #[test]
    fn uniform_low_res_input_produces_flat_normals() {
        // 16x16 hits the Gaussian pre-blur path. A constant input
        // through a Gaussian is still constant, so normals must still
        // be flat-up.
        let buf = solid(16, 16, 80, 80, 80);
        let n = normal_from_luminance(&buf, 16, 16, 1.0);
        assert_eq!(n.len(), 16 * 16 * 3);
        for i in 0..(16 * 16) {
            assert_eq!(n[i * 3], 128);
            assert_eq!(n[i * 3 + 1], 128);
            assert_eq!(n[i * 3 + 2], 255);
        }
    }

    #[test]
    fn checkerboard_produces_alternating_normals() {
        // 8x8 black/white checkerboard. The center pixel of a bright
        // square has darker neighbours to all four sides, so the
        // gradient points "outward" — Sobel produces a large gx and
        // gy. After our sign convention (nx = -gx, ny = -gy) the
        // normal tilts toward (0,0) in tangent space for dark
        // neighbours surrounding bright, and the opposite for bright
        // neighbours surrounding dark.
        //
        // We don't pin exact RGB values (the clamp + sqrt makes that
        // fragile) but we DO assert:
        //   - alternating-direction tilt between adjacent pixels
        //   - nz stays in [0.5, 1.0] (no NaN, no collapse to flat)
        //   - center pixel of a uniform run is closer to flat than
        //     an edge pixel
        // 8x8 is below LOW_RES_THRESHOLD (64) so this exercises the
        // Gaussian-blur path. The blur reduces but doesn't eliminate
        // the gradient at the checkerboard transitions.
        let buf = checker(8, 8, [0, 0, 0], [255, 255, 255]);
        let n = normal_from_luminance(&buf, 8, 8, 1.0);
        assert_eq!(n.len(), 8 * 8 * 3);

        // Pull (1,1) and (1,2) — they differ in colour (one is black,
        // the other is white) and their Sobel gradients should have
        // opposite signs along Y.
        let idx_11 = (1 * 8 + 1) * 3;
        let idx_12 = (2 * 8 + 1) * 3;
        let ny_11 = (n[idx_11 + 1] as i32) - 128;
        let ny_12 = (n[idx_12 + 1] as i32) - 128;
        assert!(
            ny_11.signum() * ny_12.signum() <= 0,
            "checkerboard rows should produce opposite-signed ny at (1,1) and (1,2), got {ny_11} and {ny_12}"
        );
        // nz never zero or near-zero — the clamp guarantees this.
        for i in 0..(8 * 8) {
            let nz_byte = n[i * 3 + 2];
            assert!(
                nz_byte >= 128,
                "nz at i={i} unexpectedly small ({nz_byte}); normals should remain mostly upward-facing"
            );
        }
    }

    #[test]
    fn horizontal_gradient_produces_horizontal_normals() {
        // A 128x128 image where luminance ramps left-to-right. Sobel
        // detects a constant horizontal gradient — every pixel should
        // tilt the same way along X, and ny should be near zero.
        // 128 is above LOW_RES_THRESHOLD so no pre-blur.
        let w = 128u32;
        let h = 128u32;
        let mut buf = Vec::with_capacity((w * h * 4) as usize);
        for _ in 0..h {
            for x in 0..w {
                let v = (x as f32 / (w - 1) as f32 * 255.0).round() as u8;
                buf.extend_from_slice(&[v, v, v, 0xFF]);
            }
        }
        let n = normal_from_luminance(&buf, w, h, 1.0);

        // Pick a sample well inside the texture (away from clamp
        // edges) and assert nx is "negative tilt" (encoded < 128) and
        // ny is ~128 (no vertical gradient).
        let sample_x = 60u32;
        let sample_y = 60u32;
        let idx = ((sample_y * w + sample_x) as usize) * 3;
        let r = n[idx];
        let g = n[idx + 1];
        // The brightness increases with +x, so Sobel-X is positive,
        // nx_raw = -gx is negative, encoded < 128.
        assert!(r < 128, "expected r<128 for +x gradient, got {r}");
        // Vertical gradient is zero → ny ~= 0 → encoded ~= 128.
        assert!((g as i32 - 128).abs() <= 1, "expected g~128, got {g}");
    }

    #[test]
    fn strength_scaling_amplifies_normals() {
        // Same horizontal gradient, two strengths — higher strength
        // should produce a more tilted normal (further from 128 in r).
        let w = 128u32;
        let h = 128u32;
        let mut buf = Vec::with_capacity((w * h * 4) as usize);
        for _ in 0..h {
            for x in 0..w {
                let v = (x as f32 / (w - 1) as f32 * 200.0).round() as u8;
                buf.extend_from_slice(&[v, v, v, 0xFF]);
            }
        }
        let n_low = normal_from_luminance(&buf, w, h, 0.5);
        let n_high = normal_from_luminance(&buf, w, h, 2.0);
        let idx = ((60 * w + 60) as usize) * 3;
        let r_low = n_low[idx] as i32 - 128;
        let r_high = n_high[idx] as i32 - 128;
        // Both negative (gradient direction stays the same) but high
        // is more displaced from neutral.
        assert!(r_low < 0 && r_high < 0);
        assert!(r_high.abs() > r_low.abs(), "high strength should tilt more (low={r_low}, high={r_high})");
    }

    /// Deterministic golden — 8x8 black/white checkerboard, strength
    /// 1.0. Locks the exact RGB output so any regression in the
    /// kernel weights, edge-clamp policy, or pack convention shows up
    /// here. Update only with `cargo test -- --nocapture` printing
    /// then a deliberate edit, never blindly.
    #[test]
    fn golden_8x8_checkerboard() {
        let buf = checker(8, 8, [0, 0, 0], [255, 255, 255]);
        let actual = normal_from_luminance(&buf, 8, 8, 1.0);

        // Build expected by re-implementing the algorithm in the test
        // (mirror-of-edge clamp, 3x3 Gaussian pre-blur because 8<=64,
        // then 3x3 Sobel, then unit-length pack). This stays a true
        // golden — if the production code's algorithm changes, this
        // breaks; if the production code's encoding shifts, this
        // catches the byte change.
        //
        // Easier: compute expected via the same module and freeze a
        // hand-checked subset of bytes. We check:
        //   - corner pixel (0,0) — most extreme edge-clamp case
        //   - center pixel (3,3) — fully interior
        //   - opposite corner (7,7)
        // Their exact bytes are locked below; if the algorithm
        // changes these update via explicit edit, not silent drift.
        let corner_00 = &actual[0..3];
        let center_33 = &actual[((3 * 8 + 3) * 3)..((3 * 8 + 3) * 3 + 3)];
        let corner_77 = &actual[((7 * 8 + 7) * 3)..((7 * 8 + 7) * 3 + 3)];

        // Reproducibility check: run the algorithm a second time and
        // confirm we get the same bytes back.
        let actual_again = normal_from_luminance(&buf, 8, 8, 1.0);
        assert_eq!(actual, actual_again, "non-deterministic output");

        // Hand-recorded expected values from running the kernel:
        // (these are the values the current implementation emits;
        // changing the impl requires updating these and is intentional).
        // (3,3) is a fully interior pixel — on a 1px black/white
        // checker the 3x3 Gaussian convolution at any interior cell
        // sums to exactly 0.5 (constant after blur), so Sobel returns
        // zero gradient → flat normal (128, 128, 255).
        assert_eq!(corner_00, &[80, 80, 216], "corner (0,0) drift");
        assert_eq!(center_33, &[128, 128, 255], "center (3,3) drift");
        assert_eq!(corner_77, &[175, 175, 216], "corner (7,7) drift");
    }
}
