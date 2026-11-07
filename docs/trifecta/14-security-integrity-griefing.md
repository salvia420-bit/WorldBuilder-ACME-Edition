# 14 — Security, integrity and griefing

Status: **draft v0.1** (2026-11-03).
Depends on: [05 persistence](05-world-state-and-persistence.md), [06 dynamic world](06-dynamic-world.md), [10 server runtime](10-server-runtime-and-scaling.md), [11 network](11-network-and-interest-management.md).

## 1. Threat model

| Threat | Example | Why it matters more now |
|---|---|---|
| Modified clients | Speed, teleport, walk through walls, forged extension messages | Walls and bases are worthless if clients can ignore them; today ACE accepts any requested position under ~1 landblock |
| Item duplication | Crash between two stores' saves | Two authorities (ACE shard, WSS store) with different save cadences |
| Economic exploits | Factory output sold to NPC vendors for pyreals; recipe loops | Automation runs 24/7 |
| Griefing by building | Walls across roads, around portals, around players; claim carpeting by alts | Malleable world |
| Griefing by monsters | Luring raids onto others; kiting raiders into towns | Raiders follow routes |
| Griefing by air | Bombing other players' bases outside war; bombing near towns | Ordnance |
| Offline raiding | Wiping a base at 4 am | P6 |
| Denial of service | Packet floods, login floods, placement floods, subscription floods | 1,000+ sessions; ACE has no login throttle and no packet rate limit (`ConnectionListener.cs:102` TODO) |
| Insider and admin error | A wrong rollback, a careless spawn | Point-in-time tools are powerful |

## 2. Principles
1. **The client predicts, the server decides.** Every placement, transfer, attack and movement is validated by the
   server. Capability bits grant **interfaces, never trust**.
2. **Conservation is tested, not assumed.** Items, commodities and currency are ledgered and checked.
3. **Every mutation is attributable**: actor, time, transaction, in the event log ([05 §4](05-world-state-and-persistence.md)).
4. **Rate limits everywhere a loop can be automated.**
5. **Recoverable**: point-in-time restore per claim and zone; compensations instead of silent deletes.

## 3. Movement integrity (H14)

**Today, verified in code:**
- `UpdatePlayerPosition` pre-validates and rejects only jumps of more than one landblock
  (`distSq > MaxSpeedSq && blockDist > 1`), plus a z-position check (`S/WorldObjects/Player_Tick.cs:411-491`).
- ACE then **computes a full collision transition** from the current to the requested position
  (`UpdateObjectInternalServer` → `transition(Position, RequestPos)`, `S/Physics/PhysicsObj.cs:1778`).
- Finally `update_object_server(forcePos = true)` **sets the requested position anyway** (`PhysicsObj.cs:4266-4277`).
  The collision result is thrown away.
- The carry experiment confirmed any step under a landblock is accepted at any speed.

**Design:**
1. **Speed envelope** (vehicles DESIGN §4.9):
   - accept a step if its length ≤ max run speed × elapsed time × slack, plus jump and fall allowances;
   - otherwise snap back to the last valid position, **never freeze**;
   - retail ignores ForcePosition while airborne, so a correction to a jumping player is re-sent on landing.
2. **Overlay collision validation, built on the transition ACE already computes**:
   - Materialized pieces are ACE physics objects, so the discarded transition (`PhysicsObj.cs:1778`) already sweeps
     the player against them. Compare its end point (`SpherePath.CurPos`) with the requested position.
   - When they differ beyond a tolerance **and** the blocking object is an overlay solid, reject the step (snap back
     to the contact point).
   - No second collision system is needed. The cost is the transition ACE already pays.
   - **Scope**: only steps that touch cells containing overlay solids, so cost is proportional to building density
     near the player.
3. **Bedrock geometry** (DAT buildings) is **not** validated in v1. It is not new risk, and full validation is what
   made one server "almost unplayable" ([Q] #general 2024-12-21).
4. Behind server properties, with generous slack. **Default-on is a gate for P2** wherever retail clients and dense
   bases coexist ([13 §5](13-retail-compatibility.md)), after testing with real retail clients.

## 4. Item and currency integrity
- **Sagas with durable debit first** ([05 §5](05-world-state-and-persistence.md)), idempotent by transaction id,
  reconciled at startup.
- **Crash loops in CI**: `kill -9` each process at each saga step, both directions; assert conservation.
- **Ledgers**:
  - per-account and per-claim commodity flows;
  - a daily conservation report: produced − consumed − Δstocks = 0 per kind;
  - anomaly alerts on outliers (an account's net inflow far above its sites' capacity).
- **Rate limits** on cross-plane transfers per account per minute.

## 5. Economic integrity (with [15](15-economy-progression-social.md))
- **No unlimited NPC buy-back of factory output.** Vendor sales of factory commodities are capped per account per day
  or disallowed. Otherwise automation becomes an infinite pyreal faucet.
- Recipes are reviewed for loops: a cycle that yields more than it consumes is a bug. The offline simulator's
  conservation checks catch it ([03 §9](03-systems-dynamics.md)).
- Unique items never enter logistics ([07 §3](07-factories-and-logistics.md)).

## 6. Griefing

| Vector | Mitigation |
|---|---|
| Building on roads, around portals, quest NPCs, lifestones | Zoning: road corridors, landmark radii, sanctuaries ([06 §3](06-dynamic-world.md)) |
| Walling in players | Building only inside one's own claims. No placement within 3 m of another player. Players inside a foreign claim get a free `/unstuck` to the nearest claim edge |
| Claim carpeting (alts) | Per-account claim limits; claims require progression (Q06.2); upkeep; abandonment to ruins |
| Luring raids onto others | Raiders have a **target claim**. They fight players who attack them but break off pursuit beyond N m from their route. Raiders entering a sanctuary dissipate (absorbing boundary) |
| Kiting monsters into towns | Same; and ecology monsters never enter sanctuaries |
| Bombing others' bases | PvP gates (war status, vulnerability window). Sanctuaries no-strike. Audit of every release |
| Offline wipes | Offline protection: core floor against monster raids; reinforcement and vulnerability windows for PvP ([06 §7](06-dynamic-world.md)) |
| Notification spam | Rate-limited raid and attack notices; coalesced per claim |
| Ruins squatting | Ruins are removed after a fixed time; their land returns to the frontier |

## 7. Protocol and service security
- **Decoders**: bounded counts, lengths and total sizes for every family. Hostile fixtures in the generated test suites
  (HBV1's pattern).
- **Rate limits**:
  - per session and opcode family;
  - placement ≤ 2 pieces/s sustained;
  - overlay subscriptions bounded per session (one viewpoint, not arbitrary areas).
- **Overlay token**: short-lived, session-bound, revoked on logout ([11 §3](11-network-and-interest-management.md)).
  Subscriptions are derived from the session's position server-side; the client cannot request arbitrary zones.
  That also prevents map-wide scouting through the overlay.
- **Gateway**:
  - per-IP connection caps;
  - a login throttle, which ACE lacks (brute-force lockout is a TODO in `AuthenticationHandler.cs:176`);
  - QUIC retry tokens against spoofed floods.
  - It passes the **real client IP** to ACE and the WSS for bans: behind the bridge ACE sees everyone as
    `127.0.0.1:port` today.
- **ACE packet floods**: add per-endpoint packet-rate limits in the listener (TODO at `ConnectionListener.cs:102`), or
  enforce them at the gateway and keep ACE's UDP ports private to the gateway for browser traffic.

## 8. Admin tooling (day one)
- **Audit queries**: by claim, zone, account and time ([05 §6](05-world-state-and-persistence.md)).
- **Point-in-time restore** of a claim or zone, as an event with compensations.
- **Claim actions**: seize, freeze, transfer, remove structures, reset upkeep.
- **Ecology circuit breakers** (scale r, clear a zone, cancel a raid) and **governor overrides** (force a step, lift
  a portal storm).
- Every admin action is itself logged and attributable.

## 9. Data protection
Event logs and ledgers contain account and character ids. Apply the same access controls and retention rules as the
project's existing PII decisions (`docs/PII-EXPOSURE-OWNER-DECISIONS.md`). Admin read access is logged.

## 10. Decisions proposed
- **D14.1** Speed envelope + overlay collision validation (H14), scoped to overlay solids; bedrock is not validated in
  v1.
- **D14.2** Item conservation by sagas, ledgers, daily conservation reports and crash-loop tests.
- **D14.3** No unlimited NPC buy-back of factory output.
- **D14.4** Building only in own claims; anti-walling distance; free unstuck from foreign claims.
- **D14.5** Overlay subscriptions are derived server-side from position; the client cannot ask for arbitrary zones.
- **D14.6** The gateway enforces per-IP limits and login throttles, and passes real IPs downstream.

## 11. Open questions
- **Q14.1** How much slack does the speed envelope need for retail clients on bad links? Needs retail testing.
- **Q14.2** Allow account sharing within households (per-IP limits) or not?
