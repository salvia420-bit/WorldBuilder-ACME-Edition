# Population Pipeline Probe Loop

This is the current highest-leverage VM workflow for OutdoorML.

Do not spend more GPU time on full-world generation until the small-region probe
produces nonzero raw placements.

## Why

Current known state:

- training metrics improved into a promising range
- full-world generation produced `0` populated landblocks and `0` objects
- the fixed `5x5` probe region also produced only `PAD` / `STOP` behavior

That means the bottleneck is still inference viability, not full-world runtime.

## Fixed probe region

Use the same region every time so results are comparable:

- `lb_x=30..34`
- `lb_y=120..124`

## Recommended VM loop

1. Regenerate placement tensors after any extraction-label change.
2. Confirm the extractor prints a nontrivial housing-token breakdown, not just cottage fallback.
3. Resume training from `pipeline_data/models/resume.pt` for a bounded slice such as `25` epochs.
4. Export or use the latest EMA-backed inference checkpoint.
5. Run the fixed small-region probe against the latest inference-loadable checkpoint with the known-good baseline inference settings.
6. Compare `accepted_after_validation`, `PAD`, `STOP`, and `housing_samples` against the current baseline.
7. If the probe regresses materially, stop and debug locally instead of widening the run.

## Probe command

From the repo root on the VM:

```bash
python3 scripts/PopulationPipeline/OutdoorML/run_small_region_probe.py \
  --model scene_placer_best.pt
```

This writes:

- probe SQL
- JSON summary
- full console log

under:

```text
pipeline_data/population_output/probes/
```

## Resume training command

```bash
python3 scripts/PopulationPipeline/OutdoorML/train_scene_placer.py \
  --resume pipeline_data/models/resume.pt \
  --epochs 725
```

Adjust `--epochs` upward based on the current checkpoint epoch. The goal is a
short bounded run, not an unattended marathon.

## Extraction-refresh command

Run this before the next bounded training slice if `extract_placement_tensors.py`
changed:

```bash
python3 scripts/PopulationPipeline/OutdoorML/extract_placement_tensors.py
```

Look for the extractor summary line:

- `Housing supervision tokens: ...`
- `Breakdown: cottage=..., villa=..., mansion=..., fallback=...`

The desired result is that retail slumlords now contribute multiple housing
families instead of collapsing entirely into cottage labels.

## Current probe baseline

Use the fixed `5x5` probe with the March 26, 2026 known-good inference baseline:

```bash
python3 scripts/PopulationPipeline/OutdoorML/run_small_region_probe.py \
  --model scene_placer_resume_ema.pt \
  --temperature 1.0 \
  --top-k 0 \
  --nucleus-p 1.0 \
  --min-objects 5 \
  --adaptive-min-objects-bonus 2 \
  --pad-logit-bias 1.0 \
  --stop-logit-bias 0.5
```

Current comparison target:

- `accepted_after_validation: 422`

## Probe interpretation

Healthy direction:

- `raw_generated > 0`
- some nonzero `regular_samples` or `housing_samples`
- ideally some nonzero `accepted_after_validation`

Still collapsed:

- `raw_generated == 0`
- output dominated by `PAD`
- possibly some `STOP`, but still no real placement tokens

## New generation options

`generate_populated_world.py` now supports:

- `--output-sql`
- `--summary-json`

These are intended for automation and repeatable probe runs.

## Practical next decision rule

- If the probe still shows `raw_generated == 0`, work on start-token / first-token inference behavior.
- If the probe shows raw placements but `accepted_after_validation == 0`, work on validators and rejection diagnostics.
- Only return to full-world generation once the probe is producing nontrivial output.
