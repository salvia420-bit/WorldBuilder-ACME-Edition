# Vehicles — design (first target: a Hellcat-type fighter demo) — 2026-11-01

Status: **design, nothing built.** Scope: the infrastructure that lets a vehicle *function well* — server movement,
streaming, visibility, combat against monsters, bail-out, and compatibility — with one demo vehicle on top. The vehicle's
looks, boarding animation and economy (fuel, armor, guild air control) plug into this later and are only sketched here.

Inputs: the owner's direction (2026-10-31 / 11-01, below) and the carry experiment
`../drone-deploy-2026-10-24/carry-experiment/README.md` (the drone carried the player at 100–750 km/h, headless).

## 0. Direction (owner)

- Portals are an obsolete way to travel; the meta moves to **vehicles** of several kinds, built from in-game items, with
  a WW2 *mental framing* (not real vehicles): e.g. a Grumman F6F Hellcat-inspired fighter — a gun that fires crossbow
  bolts rapidly, salvaged-steel armor (workmanship = protection), mana-scarab fuel, missiles that keep the flavor.
  Expensive (a money sink), and air control for a guild.
- The settings right for an aircraft are wrong for a player on foot, and wrong for a jeep: the server needs a
  structured way to know **what is coming at it and what is using its resources**.
- Decisions (2026-11-01): (1) **server-authoritative** vehicle movement; (2) vehicles **fight monsters**; (3) pilots can
  **bail out** — vehicle → on foot at 1,000+ ft; (4) scale: **a couple of vehicles** for demonstrations (design so a
  serious server could scale it); (5) **holtburger-web only** for the vehicle experience, but **retail clients keep
  connecting and playing** — "it is only in the air, and there is nothing in the air" — and should get some indication
  of what is happening even without the full depiction. Coming days: a working Hellcat-type demo (climb in, fly,
  shoot bolts); the vehicle details don't matter yet, its ability to function well does.

## 1. What the carry experiment already tells us

| Finding (laptop, headless, real drone) | Consequence for vehicles |
|---|---|
| Vanilla ACE trusts the client's position: any update < ~1 landblock (192 m) is accepted, at any speed | Today anyone can "fly" with a modified client. Vehicles must be **server-owned**; on-foot movement gets tightened (§4.9). |
| ≤ 200 km/h: everything kept up (terrain ~1 km ahead, server objects 1–2 s before you reach them) | The first demo cap. |
| 300–400 km/h: terrain fine, server objects pop in 0.25–0.5 s before you pass them | Needs a bigger server sight radius at altitude + preloading ahead (§4.5, §4.6). |
| 750 km/h: client terrain lead fell to 100–200 m, ~70 % of objects appeared after passing | Informational ceiling; not a target. |
| Revisiting ground left 1–5 min earlier at ≥ 400 km/h **froze the player's server position** (dormant landblock → missed heartbeat → step > 1 landblock rejected → every later step rejected) | Wake landblocks on entry; never freeze, correct (§4.5, §4.4). |
| One position update took **330 ms** (synchronous landblock load on the world thread) | Budgeted preloading ahead of the vehicle (§4.5). |
| ACE kept every landblock 5 min (RSS 526 → 1,171 MB over ~70 km) | Shorter retention behind vehicles; per-vehicle cost metrics (§4.5, §4.10). |
| Draw calls fall with altitude (584 at 15 m → 266 at 150 m; ~115–355 over open country) | Rendering is not the constraint; streaming and the server are. |
| A crewed vehicle needs no multi-origin visibility: ACE's player-centred streaming follows the pilot's body | Crewed first; remote-piloted (the drone) later (§9). |

## 2. Principles

1. **Players never move fast; vehicles do.** Anything faster than running is a vehicle — a server object with a profile.
   Boarding switches the player from the on-foot rules to the vehicle's rules; the server always knows which apply.
2. **The server owns the vehicle.** Clients send inputs; the server simulates; the pilot's client predicts and
   reconciles; observers interpolate. Fuel, ammo and damage live on the server.
3. **Data, not code, describes a vehicle.** A small set of locomotion classes in code (Air first, Ground later); every
   vehicle type is a profile (numbers); every vehicle is an instance (state).
4. **Additive and air-only.** Nothing changes for players on the ground or for clients that don't ask for vehicles.
   New messages go only to sessions that announced the capability; everyone else sees standard objects and messages.
   Representation is a **ladder** (§5.1): plain retail sees a stand-in, retail + a patch / Chorizite plugin can see the
   real thing, holtburger-web flies it — so the wire format and the vehicle's looks are defined once, as data.
5. **Correct, never freeze.** Out-of-envelope input or state is corrected by the server; nothing leaves a player stuck.
6. **Measure before and after.** The headless harness from the carry experiment becomes the vehicle bench.

## 3. Model

### 3.1 Locomotion classes (code)
- **Air** (this design): flies above a floor altitude; collides with terrain (and buildings only below the floor, at
  takeoff/landing); modes Parked → Takeoff → Flight → Landing; no stall in v1.
- **Ground** (later: jeeps): follows the terrain; collides with buildings, scenery, statics; slope limits.
- **On foot**: today's ACE + client physics, unchanged except the tightened envelope (§4.9).

### 3.2 Vehicle profile (data; one per vehicle type)
Stored as properties on the vehicle's weenie (custom property ids in one reserved block, documented next to the code),
read once into a server-side `VehicleProfile` record and sent to capable clients (§5) so the client predictor uses the
same numbers.

| Group | Fields |
|---|---|
| Identity | profileId, locomotion class, display name, retail stand-in Setup DID, client model key |
| Movement | vMin, vCruise, vMax (boost), accel, decel, maxBank, rollRate, maxPitch, pitchRate, yawRate (rudder), climbMax, sinkMax, floorAgl, ceilingAgl, takeoffClimb, landingSpeed |
| Server streaming | preloadSeconds, sightRadius (seated), relevance tiers, maxLandblockLoadsPerSec |
| Client streaming | terrain ring radius, object radius, load-point lead seconds |
| Seats | count; per seat: offset, role (pilot / gunner), retail motion (Sitting) |
| Weapons | per mount: type (repeating crossbow, missile), rate, spread, range, damage, magazine, ammo item |
| Economy (later) | fuel item + burn per second at cruise / boost, armor slots, hull HP, repair materials |
| Rules | outdoor-only, allowed zones, PvE / PK flags |

### 3.3 Vehicle instance (state)
guid, profileId, owner, seats → occupants, mode, pose (cell + position + heading/pitch/bank), speed, last input per
seat, magazine counts, (later) fuel / hull / armor. Demo: spawned by an admin command, not persisted.

### 3.4 Demo profile — `hellcat-demo`
| Field | Value | Note |
|---|---|---|
| vMin / vCruise / vMax | 30 / 83 / 97 m/s (108 / 300 / 350 km/h) | **capped at 69 m/s (250 km/h) until M3** (preload + sight radius); 111 m/s (400) after |
| accel / decel | 8 / 12 m/s² | 0 → 300 km/h in ~10 s |
| maxBank / rollRate | 60° / 90°/s | coordinated turn; radius ≈ 400 m at 300 km/h, 60° |
| maxPitch / pitchRate | 25° / 45°/s | |
| climbMax / sinkMax | 20 / 25 m/s | |
| floorAgl / ceilingAgl | 30 m / 450 m (~1,500 ft) | below the floor only in Takeoff / Landing |
| takeoffClimb | 8 m/s vertical to 30 m AGL, then accelerate to vMin | arcade "short takeoff"; needs open sky (reuse the drone's covered check) |
| sightRadius | 112.5 m (M1) → 350 m with tiers (M3) | |
| preloadSeconds | 6 | |
| Gun | repeating crossbow: 8 bolts/s, 1.5° spread, 120 m, magazine 200 | damage per bolt: demo constant (pierce) until ammo stats are wired; range just past the ground's reach (§4.7) so attacking means a low pass |
| Seats | 1 pilot (offset to be fitted to the model) | |

## 4. Server (ACE fork, `~/ace-server`)

Working on the live server: `~/ace-server` is the build that runs on this laptop. Change it on a branch, build the
single project (`DOTNET_ROLL_FORWARD=LatestMajor dotnet build`, memory-safe), keep the previous `bin/Release/net10.0`
for rollback, and restart at a quiet moment with the tested recipe (log players out → `stop-now` on the console FIFO
→ relaunch; ~24 s to "World is now open" — memory `ace-live.md`). Every vehicle feature sits behind a server property
(default off) so a restart with the feature off is the vanilla server.

### 4.1 The vehicle object
- New `WeenieType` (e.g. `Vehicle`) and class `Vehicle : WorldObject` with a physics object, seats, mode, pose, speed,
  magazines. Outdoor cells only.
- Demo spawn: admin command `@vehicle spawn <profile>` (place in front of the caller on open ground), `@vehicle despawn`.
- **Retail-visible as a standard object**: CreateObject / UpdatePosition with the profile's retail stand-in Setup DID.
  Capable clients replace it with the vehicle model (§6.4).

### 4.2 `VehicleManager` — the registry ("what is coming at it")
- Holds every active vehicle; ticked from `WorldManager.UpdateGameWorld()` right **before** `LandblockManager.Tick`
  (so the sim has placed vehicles and pilots before landblock physics and visibility run).
- Fixed-step simulation at **30 Hz** (accumulator; 0–2 steps per world tick; the world loop itself is limited to 60 Hz).
- Per vehicle per step: consume the input for this step (§4.3), integrate the flight model (§4.4), resolve weapons
  (§4.7), move the occupants (§4.3), schedule preloads (§4.5), queue state messages (§5).
- Owns the per-vehicle cost counters (§4.10).

### 4.3 Seats, inputs and the pilot's body
- Board: `VehicleBoard` (§5) → checks (pilot within 5 m, outdoors, not in combat stance, vehicle Parked, seat free) →
  seat taken; player state **Seated**. Demo: instant (the animation comes later, client-side, like the drone's gestures).
- While seated, the **pilot's `Location` is slaved to the vehicle** each step (seat offset); ACE's own player machinery
  — landblock relocation, ObjectMaint visibility, monster awareness — follows unchanged. AutonomousPosition /
  MoveToState from a seated player are ignored (the server already knows where they are).
- The pilot is shown to every client in the standard way: UpdatePosition at the seat + `MotionCommand.Sitting`
  (`0x41000013`). Retail clients see a seated character moving through the sky — inside the stand-in.
- Inputs: `VehicleInput` carries a sequence number and the client's step index; the server keeps a short buffer per
  seat, uses the input for each step, and holds the last one if a packet is late (inputs are sent redundantly, §5).
- Exit (Parked / on the ground) and Bail (§4.8). Logout or disconnect while seated: the pilot is saved at the **ground
  point under the vehicle** (never in the air); the demo vehicle then auto-lands and despawns.
- Blocked while seated: portals, recall spells, teleport commands, entering dungeons / buildings, melee/magic combat
  modes (the vehicle's weapons are the combat).

### 4.4 Flight model (Air, v1 — arcade, deterministic, specified once, implemented twice)
State: position p (AC world metres; x east, y north, z up), heading ψ (compass, radians), pitch θ, bank φ, airspeed v.
Inputs per step (dt = 1/30 s): throttle t ∈ [0, 1], pitch stick s_p, roll stick s_r, yaw stick s_y ∈ [−1, 1], boost b.
1. Target speed v* = vMin + t·(vCruise − vMin), or vMax with boost; v moves toward v* by at most accel·dt (decel·dt).
2. Bank φ → s_r·maxBank at rollRate; pitch θ → s_p·maxPitch at pitchRate.
3. Turn rate ψ̇ = g·tan φ / v + s_y·yawRate (coordinated turn + rudder); ψ += ψ̇·dt.
4. Vertical speed w = clamp(v·sin θ, −sinkMax, climbMax); horizontal speed = v·cos θ along (sin ψ, cos ψ).
5. p += velocity·dt; then the envelope: z ≥ ground(x, y) + floorAgl (clamp, w = 0) except in Takeoff / Landing;
   z ≤ ground(x, y) + ceilingAgl. `ground` = the retail terrain height (ACE's physics terrain on the server,
   `terrainHeightAt` on the client — the same retail split-diagonal surface).
6. Takeoff: from Parked, rise at takeoffClimb to floorAgl, then Flight at vMin. Landing: below floorAgl only at
   v ≤ landingSpeed over open ground; touching down → Parked.
7. Collision: swept segment vs terrain (heightmap) every step; vs buildings only in Takeoff / Landing. A terrain hit in
   Flight = crash (demo: vehicle destroyed and despawned, pilot ejected at the impact point with no fall damage).
Implementations: C# in ACE (authoritative) and JS in holtburger-web (predictor). Both in double precision; parity is
tested on golden input sequences (§7); remaining last-bit drift (trig) is absorbed by reconciliation.

### 4.5 Streaming and landblocks
- **Wake on entry** (the freeze root cause, verified in code): in `LandblockManager.RelocateObjectForPhysics`, when the
  object is a `Player` or a `Vehicle`, call `newBlock.SetActive()` (it also wakes the neighbours) — a dormant landblock
  no longer skips `TickPhysics` for up to the 5 s player heartbeat.
- **Preload ahead**: each step, the landblocks under a corridor `velocity × preloadSeconds` ahead (one landblock either
  side) are requested. v1: synchronous loads **spread over ticks** within a budget (≤ 1 per tick, ≤
  maxLandblockLoadsPerSec per vehicle, a global cap) so loads happen early and one at a time instead of on arrival.
  v2: off-thread loading (DAT reads + DB queries) with a world-thread publish step.
- **Back-pressure**: if a vehicle's preload queue falls behind (the next landblock on its path is not loaded with
  ≥ 2 s to spare), the server lowers that vehicle's allowed vMax (flavor: headwind / engine strain) until it catches up.
  The world never stalls to keep one vehicle fast.
- **Retention**: landblocks that only a vehicle touched (no player on foot within the 3×3) unload after 60 s instead
  of ACE's 5 min.

### 4.6 What the pilot sees (server sight radius)
- M1: unchanged (112.5 m first sight, `ObjectMaint.InitialClamp_Dist`).
- M3: per-ObjectMaint radius (the static becomes a per-player value set from the seat's profile while seated) and a
  5×5 landblock candidate set for the pilot (pilots are always holtburger-web sessions — retail sessions keep 112.5 m:
  one ACE fork, Dekaru's, *lowered* its outdoor broadcast to the 75 m radar range to cut retail / Decal client crashes,
  community Discord 2024-03-19); **relevance tiers**: within 112.5 m everything; out to sightRadius only
  vehicles, players, creatures (by size), portals, lifestones, doors and other static landmarks; never ground items or
  corpses at range. Cost grows with area (350 m ≈ 10× the objects of 112.5 m before filtering), so tiers are required.
- Client-side far dressing (static doors, signs, lifestones) from the baked spawn data the client already has
  (`scene3d/spawns.js`, `dist/spawns/`) is an option for later, swapped for the live object when it arrives.

### 4.7 Weapons vs monsters (PvE)
- **Ranges set the balance.** Ground monsters reach ~75–78 m: ACE caps monster missiles at 85 yd ≈ 77.7 m
  (`Creature_Missile.cs:403` `MissileRangeCap`, also bounded by the weapon's ballistic range) and monster spells at
  75 m (`Monster_Magic.cs:117` → `Player.MaxRadarRange_Outdoors`); the retail client's own caps are
  `MISSILE_RANGE_CAP = 85.0` and `RADAR_OUTDOOR_RADIUS = 75.0` (acclient.c:40036-40037). So an aircraft above ~80 m is
  out of reach and a strafing run below it is exposed — the demo gun's 120 m keeps attacks low and risky.
- Fire is a button in `VehicleInput`; the server owns the rate (accumulator per mount), spread (server RNG) and ammo.
- Per bolt: a ray from the muzzle along the vehicle's forward vector + spread, up to range; candidates = creatures the
  pilot already tracks (ObjectMaint known objects) inside the range cone; hit = ray vs the creature's physics cylinder;
  occlusion = terrain heightmap ray-march (v1; buildings later). No per-bolt physics projectile objects — 8 bolts/s ×
  N vehicles of ACE missile objects would be the expensive part.
- Damage through ACE's normal path, `Monster_Combat.TakeDamage(source: pilot, DamageType.Pierce, amount, crit)`, so
  aggro, death, XP and loot behave as for any player attack — and **retail clients see monsters take damage and die**
  with standard messages.
- Monsters target the pilot as usual; melee ones cannot reach the air; ranged ones within their range can. Demo: the
  seated pilot takes no damage (vehicle hull HP is a later layer).
- Capable observers get `VehicleFire` (muzzle, direction, count, step) to draw tracer bolts; hits are already visible
  through the standard damage messages.
- Missiles (later): war-magic projectile spells launched from a mount — ACE already simulates spell projectiles.

### 4.8 Bail-out (vehicle → on foot, any altitude ≥ floor)
- `VehicleExit{mode: bail}` → the seat empties; the player's state becomes **Freefall**, simulated on the server:
  gravity, drag to ~50 m/s terminal, inherited horizontal velocity decaying; the parachute opens at 150 m AGL (or on
  command) → 5 m/s descent, 8 m/s steerable glide; touchdown → **OnFoot** (normal ACE rules).
- Fall damage: none on a parachute landing (vertical speed ≤ 6 m/s); without the chute ACE's normal fall damage applies.
  The server owns the falling body so ACE's own falling logic is not applied twice.
- The empty vehicle: autopilot straight glide and descent → crash → wreck / despawn (demo: despawn after 10 s).
- Retail clients see the player falling and landing (standard UpdatePosition / motion).

### 4.9 On foot: close the speed hole (separate switch)
An on-foot player's step is checked against a run-speed envelope (max run speed × elapsed time × slack, plus jump /
fall allowances) instead of only "≤ 50 m or within one landblock". Out-of-envelope steps are corrected (snap back to the
last valid position), never frozen. Behind a server property so it can be tuned with retail clients connected —
legitimate retail movement must pass untouched. Two community notes: a Decal plugin ("Hax") already let people
teleport and "fly around like a fairy" on emulators, so the hole is real; and the retail client ignores the
ForcePosition bit while airborne (an ACE developer, #utilitybelt 2024-01-19), so a correction to a jumping / falling
retail player must be re-sent once it lands.

### 4.10 Costs and admin view ("what is using the resources")
Per vehicle: steps simulated and µs per step, landblock loads caused (last 60 s), preload queue depth and lead time,
objects tracked by its pilot, bytes/s of vehicle messages, bolts resolved and hits. Global: vehicles active, loads/s
against the cap, back-pressure events. `@vehicles` prints them; `ServerPerformanceMonitor` gets a VehicleManager entry.

## 5. Protocol (additive; capability-gated)

- **Capability handshake**: after entering the world, a capable client sends `ClientCapabilities{version, flags}`;
  flag bits: 0 = **observe** vehicles (receive `VehicleProfile` / `VehicleState` / `VehicleFire` / `VehicleEvent`),
  1 = **pilot** vehicles (may send `VehicleBoard` / `VehicleInput` / `VehicleExit`), 2 = has the vehicle **DAT patch**
  (§5.1). holtburger-web sets 0 + 1. The server records the bits per session and answers `CapabilitiesAck`; each
  message goes only to sessions holding its bit, and pilot actions from a session without bit 1 are ignored. Vanilla ACE would
  only log an unknown game action (`InboundMessageManager` warns and drops), and retail clients never send it — so
  **no session that has not asked ever receives a vehicle message**.
- Belt and braces, from the retail decomp: the client drops game events it does not know —
  `UIQueueManager::ProcessNetBlobData` (acclient.c:394441) switches on the event opcode and every unmatched case falls
  through to `result = 0` (`$L170112`). A stray vehicle event would be ignored, not crash a retail client; the gate
  still keeps their traffic and event ordering exactly as today. Community experience agrees: the stock client and
  Decal ignore unknown packets (#chorizite / #general, 2024-11 and 2025-03).
- Opcodes: the 0x0900–0x09FF block is unused in ACE's `GameActionType` / `GameEventType` and in Chorizite's tables
  (checked 2026-11-01, also absent from holtburger's `opcodes.rs` and from the community Discord archive); vehicle game
  actions (inside 0xF7B1) and game events (inside 0xF7B0) use 0x0900–0x090F. Custom opcodes are common in the
  Chorizite / UtilityBelt circle and have collided before (an ACE mod reuses 0xF7CA), so every vehicle message starts
  with a 4-byte namespace tag (`HBV1`) and a version, and a receiver drops anything without it. A shared community
  convention — one opcode with a plugin-name header and subcommands, proposed in #chorizite / #general (2024-11) — can
  replace the raw range later without changing the payloads; trevis's `acserverclientplugindemo` (gitlab) is the
  reference for a server + Chorizite-plugin custom-message pair (tier 2).

| Dir | Opcode | Message | Fields (v1) | Rate |
|---|---|---|---|---|
| C2S | 0x0900 | ClientCapabilities | version u16, flags u32 | once per login |
| S2C | 0x0900 | CapabilitiesAck | version u16, flags u32 | once |
| S2C | 0x0901 | VehicleProfile | vehicle guid, profileId, all §3.2 movement / weapon fields | on first sight |
| C2S | 0x0902 | VehicleBoard | vehicle guid, seat | on use |
| C2S | 0x0903 | VehicleExit | vehicle guid, mode (exit / bail) | on use |
| S2C | 0x0904 | VehicleSeat | vehicle guid, seat, occupant guid, state | on change |
| C2S | 0x0905 | VehicleInput | vehicle guid, inputSeq u32, step u32, throttle u8, pitch / roll / yaw i8, buttons u8 (boost, fire), + the previous 2 inputs | 30 Hz while seated |
| S2C | 0x0906 | VehicleState | vehicle guid, step u32, ackInputSeq u32 (pilot only), cell u32, x y z f32, heading / pitch / bank (i16), speed f32, mode u8 | 20 Hz to the pilot, 10 Hz to capable observers in sight |
| S2C | 0x0907 | VehicleFire | vehicle guid, step, mount, muzzle xyz, dir (i16 ×3), count | per burst tick |
| S2C | 0x0908 | VehicleEvent | vehicle guid, kind (takeoff, landed, crashed, despawn, bail, chute), payload | on event |

- Everyone (retail included) also gets the standard messages: CreateObject / UpdatePosition for the vehicle's stand-in
  and for the pilot (seated motion), and the normal combat / death messages for monsters. Capable clients drive the
  vehicle from `VehicleState` and ignore its standard UpdatePosition.
- Optional retail indication: a local, rate-limited system chat line to non-capable sessions within ~250 m
  ("A Hellcat roars overhead.") — standard chat, no new opcode.

### 5.1 Representation ladder

Owner, 2026-11-01: the team's Chorizite retail plugin already adds takram skies, ragdolls, lighting and textures —
"it perhaps can be made to offer representations of these things with a patch".

| Tier | Client | Sends | Sees |
|---|---|---|---|
| 0 | plain retail | nothing new | the stand-in object (base-DAT Setup) moving through the sky, the pilot seated in it, monsters taking damage and dying, the optional chat line |
| 1 | retail + vehicle **DAT patch** (later) | bit 2 | the real model: ACE sends the vehicle's custom Setup DID (a reserved patch range) only to bit-2 sessions; everyone else keeps the base-DAT stand-in — an unknown DID never reaches an unpatched client |
| 2 | retail + the **Chorizite plugin** (later) | bits 0 (+ 2) | the plugin parses the same vehicle messages: smooth motion from `VehicleState`, tracers from `VehicleFire`, engine sound, takeoff / crash / bail events; flying from retail (bit 1) is possible later, not planned |
| 3 | holtburger-web | bits 0 + 1 | everything; pilots |

Three choices now keep tiers 1–2 cheap later, at no cost to the demo:
1. **One wire spec.** The §5 messages are written once as a protocol fragment in Chorizite's `protocol.xml` style
   (its generator then emits the C# readers / writers for ACE and a plugin), mirrored by `holtburger-protocol` in Rust
   and checked by round-trip tests against shared byte fixtures.
2. **The vehicle's looks are data built from retail assets**: a composite of base-DAT Setup / GfxObj DIDs with part
   transforms (sent in `VehicleProfile`), or later one custom Setup in the patch range — never client-only geometry for
   the body — so every tier draws the same aircraft. Clients add their own effects on top (holtburger-web's tracers,
   the plugin's lighting).
3. **Bits are additive and versioned**; a new tier is a new bit, and the server never sends a tier's content to a
   session that did not ask for it.

## 6. Client (holtburger-web)

### 6.1 Protocol and session (Rust)
`crates/holtburger-protocol` gains the §5 messages (opcodes in `opcodes.rs`, structs under `src/messages/`);
the session sends `ClientCapabilities` after EnteredWorld and exposes `vehicleInput(...)`, `vehicleBoard(...)`,
`vehicleExit(...)` plus a vehicle-state event stream to JS (same pattern as the other wasm exports).

### 6.2 Vehicle module (`scene3d/vehicle/`, modelled on `scene3d/drone/`)
- **Controls**: reuse `scene3d/drone/controls.js` (keyboard, pointer lock, gamepad, input lock).
- **Predictor**: the §4.4 model in JS; each local step applies the input, stores (seq, input, state); on `VehicleState`
  with ackInputSeq it resets to the server state and replays the newer inputs; the visible error is blended out over
  ~150 ms. The camera follows the predicted pose.
- **Observers**: other vehicles interpolate `VehicleState` with a ~120 ms buffer.
- **Camera**: chase (behind / above) and cockpit; owns the render camera through the film camera owner, as the drone does.
- **Model**: a composite of retail parts described as data in `VehicleProfile` (§5.1 rule 2) — a placeholder until the
  real model exists, but already in the form every tier can draw; the pilot's rig sits in the seat.
- **OSD**: speed, altitude AGL, heading, magazine — the drone OSD is the starting point.
- **Effects / audio**: tracer bolts from `VehicleFire`, engine sound on the effects bus.
- **Board / exit / bail UI**: Use on the vehicle boards; the animation (climb in) comes later as local clips like the
  drone's gestures.

### 6.3 Streaming profile while seated
- Load point lead: the client's streaming centre (today the player position) is shifted forward by
  `velocity × lead seconds` (profile), so the 960 m terrain ring (`pvsRingRadius` 5) is biased ahead of the aircraft.
- Object radius per profile (default 4 landblocks); restored on exit.

### 6.4 Rendering the stand-in
A vehicle object from a capable session's `VehicleProfile` is drawn with the vehicle model; its standard Setup (the
retail stand-in) is hidden for that guid.

## 7. Testing and measurement
- **Flight-model parity**: golden input sequences (JSON) run by a C# test in ACE and `tests/vehicle_flight.test.mjs`;
  trajectories must agree within 1 mm after 30 s.
- **Protocol**: round-trip pack / unpack tests for every §5 message (Rust); the server ignores malformed ones.
- **Headless vehicle bench** (successor of `carry-runner.mjs`): spawn, board, take off, fly the carry-experiment
  routes at 200 / 300 / 400 km/h, turn, revisit ground, fire at monsters near the route. Per second: prediction error,
  corrections, server step time, preload queue and lead, landblock loads, bytes/s, server objects around the pilot
  (first-seen distance), client long tasks; ACE WARN lines per run. One heavy job at a time, inside `capped-build`.
- **Compatibility**: a non-capable session (the Rust `holtburger-cli`, standing in for a retail client) in the same
  area must receive **zero** 0x09xx messages, see the stand-in and the seated pilot move, and see monsters die; a retail
  client check by hand when one is available.
- **1070 eye test** (owner, when the box is back): flight feel at 250 / 350 km/h, corrections, tracers, frame rate.

## 8. Milestones (demo)

| # | Deliverable | Done when |
|---|---|---|
| M0 | Server groundwork: the vehicle wire spec as one protocol fragment (+ Rust mirror, byte fixtures); capability handshake with the observe / pilot / patch bits; landblock wake-on-entry; `VehicleManager` skeleton; `@vehicle spawn/despawn`; stand-in object; `@vehicles` costs | a capable and a non-capable session both see the parked stand-in; `@vehicles` lists it; the fixtures round-trip in C# and Rust |
| M1 | Fly: board / exit, server flight model (Parked → Takeoff → Flight → Landing), pilot slaved to the vehicle, `VehicleInput` / `VehicleState` / `VehicleProfile`; client predictor + reconciliation, chase camera, placeholder model, OSD, load-point lead; cap 250 km/h | 10 km at 250 km/h over the carry routes: corrections < 2 m at ≤ 100 ms RTT, no ACE `MOVEMENT SPEED` / PERFORMANCE warnings, server objects stream around the pilot |
| M2 | Shoot: gun, server bolt resolution, `Monster_Combat.TakeDamage`, magazine, tracers | a drudge killed from the air; the non-capable session sees it die |
| M3 | Faster / farther: budgeted preload ahead, back-pressure, per-pilot sight radius + tiers, shorter retention; cap → 400 km/h | the headless bench at 400 km/h: no freeze on revisits, objects first seen ≥ 1 s ahead, no world-thread stall > 50 ms from vehicles |
| M4 | Bail-out: freefall, parachute, landing; empty vehicle crashes / despawns | bail from 450 m: lands on foot unhurt; the vehicle is gone |
| M5 | Presentation: boarding animation, engine audio, retail chat indication | owner eye test |

## 9. Later layers (not in the demo)
- **Economy**: fuel (mana scarab tiers as fuel grades, burn computed by the server), armor plates of salvage
  (workmanship → protection, repairs consume salvage), ammo from inventory quarrels, wrecks returning part of the
  salvage — the money sinks.
- **Guilds and air control**: ownership, airspace claims, anti-air emplacements, PK rules for vehicle combat.
- **Ground vehicles** (jeep): the Ground locomotion class with its own profile — same registry, protocol and costs.
- **Remote-piloted vehicles** (the drone as a networked vehicle): the pilot's body stays on the ground, so the server
  needs a second visibility origin per session — the "drone gets first sight" variant; deliberately after crewed ones.
- Persistence (a garage), vehicle damage / hull HP, crew seats and gunners.

## 10. Risks and open questions
- **Latency**: server-authoritative control lives or dies by prediction. The laptop that hosts ACE is on Wi-Fi with
  documented 1–3 s echo stalls (fleet runbook) — demos on a wired link; inputs sent redundantly; corrections smoothed.
- **World-thread stalls** from landblock loads until v2 off-thread loading exists (budgeted preloading only spreads them).
- **Server simulation cost at scale**: retail AC deliberately avoided deep server-side physics for scalability
  (community Discord, an ACE developer, 2024-12-21). A couple of demo vehicles cost nothing; a serious server must read
  the per-vehicle costs (§4.10) before scaling the count.
- **Parity drift** between the C# and JS flight models (trig last bits) — tested, then absorbed by reconciliation.
- **The laptop cannot judge feel** (SwiftShader); structural checks run here, flight feel needs the 1070.
- Open: the retail stand-in Setup (what retail players see in the sky); whether the seated pilot can be hurt; ammo
  from inventory or unlimited for the demo; takeoff style (short vertical takeoff in v1, runways later?); where vehicles
  come from outside admin commands (a deed item, a garage).
