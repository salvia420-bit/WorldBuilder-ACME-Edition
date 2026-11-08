// crates/holtburger-dat/tests/challenger_m1_authored_fallback_stress.rs
// Empirical stress test harness for authored override normal map fallback logic
// under unusual dimensions, uniform colors, and mismatch conditions.

fn authored_override_fallback(
    n: &[u8],
    tex_w: u32,
    tex_h: u32,
    existing_h: Vec<u8>,
) -> Vec<u8> {
    let mut h = existing_h;
    if h.is_empty() && n.len() == (tex_w as usize * tex_h as usize * 3) {
        let px_count = tex_w as usize * tex_h as usize;
        let z_plane: Vec<u8> = (0..px_count).map(|i| n[i * 3 + 2]).collect();
        let (min_z, max_z) = z_plane
            .iter()
            .fold((255u8, 0u8), |(mn, mx), &v| (mn.min(v), mx.max(v)));
        if max_z > min_z {
            h = z_plane;
        }
    }
    h
}

#[test]
fn test_authored_override_uniform_colors() {
    // 1. Uniform flat normal map [128, 128, 255] across 64x64
    let w = 64u32;
    let h = 64u32;
    let px_count = (w * h) as usize;
    let flat_normal = vec![128, 128, 255].repeat(px_count);

    let res = authored_override_fallback(&flat_normal, w, h, Vec::new());
    assert!(
        res.is_empty(),
        "Uniform flat normal map [128, 128, 255] must NOT fabricate height (must remain empty)"
    );

    // 2. Uniform tilted normal map [160, 160, 190]
    let tilted_uniform = vec![160, 160, 190].repeat(px_count);
    let res_tilted = authored_override_fallback(&tilted_uniform, w, h, Vec::new());
    assert!(
        res_tilted.is_empty(),
        "Uniform tilted normal map [160, 160, 190] must NOT fabricate height (must remain empty)"
    );

    // 3. Uniform zero normal map [0, 0, 0]
    let zero_uniform = vec![0, 0, 0].repeat(px_count);
    let res_zero = authored_override_fallback(&zero_uniform, w, h, Vec::new());
    assert!(
        res_zero.is_empty(),
        "Uniform zero normal map [0, 0, 0] must NOT fabricate height (must remain empty)"
    );
}

#[test]
fn test_authored_override_unusual_dimensions() {
    // 1. 1x1 normal map
    let single_px = vec![128, 128, 200];
    let res_1x1 = authored_override_fallback(&single_px, 1, 1, Vec::new());
    assert!(res_1x1.is_empty(), "1x1 texture has min_z == max_z, must remain empty");

    // 2. Rectangular non-square dimensions: 512x256
    let w_rect = 512u32;
    let h_rect = 256u32;
    let px_rect = (w_rect * h_rect) as usize;
    let mut normal_rect = vec![128, 128, 255].repeat(px_rect);
    // Add grooves
    for y in 0..h_rect {
        if y % 32 == 0 {
            for x in 0..w_rect {
                let idx = (y * w_rect + x) as usize * 3;
                normal_rect[idx + 0] = 160;
                normal_rect[idx + 1] = 160;
                normal_rect[idx + 2] = 190;
            }
        }
    }
    let res_rect = authored_override_fallback(&normal_rect, w_rect, h_rect, Vec::new());
    assert_eq!(res_rect.len(), px_rect, "Non-square 512x256 heightfield must match pixel count");
    assert_eq!(res_rect[0], 190, "Groove height must be 190");
    assert_eq!(res_rect[(16 * w_rect + 16) as usize], 255, "Plateau height must be 255");

    // 3. Odd / Prime dimensions: 17x29
    let w_odd = 17u32;
    let h_odd = 29u32;
    let px_odd = (w_odd * h_odd) as usize;
    let mut normal_odd = vec![128, 128, 255].repeat(px_odd);
    normal_odd[2] = 180; // single grooved texel
    let res_odd = authored_override_fallback(&normal_odd, w_odd, h_odd, Vec::new());
    assert_eq!(res_odd.len(), px_odd, "17x29 odd dimensions heightfield matches pixel count");
    assert_eq!(res_odd[0], 180);

    // 4. Dimension mismatch: buffer length does not match w * h * 3
    let res_mismatch = authored_override_fallback(&normal_rect, 64, 64, Vec::new());
    assert!(res_mismatch.is_empty(), "Dimension mismatch must safely return empty height without panic");

    // 5. Zero dimensions: 0x0, 0x10, 10x0
    let res_zero_dim = authored_override_fallback(&[], 0, 0, Vec::new());
    assert!(res_zero_dim.is_empty(), "0x0 dimension safely returns empty height");

    let res_zero_w = authored_override_fallback(&[], 0, 10, Vec::new());
    assert!(res_zero_w.is_empty(), "0x10 dimension safely returns empty height");
}

#[test]
fn test_authored_override_preserves_existing_diffuse_height() {
    // If diffuse already produced a valid heightfield (e.g. from relief_height_classed),
    // the fallback must NOT overwrite it with z_plane!
    let w = 4u32;
    let h = 4u32;
    let px_count = (w * h) as usize;
    let existing_h = vec![77u8; px_count];
    let normal_varying = vec![128, 128, 200, 128, 128, 255, 128, 128, 200, 128, 128, 255]
        .repeat(px_count / 4);

    let res = authored_override_fallback(&normal_varying, w, h, existing_h.clone());
    assert_eq!(res, existing_h, "Existing diffuse heightfield must be preserved and not overwritten");
}
