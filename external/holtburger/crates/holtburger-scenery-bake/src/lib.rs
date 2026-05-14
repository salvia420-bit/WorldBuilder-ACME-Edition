//! **Holtburger Scenery Bake** — verbatim Rust port of
//! `ACE.Server.Entity.Scenery.Load` (198 lines).
//!
//! Phase B.2 of the world-completeness method (see
//! `docs/hypotheticalmethod.md`). Turns AC's procedural-scenery
//! channel into an explicit, deterministic placement list. One bake,
//! two consumers: the renderer reads it, the server reads it, both
//! agree by construction.
//!
//! # Determinism contract
//!
//! `bake_landblock` is **deterministic**. Same `(region, landblock,
//! landblock_id, …)` in, byte-identical `Vec<ScenicPlacement>` out,
//! every time, on every machine. This is the load-bearing property of
//! the whole world-completeness method. If it ever wavers the pretence
//! of "explicit placement" breaks.
//!
//! See `tests::determinism_repeat` for the 100-iteration stress test
//! that guards this contract.
//!
//! # Source mapping
//!
//! - Main loop:    `Scenery.cs:16-91`  → `bake_landblock`
//! - `Displace`:   `Scenery.cs:101-127` → `noise::displace`
//! - `ScaleObj`:   `Scenery.cs:136-150` → `noise::scale_obj`
//! - `RotateObj`:  `Scenery.cs:155-161` → `noise::rotate_obj`
//! - `OnRoad`:     `Scenery.cs:166-172` → `height::on_road`
//! - `Collision`:  `Scenery.cs:177-184` → `noise::intersects_any`
//! - `GetZ`:       `Scenery.cs:189-196` → `height::bilinear_height`
//!
//! # Caller contract for the closures
//!
//! - `fetch_scene(scene_id)` — must return the `Scene` for the given
//!   `0x12xxxxxx` DID, or `None` if the scene isn't found. The bake
//!   skips vertices whose scene can't be loaded.
//! - `fetch_obj_bounds(obj_id)` — must return the mesh-local AABB for
//!   the placement's mesh, or `None` if bounds aren't known. The bake
//!   skips placements without bounds (no collision basis).
//!
//! `building_aabbs` is supplied by the caller; the bake doesn't load
//! `LandblockInfo.objects` itself. Caller is responsible for
//! pre-computing the world-frame XY AABB of every building on the LB
//! using the same transform we apply to scenery (`transform_local_aabb`).

#![forbid(unsafe_code)]

pub mod aabb;
pub mod height;
pub mod noise;

pub use aabb::{Aabb2D, LocalBounds, transform_local_aabb};
pub use height::{
    CELL_SIZE, LANDBLOCK_SIZE, VERTEX_DIM, bilinear_height, bilinear_height_from_grid, slope_at,
    vertex_heights,
};
pub use noise::{
    NOISE_SCALE, cell_mat_scene, cell_mats_per_object, displace, object_noise, rotate_obj,
    scale_obj,
};

use holtburger_dat::file_type::Region;
use holtburger_dat::file_type::Scene;
use holtburger_dat::landblock::CellLandblock;

/// One baked scenery placement. Emitted by `bake_landblock`.
///
/// Coordinates `(x, y, z)` are LB-local, `[0, 192]` on each axis for
/// XY. The quaternion is yaw-only-about-Z: `w = cos(rad/2)`, `z =
/// sin(rad/2)` (XY are always 0). Matches ACE's `Quaternion.
/// CreateFromYawPitchRoll(0, 0, RotateObj(...))` — verified against
/// .NET reference source: yaw=pitch=0 reduces the quaternion to a
/// pure roll-about-Z rotation, which is `(cos(r/2), 0, 0, sin(r/2))`
/// in (w, x, y, z) order.
///
/// `source_*` fields are debug-only: they say WHY a placement exists.
/// Useful for "the lifestone is missing — which vertex/scene/index
/// dropped it?".
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScenicPlacement {
    /// GfxObj (`0x01xxxxxx`) or SetupModel (`0x02xxxxxx`) DID.
    pub obj_id: u32,
    /// LB-local X position, `[0, 192]`.
    pub x: f32,
    /// LB-local Y position, `[0, 192]`.
    pub y: f32,
    /// Snapped terrain Z (bilinear from CellLandblock heightmap).
    pub z: f32,
    pub qw: f32,
    pub qx: f32,
    pub qy: f32,
    pub qz: f32,
    /// Uniform scale factor — typically in `[0.5, 2.0]` after the
    /// `pow(max/min, noise) * min` formula clamps it.
    pub scale: f32,
    /// Debug attribution: which vertex sourced this placement.
    pub source_cell_x: u32,
    pub source_cell_y: u32,
    /// Index into `Scene.objects` of the `ObjectDesc` that emitted
    /// this placement.
    pub source_obj_idx: u32,
}

/// Run the scenery bake for one landblock.
///
/// # Determinism
///
/// Output is deterministic in the inputs. The closures `fetch_scene`
/// and `fetch_obj_bounds` MUST themselves be deterministic — i.e.
/// repeated calls with the same arguments must return identical
/// results. Otherwise downstream determinism is lost.
///
/// # Arguments
///
/// - `region` — Region `0x13000000` (LandDefs + TerrainInfo + SceneInfo).
/// - `landblock` — `CellLandblock` for this LB (81 terrain words + 81
///   height bytes).
/// - `landblock_id` — packed `(lbX << 24) | (lbY << 16)`.
/// - `fetch_scene` — closure to resolve a `0x12xxxxxx` Scene DID to
///   its parsed `Scene`. Caller owns DAT access.
/// - `fetch_obj_bounds` — closure to resolve a placement mesh's
///   local-frame AABB. Used for collision rejection.
/// - `building_aabbs` — world-frame XY AABBs of all buildings on this
///   LB (from `LandblockInfo.objects`). Caller is responsible for
///   transforming each building's mesh-local AABB into the LB-local
///   2D frame before passing.
pub fn bake_landblock(
    region: &Region,
    landblock: &CellLandblock,
    landblock_id: u32,
    mut fetch_scene: impl FnMut(u32) -> Option<Scene>,
    mut fetch_obj_bounds: impl FnMut(u32) -> Option<LocalBounds>,
    building_aabbs: &[Aabb2D],
) -> Vec<ScenicPlacement> {
    // Scenery.cs:21-22: get landblock cell offsets.
    let block_x: u32 = (landblock_id >> 24).wrapping_mul(8);
    let block_y: u32 = ((landblock_id >> 16) & 0xFF).wrapping_mul(8);

    // SceneInfo is optional in our schema (only present if
    // PARTS_MASK_HAS_SCENE_INFO is set). Real Region 0x13 has it, but
    // synthetic test fixtures may not — short-circuit cleanly.
    let scene_info = match region.scene_info.as_ref() {
        Some(s) => s,
        None => return Vec::new(),
    };

    // Pre-resolve the height grid once — saves 81 × N(candidates)
    // table lookups in the hot loop.
    let heights = vertex_heights(region, landblock);

    let mut scenery: Vec<ScenicPlacement> = Vec::new();
    let mut placed_aabbs: Vec<Aabb2D> = Vec::new();

    // Scenery.cs:26 — walk all 81 vertices.
    for i in 0..landblock.terrain.len() {
        let terrain_word: u16 = landblock.terrain[i];
        // Scenery.cs:30 — bits 2..6 (5 bits → 0..31).
        let terrain_type: usize = ((terrain_word >> 2) & 0x1F) as usize;
        // Scenery.cs:31 — bits 11..15 (5 bits → 0..31). Note ACE
        // documents `terrain >> 11` without an explicit 5-bit mask; a
        // u16 right-shifted by 11 yields a 5-bit value already since
        // there's no sign extension on unsigned types.
        let scene_type: usize = (terrain_word >> 11) as usize;

        // Scenery.cs:33 — resolve terrain_type → scene_info index.
        // Bounds-guard: real DATs only ever index 0..32 for both
        // terrain_type and scene_type, but synthetic fixtures may not
        // populate the full 32×32 table.
        let tt = match region.terrain_info.terrain_types.get(terrain_type) {
            Some(t) => t,
            None => continue,
        };
        let scene_info_idx = match tt.scene_types.get(scene_type) {
            Some(&idx) => idx as usize,
            None => continue,
        };
        // Scenery.cs:34 — resolve scene_info index → list of Scene DIDs.
        let scenes = match scene_info.scene_types.get(scene_info_idx) {
            Some(s) => &s.scenes,
            None => continue,
        };
        // Scenery.cs:35 — short-circuit empty bucket.
        if scenes.is_empty() {
            continue;
        }

        // Scenery.cs:37-41 — local + global cell coords.
        let cell_x = (i / VERTEX_DIM) as u32;
        let cell_y = (i % VERTEX_DIM) as u32;
        let global_cell_x = cell_x.wrapping_add(block_x);
        let global_cell_y = cell_y.wrapping_add(block_y);

        // Scenery.cs:43-46 — pick the Scene via deterministic noise.
        let cell_mat_initial = cell_mat_scene(global_cell_x, global_cell_y);
        let offset: f64 = cell_mat_initial as f64 * NOISE_SCALE;
        let mut scene_idx = (scenes.len() as f64 * offset) as usize;
        if scene_idx >= scenes.len() {
            scene_idx = 0;
        }
        let scene_id = scenes[scene_idx];

        // Scenery.cs:50 — load the Scene via the closure.
        let scene = match fetch_scene(scene_id) {
            Some(s) => s,
            None => continue,
        };

        // Scenery.cs:52-54 — reset PRNG state for the per-object loop.
        let (cell_x_mat, cell_y_mat, cell_mat) = cell_mats_per_object(global_cell_x, global_cell_y);

        // Scenery.cs:56-88 — emit per-object placements.
        for (j, obj) in scene.objects.iter().enumerate() {
            let j_u32 = j as u32;

            // Scenery.cs:59 — per-object noise sample.
            let noise = object_noise(cell_x_mat, cell_y_mat, cell_mat);

            // Scenery.cs:61 — gate on freq + skip weenie-managed entities.
            if !(noise < obj.freq as f64) || obj.weenie_obj != 0 {
                continue;
            }

            // Scenery.cs:63 — apply displacement noise.
            let (dx, dy) = displace(obj, global_cell_x, global_cell_y, j_u32);

            // Scenery.cs:66-67 — translate to LB-local frame.
            let lx = cell_x as f32 * CELL_SIZE + dx;
            let ly = cell_y as f32 * CELL_SIZE + dy;

            // Scenery.cs:70 — reject out-of-LB placements + road overlap.
            if lx < 0.0 || ly < 0.0 || lx > LANDBLOCK_SIZE || ly > LANDBLOCK_SIZE {
                continue;
            }
            if height::on_road(landblock, lx, ly) {
                continue;
            }

            // Slope rejection — Scenery.cs has a `TODO: ensure
            // walkable slope` here. We implement it; min_slope and
            // max_slope are in radians per ObjectDesc.cs.
            let slope = height::slope_at(&heights, lx, ly);
            if slope < obj.min_slope || slope > obj.max_slope {
                continue;
            }

            // Scenery.cs:76 — Z-snap to bilinear-interpolated terrain.
            let z = height::bilinear_height_from_grid(&heights, lx, ly);

            // Scenery.cs:77 — rotation about Z.
            let rotation_rad = rotate_obj(obj, global_cell_x, global_cell_y, j_u32);
            // Yaw-only-about-Z quaternion. .NET reference:
            //   CreateFromYawPitchRoll(0, 0, r)
            // = (cos(r/2), 0, 0, sin(r/2)) in (w, x, y, z) order.
            let half = rotation_rad * 0.5;
            let qw = half.cos();
            let qz = half.sin();

            // Scenery.cs:78 — uniform scale.
            let scale = scale_obj(obj, global_cell_x, global_cell_y, j_u32);

            // Scenery.cs:80 + 83-84 — bounding box + collision reject.
            let local_bounds = match fetch_obj_bounds(obj.obj_id) {
                Some(b) => b,
                None => continue,
            };
            let world_aabb = transform_local_aabb(local_bounds, lx, ly, rotation_rad, scale);

            if noise::intersects_any(&world_aabb, building_aabbs) {
                continue;
            }
            if noise::intersects_any(&world_aabb, &placed_aabbs) {
                continue;
            }

            // Accept the placement.
            placed_aabbs.push(world_aabb);
            scenery.push(ScenicPlacement {
                obj_id: obj.obj_id,
                x: lx,
                y: ly,
                z,
                qw,
                qx: 0.0,
                qy: 0.0,
                qz,
                scale,
                source_cell_x: cell_x,
                source_cell_y: cell_y,
                source_obj_idx: j_u32,
            });
        }
    }

    scenery
}
