// Deterministic proof for the "building interiors show only NPCs from outside" bug.
//
// The live outdoor render-set path (apps/holtburger-web/src/lib.rs
// get_render_set_with_frustum, outdoor branch) derives its `outdoor_exit_cells`
// set from `cell_portal_polygons`, which lib.rs:16352-16400 only populates when
// a portal's `polygon_id` resolves to a DRAWING polygon in the cellstruct AND
// every one of that polygon's vertices resolves. The unit-tested twin
// (holtburger-world scene.rs compute_visibility_with_frustum) instead derives it
// from the portal GRAPH EDGES, which only need the portal connection to exist.
//
// This probe replays BOTH predicates over real Holtburg-town EnvCells and counts
// cells that HAVE an outdoor-exit edge but produce ZERO resolvable outdoor-aperture
// drawing polygons. Any such cell renders in the tested twin but is dropped by the
// live path -> its interior geometry/statics/lights never show while ACE NPCs
// (a separate always-visible group) float in the empty room. Non-zero => bug real.
use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::{Environment, EnvCell};
use std::collections::HashMap;
use std::io::Cursor;

fn main() {
    let cell_dat = DatDatabase::new("/home/wbterminal/ac_base_dats/client_cell_1.dat").unwrap();
    let portal = DatDatabase::new("/home/wbterminal/ac_base_dats/client_portal.dat").unwrap();
    let mut env_cache: HashMap<u32, Environment> = HashMap::new();

    // Holtburg core + a few dense town landblocks (same set probe_env847 uses).
    let lbs: [u32; 9] = [0xA9B4, 0xA9B3, 0xAAB3, 0xAAB4, 0xAAB5, 0xABB3, 0xABB4, 0xA8B4, 0xA8B3];

    let (mut n_cells, mut n_exit_edge, mut n_exit_with_poly, mut n_exit_no_poly) = (0u32, 0u32, 0u32, 0u32);
    let mut examples: Vec<String> = vec![];

    for &lb in &lbs {
        let lbhigh = lb << 16;
        for low in 0x0100u32..0x0400 {
            let did = lbhigh | low;
            let Ok(b) = cell_dat.get_file(did) else { continue };
            let Ok(ec) = EnvCell::unpack(&mut Cursor::new(b)) else { continue };
            n_cells += 1;

            let env_did = 0x0D00_0000u32 | ec.environment_id as u32;
            if !env_cache.contains_key(&env_did) {
                if let Ok(eb) = portal.get_file(env_did) {
                    if let Ok(e) = Environment::unpack(&mut Cursor::new(eb)) {
                        env_cache.insert(env_did, e);
                    }
                }
            }
            let cs = ec.cell_structure as u32;
            let cell_struct = env_cache.get(&env_did).and_then(|e| e.cells.get(&cs));

            // EDGE predicate (tested twin): any portal edge to an outdoor sentinel.
            let has_outdoor_edge = ec
                .portals
                .iter()
                .any(|p| (p.other_cell_id as u32 & 0xFFFF) >= 0xFFFE);
            if !has_outdoor_edge {
                continue;
            }
            n_exit_edge += 1;

            // POLYGON predicate (live path): count outdoor-exit portals whose
            // polygon_id resolves to a drawing polygon with all verts resolvable.
            // Mirrors lib.rs:16352-16400 exactly.
            let mut resolvable_apertures = 0u32;
            if let Some(c) = cell_struct {
                for portal in &ec.portals {
                    if (portal.other_cell_id as u32 & 0xFFFF) < 0xFFFE {
                        continue; // interior edge, not an outdoor aperture
                    }
                    let Some(poly) = c.polygons.get(&portal.polygon_id) else {
                        continue;
                    };
                    if poly.num_pts < 3 {
                        continue;
                    }
                    let all_ok = poly
                        .vertex_ids
                        .iter()
                        .all(|&vid| c.vertex_array.vertices.contains_key(&(vid as u16)));
                    if all_ok && poly.vertex_ids.len() >= 3 {
                        resolvable_apertures += 1;
                    }
                }
            }

            if resolvable_apertures > 0 {
                n_exit_with_poly += 1;
            } else {
                n_exit_no_poly += 1;
                if examples.len() < 20 {
                    let n_out_portals = ec
                        .portals
                        .iter()
                        .filter(|p| (p.other_cell_id as u32 & 0xFFFF) >= 0xFFFE)
                        .count();
                    examples.push(format!(
                        "  cell 0x{:08X}  env=0x{:08X} cs={:<4} outdoor_portals={} cellstruct_loaded={} portals={}",
                        did,
                        env_did,
                        cs,
                        n_out_portals,
                        cell_struct.is_some(),
                        ec.portals.len(),
                    ));
                }
            }
        }
    }

    println!("=== Outdoor-aperture resolution probe (Holtburg town LBs) ===");
    println!("EnvCells scanned:                       {n_cells}");
    println!("  with an outdoor-exit EDGE:            {n_exit_edge}   <- tested twin renders these");
    println!("    of which resolve an aperture POLY:  {n_exit_with_poly}   <- live path renders these");
    println!("    of which resolve NO aperture poly:  {n_exit_no_poly}   <- live path DROPS these (BUG)");
    if n_exit_edge > 0 {
        println!(
            "  live-path miss rate:                  {:.1}%",
            100.0 * n_exit_no_poly as f32 / n_exit_edge as f32
        );
    }
    if !examples.is_empty() {
        println!("\nExamples of exit cells the live path drops (edge yes, no drawing aperture):");
        for e in &examples {
            println!("{e}");
        }
    }
}
