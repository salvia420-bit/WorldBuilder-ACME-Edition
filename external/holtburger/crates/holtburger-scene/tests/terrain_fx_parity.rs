//! terrain_fx.rs (the scatter pool's re-scatter planner) vs the real
//! terrain_scatter.js pool (fixture: apps/holtburger-web/tools/rust_parity/
//! gen_terrain_fx.mjs, which records every `scatterInstance(i, gx, gy)` call of
//! the shipped edge drain + round-robin, in order, with the resolvedFlags /
//! outFlags each one left). No transcendental function is involved: every
//! planned scatter, its order, the per-frame written / scanned / cursor /
//! edge counts and the queued edge lines must match EXACTLY, with zero
//! planner/JS disagreements on `outFlags`.
#![cfg(feature = "lane-terrain-fx")]

mod common;
use common::*;
use holtburger_scene::terrain_fx::{
    PlannerConfig, STAT_CURSOR, STAT_DESYNC, STAT_EDGE_WRITTEN, STAT_SCANNED, STAT_STOPS, STAT_WRITTEN, ScatterPlanner, scatter_hash_u32,
};
use serde_json::Value;

fn ints(v: &Value) -> Vec<i64> {
    v.as_array().expect("array").iter().map(|x| x.as_i64().expect("int")).collect()
}

#[test]
fn planner_replays_the_scatter_pool() {
    let Some(fx) = fixture("terrain_fx") else {
        eprintln!("terrain_fx fixture missing — run node tools/rust_parity/gen_terrain_fx.mjs (from apps/holtburger-web)");
        return;
    };
    let cases = fx["cases"].as_array().expect("cases");
    assert!(cases.len() >= 4);
    for c in cases {
        let name = c["name"].as_str().unwrap_or("?");
        let cf = &c["cfg"];
        let cfg = PlannerConfig {
            count: cf["count"].as_u64().unwrap() as usize,
            grid: cf["gridSize"].as_u64().unwrap() as usize,
            cell_size: hex_f64(&cf["cellSizeM"]),
            radius: hex_f64(&cf["radiusM"]),
            jitter: hex_f64(&cf["jitter"]),
            seed: cf["seed"].as_i64().unwrap() as i32,
            disc: cf["disc"].as_bool().unwrap(),
            scan_budget: cf["scanBudget"].as_u64().unwrap() as usize,
            slice_size: cf["sliceSize"].as_u64().unwrap() as usize,
            edge_budget: cf["edgeBudget"].as_u64().unwrap() as usize,
        };
        let mut p = ScatterPlanner::new(cfg).unwrap_or_else(|| panic!("{name}: config refused"));
        let mut planned_total = 0usize;
        for ev in c["frames"].as_array().unwrap() {
            let f = ev["frame"].as_u64().unwrap();
            if ev["invalidate"].as_bool() == Some(true) {
                p.invalidate();
            }
            let cx = hex_f64(&ev["cx"]);
            let cy = hex_f64(&ev["cy"]);
            let gx_min = ev["gxMin"].as_i64().unwrap() as i32;
            let gy_min = ev["gyMin"].as_i64().unwrap() as i32;
            let scatters: Vec<Vec<i64>> = ev["scatters"].as_array().unwrap().iter().map(ints).collect();
            if ev["kind"].as_str() == Some("rescatterAll") {
                let n = cfg.count;
                assert_eq!(scatters.len(), n, "{name} frame {f}: rescatterAll covers every instance");
                let mut x = vec![0i32; n];
                let mut y = vec![0i32; n];
                let mut r = vec![0u8; n];
                let mut o = vec![0u8; n];
                for s in &scatters {
                    let i = s[0] as usize;
                    x[i] = s[1] as i32;
                    y[i] = s[2] as i32;
                    r[i] = s[3] as u8;
                    o[i] = s[4] as u8;
                }
                assert!(p.sync_all(&x, &y, &r, &o, gx_min, gy_min, 0), "{name} frame {f}: sync");
                continue;
            }
            let mut k = 0usize;
            let mut n = p.begin(cx, cy, gx_min, gy_min);
            while n > 0 {
                for j in 0..n {
                    let want = scatters.get(k + j).unwrap_or_else(|| panic!("{name} frame {f}: planner made more than {} scatters", scatters.len()));
                    let b = &p.batch()[j * 3..j * 3 + 3];
                    assert_eq!(
                        (b[0] as i64, b[1] as i64, b[2] as i64),
                        (want[0], want[1], want[2]),
                        "{name} frame {f} scatter #{}",
                        k + j
                    );
                }
                for j in 0..n {
                    let want = &scatters[k + j];
                    p.outcome_mut()[j] = ((want[3] & 1) | ((want[4] & 1) << 1)) as u8;
                }
                k += n;
                n = p.resume(n);
            }
            assert_eq!(k, scatters.len(), "{name} frame {f}: scatter count");
            planned_total += k;
            let s = p.stats();
            assert_eq!(s[STAT_WRITTEN] as u64, ev["written"].as_u64().unwrap(), "{name} frame {f}: written");
            assert_eq!(s[STAT_SCANNED] as u64, ev["scanned"].as_u64().unwrap(), "{name} frame {f}: scanned");
            assert_eq!(s[STAT_CURSOR] as u64, ev["cursor"].as_u64().unwrap(), "{name} frame {f}: cursor");
            assert_eq!(s[STAT_EDGE_WRITTEN] as u64, ev["edgeWritten"].as_u64().unwrap(), "{name} frame {f}: edge written");
            assert_eq!(s[STAT_DESYNC], 0, "{name} frame {f}: planner and JS disagree on outFlags");
            assert_eq!(p.queued_lines() as u64, ev["edgePending"].as_u64().unwrap(), "{name} frame {f}: queued edge lines");
            assert!(p.done());
        }
        eprintln!("terrain_fx {name}: {planned_total} planned scatters, {} stops", p.stats()[STAT_STOPS]);
    }
}

#[test]
fn hash_is_terrain_scatter_hash() {
    // terrain_scatter.js scatterHashU32 (node, 2026-10-26).
    assert_eq!(scatter_hash_u32(0, 0, 0, 0), 1577672556);
    assert_eq!(scatter_hash_u32(12, -7, 1, 0x520c4bed), 2650851772);
    assert_eq!(scatter_hash_u32(-123456, 98765, 19, -1), 770330033);
}
