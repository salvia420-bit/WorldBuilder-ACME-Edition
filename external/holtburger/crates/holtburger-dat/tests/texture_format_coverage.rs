//! Retail-DAT format-coverage sweep for `Texture` (DAT type 0x06/0x07,
//! "RenderSurface"). Cross-reference task between melt's `Texture.cs` /
//! `DxtUtil.cs` and our own `file_type::texture` + `file_type::dxt`.
//!
//! The goal is **not** byte-for-byte decode parity against melt (both
//! ports descend from upstream ACE.DatLoader / MonoGame Ms-PL code, so
//! the DXT path is bit-identical and the BGRA path is structurally
//! identical). The goal is to enumerate which `SurfacePixelFormat`
//! values **retail actually uses**, so any gap in our `to_rgba8`
//! dispatch surfaces as a real failure instead of a theoretical one.
//!
//! For each Texture (0x06 + 0x07) record in `client_portal.dat`:
//!   1. Parse via `Texture::unpack` (asserts the binread schema works).
//!   2. Tally the raw `format_raw` u32 against the enum.
//!   3. For non-palette formats, decode via `to_rgba8` and assert it
//!      returns a buffer of the expected size (no error, no panic).
//!   4. For palette formats (P8, Index16), assert `default_palette_id`
//!      is `Some(..)` — actual decode needs a `ResourceProvider` we
//!      don't wire in this test (Palette is type 0x04 and lives in the
//!      same DAT, but the existing test pattern keeps palette fetches
//!      isolated to ResourceProvider-backed tests).
//!
//! If retail uses a format we don't dispatch (e.g. `CUSTOM_RAW_JPEG` at
//! 500, which melt's `GetBitmap` handles via `Image.FromStream`), the
//! test fails with a clear message — that's exactly the kind of
//! divergence Task #5 was scoped to find.
//!
//! SKIPs cleanly if `client_portal.dat` isn't reachable.

use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::Texture;
use holtburger_dat::file_type::texture::SurfacePixelFormat;
use std::collections::BTreeMap;
use std::path::PathBuf;

fn retail_portal_dat_path() -> Option<PathBuf> {
    if let Some(p) = holtburger_dat::utils::get_portal_dat_path() {
        return Some(p);
    }
    let c = PathBuf::from("/home/wbterminal/ac_base_dats/client_portal.dat");
    c.exists().then_some(c)
}

#[test]
fn texture_format_coverage_against_retail_portal_dat() {
    let Some(dat_path) = retail_portal_dat_path() else {
        eprintln!(
            "SKIP texture_format_coverage_against_retail_portal_dat: \
             client_portal.dat not found"
        );
        return;
    };
    let dat = DatDatabase::new(&dat_path).expect("open retail portal.dat");

    let mut format_counts: BTreeMap<u32, u64> = BTreeMap::new();
    let mut unsupported_format_ids: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
    let mut parse_failures: Vec<(u32, String)> = Vec::new();
    let mut decode_failures: Vec<(u32, String)> = Vec::new();
    let mut palette_missing: Vec<u32> = Vec::new();
    let mut decoded_ok: u64 = 0;
    let mut palette_ok: u64 = 0;

    for &id in dat.files.keys() {
        let prefix = (id >> 24) as u8;
        if prefix != 0x06 && prefix != 0x07 {
            continue;
        }
        let bytes = match dat.get_file(id) {
            Ok(b) => b,
            Err(e) => {
                parse_failures.push((id, format!("get_file: {e}")));
                continue;
            }
        };
        let tex = match Texture::unpack(&bytes) {
            Ok(t) => t,
            Err(e) => {
                parse_failures.push((id, format!("unpack: {e:?}")));
                continue;
            }
        };
        let fmt_raw = tex.format_raw;
        *format_counts.entry(fmt_raw).or_default() += 1;

        // The palette-path tests are gated on a non-zero `default_palette_id`
        // — we don't fetch the palette here.
        let needs_palette = tex.format().needs_palette();
        if needs_palette {
            if tex.default_palette_id.is_none() {
                palette_missing.push(id);
            } else {
                palette_ok += 1;
            }
            continue;
        }

        // Decode every non-palette format. Provide a closure that yells
        // if it's somehow called (sanity — we already gated above).
        let result = tex.to_rgba8(|_| {
            unreachable!("non-palette texture asked for a palette")
        });
        match result {
            Ok(buf) => {
                // CustomRawJpeg records carry header (0, 0) and the
                // actual dimensions live inside the JPEG payload. Pull
                // them via the helper for size validation.
                let (expected_w, expected_h) = if tex.format() == SurfacePixelFormat::CustomRawJpeg {
                    tex.jpeg_dimensions().unwrap_or((0, 0))
                } else {
                    (tex.width as u32, tex.height as u32)
                };
                let expected_len = (expected_w as usize)
                    .saturating_mul(expected_h as usize)
                    .saturating_mul(4);
                if buf.len() != expected_len {
                    decode_failures.push((
                        id,
                        format!(
                            "buffer len {} != expected w*h*4 = {} (w={}, h={})",
                            buf.len(), expected_len, expected_w, expected_h
                        ),
                    ));
                } else {
                    decoded_ok += 1;
                }
            }
            Err(e) => {
                decode_failures.push((id, format!("to_rgba8: {e}")));
                unsupported_format_ids
                    .entry(fmt_raw)
                    .or_default()
                    .push(id);
            }
        }
    }

    // ----- report -----
    eprintln!("\n=== Texture (0x06/0x07) format distribution in retail portal.dat ===");
    let mut total = 0u64;
    for (raw, count) in &format_counts {
        let fmt = SurfacePixelFormat::from_u32(*raw);
        let name = match fmt {
            SurfacePixelFormat::Other(v) => format!("Other(0x{v:08X} = {v})"),
            f => format!("{f:?}"),
        };
        eprintln!("  {:30} = {:>6} records  (format_raw = {})", name, count, raw);
        total += *count;
    }
    eprintln!("  {:30} = {:>6}", "TOTAL", total);
    eprintln!("\n  decoded_ok        = {decoded_ok}");
    eprintln!("  palette_ok        = {palette_ok}");
    eprintln!("  parse_failures    = {}", parse_failures.len());
    eprintln!("  decode_failures   = {}", decode_failures.len());
    eprintln!("  palette_missing   = {}", palette_missing.len());

    // ----- assertions -----
    if !parse_failures.is_empty() {
        for (id, msg) in parse_failures.iter().take(10) {
            eprintln!("  PARSE FAIL 0x{id:08X}: {msg}");
        }
        panic!("{} retail Texture records failed to parse", parse_failures.len());
    }

    // Any format encountered must be in our curated enum — `Other(_)`
    // means retail uses a value we haven't characterized. (`Unknown = 0`
    // is in the enum but should never appear in a real texture record;
    // melt's `Texture.cs:225` even logs a warning for unmapped formats.)
    for (raw, _) in &format_counts {
        let fmt = SurfacePixelFormat::from_u32(*raw);
        if matches!(fmt, SurfacePixelFormat::Other(_)) {
            panic!(
                "retail uses format value {raw} (0x{raw:08X}) that's not in our \
                 SurfacePixelFormat enum — add it. melt's enum at \
                 external/melt/Source/Ace.Entity/Enum/SurfacePixelFormat.cs \
                 has the canonical name."
            );
        }
    }

    // For palette formats we accept missing palette id only if the
    // record is also empty (length=0 → degenerate "no pixels" entry,
    // which melt's `ExportTexture` early-returns on too). Reporting any
    // non-empty palette texture without a palette id is a real bug.
    if !palette_missing.is_empty() {
        for id in palette_missing.iter().take(10) {
            eprintln!("  PALETTE MISSING 0x{id:08X}");
        }
        panic!(
            "{} palette-format retail textures missing default_palette_id",
            palette_missing.len()
        );
    }

    // Decode failures map to genuine unsupported-format cases. Print
    // them grouped by format so the gap (if any) is obvious.
    if !decode_failures.is_empty() {
        eprintln!("\n  Decode failures grouped by format:");
        for (raw, ids) in &unsupported_format_ids {
            let fmt = SurfacePixelFormat::from_u32(*raw);
            eprintln!(
                "    {fmt:?} (raw={raw}): {} records, sample ids = {:?}",
                ids.len(),
                ids.iter().take(3).collect::<Vec<_>>()
            );
        }
        for (id, msg) in decode_failures.iter().take(5) {
            eprintln!("    sample decode fail 0x{id:08X}: {msg}");
        }
        panic!(
            "{} retail Texture records failed to decode via to_rgba8 — \
             unhandled SurfacePixelFormat(s) listed above. Add dispatch \
             arms in crates/holtburger-dat/src/file_type/texture.rs::to_rgba8.",
            decode_failures.len()
        );
    }

    // Final sanity — at least *some* textures should have been seen.
    // (If `client_portal.dat` is truncated or corrupted, the counts
    // would be 0 and this catches the bad-state path.)
    assert!(
        decoded_ok + palette_ok > 1000,
        "implausibly low retail Texture count ({decoded_ok} decoded + \
         {palette_ok} palette-skipped) — DAT file may be truncated"
    );
}
