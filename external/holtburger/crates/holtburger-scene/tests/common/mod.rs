//! Shared helpers for the JS → Rust parity tests. Fixtures are written by
//! apps/holtburger-web/tools/rust_parity/*.mjs; floats travel as IEEE-754 bit
//! patterns in hex (see fixture_util.mjs).
#![allow(dead_code)]

use serde_json::Value;
use std::path::PathBuf;

pub fn fixture(name: &str) -> Option<Value> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(format!("{name}.json"));
    let s = std::fs::read_to_string(&p).ok()?;
    Some(serde_json::from_str(&s).expect("fixture JSON"))
}

pub fn hex_f64(v: &Value) -> f64 {
    f64::from_bits(u64::from_str_radix(v.as_str().expect("hex string"), 16).expect("hex"))
}

pub fn hex_f32(v: &Value) -> f32 {
    f32::from_bits(u32::from_str_radix(v.as_str().expect("hex string"), 16).expect("hex"))
}

pub fn hex_f64s(v: &Value) -> Vec<f64> {
    v.as_array().expect("array").iter().map(hex_f64).collect()
}

pub fn hex_f32s(v: &Value) -> Vec<f32> {
    v.as_array().expect("array").iter().map(hex_f32).collect()
}

/// Distance in units in the last place between two f64s (same sign assumed
/// for small differences; ±0 compare equal). NaN vs NaN is 0.
pub fn ulps_f64(a: f64, b: f64) -> u64 {
    if a.is_nan() && b.is_nan() {
        return 0;
    }
    if a == b {
        return 0;
    }
    let (ia, ib) = (a.to_bits() as i64, b.to_bits() as i64);
    let ia = if ia < 0 { i64::MIN - ia } else { ia };
    let ib = if ib < 0 { i64::MIN - ib } else { ib };
    (ia - ib).unsigned_abs()
}

pub fn ulps_f32(a: f32, b: f32) -> u32 {
    if a.is_nan() && b.is_nan() {
        return 0;
    }
    if a == b {
        return 0;
    }
    let (ia, ib) = (a.to_bits() as i32, b.to_bits() as i32);
    let ia = if ia < 0 { i32::MIN - ia } else { ia };
    let ib = if ib < 0 { i32::MIN - ib } else { ib };
    (ia - ib).unsigned_abs()
}

/// Exact bit equality (the default for anything without sin/cos/exp/pow).
pub fn assert_bits_eq(what: &str, got: &[f64], want: &[f64]) {
    assert_eq!(got.len(), want.len(), "{what}: length");
    for (i, (g, w)) in got.iter().zip(want).enumerate() {
        assert!(g.to_bits() == w.to_bits() || (g.is_nan() && w.is_nan()), "{what}[{i}]: got {g:e} ({:016x}) want {w:e} ({:016x})", g.to_bits(), w.to_bits());
    }
}

/// Within `max_ulps` (for values derived from transcendental functions).
pub fn assert_ulps(what: &str, got: &[f64], want: &[f64], max_ulps: u64) {
    assert_eq!(got.len(), want.len(), "{what}: length");
    for (i, (g, w)) in got.iter().zip(want).enumerate() {
        let d = ulps_f64(*g, *w);
        assert!(d <= max_ulps, "{what}[{i}]: got {g:e} want {w:e} ({d} ulps > {max_ulps})");
    }
}

/// Within `tol` absolute (sin/cos-derived values near zero, where a 1-ulp
/// libm difference turns into many ulps after a cancelling subtraction).
pub fn assert_abs(what: &str, got: &[f64], want: &[f64], tol: f64) {
    assert_eq!(got.len(), want.len(), "{what}: length");
    for (i, (g, w)) in got.iter().zip(want).enumerate() {
        assert!((g - w).abs() <= tol, "{what}[{i}]: got {g:e} want {w:e} (|d| {:e} > {tol:e})", (g - w).abs());
    }
}
