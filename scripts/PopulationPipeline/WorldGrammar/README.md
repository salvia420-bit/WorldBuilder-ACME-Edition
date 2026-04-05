# WorldGrammar

`WorldGrammar` is the AC-like world-fill pipeline.

It is intentionally separate from `OutdoorML`.

Division of labor:

- `OutdoorML`: older mixed planning / placement experiments
- `WorldGrammar`: retail world-grammar prior for towns, wilderness, housing, and ordinary world fill

Rules:

- New training runs should use `world_grammar_*` run names.
- New detached sessions should use the wrappers in this directory.
- New tensors and vocab files should prefer `world_grammar_component_linked_abstract_ace_*` filenames.
- Do not describe this pipeline as `OutdoorML v2`.

Recommended loop:

1. Extract or refresh world-grammar tensors with `extract_world_grammar_tensors.py`.
2. Train with `train_world_grammar.py`.
3. Resume detached runs with `resume_world_grammar_detached.sh`.
4. Treat this model as the base world-grammar prior.
5. Layer other passes on top later instead of merging responsibilities back into `OutdoorML`.

Current default target mode:

- component-linked
- abstract ACE classes for WCID-backed objects
- exact model IDs for DAT-backed world objects

