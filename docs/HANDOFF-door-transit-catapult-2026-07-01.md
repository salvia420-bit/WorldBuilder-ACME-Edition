# Holtburger-web — building/door transit catapult handoff (2026-07-01)

**Purpose:** onboard an agent to root-cause and fix the building walk-out catapult in
**holtburger-web**. Read this, then `docs/HANDOFF-holtburger-bugfix-general-2026-06-29.md`
(build discipline, live-vs-faithful paths) and the rapidgrep index in
`~/.claude/.../memory/MEMORY.md`. Decomp `~/ac-headers/acclient.c` is the behavioral
authority (we build a CLIENT); ACE `~/ace-server` is reference-only for what the server
expects — never edit it.

---

## 0. The bug cluster (all captured live on the 1070, 2026-07-01)

One walk out a Holtburg building door produced FOUR distinct defects:

1. **Doorway catapult (ROOT CAUSE OPEN).** Walking through a building doorway ejects the
   mover sideways at ~30-130 m/s. Captured timeline (user session, 200 ms samples):
   walking inside cell `a9b4016a` at x=81.4 y=34.9 z=94 → next sample x=97.7 y=15.0
   (**+16 m / −20 m in 200 ms**), then a smooth ballistic at ~26 m/s until below the world.
   An earlier capture at a different building (cell `a9b40104`, door ~x=81 y=131) ejected
   WEST with local x going NEGATIVE (out of the 0-192 landblock range). The mover passes
   through CLOSED doors and walls during the ejection (tunneling — 6 m/slice >> substep).

2. **Stale cell during the fall (same capture).** The pose keeps its indoor env-cell id
   (`a9b4016a` / `a9b40100`) for the entire flight, even 100+ m outside and below the
   building. Because `pose.is_indoors()` stays true, the outdoor terrain landing arm in
   `advance_local_pose_for_manual_drive_slice` never engages → the fall never ends.
   MITIGATED (not fixed) by the fell-through failsafe (§2).

3. **Client fights server teleports (OPEN).** `@teleloc` executed server-side but the
   client kept sending stale AutonomousPosition heartbeats from the pre-teleport pose;
   ACE logged `MOVEMENT SPEED: … trying to move from A9B4001E [90 130 -149.995] to
   C6A90009 […], speed: 5963` — i.e. the client dragged itself back. User-visible as
   "@telepoi brings me to the same spot". Repro: `scratchpad drop-test2.mjs` pattern —
   `@teleloc 0xa9b40019 90 130 -150` from a grounded state, pose never adopts. NOTE:
   an earlier `@telepoi Holtburg` in the same build DID adopt — the break may depend on
   prior integrator state (post-fall wedge?) or teleport kind. Suspect area:
   `PlayerTeleport`/`UpdatePosition` handling vs `local_player_runtime_pose` re-seed
   (`crates/holtburger-world/src/handlers/player.rs` UpdatePosition arm,
   `suspend_runtime_bodies` / resume).

4. **Door open/close state INVERTED + flapping (OPEN).** Doors/chests render open when
   closed and vice versa (per the user); the 2026-06-29 bandaid (hold-final-frame,
   `isDoorStateMotion` in `scene3d/entities.js:592` — On/Off cycles forced LoopOnce)
   stopped the perpetual open↔close flap for doors/chests but "other stuff is still
   doing it" and the inversion remains. PHYSICS ANGLE: a door is a weenie with a
   non-ethereal physobj (see §3); if the client's solid/ethereal state follows the
   inverted visual state, an apparently-open door is a SOLID collider in the doorway —
   plausibly the very thing the catapult push-out resolves against.

Also observed: `getLocalPlayerPose()` freezes at stale coordinates during long falls
(the JS getter froze while terrain streamed around the ACTUAL falling position); and a
login-time fall variant — spawning inside a building before its env-cell physics
streamed in dropped the player straight through the floor (z accelerated beyond gravity,
suggesting repeated failed floor-seat, not just g).

## 1. Ruled OUT via URL-flag bisect (catapult reproduced with each off)

- `?roofGrounding=off` (09c98115 roof grounding)
- `?stepUp=off` (Phase E1 walkable step-up)
- `?faithfulOutdoor=off` (Phase D outdoor faithful driver)

NOT ruled out (no URL escape — need an A/B wasm with the const flipped):
- `USE_FAITHFUL_TRANSITION = true` (system.rs:578, indoor BSP driver, 2026-06-28) —
  `parse_faithful_transition_flag` only supports `=on`, there is NO off-carrier.
- `USE_UNIFIED_TRANSITION = true` (system.rs:552) — same shape.
- Commit `e715973b` "stage per-part physics BSP for outdoor buildings (0x01 + 0x02),
  default-on" — per-part door/building BSP staging.
- Commit `04664d17` "read runtime pose for cell visibility" (visibility-only, less likely).

KEY STRUCTURAL SUSPECT: the legacy clamp chain carries doorway-specific relaxations —
PR-RR.1 door-entity ETHEREAL filter + cell-AABB containment bypass near open doors
(system.rs:3198-3215), B11 building-exit-room AABB bypass (system.rs:3213+) — which the
unified/faithful substep pipeline may NOT replicate. The catapult window (post-06-28)
matches the faithful-transition default-on flip exactly.

## 2. What SHIPPED today (commits on master)

- `d41d66f1` — missile-combat silent-failure chain: out-of-ammo pre-check
  (`WorldContextExt::is_missing_missile_ammo`), retail auto-unequip-before-wield,
  `InventoryServerSaveFailed` (0x00A0) recv arm + toasts, transient-string toasts,
  **Warn-level wasm console logger** (`[rust-WARN] …` lines — use `log::warn!` for
  instrumentation, it reaches the browser console now).
- `0287828f` — **fell-through-world failsafe**: `PlayerState::airborne_secs` +
  system.rs airborne arm — after 6 s continuous freefall AND z < terrain−50 at global
  XY, clear the stale indoor cell to the outdoor bucket, `rebucket_outdoor_landblock()`,
  snap z to terrain, `land()`. VERIFIED LIVE (user snapped back to terrain ~6 s after a
  catapult and resumed playing). Console fingerprint: `[fell-through-failsafe] …`.
  Also: unknown `/cmd` in chat now routes to the server as `@cmd` (index.html
  `routeSlashCommand` final arm) — `/telepoi holtburg` works.

## 3. Discord dev-archive intelligence (full report from the 2026-07-01 mining run)

- **Collision is cell-scoped** (Vanquish420 2026-02-11, gmriggs same day): the engine
  only tests building collision polys registered to the mover's CURRENT 24×24 cell;
  geometry straddling a cell/landblock boundary = walk-through on that side. gmriggs:
  "ace's physics engine is just a straight translation of acclient physics engine";
  edge case he names: an entrance/exit that "would exit immediately into the next
  landblock" is invalid placement.
- **Wrong-side push-out** (trevis 2024-03-15): a sphere resolved against a poly it's on
  the wrong side of gets ejected on the wrong side at speed; his mitigation: "instantly
  teleport back instead of sliding". ← matches the catapult signature.
- **Doors** (Yonneh 2025-03-19): "door == weenie with a physobjdesc, that is NOT
  ethereal." Open door = ethereal flip. Retail `OBJECTINFO` fields (Yonneh 2024-10-31):
  `{object, state, scale, step_up_height, step_down_height, ethereal, step_down,
  targetID}` — the per-move collision context; a doorway is a step transition over a sill.
- **physicsbsp vs cellbsp** (gmriggs 2025-05-09): separate trees; physicsbsp is
  collision; absent physicsbsp ⇒ client "will still function but do slower linear
  search" (paradox 2025-06-14: env-cell BSPs "aren't strictly necessary").
- **No fall recovery in retail** (Lingrad 2025-09-27): a broken portal destination
  teleports you to the connected cell "or crash if there isn't one" — infinite fall is
  the known third failure mode when a transit bug eats the floor.

## 4. Recommended attack plan

1. **Instrument, don't bisect further.** With the new console logger, add temp
   `log::warn!` on ANY per-slice displacement > 1 m at: the entity-collision pass
   (system.rs ~3489+), `resolve_static_bsp_pushout` (~3393), building AABB clamp
   (~3213), and the faithful-bridge dispatch return
   (`faithful_bridge.rs::faithful_find_transitional_position`). The catapult is
   16 m/200 ms — one warn names the guilty pass.
2. **Repro headless at the exact door**: building at Holtburg `A9B4`, interior cell
   `0xa9b4016a`, door ≈ x81.4 y34.5 z94 (mover walking −y gets ejected toward +x/−y);
   second door: cell `0xa9b40104` ≈ x81 y131.5 z66 (ejected −x). Navigation: teleports
   may not adopt (§0.3) — WALK from the outdoor spawn (`a9b40019/a9b4001a` area, z=94)
   using `setMovementInput` + heading calibration (calibrate empirically: try headings,
   keep the one that moves the intended axis; walls interfere — calibrate in the open).
   Account `<test-account>/<test-account>` (Developer). Single-login ~40 s cooldown.
   Harness patterns: `scratchpad/repro-catapult.mjs`, `watch-fall.mjs`,
   `session-hold.mjs`+`poke.mjs` (CDP-held session) from session scratchpad
   `/tmp/claude-1000/-home-wbterminal/3dcb35b7-*/scratchpad/`.
3. **Check the faithful driver's doorway handling** vs the legacy relaxations (PR-RR.1 /
   B11, §1) — does the substep pipeline consult the door entity's ethereal state and
   bypass cell containment at exit portals? Compare `CTransition` doorway/portal transit
   in the decomp (`find_transitional_position` acclient.c:313171, `find_cell_list`
   per-step :313300) — the transit should CHANGE THE CELL per step; ours keeps the
   stale env-cell (§0.2).
4. **Clamp push-out magnitude** as defense-in-depth: retail never ejects more than
   ~radius per step; consider trevis's "teleport back instead of slide" on wrong-side
   resolution.
5. Then the siblings: teleport adoption (§0.3), door state inversion + residual
   flapping (§0.4), `getLocalPlayerPose` freeze during falls.

## 5. Live-test setup used today (still standing)

serve.py :8765 + wsbridge :8080 + vanilla ACE (all on this laptop; see the 06-29
handoff §4). 1070 vistest: desktop shortcut "Holtburg (Chrome)" → Chrome CDP :9333,
URL 127.0.0.1:18765 via reverse tunnel
(`ssh -fN -R 18765:127.0.0.1:8765 <user>@<gpu-box-ip>`), bridge direct via tailnet
`ws://<server-ip>:8080/`, account `<account>` (Developer). Drive it:
`ssh -fN -L 9333:127.0.0.1:9333 <user>@…` + playwright `connectOverCDP` (never
`browser.close()` the user's session — disconnect only). GM rescue for a wedged player:
second account + `@teletome <name>` (bypasses the airborne refusal).
Test char `+Tester` has full weapon kit (bows/xbows/atlatl+ammo, swords, buckler,
Spadone, staff, wand). Fresh drudge target: `@create 7`.
