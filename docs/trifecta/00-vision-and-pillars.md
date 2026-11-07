# 00 — Vision and pillars

Status: **draft v0.1** (2026-11-03). Foundation document: later passes refine it.
Reads with: [01 technology audit](01-technology-audit.md) and [03 systems dynamics](03-systems-dynamics.md).
Feeds: every other document in this directory.

## 1. The pitch

Asheron's Call already has the hard part of an MMORPG: a seamless 49 × 49 km continent and a deep character game.
The emulator (ACE) and the browser client (holtburger-web) run it today. This expansion adds three things.

- **Factories.** Production machines, conveyors, trains, power and automated defenses, built in the empty land.
  They give solo players an endless creative game and give guilds a reason to hold land.
- **A world that pushes back.** Monster populations grow, spread, build nests and raid what players build.
- **Air power.** Aircraft and ordnance answer situations on the ground that have run out of control.

The classic game stays exactly as it is underneath all of this.

The shorthand is **the trifecta**:

| Leg | What it is | Player question it answers |
|---|---|---|
| **1. The classic game** | ACE + the retail content: quests, dungeons, character building, loot, allegiances, PK. **Intact.** | "Who is my character?" |
| **2. The vehicles** | Server-authoritative aircraft (the Hellcat demo exists, see [09](09-vehicles-airpower-ordnance.md)) and, later, ground vehicles and trains. Above ~80 m no monster can reach an aircraft; player-built flak reaches up to 600 m; the high band (600 m – 5 km) is out of reach of everything on the ground — a refuge from which ordnance can be dropped. | "What do we do when the ground is lost?" |
| **3. The factories** | Placeable machines, conveyors, rails, power, storage, walls, turrets and guards, on claimed frontier land. | "What do I build that outlasts my login?" |

The **connective tissue** turns the three legs into one game. It is the **living world**: a malleable data layer in
which anything players build can be destroyed, and a **monster ecology** whose populations grow, migrate, nest and
raid in proportion to industrial activity. The factories provoke the monsters. The monsters threaten the factories
and the roads. The aircraft are the high-gain response when the ground situation escalates. The factories in turn
feed the aircraft with fuel, ammunition and parts.

## 2. Why this fits Asheron's Call specifically

- **The land is mostly empty, and that is a resource.** Of the map's 65,025 landblocks (192 m squares), 32,665 are all
  land, 6,024 coastal and 26,336 all water: about **1,304 km² of land** (54 % of the grid's 24 m cells). 43 % of the
  land cells vary by ≤ 4 m (buildable without foundations).
- **Authored outdoor content is concentrated.** Portals, vendors, doors, lifestones and housing sit in **1,657
  landblocks**: 646 of them towns and 593 housing settlements. Everywhere else the land holds only region encounter
  generators (a median of 4 per landblock) and their monsters. Counted 2026-11-03 from the baked world grids and
  spawn files and the world-database release, with `tools/world_counts.py`; method in [02 §2](02-scale-model-and-budgets.md).
- **Retail AC changed its world through live events.** The Shadow Invasion (2000/04), the Virindi and Tumerok Invasion
  (2001/08), the Renegade Siege (2003/08), the **Olthoi Invasion** (2003/09) and the Viamontian Invasion (2005/11) all
  happened, and a live event destroyed the town of Arwic (acpedia dump, `external/acpedia`). Those changes were scripted,
  monthly and identical for everyone. The expansion makes invasion and change **systemic and continuous**, driven by
  players and by the ecology.
- **The lore already has the antagonists.** Olthoi hives that spread, drudge and banderling war camps, Shadow spires,
  Virindi incursions, Viamontian occupiers. The ecology ([08](08-monster-ecology.md)) is written as species profiles,
  so each antagonist can be a profile.
- **The owner's vehicle direction already points here.** The vehicles design
  (`external/holtburger/apps/holtburger-web/docs/vehicles-2026-11-01/DESIGN.md` §0) names several framings. Portals give
  way to vehicles. The vehicles are built from in-game items (the Hellcat is 55 retail parts: barrels, shields,
  crossbows, wands, kegs) with a WW2 mental framing. They are an expensive money sink and give a guild air control. A
  factory layer is where those parts, that fuel and that ammunition come from.

## 3. Pillars

Each pillar has a **litmus test**: a question any feature proposal must pass.

### P1 — Classic Dereth is bedrock
Nothing in the classic game is removed or rebalanced by the expansion.
- The DAT world is the bedrock layer and is **never mutated at runtime**: terrain, the authored buildings (LandblockInfo)
  and dungeons (EnvCells). The world-database spawns are also never mutated. New things are an **overlay**.
- Towns, quest hubs, dungeons, portals, lifestones and housing settlements sit in protected zones that the new systems
  do not touch ([06 §3](06-dynamic-world.md)).
- Retail clients keep connecting and playing. They see a safe, reduced representation of the new layer
  ([13](13-retail-compatibility.md)).
- *Litmus:* "Does a player who ignores the expansion lose anything they have today?" The answer must be no. That
  includes the world being unplayable around them, so escalation is bounded around sanctuaries.

### P2 — The frontier is malleable
On frontier land everything players build can be damaged and destroyed, and everything monsters build (nests, hives,
war camps) can be destroyed too.
- Destruction is real (HP, damage types, collapse) and persistent. So is rebuilding.
- Players and monsters can place and kill NPCs (guards, workers, vendors).
- *Litmus:* "Can this thing be lost?" If it can never be lost, it is either bedrock (P1) or a bug.

### P3 — Pressure scales with ambition
The world pushes back in proportion to what you do to it. Small, quiet builds draw little attention. Large industry
draws raids, and unchecked monster growth becomes infestation. This is the balancing feedback loop that keeps
exponential factory growth from filling the map ([03](03-systems-dynamics.md)).
- *Litmus:* "What does this provoke?" Every industrial feature declares its disturbance output, and every monster
  feature declares what it responds to.

### P4 — Escalation always has an answer, and the answer costs
When a region is lost on the ground (to monsters or to an enemy guild), the sky is the answer. Aircraft fly above
everything on the ground and drop ordnance. That answer consumes fuel, ammunition and airframes, which factories
produce. So the escalation loop runs back through the economy.
- Ground threats never reach the high band. That is an **invariant**: monster missiles are capped at 85 yd ≈ 77.7 m
  (ACE `Creature_Missile` `MissileRangeCap`) and monster spells at 75 m (vehicles DESIGN §4.7). The sky is contested
  only by other aircraft and by purpose-built anti-air.
- *Litmus:* "When this goes wrong at scale, what is the player's answer, and what does it cost?"

### P5 — Interdependence makes people matter
At scale no single player can be self-sufficient. Factories need raw materials from adventurers. Defenses need ammo
from logistics. Aircraft need fuel, parts and pilots. A region under siege needs guilds to cooperate. Social bonds
become valuable again because the world is hostile and enemy guilds are real.
- *Litmus:* "Does this create a reason to need another player?" It must not force one at small scale (see P6).

### P6 — Solo-friendly at small scale, social at large scale
One player can claim a plot, build a small factory, defend it against proportionate raids and enjoy it as a
single-player game. Offline protection rules keep a solo base from being erased while its owner sleeps ([06 §7](06-dynamic-world.md)).
Ambition beyond a solo-sized footprint is where guilds come in.
- *Litmus:* "Is the first hour fun alone?" "Is the hundredth hour better with friends?"

### P7 — Measured, server-authoritative, degrades gracefully
Every new system has a cost model and a budget ([02](02-scale-model-and-budgets.md)). The server owns all state.
Overload slows or coarsens the simulation; it never freezes it or corrupts state. This continues the vehicles work's
"correct, never freeze" and "measure before and after" principles.
- *Litmus:* "What does this cost per player, per landblock, per second? What happens at 10× load?"

## 4. Who plays it (fantasies and roles)

| Role | Core activity | Depends on |
|---|---|---|
| **Classic adventurer** | Quests, dungeons, leveling, loot (unchanged) | Nothing new; benefits from safer roads and trade goods |
| **Engineer / builder** | Claims land, designs factories, optimizes throughput | Raw materials (adventurers, extractors); defense (defenders, pilots) |
| **Defender** | Designs walls, turrets and guards (tower defense); repairs after raids | Ammo and materials (engineers); intel (scouts, pilots) |
| **Hauler / trader** | Moves goods by cart, train or cargo aircraft; runs markets | Routes kept safe; demand from everyone |
| **Pilot** | Air superiority, strike missions on nests and infestations, escort, recon | Fuel, ammo and airframes (engineers); targets (scouts, ecology) |
| **Exterminator / hunter** | Clears nests and war camps on foot; bounty hunting | Intel; supply; occasionally air support |
| **Guild leader** | Holds territory, coordinates sieges and defense, sets doctrine | All of the above |

A player moves freely between roles. Nothing here is a new class: it all sits on top of the existing skill system
([15](15-economy-progression-social.md)).

## 5. Core loops

- **Micro (minutes).** Gather or buy inputs → place machines → connect them with conveyors → watch throughput →
  tune. Raid warning → man the walls → repair.
- **Meso (hours to days).** Expand the factory, unlock higher tiers, run supply routes, clear nests that threaten the
  site, build an air wing, trade surplus.
- **Macro (weeks).** Territories form and fall. Infestation fronts advance and are pushed back. Guild wars over
  resource-rich land. Seasonal migrations and surges. The map at the end of a month looks different from the start.

## 6. The escalation ladder

The world's state per zone is a **threat level** computed by the ecology ([08](08-monster-ecology.md)). It is visible
on the map, so the community can organize around it.

| Level | Name | On the ground | Intended answer |
|---|---|---|---|
| 0 | Quiet | Classic spawns only | — |
| 1 | Stirring | Scouts probe structures; small raids | The builder's own defenses |
| 2 | Raided | Regular waves against industry in range of a nest | Better defenses; clearing the nest on foot |
| 3 | Infested | Nests multiply; roads become dangerous; raids hit undefended sites | Organized ground expeditions; supply escorts |
| 4 | Overrun | Ground travel is lethal; nests fortify; hives grow | **Air strikes** on hives; airlifted strike teams; cordon defenses |
| 5 | Crisis (rare) | A front threatens a sanctuary edge; server-wide alert | Server-wide event: everyone's role matters |

Hostile guilds create the same ladder by other means: sieges, blockades, raids on logistics. The same answers apply:
walls, escorts, and finally air superiority.

Sanctuaries (P1) cap the ladder at their edge. A Crisis besieges a sanctuary's perimeter but never spawns inside it.

## 7. Non-goals (for this expansion's first version)

- Mutating DAT terrain or DAT buildings (no terrain deformation; craters are cosmetic overlays; P1).
- Voxel or free-form geometry. Building uses a grid and snap rules with a fixed catalog of parts.
- Full-loot open PvP everywhere. PvP stays opt-in through existing PK rules and territory-war rules ([15](15-economy-progression-social.md)).
- Feature parity for retail clients. They get a safe subset ([13](13-retail-compatibility.md)).
- Changing classic character progression, loot tables or quests.
- Client authority of any kind. The client predicts and renders; the server decides.

## 8. What success looks like (targets the later passes must turn into tests)

| Target | Measure |
|---|---|
| 1,000+ concurrent players on one world, with classic play feeling unchanged | World-tick p99 ≤ 50 ms, no stalls > 250 ms (today's vehicle-fork measurements are the baseline, [01 §4](01-technology-audit.md)) |
| Factories persist and keep running while their owners are offline | Abstract simulation running for 100 % of claimed sites at ≤ 10 % of server CPU ([07](07-factories-and-logistics.md)) |
| The world visibly changes over a month | Ecology fronts move; structures are built and destroyed; tracked by an ecology dashboard ([08](08-monster-ecology.md)) |
| Air power matters but does not dominate | Strikes resolve Overrun zones; ground play is still needed to hold land ([09](09-vehicles-airpower-ordnance.md)) |
| A solo builder has fun in the first hour | Playtest metric ([15](15-economy-progression-social.md)) |
| Retail clients unaffected | Zero unknown-message crashes; walls block them the same as everyone ([13](13-retail-compatibility.md)) |
