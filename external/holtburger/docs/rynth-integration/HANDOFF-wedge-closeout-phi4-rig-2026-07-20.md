# HANDOFF — wedge closeout, phi-4 director, rig state (2026-07-20, session 2)

Follow-on to `HANDOFF-object-physics-nav-2026-07-20.md` (same day). That doc's
attack order is now largely CLOSED — read the correction notes added to it
before trusting its framing. This doc records what landed, what the live rig
runs now, and the remaining tasks.

## ⚠ FIRST THING NEXT SESSION: everything is UNCOMMITTED

~21 files of verified work sit in the holtburger working tree (frame fix,
login placement, entity-arm promotion, seam resolvers, contact-plane stamping,
stall recovery, trace facility, 3 new test modules, doc corrections). Suites at
handoff: **world 575/0 · core 601/0/1 · dat 609/0** (all baselines exceeded).
Commit before doing anything else. The deployed `pkg/` wasm == this tree.

## What landed today (all deployed to the live rig)

1. **Task #13 frame audit — CLOSED, INVERTED FU-11.** Indoor server poses are
   LANDBLOCK/DUNGEON-frame, never cell-local (ACE Position.cs:123/191 indoor
   bail; EnvCell.point_in_cell global→local; retail CEnvCell::point_in_cell
   0x0052C300; live DB rows span 200–550 units/dungeon). FU-11's cell-local
   lift was calibrated on hand-typed @teleloc input (verbatim passthrough,
   AdminCommands.cs:951). `faithful_find_placement_position` now uses
   `global_coords()`; env840 tests flipped; live A/B: real arrivals engage
   placement (`adjusted pose by 0.01m … grounded=true`).
2. **Task #12 wedge — CLOSED after full root-cause.** The freeze chain is
   retail-faithful byte-for-byte (verified: insert_into_cell 311632,
   transitional_insert 312866, step_up gate 312794/312961, slide_sphere 358899
   incl. eps 0.00019999999). Mechanism: axis-locked bot input exactly
   perpendicular to a blocking plane → slide edge orthogonal → slide component
   ~0 → BRANCH-A (driver_validate.rs:80-113, acclient.c:312223-312254) reverts
   and reports Ok → 0.000m forever. Retail players escape via input jitter.
   Fixes landed: (a) `current_cell` sphere-radius no-owner gap rescue +
   `current_cell_for_arrival` (skips the topological-neighbour walk that
   mislabeled placement lookups — retail AdjustPosition/find_visible_child_cell
   shape); (b) `last_known_contact_plane_cell_id` stamping (was type-default 0
   → BRANCH-A repin disabled adjust_offset pushout); (c) **MoveTo stall
   recovery** (`stall_recovery.rs`, bot-lane only): 5 ticks <0.02m → ±45° for
   3 ticks, alternating, 4 attempts, then defer to the router watchdog.
   Live-validated: the rail wedge on stream sheared free instantly with a 45°
   input. Deterministic repro venue if it regresses:
   `@teleloc 0x860201B4 15.05 -26.5 0.005`, walk south ~1.1m.
3. **Task #4 entity-collision arm — PROMOTED DEFAULT-ON**
   (`?faithfulEntityCollision=off` escape, faithfulOutdoor-style parser). Bar:
   offline A/B suite + hours of soak + live functional block at the grocer door
   0x7A9B401F (closed 0x10008 stops the mover ~0.95m short with cylinder
   slide; Use → ETHEREAL 0x1000C). ⚠ Academy training doors carry
   IGNORE_COLLISIONS even closed — intentionally passable, never use them as a
   door-collision venue.
4. **Track A furniture recursion — was ALREADY LANDED (2026-06-28,
   46a1e697/ba7ed2a8).** The "deferred" note was a stale premise from a
   route_validate.rs stub. Added native regression tests (cfg widened) + doc
   corrections. Doors are NEVER stabs (9/9 academy + 13-door game sample:
   door host cells have empty stab lists) — toggleable-stab design KILLED.
5. **Login placement** — retail runs find_placement_position on login
   (enter_world → SetPosition flags 0x11; CheckPositionInternal always NULL
   begin_pos → placement insert, acclient.c:145981/:319175). player.rs
   self-ObjectCreate now latches arrival placement. Live-verified at login.
6. **Track D reframe** — the live outdoor path ALREADY collides real physics
   polys; legacy AABB clamps are unreachable behind default-ON
   unified/faithful gates (system.rs:4076-4079). Gate arches pass by polys.
7. **Transition trace facility** (`holtburger-dat/src/transition/trace.rs`) —
   thread-local, zero-cost-off, per-attempt tracing through the whole
   CTransition chain. Used by `academy_wedge_tests.rs` diagnostics.

## Live rig state at handoff

- Stream: chromium CDP :9223, ffmpeg (go_live.sh wrapper) → YouTube. NB the
  broadcast URL ROLLS if the push stalls long (reloads are fine; ffmpeg
  restarts roll it) — check YT Studio for the current URL.
- Bot: **kernel ON** (`botKernel=off` removed live), **`botModel=microsoft/phi-4`**,
  **`botInterval=0.5`** (effective cadence ~78s: model asks max = 2×interval,
  + ~15-20s call time; 70 calls/hr cap ≈ 51s floor). GLM provider pin is
  z-ai/*-only and can't ride the URL; the 1280-token cap applies globally.
  ⚠ These were changed LIVE via location.href — `launch.sh` still bakes the
  OLD flags (GLM, interval 1, kernel off); a relaunch reverts them.
- Phi-4 quirks observed (fresh-journal Rithwic test): confabulates town names
  (persona prompt has none; observe payload doesn't name the town) and passes
  loose `use_object` args ("nearest enterable building"). Cheap fixes: town
  name from DerethMaps coords.json in observe(); persona line "only reference
  place names/objects present in your observation". Movement with the fix
  batch: cross-landblock travel with zero wedges.
- Journal wipe recipe: clear `director.journal.entries`, remove
  localStorage `holtburger_ai_journal_v1`, clear `_lastSummary`.
- vendortest accessLevel is still 4 (granted for @teleloc; revert in ace_auth
  if unwanted). Character last seen exploring Rithwic (0xC98D/0xC88E).

## REMAINING TASKS

### Track D residual gaps (was task #5)
1. **0x02 door-leaf BSP staging is door-blind**: `stage_bsp_02`
   (lib.rs ~14826) stages EVERY part unconditionally — no door-leaf skip
   exists (the flag doc's caveat describes a RISK, not a skip). The coarse
   AABB path already honors door state (`set_door_aabb_active`); thread the
   same binding into `cell_static_physics_bsp`/`building_physics_index`.
   Also fix the `else` branch at lib.rs ~38983 to check `pose.is_indoors()`
   (outdoor spatial-match miss currently no-ops silently).
2. **Cross-landblock straddling buildings** under-registered from the
   unbaked-neighbour side (WS7 bake clamps to home landblock,
   scene.rs ~1510).
3. **Retire/document dead code**: `building_aabb_index` +
   `clamp_delta_against_buildings*` + `USE_STATIC_BSP` pushout are
   unreachable for movement (legacy path only); stale comment
   types.rs:80-81; `open_door_exclusion_aabbs` removal is now UNBLOCKED
   (entity arm promoted).
4. Optional: audit academy poly 1 winding/normal (-0.985,~0,0.172) vs retail
   collision mesh (low priority — port exonerated).

### Track E3 + F: stairs, then the dungeon lap (was task #6)
Venues fully scoped (see stairs-agent report, summarized):
- **Venue 1** (Holtburg building, lb-frame): cells 0xA9B40104 (ground z66) →
  0xA9B4010C (landing z68.95) → 0xA9B40101 (upper z69.5-73.4); real 45°
  riser polys in Environment 0x0D00034F. Start
  `@teleloc 0xA9B40104 79.0 129.0 66.5`, drive toward (83,132,69.5); assert
  cell seq 0x0104→0x010C→0x0101 + z 66.5→~69.5+. All 3 cells share the
  building anchor origin (soak-13 bbox-fix regression case).
- **Venue 2** (apartment z-stack, lb 0x7200, tiers z=0/6/12/18):
  0x72000100 (apt z0) → 0x720002C4 (hub shaft z6, single-leaf 0-6 mesh);
  `@teleloc 0x72000100 40 -40 0.5`. ⚠ HIGH router-pruning risk: edge
  256↔708 has dZ=6 dHoriz=0 → isDropEdge SHAFT_HORIZ_M branch
  (indoor_router.js:91); soak-13 bbox-MIN anchor may still misclassify.
  Instrument this edge FIRST.
- Then the Track F composed bar: explorer enters every Holtburg building
  incl. upper floors, circles furniture, exits, rounds exteriors, dungeon
  lap — zero operator rescues, on stream (stall recovery should carry it).

### Director polish (new, from tonight's phi-4 observations)
- Town-name grounding in observe() + anti-confabulation persona line (above).
- Consider `botInterval=0.25` if faster pacing wanted (70/hr cap floors
  sustained at ~51s regardless).
- Update `launch.sh` baked flags if phi-4/kernel-on should survive relaunch.

## Suites / oracles quickref
- Harnesses: `env840_seam_tests.rs` (grocer, now lb-frame contract),
  `academy_wedge_tests.rs` (wedge venue + trace + off-axis escape experiment).
- Trace: `holtburger_dat::transition::trace` — enable around a sweep, read
  per-attempt adjust_offset/slide internals.
- Full session detail: the task-tool cards from this session and
  `STREAM-RIG-OPS.md` (updated today) for rig ops.
