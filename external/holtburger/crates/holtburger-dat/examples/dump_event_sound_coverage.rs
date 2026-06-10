//! dump_event_sound_coverage — cross-reference the Sound enums ACE actually
//! triggers (`GameMessageSound`) against which SoundTables map them, so we can
//! classify each server sound event as resolvable / gap.
//!
//!   export PATH="$HOME/.cargo/bin:$PATH"
//!   export HOLTBURGER_PORTAL_DAT=$HOME/ac_base_dats/client_portal.dat
//!   cargo run -p holtburger-dat --example dump_event_sound_coverage

use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::sound_table::SoundTable;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::ExitCode;

// (Sound enum value, name) — the set ACE's GameMessageSound call sites use,
// plus the dynamic Eat/Drink/Open/Close cases.
const TARGETS: &[(u32, &str)] = &[
    (0x0C, "Wound1"), (0x0E, "Wound3"), (0x0F, "Death1"),
    (0x2F, "Collision"), (0x30, "HitFlesh1"),
    (0x40, "Eat1"), (0x41, "Drink1"), (0x42, "Open"), (0x43, "Close"),
    (0x51, "LifestoneOn"), (0x69, "Lockpicking"),
    (0x8B, "RaiseTrait"), (0x8C, "WieldObject"), (0x8D, "UnwieldObject"),
    (0x8E, "ReceiveItem"), (0x8F, "PickUpItem"), (0x90, "DropItem"),
    (0x91, "ResistSpell"), (0x92, "PicklockFail"), (0x93, "LockSuccess"),
    (0x94, "OpenFailDueToLock"), (0x95, "TriggerActivated"),
    (0x96, "SpellExpire"), (0x97, "ItemManaDepleted"),
    (0x6A, "UI_EnterPortal"), (0x6B, "UI_ExitPortal"),
];

fn resolve_dat_path() -> Option<PathBuf> {
    if let Some(p) = holtburger_dat::utils::get_portal_dat_path() {
        return Some(p);
    }
    std::env::var("HOME").ok().map(PathBuf::from).and_then(|h| {
        let p = h.join("ac_base_dats/client_portal.dat");
        p.exists().then_some(p)
    })
}

fn main() -> ExitCode {
    let Some(path) = resolve_dat_path() else {
        eprintln!("client_portal.dat not found");
        return ExitCode::FAILURE;
    };
    let Ok(dat) = DatDatabase::new(&path) else {
        eprintln!("open failed");
        return ExitCode::FAILURE;
    };

    let mut table_ids: Vec<u32> = dat
        .files
        .keys()
        .copied()
        .filter(|id| (*id & 0xFF00_0000) == 0x2000_0000)
        .collect();
    table_ids.sort_unstable();

    // enum -> Vec<(table_id, wave)>
    let mut enum_tables: BTreeMap<u32, Vec<(u32, u32)>> = BTreeMap::new();
    // table_id -> count of TARGET enums it covers (to find the player/UI table)
    let mut table_cover: BTreeMap<u32, usize> = BTreeMap::new();

    for tid in &table_ids {
        let Ok(bytes) = dat.get_file(*tid) else { continue };
        let Ok(table) = SoundTable::unpack(&bytes) else { continue };
        for (val, _name) in TARGETS {
            if let Some(es) = table.entries_for(*val) {
                if let Some(first) = es.first() {
                    enum_tables.entry(*val).or_default().push((*tid, first.wave_did));
                    *table_cover.entry(*tid).or_default() += 1;
                }
            }
        }
    }

    println!("# {} SoundTables scanned\n", table_ids.len());

    println!("[A] Per-event resolvability ({} enums ACE triggers):", TARGETS.len());
    let mut gaps = Vec::new();
    for (val, name) in TARGETS {
        match enum_tables.get(val) {
            Some(hits) => {
                let n = hits.len();
                let sample = &hits[0];
                println!(
                    "  0x{val:02X} {name:<18} RESOLVABLE in {n:>3} table(s)  e.g. table 0x{:08X} -> Wave 0x{:08X}",
                    sample.0, sample.1
                );
            }
            None => {
                println!("  0x{val:02X} {name:<18} *** NO SoundTable maps it ***");
                gaps.push((*val, *name));
            }
        }
    }

    println!("\n[B] Genuine gaps (no table maps these → UI/engine-direct, need special handling):");
    if gaps.is_empty() {
        println!("    (none — every triggered enum is resolvable in some table)");
    }
    for (val, name) in &gaps {
        println!("    0x{val:02X} {name}");
    }

    // [C] Which table covers the most TARGET enums? = the character/UI table the
    // player must hydrate to for the bulk of action sounds (0x8B-0x97).
    let mut ranked: Vec<(u32, usize)> = table_cover.into_iter().collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1));
    println!("\n[C] Top SoundTables by TARGET-enum coverage (player/UI candidates):");
    for (tid, cnt) in ranked.iter().take(6) {
        let Ok(bytes) = dat.get_file(*tid) else { continue };
        let Ok(table) = SoundTable::unpack(&bytes) else { continue };
        let covered: Vec<String> = TARGETS
            .iter()
            .filter(|(v, _)| table.entries_for(*v).map(|e| !e.is_empty()).unwrap_or(false))
            .map(|(v, n)| format!("{n}(0x{v:02X})"))
            .collect();
        println!("    table 0x{tid:08X}: covers {cnt}/{} -> {}", TARGETS.len(), covered.join(", "));
    }

    ExitCode::SUCCESS
}
