# ACME WorldBuilder

World building tool for Asheron's Call — edit terrain, dungeons, spells, skills, and more, and export directly to DAT files. The **ACME Edition** extends the original WorldBuilder with a **headless terminal** and **agent-driven pipeline**, laying the groundwork for AI-powered autonomous world development.

<p align="center">
  <img src="docs/images/world_map_before.png" width="380" alt="Retail world map (input to AI)">
  &nbsp;&nbsp;➜&nbsp;&nbsp;
  <img src="docs/images/world_map_after.png" width="380" alt="AI-generated world map variation">
</p>
<p align="center"><em>Left: Retail Dereth map fed to AI image gen &nbsp;|&nbsp; Right: AI-generated world map variation used by the terrain pipeline</em></p>

### GUI — Full Terrain & Object Editor

<p align="center">
  <img src="docs/images/worldbuilder_gui_1.webp" width="780" alt="WorldBuilder GUI terrain editing">
</p>
<p align="center">
  <img src="docs/images/worldbuilder_gui_2.webp" width="780" alt="WorldBuilder GUI object placement">
</p>

---

## Vision — Agent-Driven Worldbuilding

The ACME Edition's long-term goal is to move beyond point-and-click editing. By exposing every world-manipulation capability through a structured, machine-readable API, we enable **AI agents** and **procedural algorithms** to design, populate, and validate entire regions of Dereth — with the same fidelity as a human using the GUI.

The worldbuilding pipeline has three pillars:

1. **Command** — An AI agent (LLM, procedural generator, or hybrid) issues structured commands: *place this building, sculpt this hillside, connect these dungeon rooms.*
2. **Execute & Validate** — The headless engine applies the commands against the live DAT data, then runs geometric and structural validators that act as a safety net — rejecting collisions, broken portals, or terrain that violates AC's spatial constraints.
3. **Observe & Iterate** — The agent reads back the world state (heightmaps, object lists, dungeon graphs, spatial queries) and refines its plan in a tight feedback loop until the result passes validation.

None of this replaces the GUI. Every feature available in the visual editor remains fully intact — the terminal is a **parallel interface**, not a replacement. Human artists and AI agents can work on the same project files.

---

## Downloads

- **Latest (for testing)** — [Releases → Edge (pre-release)](https://github.com/Vanquish-6/WorldBuilder-ACME-Edition/releases) — automated build from the latest commit. Download **ACME-WorldBuilderInstall-*.exe** and run it.
- **Stable** — [Releases](https://github.com/Vanquish-6/WorldBuilder-ACME-Edition/releases) — pick a versioned release (e.g. v0.1.0) when available.

Requires **Windows 10/11**, **.NET 8.0** (installer can prompt to install it). The app can check for updates in-app once installed.

---

> **Beta software.** All features are under active development. The newer data editors (Spell, Skill, Vital, Experience, CharGen, SpellSet, Layout) are especially early and have not been thoroughly tested. Expect rough edges, and back up your DAT files before exporting.

> **First run note:** The initial launch will be slower than usual. ACME WorldBuilder builds several caches on first run (textures, thumbnails, terrain data) that persist across sessions. Subsequent launches will be significantly faster.

---

## WorldBuilder.Terminal — Headless CLI

`WorldBuilder.Terminal` is a standalone, headless console application that exposes the full WorldBuilder engine **without a GUI**. It operates in three modes:

| Mode | Command | Use Case |
|------|---------|----------|
| **Batch** | `--project X --export Y` | Automated DAT export (CI/CD, scripts) |
| **Interactive REPL** | `--project X` (or no args) | Human-friendly colored prompt |
| **Agent (stdin/stdout)** | `--stdin [--project X]` | JSON-line protocol for AI agent piping |

### Agent Protocol at a Glance

In `--stdin` mode, the terminal speaks **JSON-line** — one JSON object per line, in each direction. The agent spawns the process, receives a `ready` handshake, and then issues commands:

```
Agent                               WorldBuilder.Terminal
  │  spawn: --stdin --project X             │
  │─────────────────────────────────────────>│
  │  {"success":true,"command":"ready",...}  │
  │<─────────────────────────────────────────│
  │  {"command":"raise","x":1500,"y":2000,  │
  │   "radius":48,"delta":10}               │
  │─────────────────────────────────────────>│
  │  {"success":true,"verticesModified":30}  │
  │<─────────────────────────────────────────│
  │  {"command":"validate-all","lbX":7,     │
  │   "lbY":10}                             │
  │─────────────────────────────────────────>│
  │  {"success":true,"isValid":true,...}    │
  │<─────────────────────────────────────────│
```

The full protocol reference — every command, parameter, response schema, coordinate system, and diagnostic code — is documented in **[`docs/agent_api_reference.md`](docs/agent_api_reference.md)** and the companion **[`docs/agent_api_schema.json`](docs/agent_api_schema.json)**.

### Available Commands

The agent JSON protocol exposes **32 documented commands**; the REPL surface is wider (**110+ commands**, including bulk operations, image-driven terrain, ontology export, ACE-database I/O, and dungeon document editing). The table below is a flavor sample — for the full grouped catalog see **[`docs/terminal_repl_commands.md`](docs/terminal_repl_commands.md)**, and for the JSON protocol see **[`docs/agent_api_schema.json`](docs/agent_api_schema.json)**.

| Category | Commands |
|----------|----------|
| **Project** | `load`, `export`, `info` |
| **Terrain Editing** | `smooth`, `raise`, `lower`, `set-height`, `paint`, `fill`, `road` |
| **Terrain Queries** | `get-height`, `terrain-info`, `get-heightmap`, `get-terrain-data` |
| **Object Management** | `list-objects`, `add-object`, `remove-object`, `move-object`, `rotate-object` |
| **Spatial Queries** | `query-radius` |
| **Dungeon Tools** | `analyze-dungeons`, `analyze-dungeon-topology`, `get-dungeon-info` |
| **Validation** | `validate-dungeon`, `validate-landblock`, `validate-terrain`, `validate-building-shells`, `validate-building-portals`, `validate-all` |
| **World Observation** | `list-landblocks`, `get-world-info`, `get-region` |
| **Ontology** | `scan-ontology`, `query-ontology`, `ontology-stats`, `enrich-unified` |
| **Bulk** | `set-landblock-heightmap`, `set-landblock-terrain`, `bulk-place-objects`, `benchmark` |
| **Image-Driven Terrain** | `calibrate-world-map`, `quick-world`, `analyze-map-image`, `extract-retail-heightmaps` |
| **Control** | `help`, `quit` / `exit` |

### Validation Engine

The terminal includes a headless **validation engine** with 34 diagnostic codes across four validators, designed to catch agent mistakes before they corrupt DAT data:

- **Dungeon** (DNG001–DNG011) — broken portal links, orphaned cells, portal symmetry, environment references, connectivity
- **Landblock** (LBK001–LBK010) — object bounds, Z-axis clamping, zero-scale, degenerate quaternions, model existence
- **Terrain** (TRN001–TRN005) — cliff detection, edge stitching, flat/mono-type warnings
- **Building Portals** (BLD001–BLD008) — portal targets, reciprocal exits, interior BFS, VisibleCells

The recommended agent workflow: **mutate → `validate-all` → fix errors → repeat**.

### Visual Channel — `render-preview`

Validation catches structural mistakes symbolically. `render-preview` catches *visual* mistakes — clustering, mode-collapse, density drift, awkward placement — by handing a vision-capable LLM a literal top-down PNG of any region it just edited. Same JSON-agent channel, returned as a base64 PNG.

<p align="center">
  <img src="docs/images/render_preview/holtburg_r2.png" width="640" alt="render-preview of a 5×5 region around Holtburg (0xA9B4)">
</p>
<p align="center"><em>5×5 region around Holtburg (0xA9B4): bilinearly-blended terrain colors, north-west hillshade, road network in tan, object glyphs by ontology category (▲ scenery, ■ structure, ● prop, ◆ creature), red dashed cliff overlay tracing the highland-to-river drop, subtle landblock grid.</em></p>

```
render-preview <lbX> <lbY> [radius] [resolution] [--no-overlay] [--out path]
```

- **Region** — single landblock (`radius=0`) or `(2r+1)×(2r+1)` grid centered on `(lbX, lbY)`
- **Encoded** — terrain elevation (hillshade) + terrain type (color) + roads + object positions (glyphs sized by ontology scale, shaped by category) + cliff/portal/building-pairing overlays
- **Returned** — base64 PNG over the JSON channel; optionally also written to disk via `--out`
- **Headless** — pure SkiaSharp raster, no GPU, no GUI dependencies

Sample renders covering the design space — town, wilderness, ocean, multi-LB region — live in [`docs/images/render_preview/`](docs/images/render_preview/).

### Quantitative Channel — `compare-to-retail`

`render-preview` catches visual mistakes; `compare-to-retail` catches *statistical* ones. It scores a generated world's placements against the retail world facts that produced its training data, surfacing mode collapse, density drift, surface/interior shift, long-tail loss, and out-of-context placements as numbers an autonomous tuning agent can drill into. Designed for the train → place → score → tune loop to run hot inside a single agent process.

```
compare-to-retail <generated.jsonl> [--retail-baseline path] [--top-k N] [--anomaly-min-model N] [--no-per-lb]
```

- **Region** — auto-derived from `lb_x/lb_y` in the generated JSONL; retail is filtered to the same landblock set before scoring
- **Signals** — per-LB density (min/p50/mean/p95/max), wcid coverage, per-LB Jaccard (theme/context coherence), surface vs. interior split, over/under-replicated wcids, novel and missing wcids, out-of-context fraction, weenieType share
- **Class-space ratio** — model-emitted vs. retail by `classIdSpace` (`wcid` / `model_id` / `ace_abstract` / `building_model`), so an agent can see what fraction of retail's placements live in class spaces the model doesn't yet emit
- **Per-landblock breakdown** — every LB in the region returned with model count, retail count, density delta, Jaccard, novel/missing wcid counts; sorted by `|density delta|` so outliers float to the top
- **Hot-loop caching** — region-keyed pickle snapshot of the filtered retail JSONL is reused across calls; the response carries `retailCacheHit` + elapsed seconds for telemetry
- **Implementation** — subprocesses `scripts/PopulationPipeline/Validation/compare_world_to_retail.py` so numeric semantics stay identical to prior offline runs

Available on both REPL and JSON-agent channels. Override the script path with `WORLDBUILDER_COMPARATOR_PY` and the python interpreter with `WORLDBUILDER_PYTHON`.

### Object Ontology Service

The `OntologyService` provides semantic awareness — mapping raw DAT model IDs to human-readable tags (`Architecture: Aluvian`, `Biome: Desert`, `Type: Scenery_Tree`) so that AI agents can make aesthetically and logically coherent placement decisions:

- Auto-classification pipeline scans all Setup (0x02) and GfxObj (0x01) entries from `portal.dat`
- Bounding box computation from GfxObj vertex data
- Cross-references `BuildingBlueprintCache` and Scene objects for definitive classification
- Heuristic classification by size, aspect ratio, part count, and polygon count
- Object ontology schema with 80+ manually tagged entries, 28 creature families, and 5 constraint presets
- Constraint presets enforce aesthetic cohesion (e.g., a "Desert Outpost" preset rejects Snowy-tagged objects)

### Integration Tests

Both **Python** (55+ tests) and **PowerShell** (25 checks) test harnesses validate the full `--stdin` protocol surface — startup handshake, error handling, CRUD roundtrips, validation report shapes, and serialization contracts. Zero external dependencies. See **[`tests/README.md`](tests/README.md)**.

---

## Architectural Roadmap

The following phases describe the path from the current state to a fully autonomous, agentic worldbuilding system.

### Phase 1 — Service Layer Consolidation ✅

Core GUI logic has been decoupled into `WorldBuilder.Shared` services, achieving 1:1 parity between the GUI and the headless CLI:

- `ITerrainService` / `IObjectPlacementService` / `IDungeonService` / `IStampService` — all extracted
- Terrain algorithms (smooth, raise/lower, set-height, paint, fill, road pathing) in `WorldBuilder.Shared/Lib/Terrain/`
- Portal snapping algorithms in `WorldBuilder.Shared/Lib/Dungeon/PortalSnapAlgorithms.cs`
- Dungeon room analysis in `WorldBuilder.Shared/Lib/Dungeon/DungeonRoomAnalyzer.cs`
- Shared `CommandEngine` ensures both REPL and JSON modes execute identical logic

### Phase 2 — State Telemetry & Observation ✅

The terminal exposes high-fidelity, machine-readable world state:

- Heightmap matrices (9×9 grids, world-space and raw index)
- Full vertex data (height, terrain type, road flags, scenery)
- Landblock enumeration with height statistics
- World metadata and constants
- Region data (height lookup table, terrain type names)
- Dungeon cell layout (cells, portals, static objects, positions)
- Spatial radius queries with distance, density, and model frequency analysis
- Quaternion-based orientation (avoiding gimbal lock for precise agent calculations)

### Phase 3 — Deterministic Validation ✅

The headless `ValidationEngine` acts as a strict gatekeeper:

- AABB-style object bounds checking
- Z-axis topographical clamping (below-terrain / floating detection)
- Portal link verification (symmetry, connectivity via BFS, environment existence)
- Terrain edge stitching validation between adjacent landblocks
- Cliff detection with configurable thresholds
- Degenerate quaternion and zero-scale detection
- 34 structured diagnostic codes with error/warning/info severity levels

### Phase 4 — Speed Testing & Bulk Operations 🟡

Per-vertex commands plus bulk variants for high-throughput agent or pipeline use:

- `benchmark` — measures terrain edit, object placement, and validation throughput
- `set-landblock-heightmap` / `set-landblock-terrain` — replace a full landblock in one call
- `bulk-place-objects` — atomic JSON-array placement of many objects
- Image-driven worldgen (`quick-world`, `extract-retail-heightmaps`, etc.) routinely exercises the bulk path at scale

The primitives are in place. A sustained-throughput regression suite and a memory-pressure dashboard are still wishlist items — most observed degradation today is caught by the worldgen pipeline rather than by an automated harness.

### Phase 5 — ML-Driven World Generation 🟡

The hypothesis: feed raw DAT data directly into ML models and let them discover Dereth's spatial grammar implicitly. No hand-crafted rules. The model sees object IDs, positions, and per-landblock context, and learns to place with retail-level accuracy plus controlled variance. Training data is sourced entirely from the retail DAT files via the Terminal's extraction commands — no manual labeling.

**Status as of April 2026:**

| Lane | Model | Status | What it produces |
|---|---|---|---|
| **Terrain smoothing** | V3 conditional DDPM (~61M params) | ✅ Production | Retail-feel heightmaps from QuickWorld output, ~15% denoise strength |
| **Macro / archetype** | Settlement planner MLP (~100K params) | ✅ Working | Per-landblock archetype + family-bin distribution; conditions the scene placer |
| **Outdoor population** | Scene placer Transformer (50.5M params) | ✅ **The thing that works** | Autoregressive object sequences scoring **83–85/100** on retail 20×20 regions — currently the only stage with end-to-end measured quality |
| **Unified outdoor + interior** | Same Transformer, `scene_kind` context (~38M params) | 🟡 In flight | Replaces the outdoor placer and adds interior component sequences in one corpus; first overnight runs underway |
| **Encounters / NPCs / vendors** | — | 🔲 Not started | Architecturally siblings of the scene placer trained on different retail tables |
| **Quests / loot tables** | — | 🔲 Not ML | Better solved with rules + a small LLM than a custom-trained model |

The placement Transformer's architecture generalizes — encounters, NPCs, and vendor inventories all fit the same "given context, emit a sequence of (entity_id, position) tuples" mold, so future lanes are mostly fresh corpora on the same model class, not new architectures.

**The outdoor result is the load-bearing claim.** If the unified run lifts interior placement to comparable quality, the architectural shell of an AC-style world becomes reachable. If it doesn't, every claim in this phase that depends on the same recipe needs to be re-examined honestly.

### Phase 6 — Gameplay Population 🔲

Phase 6 is contingent on Phase 5 hitting retail-quality population — a beautiful empty world is still empty. It is the layer that turns a *visitable* world into a *playable* one:

- Encounter / monster spawn model (same Transformer class, conditioned on landblock context and a difficulty band)
- Vendor inventory generator (per-archetype distribution over WCIDs)
- NPC placement and dialogue templates (small LLM driving structured templates, not a trained placement model)
- Treasure / loot tables (rule-based imports plus per-area scaling)
- Quest scaffolds (template + LLM)
- Geometric overlap rejection and DAT writer parity for any new token vocabularies the unified placer emits

This phase is intentionally sketched, not specified — until Phase 5's unified scene placer converges and is wired into inference, the shape of Phase 6 is a hypothesis. The existing **`OntologyService`** (semantic tagging, constraint presets, 28-family creature taxonomy) is the natural input substrate for these gameplay-population models when they arrive, and is also the fallback for any agent-driven or human-curated workflow that prefers explicit rules over learned priors.

---

## Create Custom Worlds

Generate your own Asheron's Call world in minutes on a GTX 1070 (or better). The pipeline turns any world map image into a near-retail quality playable terrain.

### The Pipeline

<p align="center">
  <img src="docs/images/pipeline_diagram.jpg" width="780" alt="World generation pipeline diagram">
</p>

### Step 1 — Generate a World Map Image

Use **Google Nano / Banana 2** (or any AI image generator). Take the retail Dereth world map and prompt the AI to create a variation — keeping the same pixel style and color palette but randomizing the terrain layout. The output should be a 2041×2041 PNG.

<p align="center">
  <img src="docs/images/1773102127388.jpg" width="250" alt="AI-generated Dereth variation 1">
  &nbsp;
  <img src="docs/images/1773102259481.jpg" width="250" alt="AI-generated Dereth variation 2">
  &nbsp;
  <img src="docs/images/1773102439191.jpg" width="250" alt="AI-generated Dereth variation 3">
</p>
<p align="center"><em>Three AI-generated world map variations from Nano Banana 2 — same palette, completely different worlds</em></p>

### Step 2 — Convert Image to Terrain

First, build a calibration codebook from the retail DAT data:

```bash
# In the WorldBuilder Terminal:
calibrate-world-map
```

Then reverse-engineer terrain from your new image:

```bash
quick-world pipeline_data/enrichment/terrain_codebook.json your_new_world_map.png
```

`quick-world` classifies each pixel's color to the nearest terrain type (via RGB distance to the codebook), estimates height from brightness, and stamps 255×255 landblocks with terrain + scenery objects. The result is a complete world — but with jagged, pixel-artifact edges at terrain boundaries.

### Step 3 — Smooth with V3 Diffusion

The V3 terrain diffusion model (~232 MB, 50M parameters) was overtrained on retail heightmaps. At ~15% diffusion strength, this "overtrained" property becomes a feature — it smooths the harsh QuickWorld edges while preserving the terrain's structural character:

```bash
python scripts/smooth_vanquish_v3.py \
    --model pipeline_data/models/v3/terrain_diffusion_v3.pt \
    --input pipeline_data/heightmaps/vanquish_heightmaps.jsonl \
    --output pipeline_data/heightmaps/vanquish_smoothed.jsonl
```

The smoother applies variable strength by terrain height band — mountains get lighter smoothing (they already look good), while mid-elevation plains (the worst QuickWorld artifacts) get stronger treatment.

**Hardware:** Runs on a GTX 1070 (8 GB VRAM). Inference takes a few minutes for the full 255×255 grid.

### Step 4 — Place Towns (Optional)

Open **[`tools/town_placer.html`](tools/town_placer.html)** in any browser. Load your world map image, click to place towns, and export the placement JSON for the downstream remap pipeline. This is the first-ever interactive town repositioning tool for Asheron's Call.

<p align="center">
  <img src="docs/images/townplacer.png" width="780" alt="Town Placer browser tool">
</p>

---

## ML Models

Pre-trained terrain model weights are included in the repository via **Git LFS**. When you clone and `git lfs pull`, you get everything needed to run the terrain pipeline end-to-end.

| Model | Architecture | Params | Size | Purpose | Training Script |
|---|---|---|---|---|---|
| **V1** | Conditional U-Net | 5.4M | 62 MB | Image → terrain heightmap + texture type (early experiment) | [`scripts/train_terrain_unet.py`](scripts/train_terrain_unet.py) |
| **V2** | Conditional U-Net (smaller) | 1.4M | 16 MB | Smaller iteration with augmentation, kept for reference | [`scripts/train_terrain_unet_v2.py`](scripts/train_terrain_unet_v2.py) |
| **V3** | Conditional DDPM U-Net | 60.8M | 232 MB | **Diffusion-based terrain smoothing — production** | [`scripts/train_terrain_v3.py`](scripts/train_terrain_v3.py) |

The **outdoor scene placer** (50.5M-parameter Transformer) and the **settlement planner** (~100K MLP) live alongside these and are the population-pipeline counterpart to V3 — see the Phase 5 roadmap entry above for status. Their training and inference flow lives under [`scripts/PopulationPipeline/`](scripts/PopulationPipeline/), and their checkpoints (`scene_placer_*.safetensors`, `settlement_planner.pt`) sit in `pipeline_data/models/` and are also tracked via LFS.

### Pipeline Data (Git LFS)

The terrain-pipeline LFS payload is ~530 MB. Clone the repo and `git lfs pull` to materialize:

```
pipeline_data/
├── models/
│   ├── terrain_unet.pt              # V1 weights (62 MB)
│   ├── v1/terrain_unet.pt           # V1 weights (62 MB)
│   ├── v2/terrain_unet_v2.pt        # V2 weights (16 MB)
│   ├── v3/terrain_diffusion_v3.pt   # V3 diffusion weights (232 MB)
│   ├── scene_placer_*.safetensors   # Outdoor scene-placement Transformer checkpoints
│   └── settlement_planner.pt        # Macro/archetype MLP
├── heightmaps/
│   └── retail_heightmaps.jsonl      # Training data from retail DATs (~61 MB)
└── reference/
    ├── retail_dungeon_topology.json # Dungeon reference data (~108 MB)
    └── placement_tensors.npz        # Outdoor placement training tensors
```

Model configs (`.json`), training loss plots (`.png`), and other small metadata files are tracked normally (not LFS). Additional pipeline data (enrichment, screenshots, population output, search runs) is generated locally and gitignored.

### Retraining

To retrain the V3 model from scratch on your own retail data:

```bash
# 1. Extract retail heightmaps (requires retail DATs loaded in a project)
#    In the Terminal:
extract-retail-heightmaps pipeline_data/heightmaps/retail_heightmaps.jsonl

# 2. Train the V3 diffusion model
python scripts/train_terrain_v3.py \
    --data pipeline_data/heightmaps/retail_heightmaps.jsonl \
    --output pipeline_data/models/v3/terrain_diffusion_v3.pt
```

The shipped V3 checkpoint took **~12 hours on a GTX 1070** (197 epochs over 65,025 samples). For a quick smoke run you can stop early — the loss curve is nearly flat after the first few hours, and the model's job is to *smooth* (not *generate*) at ~15% diffusion strength, so it tolerates an undertrained checkpoint surprisingly well. Inference on a full 255×255 grid takes a few minutes on the same card.

---

## Tools

### Town Placer — [`tools/town_placer.html`](tools/town_placer.html)

Interactive, browser-based town placement tool. Open it directly in any browser — no server, no dependencies, no build step. Select towns from the sidebar, click to place them on the world map, and export the placement JSON for the building remap pipeline.

This is the first tool that allows moving Asheron's Call towns to new locations. Exported placements feed into `remap-buildings-v2` in the Terminal.

### Heightmap Extractor — [`tools/heightmap_extractor.html`](tools/heightmap_extractor.html)

Companion browser tool for inspecting and exporting heightmap data alongside the town-placement workflow. Same zero-dependency model — open it in any browser.

---

## GUI Features

The full visual editor is available via the platform-specific projects (`WorldBuilder.Windows`, `.Mac`, `.Linux`). All features listed below are fully functional and unrelated to the agentic extensions.

### Terrain Editing

- **Raise / Lower** — left-click to raise, shift+left-click to lower. Adjustable brush radius (0.5–200) and strength (1–50)
- **Set Height** — paint vertices to a target height (0–255)
- **Smooth** — blend height differences across vertices
- **Texture Brush** — paint terrain textures with a shader-based WYSIWYG preview inside the brush circle
- **Bucket Fill** — flood-fill terrain textures with live preview, constrained to visible landblocks
- **Texture Palette** — visual thumbnail palette that activates with terrain tools
- **Slope Overlay** — highlight unwalkable slopes with configurable threshold (default 45°)

### Roads

- **Point placement** — click individual vertices to set road flags
- **Line drawing** — draw road lines between points
- **Remove** — clear road flags from vertices

### Objects

- **Object Browser** — browse and search the full DAT object catalog (Setups and GfxObjs)
- **Search** — by hex ID or keyword, filter by buildings or scenery
- **Thumbnail previews** — rendered on the GPU, cached to disk across sessions
- **Placement** — click terrain to place, with terrain snap
- **Move / Rotate / Delete** — drag to move, drag to rotate, Delete key to remove
- **Multi-select** — Ctrl+Click or drag a marquee box (full bounding-box testing)
- **Multi-object rotate** — rotate a group of objects around their shared center
- **Copy / Paste** — Ctrl+C / Ctrl+V, supports multi-object paste with offset
- **Right-click context menu** — copy, paste, snap to terrain, delete
- **Properties panel** — edit position (X, Y, Z), rotation (Euler angles), view landcell, snap to terrain
- **Auto height adjustment** — objects stay on the ground when terrain changes beneath them
- **Terrain snap on rotate** — objects maintain ground contact when rotated on slopes
- **Selection highlights** — spheres scale proportionally to object size

### Buildings

- **Building blueprint system** — place buildings with interior cells
- **Move / Rotate** — correctly updates interior cell VisibleCells references
- **Interior toggle** — show or hide building interiors in the viewport

### Terrain Stamps (Clone & Paste)

- **Clone tool** — drag a rectangle to capture terrain heights, textures, and objects
- **Stamp library** — stores up to 10 stamps (configurable, max 50)
- **Paste with rotation** — 0°, 90°, 180°, 270° via `[` and `]` keys
- **Edge blending** — optional smooth blending at stamp borders
- **Include objects** — optionally stamp objects along with terrain
- **Grid snapping** — snaps to the 24-unit cell grid

### Layers

- Full layer system with groups, visibility toggles, and export toggles
- Each layer tracks height, texture, road, and scenery changes independently
- Drag-and-drop reordering and nesting
- Base layer always at bottom (cannot be deleted or reordered)
- Layer compositing for export (top-to-bottom, first non-null wins)

### History & Snapshots

- Undo / redo for all operations (default 50 entries, configurable 5–10,000)
- History panel — click any entry to jump to that state
- Named snapshots that persist between sessions
- Forward entries shown dimmed in the history panel

### Dungeon Editor

- **Room palette** — browse all dungeon environment rooms with 2D cross-section previews
- **Portal snapping** — rooms auto-snap together via portal connections
- **Surface editing** — change wall and floor textures per cell
- **Static objects** — place and move objects inside dungeon cells
- **Copy template** — duplicate a dungeon from one landblock to another
- **Undo / redo** — full history support for dungeon operations

### Spell Editor *(beta)*

- Browse and search all spells by name, school, or type
- Edit spell properties: power, range, duration, components (1–8 slots)
- Icon picker with visual DAT icon browser
- Add and delete spells, save back to SpellTable

### Spell Set Editor *(beta)*

- Edit equipment set spell assignments
- Tiered spell slot management (add/remove tiers and spells per tier)

### Skill Editor *(beta)*

- Browse and filter skills by category (Combat, Magic, Other)
- Edit training costs, formulas (attribute contributions, divisor), bounds, learn mod
- Icon picker, add/delete skills

### Experience Table Editor *(beta)*

- Edit level progression, attribute/vital/skill XP cost tables
- Auto-scale generator with power-curve formulas for quick table generation
- Add/remove levels and ranks

### Vital Table Editor *(beta)*

- Edit Health, Stamina, and Mana formulas
- Configure attribute contributions, divisors, and multipliers
- Live formula preview

### Character Creation Editor *(beta)*

- Edit heritage groups: names, icons, attribute/skill credits, setup models
- 3D model preview for heritage setups with rotation and zoom
- Manage starting areas and spawn locations

### UI Layout Viewer *(beta)*

- Browse all LayoutDesc entries from the DAT
- Element tree hierarchy with property inspector
- Visual preview canvas with selection highlighting

### Custom Textures

- **Terrain texture replacement** — import custom images to replace any terrain type
- **Dungeon surface import** — create new dungeon wall/floor textures
- Exports overwrite existing RenderSurface entries in-place (no DAT corruption)

### DAT Export

- Exports to `client_cell_1.dat`, `client_portal.dat`, `client_highres.dat`, and `client_local_English.dat`
- Configurable portal iteration
- Layer-based export control (toggle which layers are included)
- Overwrite protection

### Camera & Navigation

- **Perspective camera** — WASD + mouse look, Space to go up, Shift to go down
- **Top-down orthographic camera** — pan and zoom, ideal for large-scale editing
- **Toggle** — press Q to switch between modes
- **Go To Landblock** — Ctrl+G, enter a hex ID or X,Y coordinates
- **Location search** — search named locations (towns, dungeons, landmarks) and teleport to them
- **Camera bookmarks** — save and recall camera positions
- **Position HUD** — shows current coordinates in the viewport
- **Grid overlay** — landblock boundaries (magenta) and cell boundaries (cyan)
- **Overlay toggles** — grid, static objects, scenery, dungeons, unwalkable slopes
- Camera position and mode saved between sessions

### Projects

- Point at your base DAT directory, name your project, and go
- Recent projects list on the splash screen
- All project data stored in a local SQLite database

### Performance

- Streaming terrain chunks — only nearby chunks loaded, distant ones unloaded
- Background geometry generation — no frame stalls during terrain loading
- Frustum culling — only visible static objects are rendered
- Two-phase GPU upload — models load in background, upload to GPU in batches
- Texture disk cache — processed RGBA data cached to disk after first load
- Camera-aware streaming — top-down loads the visible rectangle, perspective uses proximity
- Zoom-scaled scenery — trees and rocks appear at appropriate zoom levels, buildings load everywhere
- Load/unload hysteresis — prevents objects flickering at view distance edges
- Distance-prioritized loading — closest landblocks load first
- Capped batch sizes and max loaded landblocks to keep memory and frame times stable

---

## Controls

### Camera

| Action | Key |
|---|---|
| Move forward / back / left / right | W / S / A / D or Arrow Keys |
| Rotate camera (perspective) | Shift + Arrow Keys, or mouse look |
| Move up | Space |
| Move down | Shift (held) |
| Toggle perspective / top-down | Q |
| Zoom in / out | Mouse wheel, or + / - |

### Editing

| Action | Key |
|---|---|
| Go to landblock | Ctrl+G |
| Undo | Ctrl+Z |
| Redo | Ctrl+Shift+Z or Ctrl+Y |
| Copy | Ctrl+C |
| Paste | Ctrl+V |
| Delete | Delete |
| Cancel / deselect | Escape |
| Multi-select | Ctrl+Click |
| Box select | Click and drag |
| Rotate stamp | [ / ] |
| Lower terrain (with raise tool) | Shift+Left-Click |
| Context menu | Right-Click |

---

## Default Settings

| Setting | Default |
|---|---|
| Projects directory | `Documents/ACME WorldBuilder/Projects` |
| History limit | 50 |
| Max draw distance | 4,000 units |
| Field of view | 60° |
| Mouse sensitivity | 1.0 |
| Movement speed | 1,000 units/sec |
| Light intensity | 0.45 |
| Grid visible | Yes |
| Grid opacity | 40% |
| Static objects visible | Yes |
| Scenery visible | Yes |
| Dungeons visible | Yes |
| Building interiors visible | No |
| Slope highlight | Off (threshold 45°) |
| Stamp library size | 10 |

All settings are configurable in the Settings panel and persist between sessions.

---

## Project Structure

```
WorldBuilder-ACME-Edition/
├── WorldBuilder/                  # GUI application (Avalonia UI)
├── WorldBuilder.Shared/           # Shared services, algorithms, and data models
│   ├── Services/                  #   ITerrainService, IObjectPlacementService, IDungeonService, etc.
│   ├── Lib/                       #   Pure algorithms (terrain, dungeon, validation, ontology)
│   │   ├── Terrain/               #     TerrainAlgorithms, SceneryAlgorithms, StampAlgorithms
│   │   ├── Dungeon/               #     PortalSnapAlgorithms, DungeonRoomAnalyzer
│   │   └── Validation/            #     ValidationEngine (34 diagnostic codes)
│   └── Documents/                 #   SQLite-backed document storage
├── WorldBuilder.Terminal/         # Headless CLI (batch, REPL, agent stdin mode)
│   ├── Program.cs                 #   Entry point — mode routing
│   ├── CommandEngine.cs           #   Shared business logic for all commands
│   ├── JsonCommandProcessor.cs    #   stdin/stdout JSON-line protocol handler
│   ├── TerminalRepl.cs            #   Human-friendly interactive REPL
│   └── HeadlessProjectManager.cs  #   DI-based project management
├── WorldBuilder.Windows/          # Windows platform target
├── WorldBuilder.Mac/              # macOS platform target
├── WorldBuilder.Linux/            # Linux platform target
├── WorldBuilder.Browser/          # Experimental browser/WASM build target
├── WorldBuilder.Tests/            # xUnit tests for shared services and algorithms
├── pipeline_data/                 # ML models, heightmaps, training data (Git LFS)
│   ├── models/                    #   V1/V2/V3 + scene placer + settlement planner weights
│   ├── heightmaps/                #   Extracted terrain data (JSONL)
│   ├── data/                      #   Biome grids, feature catalogs
│   ├── enrichment/                #   Calibration codebooks, unified ontology, baselines
│   ├── reference/                 #   Retail dungeon topology, placement tensors, vocabs
│   └── population_output/         #   Generated population runs and summaries (gitignored)
├── scripts/                       # Python ML & worldgen scripts
│   ├── PopulationPipeline/        #   Staged population pipeline (the ML home)
│   │   ├── OutdoorML/             #     Scene-placer transformer + planner
│   │   ├── WorldGrammar/          #     Retail world-grammar prior
│   │   ├── Interiors/             #     Interior support / micro-placement research
│   │   ├── Planning/              #     Heuristic + semantic planning passes
│   │   ├── MacroPlacement/        #     Deterministic reseed/remap helpers
│   │   ├── Scatter/ Encounters/   #     Stage placeholders
│   │   └── Validation/            #     Eval-time scoring harness
│   ├── train_terrain_v3.py        #   Train V3 conditional diffusion model
│   ├── smooth_vanquish_v3.py      #   Apply V3 smoothing to QuickWorld terrain
│   └── train_terrain_unet.py      #   Train V1 U-Net model
├── tools/                         # Browser-based utilities (zero-dependency)
│   ├── town_placer.html           #   Interactive town placement
│   └── heightmap_extractor.html   #   Heightmap extraction helper
├── town_kits/                     # Per-town placement kits driving the population pipeline
├── external/                      # Vendored third-party data (e.g. LSD-Partial)
├── docs/                          # Documentation
│   ├── HowToMakeNewWorlds.md      #   World generation pipeline guide
│   ├── agent_api_reference.md     #   Full command reference (1,400+ lines)
│   ├── agent_api_schema.json      #   JSON schema for all commands
│   └── PopulationPipeline*.md     #   ML pipeline strategy / progress notes
├── tests/                         # Integration test suites
│   ├── test_agent_protocol.py     #   Python: 50+ protocol tests
│   └── Test-AgentProtocol.ps1     #   PowerShell: ~25 smoke checks
└── projects/                      # World projects
    └── TestProject/               #   Sample project with retail DATs
```

---

## Building

Requires .NET 8.0 SDK or later.

```
dotnet build WorldBuilder.slnx
```

### Running the GUI

```
dotnet run --project WorldBuilder.Windows
```

Platform-specific projects are also available: `WorldBuilder.Windows` (recommended), `WorldBuilder.Mac`, `WorldBuilder.Linux`.

### Running the Terminal

```bash
# Interactive REPL
dotnet run --project WorldBuilder.Terminal

# Batch export
dotnet run --project WorldBuilder.Terminal -- --project MyWorld.wbproj --export ./output

# Agent mode (stdin/stdout JSON)
dotnet run --project WorldBuilder.Terminal -- --stdin --project MyWorld.wbproj
```

---

## Thanks

- **Vanquish-6** — this project is forked from [Vanquish-6/WorldBuilder-ACME-Edition](https://github.com/Vanquish-6/WorldBuilder-ACME-Edition)
- **Trevis** — original WorldBuilder vision and groundwork (DatReaderWriter + the base that this all grew from, before the big refactor...)
- **Gmriggs** — testing, research, and invaluable AC knowledge
- **Advan** — testing and bug reports
- **Vermino** — PRs and code contributions
- **The AC community** — everyone who has contributed, tested, reported bugs, or just kept Dereth going. If you helped and aren't listed, you know who you are.
