//! dat-parser-2 (2026-10-13) — `?negFace=retail` census over the retail
//! baseline (`~/ac_base_dats`). `#[ignore]`d: it walks every GfxObj,
//! Environment and EnvCell. Run once with
//!
//! ```text
//! cargo test -p holtburger-dat --test neg_face_census -- --ignored --nocapture
//! ```
//!
//! Retail builds a SidesType-2 polygon's negative side in
//! `D3DPolyRender::ConstructMesh` (`acclient.c:455780`, emit pass) as a second
//! SIDE in its `neg_surface` batch: `neg_uv_indices`, normals x -1, and the
//! SAME winding (the `2 - v63` reversal only runs for the second winding of a
//! `sides_type == 1` poly). `RenderMeshSubset` culls CW, so the copy is
//! front-only; from the front it is coplanar with the pos face under
//! DEPTHTEST_LESS, batches drawn in surface-index order (`DrawMesh`,
//! `acclient.c:455154`) and alpha-delayed batches (`s_AlphaDelayMask` = 14:
//! Alpha|InvAlpha|Additive, ClipMap, Translucent) drawn later. holtburger's
//! default path instead emits a REVERSED back tri (visible from behind).
//!
//! What this sizes, for the `?negFace=retail` rules in
//! `apps/holtburger-web/src/lib.rs` (`parse_neg_face_retail_flag`):
//!
//!  1. SidesType-2 polys with `!(stippling & NoNeg)` and `neg_surface !=
//!     pos_surface` — GfxObj and CellStruct — split by `neg < pos` (the neg
//!     batch draws first) and by whether either surface is alpha-delayed. The
//!     (neg first, both opaque) bucket is where retail shows the NEG texture
//!     from the FRONT. Also the polys the default path emits a reversed back
//!     tri for (distinct resolved DIDs, not NoPos).
//!  2. `NoPos` polys (stippling 0x4 = no POSITIVE UV indices, `acclient.c:359869`
//!     `CPolygon::UnPack`) split by whether the pos surface is textured
//!     (`type & 6`) — the default path skips them all; retail draws the
//!     textured ones with UV slot 0.
//!
//! Example ids per bucket are printed for the 1070 eye test. The only
//! assertions are sanity checks; the numbers are the deliverable.

use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::env_cell::surface_did_for_envcell_index;
use holtburger_dat::file_type::{EnvCell, Environment, GfxObj, Surface};
use holtburger_dat::graphics::Polygon;
use std::collections::HashMap;
use std::io::Cursor;
use std::path::PathBuf;

const NO_POS: u8 = 0x04;
const NO_NEG: u8 = 0x08;
const SIDES_CLOCKWISE: i32 = 2;
/// `Base1Image | Base1ClipMap`.
const TYPE_TEXTURED: u32 = 0x06;
/// `ConstructMesh` mask classes 2/8/4 → `s_AlphaDelayMask` (= 14).
const TYPE_ALPHA_DELAYED: u32 = 0x0001_0300 | 0x4 | 0x10;
const ENVCELL_LOW_MIN: u32 = 0x0100;
const ENVCELL_LOW_MAX: u32 = 0xFFFD;
const MAX_EXAMPLES: usize = 8;

fn base_dat(env_var: &str, names: &[&str]) -> Option<PathBuf> {
    if let Ok(p) = std::env::var(env_var) {
        let p = PathBuf::from(p);
        if p.exists() {
            return Some(p);
        }
    }
    names
        .iter()
        .map(|n| PathBuf::from("/home/wbterminal/ac_base_dats").join(n))
        .find(|p| p.exists())
}

#[derive(Default, Debug)]
struct SidesCensus {
    /// drawing polygons seen.
    polys: u64,
    /// `sides_type == 2`.
    sides2: u64,
    /// ... with NoNeg set (retail still builds side 1, UV slot 0).
    sides2_no_neg: u64,
    /// ... `!NoNeg` and `neg_surface == pos_surface` (same batch).
    sides2_same_index: u64,
    /// ... `!NoNeg` and `neg_surface != pos_surface` — the census population.
    distinct_index: u64,
    /// population entries with a slot out of range / unparsable Surface.
    unresolved: u64,
    /// population entries whose resolved DIDs differ and that are not NoPos:
    /// the default path emits a reversed back tri for each.
    default_reversed_back: u64,
    neg_first_both_opaque: u64,
    neg_first_alpha: u64,
    neg_later_both_opaque: u64,
    neg_later_alpha: u64,
    examples_neg_first_both_opaque: Vec<u32>,
    examples_default_reversed_back: Vec<u32>,
}

#[derive(Default, Debug)]
struct NoPosCensus {
    polys: u64,
    textured: u64,
    solid: u64,
    unresolved: u64,
    examples_textured: Vec<u32>,
}

fn push_example(v: &mut Vec<u32>, id: u32) {
    if v.len() < MAX_EXAMPLES && !v.contains(&id) {
        v.push(id);
    }
}

/// One polygon against resolved surfaces. `resolve(slot) -> Option<did>`;
/// `ty(did) -> Option<type bits>`. `owner` is the record id for examples.
fn tally(
    sides: &mut SidesCensus,
    nopos: &mut NoPosCensus,
    poly: &Polygon,
    owner: u32,
    resolve: &dyn Fn(i16) -> Option<u32>,
    ty: &dyn Fn(u32) -> Option<u32>,
) {
    sides.polys += 1;
    let no_pos = (poly.stippling & NO_POS) != 0;
    if no_pos {
        nopos.polys += 1;
        match resolve(poly.pos_surface).and_then(ty) {
            Some(t) if (t & TYPE_TEXTURED) != 0 => {
                nopos.textured += 1;
                push_example(&mut nopos.examples_textured, owner);
            }
            Some(_) => nopos.solid += 1,
            None => nopos.unresolved += 1,
        }
    }
    if poly.sides_type != SIDES_CLOCKWISE {
        return;
    }
    sides.sides2 += 1;
    if (poly.stippling & NO_NEG) != 0 {
        sides.sides2_no_neg += 1;
        return;
    }
    if poly.neg_surface == poly.pos_surface {
        sides.sides2_same_index += 1;
        return;
    }
    sides.distinct_index += 1;
    let (Some(pos_did), Some(neg_did)) = (resolve(poly.pos_surface), resolve(poly.neg_surface))
    else {
        sides.unresolved += 1;
        return;
    };
    if pos_did != neg_did && !no_pos {
        sides.default_reversed_back += 1;
        push_example(&mut sides.examples_default_reversed_back, owner);
    }
    let (Some(pos_t), Some(neg_t)) = (ty(pos_did), ty(neg_did)) else {
        sides.unresolved += 1;
        return;
    };
    let alpha = ((pos_t | neg_t) & TYPE_ALPHA_DELAYED) != 0;
    match (poly.neg_surface < poly.pos_surface, alpha) {
        (true, false) => {
            sides.neg_first_both_opaque += 1;
            push_example(&mut sides.examples_neg_first_both_opaque, owner);
        }
        (true, true) => sides.neg_first_alpha += 1,
        (false, false) => sides.neg_later_both_opaque += 1,
        (false, true) => sides.neg_later_alpha += 1,
    }
}

fn print_census(label: &str, s: &SidesCensus, n: &NoPosCensus) {
    println!("── {label} ──");
    println!("  drawing polys                         {}", s.polys);
    println!("  sides_type 2                          {}", s.sides2);
    println!("    NoNeg set                           {}", s.sides2_no_neg);
    println!("    same neg/pos index                  {}", s.sides2_same_index);
    println!("    distinct neg/pos index (population) {}", s.distinct_index);
    println!("      unresolved                        {}", s.unresolved);
    println!("      default emits reversed back tri   {}", s.default_reversed_back);
    println!("      neg first, both opaque  (NEG wins front view) {}", s.neg_first_both_opaque);
    println!("      neg first, alpha-delayed          {}", s.neg_first_alpha);
    println!("      neg later, both opaque            {}", s.neg_later_both_opaque);
    println!("      neg later, alpha-delayed          {}", s.neg_later_alpha);
    println!("  NoPos polys                           {}", n.polys);
    println!("    pos surface textured (retail draws) {}", n.textured);
    println!("    pos surface solid                   {}", n.solid);
    println!("    unresolved                          {}", n.unresolved);
    println!("  examples neg-first/opaque: {:08X?}", s.examples_neg_first_both_opaque);
    println!("  examples default reversed back: {:08X?}", s.examples_default_reversed_back);
    println!("  examples textured NoPos: {:08X?}", n.examples_textured);
}

#[test]
#[ignore = "retail census over ~/ac_base_dats; run with --ignored --nocapture"]
fn neg_face_retail_census() {
    let Some(portal_path) = base_dat("HOLTBURGER_PORTAL_DAT", &["client_portal.dat"]) else {
        eprintln!("SKIP neg_face_census: no client_portal.dat (set HOLTBURGER_PORTAL_DAT)");
        return;
    };
    let portal = DatDatabase::new(&portal_path).expect("open client_portal.dat");
    let mut ids: Vec<u32> = portal.files.keys().copied().collect();
    ids.sort_unstable();

    // Surface type bits by DID.
    let mut types: HashMap<u32, u32> = HashMap::new();
    for &id in ids.iter().filter(|&&id| (id >> 24) == 0x08) {
        if let Ok(bytes) = portal.get_file(id)
            && let Ok(s) = Surface::unpack(&bytes)
        {
            types.insert(id, s.surface_type);
        }
    }
    let ty = |did: u32| types.get(&did).copied();

    // ── GfxObj (0x01) ─────────────────────────────────────────────────
    let (mut gfx_sides, mut gfx_nopos) = (SidesCensus::default(), NoPosCensus::default());
    let mut gfx_parsed = 0u64;
    let mut gfx_failed = 0u64;
    for &id in ids.iter().filter(|&&id| (id >> 24) == 0x01) {
        let Ok(bytes) = portal.get_file(id) else { continue };
        let Ok(gfx) = GfxObj::unpack(&mut Cursor::new(&bytes)) else {
            gfx_failed += 1;
            continue;
        };
        gfx_parsed += 1;
        let resolve = |slot: i16| -> Option<u32> {
            (slot >= 0).then(|| gfx.surfaces.get(slot as usize).copied()).flatten()
        };
        for poly in gfx.polygons.values() {
            tally(&mut gfx_sides, &mut gfx_nopos, poly, id, &resolve, &ty);
        }
    }

    // ── Environment (0x0D) cellstructs, index level ───────────────────
    // Drawing polys only (no vertices / BSPs), keyed (env DID, cellstruct id).
    let mut env_polys: HashMap<(u32, u32), Vec<Polygon>> = HashMap::new();
    let (mut cs_sides, mut cs_nopos) = (SidesCensus::default(), NoPosCensus::default());
    let no_slot = |_: i16| -> Option<u32> { None };
    let no_type = |_: u32| -> Option<u32> { None };
    for &id in ids.iter().filter(|&&id| (id >> 24) == 0x0D) {
        let Ok(bytes) = portal.get_file(id) else { continue };
        let Ok(env) = Environment::unpack(&mut Cursor::new(&bytes)) else { continue };
        for (cs_id, cell) in env.cells {
            for poly in cell.polygons.values() {
                // Slots resolve per EnvCell; here only the index split counts.
                tally(&mut cs_sides, &mut cs_nopos, poly, id, &no_slot, &no_type);
            }
            env_polys.insert((id, cs_id), cell.polygons.into_values().collect());
        }
    }

    println!("── neg_face census over {} ──", portal_path.display());
    println!("  Surfaces typed {} · GfxObjs parsed {} (failed {})", types.len(), gfx_parsed, gfx_failed);
    print_census("GfxObj drawing polys", &gfx_sides, &gfx_nopos);
    print_census("CellStruct drawing polys (index level, slots unresolved)", &cs_sides, &cs_nopos);

    // ── EnvCell instances (cell dat): slots → DIDs → types ─────────────
    if let Some(cell_path) =
        base_dat("HOLTBURGER_CELL_DAT", &["client_cell_1.dat", "client_cell.dat"])
    {
        let cell_dat = DatDatabase::new(&cell_path).expect("open client_cell dat");
        let mut cell_ids: Vec<u32> = cell_dat
            .files
            .keys()
            .copied()
            .filter(|id| (ENVCELL_LOW_MIN..=ENVCELL_LOW_MAX).contains(&(id & 0xFFFF)))
            .collect();
        cell_ids.sort_unstable();
        let (mut ec_sides, mut ec_nopos) = (SidesCensus::default(), NoPosCensus::default());
        let mut cells = 0u64;
        for cid in cell_ids {
            let Ok(bytes) = cell_dat.get_file(cid) else { continue };
            let Ok(envcell) = EnvCell::unpack(&mut Cursor::new(&bytes)) else { continue };
            let env_did = 0x0D00_0000 | envcell.environment_id as u32;
            let Some(polys) = env_polys.get(&(env_did, envcell.cell_structure as u32)) else {
                continue;
            };
            cells += 1;
            let resolve = |slot: i16| -> Option<u32> {
                (slot >= 0)
                    .then(|| envcell.surfaces.get(slot as usize).copied())
                    .flatten()
                    .map(surface_did_for_envcell_index)
            };
            for poly in polys {
                tally(&mut ec_sides, &mut ec_nopos, poly, cid, &resolve, &ty);
            }
        }
        println!("  EnvCells resolved {cells} over {}", cell_path.display());
        print_census("EnvCell instances (resolved)", &ec_sides, &ec_nopos);
    } else {
        eprintln!("  (no client_cell dat — EnvCell instance pass skipped)");
    }

    assert!(gfx_parsed > 0, "no GfxObjs parsed — wrong dat?");
    assert!(!types.is_empty(), "no Surfaces parsed — wrong dat?");
}
