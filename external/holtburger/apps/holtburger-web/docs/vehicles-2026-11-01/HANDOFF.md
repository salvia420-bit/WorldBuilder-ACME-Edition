# Vehicles — implementation handoff (running; started 2026-11-01)

Design: `DESIGN.md` (its **Decisions log** at the end records every deviation). Kickoff: `KICKOFF.md`.
Where the code is: the client half on branch `vehicles-2026-11-01` of WorldBuilder-ACME-Edition (pushed); the ACE half
as patches in `ace/` (base: upstream ACE `a8ff29f`; apply / regenerate: `ace/README.md`), also committed on the local
branch `vehicles-2026-11-01` of `~/ace-server` (its `origin` is upstream ACE, so nothing is pushed there).

## Where things are

| Piece | Path |
|---|---|
| Wire spec (single source) | `protocol/vehicles.protocol.xml` (Chorizite style) |
| Byte fixtures (generated from the XML) | `protocol/gen_fixtures.py` → `protocol/vehicle-wire-fixtures.json` (`--check` = stale test) |
| Sync fixtures + golden into ACE tests | `protocol/sync-ace-fixtures.sh` (`--check`) |
| Rust mirror | `crates/holtburger-protocol/src/messages/vehicle/{mod,tests}.rs`, opcodes in `opcodes.rs`, `GameAction::Vehicle` / `GameEvent::Vehicle` |
| ACE (C#) | `~/ace-server/Source/ACE.Server/Vehicles/` (VehicleWire, VehicleProfile, FlightModel, VehicleTerrain, Vehicle, VehicleManager, VehicleWeapons, VehicleBailout, VehicleStreaming, VehicleCommands, WorldTickMonitor) + hooks (see below); exported as `ace/*.patch` |
| ACE tests | `~/ace-server/Source/ACE.Server.Tests/Vehicles/` (wire fixtures, flight parity, input queue, spread RNG, terrain split) |
| wasm (session) | `apps/holtburger-web/src/vehicle_link.rs` (inbox, seat lock, stats), `src/session/commands/vehicle.rs`, SessionHandle `vehicle*` exports in `src/lib.rs`, hooks in `src/session/messages/game_event.rs` and `src/session/commands/movement.rs` (TickMovement seat lock) |
| JS client | `scene3d/vehicle/` (flight_model, predictor, controls, osd, weapons, index), installed by `scene3d/index.js` under `?vehicles=on`; per-frame seam `liveScene3d.vehicles.afterTick` after `tickPerFrame` (both tick sites) |
| Golden flight trajectories | `flight/gen_golden.mjs` → `flight/flight-golden.json` |
| JS tests | `tests/vehicle_flight.test.mjs` |
| Headless bench | `bench/vehicle-runner.mjs` + `bench/*.eval.js` + `bench/plan-*.json`; results under `/mnt/wbterminal1/tmp/claude-scratch/vehicles/` |

ACE hooks (all marked `holtburger vehicles fork`; `rg -n 'holtburger vehicles fork' ~/ace-server/Source` lists them):
`WorldManager` (world loop: VehicleManager / bail-out tick, `WorldTickMonitor` marks), `LandblockManager` (wake on entry,
read-lock fast path + `Initializing`, world-tick write locks retried while a background load holds the lock, vehicle-only
marking at construction, indoor-cell prebuild, lock / load diagnostics), `Landblock` (`VehicleOnly`, 60 s retention,
budgeted object additions / encounter placements / generator calls, loot deferral, per-phase timing), `GeneratorProfile`
(held loot queues, spawn timing), `WorldObject_Tick` + `WorldObject_Generators` (power-up yield), `WorldObject` /
`Creature` constructors (timing only), `Player_Tracking` (vehicle intro, first-sight metric, pilot CreateObject timing),
`ObjectMaint` + `PhysicsObj` (pilot sight radius / tiers / ring-2 / admission budget, visibility timing),
`WorldObject_Database` (never persist vehicles), `Player.LogOut_Inner`, `Player_Location.Teleport`,
`Player_Combat.TakeDamage`, `GameActionAutonomousPosition` / `MoveToState` / `Jump`, `Session.VehicleCapabilities`,
`PropertyManager`, `GameActionType` / `GameEventType`, and `ACE.DatLoader/DatDatabase` (a stream-lock wait counter).
With every vehicle property off, behaviour is vanilla; the diagnostics then cost a few timestamps per call site.

Server properties (default OFF = vanilla): `vehicles_enabled`, `landblock_wake_on_entry`, `vehicle_preload`,
`vehicle_preload_offthread`, `vehicle_short_retention`, `vehicle_landblock_budget`, `vehicle_retail_chat` (bools);
`vehicle_speed_cap` (double, 69 m/s), `vehicle_sight_radius` (double, 112.5 m).
Currently set on the live server: all bools above ON except `vehicle_retail_chat`; `vehicle_speed_cap` 111,
`vehicle_sight_radius` 350 (console: `modifybool <name> false` / `modifydouble <name> <value>` to go back).

Diagnostics (all in `@vehicles` / console `vehicles`, and `[VEHICLE][…]` log lines): `WorldTickMonitor` (whole world-loop
iterations over 50 ms while any vehicle exists, by phase, with GC pauses and landblock-lock waits), per-landblock tick
phases (`[LBTICK]`), slow generator calls (`[GEN]`), spawn cost split (`[SPAWN]`), pilot CreateObjects (`[CO]`),
landblock loads by thread, DAT stream-lock waits, `vehicle-createbench <wcid> [n]` (console: creation cost on the world
thread). They cost a few timestamps per phase and only run while a vehicle exists.

## Build / deploy recipes used

- Rust protocol tests: `capped-build cargo test -p holtburger-protocol` (497 + parity gate green).
- wasm: `env PATH=… capped-build wasm-pack build --target web --out-dir pkg-vehicles --release`, then `cp -a pkg pkg-prev-…` and `rsync -a --delete pkg-vehicles/ pkg/`. Backup of the pre-vehicles pkg: `pkg-prev-20261101-prevehicles`.
- ACE: `capped-build dotnet build ACE.Server/ACE.Server.csproj -c Release -o /mnt/wbterminal2/ace-build/vehicles` (NOT in place: the live server maps `bin/Release/net10.0`). Deploy = stop (`stop-now` on `~/ace_stdin.fifo`) → copy `ACE.Server.dll` + `.pdb` AND `ACE.DatLoader.dll` + `.pdb` (the fork touches DatDatabase for a diagnostic counter) → relaunch per `ace-live.md`. Rollback copy of the pre-vehicles build (both DLLs): `/mnt/wbterminal2/ace-rollback/net10.0-pre-vehicles-20261101/`.
- ACE tests: `capped-build dotnet test ACE.Server.Tests/ACE.Server.Tests.csproj -c Debug --filter FullyQualifiedName~Vehicles` (Debug only — a Release test build would write into the live directory).
- JS tests: `node tests/vehicle_flight.test.mjs`.

## Live ACE restarts (2026-11-01)

32 restarts to deploy builds (each ~20 s to "World is now open"), at 01:13 01:25 01:32 01:39 01:57 02:12 02:20 02:26 02:32
02:37 02:49 03:00 03:06 03:12 03:17 03:23 03:25 03:32 03:37 03:43 03:50 03:57 04:02 04:08 04:13 04:19 04:25 04:29 04:33
04:46 04:52 04:57. Only the bot accounts agentp09 / agentp10 logged in all day; the 04:29 run used workstation GC
(`DOTNET_gcServer=0`) and 04:33 restored ACE's default. Running now: the final build (04:57), standard launch.

## Status by milestone

All bench runs: headless Chromium (SwiftShader) on the laptop, `?nullRender=1&hud=none`, 960×540, bot `agentp10`
(Developer, `@cloak on`), local ACE (RTT 4–9 ms). Logs / JSON: `/mnt/wbterminal1/tmp/claude-scratch/vehicles/`.

### M0 — groundwork ✅ (2026-11-01)
- Wire spec (`protocol/vehicles.protocol.xml`) + generated byte fixtures; Rust mirror 4/4 tests, C# mirror 3/3 tests
  (round trip, bad tag rejected, future version, truncation, hostile count); the opcode parity gate allowlists the 10
  HBV1 opcodes.
- Bench `plan-m0.json` (`m0.json`): the capable pilot (`?vehicles=on`) got CapabilitiesAck 3, the profile and states;
  the non-capable observer (`agentp09`, no flag) saw the same parked stand-in 14 m away and received **0** HBV1
  messages; `@vehicles` lists it (1 active, ~3 µs/step, 345 B/s).

### M1 — fly ✅ (run `m1-d`)
- 11.25 km out and back at a median 248 km/h (the 69 m/s cap), 110 m AGL: board 2.4 s, take off, route, land, exit —
  the pilot ends on the terrain (z 84.5 vs ground 84.4).
- **0 corrections** (prediction exact; ack lag 4 steps at the end), RTT 4 ms. Server: 0 substituted inputs (218
  stalls repaid by 414 catch-up steps), 11 µs per step, 1.26 kB/s of vehicle traffic.
- 1,048 server objects streamed in around the pilot (first seen at a median 74 m).
- No `MOVEMENT SPEED` during flight (one at login: the harness's `@teleloc` raced an AutonomousPosition from the
  previous landing spot — ACE teleport behaviour). Vehicle-caused world stalls remained (landblocks loaded on arrival,
  up to 664 ms) — the M3 work item.
- Earlier runs found and fixed: vehicle rotting (`m1-a`), the client simulating slower than real time (frame `dt`
  cap), a substitute-and-skip input queue (corrections in multiples of one step — `m1-b`), the server dropping
  steps after its own stalls (ack lag growing to 4 s — `m1-c`). See the decisions log 15, 22–24.
- Flight-model parity: C# vs JS golden trajectories within 1 mm over 900 steps (5 sequences) + the fall model + the
  spread RNG — `ACE.Server.Tests/Vehicles` 8/8, `tests/vehicle_flight.test.mjs` 16/16.

### M2 — shoot ✅ (run `m2-c`, `plan-m2.json`)
- A Drudge Skulker (`@create 7`) on open ground 400 m south of Holtburg, killed from the air in 2 strafing passes
  (16 rounds, 5 hits, ammo 200 → 184; tracers drawn from the shared seed); the non-capable observer 30 m away
  (0 HBV1 messages) saw its corpse appear.

### M3 — faster / farther (runs `m3-a` … `m3-x`; met for the vehicle tick, not yet for the whole world loop)
- Flight (`plan-m3.json`: 5 km out + 5 km back = revisits, client `pvsRingRadius=3&objRadius=2` — the default 960 m ring
  at 400 km/h got the tab OOM-killed, `m3-a`): final `m3-x` 12.8 km at a median **399.6 km/h**, landed and exited,
  1 correction (0.02 m), ack lag 4 → **no freeze on revisits**. Across `m3-b…x`: corrections ≤ 1.3 m, none over 2 m.
- **First sight** (server, the CreateObject send): 92–97 % of ~1,800–2,200 objects first sent AHEAD of the pilot,
  69–85 % with ≥ 1 s warning, median 2.2–2.6 s, mean ~270 m. On this laptop's headless client 55–74 % are first seen
  ahead (median ~0.9–1.4 s; the tab creates entities late), and 20–30 % when the box runs out of CPU / memory
  (`m3-p`, `m3-u` — fixed by bounding the server's warm-up, decision 33).
- **World-thread stalls**: the vehicle tick has had 0 stalls over 50 ms since `m3-g` (`m3-x`: max 46.6 ms, 0 landblocks
  loaded on arrival). On the WHOLE world loop (`WorldTickMonitor`, decision 32) the first runs had ~110 iterations over
  50 ms per flight, up to 2 s (`m3-h`: generator spawns of vehicle-loaded landblocks on cold caches). Final runs: 12–20 of
  ~105,000 per flight — about half GC pauses (up to 745 ms, process-wide), the rest single ACE calls the budget cannot
  split: adding a House (a cottage 425 ms, mansions ~110 ms), a heavy creature (~100 ms), a camp's single spawn.
  Fixes, in order: off-thread loading with the world thread never waiting on it (30), HouseCell warm-up (31), spawn-cache
  warm-up incl. region encounters, gating generators not loads (33), landblock budget + loot deferral (34), cascade
  marking + power-up yield (35), indoor cells built off-thread (36).
- **GC** (decision 37): server GC (ACE's default) ~6–8 pauses over 50 ms per flight, up to 793 ms; workstation GC
  (`DOTNET_gcServer=0`, `m3-w`) 26, none over 152 ms. Both measured on this laptop at ~0.9–1.1 GB free with the 3.8 GB
  headless tab beside ACE. An owner / deployment decision; ACE runs with its default.
- Next if wanted: find why a House add costs 100–400 ms (`[HEAVYADD]` lines name them), and judge the GC trade-off on the
  real server box.
- Regression check after the M3 work: `m1-final2` (plan-m1, now at the 299 km/h cruise because the cap is 111): 11.7 km,
  2 corrections (0.04 m), ack lag 0, 0 loads on arrival, vehicle tick max 42 ms, 0 `MOVEMENT SPEED`, first sight 95 %
  ahead / 87 % ≥ 1 s / median 3.2 s.

### M4 — bail-out ✅ (runs `m4-a`, `m4-b`, `plan-m4.json`)
- `m4-b`: climbed to the 450 m ceiling at 299 km/h, bailed (X twice = `vehicleExit(…, 1)`): server "bailed out … at
  450 m AGL"; free fall, the chute opened at 150 m AGL (server; the client's 1 s samples saw it at ~106 m), 5 m/s under
  the chute; **"touched down at 5.0 m/s (chute=True) after 23.0 s"** — on foot on the terrain, no fall damage (the bot's
  health reads 99999 in god mode, so the server's touchdown speed / chute path is the evidence). The empty Hellcat went
  derelict, glided 51 s, **crashed** and **despawned 10 s later** (server log). `m4-a` (bail at 441 m): the same.
- The derelict ends far beyond the on-foot player's sight, so its crash / despawn events never reach that client; the
  client now drops vehicles it stopped tracking (entity gone + no state for 5 s — decision 38).

### M5 — presentation (code done; owner eye test queued in `EYETEST.md`)
- Retail Sitting pose for the pilot, the drone hum as the engine (`?vehicleAudio=off`), the retail chat line behind
  `vehicle_retail_chat`.
- `m5-a` (`plan-m5-chat.json` = the M2 strafe with the property on): the non-capable observer (agentp09, no flag, 0 HBV1
  messages) got **"A Hellcat roars overhead."** as ordinary chat (twice in ~3 min: once a minute per player) and saw the
  drudge die (5 passes, 4 hits). The property was switched back off afterwards.
- Look / feel (pose, seat offset, camera, hum, tracers, stand-in) cannot be judged headless: `EYETEST.md`.
- **Owner playtest 2026-11-01 05:12–05:23** (own browser over a cloudflared quick tunnel, `tailnet1`): "performed quite
  well" for a tunnel; terrain kept up, trees / scenery lagged (baked world data over the slow tunnel); expects it to do
  well on the 1070. Server side: two flights ≈ 8 min, a landing and re-board, a bail-out at 233 m AGL → chute → touchdown
  at 5.0 m/s, the derelict crashed and despawned; 0 `MOVEMENT SPEED`; no landblock / vehicle stalls while flying, only six
  GC pauses of 55–100 ms (no headless browser on the laptop — the benches' 300–790 ms pauses were memory pressure); one
  935 ms landblock tick at login, before any flight (ACE loading the arrival area). The 1070 eye test is still to do.

## 2026-11-01 evening — the first 1070 look, and the M3 residual (session 2)

**The 1070 (owner-directed, MODE T: off-screen, muted test Chrome via the box's hidden hbprobe task; gate override
written for the session).** `bench/vehicle-1070.mjs` = the eye-test tour (Holtburg → spawn → board → 300 km/h cruise, a
banked turn, cockpit, guns, 400 km/h, land, exit → climb to 450 m, bail, chute, touchdown), recording a CDP screencast
(→ `bench/frames_to_mp4.py`) and stills; `bench/vehicle-1070-probe.mjs` = a short probe of the stand-in / pilot rig
state. Pictures and video go to the owner's phone with Taildrop (`tailscale file cp … redmi-note-13-5g:`). Runs:
`/mnt/wbterminal1/tmp/claude-scratch/vehicles/1070-tour-{a,b,c}/`, `1070-probe-{a,b}/`.
- Tour A (before the fixes, server warm): flight 7.7 km, **0 corrections at RTT 83 ms** (the 1070 → SSH tunnel →
  wsbridge path), first sight 82 % ahead / 79 % ≥ 1 s; bail from 450 m, chute at 140 m, 5 m/s, unhurt, derelict gone.
  Found: the balloon vanished ~30 s into the flight (decision 40), the cockpit view was the pilot's hair (41), the pilot
  sat ~5 m below the balloon's basket (39); the stand-in is a drudge-faced hot-air balloon, not a basket vehicle.
- Tour B (seat / reaper / chase-aim fixes, server cold): the balloon stays through 400 km/h, 2 corrections (0.06 m);
  a network stall on the laptop's Wi-Fi path cost 46 substituted inputs (ack lag 62 steps at the end, first sight 60 %
  ahead) — no vehicle-caused server stall (3 GC + one vanilla decorative-corpse loot roll, 334 ms, in an ordinary
  landblock while parked).
- Probe B: in the basket the seated pilot is hidden by the basket wall from behind (present, visible, exactly at seat);
  cockpit hides pilot + balloon; the stand-in's first rig build stayed in flight 16-20 s after `@vehicle spawn`.
- Tour C (+ hop, canopy, cockpit hides, server warm-ups; server cold): flight 2 corrections (0.04 m), ack lag 1, RTT
  37 ms, first sight **91 % ahead / 87 % ≥ 1 s (median 2.35 s)**; the boarding hop carries the pilot from the ground
  into the basket; cockpit = clean first-person view from the basket. Found: the fall was filmed from the ground (the
  follow camera never followed the falling body, decision 49 — also in tour A); the far_terrain "RADIUS POLICY
  VIOLATION" console error fires at the cockpit switch (tours A and C) — open; the stand-in rig built 19.2 s after the
  spawn — open.
- Tour D (+ fall camera, muzzle in the basket, GC-first stall classification; server cold): flight **0 corrections** at
  RTT 62 ms, first sight 87 % ahead / 83 % ≥ 1 s; bail clean; the fall camera follows the body and the canopy draws —
  but the avatar was invisible under it (decision 52, fixed; probe C confirms).
- Probe C (`--bail --flags spawnTrace=1`): the rig visible through the fall; the slow stand-in appearance is the
  client's general spawn backlog after login (decision 53).
- Trees + cloud halo (Opus 5.5 agent, report relayed to the owner): two opt-in fixes, `?objRefire=on` (dropped statics
  bakes re-fired every 250 ms, ahead of travel first — the grid only re-fired a live tile on a crossing; simulation:
  58 → 94 % of the window's trees baked in flight) and `?cloudEdgeResolve=on` (a depth-aware temporal resolve at
  object silhouettes — takram's documented disocclusion artifact at the 4x4 cloud upscale; synthetic test: edge error
  -73 %). Also by design: trees exist only within `objRadius` landblocks; and the vehicle's load-point lead
  (`onPositionUpdate`) moves the bake priority centre and fires `landblockChanged` twice per lead change — the agent
  recommends a dedicated residency hint instead (open).
- **1070 verification of the two agent flags:** tours E (`objRefire=on&cloudEdgeResolve=on`) / F (baseline), same route:
  statics baked in the 7x7 object window during flight **0.96 (E) vs 0.63 (F)** (cruise 0.97 / 0.63, 400 km/h 0.94 /
  0.63; 35-36 samples each); cloudEdgeResolve installed, 5,660 passes, no shader error. Halo: `bench/vehicle-1070-probe.mjs
  --halo2` (the parked balloon from below against clouds, free camera orbiting, `?skytime=12`, the resolve toggled live
  in the same session): OFF = the gridded / dotted fringe around the balloon and roof lines, ON = clean edges
  (`/mnt/wbterminal1/tmp/claude-scratch/vehicles/1070-probe-halo2/pair-{0..3}.png`). **Owner flipped both DEFAULT ON (2026-11-01
  evening)**; `?objRefire=off` / `?cloudEdgeResolve=off` escape (fps cost unmeasured: the off-screen tab is capped at 30).
- **m3-z (laptop bench, plan-m3, server with all of decisions 45-48):** 12.9 km at 399.6 km/h, 2 corrections (0.02 m);
  world ticks over 50 ms 15 = gc 10 / other 4 / vehicle 1 (m3-x 20 = gc 8 / other 12; m3-y 15 = gc 7 / other 8). The
  non-GC rest: Necromancer / Royal Guard first InitPhysicsObj 48 / 67 ms (was 73 / 106: their landblock's instances were
  added before the serialized spawn warm-up reached them — the warm-up gates generators, not instance additions); the
  pilot's CreateObject of the Mansion House 0x7BCAD044 60 ms (the one "vehicle" stall; the same object was the worst
  CreateObject in m3-x / m3-y: 18 / 23 ms); two unattributed 62 ms ticks (Sessions; one landblock tick). Physics warm-up:
  1,046 GfxObjs built off-thread in 326 ms total. 0 ordinary landblock loads outside the vehicle loader.

**Open after session 2:** the Mansion House CreateObject cost (60 ms worst); instance additions racing the spawn
warm-up (an instance-first physics pass, or gate instance creatures on it); the far_terrain RADIUS POLICY VIOLATION at
the cockpit switch; the client's spawn backlog after login (decision 53); the vehicle's load-point lead via
`onPositionUpdate` (agent: use a residency hint); thicker tracers; the owner's calls on the stand-in (keep the balloon?),
the seat, the two agent flags' default, and EYETEST's questions. Committed (owner, 2026-11-01 evening): the client half
pushed to origin/master; the server half = `~/ace-server` commit 0003 on `vehicles-2026-11-01` (local), exported as
`ace/0003-…patch` (the three patches re-verified to reproduce the branch tree on `a8ff29f`).
- Owner feedback during the session: few trees while flying; artifacts (a speckled halo) around the balloon against
  clouds → an Opus 5.5 agent investigates both (scope: outside scene3d/vehicle and ACE).

**1070 power (owner, 2026-11-01 ~20:00):** the display turns off after 10 min idle (`powercfg /change
monitor-timeout-ac 10` and `-dc 10`; was never); sleep / hibernate stay NEVER (a sleeping box drops SSH, the tunnel and
test Chrome). Test drivers hold `navigator.wakeLock.request("screen")` for their run (vehicle-1070*.mjs now, hbsess.mjs
already) so a dark display never throttles a test tab; the lock ends when the page leaves. Revert: `powercfg /change
monitor-timeout-ac 0`.

**M3 residual (server).** Instrumentation + three fixes (decisions 45-48): vehicle-only marking on the physics /
heartbeat / relocation load paths; link children's weenies fetched on CreateWorldObjects' background task; physics
GfxObjs warmed off-thread with the spawn caches. m3-y (instrumentation + marking): stalls > 50 ms 15 (gc 7 / other 8)
vs m3-x 20 (gc 8 / other 12); the remaining "other" = house links (fixed since), cold model physics (fixed since), one
40 ms creature heartbeat, one unexplained 89 ms tick.

**Live ACE restarts (session 2):** 16:47 (instrumentation build), 18:43 (seat + link prefetch + physics warm-up),
18:59 (muzzle + stall classification).
Rollback of the session-1 final build: `/mnt/wbterminal2/ace-rollback/net10.0-vehicles-20261101-0457/`. All ACE
changes are uncommitted in `~/ace-server` (branch `vehicles-2026-11-01`).
