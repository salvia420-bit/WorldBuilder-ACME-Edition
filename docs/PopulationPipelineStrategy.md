# Population Pipeline Strategy

## Purpose

This note captures the current state of the world population pipeline, why the
existing `train_scene_placer.py` approach is not enough to reach retail-quality
world population on its own, and the staged direction we should take instead.

The goal is not merely "plausible object spam." The goal is a new world that
feels as if AC developers authored it:

- towns and hubs in sensible places
- roads, portals, lifestones, vendors, and services arranged coherently
- wilderness populated with biome-appropriate trees, rocks, ruins, and camps
- interiors and linked object graphs preserved or reconstructed correctly
- no corrupt overlapping EnvCells or invalid placements that crash the world


## Current Pipeline

The repo already has several separate population-related systems:

1. Manual / deterministic town relocation
   - `tools/town_placer.html`
   - `scripts/reseed_town_instances_from_retail.py`
   - `scripts/remap_town_network_portals.py`
   - `scripts/remap_outdoor_instances_from_lb_remap.py`

2. Heuristic broad population
   - `scripts/build_population_plan.py`

3. ML outdoor placement
   - `scripts/extract_placement_tensors.py`
   - `scripts/train_scene_placer.py`
   - `scripts/generate_populated_world.py`

4. Terrain generation / smoothing
   - `scripts/train_terrain_v3.py`
   - `scripts/smooth_vanquish_v3.py`

This is already closer to a hybrid pipeline than a single-model pipeline.
That is a good thing.


## What The Current Scene Placer Actually Does

The current scene placer is best understood as a retail-trained outdoor
landblock object-sequence model with weak context. It is useful for:

- broad object variety
- approximate outdoor density
- some housing-like placement
- rough settlement texture
- general non-ocean landblock filling

It is not currently capable of reproducing full AC developer-quality world
authoring across all placement scales.


## Critical Limits In The Current ML Design

### 1. The model does not learn full object state

The training tensors include:

- `z`
- `weenie_type`
- `parent_wcid_idx`
- sequence position

But the model only predicts:

- `wcid`
- `x/y`
- `rotation`
- link-child flag

That means the current model is not trained to reconstruct:

- floor-aware placement
- exact vertical placement
- prop-on-prop relationships
- rich parent-child graph structure
- many semantics needed for indoor fidelity

So "a bottle on a table on the second floor of a house on a hill" is outside
the real capability of the current architecture.

### 2. Indoor and outdoor data are mixed, but inference is outdoor-only

`extract_placement_tensors.py` currently parses both outdoor and indoor
instances, but `generate_populated_world.py` emits outdoor landblock instances
and snaps them to terrain.

That is a train/infer mismatch.

If interior objects are present in training but generation has no interior cell
graph to place them into, the model cannot cleanly learn what we actually want.

### 3. Context is too weak for retail-accurate placement

The context vector currently uses:

- 9x9 heights
- normalized map position
- synthetic biome approximation
- synthetic culture Voronoi
- difficulty tier
- neighbor density
- flatness
- simplified coast-distance

But terrain types and road flags are placeholders, and there is no explicit
conditioning on:

- real terrain paint
- roads
- shoreline geometry
- building footprints
- town adjacency
- structure interiors
- room topology
- portal graph

That makes retail-grade accuracy impossible even with a better model.

### 4. Neighbor-density conditioning is inconsistent

Training uses retail instance counts in the context.
Generation currently passes an empty `instance_counts` dictionary.

So the model sees a different context distribution at inference than it saw in
training.

### 5. General object links are not rebuilt at inference

The generator can emit `is_link_child`, but regular inference currently writes
flat outdoor instances and does not rebuild general parent-child links.

Only the separate housing path has special link handling.

### 6. Dense areas are clipped

Training caps each landblock sequence to `MAX_OBJECTS_PER_LB = 128`.

That is survivable for some wilderness blocks, but it is a real bottleneck for:

- dense towns
- clutter-rich retail areas
- interior-heavy regions
- complex authored scenes


## Conclusion: One Monolithic Training Run Is The Wrong Target

If the bar is "retail-dev accurate, but with variance," then one model should
not be expected to do all of these at once:

- wilderness foliage
- road corridors
- town macro layout
- town service composition
- houses and house chains
- interiors
- object-on-object micro props
- encounter generator placement

These are different scales, different constraints, and different data shapes.

The right direction is a staged, hierarchical population pipeline.


## Recommended Architecture

### Stage 1: Region / Semantic Planner

Per-landblock classification for:

- ocean / shoreline / inland
- forest / desert / mountain / swamp / plains
- wilderness / town fringe / town core
- road corridor
- ruins / camp / dungeon-entry region
- housing district / market / civic hub

This stage should be deterministic or low-variance and driven by terrain,
roads, coastline, major destinations, and design intent.

### Stage 2: Macro Structure Placement

Place the high-impact authored content:

- towns
- roads
- portals
- lifestones
- vendors / services
- major structures
- camps / POIs
- dungeon entrances

This should use a mix of:

- retail cluster reseeding
- remap logic
- learned macro placement
- explicit validators

### Stage 3: Outdoor Scatter / Foliage

Dedicated placement pass for:

- trees
- rocks
- bushes
- desert clutter
- ambient props
- biome-specific outdoor dressing

This should be separate from macro town placement. Trees and rocks are high
count, mostly local, and better handled by a specialized system.

### Stage 4: Encounter / Spawn Population

Separate pass for:

- encounter generators
- creature density
- regional progression
- spawn composition

This should be coupled to difficulty, biome, and region identity, not learned
implicitly inside a general object-sequence model.

### Stage 5: Interior / Linked Object Placement

Separate pipeline for:

- interiors
- doors / portals / reciprocal links
- room-aware placement
- object-on-object relationships
- floor-aware placement

This is where the "bottle on table" problem belongs.

### Stage 6: Validation and Repair

Every mutating stage should end with validation.

Not optional.


## Practical Path For Vanquish

For the current Vanquish world, the shortest path to high quality is:

1. Keep deterministic town relocation and reseeding.
2. Keep retail cluster remap / reseed for structured authored content.
3. Use ML or weighted sampling for outdoor non-town object placement.
4. Add a dedicated foliage / scenery population pass.
5. Treat interiors as a separate project.

This is the fastest route to a world that feels authored without asking one
model to solve every scale of the problem.


## Investigation Notes From External Repos

### ACE emulator repo

Investigated:

- `C:\Users\Andrew\Desktop\GitHubCleanup\vendored_repos\ACE-master`

Relevant observations:

- ACE clearly distinguishes landblock content, encounters, portals, housing,
  and EnvCell / landblock runtime behavior.
- `Source\ACE.Server\Entity\Landblock.cs` shows that encounters are loaded
  separately from landblock static content and spawned into outdoor blocks.
- The ACE changelog includes several crash / validation / landblock / EnvCell
  fixes over time, including pre-validating EnvCell transitions.

Implication:

The emulator itself already treats these systems as separate concerns. That is
further evidence that our pipeline should do the same.

### Vanquish play kit

Investigated:

- `C:\Users\Andrew\Desktop\GitHubCleanup\vanquishkit`

Key included assets:

- final `client_cell_1.dat`
- SQL reseed / remap / reposition payloads
- `lb_remap.json`
- `town_placements.json`

Implication:

Vanquish is currently a hybrid authored/remapped world already. The right
population strategy should extend that hybrid model rather than replacing it
with one giant ML pass.


## Crash Theory: EnvCells and Overlap

There is a plausible failure mode where relocated / remapped EnvCells or
interior-related data overlap, become invalid, or otherwise create bad
transitions that lead to crashes in specific places.

This is still a hypothesis. It has not been proven in this note.

However, the following are worth investigating:

1. Overlapping EnvCell footprints after town remaps
2. Interior entrance / exit pairs no longer agreeing
3. Multiple large EnvCell regions stacked into the same outdoor area
4. Broken visible-cell or portal target relationships
5. Reposition SQL moving objects into invalid or conflicting cells

The specific idea raised here is sensible:

- if the large interior-sea EnvCell cluster is causing conflicts, relocate it to
  a remote, unused corner of world space
- likely top-right or bottom-right if space allows and if no other systems
  depend on the original footprint

This should be done only after validation tooling is in place.


## Validator Roadmap

We should add validators specifically for population and world safety.

### Required validators

1. EnvCell overlap validator
   - detect overlapping interior footprints
   - detect duplicate or conflicting area occupancy

2. Building / interior portal validator
   - entrance -> exit reciprocity
   - exit -> entrance reciprocity
   - target cell existence
   - target cell uniqueness

3. Landblock instance validator
   - bounds checks
   - impossible Z values
   - degenerate rotations
   - duplicate GUID / link path issues

4. Population graph validator
   - parent-child link integrity
   - no orphaned link children
   - no cycles where prohibited

5. Town safety validator
   - service presence
   - lifestone / portal / vendor minimums
   - no impossible structure overlap

6. World crash-risk validator
   - suspicious clusters
   - over-dense linked instances
   - invalid portal destinations
   - known bad transition patterns


## Terminal / REPL Notes

This environment cannot currently build or run the full .NET / Python stack
freely, so investigation must lean on code reading, data inspection, and
design-first planning.

That is still useful.

Relevant existing surfaces:

- `WorldBuilder.Terminal --help`
- interactive `help`
- JSON stdin mode
- `docs/agent_api_reference.md`
- `docs/agent_api_schema.json`

The terminal already documents a validation-first workflow:

- mutate
- run `validate-all`
- fix
- repeat

That is exactly the habit the population pipeline should adopt.


## Recommended Next Steps

1. Split "population" into explicit pipeline stages in docs and code.
2. Keep town reseed/remap as a first-class deterministic stage.
3. Add a dedicated foliage / scenery stage for trees, rocks, and ambient props.
4. Define a separate interior-placement project instead of forcing it into the
   current outdoor scene placer.
5. Add EnvCell overlap and portal/integerity validators.
6. Audit Vanquish crash locations against remapped towns, EnvCells, and
   reposition SQL.
7. Upgrade the ML extractor only after the stage boundaries are clear.


## Working Decision

We are not going to pursue "one training run that does everything."

We are going to build the population pipeline the staged way:

- structured content first
- outdoor scatter separately
- encounters separately
- interiors separately
- validators everywhere

That is the right way for this repo, this data, and the quality target.
