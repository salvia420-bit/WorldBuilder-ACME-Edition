# highres_lane palette-route sentinel fix (2026-08-18)

Follow-up to the Phase-0.2 bake-prep census finding (/mnt/wbterminal2/highres-bake/
palette-index-sets.json): retail INDEX16 records use a small subset of their
2048-colour palette (median 422 of 2048), indices <8 are clipmap-transparency
sentinels, and `encode_paletted`'s nearest-neighbour search was unconstrained —
so re-quantizing an upscaled image could hand pixels to palette entries the
retail record never used, including punching NEW transparent holes into
clipmap surfaces (census sample: 7 of 10 sentinel-free records gained sentinel
pixels).

## Fix (tools/dat-patch/highres_lane.py)
- `encode_paletted(..., allowed=None)`: optional candidate-index restriction;
  search runs over the sub-palette and maps back to original index space.
- `_encode_from_png`: for the palette route, `allowed` = the SOURCE record's own
  used-index set (`np.unique` over its index data, all mip levels). "No new
  palette entries, no new holes" is now an invariant of the encode, not a hope.
- Self-contained at run time (derived from the source record; no dependency on
  the census artifact).

## Proof (6 real eor2013 records: 3 sentinel-free + 3 sentinel-using, 2x
Lanczos-upscale then encode, old vs new)

| record | used | srcSentPx | leaked new indices old→new | new sentinel px old→new | mean RGB delta of changed choices |
|---|---|---|---|---|---|
| 0600386B | 630 | 0 | 94 → 0 | 0 → 0 | 0.009 |
| 0600386D | 518 | 0 | 120 → 0 | 0 → 0 | 0.026 |
| 060038A9 | 336 | 0 | 186 → 0 | **3,075 → 0** | 0.292 |
| 06003797 | 1625 | 7096 | 96 → 0 | (legit sentinels kept) | 0.020 |
| 06003801 | 531 | 922 | 474 → 0 | — | 1.089 |
| 06003803 | 97 | 1560 | 59 → 0 | — | 0.495 |

060038A9 is the smoking gun: unrestricted encode would have shipped 3,075 new
transparent pixels on a fully-opaque retail surface. Cost of the restriction is
≤1.1/255 mean RGB delta — visually nil.

## Regression check
Full lane run with a 6-record --baked smoke set (3 INDEX16 through the new
path, 2 DXT1, 1 A8R8G8B8) + `verify`: **VERDICT OK** — upscaled_png 6, failed 0,
NO-REGRESSION-VS-r7 1342/1342, palette-route 385/385 still INDEX16/P8,
passthrough byte-identity 22/22.
