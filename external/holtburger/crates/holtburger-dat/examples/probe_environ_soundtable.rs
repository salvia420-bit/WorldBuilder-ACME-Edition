// Find the UI SoundTable DID that holds the AdminEnvirons environment-sound
// slots. Retail plays EnvironChangeType 0x65-0x7B as SoundType (= +0x11)
// 0x76-0x8A (Sound_UI_Roar .. Sound_UI_Thunder6) from ClientUISystem::
// GetUISoundTable (acclient.c:396438+). The DID isn't a literal in the decomp,
// so scan every 0x20 SoundTable in portal.dat for keys in 0x76..=0x8A.
use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::SoundTable;
use std::io::Cursor;

fn main() {
    let db = DatDatabase::new("/home/wbterminal/ac_base_dats/client_portal.dat").unwrap();
    let mut ids: Vec<u32> = db
        .files
        .keys()
        .copied()
        .filter(|&id| (id >> 24) == 0x20)
        .collect();
    ids.sort();
    println!("0x20 SoundTables in portal.dat: {}", ids.len());

    let environ_range = 0x76u32..=0x8A; // SoundType for environ sounds
    let mut hits = 0;
    for &id in &ids {
        let Ok(b) = db.get_file(id) else { continue };
        let Ok(st) = SoundTable::read(&mut Cursor::new(b)) else { continue };
        let mut present: Vec<u32> = st
            .sounds
            .keys()
            .copied()
            .filter(|k| environ_range.contains(k))
            .collect();
        if present.is_empty() {
            continue;
        }
        present.sort();
        hits += 1;
        print!(
            "0x{:08X}: {} total sounds, {} environ keys: ",
            id,
            st.sounds.len(),
            present.len()
        );
        for k in &present {
            let wave = st
                .sounds
                .get(k)
                .and_then(|d| d.entries.first())
                .map(|e| e.wave_did)
                .unwrap_or(0);
            print!("0x{:X}->0x{:08X} ", k, wave);
        }
        println!();
    }
    println!("\n{} SoundTable(s) carry environ slots (0x76-0x8A).", hits);

    // Sanity: also report which tables carry the AMBIENT slots (Ambient1-8 =
    // SoundType 0x46-0x4D) for cross-reference (these are the region STBs).
    let mut amb_tables = 0;
    for &id in &ids {
        let Ok(b) = db.get_file(id) else { continue };
        let Ok(st) = SoundTable::read(&mut Cursor::new(b)) else { continue };
        if st.sounds.keys().any(|k| (0x46..=0x4D).contains(k)) {
            amb_tables += 1;
        }
    }
    println!("(cross-ref: {} tables carry ambient slots 0x46-0x4D)", amb_tables);
}
