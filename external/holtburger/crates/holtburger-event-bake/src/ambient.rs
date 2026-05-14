//! **Ambient (S1)** — port of ACE's `AmbientSTBDesc.cs` +
//! `AmbientSoundDesc.cs` indexing scheme.
//!
//! For each of the 81 vertices in a landblock, decode the per-vertex
//! terrain word into a `(terrain_type, scene_type)` pair. Index the
//! Region's tables to land on a SceneType. If the SceneType's
//! `stb_index >= 0`, dereference the matching `AmbientSTBDesc` and
//! emit one [`AmbientTrigger`] per **unique** `(terrain_type,
//! scene_type)` combination present on the LB.
//!
//! # Source mapping (ACE)
//!
//! ```text
//! Region.sound_info.stb_descs[stb_index]
//!   ↑
//!   |     (stb_index >= 0, else "no ambient on this scene type")
//!   |
//! Region.scene_info.scene_types[scene_info_idx].stb_index : i32
//!   ↑
//!   |     (scene_info_idx is u32 in the DAT)
//!   |
//! Region.terrain_info.terrain_types[terrain_type].scene_types[scene_type]
//!   ↑
//!   |
//! terrain_word bits  :   (terrain >> 2) & 0x1F  → terrain_type
//!                        (terrain >> 11) & 0x1F → scene_type
//! ```
//!
//! The `0x1F` mask on `scene_type` matches `Scenery.cs:31` — the
//! upstream of the same `terrain_word`. PhatSDK comments note the
//! 5-bit width without the explicit mask but it's a u16-right-shift so
//! the masked value matches the unmasked one for the bottom 5 bits.
//!
//! # Output ordering
//!
//! Triggers are emitted in **ascending `(terrain_type, scene_type)`
//! order** so the JSONL diff is stable across runs. Vertex indices
//! inside each trigger are also sorted ascending.
//!
//! # Empty case
//!
//! If every vertex on the LB lands on either:
//! - an out-of-bounds `(tt, st)` (real DATs never hit this — synthetic
//!   fixtures might),
//! - or a SceneType with `stb_index == -1` (the "no ambient" sentinel),
//!
//! the function returns `Vec::new()`. Callers should still emit an
//! empty JSONL file so consumers can pattern-match on presence.

use holtburger_dat::file_type::Region;
use holtburger_dat::file_type::region::AmbientSoundDesc;
use holtburger_dat::landblock::CellLandblock;
use std::collections::BTreeMap;

/// One `(s_type, volume, base_chance, min_rate, max_rate)` ambient
/// sound entry. Plain copy of `AmbientSoundDesc` plus the
/// runtime-derived `continuous` flag (`base_chance == 0.0`, per the
/// PhatSDK comment in `region.rs::AmbientSoundDesc::is_continuous`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AmbientSoundRecord {
    pub s_type: u32,
    pub volume: f32,
    pub base_chance: f32,
    pub min_rate: f32,
    pub max_rate: f32,
    pub continuous: bool,
}

impl From<&AmbientSoundDesc> for AmbientSoundRecord {
    fn from(asd: &AmbientSoundDesc) -> Self {
        AmbientSoundRecord {
            s_type: asd.s_type,
            volume: asd.volume,
            base_chance: asd.base_chance,
            min_rate: asd.min_rate,
            max_rate: asd.max_rate,
            continuous: asd.is_continuous(),
        }
    }
}

/// One ambient trigger record — i.e. "while the player stands on a
/// vertex of this `(terrain_type, scene_type)`, these ambient sounds
/// are active".
#[derive(Debug, Clone, PartialEq)]
pub struct AmbientTrigger {
    /// Terrain code (bits 2..6 of the terrain word).
    pub terrain_type: u32,
    /// Scene type (bits 11..15 of the terrain word).
    pub scene_type: u32,
    /// `Region.scene_info.scene_types[]` index resolved through the
    /// terrain-info table. Same i32 the DAT carries — `>= 0`.
    pub scene_info_idx: u32,
    /// `Region.sound_info.stb_descs[]` index. Also the index that ACE
    /// uses to dereference the STB. `>= 0` — `-1` (no ambient on this
    /// scene) is filtered out and never produces an `AmbientTrigger`.
    pub stb_index: u32,
    /// The dereferenced `AmbientSTBDesc.stb_id` (typically a
    /// `0x20xxxxxx` SoundTable DID — the file the runtime walks for
    /// each sound entry).
    pub stb_id: u32,
    /// 0..80 indices of the vertices on this LB that resolved to this
    /// `(terrain_type, scene_type)`. Sorted ascending for stable diff.
    pub vertex_indices: Vec<u32>,
    /// Flattened list of ambient sound entries for this STB.
    pub ambient_sounds: Vec<AmbientSoundRecord>,
}

/// Bake the ambient triggers for one landblock.
///
/// `landblock_id` is currently unused for ambient — the per-vertex
/// terrain word is all the bake needs — but kept in the API for
/// symmetry with the scenery bake (and in case future ACE versions
/// add LB-id-keyed ambient overrides).
///
/// # Determinism
///
/// Output is deterministic given the `region` + `landblock` inputs.
/// Vertex indices within each trigger are sorted ascending; triggers
/// themselves are sorted by `(terrain_type, scene_type)` ascending.
pub fn bake_ambient_manifest(
    region: &Region,
    landblock: &CellLandblock,
    _landblock_id: u32,
) -> Vec<AmbientTrigger> {
    // SceneInfo + SoundInfo are both flag-gated on `parts_mask`. Real
    // Region 0x13 has them — synthetic fixtures may not. Short-circuit
    // cleanly.
    let Some(scene_info) = region.scene_info.as_ref() else {
        return Vec::new();
    };
    let Some(sound_info) = region.sound_info.as_ref() else {
        return Vec::new();
    };

    // Bucket vertices by their (terrain_type, scene_type).
    // BTreeMap so emission order is stable on the key — same property
    // the scenery bake relies on for its determinism contract.
    let mut buckets: BTreeMap<(u32, u32), Vec<u32>> = BTreeMap::new();
    for (i, word) in landblock.terrain.iter().enumerate() {
        let terrain_type = ((word >> 2) & 0x1F) as u32;
        let scene_type = ((word >> 11) & 0x1F) as u32;
        buckets
            .entry((terrain_type, scene_type))
            .or_default()
            .push(i as u32);
    }

    let mut out: Vec<AmbientTrigger> = Vec::new();

    for ((terrain_type, scene_type), vertex_indices) in buckets {
        // Resolve terrain_type → scene_info_idx via the per-terrain
        // table. Out-of-bounds is "skip" — real DATs cover the full
        // 0..=31 range but synthetic fixtures may not.
        let Some(tt) = region
            .terrain_info
            .terrain_types
            .get(terrain_type as usize)
        else {
            continue;
        };
        let Some(&scene_info_idx_raw) = tt.scene_types.get(scene_type as usize) else {
            continue;
        };
        // Dereference SceneInfo by the resolved index. SceneInfo
        // out-of-bounds is "skip" for the same reason as above.
        let Some(scene_type_record) = scene_info
            .scene_types
            .get(scene_info_idx_raw as usize)
        else {
            continue;
        };
        // stb_index = -1 is the "no ambient on this scene type"
        // sentinel — PhatSDK `RegionDesc.cpp:276-289` documents this.
        // Skip (no trigger emitted).
        if scene_type_record.stb_index < 0 {
            continue;
        }
        let stb_index_u = scene_type_record.stb_index as u32;
        let Some(stb_desc) = sound_info.stb_descs.get(stb_index_u as usize) else {
            // Out-of-bounds index — defensive skip. ACE would index
            // OOB and crash; the validator should report this as a
            // data integrity warning, not silently propagate.
            continue;
        };

        // Empty STB (no ambient sound entries) is technically valid —
        // the STB exists but emits nothing. Emit the trigger anyway so
        // the validator can match an "expected-empty" record to an
        // empty runtime fire-set.
        let ambient_sounds: Vec<AmbientSoundRecord> = stb_desc
            .ambient_sounds
            .iter()
            .map(AmbientSoundRecord::from)
            .collect();

        out.push(AmbientTrigger {
            terrain_type,
            scene_type,
            scene_info_idx: scene_info_idx_raw,
            stb_index: stb_index_u,
            stb_id: stb_desc.stb_id,
            vertex_indices,
            ambient_sounds,
        });
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_dat::file_type::region::{
        AmbientSTBDesc, LandDefs, LandSurf, Region, SceneDesc, SceneType, SoundDesc, TerrainDesc,
        TerrainType, TexMerge,
    };
    use holtburger_dat::file_type::GameTime;
    use holtburger_dat::landblock::CellLandblock;

    fn synth_region(terrain_types: usize, stb_for_scene_type: &[i32]) -> Region {
        let scene_types: Vec<SceneType> = stb_for_scene_type
            .iter()
            .map(|&stb| SceneType {
                stb_index: stb,
                scenes: vec![],
            })
            .collect();
        let terrain_types_v: Vec<TerrainType> = (0..terrain_types)
            .map(|i| TerrainType {
                terrain_name: format!("T{i}"),
                terrain_color: 0,
                // Each terrain_type just maps scene_type k → scene_info_idx k.
                scene_types: (0..stb_for_scene_type.len() as u32).collect(),
            })
            .collect();
        let stb_descs = vec![
            AmbientSTBDesc {
                stb_id: 0x20000001,
                ambient_sounds: vec![AmbientSoundDesc {
                    s_type: 256,
                    volume: 0.8,
                    base_chance: 0.0,
                    min_rate: 0.0,
                    max_rate: 0.0,
                }],
            },
            AmbientSTBDesc {
                stb_id: 0x20000002,
                ambient_sounds: vec![AmbientSoundDesc {
                    s_type: 512,
                    volume: 0.4,
                    base_chance: 0.05,
                    min_rate: 5.0,
                    max_rate: 15.0,
                }],
            },
        ];
        Region {
            id: 0x13000000,
            region_number: 1,
            version: 0,
            region_name: "TestRegion".to_string(),
            parts_mask: 0,
            land_defs: LandDefs {
                num_block_length: 1,
                num_block_width: 1,
                square_length: 24.0,
                l_block_length: 8,
                vertex_per_cell: 9,
                max_obj_height: 200.0,
                sky_height: 1000.0,
                road_width: 5.0,
                land_height_table: vec![0.0; 256],
            },
            game_time: GameTime {
                zero_time_of_year: 0.0,
                zero_year: 0,
                day_length: 1.0,
                days_per_year: 1,
                year_spec: String::new(),
                times_of_day: vec![],
                days_of_week: vec![],
                seasons: vec![],
            },
            sky_info: None,
            sound_info: Some(SoundDesc { stb_descs }),
            scene_info: Some(SceneDesc {
                scene_types,
            }),
            terrain_info: TerrainDesc {
                terrain_types: terrain_types_v,
                land_surfaces: LandSurf {
                    surf_type: 0,
                    tex_merge: TexMerge {
                        base_tex_size: 0,
                        corner_terrain_maps: vec![],
                        side_terrain_maps: vec![],
                        road_maps: vec![],
                        terrain_desc: vec![],
                    },
                },
            },
            region_misc: None,
        }
    }

    fn synth_landblock_uniform(terrain_word: u16) -> CellLandblock {
        CellLandblock {
            id: 0,
            has_objects: 0,
            terrain: vec![terrain_word; 81],
            height: vec![0u8; 81],
            _align: (),
        }
    }

    #[test]
    fn returns_empty_when_region_lacks_scene_info() {
        let mut r = synth_region(1, &[-1]);
        r.scene_info = None;
        let lb = synth_landblock_uniform(0);
        let out = bake_ambient_manifest(&r, &lb, 0);
        assert!(out.is_empty());
    }

    #[test]
    fn returns_empty_when_region_lacks_sound_info() {
        let mut r = synth_region(1, &[0]);
        r.sound_info = None;
        let lb = synth_landblock_uniform(0);
        let out = bake_ambient_manifest(&r, &lb, 0);
        assert!(out.is_empty());
    }

    #[test]
    fn stb_index_minus_one_emits_no_trigger() {
        // Region has scene_types[0] with stb_index = -1 (the "no
        // ambient" sentinel). All 81 vertices on terrain_type=0,
        // scene_type=0 → should land on scene_info_idx=0 → stb_index=-1
        // → filtered.
        let r = synth_region(1, &[-1]);
        let lb = synth_landblock_uniform(0);
        let out = bake_ambient_manifest(&r, &lb, 0);
        assert!(out.is_empty());
    }

    #[test]
    fn uniform_lb_emits_one_trigger_with_all_81_verts() {
        // scene_info_idx=0 → stb_index=0 (STB 0x20000001).
        let r = synth_region(1, &[0]);
        let lb = synth_landblock_uniform(0);
        let out = bake_ambient_manifest(&r, &lb, 0);
        assert_eq!(out.len(), 1);
        let t = &out[0];
        assert_eq!(t.terrain_type, 0);
        assert_eq!(t.scene_type, 0);
        assert_eq!(t.stb_index, 0);
        assert_eq!(t.stb_id, 0x20000001);
        assert_eq!(t.vertex_indices.len(), 81);
        // Vertices are 0..81 in order.
        assert_eq!(t.vertex_indices[0], 0);
        assert_eq!(*t.vertex_indices.last().unwrap(), 80);
        // The STB had one continuous sound entry.
        assert_eq!(t.ambient_sounds.len(), 1);
        assert_eq!(t.ambient_sounds[0].s_type, 256);
        assert!(t.ambient_sounds[0].continuous);
    }

    #[test]
    fn two_terrain_codes_emit_two_triggers_sorted_ascending() {
        // Region has 2 scene_types, both mapped to valid STBs. Half
        // the vertices have terrain_type=0/scene_type=0; the other
        // half have terrain_type=0/scene_type=1.
        let r = synth_region(1, &[0, 1]);
        let mut lb = synth_landblock_uniform(0);
        // First 40 vertices on (tt=0, st=0). Next 41 on (tt=0, st=1).
        // scene_type is bits 11..15 — set bit 11 for st=1.
        for i in 40..81 {
            lb.terrain[i] = 1u16 << 11;
        }
        let out = bake_ambient_manifest(&r, &lb, 0);
        assert_eq!(out.len(), 2);
        // Sorted by (terrain_type, scene_type) — (0, 0) then (0, 1).
        assert_eq!(out[0].terrain_type, 0);
        assert_eq!(out[0].scene_type, 0);
        assert_eq!(out[0].vertex_indices.len(), 40);
        assert_eq!(out[1].terrain_type, 0);
        assert_eq!(out[1].scene_type, 1);
        assert_eq!(out[1].vertex_indices.len(), 41);
        // STB ids match the two STB entries.
        assert_eq!(out[0].stb_id, 0x20000001);
        assert_eq!(out[1].stb_id, 0x20000002);
    }

    #[test]
    fn continuous_flag_tracks_base_chance() {
        // STB 0 has base_chance=0.0 → continuous. STB 1 has 0.05 → not.
        let r = synth_region(1, &[0, 1]);
        let mut lb = synth_landblock_uniform(0);
        for i in 40..81 {
            lb.terrain[i] = 1u16 << 11;
        }
        let out = bake_ambient_manifest(&r, &lb, 0);
        assert_eq!(out.len(), 2);
        assert!(out[0].ambient_sounds[0].continuous);
        assert!(!out[1].ambient_sounds[0].continuous);
    }

    #[test]
    fn out_of_bounds_terrain_type_skipped() {
        // Set terrain_type=31 (max 5-bit value) but region only has 1
        // terrain_type. Should skip (no trigger emitted).
        let r = synth_region(1, &[0]);
        let mut lb = synth_landblock_uniform(0);
        // (31 << 2) = 124 = 0x7C. Set on every vertex.
        for i in 0..81 {
            lb.terrain[i] = 31u16 << 2;
        }
        let out = bake_ambient_manifest(&r, &lb, 0);
        assert!(out.is_empty());
    }

    #[test]
    fn determinism_repeated_call_returns_equal() {
        let r = synth_region(1, &[0, 1]);
        let mut lb = synth_landblock_uniform(0);
        for i in 40..81 {
            lb.terrain[i] = 1u16 << 11;
        }
        let a = bake_ambient_manifest(&r, &lb, 0);
        let b = bake_ambient_manifest(&r, &lb, 0);
        assert_eq!(a.len(), b.len());
        for (x, y) in a.iter().zip(b.iter()) {
            assert_eq!(x, y);
        }
    }
}
