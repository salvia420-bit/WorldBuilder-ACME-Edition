---
name: worldbuilder-terminal
description: Drive WorldBuilder.Terminal's JSON-stdin protocol to inspect, edit, validate, render, and export AC DAT/world data. Loads .wbproj files, edits terrain/objects/dungeons, runs validators, generates tile pyramids and static sites, ingests from ACE-DB. Use when a task touches Asheron's Call DAT contents, the world database, or render outputs.
---

# WorldBuilder.Terminal — JSON command guide

WorldBuilder.Terminal is a headless tool for inspecting and editing Asheron's Call DAT files (terrain, objects, dungeons, models, textures, weenies, spells, layouts) and the ACE world database. It exposes ~147 commands over a one-JSON-per-line stdin protocol. This skill is the catalog future agents need to pick the right command for the right job.

## Invocation

The terminal binary is built C# (.NET 8) and lives at:

```
WorldBuilder.Terminal/bin/Release/net8.0/WorldBuilder.Terminal.dll
```

Invoke the JSON loop with the local SDK:

```bash
export DOTNET_ROOT=/home/wbterminal/.dotnet
$DOTNET_ROOT/dotnet WorldBuilder.Terminal/bin/Release/net8.0/WorldBuilder.Terminal.dll --stdin
```

Then write one JSON object per line on stdin:

```json
{"command":"load","path":"/home/wbterminal/projects/RetailSmoke/RetailSmoke.wbproj"}
{"command":"validate-landblock","lbX":169,"lbY":180}
{"command":"quit"}
```

Every response is a single JSON line on stdout shaped `{"success":true|false,"command":"<name>", ...}`. On failure `"error":"..."` carries the message — always check it.

`--project <path>` on the CLI is equivalent to sending `load` first and additionally auto-restores ontology cache, building pairings, town/POI gazetteers, weenie index, and ACE-DB spawn records if those files are present alongside the `.wbproj`.

## Hex landblock IDs

Most commands take `lbX` and `lbY` as **integers 0–254**, not the packed `0xAABB` form. Holtburg = `lbX:169, lbY:180` (= `0xA9B4`). Convert any hex packed key with `lbX = (key >> 8) & 0xFF`, `lbY = key & 0xFF`.

## Recommended agent loop

Per `docs/agent_api_reference.md`:

1. **Always check `success`** before reading response fields.
2. **Mutate → `validate-all` → fix errors → repeat.** Never let a malformed delta reach `export`.
3. **After `remove-object`, re-query `list-objects`** — indices shift down by one.
4. **Retry transient errors** (file locks, DAT read failures) once before failing the loop.
5. **Validate touched LBs before `export`.**

Whenever the work is more than one mutation, prefer `transact` — it bundles ops, validates the staged delta atomically, and rolls back on any failure (commit-or-undo, never half-applied state). `transact-diff <txId>` then summarises the change as added/removed/moved objects, validation regressions, and an optional visual diff PNG.

## The three observation channels

Validation catches *symbolic* mistakes; these three commands catch the rest. The README frames them as the canonical post-mutation survey set:

- **`render-preview`** — visual. Top-down PNG of an N×N LB region; catches mode collapse, density drift, awkward placement that symbols can't see. Pass `useSprites:true` for the full-fidelity static-site renderer.
- **`describe-landblock`** — factual (the "Living Atlas"). Verbal block + structured fields composing ontology + region/town gazetteer + Acpedia POIs + LSD spawnMap. Identity is stored on docs; descriptions are derived fresh per call, so post-`transact` they're always current.
- **`compare-to-retail`** — statistical. Subprocesses `scripts/PopulationPipeline/Validation/compare_world_to_retail.py` to score a generated world vs a captured retail JSONL with per-LB drilldown.

## Validation diagnostic code families

When a validator fires, the diagnostic carries a four-character code. Recognise these prefixes:

| Prefix | Meaning |
|---|---|
| `DNG###` | Dungeon — broken portal links, orphaned cells, asymmetric portals, env refs, connectivity. |
| `LBK###` | Landblock — object bounds, Z clamping, zero-scale, degenerate quat, model existence (LBK010 = footprint flushness). |
| `TRN###` | Terrain — cliffs, edge stitching with adjacent LBs, flat / mono-type warnings. |
| `BSH###` | Building shells — group-Z divergence (BSH009), shell completeness; needs `building_pairings.json`. |
| `BLD###` | Building portals — outdoor exit, interior portal target validity, VisibleCells refs. |

Full code table with descriptions in `docs/agent_api_reference.md` § Validation Diagnostic Codes.

## Canonical references

- **`docs/agent_api_reference.md`** — 2 000-line schema-grade reference for protocol, every parameter, and every response field. Skim this when a command's args feel ambiguous from the help text.
- **`docs/agent_api_schema.json`** — machine-readable JSON schema for the same protocol.
- **`docs/terminal_repl_commands.md`** — REPL-side surface (the slightly different colored-prompt mode the agent doesn't normally use).
- **`README.md` § Headless Terminal & Agent API** — high-level framing of the agent loop and the observation channels. Note: the README's "63 documented / 140+ REPL" command counts are pre-2026-04 and now stale; the live `help` output has **131 documented + 16 unadvertised = 147**, which is what this skill reflects.

## Categorical command catalog

### Project lifecycle
| name | args | what it does |
|------|------|---|
| `load` | `path` | Load a `.wbproj`; auto-pulls ontology cache + pairings + gazetteers. |
| `info` | — | Project name, DAT paths, doc counts. |
| `export` | `directory, iteration?` | Write the in-memory portal/cell/local DAT mutations to a new iteration on disk. |
| `fresh-start` | `confirm` | Wipe terrain to deep sea + delete all dungeon documents. Requires `confirm:true`. |
| `open-log-folder` | — | Returns the active `--log-file` path so an agent can ingest it (no folder side-effects). |
| `quit` / `exit` | — | Drop the loop. |

### Terrain editing
| name | args | what it does |
|------|------|---|
| `raise` / `lower` / `set-height` | `x, y, radius, delta?` (or `height`) | Per-vertex height edits within a brush. |
| `smooth` | `x, y, radius, strength?` | Boxcar-smooth heights in a radius. |
| `paint` / `fill` | `x, y, radius, type` (or no radius for fill) | Set terrain texture index; `fill` flood-fills a same-type region. |
| `road` | `x1, y1, x2, y2, value?` | Draw a road texture along a segment. |
| `auto-paint` | — | Re-classify every vertex's terrain type from its height (post-edit cleanup). |
| `set-landblock-heightmap` | `lbX, lbY, heights` | Bulk overwrite all 81 vertices in one call. |
| `set-landblock-terrain` | `lbX, lbY, types` | Bulk overwrite the 81 terrain types in one call. |
| `paste-stamp` | `srcMin*, srcMax*, dest*, includeObjects?, blendEdges?, zOffset?` | Copy a rectangular region of terrain (and optionally its objects) elsewhere. |
| `import-heightmap` | `imagePath, startLbX, startLbY, lbCountX, lbCountY, apply?` | Import a greyscale-luminance + colormap PNG; `apply:false` previews. |
| `generate-terrain` | `seed, octaves?, lacunarity?, persistence?, amplitude?, coastline?` | Procedural noise terrain across the whole world. |

### Terrain inspection
| name | args | what it does |
|------|------|---|
| `get-height` | `x, y` | Single point height. |
| `get-heightmap` | `lbX, lbY` | Full 9×9 grid. |
| `get-terrain-data` | `lbX, lbY` | Vertices + textures + roads. |
| `get-bulk-heightmap` | `minX, minY, maxX, maxY` | Stitched heightmap across many LBs. |
| `terrain-info` | `lbX, lbY` | Summary stats per LB. |
| `get-terrain-layers` | `lbX, lbY` | Terrain-type histogram. |
| `diff-terrain` | `lbX, lbY` | Per-vertex delta from base DAT. |
| `extract-retail-heightmaps` | `outputPath?` | Dump all 255×255 heights as JSONL (slow). |
| `compute-vanilla-baseline` | `outputPath?` | Quality metrics (density, terrain dist) over retail. |

### Object placement
| name | args | what it does |
|------|------|---|
| `list-objects` | `lbX, lbY` | Enumerate `StaticObjects` for an LB. |
| `add-object` | `lbX, lbY, modelId, x, y, z, qw?, qx?, qy?, qz?, scale?` | Place a model with optional orientation + uniform scale. |
| `remove-object` | `lbX, lbY, index` | Index is into the LB's object list. |
| `clear-objects` | `lbX, lbY` or `all:true` | Strip one LB or the whole world. |
| `move-object` / `rotate-object` | `lbX, lbY, index, …` | Reposition or re-orient (absolute, not delta). |
| `query-radius` | `x, y, radius, z?, includeZ?` | World-space proximity query. |
| `bulk-place-objects` | `lbX, lbY, objects[]` | Many adds in one call (batched validation). |
| `get-object-detail` | `objectId` | Mesh + ontology metadata for a model id. |

### Placements (instance database — outdoor + dungeon)
| name | args | what it does |
|------|------|---|
| `placement-list` | `lbX?, lbY?, kind?` | Outdoor / dungeon instance placement list, filtered. |
| `placement-add-outdoor` | `lbX, lbY, wcid, originX/Y/Z, anglesW/X/Y/Z?, cellNumber?` | Append outdoor instance to project. |
| `placement-add-dungeon` | same shape | Append to the dungeon document. |
| `placement-remove` | `kind, index` | Remove by index in the per-kind list. |
| `placement-export-sql` | `out?, apply?` | Emit `landblock_instances.sql` + `dungeon_instances.sql`; `apply:true` runs against ACE-DB. |

### Dungeons (cells, portals, rendering)
| name | args | what it does |
|------|------|---|
| `get-dungeon-info` | `lbX, lbY` | Cell layout, portals, Z bands. |
| `extract-cell-footprints` | `force?, lbFilter?` | Pre-bake every dungeon cell's polygon + portal walls to JSONL — required by `render-dungeon`, auto-loaded on demand. |
| `describe-floor` | `lbX, lbY, floor?` | Z-banded floor metadata + verbal description. |
| `render-dungeon` | `lbX, lbY, floor?, resolution?, includePng?, outputPath?` | PNG of one floor (auto-extracts footprints if missing). |
| `generate-dungeon` | `lbX, lbY, depth?, branching?, seed?, minRooms?, maxRooms?, theme?` | Graph-grammar procgen dungeon. |
| `snap-portal` | `lbX, lbY, targetCellNumber, targetPortalPolyId, sourceEnvId, sourceCellStruct` | Connect a cell to an existing portal stub. |
| `analyze-dungeons` / `analyze-dungeon-catalog` / `analyze-dungeon-topology` | `outputPath?` | Wide-scan the world for dungeon stats; topology version emits the portal DAG. |

### Validation
| name | args | what it does |
|------|------|---|
| `validate-landblock` | `lbX, lbY` | Object bounds, scale, quaternion sanity, footprint flush vs terrain (LBK010 — needs ontology cache). |
| `validate-terrain` | `lbX, lbY, cliffThreshold?` | Cliff steepness + boundary stitching. |
| `validate-building-shells` | `lbX, lbY` | Shell completeness + group-Z spread (BSH009 fires when pairings are loaded). |
| `validate-building-portals` | `lbX, lbY` | Portal placement vs walls. |
| `validate-dungeon` | `lbX, lbY` | Cell connectivity, portal integrity, unreachable cells. |
| `validate-all` | `lbX, lbY, cliffThreshold?` | Run terrain + landblock + buildings + portals together. |
| `compare-render-corners` | `lbX, lbY, toleranceMetres?, includeAll?` | Footprint-corner diff between full-quaternion math (validator) and yaw-only rotation (emit-dynamic-site renderer). 0 failures means the LB is safe to ship through the top-down sprite pipeline. Sweep harness: `WorldBuilder.Terminal/compare_render_corners.cjs`. |

### Ontology (object classification index)
| name | args | what it does |
|------|------|---|
| `scan-ontology` | `scanGfxObjs?` | Heavy DAT walk; classifies every model. |
| `query-ontology` | `category?, scale?, keyword?, objectId?, limit?` | Search the live ontology. |
| `ontology-stats` | — | Category × scale histogram. |
| `cache-ontology` / `load-ontology-cache` | `outputPath?` / `inputPath?` | Persist & restore the ontology JSONL. |
| `enrich-ontology` | — | Pull schema names + creature families into entries. |
| `classify-ontology` | — | Auto-tag from StringTable name hits. |
| `enrich-materials` | — | Texture-analysis material tags. |
| `enrich-canonical` / `enrich-unified` | `path` | Merge external enrichment payloads. |
| `import-catalog` | `indexPath` | ACViewer catalog → ontology. |
| `export-ontology` | `outputPath` | Live ontology → CSV. |
| `export-setup-parts` / `export-classification-signals` | `outputPath` | Setup→Parts JSONL / building+scenery setup IDs. |
| `mine-strings` | `outputPath?, filter?` | Extract DAT StringTables. |

### Weenies (ACE world DB)
| name | args | what it does |
|------|------|---|
| `weenie-snapshot` | `classId, full?` | Read weenie identity + property counts (or full snapshot). |
| `weenie-save` | `classId, fromJson` | Replace all scalar properties for an existing class_Id (transactional). |
| `weenie-insert` | `className, fromJson` | Create a new weenie at next free class_Id ≥ 100000. |
| `weenie-delete` | `classId` | Drop weenie + all properties. |
| `weenie-list-property-keys` | `family` | Enumerate property names by family (`int`/`int64`/`bool`/`float`/`string`/`did`/`iid`). |
| `weenie-template-list` | `bundlePath` | Enumerate templates in a bundle. |
| `weenie-template-apply` | `bundlePath, templateId, classId` | Merge template scalars into an existing weenie. |
| `ingest-weenies` / `enrich-weenies` | `lsdPath, outputPath?` / `summaryPath` | Batch-extract from LSD then merge into ontology. |
| `ingest-recipes` | `lsdPath, outputPath?` | Batch-extract recipe data to a summary file (LSD bundle). |

### Spells
| name | args | what it does |
|------|------|---|
| `spell-list` | `limit?, source?` | Newest spell IDs from `dat` (default) or `db`; flags overlays. |
| `spell-get` | `id` | Project overlay wins, falls back to ACE-DB. |
| `spell-save` | `id, fromJson` | Project overlay; ACE-DB UPSERT if connected. |
| `spell-copy` | `fromId, newId?` | Clone (auto-allocates `max+1` if `newId` omitted). |
| `spell-delete` | `id` | Remove from overlay; ACE-DB DELETE if connected. |
| `ingest-spells` | `lsdPath, outputPath?` | Parse `spells.json` to summary file. |

### Layouts (LayoutDesc overlays)
| name | args | what it does |
|------|------|---|
| `layout-list` | `overlayOnly?` | All LayoutDesc IDs from DAT, or only the ones the project overlays. |
| `layout-get` | `layoutId` | Project overlay wins. |
| `layout-save` | `layoutId, fromJson` | Write to project overlay. |
| `layout-delete-overlay` | `layoutId` | Drop overlay; DAT untouched. |

### Creatures (visual overrides)
| name | args | what it does |
|------|------|---|
| `creature-get` | `objectId` | Texture-map + anim-part + palette overrides from ACE-DB. |
| `creature-save` | `objectId, fromJson?` | Replace texture-map + anim-part rows transactionally. |
| `creature-export-sql` | `objectId, out?` | Idempotent DELETE+INSERT SQL for the overrides. |

### ACE-DB ingestion
Pull live data from a connected ACE world database into JSON gazetteers/indexes the rest of the toolchain consumes.

| name | args | what it does |
|------|------|---|
| `ace-db-ingest-creatures` | `out?` | → `creature_gazetteer.json` |
| `ace-db-ingest-npcs` | `out?` | → `npc_gazetteer.json` |
| `ace-db-ingest-housing` | `out?` | → `housing_gazetteer.json` |
| `ace-db-ingest-spawns` | `out?` | All `landblock_instance` rows → `ace_spawn_records.jsonl` |
| `ace-db-ingest-weenie-index` | `out?` | wcid → identity → `weenie_index.jsonl` |
| `compare-creatures-to-retail` | — | Jaccard similarity of project spawn gazetteer vs ACE rosters. |
| `ingest-spawn-maps` | `lsdPath, outputPath?` | Spawn placements from LSD bundle. |

### Population & worldgen
| name | args | what it does |
|------|------|---|
| `worldgen` | `seed?, fullWorld?, startX?/Y?, width?, height?, continentCount?, islandCount?, landCoverage?, roughness?, townCount?, townSpacing?, generateRoads?, generateBuildings?, retailTownBuildingsOnly?, outputPath?, apply?` | Procedural world (terrain + towns + roads + buildings). `apply:false` produces a result JSON without mutating; `apply:true` writes to project. |
| `worldgen-analyze-buildings` | `outputPath?` | Classify generated buildings by interior + pairing. |
| `worldgen-scan-retail-towns` | `outputPath?` | Identity, bounds, paired status of every retail town building. |
| `generate-world` | `params?, apply?, exportTownsCsv?` | GUI-parity wrapper that resets docs, runs terrain → buildings → decorations, and optionally emits the towns CSV. |
| `export-towns-csv` | `fromResult, out` | Render the GUI's towns CSV from a worldgen result JSON. |
| `generate-settlement` | `template, centerX, centerY, seed?` | Constraint-based settlement from a template. |
| `apply-population` | `planPath, dryRun?` | Apply a population plan (spawn placements) world-wide. |
| `difficulty-gradient` | `gradientPath?` | Load + validate a difficulty gradient. |
| `analyze-landblock-patterns` | `minX?, minY?, maxX?, maxY?, outputPath?` | Spatial design patterns from populated LBs. |
| `extract-building-pairings` | `minCount5?, outputPath?` | Mine retail Structure×Structure adjacency at 5 m → `building_pairings.json` (drives group-aware placement). |
| `load-building-pairings` | `path` | Activate `building_pairings.json` in the live registry. |
| `scan-building-placements` | `outputPath?` | Building positions for culture mapping. |

### Render preview & tile pyramid
| name | args | what it does |
|------|------|---|
| `render-preview` | `lbX, lbY, radius?, resolution?, overlay?, includePng?, useSprites?, outputPath?` | Top-down PNG of an N×N LB region. `useSprites:true` consumes the C# atlas — same renderer emit-static-site uses. Returns base64 unless `includePng:false`. |
| `generate-object-sprites` | `force?, spritePx?, throttleMs?, lodLevel?, nightMode?, lbFilter?` | Bake the per-model sprite atlas (`atlas.png` + `manifest.jsonl`) used by `render-preview` and the pyramid. LOD + night-mode variants. |
| `emit-tile-pyramid` | `outDir, maxZoom?, minZoom?, dirtyOnly?, emitObject?, emitFloor?, throttleMs?` | Multi-zoom Leaflet tile tree (PNG/WebP). |
| `get-tile` | `zoom, lbX?, lbY?, region?, includeBase64?` | Pull a single tile from the pyramid (zoom: `lb` / `region` / `world`). |
| `tile-stats` | — | Cache totals, dirty count, disk vs budget. |
| `regenerate-dirty-tiles` | — | Rebuild every tile flagged dirty (transact-journal triggers this). |
| `list-dirty-tiles` / `mark-tiles-clean` | — | Diagnostic + force-clean. |
| `prune-tiles` | `keepNewest?, olderThan?` | LRU prune of LB tiles (region/world tiles pinned). |
| `generate-atlas-tiles` | `mode, lbList?` | Bulk gen — `mode:lbs|regions|world|all`. |

### Static-site emission
| name | args | what it does |
|------|------|---|
| `emit-static-site` | `projectSlug, outDir, maxZoom?, minZoom?, emitObject?, emitFloor?, throttleMs?, tileFormat?, gallery?` | Full Leaflet site (pyramid + index.html + optional curated gallery). |
| `emit-render-gallery` | `outDir, autoTowns?, autoZones?, autoDungeons?, autoRegions?, radius?, resolution?, useSprites?, overlay?, lbFilter?` | Curated 5+5+5+5 gallery (towns + creature zones + dungeons + region anchors), each entry a render-preview PNG + describe-landblock body, bundled into a Tailwind dir. |
| `serve-render-gallery` | `outDir, port?, bind?` | Simple HttpListener that serves a gallery (or any) directory; reports a Tailscale-reachable URL when one is available. |

### Living atlas / per-LB description
| name | args | what it does |
|------|------|---|
| `describe-landblock` | `lbX, lbY` | Verbal + structured per-LB summary (terrain + structures + spawns + POIs + validation). Composes ontology + region/town gazetteer + Acpedia + spawnMap. |
| `list-landblocks` | `minX?, minY?, maxX?, maxY?, limit?` | Enumerate LBs (filter by bounds). |
| `get-world-info` | — | World metadata. |
| `get-region` | — | Height table + terrain type palette. |

### DAT extension (textures, mesh I/O, BSP)
| name | args | what it does |
|------|------|---|
| `export-textures` | `outputDir, minId?, maxId?` | RenderSurface textures → PNG. |
| `import-texture` | `textureId, imagePath` | Replace a texture from a PNG. |
| `import-render-surface` | `imagePath, renderSurfaceId, ui?, name?` | PNG → RenderSurface (default registers in CustomTextureStore; `ui:true` is a deferred portal write). |
| `clone-dat` | `outputPath` | Snapshot the portal DAT to a new file. |
| `defragment-dat` | `datType, outputPath` | Rewrite portal/cell/local DAT compacted. |
| `obj-export` | `datId, outputPath` | GfxObj (`0x01…`) or Setup (`0x02…`) → Wavefront `.obj`. |
| `obj-import` | `objPath, surfaceDid, gfxObjId?, setupId?` | `.obj` → GfxObj+Setup; auto-allocates `0x01FF…` / `0x02FF…` IDs and rebuilds BSP. |
| `bsp-build` | `gfxObjId` | Rebuild Physics + Drawing BSP trees on a GfxObj (e.g. after manual mesh edits). |
| `environment-append-geometry` | `datPath, envIdHex, cellStructIndex, objPath, dryRun?` | Append OBJ render geometry to one CellStruct of an Environment (`0x0D…`) in a portal-DAT COPY — the dungeon-geometry lane. `usemtl surf<N>` = CELL-LOCAL surface index; physics polys, Portals and all BSPs carried verbatim (no rebuild). Run `tools/dat-patch/texture_lane.py fixup` after EVERY append run (a grown env record taints ~2k b-tree leaves). Refuses `~/ac_base_dats`. |
| `environment-clone` | `datPath, sourceIdHex, newIdHex, dryRun?` \| `clones[{sourceIdHex,newIdHex}]` | Clone an Environment record verbatim to a FREE id (`0x0D000000–0x0D00FFFF`) in a portal-DAT COPY — the variant lane's minting step. CellStructs/physics/portals/BSPs identical (byte-verbatim mod 2 align-padding bytes), so retargeted cells keep exact collision. Refuses existing ids and `~/ac_base_dats`. |
| `envcell-retarget` | `datPath, retargets[{cellIdHex,environmentIdHex,cellStructure?}]` \| `jsonlPath, portalPath?, dryRun?` | Batch-rewrite `EnvCell.EnvironmentId` (u16 in-place; zero growth) in a CELL-dat COPY — points texture-cluster cells at their relief variant. `environmentIdHex` = u16 or full `0x0D00XXXX`; `jsonlPath` = one retarget object per line for big batches. With `portalPath` each target env+cellstruct is validated incl. PosSurface bounds vs the cell's surface count (catches wrong-variant retargets). Returns counts + first 100 failures. Run the fixup on the CELL dat afterward too (retarget writes taint its leaves the same way). Refuses `~/ac_base_dats`. |

### Bulk export / training data
| name | args | what it does |
|------|------|---|
| `export-training-data` | `minX?, minY?, maxX?, maxY?, outputPath?, nearbyLimit?` | One JSONL row per object: terrain context + neighbours + ontology entry. |
| `export-raw-world-facts` | `minX?, minY?, maxX?, maxY?, outputPath?, includeAceDb?, includeLinks?` | Raw DAT + SQL + spawn facts as JSONL. |
| `export-envcell-components` | `minX?, minY?, maxX?, maxY?, outputPath?` | Linked surface-anchor + EnvCell components as JSONL. |

### Transactions
| name | args | what it does |
|------|------|---|
| `transact` | `ops[]` or `opsFile, rollback_on_fail?, validate?, diff?` | Stage N mutating ops, validate the staged delta, atomically commit or rollback. Allow-list: terrain edits, object placement, `generate-dungeon`. `validate:auto|all|none|{landblocks:[…]}`. `diff:true|"structured"|"visual"|"both"` inlines the `transact-diff` response. |
| `transact-diff` | `txId, render?, renderMode?, lbs?, resolution?, out?` | Structured before/after report for a committed tx. `renderMode:overlay|side-by-side|after-only-with-diff`. Returns `TXDIFF-EXPIRED` / `TXDIFF-ROLLED-BACK` if the snapshot is gone. |

### Comparison & metrics
| name | args | what it does |
|------|------|---|
| `compare-to-retail` | `generated, retailBaseline?, topK?, anomalyMinModel?, perLandblock?, cacheDir?` | Subprocesses `scripts/PopulationPipeline/Validation/compare_world_to_retail.py` to score a generated world vs a captured retail JSONL baseline. |
| `compare-creatures-to-retail` | — | Project spawn gazetteer Jaccard vs ACE creature/NPC/housing rosters. |
| `compute-vanilla-baseline` | `outputPath?` | Pre-compute the retail baseline metrics. |
| `benchmark` | — | Speed test (terrain ops, objects, validators, bulk). |

### Help / utility
| name | args | what it does |
|------|------|---|
| `help` | — | Returns the canonical command catalog (current truth — re-derive this skill from there if commands drift). |

## Recipes — multi-command workflows

### A. Validate a town's renderability for emit-dynamic-site
The renderer extracts only yaw from each placement quaternion. Confirm every building agrees with the validator's full-quaternion math.

```json
{"command":"load","path":"…/RetailSmoke.wbproj"}
{"command":"compare-render-corners","lbX":169,"lbY":180,"toleranceMetres":0.05}
```

For a sweep across a curated town list use the Node harness:

```bash
node WorldBuilder.Terminal/compare_render_corners.cjs \
    --project /home/wbterminal/projects/RetailSmoke/RetailSmoke.wbproj --towns
```

### B. Generate a wiki-quality top-down render of a town
```json
{"command":"load","path":"…/RetailSmoke.wbproj"}
{"command":"extract-cell-footprints"}
{"command":"generate-object-sprites","lodLevel":0}
{"command":"render-preview","lbX":169,"lbY":180,"resolution":2048,"useSprites":true,"overlay":false,"includePng":false,"outputPath":"/tmp/holt.png"}
```

### C. Publish a Leaflet static site
```json
{"command":"extract-cell-footprints"}
{"command":"generate-object-sprites"}
{"command":"emit-static-site","projectSlug":"my-shard","outDir":"/srv/site","maxZoom":12,"gallery":true}
{"command":"serve-render-gallery","outDir":"/srv/site","port":8765}
```

### D. Atomic edit with diff
```json
{"command":"transact","ops":[
  {"command":"move-object","lbX":169,"lbY":180,"index":7,"x":32540,"y":34700,"z":66},
  {"command":"rotate-object","lbX":169,"lbY":180,"index":7,"yaw":1.5708}
],"validate":"all","diff":"structured"}
```
The response carries the resulting `txId` and structured before/after; if anything failed, nothing was written.

### E. Custom mesh into the world
```json
{"command":"obj-import","objPath":"/in/tower.obj","surfaceDid":"0x05000001"}
{"command":"bsp-build","gfxObjId":"0x01FF0001"}
{"command":"add-object","lbX":169,"lbY":180,"modelId":"0x02FF0001","x":32530,"y":34690,"z":66,"yaw":0}
{"command":"export","directory":"/out/build-N"}
```

### F. Fresh procedural shard end-to-end
```json
{"command":"fresh-start","confirm":true}
{"command":"generate-terrain","seed":42,"octaves":6}
{"command":"worldgen","seed":42,"apply":true,"townCount":12,"generateRoads":true,"generateBuildings":true}
{"command":"apply-population","planPath":"/in/population_plan.json"}
{"command":"validate-all","lbX":169,"lbY":180}
```

### G. Move an LB through tile invalidation
After `transact` runs, tiles that overlap a mutated LB are flagged dirty.

```json
{"command":"list-dirty-tiles"}
{"command":"regenerate-dirty-tiles"}
{"command":"tile-stats"}
```

## Prerequisites & gotchas

- **Most commands require a loaded project.** `help`, `quit`, and `benchmark` are the only no-project commands. Pass `--project <path>` on the CLI or send `load` first.
- **Ontology cache.** `validate-landblock`'s footprint-flush check (LBK010) and `compare-render-corners` need ontology data. The `load` command auto-reads `<project>/ontology_cache.jsonl` if present; otherwise run `cache-ontology` once after `scan-ontology`.
- **Building pairings.** `validate-building-shells`'s BSH009 group-Z check needs `building_pairings.json`. `load` auto-restores it; otherwise run `extract-building-pairings` once and `load-building-pairings <path>`.
- **ACE-DB connection.** All `ace-db-ingest-*`, `weenie-save`/`insert`/`delete`, `spell-save`/`delete`, `creature-save`, `creature-export-sql`, and `placement-export-sql --apply` require a live `appsettings.json` `AceDatabase` section. Read-only `ingest-*` (LSD) commands do not.
- **Cell footprints cache.** `render-dungeon`, `compare-render-corners`, and `generate-object-sprites` benefit from `cell_footprints.jsonl` being warm. `extract-cell-footprints` builds it once; commands auto-extract on demand if missing but the cold path is slow.
- **Hex parsing.** `lbX` / `lbY` are decimal 0–254; some commands also accept `landblock` as a hex string (e.g. `"0xA9B4"`) — check the handler in doubt.
- **Output paths.** Everything that writes to disk takes an explicit `outputPath` / `outDir`. The terminal does not rewrite project state from a write command unless the description says so (e.g. `apply:true` on `worldgen`, `generate-world`, `import-heightmap`).
- **Throttling.** Heavy renderers (`generate-object-sprites`, `emit-tile-pyramid`, `emit-static-site`) accept `throttleMs` to drop process priority — useful when an ML training job is sharing the box.
- **Dispatch vs help.** 16 commands exist in the dispatch table but not in the published `help` output (`bsp-build`, `compare-render-corners`, `describe-floor`, `emit-static-site`, `emit-tile-pyramid`, `extract-cell-footprints`, `generate-object-sprites`, `obj-export`, `obj-import`, `render-dungeon`, `weenie-snapshot`, `weenie-template-apply`, `weenie-template-list`, `worldgen`, `worldgen-analyze-buildings`, `worldgen-scan-retail-towns`). They're stable; just unadvertised. This skill catalogs them in their proper categories above.

## Recipe — dungeon relief via environment variants (dat-patch lane 3 geometry)

The retail-dat patching lanes (docs/dat-patch/) drive these commands directly
with `--stdin` and NO project (datPath-taking commands: `chorizite-parse-dat-record`,
`render-surface-import`, `surface-texture-collapse`, `environment-append-geometry`,
`environment-clone`, `envcell-retarget`).
For MEANINGFUL dungeon relief the plan is the environment-VARIANT design —
full spec + sizing in `docs/dat-patch/HANDOFF-env-variant-design-2026-08-16.md`:

1. Python plans clusters per (env, cellstruct) over all 735k EnvCells
   (`tools/dat-patch/env_geo.py cluster` → `variant-build` → `variant-apply`)
   and builds per-cluster displaced shells.
2. `clone-dat` → copies; `environment-clone` → variant records;
   `environment-append-geometry` → shells; `envcell-retarget` → cluster cells
   point at their variant (batch via `jsonlPath`, validate via `portalPath`).
3. Validate with THIS skill's loop: `validate-dungeon` per touched landblock,
   `cell-portal-graph-sweep`, chorizite re-parses, then
   `tools/dat-patch/release.sh` (fixup is mandatory — env writes churn the
   b-tree hard) and the 1070 in-client gate.

## When to use this skill

- The user mentions Asheron's Call DAT files, ACE world server data, landblocks, weenies, retail rendering, or `emit-dynamic-site` / `emit-static-site`.
- The user is editing terrain, placing objects, validating buildings, generating tiles, or comparing world data to retail.
- The user references a `.wbproj` project file, the `dist/` site folder, the `ontology_cache.jsonl`, or `building_pairings.json`.
- A prior agent left a `transact` mid-flight (`txId` floating around) or pointed to one of the gazetteer JSONs.

If none of the above applies, defer to a more targeted skill or direct tool use.
