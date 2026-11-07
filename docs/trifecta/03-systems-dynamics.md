# 03 — Systems dynamics: the world as a coupled feedback system

Status: **draft v0.1** (2026-11-03).
Depends on: [00 vision](00-vision-and-pillars.md).
Feeds: [07 factories](07-factories-and-logistics.md), [08 ecology](08-monster-ecology.md),
[09 vehicles](09-vehicles-airpower-ordnance.md), [15 economy](15-economy-progression-social.md),
[10 server runtime](10-server-runtime-and-scaling.md) (the load governor).

## 1. Why model it this way

Sandbox MMOs with building and growing threats usually fail in one of two ways.
- **Runaway.** One stock grows without bound: monsters overrun everything, factories cover the map, items inflate.
- **Collapse.** One stock goes to zero: the monsters are farmed out, the frontier is empty, the market dies.

Both are properties of the **loop structure**, not of any single feature, so they cannot be tuned away feature by
feature. This document defines the stocks, the flows and the feedback loops of the expansion. It names the parameters
that control each loop and the method for tuning them before players do it for us ([§9](#9-tuning-method-the-world-model-simulator)).

The trifecta maps cleanly onto a control system:

| Control-system role | In the game |
|---|---|
| The plant (what grows) | Industry: factories, structures, logistics |
| The disturbance / balancing feedback | The monster ecology, plus hostile guilds |
| The controllers | Players: builders, defenders, hunters |
| The **high-gain actuator for large errors** | Vehicles and ordnance |
| The set-point / policy | Zoning, caps, seasons (owner-set) |
| The sensors | Threat map, alerts, scouting (information delay is a stability parameter) |

## 2. State: the stocks

The ecology and industry operate on a grid of **zones**. Version 0 uses one zone per landblock (192 m): 65,025 zones,
of which ~38,700 have land ([02 §2](02-scale-model-and-budgets.md)). A zone's state is a few dozen numbers, so the
whole world's macro state fits in a few megabytes.

| Stock | Symbol | Unit | Scope | Persists |
|---|---|---|---|---|
| Monster population of species *s* | P_s(z) | threat points (TP; a level-scaled head count, e.g. 1 TP ≈ one level-10 drudge) | zone | yes |
| Nests / hives / war camps of species *s* | N_s(z) | nest biomass | zone | yes |
| Disturbance | D(z) | disturbance units | zone (diffusing field) | yes (decays) |
| Built mass | B(z) | build points (sum of piece HP-weights) | zone | yes |
| Defense rating | Def(z) | TP-equivalent per raid | zone (derived from turrets, walls, guards, ammo on hand) | derived |
| Resource deposits | R_k(z) | units of resource *k* | zone | yes (depletes / regenerates) |
| Industrial capacity | I(z) | throughput-weighted machine count | zone | derived |
| Commodity stocks | C_k | units | world (market + inventories) | yes |
| Currency supply | M | pyreals (+ trade notes) | world | yes (ACE) |
| Player effort allocation | E(z) | player-hours per day | zone | observed, not stored |
| Server load | L | % of budget | process | live |

Two rules make the abstract model meaningful to direct play.
1. **Conservation across fidelity.** When a zone is materialized (players present, [04 §3](04-target-architecture.md)),
   real ACE monsters are drawn from P_s(z). Every one killed is subtracted, and survivors return to the pool when the
   zone dematerializes. A kill on foot moves the macro world, and the macro world decides what you meet.
2. **Same rules, two resolutions.** An abstract raid and a materialized raid of equal strength against equal defenses
   should have the same expected outcome. This is calibrated by running materialized raids headless against abstract
   resolution ([08 §8](08-monster-ecology.md)).

## 3. Flows (v0 equations: simple, tunable, replaceable)

Per ecology tick Δt (v0: 60 s of world time).

**Monster growth** (logistic, with capacity raised by nests and attracted by industry):

    dP_s/dt = r_s · P_s · (1 − P_s / K_s(z))  +  migration  −  kills  −  raid losses
    K_s(z)  = K0_s · H_s(z) · (1 + κ_s · D(z)) · (1 + η_s · N_s(z))

H_s(z) is static **habitat suitability** from terrain type, elevation and region: Olthoi like open plains, mosswarts
like marsh. It is baked once from the DATs. κ_s is how strongly the species is fed or attracted by disturbance, and
η_s how much nests raise local capacity.

**Migration** is diffusion plus **chemotaxis** toward disturbance (a Keller–Segel term):

    migration = μ_s · ∇²P_s  −  χ_s · ∇·(P_s · ∇D)

Monsters spread out where crowded and drift **up the disturbance gradient**, toward industry. Swarms, fronts and
sieges come out of this one term. Sanctuary zones are absorbing boundaries: population that enters dissipates, so
nothing accumulates against a town wall unless a Crisis event says so.

**Nest founding** (a contact process):

    rate of new nests in z  =  ν_s · max(0, P_s(z)/K_s(z) − θ_nest)  +  ν'_s · Σ_neighbours N_s(z')

Crowding founds nests, and existing nests seed neighbours. Nests are **physical** when materialized ([08 §5](08-monster-ecology.md)).
Destroying them is the main way to push a front back.

**Disturbance**:

    dD/dt = Σ emissions(z)  −  λ · D  +  δ · ∇²D

Emissions come from machines (per unit of throughput), explosions, sustained gunfire, aircraft engines at low
altitude and power plants. The decay time 1/λ is hours, so turning a factory off quiets it the same evening, not
instantly.

**Raids** launch from zones where P exceeds a fraction of K, toward the highest-attraction target within reach:

    raid launch rate  ∝  max(0, P_local/K − θ_raid) · A(target)
    A(target)         =  D(target)^α / distance^β        (α > 1: superlinear in concentration)
    raid size W       =  w0 · P_local^γ, drawn from P (raiders leave the pool; survivors return or settle)

**Industry** grows through players' investment, limited by land, upkeep, power and the raid tax:

    net output of a site  ≈  gross output − upkeep(B) − repairs(raid damage) − ammo(defense use)

## 4. The loop map

```
                    (+)                        (+)
   INDUSTRY I ───────────► DISTURBANCE D ─────────────► MONSTER CAPACITY K, ATTRACTION A
      ▲  ▲                     │ (−) decay λ                    │ (+)
      │  │(+) demand            ▼                                ▼
      │  └───────── REPAIRS, AMMO, WALLS ◄──(+)── RAIDS W ◄── POPULATION P ──(+)──► NESTS N ──(+)──┐
      │                    (B4: destruction is the sink)   ▲  │(−)            ▲        │            │
      │                                                    │  │ kills          │ (+)   └────────────┘
      │                                                    │  ▼                │        R2: nests seed nests
      │                                        DEFENSE Def ┘  PLAYER EFFORT E ─┘ (bounties, loot, threat map)
      │                                                          │(+)
      └──── fuel, ammo, parts ◄──── VEHICLES / ORDNANCE ◄────────┘ (high-gain response to Overrun)
```

| Loop | Type | Path | What it does | Main knobs |
|---|---|---|---|---|
| **R1** industrial spiral | reinforcing | I → D → raids → demand for walls, ammo, repairs → I | Pressure creates demand for production; the factory game has a reason to grow | κ, α, raid size w0 |
| **R2** infestation | reinforcing | N → more N (contact process); P → N → K → P | Unchecked fronts grow exponentially; this is the "out of control" engine | ν, ν', η, θ_nest |
| **R3** self-replicating industry | reinforcing | output → more machines → more output | Factorio's core joy; exponential if unbraked | build costs, power, land |
| **B1** predation | balancing | P ↑ → rewards and threat ↑ → player effort E ↑ → kills → P ↓ | Players thin populations where it matters | bounty pricing, loot, XP |
| **B2** quiet decays | balancing | D decays with λ; I off → D ↓ → raids ↓ | A quiet base is left alone eventually | λ, δ |
| **B3** carrying capacity | balancing | P → K | Bounds growth per zone | K0, H |
| **B4** destruction is the sink | balancing (economy) | raids and PvP destroy B → materials consumed → prices hold | Without destruction, factory output floods the market | HP, repair costs |
| **B5** air response | balancing (high gain, delayed) | Overrun → strikes → N ↓, P ↓ | Large errors are corrected fast at high cost | ordnance yield and cost, sortie time |
| **B6** upkeep | balancing | B ↑ → upkeep ↑ → net output ↓ | Limits sprawl; clears abandoned bases | upkeep curve |
| **B7** load governor | balancing (server) | materialized load L ↑ → coarsen sim / shed / dilate → L ↓ | Keeps the server inside its budget | budget, hysteresis |

## 5. Loop analysis

### 5.1 Industry versus the raid tax: where factories stop growing (R3 vs B4, B6)
Self-replicating industry grows exponentially (R3). Three brakes act on it, and the design makes them **superlinear**
in size so that diminishing returns appear on their own. A mega-base attracts disproportionately more raids
(α > 1) and pays rising upkeep, so a guild does better with several medium sites spread across the map. That spread
is exactly what makes the world feel inhabited.

- Equilibrium site size I* is where marginal output equals marginal raid tax plus upkeep. With A ∝ D^α and D ∝ I,
  the raid tax ∝ I^α. Output ∝ I, so I* is finite for any α > 1 and shrinks as α grows.
- Tuning target (v0, to be simulated): a well-run solo site stabilizes at the "small" tier, and a guild site at
  roughly 10× that before splitting pays better.

### 5.2 Infestation fronts: speed is a design parameter (R2 vs B1, B5)
Logistic growth plus diffusion is the Fisher–KPP equation. An unresisted front advances at a speed that can be
chosen directly:

    c* = 2 · √(r · μ)

So the designer picks **how fast an unopposed infestation spreads** and **how fast a population doubles**, and the
diffusion coefficient follows. Example: doubling time 12 h (r = ln 2 / 0.5 day ≈ 1.39 / day) and target front speed
1 landblock per day give μ = c*² / (4r) ≈ 0.18 landblock² / day. Resistance (kills, nests destroyed) slows or reverses
the front locally. The front is where play concentrates, which turns an abstract number into a moving line on the
map for the community to rally against.

Nest seeding (ν') makes the front **pushed** rather than pulled: it can jump. Keep ν' small relative to ν, or fronts
become unpredictable and stop being readable.

### 5.3 Players as predators, with delay (B1)
Player effort is not a population. It is attention, and it responds to incentives (bounties, loot, XP, threat to
one's own base) with a **delay**: noticing, organizing, travelling. Predator–prey systems with delay oscillate. That
is desirable at moderate amplitude (infestation seasons are drama) and dangerous at large amplitude (boom and bust).
Damping levers:
- **Reduce information delay**: the threat map, raid warnings, and nest intel from scouts and recon flights.
- **Price incentives on the gradient**: bounties rise with the zone's threat level and with the rate it is
  *increasing* (derivative action in PID terms). Players arrive before the front peaks.
- **Telegraph raids** (a 2–10 minute warning) so defenders can respond. A raid that lands unannounced on an online
  player is a surprise; one that lands every night on an offline player is a griefing mechanism ([06 §7](06-dynamic-world.md)).

### 5.4 Air power as a high-gain actuator (B5)
Aircraft remove large errors quickly: a hive cluster burned in one sortie. High gain with delay invites overshoot.
If strikes are cheap and fast, Overrun never persists, the ground game around it never happens, and players learn
to bomb everything. Guards:
- Ordnance is **expensive and produced** (fuel, bombs, airframes come from factories; B5 runs back through R1).
- Strikes **reduce N and P**; they do not zero a zone. Nests have hardened cores that ground teams must finish, so
  air power opens a window and the ground holds it.
- Sortie time is real: fly out, return, rearm (6 s parked in the demo; minutes in the economy design).

### 5.5 The economy's sink is destruction (B4)
In a world where factories run unattended, production faucets are continuous. Prices stay meaningful only if sinks
scale with output. The strongest sink is **loss**: walls broken by raids, turrets that need ammo, aircraft shot down,
bases sieged by enemy guilds. P2 (malleability) and P3 (pressure) are therefore not just content; they are the
economy's stabilizers. A frontier without destruction is an inflation machine ([15](15-economy-progression-social.md)).

### 5.6 Server load as a stock (B7)
Server cost is dominated by **materialized** zones: real ACE monsters, physics, landblocks
([02](02-scale-model-and-budgets.md)). Player concentration drives materialization. Large battles concentrate players,
and the load governor must close the loop without flapping. **Its single specification is [10 §6](10-server-runtime-and-scaling.md)**:
- four steps with engage and release thresholds and minimum dwell times:
  1. observer rates and the ecology radius;
  2. abstract raid strength and AI rate;
  3. portal storm brewing;
  4. portal storm (retail AC's own crowd valve, [01 §2](01-technology-audit.md));
- time dilation (EVE Online's model) is a research item there, not a v1 step.

## 6. Spatial dynamics worth designing for

- **Fronts and lines.** Reaction–diffusion produces readable lines on a map. Present them: the threat map draws the
  front.
- **Chokepoints.** Rivers, mountains and the sea modulate μ (migration cost by terrain). Bridges and passes become
  strategic. They come straight from the DAT terrain and need no authoring.
- **Percolation of safety.** Defended zones that form a connected cluster make safe corridors (roads, rails).
  Disconnected outposts are islands. Logistics wants connected clusters; guilds cooperating create them.
- **Sanctuaries as anchors.** Absorbing boundaries keep classic towns stable and give every front a place where it
  cannot win (P1).

## 7. Time-scale separation

| Scale | Process | Simulation tier |
|---|---|---|
| 33 ms – 1 s | Combat, movement, projectiles, vehicles | ACE (materialized), vehicle sim at 30 Hz |
| 1 – 10 min | A raid; a factory buffer filling; a sortie | Event-driven factory sim; raid controller |
| 1 – 24 h | Disturbance decay; nest founding; population doubling | Ecology tick (60 s) |
| days | Front movement; territory change | Emergent from the above |
| weeks | Seasons, wars, economy cycles | Forcing terms (season multiplier on r), owner events |

The separation lets each tier run at its own rate. The 60 s ecology tick over ~39,000 land zones costs microseconds
per zone; the whole world costs less per minute than one busy landblock does per second.

## 8. Forcing, seasons and events

- **Seasonal forcing.** Multiply r_s by a slow periodic term (e.g. a 28-day cycle with a swarm week). Players learn
  the rhythm and prepare; that is a forced oscillator, and its phase is predictable.
- **Owner events.** Scripted perturbations in the spirit of retail's live events (an Olthoi migration, a Viamontian
  landing) are inputs to the same equations, not special-case code.
- **Circuit breakers.** A global cap on total P, per-zone caps, and an auto-damping rule. Example: if more than X % of
  the frontier sits at Overrun for more than Y hours, r is scaled down until it recovers. The rule is logged and shown
  ("the swarm is exhausted"), never silent.

## 9. Tuning method: the world-model simulator

Before any of these numbers meet players, the macro model runs **offline**.
- **What.** A headless build of the ecology, industry and economy model (the same code as the server's abstract
  tier, [04 §5](04-target-architecture.md)) driven by synthetic player agents: builder, hunter, pilot, trader and
  absentee archetypes, with behaviour rules that respond to incentives.
- **Runs.** 90 simulated days in minutes. Scenario matrix: no players; 10, 100 and 1,000 concurrent; mass absence (a
  holiday); a griefing guild; a whale guild that builds a mega-base.
- **Acceptance envelope (v0 targets, refined by playtest):**
  - in steady state, 10–30 % of the frontier at threat ≥ 3 and < 5 % at Overrun;
  - no runaway (total P bounded) and no extinction (every species present somewhere);
  - an unattended solo base with paid upkeep survives a 30-day absence with damage but no loss of its core;
  - after players leave a region, it returns to Quiet within days;
  - prices of core commodities stay within a band over 90 days.
- **Production twin.** The live server exports the same stocks hourly, and the simulator can replay from a snapshot
  to forecast ("where is the front in three days?") and to test a parameter change before applying it.

## 10. Observability (every loop has a meter)

| Loop | Metric |
|---|---|
| R1 / B4 | Commodity production vs consumption per day; repair spend; destruction volume |
| R2 | Nest count and growth rate; front position (contour of P/K > 0.5) per species |
| B1 | Kills per zone vs threat; bounty payout; player-hours per threat level |
| B5 | Sorties, ordnance consumed, nest reduction per sortie |
| B6 | Upkeep paid vs abandoned structures decayed |
| B7 | Materialized load, shed actions, time-dilation seconds, portal storms |

## 11. Decisions proposed

- **D03.1** The expansion is designed and tuned as a stock-and-flow system with explicit loops. Each new feature
  declares the stocks it touches and the loop it joins.
- **D03.2** The ecology's state is a per-zone field model (zone = landblock in v0), with logistic growth,
  diffusion, chemotaxis toward disturbance and nest founding as a contact process.
- **D03.3** Front speed and doubling time are the primary tuning parameters; diffusion coefficients are derived
  from them (§5.2).
- **D03.4** Raid attraction is superlinear in disturbance concentration (α > 1), so industry spreads out
  rather than concentrating.
- **D03.5** Destruction is a first-class economic sink; repair and rebuild costs are tuned against factory output.
- **D03.6** An offline world-model simulator, using the same code as the server's abstract tier, gates every
  tuning change.
- **D03.7** Server load is an explicit control loop (B7) with hysteresis; overload degrades fidelity, never
  correctness.

## 12. Open questions

- **Q03.1** Zone resolution: is one landblock right for the ecology, or 2×2 landblocks (384 m) to cut cost and
  smooth fronts? It affects raid targeting granularity.
- **Q03.2** Should classic generator spawns (the retail layer) count toward P? Recommended: **no**. Classic spawns
  are bedrock (P1). The ecology layer only adds.
- **Q03.3** Can player effort be measured well enough to drive bounties (B1), or do bounties simply follow threat
  level?
- **Q03.4** How visible is the model? A fully visible threat map damps oscillation but removes discovery. A middle
  path: scouting reveals detail, and the map shows only coarse levels.
