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
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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
#[derive(Debug, Clone)]
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
        let pixels = vec![0u8; 16];
        // Pick a format we don't decode (DXT1).
        let buf = make_texture_header(827611204, 2, 2, &pixels, None);
        let tex = Texture::unpack(&buf).unwrap();
        let err = tex.to_rgba8(|_| panic!("no palette")).unwrap_err();
        assert!(matches!(err, TextureDecodeError::UnsupportedFormat(_)));
    }
}
