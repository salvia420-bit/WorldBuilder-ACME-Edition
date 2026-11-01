# Drone carries the player — headless speed experiment (2026-10-31)

**Question (owner, 2026-10-31).** The drone is limited by ACE's first-sight rules, which belong to the player: fly
~150 m out and the doors are missing. Either the drone gets first sight of its own, or it carries the player. Try the
carry idea headless on the laptop (the 1070 is offline): put the player under the drone, fly it high (above the
trees) at 200 / 400 / up to 750 km/h, turn, change height, see what breaks, and estimate the 1070's frame rate from
draw calls. Owner, mid-run: *"750 km/h is very aggressive … you can fly across the entire world in less than 4 mins,
so we are doing this informationally"* — 750 is the stress point; 100–400 km/h is the realistic range.

## Short answer

| Speed | Verdict |
|---|---|
| ≤ 200 km/h | **Works.** ACE accepts the carried, airborne player with no server change; doors / NPCs / creatures stream around the drone and appear ~1–2 s before you reach them; the client keeps the whole terrain ring loaded ~1 km ahead; draw calls are *lower* than walking through town. |
| 300–400 km/h | **The world keeps up; the life doesn't.** Terrain and buildings stay loaded ~0.9–1.2 km ahead, but server objects now pop in 0.25–0.5 s before you pass them (a quarter to a half of them beside or behind you). **ACE can freeze the carried player's position for the rest of the flight** when the drone re-enters ground it flew over 1–5 min earlier (seen at 400 km/h). |
| 750 km/h | **Flies, but everything is late.** The drone and ACE both do 750 (on fresh ground ACE stayed healthy at ~16 % CPU), but the client's terrain lead drops to 100–200 m at times, ~70 % of objects appear after you have passed them, the revisit freeze hit again, and the laptop tab grew to 2.2 GB of JS heap (earlyoom killed it once). Informational, as expected. |

Draw calls are **not** the obstacle: over open country at 100 m AGL the drone view needs ~115–355 draw calls (p90
≤ ~510; real counts 401 at 100 m and 266 at 150 m at the Holtburg edge) — fewer than the 1070's E7 drone eye test at
low altitude (≈ 584 calls, 96 fps at this preset) and well under the Holtburg bench (~650 at this preset; ~1,100 on
the 1070 bench with shadows, 46–57 fps). Speed does not raise draws — it raises **streaming work**
(main-thread long tasks, landblock churn) and hits **server-side limits** (first-sight radius, dormant landblocks,
synchronous landblock loads). Getting "carry" off the ground is quick on the client (~150 lines here); making it robust
at > 200 km/h, and letting other players see the drone, is server work — see *What shipping it would take*.

## What the drone is today

`scene3d/drone/` is a real object in the scene (`props.js` procedural mesh), flown by its own flight model
(`manual_flight.js`; cine 12 m/s, boost 20 m/s), owning the client's one render camera through film mode's camera
owner (`world_link.js` → `film/runtime/camera_owner.js`), with a collision safety reflex and a client-side prewarm
around itself (96 m, ≤ 4 landblocks, ≥ 2 s apart). It is **local-only**: a cycle sends nothing to the server, so ACE
streams objects only around the character (first sight 112.5 m, 2-D, from the 3×3 landblocks around them —
`ObjectMaint.cs` InitialClamp) and nobody else can see the drone. Tether 150 m (cap 180), ceiling 120 m AGL, battery.

## What was built (experiment copy only — nothing changed in the main tree)

Copy `/mnt/wbterminal2/hb-carry/holtburger` (HEAD ebf6c2cf + two patches), served on :8766 by
`HOLTBURGER_DIST=/mnt/wbterminal2/hb-carry/dist-overlay python3 scripts/serve.py --port 8766 --bind 127.0.0.1`
(`dist-overlay` = symlinks to the SSD dist; `../chorizite` symlink needed for the build).

1. **wasm hook** — `../ace-streaming/hb-drag.patch` (2026-10-25), applied unchanged:
   `SessionHandle.debugDragPose(cell, x, y, z)` hard-snaps the local player and sends that pose as one
   `AutonomousPosition`. Release build (7.9 MB) with `CARGO_TARGET_DIR` = the main target dir.
2. **drone carry mode** — `carry-mode-js.patch` (~90 lines: `scene3d/drone/index.js`, `manual_flight.js`,
   `film/drone/flight_model.js`), behind `?droneCarry=on` (+ `droneCarryKmh`, `droneCarryAccel`): the cine craft's
   speed cap becomes the carry speed (default 760 km/h; 25 m/s², 50 m/s³; the flight model's vmax rule raised from
   200 to 400 m/s), tether / ceiling / battery lifted, pilot-moved abort off, and while the drone flies the module sends
   the player's pose 3 m under the drone at 10 Hz (`debugDragPose`), never more than 150 m per send.
   `__drone.carry()` reads / sets it; `status().carry` reports sends / lag. Two `drone_api` key-set pins fail by
   design (new keys in `status()` / `readDroneFlags()`); `drone_flight` / `drone_tether` pass.
3. **No ACE change.** Vanilla ACE accepted every airborne pose (z up to ~150 m above the terrain, contact = 1).

## How it was measured

- Headless Chromium (SwiftShader) on the 8 GB laptop, one at a time inside `capped-build` + the shared heavy-job lock,
  bot account `agentp10` (Developer, `@cloak on`), the 1070 E7 play flags `quality=high&csm=off&renderScale=1&
  adaptiveRes=off`, plus `nullRender=1&hud=none`, 960×540, `--disable-gpu-compositing` (the first try at 1080p with the
  HUD let SwiftShader's compositor throttle rAF to ~5 fps — see Caveats). The runner stops a session below 900 MB
  MemAvailable.
- Each run: `@teleloc` Holtburg (0xA9B40019 84 7.1 94) → settle → `__drone.deploy({quick})` (≈ 3.6 s) → climb (≈ 4 s)
  → fly the legs with **the drone's own flight model**, driven through `debug.setSticks` by a 10 Hz controller (pitch =
  speed ÷ carry cap, yaw to the leg heading, throttle toward the highest *known* terrain 0–300 m ahead + AGL, gimbal
  −25°, FOV 75°) → hover 8 s.
- Per second: drone pose / speed; carry sends and lag; render-terrain coverage of Chebyshev rings 2 / 3 / 5 around the
  drone and the baked-terrain lead along the track; every new server object (first-seen distance, along-track
  position); LRU residency / evictions; a CPU frustum census of the main pass from the drone camera; long tasks; rAF
  gaps; JS heap. Per run: ACE CPU / RSS and every ACE WARN / ERROR line.
- Real draw counts (`carry-census.eval.js`, rendering on, 960×540 = the same frustum as 1080p): the 1070 bench orbit
  (70 m at 22° around Holtburg 0xA9B40001) and the drone hovering at 15 / 50 / 100 / 150 m AGL. The CPU census matched
  `renderer.info` within 0–5 % on the bench views (ratio 0.95–1.00), so the in-flight census is a usable draw count.

## Results

### Flights (laptop, rendering off; "ahead" = share of new objects first seen in front of the drone)

| Run | Cruise km/h | AGL (med) | Terrain rings 2/3/5 loaded | Terrain lead med / min (m) | New objects | Seen ahead | Median warning | Draws med / p90 | Long tasks ms/s (max) | ACE |
|---|---|---|---|---|---|---|---|---|---|---|
| 100, 111° | 100 | 100 | 1 / 1 / 1 | 1,344 / 960 | 214 | 99 % | 2.35 s | 273 / 432 | 189 (207) | 4.9 % CPU, clean |
| 200, 111° | 201 | 103 | 1 / 1 / 1 | 1,248 / 960 | 393 | 95 % | 0.99 s | 146 / 431 | 76 (350) | 8.1 %, one 330 ms world-thread stall |
| 200, out & back | 201 | 105 | 1 / 1 / 1 | 1,152 / 864 | 392 | 78 % | — | 111 / 1,398 | 160 (370) | 8.6 %, clean |
| 300, 111° | 302 | 105 | 1 / 1 / 1 | 1,152 / 864 | 456 | 75 % | 0.24 s | 59 / 220 | 194 (383) | 7.2 %, clean |
| 300, 50 m, 21° | 305 | 60 | 1 / 1 / 1 | 1,056 / 768 | 506 | 35 %¹ | 0.47 s | 104 / 224 | 348 (887) | 7.5 %, clean |
| 300, 150 m, 201° | 304 | 157 | 1 / 1 / 1 | 1,152 / 864 | 643 | 76 % | 0.39 s | 91 / 148 | 96 (566) | 11.5 %, clean |
| 300, square (3 × 90°) | 303 | 104 | 1 / 1 / 1 | 1,152 / 864 | 510 | 71 % | — | 91 / 161 | 245 (487) | 12.1 %, clean |
| 400, 111° (revisits) | 403 | 107 | 1 / 1 / 1 | 1,152 / 864 | 100 | 64 % | 0.28 s | 48 / 139 | 166 (432) | **froze at 23 s** |
| 750, 111° (revisits) | 753 | 107 | 0.9 / 0.8 / 0.6 | 480 / 96 | 53 | 68 % | — | 34 / 241 | 339 (763) | **froze at 17 s** |
| 750, 291° (fresh) | 752 | 117 | 1 / 0.9 / 0.8 | 864 / 192 | 303 | 29 % | 0.10 s | 73 / 124 | 123 (426) | 15.7 %, clean |

¹ crosses Holtburg town: ACE sends indoor NPCs only from close range, so they appear beside the drone at any speed.
"Median warning" = along-track distance at first sight ÷ speed, objects first seen after reaching cruise.
Carry lag behind the drone: ≤ 8 m at 100 km/h … ≤ 52 m at 750 km/h; 0 send errors, 0 catch-up steps.

### Server (ACE)

- **Accepted without changes**: every carried pose up to ~150 m above the terrain; steps up to ~52 m at 10 Hz. The
  bubble follows the drone: 200–640 new objects per 5 km at 100–300 km/h.
- **Pop-in**: objects arrive 20–65 m ahead of the drone (not 112.5 m): visibility is evaluated per 24 m cell change, new
  landblocks load on the world thread, and the client builds the entity. Warning before you pass them: 2.4 s at
  100 km/h → 1.0 s at 200 → 0.25–0.5 s at 300–400 → 0.1 s at 750. And from 100 m AGL with the camera at −25° the
  screen centre is ~214 m ahead: the 112.5 m bubble only fills the bottom band of the frame (≈ 50–110 m ahead).
- **Freeze on revisit (verified in code)**: `Landblock.TickPhysics` returns early for a dormant landblock (`IsDormant`,
  1 min idle); only the player's 5 s heartbeat wakes the current landblock and its neighbours
  (`Player_Location.NotifyLandblocks` → `SetActive`); `LandblockManager.RelocateObjectForPhysics` does not wake it.
  Faster than ~140 km/h the drone crosses a landblock between heartbeats, so it can enter a dormant one (anything it
  flew over 1–5 min earlier): position processing stops until the next heartbeat (≤ 5 s), the next update is > 1
  landblock away, ACE rejects it (`MOVEMENT SPEED … speed: 444`), and because `Location` no longer moves every later
  update is rejected too (60 log lines/run). Objects stop streaming until a teleport / relog. Of six flights over
  ground visited 1–5 min earlier it hit both at ≥ 400 km/h and none of the four at 200–300 km/h (the risk starts above
  ~140 km/h and grows with speed; it depends on the heartbeat's phase, so it is probabilistic).
- **World-thread stalls**: `[PERFORMANCE][PHYSICS] UpdatePlayerPosition took 329.5 ms` at 200 km/h (a synchronous
  landblock load) — that hitch hits every player on the server, and ~1 s of it at 750 km/h would itself trigger the freeze.
- **Memory**: ACE RSS 526 → 1,171 MB over ~70 km of flights (landblocks stay loaded 5 min; roughly 0.6–1.5 MB each
  by two different counts); a 5-minute 750 km/h flight would hold ~1,000 landblocks, i.e. 0.6–1.5 GB for one flier.
- CPU stayed low: 5–16 % of a core.

### Client (laptop, SwiftShader — timings are pessimistic, counts are structural)

- **Terrain / buildings**: streaming is player-centred, so carrying the player brings the whole world along: the
  960 m ring (`pvsRingRadius` 5) stayed fully loaded at ≤ 400 km/h with ≥ 768 m baked ahead; at 750 km/h the outer
  rings drop to 60–80 % and the lead to 96–192 m at worst — the drone outruns the bake.
- **Main thread**: in-flight long tasks 75–350 ms/s with single tasks up to 0.4–0.9 s, driven more by what is under
  the route (towns, NPC spawns) than by speed up to 400 km/h; at rest, zero. (SwiftShader's GPU process held ~3 of the
  4 cores throughout — see Caveats — so the 1070 box will do better.)
- **Memory**: JS heap peaks 1.6–2.2 GB on 5–10 km flights (mostly collectable: it fell back to ~1.2 GB after each
  teleport). The 750 km/h runs reached the tab's 2 GB heap cap; combined with ACE's growth, the laptop dropped to
  672 MB available and earlyoom killed the renderer once.

### Draw calls and the 1070 estimate

Real `renderer.info` counts (SwiftShader, rendering on; structural, so the 1070 issues the same calls for the same
view and flags):

| View (play preset `quality=high&csm=off`) | Draw calls | Triangles | CPU census | Real − census |
|---|---|---|---|---|
| 1070 bench orbit, Holtburg, 4 headings | 484 / 531 / 739 / 863 (mean 654) | 0.31–0.44 M | 489–911 | −48 … 0 |
| Drone eye 15 m AGL at the Holtburg edge (≈ the E7 eye test) | 584 | 0.34 M | 492 | +92 |
| … 50 m AGL | 658 | 0.31 M | 567 | +91 |
| … 100 m AGL | 401 | 0.37 M | 320 | +81 |
| … 150 m AGL | 266 | 0.36 M | 202 | +64 |
| In flight, 100 m AGL, open country (census + ~80) | ~115–355 (median), p90 ≤ ~510 | — | 34–273 | — |

- **Higher is cheaper.** Draws peak at 15–50 m (buildings fill the frame) and fall to 401 at 100 m and 266 at 150 m:
  statics and buildings only exist within `objRadius` 4 landblocks, and from altitude the near field, where objects
  are dense, is a small part of the frame. Everything farther is terrain (a few batched draws).
- **Speed does not add draws** — the in-flight census at 300–750 km/h sits *below* the hover census at the same spot
  (less of the world is resident in view while streaming).
- The 1070's ~1,100-call Holtburg bench is ~650 at this preset (+~240 for CSM shadows at `quality=high` default).

**1070 estimate.** Anchors (all verified in the handoffs): the E7 drone eye test at this preset — FPV flying low around
Holtburg, ~96 fps (p50 8.4 ms on the 120 Hz grid; `../live/perf-fpv-flying.json`); main-thread render JS on the 1070
≈ 5 ms + 7.9–8.7 µs per draw call (`HANDOFF-rust-scene-core-2026-10-30.md` §D1 anatomy); the main thread binds below
~1,800 calls. Frame ≈ 10.4 ms + 8.3 µs × (calls − 584):

| Drone view | Calls | Est. steady fps on the 1070 |
|---|---|---|
| 15 m (E7) | 584 | ~96 (measured) |
| 50 m | 658 | ~90 |
| 100 m | 401 | ~110 (120 Hz cap territory) |
| 150 m | 266 | display-capped |
| 100 m, open country, any speed | ~115–355 | display-capped |

This model only carries the draw-call part: in a town the 1070 also pays for NPC rigs, animation and particles
(that is why the bench orbit runs 46–57 fps, not the ~90 the formula gives). Low passes over towns will sit between
E7 and the bench. **What the formula leaves out is streaming at speed**, which the laptop cannot time for the 1070:
the drone crosses a landblock every 3.5 s at 200 km/h, 1.7 s at 400 and 0.9 s at 750, and each crossing bakes a
new row of the 960 m terrain ring plus a row of statics and evicts the trailing row (20–35 ms per row crossing in
Linvak-class towns, `2026-10-20-improvement-hunt.md` #3; teleport tours on the 1070 show 195–374 ms worst frames).
Expected feel: ≤ 200 km/h like running today (an occasional 20–50 ms hitch); 300–400 km/h a visible hitch every
1.5–2 s; 750 km/h a hitch about every second, with terrain still filling in ahead.

## Obstacles, ranked

1. **ACE freezes the carried player's position on revisits at speed** (dormant landblocks + the 50 m / one-landblock
   step rule; permanent until teleport). One line fixes the cause: `if (worldObject is Player) newBlock.SetActive();`
   in `LandblockManager.RelocateObjectForPhysics`; belt and braces, skip the `MOVEMENT SPEED` reject for a carried /
   flagged player or re-sync instead of freezing.
2. **The 112.5 m first-sight radius is too small for a high camera.** It fixes the reported bug (doors missing around
   the drone) but at altitude the frame looks 200 m+ ahead, and above ~200 km/h life pops in at the last moment.
   Remedy: a bigger first-sight radius for a drone / carried player (`ObjectMaint` InitialClamp + 5×5 adjacency) —
   server load grows with the area (×4 objects at 225 m) — or, better, a server-side drone object with its own
   visibility (the "drone gets first sight" variant).
3. **Synchronous landblock loads on ACE's world thread** (330 ms seen) — every player feels them; at 750 km/h ACE loads
   3–5 landblocks a second. Needs preloading along the flight vector or async loads.
4. **Client streaming above ~400 km/h** — the bake lead collapses (96–192 m at 750 km/h); the camera sees holes ahead.
5. **Memory**: ACE holds every landblock for 5 min (~0.6–1.5 MB each); the client's heap grows with landblocks crossed.
6. **Trust / visibility to others**: carry is a movement hack as far as the protocol goes (any client could do it);
   other players see the character slide through the sky, not the drone. A server-sanctioned drone object is needed
   for both "others can see the drone" and anti-abuse.

## What shipping it would take

- **Small (client, days)**: the carry mode, cleaned up — a real wasm `setCarryPose` that overrides the integrator
  (no hard-snap per send), the drone hanging under/over the rig with a visible tether, a speed cap (≤ 200 km/h
  keeps every measured number green), recall that lands where you are, no RTH to a far home.
- **Small (ACE, one line + test)**: wake landblocks on relocation (obstacle 1). Without it, cap carry at ~140 km/h.
- **Medium (ACE)**: a `Drone` world object: spawned on deploy, moved by the owner's client (a new game action or the
  existing AutonomousPosition of a pet-like object), broadcast to everyone in range (so others see it), and an
  optional second visibility origin for its owner (obstacle 2). Retail clients would need it to map to a retail
  Setup DID; holtburger-web clients render the procedural drone.
- **Medium/large**: async / predictive landblock loading on ACE for fast movers; a client bake-ahead along the flight
  vector (the existing prewarm is 96 m / ≤ 4 landblocks / ≥ 2 s apart — far too small for > 200 km/h).

## Reproduce

Scripts and plans are in this folder; results in `/mnt/wbterminal1/tmp/claude-scratch/carry/` (`smoke`, `diag`,
`matrix-s1`, `matrix2`, `matrix3`, `census`, `census2` `.json` / `.log`).
1. Copy the tree, apply `../ace-streaming/hb-drag.patch` + `carry-mode-js.patch`, link `../chorizite`, build:
   `env PATH=… CARGO_TARGET_DIR=/mnt/wbterminal2/holtburger-scratch/target-main capped-build wasm-pack build --target web --out-dir pkg --release`.
2. Serve the copy on :8766 (above).
3. `capped-build node carry-runner.mjs --plan plan-matrix2.json --out <file>` (flights; `plan-matrix.json` /
   `plan-matrix3.json` are the other sessions) and `… --plan plan-census.json --render …` (bench orbit) /
   `… --plan plan-census3.json --render …` (drone-eye views: `carryCam` mode puts the render camera at the drone's
   FPV pose and carries the player 3 m below it — the real drone's deploy is frame-driven and SwiftShader renders
   ~7–14 s per frame; the drone prop itself is ≤ 4 draws); `python3 table.py <file>`.
   `results-summary.json` here = every run's summary + census view (raw per-second rows stay in the scratch dir).

## Caveats

- **Laptop ≠ 1070.** SwiftShader; an i5-6300U shared with ACE. With `?nullRender=1` the page still issues ~64 WebGL
  draws/s plus a few full-screen passes (gl-census), and SwiftShader's GPU process held ~3 of 4 cores the whole time —
  a side finding worth a look for the protocol bots. Timings here are upper bounds; draw counts are structural.
- Only Holtburg-centred routes; ~10 flights, one run each (no repetitions) — the freeze is probabilistic (heartbeat phase).
- The 750 km/h out-and-back (planned revisit test at 750) did not run: earlyoom killed the tab at its start.
- The carry hook hard-snaps the player every send; the client's own physics briefly sees an airborne body between
  snaps (harmless headless; a shipped version should override the integrator instead).
