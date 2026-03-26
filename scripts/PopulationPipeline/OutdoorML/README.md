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

Current validated inference baseline from March 26, 2026:

- checkpoint: `scene_placer_resume_ema.pt`
- `temperature=1.0`
- `top_k=0`
- `nucleus_p=1.0`
- `min_objects=5`
- `adaptive_min_objects_bonus=2`
- `pad_logit_bias=1.0`
- `stop_logit_bias=0.5`

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

Service-completion notes:

- town-lifestone completion is part of the current validated inference path
- town-vendor completion now appears to generalize across at least two `20x20` regions and is part of the current validated path
- use `--no-inject-town-vendors` only when you explicitly want to disable the vendor completion pass
