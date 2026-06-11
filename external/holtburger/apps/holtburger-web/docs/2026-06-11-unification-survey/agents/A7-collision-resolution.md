# A7 collision-resolution — unification survey

Scope (per §5): contact/slide math inside the transition system — walkable checks,
step-up/step-down, slide-along-contour, ethereal checks, water depth. A6 owns the
pipeline/cell-transit shape; everything below is about the *rules* applied at a contact.

## 1. Retail map

All resolution lives inside one recursive driver, `CTransition::transitional_insert`
(`acclient.c:312834-313012`). Per insertion attempt:

1. `insert_into_cell` (`acclient.c:311632`) runs the sphere/BSP tests; per-poly floor hits
   land in `OBJECTINFO::validate_walkable` (`acclient.c:314161`).
2. On a **collide** result with a valid contact plane: `check_walkable(0.0871557)` then a
   re-insert with `insert_type = 1`; failure restores the saved pose and reports
   `Collided` with either the last contact plane (velocity killed) or the step-up normal
   (`acclient.c:312897-312940`).
3. On a **negative-poly hit** (ceiling-ish): straight `CSphere::slide_sphere`, or
   `step_up` then `SPHEREPATH::step_up_slide` on refusal (`acclient.c:312942-312959`).
4. **Grounded, no contact**: `step_down`, halving the probe when the sphere is small
   (`step_down_ht > 2r ⇒ try ht/2 twice`, `acclient.c:312975-312993`), else `edge_slide`
   (`acclient.c:312986-312995`).

Key rules, each a self-contained predicate:

- **Walkable classifier** — `CPhysicsObj::is_valid_walkable` is exactly
  `normal.z >= PhysicsGlobals::floor_z` (`acclient.c:316500-316503`); `floor_z` is
  initialised from a `cos(...)` whose decompile is garbled (`acclient.c:800528-800531`);
  ACE pins the value: `FloorZ = 0.66417414618662751`
  (`external/ACE/Source/ACE.Server/Physics/PhysicsGlobals.cs:50`).
- **Landing allowance** — airborne objects use `z_for_landing = 0.0871557` (~85° wall!)
  instead of `floor_z` as the walkable allowance for step-up/step-down
  (`acclient.c:40376`, consumed at `acclient.c:312807-312808` and `312966-312967`), i.e.
  you may *land* on much steeper geometry than you may *walk* onto.
- **Step heights are per-object DAT data** — `CPartArray::GetStepUpHeight/-Down` return
  `setup->step_up_height * scale.z` with fallback `0.0099999998`
  (`acclient.c:325400-325424`); cached per transition in `OBJECTINFO::init`
  (`acclient.c:314128-314129`) together with the ethereal bit (`acclient.c:314131`) and
  a per-object step-down enable from object-state bit 6 (`acclient.c:314132`).
- **step_down** (`acclient.c:312629-312682`) — offset check-pos by `-step_down_ht`,
  re-insert, and only accept when `contact_plane.N.z >= z_val` AND (for player-state
  objects) `check_walkable(z_val)` passes (`acclient.c:312664-312669`), then a final
  `insert_type=1` re-insert confirms the snapped pose (`acclient.c:312671-312675`).
- **check_walkable** (`acclient.c:312475-312524`) — a *validation probe*: re-runs
  `transitional_insert` with `sphere_path.check_walkable = 1` and
  `walkable_allowance = z_chk` from a `-step_down_height` offset (probe halved for small
  spheres, `acclient.c:312506-312513`); inside `validate_walkable` the probe rejects any
  floor penetration outright (`return 2`, `acclient.c:314250-314251`).
- **validate_walkable** (`acclient.c:314161-314270+`) — the per-floor-poly contact rule:
  ethereal objects back up along their motion to the plane and report `Adjusted`
  (`acclient.c:314187-314220`); solid objects measure plane distance **plus
  `water_depth`** (`acclient.c:314224-314228`) so shoreline cells carry a raised floor;
  step-down hits scale the remaining walk interpolation (`walk_interp`,
  `acclient.c:314259-314265`).
- **edge_slide** (`acclient.c:312685-312791`) — four-way branch for a player walking off
  a walkable edge: (a) too-steep contact ⇒ `cliff_slide`; (b) walkable tracked ⇒
  `precipice_slide`; (c) other valid contact ⇒ restore + OK; (d) no contact ⇒ re-probe
  `step_down` at the walkable position, then `precipice_slide`
  (`acclient.c:312710-312772`).
- **cliff_slide** (`acclient.c:312005-312080`) — seam skid: `N_new × N_last` with z
  zeroed, offset along the seam, sets the collision normal, returns `Adjusted`.
- **precipice_slide** (`acclient.c:313980-314040`) — finds the crossed edge of the
  walkable poly (`CPolygon::find_crossed_edge`), orients its normal against the motion,
  and `slide_sphere`s along it — the "skid along the cliff lip" behavior.
- **Ethereal re-check** — `CPhysicsObj::ethereal_check_for_collisions`
  (`acclient.c:317832-317866`) keeps an object ethereal while it still overlaps anything
  (consulted by `set_ethereal`, `acclient.c:6438`), so a door closing on a player can't
  trap them inside its geometry.
- **Water depth source** — `CObjCell::get_water_depth` / `CLandBlockStruct::calc_water_depth`
  (`acclient.c:7197`, `7330`).

## 2. Ours map

| layer | site | what it owns |
|---|---|---|
| Rust constants/helpers | `crates/holtburger-world/src/spatial/physics.rs:463` `FLOOR_Z = 0.664_174_15`; `:106-107` `PLAYER_STEP_UP_HEIGHT = 0.6` / `PLAYER_STEP_DOWN_HEIGHT = 1.5` (hardcoded from Setup `0x0200_0001`, doc at `:86-105`) | classifier + step caps |
| Rust decisions | `physics.rs:593-612` `step_up_decision`, `:641-648` `step_down_decision`, `:480` `highest_floor_z_under`, `:534` `floor_normal_under`, wall classifier `WALL_NORMAL_MAX = FLOOR_Z` at `:822` | pure contact predicates (unit-tested) |
| Rust slides | `physics.rs:1186-1193` `slide_residual_along_wall_tangent` (Stage-1), `:1241-1272` `cliff_slide_residual_along_seam` (Stage-2, faithful port incl. `RETAIL_EPSILON = 0.0002`) | slide math |
| Live resolver | `crates/holtburger-core/src/client/movement/system.rs` — flags `USE_STEP_UP_DOWN = true` (`:64`), `USE_CLIFF_SLIDE = false` (`:152`), `USE_PRECIPICE_SLIDE_REENTRY = false` (`:120`), `USE_TERRAIN_WALKABLE_GATE = false` (`:297`), `USE_WATER_COLLISION = false` (`:321`); step-up + refused-step edge-slide (`:2052-2150`); `last_known_wall_normal` stamp (`:2177-2179`); outdoor water/slope gates (`:2315-2412`); outdoor step-down (`:2480-2521`); indoor step-down F4-1 (`:2603-2638`) | orchestration (single-pass, not retail's recursive insert) |
| Ported CTransition skeleton | `crates/holtburger-world/src/spatial/collision.rs:497` `insert_into_cell`, `:524` `placement_insert`, `:546` `check_other_cells`, `:578` `validate_placement`; `physics_globals::LANDING_Z = 0.0871557` (`:83`) | **placement only** — no `transitional_insert`/step/slide yet (A6 seam) |
| Entity contact | `crates/holtburger-world/src/spatial/entity_collision.rs:82` `clamp_delta_against_entities`, gated on `Entity::is_collidable()` (`crates/holtburger-world/src/entity.rs:982-986`: `!(ETHEREAL \| IGNORE_COLLISIONS)`) consumed at `system.rs:2010,2031` | ethereal honored on entity path |
| Water | `crates/holtburger-world/src/state/types.rs:540-589` `water_depth_at` (ports `get_water_depth`/`calc_water_depth`), consumed at `system.rs:2328-2332` behind `USE_WATER_COLLISION` | water depth |
| JS | none — contact math is all Rust; the JS-side terrain raycast at `scene3d/loop.js:1826-1841` is render-Z only (F4-3, out of A7 scope) | — |

## 3. Divergences

| # | behavior | retail cite | our cite(s) | class | symptom | tracked? |
|---|----------|-------------|-------------|-------|---------|----------|
| 1 | step heights are per-setup DAT values × `scale.z` (fallback 0.01) cached per transition | acclient.c:325400-325424, 314128-314129 | physics.rs:106-107 hardcodes the player-body 0.6/1.5 for everything; setup fields parsed but unread (doc physics.rs:95-105) | DIFF-ALGO | scaled/non-player movers step with human-body heights | untracked (noted as "gap 3 follow-up" in-code only) |
| 2 | step-down accepts only a *walkable* landing: `contact_plane.N.z >= z_val` + `check_walkable` re-probe | acclient.c:312664-312669 | physics.rs:641-648 snaps on pure height delta (any drop ≤ 1.5, any negative drop), no normal test at either consumer (system.rs:2492, :2625) | DIFF-ALGO | snap onto >48.4° downhill faces; F4-2 gate covers uphill only and is default-off | partially F4-2 |
| 3 | `check_walkable` validation probe (re-insert with `check_walkable=1`, reject on any floor penetration; `walk_interp` scaling) | acclient.c:312475-312524, 314250-314265 | no equivalent anywhere; grep `check_walkable\|walk_interp` in crates/ hits only the parser-side names | MISSING | accepted step-downs never re-validated; multi-step walk interpolation absent | untracked |
| 4 | walkable-edge `precipice_slide` (+ `edge_slide` walkable branch, save/restore re-entry) | acclient.c:313980-314040, 312710-312772 | only a backup-pose stub behind `USE_PRECIPICE_SLIDE_REENTRY = false` (system.rs:120, 2489-2529); no slide impl; deferral documented at system.rs:2214-2224 | MISSING | walking off a cliff lip stops/falls abruptly instead of skidding along the edge | untracked (in-code TODO only) |
| 5 | `cliff_slide` seam skid applies wherever two contact planes wedge | acclient.c:312005-312080 | faithful port physics.rs:1241-1272 but `USE_CLIFF_SLIDE = false` (system.rs:152) and indoor-only (outdoor building clamp surfaces no normal, system.rs:2226-2228) | DIFF-ALGO (gated) | concave outdoor corners stop dead | untracked |
| 6 | walkable slope gate always on (`is_valid_walkable` = `normal.z >= floor_z`) | acclient.c:316500-316503 | `USE_TERRAIN_WALKABLE_GATE = false` (system.rs:297; gate body :2357-2412 incl. G-6 contour slide) | DIFF-ALGO (gated) | run up arbitrary cliffs at full speed | **F4-2**, G-6 |
| 7 | water depth folded into every land-cell floor contact; EntirelyWater collides | acclient.c:314224-314228, 7197, 7330 | shipped port (state/types.rs:540-589; system.rs:2328-2356) but `USE_WATER_COLLISION = false` (system.rs:321) | DIFF-ALGO (gated) | stroll across lake/ocean bottoms | **F4-4**, G-8 |
| 8 | airborne landing uses `z_for_landing = 0.0871557` walkable allowance — refuse perching, but allow landing on steep faces | acclient.c:40376, 312807-312808, 312966-312967 | outdoor touchdown snaps to terrain Z with no slope test (system.rs:2339-2342); indoor snap-up likewise (system.rs:2595-2602); `LANDING_Z` exists (collision.rs:83) but is consumed only by a test (collision.rs:694) | MISSING | landing sticks to any slope; no slide-off-on-landing | untracked |
| 9 | ethereal-expiry re-check: object stays ethereal while still overlapping | acclient.c:317832-317866 (consulted by `set_ethereal`, acclient.c:6438) | entity path honors current ethereal bit only (entity.rs:982-986, system.rs:2010); no overlap re-check on flag clear (grep `ethereal` in movement/system.rs: zero hits) | MISSING | a door closing on a player can trap them in its geometry | untracked |

PARITY notes (no work): `FLOOR_Z` constant matches ACE bit-for-bit (physics.rs:463 vs
PhysicsGlobals.cs:50 vs acclient.c:316502); Stage-1 wall slide is the same projection
retail's `slide_sphere` no-contact branch performs (physics.rs:1186-1193 vs
acclient.c:7460-cluster); ethereal pass-through for *current* state matches
(entity.rs:982-986 vs acclient.c:314131,314187); step-up cap semantics match for the
player (physics.rs:593-612 vs acclient.c:312794-312831 with the player's 0.6).

## 4. Staged unification plan

Theme: the contact *predicates* are already centralized and unit-tested in
`spatial/physics.rs`; the gaps are (a) per-object inputs, (b) the validation probe, and
(c) gated-off shipped rules. Stages are independent of A6's pipeline merge but feed it —
when A6 grows `transitional_insert` in `collision.rs`, it should consume these same
helpers, not new copies.

- **R1 — per-setup step heights.** Scope: hydrate `step_up/step_down_height × scale.z`
  (fallback 0.01) from `SetupModel` (parsed at
  `crates/holtburger-dat/src/file_type/setup_model.rs:310-311`) into player/entity state;
  thread through the two `step_*_decision` call sites. Files: `system.rs`,
  `holtburger-world/src/entity.rs`, `player/types.rs`. Flag: `USE_SETUP_STEP_HEIGHTS`
  (default-off). wasm-rebuild. Tests: headless-now (unit: scaled setup ⇒ scaled caps;
  player setup ⇒ exactly 0.6/1.5 so default behavior is byte-identical). Rollback: flag off.
- **R2 — walkable step-down (closes #2/#3).** Scope: one
  `step_down_resolve(feet_z, dest_floor, dest_normal, step_down_height, allowance)` in
  `physics.rs` that adds retail's `N.z >= allowance` acceptance to `step_down_decision`,
  used by BOTH the outdoor (system.rs:2492) and indoor (system.rs:2625) arms — removing
  the duplicated snap logic. Flag: `USE_WALKABLE_STEP_DOWN` (default-off). wasm-rebuild.
  Tests: headless-now (steep downhill face ⇒ Fall not Snap); 1070-gated eye-test for feel.
  Rollback: flag off.
- **R3 — landing allowance (closes #8).** Scope: on touchdown (outdoor system.rs:2339,
  indoor :2595) test the landing surface normal (`terrain_normal_at` /
  `floor_normal_under`) against `LANDING_Z` (already in collision.rs:83); refused landing
  keeps falling with a Stage-1 slide of the lateral. Flag: `USE_LANDING_WALKABLE`
  (default-off). wasm-rebuild. Tests: headless-now unit; 1070-gated (cliff-face jump).
- **R4 — precipice_slide (closes #4).** Scope: implement `find_crossed_edge` + edge slide
  behind the existing `USE_PRECIPICE_SLIDE_REENTRY` stub (system.rs:120), using the
  already-saved `backup_pose_for_step_down`. Files: `physics.rs` (edge finder),
  `system.rs` (re-entry). wasm-rebuild. Tests: 1070-gated (walk off a lip obliquely);
  headless unit for the edge finder. Rollback: flag off (stub already byte-identical).
- **R5 — default-on campaign (closes #5/#6/#7).** No new code: flip
  `USE_TERRAIN_WALKABLE_GATE`, `USE_WATER_COLLISION`, `USE_CLIFF_SLIDE` after their
  1070 eye-tests pass. Gate: "Stage 1 eye-test PASS" + per-flag eye-test. wasm-rebuild
  per flip (batch them). Rollback: flip back.
- **R6 — ethereal-expiry re-check (closes #9).** Scope: on door/entity ethereal→solid
  transition, overlap-test against the player sphere and defer the solidify while
  overlapped (retail `ethereal_check_for_collisions`). Files: `entity.rs`,
  `system.rs` entity arm. Flag: `USE_ETHEREAL_RECHECK` (default-off). wasm-rebuild.
  Tests: headless-now unit (overlapped close stays passable).

Seam with A6: R1-R6 deliberately keep the single-pass resolver; the *recursive*
`transitional_insert` + save/restore machinery is A6's pipeline merge. When that lands,
these rules transplant as-is because they are pure functions in `physics.rs`.

## 5. Scores

- Leverage: subsumes/closes **F4-2 remainder** (R2+R5), **F4-4 activation** (R5),
  **G-6/G-8 follow-ons** (R5); divergences #1, #3, #4, #8, #9 are NEW (untracked).
- Regression-risk reduction: **M** — every stage default-off; R2 also de-duplicates the
  indoor/outdoor step-down split-brain (2 sites → 1).
- Implementation risk: **L** for R1/R3/R6 (pure-function + plumbing), **M** for R2
  (touches the hot solver), **M-H** for R4 (new geometry code).
- 1070-dependency: **Y** for R2 feel-check, R3, R4, and all of R5; R1/R6 verifiable
  headless.
- Depends-on: Stage 1 eye-test PASS (movement DESIGN.md) before R5 flips anything;
  A6's pipeline survey for the eventual transplant; no dependency on A2-A5.

## 6. SPECULATIVE / UNRESOLVED

- `floor_z`'s initializer decompiles as `cos(3437.746770784939)` (acclient.c:800530) — a
  radians/degrees decompiler garble. I treated ACE's `FloorZ = 0.66417414618662751`
  (PhysicsGlobals.cs:50) as the pinned value per §2.6 source precedence; did not derive
  the original angle.
- Retail's small-sphere step-down halving (`step_down_ht > 2r ⇒ ht*0.5`, twice —
  acclient.c:312975-312993 and 312506-312513) has no counterpart in ours, but since our
  only live mover is the player (radius 0.4, heights 0.6/1.5 — never triggers the
  halving) I could not name a player-visible symptom; folded under #1's per-object
  follow-up rather than claiming a separate divergence.
- `OBJECTINFO::init` derives a per-object step-down *enable* from object-state bit 6
  (acclient.c:314132). I could not resolve which `PhysicsState` bit this is from the
  headers alone (greps tried: `0x40` near `PhysicsState`, `step_down = ~` in acclient.h);
  ours has no per-object step-down disable. Single-cited, so not in the table.
- `walk_interp` (acclient.c:314261-314265) scales remaining movement across a step-down;
  I believe ours has no analog because the solver is single-slice, but the *consumer* of
  walk_interp on the retail side (where the scaled fraction shortens the move) is inside
  `insert_into_cell`'s caller chain I did not fully trace — kept inside #3 as the probe's
  companion rather than a standalone row.
- Whether non-player entities ever run OUR step logic at all (NPC movement is
  server-driven; local simulation may not step entities) — `clamp_delta_against_entities`
  is player-vs-entity only. If entities never locally walk, divergence #1's blast radius
  is smaller than stated. Needs A1/A6 frame-orchestration confirmation.
