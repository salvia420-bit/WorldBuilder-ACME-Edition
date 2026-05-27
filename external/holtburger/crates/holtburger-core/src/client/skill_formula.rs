//! Port of `Chorizite/ACPlugin/API/SkillFormula.cs` (vendored HEAD `1341660`).
//!
//! Wave C — Chorizite absorption (2026-05-27). Some skills (and all vitals)
//! use a formula `(Attribute1 + Attribute2) / Divisor` that boosts the base
//! level by an attribute-derived bonus. These formulas are read from
//! `portal.dat`'s `SkillBase` / `VitalTable` records.
//!
//! Example (from `SkillFormula.cs:12`): Melee Defense uses
//! `(Coordination + Quickness) / 3`.
//!
//! **Upstream bug NOT ported** — see handoff §2 row 1: the C#
//! `HasAttribute2 => Attribute2 == 0` expression is inverted relative to
//! its property name. Callers in `SkillInfo.cs:87, 119` and
//! `VitalInfo.cs:76, 102` work around it by reading `Attribute2 != 0`
//! directly. We omit `HasAttribute2` entirely; callers check
//! [`SkillFormula::has_attribute2`] which has the correct semantics.

use holtburger_common::stats::AttributeType;
use serde::{Deserialize, Serialize};

/// Skill/Vital formula `(Attribute1 + Attribute2) / Divisor`. Field names
/// mirror the C# PascalCase properties in snake_case. `divisor` is `f32` to
/// match C#'s `float Divisor` storage even though the constructor takes
/// `int`.
///
/// `attribute1` / `attribute2` use `Option<AttributeType>` because the
/// portal.dat values include `0 = Undef` to indicate "no second attribute"
/// — see `SkillFormula.cs:14`: *"If HasAttribute2 is false, only Attribute1
/// should be used."*
///
/// Ported from `ACPlugin/API/SkillFormula.cs:16-57` (vendored HEAD
/// `1341660`). The `HasAttribute2` property is **intentionally omitted** —
/// see module docs.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct SkillFormula {
    /// Whether or not to use this formula when calculating the skill total.
    /// C# field: `bool UseFormula` at `SkillFormula.cs:20`.
    pub use_formula: bool,

    /// Used for dividing the results of the attribute additions. C# field:
    /// `float Divisor` at `SkillFormula.cs:25`.
    pub divisor: f32,

    /// The first attribute this formula uses. `None` = `Undef` (value 0) in
    /// the C# source. C# field: `AttributeId Attribute1` at
    /// `SkillFormula.cs:30`.
    pub attribute1: Option<AttributeType>,

    /// The second attribute this formula uses. `None` = `Undef` (value 0)
    /// in the C# source — formula is then attribute1-only. C# field:
    /// `AttributeId Attribute2` at `SkillFormula.cs:35`.
    pub attribute2: Option<AttributeType>,
}

impl SkillFormula {
    /// Construct a new formula. Mirrors the C# `internal SkillFormula(bool,
    /// int, AttributeId, AttributeId)` at `SkillFormula.cs:52-57`.
    ///
    /// `divisor: i32` matches the C# signature; storage is `f32`.
    pub fn new(
        use_formula: bool,
        divisor: i32,
        attribute1: Option<AttributeType>,
        attribute2: Option<AttributeType>,
    ) -> Self {
        Self {
            use_formula,
            divisor: divisor as f32,
            attribute1,
            attribute2,
        }
    }

    /// Returns `true` when this formula's second attribute is set to a real
    /// attribute (NOT `Undef`).
    ///
    /// **This is the CORRECT semantic** — what the C# property name and XML
    /// doc-comment claim to express. The upstream C#
    /// `HasAttribute2 => Attribute2 == 0` is inverted (handoff §2 row 1);
    /// we don't port the buggy expression. All Chorizite callers
    /// (`SkillInfo.cs:87, 119`, `VitalInfo.cs:76, 102`) check
    /// `Attribute2 != 0` directly, which matches this method.
    pub fn has_attribute2(&self) -> bool {
        self.attribute2.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Per `SkillFormula.cs:52-57` constructor: stores divisor as float.
    /// Hand-check: int divisor 3 stored as 3.0 f32.
    #[test]
    fn new_stores_divisor_as_float() {
        let f = SkillFormula::new(
            true,
            3,
            Some(AttributeType::CoordinationAttr),
            Some(AttributeType::QuicknessAttr),
        );
        assert_eq!(f.divisor, 3.0_f32);
        assert!(f.use_formula);
    }

    /// Per the docstring at `SkillFormula.cs:14`: when second attribute is
    /// `Undef` (`None` here), the formula is attribute1-only — so
    /// `has_attribute2()` MUST return `false`.
    #[test]
    fn has_attribute2_false_when_undef() {
        // From ACE skill_table retired skills:
        // Bow row (id=2): (Coordination, _, divisor=2) — Attribute2=Undef.
        let f = SkillFormula::new(true, 2, Some(AttributeType::CoordinationAttr), None);
        assert!(!f.has_attribute2());
    }

    /// Per `SkillFormula.cs:14` doc: when second attribute is a real value,
    /// `has_attribute2()` returns `true`. This is the OPPOSITE of the
    /// buggy upstream `HasAttribute2 == 0` expression — see module docs.
    #[test]
    fn has_attribute2_true_when_set() {
        // Per SkillFormula.cs:12 docstring example: Melee Defense uses
        // (Coordination + Quickness) / 3.
        let f = SkillFormula::new(
            true,
            3,
            Some(AttributeType::CoordinationAttr),
            Some(AttributeType::QuicknessAttr),
        );
        assert!(f.has_attribute2());
    }

    /// Per `SkillFormula.cs:43`: default constructor leaves everything at
    /// `default` (use_formula=false). Mirrors the C# parameterless ctor.
    #[test]
    fn default_is_inactive_formula() {
        let f = SkillFormula::default();
        assert!(!f.use_formula);
        assert_eq!(f.divisor, 0.0_f32);
        assert_eq!(f.attribute1, None);
        assert_eq!(f.attribute2, None);
        assert!(!f.has_attribute2());
    }
}
