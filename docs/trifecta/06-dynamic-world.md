# 06 — The dynamic world: claims, building, destruction, placed NPCs

Status: **draft v0.1** (2026-11-03).
Depends on: [00 pillars](00-vision-and-pillars.md) (P1, P2, P6), [04 architecture](04-target-architecture.md), [05 persistence](05-world-state-and-persistence.md).
Feeds: [07 factories](07-factories-and-logistics.md), [08 ecology](08-monster-ecology.md), [13 retail](13-retail-compatibility.md), [14 security](14-security-integrity-griefing.md), [15 economy](15-economy-progression-social.md).

## 1. What "malleable" means here

- Players **build** structures (walls, gates, towers, platforms, machine housings, storage, lights) on land they
  claim. The structures persist and can be **damaged, destroyed, repaired and rebuilt**.
- Players **place NPCs** (guards, workers, vendors) that act in the world and can be **killed**.
- Monsters **build too**: nests, hives and war camps that grow out of the ecology ([08](08-monster-ecology.md)) and
  can be destroyed.
- The world remembers all of it, and the map at the end of a month differs from the start.

## 2. Three layers

| Layer | Contents | Mutable at runtime? | Authority |
|---|---|---|---|
| **Bedrock** | DAT terrain, DAT buildings and dungeons (LandblockInfo, EnvCells), procedural scenery, world-DB spawns, quests | **Never** (P1) | DATs + ACE world DB |
| **Overlay** | Claims, structures, machines, logistics, placed NPCs, monster nests | Yes | WSS ([05](05-world-state-and-persistence.md)) |
| **Fields** | Ecology populations, disturbance, threat levels | Continuously | WSS ([08](08-monster-ecology.md)) |

Bedrock is immutable for a principled reason, not as a shortcut. Retail clients and holtburger-web both draw and
collide with bedrock **from their local data**:
- retail from its DAT files;
- holtburger-web from its baked `dist/`, which has no per-placement unload or hide of a baked building (client survey).

A destroyed DAT building would remain standing and solid on every retail client. Keeping bedrock immutable is what
makes the overlay compatible with every client tier. It is also what keeps the classic game intact.

## 3. Zoning

The zone map is **data**: computed from the DATs and the world DB, then hand-edited by admins. One value per
landblock, plus finer masks for roads and landmark radii.

| Zone | Rule | Initial computation (2026-11-03 counts) |
|---|---|---|
| **Sanctuary** | No claims, no building, no ecology spawns, no raids. Classic content only | Towns = landblocks with a vendor, a lifestone or ≥ 6 doors (**646**) plus a 1-landblock buffer. Every other landblock with authored content (portals, lone doors, housing) keeps its own landblock. Total **~5,760 landblocks** |
| **Road corridor** | No building on road cells + 6 m buffer; gates may span a road only with an open passage (v2) | 18,540 road-touching land cells (0.8 % of land) |
| **Housing settlement** | No claims within the settlement's landblocks (retail housing is bedrock) | From the House weenies' positions |
| **Dungeon entrance / quest site** | No building within 48 m | From world-DB portals and quest NPC positions |
| **Frontier** | Claims allowed; ecology active | **~30,200 majority-land landblocks ≈ 1,114 km²** |
| **Deep wild** | Frontier where species originate (high habitat suitability); claims allowed, pressure high | From habitat maps ([08 §3](08-monster-ecology.md)) |
| **Contested** | Territory-war rules apply to structures ([15 §5](15-economy-progression-social.md)) | Owner-designated regions |
| **Water** | No building in v1 | 26,336 all-water landblocks |

Counting method (`tools/world_counts.py`):
- A majority-land landblock has ≥ 41 of its 81 vertices on land types (`world_types.u8`).
- The seeds are the **1,657** landblocks with authored outdoor content: outdoor `dist/spawns` rows (cell index
  < 0x100) of type Portal, Vendor, Door, LifeStone or SlumLord.
- A 2-landblock town buffer would shrink the frontier to ~23,500 landblocks (~866 km²). Buffers are a policy knob,
  not a constant.

## 4. The building catalog

- **Every catalog piece is a base-DAT Setup or GfxObj** ([04 §4.2](04-target-architecture.md)). ACE physics, retail
  clients and holtburger-web then all see and collide with the same shape, and no client patch is needed.
  - ACE already supports placing solid objects with a DAT Setup at runtime. Collision uses the Setup's physics BSP
    (or its spheres and cylinders); ethereal objects are skipped. This blocks **server-simulated** movers: monsters and
    projectiles.
  - The fork's aircraft are **not** blocked: the vehicle is Ethereal and IgnoreCollisions, and its flight model tests
    terrain only, plus buildings at takeoff and landing (vehicles DESIGN §4.4, decision 9). Collision between
    aircraft and overlay solids is new work ([09 §5](09-vehicles-airpower-ordnance.md)).
  - Players' positions are client-asserted (ACE computes the collision transition, then sets the requested position
    anyway: `PhysicsObj.cs:1778`, `update_object_server(forcePos = true)`),
    so walls hold against players through client collision plus H14 validation ([14 §3](14-security-integrity-griefing.md)).
  - holtburger-web already collides with server objects' physics BSPs (COL-03).
  - Existing weenie names hint at candidates (`ace35582_wall`, `ace35483_watcherswall`, `ace35062_manabarrier`). Town
    walls, palisades, fences, gates, towers, tents, crates and forges are in the DATs.
  - **Pass-2 task**: survey the DATs with the WorldBuilder.Terminal asset tools (`asset-refs`, `asset-used-by`,
    render previews). Check each candidate's physics-polygon count; the client tests all of a flattened BSP's
    polygons, so low is better.
  - **Where to look** (first scan, 2026-11-03): the world DB's 43,911 weenies include 606 with wall, gate, tower,
    forge or tent in their class name. These are mostly portals, signs, spell walls (`flamewall`, `forcewall`, …) and
    generators, not building pieces. The building kit will come from **DAT statics**: the Setups and GfxObjs placed by
    LandblockInfo in towns, camps and forts. Survey those first.
- **Piece classes**: foundation/platform (flat surfaces instead of terrain edits), wall (straight, corner, end), gate
  (openable: the door pattern, Ethereal toggled on open, `WO/Door.cs`), tower, roof/canopy, storage, light, machine
  housing ([07](07-factories-and-logistics.md)), turret ([07 §6](07-factories-and-logistics.md)), banner/claim totem,
  decoration.
- **Per catalog entry**: model (Setup / GfxObj DID, scale), collision class (solid, ethereal, gate), HP, armour per
  AC damage type (slash, pierce, bludgeon, fire, cold, acid, electric, nether), build cost (commodities), build time,
  disturbance output, support rule, and per-zone budget weight.
- **Modules**: some catalog entries are multi-part Setups (a gatehouse, a keep). They count as one ACE object when
  materialized, which keeps large bases within the per-zone object budget.
- **Custom models** (beyond base DATs) only arrive with a DAT patch tier ([13](13-retail-compatibility.md), tier 1),
  never as client-only geometry for solid pieces. Cosmetic, non-colliding pieces (conveyors, pipes, rails, lights) may
  be client-drawn for capable clients, like the Hellcat's tracers.

## 5. Claims

| Tier | Footprint (on the 24 m cell grid) | Who | Limits (v0) |
|---|---|---|---|
| Outpost | 2 × 2 cells (48 m) | any character | 1 per account |
| Holding | 4 × 4 cells (96 m) | any character, after progression | 1 per account |
| Stronghold | 8 × 8 cells (192 m = 1 landblock) | allegiance (monarch or officer) | by allegiance size |
| Domain | several landblocks, contiguous | allegiance in territory play | contested zones only |

- **Claim totem**: a placeable, buildable item. It is the claim's heart and has the highest HP. Destroying it
  (abstract or materialized, under the rules of §7) dissolves the claim, and the remaining pieces become **ruins**.
- **Permissions** per action: build, deconstruct, use machines, open storage, command guards. Granted to owner,
  allegiance ranks, fellowship, named characters. Allegiances are ACE's existing monarchy tree
  (`ACE.Server/Managers/AllegianceManager.cs`); the overlay references allegiance ids.
- **Upkeep** (loop B6, [03](03-systems-dynamics.md)): a periodic cost in pyreals or commodities, rising
  superlinearly with built mass.
  - Unpaid upkeep → **decaying**: HP drains slowly, with warnings.
  - After N days decaying → **abandoned**: pieces become ruins anyone may salvage, then they are removed.
  - This clears dead bases and returns land to the frontier. Retail housing's 30-day rent and eviction
    (`WO/House.cs`, `HouseManager.cs`) is the cultural precedent.

## 6. Building, repair, deconstruction
- **Place**: ghost → validate (claim, permissions, zoning, slope, no overlap with bedrock statics and scenery colliders
  or other pieces, support, budget) → **two-phase payment** ([05 §5](05-world-state-and-persistence.md)) →
  "under construction" (HP rises as build time elapses) → complete.
  - Validation runs twice: advisory in the client (wasm `trifecta-sim`), authoritative in the WSS.
- **Support (v0, simple)**: pieces rest on terrain within a slope limit, or on foundations. Walls need a foundation
  or terrain contact. Removing a support makes dependants ruins after a short delay (no physics simulation in v1).
- **Repair**: commodities → HP, at a fixed rate per second while a builder works on the piece.
- **Deconstruct**: owner-permitted; refunds a fraction of cost (v0: 50 %), more if undamaged.
- **Blueprints**: a saved set of pieces relative to an anchor, shared with allegiance members. Pasting creates
  ghosts; placement proceeds as affordable.
- **Scenery**: trees and rocks are bedrock (procedural, drawn locally by every client). Pieces may not overlap their
  colliders in v1. Clearing trees would need every client tier to agree, so it is not v1.

## 7. Damage, destruction and offline protection

**Who can damage what** is defined once, in the PvP and targeting table of [15 §5.1](15-economy-progression-social.md).
In short:
- raid monsters may always damage overlay pieces and placed NPCs;
- anyone may damage nests and ruins;
- players, turrets and aircraft may damage another claim only when **eligible** (PK rules, war, or a contested
  region), with the final phase only inside the target's vulnerability window;
- upkeep decay damages one's own pieces when upkeep is unpaid.

**Damage model**: catalog HP and armour per damage type; resistance by material (stone resists slash and pierce,
wood burns). ACE's damage path does the math while materialized (pieces are immobile creatures, [04 §4.2](04-target-architecture.md)).
The WSS applies the same table abstractly.

**Collapse**: destroyed pieces leave the collider set at once. Dependants lose support and become ruins after a few
seconds. The visual effect and debris are client-side ([12 §3.3](12-client-holtburger-web.md)).

**Offline protection** (P6). Losing everything while asleep is the fastest way to lose a solo builder. The rules:
1. **Monster raids against an offline owner** resolve abstractly with the site's defenses. Damage happens, which is
   the B4 economic sink. But the **core** (the totem plus up to K designated "keep" pieces) cannot fall below 1 HP
   **while the claim's upkeep is paid**. Owners can prepay up to 30 days, so a holiday does not dissolve a solo
   player's claim (no 72-hour cliff). Raid size is also scaled down while no member of the claim is online (a
   defender's advantage, tunable).
2. **PvP attacks** follow a **reinforcement** model (the EVE Online structure-timer idea):
   - breaking a claim's outer HP threshold puts it into **reinforced** state;
   - the final phase can only happen inside the defender's **vulnerability window**, a daily few-hour window the
     owner chooses;
   - so defenders can be present.
3. **Abandonment ends protection**. When prepaid upkeep runs out, a 7-day grace period starts (warnings). After it the
   claim decays to ruins (§5).
4. **Warnings**: raid warnings ([08 §7](08-monster-ecology.md)) and attack notices go to all claim members wherever
   they are in the world.

## 8. Placed NPCs
- **Guards**: ACE creature templates (existing NPC and guard models) that are **attackable** and hostile to raid
  species.
  - Use ACE's existing `Faction1Bits` / `FoeType` / `Tolerance` machinery, which already drives monster-vs-monster
    fights and combat pets (`WO/Monster.cs:39-52`, `WO/Creature_Combat.cs:1311-1358`, `WO/Pet_Monster.cs`).
  - Plain NPCs (not attackable) are never targeted by monsters (`WO/Monster_Awareness.cs:245`), so guards must not
    be plain NPCs.
  - They stay within the claim (a leash to the claim, not ACE's home radius). Abstractly, they add to the site's
    defense rating and can die in abstract raids.
- **Workers**: cosmetic laborers carrying items between machines. They make a site look alive. Optional throughput
  bonus, tuned later.
- **Vendors**: sell a claim's goods to other players. A player-economy feature with large consequences, deferred to
  [15](15-economy-progression-social.md).
- **Wages** are an upkeep item. Dead NPCs are rehired at a cost (a sink).
- **Killable** by raids always, and by players under §7's PvP rules.

## 9. Monster structures
The ecology's nests, hives and war camps are overlay structures owned by a species faction ([08 §5](08-monster-ecology.md)).
Bases from the same catalog idea (DAT models: drudge palisades, olthoi mounds, banderling totems), destructible by
anyone. Each has a **hardened core** that air strikes cannot finish on their own ([03 §5.4](03-systems-dynamics.md)).

## 10. Terrain and interiors
- **No terrain deformation in v1.** Server physics, flight terrain sampling (vehicles DESIGN decision 16) and every
  client read DAT heights. Craters, scorch and creep are decals ([12 §3.8](12-client-holtburger-web.md)).
  Foundations replace flattening.
- **No new walkable interiors with retail-style cells.** Interiors need DAT EnvCells and portals that cannot cross
  landblocks (client survey; `2026-08-13-indoor-outdoor-cell-architecture.md`). Player buildings are open structures
  on outdoor cells: walls and roof pieces as objects. That is consistent for every client tier.

## 11. Budgets and limits (v0)
- Solid pieces materialized per landblock ≤ 1,000; modules count as 1 ([02 §6.1](02-scale-model-and-budgets.md)).
- Pieces per claim tier: Outpost 300, Holding 1,500, Stronghold 6,000 (solid + cosmetic; solid ≤ 1,000 per landblock).
- Placement rate per account: ≤ 2 pieces/s sustained (bursts for blueprint pastes, server-paced).
- Placed NPCs per claim: Outpost 2, Holding 6, Stronghold 20.

## 12. Decisions proposed
- **D06.1** Bedrock (DAT + world DB) is immutable. Only the overlay changes.
- **D06.2** The zone map is computed data with admin overrides. Sanctuaries use tiered buffers.
- **D06.3** Catalog pieces are base-DAT models. Custom solid models only through a DAT-patch tier.
- **D06.4** Claims are on the 24 m cell grid in four tiers, with superlinear upkeep and abandonment to ruins.
- **D06.5** Offline protection: a core floor against monster raids while upkeep is paid (prepay up to 30 days, 7-day
  grace), and reinforcement plus vulnerability windows against PvP.
- **D06.6** Guards are attackable creature templates using ACE's faction and FoeType machinery.
- **D06.7** No terrain deformation and no new interior cells in v1.

## 13. Open questions
- **Q06.1** Which base-DAT models make a satisfying, coherent building kit? This gates the look of the whole leg
  (DAT survey, pass 2).
- **Q06.2** Should claims be purchasable only with progression (to keep alts from carpeting land), or limited per
  account?
- **Q06.3** Player vendors: yes or no (economy impact, [15](15-economy-progression-social.md))?
- **Q06.4** Are offline protection numbers (30-day prepay, 7-day grace, K core pieces) right? Simulate in the world-model simulator
  ([03 §9](03-systems-dynamics.md)) and playtest.
