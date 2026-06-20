# Handoff — "world looks empty / barren of statics" investigation (2026-06-20)

**Status: ROOT CAUSE FOUND (from code) + FIX IMPLEMENTED, AWAITING LIVE A/B.**
Diagnosed 2026-06-20 PM session — see §"ROOT CAUSE (confirmed from code)" and
§"FIX IMPLEMENTED" below. The prior session's "renderSet=1 is the smoking gun"
lead was the THIRD measurement error: renderSet=1 outdoors is BY-DESIGN, not a
bug (proof below). Validation = user A/B's `?pvsRingRadius=1` (old 3×3) vs default
(radius 5) on the live 1070 while roaming wilderness away from Holtburg.

## Symptom
User (looking at the live 1070 client) reports the rendered world is **barren / "empty
of statics"** compared to **real retail AC** (they explicitly chose retail AC as the
reference, not "denser than retail" or "fuller than yesterday"). Most visible while
roaming wilderness/coast. They were emphatic it is **busted**, not sparse-by-design.

## RULED OUT (each verified this session — do not re-litigate without new evidence)
1. **ace_world DB is COMPLETE full retail.** `landblock_instance` = **365,183 rows /
   4,520 distinct landblocks** — identical to the canonical `ACE-World-Database-v0.9.292.sql.zip`
   in the repo (~365,183). NOT a partial import. (`mysql -uace -pace ace_world`.)
2. **Scenery DATA is complete + identical everywhere.** `dist/scenery` = 40,197 LBs /
   3,131,844 placements (2026-06-01). Byte-same on laptop (live), `~/from-vm/bake/whole-dereth-2026-06-08`,
   and the buildbox `~/holtburger-dist/scenery`. Per-LB counts match (e.g. 0xB0AD=150).
3. **Scenery GENERATION is retail-faithful.** `crates/holtburger-scenery-bake/src/lib.rs:497-575`
   ports ACE `Scenery.cs::Load` line-for-line (`noise < obj.freq && weenie_obj==0`, displace,
   on_road, slope). It even **omits ACE's collision-rejection**, so if anything it places
   *more*, not fewer. Bake used the base retail DATs (`~/ac_base_dats`).
4. **The wasm fetch returns everything.** `wasmExports.fetch_landblock_scenery([0xB0AD0000])`
   → **150 placements** (NOTE: arg is a `Vec<u32>` **array** — passing a bare number returns
   0, an artifact, not a bug).
5. **The bake attaches everything.** `bakeStaticsForLandblock(ls,176,173,opts,we)` summary:
   `objectCount:150, skippedNoMesh:0, staticBatchGroupCount:17, singletonCount:210`. All 150 attach.
6. **Statics are NOT hidden by `.visible` culling.** Forcing every static `.visible=true`
   each frame produced **zero visual change**. The ~342k verts of static geometry in
   `staticsGroup` are almost all the **Holtburg boot-bake region** (off-screen, correctly
   not drawn); the ~5k visible verts ARE the player's LB's 150 objects rendering (sparse).

## My errors (the prior session's two false "smoking guns" — DO NOT repeat)
- **"2 of 150 rendered"** — false. A per-object world-position scan of `staticsGroup`
  cannot see **merged static-batch meshes** (17 batches hold the 150). Count objects via
  the bake summary, not by scanning mesh positions.
- **"98.5% culled"** — false. `visibleVertices 4995 / total 342942` looked like culling but
  the 342k is mostly off-screen Holtburg geometry; force-visible proved nothing was wrongly hidden.

## ~~THE ONE GENUINELY-ABNORMAL FINDING (best lead)~~ — DISPROVEN (3rd measurement error)
`getRenderSet().length === 1` outdoors is **BY-DESIGN, not a bug.** `getRenderSet`
returns `render_set(current, 1)` (lib.rs:31779) — a BFS over `cell_portal_graph`,
which is fed **only** EnvCell (indoor) `CellPortal` records (`insert_cell_portal`,
scene.rs:979; the comment at scene.rs:990 is explicit: *"Outdoor cells are not stored
here — current_cell derives them from the 8x8 grid"*). Outdoors there are no portal
edges, so the BFS is **structurally always `{current}`** → length 1, everywhere,
always. It was NEVER ~9-25 outdoors. Chasing "fix the BFS" would have wasted a session.

## ROOT CAUSE (confirmed from code)
The renderSet finding pointed at the right SUBSYSTEM (PVS streaming) but the wrong
mechanism. The real cause:

- The radius-6 (13×13 = 169 LB) boot ring that the comment at `scene3d/index.js`
  explicitly says gives *"the full visible horizon… instead of empty wilderness past
  ~480m"* is **hardcoded to center on Holtburg** (`statics.js:2316`, `buildings.js:1184`,
  `terrain.js` all `bakeXRing(…, HOLTBURG_X, HOLTBURG_Y, …)`). It never follows the player.
- AWAY from Holtburg, the ONLY static/scenery/building/terrain-mesh coverage came from:
  - the LB-crossing hook → **1 LB** for statics + buildings (`world_stream.js:142-150`;
    terrain 3×3 via `ensureTerrainAroundLandblock`, index.html:3432), and
  - `tickPvsLoadExpansion` → renderSet(=1, see above) expanded to a hardcoded **3×3**
    (`cells.js`), ≈288 m.
- Scenery (the 3.1M scattered trees) baked through the SAME `bakeStaticsForLandblock`
  path (statics.js:1535-1539) — no wider scenery stream exists.

Net: **everywhere except the Holtburg neighborhood, the player saw exactly the
"empty wilderness past ~480 m" symptom the 2026-05-16 radius 2→6 bump was written to
cure — the cure just never followed the player.** This is consistent with EVERY ruled-out
item: the data / generation / wasm-fetch / bake / culling are all fine *for the LB you
stand in* — the bug is that LBs 2+ away never get baked, so the distance reads barren.
The prior session's own observation (staticsGroup's 342k verts are "mostly the off-screen
Holtburg boot-bake region") is the smoking gun: Holtburg statics resident-but-off-screen
while the player's actual surroundings have nothing past 3×3. Camera far=5000 m and
operative fog=SkyState `fogMax ~2500 m`, so distant statics WOULD render if baked.

(Matches the buildbox 50-agent audit RUNTIME-1 "boot ring hardcoded to Holtburg" +
RUNTIME-2 "LRU maxResident=169 thrash" — both now addressed by the fix below.)

## FIX IMPLEMENTED (2026-06-20 PM, JS-only, default-on, awaiting live A/B)
Player-centered PVS-expansion ring. All edits JS-only — **no wasm rebuild**.
- `scene3d/index.js`: new `PVS_RING_RADIUS` const (`?pvsRingRadius=N`, **default 5** =
  11×11 ≈ 960 m; `agentic=low`→1). Included in `ringMax` for the LRU `lbCap`. Exposed
  on the live scene object as `pvsRingRadius`.
- `scene3d/cells.js` `tickPvsLoadExpansion`: ring radius now reads `scene3d.pvsRingRadius`
  (fallback 1 = legacy 3×3); **also fires `loadTerrainForLandblock`** per ring LB so the
  terrain MESH widens in lockstep (else statics float over the void past the 3×3 terrain
  patch). Added a per-frame signature gate so the (121×3≈363) idempotent hook calls fire
  once per LB-crossing, not every rAF (avoids a Promise-alloc storm).
- LRU: 11×11 (121) moving working set fits under the 169 cap (boot radius 6) with ~48 LB
  headroom — no thrash at default. `pvsRingRadius=6` (169) would fill it → pair with `?lbCap=225`.

**A/B (live 1070, roam wilderness FAR from Holtburg):** `?pvsRingRadius=1` = old barren
3×3; default (or `?pvsRingRadius=5`) = filled horizon. If the wilderness fills to ~960 m
and matches retail density → confirmed, keep default-on. Watch frame-time while roaming
(continuous wide-ring baking is heavier; dial radius down or `agentic=low` if it stutters).

## NEXT STEPS (in priority order)
1. **Why is renderSet=1 outdoors?** Trace `scene3d/cells.js tickCellVisibility3D` + the wasm
   cell-visibility BFS (`getRenderSet` / `getRenderSetWithFrustum` / `getRenderSetWithPView`).
   If the BFS only returns the player's own cell, the whole streaming ring is starved → fix the BFS.
2. **Disambiguate sparse-coast vs real bug:** the test LB this session (0xB0AD = lbX176,lbY173)
   is an **ocean coast — genuinely sparse even in retail.** Walk to a known-DENSE **inland
   forest or town** LB and diff DAT-expected scenery vs rendered there. If a dense inland LB is
   also bare → real streaming/cull bug. If dense inland renders fine → the coast was just sparse.
3. **Verify boot-ring vs spawn LB:** confirm the statics boot ring centers on Holtburg, not the
   spawn LB (audit RUNTIME-1). Fix = center the initial terrain/statics/buildings rings on the
   actual first-spawn lbId (the audit's documented Step 2), not hardcoded Holtburg.
4. **(Lower) DAT region scene-table density:** confirm the bake's region (0x13000000) scene table
   is full retail, not a stripped `e1-inworld/dats/base` variant. If stripped → world uniformly
   sparse vs retail (re-bake from `~/ac_base_dats`).

## Repro / measure (CDP)
- 1070 Chrome over CDP **port 9333** (`ssh -fN -L 9333:127.0.0.1:9333 young@100.127.215.75`);
  app at `http://127.0.0.1:18765/...` (reverse tunnel `-R 18765` to laptop serve.py). chrome-devtools MCP.
- `liveScene3d.{staticsGroup, staticsBakedLbs, wasmExports}`. `staticsBakedLbs` key =
  `(((lbX&0xff)<<24)|((lbY&0xff)<<16))>>>0`.
- `wasmExports.fetch_landblock_scenery([cellId])` (ARRAY). `bakeStaticsForLandblock(ls,lbX,lbY,ls.staticsOpts,ls.wasmExports)` → summary (can be huge; read fields not the whole thing).
- `getLocalPlayerPose()` → `.landblockId`. `__sessionHandle.getRenderSet()`.
- ace_world: `mysql -uace -pace -N -e "SELECT COUNT(*) FROM ace_world.landblock_instance WHERE (obj_cell_id>>16)=0xXXYY;"`.
- WBT: `cd WorldBuilder.Terminal/bin/Release/net8.0 && DOTNET_ROLL_FORWARD=LatestMajor printf '%s\n' '{"command":"load","path":"/home/wbterminal/e1-inworld/test.wbproj"}' '{"command":"ace-db-connect","host":"127.0.0.1","database":"ace_world","user":"ace","password":"ace"}' '{"command":"dump-lb-expectations","lbX":176,"lbY":173}' | dotnet WorldBuilder.Terminal.dll --stdin`.
  CAVEATS: its `bakedScenery` reads a STALE path (`/mnt/wbterminal1/holtburger-dist-v2`) → unreliable;
  `npcs`/`buildings` need the ontology/pairings (NOT auto-loaded) → show 0 even for towns. Reliable
  fields: `sceneryLandblockInfo`, `events`, `envCells`.

## Session state left behind (IMPORTANT)
- **dist/spawns = the wilderness fill (38,153 LBs)** restored as live (the populated world the user
  wanted). Backups intact: `spawns.bak-2026-06-17` (4,520-LB retail snapshot, w/ orientations),
  `spawns.identity-whole-2026-06-14` (no orientations), `spawns.wildernessfill-2026-06-17`.
  `_health.json` updated (spawns=38153/world), backup `_health.json.bak-2026-06-19`.
  `dist` is a symlink → `/mnt/wbterminal2/holtburger-dist` (world data NOT in git).
- **Shipped + committed + pushed to origin/master (salvia420-bit) this session** (unrelated to this bug):
  `d4ceb610` movement stall→pullback fix (`?routinePosGuard`), `704ab173` terrain triangle-Z sink fix
  (`USE_TRIANGLE_TERRAIN_Z`). Both default-on, 1070-validated. WASM cache-bust = `v=terrain-tri-z-v3-2026-06-19`.
- buildbox VM was started then **stopped** (`gcloud compute instances stop buildbox --zone us-central1-a`);
  its `~/holtburger-dist` world = identical to live (nothing different to retrieve there).
- `0xB0AD` staticsBakedLbs flag was cleared + rebaked during probing (re-flagged, fine). Any force-visible
  rAF was cancelled.

## Related memory
[[project_terrain_bilinear_vs_triangle_sink_2026-06-19]], [[project_stall_pullback_routine_pos_force_interp_2026-06-19]],
[[project_empty_world_fix_2026-06-17]], [[project_holtburger_scenery_plumb_gap_2026-05-30]],
[[project_holtburger_agentic_low_2026-05-21]] (ring radii / staticsBakedLbs), [[reference_worldbuilder_terminal]],
[[reference_buildbox_headless_claude_workflow]].
