//! Transitive walk through AC's model graph — Phase 5.1 of
//! `docs/thorough.md`.
//!
//! Given a `ResourceSource` and a starting `model_id`, [`collect_model_dependencies`]
//! enumerates every record the model references through the
//! `GfxObj` → `Surface` → `SurfaceTexture` → `Texture` → `Palette`
//! chain. Used by `dat-shard`'s boot-pack generator and
//! `dat2hba --profile boot` to expand the spawn-area landblock's
//! object placements into a transitive closure of records.
//!
//! Walks accept misses gracefully — missing records simply stop
//! the descent at that branch (matches how the existing
//! `walk_gfx_obj` / `walk_setup_model` colour walks in
//! `apps/holtburger-web` behave). A walk against a partial source
//! produces a partial dependency set rather than failing.

use std::collections::HashSet;
use std::io::Cursor;

use crate::file_type::{SetupModel, Surface, SurfaceTexture, Texture};
use crate::{EOR_PORTAL_NAMESPACE, ResourceKey, ResourceSource};

/// Walk a `(namespace, file_id)` graph starting from a single
/// model id and accumulate every reachable record into `out`.
///
/// Entry-point id classification:
/// - `0x01XXXXXX` → `GfxObj`. Walks the surface list, then each
///   surface's `Surface` → `SurfaceTexture` → `Texture` → `Palette`
///   chain.
/// - `0x02XXXXXX` → `SetupModel`. Recurses into each part id (which
///   are typically GfxObj ids).
/// - Other top-bytes are no-ops (returns the model id alone if it
///   resolves; otherwise nothing).
///
/// The walk is bounded against pathological cycles by a depth cap
/// of 4 SetupModel levels (retail SetupModels never nest more than
/// 1 level deep).
pub fn collect_model_dependencies<S: ResourceSource + ?Sized>(
    source: &S,
    model_id: u32,
    out: &mut HashSet<(String, u32)>,
) {
    walk_model(source, model_id, out, 0);
}

fn walk_model<S: ResourceSource + ?Sized>(
    source: &S,
    model_id: u32,
    out: &mut HashSet<(String, u32)>,
    depth: usize,
) {
    if depth > 4 {
        return;
    }
    if !out.insert((EOR_PORTAL_NAMESPACE.to_string(), model_id)) {
        // Already visited this id earlier in the walk — bail to
        // avoid revisiting subtrees.
        return;
    }
    let Ok(bytes) = source.get_file_by_key(ResourceKey::new(EOR_PORTAL_NAMESPACE, model_id))
    else {
        return;
    };
    match (model_id >> 24) as u8 {
        0x01 => {
            // GfxObj — surface list lives at fixed offset 8 after
            // the [u32 id][u32 flags] header.
            if let Some(surfaces) = read_gfx_obj_surfaces(&bytes) {
                for surface_id in surfaces {
                    walk_surface(source, surface_id, out);
                }
            }
        }
        0x02 => {
            // SetupModel — parts list is the canonical iteration.
            if let Ok(setup) = SetupModel::unpack(&mut Cursor::new(bytes)) {
                for part_id in setup.parts {
                    walk_model(source, part_id, out, depth + 1);
                }
            }
        }
        _ => {}
    }
}

fn walk_surface<S: ResourceSource + ?Sized>(
    source: &S,
    surface_id: u32,
    out: &mut HashSet<(String, u32)>,
) {
    if !out.insert((EOR_PORTAL_NAMESPACE.to_string(), surface_id)) {
        return;
    }
    let Ok(bytes) = source.get_file_by_key(ResourceKey::new(EOR_PORTAL_NAMESPACE, surface_id))
    else {
        return;
    };
    let Ok(surface) = Surface::unpack(&bytes) else {
        return;
    };
    if let Some((surf_tex_id, surface_pal_id)) = surface.textured() {
        if surface_pal_id != 0 {
            // The Surface's `orig_palette_id` is non-canonical for
            // most retail records (typically 0; the Texture's
            // `default_palette_id` is what the decoder uses). Add
            // it anyway when present so downstream callers that
            // need the override see it.
            out.insert((EOR_PORTAL_NAMESPACE.to_string(), surface_pal_id));
        }
        walk_surface_texture(source, surf_tex_id, out);
    }
    // solid_color() surfaces have no texture refs — nothing more
    // to chase.
}

fn walk_surface_texture<S: ResourceSource + ?Sized>(
    source: &S,
    surf_tex_id: u32,
    out: &mut HashSet<(String, u32)>,
) {
    if !out.insert((EOR_PORTAL_NAMESPACE.to_string(), surf_tex_id)) {
        return;
    }
    let Ok(bytes) = source.get_file_by_key(ResourceKey::new(EOR_PORTAL_NAMESPACE, surf_tex_id))
    else {
        return;
    };
    let Ok(surf_tex) = SurfaceTexture::unpack(&bytes) else {
        return;
    };
    // Highest-mip is what the renderer reads first (and what
    // fetch_terrain_textures pulls). Lower mips are deferred —
    // adding them all would balloon the boot pack with content
    // most pages never touch.
    if let Some(tex_id) = surf_tex.highest_res() {
        walk_texture(source, tex_id, out);
    }
}

fn walk_texture<S: ResourceSource + ?Sized>(
    source: &S,
    tex_id: u32,
    out: &mut HashSet<(String, u32)>,
) {
    if !out.insert((EOR_PORTAL_NAMESPACE.to_string(), tex_id)) {
        return;
    }
    let Ok(bytes) = source.get_file_by_key(ResourceKey::new(EOR_PORTAL_NAMESPACE, tex_id)) else {
        return;
    };
    let Ok(tex) = Texture::unpack(&bytes) else {
        return;
    };
    if let Some(pal_id) = tex.default_palette_id {
        out.insert((EOR_PORTAL_NAMESPACE.to_string(), pal_id));
    }
}

/// Read just the `surfaces: Vec<u32>` list from a GfxObj record.
///
/// Header layout: `[u32 id][u32 flags][smart_vec u32 surfaces]`.
/// Stops after the surface list — the rest of the record (vertex
/// array, polygons, BSP) is irrelevant to the boot-pack walk and
/// is the source of failures in the full GfxObj parser. Mirrors
/// the wasm-side `read_gfx_obj_surfaces` in
/// `apps/holtburger-web/src/lib.rs`; both lifted from this same
/// minimal-byte-parsing observation.
pub fn read_gfx_obj_surfaces(bytes: &[u8]) -> Option<Vec<u32>> {
    if bytes.len() < 9 {
        return None;
    }
    let mut pos = 8usize;
    let (count, n) = read_compressed_u32(&bytes[pos..])?;
    pos += n;
    let count = count as usize;
    if bytes.len() < pos.checked_add(count.checked_mul(4)?)? {
        return None;
    }
    let mut surfaces = Vec::with_capacity(count);
    for i in 0..count {
        let off = pos + i * 4;
        let id = u32::from_le_bytes([
            bytes[off],
            bytes[off + 1],
            bytes[off + 2],
            bytes[off + 3],
        ]);
        surfaces.push(id);
    }
    Some(surfaces)
}

/// Variable-width 1/2/4-byte little-endian count used by AC's
/// `read_smart_vec`. Returns `(value, bytes_consumed)`. Distinct
/// from `crate::utils::read_compressed_u32` which takes a
/// `Read + Seek` reader; this byte-slice variant is what static
/// header parsers (boot-pack walk, sprite-gen prep) want.
pub fn read_compressed_u32(bytes: &[u8]) -> Option<(u32, usize)> {
    let b0 = *bytes.first()? as u32;
    if (b0 & 0x80) == 0 {
        Some((b0, 1))
    } else if (b0 & 0x40) == 0 {
        let b1 = *bytes.get(1)? as u32;
        Some((((b0 & 0x7F) << 8) | b1, 2))
    } else {
        let b1 = *bytes.get(1)? as u32;
        let s = u16::from_le_bytes([*bytes.get(2)?, *bytes.get(3)?]) as u32;
        Some(((((b0 & 0x3F) << 8) | b1) << 16 | s, 4))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_compressed_u32_handles_all_three_widths() {
        // 1-byte (top bit clear).
        assert_eq!(read_compressed_u32(&[0x42]), Some((0x42, 1)));
        // 2-byte (0x80..0xC0).
        assert_eq!(read_compressed_u32(&[0x81, 0x23]), Some((0x123, 2)));
        // 4-byte (0xC0..). Layout: (((b0 & 0x3F) << 8 | b1) << 16) | u16le(b2,b3)
        // For [0xC1, 0x23, 0x45, 0x67]: ((0x01 << 8 | 0x23) << 16) | 0x6745
        //   = 0x01230000 | 0x6745 = 0x01236745.
        assert_eq!(
            read_compressed_u32(&[0xC1, 0x23, 0x45, 0x67]),
            Some((0x0123_6745, 4))
        );
        // Bounds: 1 byte input where 2-byte form expected.
        assert_eq!(read_compressed_u32(&[0x81]), None);
    }

    #[test]
    fn read_gfx_obj_surfaces_decodes_minimal_header() {
        // [id u32][flags u32][count varint = 2][surface0 u32][surface1 u32]
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&0x0100_1234u32.to_le_bytes()); // id
        bytes.extend_from_slice(&0u32.to_le_bytes()); // flags
        bytes.push(2); // smart_vec count = 2 (1-byte form)
        bytes.extend_from_slice(&0x0500_BBBBu32.to_le_bytes());
        bytes.extend_from_slice(&0x0500_CCCCu32.to_le_bytes());
        let surfaces = read_gfx_obj_surfaces(&bytes).unwrap();
        assert_eq!(surfaces, vec![0x0500_BBBB, 0x0500_CCCC]);
    }

    #[test]
    fn read_gfx_obj_surfaces_rejects_truncated_input() {
        // Header says count=2, only one surface follows.
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&0u32.to_le_bytes()); // id
        bytes.extend_from_slice(&0u32.to_le_bytes()); // flags
        bytes.push(2); // count=2
        bytes.extend_from_slice(&0x0500_AAAAu32.to_le_bytes());
        // Missing second surface ID.
        assert!(read_gfx_obj_surfaces(&bytes).is_none());
    }

    #[test]
    fn collect_model_dependencies_terminates_on_empty_source() {
        struct EmptySource;
        impl ResourceSource for EmptySource {
            fn get_file_by_key(
                &self,
                _key: ResourceKey<'_>,
            ) -> crate::Result<Vec<u8>> {
                Err(crate::DatError::Other("empty".into()))
            }
            fn get_metadata_by_key(
                &self,
                _key: ResourceKey<'_>,
            ) -> Option<crate::FileMetadata> {
                None
            }
            fn has_namespace(&self, _ns: &str) -> bool {
                false
            }
        }
        let mut out = HashSet::new();
        collect_model_dependencies(&EmptySource, 0x0100_0827, &mut out);
        // The starting id is recorded; the walk bails on the empty
        // body. No descent.
        assert_eq!(out.len(), 1);
        assert!(out.contains(&(EOR_PORTAL_NAMESPACE.to_string(), 0x0100_0827)));
    }
}
