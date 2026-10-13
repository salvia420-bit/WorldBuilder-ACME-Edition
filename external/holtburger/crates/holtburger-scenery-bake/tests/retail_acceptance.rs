//! `BakeMode::Retail` — retail acceptance (terrain-scenery-3).
//!
//! Retail `CLandBlock::get_land_scenes` (`acclient.c:352673-352718`) keeps a
//! candidate only if `0 <= x, y < 192`, it is off the road, its land cell
//! holds no building ORIGIN, the walkable terrain triangle's `N.z` is within
//! `[min_slope, max_slope]`, and `CPhysicsObj::obj_within_block` passes. It
//! has no box test of any kind. `AceCompat` replays ACE's dead
//! `Entity/Scenery.cs`: `<= 192`, building AABB overlap, scenery AABB
//! overlap, no slope test.
//!
//! Fixture: one Scene, objects at `freq = 1.0` (the gate always passes),
//! no displacement / scale noise, no roads. An object at base origin
//! `(0, 0)` lands exactly on its source vertex, so the candidates sit at
//! `(24 * cx, 24 * cy)` for every vertex `cx, cy` in `0..=8`. The AABB
//! closure returns a real 6 m box around each candidate (vertices are 24 m
//! apart, so one-object boxes never overlap each other).

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
    Aabb2D, Aabb3D, BakeMode, BlockSphere, PlacementXform, ScenicPlacement, WithinBlockQuery,
    WithinBlockShape, bake_landblock, bake_landblock_retail, building_cell_mask,
};

const SCENE_DID: u32 = 0x1200_0001;
/// Holtburg's LB id.
const LB_ID: u32 = 0xA9B4_0000;
/// Half-width of the box the AABB closure builds around each candidate.
const BOX_HALF: f32 = 3.0;

/// Same shape as `retail_mode.rs::synth_region`, with the height table as a
/// parameter (256 entries; the landblock's height bytes index it).
fn synth_region(land_height_table: Vec<f32>) -> Region {
    assert_eq!(land_height_table.len(), 256);
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
                scenes: vec![SCENE_DID],
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

/// Terrain word 0 everywhere (terrain type 0, scene type 0, no road), with
/// the given 81 height bytes (`idx = vx * 9 + vy`).
fn landblock(height: Vec<u8>) -> CellLandblock {
    assert_eq!(height.len(), 81);
    CellLandblock {
        id: 0xA9B4_FFFF,
        has_objects: 0,
        terrain: vec![0u16; 81],
        height,
        _align: (),
    }
}

/// Flat terrain: every height byte 0, table all 0.
fn flat() -> (Region, CellLandblock) {
    (synth_region(vec![0.0; 256]), landblock(vec![0u8; 81]))
}

/// A planar ramp along X with gradient `g`: height byte `vx`, table
/// `i * 24 * g`. Every terrain triangle has `N.z = 1 / sqrt(1 + g^2)`.
fn ramp(g: f32) -> (Region, CellLandblock) {
    let table: Vec<f32> = (0..256).map(|i| i as f32 * 24.0 * g).collect();
    let mut height = vec![0u8; 81];
    for vx in 0..9 {
        for vy in 0..9 {
            height[vx * 9 + vy] = vx as u8;
        }
    }
    (synth_region(table), landblock(height))
}

/// Every cell a saddle: height `h` on vertices with `vx + vy` odd, else 0.
/// The 4-corner plane fit is flat everywhere, but every terrain triangle
/// slopes with `N.z = 1 / sqrt(1 + 2 (h / 24)^2)`.
fn saddles(h: f32) -> (Region, CellLandblock) {
    let mut table = vec![0.0f32; 256];
    table[1] = h;
    let mut height = vec![0u8; 81];
    for vx in 0..9 {
        for vy in 0..9 {
            height[vx * 9 + vy] = ((vx + vy) % 2) as u8;
        }
    }
    (synth_region(table), landblock(height))
}

fn object(k: u32, origin_x: f32, min_slope: f32, max_slope: f32) -> ObjectDesc {
    ObjectDesc {
        obj_id: 0x0200_0001 + k,
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
        min_slope,
        max_slope,
        align: 0,
        orient: 0,
        weenie_obj: 0,
    }
}

fn scene(objects: Vec<ObjectDesc>) -> Scene {
    Scene {
        id: SCENE_DID,
        objects,
    }
}

/// A real box `2 * BOX_HALF` wide around the candidate.
fn box_around(px: PlacementXform) -> Option<Aabb3D> {
    Some(Aabb3D::new(
        px.lx - BOX_HALF,
        px.ly - BOX_HALF,
        px.lz,
        px.lx + BOX_HALF,
        px.ly + BOX_HALF,
        px.lz + 5.0,
    ))
}

fn bake_retail(
    region: &Region,
    lb: &CellLandblock,
    sc: &Scene,
    building_cells: u64,
    within_block: impl FnMut(WithinBlockQuery) -> bool,
) -> Vec<ScenicPlacement> {
    bake_landblock_retail(
        region,
        lb,
        LB_ID,
        |id| if id == SCENE_DID { Some(sc.clone()) } else { None },
        box_around,
        building_cells,
        within_block,
    )
}

fn bake_mode(
    region: &Region,
    lb: &CellLandblock,
    sc: &Scene,
    building_aabbs: &[Aabb2D],
    mode: BakeMode,
) -> Vec<ScenicPlacement> {
    bake_landblock(
        region,
        lb,
        LB_ID,
        |id| if id == SCENE_DID { Some(sc.clone()) } else { None },
        box_around,
        building_aabbs,
        mode,
    )
}

fn always(_: WithinBlockQuery) -> bool {
    true
}

/// Accepted `(source_cell_x, source_cell_y, source_obj_idx)` triples.
fn accepted(placements: &[ScenicPlacement]) -> BTreeSet<(u32, u32, u32)> {
    placements
        .iter()
        .map(|p| (p.source_cell_x, p.source_cell_y, p.source_obj_idx))
        .collect()
}

/// Every vertex `0..=hi` on both axes, object 0.
fn vertices_upto(hi: u32) -> BTreeSet<(u32, u32, u32)> {
    (0..=hi).flat_map(|cx| (0..=hi).map(move |cy| (cx, cy, 0))).collect()
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

/// Test plan 4: retail's bounds are strict, so the vertex row/column at
/// 192 places nothing; ACE's dead port accepts `x == 192`.
#[test]
fn x_or_y_of_192_is_rejected_in_retail_and_accepted_in_ace_compat() {
    let (region, lb) = flat();
    let sc = scene(vec![object(0, 0.0, 0.0, 1.0)]);
    let rt = bake_retail(&region, &lb, &sc, 0, always);
    assert_eq!(accepted(&rt), vertices_upto(7), "Retail: 0..=7 on both axes");
    assert!(rt.iter().all(|p| p.x < 192.0 && p.y < 192.0));
    let ac = bake_mode(&region, &lb, &sc, &[], BakeMode::AceCompat);
    assert_eq!(accepted(&ac), vertices_upto(8), "AceCompat accepts the 192 edge");
    assert!(ac.iter().any(|p| p.x == 192.0));
}

/// Test plan 1: a building occupies only the cell holding its origin. The
/// origin (30, 30) is cell (1, 1), so the candidate at (24, 24) — vertex
/// (1, 1), in that cell — is rejected, while the one at (48, 24) — vertex
/// (2, 1), cell (2, 1) — is kept even though its box overlaps the
/// building's box, which is exactly what AceCompat rejects it for.
#[test]
fn building_rejects_only_its_origin_cell_and_never_by_box() {
    let (region, lb) = flat();
    let sc = scene(vec![object(0, 0.0, 0.0, 1.0)]);
    let cells = building_cell_mask(LB_ID, [(30.0f32, 30.0f32)]);
    assert_eq!(cells, 1u64 << 9);
    // The building's render box spans cells (0..=2, 0..=1).
    let building_box = Aabb2D::new(20.0, 20.0, 52.0, 40.0);

    let rt = bake_retail(&region, &lb, &sc, cells, always);
    let mut want = vertices_upto(7);
    want.remove(&(1, 1, 0));
    assert_eq!(accepted(&rt), want, "Retail drops exactly the building-origin cell");
    let kept = rt
        .iter()
        .find(|p| (p.source_cell_x, p.source_cell_y) == (2, 1))
        .expect("vertex (2,1) kept in Retail");
    assert_eq!((kept.x, kept.y), (48.0, 24.0));
    assert!(
        kept.bounds.xy().intersects(&building_box),
        "the kept candidate's box overlaps the building's"
    );

    // The same building box is ignored by Retail even when handed to the
    // legacy entry point...
    let rt_legacy = bake_mode(&region, &lb, &sc, &[building_box], BakeMode::Retail);
    assert_eq!(accepted(&rt_legacy), vertices_upto(7));
    // ...and AceCompat rejects exactly the candidates whose box touches
    // it: (24, 24) and (48, 24). The (24, 48) box starts at y = 45, clear
    // of the building box's y = 40.
    let ac = bake_mode(&region, &lb, &sc, &[building_box], BakeMode::AceCompat);
    let mut want_ac = vertices_upto(8);
    want_ac.remove(&(1, 1, 0));
    want_ac.remove(&(2, 1, 0));
    assert_eq!(accepted(&ac), want_ac, "AceCompat box-rejects (1,1) and (2,1) only");
}

/// A building origin outside the block marks no cell here.
#[test]
fn out_of_block_building_origin_rejects_nothing() {
    let (region, lb) = flat();
    let sc = scene(vec![object(0, 0.0, 0.0, 1.0)]);
    let cells = building_cell_mask(LB_ID, [(-5.0f32, 30.0f32), (200.0, 30.0)]);
    assert_eq!(cells, 0);
    assert_eq!(accepted(&bake_retail(&region, &lb, &sc, cells, always)), vertices_upto(7));
}

/// Test plan 2a: the slope gate. With `min_slope = 0.95`, a ramp whose
/// triangles have `N.z = 0.9` places nothing in Retail; one with
/// `N.z = 0.97` places everything. AceCompat never slope-checks.
#[test]
fn slope_gate_uses_n_z_against_min_and_max_slope() {
    let sc = scene(vec![object(0, 0.0, 0.95, 1.0)]);
    // N.z = 1/sqrt(1 + g^2): g = 0.484322 -> 0.9, g = 0.250624 -> 0.97.
    let (steep_region, steep_lb) = ramp(0.484_322);
    let (gentle_region, gentle_lb) = ramp(0.250_624);

    let steep = bake_retail(&steep_region, &steep_lb, &sc, 0, always);
    assert!(steep.is_empty(), "N.z 0.9 < min_slope 0.95: {} placed", steep.len());
    let gentle = bake_retail(&gentle_region, &gentle_lb, &sc, 0, always);
    assert_eq!(accepted(&gentle), vertices_upto(7), "N.z 0.97 >= 0.95");

    let ac = bake_mode(&steep_region, &steep_lb, &sc, &[], BakeMode::AceCompat);
    assert_eq!(accepted(&ac), vertices_upto(8), "AceCompat has no slope gate");

    // max_slope bounds the other side: N.z 0.97 > max 0.96.
    let capped = scene(vec![object(0, 0.0, 0.0, 0.96)]);
    assert!(bake_retail(&gentle_region, &gentle_lb, &capped, 0, always).is_empty());
    let (flat_region, flat_lb) = flat();
    assert!(bake_retail(&flat_region, &flat_lb, &capped, 0, always).is_empty());
}

/// Test plan 2b: the gate reads the walkable TRIANGLE's normal, not the
/// 4-corner plane fit. On saddle cells the fit is flat (`Strict`, which
/// uses it, keeps everything) but every triangle has `N.z = 0.8`, so
/// Retail places nothing against `min_slope = 0.95`.
#[test]
fn slope_gate_reads_the_triangle_not_the_four_corner_fit() {
    // N.z = 0.8 -> 1 + 2 g^2 = 1.5625 -> g = 0.530330 -> h = 24 g.
    let h = 24.0 * 0.530_330_1f32;
    let (region, lb) = saddles(h);
    let sc = scene(vec![object(0, 0.0, 0.95, 1.0)]);
    let rt = bake_retail(&region, &lb, &sc, 0, always);
    assert!(rt.is_empty(), "triangle N.z 0.8 must fail min_slope 0.95: {} placed", rt.len());
    // (Strict's clamped fit at x or y = 192 is an edge, not a saddle, so
    // only the in-block vertices are asserted.)
    let st = accepted(&bake_mode(&region, &lb, &sc, &[], BakeMode::Strict));
    assert!(
        vertices_upto(7).is_subset(&st),
        "Strict's 4-corner fit reads every saddle cell as flat"
    );
    // And the triangle gate passes when the bound allows 0.8.
    let loose = scene(vec![object(0, 0.0, 0.79, 0.81)]);
    assert_eq!(accepted(&bake_retail(&region, &lb, &loose, 0, always)), vertices_upto(7));
}

/// Test plan 3: the within-block closure decides, sees the placement frame
/// the placement ships with, and is only reached by candidates that passed
/// every earlier gate. A cylsphere at object-local (1, 0) with radius 1.2
/// pokes over the x = 0 / y = 0 edge at every rotation from the column and
/// row of vertex 0, and nowhere else.
#[test]
fn within_block_closure_rejects_edge_crossers_and_sees_the_frame() {
    let (region, lb) = flat();
    let mut obj = object(0, 0.0, 0.0, 1.0);
    obj.max_rotation = 360.0;
    let sc = scene(vec![obj]);
    let shape = WithinBlockShape::CylSpheres(vec![BlockSphere::new(
        Vector3::new(1.0, 0.0, 0.0),
        1.2,
    )]);
    let mut seen: Vec<WithinBlockQuery> = Vec::new();
    let rt = bake_retail(&region, &lb, &sc, 0, |q| {
        seen.push(q);
        shape.within_block(&q)
    });

    let want: BTreeSet<_> = (1..=7u32).flat_map(|cx| (1..=7u32).map(move |cy| (cx, cy, 0))).collect();
    assert_eq!(accepted(&rt), want);
    // Every in-bounds candidate (8 x 8) reached the gate; the 192 edge never did.
    assert_eq!(seen.len(), 64);
    assert!(seen.iter().all(|q| q.x < 192.0 && q.y < 192.0));
    assert!(seen.iter().all(|q| q.obj_id == 0x0200_0001));
    // The query frame is the shipped frame, bit for bit.
    for p in &rt {
        let q = seen
            .iter()
            .find(|q| q.x.to_bits() == p.x.to_bits() && q.y.to_bits() == p.y.to_bits())
            .expect("a query per accepted placement");
        assert_eq!(
            [q.z, q.qw, q.qx, q.qy, q.qz].map(f32::to_bits),
            [p.z, p.qw, p.qx, p.qy, p.qz].map(f32::to_bits)
        );
    }
    // Rotations actually vary, so the frame is not a constant.
    assert!(rt.iter().any(|p| p.qz.abs() > 0.1));

    // A rejecting closure places nothing; candidates rejected earlier
    // (building cell) never reach it.
    let mut calls = 0usize;
    let none = bake_retail(&region, &lb, &sc, u64::MAX, |_| {
        calls += 1;
        false
    });
    assert!(none.is_empty());
    assert_eq!(calls, 0, "every cell holds a building: no candidate reaches within_block");
}

/// Test plan 5: retail has no scenery-vs-scenery test. Two objects 1 m
/// apart with 6 m boxes overlap at every vertex: AceCompat keeps only the
/// first, Retail keeps both.
#[test]
fn overlapping_candidates_are_all_kept_in_retail() {
    let (region, lb) = flat();
    let sc = scene(vec![object(0, 0.0, 0.0, 1.0), object(1, 1.0, 0.0, 1.0)]);
    let rt = accepted(&bake_retail(&region, &lb, &sc, 0, always));
    let ac = accepted(&bake_mode(&region, &lb, &sc, &[], BakeMode::AceCompat));
    for cx in 1..=7u32 {
        for cy in 1..=7u32 {
            assert!(rt.contains(&(cx, cy, 0)) && rt.contains(&(cx, cy, 1)), "Retail ({cx},{cy})");
            assert!(ac.contains(&(cx, cy, 0)), "AceCompat keeps the first ({cx},{cy})");
            assert!(!ac.contains(&(cx, cy, 1)), "AceCompat drops the overlapping second ({cx},{cy})");
        }
    }
}

/// Retail still builds and ships the box (the collider broad phase), the
/// one the closure returned for the accepted pose.
#[test]
fn retail_ships_the_closure_box_as_bounds() {
    let (region, lb) = ramp(0.25);
    let sc = scene(vec![object(0, 0.0, 0.0, 1.0)]);
    let rt = bake_retail(&region, &lb, &sc, 0, always);
    assert_eq!(rt.len(), 64);
    for p in &rt {
        let want = Aabb3D::new(
            p.x - BOX_HALF,
            p.y - BOX_HALF,
            p.z,
            p.x + BOX_HALF,
            p.y + BOX_HALF,
            p.z + 5.0,
        );
        assert_eq!(p.bounds, want, "bounds at ({}, {})", p.x, p.y);
    }
}

/// The legacy entry point in Retail mode is `bake_landblock_retail` with no
/// building cells and an always-true within-block test, bit for bit.
#[test]
fn legacy_entry_point_is_retail_without_cells_or_within_block() {
    let (region, lb) = ramp(0.3);
    let mut obj = object(0, 0.0, 0.9, 1.0);
    obj.max_rotation = 90.0;
    let sc = scene(vec![obj, object(1, 2.5, 0.0, 1.0)]);
    let a = bake_retail(&region, &lb, &sc, 0, always);
    let b = bake_mode(&region, &lb, &sc, &[Aabb2D::new(0.0, 0.0, 192.0, 192.0)], BakeMode::Retail);
    assert!(!a.is_empty());
    assert_eq!(a.len(), b.len());
    for (x, y) in a.iter().zip(b.iter()) {
        assert_eq!(placement_bits(x), placement_bits(y));
    }
}

/// Retail keeps the bake's determinism contract with every gate live.
#[test]
fn retail_acceptance_is_deterministic() {
    let (region, lb) = saddles(6.0);
    let mut obj = object(0, 3.0, 0.9, 1.0);
    obj.max_rotation = 360.0;
    let sc = scene(vec![obj, object(1, 0.5, 0.0, 1.0)]);
    let cells = building_cell_mask(LB_ID, [(100.0f32, 100.0f32), (12.0, 170.0)]);
    let shape = WithinBlockShape::SortingSphere(BlockSphere::new(Vector3::new(0.0, 2.0, 1.0), 2.5));
    let first = bake_retail(&region, &lb, &sc, cells, |q| shape.within_block(&q));
    assert!(!first.is_empty());
    for _ in 0..10 {
        let again = bake_retail(&region, &lb, &sc, cells, |q| shape.within_block(&q));
        assert_eq!(again.len(), first.len());
        for (a, b) in first.iter().zip(again.iter()) {
            assert_eq!(placement_bits(a), placement_bits(b));
        }
    }
}
