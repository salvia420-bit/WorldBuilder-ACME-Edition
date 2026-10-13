//! `BakeMode::Retail` — the retail scenery frame (terrain-scenery-4).
//!
//! Retail `CLandBlock::get_land_scenes` (`acclient.c:352703-352706`) builds
//! each object's frame with `ObjectDesc::ObjAlign` when `align != 0`, else
//! `ObjectDesc::GetObjFrame`: `base_loc` whole, then
//! `Frame::set_heading(noise * max_rot)` in compass DEGREES (clockwise from
//! north) when `max_rot > 0`. `AceCompat` keeps ACE's dead
//! `Entity/Scenery.cs` yaw, `(cos(r/2), 0, 0, +sin(r/2))`, so the two turn
//! opposite ways for the same noise.
//!
//! Fixture: one Scene, objects at `freq = 1.0` (the gate always passes),
//! base origin `(0, 0)` and no displacement / scale noise, no roads, no
//! buildings, so every candidate sits on its source vertex `(24 cx, 24 cy)`.

use holtburger_common::{Quaternion, Vector3};
use holtburger_dat::file_type::object_desc::ObjectDesc;
use holtburger_dat::file_type::region::{
    LandDefs, LandSurf, Region, SceneDesc, SceneType, TerrainDesc, TerrainType, TexMerge,
};
use holtburger_dat::file_type::{GameTime, Scene};
use holtburger_dat::graphics::Frame;
use holtburger_dat::landblock::CellLandblock;
use holtburger_scenery_bake::{
    Aabb3D, BakeMode, PlacementXform, ScenicPlacement, WithinBlockQuery, bake_landblock,
    bake_landblock_retail, rotate_obj, rotate_obj_retail, yaw_about_z,
};

const SCENE_DID: u32 = 0x1200_0001;
/// Holtburg's LB id.
const LB_ID: u32 = 0xA9B4_0000;
const EPS: f32 = 1e-5;

/// Same shape as `retail_acceptance.rs::synth_region`.
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

fn flat() -> (Region, CellLandblock) {
    (synth_region(vec![0.0; 256]), landblock(vec![0u8; 81]))
}

/// A planar ramp rising toward +X with gradient `g` (`z = g * x`): every
/// terrain triangle's upward normal is `(-g, 0, 1) / sqrt(1 + g^2)`.
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

fn object(base: Quaternion, max_rotation: f32, align: u32) -> ObjectDesc {
    ObjectDesc {
        obj_id: 0x0200_0001,
        base_loc: Frame {
            origin: Vector3::new(0.0, 0.0, 0.0),
            orientation: base,
        },
        freq: 1.0,
        displace_x: 0.0,
        displace_y: 0.0,
        min_scale: 1.0,
        max_scale: 1.0,
        max_rotation,
        min_slope: 0.0,
        max_slope: 1.0,
        align,
        orient: 0,
        weenie_obj: 0,
    }
}

fn scene(obj: ObjectDesc) -> Scene {
    Scene {
        id: SCENE_DID,
        objects: vec![obj],
    }
}

/// A 6 m box around the candidate; vertices are 24 m apart, so AceCompat's
/// overlap test never fires.
fn box_around(px: PlacementXform) -> Option<Aabb3D> {
    Some(Aabb3D::new(px.lx - 3.0, px.ly - 3.0, px.lz, px.lx + 3.0, px.ly + 3.0, px.lz + 5.0))
}

fn bake_retail(region: &Region, lb: &CellLandblock, sc: &Scene) -> Vec<ScenicPlacement> {
    bake_landblock_retail(
        region,
        lb,
        LB_ID,
        |id| if id == SCENE_DID { Some(sc.clone()) } else { None },
        box_around,
        0,
        |_: WithinBlockQuery| true,
    )
}

fn bake_ace(region: &Region, lb: &CellLandblock, sc: &Scene) -> Vec<ScenicPlacement> {
    bake_landblock(
        region,
        lb,
        LB_ID,
        |id| if id == SCENE_DID { Some(sc.clone()) } else { None },
        box_around,
        &[],
        BakeMode::AceCompat,
    )
}

fn quat(p: &ScenicPlacement) -> Quaternion {
    Quaternion {
        w: p.qw,
        x: p.qx,
        y: p.qy,
        z: p.qz,
    }
}

/// The placement's forward (+Y) axis in world space (`Frame::cache`
/// `m_fl2gv[3..6]`).
fn forward(p: &ScenicPlacement) -> (f32, f32, f32) {
    let (w, x, y, z) = (p.qw, p.qx, p.qy, p.qz);
    (
        2.0 * (x * y - w * z),
        1.0 - 2.0 * (x * x + z * z),
        2.0 * (y * z + w * x),
    )
}

fn global_cell(p: &ScenicPlacement) -> (u32, u32) {
    (
        (LB_ID >> 24) * 8 + p.source_cell_x,
        ((LB_ID >> 16) & 0xFF) * 8 + p.source_cell_y,
    )
}

fn yaw(rad: f64) -> Quaternion {
    Quaternion {
        w: (rad * 0.5).cos() as f32,
        x: 0.0,
        y: 0.0,
        z: (rad * 0.5).sin() as f32,
    }
}

/// Test plan (ACE AFrame cross-check): for the same noise, Retail turns
/// clockwise — `(cos(d/2), 0, 0, -sin(d/2))`, forward `(sin d, cos d)` —
/// and AceCompat counter-clockwise, `(cos(r/2), 0, 0, +sin(r/2))`. With a
/// 0-90 degree range the two are mirror images: same `qw`, opposite `qz`.
#[test]
fn retail_heading_is_clockwise_and_mirrors_ace_compat() {
    let (region, lb) = flat();
    let obj = object(Quaternion::identity(), 90.0, 0);
    let sc = scene(obj.clone());
    let rt = bake_retail(&region, &lb, &sc);
    let ac = bake_ace(&region, &lb, &sc);
    assert_eq!(rt.len(), 64);
    let mut turned = 0;
    for p in &rt {
        let a = ac
            .iter()
            .find(|a| (a.source_cell_x, a.source_cell_y) == (p.source_cell_x, p.source_cell_y))
            .expect("AceCompat places every Retail vertex");
        let (gx, gy) = global_cell(p);
        let d = rotate_obj_retail(&obj, gx, gy, 0) as f64;
        assert!((0.0..90.0).contains(&d), "heading {d}");
        let f = forward(p);
        let want = (d.to_radians().sin() as f32, d.to_radians().cos() as f32);
        assert!(
            (f.0 - want.0).abs() < EPS && (f.1 - want.1).abs() < EPS && f.2.abs() < EPS,
            "({}, {}) heading {d}: forward {f:?}, want {want:?}",
            p.source_cell_x,
            p.source_cell_y
        );
        assert_eq!((p.qx, p.qy), (0.0, 0.0), "a level base stays level");
        assert!(p.qz <= 0.0 && a.qz >= 0.0, "Retail qz {} vs AceCompat qz {}", p.qz, a.qz);
        assert!((p.qw - a.qw).abs() < EPS, "qw {} vs {}", p.qw, a.qw);
        assert!((p.qz + a.qz).abs() < EPS, "qz {} must mirror {}", p.qz, a.qz);
        if p.qz < -0.05 {
            turned += 1;
        }
    }
    assert!(turned > 10, "the noise must actually turn things ({turned})");
}

/// AceCompat is unchanged: still exactly `(cos(r/2), 0, 0, sin(r/2))` of
/// `rotate_obj`, f64 sin/cos narrowed, base orientation and `align`
/// ignored.
#[test]
fn ace_compat_orientation_is_still_the_yaw_of_rotate_obj() {
    let (region, lb) = ramp(0.25);
    let obj = object(yaw(-std::f64::consts::FRAC_PI_2), 360.0, 1);
    let ac = bake_ace(&region, &lb, &scene(obj.clone()));
    assert_eq!(ac.len(), 81);
    for p in &ac {
        let (gx, gy) = global_cell(p);
        let half = rotate_obj(&obj, gx, gy, 0) * 0.5;
        assert_eq!(
            [p.qw, p.qx, p.qy, p.qz].map(f32::to_bits),
            [(half as f64).cos() as f32, 0.0, 0.0, (half as f64).sin() as f32].map(f32::to_bits)
        );
    }
}

/// Test plan: a `max_rot == 0` object keeps its `base_loc` orientation —
/// here a base turned -90 degrees — bit for bit (`GetObjFrame` copies it
/// and never calls `set_heading`). AceCompat ships the identity instead.
#[test]
fn retail_keeps_the_base_orientation_when_nothing_turns_it() {
    let (region, lb) = flat();
    let base = yaw(-std::f64::consts::FRAC_PI_2);
    let sc = scene(object(base, 0.0, 0));
    let rt = bake_retail(&region, &lb, &sc);
    assert_eq!(rt.len(), 64);
    for p in &rt {
        assert_eq!(
            [p.qw, p.qx, p.qy, p.qz].map(f32::to_bits),
            [base.w, base.x, base.y, base.z].map(f32::to_bits)
        );
        let f = forward(p);
        assert!((f.0 - 1.0).abs() < EPS && f.1.abs() < EPS, "base faces east: {f:?}");
    }
    for a in &bake_ace(&region, &lb, &sc) {
        assert_eq!([a.qw, a.qx, a.qy, a.qz], [1.0, 0.0, 0.0, 0.0]);
    }
}

/// Test plan: an `align` object on a plane rising toward +X faces +X (up
/// the slope: `get_heading(-N)` of an upward `N`), whatever its
/// `max_rotation` and base yaw; on flat ground `-N` has no horizontal part
/// and it faces north.
#[test]
fn align_rows_face_up_the_walkable_slope() {
    let base = yaw(-std::f64::consts::FRAC_PI_2);
    let (region, lb) = ramp(0.25);
    let rt = bake_retail(&region, &lb, &scene(object(base, 360.0, 1)));
    assert_eq!(rt.len(), 64);
    for p in &rt {
        let f = forward(p);
        assert!(
            (f.0 - 1.0).abs() < EPS && f.1.abs() < EPS && f.2.abs() < EPS,
            "({}, {}): forward {f:?} must point up-slope (+X)",
            p.source_cell_x,
            p.source_cell_y
        );
    }

    let (flat_region, flat_lb) = flat();
    let rt_flat = bake_retail(&flat_region, &flat_lb, &scene(object(base, 360.0, 1)));
    assert_eq!(rt_flat.len(), 64);
    for p in &rt_flat {
        let f = forward(p);
        assert!((f.1 - 1.0).abs() < EPS && f.0.abs() < EPS, "flat: forward {f:?} must be north");
    }
}

/// A base pitched 2 degrees about X (forward `z = sin 2°`, the size of the
/// census's pitched rows) keeps that tilt through `set_heading`: the
/// forward axis climbs `n.z = fwd_z / sqrt(1 + fwd_z^2)` and the pitch
/// rides on `qx`/`qy`. AceCompat stays yaw-only.
#[test]
fn a_pitched_base_ships_its_tilt_in_qx_qy() {
    let (region, lb) = flat();
    let half = 1.0f64.to_radians();
    let pitched = Quaternion {
        w: half.cos() as f32,
        x: half.sin() as f32,
        y: 0.0,
        z: 0.0,
    };
    let sc = scene(object(pitched, 90.0, 0));
    let fwd_z = 2.0 * pitched.w as f64 * pitched.x as f64;
    let climb = (fwd_z / (1.0 + fwd_z * fwd_z).sqrt()) as f32;
    let rt = bake_retail(&region, &lb, &sc);
    assert_eq!(rt.len(), 64);
    let mut with_qy = 0;
    for p in &rt {
        assert!(p.qx.abs() > 1e-3, "qx carries the pitch: {:?}", quat(p));
        if p.qy.abs() > 1e-3 {
            with_qy += 1;
        }
        let f = forward(p);
        assert!((f.2 - climb).abs() < EPS, "forward z {} != {climb}", f.2);
        let n = (quat(p).w.powi(2) + p.qx.powi(2) + p.qy.powi(2) + p.qz.powi(2)).sqrt();
        assert!((n - 1.0).abs() < EPS, "unit quaternion: |q| = {n}");
    }
    assert!(with_qy > 10, "turned frames move the pitch into qy too ({with_qy})");
    for a in &bake_ace(&region, &lb, &sc) {
        assert_eq!((a.qx, a.qy), (0.0, 0.0));
    }
}

/// The AABB closure and the within-block closure both receive the shipped
/// quaternion, bit for bit, and `PlacementXform::rotation_rad` is its yaw
/// (`-heading`), not ACE's mirrored `RotateObj` value.
#[test]
fn closures_see_the_shipped_retail_frame() {
    let (region, lb) = ramp(0.1);
    let half = 1.0f64.to_radians();
    let pitched = Quaternion {
        w: half.cos() as f32,
        x: half.sin() as f32,
        y: 0.0,
        z: 0.0,
    };
    let obj = object(pitched, 90.0, 0);
    let sc = scene(obj.clone());
    let mut boxes: Vec<PlacementXform> = Vec::new();
    let mut frames: Vec<WithinBlockQuery> = Vec::new();
    let rt = bake_landblock_retail(
        &region,
        &lb,
        LB_ID,
        |id| if id == SCENE_DID { Some(sc.clone()) } else { None },
        |px: PlacementXform| {
            boxes.push(px);
            box_around(px)
        },
        0,
        |q: WithinBlockQuery| {
            frames.push(q);
            true
        },
    );
    assert_eq!(rt.len(), 64);
    assert_eq!(boxes.len(), 64);
    assert_eq!(frames.len(), 64);
    for p in &rt {
        let px = boxes
            .iter()
            .find(|px| px.lx.to_bits() == p.x.to_bits() && px.ly.to_bits() == p.y.to_bits())
            .expect("an AABB call per placement");
        let q = frames
            .iter()
            .find(|q| q.x.to_bits() == p.x.to_bits() && q.y.to_bits() == p.y.to_bits())
            .expect("a within-block call per placement");
        let shipped = [p.qw, p.qx, p.qy, p.qz].map(f32::to_bits);
        assert_eq!([px.qw, px.qx, px.qy, px.qz].map(f32::to_bits), shipped);
        assert_eq!([q.qw, q.qx, q.qy, q.qz].map(f32::to_bits), shipped);
        assert_eq!(px.orientation(), quat(p));
        assert_eq!(px.rotation_rad.to_bits(), yaw_about_z(quat(p)).to_bits());
        let (gx, gy) = global_cell(p);
        let d = rotate_obj_retail(&obj, gx, gy, 0).to_radians();
        assert!((px.rotation_rad + d).abs() < EPS, "yaw {} != -{d}", px.rotation_rad);
    }
}

/// `rotate_obj_retail` — `GetObjFrame`'s heading, in degrees — pinned to
/// values hand-computed from the decomp expression with `max_rot = 360`
/// (an independent Python transcription that also reproduces the
/// `golden_decomp.rs` radian goldens bit for bit). The values were
/// re-checked on 2026-10-13 with retail's 2^-32 noise scale (the exe float
/// `0x2F800000`): these five round to the same f32 as with ACE's literal.
/// `golden_decomp.rs` section 8 pins vectors where the two scales differ.
///   0xA3AE c(0,0) j=0 → 25.042774  bits 0x41C8579A
///   0xA3AE c(0,0) j=5 → 99.070496  bits 0x42C62418
///   0xA6B1 c(3,4) j=2 → 11.096992  bits 0x41318D48
///   0xACB7 c(8,8) j=7 → 178.85797  bits 0x4332DBA4
///   0xAFBA c(1,2) j=3 → 291.47269  bits 0x4391BC81
#[test]
fn rotate_obj_retail_pinned_to_decomp_degrees() {
    let obj = object(Quaternion::identity(), 360.0, 0);
    let cases: &[(u16, u32, u32, u32, u32)] = &[
        (0xA3AE, 0, 0, 0, 0x41C8_579A),
        (0xA3AE, 0, 0, 5, 0x42C6_2418),
        (0xA6B1, 3, 4, 2, 0x4131_8D48),
        (0xACB7, 8, 8, 7, 0x4332_DBA4),
        (0xAFBA, 1, 2, 3, 0x4391_BC81),
    ];
    for &(lb, cx, cy, j, exp_bits) in cases {
        let ix = ((lb >> 8) & 0xFF) as u32 * 8 + cx;
        let iy = (lb & 0xFF) as u32 * 8 + cy;
        let d = rotate_obj_retail(&obj, ix, iy, j);
        assert_eq!(
            d.to_bits(),
            exp_bits,
            "rotate_obj_retail 0x{lb:04X} c({cx},{cy}) j={j}: got {d} (0x{:08X})",
            d.to_bits()
        );
        // Same noise as ACE's radians, without the DEG_TO_RAD factor.
        let r = rotate_obj(&obj, ix, iy, j);
        assert!((d.to_radians() - r).abs() < 1e-5, "{d} deg vs {r} rad");
    }
}
