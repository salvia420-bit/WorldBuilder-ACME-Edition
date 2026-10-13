//! **Decomp-pinned golden-vector anchor for the scenery placement algorithm.**
//!
//! This is the *authoritative algorithm oracle* for AC's procedural
//! scenery PRNG + transform math. Every expected value in this file was
//! hand-computed from the **retail decompilation** (`acclient.c`
//! `CLandBlock::get_land_scenes` @ ~352530, `ObjectDesc::ScaleObj` @
//! ~351361, the displace/rotate/quadrant noise expressions) using the
//! exact magic constants listed below — NOT by running the Rust code and
//! capturing whatever it emitted, and NOT by diffing against the C#
//! `scenery-cross-check` port.
//!
//! Why this matters: today we validate the Rust bake against a C# port
//! of `ACE.Server.Entity.Scenery.Load`. Both ports descend from the same
//! retail algorithm, so a shared misreading of the decomp would pass that
//! check silently (circular dependence). The assertions here are pinned to
//! values computed *directly from the decomp constants* (reproduced in a
//! standalone Python transcription of `acclient.c`, cross-checked by
//! inlining the raw constants in-test — see [`lcg_recomputed_from_raw_decomp_constants`]).
//! Once this anchor is trusted, the C#-port-vs-Rust-port round-trip can
//! be retired in favour of "Rust port vs decomp golden".
//!
//! ## Decomp constants (verbatim from `acclient.c` / DECOMP brief)
//!
//! | name              | value          | role                                  |
//! |-------------------|----------------|---------------------------------------|
//! | NOISE_SCALE       | 2.3283064e-10  | u32 → \[0,1) normalizer (≈ 1/2^32)    |
//! | SCENE_SELECT_A    | 712977289      | scene-pick LCG inner mul              |
//! | SCENE_SELECT_B    | 1813693831     | scene-pick LCG inner add / y-mul      |
//! | SCENE_SELECT_C    | -1109124029    | scene-pick LCG x-mul                   |
//! | SCENE_SELECT_D    | 2139937281     | scene-pick LCG add                     |
//! | OBJECT_SELECT_C   | 1360117743     | per-object cellMat x*y mul            |
//! | OBJECT_SELECT_D   | 1888038839     | per-object cellMat add                 |
//! | OBJECT_SELECT_E   | 23399          | object-noise k                         |
//! | DISPLACE_X_MAGIC  | 45773          | displace-X k offset                    |
//! | DISPLACE_Y_MAGIC  | 72719          | displace-Y k offset                    |
//! | SCALE_MAGIC       | 32593          | scale k offset                         |
//! | ROTATION_MAGIC    | 63127          | rotation k offset                      |
//! | QUADRANT_B        | 1870387557     | quadrant iy mul                        |
//! | DEG_TO_RAD        | 0.017453303    | f32 π/180 (decomp literal)             |
//!
//! All u32 arithmetic **wraps** (C# `uint` / decomp `unsigned int`).
//!
//! ## Determinism contract
//!
//! Floating-point golden values are pinned **bit-exactly** via
//! `.to_bits()`. A `!= ` on the bits is a real regression, not a tolerance
//! drift — these functions must be reproducible to the last mantissa bit
//! across machines (the load-bearing property of the whole bake).

use holtburger_common::{Quaternion, Vector3};
use holtburger_dat::file_type::object_desc::ObjectDesc;
use holtburger_dat::graphics::Frame;
use holtburger_scenery_bake::{
    NOISE_SCALE, cell_mat_scene, cell_mats_per_object, displace, object_noise, rotate_obj,
    scale_obj,
};

// ----------------------------------------------------------------------
// Raw decomp constants — copied verbatim from the DECOMP brief so the
// recomputation in `lcg_recomputed_from_raw_decomp_constants` does not
// route through any production code path.
// ----------------------------------------------------------------------
const SCENE_SELECT_A: u32 = 712_977_289;
const SCENE_SELECT_B: u32 = 1_813_693_831;
const SCENE_SELECT_C_NEG: u32 = 1_109_124_029; // |SCENE_SELECT_C|; subtracted (== add of -C)
const SCENE_SELECT_D: u32 = 2_139_937_281;
const OBJECT_SELECT_C: u32 = 1_360_117_743;
const OBJECT_SELECT_D: u32 = 1_888_038_839;
const OBJECT_SELECT_E: u32 = 23_399;
const DISPLACE_X_MAGIC: u32 = 45_773;
const DISPLACE_Y_MAGIC: u32 = 72_719;
const QUADRANT_B: u32 = 1_870_387_557;
const QUADRANT_C: u32 = 1_109_124_029;
const QUADRANT_D_NEG: u32 = 402_451_965; // |QUADRANT_D| (-402451965); subtracted

// ----------------------------------------------------------------------
// Standalone decomp transcriptions. These reproduce the retail algorithm
// from the raw constants above, INDEPENDENT of `noise.rs`. They are what
// the production functions are pinned against — if a future "simplify"
// rewrites noise.rs and changes behaviour, these stay anchored to the
// decomp and the assertions catch the drift.
// ----------------------------------------------------------------------

/// `acclient.c` scene-pick LCG (mirrors Scenery.cs:43). Pure u32 wrap.
fn decomp_cell_mat_scene(gx: u32, gy: u32) -> u32 {
    let inner = SCENE_SELECT_A.wrapping_mul(gx).wrapping_add(SCENE_SELECT_B);
    gy.wrapping_mul(inner)
        .wrapping_sub(SCENE_SELECT_C_NEG.wrapping_mul(gx))
        .wrapping_add(SCENE_SELECT_D)
}

/// `acclient.c` per-object cellMat reset (mirrors Scenery.cs:52-54).
fn decomp_cell_mats(gx: u32, gy: u32) -> (u32, u32, u32) {
    let cell_x_mat = SCENE_SELECT_C_NEG.wrapping_mul(gx).wrapping_neg();
    let cell_y_mat = SCENE_SELECT_B.wrapping_mul(gy);
    let cell_mat = OBJECT_SELECT_C
        .wrapping_mul(gx)
        .wrapping_mul(gy)
        .wrapping_add(OBJECT_SELECT_D);
    (cell_x_mat, cell_y_mat, cell_mat)
}

/// Per-object noise sample WITHOUT the object index — ACE-dead-code
/// parity (mirrors `Scenery.cs:59`, which ACE never calls:
/// `Entity/Landblock.cs:197` `//LoadMeshes(objects);`). NOT the decomp:
/// retail adds the index, `c * (23399 + j)`, see section 7
/// (`decomp_object_gate_accumulator`). It draws the same u32 as retail only
/// at `j == 0`, and even there it scales by ACE's literal, not retail's
/// 2^-32 (section 7).
fn decomp_object_noise(a: u32, b: u32, c: u32) -> f64 {
    let n = a.wrapping_add(b).wrapping_sub(c.wrapping_mul(OBJECT_SELECT_E));
    n as f64 * NOISE_SCALE
}

/// `acclient.c` displace/scale/rotate shared noise core. `magic` selects
/// the channel (45773 X, 72719 Y, 32593 scale, 63127 rotation).
fn decomp_displace_noise(ix: u32, iy: u32, iq: u32, magic: u32) -> f64 {
    let inner = OBJECT_SELECT_C
        .wrapping_mul(iy)
        .wrapping_mul(ix)
        .wrapping_add(OBJECT_SELECT_D);
    let v = SCENE_SELECT_B
        .wrapping_mul(iy)
        .wrapping_sub(iq.wrapping_add(magic).wrapping_mul(inner))
        .wrapping_sub(SCENE_SELECT_C_NEG.wrapping_mul(ix));
    v as f64 * NOISE_SCALE
}

/// `acclient.c` quadrant tag (mirrors Scenery.cs:120).
fn decomp_quadrant(ix: u32, iy: u32) -> f64 {
    let inner = QUADRANT_B.wrapping_mul(iy).wrapping_add(QUADRANT_C);
    let v = SCENE_SELECT_B
        .wrapping_mul(iy)
        .wrapping_sub(ix.wrapping_mul(inner))
        .wrapping_sub(QUADRANT_D_NEG);
    v as f64 * NOISE_SCALE
}

/// Convert a content LB hex (e.g. `0xA3AE`, byte layout `lbX:lbY`) plus a
/// local cell `(cx, cy)` into the global cell coords the noise functions
/// consume. `block_x = lbX*8`, `block_y = lbY*8` per Scenery.cs:21-22.
fn global_cell(lb: u16, cx: u32, cy: u32) -> (u32, u32) {
    let lb_x = ((lb >> 8) & 0xFF) as u32;
    let lb_y = (lb & 0xFF) as u32;
    (cx.wrapping_add(lb_x * 8), cy.wrapping_add(lb_y * 8))
}

/// Build an `ObjectDesc` that exposes the noise core through the public
/// `displace`/`scale_obj`/`rotate_obj` API with no extra scaling:
/// `displace_x = displace_y = 1.0`, origin `(0,0,0)` so the displaced
/// coordinate IS the raw `displace_noise` value (modulo quadrant flip).
fn probe_obj(displace_amt: f32, min_scale: f32, max_scale: f32, max_rotation: f32) -> ObjectDesc {
    ObjectDesc {
        obj_id: 0x0100_0001,
        base_loc: Frame {
            origin: Vector3::new(0.0, 0.0, 0.0),
            orientation: Quaternion::default(),
        },
        freq: 1.0,
        displace_x: displace_amt,
        displace_y: displace_amt,
        min_scale,
        max_scale,
        max_rotation,
        min_slope: 0.0,
        max_slope: 1.0,
        align: 0,
        orient: 0,
        weenie_obj: 0,
    }
}

// ======================================================================
// 1. LCG (scene-pick) — pinned to hand-computed hex from the decomp.
// ======================================================================

/// The scene-pick LCG, pinned to literal hex constants that were
/// hand-computed from the decomp formula in Python. These are the
/// authoritative anchor: any change to `cell_mat_scene` that shifts even
/// one bit fails here.
///
/// Hand-computed (Python transcription of acclient.c):
///   cell_mat_scene(42, 314)   = 0x7F0E_8239  (2_131_657_273)
///   cell_mat_scene(1000,1000) = 0x813A_0B51  (2_168_064_849)
///   cell_mat_scene(0, 0)      = 0x7F8C_DA01  (2_139_937_281 == SCENE_SELECT_D)
///   cell_mat_scene(1, 1)      = 0xD40A_E754  (3_557_484_372)
#[test]
fn lcg_scene_select_pinned_to_decomp_hex() {
    assert_eq!(cell_mat_scene(42, 314), 0x7F0E_8239, "lb-relative (42,314)");
    assert_eq!(cell_mat_scene(1000, 1000), 0x813A_0B51, "(1000,1000)");
    // gx=gy=0 collapses the LCG to exactly the additive constant D.
    assert_eq!(cell_mat_scene(0, 0), 0x7F8C_DA01);
    assert_eq!(cell_mat_scene(0, 0), SCENE_SELECT_D, "origin == add const D");
    assert_eq!(cell_mat_scene(1, 1), 0xD40A_E754, "(1,1)");
}

/// Independent cross-check: recompute the LCG *inline from the raw decomp
/// constants* (no production-code call) and assert the production
/// `cell_mat_scene` agrees across a sweep. This is what makes the anchor
/// non-circular — `decomp_cell_mat_scene` shares no code with `noise.rs`.
#[test]
fn lcg_recomputed_from_raw_decomp_constants() {
    for &(gx, gy) in &[
        (42u32, 314u32),
        (1000, 1000),
        (0, 0),
        (1, 1),
        (1304, 1392), // 0xA3AE cell (0,0)
        (1384, 1472), // 0xACB7 cell (8,8)
        (u32::MAX, 7),
        (7, u32::MAX), // wrap stress
    ] {
        assert_eq!(
            cell_mat_scene(gx, gy),
            decomp_cell_mat_scene(gx, gy),
            "cell_mat_scene drift from raw decomp at ({gx},{gy})"
        );
    }
    // And the hand-pinned hex must equal the inline recomputation, proving
    // the Python transcription and the Rust transcription agree.
    assert_eq!(decomp_cell_mat_scene(42, 314), 0x7F0E_8239);
    assert_eq!(decomp_cell_mat_scene(1000, 1000), 0x813A_0B51);
}

// ======================================================================
// 2. Per-object cellMat reset + object_noise — bit-exact f64 pins.
// ======================================================================

/// `cell_mats_per_object` pinned to hand-computed u32 triples, and
/// `object_noise` pinned to bit-exact f64. Hand-computed from decomp:
///   (42,314)     → (0x276CA2FE,0x98D64796,0xC6ECC3F3), noise=0.5521346725954254
///   (1000,1000)  → (0xC30E65B8,0x48939758,0x8775C977), noise=0.674326002958482
///   (0,0)        → (0x00000000,0x00000000,0x70892FB7), noise=0.9564170908498522
///   (1,1)        → (0xBDE41C43,0x6C1AC587,0xC19AEFA6), noise=0.193244215793664
#[test]
fn per_object_cellmat_and_noise_pinned() {
    let cases: &[(u32, u32, (u32, u32, u32), u64)] = &[
        // (gx, gy, expected (cell_x_mat, cell_y_mat, cell_mat), object_noise.to_bits())
        (42, 314, (0x276C_A2FE, 0x98D6_4796, 0xC6EC_C3F3), 0x3FE1_AB16_5539_1EE1),
        (1000, 1000, (0xC30E_65B8, 0x4893_9758, 0x8775_C977), 0x3FE5_9414_2031_920F),
        (0, 0, (0x0000_0000, 0x0000_0000, 0x7089_2FB7), 0x3FEE_9AF8_03D1_2370),
        (1, 1, (0xBDE4_1C43, 0x6C1A_C587, 0xC19A_EFA6), 0x3FC8_BC39_F97C_CB47),
    ];
    for &(gx, gy, exp_triple, exp_noise_bits) in cases {
        let triple = cell_mats_per_object(gx, gy);
        assert_eq!(
            triple, exp_triple,
            "cell_mats_per_object({gx},{gy}) drift"
        );
        let (a, b, c) = triple;
        let n = object_noise(a, b, c);
        assert_eq!(
            n.to_bits(),
            exp_noise_bits,
            "object_noise({gx},{gy}) = {n} (bits 0x{:016X}) != decomp golden 0x{exp_noise_bits:016X}",
            n.to_bits()
        );
        // Cross-check: inline decomp recomputation must agree bit-exactly.
        assert_eq!(triple, decomp_cell_mats(gx, gy));
        assert_eq!(n.to_bits(), decomp_object_noise(a, b, c).to_bits());
    }
}

// ======================================================================
// 3. Displace formula — pinned through the public `displace()` API.
// ======================================================================

/// With `origin=(0,0)` and `displace_x = displace_y = 1.0`, the public
/// `displace()` returns the raw `displace_noise` (cast to f32) for each
/// axis, then applies the quadrant flip. Pinned to hand-computed f32 bit
/// patterns derived directly from the decomp displace + quadrant
/// expressions.
///
/// Golden vectors span the ring (DECOMP golden LBs) AND exercise two
/// quadrant branches: the first four cases have `quadrant < 0.25` (no
/// flip → output = (noise_x, noise_y)); the last (`0xAFBA`,
/// `quadrant ≈ 0.7848 ≥ 0.75`) takes the `(y, -x)` branch.
///
/// Hand-computed (decomp; floats are post-f32-narrowing):
///   0xA3AE c(0,0) j=0 → ( 0.760063648, 0.355072081)  bits (0x3F429388,0x3EB5CC02)
///   0xA3AE c(0,0) j=5 → ( 0.965696216, 0.560704648)  bits (0x3F7737DE,0x3F0F8A57)
///   0xA6B1 c(3,4) j=2 → ( 0.718806624, 0.958846152)  bits (0x3F3803B6,0x3F7576F1)
///   0xACB7 c(8,8) j=7 → ( 0.390831530, 0.717797816)  bits (0x3EC81B12,0x3F37C199)
///   0xAFBA c(1,2) j=3 → ( 0.755929112,-0.943529546)  bits (0x3F418492,0xBF718B27)  [flip]
#[test]
fn displace_formula_pinned_to_decomp() {
    let obj = probe_obj(1.0, 1.0, 1.0, 0.0);
    let cases: &[(u16, u32, u32, u32, u32, u32)] = &[
        // (lb, cx, cy, j, expected x.to_bits(), expected y.to_bits())
        (0xA3AE, 0, 0, 0, 0x3F42_9388, 0x3EB5_CC02),
        (0xA3AE, 0, 0, 5, 0x3F77_37DE, 0x3F0F_8A57),
        (0xA6B1, 3, 4, 2, 0x3F38_03B6, 0x3F75_76F1),
        (0xACB7, 8, 8, 7, 0x3EC8_1B12, 0x3F37_C199),
        (0xAFBA, 1, 2, 3, 0x3F41_8492, 0xBF71_8B27), // quadrant (y,-x) branch
    ];
    for &(lb, cx, cy, j, exp_x_bits, exp_y_bits) in cases {
        let (ix, iy) = global_cell(lb, cx, cy);
        let (x, y) = displace(&obj, ix, iy, j);
        assert_eq!(
            x.to_bits(),
            exp_x_bits,
            "displace.x 0x{lb:04X} c({cx},{cy}) j={j}: got {x} (0x{:08X}) != golden 0x{exp_x_bits:08X}",
            x.to_bits()
        );
        assert_eq!(
            y.to_bits(),
            exp_y_bits,
            "displace.y 0x{lb:04X} c({cx},{cy}) j={j}: got {y} (0x{:08X}) != golden 0x{exp_y_bits:08X}",
            y.to_bits()
        );
    }
}

/// Independent cross-check of the displace core: recompute the raw X/Y
/// noise + quadrant *inline from the decomp constants* and assert the
/// public `displace()` reproduces them (with the f32 narrowing and
/// quadrant flip applied identically). Non-circular: shares no code with
/// `noise.rs`.
#[test]
fn displace_core_recomputed_from_raw_decomp() {
    let obj = probe_obj(1.0, 1.0, 1.0, 0.0);
    for &(lb, cx, cy, j) in &[
        (0xA3AEu16, 0u32, 0u32, 0u32),
        (0xA3AE, 0, 0, 5),
        (0xA6B1, 3, 4, 2),
        (0xACB7, 8, 8, 7),
        (0xAFBA, 1, 2, 3),
    ] {
        let (ix, iy) = global_cell(lb, cx, cy);
        // Inline decomp recomputation of what displace() should return.
        let nx = decomp_displace_noise(ix, iy, j, DISPLACE_X_MAGIC) as f32;
        let ny = decomp_displace_noise(ix, iy, j, DISPLACE_Y_MAGIC) as f32;
        let q = decomp_quadrant(ix, iy);
        let expected = if q >= 0.75 {
            (ny, (-nx))
        } else if q >= 0.5 {
            (-nx, -ny)
        } else if q >= 0.25 {
            (-ny, nx)
        } else {
            (nx, ny)
        };
        let got = displace(&obj, ix, iy, j);
        assert_eq!(
            got.0.to_bits(),
            expected.0.to_bits(),
            "displace.x decomp drift 0x{lb:04X} c({cx},{cy}) j={j} (q={q})"
        );
        assert_eq!(
            got.1.to_bits(),
            expected.1.to_bits(),
            "displace.y decomp drift 0x{lb:04X} c({cx},{cy}) j={j} (q={q})"
        );
    }
}

// ======================================================================
// 4. Scale formula — pinned to hand-computed f32 bits.
// ======================================================================

/// `scale_obj` over the golden vectors with `min_scale=0.8, max_scale=1.5`.
/// The decomp computes `pow((max/min)_f32, noise) * min`, narrowed to f32.
/// Pinned bit-exactly. Hand-computed (decomp):
///   0xA3AE c(0,0) j=0 → 1.252097726  bits 0x3FA044BD
///   0xA3AE c(0,0) j=5 → 1.424873114  bits 0x3FB6623E
///   0xA6B1 c(3,4) j=2 → 1.235465646  bits 0x3F9E23BD
///   0xACB7 c(8,8) j=7 → 1.166307449  bits 0x3F954990
///   0xAFBA c(1,2) j=3 → 1.275519848  bits 0x3FA3443C
#[test]
fn scale_formula_pinned_to_decomp() {
    let obj = probe_obj(0.0, 0.8, 1.5, 0.0);
    let cases: &[(u16, u32, u32, u32, u32)] = &[
        (0xA3AE, 0, 0, 0, 0x3FA0_44BD),
        (0xA3AE, 0, 0, 5, 0x3FB6_623E),
        (0xA6B1, 3, 4, 2, 0x3F9E_23BD),
        (0xACB7, 8, 8, 7, 0x3F95_4990),
        (0xAFBA, 1, 2, 3, 0x3FA3_443C),
    ];
    for &(lb, cx, cy, j, exp_bits) in cases {
        let (ix, iy) = global_cell(lb, cx, cy);
        let s = scale_obj(&obj, ix, iy, j);
        assert_eq!(
            s.to_bits(),
            exp_bits,
            "scale_obj 0x{lb:04X} c({cx},{cy}) j={j}: got {s} (0x{:08X}) != golden 0x{exp_bits:08X}",
            s.to_bits()
        );
        // Scale must land inside [min, max] for these noise samples.
        assert!((0.8..=1.5).contains(&s), "scale {s} outside [0.8,1.5]");
    }
}

// ======================================================================
// 5. Rotation formula — pinned to hand-computed f32 bits.
// ======================================================================

/// `rotate_obj` over the golden vectors with `max_rotation=360.0` deg.
/// The decomp computes `noise * max_rotation * DEG_TO_RAD(0.017453303_f32)`
/// → radians, narrowed to f32. Pinned bit-exactly. Hand-computed (decomp):
///   0xA3AE c(0,0) j=0 → 0.437079042  bits 0x3EDFC8D3
///   0xA3AE c(0,0) j=5 → 1.729107022  bits 0x3FDD5361
///   0xA6B1 c(3,4) j=2 → 0.193679124  bits 0x3E4653D2
///   0xACB7 c(8,8) j=7 → 3.121661663  bits 0x4047C94E
///   0xAFBA c(1,2) j=3 → 5.087160110  bits 0x40A2CA04
#[test]
fn rotation_formula_pinned_to_decomp() {
    let obj = probe_obj(0.0, 1.0, 1.0, 360.0);
    let cases: &[(u16, u32, u32, u32, u32)] = &[
        (0xA3AE, 0, 0, 0, 0x3EDF_C8D3),
        (0xA3AE, 0, 0, 5, 0x3FDD_5361),
        (0xA6B1, 3, 4, 2, 0x3E46_53D2),
        (0xACB7, 8, 8, 7, 0x4047_C94E),
        (0xAFBA, 1, 2, 3, 0x40A2_CA04),
    ];
    for &(lb, cx, cy, j, exp_bits) in cases {
        let (ix, iy) = global_cell(lb, cx, cy);
        let r = rotate_obj(&obj, ix, iy, j);
        assert_eq!(
            r.to_bits(),
            exp_bits,
            "rotate_obj 0x{lb:04X} c({cx},{cy}) j={j}: got {r} (0x{:08X}) != golden 0x{exp_bits:08X}",
            r.to_bits()
        );
        // Radians must be in [0, 2π) for max_rotation=360.
        assert!(
            (0.0..std::f32::consts::TAU).contains(&r),
            "rotation {r} outside [0,2π)"
        );
    }
}

// ======================================================================
// 6. Constant anchors — the byte-exact literals the whole algorithm rides.
// ======================================================================

/// `NOISE_SCALE` is the `2.3283064e-10` *literal* from the decomp, which
/// is NOT byte-equal to `1.0 / 4294967296.0`. Pin its exact f64 bits so a
/// well-meaning "simplify to 1/2^32" refactor fails loudly. Hand-derived:
/// `(2.3283064e-10_f64).to_bits() == 0x3DEFFFFFF79322D5`.
#[test]
fn noise_scale_is_the_decomp_literal_not_one_over_two_pow_32() {
    assert_eq!(
        NOISE_SCALE.to_bits(),
        0x3DEF_FFFF_F793_22D5,
        "NOISE_SCALE must be the decomp literal 2.3283064e-10, got {NOISE_SCALE} \
         (bits 0x{:016X})",
        NOISE_SCALE.to_bits()
    );
    // It is deliberately NOT 1/2^32 — prove the bits differ.
    let one_over_2_32 = 1.0_f64 / 4_294_967_296.0_f64;
    assert_ne!(
        NOISE_SCALE.to_bits(),
        one_over_2_32.to_bits(),
        "decomp literal must differ from 1/2^32 in the low bits"
    );
}

// ======================================================================
// 7. Retail frequency gate — object index in the multiplier
//    (`BakeMode::Retail`, terrain-scenery-1).
//
//    The retail noise scale is NOT section 6's `NOISE_SCALE`. Hex-Rays
//    prints `2.3283064e-10`, but that is the shortest decimal for the
//    FLOAT the exe multiplies by. The float is at `acclient.exe`
//    `0x7c6f10`, its bytes are `00 00 80 2F` (`0x2F800000`), and its value
//    is exactly 2^-32. One use is the gate's `fmul dword [0x7c6f10]` at
//    `0x531455`, followed by `fcomp [esi+0x44]`. Section 6 pins ACE's C#
//    double literal, and only `AceCompat` uses that. The `BakeMode::Retail`
//    goldens below are computed with 2^-32 (reviewer K-R1, 2026-10-13).
// ======================================================================

use holtburger_scenery_bake::{
    NOISE_SCALE_RETAIL, displace_retail, object_noise_retail, rotate_obj_retail, scale_obj_retail,
    scene_index_retail,
};

/// Retail's noise scale, from the exe's float bits (`0x2F800000` at
/// `0x7c6f10`). Independent of `noise.rs`.
const RETAIL_SCALE_F32_BITS: u32 = 0x2F80_0000;

fn retail_scale() -> f64 {
    f32::from_bits(RETAIL_SCALE_F32_BITS) as f64
}

/// `acclient.c` `CLandBlock::get_land_scenes` frequency gate, transcribed
/// in the decomp's own ACCUMULATOR form (:352659-352731), not the closed
/// form, for objects `0..n`:
///
/// ```text
/// v44 = 1813693831 * y;            v16 = -1109124029 * x;
/// v38 = 1360117743 * x * y + 1888038839;
/// v17 = 23399 * v38;               scene_id = 23399 * v38;
/// loop kq:  obj_id.id = v16 + v44 - v17;          // the gate (:352668)
///           ... (double)obj_id.id * 2.3283064e-10 < freq ...  // float 0x2F800000
///           v17 = v38 + scene_id;  scene_id += v38; // loop tail (:352729-31)
/// ```
///
/// The tail runs for every object, gated or not, so object `j` sees
/// `v38 * (23399 + j)`. Shares no code with `noise.rs`.
fn decomp_object_gate_accumulator(gx: u32, gy: u32, n: u32) -> Vec<u32> {
    let v44 = SCENE_SELECT_B.wrapping_mul(gy);
    let v16 = SCENE_SELECT_C_NEG.wrapping_mul(gx).wrapping_neg();
    let v38 = OBJECT_SELECT_C
        .wrapping_mul(gx)
        .wrapping_mul(gy)
        .wrapping_add(OBJECT_SELECT_D);
    let mut v17 = OBJECT_SELECT_E.wrapping_mul(v38);
    let mut scene_id = OBJECT_SELECT_E.wrapping_mul(v38);
    let mut out = Vec::with_capacity(n as usize);
    for _kq in 0..n {
        out.push(v16.wrapping_add(v44).wrapping_sub(v17));
        v17 = v38.wrapping_add(scene_id);
        scene_id = scene_id.wrapping_add(v38);
    }
    out
}

/// Decomp noise for object `j`: `(double)gate * 2^-32` (retail's float
/// `0x2F800000`).
fn decomp_object_noise_j(gx: u32, gy: u32, j: u32) -> f64 {
    decomp_object_gate_accumulator(gx, gy, j + 1)[j as usize] as f64 * retail_scale()
}

/// Retail gate pinned to hand-computed values for `j = 0..3` at two
/// cells. These were computed in Python from the accumulator form above
/// (u32 wrap, then `float(n) * 2**-32`), independently of the Rust code.
/// The 2^-32 product is exact, so each f64 is just the u32 with its
/// exponent shifted:
///
/// ```text
/// (42,314)    j=0 0x8D58B2CF 0.5521346812602133  0x3FE1AB1659E00000
///             j=1 0xC66BEEDC 0.7750844275578856  0x3FE8CD7DDB800000
///             j=2 0xFF7F2AE9 0.998034173855558   0x3FEFEFE55D200000
///             j=3 0x389266F6 0.22098392015323043 0x3FCC49337B000000
/// (1000,1000) j=0 0xACA0A12F 0.6743260135408491  0x3FE5941425E00000
///             j=1 0x252AD7B8 0.14518497698009014 0x3FC2956BDC000000
///             j=2 0x9DB50E41 0.6160439404193312  0x3FE3B6A1C8200000
///             j=3 0x163F44CA 0.08690290385857224 0x3FB63F44CA000000
/// ```
///
/// At `j = 0` the u32 equals the section 2 draw, because the index term is
/// zero there. The f64 does not equal it, because section 2 pins ACE's
/// literal.
#[test]
fn retail_object_gate_pinned_to_decomp_hex() {
    let cases: &[(u32, u32, [(u32, u64); 4])] = &[
        (
            42,
            314,
            [
                (0x8D58_B2CF, 0x3FE1_AB16_59E0_0000),
                (0xC66B_EEDC, 0x3FE8_CD7D_DB80_0000),
                (0xFF7F_2AE9, 0x3FEF_EFE5_5D20_0000),
                (0x3892_66F6, 0x3FCC_4933_7B00_0000),
            ],
        ),
        (
            1000,
            1000,
            [
                (0xACA0_A12F, 0x3FE5_9414_25E0_0000),
                (0x252A_D7B8, 0x3FC2_956B_DC00_0000),
                (0x9DB5_0E41, 0x3FE3_B6A1_C820_0000),
                (0x163F_44CA, 0x3FB6_3F44_CA00_0000),
            ],
        ),
    ];
    for &(gx, gy, per_j) in cases {
        let gates = decomp_object_gate_accumulator(gx, gy, 4);
        let (a, b, c) = cell_mats_per_object(gx, gy);
        for (j, &(exp_gate, exp_bits)) in per_j.iter().enumerate() {
            let j = j as u32;
            assert_eq!(
                gates[j as usize], exp_gate,
                "decomp accumulator gate ({gx},{gy}) j={j}"
            );
            assert_eq!(
                decomp_object_noise_j(gx, gy, j).to_bits(),
                exp_bits,
                "decomp noise ({gx},{gy}) j={j}"
            );
            let n = object_noise_retail(a, b, c, j);
            assert_eq!(
                n.to_bits(),
                exp_bits,
                "object_noise_retail({gx},{gy}) j={j} = {n} (bits 0x{:016X}) != decomp golden 0x{exp_bits:016X}",
                n.to_bits()
            );
            // 2^-32 is exact: the f64 is the u32 with its exponent shifted.
            assert_eq!(n * 4_294_967_296.0, exp_gate as f64);
        }
    }
}

/// The decomp's running accumulator equals the closed form
/// `cellXMat + cellYMat - cellMat * (23399 + j)` for `j` in `0..8`, and
/// the production `object_noise_retail` matches the decomp transcription
/// bit-for-bit across a sweep that includes u32 wrap stress.
#[test]
fn retail_accumulator_equals_closed_form_and_production() {
    for &(gx, gy) in &[
        (42u32, 314u32),
        (1000, 1000),
        (0, 0),
        (1, 1),
        (1304, 1392), // 0xA3AE cell (0,0)
        (1355, 1444), // 0xA9B4 cell (3,4)
        (1384, 1472), // 0xACB7 cell (8,8)
        (u32::MAX, 7),
        (7, u32::MAX),
    ] {
        let gates = decomp_object_gate_accumulator(gx, gy, 8);
        let (a, b, c) = decomp_cell_mats(gx, gy);
        assert_eq!((a, b, c), cell_mats_per_object(gx, gy));
        for j in 0..8u32 {
            let closed = a
                .wrapping_add(b)
                .wrapping_sub(c.wrapping_mul(OBJECT_SELECT_E.wrapping_add(j)));
            assert_eq!(
                gates[j as usize], closed,
                "accumulator != closed form at ({gx},{gy}) j={j}"
            );
            assert_eq!(
                object_noise_retail(a, b, c, j).to_bits(),
                decomp_object_noise_j(gx, gy, j).to_bits(),
                "object_noise_retail drift from decomp at ({gx},{gy}) j={j}"
            );
        }
    }
}

/// At `j = 0` the retail gate draws the same u32 as the legacy
/// (ACE-dead-code) gate, scaled by 2^-32 instead of ACE's literal. From
/// `j = 1` on, the draws themselves differ.
///
/// Worked example at (42,314) with `freq = 0.5`. The legacy shared draw
/// (0.552) rejects every object in the Scene. Retail accepts object 3
/// (0.221), which is a non-nested subset the legacy gate can never produce.
#[test]
fn retail_j0_is_the_legacy_gate_and_later_objects_differ() {
    for &(gx, gy) in &[(42u32, 314u32), (1000, 1000), (0, 0), (1, 1)] {
        let (a, b, c) = cell_mats_per_object(gx, gy);
        let legacy = object_noise(a, b, c);
        let legacy_u32 = a.wrapping_add(b).wrapping_sub(c.wrapping_mul(OBJECT_SELECT_E));
        assert_eq!(decomp_object_noise(a, b, c).to_bits(), legacy.to_bits());
        assert_eq!(decomp_object_gate_accumulator(gx, gy, 1)[0], legacy_u32);
        assert_eq!(
            object_noise_retail(a, b, c, 0).to_bits(),
            (legacy_u32 as f64 * retail_scale()).to_bits()
        );
        assert_eq!(
            decomp_object_noise_j(gx, gy, 0).to_bits(),
            object_noise_retail(a, b, c, 0).to_bits()
        );
        // Same draw, different scale: retail's f64 is never below ACE's.
        assert!(object_noise_retail(a, b, c, 0) >= legacy);
        assert_ne!(
            decomp_object_gate_accumulator(gx, gy, 2)[1],
            legacy_u32,
            "j=1 must not reuse the j=0 draw at ({gx},{gy})"
        );
    }
    let (a, b, c) = cell_mats_per_object(42, 314);
    let freq = 0.5_f32 as f64;
    assert!(!(object_noise(a, b, c) < freq), "legacy rejects every object here");
    assert!(!(object_noise_retail(a, b, c, 0) < freq), "retail rejects object 0 too");
    assert!(object_noise_retail(a, b, c, 3) < freq, "retail accepts object 3 here");
}

// ======================================================================
// 8. Retail noise scale — 2^-32 in every Retail noise draw
//    (`BakeMode::Retail`, reviewer K-R1).
// ======================================================================

/// `NOISE_SCALE_RETAIL` is the exe's float `0x2F800000`, exactly 2^-32. It
/// is not section 6's ACE literal, which is about 1.6e-8 relative smaller.
#[test]
fn noise_scale_retail_is_the_exe_float_0x2f800000() {
    assert_eq!(NOISE_SCALE_RETAIL.to_bits(), 0x3DF0_0000_0000_0000);
    assert_eq!(NOISE_SCALE_RETAIL, retail_scale());
    assert_eq!(NOISE_SCALE_RETAIL, 1.0 / 4_294_967_296.0);
    assert_ne!(NOISE_SCALE_RETAIL.to_bits(), NOISE_SCALE.to_bits());
    assert!(NOISE_SCALE < NOISE_SCALE_RETAIL);
}

/// Raw u32 of the decomp's displace/scale/rotate noise core. Shares no
/// code with `noise.rs`.
fn decomp_core_u32(ix: u32, iy: u32, iq: u32, magic: u32) -> u32 {
    let inner = OBJECT_SELECT_C
        .wrapping_mul(iy)
        .wrapping_mul(ix)
        .wrapping_add(OBJECT_SELECT_D);
    SCENE_SELECT_B
        .wrapping_mul(iy)
        .wrapping_sub(iq.wrapping_add(magic).wrapping_mul(inner))
        .wrapping_sub(SCENE_SELECT_C_NEG.wrapping_mul(ix))
}

/// Raw u32 of the decomp's quadrant tag (`ObjectDesc::Place` :462630).
fn decomp_quadrant_u32(ix: u32, iy: u32) -> u32 {
    let inner = QUADRANT_B.wrapping_mul(iy).wrapping_add(QUADRANT_C);
    SCENE_SELECT_B
        .wrapping_mul(iy)
        .wrapping_sub(ix.wrapping_mul(inner))
        .wrapping_sub(QUADRANT_D_NEG)
}

const SCALE_MAGIC: u32 = 32_593;
const ROTATION_MAGIC: u32 = 63_127;

/// `ObjectDesc::Place` (:462605) with retail's scale, for an object at
/// origin `(0, 0)` with displacement amplitude `amt`.
fn decomp_place_retail(ix: u32, iy: u32, iq: u32, amt: f32) -> (f32, f32) {
    let s = retail_scale();
    let nx = (decomp_core_u32(ix, iy, iq, DISPLACE_X_MAGIC) as f64 * s * amt as f64 + 0.0) as f32;
    let ny = (decomp_core_u32(ix, iy, iq, DISPLACE_Y_MAGIC) as f64 * s * amt as f64 + 0.0) as f32;
    let q = decomp_quadrant_u32(ix, iy) as f64 * s;
    if q >= 0.75 {
        (ny, -nx)
    } else if q >= 0.5 {
        (-nx, -ny)
    } else if q >= 0.25 {
        (-ny, nx)
    } else {
        (nx, ny)
    }
}

/// `ObjectDesc::ScaleObj` (:351361) with retail's scale and its x87 f64
/// `max / min` (the exe's `fld [esi+0x54]; fdiv [esi+0x50]`, which is never
/// stored as a float).
fn decomp_scale_retail(ix: u32, iy: u32, iq: u32, min: f32, max: f32) -> f32 {
    if min == max {
        return max;
    }
    let n = decomp_core_u32(ix, iy, iq, SCALE_MAGIC) as f64 * retail_scale();
    ((max as f64 / min as f64).powf(n) * min as f64) as f32
}

/// `ObjectDesc::GetObjFrame` (:462660) heading in degrees, retail's scale.
fn decomp_heading_retail(ix: u32, iy: u32, iq: u32, max_rot: f32) -> f32 {
    (decomp_core_u32(ix, iy, iq, ROTATION_MAGIC) as f64 * retail_scale() * max_rot as f64) as f32
}

/// The `*_retail` pose functions pinned to f32 bits that were computed in
/// Python from the decomp with 2^-32 and the f64 ScaleObj ratio. The
/// computation is independent of the Rust code. The probe object has
/// origin `(0,0)`, displacement 1.0, scale 0.8..1.5 and max_rot 360.
///
/// The first five rows are the section 3-5 vectors. There, retail rounds
/// to the same f32 as ACE's literal: displace equals section 3, scale
/// equals section 4, and the degrees match `retail_orientation.rs`. The
/// last three rows were chosen because ACE's literal lands 1 ULP off on
/// several channels. A Python sweep of 3,240 `(cell, j)` samples on the
/// five golden LBs (this probe object) compared the two scales. 633 X and
/// 583 Y displacement values and 585 headings were 1 ULP apart, and so
/// were 102 scales. No quadrant flipped.
///
/// ```text
/// 0xA6B1 c(7,8) j=4 ret disp (0x3F321444,0xBEF44F64) scale 0x3FBCC96E deg 0x4278DC7C [flip y,-x]
///                   ace disp (0x3F321443,0xBEF44F63) scale 0x3FBCC96F deg 0x4278DC7B
/// 0xA9B4 c(5,2) j=4 ret disp (0x3F38A477,0xBF63CEE4) scale 0x3FAE36C9 deg 0x4391A09F [flip y,-x]
///                   ace disp (0x3F38A476,0xBF63CEE3) scale 0x3FAE36CA deg 0x4391A09E
/// 0xA3AE c(4,1) j=5 ret disp (0x3EB3083A,0x3EC5A494) scale 0x3FB26078 deg 0x42F2EA10
///                   ace disp (0x3EB30839,0x3EC5A493) scale 0x3FB26078 deg 0x42F2EA0F
/// ```
#[test]
fn retail_pose_noise_pinned_to_decomp_hex() {
    // (lb, cx, cy, j, disp x, disp y, scale, degrees)
    let cases: &[(u16, u32, u32, u32, u32, u32, u32, u32)] = &[
        (0xA3AE, 0, 0, 0, 0x3F42_9388, 0x3EB5_CC02, 0x3FA0_44BD, 0x41C8_579A),
        (0xA3AE, 0, 0, 5, 0x3F77_37DE, 0x3F0F_8A57, 0x3FB6_623E, 0x42C6_2418),
        (0xA6B1, 3, 4, 2, 0x3F38_03B6, 0x3F75_76F1, 0x3F9E_23BD, 0x4131_8D48),
        (0xACB7, 8, 8, 7, 0x3EC8_1B12, 0x3F37_C199, 0x3F95_4990, 0x4332_DBA4),
        (0xAFBA, 1, 2, 3, 0x3F41_8492, 0xBF71_8B27, 0x3FA3_443C, 0x4391_BC81),
        (0xA6B1, 7, 8, 4, 0x3F32_1444, 0xBEF4_4F64, 0x3FBC_C96E, 0x4278_DC7C),
        (0xA9B4, 5, 2, 4, 0x3F38_A477, 0xBF63_CEE4, 0x3FAE_36C9, 0x4391_A09F),
        (0xA3AE, 4, 1, 5, 0x3EB3_083A, 0x3EC5_A494, 0x3FB2_6078, 0x42F2_EA10),
    ];
    let obj = probe_obj(1.0, 0.8, 1.5, 360.0);
    for &(lb, cx, cy, j, ex, ey, es, ed) in cases {
        let (ix, iy) = global_cell(lb, cx, cy);
        let (x, y) = displace_retail(&obj, ix, iy, j);
        assert_eq!(
            (x.to_bits(), y.to_bits()),
            (ex, ey),
            "displace_retail 0x{lb:04X} c({cx},{cy}) j={j}: got ({x}, {y})"
        );
        let s = scale_obj_retail(&obj, ix, iy, j);
        assert_eq!(s.to_bits(), es, "scale_obj_retail 0x{lb:04X} c({cx},{cy}) j={j}: got {s}");
        let d = rotate_obj_retail(&obj, ix, iy, j);
        assert_eq!(d.to_bits(), ed, "rotate_obj_retail 0x{lb:04X} c({cx},{cy}) j={j}: got {d}");
        // The independent transcription agrees.
        assert_eq!(decomp_place_retail(ix, iy, j, 1.0), (x, y));
        assert_eq!(decomp_scale_retail(ix, iy, j, 0.8, 1.5).to_bits(), es);
        assert_eq!(decomp_heading_retail(ix, iy, j, 360.0).to_bits(), ed);
    }
    // On the last three rows the ACE ports (AceCompat) are 1 ULP off retail.
    for &(lb, cx, cy, j) in &[(0xA6B1u16, 7u32, 8u32, 4u32), (0xA9B4, 5, 2, 4), (0xA3AE, 4, 1, 5)] {
        let (ix, iy) = global_cell(lb, cx, cy);
        let (rx, ry) = displace_retail(&obj, ix, iy, j);
        let (ax, ay) = displace(&obj, ix, iy, j);
        assert_ne!((rx.to_bits(), ry.to_bits()), (ax.to_bits(), ay.to_bits()));
        assert_eq!(rx.to_bits().abs_diff(ax.to_bits()), 1);
        assert_eq!(ry.to_bits().abs_diff(ay.to_bits()), 1);
    }
}

/// Production `*_retail` pose functions match the independent decomp
/// transcription bit for bit across all 81 vertices of two golden LBs.
#[test]
fn retail_pose_noise_recomputed_from_raw_decomp() {
    let obj = probe_obj(4.0, 0.7, 1.9, 270.0);
    for lb in [0xA9B4u16, 0xACB7] {
        for cx in 0..9u32 {
            for cy in 0..9u32 {
                let (ix, iy) = global_cell(lb, cx, cy);
                for j in 0..4u32 {
                    let got = displace_retail(&obj, ix, iy, j);
                    let want = decomp_place_retail(ix, iy, j, 4.0);
                    assert_eq!(
                        (got.0.to_bits(), got.1.to_bits()),
                        (want.0.to_bits(), want.1.to_bits()),
                        "displace_retail 0x{lb:04X} c({cx},{cy}) j={j}"
                    );
                    assert_eq!(
                        scale_obj_retail(&obj, ix, iy, j).to_bits(),
                        decomp_scale_retail(ix, iy, j, 0.7, 1.9).to_bits(),
                        "scale_obj_retail 0x{lb:04X} c({cx},{cy}) j={j}"
                    );
                    assert_eq!(
                        rotate_obj_retail(&obj, ix, iy, j).to_bits(),
                        decomp_heading_retail(ix, iy, j, 270.0).to_bits(),
                        "rotate_obj_retail 0x{lb:04X} c({cx},{cy}) j={j}"
                    );
                }
            }
        }
    }
}

/// Retail scene pick, transcribed from `get_land_scenes`
/// (:352639-352645). `count == 1` short-circuits, and
/// `floor((double)cellMat * 2^-32 * count) >= count` falls back to 0.
fn decomp_scene_index_retail(gx: u32, gy: u32, count: u32) -> u32 {
    if count == 1 {
        return 0;
    }
    let v11 = decomp_cell_mat_scene(gx, gy) as f64 * retail_scale();
    let v12 = (v11 * count as f64).floor() as u64 as u32;
    if v12 >= count { 0 } else { v12 }
}

/// `scene_index_retail` matches the decomp pick for every vertex of the
/// golden ring and every bucket size from 1 to 8. At the boundary it
/// differs from ACE's literal: `cellMat = 2^31` with two scenes picks
/// scene 1 (exactly 0.5 * 2) where ACE's literal picks scene 0.
#[test]
fn retail_scene_pick_matches_decomp() {
    for lb in [0xA3AEu16, 0xA6B1, 0xA9B4, 0xACB7, 0xAFBA] {
        for cx in 0..9u32 {
            for cy in 0..9u32 {
                let (gx, gy) = global_cell(lb, cx, cy);
                let cm = cell_mat_scene(gx, gy);
                for count in 1..=8u32 {
                    assert_eq!(
                        scene_index_retail(cm, count as usize),
                        decomp_scene_index_retail(gx, gy, count) as usize,
                        "scene pick 0x{lb:04X} c({cx},{cy}) count={count}"
                    );
                }
            }
        }
    }
    assert_eq!(scene_index_retail(0x8000_0000, 2), 1);
    assert_eq!((2.0 * (0x8000_0000u32 as f64 * NOISE_SCALE)) as usize, 0);
}
