//! Retail-DAT parity + census sweep for `CellPortal.flags` (task
//! `PORTAL-FLAGS-DECODE`, batch-D `postBakeCodeWork`).
//!
//! Until 2026-08-11 `CellPortal.flags` was parsed and never decoded: no
//! `exact_match`, no `portal_side`, no leads-outdoors bit, and every
//! outdoor test in the engine was the VALUE test `(cell_id & 0xFFFF) >=
//! 0xFFFE` on a `landblock_high | other_cell_id` composed without
//! consulting bit 2. This sweep is the evidence for the decode:
//!
//!   1. **Bit coverage.** No portal in the retail baseline carries a
//!      flag bit outside `CELL_PORTAL_KNOWN_FLAGS` (0x7), so the decode
//!      is not dropping an undocumented field on the floor.
//!   2. **The sentinel equivalence.** `leads_outdoors()` (bit 2) and the
//!      `other_cell_id >= 0xFFFE` value test agree on every portal —
//!      which is what makes the existing value tests SAFE and lets this
//!      task leave `scene.rs` alone (see the task report).
//!   3. **The sidedness ORIENTATION.** `portal_side` is retail's
//!      `Sidedness` for the polygon plane, but which PHYSICAL side that
//!      names (room interior vs. the space beyond) is a property of the
//!      data, not of the flag. The JS punch gate
//!      (`scene3d/portal_clip.js#facesAwayWithSide`) has to know, so we
//!      measure it here: classify each portal's OWNING CELL centroid
//!      against the portal polygon's plane and tally whether it lands on
//!      the `portal_side` side. **Measured 2026-08-11 on the retail
//!      baseline: 15,186 / 15,186 outdoor-facing and 1,840,177 /
//!      1,840,177 cell→cell portals agree, zero on-plane, zero
//!      unresolved.** `portal_side` names the owning room's interior.
//!
//! Census on that same baseline (`client_cell_1.dat`, 734,976 EnvCells,
//! 1,867,699 portals): `exact_match` 1,724,912 · `portal_side` true
//! 547,046 · `leads_outdoors` 16,997 · unknown bits 0. Only six flag
//! words occur at all — 0x0000/0x0001/0x0002/0x0003/0x0005/0x0007 —
//! i.e. bit 2 never appears without bit 0, and bit 1+bit 2 together
//! (0x0006) never occurs.
//!
//! Retail grounding: `CCellPortal::UnPack` (`acclient.c:362379-362403`)
//! + `CCellPortal::Pack` (`acclient.c:362348-362375`) for the bits;
//! `CPolygon::make_plane` (`acclient.c:359628`) for the plane
//! convention; `PView::InitCell` (`acclient.c:461676-461697`) and
//! `PView::ConstructView(CBldPortal*, …)` (`acclient.c:462507-462543`)
//! for the traversal rule. ACE `PortalFlags.cs` and DRW `dats.xml:218`
//! name only bits 0-1 and neither carries the bit-1 inversion.
//!
//! Both DATs are read-only inputs. The sweep is bounded (see
//! `MAX_GEOMETRY_ENVIRONMENTS`) so it stays always-on rather than
//! `#[ignore]`d, matching `animation_hook_parity.rs`; it SKIPs cleanly
//! when the baseline DATs are not reachable. `--nocapture` prints the
//! full census.

use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::{EnvCell, Environment};
use std::collections::HashMap;
use std::io::Cursor;
use std::path::PathBuf;

/// EnvCell files in `client_cell.dat` are `0xLLLLNNNN` with `NNNN` in
/// `[0x0100, 0xFFFD]`; `0xLLLLFFFF` is the LandBlock heightmap and
/// `0xLLLLFFFE` the LandBlockInfo. Same range the engine's
/// `is_envcell_id` uses.
const ENVCELL_LOW_MIN: u32 = 0x0100;
const ENVCELL_LOW_MAX: u32 = 0xFFFD;

/// Environments (`0x0Dxxxxxx`, in `client_portal.dat`) whose geometry we
/// pull in for the orientation measurement. Each is a full CellStruct
/// tree; ~600 of them cover every dungeon and building shell in the
/// game and the sweep stays well under a minute. Raise for a deeper run.
const MAX_GEOMETRY_ENVIRONMENTS: usize = 600;

/// Retail's on-plane epsilon, `0.00019999999` — the literal in
/// `PView::InitCell` (`acclient.c:461681`) and
/// `PView::ConstructView` (`acclient.c:462519`).
const SIDEDNESS_EPS: f64 = 0.000_199_999_99;

fn retail_cell_dat_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("HOLTBURGER_CELL_DAT") {
        let p = PathBuf::from(p);
        if p.exists() {
            return Some(p);
        }
    }
    // The buildbox baseline ships the cell dat as `client_cell_1.dat`;
    // other checkouts name it `client_cell.dat`. Accept either.
    for c in [
        "/home/wbterminal/ac_base_dats/client_cell_1.dat",
        "/home/wbterminal/ac_base_dats/client_cell.dat",
    ] {
        let p = PathBuf::from(c);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

fn retail_portal_dat_path() -> Option<PathBuf> {
    if let Some(p) = holtburger_dat::utils::get_portal_dat_path() {
        return Some(p);
    }
    let c = PathBuf::from("/home/wbterminal/ac_base_dats/client_portal.dat");
    c.exists().then_some(c)
}

#[derive(Default, Debug)]
struct FlagCensus {
    cells: u64,
    portals: u64,
    exact_match: u64,
    portal_side_true: u64,
    leads_outdoors: u64,
    unknown_bits: u64,
    /// flags word → occurrences.
    words: HashMap<u16, u64>,

    // --- sentinel-equivalence tallies (invariant 2) ---
    /// bit 2 set, wire `other_cell_id` NOT 0xFFFF.
    outdoor_bit_without_ffff: u64,
    /// wire `other_cell_id` >= 0xFFFE, bit 2 NOT set.
    ffff_without_outdoor_bit: u64,
    /// bit 2 set AND the wire id would have composed to a plausible
    /// real neighbour (`0x0100..=0xFFFD`) — the fabricated-edge case.
    outdoor_bit_with_plausible_id: u64,
}

/// Newell plane of a polygon, in whatever space the points are given.
/// Deliberately the SAME accumulation as
/// `apps/holtburger-web/scene3d/portal_clip.js#polygonPlane` so the sign
/// measured here is the sign the JS gate will see, and the same
/// orientation as retail's `CPolygon::make_plane`
/// (`acclient.c:359628-359694`, a `Σ (v[k+1]-v0) × (v[k+2]-v0)` fan —
/// right-handed for CCW winding, which is what Newell yields too).
fn newell_plane(pts: &[[f64; 3]]) -> Option<([f64; 3], f64)> {
    let n = pts.len();
    if n < 3 {
        return None;
    }
    let (mut nx, mut ny, mut nz) = (0.0f64, 0.0f64, 0.0f64);
    let (mut cx, mut cy, mut cz) = (0.0f64, 0.0f64, 0.0f64);
    for i in 0..n {
        let a = pts[i];
        let b = pts[(i + 1) % n];
        nx += (a[1] - b[1]) * (a[2] + b[2]);
        ny += (a[2] - b[2]) * (a[0] + b[0]);
        nz += (a[0] - b[0]) * (a[1] + b[1]);
        cx += a[0];
        cy += a[1];
        cz += a[2];
    }
    let len = (nx * nx + ny * ny + nz * nz).sqrt();
    if !len.is_finite() || len < 1e-9 {
        return None;
    }
    nx /= len;
    ny /= len;
    nz /= len;
    cx /= n as f64;
    cy /= n as f64;
    cz /= n as f64;
    Some(([nx, ny, nz], -(nx * cx + ny * cy + nz * cz)))
}

/// Retail `Sidedness`: 0 = positive halfspace, 1 = negative, 2 = on the
/// plane. `PView::InitCell` (`acclient.c:461680-461690`).
fn sidedness(normal: [f64; 3], d: f64, p: [f64; 3]) -> u8 {
    let dist = normal[0] * p[0] + normal[1] * p[1] + normal[2] * p[2] + d;
    if dist > SIDEDNESS_EPS {
        0
    } else if dist < -SIDEDNESS_EPS {
        1
    } else {
        2
    }
}

#[derive(Default, Debug)]
struct OrientationCensus {
    /// portals we could resolve to a real polygon + >= 3 vertices.
    measured: u64,
    /// cell centroid classified ON the `portal_side` side.
    centroid_on_portal_side: u64,
    /// cell centroid classified on the OPPOSITE side.
    centroid_opposite: u64,
    /// centroid within the on-plane epsilon (unusable either way).
    centroid_on_plane: u64,
    /// portal polygon id absent from the CellStruct, or degenerate.
    unresolved: u64,
}

impl OrientationCensus {
    fn record(&mut self, portal_side: bool, centroid_side: u8) {
        self.measured += 1;
        let want = u8::from(portal_side);
        if centroid_side == 2 {
            self.centroid_on_plane += 1;
        } else if centroid_side == want {
            self.centroid_on_portal_side += 1;
        } else {
            self.centroid_opposite += 1;
        }
    }

    fn decided(&self) -> u64 {
        self.centroid_on_portal_side + self.centroid_opposite
    }
}

#[test]
fn cell_portal_flags_retail_census_and_sidedness_orientation() {
    let Some(cell_path) = retail_cell_dat_path() else {
        eprintln!(
            "SKIP cell_portal_flags_parity: no retail cell dat \
             (set HOLTBURGER_CELL_DAT or place it at \
             /home/wbterminal/ac_base_dats/client_cell_1.dat)"
        );
        return;
    };
    let cell_dat = DatDatabase::new(&cell_path).expect("open client_cell dat");

    // ── Pass 1: flag census over EVERY EnvCell in the baseline ───────
    let mut census = FlagCensus::default();
    let mut parse_failures: Vec<(u32, String)> = Vec::new();
    // cells that own at least one portal, keyed for pass 2.
    let mut portal_cells: Vec<u32> = Vec::new();

    let mut ids: Vec<u32> = cell_dat
        .files
        .keys()
        .copied()
        .filter(|id| {
            let low = id & 0xFFFF;
            (ENVCELL_LOW_MIN..=ENVCELL_LOW_MAX).contains(&low)
        })
        .collect();
    ids.sort();

    for id in &ids {
        let Ok(bytes) = cell_dat.get_file(*id) else {
            continue;
        };
        let envcell = match EnvCell::unpack(&mut Cursor::new(&bytes)) {
            Ok(c) => c,
            Err(e) => {
                parse_failures.push((*id, e.to_string()));
                continue;
            }
        };
        census.cells += 1;
        if !envcell.portals.is_empty() {
            portal_cells.push(*id);
        }
        for p in &envcell.portals {
            census.portals += 1;
            *census.words.entry(p.flags).or_insert(0) += 1;
            if p.exact_match() {
                census.exact_match += 1;
            }
            if p.portal_side() {
                census.portal_side_true += 1;
            }
            if p.leads_outdoors() {
                census.leads_outdoors += 1;
            }
            if p.unknown_flag_bits() != 0 {
                census.unknown_bits += 1;
            }

            let wire = p.other_cell_id as u32;
            if p.leads_outdoors() {
                if wire != 0xFFFF {
                    census.outdoor_bit_without_ffff += 1;
                }
                if (ENVCELL_LOW_MIN..=ENVCELL_LOW_MAX).contains(&wire) {
                    census.outdoor_bit_with_plausible_id += 1;
                }
            } else if wire >= 0xFFFE {
                census.ffff_without_outdoor_bit += 1;
            }
        }
    }

    println!("── CellPortal.flags census over {} ──", cell_path.display());
    println!("  EnvCells parsed           {}", census.cells);
    println!("  portals                   {}", census.portals);
    println!("  exact_match (bit0)        {}", census.exact_match);
    println!(
        "  portal_side TRUE          {}  (bit1 CLEAR — the inverted bit)",
        census.portal_side_true
    );
    println!("  leads_outdoors (bit2)     {}", census.leads_outdoors);
    println!("  portals with unknown bits {}", census.unknown_bits);
    let mut words: Vec<(u16, u64)> = census.words.iter().map(|(k, v)| (*k, *v)).collect();
    words.sort();
    for (w, n) in &words {
        println!("    flags 0x{:04X}  ×{}", w, n);
    }
    println!("  bit2 set but wire id != 0xFFFF        {}", census.outdoor_bit_without_ffff);
    println!("  bit2 set and wire id looks like a cell {}", census.outdoor_bit_with_plausible_id);
    println!("  wire id >= 0xFFFE but bit2 clear      {}", census.ffff_without_outdoor_bit);

    assert!(
        parse_failures.is_empty(),
        "{} EnvCell parse failures, first: {:?}",
        parse_failures.len(),
        parse_failures.first()
    );
    assert!(census.portals > 0, "no portals found — wrong dat?");

    // (1) The decode covers the whole field.
    assert_eq!(
        census.unknown_bits, 0,
        "portals carry flag bits outside CELL_PORTAL_KNOWN_FLAGS — the \
         decode is dropping a real field"
    );

    // (2) THE SENTINEL EQUIVALENCE. This is what licenses every
    //     `(cell_id & 0xFFFF) >= 0xFFFE` value test already in the
    //     engine: bit 2 and the value test are the same predicate on
    //     real data, so decoding the bit changes no edge.
    assert_eq!(
        census.outdoor_bit_without_ffff, 0,
        "a leads-outdoors portal carries a wire other_cell_id that is \
         not 0xFFFF — the >= 0xFFFE value tests are NOT equivalent to \
         the flag and scene.rs must switch to the flag"
    );
    assert_eq!(
        census.ffff_without_outdoor_bit, 0,
        "a portal with other_cell_id >= 0xFFFE does not set bit 2 — the \
         value tests over-report outdoor exits"
    );

    // ── Pass 2: sidedness ORIENTATION against real cell geometry ─────
    let Some(portal_path) = retail_portal_dat_path() else {
        eprintln!(
            "SKIP the orientation half: no client_portal.dat (the flag \
             census above still ran and passed)"
        );
        return;
    };
    let portal_dat = DatDatabase::new(&portal_path).expect("open client_portal.dat");

    let mut envs: HashMap<u32, Option<Environment>> = HashMap::new();
    let mut outdoor = OrientationCensus::default();
    let mut indoor = OrientationCensus::default();

    for id in &portal_cells {
        let Ok(bytes) = cell_dat.get_file(*id) else {
            continue;
        };
        let Ok(envcell) = EnvCell::unpack(&mut Cursor::new(&bytes)) else {
            continue;
        };
        let env_id = 0x0D00_0000u32 | envcell.environment_id as u32;

        // Bounded: stop pulling NEW environments once we hit the cap,
        // but keep measuring cells whose environment is already loaded.
        if !envs.contains_key(&env_id) {
            if envs.len() >= MAX_GEOMETRY_ENVIRONMENTS {
                continue;
            }
            let parsed = portal_dat
                .get_file(env_id)
                .ok()
                .and_then(|b| Environment::unpack(&mut Cursor::new(&b)).ok());
            envs.insert(env_id, parsed);
        }
        let Some(Some(env)) = envs.get(&env_id) else {
            continue;
        };
        let Some(cs) = env.cells.get(&(envcell.cell_structure as u32)) else {
            continue;
        };
        if cs.vertex_array.vertices.is_empty() {
            continue;
        }

        // The cell's own geometric centroid, cell-local — the same
        // space the portal polygon's vertices live in, so no frame
        // transform is involved and the sign cannot be a transform bug.
        let mut c = [0.0f64; 3];
        for v in cs.vertex_array.vertices.values() {
            c[0] += v.origin.x as f64;
            c[1] += v.origin.y as f64;
            c[2] += v.origin.z as f64;
        }
        let nv = cs.vertex_array.vertices.len() as f64;
        c[0] /= nv;
        c[1] /= nv;
        c[2] /= nv;

        for p in &envcell.portals {
            let bucket = if p.leads_outdoors() {
                &mut outdoor
            } else {
                &mut indoor
            };
            let Some(poly) = cs.polygons.get(&p.polygon_id) else {
                bucket.unresolved += 1;
                continue;
            };
            let mut pts: Vec<[f64; 3]> = Vec::with_capacity(poly.vertex_ids.len());
            let mut ok = true;
            for &vid in &poly.vertex_ids {
                match cs.vertex_array.vertices.get(&(vid as u16)) {
                    Some(v) => pts.push([v.origin.x as f64, v.origin.y as f64, v.origin.z as f64]),
                    None => {
                        ok = false;
                        break;
                    }
                }
            }
            if !ok || pts.len() < 3 {
                bucket.unresolved += 1;
                continue;
            }
            let Some((normal, d)) = newell_plane(&pts) else {
                bucket.unresolved += 1;
                continue;
            };
            bucket.record(p.portal_side(), sidedness(normal, d, c));
        }
    }

    let report = |name: &str, o: &OrientationCensus| {
        println!(
            "  {name:<22} measured {:<6} on-portal_side {:<6} opposite {:<6} \
             on-plane {:<5} unresolved {}",
            o.measured, o.centroid_on_portal_side, o.centroid_opposite, o.centroid_on_plane,
            o.unresolved
        );
    };
    println!(
        "── portal_side orientation vs. owning-cell centroid ({} environments) ──",
        envs.values().filter(|e| e.is_some()).count()
    );
    report("leads-outdoors", &outdoor);
    report("indoor (cell→cell)", &indoor);

    assert!(
        outdoor.decided() > 500,
        "too few outdoor-sentinel portals resolved to geometry ({}) to \
         call the orientation",
        outdoor.decided()
    );

    // (3) THE ORIENTATION VERDICT, pinned so a future re-key of the
    //     plane convention (winding, transform, Newell sign) cannot
    //     silently flip the JS punch gate. `portal_side` names the side
    //     the portal is VIEWED FROM, and for a CCellPortal that viewer
    //     is inside the owning room — so the room's own centroid lands
    //     on the portal_side side.
    //
    //     The measurement is not "overwhelmingly" — it is EXACT. On the
    //     retail baseline this holds for 15,186 / 15,186 outdoor-facing
    //     and 1,840,177 / 1,840,177 cell→cell portals, with zero
    //     on-plane and zero unresolved. So it is asserted as an
    //     equality, not a fraction: a single counterexample means the
    //     plane convention drifted and
    //     `portal_clip.js#facesAwayWithSide` is inverted for that
    //     portal.
    for (name, o) in [("leads-outdoors", &outdoor), ("indoor", &indoor)] {
        assert_eq!(
            o.centroid_opposite, 0,
            "{name}: {} portals put the owning cell's centroid on the \
             side OPPOSITE portal_side — portal_side does not name the \
             room interior and the JS punch gate's sign is wrong",
            o.centroid_opposite
        );
        assert_eq!(
            o.centroid_on_plane, 0,
            "{name}: {} portals put the owning cell's centroid ON the \
             portal plane (within retail's 2e-4) — the orientation is \
             undecidable for those and the gate needs a fallback",
            o.centroid_on_plane
        );
        assert_eq!(
            o.unresolved, 0,
            "{name}: {} portals could not be resolved to a polygon with \
             >= 3 vertices in their own CellStruct",
            o.unresolved
        );
    }
}
