//! Cross-language check for the 2026-10-06 regional catalogs: the region
//! files are WRITTEN by `scripts/split-catalog-regions.mjs` (Node) and READ by
//! `NamespaceCatalog::read_from` (this crate, inside the wasm client). This
//! test reads the region set the deployed dist actually carries and proves
//! (a) every file parses (magic, CRC, varints), (b) every entry sits in the
//! region `CatalogRegions::region_of` assigns it, and (c) the regions
//! partition the whole-namespace catalog exactly — same ids, same hashes,
//! same sizes.
//!
//! Real data, per the house rule: when the dist (or its region set) is not
//! present on this machine there is nothing to check, and the test says so.

use std::path::PathBuf;

use holtburger_manifest::catalog::NamespaceCatalog;
use holtburger_manifest::v2::{CatalogRegions, DEFAULT_CATALOG_REGION_URL_TEMPLATE};

#[test]
fn js_written_region_catalogs_partition_the_real_eor_cell_catalog() {
    let dist = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../dist");
    let whole_path = dist.join("manifest/eor-cell.bin");
    let regions_dir = dist.join("manifest/regions/eor-cell");
    if !whole_path.exists() || !regions_dir.exists() {
        eprintln!(
            "catalog_regions_real: {} or {} absent on this machine — real-data check not run",
            whole_path.display(),
            regions_dir.display()
        );
        return;
    }
    let whole = NamespaceCatalog::read_from(&std::fs::read(&whole_path).unwrap(), "eor/cell")
        .expect("whole eor-cell catalog parses");
    let split = CatalogRegions {
        url_template: DEFAULT_CATALOG_REGION_URL_TEMPLATE.into(),
        lb_block: 8,
    };
    assert_eq!(split.region_count(), 1024);

    let mut total = 0usize;
    for region in 0..split.region_count() {
        let p = regions_dir.join(format!("{region:03x}.bin"));
        let bytes = std::fs::read(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
        let cat = NamespaceCatalog::read_from(&bytes, "eor/cell")
            .unwrap_or_else(|e| panic!("{}: {e}", p.display()));
        assert_eq!(cat.flags, whole.flags, "region {region:03x} flags");
        for e in &cat.entries {
            assert_eq!(
                split.region_of(e.file_id),
                Some(region),
                "0x{:08X} filed under region {region:03x}",
                e.file_id
            );
            let w = whole
                .lookup(e.file_id)
                .unwrap_or_else(|| panic!("0x{:08X} not in the whole catalog", e.file_id));
            assert_eq!(w, e, "0x{:08X} differs from the whole catalog", e.file_id);
        }
        total += cat.entries.len();
    }
    assert_eq!(total, whole.entries.len(), "regions must partition the namespace exactly");
}
