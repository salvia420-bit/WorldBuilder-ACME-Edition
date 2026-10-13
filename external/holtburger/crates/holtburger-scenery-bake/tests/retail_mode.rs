//! `BakeMode::Retail` — the retail per-object frequency gate
//! (terrain-scenery-1).
//!
//! Retail `CLandBlock::get_land_scenes` (`acclient.c:352662-352731`)
//! gives object `j` of a Scene its own draw, `cellMat * (23399 + j)`.
//! `AceCompat` replays ACE's dead `Entity/Scenery.cs` port, whose single
//! shared draw makes a Scene's objects a nested set: with equal `freq`, a
//! cell gets every object or none.
//!
//! Fixture: one Scene of three objects at `freq = 0.5`, flat terrain, no
//! roads, no buildings, no displacement / rotation / scale noise, and an
//! AABB closure that never collides. In the 7×7 interior cells nothing but
//! the frequency gate can reject a candidate (the three base origins stay
//! inside `[6, 186]` under every quadrant flip), so the accepted
//! `(cell, j)` set IS the gate. The assertions read acceptance only, not
//! pose, so the later retail rules (road band, slope, frame) do not move
//! them on this fixture.
//!
//! The 23 / 32 cell counts were computed independently of the Rust code,
//! from a Python transcription of the decomp gate for LB `0xA9B4`. The 32
//! uses retail's 2^-32 noise scale, and the 23 uses ACE's literal.

use std::collections::BTreeSet;

use holtburger_common::{Quaternion, Vector3};
use holtburger_dat::file_type::object_desc::ObjectDesc;
use holtburger_dat::file_type::region::{
    LandDefs, LandSurf, Region, SceneDesc, SceneType, TerrainDesc, TerrainType, TexMerge,
};
use holtburger_dat::file_type::{GameTime, Scene};
use holtburger_dat::graphics::Frame;
use holtburger_dat::landblock::CellLandblock;
use holtburger_scenery_bake::{
    Aabb3D, BakeMode, PlacementXform, ScenicPlacement, bake_landblock, cell_mats_per_object,
    object_noise, object_noise_retail,
};

const SCENE_DID: u32 = 0x1200_0001;
/// Holtburg's LB id; block_x = 0xA9 * 8 = 1352, block_y = 0xB4 * 8 = 1440.
const LB_ID: u32 = 0xA9B4_0000;
const FREQ: f32 = 0.5;
const N_OBJ: u32 = 3;

/// Same shape as `integration.rs::synth_region`: every terrain word of 0
/// resolves to a one-Scene bucket holding `scene_did`.
fn synth_region(scene_did: u32) -> Region {
    let land_height_table: Vec<f32> = (0..256).map(|i| i as f32 * 0.5).collect();
    Region {
        id: 0x1300_0000,
        region_number: 1,
        version: 0,
        region_name: "Synthetic".to_string(),
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
            land_height_table,
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
        sound_info: None,
        scene_info: Some(SceneDesc {
            scene_types: vec![SceneType {
                stb_index: -1,
                scenes: vec![scene_did],
            }],
        }),
        terrain_info: TerrainDesc {
            terrain_types: vec![TerrainType {
                terrain_name: "T0".to_string(),
                terrain_color: 0,
                scene_types: vec![0],
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

/// Flat (all height byte 0), road-free, scene_type 0 everywhere.
fn flat_landblock() -> CellLandblock {
    CellLandblock {
        id: 0xA9B4_FFFF,
        has_objects: 0,
        terrain: vec![0u16; 81],
        height: vec![0u8; 81],
        _align: (),
    }
}

/// Three objects at `freq = 0.5` with base origins (2,2), (10,10),
/// (18,18). With no displacement the quadrant flip only mirrors those
/// origins, so every candidate in cells 1..=7 lands inside the LB and no
/// two candidates share a position.
fn three_object_scene() -> Scene {
    let obj = |k: u32, o: f32| ObjectDesc {
        obj_id: 0x0100_0001 + k,
        base_loc: Frame {
            origin: Vector3::new(o, o, 0.0),
            orientation: Quaternion::default(),
        },
        freq: FREQ,
        displace_x: 0.0,
        displace_y: 0.0,
        min_scale: 1.0,
        max_scale: 1.0,
        max_rotation: 0.0,
        min_slope: 0.0,
        max_slope: 1.0,
        align: 0,
        orient: 0,
        weenie_obj: 0,
    };
    Scene {
        id: SCENE_DID,
        objects: vec![obj(0, 2.0), obj(1, 10.0), obj(2, 18.0)],
    }
}

/// Every candidate gets its own unit box, 10 m apart along X and far
/// outside the landblock, so the `Collision` rejection can never fire
/// and acceptance is decided by the frequency gate alone.
fn never_colliding_aabb_fn() -> impl FnMut(PlacementXform) -> Option<Aabb3D> {
    let mut k: f32 = 0.0;
    move |_px: PlacementXform| {
        k += 10.0;
        Some(Aabb3D::new(1000.0 + k, 1000.0, 0.0, 1001.0 + k, 1001.0, 1.0))
    }
}

fn bake(mode: BakeMode) -> Vec<ScenicPlacement> {
    let region = synth_region(SCENE_DID);
    let lb = flat_landblock();
    let scene = three_object_scene();
    bake_landblock(
        &region,
        &lb,
        LB_ID,
        |id| if id == SCENE_DID { Some(scene.clone()) } else { None },
        never_colliding_aabb_fn(),
        &[],
        mode,
    )
}

/// Accepted `(cell_x, cell_y, j)` triples in the interior cells 1..=7.
fn accepted_interior(placements: &[ScenicPlacement]) -> BTreeSet<(u32, u32, u32)> {
    placements
        .iter()
        .filter(|p| (1..=7).contains(&p.source_cell_x) && (1..=7).contains(&p.source_cell_y))
        .map(|p| (p.source_cell_x, p.source_cell_y, p.source_obj_idx))
        .collect()
}

fn interior_cells() -> impl Iterator<Item = (u32, u32)> {
    (1..=7u32).flat_map(|cx| (1..=7u32).map(move |cy| (cx, cy)))
}

/// Global cell coords, as `bake_landblock` derives them (Scenery.cs:21-22,
/// 37-41).
fn global_cell(cx: u32, cy: u32) -> (u32, u32) {
    ((LB_ID >> 24) * 8 + cx, ((LB_ID >> 16) & 0xFF) * 8 + cy)
}

fn placement_bits(p: &ScenicPlacement) -> [u32; 12] {
    [
        p.obj_id,
        p.x.to_bits(),
        p.y.to_bits(),
        p.z.to_bits(),
        p.qw.to_bits(),
        p.qx.to_bits(),
        p.qy.to_bits(),
        p.qz.to_bits(),
        p.scale.to_bits(),
        p.source_cell_x,
        p.source_cell_y,
        p.source_obj_idx,
    ]
}

/// `retail` round-trips through `as_str` / `FromStr`, and the default
/// stays `AceCompat` (every shipped bake is ace-compat until a Retail
/// bake passes its A/B eye-test).
#[test]
fn retail_mode_round_trips_and_is_not_the_default() {
    assert_eq!(BakeMode::Retail.as_str(), "retail");
    let parsed: BakeMode = "retail".parse().unwrap();
    assert_eq!(parsed, BakeMode::Retail);
    assert_eq!(BakeMode::default(), BakeMode::AceCompat);
    let err = "bogus".parse::<BakeMode>().unwrap_err();
    assert!(err.contains("retail"), "error should list `retail`: {err}");
}

/// AceCompat: one shared draw per cell, so with equal `freq` each
/// interior cell accepts all three objects or none, exactly where
/// `object_noise` passes the gate.
#[test]
fn ace_compat_gate_is_one_shared_draw_per_cell() {
    let ac = accepted_interior(&bake(BakeMode::AceCompat));
    let mut full = 0;
    for (cx, cy) in interior_cells() {
        let (gx, gy) = global_cell(cx, cy);
        let (a, b, c) = cell_mats_per_object(gx, gy);
        let pass = object_noise(a, b, c) < FREQ as f64;
        let got: Vec<bool> = (0..N_OBJ).map(|j| ac.contains(&(cx, cy, j))).collect();
        assert_eq!(
            got,
            vec![pass; N_OBJ as usize],
            "AceCompat cell ({cx},{cy}) must be all-or-nothing (shared draw)"
        );
        if pass {
            full += 1;
        }
    }
    assert_eq!(full, 23, "AceCompat full interior cells (independent Python count)");
}

/// Retail: each object has its own draw, so acceptance follows
/// `object_noise_retail(.., j)` per object and many cells take a
/// non-nested subset (some objects, not all) — impossible in AceCompat.
#[test]
fn retail_gate_draws_per_object_and_breaks_nesting() {
    let rt = accepted_interior(&bake(BakeMode::Retail));
    let mut mixed = 0;
    for (cx, cy) in interior_cells() {
        let (gx, gy) = global_cell(cx, cy);
        let (a, b, c) = cell_mats_per_object(gx, gy);
        let mut n_in = 0;
        for j in 0..N_OBJ {
            let want = object_noise_retail(a, b, c, j) < FREQ as f64;
            let got = rt.contains(&(cx, cy, j));
            assert_eq!(
                got, want,
                "Retail cell ({cx},{cy}) object {j}: accepted={got}, gate says {want}"
            );
            if got {
                n_in += 1;
            }
        }
        if n_in > 0 && n_in < N_OBJ {
            mixed += 1;
        }
    }
    assert!(mixed > 0, "Retail must accept a non-nested subset in some cell");
    assert_eq!(mixed, 32, "Retail mixed interior cells (independent Python count)");
}

/// Object 0 draws the same u32 in both modes (`23399 + 0`). Retail scales
/// it by 2^-32 and AceCompat by ACE's literal, about 1.6e-8 relative
/// smaller, so the two gates can differ only for a draw within that of
/// `freq`. No interior cell here is that close (re-checked in Python with
/// 2^-32, 2026-10-13), so the modes agree on object 0 and differ only from
/// object 1 on.
#[test]
fn retail_and_ace_compat_agree_on_object_zero_only() {
    let ac = accepted_interior(&bake(BakeMode::AceCompat));
    let rt = accepted_interior(&bake(BakeMode::Retail));
    for (cx, cy) in interior_cells() {
        assert_eq!(
            ac.contains(&(cx, cy, 0)),
            rt.contains(&(cx, cy, 0)),
            "object 0 at ({cx},{cy}) must gate identically in both modes"
        );
    }
    assert_ne!(ac, rt, "the modes must differ for objects j > 0");
}

/// Retail keeps the bake's determinism contract.
#[test]
fn retail_bake_is_deterministic() {
    let first = bake(BakeMode::Retail);
    assert!(!first.is_empty());
    for _ in 0..10 {
        let again = bake(BakeMode::Retail);
        assert_eq!(again.len(), first.len());
        for (a, b) in first.iter().zip(again.iter()) {
            assert_eq!(placement_bits(a), placement_bits(b));
        }
    }
}
