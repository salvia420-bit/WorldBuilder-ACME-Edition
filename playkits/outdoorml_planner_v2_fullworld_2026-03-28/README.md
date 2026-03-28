# OutdoorML Planner-v2 Full-World Playtest Kit

This kit contains the March 27, 2026 validated `planner-v2` winner line generated as a full-world SQL pass on March 28, 2026.

Contents:
- `sql/fullworld_planner_v2_2026-03-28.sql`
- `sql/fullworld_planner_v2_2026-03-28_summary.json`
- `sql/fullworld_replace_safe.sql`
- `VALIDATION.md`

Current gap:
- `dat/client_cell_1.dat` is not included in this archive because the requested source path was not accessible from this VM at build time: `D:\Clones\WorldBuilder-ACME-Edition-master\vanquishkit\files\dat\client_cell_1.dat`
- Copy that file into `dat/client_cell_1.dat` on your side before playtesting.

## 1. Expected DAT

Place the Vanquish terrain DAT here:

```bash
cp /path/to/client_cell_1.dat \
  /home/salvia420/WorldBuilder-ACME-Edition/playkits/outdoorml_planner_v2_fullworld_2026-03-28/dat/client_cell_1.dat
```

Windows source you originally specified:

```text
D:\Clones\WorldBuilder-ACME-Edition-master\vanquishkit\files\dat\client_cell_1.dat
```

## 2. Apply SQL

Raw import:

```bash
mysql -u root -p ace_world < \
  /home/salvia420/WorldBuilder-ACME-Edition/playkits/outdoorml_planner_v2_fullworld_2026-03-28/sql/fullworld_planner_v2_2026-03-28.sql
```

Safer replace import for the generated full-world target area (`lbX 8..246`, `lbY 8..246`):

```bash
cd /home/salvia420/WorldBuilder-ACME-Edition/playkits/outdoorml_planner_v2_fullworld_2026-03-28/sql
mysql -u root -p ace_world < fullworld_replace_safe.sql
```

The safe wrapper:
- deletes existing `landblock_instance_link` rows connected to instances in the target landblock range
- deletes existing `landblock_instance` rows in the target landblock range
- deletes existing `encounter` rows in the target landblock range
- imports the raw generated full-world SQL

## 3. Startup Flow

Suggested playtest flow:

```bash
cd /home/salvia420/WorldBuilder-ACME-Edition/playkits/outdoorml_planner_v2_fullworld_2026-03-28/sql
mysql -u root -p ace_world < fullworld_replace_safe.sql
```

Then:
- copy `dat/client_cell_1.dat` into the place your server/client startup flow expects for Vanquish terrain
- start the world/server with that DAT and the updated `ace_world` DB
- log in and inspect multiple far-separated regions, not just the original region-B area

## 4. Reproduce Generation

The full-world SQL in this kit was generated with:

```bash
/home/salvia420/WorldBuilder-ACME-Edition/.venv/bin/python \
  /home/salvia420/WorldBuilder-ACME-Edition/scripts/PopulationPipeline/OutdoorML/generate_populated_world.py \
  --model scene_placer_final.pt \
  --planner-model settlement_planner.pt \
  --landblock-batch-size 16 \
  --temperature 1.0 \
  --top-k 0 \
  --nucleus-p 1.0 \
  --min-objects 5 \
  --adaptive-min-objects-bonus 2 \
  --pad-logit-bias 1.0 \
  --stop-logit-bias 0.5 \
  --output-sql /home/salvia420/WorldBuilder-ACME-Edition/playkits/outdoorml_planner_v2_fullworld_2026-03-28/sql/fullworld_planner_v2_2026-03-28.sql \
  --summary-json /home/salvia420/WorldBuilder-ACME-Edition/playkits/outdoorml_planner_v2_fullworld_2026-03-28/sql/fullworld_planner_v2_2026-03-28_summary.json \
  --progress-every 2000 \
  --debug-landblocks 25 \
  --require-cuda
```

Notes:
- no retraining was performed
- winner artifacts came from the validated planner-v2 line
- generation ran with default margin `8`, so this is a full-world-scale pass over `lbX 8..246`, `lbY 8..246`

## 5. Optional Validation On Your 1070

The stronger building/terrain validators live in `WorldBuilder.Terminal`, not in the Python scorer. Recommended post-import checks:

```text
validate-building-shells <lbX> <lbY>
validate-building-portals <lbX> <lbY>
validate-all <lbX> <lbY>
terrain sample-height <worldX> <worldY>
```

Use those on representative towns and suspicious-looking building placements after the world is running.
