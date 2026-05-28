//! AC Texture (DatFileType 0x06) — pixel data for one mip-level. The
//! terrain atlas uses one Texture per terrain type, decoded to RGBA8.
//!
//! Format:
//! ```text
//! [u32 id][i32 unknown][i32 width][i32 height][u32 format][i32 length]
//! [u8 source_data]*length
//! [u32 default_palette_id]?  // present iff format ∈ {INDEX16, P8}
//! ```
//!
//! Pixel formats supported by [`Texture::to_rgba8`] are the ones AC
//! terrain actually uses; other formats (DXT, RGB565, A4R4G4B4, etc.)
//! aren't ported because none of the 32 surface-table textures use them.
//! Add when needed.

use crate::Result;
use crate::file_type::palette::Palette;
use binrw::{BinRead, binread};

/// Subset of `SurfacePixelFormat` from upstream ACE
/// `Source/ACE.Entity/Enum/SurfacePixelFormat.cs`. Values are the
/// `u32` enum constants AC writes into the dat header. Only the formats
/// actually used by the 32 terrain textures are matched in
/// [`Texture::to_rgba8`]; everything else returns an error so the caller
/// learns which format to add when an unsupported texture is fed in.
#[allow(non_camel_case_types)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[repr(u32)]
pub enum SurfacePixelFormat {
    Unknown = 0,
    R8G8B8 = 20,
    A8R8G8B8 = 21,
    R5G6B5 = 23,
    A4R4G4B4 = 26,
    A8 = 28,
    P8 = 41,
    Index16 = 101,
    CustomLscapeR8G8B8 = 243,
    CustomLscapeAlpha = 244,
    /// 79 records in retail `client_portal.dat` (per
    /// `texture_format_coverage` 2026-05-28). melt's `Texture.cs:91`
    /// handles via `Image.FromStream` on the raw `SourceData` bytes;
    /// we port the same path through `jpeg-decoder`.
    CustomRawJpeg = 500,
    Dxt1 = 827611204,
    Dxt3 = 861165636,
    Dxt5 = 894720068,
    /// Sentinel for any value not in the curated set above. Carries the
    /// raw u32 so callers can report it.
    Other(u32),
}

impl SurfacePixelFormat {
    pub fn from_u32(v: u32) -> Self {
        match v {
            0 => Self::Unknown,
            20 => Self::R8G8B8,
            21 => Self::A8R8G8B8,
            23 => Self::R5G6B5,
            26 => Self::A4R4G4B4,
            28 => Self::A8,
            41 => Self::P8,
            101 => Self::Index16,
            243 => Self::CustomLscapeR8G8B8,
            244 => Self::CustomLscapeAlpha,
            500 => Self::CustomRawJpeg,
            827611204 => Self::Dxt1,
            861165636 => Self::Dxt3,
            894720068 => Self::Dxt5,
            other => Self::Other(other),
        }
    }

    pub fn needs_palette(&self) -> bool {
        matches!(self, Self::P8 | Self::Index16)
    }
}

#[binread]
#[derive(Debug, Clone, serde::Serialize)]
#[br(little)]
pub struct Texture {
    pub id: u32,
    pub _unknown: i32,
    pub width: i32,
    pub height: i32,
    pub format_raw: u32,
    pub length: i32,
    #[br(count = length)]
    pub source_data: Vec<u8>,
    /// Present iff `format` is `P8` or `Index16` (palettized formats).
    /// Read manually after `source_data` because binrw's `if` on the
    /// raw `format_raw` field needs the matching call site.
    #[br(if(matches!(SurfacePixelFormat::from_u32(format_raw), SurfacePixelFormat::P8 | SurfacePixelFormat::Index16)))]
    pub default_palette_id: Option<u32>,
}

impl Texture {
    pub fn unpack(data: &[u8]) -> Result<Self> {
        let mut cursor = std::io::Cursor::new(data);
        Ok(Self::read(&mut cursor)?)
    }

    pub fn format(&self) -> SurfacePixelFormat {
        SurfacePixelFormat::from_u32(self.format_raw)
    }

    /// For `CustomRawJpeg` records, peek the JPEG's SOF marker to get
    /// the intrinsic `(width, height)` — the Texture header carries
    /// `(0, 0)` for these records since the header was generic-DAT
    /// metadata and the JPEG payload is self-describing. Returns
    /// `None` for non-JPEG formats or malformed JPEG headers.
    pub fn jpeg_dimensions(&self) -> Option<(u32, u32)> {
        if self.format() != SurfacePixelFormat::CustomRawJpeg {
            return None;
        }
        let mut decoder = jpeg_decoder::Decoder::new(&self.source_data[..]);
        // `read_info()` parses the SOF marker without decoding the
        // image — cheap (microseconds).
        decoder.read_info().ok()?;
        let info = decoder.info()?;
        Some((info.width as u32, info.height as u32))
    }

    /// Decode `source_data` to a width × height RGBA8 buffer
    /// (`length = width * height * 4`).
    ///
    /// `palette_for` is consulted only when [`SurfacePixelFormat::needs_palette`]
    /// holds. Pass a closure rather than a borrowed `Palette` so callers
    /// can lazily fetch palettes from a `ResourceSource` only on demand —
    /// most terrain textures are `CustomLscapeR8G8B8` and never trigger
    /// the palette path.
    pub fn to_rgba8<F>(&self, palette_for: F) -> std::result::Result<Vec<u8>, TextureDecodeError>
    where
        F: FnOnce(u32) -> std::result::Result<Palette, TextureDecodeError>,
    {
        let w = self.width as usize;
        let h = self.height as usize;
        let pixels = w
            .checked_mul(h)
            .ok_or(TextureDecodeError::DimensionOverflow)?;

        match self.format() {
            // Most common for terrain. Source bytes are stored as
            // R, G, B per pixel — no swap needed unlike the misnamed
            // `R8G8B8` (which is actually BGR in the file).
            SurfacePixelFormat::CustomLscapeR8G8B8 => {
                if self.source_data.len() < pixels * 3 {
                    return Err(TextureDecodeError::ShortRead);
                }
                let mut out = Vec::with_capacity(pixels * 4);
                for i in 0..pixels {
                    let r = self.source_data[i * 3];
                    let g = self.source_data[i * 3 + 1];
                    let b = self.source_data[i * 3 + 2];
                    out.extend_from_slice(&[r, g, b, 0xFF]);
                }
                Ok(out)
            }

            // Despite the name, AC writes B, G, R per pixel. See ACE
            // upstream `Texture.cs` `GetImageColorArray` — the
            // `PFID_R8G8B8` branch reads `b, g, r`.
            SurfacePixelFormat::R8G8B8 => {
                if self.source_data.len() < pixels * 3 {
                    return Err(TextureDecodeError::ShortRead);
                }
                let mut out = Vec::with_capacity(pixels * 4);
                for i in 0..pixels {
                    let b = self.source_data[i * 3];
                    let g = self.source_data[i * 3 + 1];
                    let r = self.source_data[i * 3 + 2];
                    out.extend_from_slice(&[r, g, b, 0xFF]);
                }
                Ok(out)
            }

            // 32-bit ARGB; AC writes the i32 little-endian, so
            // `source_data[i*4..]` is `B G R A`.
            SurfacePixelFormat::A8R8G8B8 => {
                if self.source_data.len() < pixels * 4 {
                    return Err(TextureDecodeError::ShortRead);
                }
                let mut out = Vec::with_capacity(pixels * 4);
                for i in 0..pixels {
                    let b = self.source_data[i * 4];
                    let g = self.source_data[i * 4 + 1];
                    let r = self.source_data[i * 4 + 2];
                    let a = self.source_data[i * 4 + 3];
                    out.extend_from_slice(&[r, g, b, a]);
                }
                Ok(out)
            }

            // 8-bit indices into a palette of ARGB colours.
            SurfacePixelFormat::P8 => {
                let pal_id = self
                    .default_palette_id
                    .ok_or(TextureDecodeError::MissingPaletteId)?;
                let pal = palette_for(pal_id)?;
                if self.source_data.len() < pixels {
                    return Err(TextureDecodeError::ShortRead);
                }
                let mut out = Vec::with_capacity(pixels * 4);
                for i in 0..pixels {
                    let idx = self.source_data[i] as usize;
                    let argb = pal
                        .colors
                        .get(idx)
                        .copied()
                        .ok_or(TextureDecodeError::PaletteIndexOutOfRange)?;
                    let a = ((argb >> 24) & 0xFF) as u8;
                    let r = ((argb >> 16) & 0xFF) as u8;
                    let g = ((argb >> 8) & 0xFF) as u8;
                    let b = (argb & 0xFF) as u8;
                    out.extend_from_slice(&[r, g, b, a]);
                }
                Ok(out)
            }

            // 16-bit indices into a palette. Same as P8 but each index is u16-le.
            SurfacePixelFormat::Index16 => {
                let pal_id = self
                    .default_palette_id
                    .ok_or(TextureDecodeError::MissingPaletteId)?;
                let pal = palette_for(pal_id)?;
                if self.source_data.len() < pixels * 2 {
                    return Err(TextureDecodeError::ShortRead);
                }
                let mut out = Vec::with_capacity(pixels * 4);
                for i in 0..pixels {
                    let lo = self.source_data[i * 2] as u16;
                    let hi = self.source_data[i * 2 + 1] as u16;
                    let idx = (lo | (hi << 8)) as usize;
                    let argb = pal
                        .colors
                        .get(idx)
                        .copied()
                        .ok_or(TextureDecodeError::PaletteIndexOutOfRange)?;
                    let a = ((argb >> 24) & 0xFF) as u8;
                    let r = ((argb >> 16) & 0xFF) as u8;
                    let g = ((argb >> 8) & 0xFF) as u8;
                    let b = (argb & 0xFF) as u8;
                    out.extend_from_slice(&[r, g, b, a]);
                }
                Ok(out)
            }

            // Greyscale.
            SurfacePixelFormat::A8 | SurfacePixelFormat::CustomLscapeAlpha => {
                if self.source_data.len() < pixels {
                    return Err(TextureDecodeError::ShortRead);
                }
                let mut out = Vec::with_capacity(pixels * 4);
                for i in 0..pixels {
                    let v = self.source_data[i];
                    out.extend_from_slice(&[v, v, v, 0xFF]);
                }
                Ok(out)
            }

            // 16-bit packed RGB565: `[rrrrrggg][ggbbbbb b]` little-endian
            // u16 → R5 G6 B5. Bit-replicate (≡ multiply by 0xFF / max)
            // to map 0..31 → 0..255 for R/B and 0..63 → 0..255 for G.
            // Bit-replication is the standard expansion in D3D/OpenGL
            // (gives smoother gradients than `<<3` zero-extend).
            // Retail count in client_portal.dat: 3 records (rare; tiny
            // UI/HUD textures).
            SurfacePixelFormat::R5G6B5 => {
                if self.source_data.len() < pixels * 2 {
                    return Err(TextureDecodeError::ShortRead);
                }
                let mut out = Vec::with_capacity(pixels * 4);
                for i in 0..pixels {
                    let lo = self.source_data[i * 2] as u16;
                    let hi = self.source_data[i * 2 + 1] as u16;
                    let v = lo | (hi << 8);
                    let r5 = ((v >> 11) & 0x1F) as u32;
                    let g6 = ((v >> 5) & 0x3F) as u32;
                    let b5 = (v & 0x1F) as u32;
                    // Bit-replication: 0..31 → 0..255 (≡ (n<<3) | (n>>2));
                    // 0..63 → 0..255 (≡ (n<<2) | (n>>4)).
                    let r = (((r5 << 3) | (r5 >> 2)) & 0xFF) as u8;
                    let g = (((g6 << 2) | (g6 >> 4)) & 0xFF) as u8;
                    let b = (((b5 << 3) | (b5 >> 2)) & 0xFF) as u8;
                    out.extend_from_slice(&[r, g, b, 0xFF]);
                }
                Ok(out)
            }

            // 16-bit packed ARGB4444: `[aaaarrrr][ggggbbbb]` little-endian
            // u16 → A4 R4 G4 B4. Each nibble multiplied by 0x11 maps
            // 0..15 → 0..255 (bit-replication). melt's `Texture.cs:212`
            // has the right SHAPE but the wrong MATH: it does integer
            // division `(val >> 12) / 0xF * 255` which truncates to 0/1
            // and produces only 0 or 255, blowing intermediate alphas.
            // We use bit-replication (≡ multiply by 0x11) instead.
            // Retail count: 2 records.
            SurfacePixelFormat::A4R4G4B4 => {
                if self.source_data.len() < pixels * 2 {
                    return Err(TextureDecodeError::ShortRead);
                }
                let mut out = Vec::with_capacity(pixels * 4);
                for i in 0..pixels {
                    let lo = self.source_data[i * 2] as u16;
                    let hi = self.source_data[i * 2 + 1] as u16;
                    let v = lo | (hi << 8);
                    let a4 = ((v >> 12) & 0xF) as u8;
                    let r4 = ((v >> 8) & 0xF) as u8;
                    let g4 = ((v >> 4) & 0xF) as u8;
                    let b4 = (v & 0xF) as u8;
                    let a = a4 * 0x11; // 0..15 * 17 = 0..255
                    let r = r4 * 0x11;
                    let g = g4 * 0x11;
                    let b = b4 * 0x11;
                    out.extend_from_slice(&[r, g, b, a]);
                }
                Ok(out)
            }

            // Raw JPEG-encoded texture. melt's `Texture.cs:91`
            // (`GetBitmap`) hands the bytes to `Image.FromStream` so
            // the underlying GDI+ JPEG decoder does the work; we port
            // the same path through `jpeg-decoder` (pure-Rust;
            // wasm-compatible). All-opaque alpha (retail JPEGs never
            // encode alpha — UI elements that need alpha use one of
            // the BGRA / DXT / palette formats). Retail count: 79
            // records (largest "unsupported" bucket pre-Wave-8).
            SurfacePixelFormat::CustomRawJpeg => {
                // Retail's PFID_CUSTOM_RAW_JPEG records store
                // `width=0, height=0` in the Texture header — the
                // actual dimensions live inside the JPEG payload's
                // SOF marker. melt's `Texture.cs:91` doesn't validate
                // header dims either; it just feeds `SourceData` to
                // `Image.FromStream`. We do the same: trust the JPEG.
                // Caller that needs the actual dimensions can pull
                // them via `jpeg_dimensions()` below.
                let mut decoder = jpeg_decoder::Decoder::new(&self.source_data[..]);
                let pixels_jpeg = decoder
                    .decode()
                    .map_err(|e| TextureDecodeError::JpegDecode(format!("{e}")))?;
                let info = decoder
                    .info()
                    .ok_or_else(|| TextureDecodeError::JpegDecode("no JPEG info after decode".to_string()))?;
                let out = match info.pixel_format {
                    jpeg_decoder::PixelFormat::RGB24 => {
                        let mut buf = Vec::with_capacity(pixels * 4);
                        for chunk in pixels_jpeg.chunks_exact(3) {
                            buf.extend_from_slice(&[chunk[0], chunk[1], chunk[2], 0xFF]);
                        }
                        buf
                    }
                    jpeg_decoder::PixelFormat::L8 => {
                        // Greyscale JPEG (rare but legal). Expand to RGBA.
                        let mut buf = Vec::with_capacity(pixels * 4);
                        for &v in &pixels_jpeg {
                            buf.extend_from_slice(&[v, v, v, 0xFF]);
                        }
                        buf
                    }
                    other => {
                        return Err(TextureDecodeError::JpegDecode(format!(
                            "unsupported JPEG pixel format: {other:?}"
                        )));
                    }
                };
                Ok(out)
            }

            // S3TC / BCn block-compressed formats. Decode-only port of
            // upstream ACE `DxtUtil.cs` (Ms-PL, see file header). Used
            // by Phase 3 step 4.5b's per-model colour walk against the
            // ~50 DXT1 + ~10 DXT5 textures referenced by Holtburg's
            // Surface chains.
            SurfacePixelFormat::Dxt1 => {
                Ok(super::dxt::decompress_dxt1(&self.source_data, self.width as u32, self.height as u32))
            }
            SurfacePixelFormat::Dxt3 => {
                Ok(super::dxt::decompress_dxt3(&self.source_data, self.width as u32, self.height as u32))
            }
            SurfacePixelFormat::Dxt5 => {
                Ok(super::dxt::decompress_dxt5(&self.source_data, self.width as u32, self.height as u32))
            }

            other => Err(TextureDecodeError::UnsupportedFormat(other)),
        }
    }
}

#[derive(Debug)]
pub enum TextureDecodeError {
    UnsupportedFormat(SurfacePixelFormat),
    ShortRead,
    DimensionOverflow,
    MissingPaletteId,
    PaletteIndexOutOfRange,
    PaletteFetch(String),
    JpegDecode(String),
}

impl std::fmt::Display for TextureDecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnsupportedFormat(fmt) => write!(f, "unsupported pixel format: {:?}", fmt),
            Self::ShortRead => write!(f, "source_data too short for declared width/height"),
            Self::DimensionOverflow => write!(f, "width * height overflowed usize"),
            Self::MissingPaletteId => write!(f, "palettized format but no DefaultPaletteId in header"),
            Self::PaletteIndexOutOfRange => write!(f, "pixel index out of palette range"),
            Self::PaletteFetch(msg) => write!(f, "palette fetch failed: {}", msg),
            Self::JpegDecode(msg) => write!(f, "JPEG decode failed: {}", msg),
        }
    }
}

impl std::error::Error for TextureDecodeError {}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_texture_header(format: u32, width: i32, height: i32, data: &[u8], palette_id: Option<u32>) -> Vec<u8> {
        let mut buf = Vec::new();
        buf.extend_from_slice(&0x06001234u32.to_le_bytes()); // id
        buf.extend_from_slice(&0i32.to_le_bytes()); // unknown
        buf.extend_from_slice(&width.to_le_bytes());
        buf.extend_from_slice(&height.to_le_bytes());
        buf.extend_from_slice(&format.to_le_bytes());
        buf.extend_from_slice(&(data.len() as i32).to_le_bytes());
        buf.extend_from_slice(data);
        if let Some(pid) = palette_id {
            buf.extend_from_slice(&pid.to_le_bytes());
        }
        buf
    }

    #[test]
    fn parses_lscape_rgb_header_and_decodes() {
        // 2×2 LSCAPE RGB texture with R, G, B, white pixels.
        let pixels = vec![
            0xFF, 0x00, 0x00, // red
            0x00, 0xFF, 0x00, // green
            0x00, 0x00, 0xFF, // blue
            0xFF, 0xFF, 0xFF, // white
        ];
        let buf = make_texture_header(243, 2, 2, &pixels, None);
        let tex = Texture::unpack(&buf).unwrap();
        assert_eq!(tex.format(), SurfacePixelFormat::CustomLscapeR8G8B8);
        assert_eq!(tex.width, 2);
        assert_eq!(tex.height, 2);
        assert!(tex.default_palette_id.is_none());

        let rgba = tex.to_rgba8(|_| panic!("no palette needed")).unwrap();
        assert_eq!(rgba.len(), 16);
        assert_eq!(&rgba[0..4], &[0xFF, 0x00, 0x00, 0xFF]);
        assert_eq!(&rgba[4..8], &[0x00, 0xFF, 0x00, 0xFF]);
    }

    #[test]
    fn r8g8b8_swaps_to_rgb() {
        // 1×1 PFID_R8G8B8 stored as B, G, R.
        let pixels = vec![0x10, 0x20, 0x30]; // B=0x10, G=0x20, R=0x30
        let buf = make_texture_header(20, 1, 1, &pixels, None);
        let tex = Texture::unpack(&buf).unwrap();
        let rgba = tex.to_rgba8(|_| panic!("no palette")).unwrap();
        assert_eq!(rgba, vec![0x30, 0x20, 0x10, 0xFF]);
    }

    #[test]
    fn p8_with_palette_decodes() {
        let pixels = vec![0u8, 1, 2]; // 3 pixels, indices into the palette
        let buf = make_texture_header(41, 3, 1, &pixels, Some(0x04001000));
        let tex = Texture::unpack(&buf).unwrap();
        assert_eq!(tex.format(), SurfacePixelFormat::P8);
        assert_eq!(tex.default_palette_id, Some(0x04001000));

        let pal = Palette {
            id: 0x04001000,
            colors: vec![0xFFFF0000, 0xFF00FF00, 0xFF0000FF], // ARGB: red, green, blue
        };
        let rgba = tex.to_rgba8(|_id| Ok(pal.clone())).unwrap();
        // Index 0 = red ARGB FF FF 00 00 → RGBA FF 00 00 FF
        assert_eq!(&rgba[0..4], &[0xFF, 0x00, 0x00, 0xFF]);
        // Index 1 = green
        assert_eq!(&rgba[4..8], &[0x00, 0xFF, 0x00, 0xFF]);
        // Index 2 = blue
        assert_eq!(&rgba[8..12], &[0x00, 0x00, 0xFF, 0xFF]);
    }

    #[test]
    fn unsupported_format_errors() {
        // Wave 8 (2026-05-28) — every format value we ENUMERATE now has
        // a decode arm. Use a value that maps to `Other(_)` (unknown
        // to AC; never used by retail) to exercise the catch-all.
        // PFID_X8R8G8B8 (22) is in the upstream ACE enum but unused in
        // retail; our parser tags it as `Other(22)`.
        let pixels = vec![0u8; 16];
        let buf = make_texture_header(22, 2, 2, &pixels, None);
        let tex = Texture::unpack(&buf).unwrap();
        let err = tex.to_rgba8(|_| panic!("no palette")).unwrap_err();
        assert!(matches!(err, TextureDecodeError::UnsupportedFormat(_)));
    }

    #[test]
    fn dxt1_decodes_through_to_rgba8() {
        // 4×4 DXT1 block: c0=red, c1=blue, all-zero indices.
        let block: Vec<u8> = vec![
            0x00, 0xF8, // c0 = 0xF800 (red)
            0x1F, 0x00, // c1 = 0x001F (blue)
            0x00, 0x00, 0x00, 0x00, // 16 indices, all 0
        ];
        let buf = make_texture_header(827611204, 4, 4, &block, None);
        let tex = Texture::unpack(&buf).unwrap();
        assert_eq!(tex.format(), SurfacePixelFormat::Dxt1);
        let rgba = tex.to_rgba8(|_| panic!("no palette")).unwrap();
        assert_eq!(rgba.len(), 4 * 4 * 4);
        // First pixel should be red-ish.
        assert!(rgba[0] > 0xF0);
        assert_eq!(rgba[1], 0x00);
        assert_eq!(rgba[2], 0x00);
        assert_eq!(rgba[3], 0xFF);
    }
}
