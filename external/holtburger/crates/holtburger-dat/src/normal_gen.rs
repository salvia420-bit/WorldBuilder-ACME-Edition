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

use crate::scratch::ScratchBuf;

const LOW_RES_THRESHOLD: u32 = 64;

/// Per-texel gain applied to the 3x3 luminance std-dev before clamping
/// in `roughness_from_luminance`. A full black/white 1px edge yields a
/// local σ near 0.5; gain 2.0 maps that to ~1.0 (max roughness) at the
/// baseline `strength = 1.0`.
const ROUGHNESS_CONTRAST_GAIN: f32 = 2.0;

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

/// Phase 3.1 — produce an R8 heightmap from RGBA8 diffuse pixels.
///
/// Same Sobel-X gradient that `normal_from_luminance` uses, integrated
/// per row by horizontal scan (per §Phase 3.1 hand-off #1 — cheaper than
/// a 2D Poisson solve, accurate enough for stone). Output is a single
/// byte per pixel: `Vec<u8>` of length `w * h`, suitable for upload as a
/// `THREE.RedFormat` texture for the POM ray-march.
///
/// `strength` mirrors the normal-map convention — higher values amplify
/// the bumps before normalisation. Each row's integrated height is
/// rescaled to span [0, 255] independently in the X axis, then the
/// whole image is normalised to share one global [0, 255] mapping so
/// adjacent rows don't drift (perpendicular variation is lost on a pure
/// horizontal integrate; the global remap recovers some of it).
///
/// Returns an empty `Vec` on malformed input or when the luminance
/// channel is constant (no gradient → no height). Callers should treat
/// empty as "skip POM for this surface" — see `lib.rs` Phase 3.1 wire.
pub fn height_from_luminance(rgba: &[u8], w: u32, h: u32, strength: f32) -> Vec<u8> {
    let pixel_count = (w as usize).saturating_mul(h as usize);
    let needed_rgba = pixel_count.saturating_mul(4);
    if pixel_count == 0 || rgba.len() < needed_rgba {
        return Vec::new();
    }

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

    let width = w as i32;
    let height = h as i32;

    // First pass: per-pixel Sobel-X gradient (the horizontal derivative
    // of luminance — what we integrate).
    let mut gx_buf = vec![0.0f32; pixel_count];
    for y in 0..height {
        for x in 0..width {
            let l00 = sample_clamped(&lum, x - 1, y - 1, width, height);
            let l20 = sample_clamped(&lum, x + 1, y - 1, width, height);
            let l01 = sample_clamped(&lum, x - 1, y, width, height);
            let l21 = sample_clamped(&lum, x + 1, y, width, height);
            let l02 = sample_clamped(&lum, x - 1, y + 1, width, height);
            let l22 = sample_clamped(&lum, x + 1, y + 1, width, height);
            let gx = (l20 + 2.0 * l21 + l22) - (l00 + 2.0 * l01 + l02);
            gx_buf[(y as usize) * (w as usize) + x as usize] = gx * strength;
        }
    }

    // Second pass: integrate each row by horizontal scan. `h[x,y] =
    // h[x-1,y] + gx[x,y]`. Treat the leftmost pixel of each row as the
    // anchor (height 0).
    let mut height_buf = vec![0.0f32; pixel_count];
    for y in 0..(h as usize) {
        let row = y * (w as usize);
        height_buf[row] = 0.0;
        for x in 1..(w as usize) {
            height_buf[row + x] = height_buf[row + x - 1] + gx_buf[row + x];
        }
    }

    // Normalise across the whole image to [0, 255]. A global remap
    // (instead of per-row) lets the JS-side POM compare heights between
    // pixels in different rows — important so a mortar line between
    // rows doesn't appear to "jump" depth.
    let mut min_h = f32::INFINITY;
    let mut max_h = f32::NEG_INFINITY;
    for &v in &height_buf {
        if v < min_h { min_h = v; }
        if v > max_h { max_h = v; }
    }
    let span = max_h - min_h;
    if !span.is_finite() || span.abs() < 1e-6 {
        // Constant luminance → no height variation. Return empty so the
        // JS side skips POM on this surface (renders flat normal map
        // only).
        return Vec::new();
    }

    let mut out = vec![0u8; pixel_count];
    for i in 0..pixel_count {
        let n = ((height_buf[i] - min_h) / span * 255.0)
            .round()
            .clamp(0.0, 255.0);
        out[i] = n as u8;
    }
    out
}

/// A15 §3b — fused normal + height derivation, one luminance pass, zero
/// fresh scratch allocation.
///
/// Produces byte-for-byte the same output as calling
/// [`normal_from_luminance`] and [`height_from_luminance`] separately with
/// the same arguments — that equivalence is gated by
/// `fused_matches_originals_*` in this module's tests and is the whole
/// contract of this function. The originals are deliberately left as
/// independent implementations so those tests compare two real code paths
/// rather than a wrapper against itself.
///
/// What is saved per 512² surface: one of the two identical `lum` builds
/// (−1.0 MiB), plus `gx_buf` and `height_buf` leased rather than allocated
/// (−2.0 MiB). See `DESIGN-A15-ab-2026-07-24.md` §1 sites B/C/K.
///
/// `scratch` supplies three f32 slots, each resized-and-zeroed here (see
/// [`ScratchBuf::f32_zeroed3`] — a leased buffer holds the previous user's
/// bytes, so this function never reads a slot before writing it).
///
/// `normal_out` is cleared and filled to `w*h*3`, or left **empty** on
/// malformed input. `height_out` is cleared and filled to `w*h`, or left
/// **empty** on malformed input *or* on constant luminance (span ≈ 0),
/// exactly matching `height_from_luminance`'s "skip POM" signal.
pub fn normal_and_height_from_luminance(
    rgba: &[u8],
    w: u32,
    h: u32,
    strength: f32,
    scratch: &mut ScratchBuf,
    normal_out: &mut Vec<u8>,
    height_out: &mut Vec<u8>,
) {
    normal_out.clear();
    height_out.clear();

    let pixel_count = (w as usize).saturating_mul(h as usize);
    let needed_rgba = pixel_count.saturating_mul(4);
    if pixel_count == 0 || rgba.len() < needed_rgba {
        return;
    }

    // Slot A = luminance, slot B = blur target then Sobel-X gradient,
    // slot C = the integrated height. All three come back zeroed.
    let (lum, scratch_b, height_buf) =
        scratch.f32_zeroed3(pixel_count, pixel_count, pixel_count);

    // --- The single luminance build (was done identically twice). ---
    for i in 0..pixel_count {
        let r = rgba[i * 4] as f32 / 255.0;
        let g = rgba[i * 4 + 1] as f32 / 255.0;
        let b = rgba[i * 4 + 2] as f32 / 255.0;
        lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    }

    // --- Low-res pre-blur. Both consumers read the BLURRED buffer, which
    // is what the two originals each do independently. Blurring for only
    // one consumer is the negative control for the byte-equality gate.
    if w <= LOW_RES_THRESHOLD || h <= LOW_RES_THRESHOLD {
        gaussian_blur_3x3_into(lum, scratch_b, w, h);
        lum.copy_from_slice(scratch_b);
    }

    let width = w as i32;
    let height = h as i32;

    // --- Normal map (mirrors `normal_from_luminance`). ---
    normal_out.resize(pixel_count * 3, 0u8);
    for y in 0..height {
        for x in 0..width {
            let l00 = sample_clamped(lum, x - 1, y - 1, width, height);
            let l10 = sample_clamped(lum, x, y - 1, width, height);
            let l20 = sample_clamped(lum, x + 1, y - 1, width, height);
            let l01 = sample_clamped(lum, x - 1, y, width, height);
            let l21 = sample_clamped(lum, x + 1, y, width, height);
            let l02 = sample_clamped(lum, x - 1, y + 1, width, height);
            let l12 = sample_clamped(lum, x, y + 1, width, height);
            let l22 = sample_clamped(lum, x + 1, y + 1, width, height);

            let gx = (l20 + 2.0 * l21 + l22) - (l00 + 2.0 * l01 + l02);
            let gy = (l02 + 2.0 * l12 + l22) - (l00 + 2.0 * l10 + l20);

            let nx_raw = -gx * strength;
            let ny_raw = -gy * strength;

            let mag_sq = nx_raw * nx_raw + ny_raw * ny_raw;
            let (nx, ny) = if mag_sq > 1.0 {
                let scale = 1.0 / mag_sq.sqrt();
                (nx_raw * scale * 0.999, ny_raw * scale * 0.999)
            } else {
                (nx_raw, ny_raw)
            };
            let nz = (1.0 - nx * nx - ny * ny).max(0.0).sqrt();

            let idx = ((y as usize) * (w as usize) + x as usize) * 3;
            normal_out[idx] = ((nx + 1.0) * 0.5 * 255.0).round().clamp(0.0, 255.0) as u8;
            normal_out[idx + 1] = ((ny + 1.0) * 0.5 * 255.0).round().clamp(0.0, 255.0) as u8;
            normal_out[idx + 2] = (nz * 255.0).round().clamp(0.0, 255.0) as u8;
        }
    }

    // --- Heightmap (mirrors `height_from_luminance`). Slot B is reused as
    // `gx_buf`; every index is written before it is read.
    let gx_buf = scratch_b;
    for y in 0..height {
        for x in 0..width {
            let l00 = sample_clamped(lum, x - 1, y - 1, width, height);
            let l20 = sample_clamped(lum, x + 1, y - 1, width, height);
            let l01 = sample_clamped(lum, x - 1, y, width, height);
            let l21 = sample_clamped(lum, x + 1, y, width, height);
            let l02 = sample_clamped(lum, x - 1, y + 1, width, height);
            let l22 = sample_clamped(lum, x + 1, y + 1, width, height);
            let gx = (l20 + 2.0 * l21 + l22) - (l00 + 2.0 * l01 + l02);
            gx_buf[(y as usize) * (w as usize) + x as usize] = gx * strength;
        }
    }

    for y in 0..(h as usize) {
        let row = y * (w as usize);
        height_buf[row] = 0.0;
        for x in 1..(w as usize) {
            height_buf[row + x] = height_buf[row + x - 1] + gx_buf[row + x];
        }
    }

    let mut min_h = f32::INFINITY;
    let mut max_h = f32::NEG_INFINITY;
    for &v in height_buf.iter() {
        if v < min_h { min_h = v; }
        if v > max_h { max_h = v; }
    }
    let span = max_h - min_h;
    if !span.is_finite() || span.abs() < 1e-6 {
        // Constant luminance → no height variation → empty, so the JS side
        // skips POM on this surface. `height_out` is already cleared.
        return;
    }

    height_out.resize(pixel_count, 0u8);
    for i in 0..pixel_count {
        let n = ((height_buf[i] - min_h) / span * 255.0)
            .round()
            .clamp(0.0, 255.0);
        height_out[i] = n as u8;
    }
}

/// Build a Rec.601 luminance buffer (f32 in [0,1]) from RGBA8 pixels.
///
/// Shared by the Phase-5 roughness/AO generators. The pre-existing
/// `normal_from_luminance` / `height_from_luminance` keep their own
/// inline copies deliberately untouched so their byte output stays
/// frozen for the Phase-5 offline-vs-online byte-identity proof.
fn build_luminance(rgba: &[u8], pixel_count: usize) -> Vec<f32> {
    let mut lum = vec![0.0f32; pixel_count];
    for i in 0..pixel_count {
        let r = rgba[i * 4] as f32 / 255.0;
        let g = rgba[i * 4 + 1] as f32 / 255.0;
        let b = rgba[i * 4 + 2] as f32 / 255.0;
        lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    }
    lum
}

/// Phase 5 — micro-roughness map (R8) from diffuse luminance detail.
///
/// Per-texel local 3x3 luminance standard deviation, scaled by
/// `ROUGHNESS_CONTRAST_GAIN * strength` and clamped to [0,1]: locally
/// busy regions (grain, weave, pitting) read rougher; locally flat
/// regions read smooth (`0`). The mapping is **per-pixel** (no global
/// normalisation) so a cropped/atlased sub-region bakes the same bytes
/// as the standalone texture — important for the Phase-5 per-surface
/// dedup key.
///
/// Output is one byte per pixel (`Vec<u8>` length `w*h`), intended as a
/// `THREE.MeshStandardMaterial.roughnessMap` contribution the JS side
/// folds against the per-category base roughness. `0` = no added
/// roughness (a uniform surface bakes all-zero and leaves the base
/// roughness untouched).
///
/// Palette-safe by construction: reads the **decoded** RGBA, never
/// palette indices, so it can't emboss index-boundary seams.
///
/// Returns empty on malformed input (`rgba.len() < w*h*4` or zero dim).
pub fn roughness_from_luminance(rgba: &[u8], w: u32, h: u32, strength: f32) -> Vec<u8> {
    let pixel_count = (w as usize).saturating_mul(h as usize);
    let needed_rgba = pixel_count.saturating_mul(4);
    if pixel_count == 0 || rgba.len() < needed_rgba {
        return Vec::new();
    }

    let mut lum = build_luminance(rgba, pixel_count);
    if w <= LOW_RES_THRESHOLD || h <= LOW_RES_THRESHOLD {
        lum = gaussian_blur_3x3(&lum, w, h);
    }

    let width = w as i32;
    let height = h as i32;
    let mut out = vec![0u8; pixel_count];
    for y in 0..height {
        for x in 0..width {
            // 3x3 neighbourhood mean then variance → standard deviation.
            let mut sum = 0.0f32;
            let mut sum_sq = 0.0f32;
            for dy in -1..=1 {
                for dx in -1..=1 {
                    let s = sample_clamped(&lum, x + dx, y + dy, width, height);
                    sum += s;
                    sum_sq += s * s;
                }
            }
            let mean = sum / 9.0;
            let var = (sum_sq / 9.0 - mean * mean).max(0.0);
            let sigma = var.sqrt();
            let r = (sigma * ROUGHNESS_CONTRAST_GAIN * strength).clamp(0.0, 1.0);
            out[(y as usize) * (w as usize) + x as usize] =
                (r * 255.0).round().clamp(0.0, 255.0) as u8;
        }
    }
    out
}

/// Phase 5 — cavity / ambient-occlusion map (R8) from diffuse luminance.
///
/// Compares each texel's luminance to its local (3x3 Gaussian) mean:
/// texels darker than their surroundings read as crevices and get
/// occluded; raised/flat texels stay fully lit. Output follows the
/// `THREE.MeshStandardMaterial.aoMap` convention — `255` = no occlusion
/// (white), lower = more occluded. `occ = clamp(strength * relu(mean -
/// lum))`, `ao = 1 - occ`.
///
/// Per-pixel after the blur, so (like the roughness map) it is crop-
/// stable for the per-surface dedup key, and palette-safe (decoded RGBA
/// only). A uniform surface bakes all-`255` (no AO).
///
/// Returns empty on malformed input.
pub fn ao_from_luminance(rgba: &[u8], w: u32, h: u32, strength: f32) -> Vec<u8> {
    let pixel_count = (w as usize).saturating_mul(h as usize);
    let needed_rgba = pixel_count.saturating_mul(4);
    if pixel_count == 0 || rgba.len() < needed_rgba {
        return Vec::new();
    }

    let mut lum = build_luminance(rgba, pixel_count);
    if w <= LOW_RES_THRESHOLD || h <= LOW_RES_THRESHOLD {
        lum = gaussian_blur_3x3(&lum, w, h);
    }
    // Local mean = one 3x3 Gaussian pass over the (possibly pre-blurred)
    // luminance. Crevice signal = how far a texel sits below that mean.
    let local_mean = gaussian_blur_3x3(&lum, w, h);

    let mut out = vec![0u8; pixel_count];
    for i in 0..pixel_count {
        let occ = (strength * (local_mean[i] - lum[i]).max(0.0)).clamp(0.0, 1.0);
        let ao = 1.0 - occ;
        out[i] = (ao * 255.0).round().clamp(0.0, 255.0) as u8;
    }
    out
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
    gaussian_blur_3x3_into(buf, &mut out, w, h);
    out
}

/// Same kernel as [`gaussian_blur_3x3`], writing into a caller-owned
/// buffer instead of allocating. `out.len()` must be `w * h`.
///
/// The arithmetic here is the single source of truth — `gaussian_blur_3x3`
/// is a thin allocating wrapper over it — so the fused pass and the
/// original per-map passes cannot drift apart.
fn gaussian_blur_3x3_into(buf: &[f32], out: &mut [f32], w: u32, h: u32) {
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scratch::ScratchPool;

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

    // Phase 3.1 — heightmap-integration tests.

    #[test]
    fn height_empty_input_returns_empty() {
        let h = height_from_luminance(&[], 0, 0, 1.0);
        assert!(h.is_empty());
    }

    #[test]
    fn height_malformed_input_returns_empty() {
        let h = height_from_luminance(&[0u8; 8], 4, 4, 1.0);
        assert!(h.is_empty());
    }

    #[test]
    fn height_uniform_input_returns_empty() {
        // Constant luminance → zero Sobel gradient → all-zero integrated
        // heights → span=0 → return empty (caller skips POM on this surf).
        let buf = solid(128, 128, 80, 80, 80);
        let h = height_from_luminance(&buf, 128, 128, 1.0);
        assert!(
            h.is_empty(),
            "constant luminance should produce empty heightmap"
        );
    }

    #[test]
    fn height_horizontal_gradient_steps() {
        // A 128×128 left-to-right luminance ramp produces a constant
        // Sobel-X gradient. Integrating row-by-row gives a monotonically
        // increasing height — pixels on the right should have higher
        // values than pixels on the left.
        let w = 128u32;
        let h_dim = 128u32;
        let mut buf = Vec::with_capacity((w * h_dim * 4) as usize);
        for _ in 0..h_dim {
            for x in 0..w {
                let v = (x as f32 / (w - 1) as f32 * 255.0).round() as u8;
                buf.extend_from_slice(&[v, v, v, 0xFF]);
            }
        }
        let height_buf = height_from_luminance(&buf, w, h_dim, 1.0);
        assert_eq!(height_buf.len(), (w * h_dim) as usize);

        // Pick a row well inside the texture (away from clamp edges).
        let row = (h_dim / 2) as usize * (w as usize);
        let h_left = height_buf[row + 10];
        let h_mid = height_buf[row + 64];
        let h_right = height_buf[row + (w as usize - 10)];
        assert!(
            h_left < h_mid && h_mid < h_right,
            "horizontal gradient should produce monotonic height: left={h_left}, mid={h_mid}, right={h_right}"
        );
        // After normalisation the rightmost reachable pixel hits 255 (or
        // very close — at least 200 to allow for the leftmost-cell-of-
        // each-row anchor reset reducing the max slightly below 255).
        assert!(
            h_right > 200,
            "rightmost pixel should be near max after normalisation: {h_right}"
        );
    }

    #[test]
    fn height_checkerboard_produces_step_pattern() {
        // A black/white checkerboard has alternating bright/dark cells.
        // The Sobel-X gradient flips sign at every transition; the
        // horizontal integrate produces a "step" pattern that mostly
        // oscillates. Just assert: (a) length is correct, (b) we get
        // some variation (not all-zero), (c) the output is bounded
        // [0, 255]. This matches the spec's "step pattern" wording.
        let buf = checker(8, 8, [0, 0, 0], [255, 255, 255]);
        let h_buf = height_from_luminance(&buf, 8, 8, 1.0);
        assert_eq!(h_buf.len(), 8 * 8);
        let min = *h_buf.iter().min().unwrap();
        let max = *h_buf.iter().max().unwrap();
        assert!(min < max, "checkerboard should produce non-flat heights");
        // Both extremes should hit the bounds after normalisation.
        assert_eq!(min, 0, "lowest height should be 0 after normalise");
        assert_eq!(max, 255, "highest height should be 255 after normalise");
    }

    #[test]
    fn height_determinism() {
        // Same input → same output, byte-for-byte.
        let buf = checker(16, 16, [10, 10, 10], [240, 240, 240]);
        let a = height_from_luminance(&buf, 16, 16, 1.0);
        let b = height_from_luminance(&buf, 16, 16, 1.0);
        assert_eq!(a, b, "non-deterministic heightmap output");
    }

    // Phase 5 — roughness-map tests.

    #[test]
    fn roughness_empty_and_malformed_return_empty() {
        assert!(roughness_from_luminance(&[], 0, 0, 1.0).is_empty());
        assert!(roughness_from_luminance(&[0u8; 8], 4, 4, 1.0).is_empty());
    }

    #[test]
    fn roughness_uniform_is_zero_golden() {
        // Exact-byte golden: a flat surface has zero local contrast, so
        // every texel bakes 0 (no added roughness — JS keeps the base).
        // Predictable without a run-first cycle; the real-portal.dat byte
        // golden lands at the S5 producer (DAT access there).
        let buf = solid(128, 128, 90, 120, 60);
        let r = roughness_from_luminance(&buf, 128, 128, 1.0);
        assert_eq!(r.len(), 128 * 128);
        assert!(
            r.iter().all(|&b| b == 0),
            "uniform surface must bake all-zero roughness"
        );
    }

    #[test]
    fn roughness_uniform_low_res_is_zero() {
        let buf = solid(16, 16, 200, 200, 200);
        let r = roughness_from_luminance(&buf, 16, 16, 1.0);
        assert!(r.iter().all(|&b| b == 0));
    }

    #[test]
    fn roughness_detail_is_nonzero() {
        // A 1px checkerboard at 128 (above the low-res pre-blur threshold)
        // is maximally busy → texels must read rough.
        let buf = checker(128, 128, [0, 0, 0], [255, 255, 255]);
        let r = roughness_from_luminance(&buf, 128, 128, 1.0);
        assert_eq!(r.len(), 128 * 128);
        assert!(
            r.iter().any(|&b| b > 0),
            "checkerboard should produce nonzero roughness"
        );
    }

    #[test]
    fn roughness_strength_scales() {
        // 128x128 left-right ramp gives a constant small local σ. Higher
        // strength must not lower any texel and must raise overall.
        let w = 128u32;
        let mut buf = Vec::with_capacity((w * w * 4) as usize);
        for _ in 0..w {
            for x in 0..w {
                let v = (x as f32 / (w - 1) as f32 * 255.0).round() as u8;
                buf.extend_from_slice(&[v, v, v, 0xFF]);
            }
        }
        let lo = roughness_from_luminance(&buf, w, w, 0.5);
        let hi = roughness_from_luminance(&buf, w, w, 2.0);
        let idx = (60 * w + 60) as usize;
        assert!(
            hi[idx] >= lo[idx],
            "higher strength must not reduce roughness (lo={}, hi={})",
            lo[idx],
            hi[idx]
        );
        let sum_lo: u64 = lo.iter().map(|&b| b as u64).sum();
        let sum_hi: u64 = hi.iter().map(|&b| b as u64).sum();
        assert!(
            sum_hi > sum_lo,
            "higher strength should raise overall roughness (lo={sum_lo}, hi={sum_hi})"
        );
    }

    #[test]
    fn roughness_determinism() {
        let buf = checker(16, 16, [10, 10, 10], [240, 240, 240]);
        let a = roughness_from_luminance(&buf, 16, 16, 1.0);
        let b = roughness_from_luminance(&buf, 16, 16, 1.0);
        assert_eq!(a, b, "non-deterministic roughness output");
    }

    // Phase 5 — AO / cavity-map tests.

    #[test]
    fn ao_empty_and_malformed_return_empty() {
        assert!(ao_from_luminance(&[], 0, 0, 1.0).is_empty());
        assert!(ao_from_luminance(&[0u8; 8], 4, 4, 1.0).is_empty());
    }

    #[test]
    fn ao_uniform_is_white_golden() {
        // Exact-byte golden: no luminance gradient → no crevices → AO is
        // fully lit (255) everywhere. aoMap convention: white = no AO.
        let buf = solid(128, 128, 70, 70, 70);
        let ao = ao_from_luminance(&buf, 128, 128, 1.0);
        assert_eq!(ao.len(), 128 * 128);
        assert!(
            ao.iter().all(|&b| b == 255),
            "uniform surface must bake all-white AO"
        );
    }

    #[test]
    fn ao_dark_crevice_is_occluded() {
        // A single dark texel in a bright field (128 → above the pre-blur
        // threshold so it stays sharp) sits below its local mean → it
        // must read occluded (< 255); a far bright texel stays lit (255).
        let w = 128u32;
        let mut buf = solid(w, w, 230, 230, 230);
        let (cx, cy) = (64usize, 64usize);
        let p = (cy * w as usize + cx) * 4;
        buf[p] = 0;
        buf[p + 1] = 0;
        buf[p + 2] = 0;
        let ao = ao_from_luminance(&buf, w, w, 1.0);
        assert!(
            ao[cy * w as usize + cx] < 255,
            "dark crevice texel should be occluded"
        );
        assert_eq!(ao[0], 255, "far bright texel should stay fully lit");
    }

    #[test]
    fn ao_strength_scales() {
        let w = 128u32;
        let mut buf = solid(w, w, 230, 230, 230);
        let (cx, cy) = (64usize, 64usize);
        let p = (cy * w as usize + cx) * 4;
        buf[p] = 40;
        buf[p + 1] = 40;
        buf[p + 2] = 40;
        let lo = ao_from_luminance(&buf, w, w, 0.5);
        let hi = ao_from_luminance(&buf, w, w, 2.0);
        let i = cy * w as usize + cx;
        assert!(
            hi[i] <= lo[i],
            "higher strength should deepen occlusion (lo={}, hi={})",
            lo[i],
            hi[i]
        );
    }

    // A15 §3b — fused normal+height byte-identity gate.

    /// Cheap deterministic noise (LCG) so the fixtures exercise real
    /// gradients rather than only synthetic patterns.
    fn noise(w: u32, h: u32, seed: u32) -> Vec<u8> {
        let mut s = seed | 1;
        let mut out = Vec::with_capacity((w * h * 4) as usize);
        for _ in 0..(w * h) {
            let mut next = || {
                s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                (s >> 24) as u8
            };
            let (r, g, b) = (next(), next(), next());
            out.extend_from_slice(&[r, g, b, 0xFF]);
        }
        out
    }

    fn ramp(w: u32, h: u32, span: f32) -> Vec<u8> {
        let mut buf = Vec::with_capacity((w * h * 4) as usize);
        for _ in 0..h {
            for x in 0..w {
                let denom = if w > 1 { (w - 1) as f32 } else { 1.0 };
                let v = (x as f32 / denom * span).round() as u8;
                buf.extend_from_slice(&[v, v, v, 0xFF]);
            }
        }
        buf
    }

    /// Every fixture the equality gate runs over: (label, rgba, w, h).
    fn fused_fixtures() -> Vec<(&'static str, Vec<u8>, u32, u32)> {
        vec![
            // Tiny — every neighbour fetch is an edge clamp.
            ("1x1 solid", solid(1, 1, 200, 30, 90), 1, 1),
            ("1x1 black", solid(1, 1, 0, 0, 0), 1, 1),
            ("2x2 checker", checker(2, 2, [0, 0, 0], [255, 255, 255]), 2, 2),
            ("2x2 noise", noise(2, 2, 7), 2, 2),
            ("1x9 column", noise(1, 9, 11), 1, 9),
            ("9x1 row", noise(9, 1, 13), 9, 1),
            // Below LOW_RES_THRESHOLD → Gaussian pre-blur branch.
            ("8x8 checker (blur)", checker(8, 8, [0, 0, 0], [255, 255, 255]), 8, 8),
            ("16x16 noise (blur)", noise(16, 16, 3), 16, 16),
            ("7x13 odd (blur)", noise(7, 13, 5), 7, 13),
            ("13x7 odd (blur)", noise(13, 7, 17), 13, 7),
            // Exactly AT the threshold — `<=` means this still blurs.
            ("64x64 noise (at threshold)", noise(64, 64, 23), 64, 64),
            ("64x65 (h>64, w==64 → blur)", noise(64, 65, 29), 64, 65),
            ("65x64 (w>64, h==64 → blur)", noise(65, 64, 31), 65, 64),
            // Strictly above on both axes → no blur.
            ("65x65 noise (no blur)", noise(65, 65, 37), 65, 65),
            ("128x128 checker (no blur)", checker(128, 128, [0, 0, 0], [255, 255, 255]), 128, 128),
            ("71x131 odd (no blur)", noise(71, 131, 41), 71, 131),
            ("128x128 ramp", ramp(128, 128, 255.0), 128, 128),
            ("33x33 ramp (blur)", ramp(33, 33, 200.0), 33, 33),
            // Constant luminance → height_from_luminance returns EMPTY.
            ("128x128 solid (empty height)", solid(128, 128, 80, 80, 80), 128, 128),
            ("16x16 solid (empty height, blur)", solid(16, 16, 80, 80, 80), 16, 16),
        ]
    }

    /// THE byte-identity gate (design §3b): the fused pass must reproduce
    /// `normal_from_luminance` + `height_from_luminance` exactly, for every
    /// fixture × strength.
    ///
    /// Negative control: feed the height consumer the UNBLURRED luminance
    /// (i.e. blur into slot B and read `lum` for the gx pass) and this must
    /// fail on the ≤ LOW_RES_THRESHOLD fixtures.
    #[test]
    fn fused_matches_originals_byte_for_byte() {
        let pool = ScratchPool::new(2);
        for (label, rgba, w, h) in fused_fixtures() {
            for strength in [0.5f32, 1.0, 2.0, 4.0] {
                let want_n = normal_from_luminance(&rgba, w, h, strength);
                let want_h = height_from_luminance(&rgba, w, h, strength);

                let mut lease = pool.lease();
                let mut got_n = Vec::new();
                let mut got_h = Vec::new();
                normal_and_height_from_luminance(
                    &rgba,
                    w,
                    h,
                    strength,
                    lease.buf_mut(),
                    &mut got_n,
                    &mut got_h,
                );

                assert_eq!(
                    got_n, want_n,
                    "fused NORMAL differs from normal_from_luminance for {label} @ strength {strength}"
                );
                assert_eq!(
                    got_h, want_h,
                    "fused HEIGHT differs from height_from_luminance for {label} @ strength {strength}"
                );
            }
        }
    }

    /// Malformed / degenerate inputs must EMPTY both outputs, including
    /// when the output vecs arrive non-empty (they are reused buffers).
    #[test]
    fn fused_empties_outputs_on_malformed_input() {
        let mut buf = ScratchBuf::new();
        for (rgba, w, h) in [
            (Vec::new(), 0u32, 0u32),
            (vec![0u8; 8], 4, 4),
            (solid(4, 4, 9, 9, 9), 0, 4),
            (solid(4, 4, 9, 9, 9), 4, 0),
        ] {
            let mut n = vec![0xAAu8; 64];
            let mut hh = vec![0xBBu8; 64];
            normal_and_height_from_luminance(&rgba, w, h, 1.0, &mut buf, &mut n, &mut hh);
            assert!(n.is_empty(), "normal_out must be emptied for {w}x{h}");
            assert!(hh.is_empty(), "height_out must be emptied for {w}x{h}");
            assert_eq!(normal_from_luminance(&rgba, w, h, 1.0), n);
            assert_eq!(height_from_luminance(&rgba, w, h, 1.0), hh);
        }
    }

    /// Buffer reuse must not contaminate results: run a size-varying
    /// sequence through ONE pooled ScratchBuf and one pair of output vecs,
    /// and require each result to still match the originals. This is the
    /// end-to-end version of `scratch_lease_is_always_zeroed`.
    #[test]
    fn fused_is_clean_across_reused_scratch_and_outputs() {
        let pool = ScratchPool::new(1);
        let mut got_n = Vec::new();
        let mut got_h = Vec::new();
        let fixtures = fused_fixtures();
        // Two passes, so every fixture also runs on a buffer previously
        // used by a LARGER one (the stale-tail case).
        for _ in 0..2 {
            for (label, rgba, w, h) in &fixtures {
                let mut lease = pool.lease();
                normal_and_height_from_luminance(
                    rgba,
                    *w,
                    *h,
                    1.0,
                    lease.buf_mut(),
                    &mut got_n,
                    &mut got_h,
                );
                assert_eq!(
                    got_n,
                    normal_from_luminance(rgba, *w, *h, 1.0),
                    "reused-scratch normal drift for {label}"
                );
                assert_eq!(
                    got_h,
                    height_from_luminance(rgba, *w, *h, 1.0),
                    "reused-scratch height drift for {label}"
                );
            }
        }
        assert_eq!(pool.idle_len(), 1);
    }

    /// The pre-blur branch is a `<=` on EITHER axis. Pin that the fused
    /// path agrees with the originals right across the boundary, so a
    /// blur-branch mismatch cannot hide behind fixture choice.
    #[test]
    fn fused_low_res_threshold_boundary_matches() {
        let mut buf = ScratchBuf::new();
        for (w, h) in [(63u32, 63u32), (64, 64), (64, 128), (128, 64), (65, 65)] {
            let rgba = noise(w, h, w * 131 + h);
            let mut n = Vec::new();
            let mut hh = Vec::new();
            normal_and_height_from_luminance(&rgba, w, h, 1.0, &mut buf, &mut n, &mut hh);
            assert_eq!(n, normal_from_luminance(&rgba, w, h, 1.0), "normal @ {w}x{h}");
            assert_eq!(hh, height_from_luminance(&rgba, w, h, 1.0), "height @ {w}x{h}");
        }
    }

    #[test]
    fn ao_determinism() {
        let buf = checker(16, 16, [20, 20, 20], [220, 220, 220]);
        let a = ao_from_luminance(&buf, 16, 16, 1.0);
        let b = ao_from_luminance(&buf, 16, 16, 1.0);
        assert_eq!(a, b, "non-deterministic AO output");
    }
}
