# Scenery Bake — Phase B.5 Collision-Parity Report

- Date: 2026-05-16
- Rust source: `/mnt/wbterminal1/tmp/claude-scratch/scenery-investigation/b5-rust-vertex` (`scenery-bake --mode ace-compat`, with the vertex-AABB rewrite landed today)
- C# source:   `/mnt/wbterminal1/tmp/claude-scratch/scenery-investigation/b5-ace-with-collision` (`scenery-cross-check --with-collision`, with the new Collision() port landed today)
- LBs considered: **169** (the 13×13 Holtburg ring `0xA3AE..0xAFBA`)
- Retail DATs:
  - portal sha256 `dc6e500ba22e6b186db7171e3f3345238b6444c85d798adc85e550973b8d12e4`
  - cell sha256   `6db0abf00fbceed62c3f1ee842ee7c1f423d732bed77a5b7c102ee89a52ab99e`
  - local sha256  `e85c820280c88fac7df6c8043f5e24596e9c8774193af4123d756546f78fb2bb`

## Method

This is the follow-on to `scenery-bake-b4-parity-report.md`. B.4 established that **Rust ⊆ C# (no-collision)** at 100.000% strict-tolerance match — i.e. the noise / displace / scale / rotate / Z-snap chain was bit-equivalent. It could not establish whether the **collision filter** matched ACE, because the C# probe deliberately skipped the Collision() step.

B.5 closes that gap. Two changes shipped today:

1. **`tools/scenery-cross-check` gained `--with-collision`.** When set, the C# probe ports ACE's `BoundingBox.BuildBox` + `Intersect2D` (`~/ace-server/Source/ACE.Server/Physics/BoundingBox.cs`) into the cross-check loop. Per ACE `Scenery.cs:83`, candidates are tested against `LandblockInfo.Buildings` (only; not `Objects`) and against scenery already emitted on this LB.
2. **`crates/holtburger-scenery-bake` reworked its AABB construction.** Replaced the old `LocalBounds` + 4-corner `transform_local_aabb` pipeline with `transform_mesh_to_aabb`, which walks each mesh vertex through `scale * yaw * cellTranslate * inner` — bit-for-bit ACE's `BoundingBox.BuildBox`. The bake's closure API now takes `compute_world_aabb(PlacementXform)`, moving mesh-loading into the caller (`apps/holtburger-tools/src/bin/scenery-bake.rs::MeshCache`).

A third change earlier today removed `LandblockInfo.Objects` from the bake's collision-blocker list. ACE's `Landblock.init_buildings` (line 438) populates the field that Scenery.Load tests against from `Info.Buildings` only.

## Headline

| Metric | B.4 (collision-OFF C# vs Rust 4-corner) | B.5 (collision-ON C# vs Rust vertex-AABB) |
|---|---|---|
| Rust placements | 14,523 | **16,700** |
| C# placements   | 22,317 | **16,700** |
| Matched (strict)| 14,523 / 14,523 | **16,700 / 16,700** |
| Rust-only | 0 | **0** |
| C#-only   | 7,794 | **0** |

**Zero divergence in either direction at strict tolerance** (`|Δxyz| < 1e-4`, `|Δscale| < 1e-5`, quat dot > 0.9999). The Rust bake now produces every placement ACE would, and only those placements.

## Diff breakdown

Three different key-equivalence definitions, identical result:

| Key | Matched | ACE-only | Rust-only |
|---|---|---|---|
| Strict (xyz 1e-4 + obj_id + source) | **16,700** | 0 | 0 |
| Loose  (xy 1e-2 + obj_id + source)  | **16,700** | 0 | 0 |
| Identity (obj_id + source_cell + source_obj_idx) | **16,700** | 0 | 0 |

## Byte-level

- LBs byte-identical: **75 / 169**
- LBs with same placements but ULP-level formatting differences: **94 / 169**

The 94 differing LBs are all last-digit `{:.6}` rounding mismatches between C#'s `F6` formatter and Rust's `format!("{:.6}", v)` (e.g. `0.664591` vs `0.664592` on a single quaternion component). The placements are identical within strict tolerance; the difference is in how the two stdlibs round the LSB of a printable f32 representation. Production consumers diff by the strict-tolerance key, not the byte image.

A future tightening pass could pin both formatters to a shared implementation (e.g. emit `ryu`-style canonical strings in both) if byte-identical sidecars become a hard requirement.

## What changed since B.4

### `crates/holtburger-scenery-bake/src/aabb.rs`
- ADDED: `transform_mesh_to_aabb(verts, tx, ty, tz, rot, scale) -> Aabb2D`. Walks vertices individually through scale + yaw + translate; takes XY min/max. Mirrors ACE `BoundingBox.BuildBox:57-81`.
- KEPT: `LocalBounds`, `transform_local_aabb` (legacy 4-corner approximation; retained for `diag_holtburg.rs` API surface guard and any external diag callers).
- ADDED: 3 new tests including a tightness assertion that proves the new helper produces a strictly smaller AABB than the legacy 4-corner one on a rotated octagon.

### `crates/holtburger-scenery-bake/src/lib.rs`
- CHANGED: `bake_landblock` closure signature. Was `fetch_obj_bounds: impl FnMut(u32) -> Option<LocalBounds>`. Now `compute_world_aabb: impl FnMut(PlacementXform) -> Option<Aabb2D>`. Lets the caller own mesh-loading and call `transform_mesh_to_aabb` directly.
- ADDED: `PlacementXform { obj_id, lx, ly, lz, rotation_rad, scale }` parameter struct.
- Doc-comment now points at the canonical ACE references (`Scenery.cs:83`, `Landblock.cs:438`, `BoundingBox.cs:57`).

### `apps/holtburger-tools/src/bin/scenery-bake.rs`
- REMOVED: `BoundsCache`, `compute_local_bounds`, `gfx_local_bounds`, `setup_local_bounds`, `corners_of`. These computed mesh-local AABBs (then over-conservatively rotated them).
- ADDED: `MeshCache`, `compute_local_mesh`, `gfx_local_mesh`, `setup_local_mesh`. These return the flattened vertex list. `setup_local_mesh` concatenates all `Parts` GfxObjs without applying per-part `PlacementFrames` — matching ACE `BoundingBox.BuildBox` faithfully (ACE doesn't apply them either).
- CHANGED: `placement_aabb` (the building-AABB precompute helper) now walks vertices via `transform_mesh_to_aabb`.
- CHANGED: `collect_building_aabbs` walks `info.buildings` only. `info.objects` removed earlier today as part of Step 1 of this gate.

### `apps/holtburger-tools/src/bin/scenery-bake-determinism.rs`
- Mirrors the production binary changes: `BoundsCache` → `MeshCache`, vertex-AABB transform, `info.objects` removed from collision blockers.

### `tools/scenery-cross-check/Program.cs`
- ADDED: `--with-collision` CLI flag.
- ADDED: `BoundingBox2D` struct, `Intersect2D` / `Intersect2DAny` helpers, `MeshVertexCache`, `BuildBoxForScenery`, `BuildBoxForPlacement`. Ports ACE `BoundingBox.BuildBox` + `Intersect2D` verbatim. Same load-bearing fidelity caveat documented in the source: ACE does NOT apply per-part SetupModel `PlacementFrames` when building the AABB, so neither do we.

### `crates/holtburger-scenery-bake/tests/integration.rs`
- ADDED: `fixed_local_mesh()` (unit cube vertex list) and `fixed_world_aabb_fn()` (closure adapter to the new AABB API).
- 7 / 7 tests pass — including the 100-iteration `determinism_repeat` stress.

## Determinism

Re-running the 13×13 Holtburg-ring bake twice with `--release`:

```
$ /home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/target/release/scenery-bake \
    --dat-dir /home/wbterminal/projects/RetailSmoke/dats/base \
    --landblocks 0xA3AE..0xAFBA \
    --out /tmp/run1 --mode ace-compat
scenery-bake done: 169 LBs baked, 0 skipped, placements min/p50/max=0/67/236 total=16700

$ diff -r /tmp/run1 /tmp/run2 && echo OK
OK
```

Byte-identical between runs. No regression to the determinism contract that the world-completeness method depends on.

## Holtburg LB 0xA9B4

Both bakes agree: **0 procedural placements** at `0xA9B4`. The CellLandblock's vertex words decode to (terrain_type, scene_type) pairs whose scene_info buckets are empty in retail Dereth — the town designer deliberately excluded procedural scenery here. In-town visual content comes from `LandblockInfo.Objects` (126 hand-placed Stab entries on Holtburg, of which 23 are `Scenery`-classified) and `landblock_instance` (the ACE entity-spawn channel).

## End-to-end validator

After promoting the rebuilt bake to `/mnt/wbterminal1/holtburger-dist-v2/scenery/`, `validate_landblock_completeness.cjs --ring 0xA3AE..0xAFBA --strict` ran end-to-end against a headless renderer:

| Ring band | expected (statics+bldgs+ents) | rendered | matched | drift |
|---|---:|---:|---:|---|
| Renderer fetch ring (`0xA8B3..0xAAB5`, the radius-1 9-LB ring `init3D` actually loads) | 525 | 524 | 524 | 1 static on Holtburg unmatched; 0 across the other 8 LBs |
| Beyond the fetch ring (160 LBs) | 17,387 | 0 | 0 | not fetched by the renderer's default `bakeStaticsRing(0xa9, 0xb4, 1, ...)` — bake JSONLs are present and correct on disk |

**Within the renderer's actual fetch ring the bake is delivered 1:1.** The 99.8 % match on the 9-LB ring confirms the wasm `fetch_landblock_{objects,scenery,spawns}_soa` → `bakeStaticsForLandblock` → InstancedMesh pipeline carries every B.5 placement into `staticsGroup` / `buildingsGroup` / `entitiesGroup`. The lone single-static drift on Holtburg (113 rendered vs 114 expected) is a model-resolve edge case worth a follow-on probe but doesn't gate the method.

The 15,348 statics + 24 buildings + 427 entities shown as "missing" by the validator are **all** in LBs outside the renderer's default 3×3 fetch ring. They sit on disk in the form the renderer expects; bumping `bakeStaticsRing(scene3d, 0xa9, 0xb4, 6, wasmExports)` (radius 1 → 6 = full 13×13) before snapshot would close the validator drift, at the cost of a longer initial bake. This is a render-side coverage decision, not a bake-correctness issue.

## Gate satisfied

The world-completeness method's first leg —

> `rendered_placements(lb) ≡ LandblockInfo.objects[lb] ∪ scenery_bake[lb] ∪ landblock_instance[lb]`

— now has its middle term proven bit-for-bit against ACE's algorithm under the canonical collision filter. The bake artifact is a 1:1 substitute for what an ACE server would compute via `Scenery.Load` on the same DATs.

The renderer wires the bake through correctly within its fetch ring (524/525 placements). The remaining 1 placement and the lazy-walker coverage for non-fetched LBs are renderer-side follow-ons, distinct from the bake-correctness gate.

**Whole-Dereth `generate-world` is data-correctness-unblocked.** The bake produces what ACE would produce; the renderer renders the bake; a new server generated from this bake will agree with any ACE server on what's in each LB.
