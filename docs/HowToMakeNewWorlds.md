# How To Make New Worlds

> The complete pipeline for generating custom Asheron's Call worlds using AI image generation + ML terrain smoothing.
> Hardware: GTX 1070 (8 GB VRAM) or better. Total time: ~30 minutes for a full world.

---

## Overview

The pipeline converts an AI-generated world map image into a playable Asheron's Call world with near-retail terrain quality.

```
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│  1. AI Image     │    │  2. QuickWorld    │    │  3. V3 Smooth    │    │  4. Apply + Town │
│                  │    │                  │    │                  │    │    Placer         │
│  Generate new    │───▶│  Image → terrain │───▶│  Fix jagged      │───▶│  Write back to   │
│  world map with  │    │  type + height   │    │  edges with      │    │  project, place  │
│  AI (Nano etc.)  │    │  (terminal cmd)  │    │  V3 diffusion    │    │  towns, export   │
└──────────────────┘    └──────────────────┘    └──────────────────┘    └──────────────────┘
```

**Why this works:** The V3 diffusion model was intentionally overtrained on retail heightmaps. At ~15% diffusion strength, this "overtrained" property becomes a feature — it smooths the harsh pixel-aligned edges from QuickWorld while preserving the terrain's macro structure. The result is terrain that looks and feels like retail Asheron's Call.

---

## Prerequisites

Before starting, make sure you have:

- **Retail DAT files** — `cell_1.dat`, `portal.dat`, etc. (the original game data)
- **.NET 8.0 SDK** — `dotnet build WorldBuilder.Terminal`
- **Python 3.10+** with PyTorch and NumPy — `pip install torch numpy`
- **A GPU** — GTX 1070 (8 GB VRAM) or better. CPU works but is much slower.
- **A WorldBuilder project** — Created from the retail DATs (via the GUI or Terminal)

The repository includes all ML model weights and training data via Git LFS. After cloning, run:

```bash
git lfs pull
```

This downloads (~530 MB):
- V3 diffusion model weights (`pipeline_data/models/v3/terrain_diffusion_v3.pt`)
- V1 U-Net model weights (`pipeline_data/models/v1/terrain_unet.pt`)
- Retail heightmap training data (`pipeline_data/heightmaps/retail_heightmaps.jsonl`)
- Retail biome conditioning data (`pipeline_data/data/retail_biomes.npy`)
- Retail dungeon topology (`pipeline_data/reference/retail_dungeon_topology.json`)

---

## Step 1: Generate a World Map Image

Use **Google Nano / Banana 2** (or any AI image generator capable of pixel-level fidelity) to generate a new world map.

### Approach

1. Take the retail Dereth world map as a reference image (render one via ACViewer `--map`, or take a screenshot from the WorldBuilder GUI map view)
2. Prompt the AI: *"Keep this pixel perfect but randomize the terrain layout. Maintain the same color palette and ocean boundaries."*
3. The AI will produce a new world map with different terrain distribution but the same visual style

### Requirements for the Output Image

- **Resolution:** 2041×2041 pixels is ideal (1 pixel = 1 terrain vertex, exact match). Other sizes work but are bilinearly scaled.
- **Format:** PNG (lossless). Never use JPEG — lossy compression corrupts ocean pixel detection.
- **Ocean colors must be preserved exactly.** The game engine identifies ocean by exact pixel color (`#3B211D` ±5 per channel). If the AI modifies these pixels, those areas become invisible voids in-game.

> **TIP:** If the AI struggles with exact color preservation, you can generate the land freely and then paste the original ocean pixels back using a mask. The `scripts/generate_ocean_mask.py` script can create a B&W mask from any source map.

### The Impassable Color Palette

These pixel colors are hardcoded in the game engine and **must not appear on landmass pixels**:

| Type | Hex | R | G | B | Tolerance | How Detected |
|---|---|---|---|---|---|---|
| **Ocean** | `#3B211D` | 59 | 33 | 29 | ±5 per channel | Flood-fill from image border |
| **Impassable Water** | `#363C1D` | 54 | 60 | 29 | ±10 per channel | Exact color match (inland bodies) |

### The Land Biome Color Palette

These are the approximate color ranges that `ClassifyBiome` maps to terrain types:

| Biome | Approximate Color | Hue | Sat | Bri | DAT Type ID | DAT Name |
|---|---|---|---|---|---|---|
| `forest` | Dark teal | 130–210° | >0.12 | 0.20–0.60 | `0x03` | `LushGrass` |
| `grassland` | Lighter teal/green | 100–210° | >0.08 | >0.45 | `0x01` | `Grassland` |
| `snow` | White / light grey | any | <0.15 | >0.65 | `0x0F` | `Snow` |
| `swamp` | Dark blue-grey | 185–225° | >0.55 | <0.35 | `0x04` | `MarshSparseSwamp` |
| `water` | Bright blue | 170–250° | >0.45 | >0.75 | `0x10` | `WaterRunning` |
| `desert` | Warm olive/sandy | 25–70° | >0.15 | 0.35–0.70 | `0x0A` | `SandYellow` |
| `barren` | Mid grey | any | <0.18 | 0.28–0.70 | `0x0D` | `SedimentaryRock` |
| `obsidian` | Very dark with tint | any | <0.35 | 0.10–0.25 | `0x06` | `ObsidianPlain` |
| `mountain` | Bright desaturated | any | <0.30 | >0.55 | `0x0E` | `SemiBarrenRock` |
| `road` | Orange/gold | 15–55° | >0.5 | >0.4 | `0x07` | `PackedDirt` |

> **NOTE:** These colors don't need to be exact — `quick-world` uses a calibration codebook (built from the actual DAT textures) for classification, not these HSB ranges. The ranges above are for `analyze-map-image`, which is the older approach. The QuickWorld codebook is more accurate.

---

## Step 2: Build the Calibration Codebook

The codebook maps pixel colors to terrain types and heights. It's built by scanning the retail DAT data.

```bash
# Start the terminal with your project
dotnet run --project WorldBuilder.Terminal

# Inside the terminal:
calibrate-world-map
```

**Output:** `pipeline_data/enrichment/terrain_codebook.json` (~13 KB)

This file encodes:
- **Terrain base colors** — the average RGB color of each terrain type's texture (extracted from the DAT)
- **Height distributions** — per-terrain-type percentile tables mapping brightness → height index
- **Lighting constants** — the shading parameters used by the ACViewer map renderer

You only need to run this once per set of retail DATs. The codebook is deterministic.

---

## Step 3: QuickWorld — Convert Image to Terrain

This is the core reverse-engineering step. `quick-world` reads your AI-generated image and the codebook, then stamps every landblock with terrain types and heights.

```bash
# In the WorldBuilder Terminal (with your project loaded):
quick-world pipeline_data/enrichment/terrain_codebook.json your_new_world_map.png
```

Or with a seed for reproducibility:

```bash
quick-world pipeline_data/enrichment/terrain_codebook.json your_new_world_map.png 42
```

### What it does (per vertex, 255×255 landblocks × 81 vertices each):

1. **Classifies terrain type** — matches the pixel's RGB to the nearest codebook base color (Euclidean distance)
2. **Estimates height** — maps pixel brightness (0–1) linearly to height index (0–255), with ±2 random noise for micro-variation
3. **Scatters scenery** — places 1–4 biome-appropriate objects per landblock (trees, rocks, bushes)

### Output

The terrain is written directly to the project's terrain document in memory. The console shows:
- Terrain type distribution
- Number of stamped vs skipped landblocks
- Approximate color matches (warnings when pixel colors are far from any codebook entry)

**At this point you have a complete world — but with jagged, pixel-aligned terrain boundaries.** Step 4 fixes this.

---

## Step 4: Extract Heightmaps for V3 Smoothing

Extract the QuickWorld terrain as JSONL so the Python V3 smoother can process it:

```bash
# In the WorldBuilder Terminal:
extract-retail-heightmaps pipeline_data/heightmaps/my_world_heightmaps.jsonl
```

This dumps all 255×255 landblocks as a JSONL file where each line contains:
- `lbX`, `lbY` — landblock coordinates
- `heightIndices` — 81 height values (9×9 grid)
- `terrainTypes` — 81 terrain type IDs
- `roadFlags` — road presence flags

---

## Step 5: V3 Terrain Diffusion Smoothing

The V3 model is a conditional DDPM (Denoising Diffusion Probabilistic Model) trained on retail heightmaps. It uses **SDEdit** — start from a noisy version of the input and denoise partially — to smooth terrain while preserving its structure.

```bash
python scripts/smooth_vanquish_v3.py \
    --input pipeline_data/heightmaps/my_world_heightmaps.jsonl \
    --output pipeline_data/heightmaps/my_world_smoothed.jsonl \
    --batch 32
```

### How the smoother works

Each landblock is classified by average height into a terrain zone, and the V3 diffusion strength is set per zone:

| Zone | Height Range | V3 Strength | Why |
|---|---|---|---|
| Low / coastal | h < 30 | 15% | Already flat, minimal artifacts |
| Mid-low / plains | 30–60 | 35% | **Worst QuickWorld artifacts** — needs aggressive smoothing |
| Mid / hills | 60–100 | 25% | Moderate smoothing for pixel edges |
| Mid-high / foothills | 100–150 | 20% | Preserve elevation while smoothing |
| High / mountains | h ≥ 150 | 10% | Preserve dramatic peaks, barely touch |

The model conditions on:
- **Neighbor heightmaps** — the 4 adjacent landblocks (builds from retail heightmaps for context)
- **Biome cluster ID** — from `pipeline_data/data/retail_biomes.npy`

### Hardware & Performance

- **GTX 1070 (8 GB VRAM):** ~5 minutes for the full grid at batch size 32
- **GPU memory:** ~3 GB peak
- **Batch size:** Default 32. Reduce to 16 or 8 if you hit OOM.

### Output

`my_world_smoothed.jsonl` — same format as the input, with smoothed height indices. Terrain types and road flags are preserved unchanged.

The script prints before/after height statistics so you can verify the smoothing didn't distort the terrain distribution.

---

## Step 6: Apply Smoothed Heightmaps

Write the V3-smoothed heightmaps back to your project using the Terminal's `--stdin` JSON protocol:

```bash
python scripts/apply_vanquish_smoothed.py
```

> **NOTE:** This script is currently hardcoded to `projects/vanquishtest/vanquishtest.wbproj`. To use a different project, edit the `PROJECT_FILE` path at the top of the script, or apply manually via the Terminal REPL using `set-landblock-heightmap`.

### What the apply script does

1. Starts `WorldBuilder.Terminal` in `--stdin` mode with the project loaded
2. For each landblock in the smoothed JSONL:
   - Sends `set-landblock-heightmap` with the smoothed height values
   - Sends `set-landblock-terrain` with the terrain types (if present)
3. Runs `export` to write the modified DATs

Progress is printed every 10 seconds with rate (blocks/sec) and ETA.

### Manual alternative

If you prefer, apply heightmaps via the Terminal REPL by writing your own loop, or use the `--stdin` JSON protocol directly from your own script. The relevant commands are:

```json
{"command": "set-landblock-heightmap", "lbX": 100, "lbY": 100, "heights": [81 values...]}
{"command": "set-landblock-terrain", "lbX": 100, "lbY": 100, "types": [81 values...]}
{"command": "export", "directory": "D:\\ACE\\Dats"}
```

---

## Step 7: Export DAT Files

If the apply script didn't already export, or you want to export to a different directory:

```bash
# In the WorldBuilder Terminal:
export D:\ACE\Dats
```

This writes the modified `cell_1.dat` (terrain) and optionally object landblock data. Copy these DATs to your ACE server's data directory.

---

## Step 8: Place Towns (Optional)

Open **`tools/town_placer.html`** in any browser. This is a zero-dependency HTML tool that lets you:

1. Select towns from the sidebar (overworld buildings, envcells, portals)
2. Click to place them on the world map
3. Drag to reposition
4. Export the placement as JSON

The exported JSON feeds into the Terminal's building remap pipeline:

```bash
# In the WorldBuilder Terminal:
remap-buildings-v2 pipeline_data/population_output/lb_remap.json
export D:\ACE\Dats
remap-buildings-sql pipeline_data/population_output/lb_remap.json D:\ACE\Dats building_remap.sql --apply
ace-db reposition
```

---

## Quick Reference: Full Pipeline

```bash
# ── STEP 1: Generate world map image with AI (external) ──
# Use Google Nano / Banana 2 with the retail map as reference
# Output: your_new_world.png (2041×2041 PNG)

# ── STEP 2: Build calibration codebook (once per DAT set) ──
# In WorldBuilder Terminal:
calibrate-world-map

# ── STEP 3: Reverse-engineer terrain from image ──
# In WorldBuilder Terminal:
quick-world pipeline_data/enrichment/terrain_codebook.json your_new_world.png

# ── STEP 4: Extract heightmaps for smoothing ──
# In WorldBuilder Terminal:
extract-retail-heightmaps pipeline_data/heightmaps/my_world_heightmaps.jsonl

# ── STEP 5: V3 terrain diffusion smoothing ──
python scripts/smooth_vanquish_v3.py \
    --input pipeline_data/heightmaps/my_world_heightmaps.jsonl \
    --output pipeline_data/heightmaps/my_world_smoothed.jsonl

# ── STEP 6: Apply smoothed heightmaps + export ──
# Edit apply_vanquish_smoothed.py to point at your project, then:
python scripts/apply_vanquish_smoothed.py

# ── STEP 7: (Optional) Place towns ──
# Open tools/town_placer.html in browser, export placement JSON
# In WorldBuilder Terminal:
remap-buildings-v2 pipeline_data/population_output/lb_remap.json
export D:\ACE\Dats
ace-db reposition
```

---

## File Locations

| File | Purpose |
|---|---|
| `pipeline_data/models/v3/terrain_diffusion_v3.pt` | V3 diffusion model weights (232 MB, Git LFS) |
| `pipeline_data/models/v3/terrain_v3_config.json` | V3 model configuration |
| `pipeline_data/models/v1/terrain_unet.pt` | V1 U-Net model weights (62 MB, Git LFS) |
| `pipeline_data/heightmaps/retail_heightmaps.jsonl` | Retail heightmap training data (61 MB, Git LFS) |
| `pipeline_data/data/retail_biomes.npy` | Biome conditioning grid (260 KB) |
| `pipeline_data/data/retail_biome_info.json` | Biome cluster metadata (5 KB) |
| `pipeline_data/enrichment/terrain_codebook.json` | Calibration codebook (generated by `calibrate-world-map`) |
| `scripts/smooth_vanquish_v3.py` | V3 smoothing script |
| `scripts/apply_vanquish_smoothed.py` | Applies smoothed heightmaps to project via Terminal stdin |
| `scripts/train_terrain_v3.py` | V3 model training script (also defines model classes) |
| `scripts/derive_retail_biomes.py` | Generates `retail_biomes.npy` from heightmap data |
| `tools/town_placer.html` | Browser-based town placement tool |

---

## Troubleshooting

**CUDA out of memory during V3 smoothing**
Reduce batch size: `--batch 16` or `--batch 8`. The V3 model uses ~3 GB VRAM at batch 32. If you're on a card with less than 6 GB VRAM, use `--batch 4` or run on CPU (much slower).

**QuickWorld produces mostly one terrain type**
The codebook may not match your image's color palette well. Run `calibrate-world-map` with the correct retail DATs loaded, and ensure your AI-generated image uses colors in the same range as the original retail map.

**V3 smoothing makes terrain too flat**
The default strength levels are tuned for typical QuickWorld output. If your terrain is already smooth, the smoother may over-flatten. You can edit the `HEIGHT_BANDS` strength values in `smooth_vanquish_v3.py` — lower values = less smoothing.

**V3 smoothing doesn't fix enough**
Increase the strength values in `HEIGHT_BANDS`. The mid-low/plains band (30–60) defaults to 35% — try 50% for more aggressive smoothing.

**`retail_biomes.npy` is missing**
This file should be included in the repo. If it's missing, regenerate it:

```bash
python scripts/derive_retail_biomes.py
```

This reads `retail_heightmaps.jsonl` and clusters the terrain into 12 biome types using K-means. Takes about 30 seconds.

**`terrain_codebook.json` is missing**
Run `calibrate-world-map` in the Terminal with your retail DATs loaded. This scans the DAT textures and terrain data to build the codebook.

**Apply script fails to connect to Terminal**
Make sure the Terminal is built in Release mode:

```bash
dotnet build WorldBuilder.Terminal -c Release
```

The apply script looks for the exe at `WorldBuilder.Terminal/bin/Release/net8.0/WorldBuilder.Terminal.exe`.

---

## Retraining the V3 Model

If you want to retrain the V3 model from scratch (e.g., on different terrain data):

```bash
# 1. Extract heightmaps from retail DATs
extract-retail-heightmaps pipeline_data/heightmaps/retail_heightmaps.jsonl

# 2. Derive biome clusters from the heightmap data
python scripts/derive_retail_biomes.py

# 3. Train the V3 diffusion model
python scripts/train_terrain_v3.py \
    --data pipeline_data/heightmaps/retail_heightmaps.jsonl \
    --output pipeline_data/models/v3/terrain_diffusion_v3.pt
```

Training takes 10–30 minutes on a GTX 1070. The model converges quickly because the retail terrain data is relatively uniform. This is actually desirable — the V3 model works best as a **smoother** (not a generator) at low diffusion strength.

The training script saves checkpoints and a loss plot (`training_v3.png`). EMA (Exponential Moving Average) weights are used for the final model to ensure stable generation.

---

## Legacy: Stable Diffusion Approach

> **NOTE:** The pipeline described below is the **older approach** that used Stable Diffusion for inpainting. It has been superseded by the AI image generation + QuickWorld + V3 smoothing pipeline above. This section is retained for historical reference.

The original approach was:
1. Generate an ocean mask from the source map
2. Use Stable Diffusion WebUI (inpaint upload) to paint new terrain on the land areas
3. Quantize the AI output to exact biome palette colors
4. Re-composite the original ocean pixels
5. Run `analyze-map-image` + `compose-world`

This approach had several limitations:
- Required Stable Diffusion WebUI installed locally
- Generated smoother images but lost terrain micro-detail
- Required manual quantization and ocean re-compositing steps
- Did not include ML-based terrain smoothing

The modern pipeline (above) is simpler, faster, and produces better results.
