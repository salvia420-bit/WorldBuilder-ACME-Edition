# docs/ Index — triaged 2026-05-19 by docs-cleanup agent

Conservative triage pass. 12 March/April-2026 files moved to `archive/`. Nothing deleted. Everything else left in place (most top-level docs are code-referenced or referenced from root-level docs like `README.md` / `spin.md` / `wireprompt.md` — moving would break links).

## Live methods + active plan (cite from code; do NOT move)

- `diagnostic-toolset-plan-2026-05-19.md` — active 14-surface toolset plan + 5-wave team-agent execution. **LOCKED — Wave 3.A editing concurrently.**
- `physics-parity-method.md` — physics contract. **LOCKED — Wave 3.A editing concurrently.**
- `world-completeness-method.md` — placement contract (validator: `validate_landblock_completeness.cjs`)
- `entity-completeness-method.md` — entity classification (validator: `validate_entity_classification.cjs`)
- `event-completeness-method.md` — sound/particle event contract (validator: `validate_event_completeness.cjs`)
- `wire-conformance-method.md` — wire-packet contract (Wave 1 brick; cited in `validate_wire_conformance.cjs`)
- `ring-diagnose-repair-playbook.md` — operational diagnose+repair workflow (2026-05-23; ties Phase E validators to client-side `__diag`)
- `ring-expansion-method.md` — one-shot LB-range expansion (2026-05-23; current 3-CLI recipe + proposed `bake-region` orchestrator)
- `dat-parity-method.md` — DAT parity (Wave 2; cited in `validate_dat_parity.cjs`)
- `enum-parity-method.md` — enum parity (Wave 2.C/D)
- `motion-parity-method.md` — motion-table parity (Wave 3.B)
- `hypotheticalmethod.md` — original planning record for the completeness method (cited from `holtburger-scenery-bake/src/lib.rs`); superseded by world-completeness-method.md but retained for history
- `ace-local-setup.md` — ACE bring-up recipe, cited from many capture scripts
- `agent_api_reference.md` + `agent_api_schema.json` — WB.Terminal protocol catalog (cited from README.md, spin.md, wireprompt.md)
- `terminal_repl_commands.md` — REPL catalog (cited from README.md, wireprompt.md)
- `USER_GUIDE.md` — user-facing guide (cited from README.md)
- `HowToMakeNewWorlds.md` — pipeline guide (cited from README.md)

## Recent shipping records + status (last 30 days)

- `completeness-wave-1-shipping-record-2026-05-19.md` — Wave 1 docket (6 agents)
- `wave3-prereq-status.md` — Wave 3 prereqs (ACE keepalive, dev account)
- `scenery-bake-b5-collision-parity-report.md` — 16,700-placement 100% parity (2026-05-16)
- `scenery-bake-b4-parity-report.md` — predecessor B4 report (2026-05-14)
- `world-expand-step-1-asbuilt-2026-05-14.md` — 13×13 ring shipped
- `world-expand-step-1-handoff.md` — brief for the above
- `world-expand-oracle-parity-2026-05-14.md` — oracle parity report
- `world-expand-step-1-screenshots-2026-05-14/` — 10× 1920×1080 PNGs + README
- `world-completeness-demo-2026-05-14/` — 6× demo PNGs (Phase D)
- `skybox-volumetric-clouds-handoff-2026-05-15.md` — Clouds-A→D context
- `sky-experiment-2026-05-15/` — Sky-K experiment shots + README
- `visual-fidelity-handoff-pk-2026-05-13.md` — 12/14 phases shipped (PK on 1070)
- `visual-fidelity-push-prompt-2026-05-13.md` — original 14-phase plan
- `visual-fidelity-eval-2026-05-13/` — 11× evaluation PNGs + README
- `tree-sway-investigation-2026-05-13.md` — wind/sway scoping
- `screenshots/holtburger-1070-fixes-2026-05-16/` — 10× in-game 1070 captures + README

## Renderer / 3D port history (Phase 7+ and camera/skybox pushes)

- `3d-port-state-2026-05-10.md` — canonical 3D port state doc
- `3d-camera-game-feel-fix-prompt.md` — 8-commit camera/movement push (complete; archive header at top)
- `3d-polish-pass-prompt-2026-05-12.md` — Cohere session planning
- `3d-port-screenshots-2026-05-10/` — 6× early-3D captures
- `f3-live-ace-debug.md` — F#3 live-ACE timeout investigation

## Phase reports (load-bearing references; cited from code + each other)

- `thorough.md` — long-lived Phase 5 brief
- `manifest.md` — Phase 5.2 manifest-rewrite brief
- `phase-2-step-4-handoff.md`
- `phase-2-wasm-spike.md`
- `phase-3-renderer.md`, `phase-3-step-1-handoff.md`, `phase-3-step-2-handoff.md`, `phase-3-step-3-handoff.md`, `phase-3-step-4.5-handoff.md`
- `phase-4-renderer.md`, `phase-4-step-1-handoff.md`, `phase-4-step-3.6-movement-system.md` (cited from `holtburger-core/movement/handle.rs`)
- `phase-5.2-manifest-fix.md`, `phase-5-thorough.md`
- `phase-6-buildings-and-interiors.md` (cited from `capture_phase6_step_f_dungeon.cjs`)
- `post-phase-6-followons-handoff.md`
- `emit-dynamic-site.md` — the long-lived design doc (partially stale per 3d-polish-pass; still load-bearing)

## Operational / generated artifacts (referenced from root or runtime)

- `sample-dist/` — emitted static-site dist; cited from `README.md` + `spin.md` (do NOT touch)
- `images/` — heavily referenced from `README.md` + `*.cjs` capture scripts (do NOT touch)
- `prompts/` — 6 historical agent prompts (dereth_maps_enhanced, living_atlas_review, ontology_classifier_rewrite, placer_atlas_context_v6, unified_placer_v5_calibration, code_review_terrain_query_object_mgmt_prompt). Self-contained; informational rather than active links.

## Lingering historical (referenced from root-level files, kept in place)

- `gui_terminal_gap_analysis_2026-03-25.md` — cited from `wireprompt.md`
- `PopulationPipelineProgress.md` — cited from `run_population_overnight.sh`, `finalize_local.sh`
- `PopulationPipelineStrategy.md` — cited from `run_population_overnight.sh`, `finalize_local.sh`, `scripts/PopulationPipeline/README.md`
- `ComponentLinkedTraining.md` — cited from `2026-04-05_interior_support_handoff.md` (root)

## Archived (moved to `docs/archive/` — kept in tree, safe to glance later)

All have zero inbound references from code or root-level docs. Move was content-preserving:

- `2026-04-28_v5_phase0_diagnostic.md` — V5 phase-0 ML diagnostic (Apr 28)
- `OutdoorMLHandoff_2026-03-26.md` — OutdoorML Mar 26 handoff
- `OutdoorMLNextSteps_2026-03-27.md` — OutdoorML Mar 27 follow-up
- `OutdoorMLWorkingSettings.md` — OutdoorML Mar 26 working settings
- `PopulationPipelineProbeLoop.md` — probe-loop pipeline note (Apr)
- `code_review_project_terrain_20260429.md` — terrain code review
- `code_review_project_terrain_prompt.md` — terrain code-review prompt
- `code_review_terrain_query_object_mgmt_20260429.md` — terrain-query code review
- `GCP_Codex_Automation_Setup.md` — GCE setup for Codex automation
- `living_atlas_re_emit.md` — re-emit notes for visual atlas (superseded)
- `living_atlas_schema.md` — atlas describe-landblock v1 schema (frozen 2026-04-29)
- `howtoclearworldobjects.md` — clear-objects how-to

The two internal cross-links among archived files (`code_review_terrain_query_object_mgmt` → `code_review_project_terrain`) still resolve since both files moved together.

## Structure changes made

- Created `docs/archive/`
- Moved 12 stale-candidate `.md` files into it
- No other moves (top-level layout was already mostly fine; aggressive restructuring rejected per user instruction)
- No content edited; no cross-link rewrites needed (verified by grep)

## What I deliberately did NOT touch

- `physics-parity-method.md` — Wave 3.A agent editing concurrently
- `diagnostic-toolset-plan-2026-05-19.md` — same
- Other `*-method.md` files — all code-referenced via fixed relative paths from capture/validate scripts
- `images/` — heavily referenced from `README.md` + `capture_*.cjs` scripts via fixed relative paths
- `sample-dist/` — cited from `README.md` line 302 and `spin.md` as the emitted dist
- `prompts/` — kept as-is (low-traffic but self-contained set of historical agent prompts)
- Five demo-screenshot subdirs (`3d-port-screenshots-2026-05-10/`, `world-expand-step-1-screenshots-2026-05-14/`, `world-completeness-demo-2026-05-14/`, `visual-fidelity-eval-2026-05-13/`, `sky-experiment-2026-05-15/`, `screenshots/holtburger-1070-fixes-2026-05-16/`) — accompanying README context for their parent docs
- All `phase-*-renderer.md` and `phase-*-step-*-handoff.md` files — code-referenced (`emit-dynamic-site.md` source-of-truth links and code comments cite by `docs/<path>`)
- `gui_terminal_gap_analysis_2026-03-25.md`, `PopulationPipeline*`, `ComponentLinkedTraining.md` — root-level files reference them; left in place even though content reads stale

## Notes for the user

- The user asked for conservative cleanup so this leaves ~60 `.md` files at top level. They look like a lot but most are load-bearing, and reorganization into thematic subfolders (e.g. `methods/`, `phase-reports/`) would require updating dozens of code-site references (`grep -rn 'docs/' ... --include='*.cjs' --include='*.rs'` returns ~50+ refs to fixed paths).
- If you want a deeper reorg later: the safest next step is moving the `phase-2-*`, `phase-3-*`, `phase-4-*`, `phase-5*`, `phase-6-*`, `post-phase-6-*` cluster (~12 files) into `phase-reports/` and updating the ~40 inbound code/doc refs in one batch. The 8 `*-method.md` + `*-parity-method.md` files could go in `methods/` similarly but at the cost of updating every capture/validate `.cjs` script that cites them.
- `archive/` is content-preserving — anything you decide is still useful can come back out.
