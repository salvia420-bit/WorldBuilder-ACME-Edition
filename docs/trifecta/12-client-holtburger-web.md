# 12 — Client: holtburger-web

Status: **draft v0.1** (2026-11-03).
Depends on: [04 architecture](04-target-architecture.md), [11 network](11-network-and-interest-management.md).
Sources: the client survey of 2026-11-03 (facts below cite the code and the handoffs). `W` =
`external/holtburger/apps/holtburger-web`, `D` = `W/docs`.

## 1. What the client is today

holtburger-web is a Chrome-targeted browser client: Rust compiled to wasm, with JS and three.js r184 on WebGL2. The
browser talks to ACE over one WebSocket to `holtburger-wsbridge`, which relays raw AC packets to ACE's UDP ports
(`D/network-adapter-2026-10-23.md` §1).

| Layer | Owns | Size / note |
|---|---|---|
| wasm (`W/src`, crates `holtburger-*`) | Packet codec, ISAAC, fragments, session, world state, **physics and BSP collision**, the retail motion stack, DAT decode, the scene-core kernels (rig, cull, anim, particles) | `W/src/lib.rs` is 63,811 lines; release wasm ~8.0 MB |
| JS `scene3d/` | three.js scene graph, EntityManager rigs, residency (grid + LRU), HUD, the vehicle module | `entities.js` is 20,683 lines |
| Workers | Bake worker (its own wasm), shard-fetch worker, texture (basisu → BC7) worker, net worker (bots), keepalive | All default ON except the net worker for humans |
| Service worker | Content-addressed cache of `shards/`, `boot.hba`, manifests (sha256-verified) | Static content only |
| Baked world (`dist/`) | DAT records as content-addressed shards; 17,682 packs (301 MB: 2×2-landblock tile packs + interiors); scenery; spawns; the whole-map world tier (8.1 MB) | **World geometry does not come from ACE** |
| Live from ACE | Everything that arrives as CreateObject: NPCs, monsters, players, items, doors, portals | First sight 112.5 m (`ObjectMaint.InitialClamp_Dist`) |

**Performance envelope (1070, the owner's baseline GPU):**
- Holtburg ultra at 1080p runs ~52–58 fps. The **main thread is the binding resource**: ~20–23 ms per frame, ~98 %
  busy, and render JS costs ~13 µs per draw against ~0.4 µs of raw GL (`D/2026-10-29-round3-gpu-driven.md`,
  `D/HANDOFF-round3-final-2026-10-31.md`).
- Flight at 100 m AGL holds 842–923 resident entities and ~13k part meshes. Cruise is ~360–410 draws.
- JS heap is 1.6 GB at Holtburg ultra. Total wasm across the instances is ~900 MB.

**Two measured weaknesses that the expansion makes worse:**
1. **Entities are expensive.** A humanoid rig is ~34–40 draws. Only 4 of 128 entity (geometry, material) pairs are
   shared, nothing instances across rigs (`?entityBatch` is per-rig and OFF; the cross-rig "entityArena" is designed,
   R3-9, not built). A raid of 100 monsters would add ~3,500–4,000 draws.
2. **Spawns are slow.** In the first minute after login or teleport, entity spawns took p50 3.3 s / p90 15.5 s / max
   44.8 s (219 spawns; vehicles DESIGN decision 53). The dispatcher starts 6 spawns per tick
   (`scene3d/loop.js:3980`, `spawnDispatchPerTick`).

### 1.1 The platform: what Chrome gives and what it costs
"Chrome-only" is practice, not enforcement: every measurement on file is Chrome (ANGLE on D3D11, the 1070) or
headless Chromium on SwiftShader (the laptop). That platform shapes the expansion.

| | Fact | Consequence for the expansion |
|---|---|---|
| **Costs** | The GPU process takes 14.4–15.1 ms per present on the 1070, capping it at ~67–69 fps once the main thread is faster (`D/2026-10-26-rust-scene-core.md`) | Frame budget is shared with Chrome's own compositor; the overlay must stay ≤ 2 ms main thread |
| | ANGLE turns each `WEBGL_multi_draw` range into a full draw: 1,921 `info.calls` = 5,838 real draws (`D/2026-10-29-round3-gpu-driven.md` "ANGLE ground rule") | Reduce draws with **instanced runs** and merged geometry, never multi-draw ranges |
| | A first-draw shader link costs 0.5–1.7 s of FXC on the 1070 (HIGH-BAND §1) | New programs link off the frame (`compileAsync`); piece types share the statics materials, never a program each |
| | JS heap 1.59–1.61 GB at Holtburg ultra against a 4.40 GB V8 limit (`scene3d/residency_grid.js:100-110`); ~900 MB of wasm across the instances (`external/holtburger/docs/rynth-integration/HANDOFF-wasm-threads-SAB-2026-07-24.md`); a wasm32 instance cannot address more than 4 GB | The overlay has an explicit memory budget (≤ 200 MB, §4) and an LRU chunk cache |
| | Background tabs are throttled (the client already runs a keepalive worker) | Session keepalive stays in a worker; nothing in the overlay depends on rAF while hidden |
| | SharedArrayBuffer needs cross-origin isolation (COOP/COEP), off by default; the wasm-threads experiment was negative | Do not plan the overlay around wasm threads; use workers with message passing |
| **Gives** | **WebTransport** (Chrome since 2022) | QUIC datagrams for the AC packets, streams for the overlay ([11 §3](11-network-and-interest-management.md)) |
| | **WebGPU** (Chrome since 2023), not used today (the rendering charter's N4) | Optional later path for compute culling and indirect draws (belts, raids); not required (D12.6) |
| | Origin Private File System, IndexedDB, CompressionStream | A persistent, version-keyed overlay chunk cache (Q12.2) |
| | `KHR_parallel_shader_compile`, `EXT_clip_control` (reversed-Z to 250 km), BC7 textures | Already in use; the high band depends on them |
| | Long Animation Frames, `scheduler.postTask`, fetch priority hints | Main-thread scheduling and diagnosis for the overlay's work |

**What already works for the overlay:** a server object with a retail Setup DID renders, and the client **collides
with it** using the Setup's physics BSP (COL-03, `objCollideInTransition` on). Plain walls and machines sent by ACE
would work today, slowly and expensively.

## 2. Requirements from the expansion

| # | Requirement | Why |
|---|---|---|
| C1 | Draw the overlay's pieces at static-content cost: up to ~1,000 solid + ~5,000 cosmetic pieces per landblock, many landblocks in view | Bases are built from hundreds to thousands of pieces |
| C2 | Overlay ranges match baked statics (~770 m, `objRadius` 4) instead of ACE's 112.5 m first sight | A base should not pop in at 112 m when the town behind it is drawn at 770 m |
| C3 | Collide locally with overlay solids, identically to ACE's physics | Prediction must agree with the server; walls must block |
| C4 | Show damage, destruction and rebuilding per piece | P2: the frontier is malleable |
| C5 | Animate thousands of belt items, machines and power at near-zero CPU | Factories are endless |
| C6 | Build mode: placement ghost, snapping, validity, blueprints, deconstruct | The core verb of the factory leg |
| C7 | Factory UI: machine panels, logistics and power overlays, throughput | Factories are a management game |
| C8 | Map overlays: claims, threat levels, fronts, incoming raids | Information delay is a stability parameter ([03 §5.3](03-systems-dynamics.md)) |
| C9 | Many monsters (raids) and many aircraft at affordable draw cost | Raids of 50–200; air wings |
| C10 | Total added main-thread cost ≤ ~2 ms/frame in a dense base view on the 1070 | The main thread is already the limit |

## 3. Design

### 3.1 Overlay pieces render through the statics path, not the entity path (C1, C2)
- Overlay pieces are static or rarely changing, so they belong with the **baked statics**: instanced runs per
  geometry, texture-array pages, frustum culling per chunk. They do not belong in the EntityManager with its
  per-rig scene graph.
- The client receives overlay chunks over the **HBW stream** ([11 §5](11-network-and-interest-management.md)), not as
  ACE CreateObjects. The server suppresses the ACE CreateObject of structure pieces for capable sessions (the same
  gating as the vehicle messages), so nothing is drawn twice.
- New module `scene3d/overlay/`:
  - the chunk cache (versioned, persisted in IndexedDB/OPFS, so a revisit costs only deltas);
  - the piece renderer: instanced runs via the static buckets' `batchedRuns` path or the GPU batch kit's pages,
    where per-piece state (HP tint, damage variant, hidden) lives in a row texture;
  - the collider registrar (§3.2);
  - the build-mode UI (§3.5).
- Piece models are the **same base-DAT Setups and GfxObjs** that ACE and retail use ([04 §4.2](04-target-architecture.md)).
  They go through the existing decode (`fetch_model_meshes` → triangulate → pack), the existing material system and
  no new shader program, as the Hellcat airframe does (vehicles DESIGN decision 62).
- **Distance LOD**: beyond ~300 m, a chunk's pieces collapse into a merged per-chunk mesh, rebuilt on change and
  off-thread in the bake worker. Beyond `objRadius`, bases appear in the world tier as a footprint tint, like the far
  forest's canopy tint.

### 3.2 Collision with the overlay (C3)
- wasm `holtburger-world` gains an **overlay collider layer**: a static spatial index of overlay solids, each with its
  Setup's physics BSP (the same fetch that COL-03 uses for entities), and transforms from the chunk stream.
  `populateTerrain` already shows the pattern of runtime-overwritable collision data.
- The player's movement resolver tests overlay solids like DAT statics.
- **Consistency rule**: the server's materialized `StructurePiece` uses the same Setup and the same transform, so
  client and server physics agree.
- **Caution, verified in code.** ACE **computes** a collision transition for a player's requested position and then
  **discards it**:
  - `UpdateObjectInternalServer` runs `transition(Position, RequestPos)` (`S/Physics/PhysicsObj.cs:1778`);
  - `update_object_server(forcePos = true)` then sets the requested position anyway (`PhysicsObj.cs:4266-4277`);
  - only a jump of more than one landblock is rejected, plus a z-position check
    (`S/WorldObjects/Player_Tick.cs:411-491`).
  - Walls therefore hold only because honest clients collide locally.
  - Server-side movement validation against overlay solids (H14, [10 §3](10-server-runtime-and-scaling.md),
    [14 §3](14-security-integrity-griefing.md)) is what makes them hold against modified clients and against retail
    clients that were not sent every piece.
- Known cost: the per-object BSP is flattened into one leaf whose polygons are all tested (`obj_collision.rs:126-130`).
  The catalog prefers models with low physics-polygon counts, and the index bounds tests by cell.

### 3.3 Damage, destruction, rebuild (C4)
- Per-piece HP arrives as overlay deltas; pieces in a materialized zone also receive ACE's normal damage messages.
- The client maps ACE GUID ↔ piece id through an HBW `PieceBinding` message sent with materialization. Selection,
  targeting and health bars then work: clicking a wall targets its ACE GUID, so melee, missile and spells use ACE's
  normal attack path.
- Damage states: three visual stages per catalog entry (intact, damaged, ruined). Use retail damage variants where a
  model has them; otherwise a tint and decal ramp in the row texture.
- Destruction: a collapse effect from the existing particle and VFX systems, then client-only cosmetic debris that
  despawns. The piece leaves the collider index in the same frame as its removal delta.

### 3.4 Belts, items, machines at near-zero CPU (C5)
- **Closed-form motion.** The server sends, per belt segment, a **flow descriptor**: path, speed, item spacing, and
  item-type pattern (run-length), plus a time origin. The vertex shader places every item from `t`. The CPU writes
  rows only when a descriptor changes. The precedents are already in the client:
  - `?gpuParticles` (the vertex shader evaluates retail's closed-form particle motion);
  - `anim_scenery_gpu` (3,411 instanced placements posed in the vertex shader, ~30 rows written per frame).
- `trifecta-sim` in wasm ([04 §5](04-target-architecture.md)) computes the same descriptors locally between server
  updates. Belts that the server reports as unchanged keep moving smoothly with zero traffic.
- Items use their retail icon-model where one exists (a quarrel, a keg, an ingot-like model). Otherwise they use a
  small catalog of cosmetic meshes. One instanced draw per (item model, page).
- Machines: animated parts through the `anim_scenery_gpu` style (pose rows), and particle effects (smoke, sparks)
  through the particle system with the vfx write invariant ([MEMORY] vfx-write-invariant: never change light counts,
  no per-instance program keys).

### 3.5 Build mode (C6)
- Placement ghost (translucent catalog model) on a snap grid (v0: 0.5 m position, 15° rotation; walls snap
  end-to-end), with live validity colouring computed by `trifecta-sim`'s **placement rules in wasm**: claim, zoning,
  overlap with bedrock statics and other pieces, slope, budget. The server re-validates authoritatively.
- Blueprints: copy a selection to a named blueprint and paste it as a ghost set. The server places what the player
  can afford, in an order that respects support rules.
- Deconstruct with partial refund; repair mode (spend materials to restore HP).
- Input: the existing controls framework (keyboard, mouse, gamepad) with a build-mode input lock, like the vehicles'.

### 3.6 Factory and world UI (C7, C8)
- Machine panel: recipe, input/output buffers, power, status, throughput history (from the DES's event log).
- Overlays on the 3D world and on the map:
  - logistics (belt and rail flow, bottlenecks in red);
  - power grid;
  - claims (own, allegiance, others; protected zones);
  - threat map (per-zone level and fronts, [08](08-monster-ecology.md));
  - incoming raids with ETA.
- The HUD follows the existing plugin and shell architecture (`docs/ui-shell-plugin-architecture-spec-2026-05-17.md`).
  Per [MEMORY] HUD fixes apply directly and are not URL-flag gated.

### 3.7 Many monsters and many aircraft (C9)
- **The entity path must instance across rigs** before large raids ship. The design exists: R3-9 `entityArena`, one
  instanced run per (part geometry, class, page) with per-instance pose rows (`D/2026-10-29-round3-gpu-driven.md`
  §R3-9). Raid monsters share species, so palettes and geometry repeat and instancing pays most exactly where raids
  are.
- **Raid warnings double as prefetch hints.** The raid director announces species and approximate count minutes
  ahead ([08 §7](08-monster-ecology.md)). The client prewarms those rigs (Setups, MotionTables, surfaces) in the bake
  worker, so arrival does not hit the cold-spawn tail.
- Distance LOD for monsters: beyond ~150 m in a raid, impostors or a reduced-part rig. The vehicles work already stops
  drawing rigs beyond 450 m in flight, which took 42.8 → 45.1 fps.
- Aircraft: the airframe composite (55 parts → 13 material buckets) is shared per profile. N aircraft of a profile
  become one instanced run per bucket.

### 3.8 Terrain
- No terrain deformation in v1 (P1). Craters, scorch, nest creep and claim borders are **projected decals and
  terrain overlay textures**, keyed per landblock and streamed with the overlay.
- Foundations and platforms (catalog pieces) provide flat building surfaces instead of flattening terrain.
- If deformation is ever wanted: collision heights can already be swapped (`populateTerrain` overwrites), but the
  render mesh is baked once per landblock, the world tier and far ring are baked, the grid is 24 m, and **the server
  reads DAT heights** (vehicles DESIGN decision 16). It would be a cross-plane feature, not a client feature.

### 3.9 Transport (with [11](11-network-and-interest-management.md))
- Add a **WebTransport** transport (QUIC) beside the WebSocket one, as specified in [11 §3](11-network-and-interest-management.md):
  - **AC packets on datagrams**, both directions. Vehicle state (HBV) already rides inside the AC protocol;
  - the session's NAK policy tightened to match ACE's (first gap NAKed after ~2× RTT, not 1 s);
  - the overlay streams on their own reliable QUIC streams, so a big chunk snapshot never head-of-line-blocks game
    packets.
- WebSocket stays as the fallback. The network-adapter analysis already names WebTransport datagrams as "the
  structural fix for players on lossy links".

## 4. Budgets (v0; to be measured on the 1070)

| Item | Budget | Notes |
|---|---|---|
| Overlay draws in a dense base view | ≤ 150 | Instanced runs per (geometry, page); merged LOD beyond 300 m |
| Belt items visible | ≥ 50,000 | One instanced draw per item model; closed-form vertex shader |
| Main thread, overlay + belts + UI | ≤ 2 ms/frame | Row uploads only on change; no per-item JS |
| Raid of 100 monsters | ≤ 300 draws | Requires entityArena |
| Overlay memory (JS + GPU) | ≤ 200 MB | Chunk cache LRU; page budget shared with the GPU batch kit (128 MiB VRAM cap today) |
| Overlay chunk cache on disk | ≤ 500 MB | OPFS / IndexedDB, version-keyed, LRU |

## 5. Things the client must not do
- Decide anything. Placement validity in wasm is advisory; the server decides ([14](14-security-integrity-griefing.md)).
- Hide or alter DAT buildings or terrain (P1). There is no per-placement unload of baked buildings, and none is
  needed.
- Add a shader program per piece type, or change light counts (relink freezes; [MEMORY] vfx-write-invariant).
- Hold per-item JS objects for belts.

## 6. Workstreams

| ID | Work | Done when |
|---|---|---|
| CL-1 | HBW / HBF protocol in `holtburger-protocol` (+ fixtures), session events in wasm | Round-trip fixtures pass; the session exposes overlay events |
| CL-2 | `scene3d/overlay/` chunk cache + instanced piece renderer | 1,000-piece test base: ≤ 150 draws, ≤ 1 ms main thread on the 1070 |
| CL-3 | Overlay collider layer in wasm | Walk into a wall: blocked locally, 0 server corrections |
| CL-4 | Damage, destruction and the `PieceBinding` target mapping | Attack a wall on foot; health bar; collapse |
| CL-5 | Belt renderer (closed-form) + `trifecta-sim` wasm descriptors | 50k belt items at ≤ 0.5 ms/frame |
| CL-6 | Build mode + blueprints | Place, rotate, snap, validate, deconstruct |
| CL-7 | Factory panels, map overlays, threat map | Owner playtest |
| CL-8 | entityArena (cross-rig instancing) + raid prefetch | 100-monster raid at ≤ 300 draws, no spawn tail > 2 s after warning |
| CL-9 | WebTransport transport | Lossy-link test: no HOL stalls over 200 ms on game packets during chunk downloads |

## 7. Decisions proposed
- **D12.1** Overlay pieces render through the statics path (instanced runs, merged LOD), never as EntityManager rigs.
- **D12.2** = D11.5, restated for the client: capable clients receive structures over the HBW stream, and ACE does
  not send them CreateObjects for structure pieces.
- **D12.3** Belts and items are closed-form, GPU-evaluated, descriptor-driven.
- **D12.4** Cross-rig entity instancing (entityArena) is a prerequisite for raids larger than ~30 monsters.
- **D12.5** = D06.7, restated for the client: no terrain deformation in v1. Decals and overlays carry craters,
  creep and borders.
- **D12.6** WebGL2 remains the substrate. WebGPU is a later option, not a requirement, consistent with the rendering
  re-engineering charter's N4.

## 8. Open questions
- **Q12.1** Where does the build UI live on a 1080p HUD already dense with retail panels? It needs a UX pass.
- **Q12.2** OPFS or IndexedDB for the overlay chunk cache (quota behaviour in Chrome)?
- **Q12.3** Do retail damage-variant models exist for the candidate wall pieces? This is a DAT survey task (pass 2,
  with the WB.Terminal asset tools).
