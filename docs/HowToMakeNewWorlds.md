# How To Make New Worlds

> A complete pipeline for generating new landmass terrain maps compatible with the WorldBuilder ACME Edition terrain agent.  
> Written for: developers who have access to this repository and want to create a custom world from scratch.


Note a good seed is : 4050594120
---

## Overview

The WorldBuilder terrain agent reads a **world map image** (`screenshots/world_map.png`) and converts it into a `biome_map.json` file. That JSON is then consumed by `compose-world` to stamp retail heightmaps onto the actual game landblocks.

The core constraint is this: **the ocean is sacrosanct**. It is defined by exact pixel colors in the source image. The game engine treats these as impassable, unmodifiable tiles — any deviation from the exact color values will cause misclassification and corrupt the world generation.

Standard AI image generators (Midjourney, DALL-E, etc.) cannot enforce exact RGB values. They produce smooth gradients. So you must **separate AI creativity from programmatic color enforcement**. This document describes how.

---

## Prerequisites

Before starting, make sure you have:

- **Python 3.10+** with `Pillow` installed (`pip install Pillow`)
- **Git** installed
- **Stable Diffusion WebUI** (AUTOMATIC1111) — see [Step 2](#step-2-setup-stable-diffusion-webui) below
- The WorldBuilder Terminal built: `dotnet build WorldBuilder.Terminal/WorldBuilder.Terminal.csproj`
- A source world map image at `screenshots/world_map.png` (2041x2041 pixels)

---

## The Impassable Color Palette

These pixel colors are **hardcoded in the game engine** and must never appear on a landmass.

| Type | Hex | R | G | B | Tolerance | Detection Method |
|---|---|---|---|---|---|---|
| **Ocean** | `#3B211D` | 59 | 33 | 29 | +-5 per channel | Flood-fill from image border + interior body detection |
| **Impassable Water** | `#363C1D` | 54 | 60 | 29 | +-10 per channel | Exact color match (isolated inland bodies) |

The ocean tolerance was tightened from +-8 to +-5 because the coastal boundary pixel `#412722` (delta 6 from ocean) is passable land — at +-8 the flood-fill bled into it.

> **CAUTION:** If any of these colors appear on your landmass in the source image, those tiles will be classified as ocean and **skipped** by `compose-world` entirely. They will be invisible voids in-game.

> **NOTE:** The original Dereth map has NO pure black padding and NO "coastal grey" border. Previous versions of the mask script used HSB-based rules for these, which caused massive false positives on inland dark teal forest, obsidian/volcanic terrain, and mountain pixels. The current v5 script uses only flood-fill + exact color matching.

---

## The Land Biome Color Palette

These are the colors that the `ClassifyBiome` function maps to passable terrain types. When painting a new map (or reviewing AI output), aim for these approximate color characteristics.

| Biome | Approximate Color | Hue | Sat | Bri | DAT Type ID | DAT Name |
|---|---|---|---|---|---|---|
| `forest` | Dark teal | 130–210 deg | >0.12 | 0.20–0.60 | `0x03` | `LushGrass` |
| `grassland` | Lighter teal/green | 100–210 deg | >0.08 | >0.45 | `0x01` | `Grassland` |
| `snow` | White / light grey | any | <0.15 | >0.65 | `0x0F` | `Snow` |
| `swamp` | Dark blue-grey `#132D40` | 185–225 deg | >0.55 | <0.35 | `0x04` | `MarshSparseSwamp` |
| `water` | Bright blue `#6395CE` | 170–250 deg | >0.45 | >0.75 | `0x10` | `WaterRunning` |
| `desert` | Warm olive/sandy | 25–70 deg | >0.15 | 0.35–0.70 | `0x0A` | `SandYellow` |
| `barren` | Mid grey | any | <0.18 | 0.28–0.70 | `0x0D` | `SedimentaryRock` |
| `obsidian` | Very dark with tint | any | <0.35 | 0.10–0.25 | `0x06` | `ObsidianPlain` |
| `mountain` | Bright desaturated | any | <0.30 | >0.55 | `0x0E` | `SemiBarrenRock` |
| `road` | Orange/gold | 15–55 deg | >0.5 | >0.4 | `0x07` | `PackedDirt` |

DAT Type IDs are from `ACE.Server.Physics.Common.LandDefs.TerrainType` — the authoritative source in `ACE-master/Source/ACE.Server/Physics/Common/LandDefs.cs`.

---

## Step 1: Isolate the Ocean Mask

The ocean mask is a strict black-and-white image:
- **Black** = ocean / impassable water (protected, never painted)
- **White** = land (AI can generate freely here)

A script already exists to generate this automatically from any source map:

```bash
python scripts/generate_ocean_mask.py screenshots/world_map.png screenshots/ocean_mask.png
```

This produces two files:
- `screenshots/ocean_mask.png` -- the actual B&W mask to feed into Stable Diffusion
- `screenshots/ocean_mask_preview.png` -- a color preview (red=ocean, green=land) for visual verification

The mask uses a three-pass approach:
1. **Border flood-fill** -- BFS from every image border pixel, growing through ocean-colored pixels (`#3B211D +-5`). This catches the entire exterior ocean without any false positives on inland terrain, regardless of color similarity.
2. **Interior ocean detection** -- Scans for remaining ocean-colored pixel clusters not connected to the border. Any contiguous cluster >= 1,000 pixels is marked as ocean (catches large interior ocean bodies like the 458K-pixel inland sea). Small specks stay as land.
3. **Impassable water exact match** -- Isolated inland water bodies (`#363C1D +-10`) are detected by exact color.

> **TIP:** Open `ocean_mask_preview.png` to visually verify the mask before proceeding. Every landmass should be fully green, every water body fully red. Any red patches inside the landmass mean those pixels will be silently skipped by the terrain agent.

> **WARNING:** Do NOT use per-pixel HSB rules for ocean detection. The dominant Dereth land color (dark teal forest, H~190 S~0.40) and obsidian/volcanic terrain (very dark, R<20) both trigger false positives with HSB-based approaches. Flood-fill from the border is the only reliable method.

---

## Step 2: Setup Stable Diffusion WebUI

> If SD WebUI is already installed and running, skip to Step 3.

Stable Diffusion is already set up at `D:\Clones\stable-diffusion-webui\` with a GTX 1070 configuration.
No reinstallation needed — just launch it:

```
D:\Clones\stable-diffusion-webui\run.bat
```

**First launch** will install Python dependencies (5–10 minutes). A browser window opens automatically at `http://127.0.0.1:7860` when ready.

If the first launch fails with `No module named pip`, run:
```
cd D:\Clones\stable-diffusion-webui
call environment.bat
system\python\python.exe system\python\get-pip.py
system\python\python.exe -m pip install "setuptools<70"
```
Then re-run `run.bat`. The bundled `get-pip.py` bootstraps pip, and setuptools must be < 70 because the CLIP dependency requires the legacy `pkg_resources` module which was removed in setuptools 70+.

### If Setting Up From Scratch (New Machine)

```
# Windows (NVidia GPU):
1. Download: https://github.com/AUTOMATIC1111/stable-diffusion-webui/releases/tag/v1.0.0-pre
   -> sd.webui.zip
2. Extract to D:\Clones\stable-diffusion-webui\
3. Run: update.bat         <- pulls latest code
4. Configure webui\webui-user.bat (see below)
5. Place a .safetensors model in:
   webui\models\Stable-diffusion\
6. Run: run.bat
```

**Recommended `webui-user.bat` for NVidia Pascal (GTX 1070/1080) with 8GB VRAM:**

```batch
@echo off
set PYTHON=
set GIT=
set VENV_DIR=
set COMMANDLINE_ARGS=--xformers --medvram --api --no-half-vae --autolaunch
call webui.bat
```

| Flag | Purpose |
|---|---|
| `--xformers` | Cross-attention speed optimization for Pascal/Turing GPUs |
| `--medvram` | Prevents out-of-memory on large images / inpainting |
| `--api` | Enables REST API on port 7860 for scripted inpainting |
| `--no-half-vae` | Prevents NaN colour artifacts on older NVIDIA cards |
| `--autolaunch` | Opens browser automatically on start |

**Model already downloaded:**
`webui\models\Stable-diffusion\v1-5-pruned-emaonly.safetensors` (SD 1.5 base, 3.97 GB)

---

## Step 3: Generate New Terrain (Inpainting)

With SD WebUI running at `http://127.0.0.1:7860`:

### In the UI

> **CRITICAL:** Use the **"Inpaint upload"** sub-tab, NOT the regular "Inpaint" tab. The regular Inpaint tab makes you draw the mask by hand with a brush. "Inpaint upload" gives you two upload slots -- one for the image, one for the pre-made mask file.

1. Navigate to **img2img** -> **Inpaint upload**
2. Upload `screenshots/world_map.png` into the **Image** slot
3. Upload `screenshots/ocean_mask.png` into the **Mask** slot
4. Configure settings as shown below

### Settings

| Setting | Value | Why |
|---|---|---|
| **Mask mode** | `Inpaint masked` | Paints the WHITE areas of the mask (= land) |
| **Masked content** | `original` | Keeps existing land colors as starting point -- prevents random color fills |
| **Inpaint area** | `Only masked` | Only processes land pixels -- much better quality + fits in 8GB VRAM |
| **Only masked padding** | `32` | Context padding around masked region |
| **Mask blur** | `4` | Slight feathering at mask edges |
| **Resize mode** | `Just resize` | Default |
| **Width** | `512` | Safe for 8GB VRAM. Do NOT try 2041x2041 -- will OOM |
| **Height** | `512` | Safe for 8GB VRAM |
| **Sampling method** | `DPM++ 2M Karras` | Use the **Karras** variant -- fewer artifacts |
| **Sampling steps** | `30` | Higher than default 20 for better quality |
| **CFG Scale** | `7` | How strictly the AI follows the prompt |
| **Denoising strength** | `0.75` | How much the AI changes the land. 0.75 = substantial. Lower = more conservative |
| **Seed** | `-1` | Random. Note the seed of any result you like |

### Recommended Prompts

**Positive prompt:**
```
top-down satellite fantasy world map, dark teal forests, snow capped mountains,
yellow sand desert, winding blue rivers, dark swamp marshland, volcanic obsidian plains,
detailed terrain texture, painterly style, no text, no labels
```

**Negative prompt:**
```
ocean, sea, water, dark brown, blur, noise, text, labels, grid, borders,
photo, 3D, realistic
```

> **IMPORTANT:** Save the seed of any output you like. You can reproduce it exactly by entering the same seed. SD WebUI embeds the seed in the PNG metadata automatically.

### Output

Save your result as `screenshots/world_map_ai.png`. This is the raw AI output -- it will have smooth colour gradients that the terrain agent cannot interpret directly. Steps 4 and 5 fix that.

> **VRAM NOTE:** If you get CUDA out-of-memory errors, switch `--medvram` to `--lowvram` in `webui-user.bat`, or reduce Width/Height to 256. You can upscale afterward in SD WebUI's **Extras** tab using RealESRGAN.

---

## Step 4: Quantize to Exact Biome Colors

The terrain classifier requires pixels to fall within specific HSB ranges. AI-generated images have soft gradients that straddle multiple biome ranges. This step "snaps" every land pixel to the nearest approved biome color.

Create `scripts/quantize_biome_colors.py`:

```python
"""
Snaps every pixel in the AI-generated landmass to the nearest approved
biome palette color, using the ocean_mask to skip ocean pixels.
"""
from PIL import Image
import math

INPUT   = "screenshots/world_map_ai.png"
MASK    = "screenshots/ocean_mask.png"
OUTPUT  = "screenshots/world_map_quantized.png"

# Canonical representative colors for each biome (approximate center of HSB range).
# These must fall within the ranges documented in the palette table.
PALETTE = {
    "forest":    (45,  90,  80),   # Dark teal
    "grassland": (80, 140, 110),   # Lighter green-teal
    "snow":      (230, 235, 240),  # Near-white
    "swamp":     (19,  45,  64),   # #132D40 - exact Blackmire dark blue
    "water":     (99, 149, 206),   # #6395CE - bright river blue
    "desert":    (180, 160, 90),   # Warm sandy olive
    "barren":    (140, 130, 120),  # Mid grey
    "obsidian":  (45,  40,  40),   # Very dark with slight tint
    "mountain":  (190, 185, 180),  # Bright desaturated grey
    "road":      (210, 155, 60),   # Orange-gold
}

PALETTE_COLORS = list(PALETTE.values())

def nearest_color(r, g, b):
    best, best_dist = None, float("inf")
    for color in PALETTE_COLORS:
        d = math.sqrt((r-color[0])**2 + (g-color[1])**2 + (b-color[2])**2)
        if d < best_dist:
            best_dist, best = d, color
    return best

img  = Image.open(INPUT).convert("RGB")
mask = Image.open(MASK).convert("L")
out  = img.copy()

px_img, px_mask, px_out = img.load(), mask.load(), out.load()
w, h = img.size

for y in range(h):
    for x in range(w):
        if px_mask[x, y] > 128:   # white = land, snap it
            r, g, b = px_img[x, y]
            px_out[x, y] = nearest_color(r, g, b)
        # black = ocean — leave pixel untouched

out.save(OUTPUT)
print(f"Saved -> {OUTPUT}")
```

Run it:
```bash
python scripts/quantize_biome_colors.py
```

---

## Step 5: Re-Composite the Ocean

This is the critical safety step. The original ocean pixels must be mathematically identical to the source — no lossy compression, no rounding. This step copies them back pixel-perfect.

Create `scripts/recomposite_ocean.py`:

```python
"""
Pastes the exact original ocean pixels from world_map.png back onto the
quantized image, guaranteeing impassable water remains byte-identical.
"""
from PIL import Image

ORIGINAL  = "screenshots/world_map.png"
QUANTIZED = "screenshots/world_map_quantized.png"
MASK      = "screenshots/ocean_mask.png"
OUTPUT    = "screenshots/world_map_final.png"

original  = Image.open(ORIGINAL).convert("RGB")
quantized = Image.open(QUANTIZED).convert("RGB")
mask      = Image.open(MASK).convert("L")

# Where mask=0 (black=ocean) -> use original pixel
# Where mask=255 (white=land) -> use quantized pixel
final = Image.composite(quantized, original, mask)

final.save(OUTPUT, compress_level=0)   # lossless PNG
print(f"Saved -> {OUTPUT}")
print("Ocean pixels are now mathematically identical to the original.")
```

Run it:
```bash
python scripts/recomposite_ocean.py
```

> **IMPORTANT:** Always save the final composite as **PNG**, never JPEG. JPEG lossy compression will corrupt the exact ocean pixel values and break ocean detection.

---

## Step 6: Analyze the New Map

With your final image at `screenshots/world_map_final.png`, run the terrain agent:

```
# In the WorldBuilder Terminal:
analyze-map-image screenshots/world_map_final.png biome_map.json
```

This scans every landblock's pixel region, classifies it into a biome, assigns the correct DAT terrain type, and writes `biome_map.json`.

**Expected console output:**

```
[AnalyzeMapImage] Complete: XXXX land, YYYY ocean, 12 biomes in Zms -> biome_map.json

  Biome Breakdown:
    forest         : XXXX  (XX.X%)
    water          : XXXX  (XX.X%)
    barren         : XXXX  (XX.X%)
    snow           : XXXX  (XX.X%)
    ...
    ocean          : XXXX  (XX.X%)     <- should be close to original
    impassable_water : XXX  (X.X%)    <- should be close to original
```

### Reference counts from the original Dereth map

| Biome | Cells | Percent |
|---|---|---|
| ocean | 40,572 | 62.4% |
| forest | 18,838 | 29.0% |
| water | 1,725 | 2.7% |
| barren | 1,258 | 1.9% |
| snow | 1,126 | 1.7% |
| obsidian | 620 | 1.0% |
| grassland | 385 | 0.6% |
| swamp | 282 | 0.4% |
| impassable_water | 113 | 0.2% |
| desert | 96 | 0.1% |

> **NOTE:** The ocean and impassable_water counts in your new map should be very close to these reference numbers, since the ocean shape is preserved via the mask. Large deviations indicate re-compositing failed to preserve the ocean correctly.

### Verifying the Output JSON

```powershell
$j = Get-Content biome_map.json -Raw | ConvertFrom-Json
$j.summary.biomeCounts | Format-Table biome, count, percent
$j.terrainTypeMapping | Format-Table biome, terrainTypeId, terrainTypeName
$j.cells | Select-Object -First 5 | Format-Table lbX, lbY, biome, terrainTypeId, terrainTypeName
```

---

## Step 7: Compose the World

Once `biome_map.json` is validated, run terrain composition:

```
compose-world biome_map.json
```

This stamps retail heightmaps into each landblock based on the biome assigned to it. Ocean and impassable_water cells are automatically skipped.

---

## Alternative: Procedural Generation (No AI)

If you don't want to use Stable Diffusion, generate the new map entirely in Python using Perlin noise. This guarantees exact pixel values from the start and skips the inpainting + quantize steps.

The approach:
1. Load `screenshots/ocean_mask.png` (preserves the exact ocean boundary)
2. Use Perlin/simplex noise for elevation and moisture maps
3. Map `(elevation, moisture)` combinations -> biome colors from the palette table above
4. Apply noise only inside the **white** (land) region of the mask
5. Save as PNG, then go straight to `analyze-map-image`

Install the noise library:
```bash
pip install noise
```

> **TIP:** You can ask an LLM to write the full Perlin noise script. Provide it the exact hex colors and HSB ranges from the palette table above and this ocean mask file. The LLM should map noise thresholds to colors that fall squarely within the `ClassifyBiome` HSB detection ranges, bypassing quantization entirely.

---

## Biome to Terrain Type Reference

Full mapping from image biome labels to DAT terrain types.
Source: `ACE-master/Source/ACE.Server/Physics/Common/LandDefs.cs` — `LandDefs.TerrainType` enum.

| Biome | Type ID (hex) | Type ID (dec) | DAT Name | Notes |
|---|---|---|---|---|
| `forest` | `0x03` | 3 | `LushGrass` | Dense teal — dominant Dereth surface |
| `grassland` | `0x01` | 1 | `Grassland` | Lighter green areas |
| `snow` | `0x0F` | 15 | `Snow` | White/bright high-latitude terrain |
| `swamp` | `0x04` | 4 | `MarshSparseSwamp` | Blackmire dark blue terrain |
| `water` | `0x10` | 16 | `WaterRunning` | Modifiable rivers and lakes |
| `desert` | `0x0A` | 10 | `SandYellow` | Sandy/warm desert areas |
| `barren` | `0x0D` | 13 | `SedimentaryRock` | Grey/rocky terrain |
| `obsidian` | `0x06` | 6 | `ObsidianPlain` | SW volcanic dark terrain |
| `mountain` | `0x0E` | 14 | `SemiBarrenRock` | High bright peaks |
| `road` | `0x07` | 7 | `PackedDirt` | Road surface base |
| `ocean` | — | — | *(skip)* | Impassable — not written by compose-world |
| `impassable_water` | — | — | *(skip)* | Impassable inland water — not written |

---

## Quick Reference: Full Pipeline

```bash
# STEP 1 — Generate ocean mask from source map
python scripts/generate_ocean_mask.py screenshots/world_map.png screenshots/ocean_mask.png

# STEP 2 — Launch Stable Diffusion (first run takes 5-10 mins to install deps)
D:\Clones\stable-diffusion-webui\run.bat
#   -> img2img -> "Inpaint upload" -> upload world_map.png + ocean_mask.png -> generate

# STEP 3 — Quantize AI output to exact palette colors
python scripts/quantize_biome_colors.py

# STEP 4 — Restore exact ocean pixels
python scripts/recomposite_ocean.py

# STEP 5 — Analyze the final map (in WorldBuilder Terminal)
analyze-map-image screenshots/world_map_final.png biome_map.json

# STEP 6 — Compose the world
compose-world biome_map.json
```

---

## File Locations

| File | Purpose |
|---|---|
| `screenshots/world_map.png` | Source map — the reference image (2041x2041) |
| `screenshots/ocean_mask.png` | B&W mask (black=ocean, white=land) |
| `screenshots/ocean_mask_preview.png` | Colour preview for visual verification |
| `screenshots/world_map_ai.png` | Raw AI-generated output (before quantization) |
| `screenshots/world_map_quantized.png` | After snapping pixels to palette |
| `screenshots/world_map_final.png` | Final composited image — input to `analyze-map-image` |
| `biome_map.json` | Output of `analyze-map-image` — input to `compose-world` |
| `scripts/generate_ocean_mask.py` | Step 1 automation (already written) |
| `scripts/quantize_biome_colors.py` | Step 3 automation (write from template above) |
| `scripts/recomposite_ocean.py` | Step 4 automation (write from template above) |
| `D:\Clones\stable-diffusion-webui\` | SD WebUI installation |

---

## Troubleshooting

**Too many cells classified as `ocean` on the landmass**
The AI generated pixels close to `#3B211D`. Re-run the inpainting with a higher denoising strength, or add `dark brown, dark red` to your negative prompt.

**Biome counts look wrong (e.g. too much `barren`, not enough `forest`)**
Adjust the palette colors in `quantize_biome_colors.py`. Making the `forest` target color slightly darker (lower brightness) will capture more AI output as forest.

**`compose-world` produces blank/flat terrain**
Check `biome_map.json` — if `landCells` is 0 or very low, `analyze-map-image` classified everything as ocean. Verify `world_map_final.png` has the ocean re-composited correctly and the land pixels are in the expected colour range.

**SD WebUI crashes on first inpaint (out of memory)**
Add `--lowvram` to `webui-user.bat` COMMANDLINE_ARGS instead of `--medvram`, and keep Width/Height at 512. Use "Inpaint area: Only masked" to avoid processing the entire 2041x2041 image. You can upscale afterward in the Extras tab using RealESRGAN.

**SD WebUI won't start -- `No module named pip` or `No module named pkg_resources`**
The bundled Python 3.10 needs pip bootstrapped and an older setuptools. Run:
```
cd D:\Clones\stable-diffusion-webui
call environment.bat
system\python\python.exe system\python\get-pip.py
system\python\python.exe -m pip install "setuptools<70"
```
Then re-run `run.bat`. Setuptools >= 70 removed `pkg_resources` which the CLIP dependency requires.

**Mask not respected -- AI paints over ocean**
You are likely using the wrong tab. Use **img2img -> "Inpaint upload"** (two upload slots), NOT the regular "Inpaint" tab (brush drawing). Set Mask mode to "Inpaint masked" so the AI paints the white (land) areas of the mask.
