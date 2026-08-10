//! PAGE-RESAMPLE parity + kernel tests (T22 D2 discharge).
//!
//! The load-bearing test here is `predicate_matches_pool_class_key_js`: the
//! resample is only sound if the bake resamples to EXACTLY the dims the pool
//! class key will demand, and those two pieces of arithmetic live in
//! different languages in different files owned by different tasks
//! (`scene3d/pool_class_key.js` is T22's; `src/page_resample.rs` is this
//! task's). So the test runs the REAL JS module under `node` over an
//! exhaustive dimension grid and diffs it against the Rust functions,
//! including the shared constants. Either side drifting turns this red.
//!
//! Run:
//!   env PATH=... capped-build cargo test -p holtburger-tools --release \
//!       --test page_resample -- --nocapture

use std::process::Command;

use holtburger_tools::page_resample::{
    PAGE_TIER_MAX, PAGE_TIER_MIN, PageAction, dims_byte_of, needs_resample, needs_resample_dims,
    page_dims_of, page_tier_of, plan_page, resample_planar,
};

/// Every dimension the grid probes. Deliberately dense around the tier
/// boundaries (255/256/257 …) and past the clamp (4096, 8192), plus the
/// real corpus dims measured on `/mnt/wbterminal2/xu7-ingest` (2026-08-10):
/// 32, 64, 128, 256, 512, 1024, 2048, 4096, 1096, 1920, 2560.
fn probe_dims() -> Vec<u32> {
    let mut v = vec![
        0, 1, 2, 3, 5, 6, 31, 32, 33, 63, 64, 65, 100, 127, 128, 129, 255, 256, 257, 300, 511,
        512, 513, 1000, 1023, 1024, 1025, 1096, 1920, 2047, 2048, 2049, 2560, 4095, 4096, 4097,
        8192, 65535,
    ];
    v.sort_unstable();
    v.dedup();
    v
}

fn repo_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

#[test]
fn predicate_matches_pool_class_key_js() {
    let app = repo_root().join("apps/holtburger-web");
    let module = app.join("scene3d/pool_class_key.js");
    assert!(module.is_file(), "missing {module:?} — T22's class key moved");

    let dims = probe_dims();
    // The JS side reads a RECORD; feed it exactly what `axisRecordOf`
    // produces — including both `hasTex` states, since that (not the dims)
    // is what decides the untextured class.
    let script = format!(
        r#"
import {{ pageTierOf, pageEdgeOf, pageDimsOf, needsResample, PAGE_TIER_MIN, PAGE_TIER_MAX }}
  from {module:?};
const dims = {dims:?};
const out = {{ min: PAGE_TIER_MIN, max: PAGE_TIER_MAX, rows: [] }};
for (const hasTex of [true, false]) for (const w of dims) for (const h of dims) {{
  const rec = {{ hasTex, texW: w, texH: h }};
  const p = pageDimsOf(rec);
  out.rows.push([w, h, hasTex ? 1 : 0,
                 pageTierOf(Math.max(w, h)), pageEdgeOf(pageTierOf(Math.max(w, h))),
                 p === null ? -1 : p.width, p === null ? -1 : p.height,
                 needsResample(rec) ? 1 : 0]);
}}
process.stdout.write(JSON.stringify(out));
"#,
        module = module.to_str().unwrap(),
        dims = dims,
    );
    let tmp = std::env::temp_dir().join("hb-page-resample-parity.mjs");
    std::fs::write(&tmp, script).unwrap();

    let out = Command::new("node")
        .arg(&tmp)
        .current_dir(&app)
        .output()
        .expect("node must be available — it is the harness runtime for this repo");
    assert!(
        out.status.success(),
        "node failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    let _ = std::fs::remove_file(&tmp);

    assert_eq!(v["min"].as_u64().unwrap() as u32, PAGE_TIER_MIN, "PAGE_TIER_MIN drift");
    assert_eq!(v["max"].as_u64().unwrap() as u32, PAGE_TIER_MAX, "PAGE_TIER_MAX drift");

    let rows = v["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 2 * dims.len() * dims.len(), "grid size mismatch");
    let mut resampled = 0usize;
    for row in rows {
        let r: Vec<i64> = row.as_array().unwrap().iter().map(|x| x.as_i64().unwrap()).collect();
        let (w, h, has_tex) = (r[0] as u32, r[1] as u32, r[2] == 1);
        let ctx = format!("{w}x{h} hasTex={has_tex}");
        assert_eq!(page_tier_of(w.max(h)), r[3] as u32, "pageTierOf {ctx}");
        assert_eq!(
            holtburger_tools::page_resample::page_edge_of(page_tier_of(w.max(h))),
            r[4] as u32,
            "pageEdgeOf {ctx}"
        );
        match page_dims_of(has_tex, w, h) {
            None => {
                assert_eq!((r[5], r[6]), (-1, -1), "pageDimsOf null disagreement {ctx}");
            }
            Some((pw, ph)) => {
                assert_eq!((pw as i64, ph as i64), (r[5], r[6]), "pageDimsOf {ctx}");
            }
        }
        assert_eq!(needs_resample(has_tex, w, h), r[7] == 1, "needsResample {ctx}");
        // The bake-side convenience must agree with the JS whenever the JS
        // record is the one `axisRecordOf` would actually build.
        if has_tex == (w > 0 || h > 0) {
            assert_eq!(needs_resample_dims(w, h), r[7] == 1, "needs_resample_dims {ctx}");
        }
        if r[7] == 1 {
            resampled += 1;
        }
    }
    println!(
        "PARITY: {} (hasTex, w, h) records agree with scene3d/pool_class_key.js \
         ({resampled} need resample)",
        rows.len()
    );
    assert!(resampled > 0, "grid must exercise the resampled branch");
}

/// Corpus-shaped end-to-end: the exact dimension histogram measured over
/// `/mnt/wbterminal2/xu7-ingest` (3,985 KTX2, 2026-08-10). Every one of them
/// must land on a legal page, and the identity subset must be exactly the
/// square pow2 dims in [256, 2048].
#[test]
fn real_corpus_histogram_lands_on_legal_pages() {
    let hist: &[((u32, u32), usize)] = &[
        ((512, 512), 1177),
        ((1024, 1024), 780),
        ((256, 256), 472),
        ((512, 1024), 303),
        ((2048, 2048), 247),
        ((256, 512), 156),
        ((128, 128), 156),
        ((512, 256), 142),
        ((1024, 2048), 130),
        ((1024, 512), 110),
        ((128, 256), 86),
        ((256, 128), 42),
        ((2048, 1024), 34),
        ((128, 512), 24),
        ((256, 1024), 18),
        ((64, 64), 16),
        ((512, 128), 14),
        ((64, 256), 9),
        ((64, 128), 8),
        ((256, 64), 8),
        ((4096, 4096), 8),
        ((128, 64), 7),
        ((1024, 256), 7),
        ((256, 2048), 5),
        ((32, 64), 4),
        ((512, 2048), 4),
        ((32, 32), 3),
        ((64, 512), 2),
        ((2048, 512), 2),
        ((2048, 256), 2),
        ((1024, 128), 1),
        ((64, 32), 1),
        ((32, 512), 1),
        ((128, 4096), 1),
        ((128, 1024), 1),
        ((2560, 1920), 1),
        ((128, 2048), 1),
        ((1024, 4096), 1),
        ((1096, 1096), 1),
    ];
    let (mut total, mut identity, mut up, mut down) = (0usize, 0usize, 0usize, 0usize);
    for &((w, h), n) in hist {
        let p = plan_page(w, h).expect("corpus member is textured");
        assert_eq!(p.page_w, p.page_h, "pages are square: {w}x{h}");
        assert!(
            (256..=2048).contains(&p.page_w) && p.page_w.is_power_of_two(),
            "{w}x{h} → illegal page {}x{}",
            p.page_w,
            p.page_h
        );
        assert_eq!(!needs_resample_dims(w, h), p.action == PageAction::Identity);
        total += n;
        match p.action {
            PageAction::Identity => identity += n,
            PageAction::Upscale => up += n,
            PageAction::Downscale => down += n,
        }
    }
    assert_eq!(total, 3985, "histogram must cover the whole corpus");
    // 512²/1024²/256²/2048² are the only identity dims present.
    assert_eq!(identity, 1177 + 780 + 472 + 247);
    assert_eq!(identity + up + down, total);
    assert_eq!(down, 8 + 1 + 1 + 1, "4096², 128×4096, 1024×4096, 2560×1920");
    println!(
        "CORPUS PLAN: {total} members — {identity} identity / {up} upscale / {down} downscale \
         (needsResample would read {} today, 0 after the resample)",
        up + down
    );
}

/// The dims byte the bake writes for a page must round-trip to the page.
#[test]
fn page_dims_byte_round_trips() {
    for e in [256u32, 512, 1024, 2048] {
        let b = dims_byte_of(e, e);
        let (lw, lh) = ((b >> 4) as u32, (b & 0x0F) as u32);
        assert_eq!(1u32 << lw, e);
        assert_eq!(1u32 << lh, e);
        assert!((PAGE_TIER_MIN..=PAGE_TIER_MAX).contains(&lw));
    }
}

/// A 2048² page built by replication from 512² reduces (box, ×4) back to the
/// byte-exact 512² source — the "the page costs VRAM, never sharpness"
/// claim, at real corpus scale rather than on an 8×8 toy.
#[test]
fn corpus_scale_replication_round_trip() {
    let (w, h) = (512u32, 512u32);
    let src: Vec<u8> = (0..(w * h * 4)).map(|v| ((v * 7 + 13) % 251) as u8).collect();
    let page = resample_planar(&src, w, h, 2048, 2048, 4);
    assert_eq!(page.len(), 2048 * 2048 * 4);
    let back = resample_planar(&page, 2048, 2048, w, h, 4);
    assert_eq!(back, src, "replicate→box-reduce must be lossless");
}

// ---------------------------------------------------------------------------
// The `page-resample` CLI, end to end over a fixture corpus.
// ---------------------------------------------------------------------------

fn write_png(path: &std::path::Path, w: u32, h: u32, color: png::ColorType, px: &[u8]) {
    let f = std::fs::File::create(path).unwrap();
    let mut enc = png::Encoder::new(std::io::BufWriter::new(f), w, h);
    enc.set_color(color);
    enc.set_depth(png::BitDepth::Eight);
    let mut wtr = enc.write_header().unwrap();
    wtr.write_image_data(px).unwrap();
    wtr.finish().unwrap();
}

fn png_dims(path: &std::path::Path) -> (u32, u32) {
    let bytes = std::fs::read(path).unwrap();
    let w = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let h = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    (w, h)
}

/// The tool must (a) emit every member at PAGE dims, (b) leave identity
/// members byte-identical to the source, (c) never touch `--src`, and
/// (d) produce the provenance trio the corpus conventions require.
#[test]
fn cli_derives_a_page_dim_tier_with_provenance() {
    let root = std::env::temp_dir().join(format!("hb-page-resample-cli-{}", std::process::id()));
    let src = root.join("src");
    let out = root.join("out");
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&src).unwrap();

    // 512² RGBA identity · 64² RGB upscale · 4096² grayscale downscale
    // (the tier clamp) · a 300×6 oddity (the dims_byte test's shape).
    let cases: &[(u32, (u32, u32), png::ColorType, usize)] = &[
        (0x0600_0001, (512, 512), png::ColorType::Rgba, 4),
        (0x0600_0002, (64, 64), png::ColorType::Rgb, 3),
        (0x0600_0003, (4096, 4096), png::ColorType::Grayscale, 1),
        (0x0600_0004, (300, 6), png::ColorType::Rgba, 4),
    ];
    for &(id, (w, h), color, ch) in cases {
        let px: Vec<u8> =
            (0..(w as usize * h as usize * ch)).map(|v| ((v * 31 + id as usize) % 251) as u8).collect();
        write_png(&src.join(format!("0x{id:08X}.png")), w, h, color, &px);
    }
    let src_before: Vec<(String, u64)> = std::fs::read_dir(&src)
        .unwrap()
        .map(|e| {
            let e = e.unwrap();
            (e.file_name().to_string_lossy().into_owned(), e.metadata().unwrap().len())
        })
        .collect();

    let status = Command::new(env!("CARGO_BIN_EXE_page-resample"))
        .args(["--src", src.to_str().unwrap(), "--out", out.to_str().unwrap()])
        .arg("--verify-deterministic")
        .status()
        .expect("run page-resample");
    assert!(status.success(), "page-resample exited non-zero");

    // (a) every emitted member sits on its page.
    for &(id, (w, h), _, _) in cases {
        let p = out.join(format!("0x{id:08X}.png"));
        assert!(p.exists(), "0x{id:08X} missing from the derived tier");
        let got = png_dims(&p);
        let want = page_dims_of(true, w, h).unwrap();
        assert_eq!(got, want, "0x{id:08X}: {w}x{h} → {got:?}, want {want:?}");
        assert!(!needs_resample_dims(got.0, got.1), "0x{id:08X} still off-page");
    }

    // (b) the identity member is the SOURCE, byte for byte.
    let ident_src = std::fs::read(src.join("0x06000001.png")).unwrap();
    let ident_out = std::fs::read(out.join("0x06000001.png")).unwrap();
    assert_eq!(ident_src, ident_out, "identity member must be byte-identical");

    // (c) --src untouched.
    let mut src_after: Vec<(String, u64)> = std::fs::read_dir(&src)
        .unwrap()
        .map(|e| {
            let e = e.unwrap();
            (e.file_name().to_string_lossy().into_owned(), e.metadata().unwrap().len())
        })
        .collect();
    let mut before = src_before;
    before.sort();
    src_after.sort();
    assert_eq!(before, src_after, "the source corpus must never be mutated");

    // (d) provenance trio + the gate the plan carries.
    for name in ["page-resample-plan.json", "page-resample.sha256", "bake-source.sha256",
                 "PROVENANCE.md"] {
        assert!(out.join(name).exists(), "missing provenance artifact {name}");
    }
    let plan: serde_json::Value =
        serde_json::from_slice(&std::fs::read(out.join("page-resample-plan.json")).unwrap())
            .unwrap();
    assert_eq!(plan["members"], 4);
    assert_eq!(plan["identity"], 1);
    assert_eq!(plan["needs_resample_before"], 3);
    assert_eq!(plan["needs_resample_after"], 0);

    // --src == --out is refused outright (in-place mutation is the one thing
    // the corpus conventions forbid).
    let refused = Command::new(env!("CARGO_BIN_EXE_page-resample"))
        .args(["--src", src.to_str().unwrap(), "--out", src.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(!refused.status.success(), "--src == --out must be refused");

    let _ = std::fs::remove_dir_all(&root);
}

/// GROUND TRUTH, and the reason the bake must read the KTX2 header rather
/// than the DAT record: the shipped full tier is the UPSCALE corpus, whose
/// members are 4x the retail texture in each axis. A TEXREF row derived from
/// the DAT record therefore describes a texture the client never receives —
/// two page tiers below the one its class actually allocates.
#[test]
#[ignore = "needs ~/ac_base_dats + /mnt/wbterminal2/xu7-ingest"]
fn full_tier_is_four_x_the_dat_record_dims() {
    use holtburger_dat::DatDatabase;
    use holtburger_dat::file_type::Texture;
    let portal = "/home/wbterminal/ac_base_dats/client_portal.dat";
    let ingest = std::path::Path::new("/mnt/wbterminal2/xu7-ingest");
    assert!(std::path::Path::new(portal).is_file(), "missing {portal}");
    assert!(ingest.is_dir(), "missing {ingest:?}");
    let db = DatDatabase::new(portal).expect("open portal dat");

    let mut checked = 0usize;
    let mut tier_shift = 0usize;
    let mut same = Vec::new();
    let mut disagreements = Vec::new();
    let mut unparsed = Vec::new();
    let mut entries: Vec<_> = std::fs::read_dir(ingest)
        .unwrap()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("ktx2"))
        .collect();
    entries.sort();
    entries.truncate(400); // deterministic slice — the whole corpus is 3,985
    for path in entries {
        let stem = path.file_stem().unwrap().to_str().unwrap();
        let id = u32::from_str_radix(stem.trim_start_matches("0x"), 16).unwrap();
        let head = std::fs::read(&path).unwrap();
        let (kw, kh) = (
            u32::from_le_bytes(head[20..24].try_into().unwrap()),
            u32::from_le_bytes(head[24..28].try_into().unwrap()),
        );
        let Ok(bytes) = db.get_file(id) else { continue };
        match Texture::unpack(&bytes) {
            Ok(t) => {
                checked += 1;
                let (dw, dh) = (t.width.max(0) as u32, t.height.max(0) as u32);
                if (dw, dh) == (kw, kh) {
                    same.push(format!("0x{id:08X}: {dw}x{dh}"));
                } else if (dw * 4, dh * 4) != (kw, kh) {
                    disagreements.push(format!(
                        "0x{id:08X}: dat {dw}x{dh}, ktx2 {kw}x{kh} — neither equal nor 4x"
                    ));
                }
                // Whatever the ratio, the PAGE the class allocates is the one
                // the FULL TIER implies; keying on the DAT record would put
                // this member in the wrong class.
                if plan_page(dw, dh).map(|p| p.page_w) != plan_page(kw, kh).map(|p| p.page_w) {
                    tier_shift += 1;
                }
            }
            Err(e) => unparsed.push(format!("0x{id:08X}: {e}")),
        }
    }
    println!(
        "DAT-vs-FULL-TIER over {checked} records: {} exactly 4x / {} equal / {} other; \
         page tier would SHIFT for {tier_shift} if keyed on the DAT record",
        checked - same.len() - disagreements.len(),
        same.len(),
        disagreements.len()
    );
    for u in unparsed.iter().take(5) {
        println!("  unparsed {u}");
    }
    for d in disagreements.iter().take(5) {
        println!("  {d}");
    }
    assert!(checked > 0, "no DAT texture record parsed at all");
    assert!(unparsed.is_empty(), "DAT texture records must parse: {unparsed:?}");
    assert!(
        disagreements.is_empty(),
        "the shipped corpus is a uniform 4x upscale; anything else needs a look"
    );
    assert!(
        tier_shift > 0,
        "if no tier shifted, the bake reading the DAT record would be harmless — \
         it is not, and this test is the evidence"
    );
}
