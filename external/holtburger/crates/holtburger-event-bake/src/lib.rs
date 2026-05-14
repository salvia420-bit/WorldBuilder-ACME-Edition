//! **Holtburger Event Bake** — Rust ports of ACE's three event-trigger
//! enumerators for sounds + particles. Phase F.B of the
//! event-completeness method (see `docs/event-completeness-method.md`,
//! companion to the world-completeness placement bake).
//!
//! Whereas [`holtburger-scenery-bake`] enumerates *placements* (the
//! tree at `(x, y, z)`), this crate enumerates *triggers* — the
//! conditional rules that fire wave / particle events at runtime:
//!
//! - **Ambient** (S1) — per-terrain-vertex Region-driven ambient
//!   sounds. ACE: `AmbientSTBDesc.cs` + `AmbientSoundDesc.cs`. One
//!   trigger per unique `(terrain_type, scene_type)` combination
//!   present in the LB.
//! - **Animation Sound hooks** (S2) — Sound + SoundTweaked hooks
//!   embedded in entity animation clips. ACE:
//!   `AnimationHook.cs::Sound`. One trigger per `(csetup, motion,
//!   frame)`.
//! - **PhysicsScript CreateParticle hooks** (P1) — CreateParticle +
//!   CreateBlockingParticle hooks embedded in entities' default
//!   PhysicsScripts. ACE: `PhysicsScript.cs` + `AnimationHook.cs`
//!   `CreateParticle`. One trigger per `(default_script_id,
//!   start_time, emitter_id)`.
//!
//! # Determinism contract
//!
//! Same shape as the scenery bake: same DAT + same inputs → same
//! `Vec<*Trigger>`, byte-for-byte. The caller-supplied `fetch_*`
//! closures must themselves be deterministic.
//!
//! See `tests/integration.rs::determinism_repeat` for the stress test.
//!
//! # Source mapping
//!
//! | Channel | ACE source                                | Rust impl               |
//! |---------|-------------------------------------------|-------------------------|
//! | S1      | `AmbientSTBDesc.cs` `AmbientSoundDesc.cs` | `ambient::bake_ambient_manifest` |
//! | S2      | `AnimationHook.cs` + motion table walk    | `anim_sound::bake_anim_sound_manifest` |
//! | P1      | `PhysicsScript.cs` (`CreateParticle`)     | `particle::bake_particle_manifest` |
//!
//! S3 (`GameMessageSound` 0xF750) and P2 (sky chain via Region
//! SkyObject SetupModel → PhysicsScript) are out of scope for F.B —
//! the former is server-pushed (no DAT enumeration possible), the
//! latter requires SetupModel-to-PhysicsScript resolution that's
//! tracked as F.B.4. See module docs for both modules for the gaps.
//!
//! # Caller contract for closures
//!
//! Each sub-bake takes resource-fetch closures. The caller owns DAT
//! access; the bake just walks the parsed structures. This matches
//! the scenery-bake pattern (`fetch_scene` + `fetch_obj_bounds`).

#![forbid(unsafe_code)]

pub mod ambient;
pub mod anim_sound;
pub mod particle;

pub use ambient::{AmbientSoundRecord, AmbientTrigger, bake_ambient_manifest};
pub use anim_sound::{AnimSoundTrigger, bake_anim_sound_manifest};
pub use particle::{PhysicsScriptParticleTrigger, bake_particle_manifest};
