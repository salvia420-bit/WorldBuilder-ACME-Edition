# Holtburger-Web — Tracked Follow-Ons

Useful work that's scoped but not yet shipped. Each entry is sized so
a future agent (or human) can pick it up cold and finish in a focused
session.

Last updated: 2026-05-23 (PR-RR ships interim door cell-mesh fix; this
doc captures the proper fix + other live debt).

---

## Indoor door per-poly toggle (proper fix for cell-mesh collision)

**Status:** PR-RR ships an interim — `SpatialScene.open_door_exclusion_aabbs`
+ centroid-in-AABB skip in `clamp_delta_against_cell_walls_with_exclusions`.
Works for most retail indoor doors today but doesn't scale to multi-panel
gates / portcullis / very-tall doors where the AABB encloses adjacent
non-door wall geometry.

**Proper fix:** at cell-mesh bake time, tag each triangle with the
door entity (if any) it belongs to. At sweep time look up the door's
ETHEREAL bit on each triangle — O(1) per triangle, generalises to any
shape.

**Where the work lives:**

1. `apps/holtburger-web/src/lib.rs` around line 9223 — the EnvCell
   physics-polys fan-triangulation push site. Each `world_verts[0..]`
   triangle currently lands in `CELL_PHYSICS_PENDING` as
   `(cell_id, Triangle)`. Need to:
   - Identify which `Door`-flagged static_object (if any) spatially
     encloses each triangle's centroid. The cell's `static_objects`
     list is being iterated nearby (lib.rs:9242) for placement —
     extend that loop to build a `Vec<(Aabb, doorGuid)>` of door
     boxes, then query each triangle against it.
   - Extend the pending tuple to `(cell_id, doorGuidOpt, Triangle)`.
2. `crates/holtburger-world/src/spatial/scene.rs`:
   - Storage: `cell_physics_index: HashMap<u32 cell_id,
     Vec<TaggedCellTriangle>>` where `TaggedCellTriangle { tri,
     door_guid: Option<u32> }`.
   - `insert_cell_triangle` → `insert_cell_part_triangle(cell_id,
     door_guid, tri)`.
3. `crates/holtburger-world/src/spatial/physics.rs`:
   - Replace centroid-in-AABB filter with a `door_open_set:
     &HashSet<u32>` lookup per triangle. Caller builds the set from
     `entity.physics_state.contains(ETHEREAL)` over all DOOR-flagged
     entities.
4. Drop `open_door_exclusion_aabbs` from `SpatialScene` (replaced by
   the inline tag).

**Why deferred:** straightforward refactor but touches the bake path
+ storage shape + two callers (movement system + tests). Maybe 4-6
hour focused session.

---

## Cell-AABB containment vs. doorway crossing

**Symptom:** even with PR-RR cell-mesh exclusion + open-door entity
ETHEREAL filter + building-AABB toggle, the player still gets
clamped at indoor doorways. Movement collapses to ~0.6 m/s near a
door.

**Suspected cause:** the cell-AABB safety net at
`crates/holtburger-core/src/client/movement/system.rs:697`
(`clamp_delta_to_cell_interior`) re-clamps the residual delta into
the player's current cell's bounding box. The doorway is at the
cell wall — crossing it means transitioning to the adjacent cell,
which requires `current_cell(&pose)` to flip mid-step. The safety
net doesn't reach into the next cell, so the player's lateral
delta gets cropped at the cell boundary regardless of door state.

**Where the work lives:**
- `crates/holtburger-world/src/spatial/physics.rs` →
  `clamp_delta_to_cell_interior` — only clamps against ONE cell's
  AABB. Needs a multi-cell variant that consults the portal graph
  for adjacent cells the residual could legally enter (similar to
  `clamp_delta_against_buildings`'s neighbour-AABB scan in
  `scene.rs:323`).
- `crates/holtburger-core/src/client/movement/system.rs:697` —
  call site. Pass the portal-adjacent cells along with the current
  cell.
- Alternative: skip the safety net entirely when the player is
  near (within 2m of) an open door's AABB, trusting per-poly walls
  + open-door exclusion to handle the geometry. Cheaper to ship but
  may regress L-shaped corridor edge case `clamp_delta_to_cell_interior`
  was added to handle.

**Why this is the actual indoor-door blocker (post-PR-RR):**
verified 2026-05-23 — open-door cell-mesh exclusion AABB registers
correctly (log "open-door exclusion count now 1"), ETHEREAL gate
filters door entity cylinder, but player still moves ~0.6m/s through
open door. Process of elimination points to the cell-AABB safety
net.

---

## Movement integrator wall-slide tuning

**Symptom:** player walking diagonally near a wall gets clamped to
~0.37 m/s instead of expected ~4.5 m/s (run rate). Forward-only
motion through a doorway has the same issue — observable via
`scene3d/picking.js` and confirmed against ACE 2026-05-23.

**Suspected cause:** `clamp_delta_against_cell_walls` zeroes the
into-normal component and keeps the tangential slide, but if multiple
near-parallel walls each take a small bite, the residual lateral
length collapses each iteration. The first hit's "remaining" gets
re-clamped against the next wall etc.

**Where to look:**
- `crates/holtburger-world/src/spatial/physics.rs` —
  `clamp_delta_against_cell_walls` is single-pass. May need a
  multi-pass slide where we re-sweep the residual against the same
  triangle list (with a hit-cache to avoid re-hitting the same wall).
- `holtburger-core/src/client/movement/system.rs` — the integrator
  caller. Check if the AABB-containment safety net (around line
  697) is over-clamping after the per-poly pass.

**Validation:** existing tests at `spatial/tests.rs:1043+`
(`clamp_delta_against_cell_walls_stops_at_wall_and_slides`) cover the
single-wall case. Need a multi-wall test (V-shaped corner, parallel
walls 1m apart) to drive the fix.

---

## Cell-mesh per-triangle author identity (broader version of door fix)

Today every EnvCell triangle is anonymous. Doors are the most painful
case but lots of other ETHEREAL-flagged or destructible-flagged
content has the same shape: a wall poly that should disappear under
some runtime condition.

If we ship the per-poly door-tag refactor above, generalising to
"every triangle has an optional `(entity_guid, condition)` reference"
is the natural next step. Categories worth supporting:
- Doors (ETHEREAL toggle)
- Destructible chests / walls (despawn / state-bit)
- Lifestones (ETHEREAL on attune / collapse animation)

Cost: incremental — the storage shape and bake-side identification
already need the door work; extending the predicate is a flag on the
triangle.

---

## api.js coverage-table remaining rows

`apps/holtburger-web/plugins/api.js:17-32` tracks the
Chorizite-equivalent client event surface. PR-HH closed row 3
(containerOpened). Remaining:

| Row | Event | Status | Notes |
|-----|-------|--------|-------|
| 1 | `objectCreated` | PARTIAL | spawn/position channel only; no `objectCreated` bus event |
| 2 | `objectReleased` | PARTIAL | no bus event |
| 4 | `containerClosed` | MISSING | StopViewingObjectContents not surfaced |
| 5 | `selectionChanged` | MISSING | picking.js owns local state; target-bar polls @ 4Hz today (target-bar.js:404) |
| 6 | `stateChanged` (unified) | PARTIAL | spread across kinds {1,4,5,6,7} |
| 8 | `worldInfo` | MISSING | Login_WorldInfo parsed but not surfaced |
| 9 | `vitaeChanged` w/ old/new | PARTIAL | coalesced into kind=8 |
| 11 | `enchantmentChanged` | IMPLEMENTED (PR-JJ) | via `playerStatsUpdated` re-pull |

Pick any row, add the wasm-side ClientEvent kind + event-bus emit in
`index.html` (mirror the kind=21 containerOpened arm at line 7597 from
PR-HH).

---

## bar.js popover chrome restyle

`ui/bar.js:132-208` defines `.hb-panel` + `.hb-settings` with
glass-morphism (`rgba(28, 28, 32, 0.94)` + `backdrop-filter: blur(6px)`
+ sans-serif). Off-brand vs. the established retail palette
(`--hb-*` tokens). Affects every bar popover including the gear-icon
settings + RynthSuite stub + the new Fullscreen slot (PR-MM).

Replace with `--hb-bg-stone-*` background + brass border + serif font.
Pure CSS, ~30 min. PR-II already moved the canonical Options surface
into main-panel; bar.js popover is the early-game fallback that's
left behind.

---

## Wave 2 layout ports remaining

Per `project_holtburger_dat_ui_extraction_2026-05-22.md`, ~90 layouts
in `0x21xxxxxx` are unmapped. Ones likely worth porting next:

- `gmFloatySideVitalsUI` (0x21000075) — side-anchored vitals variant.
  Today vitals-hud is top-center; retail also has a side stack.
- Magic Panel — separate from Spellbook (PR-Z); the cast/component side.
- Standalone Skills "skill train" UI — Character tab covers most but
  not the train-spec flow.
- A dedicated retail `OptionsPanel` port (8-tab gmConfigUI layout
  0x21000029 — child layouts at `0x21000293`-ish). PR-II shipped the
  shell + Graphics tab; the other 7 tabs are stubbed.

---

## bar.js fullscreen popover — auto-close

PR-MM Fullscreen slot opens a popover with "Enter Fullscreen" button.
After entering, the popover stays open. Should auto-close on
fullscreenchange success (cleaner UX — fullscreen is a one-shot
toggle).

`apps/holtburger-web/index.html` Fullscreen slot `activate` callback —
listen for `fullscreenchange` and call the bar's `closePanel()`.

---

## Per-character inventory / spellbook reset on character switch

When the user switches characters within a session, our inventory +
spellbook caches don't always reset cleanly. Visible after `@switch`
or character-select round-trip in dev/test. Low priority — most users
re-login.

`apps/holtburger-web/src/lib.rs` recv loop `EnteredWorld` arm — wire a
cache reset for `latest_inventory`, `latest_known_spells`,
`latest_enchantments`, `latest_vendor_state`, `latest_container_contents`,
`__doorStates` (JS).

---

## Pre-existing infrastructure notes

These aren't follow-ons per se but worth knowing about when picking up
related work:

- **Position packets unrouted:** `should_route_message_to_world`
  (`lib.rs:12677`) excludes `AutonomousPosition`, `PublicUpdatePosition`,
  `PrivateUpdatePosition`. Investigated 2026-05-23 (PR-QQ ghost) —
  the wasm side IS getting authoritative position via the recv loop's
  dedicated arms (`lib.rs:16639` Private, `16772` Public) so player
  pose stays correct. AutonomousPosition isn't received from server
  for local-player moves (ACE trusts client prediction); only other
  entities trigger it via the world routing path (which gets dispatched
  inside `handle_message` separately).

- **JS-side `landblockId` vs `landblock_id`:** wasm-bindgen exposes
  `LocalPlayerPose.landblockId` (camelCase) per `js_name = landblockId`
  at `lib.rs:13308`. JS callers reading `.landblock_id` get
  `undefined` → `0` after `>>>` coercion. Easy footgun — fixed
  audited 2026-05-23.

- **Wasm rebuild cadence:** `wasm-pack build --target web --out-dir
  pkg --release` from `apps/holtburger-web` — ~2m10s on the laptop.
  Bump `pkg/holtburger_web.js?v=` in `index.html:934` after each
  rebuild to bust the browser module cache.

---

## How to add to this list

Drop a section header + 3-5 paragraphs of scoping detail. Keep the
"Where the work lives" pointer load-bearing — that's what saves the
next person 20 minutes of grepping. Cite memory files as
`[[memory-name]]` so future Claude sessions can pull them in.
