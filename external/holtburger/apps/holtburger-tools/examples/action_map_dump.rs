// Standalone analysis: dump (dwKey, label) tuples + histogram of device bytes.
// Compile + run with rustc + the holtburger-dat crate via cargo.
//
// Easier: just symlink this as a workspace member or use rustc directly.
// We invoke it via `cargo run --release --example action_map_dump` after
// dropping it into apps/holtburger-tools/examples/.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let am_path = Path::new("/mnt/wbterminal1/tmp/claude-scratch/actionmap/action_map.bin");
    let st_path = Path::new("/mnt/wbterminal1/tmp/claude-scratch/actionmap/string_table.bin");
    let am_bytes = fs::read(am_path)?;
    let st_bytes = fs::read(st_path)?;

    let st = holtburger_dat::file_type::StringTable::unpack(&st_bytes)?;
    let am = holtburger_dat::file_type::ActionMap::unpack(&am_bytes)?;

    println!("ActionMap 0x{:08X} — {} input_maps, string_table_data_id=0x{:08X}",
        am.id, am.input_maps.len(), am.string_table_data_id);

    let mut device_hist: BTreeMap<u8, u32> = BTreeMap::new();
    let mut subctrl_hist: BTreeMap<u8, u32> = BTreeMap::new();
    let mut ofs_hist: BTreeMap<u16, u32> = BTreeMap::new();

    // For each outer key, list inner action labels.
    let mut rows: Vec<(u32, Vec<String>)> = vec![];
    for (dw_key, values) in &am.input_maps {
        let mut labels = vec![];
        for (_inner_key, v) in values {
            let lbl = st.strings.get(&v.user_binding.action_name)
                .and_then(|s| s.strings.first().cloned())
                .unwrap_or_else(|| format!("(hash 0x{:08X})", v.user_binding.action_name));
            labels.push(lbl);
        }
        rows.push((*dw_key, labels));
        let dev = (*dw_key & 0xFF) as u8;
        let sub = ((*dw_key >> 8) & 0xFF) as u8;
        let ofs = ((*dw_key >> 16) & 0xFFFF) as u16;
        *device_hist.entry(dev).or_insert(0) += 1;
        *subctrl_hist.entry(sub).or_insert(0) += 1;
        *ofs_hist.entry(ofs).or_insert(0) += 1;
    }
    rows.sort_by_key(|(k, _)| *k);

    println!("\n=== Device-byte histogram ===");
    for (k, v) in &device_hist {
        println!("  0x{:02X}  {:>3}", k, v);
    }
    println!("\n=== SubControl-byte histogram ===");
    for (k, v) in &subctrl_hist {
        println!("  0x{:02X}  {:>3}", k, v);
    }
    println!("\n=== ofsKey histogram (top 30) ===");
    let mut ofs_pairs: Vec<_> = ofs_hist.iter().collect();
    ofs_pairs.sort_by_key(|(_, v)| std::cmp::Reverse(**v));
    for (k, v) in ofs_pairs.iter().take(30) {
        println!("  0x{:04X}  {:>3}", k, v);
    }

    println!("\n=== Per-entry table (sorted by dwKey) ===");
    for (dw_key, labels) in &rows {
        let dev = (*dw_key & 0xFF) as u8;
        let sub = ((*dw_key >> 8) & 0xFF) as u8;
        let ofs = ((*dw_key >> 16) & 0xFFFF) as u16;
        println!("0x{:08X}  dev=0x{:02X} sub=0x{:02X} ofs=0x{:04X}  -> [{}]",
            dw_key, dev, sub, ofs, labels.join(", "));
    }
    Ok(())
}
