//! dump_nonyaw_placements — find outdoor LandblockInfo stabs/buildings whose
//! orientation quaternion is NON-YAW (a real tilt: qx or qy != 0), for the
//! `?fullPlacementQuat` (F13-4) 1070 eye-test. A pure-yaw rotation (about AC's
//! z-up axis) has the form (w,0,0,z); anything with |x|>eps or |y|>eps is a
//! tilt the yaw-only path renders wrong (bolt-upright at a garbage heading).
//!
//! Prints LB id, setup/model DID, LB-local origin, WORLD coords
//! (lbX*192+x, lbY*192+y, z), and the quat. Scans the whole cell dat; lists
//! 0x7D64 first (the doc's example LB) then the rest, capped.
//!
//! Run:
//!   PATH="$HOME/.cargo/bin:$PATH" capped-build \
//!     cargo run --release -p holtburger-dat --example dump_nonyaw_placements

use holtburger_dat::DatDatabase;
use holtburger_dat::landblock::LandblockInfo;
use std::path::PathBuf;
use std::process::ExitCode;

fn cell_dat_path() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    let p = PathBuf::from(home).join("ac_base_dats/client_cell_1.dat");
    if p.exists() { Some(p) } else { None }
}

const EPS: f32 = 1.0e-3;

struct Hit {
    lb: u32,
    kind: &'static str, // "stab" | "building"
    did: u32,
    lx: f32, ly: f32, lz: f32,
    wx: f32, wy: f32,
    qw: f32, qx: f32, qy: f32, qz: f32,
}

fn main() -> ExitCode {
    let dat = match cell_dat_path().and_then(|p| DatDatabase::new(&p).ok()) {
        Some(d) => d,
        None => { eprintln!("client_cell_1.dat not found"); return ExitCode::from(2); }
    };

    // All LandblockInfo keys: 0xLLLLFFFE.
    let mut lbi_keys: Vec<u32> = dat.files.keys().copied()
        .filter(|id| (id & 0xFFFF) == 0xFFFE)
        .collect();
    lbi_keys.sort_unstable();
    eprintln!("scanning {} LandblockInfo records...", lbi_keys.len());

    let mut hits: Vec<Hit> = Vec::new();
    let mut scanned = 0usize;
    let mut parse_err = 0usize;

    for key in lbi_keys {
        let bytes = match dat.get_file(key) { Ok(b) => b, Err(_) => continue };
        let info = match LandblockInfo::unpack(&bytes) { Ok(i) => i, Err(_) => { parse_err += 1; continue } };
        scanned += 1;
        let lb_hi = key & 0xFFFF_0000;            // 0xLLLL0000
        let lbx = ((key >> 24) & 0xFF) as f32;
        let lby = ((key >> 16) & 0xFF) as f32;
        let mut push = |kind: &'static str, did: u32, o: &holtburger_common::Vector3, q: &holtburger_common::Quaternion| {
            if q.x.abs() > EPS || q.y.abs() > EPS {
                hits.push(Hit {
                    lb: lb_hi, kind, did,
                    lx: o.x, ly: o.y, lz: o.z,
                    wx: lbx * 192.0 + o.x, wy: lby * 192.0 + o.y,
                    qw: q.w, qx: q.x, qy: q.y, qz: q.z,
                });
            }
        };
        for s in &info.objects {
            push("stab", s.id, &s.frame.origin, &s.frame.orientation);
        }
        for b in &info.buildings {
            push("building", b.model_id, &b.frame.origin, &b.frame.orientation);
        }
    }

    eprintln!("scanned {scanned} ({parse_err} parse errors). {} non-yaw placements found.", hits.len());

    // 0x7D64 first, then the rest.
    hits.sort_by_key(|h| (h.lb != 0x7D64_0000, h.lb));
    let show = hits.len().min(60);
    println!("LB         kind      DID         local(x,y,z)               WORLD(x,y)            quat(w,x,y,z)");
    for h in hits.iter().take(show) {
        println!(
            "0x{:08X} {:8} 0x{:08X}  ({:8.2},{:8.2},{:7.2})  ({:9.2},{:9.2})  ({:+.4},{:+.4},{:+.4},{:+.4})",
            h.lb, h.kind, h.did, h.lx, h.ly, h.lz, h.wx, h.wy, h.qw, h.qx, h.qy, h.qz,
        );
    }
    if hits.len() > show { println!("... and {} more", hits.len() - show); }
    ExitCode::SUCCESS
}
