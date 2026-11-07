# 08 — Monster ecology: pressure that grows, spreads and raids

Status: **draft v0.1** (2026-11-03).
Depends on: [03 systems dynamics](03-systems-dynamics.md) (the equations), [04 architecture](04-target-architecture.md), [06 dynamic world](06-dynamic-world.md), [07 factories](07-factories-and-logistics.md).
Feeds: [09 vehicles](09-vehicles-airpower-ordnance.md), [10 server runtime](10-server-runtime-and-scaling.md), [12 client](12-client-holtburger-web.md), [15 economy](15-economy-progression-social.md).

## 1. Goals

1. Monsters that **grow, spread, build and raid** at the scale of the whole continent. This is the counter-pressure
   that makes factories a struggle and gives the world a pulse.
2. **Escalation that players can read and answer**: from scouts probing a solo outpost to an Overrun region that
   needs air power ([00 §6](00-vision-and-pillars.md)).
3. **Classic spawns untouched** (P1). The ecology is an additional layer.
4. Costs bounded by **observation**, not by world size (abstract everywhere, materialized only near players).

## 2. Two layers of monsters

| | Classic layer (bedrock) | Ecology layer (new) |
|---|---|---|
| Source | World-DB generators and region encounters (165,465 encounters; median 4 per landblock) | WSS population fields and nests |
| Behaviour | ACE as today: spawn on load, leash home, re-roll on unload | Drawn from P_s(z) on materialization; raiders follow route hints; survivors return to the pool |
| Persistence | None (re-rolled) | Populations and nests persist |
| Sanctuaries | Unchanged | Never spawns there |
| Weenies | As in the world DB | Existing creature weenies, plus data-only **ecology variants** (copies with tuned XP, loot, bounty tags; no new models) |

The two layers do not interact by design. Classic encounters do not count toward P (Q03.2). The ecology never
suppresses a classic spawn.

## 3. Species profiles (data)

A species profile is a data record. The code is generic: one model, many profiles.

| Field | Meaning |
|---|---|
| Roles → weenies | scout, worker, soldier, elite, queen/boss → existing creature wcids (and ecology variants) by level band |
| Habitat H_s(z) | Preference over terrain type, height, region, distance from sanctuaries; baked per zone from the DATs |
| Growth | r (doubling time), K0, η (nest capacity boost) |
| Movement | μ (diffusion), χ (chemotaxis toward disturbance), terrain costs (water, cliffs; rivers and passes become chokepoints) |
| Appetite | κ (how disturbance feeds capacity), preferred raid targets (machines, power, walls, guards, rail) |
| Nests | Catalog entries per tier (base-DAT models: mounds, palisades, totems, spires), HP, hardened core, spawn capacity |
| Raids | θ_raid, size law (w0, γ), reach, warning time, siege tactics (break walls vs bypass, target power first) |
| Season | Phase and amplitude of the swarm cycle |
| Interactions | Competition or predation with other species (a negative term in K) |
| Rewards | Bounty tables, loot tables (ecology variants), threat-scaled bounties |

**First profiles** (to be authored from the world DB's creature tables and lore):

| Species | Character | Nests | Raid style |
|---|---|---|---|
| **Olthoi** | Fast growth, strong pull toward mana disturbance; deep wild north (the Olthoi Invasion of 2003/09) | Mounds → hives (queen) | Swarm; breaks walls; targets power |
| **Drudges** | Widespread, moderate growth, opportunistic | War camps (palisades) | Probes weak sites; loots storage |
| **Banderlings** | Forest margins | Camps, totems | Ambush logistics (rails, roads) |
| **Mosswarts** | Marsh, slow | Hummocks | Attrition on nearby sites |
| **Tuskers** | Herds; no nests; migrate seasonally | — | Trample through; avoid walls |
| **Shadows** | Event-driven; spires erupt near large disturbance at night (the Shadow Invasion of 2000/04) | Shadow spires | Night raids on the largest emitters |
| **Virindi** | Rare; drawn to mana grids | — | Disable power (brown-out raids) |
| **Viamontian raiders** | A human faction: organized, PvE stand-in for an enemy guild (the Viamontian Invasion of 2005/11) | Forts | Sieges with engineers |

## 4. The field model in practice

The equations are in [03 §3](03-systems-dynamics.md). Implementation (in `trifecta-sim`):
- **Grid**: one cell per landblock (v0), with arrays per species: P, K, N, and the shared D field. Masks: sanctuary
  (absorbing), water (impassable for most species), terrain cost.
- **Integration**: explicit time stepping every 60 s of world time. For 2D diffusion the step must satisfy
  `μ·Δt/Δx² ≤ 1/4` per species (stability). With Δx = 1 landblock and Δt = 60 s, that bound is far above any
  sensible μ (fronts move about a landblock a day), so it never binds. Chemotaxis uses upwinding.
- **Randomness**: seeded per zone and tick, so the offline simulator reproduces production exactly from a snapshot.
- **Coupling in**: disturbance emissions from the factory DES (per zone, per tick); kills reported from
  materialized play; strike damage from ordnance; nest destruction.
- **Coupling out**: threat levels, raid plans, materialization spawn orders, nest growth (overlay structures).

## 5. Nests

- **Tiers**: seedling → mature → fortified → hive/citadel. Each tier raises K and spawn capacity, unlocks raid
  roles, and adds HP and a **hardened core**.
  - The core is heavily resistant to Fire and Bludgeon (ordnance) and weak to melee and pierce. **Air strikes strip a
    nest; ground teams finish it** ([03 §5.4](03-systems-dynamics.md)).
- **Founding and growth** follow the contact process ([03 §3](03-systems-dynamics.md)).
- **Location**: nests are placed on frontier land that suits the species (habitat), off roads, outside sanctuaries
  and outside claims. A nest may grow **adjacent** to a claim: the front reaching your walls.
- **Materialized** as `StructurePiece`s of the species' faction (destructible by anyone). The client shows **creep**
  decals around large nests ([12 §3.8](12-client-holtburger-web.md)).
- **Destroying a nest** cuts local K at once (a population crash follows). It pays a tiered bounty and drops
  materials. Its zone gets a short **suppression** period: no refounding for N hours, so a cleared area stays
  cleared long enough to matter.

## 6. Threat levels and the escalation ladder

- **Per zone**: T(z) ∈ {0..5} from P/K (summed across species and weighted by level band), nest tiers present, and
  recent raid history. Hysteresis: up at a threshold, down 10 % lower.
- **Shown** on the threat map ([12 §3.6](12-client-holtburger-web.md)), coarse everywhere. Detail (species, nests) is
  revealed by scouting and recon flights.
- **Triggers by level**:
  - 2: raid warnings to nearby claims;
  - 3: regional **bounty board** (rewards rise with T and with dT/dt: derivative action, [03 §5.3](03-systems-dynamics.md));
  - 4: **air-strike tasks** (missions with payouts for verified nest damage), and ground travel warnings on roads;
  - 5: a **Crisis**, a server-wide alert and an event that may need owner approval (Q08.2).

## 7. Raids

### 7.1 Planning (the raid director, WSS)
- **Candidates**: zones where P/K > θ_raid and a nest exists within reach of an attractive target.
- **Target choice**: maximize A = D^α / distance^β over sites within reach. Cooldowns per target (no site raided more
  often than every N hours). Offline protection caps size ([06 §7](06-dynamic-world.md)).
- **Composition**: drawn from the origin's population by the species' raid roles and the nest tier. Raiders **leave
  the pool**: a raid weakens its source, which gives defenders a counter-attack window.
- **Route**: **hierarchical flow fields** toward the target. Flow fields suit hordes: one field per raid, shared by
  every raider (Supreme Commander 2's approach).
  - **Approach field**: coarse 24 m cells along the corridor, built from terrain slope and water (DATs) and bedrock
    buildings as obstacles. A 3×3-landblock corridor is 24 × 24 = **576 cells**, i.e. microseconds.
  - **Assault field**: fine cells (~1.5 m) over the target claim and its surroundings, rasterized from the overlay
    pieces' footprints. 24 m cells are coarser than a gate.
    - Gates are passable when open; walls are high-cost passable (break through) or impassable (go around), per
      species tactic.
    - About 128 × 128 ≈ 16k cells for a 192 m claim, i.e. ~1 ms per raid, recomputed when a piece falls.
- **Warning**: 2–10 minutes by species and distance, sent to claim members wherever they are, and to players near
  the route ([11 §4](11-network-and-interest-management.md)). The warning also tells capable clients which species are
  coming, so they **prefetch** the rigs ([12 §3.7](12-client-holtburger-web.md)).

### 7.2 Execution: materialized (players present)
- Spawn orders at the edge of the materialized area, at least ~120 m from any player (beyond first sight) so raiders
  walk into view instead of popping in.
- ACE runs the raiders with **siege behaviour** ([10 §4.4](10-server-runtime-and-scaling.md)):
  - follow route hints;
  - attack blocking pieces;
  - prefer the target class;
  - no home leash.
  ACE's vanilla monsters move in straight lines, give up after 2–4 s when blocked, are leashed at 96 m chase / 192 m
  home, and notice players through walls (awareness has no line-of-sight test). That is exactly why raiders need the
  new behaviour.
- **Budgets**: ≤ 200 raiders per raid, ≤ 20 materialized raids server-wide. Above that, the load governor shifts
  strength to abstract resolution ([10 §6](10-server-runtime-and-scaling.md)): fewer, stronger raiders.
- **Outcome**: kills (subtracted from P), damage to pieces (ACE-authoritative while materialized), survivors
  returned to the pool at dematerialization.

### 7.3 Execution: abstract (nobody present)
At the arrival time the WSS resolves the battle statistically. Lanchester-style attrition is the classic model:
- Raiders (n, HP h, DPS d per unit) must break the wall buffer (H_w) to reach targets, while the defense (DPS
  D_def from turrets with ammo, plus guards) fires. Solve the attrition ODE: `dn/dt = −D_def / h` while walls stand.
  Walls fall at rate n·d.
- The result: raiders killed, walls lost, then the targets' damage by the species' priorities. Seeded noise (so
  outcomes vary within a calibrated spread).
- Offline-protection floors apply ([06 §7](06-dynamic-world.md)).
- **Calibration**: run materialized raids headless (bots and ACE) against the same sites and fit the abstract
  model's coefficients until expected outcomes match ([03 §2](03-systems-dynamics.md) rule 2). It is a recurring
  test, not a one-off.

### 7.4 Raids in transit
A raid on its route has a closed-form position. If it crosses into a materialized zone (a player wanders into its
path), it **materializes mid-route** at its current position, out of view where possible. If its zone dematerializes
mid-fight, survivors resume the abstract route.

## 8. Materialization windows for absent-but-online owners (option, off by default)
An owner online elsewhere may want to watch a raid on their base. Option: with a raid warning, the owner can
**request a materialization window**, the one budgeted exception to "overlay never pins landblocks"
([04 §3](04-target-architecture.md) rule 4). The landblock loads for the raid's duration through the off-thread
loader, and the owner can fly in to fight. The window costs the server ([02](02-scale-model-and-budgets.md)), so it is
rationed per player per day. Q08.1.

## 9. Ecology and the other legs
- **Factories**: disturbance feeds K and attraction ([07 §8](07-factories-and-logistics.md)). Warding lowers it.
  Explosions and gunfire add to it. **Fighting makes noise.**
- **Vehicles**:
  - Nests are strike targets; strikes on non-materialized zones are applied to the WSS's records
    ([04 §4.5](04-target-architecture.md)).
  - Raiders cannot reach the high band (P4).
  - Low-level strafing is exposed to ranged raiders (monster missile cap ~77.7 m, spells 75 m) and to flak.
- **Classic play**: ecology monsters are huntable for XP and loot (ecology variants keep classic XP curves sane).
  Roads in Infested zones are dangerous, which is where escorts and convoys come from.

## 10. Costs (from [02 §6.2](02-scale-model-and-budgets.md))
- **Field**: ~10 MB; one 60 s tick ≈ 650k zone-species updates, a fraction of one core.
- **Raid planning**: ≤ 1,000 raids/hour, negligible.
- **Materialized raids**: bounded by the ACE budgets above; the dominant cost, governed by B7.

## 11. Decisions proposed
- **D08.1** The ecology is an additive layer; classic spawns are untouched and not counted.
- **D08.2** Species are data profiles over one generic field model, using existing creature weenies plus data-only
  ecology variants.
- **D08.3** Nests are overlay structures with hardened cores: air strips, ground finishes.
- **D08.4** Raids are planned by attraction, routed by flow fields, telegraphed, and draw raiders from the source
  population.
- **D08.5** Abstract raids resolve with Lanchester-style attrition, calibrated against headless materialized raids.
- **D08.6** Threat levels drive bounties (with derivative action), air-strike tasks and Crisis events.

## 12. Open questions
- **Q08.1** Materialization windows for absent owners: worth the server cost?
- **Q08.2** Do Crisis events (level 5) fire automatically or only with owner approval? Recommended: they are
  proposed automatically and fired by an admin.
- **Q08.3** Can ecology monsters ever enter classic content (roam into a town edge, enter dungeons)? Recommended: no
  for v1.
- **Q08.4** Species authoring: who writes the first profiles and from which creature tables (world DB creature wcids
  by level band)?
