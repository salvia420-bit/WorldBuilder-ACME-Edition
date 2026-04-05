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
- `WorldGrammar/`
  - retail-Dereth world-grammar extraction, training wrappers, and detached execution
  - owns the AC-like world-fill prior line and is intentionally separate from `OutdoorML`

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

Current direction:

- `OutdoorML` remains the older outdoor/planner-oriented ML lane
- `WorldGrammar` is the new world-reproduction lane
- future work should not describe `WorldGrammar` as `OutdoorML v2`
- the two lines should not emit the same kind of placement output at the same stage

World-reproduction plan:

1. `WorldGrammar-Macro`
   - classify large-scale region character such as town, wilderness, housing, roadside, ruin, fort, village, tower, temple, or castle-like zones
   - output region priors and density/style hints, not exact objects
2. `WorldGrammar-Scatter`
   - handle broad outdoor clutter and ordinary world fill such as rocks, trees, cactus, ambient props, and biome-adjacent scatter
3. `WorldGrammar-Settlement`
   - place AC-like settlement structure: houses, doors, portals, lifestones, civic/service clusters, and settlement-edge transitions
   - the current component-linked abstract-ACE scene-placer work is the first step toward this stage
4. `WorldGrammar-POI`
   - learn structural archetypes for forts, towers, ruins, temples, castles, camps, villages, and other landmark families without training on POI names
5. `WorldGrammar-Interior`
   - learn interior object placement inside buildings and dungeons: furniture, doors, containers, hooks, room-type priors, and retail-like building completeness
6. `WorldGrammar-Micro`
   - handle support-aware placement such as objects on tables, shelves, walls, counters, and other parent-surface relationships

Target end-state:

1. macro pass chooses region mode
2. world-grammar pass proposes ordinary AC-like structure
3. interior pass fills interior-capable structures
4. micro pass places supported small objects with retail-like local accuracy
5. reranking and validation remove repetitive or illegal placements

Immediate training priority:

- keep `WorldGrammar` as the base world-fill prior
- next high-value training work should favor `Interior` and `Macro` data/model construction instead of collapsing everything into one monolithic scene-placer
