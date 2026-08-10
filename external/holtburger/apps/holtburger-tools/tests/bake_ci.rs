//! BAKE-CI — pipeline re-engineering T10 (SPEC §3 T10, GATE-BAKE).
//!
//! Two tiers:
//!
//!  * Fixture tests (always run): the legacy emitter's wire shape is
//!    untouched by T10 — `manifest.json` gains NO keys on a legacy bake.
//!
//!  * `bake_ci_bounded_region` (`#[ignore]` — needs `~/ac_base_dats` +
//!    `/mnt/wbterminal2`): the laptop-scale GATE-BAKE arm over a BOUNDED
//!    region (the Holtburg boot neighborhood ring + the densest-interior
//!    3×3 town/dungeon ring, auto-selected deterministically from the cell
//!    DAT). The FULL-WORLD bake is a buildbox job by design (I5: 8 GB
//!    laptop) — this arm proves the machinery, not world-scale numbers.
//!    Gates covered here:
//!      1. closure completeness (`--verify-closure` semantics) incl.
//!         `texrefMissingPvw = 0` (auto-runs the offline xu7 deriver when
//!         node + the vendored transcoder are available);
//!      2. determinism — two full runs, `packs/` + `index/` byte-identical;
//!      3. byte-identity differ — ≥ 50 model records + ≥ 10 EnvCells
//!         decoded through the pack containers vs straight DAT reads;
//!      4. zstd ratio report + POST-coverage ring preview re-score
//!         (F-11.16) — published to /mnt/wbterminal2/reeng/T10/;
//!      5. additive-only guarantee — the pack step touches nothing but
//!         {packs/, index/, pack-report.json, bake-source.sha256} and adds
//!         exactly the two additive keys to manifest.json.
//!
//! Run:
//!   kill $(pgrep -f rust-analyzer)
//!   env PATH=... capped-build cargo test -p holtburger-tools --release \
//!       --test bake_ci -- --ignored --nocapture

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use holtburger_dat::DatDatabase;
use holtburger_manifest::v2::ManifestV2;
use holtburger_tools::pack_bake::{PackBakeOptions, RegionRect, emit_packs};
use holtburger_tools::pack_format::{
    HbpReader, PACK_ZSTD_LEVEL, parse_hbsi1, section_kind,
};
use sha2::{Digest, Sha256};

const PORTAL_DAT: &str = "/home/wbterminal/ac_base_dats/client_portal.dat";
const CELL_DAT: &str = "/home/wbterminal/ac_base_dats/client_cell_1.dat";
const OUT_ROOT: &str = "/mnt/wbterminal2/reeng/T10";
/// RELIEF-IN-BAKE arm output (big artifacts never land in the source tree).
const RELIEF_OUT_ROOT: &str = "/mnt/wbterminal2/reeng/relief-bake";
const DIST: &str = "/mnt/wbterminal2/holtburger-dist-hires-bc7m-xu7t2";
const TEX_PRE: &str = "/mnt/wbterminal2/tex-bc7-pre/pre";
const TEX_BC7: &str = "/mnt/wbterminal2/pbr-terrain/bc7/blocks-mip";
const TEX_XU7: &str = "/mnt/wbterminal2/xu7-ingest";

fn repo_root() -> PathBuf {
    // apps/holtburger-tools -> repo root
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().unwrap()
}

fn opt_dir(p: &str) -> Option<PathBuf> {
    let path = PathBuf::from(p);
    path.is_dir().then_some(path)
}

fn sha16_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    let d = h.finalize();
    d[..16].iter().map(|b| format!("{b:02x}")).collect()
}

/// Relative path -> sha256_16 for every file under `dir`.
fn tree_digest(dir: &Path) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    fn walk(base: &Path, dir: &Path, out: &mut BTreeMap<String, String>) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for entry in rd.flatten() {
            let p = entry.path();
            if p.is_dir() {
                walk(base, &p, out);
            } else if p.is_file() {
                let rel = p.strip_prefix(base).unwrap().to_string_lossy().into_owned();
                let bytes = std::fs::read(&p).unwrap();
                out.insert(rel, sha16_hex(&bytes));
            }
        }
    }
    walk(dir, dir, &mut out);
    out
}

/// Minimal valid v2 manifest — stands in for the legacy bake's output in
/// packs-only CI dirs (the pack emitter amends an EXISTING manifest; the
/// dual-emit CLI shape runs the unchanged legacy path first).
fn write_prelude_manifest(dir: &Path) {
    std::fs::create_dir_all(dir).unwrap();
    let json = r#"{
  "version": 2,
  "generated_at": "2026-08-08T00:00:00Z",
  "source": { "portal_dat_iteration": 0, "cell_dat_iteration": 0, "local_dat_iteration": 0 },
  "boot_pack": { "url": "boot.hba", "size": 0, "sha256": "0000000000000000000000000000000000000000000000000000000000000000" },
  "catalog_version": 1,
  "namespaces": ["eor/cell", "eor/portal"],
  "shard_url_template": "shards/{sha256_prefix2}/{sha256}.bin",
  "catalog_url_template": "manifest/{namespace_slug}.bin"
}"#;
    std::fs::write(dir.join("manifest.json"), json).unwrap();
}

/// Deterministically pick the LB with the largest EnvCell byte total —
/// the densest interior in the cell DAT (a big dungeon / town interior) —
/// and return its 3×3 neighborhood rectangle.
fn densest_interior_rect(cell: &DatDatabase) -> RegionRect {
    let mut per_lb: BTreeMap<u16, u64> = BTreeMap::new();
    for (&fid, entry) in &cell.files {
        let low = (fid & 0xFFFF) as u16;
        if (0x0100..=0xFFFD).contains(&low) {
            *per_lb.entry((fid >> 16) as u16).or_default() += entry.size as u64;
        }
    }
    let (&lb, _) = per_lb
        .iter()
        .max_by_key(|&(&lb, &bytes)| (bytes, lb)) // bytes, then id: total order
        .expect("cell DAT has EnvCells");
    let (x, y) = ((lb >> 8) as u8, (lb & 0xFF) as u8);
    RegionRect {
        x0: x.saturating_sub(1),
        y0: y.saturating_sub(1),
        x1: x.saturating_add(1),
        y1: y.saturating_add(1),
    }
}

fn ci_options(out: &Path, extra_pvw: Option<PathBuf>) -> PackBakeOptions {
    let cell = DatDatabase::new(CELL_DAT).expect("open cell dat");
    let dungeon = densest_interior_rect(&cell);
    drop(cell);
    let dist = Path::new(DIST);
    PackBakeOptions {
        eor_portal: PathBuf::from(PORTAL_DAT),
        eor_cell: PathBuf::from(CELL_DAT),
        scenery_dir: Some(dist.join("scenery")).filter(|p| p.is_dir()),
        spawns_dir: Some(dist.join("spawns")).filter(|p| p.is_dir()),
        events_dir: Some(dist.join("events")).filter(|p| p.is_dir()),
        tex_bc7: opt_dir(TEX_BC7),
        tex_bc7_pre: opt_dir(TEX_PRE),
        tex_xu7: opt_dir(TEX_XU7),
        tex_pvw_extra: extra_pvw,
        terrain_bc7_dir: Some(
            repo_root().join("apps/holtburger-web/scene3d/assets/terrain_bc7/t1024"),
        )
        .filter(|p| p.is_dir()),
        regions: Some(vec![
            // Holtburg 11×11 boot neighborhood (0xA9B4 ± 5).
            RegionRect { x0: 0xA4, y0: 0xAF, x1: 0xAE, y1: 0xB9 },
            dungeon,
        ]),
        boot_landblock: 0xA9B4,
        output_dir: out.to_path_buf(),
        zstd_level: PACK_ZSTD_LEVEL,
        verify_closure: true,
        verify_deterministic: true,
        geom_relief_scale: None,
    }
}

/// Fixture tier: a legacy bake's manifest must NOT grow pack keys — the
/// additive fields serialize only when the pack emitter sets them, so the
/// legacy wire shape is byte-compatible with pre-T10 deployments.
#[test]
fn legacy_manifest_shape_is_unchanged_by_t10() {
    let json = serde_json::to_string(&ManifestV2 {
        version: 2,
        generated_at: "2026-08-08T00:00:00Z".into(),
        source: holtburger_manifest::SourceMeta {
            portal_dat_iteration: 0,
            cell_dat_iteration: 0,
            local_dat_iteration: 0,
        },
        boot_pack: holtburger_manifest::v2::BootPackV2 {
            url: "boot.hba".into(),
            size: 0,
            sha256: "00".repeat(32),
        },
        catalog_version: 1,
        namespaces: vec![],
        shard_url_template: "shards/{sha256}.bin".into(),
        catalog_url_template: None,
        world_index: None,
        pack_url_template: None,
    })
    .unwrap();
    assert!(!json.contains("world_index"));
    assert!(!json.contains("pack_url_template"));
}

#[test]
#[ignore = "needs ~/ac_base_dats + /mnt/wbterminal2 (laptop GATE-BAKE arm); \
            run with --ignored --nocapture"]
fn bake_ci_bounded_region() {
    assert!(Path::new(PORTAL_DAT).is_file(), "missing {PORTAL_DAT}");
    assert!(Path::new(CELL_DAT).is_file(), "missing {CELL_DAT}");
    let out_root = PathBuf::from(OUT_ROOT);
    std::fs::create_dir_all(&out_root).expect("create /mnt/wbterminal2/reeng/T10");

    let out1 = out_root.join("ci-run1");
    let out2 = out_root.join("ci-run2");
    for d in [&out1, &out2] {
        let _ = std::fs::remove_dir_all(d);
        write_prelude_manifest(d);
    }

    // ---- run 1 (closure + intra-run determinism verified in-bake) ------
    let mut opts1 = ci_options(&out1, None);
    let pre_snapshot = tree_digest(&out1);
    let mut report = emit_packs(&opts1).expect("pack bake run 1");
    println!(
        "run1: {} packs / {} tiles / {} interiors / {} LBs; missingPvw={} \
         legacyOnly={}",
        report.packs_emitted,
        report.tiles,
        report.interiors,
        report.landblocks,
        report.texref_missing_pvw,
        report.texref_legacy_only
    );
    assert!(report.closure_verified, "closure verification must have run");
    assert!(report.determinism_verified);
    assert!(report.patch_ids_rejected == 0, "base DATs must carry no patch ids");
    assert!(report.tiles > 0 && report.interiors > 0, "region must exercise both pack kinds");

    // ---- texrefMissingPvw = 0 (auto-derive xu7-only previews if needed) -
    if report.texref_missing_pvw > 0 {
        let ids_file = out_root.join("pvw-wanted.txt");
        std::fs::write(&ids_file, report.pvw_wanted_from_xu7.join("\n")).unwrap();
        let extra_dir = out_root.join("pvw-extra");
        let script = repo_root().join("apps/holtburger-tools/scripts/derive-pvw-xu7.mjs");
        let status = std::process::Command::new("node")
            .arg(&script)
            .args(["--xu7", TEX_XU7])
            .arg("--out")
            .arg(&extra_dir)
            .arg("--ids")
            .arg(&ids_file)
            .status()
            .expect("node available for xu7 preview derivation");
        assert!(status.success(), "derive-pvw-xu7.mjs failed");
        // Re-bake run 1 with the derived previews.
        let _ = std::fs::remove_dir_all(&out1);
        write_prelude_manifest(&out1);
        opts1 = ci_options(&out1, Some(extra_dir));
        report = emit_packs(&opts1).expect("pack bake run 1 (with extra pvw)");
        println!(
            "run1 rebake: missingPvw={} (extra-derived {})",
            report.texref_missing_pvw, report.pvw_from_extra
        );
    }
    assert_eq!(
        report.texref_missing_pvw, 0,
        "GATE-BAKE: every TEXREF'd rsId with a compressed full tier must \
         have a preview (D-05.5.4)"
    );

    // ---- additive-only guarantee ----------------------------------------
    let post_snapshot = tree_digest(&out1);
    for (rel, digest) in &pre_snapshot {
        if rel == "manifest.json" {
            continue;
        }
        assert_eq!(
            post_snapshot.get(rel),
            Some(digest),
            "pack emission must not touch legacy file {rel}"
        );
    }
    for rel in post_snapshot.keys() {
        let ok = pre_snapshot.contains_key(rel)
            || rel.starts_with("packs/")
            || rel.starts_with("index/")
            || rel == "pack-report.json"
            || rel == "bake-source.sha256";
        assert!(ok, "unexpected new file from pack emission: {rel}");
    }
    let pre_manifest: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(out1.join("manifest.json")).unwrap())
            .unwrap();
    assert!(pre_manifest.get("world_index").is_some());
    assert!(pre_manifest.get("pack_url_template").is_some());
    assert_eq!(pre_manifest.get("version").and_then(|v| v.as_u64()), Some(2));
    {
        // Removing the two additive keys restores the prelude manifest
        // exactly (field-for-field).
        let mut stripped = pre_manifest.clone();
        stripped.as_object_mut().unwrap().remove("world_index");
        stripped.as_object_mut().unwrap().remove("pack_url_template");
        let prelude: serde_json::Value = serde_json::from_str(
            r#"{
  "version": 2,
  "generated_at": "2026-08-08T00:00:00Z",
  "source": { "portal_dat_iteration": 0, "cell_dat_iteration": 0, "local_dat_iteration": 0 },
  "boot_pack": { "url": "boot.hba", "size": 0, "sha256": "0000000000000000000000000000000000000000000000000000000000000000" },
  "catalog_version": 1,
  "namespaces": ["eor/cell", "eor/portal"],
  "shard_url_template": "shards/{sha256_prefix2}/{sha256}.bin",
  "catalog_url_template": "manifest/{namespace_slug}.bin"
}"#,
        )
        .unwrap();
        assert_eq!(stripped, prelude, "manifest edit must be strictly additive");
    }

    // ---- run 2: cross-run determinism ------------------------------------
    let opts2 = PackBakeOptions {
        output_dir: out2.clone(),
        tex_pvw_extra: opts1.tex_pvw_extra.clone(),
        ..ci_options(&out2, None)
    };
    emit_packs(&opts2).expect("pack bake run 2");
    let t1: BTreeMap<String, String> = tree_digest(&out1)
        .into_iter()
        .filter(|(k, _)| k.starts_with("packs/") || k.starts_with("index/"))
        .collect();
    let t2: BTreeMap<String, String> = tree_digest(&out2)
        .into_iter()
        .filter(|(k, _)| k.starts_with("packs/") || k.starts_with("index/"))
        .collect();
    assert_eq!(t1, t2, "GATE-BAKE: re-bake of unchanged input must be byte-identical");

    // ---- byte-identity differ (≥ 50 models + ≥ 10 EnvCells) -------------
    let index_rel = pre_manifest["world_index"]["url"].as_str().unwrap();
    let index_bytes = std::fs::read(out1.join(index_rel)).unwrap();
    let index = parse_hbsi1(&index_bytes).expect("parse HBSI1");
    assert_eq!(index.packs.len(), report.packs_emitted);

    let portal = DatDatabase::new(PORTAL_DAT).unwrap();
    let cell = DatDatabase::new(CELL_DAT).unwrap();
    let mut models_checked = 0usize;
    let mut envcells_checked = 0usize;
    let mut model_ids_seen: BTreeSet<u32> = BTreeSet::new();
    for entry in &index.packs {
        let hexname: String = entry.hash16.iter().map(|b| format!("{b:02x}")).collect();
        let path = out1.join("packs").join(&hexname[..2]).join(format!("{hexname}.hbp"));
        let bytes = std::fs::read(&path)
            .unwrap_or_else(|e| panic!("pack {hexname} listed in index missing: {e}"));
        // CAS name == content hash (integrity chain).
        assert_eq!(sha16_hex(&bytes), hexname, "pack CAS name must match bytes");
        assert_eq!(bytes.len() as u32, entry.size, "index size must match pack");
        let reader = HbpReader::parse(&bytes).expect("pack parses + CRC ok");
        for kind in [section_kind::RECORDS, section_kind::ENVCELLS] {
            let Some(records) = reader.record_stream(kind).expect("stream parses") else {
                continue;
            };
            for ((ns, fid), rec_bytes) in records {
                let dat_bytes = match ns {
                    0 => cell.get_file(fid),
                    1 => portal.get_file(fid),
                    other => panic!("unexpected ns ordinal {other}"),
                }
                .unwrap_or_else(|e| panic!("DAT read 0x{fid:08X}: {e}"));
                assert_eq!(
                    rec_bytes, dat_bytes,
                    "pack record 0x{fid:08X} must be byte-identical to the DAT"
                );
                match fid >> 24 {
                    0x01 | 0x02 => {
                        if model_ids_seen.insert(fid) {
                            models_checked += 1;
                        }
                    }
                    _ if kind == section_kind::ENVCELLS => envcells_checked += 1,
                    _ => {}
                }
            }
        }
    }
    println!("differ: {models_checked} unique models, {envcells_checked} envcells byte-verified");

    // ---- T13 (ST3): HBG1 GEOM differ ------------------------------------
    // Every GEOM row in every pack re-encodes byte-identically from the base
    // DATs (pins the emission memo + codec determinism through the container;
    // the runtime-triangulator differ lives in holtburger-web's native tests).
    // Coverage/co-location/kind checks already ran in-bake (verify_geom).
    {
        use holtburger_dat::hbg1;
        struct DatPair {
            portal: DatDatabase,
            cell: DatDatabase,
        }
        impl holtburger_dat::ResourceSource for DatPair {
            fn get_file_by_key(
                &self,
                key: holtburger_dat::ResourceKey<'_>,
            ) -> holtburger_dat::Result<Vec<u8>> {
                match key.namespace {
                    "eor/portal" => self.portal.get_file(key.file_id),
                    "eor/cell" => self.cell.get_file(key.file_id),
                    _ => Err(holtburger_dat::DatError::NotFound(key.file_id)),
                }
            }
            fn get_metadata_by_key(
                &self,
                _key: holtburger_dat::ResourceKey<'_>,
            ) -> Option<holtburger_dat::FileMetadata> {
                None
            }
            fn has_namespace(&self, namespace: &str) -> bool {
                namespace == "eor/portal" || namespace == "eor/cell"
            }
        }
        let pair = DatPair {
            portal: DatDatabase::new(PORTAL_DAT).unwrap(),
            cell: DatDatabase::new(CELL_DAT).unwrap(),
        };
        let mut geom_checked: BTreeSet<u32> = BTreeSet::new();
        let mut geom_rows_total = 0usize;
        for entry in &index.packs {
            let hexname: String =
                entry.hash16.iter().map(|b| format!("{b:02x}")).collect();
            let path =
                out1.join("packs").join(&hexname[..2]).join(format!("{hexname}.hbp"));
            let bytes = std::fs::read(&path).unwrap();
            let reader = HbpReader::parse(&bytes).unwrap();
            let Some(payload) = reader.section(0x09).expect("GEOM section parses") else {
                continue;
            };
            let rows = hbg1::parse_geom_section(&payload).expect("GEOM rows parse");
            geom_rows_total += rows.len();
            for (id, enc, off, size) in rows {
                assert_eq!(enc, hbg1::ENCODING_HBG1);
                let baked = &payload[off..off + size];
                if !geom_checked.insert(id) {
                    // Inline records repeat across tile packs — the payload
                    // must still be byte-identical, so re-check cheaply.
                }
                let rec = pair.portal.get_file(id).expect("model record in DAT");
                let reenc = match (id >> 24) as u8 {
                    0x01 => hbg1::encode_gfx_part(
                        &holtburger_dat::file_type::GfxObj::unpack(
                            &mut std::io::Cursor::new(&rec),
                        )
                        .unwrap(),
                    ),
                    0x02 => hbg1::encode_setup_directory(
                        &pair,
                        &holtburger_dat::file_type::SetupModel::unpack(
                            &mut std::io::Cursor::new(&rec),
                        )
                        .unwrap(),
                    ),
                    _ => hbg1::encode_env_directory(
                        &holtburger_dat::file_type::Environment::unpack(
                            &mut std::io::Cursor::new(&rec),
                        )
                        .unwrap(),
                    ),
                }
                .expect("re-encode");
                assert_eq!(
                    baked,
                    &reenc[..],
                    "GEOM 0x{id:08X}: baked payload must re-encode byte-identically"
                );
            }
        }
        println!(
            "HBG1 differ: {} unique payloads / {} rows byte-identical re-encode; \
             report: {} rows / {:.2} MB raw / soft-cap hits {} / max payload {} B",
            geom_checked.len(),
            geom_rows_total,
            report.geom_rows,
            report.geom_bytes_raw as f64 / 1e6,
            report.geom_soft_cap_hits,
            report.geom_max_payload_bytes,
        );
        assert!(report.geom_rows > 0, "GEOM emission must have fired");
        assert!(
            geom_checked.len() >= 50,
            "HBG1 differ needs ≥ 50 payloads (got {})",
            geom_checked.len()
        );
    }
    assert!(
        models_checked >= 50,
        "differ needs ≥ 50 models (got {models_checked}) — grow the region"
    );
    assert!(
        envcells_checked >= 10,
        "differ needs ≥ 10 EnvCells (got {envcells_checked}) — grow the region"
    );

    // ---- zstd ratio + ring re-score published ---------------------------
    assert!(
        !report.section_ratios.is_empty(),
        "zstd ratio report must be populated (re-scores B1 slack, R-01)"
    );
    assert!(report.ring_tiles > 0, "boot ring must be inside the baked region");
    std::fs::copy(
        out1.join("pack-report.json"),
        out_root.join("bake-ci-report.json"),
    )
    .unwrap();
    println!(
        "ring: {} tiles / {:.2} MB tile packs / {:.2} MB previews (POST-coverage); \
         meta-commons {:.2} MB; widened-commons {:.2} MB; t128 slices {:.2}+{:.2} MB",
        report.ring_tiles,
        report.ring_tile_pack_bytes as f64 / 1e6,
        report.ring_preview_bytes as f64 / 1e6,
        report.meta_commons_bytes as f64 / 1e6,
        report.widened_commons_bytes as f64 / 1e6,
        report.terrain_slice_color_bytes as f64 / 1e6,
        report.terrain_slice_nra_bytes as f64 / 1e6,
    );
}

// ---------------------------------------------------------------------------
// RELIEF-IN-BAKE — the relief-variant bake leg
// ---------------------------------------------------------------------------

/// BAKE-CI leg for relief variants: bake the SAME bounded region with
/// `--geom-relief 1.0` and prove the two acceptance properties that make the
/// variant shippable:
///
/// (a) the relief-free default is **untouched** — every GEOM row still
///     re-encodes byte-identically through `encode_gfx_part` (the existing
///     differ baseline is not perturbed by the variant pass existing); and
/// (b) every GEOMR row byte-matches a **fresh variant encode** from the base
///     DATs (`encode_gfx_part_relief`), i.e. the variant is reproducible and
///     deterministic through the container exactly like the default.
///
/// The structural additive check (same subset table, appended triangles only)
/// runs IN-BAKE via `verify_geom`, which this leg turns on.
///
/// Deliberately a separate test from `bake_ci_bounded_region`: that arm must
/// keep baking the relief-free world so its determinism + differ legs stay the
/// clean target (SPEC §3 T10 GATE-BAKE).
#[test]
#[ignore = "needs ~/ac_base_dats + /mnt/wbterminal2 (RELIEF-IN-BAKE arm); \
            run with --ignored --nocapture"]
fn bake_ci_relief_variants() {
    use holtburger_dat::hbg1;
    assert!(Path::new(PORTAL_DAT).is_file(), "missing {PORTAL_DAT}");
    assert!(Path::new(CELL_DAT).is_file(), "missing {CELL_DAT}");
    let out_root = PathBuf::from(RELIEF_OUT_ROOT);
    std::fs::create_dir_all(&out_root).expect("create /mnt/wbterminal2/reeng/relief-bake");
    let out = out_root.join("relief-run1");
    let _ = std::fs::remove_dir_all(&out);
    write_prelude_manifest(&out);

    let opts = PackBakeOptions {
        geom_relief_scale: Some(1.0),
        // Intra-run determinism is proven by the relief-free arm; skip the
        // second in-process emission here to keep the laptop arm bounded.
        verify_deterministic: false,
        ..ci_options(&out, None)
    };
    let report = emit_packs(&opts).expect("relief pack bake");
    assert!(report.closure_verified, "verify_geom (incl. the GEOMR additive leg) must run");
    assert!(
        !report.geom_relief_variant.is_empty(),
        "the report must record WHICH variant this dist carries"
    );
    assert!(report.geom_relief_rows > 0, "relief variant emission must have fired");
    assert!(
        report.geom_relief_models_changed > 0,
        "no model gained rails — the profile or the gate is wrong"
    );
    assert!(report.geom_relief_added_tris > 0);

    let portal = DatDatabase::new(PORTAL_DAT).unwrap();
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(out.join("manifest.json")).unwrap()).unwrap();
    let index_rel = manifest["world_index"]["url"].as_str().expect("world_index url");
    let index = parse_hbsi1(&std::fs::read(out.join(index_rel)).unwrap())
        .expect("index parses");

    let mut default_checked: BTreeSet<u32> = BTreeSet::new();
    let mut variant_checked: BTreeSet<u32> = BTreeSet::new();
    let mut variant_rows = 0usize;
    let mut added_tris_seen = 0u64;
    let relief = hbg1::ReliefBake::from_scale(1.0);
    for entry in &index.packs {
        let hexname: String = entry.hash16.iter().map(|b| format!("{b:02x}")).collect();
        let path = out.join("packs").join(&hexname[..2]).join(format!("{hexname}.hbp"));
        let bytes = std::fs::read(&path).unwrap();
        let reader = HbpReader::parse(&bytes).unwrap();

        // (a) the relief-free default is byte-identical to today's encode.
        if let Some(payload) = reader.section(section_kind::GEOM).expect("GEOM parses") {
            for (id, enc, off, size) in
                hbg1::parse_geom_section(&payload).expect("GEOM rows parse")
            {
                assert_eq!(enc, hbg1::ENCODING_HBG1);
                if (id >> 24) as u8 != 0x01 {
                    continue;
                }
                let rec = portal.get_file(id).expect("model record in DAT");
                let gfx = holtburger_dat::file_type::GfxObj::unpack(
                    &mut std::io::Cursor::new(&rec),
                )
                .unwrap();
                assert_eq!(
                    &payload[off..off + size],
                    &hbg1::encode_gfx_part(&gfx).expect("default re-encode")[..],
                    "GEOM 0x{id:08X}: relief-free default drifted"
                );
                default_checked.insert(id);
            }
        }

        // (b) every variant row re-encodes byte-identically, and is additive
        //     over the co-located default row.
        let Some(vpayload) = reader
            .section(section_kind::GEOM_RELIEF)
            .expect("GEOMR parses")
        else {
            continue;
        };
        let base = reader.section(section_kind::GEOM).unwrap().unwrap();
        let base_rows: BTreeMap<u32, (usize, usize)> =
            hbg1::parse_geom_section(&base)
                .unwrap()
                .into_iter()
                .map(|(id, _, off, size)| (id, (off, size)))
                .collect();
        for (id, enc, off, size) in
            hbg1::parse_geom_section(&vpayload).expect("GEOMR rows parse")
        {
            assert_eq!(enc, hbg1::ENCODING_HBG1);
            variant_rows += 1;
            let rec = portal.get_file(id).expect("model record in DAT");
            let gfx =
                holtburger_dat::file_type::GfxObj::unpack(&mut std::io::Cursor::new(&rec))
                    .unwrap();
            let fresh = hbg1::encode_gfx_part_relief(&gfx, &relief).expect("variant encode");
            assert_eq!(
                &vpayload[off..off + size],
                &fresh[..],
                "GEOMR 0x{id:08X}: baked variant must re-encode byte-identically"
            );
            let (boff, bsize) = base_rows[&id];
            let bm = hbg1::Hbg1Mesh::parse(&base[boff..boff + bsize]).unwrap();
            let vm = hbg1::Hbg1Mesh::parse(&fresh).unwrap();
            assert!(vm.index_count > bm.index_count, "variant 0x{id:08X} adds nothing");
            added_tris_seen += ((vm.index_count - bm.index_count) / 3) as u64;
            variant_checked.insert(id);
        }
    }
    println!(
        "RELIEF differ: variant={} | {} default 0x01 rows byte-identical | \
         {} unique variants / {} rows byte-identical re-encode | \
         report: changed {} / identical {} / +{} tris / {:.2} MB raw / max {} B | \
         differ +{} tris",
        report.geom_relief_variant,
        default_checked.len(),
        variant_checked.len(),
        variant_rows,
        report.geom_relief_models_changed,
        report.geom_relief_models_identical,
        report.geom_relief_added_tris,
        report.geom_relief_bytes_raw as f64 / 1e6,
        report.geom_relief_max_payload_bytes,
        added_tris_seen,
    );
    assert!(
        variant_checked.len() >= 10,
        "relief differ needs ≥ 10 variant payloads (got {}) — grow the region \
         or check ModelGate",
        variant_checked.len()
    );
    std::fs::copy(
        out.join("pack-report.json"),
        out_root.join("relief-bake-report.json"),
    )
    .unwrap();
}
