//! Unit tests for dynamic building BSP colliders (M1: ISO shipping containers).
//!
//! Verifies:
//! - Registration and unregistration in SpatialScene (building_bsps, statics_physics_bsp,
//!   cell_static_physics_bsp, dynamic_building_bsps).
//! - Clean idempotency when re-upserting the same GUID.
//! - Walkability compliance (Normal.Z >= FLOOR_Z = 0.6641741):
//!   * Interior floor (z=0.162m, Normal.Z=1.0)
//!   * Exterior roof (z=2.591m or 2.896m, Normal.Z=1.0)
//!   * Fold-down ramp (~11° slope, Normal.Z ≈ 0.9816 >= FLOOR_Z)
//!   * Vertical walls (Normal.Z=0.0 < FLOOR_Z, blocking obstacle)

use super::scene::CellPhysicsBsp;
use super::SpatialScene;
use super::FLOOR_Z;
use holtburger_common::{Quaternion, Vector3};
use holtburger_dat::physics::{BspLeaf, BspNode, ResolvedPolygon};
use std::collections::HashMap;

fn make_poly(verts: Vec<Vector3>) -> ResolvedPolygon {
    let plane = ResolvedPolygon::make_plane(&verts).expect("non-degenerate polygon");
    ResolvedPolygon {
        num_points: verts.len(),
        vertices: verts,
        plane,
    }
}

fn make_leaf_bsp(polys: HashMap<u16, ResolvedPolygon>, origin: Vector3) -> CellPhysicsBsp {
    let mut ids: Vec<u16> = polys.keys().copied().collect();
    ids.sort_unstable();
    let tree = BspNode::Leaf(BspLeaf {
        index: 0,
        solid: 0,
        sphere: None,
        poly_ids: ids,
    });
    CellPhysicsBsp {
        tree,
        polys,
        origin,
        orientation: Quaternion::identity(),
        scale: 1.0,
    }
}

/// Helper to construct a canonical 20ft container collider:
/// - Interior floor at z = 0.162m
/// - Roof at z = 2.591m
/// - Fold-down ramp (~11° incline) when door_open is true
/// - Vertical walls (left, right, front)
fn make_container_bsp(origin: Vector3, door_open: bool) -> CellPhysicsBsp {
    let mut polys = HashMap::new();
    let hw = 1.176; // half internal width (2.352m / 2)
    let hl = 2.949; // half internal length (5.898m / 2)
    let floor_z = 0.162;
    let roof_z = 2.591;

    // 1. Interior floor (walkable, Normal.Z = 1.0)
    polys.insert(
        1u16,
        make_poly(vec![
            Vector3::new(-hw, -hl, floor_z),
            Vector3::new(hw, -hl, floor_z),
            Vector3::new(hw, hl, floor_z),
            Vector3::new(-hw, hl, floor_z),
        ]),
    );

    // 2. Exterior roof (walkable, Normal.Z = 1.0)
    let ext_hw = 1.219;
    let ext_hl = 3.029;
    polys.insert(
        2u16,
        make_poly(vec![
            Vector3::new(-ext_hw, -ext_hl, roof_z),
            Vector3::new(ext_hw, -ext_hl, roof_z),
            Vector3::new(ext_hw, ext_hl, roof_z),
            Vector3::new(-ext_hw, ext_hl, roof_z),
        ]),
    );

    // 3. Vertical side wall (-X, blocking, Normal = (+1, 0, 0))
    polys.insert(
        3u16,
        make_poly(vec![
            Vector3::new(-hw, -hl, floor_z),
            Vector3::new(-hw, hl, floor_z),
            Vector3::new(-hw, hl, roof_z),
            Vector3::new(-hw, -hl, roof_z),
        ]),
    );

    // 4. Vertical side wall (+X, blocking, Normal = (-1, 0, 0))
    polys.insert(
        4u16,
        make_poly(vec![
            Vector3::new(hw, hl, floor_z),
            Vector3::new(hw, -hl, floor_z),
            Vector3::new(hw, -hl, roof_z),
            Vector3::new(hw, hl, roof_z),
        ]),
    );

    // 5. Front end wall (+Y, blocking, Normal = (0, -1, 0))
    polys.insert(
        5u16,
        make_poly(vec![
            Vector3::new(-hw, hl, floor_z),
            Vector3::new(hw, hl, floor_z),
            Vector3::new(hw, hl, roof_z),
            Vector3::new(-hw, hl, roof_z),
        ]),
    );

    if door_open {
        // 6. Fold-down loading ramp at rear (-Y):
        // Spans from sill at y = -hl, z = floor_z (0.162m) down to ground at y = -hl - 0.85m, z = 0.0m.
        let ramp_len = 0.85;
        let y_sill = -hl;
        let y_ground = -hl - ramp_len;
        polys.insert(
            6u16,
            make_poly(vec![
                Vector3::new(-hw, y_ground, 0.0),
                Vector3::new(hw, y_ground, 0.0),
                Vector3::new(hw, y_sill, floor_z),
                Vector3::new(-hw, y_sill, floor_z),
            ]),
        );
    } else {
        // 6. Closed rear doors (blocking vertical wall, Normal = (0, 1, 0))
        polys.insert(
            6u16,
            make_poly(vec![
                Vector3::new(hw, -hl, floor_z),
                Vector3::new(-hw, -hl, floor_z),
                Vector3::new(-hw, -hl, roof_z),
                Vector3::new(hw, -hl, roof_z),
            ]),
        );
    }

    make_leaf_bsp(polys, origin)
}

#[test]
fn test_dynamic_building_bsp_upsert_and_remove() {
    let mut scene = SpatialScene::new();
    let guid = 0x1234_5678;
    let landblock_high = 0x0203_0000;
    let origin = Vector3::new(500.0, 680.0, 10.0);

    assert_eq!(scene.dynamic_building_bsp_count(), 0);

    let bsp = make_container_bsp(origin, true);
    scene.upsert_dynamic_building_bsp(guid, landblock_high, bsp);

    assert_eq!(scene.dynamic_building_bsp_count(), 1);

    // Verify presence in statics_physics_bsp
    let statics = scene.statics_physics_bsp(landblock_high);
    assert_eq!(statics.len(), 1, "registered in statics_physics_bsp");
    assert!(scene.is_building_bsp(&statics[0]), "registered in building_bsps");

    // Verify presence in cell_static_physics_bsp for the overlapping cell
    let home_cell = 0x0203_0025; // (500/24, 680/24) = (20, 28)
    let cell_statics = scene.cell_static_physics_bsp(home_cell);
    assert!(
        !cell_statics.is_empty(),
        "registered in overlapping cell_static_physics_bsp"
    );

    // Re-upserting same GUID should update without duplicate leak
    let bsp2 = make_container_bsp(origin, false);
    scene.upsert_dynamic_building_bsp(guid, landblock_high, bsp2);
    assert_eq!(scene.dynamic_building_bsp_count(), 1, "count remains 1 on update");
    assert_eq!(scene.statics_physics_bsp(landblock_high).len(), 1, "no duplicate leak in statics");

    // Remove the dynamic building BSP
    let removed = scene.remove_dynamic_building_bsp(guid);
    assert!(removed, "removal succeeded");
    assert_eq!(scene.dynamic_building_bsp_count(), 0);
    assert_eq!(scene.statics_physics_bsp(landblock_high).len(), 0);
    assert_eq!(scene.cell_static_physics_bsp(home_cell).len(), 0);

    // Second removal returns false
    assert!(!scene.remove_dynamic_building_bsp(guid));
}

#[test]
fn test_dynamic_building_bsp_walkability() {
    let origin = Vector3::new(500.0, 680.0, 10.0);
    let bsp = make_container_bsp(origin, true);

    // 1. Interior floor walkability
    let floor_poly = &bsp.polys[&1u16];
    assert!(
        floor_poly.plane.normal.z >= FLOOR_Z,
        "Interior floor normal.z ({}) must be >= FLOOR_Z ({})",
        floor_poly.plane.normal.z,
        FLOOR_Z
    );
    assert!(
        (floor_poly.plane.normal.z - 1.0).abs() < 1e-4,
        "Interior floor must have normal.z == 1.0"
    );

    // 2. Exterior roof walkability
    let roof_poly = &bsp.polys[&2u16];
    assert!(
        roof_poly.plane.normal.z >= FLOOR_Z,
        "Exterior roof normal.z ({}) must be >= FLOOR_Z ({})",
        roof_poly.plane.normal.z,
        FLOOR_Z
    );
    assert!(
        (roof_poly.plane.normal.z - 1.0).abs() < 1e-4,
        "Exterior roof must have normal.z == 1.0"
    );

    // 3. Fold-down ramp walkability (~11° slope)
    let ramp_poly = &bsp.polys[&6u16];
    assert!(
        ramp_poly.plane.normal.z >= FLOOR_Z,
        "Fold-down ramp normal.z ({}) must be >= FLOOR_Z ({})",
        ramp_poly.plane.normal.z,
        FLOOR_Z
    );
    // Slope calculation: run = 0.85m, rise = 0.162m
    // normal.z = 0.85 / sqrt(0.85^2 + 0.162^2) ≈ 0.9823
    assert!(
        (ramp_poly.plane.normal.z - 0.9823).abs() < 0.002,
        "Ramp normal.z must match expected ~0.9823, got {}",
        ramp_poly.plane.normal.z
    );

    // 4. Vertical side wall blocking (non-walkable barrier)
    let wall_poly = &bsp.polys[&3u16];
    assert!(
        wall_poly.plane.normal.z < FLOOR_Z,
        "Vertical wall normal.z ({}) must be < FLOOR_Z ({})",
        wall_poly.plane.normal.z,
        FLOOR_Z
    );
    assert!(
        wall_poly.plane.normal.z.abs() < 1e-4,
        "Vertical wall normal.z must be 0.0"
    );
}

#[test]
fn test_dynamic_building_bsp_collision_view_cloning() {
    let mut scene = SpatialScene::new();
    let guid = 0xAAAA_BBBB;
    let landblock_high = 0x0203_0000;
    let origin = Vector3::new(500.0, 680.0, 10.0);

    let bsp = make_container_bsp(origin, true);
    scene.upsert_dynamic_building_bsp(guid, landblock_high, bsp);

    // Clone into collision_view
    let view = scene.collision_view();
    assert_eq!(view.dynamic_building_bsp_count(), 1);
    assert_eq!(view.statics_physics_bsp(landblock_high).len(), 1);
}

#[test]
fn test_probe_dynamic_building_surface_floor_ramp_roof() {
    let mut scene = SpatialScene::new();
    let guid = 0x1111_2222;
    let landblock_high = 0x0203_0000;
    let origin = Vector3::new(500.0, 680.0, 10.0);

    // Outside / empty returns None
    assert!(scene.probe_dynamic_building_surface(origin.x, origin.y, origin.z + 1.0).is_none());

    scene.upsert_dynamic_building_bsp(guid, landblock_high, make_container_bsp(origin, true));

    // Outside XY returns None
    assert!(
        scene
            .probe_dynamic_building_surface(origin.x + 5.0, origin.y, origin.z + 1.0)
            .is_none()
    );

    // Inside XY with ceiling below roof returns interior floor
    let (floor_z, floor_n) = scene
        .probe_dynamic_building_surface(origin.x, origin.y, origin.z + 1.0)
        .expect("interior floor hit");
    assert!((floor_z - (origin.z + 0.162)).abs() < 1e-4);
    assert!((floor_n.z - 1.0).abs() < 1e-4);

    // Inside XY with ceiling above roof returns roof
    let (roof_z, roof_n) = scene
        .probe_dynamic_building_surface(origin.x, origin.y, origin.z + 3.5)
        .expect("roof hit");
    assert!((roof_z - (origin.z + 2.591)).abs() < 1e-4);
    assert!((roof_n.z - 1.0).abs() < 1e-4);

    // Ramp midpoint (y = -2.949 - 0.425 = -3.374 -> z = 0.081)
    let (ramp_z, ramp_n) = scene
        .probe_dynamic_building_surface(origin.x, origin.y - 2.949 - 0.425, origin.z + 1.0)
        .expect("ramp midpoint hit");
    assert!((ramp_z - (origin.z + 0.081)).abs() < 1e-3, "got ramp_z={ramp_z}");
    assert!((ramp_n.z - 0.9823).abs() < 0.002, "got ramp_n.z={}", ramp_n.z);

    // Non-finite inputs return None
    assert!(scene.probe_dynamic_building_surface(f32::NAN, origin.y, 12.0).is_none());

    assert!(scene.remove_dynamic_building_bsp(guid));
    assert!(scene.probe_dynamic_building_surface(origin.x, origin.y, origin.z + 1.0).is_none());
}

#[test]
fn test_resolve_dynamic_building_wall_pushout() {
    let mut scene = SpatialScene::new();
    let guid = 0x3333_4444;
    let landblock_high = 0x0203_0000;
    let origin = Vector3::new(500.0, 680.0, 10.0);

    // Open-door container
    scene.upsert_dynamic_building_bsp(guid, landblock_high, make_container_bsp(origin, true));

    // Penetrate -X wall from outside -> pushed outward (-X)
    let out_pen = Vector3::new(origin.x - 1.176 - 0.15, origin.y, origin.z + 0.5);
    let disp_out = scene
        .resolve_dynamic_building_wall_pushout(out_pen, 0.35)
        .expect("outside -X wall pushout");
    assert!(disp_out.x < -0.1, "expected -X pushout, got {:?}", disp_out);
    assert!(disp_out.z.abs() < 1e-4, "wall pushout must not alter Z: {:?}", disp_out);

    // Penetrate -X wall from inside -> pushed inward (+X)
    let in_pen = Vector3::new(origin.x - 1.176 + 0.15, origin.y, origin.z + 0.5);
    let disp_in = scene
        .resolve_dynamic_building_wall_pushout(in_pen, 0.35)
        .expect("inside -X wall pushout");
    assert!(disp_in.x > 0.1, "expected +X pushout, got {:?}", disp_in);

    // Open rear doorway (-Y) allows passage -> None
    let doorway = Vector3::new(origin.x, origin.y - 2.949, origin.z + 0.5);
    assert!(
        scene
            .resolve_dynamic_building_wall_pushout(doorway, 0.35)
            .is_none(),
        "open rear doorway must not block"
    );

    // Closed rear doors block passage at -Y
    scene.upsert_dynamic_building_bsp(guid, landblock_high, make_container_bsp(origin, false));
    let closed_door = Vector3::new(origin.x, origin.y - 2.949 + 0.15, origin.z + 0.5);
    let disp_door = scene
        .resolve_dynamic_building_wall_pushout(closed_door, 0.35)
        .expect("closed door pushout");
    assert!(disp_door.y > 0.1, "expected +Y pushout from closed door, got {:?}", disp_door);
}
