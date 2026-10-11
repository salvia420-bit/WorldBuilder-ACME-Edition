//! MoveTo refactor phase B (2026-10-10) — one retail `MovementManager` per
//! REMOTE object, owned by the world scene.
//!
//! Retail gives every `CPhysicsObj` its own movement manager
//! (`acclient.h:30943`): the wire's `unpack_movement` (`acclient.c:339492`)
//! writes the object's interpreted state or arms its MoveTo, the per-frame
//! `update_object` moves the body by that motion (`:319989`) and then runs
//! `MovementManager::UseTime` → `MoveToManager::UseTime` (`:322879`,
//! `:346018`), whose `_DoMotion` changes the same interp (`:344753`).
//! Holtburger used to keep these managers in core's movement registry and
//! re-create their motion through a separate steer
//! (`RemoteMoveToDrive`); with the scene owning them, the body moves by the
//! manager's own interpreted motion
//! ([`super::root_motion::root_motion`]).

use super::movement_manager::MovementManager;
use super::target_voyeur::TargetVoyeur;

/// One remote object's movement state.
#[derive(Debug, Clone, Default)]
pub struct RemoteMover {
    /// Retail `CPhysicsObj::movement_manager`: the interp + MoveToManager.
    pub movement: MovementManager,
    /// The object's motion table (its MotionTable property, else its
    /// setup's default) — where its root motion comes from.
    pub motion_table_id: Option<u32>,
    /// `CPhysicsObj::GetRadius` / `GetHeight` (the CPartArray dims) — the
    /// self half of the MoveTo cylinder metric (`GetCurrentDistance`,
    /// `acclient.c:344856-344893`) and the holder radius of an arrival
    /// stick.
    pub radius: f32,
    pub height: f32,
    /// MoveTo refactor phase G: its TargetManager registration on the
    /// MoveTo's target (`?targetVoyeur`); `None` with no targeted MoveTo.
    pub voyeur: Option<TargetVoyeur>,
}
