//! Position discriminant enum — Wave G (2026-05-27) gap-fill.
//!
//! Chorizite has `PropertyPosition` (the enum identifying WHICH position
//! property a value refers to: current location, lifestone bind, last
//! portal, etc.); we did NOT have it anywhere in the workspace.
//!
//! Distinct from [`crate::position::Position`] (the actual landblock-cell
//! coordinate type) — that's a position VALUE, this is a position KEY.
//!
//! ## Cross-reference
//!
//! * `Chorizite.Common/Enums/PropertyPosition.cs:5-141` — 27 retail
//!   position-property keys.
//! * `~/ac-headers/acclient.c::CACQualities::PositionInfo` — the wire
//!   shape is `(key: PropertyPosition, value: Position)` pairs in the
//!   weenie's `position_dict`.
//!
//! ## Documented uses (from C# XML comments)
//!
//! * `Location = 1` — current position
//! * `Sanctuary = 4` — last lifestone (@home/@save/@ls)
//! * `LinkedPortalOne = 8`, `LastPortal = 9` — portal recall targets
//! * `LinkedLifestone = 15` — lifestone tie
//! * `Save1..Save9 = 17..25` — admin quick-recall slots

use serde::{Deserialize, Serialize};
use strum_macros::{Display, FromRepr};

/// Position-property key discriminant.
///
/// Mirrors `Chorizite.Common.Enums.PropertyPosition`
/// (`Chorizite.Common/Enums/PropertyPosition.cs:5-141`, vendored HEAD
/// `e3b3bd2`). All 27 retail position keys.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize,
    Display, FromRepr, Default,
)]
#[repr(u32)]
pub enum PropertyPosition {
    /// Sentinel — Chorizite has no `None = 0` variant, so we treat
    /// missing/zero as `Location = 1`'s default. This matches the
    /// `position_dict.try_get(key, default = Location)` pattern in
    /// acclient.c.
    #[default]
    Location = 1,
    /// May be used to store where we are headed when we teleport (?)
    Destination = 2,
    /// Where will we pop into the world (?)
    Instantiation = 3,
    /// Last Lifestone Used (@ls/@home/@save/@recall).
    Sanctuary = 4,
    /// Home / starting / base position of an object. Usually first-spawn.
    Home = 5,
    /// Needs more research per Chorizite C# doc-comment.
    ActivationMove = 6,
    /// Position of target.
    Target = 7,
    /// Primary Portal Recall | Summon Primary Portal | Primary Portal Tie.
    LinkedPortalOne = 8,
    /// Portal Recall — last-used portal that can be recalled to.
    LastPortal = 9,
    /// Portal storm: where the player got portaled from or to.
    PortalStorm = 10,
    /// "I can't wait to find out" per Chorizite C# doc-comment.
    CrashAndTurn = 11,
    /// Possibly physical location of the portal you summoned.
    PortalSummonLoc = 12,
    /// Slum-lord eviction boot position.
    HouseBoot = 13,
    /// Last outside death — does NOT cover dungeon deaths.
    LastOutsideDeath = 14,
    /// Linked lifestone: Lifestone Recall | Lifestone Tie.
    LinkedLifestone = 15,
    /// Secondary Portal Recall | Summon Secondary Portal | Secondary Portal Tie.
    LinkedPortalTwo = 16,
    /// Admin Quick Recall Position 1.
    Save1 = 17,
    /// Admin Quick Recall Position 2.
    Save2 = 18,
    /// Admin Quick Recall Position 3.
    Save3 = 19,
    /// Admin Quick Recall Position 4.
    Save4 = 20,
    /// Admin Quick Recall Position 5.
    Save5 = 21,
    /// Admin Quick Recall Position 6.
    Save6 = 22,
    /// Admin Quick Recall Position 7.
    Save7 = 23,
    /// Admin Quick Recall Position 8.
    Save8 = 24,
    /// Admin Quick Recall Position 9.
    Save9 = 25,
    /// Position data is relative to Location.
    RelativeDestination = 26,
    /// Admin @telereturn: pre-@teletome character position.
    TeleportedCharacter = 27,
}

impl PropertyPosition {
    /// True for the `Save1..Save9` admin quick-recall positions.
    pub fn is_admin_save_slot(&self) -> bool {
        matches!(
            self,
            PropertyPosition::Save1
                | PropertyPosition::Save2
                | PropertyPosition::Save3
                | PropertyPosition::Save4
                | PropertyPosition::Save5
                | PropertyPosition::Save6
                | PropertyPosition::Save7
                | PropertyPosition::Save8
                | PropertyPosition::Save9
        )
    }

    /// True for portal-tied positions (lifestone, linked portals,
    /// last-portal recall destinations).
    pub fn is_recall_target(&self) -> bool {
        matches!(
            self,
            PropertyPosition::Sanctuary
                | PropertyPosition::LinkedPortalOne
                | PropertyPosition::LinkedPortalTwo
                | PropertyPosition::LastPortal
                | PropertyPosition::LinkedLifestone
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Asserts `PropertyPosition` integer values match
    /// `Chorizite.Common/Enums/PropertyPosition.cs:5-141` (vendored HEAD
    /// `e3b3bd2`). All 27 variants enumerated.
    #[test]
    fn property_position_values_match_chorizite() {
        assert_eq!(PropertyPosition::Location as u32, 1);
        assert_eq!(PropertyPosition::Destination as u32, 2);
        assert_eq!(PropertyPosition::Instantiation as u32, 3);
        assert_eq!(PropertyPosition::Sanctuary as u32, 4);
        assert_eq!(PropertyPosition::Home as u32, 5);
        assert_eq!(PropertyPosition::ActivationMove as u32, 6);
        assert_eq!(PropertyPosition::Target as u32, 7);
        assert_eq!(PropertyPosition::LinkedPortalOne as u32, 8);
        assert_eq!(PropertyPosition::LastPortal as u32, 9);
        assert_eq!(PropertyPosition::PortalStorm as u32, 10);
        assert_eq!(PropertyPosition::CrashAndTurn as u32, 11);
        assert_eq!(PropertyPosition::PortalSummonLoc as u32, 12);
        assert_eq!(PropertyPosition::HouseBoot as u32, 13);
        assert_eq!(PropertyPosition::LastOutsideDeath as u32, 14);
        assert_eq!(PropertyPosition::LinkedLifestone as u32, 15);
        assert_eq!(PropertyPosition::LinkedPortalTwo as u32, 16);
        assert_eq!(PropertyPosition::Save1 as u32, 17);
        assert_eq!(PropertyPosition::Save9 as u32, 25);
        assert_eq!(PropertyPosition::RelativeDestination as u32, 26);
        assert_eq!(PropertyPosition::TeleportedCharacter as u32, 27);

        // Round-trip via FromRepr
        assert_eq!(PropertyPosition::from_repr(1), Some(PropertyPosition::Location));
        assert_eq!(PropertyPosition::from_repr(27), Some(PropertyPosition::TeleportedCharacter));
        // Chorizite has no `0`; we default to `Location = 1`
        assert_eq!(PropertyPosition::from_repr(0), None);
        assert_eq!(PropertyPosition::from_repr(28), None);
        assert_eq!(PropertyPosition::default(), PropertyPosition::Location);
    }

    /// Asserts the helper partitioners are correct.
    #[test]
    fn property_position_classifications() {
        // Admin quick-recall slots
        assert!(PropertyPosition::Save1.is_admin_save_slot());
        assert!(PropertyPosition::Save5.is_admin_save_slot());
        assert!(PropertyPosition::Save9.is_admin_save_slot());
        assert!(!PropertyPosition::Sanctuary.is_admin_save_slot());
        assert!(!PropertyPosition::Location.is_admin_save_slot());

        // Recall targets (portal-tied)
        assert!(PropertyPosition::Sanctuary.is_recall_target());
        assert!(PropertyPosition::LinkedPortalOne.is_recall_target());
        assert!(PropertyPosition::LinkedPortalTwo.is_recall_target());
        assert!(PropertyPosition::LastPortal.is_recall_target());
        assert!(PropertyPosition::LinkedLifestone.is_recall_target());
        assert!(!PropertyPosition::Location.is_recall_target());
        assert!(!PropertyPosition::Home.is_recall_target());
        assert!(!PropertyPosition::Save1.is_recall_target());
    }
}
