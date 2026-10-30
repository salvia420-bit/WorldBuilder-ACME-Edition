//! Unit tests: small hand-built streams per rule family. The fixture replay
//! over the real producers is tests/world_parity.rs.

use super::events::*;
use super::*;

fn ev(records: &[&[f64]]) -> Vec<f64> {
    records.iter().flat_map(|r| r.iter().copied()).collect()
}

fn f(v: u32) -> f64 {
    f64::from(v)
}

/// An OBJECTS section for one object from (active, visible, gid) triples.
fn objects_arena(h: u32, slots: &[(bool, bool, u32)]) -> Vec<f64> {
    let mut a = vec![f(SEC_OBJECTS), 1.0, f(h), 0.0, slots.len() as f64];
    for &(act, vis, gid) in slots {
        a.push(f(u32::from(act) | (u32::from(vis) << 1)));
        a.push(f(gid));
    }
    a.push(f(SEC_END));
    a
}

#[test]
fn structure_mirrors_threes_id_allocation() {
    let mut w = World::new();
    let s = ev(&[
        &[f(OP_TRACK), 1.0, f(KIND_CHUNK), -1.0, -1.0],
        &[f(OP_GEOM_ADD), 1.0, 0.0, 0.0, 9.0],
        &[f(OP_INST_ADD), 1.0, 0.0, 0.0],
        &[f(OP_INST_ADD), 1.0, 1.0, 0.0],
        &[f(OP_INST_ADD), 1.0, 2.0, 0.0],
        &[f(OP_INST_DEL), 1.0, 1.0],
        &[f(OP_INST_ADD), 1.0, 1.0, 0.0], // the freed id comes back first
    ]);
    assert_eq!(w.apply(&s), Ok(7));
    assert_eq!(w.integrity_total(), 0);
    // An id three would not have handed out is counted.
    assert_eq!(w.apply(&[f(OP_INST_ADD), 1.0, 9.0, 0.0]), Ok(1));
    assert_eq!(w.integrity()[ik::SLOT_DESYNC], 1);
    let o = w.object(1).expect("tracked");
    assert_eq!(o.slots.len(), 10);
    assert!(!o.slots[5].active && !o.free.contains(&5), "a gap is not free");
}

#[test]
fn a_geometry_delete_after_its_cascade_is_clean_and_a_missed_cascade_is_counted() {
    let mut w = World::new();
    let s = ev(&[
        &[f(OP_TRACK), 1.0, f(KIND_CHUNK), -1.0, -1.0],
        &[f(OP_GEOM_ADD), 1.0, 0.0, 0.0, 9.0],
        &[f(OP_GEOM_ADD), 1.0, 1.0, 9.0, 6.0],
        &[f(OP_INST_ADD), 1.0, 0.0, 0.0],
        &[f(OP_INST_ADD), 1.0, 1.0, 1.0],
        &[f(OP_INST_DEL), 1.0, 0.0], // three's deleteGeometry → deleteInstance
        &[f(OP_GEOM_DEL), 1.0, 0.0],
    ]);
    assert_eq!(w.apply(&s), Ok(7));
    assert_eq!(w.integrity_total(), 0);
    assert_eq!(w.apply(&[f(OP_GEOM_DEL), 1.0, 1.0]), Ok(1)); // instance 1 still uses gid 1
    assert_eq!(w.integrity()[ik::CASCADE_MISS], 1);
    assert!(!w.object(1).unwrap().slots[1].active);
    assert_eq!(w.object(1).unwrap().next_geometry_id(), 0);
}

#[test]
fn landblock_seams_reach_exactly_their_attributed_instances() {
    let mut w = World::new();
    let lb_a = 0x1010_0000u32;
    let lb_b = 0x1110_0000u32;
    let s = ev(&[
        &[f(OP_TRACK), 1.0, f(KIND_CHUNK), -1.0, -1.0],
        &[f(OP_TRACK), 2.0, f(KIND_ATLAS), -1.0, -1.0],
        &[f(OP_GEOM_ADD), 1.0, 0.0, 0.0, 3.0],
        &[f(OP_GEOM_ADD), 2.0, 0.0, 0.0, 3.0],
        &[f(OP_INST_ADD), 1.0, 0.0, 0.0],
        &[f(OP_ATTR_LB), 1.0, 0.0, f(lb_a)],
        &[f(OP_INST_ADD), 1.0, 1.0, 0.0],
        &[f(OP_ATTR_LB), 1.0, 1.0, f(lb_b)],
        &[f(OP_INST_ADD), 2.0, 0.0, 0.0],
        &[f(OP_ATTR_LB), 2.0, 0.0, f(lb_a)],
        &[f(OP_LB_VIS), f(KIND_CHUNK), f(lb_a), 0.0], // the chunk seam: only chunk instances of lb_a
    ]);
    assert_eq!(w.apply(&s), Ok(11));
    let c = w.object(1).unwrap();
    let a = w.object(2).unwrap();
    assert!(!c.slots[0].vis && c.slots[1].vis && a.slots[0].vis);
    // The audit against three: chunk 0 hidden (and the raw mirror never saw a
    // setVisibleAt, so raw disagrees: what the bridge's INST_VIS_RAW is for).
    let arena = objects_arena(1, &[(true, false, 0), (true, true, 0)]);
    let m = w.audit(&arena).expect("well formed");
    assert_eq!(w.last_audit().cat[mk::VIS], 0);
    assert_eq!(w.last_audit().cat[mk::RAW], 1);
    assert_eq!(w.last_audit().cat[mk::MISSING_OBJECT], 1, "object 2 is not in this arena");
    assert_eq!(m, 2);
}

#[test]
fn pools_commit_parked_and_honour_landblock_and_cell_hides() {
    let mut w = World::new();
    let reg = 9.0;
    let lb = 0x2020_0000u32;
    let tile = tile_key_of_lb_key(lb);
    let cell = 0x2020_0101u32;
    let s = ev(&[
        &[f(OP_TRACK), 1.0, f(KIND_POOL), -1.0, reg],
        &[f(OP_GEOM_ADD), 1.0, 0.0, 0.0, 3.0],
        &[f(OP_INST_ADD), 1.0, 0.0, 0.0],
        &[f(OP_INST_VIS_RAW), 1.0, 0.0, 0.0],
        &[f(OP_POOL_ATTR), 1.0, 0.0, f(tile), f(lb), -1.0],
        &[f(OP_INST_ADD), 1.0, 1.0, 0.0],
        &[f(OP_INST_VIS_RAW), 1.0, 1.0, 0.0],
        &[f(OP_POOL_ATTR), 1.0, 1.0, f(tile), f(lb), f(cell)],
        &[f(OP_POOL_PARK), reg, f(tile)], // parked while the plan feeds
        &[f(OP_POOL_COMMIT), reg, f(tile), 1.0, 1.0, 2.0, 0.0, 1.0],
    ]);
    assert_eq!(w.apply(&s), Ok(10));
    let o = w.object(1).unwrap();
    assert!(o.slots.iter().all(|s| s.committed && !s.vis), "committed INTO the parked state");
    assert_eq!(w.apply(&ev(&[&[f(OP_POOL_HIDE_LB), reg, f(lb)], &[f(OP_POOL_ADOPT), reg, f(tile)]])), Ok(2));
    assert!(w.object(1).unwrap().slots.iter().all(|s| !s.vis), "the landblock hide outranks the adopt");
    assert_eq!(w.apply(&ev(&[&[f(OP_POOL_CELLS_VIS), reg, 0.0, 1.0, f(cell)], &[f(OP_POOL_SHOW_LB), reg, f(lb)]])), Ok(2));
    let o = w.object(1).unwrap();
    assert!(o.slots[0].vis && !o.slots[1].vis && o.slots[1].hidden_cell, "the hidden cell stays hidden");
    assert_eq!(w.and_divergence(), 0, "pools are AND-consistent");
    assert_eq!(w.integrity_total(), 0);
}

#[test]
fn residency_tables_and_the_grids_transition_table() {
    let mut w = World::new();
    let s = ev(&[
        &[f(OP_LRU_TRACK), 1.0, 5.0, 0.0],
        &[f(OP_LRU_PARK), 1.0, 5.0],
        &[f(OP_LRU_TRACK), 1.0, 5.0, 1.0], // a late bake merged into the parked copy
        &[f(OP_LRU_UNPARK), 1.0, 5.0],
        &[f(OP_LRU_EVICT), 1.0, 5.0],
        &[f(OP_TILE_STATE), 2.0, 7.0, f(TS_EMPTY), f(TS_STAGED), 10.0, 0.0],
        &[f(OP_TILE_STATE), 2.0, 7.0, f(TS_STAGED), f(TS_LIVE), 20.0, 0.0],
        &[f(OP_TILE_STATE), 2.0, 7.0, f(TS_LIVE), f(TS_PARKED), 30.0, 30.0],
    ]);
    assert_eq!(w.apply(&s), Ok(8));
    assert_eq!(w.integrity_total(), 0);
    assert!(w.lrus[&1].is_empty());
    assert_eq!(w.grids[&2][&7], TileRec { state: TS_PARKED, since: 30.0, parked: 30.0 });
    assert_eq!(w.apply(&[f(OP_TILE_STATE), 2.0, 7.0, f(TS_PARKED), f(TS_STAGED), 40.0, 0.0]), Ok(1));
    assert_eq!(w.integrity()[ik::ILLEGAL_TRANSITION], 1);
    let arena = [f(SEC_GRID), 2.0, 1.0, 7.0, f(TS_STAGED), 40.0, 0.0, f(SEC_LRU), 1.0, 0.0, 0.0, f(SEC_END)];
    assert_eq!(w.audit(&arena), Some(0));
    let stale = [f(SEC_GRID), 2.0, 1.0, 7.0, f(TS_STAGED), 41.0, 0.0, f(SEC_END)];
    assert_eq!(w.audit(&stale), Some(1));
    assert_eq!(w.last_audit().cat[mk::TILE_TIME], 1);
}

#[test]
fn malformed_input_is_refused_not_guessed() {
    let mut w = World::new();
    assert_eq!(w.apply(&[f(OP_TRACK), 1.0, 1.0]), Err(0));
    assert_eq!(w.apply(&[77.0, 1.0]), Err(0));
    assert_eq!(w.apply(&[f(OP_MARK), 1.0, f(OP_DISPOSE)]), Err(2), "the MARK applied, the truncated DISPOSE did not");
    assert_eq!(w.audit(&[f(SEC_OBJECTS), 1.5]), None);
    assert_eq!(w.audit(&[42.0]), None);
    assert_eq!(w.audit(&[f(SEC_LRU), 1.0]), None);
    // A huge id gap is a bad field, never an allocation.
    let mut w = World::new();
    assert_eq!(w.apply(&ev(&[&[f(OP_TRACK), 1.0, 1.0, -1.0, -1.0], &[f(OP_INST_ADD), 1.0, 4.0e9, 0.0]])), Ok(2));
    assert_eq!(w.integrity()[ik::BAD_FIELD], 1);
    assert!(w.object(1).unwrap().slots.is_empty());
}

#[test]
fn census_and_report_json_shapes() {
    let mut w = World::new();
    let s = ev(&[
        &[f(OP_TRACK), 1.0, f(KIND_CHUNK), -1.0, -1.0],
        &[f(OP_GEOM_ADD), 1.0, 0.0, 0.0, 3.0],
        &[f(OP_INST_ADD), 1.0, 0.0, 0.0],
        &[f(OP_ATTR_LB), 1.0, 0.0, 65536.0],
        &[f(OP_OBJR_HIDE), 3.0, 65536.0],
    ]);
    assert_eq!(w.apply(&s), Ok(5));
    assert_eq!(
        w.census_json(),
        "{\"objects\":1,\"byKind\":{\"1\":{\"objects\":1,\"slots\":1,\"active\":1,\"visible\":1}},\"slots\":1,\"active\":1,\"visible\":1,\"attributed\":1,\"committed\":0,\"geometries\":1,\"lbIndex\":1,\"tileIndex\":0,\"cellIndex\":0,\"lru\":{\"live\":0,\"parked\":0},\"tiles\":{},\"pools\":{\"regs\":0,\"parkedTiles\":0,\"hiddenLbs\":0,\"records\":0},\"objrHidden\":1,\"cells\":0}"
    );
    assert_eq!(w.and_divergence(), 1, "objRadius hides the landblock; nothing hid the instance");
    let r = w.report_json();
    assert!(r.starts_with("{\"abi\":1,\"events\":5,"), "{r}");
    assert!(r.contains("\"integrityTotal\":0}"), "{r}");
    assert!(r.contains("\"cat\":{\"unknownObject\":0,"), "{r}");
}

// ── 2026-10-29 (lane W review r2): rules no fixture reached, and the
//    poolHideOrphan cross-check. Each stream was first run through the JS model
//    and (the existing rules) the compiled SceneWorld with the same asserts. ──

#[test]
fn the_cell_pvs_delta_and_its_audit_section() {
    let mut w = World::new();
    let (a, b, c, d) = (0x01d9_0100u32, 0x01d9_0101u32, 0x01d9_0102u32, 0x01d9_0105u32);
    let s = ev(&[
        &[f(OP_CELL_PVS), 7.0, 3.0, f(a), f(b), f(c), 0.0], // a, b, c enter
        &[f(OP_CELL_PVS), 7.0, 1.0, f(d), 2.0, f(a), f(b)], // d enters, a and b leave
    ]);
    assert_eq!(w.apply(&s), Ok(2));
    assert_eq!(w.integrity_total(), 0);
    assert_eq!(w.census().cells, 2);
    assert_eq!(w.cells[&7].iter().copied().collect::<Vec<u32>>(), vec![c, d]);
    assert_eq!(w.audit(&[f(SEC_CELLS), 7.0, 2.0, f(c), f(d), f(SEC_END)]), Some(0));
    // The JS set holds a where the kernel holds d: one each way.
    assert_eq!(w.audit(&[f(SEC_CELLS), 7.0, 2.0, f(c), f(a), f(SEC_END)]), Some(2));
    assert_eq!(w.last_audit().cat[mk::CELLS], 2);
    // A scene the kernel never heard of: every listed cell is JS-only.
    assert_eq!(w.audit(&[f(SEC_CELLS), 8.0, 1.0, f(a), f(SEC_END)]), Some(1));
    assert_eq!(w.last_audit().cat[mk::CELLS], 1);
    // An OBJR section never reads the cell table (and vice versa).
    assert_eq!(w.audit(&[f(SEC_OBJR), 7.0, 2.0, f(c), f(d), f(SEC_END)]), Some(2));
    assert_eq!((w.last_audit().cat[mk::OBJR], w.last_audit().cat[mk::CELLS]), (2, 0));
    // A truncated section is refused.
    assert_eq!(w.audit(&[f(SEC_CELLS), 7.0, 3.0, f(c), f(d)]), None);
}

#[test]
fn a_late_track_snapshots_threes_tables_and_free_lists() {
    let mut w = World::new();
    let s = ev(&[
        &[f(OP_TRACK), 1.0, f(KIND_CHUNK), -1.0, -1.0],
        &[f(OP_GEOM_SNAP), 1.0, 0.0, 1.0, 0.0, 9.0],
        &[f(OP_GEOM_SNAP), 1.0, 1.0, 0.0, 9.0, 3.0], // deleted before the track: free
        &[f(OP_GEOM_SNAP), 1.0, 2.0, 1.0, 12.0, 3.0],
        &[f(OP_INST_SNAP), 1.0, 0.0, 1.0, 0.0, 1.0],
        &[f(OP_INST_SNAP), 1.0, 1.0, 0.0, 0.0, 1.0], // deleted before the track: free
        &[f(OP_INST_SNAP), 1.0, 2.0, 1.0, 2.0, 0.0], // hidden
    ]);
    assert_eq!(w.apply(&s), Ok(7));
    assert_eq!(w.integrity_total(), 0);
    let o = w.object(1).expect("tracked");
    assert_eq!((o.slots.len(), o.geoms.len()), (3, 3));
    assert!(o.slots[0].active && o.slots[0].vis && o.slots[0].raw);
    assert!(!o.slots[1].active && o.free.contains(&1));
    assert!(o.slots[2].active && !o.slots[2].vis && !o.slots[2].raw && o.slots[2].gid == 2);
    assert!(!o.geoms[1].active && o.free_geoms.contains(&1));
    assert_eq!((o.next_instance_id(), o.next_geometry_id()), (1, 1));
    assert_eq!(w.audit(&objects_arena(1, &[(true, true, 0), (false, true, 0), (true, false, 2)])), Some(0));
    // three hands the freed ids out first: predicted, no desync.
    let s = ev(&[
        &[f(OP_INST_ADD), 1.0, 1.0, 0.0],
        &[f(OP_GEOM_ADD), 1.0, 1.0, 15.0, 3.0],
        &[f(OP_INST_ADD), 1.0, 3.0, 1.0],
    ]);
    assert_eq!(w.apply(&s), Ok(3));
    assert_eq!(w.integrity_total(), 0);
    // A snapshot over a live, attributed slot drops its old attribution.
    assert_eq!(w.apply(&[f(OP_ATTR_LB), 1.0, 0.0, 65536.0]), Ok(1));
    assert_eq!(w.census().lb_index, 1);
    assert_eq!(w.apply(&[f(OP_INST_SNAP), 1.0, 0.0, 1.0, 0.0, 1.0]), Ok(1));
    assert_eq!(w.census().lb_index, 0);
    assert_eq!(w.integrity_total(), 0);
}

#[test]
fn lru_drop_pool_ends_the_dual_state_live() {
    let mut w = World::new();
    let (lb, lb2, lb3) = (0x1010_0000u32, 0x1110_0000u32, 0x1210_0000u32);
    let s = ev(&[&[f(OP_LRU_TRACK), 3.0, f(lb), 0.0], &[f(OP_LRU_PARK), 3.0, f(lb)], &[f(OP_LRU_DROP_POOL), 3.0, f(lb)]]);
    assert_eq!(w.apply(&s), Ok(3));
    assert_eq!(w.integrity_total(), 0);
    assert_eq!(w.lrus[&3][&lb], LRU_LIVE);
    // The product path (landblock_lru.js park → _discardStalePoolCopy): a track
    // while parked leaves the landblock in entries AND parkPool...
    let s = ev(&[&[f(OP_LRU_TRACK), 3.0, f(lb2), 0.0], &[f(OP_LRU_PARK), 3.0, f(lb2)], &[f(OP_LRU_TRACK), 3.0, f(lb2), 0.0]]);
    assert_eq!(w.apply(&s), Ok(3));
    assert_eq!(w.integrity()[ik::TRACK_WHILE_PARKED], 1);
    assert_eq!(w.audit(&[f(SEC_LRU), 3.0, 2.0, f(lb), f(lb2), 1.0, f(lb2), f(SEC_END)]), Some(1));
    assert_eq!(w.last_audit().cat[mk::LRU], 1, "the dual state is one lru mismatch");
    // ...and the stale pool copy's drop ends it LIVE.
    assert_eq!(w.apply(&[f(OP_LRU_DROP_POOL), 3.0, f(lb2)]), Ok(1));
    assert_eq!(w.lrus[&3][&lb2], LRU_LIVE);
    assert_eq!(w.audit(&[f(SEC_LRU), 3.0, 2.0, f(lb), f(lb2), 0.0, f(SEC_END)]), Some(0));
    // A drop for a landblock this LRU never tracked lands LIVE too, uncounted.
    assert_eq!(w.apply(&[f(OP_LRU_DROP_POOL), 3.0, f(lb3)]), Ok(1));
    assert_eq!(w.lrus[&3].get(&lb3), Some(&LRU_LIVE));
    assert_eq!(w.integrity_total(), 1);
}

#[test]
fn pool_hide_orphans_are_cross_checked_against_the_objr_sets() {
    let mut w = World::new();
    let (reg, scene) = (9.0, 3.0);
    let (lb_a, lb_b) = (0x2020_0000u32, 0x2120_0000u32);
    // object_radius.js `_hide`: the registry's sticky copy, then objRadius's own.
    let s = ev(&[
        &[f(OP_POOL_HIDE_LB), reg, f(lb_a)],
        &[f(OP_OBJR_HIDE), scene, f(lb_a)],
        &[f(OP_POOL_HIDE_LB), reg, f(lb_b)],
        &[f(OP_OBJR_HIDE), scene, f(lb_b)],
    ]);
    assert_eq!(w.apply(&s), Ok(4));
    let arena = |pool: &[u32], objr: &[u32]| -> Vec<f64> {
        let mut a = vec![f(SEC_POOLREG), reg, 0.0, pool.len() as f64];
        a.extend(pool.iter().map(|&v| f(v)));
        a.extend([f(SEC_OBJR), scene, objr.len() as f64]);
        a.extend(objr.iter().map(|&v| f(v)));
        a.push(f(SEC_END));
        a
    };
    assert_eq!(w.audit(&arena(&[lb_a, lb_b], &[lb_a, lb_b])), Some(0));
    // The forget as it was before 2026-10-29: objRadius forgets lb_a (evicted),
    // the registry keeps its copy. Both mirrors agree with their JS tables, so
    // only the cross-check sees it.
    assert_eq!(w.apply(&[f(OP_OBJR_FORGET), scene, f(lb_a)]), Ok(1));
    assert_eq!(w.audit(&arena(&[lb_a, lb_b], &[lb_b])), Some(1));
    assert_eq!(w.last_audit().cat[mk::POOL_HIDE_ORPHAN], 1);
    assert_eq!(w.last_audit().cat[mk::OBJR] + w.last_audit().cat[mk::POOL_REG], 0);
    assert!(w.last_audit().samples[0].contains("no ?objRadius set hides"), "{:?}", w.last_audit().samples);
    // The fixed forget lifts the registry's copy too (its POOL_SHOW_LB).
    assert_eq!(w.apply(&[f(OP_POOL_SHOW_LB), reg, f(lb_a)]), Ok(1));
    assert_eq!(w.audit(&arena(&[lb_b], &[lb_b])), Some(0));
    // Section order is free: the scene's OBJR may come before the registry.
    let objr_first = [f(SEC_OBJR), scene, 0.0, f(SEC_POOLREG), reg, 0.0, 1.0, f(lb_b), f(SEC_END)];
    assert_eq!(w.audit(&objr_first), Some(2));
    assert_eq!((w.last_audit().cat[mk::OBJR], w.last_audit().cat[mk::POOL_HIDE_ORPHAN]), (1, 1));
    // Any scene's OBJR set counts (the union); a scene with an empty set is fine.
    let two_scenes = [f(SEC_POOLREG), reg, 0.0, 1.0, f(lb_b), f(SEC_OBJR), scene, 1.0, f(lb_b), f(SEC_OBJR), 4.0, 0.0, f(SEC_END)];
    assert_eq!(w.audit(&two_scenes), Some(0));
    // No OBJR section (?objRadius off, or a registry driven alone): no owner to
    // compare with, nothing counted.
    assert_eq!(w.audit(&[f(SEC_POOLREG), reg, 0.0, 1.0, f(lb_b), f(SEC_END)]), Some(0));
    // One count per registry and landblock: a second registry hiding lb_a too.
    assert_eq!(w.apply(&ev(&[&[f(OP_POOL_HIDE_LB), 10.0, f(lb_a)], &[f(OP_POOL_HIDE_LB), reg, f(lb_a)]])), Ok(2));
    let two_regs = [
        f(SEC_POOLREG), reg, 0.0, 2.0, f(lb_a), f(lb_b),
        f(SEC_POOLREG), 10.0, 0.0, 1.0, f(lb_a),
        f(SEC_OBJR), scene, 1.0, f(lb_b),
        f(SEC_END),
    ];
    assert_eq!(w.audit(&two_regs), Some(2));
    assert_eq!(w.last_audit().cat[mk::POOL_HIDE_ORPHAN], 2);
    assert_eq!(w.integrity_total(), 0);
}

#[test]
fn unknown_objects_and_slot_table_lengths_are_counted() {
    let mut w = World::new();
    let s = ev(&[
        &[f(OP_TRACK), 1.0, f(KIND_CHUNK), -1.0, -1.0],
        &[f(OP_GEOM_ADD), 1.0, 0.0, 0.0, 3.0],
        &[f(OP_INST_ADD), 1.0, 0.0, 0.0],
        &[f(OP_INST_ADD), 1.0, 1.0, 0.0],
    ]);
    assert_eq!(w.apply(&s), Ok(4));
    // An object only the JS lists (handle 99, no slots).
    let a = [f(SEC_OBJECTS), 2.0, 1.0, 0.0, 2.0, 3.0, 0.0, 3.0, 0.0, 99.0, 0.0, 0.0, f(SEC_END)];
    assert_eq!(w.audit(&a), Some(1));
    assert_eq!(w.last_audit().cat[mk::UNKNOWN_OBJECT], 1);
    // three's table one (inactive) slot longer than the kernel's.
    assert_eq!(w.audit(&objects_arena(1, &[(true, true, 0), (true, true, 0), (false, true, 0)])), Some(1));
    assert_eq!(w.last_audit().cat[mk::SLOTS_LEN], 1);
}
