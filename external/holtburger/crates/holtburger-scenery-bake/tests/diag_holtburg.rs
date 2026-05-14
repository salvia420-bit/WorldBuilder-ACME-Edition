//! Public-API surface guard — pins the externally-reachable types and
//! constants so a downstream crate (the bake CLI in Phase B.3, the
//! renderer wasm bridge in Phase C) can rely on them.
//!
//! If anything here breaks at compile time, the breakage shows up as a
//! compiler error rather than a downstream consumer-side error later.
//!
//! (File started life as a Holtburg-LB diagnostic during B.2 development;
//! its now-finalised content is the API guard.)

use holtburger_common::Vector3;
use holtburger_scenery_bake::{
    Aabb2D, CELL_SIZE, LANDBLOCK_SIZE, LocalBounds, NOISE_SCALE, ScenicPlacement, VERTEX_DIM,
    cell_mat_scene, cell_mats_per_object, object_noise, transform_local_aabb,
};

#[test]
fn public_constants_have_expected_values() {
    assert_eq!(VERTEX_DIM, 9);
    assert_eq!(CELL_SIZE, 24.0);
    assert_eq!(LANDBLOCK_SIZE, 192.0);
    assert_eq!(NOISE_SCALE, 2.3283064e-10);
}

#[test]
fn public_types_construct_and_compare() {
    let p1 = ScenicPlacement {
        obj_id: 1,
        x: 1.0,
        y: 2.0,
        z: 3.0,
        qw: 1.0,
        qx: 0.0,
        qy: 0.0,
        qz: 0.0,
        scale: 1.0,
        source_cell_x: 0,
        source_cell_y: 0,
        source_obj_idx: 0,
    };
    let p2 = p1; // ScenicPlacement: Copy
    assert_eq!(p1, p2);

    let a = Aabb2D::new(0.0, 0.0, 1.0, 1.0);
    assert!(a.intersects(&a));

    let b = LocalBounds::new(Vector3::new(-1.0, -1.0, -1.0), Vector3::new(1.0, 1.0, 1.0));
    let world = transform_local_aabb(b, 5.0, 5.0, 0.0, 1.0);
    assert_eq!(world, Aabb2D::new(4.0, 4.0, 6.0, 6.0));
}

#[test]
fn public_noise_helpers_callable() {
    let cm = cell_mat_scene(42, 314);
    assert_eq!(cm, 0x7F0E_8239);
    let (a, b, c) = cell_mats_per_object(42, 314);
    let n = object_noise(a, b, c);
    assert!(n.is_finite() && (-1.0..1.0).contains(&n));
}
