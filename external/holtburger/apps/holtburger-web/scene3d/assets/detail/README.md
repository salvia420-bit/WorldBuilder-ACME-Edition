# Phase 0.2 — detail tiles

Five 512x512 grayscale PNG tiles composited over the diffuse layer of any
surface whose `surface_type` carries the AC `Detail (0x20000)` flag. The
picker in `materials.js::_materialFromFlags` selects one by surface
category (`SURFACE_CATEGORY`, Phase 1.4):

| category                            | tile                |
|-------------------------------------|---------------------|
| Stone, Brick, Tile, Lava, Metal     | `stone-grain.png`   |
| Wood                                | `wood-grain.png`    |
| Sand, Snow                          | `sand-grain.png`    |
| Foliage, Cloth                      | `fabric-weave.png`  |
| Water, Dirt, Generic, unset         | `generic-rough.png` |

All tiles are **mean ~0.5 grayscale** so the shader composite
`mix(diffuse, diffuse * detail, blendFactor)` does not shift average
surface brightness — it only modulates locally.

## Regenerating

```bash
cd apps/holtburger-web/scene3d/assets/detail
python3 generate.py
```

Generator is deterministic (per-tile seed baked into the script) — same
output every run, no external assets, no network. Pillow + NumPy only.

Per tile:

- **generic-rough** — fbm value noise, octaves at lattice freq 16/64/256.
  Isotropic; the safe fallback when no surface category is known.
- **stone-grain** — fbm at 8/32/128 with a 1.4× contrast bump; coarser
  blobs read as pebbles when tiled.
- **wood-grain** — anisotropic vertical stripes (24 cycles per tile)
  with a soft low-freq phase jitter so it doesn't look like a barcode,
  mixed 70/30 with seam-free value noise.
- **fabric-weave** — orthogonal warp+weft sine bands (32 cycles each)
  averaged then dithered with seam-free value noise.
- **sand-grain** — fbm at 128/256/384; very fine high-freq grain.

All tiles are seamlessly tileable: the underlying value-noise lattice
wraps with one row + one column of padding so bilinear interpolation
lands on the opposite edge at the texture boundary. UV scale at runtime
is `vUv * 8.0` (uniform `uDetailScale` in the shader) so each surface
shows 8 tile repeats across one diffuse UV unit.
