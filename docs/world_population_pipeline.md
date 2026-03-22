# World Population Pipeline

**Date:** March 6, 2026  
**Status:** Implemented & Tested  
**Build:** 0 errors, 0 warnings

---

## Overview

The World Population Pipeline takes a bare procedurally-generated terrain and fills it with
culturally appropriate buildings, biome-matched creatures, and scenery — all driven by data
extracted from the retail Asheron's Call game files. No hallucinations, no guessing. Every
placement decision traces back to tagged ontology data.

The pipeline is **world-independent**: it learns *what* each 3D model is (Sho pagoda, Aluvian
cottage, Drudge Skulker) from retail data, then places those models wherever *your* new world's
design dictates.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     DATA EXTRACTION (one-time)                  │
│                                                                 │
│  Retail DATs ──► scan-ontology ──► OntologyService (in-memory)  │
│  LSD Weenies ──► build_ontology_enrichment.py                   │
│                      ├── canonical_enrichment.json (12,648 obj) │
│                      └── architecture, biome, behavior, tier    │
│  Retail DATs ──► scan-building-placements                       │
│                      └── building_placements.jsonl (6,979 bldg) │
│                 ──► scan_building_cultures.py                    │
│                      └── building_culture_map.json (398 models) │
├─────────────────────────────────────────────────────────────────┤
│                     WORLD DESIGN (per world)                    │
│                                                                 │
│  User Config ──► build_difficulty_gradient.py                   │
│                      ├── difficulty_gradient.json (255×255)     │
│                      └── difficulty_gradient.png (visual)       │
│  User Config ──► cultural_zones.json (optional, auto-generated) │
├─────────────────────────────────────────────────────────────────┤
│                     PLAN & APPLY                                │
│                                                                 │
│  All Data ────► build_population_plan.py                        │
│                      └── population_plan.json (110K+ objects)   │
│  Plan ────────► apply-population (C# terminal command)          │
│                      └── Static objects placed into landblocks  │
│  Landblocks ──► export (existing command)                       │
│                      └── DAT files for ACE server               │
└─────────────────────────────────────────────────────────────────┘
```

---

## Quick Start

```bash
# ── Step 1: Extract & Tag (one-time) ──────────────────────────

# Generate canonical enrichment from LSD weenie data
python scripts/build_ontology_enrichment.py

# Scan building positions from retail DATs (in WorldBuilder terminal)
wb> load TestProject/TestProject.wbproj
wb> scan-building-placements

# Geocode buildings to cultural architectures
python scripts/scan_building_cultures.py

# ── Step 2: Design Your World ─────────────────────────────────

# Generate difficulty gradient (edit anchors in script or use config)
python scripts/build_difficulty_gradient.py

# ── Step 3: Generate & Apply ──────────────────────────────────

# Build the population plan
python scripts/build_population_plan.py

# Preview what would be placed (dry run)
wb> apply-population population_plan.json --dry-run

# Apply for real
wb> apply-population population_plan.json

# Export to DAT files
wb> export
```

---

## Data Files Reference

### Extraction Outputs (one-time, world-independent)

| File | Size | Contents |
|------|------|----------|
| `canonical_enrichment.json` | 9.3 MB | 12,648 weenie objects with full tags |
| `building_placements.jsonl` | ~500 KB | 6,979 building instances with world XY |
| `building_culture_map.json` | 106 KB | 398 unique building models → architecture |

### World Design Inputs (per world)

| File | Size | Contents |
|------|------|----------|
| `difficulty_gradient.json` | 192 KB | 255×255 grid of difficulty tiers (0-5) |
| `difficulty_gradient.png` | ~15 KB | Visual heatmap for design review |
| `cultural_zones.json` | optional | 255×255 grid of cultural assignments |

### Plan Output

| File | Size | Contents |
|------|------|----------|
| `population_plan.json` | ~26 MB | Per-landblock object placement list |

---

## Terminal Commands

All commands are available in both the interactive REPL and JSON command processor.

### `enrich-canonical <path>`
Merges canonical enrichment data (architecture, biome, behavior, difficulty tier,
creature family) into the live ontology.

```
wb> enrich-canonical canonical_enrichment.json
```

### `scan-building-placements [output]`
Scans all 255×255 retail landblocks from the cell DAT, extracts every building's
Setup ID and world position. Writes `building_placements.jsonl`.

```
wb> scan-building-placements
```

**Performance:** ~1.6 seconds for the full world scan.

### `difficulty-gradient [path]`
Loads and validates a difficulty gradient JSON file. Reports the tier distribution.

```
wb> difficulty-gradient
wb> difficulty-gradient custom_gradient.json
```

### `apply-population <plan-path> [--dry-run]`
Applies a population plan to the current world. Places static objects (scenery,
structures) into landblock documents. Creatures are counted but skipped — they
require ACE server-side weenie spawn entries.

```
wb> apply-population population_plan.json --dry-run    # preview only
wb> apply-population population_plan.json              # apply for real
```

---

## Ontology Tags

Every object in the canonical enrichment has these fields:

| Field | Values | Example |
|-------|--------|---------|
| `architecture` | Aluvian, Sho, Gharu'ndim, Viamontian, Empyrean, Neutral | `"Sho"` |
| `biome` | Temperate, Arid, Snowy, Swamp, Underground, Coastal, Any | `["Temperate", "Swamp"]` |
| `type` | Creature, NPC, NPC_Vendor, Scenery_Tree, Scenery_Rock, Structure, Interactive_Portal, Prop, Furniture_Light, etc. | `"Creature"` |
| `behavior` | Melee, Missile, Magic, Mixed, Passive, Vendor | `"Melee"` |
| `difficulty_tier` | Starter, Low, Medium, Hard, Elite, Legendary | `"Medium"` |
| `creature_family` | drudge, banderling, olthoi, golem, undead, etc. | `"olthoi"` |
| `level` | 1-275 | `50` |

---

## Difficulty Tiers

The difficulty gradient maps every landblock to one of six tiers:

| Tier | Level Range | Color | Description |
|------|-------------|-------|-------------|
| **Starter** | 1-15 | Green | Safe zones around starter towns |
| **Low** | 16-40 | Yellow-green | Surrounding farmlands, roads |
| **Medium** | 41-80 | Gold | Mid-game exploration areas |
| **Hard** | 81-130 | Orange | Dangerous wilderness |
| **Elite** | 131-200 | Red | Remote strongholds, deep forest |
| **Legendary** | 200+ | Purple | Endgame zones, world edges |

### Customizing the Gradient

Edit the `DEFAULT_ANCHORS` in `scripts/build_difficulty_gradient.py` or pass a config JSON:

```json
{
  "anchors": [
    {"lbX": 100, "lbY": 100, "tier": 0, "label": "Central Starter Town"},
    {"lbX": 200, "lbY": 200, "tier": 4, "label": "Northeastern Fortress"},
    {"lbX": 30,  "lbY": 230, "tier": 5, "label": "Legendary Wastes"}
  ],
  "zone_widths": [10, 20, 35, 50, 70],
  "ocean_mask": "ocean_mask.png"
}
```

**Zone widths** control how quickly difficulty escalates from each anchor:
- From a Starter anchor: 0-10 LBs = Starter, 10-20 = Low, 20-35 = Medium, etc.
- Multiple anchors overlap — the **lowest** difficulty wins at any point.

---

## Building Culture Map

The building culture scanner uses a **voting system** to determine each 3D model's
cultural affiliation:

1. Scans all 6,979 building placements from retail landblocks
2. For each placement, finds the nearest cultural town
3. If within 5 landblocks → high-confidence vote (×3 weight)
4. If within 15 landblocks → medium-confidence vote (×1 weight)
5. The culture with the most votes wins

### Distribution (Retail AC)

| Architecture | Models | Description |
|---|---|---|
| Neutral | 246 | Wilderness structures, ruins, generic |
| Aluvian | 65 | Medieval European style |
| Gharu'ndim | 29 | Middle Eastern / North African style |
| Viamontian | 22 | Italian Renaissance style |
| Sho | 19 | East Asian style |
| Empyrean | 17 | Ancient/magical style |

---

## Population Plan Details

The plan generator uses three parameters per landblock:

1. **Difficulty tier** → determines creature level range and density
2. **Cultural zone** → determines building style and NPC culture
3. **Biome** → determines which creatures and scenery are appropriate

### Density Profiles

| Tier | Scenery | Creatures | Structures | Spawn Rate |
|------|---------|-----------|------------|------------|
| Starter | 4-8 | 2-4 | 0-1 | 70% of LBs |
| Low | 3-7 | 2-5 | 0-1 | 50% |
| Medium | 3-6 | 3-6 | 0-1 | 40% |
| Hard | 2-5 | 3-7 | 0-1 | 30% |
| Elite | 2-4 | 4-8 | 0 | 20% |
| Legendary | 1-3 | 4-9 | 0 | 15% |

### Selection Algorithm

For creatures, the selector scores each candidate:
- **+5** if the creature's biome matches the landblock biome
- **+2** if the creature's culture matches the zone (or is Neutral)
- **+1** base score

Higher-scored candidates are selected with proportionally higher probability,
creating natural biome-appropriate distributions without being perfectly uniform.

---

## Creature Spawns vs. Static Objects

The population plan contains two categories of placements:

| Category | Placed by `apply-population` | Notes |
|---|---|---|
| **Scenery** (trees, rocks, props) | ✅ Yes — static DAT objects | Visible in-game immediately |
| **Structures** (buildings) | ✅ Yes — static DAT objects | Rendered from Building models |
| **Creatures** | ❌ Skipped | Require ACE server weenie spawn entries |

Creatures need to be spawned by the ACE server, not placed as static DAT objects.
The plan includes creature entries with all metadata (Setup ID, name, tier, position)
so they can be exported to SQL insert statements for the ACE `biota` table.

---

## File Locations

All scripts are in `scripts/`:

```
scripts/
  build_ontology_enrichment.py     # Tag weenies → canonical_enrichment.json
  scan_building_cultures.py        # Geocode buildings → building_culture_map.json
  build_difficulty_gradient.py     # Generate difficulty zones
  build_population_plan.py         # Generate placement plan
```

All C# commands are in `WorldBuilder.Terminal/`:

```
CommandResults.cs          # Result record types
CommandEngine.cs           # Command implementations
TerminalRepl.cs            # REPL dispatch + handlers + help
JsonCommandProcessor.cs    # JSON dispatch + handlers + help
```

Ontology service extensions in `WorldBuilder.Shared/`:

```
Services/IOntologyService.cs    # Interface (+EnrichFromCanonical)
Services/OntologyService.cs     # Implementation
Models/OntologyEntry.cs         # Data model (+Architecture, Biome, Behavior, CreatureFamilyName)
```

---

## Future Enhancements

- **Height snapping**: The C# applier currently places objects at Z=0. Integrate with
  `terrain sample-height` to snap objects to the actual terrain surface.
- **Creature spawn SQL export**: Generate ACE-compatible SQL from the creature entries
  in the population plan.
- **Interactive objects**: Portals, chests, and signs are tagged in the ontology but not
  yet placed by the plan generator. Add selection logic for these.
- **Wiki enrichment** (P1): Parse AC wiki infoboxes for narrative data — dungeon themes,
  NPC lore, quest descriptions.
- **Retail difficulty analysis**: Run `python scripts/build_difficulty_gradient.py --retail`
  to compute the actual difficulty gradient from retail spawn data (requires
  `spawn_map_summary.jsonl`).
- **Biome map integration**: Currently infers biome from Y-coordinate latitude. Connect
  to `biome_map.json` for terrain-accurate biome classification.
