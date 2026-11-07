# 07 — Factories and logistics

Status: **draft v0.1** (2026-11-03).
Depends on: [03 systems dynamics](03-systems-dynamics.md), [04 architecture](04-target-architecture.md), [05 persistence](05-world-state-and-persistence.md), [06 dynamic world](06-dynamic-world.md).
Feeds: [08 ecology](08-monster-ecology.md) (disturbance), [09 vehicles](09-vehicles-airpower-ordnance.md) (fuel, ammo, airframes), [12 client](12-client-holtburger-web.md), [15 economy](15-economy-progression-social.md).

## 1. Goals

1. **An endless, satisfying factory game** in AC's world: extract, process, convey, power, automate, scale up. It is
   fun alone in the first hour and deep at the hundredth (P6).
2. **Runs while the owner is offline**, for every claimed site, at a small fraction of a server
   ([02 §6.2](02-scale-model-and-budgets.md): ~1.8 M machines and segments, ≤ 2 cores).
3. **Feeds the other two legs**:
   - walls, turrets and ammunition for defense;
   - fuel, ordnance and airframes for aviation;
   - trade goods for the economy.
4. **Provokes the world** in proportion to its size (P3): disturbance feeds the ecology.
5. **Leaves the classic economy intact** (P1): factory outputs enter classic progression only through explicit,
   owner-approved channels ([15](15-economy-progression-social.md)).

## 2. Flavour: an industrial age in Dereth

Factories follow the vehicle work's framing (owner, vehicles DESIGN §0): built from in-game items, with a WW2
**mental framing** but not real-world objects.
- **Power is mana.** Mana springs and ley nodes are tapped by generators and carried by **mana conduits**. Burnable
  fuels (mana-charged shards, scarabs) power mobile and remote sites.
- **Machines** reuse retail models wherever possible (forges, anvils, cauldrons, kegs, barrels, crates, looms, mill
  wheels), since every solid piece is a base-DAT model ([06 §4](06-dynamic-world.md)).
- **Conveyors, pipes and rails** are cosmetic and non-colliding, so capable clients may draw them with procedural or
  composited geometry. Retail clients do not see them ([13](13-retail-compatibility.md)).

## 3. The item model: commodities, not items

ACE items are biotas with dozens to hundreds of property rows ([05 §1](05-world-state-and-persistence.md)). A factory
moving thousands of items per minute cannot use them.

- **Commodity** = (kind, grade, count).
  - Kind is a factory catalog id (ore, ingot, plank, stone block, steel beam, mana shard, quarrel, keg bomb, …) that
    maps to an ACE weenie (wcid) **only at the boundary**.
  - Grade is an optional quality tier (1–5), mirroring AC's workmanship idea without carrying per-item stats.
- Factories, belts, storage and trains handle commodities as integer counts.
- **Boundary crossings** happen when a player inserts or withdraws, or pays for construction. They are two-phase
  transactions that create or consume real ACE items ([05 §5](05-world-state-and-persistence.md)). Unique items
  (anything with spells, workmanship-based stats or inscriptions) **never enter** factory logistics.
- **Unique-item recipes** run as ACE recipes at special stations, notably the hangar's airframe assembly, which
  consumes shields, crossbows, wands and kegs as the Hellcat's 55-part composite suggests ([09 §6](09-vehicles-airpower-ordnance.md)).
  ACE already has a recipe system (`ACE.Server/Managers/RecipeManager.cs`). That keeps unique-item handling in the
  plane that owns it.

## 4. The simulation: discrete events over a flow network

### 4.1 Why not tick it
Factorio ticks every entity 60 times a second and spends years of optimization making that fast. An MMO with
thousands of offline factories cannot tick them at all. The insight that makes it free:

> Between changes, a factory is a set of constant flows. Every stock changes **linearly** in time. Only *changes*
> need computing.

### 4.2 The model
- **Graph**: machines and storage are nodes; belts, pipes and rail links are edges with capacity (items/s) and
  latency (length / speed). A site's graph splits into **connected components**, each simulated independently.
- **Machine states**: working, starved (an input buffer is empty), blocked (an output buffer is full), unpowered or
  brown-out (rate × power satisfaction), disabled, destroyed.
- **Rate solve** per component, recomputed **only on an event**. It propagates rates from sources (extractors,
  storage) through machines (recipe ratios, cycle times) and edges (capacity caps, splitter shares, merger
  priorities) to sinks.
  - **Termination**: the solve is a **monotone non-increasing** fixed-point iteration. Every rate starts at its upper
    bound (capacity, recipe maximum) and only ever decreases to satisfy conservation and the split and merge rules.
    A non-increasing sequence of non-negative integers terminates.
  - Splitters and mergers use deterministic proportional rules chosen to preserve that monotonicity.
  - An iteration cap with a logged fallback guards against defects.
  - Cost: O(edges × iterations), bounded. Graphs with loops are covered by the property tests (§10).
- **Between events**, every buffer is `stock(t) = stock(t0) + (in − out) · (t − t0)`, in fixed-point milli-items. It
  is a **fluid** quantity: whole items are reconciled only when a player or train withdraws, when a buffer crosses a
  threshold, or when a client observes it.
- Each buffer's next **threshold time** (full, empty) goes into a priority queue. **There are no per-cycle events.**
  A machine with a 2 s recipe in steady state generates no events at all. That is what keeps the
  [02 §6.2](02-scale-model-and-budgets.md) budget of ≤ 1 event per entity per minute.
- **Events**:
  - a buffer reaches a threshold;
  - power changes;
  - a deposit depletes;
  - a player edits, inserts or withdraws;
  - a piece is damaged or destroyed;
  - a train arrives;
  - an upkeep state changes.
  Each event changes states, re-solves the component and reschedules.
- **Exact catch-up**. A site that nobody observed for three days advances through its few dozen events, not through
  three days of ticks. WSS outages are different: overlay time is suspended during them, for factories and the
  ecology alike ([04 §9](04-target-architecture.md)).
- **Determinism**: integer arithmetic for rates (milli-items per second) and stocks, and integer milliseconds of world
  time. The native server, the wasm client and the offline simulator ([04 §5](04-target-architecture.md)) produce
  identical results. Parity tests are byte comparisons.

### 4.3 Belts and presentation
- A belt edge in steady state carries rate *q* (≤ capacity) at speed *v*, so items are spaced *v/q* apart. A mixed
  belt carries several kinds in fixed shares.
- The server derives a **flow descriptor** per belt segment: path, speed, spacing, item pattern (a deterministic
  interleave of kinds by share), and a time origin. It sends the descriptor only when it changes.
- The client places every item in the vertex shader from `t` ([12 §3.4](12-client-holtburger-web.md)). A belt
  running for hours costs zero bandwidth and near-zero CPU.
- Trade-off, stated plainly: this is a **mesoscopic** model. It does not reproduce Factorio's micro-behaviour of
  individual items jamming a lane, so mixed-belt designs behave by shares. That is a design choice for scale. Belt
  puzzles come from throughput, ratios, splitting and routing, which the model represents exactly.

### 4.4 Power
- **Grids** are connected components of conduits.
- Supply comes from generators: spring taps with fixed output, or fuel burners whose rate is tied to fuel buffers.
- Demand is the sum of machine draws.
- Satisfaction s = min(1, supply/demand). Machines run at rate × s (brown-out).
- A grid change is an event that re-solves every component on that grid.

### 4.5 Trains and long-distance logistics
- **Rail network**: track edges with signals simplified to block reservation. Trains are logistic vehicles with
  schedules (stations, load/unload conditions).
- Positions are **closed-form**: piecewise motion with acceleration profiles along a reserved path. Arrival is an
  event. Clients draw trains from schedule descriptors, as they draw belts.
- **Attackability** (v1): tracks and stations are structures and can be attacked. Moving trains cannot be targeted
  in v1; they are not materialized as ACE objects.
  - v2 option: train cars become vehicle-plane objects when they pass through materialized zones, so raids and air
    strikes can ambush them.
- **Cross-site trade** between allegiances: trains can cross claims with permission. Stations act as market
  terminals ([15](15-economy-progression-social.md)).
- Partitioned WSS (deployment shape C): cross-region edges become hand-off queues carrying a rate and the in-flight
  inventory. Rate-based flows partition cleanly.

### 4.6 Destruction and the flow network
- A destroyed machine or segment leaves the graph (event), and its component re-solves.
- Items on a destroyed belt spill into a **debris pile** that the owner can recover for 10 minutes, then it is lost.
  That loss is a sink.
- A destroyed generator browns out its grid, so defenders feel a successful raid immediately.

## 5. Catalog (v0 sketch; numbers to be tuned in the world-model simulator)

| Class | Examples | Notes |
|---|---|---|
| Extractors | Ore drill (iron, copper, silver, gold veins), quarry (stone), lumber camp (timber from forest density; trees are bedrock and are not removed), mana tap (springs) | Deposits are seeded per landblock from habitat and terrain, finite with slow regeneration ([§7](#7-resources-and-the-map)) |
| Processors | Smelter, forge, sawmill, mason, alchemist's still, assembler, munitions works | Recipes: inputs → outputs, cycle time, power |
| Logistics | Conveyor (3 tiers), splitter, merger, storage (crate, warehouse), rail track, station, train | Machines have built-in input/output ports; there are no inserter entities, which keeps entity counts low |
| Power | Spring tap, fuel burner, mana conduit, accumulator | Grids and brown-out |
| Defense | Wall, gate, tower ([06](06-dynamic-world.md)); **crossbow turret** (quarrels, pierce); **wand tower** (mana charges → real AC war spells); trap; **flak battery** (anti-air, ≤ the high-band floor) | Turrets are immobile attacking creatures when materialized (§6) |
| Aviation | Hangar (airframe assembly via ACE recipe), fuel depot, ordnance works (keg bombs, rail charges), airstrip markers | [09 §6](09-vehicles-airpower-ordnance.md) |
| Control | Warding stone (cuts local disturbance at a power cost), beacon, market terminal, research bench | Disturbance management is a strategic choice: stealth vs efficiency |

## 6. Automated defenses

- **Materialized**: turrets are `StructurePiece`s that fire **real ACE projectiles and spells**, so retail clients
  see the bolts and the damage too. Two classes by range:
  - **Short range (≤ ~75 m), ACE monster AI.** Crossbow turrets, short wand towers, guards. ACE's immobile-monster
    behaviour already turns, aims and attacks without moving ([10 §4.3](10-server-runtime-and-scaling.md)). Its reach
    is capped: monster missiles at 85 yd ≈ 77.7 m (`Creature_Missile.MissileRangeCap`), monster spells at 75 m
    (`Monster_Magic.cs:117`).
  - **Long range (> 75 m), custom weapon code**: flak to 600 m, long wand towers. They follow the Hellcat's pattern:
    - the server resolves fire itself (the six crossbows' 140 m ray and the convergence point, decision 64);
    - it launches real `SpellProjectile`s with the structure as the launcher (decision 65);
    - its own target sight (the turret's sensor radius), not ACE's 75 m monster awareness.
  - Ammo is drawn from the turret's WSS buffer; consumption is reported by write-behind deltas.
  - A turret without ammo is a wall.
- **Abstract**: a site's **defense rating** is turret DPS × ammo availability × coverage, plus wall HP and guards. It
  is used by raid resolution ([08 §8](08-monster-ecology.md)).
- **Altitude rule**: no ground weapon reaches the high band (≥ 600 m AGL; P4). Flak covers the low and mid bands,
  which makes low-level strafing of a defended base costly and keeps the high band a refuge.
- **Target discipline**: as the single rule table ([15 §5.1](15-economy-progression-social.md)) says. Raid monsters
  always; players only when eligible against the turret's claim ("defenders may shoot whoever may shoot them"); never
  into sanctuaries.

## 7. Resources and the map

- **Deposits** are seeded deterministically per landblock from terrain type (rock, snow, grass, sand, marsh), height
  and region:
  - iron in rocky highlands, copper in hills, gold rare and deep in the wild;
  - mana springs near ley-line features (old ruins, portal sites, but **outside** sanctuaries).
- **Finite with slow regeneration**. Industry migrates over time, and veins in dangerous country are richer. The
  best resources sit where the ecology is strongest (deep wild), which couples P3 risk to reward.
- **Scarcity is spatial**: land is plentiful ([02 §2](02-scale-model-and-budgets.md)), but rich deposits and safe
  ground are not, which drives territory and guild conflict ([15 §5](15-economy-progression-social.md)).

## 8. Disturbance (the coupling to the ecology)

Every catalog entry declares its **disturbance output**: per unit of throughput for machines, per shot for turrets,
per MW for generators. The WSS accumulates emissions per zone into the D field ([03 §3](03-systems-dynamics.md)).
Players manage it:
- quiet sites (warding, low throughput) draw little attention;
- big, loud industry draws raids superlinearly (α > 1);
- distance from nests matters, because raid reach is bounded.

This is the factory game's **strategic layer**. It is also the main lever by which players shape the ecology's
pressure.

## 9. The first hour (solo, P6)

1. Claim an outpost on frontier land near a copper vein the map shows.
2. Place a hand-fed smelter (no power yet), feed it ore by hand, and get the first ingots.
3. Build a mana tap on a spring and a short conduit, then a powered drill, and connect it to the smelter with a
   conveyor. Watch ingots accumulate while you go hunting nearby.
4. A raid warning: "Drudge scouts sighted to the east, 6 minutes." Build a short palisade and a crossbow turret, and
   load quarrels. The scouts break on the wall.
5. Expand. The disturbance meter shows the site's footprint. The map's threat overlay explains why bigger draws more.

## 10. Testing

- **Conservation property tests**: random factory graphs over random event sequences. Items in = items out + Δstocks,
  exactly (integers).
- **Catch-up equivalence**: simulating continuously vs jumping over the same interval gives identical state.
- **Rate-solver reference**: a slow, tick-based micro-simulator as the oracle for small graphs. DES rates must match
  its long-run averages within tolerance.
- **Determinism**: native and wasm runs of the same scenario produce byte-identical snapshots.
- **Scale benches**: 1.8 M entities on the reference box ([02 §6.2](02-scale-model-and-budgets.md)), events per
  second, solve latency p99.

## 11. Decisions proposed
- **D07.1** Factories run as a deterministic discrete-event simulation over flow networks in the WSS, never in ACE.
- **D07.2** Commodities (kind, grade, count), not ACE items, inside logistics. Unique items only through ACE recipes
  at stations.
- **D07.3** Belts are mesoscopic (rates and shares), presented by closed-form descriptors.
- **D07.4** Machine ports replace inserter entities.
- **D07.5** Power is mana grids with brown-out.
- **D07.6** Turrets are immobile `StructurePiece`s that fire real ACE projectiles and spells. Short range (≤ 75 m) uses
  ACE's immobile-monster AI; long range (flak, long wand towers) is custom weapon code on the Hellcat's pattern. Flak
  never reaches the high band.
- **D07.7** Every catalog entry declares a disturbance output. Warding trades power for stealth.
- **D07.8** Deposits are deterministic, finite and regenerating, and richer in dangerous country.

## 12. Open questions
- **Q07.1** Which outputs may leave as classic items (quarrels, scarabs, kegs), and at what rates ([15](15-economy-progression-social.md))?
- **Q07.2** Is "no inserters" right, or do port-only machines make layouts too trivial? A playtest question.
- **Q07.3** Research and unlock pacing: tied to character level, quests, or purely to factory output?
- **Q07.4** Do workers (placed NPCs) affect throughput, or are they cosmetic?
