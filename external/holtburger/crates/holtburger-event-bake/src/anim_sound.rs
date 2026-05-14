//! **Animation Sound hooks (S2)** — port of ACE's animation
//! Sound + SoundTweaked hook enumeration.
//!
//! For one entity's `(setup_model, motion_table)` pair, walk every
//! reachable animation clip (cycles, modifiers, link cycles) and
//! enumerate the Sound + SoundTweaked hooks embedded in their part
//! frames. Each `(csetup_id, motion_key, anim_id, frame_index)` tuple
//! produces one [`AnimSoundTrigger`] record.
//!
//! # Source mapping (ACE)
//!
//! - `MotionTable` carries three dictionaries: `cycles`, `modifiers`,
//!   `links` — each maps `(stance, command) → MotionData`.
//! - `MotionData.anims[]` carries one `(anim_id, low_frame,
//!   high_frame, framerate)` tuple per animation clip.
//! - `Animation` (one per `anim_id`) carries `part_frames[frame_idx]
//!   .hooks[]` — each hook is a `(hook_type, direction, payload)`
//!   triple.
//! - Hook type `1` is `Sound` with a 4-byte u32 `sound_id` payload
//!   (which the runtime indexes into the entity's SoundTable to get
//!   one or more wave DIDs).
//! - Hook type `21` is `SoundTweaked` with a 16-byte payload
//!   `{ u32 sound_id, f32 priority, f32 probability, f32 volume }`.
//!
//! Both Sound + SoundTweaked are enumerated — they're distinct
//! runtime paths in `audio_manager.js` but both attribute to "an
//! animation just played and a sound fired".
//!
//! # Frame indexing
//!
//! ACE motion-tables can reference a sub-range of a long animation
//! via `(low_frame, high_frame)`. We emit one trigger per
//! `(motion_key, anim_id, frame_index)` where `frame_index` is the
//! absolute frame in the Animation (not the relative one within the
//! `[low_frame, high_frame]` window). Consumers that care about
//! relative-frame can subtract `low_frame` themselves; absolute is the
//! canonical addressing across cycles that re-use the same Animation
//! file with different windows.
//!
//! # What's enumerated
//!
//! - `cycles` — looping motions (idle, walk, run, ...). Hook fires
//!   every loop iteration.
//! - `modifiers` — one-shot motions on top of a cycle (e.g. emotes).
//!   Hook fires once per modifier trigger.
//! - `links` — transitional motions between cycles. Hook fires once
//!   per link.
//!
//! Hooks under the `default_style` stance are tagged as such
//! ([`AnimSoundTrigger.is_default_stance`]) so the validator can
//! prioritise default-stance reachability.
//!
//! # Determinism
//!
//! Triggers are sorted by `(motion_key, anim_id, frame_index,
//! hook_type)` ascending so the JSONL diff is stable across runs.

use holtburger_dat::file_type::motion_table::{MotionData, MotionTable};
use holtburger_dat::file_type::setup_model::SetupModel;
use holtburger_dat::file_type::Animation;

/// One animation Sound or SoundTweaked hook resolved to a single
/// `(csetup, motion, frame)` trigger.
#[derive(Debug, Clone, PartialEq)]
pub struct AnimSoundTrigger {
    /// The SetupModel DID the trigger fires on (`0x02xxxxxx`). The
    /// caller passes this in — the SetupModel struct doesn't carry it
    /// in a top-level field other than `id`.
    pub csetup_id: u32,
    /// The MotionTable DID the trigger lives in (`0x09xxxxxx`).
    pub motion_table_id: u32,
    /// Composite key `(stance << 16) | command` from `MotionTable`.
    /// Same shape the runtime uses to look up the cycle.
    pub motion_key: u32,
    /// Which bucket the key came from. `0` = cycles, `1` = modifiers,
    /// `2` = links. Order matches the iteration order in the bake so
    /// "this trigger comes from a cycle vs a one-shot" is preserved.
    pub motion_kind: u8,
    /// If `motion_kind == 2` (links), this is the outer link
    /// stance key. `None` for cycles/modifiers.
    pub link_outer_key: Option<u32>,
    /// `true` iff the trigger's stance matches the MotionTable's
    /// `default_style`. Most entities default-spawn into the
    /// default stance, so these hooks are reachable on spawn-idle
    /// without further state changes.
    pub is_default_stance: bool,
    /// `Animation` DID this trigger lives in (`0x03xxxxxx`).
    pub animation_did: u32,
    /// Absolute frame index into the Animation's `part_frames[]`.
    pub hook_frame: u32,
    /// `0x01` (Sound) or `0x15` (SoundTweaked). Other hook types are
    /// not emitted by this bake.
    pub hook_type: u32,
    /// `sound_id` from the first 4 bytes of the hook payload. Indexes
    /// into the entity's SoundTable.
    pub sound_id: u32,
    /// For SoundTweaked hooks: `priority`, `probability`, `volume`
    /// (the next 12 bytes of the payload). For plain Sound hooks all
    /// three default to "default" — `priority=0.0, probability=1.0,
    /// volume=1.0` — mirroring ACE's `Sound` hook constructor in
    /// `AnimationHook.cs`.
    pub priority: f32,
    pub probability: f32,
    pub volume: f32,
}

/// Bake the animation Sound + SoundTweaked manifest for one entity.
///
/// # Arguments
///
/// - `csetup_id` — the SetupModel DID the entity uses
///   (`0x02xxxxxx`). Stamped into each output record.
/// - `setup_model` — the parsed SetupModel.
/// - `motion_table` — the parsed MotionTable. Caller resolves the
///   right MotionTable for this entity (typically
///   `setup_model.default_motion_table` if present, but spawn-time
///   `mtableId` overrides are possible).
/// - `fetch_animation` — closure to resolve an `anim_id` to a parsed
///   `Animation`. Caller owns DAT access. Returning `None` means
///   "this anim_id isn't loadable" — the bake skips it (no panic).
pub fn bake_anim_sound_manifest(
    csetup_id: u32,
    _setup_model: &SetupModel,
    motion_table: &MotionTable,
    mut fetch_animation: impl FnMut(u32) -> Option<Animation>,
) -> Vec<AnimSoundTrigger> {
    let mut out: Vec<AnimSoundTrigger> = Vec::new();
    let default_stance = motion_table.default_style;
    let motion_table_id = motion_table.id;

    // Bucket 0: cycles. Walk in sorted key order for stable emit.
    let mut cycle_keys: Vec<u32> = motion_table.cycles.keys().copied().collect();
    cycle_keys.sort();
    for k in cycle_keys {
        let md = &motion_table.cycles[&k];
        enumerate_motion_data(
            csetup_id,
            motion_table_id,
            k,
            0,
            None,
            stance_from_key(k) == default_stance,
            md,
            &mut fetch_animation,
            &mut out,
        );
    }

    // Bucket 1: modifiers.
    let mut mod_keys: Vec<u32> = motion_table.modifiers.keys().copied().collect();
    mod_keys.sort();
    for k in mod_keys {
        let md = &motion_table.modifiers[&k];
        enumerate_motion_data(
            csetup_id,
            motion_table_id,
            k,
            1,
            None,
            stance_from_key(k) == default_stance,
            md,
            &mut fetch_animation,
            &mut out,
        );
    }

    // Bucket 2: links. These are nested: outer key (typically a
    // stance/style) → inner map of cycle-like keys. Walk both levels
    // in sorted order.
    let mut outer_keys: Vec<u32> = motion_table.links.keys().copied().collect();
    outer_keys.sort();
    for outer_k in outer_keys {
        let inner = &motion_table.links[&outer_k];
        let mut inner_keys: Vec<u32> = inner.keys().copied().collect();
        inner_keys.sort();
        for inner_k in inner_keys {
            let md = &inner[&inner_k];
            enumerate_motion_data(
                csetup_id,
                motion_table_id,
                inner_k,
                2,
                Some(outer_k),
                stance_from_key(inner_k) == default_stance,
                md,
                &mut fetch_animation,
                &mut out,
            );
        }
    }

    // Final stable sort: (motion_key, anim_id, frame, hook_type).
    out.sort_by(|a, b| {
        (a.motion_key, a.animation_did, a.hook_frame, a.hook_type).cmp(&(
            b.motion_key,
            b.animation_did,
            b.hook_frame,
            b.hook_type,
        ))
    });

    out
}

/// Walk one `MotionData`'s `anims[]` and enumerate Sound + SoundTweaked
/// hooks in each animation's `part_frames[frame].hooks[]`.
fn enumerate_motion_data(
    csetup_id: u32,
    motion_table_id: u32,
    motion_key: u32,
    motion_kind: u8,
    link_outer_key: Option<u32>,
    is_default_stance: bool,
    md: &MotionData,
    fetch_animation: &mut impl FnMut(u32) -> Option<Animation>,
    out: &mut Vec<AnimSoundTrigger>,
) {
    for anim_data in &md.anims {
        let Some(anim) = fetch_animation(anim_data.anim_id) else {
            // Animation not loadable (broken DAT or LOD-gated). Skip.
            continue;
        };
        // Determine the absolute frame range. ACE's
        // `MotionInterpreter` walks `low_frame..=high_frame` where
        // negative values mean "to end". For enumeration we accept
        // `low_frame >= 0`; otherwise default to `0..num_frames-1`.
        let n_frames = anim.part_frames.len();
        if n_frames == 0 {
            continue;
        }
        let lo = if anim_data.low_frame < 0 {
            0
        } else {
            anim_data.low_frame as usize
        };
        let hi = if anim_data.high_frame < 0 || (anim_data.high_frame as usize) >= n_frames {
            n_frames.saturating_sub(1)
        } else {
            anim_data.high_frame as usize
        };
        if lo > hi {
            continue;
        }
        for frame_idx in lo..=hi {
            let frame = &anim.part_frames[frame_idx];
            for hook in &frame.hooks {
                match hook.hook_type {
                    // Sound — 4-byte u32 sound_id payload.
                    1 => {
                        if hook.data.len() < 4 {
                            continue;
                        }
                        let sound_id =
                            u32::from_le_bytes(hook.data[0..4].try_into().unwrap());
                        out.push(AnimSoundTrigger {
                            csetup_id,
                            motion_table_id,
                            motion_key,
                            motion_kind,
                            link_outer_key,
                            is_default_stance,
                            animation_did: anim.id,
                            hook_frame: frame_idx as u32,
                            hook_type: 1,
                            sound_id,
                            // Plain Sound hook has no SoundTweaked
                            // overrides; emit default values that
                            // `audio_manager.js` falls back to.
                            priority: 0.0,
                            probability: 1.0,
                            volume: 1.0,
                        });
                    }
                    // SoundTweaked — 16-byte payload.
                    21 => {
                        if hook.data.len() < 16 {
                            continue;
                        }
                        let sound_id =
                            u32::from_le_bytes(hook.data[0..4].try_into().unwrap());
                        let priority =
                            f32::from_le_bytes(hook.data[4..8].try_into().unwrap());
                        let probability =
                            f32::from_le_bytes(hook.data[8..12].try_into().unwrap());
                        let volume =
                            f32::from_le_bytes(hook.data[12..16].try_into().unwrap());
                        out.push(AnimSoundTrigger {
                            csetup_id,
                            motion_table_id,
                            motion_key,
                            motion_kind,
                            link_outer_key,
                            is_default_stance,
                            animation_did: anim.id,
                            hook_frame: frame_idx as u32,
                            hook_type: 21,
                            sound_id,
                            priority,
                            probability,
                            volume,
                        });
                    }
                    // Other hook types (Attack, CreateParticle, ...)
                    // are out of scope for the animation-Sound bake.
                    _ => {}
                }
            }
        }
    }
}

/// Top 16 bits of a `MotionTable` cycle key — the stance portion. The
/// bottom 20 bits are the command portion (matches
/// `motion_table::cycle_key` mask `0x000F_FFFF`). High 16 are stance.
fn stance_from_key(key: u32) -> u32 {
    (key >> 16) & 0xFFFF
}

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_common::Vector3;
    use holtburger_dat::file_type::animation::AnimationFlags;
    use holtburger_dat::file_type::setup_model::{AnimationFrame, AnimationHook};
    use std::collections::HashMap;

    fn empty_setup() -> SetupModel {
        SetupModel {
            id: 0x02000123,
            flags: 0,
            parts: vec![],
            parent_index: vec![],
            default_scale: vec![],
            holding_locations: HashMap::new(),
            connection_points: HashMap::new(),
            placement_frames: HashMap::new(),
            cyl_spheres: vec![],
            spheres: vec![],
            height: 0.0,
            radius: 0.0,
            step_up: 0.0,
            step_down: 0.0,
            sorting_sphere: holtburger_common::Sphere {
                center: Vector3::default(),
                radius: 0.0,
            },
            selection_sphere: holtburger_common::Sphere {
                center: Vector3::default(),
                radius: 0.0,
            },
            lights: HashMap::new(),
            default_animation: None,
            default_script: None,
            default_motion_table: None,
            default_sound_table: None,
            default_script_table: None,
        }
    }

    fn synth_animation(anim_id: u32, frames_with_hooks: Vec<Vec<AnimationHook>>) -> Animation {
        let part_frames: Vec<AnimationFrame> = frames_with_hooks
            .into_iter()
            .map(|hooks| AnimationFrame {
                frames: vec![],
                hooks,
            })
            .collect();
        Animation {
            id: anim_id,
            flags: AnimationFlags::empty(),
            num_parts: 0,
            num_frames: part_frames.len() as u32,
            pos_frames: vec![],
            part_frames,
        }
    }

    fn sound_hook(sound_id: u32) -> AnimationHook {
        AnimationHook {
            hook_type: 1,
            direction: 0,
            data: sound_id.to_le_bytes().to_vec(),
        }
    }

    fn sound_tweaked_hook(sound_id: u32, priority: f32, probability: f32, volume: f32) -> AnimationHook {
        let mut data = Vec::new();
        data.extend_from_slice(&sound_id.to_le_bytes());
        data.extend_from_slice(&priority.to_le_bytes());
        data.extend_from_slice(&probability.to_le_bytes());
        data.extend_from_slice(&volume.to_le_bytes());
        AnimationHook {
            hook_type: 21,
            direction: 0,
            data,
        }
    }

    fn other_hook() -> AnimationHook {
        // CreateParticle (13) — should NOT be emitted by the anim_sound bake.
        AnimationHook {
            hook_type: 13,
            direction: 0,
            data: vec![0u8; 40],
        }
    }

    fn motion_table_with_cycle(stance: u32, command: u32, anim_id: u32) -> MotionTable {
        // Note: cycle_key is `((stance & 0xFFFF) << 16) | (command & 0x000F_FFFF)`.
        let key = ((stance & 0xFFFF) << 16) | (command & 0x000F_FFFF);
        let mut cycles = HashMap::new();
        cycles.insert(
            key,
            MotionData {
                bitfield: 0,
                flags: holtburger_dat::file_type::motion_table::MotionDataFlags::empty(),
                anims: vec![holtburger_dat::file_type::motion_table::AnimData {
                    anim_id,
                    low_frame: 0,
                    high_frame: -1, // "to end"
                    framerate: 30.0,
                }],
                velocity: None,
                omega: None,
            },
        );
        MotionTable {
            id: 0x09000001,
            default_style: stance,
            style_defaults: HashMap::new(),
            cycles,
            modifiers: HashMap::new(),
            links: HashMap::new(),
        }
    }

    #[test]
    fn empty_motion_table_emits_no_triggers() {
        let setup = empty_setup();
        let mt = MotionTable {
            id: 0x09000001,
            default_style: 0,
            style_defaults: HashMap::new(),
            cycles: HashMap::new(),
            modifiers: HashMap::new(),
            links: HashMap::new(),
        };
        let out = bake_anim_sound_manifest(setup.id, &setup, &mt, |_| None);
        assert!(out.is_empty());
    }

    #[test]
    fn one_sound_hook_on_one_frame() {
        let setup = empty_setup();
        let anim = synth_animation(0x03000010, vec![vec![sound_hook(256)]]);
        let mt = motion_table_with_cycle(0x40, 0x05, anim.id);
        let mut fetched = false;
        let out = bake_anim_sound_manifest(setup.id, &setup, &mt, |did| {
            if did == anim.id {
                fetched = true;
                Some(anim.clone())
            } else {
                None
            }
        });
        assert!(fetched);
        assert_eq!(out.len(), 1);
        let t = &out[0];
        assert_eq!(t.csetup_id, setup.id);
        assert_eq!(t.animation_did, anim.id);
        assert_eq!(t.hook_type, 1);
        assert_eq!(t.sound_id, 256);
        assert_eq!(t.hook_frame, 0);
        assert!(t.is_default_stance);
    }

    #[test]
    fn sound_tweaked_payload_is_decoded() {
        let setup = empty_setup();
        let anim = synth_animation(
            0x03000010,
            vec![vec![sound_tweaked_hook(512, 0.5, 0.75, 0.8)]],
        );
        let mt = motion_table_with_cycle(0x40, 0x05, anim.id);
        let out = bake_anim_sound_manifest(setup.id, &setup, &mt, |did| {
            if did == anim.id { Some(anim.clone()) } else { None }
        });
        assert_eq!(out.len(), 1);
        let t = &out[0];
        assert_eq!(t.hook_type, 21);
        assert_eq!(t.sound_id, 512);
        assert!((t.priority - 0.5).abs() < 1e-6);
        assert!((t.probability - 0.75).abs() < 1e-6);
        assert!((t.volume - 0.8).abs() < 1e-6);
    }

    #[test]
    fn non_sound_hooks_are_filtered_out() {
        let setup = empty_setup();
        let anim = synth_animation(
            0x03000010,
            vec![vec![other_hook(), sound_hook(123), other_hook()]],
        );
        let mt = motion_table_with_cycle(0x40, 0x05, anim.id);
        let out = bake_anim_sound_manifest(setup.id, &setup, &mt, |did| {
            if did == anim.id { Some(anim.clone()) } else { None }
        });
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].sound_id, 123);
    }

    #[test]
    fn missing_animation_skipped_not_panicked() {
        let setup = empty_setup();
        let mt = motion_table_with_cycle(0x40, 0x05, 0x03000099);
        // fetch_animation always returns None — broken DAT scenario.
        let out = bake_anim_sound_manifest(setup.id, &setup, &mt, |_| None);
        assert!(out.is_empty());
    }

    #[test]
    fn determinism_repeated_call() {
        let setup = empty_setup();
        let anim = synth_animation(
            0x03000010,
            vec![
                vec![sound_hook(1)],
                vec![],
                vec![sound_hook(2), sound_hook(3)],
            ],
        );
        let mt = motion_table_with_cycle(0x40, 0x05, anim.id);
        let a = bake_anim_sound_manifest(setup.id, &setup, &mt, |did| {
            if did == anim.id { Some(anim.clone()) } else { None }
        });
        let b = bake_anim_sound_manifest(setup.id, &setup, &mt, |did| {
            if did == anim.id { Some(anim.clone()) } else { None }
        });
        assert_eq!(a, b);
        assert_eq!(a.len(), 3);
        assert_eq!(a[0].hook_frame, 0);
        assert_eq!(a[0].sound_id, 1);
        assert_eq!(a[1].hook_frame, 2);
        assert_eq!(a[1].sound_id, 2);
        assert_eq!(a[2].hook_frame, 2);
        assert_eq!(a[2].sound_id, 3);
    }

    #[test]
    fn modifiers_and_links_buckets_walked() {
        let setup = empty_setup();
        let anim_cycle = synth_animation(0x03000010, vec![vec![sound_hook(100)]]);
        let anim_mod = synth_animation(0x03000020, vec![vec![sound_hook(200)]]);
        let anim_link = synth_animation(0x03000030, vec![vec![sound_hook(300)]]);
        let cycle_key = ((0x40u32 & 0xFFFF) << 16) | (0x05u32 & 0x000F_FFFF);
        let mod_key = ((0x40u32 & 0xFFFF) << 16) | (0x06u32 & 0x000F_FFFF);
        let link_inner = ((0x40u32 & 0xFFFF) << 16) | (0x07u32 & 0x000F_FFFF);

        let mut cycles = HashMap::new();
        cycles.insert(
            cycle_key,
            MotionData {
                bitfield: 0,
                flags: holtburger_dat::file_type::motion_table::MotionDataFlags::empty(),
                anims: vec![holtburger_dat::file_type::motion_table::AnimData {
                    anim_id: anim_cycle.id,
                    low_frame: 0,
                    high_frame: -1,
                    framerate: 30.0,
                }],
                velocity: None,
                omega: None,
            },
        );
        let mut modifiers = HashMap::new();
        modifiers.insert(
            mod_key,
            MotionData {
                bitfield: 0,
                flags: holtburger_dat::file_type::motion_table::MotionDataFlags::empty(),
                anims: vec![holtburger_dat::file_type::motion_table::AnimData {
                    anim_id: anim_mod.id,
                    low_frame: 0,
                    high_frame: -1,
                    framerate: 30.0,
                }],
                velocity: None,
                omega: None,
            },
        );
        let mut inner = HashMap::new();
        inner.insert(
            link_inner,
            MotionData {
                bitfield: 0,
                flags: holtburger_dat::file_type::motion_table::MotionDataFlags::empty(),
                anims: vec![holtburger_dat::file_type::motion_table::AnimData {
                    anim_id: anim_link.id,
                    low_frame: 0,
                    high_frame: -1,
                    framerate: 30.0,
                }],
                velocity: None,
                omega: None,
            },
        );
        let mut links = HashMap::new();
        links.insert(0x40, inner);

        let mt = MotionTable {
            id: 0x09000001,
            default_style: 0x40,
            style_defaults: HashMap::new(),
            cycles,
            modifiers,
            links,
        };

        let lookup = |did: u32| {
            if did == anim_cycle.id {
                Some(anim_cycle.clone())
            } else if did == anim_mod.id {
                Some(anim_mod.clone())
            } else if did == anim_link.id {
                Some(anim_link.clone())
            } else {
                None
            }
        };

        let out = bake_anim_sound_manifest(setup.id, &setup, &mt, lookup);
        assert_eq!(out.len(), 3);
        // All three motion_kinds appear.
        let mut kinds: Vec<u8> = out.iter().map(|t| t.motion_kind).collect();
        kinds.sort();
        assert_eq!(kinds, vec![0, 1, 2]);
        // Find the link trigger and confirm link_outer_key.
        let link = out.iter().find(|t| t.motion_kind == 2).unwrap();
        assert_eq!(link.link_outer_key, Some(0x40));
    }
}
