# 18 — Scenarios and sequences (the architecture, walked through)

Status: **draft v0.1** (2026-11-03).
Purpose: check that the mechanisms of [04](04-target-architecture.md) compose by walking concrete scenarios across the
planes. Each step names its owner, and each scenario ends with the invariants it exercises. A scenario that cannot be
walked exposes a gap; record it in [17](17-risks-and-open-questions.md).

Actors: **C** = holtburger-web client, **R** = retail client, **G** = gateway, **A** = ACE (+ adapter),
**W** = WSS, **DB** = overlay store, **S** = ACE shard DB.

## S1. Login, capabilities, overlay subscription
```
C ──AC login (datagrams via G)──────────────► A        character enters world (unchanged ACE path)
C ──HBC2 ClientCapabilities{bits}──────────► A        in-band, after EnteredWorld
A ──bus: SessionBind{session, account, char, allegiance, bits}──► W
A ──HBC2 CapabilitiesAck{bits, overlayToken}──► C     token: short-lived, session-bound
C ──control stream: Auth{overlayToken}─────► G ──verify──► W
W ── derives the subscription from the session's position (never from client requests, D14.5)
W ──ChunkSnapshot / ThreatMap (streams)────► G ──► C  cached by version; later only deltas
```
Invariants: no extension message to a session without the bit; the client cannot choose arbitrary zones; R does none
of this and plays as today.

## S2. Walking up to a guild base (materialization)
```
C/R move toward landblock X ──► A loads X (off-thread, H1), X becomes active
A ──bus: ZoneActive{X, presence}──► W
W ──bus: Materialize{X, version, solid pieces, ecology spawn orders, raids}──► A
A applies within the per-tick bring-up budget (H2): StructurePieces created (ACE GUIDs from the dynamic range)
A ──CreateObject(piece)──► R only (budgeted, D13.1)
A ──HBW PieceBinding{pieceId↔guid}──► C (in-band, ordered with ACE's own messages)
W ──ChunkSnapshot{X}──► G ──► C (if not cached)
```
Invariants: ACE does not send piece CreateObjects to C (D11.5); C draws pieces through the statics path (D12.1);
nothing pinned X except the player (D04.1).

## S3. Placing a wall (two-phase payment)
```
C ──HBW PlaceRequest{catalogId, transform, txnId}──► A ──forward──► W
W validates: claim, permission, zoning, overlap, support, budget ── fail → PlaceResult{reject}
W ──bus: Prepare{txnId, debit 20 stone blocks}──► A
A removes items, writes the debit + trifecta_txn{debited} to S immediately (durable debit, D05.4)
A ──bus: Prepared{txnId}──► W
W appends PiecePlaced{txnId} (group commit ≤ 200 ms) → event log in DB
W ──bus: Commit{txnId}──► A (txn done) ; W ──ChunkDelta──► C ; A materializes the piece if X is materialized
```
Crash cases: A dies after the debit and before Prepared → on restart both scan open txns → W places the piece if the
placement still validates, otherwise A refunds ("complete if still valid, otherwise compensate", [05 §5](05-world-state-and-persistence.md)).
Idempotent by txnId. Invariants: no item duplication, no free walls.

## S4. Feeding a machine, taking its output
- **Insert**: as S3, with W crediting the machine buffer. The DES schedules the next event (the input buffer is no
  longer empty → the machine starts working → a new threshold time).
- **Withdraw**: W durably debits the output buffer (`ItemsDebited{txn}`) → A creates the items and saves the player
  with the txn row → W marks it done.
- **Retail player** (D13.3): R gives ore to a Quartermaster NPC (the ACE Give action) → A starts the same saga →
  credit to the claim's storage.

Invariants: commodities only; unique items never cross (D07.2); daily conservation reports balance (D14.2).

## S5. A raid on an occupied base (materialized)
```
W (ecology tick) nest N in zone Y: P/K > θ_raid; best target by attraction = claim K in X
W plans: composition (drawn from P_Y), flow-field route Y→X, arrival T+6 min
W ──HBE RaidWarning──► C (members anywhere, players near the route) ; A ──chat──► R (D13.4)
C prefetches the species' rigs (bake worker) ── client spawn tail avoided (CL-8)
T+~5 min: raid enters the materialized area around X
W ──bus: SpawnOrders{raidId, species, count, positions ≥120 m from players, route hints}──► A
A spawns raiders (ecology generator) with siege behaviour (follow hints, break walls, no leash)
combat: turrets (StructurePieces with attack AI) fire real projectiles; players fight; walls take damage
A ──bus: write-behind deltas: PieceDamaged, PieceDestroyed, Killed{species}, AmmoUsed──► W
W: P_Y −= kills; pieces' records updated; the DES re-solves (a broken conveyor, a lost generator)
end of fight or dematerialization ──► A ──bus: Report{survivors, final HP}──► W ; survivors return to P
```
Invariants: single writer (A owns HP while materialized); conservation of monsters; budgets (≤ 200 raiders, the
governor may shift strength to abstract resolution); sanctuaries untouched.

## S6. A raid on an offline base (abstract)
```
W: no presence in X at arrival time T
W resolves: Lanchester attrition with the site's defense rating (turret DPS × ammo, wall HP, guards)
W applies: damage by species priorities; offline floor (core ≥ 1 HP while upkeep is paid); ammo consumed
W appends RaidResolved{…} events; P_Y −= raiders killed; survivors return
owner logs in later ──► S1 ──► ChunkSnapshot shows the damage; the raid log in the claim panel
```
Invariants: same expected outcome as S5 for the same forces (calibration, D08.5); offline protection (D06.5).

## S7. A high-band strike on an unobserved hive
```
pilot (C) in airspace transit at 3 km (anchored, no landblock loads, D09.2)
C ──HBV VehicleInput{bomb}──► A (vehicle plane) ── server ballistic twin steps the bomb (30 Hz)
impact point in zone Z: is Z materialized (active for a player on foot, or partially for an engaging low-band aircraft, 04 §4.1)?
  no ──► A ──bus: OrdnanceImpact{Z, pos, yield, attacker, rules}──► W
         W: blast vs nest records (hardened core resists: strips, does not finish, D08.3); D(Z) += explosion noise
         W ──ChunkDelta{Z}──► subscribers ; A ──HBV Explosion event──► capable observers (visual)
  yes ──► ACE damage path: area Fire damage to creatures and StructurePieces (existing bomb code)
```
Invariants: no landblock loaded for the strike; PvP gates for player structures; sanctuaries no-strike (D09.6);
explosions feed disturbance (fighting makes noise).

## S8. Descending out of the high band into a fight
```
pilot pitches down; predicted crossing of the band floor in ~8 s at landblock L
A (vehicle plane) ──preload L and its 3×3 off-thread (H1)── before the crossing
crossing: anchor released → placement into L via the teleport-arrival path (no portal-space message to the client;
          OnTeleportComplete waits for L's objects); ObjectMaint first sight runs
L's materialization (S2) proceeds as for any arrival; low-band speed cap from the load budget (D09.3)
```
Invariant: no synchronous load on the world thread; no stall for other players.

## S9. A crowd at a siege (the load governor)
```
landblock group cost > 70 % of budget ── step 1: observer position rates drop a tier; ecology radius shrinks
> 85 % ── step 2: raid strength shifts to abstract; AI 5 → 2.5 Hz for creatures without targets
> 100 % for 10 s ── step 3: PortalStormBrewing (0x02C9) → PortalStormImminent (0x02CA) to the densest landblock
> 120 % for 20 s ── step 4: a share of non-combat players teleported away (0x02CB); then Subsided (0x02CC)
release with hysteresis; every step logged
```
Invariants: degrade fidelity, never correctness (D03.7); retail understands every message; policy for siege
participants (Q10.2).

## S10. Failures
- **WSS crash**:
  - A keeps materialized pieces (adapter cache) and refuses placements.
  - Overlay time is suspended: factories and the ecology both stop.
  - On restart W replays the event-log tail, reconciles open txns with A, and resumes overlay time from the outage.
    There is no catch-up for outage time (D04.9).
- **ACE crash**:
  - Players are disconnected.
  - W continues: factories run; abstract raids resolve under offline rules.
  - On restart A reconciles txns and re-requests materialization as zones activate.
  - Pilots in the air enter on the ground (the existing `AirborneSaveMark`, decision 69).
- **Gateway restart**: browsers reconnect (S1). R unaffected.
- **Overlay store failure**: W stops accepting mutations (read-only mode) and the world keeps playing the classic
  game. Restore by point-in-time recovery.

## S11. Clearing an Overrun region (the whole trifecta in one evening)
1. The threat map shows a hive cluster at level 4 near an allied stronghold. A strike task posts a bounty.
2. Engineers ship bombs and fuel from the ordnance works to the forward airstrip by train (S4 flows; the DES moves
   commodities).
3. Pilots fly high (S8 in reverse), bomb the hives from the high band (S7): cores exposed, P drops, disturbance spikes.
4. A ground team lands at the airstrip, crosses the infested zone (classic-style combat with ecology monsters), and
   finishes the cores on foot (S5-style materialized fight). Retail players in the team fight normally.
5. The front recedes over the next days as K falls. Suppression keeps nests from refounding. Titles are awarded.

Invariants exercised: P4 (escalation has an answer, and it costs), P5 (interdependence), B5 and B1 loops, the
conservation rules, retail participation.
