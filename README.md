# Holtburger 3D — Visual Bug Fixes & Enhancements Gallery (2026-11-14)

- **GPU**: `ANGLE (NVIDIA Corporation, NVIDIA GeForce GTX 1070 Ti/PCIe/SSE2, OpenGL ES 3.2)` (1440×900, High quality, Volumetric Clouds ON, Desert Haze ON)
- **WebGL / JS Errors**: `0` across all 16 captures

| # | File | Highlight | Mean FPS | P50 FPS |
|---|---|---|---|---|
| 01 | `01_clouds_behind_hills_holtburg.png` | Bug 1 — Volumetric clouds cleanly occluded behind hills, roofs, and far terrain ridges (Holtburg 0xA9B4) | **70.5 FPS** | **105.3 FPS** |
| 02 | `02_shoushi_portal_courtyard_grass.png` | Bug 2 — Shoushi Town Network arrival courtyard lush with grass right up to L-walls & pagoda (0xDA55) | **65.3 FPS** | **66.7 FPS** |
| 03 | `03_grass_meadow_botanical_variety.png` | Item 3 — Performant multi-species grass variety: macro meadow waves, seed-head culms, broadleaf clovers & slope tint | **89.1 FPS** | **91.7 FPS** |
| 04a | `04a_nanto_blue_ghost_falls.png` | Item 4a — Nanto Blue Ghost Falls (0xE43D): dual cliff-gap spouts snapped to exact cliff emitters + plunge mist | **100.4 FPS** | **102 FPS** |
| 04b | `04b_cragstone_falls_cataract.png` | Item 4b — Cragstone Falls (0xB6A3): 66m-wide cataract curtain with animated foam striations & plunge boil | **74.2 FPS** | **76.9 FPS** |
| 04c | `04c_marae_lassel_dam_cascade.png` | Item 4c — Marae Lassel Dam Cascade (0x1FBC): feathered dam face cascade (<82m dry deck) into lily-pad lagoon | **130.9 FPS** | **137 FPS** |
| 05 | `05_holtburg_night_lighting_fixed.png` | Item 5 — Holtburg Night Lighting (0xA9B4): Lifestone & warm town lights with 0x02000364 test-light anomalies suppressed | **84.8 FPS** | **89.3 FPS** |
| 06a | `06a_ocean_coast_starfish_shells_palms.png` | Item 6a — Ocean Coast (Ulgrim's Island 0x7009): 5-arm starfish, pearlescent seashells & GPU treesway coconut palms | **154.4 FPS** | **156.2 FPS** |
| 06b | `06b_river_shore_driftwood_logs.png` | Item 6b — River Shore (0xB6A4): weathered driftwood logs washed ashore and aligned with river flow | **130.4 FPS** | **131.6 FPS** |
| 07a | `07a_obsidian_spires_shadow_miasma.png` | Item 7a — Obsidian Spires (0x472C): creeping dark-violet shadow miasma & rising void wisps (0 screen-warp) | **78.3 FPS** | **92.6 FPS** |
| 07b | `07b_aerlinthe_magma_convection.png` | Item 7b — Volcano Magma (Aerlinthe 0xB9EE): localized molten crust convection & basalt incandescence (0 screen-warp) | **64 FPS** | **68.5 FPS** |
| 07c | `07c_naqut_desert_heat_haze_intact.png` | Item 7c — Desert Heat Haze Preserved (Naqut Desert 0x886E): ground shimmer & horizon mirage 100% intact | **88.5 FPS** | **92.6 FPS** |
| 08 | `08_weather_crystalline_snowfall.png` | Item 8 — Enhanced Snowfall: 3-layer 6-fold hexagonal crystal dendrites + soft bokeh & wind gusts (1 draw call) | **61.9 FPS** | **67.6 FPS** |
| 09 | `09_weather_rain_streaks_and_splashes.png` | Item 9 — Enhanced Rain: wind-slanted 3D velocity streaks + expanding concentric water/ground splash rings | **138.4 FPS** | **137 FPS** |
| 10 | `10_weather_forked_3d_lightning.png` | Item 10 — Regained 3D Lightning: forked return-stroke bolt, localized cloud-anvil illumination & 343 m/s thunder | **123.2 FPS** | **137 FPS** |
| 11 | `11_weather_hud_toggle_off.png` | Item 11 — Cloud-Associated Weather System & Live HUD Weather Toggle (Off/On synced with CharacterOption 0x04) | **107.6 FPS** | **114.9 FPS** |
| 12 | `12_underwater_shallows_shark.png` | Item 12 — Underwater Water Spawns (0x7963): Shallows Shark submerged 0.90m below water surface with aquatic shading | **100.4 FPS** | **178.6 FPS** |

## Full-Resolution Previews (1440×900)

### `01_clouds_behind_hills_holtburg.png`
![01_clouds_behind_hills_holtburg.png](./01_clouds_behind_hills_holtburg.png)

### `02_shoushi_portal_courtyard_grass.png`
![02_shoushi_portal_courtyard_grass.png](./02_shoushi_portal_courtyard_grass.png)

### `03_grass_meadow_botanical_variety.png`
![03_grass_meadow_botanical_variety.png](./03_grass_meadow_botanical_variety.png)

### `04a_nanto_blue_ghost_falls.png`
![04a_nanto_blue_ghost_falls.png](./04a_nanto_blue_ghost_falls.png)

### `04b_cragstone_falls_cataract.png`
![04b_cragstone_falls_cataract.png](./04b_cragstone_falls_cataract.png)

### `04c_marae_lassel_dam_cascade.png`
![04c_marae_lassel_dam_cascade.png](./04c_marae_lassel_dam_cascade.png)

### `05_holtburg_night_lighting_fixed.png`
![05_holtburg_night_lighting_fixed.png](./05_holtburg_night_lighting_fixed.png)

### `06a_ocean_coast_starfish_shells_palms.png`
![06a_ocean_coast_starfish_shells_palms.png](./06a_ocean_coast_starfish_shells_palms.png)

### `06b_river_shore_driftwood_logs.png`
![06b_river_shore_driftwood_logs.png](./06b_river_shore_driftwood_logs.png)

### `07a_obsidian_spires_shadow_miasma.png`
![07a_obsidian_spires_shadow_miasma.png](./07a_obsidian_spires_shadow_miasma.png)

### `07b_aerlinthe_magma_convection.png`
![07b_aerlinthe_magma_convection.png](./07b_aerlinthe_magma_convection.png)

### `07c_naqut_desert_heat_haze_intact.png`
![07c_naqut_desert_heat_haze_intact.png](./07c_naqut_desert_heat_haze_intact.png)

### `08_weather_crystalline_snowfall.png`
![08_weather_crystalline_snowfall.png](./08_weather_crystalline_snowfall.png)

### `09_weather_rain_streaks_and_splashes.png`
![09_weather_rain_streaks_and_splashes.png](./09_weather_rain_streaks_and_splashes.png)

### `10_weather_forked_3d_lightning.png`
![10_weather_forked_3d_lightning.png](./10_weather_forked_3d_lightning.png)

### `11_weather_hud_toggle_off.png`
![11_weather_hud_toggle_off.png](./11_weather_hud_toggle_off.png)

### `12_underwater_shallows_shark.png`
![12_underwater_shallows_shark.png](./12_underwater_shallows_shark.png)

