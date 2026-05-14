//! Integration tests for the event bake.
//!
//! Two groups:
//! 1. `determinism_stress` — runs each sub-bake 50× against synthetic
//!    inputs and asserts byte-equal output. Mirrors the determinism
//!    stress test in `holtburger-scenery-bake`.
//! 2. `real_holtburg_ambient_smoke` — bakes the ambient manifest for
//!    Holtburg LB 0xA9B4 from the real retail DAT and asserts that
//!    we get a sane number of triggers. Skipped (with a printed
//!    "SKIP — no dat" line) when retail DATs aren't on the host.
//!
//! The real-DAT test follows the existing pattern from
//! `physics_script::tests::probe_retail_physics_script_moon`.

use holtburger_dat::file_type::physics_script::{PhysicsScript, PhysicsScriptData};
use holtburger_dat::file_type::region::{
    AmbientSTBDesc, AmbientSoundDesc, LandDefs, LandSurf, Region, SceneDesc, SceneType, SoundDesc,
    TerrainDesc, TerrainType, TexMerge,
};
use holtburger_dat::file_type::setup_model::AnimationHook;
use holtburger_dat::file_type::GameTime;
use holtburger_dat::landblock::CellLandblock;
use holtburger_event_bake::{bake_ambient_manifest, bake_particle_manifest};

// ---------------------------------------------------------------------------
// Determinism stress
// ---------------------------------------------------------------------------

fn synth_region_with_stbs(num_stb: usize) -> Region {
    let stb_descs: Vec<AmbientSTBDesc> = (0..num_stb)
        .map(|i| AmbientSTBDesc {
            stb_id: 0x20000000 + (i as u32),
            ambient_sounds: vec![AmbientSoundDesc {
                s_type: 100 + i as u32,
                volume: 0.5,
                base_chance: if i % 2 == 0 { 0.0 } else { 0.1 },
                min_rate: 1.0,
                max_rate: 5.0,
            }],
        })
        .collect();
    let scene_types: Vec<SceneType> = (0..num_stb as i32)
        .map(|i| SceneType {
            stb_index: i,
            scenes: vec![],
        })
        .collect();
    Region {
        id: 0x13000000,
        region_number: 1,
        version: 0,
        region_name: "Stress".to_string(),
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
        scene_info: Some(SceneDesc { scene_types }),
        terrain_info: TerrainDesc {
            terrain_types: vec![TerrainType {
                terrain_name: "T0".to_string(),
                terrain_color: 0,
                scene_types: (0..num_stb as u32).collect(),
            }],
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

fn synth_landblock_varied() -> CellLandblock {
    // Mix vertices across 3 scene_types (st in {0, 1, 2}) so the bake
    // emits 3 distinct triggers.
    let mut terrain = vec![0u16; 81];
    for i in 0..81 {
        let st = (i % 3) as u16;
        terrain[i] = st << 11;
    }
    CellLandblock {
        id: 0xA9B4_FFFF,
        has_objects: 0,
        terrain,
        height: vec![0u8; 81],
        _align: (),
    }
}

#[test]
fn determinism_stress_ambient_50x() {
    let region = synth_region_with_stbs(3);
    let lb = synth_landblock_varied();
    let baseline = bake_ambient_manifest(&region, &lb, 0xA9B4_0000);
    assert!(!baseline.is_empty());
    for _ in 0..50 {
        let again = bake_ambient_manifest(&region, &lb, 0xA9B4_0000);
        assert_eq!(baseline, again, "ambient bake determinism");
    }
}

#[test]
fn determinism_stress_particle_50x() {
    fn cp_hook(emitter_id: u32) -> AnimationHook {
        let mut data = Vec::with_capacity(40);
        data.extend_from_slice(&emitter_id.to_le_bytes());
        data.extend_from_slice(&0u32.to_le_bytes());
        data.extend(std::iter::repeat(0u8).take(40 - 8));
        AnimationHook {
            hook_type: 13,
            direction: 0,
            data,
        }
    }
    let ps = PhysicsScript {
        id: 0x33000001,
        script_data: vec![
            PhysicsScriptData {
                start_time: 0.0,
                hook: cp_hook(0x32000001),
            },
            PhysicsScriptData {
                start_time: 0.5,
                hook: cp_hook(0x32000002),
            },
            PhysicsScriptData {
                start_time: 1.0,
                hook: cp_hook(0x32000003),
            },
        ],
    };
    let baseline = bake_particle_manifest(ps.id, &ps);
    assert_eq!(baseline.len(), 3);
    for _ in 0..50 {
        let again = bake_particle_manifest(ps.id, &ps);
        assert_eq!(baseline, again, "particle bake determinism");
    }
}

// ---------------------------------------------------------------------------
// Real-DAT smoke
// ---------------------------------------------------------------------------

fn try_real_holtburg_inputs() -> Option<(Region, CellLandblock)> {
    use holtburger_dat::DatDatabase;
    use holtburger_dat::file_type::Region as RegionFt;

    let path = if let Some(p) = holtburger_dat::utils::get_portal_dat_path() {
        p
    } else {
        let candidates = [
            "/home/wbterminal/ac_base_dats/client_portal.dat",
            "/home/wbterminal/projects/RetailSmoke/dats/base/client_portal.dat",
        ];
        candidates
            .iter()
            .map(std::path::PathBuf::from)
            .find(|p| p.exists())?
    };
    let portal = DatDatabase::new(&path).ok()?;
    let region_bytes = portal.get_file(0x13000000).ok()?;
    let mut cursor = std::io::Cursor::new(&region_bytes);
    let region = RegionFt::unpack(&mut cursor).ok()?;
    // Need the cell DAT too. Sibling lookup.
    let cell_path = path.with_file_name("client_cell_1.dat");
    if !cell_path.exists() {
        eprintln!("SKIP — cell.dat missing");
        return None;
    }
    let cell_db = DatDatabase::new(&cell_path).ok()?;
    // Holtburg landblock 0xA9B4 → CellLandblock id 0xA9B4FFFF.
    let bytes = cell_db.get_file(0xA9B4FFFF).ok()?;
    let lb = CellLandblock::unpack(&bytes).ok()?;
    Some((region, lb))
}

#[test]
fn real_holtburg_ambient_smoke() {
    let Some((region, lb)) = try_real_holtburg_inputs() else {
        eprintln!("SKIP — no dat");
        return;
    };
    let triggers = bake_ambient_manifest(&region, &lb, 0xA9B4_0000);
    // Holtburg has a healthy mix of terrain codes (grass + dirt +
    // forest floor at the edges). Expect at least one ambient
    // trigger.
    assert!(
        !triggers.is_empty(),
        "Holtburg LB 0xA9B4 should yield ambient triggers; got 0"
    );
    let vertices_covered: usize = triggers.iter().map(|t| t.vertex_indices.len()).sum();
    // Some vertices may land on stb_index=-1 (the "no ambient"
    // sentinel) — those are filtered out. Bound: 0 < covered <= 81.
    assert!(vertices_covered <= 81);
    eprintln!(
        "Holtburg ambient bake: {} triggers covering {} vertices",
        triggers.len(),
        vertices_covered
    );
    // No duplicate (terrain_type, scene_type) keys.
    for i in 0..triggers.len() {
        for j in (i + 1)..triggers.len() {
            assert_ne!(
                (triggers[i].terrain_type, triggers[i].scene_type),
                (triggers[j].terrain_type, triggers[j].scene_type)
            );
        }
    }
    // All STB ids should be in the 0x20xxxxxx range (SoundTable prefix).
    for t in &triggers {
        assert_eq!(
            t.stb_id >> 24,
            0x20,
            "ambient trigger stb_id should be 0x20xxxxxx, got 0x{:08X}",
            t.stb_id
        );
    }
}
