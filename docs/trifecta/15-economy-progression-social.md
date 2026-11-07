# 15 — Economy, progression and social structure

Status: **draft v0.1** (2026-11-03).
Depends on: [03 systems dynamics](03-systems-dynamics.md) (loops B4, B6, R1, R3), [06](06-dynamic-world.md), [07](07-factories-and-logistics.md), [08](08-monster-ecology.md), [09](09-vehicles-airpower-ordnance.md), [14](14-security-integrity-griefing.md).

## 1. Goals
1. **The classic economy stays intact** (P1): loot, vendors, salvage, tinkering and spell components behave as
   today, and nothing from the new layer floods them.
2. **The new economy is a closed loop with real sinks.** Production is continuous, so sinks must scale with it.
   Destruction is the main one ([03 §5.5](03-systems-dynamics.md)).
3. **Social structures matter again**: allegiances hold land, wage war, run logistics and defend each other
   (P5).

## 2. Faucets and sinks

| | Classic (unchanged) | New |
|---|---|---|
| **Faucets** | Monster loot, NPC vendor buy-back of loot, quest rewards | Factory commodities, bounties (pyreals, commodities), nest and raid loot (ecology variants), wreck salvage |
| **Sinks** | Spell components, vendor purchases, tinkering, housing rent | **Construction** (materials), **repairs** (destruction), upkeep, ammunition and fuel, ordnance, airframe losses, NPC wages, research, market taxes, war declarations, insurance |

**Balance rule**: the world-model simulator ([03 §9](03-systems-dynamics.md)) must show, for each commodity, that
production and consumption balance within a band over 90 simulated days at 10, 100 and 1,000 concurrent players. The
same goes for the money supply M.

## 3. The boundary between the economies
- **Industrial commodities are their own class.** They do not convert into classic salvage or classic items, except
  through a **whitelist** with per-account daily caps. Candidates:
  - ammunition (quarrels, arrows) — consumables vendors already sell, so caps are loose;
  - spell components such as mana scarabs, also vendor-sold, so production cannot undercut a ceiling;
  - healing kits.
  Q07.1 decides the list.
- **Classic → industrial is open**: classic salvage and junk loot can be fed into factories (inputs) and into hangar
  recipes (unique items → airframes). That is a **new sink for classic loot**, good for the classic economy.
- **No unlimited NPC buy-back** of factory output ([14 §5](14-security-integrity-griefing.md)).
- **Pyreals** (and trade notes) remain the currency of both, with ACE as the authority. Upkeep, wages, taxes and fees
  remove pyreals; bounties add them. Net money growth is monitored.

## 4. Markets
- **Market terminals** (a station structure) host a commodity **order book** in the WSS: buy and sell orders per
  kind and grade, matched server-side, settled by sagas. Goods must be physically at the terminal's storage. Moving
  them by train, cart or aircraft is the **hauler's game**, and distance creates price differences.
- **Taxes** per trade (a sink); terminal owners (claims) may set a share within bounds, so a guild running a trade
  hub earns from it.
- **Player vendors** (NPCs selling a claim's goods to passers-by): Q06.3. Their prices undercut nothing classic,
  because they sell only industrial goods and whitelist items.

## 5. Allegiances, territory and war
- **Allegiances are the guilds.** ACE's monarchy tree (`ACE.Server/Managers/AllegianceManager.cs`) already gives
  ranks, officers, vassals and bans. The overlay references allegiance ids for claim ownership and permissions.
  ACE has **no diplomacy**; combat never checks allegiance (survey).
- **Relations (new, WSS)**: per pair of allegiances, one of `peace` (default), `alliance` or `war`.
  - War is declared with 24 h notice and a fee (a sink), and lasts at least N days.
  - Alliances share defense. Adjacent allied claims pool part of their defense rating, which rewards connected
    clusters (percolation, [03 §6](03-systems-dynamics.md)).
- **Contested regions** (owner-designated): domain-tier claims and territory control over rich deposits, mana springs
  and chokepoints. **Entering one flags a character for PvP there**, with a warning at the border. That is
  hostility without consent, confined to places players choose to enter. Sieges fall in vulnerability windows. This
  is the endgame for guilds who want it; PvE players never have to enter.
- **Hostility outside contested regions**: war (consensual on PvE servers, §5.1), and **economic** rivalry: races for
  rich deposits, market undercutting at terminals, outbidding for strongholds. Interdicting logistics by force
  happens only where PvP applies.
- **Server type matters**:
  - On a PvE server, war is opt-in per allegiance (both must be "war-eligible").
  - On a PK server, war-eligibility may be the default.
  - Owner policy (Q15.1).

### 5.1 PvP and targeting rules (the single source)

Every other document refers here: [06 §7](06-dynamic-world.md), [07 §6](07-factories-and-logistics.md),
[09 §5](09-vehicles-airpower-ordnance.md). "Eligible" below means: ACE's existing PK rules apply
(PK↔PK, PKLite↔PKLite, `Player_Combat.cs:1163-1213`), **or** the two allegiances are at war, **or** both parties
are inside a contested region. Never fellowship members or the same or allied allegiances (no friendly fire). Never
inside or into a sanctuary.

| Attacker → target | Allowed when | Notes |
|---|---|---|
| Player → player | Eligible | Classic rules unchanged outside war and contested regions |
| Player → another claim's pieces and placed NPCs | Eligible. **Outer damage** any time while eligible. The **final phase** (core pieces, the totem) only inside the target's **vulnerability window** | Reinforcement model ([06 §7](06-dynamic-world.md)) |
| Anyone → nests, monster structures, ruins | Always | |
| Raid monsters → overlay pieces and placed NPCs | Always | Offline floors ([06 §7](06-dynamic-world.md)) |
| Turret or guard → monsters | Always | |
| Turret or guard → player | Only a player who is currently eligible against the turret's claim ("defenders may shoot whoever may shoot them") | Never NPK players outside war and contested regions |
| Aircraft → monsters | Always | |
| Aircraft → ground players (guns, rails, bombs) | Eligible. Replaces the fork's global `vehicle_gun_players` switch (`Vehicles/VehicleOrdnance.cs:195-208`) | Blast checks eligibility per victim |
| Aircraft → player structures | Eligible and inside the target's window for the final phase, **plus**: the impact zone must be **materialized** (no abstract PvP strikes); claim **cores are hardened against ordnance** ("air strips, ground finishes", as for nests) | Prevents razing by air alone ([17](17-risks-and-open-questions.md) R28) |
| Aircraft → aircraft | The pilots are eligible | Needs the hull model ([09 §5](09-vehicles-airpower-ordnance.md)) |
| Flak → aircraft | As turret → player, applied to the pilot | Never above the high-band floor |

## 6. Progression
- **No new skills.** The retail client's skill list comes from its DATs, so a new skill would be invisible to retail
  players.
- Progression in the new layer is by:
  - **research** (consuming goods at research benches, unlocking catalog tiers per allegiance or per account);
  - **level gates** (higher claim tiers need character progression, which also limits alt carpeting);
  - **titles** (a retail-visible feature; ACE's `CharacterTitle` enum shows the mechanism, e.g. `PortalStormer`).
- **XP** stays the classic game's:
  - ecology monsters give their (tuned) weenie XP;
  - defense, building and logistics give **bounties and titles, not XP**, so the classic leveling curve is untouched;
  - this is an owner decision (Q15.2).
- **Tier ladder (v0)**:
  1. **T1**, hand-fed machines, palisades, crossbow turrets (outpost);
  2. **T2**, mana power and conveyors (holding);
  3. **T3**, rail logistics, wand towers, flak (stronghold);
  4. **T4**, hangars and aircraft assembly, ordnance works (stronghold + research).

## 7. Social incentives (P5)
- **Interdependence by design**:
  - pilots need fuel and ordnance from engineers;
  - engineers need defenders and raw inputs from adventurers;
  - haulers connect markets;
  - Crisis events need everyone.
- **Fellowships** share bounties for raid defense and nest clearing.
- **Convoys**: escort bounties for trains and caravans through Infested zones.
- **Crisis events** ([08 §6](08-monster-ecology.md)): server-wide objectives with titles for participants, in the
  spirit of retail's event tokens ("Defender of Dereth" from the 2003 Olthoi Invasion).
- **Recognition**: the map shows allegiance territories; titles for defenders, pilots and builders; leaderboards per
  season.

## 8. Telemetry
- Money supply M and its growth.
- Faucet and sink volumes per commodity.
- Market price indices.
- Time-to-unlock per tier.
- Share of players active in each leg.
- War declarations and outcomes.
- Raid losses vs repairs spent.

Reported weekly. The simulator's forecasts are compared with live data ([03 §9](03-systems-dynamics.md)).

## 9. Decisions proposed
- **D15.1** Industrial commodities are a separate class. Classic → industrial is open; industrial → classic goes
  through a capped whitelist only.
- **D15.2** Market terminals with server-side order books, physical stock and taxes.
- **D15.3** Allegiance relations (peace, alliance, war) live in the WSS. All PvP and targeting follows the single
  rule table of §5.1: eligibility = PK rules, war or a contested region; final-phase structure damage only in the
  window; no abstract PvP strikes; claim cores hardened against ordnance.
- **D15.4** No new skills. Progression by research, level gates and titles. New activities give bounties and titles,
  not XP.

## 10. Open questions
- **Q15.1** Server type: PvE with opt-in wars, or PK-default territory? This determines who can attack bases.
- **Q15.2** Should building, defense or logistics give any XP? Recommended: no.
- **Q15.3** Trade notes and money supply: do bounties pay pyreals (inflationary) or commodities (contained)?
  Recommended: mostly commodities.
