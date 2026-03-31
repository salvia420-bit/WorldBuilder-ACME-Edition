# FrequencyModel

Standalone scoring and search utilities for population outputs.

This path is separate from the OutdoorML trainer. It is intended to answer:

- does a generated world overproduce common safe objects
- does a generated landblock look locally plausible for Dereth
- which generation settings are less bad on a fixed benchmark suite

## Main files

- `build_object_frequency_weights.py`
  - builds per-WCID reward and penalty weights from retail counts
- `build_landblock_reference_counts.py`
  - builds sparse retail WCID counts by landblock
- `build_wcid_similarity.py`
  - builds label-free WCID similarity from retail landblock co-presence
- `score_frequency_distribution.py`
  - global frequency score
- `score_landblock_frequency.py`
  - exact-landblock local score
- `score_neighborhood_frequency.py`
  - current best local score
- `rank_neighborhood_scores.py`
  - batch ranking wrapper for multiple SQL outputs
- `run_overnight_benchmark_search.py`
  - autonomous benchmark search over generation-time knobs

## Current scoring shape

`score_neighborhood_frequency.py` combines three ideas:

- exact local WCID support from nearby retail landblocks
- partial substitution support from mathematically similar WCIDs
- whole-landblock mix plausibility against nearby retail blocks

The score is still penalty-driven. That is deliberate. Unsupported spam should
hurt much more than approximate plausibility helps.

Useful columns:

- `score/row`: overall normalized quality
- `over/row`: unsupported generation pressure
- `mix/lb`: local compositional plausibility

## Rank multiple outputs

```bash
python3 scripts/PopulationPipeline/FrequencyModel/rank_neighborhood_scores.py \
  path/to/run_a.sql \
  path/to/run_b.sql \
  path/to/run_c.sql
```

Optional JSON output:

```bash
python3 scripts/PopulationPipeline/FrequencyModel/rank_neighborhood_scores.py \
  path/to/run_a.sql \
  path/to/run_b.sql \
  --out-json pipeline_data/reference/neighborhood_rank_results.json
```

## Overnight search

The overnight search does not retrain the model. It searches generation-time
parameters on fixed benchmark regions:

- region A: `30-49 x 120-139`
- region B: `50-69 x 120-139`
- region C: `30-39 x 120-129`

It writes:

- `manifest.json`
- `leaderboard.json`
- `search_summary.json`
- per-candidate params, logs, SQL, summaries, and scored results

## Detached launch

Use the repo-root launcher:

- `run_overnight_benchmark_search.sh`
- `launch_overnight_benchmark_search_detached.sh`

The detached launcher is designed for this VM's current GPU quirk:

- `nvidia-smi` can work in an elevated shell while plain user shells lose
  access to `/dev/nvidia*`
- the launcher recreates NVIDIA device nodes and keeps the benchmark search in
  the same elevated detached shell

This is not a general CUDA fix. It is a practical workaround for this VM.

## Practical workflow

1. Generate candidate outputs or run the overnight search.
2. Rank them with `rank_neighborhood_scores.py`.
3. Prefer improvements that:
   - improve `score/row`
   - reduce `over/row`
   - do not collapse `mix/lb`
4. Promote only the best few candidates to larger confirmation runs.
