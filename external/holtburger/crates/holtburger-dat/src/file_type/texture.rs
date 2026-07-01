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
use binrw::{BinRead, BinResult, BinWrite, binread};
use std::io::{Seek, Write};

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
    /// FourCC 'DXT2' = 0x32545844. Same on-wire layout as
    /// [`SurfacePixelFormat::Dxt3`] (BC2 — 64-bit explicit-alpha block
    /// followed by 64-bit DXT1-style colour block); the difference is
    /// purely semantic — DXT2 signals that the encoded RGB has been
    /// premultiplied by alpha. Our straight-RGBA8 decode emits the
    /// stored bytes as-is, so downstream consumers that need straight
    /// colour from a DXT2 record must un-premultiply (rgb / alpha).
    /// HUD rec #203 (2026-06-16): added for retail completeness.
    Dxt2 = 844388420,
    Dxt3 = 861165636,
    /// FourCC 'DXT4' = 0x34545844. Same on-wire layout as
    /// [`SurfacePixelFormat::Dxt5`] (BC3 — 64-bit interpolated-alpha
    /// block + 64-bit DXT1 colour block); the difference is purely
    /// semantic — DXT4 signals premultiplied RGB, mirroring DXT2 vs
    /// DXT3. Decode routes through `decompress_dxt5`. HUD rec #203
    /// (2026-06-16): added for retail completeness.
    Dxt4 = 877942852,
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
            844388420 => Self::Dxt2,
            861165636 => Self::Dxt3,
            877942852 => Self::Dxt4,
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

    /// Serialize this Texture back into the canonical DAT body layout —
    /// `[u32 id][i32 _unknown][i32 width][i32 height][u32 format_raw]`
    /// `[i32 length][u8 source_data]*length[u32 default_palette_id]?` — the
    /// exact inverse of [`Texture::unpack`]. The byte length is derived from
    /// `source_data.len()` (written as an `i32`, matching the read side), and
    /// `default_palette_id` is emitted iff the format is palette-indexed
    /// (P8 / Index16, i.e. [`SurfacePixelFormat::needs_palette`]) — the exact
    /// condition the reader gates the trailing `Option<u32>` on. The compressed
    /// / JPEG formats (`Dxt*`, `CustomRawJpeg`) are serialized verbatim from
    /// `source_data` (no decode), so `unpack(pack(x)) == x` holds byte-for-byte
    /// for every format.
    ///
    /// INTRA-RECORD validation only: this method does NOT resolve the
    /// `default_palette_id` against a real [`Palette`] nor bounds-check pixel
    /// indices — that cross-record check requires a palette argument the
    /// `DatPack` trait path does not carry, and lives in the dat-write
    /// `pack/texture.rs` separate `Texture::pack_validated`-style path
    /// (E12 design §B, deferred). Here we only ensure the on-wire shape is the
    /// faithful inverse of the read.
    pub fn write<W: Write + Seek>(&self, writer: &mut W) -> BinResult<()> {
        // Last-line structural guard (mirrors Animation::write): the reader
        // gates the trailing default_palette_id on `needs_palette()` ALONE
        // (P8/Index16), so a record whose palette-id presence disagrees with
        // its format could not be re-read after writing — fail closed before
        // emitting any bytes rather than producing a non-re-readable record.
        // (A P8/Index16 record with default_palette_id==None would otherwise
        // write 4 bytes short; a non-indexed record carrying Some would write
        // 4 stray bytes the reader never consumes.) The richer attributable
        // InvariantViolation is raised by the dat-write pack/texture.rs guard
        // on the trait path; this keeps the inherent pack/pack_validated path
        // symmetric and fail-closed too.
        if self.format().needs_palette() != self.default_palette_id.is_some() {
            return Err(binrw::Error::Custom {
                pos: writer.stream_position().unwrap_or(0),
                err: Box::new(TextureWriteError(format!(
                    "format {:?} needs_palette={} but default_palette_id.is_some()={} \
                     (would not round-trip: the reader reads the trailing id iff the \
                     format is P8/Index16)",
                    self.format(),
                    self.format().needs_palette(),
                    self.default_palette_id.is_some(),
                ))),
            });
        }

        self.id.write_le(writer)?;
        self._unknown.write_le(writer)?;
        self.width.write_le(writer)?;
        self.height.write_le(writer)?;
        self.format_raw.write_le(writer)?;
        let length = i32::try_from(self.source_data.len()).map_err(|e| binrw::Error::Custom {
            pos: writer.stream_position().unwrap_or(0),
            err: Box::new(e),
        })?;
        length.write_le(writer)?;
        writer.write_all(&self.source_data)?;
        // The trailing default_palette_id is present iff the format is
        // palette-indexed — exactly the binrw `if` the reader gates it on.
        // The guard above guarantees the Some-ness matches needs_palette(), so
        // this emits the id for every palette-indexed record.
        if self.format().needs_palette() {
            if let Some(pid) = self.default_palette_id {
                pid.write_le(writer)?;
            }
        }
        Ok(())
    }

    /// Pack into a freshly allocated `Vec<u8>` — for byte-equal round-trip
    /// parity against retail Textures.
    pub fn pack(&self) -> Result<Vec<u8>> {
        let mut buf = std::io::Cursor::new(Vec::new());
        self.write(&mut buf)?;
        Ok(buf.into_inner())
    }

    /// CROSS-RECORD validated pack (E12 design §B.5 #11; deferred from the
    /// `DatPack::pack` trait path because that path carries no palette).
    ///
    /// For the palette-indexed formats (P8 / Index16) this resolves the
    /// texture's pixel indices against the supplied [`Palette`] and rejects
    /// (fail-closed, no bytes emitted) any index `>= palette.colors.len()`:
    /// `u8` indices for P8, `u16`-little-endian indices for Index16. The
    /// caller is responsible for passing the palette the texture's
    /// `default_palette_id` resolves to. Non-palettized formats have no
    /// cross-record dependency and pack straight through.
    ///
    /// This lives here (next to the parser) rather than in `holtburger-dat-write`
    /// because the orphan rule forbids an inherent `impl Texture` outside this
    /// crate. The dat-write `DatPack::pack` path runs the INTRA-record guards
    /// (palette-id presence + width×height×bpp); this path adds the cross-record
    /// index-bounds half.
    pub fn pack_validated(&self, palette: &Palette) -> Result<Vec<u8>> {
        let pal_len = palette.colors.len();
        match self.format() {
            SurfacePixelFormat::P8 => {
                for (i, &idx) in self.source_data.iter().enumerate() {
                    if (idx as usize) >= pal_len {
                        return Err(crate::DatError::Corruption(format!(
                            "Texture 0x{:08X}: P8 pixel {i} index {idx} >= palette len {pal_len} (palette 0x{:08X})",
                            self.id, palette.id
                        )));
                    }
                }
            }
            SurfacePixelFormat::Index16 => {
                if self.source_data.len() % 2 != 0 {
                    return Err(crate::DatError::Corruption(format!(
                        "Texture 0x{:08X}: Index16 source_data length {} is not a multiple of 2",
                        self.id,
                        self.source_data.len()
                    )));
                }
                for (i, chunk) in self.source_data.chunks_exact(2).enumerate() {
                    let idx = (chunk[0] as usize) | ((chunk[1] as usize) << 8);
                    if idx >= pal_len {
                        return Err(crate::DatError::Corruption(format!(
                            "Texture 0x{:08X}: Index16 pixel {i} index {idx} >= palette len {pal_len} (palette 0x{:08X})",
                            self.id, palette.id
                        )));
                    }
                }
            }
            // Non-palettized formats have no cross-record dependency.
            _ => {}
        }
        self.pack()
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

    /// Authoritative `(width, height)` for the record. For JPEG, falls
    /// back to the header pair when the SOF peek fails (defensive only —
    /// retail JPEGs are well-formed). For every other format the header
    /// pair is canonical. Use this anywhere the caller will allocate or
    /// report dimensions; the raw `width`/`height` fields are a lie for
    /// `CustomRawJpeg` (Trevis #worldbuilder:253 — dims live in the JPEG
    /// payload, not the DAT header).
    pub fn actual_dimensions(&self) -> (u32, u32) {
        if let Some(dims) = self.jpeg_dimensions() {
            return dims;
        }
        (self.width.max(0) as u32, self.height.max(0) as u32)
    }

    /// Decode `source_data` to a width × height RGBA8 buffer
    /// (`length = width * height * 4`).
    ///
    /// `palette_for` is consulted only when [`SurfacePixelFormat::needs_palette`]
    /// holds. Pass a closure rather than a borrowed `Palette` so callers
    /// can lazily fetch palettes from a `ResourceSource` only on demand —
    /// most terrain textures are `CustomLscapeR8G8B8` and never trigger
    /// the palette path.
    ///
    /// `palette_override` (when `Some(non-zero)`) takes precedence over the
    /// texture's own `default_palette_id` for the palette-indexed formats —
    /// this is the surface-level `orig_palette_id` recolour, matching retail's
    /// `CSurface::SetTextureAndPalette(base1pal)` which applies the Surface's
    /// palette over the Texture's. `None` (or `Some(0)`) → use the texture's
    /// `default_palette_id` as before.
    ///
    /// `clipmap` marks the surface as `Base1ClipMap` (alpha-cutout). For the
    /// palette-indexed formats (P8 / Index16) this reproduces retail
    /// `ImgTex::CopyIntoData` (acclient.c:365958/365980): a pixel whose palette
    /// index is `< 8` is the transparent clip range → emitted as RGBA(0,0,0,0)
    /// rather than the (opaque) palette colour. Non-clipmap or non-palette
    /// decodes ignore it. Without this, Index16/P8 clip-map creature bodies
    /// (dolls, Virindi energy clusters) decode fully opaque and render as
    /// solid boxes.
    fn to_rgba8_impl<F>(
        &self,
        palette_override: Option<u32>,
        clipmap: bool,
        palette_for: F,
    ) -> std::result::Result<Vec<u8>, TextureDecodeError>
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
                let pal_id = palette_override
                    .filter(|&p| p != 0)
                    .or(self.default_palette_id)
                    .ok_or(TextureDecodeError::MissingPaletteId)?;
                let pal = palette_for(pal_id)?;
                if self.source_data.len() < pixels {
                    return Err(TextureDecodeError::ShortRead);
                }
                let mut out = Vec::with_capacity(pixels * 4);
                for i in 0..pixels {
                    let idx = self.source_data[i] as usize;
                    // Retail ImgTex::CopyIntoData (acclient.c:365980): ClipMap
                    // surface → palette index < 8 is the transparent clip range.
                    if clipmap && idx < 8 {
                        out.extend_from_slice(&[0, 0, 0, 0]);
                        continue;
                    }
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
                let pal_id = palette_override
                    .filter(|&p| p != 0)
                    .or(self.default_palette_id)
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
                    // Retail ImgTex::CopyIntoData (acclient.c:365958): ClipMap
                    // surface → palette index < 8 is the transparent clip range.
                    if clipmap && idx < 8 {
                        out.extend_from_slice(&[0, 0, 0, 0]);
                        continue;
                    }
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
            // HUD rec #203 (2026-06-16): DXT2 = BC2 with premultiplied
            // RGB. Wire layout is byte-identical to DXT3 — only the
            // RGB interpretation differs, and our straight-RGBA8 decode
            // emits the stored bytes verbatim, so routing through
            // decompress_dxt3 is the correct shape. Downstream
            // consumers that need straight colour must un-premultiply.
            SurfacePixelFormat::Dxt2 | SurfacePixelFormat::Dxt3 => {
                Ok(super::dxt::decompress_dxt3(&self.source_data, self.width as u32, self.height as u32))
            }
            // HUD rec #203 (2026-06-16): DXT4 = BC3 with premultiplied
            // RGB. Wire layout is byte-identical to DXT5 — only the
            // RGB interpretation differs. Same straight-byte handling
            // as DXT2 above; consumers that need straight colour must
            // un-premultiply.
            SurfacePixelFormat::Dxt4 | SurfacePixelFormat::Dxt5 => {
                Ok(super::dxt::decompress_dxt5(&self.source_data, self.width as u32, self.height as u32))
            }

            other => Err(TextureDecodeError::UnsupportedFormat(other)),
        }
    }

    /// Decode to RGBA8 using the texture's own `default_palette_id` for
    /// palette-indexed formats (the common path — terrain, un-recoloured
    /// statics). Thin wrapper over [`Texture::to_rgba8_impl`].
    pub fn to_rgba8<F>(&self, palette_for: F) -> std::result::Result<Vec<u8>, TextureDecodeError>
    where
        F: FnOnce(u32) -> std::result::Result<Palette, TextureDecodeError>,
    {
        self.to_rgba8_impl(None, false, palette_for)
    }

    /// Like [`Texture::to_rgba8`] but honouring the `Base1ClipMap` surface bit:
    /// for P8/Index16 textures, palette index `< 8` decodes to transparent
    /// (retail `ImgTex::CopyIntoData`). Used by the entity/NPC decode path,
    /// which composes a dyed palette in the `palette_for` closure and so can't
    /// use the `orig_palette_id`-override wrapper.
    pub fn to_rgba8_clipmap<F>(
        &self,
        clipmap: bool,
        palette_for: F,
    ) -> std::result::Result<Vec<u8>, TextureDecodeError>
    where
        F: FnOnce(u32) -> std::result::Result<Palette, TextureDecodeError>,
    {
        self.to_rgba8_impl(None, clipmap, palette_for)
    }

    /// Decode to RGBA8 applying a Surface-level `orig_palette_id` recolour
    /// when non-zero (retail `CSurface::SetTextureAndPalette(base1pal)`),
    /// falling back to the texture's `default_palette_id` when the override
    /// is 0. Non-palettized formats ignore the override entirely.
    ///
    /// `clipmap` marks a `Base1ClipMap` surface — for P8/Index16 textures,
    /// palette index `< 8` decodes to transparent (retail
    /// `ImgTex::CopyIntoData`). Pass the surface's ClipMap bit.
    pub fn to_rgba8_with_palette_override<F>(
        &self,
        surface_palette_id: u32,
        clipmap: bool,
        palette_for: F,
    ) -> std::result::Result<Vec<u8>, TextureDecodeError>
    where
        F: FnOnce(u32) -> std::result::Result<Palette, TextureDecodeError>,
    {
        self.to_rgba8_impl(
            (surface_palette_id != 0).then_some(surface_palette_id),
            clipmap,
            palette_for,
        )
    }
}

/// Fail-closed write guard error (the inherent `Texture::write` last-line
/// structural guard). Boxed into `binrw::Error::Custom` so `pack` /
/// `pack_validated` surface it as an `Err` instead of emitting a
/// non-re-readable record.
#[derive(Debug)]
struct TextureWriteError(String);

impl std::fmt::Display for TextureWriteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Texture write invariant: {}", self.0)
    }
}

impl std::error::Error for TextureWriteError {}

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
    fn pack_is_exact_inverse_of_unpack_non_palettized() {
        // CustomLscapeR8G8B8 (243) — no trailing palette id.
        let pixels = vec![
            0xFF, 0x00, 0x00, 0x00, 0xFF, 0x00, 0x00, 0x00, 0xFF, 0xFF, 0xFF, 0xFF,
        ];
        let buf = make_texture_header(243, 2, 2, &pixels, None);
        let tex = Texture::unpack(&buf).unwrap();
        let packed = tex.pack().unwrap();
        assert_eq!(packed, buf, "pack must be the exact byte inverse of unpack");
        let reparsed = Texture::unpack(&packed).unwrap();
        assert_eq!(reparsed.id, tex.id);
        assert_eq!(reparsed.width, tex.width);
        assert_eq!(reparsed.height, tex.height);
        assert_eq!(reparsed.format_raw, tex.format_raw);
        assert_eq!(reparsed.source_data, tex.source_data);
        assert!(reparsed.default_palette_id.is_none());
    }

    #[test]
    fn pack_is_exact_inverse_of_unpack_palettized() {
        // P8 (41) — trailing default_palette_id present.
        let pixels = vec![0u8, 1, 2];
        let buf = make_texture_header(41, 3, 1, &pixels, Some(0x04001000));
        let tex = Texture::unpack(&buf).unwrap();
        let packed = tex.pack().unwrap();
        assert_eq!(
            packed, buf,
            "palettized pack must include the trailing palette id and be byte-exact"
        );
        let reparsed = Texture::unpack(&packed).unwrap();
        assert_eq!(reparsed.default_palette_id, Some(0x04001000));
    }

    #[test]
    fn pack_validated_accepts_in_bounds_p8_indices() {
        // P8 (41): 2x2, indices {0,1,2,0} into a 3-colour palette.
        let buf = make_texture_header(41, 2, 2, &[0u8, 1, 2, 0], Some(0x04003000));
        let tex = Texture::unpack(&buf).unwrap();
        let pal = Palette {
            id: 0x04003000,
            colors: vec![0xFF000000, 0xFF000001, 0xFF000002],
        };
        let bytes = tex.pack_validated(&pal).expect("in-bounds indices must pass");
        assert_eq!(bytes, tex.pack().unwrap(), "validated pack equals plain pack when in-bounds");
    }

    #[test]
    fn pack_validated_rejects_out_of_bounds_p8_index() {
        // index 5 with a 3-colour palette → out of bounds.
        let buf = make_texture_header(41, 2, 2, &[0u8, 1, 5, 0], Some(0x04003000));
        let tex = Texture::unpack(&buf).unwrap();
        let pal = Palette {
            id: 0x04003000,
            colors: vec![0xFF000000, 0xFF000001, 0xFF000002],
        };
        let err = tex
            .pack_validated(&pal)
            .expect_err("out-of-bounds P8 index must be rejected");
        assert!(
            format!("{err}").contains(">= palette len"),
            "error should attribute the bounds violation: {err}"
        );
    }

    #[test]
    fn pack_validated_rejects_out_of_bounds_index16() {
        // Index16 (101): 1 pixel, index = 5 (le u16) with a 3-colour palette.
        let buf = make_texture_header(101, 1, 1, &[0x05, 0x00], Some(0x04003000));
        let tex = Texture::unpack(&buf).unwrap();
        let pal = Palette {
            id: 0x04003000,
            colors: vec![0xFF000000, 0xFF000001, 0xFF000002],
        };
        let err = tex
            .pack_validated(&pal)
            .expect_err("out-of-bounds Index16 index must be rejected");
        assert!(format!("{err}").contains(">= palette len"), "{err}");
    }

    #[test]
    fn inherent_pack_rejects_indexed_format_missing_palette_id() {
        // P8 (41) with default_palette_id == None: the reader would try to
        // read a trailing u32 that the writer omits, so the inherent pack must
        // fail closed (Err, no panic, no short bytes) rather than emit a
        // non-re-readable record. Constructed directly because unpack always
        // sets Some for indexed formats.
        let tex = Texture {
            id: 0x0600_0042,
            _unknown: 0,
            width: 2,
            height: 2,
            format_raw: 41, // P8
            length: 4,
            source_data: vec![0u8; 4],
            default_palette_id: None,
        };
        let err = tex
            .pack()
            .expect_err("P8 with no palette id must fail closed");
        assert!(
            format!("{err}").contains("needs_palette"),
            "error should attribute the palette-id presence mismatch: {err}"
        );
    }

    #[test]
    fn inherent_pack_rejects_non_indexed_format_carrying_palette_id() {
        // A8R8G8B8 (21) with a stray default_palette_id: the reader never reads
        // a trailing id for non-indexed formats, so emitting one would not
        // round-trip — fail closed.
        let tex = Texture {
            id: 0x0600_0043,
            _unknown: 0,
            width: 1,
            height: 1,
            format_raw: 21, // A8R8G8B8 (not palette-indexed)
            length: 4,
            source_data: vec![0u8; 4],
            default_palette_id: Some(0x0400_2000),
        };
        let err = tex
            .pack()
            .expect_err("non-indexed format carrying a palette id must fail closed");
        assert!(format!("{err}").contains("needs_palette"), "{err}");
    }

    #[test]
    fn pack_serializes_jpeg_source_verbatim() {
        // CustomRawJpeg (500) — header dims are 0,0; payload bytes serialized
        // verbatim (no decode), with no trailing palette id.
        let fake_jpeg = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x01, 0x02, 0x03];
        let buf = make_texture_header(500, 0, 0, &fake_jpeg, None);
        let tex = Texture::unpack(&buf).unwrap();
        let packed = tex.pack().unwrap();
        assert_eq!(packed, buf, "JPEG source must round-trip verbatim");
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
