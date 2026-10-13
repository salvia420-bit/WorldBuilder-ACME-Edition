//! ClothingTable (DAT type 0x10, ID range `0x10000000..=0x1000FFFF`).
//!
//! Describes how an equippable item maps onto a wearer's body model:
//! per-setup ClothingBaseEffects (which GfxObj parts swap in and which
//! textures get retargeted on each part) plus a separate map of
//! ClothingSubPalEffects (color-variant overlays — dyed armor, hair
//! tinting, the player tinker palette).
//!
//! Wire layout (DRW `dats.xml` `ClothingTable`):
//!
//! ```text
//!   u32                                              id
//!   PackableHashTable<QualifiedDataId<Setup>,       clothing_base_effects
//!                     ClothingBaseEffect>
//!   PackableHashTable<u32, CloSubPalEffect>          clothing_sub_pal_effects
//!
//!   // PackableHashTable header is u16 count + u16 bucket_size; entries
//!   // follow inline (no per-bucket framing on the wire).
//!
//!   ClothingBaseEffect:
//!     u32 num_clo_object_effects
//!     [CloObjectEffect; num_clo_object_effects]
//!
//!   CloObjectEffect:
//!     u32 index                       // body-part / setup slot
//!     u32 model_id                    // GfxObj DataID
//!     u32 num_clo_texture_effects
//!     [CloTextureEffect; num_clo_texture_effects]
//!
//!   CloTextureEffect:
//!     u32 old_texture                 // SurfaceTexture DataID
//!     u32 new_texture                 // SurfaceTexture DataID
//!
//!   CloSubPalEffect:
//!     u32 icon                        // RenderSurface DataID
//!     u32 num_clo_sub_palettes
//!     [CloSubPalette; num_clo_sub_palettes]
//!
//!   CloSubPalette:
//!     u32 num_ranges
//!     [CloSubPaletteRange; num_ranges]
//!     u32 palette_set                 // PalSet DataID
//!
//!   CloSubPaletteRange:
//!     u32 offset
//!     u32 num_colors
//! ```
//!
//! Cross-checked against acclient.h: there is no monolithic
//! ClothingTable struct in the decomp; the in-game representation is
//! built out of `ClothingBase` / `CloObjEffect` style records glued
//! together by the runtime palette/setup loader. DRW's wire schema is
//! the canonical reference for on-disk shape.
//!
//! Real-record cross-check: Clothing 0x10000001 (3344 bytes) parses
//! to 17 base effects + 102 sub-palette effects; first base-effect
//! setup is 0x02001A18 with 6 CloObjectEffects, first of which is
//! GfxObj 0x01004AA7 swapping the textures
//! 0x050003D5 → 0x0500025F and 0x050003D4 → 0x0500025E.
//!
//! maps-chargen-barber-3 (2026-10-13): the sub-palette table also keeps
//! its keys in DAT order and its bucket count, because retail reads it in
//! hash-walk order (`CharGenState::StoreColorInformation`, acclient.c:
//! 495905 — the chargen colour list of a gear) and that order is fixed by
//! both; see [`packable_hash_table_walk_order`].

use binrw::BinRead;
use binrw::io::{Read, Seek};
use std::collections::HashMap;

#[derive(BinRead, Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[br(little)]
pub struct CloSubPaletteRange {
    pub offset: u32,
    pub num_colors: u32,
}

#[binrw::binread]
#[derive(Debug, Clone, serde::Serialize)]
#[br(little)]
pub struct CloSubPalette {
    #[br(temp)]
    num_ranges: u32,
    #[br(count = num_ranges)]
    pub ranges: Vec<CloSubPaletteRange>,
    /// PalSet (DAT 0x0F) DataID.
    pub palette_set: u32,
}

#[binrw::binread]
#[derive(Debug, Clone, serde::Serialize)]
#[br(little)]
pub struct CloSubPalEffect {
    /// RenderSurface (DAT 0x06/0x07) DataID for the variant icon.
    pub icon: u32,
    #[br(temp)]
    num_clo_sub_palettes: u32,
    #[br(count = num_clo_sub_palettes)]
    pub clo_sub_palettes: Vec<CloSubPalette>,
}

#[derive(BinRead, Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[br(little)]
pub struct CloTextureEffect {
    /// SurfaceTexture (DAT 0x05) DataID to replace.
    pub old_texture: u32,
    /// SurfaceTexture (DAT 0x05) DataID to substitute in.
    pub new_texture: u32,
}

#[binrw::binread]
#[derive(Debug, Clone, serde::Serialize)]
#[br(little)]
pub struct CloObjectEffect {
    /// Body-part / setup-slot index this swap targets.
    pub index: u32,
    /// GfxObj (DAT 0x01) DataID of the replacement mesh.
    pub model_id: u32,
    #[br(temp)]
    num_clo_texture_effects: u32,
    #[br(count = num_clo_texture_effects)]
    pub clo_texture_effects: Vec<CloTextureEffect>,
}

#[binrw::binread]
#[derive(Debug, Clone, serde::Serialize)]
#[br(little)]
pub struct ClothingBaseEffect {
    #[br(temp)]
    num_clo_object_effects: u32,
    #[br(count = num_clo_object_effects)]
    pub clo_object_effects: Vec<CloObjectEffect>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ClothingTable {
    pub id: u32,
    /// Setup (DAT 0x02) DataID → effect to apply when that setup is worn.
    pub clothing_base_effects: HashMap<u32, ClothingBaseEffect>,
    /// Sub-palette key → color-variant overlay (used for armor dyes,
    /// hair color, etc.).
    pub clothing_sub_pal_effects: HashMap<u32, CloSubPalEffect>,
    /// `clothing_sub_pal_effects`' keys in DAT (stream) order — the order
    /// `PackableHashTable::UnPack` adds them in. The map above loses it.
    /// Not serialized, so `fetch_clothing_table`'s JSON is unchanged.
    #[serde(skip)]
    pub clothing_sub_pal_effect_keys: Vec<u32>,
    /// The sub-palette table's bucket count (`_table_size`, the high u16
    /// of the PackableHashTable header).
    #[serde(skip)]
    pub clothing_sub_pal_effects_table_size: u16,
}

impl ClothingTable {
    pub fn unpack(data: &[u8]) -> binrw::BinResult<Self> {
        let mut cursor = binrw::io::Cursor::new(data);
        Self::read_le(&mut cursor)
    }

    /// The sub-palette (CloPaletteTemplate) keys in the order retail's
    /// `PackableHashIterator` visits them — what
    /// `CharGenState::StoreColorInformation` (acclient.c:495905) walks.
    pub fn sub_pal_effect_keys_in_retail_order(&self) -> Vec<u32> {
        packable_hash_table_walk_order(
            &self.clothing_sub_pal_effect_keys,
            self.clothing_sub_pal_effects_table_size,
        )
    }
}

/// The order retail walks a `PackableHashTable<unsigned long, T>` whose
/// `UnPack` read `keys` (in stream order) under a header bucket count of
/// `table_size`:
///
/// - `PackableHashTable::add` (acclient.c:465203) puts a key in bucket
///   `key % _table_size` and PREPENDS it to that bucket's chain; a key
///   already present is not added again;
/// - `begin` (:464420) starts at the first non-empty bucket, and the
///   iterator follows `_next` down the chain, then the next non-empty
///   bucket.
///
/// So: buckets in index order, each bucket's keys in reverse add order.
/// A table size of 0 holds nothing (`UnPack` returns before adding).
pub fn packable_hash_table_walk_order(keys: &[u32], table_size: u16) -> Vec<u32> {
    let size = u32::from(table_size);
    if size == 0 {
        return Vec::new();
    }
    let mut buckets: Vec<Vec<u32>> = vec![Vec::new(); size as usize];
    for &key in keys {
        let bucket = &mut buckets[(key % size) as usize];
        if !bucket.contains(&key) {
            bucket.push(key);
        }
    }
    buckets
        .into_iter()
        .flat_map(|bucket| bucket.into_iter().rev())
        .collect()
}

impl BinRead for ClothingTable {
    type Args<'a> = ();

    fn read_options<R: Read + Seek>(
        reader: &mut R,
        endian: binrw::Endian,
        _: Self::Args<'_>,
    ) -> binrw::BinResult<Self> {
        if endian != binrw::Endian::Little {
            return Err(binrw::Error::AssertFail {
                pos: reader.stream_position().unwrap_or(0),
                message: "ClothingTable is little-endian only".to_string(),
            });
        }

        let id = u32::read_le(reader)?;
        let base_effects = read_packable_hash_table(reader, |r| ClothingBaseEffect::read_le(r))?;
        let sub_pal_effects = read_packable_hash_table(reader, |r| CloSubPalEffect::read_le(r))?;
        let clothing_sub_pal_effect_keys: Vec<u32> =
            sub_pal_effects.entries.iter().map(|(key, _)| *key).collect();
        let clothing_sub_pal_effects_table_size = sub_pal_effects.table_size;

        Ok(Self {
            id,
            // The HashMap views keep their old semantics (a repeated key
            // keeps the last value).
            clothing_base_effects: base_effects.entries.into_iter().collect(),
            clothing_sub_pal_effects: sub_pal_effects.entries.into_iter().collect(),
            clothing_sub_pal_effect_keys,
            clothing_sub_pal_effects_table_size,
        })
    }
}

/// A PackableHashTable as the DAT stores it: the entries in stream order
/// and the header's bucket count.
struct PackedHashTable<V> {
    entries: Vec<(u32, V)>,
    table_size: u16,
}

fn read_packable_hash_table<R, V, F>(
    reader: &mut R,
    mut read_value: F,
) -> binrw::BinResult<PackedHashTable<V>>
where
    R: Read + Seek,
    F: FnMut(&mut R) -> binrw::BinResult<V>,
{
    // PackableHashTable header: u16 count + u16 bucket size
    // (`PackableHashTable::UnPack`, acclient.c:465123: the low half is the
    // count, the high half `_table_size`).
    let count = u16::read_le(reader)?;
    let table_size = u16::read_le(reader)?;
    let mut entries = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let key = u32::read_le(reader)?;
        let value = read_value(reader)?;
        entries.push((key, value));
    }
    Ok(PackedHashTable {
        entries,
        table_size,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use binrw::io::Cursor;

    /// First base-effect entry of retail Clothing 0x10000001:
    /// setup 0x02001A18, six CloObjectEffects. We slice off just
    /// enough bytes for the first CloObjectEffect (index 9, model
    /// GfxObj 0x01004AA7, two texture swaps) to validate field order
    /// without dragging the whole 17-entry table inline.
    const CLOTHING_0X10000001_FIRST_OBJECT_EFFECT: &[u8] = &[
        0x09, 0x00, 0x00, 0x00, // index = 9
        0xA7, 0x4A, 0x00, 0x01, // model_id = 0x01004AA7
        0x02, 0x00, 0x00, 0x00, // num_clo_texture_effects = 2
        // tex swap 0
        0xD5, 0x03, 0x00, 0x05, // old = 0x050003D5
        0x5F, 0x02, 0x00, 0x05, // new = 0x0500025F
        // tex swap 1
        0xD4, 0x03, 0x00, 0x05, // old = 0x050003D4
        0x5E, 0x02, 0x00, 0x05, // new = 0x0500025E
    ];

    #[test]
    fn clo_object_effect_decodes_field_order() {
        let mut cursor = Cursor::new(CLOTHING_0X10000001_FIRST_OBJECT_EFFECT);
        let effect = CloObjectEffect::read_le(&mut cursor).expect("parse effect");
        assert_eq!(effect.index, 9);
        assert_eq!(effect.model_id, 0x01004AA7);
        assert_eq!(effect.clo_texture_effects.len(), 2);
        assert_eq!(effect.clo_texture_effects[0].old_texture, 0x050003D5);
        assert_eq!(effect.clo_texture_effects[0].new_texture, 0x0500025F);
        assert_eq!(effect.clo_texture_effects[1].old_texture, 0x050003D4);
        assert_eq!(effect.clo_texture_effects[1].new_texture, 0x0500025E);
    }

    /// Minimal full-table round-trip — one base effect + zero sub-pal
    /// effects. Validates the outer PackableHashTable framing.
    #[test]
    fn clothing_table_round_trips_single_base_effect() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&0x10000001u32.to_le_bytes());
        // base_effects: 1 entry, bucket_size 8
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&8u16.to_le_bytes());
        bytes.extend_from_slice(&0x02001A18u32.to_le_bytes()); // setup key
        bytes.extend_from_slice(&1u32.to_le_bytes()); // num_clo_object_effects
        bytes.extend_from_slice(CLOTHING_0X10000001_FIRST_OBJECT_EFFECT);
        // sub_pal_effects: 0 entries, bucket_size 8
        bytes.extend_from_slice(&0u16.to_le_bytes());
        bytes.extend_from_slice(&8u16.to_le_bytes());

        let mut cursor = Cursor::new(&bytes);
        let table = ClothingTable::read_le(&mut cursor).expect("parse table");
        assert_eq!(table.id, 0x10000001);
        assert_eq!(table.clothing_base_effects.len(), 1);
        assert!(table.clothing_sub_pal_effects.is_empty());

        let base = table
            .clothing_base_effects
            .get(&0x02001A18)
            .expect("setup 0x02001A18 should be present");
        assert_eq!(base.clo_object_effects.len(), 1);
        assert_eq!(base.clo_object_effects[0].model_id, 0x01004AA7);
    }

    /// maps-chargen-barber-3: retail's walk is bucket by bucket
    /// (`key % table_size`), each bucket newest-added first, duplicates
    /// dropped.
    #[test]
    fn packable_hash_table_walk_order_follows_add_and_begin() {
        // Size 4: bucket 1 gets 5, 1, 9 (added in that order), bucket 2
        // gets 2, bucket 3 gets 7; bucket 0 is empty.
        assert_eq!(
            packable_hash_table_walk_order(&[5, 1, 9, 2, 7], 4),
            vec![9, 1, 5, 2, 7]
        );
        assert_eq!(packable_hash_table_walk_order(&[3, 3, 3], 8), vec![3]);
        assert!(packable_hash_table_walk_order(&[1, 2], 0).is_empty());
        // No collisions: plain key order by bucket.
        assert_eq!(
            packable_hash_table_walk_order(&[30, 2, 17], 64),
            vec![2, 17, 30]
        );
    }

    /// maps-chargen-barber-3: the sub-palette table keeps its DAT order
    /// and bucket count beside the HashMap view.
    #[test]
    fn clothing_table_keeps_sub_pal_effect_order_and_bucket_count() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&0x10000002u32.to_le_bytes());
        // base_effects: none.
        bytes.extend_from_slice(&0u16.to_le_bytes());
        bytes.extend_from_slice(&8u16.to_le_bytes());
        // sub_pal_effects: 3 entries, bucket count 2. Each: key, icon,
        // one CloSubPalette with one range and a PalSet.
        bytes.extend_from_slice(&3u16.to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        for (key, pal_set) in [(7u32, 0x0F00_0007u32), (4, 0x0F00_0004), (9, 0x0F00_0009)] {
            bytes.extend_from_slice(&key.to_le_bytes());
            bytes.extend_from_slice(&0x0600_0001u32.to_le_bytes()); // icon
            bytes.extend_from_slice(&1u32.to_le_bytes()); // num_clo_sub_palettes
            bytes.extend_from_slice(&1u32.to_le_bytes()); // num_ranges
            bytes.extend_from_slice(&1312u32.to_le_bytes()); // offset
            bytes.extend_from_slice(&64u32.to_le_bytes()); // num_colors
            bytes.extend_from_slice(&pal_set.to_le_bytes());
        }

        let table = ClothingTable::unpack(&bytes).expect("parse table");
        assert_eq!(table.clothing_sub_pal_effect_keys, vec![7, 4, 9]);
        assert_eq!(table.clothing_sub_pal_effects_table_size, 2);
        assert_eq!(table.clothing_sub_pal_effects.len(), 3);
        assert_eq!(
            table.clothing_sub_pal_effects[&9].clo_sub_palettes[0].palette_set,
            0x0F00_0009
        );
        // Bucket 0: 4 (even); bucket 1: 7 then 9, walked newest first.
        assert_eq!(table.sub_pal_effect_keys_in_retail_order(), vec![4, 9, 7]);
        // The new fields stay out of the JSON fetch_clothing_table returns.
        let json = serde_json::to_value(&table).expect("serialize");
        let obj = json.as_object().expect("object");
        assert_eq!(obj.len(), 3, "{obj:?}");
        assert!(obj.contains_key("clothing_sub_pal_effects"));
    }
}
