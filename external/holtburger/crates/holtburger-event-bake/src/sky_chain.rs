//! **Sky particle chain (P2)** — port of the Region SkyObject →
//! PhysicsScript → CreateParticle walk that the renderer's `sky_dome.js`
//! chain walker (Sky-J P5) performs at runtime.
//!
//! Whereas the per-entity particle bake ([`crate::particle`]) is keyed
//! on `(default_script_id, start_time, emitter_id)` and anchored to a
//! spawned entity, the sky chain is keyed on `(day_group, sky_object,
//! hook)` and anchored to the **sky cell origin** — the cell that
//! follows the camera each frame. Sky particles fire on a per-tick
//! cadence driven by `time-of-day` rather than per-entity spawn events.
//!
//! # Source mapping (ACE / DAT)
//!
//! ```text
//! Region.sky_info.day_groups[i] = DayGroup {
//!     day_name,
//!     sky_objects: Vec<SkyObject {
//!         begin_time, end_time,     // day-fractions (0.0..1.0)
//!         default_gfx_object_id,    // 0x01xxxxxx GfxObj OR 0x02xxxxxx SetupModel
//!         default_pes_object_id,    // 0x33xxxxxx PhysicsScript (or 0)
//!     }>,
//!     sky_time: Vec<SkyTimeOfDay>,
//! }
//!
//! When default_pes_object_id != 0, fetch PhysicsScript:
//!   PhysicsScript.script_data[j] = (start_time, AnimationHook)
//!
//! For hook_type=13 (CreateParticle) or hook_type=26
//! (CreateBlockingParticle), the first 4 bytes of the 40-byte payload
//! decode to a 0x32xxxxxx ParticleEmitter DID — same field layout the
//! entity-particle bake uses.
//! ```
//!
//! # Anchor
//!
//! All sky-chain triggers anchor to `"sky_cell_origin"` — the renderer
//! cell that follows the camera. This is a fixed string (no per-record
//! variation) but written into every record for symmetry with the
//! entity bake's `"entity_origin"` anchor field.
//!
//! Per-hook offsets carried in `AnimationHook.data[8..40]` (a Vector3
//! origin + Quaternion orientation) are NOT extracted by this bake —
//! they're consumed by the runtime particle manager at fire-time and
//! don't change the trigger identity. See
//! `apps/holtburger-web/scene3d/sky_dome.js::_attachParticleChainFromState`
//! for the runtime path.
//!
//! # Day-group activity window
//!
//! Each DayGroup has a `chance_of_occur` weight (used by ACE's
//! per-day LCG hash to pick one of the N DayGroups as "today"), and
//! each `SkyObject` carries `begin_time` / `end_time` day-fractions
//! during which it's visible. The bake propagates these as
//! `active_fraction_start` / `active_fraction_end` (the raw DAT values,
//! in `0.0..1.0`). The brief's `active_hours_start` / `active_hours_end`
//! shape (in absolute hours-of-day) requires multiplying by
//! `region.game_time.day_length / 3600`, which the consumer can do
//! deterministically given the JSONL; we keep the trigger record
//! unit-independent.
//!
//! # Determinism
//!
//! Output is deterministic given `(region, fetch_physics_script,
//! fetch_setup_model)`. Records are emitted in
//! `(day_group_idx, sky_object_idx, hook_idx)` ascending order —
//! identical to the DAT iteration order, so the JSONL diff is stable
//! across runs.
//!
//! # Empty case
//!
//! If `region.sky_info` is `None` (Region without `HasSkyInfo` bit), or
//! if no SkyObject across all DayGroups has a nonzero
//! `default_pes_object_id` *and* no SetupModel resolves to a
//! `default_script`, the function returns `Vec::new()`. Real Region 0x13
//! has at least the moon chain (`0x02000714 → 0x330007DB`) per
//! `region.rs::region_1_parses_from_real_client_portal_dat_with_sky_info`
//! and `crates/holtburger-event-bake/src/particle.rs::three_create_particles_extracted_in_order`.

use holtburger_dat::file_type::physics_script::PhysicsScript;
use holtburger_dat::file_type::region::Region;
use holtburger_dat::file_type::setup_model::SetupModel;

/// One sky-chain particle trigger. Records the path
/// `(day_group, sky_object, physics_script, hook) → emitter` along with
/// enough context for the validator to time-correlate against the
/// runtime event log.
#[derive(Debug, Clone, PartialEq)]
pub struct SkyParticleTrigger {
    /// Index of the DayGroup in `Region.sky_info.day_groups[]` (0..N).
    pub day_group_idx: u32,
    /// `DayGroup.day_name` — e.g. `"Sunny"`, `"PartlyCloudy"`. Carried
    /// for the validator's report so the day picker doesn't need to
    /// resolve the index against the Region every time.
    pub day_group_name: String,
    /// `DayGroup.chance_of_occur` — used by ACE's per-day LCG hash to
    /// pick a day. The bake doesn't simulate the picker — every
    /// DayGroup gets its chain enumerated; the validator filters by
    /// "today's" day group at probe time.
    pub day_group_chance: f32,
    /// `SkyObject.begin_time` — day-fraction (0.0..1.0) at which this
    /// object becomes visible. Renderer multiplies by
    /// `region.game_time.day_length` to get seconds-since-day-start.
    pub active_fraction_start: f32,
    /// `SkyObject.end_time` — day-fraction at which the object
    /// disappears. May be `< active_fraction_start` for objects that
    /// wrap past midnight (e.g. moon visible from late-night to early
    /// morning). The validator should treat the active window as
    /// `[start, end]` mod 1.0.
    pub active_fraction_end: f32,
    /// Index of the SkyObject within `DayGroup.sky_objects[]`. Combined
    /// with `day_group_idx` this uniquely identifies the source
    /// SkyObject record.
    pub sky_object_idx: u32,
    /// `SkyObject.default_gfx_object_id` — either a `0x01xxxxxx` GfxObj
    /// (direct visual) or `0x02xxxxxx` SetupModel (physics-script
    /// anchor). Reported verbatim for the JSONL — the validator can
    /// dispatch on `id >> 24` to know which renderer path the trigger
    /// fires through.
    pub sky_object_id: u32,
    /// `0x33xxxxxx` PhysicsScript DID resolved from either
    /// `SkyObject.default_pes_object_id` (preferred, matches the
    /// runtime chain) or `SetupModel.default_script` (fallback for
    /// `0x02xxxxxx` SkyObjects whose pes_object_id is zero — none in
    /// retail Dereth but defensive against future regions / mods).
    pub physics_script_id: u32,
    /// Source for the `physics_script_id`. `"sky_object"` =
    /// `SkyObject.default_pes_object_id`, `"setup_model"` =
    /// `SetupModel.default_script`. Records with `"setup_model"` source
    /// are an edge case — retail Dereth never hits this path.
    pub physics_script_source: ScriptSource,
    /// Index of the hook within `PhysicsScript.script_data[]` (0..M).
    /// Mirrors the entity-particle bake's emission order — fire-order
    /// within the script. Same `(physics_script_id, hook_idx)` will
    /// always resolve to the same hook across runs.
    pub hook_idx: u32,
    /// `PhysicsScriptData.start_time` — seconds since script-start at
    /// which this hook fires. ACE's `PhysicsScript.Process(elapsed)`
    /// fires when `elapsed >= start_time`. For the retail moon all
    /// three hooks have `start_time=0` (one-shot at script begin) per
    /// `particle::tests::three_create_particles_extracted_in_order`.
    pub start_time_s: f64,
    /// `0x32xxxxxx` ParticleEmitter DID — first 4 bytes of the hook
    /// payload. Same field the entity-particle bake extracts.
    pub emitter_id: u32,
    /// `true` iff the hook is `CreateBlockingParticle` (hook_type=26)
    /// rather than plain `CreateParticle` (hook_type=13). Mirrors the
    /// entity-particle bake's `blocking` flag.
    pub blocking: bool,
}

/// Where the PhysicsScript DID came from. Tags the record so the
/// validator can prioritise the runtime-matching path (sky_object) over
/// the SetupModel-fallback path (which retail never exercises).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScriptSource {
    /// `SkyObject.default_pes_object_id` was nonzero — the runtime
    /// chain. Retail Dereth's moon hits this path.
    SkyObject,
    /// `SkyObject.default_pes_object_id == 0` *and*
    /// `default_gfx_object_id` was a `0x02xxxxxx` SetupModel *and*
    /// `SetupModel.default_script` was `Some(_)`. Edge case; no retail
    /// SkyObject hits this.
    SetupModel,
}

impl ScriptSource {
    pub fn as_str(self) -> &'static str {
        match self {
            ScriptSource::SkyObject => "sky_object",
            ScriptSource::SetupModel => "setup_model",
        }
    }
}

/// Walk the sky particle chain for a Region. For each DayGroup, for
/// each SkyObject, resolve the PhysicsScript (via
/// `SkyObject.default_pes_object_id` first, falling back to
/// `SetupModel.default_script` when the SkyObject is a `0x02xxxxxx`
/// SetupModel with no direct PES reference), then enumerate every
/// CreateParticle / CreateBlockingParticle hook in the script.
///
/// # Arguments
///
/// - `region` — the parsed Region. If `region.sky_info` is `None`, the
///   function returns `Vec::new()`.
/// - `fetch_physics_script` — closure that resolves a `0x33xxxxxx` DID
///   to a parsed `PhysicsScript`. Returning `None` is treated as
///   "script not loadable" — the chain skips that SkyObject without
///   panicking. Mirrors the `bake_anim_sound_manifest`
///   `fetch_animation` convention.
/// - `fetch_setup_model` — closure that resolves a `0x02xxxxxx`
///   SetupModel DID. Only invoked when `default_pes_object_id == 0` and
///   `default_gfx_object_id` has the `0x02` prefix. Returning `None`
///   skips the SkyObject.
///
/// # Output ordering
///
/// Records are emitted in `(day_group_idx, sky_object_idx, hook_idx)`
/// ascending order — the same order they appear in the DAT.
pub fn enumerate_sky_particle_chain(
    region: &Region,
    mut fetch_physics_script: impl FnMut(u32) -> Option<PhysicsScript>,
    mut fetch_setup_model: impl FnMut(u32) -> Option<SetupModel>,
) -> Vec<SkyParticleTrigger> {
    let Some(sky_info) = region.sky_info.as_ref() else {
        return Vec::new();
    };

    let mut out: Vec<SkyParticleTrigger> = Vec::new();

    for (dg_idx, dg) in sky_info.day_groups.iter().enumerate() {
        for (so_idx, so) in dg.sky_objects.iter().enumerate() {
            // Resolve the PhysicsScript DID. Preference order matches
            // the runtime chain walker in sky_dome.js — direct
            // `default_pes_object_id` first, SetupModel fallback only
            // when the SkyObject is a 0x02 SetupModel and its
            // pes_object_id is zero.
            let (script_did, script_source) = if so.default_pes_object_id != 0 {
                (so.default_pes_object_id, ScriptSource::SkyObject)
            } else if (so.default_gfx_object_id >> 24) == 0x02 {
                // 0x02 SetupModel with no direct PES ref — try the
                // SetupModel's own default_script.
                let Some(setup) = fetch_setup_model(so.default_gfx_object_id) else {
                    continue;
                };
                let Some(setup_script) = setup.default_script else {
                    continue;
                };
                (setup_script, ScriptSource::SetupModel)
            } else {
                // 0x01 GfxObj with no PES — no particles. Common case
                // for the visible-only celestials (sun, base shells,
                // cloud bands).
                continue;
            };

            // Only walk if the resolved DID is in the PhysicsScript
            // namespace. A SetupModel.default_script pointing at the
            // PhysicsScriptTable namespace (0x34xxxxxx) would indicate
            // a mis-resolved chain — defensive skip.
            if (script_did >> 24) != 0x33 {
                continue;
            }

            let Some(ps) = fetch_physics_script(script_did) else {
                continue;
            };

            for (hook_idx, entry) in ps.script_data.iter().enumerate() {
                let blocking = match entry.hook.hook_type {
                    13 => false,
                    26 => true,
                    // Non-particle hooks (Sound, Attack, ...) live in
                    // sky-anchored PhysicsScripts too — they're orthogonal
                    // to this bake. The sky Sound hook path is wired by
                    // F.B.2's anim_sound enumerator at runtime via
                    // sky_dome.js::_attachParticleChainFromState's Sound
                    // arm; for the static manifest only particles are
                    // emitted here.
                    _ => continue,
                };
                if entry.hook.data.len() < 8 {
                    continue;
                }
                let emitter_id =
                    u32::from_le_bytes(entry.hook.data[0..4].try_into().unwrap());

                out.push(SkyParticleTrigger {
                    day_group_idx: dg_idx as u32,
                    day_group_name: dg.day_name.clone(),
                    day_group_chance: dg.chance_of_occur,
                    active_fraction_start: so.begin_time,
                    active_fraction_end: so.end_time,
                    sky_object_idx: so_idx as u32,
                    sky_object_id: so.default_gfx_object_id,
                    physics_script_id: script_did,
                    physics_script_source: script_source,
                    hook_idx: hook_idx as u32,
                    start_time_s: entry.start_time,
                    emitter_id,
                    blocking,
                });
            }
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_common::Vector3;
    use holtburger_dat::file_type::physics_script::{PhysicsScript, PhysicsScriptData};
    use holtburger_dat::file_type::region::{
        DayGroup, LandDefs, LandSurf, Region, SceneDesc, SkyDesc, SkyObject, TerrainDesc,
        TexMerge,
    };
    use holtburger_dat::file_type::setup_model::{AnimationHook, SetupModel};
    use holtburger_dat::file_type::GameTime;
    use std::collections::HashMap;

    fn create_particle_hook(emitter_id: u32) -> AnimationHook {
        let mut data = Vec::with_capacity(40);
        data.extend_from_slice(&emitter_id.to_le_bytes());
        data.extend_from_slice(&0u32.to_le_bytes());
        data.extend(std::iter::repeat(0u8).take(40 - 8));
        AnimationHook {
            hook_type: 13,
            direction: 0,
            data,
        }
    }

    fn blocking_particle_hook(emitter_id: u32) -> AnimationHook {
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

    fn synth_setup_model(id: u32, default_script: Option<u32>) -> SetupModel {
        SetupModel {
            id,
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
            default_script,
            default_motion_table: None,
            default_sound_table: None,
            default_script_table: None,
        }
    }

    fn synth_region(day_groups: Vec<DayGroup>) -> Region {
        Region {
            id: 0x13000000,
            region_number: 1,
            version: 0,
            region_name: "TestRegion".to_string(),
            parts_mask: 0,
            land_defs: LandDefs {
                num_block_length: 1,
                num_block_width: 1,
                square_length: 24.0,
                l_block_length: 8,
                vertex_per_cell: 9,
                max_obj_height: 200.0,
                sky_height: 1000.0,
                road_width: 5.0,
                land_height_table: vec![0.0; 256],
            },
            game_time: GameTime {
                zero_time_of_year: 0.0,
                zero_year: 0,
                day_length: 7620.0,
                days_per_year: 1,
                year_spec: String::new(),
                times_of_day: vec![],
                days_of_week: vec![],
                seasons: vec![],
            },
            sky_info: Some(SkyDesc {
                tick_size: 3.0,
                light_tick_size: 20.0,
                day_groups,
            }),
            sound_info: None,
            scene_info: Some(SceneDesc {
                scene_types: vec![],
            }),
            terrain_info: TerrainDesc {
                terrain_types: vec![],
                land_surfaces: LandSurf {
                    surf_type: 0,
                    tex_merge: TexMerge {
                        base_tex_size: 0,
                        corner_terrain_maps: vec![],
                        side_terrain_maps: vec![],
                        road_maps: vec![],
                        terrain_desc: vec![],
                    },
                },
            },
            region_misc: None,
        }
    }

    fn moon_day_group() -> DayGroup {
        // Mirrors retail Dereth's "Sunny" day group SkyObject[6] —
        // 0x02000714 SetupModel anchor paired with
        // default_pes_object_id 0x330007DB.
        DayGroup {
            chance_of_occur: 0.25,
            day_name: "Sunny".to_string(),
            sky_objects: vec![SkyObject {
                begin_time: 0.0,
                end_time: 1.0,
                begin_angle: 0.0,
                end_angle: std::f32::consts::PI * 2.0,
                tex_velocity_x: 0.0,
                tex_velocity_y: 0.0,
                default_gfx_object_id: 0x02000714,
                default_pes_object_id: 0x330007DB,
                properties: 0,
            }],
            sky_time: vec![],
        }
    }

    #[test]
    fn returns_empty_when_region_lacks_sky_info() {
        let mut r = synth_region(vec![]);
        r.sky_info = None;
        let out = enumerate_sky_particle_chain(&r, |_| None, |_| None);
        assert!(out.is_empty());
    }

    #[test]
    fn returns_empty_when_no_day_groups() {
        let r = synth_region(vec![]);
        let out = enumerate_sky_particle_chain(&r, |_| None, |_| None);
        assert!(out.is_empty());
    }

    #[test]
    fn retail_moon_chain_resolves_via_default_pes_object_id() {
        // The brief's example: 0x02000714 → 0x330007DB → 0x32000456.
        // First-resolution path is `default_pes_object_id` — the
        // SetupModel fallback should NOT be invoked.
        let r = synth_region(vec![moon_day_group()]);
        let mut setup_fetched = false;
        let mut script_fetched_did: Option<u32> = None;

        let out = enumerate_sky_particle_chain(
            &r,
            |did| {
                script_fetched_did = Some(did);
                if did == 0x330007DB {
                    Some(PhysicsScript {
                        id: 0x330007DB,
                        script_data: vec![
                            PhysicsScriptData {
                                start_time: 0.0,
                                hook: create_particle_hook(0x32000455),
                            },
                            PhysicsScriptData {
                                start_time: 0.0,
                                hook: create_particle_hook(0x32000456),
                            },
                            PhysicsScriptData {
                                start_time: 0.0,
                                hook: create_particle_hook(0x32000457),
                            },
                        ],
                    })
                } else {
                    None
                }
            },
            |_| {
                setup_fetched = true;
                None
            },
        );

        assert!(
            !setup_fetched,
            "SetupModel fallback must NOT be invoked when default_pes_object_id is nonzero"
        );
        assert_eq!(script_fetched_did, Some(0x330007DB));
        assert_eq!(out.len(), 3, "moon chain has 3 CreateParticle hooks");
        assert_eq!(out[0].emitter_id, 0x32000455);
        assert_eq!(out[1].emitter_id, 0x32000456);
        assert_eq!(out[2].emitter_id, 0x32000457);
        for t in &out {
            assert_eq!(t.day_group_idx, 0);
            assert_eq!(t.day_group_name, "Sunny");
            assert_eq!(t.sky_object_idx, 0);
            assert_eq!(t.sky_object_id, 0x02000714);
            assert_eq!(t.physics_script_id, 0x330007DB);
            assert_eq!(t.physics_script_source, ScriptSource::SkyObject);
            assert!(!t.blocking);
            assert!((t.start_time_s - 0.0).abs() < 1e-9);
        }
        // hook_idx is the per-record DAT order.
        assert_eq!(out[0].hook_idx, 0);
        assert_eq!(out[1].hook_idx, 1);
        assert_eq!(out[2].hook_idx, 2);
    }

    #[test]
    fn setup_model_fallback_resolves_when_pes_object_id_zero() {
        // 0x02 SetupModel SkyObject with pes_object_id == 0.
        // SetupModel.default_script = Some(0x33000ABC) — fallback path.
        let mut dg = moon_day_group();
        dg.sky_objects[0].default_pes_object_id = 0;
        let r = synth_region(vec![dg]);

        let out = enumerate_sky_particle_chain(
            &r,
            |did| {
                if did == 0x33000ABC {
                    Some(PhysicsScript {
                        id: 0x33000ABC,
                        script_data: vec![PhysicsScriptData {
                            start_time: 0.5,
                            hook: create_particle_hook(0x32000123),
                        }],
                    })
                } else {
                    None
                }
            },
            |did| {
                if did == 0x02000714 {
                    Some(synth_setup_model(0x02000714, Some(0x33000ABC)))
                } else {
                    None
                }
            },
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].physics_script_id, 0x33000ABC);
        assert_eq!(out[0].physics_script_source, ScriptSource::SetupModel);
        assert_eq!(out[0].emitter_id, 0x32000123);
        assert!((out[0].start_time_s - 0.5).abs() < 1e-9);
    }

    #[test]
    fn skips_sky_objects_with_no_chain() {
        // 0x01 GfxObj SkyObject (sun, cloud band, base shell) with no
        // PES — produces zero triggers.
        let dg = DayGroup {
            chance_of_occur: 1.0,
            day_name: "Clear".to_string(),
            sky_objects: vec![SkyObject {
                begin_time: 0.0,
                end_time: 1.0,
                begin_angle: 0.0,
                end_angle: 0.0,
                tex_velocity_x: 0.0,
                tex_velocity_y: 0.0,
                default_gfx_object_id: 0x01000123, // visible-only sun
                default_pes_object_id: 0,
                properties: 0,
            }],
            sky_time: vec![],
        };
        let r = synth_region(vec![dg]);
        let mut physics_fetched = false;
        let mut setup_fetched = false;
        let out = enumerate_sky_particle_chain(
            &r,
            |_| {
                physics_fetched = true;
                None
            },
            |_| {
                setup_fetched = true;
                None
            },
        );
        assert!(out.is_empty());
        assert!(
            !physics_fetched,
            "0x01 GfxObj without PES should not invoke fetch_physics_script"
        );
        assert!(
            !setup_fetched,
            "0x01 GfxObj should not invoke fetch_setup_model fallback"
        );
    }

    #[test]
    fn non_particle_hooks_are_skipped() {
        let r = synth_region(vec![moon_day_group()]);
        let out = enumerate_sky_particle_chain(
            &r,
            |_| {
                Some(PhysicsScript {
                    id: 0x330007DB,
                    script_data: vec![
                        // Sound hook — hook_type=1 — skipped.
                        PhysicsScriptData {
                            start_time: 0.0,
                            hook: AnimationHook {
                                hook_type: 1,
                                direction: 0,
                                data: vec![0, 1, 0, 0],
                            },
                        },
                        // CreateParticle — emitted.
                        PhysicsScriptData {
                            start_time: 0.1,
                            hook: create_particle_hook(0x32000ABC),
                        },
                        // CreateBlockingParticle — emitted with
                        // blocking=true.
                        PhysicsScriptData {
                            start_time: 0.2,
                            hook: blocking_particle_hook(0x32000DEF),
                        },
                    ],
                })
            },
            |_| None,
        );
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].emitter_id, 0x32000ABC);
        assert!(!out[0].blocking);
        assert_eq!(out[0].hook_idx, 1, "hook_idx is DAT index, not emit index");
        assert_eq!(out[1].emitter_id, 0x32000DEF);
        assert!(out[1].blocking);
        assert_eq!(out[1].hook_idx, 2);
    }

    #[test]
    fn multiple_day_groups_each_walk_independently() {
        // Two day groups, each with one SkyObject with one
        // CreateParticle hook → 2 triggers, day_group_idx 0 and 1.
        let dg0 = moon_day_group();
        let mut dg1 = moon_day_group();
        dg1.day_name = "PartlyCloudy".to_string();
        dg1.sky_objects[0].default_pes_object_id = 0x33001234;
        let r = synth_region(vec![dg0, dg1]);
        let out = enumerate_sky_particle_chain(
            &r,
            |did| {
                let emitter = if did == 0x330007DB {
                    0x32000456
                } else if did == 0x33001234 {
                    0x32009999
                } else {
                    return None;
                };
                Some(PhysicsScript {
                    id: did,
                    script_data: vec![PhysicsScriptData {
                        start_time: 0.0,
                        hook: create_particle_hook(emitter),
                    }],
                })
            },
            |_| None,
        );
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].day_group_idx, 0);
        assert_eq!(out[0].day_group_name, "Sunny");
        assert_eq!(out[0].emitter_id, 0x32000456);
        assert_eq!(out[1].day_group_idx, 1);
        assert_eq!(out[1].day_group_name, "PartlyCloudy");
        assert_eq!(out[1].emitter_id, 0x32009999);
    }

    #[test]
    fn dat_order_preserved_across_day_groups_sky_objects_hooks() {
        // Ordering invariant: (day_group_idx, sky_object_idx, hook_idx)
        // ascending. Build a region where each level has 2 entries and
        // verify the emit order is the canonical 8-record sequence.
        let mk_dg = |name: &str, pes_a: u32, pes_b: u32| DayGroup {
            chance_of_occur: 0.5,
            day_name: name.to_string(),
            sky_objects: vec![
                SkyObject {
                    begin_time: 0.0,
                    end_time: 1.0,
                    begin_angle: 0.0,
                    end_angle: 0.0,
                    tex_velocity_x: 0.0,
                    tex_velocity_y: 0.0,
                    default_gfx_object_id: 0x01000100,
                    default_pes_object_id: pes_a,
                    properties: 0,
                },
                SkyObject {
                    begin_time: 0.0,
                    end_time: 1.0,
                    begin_angle: 0.0,
                    end_angle: 0.0,
                    tex_velocity_x: 0.0,
                    tex_velocity_y: 0.0,
                    default_gfx_object_id: 0x01000200,
                    default_pes_object_id: pes_b,
                    properties: 0,
                },
            ],
            sky_time: vec![],
        };
        let r = synth_region(vec![
            mk_dg("Sunny", 0x33000001, 0x33000002),
            mk_dg("Cloudy", 0x33000003, 0x33000004),
        ]);
        // Each script has 2 hooks → 8 records total.
        let out = enumerate_sky_particle_chain(
            &r,
            |did| {
                let base = (did & 0xFFFF) as u32;
                Some(PhysicsScript {
                    id: did,
                    script_data: vec![
                        PhysicsScriptData {
                            start_time: 0.0,
                            hook: create_particle_hook(0x3200_0000 | (base * 0x10)),
                        },
                        PhysicsScriptData {
                            start_time: 0.0,
                            hook: create_particle_hook(0x3200_0001 | (base * 0x10)),
                        },
                    ],
                })
            },
            |_| None,
        );
        assert_eq!(out.len(), 8);
        // First 4 records are from DayGroup 0; last 4 from DayGroup 1.
        for (i, t) in out.iter().enumerate() {
            let expected_dg = (i / 4) as u32;
            let expected_so = ((i / 2) % 2) as u32;
            let expected_hook = (i % 2) as u32;
            assert_eq!(t.day_group_idx, expected_dg, "i={i}");
            assert_eq!(t.sky_object_idx, expected_so, "i={i}");
            assert_eq!(t.hook_idx, expected_hook, "i={i}");
        }
    }

    #[test]
    fn determinism_repeated_call() {
        let r = synth_region(vec![moon_day_group()]);
        let build_ps = || PhysicsScript {
            id: 0x330007DB,
            script_data: vec![
                PhysicsScriptData {
                    start_time: 0.0,
                    hook: create_particle_hook(0x32000455),
                },
                PhysicsScriptData {
                    start_time: 0.0,
                    hook: create_particle_hook(0x32000456),
                },
            ],
        };
        let a = enumerate_sky_particle_chain(
            &r,
            |did| (did == 0x330007DB).then(build_ps),
            |_| None,
        );
        let b = enumerate_sky_particle_chain(
            &r,
            |did| (did == 0x330007DB).then(build_ps),
            |_| None,
        );
        assert_eq!(a, b);
        assert_eq!(a.len(), 2);
    }

    #[test]
    fn script_source_as_str() {
        assert_eq!(ScriptSource::SkyObject.as_str(), "sky_object");
        assert_eq!(ScriptSource::SetupModel.as_str(), "setup_model");
    }

    #[test]
    fn missing_physics_script_skipped_not_panicked() {
        let r = synth_region(vec![moon_day_group()]);
        // fetch_physics_script always returns None — broken DAT scenario.
        let out = enumerate_sky_particle_chain(&r, |_| None, |_| None);
        assert!(out.is_empty());
    }

    #[test]
    fn rejects_non_physics_script_did_in_default_script_fallback() {
        // SetupModel.default_script points at 0x34xxxxxx (PhysicsScriptTable
        // namespace) rather than 0x33xxxxxx (PhysicsScript). Defensive
        // skip — no fetch_physics_script call attempted.
        let mut dg = moon_day_group();
        dg.sky_objects[0].default_pes_object_id = 0;
        let r = synth_region(vec![dg]);
        let mut ps_fetched = false;
        let out = enumerate_sky_particle_chain(
            &r,
            |_| {
                ps_fetched = true;
                None
            },
            |did| {
                if did == 0x02000714 {
                    Some(synth_setup_model(0x02000714, Some(0x34000123)))
                } else {
                    None
                }
            },
        );
        assert!(out.is_empty());
        assert!(
            !ps_fetched,
            "non-0x33 default_script should not trigger fetch_physics_script"
        );
    }
}
