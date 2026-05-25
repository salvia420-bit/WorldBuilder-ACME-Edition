// Dump retail KeyMap records (DAT type 0x14, "MasterInputMap").
//
// Reads the pre-exported bins at /mnt/wbterminal1/tmp/claude-scratch/keymap/
// (already extracted via dat-tool export). Prints input-map categories,
// device list, and per-mapping `(key, modifier, activation, unknown)`
// rows so the JS resolver knows what shape to expect.
//
// Run: cargo run --release --example keymap_dump

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let candidates = [
        ("/mnt/wbterminal1/tmp/claude-scratch/keymap/keymap_0.bin", 0x14000000u32),
        ("/mnt/wbterminal1/tmp/claude-scratch/keymap/keymap_2.bin", 0x14000002u32),
    ];

    for (path_str, expected_id) in &candidates {
        let path = Path::new(path_str);
        if !path.exists() {
            println!("(skipped) {path_str} not found");
            continue;
        }
        let bytes = fs::read(path)?;
        let km = holtburger_dat::file_type::KeyMap::unpack(&bytes)?;

        println!("\n=========================================");
        println!("KeyMap 0x{:08X} — {} bytes", km.id, bytes.len());
        if km.id != *expected_id {
            println!("  WARNING: expected id 0x{expected_id:08X}");
        }
        println!("  name: {:?}", km.name);
        println!("  guid: {:02X?}", km.guid_map);
        println!("  devices ({}):", km.devices.len());
        for (i, dev) in km.devices.iter().enumerate() {
            let kind = match dev.device_type {
                0 => "Invalid",
                1 => "Keyboard",
                2 => "Mouse",
                3 => "Joystick",
                4 => "Virtual",
                _ => "?",
            };
            println!("    [{i}] type=0x{:02X} ({kind})  guid={:02X?}", dev.device_type, dev.guid);
        }
        println!("  meta_keys ({}):", km.meta_keys.len());
        for (i, mk) in km.meta_keys.iter().enumerate() {
            println!("    [{i}] key=0x{:08X} modifier=0x{:08X}", mk.key, mk.modifier);
        }

        // Histograms across all mappings.
        let mut key_dev_hist: BTreeMap<u8, u32> = BTreeMap::new();
        let mut key_sub_hist: BTreeMap<u8, u32> = BTreeMap::new();
        let mut key_ofs_hist: BTreeMap<u16, u32> = BTreeMap::new();
        let mut activation_hist: BTreeMap<u32, u32> = BTreeMap::new();
        let mut action_hash_hist: BTreeMap<u32, u32> = BTreeMap::new();
        let mut total_mappings = 0usize;

        let mut sorted_maps: Vec<(&u32, &holtburger_dat::file_type::CInputMap)> =
            km.input_maps.iter().collect();
        sorted_maps.sort_by_key(|(k, _)| **k);

        println!("\n  input_maps ({}):", km.input_maps.len());
        for (cat, cinput) in &sorted_maps {
            println!("    category 0x{:08X} ({} mappings):", cat, cinput.mappings.len());
            for (i, m) in cinput.mappings.iter().enumerate() {
                let dev = (m.key.key & 0xFF) as u8;
                let sub = ((m.key.key >> 8) & 0xFF) as u8;
                let ofs = ((m.key.key >> 16) & 0xFFFF) as u16;
                *key_dev_hist.entry(dev).or_insert(0) += 1;
                *key_sub_hist.entry(sub).or_insert(0) += 1;
                *key_ofs_hist.entry(ofs).or_insert(0) += 1;
                *activation_hist.entry(m.activation).or_insert(0) += 1;
                *action_hash_hist.entry(m.action_hash).or_insert(0) += 1;
                total_mappings += 1;
                println!(
                    "      [{i:>3}] key=0x{:08X} (dev=0x{dev:02X} sub=0x{sub:02X} ofs=0x{ofs:04X}) mod=0x{:08X} act=0x{:08X} action_hash=0x{:08X}",
                    m.key.key, m.key.modifier, m.activation, m.action_hash,
                );
            }
        }

        println!("\n  totals: {} mappings", total_mappings);

        println!("\n  === key.device-byte histogram ===");
        for (k, v) in &key_dev_hist {
            println!("    0x{k:02X}  {v:>4}");
        }
        println!("  === key.subcontrol-byte histogram ===");
        for (k, v) in &key_sub_hist {
            println!("    0x{k:02X}  {v:>4}");
        }
        println!("  === key.ofsKey histogram (top 24) ===");
        let mut ofs_pairs: Vec<_> = key_ofs_hist.iter().collect();
        ofs_pairs.sort_by_key(|(_, v)| std::cmp::Reverse(**v));
        for (k, v) in ofs_pairs.iter().take(24) {
            println!("    0x{k:04X}  {v:>4}");
        }
        println!("  === activation histogram (top 8) ===");
        let mut act_pairs: Vec<_> = activation_hist.iter().collect();
        act_pairs.sort_by_key(|(_, v)| std::cmp::Reverse(**v));
        for (k, v) in act_pairs.iter().take(8) {
            println!("    0x{k:08X}  {v:>4}");
        }
        println!("  === action_hash histogram (top 12; >1 means dual-binding) ===");
        let mut ah_pairs: Vec<_> = action_hash_hist.iter().collect();
        ah_pairs.sort_by_key(|(_, v)| std::cmp::Reverse(**v));
        for (k, v) in ah_pairs.iter().take(12) {
            println!("    0x{k:08X}  {v:>4}");
        }
    }

    Ok(())
}
