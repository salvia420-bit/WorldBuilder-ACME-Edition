//! `BakeMode::Retail` — the retail road band (terrain-scenery-2).
//!
//! Retail `CLandBlock::on_road` (`acclient.c:352238`) reads the four
//! corners of the candidate's cell at `9 * ix + iy` and keeps scenery out of
//! a 5 m band along the road. `AceCompat` / `Strict` replay ACE's dead
//! `Entity/Scenery.cs` test, one terrain word at `cellX * 8 + cellY`.
//!
//! Fixture: one object at `freq = 1.0` (the gate always passes), flat
//! terrain, no buildings, no displacement / rotation / scale noise, and an
//! AABB closure that never collides, so in the 7×7 interior vertices the
//! road test is the only thing that can reject a candidate. The assertions
//! read acceptance in the interior only, so the later retail acceptance
//! rules (terrain-scenery-3: `< 192`, building cells, slope) do not move
//! them on this fixture.

use std::collections::BTreeSet;

use holtburger_common::{Quaternion, Vector3};
use holtburger_dat::file_type::object_desc::ObjectDesc;
use holtburger_dat::file_type::region::{
    LandDefs, LandSurf, Region, SceneDesc, SceneType, TerrainDesc, TerrainType, TexMerge,
};
use holtburger_dat::file_type::{GameTime, Scene};
use holtburger_dat::graphics::Frame;
use holtburger_dat::landblock::CellLandblock;
use holtburger_scenery_bake::height::{
    RETAIL_ROAD_WIDTH, on_road, on_road_retail, retail_road_width,
};
use holtburger_scenery_bake::{
    Aabb3D, BakeMode, CELL_SIZE, PlacementXform, ScenicPlacement, bake_landblock, displace,
    displace_retail,
};

const SCENE_DID: u32 = 0x1200_0001;
/// Holtburg's LB id; block_x = 0xA9 * 8 = 1352, block_y = 0xB4 * 8 = 1440.
const LB_ID: u32 = 0xA9B4_0000;
/// The one road vertex: (3, 2), terrain index `9 * 3 + 2 = 29`, LB-local
/// (72, 48). ACE's 8-stride reads index 29 for cell (3, 5) instead.
const ROAD_VERTEX: (u32, u32) = (3, 2);
const ACE_STRIDE_VERTEX: (u32, u32) = (3, 5);

/// Same shape as `retail_mode.rs::synth_region`, with `road_width` as a
/// parameter.
fn synth_region(scene_did: u32, road_width: f32) -> Region {
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
            road_width,
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

/// Flat, terrain type 0 / scene type 0 everywhere, road bits (type 1) only
/// on [`ROAD_VERTEX`].
fn one_road_vertex_landblock() -> CellLandblock {
    let mut terrain = vec![0u16; 81];
    terrain[(ROAD_VERTEX.0 * 9 + ROAD_VERTEX.1) as usize] = 0x0001;
    CellLandblock {
        id: 0xA9B4_FFFF,
        has_objects: 0,
        terrain,
        height: vec![0u8; 81],
        _align: (),
    }
}

/// One object at base origin `(origin_x, 0)`, `freq = 1.0`, no
/// displacement. The quadrant flip only turns the origin about its vertex,
/// so each candidate sits `origin_x` metres (L1) from its source vertex.
fn one_object(origin_x: f32) -> ObjectDesc {
    ObjectDesc {
        obj_id: 0x0100_0001,
        base_loc: Frame {
            origin: Vector3::new(origin_x, 0.0, 0.0),
            orientation: Quaternion::default(),
        },
        freq: 1.0,
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
    }
}

/// Every candidate gets its own unit box far outside the landblock, so the
/// `Collision` rejection never fires.
fn never_colliding_aabb_fn() -> impl FnMut(PlacementXform) -> Option<Aabb3D> {
    let mut k: f32 = 0.0;
    move |_px: PlacementXform| {
        k += 10.0;
        Some(Aabb3D::new(1000.0 + k, 1000.0, 0.0, 1001.0 + k, 1001.0, 1.0))
    }
}

fn bake(origin_x: f32, road_width: f32, mode: BakeMode) -> Vec<ScenicPlacement> {
    let region = synth_region(SCENE_DID, road_width);
    let lb = one_road_vertex_landblock();
    let scene = Scene {
        id: SCENE_DID,
        objects: vec![one_object(origin_x)],
    };
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

fn interior_vertices() -> impl Iterator<Item = (u32, u32)> {
    (1..=7u32).flat_map(|cx| (1..=7u32).map(move |cy| (cx, cy)))
}

/// Accepted source vertices in the interior (1..=7 on both axes).
fn accepted_interior(placements: &[ScenicPlacement]) -> BTreeSet<(u32, u32)> {
    placements
        .iter()
        .filter(|p| (1..=7).contains(&p.source_cell_x) && (1..=7).contains(&p.source_cell_y))
        .map(|p| (p.source_cell_x, p.source_cell_y))
        .collect()
}

/// Every interior vertex except `skip`.
fn interior_except(skip: (u32, u32)) -> BTreeSet<(u32, u32)> {
    interior_vertices().filter(|&v| v != skip).collect()
}

/// The candidate position the bake computes for vertex `(cx, cy)`
/// (Scenery.cs:37-41, 63-67). `Retail` displaces with
/// `displace_retail` (retail's 2^-32 noise scale), and the other modes
/// with ACE's `displace`.
fn candidate(obj: &ObjectDesc, cx: u32, cy: u32, mode: BakeMode) -> (f32, f32) {
    let gx = (LB_ID >> 24) * 8 + cx;
    let gy = ((LB_ID >> 16) & 0xFF) * 8 + cy;
    let (dx, dy) = match mode {
        BakeMode::Retail => displace_retail(obj, gx, gy, 0),
        BakeMode::AceCompat | BakeMode::Strict => displace(obj, gx, gy, 0),
    };
    (cx as f32 * CELL_SIZE + dx, cy as f32 * CELL_SIZE + dy)
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

/// The band width is the Region's `road_width` when usable, else retail's
/// literal 5.0 (synthetic Regions may leave it zeroed).
#[test]
fn road_width_comes_from_the_region_with_a_retail_fallback() {
    assert_eq!(RETAIL_ROAD_WIDTH, 5.0);
    assert_eq!(retail_road_width(&synth_region(SCENE_DID, 5.0)), 5.0);
    assert_eq!(retail_road_width(&synth_region(SCENE_DID, 3.5)), 3.5);
    for bad in [0.0f32, -1.0, 24.0, 30.0, f32::NAN, f32::INFINITY] {
        assert_eq!(
            retail_road_width(&synth_region(SCENE_DID, bad)),
            RETAIL_ROAD_WIDTH,
            "road_width {bad} must fall back to retail's 5.0"
        );
    }
}

/// Candidates sit exactly on their vertex. Retail clears the road vertex
/// itself (all four corners read at `9 * ix + iy`); AceCompat reads index 29
/// for cell (3, 5) instead, so it keeps the candidate on the road and drops
/// an unrelated one.
#[test]
fn retail_clears_the_road_vertex_and_ace_compat_keeps_its_8_stride() {
    let rt = accepted_interior(&bake(0.0, 5.0, BakeMode::Retail));
    assert_eq!(rt, interior_except(ROAD_VERTEX), "Retail must drop only the road vertex");
    let ac = accepted_interior(&bake(0.0, 5.0, BakeMode::AceCompat));
    assert_eq!(
        ac,
        interior_except(ACE_STRIDE_VERTEX),
        "AceCompat must keep ACE's cellX*8+cellY read"
    );
    let st = accepted_interior(&bake(0.0, 5.0, BakeMode::Strict));
    assert_eq!(st, ac, "Strict shares AceCompat's road test");
}

/// Each mode rejects exactly the candidates its road test flags (here 4 m
/// from their vertex, so the band itself decides for the road vertex).
#[test]
fn each_mode_rejects_exactly_what_its_road_test_flags() {
    let lb = one_road_vertex_landblock();
    let obj = one_object(4.0);
    let want_retail: BTreeSet<(u32, u32)> = interior_vertices()
        .filter(|&(cx, cy)| {
            let (lx, ly) = candidate(&obj, cx, cy, BakeMode::Retail);
            !on_road_retail(&lb, lx, ly, RETAIL_ROAD_WIDTH)
        })
        .collect();
    let want_ace: BTreeSet<(u32, u32)> = interior_vertices()
        .filter(|&(cx, cy)| {
            let (lx, ly) = candidate(&obj, cx, cy, BakeMode::AceCompat);
            !on_road(&lb, lx, ly)
        })
        .collect();
    assert_eq!(accepted_interior(&bake(4.0, 5.0, BakeMode::Retail)), want_retail);
    assert_eq!(accepted_interior(&bake(4.0, 5.0, BakeMode::AceCompat)), want_ace);
    // The road vertex's candidate is 4 m (L1) from the road: inside the
    // 5 m band.
    assert!(!want_retail.contains(&ROAD_VERTEX));
}

/// Retail's band follows the Region's `road_width`: at 3 m the candidate
/// 4 m from the road vertex survives. AceCompat ignores `road_width`
/// entirely (byte-identical output).
#[test]
fn retail_band_width_follows_the_region_and_ace_compat_ignores_it() {
    let rt5 = accepted_interior(&bake(4.0, 5.0, BakeMode::Retail));
    let rt3 = accepted_interior(&bake(4.0, 3.0, BakeMode::Retail));
    assert!(!rt5.contains(&ROAD_VERTEX));
    assert!(rt3.contains(&ROAD_VERTEX));
    assert_eq!(rt3, interior_vertices().collect::<BTreeSet<_>>());

    let ac5 = bake(4.0, 5.0, BakeMode::AceCompat);
    let ac3 = bake(4.0, 3.0, BakeMode::AceCompat);
    assert_eq!(ac5.len(), ac3.len());
    for (a, b) in ac5.iter().zip(ac3.iter()) {
        assert_eq!(placement_bits(a), placement_bits(b));
    }
}
