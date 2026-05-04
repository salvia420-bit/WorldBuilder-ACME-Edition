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
//! `SurfaceType` flag bits (from `ACE.Entity/Enum/SurfaceType.cs`):
//! `Base1Solid = 0x1`, `Base1Image = 0x2`, `Base1ClipMap = 0x4`,
//! `Translucent = 0x10`, etc. The image/clipmap branch fires when
//! either `0x2` or `0x4` is set — mask `0x06`.

use binrw::{BinRead, binread};

/// Mask matching `Base1Image (0x2) | Base1ClipMap (0x4)`. When either
/// bit is set, the surface body holds `(orig_texture_id, orig_palette_id)`
/// instead of a solid `color_value`.
pub const SURFACE_TYPE_TEXTURE_MASK: u32 = 0x06;

#[binread]
#[derive(Debug, Clone)]
#[br(little)]
pub struct TextureRefs {
    pub orig_texture_id: u32,
    pub orig_palette_id: u32,
}

#[binread]
#[derive(Debug, Clone)]
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
    fn combined_solid_and_translucent_flags_still_solid() {
        // Base1Solid (0x1) | Translucent (0x10) — translucent flag does
        // not flip the body to texture.
        let buf = pack_solid(0x11, 0x80FF0000, 0.0, 0.0, 1.0);
        let surf = Surface::unpack(&buf).unwrap();
        assert_eq!(surf.surface_type, 0x11);
        assert_eq!(surf.solid_color(), Some(0x80FF0000));
    }
}
