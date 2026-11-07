# 04 — Target architecture

Status: **draft v0.1** (2026-11-03).
Depends on: [01 audit](01-technology-audit.md), [02 scale model](02-scale-model-and-budgets.md), [03 systems dynamics](03-systems-dynamics.md).
Feeds: everything from [05](05-world-state-and-persistence.md) onward.

## 1. The core problem, stated plainly

In ACE (and in retail AC before it), **simulated means loaded**. A landblock is the unit of everything: terrain
cells, DAT statics, indoor cells, every spawned monster, every generator, physics, heartbeats and visibility. It is
loaded when a player comes near and kept 5 minutes after they leave ([01 §3](01-technology-audit.md)). Keeping
something "running" in the world therefore means keeping its landblock loaded, which means paying for **everything**
in it: its monsters' physics and AI, its generators, its DAT cells. The vehicles fork measured the cost of a load:
0.6–1.5 MB of server memory per landblock, a 330 ms synchronous load on the world thread before the off-thread
loader, and cold generator spawns that stalled the whole world loop.

A factory layer built that way fails at scale. Thousands of player sites, each pinning a 3×3 of landblocks, would
mean tens of thousands of permanently loaded landblocks. Each would be running monsters and physics that nobody
sees ([02 §5](02-scale-model-and-budgets.md) quantifies this).

**The modern answer is to decouple persistent simulation from loaded landblocks.** The world's new state lives in
compact, authoritative data structures. It is simulated by event-driven and field-based models that need no
landblock, and it is **materialized** into full-fidelity ACE objects only where someone is present to experience it.
This is how large persistent worlds handle scale today:
- X4 Foundations: high-attention vs low-attention sectors.
- Factorio: transport lines and sleeping entities.
- EVE Online: a node per solar system, plus time dilation.
- Large-world MMOs in general: interest management with level-of-detail simulation.

## 2. Planes

The architecture separates five planes. Each owns its state and has its own scaling and failure profile.

| Plane | Owns | Authority | Implementation |
|---|---|---|---|
| **Character plane** | Characters, inventories, items, combat, spells, quests, chat, allegiances, the classic world (DAT + world DB), **materialized** monsters and structures | ACE (fork) | C# / .NET 10, MySQL (unchanged) |
| **World-state plane** (new) | The overlay: claims, structures, machines, logistics, power, resource deposits, ecology fields, nests, raid plans | **World State Service (WSS)** | New service (Rust recommended, §6), its own store ([05](05-world-state-and-persistence.md)) |
| **Vehicle plane** | Vehicles, seats, ordnance in flight, airspace | ACE fork today (`VehicleManager`); its own thread or service at scale ([09](09-vehicles-airpower-ordnance.md)) | C# now |
| **Edge plane** | Client connections, transport, routing, extension-stream fan-out | **Gateway** | Evolution of `holtburger-wsbridge` (Rust), WebTransport + WebSocket ([11](11-network-and-interest-management.md)) |
| **Insight plane** | Metrics, logs, traces, dashboards, the world-model simulator | Ops tooling | [10 §8](10-server-runtime-and-scaling.md), [03 §9](03-systems-dynamics.md) |

```
  Browser (holtburger-web: wasm session + three.js)          Retail client (acclient + optional Chorizite plugin)
      │  WebTransport (QUIC): AC protocol stream + datagrams           │ UDP (AC protocol, unchanged)
      │  + extension streams (HBV vehicles, HBW world, HBF factory)    │
      ▼                                                               │
  ┌────────────────────────────┐                                      │
  │ GATEWAY (edge plane)       │── AC packets (UDP, unchanged) ──────►│
  │ auth binding, routing,     │                                      ▼
  │ AOI fan-out of overlay     │◄──── overlay deltas ────┐   ┌─────────────────────────────────────┐
  └────────────────────────────┘                         │   │ ACE (character plane)                │
                                                         │   │  world loop, landblocks, physics,    │
  ┌──────────────────────────────────────────────┐       │   │  monsters, players, VehicleManager   │
  │ WORLD STATE SERVICE (world-state plane)      │───────┘   │  + TRIFECTA ADAPTER (thin, in-proc): │
  │  structure store · claims · factory DES ·    │◄─────────►│    materialize / dematerialize,      │
  │  logistics · ecology field · raid director · │  internal │    structure objects, damage hooks,  │
  │  AOI publisher · audit log                   │   bus     │    inventory transactions, spawn     │
  └──────────────────────────────────────────────┘           │    orders, permission checks         │
         │ overlay store (Postgres + chunk blobs)            └─────────────────────────────────────┘
         ▼                                                            │ MySQL (world + shard, unchanged)
```

## 3. Two fidelities: abstract and materialized

Every new system runs at one of two fidelities per zone (zone = landblock in v0):

| | **Abstract** (always on) | **Materialized** (only where observed) |
|---|---|---|
| Where | Every zone with overlay state | Zones inside some player's or vehicle's interest radius (ACE has the landblock active) |
| Structures | Records in the WSS store: type, transform, HP, owner | Collidable pieces exist as lightweight ACE objects (§4.2); cosmetic pieces exist only in clients |
| Factories | Discrete-event flow simulation ([07 §4](07-factories-and-logistics.md)) | **Same simulation.** Factories never run in ACE; clients render belts from flow state |
| Monsters (ecology layer) | Population fields P_s(z), nests N_s(z) ([08](08-monster-ecology.md)) | Real ACE creatures drawn from P, via ecology spawn orders |
| Raids | Statistical resolution: raid strength vs defense rating | Real ACE monsters with siege behaviour against real structure objects |
| Cost | ~µs per zone per ecology tick; per *event* for factories | ACE's full per-landblock cost |

Rules:
1. **Single writer.** At any moment exactly one authority owns each piece of mutable state. Example: a structure's
   HP is owned by ACE while its zone is materialized and by the WSS otherwise. Ownership moves with explicit
   hand-off messages (§4.1) carrying a version.
2. **Conservation.** Hand-offs conserve state: monsters drawn and returned, HP, ammo, items. Every hand-off is
   idempotent and versioned ([03 §2](03-systems-dynamics.md) rule 1).
3. **The classic layer is never abstracted.** Classic generator spawns, quests and dungeons stay exactly as ACE runs
   them (P1). Materialization only **adds** objects to a landblock that ACE has loaded for its own reasons.
4. **Materialization never loads a landblock by itself.** It piggybacks on ACE's existing reasons to load (a player,
   a vehicle corridor). Overlay state therefore never pins landblocks, which is the decoupling of §1. A deliberate,
   budgeted exception: a raid in progress against a site whose owner is online but away may request a short
   materialization window. That is a design option, off by default ([08 §8](08-monster-ecology.md)).

## 4. Mechanisms

### 4.1 Materialize / dematerialize
- **Trigger.** ACE's adapter reports landblock lifecycle events (loaded → active → dormant → unloaded) and
  player/vehicle presence per landblock to the WSS. These are hooks on ACE's existing state machine, not new timers.
- **On activation** the WSS answers with a **materialization packet** for that zone:
  - (a) collidable structure pieces to instantiate as ACE objects;
  - (b) ecology spawn orders (species, count, positions near nests or along raid paths, drawn from P);
  - (c) any active raid for which this zone is the arena;
  - (d) the state version.
  The adapter applies it **within a per-tick time budget**, the same mechanism as the vehicle fork's landblock
  budget (8 ms per world tick, `vehicle_landblock_budget`).
- **While materialized**, ACE is authoritative for HP of materialized pieces and for the ecology creatures it
  spawned. The adapter streams **write-behind deltas** to the WSS: damage, destruction, kills, interactions. A crash
  then loses at most the last few seconds.
- **On dormancy / unload** the adapter sends a **dematerialization report**: final HP per piece, survivors per species
  (returned to P), resources consumed. The WSS takes ownership back. Then the adapter removes its objects.
- **Hysteresis**: zones flicker as players move along landblock edges. Dematerialization waits for ACE's own dormancy
  (1 min idle) rather than the first moment of absence.
- **Vehicle-only landblocks** (loaded only because an aircraft is near; the fork's `VehicleOnly` flag) materialize
  **partially**:
  - overlay solids and nests within ~200 m of the flight path while the aircraft is below the band floor, so they are
    collidable, targetable and visible;
  - ecology spawn orders only when an aircraft engages there (fires, bombs) or lands;
  - nothing at all for aircraft in high-band transit ([09 §4.2](09-vehicles-airpower-ordnance.md)).
- **Single-landblock edge loads** by physics (`LScape.get_landcell`) carry no materialization of their own. A
  landblock materializes only when it becomes **active** for a player or a vehicle.

### 4.2 Structures inside ACE: lightweight, catalog-built, never persisted by ACE
- Collidable pieces (walls, gates, towers, machines with a Use, turrets, nests) are ACE objects built **in memory**
  from a catalog. This follows the precedent of the vehicle: "a Generic weenie built in memory (custom wcid
  4,000,001, never in the world DB) … never persisted (`IsDynamicThatShouldPersistToShard` → false)" (vehicles
  DESIGN decision 9). ACE persists none of them; the WSS persists everything.
- **Looks and collision come from the base DATs.** Each catalog entry names a retail Setup or GfxObj that exists in
  the base DATs: palisades, stone walls, gates, towers, tents, crates, forges and similar. ACE's physics (Setup and
  GfxObj BSPs) and **retail clients** therefore both see and collide with the same shape, with no client patch. This
  extends vehicles DESIGN §5.1 rule 2 ("looks are data built from retail assets") from vehicles to the whole overlay.
- **Damageable as creatures.** Pieces that can be attacked are realized as an immobile `Creature` subclass
  (`StructurePiece`). ACE's whole combat stack then works unchanged: melee, missile, war magic, the vehicles' bolts
  and bombs, resistances, death → destruction, and retail clients' health bars and damage text.
  - **Turrets** are the same class with attack AI and no movement. ACE's immobile-monster behaviour already exists
    (verified); it reaches ≤ 75 m. Long-range turrets use custom weapon code ([07 §6](07-factories-and-logistics.md)).
  - **A plain `Creature` is too expensive at 1,000 per landblock.** It brings a 5 Hz monster tick, a serial 5 s
    heartbeat, monster status, landmark sight and faction scans, so `StructurePiece` opts out of each (verified hooks
    and the bench in [10 §4.3](10-server-runtime-and-scaling.md)).
- **Cosmetic and flow pieces never become ACE objects.** Conveyors, pipes, rails, power lines, belt items and decals
  are non-colliding. Capable clients draw them from the overlay stream; ACE never hears of them.
- **Per-zone budget.** Materialized solid pieces per landblock are capped (v0: 1,000 ACE objects; [02 §6](02-scale-model-and-budgets.md)).
  Larger builds use **modules**, catalog entries that are one multi-part Setup.

### 4.3 Interactions that cross planes
- **Inventory ↔ overlay** (insert items into a machine, take output, pay for a wall) is a **two-phase transaction**
  between ACE (owner of the player's inventory) and the WSS (owner of machine buffers and structures). It carries an
  idempotency key and a timeout refund. Commodities only: factories handle fungible stacks (wcid, count, grade),
  never unique items with spells or workmanship ([07 §3](07-factories-and-logistics.md)). ACE creates real items only
  at the boundary, when a player takes output.
- **Placement** is requested by the client on its extension stream. The WSS validates it (claim, zoning, collision
  against bedrock and other pieces, budget), and ACE is asked to consume the materials (two-phase). On commit the
  piece exists and is materialized if its zone is.
- **Damage from ACE combat** to a materialized piece is native ACE damage. To an abstract piece it is impossible by
  construction: you cannot hit what is not materialized. Bombs dropped on an abstract zone (high-band strikes) are
  resolved by the WSS against its records (§4.5).
- **Use** on a machine opens the factory UI. ACE forwards `Use` on a `StructurePiece` to the WSS, and the panel is
  served over the extension stream.

### 4.4 Raids
The **raid director** (WSS) plans raids from the ecology ([08 §7](08-monster-ecology.md)): origin nest, target,
composition, route on a flow field, and arrival time with warning.
- If the target zone is materialized, the director issues spawn orders at the edge of the materialized area. ACE
  runs real monsters with a **siege behaviour**: follow the route hints, attack structures in the way, prefer the
  target class. The route hints are needed because ACE has no pathfinding ([01 §3](01-technology-audit.md)).
- If not, the raid is resolved **statistically** at arrival time with the same expected outcome
  ([03 §2](03-systems-dynamics.md) rule 2). Offline protection rules apply ([06 §7](06-dynamic-world.md)).
- A raid in flight crossing into a materialized zone **materializes mid-route**. Players see it coming.

### 4.5 Ordnance and the overlay
Bombs and rockets are resolved by ACE when they land in a materialized zone, through ACE's damage path (the existing
bomb code already applies area Fire damage to creatures, [09 §2](09-vehicles-airpower-ordnance.md)), so they also hit
`StructurePiece`s. A high-band strike on a **non-materialized** zone is the common case: a pilot 5 km up bombing a
hive that nobody is near. The vehicle plane then sends the impact to the WSS, which applies blast damage to its
records (nests, enemy structures). The visual effect is shown to observers as usual. No landblock needs loading to
bomb something.

### 4.6 Interest management
Each data type has its own interest rule ([11 §4](11-network-and-interest-management.md)). The WSS's AOI publisher
serves overlay **chunk snapshots + deltas** to the gateway per client. The rule follows distance and altitude. The
client caches chunks by version, so a revisit costs only deltas. ACE's `ObjectMaint` keeps doing what it does for the
character plane, with one change: structure pieces are sent as ACE objects only to sessions that do not receive the
overlay stream (retail), following the capability gating that the vehicle messages already use.

## 5. One simulation core, three hosts

The factory DES, the ecology field model and the raid resolver are written once as a deterministic library
(**`trifecta-sim`**). It has three hosts:
1. **Server**: inside the WSS (native).
2. **Offline**: the world-model simulator ([03 §9](03-systems-dynamics.md)), with synthetic agents, for tuning and
   forecasting.
3. **Client**: compiled to wasm in holtburger-web, for **presentation**. Belts animate from the same flow equations
   between server updates, and the threat map interpolates fronts. The client never decides anything; the server
   corrects it.

This continues the vehicle work's "specified once, implemented twice, parity-tested" flight model (vehicles DESIGN
§4.4), but one better: implemented **once**, so there is no parity drift.

## 6. Why the WSS is a separate process, and why Rust

**Separate process**:
- **GC and the world thread.** The ACE fork already spends serious effort on GC pauses (705 ms blocking gen2 before
  tuning, 51–152 ms after, vehicles DESIGN decisions 37, 71, 73) and on world-thread stalls. A factory and ecology
  model adds a large long-lived heap that the world thread does not need to share.
- **Independent restarts and failure.** The WSS can be upgraded or restarted without kicking 1,000 players (an ACE
  restart is ~24 s, memory `ace-live.md`), and ACE can restart without stopping factories.
- **Different persistence profile.** Many small writes to chunked overlay state is a different workload from
  character saves in ACE's per-property relational schema ([05](05-world-state-and-persistence.md)).
- **A thin ACE diff.** The fork is maintained as a patch series against upstream ACE (vehicles `ace/0001-0006`). A
  sidecar keeps the ACE side to a thin adapter.

**Rust**:
- **One core, three hosts** (§5): the same code runs native on the server, in wasm in the browser and in the offline
  simulator.
- **Shared code with the client.** The `holtburger-dat` crates already read the DATs, and holtburger's
  `terrain_height_at` is the reference terrain sampler. The vehicle fork had to mirror that sampler in C# "operation
  for operation" (decision 16). A Rust WSS links the same crate.
- **Data-oriented and pause-free**: ECS-style arrays for hundreds of thousands of machines and belts, with no GC.

The interface is language-neutral (§7), so a C# WSS stays possible if the owner prefers one runtime on the server.
The cost of that choice would be §5's single-core property and the GC isolation.

## 7. The internal bus (ACE adapter ↔ WSS)

- Transport: a Unix domain socket on the single-box deployment, TCP in a cluster, with length-prefixed binary frames.
  The **schema lives in the same protocol-fragment XML style** as HBV1 (`vehicles.protocol.xml` → C# and Rust codecs
  plus byte fixtures generated by a third implementation), so both sides are generated and round-trip-tested.
- Message classes:
  - lifecycle (zone active, dormant, unloaded; presence);
  - materialization packets and dematerialization reports;
  - write-behind deltas;
  - transactions (prepare / commit / abort, idempotent);
  - spawn orders;
  - ordnance impacts;
  - session binding (which ACE session ↔ which gateway client, its capability bits, its account and allegiance for
    permission checks).
- Back-pressure: bounded queues on both sides. The adapter never blocks the world thread on the bus; it queues and
  applies within budget.

## 8. Failure modes

| Failure | Effect | Behaviour |
|---|---|---|
| WSS down | The classic game is unaffected | ACE keeps materialized pieces as they are (cached in the adapter) and refuses new placements and factory UIs. **Overlay time is suspended**: factories and the ecology both stop, and on return both resume from the moment of the outage. No catch-up for outage time, so factories never produce while raids are frozen (§9) |
| ACE down | Players disconnected | The WSS keeps the world living: factories run, the ecology evolves, abstract raids resolve under offline rules. On ACE return, materialization resumes |
| Gateway down | Browser players disconnected | Reconnect; retail unaffected |
| Bus partition | As WSS down, from ACE's side | Write-behind deltas buffered with bounded memory, then replayed idempotently |
| Overlay store corruption | — | Event log + snapshots allow point-in-time restore per zone ([05 §6](05-world-state-and-persistence.md)) |

## 9. Time

- One world clock, with server-issued monotonic timestamps on every bus message.
- **Overlay time** is a clock owned by the WSS. It advances while the WSS runs, whether or not anyone is watching.
  The factory DES schedules on it, so catch-up for **unobserved** sites (offline owners) is exact for piecewise-linear
  flows.
- **Outages suspend overlay time for factories and the ecology together**: the WSS down, or a planned maintenance
  pause. That keeps production and pressure symmetric. Nobody returns from a maintenance window to an overrun region
  or to free production. ACE outages do **not** suspend it: the overlay keeps living without ACE (§8).
- Time dilation in hotspots ([10 §6](10-server-runtime-and-scaling.md)) applies to the character plane's local
  simulation. The overlay clock does not dilate, and dilation is per-zone bookkeeping in the raid controller.

## 10. Deployment shapes

- **Shape A (first target): one box.** ACE + WSS + gateway + MySQL + Postgres on one server-class machine: the
  reference box of [02 §6](02-scale-model-and-budgets.md), 32 cores / 64 threads, 128 GB RAM, NVMe. The laptop is a
  **development** host only and runs reduced shapes ([02 §8](02-scale-model-and-budgets.md)).
- **Shape B: split by plane.** ACE on its own box. WSS and stores on another. Gateways near the users.
- **Shape C: WSS partitioned by region.** The overlay is spatially local, so WSS shards by region with hand-offs
  for cross-region trains and raids. ACE remains one process.
- **Shape D (research track, not planned): ACE partitioned spatially**, as retail AC distributed landblocks across a
  server cluster ([01 §2](01-technology-audit.md)). Only if one ACE process cannot carry the character plane at the
  target population after the hardening in [10](10-server-runtime-and-scaling.md).

## 11. Decisions proposed

- **D04.1** Decouple persistent simulation from landblock residency. Overlay state never pins landblocks.
- **D04.2** Five planes (character, world-state, vehicle, edge, insight). A new World State Service owns the overlay.
- **D04.3** Two fidelities (abstract / materialized) with single-writer ownership and versioned, conservative
  hand-offs.
- **D04.4** Structures inside ACE are in-memory, catalog-built, never ACE-persisted objects. Looks and collision come
  from base-DAT Setups. Damageable pieces are immobile creatures (`StructurePiece`).
- **D04.5** Factories never run in ACE. Clients render flows from the overlay stream.
- **D04.6** A thin in-process ACE adapter with a generated, fixture-tested bus protocol.
- **D04.7** `trifecta-sim` is a single deterministic Rust core hosted by the WSS, the offline simulator and the
  client.
- **D04.8** Deployment starts as one box (shape A) and is designed for shapes B and C. Spatially partitioning ACE is
  research only.
- **D04.9** Overlay time is owned by the WSS. Unobserved sites catch up exactly. WSS outages suspend overlay time for
  factories and the ecology together.

## 12. Open questions

- **Q04.1** WSS language: Rust (recommended) or C#? Owner preference, and who maintains it.
- **Q04.2** Does materialization ever *request* a landblock load (the online-owner raid window)? Default no.
- **Q04.3** Overlay store: Postgres (recommended for operations) or an embedded store (RocksDB / SQLite per region)
  for simplicity on one box?
- **Q04.4** Is the `StructurePiece`-as-creature approach acceptable to the retail look? Retail shows a health bar
  and a name on select. Is "a wall with a health bar" acceptable, or is a non-creature damage path worth building?
