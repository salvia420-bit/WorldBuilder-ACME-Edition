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
