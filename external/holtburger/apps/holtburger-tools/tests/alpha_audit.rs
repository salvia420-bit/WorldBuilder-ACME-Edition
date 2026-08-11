//! TEXBC7-ALPHA-AUDIT — real-record tests.
//!
//! `src/alpha_audit.rs`'s own `#[cfg(test)]` module pins the pure
//! arithmetic (the four classes, the PFID capability table, the verdict
//! table, the PNG/KTX2 container readers). THIS file pins the tool against
//! `~/ac_base_dats/` — the test-fixtures-real-data rule — because the whole
//! claim of the audit is "the DAT is the truth", and a classifier that only
//! ever meets hand-built bytes has never met that claim.
//!
//! Every test here is `#[ignore]`d in the house style (`bake_ci.rs`,
//! `page_resample.rs`): the retail DATs are not in the repo. Run:
//!
//! ```text
//!   cargo test -p holtburger-tools --test alpha_audit -- --ignored --nocapture
//! ```
//!
//! The two cited records come from the batch-D queue item and from
//! 062e5ce3's live A/B at Yaraq:
//!
//!  * `rs 0x0600396B` — the standard portal's albedo. 8x8 PFID_DXT1, four
//!    blocks of `c0=0x0000 c1=0x0001 / indices=0xFFFFFFFF`. c0 <= c1 is
//!    punch-through mode and index 3 is the transparent texel, so the whole
//!    record is `(0,0,0,0)`. The hires upscaler shipped it as 32x32 OPAQUE.
//!  * `rs 0x060037A3` — the queue item's second id. Measured here (not
//!    assumed): 8x8 PFID_INDEX16 behind `Base1ClipMap` Surface
//!    `0x08000015` — the OTHER surface 062e5ce3's live blast-radius read
//!    vetoed — so retail's palette-index < 8 rule zeroes all 64 texels.
//!    Same class, reached down a completely different decode path, which is
//!    why keeping both is worth it.

use std::collections::BTreeMap;
use std::path::Path;

use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::{
    Palette, Surface, SurfaceTexture, SurfacePixelFormat, Texture, TextureDecodeError,
};
use holtburger_tools::alpha_audit::{
    AlphaClass, AlphaSource, SURFACE_BASE1_CLIPMAP, Verdict, classify_texture, decide,
    format_carries_alpha,
};

const PORTAL_DAT: &str = "/home/wbterminal/ac_base_dats/client_portal.dat";

/// The portal albedo the whole item is about.
const RS_PORTAL_SWIRL: u32 = 0x0600_396B;
/// The queue item's second cited record.
const RS_SECOND: u32 = 0x0600_37A3;
/// `Base1ClipMap` Surface over `RS_PORTAL_SWIRL` (062e5ce3).
const SURFACE_PORTAL: u32 = 0x0800_0157;
/// The second surface 062e5ce3's Yaraq blast-radius read vetoed.
const SURFACE_SECOND: u32 = 0x0800_0015;

fn portal() -> DatDatabase {
    assert!(Path::new(PORTAL_DAT).is_file(), "missing {PORTAL_DAT}");
    DatDatabase::new(PORTAL_DAT).expect("open portal dat")
}

fn texture(db: &DatDatabase, id: u32) -> Texture {
    let bytes = db.get_file(id).unwrap_or_else(|e| panic!("read 0x{id:08X}: {e}"));
    Texture::unpack(&bytes).unwrap_or_else(|e| panic!("parse 0x{id:08X}: {e}"))
}

fn palette_closure(db: &DatDatabase) -> impl Fn(u32) -> Result<Palette, TextureDecodeError> + '_ {
    move |pid| {
        let bytes = db.get_file(pid).map_err(|e| TextureDecodeError::PaletteFetch(e.to_string()))?;
        Palette::unpack(&bytes).map_err(|e| TextureDecodeError::PaletteFetch(e.to_string()))
    }
}

/// `Surface -> SurfaceTexture -> Texture`, the chain the tool indexes.
/// Read-verified in `file_type/surface.rs`: `orig_texture_id` is a 0x05 id
/// despite the name.
fn surface_chain(db: &DatDatabase, sid: u32) -> (u32, Vec<u32>) {
    let s = Surface::unpack(&db.get_file(sid).expect("read surface"))
        .unwrap_or_else(|e| panic!("parse surface 0x{sid:08X}: {e}"));
    let refs = s.texture_refs.as_ref().expect("surface is textured");
    let st = SurfaceTexture::unpack(&db.get_file(refs.orig_texture_id).expect("read 0x05"))
        .expect("parse SurfaceTexture");
    (s.surface_type, st.textures)
}

// ---------------------------------------------------------------------------

#[test]
#[ignore = "needs ~/ac_base_dats/client_portal.dat"]
fn portal_swirl_record_is_fully_transparent() {
    let db = portal();
    let tex = texture(&db, RS_PORTAL_SWIRL);

    // The record shape 062e5ce3 measured, re-measured here.
    assert_eq!(tex.format(), SurfacePixelFormat::Dxt1);
    assert_eq!(tex.actual_dimensions(), (8, 8));
    assert_eq!(
        tex.source_data.len(),
        32,
        "8x8 DXT1 = 4 blocks x 8 B; got {} B",
        tex.source_data.len()
    );
    for (i, block) in tex.source_data.chunks_exact(8).enumerate() {
        let c0 = u16::from_le_bytes([block[0], block[1]]);
        let c1 = u16::from_le_bytes([block[2], block[3]]);
        assert!(c0 <= c1, "block {i}: c0=0x{c0:04X} c1=0x{c1:04X} is not punch-through mode");
        assert_eq!(&block[4..8], &[0xFF, 0xFF, 0xFF, 0xFF], "block {i}: not all-index-3");
    }

    // THE assertion the acceptance names.
    let facts = classify_texture(&tex, /*clipmap*/ true, 0, palette_closure(&db));
    assert_eq!(facts.class, AlphaClass::FullyTransparent, "0x0600396B datAlphaClass");
    assert_eq!(facts.source, AlphaSource::Dxt1PunchThrough);
    assert_eq!(facts.stats.texels, 64);
    assert_eq!(facts.stats.zero, 64);
    assert_eq!(facts.stats.max, 0);
    assert_eq!(facts.zero_frac, 1.0);

    // The clipmap bit is irrelevant for DXT1 (it only gates the palette
    // index < 8 rule), so the class must not depend on it.
    let no_clip = classify_texture(&tex, false, 0, palette_closure(&db));
    assert_eq!(no_clip.class, facts.class);

    // And the queue item's rule: a fully-transparent DAT record is SKIP
    // against every possible corpus class, under both strictness settings.
    for corpus in [
        AlphaClass::Opaque,
        AlphaClass::FullyTransparent,
        AlphaClass::PunchThrough,
        AlphaClass::GradientAlpha,
        AlphaClass::Undetermined,
    ] {
        for strict in [false, true] {
            let (v, reason, _) = decide(facts.class, corpus, strict);
            assert_eq!(v, Verdict::Skip, "{corpus:?} strict={strict}");
            assert!(reason.contains("zero information"), "{reason}");
        }
    }
}

#[test]
#[ignore = "needs ~/ac_base_dats/client_portal.dat"]
fn second_cited_record_is_fully_transparent_via_the_clipmap_rule() {
    let db = portal();
    let tex = texture(&db, RS_SECOND);

    // Measured, not assumed: this one is palettized, so its transparency
    // comes from retail's ImgTex::CopyIntoData index < 8 rule rather than
    // from a DXT punch-through block.
    assert_eq!(tex.format(), SurfacePixelFormat::Index16);
    assert_eq!(tex.actual_dimensions(), (8, 8));

    let facts = classify_texture(&tex, /*clipmap*/ true, 0, palette_closure(&db));
    assert_eq!(facts.class, AlphaClass::FullyTransparent, "0x060037A3 datAlphaClass");
    assert_eq!(facts.source, AlphaSource::PaletteArgb);
    assert_eq!(facts.stats.texels, 64);
    assert_eq!(facts.stats.zero, 64);

    // This is the load-bearing half: WITHOUT the clipmap bit the same
    // record decodes to its palette colours and is opaque. So the audit's
    // Surface index is not an ornament — drop it and this record's verdict
    // flips from SKIP to a false KEEP/REBAKE.
    let no_clip = classify_texture(&tex, false, 0, palette_closure(&db));
    assert_ne!(
        no_clip.class,
        AlphaClass::FullyTransparent,
        "0x060037A3 decoded without the clipmap bit must NOT be fully transparent — \
         if this ever passes, the index<8 rule stopped being load-bearing"
    );
}

#[test]
#[ignore = "needs ~/ac_base_dats/client_portal.dat"]
fn both_cited_records_hang_off_the_two_surfaces_the_client_veto_measured() {
    let db = portal();

    // 062e5ce3: "exactly 2 surfaces vetoed (0x08000157 and 0x08000015)".
    // The audit must reach the same two from the DAT side alone.
    let (ty, chain) = surface_chain(&db, SURFACE_PORTAL);
    assert_ne!(ty & SURFACE_BASE1_CLIPMAP, 0, "0x08000157 is Base1ClipMap");
    assert_eq!(chain.last(), Some(&RS_PORTAL_SWIRL), "0x08000157 -> 0x0600396B");

    let (ty2, chain2) = surface_chain(&db, SURFACE_SECOND);
    assert_ne!(ty2 & SURFACE_BASE1_CLIPMAP, 0, "0x08000015 is Base1ClipMap");
    assert!(
        chain2.contains(&RS_SECOND),
        "0x08000015 -> 0x060037A3; chain was {chain2:02X?}"
    );
}

#[test]
#[ignore = "needs ~/ac_base_dats/client_portal.dat (walks every 0x06 record)"]
fn full_census_classifies_every_render_surface() {
    let db = portal();
    let mut ids: Vec<u32> = db.files.keys().copied().filter(|id| id >> 24 == 0x06).collect();
    ids.sort_unstable();
    assert!(ids.len() > 10_000, "only {} RenderSurface records — wrong DAT?", ids.len());

    // Which records sit behind a Base1ClipMap surface — the same index the
    // bin builds, in miniature (clipmap bit only).
    let mut clipmap: BTreeMap<u32, bool> = BTreeMap::new();
    for sid in db.files.keys().copied().filter(|id| id >> 24 == 0x08) {
        let Ok(bytes) = db.get_file(sid) else { continue };
        let Ok(s) = Surface::unpack(&bytes) else { continue };
        let Some(refs) = s.texture_refs.as_ref() else { continue };
        let is_clip = (s.surface_type & SURFACE_BASE1_CLIPMAP) != 0;
        let Ok(st_bytes) = db.get_file(refs.orig_texture_id) else { continue };
        let Ok(st) = SurfaceTexture::unpack(&st_bytes) else { continue };
        for &tid in &st.textures {
            *clipmap.entry(tid).or_insert(false) |= is_clip;
        }
    }
    assert!(!clipmap.is_empty(), "no Surface -> Texture chains resolved");

    let mut by_class: BTreeMap<&'static str, usize> = BTreeMap::new();
    let mut capable = 0usize;
    let mut failures = 0usize;
    for &id in &ids {
        let Ok(bytes) = db.get_file(id) else {
            failures += 1;
            continue;
        };
        let Ok(tex) = Texture::unpack(&bytes) else {
            failures += 1;
            continue;
        };
        if format_carries_alpha(tex.format()) {
            capable += 1;
        }
        let is_clip = clipmap.get(&id).copied().unwrap_or(false);
        let facts = classify_texture(&tex, is_clip, 0, palette_closure(&db));
        *by_class.entry(facts.class.as_str()).or_insert(0) += 1;
    }
    eprintln!(
        "census: {} records; by class {by_class:?} \
         (alpha-capable PFID: {capable}, unreadable: {failures})",
        ids.len()
    );

    // All four real classes must be populated by a 20 k-record retail DAT —
    // a classifier that collapses to one bucket is broken, and this is the
    // cheapest way to notice.
    for want in ["opaque", "fully-transparent", "punch-through", "gradient-alpha"] {
        assert!(by_class.get(want).copied().unwrap_or(0) > 0, "class {want} never occurred");
    }
    // The census must not lose records.
    let total: usize = by_class.values().sum();
    assert_eq!(total + failures, ids.len());
    // And the whole point: alpha-bearing records exist in quantity.
    let bearing: usize = ["fully-transparent", "punch-through", "gradient-alpha"]
        .iter()
        .map(|k| by_class.get(k).copied().unwrap_or(0))
        .sum();
    assert!(bearing > 100, "only {bearing} alpha-bearing records — the walk missed something");
}

#[test]
#[ignore = "needs ~/ac_base_dats/client_portal.dat (runs the built binary)"]
fn cli_dat_truth_only_emits_the_row_contract() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let ids = tmp.path().join("ids.txt");
    std::fs::write(&ids, "0x0600396B\n# a comment\n0x060037A3\n").unwrap();
    let out = tmp.path().join("out");

    let status = std::process::Command::new(env!("CARGO_BIN_EXE_alpha-audit"))
        .args(["--dat", PORTAL_DAT])
        .arg("--ids")
        .arg(&ids)
        .arg("--out-dir")
        .arg(&out)
        .arg("--no-dat-sha")
        .status()
        .expect("run alpha-audit");
    assert!(status.success(), "alpha-audit exited {status}");

    let jsonl = std::fs::read_to_string(out.join("verdicts.jsonl")).expect("verdicts.jsonl");
    let rows: Vec<serde_json::Value> =
        jsonl.lines().map(|l| serde_json::from_str(l).expect("row is JSON")).collect();
    assert_eq!(rows.len(), 2, "one row per requested id");
    // Ascending id order — the determinism rule.
    assert_eq!(rows[0]["id"], "0x060037A3");
    assert_eq!(rows[1]["id"], "0x0600396B");
    for r in &rows {
        assert_eq!(r["datAlphaClass"], "fully-transparent");
        assert_eq!(r["refs"]["clipmap"], true, "both cited records are clipmap rows");
        assert!(r["surfaceClass"].as_str().unwrap().contains("clipmap"));
        // DAT-truth-only mode carries no verdict — there is nothing to
        // compare against, and inventing one would be a lie.
        assert!(r.get("verdict").is_none(), "no verdict without a corpus");
        assert!(r.get("corpusAlphaClass").is_none());
    }

    let summary: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(out.join("summary.json")).unwrap()).unwrap();
    assert_eq!(summary["mode"], "dat-truth-only");
    assert_eq!(summary["records"], 2);
    assert_eq!(summary["byAlphaClass"]["fully-transparent"], 2);
    assert_eq!(summary["clipmapByAlphaClass"]["fully-transparent"], 2);
    assert!(out.join("PROVENANCE.md").is_file());

    // Byte-identical re-run: the tool must be deterministic.
    let out2 = tmp.path().join("out2");
    let status = std::process::Command::new(env!("CARGO_BIN_EXE_alpha-audit"))
        .args(["--dat", PORTAL_DAT])
        .arg("--ids")
        .arg(&ids)
        .arg("--out-dir")
        .arg(&out2)
        .arg("--no-dat-sha")
        .status()
        .expect("re-run alpha-audit");
    assert!(status.success());
    assert_eq!(
        std::fs::read(out.join("verdicts.jsonl")).unwrap(),
        std::fs::read(out2.join("verdicts.jsonl")).unwrap(),
        "verdicts.jsonl is not byte-stable across runs"
    );
    assert_eq!(
        std::fs::read(out.join("summary.json")).unwrap(),
        std::fs::read(out2.join("summary.json")).unwrap(),
        "summary.json is not byte-stable across runs"
    );
}

#[test]
#[ignore = "needs ~/ac_base_dats/client_portal.dat (runs the built binary)"]
fn cli_corpus_mode_catches_a_dropped_alpha_channel() {
    // Build a two-member fake corpus lane from REAL DAT truth: one PNG that
    // preserves the record's (fully transparent) alpha, one that drops the
    // channel entirely — the upscaler's actual failure mode.
    let tmp = tempfile::tempdir().expect("tempdir");
    let lane = tmp.path().join("lane");
    std::fs::create_dir_all(&lane).unwrap();

    let db = portal();
    // A REAL punch-through record to stand in for the general case: find
    // the first one the census produces, so this test cannot be satisfied
    // by a hand-built fixture.
    let mut punch: Option<u32> = None;
    let mut ids: Vec<u32> = db.files.keys().copied().filter(|id| id >> 24 == 0x06).collect();
    ids.sort_unstable();
    for &id in &ids {
        let Ok(bytes) = db.get_file(id) else { continue };
        let Ok(tex) = Texture::unpack(&bytes) else { continue };
        if !matches!(tex.format(), SurfacePixelFormat::Dxt1) {
            continue;
        }
        let facts = classify_texture(&tex, false, 0, palette_closure(&db));
        if facts.class == AlphaClass::PunchThrough {
            punch = Some(id);
            break;
        }
    }
    let punch = punch.expect("retail has at least one punch-through DXT1 record");
    eprintln!("corpus-mode test uses real punch-through record 0x{punch:08X}");

    // The defective payload: 4x dims, RGB (no alpha channel at all).
    let write_png = |id: u32, w: u32, h: u32, color: png::ColorType, px: &[u8]| {
        let mut out = Vec::new();
        {
            let mut enc = png::Encoder::new(&mut out, w, h);
            enc.set_color(color);
            enc.set_depth(png::BitDepth::Eight);
            let mut wr = enc.write_header().unwrap();
            wr.write_image_data(px).unwrap();
            wr.finish().unwrap();
        }
        std::fs::write(lane.join(format!("0x{id:08X}.png")), out).unwrap();
    };
    let (pw, ph) = {
        let tex = texture(&db, punch);
        let (w, h) = tex.actual_dimensions();
        (w * 4, h * 4)
    };
    write_png(punch, pw, ph, png::ColorType::Rgb, &vec![0u8; (pw * ph * 3) as usize]);
    // And the portal record, likewise flattened — which must still be SKIP,
    // never REBAKE, because it is fully transparent in the DAT.
    write_png(RS_PORTAL_SWIRL, 32, 32, png::ColorType::Rgb, &vec![0u8; 32 * 32 * 3]);

    // A SECOND lane in the `--tex-bc7` container (`.hbc7`, raw BC7 blocks):
    // an all-mode-1 payload encodes no alpha field at all, so it is
    // provably opaque without decoding a texel — the same REBAKE finding
    // reached through the other reader.
    let lane2 = tmp.path().join("lane-bc7");
    std::fs::create_dir_all(&lane2).unwrap();
    {
        let (w, h) = (32u32, 32u32);
        let mut blob = Vec::new();
        blob.extend_from_slice(b"HBC7");
        blob.extend_from_slice(&w.to_le_bytes());
        blob.extend_from_slice(&h.to_le_bytes());
        blob.extend_from_slice(&w.div_ceil(4).to_le_bytes());
        blob.extend_from_slice(&h.div_ceil(4).to_le_bytes());
        for _ in 0..(w.div_ceil(4) * h.div_ceil(4)) {
            let mut block = [0u8; 16];
            block[0] = 0b0000_0010; // BC7 mode 1 — no alpha field
            blob.extend_from_slice(&block);
        }
        std::fs::write(lane2.join(format!("0x{punch:08X}.hbc7")), blob).unwrap();
    }

    let idfile = tmp.path().join("ids.txt");
    std::fs::write(&idfile, format!("0x{punch:08X}\n0x{RS_PORTAL_SWIRL:08X}\n")).unwrap();
    let out = tmp.path().join("out");
    let status = std::process::Command::new(env!("CARGO_BIN_EXE_alpha-audit"))
        .args(["--dat", PORTAL_DAT])
        .arg("--ids")
        .arg(&idfile)
        .arg("--corpus")
        .arg(&lane)
        .arg("--corpus")
        .arg(&lane2)
        .arg("--out-dir")
        .arg(&out)
        .arg("--no-dat-sha")
        .status()
        .expect("run alpha-audit");
    assert!(status.success());

    let jsonl = std::fs::read_to_string(out.join("verdicts.jsonl")).unwrap();
    let rows: BTreeMap<String, serde_json::Value> = jsonl
        .lines()
        .map(|l| {
            let v: serde_json::Value = serde_json::from_str(l).unwrap();
            (v["id"].as_str().unwrap().to_string(), v)
        })
        .collect();

    let p = &rows[&format!("0x{punch:08X}")];
    assert_eq!(p["datAlphaClass"], "punch-through");
    assert_eq!(p["corpusAlphaClass"], "opaque");
    assert_eq!(p["verdict"], "REBAKE", "a dropped alpha channel must be REBAKE");
    assert!(p["reason"].as_str().unwrap().contains("alpha dropped"));
    assert_eq!(p["corpus"][0]["alpha"]["source"], "png-no-alpha-channel");
    assert!(
        p["corpus"][0]["flags"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f == "alpha-channel-dropped")
    );
    // Lane 2 reaches the same verdict from the BC7 mode histogram alone.
    assert_eq!(p["corpus"][1]["alpha"]["source"], "hbc7-blocks");
    assert_eq!(p["corpus"][1]["corpusAlphaClass"], "opaque");
    assert_eq!(p["corpus"][1]["verdict"], "REBAKE");
    assert_eq!(p["corpus"][1]["alpha"]["hbc7"]["hasAlphaChannel"], false);
    assert_eq!(p["corpus"][1]["alpha"]["hbc7"]["modeHistogram"][1], 64);

    let s = &rows[&format!("0x{RS_PORTAL_SWIRL:08X}")];
    assert_eq!(s["datAlphaClass"], "fully-transparent");
    assert_eq!(
        s["verdict"], "SKIP",
        "the portal record is zero-information: SKIP even with a defective payload present"
    );

    let summary: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(out.join("summary.json")).unwrap()).unwrap();
    assert_eq!(summary["mode"], "corpus");
    assert_eq!(summary["corpusMatched"], 2);
    assert_eq!(summary["byVerdict"]["REBAKE"], 1);
    assert_eq!(summary["byVerdict"]["SKIP"], 1);
    assert_eq!(summary["rebakeIds"][0], format!("0x{punch:08X}"));
}
