# Glossary

| Term | Meaning |
|---|---|
| **Abstract fidelity** | A zone's new-layer state simulated without ACE objects: factory events, ecology fields, statistical raids ([04 §3](04-target-architecture.md)) |
| **AC protocol** | Asheron's Call's 1999 UDP protocol: ≤ 484 B datagrams, fragments, ISAAC-keyed checksums, ACK/NAK reliability |
| **ACE** | Asheron's Call Emulator, the C# server. Here, the fork at `~/ace-server` (upstream `a8ff29f` + the vehicles patches) |
| **Adapter (trifecta adapter)** | Thin in-process ACE module bridging ACE and the WSS ([10 §4](10-server-runtime-and-scaling.md)) |
| **Airspace transit** | High-band flight that loads no landblocks: the pilot stays anchored in one landblock with relocation suspended, while the vehicle plane tracks the real 3D pose ([09 §4.1](09-vehicles-airpower-ordnance.md)) |
| **Allegiance** | AC's guild: a monarchy tree of patrons and vassals; ACE `AllegianceManager` |
| **Bedrock** | The immutable classic world: DAT terrain, DAT buildings and dungeons, scenery, world-DB spawns, quests ([06 §2](06-dynamic-world.md)) |
| **Biota** | ACE's persisted object: one row plus per-property rows in the shard DB (an EAV schema) |
| **Capability bits** | A per-session bitmask, announced by the client, that gates extension messages (HBV1 today, HBC2 proposed) |
| **Catalog** | Versioned data listing every buildable piece, machine and NPC template with its model, HP, costs and disturbance |
| **Cell** | 24 m × 24 m outdoor terrain cell (8 × 8 per landblock); also an indoor EnvCell |
| **Character plane** | ACE's domain: characters, items, combat, quests, the classic world, materialized objects |
| **Claim** | Land a player or allegiance owns on the 24 m grid; tiers Outpost, Holding, Stronghold, Domain ([06 §5](06-dynamic-world.md)) |
| **Commodity** | A fungible stack (kind, grade, count) used by factory logistics instead of ACE items ([07 §3](07-factories-and-logistics.md)) |
| **Contested region** | An owner-designated area with territory-war rules for structures |
| **DAT** | The retail data files (portal.dat, cell.dat): models, terrain, buildings, dungeons |
| **Dematerialize** | Hand state back from ACE to the WSS when a zone goes dormant or unloads |
| **DES** | Discrete-event simulation: advance from event to event; stocks change linearly in between ([07 §4](07-factories-and-logistics.md)) |
| **Disturbance (D)** | A diffusing field of industrial noise that attracts and feeds monsters ([03 §3](03-systems-dynamics.md)) |
| **Dormant** | An ACE landblock idle for 1 min: physics and monster AI stop; generators, heartbeats and saves continue |
| **Ecology variant** | A data-only copy of an existing creature weenie with tuned XP, loot and bounty tags |
| **entityArena** | Designed but unbuilt cross-rig instancing in holtburger-web (R3-9); a prerequisite for big raids |
| **Flow descriptor** | A belt segment's closed-form description (path, speed, spacing, item pattern, time origin) |
| **Flow field** | A per-raid direction field over a walkability grid that every raider follows |
| **Frontier** | Land open to claims and to the ecology |
| **Gateway** | The edge process terminating browser connections (WebTransport + WebSocket), evolved from `holtburger-wsbridge` |
| **Generator** | An ACE object that spawns others (monsters, items) by profiles; static caps; re-rolled on landblock reload |
| **HBV1 / HBC2 / HBW1 / HBF1 / HBE1** | Extension message families: vehicles (exists); capabilities v2; world overlay; factory; ecology |
| **High band** | 600 m – 5 km AGL; reachable only by aircraft ([09 §3](09-vehicles-airpower-ordnance.md)) |
| **holtburger-web** | The browser client: Rust/wasm + three.js (WebGL2), Chrome-targeted |
| **Landblock** | 192 m × 192 m world tile; 255 × 255 of them; ACE's unit of loading and simulation |
| **Load governor** | The control loop that sheds fidelity under load, ending in portal storms ([10 §6](10-server-runtime-and-scaling.md)) |
| **Low band** | 30–150 m AGL; the combat band, reachable from the ground |
| **Materialize** | Instantiate a zone's overlay as real ACE objects because players are present |
| **Module** | A catalog piece that is a multi-part Setup and counts as one ACE object |
| **Nest** | An ecology structure (mound, hive, war camp, spire) with a hardened core |
| **ObjectMaint** | ACE's per-object visibility tables; first sight 112.5 m |
| **Overlay** | The mutable new layer: claims, structures, machines, logistics, NPCs, nests |
| **Permaload** | ACE config that keeps a landblock loaded and active forever |
| **Portal storm** | Retail AC's crowd valve: overcrowded areas teleport players away; the client messages are 0x02C9–0x02CC |
| **Raid director** | The WSS component that plans raids: target, composition, route, warning |
| **Representation ladder** | Tiers of client capability: retail, + DAT patch, + Chorizite plugin, holtburger-web |
| **Sanctuary** | A zone with no claims, no ecology and no raids (towns, landmarks) |
| **Setup / GfxObj** | DAT model records: a multi-part model / a single mesh with physics BSP |
| **Siege behaviour** | New ACE AI for raiders: follow route hints, attack blocking pieces, no leash ([10 §4.4](10-server-runtime-and-scaling.md)) |
| **StructurePiece** | An overlay piece materialized in ACE as an immobile creature, so ACE's combat applies |
| **Threat level T(z)** | Per-zone 0–5 summary of the ecology, driving warnings, bounties and strikes |
| **TP (threat points)** | Level-scaled monster head-count unit of the ecology model |
| **`trifecta-sim`** | The single deterministic Rust simulation core: WSS (native), offline simulator, client (wasm) |
| **Vulnerability window** | A daily window, chosen by the defender, in which PvP may finish a reinforced claim |
| **Weenie / wcid** | An ACE object template / its class id |
| **World-model simulator** | Offline runs of `trifecta-sim` with synthetic players, for tuning and forecasting ([03 §9](03-systems-dynamics.md)) |
| **WSS** | World State Service: the new process owning the overlay ([04](04-target-architecture.md)) |
| **Zone** | The ecology and overlay grid unit; one landblock in v0 |
