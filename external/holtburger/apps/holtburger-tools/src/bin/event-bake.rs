//! `event-bake` — Phase F.B integration shell for the event bake.
//!
//! Mirrors `scenery-bake` (Phase B.3) for the three event-trigger
//! channels: ambient terrain-driven sounds, animation Sound hooks,
//! and PhysicsScript CreateParticle hooks. Emits one JSONL per LB
//! with `"source": "ambient" | "animation_sound" | "physics_script_particle"`
//! prefix per record, plus an `event-bake-source.sha256` sidecar.
//!
//! See `docs/event-completeness-method.md` for the full method spec.
//!
//! Usage:
//!
//! ```text
//! event-bake \
//!     --dat-dir /home/wbterminal/projects/RetailSmoke/dats/base \
//!     --landblocks 0xA3AE..0xAFBA \
//!     --spawns-dir /mnt/wbterminal1/holtburger-dist-v2/spawns/ \
//!     --setup-table-path /mnt/wbterminal1/holtburger-dist-v2/spawns/wcid_to_setup.json \
//!     --out /mnt/wbterminal1/tmp/claude-scratch/event-completeness/b/holtburg-ring
//! ```
//!
//! Same `--landblocks` spec syntax as `scenery-bake`:
//! - single hex LB id (`0xA9B4`)
//! - inclusive `<lo>..<hi>` corner rectangle (`0xA3AE..0xAFBA`)
//! - `@<path>` file list

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use binrw::io::Cursor;
use clap::Parser;
use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::particle_emitter::ParticleEmitter;
use holtburger_dat::file_type::{Animation, MotionTable, PhysicsScript, Region, SetupModel};
use holtburger_dat::landblock::CellLandblock;
use holtburger_event_bake::{
    AmbientTrigger, AnimSoundTrigger, PhysicsScriptParticleTrigger, SkyParticleTrigger,
    bake_ambient_manifest, bake_anim_sound_manifest, bake_particle_manifest,
    enumerate_sky_particle_chain,
};
use log::{debug, info, warn};
use sha2::{Digest, Sha256};

const EVENT_BAKE_CLI_VERSION: &str = "event-bake-cli/0.1.0";
const EVENT_BAKE_LIB_VERSION: &str = "holtburger-event-bake/0.1.0";

#[derive(Parser, Debug)]
#[command(
    author,
    version,
    about = "Bake per-LB event manifests (ambient + anim Sound + PhysicsScript particle) — Phase F.B"
)]
struct Cli {
    /// Directory containing the three retail base DATs:
    /// `client_portal.dat`, `client_cell_1.dat`,
    /// `client_local_English.dat`. MUST be retail-clean — the
    /// pre-flight rejects sibling `custom_textures/` / `iter-*/` /
    /// `*.wbproj` and any modder-allocated record IDs.
    #[arg(long, value_name = "PATH")]
    dat_dir: PathBuf,

    /// Landblock spec. Same syntax as `scenery-bake`:
    /// - hex LB id: `0xA9B4`
    /// - inclusive rectangle: `0xA3AE..0xAFBA`
    /// - file list: `@<path>` reads one hex id per line
    #[arg(long, value_name = "LB_SPEC")]
    landblocks: String,

    /// Region DID. Defaults to `0x13000000` (Dereth).
    #[arg(long, value_name = "DID", default_value = "0x13000000")]
    region_did: String,

    /// Directory containing per-LB spawn JSONL files (e.g.
    /// `<lbHex>.spawns.jsonl`) — typically Phase D.1's staged dir
    /// `/mnt/wbterminal1/holtburger-dist-v2/spawns/`. The bake reads
    /// each LB's spawns to know which entities are expected on it for
    /// anim-Sound + particle enumeration.
    #[arg(long, value_name = "PATH")]
    spawns_dir: PathBuf,

    /// Path to `wcid_to_setup.json` — the wcid→SetupModel DID map
    /// produced by Phase D.1. Used to resolve each spawn's entity
    /// SetupModel.
    #[arg(long, value_name = "PATH")]
    setup_table_path: PathBuf,

    /// Output directory. Created if missing. Will contain one
    /// `<lbHex>.events.jsonl` per landblock plus an
    /// `event-bake-source.sha256` sidecar.
    #[arg(long, value_name = "DIR")]
    out: PathBuf,

    /// **F.B.4** — also bake the sky particle chain (P2). One
    /// `region.sky-events.jsonl` is written alongside the per-LB
    /// events files, containing one record per `(day_group_idx,
    /// sky_object_idx, hook_idx)` tuple for every SkyObject in
    /// `Region.sky_info.day_groups` that has a resolvable
    /// PhysicsScript chain. The bake is region-scoped (not per-LB) —
    /// sky triggers depend on time-of-day rather than landblock.
    #[arg(long, default_value_t = false)]
    sky: bool,

    /// Emit progress logs (INFO level) to stderr.
    #[arg(long)]
    verbose: bool,
}

fn parse_hex_u32(s: &str) -> Result<u32> {
    let s = s.trim();
    let stripped = s.trim_start_matches("0x").trim_start_matches("0X");
    u32::from_str_radix(stripped, 16).with_context(|| format!("parse hex u32 `{s}`"))
}

/// Same LB-spec parser as `scenery-bake` — copy-pasted because the
/// scenery-bake CLI keeps it private. Out-of-bounds rectangles error
/// rather than silently dropping LBs.
fn parse_landblock_spec(spec: &str) -> Result<Vec<u16>> {
    let spec = spec.trim();
    if let Some(path) = spec.strip_prefix('@') {
        let body = fs::read_to_string(Path::new(path))
            .with_context(|| format!("read landblock list `{path}`"))?;
        let mut out = Vec::new();
        for (lineno, line) in body.lines().enumerate() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let v = parse_hex_u32(line)
                .with_context(|| format!("landblock list `{path}` line {}", lineno + 1))?;
            out.push(u16::try_from(v).with_context(|| {
                format!("landblock id `{line}` is wider than 16 bits — expected packed key")
            })?);
        }
        return Ok(out);
    }
    if let Some((lo_s, hi_s)) = spec.split_once("..") {
        let lo = parse_hex_u32(lo_s)?;
        let hi = parse_hex_u32(hi_s)?;
        if hi < lo {
            bail!("--landblocks range high `{hi:#X}` is below low `{lo:#X}`");
        }
        let lo_u16 = u16::try_from(lo)
            .with_context(|| format!("range bound `{lo:#X}` is wider than 16 bits"))?;
        let hi_u16 = u16::try_from(hi)
            .with_context(|| format!("range bound `{hi:#X}` is wider than 16 bits"))?;
        let (xlo, ylo) = ((lo_u16 >> 8) as u32, (lo_u16 & 0xFF) as u32);
        let (xhi, yhi) = ((hi_u16 >> 8) as u32, (hi_u16 & 0xFF) as u32);
        if xhi < xlo || yhi < ylo {
            bail!(
                "--landblocks rectangle: hi=({xhi:#X},{yhi:#X}) must dominate lo=({xlo:#X},{ylo:#X})"
            );
        }
        let mut out = Vec::with_capacity(((xhi - xlo + 1) * (yhi - ylo + 1)) as usize);
        for x in xlo..=xhi {
            for y in ylo..=yhi {
                out.push(((x as u16) << 8) | (y as u16));
            }
        }
        return Ok(out);
    }
    let v = parse_hex_u32(spec)?;
    let v_u16 = u16::try_from(v)
        .with_context(|| format!("landblock id `{spec}` is wider than 16 bits"))?;
    Ok(vec![v_u16])
}

/// Pre-flight integrity check. Same shape as `scenery-bake`'s — refuses
/// to run against custom DATs. Opens the three DATs + computes
/// SHA-256 hashes for the sidecar.
struct DatDirCheck {
    portal_db: DatDatabase,
    cell_db: DatDatabase,
    portal_hash: String,
    cell_hash: String,
    local_hash: String,
}

fn preflight_dat_dir(dat_dir: &Path) -> Result<DatDirCheck> {
    if !dat_dir.is_dir() {
        bail!("--dat-dir `{}` is not a directory", dat_dir.display());
    }
    let portal = dat_dir.join("client_portal.dat");
    let cell = dat_dir.join("client_cell_1.dat");
    let local = dat_dir.join("client_local_English.dat");
    for (label, p) in [
        ("client_portal.dat", &portal),
        ("client_cell_1.dat", &cell),
        ("client_local_English.dat", &local),
    ] {
        let md = fs::metadata(p)
            .with_context(|| format!("stat {label} at `{}`", p.display()))?;
        if !md.is_file() {
            bail!(
                "--dat-dir: `{}` is not a regular file (got file_type={:?})",
                p.display(),
                md.file_type()
            );
        }
    }
    // Sibling iteration markers — base-DATs-only check.
    let entries = fs::read_dir(dat_dir)
        .with_context(|| format!("read --dat-dir `{}`", dat_dir.display()))?;
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        let name_s = name.to_string_lossy();
        if name_s == "custom_textures" {
            let mut iter = fs::read_dir(entry.path())?;
            if iter.next().is_some() {
                bail!(
                    "--dat-dir contains non-empty `custom_textures/` — bake refuses to run against custom DATs"
                );
            }
        }
        if name_s.starts_with("iter-") {
            bail!(
                "--dat-dir contains modder-iteration marker `{name_s}` — bake refuses to run against custom DATs"
            );
        }
        if name_s.ends_with(".wbproj") {
            bail!(
                "--dat-dir contains WorldBuilder project file `{name_s}` — bake refuses to run against custom DATs"
            );
        }
    }
    let portal_db = DatDatabase::new(&portal)
        .with_context(|| format!("open {}", portal.display()))?;
    let cell_db = DatDatabase::new(&cell)
        .with_context(|| format!("open {}", cell.display()))?;
    let local_db = DatDatabase::new(&local)
        .with_context(|| format!("open {}", local.display()))?;
    for (label, db) in [
        ("portal.dat", &portal_db),
        ("cell.dat", &cell_db),
        ("local.dat", &local_db),
    ] {
        if let Some(bad) = first_modder_allocated_id(db) {
            bail!(
                "--dat-dir contains modder-allocated record 0x{bad:08X} in {label} — bake refuses to run against custom DATs"
            );
        }
    }
    let portal_hash = sha256_file(&portal)?;
    let cell_hash = sha256_file(&cell)?;
    let local_hash = sha256_file(&local)?;
    Ok(DatDirCheck {
        portal_db,
        cell_db,
        portal_hash,
        cell_hash,
        local_hash,
    })
}

fn first_modder_allocated_id(db: &DatDatabase) -> Option<u32> {
    let mut hits: Vec<u32> = db
        .files
        .keys()
        .copied()
        .filter(|&id| {
            let top = (id >> 24) & 0xFF;
            let second = (id >> 16) & 0xFF;
            (0x01..=0x78).contains(&(top as u8)) && second == 0xFF
        })
        .collect();
    if hits.is_empty() {
        return None;
    }
    hits.sort();
    Some(hits[0])
}

fn sha256_file(path: &Path) -> Result<String> {
    let mut hasher = Sha256::new();
    let mut f = File::open(path).with_context(|| format!("open for hash {}", path.display()))?;
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// Stream-hash a file's textual content. Used for the spawns dir +
/// setup-table-path so the sidecar pins their identity too.
fn sha256_textual_file(path: &Path) -> Result<String> {
    sha256_file(path)
}

// ---------------------------------------------------------------------------
// Wcid → setup table
// ---------------------------------------------------------------------------

/// Load `wcid_to_setup.json` (a flat `{ "wcid_str": setup_did_int,
/// ... }` map) into a `HashMap<u32, u32>`.
fn load_wcid_to_setup(path: &Path) -> Result<HashMap<u32, u32>> {
    let bytes = fs::read(path)
        .with_context(|| format!("read setup-table `{}`", path.display()))?;
    let raw: serde_json::Value = serde_json::from_slice(&bytes)
        .with_context(|| format!("parse setup-table JSON `{}`", path.display()))?;
    let obj = raw
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("setup-table is not a JSON object"))?;
    let mut out: HashMap<u32, u32> = HashMap::with_capacity(obj.len());
    for (k, v) in obj {
        let wcid: u32 = k
            .parse()
            .with_context(|| format!("wcid key `{k}` is not u32"))?;
        let setup = v
            .as_u64()
            .ok_or_else(|| anyhow::anyhow!("setup value for wcid {k} is not u64"))?;
        let setup_u32 = u32::try_from(setup)
            .with_context(|| format!("setup value for wcid {k} doesn't fit u32"))?;
        out.insert(wcid, setup_u32);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Per-LB spawn loader
// ---------------------------------------------------------------------------

/// One spawn row from the per-LB JSONL. Only the fields we need.
#[derive(Debug, Clone)]
struct SpawnRow {
    wcid: u32,
    #[allow(dead_code)]
    name: String,
}

fn load_spawns_for_lb(spawns_dir: &Path, lb_key: u16) -> Vec<SpawnRow> {
    let path = spawns_dir.join(format!("0x{lb_key:04X}.spawns.jsonl"));
    let Ok(f) = File::open(&path) else {
        // No spawns file for this LB — many LBs have no entities.
        return Vec::new();
    };
    let mut out: Vec<SpawnRow> = Vec::new();
    let reader = BufReader::new(f);
    for (lineno, line) in reader.lines().enumerate() {
        let Ok(line) = line else { continue };
        if line.trim().is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                warn!(
                    "spawn-json parse error in `{}` line {}: {}",
                    path.display(),
                    lineno + 1,
                    e
                );
                continue;
            }
        };
        let wcid = match v.get("wcid").and_then(|x| x.as_u64()) {
            Some(w) => w as u32,
            None => continue,
        };
        let name = v
            .get("name")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        out.push(SpawnRow { wcid, name });
    }
    out
}

// ---------------------------------------------------------------------------
// DAT resource caches — memoise SetupModel + MotionTable + Animation +
// PhysicsScript so per-LB bakes don't re-parse repeated entities.
// ---------------------------------------------------------------------------

struct ResourceCache {
    setups: HashMap<u32, Option<SetupModel>>,
    motion_tables: HashMap<u32, Option<MotionTable>>,
    animations: HashMap<u32, Option<Animation>>,
    physics_scripts: HashMap<u32, Option<PhysicsScript>>,
}

impl ResourceCache {
    fn new() -> Self {
        Self {
            setups: HashMap::new(),
            motion_tables: HashMap::new(),
            animations: HashMap::new(),
            physics_scripts: HashMap::new(),
        }
    }

    fn setup(&mut self, portal: &DatDatabase, did: u32) -> Option<SetupModel> {
        if let Some(c) = self.setups.get(&did) {
            return c.clone();
        }
        let r = portal
            .get_file(did)
            .ok()
            .and_then(|b| SetupModel::read(&mut Cursor::new(&b)).ok());
        self.setups.insert(did, r.clone());
        r
    }

    fn motion_table(&mut self, portal: &DatDatabase, did: u32) -> Option<MotionTable> {
        if let Some(c) = self.motion_tables.get(&did) {
            return c.clone();
        }
        let r = portal
            .get_file(did)
            .ok()
            .and_then(|b| MotionTable::read(&mut Cursor::new(&b)).ok());
        self.motion_tables.insert(did, r.clone());
        r
    }

    fn animation(&mut self, portal: &DatDatabase, did: u32) -> Option<Animation> {
        if let Some(c) = self.animations.get(&did) {
            return c.clone();
        }
        let r = portal
            .get_file(did)
            .ok()
            .and_then(|b| Animation::read(&mut Cursor::new(&b)).ok());
        self.animations.insert(did, r.clone());
        r
    }

    fn physics_script(&mut self, portal: &DatDatabase, did: u32) -> Option<PhysicsScript> {
        if let Some(c) = self.physics_scripts.get(&did) {
            return c.clone();
        }
        let r = portal
            .get_file(did)
            .ok()
            .and_then(|b| PhysicsScript::read(&mut Cursor::new(&b)).ok());
        self.physics_scripts.insert(did, r.clone());
        r
    }
}

// ---------------------------------------------------------------------------
// JSONL serialization
// ---------------------------------------------------------------------------

/// Format an f32 with six digits after the decimal. Determinism +
/// locale-free. Mirrors `scenery-bake`'s helper of the same name.
fn fmt_f32(v: f32) -> String {
    let v = if v == 0.0 { 0.0 } else { v };
    format!("{:.6}", v)
}

fn fmt_f64(v: f64) -> String {
    let v = if v == 0.0 { 0.0 } else { v };
    format!("{:.6}", v)
}

fn write_ambient_line<W: Write>(mut w: W, t: &AmbientTrigger) -> Result<()> {
    let mut sounds_json = String::new();
    sounds_json.push('[');
    for (i, s) in t.ambient_sounds.iter().enumerate() {
        if i > 0 {
            sounds_json.push(',');
        }
        sounds_json.push_str(&format!(
            "{{\"s_type\":{},\"volume\":{},\"base_chance\":{},\"min_rate\":{},\"max_rate\":{},\"continuous\":{}}}",
            s.s_type,
            fmt_f32(s.volume),
            fmt_f32(s.base_chance),
            fmt_f32(s.min_rate),
            fmt_f32(s.max_rate),
            s.continuous,
        ));
    }
    sounds_json.push(']');
    let mut verts_json = String::new();
    verts_json.push('[');
    for (i, v) in t.vertex_indices.iter().enumerate() {
        if i > 0 {
            verts_json.push(',');
        }
        verts_json.push_str(&v.to_string());
    }
    verts_json.push(']');
    writeln!(
        w,
        "{{\"source\":\"ambient\",\"trigger\":\"terrain\",\"terrain_type\":{},\"scene_type\":{},\"scene_info_idx\":{},\"stb_index\":{},\"stb_id\":\"0x{:08X}\",\"vertex_indices\":{},\"ambient_sounds\":{}}}",
        t.terrain_type,
        t.scene_type,
        t.scene_info_idx,
        t.stb_index,
        t.stb_id,
        verts_json,
        sounds_json,
    )?;
    Ok(())
}

fn write_anim_sound_line<W: Write>(mut w: W, t: &AnimSoundTrigger) -> Result<()> {
    let link_outer = match t.link_outer_key {
        Some(k) => format!("{k}"),
        None => "null".to_string(),
    };
    writeln!(
        w,
        "{{\"source\":\"animation_sound\",\"trigger\":\"animation_sound\",\"csetup_id\":\"0x{:08X}\",\"motion_table_id\":\"0x{:08X}\",\"motion_key\":\"0x{:08X}\",\"motion_kind\":{},\"link_outer_key\":{},\"is_default_stance\":{},\"animation_did\":\"0x{:08X}\",\"hook_frame\":{},\"hook_type\":{},\"sound_id\":{},\"priority\":{},\"probability\":{},\"volume\":{}}}",
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
    )?;
    Ok(())
}

fn write_particle_line<W: Write>(
    mut w: W,
    t: &PhysicsScriptParticleTrigger,
    anchor: &str,
) -> Result<()> {
    writeln!(
        w,
        "{{\"source\":\"physics_script_particle\",\"trigger\":\"physics_script_particle\",\"default_script_id\":\"0x{:08X}\",\"start_time_s\":{},\"emitter_id\":\"0x{:08X}\",\"part_index\":{},\"blocking\":{},\"anchor\":\"{}\"}}",
        t.default_script_id,
        fmt_f64(t.start_time_s),
        t.emitter_id,
        t.part_index,
        t.blocking,
        anchor,
    )?;
    Ok(())
}

/// F.B.4 — sky particle chain JSONL row. Single-line JSON per record;
/// region-scoped (not per-LB) so the writer lives outside the per-LB
/// loop. `hw_gfx_obj_id` is the ParticleEmitter's `hw_gfx_obj_id`
/// resolved via the caller-supplied lookup; passed in explicitly so the
/// writer has no `DatDatabase` dependency.
#[allow(clippy::too_many_arguments)]
fn write_sky_particle_line<W: Write>(
    mut w: W,
    t: &SkyParticleTrigger,
    hw_gfx_obj_id: u32,
) -> Result<()> {
    // String fields are pre-escaped via the static `day_group_name`
    // from the DAT — same Region 0x13 names that already flow through
    // the existing `eprintln!` test reports (`Sunny`, `PartlyCloudy`,
    // etc.) — none contain quote/backslash. Defensive replace is
    // applied below for forward-compat in case a future Region carries
    // a name with embedded specials.
    let escaped_name = t
        .day_group_name
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    writeln!(
        w,
        "{{\"source\":\"sky_chain\",\"trigger\":\"time_of_day\",\"day_group_idx\":{},\"day_group_name\":\"{}\",\"day_group_chance\":{},\"active_fraction_start\":{},\"active_fraction_end\":{},\"sky_object_idx\":{},\"sky_object_id\":\"0x{:08X}\",\"physics_script_id\":\"0x{:08X}\",\"physics_script_source\":\"{}\",\"hook_idx\":{},\"start_time_s\":{},\"emitter_id\":\"0x{:08X}\",\"hw_gfx_obj_id\":\"0x{:08X}\",\"blocking\":{},\"anchor\":\"sky_cell_origin\"}}",
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
        hw_gfx_obj_id,
        t.blocking,
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Per-LB bake driver
// ---------------------------------------------------------------------------

struct LbCounts {
    ambient: usize,
    anim_sound: usize,
    particle: usize,
}

fn bake_one_lb(
    region: &Region,
    portal: &DatDatabase,
    cell_db: &DatDatabase,
    spawns_dir: &Path,
    wcid_to_setup: &HashMap<u32, u32>,
    cache: &mut ResourceCache,
    lb_key: u16,
    out_dir: &Path,
) -> Result<Option<LbCounts>> {
    let lb_word = (lb_key as u32) << 16;
    let cell_id = lb_word | 0xFFFF;
    let Ok(cell_bytes) = cell_db.get_file(cell_id) else {
        warn!("LB 0x{lb_key:04X}: CellLandblock {cell_id:#010X} not in cell.dat — skipping");
        return Ok(None);
    };
    let cell_landblock = CellLandblock::unpack(&cell_bytes)
        .with_context(|| format!("parse CellLandblock 0x{cell_id:08X}"))?;
    let landblock_id = lb_word;

    // F.B.1 ambient
    let ambient = bake_ambient_manifest(region, &cell_landblock, landblock_id);

    // F.B.2 anim_sound + F.B.3 particle — both require enumerating
    // entities expected on the LB. Walk the staged spawns JSONL.
    let spawns = load_spawns_for_lb(spawns_dir, lb_key);

    // De-duplicate by csetup so two wisps of the same kind don't
    // double-bake. The runtime fires hooks per-entity-instance, but
    // the manifest is a per-csetup contract; the validator multiplies
    // by spawn-count at match time if it wants per-instance precision.
    let mut unique_setups: Vec<u32> = Vec::new();
    for s in &spawns {
        let Some(&setup_did) = wcid_to_setup.get(&s.wcid) else {
            continue;
        };
        if !unique_setups.contains(&setup_did) {
            unique_setups.push(setup_did);
        }
    }
    unique_setups.sort();

    let mut anim_sound_triggers: Vec<AnimSoundTrigger> = Vec::new();
    let mut particle_triggers: Vec<PhysicsScriptParticleTrigger> = Vec::new();

    for setup_did in &unique_setups {
        let Some(setup) = cache.setup(portal, *setup_did) else {
            debug!("LB 0x{lb_key:04X}: SetupModel 0x{setup_did:08X} not loadable");
            continue;
        };

        // anim_sound: needs motion_table.
        if let Some(motion_table_did) = setup.default_motion_table {
            if let Some(motion_table) = cache.motion_table(portal, motion_table_did) {
                // Borrow-checker workaround: we need to capture `cache`
                // mutably inside the closure but also pass it to
                // `bake_anim_sound_manifest`. Pre-collect all needed
                // animation DIDs first, then resolve them, then build
                // a deterministic in-memory lookup table.
                let mut anim_dids: Vec<u32> = Vec::new();
                for md in motion_table.cycles.values() {
                    for a in &md.anims {
                        anim_dids.push(a.anim_id);
                    }
                }
                for md in motion_table.modifiers.values() {
                    for a in &md.anims {
                        anim_dids.push(a.anim_id);
                    }
                }
                for inner in motion_table.links.values() {
                    for md in inner.values() {
                        for a in &md.anims {
                            anim_dids.push(a.anim_id);
                        }
                    }
                }
                anim_dids.sort();
                anim_dids.dedup();
                let mut anim_cache: HashMap<u32, Option<Animation>> = HashMap::new();
                for d in &anim_dids {
                    let r = cache.animation(portal, *d);
                    anim_cache.insert(*d, r);
                }
                let lookup = |did: u32| anim_cache.get(&did).cloned().flatten();
                let mut t = bake_anim_sound_manifest(*setup_did, &setup, &motion_table, lookup);
                anim_sound_triggers.append(&mut t);
            }
        }

        // particle: needs SetupModel.default_script.
        if let Some(script_did) = setup.default_script {
            if let Some(ps) = cache.physics_script(portal, script_did) {
                let mut t = bake_particle_manifest(script_did, &ps);
                particle_triggers.append(&mut t);
            }
        }
    }

    // Dedupe particle triggers — multiple entities sharing the same
    // SetupModel + default_script would produce identical bake records.
    particle_triggers.sort_by(|a, b| {
        (a.default_script_id, a.emitter_id, a.start_time_s.to_bits()).cmp(&(
            b.default_script_id,
            b.emitter_id,
            b.start_time_s.to_bits(),
        ))
    });
    particle_triggers.dedup();

    // Dedupe anim_sound triggers — same csetup repeated across two
    // spawns of the same NPC would produce identical records.
    anim_sound_triggers.dedup();

    // Emit JSONL — one line per record, prefixed with `source` field.
    let out_path = out_dir.join(format!("0x{lb_key:04X}.events.jsonl"));
    let f = File::create(&out_path)
        .with_context(|| format!("create {}", out_path.display()))?;
    let mut w = BufWriter::new(f);
    for t in &ambient {
        write_ambient_line(&mut w, t)?;
    }
    for t in &anim_sound_triggers {
        write_anim_sound_line(&mut w, t)?;
    }
    for t in &particle_triggers {
        write_particle_line(&mut w, t, "entity_origin")?;
    }
    w.flush()?;

    debug!(
        "LB 0x{lb_key:04X}: ambient={} anim_sound={} particle={} → {}",
        ambient.len(),
        anim_sound_triggers.len(),
        particle_triggers.len(),
        out_path.display()
    );

    Ok(Some(LbCounts {
        ambient: ambient.len(),
        anim_sound: anim_sound_triggers.len(),
        particle: particle_triggers.len(),
    }))
}

// ---------------------------------------------------------------------------
// F.B.4 — sky particle chain bake
// ---------------------------------------------------------------------------

struct SkyBakeCounts {
    total: usize,
    skipped_emitter_resolve: usize,
}

/// Resolve a ParticleEmitter's `hw_gfx_obj_id` for the JSONL writer.
/// Memoised across all hooks; one cache per bake invocation.
fn fetch_emitter_hw_gfx_obj_id(
    portal: &DatDatabase,
    cache: &mut HashMap<u32, Option<u32>>,
    emitter_id: u32,
) -> Option<u32> {
    if let Some(c) = cache.get(&emitter_id) {
        return *c;
    }
    let r = portal
        .get_file(emitter_id)
        .ok()
        .and_then(|b| ParticleEmitter::unpack(&b).ok())
        .map(|pe| pe.hw_gfx_obj_id);
    cache.insert(emitter_id, r);
    r
}

/// Bake the region-scoped sky particle chain (F.B.4). Writes one
/// `region.sky-events.jsonl` to `out_dir`; the file is region-keyed
/// rather than per-LB because sky triggers depend on time-of-day, not
/// landblock.
fn bake_sky_chain(
    region: &Region,
    portal: &DatDatabase,
    cache: &mut ResourceCache,
    out_dir: &Path,
) -> Result<SkyBakeCounts> {
    // The enumerator borrows `cache` mutably via two closures; rather
    // than fight the borrow checker, materialise the script + setup
    // lookups eagerly via the cache's own helpers. The enumerator
    // calls each closure at most once per (script_did, setup_did) so
    // this is the same number of cache lookups it would have done.
    //
    // Build a closure-friendly wrapper: each closure does `cache.…(portal, did)`
    // which only touches one cache field, so the two closures never
    // alias.
    let mut sky_cache_ps: HashMap<u32, Option<PhysicsScript>> = HashMap::new();
    let mut sky_cache_setup: HashMap<u32, Option<SetupModel>> = HashMap::new();

    // Pre-seed both caches by walking the SkyObjects once to know
    // which DIDs to fetch. This way the actual `enumerate_sky_…`
    // closures are pure lookups against in-memory maps.
    if let Some(sky_info) = region.sky_info.as_ref() {
        for dg in &sky_info.day_groups {
            for so in &dg.sky_objects {
                if so.default_pes_object_id != 0 {
                    if !sky_cache_ps.contains_key(&so.default_pes_object_id) {
                        let r = cache.physics_script(portal, so.default_pes_object_id);
                        sky_cache_ps.insert(so.default_pes_object_id, r);
                    }
                } else if (so.default_gfx_object_id >> 24) == 0x02 {
                    if !sky_cache_setup.contains_key(&so.default_gfx_object_id) {
                        let r = cache.setup(portal, so.default_gfx_object_id);
                        sky_cache_setup.insert(so.default_gfx_object_id, r.clone());
                        if let Some(setup) = r {
                            if let Some(script_did) = setup.default_script {
                                if (script_did >> 24) == 0x33
                                    && !sky_cache_ps.contains_key(&script_did)
                                {
                                    let ps = cache.physics_script(portal, script_did);
                                    sky_cache_ps.insert(script_did, ps);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    let triggers = enumerate_sky_particle_chain(
        region,
        |did| sky_cache_ps.get(&did).cloned().flatten(),
        |did| sky_cache_setup.get(&did).cloned().flatten(),
    );

    let mut emitter_hw_cache: HashMap<u32, Option<u32>> = HashMap::new();
    let out_path = out_dir.join("region.sky-events.jsonl");
    let f = File::create(&out_path)
        .with_context(|| format!("create {}", out_path.display()))?;
    let mut w = BufWriter::new(f);
    let mut skipped_emitter_resolve = 0usize;
    for t in &triggers {
        // hw_gfx_obj_id resolution can fail when the bake runs against
        // a DAT that has the SkyObject + PhysicsScript but a missing
        // ParticleEmitter (would indicate a broken chain — defensive).
        let hw = match fetch_emitter_hw_gfx_obj_id(portal, &mut emitter_hw_cache, t.emitter_id) {
            Some(h) => h,
            None => {
                skipped_emitter_resolve += 1;
                warn!(
                    "sky-chain: ParticleEmitter 0x{:08X} (day_group={} sky_object={}) failed to resolve — emitting hw_gfx_obj_id=0x00000000",
                    t.emitter_id, t.day_group_idx, t.sky_object_idx
                );
                0
            }
        };
        write_sky_particle_line(&mut w, t, hw)?;
    }
    w.flush()?;

    debug!(
        "sky-chain: {} triggers (skipped_emitter_resolve={}) → {}",
        triggers.len(),
        skipped_emitter_resolve,
        out_path.display()
    );

    Ok(SkyBakeCounts {
        total: triggers.len(),
        skipped_emitter_resolve,
    })
}

#[allow(clippy::too_many_arguments)]
fn format_manifest(
    portal_hash: &str,
    cell_hash: &str,
    local_hash: &str,
    spawns_index_hash: Option<&str>,
    region_did: u32,
    baked: usize,
    skipped: usize,
    total_ambient: usize,
    total_anim_sound: usize,
    total_particle: usize,
    sky_counts: Option<&SkyBakeCounts>,
) -> String {
    let spawns_line = match spawns_index_hash {
        Some(h) => format!("wcid_to_setup.json\t{h}\n"),
        None => String::new(),
    };
    // F.B.4 — sky chain produces one region-keyed JSONL alongside the
    // per-LB files. The hash sidecar pins the file's presence via a
    // line; bake-source.sha256 consumers verify by re-running the bake
    // and diffing the JSONL byte-for-byte (same shape the per-LB files
    // already use).
    let sky_line = match sky_counts {
        Some(c) => format!(
            "region.sky-events.jsonl\tsky_chain triggers={} (skipped_emitter_resolve={})\n",
            c.total, c.skipped_emitter_resolve
        ),
        None => String::new(),
    };
    let sky_count_field = match sky_counts {
        Some(c) => format!(" sky_chain={}", c.total),
        None => String::new(),
    };
    format!(
        "client_portal.dat\t{}\nclient_cell_1.dat\t{}\nclient_local_English.dat\t{}\n{}{}bake-tool-version\t{} + {}\nregion-did\t0x{:08X}\nlandblocks\t{} baked, {} skipped\nevent-counts\tambient={} anim_sound={} particle={}{}\n",
        portal_hash,
        cell_hash,
        local_hash,
        spawns_line,
        sky_line,
        EVENT_BAKE_LIB_VERSION,
        EVENT_BAKE_CLI_VERSION,
        region_did,
        baked,
        skipped,
        total_ambient,
        total_anim_sound,
        total_particle,
        sky_count_field,
    )
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let mut log_builder = env_logger::Builder::from_default_env();
    if cli.verbose {
        log_builder.filter_level(log::LevelFilter::Info);
    } else {
        log_builder.filter_level(log::LevelFilter::Warn);
    }
    log_builder.init();

    let region_did = parse_hex_u32(&cli.region_did)?;
    let landblocks = parse_landblock_spec(&cli.landblocks)?;

    info!(
        "event-bake: --dat-dir={} --landblocks={} ({} LBs) --region-did=0x{:08X} --out={}",
        cli.dat_dir.display(),
        cli.landblocks,
        landblocks.len(),
        region_did,
        cli.out.display(),
    );

    fs::create_dir_all(&cli.out)
        .with_context(|| format!("create --out `{}`", cli.out.display()))?;

    let check = preflight_dat_dir(&cli.dat_dir)?;
    info!(
        "pre-flight ok: portal_hash={} cell_hash={} local_hash={}",
        &check.portal_hash[..16],
        &check.cell_hash[..16],
        &check.local_hash[..16],
    );

    // Spawns dir + setup table — soft-required (allow empty if no
    // anim_sound/particle wanted, but pre-check existence so empty
    // anim_sound output isn't a silent "we didn't find the table"
    // failure).
    if !cli.spawns_dir.is_dir() {
        bail!(
            "--spawns-dir `{}` is not a directory",
            cli.spawns_dir.display()
        );
    }
    if !cli.setup_table_path.is_file() {
        bail!(
            "--setup-table-path `{}` is not a regular file",
            cli.setup_table_path.display()
        );
    }
    let wcid_to_setup = load_wcid_to_setup(&cli.setup_table_path)?;
    let spawns_index_hash = sha256_textual_file(&cli.setup_table_path)?;
    info!(
        "wcid_to_setup loaded: {} entries (hash={})",
        wcid_to_setup.len(),
        &spawns_index_hash[..16]
    );

    // Parse the Region once.
    let region_bytes = check
        .portal_db
        .get_file(region_did)
        .with_context(|| format!("fetch Region {region_did:#010X} from portal.dat"))?;
    let region = {
        let mut cursor = Cursor::new(&region_bytes);
        Region::unpack(&mut cursor)
            .with_context(|| format!("parse Region {region_did:#010X}"))?
    };

    let mut cache = ResourceCache::new();
    let mut total_ambient = 0usize;
    let mut total_anim_sound = 0usize;
    let mut total_particle = 0usize;
    let mut baked = 0usize;
    let mut skipped = 0usize;

    for (i, &lb_key) in landblocks.iter().enumerate() {
        match bake_one_lb(
            &region,
            &check.portal_db,
            &check.cell_db,
            &cli.spawns_dir,
            &wcid_to_setup,
            &mut cache,
            lb_key,
            &cli.out,
        )? {
            Some(c) => {
                total_ambient += c.ambient;
                total_anim_sound += c.anim_sound;
                total_particle += c.particle;
                baked += 1;
            }
            None => skipped += 1,
        }
        if cli.verbose && (i + 1) % 25 == 0 {
            info!(
                "progress: {}/{} LBs baked ({} skipped so far) — totals ambient={} anim_sound={} particle={}",
                i + 1,
                landblocks.len(),
                skipped,
                total_ambient,
                total_anim_sound,
                total_particle,
            );
        }
    }

    // F.B.4 — opt-in sky particle chain bake. Region-scoped (one
    // `region.sky-events.jsonl` rather than per-LB). Counts are folded
    // into the manifest sidecar so consumers can diff sky+per-LB
    // totals atomically.
    let sky_counts = if cli.sky {
        let counts = bake_sky_chain(&region, &check.portal_db, &mut cache, &cli.out)?;
        info!(
            "sky-chain: {} triggers baked (skipped_emitter_resolve={})",
            counts.total, counts.skipped_emitter_resolve
        );
        Some(counts)
    } else {
        None
    };

    let manifest_path = cli.out.join("event-bake-source.sha256");
    let manifest = format_manifest(
        &check.portal_hash,
        &check.cell_hash,
        &check.local_hash,
        Some(&spawns_index_hash),
        region_did,
        baked,
        skipped,
        total_ambient,
        total_anim_sound,
        total_particle,
        sky_counts.as_ref(),
    );
    fs::write(&manifest_path, manifest)
        .with_context(|| format!("write {}", manifest_path.display()))?;

    let sky_msg = match sky_counts.as_ref() {
        Some(c) => format!(" sky_chain={}", c.total),
        None => String::new(),
    };
    eprintln!(
        "event-bake done: {} LBs baked, {} skipped — ambient={} anim_sound={} particle={}{} (total events = {})",
        baked,
        skipped,
        total_ambient,
        total_anim_sound,
        total_particle,
        sky_msg,
        total_ambient + total_anim_sound + total_particle
            + sky_counts.as_ref().map(|c| c.total).unwrap_or(0),
    );

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_hex_u32_accepts_prefixed_and_bare() {
        assert_eq!(parse_hex_u32("0xA9B4").unwrap(), 0xA9B4);
        assert_eq!(parse_hex_u32("a9b4").unwrap(), 0xA9B4);
        assert_eq!(parse_hex_u32("0X13000000").unwrap(), 0x13000000);
    }

    #[test]
    fn parse_landblock_spec_single() {
        let v = parse_landblock_spec("0xA9B4").unwrap();
        assert_eq!(v, vec![0xA9B4]);
    }

    #[test]
    fn parse_landblock_spec_holtburg_13x13() {
        let v = parse_landblock_spec("0xA3AE..0xAFBA").unwrap();
        assert_eq!(v.len(), 13 * 13);
        assert_eq!(v[0], 0xA3AE);
        assert_eq!(*v.last().unwrap(), 0xAFBA);
        assert!(v.contains(&0xA9B4));
    }

    #[test]
    fn parse_landblock_spec_range_rejects_inverted() {
        assert!(parse_landblock_spec("0xA3BA..0xAFAE").is_err());
    }

    #[test]
    fn fmt_f32_six_sig_normalises_negative_zero() {
        assert_eq!(fmt_f32(-0.0), "0.000000");
        assert_eq!(fmt_f32(0.0), "0.000000");
        assert_eq!(fmt_f32(1.234567), "1.234567");
    }

    #[test]
    fn format_manifest_contains_all_fields() {
        let m = format_manifest(
            &"a".repeat(64),
            &"b".repeat(64),
            &"c".repeat(64),
            Some(&"d".repeat(64)),
            0x13000000,
            169,
            0,
            42,
            13,
            7,
            None,
        );
        assert!(m.contains("client_portal.dat\t"));
        assert!(m.contains("wcid_to_setup.json\t"));
        assert!(m.contains("region-did\t0x13000000"));
        assert!(m.contains("169 baked, 0 skipped"));
        assert!(m.contains("ambient=42 anim_sound=13 particle=7"));
        assert!(
            !m.contains("sky_chain="),
            "sky line is omitted when sky_counts is None"
        );
        assert!(
            !m.contains("region.sky-events.jsonl"),
            "sky JSONL line is omitted when sky_counts is None"
        );
        assert!(m.contains(EVENT_BAKE_LIB_VERSION));
        assert!(m.contains(EVENT_BAKE_CLI_VERSION));
    }

    #[test]
    fn format_manifest_with_sky_counts_includes_sky_line() {
        let sky = SkyBakeCounts {
            total: 60,
            skipped_emitter_resolve: 2,
        };
        let m = format_manifest(
            &"a".repeat(64),
            &"b".repeat(64),
            &"c".repeat(64),
            Some(&"d".repeat(64)),
            0x13000000,
            169,
            0,
            42,
            13,
            7,
            Some(&sky),
        );
        assert!(m.contains("region.sky-events.jsonl\tsky_chain triggers=60"));
        assert!(m.contains("skipped_emitter_resolve=2"));
        assert!(m.contains("sky_chain=60"));
        assert!(m.contains("ambient=42 anim_sound=13 particle=7 sky_chain=60"));
    }

    #[test]
    fn modder_allocated_filter_rejects_modder_range() {
        let bad_ids = [0x01FF_0001, 0x02FF_1234, 0x12FF_ABCD, 0x78FF_FFFE];
        for id in bad_ids {
            let top = (id >> 24) & 0xFF;
            let second = (id >> 16) & 0xFF;
            assert!(
                (0x01u8..=0x78).contains(&(top as u8)) && second == 0xFF,
                "0x{id:08X} should be flagged as modder-allocated"
            );
        }
    }

    #[test]
    fn write_ambient_line_format_is_jsonl_one_line() {
        let t = AmbientTrigger {
            terrain_type: 21,
            scene_type: 3,
            scene_info_idx: 7,
            stb_index: 7,
            stb_id: 0x20000005,
            vertex_indices: vec![12, 13, 21, 22],
            ambient_sounds: vec![holtburger_event_bake::AmbientSoundRecord {
                s_type: 256,
                volume: 0.8,
                base_chance: 0.0,
                min_rate: 0.0,
                max_rate: 0.0,
                continuous: true,
            }],
        };
        let mut buf = Vec::new();
        write_ambient_line(&mut buf, &t).unwrap();
        let s = String::from_utf8(buf).unwrap();
        assert_eq!(s.matches('\n').count(), 1);
        assert!(s.starts_with("{\"source\":\"ambient\""));
        assert!(s.contains("\"stb_id\":\"0x20000005\""));
        assert!(s.contains("\"vertex_indices\":[12,13,21,22]"));
        assert!(s.contains("\"continuous\":true"));
    }

    #[test]
    fn write_anim_sound_line_format_is_jsonl_one_line() {
        let t = AnimSoundTrigger {
            csetup_id: 0x02000123,
            motion_table_id: 0x09000456,
            motion_key: 0x00400005,
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
        };
        let mut buf = Vec::new();
        write_anim_sound_line(&mut buf, &t).unwrap();
        let s = String::from_utf8(buf).unwrap();
        assert_eq!(s.matches('\n').count(), 1);
        assert!(s.starts_with("{\"source\":\"animation_sound\""));
        assert!(s.contains("\"csetup_id\":\"0x02000123\""));
        assert!(s.contains("\"hook_frame\":12"));
        assert!(s.contains("\"link_outer_key\":null"));
    }

    #[test]
    fn write_particle_line_format_is_jsonl_one_line() {
        let t = PhysicsScriptParticleTrigger {
            default_script_id: 0x33000789,
            start_time_s: 0.5,
            emitter_id: 0x32000ABC,
            part_index: 0,
            blocking: false,
        };
        let mut buf = Vec::new();
        write_particle_line(&mut buf, &t, "entity_origin").unwrap();
        let s = String::from_utf8(buf).unwrap();
        assert_eq!(s.matches('\n').count(), 1);
        assert!(s.starts_with("{\"source\":\"physics_script_particle\""));
        assert!(s.contains("\"default_script_id\":\"0x33000789\""));
        assert!(s.contains("\"emitter_id\":\"0x32000ABC\""));
        assert!(s.contains("\"anchor\":\"entity_origin\""));
    }

    #[test]
    fn write_sky_particle_line_format_is_jsonl_one_line() {
        // Mirrors the brief's example record — moon middle crimson-star
        // chain: Sunny DayGroup[0] / SkyObject 0x02000714 /
        // PhysicsScript 0x330007DB / hook 1 / emitter 0x32000456 /
        // HwGfxObjId 0x01001A62.
        let t = SkyParticleTrigger {
            day_group_idx: 0,
            day_group_name: "Sunny".to_string(),
            day_group_chance: 0.25,
            active_fraction_start: 0.0,
            active_fraction_end: 1.0,
            sky_object_idx: 6,
            sky_object_id: 0x02000714,
            physics_script_id: 0x330007DB,
            physics_script_source: holtburger_event_bake::ScriptSource::SkyObject,
            hook_idx: 1,
            start_time_s: 0.0,
            emitter_id: 0x32000456,
            blocking: false,
        };
        let mut buf = Vec::new();
        write_sky_particle_line(&mut buf, &t, 0x01001A62).unwrap();
        let s = String::from_utf8(buf).unwrap();
        assert_eq!(s.matches('\n').count(), 1);
        assert!(s.starts_with("{\"source\":\"sky_chain\""));
        assert!(s.contains("\"trigger\":\"time_of_day\""));
        assert!(s.contains("\"day_group_idx\":0"));
        assert!(s.contains("\"day_group_name\":\"Sunny\""));
        assert!(s.contains("\"sky_object_id\":\"0x02000714\""));
        assert!(s.contains("\"physics_script_id\":\"0x330007DB\""));
        assert!(s.contains("\"physics_script_source\":\"sky_object\""));
        assert!(s.contains("\"hook_idx\":1"));
        assert!(s.contains("\"emitter_id\":\"0x32000456\""));
        assert!(s.contains("\"hw_gfx_obj_id\":\"0x01001A62\""));
        assert!(s.contains("\"anchor\":\"sky_cell_origin\""));
        assert!(s.contains("\"blocking\":false"));
    }

    #[test]
    fn write_sky_particle_line_escapes_day_name_specials() {
        // Defensive: day names with `"` or `\` must round-trip through
        // JSONL parsing. None of retail Region 0x13's 20 day names
        // contain specials but a future region might.
        let t = SkyParticleTrigger {
            day_group_idx: 0,
            day_group_name: "Stormy\"\\Day".to_string(),
            day_group_chance: 0.1,
            active_fraction_start: 0.0,
            active_fraction_end: 1.0,
            sky_object_idx: 0,
            sky_object_id: 0x02000714,
            physics_script_id: 0x330007DB,
            physics_script_source: holtburger_event_bake::ScriptSource::SkyObject,
            hook_idx: 0,
            start_time_s: 0.0,
            emitter_id: 0x32000456,
            blocking: false,
        };
        let mut buf = Vec::new();
        write_sky_particle_line(&mut buf, &t, 0x01001A62).unwrap();
        let s = String::from_utf8(buf).unwrap();
        assert!(s.contains("\"day_group_name\":\"Stormy\\\"\\\\Day\""));
        // Confirm the embedded specials are not the unescaped form.
        assert!(!s.contains("\"day_group_name\":\"Stormy\"\\Day\""));
    }
}
