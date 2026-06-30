# Investigative handoff — movement "stall → big pull-back" bug

**Filed 2026-06-19. Status: UNINVESTIGATED — symptom + hypotheses + repro/measure plan only.**

## Symptom (user, verbatim)
> Another movement-related bug, seemingly related to the unified pipeline. It seems like
> the thread overflows and the game can't keep up with what's going on, so the **rain stops
> until it can catch up**. But since **movement is occurring during this time, the player
> gets pulled way back**.

So: a main-thread stall (rendering freezes — the rain is the visible tell) during which the
player keeps moving; on catch-up the player snaps **way back** (a large one-off position
correction, not the per-cycle wobble).

## What this is NOT (don't conflate)
- NOT the locomotion **root-motion model-lead** snapback — that was the rendered model
  striding ~3m ahead of the rig root and snapping every ~0.8s run cycle, fixed
  `172af2ff` (skeleton root-motion stripped → in-place; see
  `[[project_snapback_real_cause_rootmotion_2026-06-19]]`). That is render-only, per-cycle,
  and uncorrelated with frame hitches.
- NOT the routine server-reconcile (the rig follows prediction with 0 frames pulled to
  server in steady state — measured via `__diag.physics`). THIS bug is the **occasional >5m
  hard snap** that `[[project_local_player_snapback_2026-06-13]]` noted ("occasional >5m hard
  snaps"), now attributed to STALLS.

## Mechanism hypothesis
1. **Trigger — main-thread stall.** A long synchronous task blocks rAF (rain + all rendering
   freeze). Prime suspects: terrain bake (~33 MiB sync terrain-atlas + un-budgeted boot/stream
   terrain bakes — `[[project_holtburger_stutter_diag_2026-06-01]]`), statics/buildings bake on
   a landblock hop, atmosphere warm-up, or a unified-pipeline queue draining in a burst.
2. **During the stall, movement continues** — real input and/or the server's ~20 Hz
   PublicUpdatePosition broadcasts queue up; the wasm integrator advances on the next (huge) dt.
3. **Catch-up yanks the player back**, via one of:
   - (a) the integrator gets a single huge `dt` (the whole stall) → over- or under-advances vs
     the server, then a correction;
   - (b) queued server position broadcasts drain in a burst and reconcile the body to a stale
     authoritative pose → a big backward snap (`drift > 5 m` → camera.js hard-snap, not lerp);
   - (c) a unified-pipeline queue (position-manager / motion dispatch / entity backlog) overflows
     and replays/snaps on drain.

## Suspect code
- **Stall sources:** `scene3d/terrain.js`, `scene3d/world_stream.js`, `scene3d/landblock_lru.js`
  stream bake; `scene3d/buildings.js` / `statics.js` bakes; atmosphere. Find the blocking long task.
- **dt / timestep under a large frame gap:** integrator dt clamp / sub-stepping
  (`USE_QUANTUM_SUBDIVIDED_INTEGRATION`, holtburger-core movement `system.rs`) — does a huge dt
  over-advance, or does catch-up replay accumulated input?
- **Reconcile snap on catch-up:** `scene3d/camera.js` (~:852) reconcile-vs-snap 5 m cutoff =
  the visible "pulled way back". `__diag.physics` `hitchCount` counts these.
- **Unified-pipeline queues:** `?USE_POSITION_MANAGER_QUEUE`, the wasm recv/message drain, the
  motion dispatch queue, `__scene3dEntityBacklog` (512-cap ring). A stall → backlog → burst drain.

## Reproduce (1070, attached)
- Re-establish `-L 9333` tunnel; attach CDP to `127.0.0.1:9333` (the Holtburg-Chrome shortcut
  launches with `--remote-debugging-port=9333`). Method in
  `[[project_snapback_real_cause_rootmotion_2026-06-19]]`.
- Move continuously WHILE triggering a stall: `@telepoi`, cross a landblock boundary (terrain/
  statics bake), or run into an unbaked area. Watch: rain freezes, then the player jumps back.

## Measure
- `__diag.physics.summary()` → `hitchCount` (>5 m snaps) + `drift.max`; dump `.samples` around the
  stall to capture the big pull-back (`predicted` / `applied` / `server` arrays).
- CDP performance trace (`performance_start_trace` / `_stop_trace`) → the blocking **long task**
  (stall source + duration). Correlate the rAF dt spike (rain-freeze window) with the pull-back
  magnitude.
- Sample `getLocalPlayerPose()` (integrator) + `cameraSwitcher.predictedPlayerPos` + the server
  pose across the stall: does the body over-advance on the huge dt then snap to a stale server
  pose, or burst-drain backward?

## Likely fix directions (to validate, not yet attempted)
- **Cap the integrator catch-up dt** (don't advance a full stall in one frame — sub-step or clamp).
- **Suppress the reconcile snap right after a long frame gap** (let prediction smoothly re-converge
  instead of hard-yanking to a stale server pose).
- **Remove the stall** (terrain/statics bake fully off-thread + frame-budgeted — the stutter-diag
  memory's Web-Worker-atlas + budget fix) → render never freezes, no catch-up.
- **Bound the unified-pipeline queues** so a stall can't burst-replay.

## Related
- This session: `172af2ff` locomotion in-place; `67c98271` local-player autonomous-echo guard
  (`USE_LOCAL_PLAYER_AUTONOMOUS_GUARD`, the OTHER reconcile path); `724d9557` texture wrap.
- Memories: `[[project_snapback_real_cause_rootmotion_2026-06-19]]`,
  `[[project_local_player_snapback_2026-06-13]]`, `[[project_holtburger_stutter_diag_2026-06-01]]`,
  `[[project_eyetest_session_2026-06-11]]` (unified movement pipeline / `USE_INTERPRETED_VELOCITY`),
  `[[reference_1070_login_perf_probe_chromium]]` (main-thread stall during bakes; ~90 s cold-load).
