# 10 — Server runtime and scaling (the character plane at 1,000+ players)

Status: **draft v0.1** (2026-11-03).
Depends on: [01 audit](01-technology-audit.md), [02 scale model](02-scale-model-and-budgets.md), [04 architecture](04-target-architecture.md).
Sources: the server surveys of 2026-11-03. `S/` = `~/ace-server/Source/ACE.Server/` (fork, branch
`vehicles-2026-11-01` = upstream `a8ff29f` + the vehicles patch series `ace/0001-0006`).

## 1. Summary

ACE can plausibly carry the **character plane** for 1,000+ concurrent players on a server-class box. This is
**unproven**, and it depends on five things:
- the work that is serial today stays small per player, which is a measurement;
- **landblock work stays parallel at scale**: today's distance-based groups percolate into one group at the projected
  5,000–8,700 resident landblocks, so this needs the phase-coloured scheduler (H17) and parallel heartbeats (H18);
- every landblock load and bring-up leaves the world thread, generalizing what the vehicle fork built;
- crowd costs (O(N²) visibility and broadcast) are bounded;
- the new heavy systems run outside ACE, in the WSS ([04](04-target-architecture.md)).

This document lists the hardening items (H1–H18) and the ACE hooks the trifecta adapter needs (§4), and defines the
load governor (§6).

## 2. ACE's runtime today

| Element | Behaviour | Citation |
|---|---|---|
| World Manager thread | One thread; each loop: PlayerManager.Tick → inbound messages → action queue → delay manager → UpdateGameWorld (rate-limited to 60 Hz) → session work (outbound) → perf monitor. Sleeps 1 ms only when no game update ran | `S/Managers/WorldManager.cs:363-402,317` |
| UpdateGameWorld | [fork] VehicleManager + VehicleBailout → LandblockManager.Tick → HouseManager (1/min) | `WorldManager.cs:412-439` |
| LandblockManager.Tick | TickPhysics (parallel across groups) → TickMultiThreadedWork (parallel) → **TickSingleThreadedWork (serial)** → unloads | `S/Managers/LandblockManager.cs:268-291` |
| Serial section | Every `Player_Tick` (which runs the player's action queue: attacks, casts, inventory), every heartbeat (5 s), relocations and the loads they cause, unloads | `LandblockManager.cs:439-448`, `S/Entity/Landblock.cs:821-881` |
| Parallelism | `max(1, cores × 0.34)` threads for landblock groups **and** outbound network; 1 on the laptop. Parallel ticking also needs `MultiThreadedLandblockGroupPhysicsTicking` / `…GroupTicking`: false in code, true in the shipped config | `ACE.Common/ThreadConfiguration.cs:13,39-42,68-70`; live `Config.js:15-16` |
| Landblock groups | Chebyshev distance < 4 (< 3 dormant) merges; split only after an unload, at most every 5 min. Dense areas chain into one group, i.e. one thread | `S/Entity/LandblockGroup.cs:36-44,270-291` |
| Locks | `landblockLock` (upgradeable read on every vanilla cell lookup); **one static lock for all `ObjectMaint` instances**; DAT stream mutex on uncached reads | `LandblockManager.cs:31`, `S/Physics/Common/ObjectMaint.cs:23`, `ACE.DatLoader/DatDatabase.cs:24` |
| Delays | Every ActionChain delay goes to one global SortedSet processed on the world thread | `S/Entity/Actions/DelayManager.cs` |
| Shard DB | One serialized worker thread; batch saves run `Parallel.ForEach` inside one queued task | `ACE.Database/SerializedShardDatabase.cs:24-77` |
| Sessions | Fixed array of `MaximumAllowedSessions` (128 live), scanned every loop; no login throttle | `S/Network/Managers/NetworkManager.cs:37,359-373` |
| Crowd valve | **None.** Retail's portal-storm events exist as messages (`GameEventPortalStorm*`, 0x02C9–0x02CC) but are sent only by a developer command | `S/Command/Handlers/DeveloperCommands.cs:3930-3944` |
| Monitoring | `ServerPerformanceMonitor` (off by default); the fork's `WorldTickMonitor` (only while a vehicle exists) | `S/Managers/ServerPerformanceMonitor.cs`, `S/Vehicles/WorldTickMonitor.cs` |

What the vehicle fork already proved can be fixed: wake-on-entry, off-thread loading with `FastLookup` / `Initializing`,
spawn-cache and GfxObj warm-ups, the 8 ms bring-up budget, loot deferral, dungeon deferral, shared cell structs, and GC
budget caps (vehicles DESIGN decisions 26–37, 45–48, 71, 73). Today they apply **only to vehicle-loaded landblocks**.

## 3. Hardening items

Each item: problem → evidence → change → how it is tested. All go behind server properties, default off until
measured, then default on (the project's "validated gates ship default-on" rule).

### Landblocks
- **H1 Off-thread loading for everyone.**
  - Problem: player-triggered loads (teleports, relocation into an unloaded 3×3, the lifestone after a death) are
    synchronous on the world thread.
  - Evidence: 330 ms and 694 ms loads inside position updates (DESIGN decisions in §1 and 33).
  - Change: generalize `vehicle_preload_offthread` (background `GetLandblock`, `FastLookup`, `Initializing`, deferred
    write locks) to every load. Add **predictive preloading** for players from heading and speed, and for teleports
    from the destination known before the portal-space transition.
  - Test: zero world-loop iterations over 50 ms caused by loads in a 500-bot teleport storm.
- **H2 Bring-up budget for every landblock.**
  - Change: generalize `vehicle_landblock_budget` (8 ms per tick shared; generator power-ups that yield) and the
    spawn-cache warm-up (weenies, create lists, treasure tables, Setups and GfxObjs off-thread) to all landblocks.
  - Test: the cold-spawn stall histogram.
- **H3 Lazy loot.**
  - Problem: loot generation costs 0.3–2 s per chest under load, one roll 954 ms (decision 34).
  - Change: roll chest and corpse contents **when first opened**, not when spawned. The result is identical for the
    player and costs nothing for chests nobody opens. Retail-visible behaviour is unchanged (contents are only seen
    on open).
- **H4 Adjacency only for observers.**
  - Problem: every relocated mover loads its 3×3, monsters included. The load is **hard-coded** inside
    `RelocateObjectForPhysics`: `GetLandblock(worldObject.Location.LandblockId, true)`
    (`S/Managers/LandblockManager.cs:467`). The `true` passed by `Monster_Navigation.cs:299` is a different flag
    (`adjacencyMove`).
  - Change: `RelocateObjectForPhysics` loads adjacents only for players and vehicles, which need the 3×3 for
    visibility.
  - Remaining: physics still loads **single** landblocks on demand at edges (`S/Physics/Common/LScape.cs:61`,
    `get_landcell`). Those are cheap and correct, and stay.
- **H5 Adaptive retention.**
  - Change: replace the flat 5 minutes with a policy:
    - visited on foot: 5 min;
    - transit-only: 60 s (the fork's short retention);
    - under memory pressure: LRU on dormant landblocks against a resident budget ([02 §6.1](02-scale-model-and-budgets.md):
      ≤ 10,000).
- **H6 Wake-on-entry default on** (`landblock_wake_on_entry`). It fixes the frozen-position-on-revisit class of bug
  for every fast mover (carry experiment obstacle 1).

### Visibility and broadcast
- **H7 Replace the global `ObjectMaint` lock.**
  - Problem: one static ReaderWriterLockSlim serializes all visibility work across landblock threads. Rescans use
    LINQ allocations.
  - Change: per-group ownership (an object's tables are touched only by its group's thread), with cross-group
    changes posted to the owner. Allocation-free rescans (reused buffers; the fork already does this for vehicles).
- **H8 Broadcast economy (relevance and rate).**
  - Problem: every AutonomousPosition is re-broadcast to every known player. Browser clients send ~7/s while running
    (vs retail ~1/s), and chasing monsters broadcast at 5 Hz, with no distance-based reduction.
  - Change, in three parts:
    - (a) **Rate-limit re-broadcast per observer**: the mover's own echo is unchanged; observers get position updates
      at a rate that falls with distance (e.g. 5 Hz < 20 m, 2 Hz < 60 m, 1 Hz beyond), plus immediately on motion
      change. That is a priority-accumulator scheme in the style of modern replication systems.
    - (b) **Build once, reference many**: one serialized buffer per message with per-session headers; today the bytes
      are copied per recipient.
    - (c) Pooled writers instead of a `MemoryStream` per message and a `byte[]` per fragment.
  - Retail clients dead-reckon from velocity in UpdatePosition, so a lower observer rate is visually tolerable. That
    is VERIFY-on-retail.
- **H9 Session scaling.** Raise `MaximumAllowedSessions`, make `Find` and the per-loop slot walk O(active), and add a
  login rate limiter.
- **H10 Outbound off the world thread.** Dedicated send threads draining per-session queues. The world thread only
  enqueues.

### Data and memory
- **H11 Shard DB group commit.**
  - Problem: one serialized DB thread with per-object `SaveChanges`.
  - Change: a batched writer (many biotas per transaction, N parallel connections partitioned by biota id) with a
    bounded queue and back-pressure metrics. Measure first: at 1,000 players there are 3.3 player saves per second
    plus landblock saves ([02 §3.2](02-scale-model-and-budgets.md)).
- **H12 GC.**
  - Keep the fork's budget caps (`DOTNET_GCGen0MaxBudget`, `DOTNET_GCGen1MaxBudget` = 16 MB per heap).
  - Evaluate server GC vs DATAS on server hardware.
  - Cut hot-path allocations (H8c, the H7 rescans).
  - Moving the overlay out of ACE ([04 §6](04-target-architecture.md)) is itself a GC measure.
  - Target: p99 pause ≤ 50 ms.

### Crowds and fairness
- **H13 Crowd valves** (§6): load shedding per landblock group, then retail-style **portal storms** for the overflow.
- **H14 On-foot movement envelope.**
  - Problem: ACE accepts any step under ~1 landblock at any speed (carry experiment).
  - Change: the vehicles design's §4.9 speed envelope, plus **collision-aware validation against overlay solids**,
    so that walls hold against modified clients ([14 §3](14-security-integrity-griefing.md)).
- **H15 Dense-group parallelism.**
  - Problem: a busy town chains its landblocks into one group, i.e. one thread.
  - Change: subsumed by H17.
- **H17 Phase-coloured landblock scheduling** (the biggest structural item for 1,000 players).
  - Problem: groups merge **transitively** when landblocks are within Chebyshev distance < 4 (< 3 dormant)
    (`S/Entity/LandblockGroup.cs:36-38,270-291`), and split at most every 5 minutes. That is percolation.
    `tools/group_percolation.py` places N loaded landblocks over the 38,689 land landblocks:
    - uniformly, the largest group holds 17 % of loaded landblocks at 3,000, **63 % at 4,000, 87 % at 5,000** and
      90 % at 8,700;
    - clustered around 40 hubs, 30–36 %.
    [02 §4](02-scale-model-and-budgets.md) projects 5,000–8,700 resident landblocks at 1,000 players. Retention
    trails and flight corridors act as bridges between groups. So ACE's physics, monster AI and generators would run
    on **one or two threads**, whatever the core count. The claim that ACE "scales with spread" holds only below the
    threshold.
  - Change: replace connected-component grouping with **spatial phase colouring**.
    - Colour each landblock by (x mod 4, y mod 4): 16 colours.
    - Each tick runs 16 phases. In each, all **active** landblocks of one colour tick in parallel. Same-coloured
      landblocks are always ≥ 4 apart, the separation ACE's grouping exists to guarantee.
    - Cross-landblock relocations stay deferred to after each phase, as ACE already defers them after `TickPhysics`.
  - Cost: 16 barriers per tick (~960/s at 60 Hz). Parallelism then scales with the number of active landblocks per
    colour, not with how the world happens to connect.
  - Balance: a phase lasts as long as its slowest landblock. Heavy hubs land in different colours, so the expected
    tick is about Σ over phases of the slowest landblock, not Σ over all landblocks.
  - Test:
    1. P0.4 measures group sizes on the live server and the bot fleet.
    2. Then an A/B of grouping against colouring under a 1,000-bot soak.
- **H18 Heartbeats off the serial section.**
  - Problem: every object's 5 s heartbeat runs in `TickSingleThreadedWork`, including those in dormant landblocks.
    At 5,000–8,700 resident landblocks with tens of objects each, that is tens of thousands of serial heartbeats per
    second.
  - Change: split heartbeats into **landblock-local** work (vitals, enchantments, emotes, decay), which runs in the
    H17 phases, and **global-touching** work (allegiance, fellowship, housing, saves), which stays serial. ACE's
    config already warns that world-object ticking "interacts with server global constructs like Allegiances,
    Fellowships, Housing" (`Config.js.example:77`).

### Operations
- **H16 Always-on telemetry.**
  - Generalize `WorldTickMonitor` from "while a vehicle exists" to always-on, with per-phase histograms. Add top-N
    landblocks by tick cost, GC events, DB queue depth, broadcast bytes per second, and loads per second.
  - Export it in Prometheus format ([§8](#8-insight-plane)).

## 4. The trifecta adapter: hooks needed in ACE

The adapter is a thin in-process module ([04 §7](04-target-architecture.md)). The ACE changes it requires:

### 4.1 Lifecycle and presence
- Events on landblock load, active, dormant and unload, plus player and vehicle presence counts, sent to the WSS.
- The existing state machine (`Landblock.cs:694-739`) is the source; no new timers.

### 4.2 Materialization
- Apply materialization packets within the bring-up budget (H2): create `StructurePiece`s and ecology creatures, and
  attach raid behaviour.
- Remove objects on dematerialization and report final state.

### 4.3 `StructurePiece` (immobile creature)
- A `Creature` subclass built in memory from the catalog: `AiImmobile`, `NoCorpse`, never persisted by ACE (the
  vehicle precedent: in-memory weenie, `IsDynamicThatShouldPersistToShard` → false).
- Melee requires a `Creature` target (`S/WorldObjects/Player_Melee.cs:112-117`) and damage paths are creature-based
  (`Creature_Combat.cs:1046-1077`), so the creature route reuses all of combat.
- Faction banners already use a PK-only creature pattern (`Creature_Combat.cs:1062`, `Player_Combat.cs:1209-1213`).
- Pass 2 must check:
  - (a) health bar and name on select (acceptable look? Q04.4);
  - (b) XP and loot must not be awarded for killing walls;
  - (c) that ACE's monster-awareness code ignores pieces as threats but can target them in siege mode;
  - (d) turret attack AI with `AiImmobile`: **verified 2026-11-03** to exist as monster behaviour. Immobile
    monsters turn to face their target for ranged and magic attacks (`S/WorldObjects/Monster_Navigation.cs:89,413`),
    never stick to a melee target (`Monster_Melee.cs:70,373`), and drop melee targets out of reach
    (`Monster_Navigation.cs:146-151`). Ranged and magic turrets are configuration, not new AI. Remaining: target
    selection rules for turrets (hostile species and PvP-eligible players only);
  - (e) `CheckMonsters` and alerting cost with many pieces.
- **Per-object costs a plain `Creature` would bring** (verified 2026-11-03). They must be opted out, because a
  landblock may hold 1,000 pieces:
  - every non-player creature joins the landblock's monster-tick list, so it gets 5 Hz `Monster_Tick`
    (`S/Entity/Landblock.cs:908-916`);
  - every object joins the 5 s heartbeat list, which runs in the **serial** section;
  - `IsMonster = Attackable || TargetingTactic != None` (`S/WorldObjects/Monster.cs:47`), so an attackable piece
    counts as a monster for awareness, and a piece with a faction scans for targets;
  - the fork's pilot sight treats **every creature as a landmark** (`ObjectMaint.IsSightLandmark`,
    `S/Physics/Common/ObjectMaint.cs:464-468`), so pieces would be sent at long range.
  - `StructurePiece` therefore overrides each one:
    - kept off the monster-tick list (turrets excepted);
    - no 5 s heartbeat (state lives in the WSS);
    - `IsMonster = false` while still damageable;
    - not a sight landmark;
    - no faction scan.
  - Test: a **1,000-piece serial-cost bench** belongs to P2.3. If the overrides grow too invasive, the fallback is a
    non-creature class with its own damage entry points (Q04.4).

### 4.4 Siege behaviour
ACE monsters move in straight lines, have no pathfinding, give up when blocked after 2–4 s, and see players through
walls (survey: `MoveToManager.cs:456-460`, `Monster_Navigation.cs:99,251-252`; line of sight checked only before
projectile spells). Raid monsters therefore need a new behaviour:
- follow **route hints** (flow-field waypoints from the WSS, [08 §7](08-monster-ecology.md));
- when blocked, **attack the blocking piece** instead of giving up;
- prefer the raid's target class;
- no leash home while raiding (`MaxChaseRange` 96 m and `HomeRadius` 192 m are overridden for raiders).

### 4.5 Ecology creatures
- A dynamic generator variant whose spawns are counted against the WSS population and reported on death and on
  dematerialization.
- Classic generators are untouched (P1).

### 4.6 Transactions and interaction
- Two-phase item consumption and creation for placement and machine I/O ([04 §4.3](04-target-architecture.md)).
- `Use` on a `StructurePiece` is forwarded to the WSS.

### 4.7 Session binding and gating
- Extend the capability handshake beyond the HBV1 bits (`S/Vehicles/VehicleWire.cs:35-37`) with world, factory and
  ecology bits.
- Give the gateway a session token for the overlay streams.
- In `ObjectMaint`, gate structure-piece CreateObjects to sessions without the world bit ([11 §5](11-network-and-interest-management.md)).

### 4.8 Ordnance export
Bomb and rocket impacts in non-materialized zones are sent to the WSS ([04 §4.5](04-target-architecture.md)).

### 4.9 Protected-zone enforcement in ACE
No placement in sanctuaries, no ecology spawn orders inside them. The WSS checks too; this is belt and braces.

## 5. The vehicle plane at scale (with [09](09-vehicles-airpower-ordnance.md))
- `VehicleManager` runs on the world thread at 30 Hz with input-driven stepping (decision 15). Per-vehicle cost is
  microseconds. Its **landblock streaming** is the scale problem ([02 §4.1](02-scale-model-and-budgets.md)).
- **Airspace transit** ([09 §4.1](09-vehicles-airpower-ordnance.md)). ACE has no off-landblock state for an online
  player: portal space keeps the player in the destination landblock, hidden and non-colliding
  (`S/WorldObjects/Player_Location.cs:682-768`). Transit is therefore an **anchor**:
  - above the high band the pilot and the vehicle stay members of the landblock where transit began (kept alive);
  - `RelocateObjectForPhysics` is suspended for them, so no crossing loads a 3×3;
  - the pilot's ObjectMaint admits no ground objects;
  - descending re-enters through the teleport-arrival path without the client's portal-space message, with the
    destination preloaded by H1.
  The fork's open item "relocation without adjacents for a pilot above the band" (HIGH-BAND §5) is the first step.
  - **VERIFY** (spike): which systems read `CurrentLandblock` instead of `Location` for a player (broadcast and
    known sets, local chat, fog and weather, housing checks, `@`-commands).
- Move vehicle simulation to its own thread with a mailbox to the world thread once vehicles number in the dozens.
  The world thread then only applies seat placement and combat effects.

## 6. The load governor (loop B7 of [03](03-systems-dynamics.md))

Per landblock group, measure tick cost over a sliding window against its budget share. Global measures: world-loop
p99, GC, memory.

| Step | Trigger (engage / release) | Action | Visible to players |
|---|---|---|---|
| 0 | — | Normal | — |
| 1 | group cost > 70 % / < 50 % of budget | Observer position rates drop one tier (H8a); ecology materialization radius shrinks | No |
| 2 | > 85 % / < 65 % | Raids in the group shift strength to abstract resolution (fewer, stronger materialized raiders); new ecology spawns paused; monster AI 5 → 2.5 Hz for creatures without a target | Slightly |
| 3 | > 100 % for 10 s / < 75 % for 60 s | **Portal storm brewing** for the densest landblock: retail's own client messages (0x02C9 Brewing, 0x02CA Imminent) give the warning | Yes: retail UI |
| 4 | > 120 % for 20 s | **Portal storm**: a share of non-combat players in that landblock is teleported to their lifestone or a nearby safe point, until under budget; then **Subsided** (0x02CC) | Yes |
| (research) | — | **Time dilation** per group, the EVE Online model: scale the group's simulation clock instead of shedding. ACE uses wall-clock timers widely (unix time, PortalYearTicks), so this is a research item, not v1 | — |

Rules: minimum dwell time per step (30 s); no step 4 within 10 minutes of the last for the same landblock; every
action logged and counted ([§8](#8-insight-plane)); players in an active PvP siege are exempt from step 4 (fairness).
That last rule needs owner policy (Q10.2).

## 7. Deployment (shape A)

- **Box**: the reference in [02 §6](02-scale-model-and-budgets.md) (32 cores, 128 GB, NVMe).
- **Processes**: ACE, WSS, gateway, MySQL, Postgres. Pin the ACE world thread to a dedicated core. Landblock and
  network threads are `0.5 × cores`. The WSS and the databases run on separate core sets (cgroups / cpusets).
- **ACE config**: `WorldThreadCountMultiplier` 0.5, `MaximumAllowedSessions` 1,500, GC environment as in
  `run-ace-live.sh` (re-tuned on the box), `WorldDatabasePrecaching` on (~1.7 GB, 1–2 min at start;
  `Config.js.example:90-96`).
- **Restarts**: ACE ~24 s to "World is now open" (memory `ace-live.md`). The WSS restarts independently; the gateway
  holds browser connections through an ACE restart where possible (Q10.3).
- **Fork discipline**: as the vehicles fork does:
  - every change behind a server property, default off;
  - a patch series regenerated against upstream (`git am` on `a8ff29f` reproduces the branch);
  - ACE built to a separate output directory, swapping only `ACE.Server.dll` on restart;
  - tests in Debug.

## 8. Insight plane

- **Metrics**: Prometheus exporters in ACE, the WSS and the gateway.
- **Dashboards**:
  - world loop per phase;
  - landblocks (resident, loads/s, bring-up ms, top-N tick cost);
  - sessions and bytes/s;
  - GC;
  - DB queue;
  - governor steps;
  - per-vehicle costs (`@vehicles` today);
  - ecology loops ([03 §10](03-systems-dynamics.md)).
- **Logs**: keep the fork's tagged lines (`[VEHICLE][WORLDSTALL]`, `[HEAVYADD]`, `[LOAD]`) and add `[TRIFECTA]` tags
  for adapter events.
- **Load testing**: a headless bot fleet (Rust protocol sessions, no rendering) with scripted behaviours: town idle,
  hunting, teleport storm, siege crowd, flight corridors. Run against shape A before every scale gate
  ([16](16-roadmap.md)).

## 9. Decisions proposed
- **D10.1** ACE remains the character plane. Hardening H1–H18 is prioritized by Phase 0 measurements.
- **D10.2** The vehicle fork's landblock machinery (off-thread load, budget, warm-ups, short retention) becomes
  general infrastructure.
- **D10.3** Lazy loot (roll on first open).
- **D10.4** Monsters and NPCs stop loading 3×3 adjacents.
- **D10.5** Observer position re-broadcast becomes distance- and change-driven.
- **D10.6** The load governor, with retail portal storms as the final crowd valve.
- **D10.7** = D09.2 (airspace transit), restated for the server plane.
- **D10.8** Landblocks tick in 16 spatial colour phases (H17) instead of connected-component groups.
- **D10.9** Heartbeats split into landblock-local (parallel) and global (serial) parts (H18).
- **D10.10** `StructurePiece` opts out of monster ticks, heartbeats, monster status, landmark sight and faction
  scans, with a 1,000-piece serial-cost bench as its gate.

## 10. Open questions
- **Q10.1** Is a server-class box available for Phase 0? Without one, the 1,000-player claim stays a derivation.
- **Q10.2** Portal storms during PvP sieges: exempt, or cap siege participation instead?
- **Q10.3** Can the gateway keep browser sessions alive across an ACE restart, re-handshaking transparently? The AC
  protocol's session state (ISAAC, sequences) lives in ACE, so probably not without a protocol-level resume.
- **Q10.4** Time dilation: worth a research spike, or do shedding and portal storms suffice?
