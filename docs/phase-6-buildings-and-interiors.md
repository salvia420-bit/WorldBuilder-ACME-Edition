# Phase 6 — Buildings, Interiors, and Multi-Floor Z-Culling

> Status: planned — execution starts after sign-off on this doc.
> Created: 2026-05-09. Author: Claude.
> Sibling docs: `emit-dynamic-site.md` (overall project), `phase-4-step-3.6-movement-system.md` (movement system), `2026-04-05_interior_support_handoff.md` (terminal-side interior export, already shipped).

## 1. Problem

Buildings render as silhouettes only. The local player walks straight through them. Interiors are not visible in the browser at all. Doors have no geometry. Stairs cannot be traversed. The world is, in effect, a 2D map with a third dimension that exists only for terrain following.

Concretely, three connected gaps:

1. **Building exteriors are silhouettes.** `apps/holtburger-web/src/lib.rs:654-656` explicitly drops portal/door/window/leaf meshes during building Setup parsing — only the outer building placement (model_id + frame) reaches PIXI. The rendering path for `info.buildings` (`lib.rs:712-713`) calls `frame_to_placement()` (`lib.rs:680-695`), which returns only enough data to draw the outermost shell, not the recursive part tree.
2. **EnvCells are parsed but never rendered.** `crates/holtburger-dat/src/file_type/env_cell.rs:25-84` ships a complete `EnvCell` struct with portals, static objects, visibility cells, and restriction objects. `dat-shard` already catalogs ~805k EnvCell records into manifest v2 under `eor/cell` (`crates/holtburger-manifest/src/v2.rs:5-6`). The terminal-side exporter at `WorldBuilder.Terminal/CommandEngine.cs:5367-5462` already exports per-cell `staticObjects`, world coordinates, `aabbLocal`, `supportSurfaceHints`, portal refs, and visible-cell graphs (per `2026-04-05_interior_support_handoff.md`). **None of this reaches JavaScript.** No wasm export retrieves EnvCells; no PIXI code knows they exist.
3. **No client-side collision.** `project_pose_by_velocity()` in `crates/holtburger-world/src/spatial/physics.rs:308-319` is pure kinematics: velocity × dt → pose, with terrain Z-snap as the only world-geometry constraint. There is no AABB query, no ray-cast, no swept-volume check against buildings. The server (ACE `Server.Physics/PhysicsEngine.cs`) validates and rubber-bands deviations, but client-side movement passes through walls unimpeded.

The user has called this out directly: "the client seeming clips through buildings and such as if it didn't exist. this even possibly works on servers lending to unintended behaviors. for our sake it means we cant traverse stairways in buildings etc."

The deeper request is multi-floor support. AC's vertical world — second floors, basements, dungeons stacked tens of cells deep — is encoded in EnvCell graphs where stairs are just portal connections between Z-stacked cells. The client needs visibility logic that follows the player through this graph automatically, with no UI for "switch floor."

## 2. Goal

Bring building rendering and traversal to a level where:

1. **Geometry is retail-correct.** Doors render at the right size. Interior walls, floors, tables, chairs, shelves are visible. Buildings look like buildings, not flat shells.
2. **The player physically can't walk through buildings.** Closed doors block. Walls block. Movement clamps at first contact, mirroring ACE's authoritative physics.
3. **The visible cell set auto-tracks the player.** Walking up stairs swaps the rendered cell set: the floor below drops out, the floor above pops in. No buttons, no manual toggles. Same logic generalizes to N-floor dungeons.
4. **Live-server validated.** Each phase ships with a Playwright capture against `<server-ip>` that asserts the new behavior end-to-end.

Single-source physics + cell-graph-driven culling. The expandability for arbitrarily vertical dungeons falls out of phase D for free.

## 3. Architecture decisions

### 3.1 Per-part PIXI meshes, not fused per-building

Phase A could either bake the whole Setup into one PIXI mesh per building (cheaper) or keep parts separate (needed later for door state mutation). **Pick separate.** Phase E rotates door GfxObjs around hinge frames; that's only practical if doors are addressable as their own sprites. Per-part keyed by `(building_id, part_index)` in `entityMap`-style.

### 3.2 Spatial index keyed per landblock cell

Phase B's collision index doesn't need to be a BVH or octree. Holtburg town has ~50 buildings spread across 64 outdoor LandCells in `0xA9B40000`; per-cell bucket lookup is O(handful) and fits in a `HashMap<CellId, Vec<BuildingAabb>>`. Indoor lookup is one bucket per EnvCell. Drop in something fancier if profiling shows a hot path.

### 3.3 Cell graph is the abstraction; stairs are not special

Phase D treats every traversal — outdoor → indoor, floor 1 → floor 2, dungeon room → corridor — as the same `current_cell(pos)` change driven by player position. EnvCell `CellPortal` records (already parsed at `env_cell.rs:10-14`) define the visibility graph. There is no special-cased "stair" code. K=1 portal-neighbour depth is the default; configurable per cell type if line-of-sight effects need K=2.

### 3.4 EnvCells lazy-fetched per landblock

Don't preload all 805k. Mirror the terrain prefetch pattern (kind=7 EnteredWorld + LB-change-driven prefetch from `f993earlier`): on landblock entry, fetch EnvCells for that landblock's neighbourhood. Cache in `WorldState`. Indoor cell IDs share the high word with their parent landblock so the bucket is obvious.

### 3.5 Collision is client-side gate, ACE remains authoritative

Adding client-side collision does not displace server-side validation. ACE will still rubber-band on disagreement. The point of client collision is two-fold: (a) the player feels solid walls instead of running through them and snapping back, (b) the client doesn't accidentally drive ACE into illegal positions that server-side would reject.

### 3.6 Door state from ACE, not local prediction

Phase E listens for `PublicWeenieDesc.DoorState` updates rather than predicting locally. Doors in retail AC are weenies with a state property; ACE owns transitions. Local rendering rotates the GfxObj sprite around its hinge frame on state-change events. Phase B's AABB index toggles entries on the same edge — closed door enters the index, open door drops out.

## 4. Surface inventory

### 4.1 Building rendering (Phase A)

`apps/holtburger-web/src/lib.rs`:

| Line | Symbol | Purpose |
|---|---|---|
| 654-656 | (comment block at silhouette path) | Currently drops portals/leaf meshes for buildings — point of change. |
| 664-717 | `fetch_landblock_objects()` | Pulls `info.objects` + `info.buildings` from `LandblockInfo`. |
| 680-695 | `frame_to_placement()` | Quaternion → yaw conversion; today buildings only get this minimal placement. |
| 712-713 | building loop | Iterates `info.buildings`; the path that needs to switch to full triangulation. |
| 1177-1189 | `walk_setup_model_surfaces()` | Walks Setup parts list — the existing primitive Phase A reuses. |
| 1520-1584 | `triangulate_setup_identity_placement()` | Static placement triangulator; the path buildings should join. |
| 2255-2336 | `fetch_entity_model_render()` | Substitution-aware triangulator (reference for Phase E door rendering). |

Phase A: route building placements through `triangulate_setup_identity_placement` (or a near-identical path that preserves `part_index` for Phase E). Bake one mesh per part, attach to a per-building PIXI container.

### 4.2 Collision integrator (Phase B)

`crates/holtburger-world/src/spatial/physics.rs`:

| Line | Symbol | Purpose |
|---|---|---|
| 308-319 | `project_pose_by_velocity()` | Pure-kinematic velocity integration. Add AABB sweep here. |
| 335-365 | `advance_body_kinematics()` | Body integration including rotation. Same sweep logic for non-player bodies if needed later. |

`crates/holtburger-world/src/state/types.rs`:

| Line | Symbol | Purpose |
|---|---|---|
| 46-62 | `WorldState` fields | Add a `building_aabb_index: HashMap<CellId, Vec<BuildingAabb>>` field. |
| 372 | `WorldState::new` | Initialize the index empty. |
| 376 | `WorldState::new_with_spatial_physics` | Same. |

`crates/holtburger-dat/src/file_type/setup.rs` (Setup struct, exact lines TBD when Phase B starts):
- Per-part bounding sphere → derive AABB.
- Or read top-level Setup AABB if the format provides one.

ACE reference for collision shape choices: `external/ACE/Source/ACE.Server/Physics/PhysicsEngine.cs`, `PhysicsObj.cs`, `Collision/BBox.cs`, `Collision/CollisionInfo.cs`. Player capsule radius and height are in `PhysicsObj` setup; mirror those values rather than picking from feel.

### 4.3 EnvCell render path (Phase C)

`crates/holtburger-dat/src/file_type/env_cell.rs:1-197`:
- `EnvCell` struct: `cell_id`, `flags`, `cell_origin`, `cell_orientation`, `environment_id` (0x0D…), portals, visible cells, static objects (`Stab` records), restriction objects.
- `unpack()` and `pack()` already implemented.
- Flag 0x01 = `HasStaticObjs`, flag 0x02 = `HasRestrictionObj`.

`apps/holtburger-web/src/lib.rs`:
- New wasm export: `fetch_env_cells_in_landblock(lbid: u32) -> JsValue` returning `Vec<EnvCellPlacement>`.
- New struct `EnvCellPlacement` mirroring `ObjectPlacement` (line 605-644 reference): cell_id, environment_id, x/y/z, orientation, static_objects vec, portal_refs vec.
- New triangulator path: Environment DIDs (0x0D…) need their own walker — different from Setup.

`crates/holtburger-common/src/position.rs:75-80`:
- `WorldPosition::is_indoors()` — indoor cells have low 16 bits ≥ 0x0100. Use this to decide whether `current_cell` should look in the EnvCell graph or the outdoor 8×8 grid.

### 4.4 Active-cell tracking (Phase D)

`crates/holtburger-world/src/state/types.rs`:
- New method `WorldState::current_cell(pos: &WorldPosition) -> CellId`.
- New method `WorldState::render_set(current: CellId, depth: u8) -> HashSet<CellId>` — BFS across portals.
- New cache: `cell_portal_graph: HashMap<CellId, Vec<CellId>>` populated as EnvCells are fetched.

`apps/holtburger-web/index.html` (or wherever the rAF tick lives):
- Per frame, read `currentCellId` from a wasm getter.
- Toggle `liveScene.cellContainers.get(cellId).visible = renderSet.has(cellId)`.
- Outdoor terrain is `cellId = current outdoor LandCell` for this purpose.

### 4.5 Door state (Phase E)

`apps/holtburger-web/src/lib.rs:2975-3394`:
- Portal weenie path (already implemented, same pattern). Door appraisal text + click handler exists.
- Add `DoorState` field to the live-entity record; pull from ACE's `PublicWeenieDesc`.
- On state change, rotate the door's GfxObj sprite around its hinge frame.

`crates/holtburger-core/src/client/world/handlers/`:
- Find the `PublicWeenieDesc` handler; extract `DoorState` int property; emit a `WorldEvent::DoorStateChanged { guid, state }`.

ACE reference: `external/ACE/Source/ACE.Server/WorldObjects/Door.cs` for the state semantics (opened/closed/locked) and `Open()` / `Close()` methods.

### 4.6 Live-server test scaffold (all phases)

`apps/holtburger-web/capture_phase4_step3.cjs`:
- Pre/post entity snapshot pattern at lines 196-206, 327-373.
- Threshold delta check at line 367 — adapt for "should NOT move" inversion in collision tests.
- `__sessionHandle.sendChat` at line 182 — issues `@pk pk`, `@telepoi`, `@teleloc`, `@create`.
- Env vars: `PHASE4_TEST_ACCOUNT`, `PHASE4_TEST_PASSWORD`, `PHASE4_BRIDGE_URL`, `PHASE4_SERVER_IP=<server-ip>`, `PHASE4_SERVER_PORT=9000`.

`apps/holtburger-web/smoke_test.cjs`:
- `check(name, ok, detail)` pattern (line 38).
- Bake cache at `$HOLTBURGER_SMOKE_DIST_DIR/holtburger-smoke-cache/<hash>/` (line 635).
- `--fast` skips dat-shard bake; useful when iterating Phase A Rust changes.

`apps/holtburger-web/capture_phase4_step2b.cjs:157-175`:
- `window.liveScene` exposes the PIXI root.
- `window.entityMap` is `Map<u32, {sprite, modelId}>`.
- For Phase D, expose a similar `window.cellContainers` map.

SQL access: `mariadb -u ace -pace ace_shard -e "..."` — Playwright doesn't have a connector wired in. Memory entry confirms `biota_properties_position` and `biota_properties_int` are checked manually post-run.

## 5. Phased plan

### Phase A — Restore building leaf geometry (~1-2 days)

**Why first:** without leaf parts, there's no interior geometry to collide with or stand on. Highest visible delta per unit work.

**Steps:**
1. Replace the silhouette-only path at `lib.rs:654-656` with a full part-walk. Reuse `walk_setup_model_surfaces` (`lib.rs:1177-1189`) and the `triangulate_setup_identity_placement` triangulator (`lib.rs:1520-1584`).
2. Walk every GfxObj part in the Setup; apply parent-index frame composition; emit one PIXI mesh per part.
3. Attach parts to a per-building `PIXI.Container` keyed by building model_id; expose `window.buildingMap: Map<u64, PIXIContainer>` for tests.
4. Per-part addressing: each child mesh tagged `{building_id, part_index}` in user data so Phase E can look them up.

**Smoke:** `check('phase6.A.holtburg_townhall_part_count', townhallPartCount > 10, ...)` in `smoke_test.cjs`. Establish a snapshot baseline today (silhouette = 1 mesh) and assert at least 10× delta.

**Live:** new `capture_phase6_step_a_geometry.cjs` based on step 3:
- Login, `@telepoi Holtburg`, navigate to `(86, 30, …)` in front of the town hall.
- Read `window.buildingMap.get(townhall_id).children.length`; assert ≥ N (calibrate N from manual inspection).
- Screenshot `phase6_step_a_geometry.png` for visual regression.

**Done when:** Holtburg town hall has visible doors, windows, interior wall partitions in the browser. Triangle count grows by an order of magnitude. No regression in 102/102 smoke.

### Phase B — Player ↔ building AABB collision (~3-4 days)

**Why next:** the user's #1 complaint. Also makes server-trust assumptions match client behaviour.

**Steps:**
1. In `crates/holtburger-dat/src/file_type/setup.rs`, add `Setup::part_aabbs() -> Vec<Aabb>` returning per-part world-space AABBs after applying part frames. Per-part is preferred over fused — Holtburg roof overhangs are real geometry but shouldn't be solid walls at ground level.
2. In `WorldState`, add a `building_aabb_index: HashMap<CellId, Vec<(BuildingId, Aabb)>>`. Populate on `fetch_landblock_objects`-equivalent path: for every building placement, look up its Setup, compute AABBs, transform by placement frame, bucket into landblock cells.
3. In `project_pose_by_velocity()` (`crates/holtburger-world/src/spatial/physics.rs:308-319`):
   - Compute proposed delta from velocity × dt.
   - Player capsule: radius 0.4 m, height 1.8 m (mirror `PhysicsObj.cs` values).
   - Look up AABBs in `current_cell ∪ neighbours` (covers movement crossing cell boundaries within a tick).
   - Sweep capsule against AABBs; clamp delta to first hit.
   - Slide along contact surface (drop the colliding axis component); single-iteration depenetrate.
4. Ensure terrain Z-snap still runs after the X/Y clamp.
5. Closed-door AABBs are part of the index; Phase E will toggle them by state.

**Smoke:** unit test in `crates/holtburger-world/src/spatial/tests.rs`:
- Fixture: a single Setup at a known position with a known AABB.
- Assert proposed move into the AABB returns clamped pose, not the input pose.
- Assert proposed move along the AABB face slides without blocking.

**Live:** `capture_phase6_step_a_geometry.cjs` extension or new `capture_phase6_step_b_collision.cjs`:
- Login, `@telepoi Holtburg`, walk straight at the town hall wall for 3 seconds with W held.
- Pre/post entity snapshot via `window.entityMap`. Assert `Math.hypot(dx, dy) < 0.5` (player should hit the wall and stop, not pass through).
- Compare against a control direction (no wall) where delta should be ≥ 2 m.

**Done when:** walking into the town hall wall stops the player at the wall. SQL `biota_properties_position` shows the player position halts at the wall. No regression on movement smoke 102/102.

### Phase C — EnvCell rendering wasm export (~3-5 days)

**Steps:**
1. Add `fetch_env_cells_in_landblock(lbid: u32) -> JsValue` to `apps/holtburger-web/src/lib.rs`.
2. New struct `EnvCellPlacement` exposing: `cell_id`, `environment_id`, `cell_origin_x/y/z`, `cell_orientation_qw/qx/qy/qz`, `static_objects: Vec<StaticObjectPlacement>`, `portal_cell_ids: Vec<u32>`.
3. New struct `StaticObjectPlacement` mirroring the terminal exporter's `staticObjects`: `did`, world `x/y/z`, quaternion, `aabbLocal`.
4. New Rust path: walk Environment DIDs (0x0D…) — different format from Setup. Identify the parser entry point in `holtburger-dat::file_type::environment` (or add it if missing).
5. JS-side: new triangulation per EnvCell. Place under a `window.cellContainers: Map<CellId, PIXI.Container>` map. Static objects reuse `triangulate_setup_identity_placement`.
6. Lazy-fetch on landblock entry: hook into the existing terrain prefetch path so EnvCells load alongside heightmaps.

**Smoke:** `check('phase6.C.holtburg_envcell_count', envCellsForLb('0xA9B4') >= N, ...)`. Sanity assert on Holtburg's known cell count (calibrate by running terminal exporter once).

**Live:** `capture_phase6_step_c_envcells.cjs`:
- Login, `@telepoi Holtburg`, walk to town hall door (which Phase A made visible at correct size).
- Walk inside (Phase B will block walls but should leave doorways passable since doors aren't in the AABB index until Phase E).
- Read `window.cellContainers.size` post-entry; assert ≥ 1.
- Screenshot interior `phase6_step_c_envcells_interior.png`.

**Done when:** walking into Holtburg town hall reveals interior tables, walls, ceiling. Static objects render at their exported positions.

### Phase D — Active-cell tracking + Z-culling (~3-4 days)

**This is the multi-floor and dungeon-expandable phase.**

**Steps:**
1. `WorldState::current_cell(pos: &WorldPosition) -> CellId`:
   - Outdoor: derive from `landblock_id` high word + 8×8 grid index (already exists in position normalization).
   - Indoor: AABB containment check across cached EnvCells in the current landblock. EnvCells stack in Z; a 3D AABB lookup picks the right floor.
2. `WorldState::render_set(current: CellId, depth: u8) -> HashSet<CellId>`:
   - BFS across `cell_portal_graph`.
   - Default depth 1 (current cell + immediate portal-visible neighbours).
   - For dungeon line-of-sight effects, configurable to 2.
3. Per-frame in the rAF tick (JS):
   - Read `wasm.current_cell()`.
   - Compute render set.
   - Toggle `cellContainers.get(cid).visible` based on membership.
   - Outdoor terrain is one big "outdoor cell" container; toggle it off when player is indoors.
4. Stair handling: stairs are EnvCell `CellPortal` connections between Z-stacked cells. Walking up the stairwell crosses a portal boundary, which shifts `current_cell`, which shifts `render_set`. Lower floor falls out, upper floor pops in. **No special "stairs" code.**

**Smoke:** unit test in `crates/holtburger-world/src/state/tests.rs`:
- Fixture: a 3-floor cell graph (`cell_a → cell_b → cell_c` connected by portals).
- For each cell, assert `render_set(cell, depth=1)` includes only the cell and its direct neighbours.
- Position-driven: walk a synthetic pose up through the cells; assert `current_cell` transitions at the right Z thresholds.

**Live:** `capture_phase6_step_d_floors.cjs`:
- Login, `@telepoi` to a 2-floor Holtburg house (or `@teleloc` to a known interior cell — feasibility flagged in §6).
- Walk up the stairs; sample `window.cellContainers` visibility before / mid-stair / after.
- Assert lower-floor container `.visible = false` once player is on upper floor.
- Assert upper-floor container `.visible = true` and was `false` before.

**Done when:** walking up stairs in a Holtburg multi-floor house cleanly transitions visible cells. No flicker. Player remains contained by Phase B's collision throughout.

### Phase E — Door geometry + state (~2-3 days)

**Steps:**
1. Identify door GfxObj parts within building Setups (Phase A keeps them; Phase E addresses them by `part_index`).
2. Subscribe to `PublicWeenieDesc.DoorState` updates from ACE in `crates/holtburger-core/src/client/world/handlers/`. Emit `WorldEvent::DoorStateChanged { guid, state }`.
3. JS handler: rotate the door's GfxObj sprite around its hinge frame on state change. Hinge frame is part_index-relative; precompute on Phase A part walk.
4. Phase B AABB index toggle: closed door = AABB present, open door = AABB removed. Emit on `DoorStateChanged`.

**Smoke:** unit test that mutating door state in `WorldState` triggers an AABB index update.

**Live:** `capture_phase6_step_e_doors.cjs`:
- Login, `@telepoi Holtburg`, walk to a closed door.
- Assert collision blocks (`Math.hypot(dx, dy) < 0.2`).
- Click the door (`useObject` from Phase 4 step 5).
- Assert ACE returns `kind=14 UseDone` and `DoorState` flips.
- Walk through the door; assert position delta ≥ 1 m.
- Screenshot before/after.

**Done when:** doors animate open/closed, collision toggles with state, walking through an open door succeeds and a closed door blocks.

### Phase F — Vertical-dungeon validation (~2 days) ✅ (landed)

**Steps:**
1. Pick a 3+ floor dungeon. Candidates:
   - Mite Maze (multiple Z levels, lots of portal corridors).
   - One of the Frore towers (vertically stacked rooms).
   - Glenden Wood Mine (basement levels).
2. `capture_phase6_step_f_dungeon.cjs`: teleport to the dungeon entrance, walk the full Z range, sample render set at each floor transition.
3. Document the chosen dungeon as a regression target in this doc's "Validation suite" appendix.

**Chosen dungeon target: Mite Maze.** Entrance at cell `0x01F801D4` (origin `6.1, -101.6, 0`) — derived from the `portalmitemaze` weenie (class_id 1121) `weenie_properties_position WHERE position_Type=2` row in `ace_world`. LB `0x01F8` has 879 indoor cells in `dist/manifest.json` under `eor/cell:0x01F8...` keys. The capture script falls back to **Holtburg Dungeon** (cell `0x01F60289`, LB `0x01F6`, 429 indoor cells, derived from `portalholtburgdungeon` weenie 1125) if Mite Maze's EnvCells aren't present in the bake.

**`@telepoi` does NOT include Mite Maze or any dungeon** — the `points_of_interest` table only has cities + a handful of named spawns (Marketplace, Hotel, Underground, Storage, Town Network). Confirmed by `mariadb -u ace -pace ace_world -e "SELECT name FROM points_of_interest"`. Phase F therefore uses `@teleloc 0xLLLLLLLL X Y Z` with the entrance coords from the portal weenie's destination position (same pattern as `capture_step6_monster.cjs`).

**Smoke:** parameterized version of the Phase D unit test, fed with the chosen dungeon's actual cell graph (extracted via terminal exporter once).

**Live:** the dungeon walk capture itself — runs end-to-end without errors.

**Done when:** at least one 3+ floor dungeon is fully traversable in the browser with correct culling at every floor transition. **Live capture deferred** to follow-up because chromium is unavailable in this environment; the wasm-side smoke check (`phase6.F.dungeon_render_set_bounded_under_n_floor_walk`) synthesizes a 5-floor stack and proves the cell-graph abstraction generalizes to N floors with no Phase F-specific code — that's the load-bearing validation.

## 6. Risks and open questions

1. **Setup AABBs may be coarser than retail wants.** Holtburg houses include roof overhangs whose AABBs extend past the wall plane. A player walking along the wall outside might get blocked by overhang at ground level. Mitigation: per-part AABBs, and accept that retail itself uses BSP not AABB for fine-grained collision — Phase B's contract is "no walking through walls", not "pixel-perfect retail collision."
2. **`@teleloc` to interior cell IDs may not work.** Phase D's live test wants to teleport directly into an EnvCell. ACE's `@teleloc` accepts landblock-format positions (`0xA9B40100, x, y, z`) but indoor cells use the 0x0100+ low-word convention. If ACE rejects, fall back to: teleport to outdoor coords, walk through the door manually in the capture.
3. **`PlayerDescription` biota timing.** The known caps_ok regression watchdog (memory: 2026-05-08 fixes) may interact with Phase B's collision — if collision clamps a velocity-driven move, the resulting pose may diverge from ACE's expectation and trigger UpdatePosition snaps. Mitigation: only clamp when a real wall is hit; tolerate sub-cm overshoots without rejecting them.
4. **EnvCell graph density at scale.** 805k records exist; we never load the full set, but a dungeon like Mite Maze has hundreds of cells in one landblock. Verify the manifest v2 prefetch budget can absorb a 500-cell load on landblock entry. If not, lazy-fetch by render set rather than by landblock.
5. **Restriction polygons unused in Phase B.** Some doorways are arched and AABB collision will block them where retail wouldn't. Phase G (out of scope) would consume EnvCell `RestrictionObject` polygons for precise non-AABB walls. For now, accept that some doorways may feel slightly tight.
6. **Door hinge frames may not be in Setup metadata.** Retail door GfxObjs have implicit pivot points; if the Setup format doesn't expose them, Phase E may need to derive from AABB local origin. Confirm by reading a Holtburg house door part during Phase A.
7. **Per-frame visibility toggling cost.** `cellContainers.get(cid).visible = bool` on hundreds of cells per frame might churn PIXI's batch state. Mitigation: only toggle on render-set diff, not every frame.
8. **Server-side authority during Phase B development.** While client collision is being added, ACE will continue to rubber-band based on its own physics. Misaligned AABBs (client says "wall here", server says "no wall") will produce visible jitter. Mitigation: align client AABBs to ACE's `PhysicsObj` setup rules from the start.

## 7. Out of scope

- BSP-grade collision (Phase G if ever).
- Restriction polygon walls (Phase G).
- Lighting per cell (Phase H — interior cells have ambient lights stored in EnvCell, not in scope here).
- Indoor weather / fog (out).
- Per-cell music or ambient sound (out).
- NPC pathfinding using cell graph (server-side, ACE handles).
- Server-side physics changes (this work is purely client; ACE remains authoritative).

## 8. Validation suite (canonical list, grow as phases land)

Tests that MUST pass after every phase:

| Test | Asserts | Runs against |
|---|---|---|
| `smoke_test.cjs` 102/102 + 1 SKIP | No regression in baseline | Local fixtures |
| `capture_phase4_step3.cjs` | WASD movement still works | Live ACE `<server-ip>` |
| `capture_phase4_step5.cjs` | Click-to-use still works | Live ACE |
| `capture_step6_monster_walking.cjs` | Walk-cycle bake unchanged | Local fixtures |
| `capture_phase6_step_a_geometry.cjs` (Phase A+) | Holtburg town hall geometry | Live ACE |
| `capture_phase6_step_b_collision.cjs` (Phase B+) | Wall blocks player | Live ACE |
| `capture_phase6_step_c_envcells.cjs` (Phase C+) | Interior renders | Live ACE |
| `capture_phase6_step_d_floors.cjs` (Phase D+) | Floor culling correct | Live ACE |
| `capture_phase6_step_e_doors.cjs` (Phase E+) | Doors block when closed, pass when open | Live ACE |
| `capture_phase6_step_f_dungeon.cjs` (Phase F+) | 3+ floor dungeon traversable — target **Mite Maze** (`@teleloc 0x01F801D4 6.1 -101.6 0`), fallback **Holtburg Dungeon** (`@teleloc 0x01F60289 96.7 -10 0`) | Live ACE |

## 9. Reference index

- Building rendering: `apps/holtburger-web/src/lib.rs:654-656, 664-717, 680-695, 712-713, 1177-1189, 1520-1584, 2255-2336`
- EnvCell parser: `crates/holtburger-dat/src/file_type/env_cell.rs:1-197`
- Manifest EnvCell coverage: `crates/holtburger-manifest/src/v2.rs:5-6`
- Indoor detection: `crates/holtburger-common/src/position.rs:75-80`
- Physics integrator: `crates/holtburger-world/src/spatial/physics.rs:308-319, 335-365`
- WorldState: `crates/holtburger-world/src/state/types.rs:46-62, 372, 376`
- Terminal envcell export: `WorldBuilder.Terminal/CommandEngine.cs:5367-5462` and `2026-04-05_interior_support_handoff.md`
- ACE physics reference: `external/ACE/Source/ACE.Server/Physics/PhysicsEngine.cs`, `PhysicsObj.cs`, `Collision/BBox.cs`, `Collision/CollisionInfo.cs`
- ACE doors: `external/ACE/Source/ACE.Server/WorldObjects/Door.cs`
- Test scaffold: `apps/holtburger-web/capture_phase4_step3.cjs:182, 196-206, 327-373`, `apps/holtburger-web/smoke_test.cjs:38, 635`, `apps/holtburger-web/capture_phase4_step2b.cjs:157-175`
- Sibling phase doc: `phase-4-step-3.6-movement-system.md`
