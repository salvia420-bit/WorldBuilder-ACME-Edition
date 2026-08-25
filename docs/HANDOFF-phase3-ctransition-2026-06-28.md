# HANDOFF — Phase 3: CTransition collision driver port (2026-06-28)

**Branch:** `feat/phase3-ctransition-driver` (local, **unpushed**, 8 commits on top of `master`).
**What it is:** a decomp-faithful Rust port of the retail Asheron's Call client's
`CTransition` swept-sphere collision/movement **driver** into the holtburger
client, built on the already-shipped Phase-1 (geometry leaf) + Phase-2 (resolver)
layers. Then (B4) wired into the live client behind a default-OFF flag.

> **✅ UPDATE 2026-06-28 (later same day): §4's "BLOCKING BUG" was a
> MISDIAGNOSIS — the CTransition driver is collision-correct.** A grounded player
> AND an airborne mover both STOP at a wall in the faithful driver (proven by two
> new end-to-end tests). The old §4 "walks through walls" was a TEST-FIXTURE
> artifact (a floorless synthetic scene that nulled `check_cell`), not a driver
> bug. The real LIVE blocker was two bridge gaps — a stubbed static-object
> collision and a missing `point_in_cell` cell re-seat — both now FIXED + tested.
> See the rewritten §4. Remaining: the wasm DAT→static-BSP populate (live feed)
> and the 1070 eye-test.

---

## 1. TL;DR state

| Layer | Status | Tests |
|---|---|---|
| Phase 1 leaf + Phase 2 resolver | shipped before this work (commit `2fb81188`) | — |
| **B1** A08 shared-state contract | ✅ committed `e7d18fa2` | |
| **B2a** CObjCell foundation + mutators | ✅ `57819827` | |
| **B2b/c** spine + dispatch + validation | ✅ `60135a12` | |
| **B3** driver complete (search/placement/slide/init) | ✅ `081892e9` | |
| **B3** cross-landblock plane-carry test | ✅ `08ba5b4a` | |
| **B4-A** SpatialScene→CObjCell bridge + dispatcher + flag | ✅ `4a0a541a` | |
| **B4-B** (laptop) ?faithfulTransition flag + drift harness | ✅ `f0c4c803` | |
| **B4** wall-passthrough regression (ignored) | ✅ `1d75705c` | |
| **Investigation** grounded walker stops at wall (disproves §4) | ✅ `1680b197` | |
| **(b)** airborne wall-stop faithful too (§4 was a harness artifact) | ✅ `a87bf0ad` | |
| **(a)/Phase C** faithful per-static collision + cell re-seat | ✅ `380eb8f1` | |

**Green (as of 2026-06-28 later):** `holtburger-dat` lib `transition::` = **252 pass,
0 ignored** (the airborne probe is now a passing test, not ignored);
`holtburger-world` **9/9 drift pass** (new `faithful_static_object_stops_mover`); the
**2 `position_manager` fails are PRE-EXISTING** (handoff §1), untouched; `holtburger-core`
`cargo check` clean. `holtburger-web` does NOT build natively (pre-existing,
unrelated wasm-gated types) — the wasm static-BSP populate (the live feed, §5
Phase C) is the one piece not yet landed/tested.

---

## 2. Where the code lives

**The driver crate:** `external/holtburger/crates/holtburger-dat/src/transition/`
- `types.rs` — state structs (`CTransition`, `SpherePath`, `CollisionInfo`,
  `ObjectInfo`, `Position`, `CellArray`/`CellInfo`), enums (`TransitionState`,
  `InsertType`, `object_info_state`), constants (`EPSILON`, `Z_FOR_LANDING`,
  `GRAVITY`, `FLOOR_Z`), `LandDefs::get_block_offset`.
- `objcell.rs` — the **`CObjCell` trait** (cell collision abstraction, vtable
  slot 5 = `find_collisions`) + seam traits (`CellWorld`, `CellArrayApi`,
  `ObjectManager`, `PhysicsObjRef`, `WeenieObjRef`, `LandblockRef`, `Landscape`,
  `LandDefsSeam`), `WaterType`, `find_cell_list`, `CellArray` methods +
  `impl CellArrayApi for CellArray`.
- `objectinfo.rs` — `ObjectInfo::{get_walkable_z, is_valid_walkable, validate_walkable}`.
- `spherepath_methods.rs` — SPHEREPATH mutators (`cache_global_sphere`,
  `add_offset_to_check_pos`, `set_collide`, `set_walkable`, `step_up_slide`,
  `check_walkables`, `save/restore/adjust_check_pos`, `precipice_slide`,
  `set_check_pos`, `cache_global_curr_center`, `cache_localspace_sphere`).
- `resolver_*.rs` (Phase 2) — `find_collisions` dispatcher + branch helpers.
- **driver methods** (Phase 3, this work):
  - `driver_spine.rs` — `transitional_insert` (the engine) + `step_up`/`step_up_impl`
    + `step_down` + `check_walkable` + `edge_slide` + the **DriverCtx thread-local**
    (world bridge for `step_up` + recursion-depth guard).
  - `driver_cell_dispatch.rs` — `check_collisions`, `insert_into_cell`,
    `check_other_cells`, `build_cell_array`.
  - `driver_validate.rs` — `find_valid_position` (entry), `find_transitional_position`
    (A03), `find_placement_position` (A04 wrapper), `validate_transition`,
    `validate_placement_transition`, `calc_num_steps`, the `MovingObjectPhysics` seam.
  - `driver_geometry.rs` — `adjust_offset`, `cliff_slide`, `snap_to_plane`,
    `Position::get_offset`.
  - `driver_placement.rs` — `find_placement_pos`, `placement_insert`, `validate_placement`.
  - `driver_init.rs` — `init*` suite, `CTransition::new`, `TransitionPool` (the
    Rust-idiomatic replacement for the decomp's static `makeTransition` pool).
  - `test_utils.rs` — synthetic `CObjCell` scenes (floor/wall/step/cliff/ramp via
    `SynthEnvCell` + `SceneWorld`) driving the spine end-to-end; **the ignored
    wall-passthrough regression test lives here**.

**The B4 live bridge:** `external/holtburger/crates/holtburger-world/src/spatial/`
- `faithful_bridge.rs` — `SceneObjCell` (per-cell `CObjCell` adapter over
  `CellPhysicsBsp`), `SceneWorld` (`CellWorld` over `&SpatialScene`),
  `FaithfulMover`, `faithful_find_transitional_position` (marshals
  `TransitionInput → CTransition → find_valid_position → TransitionOutcome`),
  and the 8-test `mod drift` harness.
- `transition.rs` — `find_transitional_position_dispatch(env, input, faithful)`
  (additive, beside the existing approximate `find_transitional_position:638`).

**The B4 flag:** `external/holtburger/crates/holtburger-core/src/client/`
- `movement/system.rs` — `const USE_FAITHFUL_TRANSITION: bool = false;` + runtime
  carrier `faithful_transition_runtime` + `faithful_transition_enabled()`.
- `movement/handle.rs` — `MovementSystemHandle::set_faithful_transition` forwarder.
- `simulation.rs:220` + `movement/system.rs:4458` — the two live callers, routed
  through the dispatcher.
- `apps/holtburger-web/src/lib.rs` — `parse_faithful_transition_flag`
  (`?faithfulTransition=on`) → `set_faithful_transition`.
- `apps/holtburger-web/docs/url-flags.md` — the `?faithfulTransition=on` row.

**Pass-A source material (reference):** `/home/wbterminal/from-vm/phase3-passA/parts/A01.md … A16.md`
(the 16-agent buildbox fan-out that authored the driver; A08 = the integration
contract, A14 = the B4 wiring plan, A15 = the adversarial audit/risk list).

---

## 3. Build & test (laptop — the 8GB OOM-jail rules)

```bash
cd /home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger
# ALWAYS: OOM-jail wrapper + FULL cargo path. NEVER bare cargo, NEVER --workspace.
capped-build ~/.cargo/bin/cargo test  -p holtburger-dat   --lib 'transition::'
capped-build ~/.cargo/bin/cargo check -p holtburger-world --tests
capped-build ~/.cargo/bin/cargo test  -p holtburger-world --lib 'spatial::'
capped-build ~/.cargo/bin/cargo check -p holtburger-core
```
- `pkill -x rust-analyzer` to reclaim RAM (NEVER `pgrep -f rust-analyzer` — it
  self-matches your shell → exit 144).
- `holtburger-web` won't build natively (pre-existing); test parse fns standalone.

---

## 4. ✅ RESOLVED — §4 was a misdiagnosis; the driver is collision-correct

The original §4 claimed the faithful driver "walks players straight through walls"
and called it a `holtburger-dat` driver-fidelity gap. **That was wrong on both
counts.** A multi-source investigation (decomp + ACE + chorizite cross-ref, plus
instrumented runs) proved the CTransition algorithm is decomp-faithful AND
collision-correct, and located the real LIVE blocker in the bridge.

### 4.1 The driver stops movers at walls (proven)

Two new end-to-end tests in `holtburger-dat` `transition::test_utils`:

- **`find_transitional_grounded_walker_stops_at_wall`** — a GROUNDED player
  (CONTACT held by a floor) walking `x=2 → -2` into a wall at `x=0` stops at
  **`x=0.5`** (one radius short). The CONTACT branch (`resolver_find.rs:214`) routes
  the wall hit through `step_sphere_up → step_up_slide → slide_sphere`, which stamps
  the horizontal `collision_normal`; `validate_transition:132-134` promotes it to
  `sliding_normal` and the next `adjust_offset` zeroes the into-wall step.
- **`find_transitional_airborne_mover_stops_at_wall`** — a non-CONTACT airborne
  mover (above a floor) also stops at `x=0.5`, via the non-CONTACT branch
  (`resolver_find.rs:259 → set_collide → transitional_insert` collide block →
  COLLIDED with `collision_normal = step_up_normal`).

### 4.2 Why the OLD §4 test "passed through" — a FIXTURE artifact, not a bug

The old `..._walker_blocked_by_wall_...` probe used `scenes::vertical_wall()` — a
**bare wall with NO FLOOR**. Two harness consequences, neither a driver bug:
1. **CONTACT is the discriminator.** `validate_transition:183-194` recomputes
   CONTACT from the contact plane every step; a floorless scene clears it, so the
   mover takes the non-CONTACT *landing* branch (`:259`), never the slide branch.
2. **`check_cell` nulling.** `SynthEnvCell::point_in_cell` only counts a point
   "inside" within 1.0 of a WALKABLE poly; floorless ⇒ no walkable poly ⇒
   `check_other_cells/find_cell_list` nulls `check_cell` after step 0
   (`driver_cell_dispatch.rs:215`), silently disabling collision for the rest of
   the walk. (Instrumentation showed `find_collisions` ran only ONCE.)

The old `find_collisions / transitional_insert returns COLLIDED=2` "localization"
was a single-call direct probe (DIAG C), which works; the full stepping loop never
re-ran collision because the cell was unseated. The handoff's "set `sliding_normal`
on COLLIDED" fix direction was chasing a symptom that doesn't exist in a grounded
scene. The old ignored test was REPLACED by the two passing tests above.

### 4.3 The REAL live blocker (now fixed) — two bridge gaps, Phase C

The faithful path is only live behind `?faithfulTransition=on`. Its actual
passthrough lived in `holtburger-world` `faithful_bridge.rs`, NOT the driver:
1. **`SceneObjCell::find_obj_collisions` was an identity stub** → static objects
   (doors/props/furniture) in a baked env-cell were never tested. Now it sweeps the
   mover against each resident static's physics BSP (the decomp
   `CObjCell::find_obj_collisions` loop, acclient.c:347151).
2. **`SceneObjCell` used the base `point_in_cell` (returns false)** → `check_cell`
   nulled after step 0 in the bridge too, disabling ALL collision (env walls AND
   statics) across a multi-step walk. Now backed by the cell AABB. *This is the
   same class of bug as 4.2.2, in the live bridge — and the drift wall test missed
   it because it only asserted marshalling, never the stop.*

Both fixed in commit `380eb8f1`; proven by `faithful_static_object_stops_mover`
(stops at the static wall; control without the static walks through). **Remaining
for the live client:** the wasm DAT→`cell_static_physics_bsp` populate (§5 Phase C)
— nothing feeds the new table yet, so on the live path it's empty.

### 4.4 Lesson for the test suite

B2/B3's 250 tests + the drift harness asserted **termination + marshalling**, not
**outcome** (final position / grounded), which is why a passthrough survived 250
green tests. The new tests assert the stop position. Keep adding outcome assertions.

---

## 5. Remaining B4 phases (tasks #5–#8, queued behind the fix)

- **Phase B eye-test** (task #5 laptop part DONE): the 1070 **truly-headless** A/B
  (Holtburg run, academy corridor diagonal = cell-boundary R1, mansion entry/exit
  = portal, powerslide corner). **No longer blocked on §4** (driver is correct);
  blocked only on the box being free. NB the env-cell wall stop now works in the
  bridge (the `point_in_cell` re-seat fix), so the A/B should show env-wall parity
  even before the static populate lands.
- **Phase C** (#6): in-cell statics. **DRIVER + BRIDGE DONE** (commit `380eb8f1`):
  `SceneObjCell::find_obj_collisions` now sweeps each resident static's physics BSP
  via the faithful resolver, fed by the new per-cell `cell_static_physics_bsp`
  table; proven by `faithful_static_object_stops_mover`. **REMAINING (wasm-only):**
  the live FEED — `fetchEnvCellsInLandblock` builds render-only
  `StaticObjectPlacement`s; add a populate pass mirroring the outdoor
  `populateStaticsAabbsForLandblock` BSP extraction (lib.rs:12343-12443) to push
  each stab's resolved physics BSP into `insert_cell_static_physics_bsp`. Untestable
  natively (holtburger-web is wasm-gated) → validate via `capped-build wasm-pack`.
  NB the earlier note pointing at `resolve_static_bsp_pushout` was wrong: that's the
  approximate-path PUSHOUT; the faithful path uses the swept resolver, not pushout.
- **Phase D** (#7): outdoor terrain parity — blocked on a terrain physics-BSP;
  faithful path is indoor-only until then (outdoor uses the heightfield).
- **Phase E** (#8): flip `USE_FAITHFUL_TRANSITION = true` after the A/B passes;
  keep `?faithfulTransition=off` one release, then delete the approximate path.

Also `VERIFY(B4)`/`VERIFY(1070)` notes in `faithful_bridge.rs` /
`driver_validate.rs`: quaternion `set_rotate`/SLERP for orientation-changing
sweeps (Frame has no quaternion), real `CPhysicsObj` velocity/`has_gravity`,
portal-spanning cross-cell with real handles, EnvCell `water_type`.

---

## 6. Key decisions & conventions (do not regress)

- **FLOOR_Z = 0.66417… (cos 48.4°)** is the `ON_WALKABLE` gate; **Z_FOR_LANDING =
  0.0871557 (cos 85°)** is the default BSP `walkable_allowance`. **Two different
  thresholds, both load-bearing — never merge** (A15 R2). FLOOR_Z VERIFY is
  resolved: `cos(3437.746770784939)` IS the decomp literal.
- **Cell model:** `ObjCellHandle = Rc<dyn CObjCell>` (fat handles in `CellInfo`,
  A08 anticipated the swap from u32). `CellInfo` is Clone + manual Debug, NOT
  PartialEq/Default.
- **Cell-world access** is a threaded `&dyn CellWorld` param (never a `CTransition`
  field — preserves its derives). `step_up`'s signature is pinned by the resolver
  caller, so it recovers `world` from the **`DriverCtx` thread-local** (unsafe
  lifetime-erasure, RAII-guarded). The DriverCtx also holds the **recursion-depth
  guard** (`debug_assert!(depth < 16)`, A15 R1) — keep `transitional_insert`
  installing it.
- **`check_walkables`** is the recursion-termination gate (A15 R1/D1). Its port
  reuses `check_small_walkable` (radius²·0.25 == decomp `check_walkable(half-radius)`).
- **`get_block_offset` fold sign** is verified across a landblock seam by
  `resolver_step_down.rs::step_down_cross_landblock_plane_carry_shifts_d`.
- **Resolver return codes** are raw i32: 1=OK 2=COLLIDED 3=ADJUSTED 4=SLID.
- **B4 flag-OFF must stay byte-identical** to the existing approximate path.

---

## 7. The 1070 GPU box (for the eventual eye-test)

- `<user>@<gpu-box-ip>` (tailscale, pubkey). Reachable; GTX 1070 healthy.
- **A person uses it — as of this handoff, Roblox is running.** The eye-test must
  be **truly headless** (software render, no GPU contention) OR wait for the box
  to be free. Re-probe first:
  `ssh <user>@<gpu-box-ip> "tasklist /FI \"IMAGENAME eq RobloxPlayerBeta.exe\" /NH & tasklist /FI \"IMAGENAME eq chrome.exe\" /NH"`.
  If free → off-screen MODE2i (`--use-angle=d3d11`, off-screen window, CDP :9333)
  per `~/.claude/.../memory/MEMORY.md`. NEVER kill the person's chrome; clean up by
  `--user-data-dir` match only.

---

## 8. Risks carried forward (from the A15 audit + the Discord corpus)

- **Adjacent-landblock collision load** (community-confirmed): retail/ACE only
  checks the current 24×24 cell; off-center building BSP overruns the boundary →
  walk-through. The faithful `find_cell_list`/`add_all_outside_cells` models the
  full cell-ring; wire it to load neighbors at B4 cell transitions.
- **Keep the driver in cell-local space**, marshal world↔local once per entry/exit
  (float precision) — the bridge already does this.
- **Portal collision as the inside/outside gate**; **dual movement path**
  (DoMotion vs apply_raw_movement) for powerslide fidelity; **client position
  autonomy, server corrects** (reset local velocity on autopos).
- Reference clients: merklejerk/holtburger (full client), trevis's PickerDemo
  (physics-poly extraction).

---

## 9. Suggested next session

§4 is RESOLVED (driver correct; bridge static-collision + cell re-seat fixed +
tested). The path forward:

1. **Phase C live feed (wasm):** add the `fetchEnvCellsInLandblock` populate pass
   that pushes each env-cell stab's resolved physics BSP into
   `insert_cell_static_physics_bsp` (recipe in §5). Validate with
   `capped-build wasm-pack`. Without this the new `find_obj_collisions` runs over
   an empty table on the live path (no regression, just no static collision yet).
2. **Phase B eye-test:** re-probe the 1070; if free, run the truly-headless A/B.
   Env-cell wall stop should already show parity (the `point_in_cell` fix); static
   collision parity follows step 1.
3. **Phase D** (outdoor terrain parity, when a terrain physics-BSP exists) and
   **Phase E** (flip `USE_FAITHFUL_TRANSITION = true` after the A/B passes).
4. Optional fidelity refinements (tagged in code): `SceneObjCell::point_in_cell`
   via the precise cell-membership BSP (currently AABB); cross-portal cell
   resolution; per-static scale.
