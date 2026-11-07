# 17 — Risks, owner decisions, and the decision register

Status: **draft v0.1** (2026-11-03). Living document. §4 and §5 are **generated** from the other documents' "Decisions
proposed" and "Open questions" sections; regenerate after editing them (see README, "Maintaining this directory").

## 1. Risk register

Likelihood and impact: H / M / L.

| ID | Risk | L | I | Mitigation | Where |
|---|---|---|---|---|---|
| R1 | ACE cannot carry 1,000 real players even after hardening. No ACE server has published 1,000 real concurrent players with server metrics; the largest dated figure is 908 with bots | H | H | Measure first (P0.4); hardening H1–H16; governor + portal storms; fallback: lower the per-world cap and run several worlds | [02](02-scale-model-and-budgets.md), [10](10-server-runtime-and-scaling.md) |
| R2 | **No server-class hardware** for measurements and scale gates (the build box was deleted 2026-10-05) | H | H | Owner decision Q17.1; short hourly rentals for gates; bots on any spare machine | [02 §8](02-scale-model-and-budgets.md) |
| R3 | Ecology **runaway or collapse** | M | H | Simulator gating (D03.6); circuit breakers; seasonal forcing; admin controls | [03](03-systems-dynamics.md), [08](08-monster-ecology.md) |
| R4 | **Item duplication** across planes | M | H | Durable-debit-first sagas; crash-loop tests; ledgers; daily conservation reports | [05 §5](05-world-state-and-persistence.md), [14 §4](14-security-integrity-griefing.md) |
| R5 | Griefing makes the frontier hostile to solo players | M | H | Zoning; claims-only building; offline protection; reinforcement windows; audit + restore | [06](06-dynamic-world.md), [14](14-security-integrity-griefing.md) |
| R6 | Client cannot render big raids and dense bases on the 1070 | H | M | Statics-path overlay (D12.1); entityArena (XL); budgets; LOD | [12](12-client-holtburger-web.md) |
| R7 | Retail clients crash in dense bases | M | M | Piece budgets, modules, H14 consistency guard, real-retail crash tests | [13](13-retail-compatibility.md) |
| R8 | Movement validation rubber-bands honest players (one server's validation made the game "almost unplayable") | M | M | Generous slack; overlay-only scope; property-gated; retail tests | [14 §3](14-security-integrity-griefing.md) |
| R9 | The ACE fork diverges from upstream | M | M | Patch series against upstream; thin adapter; properties default off | [10 §7](10-server-runtime-and-scaling.md) |
| R10 | Scope explosion vs capacity: one owner plus agents | H | H | Phases with done-when criteria; an MVP per leg; content later; critical path first | [16](16-roadmap.md) |
| R11 | WebTransport server-side maturity in Rust | L | M | WebSocket fallback; a spike in P1.4 | [11 §3](11-network-and-interest-management.md) |
| R12 | GC pauses at 1,000 players | M | M | H12; less allocation; heavy systems outside ACE | [10 §3](10-server-runtime-and-scaling.md) |
| R13 | Abstract vs materialized outcomes differ, and players exploit it (log off to dodge raids, or stay to farm them) | M | M | Calibration harness (D08.5); conservative offline floors | [08 §7.3](08-monster-ecology.md) |
| R14 | Economic leakage into the classic game | M | M | Whitelist with caps; no NPC buy-back; telemetry | [15 §3](15-economy-progression-social.md) |
| R15 | Air power dominates ground play | M | M | Hardened nest cores; costs; flak; sortie time; bands | [03 §5.4](03-systems-dynamics.md), [09](09-vehicles-airpower-ordnance.md) |
| R16 | The base-DAT building kit looks incoherent | M | M | Survey early (P0.7); a tier-1 DAT patch later | [06 §4](06-dynamic-world.md) |
| R17 | Laptop limits (8 GB) slow development or freeze the box | H | M | `~/CLAUDE.md` rules in every session and agent; scale work off the laptop | [16 §4](16-roadmap.md) |
| R18 | Overlay store loss or corruption | L | H | Point-in-time recovery; tested restores; event log | [05 §6](05-world-state-and-persistence.md) |
| R19 | Native and wasm simulation drift | L | M | Integer arithmetic; byte-parity tests | [07 §4.2](07-factories-and-logistics.md) |
| R20 | Guild wars make PvE players feel unsafe | M | M | Opt-in wars on PvE servers; vulnerability windows; sanctuaries | [15 §5](15-economy-progression-social.md) |
| R21 | **Operating cost**: hosting the reference box and 64–200 Mbit/s of egress, against an owner who has declined paid infrastructure before | M | H | Cost estimate before P6; start at shape A on one box; size from Phase 0 data | [16 P8](16-roadmap.md) |
| R22 | **Operations staffing**: claim disputes, restores, griefing reports and Crisis approvals need people | H | M | Self-service tools; audit and restore designed for speed; GM roles | [14 §8](14-security-integrity-griefing.md), [16 P8](16-roadmap.md) |
| R23 | **Landblock groups percolate** into one at 3,000–5,000+ resident landblocks, so ACE's landblock work runs on ~1 thread at the 1,000-player scale (verified by simulation, `tools/group_percolation.py`) | H | H | H17 phase-coloured scheduling; H18 parallel heartbeats; H5 adaptive retention; measure in P0.4 | [10 §3](10-server-runtime-and-scaling.md) |
| R24 | **StructurePiece per-object costs**: a plain creature brings a 5 Hz monster tick, a serial heartbeat, monster status, landmark sight and faction scans; ×1,000 per landblock | H | M | Opt-outs (D10.10); 1,000-piece serial-cost bench in P2.3; fallback to a non-creature class (Q04.4) | [10 §4.3](10-server-runtime-and-scaling.md) |
| R25 | **Retail players snapped back by walls they cannot see** (300-piece budget vs 1,000 solids) | M | M | Perimeter-first selection; long wall modules; H14 on ACE's own transition; measure snap-backs | [13 §5](13-retail-compatibility.md) |
| R26 | **Air-battle bandwidth**: 50 visible aircraft at 10 Hz ≈ 50 kB/s per observer, 8× the budget | M | M | VehicleState distance tiers (10 / 2 / ~1 Hz) | [09 §4.4](09-vehicles-airpower-ordnance.md), [11 §4](11-network-and-interest-management.md) |
| R27 | **No atomic saves in ACE today**: per-object contexts in a parallel loop; failures swallowed | H | H | A new transactional save method (debit + txn row), failures surfaced to the saga; prerequisite of P2.2 | [05 §5](05-world-state-and-persistence.md) |
| R28 | **Air superiority decides guild wars**: aircraft razing structures with no ground counterplay | M | H | No abstract PvP strikes (materialized zones only); cores hardened against ordnance; vulnerability windows; flak; interceptors; siege engines as ground counterplay | [15 §5.1](15-economy-progression-social.md), [09 §7](09-vehicles-airpower-ordnance.md) |

## 2. The core bet, stated plainly

The design bets on three things:
1. One hardened ACE process can carry the **character plane** for 1,000+ players. That holds only if its landblock
   work stays parallel at scale (R23, H17).
2. Everything new and heavy can live **outside** it, as abstract simulation that is materialized only where observed.
3. The retail client can be kept safe with a **curated subset**.

The first is the least certain. It is why Phase 0 is a measurement campaign, and why every other system is designed
to cost ACE nothing when nobody is looking.

## 3. Owner decisions, ranked by how much they unblock

| Rank | ID | Question | Recommendation |
|---|---|---|---|
| 1 | **Q17.1** (= Q10.1) | A server-class box (or hourly rentals) for Phase 0 and scale gates? | Yes. Without it, the 1,000-player target cannot be verified |
| 2 | Q15.1 | Server type: PvE with opt-in wars, or PK-default territory? | PvE with opt-in wars, plus designated contested regions |
| 3 | Q04.1 | WSS language: Rust or C#? | Rust (one simulation core, three hosts) |
| 4 | Q04.3 / Q05.1 | Overlay store: Postgres or embedded? | Postgres |
| 5 | Q07.1 | Which factory outputs may become classic items, at what caps? | Ammunition and vendor-sold components only, capped |
| 6 | Q09.1 / Q09.2 | Flight ceiling; air-to-air PvP rules | Keep 5 km; air PvP under the same war rules as structures |
| 7 | Q06.2 | Claims gated by progression or per account? | Both: level gates for higher tiers, plus per-account limits |
| 8 | Q04.4 | Walls with retail health bars acceptable? | Yes for v1 (it reuses all of combat) |
| 9 | Q08.2 | Crisis events automatic or approved? | Proposed automatically, fired by an admin |
| 10 | Q13.1 | Distribute a tier-1 DAT patch? | Not in v1 |
| 11 | Q03.4 | How visible is the ecology model? | Coarse map for everyone; detail by scouting |
| 12 | Q15.2 | XP from building, defense or logistics? | No |

### Open questions owned by this document
- **Q17.1** A server-class box (or hourly rentals) for Phase 0 and the scale gates? Same as Q10.1. Without it the
  1,000-player target remains a derivation (R1, R2).

## 4. Decision register (generated)

<!-- BEGIN GENERATED REGISTER -->
_84 proposed decisions, 45 open questions. Generated by `tools/gen_register.py`; do not edit by hand._

| ID | Proposed decision | Doc |
|---|---|---|
| D03.1 | The expansion is designed and tuned as a stock-and-flow system with explicit loops. Each new feature declares the stocks it touches and the loop it joins. | [03](03-systems-dynamics.md) |
| D03.2 | The ecology's state is a per-zone field model (zone = landblock in v0), with logistic growth, diffusion, chemotaxis toward disturbance and nest founding as a contact process. | [03](03-systems-dynamics.md) |
| D03.3 | Front speed and doubling time are the primary tuning parameters; diffusion coefficients are derived from them (§5.2). | [03](03-systems-dynamics.md) |
| D03.4 | Raid attraction is superlinear in disturbance concentration (α > 1), so industry spreads out rather than concentrating. | [03](03-systems-dynamics.md) |
| D03.5 | Destruction is a first-class economic sink; repair and rebuild costs are tuned against factory output. | [03](03-systems-dynamics.md) |
| D03.6 | An offline world-model simulator, using the same code as the server's abstract tier, gates every tuning change. | [03](03-systems-dynamics.md) |
| D03.7 | Server load is an explicit control loop (B7) with hysteresis; overload degrades fidelity, never correctness. | [03](03-systems-dynamics.md) |
| D04.1 | Decouple persistent simulation from landblock residency. Overlay state never pins landblocks. | [04](04-target-architecture.md) |
| D04.2 | Five planes (character, world-state, vehicle, edge, insight). A new World State Service owns the overlay. | [04](04-target-architecture.md) |
| D04.3 | Two fidelities (abstract / materialized) with single-writer ownership and versioned, conservative hand-offs. | [04](04-target-architecture.md) |
| D04.4 | Structures inside ACE are in-memory, catalog-built, never ACE-persisted objects. Looks and collision come from base-DAT Setups. Damageable pieces are immobile creatures (`StructurePiece`). | [04](04-target-architecture.md) |
| D04.5 | Factories never run in ACE. Clients render flows from the overlay stream. | [04](04-target-architecture.md) |
| D04.6 | A thin in-process ACE adapter with a generated, fixture-tested bus protocol. | [04](04-target-architecture.md) |
| D04.7 | `trifecta-sim` is a single deterministic Rust core hosted by the WSS, the offline simulator and the client. | [04](04-target-architecture.md) |
| D04.8 | Deployment starts as one box (shape A) and is designed for shapes B and C. Spatially partitioning ACE is research only. | [04](04-target-architecture.md) |
| D04.9 | Overlay time is owned by the WSS. Unobserved sites catch up exactly. WSS outages suspend overlay time for factories and the ecology together. | [04](04-target-architecture.md) |
| D05.1 | The overlay has its own store (Postgres recommended); ACE persists no overlay object. | [05](05-world-state-and-persistence.md) |
| D05.2 | Event log + per-zone snapshots are the source of truth; group commit ≤ 200 ms. | [05](05-world-state-and-persistence.md) |
| D05.3 | Overlay ids are 64-bit and zone-scoped; ACE GUIDs are transient bindings only. | [05](05-world-state-and-persistence.md) |
| D05.4 | Cross-plane item moves use durable-debit-first sagas with idempotent startup reconciliation ("complete if still valid, otherwise compensate"); only commodities cross. Requires a new transactional ACE save method. | [05](05-world-state-and-persistence.md) |
| D05.5 | Point-in-time restore per claim and zone is a day-one admin capability. | [05](05-world-state-and-persistence.md) |
| D06.1 | Bedrock (DAT + world DB) is immutable. Only the overlay changes. | [06](06-dynamic-world.md) |
| D06.2 | The zone map is computed data with admin overrides. Sanctuaries use tiered buffers. | [06](06-dynamic-world.md) |
| D06.3 | Catalog pieces are base-DAT models. Custom solid models only through a DAT-patch tier. | [06](06-dynamic-world.md) |
| D06.4 | Claims are on the 24 m cell grid in four tiers, with superlinear upkeep and abandonment to ruins. | [06](06-dynamic-world.md) |
| D06.5 | Offline protection: a core floor against monster raids while upkeep is paid (prepay up to 30 days, 7-day grace), and reinforcement plus vulnerability windows against PvP. | [06](06-dynamic-world.md) |
| D06.6 | Guards are attackable creature templates using ACE's faction and FoeType machinery. | [06](06-dynamic-world.md) |
| D06.7 | No terrain deformation and no new interior cells in v1. | [06](06-dynamic-world.md) |
| D07.1 | Factories run as a deterministic discrete-event simulation over flow networks in the WSS, never in ACE. | [07](07-factories-and-logistics.md) |
| D07.2 | Commodities (kind, grade, count), not ACE items, inside logistics. Unique items only through ACE recipes at stations. | [07](07-factories-and-logistics.md) |
| D07.3 | Belts are mesoscopic (rates and shares), presented by closed-form descriptors. | [07](07-factories-and-logistics.md) |
| D07.4 | Machine ports replace inserter entities. | [07](07-factories-and-logistics.md) |
| D07.5 | Power is mana grids with brown-out. | [07](07-factories-and-logistics.md) |
| D07.6 | Turrets are immobile `StructurePiece`s that fire real ACE projectiles and spells. Short range (≤ 75 m) uses ACE's immobile-monster AI; long range (flak, long wand towers) is custom weapon code on the Hellcat's pattern. Flak never reaches the high band. | [07](07-factories-and-logistics.md) |
| D07.7 | Every catalog entry declares a disturbance output. Warding trades power for stealth. | [07](07-factories-and-logistics.md) |
| D07.8 | Deposits are deterministic, finite and regenerating, and richer in dangerous country. | [07](07-factories-and-logistics.md) |
| D08.1 | The ecology is an additive layer; classic spawns are untouched and not counted. | [08](08-monster-ecology.md) |
| D08.2 | Species are data profiles over one generic field model, using existing creature weenies plus data-only ecology variants. | [08](08-monster-ecology.md) |
| D08.3 | Nests are overlay structures with hardened cores: air strips, ground finishes. | [08](08-monster-ecology.md) |
| D08.4 | Raids are planned by attraction, routed by flow fields, telegraphed, and draw raiders from the source population. | [08](08-monster-ecology.md) |
| D08.5 | Abstract raids resolve with Lanchester-style attrition, calibrated against headless materialized raids. | [08](08-monster-ecology.md) |
| D08.6 | Threat levels drive bounties (with derivative action), air-strike tasks and Crisis events. | [08](08-monster-ecology.md) |
| D09.1 | Altitude bands with the ground-reach invariant: nothing on the ground reaches the high band. | [09](09-vehicles-airpower-ordnance.md) |
| D09.2 | Airspace transit: high-band aircraft load no landblocks. The pilot stays anchored in one landblock with relocation suspended. | [09](09-vehicles-airpower-ordnance.md) |
| D09.3 | The low band is a budgeted combat zone with a load-budget speed cap. | [09](09-vehicles-airpower-ordnance.md) |
| D09.4 | A hull and component model replaces pilot invulnerability; aircraft are attackable creature-like targets. | [09](09-vehicles-airpower-ordnance.md) |
| D09.5 | Aircraft are assembled by ACE recipe from retail items plus factory components; persisted by the WSS. | [09](09-vehicles-airpower-ordnance.md) |
| D09.6 | Sanctuaries are no-strike zones. | [09](09-vehicles-airpower-ordnance.md) |
| D10.1 | ACE remains the character plane. Hardening H1–H18 is prioritized by Phase 0 measurements. | [10](10-server-runtime-and-scaling.md) |
| D10.2 | The vehicle fork's landblock machinery (off-thread load, budget, warm-ups, short retention) becomes general infrastructure. | [10](10-server-runtime-and-scaling.md) |
| D10.3 | Lazy loot (roll on first open). | [10](10-server-runtime-and-scaling.md) |
| D10.4 | Monsters and NPCs stop loading 3×3 adjacents. | [10](10-server-runtime-and-scaling.md) |
| D10.5 | Observer position re-broadcast becomes distance- and change-driven. | [10](10-server-runtime-and-scaling.md) |
| D10.6 | The load governor, with retail portal storms as the final crowd valve. | [10](10-server-runtime-and-scaling.md) |
| D10.7 | = D09.2 (airspace transit), restated for the server plane. | [10](10-server-runtime-and-scaling.md) |
| D10.8 | Landblocks tick in 16 spatial colour phases (H17) instead of connected-component groups. | [10](10-server-runtime-and-scaling.md) |
| D10.9 | Heartbeats split into landblock-local (parallel) and global (serial) parts (H18). | [10](10-server-runtime-and-scaling.md) |
| D10.10 | `StructurePiece` opts out of monster ticks, heartbeats, monster status, landmark sight and faction scans, with a 1,000-piece serial-cost bench as its gate. | [10](10-server-runtime-and-scaling.md) |
| D11.1 | A gateway (the evolution of wsbridge) with WebTransport: AC packets on datagrams, overlay on reliable streams. WebSocket as fallback. | [11](11-network-and-interest-management.md) |
| D11.2 | Overlay data never passes through ACE. Only small, lifecycle-ordered extension messages ride in-band. | [11](11-network-and-interest-management.md) |
| D11.3 | All new message families follow the HBV1 template: namespaced, versioned, capability-gated, generated codecs, third-party fixtures. | [11](11-network-and-interest-management.md) |
| D11.4 | A capabilities-v2 handshake (HBC2) with an overlay token binds browser sessions to overlay subscriptions. | [11](11-network-and-interest-management.md) |
| D11.5 | ACE suppresses structure-piece CreateObjects for overlay-capable sessions. | [11](11-network-and-interest-management.md) |
| D11.6 | Interest rules are defined per data type, with client caches keyed by chunk version. | [11](11-network-and-interest-management.md) |
| D12.1 | Overlay pieces render through the statics path (instanced runs, merged LOD), never as EntityManager rigs. | [12](12-client-holtburger-web.md) |
| D12.2 | = D11.5, restated for the client: capable clients receive structures over the HBW stream, and ACE does not send them CreateObjects for structure pieces. | [12](12-client-holtburger-web.md) |
| D12.3 | Belts and items are closed-form, GPU-evaluated, descriptor-driven. | [12](12-client-holtburger-web.md) |
| D12.4 | Cross-rig entity instancing (entityArena) is a prerequisite for raids larger than ~30 monsters. | [12](12-client-holtburger-web.md) |
| D12.5 | = D06.7, restated for the client: no terrain deformation in v1. Decals and overlays carry craters, creep and borders. | [12](12-client-holtburger-web.md) |
| D12.6 | WebGL2 remains the substrate. WebGPU is a later option, not a requirement, consistent with the rendering re-engineering charter's N4. | [12](12-client-holtburger-web.md) |
| D13.1 | Retail tier 0 sees solid pieces, nests, turrets, raiders and NPCs as ordinary ACE objects within budget; nothing cosmetic. | [13](13-retail-compatibility.md) |
| D13.2 | Movement validation against overlay solids is mandatory for any session not sent every nearby solid piece. | [13](13-retail-compatibility.md) |
| D13.3 | Quartermaster NPCs let retail players supply and draw from factories through Give. | [13](13-retail-compatibility.md) |
| D13.4 | Raid warnings and threat notices reach retail as standard chat. | [13](13-retail-compatibility.md) |
| D14.1 | Speed envelope + overlay collision validation (H14), scoped to overlay solids; bedrock is not validated in v1. | [14](14-security-integrity-griefing.md) |
| D14.2 | Item conservation by sagas, ledgers, daily conservation reports and crash-loop tests. | [14](14-security-integrity-griefing.md) |
| D14.3 | No unlimited NPC buy-back of factory output. | [14](14-security-integrity-griefing.md) |
| D14.4 | Building only in own claims; anti-walling distance; free unstuck from foreign claims. | [14](14-security-integrity-griefing.md) |
| D14.5 | Overlay subscriptions are derived server-side from position; the client cannot ask for arbitrary zones. | [14](14-security-integrity-griefing.md) |
| D14.6 | The gateway enforces per-IP limits and login throttles, and passes real IPs downstream. | [14](14-security-integrity-griefing.md) |
| D15.1 | Industrial commodities are a separate class. Classic → industrial is open; industrial → classic goes through a capped whitelist only. | [15](15-economy-progression-social.md) |
| D15.2 | Market terminals with server-side order books, physical stock and taxes. | [15](15-economy-progression-social.md) |
| D15.3 | Allegiance relations (peace, alliance, war) live in the WSS. All PvP and targeting follows the single rule table of §5.1: eligibility = PK rules, war or a contested region; final-phase structure damage only in the window; no abstract PvP strikes; claim cores hardened against ordnance. | [15](15-economy-progression-social.md) |
| D15.4 | No new skills. Progression by research, level gates and titles. New activities give bounties and titles, not XP. | [15](15-economy-progression-social.md) |

## 5. Open questions (generated)

| ID | Open question | Doc |
|---|---|---|
| Q03.1 | Zone resolution: is one landblock right for the ecology, or 2×2 landblocks (384 m) to cut cost and smooth fronts? It affects raid targeting granularity. | [03](03-systems-dynamics.md) |
| Q03.2 | Should classic generator spawns (the retail layer) count toward P? Recommended: **no**. Classic spawns are bedrock (P1). The ecology layer only adds. | [03](03-systems-dynamics.md) |
| Q03.3 | Can player effort be measured well enough to drive bounties (B1), or do bounties simply follow threat level? | [03](03-systems-dynamics.md) |
| Q03.4 | How visible is the model? A fully visible threat map damps oscillation but removes discovery. A middle path: scouting reveals detail, and the map shows only coarse levels. | [03](03-systems-dynamics.md) |
| Q04.1 | WSS language: Rust (recommended) or C#? Owner preference, and who maintains it. | [04](04-target-architecture.md) |
| Q04.2 | Does materialization ever *request* a landblock load (the online-owner raid window)? Default no. | [04](04-target-architecture.md) |
| Q04.3 | Overlay store: Postgres (recommended for operations) or an embedded store (RocksDB / SQLite per region) for simplicity on one box? | [04](04-target-architecture.md) |
| Q04.4 | Is the `StructurePiece`-as-creature approach acceptable to the retail look? Retail shows a health bar and a name on select. Is "a wall with a health bar" acceptable, or is a non-creature damage path worth building? | [04](04-target-architecture.md) |
| Q05.1 | = Q04.3 (Postgres vs an embedded store), tracked there. | [05](05-world-state-and-persistence.md) |
| Q05.2 | Retention window for fine-grained events (storage vs investigative needs). | [05](05-world-state-and-persistence.md) |
| Q05.3 | Should ACE's `trifecta_txn` table live in the shard DB (same transaction as the inventory write: best) or in Postgres? Recommended: the shard, so debit and txn row commit atomically. | [05](05-world-state-and-persistence.md) |
| Q06.1 | Which base-DAT models make a satisfying, coherent building kit? This gates the look of the whole leg (DAT survey, pass 2). | [06](06-dynamic-world.md) |
| Q06.2 | Should claims be purchasable only with progression (to keep alts from carpeting land), or limited per account? | [06](06-dynamic-world.md) |
| Q06.3 | Player vendors: yes or no (economy impact, [15](15-economy-progression-social.md))? | [06](06-dynamic-world.md) |
| Q06.4 | Are offline protection numbers (30-day prepay, 7-day grace, K core pieces) right? Simulate in the world-model simulator ([03 §9](03-systems-dynamics.md)) and playtest. | [06](06-dynamic-world.md) |
| Q07.1 | Which outputs may leave as classic items (quarrels, scarabs, kegs), and at what rates ([15](15-economy-progression-social.md))? | [07](07-factories-and-logistics.md) |
| Q07.2 | Is "no inserters" right, or do port-only machines make layouts too trivial? A playtest question. | [07](07-factories-and-logistics.md) |
| Q07.3 | Research and unlock pacing: tied to character level, quests, or purely to factory output? | [07](07-factories-and-logistics.md) |
| Q07.4 | Do workers (placed NPCs) affect throughput, or are they cosmetic? | [07](07-factories-and-logistics.md) |
| Q08.1 | Materialization windows for absent owners: worth the server cost? | [08](08-monster-ecology.md) |
| Q08.2 | Do Crisis events (level 5) fire automatically or only with owner approval? Recommended: they are proposed automatically and fired by an admin. | [08](08-monster-ecology.md) |
| Q08.3 | Can ecology monsters ever enter classic content (roam into a town edge, enter dungeons)? Recommended: no for v1. | [08](08-monster-ecology.md) |
| Q08.4 | Species authoring: who writes the first profiles and from which creature tables (world DB creature wcids by level band)? | [08](08-monster-ecology.md) |
| Q09.1 | Is the 5 km ceiling right for gameplay, or does a lower high band (1.5–2 km) keep pilots closer to the world? | [09](09-vehicles-airpower-ordnance.md) |
| Q09.2 | Air-to-air PvP: PK-only, war-only, or designated air-combat regions? | [09](09-vehicles-airpower-ordnance.md) |
| Q09.3 | Should the high band be fully safe from the ground (current invariant), or should heavy anti-air ("sky-piercer" spells) exist late in the tech tree? | [09](09-vehicles-airpower-ordnance.md) |
| Q09.4 | Cargo aircraft: carry commodities only, or also players (airlift squads)? Squads need seats beyond the pilot (DESIGN §9 crew seats). | [09](09-vehicles-airpower-ordnance.md) |
| Q10.1 | Is a server-class box available for Phase 0? Without one, the 1,000-player claim stays a derivation. | [10](10-server-runtime-and-scaling.md) |
| Q10.2 | Portal storms during PvP sieges: exempt, or cap siege participation instead? | [10](10-server-runtime-and-scaling.md) |
| Q10.3 | Can the gateway keep browser sessions alive across an ACE restart, re-handshaking transparently? The AC protocol's session state (ISAAC, sequences) lives in ACE, so probably not without a protocol-level resume. | [10](10-server-runtime-and-scaling.md) |
| Q10.4 | Time dilation: worth a research spike, or do shedding and portal storms suffice? | [10](10-server-runtime-and-scaling.md) |
| Q11.1 | Do the extension families stay in the raw 0x09xx block, or move to the community's "one opcode + plugin-name header" convention (vehicles DESIGN §5)? Payloads would not change either way. | [11](11-network-and-interest-management.md) |
| Q11.2 | = Q10.3 (session resume across ACE restarts), tracked there. | [11](11-network-and-interest-management.md) |
| Q11.3 | Should retail clients with the Chorizite plugin (representation tier 2) receive the overlay streams? They could only through an in-band path, since the plugin speaks the AC protocol only. | [11](11-network-and-interest-management.md) |
| Q12.1 | Where does the build UI live on a 1080p HUD already dense with retail panels? It needs a UX pass. | [12](12-client-holtburger-web.md) |
| Q12.2 | OPFS or IndexedDB for the overlay chunk cache (quota behaviour in Chrome)? | [12](12-client-holtburger-web.md) |
| Q12.3 | Do retail damage-variant models exist for the candidate wall pieces? This is a DAT survey task (pass 2, with the WB.Terminal asset tools). | [12](12-client-holtburger-web.md) |
| Q13.1 | Is a tier-1 DAT patch for the expansion (custom piece models, airframe) worth distributing? The community notes that few servers use DAT patching (#worldbuilder 2025-06-01). | [13](13-retail-compatibility.md) |
| Q13.2 | The retail piece budget (300) needs crash-test data from a real retail client. | [13](13-retail-compatibility.md) |
| Q14.1 | How much slack does the speed envelope need for retail clients on bad links? Needs retail testing. | [14](14-security-integrity-griefing.md) |
| Q14.2 | Allow account sharing within households (per-IP limits) or not? | [14](14-security-integrity-griefing.md) |
| Q15.1 | Server type: PvE with opt-in wars, or PK-default territory? This determines who can attack bases. | [15](15-economy-progression-social.md) |
| Q15.2 | Should building, defense or logistics give any XP? Recommended: no. | [15](15-economy-progression-social.md) |
| Q15.3 | Trade notes and money supply: do bounties pay pyreals (inflationary) or commodities (contained)? Recommended: mostly commodities. | [15](15-economy-progression-social.md) |
| Q17.1 | A server-class box (or hourly rentals) for Phase 0 and the scale gates? Same as Q10.1. Without it the 1,000-player target remains a derivation (R1, R2). | [17](17-risks-and-open-questions.md) |
<!-- END GENERATED REGISTER -->
