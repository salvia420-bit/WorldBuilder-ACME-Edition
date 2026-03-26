# OutdoorML Working Settings

Current validated settings from the March 26, 2026 VM debugging session.

These are the settings that moved OutdoorML beyond PAD/STOP collapse and
produced valid probe and regional generation output.

## Baseline exploratory settings

Use these for current non-collapsed generation runs:

```bash
python3 scripts/PopulationPipeline/OutdoorML/generate_populated_world.py \
  --model scene_placer_resume_ema.pt \
  --temperature 1.0 \
  --top-k 0 \
  --nucleus-p 1.0 \
  --min-objects 5 \
  --adaptive-min-objects-bonus 2 \
  --pad-logit-bias 1.0 \
  --stop-logit-bias 0.5
```

Equivalent setting list:

- `--temperature 1.0`
- `--top-k 0`
- `--nucleus-p 1.0`
- `--min-objects 5`
- `--adaptive-min-objects-bonus 2`
- `--pad-logit-bias 1.0`
- `--stop-logit-bias 0.5`

Observed effect:

- fixed `5x5` probe produced `422` accepted placements
- large-region generation remained stable
- PAD/STOP collapse no longer blocked inference

## Housing stress-test settings

Use these only for explicit housing-path validation, not yet as default
production settings:

```bash
python3 scripts/PopulationPipeline/OutdoorML/run_small_region_probe.py \
  --model scene_placer_resume_ema.pt \
  --temperature 1.0 \
  --top-k 0 \
  --nucleus-p 1.0 \
  --min-objects 5 \
  --adaptive-min-objects-bonus 2 \
  --pad-logit-bias 1.0 \
  --stop-logit-bias 0.5 \
  --housing-logit-bias 4.0 \
  --housing-min-placements 0 \
  --housing-flatness-threshold 0.0 \
  --housing-difficulty-ceiling 1.0 \
  --max-housing-per-lb 2
```

Equivalent setting list:

- `--housing-logit-bias 4.0`
- `--housing-min-placements 0`
- `--housing-flatness-threshold 0.0`
- `--housing-difficulty-ceiling 1.0`
- `--max-housing-per-lb 2`

Observed effect:

- fixed `5x5` probe produced `Housing toks: 2`
- `Houses placed: 2`
- `16` housing links written
- housing integrity validated successfully

## Notes

- `scene_placer_resume_ema.pt` is the current working checkpoint for inference.
- The older PAD-collapse behavior was strongly tied to the previous sampling
  settings, especially filtered sampling.
- Housing generation is now confirmed to work through the placement path, but
  the aggressive housing settings above are still proof-of-path settings, not
  yet balanced world-generation defaults.
