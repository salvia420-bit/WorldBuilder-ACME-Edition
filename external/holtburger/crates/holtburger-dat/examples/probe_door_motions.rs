//! probe_door_motions — READ-ONLY DAT probe for the animation consolidation
//! (docs/animation-audit §5 Step 3, door). Answers ONE question: do door
//! MotionTables carry On (0x4000000b) / Off (0x4000000c) cycles with real
//! keyframes? If yes, the unified-authority door fix is a ~15-line wire-up
//! (resolve via the cycle bake, like missile); if no, SetupModel hinge-frame
//! extraction is required. Writes nothing.
//!
//!   HOLTBURGER_PORTAL_DAT=$HOME/ac_base_dats/client_portal.dat \
//!     cargo run --quiet -p holtburger-dat --example probe_door_motions

use binrw::io::Cursor;
use holtburger_dat::file_type::MotionTable;
use holtburger_dat::DatDatabase;
use std::path::PathBuf;
use std::process::ExitCode;

const ON_LOW: u32 = 0x000b; // MotionCommand::On  (0x4000000b) — door open
const OFF_LOW: u32 = 0x000c; // MotionCommand::Off (0x4000000c) — door close
const MAX_REPORT: usize = 25;

fn main() -> ExitCode {
    let dat_path = std::env::var("HOLTBURGER_PORTAL_DAT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("client_portal.dat"));
    if !dat_path.exists() {
        eprintln!("client_portal.dat not found: set HOLTBURGER_PORTAL_DAT");
        return ExitCode::FAILURE;
    }
    let dat = match DatDatabase::new(&dat_path) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("DatDatabase::new failed: {e}");
            return ExitCode::FAILURE;
        }
    };

    println!("Scanning MotionTables 0x09000000..=0x0900FFFF for On/Off door cycles...");
    let mut found = 0usize;
    let mut scanned = 0usize;
    for id in 0x0900_0000u32..=0x0900_FFFF {
        let bytes = match dat.get_file(id) {
            Ok(b) => b,
            Err(_) => continue,
        };
        scanned += 1;
        let mt = match MotionTable::read(&mut Cursor::new(&bytes)) {
            Ok(m) => m,
            Err(_) => continue,
        };
        // Door cycles: any cycle key whose low-16 is On or Off.
        let door_keys: Vec<u32> = mt
            .cycles
            .keys()
            .copied()
            .filter(|k| (*k & 0xFFFF) == ON_LOW || (*k & 0xFFFF) == OFF_LOW)
            .collect();
        if door_keys.is_empty() {
            continue;
        }
        found += 1;
        if found <= MAX_REPORT {
            println!(
                "\nMT 0x{id:08X}  default_style=0x{:08X}  cycles={} links={}",
                mt.default_style,
                mt.cycles.len(),
                mt.links.len(),
            );
            for k in door_keys {
                let low = k & 0xFFFF;
                let name = if low == ON_LOW { "On " } else { "Off" };
                if let Some(md) = mt.cycles.get(&k) {
                    let n = md.anims.len();
                    let detail = md
                        .anims
                        .first()
                        .map(|a| {
                            format!(
                                "anim_id=0x{:08X} low={} high={} fps={:.1}",
                                a.anim_id, a.low_frame, a.high_frame, a.framerate
                            )
                        })
                        .unwrap_or_else(|| "(no anims)".to_string());
                    println!("   {name} key=0x{k:08X}  anims={n}  {detail}");
                }
            }
        }
    }

    println!(
        "\n==== {found} door MotionTable(s) with On/Off cycles (of {scanned} MTs scanned) ===="
    );
    if found == 0 {
        println!("VERDICT: NO door On/Off cycles → unified door needs SetupModel hinge extraction.");
    } else {
        println!("VERDICT: doors DO carry On/Off cycles → unified door = resolve via the cycle bake.");
    }
    ExitCode::SUCCESS
}
