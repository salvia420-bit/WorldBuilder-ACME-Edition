//! Parse every retail Font record from `client_portal.dat` and assert
//! shape invariants. Skipped when `HOLTBURGER_PORTAL_DAT` is unset (and
//! no fallback DAT is discoverable).

use binrw::BinRead;
use binrw::io::Cursor;
use holtburger_dat::file_type::Font;
use holtburger_dat::{DatDatabase, DatFileType};

mod common;
use common::get_portal_dat_path;

#[test]
fn all_retail_fonts_parse() {
    let Some(dat_path) = get_portal_dat_path() else {
        println!("Skipping font parity test: portal.dat not found");
        return;
    };

    let dat = DatDatabase::new(&dat_path).expect("open portal.dat");
    let dat_kind = dat.dat_kind();

    let mut font_ids: Vec<u32> = dat
        .files
        .keys()
        .copied()
        .filter(|&id| DatFileType::from_id_in_dat(id, dat_kind) == DatFileType::Font)
        .collect();
    font_ids.sort_unstable();

    assert!(
        !font_ids.is_empty(),
        "expected at least one Font record in portal.dat",
    );

    let mut total_glyphs: usize = 0;
    for id in &font_ids {
        let bytes = dat.get_file(*id).unwrap_or_else(|e| {
            panic!("read Font 0x{id:08X}: {e}");
        });
        let mut cursor = Cursor::new(&bytes);
        let font = Font::read(&mut cursor).unwrap_or_else(|e| {
            panic!("parse Font 0x{id:08X} ({} bytes): {e}", bytes.len());
        });

        // ID stamped in the record must match the file ID.
        assert_eq!(font.id, *id, "Font 0x{id:08X} self-id mismatch");

        // Sanity: every retail font has glyphs and a positive cell size.
        assert!(
            !font.char_descs.is_empty(),
            "Font 0x{id:08X} has zero char descs",
        );
        assert!(
            font.max_char_height > 0 && font.max_char_width > 0,
            "Font 0x{id:08X} has zero max cell size ({}x{})",
            font.max_char_height,
            font.max_char_width,
        );

        // Sanity: byte-size accounts exactly for header + char-desc array.
        let predicted = 36 + 11 * font.char_descs.len();
        assert_eq!(
            predicted,
            bytes.len(),
            "Font 0x{id:08X} size mismatch: predicted {} != actual {}",
            predicted,
            bytes.len(),
        );

        total_glyphs += font.char_descs.len();
    }

    println!(
        "Parsed {} Font records, {} total glyphs",
        font_ids.len(),
        total_glyphs
    );
}
