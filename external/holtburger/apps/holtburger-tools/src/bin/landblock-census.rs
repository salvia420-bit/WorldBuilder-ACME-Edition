//! landblock-census — enumerate the content-bearing landblocks of Dereth.
//!
//! Phase 0 of the full-world bake/verify plan
//! (`docs/full-world-bake-and-verify-plan-2026-05-30.md`). Produces the
//! work-list that sizes everything downstream: which of the 65,025 grid
//! landblocks are worth baking scenery for + verifying, vs the open ocean we
//! skip.
//!
//! A landblock is CONTENT-BEARING iff it has explicit objects
//! (`CellLandblock.has_objects`) OR at least one non-water terrain vertex.
//! Pure-ocean LBs with no structures are skipped — but the all-water LBs that
//! DO carry structures (piers, bridges, lighthouses) are kept via the
//! `has_objects` arm of the union, so a naive "drop all water" filter can't
//! lose them. Dungeons are captured too: EnvCell-bearing LBs are a strict
//! subset of the `has_objects` set.
//!
//! Reads only `client_cell_1.dat` — no ACE, no network. One pass over the
//! cell.dat id table (~805k ids), unpacking the ~65k CellLandblock records.
//!
//! Usage:
//!   landblock-census --dat-dir ~/ac_base_dats --out /path/to/census/
//! Emits:
//!   <out>/content-landblocks.txt  one `0xLLLL` per line; feed bakes via `--landblocks @file`
//!   <out>/dungeon-landblocks.txt  the EnvCell-bearing subset (the PVS-pass work-list)

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use clap::Parser;
use holtburger_dat::DatDatabase;
use holtburger_dat::landblock::CellLandblock;

/// Water terrain-type codes — `acclient.h:4130-4134` `LandDefs::TerrainType`
/// 0x10..=0x14 (WaterRunning, WaterStandingFresh, WaterShallowSea,
/// WaterShallowStillSea, WaterDeepSea). A landblock whose 81 terrain vertices
/// are ALL in this range is open water.
const WATER_MIN: u8 = 0x10;
const WATER_MAX: u8 = 0x14;

#[derive(Parser)]
#[command(about = "Enumerate content-bearing (non-ocean) landblocks from cell.dat")]
struct Args {
    /// Directory containing client_cell_1.dat (canonical: ~/ac_base_dats).
    #[arg(long)]
    dat_dir: PathBuf,
    /// Output directory for content-landblocks.txt + dungeon-landblocks.txt.
    #[arg(long)]
    out: PathBuf,
}

fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    let cell_dat = args.dat_dir.join("client_cell_1.dat");
    let db = DatDatabase::new(&cell_dat)
        .map_err(|e| anyhow::anyhow!("open {}: {e}", cell_dat.display()))?;

    // One pass over every cell.dat record id, bucketed by the low-16 tag:
    //   0xFFFF          -> CellLandblock (terrain — 1 per grid LB)
    //   0xFFFE          -> LandblockInfo (explicit objects/buildings)
    //   0x0100..=0xFFFD -> EnvCell (indoor/dungeon)
    //   0x0001..=0x0040 -> outdoor LandCell (ignored here)
    let mut cell_lb_ids: Vec<u32> = Vec::new();
    let mut lb_with_lbi: BTreeSet<u16> = BTreeSet::new();
    let mut lb_with_envcell: BTreeSet<u16> = BTreeSet::new();
    for &id in db.files.keys() {
        let low = (id & 0xFFFF) as u16;
        let lb = (id >> 16) as u16;
        match low {
            0xFFFF => cell_lb_ids.push(id),
            0xFFFE => {
                lb_with_lbi.insert(lb);
            }
            0x0100..=0xFFFD => {
                lb_with_envcell.insert(lb);
            }
            _ => {}
        }
    }
    cell_lb_ids.sort_unstable();

    let mut content: BTreeSet<u16> = BTreeSet::new();
    let mut ocean = 0usize;
    let mut land = 0usize;
    let mut has_objects = 0usize;
    let mut ocean_structs = 0usize;
    let mut parse_fail = 0usize;

    for &id in &cell_lb_ids {
        let lb = (id >> 16) as u16;
        let bytes = match db.get_file(id) {
            Ok(b) => b,
            Err(_) => {
                parse_fail += 1;
                continue;
            }
        };
        let clb = match CellLandblock::unpack(&bytes) {
            Ok(c) => c,
            Err(_) => {
                parse_fail += 1;
                continue;
            }
        };
        let has_obj = clb.has_objects != 0;
        // all-water iff every one of the 9x9 vertices is a water terrain type.
        let all_water = (0usize..9)
            .all(|x| (0usize..9).all(|y| (WATER_MIN..=WATER_MAX).contains(&clb.terrain_type(x, y))));

        if has_obj {
            has_objects += 1;
        }
        if all_water {
            ocean += 1;
        } else {
            land += 1;
        }
        if all_water && has_obj {
            ocean_structs += 1;
        }
        // content-bearing = has explicit objects OR has any non-water terrain.
        if has_obj || !all_water {
            content.insert(lb);
        }
    }

    // Every dungeon (EnvCell-bearing) LB should be content-bearing; flag if not.
    let dungeons_not_content = lb_with_envcell.difference(&content).count();

    std::fs::create_dir_all(&args.out)?;
    let content_path = args.out.join("content-landblocks.txt");
    let dungeon_path = args.out.join("dungeon-landblocks.txt");
    write_list(&content_path, content.iter().copied())?;
    write_list(&dungeon_path, lb_with_envcell.iter().copied())?;

    println!("landblock-census — source {}", cell_dat.display());
    println!("  CellLandblock records (grid LBs) : {}", cell_lb_ids.len());
    println!("  all-water (ocean)                : {ocean}");
    println!("  has-land (>=1 non-water vertex)  : {land}");
    println!("  has_objects flag set             : {has_objects}");
    println!("  LandblockInfo (0xFFFE) present   : {}", lb_with_lbi.len());
    println!("  all-water WITH structures        : {ocean_structs}");
    println!("  dungeon (EnvCell-bearing)        : {}", lb_with_envcell.len());
    println!("  parse failures                   : {parse_fail}");
    println!(
        "  => CONTENT-BEARING (bake+verify) : {}  ({land} land + {ocean_structs} ocean-with-structures)",
        content.len()
    );
    if dungeons_not_content != 0 {
        println!("  WARNING: {dungeons_not_content} dungeon LBs are NOT content-bearing (unexpected)");
    }
    println!("wrote {} ({} ids)", content_path.display(), content.len());
    println!(
        "wrote {} ({} ids)",
        dungeon_path.display(),
        lb_with_envcell.len()
    );
    Ok(())
}

fn write_list(path: &Path, ids: impl Iterator<Item = u16>) -> anyhow::Result<()> {
    use std::fmt::Write as _;
    let mut s = String::new();
    for id in ids {
        let _ = writeln!(s, "0x{id:04X}");
    }
    std::fs::write(path, s)?;
    Ok(())
}
