# Interior Support / Interior Placement Handoff

Date: 2026-04-05  
Repo: `/home/salvia420/WorldBuilder-ACME-Edition`  
Branch at handoff: `master`  
Latest relevant pushed commit: `e10add3` (`Add interior review bootstrap outputs`)

## Purpose

This document is the current handoff for the interior-placement support-labeling line.

This work is **not** the OutdoorML full-world run and is **not** the town grammar or outdoor tensor lane. The goal here is the much harder retail-style interior micro-placement problem:

- object-on-table
- object-on-shelf
- object-on-desk
- object-on-hook / wall attachment
- other “placed on / attached to interior support” relationships

Historically, AC retail developers could use authoring tools / GUI placement workflows to put props on tables, shelves, and other supports inside interiors. We are trying to recover enough trustworthy supervision from retail data exports to eventually train a tensor/model stage that can reproduce that effect.

## Bottom Line

As of this handoff:

- the pipeline/runtime issues are fixed
- the interior extractor is much more honest than when this started
- the terminal exporter now emits useful static support geometry
- the first geometry-backed review pass rejected all current review candidates
- there is **still no model-ready supported-prop dataset**

Current honest counts from [`interior_support_dataset_highconf_summary.json`](/home/salvia420/WorldBuilder-ACME-Edition/pipeline_data/reference/interior_support_dataset_highconf_summary.json):

- `scanned_rows`: `581,430`
- `interior_rows`: `320,455`
- `support_objects_emitted`: `194,632`
- `static_support_objects_emitted`: `5,353`
- `gold_props_emitted`: `0`
- `silver_props_emitted`: `0`
- `review_candidate_emitted`: `7`
- `candidate_rows_emitted`: `8`
- `motif_rows_emitted`: `0`
- `review_packets_emitted`: `7`
- `bootstrap_rows_emitted`: `0`

This means:

- we do have broad support-object recovery
- we do **not** yet have enough truthful prop-on-support labels for training
- the current candidate set is mostly noise, and the geometry upgrade proved that by invalidating earlier point-distance “silver” rows

## What Exists Now

### Core extractor

Main script:

- [`extract_support_aware_interior_dataset.py`](/home/salvia420/WorldBuilder-ACME-Edition/scripts/PopulationPipeline/Interiors/extract_support_aware_interior_dataset.py)

Current responsibilities:

- recover support objects from dynamic instances and static DAT-backed envcell objects
- recover direct graph-linked parent relationships when present
- generate ranked weak prop/support candidates
- emit review packets for human-in-the-loop inspection
- optionally consume review decisions and emit bootstrap-promoted labels

### Town wrapper

Town-only wrapper:

- [`extract_town_support_aware_interior_dataset.py`](/home/salvia420/WorldBuilder-ACME-Edition/scripts/PopulationPipeline/Interiors/extract_town_support_aware_interior_dataset.py)

This was tried because towns seemed likely to be a target-rich environment for indoor placements. In practice, the exported town-interior subset was too sparse to solve supervision by itself.

### Terminal-side exporter upgrades

Relevant implementation:

- [`CommandEngine.cs`](/home/salvia420/WorldBuilder-ACME-Edition/WorldBuilder.Terminal/CommandEngine.cs)

Implemented terminal/export improvements:

- static object orientation:
  - `qw`, `qx`, `qy`, `qz`
  - `yawDeg`
- static object conservative bounds:
  - `aabbLocal`
- static object conservative support hints:
  - `supportSurfaceHints`
  - currently emits a conservative `top_plane` hint with:
    - `surfaceClass`
    - `supportClass`
    - `originLocal`
    - `normalLocal`
    - `extentLocal`
    - `confidence`
    - `inferenceMode = "model_bounds_top_plane"`

These terminal upgrades were necessary and are correct. They made the downstream extractor stricter and more trustworthy.

## Current Output Files

Primary reference outputs:

- support objects: [`interior_support_objects_highconf.jsonl`](/home/salvia420/WorldBuilder-ACME-Edition/pipeline_data/reference/interior_support_objects_highconf.jsonl)
- gold prop/support labels: [`interior_supported_props_highconf.jsonl`](/home/salvia420/WorldBuilder-ACME-Edition/pipeline_data/reference/interior_supported_props_highconf.jsonl)
- silver prop/support labels: [`interior_supported_props_silver.jsonl`](/home/salvia420/WorldBuilder-ACME-Edition/pipeline_data/reference/interior_supported_props_silver.jsonl)
- ranked candidates: [`interior_supported_prop_candidates_ranked.jsonl`](/home/salvia420/WorldBuilder-ACME-Edition/pipeline_data/reference/interior_supported_prop_candidates_ranked.jsonl)
- top review candidates: [`interior_supported_prop_candidates_review.jsonl`](/home/salvia420/WorldBuilder-ACME-Edition/pipeline_data/reference/interior_supported_prop_candidates_review.jsonl)
- motifs: [`interior_supported_prop_motifs.jsonl`](/home/salvia420/WorldBuilder-ACME-Edition/pipeline_data/reference/interior_supported_prop_motifs.jsonl)
- review packets: [`interior_supported_prop_review_packets.jsonl`](/home/salvia420/WorldBuilder-ACME-Edition/pipeline_data/reference/interior_supported_prop_review_packets.jsonl)
- bootstrap-promoted labels: [`interior_supported_props_bootstrap.jsonl`](/home/salvia420/WorldBuilder-ACME-Edition/pipeline_data/reference/interior_supported_props_bootstrap.jsonl)
- summary: [`interior_support_dataset_highconf_summary.json`](/home/salvia420/WorldBuilder-ACME-Edition/pipeline_data/reference/interior_support_dataset_highconf_summary.json)

Review decisions created in this session:

- [`interior_supported_prop_review_decisions_v1.jsonl`](/home/salvia420/WorldBuilder-ACME-Edition/pipeline_data/reference/interior_supported_prop_review_decisions_v1.jsonl)

Example review-decision schema:

- [`bootstrap_review_decisions_example.jsonl`](/home/salvia420/WorldBuilder-ACME-Edition/scripts/PopulationPipeline/Interiors/bootstrap_review_decisions_example.jsonl)

## What Happened During This Session

### 1. Fixed extractor runtime / hot-path issues

The earlier extractor path had enough overhead that runs were effectively stalled or too opaque to trust. The hot path was tightened and progress logging was added so full-world runs could complete and be inspected.

That part is solved.

### 2. Built the first conservative support-aware extractor

The extractor originally focused on:

- support-object rows
- direct graph-linked supported-prop rows
- limited geometric fallback

That produced some early apparent positives, but they were not stable enough to trust.

### 3. Invalidated an earlier false positive

A previous “supported prop” result turned out to be cross-cell / cross-component noise. The extractor was tightened to reject:

- different-cell parent relationships
- different-component parent relationships
- below-parent-plane relations

This was necessary and correct.

### 4. Added static support recovery from envcell component data

Static DAT-backed supports were promoted into the support catalog using canonical `setupDid` / `model_id` naming, which increased support coverage substantially.

This materially improved support coverage:

- `shelf_like: 5,169`
- `table_like: 45`
- `bed_like: 206`

But it still did not create enough trustworthy prop/support labels.

### 5. Tried weak supervision / motifs / semantic priors

The extractor was extended to:

- rank top-k support candidates per prop
- split weak labels into tiers
- mine repeated motifs
- promote repeated semantic patterns into silver when evidence repeated

Before the geometry-aware exporter was integrated, this briefly produced a tiny `silver` set.

### 6. Integrated real support-plane geometry from terminal export

This was a key step.

The refreshed `envcell_components_full.jsonl` now contains:

- `593,927` static objects with `aabbLocal`
- `286,005` static objects with `supportSurfaceHints`

After the extractor started using those real support planes and footprints:

- previous point-distance “silver” labels disappeared
- current result became:
  - `gold: 0`
  - `silver: 0`
  - `review: 7`
  - `candidates: 8`

This is painful for recall, but correct for precision. It means the old `silver` set was mostly optimistic nearest-neighbor noise.

### 7. Built a review/bootstrap lane

The extractor now emits:

- one review packet per prop candidate group
- stable `reviewKey`
- stable `reviewGroupKey`
- compact top-k evidence per prop
- optional bootstrap output driven by review decisions

This is now the cleanest programmatic path to grow labels without blind guessing.

### 8. Performed the first review pass

We reviewed the current `7` geometry-backed packets.

Outcome:

- `0 accepted`
- `7 rejected`

Reasons:

- 6 were chest/container-top candidates with large horizontal offsets and no surface hints
- 1 was a bookcase candidate, but the prop sat well outside the inferred support footprint

The reject decisions were written to:

- [`interior_supported_prop_review_decisions_v1.jsonl`](/home/salvia420/WorldBuilder-ACME-Edition/pipeline_data/reference/interior_supported_prop_review_decisions_v1.jsonl)

The extractor was rerun with that file, and the bootstrap output correctly remained empty.

## Important Conclusions

### 1. The current export is not preserving enough direct interior micro-placement truth

We are not failing because the code is crashing anymore. We are failing because the underlying source evidence is sparse.

More specifically:

- direct `parentGuids` almost never yield valid same-cell same-component support relations
- nearest-neighbor geometry alone mostly finds chests and other false positives
- even after static furniture recovery, there are not enough repeated stable placements to auto-promote with confidence

### 2. The geometry-aware path is correct, even though it reduced label count

This is the most important reality check from the session.

The fact that geometry-backed scoring reduced `silver` from nonzero to zero does **not** mean the exporter work was a mistake. It means the earlier point-based candidate logic was overpromoting bad labels.

The current state is more useful because it is more honest.

### 3. We are still not close to model-ready supported-prop supervision

Support-object rows are not the bottleneck.

The bottleneck is training-grade prop/support relations. Right now we have:

- plenty of support objects
- almost no trustworthy prop-on-support pairs

That is not enough for a tensor model.

## Relevant Commit Trail

Recent interior-specific commit history:

- `e10add3` `Add interior review bootstrap outputs`
- `2d4f463` `Use exported support surface hints in interior ranking`
- `ab75f5a` `Export envcell support surface hints`
- `2952258` `Export envcell static object bounds`
- `17a0e9b` `Add interior support exporter plan`
- `6a38487` `Add town interior support dataset wrapper`
- `77a88e9` `Expand interior semantic prior promotion`
- `e3d463d` `Emit interior support motifs`
- `e5cd6e0` `Split interior weak labels by tier`
- `1b54dd9` `Add ranked weak supervision for interiors`

These are already pushed to `origin/master`.

## Commands Used / Current Repro Path

### Regenerate envcell component export

The current component export was regenerated through `WorldBuilder.Terminal` JSON stdin mode using the `RetailSmoke` project:

Project:

- `/home/salvia420/projects/RetailSmoke/RetailSmoke.wbproj`

Command shape:

```bash
printf '%s\n%s\n%s\n' \
  '{"command":"load","path":"/home/salvia420/projects/RetailSmoke/RetailSmoke.wbproj"}' \
  '{"command":"export-envcell-components","outputPath":"/home/salvia420/WorldBuilder-ACME-Edition/pipeline_data/reference/envcell_components_full.jsonl"}' \
  '{"command":"quit"}' \
  | /home/salvia420/WorldBuilder-ACME-Edition/WorldBuilder.Terminal/bin/Debug/net8.0/WorldBuilder.Terminal --stdin
```

### Run the interior extractor

Without review decisions:

```bash
python3 -u /home/salvia420/WorldBuilder-ACME-Edition/scripts/PopulationPipeline/Interiors/extract_support_aware_interior_dataset.py
```

With review decisions:

```bash
python3 -u /home/salvia420/WorldBuilder-ACME-Edition/scripts/PopulationPipeline/Interiors/extract_support_aware_interior_dataset.py \
  --review-decisions-jsonl /home/salvia420/WorldBuilder-ACME-Edition/pipeline_data/reference/interior_supported_prop_review_decisions_v1.jsonl
```

## What Should Happen Next

If this line is resumed later, the highest-probability next moves are:

### A. Improve candidate generation upstream

This is the main recommendation.

Best next target:

- export richer per-prop support-plane candidate evidence directly from terminal-side geometry

Examples of useful extra fields:

- top-N nearest support surfaces per prop
- plane distance
- footprint inclusion / overflow
- surface orientation agreement
- competing support count
- maybe object bounding extents if obtainable for props as well

Why:

- the current Python extractor is still inferring too much downstream
- better terminal-side candidate evidence is more likely to recover truthful furniture-based candidates than more Python threshold tuning

### B. Continue the review/bootstrap lane once better candidates exist

The review/bootstrap scaffolding is ready now. Once candidate quality improves:

- inspect `interior_supported_prop_review_packets.jsonl`
- accept real placements
- rerun with `--review-decisions-jsonl`
- accumulate `interior_supported_props_bootstrap.jsonl`

This is the safest path to grow labels without guessing.

### C. Do not loosen thresholds just to create labels

This was effectively tested already.

The earlier weak labels looked more optimistic but did not survive geometry scrutiny. More lenient promotion rules will likely create prettier wrong answers, not useful training data.

### D. If another data source exists, it may matter more than extractor tuning

If a richer retail/editor-like interior placement source exists anywhere, it could be more valuable than continued inference from current exports.

Examples:

- editor-side placement metadata
- stronger interior parent/support relationships
- another export with clearer static furniture/support semantics

## Known Good / Known Bad

### Known good

- terminal exporter builds and runs
- `envcell_components_full.jsonl` has real static geometry and support hints
- extractor completes end to end
- review/bootstrap lane works mechanically
- current reviewed baseline is explicitly recorded

### Known bad / unresolved

- no gold supported-prop labels
- no surviving silver labels after geometry correction
- no motif-backed repeated positives
- current review set is all rejected
- model training is premature

## Worktree Note

This repo has unrelated existing modified/untracked files outside the interior-support lane. At handoff time, `git status --short` included unrelated work in:

- `docs/ComponentLinkedTraining.md`
- several `scripts/PopulationPipeline/OutdoorML/*`
- several `scripts/PopulationPipeline/WorldGrammar/*`
- some model/data artifacts and utility scripts

Those were not part of this interior-support work and were not reverted.

## Short Takeaway

The project is in a much better state technically than when this session started:

- exporter is richer
- extractor is faster and more transparent
- false positives are being rejected instead of promoted
- review/bootstrap infrastructure exists

But the core business reality is unchanged:

we still do **not** have enough trustworthy interior prop-on-support labels to train an interior micro-placement model.

The next likely win is better candidate generation from terminal-side geometry, then using the new review/bootstrap lane to accumulate true labels deliberately.
