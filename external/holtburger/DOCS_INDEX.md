# external/holtburger/ Docs Index — triaged 2026-05-19

Conservative triage pass across `external/holtburger/`. **No moves made.** Every `.md` file under this hard-forked tree is either (a) <17 days old (vendored 2026-05-03; nothing older exists), (b) code-referenced via fixed relative paths from `*.rs` / `*.js` / `*.cjs` / `*.html` / `Cargo.toml`, or (c) inside the Wave-3.F concurrency-locked `apps/holtburger-web/` subtree. Buckets below mirror `docs/INDEX.md` (parent-repo).

## Vendoring / provenance (fork-tracking — do NOT touch lightly)

- `VENDORED.md` — manifest of the hard-fork (upstream `merklejerk/holtburger@629695a2`, vendored 2026-05-03). **Load-bearing for upstream re-sync workflow.** Linked from `apps/holtburger-web/CHORIZITE_PORTING_PLAN.md` §"upstream sync"; the canonical `UPSTREAM_SYNC_NOTES.md` referenced in `CHORIZITE_PORTING_PLAN.md` §upstream-sync does NOT currently exist in-tree (memory mentions it; create-on-need).
- `LICENSE.md` — AGPL v3, untouched per instructions (orchestrator-owned). VENDORED.md cross-links to it.
- `README.md` — untouched per instructions (separate README-update agent owns it).

## Live methods + active plans (cite from code; do NOT move)

All under `docs/`. Every entry has at least one inbound code citation grepped at triage time.

- `docs/sky-i-probe-2026-05-11.md` — sky-render bug probe; cited from `crates/holtburger-world/src/sky.rs:222` + `apps/holtburger-web/src/lib.rs:7407`. **Wave 3.F lib.rs reference — file safe, just don't edit lib.rs.**
- `docs/sky-particles-p4-port-spec.md` — JS particle runtime port spec; cited from `apps/holtburger-web/src/lib.rs:19116` (Wave 3.F-adjacent).
- `docs/sky-particles-p5-integration-plan.md` — sky-dome wire-in plan for the above; cited from `docs/ambient-sounds-chain-2026-05-12.md` §refs (md-to-md).
- `docs/ambient-sounds-chain-2026-05-12.md` — `CRegionDesc → SoundTable → Wave` chain spec; cited from `crates/holtburger-protocol/src/messages/effects/types.rs:100` + `apps/holtburger-web/index.html` (multiple lines) + `apps/holtburger-web/src/lib.rs` (multiple sites).
- `docs/holtburg-coverage-survey-2026-05-12.md` — retail Holtburg coverage probe; cited from `crates/holtburger-protocol/src/messages/effects/types.rs:113`.
- `docs/quality-presets.md` — quality preset matrix; cited from `apps/holtburger-web/scene3d/quality.js:8,19` + `apps/holtburger-web/ui/graphics_settings.js:14`.
- `docs/fps-perf-plan-2026-05-18.md` — 8-wave FPS audit execution plan (70 KB); cited from `apps/holtburger-web/scene3d/cells.js:111`.
- `docs/fps-perf-followon-2026-05-18.md` — 5 deferred follow-ons after the plan above; cited from `apps/holtburger-web/scene3d/statics.js:699`.
- `docs/motion-table-acclient-audit-2026-05-19.md` — 436/436 retail motion tables vs `acclient.c` audit; cited from `crates/holtburger-dat/tests/motion_table_inspect.rs:5`. Mentioned in MEMORY.md.
- `docs/swing-classification-spec-2026-05-19.md` — implementation-ready swing-pose classifier spec; cited from `apps/holtburger-web/validate_motion_pose.cjs:10,928` + `apps/holtburger-web/src/lib.rs:3981,14271` + `crates/holtburger-dat/tests/motion_table_monsters.rs:3`. Mentioned in MEMORY.md.

## Recent shipping records + handoffs (last 30 days; all referenced)

- `HANDOFF.md` — Sky-I correction post-mortem (2026-05-11/13); cited from `apps/holtburger-web/capture_3d_movement_e2e.cjs:128,724`. Mentioned by 2 memory entries.
- `docs/handoff-2026-05-17.md` — Combat Phases A–K.1 handoff; predecessor links to ui-shell-plugin-architecture-spec / combat-melee-cross-reference / ui-conformance-audit (all md-to-md). No direct code refs found, but it's a current handoff and self-consistent with the active spec set.
- `docs/ui-shell-plugin-architecture-spec-2026-05-17.md` — plugin-bar architectural spec; cited from `docs/handoff-2026-05-17.md` and memory `project_holtburger_ui_shell_bar_done_2026-05-17`.
- `docs/combat-melee-cross-reference-2026-05-17.md` — Phase A three-source doc; cited from `docs/handoff-2026-05-17.md`.
- `docs/ui-conformance-audit-2026-05-17.md` — retail-vs-shipped UI audit (asheron.fandom.com); cited from `docs/handoff-2026-05-17.md` + 3 memory entries.

## Architecture references (per-crate; cite their crate from comments and parent ARCHITECTURE.md)

- `ARCHITECTURE.md` (top-level) — workspace overview; links out to all 8 crate-level ARCHITECTURE.mds.
- `crates/holtburger-common/ARCHITECTURE.md` — bedrock crate.
- `crates/holtburger-content/ARCHITECTURE.md` — content seam.
- `crates/holtburger-core/ARCHITECTURE.md` — orchestration brain.
- `crates/holtburger-dat/ARCHITECTURE.md` — DAT library.
- `crates/holtburger-protocol/ARCHITECTURE.md` — wire language.
- `crates/holtburger-protocol/FIXTURES.md` — fixture-generation SOP; cited from `.github/workflows/hygiene-assessment.md:56`.
- `crates/holtburger-session/ARCHITECTURE.md` — transport.
- `crates/holtburger-world/ARCHITECTURE.md` — world authority.
- `crates/holtburger-scripting/SCRIPTING_GUIDE.md` — script-author quickstart; linked from top-level `README.md`.
- `apps/holtburger-cli/ARCHITECTURE.md` — TUI frontend.
- `apps/holtburger-wsbridge/ARCHITECTURE.md` — Phase 1 WS bridge; cited from `apps/holtburger-wsbridge/src/{lib,main,frame,bin/wsshim}.rs`.

## CI / operational

- `.github/workflows/hygiene-assessment.md` — daily CI agent prompt for repo hygiene. References `FIXTURES.md`. Embedded in the workflow YAML toolchain — DO NOT relocate (workflow file structure).

## Asset / data READMEs (referenced from generators or sibling code)

- `dats/README.md` — HBA bundle generation recipe; **load-bearing**: cited as `readme` in `Cargo.toml:95` workspace metadata. Also referenced from `apps/holtburger-web/smoke_test.cjs:2211`.
- `apps/holtburger-web/data/chorizite/README.md` — Chorizite oracle JSON dump manifest; describes data consumed by `plugins/world-objects/`, `plugins/combat-bar/` + protocol parity tests.
- `apps/holtburger-web/scene3d/assets/detail/README.md` — Phase 0.2 detail tile manifest. Sibling `generate.py` regenerates the tiles.
- `apps/holtburger-web/scene3d/assets/terrain_detail/README.md` — Phase 1.2 normal-map manifest. Sibling `generate.py`.
- `scripts/README.md` — one-line "Put JS scripts in here.".
- `scripts/src/mage/README.md` — mage TUI script package guide.
- `scripts/src/mage/initial-plan.md` — original mage script design doc.
- `scripts/visual-regression/README.md` — Phase X.2 visual-regression infrastructure README; cited from `apps/holtburger-web/capture-all.cjs` headers (sibling scripts cite this README).

## Apps/holtburger-web survey (Wave 3.F territory — NO TOUCH)

All listed but NOT inspected for moves due to active Wave 3.F editing. Categorized by content type only.

### Working specs (active)

- `apps/holtburger-web/CHORIZITE_PORTING_PLAN.md` — 76 KB. Rev 3 (2026-05-19). Cited from `validate_entity_classification.cjs:37`, `index.html:730`, `plugins/api.js:61`, `plugins/world-objects/world_object_manager.js:96`, `plugins/world-objects/vendor.js:11`. **Wave 3.F-adjacent — high inbound link count; do NOT move.**
- `apps/holtburger-web/INTERACTING_LAYERS_ANALYSIS.md` — working doc on visual-effect time sources, camera cycle, etc.; cited from `scene3d/sun_direction.js:31` + `scene3d/index.js:869`.
- `apps/holtburger-web/OPTICAL_EFFECTS_HANDOFF.md` — atmosphere/optical effects survey; cited from `scene3d/index.js:1544` + `scene3d/aurora.js:3`.

### App README

- `apps/holtburger-web/README.md` — cited from internal `index.html:605`.

### Plugin / data dirs

- `apps/holtburger-web/plugins/world-objects/README.md` — recent (2026-05-19); cross-links to `CHORIZITE_PORTING_PLAN.md` §3, §12, vendored chorizite manifest, parent `docs/entity-completeness-method.md`.

### Generated / vendored (mechanical)

- `apps/holtburger-web/pkg/README.md` — wasm-pack output.
- `apps/holtburger-web/pkg-node/README.md` — wasm-pack node target output.
- `apps/holtburger-web/pkg-nodejs/README.md` — wasm-pack node target output.
- `apps/holtburger-web/pkg-web/README.md` — wasm-pack web target output.
- `apps/holtburger-web/apps/holtburger-web/pkg/README.md` — nested duplicate from a recursive `wasm-pack` invocation; **mechanically regenerated**, harmless but noisy. Surfaces from the wasm-pack command being run from a non-root cwd at some point; ignore for now.
- `apps/holtburger-web/vendor/takram-three-clouds/README.md` — third-party (40 KB).
- `apps/holtburger-web/vendor/takram-three-clouds/CHANGELOG.md` — third-party.
- `apps/holtburger-web/vendor/takram-three-clouds/LICENSE.md` — third-party MIT/BSD-3-Clause/Zlib aggregate.

## Build artifacts (not surveyed; pure build output)

- `target/doc/static.files/SourceSerif4-LICENSE-a2cfd9d5.md` — rustdoc asset; ignore.

## Structure changes made

**None.** Zero moves, zero deletions, zero edits to existing files.

Rationale: every non-vendor / non-target `.md` file in this tree is either (a) directly cited from code (grep-verified), (b) <17 days old (the entire tree was vendored 2026-05-03 — there is no >30-day-old content here), or (c) Wave-3.F-locked. The conservative bar for archiving (>60d + zero inbound refs) is met by zero files. Creating an `archive/` subdir would be premature; defer until a sub-doc demonstrably ages out.

## What I deliberately did NOT touch (and why)

- **Wave 3.F-locked files** per orchestrator brief:
  - `apps/holtburger-web/src/lib.rs`
  - `apps/holtburger-web/index.html`
  - `apps/holtburger-web/capture_physics_replay.cjs`
  - `apps/holtburger-web/validate_physics_replay.cjs`
  - everything under `WorldBuilder.Terminal/**` (parent-repo, out-of-scope here anyway)
  - `docs/diagnostic-toolset-plan-2026-05-19.md` (parent-repo)
  - `docs/physics-parity-method.md` (parent-repo)
- **All of `apps/holtburger-web/`** for moves (surveyed but not relocated) — Wave 3.F may touch any sibling file there; safer to leave the whole subtree alone for this pass.
- **`external/holtburger/README.md`** — separate README-update agent owns it.
- **`external/holtburger/LICENSE.md`** — user instruction.
- **No git ops, no deletions** — both forbidden by the orchestrator brief.

## Surprises / orphans / ghosts

1. **`UPSTREAM_SYNC_NOTES.md` does NOT exist in-tree** despite being mentioned in `apps/holtburger-web/CHORIZITE_PORTING_PLAN.md:516` ("This is an upstream-tracked subtree per memory mentions of `UPSTREAM_SYNC_NOTES.md`"). Memory MEMORY.md has no direct entry naming it either; the live source of upstream-sync truth is **`VENDORED.md`** in this tree. The CHORIZITE_PORTING_PLAN reference is aspirational. **Recommendation:** when a re-sync from upstream happens, decide whether to write `UPSTREAM_SYNC_NOTES.md` as a sibling to `VENDORED.md`, or just append a "Sync history" section to `VENDORED.md` directly. Left alone for now.
2. **Nested `apps/holtburger-web/apps/holtburger-web/pkg/`** — clearly a stray `wasm-pack` invocation from a non-root cwd at some point created a duplicate `pkg/` tree at depth 4. Mechanical only; the inner `README.md` is identical wasm-pack boilerplate. Worth a separate cleanup PR (delete the duplicate dir + adjust the build invocation that creates it) but out-of-scope for this docs pass.
3. **Multiple parallel `pkg-*` dirs** — `pkg/`, `pkg-node/`, `pkg-nodejs/`, `pkg-web/` all exist with identical README.md boilerplate from wasm-pack. Probably reflects the multi-target wasm build (node + web). All mechanical; leave alone.
4. **`hygiene-assessment.md` lives at `.github/workflows/`** — odd location for a markdown file (next to `.yml`). It's the prompt body for the daily CI hygiene agent; the YAML is implied or sits beside it. Untouched.
5. **`docs/handoff-2026-05-17.md` has no direct code refs** — it's a meta-handoff that points at three spec docs, all of which ARE code-referenced. Treated as live recent handoff, not stale.
6. **`fps-perf-plan-2026-05-18.md` is 70 KB** — the biggest single doc in the tree. Cited from `scene3d/cells.js:111`. Heavy but live.
7. **No "wave-status-pending.md" or "WAVE*_DISPATCH_PENDING.patch" files** present at triage time, so no inter-agent splice coordination markers to preserve.

## Notes for the user

- This tree is dense with load-bearing docs because (a) it was vendored only 16 days ago and (b) the Phase 7+ / combat / FPS work has been generating dated specs in `docs/` at a steady cadence. Nothing here has aged into archive territory yet.
- The next conservative cleanup pass on this tree probably won't be useful until ~July 2026 (~2 months from now), once the dated `2026-05-*` specs have either been folded into permanent reference docs or aged into archive-candidate.
- If you want a deeper reorg before then: the safest move would be **renaming** `apps/holtburger-web/INTERACTING_LAYERS_ANALYSIS.md` + `OPTICAL_EFFECTS_HANDOFF.md` to lowercase-with-dashes-and-dates so they match the `docs/`-folder convention (e.g. `interacting-layers-analysis-2026-05-18.md`). That requires Wave 3.F to land first + updating 2 inbound code refs.
