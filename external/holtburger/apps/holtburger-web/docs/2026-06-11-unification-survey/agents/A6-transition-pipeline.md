# A6 transition-pipeline — unification survey

Scope per §5: pipeline shape + cell transit (CTransition entry points, SpherePath/ObjectInfo/
CollisionInfo, which cell a moving sphere lands in). Contact math (walkable/step/slide constants)
is A7's; this report cites those calls only to show pipeline ordering. Seam flagged for A16.

## 1. Retail map

Retail runs **one** transition pipeline for every mover (player, NPC, missile, camera viewer,
server-forced placement). All entry points funnel into `CTransition`:

| responsibility | retail cite | notes |
|---|---|---|
| Pipeline entry for any move | `CPhysicsObj::transition` acclient.c:320061 | `makeTransition` → `get_object_info` → `init_object` (320077-320080) |
| Sphere init from PartArray | acclient.c:320083-320101 | `CPartArray::GetNumSphere/GetSphere`, scaled; falls back to `dummy_sphere` (320100) |
| Path init (begin cell/pos → end pos) | acclient.c:320103 (`CTransition::init_path`, body 311626) | |
| Stationary-fall frames from `transient_state` bits 0x10/0x20/0x40 | acclient.c:320104-320115 | feeds CollisionInfo |
| Top-level solve | `CTransition::find_valid_position` acclient.c:313419-313426 | dispatches `find_transitional_position` vs `find_placement_position` |
| Substep loop | `CTransition::find_transitional_position` acclient.c:313171 | `calc_num_steps` (313207) then per-step: `adjust_offset` (313266) → rotation interpolated per step (`Frame::interpolate_rotation`, 313281+) → insert/validate |
| Step count = ceil(dist/sphere-radius) | `CTransition::calc_num_steps` acclient.c:311764; non-viewer arm 311823-311845; viewer arm (`object_info.state & 4`) 311797-311820 uses floor(dist/r)+1 with last-step remainder (313245-313262) | no sub-radius tunneling possible |
| Insert with bounded retries + state machine | `CTransition::insert_into_cell` acclient.c:311632 | up to `num_insertion_attempts` calls into the cell's virtual insert; result codes OK(1)/Collided(2)/Adjusted(4); code 4 invalidates contact plane and retries |
| Validate/redo loop | `CTransition::validate_transition` acclient.c:312194 | rebuilds cell array on success (312252) |
| Cell transit recomputed from geometry EVERY step | `CTransition::build_cell_array` acclient.c:311675-311680 → `CObjCell::find_cell_list` (decl 7201); also called per-step at 313235 and in `check_other_cells` 312403 | sets `cell_array_valid`, `hits_interior_cell`; the landing cell is an *output* of the sweep |
| Walkable/step/slide resolution inside the same loop | `check_walkable` 312475 → `transitional_insert` (312518), `step_up` 6227/`step_down` 6225/`edge_slide` 6226/`cliff_slide` 312005 | math owned by A7 |
| Obj-vs-obj collision inside the same pipeline | `CTransition::check_collisions` acclient.c:312175-312190 → `CPhysicsObj::FindObjCollisions` 316159 (parts: `CPhysicsPart::find_obj_collisions`, decl 311678 block) | entities are not a separate system |
| Missiles: same pipeline + ignore filter | `OBJECTINFO::missile_ignore` decl acclient.c:6246 | missile branch is a filter inside ObjectInfo, not a fork |
| Server-forced position uses the pipeline | `CPhysicsObj::SetPositionInternal` acclient.c:322504; calls `CPhysicsObj::transition` at 322812 | placement variant: `validate_placement` 6224, `placement_insert` 6223 |
| **Camera viewer uses the pipeline too** | acclient.c:145082-145089: `makeTransition` → `init_object(player, 92)` → `init_sphere(1, &viewer_sphere, 1.0)` → `init_path` → `find_valid_position` | the viewer arm of `calc_num_steps` (state & 4) exists exactly for this |
| Re-entrancy guard | `CTransition::transition_level` acclient.c:54562, decremented in `cleanupTransition` 311589-311593 | |

Call order summary: `transition()` builds ObjectInfo+spheres+path → `find_transitional_position`
→ N substeps of {adjust_offset → set check_pos → insert_into_cell (retry loop) →
validate_transition (walkable/step/slide; may redo) → advance curr_pos, rebuild cell array} →
final pos **and final cell** come out together.

## 2. Ours map

We run **five** distinct collision/transit paths plus two inert scaffolds. Repo-relative paths;
`system.rs` = `crates/holtburger-core/src/client/movement/system.rs`,
`physics.rs` = `crates/holtburger-world/src/spatial/physics.rs`,
`scene.rs` = `crates/holtburger-world/src/spatial/scene.rs`.

| # | mover | Rust | JS | shape |
|---|---|---|---|---|
| P1 | Local player, manual WASD | `system.rs:1282` `advance_local_pose_for_manual_drive_slice`, 30 Hz slices (`system.rs:1266`): envcell entry flip (1585-1593) → exit flip B11 (1611-1620) → indoor per-poly cell walls `clamp_delta_against_cell_walls_dispatch` (1691) or cell-AABB net `clamp_delta_to_cell_interior` (1751) → outdoor buildings (1767/1778) → statics AABB sweep (1865-1880, BSP arm behind `USE_STATIC_BSP`=false, system.rs:422) → entity cylinders `clamp_delta_against_entities` (2031) → step_up (2112) / floors (2096, 2574) / step_down (2492, 2625) | — | sequential one-pass clamps per geometry class; substep loop exists but `USE_SUBSTEP_TRANSITION=false` (physics.rs:53) |
| P2 | Local player, server-projection / autonomous drive | `LocalDriveControl` built at `system.rs:1126-1205`; solved by `physics.rs:1571` `solve_self_player_local_drive` → `project_pose_by_velocity_with_collision` (physics.rs:1804, call 1620) — **buildings AABB only** | — | no cell walls, no statics, no entities, no step/floor |
| P3 | Remote entities | `physics.rs:1841` `advance_body_kinematics` via `simulation.rs:122` `build_solve_request` / `apply_solve_batch` (181) | — | **zero collision**; cell id is server-stamped only |
| P4 | Camera | wasm exports `cameraSweepCollision` / `sweepSphereAgainstBuildingMesh` / `CellMesh` / `Statics` (`apps/holtburger-web/src/lib.rs:23287-23289`, 25214; per-tick scene clone noted at 23038) → `scene.rs:1656/1736/1862/1949` | `scene3d/camera.js:727-779` chains the sweeps | raw swept-sphere queries; no insert/validate/walkable semantics |
| P5 | Projectiles | none | `scene3d/entities.js:2952-2974` ballistic seed (F3-1) + `?projectileGravity` arc (G-4, entities.js:532-546); launch velocity via `scene3d/loop.js:1647-1652` | client-side flight, **no collision** |
| S1 | Inert: TransitionState + placement scaffold | `crates/holtburger-world/src/spatial/collision.rs:13-25` (`TransitionState` OK/Collided/Adjusted/Slid — "nothing uses them yet"), M4 `PlacementContext`/`InsertType` (collision.rs:100-125) behind `USE_PHYSICS_BSP=false` (system.rs:403) | — | faithful SpherePath/CollisionInfo port, wired into nothing |
| S2 | Render-only Z reconcile | — | `scene3d/loop.js:535-560` `getTerrainVisualZ` raycast (F4-3/B2 caps) | visual, not physics |

Cell transit ours: outdoor→indoor flip `USE_LOCAL_ENVCELL_ENTRY=true` (system.rs:436, fire at
1585) + indoor→outdoor inverse (B11, system.rs:1611); outdoor cell rebucketing via
`normalize_outdoor_cell` (physics.rs:1782). Applies to P1 only; P2-P5 never recompute cells.

## 3. Divergences

| # | behavior | retail cite | our cite(s) | class | symptom | tracked? |
|---|---|---|---|---|---|---|
| 1 | One transition pipeline for all movers vs five disjoint paths | acclient.c:320061 (`transition`), 322812 (SetPosition), 145082-145089 (viewer), 312190 (obj-vs-obj), 6246 (missile filter) | system.rs:1282 (P1); physics.rs:1571 (P2); physics.rs:1841 (P3); lib.rs:23287/camera.js:727 (P4); entities.js:2952 (P5) | SPLIT-BRAIN (5 sites) | every collision fix must be re-applied per path; paths drift (P2/P3 already lack what P1 has) | untracked as a whole; pieces in B4/B11 |
| 2 | Local player has TWO solvers with different collision coverage: manual WASD gets full clamp chain; server-projection/move-to drive gets buildings-only | acclient.c:313419 (one `find_valid_position` regardless of autonomy) | system.rs:1691-2625 (full) vs physics.rs:1620 (`project_pose_by_velocity_with_collision`, buildings only) | SPLIT-BRAIN (2 sites) | a server-projected move-to can drag the player through cell walls, statics, entities that WASD correctly blocks on | untracked |
| 3 | Remote entities run no collision between server updates | acclient.c:320061 + update path: every `CPhysicsObj` move transitions; obj insert at 311632 | physics.rs:1841 `advance_body_kinematics` (pure kinematics); simulation.rs:181 applies unclamped | MISSING | velocity-extrapolated creatures/players clip through walls and floors until next server pose | partially: bughunt-18 B4 root-cause note ("integrator only knows building AABBs + entity spheres") is player-side; entity-side untracked |
| 4 | Substep sweep: retail subdivides every move into ceil(dist/radius) steps, collide+slide each | acclient.c:311764 (`calc_num_steps`), 313207-313266 (loop) | physics.rs:53 `USE_SUBSTEP_TRANSITION=false` default; single-pass dispatch at system.rs:1691 | DIFF-ALGO | fast moves can tunnel thin walls; L-corner second-wall slide missed | tracked in-code (physics deep-dive 2026-06-01 gate, physics.rs:13-52) |
| 5 | Insert/validate state machine (OK/Collided/Adjusted/Slid + bounded retries + redo loop) drives resolution; ours has no state machine, just sequential clamps | acclient.c:311632 (`insert_into_cell` retry codes), 312194 (`validate_transition` redo) | collision.rs:13-25 (enum exists, "nothing uses them yet"); P1 sequence system.rs:1691-2625 has no retry/redo | MISSING | Adjusted-and-retry semantics (code 4 → invalidate contact plane → reinsert) unrepresentable; multi-constraint poses (wall+entity+riser) resolve order-dependently | untracked (M4 scaffold exists, inert) |
| 6 | Landing cell is an output of the per-step sweep (`find_cell_list` each step, `hits_interior_cell`); ours flips cells once per tick by membership test, player-only | acclient.c:311675-311680, 313235, 312403 | system.rs:1585-1620 (entry/exit flips, `USE_LOCAL_ENVCELL_ENTRY` system.rs:436); physics.rs:1782 outdoor rebucket; P2-P5 none | DIFF-ALGO | mid-tick multi-cell crossings (doorway diagonal at run speed) can mis-cell for a tick; remote entities never re-cell client-side | B11 (exit flip) SHIPPED per system.rs:1596-1620; residual per-step transit untracked |
| 7 | Camera viewer is a transition client (viewer sphere, `object_info.state & 4` step arm); ours is a raw sweep chain with no insert/walkable semantics | acclient.c:145082-145089, 311797-311820 | camera.js:727-779; lib.rs:25214; scene.rs:1656-1960 | DIFF-ALGO | camera can rest inside geometry a transition would reject (insert validation); behavior diverges from retail occlusion feel | untracked (Workstream C shipped the sweeps; no parity claim made) |
| 8 | Missiles transition with `missile_ignore` filtering; ours fly ballistically with zero collision | acclient.c:6246; pipeline entry 320061 | entities.js:2952-2974 (no collision in flight); loop.js:1647 | MISSING | projectiles pass through walls/terrain until server kills them | F3-1/G-4 tracked the *flight visuals* only; collision untracked |
| 9 | Render-only terrain-Z raycast lift (visual mesh vs bilinear collision Z) | retail renders the collision geometry — no such reconcile exists (no counterpart symbol; see §6) | loop.js:535-560 | EXTRA | benign by design; documented caps | F4-3, B2 (shipped) |

Row 9 is EXTRA-by-design (Catmull-Rom render terrain is our renderer's choice); listed for
completeness, no work proposed.

## 4. Staged unification plan

Goal: one `transition` module in `holtburger-world` with retail's shape — ObjectInfo-style mover
descriptor, SpherePath state, substep loop, insert/validate state machine — consumed by all five
paths. The shipped clamps become the *geometry backends* of the pipeline, not five callers.
A7 plugs contact-math fixes into the same module (seam: A6 owns context/loop/cell-transit,
A7 owns the per-contact resolution functions the loop calls).

- **Stage T0 — module shell + descriptor (headless-now).**
  Scope: create `crates/holtburger-world/src/spatial/transition.rs`: `ObjectInfo` (mover state
  bits incl. viewer/missile/contact flags), `SpherePath` (curr/check pos+cell), reuse the shipped
  `TransitionState` (collision.rs:13) and M4 `PlacementContext` (collision.rs:100+). Pure types +
  unit tests; nothing calls it. Flag: none needed (inert). Wasm-rebuild batchable. Rollback: n/a.
- **Stage T1 — manual-drive path through the pipeline (wasm-rebuild).**
  Scope: wrap the existing P1 clamp sequence as the pipeline's backends in retail order:
  calc_num_steps (turn `USE_SUBSTEP_TRANSITION` machinery ON inside the pipeline only) → per-step
  adjust_offset → insert (cell walls/buildings/statics/entities as insert backends) → validate
  (existing step_up/step_down/edge-slide as redo handlers) → per-step cell transit (move the
  entry/exit flips from system.rs:1585-1620 into the step loop). Files: system.rs (call-site swap
  at 1282), transition.rs. Flag: Rust const `USE_UNIFIED_TRANSITION=false` + URL flag
  `?unifiedTransition=on` in url-flags.md style. Tests: headless-now unit parity (flag-off
  bit-identical; flag-on parity on straight-line/corner/doorway fixtures); 1070-gated eye test
  (Holtburg run loop, academy dungeon, mansion entry/exit). Rollback: flag off. GATE: Stage 1
  (movement) eye-test PASS first — both touch the same tick.
- **Stage T2 — kill the second local-player solver (wasm-rebuild).**
  Scope: route `solve_self_player_local_drive` (physics.rs:1571) through the same pipeline (the
  drive's `desired_world_delta` is just the offset input). Deletes divergence #2. Files:
  physics.rs, simulation.rs. Same flag. Tests: headless-now (move-to projection fixture cannot
  cross a cell-wall fixture); 1070-gated (in-world move-to through a wall corner). Rollback: flag off.
- **Stage T3 — remote-entity transitions (wasm-rebuild, perf-bounded).**
  Scope: `advance_body_kinematics` callers opt bodies within ~25 m into the pipeline with an
  `ObjectInfo` built from entity physics state (ethereal/missile bits per
  entity_collision.rs:14-26 notes). Flag: `?entityCollision=on` (default off — perf risk on dense
  landblocks). Tests: headless-now (entity body vs wall fixture); 1070-gated (watch a wandering
  NPC at a dungeon wall). Rollback: flag off.
- **Stage T4 — camera as viewer-sphere client (JS-live + wasm-rebuild).**
  Scope: add a `viewer` arm (`state & 4` step semantics, acclient.c:311797) and expose one
  `cameraTransition` export; camera.js swaps its sweep chain for it. Flag: `?cameraTransition=on`.
  Tests: 1070-gated only (camera feel is an eye test). Rollback: flag off; old exports retained.
  NOTE for A16: A12 (camera) may conclude NO WORK; if so T4 drops without affecting T1-T3.
- **Stage T5 — projectile flight collision (JS-live consuming existing exports first).**
  Scope: minimal `missile_ignore`-filtered transition for client-flown projectiles so they stop
  at walls; can ship cheaply as a JS call into the existing sweep exports before T1 lands, then
  migrate onto the pipeline. Flag: `?projectileCollision=on` (pairs with `?projectileGravity`).
  Tests: headless-now (unit), 1070-gated (arrow into a wall). Rollback: flag off.

Dependency: T0→T1→T2→T3; T4/T5 after T1 (T5's interim JS form has no dependency). Everything
1070-eye-test-gated for default-ON promotion; all stages headless-verifiable for correctness.

## 5. Scores

- Leverage / backlog IDs subsumed: **B4** (Tier-2 `USE_STATIC_BSP` wiring becomes a T1 insert
  backend; bughunt-18 Wave-4 spec), **B11** residuals (per-step cell transit replaces the
  per-tick flips; the shipped flip pair becomes the flag-off fallback), in-code deferred gates
  `USE_SUBSTEP_TRANSITION` / `USE_CALCNUMSTEPS_3D_DIST` / `USE_CLIFF_SLIDE_INTRA_SUBSTEP`
  (physics.rs:53/66/76 — T1 makes them the pipeline default instead of orphan A/B consts), the
  M4/M5 `USE_PHYSICS_BSP` scaffolding (collision.rs — gets its first live consumer), **G-4/F3-1**
  follow-on (T5). F4-x contact-math items are A7's to claim.
- Regression-risk reduction: **H** — divergences #1/#2 are exactly the "fix lands in one path,
  regresses or is absent in another" class; five sites collapse to one.
- Implementation risk: **H** for T1 (rewrites the live player tick's spine; mitigated by flag-off
  bit-parity tests and the Stage-1 gate), M for T2/T3, L for T5.
- 1070-dependency: **Y** for default-ON promotion of every stage; N for correctness (headless unit
  parity exists for T0-T3, T5).
- Depends-on: movement Stage 1 eye-test PASS (shared tick, `USE_INTERPRETED_VELOCITY` interacts
  with the slice loop at system.rs:1315); A7 (resolution functions are the pipeline's callees —
  serialize A6-T1 with A7's plan or merge into one stage list); A2 seam (force-position
  `InterpolateTo` easing in `spatial/force_position_interp.rs` feeds offsets INTO the pipeline —
  retail runs adjust_offset through transition too, acclient.c:144717-145227; A2 owns it); A16
  conflict matrix: system.rs, physics.rs, lib.rs, loop.js are all shared hot files.

## 6. SPECULATIVE / UNRESOLVED

- **Dedupe sources unavailable on this host**: `~/out/bughunt86-combat-render-loop-items-2026-06-09.md`
  and `~/out/grind-loop-2026-06-11.md` do not exist here (checked `ls ~/out/`). Dedupe was done
  against `~/out/bughunt-18-FINAL-REPORT-2026-06-08.md` (B4 row 14, B11 row 82) and in-code IDs
  (F3-1, F4-2, F4-3, G-4, G-7, B11, PR-RR in system.rs/entities.js/loop.js comments). F-item rows
  in the `tracked?` column may therefore under-report; A16 should re-check rows 2, 3, 5, 7
  against the bughunt86/grind docs on the laptop.
- Row 9's retail side is an absence claim ("no counterpart") — I could not cite a line proving
  retail has no render-vs-collision Z reconcile, only that no such symbol family exists near the
  terrain/render code I searched (`grep -n "visual.*collision\|render.*bilinear" acclient.c`,
  `grep -n "GetTerrainVisualZ\|terrain_visual" acclient.c` — no hits). Classified EXTRA on that
  basis; treat as soft.
- `frames_stationary_fall` (transient_state 0x10/0x20/0x40 → CollisionInfo, acclient.c:320104-320115):
  found no our-side counterpart (`grep -rn "stationary_fall\|frames_stationary" crates/ apps/` — 0
  hits outside this survey). Single-cited → left out of the table; likely folds into T0's
  ObjectInfo but A7 should confirm what consumes it in the resolution math.
- Whether ACE server-side tolerance makes client-side remote-entity collision (row 3 / T3)
  player-visible enough to justify its perf cost is a judgment call, not established here — the
  divergence is real, the leverage estimate is speculative.
- `CTransition::transition_level` re-entrancy (acclient.c:54562): no evidence our paths can
  re-enter (single-threaded tick), so no divergence claimed; noting it so T1 doesn't cargo-cult
  the static.
