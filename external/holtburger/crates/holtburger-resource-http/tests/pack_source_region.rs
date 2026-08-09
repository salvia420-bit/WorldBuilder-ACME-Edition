//! T12 GATE-WIRE-BOOT native arm — `PackSource` over T10's REAL baked
//! region (`/mnt/wbterminal2/reeng/T10/ci-run1`, the bounded-region
//! `dat-shard --emit-packs` output whose GATE-BAKE ran green).
//!
//! House rules honored: real data, not synthetic fixtures
//! (test-fixtures-real-data); heavy corpus tests are `#[ignore]`d and run
//! explicitly (the `bake_ci` precedent):
//!
//! ```sh
//! capped-build cargo test -p holtburger-resource-http --release \
//!     --test pack_source_region -- --ignored --nocapture
//! ```
//!
//! Fails LOUD (not skip) when the region or the base DATs are missing —
//! a silently-skipped differ is the "0 placements" lesson re-armed.

#![cfg(not(target_arch = "wasm32"))]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use holtburger_dat::{DatDatabase, ResourceKey, ResourceSource};
use holtburger_manifest::sha256_hex;
use holtburger_resource_http::pack::{
    self, PackSource, hash16_from_hex, parse_hbsi1,
};

const REGION: &str = "/mnt/wbterminal2/reeng/T10/ci-run1";
const BASE_DATS: &str = "/home/wbterminal/ac_base_dats";

fn region_root() -> PathBuf {
    let p = PathBuf::from(REGION);
    assert!(
        p.is_dir(),
        "T10 baked region missing at {REGION} — mount /mnt/wbterminal2 or re-bake \
         (bounded region only, output under /mnt/wbterminal2/reeng/T12/)"
    );
    p
}

/// manifest.json → (index url, sha256_16); index bytes verified + parsed.
fn load_index(root: &Path) -> (Vec<u8>, pack::SpatialIndex) {
    let manifest: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(root.join("manifest.json")).expect("read manifest.json"),
    )
    .expect("parse manifest.json");
    let wi = manifest
        .get("world_index")
        .expect("manifest lacks world_index (not a pack bake?)");
    let url = wi["url"].as_str().expect("world_index.url");
    let sha16 = wi["sha256_16"].as_str().expect("world_index.sha256_16");
    let bytes = std::fs::read(root.join(url)).expect("read index bytes");
    assert_eq!(bytes.len() as u64, wi["size"].as_u64().unwrap(), "index size mismatch");
    // Hash-on-receipt, exactly what the controller does (sha256 trunc 16).
    assert_eq!(&sha256_hex(&bytes)[..32], sha16, "index sha256_16 mismatch");
    let index = parse_hbsi1(&bytes).expect("parse HBSI1");
    (bytes, index)
}

/// Walk packs/{p2}/{hash32}.hbp, verify each file's sha256 against its CAS
/// name (the controller's hash-on-receipt, done here in-test), and admit.
fn admit_all(root: &Path, src: &PackSource) -> BTreeMap<String, (usize, u64)> {
    let mut by_kind: BTreeMap<String, (usize, u64)> = BTreeMap::new();
    let packs_dir = root.join("packs");
    let mut admitted = 0usize;
    for bucket in std::fs::read_dir(&packs_dir).expect("read packs/") {
        let bucket = bucket.expect("dirent").path();
        if !bucket.is_dir() {
            continue;
        }
        for f in std::fs::read_dir(&bucket).expect("read bucket") {
            let f = f.expect("dirent").path();
            let name = f.file_stem().unwrap().to_str().unwrap().to_string();
            let bytes = std::fs::read(&f).expect("read pack");
            // hash-on-receipt: CAS name IS the expected digest.
            assert_eq!(&sha256_hex(&bytes)[..32], name, "pack {name} sha mismatch");
            let hash = hash16_from_hex(&name).expect("hash from name");
            let st = src.insert_pack(hash, bytes).unwrap_or_else(|e| {
                panic!("insert {name}: {e}");
            });
            assert!(!st.duplicate, "duplicate CAS file {name}?");
            let kind_name = match st.kind {
                0 => "tile",
                1 => "interior",
                2 => "meta-shared",
                3 => "preview",
                4 => "env",
                5 => "core",
                6 => "terrain-t128-color",
                7 => "terrain-t128-nra",
                _ => "unknown",
            };
            let row = by_kind.entry(kind_name.into()).or_insert((0, 0));
            row.0 += 1;
            row.1 += std::fs::metadata(&f).unwrap().len();
            admitted += 1;
        }
    }
    assert!(admitted > 0, "no packs found under {packs_dir:?}");
    by_kind
}

#[test]
#[ignore = "T10-region corpus test — run explicitly (see module docs)"]
fn region_admits_every_pack_and_matches_bake_report() {
    let root = region_root();
    let (_bytes, index) = load_index(&root);
    let src = PackSource::from_index_bytes(&_bytes).expect("index parse");

    let by_kind = admit_all(&root, &src);

    // Cross-check the bake's own report — counts by kind + totals.
    let report: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(root.join("pack-report.json")).expect("read pack-report"),
    )
    .expect("parse pack-report");
    let expect_kinds = report["packs_by_kind"].as_object().expect("packs_by_kind");
    for (kind, row) in expect_kinds {
        let (n, bytes) = by_kind
            .get(kind.as_str())
            .unwrap_or_else(|| panic!("kind {kind} missing from admitted set"));
        assert_eq!(*n as u64, row[0].as_u64().unwrap(), "count mismatch for {kind}");
        assert_eq!(*bytes, row[1].as_u64().unwrap(), "byte mismatch for {kind}");
    }
    let st = src.stats();
    assert_eq!(
        st.packs_resident as u64,
        report["packs_emitted"].as_u64().unwrap(),
        "resident pack count vs report"
    );
    assert_eq!(
        st.pack_file_bytes as u64,
        report["pack_bytes_total"].as_u64().unwrap(),
        "resident pack bytes vs report"
    );

    // Index shape sanity vs report: every index row admitted; grid tiles.
    assert_eq!(index.packs.len(), st.packs_resident, "index rows all admitted");
    let non_empty_tiles = index.tile_grid.iter().filter(|&&t| t != pack::TILE_EMPTY).count();
    assert_eq!(non_empty_tiles as u64, report["tiles"].as_u64().unwrap());
    assert_eq!(index.interiors.len() as u64, report["interiors"].as_u64().unwrap());

    println!(
        "region admitted: {} packs / {} records / {} pack bytes / {} section bytes",
        st.packs_resident, st.records, st.pack_file_bytes, st.section_bytes
    );
}

#[test]
#[ignore = "T10-region + base-DAT differ — run explicitly (see module docs)"]
fn region_records_byte_identical_to_base_dats() {
    let root = region_root();
    let (index_bytes, _index) = load_index(&root);
    let src = PackSource::from_index_bytes(&index_bytes).expect("index parse");
    admit_all(&root, &src);

    let base = PathBuf::from(BASE_DATS);
    assert!(base.is_dir(), "base DATs missing at {BASE_DATS} (bake-base-dats-only rule)");
    let portal = DatDatabase::new(base.join("client_portal.dat")).expect("open portal.dat");
    let cell = DatDatabase::new(base.join("client_cell_1.dat")).expect("open cell.dat");

    // The consumer-side differ: EVERY record the pack source serves must be
    // byte-identical to its base-DAT origin (GATE-WIRE-BOOT's "rendered
    // world byte-identical" premise for the record lane).
    let keys = src.record_keys();
    assert!(keys.len() > 1000, "suspiciously few records: {}", keys.len());
    let mut checked = 0usize;
    for (ns, fid) in keys {
        let packed = src
            .get_file_by_key(ResourceKey::new(&ns, fid))
            .unwrap_or_else(|e| panic!("pack read {ns}:0x{fid:08X}: {e}"));
        let db = match ns.as_str() {
            "eor/portal" => &portal,
            "eor/cell" => &cell,
            other => panic!("unexpected namespace {other}"),
        };
        let dat = db
            .get_file(fid)
            .unwrap_or_else(|e| panic!("DAT read {ns}:0x{fid:08X}: {e}"));
        assert_eq!(packed, dat, "byte mismatch at {ns}:0x{fid:08X}");
        checked += 1;
    }
    println!("differ: {checked} records byte-identical to base DATs");
}

#[test]
#[ignore = "T10-region composite smoke — run explicitly (see module docs)"]
fn region_composite_serves_packs_first_with_stub_legacy() {
    struct NeverLegacy;
    impl ResourceSource for NeverLegacy {
        fn get_file_by_key(&self, key: ResourceKey<'_>) -> holtburger_dat::Result<Vec<u8>> {
            Err(holtburger_dat::DatError::Other(format!(
                "legacy hit for {}:0x{:08X} — pack should have served this",
                key.namespace, key.file_id
            )))
        }
        fn get_metadata_by_key(&self, _: ResourceKey<'_>) -> Option<holtburger_dat::FileMetadata> {
            None
        }
        fn has_namespace(&self, _: &str) -> bool {
            false
        }
    }

    let root = region_root();
    let (index_bytes, _) = load_index(&root);
    let src = Arc::new(PackSource::from_index_bytes(&index_bytes).expect("index parse"));
    admit_all(&root, &src);
    let composite =
        holtburger_resource_http::CompositeSource::new(src.clone(), Arc::new(NeverLegacy));

    // Every pack-resident record reads through the composite WITHOUT
    // touching the legacy arm (NeverLegacy errors if reached).
    let mut n = 0usize;
    for (ns, fid) in src.record_keys() {
        composite
            .get_file_by_key(ResourceKey::new(&ns, fid))
            .unwrap_or_else(|e| panic!("composite read {ns}:0x{fid:08X}: {e}"));
        n += 1;
    }
    // And a key nowhere resident falls through to the legacy error.
    assert!(
        composite
            .get_file_by_key(ResourceKey::new("eor/portal", 0x0100_0000))
            .is_err()
            || src.serves(ResourceKey::new("eor/portal", 0x0100_0000)),
        "unresident key must fall through to legacy"
    );
    println!("composite: {n} pack-first reads, 0 legacy hits");
}
