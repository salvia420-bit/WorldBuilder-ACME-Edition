//! Lane W parity: the fixtures apps/holtburger-web/tools/rust_parity/gen_world.mjs
//! records by driving the REAL producers in node (chunk buckets with and
//! without ?statGeomDedup, atlas buckets, building batches, the pool registry,
//! the slot grid driving a real LandblockLRU) with the shadow bridge armed on
//! the JS reference model. For every scenario:
//!
//! - the protocol tables (opcodes, sections, kinds, tile states, mismatch and
//!   integrity names, abi) equal the ones the JS wrote;
//! - the recorded event stream, replayed checkpoint by checkpoint, audits 0
//!   mismatches against the arena the bridge built from three.js and the JS
//!   residency at that checkpoint, with 0 integrity errors, the model's table
//!   census and the model's AND-form divergence;
//! - every recorded perturbation of an arena is caught with exactly the model's
//!   per-category counts (the audit is not vacuous);
//! - the whole stream in ONE batch reaches the same tables as the checkpoint
//!   segments;
//! - (2026-10-29) the `poolHideOrphan` cross-check is exercised: `objrPool`
//!   (the grid with `?objRadius`'s pool hides wired) audits 0 at every
//!   checkpoint, and at least one of its negatives is caught as an orphan.
//!
//! A missing fixture prints a hint and passes (as the other lanes' suites do).
#![cfg(feature = "lane-world")]

mod common;

use holtburger_scene::world::{events, Census, World, INTEGRITY_KEYS, MISMATCH_KEYS};
use serde_json::Value;

const SCENARIOS: &[&str] = &["chunk", "chunkDedup", "atlas", "building", "pool", "grid", "objrPool"];

fn value(x: &Value) -> f64 {
    match x {
        Value::Number(n) => n.as_f64().expect("number"),
        Value::String(s) => f64::from_bits(u64::from_str_radix(s, 16).expect("hex")),
        other => panic!("fixture value {other}"),
    }
}

fn values(v: &Value) -> Vec<f64> {
    v.as_array().expect("array").iter().map(value).collect()
}

fn load(name: &str) -> Option<Value> {
    let fx = common::fixture(&format!("world_{name}"));
    if fx.is_none() {
        eprintln!("world_parity: no fixture world_{name}.json — run `node tools/rust_parity/gen_world.mjs` in apps/holtburger-web");
    }
    fx
}

fn census_field(c: &Census, k: &str) -> u64 {
    let tiles = |s: u32| c.tiles.get(&s).copied().unwrap_or(0);
    match k {
        "objects" => c.objects,
        "slots" => c.slots,
        "active" => c.active,
        "visible" => c.visible,
        "attributed" => c.attributed,
        "committed" => c.committed,
        "geometries" => c.geometries,
        "lb_index" => c.lb_index,
        "tile_index" => c.tile_index,
        "cell_index" => c.cell_index,
        "lru_live" => c.lru_live,
        "lru_parked" => c.lru_parked,
        "tiles_fetching" => tiles(events::TS_FETCHING),
        "tiles_staged" => tiles(events::TS_STAGED),
        "tiles_live" => tiles(events::TS_LIVE),
        "tiles_parked" => tiles(events::TS_PARKED),
        "tiles_quarantined" => tiles(events::TS_QUARANTINED),
        "pool_regs" => c.pool_regs,
        "pool_parked_tiles" => c.pool_parked_tiles,
        "pool_hidden_lbs" => c.pool_hidden_lbs,
        "pool_records" => c.pool_records,
        "objr_hidden" => c.objr_hidden,
        "cells" => c.cells,
        other => panic!("unknown census field {other}"),
    }
}

fn same_table(what: &str, fixture: &Value, rust: &[(&str, u32)]) {
    let obj = fixture.as_object().expect("table object");
    assert_eq!(obj.len(), rust.len(), "{what}: entry count (fixture {obj:?})");
    for &(name, code) in rust {
        let v = obj.get(name).and_then(Value::as_u64);
        assert_eq!(v, Some(u64::from(code)), "{what}.{name}");
    }
}

#[test]
fn protocol_tables_match_the_bridge() {
    for name in SCENARIOS {
        let Some(fx) = load(name) else { continue };
        assert_eq!(fx["abi"].as_u64(), Some(u64::from(events::ABI)), "{name}: abi");
        same_table("ops", &fx["ops"], events::OPS);
        same_table("sections", &fx["sections"], events::SECTIONS);
        same_table("kinds", &fx["kinds"], events::KINDS);
        same_table("tile_states", &fx["tile_states"], events::TILE_STATES);
        let mk: Vec<&str> = fx["mismatch_keys"].as_array().expect("array").iter().map(|v| v.as_str().expect("str")).collect();
        assert_eq!(mk, MISMATCH_KEYS.to_vec(), "{name}: mismatch categories");
        let ik: Vec<&str> = fx["integrity_keys"].as_array().expect("array").iter().map(|v| v.as_str().expect("str")).collect();
        assert_eq!(ik, INTEGRITY_KEYS.to_vec(), "{name}: integrity counters");
    }
}

#[test]
fn every_checkpoint_audits_clean_with_the_models_census() {
    for name in SCENARIOS {
        let Some(fx) = load(name) else { continue };
        let ev = values(&fx["events"]);
        let mut w = World::new();
        let mut prev = 0usize;
        for cp in fx["checkpoints"].as_array().expect("checkpoints") {
            let label = cp["label"].as_str().unwrap_or("?");
            let end = cp["events_end"].as_u64().expect("events_end") as usize;
            let applied = w.apply(&ev[prev..end]);
            assert!(applied.is_ok(), "{name} / {label}: apply failed at {applied:?}");
            prev = end;
            let arena = values(&cp["arena"]);
            let m = w.audit(&arena);
            let want = cp["mismatches"].as_u64().expect("mismatches");
            assert_eq!(
                m,
                Some(want),
                "{name} / {label}: audit (categories {:?}, samples {:?})",
                w.last_audit().cat,
                w.last_audit().samples
            );
            assert_eq!(w.integrity_total(), cp["integrity"].as_u64().expect("integrity"), "{name} / {label}: integrity {:?}", w.integrity());
            assert_eq!(w.last_audit().and_divergence, cp["and_divergence"].as_u64().expect("and_divergence"), "{name} / {label}: AND-form divergence");
            let census = w.census();
            for (k, v) in cp["census"].as_object().expect("census") {
                assert_eq!(census_field(&census, k), v.as_u64().expect("u64"), "{name} / {label}: census.{k}");
            }
        }
        assert_eq!(prev, ev.len(), "{name}: the last checkpoint closes the stream");
    }
}

#[test]
fn negatives_are_caught_category_for_category() {
    for name in SCENARIOS {
        let Some(fx) = load(name) else { continue };
        let ev = values(&fx["events"]);
        let cps = fx["checkpoints"].as_array().expect("checkpoints");
        let negs = fx["negatives"].as_array().expect("negatives");
        assert!(!negs.is_empty(), "{name}: the fixture carries negatives");
        for neg in negs {
            let label = neg["label"].as_str().unwrap_or("?");
            let cp = &cps[neg["checkpoint"].as_u64().expect("checkpoint") as usize];
            let end = cp["events_end"].as_u64().expect("events_end") as usize;
            let mut w = World::new();
            assert!(w.apply(&ev[..end]).is_ok(), "{name} / {label}: replay");
            let mut arena = values(&cp["arena"]);
            for e in neg["edits"].as_array().expect("edits") {
                let e = e.as_array().expect("edit");
                arena[e[0].as_u64().expect("index") as usize] = value(&e[1]);
            }
            let m = w.audit(&arena);
            assert_eq!(m, neg["mismatches"].as_u64(), "{name} / {label}: total");
            let cat = neg["cat"].as_object().expect("cat");
            for (k, key) in MISMATCH_KEYS.iter().enumerate() {
                let want = cat.get(*key).and_then(Value::as_u64).unwrap_or(0);
                assert_eq!(w.last_audit().cat[k], want, "{name} / {label}: category {key}");
            }
        }
    }
}

#[test]
fn one_batch_replay_reaches_the_same_tables() {
    for name in SCENARIOS {
        let Some(fx) = load(name) else { continue };
        let ev = values(&fx["events"]);
        let mut whole = World::new();
        assert_eq!(whole.apply(&ev).map(|n| n > 0), Ok(true), "{name}: one batch");
        let mut parts = World::new();
        let mut prev = 0usize;
        for cp in fx["checkpoints"].as_array().expect("checkpoints") {
            let end = cp["events_end"].as_u64().expect("events_end") as usize;
            assert!(parts.apply(&ev[prev..end]).is_ok());
            prev = end;
        }
        assert_eq!(whole.census(), parts.census(), "{name}: census");
        assert_eq!(whole.integrity(), parts.integrity(), "{name}: integrity");
        assert_eq!(whole.census_json(), parts.census_json(), "{name}: census json");
        let last = fx["checkpoints"].as_array().expect("checkpoints").last().expect("a checkpoint");
        assert_eq!(whole.audit(&values(&last["arena"])), Some(0), "{name}: the last arena against the one-batch tables");
    }
}

/// 2026-10-29 (lane W review r2): the `objrPool` fixture drives the path the
/// `?objRadius` forget fix lives on (hide → park → release → forget → walk
/// back) through the grid with the pool hides wired, and pins the
/// `poolHideOrphan` cross-check: its negatives must include an orphan (the
/// per-category counts are then checked by `negatives_are_caught_category_for_category`).
#[test]
fn the_pool_hide_cross_check_is_pinned() {
    let Some(fx) = load("objrPool") else { return };
    let negs = fx["negatives"].as_array().expect("negatives");
    let orphans: u64 = negs.iter().filter_map(|n| n["cat"].get("poolHideOrphan").and_then(Value::as_u64)).sum();
    assert!(orphans > 0, "objrPool: no negative exercises poolHideOrphan");
    let ev = values(&fx["events"]);
    let (mut i, mut forgets, mut pool_hides, mut pool_shows) = (0usize, 0u64, 0u64, 0u64);
    while i < ev.len() {
        let len = events::record_len(&ev, i).expect("a decodable record");
        match ev[i] as u32 {
            events::OP_OBJR_FORGET => forgets += 1,
            events::OP_POOL_HIDE_LB => pool_hides += 1,
            events::OP_POOL_SHOW_LB => pool_shows += 1,
            _ => {}
        }
        i += len;
    }
    assert!(forgets > 0 && pool_hides > 0 && pool_shows > 0, "objrPool: forgets {forgets}, pool hides {pool_hides}, pool shows {pool_shows}");
}
