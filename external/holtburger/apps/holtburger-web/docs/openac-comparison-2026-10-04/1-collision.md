# 1 — Collision / cell-membership comparison: holtburger vs OpenAC vs retail decomp

Scope: why the player still glitches **through the map at tunnel / dungeon mouths** (outdoor terrain <-> EnvCell / building portals) after 399b26b7.
Paths: H = `external/holtburger`, O = `external/OpenAC/src/AcDream.Core/Physics`, D = `~/ac-headers/acclient.c`.
Every file:line below was re-read for this report. Read-only study; nothing built or run.

## TL;DR

holtburger's `find_cell_list` / `check_other_cells` port is close to the decomp, so the bugs are in the parts **around** the driver:

1. **Cell membership is decided outside the driver, by a heuristic, and the driver's own answer is thrown away.** The heuristic:
   - is sphere-based, not point-based;
   - tests the **feet** point, not the sphere centre;
   - scans **every** EnvCell in the landblock, not only cells reachable through a building portal.

   This can flip the player into a tunnel EnvCell they are not inside.
2. When that happens, the **faithful** retail rule "no containing cell ⇒ `check_cell = NULL` ⇒ `transitional_insert` returns OK with zero collision" takes over, and the player drops through terrain.

OpenAC avoids both: it does membership through retail building-transit plus a `point_in_cell` pick, and it never lets the primary cell go null (it keeps the seed cell and recovers through the stab list).

Most likely fall-through mechanism, ranked: **F1 + F2 + F3 together** (HIGH). Then F4/F5 at landblock edges (MED). Then F6 at building or dungeon-entrance shells (MED).

---

## F1 — EnvCell entry/exit is a post-transition heuristic that ignores the driver's cell (HIGH)

**Retail.** Membership is decided inside every step:
- `CObjCell::find_cell_list` (D:346961) seeds the CELLARRAY.
  - An outdoor cell gets `CLandCell::find_transit_cells` (D:355423), which goes through `CSortCell::find_transit_cells` (D:356087), then `CBuildingObj::find_building_transit_cells` (D:719068), then `CEnvCell::check_building_transit` (D:348110).
  - So the only EnvCells that can join from outdoors are cells behind a **building portal**, and only when `sphere_intersects_cell` is true.
- `curr_cell` is then picked by `point_in_cell(sphere[0].center)`. An interior match wins (D:~347030-347060).
- `check_other_cells` (D:312381) writes that pick into `check_cell`, and `validate_transition` commits it as the object's cell.

**OpenAC** follows this model:
- `CellTransit.BuildCellSetAndPickContaining` (O/CellTransit.cs:828-965):
  - an outdoor seed adds the outside ring (870);
  - each outdoor candidate with a building runs `CheckBuildingTransit` (878-885 → 407-462, sphere-vs-cell);
  - each EnvCell runs `FindTransitCellsSphere` (891);
  - the pick is `PointInCell` on the sphere centre, interior first (916-923).
- `RunCheckOtherCellsAndAdvance` (O/TransitionTypes.cs:2474-) applies the result through `sp.SetCheckPos`.

**holtburger:**
- **The outdoor CLandCell has no building transit at all.** `build_outdoor_cell` sets `resolved_neighbours: Vec::new()` (H/crates/holtburger-world/src/spatial/faithful_bridge.rs:1136), and `find_transit_cells` (466) only walks `resolved_neighbours`. From outdoors, no EnvCell ever enters the CELLARRAY.
- **The driver's resolved cell is discarded.**
  - The marshal builds the output pose with `landblock_id: input.begin.landblock_id` (faithful_bridge.rs:1590).
  - It then overrides the cell with scene heuristics (1619-1645): `entered_envcell_for_outdoor_pose`, `exited_envcell_to_outdoor`, `current_cell`.
  - `t.sphere_path.curr_cell` and `curr_pos.objcell_id` are never read in production; they are only read by the cfg(test) diag at 2179-2182.
- **`entered_envcell_for_outdoor_pose`** (H/.../spatial/scene.rs:2917):
  - iterates **every** `cell_aabbs` entry in the landblock — dungeon or tunnel cells under the hill, not only cells behind a building portal;
  - flips indoors when the **sphere intersects** the hull (`sphere_intersects_cell != Outside`), instead of when the point is inside;
  - centres that sphere at `pos.global_coords()` (2925), which is the **feet** (see F3).
- The approximate pipeline repeats the same flip per step: `step_cell_transit_flips`, H/.../spatial/transition.rs:545-580.

**Why this drops you through the map.**
1. You walk on terrain beside or above a tunnel or dungeon-mouth EnvCell whose hull comes within about 0.48 m of your feet.
2. The flip makes that EnvCell the begin cell, although your sphere centre is outside it.
3. Next frame the driver starts in that EnvCell. `find_cell_list` gets no exterior-portal straddle unless you happen to be near the mouth's portal plane, so no terrain ring is added.
4. The `point_in_cell` pick fails, `check_cell` becomes `None`, and from F2 you get zero collision. You fall.
5. `exited_envcell_to_outdoor` (scene.rs:3124) keeps you "indoors" as long as the sphere still touches the hull.

399b26b7 fixed only the case where the straddle **does** fire.

**Fix.**
- (a) Give outdoor `SceneObjCell`s a building list. Build it from LandBlockInfo buildings registered on the landcell that contains the building origin, as OpenAC does (`cache.GetBuilding(cellId)`; see `RegisterBuildings` in O tests/Conformance/DoorwayCellMembershipTests.cs).
- (b) Implement `find_transit_cells` for outdoor cells as retail does: for each building portal, resolve `other_cell_id` → `GetVisible`. If any sphere passes `sphere_intersects_cell` in that cell's frame, `add_cell` it and set `hits_interior_cell`.
- (c) Marshal the output pose's cell from `t.sphere_path.curr_cell` (or `curr_pos.objcell_id`) instead of `entered_envcell_for_outdoor_pose`, `exited_envcell_to_outdoor` and `current_cell`. Keep the heuristic only as a fallback for the non-faithful pipeline. If you keep it at all, limit it to building-portal cells and use point containment at the sphere centre.

---

## F2 — A null `check_cell` disables all collision; OpenAC never lets it go null (HIGH as an amplifier)

**Retail.**
- `check_other_cells` LABEL_6 (D:~312436-312470) sets `check_cell = new_cell2`.
  - If there is no `point_in_cell` winner and `check_pos` is indoor, `check_cell` stays NULL.
  - If `check_pos` is outdoor, it calls `adjust_to_outside`.
- `transitional_insert` starts with `if (!check_cell) return 1;` (D:312859). That means no env, terrain, building or object test, and no step-down (the step-down gate also requires `check_cell`).
- Retail can afford this because its membership never disagrees with geometry: walls stop you before your centre leaves every cell.

**holtburger** ports this faithfully:
- check_other_cells is at H/crates/holtburger-dat/src/transition/driver_cell_dispatch.rs:151-241. The indoor no-winner path at 213-241 leaves `check_cell = None`.
- The early return is at driver_spine.rs:123-126.
- Combined with F1/F3, an off-hull begin cell therefore becomes a free-fall corridor.

**OpenAC deliberately deviates:**
- `BuildCellSetAndPickContaining` keeps the seed cell when nothing contains the point (O/CellTransit.cs:936-964).
- Before that it tries `FindVisibleChildCell(useStabList:true)` (695-735, the port of `CEnvCell::find_visible_child_cell`, D: `CEnvCell::find_visible_child_cell`).
- It sets `containingCellFound=false` only so that **placement** can be rejected (O/TransitionTypes.cs:2509-2514).
- Its test `A9B3Cottage_GapBeyondStraddleDistance_KeepsCurrCell_RetailGate` (O tests/AcDream.Core.Tests/Conformance/DoorwayCellMembershipTests.cs:48) pins this behaviour.
- `PlacementContainmentTests.cs:11-16` documents the split: "the ordinary movement path keeps its seed-cell fallback… placement must not inherit that fallback".

**Fix.** In `check_other_cells` LABEL_6, when there is no winner and the cell is indoor:
1. try the stab-list `find_visible_child_cell`;
2. otherwise keep the previous `check_cell`;
3. return COLLIDED only for Placement or InitialPlacement inserts.

This is cheap and turns every remaining membership error into "walls still collide" instead of "fall through".

---

## F3 — Membership tests use the FEET point; retail uses the sphere[0] centre, about 0.475 m higher (HIGH-MED)

- **Retail and OpenAC** test `sphere->center`:
  - `find_cell_list` local point = `sphere->center - block_offset` (D:~347040);
  - OpenAC uses `worldSpheres[0].Origin` (O/CellTransit.cs:842, 921).
- **holtburger.** The driver's own pick is correct: `spheres[0].center` at objcell.rs:~412. But every out-of-driver test uses `pos.global_coords()`, which is the feet position (the capsule centres sit at `capsule[0].0` above it; faithful_bridge.rs:~104-118):
  - `current_cell` (scene.rs:2692);
  - `entered_envcell_for_outdoor_pose` (2925);
  - `exited_envcell_to_outdoor` (3137).
- **Effect.**
  - The entry sphere reaches 0.48 m **below** ground, so cells just under the terrain (tunnel ceilings, the mouth ramp) qualify. This feeds F1.
  - Point membership is tested exactly on the floor plane, so a ramp descending into a tunnel can classify as outside the cell. `current_cell` then falls to the loose-AABB scan.
- **Fix.** Use `feet + (0,0,capsule[0].0)` and radius `capsule[0].1` for every membership query, or drop these queries per F1(c).

---

## F4 — `adjust_to_outside` in the driver is a stub that yields cell `LB|0000` and an empty ring (MED)

- **Retail.** `check_other_cells` outdoor tail runs `LandDefs::adjust_to_outside` (decomp :467434) and re-seats `check_pos` into the real outdoor cell.
- **OpenAC.** `LandDefs.AdjustToOutside` (O/LandDefs.cs:66-84) is used for both the ring and the pick (CellTransit.cs:292, 911).
- **holtburger.**
  - `adjust_to_outside_seam` (H/.../transition/driver_cell_dispatch.rs:43-51) is documented as "NOT a faithful landblock-grid walk". It sets `cell_id &= 0xFFFF0000`, which is cell low word 0.
  - It is called at 230.
  - On the next `find_cell_list`, `add_all_outside_cells_sphere` (objcell.rs:666-711) calls the real `SpatialScene::adjust_to_outside` (faithful_bridge.rs:923). That rejects low word 0 (`cell_in_range`), so the loop breaks with **no cells**, which means no terrain for the rest of that transition.
- **Trigger.** Any outdoor step whose `point_in_cell` pick fails: landblock seams (F5), or more than 64 m from the terrain z band (F7).
- **Fix.** Route LABEL_6 through `CellWorld` and call the real `adjust_to_outside`, converting the point to block-local and back exactly as `SceneWorld::add_all_outside_cells` does (faithful_bridge.rs:~808-838).

---

## F5 — World-frame driver still applies retail's block-local `get_block_offset` (MED, landblock edges)

- **The bridge runs in WORLD space** (faithful_bridge.rs:45-53: "get_block_offset is 0 within one landblock (the only case Phase A exercises)"). Yet `get_block_offset` gives ±192 m whenever two ids differ in their high word.
- **Pick failure.** `SceneWorld::block_offset` → `LandDefs::get_block_offset` (faithful_bridge.rs:841-843). `find_cell_list` subtracts it from the world sphere centre before `point_in_cell` (objcell.rs:~409-412). When the centre crosses into the next landblock, the next landblock's cells test a point shifted by 192 m and fail, and the old landblock's cells don't contain it either. Result: no winner, then F4, then the rest of that transition has no collision and no step-down. Each landblock crossing can cause a one-frame airborne hop or worse; it gets more likely with multi-step frames (low fps or headless).
- **Other uses in the driver.**
  - `adjust_check_pos` (spherepath_methods.rs:377-387) would shift `check_pos` by 192 m if a cross-landblock pick ever succeeded.
  - `adjust_offset` push-out (driver_geometry.rs:131-149);
  - `cliff_slide` (driver_geometry.rs:198);
  - slide / `step_up_slide` (resolver_slide.rs:115, spherepath_methods.rs:287, driver_spine.rs:746);
  - contact-plane `d` rebasing (resolver_find.rs:187, resolver_step_down.rs:142).

  All of these are wrong across a landblock edge in the world frame.
- **OpenAC** works in world space and simply has **no** block offset in `AdjustOffset` (O/TransitionTypes.cs:3618-3700). It tracks a `CarriedBlockOrigin` only for the outdoor ring and pick (CellTransit.cs:846-856; TransitionTypes.cs:2533-2546). Its tests `CellMarchLandblockPreservationTests` and `LandDefsBlockOffsetTests` pin landblock-edge behaviour.
- **Fix.** Make `CellWorld::block_offset` return zero in the world-frame bridge, and add a `world_frame` flag on `CTransition` that zeroes `LandDefs::get_block_offset` at the driver sites above. `add_all_outside_cells` already localises by the landblock origin, so the ring stays correct.

---

## F6 — `bldg_check` is never set, so building shells are "centre-solid" during placement inserts inside an interior (MED)

- **Retail.** `CBuildingObj::find_building_collisions` (D:719116-719129) sets `sphere_path.bldg_check = 1` around the building part's BSP. `BSPTREE::find_collisions` placement branch (D:361344-361351) then uses `center_solid = (hits_interior_cell == 0)`. While an interior cell is in the array, a sphere centred inside the building shell's solid is **not** a placement collision.
- **OpenAC.** `FindBuildingCollisions` sets `sp.BldgCheck = true` (O/TransitionTypes.cs:2966, cleared at 2988). This is consumed as `clearCell = !(BldgCheck && HitsInteriorCell)` (O/BSPQuery.cs:1310; FlatBspQuery.cs:1802).
- **holtburger.**
  - Reads the flag in H/.../transition/resolver_find.rs:106-110, but **nothing ever sets it true** (rg shows only defaults/resets in types.rs:432, driver_init.rs:159).
  - Building shells are plain statics in `find_obj_collisions` (faithful_bridge.rs:~596-630).
  - So every Placement re-insert near a doorway or dungeon-entrance building is COLLIDED. That covers the collide → `check_walkable` → Placement re-insert, and the step-up/step-down final placement pass.
  - The result is restore, kill-velocity, step-down failure, then edge-slide or airborne. Expect "stuck / hop / drop" at thresholds.
- **Fix.**
  - Tag building GfxObj statics (from LandBlockInfo buildings) when staging them.
  - In `find_obj_collisions`, set `sphere_path.bldg_check = true` around those trees.
  - Set `collided_with_environment` on a non-contact hit (D:719126-719127).

---

## F7 — Outdoor `point_in_cell` uses an AABB with a ±64 m z band; retail is 2D (LOW-MED)

- **Retail.** `CLandCell::point_in_cell` = `find_terrain_poly(point) != 0` (D:354881), an XY test with any z.
- **holtburger.**
  - Outdoor cells are given an AABB padded by `OUTDOOR_AABB_Z_PAD = 64.0` (faithful_bridge.rs:872, built in `build_outdoor_cell` 1062-~1105).
  - `point_in_cell` uses it (432-457).
  - Falling or standing more than 64 m above the corners, or an outdoor-ring pick from a deep dungeon cell (cells reach z −324; see the 08-13 architecture doc §5), fails the pick. That leads to F4/F2.
- **Fix.** For cells with `terrain_polys`, use an XY footprint test (or `find_terrain_poly`).

---

## F8 — Bounded transit flood plus build-time neighbour resolution (LOW)

- `MAX_PORTAL_HOPS = 2` (faithful_bridge.rs:133). Neighbours at the leaf depth carry empty `resolved_neighbours`.
- Retail's flood is unbounded, gated per cell by `sphere_intersects_cell` (D:348250-348401).
- Short connector cells at tunnel mouths can put the cell that owns the exterior portal 3 or more hops away.
- Non-resident neighbours are dropped instead of added with a null handle via the portal-side test (D:~348350-348395; OpenAC CellTransit.cs:116-131, which uses EPSILON 0.02 where retail uses 0.0002).
- **Fix.** Resolve neighbours lazily through `world.get_visible` at transit time; `CELL_HANDLE_CACHE` already makes that cheap.

---

## F9 — Pipeline mixing at mouths (LOW-MED, operational)

- The faithful bridge delegates to the approximate pipeline when the begin landblock's terrain is not resident or the begin EnvCell has no physics BSP (faithful_bridge.rs:1261-1268).
- The approximate path has its own AABB-containment nets and doorway relaxations (transition.rs:~640-700).
- Mouth cells streaming in late can therefore flip a frame between two collision models with different floors and membership.
- **Fix.** Refuse motion (hold position) instead of delegating while cells stream, or log the delegation to `__diag`.

---

## Things holtburger already matches

- `find_cell_list` structure, ordering, the last-outdoor / first-interior pick, and the do_not_load prune: objcell.rs:345-460 vs D:346961-347100.
- `check_other_cells` dispatch: driver_cell_dispatch.rs:151-241 vs D:312381-312470.
- `transitional_insert` null-cell early-out (driver_spine.rs:124 vs D:312859). Faithful, but see F2.
- Exterior-portal straddle band `-r < d < r` (faithful_bridge.rs:532-547 vs D:~348320). It omits the +0.0002 pad; negligible.
- The terrain contact plane is now world-frame (faithful_bridge.rs:~295-340, COL-16/17).

## OpenAC regression-test names worth porting as fixtures

All under `tests/AcDream.Core.Tests/`:
- `Conformance/DoorwayCellMembershipTests.cs`:
  - `A9B3CottageGap_AtDoorway_StraddlesExitPlane_DemotesRetailFaithfully`
  - `..._GapBeyondStraddleDistance_KeepsCurrCell_RetailGate`
  - `..._OutdoorSeed_TickSkippedThreshold_RecoversViaGrowingWalk`
  - `..._RunSpeedEntryReplay_NeverStrandsOutdoor`
  - `ThresholdCottage_AdjacentClaim_LaterallyRecovers_ViaStabGraph`
- `Conformance/ThresholdPortalCrossingReplayTests.cs`
- `Physics/CellMarchLandblockPreservationTests.cs` (landblock-edge pick)
- `Physics/PlacementContainmentTests.cs` (placement must not commit outside every cell)
- `Physics/RetailStepDownPlacementTests.cs` (`StepUp_UsesTheSameFinalPlacementPass`, `SupportedCandidate_OverlappingDuringPlacement_IsRejected`)
- `Physics/CellarLipWedgeTests.cs`
- `Physics/FindEnvCollisionsMultiCellTests.cs`

## Suggested order

1. F2: no-null `check_cell` for movement. Smallest change, biggest safety net.
2. F1(c) + F3: marshal the driver's `curr_cell`; sphere-centre membership.
3. F1(a/b): building transit for outdoor cells.
4. F4 + F5: real `adjust_to_outside`; zero block offsets in the world-frame bridge.
5. F6: `bldg_check`.
6. F7, F8.

For each step, add a fixture shaped like `dungeon_mouth_jump_off_the_side_lands_on_terrain` (faithful_bridge.rs:~2483): walk over the hill above a shallow tunnel cell, approach the mouth from the side, and cross a landblock line at 30 fps with 3 steps per frame.
