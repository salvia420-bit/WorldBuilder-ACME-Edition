# Validation

## Full-World Output

Generated files:
- `sql/fullworld_planner_v2_2026-03-28.sql`
- `sql/fullworld_planner_v2_2026-03-28_summary.json`

Full-world counts from the raw SQL:
- object rows: `511,233`
- link rows: `3,606`
- encounter rows: `120,585`

Coverage:
- unique landblocks from `landblock_instance.obj_Cell_Id`: `57,121`
- unique landblocks from `encounter.landblock`: `50,961`
- `obj_Cell_Id` coverage: `lbX 8..246`, `lbY 8..246`
- `encounter.landblock` coverage: `lbX 8..243`, `lbY 8..246`

This is full-world scale, not the original region-B-only slice.

## Generation Settings

Winner line:
- planner-v2 validated March 27, 2026
- `scene_placer_final.pt`
- `settlement_planner.pt`
- no retraining

Sampling:
- seed `42`
- temperature `1.0`
- top-k `0`
- nucleus-p `1.0`
- min objects `5`
- adaptive min-object bonus `2`
- pad logit bias `1.0`
- stop logit bias `0.5`
- town lifestone injection enabled
- town vendor injection enabled

Runtime:
- full-world generation time: `1182.29s`
- about `19.7` minutes

## Fast-Path Validation

Generator optimization was validated before the full-world run:
- legacy validated region-B reference: about `45.344s`
- optimized batch-16 region-B run: about `10s`
- optimized batch-16 region-B quality score: `85.8/100`
- wider batch-32 run was faster but regressed to `84.3/100`, so it was rejected

This full-world output was generated with `--landblock-batch-size 16`.

## Planner Summary

Predicted planner archetypes from the full-world summary:
- `sparse_misc`: `23,691`
- `service_node`: `20,184`
- `housing_cluster`: `12,583`
- `portal_creature_outpost`: `389`
- `vendor_portal_hub`: `274`

Other generation summary numbers:
- houses placed: `288`
- collision rerolls: `306,403`
- injected lifestones: `2,550`
- injected vendors: `333`
- empty landblocks after validation: `0`

## Known Gaps And Assumptions

Known gaps:
- `dat/client_cell_1.dat` could not be copied into this kit on the VM because the specified Windows path was not accessible from this environment
- `WorldBuilder.Terminal` validators were not run here against a live imported test world; they should be run on your side after import

Observed issue:
- housing integrity reported one proximity warning:
  - two cottages too close at distance `2.5` with a minimum threshold `18.0`

Assumptions:
- full-world generation used the repo-default full-world margin `8`
- the intended replace-safe scope is therefore the same full generated rectangle: `lbX 8..246`, `lbY 8..246`
- encounter coverage being slightly narrower on `lbX` (`8..243`) is treated as output behavior, not a truncation failure, because object coverage spans the full generated rectangle
