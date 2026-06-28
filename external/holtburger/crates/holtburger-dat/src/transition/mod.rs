//! Retail CLIENT physics — the LEAF layer (geometry primitives + BSP
//! collision predicates) that the later `CTransition` driver (Phase 3)
//! drives. Ported decomp-faithfully from `acclient.c` / `acclient.h`
//! (`CTransition` @52329, `SPHEREPATH` @32625, `OBJECTINFO`/`COLLISIONINFO`
//! @52284/52306, enums @6100..6196).
//!
//! Built ALONGSIDE `crate::physics` (the M1-M4 BSP work) — the leaf
//! methods `use crate::physics::{BspNode, BspLeaf, ResolvedPolygon,
//! PHYSICS_EPSILON}` and the shared geometry from `holtburger_common`.
//!
//! Shared state structs live in [`types`]; the leaf modules reference
//! them via `use super::types::*`.

// The types agent (agent 00) owns this file plus `types.rs`. Each of the
// remaining submodules is authored by a sibling fan-out agent; the driver
// builds the crate once after all of them land.
pub mod types;
pub mod sphere_basics;
pub mod sphere_slide;
pub mod sphere_collide_point;
pub mod sphere_step;
pub mod polygon_hits;
pub mod polygon_walkable;
pub mod polygon_adjust;
pub mod polygon_edge;
pub mod bspnode_solid;
pub mod bspnode_poly;
pub mod bspnode_walkable;
pub mod bsptree_adjust;
pub mod collisioninfo;
pub mod frame_transform;

// Phase-2 resolver layer — the swept-step driver on top of the leaf
// predicates (`BSPTREE::find_collisions` + branch helpers + the SPHEREPATH
// mutators they call). Authored by the Phase-2 fan-out agents (01–06).
pub mod resolver_check_walkable;
pub mod resolver_step_down;
pub mod resolver_slide;
pub mod resolver_collide_pt;
pub mod resolver_find;
pub mod spherepath_methods;

// Phase-3 CELL/OBJECTINFO foundation the `CTransition` driver builds on:
// the `CObjCell` collision abstraction + `CELLARRAY` container/ring assembly
// (`objcell`), and the `OBJECTINFO` walkable validators (`objectinfo`). The
// driver methods (transitional_insert/step_*/check_walkable/insert_into_cell/
// check_other_cells/validate_*) land in a later sub-stage on top of these.
pub mod objcell;
pub mod objectinfo;
