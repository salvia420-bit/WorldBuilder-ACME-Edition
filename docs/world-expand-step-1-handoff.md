# World-expand step 1 — Handoff Brief

> Use this prompt to brief the next agent picking up open-world
> expansion work. Step 1 of the world-expand line is **20× the
> rendered landblock footprint around Holtburg from a 3×3 ring to a
> 13×13 ring (169 LBs)** by refactoring the `init3D` static bakers
> into per-LB bakers + hooking them through `handlePositionUpdate`'s
> lazy LB-entry path. This is the smallest contained step toward
> eventual whole-Dereth open-world rendering — same shape as Phase 6's
> "Open-world LB-entry render landed 2026-05-09 (357e8ed + 5587fa0)"
> but extending the lazy contract from EnvCells / collision /
> wasm-side heightmaps to the **3D terrain meshes, building Groups,
> and static Meshes** that today are static-baked at init.
>
> Structure: **Context → Intent → Objectives → Why → Specs.** Read
> in order. Don't start coding before you've finished §Why. The
> "Decisions to NOT re-litigate" section in §Specs lists user-
> approved forks from the planning session that produced this brief
> (2026-05-13) — do not reopen them without explicit ask.

---

## Context

The 3D renderer (`?renderer=3d`) currently bakes a fixed 3×3 ring
around Holtburg (LB `0xA9B4`, `lbX=169 lbY=180`) at `init3D` time and
relies on a lazy LB-entry pipeline for the 2D-side wasm-cached
heightmap + collision AABBs + EnvCell interiors. **The 3D mesh layers
themselves are static** — a player who walks beyond the 3×3 ring
sees void terrain and missing buildings in 3D mode (the wasm-side
data does prefetch correctly, so movement / collision still work).

Phase 6's lazy LB-entry path (commit `357e8ed`, 2026-05-09) closed
the wasm-side gap. This step closes the **3D-side** gap: it
generalizes the per-LB lazy pattern (already proven in `cells.js`
for EnvCells) to terrain meshes, buildings, and statics, then flips
the initial spawn ring to 13×13.

The user-approved scale target is **13×13 = 169 LBs** (≈ 2.5 km × 2.5
km, ~19× more LBs than today's 3×3, ~3.2× more static objects per
WorldBuilder.Terminal oracle: 766 statics, 46 structures across the
full ring versus 239 statics in today's 3×3). Most of the ring is
sparse Aluvian Heartlands countryside — only 51 of 169 LBs are
populated; 118 are empty wilderness. South Holtburg Outpost
(`0xA9B0`) and 42 other LBs carry POIs (Lumberjack's Camp, Standing
Stones, Eternal Flame, etc.). All 169 LBs have terrain (no ocean
gaps in this region).

### Where the project is right now (as of `89b3986`, 2026-05-13)

| Phase | What landed | Commit(s) |
|---|---|---|
| Phase 6 | Open-world LB-entry render — buildings/interiors/Z-culling/door rotation | `dc49b6f`..`e5bf8a8`, `357e8ed`, `5587fa0` |
| 3D camera + game-feel push | WASD + mouse-look + integrator hardening (Workstreams A–G) | `2aa39d4`..`87aef38` |
| Skybox push (Sky-A..H) | Region-driven sky + celestial bodies | `ed4d227`..`7859bf0` |
| Sky particles push (Sky-J P1-P5) | ParticleEmitter / PhysicsScript / Wave / AudioManager parsers + runtime | `b499411`..`5618579` |
| Ambient sounds (Tasks A-F) | SoundTable + AmbientRuntime + AnimationHook sounds + GameMessageSound | `fde41e8`..(landed 2026-05-12) |
| Academy population characterized | 23 NPC nameplates + 104 EnvCell ACE-PVS coverage measured | (landed 2026-05-13) |
| Visual-fidelity push wave-1 | X.1 quality presets + 0.1 shadows + 1.4 surface classifier | (3 parallel agents, 2026-05-13) |
| Visual-fidelity push wave-2 | 0.2 Detail flag + 1.1 procedural normals + 1.5 overrides + X.2 regression infra | (4 parallel agents) |
| Visual-fidelity push wave-3 | 1.2 terrain detail normal + 3.2 SSAO + 3.3 CSM | (3 parallel agents) |
| Visual-fidelity push wave-4 | 1.3 triplanar + 3.1 POM | (2 parallel agents) |
| Visual-fidelity push wave-5 | 2.1 terrain mesh subdivision | (1 agent) |
| Visual-fidelity push wave-6 | 2.2 animated water/lava vertex displacement | `cb97dc4`, `ede4122` |
| PK hand-off (12 of 14 visual-fidelity phases) | Eye-test + perf + Phase 2.3 hero PBR | `76f0448` |
| Tree-sway / wind scoping investigation | (docs only) | `89b3986` |
| **World-expand step 1 — 3×3 → 13×13 lazy 3D pipeline** | **▶ this brief** | — |

**Working tree:** clean. **Branch:** `master`, pushed to
`origin/master`. **Native invariant:** `cargo test --workspace` is
**1352/0/1** (per `docs/visual-fidelity-handoff-pk-2026-05-13.md`)
and is the merge gate at every commit boundary. **Smoke test:**
`apps/holtburger-web/smoke_test.cjs` is the per-feature web-side gate;
add per-objective deltas. **Capture scripts** under
`apps/holtburger-web/capture_*.cjs` are the eye-test gate — assert
counts against the WorldBuilder.Terminal oracle inventory captured
2026-05-13 at `/mnt/wbterminal1/tmp/claude-scratch/world-expand/`.

### What's already in place

- **EnvCell lazy loader** at
  `external/holtburger/apps/holtburger-web/scene3d/cells.js:77`
  (`buildEnvCellsForLandblock(scene3d, landblockId, wasmExports)`).
  Idempotent via `scene3d.envCellLoadedLbs: Set<u32>`. **This is the
  canonical pattern step 1 mirrors for terrain / buildings / statics.**
- **handlePositionUpdate lazy hooks (wasm-side)** at
  `external/holtburger/apps/holtburger-web/index.html:4122`. Already
  fires `ensureTerrainAroundLandblock` (3×3 wasm heightmap +
  `populateTerrain`), `ensureBuildingAabbsAroundLandblock` (3×3
  collision AABBs), `ensureCellContainersForLandblock` (1-LB
  EnvCells for the 2D PIXI path), and `liveScene3d.loadEnvCellsForLandblock`
  (1-LB EnvCells for the 3D path). Workstream G (2026-05-11)
  unblocked the local-player branch so these fire in 3D mode
  regardless of `liveScene` being null.
- **WorldBuilder.Terminal at
  `WorldBuilder.Terminal/bin/Release/net8.0/WorldBuilder.Terminal.dll`**
  with `RetailSmoke.wbproj` (`/home/wbterminal/projects/RetailSmoke/`)
  preloaded with ontology cache, building pairings, gazetteers. JSON
  stdin protocol per `~/.claude/skills/worldbuilder-terminal/skill.md`.
- **Data oracle for the 13×13 ring** captured 2026-05-13 at
  `/mnt/wbterminal1/tmp/claude-scratch/world-expand/`:
  - `ring_13x13_inventory.jsonl` — `get-bulk-heightmap` +
    169× `list-objects` + 169× `describe-landblock`
  - `heightmaps_13x13.json` — extracted bulk-heightmap (141.9 KB,
    169 LBs × 9×9 = 13,689 verts; height range 28..134 m)
- **Manifest + shards delivery** at
  `/mnt/wbterminal1/holtburger-dist-v2/` (4.3 GB, full Dereth shard
  set). Boot pack covers Holtburg's 3×3 transitive closure; anything
  else fetches lazily from `dist/shards/{prefix2}/{trunc32}.bin` —
  the path works (verified at Phase 6 landing).
- **Wasm fetch helpers** that already return DAT-backed per-LB data:
  `fetch_landblock_heightmaps(cellIds: Uint32Array) -> LandblockMesh[]`,
  `fetch_landblock_objects(cellIds) -> ObjectPlacement[]`,
  `fetchBuildingPlacement(modelId) -> BuildingPlacement`,
  `fetch_subdivided_landblock(cellId, level) -> SubdividedMesh`,
  `fetch_surfaces_pixels(dids) -> ...`,
  `fetchEnvCellsInLandblock(lbKey) -> EnvCellPlacement[]`.
  No new wasm exports are needed for step 1 — the per-LB bake is
  pure JS refactor against existing APIs.

### What's NOT in place — and what step 1 fixes

- **3D terrain bake is fixed at 3×3** in
  `external/holtburger/apps/holtburger-web/scene3d/terrain.js:542`
  via `holtburgNeighbourhoodCellIds()`. Hardcoded `HOLTBURG_X=0xa9
  / HOLTBURG_Y=0xb4` constants at `terrain.js:33-34`. Subdivision LOD
  rule is "centre LB = full level, outer 8 = half" — degrades at
  larger N.
- **3D buildings bake is fixed at 3×3** in
  `scene3d/buildings.js:322`. Same hardcoded constants.
- **3D statics bake is fixed at 3×3** in
  `scene3d/statics.js:86`. Same hardcoded constants.
- **No per-LB hook on `liveScene3d`** for terrain / buildings /
  statics — only `loadEnvCellsForLandblock` exists today (see
  `scene3d/index.js:890`).
- **No lazy 3D mesh load in `handlePositionUpdate`** — the index.html
  side only calls `loadEnvCellsForLandblock` for the 3D path.
- **Fog far defaults to 800 m** (`scene3d/sky_lighting.js:91:
  DEFAULT_FOG_MAX = 800.0`); the wasm SkyState `fogMax` clamps the
  per-tick `fog.far` to whatever the per-DayGroup `max_world_fog`
  Region 0x13 lerp says. With a 13×13 ring the corner-to-centre
  diagonal is ~1.77 km — 800 m fog blinds it.
- **Initial spawn radius is implicitly `1`** (the 3×3 means radius=1
  from centre LB). Step 1 introduces an explicit radius parameter and
  flips it to `6` (= 13×13 ring).
- **No capture script asserting renderer ↔ oracle parity** for any
  ring size. Step 1 adds one.

---

## Intent

You are turning the 3D scene's static-baked Holtburg view into a
**lazy-streamed 13×13 ring driven by player position**. Same data
contract (DAT via wasm `fetch_*` helpers) but loaded per-LB as the
player walks, and bigger at spawn.

What "done" looks like at the end of this step:

1. Open `?renderer=3d&quality=high` in a browser pointed at the local
   stack. After init resolves, the camera looks down at Holtburg and
   `liveScene3d.terrainGroup.children.length === 169`,
   `liveScene3d.buildingsGroup.children.length` matches the oracle's
   ring-wide structure count (46), `liveScene3d.staticsGroup.children`
   roughly equals the oracle's non-building object total (766 −
   46 = 720 statics, give or take 1.4 % discrepancy worked through
   in Objective 1).
2. Fog reaches ≥2500 m so the player at Holtburg centre can SEE the
   ring's outer LBs at ground level.
3. WASD walk east 10 LBs (~1.9 km). Every LB crossed triggers a
   per-LB bake call that lands within a few rAF ticks; no void
   tiles, no missing buildings.
4. Walk back to Holtburg. Already-baked LBs are **not** re-baked
   (idempotent `Set<lbKey>` gates).
5. EnvCells already lazy-load — verify South Holtburg Outpost
   (`0xA9B0`) interiors paint when entered.
6. `node capture_world_expand_e2e.cjs` asserts the rendered scene's
   per-layer counts equal the WorldBuilder.Terminal oracle's counts,
   per-LB. Cross-check passes.
7. Smoke test grows by **+N checks** (per-objective deltas below):
   - Per-LB-baker symbol presence for `bakeTerrainForLandblock` /
     `bakeBuildingsForLandblock` / `bakeStaticsForLandblock`.
   - Idempotency: running each twice for the same LB returns the
     same object reference (no duplicate mesh).
   - Lazy hook fires: simulated `handlePositionUpdate` for a new LB
     triggers the three bakers exactly once.
8. New screenshot at
   `docs/images/world-expand-step-1-13x13.png` showing the 13×13
   ring under `quality=high` from a hilltop oblique angle.

What this step deliberately does NOT do:

- **No bake of Training Academy (LB `0x8602`)** — explicit user
  constraint. Its init path stays identical.
- **No texture-atlas LRU eviction.** 169 ring fits comfortably in
  WebGL2 buffer limits per the oracle counts. Eviction is a
  whole-world concern (Dereth = 65,536 LBs); step 1 punts it.
- **No region-streaming.** A single 13×13 ring around Holtburg, not
  Dereth-wide. Step 2 (out of scope here) generalises radius +
  centre-from-player-LB.
- **No frustum/distance culling beyond three.js defaults.** Frustum
  cull already runs per-object; with 169 + 46 + 766 children that's
  ~981 cull tests per frame which is fine.
- **No instancing refactor for buildings.** The per-placement Group
  contract (door rotation hinge) is preserved; 46 buildings ×
  per-Group overhead is well below today's 16-building cost.
- **No `?renderer=2d` parity.** The 2D PIXI path's
  `outdoorContainer` will still only paint the 3×3 ring (no behavior
  change for 2D mode).
- **No bake of LBs flagged as ocean-only in the oracle.** All 169
  ring LBs returned `found: true` for terrain so the question is
  moot in this region; the per-LB baker still guards `found:false`
  for any future caller.
- **No re-litigation of the planning forks.** The user picked
  13×13 + lazy-3D + fog-extend-to-cover-ring on 2026-05-13; section
  "Decisions to NOT re-litigate" in §Specs locks those in.

This is the smallest possible world-expand step 1 vertical slice:
**proves the lazy per-LB bake pattern generalizes to the 3D
terrain/buildings/statics layers, the data oracle (WorldBuilder.Terminal
`list-objects` + `get-bulk-heightmap`) anchors validation, and the
13×13 ring renders identically to retail**. The existing visual-fidelity
phases (shadows, normals, terrain detail, subdivision, SSAO, CSM, POM,
water displacement) stay live — they're per-LB primitives that work
identically at radius=6.

---

## Objectives

In rough dependency order. Each objective ships its own commit; do
not batch.

1. **Audit `scene3d/cells.js`'s per-LB pattern + the wasm-side oracle
   parity for one non-Holtburg LB.** Read
   `buildEnvCellsForLandblock` (cells.js:77-) end-to-end. Note: the
   shape of the idempotency check (`envCellLoadedLbs.has(lbKey)`),
   the "drain wasm into JS-owned snapshots before instantiation"
   pattern, the `materialCache.preload` step, the per-cell Group
   construction. Then run a parity check: pick `0xA9B0` (South
   Holtburg Outpost — has real content), run
   `list-objects lbX=169 lbY=176` through WorldBuilder.Terminal,
   then run `wasm.fetch_landblock_objects(new Uint32Array([0xA9B0_FFFE]))`
   in a Node-side smoke harness. The two object lists must match
   (same model_ids, same coordinates within 0.01 m, same isBuilding
   flag). Document the comparison in a new file
   `docs/world-expand-oracle-parity-2026-05-13.md`.

   **Verification:** parity doc lands; mismatches enumerated (zero
   is ideal). If any non-zero mismatches surface, step 1 stops here
   and a follow-on PR fixes the wasm reader first — do not paper
   over data discrepancies.

2. **Refactor `buildHoltburgTerrain` into per-LB baker + thin
   driver.** Split `scene3d/terrain.js:712` `buildHoltburgTerrain`
   into:

   - `bakeTerrainForLandblock(scene3d, lbX, lbY, opts, wasmExports)`
     — bakes one LB's terrain mesh (heightfield + per-LB
     vertex-types texture + road overlay + Phase 2.1 subdivision +
     Phase 2.2 displacement). Idempotent via
     `scene3d.terrainBakedLbs: Set<u32>` keyed by
     `(lbX << 24) | (lbY << 16)`. Returns the added `THREE.Mesh`.
   - `bakeTerrainRing(scene3d, centreLbX, centreLbY, radius,
     wasmExports)` — thin driver that loops `(dx, dy)` in
     `[-radius, +radius]² ∩ [0, 255]²`, calls
     `bakeTerrainForLandblock` for each, returns the
     existing-shape summary `{ atlasTexture, roadTexture, lbCount,
     atlasCanvas, roadCanvas }`.
   - `buildHoltburgTerrain` (existing entry point) becomes a one-line
     wrapper calling `bakeTerrainRing(scene3d, 0xa9, 0xb4, 1,
     wasmExports)` — preserves the radius=1 behavior for any caller
     that still relies on it (smoke tests, the Phase 7.1 capture).

   `opts` passes through the existing per-LB knobs that
   `buildHoltburgTerrain` resolves once (detailNormalArrayTex,
   subdivLevel resolution, displacementEnabled, etc.). The driver
   resolves them once and threads `opts` into each per-LB call so
   shader uniforms / textures aren't rebuilt 169 times.

   Subdivision LOD is **not** changed in this objective — every LB
   in the ring gets the centre level. Distance-keyed LOD is
   Objective 6.

   **Verification:** `cargo test --workspace --lib` ≥1352/0/1.
   `wasm-pack build --target {nodejs,web}` clean.
   `test_phase7_1_terrain.mjs` (if it exists; otherwise the latest
   terrain regression test) still passes. Smoke test gains 1 check:
   `bakeTerrainForLandblock` symbol present.

3. **Refactor `buildHoltburgBuildings` into per-LB baker + thin
   driver.** Same shape as Objective 2 but for
   `scene3d/buildings.js:299`. Split into
   `bakeBuildingsForLandblock(scene3d, lbX, lbY, opts, wasmExports)`
   + `bakeBuildingsRing(scene3d, centreLbX, centreLbY, radius,
   wasmExports)` + a one-line `buildHoltburgBuildings` wrapper.
   Idempotency set: `scene3d.buildingsBakedLbs: Set<u32>`.

   Per-LB baker:
   - Calls `wasmExports.fetch_landblock_objects(new
     Uint32Array([cellId]))` for the single LB.
   - Filters `p.isBuilding === true`.
   - Calls `wasmExports.fetchBuildingPlacement(modelId)` for each
     unique building model in this LB (LB-local cache; the
     fused per-Setup-model bake from the prior code stays
     valid).
   - Returns the per-LB summary (placementCount, modelCount,
     surfaceCount).

   The Phase 6 step B `building_aabb_index` population already runs
   lazy in wasm via `populateBuildingAabbsForLandblock` — keep it
   wired (collision-side, not visual-side).

   **Verification:** Same as Objective 2. Smoke +1 check.

4. **Refactor `buildHoltburgStatics` into per-LB baker + thin
   driver.** Same shape as Objectives 2-3 but for
   `scene3d/statics.js:68`. Split into
   `bakeStaticsForLandblock(...)` + `bakeStaticsRing(...)` +
   wrapper. Idempotency set:
   `scene3d.staticsBakedLbs: Set<u32>`.

   The F#5+6 InstancedMesh / LOD logic must continue to work
   **across the ring** — i.e., 222 statics in 9 LBs today collapses
   from 222 draw calls to ~66 (one per unique modelId). At 169 LBs
   ≈ 766 statics, the unique-modelId set roughly doubles to ~130
   (rough estimate; oracle will tell us); InstancedMesh should
   still collapse them. **Key decision:** instance group keyed by
   modelId across the full ring (not per-LB). That means the per-LB
   baker COLLECTS placements + uniqueModelIds; the driver
   instantiates the InstancedMesh / LOD once at ring-bake completion.
   Per-LB baker for lazy-walk path uses single-instance Mesh
   adds (no instancing) — the initial ring bake gets the
   instancing win; the lazy hook adds are rare enough that
   per-instance draw cost is fine.

   This is the **first objective where the per-LB shape and the
   ring-driver shape diverge meaningfully**. Document the divergence
   inline.

   **Verification:** Same as Objective 2. Smoke +1 check (`bakeStaticsForLandblock`
   symbol). Plus +1 check asserting InstancedMesh path still collapses
   placements with `>=2` instances at ring-bake time.

5. **Expose `loadTerrainForLandblock` / `loadBuildingsForLandblock`
   / `loadStaticsForLandblock` on `liveScene3d`.** Mirror
   `scene3d/index.js:890`'s `loadEnvCellsForLandblock`. Each method
   calls its respective `bakeXForLandblock(this, lbX, lbY, this.opts,
   this.wasmExports)` and returns a Promise. The `opts` field is
   added to `liveScene3d` during `init3D` — it carries the resolved
   per-LB knobs from the ring bake (atlas texture, subdivLevel,
   displacementEnabled, etc.) so lazy adds don't redo that work.

   **Verification:** Smoke +3 checks for symbol presence.
   `liveScene3d.loadTerrainForLandblock(0xa9, 0xb5)` actually adds a
   mesh to `terrainGroup` (verified via DOM-stub smoke harness).

6. **Hook lazy loads in `handlePositionUpdate`.** In
   `external/holtburger/apps/holtburger-web/index.html:4122`, mirror
   the existing `if (lbId !== 0 && window.liveScene3d?.loadEnvCellsForLandblock)`
   guard for the three new methods. Decompose the LB id into
   `(lbX, lbY)` via `(lbId >>> 24) & 0xff` / `(lbId >>> 16) & 0xff`.

   Trigger 3×3 ring around the player's centre LB (mirror the
   existing terrain wasm-prefetch ring). The per-LB bakers
   short-circuit if the LB is already baked, so the cost is the
   3×3 set-lookups (≈ 9 hash hits).

   **Verification:** Smoke gains 1 check that walks a stub-position
   through the recv loop, observes the three loaders fire, and
   asserts the per-LB sets contain the new lbKey. Cargo unchanged.

7. **Distance-keyed subdivision LOD.** Today
   `scene3d/terrain.js:795` picks subdivLevel = full for centre LB,
   half for the 8 outer LBs. Replace with:

   - distance-0 (player's LB): `subdivLevel`
   - distance-1 ring (8 LBs immediately around player): `max(1,
     subdivLevel/2)`
   - distance-2+ rings: `1` (no subdivision)

   Distance is computed from `playerLb` not centre-LB. The per-LB
   baker (Objective 2) accepts a `subdivLevelForThisLb` argument.
   The driver computes it per-LB given the centre. The lazy hook
   (Objective 6) re-computes when the player's LB changes — but
   **does NOT re-bake** unsubdivided LBs to subdivided ones. (Re-bake
   on LOD shift is Step 2 scope; Step 1 accepts that LBs the player
   approaches stay at their initial LOD.)

   **Note:** the road overlay (lifted +0.4 m, terrain.js:592) is
   designed for subdivLevel=4 — at subdivLevel=1 the lift is
   unnecessary but harmless.

   **Verification:** Smoke gains 1 check confirming a LB 5 away from
   the centre gets `subdivLevelForThisLb === 1`. Eye-test:
   subdivision is visually identical at the centre LB versus the
   prior 3×3 default.

8. **Flip the initial ring radius `1` → `6` (3×3 → 13×13) at
   `init3D`.** In `scene3d/index.js:377-443` change the three
   `buildHoltburgX(scene3dForBuilders, wasmExports)` calls to call
   `bakeXRing(scene3dForBuilders, 0xa9, 0xb4, 6, wasmExports)`
   directly (or keep `buildHoltburgX` as wrappers and pass the
   radius via an explicit `RING_RADIUS` constant defined once).

   Per-LB baker fan-out: parallelize with `Promise.all` per layer.
   Per-LB heightmap fetch is already batched by
   `fetch_landblock_heightmaps(Uint32Array)`; per-LB object fetch is
   batched the same way. The wasm side handles 169 cell IDs in one
   call cleanly (verified at boot pack scope).

   Expected init-time impact: **terrain bake ~6× slower at radius=6
   vs radius=1** (oracle reports 169/9 = ~19× more LBs but 118 of
   the new LBs have zero objects so the building / statics layers
   are sub-linear in `169 / 9`). Cold-start through manifest /
   shards adds ~5-15 s of HTTP fetches for the new (non-boot) LB
   records. Acceptable.

   **Verification:** `capture_world_expand_e2e.cjs` (new, see
   Objective 10) asserts `terrainGroup.children.length === 169`.

9. **Fog extension to cover the loaded ring.** Override
   `DEFAULT_FOG_MAX` (`scene3d/sky_lighting.js:91`) from `800.0` to
   `2500.0` — sized to 13×13 corner-to-centre distance (~1.77 km)
   plus headroom. The wasm SkyState's per-tick `state.fogMax` clamp
   (`sky_lighting.js:388: this.fog.far = Math.max(this.fog.near + 1.0,
   state.fogMax)`) needs a floor: change to
   `this.fog.far = Math.max(this.fog.near + 1.0, state.fogMax,
   FOG_FAR_FLOOR)` where `FOG_FAR_FLOOR = 2500.0`. The per-DayGroup
   Region 0x13 `max_world_fog` values still drive the dynamic
   day/night fog colour and a tighter night fog; the floor keeps the
   draw distance long enough to see the ring.

   **Verification:** Smoke gains 1 check that
   `liveScene3d.skyLightingController._lastState.fog.far >= 2500`
   after init resolves. Eye-test: dusk/dawn fog still varies but
   doesn't hide the ring.

10. **Capture script: `capture_world_expand_e2e.cjs`.** Mirror the
    structure of `capture_visfid_p33_csm.mjs` /
    `capture_phase6_step_c_envcells.cjs`. Loads
    `?renderer=3d&quality=high`, waits for `init3D` to resolve,
    then asserts:

    - `liveScene3d.terrainGroup.children.length === 169`
    - `liveScene3d.buildingsGroup.children.length === 46` (from
      oracle ring sum)
    - `liveScene3d.staticsGroup.children.length` sum across the
      ring matches the oracle's non-building total (extract from
      `ring_13x13_inventory.jsonl`)
    - `liveScene3d.terrainBakedLbs.size === 169`
    - `liveScene3d.buildingsBakedLbs.size === 169`
    - `liveScene3d.staticsBakedLbs.size === 169`
    - **Lazy walk:** simulate `handlePositionUpdate` for an LB
      outside the initial ring (e.g. `0xA0AE` — 9 LBs west). Assert
      the three `bakedLbs` sets grow accordingly.
    - **Idempotency:** re-fire the same `handlePositionUpdate`.
      Assert no growth.
    - Oracle parity drill: for one sampled LB (e.g. `0xA9B0`), the
      rendered statics group's child `position` for each placement
      matches the oracle's `(x, y, z)` to within `0.01 m`.

    The oracle is loaded from
    `/mnt/wbterminal1/tmp/claude-scratch/world-expand/ring_13x13_inventory.jsonl`.

    **Verification:** Capture passes locally. The oracle JSONL is
    re-runnable via `node /mnt/wbterminal1/tmp/claude-scratch/world-expand/world_expand_inventory.cjs
    | dotnet WorldBuilder.Terminal.dll --project RetailSmoke.wbproj
    --stdin` so the assertions are reproducible from a fresh state.

11. **Native invariant + smoke + wasm checks.** `cargo test
    --workspace` ≥1352/0/1. `cargo check --target
    wasm32-unknown-unknown` clean for
    `holtburger-{dat,session,transport-ws,resource-http,web}`.
    `wasm-pack build --target {nodejs,web}` both green.
    `apps/holtburger-web/smoke_test.cjs` ≥ current count + Σ(new
    checks from Objectives 2-9). `capture_world_expand_e2e.cjs`
    PASS.

12. **Document + memory.** New as-built doc at
    `docs/world-expand-step-1-asbuilt-2026-05-13.md` (or whatever the
    landing date is) summarizing: per-objective commits, smoke
    delta, oracle parity result, eye-test screenshot path, known
    open follow-ons. Add a memory note at
    `~/.claude/projects/-home-wbterminal/memory/project_world_expand_step_1.md`
    + bump `MEMORY.md` index. Update
    `~/.claude/projects/-home-wbterminal/memory/project_emit_dynamic_site.md`
    with a "World-expand step 1 landed" paragraph in the same style
    as the existing Phase 6 entry.

---

## Why

Each objective answers a "why now" — not just "why eventually."

- **Why audit cells.js first (Objective 1)?** Because it is the only
  existing per-LB lazy loader in the 3D path and is the contract step
  1 mirrors. Skipping the audit leads to invented patterns that don't
  match the established idempotency / wasm-drain / preload shape and
  produce silent bugs (re-baked geometry, leaked wasm handles).
  Adding the oracle parity check at the same time catches data
  discrepancies between the two readers (WorldBuilder.Terminal vs the
  wasm `fetch_*` path) *before* we ship 169 LBs of data that might
  diverge from retail in ways the existing 9-LB tests never tripped.

- **Why per-LB bakers as separate refactors (Objectives 2-4) before
  the lazy hook (Objective 6)?** Because each layer (terrain,
  buildings, statics) has different fan-out shapes — terrain has
  shader uniforms that resolve once-per-ring, buildings have a
  per-Setup-model bake cache that lives across LBs, statics has the
  cross-ring InstancedMesh collapse. Doing them as separate commits
  keeps each diff reviewable; doing them before the lazy hook means
  the hook only has to plumb three already-tested functions, not
  three open-shape APIs.

- **Why an `opts` parameter instead of pulling from `scene3d`?**
  Because `scene3d` evolves across the ring bake (children get added,
  groups get attached). Threading an explicit `opts` makes the
  per-LB baker pure with respect to its inputs — easier to unit-test
  in isolation, easier to call from the lazy hook (where the
  scene3d state is mid-mutation in three.js's per-frame loop).

- **Why a single `liveScene3d.loadXForLandblock` method per layer
  (Objective 5)?** Because the lazy hook is JS-side and we want one
  symbol per layer to grep for. Matches the existing
  `loadEnvCellsForLandblock` pattern; mirrors the
  `try_ws_handshake_smoke` → `start_session` evolution from emit-
  dynamic-site Phase 4 step 1 where the boundary surface gets
  consolidated as the feature lands.

- **Why distance-keyed LOD only at Objective 7, not earlier?**
  Because the simpler fixed-LOD path lets us validate that 169 LBs
  bake correctly first. Once that's locked, switching the LOD rule
  is a per-LB-baker argument change — small diff, isolated visual
  impact. Doing it earlier would require LOD-aware oracle parity
  (different vertex counts at different distances), inflating
  Objective 1's scope.

- **Why a fog-far floor (Objective 9) instead of overriding the
  whole sky controller?** Because the day/night fog COLOUR is
  authoritative from Region 0x13's lerp (which sky_lighting.js
  already drives). Only the DRAW DISTANCE needs extending; everything
  else stays correct. A floor on `state.fogMax` does that
  surgically; touching the colour/lerp would re-litigate the
  Sky-A..H phase contracts.

- **Why a WorldBuilder.Terminal oracle for the capture (Objective
  10)?** Because the renderer's wasm `fetch_*` helpers and
  WorldBuilder.Terminal's `list-objects` / `get-bulk-heightmap` read
  the same DAT through different parsers. A capture that asserts the
  renderer's loaded objects exactly equal the oracle's
  `list-objects` output proves both readers agree — same as Phase 4
  Step 1's mock-bridge smoke proved the WS transport works without
  needing a live ACE. The oracle JSONL is small (~730 KB), runnable
  in <2 minutes from a fresh state, and works for any region of
  Dereth — so it generalizes to step 2 (radius bump) and step 3
  (region streaming) without changing the test pattern.

- **Why preserve the 3×3 wrapper APIs (`buildHoltburgX`)?** Because
  the existing capture scripts and smoke tests rely on radius=1
  behavior. Keeping the wrappers means the visual-fidelity wave-1
  through wave-6 captures keep passing during step 1's commits;
  flipping the call site is one localized change at Objective 8
  rather than 12 commits of "and update the captures too".

- **Why no Academy bake (LB 0x8602)?** Explicit user constraint:
  "20x the landblock size we have around holtburg (not the
  training academy)". Academy gets its own (later) world-expand
  treatment; step 1 keeps Academy init untouched so existing
  Academy captures (`capture_academy_envcells.cjs`,
  `capture_academy_tour.cjs`, `capture_academy_rubberband.cjs`)
  stay green at radius=1 Academy default.

- **Why preserve the native invariant?** Same reason as every prior
  step: `cargo test --workspace` ≥1352/0/1 has caught real bugs at
  each prior commit boundary. Most step 1 work is JS-side so the
  cargo count is unlikely to change; the invariant is the merge
  gate regardless.

- **Why is now the right time to start world-expand?** Because the
  renderer's visual-fidelity push is at 12/14 phases (subdivision,
  shadows, normals, terrain detail, triplanar, SSAO, CSM, POM,
  animated water, classifier, overrides, regression infra all
  shipped). The only remaining visual phase (2.3 hero PBR maps)
  is human art work, blocked on PK. Ground-area expansion is the
  next-largest visible-improvement vector and unblocks the
  long-promised "eventual whole-Dereth open world" goal recorded
  in `~/.claude/projects/-home-wbterminal/memory/project_emit_dynamic_site.md`.

---

## Specs

### Read these files first (in order)

1. [`docs/emit-dynamic-site.md`](emit-dynamic-site.md) — §3.1
   (Holtburger surfaces), §4.1 (WASM compile decisions), §8 Phase 6
   (open-world LB-entry — the precedent step 1 generalizes), §8
   "What's open" (the streaming follow-ons that step 1 is the first
   PR toward).
2. [`docs/phase-4-step-1-handoff.md`](phase-4-step-1-handoff.md) —
   the structural template this brief follows. Same Context → Intent
   → Objectives → Why → Specs shape; same commit conventions.
3. [`docs/visual-fidelity-handoff-pk-2026-05-13.md`](visual-fidelity-handoff-pk-2026-05-13.md)
   — what shipped in the renderer most recently, cargo / smoke
   baselines, the visual-fidelity phases that must remain working
   at radius=6.
4. [`~/.claude/skills/worldbuilder-terminal/skill.md`](file:///home/wbterminal/.claude/skills/worldbuilder-terminal/skill.md)
   — the JSON command catalog. §"Categorical command catalog" →
   "Terrain inspection" + "Object placement" + "Living atlas" cover
   the oracle commands step 1 uses (`get-heightmap`,
   `get-bulk-heightmap`, `list-objects`, `describe-landblock`).
5. [`external/holtburger/apps/holtburger-web/scene3d/cells.js`](../external/holtburger/apps/holtburger-web/scene3d/cells.js)
   — `buildEnvCellsForLandblock` (line 77) is the canonical per-LB
   lazy loader. The "drain wasm into JS-owned snapshots → preload
   materials → instantiate THREE Groups" pattern is the contract.
6. [`external/holtburger/apps/holtburger-web/scene3d/terrain.js`](../external/holtburger/apps/holtburger-web/scene3d/terrain.js)
   — `holtburgNeighbourhoodCellIds` (line 542) and
   `buildHoltburgTerrain` (line 712). The hardcoded 3×3 loop and the
   centre-vs-ring subdivision rule both live here.
7. [`external/holtburger/apps/holtburger-web/scene3d/buildings.js`](../external/holtburger/apps/holtburger-web/scene3d/buildings.js)
   — `buildHoltburgBuildings` (line 299) and the
   `bakeBuildingPlacement` per-Setup-model bake (line 89). The
   per-placement Group + hinge wrapper tree (lines 1-50 commentary)
   is the door-rotation contract step 1 preserves.
8. [`external/holtburger/apps/holtburger-web/scene3d/statics.js`](../external/holtburger/apps/holtburger-web/scene3d/statics.js)
   — `buildHoltburgStatics` (line 68). The F#5+6 InstancedMesh / LOD
   logic at lines 395-485 is the cross-ring collapse step 1 must
   preserve.
9. [`external/holtburger/apps/holtburger-web/scene3d/index.js`](../external/holtburger/apps/holtburger-web/scene3d/index.js)
   — `init3D` (line 44), the three `buildHoltburgX` call sites
   (lines 377, 423, 435), `loadEnvCellsForLandblock` symbol on
   `liveScene3d` (line 890). The pattern Objective 5 mirrors.
10. [`external/holtburger/apps/holtburger-web/index.html`](../external/holtburger/apps/holtburger-web/index.html)
    — `handlePositionUpdate` (line 4122), `ensureTerrainAroundLandblock`
    (line 4047), the existing 3D-side `loadEnvCellsForLandblock` hook
    (line 4192). Objective 6 adds three sibling hooks.
11. [`external/holtburger/apps/holtburger-web/scene3d/sky_lighting.js`](../external/holtburger/apps/holtburger-web/scene3d/sky_lighting.js)
    — `DEFAULT_FOG_MAX` (line 91) + the per-tick fog clamp at line
    388. Objective 9's two-line floor change.
12. [`external/holtburger/apps/holtburger-tools/src/dat_shard.rs`](../external/holtburger/apps/holtburger-tools/src/dat_shard.rs)
    — `spawn_neighborhood_cells` (line 371). Explains why the boot
    pack covers Holtburg's 9 LBs and why the other 160 LBs of the
    ring fetch from shards. Important context for "first-load
    latency is OK because shards are pay-as-you-go".
13. **Oracle data (already captured):**
    - `/mnt/wbterminal1/tmp/claude-scratch/world-expand/ring_13x13_inventory.jsonl`
      (730 KB) — `get-bulk-heightmap` + 169× `list-objects` + 169×
      `describe-landblock`.
    - `/mnt/wbterminal1/tmp/claude-scratch/world-expand/heightmaps_13x13.json`
      (142 KB) — extracted bulk-heightmap.
    - `/mnt/wbterminal1/tmp/claude-scratch/world-expand/world_expand_inventory.cjs`
      — re-runnable driver.

### Sketch — `bakeTerrainForLandblock` shape

```js
// scene3d/terrain.js

export async function bakeTerrainForLandblock(
  scene3d,
  lbX,
  lbY,
  opts,    // { atlasTexture, roadTexture, codeToSliceArr, subdivLevel,
           //   detailNormalArrayTex, displacementEnabled, ... }
  wasmExports,
) {
  if (!scene3d.terrainBakedLbs) scene3d.terrainBakedLbs = new Set();
  const lbKey = ((lbX << 24) | (lbY << 16)) >>> 0;
  if (scene3d.terrainBakedLbs.has(lbKey)) return null;   // idempotent
  scene3d.terrainBakedLbs.add(lbKey);

  // 1. Fetch base + subdivided heightmaps for this single LB.
  const cellId = (lbKey | 0xFFFF) >>> 0;
  const [baseMesh] = await wasmExports.fetch_landblock_heightmaps(
    new Uint32Array([cellId]),
  );
  let subdivMesh = null;
  if (opts.canSubdivide) {
    const level = opts.pickSubdivLevelForLb(lbX, lbY);  // see Objective 7
    subdivMesh = await wasmExports.fetch_subdivided_landblock(cellId, level);
  }

  // 2. Build the THREE.Mesh (heightfield + per-LB vertex-types texture
  //    + road overlay + subdivision + displacement). Lifted verbatim
  //    from the existing buildHoltburgTerrain inner loop body.
  const lbMesh = makeLandblockMesh(baseMesh, subdivMesh, lbX, lbY, opts);
  scene3d.terrainGroup.add(lbMesh);

  if (baseMesh.free) baseMesh.free();
  if (subdivMesh?.free) subdivMesh.free();
  return lbMesh;
}

export async function bakeTerrainRing(
  scene3d,
  centreLbX,
  centreLbY,
  radius,
  wasmExports,
) {
  // Resolve once-per-ring uniforms / textures.
  const [terrainTextures] = await Promise.all([
    wasmExports.fetch_terrain_textures(),
  ]);
  const opts = resolveTerrainOpts(scene3d, terrainTextures, /*...*/);

  // Fan-out per-LB bakes.
  const promises = [];
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      const lbX = centreLbX + dx;
      const lbY = centreLbY + dy;
      if (lbX < 0 || lbX > 0xff || lbY < 0 || lbY > 0xff) continue;
      promises.push(bakeTerrainForLandblock(scene3d, lbX, lbY, opts, wasmExports));
    }
  }
  await Promise.all(promises);

  return { atlasTexture: opts.atlasTexture, roadTexture: opts.roadTexture,
           lbCount: scene3d.terrainBakedLbs.size, /*...*/ };
}

// Preserve radius=1 wrapper for back-compat with existing captures.
export async function buildHoltburgTerrain(scene3d, wasmExports) {
  return bakeTerrainRing(scene3d, 0xa9, 0xb4, 1, wasmExports);
}
```

Exact uniform / shader handling depends on the current `buildHoltburgTerrain`
implementation — audit and lift verbatim. **The above is shape, not
ready-to-paste code.**

### Sketch — lazy hook in `handlePositionUpdate`

```js
// index.html ~line 4192 (after the existing loadEnvCellsForLandblock hook)

if (lbId !== 0 && window.liveScene3d?.loadTerrainForLandblock) {
  // 3×3 ring around player's centre LB for terrain. Mirror
  // ensureTerrainAroundLandblock's neighborhood pattern.
  const cx = (lbId >>> 24) & 0xff;
  const cy = (lbId >>> 16) & 0xff;
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || nx > 0xff || ny < 0 || ny > 0xff) continue;
      // Fire-and-forget; per-LB baker is idempotent.
      window.liveScene3d.loadTerrainForLandblock(nx, ny);
    }
  }
}
if (lbId !== 0 && window.liveScene3d?.loadBuildingsForLandblock) {
  const cx = (lbId >>> 24) & 0xff;
  const cy = (lbId >>> 16) & 0xff;
  window.liveScene3d.loadBuildingsForLandblock(cx, cy);   // 1-LB scope
}
if (lbId !== 0 && window.liveScene3d?.loadStaticsForLandblock) {
  const cx = (lbId >>> 24) & 0xff;
  const cy = (lbId >>> 16) & 0xff;
  window.liveScene3d.loadStaticsForLandblock(cx, cy);     // 1-LB scope
}
```

Terrain warrants a 3×3 ring (LOD + edge stitching matters); buildings
and statics are 1-LB (no cross-LB dependencies). Same scope split as
the existing wasm-side hooks.

### Sketch — distance-keyed subdivision LOD

```js
// scene3d/terrain.js

function pickSubdivLevelForLb(scene3d, lbX, lbY, fullLevel) {
  const playerLb = scene3d.playerLbKey ?? scene3d.initialCentreLbKey;
  const pX = (playerLb >>> 24) & 0xff;
  const pY = (playerLb >>> 16) & 0xff;
  const distLb = Math.max(Math.abs(lbX - pX), Math.abs(lbY - pY));  // Chebyshev
  if (distLb === 0) return fullLevel;
  if (distLb === 1) return Math.max(1, Math.floor(fullLevel / 2));
  return 1;
}
```

`scene3d.playerLbKey` updates on every `handlePositionUpdate` so lazy
hooks bake new LBs at the correct LOD for their distance at bake
time.

### Verification checklist (per commit boundary)

- [ ] `cargo test --workspace` from `external/holtburger/` — ≥1352/0/1.
- [ ] `cargo check --target wasm32-unknown-unknown` clean for
      `holtburger-{dat,session,transport-ws,resource-http,web}`.
- [ ] `wasm-pack build --target {nodejs,web}` both green.
- [ ] `node smoke_test.cjs` from `apps/holtburger-web/` — current
      count + this objective's delta.
- [ ] **Capture parity:** if Objective 10 or later, `node
      capture_world_expand_e2e.cjs` PASS.
- [ ] **Existing captures:** all `test_visfid_p*` + `capture_*` that
      were green at `89b3986` remain green. Run before push.
- [ ] **Eye-test:** Objectives 7-9 require visual confirmation —
      capture screenshots to
      `docs/images/world-expand-step-1-*` and check them in.

### Decisions to NOT re-litigate

These were settled in the planning session (2026-05-13, in
conversation immediately preceding this brief). Do not re-open
without explicit ask from the user:

- **Scale target = 13×13 LBs (169 total, ≈ 19× current).** Not
  larger (no 41×41 / 60×60), not smaller (no incremental 5×5 first
  step). User chose 13×13 explicitly in plan Q&A.
- **Lazy 3D pipeline (mirror cells.js per-LB pattern) over static
  bigger bake.** User picked option (b) "Lazy 3D pipeline + small
  initial ring" — generalizes to whole Dereth and is the architecture
  for future radius bumps.
- **Fog extends to cover the loaded ring.** User picked "Extend fog
  to ~2500m so 13×13 is mostly visible" over the retail-ish 800 m
  default. Accept the art-direction change.
- **Training Academy (LB 0x8602) is OUT OF SCOPE.** User explicitly
  said "not the training academy". Academy gets its own world-expand
  treatment later.
- **WorldBuilder.Terminal is the data oracle, not a runtime
  dependency.** Renderer keeps using its wasm `fetch_*` helpers at
  runtime; WorldBuilder.Terminal is for build-time validation and
  capture-script assertions. User said "we only operate based on
  data" — this is how we make that concrete without dragging
  WorldBuilder.Terminal into the browser bundle.
- **No instancing refactor for buildings.** Per-placement Group
  preserved (door rotation contract).
- **WASM-port over server-side per-player rendering.**
- **PixiJS / Three.js direct renderer; no Leaflet basemap reuse.**
- **`wasm-pack` build pipeline.**
- **Real `~/ac_base_dats/` DATs over synthetic fixtures.**
- **`dat-shard` v2 production bake (`/mnt/wbterminal1/holtburger-dist-v2/`)
  is the delivery substrate.**

### Decisions still legitimately open after step 1

- **Re-bake-on-LOD-shift.** Today's step 1 picks LOD at bake time and
  doesn't re-bake when the player walks closer. Step 2 may add
  re-bake-on-approach (drop the old mesh, bake a higher-subdiv
  version). Out of scope here.
- **Texture-atlas LRU eviction.** Today's 13×13 ring fits in WebGL2
  buffer limits; step 2 (eviction) is gated on perf data from PK's
  hardware.
- **Region-streaming primitive.** Step 1 hardcodes radius=6 around
  `0xa9 0xb4`. Step 2 generalizes to `centreLb = playerLbAtSpawn`
  and exposes a `?radius=N` URL param.
- **Per-LB ambient-roller sanity for the new LBs.** AmbientRuntime
  (`scene3d/audio/ambient_runtime.js`) walks
  `terrainGroup.children` so it auto-extends, but step 1 doesn't
  verify the new ambient LBs sound right. PK eye-test follow-on.
- **Step 2 — flip radius to a URL param + spawn-centred ring.**
  Likely scope for the next contained step.
- **Step 3 — region streaming + eviction + LRU.** Scope after step 2.
- **Whole-Dereth (256×256) scope.** Needs all of: region streaming,
  per-LB texture-atlas eviction, per-LB lighting/audio budget caps,
  multiple-region sky lerping (regions other than 0x13000000).

### Commit conventions (match prior session)

- `feat(holtburger-web): <subject>` for the per-LB baker refactors
  + lazy hook + LOD changes.
- `feat(emit-dynamic-site): <subject>` for the init3D radius flip
  (Objective 8) since it touches the architectural seam.
- `test(holtburger-web): <subject>` for the smoke-test additions per
  objective.
- `docs(emit-dynamic-site): <subject>` for the as-built doc + this
  brief's status updates.
- Commit body: section-headed paragraphs explaining **what** + **why**,
  with verification stats (cargo / smoke counts, oracle parity
  result). See `cb97dc4` for format example from Phase 2.2.
- Co-author trailer: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- Memory update at the end: edit
  `/home/wbterminal/.claude/projects/-home-wbterminal/memory/MEMORY.md`
  to add the new `project_world_expand_step_1.md` line + bump
  `project_emit_dynamic_site.md`'s body with a "World-expand step 1
  landed" paragraph.

### Tooling assumed installed

- `cargo` + `rustc` (in `~/.cargo/bin`, source `~/.cargo/env` if
  needed).
- `wasm-pack 0.14.0`.
- `wasm32-unknown-unknown` rustup target.
- `node` ≥ 18 (Playwright dropped into npx cache at
  `/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules` — set
  `NODE_PATH` when running cjs captures directly).
- `dotnet 8.0` SDK at `/home/wbterminal/.dotnet` for
  WorldBuilder.Terminal oracle queries.
- WorldBuilder.Terminal already built at
  `WorldBuilder.Terminal/bin/Release/net8.0/WorldBuilder.Terminal.dll`.
- `RetailSmoke.wbproj` at `/home/wbterminal/projects/RetailSmoke/` with
  ontology cache + building pairings + gazetteers preloaded.
- Real browser (Chrome / Firefox) for manual validation, or
  `npx playwright install chromium` for scripted captures.
- **External-drive scratch:** all logs / screenshots / traces under
  `/mnt/wbterminal1/tmp/claude-scratch/world-expand/`. The system disk
  is at 96 % (5 GB free); do not write to `/tmp`.

### What done looks like

- 12 commits land on `master` (one per objective), each green at the
  verification gates above.
- `node capture_world_expand_e2e.cjs` PASS — 169 terrain meshes, 46
  buildings, ~720 statics; per-LB sets idempotent; oracle parity
  drill clean.
- `cargo test --workspace` ≥1352/0/1; `wasm-pack build` both targets
  green; smoke test up by ~10 checks for the new symbols + idempotency
  + lazy hook + LOD + fog floor.
- New screenshot at
  `docs/images/world-expand-step-1-13x13.png` showing the ring under
  `?renderer=3d&quality=high` from a hilltop oblique angle (NOT
  top-down — the visual-fidelity push docs called out that top-down
  hides shadows / subdivision).
- New as-built doc at
  `docs/world-expand-step-1-asbuilt-<date>.md` with: per-objective
  commit ledger, smoke/cargo deltas, oracle-parity outcome,
  screenshot link, open follow-ons.
- Memory updated: new `project_world_expand_step_1.md` body + line
  in `MEMORY.md`; `project_emit_dynamic_site.md` extended with the
  step-1 paragraph.
- The next session can either (a) tackle step 2 (radius URL param +
  spawn-centred ring), (b) close the 12/14 → 14/14 visual-fidelity
  phases (Phase 2.3 PBR + 2.3 polish — PK-blocked), or (c) start
  step 3 (texture-atlas LRU + eviction) once perf data lands. Step 1
  closes one specific architectural gap without blocking any of
  these.

### Notes for the next world-expand step (forward-looking)

These are observations from the planning session — record them so
the agent picking up step 2 doesn't redo the analysis:

- **Only 51 of 169 LBs in the 13×13 ring are populated.** The other
  118 LBs have terrain but zero static objects. Whole-Dereth (65,536
  LBs) is likely ~30 % populated. The per-LB-baker driver should
  short-circuit no-object LBs cheaply (don't pay for the wasm
  round-trip if `LandblockInfo.objects.is_empty()` — the wasm side
  can return an empty list fast).
- **South Holtburg Outpost (`0xA9B0`) is a real second settlement in
  the ring.** Hardunna + Hudriffa the Shopkeeper live there. POIs
  worth eye-testing for: drop the player near `0xA9B0` and confirm
  the outpost paints.
- **Cost model per LB:** terrain mesh ~9×9 base + subdivLevel × 9×9
  subdiv = ~80-1280 vertices depending on LOD. Buildings: ~0.3 per
  LB average across the ring (46 / 169), but Holtburg alone has 12.
  Statics: ~5 per LB median (excluding empty LBs), 222 in 3×3 today,
  ~720 across the 13×13 ring.
- **Boot pack is at 1.86 MB** (Holtburg's 3×3 transitive closure).
  Step 2 might want to regenerate the boot pack at radius=6
  (~6× bigger boot, maybe 11 MB) to shorten first-load on the 13×13
  region. But: `dat-shard` rebuild touches 4.3 GB of shards and the
  manifest re-key — overhead is real. The pay-as-you-go lazy shard
  path works today; only optimize if PK's perf data warrants it.
- **Adjacent-LB-loaded wiring through wasm** (visual-fidelity wave-2
  follow-on: `subdivide_landblock` accepts adjacent-LB heights for
  bicubic continuity but the wasm export always passes mirror) —
  becomes more visible at radius=6 where seam edges multiply. Likely
  a step-2-or-step-3 follow-on.
- **The `_chainBeforeCompile` shader-patch composition primitive** is
  load-bearing: Phase 0.2 + 3.3 + 3.1 all compose patches on
  `MeshStandardMaterial`. Step 1's per-LB bakers must use the
  existing material cache, not invent a parallel one.
- **Three.js APIs to verify against r184 docs each session:**
  `DataTexture2DArray` → `DataArrayTexture`. `PCFSoftShadowMap`
  deprecated. `cascades` API doesn't exist — CSM is hand-rolled.
  Likely more drift to surface at radius=6 scale.

**End of brief.** Ship the 12 commits and the screenshot; ping back
with smoke / cargo deltas at each commit boundary.
