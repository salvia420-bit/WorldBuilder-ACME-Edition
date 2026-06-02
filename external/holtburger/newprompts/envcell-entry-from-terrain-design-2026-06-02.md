# EnvCell entry-from-terrain — client-side design + staged plan
_Source: deep-dive workflow wf_0f78c568-8be (6 facets, adversarially verified), 2026-06-02._

All facets are verified with file:line refs already provided. The two verifier corrections (facet 3 claim 10 about cell_bsp node contents, and facet 6 claims 3+8 about USE_LOCAL_FORCE_POSITION_CONSTRAINT) are the load-bearing nuances I must reflect. I have everything needed to write the design doc directly. No further tool calls required.

# Terrain -> EnvCell entry: client-side design for holtburger

## 1. The canonical entry mechanism

**Retail/ACE determines "I entered EnvCell X" CLIENT-LOCALLY, every physics tick, with zero server round-trip.** This is the load-bearing answer and it is confirmed in the decompiled retail client, not just ACE.

Per-tick chain (all in-process, all from loaded DAT geometry):

```
CPhysicsObj::update_object (acclient.c:323081)
 └ UpdateObjectInternal (acclient.c:322719)
    ├ UpdatePositionInternal           # local velocity integration -> new_pos
    └ if new_pos.origin != m_position.origin:   # acclient.c:322781 fast-path gate
        transition(this, &m_position, &new_pos, 0)   (acclient.c:322812 / 320061)
         └ find_valid_position (acclient.c:313419)
            └ find_transitional_position (acclient.c:313171)
               └ CObjCell::find_cell_list (acclient.c:346961 / ObjCell.cs:335)
```

`find_cell_list` is the cell-discovery engine:

1. If `(ObjCellID & 0xFFFF) >= 0x100` (already indoors): set `path.HitsInteriorCell = true`, add current EnvCell (ObjCell.cs:344–345).
2. Else (outdoors): `LandCell.add_all_outside_cells()` adds the 1–4 terrain cells the sphere footprint overlaps.
3. For each cell in the array, call its `find_transit_cells` vtable slot. For an outdoor `SortCell` that owns a building: `SortCell.find_transit_cells` -> `BuildingObj.find_building_transit_cells` (acclient.c:719068 / SortCell.cs:33–37, BuildingObj.cs:54–62). This iterates the building's `CBldPortal` list and calls `EnvCell.check_building_transit(otherCell, portal.OtherPortalId, …)`.
4. **`check_building_transit` (acclient.c:348110 / EnvCell.cs:128–143) is the sole outdoor->indoor trigger.** It transforms each player sphere into the EnvCell's local frame (`Frame.GlobalToLocal`), then calls `CCellStruct::sphere_intersects_cell` — **the CellBSP, NOT the PhysicsBSP** (confirmed acclient.c:348139 + 355502–355504, CellStruct.cs:65–67). If the result is not `Outside`: set `path->hits_interior_cell = 1` (acclient.c:348147) and add the EnvCell to `cellArray`. Guarded on `portal_id != ushort.MaxValue` (0xFFFF = no opposing interior portal -> skip).
5. After transit discovery, the point-in-cell scan picks the winner: for each cell, `point_in_cell(localPoint)` via `CCellStruct::point_in_cell` -> `CellBSP.point_inside_cell_bsp` (acclient.c:355496, plane-only walk at 362944). First cell with low-word `>= 0x100` whose test passes becomes `curr_cell`, and `HitsInteriorCell` is set again (ObjCell.cs:380).

The cell-id write happens locally, ahead of any packet: `SetPositionInternal` (acclient.c:322504) writes `m_position.objcell_id` (same-cell, 322541) or calls `change_cell` -> `enter_cell` which writes `m_position.objcell_id = new_cell->m_DID.id` (acclient.c:318229) and `this->cell = new_cell` (318237). `SmartBox::HandleReceivedPosition` (acclient.c:145125) does NOT call `transition()` for non-teleport player corrections — it only sets PositionManager targets (ConstrainTo/InterpolateTo), consumed on the next tick. **No server message participates in the entry decision.**

**Shell + doorway solidity rule.** A cottage is three independent meshes:
- Shell (exterior walls/roof) = `CBuildingObj.part_array` GfxObj physics BSP, queried via `SortCell.FindCollisions` -> `BuildingObj.find_building_collisions`.
- Interior walls = each EnvCell's `CellStruct.PhysicsBSP`, queried via `EnvCell.FindEnvCollisions` only once the cell-id is an EnvCell id.
- Doorway = a hole cut into the interior BSP via the portal polygon (`CellPortal.PolygonId` -> `CellStruct.Polygons[]`), with a `PortalSide` half-space flag.

The shell becomes transparent the moment entry is detected: `find_building_collisions` brackets the shell BSP query with `bldg_check = true/false` (acclient.c:719123–719125 / BuildingObj.cs:44–46), and inside the BSP traversal `v25` ("treat as solid") = `(hits_interior_cell == 0)` only when `bldg_check` is set (acclient.c:361347–361348). So once `check_building_transit` has flipped `hits_interior_cell`, the exterior wall mesh stops blocking — the player passes through the wall plane that the doorway occupies while the interior PhysicsBSP (doorway cut in) takes over.

`PortalSide` sign convention: `PortalSide = !(Flags & 0x2)` (CBldPortal.cs:13, CellPortal.cs:14, confirmed).

## 2. Data prerequisites — PRESENT vs MISSING in holtburger today

| Piece | Status | Where loaded / why not used | file:line |
|---|---|---|---|
| EnvCell frames (position + orientation) | **PRESENT, used** | `buildEnvCellsForLandblock` reads `envcell.position.origin/orientation`; used for cell_physics_bsp origin/orientation and cell_aabbs | lib.rs:11838; scene.rs:263–266 |
| `cell_bsp` (BspType::Cell — the membership tree) | **PARSED, then DROPPED** | Parsed into `CellStruct.cell_bsp: Option<BspNode>` but no insertion path into SpatialScene; wasm pipeline stores only `physics_bsp` | environment.rs:42,103; lib.rs:12023 (physics_bsp only) |
| cell_bsp node contents | **CORRECTION** | cell_bsp nodes hold **only splitting planes + child pointers** — NO sphere bound, NO `InPolys` index list (those live only in Drawing BSP). The earlier claim that it holds "planes and indices" is FALSE | DatLoader BSPNode.cs:74–75; holtburger-dat physics.rs:1116–1123 |
| Cell portals (EnvCell->EnvCell edges + outdoor-exit markers) | **PRESENT, used (render only)** | Edges `(cell_id, landblock_high\|other_cell_id)` pushed to cell graph; outdoor-exit = `other_cell_id >= 0xFFFE`; portal polygons -> `scene.cell_portal_polygons` used by PView frustum-clip only | lib.rs:11882–11916, 12068–12115; env_cell.rs:60–68 |
| Building->cell portal links (`BuildInfo.portals[]` = `CBldPortal`) | **PARSED, NEVER CONSUMED** | `PortalInternal { flags, other_cell_id, other_portal_id, stab_list }` parsed; `populate_building_aabbs` only reads `model_id`/`frame` — `build_info.portals` is never touched | landblock.rs:37–50; lib.rs:9435–9442 |
| `physics_bsp` (interior collision tree) | **PRESENT, INERT** | Stored into `scene.cell_physics_bsp` (drained on TickMovement) but `USE_PHYSICS_BSP = false` keeps the solver out of the integrator | environment.rs:43,112; lib.rs:33674; system.rs:269 |
| Cell AABBs (mesh bbox -> world) | **PRESENT, gated** | In `scene.cell_aabbs`; `current_cell` AABB scan runs **only when `pos.is_indoors()` is already true** — never queried for an outdoor pose | lib.rs:11855–11881; scene.rs:1038–1075 |
| `is_indoors()` geometry override | **MISSING** | `(landblock_id & 0xFFFF) >= 0x0100` — pure arithmetic on server-stamped id; no geometry-derived flip exists | position.rs:75–79 |
| `bldg_check`/`hits_interior_cell` shell-transparency gate | **MISSING entirely** | No counterpart; building shell collides via AABB push-out (`clamp_delta_against_buildings`), never goes transparent | system.rs:1390–1412 |

**Bottom line:** the EnvCell *frame*, the *building->cell portal links*, the *physics_bsp*, and the *cell AABBs* are all in memory client-side before the server transition fires. The membership tree (`cell_bsp`) is parsed but dropped. The *only* path that can flip `is_indoors()` today is a server `UpdatePosition`/`PrivateUpdatePosition`.

## 3. Proposed client design

Mirror the retail chain but scoped to the minimum that engages collision on entry. Use the building-portal links to bound the search (do not scan all EnvCells).

**(a) Local cell-membership / point-in-cell test using loaded geometry.**
- Add a `cell_membership` map keyed by EnvCell id storing `{ cell_bsp: BspNode, origin, orientation }` — populate it in the same drain that today fills `cell_physics_bsp`. Edit points: lib.rs:12023–12054 (clone `cell_struct.cell_bsp` alongside `physics_bsp`), and a parallel `scene.cell_membership` field + drain near scene.rs:338 / lib.rs:33674.
- Wire the building->cell links: in `populate_building_aabbs_for_landblock_impl`, also read `build_info.portals[].other_cell_id` and emit a `building_id -> [EnvCell ids]` (and reachable `stab_list`) map into the scene. Edit point: lib.rs:9435–9442 (the loop that currently ignores `portals`).
- Implement `sphere_intersects_cell_bsp` and `point_inside_cell_bsp` (plane-only walk; cell_bsp has no polys, per the §2 correction — the traversal is exactly the retail `BSPNODE::point_inside_cell_bsp` at acclient.c:362944: follow `pos_node`, within ±EPSILON return on-plane, fall off the end -> inside). New helper in holtburger-world/src/spatial/physics.rs near the existing `CellPhysicsBsp::world_to_local` (scene.rs:274–283 has the transform to reuse).

**(b) Flip `is_indoors` locally instead of waiting for the server.**
- In `advance_local_pose_for_manual_drive_slice` (system.rs:1051), after the lateral step is computed and BEFORE the `pose.is_indoors()` branch selector at system.rs:1286: if `!pose.is_indoors()`, run a `check_building_transit` equivalent — for each building near the pose, for each `other_cell_id` portal, transform the player sphere into that EnvCell's frame and run `sphere_intersects_cell_bsp`. On the first hit, set `pose.landblock_id` to `landblock_high | other_cell_id` (the indoor cell id). This is `check_building_transit` in ~10 lines.
- This makes `pose.is_indoors()` return true on the SAME tick, so the indoor branch (per-poly clamp) fires immediately. Edit point: system.rs ~1280 (just above the 1286 gate); the existing outdoor `rebucket_outdoor_landblock` call at system.rs:2057 stays as-is for the indoor->outdoor exit (it is gated `!is_indoors()`).

**(c) Engage cell-wall + (M6) BSP collision on entry.**
- Once `is_indoors()` is true, the indoor branch already runs the cell-triangle clamp (`clamp_delta_against_cell_walls`, physics.rs:682) and `current_cell` will now correctly disambiguate the sub-cell via the AABB scan (scene.rs:1038–1075). That path is already correct for post-transition movement — no change needed beyond (b).
- M6 (the faithful interior PhysicsBSP solver) is a follow-on: flip `USE_PHYSICS_BSP = true` (system.rs:269) and wire the `cell_physics_bsp` solver into the indoor branch. Keep it false for the initial fix — the cell-triangle clamp already exists and is sufficient to stop pass-through. Membership (cell_bsp) and collision (physics_bsp) are independent; (b) only needs membership.

**(d) Shell + doorway handling client-side.**
- Add a `hits_interior_cell` bool to the movement step state. When (b) flips the cell id (or detects sphere overlap with any entry EnvCell), set it true for that tick.
- In the outdoor building-collision branch (system.rs:1390–1412, `clamp_delta_against_buildings`), gate the shell clamp: when `hits_interior_cell` is true, **skip the shell AABB push-out** so the player passes the doorway plane — this is the holtburger analogue of retail's `v25 = (hits_interior_cell == 0)` (acclient.c:361347). Without this gate, the conservative shell AABB would block the doorway. This is the load-bearing pairing: (b) flips the cell, (d) makes the shell transparent the same tick.
- Note the holtburger shell is a conservative *AABB*, not the faithful shell physics BSP (the `building_physics_index` triangles at lib.rs:9609–9641 are wired only to camera collision). The AABB is coarser than retail's BSP, so the transparency gate must key on the geometry membership test, not on the AABB itself, to avoid a one-tick block at the threshold.

## 4. Server reconciliation

The locally-flipped indoor cell id must survive the next few server broadcasts, then yield to a genuine server correction.

- **Preserve during simulation:** `reconcile_authoritative_body` (scene.rs:1543) keeps `body.pose` when the body is a LocalPlayer in `SimulatingMotionState | SimulatingVelocity` (scene.rs:1562–1567). The locally-set `landblock_id` rides through routine broadcasts as long as the integrator is simulating.
- **CORRECTION — the "snapshot only on Reset" claim is FALSE.** `USE_LOCAL_FORCE_POSITION_CONSTRAINT = true` is the live default (scene.rs:31). In the Snapshot + Simulating* branch the code calls `constrain_local_pose_toward(body.pose, pose)` (scene.rs:1620–1622), and that function returns a pose with `landblock_id: target.landblock_id` (scene.rs:157) whenever drift is in (`RECONCILE_DEADBAND_M=0.05 m`, blip=25 m indoor]. So when the server confirms the same (or a nearby) indoor cell, `body.pose.landblock_id` is overwritten with the server value — which for a correct local prediction is identical, hence harmless. Practically: a correct local flip is silently confirmed; a wrong local flip is corrected within the 25 m band on the next `UpdatePosition`.
- **`UpdatePosition` drives the indoor id regardless of the 5 m guard.** The local-player `UpdatePosition` path (lib.rs:28371) unconditionally calls `set_player_position` -> `update_player_position` (mutations.rs:566–613) -> reconcile. The 5 m snap threshold belongs only to `PrivateUpdatePosition` (lib.rs:28508) and does NOT protect the indoor transition — `UpdatePosition` does. (The earlier "5 m guard protects the local flip" claim is FALSE; its premise — that the integrator already flips landblock_id — never held before this change.)
- **Hard reset always wins:** `AuthoritativeBodySync::Reset` sets `SpatialSampleMode::Suspended` (scene.rs:1554), fails the Simulating* test, and hard-snaps `body.pose = pose` (scene.rs:1624). A server force-reposition (e.g., "you entered the wrong cell") overrides the local flip; the next movement tick re-arms Simulating* and prediction resumes.
- **Seeding:** first `UpdatePosition`/`PrivateUpdatePosition` stamps the cell id directly (lib.rs:28248, 28458–28465). After (b) ships, the first packet still wins on seed — local flips only matter after seeding, mid-traversal.

Net: **trust local on entry; let `UpdatePosition`/reconcile confirm or gently correct within the constraint band; let Reset hard-override.** No new reconciliation state is required — the existing `constrain_local_pose_toward` path already adopts the server cell id when it differs.

## 5. Staged implementation plan

**Stage 0 — store cell_bsp + building->cell links (data wiring, no behavior change).**
- Clone `cell_struct.cell_bsp` into a new `CellMembership` pending struct alongside the physics_bsp clone: lib.rs:12023–12054.
- Read `build_info.portals[].other_cell_id` (+ `stab_list`) into a `building_id -> entry EnvCell ids` map: lib.rs:9435–9442.
- Add `scene.cell_membership` + `scene.building_entry_cells` fields and drains: scene.rs ~338, lib.rs:33674.
- Validation: WB.Terminal `chorizite-dump-layout-tree` / `dump-lb-expectations` on the Holtburg cottage LB (0xA9B4) to confirm the parsed `other_cell_id` set matches the EnvCell ids; assert `scene.cell_membership.len()` equals the cottage EnvCell count. No movement change to test yet.

**Stage 1 — membership predicate.**
- Implement `point_inside_cell_bsp` + `sphere_intersects_cell_bsp` (plane-only walk, no polys) in holtburger-world/src/spatial/physics.rs, reusing `world_to_local` (scene.rs:274–283).
- Validation: `#[cfg(test)]` unit test seeding a known cottage cell_bsp + a point known to be inside (foot of a spawn inside the cottage) and one outside the doorway; cross-check against ACE `CellStruct.point_in_cell` output for the same cell via a WB.Terminal one-shot oracle (`dotnet <dll>` long-lived worker, the Wave-4 pattern).

**Stage 2 — local is_indoors flip (the fix).**
- Insert the `check_building_transit` equivalent at system.rs ~1280, just above the gate at 1286: outdoor pose -> probe entry EnvCells via Stage-1 predicate -> set `pose.landblock_id` to the indoor id; set step-state `hits_interior_cell`.
- Validation: wire-agent scenario. `?autoLogin=1&autoSpawn=first&renderer=3d&agentic=low&nullRender=1&diag=1`, teleport just outside the Holtburg cottage doorway, walk forward via scripted manual-drive, poll `window.__diag` / wasm pose getter for `landblock_id & 0xFFFF >= 0x100` **before** the next server `UpdatePosition` arrives (drain net at low Hz to widen the window, `netDrainHz`). Pass = indoor id appears within ~1–2 ticks of crossing the doorway plane, with the net paused.

**Stage 3 — shell transparency gate at the doorway.**
- Gate `clamp_delta_against_buildings` on `hits_interior_cell` (skip shell push-out when true): system.rs:1390–1412.
- Validation: same wire-agent scenario; assert the player coordinate advances through the doorway plane (no AABB rejection one-tick stall) and the interior cell-wall clamp then stops the player at the back wall. Compare X/Z trajectory against a retail-physics replay trace (the Wave-3.F `OracleSim` / `physics-replay-trace` harness) for the same entry path; target maxDrift in the existing 0.04–0.09 m band.

**Stage 4 — reconciliation soak.**
- No code change expected; confirm Stage-2/3 coexist with live server. Validation: run the full agentic-login entry with net live, capture `body.pose.landblock_id` across the entry frame and the following 5–10 server `UpdatePosition` packets; assert no rubber-band (no >0.05 m snap) when server confirms the same cell, and a clean correction (no oscillation) if the server disagrees. Cross-check `reconcile_authoritative_body` takes the `constrain_local_pose_toward` branch (scene.rs:1620), not Reset, for a normal entry.

**Stage 5 (follow-on, optional) — M6 faithful interior BSP.**
- Flip `USE_PHYSICS_BSP = true` (system.rs:269), wire `cell_physics_bsp` solver into the indoor branch for true wall normals/step-up. Independent of the entry fix; do only after Stages 0–4 are validated.

## 6. Open questions / risks before coding

1. **Sphere radius + sphere set.** Retail tests every sphere in the player capsule against the cell hull (`for each sphere` in `check_building_transit`). Holtburger's collision sphere radius and how many spheres the manual-drive integrator uses for this probe are not pinned down here — need to confirm the radius used so the membership probe matches the clamp radius (otherwise entry flips at a different distance than collision engages). **Not confirmed from sources; verify in system.rs before Stage 2.**
2. **`other_portal_id` guard semantics.** Retail skips transit when `OtherPortalId == 0xFFFF`. Holtburger's `PortalInternal.other_portal_id` is parsed but its 0xFFFF meaning was not independently re-verified for the building (CBldPortal) side here. Confirm before relying on it to filter candidate cells.
3. **Coarse shell AABB vs precise doorway.** Holtburger's shell is an AABB, not the retail shell BSP. The doorway is narrower than the AABB face. The transparency gate (Stage 3) keys on the membership test, but there is a window where the sphere is past the AABB face yet not yet inside the cell hull. Risk: a one-tick block or a one-tick pass-through at the threshold. Mitigation: trigger transparency as soon as the sphere overlaps the entry cell hull (sphere_intersects, not point_in_cell) — matching retail's `check_building_transit` which uses the sphere test, not the point test.
4. **Multiple candidate cells / which cell wins.** Retail's point-in-cell scan picks the first `point_in_cell`-true cell with low-word >= 0x100. With overlapping cottage cells (foyer + room) the order matters. Use the same first-match-wins rule and feed candidates in the building's portal order; confirm holtburger's existing `current_cell` AABB scan ordering agrees once indoors so the membership flip and the AABB disambiguation don't pick different cells.
5. **cell_bsp absence for some cells.** If any entry EnvCell has no `cell_bsp` (None), the membership probe must fall back (e.g., to the cell AABB) rather than silently failing to flip. Decide the fallback before Stage 2.
6. **Exit symmetry.** This design covers outdoor->indoor entry. Indoor->outdoor exit currently relies on `rebucket_outdoor_landblock` (gated `!is_indoors()`, system.rs:2057) — which only runs once already outdoors. Verify the exit transition (indoor cell -> outdoor LandCell through the same doorway) still works after the entry flip; retail handles it via `EnvCell.find_transit_cells` walking outdoor-exit portals (`other_cell_id == 0xFFFF`). Exit may need its own probe; out of scope for the entry fix but must not regress.
7. **Server-disagreement direction.** §4 establishes the server can overwrite the local cell id within the 25 m band via `constrain_local_pose_toward`. If the local flip is correct but arrives a few ticks before the server's, confirm the intervening server `UpdatePosition` (still carrying the *outdoor* cell id) does not flip the player back outdoors and cause a flicker. This is the most likely visible artifact; validate explicitly in Stage 4.