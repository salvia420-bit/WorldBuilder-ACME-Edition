//! Integration tests for the scenery bake.
//!
//! Three groups:
//! 1. `determinism_repeat` — runs the bake 100× and asserts byte-equal output.
//! 2. `bilinear_height_matches_handcomputed_values` — pins Z snap against
//!    hand-computed ACE-style values for 5 reference positions.
//! 3. `real_holtburg_bake_smoke` — bakes Holtburg LB 0xA9B4 from the
//!    real retail DAT and asserts placement counts are sane.

use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::object_desc::ObjectDesc;
use holtburger_dat::file_type::region::{
    LandDefs, LandSurf, Region, SceneDesc, SceneType, TerrainDesc, TerrainType, TexMerge,
};
use holtburger_dat::file_type::{GameTime, Scene};
use holtburger_dat::graphics::Frame;
use holtburger_dat::landblock::CellLandblock;
use holtburger_common::{Quaternion, Vector3};
use holtburger_scenery_bake::{
    Aabb2D, BakeMode, PlacementXform, ScenicPlacement, bake_landblock, bilinear_height_from_grid,
    transform_mesh_to_aabb, triangle_plane_height_from_grid, vertex_heights,
};
use std::path::PathBuf;

// ---------------------------------------------------------------------------
// Synthetic-fixtures + determinism stress test
// ---------------------------------------------------------------------------

/// Build a Region whose `terrain_info.terrain_types[0].scene_types[0]`
/// points at `scene_info.scene_types[0].scenes[0] = scene_did`. Two
/// terrain_types so the bake exercises the bounds-guard in `tt.scene_types.get`.
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
            terrain_types: vec![
                TerrainType {
                    terrain_name: "T0".to_string(),
                    terrain_color: 0,
                    // Maps scene_type 0 → scene_info_idx 0.
                    scene_types: vec![0],
                },
                TerrainType {
                    terrain_name: "T1".to_string(),
                    terrain_color: 0,
                    scene_types: vec![0],
                },
            ],
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

/// Build a CellLandblock where every vertex carries scene_type=0,
/// terrain_type=0, road=0. Heights ramp linearly so the Z-snap is
/// deterministic and non-trivial.
fn synth_landblock() -> CellLandblock {
    // terrain_type=0, scene_type=0 → terrain_word = 0 (both shifts zero).
    let terrain = vec![0u16; 81];
    // Heights — modest ramp.
    let heights: Vec<u8> = (0..81u8).collect();
    CellLandblock {
        id: 0xA9B4_FFFF,
        has_objects: 0,
        terrain,
        height: heights,
        _align: (),
    }
}

/// A Scene with two `ObjectDesc` rows — one that should trigger most
/// of the time (`freq=1.0`), one that should never (`freq=0.0`).
fn synth_scene(scene_did: u32) -> Scene {
    Scene {
        id: scene_did,
        objects: vec![
            ObjectDesc {
                obj_id: 0x0100_0001,
                base_loc: Frame {
                    origin: Vector3::new(2.0, 2.0, 0.0),
                    orientation: Quaternion::default(),
                },
                freq: 1.0,
                displace_x: 0.5,
                displace_y: 0.5,
                min_scale: 0.9,
                max_scale: 1.1,
                max_rotation: 90.0,
                min_slope: 0.0,
                max_slope: 1.5,
                align: 0,
                orient: 0,
                weenie_obj: 0,
            },
            ObjectDesc {
                obj_id: 0x0100_0002,
                base_loc: Frame {
                    origin: Vector3::new(10.0, 10.0, 0.0),
                    orientation: Quaternion::default(),
                },
                freq: 0.0, // never triggers
                displace_x: 0.0,
                displace_y: 0.0,
                min_scale: 1.0,
                max_scale: 1.0,
                max_rotation: 0.0,
                min_slope: 0.0,
                max_slope: 1.5,
                align: 0,
                orient: 0,
                weenie_obj: 0,
            },
        ],
    }
}

/// Synthetic mesh vertex list — a unit cube's 8 corners. Matches the
/// extents of the legacy `LocalBounds::new(-0.5, 0.5)` fixture so any
/// downstream collision-rejection counts the same way.
fn fixed_local_mesh() -> Vec<Vector3> {
    vec![
        Vector3::new(-0.5, -0.5, 0.0),
        Vector3::new( 0.5, -0.5, 0.0),
        Vector3::new(-0.5,  0.5, 0.0),
        Vector3::new( 0.5,  0.5, 0.0),
        Vector3::new(-0.5, -0.5, 1.0),
        Vector3::new( 0.5, -0.5, 1.0),
        Vector3::new(-0.5,  0.5, 1.0),
        Vector3::new( 0.5,  0.5, 1.0),
    ]
}

/// Build the bake's `compute_world_aabb` closure backed by a fixed
/// mesh. Returns a closure that resolves any obj_id to the fixed cube
/// mesh's transformed AABB — sufficient for synthetic tests.
fn fixed_world_aabb_fn() -> impl FnMut(PlacementXform) -> Option<Aabb2D> {
    let verts = fixed_local_mesh();
    move |px: PlacementXform| {
        Some(transform_mesh_to_aabb(&verts, px.lx, px.ly, px.lz, px.rotation_rad, px.scale))
    }
}

/// 1. Determinism stress test — bake the same synthetic fixture 100×
///    and assert byte-identical output every iteration. Catches:
///    - HashMap iteration order leaking into the output
///    - non-wrapping arithmetic varying with build flags
///    - any accidental use of `rand::*` or system time
#[test]
fn determinism_repeat() {
    const SCENE_DID: u32 = 0x1200_0001;
    let region = synth_region(SCENE_DID);
    let lb = synth_landblock();
    let scene = synth_scene(SCENE_DID);
    // Landblock id 0xA9B4FFFF → block_x = 0xA9 * 8 = 1352, block_y = 0xB4 * 8 = 1440.
    let landblock_id: u32 = 0xA9B4_0000;

    let baseline = bake_landblock(
        &region,
        &lb,
        landblock_id,
        |id| if id == SCENE_DID { Some(scene.clone()) } else { None },
        fixed_world_aabb_fn(),
        &[],
        BakeMode::AceCompat,
    );

    // Sanity — baseline should be non-empty.
    assert!(
        !baseline.is_empty(),
        "synthetic bake must produce at least one placement; got 0"
    );

    for iter in 0..100 {
        let v = bake_landblock(
            &region,
            &lb,
            landblock_id,
            |id| if id == SCENE_DID { Some(scene.clone()) } else { None },
            fixed_world_aabb_fn(),
            &[],
            BakeMode::AceCompat,
        );
        assert_eq!(
            v.len(),
            baseline.len(),
            "iter {} → len drift: {} vs baseline {}",
            iter,
            v.len(),
            baseline.len()
        );
        for (i, (a, b)) in baseline.iter().zip(v.iter()).enumerate() {
            assert_eq!(
                placement_to_bits(a),
                placement_to_bits(b),
                "iter {} placement {} bit-differs from baseline: {:?} vs {:?}",
                iter,
                i,
                a,
                b
            );
        }
    }
}

/// Compare placements by bit-pattern (not float equality — bake output
/// must be byte-identical, including NaN bit patterns if they ever
/// appear).
fn placement_to_bits(p: &ScenicPlacement) -> (u32, u32, u32, u32, u32, u32, u32, u32, u32, u32, u32, u32) {
    (
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
    )
}

// ---------------------------------------------------------------------------
// Bilinear height vs hand-computed values
// ---------------------------------------------------------------------------

/// Pin `bilinear_height_from_grid` against five hand-computed values
/// on a known heightmap. Provides ground truth without depending on
/// `holtburger-world` (wrong dep direction; see brief).
#[test]
fn bilinear_height_matches_handcomputed_values() {
    // 9×9 heightmap: vertex (vx, vy) has height = vx * 10 + vy.
    // height_table[i] = i as f32, so heights[vx*9+vy] = vx*10+vy.
    let mut grid = [0.0f32; 81];
    for vx in 0..9 {
        for vy in 0..9 {
            grid[vx * 9 + vy] = (vx * 10 + vy) as f32;
        }
    }

    // At a vertex: Z = vx*10 + vy.
    assert!((bilinear_height_from_grid(&grid, 0.0, 0.0) - 0.0).abs() < 1e-5);
    assert!((bilinear_height_from_grid(&grid, 24.0, 0.0) - 10.0).abs() < 1e-5);
    assert!((bilinear_height_from_grid(&grid, 0.0, 24.0) - 1.0).abs() < 1e-5);
    assert!((bilinear_height_from_grid(&grid, 48.0, 72.0) - 23.0).abs() < 1e-5);

    // Midpoint of cell (0,0): corners (0,0)=0, (1,0)=10, (0,1)=1, (1,1)=11.
    // Average = (0+10+1+11)/4 = 5.5.
    let z = bilinear_height_from_grid(&grid, 12.0, 12.0);
    assert!((z - 5.5).abs() < 1e-5, "midpoint expected 5.5, got {}", z);

    // Quarter-point of cell (3,4): fx=0.25, fy=0.25.
    // Corners: (3,4)=34, (4,4)=44, (3,5)=35, (4,5)=45.
    // Z = 34*(0.75)*(0.75) + 44*(0.25)*(0.75) + 35*(0.75)*(0.25) + 45*(0.25)*(0.25)
    //   = 19.125 + 8.25 + 6.5625 + 2.8125 = 36.75
    let z = bilinear_height_from_grid(&grid, 24.0 * 3.0 + 6.0, 24.0 * 4.0 + 6.0);
    assert!(
        (z - 36.75).abs() < 1e-4,
        "quarter-point expected 36.75, got {}",
        z
    );
}

// ---------------------------------------------------------------------------
// Real Holtburg DAT smoke test
// ---------------------------------------------------------------------------

/// Resolve the canonical retail portal.dat path. Tries
/// `HOLTBURGER_PORTAL_DAT` env var first, falls back to canonical
/// `~/ac_base_dats/client_portal.dat`. Returns `None` if neither is
/// reachable — test prints a SKIP note and passes.
fn locate_portal_dat() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("HOLTBURGER_PORTAL_DAT") {
        let p = PathBuf::from(p);
        if p.exists() {
            return Some(p);
        }
    }
    let canonical = PathBuf::from("/home/wbterminal/ac_base_dats/client_portal.dat");
    if canonical.exists() {
        return Some(canonical);
    }
    let project = PathBuf::from("/home/wbterminal/projects/RetailSmoke/dats/base/client_portal.dat");
    if project.exists() {
        return Some(project);
    }
    None
}

fn locate_cell_dat() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("HOLTBURGER_CELL_DAT") {
        let p = PathBuf::from(p);
        if p.exists() {
            return Some(p);
        }
    }
    let project = PathBuf::from("/home/wbterminal/projects/RetailSmoke/dats/base/client_cell_1.dat");
    if project.exists() {
        return Some(project);
    }
    let canonical = PathBuf::from("/home/wbterminal/ac_base_dats/client_cell_1.dat");
    if canonical.exists() {
        return Some(canonical);
    }
    None
}

/// 4. Bake Holtburg LB 0xA9B4 + a sample of wilderness LBs from the
///    real retail DAT and verify the algorithm produces sane output.
///
/// Uses an empty `&[Aabb2D]` for buildings and a fixed small bbox
/// for `fetch_obj_bounds` — so collision rejection is minimal. This
/// is intentional: B.2 asserts the ALGORITHM is correct (PRNG, scene
/// selection, displace/scale/rotate, bounds, road skip). Retail-exact
/// placement counts (with full collision data) is Phase B.4.
///
/// ### What Holtburg's bake looks like
///
/// Holtburg LB 0xA9B4 produces **0 placements**. This is correct, not
/// a bug. The diagnostic at `tests/diag_holtburg.rs` (run during
/// development) revealed the chain:
///
///   - 46 of 81 vertices map to `(tt, st) → scene_info_idx=46`, whose
///     `scenes` list is empty → `if scenes.is_empty() { continue; }`.
///   - The remaining 35 vertices all resolve to scene `0x120000A5`.
///   - That scene contains a single `ObjectDesc` with `obj_id=0`,
///     `freq=1.0`, **`weenie_obj=1`**.
///   - Scenery.cs:61 rejects `weenie_obj != 0`, so the placement is
///     skipped.
///
/// Net: Holtburg's terrain is entirely "no procedural scenery" — the
/// town's visible buildings come from `LandblockInfo.objects` (DAT
/// explicit), and the NPCs / lifestone / portals come from the ACE
/// entity channel. Matches retail observation (the town interior has
/// no procedural trees).
///
/// To prove the algorithm IS working when there's something to place,
/// we additionally bake a handful of wilderness LBs (well outside the
/// town grid) and require at least one of them to produce ≥1 placement.
#[test]
fn real_holtburg_bake_smoke() {
    let Some(portal_path) = locate_portal_dat() else {
        eprintln!(
            "[real_holtburg_bake_smoke] SKIP — no client_portal.dat \
             found at HOLTBURGER_PORTAL_DAT, ~/ac_base_dats/, or \
             ~/projects/RetailSmoke/dats/base/"
        );
        return;
    };
    let Some(cell_path) = locate_cell_dat() else {
        eprintln!(
            "[real_holtburg_bake_smoke] SKIP — no client_cell_1.dat found"
        );
        return;
    };

    let portal = DatDatabase::new(&portal_path).expect("portal dat must open");
    let cell = DatDatabase::new(&cell_path).expect("cell dat must open");

    let region_bytes = portal
        .get_file(0x1300_0000)
        .expect("Region 0x13000000 must exist in client_portal.dat");
    let region = Region::unpack(&mut std::io::Cursor::new(&region_bytes))
        .expect("Region 0x13000000 must parse");
    assert!(
        region.scene_info.is_some(),
        "Retail Region 0x13 must have scene_info"
    );

    let bake_one = |lb_id: u32| -> Option<Vec<ScenicPlacement>> {
        let did = lb_id | 0xFFFF;
        let bytes = cell.get_file(did).ok()?;
        let landblock = CellLandblock::unpack(&bytes).ok()?;
        let placements = bake_landblock(
            &region,
            &landblock,
            lb_id,
            |scene_id| {
                let bytes = portal.get_file(scene_id).ok()?;
                Scene::unpack(&mut std::io::Cursor::new(&bytes)).ok()
            },
            fixed_world_aabb_fn(),
            &[],
            BakeMode::AceCompat,
        );
        Some(placements)
    };

    // (1) Holtburg LB itself — expected: 0 placements (see docstring).
    let holtburg_placements = bake_one(0xA9B4_0000).expect("Holtburg LB 0xA9B4FFFF must exist");
    eprintln!(
        "[real_holtburg_bake_smoke] Holtburg LB 0xA9B4 → {} placements (expected: 0)",
        holtburg_placements.len()
    );
    assert_eq!(
        holtburg_placements.len(),
        0,
        "Holtburg LB 0xA9B4 should produce 0 procedural placements \
         (all candidates are weenie-managed); got {}",
        holtburg_placements.len()
    );

    // (2) Wilderness LB sample — at least one MUST produce ≥1 placement
    //     to prove the algorithm pipeline (PRNG → scene → displace →
    //     scale → rotate → Z-snap → quat) actually fires end-to-end on
    //     real data.
    let wilderness_lbs: Vec<u32> = vec![
        0x4040_0000, 0xC0C0_0000, 0xF8F8_0000, 0x6010_0000, 0x9020_0000, 0xD040_0000,
    ];
    let mut total_wilderness_placements = 0usize;
    let mut sample_count_per_lb = Vec::new();
    for lb_id in &wilderness_lbs {
        let Some(placements) = bake_one(*lb_id) else {
            continue;
        };
        sample_count_per_lb.push((*lb_id, placements.len()));
        total_wilderness_placements += placements.len();

        // Validate every placement's geometry.
        for p in &placements {
            assert!(
                (0.0..=192.0).contains(&p.x),
                "LB 0x{:08X} placement {:?} x out of [0, 192]",
                lb_id,
                p
            );
            assert!(
                (0.0..=192.0).contains(&p.y),
                "LB 0x{:08X} placement {:?} y out of [0, 192]",
                lb_id,
                p
            );
            assert!(p.z.is_finite(), "LB 0x{:08X} placement z not finite", lb_id);
            assert!(
                (0.1..=10.0).contains(&p.scale),
                "LB 0x{:08X} placement {:?} scale out of [0.1, 10.0]",
                lb_id,
                p
            );
            // Quaternion should be unit-length.
            let qmag = (p.qw * p.qw + p.qx * p.qx + p.qy * p.qy + p.qz * p.qz).sqrt();
            assert!(
                (qmag - 1.0).abs() < 1e-4,
                "LB 0x{:08X} placement {:?} quaternion not unit-length (mag={})",
                lb_id,
                p,
                qmag
            );
            // Brief upper bound 1000 per LB.
            assert!(
                placements.len() < 1000,
                "LB 0x{:08X} placement count {} exceeds sane upper bound 1000",
                lb_id,
                placements.len()
            );
        }
    }
    eprintln!(
        "[real_holtburg_bake_smoke] Wilderness sample: {:?} ({} total)",
        sample_count_per_lb, total_wilderness_placements
    );
    assert!(
        total_wilderness_placements > 0,
        "wilderness sample must produce at least one placement \
         (proves PRNG → scene → emit chain fires); got 0 across {} LBs",
        wilderness_lbs.len()
    );

    // (3) Determinism on real data: bake wilderness LB 0xC0C00000
    //     twice and assert byte-equal output.
    let p1 = bake_one(0xC0C0_0000).unwrap();
    let p2 = bake_one(0xC0C0_0000).unwrap();
    assert_eq!(p1.len(), p2.len(), "real bake should be deterministic");
    for (a, b) in p1.iter().zip(p2.iter()) {
        assert_eq!(placement_to_bits(a), placement_to_bits(b));
    }
}

/// BakeMode::AceCompat is the default and must round-trip through
/// `as_str` / `FromStr`.
#[test]
fn bake_mode_default_and_round_trip() {
    let default: BakeMode = BakeMode::default();
    assert_eq!(default, BakeMode::AceCompat);
    let s = default.as_str();
    assert_eq!(s, "ace-compat");
    let back: BakeMode = s.parse().unwrap();
    assert_eq!(back, default);
    // Strict also round-trips.
    let s2 = BakeMode::Strict.as_str();
    let back2: BakeMode = s2.parse().unwrap();
    assert_eq!(back2, BakeMode::Strict);
}

/// AceCompat vs Strict: on a synthetic LB built from `synth_landblock`
/// where every vertex's slope is well inside `[min_slope, max_slope]`
/// of the test ObjectDesc, AceCompat ≡ Strict in placement COUNT (the
/// only delta is Z). On a synthetic LB designed to fail the slope check
/// for AT LEAST one placement, AceCompat ⊃ Strict — the slope-rejected
/// placements survive in AceCompat.
///
/// W1 (2026-05-29): slope rejection now compares the terrain-normal Z
/// (`cos slope`, 1.0 flat → 0.0 vertical) against `[min_slope,
/// max_slope]` per retail `ObjectDesc::CheckSlope`. So a STEEP ramp has
/// a LOW `N.z`, and to reject it the scene's `min_slope` must be set
/// ABOVE that low cosine. (Pre-W1 this test compared the slope ANGLE in
/// radians and rejected with `> max_slope`; that test would no longer
/// trigger under the corrected semantics, so the fixture is rebuilt to
/// reject on a `min_slope` floor.)
#[test]
fn ace_compat_is_strict_superset_on_steep_terrain() {
    const SCENE_DID: u32 = 0x1200_0001;

    // Build a 9×9 with a steep ramp so the terrain-normal Z is low.
    // table[i] = i*4 with height byte = vx*180 (capped 255) gives a
    // per-cell Z step of ~720 over CELL_SIZE=24 → dz/dx ≈ 30, so
    //   N.z = 1 / sqrt(30² + 1) ≈ 0.033
    // (i.e. an almost-vertical face). With the scene's `min_slope`
    // floor set to 0.5 (reject anything steeper than ~60°), every
    // ramp placement's `N.z ≈ 0.033 < 0.5` and is REJECTED in Strict
    // mode while surviving in AceCompat (which never slope-checks).
    let table: Vec<f32> = (0..256).map(|i| (i as f32) * 4.0).collect();
    let mut heights = vec![0u8; 81];
    for vx in 0..9 {
        for vy in 0..9 {
            let b = ((vx as u16 * 180).min(255)) as u8;
            heights[vx * 9 + vy] = b;
        }
    }
    let lb = CellLandblock {
        id: 0xA9B4_FFFF,
        has_objects: 0,
        terrain: vec![0u16; 81],
        height: heights,
        _align: (),
    };
    let region = synth_region_with_table(SCENE_DID, table);
    // Custom scene: identical to `synth_scene` but with a `min_slope`
    // floor of 0.5 (cosine) so the steep ramp's `N.z ≈ 0.033` falls
    // below it and is slope-rejected in Strict mode.
    let mut scene = synth_scene(SCENE_DID);
    for obj in &mut scene.objects {
        obj.min_slope = 0.5;
        obj.max_slope = 1.0;
    }

    let bake = |mode| {
        bake_landblock(
            &region,
            &lb,
            0xA9B4_0000,
            |id| if id == SCENE_DID { Some(scene.clone()) } else { None },
            fixed_world_aabb_fn(),
            &[],
            mode,
        )
    };
    let ac = bake(BakeMode::AceCompat);
    let st = bake(BakeMode::Strict);

    assert!(
        ac.len() >= st.len(),
        "AceCompat ({}) must be ≥ Strict ({}) on slope-rejecting terrain",
        ac.len(),
        st.len()
    );
    // And for THIS fixture the slope-rejected set must be non-empty —
    // otherwise we're not actually testing the slope branch.
    assert!(
        ac.len() > st.len(),
        "fixture failed to trigger slope rejection: ac={} st={}",
        ac.len(),
        st.len()
    );
}

/// Helper used by the slope-superset test — same as synth_region but
/// with a caller-supplied land_height_table for steeper ramps.
fn synth_region_with_table(scene_did: u32, table: Vec<f32>) -> Region {
    let mut r = synth_region(scene_did);
    r.land_defs.land_height_table = table;
    r
}

/// AceCompat Z (triangle-plane) and Strict Z (bilinear) agree at cell
/// CORNERS — both methods evaluate to the raw vertex height there. So
/// any placement that lands exactly on a corner must have identical Z
/// between the two modes.
#[test]
fn ace_and_strict_z_agree_at_corners() {
    let mut grid = [0.0f32; 81];
    for vx in 0..9 {
        for vy in 0..9 {
            grid[vx * 9 + vy] = (vx * 10 + vy) as f32;
        }
    }
    for cx in 0..9 {
        for cy in 0..9 {
            let lx = cx as f32 * 24.0;
            let ly = cy as f32 * 24.0;
            let zb = bilinear_height_from_grid(&grid, lx, ly);
            let zt = triangle_plane_height_from_grid(&grid, 0xA9B4, lx, ly);
            assert!(
                (zb - zt).abs() < 1e-3,
                "corner ({cx},{cy}): bilinear={zb} triangle={zt}"
            );
        }
    }
}

/// Quick health-check that `vertex_heights` returns 81 values when
/// fed a synthetic region + LB. Catches regressions in the height
/// table lookup wiring without depending on real DATs.
#[test]
fn vertex_heights_returns_81_values_synthetic() {
    let region = synth_region(0x1200_0001);
    let lb = synth_landblock();
    let heights = vertex_heights(&region, &lb);
    assert_eq!(heights.len(), 81);
    // height[i] = height_table[height_byte[i]] = (i as f32) * 0.5
    // (since synth_region's table is i*0.5 and synth_landblock's
    // height bytes ramp 0..80).
    for i in 0..81 {
        let expected = (i as f32) * 0.5;
        assert!(
            (heights[i] - expected).abs() < 1e-5,
            "heights[{}] expected {}, got {}",
            i,
            expected,
            heights[i]
        );
    }
}
