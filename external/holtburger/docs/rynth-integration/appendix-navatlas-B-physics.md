# Appendix B — Holtburger geometry/physics & walkability surfaces (Explore-agent report, 2026-07-18, citations spot-verified)

Root: `external/holtburger`.

## 1. DAT geometry → collision; the runtime spatial structure

**`SpatialScene`** (`crates/holtburger-world/src/spatial/scene.rs:432`) is the single structure the CTransition/faithful walker collides against:

- Buildings: coarse per-part AABBs `building_aabb_index` (:445) + precise interior/basement triangles `building_physics_index` (:608) — SetupModel parts → `GfxObj.physics_polygons`.
- EnvCells: `cell_physics_bsp` (:492), render-only `cell_physics_index` (:480), membership `cell_membership` (:520), AABBs (:461), portal graph `cell_portal_graph` (:454).
- Scenery/statics: outdoor `statics_aabb_index` (:577) + `statics_physics_bsp` (:587); indoor `cell_static_physics_bsp` (:509) — **⚠ no live wasm populate path yet (scene.rs:504-508): live walkers do not collide indoor furniture; a native harness must populate it itself.**
- Terrain: `terrain_heights` (9×9 corner grids, :622) + `terrain_water_codes` (:635).
- Dynamic entities: per-query via `TransitionEnv::entity_colliders_near` (transition.rs:198) as cylinders.

Crate split: `holtburger-dat` parses DATs + owns the decomp-faithful CTransition driver (`crates/holtburger-dat/src/transition/`, 28 files; `resolve_cell_physics_polygons` physics.rs:1072). `holtburger-world` owns SpatialScene + the bridge (`faithful_bridge.rs`: `SceneWorld` :497 implements the driver's CellWorld seam; SpatialScene implements Landscape :748 and LandDefsSeam :719).

Live population: wasm `populateBuildingAabbsForLandblock` (lib.rs:14933), `populateStaticsAabbsForLandblock` (:15229), `populateTerrain` (:32796), EnvCell walk via `fetchEnvCellsInLandblock`. Live walker: `MovementSystem` → `faithful_find_transitional_position` (`USE_FAITHFUL_TRANSITION=true`, system.rs:620) + `faithful_find_placement_position` (:5843).

## 2. Wasm physicality exports (SessionHandle unless noted)

Sweeps (→ `CollisionHit|undefined`, against a live CLONE of the movement scene, synced lib.rs:48034):
- `cameraSweepCollision` (:31935) — building AABBs
- `sweepSphereAgainstBuildingMesh` (:31987) — precise building triangles
- `sweepSphereAgainstStatics` (:32022) — outdoor static AABBs
- `sweepSphereAgainstCellMesh` (:32070) — EnvCell triangles for given cell ids

Terrain/placement: `terrainHeightAt` (:31878, retail diagonal-split interpolation), `getBuildingPartForDoor` (:32114).

Movement drive: `setMovementInput` (:32657), `tickMovement` (:34359), `moveToPosition` (:30492; JS wrapper webhost.js:652). Speed: `playerRunRate` (:35898, cached), `playerRunRateInputs` (:35924), free fn `stateGroundSpeed` (:6943 — integrator caps ground anim speed at `run_rate × 4.0`). Diagnostics: `startMovementTrace`/`getMovementTrace`, `movementPendingMotionsDiag`; test exports `holtburgTestCollisionClampAxisAligned`/`SlideAlongWall`.

**rynth/*.js uses NONE of the sweep/terrain exports today** (grep-verified) — obstacle probing from JS is an untapped, perception-pure capability.

## 3. Offline/headless harness patterns (route validation by simulated walking)

1. `crates/holtburger-world/src/spatial/env840_seam_tests.rs` — opens real DATs (`DatDatabase::new`), rebuilds cells exactly like the web path (`EnvCell::unpack` + `resolve_cell_physics_polygons` → `insert_cell_physics_bsp`/membership/aabb/portal), stubs `TransitionEnv` (TestEnv :52-80), and drives the SAME faithful APIs:
   - `env840_seam_cross_into_room` (:451): 0.25 m slice walk threading `last_contact_plane`, asserts seam crossing.
   - `env840_run_seam_wedge_slice_loop` (:536): full per-frame RUN loop — 30 fps, `RUN_SPEED=4.0`, gravity integration, `frames_stationary_fall` carry, 80 slices, asserts arrival + re-ground. **Directly reusable template for validating a route by simulated walking.**
2. `crates/holtburger-world/examples/probe_walkin.rs` — native main() building CellMembership for a landblock and printing per-cell verdicts (siblings: corner_check.rs, leak_test.rs).

Recipe for a route validator: open DATs → build SpatialScene (cells + statics + terrain) → implement TransitionEnv (terrain height/normal/water from the grid) → loop `faithful_find_transitional_position` per slice at run speed → assert `TransitionOutcome::{pose,grounded}` progress per leg.

## 4. Run speed

Ground run velocity = **MotionTable RunForward anim speed × run_rate scalar**:
- `resolved_manual_run_speed` = `base_run_forward_speed() * run_rate_scalar` (state/self_movement.rs:44); base speed comes from the RUN_FORWARD_COMMAND animation via `cycle_kinematics` (state/motion_resolution.rs:262-265).
- `run_rate_from_skill_and_burden` (context.rs:130, formula :137-153): `(load_mod · (skill/(skill+200)·11) + 4)/4`, plateau `==800 → 18/4 = 4.5` (retail edge behind `RETAIL_RUNRATE_EDGE`); exhaustion (stamina 0) forces rate 1.0. Matches retail `MovementSystem::GetRunRate` (acclient.c:713790).
- Gait selector `forward_axis_speed` (movement/common.rs:838-848); backstep ×0.65; sidestep caps 3.75 m/s.
- Offline harness uses `RUN_SPEED = 4.0` (= resolved speed at rate 1).

## 5. JS-side static-object visibility (route-authoring raw material)

- Buildings: `window.buildingMap3d` = Map<placementKey, THREE.Group> (scene3d/buildings.js:1358-1362) — world transforms → Box3 derivable; door parts via wasm `getBuildingPartForDoor`.
- Outdoor scenery: built in scene3d/statics.js from LandblockInfo.objects placements (worldX/worldY :231, orientation :175-189); wasm `holtburgStaticObjectCount` (:16270), per-cell `takeStaticObjects()` → `StaticObjectPlacement`.
- The collision-authoritative query surface is the wasm sweep API (§2) — prefer it over render meshes.
