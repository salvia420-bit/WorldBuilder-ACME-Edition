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
use holtburger_manifest::{
    catalog::NamespaceCatalog,
    format_shard_key, parse_shard_key, sha256_hex,
    v2::{MANIFEST_V2_VERSION, ManifestV2, namespace_slug},
};
use holtburger_tools::dat_shard::{DatShardOptions, V2BakeResult, shard_bundle, shard_bundle_v2};

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
        manifest_version: 1,
        tex_bc7: None,
        tex_bc7_pre: None,
        tex_xu7: None,
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

// ============================================================
// Phase 5.2 obj 5 — v2 manifest emission tests.
// ============================================================

/// Bake a v2 fixture once; tests below probe the resulting dist/
/// directly. Returns the tmp dir (kept alive by callers via
/// `let _keep = tmp;`), the dist path, and the in-memory result.
fn v2_shard_fixture() -> (tempfile::TempDir, std::path::PathBuf, V2BakeResult) {
    let tmp = tempfile::tempdir().expect("tempdir");
    let fixture_hba = tmp.path().join("fixture.hba");
    build_fixture_hba(&fixture_hba);

    let output_dir = tmp.path().join("dist");
    let bake = shard_bundle_v2(&DatShardOptions {
        input_hba: Some(fixture_hba),
        eor_portal: None,
        eor_cell: None,
        eor_local: None,
        boot_landblock: BOOT_LANDBLOCK,
        output_dir: output_dir.clone(),
        manifest_version: 2,
        tex_bc7: None,
        tex_bc7_pre: None,
        tex_xu7: None,
    })
    .expect("shard_bundle_v2");

    (tmp, output_dir, bake)
}

#[test]
fn v2_top_level_manifest_under_5kb() {
    // (a) Top-level manifest.json must be <5 KB. The fixture's
    // 7 records produce a ≈2 KB top-level v2 (just version +
    // generated_at + source + boot_pack + namespaces +
    // URL templates); on the real Dereth bake the bound is the
    // same ≈2 KB regardless of record count, since shard listings
    // moved to per-namespace binaries.
    let (tmp, dist, _bake) = v2_shard_fixture();
    let _keep = tmp;

    let manifest_path = dist.join("manifest.json");
    let bytes = std::fs::read(&manifest_path).expect("read v2 manifest");
    assert!(
        bytes.len() < 5 * 1024,
        "top-level v2 manifest must be <5 KB; got {} bytes",
        bytes.len()
    );

    // Schema sanity: parse + assert the version field.
    let parsed: ManifestV2 =
        serde_json::from_slice(&bytes).expect("parse v2 manifest.json");
    assert_eq!(parsed.version, MANIFEST_V2_VERSION);
    assert_eq!(parsed.catalog_version, 1);
    assert!(
        parsed.catalog_url_template.is_some(),
        "default emission carries a catalog template"
    );
}

#[test]
fn v2_per_namespace_catalogs_exist_for_every_namespace() {
    // (b) Per-namespace catalogs exist for every namespace in the
    // bundle. The fixture has 2 namespaces (eor/portal + eor/cell),
    // so we expect 2 catalog files. Manifest's `namespaces` field
    // must list both, and each must have a corresponding
    // `manifest/<slug>.bin` file on disk.
    let (tmp, dist, bake) = v2_shard_fixture();
    let _keep = tmp;

    let expected: HashSet<&str> = [EOR_PORTAL_NAMESPACE, EOR_CELL_NAMESPACE]
        .into_iter()
        .collect();
    let listed: HashSet<&str> = bake.manifest.namespaces.iter().map(String::as_str).collect();
    assert_eq!(listed, expected, "manifest must list every fixture namespace");

    for namespace in &bake.manifest.namespaces {
        let slug = namespace_slug(namespace);
        let catalog_path = dist.join("manifest").join(format!("{slug}.bin"));
        assert!(
            catalog_path.exists(),
            "catalog {catalog_path:?} missing for namespace {namespace}"
        );
        let size = std::fs::metadata(&catalog_path)
            .expect("stat catalog")
            .len();
        // Header (16) + at least 1 entry (1+16+1 minimum) + footer (8) = 42 bytes floor.
        assert!(size >= 42, "catalog {namespace} has trivial size {size}");
    }
}

#[test]
fn v2_catalogs_round_trip_via_read_from() {
    // (c) Each catalog round-trips via `NamespaceCatalog::read_from`
    // — the codec the runtime resource source will exercise.
    let (tmp, dist, bake) = v2_shard_fixture();
    let _keep = tmp;

    for namespace in &bake.manifest.namespaces {
        let slug = namespace_slug(namespace);
        let catalog_path = dist.join("manifest").join(format!("{slug}.bin"));
        let bytes = std::fs::read(&catalog_path).expect("read catalog");
        let catalog = NamespaceCatalog::read_from(&bytes, namespace.clone())
            .unwrap_or_else(|e| panic!("read {namespace} catalog: {e}"));

        assert_eq!(&catalog.namespace, namespace);
        assert!(
            !catalog.entries.is_empty(),
            "catalog {namespace} has no entries"
        );

        // Entries must be sorted by file_id (delta encoding requires it).
        for window in catalog.entries.windows(2) {
            assert!(
                window[0].file_id <= window[1].file_id,
                "catalog {namespace} not sorted: {} > {}",
                window[0].file_id,
                window[1].file_id,
            );
        }
    }
}

#[test]
fn v2_convention_symlinks_point_at_sha256_keyed_shards() {
    // (d) Convention-URL symlinks at
    // `shards/<namespace_slug>/0x<file_id>.bin` resolve to the
    // canonical truncated-sha256 shard, and the bytes match what
    // the source HBA stored. Confirms both forms (convention URL
    // and content-addressable URL) serve the same content.
    let (tmp, dist, bake) = v2_shard_fixture();
    let _keep = tmp;

    // For each catalog entry, follow the symlink + verify it
    // resolves to a real file under shards/<prefix>/.
    for namespace in &bake.manifest.namespaces {
        let slug = namespace_slug(namespace);
        let catalog_path = dist.join("manifest").join(format!("{slug}.bin"));
        let catalog_bytes = std::fs::read(&catalog_path).expect("read catalog");
        let catalog =
            NamespaceCatalog::read_from(&catalog_bytes, namespace.clone()).expect("parse catalog");

        for entry in &catalog.entries {
            let conv_path = dist
                .join("shards")
                .join(&slug)
                .join(format!("0x{:08X}.bin", entry.file_id));
            assert!(
                conv_path.exists(),
                "convention symlink missing: {conv_path:?}"
            );

            // Reading through the symlink follows it to the canonical.
            let bytes = std::fs::read(&conv_path)
                .unwrap_or_else(|e| panic!("read {conv_path:?}: {e}"));

            // Truncated sha256 of the bytes must match the catalog entry.
            let full = sha256_hex(&bytes);
            let trunc_hex: String = full.chars().take(32).collect();
            let expected_hex: String = entry
                .sha256_truncated
                .iter()
                .map(|b| format!("{:02x}", b))
                .collect();
            assert_eq!(
                trunc_hex, expected_hex,
                "convention symlink for {namespace}:0x{:08X} pointed at wrong content",
                entry.file_id,
            );

            // Also verify the canonical-keyed path exists at the
            // expected `shards/<prefix2>/<full-trunc>.bin` location.
            let canonical_path = dist
                .join("shards")
                .join(&trunc_hex[..2])
                .join(format!("{trunc_hex}.bin"));
            assert!(
                canonical_path.exists(),
                "canonical shard missing: {canonical_path:?}"
            );
        }
    }
}

#[test]
fn v2_every_source_record_reachable_via_manifest() {
    // (e) Every (namespace, file_id) from the source HBA is
    // reachable via the v2 manifest path: either via the boot
    // pack OR via a per-namespace catalog entry. No record is
    // dropped.
    let (tmp, dist, bake) = v2_shard_fixture();
    let _keep = tmp;

    let expected: HashSet<(String, u32)> = [
        (EOR_PORTAL_NAMESPACE.into(), CharGen::FILE_ID),
        (EOR_PORTAL_NAMESPACE.into(), 0x0100_0827),
        (EOR_PORTAL_NAMESPACE.into(), 0x0100_0828),
        (EOR_CELL_NAMESPACE.into(), 0xA9B4_FFFF),
        (EOR_CELL_NAMESPACE.into(), 0xA9B4_FFFE),
        (EOR_CELL_NAMESPACE.into(), 0xA8B3_FFFF),
        (EOR_CELL_NAMESPACE.into(), 0x0000_FFFF),
    ]
    .into_iter()
    .collect();

    let mut reachable: HashSet<(String, u32)> = HashSet::new();

    // Boot pack contributes via its parsed HBA. v2's BootPackV2
    // wire format dropped the `covers: Vec<String>` field (see
    // `holtburger_manifest::v2::BootPackV2` docs) — runtime
    // boot-pack hit-tests now go through `HbaReader::exists_by_key`.
    // The integration test mirrors that by walking the boot HBA's
    // entries directly.
    let boot_path = dist.join("boot.hba");
    let boot_reader =
        HbaReader::<std::fs::File>::open(&boot_path).expect("open boot.hba");
    for entry in boot_reader.entries() {
        let entry = entry.expect("HBA entry");
        let ns = entry.namespace_id().expect("decode namespace");
        reachable.insert((ns.as_str().to_owned(), entry.file_id));
    }

    // Catalog entries add to reachability.
    for namespace in &bake.manifest.namespaces {
        let slug = namespace_slug(namespace);
        let catalog_path = dist.join("manifest").join(format!("{slug}.bin"));
        let catalog_bytes = std::fs::read(&catalog_path).expect("read catalog");
        let catalog =
            NamespaceCatalog::read_from(&catalog_bytes, namespace.clone()).expect("parse catalog");
        for entry in catalog.entries {
            reachable.insert((namespace.clone(), entry.file_id));
        }
    }

    assert_eq!(
        reachable, expected,
        "v2 manifest path must reach every source record"
    );
    assert_eq!(bake.total_records, expected.len());
    // Duplicates: 2 fixture records share bytes ({0x0100_0827,
    // 0x0100_0828}), so unique shard count is 6 of 7 records.
    assert_eq!(bake.unique_shard_count, 6);
}
