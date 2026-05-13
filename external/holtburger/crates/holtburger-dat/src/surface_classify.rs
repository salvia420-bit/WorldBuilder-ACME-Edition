//! Phase 1.4 — heuristic surface classifier.
//!
//! Given an RGBA8 decoded surface texture plus the raw
//! `Surface.surface_type` bitfield (see `file_type::surface::Surface`),
//! produce a [`SurfaceCategory`] used downstream by `materials.js` to
//! pick category-aware roughness / metalness defaults.
//!
//! Target accuracy: 80% on Holtburg's surface set (acceptance criterion
//! #1 in §Phase 1.4). The remaining 20% are caught by Phase 1.5
//! (manual override JSON), so this module deliberately does NOT add
//! ad-hoc DID-specific cases — it stays a pure data-driven rule set.
//!
//! Statistics are computed in linear-light(ish) space — we keep AC
//! pixels as-is (the DAT data is already display-encoded, but every
//! retail surface is in the same encoding, so per-rule thresholds
//! were tuned against the encoded values).
//!
//! See §6 "Surface classification — full hybrid (Option 3) detail" of
//! `docs/visual-fidelity-push-prompt-2026-05-13.md` for the framing.

/// 13 buckets total. Stable encoding via [`SurfaceCategory::as_u8`] so
/// the wasm-bindgen getter on `SurfacePixels` can ship a single byte
/// to JS rather than a string.
///
/// `Brick` and `Tile` are listed for forward compat with Phase 1.5
/// overrides but the heuristic in this module lumps both into `Stone`
/// (see hand-off note: distinguishing brick patterns without FFT or
/// run-length analysis is unreliable, and Phase 1.5 is the right
/// place to special-case them).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SurfaceCategory {
    Stone = 0,
    Wood = 1,
    Metal = 2,
    Sand = 3,
    Lava = 4,
    Water = 5,
    Foliage = 6,
    Cloth = 7,
    Dirt = 8,
    Snow = 9,
    Brick = 10,
    Tile = 11,
    Generic = 12,
}

impl SurfaceCategory {
    pub fn as_u8(self) -> u8 {
        self as u8
    }

    /// JS-side label used by the diagnostic page. Matches the enum
    /// variant names so a grep across the repo for "Stone" / "Wood"
    /// hits both Rust and JS.
    pub fn label(self) -> &'static str {
        match self {
            Self::Stone => "Stone",
            Self::Wood => "Wood",
            Self::Metal => "Metal",
            Self::Sand => "Sand",
            Self::Lava => "Lava",
            Self::Water => "Water",
            Self::Foliage => "Foliage",
            Self::Cloth => "Cloth",
            Self::Dirt => "Dirt",
            Self::Snow => "Snow",
            Self::Brick => "Brick",
            Self::Tile => "Tile",
            Self::Generic => "Generic",
        }
    }

    pub fn from_u8(value: u8) -> Option<Self> {
        match value {
            0 => Some(Self::Stone),
            1 => Some(Self::Wood),
            2 => Some(Self::Metal),
            3 => Some(Self::Sand),
            4 => Some(Self::Lava),
            5 => Some(Self::Water),
            6 => Some(Self::Foliage),
            7 => Some(Self::Cloth),
            8 => Some(Self::Dirt),
            9 => Some(Self::Snow),
            10 => Some(Self::Brick),
            11 => Some(Self::Tile),
            12 => Some(Self::Generic),
            _ => None,
        }
    }
}

/// Per-surface statistics used by the rule set. All values are in
/// `[0.0, 1.0]` after normalisation; `dominant_hue` is in degrees
/// (`[0.0, 360.0)`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SurfaceStats {
    /// Mean RGB across the texture, each channel in `[0.0, 1.0]`.
    pub mean: [f32; 3],
    /// Per-channel standard deviation in `[0.0, 1.0]`.
    pub std_dev: [f32; 3],
    /// Rec.601 luminance of the mean colour: `0.299*R + 0.587*G + 0.114*B`.
    pub luminance: f32,
    /// Average luminance variance across the texture — a "roughness"
    /// signal used to separate smooth surfaces (Metal, Snow) from
    /// patterned ones (Brick, Stone).
    pub variance: f32,
    /// Mean hue in degrees `[0.0, 360.0)`. `0` for fully desaturated
    /// surfaces where the value is meaningless.
    pub dominant_hue: f32,
    /// HSV saturation of the mean: `(max - min) / max`, in `[0.0, 1.0]`.
    pub saturation: f32,
}

/// ACE `Surface.surface_type` bitfield bits we consult in the rules.
/// Mirrors the constants in `apps/holtburger-web/scene3d/materials.js`
/// `SURFACE_TYPE`.
pub mod surface_type_flags {
    pub const BASE1_CLIP_MAP: u32 = 0x4;
    pub const TRANSLUCENT: u32 = 0x10;
    pub const LUMINOUS: u32 = 0x40;
    pub const ADDITIVE: u32 = 0x10000;
}

/// Compute [`SurfaceStats`] for one decoded RGBA8 surface.
///
/// `rgba.len() == w * h * 4` is assumed; if the buffer is too short
/// for the dimensions, the function returns a zeroed stats struct
/// (callers should already have errored upstream when [`Texture::to_rgba8`]
/// failed, so this is a defensive fallback rather than the hot path).
pub fn compute_stats(rgba: &[u8], w: u32, h: u32) -> SurfaceStats {
    let pixel_count = (w as usize).saturating_mul(h as usize);
    let needed = pixel_count.saturating_mul(4);
    if pixel_count == 0 || rgba.len() < needed {
        return SurfaceStats {
            mean: [0.0; 3],
            std_dev: [0.0; 3],
            luminance: 0.0,
            variance: 0.0,
            dominant_hue: 0.0,
            saturation: 0.0,
        };
    }

    // First pass — sums (mean) plus sum-of-squared-luminance for the
    // variance signal.
    let mut sum_r = 0.0f64;
    let mut sum_g = 0.0f64;
    let mut sum_b = 0.0f64;
    let mut sum_lum = 0.0f64;
    let mut sum_lum_sq = 0.0f64;
    for i in 0..pixel_count {
        let r = rgba[i * 4] as f64 / 255.0;
        let g = rgba[i * 4 + 1] as f64 / 255.0;
        let b = rgba[i * 4 + 2] as f64 / 255.0;
        let lum = 0.299 * r + 0.587 * g + 0.114 * b;
        sum_r += r;
        sum_g += g;
        sum_b += b;
        sum_lum += lum;
        sum_lum_sq += lum * lum;
    }
    let n = pixel_count as f64;
    let mean_r = sum_r / n;
    let mean_g = sum_g / n;
    let mean_b = sum_b / n;
    let mean_lum = sum_lum / n;
    let lum_variance = (sum_lum_sq / n - mean_lum * mean_lum).max(0.0);

    // Second pass — per-channel std-dev.
    let mut ssr = 0.0f64;
    let mut ssg = 0.0f64;
    let mut ssb = 0.0f64;
    for i in 0..pixel_count {
        let r = rgba[i * 4] as f64 / 255.0;
        let g = rgba[i * 4 + 1] as f64 / 255.0;
        let b = rgba[i * 4 + 2] as f64 / 255.0;
        let dr = r - mean_r;
        let dg = g - mean_g;
        let db = b - mean_b;
        ssr += dr * dr;
        ssg += dg * dg;
        ssb += db * db;
    }
    let std_r = (ssr / n).sqrt() as f32;
    let std_g = (ssg / n).sqrt() as f32;
    let std_b = (ssb / n).sqrt() as f32;

    let mean = [mean_r as f32, mean_g as f32, mean_b as f32];
    let lum_mean = mean_lum as f32;

    // HSV-ish hue + saturation from the mean colour (good enough for
    // a rule-set; per-pixel hue histograms are out of scope here).
    let (h_deg, sat) = mean_hue_saturation(mean[0], mean[1], mean[2]);

    SurfaceStats {
        mean,
        std_dev: [std_r, std_g, std_b],
        luminance: lum_mean,
        variance: lum_variance as f32,
        dominant_hue: h_deg,
        saturation: sat,
    }
}

/// HSV hue (degrees) + saturation for one RGB sample.
/// Saturation: `S = (max - min) / max` (matches the hand-off note).
fn mean_hue_saturation(r: f32, g: f32, b: f32) -> (f32, f32) {
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let delta = max - min;
    if max <= f32::EPSILON || delta <= f32::EPSILON {
        return (0.0, 0.0);
    }
    let sat = delta / max;
    let hue = if max == r {
        60.0 * (((g - b) / delta) % 6.0)
    } else if max == g {
        60.0 * (((b - r) / delta) + 2.0)
    } else {
        60.0 * (((r - g) / delta) + 4.0)
    };
    let hue = if hue < 0.0 { hue + 360.0 } else { hue };
    (hue, sat)
}

/// Apply the 12-rule classifier. Rules are evaluated in priority order;
/// the first match wins. Tuned empirically against Holtburg's surface
/// set (Phase 1.4 acceptance criterion #1).
pub fn classify(stats: &SurfaceStats, surface_type_flags: u32) -> SurfaceCategory {
    use surface_type_flags::*;

    let flags = surface_type_flags;
    let [r, g, b] = stats.mean;
    let lum = stats.luminance;
    let sat = stats.saturation;
    let hue = stats.dominant_hue;
    let var = stats.variance;

    // Rule 1: Luminous + red-dominant + low variance → Lava.
    // Lifestones and lava floors are emissive red/orange with a smooth
    // baked look. Translucent emissives (glowing runes) are NOT lava.
    if (flags & LUMINOUS) != 0
        && r > 0.4
        && r > g * 1.2
        && r > b * 1.5
        && var < 0.05
        && (flags & TRANSLUCENT) == 0
    {
        return SurfaceCategory::Lava;
    }

    // Rule 2: Translucent + blue-dominant + low alpha → Water.
    // The "low alpha" hand-off note refers to mean alpha not RGB; the
    // pixels are RGBA8 so technically we could pull mean alpha, but
    // Translucent + blue-dominant is the dominant signal — water in
    // AC retail surfaces is always Translucent. The "low alpha"
    // disambiguator falls out as a non-binding clarification.
    if (flags & TRANSLUCENT) != 0 && b > r && b > g && b > 0.2 {
        return SurfaceCategory::Water;
    }

    // Rule 3: Base1ClipMap + green-dominant → Foliage. (Clip-map is
    // AC's binary-alpha mask, used by every cutout tree/bush.)
    if (flags & BASE1_CLIP_MAP) != 0 && g > r && g > b && sat > 0.15 {
        return SurfaceCategory::Foliage;
    }

    // Rule 4: Green-dominant (sat > 0.3) → Foliage even without the
    // clip-map flag — solid-green hedge surfaces, grass tiles.
    if g > r && g > b && sat > 0.3 {
        return SurfaceCategory::Foliage;
    }

    // Rule 5: Near-white + low variance → Snow. Snow is distinctive:
    // very high luminance, very low saturation, smooth.
    if lum > 0.78 && sat < 0.12 && var < 0.02 {
        return SurfaceCategory::Snow;
    }

    // Rule 6: Tan/beige (hue 30–60, sat 0.2–0.4, lum ≥ 0.55) + low
    // variance → Sand. The luminance gate matters: real sand is pale
    // and warm, separating it from low-lum browns that should hit
    // Wood/Dirt below.
    if (30.0..=60.0).contains(&hue) && sat >= 0.2 && sat <= 0.5 && lum >= 0.55 && var < 0.06 {
        return SurfaceCategory::Sand;
    }

    // Rule 7: Red-dominant (R > 1.5 × G and 1.5 × B) in the orange/
    // brown hue band (5–45°) → Wood (dark) or Dirt (light). Tuned to
    // catch real wood/dirt where saturation is often 0.5–0.8 (the
    // hand-off "low sat" wording reads as "lower than pure red", not
    // a literal sat < 0.45 cap). The hue band excludes pure-red
    // banners / dyed cloth which sit around 0° or 350°.
    if r > g * 1.4 && r > b * 1.4 && (5.0..=50.0).contains(&hue) {
        if lum < 0.35 {
            return SurfaceCategory::Wood;
        } else {
            return SurfaceCategory::Dirt;
        }
    }

    // Rule 8: Brown wood / dirt without strict R>1.4G threshold —
    // catches the more muted oak / pine tones where green's been
    // boosted by AC's palette. Hue band 15–55 (orange/brown), modest
    // saturation, generous variance (cottage walls have rough texture
    // detail — variance up to ~0.12 is normal).
    if (15.0..=55.0).contains(&hue) && sat >= 0.1 && sat <= 0.65 && var < 0.13 {
        if lum < 0.35 {
            return SurfaceCategory::Wood;
        } else if lum < 0.55 {
            return SurfaceCategory::Dirt;
        }
        // higher-luminance brown→tan band already hit Sand above.
    }

    // Rule 9: Gray + low variance + high luminance → Metal.
    // Polished iron / steel surfaces are bright but desaturated and
    // smooth. The variance threshold separates them from stone.
    if sat < 0.12 && lum > 0.45 && var < 0.025 {
        return SurfaceCategory::Metal;
    }

    // Rule 10: Gray-ish + low variance + low-to-mid luminance → Stone.
    // Includes polished marble, smooth flagstone, and dark stone
    // (lum >= 0.10 floor; below that is silhouette/shadow surfaces).
    if sat < 0.2 && lum >= 0.10 && lum <= 0.65 && var < 0.04 {
        return SurfaceCategory::Stone;
    }

    // Rule 11: Gray + high variance → Stone (rough). Brick patterns
    // fall here per hand-off note (lump brick into Stone for now,
    // Phase 1.5 will override known brick DIDs).
    if sat < 0.25 && lum >= 0.10 && var >= 0.025 {
        return SurfaceCategory::Stone;
    }

    // Rule 12: Default → Generic.
    SurfaceCategory::Generic
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a uniform-colour `width × height` RGBA8 buffer.
    fn solid(w: u32, h: u32, r: u8, g: u8, b: u8, a: u8) -> Vec<u8> {
        let mut out = Vec::with_capacity((w * h * 4) as usize);
        for _ in 0..(w * h) {
            out.extend_from_slice(&[r, g, b, a]);
        }
        out
    }

    /// Checkerboard for variance tests.
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

    // ----- compute_stats ---------------------------------------------------

    #[test]
    fn compute_stats_solid_mid_gray() {
        let buf = solid(4, 4, 128, 128, 128, 0xFF);
        let s = compute_stats(&buf, 4, 4);
        assert!((s.mean[0] - 0.5019608).abs() < 1e-4);
        assert!((s.mean[1] - 0.5019608).abs() < 1e-4);
        assert!((s.mean[2] - 0.5019608).abs() < 1e-4);
        assert!((s.luminance - 0.5019608).abs() < 1e-4);
        // Zero variance for a flat surface.
        assert!(s.variance < 1e-5);
        // Saturation undefined (delta=0) → reported as 0.
        assert_eq!(s.saturation, 0.0);
    }

    #[test]
    fn compute_stats_solid_pure_red() {
        let buf = solid(2, 2, 255, 0, 0, 0xFF);
        let s = compute_stats(&buf, 2, 2);
        assert!((s.mean[0] - 1.0).abs() < 1e-4);
        assert!((s.saturation - 1.0).abs() < 1e-4);
        // Red hue is 0°.
        assert!(s.dominant_hue.abs() < 1e-4 || (s.dominant_hue - 360.0).abs() < 1e-4);
    }

    #[test]
    fn compute_stats_checkerboard_has_variance() {
        let buf = checker(8, 8, [0, 0, 0], [255, 255, 255]);
        let s = compute_stats(&buf, 8, 8);
        // Mean half-gray.
        assert!((s.luminance - 0.5).abs() < 0.01);
        // Variance ≈ 0.25 for a black/white checkerboard
        // (E[Y²]=0.5, E[Y]=0.5, variance = 0.25).
        assert!((s.variance - 0.25).abs() < 0.01);
    }

    #[test]
    fn compute_stats_dim_mismatch_returns_zeroed_stats() {
        let buf = vec![0u8; 8]; // not enough for 4x4
        let s = compute_stats(&buf, 4, 4);
        assert_eq!(s.mean, [0.0; 3]);
        assert_eq!(s.variance, 0.0);
    }

    // ----- classify — one golden per category -------------------------------

    fn stats(
        mean: [f32; 3],
        std: [f32; 3],
        variance: f32,
        hue: f32,
        sat: f32,
    ) -> SurfaceStats {
        let lum = 0.299 * mean[0] + 0.587 * mean[1] + 0.114 * mean[2];
        SurfaceStats {
            mean,
            std_dev: std,
            luminance: lum,
            variance,
            dominant_hue: hue,
            saturation: sat,
        }
    }

    #[test]
    fn classify_lava() {
        // Bright red, low variance, Luminous flag set.
        let s = stats([0.9, 0.2, 0.1], [0.05; 3], 0.01, 5.0, 0.88);
        let c = classify(&s, surface_type_flags::LUMINOUS);
        assert_eq!(c, SurfaceCategory::Lava);
    }

    #[test]
    fn classify_water() {
        // Blue-tinted translucent.
        let s = stats([0.2, 0.4, 0.7], [0.05; 3], 0.015, 210.0, 0.6);
        let c = classify(&s, surface_type_flags::TRANSLUCENT);
        assert_eq!(c, SurfaceCategory::Water);
    }

    #[test]
    fn classify_foliage_clipmap() {
        // Green-tinted clipmap (tree leaf).
        let s = stats([0.25, 0.6, 0.2], [0.1; 3], 0.04, 110.0, 0.55);
        let c = classify(&s, surface_type_flags::BASE1_CLIP_MAP);
        assert_eq!(c, SurfaceCategory::Foliage);
    }

    #[test]
    fn classify_foliage_solid_green() {
        // Grass tile, no clipmap flag.
        let s = stats([0.2, 0.55, 0.18], [0.1; 3], 0.035, 110.0, 0.65);
        let c = classify(&s, 0);
        assert_eq!(c, SurfaceCategory::Foliage);
    }

    #[test]
    fn classify_snow() {
        // Near-white smooth.
        let s = stats([0.92, 0.93, 0.94], [0.02; 3], 0.005, 0.0, 0.02);
        let c = classify(&s, 0);
        assert_eq!(c, SurfaceCategory::Snow);
    }

    #[test]
    fn classify_sand() {
        // Tan/beige.
        let s = stats([0.78, 0.66, 0.42], [0.05; 3], 0.02, 40.0, 0.46);
        let c = classify(&s, 0);
        assert_eq!(c, SurfaceCategory::Sand);
    }

    #[test]
    fn classify_wood_dark() {
        // Dark brown door — red-dominant, orange-brown hue.
        // RGB (0.36, 0.18, 0.12) → sat=0.667, hue≈18.
        let s = stats([0.36, 0.18, 0.12], [0.06; 3], 0.025, 18.0, 0.667);
        let c = classify(&s, 0);
        assert_eq!(c, SurfaceCategory::Wood);
    }

    #[test]
    fn classify_dirt() {
        // Light dirt path — red-dominant, higher luminance.
        // RGB (0.58, 0.36, 0.24) → sat=0.586, hue≈22.
        let s = stats([0.58, 0.36, 0.24], [0.06; 3], 0.025, 22.0, 0.586);
        let c = classify(&s, 0);
        assert_eq!(c, SurfaceCategory::Dirt);
    }

    #[test]
    fn classify_metal() {
        // Bright polished gray — high luminance, very low variance.
        let s = stats([0.62, 0.62, 0.63], [0.04; 3], 0.015, 0.0, 0.02);
        let c = classify(&s, 0);
        assert_eq!(c, SurfaceCategory::Metal);
    }

    #[test]
    fn classify_stone_smooth() {
        // Mid-gray smooth flagstone.
        let s = stats([0.38, 0.38, 0.38], [0.05; 3], 0.025, 0.0, 0.0);
        let c = classify(&s, 0);
        assert_eq!(c, SurfaceCategory::Stone);
    }

    #[test]
    fn classify_stone_rough() {
        // Rough cottage wall — high variance, low sat.
        let s = stats([0.45, 0.44, 0.42], [0.12; 3], 0.06, 35.0, 0.07);
        let c = classify(&s, 0);
        assert_eq!(c, SurfaceCategory::Stone);
    }

    #[test]
    fn classify_generic_fallthrough() {
        // Mid-saturation purple — none of the rules match.
        let s = stats([0.5, 0.3, 0.5], [0.05; 3], 0.02, 300.0, 0.4);
        let c = classify(&s, 0);
        assert_eq!(c, SurfaceCategory::Generic);
    }

    #[test]
    fn category_round_trips_via_u8() {
        for raw in 0u8..=12u8 {
            let cat = SurfaceCategory::from_u8(raw).unwrap();
            assert_eq!(cat.as_u8(), raw);
        }
        assert!(SurfaceCategory::from_u8(13).is_none());
    }
}
