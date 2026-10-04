# Door pipeline — holtburger-web vs OpenAC vs retail (read-only study, 2026-10-04)

Paths: `HB=<repo>/external/holtburger`, `OA=.../external/OpenAC`,
`ACE=.../external/ACE/Source/ACE.Server`, decomp `~/ac-headers/acclient.c`.
Every file:line below was read and checked.

## 0. Ground truth (what the server sends and what retail does)

**ACE `WorldObjects/Door.cs`**
- Spawn (`SetEphemeralValues`, :37-52): closed door → `CurrentMotionState = (NonCombat, Off)`, not ethereal.
  `DefaultOpen` door → `(NonCombat, On)` + `Ethereal = true`. Both reach the client in ObjectCreate
  (PhysicsDesc state + MovementData).
- `Open()` (:119-143): broadcasts **UpdateMotion(On)**, then sets `Ethereal = true` and broadcasts
  **SetState** right away. The order is motion first, then state.
- `Close()` (:147-178): broadcasts **UpdateMotion(Off) only**. `FinalizeClose()` (:180-208) runs after
  `GetAnimationLength(On→Off)`. It clears Ethereal and only then sends **SetState**. With
  `allow_door_hold`, ACE first runs `ethereal_check_for_collisions` on the **server** and keeps the door
  ethereal (polling every 1 s) while something overlaps it. So the door stays passable for the whole
  close swing. The overlap defer is done on the server, not the client.

**Retail decomp**
- `SmartBox::HandleSetState` (acclient.c:144395) queues the update when the object is unknown or its
  instance stamp is newer. `SmartBox::DoSetState` applies it only when `state_timestamp` beats
  `update_times[2]`, then calls `CPhysicsObj::set_state`.
- `CPhysicsObj::set_state` (:322172) **assigns the state verbatim**. It only reacts to the lighting,
  nodraw and hidden bits. It does **not** call `set_ethereal`, so a wire SetState gets no
  overlap check.
- `CPhysicsObj::set_ethereal` (:319047) and its `ethereal_check_for_collisions` defer (:317832) are reached
  only from `EtherealHook::Execute` (:342312), the animation hook.
- `CPhysicsObj::FindObjCollisions` (:316159):
  - Skips the object entirely only when it is **ETHEREAL AND IGNORE_COLLISIONS** (`v4 & 4 && v4 & 0x10`).
  - ETHEREAL alone (or a non-static target while the mover is ethereal) sets `obstruction_ethereal`.
    It returns OK early on step-down, and any hit becomes `OK_TS` and is only recorded (:316296-316304).
  - **IGNORE_COLLISIONS alone still collides.** ACE `Physics/PhysicsObj.cs:385` does the same, and
    uses IgnoreCollisions only to suppress collision *reporting* (:3348/:3363).
  - Branch order: `HAS_PHYSICS_BSP (0x10000)` → `CPartArray::FindObjCollisions`. That walks per-part
    BSPs at the parts' **current, animated** frames. Otherwise it uses the cylsphere, then the sphere.
- `MotionTableManager::HandleEnterWorld` calls `CSequence::remove_all_link_animations` and drains pending
  animations. A door created in the `On` state appears already open, with no swing.

**OpenAC (reference)**
- `CollisionExemption.ShouldSkip` (`OA/src/AcDream.Core/Physics/CollisionExemption.cs:11`) skips only on
  ETHEREAL && IGNORE_COLLISIONS, which is exact retail.
- `FindObjCollisionsInCell` (`TransitionTypes.cs:2668`) runs **inside the transition, per cell**:
  - `etherealForTest` plus the step-down skip (:2718-2724).
  - The ethereal hit becomes OK (:2832-2838).
  - `BspOnlyDispatch` (:972) means a HAS_PHYSICS_BSP object never falls back to a cylinder.
- Collision shapes are built once per spawn:
  - Per-part BSP at the motion table's **default-state pose**, with ObjScale and post-AnimPartChange
    GfxObjs (`OA/src/AcDream.Runtime/Physics/LiveEntityCollisionBuilder.cs:109-119`,
    `MotionTablePose.cs:10-34`).
  - They are not re-posed per frame. This is a simplification of retail, but it is safe for doors
    because a door is ethereal whenever its parts are away from the closed pose.
- SetState is gated by `PhysicsTimestampGate.TryAcceptStateEvent`
  (`OA/src/AcDream.Runtime/Entities/InboundPhysicsStateController.cs:468-473`). The hidden-transition fold
  is in `RetailPhysicsStateTransition.cs:29-59`, and `ShadowObjectRegistry.UpdatePhysicsState` is at :2310.
- Spawn motion: `SpawnMotionInitializer.cs:20-24` installs the default state, sets the wire cycle and
  calls `HandleEnterWorld` (`Motion/MotionTableManager.cs:202-206`), so no swing plays at spawn.
- EtherealHook is deliberately ignored for visuals (`tests/AcDream.Core.Tests/Rendering/TranslucencyHookSinkTests.cs:37`).

## 1. Findings (most important first)

### F1 — Door collision runs as a post-hoc XY clamp outside the transition, and the clamp never re-buckets the cell
- **Mechanism.**
  - The live path is the faithful driver (`USE_FAITHFUL_TRANSITION=true`, `HB/crates/holtburger-core/src/client/movement/system.rs:804`).
    It collides env-BSP and statics only.
  - Doors and other entities are applied afterward: `finish_manual_slice_via_transition` (system.rs:7313-7396)
    clamps the straight begin→realized XY residual, then adds the correction to `pose.coords` (:7395-7396).
  - Nothing re-runs wall collision, re-buckets the cell or does a cell transit after that correction.
- **Why it matters for doors.** A door leaf sits on the doorway portal. The transition can carry the mover
  across the threshold into the EnvCell. The clamp then pulls XY back outside while the pose keeps the
  indoor cell id, which gives wrong-cell, indoor/outdoor flicker or rubber-band symptoms. A slide along
  the leaf can also push into the jamb walls, because walls are not re-tested.
- **Native flag vs. live web build.** The native const `USE_FAITHFUL_ENTITY_COLLISION=false` (:886) means
  headless/native builds have **no door collision at all**. The web runtime is default-on
  (`parse_faithful_entity_collision_flag`, `HB/apps/holtburger-web/src/lib.rs:527`, test :31542).
- **Retail.** `CObjCell::find_obj_collisions` → `CPhysicsObj::FindObjCollisions` runs per step, per cell,
  inside `CTransition`.
- **OpenAC.** `TransitionTypes.cs:2668-2916`, inside the transition.
- **ACE.** Not involved; this is client physics.
- **Confidence:** high on the structure; medium that the cell-desync is the live symptom.
- **Fix.** Register door and other entity BSPs as `CObjCell` occupants of the faithful driver. Extend
  `SceneObjCell::find_obj_collisions` (`faithful_bridge.rs:~590-620`) to iterate entity shadows with the
  OpenAC/retail ethereal rules. As a stopgap, flip the native const to `true` and re-derive the cell
  (`current_cell`) after the XY correction.

### F2 — IGNORE_COLLISIONS alone is treated as passable (retail and ACE still collide)
- **holtburger.** `Entity::is_collidable` (`HB/crates/holtburger-world/src/entity.rs:1241-1245`) uses
  `!intersects(ETHEREAL | IGNORE_COLLISIONS)`. The same OR is claimed in
  `entity_collision.rs:20-22`, `lib.rs:36937` and `system.rs:866-868`. That claim is wrong: the decomp is
  `&&` (acclient.c:316195-316196).
- **Docs.** `lib.rs:520-521` and `docs/url-flags.md:1088` say academy training doors "carry IGNORE_COLLISIONS
  even closed" and are intentionally passable. Retail would block them.
- **OpenAC.** `CollisionExemption.cs:11` (AND).
- **Confidence:** high on semantics. Whether a retail client blocked at those academy doors is DAT/weenie
  dependent and needs an in-game check.
- **Fix.** `is_collidable = !(ETHEREAL && IGNORE_COLLISIONS)`. Treat ETHEREAL-only as "OK but record"
  (pass-through), matching OpenAC `etherealForTest`. Keep the camera-sweep caller (`lib.rs:36967`)
  consistent.

### F3 — SetState has no timestamp or instance gating
- **holtburger.** `apply_set_state_update` (`HB/crates/holtburger-world/src/state/mutations.rs:1800-1843`)
  writes `entity.physics_state = data.physics_state` unconditionally. `Entity` has no state-sequence slot:
  `entity.rs:994-1003` lists indices 0, 3, 4, 5, 6 and 8, with no 2 = `update_times[2]`.
- **Effect.** A stale or reordered SetState, or one carrying an old instance (a door re-created after LB
  churn), can flip open/closed collision and the DoorStateChanged visuals backwards.
- **Retail.** `SmartBox::HandleSetState`/`DoSetState` (:144395).
- **OpenAC.** `InboundPhysicsStateController.cs:468-473`.
- **Confidence:** high (code); low-medium for live frequency.
- **Fix.** Store `state_sequence` per entity. Drop the update unless `instance_sequence` matches and
  `state_sequence` is newer (wrap-aware, the same 0x7FFF compare used elsewhere).

### F4 — The A7-R6 "ethereal recheck" models the wrong retail path (keep it OFF, fix the doc)
- **holtburger.** `entity.rs:977-992` and `mutations.rs:1820-1838` claim that a retail *wire*
  ethereal→solid transition defers via `set_ethereal(0)`. It does not: retail's wire path is
  `set_state`, which is verbatim (:322172). `set_ethereal` is reached only by `EtherealHook::Execute`.
  ACE already does the door-hold overlap check on the server (Door.cs:185-205) before it sends the
  SetState.
- **Confidence:** high.
- **Fix.** Leave `USE_ETHEREAL_RECHECK=false` and correct the comments. A player embedded in a
  just-closed door is handled by `USE_PENETRATION_ESCAPE` (`entity_collision.rs:64`), which stands in for
  retail's AdjustPosition.

### F5 — EtherealHook is rendered as a 0.4-opacity ghost and never reaches physics
- **holtburger.** hookType 6 → `_applyEtherealToEntity` (`HB/apps/holtburger-web/scene3d/entities.js:16396-16404`,
  :16716-16742). The method's own doc admits this is not retail.
- **Retail.** `EtherealHook::Execute` → `set_ethereal` (physics only, no visual).
- **ACE.** The `Door.cs:190` comment says door animations carry EtherealHook, so opening or closing doors
  may turn translucent mid-swing in holtburger.
- **OpenAC.** Ignores the hook visually (`TranslucencyHookSinkTests.cs:37`).
- **Confidence:** medium. Confirm by dumping the hooks of a door MotionTable's On/Off link animations
  (e.g. for Setup 0x020019FF).
- **Fix.** Drop the opacity change. Optionally forward the hook to a Rust-side local ethereal bit,
  overridden by the next wire SetState.

### F6 — Door collision geometry is per-Setup, with no object scale and no part swaps, and with an asymmetric fallback
- **holtburger.** `setup_entity_physics_geometry` → `walk_setup_parts_with_geom_and_bsp`
  (`HB/apps/holtburger-web/src/lib.rs:7410`) passes empty `model_changes` and `mtable_override=None`. The
  pose therefore comes from `setup.default_motion_table` and the default-state cycle's `part_frames[0]`
  (`try_resolve_idle_anim_frame_with_override`, lib.rs ~7060-7110).
  - Object scale is explicitly not modelled (`entity_collision.rs:130`).
  - The geometry is keyed only by setup id (`state/types.rs:975-985`).
- **OpenAC.** Uses the wire motion table, ObjScale, `effectivePartGfxObjIds` and the anim `LowFrame`
  (`LiveEntityCollisionBuilder.cs:109-119`, `MotionTablePose.cs:31`).
- **Neither follows animated frames as retail does.** That is fine for doors, which are ethereal while
  swinging under ACE.
- **Fallback gaps.**
  1. Geometry for a door that spawned open (ethereal) is never requested until it closes. The wanted list
     filters `is_collidable()` (`types.rs:998-1004`), so right after the first close the door falls back to
     the circle-at-hinge arm.
  2. A HAS_PHYSICS_BSP entity without resident geometry uses a circle (`entity_collision.rs:337-352`).
     Retail and OpenAC (`BspOnlyDispatch`) never do.
- **Confidence:** medium (scaled gates and odd motion tables are the exposure).
- **Fix.** Key the geometry by (setup, mtable, scale, part swaps). Request it for every HAS_PHYSICS_BSP
  entity regardless of ethereal. Do not fall back to a circle for BSP-flagged objects; treat them as
  non-blocking until the geometry is resident, or block on load.

### F7 — The origin-distance prefilter can miss wide doors and gates
- **holtburger.** The prefilter is `travel + radius + 2.0` m measured from the entity **origin**
  (`system.rs:7320`, and the `transition.rs:350-375` gather). The door origin is the hinge, and a house leaf
  is already 1.93 m wide (`entity_collision.rs:37-44`). For double doors or gates wider than about 2.4 m,
  the far end is not gathered.
- **Retail and OpenAC.** Use cell shadow lists, so the gather is cell-based.
- **Confidence:** medium.
- **Fix.** Prefilter with `geometry.bound_radius`, or gather by cell.

### F8 — Building-AABB toggles and cell-mesh exclusion hacks are not retail
- **holtburger.**
  - On DoorStateChanged, the code finds the building-part AABB that contains the door origin and
    deactivates **the whole part** (`lib.rs:44410-44483`, spawn arm at `lib.rs:46650-46700`,
    `scene.rs set_door_aabb_active`).
  - For indoor doors it removes every cell-wall triangle whose centroid lies within ±1.5 m of the door
    origin (`lib.rs:44486-44545`, `physics.rs:837-856`/:991-1005).
- **Retail.** Door leaves are separate weenie CPhysicsObjs. Building and EnvCell BSPs never contain the
  leaf, so nothing in static geometry should toggle.
- **Under the default faithful path** this machinery is inert (`faithful_bridge.rs:~590` says so). Under
  any legacy fallback it opens holes in real walls and building AABBs.
- **Confidence:** high.
- **Fix.** Delete it, or hard-gate it to the legacy pipeline. The `lib.rs:838` caveat about "door leaf as
  a building part" is a false premise.

### F9 — Visual state is driven from two triggers, one of them non-retail
- **holtburger.** The kind=15 DoorStateChanged handler is derived from the SetState ETHEREAL bit
  (`HB/apps/holtburger-web/index.html:9750-9813`) and calls `playDoorMotion` into the `setMotion` door branch
  (`entities.js:9360-9367`, :10425-10460, low-16 dedup). It also deduplicates against the UpdateMotion
  path. Because ACE sends UpdateMotion(Off) about one animation length *before* the closing SetState, the
  dedup holds.
- **Escape-mode hack.** With `?unifiedMotion` set to anything except `door`/`on` (for example `=off`),
  `inst.root.rotation.z = ±π/2` (index.html:9805). That hack is not retail and rotates the entire entity.
- **Wrong doc premise.** `docs/a9-door-animation-investigation-2026-05-28.md:22` says "ACE doesn't
  broadcast UpdateMotion for doors". That is false (Door.cs:124/152).
- **Spawn.** Spawning snaps to the hold pose (`entities.js:5023-5060`), which matches retail
  `HandleEnterWorld`.
- **Confidence:** high.
- **Fix.** Drive visuals only from UpdateMotion, as retail does. Make the kind=15 handler visual-free (or
  keep it as a no-op dedup) and delete the root-rotation snap.

## 2. What already matches
- ETHEREAL exemption for an open door, in effect (pass-through).
- ACE's door state is read from ObjectCreate (`hydration.rs:258-272`, `lib.rs:46650-46660`).
- On/Off are held as one-shot link plus hold (`entities.js:1025-1041`).
- The embedded-mover escape exists (`entity_collision.rs:47-64`, :226-271).
- Per-part BSP is used for HAS_PHYSICS_BSP doors once resident (COL-03).

## 3. Suggested order
F2 (one-line semantic fix) → F3 (sequence gate) → F1 (move entity collision into the faithful driver,
or at least re-bucket after the clamp) → F6/F7 (geometry residency and gather) → F5/F9/F8 cleanups → F4 docs.
