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
- `housing_linker.py`
- `score_placement_quality.py`
