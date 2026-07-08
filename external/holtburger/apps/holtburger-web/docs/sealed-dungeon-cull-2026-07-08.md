# Sealed-dungeon outdoor cull — Town Network perf (2026-07-08)

## The report
"In Town Network I see the ocean rendering, big mountains and hills, other stuff.
Rendering all that while in the ENV cell is imaginably a big perf hit — a player in
the town network doesn't need it." Plus: water rising/falling *on the dungeon floor*.

## Data analysis — "seeing" Town Network in the DATs (WorldBuilder.Terminal)
Town Network destination cell (from the portal weenies 43065/43066/43067/42852,
LSD posStat 2) = objcell **0x00070143** → **landblock 0x0007**, EnvCell 0x0143 (323 ≥
256 = indoor). Project used: `projects/RetailSmoke/RetailSmoke.wbproj` (retail base
DATs). Commands run against it:

- `terrain-info lbX=0 lbY=7` → **heightMin/Max/Avg = 0** (flat sea level); terrain
  types **83% WaterDeepSea (20) + 17% sand-yellow (10)** → open ocean.
- `describe-landblock lbX=0 lbY=7` → `summary: "flat, mostly waterdeepsea, no road"`;
  interior **205 cells, 533 statics, 476 cell-graph edges, exteriorPortals: 0**,
  structureCount 0, 176 spawns (portals).
- `get-bulk-heightmap` window 0..15 × 1..15 → **column x0 (where Town Network sits)
  is all sea level**; immediately east, **x1 is a 416 m wall top-to-bottom** (the AC
  world-edge mountain wall) plus a full mountain range x2–x14 (40–416 m). That is the
  "ocean + big mountains/hills" the player sees.
- `pvs-visibility-snapshot 0x00070143 bfsDepth 8` → **205 visible cells, ALL interior,
  0 surface, all within LB 0x0007.** The retail PVS from inside is interior-only.

Conclusion: Town Network is a fully-enclosed hub dungeon parked in the deep-sea
ocean at the far-SW world edge. Retail renders **zero** surface from inside it. The
"water on the floor" is the z=0 ocean plane of 0x0007 cutting through the interior
(dungeon z-span −6..+6).

## Root cause (render path)
`scene3d/cells.js tickCellVisibility3D` forced `terrainGroup`/`buildingsGroup`/
`staticsGroup` **visible = true unconditionally** whenever indoor. That is the Phase 5
render-order fix (2026-05-25) — deliberately keep terrain visible so the landscape
shows through a **cottage doorway** (a depth-clear two-pass trick paints terrain, then
draws the interior on top). Correct for openings; pure waste for a sealed dungeon,
which has none.

## The fix (`?sealedCull`, default ON, `=off` escapes)
- **wasm** `SessionHandle::currentDungeonHasOutdoorPortal()` (src/lib.rs, next to
  `isCurrentCellIndoor`): scans the snapshot's `cell_portal_polygons` for the AC
  outdoor sentinel `to & 0xFFFF ≥ 0xFFFE`, restricted to the current cell's landblock
  high word. Returns **false** only for a fully-loaded, mouthless indoor dungeon;
  returns **true** (⇒ don't cull) for outdoor / no-cell / not-yet-loaded (conservative
  — no entry-time flicker at a mouthed dungeon). Same sentinel the PView walk skips and
  `getVisiblePortalApertures` collects. Additive export, no manifest bump.
- **JS** `cells.js`: `tickCellVisibility3D` now sets the three outdoor groups'
  visibility to `wantOutdoorVisible = !(SEALED_CULL_ENABLED && isIndoor &&
  !currentDungeonHasOutdoorPortal())`. Re-checked per frame while indoor (the wasm
  side is a ~140-entry integer scan — far cheaper than one terrain draw call). typeof-
  guarded so a stale pkg leaves terrain visible.

Coarse per-dungeon (not per-view): only ever culls at **zero** exterior portals, so
mouthed dungeons/cottages are untouched — safe by construction, no regression, no pop.

## Validation (headless, this laptop, release wasm, account tailnet1)
`autoSpawn=first` happened to spawn *in Town Network* (cell 0x00070143, pose 70,−60,0).

| Location | isIndoor | hasOutdoorPortal | terrain/buildings/statics |
|---|---|---|---|
| Town Network 0x0007 (sealed) | true | **false** | **hidden** |
| Holtburg 0xa9b4 (outdoor) | false | true | visible (15 LBs) |

A/B draw-call delta at Town Network (toggle groups on/off, `info.autoReset=false`):
**1575 → 525 draw calls (−1050, −67%)**, **70,782 → 23,594 tris/frame**. Hidden
resident geometry: terrain 138k tris, buildings 3k, **statics 6,081 meshes / 1.75M
tris**. Interior `cellsGroup` (1,201 meshes) stays visible. Round-trip restores the
outdoor case. **0 error-level console messages.**

## Owed
- 1070 pixel eye-test (SwiftShader here can't judge pixels/fps).
- Runtime spot-check at a *mouthed* dungeon / cottage interior (expect
  `hasOutdoorPortal=true`, terrain stays visible). Safe by construction but unverified
  at runtime.
- Follow-on residency win: statics/terrain are still **baked** (58 LBs resident on
  arrival) — the cull only stops the per-frame *draw*. Skipping the bake when sealed
  would also reclaim memory + the per-frame statics walk. Pairs with `indoorPvsRing`.

## Second bug (appended per request): water surface animation freezes — FIXED (`?waterScroll`)
Ruled OUT the registry hypothesis by live probe: `scene3d.terrainMaterials ===
liveScene3d.terrainMaterials` (same ref), all terrain materials registered, and `uTime`
advances 7.0 s over 8 real rAF frames (the earlier "frozen" read was a sub-frame sample
at SwiftShader ~1 fps). The real cause is in the shader: the water UV scroll
`waterCellUv = fract(cellUv + uTime*(.05,.02))` was **gated behind
`if (uDisplacementEnabled > 0.5)`** (terrain.js, was ~L1431), and `uDisplacementEnabled`
is 1.0 only at `subdivLevel ≥ 2`. `pickSubdivLevelForLb` (terrain.js:~2839) gives the LB
underfoot full subdiv but drops distance≥2 rings — and the whole batched ring — to
subdiv 1 (`disp=0`). So the scroll shared the vertex-displacement LOD gate even though a
per-pixel scroll needs no subdivided geometry → open water froze wherever `disp=0`
(measured `disp:0` on the ocean LB 0x0007 underfoot). Both the per-LB and batched paths
share this fragment source (terrain_batch string-adapts it and doesn't touch the gate).

**Fix:** decouple the scroll onto a dedicated `uWaterScrollEnabled` uniform (default
1.0), independent of subdiv. Vertex displacement (rise/fall) stays gated on
`uDisplacementEnabled` — it genuinely needs the verts. The per-corner `uWaterCodeMask`
test still restricts the scrolled UV to water corners (land unaffected). The uniform
propagates to the batched material via `_buildBatchMaterial`'s uniform clone.
`?waterScroll=off` sets it 0.0 (fully static). Files: terrain.js frag-shader gate +
`uWaterScrollEnabled` material uniform + `waterScrollEnabled` opts + `readWaterScrollFlag`.

**Validated (headless, Town Network ocean, live terrain.js — no wasm rebuild):** all 7
terrain materials carry the uniform (0 missing); all 7 water materials
`uWaterScrollEnabled=1` while `uDisplacementEnabled=0` — the exact previously-frozen case
now scrolls — uTime advancing; 0 GL/shader errors. Owed: 1070 pixel eye-test of the
actual motion. Minor follow-up: the water tint "breath" (`sin(uTime*0.3)`, vertex shader)
is still `uDisplacementEnabled`-gated, so it stays static at low subdiv — decouple it the
same way if it reads as inconsistent on the 1070.

## Artifacts
`pkg/` rebuilt to release with the new export (validated). `pkg-bak-preseal/` = the
pre-change release wasm (instant revert, since `pkg/` is gitignored). Both are build
artifacts safe to delete.
