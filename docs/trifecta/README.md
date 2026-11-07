# The Trifecta expansion — system design

Status: **foundation set, draft v0.1** (started 2026-11-03). Analysis and design documents only; no code was changed.
Later refinement passes will tighten every number marked *derived* and every item marked **VERIFY**.

## The idea in one paragraph

Asheron's Call already has a seamless continent (65,025 landblocks, ~1,300 km² of land) and a deep character game.
ACE serves it and holtburger-web (Chrome) plays it. The expansion adds three things.
- **Factories**: production, conveyors, rails, power and automated defenses on the empty frontier.
- **A monster ecology**: populations grow, spread, build nests and raid in proportion to industry.
- **Air power**: aircraft and ordnance answer situations that run out of control on the ground; the high band is
  out of reach of everything on the ground.

The classic game stays intact underneath. **The core technical move** decouples persistent simulation from loaded
landblocks. In 1999 AC (and ACE after it) made "simulated" mean "loaded at full fidelity". Here the new world state
is simulated abstractly everywhere (event-driven factories, field-based ecology) and **materialized** into real ACE
objects only where players are present ([04](04-target-architecture.md)).

## Reading order

| # | Document | Answers |
|---|---|---|
| 00 | [Vision and pillars](00-vision-and-pillars.md) | What are we building, for whom, and what must never break? (P1–P7, escalation ladder, non-goals) |
| 01 | [Technology audit](01-technology-audit.md) | How old is each part of the stack, what was retail's design, what does modern practice do? |
| 02 | [Scale model and budgets](02-scale-model-and-budgets.md) | The world counted; unit costs; 1,000 players derived; why pinned landblocks fail; budgets |
| 03 | [Systems dynamics](03-systems-dynamics.md) | Stocks, flows and feedback loops; front speed; tuning with a world-model simulator |
| 04 | [Target architecture](04-target-architecture.md) | Five planes, two fidelities, materialization, the WSS, one simulation core with three hosts |
| 05 | [World state and persistence](05-world-state-and-persistence.md) | The overlay store; event log + snapshots; cross-plane item integrity |
| 06 | [Dynamic world](06-dynamic-world.md) | Zoning, claims, building catalog, destruction, offline protection, placed NPCs |
| 07 | [Factories and logistics](07-factories-and-logistics.md) | The discrete-event factory simulation, belts, power, trains, turrets, resources, disturbance |
| 08 | [Monster ecology](08-monster-ecology.md) | Species profiles, nests, threat levels, raids (flow fields, Lanchester resolution) |
| 09 | [Vehicles, air power, ordnance](09-vehicles-airpower-ordnance.md) | From the Hellcat demo to hundreds of aircraft: bands, airspace transit, hulls, economy |
| 10 | [Server runtime and scaling](10-server-runtime-and-scaling.md) | ACE's runtime, hardening H1–H18, adapter hooks, load governor, deployment |
| 11 | [Network and interest management](11-network-and-interest-management.md) | WebTransport gateway, protocol families, per-type interest rules, bandwidth |
| 12 | [Client (holtburger-web)](12-client-holtburger-web.md) | Overlay rendering, collision, belts, build mode, raids on the 1070's budget |
| 13 | [Retail compatibility](13-retail-compatibility.md) | What 1999 clients see and survive; the representation ladder per system |
| 14 | [Security, integrity, griefing](14-security-integrity-griefing.md) | Threat model, movement validation, duplication, griefing vectors, admin tools |
| 15 | [Economy, progression, social](15-economy-progression-social.md) | Faucets and sinks, the classic/industrial boundary, markets, allegiance wars |
| 16 | [Roadmap](16-roadmap.md) | Phases P0–P8, workstreams, critical path, the next steps |
| 17 | [Risks and open questions](17-risks-and-open-questions.md) | Risk register, ranked owner decisions, the generated register of all decisions and questions |
| 18 | [Scenarios and sequences](18-scenarios-and-sequences.md) | The architecture walked end to end: login, materialization, placement, raids, strikes, crowds, failures |
| — | [Glossary](GLOSSARY.md) | Terms used across the set |

Short on time? Read 00, 04 (§1–3), 02 (§4–5), 16 (§3, §5) and 17 (§3).

## Key numbers

| | Value | Source |
|---|---|---|
| Landblocks: all land / coastal / water | 32,665 / 6,024 / 26,336 | [02 §2](02-scale-model-and-budgets.md) (counted) |
| Authored outdoor content / frontier after sanctuaries | 1,657 landblocks (646 towns) / ~30,200 landblocks ≈ 1,114 km² | [06 §3](06-dynamic-world.md) (counted, `tools/world_counts.py`) |
| Encounter generators | 165,465, median 4 per landblock | [02 §2](02-scale-model-and-budgets.md) (counted) |
| Memory per loaded landblock | 0.6–1.5 MB | carry experiment (measured) |
| Landblock retention | dormant 1 min, unloaded 5 min, 3×3 per mover | [10 §2](10-server-runtime-and-scaling.md) (code) |
| ACE parallel threads | max(1, cores × 0.34); the serial section includes every player tick | [10 §2](10-server-runtime-and-scaling.md) (code) |
| Largest dated ACE population | 908 (2024-12, with bots) | [01 §3.3](01-technology-audit.md) (community) |
| Retail world capacity | ~2,000+ peak; 3,000 design; ~12–13 machines; portal storms ~35 outdoors | [01 §2](01-technology-audit.md) |
| Aircraft at 400 km/h in the low band | 1.73 landblock loads/s each; global cap 6/s today | [02 §4.1](02-scale-model-and-budgets.md) (derived) |
| holtburger-web on the 1070 | main thread ~20–23 ms/frame; ~13 µs JS per draw; humanoid ≈ 34–40 draws | [12 §1](12-client-holtburger-web.md) (measured) |

## Conventions

- **IDs**:
  - `Dnn.m` = a decision proposed in document nn; `Qnn.m` = an open question; `Rn` = a risk ([17](17-risks-and-open-questions.md)).
  - `Hn` = ACE hardening item ([10 §3](10-server-runtime-and-scaling.md)); `Pn.m` = a roadmap item ([16](16-roadmap.md)).
  - `Vn` = vehicle item ([09 §9](09-vehicles-airpower-ordnance.md)); `CL-n` = client item ([12 §6](12-client-holtburger-web.md));
    `WS-x` = workstream.
  - `P1`–`P7` = pillars ([00 §3](00-vision-and-pillars.md)).
- **Evidence labels**:
  - numbers are **measured** (with source), **counted** (from data, method given) or **derived** (formula given);
  - community quotes are `[Q]` with channel and date, attributed by role, never by name;
  - inferences are `[I]`;
  - code citations are `path:line` against the fork at `~/ace-server` (branch `vehicles-2026-11-01`) and holtburger at
    `external/holtburger`.
- **Units**: metres (AC world units), AGL = above ground level, landblock = 192 m, cell = 24 m.
- **Status words**: *proposed* (a decision awaiting owner review), **VERIFY** (a claim to check in pass 2).

## Prior work this set builds on
- Vehicles design, handoff and ACE patch series:
  `external/holtburger/apps/holtburger-web/docs/vehicles-2026-11-01/` (decisions 1–73; `ace/0001-0006`).
- The high band and flight experience: `…/docs/flight-experience-2026-11-01/` (HIGH-BAND.md, HANDOFF.md).
- The drone carry experiment (ACE streaming at speed): `…/docs/drone-deploy-2026-10-24/carry-experiment/README.md`.
- The network adapter analysis: `…/docs/network-adapter-2026-10-23.md`.
- Rust scene core and round 3 (client performance): `…/docs/2026-10-26-rust-scene-core.md`,
  `…/docs/2026-10-29-round3-gpu-driven.md`.

## Pass 2 (refinement) — what to verify first
1. ACE combat paths with an immobile `StructurePiece` creature: health bar look, no XP or loot, siege targeting,
   turret AI ([04 §4.2](04-target-architecture.md), [10 §4.3](10-server-runtime-and-scaling.md)).
2. Airspace transit as an anchor landblock with relocation suspended: ACE has no off-landblock state (verified:
   portal space keeps the player in the destination landblock). Spike: which systems read `CurrentLandblock`
   instead of `Location` ([09 §4.1](09-vehicles-airpower-ordnance.md)).
3. Server-side Rust WebTransport: two pre-1.0 crates identified (`wtransport`, `web-transport-quinn`); a P1.4 spike decides ([11 §3](11-network-and-interest-management.md)).
4. Retail tolerance of lower observer position rates (H8) ([10 §3](10-server-runtime-and-scaling.md)).
5. The building catalog DAT survey: models, physics-polygon counts, damage variants ([06 §4](06-dynamic-world.md)).
6. Phase 0 measurements to replace every *derived* number in [02](02-scale-model-and-budgets.md).

## Maintaining this directory
- Every document carries a status line.
- The design documents (03–15) end with "Decisions proposed" and "Open questions" sections in the
  `- **Dnn.m** …` / `- **Qnn.m** …` bullet form; doc 17 owns Q17.1. Documents 00–02, 16 and 18 are framing, audit,
  scale, roadmap and scenario documents without decision sections.
- Restated decisions keep their own ID and name the original (e.g. "D10.7 = D09.2").
- After editing any of them, regenerate the register: `python3 -I docs/trifecta/tools/gen_register.py`.
- Owner decisions: mark the decision **accepted** or **rejected** in its document (append "— accepted YYYY-MM-DD"),
  then regenerate.
- Numbers: when a *derived* number is measured, replace it in place and cite the measurement. Counted numbers come
  from `tools/world_counts.py` and `tools/group_percolation.py`; re-run them after DAT or world-DB changes.
- **Any agent working from these docs** follows `~/CLAUDE.md` (the laptop resource rules), and the rules go verbatim
  into every agent prompt.
