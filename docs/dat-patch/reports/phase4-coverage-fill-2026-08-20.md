# Phase 4 — the coverage fill (2026-08-20)

Owner directive: fill the r8 runway this session, intelligently, per
PLAN-2026-08-18. Task list with the measured costs:
TASKLIST-2026-08-20-phase4-fill.md. This report is the execution record.

## What was shipped into the space

The fill is **purely additive to `client_highres.dat`**, which the client already
prefers over the portal. So the r8 portal ships byte-identical, nothing is
deleted, no re-split or reconstruction happens, and `Tree.TryDelete` — which
corrupts the b-tree (upstream-drw-btree-delete-fix.md) — is never called.

| | before (r8) | after |
|---|---|---|
| covered 0x06 records | 2,412 of 20,684 (11.7 %) | **7,293 of 20,684 (35.3 %)** |
| world surfaces >=64 px still at retail quality | 4,892 | **~0** |
| client_portal.dat | 556 MB | 556 MB (unchanged) |

## The routing decision (the "intelligently" part)

Not every record is worth the same bytes, and not every record may be re-encoded
at all:

- **INDEX16 / P8 -> stay palettized, 2x.** Converting a palettized record to DXT
  freezes its colours and breaks every ClothingTable subpalette recolour
  (pallib.py RECOLOR SAFETY) — that is most of the creature/monster/clothing
  corpus, the exact surfaces the plan ranks #4. The palette route upscales the
  RGBA, then re-solves indices **within the record's own used subset**, so no new
  palette entries and no new clipmap-transparency holes can appear. Verified on
  the output: `indices new-not-in-old = 0` on every sampled record.
- **Everything else -> DXT1 (opaque) / DXT5 (alpha) at 4x**, encoded by
  WorldBuilder.Terminal (BCnEncoder, the client-grade path), alpha transplanted
  from the retail decode and re-binarised at retail's own 100 cut for clipmaps.
- **Terrain-protected RenderSurfaces are refused** (they must stay 512^2
  A8R8G8B8 or ImgTex::MergeTexture reads out of bounds -> VeryHigh crash).
- **32 px icons/UI (12,933 records, ~41 MB) deliberately NOT shipped this pass.**
  They are 71 % of the remaining record count for 4 % of the bytes and the least
  world-visible surface class in the game. Their upscales are already baked and
  parked on the buildbox for a later pass.

## Exposure: the fill matches the shipped lane, measured

Raw Remacri output sits at lumRatio median **1.044** vs retail — the shipped r7.1
lane sits at **1.15** by design. Shipping the fill unanchored would have put a
filled wall visibly cooler than the r7.1 wall next to it. So every fill record
goes through `legibility.bake_texture(..., h=None)` — anchor only, no emboss
(these records have no surface metadata, material class or seam height behind
them) — with the same `rgb+sat` retail anchor the take-5 driver uses.

Colour ledger on the baked output (119-record sample): lumRatio median **1.1540**,
per-channel 1.1535 / 1.1540 / 1.1552, satRatio median 0.998, castDrift median
0.0019 / p99 0.058, **0 %** outside the per-texture band, verdict **PASS**.

## Pipeline

1. **deblock** (local, CPU) — 607 DXT-sourced inputs through `deblock.py batch`
   (2 passes): source grid excess **+42.0 % -> -0.4 %** (median +30.8 % -> -0.0 %),
   off-grid detail kept 103 % mean / 96 % p10. Non-DXT sources skip this stage:
   they have no block grid to remove.
2. **upscale** (buildbox T4) — `fill_upscale.py`, the shipped rewrap recipe
   (wrap-pad 16 px -> Remacri 4x -> crop 64) so tile edges stay seamless.
   16,922 records in ~30 min. Resumable by construction (an existing output is
   skipped), which mattered: **the SPOT box was preempted mid-session** and the
   run resumed with no lost work.
3. **bake** (local, 3 shards) — retail anchor + alpha transplant, then either a
   DXT PNG for WBT or raw INDEX16 record bytes.
4. **land** — `build_r9_highres.sh`: WBT `render-surface-import --allowCreate`
   for the DXT route, `DatRecordInsert` (insert-only, readback-verified) for the
   palette route, then DatCompress -> walk_check -> dims ledger vs r8 -> size guard.

## New tooling (all in-repo)
- `tools/dat-patch/fill_import.py` — the coverage bake + routing.
- `tools/dat-patch/build_r9_highres.sh` — the landing driver and its gates.
- `tools/dat-patch/DatRecordInsert/` — insert raw record bytes into an existing
  dat, insert-only, with a byte-identical readback pass. No deletes, ever.
- `fill_upscale.py` (box-side, kept with the run artefacts).
