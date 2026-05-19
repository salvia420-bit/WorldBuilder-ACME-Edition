//! **Single-LB wrapper** — bundle the four sub-bakes (ambient, anim,
//! particle, sky-chain) into one [`LandblockEventBake`] for a single
//! landblock.
//!
//! This is the F.B caller-facing entry point: open the DATs, resolve
//! the landblock's expected entities, walk every event-trigger source,
//! return a deterministic struct. The `event-bake` CLI calls into the
//! same primitives the per-LB loop in
//! `apps/holtburger-tools/src/bin/event-bake.rs` walks; this module
//! lifts that orchestration into the library so consumers without the
//! spawns-JSONL staging step can still bake from raw DATs.
//!
//! # Determinism contract
//!
//! [`bake_landblock_events`] is deterministic in `(lb_id, dat_dir,
//! region_did)`. Same inputs, byte-identical output, every time.
//! See `tests/determinism_100x.rs` for the 100-iteration stress test.
//!
//! Sources of non-determinism we eliminate:
//! - HashMap iteration → collect-then-sort everywhere
//! - PartialOrd on f32 → never used; comparisons go through `.to_bits()`
//! - Floating-point drift → no derived computations, all values are
//!   verbatim DAT bytes (CreateParticle payload, AmbientSoundDesc, etc.)
//!
//! # Entity enumeration
//!
//! Expected entities for a landblock come from one of two sources:
//!
//! 1. **DAT-only** ([`EntitySource::LandblockInfo`]) — the cell.dat's
//!    `LandblockInfo` Stab list (`<lbHex>FFFE`). One Stab per static
//!    object placed by ACE's content tool; `Stab.id` is the SetupModel
//!    DID directly. No spawns-JSONL needed — works from a clean DAT
//!    dump. This is the F.B caller default.
//! 2. **Spawns JSONL** ([`EntitySource::SpawnsManifest`]) — Phase D.1's
//!    `<lbHex>.spawns.jsonl` + `wcid_to_setup.json` mapping. Includes
//!    dynamic spawns (server-managed wcids) that aren't in the static
//!    LandblockInfo (NPCs, monsters, vendor stock). Same path the
//!    binary uses for the ring-bake.
//!
//! Both sources produce the same `Vec<u32>` of unique setup DIDs ahead
//! of the anim/particle sub-bakes — the bakes themselves don't care
//! which source produced the list.

use crate::ambient::AmbientTrigger;
use crate::anim_sound::AnimSoundTrigger;
use crate::particle::PhysicsScriptParticleTrigger;
use crate::sky_chain::SkyParticleTrigger;
use crate::{
    bake_ambient_manifest, bake_anim_sound_manifest, bake_particle_manifest,
    enumerate_sky_particle_chain,
};
use binrw::io::Cursor;
use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::{Animation, MotionTable, PhysicsScript, Region, SetupModel};
use holtburger_dat::landblock::{CellLandblock, LandblockInfo};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Default Region DID for retail Dereth.
pub const DEFAULT_REGION_DID: u32 = 0x1300_0000;

/// The unified expected-events bake for one landblock. All four event
/// categories the validator cares about — three of them per-LB, the
/// sky chain region-scoped but reported alongside for correlation.
///
/// # Per-LB count expectations (measured against retail Holtburg 0xA9B4)
///
/// - `ambient_terrain_events.len()` — 9 unique `(terrain_type,
///   scene_type)` combinations cover the LB's 81 vertices.
/// - `anim_hook_events.len()` — **0** for Holtburg. Static placements
///   are doors / statues / storefronts / one bind stone; only the
///   bind stone has a MotionTable, and that MotionTable doesn't carry
///   any Sound or SoundTweaked hooks. LBs with animated NPCs (the
///   Academy 0x8602, monster-heavy dungeons) will be > 0. Synthesised
///   `anim_sound::tests` cover the > 0 path.
/// - `physics_particle_events.len()` — Holtburg LandblockInfo path: 3
///   (the destroyed portal at 27.325/137.487/66.5). Spawns-manifest
///   path: 20 (additional NPCs/monsters carry CreateParticle hooks).
/// - `sky_particle_events.len()` — 82 for Region 0x13's full sky
///   chain (the moon contributes 3 of these).
///
/// # Field ordering
///
/// Each `Vec<_>` is sorted by a stable key:
///
/// | Field                     | Sort key                                |
/// |---------------------------|-----------------------------------------|
/// | `ambient_terrain_events`  | `(terrain_type, scene_type)`            |
/// | `anim_hook_events`        | `(csetup_id, motion_key, animation_did, hook_frame, hook_type)` |
/// | `physics_particle_events` | `(default_script_id, emitter_id, start_time.to_bits())` |
/// | `sky_particle_events`     | `(day_group_idx, sky_object_idx, hook_idx)` |
///
/// Same sort across runs → byte-identical JSONL.
#[derive(Debug, Clone, PartialEq)]
pub struct LandblockEventBake {
    /// Packed landblock id (`(lbX << 24) | (lbY << 16)`). Matches the
    /// `landblock_id` argument the scenery bake takes.
    pub landblock_id: u32,
    /// Region DID this bake was sourced from. Stamped onto the struct
    /// so the JSONL writer can include it on every record without
    /// re-passing through the bake API.
    pub region_did: u32,
    /// **S1** — Region-driven per-terrain ambient sounds. One record
    /// per unique `(terrain_type, scene_type)` combination present on
    /// the LB's 81 vertices, with `stb_index >= 0`.
    pub ambient_terrain_events: Vec<AmbientTrigger>,
    /// **S2** — Sound + SoundTweaked hooks embedded in entity
    /// animation clips. One record per `(csetup, motion, frame,
    /// hook_type)`. Deduped across spawns that share the same
    /// SetupModel (the runtime fires per-instance; the manifest is a
    /// per-csetup contract).
    pub anim_hook_events: Vec<AnimSoundTrigger>,
    /// **P1** — CreateParticle + CreateBlockingParticle hooks in
    /// entities' default PhysicsScripts. One record per
    /// `(default_script_id, hook_idx)`. Deduped across spawns that
    /// share the same PhysicsScript.
    pub physics_particle_events: Vec<PhysicsScriptParticleTrigger>,
    /// **P2** — Sky chain (Region SkyObject → PhysicsScript →
    /// CreateParticle). Region-scoped, but reported per-LB so the
    /// validator can correlate against per-frame visibility (the
    /// runtime fires sky hooks against the sky cell that follows the
    /// camera; that cell is bound to whatever LB the camera is over).
    pub sky_particle_events: Vec<SkyParticleTrigger>,
}

impl LandblockEventBake {
    /// Total event records across all four categories. Convenience for
    /// the report's "N events total" line.
    pub fn total_events(&self) -> usize {
        self.ambient_terrain_events.len()
            + self.anim_hook_events.len()
            + self.physics_particle_events.len()
            + self.sky_particle_events.len()
    }

    /// Serialize the bake to deterministic JSONL bytes — the same
    /// shape the `event-bake` CLI writes. One line per record; line
    /// ordering matches the field's sort key.
    ///
    /// This is the canonical "byte-identical across runs" representation
    /// for determinism testing. The struct itself compares by Eq, but
    /// the JSONL bytes pin formatting (f32 → `{:.6}`, etc) too.
    pub fn to_jsonl_bytes(&self) -> Vec<u8> {
        let mut out: Vec<u8> = Vec::new();
        for t in &self.ambient_terrain_events {
            write_ambient_line(&mut out, t);
        }
        for t in &self.anim_hook_events {
            write_anim_hook_line(&mut out, t);
        }
        for t in &self.physics_particle_events {
            write_particle_line(&mut out, t);
        }
        for t in &self.sky_particle_events {
            write_sky_particle_line(&mut out, t);
        }
        out
    }
}

/// Where the per-LB expected-entity list comes from. The bake handles
/// both; pick the one whose inputs are available.
#[derive(Debug, Clone)]
pub enum EntitySource {
    /// Read `cell.dat`'s `<lbHex>FFFE` `LandblockInfo` and use its
    /// `objects` Stab list (each `Stab.id` is a SetupModel DID). No
    /// extra inputs needed — works from a clean DAT dump. Default
    /// path for the F.B caller.
    LandblockInfo,
    /// Read a Phase D.1 spawns JSONL (`<lbHex>.spawns.jsonl`) and
    /// resolve `wcid → setup` via the supplied table. Catches
    /// server-managed dynamic spawns that aren't in `LandblockInfo`.
    SpawnsManifest {
        /// Directory containing per-LB `<lbHex>.spawns.jsonl` files.
        spawns_dir: PathBuf,
        /// Path to the wcid → SetupModel DID map.
        setup_table_path: PathBuf,
    },
}

/// Inputs for [`bake_landblock_events`]. Bundling them in a struct
/// keeps the API stable when we add follow-on knobs (entity source,
/// inclusion filters, etc.) without breaking call sites.
#[derive(Debug, Clone)]
pub struct BakeInputs {
    /// Landblock id (packed, e.g. `0xA9B4_0000` for Holtburg).
    pub landblock_id: u32,
    /// Directory containing `client_portal.dat` + `client_cell_1.dat`.
    pub dat_dir: PathBuf,
    /// Region DID. Defaults to [`DEFAULT_REGION_DID`] for retail
    /// Dereth.
    pub region_did: u32,
    /// Where to source the expected-entity list. See [`EntitySource`].
    pub entity_source: EntitySource,
    /// Include the region-scoped sky particle chain in the per-LB
    /// bake. `true` for full F.B coverage. Set `false` when bulk-
    /// baking many LBs and the sky chain is staged separately.
    pub include_sky_chain: bool,
}

impl BakeInputs {
    /// Construct inputs for the canonical "open a DAT dir and bake one
    /// LB" path used by the task spec. Defaults to LandblockInfo-only
    /// entity enumeration and sky-chain inclusion.
    pub fn from_dat_dir<P: Into<PathBuf>>(landblock_id: u32, dat_dir: P) -> Self {
        Self {
            landblock_id,
            dat_dir: dat_dir.into(),
            region_did: DEFAULT_REGION_DID,
            entity_source: EntitySource::LandblockInfo,
            include_sky_chain: true,
        }
    }
}

/// Errors the wrapper bake can return.
///
/// Distinct from `binrw::Error` / `holtburger_dat::DatError` because we
/// want callers to discriminate on "this LB doesn't exist" vs "the
/// portal.dat parse blew up" without string-matching.
#[derive(Debug)]
pub enum BakeError {
    DatOpen {
        which: &'static str,
        path: PathBuf,
        source: holtburger_dat::DatError,
    },
    FileMissing {
        which: &'static str,
        id: u32,
    },
    Parse {
        which: &'static str,
        id: u32,
        source: String,
    },
    SetupTable {
        path: PathBuf,
        message: String,
    },
}

impl std::fmt::Display for BakeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BakeError::DatOpen { which, path, source } => {
                write!(f, "open {} at {}: {}", which, path.display(), source)
            }
            BakeError::FileMissing { which, id } => {
                write!(f, "{which} 0x{id:08X} missing from DAT")
            }
            BakeError::Parse { which, id, source } => {
                write!(f, "parse {which} 0x{id:08X}: {source}")
            }
            BakeError::SetupTable { path, message } => {
                write!(f, "setup-table {}: {}", path.display(), message)
            }
        }
    }
}

impl std::error::Error for BakeError {}

/// Bake the expected-events manifest for a single landblock.
///
/// # Determinism
///
/// The output struct is deterministic in `inputs`. See
/// `tests/determinism_100x.rs` for the 100-iteration byte-equality
/// stress test against real Holtburg LB 0xA9B4.
///
/// # The task-spec signature
///
/// The task brief lists `bake_landblock_events(lb_id: u32, dat_dir:
/// &Path) -> LandblockEventBake`. That convenience shape is provided
/// by [`bake_landblock_events_simple`], which builds default
/// [`BakeInputs`] (LandblockInfo entity source, sky chain ON) and
/// calls into this function.
pub fn bake_landblock_events(inputs: &BakeInputs) -> Result<LandblockEventBake, BakeError> {
    let portal_path = inputs.dat_dir.join("client_portal.dat");
    let cell_path = inputs.dat_dir.join("client_cell_1.dat");
    let portal = DatDatabase::new(&portal_path).map_err(|e| BakeError::DatOpen {
        which: "client_portal.dat",
        path: portal_path.clone(),
        source: e,
    })?;
    let cell = DatDatabase::new(&cell_path).map_err(|e| BakeError::DatOpen {
        which: "client_cell_1.dat",
        path: cell_path.clone(),
        source: e,
    })?;

    let region = load_region(&portal, inputs.region_did)?;
    let cell_landblock = load_cell_landblock(&cell, inputs.landblock_id)?;
    let setup_dids = resolve_setup_dids(&portal, &cell, inputs)?;

    let ambient_terrain_events = bake_ambient_manifest(&region, &cell_landblock, inputs.landblock_id);

    let (mut anim_hook_events, mut physics_particle_events) =
        bake_entity_event_arms(&portal, &setup_dids);

    // Final sort guarantees both vecs are in the documented order even
    // if a sub-bake's internal ordering ever changes. Cheap because
    // the inner bakes already emit in (mostly) the right order.
    anim_hook_events.sort_by(|a, b| {
        (
            a.csetup_id,
            a.motion_key,
            a.animation_did,
            a.hook_frame,
            a.hook_type,
        )
            .cmp(&(
                b.csetup_id,
                b.motion_key,
                b.animation_did,
                b.hook_frame,
                b.hook_type,
            ))
    });
    physics_particle_events.sort_by(|a, b| {
        (
            a.default_script_id,
            a.emitter_id,
            a.start_time_s.to_bits(),
            a.part_index,
            a.blocking as u8,
        )
            .cmp(&(
                b.default_script_id,
                b.emitter_id,
                b.start_time_s.to_bits(),
                b.part_index,
                b.blocking as u8,
            ))
    });

    let sky_particle_events = if inputs.include_sky_chain {
        bake_sky_arm(&portal, &region)
    } else {
        Vec::new()
    };

    Ok(LandblockEventBake {
        landblock_id: inputs.landblock_id,
        region_did: inputs.region_did,
        ambient_terrain_events,
        anim_hook_events,
        physics_particle_events,
        sky_particle_events,
    })
}

/// Task-spec convenience wrapper — matches the brief's
/// `bake_landblock_events(lb_id, dat_dir)` signature. Builds default
/// [`BakeInputs`] (LandblockInfo entity source, sky chain ON, retail
/// Region DID) and forwards.
pub fn bake_landblock_events_simple(
    lb_id: u32,
    dat_dir: &Path,
) -> Result<LandblockEventBake, BakeError> {
    bake_landblock_events(&BakeInputs::from_dat_dir(lb_id, dat_dir))
}

fn load_region(portal: &DatDatabase, region_did: u32) -> Result<Region, BakeError> {
    let bytes = portal.get_file(region_did).map_err(|_| BakeError::FileMissing {
        which: "Region",
        id: region_did,
    })?;
    let mut cursor = Cursor::new(&bytes);
    Region::unpack(&mut cursor).map_err(|e| BakeError::Parse {
        which: "Region",
        id: region_did,
        source: e.to_string(),
    })
}

fn load_cell_landblock(cell: &DatDatabase, landblock_id: u32) -> Result<CellLandblock, BakeError> {
    // CellLandblock id = landblock_id | 0xFFFF (e.g. 0xA9B4_FFFF for
    // Holtburg LB 0xA9B4).
    let cell_id = (landblock_id & 0xFFFF_0000) | 0xFFFF;
    let bytes = cell.get_file(cell_id).map_err(|_| BakeError::FileMissing {
        which: "CellLandblock",
        id: cell_id,
    })?;
    CellLandblock::unpack(&bytes).map_err(|e| BakeError::Parse {
        which: "CellLandblock",
        id: cell_id,
        source: e.to_string(),
    })
}

/// Resolve the per-LB unique-setup-DID list ahead of the anim/particle
/// sub-bakes. Output is sorted ascending for determinism.
fn resolve_setup_dids(
    portal: &DatDatabase,
    cell: &DatDatabase,
    inputs: &BakeInputs,
) -> Result<Vec<u32>, BakeError> {
    let mut setups: Vec<u32> = Vec::new();
    match &inputs.entity_source {
        EntitySource::LandblockInfo => {
            // LandblockInfo id = landblock_id | 0xFFFE. Missing is
            // valid (LBs with no static objects don't have one);
            // treat as empty.
            let info_id = (inputs.landblock_id & 0xFFFF_0000) | 0xFFFE;
            if let Ok(bytes) = cell.get_file(info_id) {
                let info = LandblockInfo::unpack(&bytes).map_err(|e| BakeError::Parse {
                    which: "LandblockInfo",
                    id: info_id,
                    source: e.to_string(),
                })?;
                for stab in &info.objects {
                    // Stab.id is the SetupModel DID (`0x02xxxxxx`).
                    // Defensive: only walk if it parses as one — non-
                    // 0x02 ids would indicate a corrupted DAT.
                    if (stab.id >> 24) == 0x02 && resolves_to_setup_model(portal, stab.id) {
                        setups.push(stab.id);
                    }
                }
            }
        }
        EntitySource::SpawnsManifest {
            spawns_dir,
            setup_table_path,
        } => {
            let table = load_wcid_to_setup(setup_table_path)?;
            let spawn_path =
                spawns_dir.join(format!("0x{:04X}.spawns.jsonl", inputs.landblock_id >> 16));
            if let Ok(text) = std::fs::read_to_string(&spawn_path) {
                for line in text.lines() {
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }
                    let v: serde_json::Value = match serde_json::from_str(line) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    let wcid = match v.get("wcid").and_then(|x| x.as_u64()) {
                        Some(w) => w as u32,
                        None => continue,
                    };
                    if let Some(&setup) = table.get(&wcid) {
                        setups.push(setup);
                    }
                }
            }
        }
    }
    setups.sort();
    setups.dedup();
    Ok(setups)
}

/// Verify that the DAT actually has the SetupModel for this DID. Used
/// to filter out Stab entries that point at envCells / 0x02 records
/// the parser doesn't accept (defensive).
fn resolves_to_setup_model(portal: &DatDatabase, did: u32) -> bool {
    portal.get_file(did).is_ok()
}

fn load_wcid_to_setup(path: &Path) -> Result<HashMap<u32, u32>, BakeError> {
    let bytes = std::fs::read(path).map_err(|e| BakeError::SetupTable {
        path: path.to_path_buf(),
        message: format!("read: {e}"),
    })?;
    let raw: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| BakeError::SetupTable {
        path: path.to_path_buf(),
        message: format!("parse json: {e}"),
    })?;
    let obj = raw.as_object().ok_or_else(|| BakeError::SetupTable {
        path: path.to_path_buf(),
        message: "top-level is not an object".to_string(),
    })?;
    let mut out: HashMap<u32, u32> = HashMap::with_capacity(obj.len());
    for (k, v) in obj {
        let Ok(wcid) = k.parse::<u32>() else { continue };
        let Some(setup) = v.as_u64() else { continue };
        let Ok(setup_u32) = u32::try_from(setup) else {
            continue;
        };
        out.insert(wcid, setup_u32);
    }
    Ok(out)
}

/// Run the anim_sound + particle sub-bakes for one LB's entity list.
/// Shared private helper so the resource caches are scoped to this
/// call.
fn bake_entity_event_arms(
    portal: &DatDatabase,
    setup_dids: &[u32],
) -> (Vec<AnimSoundTrigger>, Vec<PhysicsScriptParticleTrigger>) {
    let mut anim: Vec<AnimSoundTrigger> = Vec::new();
    let mut particle: Vec<PhysicsScriptParticleTrigger> = Vec::new();
    let mut animation_cache: HashMap<u32, Option<Animation>> = HashMap::new();

    for &setup_did in setup_dids {
        let Some(setup) = load_setup_model(portal, setup_did) else {
            continue;
        };

        if let Some(mt_did) = setup.default_motion_table {
            if let Some(mt) = load_motion_table(portal, mt_did) {
                // Pre-seed the animation cache so the closure doesn't
                // hammer the DAT for the same anim_id 100× (motion
                // tables often re-use animations across cycles).
                pre_seed_animation_cache(portal, &mt, &mut animation_cache);
                let lookup = |did: u32| animation_cache.get(&did).cloned().flatten();
                let mut t = bake_anim_sound_manifest(setup_did, &setup, &mt, lookup);
                anim.append(&mut t);
            }
        }

        if let Some(script_did) = setup.default_script {
            if let Some(ps) = load_physics_script(portal, script_did) {
                let mut t = bake_particle_manifest(script_did, &ps);
                particle.append(&mut t);
            }
        }
    }

    // Dedupe by full record — two spawns of the same NPC produce the
    // same (csetup_id, motion, frame) records.
    anim.sort_by(|a, b| {
        (
            a.csetup_id,
            a.motion_key,
            a.animation_did,
            a.hook_frame,
            a.hook_type,
        )
            .cmp(&(
                b.csetup_id,
                b.motion_key,
                b.animation_did,
                b.hook_frame,
                b.hook_type,
            ))
    });
    anim.dedup();

    particle.sort_by(|a, b| {
        (
            a.default_script_id,
            a.emitter_id,
            a.start_time_s.to_bits(),
            a.part_index,
            a.blocking as u8,
        )
            .cmp(&(
                b.default_script_id,
                b.emitter_id,
                b.start_time_s.to_bits(),
                b.part_index,
                b.blocking as u8,
            ))
    });
    particle.dedup();

    (anim, particle)
}

fn pre_seed_animation_cache(
    portal: &DatDatabase,
    mt: &MotionTable,
    cache: &mut HashMap<u32, Option<Animation>>,
) {
    let mut dids: Vec<u32> = Vec::new();
    for md in mt.cycles.values() {
        for a in &md.anims {
            dids.push(a.anim_id);
        }
    }
    for md in mt.modifiers.values() {
        for a in &md.anims {
            dids.push(a.anim_id);
        }
    }
    for inner in mt.links.values() {
        for md in inner.values() {
            for a in &md.anims {
                dids.push(a.anim_id);
            }
        }
    }
    dids.sort();
    dids.dedup();
    for d in dids {
        if !cache.contains_key(&d) {
            let r = load_animation(portal, d);
            cache.insert(d, r);
        }
    }
}

fn load_setup_model(portal: &DatDatabase, did: u32) -> Option<SetupModel> {
    portal
        .get_file(did)
        .ok()
        .and_then(|b| SetupModel::read(&mut Cursor::new(&b)).ok())
}

fn load_motion_table(portal: &DatDatabase, did: u32) -> Option<MotionTable> {
    portal
        .get_file(did)
        .ok()
        .and_then(|b| MotionTable::read(&mut Cursor::new(&b)).ok())
}

fn load_animation(portal: &DatDatabase, did: u32) -> Option<Animation> {
    portal
        .get_file(did)
        .ok()
        .and_then(|b| Animation::read(&mut Cursor::new(&b)).ok())
}

fn load_physics_script(portal: &DatDatabase, did: u32) -> Option<PhysicsScript> {
    portal
        .get_file(did)
        .ok()
        .and_then(|b| PhysicsScript::read(&mut Cursor::new(&b)).ok())
}

fn bake_sky_arm(portal: &DatDatabase, region: &Region) -> Vec<SkyParticleTrigger> {
    // Pre-seed both lookup caches so the enumerator's closures are
    // pure in-memory reads. Avoids borrow-checker complications around
    // sharing one cache across two FnMut closures.
    let mut ps_cache: HashMap<u32, Option<PhysicsScript>> = HashMap::new();
    let mut setup_cache: HashMap<u32, Option<SetupModel>> = HashMap::new();

    if let Some(sky_info) = region.sky_info.as_ref() {
        for dg in &sky_info.day_groups {
            for so in &dg.sky_objects {
                if so.default_pes_object_id != 0 {
                    if !ps_cache.contains_key(&so.default_pes_object_id) {
                        let r = load_physics_script(portal, so.default_pes_object_id);
                        ps_cache.insert(so.default_pes_object_id, r);
                    }
                } else if (so.default_gfx_object_id >> 24) == 0x02 {
                    if !setup_cache.contains_key(&so.default_gfx_object_id) {
                        let r = load_setup_model(portal, so.default_gfx_object_id);
                        if let Some(ref setup) = r {
                            if let Some(script_did) = setup.default_script {
                                if (script_did >> 24) == 0x33 && !ps_cache.contains_key(&script_did)
                                {
                                    let ps = load_physics_script(portal, script_did);
                                    ps_cache.insert(script_did, ps);
                                }
                            }
                        }
                        setup_cache.insert(so.default_gfx_object_id, r);
                    }
                }
            }
        }
    }

    enumerate_sky_particle_chain(
        region,
        |did| ps_cache.get(&did).cloned().flatten(),
        |did| setup_cache.get(&did).cloned().flatten(),
    )
}

// ---------------------------------------------------------------------------
// JSONL serialisers — deterministic, six-digit f32 formatting.
//
// These mirror the binary's writers verbatim but emit into a `Vec<u8>`
// (vs `BufWriter<File>`) so the library can produce the canonical
// byte representation for determinism testing without filesystem I/O.
// ---------------------------------------------------------------------------

/// Format an f32 with six digits after the decimal. Locale-free, no
/// negative-zero divergence.
fn fmt_f32(v: f32) -> String {
    let v = if v == 0.0 { 0.0 } else { v };
    format!("{:.6}", v)
}

fn fmt_f64(v: f64) -> String {
    let v = if v == 0.0 { 0.0 } else { v };
    format!("{:.6}", v)
}

fn write_ambient_line(out: &mut Vec<u8>, t: &AmbientTrigger) {
    let mut sounds = String::new();
    sounds.push('[');
    for (i, s) in t.ambient_sounds.iter().enumerate() {
        if i > 0 {
            sounds.push(',');
        }
        sounds.push_str(&format!(
            "{{\"s_type\":{},\"volume\":{},\"base_chance\":{},\"min_rate\":{},\"max_rate\":{},\"continuous\":{}}}",
            s.s_type,
            fmt_f32(s.volume),
            fmt_f32(s.base_chance),
            fmt_f32(s.min_rate),
            fmt_f32(s.max_rate),
            s.continuous,
        ));
    }
    sounds.push(']');
    let mut verts = String::new();
    verts.push('[');
    for (i, v) in t.vertex_indices.iter().enumerate() {
        if i > 0 {
            verts.push(',');
        }
        verts.push_str(&v.to_string());
    }
    verts.push(']');
    out.extend_from_slice(
        format!(
            "{{\"source\":\"ambient\",\"trigger\":\"terrain\",\"terrain_type\":{},\"scene_type\":{},\"scene_info_idx\":{},\"stb_index\":{},\"stb_id\":\"0x{:08X}\",\"vertex_indices\":{},\"ambient_sounds\":{}}}\n",
            t.terrain_type,
            t.scene_type,
            t.scene_info_idx,
            t.stb_index,
            t.stb_id,
            verts,
            sounds,
        )
            .as_bytes(),
    );
}

fn write_anim_hook_line(out: &mut Vec<u8>, t: &AnimSoundTrigger) {
    let link_outer = match t.link_outer_key {
        Some(k) => k.to_string(),
        None => "null".to_string(),
    };
    out.extend_from_slice(
        format!(
            "{{\"source\":\"animation_sound\",\"trigger\":\"animation_sound\",\"csetup_id\":\"0x{:08X}\",\"motion_table_id\":\"0x{:08X}\",\"motion_key\":\"0x{:08X}\",\"motion_kind\":{},\"link_outer_key\":{},\"is_default_stance\":{},\"animation_did\":\"0x{:08X}\",\"hook_frame\":{},\"hook_type\":{},\"sound_id\":{},\"priority\":{},\"probability\":{},\"volume\":{}}}\n",
            t.csetup_id,
            t.motion_table_id,
            t.motion_key,
            t.motion_kind,
            link_outer,
            t.is_default_stance,
            t.animation_did,
            t.hook_frame,
            t.hook_type,
            t.sound_id,
            fmt_f32(t.priority),
            fmt_f32(t.probability),
            fmt_f32(t.volume),
        )
            .as_bytes(),
    );
}

fn write_particle_line(out: &mut Vec<u8>, t: &PhysicsScriptParticleTrigger) {
    out.extend_from_slice(
        format!(
            "{{\"source\":\"physics_script_particle\",\"trigger\":\"physics_script_particle\",\"default_script_id\":\"0x{:08X}\",\"start_time_s\":{},\"emitter_id\":\"0x{:08X}\",\"part_index\":{},\"blocking\":{},\"anchor\":\"entity_origin\"}}\n",
            t.default_script_id,
            fmt_f64(t.start_time_s),
            t.emitter_id,
            t.part_index,
            t.blocking,
        )
            .as_bytes(),
    );
}

fn write_sky_particle_line(out: &mut Vec<u8>, t: &SkyParticleTrigger) {
    let escaped_name = t
        .day_group_name
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    out.extend_from_slice(
        format!(
            "{{\"source\":\"sky_chain\",\"trigger\":\"time_of_day\",\"day_group_idx\":{},\"day_group_name\":\"{}\",\"day_group_chance\":{},\"active_fraction_start\":{},\"active_fraction_end\":{},\"sky_object_idx\":{},\"sky_object_id\":\"0x{:08X}\",\"physics_script_id\":\"0x{:08X}\",\"physics_script_source\":\"{}\",\"hook_idx\":{},\"start_time_s\":{},\"emitter_id\":\"0x{:08X}\",\"blocking\":{},\"anchor\":\"sky_cell_origin\"}}\n",
            t.day_group_idx,
            escaped_name,
            fmt_f32(t.day_group_chance),
            fmt_f32(t.active_fraction_start),
            fmt_f32(t.active_fraction_end),
            t.sky_object_idx,
            t.sky_object_id,
            t.physics_script_id,
            t.physics_script_source.as_str(),
            t.hook_idx,
            fmt_f64(t.start_time_s),
            t.emitter_id,
            t.blocking,
        )
            .as_bytes(),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sky_chain::ScriptSource;
    use crate::AmbientSoundRecord;

    fn synthetic_bake() -> LandblockEventBake {
        LandblockEventBake {
            landblock_id: 0xA9B4_0000,
            region_did: DEFAULT_REGION_DID,
            ambient_terrain_events: vec![AmbientTrigger {
                terrain_type: 11,
                scene_type: 3,
                scene_info_idx: 33,
                stb_index: 5,
                stb_id: 0x2000_000A,
                vertex_indices: vec![0, 1, 2, 4],
                ambient_sounds: vec![AmbientSoundRecord {
                    s_type: 256,
                    volume: 0.8,
                    base_chance: 0.0,
                    min_rate: 0.0,
                    max_rate: 0.0,
                    continuous: true,
                }],
            }],
            anim_hook_events: vec![AnimSoundTrigger {
                csetup_id: 0x0200_0123,
                motion_table_id: 0x0900_0456,
                motion_key: 0x0040_0005,
                motion_kind: 0,
                link_outer_key: None,
                is_default_stance: true,
                animation_did: 0x0300_ABCD,
                hook_frame: 12,
                hook_type: 1,
                sound_id: 256,
                priority: 0.0,
                probability: 1.0,
                volume: 1.0,
            }],
            physics_particle_events: vec![PhysicsScriptParticleTrigger {
                default_script_id: 0x3300_0789,
                start_time_s: 0.5,
                emitter_id: 0x3200_0ABC,
                part_index: 0,
                blocking: false,
            }],
            sky_particle_events: vec![SkyParticleTrigger {
                day_group_idx: 0,
                day_group_name: "Sunny".to_string(),
                day_group_chance: 0.25,
                active_fraction_start: 0.0,
                active_fraction_end: 1.0,
                sky_object_idx: 6,
                sky_object_id: 0x0200_0714,
                physics_script_id: 0x3300_07DB,
                physics_script_source: ScriptSource::SkyObject,
                hook_idx: 1,
                start_time_s: 0.0,
                emitter_id: 0x3200_0456,
                blocking: false,
            }],
        }
    }

    #[test]
    fn to_jsonl_bytes_round_trips_exactly_n_lines() {
        let b = synthetic_bake();
        let bytes = b.to_jsonl_bytes();
        let s = std::str::from_utf8(&bytes).unwrap();
        assert_eq!(s.matches('\n').count(), b.total_events());
        assert_eq!(b.total_events(), 4);
    }

    #[test]
    fn to_jsonl_bytes_is_byte_identical_across_calls() {
        // Determinism gate at the in-memory level — guards against
        // HashMap-iteration creep should anyone later wire the JSONL
        // through one.
        let b = synthetic_bake();
        let a = b.to_jsonl_bytes();
        let aa = b.to_jsonl_bytes();
        assert_eq!(a, aa);
    }

    #[test]
    fn to_jsonl_bytes_each_category_starts_with_known_source_tag() {
        let b = synthetic_bake();
        let s = String::from_utf8(b.to_jsonl_bytes()).unwrap();
        let lines: Vec<&str> = s.lines().collect();
        assert_eq!(lines.len(), 4);
        assert!(lines[0].starts_with("{\"source\":\"ambient\""));
        assert!(lines[1].starts_with("{\"source\":\"animation_sound\""));
        assert!(lines[2].starts_with("{\"source\":\"physics_script_particle\""));
        assert!(lines[3].starts_with("{\"source\":\"sky_chain\""));
    }

    #[test]
    fn bake_inputs_from_dat_dir_defaults() {
        let inputs = BakeInputs::from_dat_dir(0xA9B4_0000, "/tmp/dats");
        assert_eq!(inputs.landblock_id, 0xA9B4_0000);
        assert_eq!(inputs.region_did, DEFAULT_REGION_DID);
        assert!(matches!(inputs.entity_source, EntitySource::LandblockInfo));
        assert!(inputs.include_sky_chain);
    }

    #[test]
    fn total_events_sums_all_four_categories() {
        let b = synthetic_bake();
        assert_eq!(b.total_events(), 4);
    }

    #[test]
    fn fmt_f32_normalises_negative_zero() {
        assert_eq!(fmt_f32(-0.0), "0.000000");
        assert_eq!(fmt_f32(0.0), "0.000000");
        assert_eq!(fmt_f32(1.5), "1.500000");
    }
}
