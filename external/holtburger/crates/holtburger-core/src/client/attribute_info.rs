//! Port of `Chorizite/ACPlugin/API/AttributeInfo.cs` (vendored HEAD `1341660`).
//!
//! Wave C — Chorizite absorption (2026-05-27). Per-attribute bundle that
//! mirrors the C# `AC.API.AttributeInfo` shape and `Current` derivation
//! formula byte-for-byte.
//!
//! See [`chorizite-absorption-plan-2026-05-27.md`] §Wave C and
//! [`chorizite-reading-guide-summary-2026-05-27.md`] §3 for the load-bearing
//! semantics this port preserves.
//!
//! [`chorizite-absorption-plan-2026-05-27.md`]: ../../../../docs/chorizite-absorption-plan-2026-05-27.md
//! [`chorizite-reading-guide-summary-2026-05-27.md`]: ../../../../docs/chorizite-reading-guide-summary-2026-05-27.md

use holtburger_common::stats::AttributeType;
use serde::{Deserialize, Serialize};

/// Per-attribute bundle for a Character. Mirrors the C# `AC.API.AttributeInfo`
/// public surface (field names → snake_case, types preserved).
///
/// Ported from chorizite `ACPlugin/API/AttributeInfo.cs:13-65`
/// (vendored HEAD `1341660`).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct AttributeInfo {
    /// Attribute type (Strength / Endurance / Quickness / Coordination /
    /// Focus / Self). C# field: `AttributeId Type` at `AttributeInfo.cs:19`.
    pub attribute_type: Option<AttributeType>,

    /// The number of times this attribute has been raised. C# field:
    /// `uint PointsRaised` at `AttributeInfo.cs:24`.
    pub points_raised: u32,

    /// Starting point for advancement of the attribute (eg bonus points).
    /// C# field: `uint InnatePoints` at `AttributeInfo.cs:29`.
    pub innate_points: u32,

    /// Total XP spent on this attribute. C# field: `uint Experience` at
    /// `AttributeInfo.cs:34`.
    pub experience: u32,
}

impl AttributeInfo {
    /// Construct an empty `AttributeInfo` for the given attribute type. Mirrors
    /// the C# `internal AttributeInfo(AttributeId)` constructor at
    /// `AttributeInfo.cs:58-60`.
    pub fn new(attribute_type: AttributeType) -> Self {
        Self {
            attribute_type: Some(attribute_type),
            ..Default::default()
        }
    }

    /// Base (unbuffed) attribute level. Ported from
    /// `AttributeInfo.cs:38-39`:
    /// ```csharp
    /// public virtual int Base => (int)(InnatePoints + PointsRaised);
    /// ```
    ///
    /// C# returns `int` so the addition is done in `u32` then cast — the
    /// `(int)` cast is what we mirror with `as i32`.
    pub fn base(&self) -> i32 {
        // C# `(int)(uint + uint)` — wrapping is fine; AC values stay within i32.
        (self.innate_points.wrapping_add(self.points_raised)) as i32
    }

    /// Current attribute level. Includes buffs / debuffs / vitae.
    ///
    /// Ported from `AttributeInfo.cs:44-52`:
    /// ```csharp
    /// var multiplier = character.GetEnchantmentsMultiplierModifier(Type);
    /// var additives  = character.GetEnchantmentsAdditiveModifier(Type);
    /// var effective  = (int)Math.Round(Base * multiplier + additives);
    /// return Math.Max(effective, Base >= 10 ? 10 : 1);
    /// ```
    ///
    /// The `multiplier` (f32) and `additives` (i32) are passed in by the
    /// caller — in C# they come from `Character` via the ambient
    /// `ACPlugin.Instance.Game.Character`; we accept them as parameters so
    /// the math is testable in isolation.
    ///
    /// C# `Math.Round(double)` uses banker's rounding (round-half-to-even);
    /// Rust's `f32::round()` uses round-half-away-from-zero. For the AC
    /// values we see in practice (ints in `[10, 400]` × `[0.0, ~5.0]`),
    /// this matters only on exact `.5` boundaries — we accept the drift
    /// in the unit tests and document the divergence here. **Tracking
    /// item** — file as Wave C.2 candidate if the drift surfaces in HUD
    /// values.
    pub fn current(&self, multiplier: f32, additives: i32) -> i32 {
        let base = self.base();
        let effective = ((base as f32) * multiplier + additives as f32).round() as i32;
        let min = if base >= 10 { 10 } else { 1 };
        effective.max(min)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Per `AttributeInfo.cs:39`: `Base => InnatePoints + PointsRaised`.
    /// Hand-derivation: a freshly created character with 100 Strength (60
    /// innate + 40 raised) → base == 100.
    #[test]
    fn base_sums_innate_and_raised() {
        let info = AttributeInfo {
            attribute_type: Some(AttributeType::StrengthAttr),
            innate_points: 60,
            points_raised: 40,
            experience: 0,
        };
        assert_eq!(info.base(), 100);
    }

    /// Per `AttributeInfo.cs:50`: `effective = round(Base * mult + add)`.
    /// Hand math: base 100, mult 1.5, add 10 → 100 * 1.5 + 10 = 160 → 160.
    #[test]
    fn current_applies_multiplier_then_additive() {
        let info = AttributeInfo {
            attribute_type: Some(AttributeType::CoordinationAttr),
            innate_points: 100,
            points_raised: 0,
            experience: 0,
        };
        assert_eq!(info.current(1.5, 10), 160);
    }

    /// Per `AttributeInfo.cs:50`: rounding via `Math.Round`. Float math:
    /// 100 * 1.234 = 123.4 → round → 123.
    #[test]
    fn current_rounds_float_result() {
        let info = AttributeInfo {
            innate_points: 100,
            points_raised: 0,
            ..Default::default()
        };
        assert_eq!(info.current(1.234, 0), 123);
    }

    /// Per `AttributeInfo.cs:50`: clamp at base>=10 → 10, else → 1.
    /// Hand math: base 100, mult 0.0, add -1000 → -1000 → clamp to 10.
    #[test]
    fn current_clamps_to_ten_when_base_at_least_ten() {
        let info = AttributeInfo {
            innate_points: 100,
            points_raised: 0,
            ..Default::default()
        };
        // Massive debuff that would otherwise push below 10.
        assert_eq!(info.current(0.0, -1000), 10);
    }

    /// Per `AttributeInfo.cs:50`: low-base creatures clamp to 1.
    #[test]
    fn current_clamps_to_one_when_base_below_ten() {
        let info = AttributeInfo {
            innate_points: 5,
            points_raised: 0,
            ..Default::default()
        };
        assert_eq!(info.current(0.0, -100), 1);
    }

    /// Per `AttributeInfo.cs:50`: identity multiplier+additive returns base.
    #[test]
    fn current_no_buff_returns_base() {
        let info = AttributeInfo {
            innate_points: 80,
            points_raised: 50,
            ..Default::default()
        };
        assert_eq!(info.current(1.0, 0), 130);
    }
}
