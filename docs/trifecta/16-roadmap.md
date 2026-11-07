# 16 — Roadmap: phases, workstreams, dependencies

Status: **draft v0.1** (2026-11-03). This is the map of the work. Each item names the document that specifies it.
Sizes are **relative complexity** (S, M, L, XL), not calendar estimates. One calibration point: the vehicles demo,
M0–M5 plus the high band and armament (an L-sized scope), took about two days of agent sessions on 2026-11-01 and
11-02. That pace depended on a clear design and an existing harness; most items below need both built first.

## 1. Phases

```
P0 Measure & foundations ──► P1 Platform ──► P2 Dynamic world MVP ──► P3 Factory MVP ──► P4 Ecology MVP
        │                        │                                                         │
        └── simulator, zone map, catalog survey (offline, start immediately)               ▼
                                 P5 Vehicles at scale ──────────────► P6 Scale & hardening ──► P7 Content, economy, social ──► P8 Launch
```

### P0 — Measure and foundations (no gameplay changes)
| ID | Item | Doc | Size | Done when |
|---|---|---|---|---|
| P0.1 | **Server-class test box** (owner decision) | [02 §8](02-scale-model-and-budgets.md) | — | Available for scale gates |
| P0.2 | Headless **bot fleet** (Rust protocol sessions) + scenario scripts (town idle, hunting, teleport storm, siege crowd, flight corridor) | [10 §8](10-server-runtime-and-scaling.md) | M | 1,000 bots connect from one machine |
| P0.3 | **Always-on telemetry** (H16): world-loop phases, landblocks, GC, DB queue, bytes/s; Prometheus + dashboards | [10 §3](10-server-runtime-and-scaling.md) | M | Dashboards live on the dev server |
| P0.4 | **Baseline measurements**: serial cost per player, the O(N²) curve, **landblock group sizes** (the percolation of [10 H17](10-server-runtime-and-scaling.md)), landblock costs, GC, DB, gateway | [02 §7](02-scale-model-and-budgets.md) | M | [02](02-scale-model-and-budgets.md)'s derived numbers replaced by measured ones |
| P0.5 | **`trifecta-sim` skeleton + world-model simulator v0** (ecology field + macro economy + synthetic agents) | [03 §9](03-systems-dynamics.md), [04 §5](04-target-architecture.md) | L | 90 simulated days in minutes; first acceptance envelope evaluated |
| P0.6 | **Zone map bake**: sanctuaries, road corridors, landmark radii, habitats, deposits (from DATs and the world DB) | [06 §3](06-dynamic-world.md), [07 §7](07-factories-and-logistics.md), [08 §3](08-monster-ecology.md) | M | Reproducible bake with a `bake-source.sha256`, viewable on a map |
| P0.7 | **Building catalog survey** of base-DAT models (WorldBuilder.Terminal asset tools): looks, physics-polygon counts, damage variants | [06 §4](06-dynamic-world.md) | M | ≥ 40 coherent pieces chosen with previews |
| P0.8 | **Protocol framework v2**: HBC2 capabilities, the protocol-fragment generator for new families (C#, Rust, third-party fixtures) | [11 §5](11-network-and-interest-management.md) | M | HBC2 round-trips in C# and Rust; HBV1 unchanged |

### P1 — Platform
| ID | Item | Doc | Size | Done when |
|---|---|---|---|---|
| P1.1 | ACE landblock hardening **H1–H6** (off-thread loads for all, bring-up budget, lazy loot, observer-only adjacency, adaptive retention, wake-on-entry) | [10 §3](10-server-runtime-and-scaling.md) | L | Teleport-storm bench: 0 load-caused stalls > 50 ms |
| P1.2 | **WSS skeleton**: process, event log + snapshots (Postgres), group commit, catalog loader, admin CLI | [05](05-world-state-and-persistence.md) | L | Survives `kill -9` with ≤ 1 s of loss |
| P1.3 | **ACE adapter + bus**: lifecycle and presence events, session binding, overlay token | [04 §7](04-target-architecture.md), [10 §4](10-server-runtime-and-scaling.md) | M | The WSS tracks active zones in real time |
| P1.4 | **Gateway v1**: WebTransport (AC on datagrams, overlay on streams), WebSocket fallback, auth binding, per-IP limits, login throttle | [11 §3](11-network-and-interest-management.md), [14 §7](14-security-integrity-griefing.md) | L | Lossy-link bench **in both directions** (1–5 % loss): game-packet p99 beats the TCP path, with ACE's and the session's NAK policy tightened; 1,000 connections |
| P1.5 | **Client overlay plumbing**: HBW/HBF/HBE codecs in `holtburger-protocol`, wasm session events, the WebTransport transport, chunk cache | [12 §6](12-client-holtburger-web.md) CL-1, CL-9 | M | Overlay chunks received and cached by version |
| P1.6 | **Phase-coloured landblock scheduling (H17) + heartbeat split (H18)** | [10 §3](10-server-runtime-and-scaling.md) | L | Bench at 5,000+ resident landblocks: parallel efficiency > 50 % on the reference box (vs ~1 thread with groups) |

### P2 — Dynamic world MVP (structures, in one test region)
| ID | Item | Doc | Size | Done when |
|---|---|---|---|---|
| P2.1 | Claims (tiers, permissions, upkeep, abandonment) | [06 §5](06-dynamic-world.md) | M | Claim lifecycle end to end |
| P2.2 | Placement (validation, two-phase payment, construction), deconstruct, repair, blueprints | [06 §6](06-dynamic-world.md), [05 §5](05-world-state-and-persistence.md) | L | Requires the new **transactional ACE save method** ([05 §5](05-world-state-and-persistence.md)); crash-loop conservation test passes |
| P2.3 | **Materialization** (budgeted) + `StructurePiece` (immobile creature) + dematerialization | [04 §4](04-target-architecture.md), [10 §4.3](10-server-runtime-and-scaling.md) | L | 1,000-piece base materializes within the budget, no stall; **1,000-piece serial-cost bench** with the `StructurePiece` opt-outs ([10 §4.3](10-server-runtime-and-scaling.md)) |
| P2.4 | Client: instanced overlay renderer, collider layer, damage states, `PieceBinding`, build mode | [12](12-client-holtburger-web.md) CL-2…CL-4, CL-6 | L | 1,000-piece base: ≤ 150 draws, ≤ 1 ms on the 1070; walls block locally |
| P2.5 | **H14** movement validation (speed envelope + overlay collision on ACE's own transition) — **a gate for P2** | [14 §3](14-security-integrity-griefing.md), [13 §5](13-retail-compatibility.md) | M | A modified client cannot cross a wall; retail players in a dense base are not snapped back by walls they can see |
| P2.6 | Retail tier 0: piece budget, consistency guard, Quartermaster NPC | [13](13-retail-compatibility.md) | M | Non-capable session test (§6 there) passes |
| P2.7 | Admin tools: audit, point-in-time restore, claim actions | [05 §6](05-world-state-and-persistence.md), [14 §8](14-security-integrity-griefing.md) | M | Restore a griefed claim in < 5 min |

### P3 — Factory MVP
| ID | Item | Doc | Size | Done when |
|---|---|---|---|---|
| P3.1 | DES core (rate solver, events, integer determinism) + power grids | [07 §4](07-factories-and-logistics.md) | L | Conservation, catch-up equivalence and native-vs-wasm byte parity tests pass |
| P3.2 | T1–T2 catalog (extractors, processors, conveyors, storage, power), deposits | [07 §5](07-factories-and-logistics.md), [07 §7](07-factories-and-logistics.md) | M | — |
| P3.3 | Machine I/O sagas; panels | [05 §5](05-world-state-and-persistence.md), [12 §3.6](12-client-holtburger-web.md) | M | — |
| P3.4 | Client belt renderer (closed-form) + wasm descriptors | [12 §3.4](12-client-holtburger-web.md) CL-5 | M | 50k belt items ≤ 0.5 ms/frame on the 1070 |
| P3.5 | Disturbance output → D field | [07 §8](07-factories-and-logistics.md) | S | — |
| P3.6 | **First-hour script** playable solo | [07 §9](07-factories-and-logistics.md) | — | Owner playtest |

### P4 — Ecology MVP
| ID | Item | Doc | Size | Done when |
|---|---|---|---|---|
| P4.1 | Field model live (2 species: drudges, Olthoi), threat levels | [08 §4](08-monster-ecology.md), [08 §6](08-monster-ecology.md) | M | Matches the simulator on a replayed snapshot |
| P4.2 | Nests (overlay structures, tiers, hardened cores) | [08 §5](08-monster-ecology.md) | M | — |
| P4.3 | Raid director (attraction, flow fields, warnings) | [08 §7.1](08-monster-ecology.md) | L | — |
| P4.4 | ACE **siege behaviour** + ecology generator + spawn orders | [10 §4.4](10-server-runtime-and-scaling.md) | L | Raiders break walls, follow routes, never leash home |
| P4.5 | Abstract resolution + **calibration harness** (headless materialized vs abstract) | [08 §7.3](08-monster-ecology.md) | M | Expected outcomes within tolerance |
| P4.6 | Client: threat map, raid warnings, **entityArena** + raid prefetch | [12 §3.6](12-client-holtburger-web.md), [12 §3.7](12-client-holtburger-web.md) CL-8 | XL | 100-monster raid ≤ 300 draws |
| P4.7 | Offline protection rules | [06 §7](06-dynamic-world.md) | M | A 30-day absence with prepaid upkeep simulated: core survives |

### P5 — Vehicles at scale and integration
| ID | Item | Doc | Size |
|---|---|---|---|
| P5.1 | V1 airspace transit | [09 §4.1](09-vehicles-airpower-ordnance.md) | L |
| P5.2 | V2 vehicle simulation thread | [09 §4.3](09-vehicles-airpower-ordnance.md) | M |
| P5.3 | V3 low-band load budget + cheap shells | [09 §4.2](09-vehicles-airpower-ordnance.md) | M |
| P5.4 | V5 strikes on abstract zones (WSS ordnance) | [04 §4.5](04-target-architecture.md) | M |
| P5.5 | V4 hull and component model + flak turrets | [09 §5](09-vehicles-airpower-ordnance.md) | L |
| P5.6 | V6 persistence, hangar recipe, fuel and ammo economy | [09 §6](09-vehicles-airpower-ordnance.md) | L |
| P5.7 | V8 client: instanced airframes, observers, radar | [09 §9](09-vehicles-airpower-ordnance.md) | M |

### P6 — Scale and hardening
| ID | Item | Doc | Size | Done when |
|---|---|---|---|---|
| P6.1 | H7 (ObjectMaint lock), H8 (broadcast economy), H9–H10 (sessions, outbound threads) | [10 §3](10-server-runtime-and-scaling.md) | L | O(N²) curve flattened per P0.4's measurement |
| P6.2 | H11 DB group commit, H12 GC | [10 §3](10-server-runtime-and-scaling.md) | M | GC p99 ≤ 50 ms; save queue bounded |
| P6.3 | **Load governor + portal storms** (H13) | [10 §6](10-server-runtime-and-scaling.md) | M | Siege-crowd bench sheds without stalls |
| P6.4 | **1,000-bot 24 h soak** on shape A, with humans on the 1070 | [02 §6](02-scale-model-and-budgets.md) | — | p99 loop ≤ 50 ms, no stall > 250 ms, conservation clean |

### P7 — Content, economy, social
- The species roster.
- Catalog breadth (T3–T4).
- Research and tiers.
- Markets and terminals.
- Allegiance relations and war.
- Contested regions.
- Titles and Crisis events.
- Tuning passes through the simulator.
- A closed beta.

Specified in [07](07-factories-and-logistics.md), [08](08-monster-ecology.md) and [15](15-economy-progression-social.md).

### P8 — Launch and live operations
- Runbooks: restarts, backups and restores, governor overrides.
- **Operating budget**: hosting for the reference box, egress of 64–200 Mbit/s ([02 §6.3](02-scale-model-and-budgets.md)), backups. An owner decision (R21).
- **Operations staffing**: admins and GMs to run the [14 §8](14-security-integrity-griefing.md) tools (claim disputes, restores, griefing reports), Crisis-event approvals and the weekly reports (R22).
- Weekly economy and ecology reports.
- Seasonal forcing calendar.

## 2. Workstreams (parallel tracks)

| Track | Scope | Main docs | Interfaces with |
|---|---|---|---|
| **WS-A ACE** | Hardening H1–H18, adapter hooks, `StructurePiece`, siege AI, airspace transit | [10](10-server-runtime-and-scaling.md), [09](09-vehicles-airpower-ordnance.md) | WS-B (bus), WS-C (sessions) |
| **WS-B WSS + sim** | Store, event log, DES, ecology, raid director, AOI publisher, `trifecta-sim` | [04](04-target-architecture.md), [05](05-world-state-and-persistence.md), [07](07-factories-and-logistics.md), [08](08-monster-ecology.md) | WS-A, WS-C, WS-D (wasm sim) |
| **WS-C Edge + protocol** | Gateway, WebTransport, HBC2/HBW/HBF/HBE, codecs and fixtures | [11](11-network-and-interest-management.md) | Everyone |
| **WS-D Client** | Overlay renderer, collider layer, belts, build mode, panels, maps, entityArena, airframes | [12](12-client-holtburger-web.md) | WS-B, WS-C |
| **WS-E Content + data** | Zone map, catalog, species profiles, recipes, deposits, ecology weenie variants | [06](06-dynamic-world.md), [07](07-factories-and-logistics.md), [08](08-monster-ecology.md) | WS-B, WS-G |
| **WS-F Tools + ops** | Bots, telemetry, dashboards, admin tools, runbooks, backups | [10 §8](10-server-runtime-and-scaling.md), [14 §8](14-security-integrity-griefing.md) | Everyone |
| **WS-G Design + tuning** | Simulator scenarios, balance, economy reports, playtests | [03](03-systems-dynamics.md), [15](15-economy-progression-social.md) | WS-B, WS-E |

## 3. Critical path
1. **P0.1 (a server box) → P0.4 (measurements, including group percolation) → P1.6 (phase-coloured scheduling) →
   P6.4 (the 1,000 claim).** Without the box, the scale claim cannot be verified. Without H17, ACE's landblock work
   runs on about one thread at the projected scale.
2. **P0.8 → P1.3 / P1.4 / P1.5 → P2.x**: protocol and bus before any overlay feature.
3. **P1.2 → P2.2 → P3.3**: the store and sagas before anything that moves items.
4. **P2.3 (materialization) → P4.4 (siege AI)**: raids need pieces to break.
5. **P4.6 (entityArena)** is the client's longest pole and gates raids larger than ~30 monsters.

**Off the critical path, startable today**: P0.5 (simulator), P0.6 (zone bake), P0.7 (catalog survey), P0.2 (bots).

## 4. Execution rules on this project's hardware
- The laptop (8 GB) follows `~/CLAUDE.md` in every session and every agent prompt:
  - one heavy job at a time, inside `capped-build`, with ≥ 2.5 GB available first;
  - parallel agents only read, edit and run targeted single tests;
  - the orchestrator runs full gates and builds once, after merging.
- **Live ACE on the laptop** is the development server. Every fork change goes behind a server property (default off)
  and follows the fork's patch-series discipline ([10 §7](10-server-runtime-and-scaling.md)).
- **The 1070** is for client look and frame-rate gates: off-screen, batched eye tests, never server load.
- **Scale gates** (P0.4, P6.4) run only on the server-class box.

## 5. The next concrete steps (first two weeks)
1. Owner decisions on the top open questions ([17 §3](17-risks-and-open-questions.md)), above all Q17.1, the server
   box.
2. Start **P0.5**: the world-model simulator for the ecology and economy macro model, in Rust, as the first
   `trifecta-sim` code.
3. Start **P0.6** and **P0.7**: the zone-map bake and the catalog survey, both data work with existing tools.
4. Start **P0.2** and **P0.3**: bots and telemetry. They are useful immediately for the existing vehicle work too.
5. Write **P0.8**'s HBC2 spec as a protocol fragment next to `vehicles.protocol.xml`.
