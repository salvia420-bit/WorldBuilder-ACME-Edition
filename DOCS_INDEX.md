# Top-level docs index — triaged 2026-05-19

This is the index for top-level + immediate-subdir docs. For `docs/` see
`docs/INDEX.md`. For `external/holtburger/` see
`external/holtburger/DOCS_INDEX.md`.

Conservative triage pass. 6 stale-candidate `.md` files moved into a new
top-level `archive/` (separate from `docs/archive/`). No deletions. No
content edits. No code/script cross-link rewrites needed (every moved file
had zero inbound references from code, scripts, or live docs — verified by
grep).

## Live (load-bearing — cited from code or active root docs; DO NOT MOVE)

- `README.md` — primary repo readme. **LOCKED — separate README agent owns it.**
- `LICENSE.md` — license text. **SACRED — never touch.**
- `weenie_index.md` — cited from `WorldBuilder.Terminal/CommandEngine.WeenieIndex.cs:9` as a doc cross-ref ("see weenie_index.md") in production C# comment.
- `march25.md` — cited from `run_population_overnight.sh:45` (tarball-includes list).
- `UPSTREAM_SYNC_NOTES.md` — 470-line manual upstream-sync log; cited 3× from `spin.md` and 5× from `wireprompt.md` (Cluster A deferred work tracker).
- `spin.md` — Apr 30 "real map of Dereth" wave brief. References `UPSTREAM_SYNC_NOTES.md`, `wireprompt.md`, `docs/sample-dist/`.
- `wireprompt.md` — Apr 26→30 headless-parity wave brief. References `UPSTREAM_SYNC_NOTES.md`, `docs/agent_api_reference.md`, `docs/gui_terminal_gap_analysis_2026-03-25.md`.
- `wirerender.md` — May 02 render-gallery brief. Cited from `docs/agent_api_reference.md:2017` ("Companion brief: `wirerender.md`") + Terminal C# RenderGallery tags reference this wave by name.
- `reingest.md` — runbook activating `static_site_scene_quality.md` items 0–9. Live pair.
- `static_site_scene_quality.md` — Objs 0–25/52 action plan. Cited from `reingest.md`.
- `2026-04-05_interior_support_handoff.md` — interior placement handoff; cited from `docs/phase-6-buildings-and-interiors.md` (active phase doc + `WorldBuilder.Terminal/CommandEngine.cs:5367-5462` cross-ref).
- `2026-04-27_pipeline_theory_overview.md` — pipeline theory orientation doc; cited 2× from `docs/prompts/unified_placer_v5_calibration.md` ("agent must read…").

## Recent (last 30 days; left in place)

None at the top level. Recent docs all live in `docs/` (see `docs/INDEX.md`).

## Stale candidates (moved to `archive/` at repo root — content-preserving)

All had zero inbound references from code, scripts, or live docs. Moved via
`git mv`. Originally were one-off training/plan snapshots from April 2026.

- `march27plan.md` — Mar 27 planner-v2 winner snapshot; superseded by `mlplan.md` and v6/v7 atlas runs.
- `mlplan.md` — Apr 29 "30 GPU-hr push" ML plan; references v4/v6 checkpoints; one-off training plan.
- `v7prompt.md` — Apr 30 v8-training brief; one-off training session prompt.
- `textureplan.md` — Apr 30 texture parity plan; Item 1 (sprite roofs) DONE inline, Item 2 (terrain overlays) stale.
- `object_display_expansion.md` — May 03 object-display action plan; superseded by `static_site_scene_quality.md` (which subsumes 25/52 DBObj coverage).
- `2026-04-05_interior_support_precision_note.md` — small 1.4KB precision note observing `export-envcell-components` already exports per-cell statics; no follow-up actions tracked.

## Ambiguous

None. All top-level `.md` files were either clearly load-bearing (10) or
clearly archive-candidates (6).

## Immediate-subdir survey

No `.md` files were found in any immediate top-level subdir outside the
locked set (`docs/`, `external/`, `WorldBuilder.Terminal/`, `.git/`,
`.claude/`, `node_modules/`). Verified via `find -maxdepth 2`.

So `WorldBuilder.Tests/`, `WorldBuilder.Shared/`, `WorldBuilder.Browser/`,
`WorldBuilder.Desktop/`, `WorldBuilder.Linux/`, `WorldBuilder.Mac/`,
`WorldBuilder.Windows/`, `DatReaderWriter.Extensions/`,
`Chorizite.OpenGLSDLBackend/`, `NuGet/`, `RetailSmoke/` (n/a — doesn't
exist at top level), `playkits/`, `pipeline_data/`, `tests/`, `tools/`,
`scripts/`, `installer/`, `town_kits/`, `ace_world_release/`, `images/`
(n/a), `prompts/` (n/a — both inside `docs/`) all had no orphan top-level
`.md` files.

## Structure changes made

- Created `archive/` at repo root (separate from `docs/archive/`).
- Moved 6 stale-candidate `.md` files into it via `git mv`.
- No content edited.
- No cross-link rewrites required (verified by grep — moved files had zero inbound refs from non-archive locations before the move).

## What I deliberately did NOT touch

- `README.md` — separate README-update agent owns it.
- `LICENSE.md` — sacred.
- `docs/*` — already triaged by prior cleanup; see `docs/INDEX.md`. Additionally, Wave 3.F editing `docs/diagnostic-toolset-plan-2026-05-19.md` + `docs/physics-parity-method.md` concurrently.
- `external/holtburger/*` — separate agent + Wave 3.F territory.
- `WorldBuilder.Terminal/*` — Wave 3.F editing concurrently.
- `Cargo.toml` / `*.csproj` / `*.sln` / `*.slnx` / `Directory.Build.props` / `GitVersion.yml` — build configs.
- `.gitignore` / `.gitattributes` — repo configs.
- All 10 load-bearing root `.md` files listed under "Live" above — every one of them has at least one verified inbound reference from production code, a shell script, or an active doc.

## Notes for the user

- Top level had 18 `.md` files before (incl. README + LICENSE). After this pass: 12 files at top level (10 live + README + LICENSE), 6 in `archive/`.
- The "load-bearing chain" is tightly interlinked: `spin.md` → `wireprompt.md` → `UPSTREAM_SYNC_NOTES.md` → `reingest.md` → `static_site_scene_quality.md` → `weenie_index.md` → `2026-04-05_interior_support_handoff.md` → `wirerender.md`. Plus `march25.md` referenced from a shell script and `2026-04-27_pipeline_theory_overview.md` cited from `docs/prompts/`. Moving any of these would require updating multiple inbound references at runtime/script level.
- `archive/` is content-preserving — anything you decide is still useful can come back out with `git mv`.
- The 6 archived files all date from before the May renderer-port + visual-fidelity waves; they describe an older ML/training-driven pipeline state. Reading any of them today gives a snapshot of a different phase of the project.
