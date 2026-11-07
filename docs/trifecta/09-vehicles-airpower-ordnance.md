# 09 — Vehicles, air power and ordnance

Status: **draft v0.1** (2026-11-03).
Builds on: `external/holtburger/apps/holtburger-web/docs/vehicles-2026-11-01/` (DESIGN, HANDOFF; decisions 1–73) and
`…/flight-experience-2026-11-01/HIGH-BAND.md`.
Depends on: [02 scale model](02-scale-model-and-budgets.md) §4.1, [04 architecture](04-target-architecture.md), [10 server runtime](10-server-runtime-and-scaling.md) §5.
Feeds: [07 factories](07-factories-and-logistics.md) (demand), [08 ecology](08-monster-ecology.md) (strikes), [15 economy](15-economy-progression-social.md).

## 1. What exists (2026-11-02)

| Area | State | Source |
|---|---|---|
| Aircraft | The **Hellcat**, a 55-part composite of retail items (barrel fuselage, steel-keg cowling, tower-shield wings, Spadone prop, crossbows, wands, keg bombs) | DESIGN decision 62 |
| Simulation | Server-authoritative, fixed 30 Hz, **input-driven stepping**: 0 corrections over 11 km; C# and JS flight models agree within 1 mm over 900 steps | decisions 15, 24; HANDOFF M1 |
| Protocol | HBV1 v2: capability-gated, opcodes 0x0900–0x090F, generated codecs, third-party byte fixtures | decisions 1–6, 63 |
| Streaming | Wake-on-entry; 6 s preload corridor; off-thread loads (≤ 2 in flight); spawn-cache warm-up; 8 ms bring-up budget; 60 s retention for vehicle-only landblocks; dungeon deferral | decisions 26–36, 71 |
| Sight | Pilot sight radius with tiers (5×5 gather; landmarks beyond 112.5 m); 3D sight above the high band | decision 27; HIGH-BAND §5 |
| Altitude | Ceiling up to **5 km** (`vehicle_ceiling_agl`), climb 40 m/s, the **high band** above 600 m | HIGH-BAND |
| Armament | 6 crossbows (5 quarrels/s each, 140 m, harmonized at 110 m); 6 rails launching real **Lightning Bolt** spells through ACE's `SpellProjectile`; bombs 1 × 2,000 lb + 2 × 1,000 lb with a bit-identical client twin | decisions 64–66 |
| Bail-out | Server-simulated free fall + parachute; retail-pose falling animation | decisions 29, 54–61 |
| Safety | Pilots saved in the sky enter on the ground (crash-tested with `kill -9`); combat and recalls refused while seated | decision 69 |
| Retail view | Stand-in: the Bucket (0x0200043C) at 2×, with the seated pilot; bombs' fireballs are real Flame Bolt projectiles everyone sees | decisions 10, 66, 72 |
| Not built | Hull and damage model (the pilot is invulnerable while seated); bomb hits on buildings; persistence; economy; air-to-air combat | decisions 12, 72 |
| Scale | "A couple of vehicles": the global load cap is **6 landblocks/s** | [02 §4.1](02-scale-model-and-budgets.md) |

## 2. Role in the trifecta
1. **The answer to escalation** (P4): strikes on Overrun zones, relief of besieged sites, interdiction of raids in
   transit.
2. **Mobility**: the owner's direction is that portals give way to vehicles (DESIGN §0). Aircraft reach the
   frontier fast.
3. **Logistics** (later): cargo aircraft and airlifted strike teams.
4. **Guild power**: air superiority over territory, contested by other guilds' fighters and flak.
5. **A money sink**: airframes, fuel, ordnance and losses are the economy's biggest consumers
   ([15](15-economy-progression-social.md)).

## 3. Altitude bands (design invariants)

| Band | AGL | Who can reach it | Simulation | Purpose |
|---|---|---|---|---|
| Ground | 0 | Everything | ACE full fidelity | Classic play, building, sieges |
| **Low** | 30 m (vehicle floor) – ~150 m | Ranged monsters ≤ 77.7 m (missiles) / 75 m (spells); player bows; turrets; flak | Full fidelity, landblock loads, **speed capped by the load budget** | Combat band: strafing, bombing, landing |
| **Mid** | 150 – 600 m | Flak; aircraft | Full fidelity (sight tiers) | Approach, recon, contested by anti-air |
| **High** | 600 m – 5 km | **Aircraft only** | **Airspace transit: anchored, no landblock loads** (§4.1) | Refuge, transit, high-altitude bombing |

**Invariant**: nothing on the ground reaches the high band (monster caps from ACE `Creature_Missile.MissileRangeCap`
and `Player.MaxRadarRange_Outdoors`; flak's ceiling = the high-band floor). The sky is a refuge from the ground. It is
not a refuge from other aircraft.

## 4. Scaling air power (from "a couple" to hundreds)

### 4.1 Airspace transit (the key change)
- **Problem**: every landblock crossing loads 3 landblocks around the pilot's body, at any altitude
  (`RelocateObjectForPhysics` loads the 3×3). At 400 km/h that is ~1.7 loads/s per aircraft, against a global cap of
  6/s ([02 §4.1](02-scale-model-and-budgets.md)). The HIGH-BAND document already names the missing piece: "a
  relocation without adjacents for a pilot above the band".
- **Constraint, verified in code**: ACE has **no "in no landblock" state** for an online player. Even portal space
  places the player in the destination landblock at once:
  - `Teleport` sets `Teleporting`, `Hidden` and `IgnoreCollisions`, then calls `UpdatePlayerPosition(newPosition, true)`;
  - `OnTeleportComplete` waits for the landblock's `CreateWorldObjectsCompleted` before un-hiding
    (`S/WorldObjects/Player_Location.cs:682-768`).
  Every player is ticked through its landblock (`Landblock.TickSingleThreadedWork` → `Player_Tick`).
- **Design: an anchor with relocation suspended**:
  1. Above the high-band floor (with hysteresis), the pilot's body and the vehicle stay **members of an anchor
     landblock**: the one where transit began, kept alive by the existing 5 s vehicle keep-alive.
     `RelocateObjectForPhysics` is **suspended** for them. Their `Location` follows the vehicle plane, but no crossing
     loads a 3×3.
  2. The pilot's ACE `ObjectMaint` admits **no ground objects** in transit. That extends `vehicle_high_band_agl`'s 3D
     sight; nothing on the ground is relevant 600 m up. The vehicle plane tracks aircraft in its own 3D index and
     handles air-to-air sight and combat.
  3. Ordnance released from transit is resolved per [04 §4.5](04-target-architecture.md): ACE if the impact zone is
     materialized, the WSS otherwise.
  4. Descending below the floor re-enters the world through the **teleport-arrival path minus the client's portal-space
     message**: placement into the landblock under the aircraft, preloaded off-thread (H1) as soon as the descent is
     predicted. `OnTeleportComplete`'s wait for `CreateWorldObjectsCompleted` protects against arriving early.
  - Cost: **one anchor landblock per pilot in transit** (often shared), instead of ~1.7 new landblocks per second.
  - **Caveat, verified in the fork.** Suspending the 3×3 relocation is not enough. Placing a body with
    `set_current_pos` loads the position's landblock inside `LScape.get_landcell`
    (`S/Vehicles/VehicleManager.cs:443-447`). Transit must also **decouple the physics cell from the reported
    position**: the body's physics position stays in the anchor cell, and the true 3D pose lives in the vehicle plane.
    Part of the P5.1 spike.
- **Verify** (pass 2 spike): which ACE subsystems read `CurrentLandblock` rather than `Location` for a player:
  - broadcast and known-object sets;
  - local chat (96 m from `Location`);
  - fog and weather per landblock;
  - housing checks;
  - `@`-commands;
  - saves, which the `AirborneSaveMark` logic already handles.
- **Effect**: high-band flight costs microseconds per aircraft per step and **no landblock loads**. Hundreds of
  aircraft in transit are cheap.

### 4.2 The low band is a budgeted combat zone
- Per-aircraft low-band speed cap from the load budget. Low-band aircraft share a pool of **≤ 15 loads/s** out of
  the server's total budget of ≤ 30/s, all off-thread ([02 §6.1](02-scale-model-and-budgets.md)). Today's global cap
  is 6/s. The existing back-pressure (decision 26) enforces the pool.
- **Cheap shells** for vehicle-only landblocks: terrain, statics and indoor cells built off-thread; classic
  generators deferred unless an aircraft actually engages there. That extends decisions 34–35. A measurement item.
- **What materializes for an aircraft** ([04 §4.1](04-target-architecture.md)): in a vehicle-only landblock, overlay
  **solids and nests** materialize within ~200 m of the flight path when the aircraft is below the band floor. They
  must be collidable, targetable and visible. **Ecology spawn orders** are issued only when an aircraft engages there
  (fires, bombs) or lands. A fast flyover never spawns monsters.
- Players feel this as "low and fast is expensive; go high to travel, come down to fight". It matches the
  ground-reach balance of DESIGN §4.7.

### 4.3 The vehicle simulation leaves the world thread
At dozens of vehicles, `VehicleManager` runs on its own thread with a mailbox to the world thread
([10 §5](10-server-runtime-and-scaling.md)). The world thread applies seat placement, combat effects and ACE
broadcasts.

### 4.4 Visibility between aircraft
- 3D sight within the vehicle plane (existing `Sight3D`).
- **Rate tiers for `VehicleState`**. At 10 Hz each visible aircraft costs an observer ~1 kB/s, so 50 aircraft would be
  ~50 kB/s, 8× the per-player budget. Rates fall with distance:
  - 10 Hz within 500 m;
  - 2 Hz within 2 km;
  - radar blips at 0.5–1 Hz beyond;
  - the pilot's own state stays at 20 Hz.
  [11 §4](11-network-and-interest-management.md) carries the same rule.
- Long-range **radar** (later): blips over the overlay channel within ~5 km, more with radar towers (structures).
- **Ground intel for bombing from altitude**: the aircraft's **sensor footprint** (the bombsight cone and an
  ahead-of-track strip) admits coarse markers for nests, raids and enemy structures. It is derived server-side from
  the vehicle's pose, so it is consistent with D14.5 ([11 §4](11-network-and-interest-management.md)).
- Retail clients see stand-ins only within ACE's normal ranges.

## 5. Combat

| Engagement | Status | Design |
|---|---|---|
| Air → monsters | Built (guns, rails, bombs through ACE combat) | Keep |
| Air → nests and ecology structures | — | Materialized: ACE damage on `StructurePiece`s. Abstract (high-band strikes over empty zones): WSS blast resolution on nest records; hardened cores ([08 §5](08-monster-ecology.md)) |
| Air → ground players | Only with the global `vehicle_gun_players` switch (no PK, war or claim check; `Vehicles/VehicleOrdnance.cs:195-208`) | Per-victim **eligibility** from the single rule table ([15 §5.1](15-economy-progression-social.md)); no friendly fire |
| Air → player structures | — | Eligible, plus the target's window for the final phase. **Materialized zones only** (no abstract PvP strikes). Claim cores hardened against ordnance: air strips, ground finishes ([15 §5.1](15-economy-progression-social.md)) |
| Ground → air | Monsters in range (≤ ~78 m) | Plus **flak** (long-range custom weapon, ≤ 600 m, [07 §6](07-factories-and-logistics.md)) and player missile weapons in range |
| **Air → air** | — | Needs the **hull model**. Pilots must be eligible ([15 §5.1](15-economy-progression-social.md); Q09.2) |
| Air ↔ overlay solids (collision) | The aircraft is Ethereal and ignores collisions; terrain only, plus buildings at takeoff and landing (decision 9, DESIGN §4.4) | Low-band flight tests overlay solids from the overlay collider index (the swept segment per step, as for terrain): a crash. Landing spots are checked for pieces |
| Pilot damage | Invulnerable while seated (decision 12) | Replaced by the hull model: the aircraft absorbs damage; at 0 HP it is lost (crash or bail) |

**Hull model (v1)**:
- Hull HP and armour per damage type.
- Components (engine, fuel tank, control surfaces), each with HP and a performance penalty when damaged (vMax, roll
  rate, fuel leak).
- Damage arrives through ACE's combat path: the vehicle becomes an attackable creature-like target, reusing the
  `StructurePiece` approach.
- Destruction leaves a **wreck** with salvage (a partial sink).
- Parity: the predictor needs the server's degraded flight parameters. They travel as `VehicleProfile` updates, and
  HBV is append-only, so new fields are added at the end.

## 6. Economy of air power
- **Acquisition**: an aircraft is assembled at a **hangar** (a factory station) by an **ACE recipe**. It consumes
  unique retail items mirroring the composite (tower shields, kite shields, a barrel, crossbows, wands) plus factory
  components (engine block, control linkage, fuel tank). Old loot becomes airframes, a sink for classic drops. The
  recipe yields a **vehicle deed** (an ACE item) that registers a persistent vehicle.
- **Persistence**:
  - Vehicles become persistent records: hull, components, fuel, ammo, location.
  - Parked aircraft live at hangars and airstrips in claims; they are never parked in sanctuaries.
  - The demo's "never persisted" rule (decision 9) is replaced by WSS persistence, not ACE persistence.
- **Fuel**: mana scarabs or charges, burn rate computed by the server per second at cruise and boost. Range limits
  make **forward airstrips** (claims) strategic.
- **Ammunition**: quarrels and rail charges from munitions works; bombs from ordnance works. Rearming draws from the
  hangar's or airstrip's stock (replacing the demo's free 6 s rearm, decision 67).
- **Repair**: commodities at a hangar.
- **Losses**: shot down or crashed → wreck → partial salvage. Optional insurance (a pyreal sink).

## 7. Ground vehicles and trains
- **Ground vehicles** (jeeps, carts, haulers): the Ground locomotion class of DESIGN §3.1, with the same registry,
  protocol, seats and costs.
  - Server-simulated, so unlike aircraft they **collide** with bedrock buildings, scenery and **overlay solids**: the
    same overlay collider index, swept per step.
  - Walls and gates stop them. Gates open for permitted claims.
  - At ~28 m/s they cost like a fast runner ([02 §4.1](02-scale-model-and-budgets.md)).
  - Roles: haulers moving commodities between claims and markets (cargo holds are machine-like buffers in the WSS),
    defenders moving between walls, convoys through Infested zones.
- **Siege engines** (v2): slow ground vehicles (ram, catapult) whose weapons do structure damage (Bludgeon), subject
  to the PvP rules ([15 §5.1](15-economy-progression-social.md)). They give **ground counterplay** in sieges and keep
  air power from being the only way to break a fortress (R28).
- **Trains** belong to the logistics simulation ([07 §4.5](07-factories-and-logistics.md)).
  - Positions are closed-form, so they cost nothing in ACE until v2 makes moving cars attackable.
  - **Passenger cars** (v2) reuse vehicle seats: a seated rider is slaved to the car's pose like a pilot (DESIGN
    §4.3). That needs the car in the vehicle plane while occupied.
  - Stations are structures.

## 8. Safeguards
- **Sanctuaries are no-strike zones**: ordnance released over a sanctuary is disarmed (it fizzles, with a visible
  effect), and guns stop firing at targets inside.
- **PvP gates** for anything player-owned ([06 §7](06-dynamic-world.md)).
- **Rate limits** on ordnance release outside war contexts, and audit logging of every release and impact
  ([14](14-security-integrity-griefing.md)).
- **Derelicts**: the existing rules (despawn above 600 m after 30 s, parked empty 10 min) stay until persistence
  replaces them.

## 9. Roadmap items (vehicle plane)

| ID | Item | Done when |
|---|---|---|
| V1 | Airspace transit (anchor + suspended relocation; no loads in the high band) | 100 bot aircraft in the high band: zero loads, world loop unaffected |
| V2 | Vehicle simulation thread | 200 vehicles at 30 Hz: < 2 ms of world-thread time per tick |
| V3 | Low-band load budget + cheap shells | 20 low-band aircraft at the capped speed: no world stall from loads |
| V4 | Hull and component model + flak | Shoot-down → bail → wreck, end to end |
| V5 | Strikes on abstract zones (WSS ordnance) | High-band bombing reduces a nest's records |
| V6 | Persistence, hangar recipe, fuel and ammo economy | Build, fuel, fly, lose, salvage: the loop closes |
| V7 | Air-to-air PvP rules | Owner-approved ruleset implemented |
| V8 | Client: instanced airframes, many observers, radar | 50 aircraft visible: ≤ 100 draws for airframes |

## 10. Decisions proposed
- **D09.1** Altitude bands with the ground-reach invariant: nothing on the ground reaches the high band.
- **D09.2** Airspace transit: high-band aircraft load no landblocks. The pilot stays anchored in one landblock with
  relocation suspended.
- **D09.3** The low band is a budgeted combat zone with a load-budget speed cap.
- **D09.4** A hull and component model replaces pilot invulnerability; aircraft are attackable creature-like targets.
- **D09.5** Aircraft are assembled by ACE recipe from retail items plus factory components; persisted by the WSS.
- **D09.6** Sanctuaries are no-strike zones.

## 11. Open questions
- **Q09.1** Is the 5 km ceiling right for gameplay, or does a lower high band (1.5–2 km) keep pilots closer to the
  world?
- **Q09.2** Air-to-air PvP: PK-only, war-only, or designated air-combat regions?
- **Q09.3** Should the high band be fully safe from the ground (current invariant), or should heavy anti-air
  ("sky-piercer" spells) exist late in the tech tree?
- **Q09.4** Cargo aircraft: carry commodities only, or also players (airlift squads)? Squads need seats beyond the
  pilot (DESIGN §9 crew seats).
