# DerethMapsEnhanced — render any WorldBuilder world as a deeply explorable static site

## Why this exists

Three observation channels exist in `WorldBuilder.Terminal` — `render-preview` (visual), `describe-landblock` (verbal), `compare-to-retail` (quantitative) — plus the `transact`/`transact-diff` action loop. They are powerful primitives, but the only consumers right now are agent processes piping JSON over stdin. Humans can't see what we've built; the community can't be shown why this technology is supposed to matter. While our AI-generated world is still maturing, the back-catalog of tools we have is already strictly more powerful than what the community uses today (e.g. `thwargle.com/derethMaps`).

`DerethMapsEnhanced` is the demonstration. It is a one-shot batch that renders any `.wbproj` project — vanilla AC by default (`projects/RetailSmoke`), any custom world later — into a self-contained static site that the user can drag-drop onto Google Drive, share a link, and have viewers double-click `index.html` and start exploring. It composes the entire WB.Terminal observation stack into a Leaflet-based map: world view at z=3, region at z=6, landblocks at z=9, individual objects rendered as their own top-down sprites at z=11, per-floor dungeon interiors with actual cell walls at z=12+. Hover any object → a verbal description, drawn from the Living Atlas, appears in a side panel.

The architectural payoff: this forces every pipeline to support full-world batch emission and a static deployment target. Once that exists, a future "live admin overlay" is purely additive — drop a `dynamic_players.js` next to the static dist and the existing frontend renders blinking dots. We are not designing for that now, but the file layout reserves the hook.

The framing isn't subtle. This is a wake-up call. Quality matters — every detail that is technically achievable should be achieved.

## Context — what exists in the repo

Read these before touching anything; the design assumes you understand what's already there.

### Backend (WB.Terminal)
- `WorldBuilder.Terminal/RenderPreviewRenderer.cs` — top-down PNG renderer over `(terrain dict, objects dict, ontology, pairings)`. Pure SkiaSharp. Already region-tile capable via `CommandEngine.RenderPreview`. Glyph dispatch helpers were exposed in the recent transact-diff work (`ResolveShapeForObject`, `ResolveSizePxForObject`, `DrawObjectGlyphInColor`, internal `GlyphShape` enum). **Reuse these; do not introduce a parallel glyph table.** The renderer is outdoor-only — it has no concept of dungeon interiors.
- `WorldBuilder.Terminal/LandblockDescriber.cs` — verbal + structured per-LB description: `ContextBlock`, `TerrainBlock`, `LandblockBody` (with `Structures`, `LooseObjectCount`, `Interior`, `NamedObjects`, `Spawns`). Already cell-Z-cluster-aware via `ClusterByZ` (`CellZBandGap = 2.0f`). Already does per-building `attributedCells` against dungeon docs. Per-cell footprint extraction is explicitly TODO (see comment around the `attributedCells` block).
- `WorldBuilder.Terminal/CommandEngine.cs` — atlas tile pipeline: `GetLbTile`, `GetRegionTile`, `GetWorldTile`, `OnTransactCommitted` (dirty propagation), `RegenerateDirtyTiles`. Tile cache lives at `projects/<name>/atlas_tiles/`. Has `Ontology`, `PairingsGroupKey`, `GetHeightTableForDiff()` accessors.
- `WorldBuilder.Terminal/JsonCommandProcessor.cs` — JSON dispatch. Existing related commands: `render-preview`, `describe-landblock`, `get-tile`, `tile-stats`, `regenerate-dirty-tiles`, `generate-atlas-tiles`. Mirror their wiring shape when adding new ones.
- `WorldBuilder.Shared/Documents/DungeonDocument.cs` — dungeon cells with `Origin`, `CellPortals` (with `OtherCellId`), `StaticObjects`. The cells' wall geometry lives in the DAT's `EnvCell` + `CellStruct` chain; reading it is part of this work.
- `WorldBuilder.Shared/Lib/...` — `IOntologyService.GetEntry(uint id)` returns `OntologyEntry { Category, Architecture, Scale, Name, BoundsMin, BoundsMax, FootprintCorners, Tags, WeenieClassId, ... }`. Bounds and footprints exist for many models thanks to the Unified enrichment.

### Reference frontend (do not copy verbatim — it shows the wrong shape)
- `external/DerethMaps/` — Thwargle's canvas-based map. **We are not extending this.** Worth reading once to understand the overlay categories the community expects (towns, housing, NPCs, mob overlays, dynamic players/landblocks/coords). Reuse their `coords.json`, `housing.json`, `npcs.txt` as **seed overlay data for the vanilla AC layer**; do not commit our overlays to depend on `external/`.

### Vanilla seed project
- `projects/RetailSmoke/` — full vanilla AC. DATs in `dats/`, `ontology_cache.jsonl` populated, `town_gazetteer.json`, `poi_gazetteer.json`, `spawn_gazetteer.json`, `region_gazetteer.json`, `wcid_acpedia_join.jsonl` all present. `atlas_tiles/` already partially populated. **This is the v1 seed render target.** The system must work for any other `.wbproj` too — do not hardcode "vanilla."

### Coordinates and constants
- 1 landblock = 192 world units, 8×8 cells, 9×9 vertices.
- World grid = 256 × 256 LBs (lbX × lbY, both `[0..255]`).
- World extent = 49,152 × 49,152 world units.
- LB hex format: `0xXXYY` where XX = lbX, YY = lbY.

## Intent

Add a one-shot batch command — `emit-static-site` — that produces a self-contained `dist/` folder consumable by a vanilla browser opening `index.html` directly from disk. The folder is the entire deliverable. The user drops it onto Google Drive, Cloudflare Pages, an S3 bucket, or their desktop; the experience is identical.

Inside the dist, viewers can:

1. **Switch projects** — vanilla AC is the default; any other rendered project shows up in a dropdown.
2. **Zoom from world to per-object** — five visual tiers (world, region, LB, object, floor) with the renderer auto-selecting the right detail at each zoom.
3. **Walk into dungeons** — any LB with a dungeon doc gets a floor selector (top-floor first by default, bottom floor at the end). The Pit and other vertical megadungeons render correctly because the partition is by interior cell Z-band, not by exterior model stories.
4. **Hover any object** — a side panel shows model id, ontology category, position, structure containment, and (when available) the Acpedia-matched description.
5. **Toggle overlays** — landblock grid, towns, housing, spawns, POIs, validation issues. Every overlay is a Leaflet layer that can be turned on/off.

## Objectives

1. Demonstrate that the WB stack can render a full AC-grade world to a static, deployable site at quality strictly higher than anything the community currently has.
2. Force every observation pipeline (`render-preview`, `describe-landblock`, `get-tile`) to support full-world batch emission and a static deployment target — the architecture pays forward for everything that comes after.
3. Be project-agnostic: the same command, run against any `.wbproj`, produces a viewable site. Vanilla AC is just the first project.
4. Reserve the hook for a future live-admin overlay without designing for it now: the frontend must support loading `dynamic_*.js` files if they are present alongside the static data, but must not require them.
5. Ship-quality visuals. Cell walls drawn from real DAT geometry. Per-object top-down sprites rendered from real model meshes. No placeholder dots, no abstract glyphs at the deepest zooms.

## Specs

### 1. Output structure — the `dist/` contract

The `emit-static-site` command produces this layout. Treat it as the system contract; downstream components (renderers, frontend) are validated by writing/reading these files.

```
dist/
├── index.html                          # Leaflet app entry
├── app.js                              # Leaflet app, ~ES6, no build step required
├── app.css
├── leaflet/                            # Leaflet 1.9.x bundled (vendored, not CDN)
│   ├── leaflet.js
│   └── leaflet.css
├── manifest.js                         # const MANIFEST = { ... }; — top-level index
└── projects/
    └── <project-slug>/
        ├── meta.js                     # const PROJECT_<slug> = { lbList, dungeonLbs, floorCounts, ... };
        ├── tiles/
        │   ├── exterior/
        │   │   ├── 3/0/0.png           # z/x/y standard Leaflet
        │   │   ├── 4/0/0.png
        │   │   └── ...
        │   ├── object/
        │   │   ├── 11/x/y.png          # z=11+ tier with full per-object sprites
        │   │   └── 12/x/y.png
        │   └── floor/
        │       └── <lbHex>/
        │           ├── 12/0/0/<floor>.png   # one per floor at deep zoom
        │           └── 13/...
        ├── sprites/
        │   ├── atlas.png               # combined sprite sheet
        │   └── atlas.js                # const SPRITE_ATLAS = { "0x02000abc": {x, y, w, h, worldBounds:[wx,wy]}, ... }
        ├── desc/
        │   └── <lbHex>.js              # LOAD_DESC('<lbHex>', { context, terrain, body, ... })
        ├── dungeons/
        │   └── <lbHex>.js              # LOAD_DUNGEON('<lbHex>', { cells:[{id, footprint:[[x,y],...], floor, portals, objects}], floorPartition })
        ├── overlays/
        │   ├── towns.js                # LOAD_OVERLAY('towns', [...])
        │   ├── housing.js
        │   ├── spawns.js
        │   ├── pois.js
        │   └── grid.js
        └── README.txt                  # one-paragraph "what this is, how to view"
```

**Why `.js` not `.json`:** Browsers refuse `fetch()` from `file://` origins under default settings. Loading data as JSONP-style scripts (`var MANIFEST = {...}` or `LOAD_DESC(hex, body)`) works from `file://` without flags. The frontend uses a small dynamic-`<script>`-tag loader. Tiles are PNGs accessed via `<img>` which works from `file://` regardless.

### 2. Cell footprint extraction

**New file:** `WorldBuilder.Terminal/CellFootprintExtractor.cs` (pure logic).
**New command:** `extract-cell-footprints` (REPL + JSON; one-shot batch).

For every `EnvCell` referenced by any loaded dungeon's `Cells`, walk into the DAT's `CellStruct` chain, project the cell's wall vertices to the XY plane, and extract a 2D wall polygon (concave hull is fine; degenerate cells get a synthetic AABB from bounds). Cache to `projects/<name>/cell_footprints.jsonl`, one line per cell:

```jsonc
{
  "cellId": "0x12340100",
  "envCellId": "0x01230456",
  "polygon": [[x,y], [x,y], ...],   // local cell coords, world-aligned
  "zRange": [zMin, zMax],
  "portals": [{"toCellId": "0x12340101", "wallSpan": [[x,y],[x,y]]}, ...]
}
```

**Hard constraint:** if the EnvCell can't be resolved (missing DAT entry), emit a synthetic axis-aligned box from the cell's existing `Origin` + a fallback bounds estimate; do **not** skip the cell. Log a warning. Frontend always has *something* to draw.

**Reuse, don't invent:** the existing `FootprintExtractor` (in `WorldBuilder.Shared.Lib.Geometry`) handles building footprints from `Setup`/`GfxObj`. The cell case is similar but one layer deeper into the DAT; mine for shared helpers before writing new ones.

**Acceptance:** running against `RetailSmoke`, the cache contains an entry for every cell ID enumerated by every dungeon doc. No cell is missing. Spot-check by overlaying polygons against `render-preview` output for a known dungeon (e.g. Holtburg's interiors).

### 3. Object sprite generator

**New file:** `WorldBuilder.Terminal/ObjectSpriteGenerator.cs`.
**New command:** `generate-object-sprites` (REPL + JSON; one-shot batch).

For every model id (`Setup` 0x02xxxxxx + standalone `GfxObj` 0x01xxxxxx) that appears anywhere in the project's loaded landblock or dungeon documents, render a top-down orthographic PNG sprite. Output to `projects/<name>/sprites/<modelHex>.png` plus `projects/<name>/sprites/manifest.jsonl`.

**Sprite rendering spec — get this right, it's where the visual quality lives:**

- **Source geometry:** walk the model's vertex array (Setup → Parts → GfxObj.VertexArray, or direct GfxObj). Project to XY plane. Build a triangle list with per-vertex Z preserved for shading.
- **Render at 512px per longest world dimension.** A model whose XY bounds are 3m × 5m renders to a 308×512 PNG (3/5 × 512 = 308). A model whose XY bounds are 50m × 50m renders to 512×512. This is "high uniform fidelity per object" — every sprite is the same level of detail per pixel of model surface.
- **Lighting model:** orthographic top-down with a simulated sun at azimuth 135°, elevation 60° (matches `render-preview`'s hillshade convention). Faces lit by their normal × sun direction; back-faces culled. Albedo from the model's surface texture if available, fall back to ontology category color (reuse `RenderPreviewRenderer`'s palette via `ResolveGlyph`).
- **Drop shadow:** soft alpha-blurred shadow offset 4px down-right from the model silhouette. This is what makes sprites pop against the terrain when composited at deep zoom.
- **Anti-aliasing:** SkiaSharp default high-quality.
- **Transparent background.** Manifest stores `worldBounds: [worldWidthM, worldHeightM]` — frontend uses these to scale sprite to its true world footprint at any zoom.

**Sprite atlas:** after rendering all sprites, pack them into a single `atlas.png` (skyline packing or simple shelf packing) plus an `atlas.js` (`const SPRITE_ATLAS = { "0x02000abc": {x:0, y:0, w:308, h:512, worldBounds:[3.0, 5.0]}, ... }`). Atlas files are emitted alongside individual PNGs — keep both. Atlas for runtime efficiency, individual PNGs for inspection/debugging.

**Acceptance:** sprite manifest covers every model id placed in `RetailSmoke`. A spot-check of 5 hand-picked models (a building, a furniture piece, a tree, a creature, a portal) loaded standalone shows recognizable top-down silhouettes.

### 4. `render-dungeon` — per-floor interior renderer

**New file:** `WorldBuilder.Terminal/DungeonRenderer.cs`.
**New command:** `render-dungeon` (REPL + JSON).

Wire form:
```jsonc
{"command": "render-dungeon", "lbX": 169, "lbY": 180, "floor": 0, "resolution": 1024, "out": null}
```

- `floor` (default `null` = all floors as a stacked PNG):
  - Integer index 0..N where 0 = bottom floor (deepest Z-band), N = top.
  - The floor partition is the cell Z-band clustering produced by the existing `LandblockDescriber.ClusterByZ` over `dungeonDoc.Cells.Origin.Z`. Reuse that exact partition; do not invent a parallel.
- Output: square PNG of just that floor's cells, drawn from `cell_footprints.jsonl`:
  - **Cell walls:** stroke the polygon edges; thin neutral-stroke between cells, thick darker stroke on exterior boundary edges (cell edges that don't share a portal with another cell on the same floor).
  - **Cell interior fill:** soft per-cell color (low-saturation, slight per-cell hue variation so adjacent cells are visually distinguishable).
  - **Portals:** drawn as gaps in walls (interior portal between same-floor cells) or as colored markers (exterior portal pointing outside this dungeon, e.g. entry/exit; staircase portal pointing to another floor).
  - **Cell-resident static objects:** rendered as sprites (atlas lookup) at world position, scaled to true world footprint.
  - **LB-doc loose objects** whose Z falls within this floor's band AND whose XY falls within any cell footprint: also rendered as sprites.
  - **Z-stratified labelling:** small "Floor N" label in the top-left corner with floor's Z range.

**Vertical megadungeon support:** the Pit, Halls of Helm — partitioning by Z-band gives one image per playable level. Inter-floor portals (the central shaft) draw as differently-colored markers so the eye sees how levels connect.

**Acceptance:** running against Holtburg's town hall (a multi-floor playable building) produces 2-3 PNGs that visually match what a player remembers from in-game. Running against the Pit produces 8-10 PNGs corresponding to its known levels, with the central shaft visible as cross-floor portal markers.

### 5. `render-preview` sprite mode + zoom-tier awareness

Extend, do not duplicate.

Add to `RenderPreviewRenderer.Input`:
- `bool UseSprites` (default false) — when true, replace category-glyph dispatch with sprite lookups for every placed object.
- `Func<uint, SpriteInfo?>? Sprites` — called per object id, returns `(spriteAtlasPng, x, y, w, h, worldBounds)` from the sprite manifest (or null → fall back to glyph).

When `UseSprites = true`:
- Each object draws as `(worldBounds × pixels-per-world-unit-at-this-zoom)` pixels, sourced from the atlas region. Sprite scale is *world-true*: a 5m-wide table draws as `5 * pxPerWorldUnit` pixels regardless of zoom.
- Below 4 px per object world-largest-dim, fall back to glyph (sprite would be unreadable).
- Z-priority unchanged from existing dispatch (Structure on top).

**Zoom-tier awareness** is a property of the tile-pyramid emitter (next section), not the renderer itself. Renderer takes `UseSprites` from caller.

### 6. Tile-pyramid emitter

**New file:** `WorldBuilder.Terminal/TilePyramidEmitter.cs`.
**New command:** `emit-tile-pyramid --project <name> --out <dir>` (REPL + JSON).

Standard Leaflet z/x/y output. Tile size 256×256.

| Zoom | Tile contents | Renderer |
|------|--------------|----------|
| 3 | full world ÷ 8×8 = 64 tiles | terrain only, scenery omitted |
| 4 | 16×16 = 256 tiles | terrain only |
| 5 | 32×32 = 1024 tiles | terrain + structure footprints |
| 6 | 64×64 = 4096 tiles | terrain + structure footprints |
| 7 | 128×128 | terrain + structures + glyph dispatch (current `render-preview`) |
| 8 | 256×256 = 65536, exactly 1 LB per tile | terrain + structures + glyph |
| 9 | 512×512 (1 tile = 96 world units) | terrain + structures + glyph |
| 10 | 1024×1024 (1 tile = 48 world units) | terrain + structures + glyph |
| 11 | 2048×2048 | terrain + structures + **per-object sprites** |
| 12 | 4096×4096 | sprites at full per-pixel-world-unit fidelity |
| 13+ | floor tiles for dungeon LBs only | `render-dungeon` output |

**Implementation notes:**
- Lower zoom levels can be downsampled from higher; do **not** re-render. Render at z=12 (and z=13+ floor tiles), build z=11..3 by 2×2 average-downsample.
- Tile generation is parallel by tile coordinate. Use `Parallel.ForEach` over the tile coordinate space at z=12; downsample serially.
- Empty tiles (over ocean, no terrain) emit as a tiny solid-color PNG, still placed at the right path so Leaflet's 404 handling stays clean. (Or: emit nothing, frontend tile layer config handles 404s. Pick one and stick with it.)
- `--dirty-only` flag uses the existing dirty-LB tracking from `OnTransactCommitted` so re-renders after edits are incremental.

**Acceptance:** running `emit-tile-pyramid --project RetailSmoke --out dist/projects/RetailSmoke/tiles/` populates the full pyramid. Wall-clock target: **under 3 hours on this VM** (the user has GPU/CPU freed up after their ML run; render-preview is CPU-only via SkiaSharp, so this is a parallelism target).

### 7. Per-floor describer

Extend `LandblockDescriber`. New entry point:

```csharp
public static FloorDescriptionResult DescribeFloor(
    ushort lbKey, int floorIndex,
    LandblockDocument lbDoc, TerrainDocument terrainDoc, DungeonDocument dungeonDoc,
    IOntologyService ontology, ...);
```

Returns a record similar to `LandblockDescriptionResult` but scoped to one floor: cells on this floor, loose objects within this floor's Z band, named objects on this floor, a verbal paragraph specific to the floor ("Holtburg Town Hall, second floor: a single oblong chamber, 4 cells, contains a lectern with parchment, 3 chairs flanking the east wall, a fireplace on the south wall.").

**The floor partition is computed from `ClusterByZ(dungeonDoc.Cells.Origin.Z)`. Reuse the existing function; do not parallel-implement.**

Floor descriptions are emitted to `dist/projects/<name>/dungeons/<lbHex>.js` as part of the static-site batch.

### 8. `emit-static-site` — the orchestrator

**New file:** `WorldBuilder.Terminal/StaticSiteEmitter.cs`.
**New command:** `emit-static-site --project <name> --out <dir>` (REPL + JSON).

This is the user-facing entry point. It composes everything:

1. Ensure cell footprints are extracted (`extract-cell-footprints` if not cached).
2. Ensure object sprites are generated (`generate-object-sprites` if not cached).
3. Emit tile pyramid for the project (`emit-tile-pyramid --dirty-only` if cache exists).
4. Emit per-LB descriptions (`describe-landblock` for every populated LB → `<lbHex>.js`).
5. Emit per-LB dungeon graphs (combine `cell_footprints.jsonl` + `DescribeFloor` per floor → `<lbHex>.js`).
6. Emit overlays (towns, housing, spawns, POIs, grid) from the project's gazetteers as `LOAD_OVERLAY('name', [...])` files.
7. Copy the frontend bundle (`dist/index.html`, `dist/app.js`, `dist/app.css`, `dist/leaflet/`) — these are static assets shipped with the source code at `WorldBuilder.Terminal/StaticSite/`.
8. Emit `manifest.js` with: protocol version, list of available projects (the command may have been run multiple times into the same `dist/`), default project, build timestamp, total tile counts.
9. Emit `dist/projects/<name>/README.txt` — a one-paragraph "this is X, to view, double-click index.html or run `python -m http.server` in this folder."

**Multi-project support:** running `emit-static-site` against project A then against project B writes both into the same `dist/projects/`, updates `manifest.js` to include both, and the frontend's project switcher shows both. **Do not nuke existing project data on each run.**

**Wall-clock acceptance:** full first run for `RetailSmoke` from a cold cache should complete in **under 6 hours**. Subsequent runs after a small `transact` should complete in **under 2 minutes** (incremental via dirty tracking).

### 9. Frontend — Leaflet app at `WorldBuilder.Terminal/StaticSite/`

A small ES6 application; no build step, no npm. Vendored Leaflet 1.9.x.

**Required behaviors:**
1. **Project switcher** — dropdown at top, repopulates the map when changed.
2. **Five-tier Leaflet `L.tileLayer`** wired to the exterior tile pyramid. CRS = `L.CRS.Simple`; world bounds = `[[0, 0], [49152, 49152]]`. Tile coordinate transform from world coords is the inverse of the emitter's.
3. **Object zoom (z=11+):** auto-switches to the `object/` tile layer (with sprites) when zoom passes 11. Lower zooms use `exterior/` (glyph or footprint).
4. **Floor selector:** a docked control on the left. Hidden when no LB under the cursor (or center-of-view) has a dungeon. When a dungeon LB is in view at z≥10, a vertical strip of floor buttons appears (top-floor at top, bottom-floor at bottom — matching how a player thinks about the building). Selecting a floor switches the active tile layer to `floor/<lbHex>/<z>/<x>/<y>/<floor>.png`. The exterior tile fades to 30% opacity behind the floor tiles for context.
5. **Hover/click describe panel:** a docked panel on the right. On hover over an object glyph or sprite, fetch (via `<script>`-tag injection) the `desc/<lbHex>.js` for the LB under the cursor, find the object by index (resolved from a small per-LB "what's at pixel (x,y)" lookup table emitted in `meta.js`), display its model id, ontology category, position, structure/floor containment, and Acpedia description if any.
6. **Overlay toggles:** Leaflet `L.control.layers` panel with checkboxes for towns, housing, spawns, POIs, landblock grid, validation diagnostics. Each overlay loads from `overlays/<name>.js`.
7. **URL deep-linking:** `?project=RetailSmoke&z=12&x=169&y=180&floor=2` deep-links to a specific zoom/LB/floor and the frontend restores that view on load.
8. **Live overlay hook (forward-compatible, do not implement):** at boot, the frontend `<script>`-loads `overlays/dynamic_players.js` if present; if it is, render the overlay; if not, silently no-op. **The file does not exist in v1.** This is the seam for the future live-admin overlay.

**Visual quality target:** the map must look better at zoom 12 than `derethMaps.html` does at any zoom. That is the demo bar.

### 10. Vanilla AC seed render

After all of the above lands and tests pass, run `emit-static-site --project RetailSmoke --out /home/salvia420/dist/`. Verify:
- All five zoom tiers render correctly.
- A known multi-floor building (Holtburg Town Hall) supports per-floor exploration.
- The Pit's floor selector shows ~9 levels and the central shaft is visible.
- Hovering objects produces the right side-panel content.
- Overlay toggles work.
- The site loads from `file://` (double-click `index.html` from a file manager).

## Non-goals — do not do these

- **Live polling, SQL connections, or any runtime backend.** The dist is static. The future live overlay is a separate project; this one only reserves the file-naming hook for it.
- **A build step (npm, webpack, vite, esbuild).** The frontend is plain ES6 + vendored Leaflet. The user must be able to inspect `app.js` directly without a sourcemap.
- **Replacing `render-preview` with sprite-only.** The glyph dispatch is correct at intermediate zooms; sprite rendering is purely a deeper-zoom enhancement.
- **Inventing parallel data formats.** Reuse the describer's body schema, the ontology entry shape, the existing tile cache layout. Where the describer says `Structures: List<StructureBlock>`, the per-LB description JS file's `body.structures` field is the same shape.
- **A new ontology category, glyph, or validation code.** This work is purely about exposing existing data more beautifully.
- **Optimising the tile pyramid for delta updates beyond the existing dirty-LB tracking.** `--dirty-only` reuses what's there; if it's slow, fix it in a follow-up.
- **Persisting cell footprints or sprites in the project SQLite DB.** They're caches; live in the project directory as `.jsonl` and `.png`. Re-derivable from the DAT.
- **Caring about Cloudflare Pages file caps or any specific hosting target.** The user's hosting is their problem; ours is producing a folder that works when served from any HTTP origin including `file://`.
- **Comments explaining what code does.** Only `// Why:` comments where the reasoning is non-obvious (e.g. "we render at z=12 and downsample because re-rendering each zoom would be 4× the cost for identical output").

## Acceptance criteria

1. All pre-existing tests pass unchanged.
2. New tests in `tests/test_agent_protocol.py` cover:
   - `extract-cell-footprints` produces a non-empty cache against `RetailSmoke` containing entries for every cell ID enumerated by every dungeon doc.
   - `generate-object-sprites` produces an atlas covering every model id placed in `RetailSmoke`.
   - `render-dungeon` for a known multi-floor LB returns a non-empty PNG with reasonable dimensions.
   - `emit-static-site` against `RetailSmoke` writes the expected dist/ structure (manifest, tile-pyramid root, sprites, desc, dungeons, overlays, frontend bundle) and the manifest references every populated LB.
3. Visual smoke test (manual, documented in the PR): screenshots at world zoom, region zoom, LB zoom, object zoom, and floor zoom for both Holtburg and the Pit, demonstrating the zoom tier transitions and floor selector behavior.
4. The dist folder loads correctly when opened via `file://index.html` in Chrome and Firefox. No fetch errors, no missing tiles for in-bounds zooms.
5. README at the repo root gains a "DerethMapsEnhanced" subsection (~30 lines) describing the command and the demo URL convention. `docs/agent_api_reference.md` and `docs/agent_api_schema.json` gain entries for `extract-cell-footprints`, `generate-object-sprites`, `render-dungeon`, `emit-tile-pyramid`, `emit-static-site`.
6. Wall-clock target met: full cold render for `RetailSmoke` under 6 hours; incremental re-render after a single-LB transact under 2 minutes.

## Style notes

- Match the verbosity and tone of `compare-to-retail`'s and `transact`'s commit/README sections.
- Prefer extending existing files over creating new ones; the clearly new files are listed in each spec section. The frontend bundle (`StaticSite/`) is its own subdirectory.
- No try/catch wrappers around code that can't throw. Trust internal invariants. Validate at the dispatch surface only.
- No defensive null checks against arguments the dispatch surface already validates.
- Match conventions: snake_case for JSON keys, camelCase for emitted JS (`LOAD_DESC` is a function name; arguments are camelCase), PascalCase for C#.
- No emoji in code or generated files.

## Recommended phasing

This is large enough that it must be phased. Suggested decomposition (matches the order dependencies dictate):

- **Phase 1 — extraction foundation** (parallelizable internally): cell footprint extractor + object sprite generator + their tests + their CLI commands.
- **Phase 2 — renderer extensions:** `render-dungeon`, `render-preview` sprite mode, both wired into `CommandEngine`. Tests.
- **Phase 3 — pyramid & describer extension:** `emit-tile-pyramid` (depends on Phase 2), per-floor describer extension. Tests.
- **Phase 4 — orchestrator:** `emit-static-site`. Just wires everything. Tests for the dist-shape contract.
- **Phase 5 — frontend:** Leaflet app at `WorldBuilder.Terminal/StaticSite/`. Manual visual testing.
- **Phase 6 — vanilla seed run + docs:** First full `RetailSmoke` render. README + agent_api_reference.md + agent_api_schema.json updates. Screenshots.

Each phase is reviewable in isolation. Phase 1 and 5 can run concurrently if you have parallel implementer capacity.

---

Two notes on using this prompt:

- The prompt assumes the receiving agent reads the files in the **Context** section before writing code. If you hand it to a smaller model, prepend "Read every file listed under Context before drafting any plan."
- The frontend section (objective 9) is the part most likely to drift toward "let's just inline everything in one giant `index.html`." If the receiving agent goes that direction, redirect them to the JSONP-style file-loading pattern in section 1 — `file://` viability is non-negotiable and is what makes the architecture portable.
