//! AC Surface (DatFileType 0x08) — per-model material info: either a
//! solid ARGB colour or a (texture, palette) reference. Used by the
//! Phase 3 step 4.5 model → colour walk to give each placed
//! `LandblockInfo` object its real per-model tint instead of the
//! 2-bucket category fallback.
//!
//! Format (mirrors `ACE.DatLoader/FileTypes/Surface.cs::Unpack`):
//! ```text
//! [u32 surface_type]                    // SurfaceType bitfield
//! if (type & (Base1Image | Base1ClipMap)) {
//!     [u32 orig_texture_id]
//!     [u32 orig_palette_id]
//! } else {
//!     [u32 color_value]                 // ARGB
//! }
//! [f32 translucency]
//! [f32 luminosity]
//! [f32 diffuse]
//! ```
//!
//! Notably, Surface (unlike Texture / Palette / SurfaceTexture) does
//! NOT include a leading `id` field — the file ID lives in the dat
//! directory entry, not the record body. Total record size is 20 bytes
//! for solid surfaces, 24 bytes for textured (`Base1Image` /
//! `Base1ClipMap`).
//!
//! **Field-naming gotcha:** `OrigTextureId` is misleading — it actually
//! holds a **SurfaceTexture (0x05) ID**, not a Texture / RenderSurface
//! (0x06) ID. To get pixel data, callers walk
//! `Surface.OrigTextureId → SurfaceTexture → highest_res() → Texture`,
//! the same chain `fetch_terrain_textures` uses for the terrain-tile
//! pipeline. This is also the chain documented in
//! `WorldBuilder.Shared/Lib/Texture/RenderSurfaceImporter.cs`
//! (`CreateSurface(gid, surfaceTextureGid)`).
//!
//! `SurfaceType` flag bits (from `ACE.Entity/Enum/SurfaceType.cs`):
//! `Base1Solid = 0x1`, `Base1Image = 0x2`, `Base1ClipMap = 0x4`,
//! `Translucent = 0x10`, etc. The image/clipmap branch fires when
//! either `0x2` or `0x4` is set — mask `0x06`.

use binrw::{BinRead, BinResult, BinWrite, binread};
use std::io::{Seek, Write};

/// Mask matching `Base1Image (0x2) | Base1ClipMap (0x4)`. When either
/// bit is set, the surface body holds `(orig_texture_id, orig_palette_id)`
/// instead of a solid `color_value`.
pub const SURFACE_TYPE_TEXTURE_MASK: u32 = 0x06;

#[binread]
#[derive(Debug, Clone, serde::Serialize)]
#[br(little)]
pub struct TextureRefs {
    pub orig_texture_id: u32,
    pub orig_palette_id: u32,
}

#[binread]
#[derive(Debug, Clone, serde::Serialize)]
#[br(little)]
pub struct Surface {
    pub surface_type: u32,
    /// Present iff `surface_type & 0x06` is non-zero (image / clipmap).
    #[br(if((surface_type & SURFACE_TYPE_TEXTURE_MASK) != 0))]
    pub texture_refs: Option<TextureRefs>,
    /// Present iff `surface_type & 0x06` is zero (solid colour). ARGB,
    /// most-significant byte = alpha.
    #[br(if((surface_type & SURFACE_TYPE_TEXTURE_MASK) == 0))]
    pub color_value: Option<u32>,
    pub translucency: f32,
    pub luminosity: f32,
    pub diffuse: f32,
}

impl Surface {
    pub fn unpack(data: &[u8]) -> Result<Self, binrw::Error> {
        let mut cursor = std::io::Cursor::new(data);
        Self::read(&mut cursor)
    }

    /// Serialize this Surface back into the canonical DAT body layout, the
    /// exact inverse of [`Surface::unpack`]:
    /// ```text
    /// [u32 surface_type]
    /// if (surface_type & 0x06) != 0 { [u32 orig_texture_id][u32 orig_palette_id] }
    /// else                          { [u32 color_value] }
    /// [f32 translucency][f32 luminosity][f32 diffuse]
    /// ```
    /// The body branch is gated by the `surface_type` bitfield exactly as the
    /// reader gates it (mask `0x06` = `Base1Image | Base1ClipMap`), so the
    /// textured / solid bodies are MUTUALLY EXCLUSIVE. The matching field
    /// (`texture_refs` for textured, `color_value` for solid) MUST be present
    /// or this returns an error rather than emitting bytes the reader cannot
    /// re-parse — `unpack(pack(x)) == x` only holds when the in-memory record
    /// agrees with its own type bitfield. (The higher-level write path also
    /// guards this up front via `WriteError::InvariantViolation`.)
    pub fn write<W: Write + Seek>(&self, writer: &mut W) -> BinResult<()> {
        self.surface_type.write_le(writer)?;

        if (self.surface_type & SURFACE_TYPE_TEXTURE_MASK) != 0 {
            // Textured branch: write (orig_texture_id, orig_palette_id).
            let refs = self.texture_refs.as_ref().ok_or_else(|| binrw::Error::AssertFail {
                pos: writer.stream_position().unwrap_or(0),
                message: format!(
                    "Surface type 0x{:08X} is textured (& 0x06) but texture_refs is None",
                    self.surface_type
                ),
            })?;
            refs.orig_texture_id.write_le(writer)?;
            refs.orig_palette_id.write_le(writer)?;
        } else {
            // Solid branch: write the single ARGB color_value.
            let color = self.color_value.ok_or_else(|| binrw::Error::AssertFail {
                pos: writer.stream_position().unwrap_or(0),
                message: format!(
                    "Surface type 0x{:08X} is solid (& 0x06 == 0) but color_value is None",
                    self.surface_type
                ),
            })?;
            color.write_le(writer)?;
        }

        self.translucency.write_le(writer)?;
        self.luminosity.write_le(writer)?;
        self.diffuse.write_le(writer)?;
        Ok(())
    }

    /// Pack into a freshly allocated `Vec<u8>` — for byte-equal round-trip
    /// parity against retail Surfaces.
    pub fn pack(&self) -> Result<Vec<u8>, binrw::Error> {
        let mut buf = std::io::Cursor::new(Vec::new());
        self.write(&mut buf)?;
        Ok(buf.into_inner())
    }

    /// Solid ARGB if the surface stored a `color_value`. `None` for
    /// textured surfaces — caller decides whether to walk the texture
    /// pipeline (Texture + Palette → mean pixel) for those, or fall
    /// back to a category tint. Step 4.5 takes the latter route.
    pub fn solid_color(&self) -> Option<u32> {
        self.color_value
    }

    /// `(orig_texture_id, orig_palette_id)` for textured surfaces; `None`
    /// for solid. Lets a caller defer the texture+palette fetch until
    /// the solid path has been exhausted.
    pub fn textured(&self) -> Option<(u32, u32)> {
        self.texture_refs
            .as_ref()
            .map(|r| (r.orig_texture_id, r.orig_palette_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pack_solid(surface_type: u32, color: u32, translucency: f32, luminosity: f32, diffuse: f32) -> Vec<u8> {
        let mut buf = Vec::new();
        buf.extend_from_slice(&surface_type.to_le_bytes());
        buf.extend_from_slice(&color.to_le_bytes());
        buf.extend_from_slice(&translucency.to_le_bytes());
        buf.extend_from_slice(&luminosity.to_le_bytes());
        buf.extend_from_slice(&diffuse.to_le_bytes());
        buf
    }

    fn pack_textured(surface_type: u32, tex: u32, pal: u32, translucency: f32, luminosity: f32, diffuse: f32) -> Vec<u8> {
        let mut buf = Vec::new();
        buf.extend_from_slice(&surface_type.to_le_bytes());
        buf.extend_from_slice(&tex.to_le_bytes());
        buf.extend_from_slice(&pal.to_le_bytes());
        buf.extend_from_slice(&translucency.to_le_bytes());
        buf.extend_from_slice(&luminosity.to_le_bytes());
        buf.extend_from_slice(&diffuse.to_le_bytes());
        buf
    }

    #[test]
    fn solid_surface_is_20_bytes_and_round_trips() {
        // Base1Solid (0x1) — body is one ARGB colour. 20-byte total.
        let buf = pack_solid(0x01, 0xFF8B6442, 0.0, 0.25, 0.75);
        assert_eq!(buf.len(), 20);
        let surf = Surface::unpack(&buf).unwrap();
        assert_eq!(surf.surface_type, 0x01);
        assert_eq!(surf.color_value, Some(0xFF8B6442));
        assert!(surf.texture_refs.is_none());
        assert_eq!(surf.solid_color(), Some(0xFF8B6442));
        assert_eq!(surf.textured(), None);
        assert_eq!(surf.translucency, 0.0);
        assert_eq!(surf.luminosity, 0.25);
        assert_eq!(surf.diffuse, 0.75);
    }

    #[test]
    fn image_surface_is_24_bytes_and_reads_refs() {
        // Base1Image (0x2) — body is (orig_texture_id, orig_palette_id). 24 bytes.
        let buf = pack_textured(0x02, 0x06001000, 0x04001000, 0.1, 0.2, 0.3);
        assert_eq!(buf.len(), 24);
        let surf = Surface::unpack(&buf).unwrap();
        assert_eq!(surf.surface_type, 0x02);
        assert!(surf.color_value.is_none());
        let refs = surf.texture_refs.as_ref().unwrap();
        assert_eq!(refs.orig_texture_id, 0x06001000);
        assert_eq!(refs.orig_palette_id, 0x04001000);
        assert_eq!(surf.solid_color(), None);
        assert_eq!(surf.textured(), Some((0x06001000, 0x04001000)));
    }

    #[test]
    fn clipmap_surface_takes_texture_branch() {
        // Base1ClipMap (0x4) — same body shape as Image.
        let buf = pack_textured(0x04, 0x06002222, 0x04003333, 0.5, 0.5, 0.5);
        let surf = Surface::unpack(&buf).unwrap();
        assert_eq!(surf.surface_type, 0x04);
        assert_eq!(surf.textured(), Some((0x06002222, 0x04003333)));
    }

    #[test]
    fn pack_is_exact_inverse_of_unpack_solid() {
        // Solid surface: pack must reproduce the source bytes exactly.
        let buf = pack_solid(0x01, 0xFF8B6442, 0.0, 0.25, 0.75);
        let surf = Surface::unpack(&buf).unwrap();
        let packed = surf.pack().unwrap();
        assert_eq!(packed, buf, "solid pack must be the exact byte inverse of unpack");
        assert_eq!(packed.len(), 20);

        let reparsed = Surface::unpack(&packed).unwrap();
        assert_eq!(reparsed.surface_type, 0x01);
        assert_eq!(reparsed.color_value, Some(0xFF8B6442));
        assert!(reparsed.texture_refs.is_none());
    }

    #[test]
    fn pack_is_exact_inverse_of_unpack_textured() {
        // Textured surface (Base1Image 0x02): pack must reproduce the source.
        let buf = pack_textured(0x02, 0x06001000, 0x04001000, 0.1, 0.2, 0.3);
        let surf = Surface::unpack(&buf).unwrap();
        let packed = surf.pack().unwrap();
        assert_eq!(packed, buf, "textured pack must be the exact byte inverse of unpack");
        assert_eq!(packed.len(), 24);

        let reparsed = Surface::unpack(&packed).unwrap();
        assert_eq!(reparsed.surface_type, 0x02);
        assert!(reparsed.color_value.is_none());
        assert_eq!(reparsed.textured(), Some((0x06001000, 0x04001000)));
    }

    #[test]
    fn pack_clipmap_round_trips() {
        // Base1ClipMap (0x04) also takes the textured branch.
        let buf = pack_textured(0x04, 0x06002222, 0x04003333, 0.5, 0.5, 0.5);
        let surf = Surface::unpack(&buf).unwrap();
        let packed = surf.pack().unwrap();
        assert_eq!(packed, buf);
    }

    #[test]
    fn combined_solid_and_translucent_flags_still_solid() {
        // Base1Solid (0x1) | Translucent (0x10) — translucent flag does
        // not flip the body to texture.
        let buf = pack_solid(0x11, 0x80FF0000, 0.0, 0.0, 1.0);
        let surf = Surface::unpack(&buf).unwrap();
        assert_eq!(surf.surface_type, 0x11);
        assert_eq!(surf.solid_color(), Some(0x80FF0000));
    }

    /// Probe retail surfaces 0x08000040 (target — used by GfxObj
    /// 0x01001A62), 0x080000D5 (cloud-band reference), 0x080000C5
    /// (weather-streak reference). Decodes the SurfaceType bitfield,
    /// resolves the SurfaceTexture → highest-res Texture chain, and
    /// dumps the pixel data to /tmp as a binary PPM (trivially
    /// `convert` -able to PNG) when textured.
    ///
    /// Locates client_portal.dat via the same convention as
    /// `region::tests::locate_portal_dat`.
    #[test]
    fn probe_retail_surface_chain_for_holtburger() {
        use crate::DatDatabase;
        use crate::file_type::palette::Palette;
        use crate::file_type::surface_texture::SurfaceTexture;
        use crate::file_type::texture::{SurfacePixelFormat, Texture};
        use std::io::Write;

        let path = if let Some(p) = crate::utils::get_portal_dat_path() {
            p
        } else {
            let c = std::path::PathBuf::from("/home/wbterminal/ac_base_dats/client_portal.dat");
            if c.exists() {
                c
            } else {
                eprintln!("[probe_retail_surface_chain_for_holtburger] SKIP — no dat");
                return;
            }
        };
        let dat = DatDatabase::new(&path).expect("open client_portal.dat");

        fn flags_string(t: u32) -> String {
            let mut v = Vec::new();
            if t & 0x1 != 0       { v.push("Base1Solid"); }
            if t & 0x2 != 0       { v.push("Base1Image"); }
            if t & 0x4 != 0       { v.push("Base1ClipMap"); }
            if t & 0x10 != 0      { v.push("Translucent"); }
            if t & 0x20 != 0      { v.push("Diffuse"); }
            if t & 0x40 != 0      { v.push("Luminous"); }
            if t & 0x100 != 0     { v.push("Alpha"); }
            if t & 0x200 != 0     { v.push("InvAlpha"); }
            if t & 0x10000 != 0   { v.push("Additive"); }
            if t & 0x20000 != 0   { v.push("Detail"); }
            if t & 0x10000000 != 0 { v.push("Gouraud"); }
            if t & 0x40000000 != 0 { v.push("Stippled"); }
            if t & 0x80000000 != 0 { v.push("Perspective"); }
            v.join(" | ")
        }

        for &sid in &[0x08000040u32, 0x080000D5u32, 0x080000C5u32] {
            eprintln!("\n========== Surface 0x{:08X} ==========", sid);
            let raw = match dat.get_file(sid) {
                Ok(b) => b,
                Err(e) => { eprintln!("  NOT FOUND in dat: {:?}", e); continue; }
            };
            let n = raw.len().min(32);
            let hex: String = raw[..n].iter().map(|b| format!("{:02x}", b)).collect::<Vec<_>>().join(" ");
            eprintln!("  raw bytes ({}B total): {}", raw.len(), hex);

            let surf = match Surface::unpack(&raw) {
                Ok(s) => s,
                Err(e) => { eprintln!("  unpack error: {:?}", e); continue; }
            };
            eprintln!("  surface_type: 0x{:08X}  flags: [{}]", surf.surface_type, flags_string(surf.surface_type));
            eprintln!("  translucency={} luminosity={} diffuse={}", surf.translucency, surf.luminosity, surf.diffuse);

            if let Some((tex_id, pal_id)) = surf.textured() {
                eprintln!("  TEXTURED: orig_texture_id=0x{:08X} (SurfaceTexture 0x05) orig_palette_id=0x{:08X}", tex_id, pal_id);

                let st_raw = match dat.get_file(tex_id) {
                    Ok(b) => b,
                    Err(e) => { eprintln!("  SurfaceTexture not found: {:?}", e); continue; }
                };
                let st = match SurfaceTexture::unpack(&st_raw) {
                    Ok(s) => s,
                    Err(e) => { eprintln!("  SurfaceTexture unpack err: {:?}", e); continue; }
                };
                eprintln!("    SurfaceTexture 0x{:08X}: unknown_int={} unknown_byte={} mips={:?}",
                    st.id, st.unknown_int, st.unknown_byte,
                    st.textures.iter().map(|i| format!("0x{:08X}", i)).collect::<Vec<_>>());

                let hr = match st.highest_res() {
                    Some(h) => h,
                    None => { eprintln!("    no mips!"); continue; }
                };
                let t_raw = match dat.get_file(hr) {
                    Ok(b) => b,
                    Err(e) => { eprintln!("    Texture not found: {:?}", e); continue; }
                };
                let tex = match Texture::unpack(&t_raw) {
                    Ok(t) => t,
                    Err(e) => { eprintln!("    Texture unpack err: {:?}", e); continue; }
                };
                eprintln!("    Texture 0x{:08X}: {}x{} format={:?} (raw={}) length={} default_palette_id={:?}",
                    tex.id, tex.width, tex.height, tex.format(), tex.format_raw, tex.length, tex.default_palette_id);

                // Decode pixels. For palettized, try Surface.orig_palette_id first, fall back to default_palette_id.
                let pal_fetch = |pid: u32| -> std::result::Result<Palette, crate::file_type::texture::TextureDecodeError> {
                    dat.get_file(pid)
                        .map_err(|e| crate::file_type::texture::TextureDecodeError::PaletteFetch(format!("{:?}", e)))
                        .and_then(|b| Palette::unpack(&b)
                            .map_err(|e| crate::file_type::texture::TextureDecodeError::PaletteFetch(format!("{:?}", e))))
                };

                // For P8/Index16, Surface.orig_palette_id overrides default_palette_id.
                let needs_pal = matches!(tex.format(), SurfacePixelFormat::P8 | SurfacePixelFormat::Index16);
                let rgba_result = if needs_pal && pal_id != 0 {
                    tex.to_rgba8(|_| pal_fetch(pal_id))
                } else {
                    tex.to_rgba8(pal_fetch)
                };
                let rgba = match rgba_result {
                    Ok(p) => p,
                    Err(e) => { eprintln!("    decode err: {}", e); continue; }
                };

                // Dump as a binary PPM (P6) — easy to convert with `convert in.ppm out.png`.
                let out_path = format!("/tmp/probe_surface_{:08X}.ppm", sid);
                let mut f = std::fs::File::create(&out_path).expect("create ppm");
                writeln!(f, "P6\n{} {}\n255", tex.width, tex.height).unwrap();
                // RGBA → RGB (strip alpha).
                let mut rgb = Vec::with_capacity((tex.width * tex.height * 3) as usize);
                for chunk in rgba.chunks_exact(4) {
                    rgb.extend_from_slice(&chunk[..3]);
                }
                f.write_all(&rgb).unwrap();
                eprintln!("    wrote {} ({}x{} RGB)", out_path, tex.width, tex.height);

                // Compute average pixel color.
                let mut r_sum = 0u64; let mut g_sum = 0u64; let mut b_sum = 0u64; let mut a_sum = 0u64;
                let n = (tex.width * tex.height) as u64;
                for chunk in rgba.chunks_exact(4) {
                    r_sum += chunk[0] as u64;
                    g_sum += chunk[1] as u64;
                    b_sum += chunk[2] as u64;
                    a_sum += chunk[3] as u64;
                }
                eprintln!("    avg RGBA: ({:>3}, {:>3}, {:>3}, {:>3})",
                    r_sum/n, g_sum/n, b_sum/n, a_sum/n);
            } else if let Some(c) = surf.solid_color() {
                eprintln!("  SOLID ARGB: 0x{:08X}  (A={} R={} G={} B={})",
                    c, (c >> 24) & 0xFF, (c >> 16) & 0xFF, (c >> 8) & 0xFF, c & 0xFF);
            }
        }

        // Done — this is a probe test, no assertion beyond the prints.
    }
}
