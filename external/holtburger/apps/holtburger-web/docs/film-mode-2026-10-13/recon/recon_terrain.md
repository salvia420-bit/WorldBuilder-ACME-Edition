# TERRAIN, STREAMING, RESIDENCY, COORDINATES (holtburger-web; paths relative to HB=external/holtburger/apps/holtburger-web unless absolute)
VERIFIED MAP. Every file:line below was read in this pass unless an entry is marked otherwise. Bottom line: all streaming and residency is centred on the PLAYER. The camera only affects render-side things: view-cell walks, fog distance, LOD, frustum culling, and the order the far ring fetches in. A film camera more than ~1 km from the player films a void. The two workable designs are: (A) teleport the character, or a dedicated GM/camera character, near every shot; or (B) add a default-OFF 'film focus' seam at the 6 player-centre sites listed under seams.

Q1 TERRAIN HEIGHT / NORMAL / WATER
(a) wasm `SessionHandle.terrainHeightAt(world_x, world_y): number|undefined` (pkg/holtburger_web.d.ts:6652).
- Takes GLOBAL AC world metres: +X east, +Y north, Z up.
- Returns a triangle-plane height on the retail split diagonal.
- Reads the collision_scene shadow, which refreshes at most every 100 ms.
- Both arguments are bound as f32, so they are quantised by up to ~2 mm at Dereth coordinates (terrain_oracle.js:640-656).
- Returns undefined unless the landblock is in the wasm terrain cache. The only feeder is `populateTerrain` from app/landblock_stream.js:722 `ensureTerrainAroundLandblock`. That runs for the 3×3 around each landblock named by the local player's position packets (world_stream.js:329-332), and terrainPrefetchedLbs only ever grows.
- So for landblocks 500 m–2 km from the player it is UNDEFINED. camera.js:2006 `_terrainFloorZ` uses it with a 0.5+0.2 m margin.
(b) JS oracle `createTerrainOracle()` (scene3d/terrain_oracle.js:289). It does not depend on THREE.js.
- `sample(x, y, out?)` (line 481) returns {height, normal{x,y,z}, code, family, cornerCodes[SW,SE,NW,NE], cornerRoads, roadEdgeM, lbX, lbY, lbKey, hasHeight}.
  - `normal` is the exact AC-frame face normal.
  - `code` is the nearest-vertex terrain code, masked with &0x1f.
- `heightAt(x, y)` (line 659) returns a number, or null when the landblock is not cached.
- `noteLandblock(lbKey, {codes, heights, roads, lbX, lbY})` (line 356) adds a landblock.
- It is a JS port of terrain_subdiv: cellSwToNeCut :83, triangleHeightInCell :97, triangleGradInCell :123.
- It matches wasm to ~1e-5 only if you pass `Math.fround(x)`, `Math.fround(y)`.
- The live instance is `window.__terrainVfx.oracle` / `ensureOracle()` (terrain_vfx.js:624,979). It is fed on every near-ring terrain bake, survives park, and drops a landblock on evict or rebake. It returns NULL for landblocks that were never baked.
(c) For ANY landblock, regardless of residency, use `liveScene3d.wasmExports.fetch_landblock_heightmaps(Uint32Array[(lbKey|0xFFFF)>>>0], urgent=false)`, which returns `Promise<LandblockMesh[]>` (d.ts:9033).
- LandblockMesh fields (d.ts:2064-2142): `.heights` Float32Array(81) with idx = vx*9+vy, plus `.terrainCodes`, `.roadCodes`, `.heightMin`/`.heightMax`, and `.positions` in landblock-local coordinates.
- You must call `.free()` on each mesh.
- The whole batch rejects if any single id fails.
- Cost is 6.0–8.8 ms per landblock cold and 0.01 ms warm (far_terrain.js:1377-1382).
- Feeding a private oracle this way gives exact retail heights and normals for a whole flight corridor before you fly it.
(d) The drawn surface equals the physics surface since 2026-06-26 (terrain.js:7162-7171): subdivided vertex Z is computed with triangle_height_in_cell. Only two visual deviations exist:
- a rounding fillet of at most 8 cm (terrain_round.js:60/104);
- water swell with an envelope of ~0.25 m, total ≤0.4 m (terrain.js:954-1000).
(e) Water is a terrain code, not a separate plane. The default strict set is codes 16-20 (terrain.js:1042). Test with `isWaterCode(code)` (terrain_families.js:213); FAM_WATER = 8. Water surface = terrain height + swell. `retailLandNormals(heights, lbX, lbY)` (far_terrain.js:330) gives retail per-vertex lighting normals.

Q2 WHAT STREAMING IS CENTRED ON: the PLAYER everywhere. There is no camera-driven residency.
(1) PVS bake ring, `tickPvsLoadExpansion` (cells.js:4388):
- `seen` = landblock keys of `sessionHandle.getRenderSet(1)` (cells.js:4421). That is the BFS rooted at the PLAYER's cell (d.ts:4530-4541); outdoors it is {player LB}.
- The ring is radius `scene3d.pvsRingRadius`, default 5 (residency.js:51/187).
- It fires terrain, statics and buildings nearest-first, with at most 6 bakes in flight.
- It collapses to 1 indoors, to 0 when sealed, and is capped by fog (cells.js:4489-4516).
- It publishes `_pvsEffectiveRingRadius` (:4658).
(2) world_stream `onPositionUpdate` (world_stream.js:251), driven by the local player's KIND_POSITION packets:
- 3×3 terrain via loadTerrainRing, which goes through the FixedSlotGrid (radius 1) and EdgeParkScheduler.
- Single-landblock buildings, statics, spawns and EnvCells.
- 3×3 collision.
(3) LRU `getCurrentLbId` (index.js:6596-6620) = floor(rig root.position / 192). It drives `tickEviction` (index.js:2605-2631), LOD rebake (:2652), the 1 Hz terrain hole audit (:2663) and the entity reaper (:2686).
(4) Far ring `playerLb()` (far_terrain.js:1070) = currentLandblockKey ?? playerLbKey ?? getLocalPlayerWorldPos. Camera forward only biases fetch ORDER (:1290-1320, 1359).
(5) objRadius uses `seen` as its centres (object_radius.js:156; cells.js:4446).
(6) Subdiv LOD reference `opts.playerLbKey` (terrain.js:5587).
(7) Viewer cell, render only: a wasm walk from the PLAYER's head to the camera eye (cells.js:2849-2873). It re-roots render walks, not streaming (viewer_cell.js:22-27).
(8) Server (ACE, external/ACE ObjectMaint.cs:337-355,420-445):
- Outdoors, objects are visible for the player's current landblock + adjacent, i.e. 3×3.
- A first sighting needs a 2D distance ≤112.5 m (InitialClamp).
- Objects are destroyed 25 s after leaving visibility (:21).
- The client reaper keep-zone is 8 LB (residency.js:190).
Camera 500 m–2 km from the player:
- NOTHING new loads for the camera and nothing extra unloads.
- What the camera sees is the player's world: objects within ≤4 LB, near terrain within ≤5 LB, far albedo terrain within ≤8 LB.
- Beyond 1632 m from the player's landblock centre there is no ground at all.
Override / prewarm: there is NO focus override API.
- `liveScene3d.previewSpawnArea({cell,x,y,z})` (index.js:4234) works only before spawn; it returns null once a pose exists.
- Per-landblock loaders are public: loadTerrainForLandblock :4002, _runTerrainRingBatch :4211, loadBuildingsForLandblock :4286, loadStaticsForLandblock :4337, loadEnvCellsForLandblock :3907, loadSpawnsForLandblock :4412. Caveats are in hazards.
- Runtime knobs: `liveScene3d.pvsRingRadius`, which is read every tick (cells.js:4462), and `landblockLru.maxResident`.
- Moving the player is the reliable way: `window.__sessionHandle.sendChat('@teleloc …')` (d.ts:6096).
Readiness signals:
- `terrainBakedLbs` / `staticsBakedLbs` / `buildingsBakedLbs` / `envCellLoadedLbs`. Note the terrain mark is set BEFORE the mesh attaches (terrain.js:5955 vs 6814).
- `_streamGuardState.inFlight` keys `terrain:<lbKey>`, `statics:<lbKey>`, `buildings:<lbKey>`.
- `landblockLru.isParked()`.
- `_pvsSweepIncomplete === false` (cells.js:4828/4855).
- `_terrainAuditStats.lastPending`.
- `window.__farTerrainState().ring`.
- `__terrainBatch.stats().visibleRows`.
- `__landblockLru.getStats()`.
- `__diag.bakeWait()`.
- `window.__groundDrawnAt`.
- `window.__interiorBuildPending`.
- `collisionResidencyDiag()`, whose field terrainHeightLbs counts wasm height-cache landblocks.

Q3 BAKED vs STREAMED.
Client-baked from dist via wasm, available for any landblock on demand:
- terrain heightmaps (cell.dat 0xXXYYFFFF);
- LandblockInfo statics and buildings (0xXXYYFFFE);
- procedural scenery (dist/scenery/0xXXXX.scenery.jsonl, statics.js:700-714);
- EnvCell interiors and dungeons (fetchEnvCellsInLandblock);
- synthetic ACE spawns (dist/spawns/*.jsonl, ~38k landblocks), injected only when there is no session or with `?spawns=force` (spawns.js:123-152). Forcing it with a live session DUPLICATES every spawn.
Server-streamed: creatures, NPCs, players, items, corpses, etc. These exist only within the player's 3×3 landblocks, with a 112.5 m first-sight clamp.
So a far drone shot over terrain the player has not visited shows:
- terrain plus statics, buildings and scenery only inside the player's object radius;
- flat albedo terrain with NO trees or buildings at 5–8 LB;
- NO creatures beyond about the player's 3×3;
- interiors only for the player's landblock and a radius-1 skirt (cells.js:914-938; 1 start per tick, 2 in flight).

Q4 DRAW DISTANCE.
- Camera: PerspectiveCamera(60°, near 0.1, far 5000) with logarithmicDepthBuffer (index.js:1625, 1162). `?retailFov=on` gives 90°.
- Near ring: pvsRingRadius 5 → 11×11 landblocks, drawn edge (R+0.5)·192 = 1056 m. `?pvsRingRadius` accepts 0..12. LRU cap = span²+2·span+8 = 203 (index.js:6488-6512).
- Objects: `?objRadius` default 4. Bakes happen for d ≤ 4 and objects are HIDDEN at d > 5 (object_radius.js:52-176); `?objRadius=off` restores full-ring objects.
- Far Composite Ring (default ON; far_terrain_flags.js:72/85):
  - radius 8 → 1632 m edge, `?farRadius` 1..16;
  - 4×4-LB albedo patches, heights only, no objects;
  - fetches only when the near ring is idle, with a 10 s starvation escape, 2 in flight;
  - 1 patch bake per frame (~1.2 ms GPU);
  - a patch appears only after all 16 of its landblocks have baked;
  - patches retire at d > R+4 (far_terrain.js:1268-1350).
- Fog: horizon band far = 0.95·(R_eff+0.5)·192 (with a 700 m floor), near = max(authored fogMin, 0.62·edge) (far_terrain_flags.js:283).
  - With the far ring solid that is ~1012→1550 m; with the near ring only, ~655→1003 m.
  - It is applied in loop.js:2273-2310.
  - It is plane depth from the CAMERA; `?radialFog=on` makes it range-based.
  - `?fogRingCap` (default ON) shrinks the bake ring to ceil(authored fogMax/192)+1 (~4 at night) (cells.js:873, 4510).
  - The MAX_LIVE_GEOM=8000 governor can collapse the near ring to effective radius ~3 on long tours (landblock_lru.js:301; far_terrain.js:120-130).
- From 100–500 m AGL over the player: about a 2.1 km square at full detail and about 3.3 km of albedo terrain, then sky.
- Pop and latency:
  - near ring bakes are capped at 6 in flight and skip when the cap is hit;
  - per-landblock statics stalls of 100–500 ms were measured (bake_worker_client.js:37-45);
  - EnvCells for Academy are ~568 cells per landblock;
  - texture tier promotion (t1024, 68 MB) arrives after in-world (bandwidth_tier.js:322);
  - statics swap to their degraded LOD at 100 m from the camera (statics.js:288).
- Fast camera moves cause NO streaming. Pops come from camera-distance LOD and from player movement: ring shifts, objRadius hysteresis, and EdgeParkScheduler trailing-edge parks.
- Bake worker (default ON): its own wasm instance and resource source, a transparent main-thread fallback, and a fetch concurrency split of 8 for the worker and 24 for the main thread (bake_worker_client.js:1-75).

Q5 COORDINATES.
- Cell id = (x_byte<<24)|(y_byte<<16)|cell.
  - Outdoor cell = cx·8+cy+1 with cx = floor(localX/24), cy = floor(localY/24), giving 1..64 (radar.js:213; d.ts:4258-4266).
  - EnvCell ids are ≥0x100.
  - 0xFFFE = LandblockInfo key; 0xFFFF = terrain record and `userData.lbId` form.
- lbKey = id & 0xFFFF0000 >>> 0 (landblock_lru.js:494-500). ALWAYS apply `>>> 0`, because bitwise ops give signed int32.
- Landblock-local x,y run 0..192 m; z is absolute altitude.
- Global wx = lbX·192 + x and wy = lbY·192 + y (app/landblock_stream.js:221; cells.js:712-733).
- Inverse: lbX = floor(wx/192), with an off-world guard for 0..255 (terrain_oracle.js:489-499).
- The vertex grid is 9×9 at 24 m spacing, column-major (vx*9+vy).
- Map coordinates: ew = wx/240 − 101.95 and ns = wy/240 − 101.95 (plugins/map-panel.js:83-90), formatted 'NS, EW' (:108). The retail cell-quantised version is radar.js:224.
- ACE `@tele [name] 37s,67w`:
  - NS comes first (CommandParameterHelpers.cs:227, 559-618);
  - it needs Advocate level ≥5 or above;
  - it refuses landblocks that are entirely water (AdvocateCommands.cs:155-200).
- `@teleloc <cellhex> x y z [qw qx qy qz]` uses landblock-local x,y,z and needs Developer access (AdminCommands.cs:911-956).
- three.js mapping:
  - worldRoot.rotation.x = −π/2 (index.js:1552-1555); its children (terrain, entities) are in AC coordinates.
  - Cameras and lights are outside worldRoot and use three-space coordinates.
  - `acToThree(ax, ay, az)` = [ax, az, −ay] (adapter.js:1817). The inverse is ac = (tx, −tz, ty) (far_terrain.js:1359-1374) or `worldRoot.worldToLocal` (cells.js:672).
  - `acQuatToThree(qw, qx, qy, qz)` returns Quaternion(qx, qy, qz, qw) for children of worldRoot (adapter.js:1395).
- Pose heading: yaw 0 = north (+Y), counter-clockwise, π/2 = west; compass = −yaw (d.ts:2337-2342).
- `getLocalPlayerPose()` returns landblock-LOCAL x,y and is a wasm box you must `.free()`.
- Terrain meshes are placed at (lbX·192, lbY·192, 0) in AC coordinates (terrain.js:6689).

Q6 HAZARDS: see hazards[]. The biggest:
- the player-centred world versus a free camera;
- fog that follows the camera with a band computed from the player-centred radius, which exposes the edge;
- terrainHeightAt and the oracle are blind to far landblocks;
- loadTerrainRing re-centres the player's fixed grid;
- objRadius hides prewarmed far objects;
- the guard skip-at-cap;
- baked marks set before attach;
- post-teleport stale centre;
- viewer cell rooted at the player;
- the service-worker cache.

## APIS
- SessionHandle.terrainHeightAt [pkg/holtburger_web.d.ts:6652]  sig=terrainHeightAt(world_x: number, world_y: number): number | undefined :: Exact retail triangle-plane ground Z at GLOBAL AC world (x east, y north). f32-bound (~2 mm quantisation). Reads the collision_scene shadow (≤100 ms refresh). undefined unless the LB was populateTerrain'd, which only happens for the 3×3 of player-visited LBs. Used by camera.js:2006 _terrainFloorZ (+0.5+0.2 m).
- SessionHandle.populateTerrain [pkg/holtburger_web.d.ts:5772]  sig=populateTerrain(landblock_id: number, heights: Float32Array /*81*/, terrain_codes: Uint8Array): void :: Feeds the wasm height/water grid used by terrainHeightAt and the integrator. Only caller is app/landblock_stream.js:722 ensureTerrainAroundLandblock (3×3 around each player LB). Film mode could call it for camera LBs, but it also affects physics/water-walk.
- fetch_landblock_heightmaps [pkg/holtburger_web.d.ts:9033]  sig=fetch_landblock_heightmaps(cell_ids: Uint32Array /* (lbKey|0xFFFF)>>>0 */, urgent?: boolean|null): Promise<LandblockMesh[]> :: Residency-independent heights/codes for ANY landblock, read from the dist shards. Access via window.liveScene3d.wasmExports. LandblockMesh: heights Float32Array(81) idx=vx*9+vy, terrainCodes, roadCodes, heightMin/Max, positions LB-local (d.ts:2064-2142). Must .free(). Whole batch rejects on any per-id failure. 6-9 ms/LB cold.
- createTerrainOracle [scene3d/terrain_oracle.js:289]  sig=createTerrainOracle({getTerrainMeshes?, parkRescanEveryHits?}) -> {noteLandblock(lbKey,{codes,heights,roads,lbX,lbY}), invalidate, clear, sample(x,y,out?), sampleCode, heightAt(x,y), familyCoverage, hasLandblock, stats, keys} :: Deterministic, THREE-free height/normal/terrain-code/road sampler in global AC metres. sample() (line 481) returns {height, normal{x,y,z}, code, family, cornerCodes SW/SE/NW/NE, cornerRoads, roadEdgeM, lbX, lbY, lbKey, hasHeight}; heightAt (line 659) returns number|null. ~486 B/LB. Matches wasm to 1e-5 with Math.fround inputs.
- cellSwToNeCut / triangleHeightInCell / triangleGradInCell [scene3d/terrain_oracle.js:83]  sig=cellSwToNeCut(globalCellX,globalCellY): boolean; triangleHeightInCell(z00,z10,z01,z11,fx,fy,swNeCut): number (:97); triangleGradInCell(...): [dz/dfx, dz/dfy] (:123) :: Pure retail split-diagonal math (uint32 wraparound via Math.imul). Global cell = lbByte*8 + cellIdx. Use for custom terrain-following, slope, and clearance over a camera footprint.
- window.__terrainVfx.oracle / ensureOracle [scene3d/terrain_vfx.js:624]  sig=window.__terrainVfx.ensureOracle(): Promise<oracle|null>; window.__terrainVfx.oracle (getter, :979) :: Live shared oracle fed at every near-ring terrain bake. Survives warm-park; drops a landblock on evict/rebake. Null for never-baked LBs. VFX spine is disabled under ?wireframe=1 / ?terrainVfx=off, but ensureOracle still backfills from terrainGroup userData.
- isWaterCode / familyForCode [scene3d/terrain_families.js:213]  sig=isWaterCode(code): boolean; familyForCode(code): FAM_* (:208); FAM_WATER=8 (:31) :: Water test on a terrain code. Default strict set is 16-20 (?strictWaterCodes reads ON when absent). Water surface = terrain height + swell (~0.25 m envelope).
- retailLandNormals [scene3d/far_terrain.js:330]  sig=retailLandNormals(heights: Float32Array(81), lbX, lbY): Float32Array(243) :: Retail CLandBlockStruct::calc_lighting per-vertex normals (AC Z-up) from heights alone.
- acToThree / acQuatToThree [scene3d/adapter.js:1817]  sig=acToThree(ax,ay,az): [ax, az, -ay]; acQuatToThree(qw,qx,qy,qz): THREE.Quaternion(qx,qy,qz,qw) (:1395) :: AC (Z-up, +Y north) → three world for objects OUTSIDE worldRoot (cameras, lights). Inverse: ac = (tx, -tz, ty), or worldRoot.worldToLocal(v).
- lbKeyFromXY / lbKeyOf / lbChebyshev / isNearPlayerLb [scene3d/landblock_lru.js:494]  sig=lbKeyFromXY(lbX,lbY)->u32; lbKeyOf(id)->id&0xFFFF0000>>>0 (:498); lbChebyshev(a,b) (:523); isNearPlayerLb(scene3d,lbKey,radius=1) (:550); exported at :2635 :: Canonical residency keys. isNearPlayerLb decides the urgent fetch lane (player 3×3 or the server-stamped LB).
- worldToCoords / coordsToWorld / lbToCoords / formatCoords [plugins/map-panel.js:83]  sig=worldToCoords(wx,wy)->{ew,ns}; coordsToWorld(ew,ns)->{wx,wy} (:88); lbToCoords(landblockId,x,y) (:93); formatCoords(ew,ns)->'42.1N, 33.6E' (:108) :: Map lat/lng: ew = wx/240 - 101.95, ns = wy/240 - 101.95 (E/N positive). Same convention as ACE @loc/@tele.
- mapCoordsForCell / outdoorCellId / formatRadarCoords [plugins/radar.js:224]  sig=mapCoordsForCell(cellId)->{ew,ns}|null; outdoorCellId(landblockId,x,y) (:213); formatRadarCoords(ew,ns) (:235) :: Retail cell-quantised coords (null indoors). outdoorCellId: cell = cx*8 + cy + 1 with 24 m cells.
- SessionHandle.getLocalPlayerPose [pkg/holtburger_web.d.ts:4408]  sig=getLocalPlayerPose(): LocalPlayerPose|undefined {landblockId, x, y (LB-local 0..192), z (abs), heading, isOnGround} :: Authoritative player pose. A wasm box: must .free(). x/y are LB-LOCAL. Heading: 0 = north, CCW, compass = -yaw (d.ts:2337-2342). World conversion pattern: cells.js:712 playerAcPosition, camera.js:1470-1482.
- SessionHandle.getRenderSet / getCurrentCellId / isCurrentCellIndoor [pkg/holtburger_web.d.ts:4541]  sig=getRenderSet(depth): Uint32Array (sorted cell ids); getCurrentCellId(): number (:4266); isCurrentCellIndoor(): boolean (:5011) :: Player-rooted BFS render set. Its LB keys are the 'seen' set that centres the whole streaming ring (cells.js:4421).
- SessionHandle.resolveViewerCell / setViewerCell [pkg/holtburger_web.d.ts:5983]  sig=resolveViewerCell(fx,fy,fz,tx,ty,tz,radius,start_cell): number; setViewerCell(cell) (:6395; 0 clears) :: Retail viewer cell: walks a segment from a start cell. cells.js:2849 calls it each frame from player head (+1.5 m) to camera eye with r = 0.3. Roots the render walks (indoor split, portal punch, sky) only, not streaming.
- SessionHandle.cameraSweepCollision [pkg/holtburger_web.d.ts:3496]  sig=cameraSweepCollision(fx,fy,fz,tx,ty,tz,radius,landblock_id): CollisionHit|undefined :: Sphere sweep against building AABBs for the given LB. Only has data for LBs whose collision was populated (player 3×3).
- populateBuildingAabbsForLandblock / populateStaticsAabbsForLandblock [pkg/holtburger_web.d.ts:10420]  sig=populateBuildingAabbsForLandblock(lb): Promise<number>; populateStaticsAabbsForLandblock(lb): Promise<number> (:10463) :: Free wasm exports that queue per-LB collision AABBs, applied on the next movement tick. Needed if film obstruction tests run far from the player. JS dedup lives in app/landblock_stream.js:584.
- SessionHandle.collisionResidencyDiag [pkg/holtburger_web.d.ts:3658]  sig=collisionResidencyDiag(): string (comma-packed; includes terrainHeightLbs) :: Readiness check for the wasm height/collision caches. Wrapped by __diag.collision.residency() (scene3d/diag/collision.js:195).
- liveScene3d.loadTerrainForLandblock [scene3d/index.js:4002]  sig=loadTerrainForLandblock(lbX, lbY, prefetchedMesh?): Promise<Mesh|null> (never rejects) :: Per-LB guarded terrain bake. Already-baked fast path unparks and touches. Non-urgent bakes are SKIPPED (resolve null) when 6 bakes are in flight. Bake path: terrain.js:5867 bakeTerrainForLandblock.
- liveScene3d._runTerrainRingBatch [scene3d/index.js:4211]  sig=_runTerrainRingBatch(cx, cy) :: Batched 3×3 terrain fetch and bake around (cx,cy) (terrain_ring.js:61). Does NOT touch the player's FixedSlotGrid, so it is safe for prewarming.
- liveScene3d.loadTerrainRing [scene3d/index.js:4132]  sig=loadTerrainRing(cx, cy) :: Player ring driver. Routes through FixedSlotGrid.update (fixed_grid.js:296). DO NOT call with a non-player centre (see hazards).
- liveScene3d.loadStaticsForLandblock / loadBuildingsForLandblock / loadEnvCellsForLandblock / loadSpawnsForLandblock [scene3d/index.js:4337]  sig=loadStaticsForLandblock(lbX,lbY) (:4337); loadBuildingsForLandblock(lbX,lbY) (:4286); loadEnvCellsForLandblock(landblockId) (:3907); loadSpawnsForLandblock(lbX,lbY) (:4412) :: Per-LB object/interior/synthetic-spawn loaders. Statics/buildings are guarded (cap 6, cooldown 2.5 s) and run afterObjectBake, which hides objects beyond objRadius+1. EnvCells are NOT behind the guard.
- liveScene3d.previewSpawnArea + cameraSwitcher.setPreviewTarget [scene3d/index.js:4234]  sig=previewSpawnArea({cell,x,y,z}) -> diag|null; cameraSwitcher.setPreviewTarget({x,y,z}|null) (camera.js:3286) :: Pre-spawn only (returns null once a player pose exists). Streams the ring around a point and frames it. The pattern to copy for a film prewarm.
- tickPvsLoadExpansion [scene3d/cells.js:4388]  sig=tickPvsLoadExpansion(scene3d, sessionHandle) :: The ring driver (~10 Hz, loop.js:2894). Centre = render-set LBs. Fires terrain/statics/buildings nearest-first. Publishes _pvsEffectiveRingRadius (:4658) and _pvsSweepIncomplete (:4828/:4855).
- LandblockLRU (window.__landblockLru) [scene3d/landblock_lru.js:591]  sig=isParked(k) (:857), unpark(k) (:2367), park(k) (:2138), touch(k) (:984), tickEviction(cur, sealed) (:1156), getStats() (:2568), maxResident (field) :: Residency set (cap 203). Warm-park pool 160 MB. Ring-protect around the PLAYER only. Reclaims oldest beyond the ring when over cap or when live geometry exceeds 8000.
- guardedStreamBake [scene3d/stream_bake_guard.js:168]  sig=guardedStreamBake(state, kind, lbKey, run, {urgent, maxInFlight=6, cooldownMs=2500}) :: Global bake gate. Skips (resolves null) when in flight, cooling down, or over the cap unless urgent. In-flight keys are `${kind}:${lbKey}` in liveScene3d._streamGuardState.inFlight.
- farTerrainState / window.__farTerrainState [scene3d/far_terrain.js:1600]  sig=window.__farTerrainState() -> {flags, fog, nearMeasuredRadiusLb, farRingSolidRadiusLb, ring:{patchesBaked, patchesFetching, patchesReady, fetchInFlight, policyOk,...}} :: Far-ring readiness probe plus the fog actually applied this frame.
- computeFogBand [scene3d/far_terrain_flags.js:283]  sig=computeFogBand({authoredMin, authoredMax, rEffLb, frac, floorM, floorMinLb, horizon, horizonNear}) -> {near, far, drawnEdgeM, mode} :: Pure fog-band math used in loop.js:2294. Film mode can reuse it with a camera-relative drawn edge.
- registerTerrainVfx [scene3d/terrain_vfx.js:231]  sig=registerTerrainVfx({id, scope:'landblock', enabled(), quality(), onLandblockReady(ctx), onLandblockPark(k), onLandblockUnpark(k,ctx), onLandblockGone(k)}) -> {id, unregister} :: Event-driven terrain residency notifications (attach/park/unpark/evict). ctx carries heights, codes and the oracle. Inert under wireframe.
- window.__cam (?camDebug=on) [scene3d/camera.js:1484]  sig=__cam.set(ex,ey,ez,tx,ty,tz) (AC world, parks camera); orbit(tx,ty,tz,dist,azDeg,elDeg); player(dist,az,el,dz); park(); release(); fov(v); info(); world() :: Existing AC-coordinate camera override (debug flag). set() uses up = (0,1,0) + lookAt, which degenerates when looking straight down.
- SessionHandle.sendChat (admin teleports) [pkg/holtburger_web.d.ts:6096]  sig=window.__sessionHandle.sendChat('@teleloc 0xXXYYCCCC x y z [qw qx qy qz]' | '@tele 37s,67w' | '@telepoi <name>') :: Moves the PLAYER, which re-centres every ring. ACE handlers: /home/wbterminal/ace-server/Source/ACE.Server/Command/Handlers/AdminCommands.cs:911 (teleloc, Developer), :875 (telepoi), AdvocateCommands.cs:156 (tele, NS first).
- ensureSpawnsForLandblock (synthetic spawns) [scene3d/spawns.js:521]  sig=ensureSpawnsForLandblock(lbX, lbY, scene3d, wasmExports); mode ?spawns=auto|force|off (:123) :: Replays pre-baked ACE spawn JSONL through the entity hook. auto = only when there is no session. force + live session = duplicated entities.

## SEAMS
- [scene3d/cells.js:4421] Streaming centre set `seen` (render-set LB keys) feeding ring radius, objRadius centres and nearest-first sort => Union in film-focus LB keys behind a default-OFF flag, so the ring, object bakes and the hide/show hysteresis also cover the shot area (lines 4421-4446, 4693-4705).
- [scene3d/landblock_lru.js:1150] LRU reclaim centre and ring protection (getCurrentLbId + _wantedRingRadius + candidate filter) => Exempt film-focus LBs from reclaim (like lbRingProtect) and touch them each tick, so prewarmed shot areas are not parked as 'oldest'. Centre resolver is at index.js:6596.
- [scene3d/far_terrain.js:1070] Far ring centre playerLb() => Optionally centre or union the far ring on the camera or focus LB for long drone flights (albedo only, cheap: ~2 KB/LB).
- [scene3d/loop.js:2294] Fog band computation (computeFogBand call in tickDistanceFogColor) => Compute drawnEdge relative to the CAMERA (distance from camera to the nearest unloaded edge in view), or pin with ?farFogNear/?farFogFar, so off-player shots never show the void edge.
- [scene3d/cells.js:2849] Viewer cell resolution (player head → camera eye) => In dungeons, track the film camera's own viewer cell incrementally along its path (resolveViewerCell(prevEye→eye, 0.3, prevViewerCell) then setViewerCell), so the portal render set follows the camera around right-angle corridors.
- [scene3d/index.js:4002] Per-LB prewarm loaders on the liveScene3d facade => Prewarm a shot corridor with loadTerrainForLandblock / _runTerrainRingBatch (:4211), loadStatics (:4337), loadBuildings (:4286), loadEnvCells (:3907). Re-fire until baked, because the guard skips at cap.
- [scene3d/index.js:4234] previewSpawnArea pre-spawn warm-up pattern => Template for a film 'stage area' API: 3×3 terrain + buildings + statics around a target plus a camera preview target (pre-spawn only today).
- [scene3d/terrain_vfx.js:231] Terrain residency lifecycle events => Register a 'film.residency' provider to learn when each LB's terrain is attached, parked or evicted, and to receive its heights. Drives readiness gating and the planner's height cache.
- [scene3d/terrain_oracle.js:289] Height oracle + residency-independent heightmap fetch => A private oracle fed by fetch_landblock_heightmaps for the planned flight corridor gives exact AGL altitude, terrain following and normal-based clearance before any LB is resident.
- [scene3d/index.js:3780] Runtime draw-distance knobs => liveScene3d.pvsRingRadius is read every tick (cells.js:4462). landblockLru.maxResident can be raised at runtime. Raise both for wide aerials (keep ≤7 because of terrain-batch 256 slots).
- [scene3d/cells.js:4828] Ring readiness flags => Gate 'action' on: _pvsSweepIncomplete===false, no guard in-flight keys, no parked focus LBs, __farTerrainState().ring.patchesFetching===0, __interiorBuildPending===false.
- [scene3d/world_stream.js:251] Player relocation drives every centre (world_stream onPositionUpdate) => Leapfrog-teleport the player or a camera character (@teleloc/@telepoi) between shots; wait for readiness after each hop and cut on teleports.
- [pkg/holtburger_web.d.ts:10420] Collision population for far obstruction tests => Before sweeping the film camera against buildings/statics away from the player, populate those LBs (populateBuildingAabbs/StaticsAabbs) and pass the camera's LB to cameraSweepCollision.
- [scene3d/spawns.js:148] Synthetic spawn injector => Offline or no-session previews can show NPC/creature placements anywhere (static, no AI). Avoid with a live session (duplicates).
- [scene3d/camera.js:1484] Camera debug override in AC coordinates => Prototype camera rails via window.__cam.set/orbit (?camDebug=on). Film mode needs a quaternion path, not up=(0,1,0)+lookAt, for straight-down tilts.

## HAZARDS
- [scene3d/cells.js:4421] All residency is player-centred: PVS ring, LRU, far ring, objRadius, LOD, terrain audit, entity reaper, ACE visibility. A camera >~1 km from the player sees bare albedo terrain (5–8 LB) and then nothing; at 2 km it is beyond the 1632 m far-ring edge. || mitig: Keep the player (or a camera character) within ~3–4 LB of every camera position, or add the film-focus seam at all six centre sites.
- [scene3d/loop.js:2294] Fog is measured from the CAMERA (plane depth), but its far distance is derived from the PLAYER-centred drawn-edge radius. An offset camera looking toward the near edge sees an unfogged hard terrain edge or void. || mitig: Compute a camera-relative fog band (reuse computeFogBand) or pin ?farFogNear/?farFogFar per shot. ?radialFog=on removes yaw-dependent fog.
- [pkg/holtburger_web.d.ts:6652] terrainHeightAt returns undefined beyond the player-visited 3×3 rings. Whether LRU eviction purges the wasm height grid was not verified. The shared oracle returns null for never-baked LBs. || mitig: Use a private createTerrainOracle fed by fetch_landblock_heightmaps for the whole flight corridor. Treat null as 'unknown' and fail closed (hold altitude).
- [scene3d/terrain_oracle.js:640] Oracle vs wasm parity requires f32-quantised inputs; raw f64 coordinates diverge by up to ~2 mm. || mitig: Math.fround(x/y) for parity checks. Use ≥0.5 m clearance margin anyway (8 cm fillet + ≤0.4 m water swell).
- [pkg/holtburger_web.d.ts:9033] fetch_landblock_heightmaps rejects the WHOLE batch if any id fails, and returns wasm objects that leak unless freed. || mitig: Batch ≤16 (far_terrain uses 16) with a per-LB retry on rejection. Always m.free() after copying heights/codes.
- [scene3d/fixed_grid.js:296] liveScene3d.loadTerrainRing(cx,cy) with a non-player centre moves the player's FixedSlotGrid. A 1–2 LB offset is a SHIFT whose vacated player-side LBs are whole-LB PARKED after 2 s (EdgeParkScheduler). With ?loadPointShiftOnly the grid stays wrong until the player crosses an LB. || mitig: Prewarm with _runTerrainRingBatch(cx,cy) or per-LB loadTerrainForLandblock, never loadTerrainRing (index.js:4132).
- [scene3d/object_radius.js:181] objRadius (default 4) hides statics/buildings of any LB more than 5 LB from the player, including on arrival of a prewarm bake (afterObjectBake), and never bakes objects for d>4 in the ring. || mitig: ?objRadius=off for film sessions, or add the focus to the objRadius centres.
- [scene3d/landblock_lru.js:1394] LRU reclaims the OLDEST LBs beyond the player ring when resident >203 or live geometry >8000 (MAX_LIVE_GEOM). Prewarmed off-ring LBs are never touched, so they are the first victims. The geometry governor has collapsed resident LBs 200→35 on long tours. || mitig: Film-focus reclaim exemption plus touch, raise maxResident, ?maxLiveGeom tuned for the 1070, and re-check isParked before each take.
- [scene3d/stream_bake_guard.js:216] Stream guard skips (resolves null, no queue) non-urgent bakes when 6 are in flight, and after a failure applies a 2.5 s cooldown. One loader call is not a guarantee. || mitig: Poll-and-refire until baked marks are present and the guard key `${kind}:${lbKey}` is not in _streamGuardState.inFlight.
- [scene3d/terrain.js:5955] Half-baked LBs: terrainBakedLbs is marked BEFORE the mesh attaches (await prewarmSubtree in between). Terrain, statics/scenery, buildings, EnvCells and lights each land separately. Texture tier promotion (t1024) arrives later. || mitig: Readiness = baked marks + not in flight + not parked + _pvsSweepIncomplete===false + settle seconds. Force ?bandwidth=high and wait for texture promotion before recording.
- [scene3d/fixed_grid.js:504] EdgeParkScheduler parks the trailing edge of the radius-1 terrain grid 2 s after a player crossing (inside the radius-5 draw ring); the 1 Hz terrain audit / PVS re-sweep then unparks it. This can flicker behind a moving player. || mitig: Do not move the player during takes, or run film sessions with ?fixedGridPark=off (A/B first).
- [scene3d/far_terrain.js:1268] Far ring pops in 4×4-LB (768 m) patches only after all 16 LBs bake. It fetches only when the near ring is idle (10 s starvation escape) and retires at d > R+4 from the player. || mitig: Wait for farRingSolidRadiusLb ≥ farRadius via __farTerrainState() before wide shots. Raise ?farRadius for longer aerials.
- [scene3d/landblock_lru.js:443] Post-teleport stale centre: the rig-derived LB lags the teleport (measured 17.5 s first hop under saturation; the documented pose.landblockId freeze). The reclaim gate holds up to 10 s. A teleport also flushes queued spawns of the departed area. || mitig: After any @teleloc, gate on terrainBakedLbs containing the destination 3×3 plus the ring-ready flags, not on pose.landblockId.
- [scene3d/cells.js:2849] Viewer cell is resolved by walking from the PLAYER's head to the camera eye. A film camera in a dungeon corridor far from or around a corner from the player gets a wrong viewer cell and render set (missing cells or wrong indoor split). || mitig: Film-camera-owned incremental viewer-cell tracking (resolveViewerCell from the previous eye/cell), then setViewerCell.
- [scene3d/cells.js:914] Dungeons: EnvCells load only for the player's LB plus a radius-1 skirt (1 start/tick, 2 in flight, 3 attempts). Sealed-dungeon purge evicts every outdoor LB. dungeonStreamGate holds outdoor streaming while indoors. Large interiors (Academy, 568 cells) take seconds. || mitig: Put the player inside the target dungeon LB, wait for envCellLoadedLbs.has(lb) and __interiorBuildPending===false, and avoid exterior shots while the player is indoors.
- [scene3d/cells.js:4510] ?fogRingCap (default ON) shrinks the bake ring to ceil(authoredFogMax/192)+1 (≈4 LB at night, less in fog weather). Night or foggy aerials see less. || mitig: ?fogRingCap=off for film sessions that light or grade night scenes.
- [/home/wbterminal/WorldBuilder-ACME-Edition/external/ACE/Source/ACE.Server/Physics/Common/ObjectMaint.cs:420] ACE sends creatures/NPCs only for the player's 3×3 LBs, with a 112.5 m first-sight clamp; they are destroyed 25 s after leaving visibility. The client reaper keep-zone is 8 LB. || mitig: Stage creature shots within ~100 m of the player character. Do not expect populated far vistas.
- [service-worker.js:459] Service worker v2 caches content-addressed shards/packs cache-first, boot.hba and manifest/*.bin behind a bake gate, and /scene3d/assets/ as stale-while-revalidate. Stale art can appear for one load after an asset change. || mitig: ?nosw=1 on every dev/film URL (index.html:2349 unregisters and clears caches, then reloads once).
- [scene3d/bake_worker_client.js:33] Bake worker (default ON) holds its own wasm instance and resource source, with a transparent main-thread fallback. It is stale after a wasm rebuild until reload. Fetch concurrency is split 8 worker / 24 main. || mitig: Full reload after any rebuild. Check the console for 'main-thread fallback' before perf measurements.
- [scene3d/index.js:3771] Dual facade: liveScene3d vs scene3dForBuilders are different objects. Some fields are copied once at init (snapshot); playerLbKey is mirrored on both by the LOD reconcile. || mitig: Read from window.liveScene3d (index.js:4420) and null-guard. Never cache a field reference before the first bake.
- [scene3d/cells.js:4428] Signed int32 keys: (id & 0xFFFF0000) is negative for x bytes ≥ 0x80 and silently misses Set lookups. || mitig: Always >>> 0 (use lbKeyOf / lbKeyFromXY).
- [scene3d/cells.js:712] getLocalPlayerPose returns LB-LOCAL x/y and a wasm box. Passing raw x/y to terrainHeightAt samples near the world origin, and not freeing it leaks every frame. || mitig: Convert lbX*192+x, lbY*192+y and free() in finally (the playerAcPosition pattern).
- [scene3d/camera.js:1495] camera.lookAt with up=(0,1,0) is degenerate for straight-down tilts (__cam.set), which causes gimbal flips at 90° pitch. || mitig: Drive the film camera with quaternions (slerp / parallel-transport frames), not lookAt + a fixed up vector.
- [scene3d/statics.js:288] Statics with degrade chains swap to their degraded mesh at 100 m CAMERA distance (LOD_DISTANCE_M). Drone shots show degraded props; a fast dolly crossing 100 m pops them. || mitig: Accept it, or evaluate ?retailDegrade=on bands. Avoid dollies that hover at the 100 m threshold.
- [scene3d/residency.js:131] ?agentic=low forces pvsRingRadius=1 and shrinks the LRU cap. ?wireframe=1 / SwiftShader disables the terrain VFX spine and lies about all far-ring GPU behaviour. || mitig: Film runs must use real-GPU (1070) URLs without agentic=low or wireframe.
- [docs/url-flags.md:549] Doc drift: url-flags.md cites the eagerDungeons reader at index.js:1784; it is actually at index.js:2172. d.ts fetch_subdivided_landblock still says 'Catmull-Rom + noise', but terrain.js:7162 says the subdivided mesh is the faceted collision surface. || mitig: Trust code over docs. Terrain shape is identical at every LOD level.

## DATA
- {'name': 'Served dist (SSD copy)', 'location': '/home/wbterminal/hb-serve/dist/current -> holtburger-dist-hires-bc7m-xu7t2 (served at ../../dist/ relative to apps/holtburger-web via external/holtburger/scripts/serve.py)', 'format': 'manifest.json v2 + boot.hba + shards/{prefix2}/{sha256}.bin + manifest/*.bin catalogs + index/ + packs/', 'notes': 'Namespaces eor/cell (terrain CellLandblock XXYYFFFF, LandblockInfo XXYYFFFE, EnvCells), eor/portal, eor/local, holtburger/tex-*. Read-only inspection of manifest.json only.'}
- {'name': 'Procedural scenery bake', 'location': 'dist/scenery/0xXXXX.scenery.jsonl (+ .materials.json, .sha256); ?sceneryBake=retail -> dist/scenery-retail (symlink to /mnt/wbterminal2/hb-scenery-ab-2026-10-13/retail-full-v2)', 'format': 'JSONL per LB (195k files incl. sidecars)', 'notes': 'Loaded by fetch_landblock_scenery inside statics bakes (statics.js:700-714). World-wide.'}
- {'name': 'Synthetic ACE spawns', 'location': 'dist/spawns/0xXXXX.spawns.jsonl (~38k LBs; 76,309 files incl. .sha256) + dist/spawns/wcid_to_setup.json', 'format': 'JSONL + JSON map', 'notes': 'Injected only with no session or with ?spawns=force (duplicates with a live wire).'}
- {'name': 'Heightmaps for arbitrary landblocks', 'location': 'wasm fetch_landblock_heightmaps / fetch_landblock_heightmap (pkg/holtburger_web.d.ts:9011-9033)', 'format': 'LandblockMesh: heights Float32Array(81, idx=vx*9+vy), terrainCodes/roadCodes Uint8Array(81), positions LB-local', 'notes': "Residency-independent. The far ring's own fetch path (far_terrain.js:1383)."}
- {'name': 'Live ACE server (server-streamed content)', 'location': 'vanilla ACE on the laptop (memory: $ACERT); visibility rules in external/ACE/Source/ACE.Server/Physics/Common/ObjectMaint.cs', 'format': 'wire KIND_SPAWN / KIND_POSITION', 'notes': "Creatures, NPCs, players and items within the player's 3×3 LB. 112.5 m initial clamp, 25 s destruction delay."}
- {'name': 'Runtime probes', 'location': 'window.liveScene3d, window.__landblockLru, window.__farTerrainState(), window.__terrainBatch.stats(), window.__terrainVfx, window.__fixedGrid, window.__diag.bakeWait(), window.__groundDrawnAt, window.__interiorBuildPending, liveScene3d.__farFogApplied, liveScene3d._terrainAuditStats', 'format': 'JS objects (CDP Runtime.evaluate)', 'notes': 'All verified as installed by the cited code; none were exercised live in this pass (read-only).'}

## RECS
- Treat the PLAYER as the streaming dolly. Prefer design A for v1: teleport a dedicated camera/GM character (@teleloc/@telepoi via __sessionHandle.sendChat) to stay within ~3–4 LB of every camera position, and cut on teleports. Add design B (a default-OFF ?filmFocus seam) only if continuous long aerials are required.
- Design B, if built, must patch all six player-centre sites together: cells.js:4421-4446 (seen/objRadius), landblock_lru.js:1150-1394 (reclaim exemption + touch), far_terrain.js:1070 (far centre), terrain.js:5587 (LOD reference, cosmetic only), loop.js:2294 (camera-relative fog edge), and cells.js:2849 (viewer cell for dungeons).
- Planner heights: create a private createTerrainOracle() and feed it fetch_landblock_heightmaps for the LB corridor of every planned move (batches ≤16, per-LB retry, free() meshes). AGL = cameraZ − max(oracle height over a ~2–5 m footprint). Clearance ≥0.5 m plus water swell. Use sample().normal for slope-aware terrain following.
- Never use loadTerrainRing for prewarm. Use _runTerrainRingBatch(cx,cy) plus loadStatics/loadBuildings per LB, and loop until baked (the guard skips at cap 6).
- Readiness gate before rolling: (1) focus LBs: terrain mesh attached and !isParked, statics/buildings baked, no `${kind}:${lbKey}` in _streamGuardState.inFlight; (2) liveScene3d._pvsSweepIncomplete === false; (3) __farTerrainState().ring.patchesFetching+patchesReady === 0 and farRingSolidRadiusLb ≥ farRadius; (4) __interiorBuildPending === false and envCellLoadedLbs.has(lb) for dungeons; (5) texture promotion settled; (6) ≥3–5 s settle with no new console '[terrain-audit] holes'.
- Film URL preset (1070, real GPU): ?nosw=1&bandwidth=high&objRadius=off&fogRingCap=off&farRadius=12&radialFog=on, plus optionally pvsRingRadius=6–7 with a matching lbCap. Never agentic=low or wireframe. A/B fixedGridPark=off for in-take player movement.
- Dungeon shots: the player must be inside the dungeon LB. The film camera owns an incremental viewer cell (resolveViewerCell from previous eye and cell, then setViewerCell) so right-angle corridor moves keep the correct portal render set.
- Creature/NPC shots: keep the subject within ~100 m of the player character (ACE 112.5 m first-sight clamp, 3×3 LB visibility). Far vistas will have no creatures.
- Coordinates for the agent and JEV: plan in GLOBAL AC metres (wx=lbX*192+x, wy=lbY*192+y, z absolute). Convert map lat/lng with coordsToWorld (map-panel.js:88). Convert to three only at the camera with acToThree. Keep lbKeys unsigned (>>>0).
- Camera orientation: build film camera frames from quaternions and parallel transport, not lookAt with up=(0,1,0), to survive straight-down tilts and 90° corridor turns.

## OPENQ
- Does enqueueClearLandblockCollision (fired on LRU evict) also drop the wasm terrain-height grid used by terrainHeightAt? terrainPrefetchedLbs is never cleared, so a revisit may not re-populate it. Not verified.
- Which character is the 'streaming dolly' for film: the user's own character teleported around, or a dedicated GM/observer character? This affects whether @tele (Advocate ≥5) or @teleloc (Developer) access is available on the target ACE.
- Does getRenderSet(1) stay player-rooted after setViewerCell(non-zero)? The d.ts says yes (getViewerRenderSet is separate), but the wasm behaviour was not checked.
- terrain.js:5618 says the rounding floor roundMinLevel defaults to 2, but terrain_round.js:106 shows minLevel: 1. The effective far-LB subdivision factor is unresolved (cosmetic only, because shape is identical).
- On the 1070 box, is the dist served locally (~/hb-serve/dist/current equivalent) or over the tailnet? Cold far-ring and heightmap fetch latency (6–9 ms/LB measured on the 1070) depends on it.
- Is ACE @tele placement z (Position.AdjustMapCoords) terrain-snapped or fixed? Not read.
