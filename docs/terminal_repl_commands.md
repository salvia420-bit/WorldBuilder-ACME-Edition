# WorldBuilder.Terminal REPL Command Reference

This is the full interactive REPL command catalog (as shown by `help`), grouped by category for quick scanning.

## Project Management
- `load <path>`
- `export <directory> [iter] [--reposition]`
- `info`

## Terrain Editing
- `smooth <x> <y> <radius> [str]`
- `raise <x> <y> <radius> [delta]`
- `lower <x> <y> <radius> [delta]`
- `set-height <x> <y> <r> <h>`
- `paint <x> <y> <radius> <type>`
- `fill <x> <y> <type>`
- `road <x1> <y1> <x2> <y2> [val]`

## Terrain Queries
- `get-height <x> <y>`
- `terrain-info <lbX> <lbY>`
- `get-heightmap <lbX> <lbY>`
- `get-terrain-data <lbX> <lbY>`
- `terrain sample-height <wX> <wY>`

## Object Management
- `list-objects <lbX> <lbY>`
- `add-object <lbX> <lbY> <id> <x> <y> <z>`
- `remove-object <lbX> <lbY> <index>`
- `clear-objects <lbX> <lbY>`
- `clear-objects --all`
- `move-object <lbX> <lbY> <idx> <x> <y> <z>`
- `rotate-object <lbX> <lbY> <idx> <yaw°>`
- `rotate-object <lbX> <lbY> <idx> <qw> <qx> <qy> <qz>`

## Spatial Queries
- `query-radius <x> <y> <radius>`

## Dungeon Tools
- `analyze-dungeons [output-path]`
- `analyze-dungeon-catalog [output-path.json]`
- `analyze-dungeon-topology [output-path.json]`
- `get-dungeon-info <lbX> <lbY>`

## Validation
- `validate-dungeon <lbX> <lbY>`
- `validate-landblock <lbX> <lbY>`
- `validate-terrain <lbX> <lbY> [thresh]`
- `validate-building-shells <lbX> <lbY>`
- `validate-building-portals <lbX> <lbY>`
- `validate-all <lbX> <lbY> [thresh]`

## World Observation
- `list-landblocks [minX minY maxX maxY]`
- `get-world-info`
- `get-region`

## Ontology
- `scan-ontology [setups-only]`
- `query-ontology [cat] [scale] [kw] [n]`
- `query-ontology 0x02001234`
- `ontology-stats`

## Stamp & Portal
- `paste-stamp <sX1> <sY1> <sX2> <sY2> <dX> <dY>`
- `snap-portal <lbX> <lbY> <cell> <poly> <env> <struct>`

## Bulk & Detail Queries
- `get-bulk-heightmap <minX> <minY> <maxX> <maxY>`
- `get-object-detail <objectId>`
- `diff-terrain <lbX> <lbY>`

## Terrain Layers
- `get-terrain-layers <lbX> <lbY>`

## DAT Extensions
- `export-textures <outputDir> [minId] [maxId]`
- `import-texture <textureId> <imagePath>`
- `clone-dat <outputPath>`
- `defragment-dat <portal|cell|local> <outPath>`

## Ontology Export & Enrichment
- `export-ontology <outputPath>`
- `export-setup-parts <outputPath>`
- `export-classification-signals <outputPath>`
- `mine-strings [outputPath] [filter]`
- `enrich-ontology`
- `enrich-unified <unified-ontology-json>`
- `cache-ontology [outputPath]` — persist live ontology to JSONL (default `<project_dir>/ontology_cache.jsonl`)
- `load-ontology-cache [inputPath]` — restore ontology from JSONL cache (auto-runs on `load` if a sibling `ontology_cache.jsonl` exists)
- `import-catalog <index.json>`
- `classify-ontology`
- `enrich-materials`

The unified ontology pipeline is:

1. `scan-ontology` — DAT geometry scan
2. `export-setup-parts <outputPath>` — Setup → Parts (GfxObj) JSONL
3. `export-classification-signals <outputPath>` — building/scenery model_id sets
4. `python3 scripts/build_unified_ontology.py` — merges the above with `canonical_enrichment.json` and `ace_world_setup_names.json` into `pipeline_data/enrichment/unified_ontology.json`
5. `enrich-unified pipeline_data/enrichment/unified_ontology.json` — applies the merged ontology to the live `OntologyService`

## LSD Data Ingestion
- `ingest-weenies <lsd-path> [output]`
- `enrich-weenies <summary-path>`
- `enrich-canonical <json-path>`
- `scan-building-placements [output]`
- `difficulty-gradient [json-path]`
- `apply-population <plan-path> [--dry-run]`
- `ingest-spawn-maps <lsd-path> [output]`
- `ingest-spells <lsd-path> [output]`
- `ingest-recipes <lsd-path> [output]`

## Benchmark & Bulk Operations
- `benchmark`
- `set-landblock-heightmap <lbX> <lbY> <h1,h2,...>`
- `set-landblock-terrain <lbX> <lbY> <t1,t2,...>`
- `bulk-place-objects <lbX> <lbY> <json-array>`

## Procedural Generation
- `generate-terrain <seed> [oct] [lac] [per] [amp]`
- `generate-dungeon <lbX> <lbY> [depth] [branching] [seed]`
- `auto-paint`
- `analyze-landblock-patterns [minX minY maxX maxY] [output]`
- `export-training-data [minX minY maxX maxY] [output] [nearbyN]`
- `generate-settlement <template> <cx> <cy> [seed]`
- `extract-retail-heightmaps [output.jsonl]`
- `compute-vanilla-baseline [output.json]`

## Image-Driven Terrain
- `analyze-map-image <image.png> [output.json]`
- `calibrate-world-map [output.json]`
- `quick-world <codebook.json> <map.png> [seed]`

## Building Remap
- `remap-buildings <lb_remap.json> <out_dir> [--apply]`
- `remap-buildings-v2 <lb_remap.json> [--flatten-radius=N] [--flatten-strength=S] [--no-validate] [--preserve-retail-z]`
- `remap-buildings-sql <lb_remap.json> <export_dir> <out.sql> [--apply]`

## ACE Database
- `ace-db connect <host> <port> <db> <user> <pass>`
- `ace-db status`
- `ace-db query-instances <landblockId>`
- `ace-db reposition`
- `ace-db export-sql <path>`
- `ace-db stats`
- `ace-db clear-instances`

## Dungeon Document Operations
- `dungeon add-cell <lbX> <lbY> <envId> <csId> <x> <y> <z>`
- `dungeon remove-cell <lbX> <lbY> <cellNum>`
- `dungeon connect <lbX> <lbY> <cellA> <polyA> <cellB> <polyB>`
- `dungeon disconnect <lbX> <lbY> <cellA> <cellB>`
- `dungeon validate <lbX> <lbY>`
- `dungeon autofix <lbX> <lbY>`
- `dungeon recompute <lbX> <lbY>`
- `dungeon reload <lbX> <lbY>`
- `dungeon copy-cells <srcX> <srcY> <destX> <destY>`
- `dungeon move-cell <lbX> <lbY> <cellNum> <dX> <dY> <dZ>`
- `dungeon rotate-cell <lbX> <lbY> <cellNum> <degrees> <axisX> <axisY> <axisZ>`
- `dungeon move-object <lbX> <lbY> <cellNum> <objIndex> <dX> <dY> <dZ>`
- `dungeon rotate-object <lbX> <lbY> <cellNum> <objIndex> <degrees>`
- `dungeon set-cell-position <lbX> <lbY> <cellNum> <x> <y> <z>`
- `dungeon set-cell-rotation <lbX> <lbY> <cellNum> <rotX> <rotY> <rotZ>`
- `dungeon set-object-position <lbX> <lbY> <cellNum> <objIndex> <x> <y> <z>`
- `dungeon set-object-rotation <lbX> <lbY> <cellNum> <objIndex> <degrees>`

## General
- `help`
- `quit`
- `exit`
