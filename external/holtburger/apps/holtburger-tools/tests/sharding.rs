//! Phase 5.0 obj 3 smoke test: drive `dat_shard::shard_bundle`
//! against a synthetic in-memory HBA fixture and verify the
//! manifest / shard / boot-pack invariants.
//!
//! Reading the repo's 605 MB `dats/assets.hba` is too slow for
//! `cargo test --workspace --lib`; the fixture HBA built here
//! exercises every code path on a few KB of data and runs in
//! milliseconds.

use std::collections::HashSet;

use holtburger_dat::file_type::CharGen;
use holtburger_dat::{
    EOR_CELL_NAMESPACE, EOR_PORTAL_NAMESPACE, HbaReader, HbaStreamWriter,
};
use holtburger_manifest::{format_shard_key, parse_shard_key};
use holtburger_tools::dat_shard::{DatShardOptions, shard_bundle};

const BOOT_LANDBLOCK: u32 = 0xA9B4;

/// Build a fixture HBA with a representative mix of records:
///
/// - `eor/portal:CharGen::FILE_ID` — boot essential
/// - `eor/portal:0x01000827` — non-essential (a normal model)
/// - `eor/cell:0xA9B4FFFF` — boot landblock terrain
/// - `eor/cell:0xA9B4FFFE` — boot landblock LandblockInfo
/// - `eor/cell:0xA8B3FFFF` — adjacent landblock terrain
/// - `eor/cell:0x0000FFFF` — far-away landblock terrain
///   (NOT in boot pack)
/// - `eor/portal:0x01000828` — duplicate bytes of `0x01000827` to
///   exercise the sha256 dedupe
fn build_fixture_hba(path: &std::path::Path) {
    let mut writer = HbaStreamWriter::create(path).expect("create fixture HBA");
    writer.set_compression(false);
    let model_a = b"model-a-bytes-XXXXXX".to_vec();
    let model_b_dup = model_a.clone();
    let cell_a9b4_terrain = b"cell-a9b4-terrain".to_vec();
    let cell_a9b4_info = b"cell-a9b4-info".to_vec();
    let cell_a8b3_terrain = b"cell-a8b3-terrain".to_vec();
    let cell_far = b"cell-far".to_vec();
    let char_gen = b"chargen-stub".to_vec();

    writer
        .add(EOR_PORTAL_NAMESPACE, CharGen::FILE_ID, 0, char_gen)
        .unwrap();
    writer
        .add(EOR_PORTAL_NAMESPACE, 0x0100_0827, 0, model_a)
        .unwrap();
    writer
        .add(EOR_PORTAL_NAMESPACE, 0x0100_0828, 0, model_b_dup)
        .unwrap();
    writer
        .add(EOR_CELL_NAMESPACE, 0xA9B4_FFFF, 0, cell_a9b4_terrain)
        .unwrap();
    writer
        .add(EOR_CELL_NAMESPACE, 0xA9B4_FFFE, 0, cell_a9b4_info)
        .unwrap();
    writer
        .add(EOR_CELL_NAMESPACE, 0xA8B3_FFFF, 0, cell_a8b3_terrain)
        .unwrap();
    writer
        .add(EOR_CELL_NAMESPACE, 0x0000_FFFF, 0, cell_far)
        .unwrap();
    writer.finish().expect("finalize fixture HBA");
}

fn shard_fixture() -> (tempfile::TempDir, holtburger_manifest::Manifest) {
    let tmp = tempfile::tempdir().expect("tempdir");
    let fixture_hba = tmp.path().join("fixture.hba");
    build_fixture_hba(&fixture_hba);

    let output_dir = tmp.path().join("dist");
    let manifest = shard_bundle(&DatShardOptions {
        input_hba: Some(fixture_hba),
        eor_portal: None,
        eor_cell: None,
        eor_local: None,
        boot_landblock: BOOT_LANDBLOCK,
        output_dir,
    })
    .expect("shard_bundle");

    (tmp, manifest)
}

#[test]
fn manifest_lists_every_record_in_source() {
    // (a) Every record in the source HBA appears in the manifest.
    let (tmp, manifest) = shard_fixture();
    let _keep = tmp;

    let expected: HashSet<String> = [
        format_shard_key(EOR_PORTAL_NAMESPACE, CharGen::FILE_ID),
        format_shard_key(EOR_PORTAL_NAMESPACE, 0x0100_0827),
        format_shard_key(EOR_PORTAL_NAMESPACE, 0x0100_0828),
        format_shard_key(EOR_CELL_NAMESPACE, 0xA9B4_FFFF),
        format_shard_key(EOR_CELL_NAMESPACE, 0xA9B4_FFFE),
        format_shard_key(EOR_CELL_NAMESPACE, 0xA8B3_FFFF),
        format_shard_key(EOR_CELL_NAMESPACE, 0x0000_FFFF),
    ]
    .into_iter()
    .collect();

    let got: HashSet<String> = manifest.shards.keys().cloned().collect();
    assert_eq!(got, expected, "shard set must mirror source HBA records");
}

#[test]
fn boot_pack_covers_spawn_landblock_and_essentials() {
    // (b) boot pack contains records reachable from spawn landblock
    // (Phase 5.0 obj 3 ships the minimum-viable subset: catalog
    // essentials + the 9-cell spawn neighborhood. Obj 8 expands
    // this with the transitive walk.)
    let (tmp, manifest) = shard_fixture();
    let _keep = tmp;

    let covers: HashSet<&String> = manifest.boot_pack.covers.iter().collect();
    assert!(
        covers.contains(&format_shard_key(EOR_PORTAL_NAMESPACE, CharGen::FILE_ID)),
        "boot pack must include CharGen catalog table"
    );
    assert!(
        covers.contains(&format_shard_key(EOR_CELL_NAMESPACE, 0xA9B4_FFFF)),
        "boot pack must include spawn landblock terrain"
    );
    assert!(
        covers.contains(&format_shard_key(EOR_CELL_NAMESPACE, 0xA9B4_FFFE)),
        "boot pack must include spawn LandblockInfo"
    );
    assert!(
        covers.contains(&format_shard_key(EOR_CELL_NAMESPACE, 0xA8B3_FFFF)),
        "boot pack must include adjacent landblock terrain"
    );
    assert!(
        !covers.contains(&format_shard_key(EOR_CELL_NAMESPACE, 0x0000_FFFF)),
        "boot pack must NOT include far-away landblock"
    );
    assert!(
        !covers.contains(&format_shard_key(EOR_PORTAL_NAMESPACE, 0x0100_0827)),
        "boot pack must NOT include arbitrary models in the obj-3 minimum-viable policy"
    );
}

#[test]
fn duplicate_records_collapse_to_one_shard_url() {
    // (c) duplicate records (same bytes) collapse to one shard
    // URL via sha256 dedupe.
    let (tmp, manifest) = shard_fixture();
    let _keep = tmp;

    let entry_a = manifest
        .shards
        .get(&format_shard_key(EOR_PORTAL_NAMESPACE, 0x0100_0827))
        .expect("0x01000827 in manifest");
    let entry_b = manifest
        .shards
        .get(&format_shard_key(EOR_PORTAL_NAMESPACE, 0x0100_0828))
        .expect("0x01000828 in manifest");

    assert_eq!(
        entry_a.sha256, entry_b.sha256,
        "duplicate-byte records must share a sha256"
    );
    assert_eq!(
        entry_a.url, entry_b.url,
        "duplicate-byte records must share a shard URL"
    );

    let unique_urls: HashSet<&String> = manifest.shards.values().map(|e| &e.url).collect();
    let unique_hashes: HashSet<&String> = manifest.shards.values().map(|e| &e.sha256).collect();
    assert_eq!(
        unique_urls.len(),
        unique_hashes.len(),
        "URL set and hash set must be one-to-one"
    );
    // 7 records, 1 dedupe → 6 unique shard files.
    assert_eq!(unique_urls.len(), 6);
}

#[test]
fn boot_hba_round_trips_via_hbareader() {
    // Boot pack is a real HBA. Open it and verify the records the
    // manifest claims are covered are actually present.
    let (tmp, manifest) = shard_fixture();
    let boot_path = tmp.path().join("dist").join("boot.hba");
    let reader = HbaReader::<std::fs::File>::open(&boot_path).expect("open boot.hba");

    for cover in &manifest.boot_pack.covers {
        let (namespace, file_id) = parse_shard_key(cover).expect("parse cover key");
        let bytes = reader
            .get_file_in_namespace(&namespace, file_id)
            .unwrap_or_else(|e| panic!("boot.hba missing {cover}: {e}"));
        assert!(!bytes.is_empty(), "boot.hba record {cover} has zero bytes");
    }
}
