// crates/holtburger-dat/tests/challenger_m1_modelgate_stress.rs
// Empirical stress test harness for ModelGate architecture discriminator under relaxed thresholds:
// min_bbox_extent_m = 2.0, min_median_edge_m = 0.35, min_area_m2 = 10.0, max_double_sided_frac = 0.25

use std::collections::HashMap;
use holtburger_dat::graphics::Polygon;
use holtburger_dat::gfx_remodel::{ModelGate, ModelTopology};

fn make_box(
    _name: &str,
    w: f32, // X extent
    d: f32, // Y extent
    h: f32, // Z extent
    double_sided: bool,
) -> (HashMap<u16, Polygon>, Vec<[f32; 3]>) {
    let hw = w * 0.5;
    let hd = d * 0.5;
    let verts = vec![
        [-hw, -hd, 0.0], // 0: bottom-left-front
        [ hw, -hd, 0.0], // 1: bottom-right-front
        [ hw,  hd, 0.0], // 2: bottom-right-back
        [-hw,  hd, 0.0], // 3: bottom-left-back
        [-hw, -hd,   h], // 4: top-left-front
        [ hw, -hd,   h], // 5: top-right-front
        [ hw,  hd,   h], // 6: top-right-back
        [-hw,  hd,   h], // 7: top-left-back
    ];

    let mut polys = HashMap::new();
    let sides_type = if double_sided { 1 } else { 0 };

    // Rings wound so Newell outward normals point outward
    let faces = [
        [0i16, 1, 5, 4], // Front
        [1, 2, 6, 5],    // Right
        [2, 3, 7, 6],    // Back
        [3, 0, 4, 7],    // Left
        [4, 5, 6, 7],    // Top
        [3, 2, 1, 0],    // Bottom
    ];

    for (i, f) in faces.iter().enumerate() {
        polys.insert(
            i as u16,
            Polygon {
                num_pts: f.len() as u8,
                stippling: 0,
                sides_type,
                pos_surface: 0,
                neg_surface: -1,
                pos_uv_indices: vec![0; f.len()],
                neg_uv_indices: vec![],
                vertex_ids: f.to_vec(),
            },
        );
    }

    (polys, verts)
}

#[test]
fn test_props_vs_architecture_empirical_gate() {
    let gate = ModelGate::default();
    assert_eq!(gate.min_bbox_extent_m, 2.0);
    assert_eq!(gate.min_median_edge_m, 0.35);
    assert_eq!(gate.min_area_m2, 10.0);
    assert_eq!(gate.max_double_sided_frac, 0.25);

    // -------------------------------------------------------------------------
    // 1. ACTUAL PROPS — MUST ALL BE REJECTED
    // -------------------------------------------------------------------------

    // A. Wooden Stool: 0.45m x 0.45m x 0.45m box
    let (stool_polys, stool_v) = make_box("stool", 0.45, 0.45, 0.45, false);
    let stool_topo = ModelTopology::build(
        &stool_polys,
        &[0x05001001],
        &[],
        &|i| stool_v.get(i as usize).copied(),
        &|_i, _k| Some([0.0, 0.0]),
    );
    assert!(
        !stool_topo.passes_gate(&gate),
        "PROP: Wooden stool must be rejected by gate"
    );

    // B. Street / Hanging Lantern: 0.25m x 0.25m x 0.40m
    let (lantern_polys, lantern_v) = make_box("lantern", 0.25, 0.25, 0.40, false);
    let lantern_topo = ModelTopology::build(
        &lantern_polys,
        &[0x05001002],
        &[],
        &|i| lantern_v.get(i as usize).copied(),
        &|_i, _k| Some([0.0, 0.0]),
    );
    assert!(
        !lantern_topo.passes_gate(&gate),
        "PROP: Lantern must be rejected by gate"
    );

    // C. Cup / Goblet: 0.10m x 0.10m x 0.14m
    let (cup_polys, cup_v) = make_box("cup", 0.10, 0.10, 0.14, false);
    let cup_topo = ModelTopology::build(
        &cup_polys,
        &[0x05001003],
        &[],
        &|i| cup_v.get(i as usize).copied(),
        &|_i, _k| Some([0.0, 0.0]),
    );
    assert!(
        !cup_topo.passes_gate(&gate),
        "PROP: Drinking cup must be rejected by gate"
    );

    // D. Tree / Foliage Cluster: large bounding box (4m x 4m x 8m) but double-sided leaves
    let (tree_polys, tree_v) = make_box("tree_cluster", 4.0, 4.0, 8.0, true);
    let tree_topo = ModelTopology::build(
        &tree_polys,
        &[0x05001004],
        &[],
        &|i| tree_v.get(i as usize).copied(),
        &|_i, _k| Some([0.0, 0.0]),
    );
    assert!(
        !tree_topo.passes_gate(&gate),
        "PROP: Tree / foliage cluster (double-sided) must be rejected by gate"
    );

    // E. Barrel: 0.8m x 0.8m x 1.1m (extent 1.1m < 2.0m, area ~3.8m² < 10m²)
    let (barrel_polys, barrel_v) = make_box("barrel", 0.8, 0.8, 1.1, false);
    let barrel_topo = ModelTopology::build(
        &barrel_polys,
        &[0x05001005],
        &[],
        &|i| barrel_v.get(i as usize).copied(),
        &|_i, _k| Some([0.0, 0.0]),
    );
    assert!(
        !barrel_topo.passes_gate(&gate),
        "PROP: Wooden barrel must be rejected by gate"
    );

    // F. Weapon / Sword: 0.12m x 0.05m x 1.20m
    let (sword_polys, sword_v) = make_box("sword", 0.12, 0.05, 1.20, false);
    let sword_topo = ModelTopology::build(
        &sword_polys,
        &[0x05001006],
        &[],
        &|i| sword_v.get(i as usize).copied(),
        &|_i, _k| Some([0.0, 0.0]),
    );
    assert!(
        !sword_topo.passes_gate(&gate),
        "PROP: Sword must be rejected by gate"
    );

    // G. Wooden Chest: 0.90m x 0.60m x 0.60m
    let (chest_polys, chest_v) = make_box("chest", 0.90, 0.60, 0.60, false);
    let chest_topo = ModelTopology::build(
        &chest_polys,
        &[0x05001007],
        &[],
        &|i| chest_v.get(i as usize).copied(),
        &|_i, _k| Some([0.0, 0.0]),
    );
    assert!(
        !chest_topo.passes_gate(&gate),
        "PROP: Chest must be rejected by gate"
    );

    // -------------------------------------------------------------------------
    // 2. ACTUAL ARCHITECTURAL ELEMENTS — MUST ALL PASS
    // -------------------------------------------------------------------------

    // A. Town Perimeter Wall segment: 2.5m wide x 0.6m deep x 2.2m high
    let (wall_polys, wall_v) = make_box("perimeter_wall", 2.5, 0.6, 2.2, false);
    let wall_topo = ModelTopology::build(
        &wall_polys,
        &[0x05002001],
        &[],
        &|i| wall_v.get(i as usize).copied(),
        &|_i, _k| Some([0.0, 0.0]),
    );
    assert!(
        wall_topo.passes_gate(&gate),
        "ARCHITECTURE: Town perimeter wall section must PASS gate"
    );

    // B. Low Stone Fence segment: 3.0m wide x 0.35m deep x 1.3m high
    let (fence_polys, fence_v) = make_box("stone_fence", 3.0, 0.35, 1.3, false);
    let fence_topo = ModelTopology::build(
        &fence_polys,
        &[0x05002002],
        &[],
        &|i| fence_v.get(i as usize).copied(),
        &|_i, _k| Some([0.0, 0.0]),
    );
    assert!(
        fence_topo.passes_gate(&gate),
        "ARCHITECTURE: Stone fence must PASS gate"
    );

    // C. Stone Steps / Stairs: 2.2m wide x 1.8m deep x 1.0m high
    let (stairs_polys, stairs_v) = make_box("stone_stairs", 2.2, 1.8, 1.0, false);
    let stairs_topo = ModelTopology::build(
        &stairs_polys,
        &[0x05002003],
        &[],
        &|i| stairs_v.get(i as usize).copied(),
        &|_i, _k| Some([0.0, 0.0]),
    );
    assert!(
        stairs_topo.passes_gate(&gate),
        "ARCHITECTURE: Stone stairs must PASS gate"
    );

    // -------------------------------------------------------------------------
    // 3. THRESHOLD BOUNDARY DRIFT & SENSITIVITY TESTING
    // -------------------------------------------------------------------------

    // Box with 1.99m extent (just under 2.0m)
    let (sub_bbox_polys, sub_bbox_v) = make_box("sub_bbox", 1.99, 1.99, 1.99, false);
    let sub_bbox_topo = ModelTopology::build(
        &sub_bbox_polys,
        &[0x05003001],
        &[],
        &|i| sub_bbox_v.get(i as usize).copied(),
        &|_i, _k| Some([0.0, 0.0]),
    );
    assert!(
        !sub_bbox_topo.passes_gate(&gate),
        "Boundary: 1.99m extent must be rejected"
    );

    // Box with 2.01m extent (just over 2.0m)
    let (over_bbox_polys, over_bbox_v) = make_box("over_bbox", 2.01, 2.01, 2.01, false);
    let over_bbox_topo = ModelTopology::build(
        &over_bbox_polys,
        &[0x05003002],
        &[],
        &|i| over_bbox_v.get(i as usize).copied(),
        &|_i, _k| Some([0.0, 0.0]),
    );
    assert!(
        over_bbox_topo.passes_gate(&gate),
        "Boundary: 2.01m extent with sufficient area must pass"
    );

    // Empty model / degenerate cases
    let empty_topo = ModelTopology::build(
        &HashMap::new(),
        &[],
        &[],
        &|_| None,
        &|_, _| None,
    );
    assert!(!empty_topo.passes_gate(&gate), "Empty model must be rejected");
}
