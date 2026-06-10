//! dump_portal_sounds — locate the real portal-space Wave DID.
//!
//! Scans `client_portal.dat`:
//!   1. Does Wave 0x0A000316 (the candidate portal sound) exist?
//!   2. Which SoundTable(s) map `Sound.UI_EnterPortal` (0x6A) /
//!      `UI_ExitPortal` (0x6B), and to which Wave(s)? → the real portal sound.
//!   3. Which SoundTable / Sound-enum (if any) references Wave 0x0A000316? →
//!      tells us what 0x0A000316 actually is.
//!   4. Full dump of the portal object table 0x20000014 (used by Virindi/Test
//!      portals) + the Visible Portalspace Anomaly table 0x2000001E.
//!
//! Usage:
//!   export PATH="$HOME/.cargo/bin:$PATH"
//!   export HOLTBURGER_PORTAL_DAT=$HOME/ac_base_dats/client_portal.dat
//!   cargo run -p holtburger-dat --example dump_portal_sounds

use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::sound_table::SoundTable;
use std::path::PathBuf;
use std::process::ExitCode;

const UI_ENTER_PORTAL: u32 = 0x6A;
const UI_EXIT_PORTAL: u32 = 0x6B;
const CANDIDATE_WAVE: u32 = 0x0A00_0316;

fn resolve_dat_path() -> Option<PathBuf> {
    if let Some(path) = holtburger_dat::utils::get_portal_dat_path() {
        return Some(path);
    }
    if let Ok(home) = std::env::var("HOME") {
        let p = PathBuf::from(home).join("ac_base_dats/client_portal.dat");
        if p.exists() {
            return Some(p);
        }
    }
    None
}

fn main() -> ExitCode {
    let Some(dat_path) = resolve_dat_path() else {
        eprintln!("client_portal.dat not found (set HOLTBURGER_PORTAL_DAT)");
        return ExitCode::FAILURE;
    };
    let dat = match DatDatabase::new(&dat_path) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("open {}: {e}", dat_path.display());
            return ExitCode::FAILURE;
        }
    };
    println!("# dat: {}", dat_path.display());

    // (1) Does the candidate wave exist?
    println!(
        "\n[1] Wave 0x{CANDIDATE_WAVE:08X} present in DAT directory? {}",
        dat.files.contains_key(&CANDIDATE_WAVE)
    );
    let wave_count = dat
        .files
        .keys()
        .filter(|id| (**id & 0xFF00_0000) == 0x0A00_0000)
        .count();
    println!("    (total Wave 0x0A files: {wave_count})");

    // Enumerate every SoundTable once.
    let mut table_ids: Vec<u32> = dat
        .files
        .keys()
        .copied()
        .filter(|id| (*id & 0xFF00_0000) == 0x2000_0000)
        .collect();
    table_ids.sort_unstable();
    println!("\n[*] {} SoundTable (0x20) records total", table_ids.len());

    let mut enter_hits = Vec::new();
    let mut exit_hits = Vec::new();
    let mut candidate_refs = Vec::new();

    for tid in &table_ids {
        let Ok(bytes) = dat.get_file(*tid) else { continue };
        let Ok(table) = SoundTable::unpack(&bytes) else { continue };

        if let Some(es) = table.entries_for(UI_ENTER_PORTAL) {
            for e in es {
                enter_hits.push((*tid, e.wave_did, e.volume, e.probability));
            }
        }
        if let Some(es) = table.entries_for(UI_EXIT_PORTAL) {
            for e in es {
                exit_hits.push((*tid, e.wave_did, e.volume, e.probability));
            }
        }
        // (3) reverse search: who references the candidate wave, as what sound?
        for (sound_enum, sd) in &table.sounds {
            for e in &sd.entries {
                if e.wave_did == CANDIDATE_WAVE {
                    candidate_refs.push((*tid, *sound_enum, e.volume));
                }
            }
        }
    }

    // (2) the real portal sounds
    println!("\n[2] Sound.UI_EnterPortal (0x6A) mappings:");
    if enter_hits.is_empty() {
        println!("    (none — not defined in any object SoundTable; likely a");
        println!("     client-global/UI sound played outside the 0x20 tables)");
    }
    for (tid, wave, vol, prob) in &enter_hits {
        println!("    table 0x{tid:08X}  ->  Wave 0x{wave:08X}  (vol {vol:.2}, prob {prob:.2})");
    }
    println!("    Sound.UI_ExitPortal (0x6B) mappings:");
    for (tid, wave, vol, prob) in &exit_hits {
        println!("    table 0x{tid:08X}  ->  Wave 0x{wave:08X}  (vol {vol:.2}, prob {prob:.2})");
    }

    // (3) what is 0x0A000316?
    println!("\n[3] Who references Wave 0x{CANDIDATE_WAVE:08X}?");
    if candidate_refs.is_empty() {
        println!("    (no SoundTable references it — so it's not a table-mapped");
        println!("     sound; either unused, a direct/UI wave, or the id is off)");
    }
    for (tid, se, vol) in &candidate_refs {
        println!("    table 0x{tid:08X}  Sound-enum 0x{se:02X} ({se})  (vol {vol:.2})");
    }

    // (4) full dumps of the two portal-related tables
    for tid in [0x2000_0014u32, 0x2000_001Eu32] {
        println!("\n[4] Full dump of SoundTable 0x{tid:08X}:");
        let Ok(bytes) = dat.get_file(tid) else {
            println!("    (not in DAT)");
            continue;
        };
        let Ok(table) = SoundTable::unpack(&bytes) else {
            println!("    (parse failed)");
            continue;
        };
        let mut keys: Vec<u32> = table.sounds.keys().copied().collect();
        keys.sort_unstable();
        for k in keys {
            let sd = &table.sounds[&k];
            let waves: Vec<String> = sd
                .entries
                .iter()
                .map(|e| format!("0x{:08X}(v{:.1})", e.wave_did, e.volume))
                .collect();
            println!("    Sound 0x{k:02X} ({k:>3}) -> [{}]", waves.join(", "));
        }
    }

    ExitCode::SUCCESS
}
