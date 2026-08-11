//! TEXBC7-ALPHA-AUDIT — DAT-truth alpha classification for every
//! RenderSurface, and the corpus comparison the re-bake is gated on
//! (batch-D queue item `TEXBC7-ALPHA-REBAKE`).
//!
//! WHY THIS EXISTS
//! ---------------
//! PORTAL-BLACKBOX (2026-08-10, fixed client-side in 062e5ce3): the hires
//! upscaler took retail's 8x8 `PFID_DXT1` record `rs 0x0600396B` — four
//! blocks of `c0=0x0000 c1=0x0001, indices=0xFFFFFFFF`, i.e. DXT1
//! punch-through mode with every texel on index 3, i.e. `(0,0,0,0)`
//! EVERYWHERE — 4x'd it, and DROPPED THE ALPHA. The shipped
//! `holtburger/tex-bc7` payload is a 32x32 OPAQUE image, so every portal in
//! the world (Setup 0x020001B3 -> GfxObj 0x0100168B -> Surface 0x08000157)
//! grew a 2.82 m opaque black box where retail draws nothing at all.
//!
//! The client now vetoes that one class (`albedoFullyTransparent` in
//! `scene3d/materials.js`), but the veto is a floor, not a fix: it only
//! catches the degenerate FULLY-TRANSPARENT case, because that is the only
//! case where "the compressed payload cannot be a faithful re-encode" is
//! provable from the client's side alone. A record whose retail alpha is a
//! real punch-through MASK (leaves, grates, ladders, clipmap creature
//! bodies) that the same upscaler flattened to opaque renders as a solid
//! quad and NOTHING vetoes it. The queue item's second sentence — "then
//! AUDIT all alpha-bearing surfaces the same tool upscaled" — is this
//! module.
//!
//! WHAT "DAT TRUTH" MEANS HERE
//! ---------------------------
//! The audit's authority is the retail DAT record, decoded through the SAME
//! parsers the client uses (`holtburger_dat::file_type::Texture`, whose DXT
//! decoder is the one that gets punch-through right — `dxt.rs` c0 <= c1 =>
//! index 3 is transparent). Four classes, defined on the decoded alpha
//! plane and nothing else:
//!
//! | class               | rule                                          |
//! |---------------------|-----------------------------------------------|
//! | `opaque`            | every texel alpha == 255                      |
//! | `fully-transparent` | every texel alpha == 0                        |
//! | `punch-through`     | alpha ∈ {0,255}, both present                 |
//! | `gradient-alpha`    | at least one texel with 0 < alpha < 255       |
//! | `undetermined`      | no decode (unsupported PFID, short record)    |
//!
//! `gradient-alpha` is STRICT: one soft texel in a 512² mask lands here.
//! That is deliberate — the class must not silently absorb the Remacri
//! alpha-fringe failure mode (`impl/texfix-fringe-2026-08-09.md`: a binary
//! source upscaled into a 37%-wide soft band) — so the row also carries
//! `partial_frac` and the derived `effectively_binary` bit, which is what a
//! consumer should bucket on when it wants "is this a mask".
//!
//! TWO PLACES THE ALPHA PLANE IS NOT `to_rgba8()[3]`
//! -------------------------------------------------
//! 1. `PFID_A8` (28) / `PFID_CUSTOM_LSCAPE_ALPHA` (244).
//!    `Texture::to_rgba8` decodes both as GREYSCALE-OPAQUE — `[v, v, v,
//!    0xFF]` (`file_type/texture.rs`, the `A8 | CustomLscapeAlpha` arm).
//!    That is a client-side convention (nothing in the tree consumes these
//!    as coverage; the only other reader is dat-write's bpp table), but for
//!    an ALPHA audit it would report every A8 record opaque and hide the
//!    exact class the tool is looking for. Here the stored byte IS the
//!    alpha plane, and [`AlphaSource::A8Plane`] says so on every row.
//! 2. `Base1ClipMap` surfaces over palettized art. Retail
//!    `ImgTex::CopyIntoData` (acclient.c:365958/365980) treats palette
//!    index < 8 as the transparent clip range, so a `P8`/`Index16` record's
//!    alpha depends on whether a `Base1ClipMap` Surface (0x08) references
//!    it. The audit therefore builds the Surface -> SurfaceTexture ->
//!    Texture index FIRST and passes the resulting clipmap bit into the
//!    decode — the same argument `to_rgba8_clipmap` takes.
//!
//! DETERMINISM / PROVENANCE
//! ------------------------
//! Every classification is a pure function of record bytes. Rows are
//! emitted in ascending id order. The bin stamps the sha256 of each input
//! DAT into the summary, the way the bake tools do.

use std::collections::BTreeMap;

use holtburger_dat::file_type::{Palette, SurfacePixelFormat, Texture, TextureDecodeError};
use serde::Serialize;

// ---------------------------------------------------------------------------
// Surface (0x08) type bits — ACE `ACE.Entity/Enum/SurfaceType.cs`, the same
// table `file_type/surface.rs` documents.
// ---------------------------------------------------------------------------

pub const SURFACE_BASE1_SOLID: u32 = 0x1;
pub const SURFACE_BASE1_IMAGE: u32 = 0x2;
pub const SURFACE_BASE1_CLIPMAP: u32 = 0x4;
pub const SURFACE_TRANSLUCENT: u32 = 0x10;
pub const SURFACE_ALPHA: u32 = 0x100;
pub const SURFACE_INV_ALPHA: u32 = 0x200;
pub const SURFACE_ADDITIVE: u32 = 0x1_0000;

// ---------------------------------------------------------------------------
// The class
// ---------------------------------------------------------------------------

/// What a payload's alpha plane actually is. See the table in the module
/// docs; the four real classes are exhaustive over any non-empty plane.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AlphaClass {
    /// Every texel alpha == 255 (includes "the format has no alpha bits").
    Opaque,
    /// Every texel alpha == 0. The PORTAL-BLACKBOX class: zero information,
    /// so no re-encode of it can be an improvement — always `SKIP`.
    FullyTransparent,
    /// alpha ∈ {0, 255} with both present — a binary mask.
    PunchThrough,
    /// At least one texel with 0 < alpha < 255.
    GradientAlpha,
    /// Not decodable here (unsupported PFID, short record, or — on the
    /// corpus side — an encoded payload whose header cannot settle it).
    Undetermined,
}

impl AlphaClass {
    /// True when the payload carries transparency of any kind.
    pub fn bears_alpha(self) -> bool {
        matches!(self, Self::FullyTransparent | Self::PunchThrough | Self::GradientAlpha)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Opaque => "opaque",
            Self::FullyTransparent => "fully-transparent",
            Self::PunchThrough => "punch-through",
            Self::GradientAlpha => "gradient-alpha",
            Self::Undetermined => "undetermined",
        }
    }
}

/// Where the alpha plane came from — named on every row so a reader never
/// has to re-derive the decode path from the PFID.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AlphaSource {
    /// The format has no alpha bits at all (`R8G8B8`, `CustomLscapeR8G8B8`,
    /// `R5G6B5`, `CustomRawJpeg`). Opaque by construction, never decoded.
    None,
    /// `A8R8G8B8` — the stored `A` byte.
    Argb8888,
    /// `A4R4G4B4` — the top nibble, bit-replicated (`* 0x11`).
    Argb4444,
    /// `A8` / `CustomLscapeAlpha` — the stored byte IS the coverage (see
    /// the module docs; `to_rgba8` disagrees on purpose).
    A8Plane,
    /// `P8` / `Index16` — the palette entry's ARGB alpha, plus the retail
    /// `Base1ClipMap` index < 8 rule when a clipmap Surface references it.
    PaletteArgb,
    /// `DXT1` — c0 <= c1 punch-through mode, index 3 = transparent.
    Dxt1PunchThrough,
    /// `DXT2`/`DXT3` (BC2) — 4-bit explicit alpha.
    Dxt3Explicit,
    /// `DXT4`/`DXT5` (BC3) — interpolated alpha block.
    Dxt5Interpolated,
    /// PNG corpus payload with an alpha channel.
    PngRgba,
    /// PNG corpus payload with no alpha channel — alpha DROPPED if the DAT
    /// twin had any. This is the PORTAL-BLACKBOX signature on the PNG lane.
    PngNoAlphaChannel,
    /// KTX2 corpus payload: settled from the header/DFD rather than pixels.
    Ktx2Header,
    /// HBC7 corpus payload (`--tex-bc7` / `--tex-bc7-pre`): settled from
    /// the per-block BC7 MODE, not from decoded texels.
    Hbc7Blocks,
    /// PFID outside the curated set — no decode arm.
    Unsupported,
}

/// Counted shape of one alpha plane. All counts are texels.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct AlphaStats {
    pub texels: u64,
    /// alpha == 0
    pub zero: u64,
    /// alpha == 255
    pub full: u64,
    /// 0 < alpha < 255
    pub partial: u64,
    pub min: u8,
    pub max: u8,
}

impl AlphaStats {
    /// Fraction of texels with a soft alpha. The Remacri-fringe axis.
    pub fn partial_frac(&self) -> f64 {
        if self.texels == 0 { 0.0 } else { self.partial as f64 / self.texels as f64 }
    }

    /// Fraction of texels that are fully transparent.
    pub fn zero_frac(&self) -> f64 {
        if self.texels == 0 { 0.0 } else { self.zero as f64 / self.texels as f64 }
    }

    /// A `gradient-alpha` plane that is a mask in all but name — the class
    /// a consumer should bucket on when it asks "is this a cutout". The
    /// 0.5% floor is the `texfix-fringe` report's shape (a true binary
    /// source measured ONE partial texel in 512²; the upscaled twin
    /// measured 37%).
    pub fn effectively_binary(&self) -> bool {
        self.partial_frac() < 0.005
    }
}

/// Classify an alpha plane. Empty input is [`AlphaClass::Undetermined`] —
/// a zero-texel payload is not an opaque one, and calling it opaque would
/// silently pass a truncated record.
pub fn classify_alpha(alphas: &[u8]) -> (AlphaClass, AlphaStats) {
    if alphas.is_empty() {
        return (AlphaClass::Undetermined, AlphaStats::default());
    }
    let mut st = AlphaStats { texels: alphas.len() as u64, min: 255, max: 0, ..Default::default() };
    for &a in alphas {
        match a {
            0 => st.zero += 1,
            255 => st.full += 1,
            _ => st.partial += 1,
        }
        st.min = st.min.min(a);
        st.max = st.max.max(a);
    }
    let class = if st.partial > 0 {
        AlphaClass::GradientAlpha
    } else if st.zero == 0 {
        AlphaClass::Opaque
    } else if st.full == 0 {
        AlphaClass::FullyTransparent
    } else {
        AlphaClass::PunchThrough
    };
    (class, st)
}

// ---------------------------------------------------------------------------
// DAT truth
// ---------------------------------------------------------------------------

/// The decode path a PFID's alpha takes. [`AlphaSource::None`] means the
/// format has no alpha bits and the record is opaque without decoding it —
/// which is also what makes the census cheap over the ~thousands of
/// `CustomLscapeR8G8B8` / JPEG records.
pub fn alpha_source_of(fmt: SurfacePixelFormat) -> AlphaSource {
    match fmt {
        SurfacePixelFormat::R8G8B8
        | SurfacePixelFormat::CustomLscapeR8G8B8
        | SurfacePixelFormat::R5G6B5
        | SurfacePixelFormat::CustomRawJpeg => AlphaSource::None,
        SurfacePixelFormat::A8R8G8B8 => AlphaSource::Argb8888,
        SurfacePixelFormat::A4R4G4B4 => AlphaSource::Argb4444,
        SurfacePixelFormat::A8 | SurfacePixelFormat::CustomLscapeAlpha => AlphaSource::A8Plane,
        SurfacePixelFormat::P8 | SurfacePixelFormat::Index16 => AlphaSource::PaletteArgb,
        SurfacePixelFormat::Dxt1 => AlphaSource::Dxt1PunchThrough,
        SurfacePixelFormat::Dxt2 | SurfacePixelFormat::Dxt3 => AlphaSource::Dxt3Explicit,
        SurfacePixelFormat::Dxt4 | SurfacePixelFormat::Dxt5 => AlphaSource::Dxt5Interpolated,
        SurfacePixelFormat::Unknown | SurfacePixelFormat::Other(_) => AlphaSource::Unsupported,
    }
}

/// True when the PFID can carry transparency AT ALL — the "alpha-bearing
/// surfaces" set the queue item names, taken at format granularity. DXT1 is
/// IN (punch-through is an alpha mode of it), which is the whole point.
///
/// Note the asymmetry with [`AlphaClass::bears_alpha`]: this is the
/// CAPABILITY (what the format could encode), that is the REALITY (what
/// these bytes do encode). A DXT1 record with no punch-through block is
/// alpha-capable and opaque.
pub fn format_carries_alpha(fmt: SurfacePixelFormat) -> bool {
    !matches!(alpha_source_of(fmt), AlphaSource::None | AlphaSource::Unsupported)
}

/// Human label for a PFID (stable strings — they end up in JSONL rows).
pub fn format_label(fmt: SurfacePixelFormat) -> String {
    match fmt {
        SurfacePixelFormat::Other(v) => format!("other-{v}"),
        other => format!("{other:?}"),
    }
}

/// Extract one texture record's alpha plane, honouring the two divergences
/// the module docs call out.
///
/// `clipmap` is the `Base1ClipMap` bit of the Surface(s) that reference this
/// record — retail `ImgTex::CopyIntoData` makes palette index < 8
/// transparent under it. `palette_override` is the referencing Surface's
/// `orig_palette_id` recolour (0 = none).
///
/// `Ok(None)` = the format has no alpha bits; the caller reports
/// [`AlphaClass::Opaque`] without allocating an RGBA8 buffer.
pub fn texture_alpha_plane<F>(
    tex: &Texture,
    clipmap: bool,
    palette_override: u32,
    palette_for: F,
) -> Result<Option<Vec<u8>>, TextureDecodeError>
where
    F: FnOnce(u32) -> Result<Palette, TextureDecodeError>,
{
    let fmt = tex.format();
    match alpha_source_of(fmt) {
        AlphaSource::None => Ok(None),
        AlphaSource::Unsupported => Err(TextureDecodeError::UnsupportedFormat(fmt)),
        // The stored byte IS the coverage plane. `to_rgba8` would hand back
        // greyscale-opaque here (see module docs), so read it directly.
        AlphaSource::A8Plane => {
            let (w, h) = tex.actual_dimensions();
            let want = w as usize * h as usize;
            if tex.source_data.len() < want {
                return Err(TextureDecodeError::ShortRead);
            }
            Ok(Some(tex.source_data[..want].to_vec()))
        }
        // Everything else routes through the client's own decoder so the
        // punch-through / explicit-alpha / clipmap rules are the SAME code
        // the renderer runs.
        _ => {
            let rgba = tex.to_rgba8_with_palette_override(palette_override, clipmap, palette_for)?;
            Ok(Some(rgba.iter().skip(3).step_by(4).copied().collect()))
        }
    }
}

/// Everything the audit knows about one DAT record's alpha. Serialized
/// verbatim into the JSONL row.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatAlphaFacts {
    pub class: AlphaClass,
    pub source: AlphaSource,
    pub format: String,
    pub format_raw: u32,
    pub width: u32,
    pub height: u32,
    pub stats: AlphaStats,
    pub partial_frac: f64,
    pub zero_frac: f64,
    pub effectively_binary: bool,
    /// Populated when the decode failed — the row still exists (the census
    /// must not lose records), with class `undetermined`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decode_error: Option<String>,
}

/// Classify one already-parsed [`Texture`]. Never fails: a decode error
/// becomes an `undetermined` row carrying the error text, because an audit
/// that drops the records it could not read is an audit that lies.
pub fn classify_texture<F>(
    tex: &Texture,
    clipmap: bool,
    palette_override: u32,
    palette_for: F,
) -> DatAlphaFacts
where
    F: FnOnce(u32) -> Result<Palette, TextureDecodeError>,
{
    let fmt = tex.format();
    let (w, h) = tex.actual_dimensions();
    let source = alpha_source_of(fmt);
    let (class, stats, err) = match texture_alpha_plane(tex, clipmap, palette_override, palette_for)
    {
        // No alpha bits in the format: opaque, and the texel count is the
        // declared area so the census sums are still meaningful.
        Ok(None) => (
            AlphaClass::Opaque,
            AlphaStats {
                texels: w as u64 * h as u64,
                full: w as u64 * h as u64,
                min: 255,
                max: 255,
                ..Default::default()
            },
            None,
        ),
        Ok(Some(plane)) => {
            let (c, s) = classify_alpha(&plane);
            (c, s, None)
        }
        Err(e) => (AlphaClass::Undetermined, AlphaStats::default(), Some(e.to_string())),
    };
    DatAlphaFacts {
        class,
        source,
        format: format_label(fmt),
        format_raw: tex.format_raw,
        width: w,
        height: h,
        stats,
        partial_frac: stats.partial_frac(),
        zero_frac: stats.zero_frac(),
        effectively_binary: stats.effectively_binary(),
        decode_error: err,
    }
}

// ---------------------------------------------------------------------------
// Corpus side — PNG lane (exact) and KTX2 lane (header read)
// ---------------------------------------------------------------------------

/// Alpha facts for one upscaled corpus payload.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CorpusAlphaFacts {
    pub class: AlphaClass,
    pub source: AlphaSource,
    pub width: u32,
    pub height: u32,
    pub stats: AlphaStats,
    pub partial_frac: f64,
    pub effectively_binary: bool,
    /// KTX2 only: the header/DFD read, verbatim, so a consumer can
    /// re-adjudicate an `undetermined` without re-running the tool.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ktx2: Option<Ktx2Probe>,
    /// HBC7 only: the header + BC7 mode histogram, likewise verbatim.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hbc7: Option<Hbc7Probe>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decode_error: Option<String>,
}

impl CorpusAlphaFacts {
    /// A container-level verdict with no texel statistics behind it.
    fn from_container(
        class: AlphaClass,
        source: AlphaSource,
        width: u32,
        height: u32,
    ) -> Self {
        Self {
            class,
            source,
            width,
            height,
            stats: AlphaStats::default(),
            partial_frac: 0.0,
            effectively_binary: false,
            ktx2: None,
            hbc7: None,
            decode_error: None,
        }
    }
}

/// Classify a PNG corpus payload from its bytes. EXACT — the alpha channel
/// is read texel by texel, so this lane settles every class.
///
/// A PNG with no alpha channel (`Rgb`/`Grayscale`) is `opaque` with source
/// [`AlphaSource::PngNoAlphaChannel`]: that pair is the upscaler's
/// alpha-drop signature, and naming it separately is what lets the summary
/// say "the channel was gone" rather than "the pixels were opaque".
pub fn classify_png(bytes: &[u8]) -> CorpusAlphaFacts {
    match decode_png_alpha(bytes) {
        Ok((w, h, Some(plane))) => {
            let (class, stats) = classify_alpha(&plane);
            CorpusAlphaFacts {
                class,
                source: AlphaSource::PngRgba,
                width: w,
                height: h,
                stats,
                partial_frac: stats.partial_frac(),
                effectively_binary: stats.effectively_binary(),
                ktx2: None,
                hbc7: None,
                decode_error: None,
            }
        }
        Ok((w, h, None)) => {
            let n = w as u64 * h as u64;
            let stats = AlphaStats { texels: n, full: n, min: 255, max: 255, ..Default::default() };
            CorpusAlphaFacts {
                class: AlphaClass::Opaque,
                source: AlphaSource::PngNoAlphaChannel,
                width: w,
                height: h,
                stats,
                partial_frac: 0.0,
                effectively_binary: true,
                ktx2: None,
                hbc7: None,
                decode_error: None,
            }
        }
        Err(e) => CorpusAlphaFacts {
            decode_error: Some(e),
            ..CorpusAlphaFacts::from_container(AlphaClass::Undetermined, AlphaSource::PngRgba, 0, 0)
        },
    }
}

/// `(w, h, Some(alpha plane) | None)` — `None` when the PNG has no alpha
/// channel. 16-bit and palette+tRNS sources are normalized to 8-bit first,
/// exactly as `page-resample` does, so the two tools read one corpus the
/// same way.
fn decode_png_alpha(bytes: &[u8]) -> Result<(u32, u32, Option<Vec<u8>>), String> {
    let mut dec = png::Decoder::new(std::io::Cursor::new(bytes));
    dec.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = dec.read_info().map_err(|e| format!("read_info: {e}"))?;
    let mut buf = vec![0u8; reader.output_buffer_size().unwrap_or(0)];
    let info = reader.next_frame(&mut buf).map_err(|e| format!("decode: {e}"))?;
    if info.bit_depth != png::BitDepth::Eight {
        return Err(format!("bit depth {:?} survived normalization", info.bit_depth));
    }
    let (channels, alpha_at) = match info.color_type {
        png::ColorType::Grayscale => (1usize, None),
        png::ColorType::Rgb => (3, None),
        png::ColorType::GrayscaleAlpha => (2, Some(1usize)),
        png::ColorType::Rgba => (4, Some(3)),
        other => return Err(format!("unsupported color type {other:?}")),
    };
    let px = info.width as usize * info.height as usize;
    let want = px * channels;
    if buf.len() < want {
        return Err(format!("short buffer: {} B, expected {want}", buf.len()));
    }
    let plane = alpha_at.map(|off| buf[..want].iter().skip(off).step_by(channels).copied().collect());
    Ok((info.width, info.height, plane))
}

/// KTX2 file identifier (spec §3.1). Same constant `pack_bake::ktx2_dims`
/// uses; duplicated rather than exported so this module stays a leaf.
pub const KTX2_IDENTIFIER: [u8; 12] =
    [0xAB, 0x4B, 0x54, 0x58, 0x20, 0x32, 0x30, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A];

/// What a KTX2 header + basic Data Format Descriptor says. Emitted VERBATIM
/// on the row: the alpha verdict for an encoded payload is an inference,
/// and a consumer that disagrees with the inference must be able to see the
/// evidence without re-running.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ktx2Probe {
    pub width: u32,
    pub height: u32,
    pub vk_format: u32,
    pub level_count: u32,
    pub supercompression: u32,
    /// KHR_DF colour model from the basic DFD (163 = ETC1S, 166 = UASTC,
    /// 128..134 = BC1..BC7), when the DFD is present and well-formed.
    pub color_model: Option<u8>,
    /// One entry per DFD sample: `channelType & 0x0F`.
    pub channel_types: Vec<u8>,
    /// `Some(true|false)` when the header settles alpha presence,
    /// `None` when it cannot (raw BC7, unknown model).
    pub has_alpha_channel: Option<bool>,
}

/// Read a KTX2 header + basic DFD. Reads no image data at all.
///
/// The alpha inference is deliberately CONSERVATIVE — it answers only where
/// the container is unambiguous:
///
///  * `vkFormat != 0`: a small table of the block/uncompressed formats a
///    texture corpus can plausibly ship. BC7 (145/146) is `None`: BC7 has
///    one DFD channel (`BC7_DATA`) and its alpha lives inside the block
///    modes, so no header read can settle it — only a decode can, and this
///    tool does not decode.
///  * `vkFormat == 0` (Basis Universal): ETC1S (`colorModel` 163) carries
///    alpha as a SECOND sample, so the sample count settles it exactly.
///    UASTC (166) is settled only for the unambiguous RGB channel type.
///
/// Anything else returns `has_alpha_channel: None`, and the caller counts
/// it as undetermined rather than guessing.
pub fn probe_ktx2(bytes: &[u8]) -> Option<Ktx2Probe> {
    if bytes.len() < 80 || bytes[..12] != KTX2_IDENTIFIER {
        return None;
    }
    let u32_at = |o: usize| u32::from_le_bytes(bytes[o..o + 4].try_into().unwrap());
    let vk_format = u32_at(12);
    let width = u32_at(20);
    let height = u32_at(24);
    let level_count = u32_at(40);
    let supercompression = u32_at(44);
    let dfd_offset = u32_at(48) as usize;
    let dfd_len = u32_at(52) as usize;

    let (color_model, channel_types) = parse_basic_dfd(bytes, dfd_offset, dfd_len)
        .map(|(m, c)| (Some(m), c))
        .unwrap_or((None, Vec::new()));

    let has_alpha_channel = if vk_format != 0 {
        vk_format_has_alpha(vk_format)
    } else {
        match color_model {
            // KHR_DF_MODEL_ETC1S: 1 sample = RGB, 2 samples = RGB + AAA.
            Some(163) => match channel_types.len() {
                1 => Some(false),
                2 => Some(true),
                _ => None,
            },
            // KHR_DF_MODEL_UASTC: channel type 0 is RGB in every revision
            // of the table; the alpha-bearing codes differ between them, so
            // only the negative is asserted here.
            Some(166) => match channel_types.first() {
                Some(0) => Some(false),
                _ => None,
            },
            _ => None,
        }
    };

    Some(Ktx2Probe {
        width,
        height,
        vk_format,
        level_count,
        supercompression,
        color_model,
        channel_types,
        has_alpha_channel,
    })
}

/// `(colorModel, channelTypes)` from the KTX2 basic Data Format Descriptor.
///
/// Layout (KHR_DF spec): `[u32 dfdTotalSize]` then the basic block —
/// `vendorId/descriptorType` (u32), `versionNumber/descriptorBlockSize`
/// (u32), `colorModel` u8 @8, `colorPrimaries` @9, `transferFunction` @10,
/// `flags` @11, `texelBlockDimension[4]` @12, `bytesPlane[8]` @16, then
/// 16-byte samples from @24. `channelType` is the low nibble of byte 3 of
/// each sample.
fn parse_basic_dfd(bytes: &[u8], offset: usize, len: usize) -> Option<(u8, Vec<u8>)> {
    if offset == 0 || len < 4 + 24 {
        return None;
    }
    let end = offset.checked_add(len)?;
    if end > bytes.len() {
        return None;
    }
    let block = &bytes[offset + 4..end];
    if block.len() < 24 {
        return None;
    }
    let block_size = u16::from_le_bytes(block[6..8].try_into().ok()?) as usize;
    let block_size = block_size.min(block.len());
    if block_size < 24 {
        return None;
    }
    let color_model = block[8];
    let n_samples = (block_size - 24) / 16;
    let mut channels = Vec::with_capacity(n_samples);
    for i in 0..n_samples {
        channels.push(block[24 + i * 16 + 3] & 0x0F);
    }
    Some((color_model, channels))
}

/// Alpha presence for the `vkFormat` values a texture corpus can plausibly
/// ship. `None` = the format can carry alpha but the header cannot say
/// whether these bytes do (BC7).
fn vk_format_has_alpha(vk_format: u32) -> Option<bool> {
    match vk_format {
        // Uncompressed 8-bit: the R8G8B8_* family (UNORM..SRGB) then the
        // R8G8B8A8_* family, contiguous in the Vulkan enum.
        23..=29 => Some(false),
        37..=43 => Some(true),
        // BC1 has two distinct vkFormats — the RGB pair genuinely has no
        // alpha bit, which makes it the strongest possible drop signal.
        131 | 132 => Some(false), // BC1_RGB_{UNORM,SRGB}
        133 | 134 => Some(true),  // BC1_RGBA_{UNORM,SRGB}
        135 | 136 => Some(true),  // BC2 (explicit 4-bit alpha)
        137 | 138 => Some(true),  // BC3 (interpolated alpha)
        139 | 140 => Some(false), // BC4 (single channel)
        141 | 142 => Some(false), // BC5 (two channels)
        143 | 144 => Some(false), // BC6H (HDR RGB)
        // BC7: one DFD channel, alpha lives in the block mode. Undecidable
        // from the container.
        145 | 146 => None,
        _ => None,
    }
}

/// Classify a KTX2 corpus payload from its header. Never decodes.
pub fn classify_ktx2(bytes: &[u8]) -> CorpusAlphaFacts {
    match probe_ktx2(bytes) {
        Some(p) => {
            let class = match p.has_alpha_channel {
                // No alpha channel in the container at all: every texel is
                // opaque by construction. This is the alpha-drop signature.
                Some(false) => AlphaClass::Opaque,
                // The channel exists; its CONTENT needs a decode.
                Some(true) | None => AlphaClass::Undetermined,
            };
            let (w, h) = (p.width, p.height);
            CorpusAlphaFacts {
                ktx2: Some(p),
                ..CorpusAlphaFacts::from_container(class, AlphaSource::Ktx2Header, w, h)
            }
        }
        None => CorpusAlphaFacts {
            decode_error: Some("not a KTX2 file (identifier mismatch or short)".into()),
            ..CorpusAlphaFacts::from_container(
                AlphaClass::Undetermined,
                AlphaSource::Ktx2Header,
                0,
                0,
            )
        },
    }
}

// --- HBC7 (the `--tex-bc7` / `--tex-bc7-pre` lane) -------------------------

/// `"HBC7"` magic + 20-byte header, read-verified against
/// `dat_shard::validate_hbc7` and `scene3d/bc7_textures.js#parseHbc7`:
/// `magic(4) | u32 width | u32 height | u32 blocksX | u32 blocksY`, then a
/// mip chain of raw 16-byte BC7 blocks.
pub const HBC7_MAGIC: [u8; 4] = *b"HBC7";
pub const HBC7_HEADER_BYTES: usize = 20;
const BC7_BLOCK_BYTES: usize = 16;

/// What an HBC7 payload's BC7 blocks say about alpha.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hbc7Probe {
    pub width: u32,
    pub height: u32,
    pub blocks_x: u32,
    pub blocks_y: u32,
    /// Total 16-byte blocks in the whole mip chain.
    pub blocks: u64,
    /// Count per BC7 mode, index 0..=7; index 8 = blocks with an illegal
    /// mode field (low byte all zero).
    pub mode_histogram: [u64; 9],
    /// `Some(false)` when EVERY block is mode 0..=3 (those modes encode no
    /// alpha field at all, so the payload is provably opaque). `None`
    /// otherwise — see [`probe_hbc7`].
    pub has_alpha_channel: Option<bool>,
}

/// Read an HBC7 payload's header and scan its BC7 block modes. Decodes no
/// texels.
///
/// BC7's mode is unary-coded in the LOW bits of each 128-bit block, so the
/// mode of a block is `block[0].trailing_zeros()` (a zero low byte is an
/// illegal mode field). Modes 0–3 carry NO alpha field — their alpha is
/// implicitly 255 — so a payload built entirely from them is provably
/// opaque, which is exactly the alpha-drop signature this audit hunts.
///
/// The converse is NOT available from a mode scan: modes 4–7 have an alpha
/// field that an encoder will happily fill with 255 for opaque content
/// (mode 6 in particular is the workhorse mode for high-quality opaque
/// blocks). So any mode-4..7 block makes the answer `None` — undetermined —
/// rather than "has alpha". Settling those needs a real BC7 decode, which
/// this tool deliberately does not do; run the same audit against the PNG
/// lane the payload was encoded FROM and the answer is exact.
pub fn probe_hbc7(bytes: &[u8]) -> Option<Hbc7Probe> {
    if bytes.len() < HBC7_HEADER_BYTES || bytes[..4] != HBC7_MAGIC {
        return None;
    }
    let u32_at = |o: usize| u32::from_le_bytes(bytes[o..o + 4].try_into().unwrap());
    let width = u32_at(4);
    let height = u32_at(8);
    let blocks_x = u32_at(12);
    let blocks_y = u32_at(16);

    let mut mode_histogram = [0u64; 9];
    let mut blocks = 0u64;
    for block in bytes[HBC7_HEADER_BYTES..].chunks_exact(BC7_BLOCK_BYTES) {
        blocks += 1;
        let mode = block[0].trailing_zeros() as usize; // 8 when block[0] == 0
        mode_histogram[mode.min(8)] += 1;
    }

    let alpha_capable_blocks: u64 = mode_histogram[4..=7].iter().sum();
    let has_alpha_channel = if blocks == 0 {
        None
    } else if alpha_capable_blocks == 0 && mode_histogram[8] == 0 {
        Some(false)
    } else {
        None
    };

    Some(Hbc7Probe {
        width,
        height,
        blocks_x,
        blocks_y,
        blocks,
        mode_histogram,
        has_alpha_channel,
    })
}

/// Classify an HBC7 corpus payload. Never decodes texels.
pub fn classify_hbc7(bytes: &[u8]) -> CorpusAlphaFacts {
    match probe_hbc7(bytes) {
        Some(p) => {
            let class = match p.has_alpha_channel {
                Some(false) => AlphaClass::Opaque,
                _ => AlphaClass::Undetermined,
            };
            let (w, h) = (p.width, p.height);
            CorpusAlphaFacts {
                hbc7: Some(p),
                ..CorpusAlphaFacts::from_container(class, AlphaSource::Hbc7Blocks, w, h)
            }
        }
        None => CorpusAlphaFacts {
            decode_error: Some("not an HBC7 payload (magic mismatch or short)".into()),
            ..CorpusAlphaFacts::from_container(
                AlphaClass::Undetermined,
                AlphaSource::Hbc7Blocks,
                0,
                0,
            )
        },
    }
}

/// Classify a corpus payload by sniffing its container — the three the
/// lanes actually ship:
///
///  * PNG — the upscale corpus (`out/<set>-remacri`). EXACT.
///  * KTX2 — the `--tex-xu7` ingest / xubc7 corpora. Header + DFD.
///  * HBC7 — the `--tex-bc7` / `--tex-bc7-pre` ingest. BC7 mode scan.
///
/// Anything else is `undetermined` and counted, never guessed at.
pub fn classify_corpus_payload(bytes: &[u8]) -> CorpusAlphaFacts {
    const PNG_MAGIC: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    if bytes.len() >= 8 && bytes[..8] == PNG_MAGIC {
        classify_png(bytes)
    } else if bytes.len() >= 12 && bytes[..12] == KTX2_IDENTIFIER {
        classify_ktx2(bytes)
    } else if bytes.len() >= 4 && bytes[..4] == HBC7_MAGIC {
        classify_hbc7(bytes)
    } else {
        CorpusAlphaFacts {
            decode_error: Some("unrecognised container (not PNG, not KTX2, not HBC7)".into()),
            ..CorpusAlphaFacts::from_container(
                AlphaClass::Undetermined,
                AlphaSource::Unsupported,
                0,
                0,
            )
        }
    }
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Verdict {
    /// Corpus alpha agrees with DAT truth — leave the payload alone.
    Keep,
    /// The corpus payload misrepresents DAT alpha. Re-encode from the DAT
    /// source with alpha preserved.
    Rebake,
    /// Nothing to do and nothing to gain: the DAT record is fully
    /// transparent (zero information — the queue item's own rule), or the
    /// corpus never upscaled it.
    Skip,
}

impl Verdict {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Keep => "KEEP",
            Self::Rebake => "REBAKE",
            Self::Skip => "SKIP",
        }
    }
}

/// Sub-signals carried alongside the verdict. Distinct from the verdict on
/// purpose: the acceptance gate names exactly three verdicts, and a defect
/// class that is real but not a re-bake (a softened mask that the fringe
/// repair already owns) must not be able to inflate the REBAKE count.
pub const FLAG_PUNCHTHROUGH_SOFTENED: &str = "punchthrough-softened";
pub const FLAG_ALPHA_CHANNEL_DROPPED: &str = "alpha-channel-dropped";
pub const FLAG_CORPUS_UNDETERMINED: &str = "corpus-alpha-undetermined";
pub const FLAG_DIMS_NOT_INTEGER_SCALE: &str = "dims-not-integer-scale";
pub const FLAG_CLIPMAP: &str = "clipmap-surface";

/// The verdict rule, as one pure function.
///
/// | DAT | corpus | verdict | reason |
/// |-----|--------|---------|--------|
/// | fully-transparent | anything | SKIP | zero information; no re-encode can improve it (queue rule, and what 062e5ce3 vetoes client-side) |
/// | punch-through / gradient | opaque | REBAKE | alpha dropped — the PORTAL-BLACKBOX defect |
/// | punch-through | gradient | KEEP + `punchthrough-softened` | the Remacri fringe class; owned by the fringe repair, not by a re-bake |
/// | opaque | bears alpha | REBAKE | alpha INVENTED — a solid surface would turn see-through |
/// | any | undetermined | KEEP + `corpus-alpha-undetermined` (REBAKE under `strict_unknown`) | encoded payload; header cannot settle it |
/// | undetermined (DAT) | any | SKIP | no DAT truth to compare against |
///
/// `strict_unknown` is the lever for a lane where the fail-open default is
/// wrong (an operator who would rather re-encode than ship an unverified
/// payload). It never changes a SKIP.
pub fn decide(
    dat: AlphaClass,
    corpus: AlphaClass,
    strict_unknown: bool,
) -> (Verdict, &'static str, Vec<&'static str>) {
    let mut flags = Vec::new();
    match (dat, corpus) {
        (AlphaClass::FullyTransparent, _) => (
            Verdict::Skip,
            "DAT record is fully transparent: zero information, so no re-encode can be an improvement",
            flags,
        ),
        (AlphaClass::Undetermined, _) => {
            (Verdict::Skip, "DAT alpha could not be decoded — no truth to compare against", flags)
        }
        (_, AlphaClass::Undetermined) => {
            flags.push(FLAG_CORPUS_UNDETERMINED);
            if strict_unknown {
                (
                    Verdict::Rebake,
                    "corpus alpha undetermined and --strict-unknown is set",
                    flags,
                )
            } else {
                (
                    Verdict::Keep,
                    "corpus payload is encoded; its alpha content cannot be settled from the header \
                     (re-run against the PNG lane to settle it)",
                    flags,
                )
            }
        }
        (AlphaClass::PunchThrough | AlphaClass::GradientAlpha, AlphaClass::Opaque) => {
            flags.push(FLAG_ALPHA_CHANNEL_DROPPED);
            (Verdict::Rebake, "DAT record carries alpha, corpus payload is opaque — alpha dropped", flags)
        }
        (AlphaClass::PunchThrough | AlphaClass::GradientAlpha, AlphaClass::FullyTransparent) => (
            Verdict::Rebake,
            "corpus payload is fully transparent but the DAT record is not — alpha destroyed",
            flags,
        ),
        (AlphaClass::PunchThrough, AlphaClass::GradientAlpha) => {
            flags.push(FLAG_PUNCHTHROUGH_SOFTENED);
            (
                Verdict::Keep,
                "binary DAT mask upscaled to soft alpha (the alpha-fringe class — owned by the \
                 fringe repair, not by a re-bake)",
                flags,
            )
        }
        (AlphaClass::Opaque, c) if c.bears_alpha() => (
            Verdict::Rebake,
            "DAT record is opaque but the corpus payload carries alpha — transparency invented",
            flags,
        ),
        _ => (Verdict::Keep, "corpus alpha agrees with DAT truth", flags),
    }
}

// ---------------------------------------------------------------------------
// Census bucketing
// ---------------------------------------------------------------------------

/// Ordered counters keyed by a stable string. `BTreeMap` so the summary is
/// byte-identical run to run.
pub type Buckets = BTreeMap<String, u64>;

pub fn bump(b: &mut Buckets, key: impl Into<String>) {
    *b.entry(key.into()).or_insert(0) += 1;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_four_classes() {
        assert_eq!(classify_alpha(&[255, 255, 255]).0, AlphaClass::Opaque);
        assert_eq!(classify_alpha(&[0, 0, 0]).0, AlphaClass::FullyTransparent);
        assert_eq!(classify_alpha(&[0, 255, 0, 255]).0, AlphaClass::PunchThrough);
        assert_eq!(classify_alpha(&[0, 128, 255]).0, AlphaClass::GradientAlpha);
        // Empty is NOT opaque — a truncated record must not pass as clean.
        assert_eq!(classify_alpha(&[]).0, AlphaClass::Undetermined);
    }

    #[test]
    fn stats_and_the_effectively_binary_bit() {
        let plane: Vec<u8> = std::iter::repeat_n(0u8, 100)
            .chain(std::iter::repeat_n(255u8, 899))
            .chain(std::iter::once(200u8))
            .collect();
        let (class, st) = classify_alpha(&plane);
        assert_eq!(class, AlphaClass::GradientAlpha);
        assert_eq!(st.texels, 1000);
        assert_eq!(st.zero, 100);
        assert_eq!(st.full, 899);
        assert_eq!(st.partial, 1);
        assert_eq!(st.min, 0);
        assert_eq!(st.max, 255);
        // 1/1000 = 0.001 < 0.005 -> a mask in all but name.
        assert!(st.effectively_binary());
        // The fringe shape (37% soft band) is NOT.
        let band: Vec<u8> = std::iter::repeat_n(128u8, 370)
            .chain(std::iter::repeat_n(255u8, 630))
            .collect();
        assert!(!classify_alpha(&band).1.effectively_binary());
    }

    #[test]
    fn alpha_capability_by_pfid() {
        use SurfacePixelFormat as F;
        // DXT1 is IN — punch-through is an alpha mode of it, and it is the
        // exact format PORTAL-BLACKBOX turned up.
        assert!(format_carries_alpha(F::Dxt1));
        assert_eq!(alpha_source_of(F::Dxt1), AlphaSource::Dxt1PunchThrough);
        assert!(format_carries_alpha(F::Dxt3));
        assert!(format_carries_alpha(F::Dxt5));
        assert!(format_carries_alpha(F::A8R8G8B8));
        assert!(format_carries_alpha(F::A4R4G4B4));
        assert!(format_carries_alpha(F::P8));
        assert!(format_carries_alpha(F::Index16));
        assert!(format_carries_alpha(F::A8));
        assert!(format_carries_alpha(F::CustomLscapeAlpha));
        // No alpha bits.
        assert!(!format_carries_alpha(F::R8G8B8));
        assert!(!format_carries_alpha(F::CustomLscapeR8G8B8));
        assert!(!format_carries_alpha(F::R5G6B5));
        assert!(!format_carries_alpha(F::CustomRawJpeg));
        assert_eq!(alpha_source_of(F::R8G8B8), AlphaSource::None);
        // Unknown PFIDs are neither capable nor silently opaque.
        assert!(!format_carries_alpha(F::Other(22)));
        assert_eq!(alpha_source_of(F::Other(22)), AlphaSource::Unsupported);
    }

    #[test]
    fn a8_plane_is_the_stored_byte_not_the_greyscale_decode() {
        // PFID_A8 (28), 2x2, coverage 0/64/128/255. `to_rgba8` would report
        // this opaque (it emits [v,v,v,0xFF]); the audit must not.
        let mut buf = Vec::new();
        buf.extend_from_slice(&0x0600_0001u32.to_le_bytes());
        buf.extend_from_slice(&0i32.to_le_bytes());
        buf.extend_from_slice(&2i32.to_le_bytes());
        buf.extend_from_slice(&2i32.to_le_bytes());
        buf.extend_from_slice(&28u32.to_le_bytes());
        buf.extend_from_slice(&4i32.to_le_bytes());
        buf.extend_from_slice(&[0u8, 64, 128, 255]);
        let tex = Texture::unpack(&buf).unwrap();
        let facts = classify_texture(&tex, false, 0, |_| panic!("no palette"));
        assert_eq!(facts.source, AlphaSource::A8Plane);
        assert_eq!(facts.class, AlphaClass::GradientAlpha);
        assert_eq!(facts.stats.zero, 1);
        assert_eq!(facts.stats.full, 1);
        assert_eq!(facts.stats.partial, 2);
        // And the client-side decode really does disagree, as documented.
        let rgba = tex.to_rgba8(|_| panic!("no palette")).unwrap();
        assert!(rgba.iter().skip(3).step_by(4).all(|&a| a == 255));
    }

    #[test]
    fn dxt1_punch_through_is_the_portal_blackbox_shape() {
        // The retail 0x0600396B block, verbatim from 062e5ce3's commit
        // message: c0=0x0000, c1=0x0001 (c0 <= c1 => punch-through mode),
        // indices 0xFFFFFFFF (every texel on index 3 = transparent).
        let mut buf = Vec::new();
        buf.extend_from_slice(&0x0600_0002u32.to_le_bytes());
        buf.extend_from_slice(&0i32.to_le_bytes());
        buf.extend_from_slice(&4i32.to_le_bytes());
        buf.extend_from_slice(&4i32.to_le_bytes());
        buf.extend_from_slice(&827611204u32.to_le_bytes()); // PFID_DXT1
        buf.extend_from_slice(&8i32.to_le_bytes());
        buf.extend_from_slice(&[0x00, 0x00, 0x01, 0x00, 0xFF, 0xFF, 0xFF, 0xFF]);
        let tex = Texture::unpack(&buf).unwrap();
        let facts = classify_texture(&tex, false, 0, |_| panic!("no palette"));
        assert_eq!(facts.class, AlphaClass::FullyTransparent);
        assert_eq!(facts.source, AlphaSource::Dxt1PunchThrough);
        assert_eq!(facts.stats.zero, 16);
        // And the queue item's rule: this can only ever be SKIP.
        for corpus in [
            AlphaClass::Opaque,
            AlphaClass::PunchThrough,
            AlphaClass::GradientAlpha,
            AlphaClass::Undetermined,
        ] {
            assert_eq!(decide(facts.class, corpus, false).0, Verdict::Skip);
            assert_eq!(decide(facts.class, corpus, true).0, Verdict::Skip);
        }
    }

    #[test]
    fn verdict_table() {
        use AlphaClass::*;
        // The defect the queue item is about.
        let (v, _, f) = decide(PunchThrough, Opaque, false);
        assert_eq!(v, Verdict::Rebake);
        assert!(f.contains(&FLAG_ALPHA_CHANNEL_DROPPED));
        assert_eq!(decide(GradientAlpha, Opaque, false).0, Verdict::Rebake);
        // Invented transparency is equally a defect.
        assert_eq!(decide(Opaque, PunchThrough, false).0, Verdict::Rebake);
        assert_eq!(decide(Opaque, GradientAlpha, false).0, Verdict::Rebake);
        // Agreement.
        assert_eq!(decide(Opaque, Opaque, false).0, Verdict::Keep);
        assert_eq!(decide(PunchThrough, PunchThrough, false).0, Verdict::Keep);
        assert_eq!(decide(GradientAlpha, GradientAlpha, false).0, Verdict::Keep);
        // The fringe class stays KEEP but is flagged, so it cannot inflate
        // the re-bake list.
        let (v, _, f) = decide(PunchThrough, GradientAlpha, false);
        assert_eq!(v, Verdict::Keep);
        assert!(f.contains(&FLAG_PUNCHTHROUGH_SOFTENED));
        // Undetermined corpus: fail-open + counted, or strict.
        let (v, _, f) = decide(PunchThrough, Undetermined, false);
        assert_eq!(v, Verdict::Keep);
        assert!(f.contains(&FLAG_CORPUS_UNDETERMINED));
        assert_eq!(decide(PunchThrough, Undetermined, true).0, Verdict::Rebake);
        // No DAT truth -> nothing to assert.
        assert_eq!(decide(Undetermined, Opaque, false).0, Verdict::Skip);
        assert_eq!(decide(Undetermined, Opaque, true).0, Verdict::Skip);
    }

    // --- corpus lanes ----------------------------------------------------

    fn png_bytes(w: u32, h: u32, color: png::ColorType, pixels: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        {
            let mut enc = png::Encoder::new(&mut out, w, h);
            enc.set_color(color);
            enc.set_depth(png::BitDepth::Eight);
            let mut wr = enc.write_header().unwrap();
            wr.write_image_data(pixels).unwrap();
            wr.finish().unwrap();
        }
        out
    }

    #[test]
    fn png_rgba_alpha_is_exact() {
        // 2x1 RGBA: one transparent texel, one opaque.
        let bytes = png_bytes(2, 1, png::ColorType::Rgba, &[1, 2, 3, 0, 4, 5, 6, 255]);
        let facts = classify_png(&bytes);
        assert_eq!(facts.class, AlphaClass::PunchThrough);
        assert_eq!(facts.source, AlphaSource::PngRgba);
        assert_eq!((facts.width, facts.height), (2, 1));
        assert_eq!(facts.stats.zero, 1);
        assert_eq!(facts.stats.full, 1);
    }

    #[test]
    fn png_without_an_alpha_channel_is_the_drop_signature() {
        let bytes = png_bytes(2, 1, png::ColorType::Rgb, &[1, 2, 3, 4, 5, 6]);
        let facts = classify_png(&bytes);
        assert_eq!(facts.class, AlphaClass::Opaque);
        // The named source is what lets the summary say WHY it is opaque.
        assert_eq!(facts.source, AlphaSource::PngNoAlphaChannel);
        assert_eq!(facts.stats.texels, 2);
        // Against a punch-through DAT twin this is the re-bake case.
        assert_eq!(decide(AlphaClass::PunchThrough, facts.class, false).0, Verdict::Rebake);
    }

    #[test]
    fn corpus_sniffs_the_container() {
        let png = png_bytes(1, 1, png::ColorType::Rgba, &[0, 0, 0, 0]);
        assert_eq!(classify_corpus_payload(&png).source, AlphaSource::PngRgba);
        assert_eq!(classify_corpus_payload(b"not an image").class, AlphaClass::Undetermined);
        assert_eq!(classify_corpus_payload(b"not an image").source, AlphaSource::Unsupported);
    }

    /// Synthesize a KTX2 header (+ optional basic DFD) — the real corpus
    /// lives on the laptop's mounted drives, so the container reader is
    /// pinned against hand-built headers here and against the real lane in
    /// the corpus run.
    fn ktx2_bytes(vk_format: u32, w: u32, h: u32, dfd: Option<(u8, &[u8])>) -> Vec<u8> {
        let mut head = Vec::new();
        head.extend_from_slice(&KTX2_IDENTIFIER);
        head.extend_from_slice(&vk_format.to_le_bytes()); // 12
        head.extend_from_slice(&1u32.to_le_bytes()); // 16 typeSize
        head.extend_from_slice(&w.to_le_bytes()); // 20
        head.extend_from_slice(&h.to_le_bytes()); // 24
        head.extend_from_slice(&0u32.to_le_bytes()); // 28 pixelDepth
        head.extend_from_slice(&0u32.to_le_bytes()); // 32 layerCount
        head.extend_from_slice(&1u32.to_le_bytes()); // 36 faceCount
        head.extend_from_slice(&1u32.to_le_bytes()); // 40 levelCount
        head.extend_from_slice(&0u32.to_le_bytes()); // 44 supercompression
        let dfd_block = dfd.map(|(model, channels)| {
            let block_size = 24 + channels.len() * 16;
            let mut b = vec![0u8; 4 + block_size];
            b[0..4].copy_from_slice(&((4 + block_size) as u32).to_le_bytes()); // dfdTotalSize
            // descriptorBlockSize lives in the high half of the second u32
            // of the block (bytes 6..8 of the block).
            b[4 + 6..4 + 8].copy_from_slice(&(block_size as u16).to_le_bytes());
            b[4 + 8] = model;
            for (i, &c) in channels.iter().enumerate() {
                b[4 + 24 + i * 16 + 3] = c;
            }
            b
        });
        let dfd_off = if dfd_block.is_some() { 80u32 } else { 0 };
        let dfd_len = dfd_block.as_ref().map(|b| b.len() as u32).unwrap_or(0);
        head.extend_from_slice(&dfd_off.to_le_bytes()); // 48
        head.extend_from_slice(&dfd_len.to_le_bytes()); // 52
        head.extend_from_slice(&0u32.to_le_bytes()); // 56 kvdByteOffset
        head.extend_from_slice(&0u32.to_le_bytes()); // 60 kvdByteLength
        head.extend_from_slice(&0u64.to_le_bytes()); // 64 sgdByteOffset
        head.extend_from_slice(&0u64.to_le_bytes()); // 72 sgdByteLength
        assert_eq!(head.len(), 80);
        if let Some(b) = dfd_block {
            head.extend_from_slice(&b);
        }
        head
    }

    #[test]
    fn ktx2_vkformat_settles_what_it_can() {
        // BC1_RGB has no alpha bit at all — the strongest drop signal.
        let p = probe_ktx2(&ktx2_bytes(131, 32, 32, None)).unwrap();
        assert_eq!((p.width, p.height), (32, 32));
        assert_eq!(p.has_alpha_channel, Some(false));
        assert_eq!(classify_ktx2(&ktx2_bytes(131, 32, 32, None)).class, AlphaClass::Opaque);
        // BC1_RGBA / BC3 carry alpha; content still needs a decode.
        assert_eq!(probe_ktx2(&ktx2_bytes(133, 8, 8, None)).unwrap().has_alpha_channel, Some(true));
        assert_eq!(probe_ktx2(&ktx2_bytes(137, 8, 8, None)).unwrap().has_alpha_channel, Some(true));
        assert_eq!(
            classify_ktx2(&ktx2_bytes(137, 8, 8, None)).class,
            AlphaClass::Undetermined
        );
        // BC7 is honestly undecidable from the container.
        assert_eq!(probe_ktx2(&ktx2_bytes(145, 8, 8, None)).unwrap().has_alpha_channel, None);
        // Not a KTX2 at all.
        assert!(probe_ktx2(b"nope").is_none());
    }

    #[test]
    fn ktx2_etc1s_alpha_is_the_second_sample() {
        // vkFormat 0 = Basis Universal; ETC1S = colour model 163.
        let rgb = ktx2_bytes(0, 64, 64, Some((163, &[0])));
        let rgba = ktx2_bytes(0, 64, 64, Some((163, &[0, 15])));
        let p_rgb = probe_ktx2(&rgb).unwrap();
        assert_eq!(p_rgb.color_model, Some(163));
        assert_eq!(p_rgb.channel_types, vec![0]);
        assert_eq!(p_rgb.has_alpha_channel, Some(false));
        let p_rgba = probe_ktx2(&rgba).unwrap();
        assert_eq!(p_rgba.channel_types, vec![0, 15]);
        assert_eq!(p_rgba.has_alpha_channel, Some(true));
        // UASTC (166): only the RGB negative is asserted.
        let uastc_rgb = probe_ktx2(&ktx2_bytes(0, 64, 64, Some((166, &[0])))).unwrap();
        assert_eq!(uastc_rgb.has_alpha_channel, Some(false));
        let uastc_other = probe_ktx2(&ktx2_bytes(0, 64, 64, Some((166, &[4])))).unwrap();
        assert_eq!(uastc_other.has_alpha_channel, None);
        assert_eq!(uastc_other.channel_types, vec![4]);
    }

    /// Build an HBC7 payload whose blocks all use `mode` (unary-coded in
    /// the low bits of byte 0, so mode m => byte0 == 1 << m).
    fn hbc7_bytes(w: u32, h: u32, modes: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&HBC7_MAGIC);
        out.extend_from_slice(&w.to_le_bytes());
        out.extend_from_slice(&h.to_le_bytes());
        out.extend_from_slice(&w.div_ceil(4).to_le_bytes());
        out.extend_from_slice(&h.div_ceil(4).to_le_bytes());
        for &m in modes {
            let mut block = [0u8; 16];
            block[0] = if m >= 8 { 0 } else { 1u8 << m };
            out.extend_from_slice(&block);
        }
        out
    }

    #[test]
    fn hbc7_modes_0_to_3_are_provably_opaque() {
        // Modes 0..3 have no alpha field at all.
        let p = probe_hbc7(&hbc7_bytes(8, 8, &[0, 1, 2, 3])).unwrap();
        assert_eq!((p.width, p.height), (8, 8));
        assert_eq!((p.blocks_x, p.blocks_y), (2, 2));
        assert_eq!(p.blocks, 4);
        assert_eq!(p.mode_histogram[0..4], [1, 1, 1, 1]);
        assert_eq!(p.has_alpha_channel, Some(false));
        assert_eq!(classify_hbc7(&hbc7_bytes(8, 8, &[0, 1, 2, 3])).class, AlphaClass::Opaque);
        // Against a punch-through DAT twin that is the re-bake case.
        assert_eq!(decide(AlphaClass::PunchThrough, AlphaClass::Opaque, false).0, Verdict::Rebake);
    }

    #[test]
    fn hbc7_alpha_capable_modes_stay_undetermined() {
        // Mode 6 is the workhorse for opaque high-quality blocks AND the
        // mode an alpha-bearing block uses, so ONE of them makes the whole
        // payload undecidable without a real decode. Claiming "has alpha"
        // here would manufacture evidence.
        for m in 4u8..=7 {
            let bytes = hbc7_bytes(8, 8, &[0, 0, 0, m]);
            let p = probe_hbc7(&bytes).unwrap();
            assert_eq!(p.mode_histogram[m as usize], 1, "mode {m}");
            assert_eq!(p.has_alpha_channel, None, "mode {m}");
            assert_eq!(classify_hbc7(&bytes).class, AlphaClass::Undetermined);
        }
        // An illegal mode field (low byte zero) is counted and refuses the
        // opaque verdict rather than being silently binned as mode 8.
        let bad = hbc7_bytes(8, 8, &[0, 0, 0, 9]);
        let p = probe_hbc7(&bad).unwrap();
        assert_eq!(p.mode_histogram[8], 1);
        assert_eq!(p.has_alpha_channel, None);
        // Not an HBC7 at all.
        assert!(probe_hbc7(b"HBC").is_none());
        assert!(probe_hbc7(&[0u8; 32]).is_none());
    }

    #[test]
    fn corpus_sniff_covers_all_three_lane_containers() {
        let png = png_bytes(1, 1, png::ColorType::Rgba, &[0, 0, 0, 0]);
        assert_eq!(classify_corpus_payload(&png).source, AlphaSource::PngRgba);
        assert_eq!(
            classify_corpus_payload(&ktx2_bytes(131, 8, 8, None)).source,
            AlphaSource::Ktx2Header
        );
        assert_eq!(
            classify_corpus_payload(&hbc7_bytes(8, 8, &[0, 0, 0, 0])).source,
            AlphaSource::Hbc7Blocks
        );
    }

    #[test]
    fn buckets_are_ordered_and_additive() {
        let mut b = Buckets::new();
        bump(&mut b, "punch-through");
        bump(&mut b, "opaque");
        bump(&mut b, "punch-through");
        assert_eq!(b.get("punch-through"), Some(&2));
        assert_eq!(b.keys().collect::<Vec<_>>(), vec!["opaque", "punch-through"]);
    }
}
