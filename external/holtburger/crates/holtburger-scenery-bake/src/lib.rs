//! **Holtburger Scenery Bake** — turns AC's procedural-scenery channel
//! into an explicit, deterministic placement list. This is Phase B.2 of
//! the world-completeness method (see `docs/hypotheticalmethod.md`).
//!
//! The bake runs in one of three [`BakeMode`]s, and they follow different
//! sources:
//! - `AceCompat` is the default, and every shipped bake uses it. It is a
//!   verbatim port of `ACE.Server.Entity.Scenery.Load` (`Entity/Scenery.cs`,
//!   198 lines). That code is DEAD in ACE: its only caller,
//!   `Entity/Landblock.LoadMeshes`, is commented out
//!   (`Entity/Landblock.cs:197`, and :334 says "This isn't used by ACE").
//!   So it is not what a live ACE server computes.
//! - `Retail` follows `acclient.c` `CLandBlock::get_land_scenes`. Live ACE
//!   physics (`Physics/Common/Landblock.get_land_scenes`) follows the same
//!   rules, except that it scales the noise by ACE's double literal instead
//!   of retail's 2^-32 ([`NOISE_SCALE`] vs [`NOISE_SCALE_RETAIL`]).
//! - `Strict` is a renderer-aligned variant of `AceCompat`.
//!
//! The bake's consumers agree with each other by construction, because
//! they all read the same bake. They are the client renderer, the client's
//! scenery colliders and the rynthnav nav geometry. No server reads the
//! bake. A server agrees with it only as far as the server computes the
//! same placements itself. For live ACE that is close to `Retail`, and
//! `AceCompat` does not match it.
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
//! - Retail frequency gate (`BakeMode::Retail` only): `acclient.c`
//!   `CLandBlock::get_land_scenes` :352662-352731 →
//!   `noise::object_noise_retail`
//! - Retail noise scale (`BakeMode::Retail` only): the exe's float
//!   `0x2F800000` = 2^-32 → [`NOISE_SCALE_RETAIL`] in the gate, the scene
//!   pick (:352639-352645, `noise::scene_index_retail`), `ObjectDesc::Place`
//!   (:462605, `noise::displace_retail`), `ObjectDesc::ScaleObj` (:351361,
//!   `noise::scale_obj_retail`) and `GetObjFrame` (`noise::rotate_obj_retail`)
//! - Retail road band (`BakeMode::Retail` only): `acclient.c`
//!   `CLandBlock::on_road` :352238 → `height::on_road_retail`
//! - Retail acceptance (`BakeMode::Retail` only, via
//!   [`bake_landblock_retail`]): `acclient.c` `CLandBlock::get_land_scenes`
//!   :352673-352718 — strict `< 192` bounds, `CSortCell::has_building` →
//!   [`retail::building_cell_mask`], `ObjectDesc::CheckSlope` on the
//!   walkable triangle → [`retail::check_slope`] +
//!   [`height::triangle_plane_from_grid`], `CPhysicsObj::obj_within_block`
//!   → the caller's `within_block` closure ([`retail::WithinBlockShape`])
//! - Retail orientation (`BakeMode::Retail` only): `acclient.c`
//!   `ObjectDesc::GetObjFrame` :462660 / `ObjectDesc::ObjAlign` :462708 →
//!   `Frame::set_heading` :357692 → [`orientation::obj_frame_orientation`]
//!
//! # Caller contract for the closures
//!
//! - `fetch_scene(scene_id)` — must return the `Scene` for the given
//!   `0x12xxxxxx` DID, or `None` if the scene isn't found. The bake
//!   skips vertices whose scene can't be loaded.
//! - `compute_world_aabb(params)` — must return the world-frame
//!   [`Aabb3D`] for the placement, computed by transforming the mesh's
//!   vertices through ACE's `scale * yaw * cellTranslate * inner`
//!   stack (see [`aabb::transform_mesh_to_aabb3`] for the canonical
//!   helper). Returns `None` when the mesh can't be loaded; the bake
//!   skips placements without a usable AABB (no collision basis). In
//!   `BakeMode::Retail` the frame is the full retail quaternion
//!   ([`PlacementXform::orientation`]; build the box with
//!   [`aabb::transform_mesh_to_aabb3_quat`]), not a yaw.
//!
//! # DAT-01 phase 1 (2026-07-27) — the box is shipped, not discarded
//!
//! ACE's `Collision` rejection only ever reads the XY slice, and until
//! now the box was dropped the moment the decision was made. It is now
//! retained on [`ScenicPlacement::bounds`] so procedural scenery can be
//! given a collision representation downstream (retail makes every
//! scenery instance a real `CPhysicsObj` — `CLandBlock::get_land_scenes`,
//! `acclient.c:352708-352718`; we intend an AABB broad-phase feeding the
//! existing per-static physics-BSP narrow phase).
//!
//! Two invariants make this safe to land ahead of any consumer:
//! - **Acceptance is untouched.** The rejection test reads
//!   `bounds.xy()`, which is bit-identical to what the old 2D builder
//!   returned (`aabb::tests::transform_mesh_to_aabb3_xy_matches_2d`).
//! - **The freeze hash is untouched.** [`placements_fingerprint`] still
//!   folds only the twelve wire fields, so every shipped
//!   `placements-hash` sidecar stays valid.
//!
//! `building_aabbs` is supplied by the caller; the bake doesn't load
//! `LandblockInfo` itself. Caller is responsible for pre-computing the
//! world-frame XY AABB of every entry in `LandblockInfo.Buildings`
//! (NOT `Objects` — ACE's `Landblock.init_buildings` populates the
//! collision-blocker list from Buildings alone; see
//! `~/ace-server/Source/ACE.Server/Physics/Common/Landblock.cs:438`
//! and `Scenery.cs:83`) using the same per-vertex transform.
//!
//! `BakeMode::Retail` never rejects on a box (terrain-scenery-3): it still
//! builds and ships `bounds`, but its building test is the retail
//! building-CELL mask ([`retail::building_cell_mask`], from the
//! `LandblockInfo.Buildings` origins) and it has no placed-scenery test.

#![forbid(unsafe_code)]

pub mod aabb;
pub mod height;
pub mod noise;
pub mod orientation;
pub mod retail;

pub use aabb::{
    Aabb2D, Aabb3D, LocalBounds, transform_local_aabb, transform_mesh_to_aabb,
    transform_mesh_to_aabb3, transform_mesh_to_aabb3_quat,
};
pub use height::{
    CELL_SIZE, LANDBLOCK_SIZE, TrianglePlane, VERTEX_DIM, bilinear_height,
    bilinear_height_from_grid, get_split_dir, normal_z_at, slope_at, triangle_plane_from_grid,
    triangle_plane_height_from_grid, vertex_heights,
};
pub use noise::{
    NOISE_SCALE, NOISE_SCALE_RETAIL, cell_mat_scene, cell_mats_per_object, displace,
    displace_retail, object_noise, object_noise_retail, rotate_obj, rotate_obj_retail, scale_obj,
    scale_obj_retail, scene_index_retail,
};
pub use orientation::{frame_set_heading, obj_frame_orientation, vector_heading, yaw_about_z};
pub use retail::{
    BlockSphere, WithinBlockQuery, WithinBlockShape, building_cell_mask, land_cell_bit,
};

use holtburger_common::Quaternion;
use holtburger_dat::file_type::Region;
use holtburger_dat::file_type::Scene;
use holtburger_dat::landblock::CellLandblock;

/// Bake-mode toggle for the placement contracts the bake can reproduce.
///
/// | Concern | `AceCompat` (default) | `Strict` | `Retail` |
/// |---|---|---|---|
/// | Noise scale | ACE's C# double literal `2.3283064e-10` ([`NOISE_SCALE`]), about 1.6e-8 relative below 2^-32. | Same as `AceCompat`. | Retail — the exe's float `0x2F800000` (`acclient.exe` `0x7c6f10`), exactly 2^-32 ([`NOISE_SCALE_RETAIL`]), in the gate, the scene pick ([`scene_index_retail`]), the displacement and quadrant ([`displace_retail`]), the scale ([`scale_obj_retail`], which also keeps `max/min` unrounded as retail's x87 does) and the heading ([`rotate_obj_retail`]). Live ACE physics keeps ACE's literal. |
/// | Frequency gate | `Scenery.cs:59` — ONE draw per vertex (`cellMat * 23399`, [`object_noise`]) shared by every `ObjectDesc` in the Scene, so a Scene's objects appear or vanish as a nested set. | Same as `AceCompat`. | Retail — object `j` draws its own value from `cellMat * (23399 + j)` ([`object_noise_retail`]; `acclient.c` `CLandBlock::get_land_scenes` :352662-352731). |
/// | Road test | `Scenery.cs:166-172` — ONE terrain word, read at `cellX * 8 + cellY` (an 8-stride on the 9×9 grid, so for `cellX >= 1` it is an unrelated vertex; [`height::on_road`]). | Same as `AceCompat`. | Retail — all four cell corners at `9 * ix + iy` (`+1`, `+9`, `+10`) and the 5 m road band, diagonals included ([`height::on_road_retail`]; `acclient.c` `CLandBlock::on_road` :352238). |
/// | Z snap | Triangle-plane via [`triangle_plane_height_from_grid`] — mirrors `LandblockMesh.GetZ` per-cell triangulation, **and matches the live player surface** (render + `holtburger_world` physics both use the per-cell triangle). | Bilinear via [`bilinear_height_from_grid`] — NB: no longer matches the player/render surface (they moved to the per-cell triangle 2026-06-19/20); retained as an explicit alternative. | Triangle-plane, as `AceCompat` (retail `Plane::set_height` on the walkable terrain triangle). |
/// | Slope rejection | Skipped — `Scenery.cs:69` has it as `TODO: ensure walkable slope` so ACE doesn't reject. | Implemented — rejects placements whose terrain-normal Z (cos slope) falls outside `[min_slope, max_slope]`, using the 4-corner plane fit [`normal_z_at`]. | Retail — `ObjectDesc::CheckSlope` on the `N.z` of the walkable cell TRIANGLE under the point ([`triangle_plane_from_grid`], [`retail::check_slope`]; `acclient.c:352699`). |
/// | Bounds | `Scenery.cs:70` — `0 <= x, y <= 192` (192 accepted). | Same as `AceCompat`. | Retail — `0 <= x, y < 192` (`flt_844AEC`, strict; `acclient.c:352677-352678`). |
/// | Buildings | `Scenery.cs:83` — reject when the placement's render-mesh XY AABB overlaps any building's. | Same as `AceCompat`. | Retail — reject when the candidate's 24 m land cell holds a building ORIGIN (`CSortCell::has_building`, :352697); no box test ([`retail::building_cell_mask`]). |
/// | Scenery overlap | `Scenery.cs:84` — reject when the AABB overlaps an already placed one. | Same as `AceCompat`. | None — retail has no scenery-vs-scenery test. |
/// | Block edge | None. | None. | Retail — `CPhysicsObj::obj_within_block` (:352712) on the unscaled physics shape, via the caller's `within_block` closure ([`bake_landblock_retail`], [`retail::WithinBlockShape`]). |
/// | Orientation | `Scenery.cs:77` — yaw only, `(cos(r/2), 0, 0, sin(r/2))` with `r = noise * max_rot` in radians ([`rotate_obj`]); `base_loc` orientation and `align` ignored. | Same as `AceCompat`. | Retail — `ObjectDesc::GetObjFrame` / `ObjAlign` (:352703-352706): `base_loc` whole when `max_rot == 0`; else `Frame::set_heading(noise * max_rot)` in compass DEGREES, clockwise, so heading `d` is `(cos(d/2), 0, 0, -sin(d/2))` (the mirror of `AceCompat`), keeping the base's forward-axis pitch; `align != 0` faces up the walkable triangle's slope ([`orientation::obj_frame_orientation`]). |
///
/// `AceCompat` replays ACE's `Entity/Scenery.cs` port exactly, TODOs and
/// bugs included. **That port is dead code in ACE** (corrected
/// 2026-10-13): its only caller, `Entity/Landblock.LoadMeshes`, is
/// commented out (`Entity/Landblock.cs:197`; ":334 This isn't used by
/// ACE"). A live ACE server builds its scenery in
/// `Physics/Common/Landblock.get_land_scenes` (`UseSceneFiles = true`),
/// which follows retail: the per-object index in the frequency gate, the
/// road-band test, `has_building` and `CheckSlope`. So `AceCompat` does
/// NOT agree placement-for-placement with a live ACE server, and its
/// "bugs" are not retail behaviour. It stays the default only because
/// every shipped bake (and its `placements-hash` sidecars) is ace-compat.
///
/// `Strict` is the **renderer-aligned** target — what we'd want if we
/// were running a clean-slate server with no ACE compatibility needs.
/// It produces a STRICT SUBSET of `AceCompat`'s output (slope rejection
/// removes placements; Z is the only other delta and it doesn't
/// add/remove placements, just shifts them).
///
/// `Retail` is the retail target. Live ACE physics follows the same rules,
/// but it keeps ACE's double noise literal. That flips a gate or a scene
/// pick only within about 1.6e-8 of a threshold, but it moves many
/// displacements, scales and headings by 1 f32 ULP. It is built up under
/// this one mode: today it differs from `AceCompat` in the noise scale,
/// the frequency gate, the road test, the acceptance rules and the
/// orientation. Under the gate each object keeps its
/// marginal probability `freq`, so density is unchanged; what changes is
/// WHICH objects of a
/// Scene appear in a cell. The road band keeps scenery off the roads
/// retail keeps clear (and stops ACE's 8-stride from clearing unrelated
/// cells). The acceptance rules (terrain-scenery-3) follow
/// `get_land_scenes` in order — bounds, road, building cell, slope,
/// within-block — and drop both of ACE's box rejections, so forests that
/// ACE's overlap test thinned get denser, steep hillsides and building
/// cells get sparser, and a tree in a cell NEXT to a building may now
/// touch its walls (retail-faithful). The full rule set needs the
/// caller's building origins and physics shapes, so it runs through
/// [`bake_landblock_retail`]; [`bake_landblock`] in this mode has neither
/// (empty building-cell mask, within-block always true). The orientation
/// (terrain-scenery-4) is retail's `Frame::set_heading` frame: every
/// rotated object turns the other way to `AceCompat` (which copies ACE's
/// `CreateFromYawPitchRoll(0, 0, +r)`), so a partial `max_rot` range (say
/// 0-85 degrees) fans out clockwise from north, not counter-clockwise, and
/// the heading replaces the base's own yaw; `max_rot == 0` objects keep
/// their `base_loc` heading instead of identity; `align` objects face up
/// the slope; and the few pitched bases keep their (1-2 degree) tilt, so
/// `qx`/`qy` may be non-zero. It is opt-in: do not make it the default
/// until a Retail bake has passed an A/B eye-test against the shipped
/// ace-compat dist.
///
/// The mode appears in the bake's `bake-source.sha256` sidecar so
/// downstream consumers can refuse to honour a mode they don't expect.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum BakeMode {
    /// **Default.** ACE's `Entity/Scenery.cs` port, bit-exactly: one
    /// shared frequency draw per vertex, triangle-plane Z, no slope
    /// check. Every shipped bake is this mode. (Not what a live ACE
    /// server runs — see the type docs.)
    #[default]
    AceCompat,
    /// Renderer-friendly: bilinear Z, slope-rejection ON. Use this for
    /// non-ACE consumers or when you want scenery to land on the same
    /// terrain Z the player physics integrator uses.
    Strict,
    /// Retail `CLandBlock::get_land_scenes` (`acclient.c:352530`), which
    /// the live ACE server's `Physics/Common/Landblock.get_land_scenes`
    /// also follows (with ACE's noise literal). Currently: retail's 2^-32
    /// noise scale ([`NOISE_SCALE_RETAIL`]) in every noise draw, the
    /// per-object frequency gate
    /// ([`object_noise_retail`]), the 4-corner road band
    /// ([`height::on_road_retail`]) and retail acceptance (strict bounds,
    /// building cell, walkable-triangle slope, within-block; no box
    /// rejections — see [`bake_landblock_retail`]) and the retail frame
    /// orientation ([`orientation::obj_frame_orientation`]);
    /// triangle-plane Z as `AceCompat`. Opt-in only.
    Retail,
}

impl BakeMode {
    /// Stable lowercase identifier for CLI parsing and the
    /// `bake-source.sha256` sidecar.
    pub fn as_str(self) -> &'static str {
        match self {
            BakeMode::AceCompat => "ace-compat",
            BakeMode::Strict => "strict",
            BakeMode::Retail => "retail",
        }
    }
}

impl std::str::FromStr for BakeMode {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "ace-compat" | "ace_compat" | "acecompat" => Ok(BakeMode::AceCompat),
            "strict" => Ok(BakeMode::Strict),
            "retail" => Ok(BakeMode::Retail),
            other => Err(format!(
                "unknown BakeMode `{other}` (expected `ace-compat`, `strict` or `retail`)"
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
/// XY. In `AceCompat` / `Strict` the quaternion is yaw-only-about-Z:
/// `w = cos(rad/2)`, `z = sin(rad/2)` (XY are always 0). Matches ACE's
/// `Quaternion.CreateFromYawPitchRoll(0, 0, RotateObj(...))` — verified
/// against .NET reference source: yaw=pitch=0 reduces the quaternion to a
/// pure roll-about-Z rotation, which is `(cos(r/2), 0, 0, sin(r/2))`
/// in (w, x, y, z) order. In `Retail` it is the retail frame
/// orientation ([`orientation::obj_frame_orientation`]): the opposite turn
/// for the same noise, `base_loc` kept when nothing turns it, and `qx`/`qy`
/// non-zero where the base is pitched.
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
    /// DAT-01 phase 1 (2026-07-27) — the world-frame bounding box the
    /// bake built for this placement, in the SAME frame as `(x, y, z)`
    /// (LB-local metres on XY, absolute world metres on Z).
    ///
    /// This is not a new computation: the bake has always built this box
    /// in order to run ACE's `Collision` rejection (`Scenery.cs:80-84`)
    /// and has always discarded it afterwards. `bounds.xy()` is
    /// literally the box that was tested against `building_aabbs` and
    /// the already-placed set; the Z extent is the same per-vertex walk
    /// with the third axis kept instead of thrown away. (`BakeMode::Retail`
    /// tests no box; there it is built only to be shipped.)
    ///
    /// It exists so procedural scenery can get a collision
    /// representation without the client re-deriving one per instance:
    /// it is the broad-phase box for `holtburger_world::StaticAabbEntry`
    /// (DAT-01 phase 2). Carrying it costs nothing at bake time and
    /// guarantees the collision box and the placement-rejection box can
    /// never drift apart.
    ///
    /// **It is deliberately excluded from [`placements_fingerprint`]** —
    /// the freeze hash covers the twelve wire fields the client can
    /// reconstruct, and widening it would invalidate every shipped
    /// sidecar for a purely additive change.
    pub bounds: Aabb3D,
}

/// FNV-1a/64 fingerprint primitives — re-exported from the unified
/// [`holtburger_common::bake_fingerprint`] so the bake-side sidecar
/// emitter and the client-side load-time gate fold through a single
/// shared implementation (byte-identical on either side, no platform
/// `DefaultHasher`, no divergent copy). These names remain part of this
/// crate's public API (the integration tests `use` them from here).
pub use holtburger_common::bake_fingerprint::{
    fnv1a_fold, wire_f32_bits, FNV1A_OFFSET, FNV1A_PRIME,
};

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
/// DAT-01 phase 1 (2026-07-27): [`ScenicPlacement::bounds`] is
/// deliberately NOT folded either, for the same reason as the identity —
/// it is an additive wire field, and widening the hash would invalidate
/// every already-shipped `placements-hash` sidecar (40,197 of them in
/// `dist/scenery/`) for a change that moves no placement.
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

impl ScenicPlacement {
    /// Canonical, content-derived addressable identity for this
    /// placement — delegates to [`GeneratedSceneryIdentity::stable_id`]
    /// on this placement's [`identity`](Self::identity). This is the
    /// join key serialized to the per-LB `.scenery.jsonl` (`stable_id`
    /// field) and consumed by the scenery-cross-check oracle and E8
    /// traceability. Stable across re-bakes of the same DAT inputs.
    pub fn stable_id(&self) -> String {
        self.identity.stable_id()
    }
}

/// Per-candidate placement transform parameters passed to the bake's
/// AABB-building closure. The closure is expected to load the mesh
/// for `obj_id`, run each vertex through
/// `scale * yaw(rotation_rad) * cellTranslate * translate(lx, ly, lz)`,
/// and return the world-frame min/max — exactly what ACE's
/// `BoundingBox.BuildBox` does. Since DAT-01 phase 1 the closure returns
/// an [`Aabb3D`]; the bake reads `.xy()` for ACE's rejection test and
/// ships the whole box on the placement.
///
/// terrain-scenery-4: it also carries the full orientation the placement
/// ships with (`qw..qz`). A `BakeMode::Retail` frame is not yaw-only, so a
/// Retail closure should rotate by [`Self::orientation`]
/// ([`aabb::transform_mesh_to_aabb3_quat`]) rather than `rotation_rad`.
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
    /// Yaw about Z, in radians. `AceCompat` / `Strict`: ACE's
    /// `RotateObj` value, exactly as before. `Retail`: the yaw of the
    /// retail frame ([`orientation::yaw_about_z`]), which drops the 1-2
    /// degree pitch a few bases carry.
    pub rotation_rad: f32,
    /// Uniform scale.
    pub scale: f32,
    /// The placement's orientation, `(w, x, y, z)` — bit-identical to the
    /// [`ScenicPlacement`] quaternion. `AceCompat` / `Strict`:
    /// `(cos(r/2), 0, 0, sin(r/2))` of `rotation_rad`.
    pub qw: f32,
    pub qx: f32,
    pub qy: f32,
    pub qz: f32,
}

impl PlacementXform {
    /// The placement orientation as a [`Quaternion`].
    #[inline]
    pub fn orientation(&self) -> Quaternion {
        Quaternion {
            w: self.qw,
            x: self.qx,
            y: self.qy,
            z: self.qz,
        }
    }
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
///   world-frame AABB. Use [`transform_mesh_to_aabb3`] inside the
///   closure to match ACE bit-for-bit. Return `None` when the mesh
///   can't be resolved — the bake will skip the placement. Only the
///   `.xy()` slice participates in ACE's rejection test; the full box
///   rides out on [`ScenicPlacement::bounds`] (DAT-01 phase 1).
/// - `building_aabbs` — world-frame XY AABBs of all entries in
///   `LandblockInfo.Buildings` on this LB. Caller is responsible for
///   computing each one via the same per-vertex transform. **Do not
///   include `LandblockInfo.Objects`** — ACE's Scenery.Load collides
///   against Buildings only (`Scenery.cs:83` /
///   `Landblock.cs:438`). Ignored by `BakeMode::Retail`, which never
///   rejects on a box.
///
/// `BakeMode::Retail` through this entry point runs the retail chain with
/// NO building cells and an always-true within-block test, because this
/// signature carries neither. Use [`bake_landblock_retail`] for the full
/// retail acceptance.
pub fn bake_landblock(
    region: &Region,
    landblock: &CellLandblock,
    landblock_id: u32,
    fetch_scene: impl FnMut(u32) -> Option<Scene>,
    compute_world_aabb: impl FnMut(PlacementXform) -> Option<Aabb3D>,
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
        0,
        |_: WithinBlockQuery| true,
        mode,
    )
}

/// Run the scenery bake for one landblock in `BakeMode::Retail`, with the
/// two inputs only the caller can supply (terrain-scenery-3).
///
/// Acceptance follows `acclient.c` `CLandBlock::get_land_scenes`
/// (:352673-352718) in order: `0 <= x, y < 192`; not on a road
/// ([`height::on_road_retail`]); the candidate's land cell not in
/// `building_cells`; `N.z` of the walkable terrain triangle within
/// `[min_slope, max_slope]`; and `within_block` true. There is no box
/// test of any kind: `compute_world_aabb` is still called for every
/// accepted placement, but only to fill [`ScenicPlacement::bounds`] (the
/// collider broad phase). A `None` from it still drops the placement — it
/// means the model could not be loaded, which in retail is a failed
/// `CPhysicsObj::makeObject` and likewise places nothing.
///
/// # Arguments
///
/// As [`bake_landblock`], plus:
///
/// - `building_cells` — bit `ix * 8 + iy` set for each of this block's land
///   cells holding a building origin. Build it with
///   [`retail::building_cell_mask`] from `LandblockInfo.Buildings[].frame`
///   origins (not `Objects`).
/// - `within_block` — `CPhysicsObj::obj_within_block` (`acclient.c:318307`)
///   for the placed, UNSCALED object: retail runs it before
///   `SetScaleStatic` (:352712 vs :352716). It gets the model id and the
///   placement frame (the same origin and quaternion the placement ships
///   with) and returns false to drop the candidate. Load the model's
///   [`retail::WithinBlockShape`] and call
///   [`retail::WithinBlockShape::within_block`]. Must be deterministic.
pub fn bake_landblock_retail(
    region: &Region,
    landblock: &CellLandblock,
    landblock_id: u32,
    fetch_scene: impl FnMut(u32) -> Option<Scene>,
    compute_world_aabb: impl FnMut(PlacementXform) -> Option<Aabb3D>,
    building_cells: u64,
    within_block: impl FnMut(WithinBlockQuery) -> bool,
) -> Vec<ScenicPlacement> {
    bake_landblock_impl(
        region,
        landblock,
        landblock_id,
        fetch_scene,
        compute_world_aabb,
        &[],
        building_cells,
        within_block,
        BakeMode::Retail,
    )
}

#[allow(clippy::too_many_arguments)]
fn bake_landblock_impl(
    region: &Region,
    landblock: &CellLandblock,
    landblock_id: u32,
    mut fetch_scene: impl FnMut(u32) -> Option<Scene>,
    mut compute_world_aabb: impl FnMut(PlacementXform) -> Option<Aabb3D>,
    building_aabbs: &[Aabb2D],
    building_cells: u64,
    mut within_block: impl FnMut(WithinBlockQuery) -> bool,
    mode: BakeMode,
) -> Vec<ScenicPlacement> {
    // Scenery.cs:21-22: get landblock cell offsets.
    let block_x: u32 = (landblock_id >> 24).wrapping_mul(8);
    let block_y: u32 = ((landblock_id >> 16) & 0xFF).wrapping_mul(8);
    // For triangle-plane Z (AceCompat, Retail): pre-pack the LB-id top half
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
    // `BakeMode::Retail` road-band width: the Region's `road_width` (5.0,
    // retail's `CLandBlock::on_road` literal), resolved once.
    let road_width = height::retail_road_width(region);

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
        // `Retail` scales by retail's 2^-32 (acclient.c
        // CLandBlock::get_land_scenes :352639-352645); `AceCompat` and
        // `Strict` keep ACE's literal, byte-identical.
        let cell_mat_initial = cell_mat_scene(global_cell_x, global_cell_y);
        let scene_idx = match mode {
            BakeMode::Retail => scene_index_retail(cell_mat_initial, scenes.len()),
            BakeMode::AceCompat | BakeMode::Strict => {
                let offset: f64 = cell_mat_initial as f64 * NOISE_SCALE;
                let mut scene_idx = (scenes.len() as f64 * offset) as usize;
                if scene_idx >= scenes.len() {
                    scene_idx = 0;
                }
                scene_idx
            }
        };
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

            // Scenery.cs:59 — per-object noise sample. `Retail` gives each
            // object its own draw, `cellMat * (23399 + j)` (acclient.c
            // CLandBlock::get_land_scenes :352662-352731). `AceCompat` and
            // `Strict` keep ACE's dead-code shared draw, byte-identical.
            let noise = match mode {
                BakeMode::Retail => object_noise_retail(cell_x_mat, cell_y_mat, cell_mat, j_u32),
                BakeMode::AceCompat | BakeMode::Strict => {
                    object_noise(cell_x_mat, cell_y_mat, cell_mat)
                }
            };

            // Scenery.cs:61 — gate on freq + skip weenie-managed entities.
            if !(noise < obj.freq as f64) || obj.weenie_obj != 0 {
                continue;
            }

            // Scenery.cs:63 — apply displacement noise. `Retail` is
            // `ObjectDesc::Place` with retail's 2^-32 scale.
            let (dx, dy) = match mode {
                BakeMode::Retail => displace_retail(obj, global_cell_x, global_cell_y, j_u32),
                BakeMode::AceCompat | BakeMode::Strict => {
                    displace(obj, global_cell_x, global_cell_y, j_u32)
                }
            };

            // Scenery.cs:66-67 — translate to LB-local frame.
            let lx = cell_x as f32 * CELL_SIZE + dx;
            let ly = cell_y as f32 * CELL_SIZE + dy;

            // Scenery.cs:70 — reject out-of-LB placements + road overlap.
            // `Retail` bounds the point to [0, 192): get_land_scenes tests
            // `obj_vector.x < flt_844AEC` (24.0 * 8.0), strict, and a NaN
            // fails every comparison (acclient.c:352674-352678).
            // `AceCompat` / `Strict` keep ACE's `> 192`, which accepts 192.
            let out_of_block = match mode {
                BakeMode::Retail => {
                    !(lx >= 0.0 && ly >= 0.0 && lx < LANDBLOCK_SIZE && ly < LANDBLOCK_SIZE)
                }
                BakeMode::AceCompat | BakeMode::Strict => {
                    lx < 0.0 || ly < 0.0 || lx > LANDBLOCK_SIZE || ly > LANDBLOCK_SIZE
                }
            };
            if out_of_block {
                continue;
            }
            // `AceCompat` and `Strict` keep ACE's dead-code one-word test
            // (Scenery.cs:166-172, 8-stride), byte-identical. `Retail` runs
            // the 4-corner road band (acclient.c CLandBlock::on_road, called
            // from get_land_scenes :352679).
            let on_road = match mode {
                BakeMode::Retail => height::on_road_retail(landblock, lx, ly, road_width),
                BakeMode::AceCompat | BakeMode::Strict => height::on_road(landblock, lx, ly),
            };
            if on_road {
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
            //
            // `BakeMode::Retail` slope-checks below, against the walkable
            // terrain TRIANGLE's `N.z` rather than this 4-corner fit.
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
            // `BakeMode::Retail` uses the triangle plane too: retail calls
            // `Plane::set_height` on the walkable terrain triangle
            // (acclient.c CLandBlock::get_land_scenes). Before that it runs
            // the two cell gates, in retail order (:352697-352699):
            // `CSortCell::has_building` on the candidate's land cell, then
            // `ObjectDesc::CheckSlope` on the `N.z` of the triangle
            // `CLandCell::find_terrain_poly` returns. The triangle's normal
            // rides along for `ObjectDesc::ObjAlign` below (only `Retail`
            // reads it; the other modes pass straight up, unused).
            let (z, walkable_normal) = match mode {
                BakeMode::AceCompat => (
                    height::triangle_plane_height_from_grid(&heights, landblock_id_top_16, lx, ly),
                    (0.0, 0.0, 1.0),
                ),
                BakeMode::Strict => (
                    height::bilinear_height_from_grid(&heights, lx, ly),
                    (0.0, 0.0, 1.0),
                ),
                BakeMode::Retail => {
                    if building_cells & retail::land_cell_bit(landblock_id, lx, ly) != 0 {
                        continue;
                    }
                    let plane =
                        height::triangle_plane_from_grid(&heights, landblock_id_top_16, lx, ly);
                    if !retail::check_slope(obj, plane.normal_z()) {
                        continue;
                    }
                    (plane.z, plane.normal)
                }
            };

            // Orientation. `AceCompat` / `Strict`: Scenery.cs:77, a yaw
            // about Z from `RotateObj`, byte-identical to every shipped
            // bake. `Retail` (terrain-scenery-4): the frame retail builds
            // after `Plane::set_height` (acclient.c CLandBlock::get_land_scenes
            // :352703-352706) — `ObjectDesc::ObjAlign` when `align != 0`,
            // else `ObjectDesc::GetObjFrame` (`base_loc`, then
            // `Frame::set_heading(noise * max_rot)` in compass degrees when
            // `max_rot > 0`). Full quaternion; `rotation_rad` is its yaw.
            let (rotation_rad, qw, qx, qy, qz) = match mode {
                BakeMode::Retail => {
                    let q = orientation::obj_frame_orientation(
                        obj,
                        global_cell_x,
                        global_cell_y,
                        j_u32,
                        walkable_normal,
                    );
                    (orientation::yaw_about_z(q), q.w, q.x, q.y, q.z)
                }
                BakeMode::AceCompat | BakeMode::Strict => {
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
                    (rotation_rad, qw, 0.0, 0.0, qz)
                }
            };

            // `Retail` only — `CPhysicsObj::obj_within_block` on the placed
            // object (acclient.c:352711-352712): `set_initial_frame` with
            // the placement frame, BEFORE `SetScaleStatic`, so the closure
            // tests the unscaled shape. False deletes the object.
            if matches!(mode, BakeMode::Retail)
                && !within_block(WithinBlockQuery {
                    obj_id: obj.obj_id,
                    x: lx,
                    y: ly,
                    z,
                    qw,
                    qx,
                    qy,
                    qz,
                })
            {
                continue;
            }

            // Scenery.cs:78 — uniform scale. `Retail` is
            // `ObjectDesc::ScaleObj`: retail's 2^-32 scale and an unrounded
            // (f64) `max / min` ratio.
            let scale = match mode {
                BakeMode::Retail => scale_obj_retail(obj, global_cell_x, global_cell_y, j_u32),
                BakeMode::AceCompat | BakeMode::Strict => {
                    scale_obj(obj, global_cell_x, global_cell_y, j_u32)
                }
            };

            // Scenery.cs:80 + 83-84 — bounding box + collision reject.
            // AABB construction matches ACE BoundingBox.BuildBox: walk
            // each mesh vertex through `scale * rotate * cellTranslate
            // * cellTranslateInner` and take XY min/max. Closure owns
            // the mesh cache + the transform — see
            // `apps/holtburger-tools/src/bin/scenery-bake.rs::compute_world_aabb_for`.
            let world_bounds = match compute_world_aabb(PlacementXform {
                obj_id: obj.obj_id,
                lx,
                ly,
                lz: z,
                rotation_rad,
                scale,
                qw,
                qx,
                qy,
                qz,
            }) {
                Some(a) => a,
                None => continue,
            };
            // DAT-01 phase 1: ACE's `Collision` is XY-only, so the
            // rejection reads the `.xy()` slice and nothing else. The
            // full 3D box is retained solely to be SHIPPED on the
            // accepted placement — it never influences acceptance, which
            // is why widening the closure's return type cannot move a
            // single placement.
            //
            // `Retail` runs neither box test: retail has no
            // scenery-vs-scenery rejection at all, and its building test
            // is the land-cell mask above (terrain-scenery-3). The box is
            // still built and shipped as the collider broad phase.
            if !matches!(mode, BakeMode::Retail) {
                let world_aabb = world_bounds.xy();

                if noise::intersects_any(&world_aabb, building_aabbs) {
                    continue;
                }
                if noise::intersects_any(&world_aabb, &placed_aabbs) {
                    continue;
                }
                placed_aabbs.push(world_aabb);
            }

            // Accept the placement.
            scenery.push(ScenicPlacement {
                obj_id: obj.obj_id,
                x: lx,
                y: ly,
                z,
                qw,
                qx,
                qy,
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
                bounds: world_bounds,
            });
        }
    }

    scenery
}
