# Phase 1.2 — terrain detail normal maps

Five 1024x1024 RGB normal-map PNGs loaded into a `THREE.DataArrayTexture`
and sampled by the terrain custom ShaderMaterial at high UV frequency.
Combined with the per-cell surface normal via reoriented normal mapping
(RNM) for a high-frequency micro-detail layer that reads at the player's
feet without changing geometry.

| slice | tile                          | category | source terrain types (Region 0x13)         |
|-------|-------------------------------|----------|--------------------------------------------|
| 0     | `terrain_grass_normal.png`    | grass    | 1 Grassland, 3 LushGrass, 9 PatchyGrassland, 21 forestfloor, 28 Moss, 29 DarkMoss |
| 1     | `terrain_dirt_normal.png`     | dirt     | 5 MudRichDirt, 7 PackedDirt, 8 PatchyDirt, 24 Argila, 31 DesolateLands |
| 2     | `terrain_sand_normal.png`     | sand     | 10 sand-yellow, 11 sand-grey, 12 sand-rockStrewn |
| 3     | `terrain_stone_normal.png`    | stone    | 0 BarrenRock, 6 ObsidianPlain, 13 SedimentaryRock, 14 SemiBarrenRock, 25 Volcano1, 26 Volcano2, 30 olthoi |
| 4     | `terrain_snow_normal.png`     | snow     | 2 Ice, 15 Snow, 27 BlueIce |

Terrain types **not** in the table (4 MarshSparseSwamp, 16–20 Water*,
22 FauxWaterRunning, 23 SeaSlime) explicitly map to "no detail" — the
shader uses slot 0 with strength 0 (no contribution). Water and swamp
look better flat at the detail layer; they get their own water-specific
shader work in Phase 2.x.

Holtburg LB 0xA9B4 has these terrain types per `get-terrain-layers`:
LushGrass (3, 42%), Grassland (1, 22%), SemiBarrenRock (14, 22%),
PatchyGrassland (9, 14%) → 78% grass, 22% stone.

## Encoding

Flat ground encodes as `(128, 128, 255)` (positive Z-up tangent-space
normal). The Z component is encoded across [128, 255], R/G are signed
deviation centered on 128. Linear colourspace at load — the
`DataArrayTexture` uses `THREE.NoColorSpace` so the GPU does not apply
the sRGB → linear de-gamma to vector data.

## Sand wind

The sand normal has anisotropic drifts running along one axis. At
sample-time the terrain fragment shader rotates the detail UV by a
`uWindDir` vec2 uniform (unit vector `(cos θ, sin θ)`) so the drift
direction tracks the wind. Currently `uWindDir` defaults to `(1, 0)`
and is not yet wired into the skybox weather state — Phase 2.x weather
work owns that handoff.

## Regenerating

```bash
cd apps/holtburger-web/scene3d/assets/terrain_detail
python3 generate.py
```

Deterministic — seeds + octave parameters baked into the script. Pillow
+ NumPy only, no external assets, no network.

Pipeline per tile:

1. Build a seamlessly-tileable grayscale heightmap from layered value
   noise (`_seamless_value_noise` uses one row + column of padding so
   bilinear upsample lands on the opposite edge — same trick as Phase
   0.2's generator).
2. Finite-difference into a tangent-space normal:
   ```
   nx = -(h(x+1, y) - h(x-1, y)) * strength
   ny = -(h(x, y+1) - h(x, y-1)) * strength
   nz = 1
   ```
   `np.roll` for the diff so the gradient wraps with the heightmap.
3. Normalise, encode as `(n * 0.5 + 0.5) * 255` uint8 RGB.

Per-category heightmap shapers:

- **grass** — sparse blade mask (threshold a 384-lattice noise at 0.78
  for ~15% coverage) mixed with a fine 256-lattice ground micro-detail.
- **dirt** — pure isotropic fbm at 128/256/384 lattice freqs.
- **sand** — anisotropic ridges from a phase-jittered cosine on Y
  (~12 ridges/tile, contrast bump `**1.6`), plus a 30% fine grain base.
  Ridges run along the X axis so `uWindDir` can rotate them.
- **stone** — high-contrast pebble field (192-lattice noise stretched)
  minus thin sub-pixel cracks (96-lattice threshold-band mask).
- **snow** — low-freq fbm drifts plus sparse crystal-spike mask (>0.93
  threshold on a 512-lattice channel).

Strengths (the finite-difference scalar) per category are tuned so the
relative bump intensity reads correctly: grass=6, dirt=5, sand=7, stone=8,
snow=4.
