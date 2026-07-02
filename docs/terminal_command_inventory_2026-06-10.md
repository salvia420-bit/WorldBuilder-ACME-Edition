# WorldBuilder.Terminal — Command Inventory (source-derived)

**Generated:** 2026-06-10 · **Source of truth:** `WorldBuilder.Terminal/JsonCommandProcessor.cs` `BuildCommandHandlers()` (lines 152–377), repo @ `40c26009`.

**Counts:** 203 dispatch-table commands + `quit`/`exit` (special-cased at JsonCommandProcessor.cs:136) = **205 callable names**. `help` advertises 152 of the 203 (+ `quit`); **51 are unadvertised** (marked ✗ below). The worldbuilder-terminal skill catalog (165) is stale — it predates the chorizite/diag/motion/physics/wave4/parity families being counted.

Columns: **Adv** = listed in `help` output; **Dispatch** = registration line in JsonCommandProcessor.cs; **Handler** = wrapper invoked (root of the call chain to audit). Args/description are verbatim from the `help` metadata where advertised.

## Project lifecycle

| Command | Args | Adv | Dispatch | Handler | Description |
|---|---|---|---|---|---|
| `load` | `path` | ✓ | :153 | `CmdLoad` | Load a .wbproj project |
| `export` | `directory, iteration?` | ✓ | :154 | `CmdExport` | Export DATs |
| `info` | `` | ✓ | :155 | `_ => CmdInfo()` | Show project info |
| `fresh-start` | `confirm` | ✓ | :259 | `CmdFreshStart` | Wipes all terrain to deep sea + deletes all dungeon documents (requires confirm:true) |
| `open-log-folder` | `` | ✓ | :234 | `_ => CmdOpenLogFolder()` | Returns the active --log-file path so the agent can ingest it (no folder-opening side effects) |
| `help` | `` | ✗ | :376 | `_ => CmdHelp()` |  |
| `benchmark` | `` | ✓ | :229 | `_ => CmdBenchmark()` | Run speed test suite (terrain, objects, validation, bulk) |
| `quit` / `exit` | — | ✓ | :136 (special-case) | inline | Exit the JSON loop. |

## Terrain editing

| Command | Args | Adv | Dispatch | Handler | Description |
|---|---|---|---|---|---|
| `raise` | `x, y, radius, delta?` | ✓ | :157 | `CmdRaise` | Raise terrain |
| `lower` | `x, y, radius, delta?` | ✓ | :158 | `CmdLower` | Lower terrain |
| `set-height` | `x, y, radius, height` | ✓ | :159 | `CmdSetHeight` | Set terrain height |
| `smooth` | `x, y, radius, strength?` | ✓ | :156 | `CmdSmooth` | Smooth terrain |
| `paint` | `x, y, radius, type` | ✓ | :160 | `CmdPaint` | Paint terrain texture |
| `fill` | `x, y, type` | ✓ | :161 | `CmdFill` | Flood-fill terrain |
| `road` | `x1, y1, x2, y2, value?` | ✓ | :162 | `CmdRoad` | Draw road path |
| `auto-paint` | `` | ✓ | :265 | `_ => CmdAutoPaint()` | Re-paint all terrain types from heightmap |
| `set-landblock-heightmap` | `lbX, lbY, heights` | ✓ | :230 | `CmdSetLandblockHeightmap` | Set all 81 heights in one call |
| `set-landblock-terrain` | `lbX, lbY, types` | ✓ | :231 | `CmdSetLandblockTerrain` | Set all 81 terrain types in one call |
| `paste-stamp` | `srcMinX, srcMinY, srcMaxX, srcMaxY, destX, destY, includeObjects?, blendEdges?, zOffset?` | ✓ | :193 | `CmdPasteStamp` | Copy & paste terrain |
| `import-heightmap` | `imagePath, startLbX, startLbY, lbCountX, lbCountY, apply?` | ✓ | :232 | `CmdImportHeightmap` | Import grayscale+colormap PNG; height from luminance, type from nearest texture color |
| `generate-terrain` | `seed, octaves?, lacunarity?, persistence?, amplitude?, coastline?` | ✓ | :263 | `CmdGenerateTerrain` | Generate full-world procedural terrain |
| `bulk-paint-replace` | `lbList\|minLbX..maxLbY, fromType?, toType` | ✓ | :372 | `CmdBulkPaintReplace` | Bulk terrain-type substitution across many LBs (melt bucket-fill): replace fromType with toType, or repaint all 81 vertices when fromType omitted. |

## Terrain inspection

| Command | Args | Adv | Dispatch | Handler | Description |
|---|---|---|---|---|---|
| `get-height` | `x, y` | ✓ | :163 | `CmdGetHeight` | Query terrain height at point |
| `get-heightmap` | `lbX, lbY` | ✓ | :165 | `CmdGetHeightmap` | Full 9×9 heightmap grid |
| `get-terrain-data` | `lbX, lbY` | ✓ | :166 | `CmdGetTerrainData` | All vertex data |
| `get-bulk-heightmap` | `minX, minY, maxX, maxY` | ✓ | :195 | `CmdGetBulkHeightmap` | Multi-landblock heightmaps in one call |
| `terrain-info` | `lbX, lbY` | ✓ | :164 | `CmdTerrainInfo` | Landblock statistics |
| `get-terrain-layers` | `lbX, lbY` | ✓ | :198 | `CmdGetTerrainLayers` | Terrain type distribution per landblock |
| `diff-terrain` | `lbX, lbY` | ✓ | :197 | `CmdDiffTerrain` | Compare current terrain vs base DAT |
| `extract-retail-heightmaps` | `outputPath?` | ✓ | :273 | `CmdExtractRetailHeightmaps` | Dump all 255×255 landblock heightmaps as JSONL |
| `compute-vanilla-baseline` | `outputPath?` | ✓ | :274 | `CmdComputeVanillaBaseline` | Compute retail quality baseline metrics (density, terrain dist, etc.) |

## Object placement

| Command | Args | Adv | Dispatch | Handler | Description |
|---|---|---|---|---|---|
| `list-objects` | `lbX, lbY` | ✓ | :167 | `CmdListObjects` | List static objects |
| `add-object` | `lbX, lbY, modelId, x, y, z, qw?, qx?, qy?, qz?, scale?` | ✓ | :170 | `CmdAddObject` | Place object |
| `remove-object` | `lbX, lbY, index` | ✓ | :171 | `CmdRemoveObject` | Remove object by index |
| `clear-objects` | `lbX, lbY \| all=true` | ✓ | :172 | `CmdClearObjects` | Clear all objects from one landblock or whole world |
| `move-object` | `lbX, lbY, index, x, y, z` | ✓ | :173 | `CmdMoveObject` | Move object |
| `rotate-object` | `lbX, lbY, index, qw/qx/qy/qz \| yaw` | ✓ | :174 | `CmdRotateObject` | Set object orientation (absolute, not incremental) |
| `query-radius` | `x, y, radius, z?, includeZ?` | ✓ | :175 | `CmdQueryRadius` | Find objects within radius |
| `bulk-place-objects` | `lbX, lbY, objects[]` | ✓ | :262 | `CmdBulkPlaceObjects` | Place multiple objects in one call |
| `get-object-detail` | `objectId` | ✓ | :196 | `CmdGetObjectDetail` | DAT model geometry & ontology info |

## Placements (instance DB)

| Command | Args | Adv | Dispatch | Handler | Description |
|---|---|---|---|---|---|
| `placement-list` | `lbX?, lbY?, kind?` | ✓ | :251 | `CmdPlacementList` | Lists outdoor/dungeon instance placements (filtered by lb + kind) |
| `placement-add-outdoor` | `lbX, lbY, wcid, cellNumber?, originX, originY, originZ, anglesW?, anglesX?, anglesY?, anglesZ?` | ✓ | :252 | `CmdPlacementAddOutdoor` | Appends an outdoor instance placement to Project.OutdoorInstancePlacements |
| `placement-add-dungeon` | `lbX, lbY, wcid, cellNumber?, originX, originY, originZ, anglesW?, anglesX?, anglesY?, anglesZ?` | ✓ | :253 | `CmdPlacementAddDungeon` | Appends a dungeon instance placement to the dungeon document for the given lb |
| `placement-remove` | `kind, index` | ✓ | :254 | `CmdPlacementRemove` | Removes an outdoor or dungeon placement by index in its respective list |
| `placement-set-scope` | `kind, index, scope` | ✓ | :255 | `CmdPlacementSetScope` | Sets a placement's enrichment scope: classDefault (Option A, world weenie_properties_*) or placementOverride (Option B, shard biota_properties_*) |
| `placement-export-sql` | `out?, apply?, dryRun?, force?, validate?` | ✓ | :256 | `CmdPlacementExportSql` | Writes landblock_instances.sql + dungeon_instances.sql + per-class weenie_properties_*.sql (world) + per-placement biota_properties_*.sql (shard) + validation_report.jsonl; E6 validation gate blocks on errors unless force; apply writes world to ace-db + biota to ace-shard-db; dryRun emits files only (no DB) |

## Dungeons

| Command | Args | Adv | Dispatch | Handler | Description |
|---|---|---|---|---|---|
| `get-dungeon-info` | `lbX, lbY` | ✓ | :179 | `CmdGetDungeonInfo` | Dungeon cell layout |
| `extract-cell-footprints` | `` | ✗ | :295 | `CmdExtractCellFootprints` |  |
| `describe-floor` | `` | ✗ | :299 | `CmdDescribeFloor` |  |
| `render-dungeon` | `` | ✗ | :297 | `CmdRenderDungeon` |  |
| `generate-dungeon` | `lbX, lbY, depth?, branching?, seed?, minRooms?, maxRooms?, theme?` | ✓ | :264 | `CmdGenerateDungeon` | Generate procedural dungeon from graph grammar |
| `snap-portal` | `lbX, lbY, targetCellNumber, targetPortalPolyId, sourceEnvId, sourceCellStruct` | ✓ | :194 | `CmdSnapPortal` | Snap dungeon cell to portal |
| `analyze-dungeons` | `outputPath?` | ✓ | :176 | `CmdAnalyzeDungeons` | Scan dungeon rooms |
| `analyze-dungeon-catalog` | `outputPath?` | ✓ | :177 | `CmdAnalyzeDungeonCatalog` | Extract full room catalog (bounds, portals, dims, classification) |
| `analyze-dungeon-topology` | `outputPath?` | ✓ | :178 | `CmdAnalyzeDungeonTopology` | Extract portal graph topology (DAG, depth, branching, classification) |
| `cell-portal-graph-sweep` | `` | ✗ | :335 | `CmdCellPortalGraphSweep` |  |
| `pvs-visibility-snapshot` | `` | ✗ | :336 | `CmdPvsVisibilitySnapshot` |  |
| `env-cell-vs-setup-model-chunk` | `` | ✗ | :342 | `CmdEnvCellVsSetupModelChunk` |  |

## Validation

| Command | Args | Adv | Dispatch | Handler | Description |
|---|---|---|---|---|---|
| `validate-landblock` | `lbX, lbY` | ✓ | :181 | `CmdValidateLandblock` | Validate landblock objects (LBK010 footprint flush check fires when ontology is scanned) |
| `validate-terrain` | `lbX, lbY, cliffThreshold?` | ✓ | :183 | `CmdValidateTerrain` | Validate terrain |
| `validate-building-shells` | `lbX, lbY` | ✓ | :184 | `CmdValidateBuildingShells` | Validate building shells (BSH009 group-Z divergence when pairings are loaded) |
| `validate-building-portals` | `lbX, lbY` | ✓ | :185 | `CmdValidateBuildingPortals` | Validate building portals |
| `validate-dungeon` | `lbX, lbY` | ✓ | :180 | `CmdValidateDungeon` | Validate dungeon |
| `validate-all` | `lbX, lbY, cliffThreshold?` | ✓ | :186 | `CmdValidateAll` | Run all validators (footprint flush + cliffs + portals) |
| `compare-render-corners` | `` | ✗ | :182 | `CmdCompareRenderCorners` |  |
| `dump-lb-expectations` | `lbX, lbY` | ✓ | :169 | `CmdDumpLbExpectations` | Compact landblock oracle for holtburger-web wire-agent diagnostic layer — npcs (wcid+name+pos) + buildings (modelId+origin) + scenery count + interior cells. Consumer: window.__diag.setExpected(json); window.__diag.diff(0xLLLL0000). |

## Ontology

| Command | Args | Adv | Dispatch | Handler | Description |
|---|---|---|---|---|---|
| `scan-ontology` | `scanGfxObjs?` | ✓ | :190 | `CmdScanOntology` | Scan DAT to classify all models |
| `query-ontology` | `category?, scale?, keyword?, objectId?, limit?` | ✓ | :191 | `CmdQueryOntology` | Query the ontology index |
| `ontology-stats` | `` | ✓ | :192 | `_ => CmdOntologyStats()` | Ontology category/scale breakdown |
| `cache-ontology` | `outputPath?` | ✓ | :215 | `CmdCacheOntology` | Persist live ontology to JSONL (default <project_dir>/ontology_cache.jsonl) |
| `load-ontology-cache` | `inputPath?` | ✓ | :216 | `CmdLoadOntologyCache` | Restore ontology from JSONL cache |
| `enrich-ontology` | `` | ✓ | :207 | `_ => CmdEnrichOntology()` | Enrich ontology with schema names & creature families |
| `classify-ontology` | `` | ✓ | :209 | `_ => CmdClassifyOntology()` | Auto-tag ontology from StringTable names |
| `enrich-materials` | `` | ✓ | :210 | `_ => CmdEnrichMaterials()` | Tag materials from texture analysis |
| `enrich-canonical` | `path` | ✓ | :213 | `CmdEnrichCanonical` | Merge canonical enrichment (architecture, biome, behavior) |
| `enrich-unified` | `path` | ✓ | :214 | `CmdEnrichUnified` | Merge unified ontology (canonical + ACE world + Setup->Parts + DAT signals + geometry) |
| `import-catalog` | `indexPath` | ✓ | :208 | `CmdImportCatalog` | Import ACViewer catalog into ontology |
| `export-ontology` | `outputPath` | ✓ | :203 | `CmdExportOntology` | Export ontology to CSV |
| `export-setup-parts` | `outputPath` | ✓ | :204 | `CmdExportSetupParts` | Export Setup -> Parts (GfxObj) JSONL |
| `export-classification-signals` | `outputPath` | ✓ | :205 | `CmdExportClassificationSignals` | Export building/scenery setup IDs (JSON) |
| `mine-strings` | `outputPath?, filter?` | ✓ | :206 | `CmdMineStrings` | Extract strings from DAT StringTables |

## Weenies (ACE world DB)

| Command | Args | Adv | Dispatch | Handler | Description |
|---|---|---|---|---|---|
| `weenie-snapshot` | `` | ✗ | :278 | `CmdWeenieSnapshot` |  |
| `weenie-save` | `classId, fromJson` | ✓ | :247 | `CmdWeenieSave` | Replaces all scalar weenie_properties_* rows for an existing class_Id |
| `weenie-insert` | `className, fromJson` | ✓ | :248 | `CmdWeenieInsert` | Creates a new weenie row (auto-class-id ≥100000) and saves the snapshot scalars |
| `weenie-delete` | `classId` | ✓ | :249 | `CmdWeenieDelete` | Deletes a weenie + every weenie_properties_* row that points at its class_Id |
| `weenie-list-property-keys` | `family` | ✓ | :250 | `CmdWeenieListPropertyKeys` | Enumerates AcePropertyXxx names by family (int\|int64\|bool\|float\|string\|did\|iid) |
| `weenie-template-list` | `` | ✗ | :279 | `CmdWeenieTemplateList` |  |
| `weenie-template-apply` | `` | ✗ | :280 | `CmdWeenieTemplateApply` |  |
| `ingest-weenies` | `lsdPath, outputPath?` | ✓ | :211 | `CmdIngestWeenies` | Batch-extract weenie data to summary file |
| `enrich-weenies` | `summaryPath` | ✓ | :212 | `CmdEnrichWeenies` | Merge weenie data into live ontology |
| `ingest-recipes` | `lsdPath, outputPath?` | ✓ | :222 | `CmdIngestRecipes` | Batch-extract recipe data to summary file |

## Spells

| Command | Args | Adv | Dispatch | Handler | Description |
|---|---|---|---|---|---|
| `spell-list` | `limit?, source?` | ✓ | :242 | `CmdSpellList` | Lists newest spell ids by source (\"dat\" default, \"db\" for ace-db); annotates rows that have a project overlay |
| `spell-get` | `id` | ✓ | :243 | `CmdSpellGet` | Returns a SpellRecord JSON; project overlay wins, falls back to ace-db |
| `spell-save` | `id, fromJson` | ✓ | :244 | `CmdSpellSave` | Writes a SpellRecord into the project overlay; if ace-db is connected also UPSERTs the row |
| `spell-copy` | `fromId, newId?` | ✓ | :245 | `CmdSpellCopy` | Clones a spell with a new id (auto-allocates max+1 if newId is omitted) |
| `spell-delete` | `id` | ✓ | :246 | `CmdSpellDelete` | Removes a spell from the project overlay; if ace-db is connected also DELETEs the row |
| `ingest-spells` | `lsdPath, outputPath?` | ✓ | :221 | `CmdIngestSpells` | Parse spells.json to summary file |

## Layouts

| Command | Args | Adv | Dispatch | Handler | Description |
|---|---|---|---|---|---|
| `layout-list` | `overlayOnly?` | ✓ | :238 | `CmdLayoutList` | Lists every LayoutDesc id from the local DAT (or only ones with a project overlay) |
| `layout-get` | `layoutId` | ✓ | :239 | `CmdLayoutGet` | Returns a LayoutDesc as JSON; preferred from project overlay if present |
| `layout-save` | `layoutId, fromJson` | ✓ | :240 | `CmdLayoutSave` | Saves a JSON LayoutDesc into the project's LayoutDatDocument overlay |
| `layout-delete-overlay` | `layoutId` | ✓ | :241 | `CmdLayoutDeleteOverlay` | Removes the project overlay for a LayoutDesc id (DAT original is untouched) |

## Creatures (visual overrides)

| Command | Args | Adv | Dispatch | Handler | Description |
|---|---|---|---|---|---|
| `creature-get` | `objectId` | ✓ | :235 | `CmdCreatureGet` | Loads ACE-DB creature visual overrides (texture map, anim part, palette) |
| `creature-save` | `objectId, fromJson?` | ✓ | :236 | `CmdCreatureSave` | Replaces texture-map + anim-part rows for the given object_Id (transactional) |
| `creature-export-sql` | `objectId, out?` | ✓ | :237 | `CmdCreatureExportSql` | Generates idempotent DELETE+INSERT SQL for the creature's overrides |

## ACE-DB ingestion / connection

| Command | Args | Adv | Dispatch | Handler | Description |
|---|---|---|---|---|---|
| `ace-db-ingest-creatures` | `out?` | ✓ | :223 | `CmdAceDbIngestCreatures` | Pull creature roster from ACE DB → creature_gazetteer.json |
| `ace-db-ingest-npcs` | `out?` | ✓ | :224 | `CmdAceDbIngestNpcs` | Pull NPC roster from ACE DB → npc_gazetteer.json |
| `ace-db-ingest-housing` | `out?` | ✓ | :225 | `CmdAceDbIngestHousing` | Pull housing portal roster from ACE DB → housing_gazetteer.json |
| `ace-db-ingest-spawns` | `out?` | ✓ | :226 | `CmdAceDbIngestSpawns` | Pull every landblock_instance row → ace_spawn_records.jsonl (SpawnRecord shape) |
| `ace-db-ingest-weenie-index` | `out?` | ✓ | :227 | `CmdAceDbIngestWeenieIndex` | Pull canonical wcid → identity (setup, name, type) → weenie_index.jsonl |
| `ace-shard-db-connect` | `host, port?, database?, user?, password?` | ✓ | :257 | `CmdAceShardDbConnect` | Tests + saves the ACE SHARD DB connection (separate from world ace-db); db defaults to ace_shard; rejects a target matching the world DB |
| `ace-shard-db-status` | `` | ✓ | :258 | `CmdAceShardDbStatus` | Shows the ACE SHARD DB connection settings + tests connectivity |
| `compare-creatures-to-retail` | `` | ✓ | :228 | `_ => CmdCompareCreaturesToRetail()` | Jaccard similarity of project's spawn gazetteer vs. ACE creature/NPC/housing rosters |
| `ingest-spawn-maps` | `lsdPath, outputPath?` | ✓ | :220 | `CmdIngestSpawnMaps` | Extract spawn placement data |

## Population & worldgen

| Command | Args | Adv | Dispatch | Handler | Description |
|---|---|---|---|---|---|
| `worldgen` | `` | ✗ | :281 | `CmdWorldGen` |  |
| `worldgen-analyze-buildings` | `` | ✗ | :282 | `CmdWorldGenAnalyzeBuildings` |  |
| `worldgen-scan-retail-towns` | `` | ✗ | :283 | `CmdWorldGenScanRetailTowns` |  |
| `generate-world` | `params?, apply?, exportTownsCsv?` | ✓ | :260 | `CmdGenerateWorld` | GUI-parity world generation: ResetWorldDocs → terrain → buildings → decorations; optional CSV emit |
| `export-towns-csv` | `fromResult, out` | ✓ | :261 | `CmdExportTownsCsv` | Renders the GUI's towns CSV from a worldgen result JSON written by generate-world |
| `generate-settlement` | `template, centerX, centerY, seed?` | ✓ | :272 | `CmdGenerateSettlement` | Generate constraint-based settlement from template |
| `apply-population` | `planPath, dryRun?` | ✓ | :219 | `CmdApplyPopulation` | Apply population plan to world |
| `difficulty-gradient` | `gradientPath?` | ✓ | :218 | `CmdDifficultyGradient` | Load & validate difficulty gradient |
| `analyze-landblock-patterns` | `minX?, minY?, maxX?, maxY?, outputPath?` | ✓ | :266 | `CmdAnalyzeLandblockPatterns` | Extract spatial design patterns from populated landblocks |
| `extract-building-pairings` | `minCount5?, outputPath?` | ✓ | :267 | `CmdExtractBuildingPairings` | Mine retail Structure×Structure adjacency at 5m → building_pairings.json (drives group-aware placement) |
| `load-building-pairings` | `path` | ✓ | :268 | `CmdLoadBuildingPairings` | Load building_pairings.json into the live registry |
| `scan-building-placements` | `outputPath?` | ✓ | :217 | `CmdScanBuildingPlacements` | Extract building positions for culture mapping |

## Render preview & tiles

| Command | Args | Adv | Dispatch | Handler | Description |
|---|---|---|---|---|---|
| `render-preview` | `lbX, lbY, radius?, resolution?, overlay?, includePng?, outputPath?` | ✓ | :284 | `CmdRenderPreview` | Top-down PNG of an N×N landblock region (terrain + objects + cliff/pairing overlays). Returns base64 PNG. |
| `generate-object-sprites` | `` | ✗ | :296 | `CmdGenerateObjectSprites` |  |
| `emit-tile-pyramid` | `` | ✗ | :298 | `CmdEmitTilePyramid` |  |
| `get-tile` | `zoom, lbX?, lbY?, region?, includeBase64?` | ✓ | :288 | `CmdGetTile` | Tile pyramid (sourced from render-preview). zoom=lb (LB-keyed), region (region name), or world. Returns path + size + optional base64 PNG. |
| `tile-stats` | `` | ✓ | :289 | `_ => CmdTileStats()` | Tile-cache totals, dirty counts, disk used vs. budget |
| `regenerate-dirty-tiles` | `` | ✓ | :290 | `_ => CmdRegenerateDirtyTiles()` | Rebuild every tile flagged dirty (e.g. by transact-journal invalidation) and clear dirty bits. |
| `list-dirty-tiles` | `` | ✓ | :291 | `_ => CmdListDirtyTiles()` | Enumerate LBs whose tiles need regeneration. |
| `mark-tiles-clean` | `` | ✓ | :292 | `_ => CmdMarkTilesClean()` | Force-clear all dirty bits without regenerating. |
| `prune-tiles` | `keepNewest?, olderThan?` | ✓ | :293 | `CmdPruneTiles` | LRU-prune the LB-tile layer; region+world tiles are pinned. |
| `generate-atlas-tiles` | `mode, lbList?` | ✓ | :294 | `CmdGenerateAtlasTiles` | Bulk-generate tiles. mode=lbs\|regions\|world\|all. mode=lbs requires lbList[{lbX,lbY}]; mode=all sweeps every LB and may take many minutes. |

## Static-site emission

| Command | Args | Adv | Dispatch | Handler | Description |
|---|---|---|---|---|---|
| `emit-static-site` | `` | ✗ | :300 | `CmdEmitStaticSite` |  |
| `emit-render-gallery` | `outDir, autoTowns?, autoZones?, autoDungeons?, autoRegions?, radius?, resolution?, useSprites?, overlay?, lbFilter?` | ✓ | :301 | `CmdEmitRenderGallery` | Curate N landblocks (5 towns + 5 creature zones + 5 dungeons + 5 region anchors by default), render-preview + describe-landblock per pick, bundle into a Tailwind gallery dir. |
| `serve-render-gallery` | `outDir, port?, bind?` | ✓ | :302 | `CmdServeRenderGallery` | Serve a gallery (or any) directory over HTTP via a built-in C# HttpListener. Detects Tailscale IPs and reports a tailnet-reachable URL when one is available. |

## Living atlas / world info

| Command | Args | Adv | Dispatch | Handler | Description |
|---|---|---|---|---|---|
| `describe-landblock` | `lbX, lbY` | ✓ | :168 | `CmdDescribeLandblock` | Living Atlas: verbal + deeply structured per-LB description (terrain, structures, spawns, POIs, validation). Composes ontology + region/town gazetteer + Acpedia + LSD spawnMap. |
| `list-landblocks` | `minX?, minY?, maxX?, maxY?, limit?` | ✓ | :187 | `CmdListLandblocks` | List landblocks |
| `get-world-info` | `` | ✓ | :188 | `_ => CmdGetWorldInfo()` | World metadata |
| `get-region` | `` | ✓ | :189 | `_ => CmdGetRegion()` | Height table and terrain types |

## DAT extension (textures/mesh/BSP)

| Command | Args | Adv | Dispatch | Handler | Description |
|---|---|---|---|---|---|
| `export-textures` | `outputDir, minId?, maxId?` | ✓ | :199 | `CmdExportTextures` | Export RenderSurface textures to PNG |
| `import-texture` | `textureId, imagePath` | ✓ | :200 | `CmdImportTexture` | Replace a texture from image file |
| `import-render-surface` | `imagePath, renderSurfaceId, ui?, name?` | ✓ | :233 | `CmdImportRenderSurface` | Import a PNG to replace a RenderSurface (default: register in CustomTextureStore; --ui: deferred portal write) |
| `clone-dat` | `outputPath` | ✓ | :201 | `CmdCloneDat` | Clone portal DAT to a new file |
| `defragment-dat` | `datType, outputPath` | ✓ | :202 | `CmdDefragmentDat` | Defragment DAT (portal/cell/local) |
| `obj-export` | `` | ✗ | :275 | `CmdObjExport` |  |
| `obj-import` | `` | ✗ | :276 | `CmdObjImport` |  |
| `bsp-build` | `` | ✗ | :277 | `CmdBspBuild` |  |

## External DAT handles (Phase X.1)

| Command | Args | Adv | Dispatch | Handler | Description |
|---|---|---|---|---|---|
| `dat-open` | `path, alias` | ✓ | :354 | `CmdDatOpen` | Open an external DAT (directory with the 4 EoR dats, or a single .dat file) read-only under a named alias. Aliases are accepted wherever a second DAT is consumed (region-diff otherDat, future scene-diff / transplant fromDat). |
| `dat-close` | `alias` | ✓ | :355 | `CmdDatClose` | Dispose and unregister an external DAT handle. |
| `dat-list` | `` | ✓ | :356 | `_ => CmdDatList()` | Enumerate open external DAT handles ({alias, path, kind}). |

## Region 0x13 (Phase R + skybox diagnostics)

| Command | Args | Adv | Dispatch | Handler | Description |
|---|---|---|---|---|---|
| `region-export-json` | `out?, parts?, datPath?` | ✓ | :350 | `CmdRegionExportJson` | Export Region 0x13000000 (LandDefs/GameTime/Sky/Sound/Scene/Terrain/Misc) as a stable JSON document. parts filters to sky\|sound\|scene\|terrain\|misc (comma list). Prefers staged PortalDatDocument edits, then project DATs, then base portal DAT. |
| `region-import-json` | `path, apply?` | ✓ | :351 | `CmdRegionImportJson` | Validate a region JSON document, rebuild the Region DBObj, verify pack/unpack self-parity; apply:true stages it into PortalDatDocument so 'export' writes it to the export DATs. |
| `region-diff` | `otherDat?, otherJson?, maxRows?` | ✓ | :352 | `CmdRegionDiff` | Deep field-by-field Region diff vs a second DAT (path or portal/cell alias) or a previously exported region JSON. Emits {path, ours, theirs} rows. |
| `region-skybox-snapshot` | `` | ✗ | :347 | `CmdRegionSkyboxSnapshot` |  |
| `region-day-night-curve` | `` | ✗ | :348 | `CmdRegionDayNightCurve` |  |

## Scene 0x12 (Phase S)

| Command | Args | Adv | Dispatch | Handler | Description |
|---|---|---|---|---|---|
| `scene-export-json` | `sceneId\|all, out?, datPath?` | ✓ | :358 | `CmdSceneExportJson` | Dump Scene 0x12 ObjectDescs (full retail field set incl. freq/displace/scale/slope/align/orient) as JSON; all:true sweeps every scene to 'out'. |
| `scene-diff` | `sceneId, otherDat, maxRows?` | ✓ | :359 | `CmdSceneDiff` | Per-object field diff of a Scene vs a second DAT (dat-open alias or path). |
| `scene-where-used` | `sceneId` | ✓ | :360 | `CmdSceneWhereUsed` | Reverse map via Region 0x13: which SceneDesc scene-type indices carry this scene and which TerrainTypes reference them. |
| `scene-edit` | `sceneId, index, fields, apply?` | ✓ | :361 | `CmdSceneEdit` | Mutate one ObjectDesc (objectId/origin/orientation/frequency/displace/scale/rotation/slope/align/orient/weenieObj) and stage the Scene for export (apply:true). |

## Asset-reference graph (Phase G)

| Command | Args | Adv | Dispatch | Handler | Description |
|---|---|---|---|---|---|
| `asset-refs` | `id, datPath?` | ✓ | :363 | `CmdAssetRefs` | Forward asset-chain edges for a DID: Scene→placed objects, Setup→GfxObj parts, GfxObj→Surfaces, Surface→SurfaceTexture/Palette, SurfaceTexture→RenderSurfaces. |
| `asset-used-by` | `id, transitive?, datPath?` | ✓ | :364 | `CmdAssetUsedBy` | Reverse lookup: who references this DID. First call builds a session-cached portal-DAT reverse index; transitive:true walks the closure up to Setups/Scenes ('which models show this surface'). |
| `surface-fingerprint` | `id?, match?, datPath?` | ✓ | :365 | `CmdSurfaceFingerprint` | Fingerprint a Surface (Type, OrigTexture/Palette, ColorValue, Translucency, Luminosity, Diffuse) and find all surfaces sharing it, or query by partial match spec — locates the same material under different IDs. |

## Cross-DAT transplant (Phase X.2)

| Command | Args | Adv | Dispatch | Handler | Description |
|---|---|---|---|---|---|
| `copy-landblock` | `fromDat, srcLbX, srcLbY, dstLbX?, dstLbY?, heightmap?, textures?, objects?, buildings?, clearExisting?` | ✓ | :369 | `CmdCopyLandblock` | Copy a landblock from an external DAT (dat-open alias or directory): terrain heights and/or texture bytes, exterior objects, buildings incl. interior EnvCells (cell-ID remap at export). dst defaults to src. Validate + export afterwards. |
| `copy-building` | `fromDat, srcLbX, srcLbY, buildingIndex, dstLbX, dstLbY, x, y, z, qw?/qx?/qy?/qz?` | ✓ | :370 | `CmdCopyBuilding` | Transplant one building + interior cells from an external DAT to a world position (donor-blueprint pipeline handles cell-ID remap + VisibleCells fixup at export). |
| `remove-building` | `lbX, lbY, buildingIndex` | ✓ | :371 | `CmdRemoveBuilding` | Remove a building's shell from the staged landblock; export drops the BuildingInfo and decrements NumCells (interior cells orphaned). |

## Melt deferred briefing

| Command | Args | Adv | Dispatch | Handler | Description |
|---|---|---|---|---|---|
| `melt-reference` | `topic?` | ✓ | :367 | `CmdMeltReference` | Agent briefing for DEFERRED melt functionality (not implemented): topics dm-textures, id-migration, cache-converters, acedb-recipes. No topic = list; topic = full markdown section with melt file:line pointers. Read-only knowledge surface. |

## Bulk export / training data

| Command | Args | Adv | Dispatch | Handler | Description |
|---|---|---|---|---|---|
| `export-training-data` | `minX?, minY?, maxX?, maxY?, outputPath?, nearbyLimit?` | ✓ | :269 | `CmdExportTrainingData` | Export placement examples as JSONL (one per object with terrain + neighbors + ontology) |
| `export-raw-world-facts` | `minX?, minY?, maxX?, maxY?, outputPath?, includeAceDb?, includeLinks?` | ✓ | :270 | `CmdExportRawWorldFacts` | Export raw DAT/SQL/spawn facts as JSONL |
| `export-envcell-components` | `minX?, minY?, maxX?, maxY?, outputPath?` | ✓ | :271 | `CmdExportEnvCellComponents` | Export linked surface-anchor and EnvCell components as JSONL |

## Transactions

| Command | Args | Adv | Dispatch | Handler | Description |
|---|---|---|---|---|---|
| `transact` | `ops[] \| opsFile, rollback_on_fail?, validate?, diff?` | ✓ | :286 | `CmdTransact` | Stage N mutating ops, validate the staged delta, atomically commit or rollback. Allow-list: terrain edits, object placement, generate-dungeon. validate=auto\|all\|none\|{landblocks:[...]}. diff=true\|\"structured\"\|\"visual\"\|\"both\" inlines the transact-diff response. |
| `transact-diff` | `txId, render?, renderMode?, lbs?, resolution?, out?` | ✓ | :287 | `CmdTransactDiff` | Structured before/after report for a committed transaction. renderMode=overlay\|side-by-side\|after-only-with-diff. Returns TXDIFF-EXPIRED or TXDIFF-ROLLED-BACK if the snapshot is unavailable. |

## Comparison & metrics

| Command | Args | Adv | Dispatch | Handler | Description |
|---|---|---|---|---|---|
| `compare-to-retail` | `generated, retailBaseline?, topK?, anomalyMinModel?, perLandblock?, cacheDir?` | ✓ | :285 | `CmdCompareToRetail` | Subprocess the Python comparator; score generated world vs retail with per-LB drilldown and class-space ratio. Caches retail snapshot for tight tuning loops. |

## Chorizite parity / DAT forensics

| Command | Args | Adv | Dispatch | Handler | Description |
|---|---|---|---|---|---|
| `chorizite-classify` | `` | ✗ | :306 | `CmdChoriziteClassify` |  |
| `chorizite-decode-surface-chunk` | `` | ✗ | :338 | `CmdChoriziteDecodeSurfaceChunk` |  |
| `chorizite-decode-texture-chain-chunk` | `` | ✗ | :339 | `CmdChoriziteDecodeTextureChainChunk` |  |
| `chorizite-dump-enum-values` | `` | ✗ | :303 | `CmdChoriziteDumpEnumValues` |  |
| `chorizite-dump-layout-tree` | `` | ✗ | :310 | `CmdChoriziteDumpLayoutTree` |  |
| `chorizite-dump-opcodes` | `` | ✗ | :307 | `CmdChoriziteDumpOpcodes` |  |
| `chorizite-dump-skill-table` | `` | ✗ | :313 | `CmdChoriziteDumpSkillTable` |  |
| `chorizite-dump-world-object-taxonomy` | `` | ✗ | :304 | `CmdChoriziteDumpWorldObjectTaxonomy` |  |
| `chorizite-extract-ui-textures` | `` | ✗ | :311 | `CmdChoriziteExtractUiTextures` |  |
| `chorizite-hash-string` | `` | ✗ | :305 | `CmdChoriziteHashString` |  |
| `chorizite-list-dat-records` | `` | ✗ | :321 | `CmdChoriziteListDatRecords` |  |
| `chorizite-list-dat-types` | `` | ✗ | :323 | `_ => CmdChoriziteListDatTypes()` |  |
| `chorizite-parse-dat-record` | `` | ✗ | :322 | `CmdChoriziteParseDatRecord` |  |
| `chorizite-resolve-sound` | `` | ✗ | :308 | `CmdChoriziteResolveSound` |  |
| `chorizite-wire-list-message-types` | `` | ✗ | :317 | `_ => CmdChoriziteWireListMessageTypes()` |  |
| `chorizite-wire-pack-message` | `` | ✗ | :315 | `CmdChoriziteWirePackMessage` |  |
| `chorizite-wire-unpack-message` | `` | ✗ | :316 | `CmdChoriziteWireUnpackMessage` |  |

## Parity & diagnostics harnesses

| Command | Args | Adv | Dispatch | Handler | Description |
|---|---|---|---|---|---|
| `diag-run-all` | `` | ✗ | :374 | `CmdDiagRunAll` |  |
| `diag-status` | `` | ✗ | :375 | `_ => CmdDiagStatus()` |  |
| `enum-parity-report` | `` | ✗ | :319 | `CmdEnumParityReport` |  |
| `mesh-vs-obj-export-chunk` | `` | ✗ | :341 | `CmdMeshVsObjExportChunk` |  |
| `motion-classify-swing` | `` | ✗ | :330 | `CmdMotionClassifySwing` |  |
| `motion-inventory` | `` | ✗ | :331 | `CmdMotionInventory` |  |
| `motion-table-anim-hooks` | `` | ✗ | :333 | `CmdMotionTableAnimHooks` |  |
| `physics-jump-formula` | `` | ✗ | :325 | `CmdPhysicsJumpFormula` |  |
| `physics-jump-formula-sweep` | `` | ✗ | :326 | `CmdPhysicsJumpFormulaSweep` |  |
| `physics-replay-trace` | `` | ✗ | :328 | `CmdPhysicsReplayTrace` |  |
| `wave4-status` | `` | ✗ | :344 | `_ => CmdWave4Status()` |  |
| `wave4-sweep` | `` | ✗ | :345 | `CmdWave4Sweep` |  |


## Addendum 2026-07-02 — UI workspace suite

Ported from the community desktop tools `AC_UI_Asset_Builder` v0.3 (Rust/egui) and `Asherons_Interface` v0.1 (WPF), studied from their binaries + ILSpy decompile under `/mnt/wbterminal2/asheron-ui-tools/`. Engine: `WorldBuilder.Terminal/CommandEngine.UiWorkspace.cs`. All five are advertised in `help`.

| Command | Args | Adv | Handler | Description |
|---|---|---|---|---|
| `ui-layout-list` | `datPath?` | ✓ | `CmdUiLayoutList` | List every retail UI LayoutDesc in the local DAT (dims, element/image counts, root element names) |
| `ui-layout-render` | `layoutId, outPath, datPath?, state?, scale?, annotate?, drawText?, background?, animationFrame?, manifestPath?, includeElements?` | ✓ | `CmdUiLayoutRender` | Headless-render a retail UI layout to PNG: base-element inheritance, per-state media, tiled images, alpha masks, retail bitmap-font text from StringTables (fonts resolved via PassToChildren inheritance + most-used-font fallback); emits a render manifest |
| `ui-element-edit` | `datPath, layoutId, edits[{elementId, x?, y?, width?, height?, zLevel?}], dryRun?` | ✓ | `CmdUiElementEdit` | Move/resize UI elements in a LayoutDesc and write back to a local-DAT COPY (writes to ~/ac_base_dats refused) |
| `ui-image-replace` | `datPath, replacements[{did, pngPath}] \| fromDir, dryRun?, allowCreate?` | ✓ | `CmdUiImageReplace` | Write PNGs into a portal-DAT COPY as RenderSurfaces (R8G8B8 preserved for opaque replacements, else A8R8G8B8; batch via a dir of 0x06XXXXXX.png) |
| `ui-pack-export` | `outDir, layoutIds?, datPath?, includeImages?` | ✓ | `CmdUiPackExport` | Export an AC_UI_Asset_Builder-compatible `reference_pack.json` + `images/` (schema key-identical to the community tool's pack; verified 2026-07-02) |
