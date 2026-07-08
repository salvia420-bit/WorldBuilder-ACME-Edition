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

## Separate open bug (appended per request): water surface animation freezes up close
The ocean surface "moving effect" (UV scroll `waterCellUv`, terrain.js:1432) and the
vertical rise/fall (uTime vertex displacement, terrain.js:~896) are both driven by the
per-frame `uTime` push in `loop.js tickTerrainUTime` (line 880), which iterates
`scene3d.terrainMaterials`. "Animates far, freezes close" ⇒ the near water LB's
material is missing from that registry. Prime suspects: (1) the eviction filter
**reassigns** the array — `landblock_lru.js:494 s.terrainMaterials =
s.terrainMaterials.filter(...)` — which can split producer/consumer references; (2) the
`scene3d` vs `window.liveScene3d` **dual-registry** push in `terrain_batch.js:406–414`;
(3) an LOD re-bake at higher subdivLevel producing a material that never re-registers.
Next step: teleport to open ocean, walk near, and check
`window.liveScene3d.terrainMaterials` membership + whether the near water material's
`uniforms.uTime.value` advances vs the batched material's.

## Artifacts
`pkg/` rebuilt to release with the new export (validated). `pkg-bak-preseal/` = the
pre-change release wasm (instant revert, since `pkg/` is gitignored). Both are build
artifacts safe to delete.
