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
//! - `compute_world_aabb(params)` — must return the world-frame XY
//!   AABB for the placement, computed by transforming the mesh's
//!   vertices through ACE's `scale * yaw * cellTranslate * inner`
//!   stack (see [`aabb::transform_mesh_to_aabb`] for the canonical
//!   helper). Returns `None` when the mesh can't be loaded; the bake
//!   skips placements without a usable AABB (no collision basis).
//!
//! `building_aabbs` is supplied by the caller; the bake doesn't load
//! `LandblockInfo` itself. Caller is responsible for pre-computing the
//! world-frame XY AABB of every entry in `LandblockInfo.Buildings`
//! (NOT `Objects` — ACE's `Landblock.init_buildings` populates the
//! collision-blocker list from Buildings alone; see
//! `~/ace-server/Source/ACE.Server/Physics/Common/Landblock.cs:438`
//! and `Scenery.cs:83`) using the same per-vertex transform.

#![forbid(unsafe_code)]

pub mod aabb;
pub mod height;
pub mod noise;

pub use aabb::{Aabb2D, LocalBounds, transform_local_aabb, transform_mesh_to_aabb};
pub use height::{
    CELL_SIZE, LANDBLOCK_SIZE, VERTEX_DIM, bilinear_height, bilinear_height_from_grid,
    get_split_dir, normal_z_at, slope_at, triangle_plane_height_from_grid, vertex_heights,
};
pub use noise::{
    NOISE_SCALE, cell_mat_scene, cell_mats_per_object, displace, object_noise, rotate_obj,
    scale_obj,
};

use holtburger_dat::file_type::Region;
use holtburger_dat::file_type::Scene;
use holtburger_dat::landblock::CellLandblock;

/// Bake-mode toggle for two deliberately-different placement contracts.
///
/// The B.2 / B.3 implementation diverged from ACE in two places. For
/// each divergence the ACE behaviour is one mode and the
/// renderer-friendly behaviour is the other:
///
/// | Concern | `AceCompat` (default) | `Strict` |
/// |---|---|---|
/// | Z snap | Triangle-plane via [`triangle_plane_height_from_grid`] — mirrors `LandblockMesh.GetZ` per-cell triangulation. | Bilinear via [`bilinear_height_from_grid`] — matches `holtburger_world` and the live renderer. |
/// | Slope rejection | Skipped — `Scenery.cs:69` has it as `TODO: ensure walkable slope` so ACE doesn't reject. | Implemented — rejects placements whose terrain-normal Z (cos slope) falls outside `[min_slope, max_slope]`, matching retail `ObjectDesc::CheckSlope`. |
///
/// `AceCompat` is the **1:1 Coldeve compatibility** target — what the
/// brief calls the load-bearing requirement. Even when ACE has a TODO or
/// a bug, ACE-compat replays that exact behaviour so that the bake and
/// a live ACE server agree placement-for-placement.
///
/// `Strict` is the **renderer-aligned** target — what we'd want if we
/// were running a clean-slate server with no ACE compatibility needs.
/// It produces a STRICT SUBSET of `AceCompat`'s output (slope rejection
/// removes placements; Z is the only other delta and it doesn't
/// add/remove placements, just shifts them).
///
/// The mode appears in the bake's `bake-source.sha256` sidecar so
/// downstream consumers can refuse to honour a mode they don't expect.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum BakeMode {
    /// **Default.** Match today's ACE behaviour bit-exactly:
    /// triangle-plane Z, no slope check. Use this for ACE-derivative
    /// servers (Coldeve etc.) that want client/server agreement.
    #[default]
    AceCompat,
    /// Renderer-friendly: bilinear Z, slope-rejection ON. Use this for
    /// non-ACE consumers or when you want scenery to land on the same
    /// terrain Z the player physics integrator uses.
    Strict,
}

impl BakeMode {
    /// Stable lowercase identifier for CLI parsing and the
    /// `bake-source.sha256` sidecar.
    pub fn as_str(self) -> &'static str {
        match self {
            BakeMode::AceCompat => "ace-compat",
            BakeMode::Strict => "strict",
        }
    }
}

impl std::str::FromStr for BakeMode {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "ace-compat" | "ace_compat" | "acecompat" => Ok(BakeMode::AceCompat),
            "strict" => Ok(BakeMode::Strict),
            other => Err(format!(
                "unknown BakeMode `{other}` (expected `ace-compat` or `strict`)"
            )),
        }
    }
}

/// Addressable identity for one baked generated-scenery placement.
///
/// Every field is a stable, content-derived key — not a coordinate or
/// an array offset that shifts when an unrelated placement is added or
/// removed. This is the canonical traceability key the
/// explicit-everywhere validator and the (forthcoming) worker-bake
/// merge use to assert "this rendered object IS this baked placement"
/// without reconstructing identity from floating-point positions.
///
/// Identity ONLY: it carries none of the bake's acceptance math and
/// does not influence which placements are emitted. The shape is
/// adopted from upstream (`merklejerk` `static_outdoor_scene.rs`)'s
/// `GeneratedScenery` instance key — the identity struct alone, with
/// none of upstream's divergent placement-acceptance logic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct GeneratedSceneryIdentity {
    /// Packed `(lbX << 24) | (lbY << 16)` of the owning landblock.
    pub landblock_id: u32,
    /// Scene (`0x12xxxxxx`) DID whose `ObjectDesc` produced this placement.
    pub scene_id: u32,
    /// Source terrain-vertex index `0..81` (the loop `i` that sourced it).
    pub terrain_index: u32,
    /// Index of the `ObjectDesc` within `Scene.objects` (the template).
    pub template_index: u32,
    /// The placed GfxObj (`0x01`) / SetupModel (`0x02`) DID.
    pub source_did: u32,
}

impl GeneratedSceneryIdentity {
    /// Canonical, collision-free string key for this placement:
    /// `landblock-static/{landblock_id:08x}/generatedscenery/{scene_id:08x}/{terrain_index}/{template_index}/{source_did:08x}`.
    ///
    /// Stable across re-bakes of the same DAT inputs and unique within a
    /// landblock (the `(terrain_index, template_index)` pair is unique
    /// per emitted placement). Use it as the key when merging the three
    /// placement streams or asserting render/placement traceability.
    pub fn stable_id(&self) -> String {
        format!(
            "landblock-static/{:08x}/generatedscenery/{:08x}/{}/{}/{:08x}",
            self.landblock_id,
            self.scene_id,
            self.terrain_index,
            self.template_index,
            self.source_did
        )
    }
}

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
    /// Addressable identity — the canonical, content-derived
    /// traceability key (see [`GeneratedSceneryIdentity`]). Supersedes
    /// the `source_*` debug fields above and is decoupled from the bake
    /// math (adding it does not change which placements are emitted).
    pub identity: GeneratedSceneryIdentity,
}

/// FNV-1a/64 offset basis. Seed for [`fnv1a_fold`].
pub const FNV1A_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
/// FNV-1a/64 prime multiplier. Used by [`fnv1a_fold`].
pub const FNV1A_PRIME: u64 = 0x0000_0100_0000_01b3;

/// Fold one `u32` word (little-endian bytes) into a running FNV-1a/64
/// hash. The single primitive both the bake-side sidecar emitter and
/// the client-side load-time gate fold through, so a placement's
/// fingerprint is identical bit-for-bit on either side regardless of
/// platform (no `DefaultHasher`, no external dep). Seed with
/// [`FNV1A_OFFSET`].
#[inline]
pub fn fnv1a_fold(mut h: u64, word: u32) -> u64 {
    for byte in word.to_le_bytes() {
        h ^= byte as u64;
        h = h.wrapping_mul(FNV1A_PRIME);
    }
    h
}

/// Canonicalise one f32 into the **exact value the `*.scenery.jsonl`
/// wire carries**, and return its IEEE-754 bits. This is the single
/// load-bearing rule that makes the E5 freeze hash agree across the
/// bake/client boundary.
///
/// The bake serialises every float through `scenery-bake.rs`'s
/// `format_f32_six_sig` — `{:.6}` with a `-0.0 → 0.0` normalisation —
/// which is **lossy** for f32 (round-tripping an arbitrary f32 needs up
/// to 9 significant decimal digits, not 6). The client only ever sees
/// the truncated text and parses it back into a *different* f32 bit
/// pattern (e.g. a `0.7071068` quaternion component round-trips
/// `0x3f3504f4 → "0.707107" → 0x3f3504f7`). So the fingerprint MUST
/// hash the post-truncation value, not the raw in-memory f32, or the
/// advisory gate false-positives on essentially every non-axis-aligned
/// placement.
///
/// This helper formats with the identical `{:.6}` + `-0.0 → 0.0` rule
/// and reparses, yielding the same bits the client reconstructs from
/// the JSONL. It is **idempotent**: applying it to an already-reparsed
/// value is a no-op, so the client can safely canonicalise its parsed
/// fields with the same rule.
#[inline]
pub fn wire_f32_bits(v: f32) -> u32 {
    // Match `format_f32_six_sig`: collapse both zero encodings first so
    // a signed -0.0 hashes identically to +0.0.
    let v = if v == 0.0 { 0.0 } else { v };
    // `{:.6}` is locale-free in Rust (always `.`), so this is byte-
    // stable across machines, and reparsing recovers exactly the f32
    // the client gets from `serde_json`.
    let truncated: f32 = format!("{v:.6}").parse().unwrap_or(v);
    truncated.to_bits()
}

/// Deterministic FNV-1a/64 fingerprint over the FROZEN, explicit
/// placement stream — the **E5 determinism freeze hash**.
///
/// Hashes only the twelve wire-serialised fields of each
/// [`ScenicPlacement`] (the same fields the per-LB `*.scenery.jsonl`
/// carries: `obj_id`, the `(x, y, z)` coordinates, the `(qw, qx, qy,
/// qz)` quaternion, `scale`, and the `source_*` attribution words). The
/// three `u32` words (`obj_id`, `source_*`) round-trip the JSONL
/// exactly and are folded as-is. The nine float words are folded
/// through [`wire_f32_bits`] — the post-`{:.6}`-truncation bits the
/// JSONL actually carries — NOT the full-precision in-memory f32,
/// because the client can only reconstruct the truncated value (see
/// [`wire_f32_bits`] for why hashing the raw f32 false-positives the
/// gate). It deliberately does **not** fold the
/// [`GeneratedSceneryIdentity`] — that key is recomputed from frozen
/// content on load but is not serialised into the JSONL, so the
/// client could not reproduce an identity-inclusive hash. Hashing the
/// shared wire fields lets the bake CLI emit a `placements-hash` line
/// in the per-LB sidecar and the client recompute the SAME value over
/// the loaded placement array.
///
/// This fingerprint is **advisory**: a mismatch means the shipped
/// `*.scenery.jsonl` diverged from what a fresh bake of the same DAT
/// inputs would produce (the "edited noise.rs but forgot to re-bake"
/// trap). It is hashed over the frozen explicit placements only and
/// MUST NEVER be used to trigger a procedural re-derive on load.
pub fn placements_fingerprint(placements: &[ScenicPlacement]) -> u64 {
    let mut h = FNV1A_OFFSET;
    for p in placements {
        for word in [
            p.obj_id,
            wire_f32_bits(p.x),
            wire_f32_bits(p.y),
            wire_f32_bits(p.z),
            wire_f32_bits(p.qw),
            wire_f32_bits(p.qx),
            wire_f32_bits(p.qy),
            wire_f32_bits(p.qz),
            wire_f32_bits(p.scale),
            p.source_cell_x,
            p.source_cell_y,
            p.source_obj_idx,
        ] {
            h = fnv1a_fold(h, word);
        }
    }
    h
}

/// Per-candidate placement transform parameters passed to the bake's
/// AABB-building closure. The closure is expected to load the mesh
/// for `obj_id`, run each vertex through
/// `scale * yaw(rotation_rad) * cellTranslate * translate(lx, ly, lz)`,
/// and return the world-frame XY min/max — exactly what ACE's
/// `BoundingBox.BuildBox` does.
#[derive(Debug, Clone, Copy)]
pub struct PlacementXform {
    /// GfxObj (`0x01xxxxxx`) or SetupModel (`0x02xxxxxx`) DID.
    pub obj_id: u32,
    /// LB-local X (the displaced X in [0, 192]).
    pub lx: f32,
    /// LB-local Y (the displaced Y in [0, 192]).
    pub ly: f32,
    /// World Z snapped to terrain.
    pub lz: f32,
    /// Yaw about Z, in radians.
    pub rotation_rad: f32,
    /// Uniform scale.
    pub scale: f32,
}

/// Run the scenery bake for one landblock.
///
/// # Determinism
///
/// Output is deterministic in the inputs. The closures `fetch_scene`
/// and `compute_world_aabb` MUST themselves be deterministic — i.e.
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
/// - `compute_world_aabb` — closure to return the placement's
///   world-frame XY AABB. Use [`transform_mesh_to_aabb`] inside the
///   closure to match ACE bit-for-bit. Return `None` when the mesh
///   can't be resolved — the bake will skip the placement.
/// - `building_aabbs` — world-frame XY AABBs of all entries in
///   `LandblockInfo.Buildings` on this LB. Caller is responsible for
///   computing each one via the same per-vertex transform. **Do not
///   include `LandblockInfo.Objects`** — ACE's Scenery.Load collides
///   against Buildings only (`Scenery.cs:83` /
///   `Landblock.cs:438`).
pub fn bake_landblock(
    region: &Region,
    landblock: &CellLandblock,
    landblock_id: u32,
    fetch_scene: impl FnMut(u32) -> Option<Scene>,
    compute_world_aabb: impl FnMut(PlacementXform) -> Option<Aabb2D>,
    building_aabbs: &[Aabb2D],
    mode: BakeMode,
) -> Vec<ScenicPlacement> {
    bake_landblock_impl(
        region,
        landblock,
        landblock_id,
        fetch_scene,
        compute_world_aabb,
        building_aabbs,
        mode,
    )
}

fn bake_landblock_impl(
    region: &Region,
    landblock: &CellLandblock,
    landblock_id: u32,
    mut fetch_scene: impl FnMut(u32) -> Option<Scene>,
    mut compute_world_aabb: impl FnMut(PlacementXform) -> Option<Aabb2D>,
    building_aabbs: &[Aabb2D],
    mode: BakeMode,
) -> Vec<ScenicPlacement> {
    // Scenery.cs:21-22: get landblock cell offsets.
    let block_x: u32 = (landblock_id >> 24).wrapping_mul(8);
    let block_y: u32 = ((landblock_id >> 16) & 0xFF).wrapping_mul(8);
    // For triangle-plane Z (AceCompat): pre-pack the LB-id top half
    // exactly the way `LandblockId.LandblockX/Y` reads it. `landblock_id`
    // is `(lb_x << 24) | (lb_y << 16)` so the top 16 bits packed back
    // as `(lb_x << 8) | lb_y` is `landblock_id >> 16`.
    let landblock_id_top_16 = (landblock_id >> 16) as u16;

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

            // Slope rejection — `BakeMode::Strict` enforces it (ACE's
            // `TODO: ensure walkable slope` at Scenery.cs:69 is treated
            // as "fix that someday"); `BakeMode::AceCompat` mirrors ACE
            // verbatim, including the TODO, so the rejection is OFF.
            //
            // W1 fix (2026-05-29): `min_slope`/`max_slope` are NOT
            // radians — they are COSINES of the slope angle (= the
            // terrain plane's `N.z`). Retail `ObjectDesc::CheckSlope`
            // (`acclient.c:351355`) is literally
            //   `z_val >= min_slope && z_val <= max_slope`
            // called with `walkable->plane.N.z` (`acclient.c:352699`),
            // where `N.z` is 1.0 on flat ground and 0.0 on a vertical
            // face. Real DAT `min_slope` values cluster in 0.86–0.98
            // (73.5% of rows), unmistakably cosines. The prior code
            // compared the slope ANGLE (radians) with the inverted
            // inequality (reject `< min || > max`), which is wrong on
            // both axes. Now: compute the terrain-normal Z (cosine) and
            // REJECT when it falls OUTSIDE `[min_slope, max_slope]` —
            // i.e. accept iff CheckSlope would (`N.z >= min && N.z <=
            // max`).
            if matches!(mode, BakeMode::Strict) {
                let normal_z = height::normal_z_at(&heights, lx, ly);
                if normal_z < obj.min_slope || normal_z > obj.max_slope {
                    continue;
                }
            }

            // Scenery.cs:76 — Z-snap. ACE uses `LandblockMesh.GetZ`
            // (triangle-plane per-cell, see `height::triangle_plane_height_from_grid`).
            // `BakeMode::Strict` instead uses bilinear so scenery lands
            // on the same Z the renderer's physics integrator uses.
            let z = match mode {
                BakeMode::AceCompat => height::triangle_plane_height_from_grid(
                    &heights,
                    landblock_id_top_16,
                    lx,
                    ly,
                ),
                BakeMode::Strict => height::bilinear_height_from_grid(&heights, lx, ly),
            };

            // Scenery.cs:77 — rotation about Z.
            let rotation_rad = rotate_obj(obj, global_cell_x, global_cell_y, j_u32);
            // Yaw-only-about-Z quaternion. .NET reference:
            //   CreateFromYawPitchRoll(0, 0, r)
            // = (cos(r/2), 0, 0, sin(r/2)) in (w, x, y, z) order.
            let half = rotation_rad * 0.5;
            // Compute sin/cos in f64 then narrow, to match .NET's f32 sin/cos
            // (CreateFromYawPitchRoll) which does not bit-match scalar glibc
            // `sinf`/`cosf`. `half` stays f32 first (matches ACE `roll * 0.5f`).
            let qw = (half as f64).cos() as f32;
            let qz = (half as f64).sin() as f32;

            // Scenery.cs:78 — uniform scale.
            let scale = scale_obj(obj, global_cell_x, global_cell_y, j_u32);

            // Scenery.cs:80 + 83-84 — bounding box + collision reject.
            // AABB construction matches ACE BoundingBox.BuildBox: walk
            // each mesh vertex through `scale * rotate * cellTranslate
            // * cellTranslateInner` and take XY min/max. Closure owns
            // the mesh cache + the transform — see
            // `apps/holtburger-tools/src/bin/scenery-bake.rs::compute_world_aabb_for`.
            let world_aabb = match compute_world_aabb(PlacementXform {
                obj_id: obj.obj_id,
                lx,
                ly,
                lz: z,
                rotation_rad,
                scale,
            }) {
                Some(a) => a,
                None => continue,
            };

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
                identity: GeneratedSceneryIdentity {
                    landblock_id,
                    scene_id,
                    terrain_index: i as u32,
                    template_index: j_u32,
                    source_did: obj.obj_id,
                },
            });
        }
    }

    scenery
}
