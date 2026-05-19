//! Port of Chorizite's `AC.API.SkillFormula` (C# `ACPlugin/API/SkillFormula.cs`).
//!
//! Some skills use a formula to boost the level based on attributes. If
//! `use_formula` is false the skill has no formula boost. These formulas are
//! read from the portal.dat.
//!
//! The formula is `(Attribute1 + Attribute2) / Divisor`. For example, the
//! formula for Melee Defense is `(Coordination + Quickness) / 3`. If
//! `HasAttribute2` is false, only `Attribute1` should be used.

use serde::{Deserialize, Serialize};

/// Mirror of `Chorizite.Common.Enums.AttributeId`. Backed by `u32` to match
/// the C# `: uint` declaration. Variant order matches the C# enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u32)]
pub enum AttributeId {
    Undef = 0,
    Strength = 1,
    Endurance = 2,
    Quickness = 3,
    Coordination = 4,
    Focus = 5,
    Self_ = 6,
}

impl Default for AttributeId {
    fn default() -> Self {
        AttributeId::Undef
    }
}

/// Port of `AC.API.SkillFormula`. Field names mirror the C# PascalCase
/// properties in snake_case. `divisor` is `f32` to match C#'s `float Divisor`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SkillFormula {
    pub use_formula: bool,
    pub divisor: f32,
    pub attribute1: AttributeId,
    pub attribute2: AttributeId,
}

impl SkillFormula {
    /// Equivalent to the C# `internal SkillFormula(bool, int, AttributeId, AttributeId)`
    /// constructor. Note the C# constructor takes `int divisor` but stores it
    /// in `float Divisor`; we accept `f32` directly for the same end state.
    pub fn new(
        use_formula: bool,
        divisor: f32,
        attribute1: AttributeId,
        attribute2: AttributeId,
    ) -> Self {
        Self {
            use_formula,
            divisor,
            attribute1,
            attribute2,
        }
    }

    /// Faithful port of the C# `HasAttribute2 => Attribute2 == 0` expression.
    ///
    /// NOTE — upstream bug preserved: the property name says "has", but the
    /// C# returns `true` when `Attribute2` is `Undef` (value 0). The XML doc
    /// on the C# property reads "True if this formula uses Attribute2", which
    /// is the opposite of the implementation. Callers that follow the doc
    /// comment will read the secondary attribute when it is absent and skip
    /// it when it is present. We mirror the C# source, not the docstring.
    pub fn has_attribute2(&self) -> bool {
        self.attribute2 as u32 == 0
    }

    /// Apply the documented formula `(attribute1_value + attribute2_value) / divisor`.
    ///
    /// Per the class docstring (`SkillFormula.cs` line 14): "If HasAttribute2
    /// is false, only Attribute1 should be used." Following the *docstring*
    /// definition of "has Attribute2" (the intended meaning, not the buggy
    /// expression), `attribute2_value` is included when `Attribute2` is set
    /// to a real attribute (i.e. NOT `Undef`/0).
    ///
    /// Returns `f32` because C# `Divisor` is `float`.
    pub fn compute(&self, attribute1_value: u32, attribute2_value: u32) -> f32 {
        let sum = if self.attribute2 as u32 == 0 {
            attribute1_value as f32
        } else {
            attribute1_value as f32 + attribute2_value as f32
        };
        sum / self.divisor
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // C# reference: Sword retired skill row, skill_table.rs line 108:
    //   `(11, "Sword", 1, 4, 3)` => attr1=Strength(1), attr2=Coordination(4), divisor=3
    // The class docstring on SkillFormula.cs uses Melee Defense as its
    // example: `(Coordination + Quickness) / 3` — we test both the canonical
    // docstring example AND the retired Sword row.
    #[test]
    fn melee_defense_two_attribute_formula() {
        // From SkillFormula.cs line 12 docstring: "(Coordination + Quickness) / 3"
        let f = SkillFormula::new(true, 3.0, AttributeId::Coordination, AttributeId::Quickness);
        // Hand math: (60 + 90) / 3 = 50.0
        assert_eq!(f.compute(60, 90), 50.0);
    }

    #[test]
    fn sword_two_attribute_formula() {
        // From skill_table.rs retired_skills[Sword]: (Strength + Coordination) / 3
        let f = SkillFormula::new(true, 3.0, AttributeId::Strength, AttributeId::Coordination);
        // Hand math: (100 + 80) / 3 = 60.0
        assert_eq!(f.compute(100, 80), 60.0);
    }

    #[test]
    fn bow_single_attribute_formula() {
        // From skill_table.rs retired_skills[Bow] line 103:
        //   `(2, "Bow", 4, 0, 2)` => attr1=Coordination(4), attr2=Undef(0), divisor=2
        // attribute2 == Undef so compute() should ignore attribute2_value.
        let f = SkillFormula::new(true, 2.0, AttributeId::Coordination, AttributeId::Undef);
        // Hand math: 80 / 2 = 40.0 (attribute2_value=999 ignored because attribute2==Undef)
        assert_eq!(f.compute(80, 999), 40.0);
    }

    #[test]
    fn zero_attributes_two_attribute() {
        let f = SkillFormula::new(true, 3.0, AttributeId::Strength, AttributeId::Coordination);
        // Hand math: (0 + 0) / 3 = 0.0
        assert_eq!(f.compute(0, 0), 0.0);
    }

    #[test]
    fn divisor_rounding_boundary_no_truncation() {
        // Verify C# semantics: `Divisor` is `float`, so `(int + int) / float`
        // in C# is `float / float` after promotion → NO integer truncation.
        // (15 + 13) / 3 = 28 / 3 = 9.333... (not 9).
        let f = SkillFormula::new(true, 3.0, AttributeId::Strength, AttributeId::Coordination);
        let got = f.compute(15, 13);
        // Hand math: 28.0 / 3.0 ≈ 9.3333335 in f32
        assert!((got - 9.333_333_5).abs() < 1e-5, "got {}", got);
    }

    #[test]
    fn has_attribute2_preserves_csharp_bug() {
        // SkillFormula.cs line 41: `public bool HasAttribute2 => Attribute2 == 0;`
        // The implementation returns true when Attribute2 IS Undef, which is
        // the opposite of what the property name and XML doc imply. We mirror
        // the C# source verbatim — see has_attribute2() doc comment.
        //
        // Case A: Attribute2 == Undef (0) — buggy C# returns true.
        let f_undef = SkillFormula::new(true, 2.0, AttributeId::Coordination, AttributeId::Undef);
        assert!(
            f_undef.has_attribute2(),
            "buggy C# returns true when Attribute2 == 0"
        );

        // Case B: Attribute2 == Quickness (3) — buggy C# returns false.
        let f_set = SkillFormula::new(
            true,
            3.0,
            AttributeId::Coordination,
            AttributeId::Quickness,
        );
        assert!(
            !f_set.has_attribute2(),
            "buggy C# returns false when Attribute2 is set to a real attribute"
        );
    }
}
