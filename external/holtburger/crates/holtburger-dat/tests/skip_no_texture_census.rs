//! cells-portals-6 (2026-10-13) — retail `skipNoTexture` census over the
//! retail baseline (`~/ac_base_dats`). `#[ignore]`d: it walks every
//! LandBlockInfo building, every Environment and every EnvCell. Run once with
//!
//! ```text
//! cargo test -p holtburger-dat --test skip_no_texture_census -- --ignored --nocapture
//! ```
//!
//! Retail rule: `D3DPolyRender::DrawMesh` (`acclient.c:455154`) skips every
//! mesh subset (= one surface slot, pos AND neg sides) whose surface is
//! untextured (`!(type & 6)`) while `skipNoTexture` (`acclient.c:45777`, = 1)
//! and either `RenderDeviceD3D::ObjBuildingOrBuildingPart` (set by
//! `RenderDeviceD3D::DrawBuilding` around `CPhysicsPart::Draw(parts[0], 0)`,
//! `acclient.c:456949` — part 0 ONLY) or `isEnvCell` (`DrawEnvCell` passes 1)
//! is set. Ordinary objects keep their untextured surfaces.
//!
//! holtburger has no surface-type test on either path: it skips every `NoPos`
//! poly (stippling 0x4, which is where the doorway portal faces sit — retail
//! drops those too, as untextured) and draws everything else, solid surfaces
//! as 1×1 colour textures. This sizes the residue:
//!
//!  (a) `!NoPos` polys whose pos surface is untextured — holtburger draws,
//!      retail skips. Split by whether the surface is fully translucent
//!      (Translucent 0x10 and translucency >= 1), which `?skipDeadAlpha` may
//!      already hide.
//!  (a') back tris holtburger's default path emits (sides_type 2, `!NoNeg`,
//!      neg DID != pos DID) on an untextured neg surface — retail skips the
//!      neg side with its subset too.
//!
//! The textured-`NoPos` bucket (holtburger skips, retail draws) is
//! `tests/neg_face_census.rs` bucket 2 — not repeated here.
//!
//! Contexts: EnvCell instances (cell dat, slots resolved per EnvCell), and
//! building part-0 GfxObjs from `LandblockInfo.buildings` (a GfxObj model_id
//! is its own part 0; a Setup model_id contributes `parts[0]`). Spot checks
//! for the WebAC-named candidates: GfxObjs 0x010014C3 / 0x01002286 and the
//! 0xB2AA cells. Example ids are printed for the 1070 eye test; the only
//! assertions are sanity checks — the numbers are the deliverable. If (a)
//! and (a') are zero, nothing needs porting.

use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::env_cell::surface_did_for_envcell_index;
use holtburger_dat::file_type::{EnvCell, Environment, GfxObj, SetupModel, Surface};
use holtburger_dat::graphics::Polygon;
use holtburger_dat::landblock::LandblockInfo;
use std::collections::HashMap;
use std::io::Cursor;
use std::path::PathBuf;

const NO_POS: u8 = 0x04;
const NO_NEG: u8 = 0x08;
const SIDES_CLOCKWISE: i32 = 2;
/// `Base1Image | Base1ClipMap`.
const TYPE_TEXTURED: u32 = 0x06;
/// `SurfaceType::Translucent`.
const TYPE_TRANSLUCENT: u32 = 0x10;
const ENVCELL_LOW_MIN: u32 = 0x0100;
const ENVCELL_LOW_MAX: u32 = 0xFFFD;
const LANDBLOCK_INFO_LOW: u32 = 0xFFFE;
const MAX_EXAMPLES: usize = 12;
const TOP_SURFACES: usize = 16;
/// WebAC `tests/verify-building-portal-faces.ts` candidates.
const SPOT_GFXOBJS: [u32; 2] = [0x0100_14C3, 0x0100_2286];
const SPOT_LANDBLOCK: u32 = 0xB2AA;

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

#[derive(Clone, Copy, Debug)]
struct SurfaceInfo {
    ty: u32,
    color: Option<u32>,
    translucency: f32,
}

impl SurfaceInfo {
    fn textured(&self) -> bool {
        (self.ty & TYPE_TEXTURED) != 0
    }

    /// Fully see-through: the only untextured case holtburger may already hide.
    fn dead(&self) -> bool {
        (self.ty & TYPE_TRANSLUCENT) != 0 && self.translucency >= 1.0
    }
}

#[derive(Default, Debug)]
struct SkipCensus {
    /// records walked (GfxObjs / EnvCell instances).
    owners: u64,
    /// ... with >= 1 (a) or (a') hit.
    owners_with_hits: u64,
    /// drawing polys with >= 3 vertices.
    polys: u64,
    /// NoPos — skipped by holtburger on every path.
    no_pos: u64,
    /// (a) `!NoPos`, untextured pos surface, not fully translucent.
    drawn_untextured: u64,
    /// (a) ... fully translucent.
    drawn_untextured_dead: u64,
    /// (a') default-path back tris on an untextured neg surface.
    back_untextured: u64,
    /// slot out of range / Surface unparsable.
    unresolved: u64,
    /// untextured surface DID -> (a) + (a') tri-source polys.
    by_surface: HashMap<u32, u64>,
    examples: Vec<u32>,
}

fn push_example(v: &mut Vec<u32>, id: u32) {
    if v.len() < MAX_EXAMPLES && !v.contains(&id) {
        v.push(id);
    }
}

/// One record's drawing polys. `resolve(slot) -> Option<surface DID>`.
/// Returns the record's (a) + (a') hit count.
fn tally_owner<'a>(
    c: &mut SkipCensus,
    owner: u32,
    polys: impl Iterator<Item = &'a Polygon>,
    resolve: &dyn Fn(i16) -> Option<u32>,
    surfaces: &HashMap<u32, SurfaceInfo>,
) -> u64 {
    let mut hits = 0u64;
    for poly in polys {
        if poly.vertex_ids.len() < 3 {
            continue;
        }
        c.polys += 1;
        if (poly.stippling & NO_POS) != 0 {
            c.no_pos += 1;
            continue;
        }
        let Some(pos_did) = resolve(poly.pos_surface) else {
            c.unresolved += 1;
            continue;
        };
        let Some(pos) = surfaces.get(&pos_did).copied() else {
            c.unresolved += 1;
            continue;
        };
        if !pos.textured() {
            hits += 1;
            if pos.dead() {
                c.drawn_untextured_dead += 1;
            } else {
                c.drawn_untextured += 1;
            }
            *c.by_surface.entry(pos_did).or_default() += 1;
        }
        // Same gate as the default path's back tri (`append_environment_tris`
        // / `append_gfx_tris_with_tex_swaps`).
        let has_back_face = poly.sides_type == SIDES_CLOCKWISE
            && (poly.stippling & NO_NEG) == 0
            && !poly.neg_uv_indices.is_empty();
        if has_back_face
            && let Some(neg_did) = resolve(poly.neg_surface)
            && neg_did != pos_did
            && surfaces.get(&neg_did).is_some_and(|s| !s.textured())
        {
            hits += 1;
            c.back_untextured += 1;
            *c.by_surface.entry(neg_did).or_default() += 1;
        }
    }
    c.owners += 1;
    if hits > 0 {
        c.owners_with_hits += 1;
        push_example(&mut c.examples, owner);
    }
    hits
}

fn print_census(label: &str, c: &SkipCensus, surfaces: &HashMap<u32, SurfaceInfo>) {
    println!("── {label} ──");
    println!("  records                                   {}", c.owners);
    println!("    with (a)/(a') hits                      {}", c.owners_with_hits);
    println!("  drawing polys                             {}", c.polys);
    println!("    NoPos (holtburger skips, retail too)    {}", c.no_pos);
    println!("    unresolved                              {}", c.unresolved);
    println!("  (a) !NoPos on untextured pos surface      {}", c.drawn_untextured);
    println!("      ... fully translucent (maybe hidden)  {}", c.drawn_untextured_dead);
    println!("  (a') back tri on untextured neg surface   {}", c.back_untextured);
    println!("  examples: {:08X?}", c.examples);
    let mut top: Vec<(u32, u64)> = c.by_surface.iter().map(|(&d, &n)| (d, n)).collect();
    top.sort_unstable_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    if !top.is_empty() {
        println!("  untextured surfaces ({} distinct), top {}:", top.len(), TOP_SURFACES.min(top.len()));
    }
    for (did, n) in top.into_iter().take(TOP_SURFACES) {
        match surfaces.get(&did) {
            Some(s) => println!(
                "    {did:08X}  polys {n:>7}  type {:08X}  color {}  translucency {:.3}",
                s.ty,
                s.color.map_or_else(|| "-".to_string(), |v| format!("{v:08X}")),
                s.translucency
            ),
            None => println!("    {did:08X}  polys {n:>7}"),
        }
    }
}

#[test]
#[ignore = "retail census over ~/ac_base_dats; run with --ignored --nocapture"]
fn skip_no_texture_retail_census() {
    let Some(portal_path) = base_dat("HOLTBURGER_PORTAL_DAT", &["client_portal.dat"]) else {
        eprintln!("SKIP skip_no_texture_census: no client_portal.dat (set HOLTBURGER_PORTAL_DAT)");
        return;
    };
    let portal = DatDatabase::new(&portal_path).expect("open client_portal.dat");
    let mut ids: Vec<u32> = portal.files.keys().copied().collect();
    ids.sort_unstable();

    // Surface type / colour / translucency by DID.
    let mut surfaces: HashMap<u32, SurfaceInfo> = HashMap::new();
    for &id in ids.iter().filter(|&&id| (id >> 24) == 0x08) {
        if let Ok(bytes) = portal.get_file(id)
            && let Ok(s) = Surface::unpack(&bytes)
        {
            surfaces.insert(
                id,
                SurfaceInfo { ty: s.surface_type, color: s.color_value, translucency: s.translucency },
            );
        }
    }
    let untextured_surfaces = surfaces.values().filter(|s| !s.textured()).count();

    let load_gfx = |id: u32| -> Option<GfxObj> {
        let bytes = portal.get_file(id).ok()?;
        GfxObj::unpack(&mut Cursor::new(&bytes)).ok()
    };

    // ── Spot checks: WebAC's building candidates, every untextured poly ──
    println!("── skip_no_texture census over {} ──", portal_path.display());
    println!("  Surfaces typed {} (untextured {})", surfaces.len(), untextured_surfaces);
    for &gid in &SPOT_GFXOBJS {
        let Some(gfx) = load_gfx(gid) else {
            println!("  spot {gid:08X}: not found / unparsable");
            continue;
        };
        println!("  spot {gid:08X}: {} polys, {} surfaces {:08X?}", gfx.polygons.len(), gfx.surfaces.len(), gfx.surfaces);
        let mut pids: Vec<u16> = gfx.polygons.keys().copied().collect();
        pids.sort_unstable();
        for pid in pids {
            let poly = &gfx.polygons[&pid];
            let did = (poly.pos_surface >= 0)
                .then(|| gfx.surfaces.get(poly.pos_surface as usize).copied())
                .flatten();
            let Some(s) = did.and_then(|d| surfaces.get(&d)) else { continue };
            if s.textured() {
                continue;
            }
            println!(
                "    poly {pid:>4}  verts {}  stippling {:#04X}  sides {}  pos {:08X} (type {:08X}, color {})  holtburger draws: {}",
                poly.vertex_ids.len(),
                poly.stippling,
                poly.sides_type,
                did.unwrap_or(0),
                s.ty,
                s.color.map_or_else(|| "-".to_string(), |v| format!("{v:08X}")),
                (poly.stippling & NO_POS) == 0 && poly.vertex_ids.len() >= 3
            );
        }
    }

    // ── Environment (0x0D) cellstructs: drawing polys keyed (env, cs) ──
    let mut env_polys: HashMap<(u32, u32), Vec<Polygon>> = HashMap::new();
    for &id in ids.iter().filter(|&&id| (id >> 24) == 0x0D) {
        let Ok(bytes) = portal.get_file(id) else { continue };
        let Ok(env) = Environment::unpack(&mut Cursor::new(&bytes)) else { continue };
        for (cs_id, cell) in env.cells {
            env_polys.insert((id, cs_id), cell.polygons.into_values().collect());
        }
    }

    let Some(cell_path) = base_dat("HOLTBURGER_CELL_DAT", &["client_cell_1.dat", "client_cell.dat"])
    else {
        eprintln!("  (no client_cell dat — EnvCell + building passes skipped)");
        assert!(!surfaces.is_empty(), "no Surfaces parsed — wrong dat?");
        return;
    };
    let cell_dat = DatDatabase::new(&cell_path).expect("open client_cell dat");
    let mut cell_ids: Vec<u32> = cell_dat.files.keys().copied().collect();
    cell_ids.sort_unstable();

    // ── EnvCell instances: slots → DIDs → types (DrawEnvCell isEnvCell = 1) ──
    let mut envcells = SkipCensus::default();
    let mut spot_cells = SkipCensus::default();
    for &cid in cell_ids
        .iter()
        .filter(|&&id| (ENVCELL_LOW_MIN..=ENVCELL_LOW_MAX).contains(&(id & 0xFFFF)))
    {
        let Ok(bytes) = cell_dat.get_file(cid) else { continue };
        let Ok(envcell) = EnvCell::unpack(&mut Cursor::new(&bytes)) else { continue };
        let env_did = 0x0D00_0000 | envcell.environment_id as u32;
        let Some(polys) = env_polys.get(&(env_did, envcell.cell_structure as u32)) else {
            continue;
        };
        let resolve = |slot: i16| -> Option<u32> {
            (slot >= 0)
                .then(|| envcell.surfaces.get(slot as usize).copied())
                .flatten()
                .map(surface_did_for_envcell_index)
        };
        tally_owner(&mut envcells, cid, polys.iter(), &resolve, &surfaces);
        if (cid >> 16) == SPOT_LANDBLOCK {
            tally_owner(&mut spot_cells, cid, polys.iter(), &resolve, &surfaces);
        }
    }

    // ── Buildings: LandblockInfo.buildings → part-0 GfxObj (DrawBuilding) ──
    let mut setup_part0: HashMap<u32, Option<(u32, usize)>> = HashMap::new();
    let mut placements_by_gfx: HashMap<u32, u64> = HashMap::new();
    let (mut lb_infos, mut buildings, mut setup_buildings, mut multi_part_setups) = (0u64, 0u64, 0u64, 0u64);
    let mut unresolved_models = 0u64;
    for &lid in cell_ids.iter().filter(|&&id| (id & 0xFFFF) == LANDBLOCK_INFO_LOW) {
        let Ok(bytes) = cell_dat.get_file(lid) else { continue };
        let Ok(info) = LandblockInfo::unpack(&bytes) else { continue };
        lb_infos += 1;
        for b in &info.buildings {
            buildings += 1;
            let part0 = match b.model_id >> 24 {
                0x01 => Some(b.model_id),
                0x02 => {
                    setup_buildings += 1;
                    let entry = *setup_part0.entry(b.model_id).or_insert_with(|| {
                        let bytes = portal.get_file(b.model_id).ok()?;
                        let setup = SetupModel::unpack(&mut Cursor::new(&bytes)).ok()?;
                        setup.parts.first().map(|&p| (p, setup.parts.len()))
                    });
                    if let Some((_, n)) = entry
                        && n > 1
                    {
                        multi_part_setups += 1;
                    }
                    entry.map(|(p, _)| p)
                }
                _ => None,
            };
            match part0 {
                Some(g) => *placements_by_gfx.entry(g).or_default() += 1,
                None => unresolved_models += 1,
            }
        }
    }
    let mut building_gfx: Vec<u32> = placements_by_gfx.keys().copied().collect();
    building_gfx.sort_unstable();
    let mut buildings_census = SkipCensus::default();
    let (mut placements_hit, mut gfx_failed) = (0u64, 0u64);
    for gid in building_gfx {
        let Some(gfx) = load_gfx(gid) else {
            gfx_failed += 1;
            continue;
        };
        let resolve = |slot: i16| -> Option<u32> {
            (slot >= 0).then(|| gfx.surfaces.get(slot as usize).copied()).flatten()
        };
        if tally_owner(&mut buildings_census, gid, gfx.polygons.values(), &resolve, &surfaces) > 0 {
            placements_hit += placements_by_gfx[&gid];
        }
    }

    println!("  cell dat {}", cell_path.display());
    print_census("EnvCell instances (DrawEnvCell, isEnvCell = 1)", &envcells, &surfaces);
    print_census(&format!("spot: 0x{SPOT_LANDBLOCK:04X} EnvCells"), &spot_cells, &surfaces);
    println!(
        "  LandblockInfos {lb_infos} · buildings {buildings} (Setup model {setup_buildings}, of which multi-part {multi_part_setups} — retail DrawBuilding draws part 0 only) · unresolved models {unresolved_models}"
    );
    println!(
        "  distinct part-0 GfxObjs {} (unparsable {gfx_failed}) · placements whose part 0 has hits {placements_hit}",
        placements_by_gfx.len()
    );
    print_census("Building part-0 GfxObjs (ObjBuildingOrBuildingPart = 1)", &buildings_census, &surfaces);

    assert!(!surfaces.is_empty(), "no Surfaces parsed — wrong dat?");
    assert!(envcells.owners > 0, "no EnvCells resolved — wrong cell dat?");
    assert!(buildings > 0, "no LandblockInfo buildings — wrong cell dat?");
}
