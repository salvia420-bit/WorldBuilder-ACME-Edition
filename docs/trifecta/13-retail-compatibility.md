# 13 — Retail compatibility

Status: **draft v0.1** (2026-11-03).
Depends on: [00 pillars](00-vision-and-pillars.md) (P1), [11 network](11-network-and-interest-management.md).
Builds on: vehicles DESIGN §5 and §5.1 (the representation ladder).

## 1. The commitment

Retail clients (acclient, 1999) keep connecting and playing the classic game. The expansion:
- never sends them a message they did not ask for;
- never shows them geometry that is not in their DATs;
- never gives them more objects than they can survive;
- keeps the world **physically consistent** for them: a wall that blocks a browser player blocks a retail player.

## 2. What a retail client can and cannot take

| Fact | Source | Consequence |
|---|---|---|
| Unknown game events are dropped (`UIQueueManager::ProcessNetBlobData` falls through to `result = 0`) | `acclient.c:394441`, vehicles DESIGN §5 | A stray extension event will not crash it. Still, **never rely on that**: capability gating means retail never receives one |
| 32-bit; crashes near 1.6–1.8 GB; memory grows with objects seen and corpses opened | #thwarg 2024-02-26; #general 2020-09-15 | **Object budget** per retail session |
| Dense towns crash it ("too many objects in holtburg … buffer overflow, if you portal in") | #utilitybelt 2022-04-29 | Cap structure pieces per landblock for retail; prefer modules |
| Keeps left-view objects 25 s; visible list rebuilt every 1 s | `acclient.c:310666, 310239` | Churn costs memory; avoid streaming hundreds of pieces in and out |
| Only base-DAT (or patched) Setups render | — | Catalog = base-DAT models ([06 §4](06-dynamic-world.md)) |
| Assets only update on login; landblock refresh "goes black" | #worldbuilder 2026-02 | No runtime DAT or terrain edits (P1, bedrock) |
| Understands portal-storm messages (0x02C9–0x02CC) | `acclient.c:402296-402357` | The crowd valve needs no new client support |
| Does not hear the server's collision opinion for players: ACE computes the transition, then sets the requested position anyway | `PhysicsObj.cs:1778`, `PhysicsObj.cs:4266-4277`, `Player_Tick.cs:411-491` | Walls hold for retail only if retail **has the pieces** or the server **validates movement** (H14) |

## 3. The representation ladder, per system

Tiers (vehicles DESIGN §5.1):
- **0**: plain retail.
- **1**: retail + a DAT patch.
- **2**: retail + the Chorizite plugin.
- **3**: holtburger-web.

| System | Tier 0 (plain retail) | Tier 1 (+ DAT patch) | Tier 2 (+ plugin) | Tier 3 (holtburger-web) |
|---|---|---|---|---|
| Solid structure pieces | ACE objects with base-DAT Setups, within ACE's normal ranges; health bar and damage text (immobile creatures) | Custom piece models from the patch range | Damage-state visuals | Full overlay stream, 770 m range, instanced |
| Cosmetic pieces (belts, pipes, rails, decals, creep) | Not shown | Not shown | Possible later (plugin draws from in-band summaries) | Full |
| Machines | Solid housing; `Use` prints "operated from a Trifecta terminal" | Same | Panel (later) | Full panels |
| Claims | Chat notice on entering a claim (rate-limited) | Same | Border overlay | Full overlay |
| Ecology monsters, raiders | **Real creatures**: fully visible, fully fightable | Same | Same | Same + prefetch |
| Nests | Solid, attackable pieces | Custom nest models | Creep visuals | Full |
| Turrets | Solid; their bolts and spells are real projectiles everyone sees | Same | Same | Same |
| Placed NPCs | Real creatures | Same | Same | Same |
| Vehicles | Stand-in (the Bucket at 2×) with the seated pilot; not drawn at high altitude (beyond degrade distance) | The real airframe as a patch Setup | Smooth motion from `VehicleState`, tracers | Everything; pilots |
| Threat map, raid warnings | **Standard chat** lines (raid warnings, threat changes near you) | Same | Map overlay | Full |
| Portal storms | Native retail messages | Same | Same | Same |
| Building | Cannot build (v1) | Same | Possible later | Full |

## 4. Letting retail players take part

Retail players are not locked out of the new economy:
- **Quartermaster NPCs** at claims accept items through the standard **Give** action and credit the claim's storage.
  It is a two-phase transaction ([05 §5](05-world-state-and-persistence.md)), so retail players can supply a
  factory. Paying out works the same way in reverse ("Give me 50 quarrels").
- **Raids and nests are ordinary combat**, so retail players defend sites and clear nests fully.
- **Contracts and bounties** use existing quest and chat mechanics where possible.

## 5. Budgets for retail sessions

- **Structure pieces per retail session**: ≤ 300 materialized pieces in its known set (v0, tune with the crash data).
  Modules count as 1.
- **Perimeter first**: the **collision-relevant** pieces near the player are always selected first: outer walls,
  gates, towers, anything blocking a path the player could take. The budget trims interior and decorative solids
  (machine housings inside a wall ring, storage, lights).
- **The catalog helps**: long wall modules (one object per wall run, not per segment) keep a fortress perimeter
  within budget.
- **Consistency guard**: a landblock may hold 1,000 solid pieces against a 300-piece retail budget, so a retail
  session cannot always be sent every solid piece around it. The server therefore **must** validate movement against
  overlay solids (H14) for every session in a dense base; otherwise retail players would walk through walls they do
  not have.
  - Because the perimeter is sent first, the walls that stop a retail player are almost always walls they can see.
    Snap-backs from unseen interior pieces are the residual case, and they are measured.
  - Consequence for the roadmap: H14 is a **gate for P2** (and default-on wherever retail clients and dense bases
    coexist), not an optional later item.
- **Churn**: piece objects that leave a retail session's view are not re-sent for 30 s (hysteresis), to respect the
  client's 25 s retention.

## 6. Tests
- A non-capable session (the Rust `holtburger-cli` standing in for retail, as in the vehicle work) in a dense base:
  - zero extension messages received;
  - ≤ the piece budget;
  - walls block it (H14 on);
  - it sees raiders die and turrets fire.
- A real retail client by hand when available (owner).

## 7. Decisions proposed
- **D13.1** Retail tier 0 sees solid pieces, nests, turrets, raiders and NPCs as ordinary ACE objects within budget;
  nothing cosmetic.
- **D13.2** Movement validation against overlay solids is mandatory for any session not sent every nearby solid piece.
- **D13.3** Quartermaster NPCs let retail players supply and draw from factories through Give.
- **D13.4** Raid warnings and threat notices reach retail as standard chat.

## 8. Open questions
- **Q13.1** Is a tier-1 DAT patch for the expansion (custom piece models, airframe) worth distributing? The community
  notes that few servers use DAT patching (#worldbuilder 2025-06-01).
- **Q13.2** The retail piece budget (300) needs crash-test data from a real retail client.
