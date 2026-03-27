# Outdoor ML

This stage owns outdoor-only ML extraction, training, inference, and QA.

What belongs here:

- tensor extraction for outdoor placement
- model training
- outdoor generation
- outdoor placement quality scoring
- shared helpers tightly coupled to the outdoor ML flow

Current contents:

- `extract_placement_tensors.py`
- `train_scene_placer.py`
- `generate_populated_world.py`
- `run_small_region_probe.py`
- `debug_first_token_logits.py`
- `housing_linker.py`
- `score_placement_quality.py`
- `analyze_retail_housing.py`
- `analyze_population_gaps.py`

Current validated inference baseline from March 26, 2026:

- checkpoint: `scene_placer_resume_ema.pt`
- `temperature=1.0`
- `top_k=0`
- `nucleus_p=1.0`
- `min_objects=5`
- `adaptive_min_objects_bonus=2`
- `pad_logit_bias=1.0`
- `stop_logit_bias=0.5`

Current code-level safeguards:

- `extract_placement_tensors.py` now accepts `--retail-sql` and `ACE_RETAIL_SQL`
  so the retail SQL path is no longer hardcoded to one machine
- the extractor filters indoor rows before building OutdoorML training examples
- `generate_populated_world.py` canonicalizes raw sampled slumlord WCIDs back
  into the housing-token path so housing is emitted through `HousingLinker`
  instead of leaking unlinked slumlord instances
- housing autoregressive state now preserves `weenie_type=55` for generated
  housing tokens so inference matches training more closely

Operational note:

- small-region probe results in this environment differ materially between CPU and CUDA
- prefer CUDA-backed runs for validation; `run_small_region_probe.py` now requires CUDA by default
- use `--allow-cpu` only when you explicitly want a CPU fallback diagnostic

Current validated larger-scale results:

- `10x10` CUDA region: `83.8/100`
- `20x20` CUDA region after lifestone completion: `80.8/100`
- `20x20` CUDA region with service completion: `83.1/100`
- second `20x20` CUDA region after lifestone completion: `81.7/100`
- second `20x20` CUDA region with service completion: `83.6/100`

Current experimental leader:

- planner-conditioned inference branch
- softened planner family constraints currently score:
  - `85.2/100` on one `20x20` region
  - `84.8/100` on a second `20x20` region
- current planner-soft probe:
  - `accepted=244`
  - `PAD=11`
  - `STOP=25`

Planner-stage artifacts:

- `extract_settlement_planner_tensors.py`
- `train_settlement_planner.py`
- `pipeline_data/models/settlement_planner.pt`

Interpretation:

- the old single-stage line remains the safer historical baseline
- the planner-soft branch is the first line to beat the repeated `83.6` regional plateau
- future score work should focus on clustering within the planner path rather than more scalar tuning of the old single-stage path

Service-completion notes:

- town-lifestone completion is part of the current validated inference path
- town-vendor completion now appears to generalize across at least two `20x20` regions and is part of the current validated path
- use `--no-inject-town-vendors` only when you explicitly want to disable the vendor completion pass

Current analysis helpers:

- `analyze_retail_housing.py` summarizes retail housing density and house-family token coverage
- `analyze_population_gaps.py` compares retail vs generated SQL for dense-town service gaps, slumlord-link coverage, and coarse family co-occurrence

Detached execution:

- use `run_outdoorml_detached.sh` from the repo root to launch a bounded cycle
  under a detached `tmux` session so it survives SSH disconnects
- the script writes a run directory under `pipeline_data/population_output/detached_runs/`
  with `stdout.log`, `pid.txt`, `session.txt`, and a copy of the exact command used
