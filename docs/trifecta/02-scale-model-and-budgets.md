# 02 — Scale model and budgets

Status: **draft v0.1** (2026-11-03). Numbers are first estimates. Every one is either **measured** (with its source),
**counted** (from data, method given) or **derived** (formula given). The derived ones are what Phase 0
([16](16-roadmap.md)) must replace with measurements.
Depends on: [01 audit](01-technology-audit.md).
Feeds: [04](04-target-architecture.md), [09](09-vehicles-airpower-ordnance.md), [10](10-server-runtime-and-scaling.md), [11](11-network-and-interest-management.md).

## 1. Purpose

The expansion is asked to support **1,000+ concurrent players** with vehicles, factories and a living ecology on top of
the classic game. This document turns that ask into numbers:
- what the world contains;
- what each unit of activity costs today;
- what 1,000 players cost under the current architecture;
- what the naive "keep factory landblocks loaded" approach would cost;
- the budgets the target architecture must stay within.

## 2. The world, counted

Counted 2026-11-03 from the baked whole-map grids (`dist/world/world_types.u8` and `world_height.u8`: 2041 × 2041
vertices, 24 m apart, base DATs only), the baked spawn files (`dist/spawns/*.jsonl` = ACE `landblock_instance` rows)
and the world-database release (`ace_world_release/ACE-World-Database-v0.9.292.sql`, table `encounter`).
**Reproduce** with `python3 -I docs/trifecta/tools/world_counts.py` from the repository root; re-run after any DAT or
world-DB change. Definitions are in the script's header.

| Quantity | Value | Note |
|---|---|---|
| Landblocks (192 m) | 65,025 (255 × 255) | Landblock 0xFF does not exist (vehicles DESIGN decision 59) |
| All-land / coastal / all-water landblocks | 32,665 / 6,024 / 26,336 | Water = terrain types 16–20 or no CellLandblock record |
| Land area | ~1,304 km² | 2,263,576 land cells of 24 m (54.4 % of all cells) |
| Flat land (≤ 4 m relief per 24 m cell) | 973,023 cells = 43 % of land (~560 km²) | Buildable without foundations |
| Road-touching land cells | 18,540 (0.8 %) | Roads are thin; keep them clear ([06 §3](06-dynamic-world.md)) |
| Landblocks with tall trees | 30,443 (1.49 M trees) | `world_trees.u8` (far-forest census) |
| Baked spawns (all) | 722,176 rows | 384,825 outdoor (cell index < 0x100), 337,351 indoor (46.7 %). Outdoor rows are dominated by region-encounter generators and the creatures they place |
| Landblocks with **authored** outdoor content | **1,657** | Portals, vendors, doors, lifestones, housing (slumlords). **646 towns** (a vendor, a lifestone or ≥ 6 doors); 593 housing settlements |
| Region encounter generators | 165,465 in 35,634 landblocks | Median **4** per landblock (p90 8, max 37), 212 distinct generator weenies |

**Reading:**
- Almost every land landblock spawns monsters when it loads (encounters).
- Only ~4 % of land landblocks (1,657 of 38,689) hold authored outdoor content.
- The frontier is ~1,300 km² minus protected zones ([06 §3](06-dynamic-world.md)).
- At a 48 × 48 m starter plot that is >500,000 plots: land is not scarce for 1,000 concurrent players. Scarcity
  arises from **resources and safety**, which is where the design wants it ([03 §6](03-systems-dynamics.md)).

## 3. Unit costs today (ACE fork + holtburger-web)

### 3.1 Server: landblocks
| Cost | Value | Source |
|---|---|---|
| Memory per loaded landblock | 0.6–1.5 MB | carry experiment: RSS 526 → 1,171 MB over ~70 km of flight |
| Load (constructor + physics init), warm | ~0.5–3 ms | fork logs (`ACE_Log.txt`) |
| Load, cold (first time in a process) | 74–870 ms; the first-ever load ~1 s | fork logs |
| Object bring-up, cold vs warm | 11–40 ms vs 0.01–0.1 ms per object | vehicles DESIGN decision 32 |
| First physics init of a model | 45–106 ms | decision 48 |
| A 434-object landblock's bring-up | one 220 ms tick | `Entity/Landblock.cs:296` comment |
| Loot generation (chests) | 0.3–2 s per chest, one 954 ms roll | decision 34 |
| Retention | dormant after 1 min idle, unloaded after 5 min | `Landblock.cs:136,141` |
| Adjacency | **every** moving object relocated into a landblock loads its 3×3 (monsters included) | `LandblockManager.cs:467`, `Monster_Navigation.cs:299` |
| Dormant landblocks still run | generators, heartbeats (5 s), decay, DB save (5 min); dormancy only stops physics and monster AI | `Landblock.cs:531,601,624-689` |

### 3.2 Server: players, monsters, world thread
| Cost | Value | Source |
|---|---|---|
| World loop | One thread; game tick rate-limited to 60 Hz; inbound and outbound at ~1 kHz loop rate | `WorldManager.cs:317,363-400` |
| Parallel landblock work | `max(1, cores × 0.34)` threads (1 on the 4-vCPU laptop; ~21 on 64 vCPUs) | `ACE.Common/ThreadConfiguration.cs:13,39-42` |
| **Serial no matter what** | Every `Player_Tick` (including each player's queued actions: combat, spells, inventory), every heartbeat, inbound dispatch, delays, relocations (and the loads they trigger), unloads | `LandblockManager.cs:439-448`, `Landblock.cs:821-881` |
| Monster AI | 5 Hz per awake creature; chasing monsters broadcast UpdatePosition at 5 Hz | `Monster_Tick.cs:10`, `Monster_Navigation.cs:239-263` |
| Visibility | Re-evaluated on each 24 m cell crossing: a 3×3 rescan with LINQ, under **one global static lock** | `PhysicsObj.cs:2741-2786`, `ObjectMaint.cs:23` |
| Broadcast | O(N²) for co-located players; every AutonomousPosition is re-broadcast | `Player_Tick.cs:513-516` |
| Session cap | `MaximumAllowedSessions` = 128 (array-sized; configurable) | live `Config.js:5` |
| Shard DB | One serialized worker thread; EAV schema (one row per property, 25 property tables); per-object `SaveChanges` | `SerializedShardDatabase.cs:24-77` |
| Player saves | Every 300 s → 3.3 saves/s at 1,000 players, plus each loaded landblock's 5-min save | `PropertyManager.cs:639` |
| GC | ACE default: up to a 705 ms blocking gen2; tuned (gen0/gen1 16 MB caps): 51–152 ms, ~1 per 100 s of fast flight | decisions 37, 71, 73 |

### 3.3 Network
| Cost | Value | Source |
|---|---|---|
| Datagram | ≤ 484 B (20 B header + 464 B body); 16 B per message fragment | `ServerPacket.cs:11`, `PacketFragmentHeader.cs:11` |
| UpdatePosition / UpdateMotion | 44–68 B / 32–88 B | `PositionPack.cs`, `MovementData.cs` |
| CreateObject | ~150–250 B (item, door), ~250–400 B (monster), ~500–900 B (clothed player) | estimate from `WorldObject_Networking.cs` |
| AutonomousPosition rate | retail ~1/s; **holtburger-web every 2.5 m** of travel (≤ 10/s; ~7/s at 18 m/s) | `GameActionAutonomousPosition.cs:10`, `holtburger-core movement/system.rs:549` |
| Per player, idle / active (measured, few players) | ~0.14 / ~0.74 kB/s down | bridge link summaries (`wsbridge_console.log`) |
| Per player, busy town of 50 (derived) | ~7.6 kB/s (retail cadence) – ~14 kB/s (browser cadence) down | formulas in the network survey: town egress ≈ N(N−1)·f·a·w |
| Vehicle pilot (measured; session attributed to a pilot) | 2.75 kB/s up / 3.4 kB/s down | bridge log 2026-11-02 |

### 3.4 Client (1070)
| Cost | Value | Source |
|---|---|---|
| Main thread | ~20–23 ms/frame, ~98 % busy | `D/2026-10-26-rust-scene-core.md`, flight HANDOFF |
| Per draw (JS) | ~13 µs | `D/HANDOFF-round3-final-2026-10-31.md` |
| Humanoid rig | ~34–40 draws | `D/2026-10-26-rust-rig.md` |
| Spawn latency after login / teleport | p50 3.3 s, p90 15.5 s | vehicles DESIGN decision 53 |

## 4. 1,000 players under the current architecture (derived)

**Assumed population mix** (to be replaced with real telemetry):
- 35 % in towns and hubs;
- 30 % in dungeons;
- 20 % hunting in the open world;
- 10 % at frontier build sites;
- 5 % flying.

| Segment | Players | Resident landblocks (derived) | Note |
|---|---|---|---|
| Towns / hubs (~20 hubs) | 350 | ~180–300 | 3×3 per hub plus spill; heavy overlap |
| Dungeons | 300 | ~150–300 | Dungeons have no adjacents; ~1–2 players per dungeon landblock on average |
| Open-world hunting (groups of ~2) | 200 | ~600–1,500 | 3×3 per group plus 5-min retention trails |
| Frontier build sites | 100 | ~300–900 | Today's ACE: the site's 3×3 while someone is there |
| Flying, low band, 250–400 km/h | 50 | **~3,700–5,700** | See §4.1 |
| **Total** | 1,000 | **~5,000–8,700** | 3–13 GB of landblock memory at 0.6–1.5 MB each |

**At this scale ACE's thread grouping collapses.** Landblocks within Chebyshev distance < 4 merge transitively into
one group, which is one thread. With N resident landblocks placed on land (`tools/group_percolation.py`), the
largest group holds:
- uniformly: 17 % at 3,000, 63 % at 4,000, **87 % at 5,000**, 90 % at 8,700;
- clustered around 40 hubs: 30–36 %.

Retention trails and flight corridors bridge groups further. The parallel landblock budget below therefore assumes
the phase-coloured scheduler (H17, [10 §3](10-server-runtime-and-scaling.md)).

### 4.1 The cost of a fast aircraft in the low band
A straight-flying mover crosses a landblock every 192 / v seconds and loads up to 3 new landblocks per crossing (5 on
a diagonal).

    load rate      ≈ 3v / 192                 (landblocks per second)
    resident set   ≈ 3 · v · R / 192 + 9      (R = retention, s)

| Speed | Load rate | Resident, R = 60 s (fork's short retention) | Resident, R = 300 s (vanilla) |
|---|---|---|---|
| Running, 18 m/s | 0.28/s | 26 | 93 |
| Jeep, 28 m/s (100 km/h) | 0.44/s | 35 | 140 |
| Aircraft, 69 m/s (250 km/h) | 1.08/s | 74 | 332 |
| Aircraft, 111 m/s (400 km/h) | 1.73/s | 113 | 529 |

- **50 aircraft at 400 km/h in the low band ⇒ ~87 landblock loads per second.** The vehicle fork's global cap is
  **6 loads/s** (`VehicleStreaming.cs` `GlobalLoadsPerSecond`), which sustains about **3–5** such aircraft over fresh
  ground. The cap holds because back-pressure slows the aircraft. This is the measured "couple of vehicles" scale of
  the demo, and it is the single biggest structural limit for air power at MMO scale.
- Therefore ([09 §4](09-vehicles-airpower-ordnance.md)):
  - **transit happens in the high band and loads nothing** (the "airspace transit" design);
  - the low band is a **combat band**, entered deliberately, with a speed cap set by the load budget;
  - vehicle-only landblocks become **cheap shells**: terrain and statics only, with spawns materialized only for
    combat.

## 5. The naive factory approach, costed (why [04](04-target-architecture.md) decouples)

Suppose factories ran inside ACE and kept their landblocks loaded (Permaload or the KeepAlive weenie, wcid 80007).
A permaloaded landblock never goes dormant: ticked at 60 Hz (objects step physics at 30 Hz), 5 Hz AI, heartbeats and generators forever
(`Landblock.cs:716`).

| Scenario | Pinned landblocks | Memory | Ongoing CPU |
|---|---|---|---|
| 2,000 sites, own landblock only | 2,000 | 1.2–3 GB | ~4.6 encounter generators each → ~10,000+ monsters awake for nobody |
| 2,000 sites, 3×3 (monsters relocating in load adjacents anyway) | ~10,000–18,000 | 6–27 GB | ~50,000–80,000 monsters; generators re-rolling; 5-min saves of every changed object through one DB thread |
| 6,000 sites (30 % of ~20,000 accounts build) | 18,000–54,000 | 11–80 GB | Beyond one ACE process |

And all of that buys a factory simulated at full physics fidelity (60 Hz landblock ticks), which a conveyor does not need.

**Under the target architecture:**
- **Factories cost nothing in ACE.** They run in the WSS's discrete-event simulation ([07](07-factories-and-logistics.md)).
- **Monsters exist in ACE only where observed.** The ecology field is abstract ([08](08-monster-ecology.md)).

## 6. Target budgets (deployment shape A: one server-class box)

Reference box for budgeting: **32 cores / 64 threads, 128 GB RAM, NVMe, 1 Gbit/s+**. The 8 GB laptop is a development
host only (§8).

### 6.1 Character plane (ACE)
| Budget | Target | Why |
|---|---|---|
| World-loop iteration | p99 ≤ 50 ms; no stall > 250 ms | The vehicle work's stall definition (`WorldTickMonitor`, 50 ms) |
| Serial section (players + heartbeats + inbound) | ≤ 8 ms per 60 Hz tick at 1,000 players (≤ 8 µs/player/tick amortized) | Leaves headroom for loads and GC; **must be measured in Phase 0** |
| Parallel landblock threads | 0.5 × cores (the example config's "larger servers" advice), **effective only with H17** | `Config.js.example:60`; §4 |
| Resident landblocks | ≤ 10,000 (≤ 15 GB) | §4 plus margin; vehicles transit in the high band |
| Landblock loads | ≤ 30/s sustained in total, of which ≤ 15/s is the low-band aircraft pool; all off the world thread | Generalized vehicle-fork off-thread loader ([10 §3](10-server-runtime-and-scaling.md), [09 §4.2](09-vehicles-airpower-ordnance.md)) |
| Materialized overlay objects | ≤ 1,000 solid pieces per landblock; ≤ 200 ecology creatures per landblock | Bounded bring-up; [04 §4.2](04-target-architecture.md) |
| Concurrent raids materialized | ≤ 20 server-wide, ≤ 200 raiders each | Load governor ([03 §5.6](03-systems-dynamics.md)) |
| GC | p99 pause ≤ 50 ms | Tuned GC + less allocation ([10 §5](10-server-runtime-and-scaling.md)) |
| Session cap | 1,500 | Configurable today (128 live) |

### 6.2 World-state plane (WSS)
| Item | Sizing (derived) | Budget |
|---|---|---|
| Ecology field | 65,025 zones × ~10 species × ~16 B ≈ 10 MB; one tick (60 s) ≈ 650k zone-species updates | < 1 % of a core |
| Structures (store) | 6,000 sites × 2,000 pieces = 12 M pieces × ~32 B ≈ 400 MB | Hot set in RAM per active region |
| Factory entities | 6,000 sites × 300 machines/belt segments = 1.8 M | Event-driven: ≤ 1 event/entity/min average ⇒ ~30k events/s ⇒ ≤ 2 cores |
| Raid director | ≤ 1,000 planned raids/hour | Negligible |
| Write rate | Event log ~100–1,000 events/s; chunk snapshots debounced (≤ 1 per chunk per 10 s) | NVMe-friendly |

### 6.3 Network (edge plane)
| Item | Budget |
|---|---|
| Average downstream per player | ≤ 6 kB/s (AC protocol) + ≤ 2 kB/s (overlay deltas) |
| Peak (entering a dense base or town) | ≤ 150 KB burst over 2 s (chunk snapshot + CreateObjects) |
| Server egress at 1,000 players | ≈ 8 MB/s average (64 Mbit/s), 3× peak ≈ 200 Mbit/s |
| Packets | ≈ 40–60k packets/s out; the gateway batches per QUIC connection ([11](11-network-and-interest-management.md)) |
| Position re-broadcast | Distance tiers for on-foot players: 5 Hz < 20 m, 2 Hz < 60 m, 1 Hz beyond, immediately on motion change; the sender always gets its echo (H8a) |

### 6.4 Client (1070 baseline)
See [12 §4](12-client-holtburger-web.md): overlay ≤ 150 draws and ≤ 2 ms/frame main thread; raids ≤ 300 draws per
100 monsters (needs cross-rig instancing).

## 7. What must be measured first (Phase 0)

1. The serial world-thread cost per player per tick, and per action, under bots at 100 / 250 / 500 / 1,000 (headless
   protocol bots, not browsers).
2. The O(N²) curve: one town with 50 / 100 / 200 co-located bots, measuring broadcast bytes and world-loop time.
3. Landblock costs on server hardware: warm and cold load, bring-up, memory per landblock, dormant overhead.
4. GC under 1,000-player allocation rates (server GC vs workstation GC vs DATAS; [10 §5](10-server-runtime-and-scaling.md)).
5. Shard DB throughput: saves per second through the single serialized thread at 1,000 players.
6. Gateway throughput: 1,000 concurrent connections, packets per second, CPU.

## 8. Development and test hosts

| Host | Use | Constraint |
|---|---|---|
| Laptop (8 GB, 4 vCPU, HD520) | Development: ACE + WSS + a few bots; no 1,000-player tests | `~/CLAUDE.md`: one heavy job at a time, `capped-build`, ≥ 2.5 GB available first |
| GTX 1070 box (the owner's baseline GPU) | Client look and frame-rate tests; off-screen, batched | Used by a person; never for server load |
| **Server-class box (needed)** | Phase 0 measurements and every scale gate | Not available today: the old build box was deleted (2026-10-05). An owner decision ([17](17-risks-and-open-questions.md) Q17.1) |
| Bot fleet | 1,000 headless protocol bots (the Rust `holtburger-cli` session, no rendering) | Per-bot memory unmeasured (estimate: tens of MB with DAT-backed physics) ⇒ measure in Phase 0 |
