// Cross-check the empirical hypothesis that
// `QualifiedControl.action_hash` (DRW's `Unknown` field) equals the
// ActionMap inner-dict key in the same input_map category.
//
// Run: cargo run --release --example keymap_actionmap_xcheck
//
// Requires the pre-exported bins at
// /mnt/wbterminal1/tmp/claude-scratch/{keymap,actionmap}/.

use std::collections::BTreeSet;
use std::fs;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let km_path = "/mnt/wbterminal1/tmp/claude-scratch/keymap/keymap_0.bin";
    let am_path = "/mnt/wbterminal1/tmp/claude-scratch/actionmap/action_map.bin";
    let km = holtburger_dat::file_type::KeyMap::unpack(&fs::read(km_path)?)?;
    let am = holtburger_dat::file_type::ActionMap::unpack(&fs::read(am_path)?)?;

    let km_cats: BTreeSet<u32> = km.input_maps.keys().copied().collect();
    let am_cats: BTreeSet<u32> = am.input_maps.keys().copied().collect();
    println!("KeyMap categories: {} | ActionMap categories: {}", km_cats.len(), am_cats.len());
    println!("KeyMap-only: {:?}", km_cats.difference(&am_cats).collect::<Vec<_>>());
    println!("ActionMap-only: {:?}", am_cats.difference(&km_cats).collect::<Vec<_>>());

    let mut total_hits = 0usize;
    let mut total_misses = 0usize;
    for cat in km_cats {
        let km_hashes: BTreeSet<u32> = km.input_maps[&cat].mappings.iter().map(|m| m.action_hash).collect();
        let am_hashes: BTreeSet<u32> = am.input_maps.get(&cat).map(|m| m.keys().copied().collect()).unwrap_or_default();
        let hits = km_hashes.intersection(&am_hashes).count();
        let misses = km_hashes.difference(&am_hashes).count();
        total_hits += hits;
        total_misses += misses;
        if misses > 0 || cat == 0x00000004 {
            println!("cat 0x{cat:08X}: {} km-distinct hashes, {} action-map hashes -> {hits} hits, {misses} miss",
                km_hashes.len(), am_hashes.len());
        }
    }
    println!("\nTotal: {total_hits} hits, {total_misses} miss");
    Ok(())
}
