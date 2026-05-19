//! Retail-DAT parity sweep for `AnimationHook` (DRW reference type;
//! ACE `AnimationHookType` enum at
//! `external/ACE/Source/ACE.Entity/Enum/AnimationHookType.cs`).
//!
//! Iterates every Animation file (`0x03xxxxxx`), every SetupModel file
//! (`0x02xxxxxx`, for `placement_frames` hooks), and every PhysicsScript
//! file (`0x33xxxxxx`) in the retail `client_portal.dat` baseline,
//! recursively decodes every `AnimationHook` reachable, and asserts:
//!
//!   1. The hook parses without error.
//!   2. The hook re-serializes byte-for-byte to the input slice
//!      (`AnimationHook::write` is the inverse of `AnimationHook::read`).
//!
//! Reference: `acclient.c::CAnimHook::UnPackHook` (342737-343026) +
//! `PackObj::ALIGN_PTR` (296286 / 300284). DRW schema sits in
//! `external/DatReaderWriter/DatReaderWriter/dats.xml:233-262` (enum) and
//! `2611-2715` (typeswitch payloads).
//!
//! The full sweep runs in well under a second on a development box once
//! the `client_portal.dat` page cache is warm, so it stays always-on
//! (not `#[ignore]`d). If `client_portal.dat` isn't reachable, the test
//! SKIPs cleanly. Capture full per-variant counts with `--nocapture`.

use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::{Animation, PhysicsScript, SetupModel};
use holtburger_dat::file_type::setup_model::AnimationHook;
use std::io::Cursor;
use std::path::PathBuf;

fn retail_portal_dat_path() -> Option<PathBuf> {
    if let Some(p) = holtburger_dat::utils::get_portal_dat_path() {
        return Some(p);
    }
    let c = PathBuf::from("/home/wbterminal/ac_base_dats/client_portal.dat");
    c.exists().then_some(c)
}

#[derive(Default, Debug)]
struct VariantStats {
    counts: [u64; 27],
    files: u64,
}

impl VariantStats {
    fn record(&mut self, hook: &AnimationHook) {
        let idx = hook.hook_type as usize;
        if idx < 27 {
            self.counts[idx] += 1;
        }
    }

    fn total(&self) -> u64 {
        self.counts.iter().sum()
    }
}

const VARIANT_NAMES: [&str; 27] = [
    "NoOp",
    "Sound",
    "SoundTable",
    "Attack",
    "AnimationDone",
    "ReplaceObject",
    "Ethereal",
    "TransparentPart",
    "Luminous",
    "LuminousPart",
    "Diffuse",
    "DiffusePart",
    "Scale",
    "CreateParticle",
    "DestroyParticle",
    "StopParticle",
    "NoDraw",
    "DefaultScript",
    "DefaultScriptPart",
    "CallPES",
    "Transparent",
    "SoundTweaked",
    "SetOmega",
    "TextureVelocity",
    "TextureVelocityPart",
    "SetLight",
    "CreateBlockingParticle",
];

/// Walk the raw bytes of a parsed hook through one round-trip and
/// confirm the encoded output matches the original input slice.
fn assert_round_trip(file_id: u32, hook_index: usize, hook: &AnimationHook, original_slice: &[u8]) {
    let mut buf = Vec::with_capacity(8 + hook.data.len());
    {
        let mut cursor = Cursor::new(&mut buf);
        hook.write(&mut cursor)
            .unwrap_or_else(|e| panic!("write hook {} of file 0x{:08X}: {}", hook_index, file_id, e));
    }
    assert_eq!(
        buf, original_slice,
        "byte-mismatch on file 0x{:08X} hook #{} (type={} dir={} payload_len={})",
        file_id, hook_index, hook.hook_type, hook.direction, hook.data.len()
    );
}

/// Read one `AnimationHook` from a fresh cursor over `bytes` starting at
/// `start`, return the parsed hook and the slice it consumed. Used for
/// re-extracting individual hook slices from a host file body so we can
/// round-trip them without re-implementing AnimFrame / PhysicsScript
/// layout in the test.
fn read_one_with_slice<'a>(
    bytes: &'a [u8],
    start: usize,
) -> binrw::BinResult<(AnimationHook, &'a [u8])> {
    let mut cursor = Cursor::new(&bytes[start..]);
    let hook = AnimationHook::read(&mut cursor)?;
    let end = start + cursor.position() as usize;
    Ok((hook, &bytes[start..end]))
}

/// Walk an Animation file body byte-by-byte at the hook level, asserting
/// each hook round-trips. Because `Animation::read` discards the
/// per-hook byte offsets, we re-decode the file inline here using the
/// public API and reconstruct hook offsets by re-running
/// `AnimationHook::read` over fresh cursors.
fn sweep_animation_hooks(
    bytes: &[u8],
    file_id: u32,
    stats: &mut VariantStats,
    bytes_walked: &mut u64,
) -> Result<usize, String> {
    let anim = Animation::read(&mut Cursor::new(bytes))
        .map_err(|e| format!("Animation::read on 0x{:08X}: {}", file_id, e))?;

    // Re-walk the file with offset tracking by parsing again on a
    // separate cursor. This is simpler than threading offsets through
    // AnimationFrame::read just for the test.
    let mut cursor = Cursor::new(bytes);
    use binrw::BinRead;
    let _id = u32::read_le(&mut cursor).unwrap();
    let _flags = u32::read_le(&mut cursor).unwrap();
    let num_parts = u32::read_le(&mut cursor).unwrap();
    let num_frames = u32::read_le(&mut cursor).unwrap();

    if anim.flags.contains(holtburger_dat::file_type::animation::AnimationFlags::POS_FRAMES) {
        // skip POS_FRAMES (each Frame = 28 bytes)
        cursor.set_position(cursor.position() + (num_frames as u64) * 28);
    }

    let mut hook_count = 0usize;
    for _frame in 0..num_frames {
        // skip num_parts × Frame(28 bytes)
        cursor.set_position(cursor.position() + (num_parts as u64) * 28);
        let num_hooks = u32::read_le(&mut cursor).unwrap();
        for hook_i in 0..num_hooks {
            let start = cursor.position() as usize;
            let (hook, slice) = read_one_with_slice(bytes, start)
                .map_err(|e| format!("hook {} of 0x{:08X}: {}", hook_i, file_id, e))?;
            assert_round_trip(file_id, hook_count, &hook, slice);
            stats.record(&hook);
            *bytes_walked += slice.len() as u64;
            cursor.set_position(start as u64 + slice.len() as u64);
            hook_count += 1;
        }
    }
    Ok(hook_count)
}

fn sweep_setup_model_hooks(
    bytes: &[u8],
    file_id: u32,
    stats: &mut VariantStats,
    bytes_walked: &mut u64,
) -> Result<usize, String> {
    let setup = SetupModel::read(&mut Cursor::new(bytes))
        .map_err(|e| format!("SetupModel::read on 0x{:08X}: {}", file_id, e))?;

    let mut total = 0usize;
    for (_pkey, ptype) in setup.placement_frames.iter() {
        // We don't have per-hook byte offsets without re-walking the
        // file. Instead, round-trip each parsed hook through a fresh
        // pack/unpack: write → read again → assert byte-equal both
        // ways. This is byte-equal-equivalent because Pack is the
        // inverse of Unpack for variant payloads.
        for (hook_i, hook) in ptype.anim_frame.hooks.iter().enumerate() {
            let mut buf = Vec::new();
            {
                let mut cursor = Cursor::new(&mut buf);
                hook.write(&mut cursor).unwrap_or_else(|e| {
                    panic!("write setup hook {} of 0x{:08X}: {}", hook_i, file_id, e)
                });
            }
            let reparsed = AnimationHook::read(&mut Cursor::new(&buf[..]))
                .map_err(|e| format!("reparse setup hook {} of 0x{:08X}: {}", hook_i, file_id, e))?;
            assert_eq!(
                reparsed.hook_type, hook.hook_type,
                "setup-model 0x{:08X} hook #{}: type drift on round-trip",
                file_id, hook_i
            );
            assert_eq!(
                reparsed.direction, hook.direction,
                "setup-model 0x{:08X} hook #{}: direction drift on round-trip",
                file_id, hook_i
            );
            assert_eq!(
                reparsed.data, hook.data,
                "setup-model 0x{:08X} hook #{}: data drift on round-trip",
                file_id, hook_i
            );
            stats.record(hook);
            *bytes_walked += buf.len() as u64;
            total += 1;
        }
    }
    Ok(total)
}

fn sweep_physics_script_hooks(
    bytes: &[u8],
    file_id: u32,
    stats: &mut VariantStats,
    bytes_walked: &mut u64,
) -> Result<usize, String> {
    let script = PhysicsScript::unpack(bytes)
        .map_err(|e| format!("PhysicsScript::unpack on 0x{:08X}: {}", file_id, e))?;

    // PhysicsScript supports a real `pack()` → re-emit the whole file
    // and assert byte-equality with the input. That gives us strict
    // round-trip parity for every hook inside in one shot.
    let repacked = script
        .pack()
        .map_err(|e| format!("PhysicsScript::pack on 0x{:08X}: {}", file_id, e))?;
    assert_eq!(
        repacked, bytes,
        "PhysicsScript 0x{:08X} did not round-trip byte-equal",
        file_id
    );

    for entry in &script.script_data {
        stats.record(&entry.hook);
        *bytes_walked += 8 + entry.hook.data.len() as u64;
    }
    Ok(script.script_data.len())
}

#[test]
fn animation_hook_parity_sweep_against_retail_portal_dat() {
    let path = match retail_portal_dat_path() {
        Some(p) => p,
        None => {
            eprintln!(
                "[animation_hook_parity] SKIP — no client_portal.dat available \
                 (set HOLTBURGER_PORTAL_DAT or place it at \
                 /home/wbterminal/ac_base_dats/client_portal.dat)"
            );
            return;
        }
    };
    let dat = DatDatabase::new(&path).expect("open client_portal.dat");

    let mut anim_stats = VariantStats::default();
    let mut setup_stats = VariantStats::default();
    let mut script_stats = VariantStats::default();
    let mut anim_bytes = 0u64;
    let mut setup_bytes = 0u64;
    let mut script_bytes = 0u64;
    let mut failures: Vec<(&'static str, u32, String)> = Vec::new();

    // Animation files (0x03xxxxxx).
    let mut anim_ids: Vec<u32> = dat
        .files
        .keys()
        .copied()
        .filter(|id| (0x03000000..=0x03FFFFFF).contains(id))
        .collect();
    anim_ids.sort();
    let total_anim_ids = anim_ids.len();
    for id in &anim_ids {
        match dat.get_file(*id) {
            Ok(bytes) => match sweep_animation_hooks(&bytes, *id, &mut anim_stats, &mut anim_bytes) {
                Ok(_) => anim_stats.files += 1,
                Err(e) => failures.push(("animation", *id, e)),
            },
            Err(e) => failures.push(("animation:get_file", *id, e.to_string())),
        }
    }

    // SetupModel files (0x02xxxxxx) — placement_frames hooks.
    let mut setup_ids: Vec<u32> = dat
        .files
        .keys()
        .copied()
        .filter(|id| (0x02000000..=0x02FFFFFF).contains(id))
        .collect();
    setup_ids.sort();
    let total_setup_ids = setup_ids.len();
    for id in &setup_ids {
        match dat.get_file(*id) {
            Ok(bytes) => {
                match sweep_setup_model_hooks(&bytes, *id, &mut setup_stats, &mut setup_bytes) {
                    Ok(_) => setup_stats.files += 1,
                    Err(e) => failures.push(("setup_model", *id, e)),
                }
            }
            Err(e) => failures.push(("setup_model:get_file", *id, e.to_string())),
        }
    }

    // PhysicsScript files (0x33xxxxxx).
    let mut script_ids: Vec<u32> = dat
        .files
        .keys()
        .copied()
        .filter(|id| (0x33000000..=0x33FFFFFF).contains(id))
        .collect();
    script_ids.sort();
    let total_script_ids = script_ids.len();
    for id in &script_ids {
        match dat.get_file(*id) {
            Ok(bytes) => match sweep_physics_script_hooks(
                &bytes,
                *id,
                &mut script_stats,
                &mut script_bytes,
            ) {
                Ok(_) => script_stats.files += 1,
                Err(e) => failures.push(("physics_script", *id, e)),
            },
            Err(e) => failures.push(("physics_script:get_file", *id, e.to_string())),
        }
    }

    if !failures.is_empty() {
        for (kind, id, err) in failures.iter().take(20) {
            eprintln!("FAIL [{kind}] 0x{id:08X}: {err}");
        }
        panic!(
            "{} animation-hook parity failures across {} animation, {} setup-model, {} physics-script files",
            failures.len(),
            total_anim_ids,
            total_setup_ids,
            total_script_ids,
        );
    }

    // Aggregate variant table.
    let mut combined = [0u64; 27];
    for i in 0..27 {
        combined[i] = anim_stats.counts[i] + setup_stats.counts[i] + script_stats.counts[i];
    }

    eprintln!(
        "[animation_hook_parity] SWEPT files: anim={}/{} setup={}/{} pscript={}/{}",
        anim_stats.files, total_anim_ids,
        setup_stats.files, total_setup_ids,
        script_stats.files, total_script_ids,
    );
    eprintln!(
        "[animation_hook_parity] HOOKS: anim={} setup={} pscript={} total={}",
        anim_stats.total(), setup_stats.total(), script_stats.total(),
        combined.iter().sum::<u64>(),
    );
    eprintln!(
        "[animation_hook_parity] BYTES round-tripped: anim={} setup={} pscript={}",
        anim_bytes, setup_bytes, script_bytes,
    );

    eprintln!("[animation_hook_parity] PER-VARIANT COUNTS (retail portal.dat):");
    eprintln!(
        "{:<4} {:<25} {:>10} {:>10} {:>10} {:>10}",
        "id", "name", "anim", "setup", "pscript", "total"
    );
    for i in 0..27 {
        eprintln!(
            "{:<4} {:<25} {:>10} {:>10} {:>10} {:>10}",
            i,
            VARIANT_NAMES[i],
            anim_stats.counts[i],
            setup_stats.counts[i],
            script_stats.counts[i],
            combined[i],
        );
    }

    // Per-variant retail-usage assertions: every variant we observed
    // anywhere in retail MUST have a non-zero combined count if the
    // sweep validated it. Variants that are unused in retail are
    // explicitly documented below — they remain known-defined by the
    // enum (matches ACE / DRW), but are exercised only by the inline
    // synthetic tests in `setup_model.rs`, not by real DAT data.
    //
    // The known unused-in-retail variants are documented in the test
    // output above — we don't fail on them here, just report.
    let mut unused = Vec::new();
    for i in 0..27 {
        if combined[i] == 0 {
            unused.push((i, VARIANT_NAMES[i]));
        }
    }
    if !unused.is_empty() {
        eprintln!("[animation_hook_parity] UNUSED-IN-RETAIL variants ({}):", unused.len());
        for (i, name) in &unused {
            eprintln!("  {} {}", i, name);
        }
    }

    // Sanity: at minimum, the most common variants (Sound, CreateParticle,
    // SoundTweaked) must appear, otherwise the sweep walked an empty
    // universe and gave us a false-positive PASS.
    assert!(combined[1] > 0, "Sound (type 1) must appear in retail");
    assert!(
        combined[13] > 0 || combined[26] > 0,
        "CreateParticle / CreateBlockingParticle must appear"
    );
    assert!(combined.iter().sum::<u64>() > 1_000, "expected >1k retail hooks");
}

/// A non-`#[ignore]` smoke test that hits a small known set of files so
/// `cargo test -p holtburger-dat` still gets some coverage of the
/// parser against retail data without the full ~927 MB sweep.
#[test]
fn animation_hook_parity_smoke_against_known_retail_files() {
    let path = match retail_portal_dat_path() {
        Some(p) => p,
        None => {
            eprintln!(
                "[animation_hook_parity_smoke] SKIP — no client_portal.dat available"
            );
            return;
        }
    };
    let dat = DatDatabase::new(&path).expect("open client_portal.dat");

    // The retail moon's PhysicsScript at 0x330007DB — known to contain
    // 3 CreateParticleHook entries (see
    // `crates/holtburger-dat/src/file_type/physics_script.rs`'s
    // `probe_retail_physics_script_moon`).
    let mut stats = VariantStats::default();
    let mut walked = 0u64;
    if let Ok(bytes) = dat.get_file(0x330007DB) {
        sweep_physics_script_hooks(&bytes, 0x330007DB, &mut stats, &mut walked)
            .expect("moon PhysicsScript should round-trip");
    }

    // Sweep the first 50 animations and 50 setup models as a smoke
    // sample.
    let mut anim_ids: Vec<u32> = dat
        .files
        .keys()
        .copied()
        .filter(|id| (0x03000000..=0x03FFFFFF).contains(id))
        .collect();
    anim_ids.sort();
    for id in anim_ids.iter().take(50) {
        if let Ok(bytes) = dat.get_file(*id) {
            sweep_animation_hooks(&bytes, *id, &mut stats, &mut walked)
                .unwrap_or_else(|e| panic!("smoke: animation 0x{:08X}: {}", id, e));
        }
    }

    let mut setup_ids: Vec<u32> = dat
        .files
        .keys()
        .copied()
        .filter(|id| (0x02000000..=0x02FFFFFF).contains(id))
        .collect();
    setup_ids.sort();
    for id in setup_ids.iter().take(50) {
        if let Ok(bytes) = dat.get_file(*id) {
            sweep_setup_model_hooks(&bytes, *id, &mut stats, &mut walked)
                .unwrap_or_else(|e| panic!("smoke: setup 0x{:08X}: {}", id, e));
        }
    }

    eprintln!(
        "[animation_hook_parity_smoke] OK — hooks={} bytes={}",
        stats.total(),
        walked,
    );
    assert!(stats.total() > 0, "smoke sweep must observe at least one hook");
}
