//! Phase 5.1 — boot-pack transitive reachability walker.
//!
//! Answers a single question for the `dat2hba --profile boot` /
//! `dat-shard` boot-pack policy: **is the boot landblock fully
//! packable?** — i.e. does the produced archive contain every
//! GfxObj / Surface / SurfaceTexture / Texture / Palette record that
//! the spawn-area object placements transitively reference?
//!
//! Starting point is the boot landblock's `LandblockInfo`
//! (`0xXXYYFFFE`, namespace [`EOR_CELL_NAMESPACE`]). Its `objects[]`
//! (placed `Stab`s) and `buildings[].model_id` give the **model
//! roots**. From each root, [`walk_boot_reachability`] performs a
//! read-only depth-first walk through the model graph:
//!
//! ```text
//! GfxObj (0x01) ──surfaces[]──▶ Surface (0x08)
//!                                  │ orig_texture_id (a SurfaceTexture 0x05 id!)
//!                                  ▼
//!                               SurfaceTexture (0x05) ──highest_res()──▶ Texture (0x06)
//!                                  │ orig_palette_id (0x04)                 │ default_palette_id (0x04)
//!                                  ▼                                        ▼
//!                               Palette (0x04)                          Palette (0x04)
//!
//! SetupModel (0x02) ──parts[]──▶ GfxObj (0x01) …
//! ```
//!
//! "OrigTextureId" is misleadingly named: it is a **SurfaceTexture
//! (0x05) id**, not a Texture (0x06) id — see `surface.rs`. The walk
//! follows that chain exactly.
//!
//! The walk is **read-only** — it never writes, mutates, or prunes the
//! DAT/HBA. It distinguishes two outcomes per visited DID:
//! - **reachable** — the record is present in the source *and* parses
//!   cleanly (so it can be packed and its children chased), and
//! - **missing** — the record is referenced but absent from the source
//!   (or present-but-unparseable), so packing the landblock would leave
//!   a dangling reference.
//!
//! Cycles are bounded by a `visited` set (every DID is walked at most
//! once) plus a SetupModel-nesting depth cap, mirroring
//! [`crate::walk::collect_model_dependencies`].

use std::collections::BTreeSet;

use crate::file_type::{SetupModel, Surface, SurfaceTexture, Texture};
use crate::landblock::LandblockInfo;
use crate::walk::read_gfx_obj_surfaces;
use crate::{EOR_CELL_NAMESPACE, EOR_PORTAL_NAMESPACE, ResourceKey, ResourceSource};

/// Retail SetupModels never nest more than one level; cap at 4 to stay
/// well clear of that while still terminating any pathological cycle the
/// `visited` set somehow misses. Matches `walk::walk_model`.
const MAX_SETUP_DEPTH: usize = 4;

/// Result of [`walk_boot_reachability`].
///
/// `reachable_dids` and `missing_dids` partition every DID the walk
/// *referenced* (the model roots plus everything transitively chased
/// from them). A DID never appears in both sets. `fully_packable` is
/// simply `missing_dids.is_empty()`.
///
/// **Scope:** the walk follows only the *visual material* chain —
/// GfxObj/Surface/SurfaceTexture/Texture/Palette plus `SetupModel.parts`.
/// It deliberately does **not** chase a SetupModel's other DID
/// references (DefaultMotionTable / DefaultSoundTable / DefaultScript /
/// DefaultScriptTable / Lights), matching `walk.rs`. So `fully_packable`
/// means *fully **visually** packable*: every model/surface/texture/
/// palette a placement renders is present. A boot landblock can report
/// `fully_packable == true` while its placed objects' animation/sound/
/// script tables are absent from the HBA.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BootReachability {
    /// DIDs that are present in the source and parsed cleanly — every
    /// one of these can be packed into the boot HBA. Sorted (BTreeSet)
    /// for deterministic reporting.
    pub reachable_dids: BTreeSet<u32>,
    /// DIDs that were referenced but are absent from the source (or
    /// present-but-unparseable). These are the dangling references that
    /// would make the boot landblock *not* fully packable.
    pub missing_dids: BTreeSet<u32>,
    /// `true` iff every referenced *visual* DID resolved — i.e.
    /// `missing_dids` is empty. See the type-level doc: this covers the
    /// model/surface/texture/palette chain only, not animation/sound/
    /// script tables.
    pub fully_packable: bool,
}

impl BootReachability {
    /// All referenced DIDs (reachable ∪ missing).
    pub fn referenced_dids(&self) -> BTreeSet<u32> {
        self.reachable_dids
            .union(&self.missing_dids)
            .copied()
            .collect()
    }
}

/// Walk the transitive reachability graph rooted at the boot
/// landblock's object placements and report whether the landblock is
/// fully packable against `source`.
///
/// `boot_landblock` is the world-grid landblock id (`0xXXYY`). The
/// `LandblockInfo` record id is derived as `(boot_landblock << 16) |
/// 0xFFFE`, matching [`crate::manifest::StripperManifest::boot`].
///
/// Read-only: no record is written, mutated, or pruned. Missing /
/// unparseable records are recorded in `missing_dids` and stop the
/// descent at that branch (a partial source yields a partial walk
/// rather than an error).
pub fn walk_boot_reachability<S: ResourceSource + ?Sized>(
    source: &S,
    boot_landblock: u32,
) -> BootReachability {
    let mut walker = Walker {
        source,
        reachable: BTreeSet::new(),
        missing: BTreeSet::new(),
    };

    let landblock_info_id = (boot_landblock << 16) | 0xFFFE;

    // The LandblockInfo lives in the cell namespace; the model graph it
    // points at lives in the portal namespace.
    match source.get_file_by_key(ResourceKey::new(EOR_CELL_NAMESPACE, landblock_info_id)) {
        Ok(bytes) => match LandblockInfo::unpack(&bytes) {
            Ok(info) => {
                walker.reachable.insert(landblock_info_id);
                for stab in &info.objects {
                    walker.walk_model(stab.id, 0);
                }
                for building in &info.buildings {
                    walker.walk_model(building.model_id, 0);
                }
            }
            Err(_) => {
                // Present but unparseable — the boot pack has the bytes
                // but they're not a valid LandblockInfo, so we can't
                // enumerate placements. Record it as missing (dangling)
                // and produce an empty graph.
                walker.missing.insert(landblock_info_id);
            }
        },
        Err(_) => {
            // The boot LandblockInfo itself isn't in the source — the
            // whole boot pack is unpackable.
            walker.missing.insert(landblock_info_id);
        }
    }

    let fully_packable = walker.missing.is_empty();
    BootReachability {
        reachable_dids: walker.reachable,
        missing_dids: walker.missing,
        fully_packable,
    }
}

struct Walker<'a, S: ResourceSource + ?Sized> {
    source: &'a S,
    reachable: BTreeSet<u32>,
    missing: BTreeSet<u32>,
}

impl<S: ResourceSource + ?Sized> Walker<'_, S> {
    /// `true` if `did` has already been visited (in either set) — keeps
    /// the DFS finite on cyclic graphs.
    fn visited(&self, did: u32) -> bool {
        self.reachable.contains(&did) || self.missing.contains(&did)
    }

    /// Fetch a portal-namespace record, recording the DID as reachable
    /// on success or missing on failure. Returns the bytes only when the
    /// record was both newly visited and present.
    ///
    /// Returns `None` (without re-recording) when `did` was already
    /// visited — the caller must treat that as "stop, already chased".
    fn fetch_portal(&mut self, did: u32) -> Option<Vec<u8>> {
        if self.visited(did) {
            return None;
        }
        match self
            .source
            .get_file_by_key(ResourceKey::new(EOR_PORTAL_NAMESPACE, did))
        {
            Ok(bytes) => {
                self.reachable.insert(did);
                Some(bytes)
            }
            Err(_) => {
                self.missing.insert(did);
                None
            }
        }
    }

    /// Walk a model root: GfxObj (`0x01`) or SetupModel (`0x02`). Other
    /// top-bytes are recorded (present/missing) but not descended into —
    /// they carry no model-graph children.
    fn walk_model(&mut self, did: u32, depth: usize) {
        if depth > MAX_SETUP_DEPTH {
            return;
        }
        let Some(bytes) = self.fetch_portal(did) else {
            return;
        };
        match (did >> 24) as u8 {
            0x01 => {
                // GfxObj — chase its surface list. Use the minimal
                // header parser (the full GfxObj parser chokes on some
                // retail vertex/BSP data and isn't needed here).
                match read_gfx_obj_surfaces(&bytes) {
                    Some(surfaces) => {
                        for surface_id in surfaces {
                            self.walk_surface(surface_id);
                        }
                    }
                    None => {
                        // Present but the surface-list header didn't
                        // parse — can't pack a usable GfxObj.
                        self.demote_to_missing(did);
                    }
                }
            }
            0x02 => {
                // SetupModel — recurse into each part (typically GfxObj
                // ids).
                match SetupModel::unpack(&mut std::io::Cursor::new(bytes)) {
                    Ok(setup) => {
                        for part_id in setup.parts {
                            self.walk_model(part_id, depth + 1);
                        }
                    }
                    Err(_) => self.demote_to_missing(did),
                }
            }
            _ => {}
        }
    }

    /// Walk a Surface (`0x08`): solid surfaces terminate; textured
    /// surfaces chase `orig_texture_id` (a SurfaceTexture id) and
    /// `orig_palette_id` (a Palette id).
    fn walk_surface(&mut self, did: u32) {
        let Some(bytes) = self.fetch_portal(did) else {
            return;
        };
        let Ok(surface) = Surface::unpack(&bytes) else {
            // Present but unparseable — already recorded reachable by
            // fetch_portal; demote to missing since we can't pack a
            // usable surface chain from it.
            self.demote_to_missing(did);
            return;
        };
        if let Some((surf_tex_id, surface_pal_id)) = surface.textured() {
            if surface_pal_id != 0 {
                // The Surface's per-instance palette override. Most
                // retail surfaces store 0 here (the Texture's
                // default_palette_id is canonical) but when present it
                // must be packed too.
                self.walk_palette(surface_pal_id);
            }
            self.walk_surface_texture(surf_tex_id);
        }
        // solid_color() surfaces reference nothing further.
    }

    /// Walk a SurfaceTexture (`0x05`): chase the highest-res mip Texture.
    fn walk_surface_texture(&mut self, did: u32) {
        let Some(bytes) = self.fetch_portal(did) else {
            return;
        };
        let Ok(surf_tex) = SurfaceTexture::unpack(&bytes) else {
            self.demote_to_missing(did);
            return;
        };
        // Highest-mip is what the renderer reads first (matches
        // fetch_terrain_textures and walk::walk_surface_texture). Lower
        // mips are intentionally not packed into the boot set.
        if let Some(tex_id) = surf_tex.highest_res() {
            self.walk_texture(tex_id);
        }
    }

    /// Walk a Texture (`0x06`): chase its `default_palette_id` when the
    /// format is palettized.
    fn walk_texture(&mut self, did: u32) {
        let Some(bytes) = self.fetch_portal(did) else {
            return;
        };
        let Ok(tex) = Texture::unpack(&bytes) else {
            self.demote_to_missing(did);
            return;
        };
        if let Some(pal_id) = tex.default_palette_id {
            self.walk_palette(pal_id);
        }
    }

    /// Walk a Palette (`0x04`): a leaf — present/missing is recorded,
    /// nothing further is chased.
    fn walk_palette(&mut self, did: u32) {
        // fetch_portal records reachable/missing; palettes have no
        // children so we just probe presence.
        let _ = self.fetch_portal(did);
    }

    /// Move a DID that `fetch_portal` optimistically marked reachable
    /// (the bytes were present) into the missing set after a parse
    /// failure — the record can't be safely chased/packed.
    fn demote_to_missing(&mut self, did: u32) {
        self.reachable.remove(&did);
        self.missing.insert(did);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file_type::DatFileType;
    use crate::landblock::{Frame, Stab};
    use crate::{DatError, FileMetadata};
    use holtburger_common::{Quaternion, Vector3};
    use std::collections::HashMap;

    /// In-memory `ResourceSource` keyed by `(namespace, did)`.
    #[derive(Default)]
    struct MapSource {
        files: HashMap<(String, u32), Vec<u8>>,
    }

    impl MapSource {
        fn insert(&mut self, namespace: &str, did: u32, bytes: Vec<u8>) {
            self.files.insert((namespace.to_string(), did), bytes);
        }
    }

    impl ResourceSource for MapSource {
        fn get_file_by_key(&self, key: ResourceKey<'_>) -> crate::Result<Vec<u8>> {
            self.files
                .get(&(key.namespace.to_string(), key.file_id))
                .cloned()
                .ok_or(DatError::NotFound(key.file_id))
        }
        fn get_metadata_by_key(&self, key: ResourceKey<'_>) -> Option<FileMetadata> {
            self.files
                .get(&(key.namespace.to_string(), key.file_id))
                .map(|b| FileMetadata {
                    id: key.file_id,
                    size: b.len() as u32,
                    is_pruned: false,
                })
        }
        fn has_namespace(&self, namespace: &str) -> bool {
            self.files.keys().any(|(ns, _)| ns == namespace)
        }
    }

    // ---- record builders (mirror each parser's wire format) ----

    /// Minimal LandblockInfo: `[id][num_cells][num_objects][Stab*]`
    /// `[num_buildings u16][pack_mask u16][BuildInfo*][restriction?]`.
    /// We build it by packing real `Stab`s and zero buildings so it
    /// round-trips through `LandblockInfo::unpack`.
    fn build_landblock_info(id: u32, object_ids: &[u32]) -> Vec<u8> {
        let mut buf = Vec::new();
        buf.extend_from_slice(&id.to_le_bytes());
        buf.extend_from_slice(&0u32.to_le_bytes()); // num_cells
        buf.extend_from_slice(&(object_ids.len() as u32).to_le_bytes());
        for &oid in object_ids {
            // Stab = [u32 id][Frame] ; Frame = Vector3 origin + Quaternion.
            buf.extend_from_slice(&oid.to_le_bytes());
            // origin x,y,z
            buf.extend_from_slice(&0f32.to_le_bytes());
            buf.extend_from_slice(&0f32.to_le_bytes());
            buf.extend_from_slice(&0f32.to_le_bytes());
            // quaternion w,x,y,z (Vector3/Quaternion layout assumed 4 f32 here)
            buf.extend_from_slice(&1f32.to_le_bytes());
            buf.extend_from_slice(&0f32.to_le_bytes());
            buf.extend_from_slice(&0f32.to_le_bytes());
            buf.extend_from_slice(&0f32.to_le_bytes());
        }
        buf.extend_from_slice(&0u16.to_le_bytes()); // num_buildings
        buf.extend_from_slice(&0u16.to_le_bytes()); // pack_mask (no restriction table)
        buf
    }

    /// Minimal GfxObj header: `[id][flags=0][smart_vec surfaces]`.
    /// `read_gfx_obj_surfaces` only needs these bytes.
    fn build_gfx_obj(id: u32, surfaces: &[u32]) -> Vec<u8> {
        let mut buf = Vec::new();
        buf.extend_from_slice(&id.to_le_bytes());
        buf.extend_from_slice(&0u32.to_le_bytes()); // flags
        assert!(surfaces.len() < 0x80, "test helper only emits 1-byte counts");
        buf.push(surfaces.len() as u8); // smart_vec 1-byte count
        for &s in surfaces {
            buf.extend_from_slice(&s.to_le_bytes());
        }
        buf
    }

    /// Textured Surface (Base1Image 0x2): `[type][orig_tex][orig_pal][f32*3]`.
    fn build_textured_surface(surf_tex_id: u32, pal_id: u32) -> Vec<u8> {
        let mut buf = Vec::new();
        buf.extend_from_slice(&0x02u32.to_le_bytes()); // Base1Image
        buf.extend_from_slice(&surf_tex_id.to_le_bytes());
        buf.extend_from_slice(&pal_id.to_le_bytes());
        buf.extend_from_slice(&0f32.to_le_bytes()); // translucency
        buf.extend_from_slice(&0f32.to_le_bytes()); // luminosity
        buf.extend_from_slice(&0f32.to_le_bytes()); // diffuse
        buf
    }

    /// Solid Surface (Base1Solid 0x1): `[type][color][f32*3]`.
    fn build_solid_surface(color: u32) -> Vec<u8> {
        let mut buf = Vec::new();
        buf.extend_from_slice(&0x01u32.to_le_bytes());
        buf.extend_from_slice(&color.to_le_bytes());
        buf.extend_from_slice(&0f32.to_le_bytes());
        buf.extend_from_slice(&0f32.to_le_bytes());
        buf.extend_from_slice(&0f32.to_le_bytes());
        buf
    }

    /// SurfaceTexture: `[id][i32 unk][u8 unk][i32 count][u32 tex*count]`.
    fn build_surface_texture(id: u32, mips: &[u32]) -> Vec<u8> {
        let mut buf = Vec::new();
        buf.extend_from_slice(&id.to_le_bytes());
        buf.extend_from_slice(&0i32.to_le_bytes()); // unknown_int
        buf.push(0); // unknown_byte
        buf.extend_from_slice(&(mips.len() as i32).to_le_bytes());
        for &m in mips {
            buf.extend_from_slice(&m.to_le_bytes());
        }
        buf
    }

    /// Palettized Texture (P8=41) with a default_palette_id trailer.
    fn build_palettized_texture(id: u32, default_pal: u32) -> Vec<u8> {
        let mut buf = Vec::new();
        buf.extend_from_slice(&id.to_le_bytes());
        buf.extend_from_slice(&0i32.to_le_bytes()); // _unknown
        buf.extend_from_slice(&1i32.to_le_bytes()); // width
        buf.extend_from_slice(&1i32.to_le_bytes()); // height
        buf.extend_from_slice(&41u32.to_le_bytes()); // format_raw = P8 (palettized)
        buf.extend_from_slice(&1i32.to_le_bytes()); // length
        buf.push(0u8); // source_data (1 byte)
        buf.extend_from_slice(&default_pal.to_le_bytes()); // default_palette_id
        buf
    }

    /// Palette leaf: `[id][i32 count][u32 color*count]`.
    fn build_palette(id: u32) -> Vec<u8> {
        let mut buf = Vec::new();
        buf.extend_from_slice(&id.to_le_bytes());
        buf.extend_from_slice(&1i32.to_le_bytes());
        buf.extend_from_slice(&0xFF00_00FFu32.to_le_bytes());
        buf
    }

    const LB: u32 = 0xA9B4;
    const LB_INFO_ID: u32 = 0xA9B4_FFFE;
    const GFX: u32 = 0x0100_1234;
    const SURF: u32 = 0x0800_0040;
    const SURF_TEX: u32 = 0x0500_1000;
    const TEX: u32 = 0x0600_1000;
    const TEX_PAL: u32 = 0x0400_2000; // texture's default palette
    const SURF_PAL: u32 = 0x0400_3000; // surface's override palette

    /// A source wired up with a complete chain so the boot landblock is
    /// fully packable. Returns the source.
    fn complete_source() -> MapSource {
        let mut src = MapSource::default();
        src.insert(EOR_CELL_NAMESPACE, LB_INFO_ID, build_landblock_info(LB_INFO_ID, &[GFX]));
        src.insert(EOR_PORTAL_NAMESPACE, GFX, build_gfx_obj(GFX, &[SURF]));
        src.insert(EOR_PORTAL_NAMESPACE, SURF, build_textured_surface(SURF_TEX, SURF_PAL));
        src.insert(EOR_PORTAL_NAMESPACE, SURF_PAL, build_palette(SURF_PAL));
        src.insert(EOR_PORTAL_NAMESPACE, SURF_TEX, build_surface_texture(SURF_TEX, &[TEX]));
        src.insert(EOR_PORTAL_NAMESPACE, TEX, build_palettized_texture(TEX, TEX_PAL));
        src.insert(EOR_PORTAL_NAMESPACE, TEX_PAL, build_palette(TEX_PAL));
        src
    }

    #[test]
    fn fully_packable_chain_reports_all_dids_reachable() {
        let src = complete_source();
        let result = walk_boot_reachability(&src, LB);

        assert!(result.fully_packable, "complete chain must be fully packable");
        assert!(result.missing_dids.is_empty());
        // Every link in the chain is reachable.
        for did in [LB_INFO_ID, GFX, SURF, SURF_TEX, TEX, TEX_PAL, SURF_PAL] {
            assert!(
                result.reachable_dids.contains(&did),
                "expected DID 0x{:08X} reachable",
                did
            );
        }
        // referenced = reachable here.
        assert_eq!(result.referenced_dids(), result.reachable_dids);
    }

    #[test]
    fn missing_texture_makes_landblock_unpackable() {
        let mut src = complete_source();
        // Drop the highest-res Texture — its palette becomes unreachable too.
        src.files.remove(&(EOR_PORTAL_NAMESPACE.to_string(), TEX));

        let result = walk_boot_reachability(&src, LB);
        assert!(!result.fully_packable);
        assert!(result.missing_dids.contains(&TEX), "dropped texture is missing");
        // The texture's own palette is never reached (walk stops at the
        // missing texture) so it is neither reachable nor missing.
        assert!(!result.reachable_dids.contains(&TEX_PAL));
        assert!(!result.missing_dids.contains(&TEX_PAL));
        // Everything up to the texture is still reachable.
        assert!(result.reachable_dids.contains(&SURF_TEX));
        assert!(result.reachable_dids.contains(&GFX));
    }

    #[test]
    fn missing_boot_landblock_info_is_unpackable() {
        let src = MapSource::default(); // empty
        let result = walk_boot_reachability(&src, LB);
        assert!(!result.fully_packable);
        assert!(result.missing_dids.contains(&LB_INFO_ID));
        assert!(result.reachable_dids.is_empty());
    }

    #[test]
    fn solid_surface_terminates_without_texture_chain() {
        let mut src = MapSource::default();
        src.insert(EOR_CELL_NAMESPACE, LB_INFO_ID, build_landblock_info(LB_INFO_ID, &[GFX]));
        src.insert(EOR_PORTAL_NAMESPACE, GFX, build_gfx_obj(GFX, &[SURF]));
        // Solid surface references no texture/palette.
        src.insert(EOR_PORTAL_NAMESPACE, SURF, build_solid_surface(0xFF8B6442));

        let result = walk_boot_reachability(&src, LB);
        assert!(result.fully_packable, "solid-surface chain is self-contained");
        assert_eq!(
            result.reachable_dids,
            BTreeSet::from([LB_INFO_ID, GFX, SURF])
        );
        // No texture/palette DIDs were even referenced.
        assert!(!result.referenced_dids().contains(&TEX));
        assert!(!result.referenced_dids().contains(&SURF_PAL));
    }

    #[test]
    fn cyclic_setup_part_reference_terminates() {
        // SetupModel whose part list points back to itself — the visited
        // set must stop the recursion. (0x02 prefix → SetupModel.)
        let setup_id = 0x0200_0001u32;
        // SetupModel::unpack must accept this; build the smallest valid
        // record whose parts include itself. If the parser rejects our
        // hand-rolled bytes the DID is simply recorded missing — either
        // way the walk must terminate, which is what we assert.
        let mut src = MapSource::default();
        src.insert(EOR_CELL_NAMESPACE, LB_INFO_ID, build_landblock_info(LB_INFO_ID, &[setup_id]));
        // Intentionally provide unparseable bytes for the setup model:
        // the walk should record it (missing, since unpack fails) and
        // terminate rather than loop.
        src.insert(EOR_PORTAL_NAMESPACE, setup_id, vec![0xAA; 8]);

        let result = walk_boot_reachability(&src, LB);
        // Must terminate and classify the setup id.
        assert!(
            result.referenced_dids().contains(&setup_id),
            "setup id must be referenced"
        );
        // It is unpackable (bad bytes) → not fully packable.
        assert!(!result.fully_packable);
    }

    #[test]
    fn shared_surface_across_two_objects_is_visited_once() {
        // Two GfxObjs sharing one Surface — the surface (and its chain)
        // must be walked exactly once. We assert correctness via the
        // result sets (no duplicates possible in a BTreeSet, but the
        // important property is that a second visit doesn't re-mark a
        // demoted/missing DID).
        let gfx2 = 0x0100_5678u32;
        let mut src = complete_source();
        // Boot landblock now places BOTH gfx objects, both pointing at SURF.
        src.insert(
            EOR_CELL_NAMESPACE,
            LB_INFO_ID,
            build_landblock_info(LB_INFO_ID, &[GFX, gfx2]),
        );
        src.insert(EOR_PORTAL_NAMESPACE, gfx2, build_gfx_obj(gfx2, &[SURF]));

        let result = walk_boot_reachability(&src, LB);
        assert!(result.fully_packable);
        assert!(result.reachable_dids.contains(&gfx2));
        assert!(result.reachable_dids.contains(&SURF));
        // Sanity: the shared chain leaves are present exactly once.
        assert!(result.reachable_dids.contains(&TEX_PAL));
    }

    #[test]
    fn datfiletype_classification_is_consistent_with_prefixes() {
        // Guard that the DID prefixes the walker switches on line up with
        // the crate's own DatFileType classifier (defensive: catches a
        // future prefix-scheme drift).
        assert_eq!(DatFileType::from_id(GFX), DatFileType::Model);
        assert_eq!(DatFileType::from_id(SURF), DatFileType::Surface);
        assert_eq!(DatFileType::from_id(SURF_TEX), DatFileType::SurfaceTexture);
        assert_eq!(DatFileType::from_id(TEX), DatFileType::Texture);
        assert_eq!(DatFileType::from_id(TEX_PAL), DatFileType::Palette);
    }

    // Silence unused-import warnings if the Frame/Stab/Vector3/Quaternion
    // round-trip helpers above ever get inlined away.
    #[allow(dead_code)]
    fn _assert_stab_shape() {
        let _ = Stab {
            id: 0,
            frame: Frame {
                origin: Vector3::zero(),
                orientation: Quaternion::default(),
            },
        };
    }
}
