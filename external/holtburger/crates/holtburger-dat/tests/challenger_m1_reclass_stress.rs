// crates/holtburger-dat/tests/challenger_m1_reclass_stress.rs
// Empirical verification of texture reclassifications in data/tex-relief-classes.compact.json
// and heightfield carving under Stone and Brick relief classes.

use std::fs;
use std::path::Path;
use serde_json::Value;
use holtburger_dat::height_seam::{relief_height_classed, ReliefClass};

const RECLASSIFIED_STONES: &[u32] = &[
    0x060038F6, 0x060038FA, 0x0600393D, 0x06003951, 0x06003959,
    0x0600398F, 0x060039A3, 0x060039A7, 0x06003AE9, 0x06003AF1,
    0x06003AF7, 0x06003AF9, 0x06003B03, 0x06003B07, 0x06003B09,
    0x06003C9C, 0x06003CA0, 0x06003CA5, 0x06003D15, 0x06003D17,
    0x06003D72, 0x06003D76, 0x06003DBA, 0x06003E4A, 0x06003E7C,
    0x06003F53, 0x06003F55, 0x06004204, 0x060042F7, 0x06004459,
    0x06006302,
];

const RECLASSIFIED_BRICKS: &[u32] = &[
    0x06004231, 0x06004387, 0x06004543,
];

#[test]
fn test_tex_relief_classes_json_integrity_and_reclassifications() {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let json_path = Path::new(manifest_dir).join("../../data/tex-relief-classes.compact.json");
    assert!(json_path.exists(), "JSON file must exist at {:?}", json_path);

    let raw = fs::read_to_string(&json_path).expect("Read JSON string");
    // Verify compact single line invariant
    assert!(!raw.contains('\n') || raw.trim().lines().count() == 1, "File must be single line compact JSON");

    let doc: Value = serde_json::from_str(&raw).expect("JSON parse without error");
    assert_eq!(doc.get("version").and_then(|v| v.as_i64()), Some(1));
    assert!(doc.get("meta").is_some());

    let classes = doc.get("classes").and_then(|c| c.as_object()).expect("classes object");
    assert!(classes.len() >= 20680, "classes map must contain full catalog (found {})", classes.len());

    // Verify all 31 Stones
    for &did in RECLASSIFIED_STONES {
        let key = format!("0x{:08X}", did);
        let val = classes.get(&key).and_then(|v| v.as_str()).expect(&format!("Key {} present", key));
        assert_eq!(val, "S", "DID {} must be reclassified to 'S' (Stone)", key);
    }

    // Verify all 3 Bricks
    for &did in RECLASSIFIED_BRICKS {
        let key = format!("0x{:08X}", did);
        let val = classes.get(&key).and_then(|v| v.as_str()).expect(&format!("Key {} present", key));
        assert_eq!(val, "B", "DID {} must be reclassified to 'B' (Brick)", key);
    }

    // Verify that all keys are valid hex u32 and all values are valid ReliefClass codes
    for (k, v) in classes {
        let hex = k.strip_prefix("0x").expect("starts with 0x");
        let _did = u32::from_str_radix(hex, 16).expect("valid u32 hex");
        let code = v.as_str().expect("string value").bytes().next().expect("non-empty code");
        let parsed = ReliefClass::from_code(code);
        assert!(parsed.is_some(), "Code '{}' must parse as valid ReliefClass", code as char);
    }
}

#[test]
fn test_reclassified_heightfield_carving_oracles() {
    let w = 128u32;
    let h = 128u32;
    let px_count = (w * h) as usize;

    // Synthetic masonry mortar grid diffuse (dark joints at y%32==0, light stones elsewhere)
    let mut rgba = vec![200u8; px_count * 4];
    for y in 0..h {
        let is_joint = y % 32 == 0;
        for x in 0..w {
            let idx = ((y * w + x) * 4) as usize;
            if is_joint || (x % 32 == 0 && (y / 32) % 2 == 0) || (x % 32 == 16 && (y / 32) % 2 != 0) {
                rgba[idx] = 30;
                rgba[idx + 1] = 30;
                rgba[idx + 2] = 30;
            }
        }
    }

    // 1. Flush ('F') suppression check: Flush MUST suppress macro relief
    let hf_flush = relief_height_classed(&rgba, w, h, Some(ReliefClass::Flush), 0x060038F6);
    assert!(!ReliefClass::Flush.allows_macro());

    // 2. Stone ('S') carving check for all 31 reclassified DIDs
    assert!(ReliefClass::Stone.allows_macro());
    for &did in RECLASSIFIED_STONES {
        let hf_stone = relief_height_classed(&rgba, w, h, Some(ReliefClass::Stone), did);
        assert!(!hf_stone.is_empty(), "DID 0x{:08X}: Stone heightfield must not be empty", did);
        assert_eq!(hf_stone.len(), px_count, "DID 0x{:08X}: length must match w*h", did);

        // Verify finite, bounded in [0.0, 1.0]
        for &v in &hf_stone {
            assert!(v.is_finite(), "DID 0x{:08X}: height values must be finite", did);
            assert!(v >= 0.0 && v <= 1.0, "DID 0x{:08X}: height values must be in [0, 1]", did);
        }

        // Mortar joint at y=0, x=16 must be CARVED deeper (lower height) than pillowed block at y=16, x=16
        let joint_h = hf_stone[(0 * w + 16) as usize];
        let block_h = hf_stone[(16 * w + 16) as usize];
        assert!(
            joint_h < block_h,
            "DID 0x{:08X}: joint height ({}) must be lower than pillowed block ({})",
            did, joint_h, block_h
        );
        assert!(
            joint_h < 0.40,
            "DID 0x{:08X}: joint must carve deeply (found {})",
            did, joint_h
        );
        assert!(
            block_h > 0.70,
            "DID 0x{:08X}: block face must pillow proud (found {})",
            did, block_h
        );
    }

    // 3. Brick ('B') carving check for all 3 reclassified DIDs
    assert!(ReliefClass::Brick.allows_macro());
    for &did in RECLASSIFIED_BRICKS {
        let hf_brick = relief_height_classed(&rgba, w, h, Some(ReliefClass::Brick), did);
        assert!(!hf_brick.is_empty(), "DID 0x{:08X}: Brick heightfield must not be empty", did);
        assert_eq!(hf_brick.len(), px_count, "DID 0x{:08X}: length must match w*h", did);

        for &v in &hf_brick {
            assert!(v.is_finite() && v >= 0.0 && v <= 1.0);
        }

        let joint_h = hf_brick[(0 * w + 16) as usize];
        let brick_h = hf_brick[(16 * w + 16) as usize];
        assert!(
            joint_h < brick_h,
            "DID 0x{:08X}: joint height ({}) must be lower than brick face ({})",
            did, joint_h, brick_h
        );
        assert!(joint_h < 0.35, "DID 0x{:08X}: brick joint must carve (found {})", did, joint_h);
        assert!(brick_h > 0.75, "DID 0x{:08X}: brick face must be proud (found {})", did, brick_h);
    }
}
