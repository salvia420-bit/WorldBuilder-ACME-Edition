# Population Pipeline Probe Loop

This is the current highest-leverage VM workflow for OutdoorML after the
successful March 27, 2026 full-world generation milestone.

The old guidance in this file that treated full-world generation as blocked is
now obsolete. The probe loop still matters, but its role has changed:

- before March 27 it was used to prove inference viability
- after March 27 it is used to protect the current working baseline while
  improving quality with bounded experiments

## Why

Current known state:

- the fixed `5x5` probe baseline is stable at:
  - `accepted_after_validation: 422`
  - `PAD: 11`
  - `STOP: 24`
- the March 27, 2026 full-world CUDA run succeeded with:
  - `57,121` populated landblocks
  - `605,636` objects
  - `104` houses
  - `120,727` encounters
  - score `77.8/100`
- the current baseline is no longer PAD/STOP collapse
- the remaining bottlenecks are quality-related:
  - weak building integrity
  - modest variety / clustering
  - reliance on lifestone / vendor completion passes
  - incomplete service / housing-link semantics in some dense landblocks

That means the bottleneck is now controlled quality improvement, not inference
viability.

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
7. Run one representative scored regional generation such as a validated `20x20` region.
8. Only if the bounded checks hold should you schedule another full-world run.
9. If the probe or region regresses materially, stop and debug locally instead of widening the run.

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
  --resume pipeline_data/models/resume_baseline_2026-03-26_epoch750.pt \
  --epochs 775
```

Adjust `--epochs` upward based on the current checkpoint epoch. The goal is
still a short bounded run, not an unattended marathon.

## Extraction-refresh command

Run this before the next bounded training slice if `extract_placement_tensors.py`
changed:

```bash
python3 scripts/PopulationPipeline/OutdoorML/extract_placement_tensors.py
```

If the retail SQL is not in the repo-local `ace_world_release/` copy, pass it
explicitly:

```bash
python3 scripts/PopulationPipeline/OutdoorML/extract_placement_tensors.py \
  --retail-sql /path/to/ACE-World-Database-v0.9.292.sql
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
- `PAD: 11`
- `STOP: 24`

This probe is a guardrail. Passing it does not mean the model improved. Failing
it means the candidate should not advance.

## Probe interpretation

Healthy direction:

- `raw_generated > 0`
- some nonzero `regular_samples` or `housing_samples`
- `accepted_after_validation` remains near the baseline rather than collapsing
- no obvious density explosion relative to the known-good baseline

Still collapsed:

- `raw_generated == 0`
- output dominated by `PAD`
- possibly some `STOP`, but still no real placement tokens

Still unsafe even if not collapsed:

- probe density jumps materially above baseline without better regional scores
- `PAD` / `STOP` drift sharply
- housing / structure semantics regress on scored regions
- full-world quality depends even more on heuristic completion passes

## New generation options

`generate_populated_world.py` now supports:

- `--output-sql`
- `--summary-json`

These are intended for automation and repeatable probe runs.

## Detached execution

For unstable SSH sessions, launch the bounded cycle via:

```bash
./run_outdoorml_detached.sh
```

This starts the current bounded loop under a detached `tmux` session and writes a run directory
under:

```text
pipeline_data/population_output/detached_runs/
```

with:

- `stdout.log`
- `pid.txt`
- `session.txt`
- `command.txt`

## Practical next decision rule

- If the probe still shows `raw_generated == 0`, work on start-token / first-token inference behavior.
- If the probe shows raw placements but `accepted_after_validation == 0`, work on validators and rejection diagnostics.
- If the probe is healthy but scored regions are weak, work on label quality and retail supervision before widening the model.
- If scored regions improve without probe regression, then consider another full-world run.
- Do not widen context beyond `224` just because a label experiment stalls; the `227`-dim housing-prior branch is currently parked.

## Current next-phase focus

The highest-leverage work after the March 27 milestone is:

1. Improve structure and service semantics without changing model input width.
2. Reduce reliance on town completion passes by teaching more retail patterns in extraction labels.
3. Improve housing-link and dense-town supervision using retail analysis.
4. Raise the full-world quality score above `80` while preserving the current density baseline.
