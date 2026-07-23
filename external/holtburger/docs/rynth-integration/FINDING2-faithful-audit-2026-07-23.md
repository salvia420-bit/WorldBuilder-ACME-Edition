# FINDING #2 — Faithful outdoor path settle-land audit (2026-07-23)

Audit of handoff FINDING follow-ups 2 (and 3). Scope: does
`faithful_bridge::faithful_find_transitional_position` — the TRUE live-gameplay
outdoor manual-drive path when terrain is scene-resident — share the ea2cc7c3
hover-latch, and how do we build a test that actually reaches it.

NOTE: the source tree lives under `crates/holtburger-world/src/spatial/` and
`crates/holtburger-dat/src/transition/`, not the paths the handoff quoted
(`faithful_bridge.rs:959`, `scene.rs:1666`, etc. are relative filenames — the
line numbers matched exactly, the directories differ). All citations below are
absolute-in-repo paths I read.

---

## Q1 verdict — CONDITIONALLY-BUGGY (no one-tick EPS snap; gravity-bounded, not a forever-latch)

### Trace of an outdoor airborne mover, vz≈0, hovering 2–6 cm above flat walkable terrain

1. Router: `faithful_find_transitional_position` outdoor branch runs the faithful
   terrain driver iff `faithful_outdoor && scene.terrain_landblock_resident(begin_cell)`
   (`faithful_bridge.rs:969-981`). Assume resident (real gameplay).

2. Entry object-state stamping (retail_ground gate,
   `faithful_bridge.rs:1211-1228`): the mover is airborne, so `grounded_entry` is
   false (`faithful_bridge.rs:1077`, `!input.airborne || input.force_grounded`).
   With no *live* contact (`live_contact == false`, flat terrain, nothing in
   `last_contact_plane`), the airborne arm **strips CONTACT**:
   `t.object_info.state &= !CONTACT` (`faithful_bridge.rs:1227`). ON_WALKABLE is
   not set either. So the mover enters the driver with **neither CONTACT nor
   ON_WALKABLE**.

3. The swept driver `find_transitional_position` (`driver_validate.rs:359`) steps
   begin→end. The terrain narrow-phase is `SceneObjCell::find_terrain_collisions`
   (`faithful_bridge.rs:217-265`) → `ObjectInfo::validate_walkable`
   (`objectinfo.rs:81`).

4. **The analogous touchdown/grounding decision is `objectinfo.rs:137-141`:**
   ```
   let v17 = ... (signed distance of the sphere BOTTOM to the terrain plane, + water_depth)
   if v17 >= -EPSILON {
       if v17 > EPSILON {
           return 1;   // hovering above the plane → OK, NO contact recorded
       }
       ... (exactly-resting branch: record contact)
   ```
   A mover whose sphere bottom is **above** the plane by more than `EPSILON`
   (~1e-5 m) returns OK with **no contact plane**. A 2–6 cm hover is far above
   that threshold, so no contact is recorded. This is the decomp-faithful analog
   of the legacy bare `pose.coords.z <= terrain_z` gate: contact only latches
   when the sphere bottom actually reaches the plane (`v17 <= EPSILON`), never
   while hovering.

5. Back in `transitional_insert` (`driver_spine.rs`), the step-down that *could*
   snap a hovering mover onto terrain is **gated on CONTACT**:
   `driver_spine.rs:289-306` returns early (`return 1`, no step-down) when
   `state & CONTACT == 0`. Because step 2 stripped CONTACT for the airborne
   mover, step-down never runs. (For a *grounded* mover CONTACT|ON_WALKABLE are
   stamped at `faithful_bridge.rs:1219-1220`, step-down runs, and it snaps to
   terrain — the downhill stick. That case is fine; it is only the airborne
   entry that is exposed.)

6. Grounded derivation (`faithful_bridge.rs:1338-1347`): with no settled
   `contact_plane` and no `walkable` poly, `grounded == false`. The edge-hold
   rebind (`faithful_bridge.rs:1363-1372`) needs `entry_walkable_contact.is_some()`
   (a carried walkable plane) — absent here — so it does not fire. Outcome:
   **`grounded == false`, pose z left at the hover height.** `is_airborne` stays
   latched; the frozen no-friction airborne planar arm keeps sliding.

### Why it is *conditionally* buggy and not "immune", nor "forever"

- Not immune: from a 2–6 cm hover the faithful path does **not** ground within
  one/two ticks. It grounds only once the caller's per-tick gravity integration
  carries the sphere bottom down to the plane (`v17 <= EPSILON`), which from a
  ~5 cm gap starting at vz≈0 takes ~3–4 manual-drive ticks; the frozen airborne
  planar velocity slides the whole time. This is exactly the residual the
  ea2cc7c3 EPS fix removes on the fallback path — the faithful path has **no
  equivalent one-tick EPS hover-snap**.
- Not a forever-latch: gravity keeps integrating `vertical_velocity` every tick
  regardless (same reasoning the tests.rs FINDING comment gives for the
  `resolve_floor_for_step` fallback), and the moment the descending sphere bottom
  crosses the plane the penetrating arm of `validate_walkable`
  (`objectinfo.rs:155-188`: `step_down || !ON_WALKABLE || valid` is true because
  ON_WALKABLE==0 → records contact, pushes the sphere straight up onto the plane,
  ts=3) grounds it and `validate_transition` (`driver_validate.rs:203-209`)
  re-derives CONTACT|ON_WALKABLE from the terrain normal (z≈1 ≥ FLOOR_Z). So it
  self-terminates in a bounded number of ticks — the same bounded-slide behavior
  the re-pinned fallback tests exercise, not the "unbreakable ~9 yd/s off Yaraq"
  catastrophe.

VERDICT: **conditionally-buggy** — identical bounded-slide exposure to the
un-patched `resolve_floor_for_step`, no one-tick EPS. Analogous grounding
decision: `crates/holtburger-dat/src/transition/objectinfo.rs:137-141` (the
`v17 > EPSILON → return 1, no contact` hover gate). This partly answers handoff
item 3: the faithful path is **not** independently immune; a live 2026-07-21
slide could equally have resolved by gravity reeling the mover below the plane
within a few ticks.

### Minimal patch spec (mirror the EPS, gate on `input.gates.settle_land`)

Do **not** edit `objectinfo.rs` / `validate_walkable`: it is decomp-faithful and
shared by the indoor BSP narrow-phase, so an EPS there is both a decomp deviation
and an unwanted indoor behavior change. Mirror the fallback's approach at the
**marshalling level** in `faithful_find_transitional_position`, immediately after
the final `grounded` is settled (after the edge-hold rebind at
`faithful_bridge.rs:1363-1372`, before `TransitionOutcome` is built at
`faithful_bridge.rs:1416`). `pose` is already `mut` and finalized by then.

Proposed insert (names to match the fallback at `transition.rs:971-1016`):
```rust
// Settle-land EPS hover-snap (gates.settle_land / USE_SETTLE_LAND) — the
// faithful twin of resolve_floor_for_step's touchdown-ceiling widening
// (transition.rs:986-1016). The decomp terrain gate (validate_walkable,
// objectinfo.rs:139) records contact only when the sphere BOTTOM reaches the
// plane; a non-rising airborne mover hovering within LAND_SETTLE_EPS above
// walkable terrain thus stays grounded==false and slides on frozen airborne
// velocity until gravity closes the cm gap. Snap to the plane + ground THIS tick.
let (grounded, pose) = if input.gates.settle_land
    && !grounded
    && input.airborne          // was airborne (mirrors resolve_floor_for_step's `if *airborne`)
    && input.descending        // non-rising only (vz <= 0)
    && outdoor
{
    match faithful_terrain_height(scene, &pose) {           // NEW sibling of faithful_terrain_normal
        Some(tz)
            if pose.coords.z > tz
                && pose.coords.z <= tz + LAND_SETTLE_EPS
                && faithful_terrain_normal(scene, &pose)
                    .map_or(true, |n| n.z >= physics_globals::LANDING_Z) =>
        {
            let mut p = pose;
            p.coords.z = tz;                                 // snap feet to the plane
            (true, p)
        }
        _ => (grounded, pose),
    }
} else {
    (grounded, pose)
};
```
Notes for the implementer:
- `LAND_SETTLE_EPS` (= 0.08) and `physics_globals::LANDING_Z` are already in this
  crate (`physics.rs:497`, `collision.rs:86`); the fallback uses the identical
  `landing_allows_touchdown(normal.z, LANDING_Z)` walkable gate — reuse it for
  exact parity if preferred.
- `faithful_terrain_height(scene, &pose) -> Option<f32>` does not exist yet;
  add it as a one-line sibling of `faithful_terrain_normal`
  (`faithful_bridge.rs:943-957`): same `terrain_cell_heights` +
  `cell_terrain_polys` + `find_terrain_poly` lookup, but evaluate the found
  poly's plane at (x,y): `z = -(n.x*x + n.y*y + d) / n.z` (landblock-local),
  so the sampled height agrees with the collision triangles rather than the
  separate WorldState heightfield sampler. Do **not** substitute
  `env.terrain_height_at` here — that reads `WorldState.terrain_heights`, a
  different store (see Q2).
- Gate strictly on `input.gates.settle_land`; with the gate off this is a no-op
  and the faithful path is byte-identical to today, exactly like the fallback's
  `settle_ceiling == z` off-path.
- `input.descending` already carries the `vz <= 0` non-rising test
  (`transition.rs:283-284`), so ascent/jump is untouched.

---

## Q2 test-infra plan — recommendation (a): add a SEPARATE opt-in helper

### The gap, confirmed

- `WorldState::populate_terrain_heights` (`crates/holtburger-world/src/state/types.rs:507`)
  writes only `WorldState.terrain_heights`
  (`self.terrain_heights.insert(landblock_id, heights)`, types.rs:519).
- The residency check `SpatialScene::terrain_landblock_resident`
  (`scene.rs:1666-1668`) reads `SpatialScene.terrain_heights`
  (`self.terrain_heights.contains_key(cell_id & 0xFFFF_0000)`), a **different
  store** (`scene.rs:623`), populated by `SpatialScene::populate_terrain_heights`
  (`scene.rs:1650-1652`, note the `& 0xFFFF_0000` mask). `terrain_cell_heights`
  (`scene.rs:1673-1675`) — which `SceneWorld` reads to build the collision
  triangles — also reads the scene store.
- Every terrain-seeding fixture in
  `crates/holtburger-core/src/client/movement/system/tests.rs` (e.g. lines 2141,
  3154, 3234, 3394-3464, 3910, 3984, 7389) calls only
  `world.populate_terrain_heights(...)`, so `terrain_landblock_resident` reads
  false and `faithful_find_transitional_position` falls back to
  `find_transitional_position` → `resolve_floor_for_step`. None reach the
  faithful driver.

### The mechanism to close it already exists

`SpatialScene::populate_terrain_heights` is public and already writes the
residency store. Precedent: the existing entity-collision parity fixture
`run_slice` at `tests.rs:8829-8837` seeds **both** stores explicitly:
```rust
world.populate_terrain_heights(LB_KEY, [FLAT_Z; 81]);        // WorldState floor sampler
world.scene.populate_terrain_heights(LB_KEY, [FLAT_Z; 81]);  // scene residency + triangles
```
That dual-seed is exactly what routes a fixture through the faithful outdoor
driver. (`LB_KEY` is the landblock-high key; the scene method masks it, the
WorldState method stores it verbatim — pass the same high key to both.)

### Recommendation: (a) separate opt-in helper — do NOT modify the existing one

Modifying `WorldState::populate_terrain_heights` to *also* seed the scene store
would silently REROUTE every existing outdoor fixture (2141, 3154, 3234, 3910,
3984, 7389, and the current settle-land tests) from the `resolve_floor_for_step`
fallback to the faithful driver, changing their asserted behavior en masse — and
the canary `settle_land_eps_gate_is_unreachable_under_default_routing` plus the
re-pinned `settle_land_hover_*` tests are explicitly written against the fallback
path's numbers. That is a large, opaque blast radius for a test-only convenience.
The codebase already favors the explicit dual-seed (tests.rs:8837), so add a
named helper that makes the intent obvious and opt-in:

Add to `WorldState` (`crates/holtburger-world/src/state/types.rs`, beside
`populate_terrain_heights`):
```rust
/// Seed terrain heights on BOTH the WorldState floor sampler AND the
/// SpatialScene residency store, so an outdoor manual-drive fixture routes
/// through `faithful_find_transitional_position` (the live-gameplay path)
/// instead of the `resolve_floor_for_step` fallback. Opt-in: existing
/// fixtures that call `populate_terrain_heights` keep the fallback path and
/// their pinned numbers. `landblock_id` is the landblock-high key
/// (e.g. 0xA9B4_0000); the scene store masks it internally.
pub fn populate_terrain_heights_scene_resident(&mut self, landblock_id: u32, heights: [f32; 81]) {
    self.populate_terrain_heights(landblock_id, heights);
    self.scene.populate_terrain_heights(landblock_id, heights);
}
```
New faithful-path settle-land tests then call
`world.populate_terrain_heights_scene_resident(LB_KEY, [terrain_z; 81])` in place
of `world.populate_terrain_heights(...)`; nothing else in the fixture changes.
With `USE_FAITHFUL_OUTDOOR` const-true and the landblock now scene-resident,
`faithful_find_transitional_position` takes the terrain-driver branch
(`faithful_bridge.rs:979`) and the Q1 patch becomes exercisable.

### ⚠ WARNING to flag prominently

**Do NOT change `WorldState::populate_terrain_heights` to seed the scene store.**
Doing so reroutes ~7+ existing outdoor fixtures (incl. the re-pinned
`settle_land_hover_*` tests, tests.rs §3305+) from the fallback path to the
faithful path, silently changing their behavior and defeating the
`settle_land_eps_gate_is_unreachable_under_default_routing` canary's intent. Use
the separate `populate_terrain_heights_scene_resident` opt-in helper (a) instead.

### Second guard the new faithful-path test needs

Seeding the scene store makes the landblock resident (routes to the faithful
driver) AND gives `SceneWorld` the collision triangles (`terrain_cell_heights`,
scene.rs:1673). No further wiring is needed for flat NotWater terrain. Water
depth/type default to NotWater (`scene.rs` corner data absent) which is correct
for the hover-latch repro.

---

## Evidence (file:line — every line read and verified)

Q1 (faithful path):
- `crates/holtburger-world/src/spatial/faithful_bridge.rs:969-981` — outdoor
  routing guard (`faithful_outdoor && terrain_landblock_resident`, else fallback).
- `faithful_bridge.rs:1077` — `grounded_entry = !input.airborne || input.force_grounded`.
- `faithful_bridge.rs:1211-1228` — retail_ground entry stamping: grounded ⇒
  CONTACT|ON_WALKABLE; airborne+no-live-contact ⇒ `state &= !CONTACT`.
- `faithful_bridge.rs:1338-1347` — `grounded` derivation from settled contact
  plane / walkable poly.
- `faithful_bridge.rs:1363-1372` — edge-hold rebind (needs `entry_walkable_contact`).
- `faithful_bridge.rs:1416-1426` — `TransitionOutcome` construction (patch site is
  just above this).
- `faithful_bridge.rs:217-265` — `find_terrain_collisions` → `validate_walkable`.
- `faithful_bridge.rs:943-957` — `faithful_terrain_normal` (helper to clone for
  `faithful_terrain_height`).
- `crates/holtburger-dat/src/transition/objectinfo.rs:137-141` — **the hover gate:
  `v17 > EPSILON → return 1, no contact`** (analogous touchdown decision).
- `objectinfo.rs:143-153` — exactly-resting branch records contact.
- `objectinfo.rs:155-188` — penetrating branch: `step_down || !ON_WALKABLE || valid`
  records contact + pushes sphere up onto the plane (the gravity-reels-it-in ground).
- `crates/holtburger-dat/src/transition/driver_spine.rs:287-306` — step-down gate:
  `state & CONTACT == 0 → return 1` (no snap for CONTACT-stripped airborne mover).
- `driver_spine.rs:307-360` — walkable-aware step-down (only reached when CONTACT set).
- `driver_spine.rs:389-443` — `step_down` body (snaps grounded mover to plane).
- `crates/holtburger-dat/src/transition/driver_validate.rs:203-213` — CONTACT/
  ON_WALKABLE recomputed from the settled contact plane.
- `driver_validate.rs:359-523` — swept `find_transitional_position` (no explicit
  step_down in the transition branch; step_down lives in placement / the
  transitional_insert gate).

Q1 patch parity (fallback EPS to mirror):
- `crates/holtburger-world/src/spatial/transition.rs:951-1016` — `resolve_floor_for_step`,
  the `settle_ceiling = z + LAND_SETTLE_EPS` widening (transition.rs:986-1016),
  gated on `gates.settle_land` + `descending`.
- `crates/holtburger-world/src/spatial/transition.rs:149` — `TransitionGates.settle_land`.
- `crates/holtburger-world/src/spatial/transition.rs:283-284` — `TransitionInput.descending`
  (= vz ≤ 0 at entry); `:281` `airborne`.
- `crates/holtburger-world/src/spatial/physics.rs:497` — `LAND_SETTLE_EPS = 0.08`.
- `crates/holtburger-world/src/spatial/collision.rs:86` — `LANDING_Z = 0.0871557`.

Q2 (test-infra):
- `crates/holtburger-world/src/state/types.rs:507-520` — `WorldState::populate_terrain_heights`
  writes only `WorldState.terrain_heights` (verbatim key, no mask).
- `crates/holtburger-world/src/spatial/scene.rs:623` — `SpatialScene.terrain_heights` field.
- `scene.rs:1650-1652` — `SpatialScene::populate_terrain_heights` (masks `& 0xFFFF_0000`).
- `scene.rs:1666-1668` — `terrain_landblock_resident` reads the scene store.
- `scene.rs:1673-1675` — `terrain_cell_heights` (collision-triangle source) reads scene store.
- `crates/holtburger-core/src/client/movement/system/tests.rs:8829-8837` —
  existing dual-seed precedent (`world.populate_terrain_heights` +
  `world.scene.populate_terrain_heights`) that reaches the faithful outdoor driver.
- `tests.rs:2141, 3154, 3234, 3464, 3910, 3984, 7389` — existing single-store
  seeds (WorldState only) that fall back to `resolve_floor_for_step`.
- `tests.rs:3305-3430` — the FINDING doc comment + canary this audit extends.
