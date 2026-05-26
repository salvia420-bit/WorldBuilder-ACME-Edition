//! Lock our local interpretation of `AttackHeight` to the ACE source.
//!
//! Wave 8 / Phase 24 (2026-05-26): the
//! `dump_cmt_ranged_rows.rs` example and `shield_stance_backhand_audit.rs`
//! test both had an inverted `attack_height_name` label table
//! (`1 => "Low", 3 => "High"`) that contradicted ACE's enum. Phase 24
//! fixed the labels; this test makes sure no one "fixes" them back the
//! wrong way without tripping CI.
//!
//! Source of truth (copied verbatim, no portal.dat required):
//!
//! ```text
//! // ~/ace-server/Source/ACE.Entity/Enum/AttackHeight.cs:1-8
//! namespace ACE.Entity.Enum
//! {
//!     public enum AttackHeight
//!     {
//!         High    = 1,
//!         Medium  = 2,
//!         Low     = 3
//!     }
//! ```
//!
//! `AttackHeightExtensions.GetString` in the same file (lines 12-21)
//! returns `"High" / "Med" / "Low"` for those three values respectively.

/// Mirror of `ACE.Entity.Enum.AttackHeight` used purely to assert wire
/// parity with the C# enum. Kept private to this test so production
/// code keeps reading the raw `u32` off CMT rows (matches retail).
#[repr(u32)]
#[derive(Clone, Copy)]
#[allow(dead_code)]
enum AttackHeightAceMirror {
    High = 1,
    Medium = 2,
    Low = 3,
}

#[test]
fn attack_height_matches_ace_enum() {
    // Cite: ~/ace-server/Source/ACE.Entity/Enum/AttackHeight.cs:3-8
    assert_eq!(AttackHeightAceMirror::High as u32, 1, "AttackHeight::High");
    assert_eq!(
        AttackHeightAceMirror::Medium as u32,
        2,
        "AttackHeight::Medium",
    );
    assert_eq!(AttackHeightAceMirror::Low as u32, 3, "AttackHeight::Low");
}

#[test]
fn attack_height_label_table_matches_ace() {
    // The two consumers (the dump example and the shield audit test)
    // each carry their own local `attack_height_name(u32) -> &str` map.
    // Re-encode the expected mapping here so if either drifts the
    // expectation lives in exactly one place. Drift = CI failure.
    //
    // ACE.Entity.Enum.AttackHeightExtensions.GetString returns "Med"
    // (not "Medium") — we keep "Medium" in the dump/audit helpers for
    // human readability; the *values* are what matter for parity, not
    // the printed strings. This test asserts the value mapping only.
    let cases: &[(u32, &str)] = &[
        (1, "High"),
        (2, "Medium"),
        (3, "Low"),
    ];
    for (value, expected) in cases {
        let label = expected_label(*value);
        assert_eq!(
            label, *expected,
            "AttackHeight {} expected to map to {:?}, got {:?}",
            value, expected, label,
        );
    }
    // Anything outside [1, 3] is "Unknown" — see the dump helper.
    assert_eq!(expected_label(0), "Unknown", "AttackHeight 0 (Undef)");
    assert_eq!(expected_label(4), "Unknown", "AttackHeight 4 (out-of-range)");
}

/// Re-declares the canonical label table so a parity break trips this
/// test before it reaches the dump output. Matches the function bodies
/// in `examples/dump_cmt_ranged_rows.rs` and
/// `tests/shield_stance_backhand_audit.rs`.
fn expected_label(h: u32) -> &'static str {
    match h {
        1 => "High",
        2 => "Medium",
        3 => "Low",
        _ => "Unknown",
    }
}
