//! **PhysicsScript CreateParticle hooks (P1)** — port of ACE's
//! `PhysicsScript.cs` + `AnimationHook.cs::CreateParticle` walk.
//!
//! For each entity that has a `default_script_id` (set in
//! ObjectDescription on the wire, or derived from the SetupModel's
//! `default_script` field), load the PhysicsScript and enumerate its
//! `(start_time, AnimationHook)` script-data entries. For each
//! `CreateParticle` (hook_type=13) or `CreateBlockingParticle`
//! (hook_type=26), emit one [`PhysicsScriptParticleTrigger`] record.
//!
//! # Source mapping (ACE)
//!
//! ```text
//! PhysicsScript.script_data[i] = {
//!     start_time: f64,
//!     hook: AnimationHook { hook_type, direction, data },
//! }
//!
//! For hook_type=13 (CreateParticle) and hook_type=26
//! (CreateBlockingParticle), the 40-byte payload is laid out:
//!   data[0..4]  : u32 emitter_info_id    (`0x32xxxxxx` ParticleEmitter DID)
//!   data[4..8]  : u32 part_index         (anchor part index; 0 = entity origin)
//!   data[8..40] : Vector3 offset_origin + Quaternion offset_orientation
//! ```
//!
//! The first 4 bytes are verified against the retail moon at
//! `0x330007DB` in `physics_script::tests::probe_retail_physics_script_moon`.
//!
//! # Sky particles (P2) — see F.B.4 follow-on
//!
//! Sky particles fire through the same Region → SkyObject SetupModel
//! → PhysicsScript chain but are not anchored to spawned entities;
//! they're walked once per Region per visible day. That path is
//! tracked as F.B.4 (a separate enumerator that reads
//! `Region.sky_info.day_groups[i].sky_objects[j].id`, dispatches on
//! `id >> 24` for `0x01` GfxObj vs `0x02` SetupModel, and recurses
//! into SetupModel.default_script to find the PhysicsScript).
//!
//! The current bake handles only entity-anchored particles (P1).

use holtburger_dat::file_type::PhysicsScript;

/// One PhysicsScript CreateParticle (or CreateBlockingParticle)
/// trigger resolved to a single `(default_script_id, start_time,
/// emitter_id)` record.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PhysicsScriptParticleTrigger {
    /// The PhysicsScript DID the trigger lives in (`0x33xxxxxx`).
    /// Typically the `default_script_id` of an entity that anchors
    /// this script.
    pub default_script_id: u32,
    /// `start_time` from the `PhysicsScriptData` entry. Seconds since
    /// script-start. ACE's `PhysicsScript.Process(elapsed)` fires the
    /// hook when `elapsed >= start_time`.
    pub start_time_s: f64,
    /// ParticleEmitter DID (`0x32xxxxxx`). Emitter is then resolved
    /// through fetchParticleEmitter at runtime.
    pub emitter_id: u32,
    /// Anchor part index from `data[4..8]`. `0` = entity origin / sky
    /// cell origin. Non-zero indexes into the SetupModel's parts list.
    pub part_index: u32,
    /// `true` iff the hook is `CreateBlockingParticle` (hook_type=26)
    /// rather than `CreateParticle` (hook_type=13). The blocking
    /// variant pauses the script until the emitter ends — relevant
    /// for the validator's timing expectations.
    pub blocking: bool,
}

/// Bake the per-entity PhysicsScript particle manifest for one
/// `default_script_id`.
///
/// # Arguments
///
/// - `default_script_id` — the PhysicsScript DID this script belongs
///   to. Stamped onto every output record.
/// - `physics_script` — the parsed PhysicsScript.
///
/// # Output ordering
///
/// Triggers are emitted in the order they appear in
/// `script_data[]` — i.e. fire-order. Stable across runs because
/// `Vec<PhysicsScriptData>` preserves insertion order from the DAT.
pub fn bake_particle_manifest(
    default_script_id: u32,
    physics_script: &PhysicsScript,
) -> Vec<PhysicsScriptParticleTrigger> {
    let mut out: Vec<PhysicsScriptParticleTrigger> = Vec::new();
    for entry in &physics_script.script_data {
        let blocking = match entry.hook.hook_type {
            13 => false,
            26 => true,
            // Non-particle hooks (Sound, Attack, Scale, etc.) live in
            // PhysicsScripts too — they're orthogonal to this bake.
            // Sound hooks within PhysicsScripts would be covered by a
            // future enumerator alongside animation Sound hooks; for
            // now only the particle variants are emitted.
            _ => continue,
        };
        if entry.hook.data.len() < 8 {
            continue;
        }
        let emitter_id = u32::from_le_bytes(entry.hook.data[0..4].try_into().unwrap());
        let part_index = u32::from_le_bytes(entry.hook.data[4..8].try_into().unwrap());
        out.push(PhysicsScriptParticleTrigger {
            default_script_id,
            start_time_s: entry.start_time,
            emitter_id,
            part_index,
            blocking,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_dat::file_type::physics_script::{PhysicsScript, PhysicsScriptData};
    use holtburger_dat::file_type::setup_model::AnimationHook;

    fn create_particle_hook(emitter_id: u32, part_index: u32) -> AnimationHook {
        let mut data = Vec::with_capacity(40);
        data.extend_from_slice(&emitter_id.to_le_bytes());
        data.extend_from_slice(&part_index.to_le_bytes());
        // Padding to 40 bytes — origin + orientation.
        data.extend(std::iter::repeat(0u8).take(40 - 8));
        AnimationHook {
            hook_type: 13,
            direction: 0,
            data,
        }
    }

    fn create_blocking_particle_hook(emitter_id: u32) -> AnimationHook {
        let mut data = Vec::with_capacity(40);
        data.extend_from_slice(&emitter_id.to_le_bytes());
        data.extend_from_slice(&0u32.to_le_bytes());
        data.extend(std::iter::repeat(0u8).take(40 - 8));
        AnimationHook {
            hook_type: 26,
            direction: 0,
            data,
        }
    }

    fn sound_hook() -> AnimationHook {
        AnimationHook {
            hook_type: 1,
            direction: 0,
            data: vec![0, 1, 0, 0], // sound_id=256
        }
    }

    #[test]
    fn empty_physics_script_yields_no_triggers() {
        let ps = PhysicsScript {
            id: 0x33000001,
            script_data: vec![],
        };
        let out = bake_particle_manifest(ps.id, &ps);
        assert!(out.is_empty());
    }

    #[test]
    fn three_create_particles_extracted_in_order() {
        // Mirrors the retail moon at 0x330007DB.
        let ps = PhysicsScript {
            id: 0x330007DB,
            script_data: vec![
                PhysicsScriptData {
                    start_time: 0.0,
                    hook: create_particle_hook(0x32000455, 0),
                },
                PhysicsScriptData {
                    start_time: 0.0,
                    hook: create_particle_hook(0x32000456, 0),
                },
                PhysicsScriptData {
                    start_time: 0.0,
                    hook: create_particle_hook(0x32000457, 0),
                },
            ],
        };
        let out = bake_particle_manifest(ps.id, &ps);
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].emitter_id, 0x32000455);
        assert_eq!(out[1].emitter_id, 0x32000456);
        assert_eq!(out[2].emitter_id, 0x32000457);
        for t in &out {
            assert_eq!(t.default_script_id, 0x330007DB);
            assert_eq!(t.start_time_s, 0.0);
            assert!(!t.blocking);
        }
    }

    #[test]
    fn blocking_particle_flag_propagates() {
        let ps = PhysicsScript {
            id: 0x33000001,
            script_data: vec![PhysicsScriptData {
                start_time: 1.5,
                hook: create_blocking_particle_hook(0x32000123),
            }],
        };
        let out = bake_particle_manifest(ps.id, &ps);
        assert_eq!(out.len(), 1);
        assert!(out[0].blocking);
        assert_eq!(out[0].emitter_id, 0x32000123);
        assert!((out[0].start_time_s - 1.5).abs() < 1e-9);
    }

    #[test]
    fn non_particle_hooks_are_skipped() {
        let ps = PhysicsScript {
            id: 0x33000001,
            script_data: vec![
                PhysicsScriptData {
                    start_time: 0.0,
                    hook: sound_hook(),
                },
                PhysicsScriptData {
                    start_time: 0.1,
                    hook: create_particle_hook(0x32000ABC, 0),
                },
                PhysicsScriptData {
                    start_time: 0.2,
                    hook: sound_hook(),
                },
            ],
        };
        let out = bake_particle_manifest(ps.id, &ps);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].emitter_id, 0x32000ABC);
    }

    #[test]
    fn determinism_repeated_call() {
        let ps = PhysicsScript {
            id: 0x33000001,
            script_data: vec![
                PhysicsScriptData {
                    start_time: 0.0,
                    hook: create_particle_hook(0x32000001, 0),
                },
                PhysicsScriptData {
                    start_time: 0.5,
                    hook: create_blocking_particle_hook(0x32000002),
                },
            ],
        };
        let a = bake_particle_manifest(ps.id, &ps);
        let b = bake_particle_manifest(ps.id, &ps);
        assert_eq!(a, b);
    }
}
