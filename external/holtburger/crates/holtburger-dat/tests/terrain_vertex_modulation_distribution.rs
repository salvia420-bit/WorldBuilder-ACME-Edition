//! Sanity scan of TerrainTex vertex-modulation ranges in retail
//! `client_portal.dat`. melt's `Source/misc/RegionComparer.cs:85-117`
//! reads 6 u32 fields per terrain type — `(Max|Min)Vert(Bright|Saturate|Hue)`.
//! Our `crates/holtburger-dat/src/file_type/region.rs:537-567` parses
//! them identically, but the renderer doesn't consume them (see
//! `terrain.js` — only `texture_id`, `tex_tiling`, `detail_*` reach the
//! atlas builder).
//!
//! This test reports the retail distribution: all 33 terrain types
//! have nonzero ranges (max != min) for brightness, saturation, AND
//! hue. So the values look like real signal at first glance.
//!
//! **HOWEVER:** the 2026-05-28 follow-on verification of `acclient.c`
//! found these 6 fields appear **only** inside `TerrainTex::Pack`
//! (`acclient.c:304995-305025`) and `TerrainTex::UnPack`
//! (`acclient.c:305081-305111`). Zero application sites elsewhere
//! in the 31 MB decompile; ACE.Server only copies the values, never
//! reads them. **The fields are dead data in retail** — likely a
//! cut feature. Implementing modulation in our shader would be
//! creative invention, not retail fidelity.
//!
//! This test stays as documentation so a future implementer doesn't
//! re-tread the same path. See
//! `project_terrain_vertex_modulation_gap_2026-05-28.md` in memory
//! for the full verdict.
//!
//! SKIPs cleanly without retail data.

use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::Region;
use std::path::PathBuf;

fn retail_portal_dat_path() -> Option<PathBuf> {
    if let Some(p) = holtburger_dat::utils::get_portal_dat_path() {
        return Some(p);
    }
    let c = PathBuf::from("/home/wbterminal/ac_base_dats/client_portal.dat");
    c.exists().then_some(c)
}

#[test]
fn terrain_vertex_modulation_distribution_against_retail() {
    let Some(dat_path) = retail_portal_dat_path() else {
        eprintln!("SKIP: client_portal.dat not found");
        return;
    };
    let dat = DatDatabase::new(&dat_path).expect("open retail portal.dat");

    // Region records live under prefix 0x13. Retail has one canonical
    // Region (Dereth) but iterate generally.
    let mut region_count = 0u64;
    let mut terrain_type_count = 0u64;
    let mut nonzero_bright_range = 0u64;
    let mut nonzero_sat_range = 0u64;
    let mut nonzero_hue_range = 0u64;
    let mut max_bright_seen: u32 = 0;
    let mut max_sat_seen: u32 = 0;
    let mut max_hue_seen: u32 = 0;
    let mut samples: Vec<(u32, u32, u32, u32, u32, u32, u32)> = Vec::new();

    for &id in dat.files.keys() {
        let prefix = (id >> 24) as u8;
        if prefix != 0x13 {
            continue;
        }
        let bytes = match dat.get_file(id) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let mut cursor = std::io::Cursor::new(&bytes[..]);
        let region = match Region::unpack(&mut cursor) {
            Ok(r) => r,
            Err(_) => continue,
        };
        region_count += 1;
        // Path: region.terrain_info.land_surfaces.tex_merge.terrain_desc[i].terrain_tex
        let terrain_descs = &region.terrain_info.land_surfaces.tex_merge.terrain_desc;
        for td in terrain_descs {
            terrain_type_count += 1;
            let t = &td.terrain_tex;
            let bright_range = t.max_vert_bright.saturating_sub(t.min_vert_bright);
            let sat_range = t.max_vert_saturate.saturating_sub(t.min_vert_saturate);
            let hue_range = t.max_vert_hue.saturating_sub(t.min_vert_hue);
            if bright_range > 0 {
                nonzero_bright_range += 1;
            }
            if sat_range > 0 {
                nonzero_sat_range += 1;
            }
            if hue_range > 0 {
                nonzero_hue_range += 1;
            }
            max_bright_seen = max_bright_seen.max(t.max_vert_bright);
            max_sat_seen = max_sat_seen.max(t.max_vert_saturate);
            max_hue_seen = max_hue_seen.max(t.max_vert_hue);
            // Capture a few samples for visual inspection.
            if samples.len() < 8 {
                samples.push((
                    td.terrain_type,
                    t.min_vert_bright, t.max_vert_bright,
                    t.min_vert_saturate, t.max_vert_saturate,
                    t.min_vert_hue, t.max_vert_hue,
                ));
            }
        }
    }

    eprintln!("\n=== TerrainTex vertex-modulation distribution in retail portal.dat ===");
    eprintln!("  Region (0x13) records      = {region_count}");
    eprintln!("  terrain types per region   = {terrain_type_count}");
    eprintln!("  with nonzero bright range  = {nonzero_bright_range}");
    eprintln!("  with nonzero saturate rng  = {nonzero_sat_range}");
    eprintln!("  with nonzero hue range     = {nonzero_hue_range}");
    eprintln!("  max bright value seen      = {max_bright_seen}");
    eprintln!("  max saturate value seen    = {max_sat_seen}");
    eprintln!("  max hue value seen         = {max_hue_seen}");
    eprintln!("\n  samples (terrain_type, min_b/max_b, min_s/max_s, min_h/max_h):");
    for (tt, minb, maxb, mins, maxs, minh, maxh) in &samples {
        eprintln!(
            "    terrain_type={tt:>4}  bright={minb:>3}..{maxb:<3}  sat={mins:>3}..{maxs:<3}  hue={minh:>5}..{maxh:<5}"
        );
    }

    // We don't assert on the distribution — this is a reporting test.
    // The verdict ("feature is active in retail" / "no-op in retail")
    // goes in the test output for the audit memo.
    assert!(region_count >= 1, "expected at least 1 Region (0x13) record in retail portal.dat");
}
