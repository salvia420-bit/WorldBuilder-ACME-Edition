# 05 — World state and persistence

Status: **draft v0.1** (2026-11-03).
Depends on: [04 architecture](04-target-architecture.md).
Feeds: [06](06-dynamic-world.md), [07](07-factories-and-logistics.md), [08](08-monster-ecology.md), [14](14-security-integrity-griefing.md).
Sources: the persistence survey of 2026-11-03. `DB/` = `~/ace-server/Source/ACE.Database/`,
`WO/` = `~/ace-server/Source/ACE.Server/WorldObjects/`.

## 1. ACE persistence today, and why the overlay does not use it

| Aspect | ACE today | Fit for millions of overlay objects |
|---|---|---|
| Technology | EF Core 9 + Pomelo MySQL (`DB/ACE.Database.csproj:21-22`) | Fine as technology |
| Schema | **EAV**: a `biota` row plus 25 `biota_properties_*` tables, **one row per property**. A new object copies its weenie's full property set: tens of rows for items, hundreds for creatures (`DB/Adapter/BiotaConverter.cs`) | **No**: 12 M pieces would mean hundreds of millions of rows |
| Writer | **One** "Serialized Shard Database" thread; per-object DbContext and `SaveChanges`; no cross-object batching (`DB/SerializedShardDatabase.cs:24-77`) | **No** for 100–1,000 events/s |
| Load | 1 SELECT + up to 25 per object; containers then queue their own inventory query (N+1) (`DB/ShardDatabase.cs:163-262`, `WO/Container.cs:89-95`) | **No** for chunk-at-a-time loads |
| Cadence | Players every 300 s and at logout; landblocks every 5 min and at unload; some immediate saves (hooks, corpses) | Crash windows of minutes |
| What persists | Players and possessions, houses, slumlords, non-empty hooks and storage, non-generated dynamic objects. **Not**: world spawns, chest contents, door/NPC state, generator state | — |
| Identity | Static GUIDs **4,096 per landblock** (`0x7AABBnnn`); dynamic GUIDs 2.1 B, recycled after 6 h, gap-scanned at startup (`ACE.Entity/ObjectGuid.cs:21-38`, `ACE.Server/Managers/GuidManager.cs`) | Static: **no**. Dynamic: yes for transient use only |

**Conclusion.** ACE's shard keeps doing what it is good at: characters and their items. The overlay gets its own
store, designed for chunked, append-heavy, spatially local data. ACE never persists an overlay object (the vehicle
precedent, `IsDynamicThatShouldPersistToShard` → false).

## 2. Requirements

| # | Requirement | Target |
|---|---|---|
| P1 | Volume | 12 M pieces, 2 M machines and segments, ~40–60k claims (≤ 2 per account × ~20k accounts + allegiance claims), 65k ecology zones ([02 §6.2](02-scale-model-and-budgets.md)) |
| P2 | Write rate | 100–1,000 events/s sustained, bursts of 10k/s (a siege) |
| P3 | Durability | ≤ 1 s of events lost on a WSS crash; **zero item duplication** across planes (§5) |
| P4 | Read pattern | A whole chunk at a time (materialization, subscription), in milliseconds when hot |
| P5 | Audit | Who placed, damaged or destroyed what, when, with which transaction |
| P6 | Rollback | Point-in-time restore of one claim or one zone without touching the rest of the world |
| P7 | Evolution | Versioned binary formats; old snapshots stay readable |

## 3. Data model (logical)

```
Zone (landblock id)                       ── 1 ──┬── * Piece        (structure pieces, cosmetic and solid)
  version, ecology cell (P_s, N_s, D, …)         ├── * Machine      (recipe, buffers, progress, power state)
                                                 ├── * FlowEdge     (belt / pipe / rail segments: graph edges)
Claim (id) ── * Zone (coverage)                  ├── * Nest         (species, biomass, hardened core HP)
  owner (account, character), allegiance,        ├── * PlacedNpc    (template weenie, pose, HP, alive, orders)
  shape, tier, upkeep, protection timers         └── * Deposit      (resource kind, remaining, regen)
LogisticsNetwork (id) ── * FlowEdge, * Machine  (cross-zone graph; trains)
PowerGrid (id) ── * Machine
Raid (id): origin nest, target, composition, route, schedule, state, outcome
Txn (id): cross-plane transactions with ACE (§5)
```

- **IDs** are 64-bit and **zone-scoped**: `zone (16 bits) | sequence (48 bits)`. They are never reused and need no
  global coordination. Cross-zone objects (networks, grids, claims, raids) use a global 64-bit sequence.
- **ACE GUIDs are transient bindings**, assigned at materialization from ACE's dynamic range and never stored in the
  overlay. The adapter keeps the map in memory, and capable clients learn it through `PieceBinding`
  ([11 §5](11-network-and-interest-management.md)). This sidesteps both the 4,096 static-GUID limit per landblock and
  the dynamic-GUID recycling window.
- **Catalog**: pieces, machines and NPC templates reference catalog ids. The catalog is versioned data (base-DAT
  Setup / GfxObj, collision class, HP, armour per damage type, build cost, disturbance output, support rules).
  It is shipped to the server and to capable clients ([06 §4](06-dynamic-world.md)).

## 4. Storage design

### 4.1 Event log + snapshots (source of truth)
- **Event log**: append-only, every mutation as an event (`PiecePlaced`, `PieceDamaged{ΔHP, source}`,
  `PieceDestroyed`, `ClaimCreated`, `MachineConfigured`, `ItemsCredited{txn}`, `RaidResolved{…}`, …) with world
  time, actor (account, character, system) and transaction id. Partitioned by time and indexed by zone.
- **Snapshots**: one binary chunk snapshot per zone (the [11 §5.1](11-network-and-interest-management.md) encoding is
  the wire form, and the storage form is close to it). Written when dirty, debounced to ≤ 1 per 10 s per zone, and
  always at dematerialization.
- **State of a zone** = latest snapshot + events after its version. Recovery after a crash replays the tail.

### 4.2 Relational tables
Claims (with a spatial index), permissions, allegiance relations (war and peace, [15](15-economy-progression-social.md)),
cross-plane transactions, raid history, economy ledgers and metric rollups. These are small and query-heavy.

### 4.3 Technology
- **Recommended: PostgreSQL** (16+): relational tables; snapshots as `bytea` (TOAST-compressed); the event log as a
  partitioned table; WAL on NVMe; continuous archiving for point-in-time recovery. It is well understood for
  operations and backs up cleanly.
- **Alternative** for a single box: an embedded store (RocksDB, or SQLite per region) inside the WSS (Q04.3). It is
  simpler but has fewer tools.
- **Not**: ACE's MySQL shard with EAV, and not a document store per piece.

### 4.4 Write and read paths
- **Write**: the WSS applies events in memory, then **group-commits** the event batch every 50–200 ms (≤ 1 s loss,
  P3). Snapshots are written asynchronously.
- **Read**: zones are hot in WSS memory while subscribed or recently active; cold zones load snapshot + tail in
  milliseconds. Eviction is LRU against a memory budget.

## 5. Cross-plane transactions with ACE: the duplication problem

Items cross the plane boundary when a player pays for a wall, feeds a machine or takes its output. Two stores with
different save cadences are the classic **item-duplication** setup. Example: ACE saves a player every 5 minutes. If
the WSS durably credits a machine with 100 iron while the player's debit lives only in ACE memory, an ACE crash
restores the iron to the player. The iron then exists twice.

**Rule: debit durably first, then credit; reconcile pending transactions at startup.** This is the saga pattern with
compensations.
1. **Player → overlay** (pay, insert):
   1. ACE removes the items **and writes the debit immediately** to its shard, along with a row in a small new
      `trifecta_txn` table (txn id, state = `debited`). ACE has immediate-save precedents for hooks and corpses.
   2. The WSS commits the credit event with the same txn id.
   3. ACE marks the txn `done`.
2. **Overlay → player** (take output, refund):
   1. The WSS durably debits (event `ItemsDebited{txn}`).
   2. ACE creates the items and saves the player immediately, along with the txn row.
   3. The WSS marks the txn `done`.
3. **Startup reconciliation**: both sides scan open txns. Every step is **idempotent** by txn id.
   - The rule is **complete if still valid, otherwise compensate**.
   - A txn that ACE debited and the WSS never credited is credited, if the credit still applies (the machine exists;
     the placement still validates). Otherwise ACE **refunds** the debit.
   - A txn that the WSS debited and ACE never created is created, or re-credited to the machine if the character no
     longer exists.
4. **Only commodities cross** (fungible stacks: wcid, count, grade). Unique items stay in ACE. That bounds the item
   kinds the overlay must understand ([07 §3](07-factories-and-logistics.md)).

**Prerequisite in ACE, verified 2026-11-03: atomic saves do not exist today.**
- `SaveBiotasInParallel` saves each object in its own database context inside a `Parallel.ForEach`
  (`ACE.Database/ShardDatabase.cs:371-380`).
- The serialized DB thread logs a failed task and **swallows** it (`ACE.Database/SerializedShardDatabase.cs:55-64`).
- "Debit plus txn row in one commit" (Q05.3) therefore needs **a new ACE database method**: one context, one
  transaction, covering only the changed inventory items and the txn row (not a full player save). Its failure must be
  surfaced to the saga (it aborts the txn), not swallowed. Its cost goes into the [02 §6.1](02-scale-model-and-budgets.md)
  shard budget. It is a P2.2 prerequisite.

Test: crash both processes (`kill -9`) at every step of both directions in a loop. Assert that item totals are
conserved. The vehicle work's live crash test (decision 69, "pilot saved in the sky … `kill -9` of the ACE process")
is the model.

## 6. Audit, rollback, retention, backups

- **Audit**: admin queries over the event log: what happened to this claim, who destroyed this wall, all actions by
  this account in an interval. These feed the anti-griefing tools ([14](14-security-integrity-griefing.md)).
- **Rollback**: point-in-time restore of a claim or zone (snapshot at T + events up to T). Rollbacks are recorded as
  events themselves. Cross-plane items involved in rolled-back events need compensations, never silent deletion.
  Server-wide rollbacks are a last resort, coordinated with ACE's MySQL backups at a common timestamp.
- **Retention**: fine-grained events are kept 30–90 days; older ones are compacted into snapshots. Raid and economy
  history roll up into metrics.
- **Backups**: Postgres base backup nightly plus WAL archiving (point-in-time recovery). MySQL as today. **Restores
  are tested** on a schedule.

## 7. Schema evolution
- Binary formats are versioned and append-only, the HBV1 rule: readers parse known fields and skip trailing bytes.
- The catalog is versioned. Pieces reference a catalog entry by id and the snapshot records the catalog version.
  A catalog change that alters collision or HP applies on the next materialization, with a migration event.

## 8. Decisions proposed
- **D05.1** The overlay has its own store (Postgres recommended); ACE persists no overlay object.
- **D05.2** Event log + per-zone snapshots are the source of truth; group commit ≤ 200 ms.
- **D05.3** Overlay ids are 64-bit and zone-scoped; ACE GUIDs are transient bindings only.
- **D05.4** Cross-plane item moves use durable-debit-first sagas with idempotent startup reconciliation ("complete
  if still valid, otherwise compensate"); only commodities cross. Requires a new transactional ACE save method.
- **D05.5** Point-in-time restore per claim and zone is a day-one admin capability.

## 9. Open questions
- **Q05.1** = Q04.3 (Postgres vs an embedded store), tracked there.
- **Q05.2** Retention window for fine-grained events (storage vs investigative needs).
- **Q05.3** Should ACE's `trifecta_txn` table live in the shard DB (same transaction as the inventory write: best)
  or in Postgres? Recommended: the shard, so debit and txn row commit atomically.
