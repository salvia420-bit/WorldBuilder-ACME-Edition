# 01 — Technology audit: what we have, how old it is, what exists now

Status: **draft v0.1** (2026-11-03).
Feeds: [02 scale model](02-scale-model-and-budgets.md), [04 architecture](04-target-architecture.md), [10 server runtime](10-server-runtime-and-scaling.md).
Sources:
- the 2026-11-03 surveys of the ACE fork (`~/ace-server`), holtburger-web and the community archive;
- the retail decomp (`~/ac-headers`);
- the acpedia dump (`external/acpedia`);
- the vehicles and flight-experience docs (`external/holtburger/apps/holtburger-web/docs/`).

Community quotes are attributed by role and date, never by name. `[Q]` marks a quote, `[I]` an inference.

## 1. Summary

| Layer | Era | What it is | Verdict |
|---|---|---|---|
| World model (landblocks, cells, weenies, generators) | **1995–1999** design | Seamless 255 × 255-landblock continent. The landblock is the unit of loading **and** of simulation | **Keep as bedrock**, add a decoupled overlay ([04](04-target-architecture.md)) |
| AC protocol | **1999** | Custom reliable/unreliable UDP, ≤ 484 B datagrams, fragments, ISAAC-keyed checksums, designed for 28.8k modems | **Keep** (compact, sound). Carry it over QUIC datagrams for browsers; add extension families |
| Retail client (acclient) | **1999**, DirectX 6.1, 32-bit | Must keep working (P1) | **Support a safe subset** ([13](13-retail-compatibility.md)) |
| ACE server | **2017–** (C#, now .NET 10, EF Core 9, MySQL) | Faithful re-implementation of retail server logic in one process | **Keep and harden** as the character plane ([10](10-server-runtime-and-scaling.md)) |
| ACE persistence | 2017–2020 design | EAV biota schema, one serialized writer | **Keep for characters**; new store for the overlay ([05](05-world-state-and-persistence.md)) |
| holtburger-web | **2026** | Rust/wasm + three.js WebGL2 browser client, baked content-addressed world | **Keep and extend** ([12](12-client-holtburger-web.md)) |
| Browser transport (wsbridge) | 2026 | WebSocket → UDP relay | **Evolve** into a WebTransport gateway ([11](11-network-and-interest-management.md)) |
| Vehicles fork | **2026-11** | Server-authoritative aircraft, HBV1 protocol, fast-flight streaming | **Generalize** its infrastructure |

The dated part is not the language or the database. It is one **architectural assumption**: *simulated = loaded =
full fidelity*. Retail made that assumption in 1999 and ACE inherited it. Everything else can be hardened or wrapped.

## 2. Retail Asheron's Call (1995–2017): what Turbine built

- **Age**:
  - [Q] "Development of Asheron's Call began in 1995"; "released on November 2, 1999" (acpedia, *Asheron's Call*).
  - Minimum spec: "Pentium 166 MHz", "32 MB of RAM", "28.8 Kbps modem", DirectX 6.1 (acpedia, *Microsoft Games
    Archive/Technical*).
- **A world was a cluster**:
  - The client protocol has server switching: `ServerSwitchType { ssWorldSwitch, ssLogonSwitch }`
    (`acclient.h:4900-4904`), `ClientNet::HandleServerSwitch` (`acclient.c:371557`).
  - [Q] An emulator developer: "retail worlds were 12 (13?) servers iirc", and the servers would "transfer blocks to
    different machines and portal storm users to other blocks on other machines to keep tick times low"
    (#utilitybelt 2022-07-18).
  - [Q] The same developer later: "it ended up being stripes of blocks rather than individual blocks", "ac did load
    balancing less than failover" (#general 2025-07-09).
  - [I] Per-landblock dynamic balancing was the design. In practice, coarse stripes of landblocks per machine.
- **Population**:
  - A 1997 preview promised "supports 3000 players simultaneously".
  - Players reported "populations over 2k on each server" in 2000, and Microsoft's reply did not dispute it (acpedia,
    *Developer Chat 2000/04/12*).
  - [I] Peak ~2,000+ per world, design target 3,000, spread over ~12–13 machines.
- **Load followed active landblocks, not headcount**:
  - [Q] A Turbine developer on Darktide lag: "While regular servers tend to have big clumps of people, DT spreads out,
    keeping more areas of the world loaded at any given time" (*Developer Chat 2001/01/17*).
  - [Q] Two spawn-heavy dungeons were "causing a strain on the entire server farm" (2000/07/18).
- **Crowds were capped by design**:
  - [Q] "50 people in battle is … pretty laggy" (2000/04/12).
  - [Q] "There will always be limits on the size of crowds in AC, given the nature of its technology and the
    Internet" (*Dark Thaw*, 2000/01).
  - [Q] The valve was the **portal storm**: "This area is getting too crowded - a Portal Storm is brewing." / "… is
    imminent" / "The Portal Storm has teleported you away from the crowded area!" (`acclient.c:402296-402357`).
  - Admin opcodes `SetPortalStormThreshold` and `SetPortalStormNumToMove` existed
    (`ACE.Entity/PacketOpCodeNames.cs:560-561`).
  - [I] The in-game wedding handbook's "limit your guest list to 35" implies an outdoor threshold around 35.
  - Storms acted only outdoors, and destinations could be flagged invalid (2000/12 patch notes).
- **Authority**:
  - [Q] An ACE physics developer: "ace runs an exact copy of the acclient physics code on the server same as retail";
    "most mmos … after ac opted to skip doing the deep server-side physics simulation, as it was processor intensive
    and limited scalability" (#general 2024-12-29, 2024-12-21).
  - [I] Retail paid for server physics. Later MMOs avoided it.
- **The world changed through live events**: Shadow Invasion (2000/04), Virindi and Tumerok Invasion (2001/08),
  Renegade Siege (2003/08), Olthoi Invasion (2003/09), Viamontian Invasion (2005/11), the destruction of Arwic
  (acpedia). Those were scripted, monthly changes shipped as patches.

**Takeaway.** Turbine's 1999 design was ahead of its time: one seamless continent, distributed across a server
cluster, with a built-in crowd valve. Its unit of simulation, the fully loaded landblock, is what the expansion has
to move beyond.

## 3. ACE (2017–): the character plane

### 3.1 History
- Development began **2017-03** (changelog `### 2017-03-25`).
- Physics runs on the server "@ 60fps" with the **permaload** system (2018-10-02).
- Landblock **dormancy after 1 min** (2019-04-18).
- Preloaded landblock groups for apartments (2019-04-29).
- **Multithreaded landblock-group ticking** (2019-11-17).
- The changelog stops at 2020-06-04; the code continues.
- This fork targets **.NET 10** with EF Core 9.0.15 and Pomelo MySQL 9.0.0.

### 3.2 Architecture (details in [10 §2](10-server-runtime-and-scaling.md))
- **World loop**: one World Manager thread; game tick rate-limited to 60 Hz; per-object physics at 30 Hz; creature
  AI and physics at 5 Hz; heartbeats every 5 s.
- **Serial section**: every player's tick (including their queued actions), all heartbeats, inbound dispatch,
  relocations and unloads.
- **Parallelism**: landblock groups run in parallel on `max(1, cores × 0.34)` threads, when the multi-threading
  config flags are on. A landblock joins and **transitively merges** every group with a member at Chebyshev distance
  < 4 (< 3 when dormant).
  - So ACE scales with how spread out players are, but **only while the loaded set stays sparse**.
  - A crowded town is one group on one core.
  - Above roughly 3,000–4,000 resident landblocks, groups **percolate** into one ([10 H17](10-server-runtime-and-scaling.md),
    `tools/group_percolation.py`).
- **Landblock lifecycle**:
  - load on proximity, always with the 3×3 neighbours (for monsters too);
  - dormant after 1 min (physics and AI stop; generators, heartbeats and saves continue);
  - unloaded after 5 min, which destroys spawns and re-rolls them on the next load.
- **Interest management**: 112.5 m first sight (2D); objects known across a 576 m square; forgotten silently after
  25 s; every update fanned out to every knower. O(N²) in crowds; one global lock.
- **Persistence**: EAV biota schema; one serialized DB writer; players saved every 300 s.
- **Monsters**: straight-line MoveTo, **no pathfinding**, leashed to home (96 m chase, 192 m home radius), no
  wander, static generator caps. No growth, migration or memory across unloads.
- **Movement authority**: [Q] "there is very little server auth movement stuff in base ace" (#utilitybelt
  2024-01-19). The carry experiment confirmed any step under ~1 landblock is accepted at any speed. [Q] "Coldeve
  attempted location validation and it made the game almost unplayable" (#general 2024-12-21).
- **Crowd valve**: none. Retail's portal-storm messages exist in ACE (`GameEventPortalStorm*`) but only a developer
  command sends them. [Q] An ACE core developer: "Its non existent feature … The missing piece to ps is have a way to
  determine a valid position to portal people to" (#worldbuilder 2025-09-28).

### 3.3 ACE at scale, in practice
- **Largest dated figure**: [Q] a server-list entry for Coldeve, `"software": "ACE"`, `"count": 908` (#general
  2024-12-09), "inflated by bots. there is a 36 account limit" (2025-04-18).
- **Load tests**: [Q] "150+ other load test clients all over dereth" (2020-09-10); "my record, for clients connected
  to a single server, was 1600 … was a local server tho" (#utilitybelt 2021-11-11); "nearing 400 clients" with "ACE
  can support thousands of clients if the sever hardware is adequate" (#general 2025-07-04). No server-side CPU or
  memory figures were published.
- **Memory**: [Q] "a lot of long lived land blocks can eat up mem over time", "64g easily gets filled by 7 days"
  (#worldbuilder 2025-09-28). The carry experiment measured 0.6–1.5 MB per loaded landblock.
- **GC**: [Q] "ace gc has been a notorious sticking point" (#general 2025-05-20). The vehicle fork measured 705 ms
  blocking gen2 pauses under default settings and brought them to 51–152 ms with budget caps.

**Verdict.** ACE's game logic is the irreplaceable asset: ~248k lines of C# encoding retail behaviour, maintained by
a community for years. Its runtime is a 2017–2019 single-process design that has never been shown to carry 1,000
real players. With the hardening in [10](10-server-runtime-and-scaling.md) and the heavy new systems kept out of it,
it is the right foundation for the character plane.

## 4. The retail client today

- **32-bit**: [Q] it can "only consume 2gb, and will crash closer to 1.6-1.8" (#thwarg 2024-02-26). Memory "leak &
  maybe heap fragmentation" grows "depend[ing] on how many corpses you're opening, or new objects you're seeing".
- **Dense towns crash it**: [Q] "too many objects in holtburg, that causes a buffer overflow, if you portal in"
  (#utilitybelt 2022-04-29). A PK server "lower[ed] the outdoor broadcast range to the radar range … reduced the
  crash occurrences" (2024-03-19).
- **Runtime world edits**: [Q] "Assets are only updated on login"; a landblock refresh "just makes everything go
  black" (#worldbuilder 2026-02-14/15).

**Consequence.** Retail clients must receive **fewer, safer** objects in a dynamic world: solid pieces only, inside
radar-scale ranges, never belts or debris ([13](13-retail-compatibility.md)).

## 5. holtburger-web (2026): the modern client

- **Stack**:
  - Rust/wasm (`W/src/lib.rs`, 63,811 lines) for protocol, session, physics, DAT decode and scene kernels;
  - three.js r184 on WebGL2;
  - five workers;
  - a service-worker cache of a content-addressed, baked world (17,682 packs, 301 MB of tile and interior geometry,
    plus an 8.1 MB whole-map world tier).
- **Strengths**:
  - retail-parity motion and physics;
  - GPU instancing for scenery (7k animated slots) and far forests (178k instances);
  - flight to 5 km over a CDLOD world tier;
  - server-authoritative vehicle prediction with 0 corrections over 11 km (vehicles DESIGN decision 15).
- **Limits**:
  - The main thread is bound at ~20–23 ms/frame on the 1070.
  - Entities are ~34–40 draws each with no cross-rig instancing.
  - Spawn latency is p50 3.3 s after login.
  - WebGL2 means no compute shaders or indirect draws.
  - The transport is TCP, with head-of-line stalls on lossy links.

## 6. The vehicles fork (2026-11): what it proved

- A capability-gated extension protocol (HBV1) that retail never sees.
- Server-authoritative simulation with exact client prediction (input-driven stepping).
- Retail representation by a stand-in object (the representation ladder).
- **Off-thread landblock loading**, bring-up budgets, spawn-cache warm-ups, short retention, dungeon deferral, GC
  budget caps.
- A world-tick stall monitor.
- Server weapons through ACE's own combat (bolts, real Lightning Bolt spells, bombs).
- A safe crash story (pilots saved in the sky land on the ground).

Its measured limit is **streaming**: low-altitude fast flight loads 1–2 landblocks per second per aircraft, against a
global cap of 6/s ([02 §4.1](02-scale-model-and-budgets.md)).

## 7. What exists now: modern practice per concern

| Concern | AC retail (1999) | ACE (2017–) | Modern practice (2026) | This expansion |
|---|---|---|---|---|
| World partitioning | Landblock stripes over 12–13 machines, server switch | One process | Functional decomposition into services (universal); spatial partitioning with authority hand-off (EVE's node-per-system cluster; Star Citizen's server meshing, first shipped 2024; SpatialOS-style entity authority) | Functional first (WSS beside ACE); overlay partitioned by region later; ACE stays one process ([04 §10](04-target-architecture.md)) |
| Overload | Portal storms; crowd limits by design | Nothing | Graceful degradation: EVE Online's time dilation; per-region throttling; queues | Load governor + portal storms ([10 §6](10-server-runtime-and-scaling.md)) |
| Simulation fidelity | Loaded = full | Loaded = full | Level-of-detail simulation: X4 Foundations' high/low-attention sectors; Factorio's sleeping entities and belt transport lines (0.16 belt rewrite, FFF #176); closed-form motion | Abstract/materialized fidelities ([04 §3](04-target-architecture.md)) |
| Interest management | Landblock adjacency | 112.5 m radius, uniform rates, O(N²) | Relevance and priority per connection (Unreal Replication Graph / Iris; priority accumulators); per-data-type channels | H8 rate tiers; per-type overlay AOI ([11 §4](11-network-and-interest-management.md)) |
| Transport | Custom UDP (good bones) | Same | QUIC (RFC 9000) and WebTransport (Chrome since 2022) for browsers; datagrams + streams; zstd | Gateway over WebTransport ([11 §3](11-network-and-interest-management.md)) |
| Persistence | Proprietary | EF Core + MySQL EAV, single writer | Event sourcing + snapshots; group commit; point-in-time recovery; chunked blobs | Overlay store ([05](05-world-state-and-persistence.md)) |
| Concurrency | Per-machine loops | World thread + parallel groups + global locks | Data-oriented ECS with job systems; actor/mailbox ownership; GC-free hot paths | WSS in Rust; ACE locks narrowed (H7) |
| AI and movement | Straight-line, leashed | Same | Navmeshes (Recast/Detour); **flow fields** for hordes (Supreme Commander 2); LOD AI | Flow-field route hints for raids ([08 §7](08-monster-ecology.md)) |
| Hostile ecology | Static spawns; live events | Static generators | Systemic pressure: Factorio's pollution-driven biter expansion and attacks; colony and horde games (They Are Billions, Mindustry) | Ecology field model ([08](08-monster-ecology.md)) |
| Player building | Housing on DAT plots, hooks | Same | Upkeep and decay (Rust's tool-cupboard upkeep); reinforcement timers and vulnerability windows (EVE structures; Albion's prime-time territories); logistics-as-gameplay (Foxhole) | Claims, upkeep, offline protection ([06](06-dynamic-world.md)) |
| Movement authority | Server physics (expensive) | Client-trusted | Server-authoritative with client prediction and reconciliation | Vehicles already; on-foot envelope + overlay collision checks (H14) |
| Client rendering | Fixed-function DX6 | — | WebGPU (Chrome since 2023): compute culling, indirect draws; instancing everywhere | WebGL2 instancing now; WebGPU optional later ([12 §7](12-client-holtburger-web.md)) |
| Runtime | C++ | .NET with server GC | .NET 8+ DATAS / tuned GC; Rust for pause-free simulation | ACE tuned (H12); WSS in Rust |
| Operations | Proprietary | Logs, opt-in perf monitor | Metrics, tracing, dashboards, load-test fleets, canaries | Insight plane ([10 §8](10-server-runtime-and-scaling.md)) |

## 8. Conclusions that drive the design

1. **Keep the classic game's engine, change the unit of simulation.** Factories and ecology must not live inside
   loaded landblocks ([04 §1](04-target-architecture.md)).
2. **Concurrency follows spatial spread, up to a point.** Retail knew it (Darktide's load, crowd limits, portal
   storms) and ACE's groups encode it. The expansion should **spread play across the map**, as the factory frontier
   and the ecology fronts naturally do, and cap crowds with retail's own valve.
   But spread also raises the number of resident landblocks, and past ~3,000–4,000 ACE's distance-based groups merge
   into one. **The scheduler must change** (phase colouring, H17) for spread to keep paying.
3. **The 1999 protocol is an asset.** Compact and UDP-native, it carries over QUIC datagrams unchanged. Bulk new data
   travels beside it, not inside it.
4. **The retail client is the fragile participant.** It gets a curated, budgeted subset.
5. **The vehicle fork already holds the patterns**: capability gating, server authority, landblock streaming. They
   are generalized, not reinvented.
6. **Measure before claiming 1,000.** No ACE server has published 1,000 real concurrent players with server metrics.
   Phase 0 is a measurement campaign ([02 §7](02-scale-model-and-budgets.md), [16](16-roadmap.md)).
