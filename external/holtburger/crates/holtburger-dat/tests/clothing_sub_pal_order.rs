//! maps-chargen-barber-3 (2026-10-13): every retail ClothingTable keeps its
//! sub-palette (CloPaletteTemplate) keys in DAT order, with the header's
//! count and bucket size, and the retail walk order is a permutation of
//! them. Retail's chargen colour lists (`CharGenState::StoreColorInformation`,
//! acclient.c:495905) walk that table in PackableHashTable order, which
//! the DAT order and the bucket size decide.
//!
//! The DAT order is read here with a separate minimal byte walker, not the
//! parser under test. Skipped when `HOLTBURGER_PORTAL_DAT` / the default
//! portal.dat is absent.

use holtburger_dat::file_type::ClothingTable;
use holtburger_dat::file_type::clothing::packable_hash_table_walk_order;
use holtburger_dat::{DatDatabase, DatFileType};

mod common;
use common::get_portal_dat_path;

struct Walker<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl Walker<'_> {
    fn u16(&mut self) -> u16 {
        let v = u16::from_le_bytes([self.bytes[self.pos], self.bytes[self.pos + 1]]);
        self.pos += 2;
        v
    }
    fn u32(&mut self) -> u32 {
        let b = &self.bytes[self.pos..self.pos + 4];
        self.pos += 4;
        u32::from_le_bytes([b[0], b[1], b[2], b[3]])
    }
    fn skip(&mut self, n: usize) {
        self.pos += n;
    }
}

/// (count, bucket size, sub-palette keys in stream order).
fn walk_sub_pal_keys(bytes: &[u8]) -> (u16, u16, Vec<u32>) {
    let mut w = Walker { bytes, pos: 0 };
    let _id = w.u32();
    // ClothingBaseEffects: key, num object effects, each (index, model,
    // num texture effects, 8 bytes each).
    let base_count = w.u16();
    let _base_buckets = w.u16();
    for _ in 0..base_count {
        let _setup = w.u32();
        let objects = w.u32();
        for _ in 0..objects {
            let _index = w.u32();
            let _model = w.u32();
            let textures = w.u32() as usize;
            w.skip(textures * 8);
        }
    }
    // ClothingSubPalEffects: key, icon, num sub-palettes, each (num
    // ranges, 8 bytes each, PalSet).
    let count = w.u16();
    let buckets = w.u16();
    let mut keys = Vec::with_capacity(count as usize);
    for _ in 0..count {
        keys.push(w.u32());
        let _icon = w.u32();
        let subs = w.u32();
        for _ in 0..subs {
            let ranges = w.u32() as usize;
            w.skip(ranges * 8);
            let _pal_set = w.u32();
        }
    }
    assert_eq!(w.pos, bytes.len(), "byte walker must consume the record");
    (count, buckets, keys)
}

#[test]
fn retail_clothing_tables_keep_sub_pal_effect_dat_order() {
    let Some(dat_path) = get_portal_dat_path() else {
        println!("Skipping ClothingTable sub-palette order: portal.dat not found");
        return;
    };
    let dat = DatDatabase::new(&dat_path).expect("open portal.dat");
    let dat_kind = dat.dat_kind();
    let mut ids: Vec<u32> = dat
        .files
        .keys()
        .copied()
        .filter(|&id| DatFileType::from_id_in_dat(id, dat_kind) == DatFileType::Clothing)
        .collect();
    ids.sort_unstable();
    assert!(!ids.is_empty(), "expected ClothingTable records in portal.dat");

    let mut checked = 0usize;
    let mut reordered = 0usize;
    for id in &ids {
        let bytes = dat.get_file(*id).expect("read ClothingTable");
        let table = ClothingTable::unpack(&bytes)
            .unwrap_or_else(|e| panic!("parse ClothingTable 0x{id:08X}: {e}"));
        let (count, buckets, keys) = walk_sub_pal_keys(&bytes);

        assert_eq!(
            table.clothing_sub_pal_effect_keys, keys,
            "0x{id:08X}: keys must come back in DAT order"
        );
        assert_eq!(
            table.clothing_sub_pal_effect_keys.len(),
            count as usize,
            "0x{id:08X}: key count must match the header"
        );
        assert_eq!(table.clothing_sub_pal_effects_table_size, buckets, "0x{id:08X}");
        assert_eq!(
            table.clothing_sub_pal_effects.len(),
            count as usize,
            "0x{id:08X}: retail tables have no repeated keys"
        );

        let walk = table.sub_pal_effect_keys_in_retail_order();
        assert_eq!(walk, packable_hash_table_walk_order(&keys, buckets));
        let mut a = walk.clone();
        let mut b = keys.clone();
        a.sort_unstable();
        b.sort_unstable();
        assert_eq!(a, b, "0x{id:08X}: the walk visits every key once");
        if walk != keys {
            reordered += 1;
        }
        checked += 1;
    }

    // Known record: Clothing 0x10000001 has 102 sub-palette effects.
    let bytes = dat.get_file(0x1000_0001).expect("0x10000001");
    let table = ClothingTable::unpack(&bytes).expect("parse 0x10000001");
    assert_eq!(table.clothing_sub_pal_effect_keys.len(), 102);

    println!(
        "ClothingTable sub-palette order: {checked} tables, {reordered} walk in a different order than the DAT"
    );
}
