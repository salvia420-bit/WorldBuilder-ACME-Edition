# Population Pipeline Scripts

This folder is the home for population-pipeline implementation scripts.

Why this exists:

- the `scripts/` root was getting too flat to navigate safely
- population work is now explicitly staged in `docs/PopulationPipelineStrategy.md`
- future population work should land here instead of mixing with unrelated terrain, diagnostics, and one-off worldgen utilities

Current staged layout:

- `Planning/`
  - heuristic or semantic planning passes such as `build_population_plan.py`
- `MacroPlacement/`
  - deterministic reseed, remap, and authored-structure placement helpers
- `OutdoorML/`
  - outdoor tensor extraction, training, inference, housing/link support, and QA

Compatibility rule:

- existing `scripts/*.py` entrypoints remain as thin forwarding wrappers
- `scripts/PopulationPipeline/*.py` also remain as thin forwarding wrappers while the staged layout settles
- new work should target the stage folder first, not the root wrapper
- wrappers can be removed in a later cleanup pass once downstream docs and habits have shifted

Recommended next subfolders when the pipeline grows:

- `scripts/PopulationPipeline/Scatter/`
- `scripts/PopulationPipeline/Encounters/`
- `scripts/PopulationPipeline/Interiors/`
- `scripts/PopulationPipeline/Validation/`

These folders now exist as placeholders with stage-specific README notes so the
intended ownership is visible before the implementations arrive.
