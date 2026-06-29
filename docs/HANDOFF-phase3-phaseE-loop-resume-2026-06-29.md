# HANDOFF — Phase 3 CTransition · Phase E workflow-loop RESUME (2026-06-29)

**Purpose:** resume the autonomous Phase E ultracode workflow loop (E1 ✅ → **E2 next** → E3) from a fresh
session if this one closes. Self-contained: branch/commit state, the loop mechanics + reusable workflow
template, E2/E3 scope, and the exact commands.

---

## 1. State of record

- **Branch:** `feat/phase3-phaseD-outdoor-terrain` (Phase E is stacking on it; rename later if you like).
- **Commits (local, NOT pushed):**
  - `69a782b8` — Phase D: faithful outdoor terrain collision + Option C off-center-building fix (default-ON).
  - `2f181a96` — Phase E1: faithful vertical-lip step-up (curbs/stairs/ledges), default-ON.
  - `336bd9e5` — docs: this resume handoff.
  - `7af9273b` — Phase E2: cross-portal collision (resolve portal-neighbour handles, depth-1, default-ON).
- **Working tree:** clean of our work (only pre-existing untracked junk: `crates_probe_anim_dist.rs`, old
  HANDOFF-*.md, `02000ADC.bin`, `examples/`, etc. — none ours).
- **`pkg/` wasm** rebuilt at E1b (17.9 MB) so default-ON (C/D/E1) is live for local serve.py.

### Phase ladder
| Phase | What | Status |
|---|---|---|
| C | indoor env-cell BSP + in-cell statics | ✅ (pre-existing, default-ON) |
| D | outdoor terrain (2-tri/cell) + Option C off-center-building fix | ✅ `69a782b8` |
| E1 | walkable step-up: vertical-lip climb (curbs/stairs/ledges) via `ON_WALKABLE` precondition | ✅ `2f181a96` |
| E2 | cross-portal cell transitions (portal-neighbour cells collision-tested, depth-1) | ✅ `7af9273b` (implemented directly in-session, not a workflow) |
| **E3** | **precision polish + live headless validation + ship wasm** | ⛔ **NEXT** |

### Task list (TaskCreate IDs in this session)
`#1` wait-D ✅ · `#2` assess-D ✅ · `#3` derive-E ✅ · `#4` E1 (vertical-lip) ✅ ·
`#5` E2 cross-portal ✅ (`7af9273b`) · `#6` **E3 polish+validate+ship — NEXT**.

---

## 2. How to RESUME

D, E1, and E2 are done + committed (`7af9273b` is HEAD). **E3 is next.** NOTE: the user moved away from
ultracode workflows for E2 — it was handled **directly in-session** (research agents + manual edits + drift
tests + commit). Confirm with the user whether E3 should be a workflow or handled directly too. To resume:

```
Resume Phase E at E3 (D/E1/E2 done+committed; HEAD 7af9273b on feat/phase3-phaseD-outdoor-terrain). FIRST send
explore agents to discord sql (gotchas) + acclient.txt + decomp/ACE/chorizite/holtburger before any E3 plan.
E3 scope: (1) precision polish — precise point_in_cell via the cell-membership BSP (CellMembership in scene.rs,
currently AABB at faithful_bridge.rs point_in_cell); per-static scale; outdoor water_type/depth through the
cell adapter; quaternion set_rotate/SLERP. (2) the E2 follow-up: iterative multi-hop portal flood + the
sphere-vs-portal intersection gate (acclient.c:348337) — E2 shipped depth-1 only. (3) fix the 2 stale
position_manager tests (sticky_flag_default_off_* / facade_flag_off_* assert default-OFF vs flipped consts).
(4) live headless A/B validation of C/D/E1/E2 (phase4demo harness). (5) rebuild + ship the wasm. Ask the user:
workflow or direct? capped-build, ground in acclient.c, ACE reference-only, checkpoint-commit, pause on
material failure.
```

A fresh session should first read this doc + the three PLAN docs (§6) to reload context.

---

## 3. The loop mechanics + reusable workflow template

Each phase = one **ultracode `Workflow`** with this proven shape (see the saved scripts in §6 — clone one):

1. **Recon+Baseline** (parallel, READ-ONLY): a GATING recon (`Explore`) grounds the faithful mechanism in
   `acclient.c` (cross-check ACE + holtburger current) and returns a structured verdict the impl consumes;
   a baseline (`Explore`) confirms the pre-change build is green. ⚠ **Watch:** the E1b recon once returned a
   placeholder stub (`"Test"`/`"file1"`) — if the recon verdict looks degenerate, the impl agents fall back
   to the PLAN doc (which carries the real mechanism), but scrutinize the result extra hard.
2. **Implement** (SEQUENTIAL, shared working tree, `general-purpose`): each WS compile-gates (`cargo check`)
   before the next builds on it. Sequential because the laptop is an 8 GB OOM jail — **parallel cargo builds
   share `target/` and OOM/clobber**. Pass prior-WS summaries into later prompts.
3. **Build gate** (`general-purpose`): full `transition::` + `drift` suites + `core` check + `wasm-pack`;
   may fix trivial compile breaks; reports the headline A/B numbers + regression status.
4. **Verify** (parallel, READ-ONLY `Explore`): adversarial checks — **faithfulness-to-`acclient.c` is the lead
   check** — plus the behavioral A/B, regression/no-jitter, and completeness-vs-plan.

**Discipline baked into every agent prompt** (carry verbatim):
- `capped-build` + full toolchain paths, **one build at a time**; `kill $(pgrep -f rust-analyzer)` to reclaim RAM;
  never bare `cargo --workspace` / bare `wasm-pack` / buildbox.
- **acclient.c WINS**; ACE (`/home/wbterminal/ace-server/Source/ACE.Server/Physics`) is the readable Rosetta
  stone, **reference-only — no server/DB/gameplay data into the client**; Chorizite ACBindings offsets corroborate.
- **Preserve retail quirks; do NOT "fix" them** (Dekaru: 100% client fidelity). Default-ON + `?flag=off` escape.
- **No git commits inside the workflow.** The orchestrator (main loop) **checkpoint-commits each phase locally**
  after assessing (this is an explicitly authorized exception for the autonomous multi-phase chain — keeps phases
  reviewable as separate diffs; local only, no push).
- **Pause + ask the user** if a phase fails materially or over-implements non-minimally (the user is available
  for decisions). Otherwise proceed autonomously and report at each phase boundary.

**Build/test commands:**
```bash
REPO=/home/wbterminal/WorldBuilder-ACME-Edition ; cd $REPO/external/holtburger
PATH="$HOME/.cargo/bin:$PATH" capped-build ~/.cargo/bin/cargo test  -p holtburger-dat   --lib transition::          # >=256
PATH="$HOME/.cargo/bin:$PATH" capped-build ~/.cargo/bin/cargo test  -p holtburger-world --lib spatial::faithful_bridge::drift
PATH="$HOME/.cargo/bin:$PATH" capped-build ~/.cargo/bin/cargo check -p holtburger-core
PATH="$HOME/.cargo/bin:$PATH" capped-build wasm-pack build --target web --out-dir pkg --dev    # ~22s; pkg/ gitignored
```
Known: **2 pre-existing `position_manager` test failures** (`sticky_flag_default_off_*`, `facade_flag_off_*`) are
stale default-OFF assertions vs flipped consts — unrelated to C/D/E; **fix in E3**.

---

## 4. E2 — cross-portal / indoor↔outdoor cell transitions (NEXT)

**Goal:** faithful collision ACROSS cell boundaries — portal cells, indoor↔outdoor transitions, and AC's
non-Euclidean dungeon overlap. Today the faithful driver collision-tests only the **primary/current cell**.

**Known seams / leads (verify against acclient.c first):**
- `faithful_bridge.rs:153` VERIFY: `find_transit_cells` floods portal neighbours with **NULL handles**; only the
  primary cell is collision-tested. Cross-portal sweeps need the **live cell graph** — and a `'static` cell can't
  hold the scene ref (the core architectural problem to solve).
- Decomp: `CObjCell::find_cell_list` portal-neighbor flooding; `CEnvCell` portal/`visible_cells`; how retail walks
  the cell graph across a portal during a sweep. `add_all_outside_cells` (Phase D) is the outdoor analogue.
- Discord (trevis): "feels so hacky without proper physics / cell transitions"; non-Euclidean dungeons overlap
  spatially but must stay separate physics spaces; gmriggs z-fight "bump dungeon-only landblock down by 50".
- ACE `ObjCell.find_cell_list` (`:335`) EnvCell visibility filtering (removes cells not in current room's
  `VisibleCells`) — the indoor cross-room analogue.

**Process (per user):** send explore agents to **discord sql (gotchas) + acclient.txt** + decomp/ACE/chorizite/
holtburger **BEFORE** writing the E2 plan doc. Then plan → workflow (the §3 template). Default-ON + `?flag=off`.

---

## 5. E3 — precision polish + live validation + ship (after E2)

- **Carried VERIFY items** (Phase C/D handoff §5 + E1): precise `point_in_cell` via the cell-membership BSP
  (currently AABB footprint); per-static **scale** (statics treated unscaled); **quaternion `set_rotate`/SLERP**
  for orientation-changing sweeps; outdoor **water_type/depth** through the cell adapter (SpatialScene carries no
  water today → terrain water gate is inert); **E1 follow-up:** outdoor *static-object* vertical-lip step-up
  (E1 indoor-gated it to protect the Phase-D cliff-stop).
- **Fix the 2 stale `position_manager` tests** (§3) — align the assertions with the flipped consts.
- **Live headless A/B validation of C/D/E** (collision is CPU-side → no GPU needed): Playwright (raw
  `chrome --headless` botches the WS bridge upgrade). Local stack: serve.py `:8765`, `holtburger-wsbridge :8080`,
  ACE UDP `:9000/:9001`, MariaDB. Safe account **`phase4demo`/`phase4demo`** (NOT the owner's `tailnet1`). Harness
  `harness/lib/boot.mjs#launchAndEnter({query,timeoutMs})`; bot URL flags `?nullRender=1&renderOnDemand=1&netDrainHz=30&nosw=1`.
  Confirm in-world: outdoor walk grounded, indoor/outdoor curbs climb, off-center building stops, 0 errors.
  Optional 1070 real-GPU eye-test per `MEMORY.md` (render fidelity only; never `browser.close()` the person's session).
- **Ship:** rebuild + ship the wasm so default-ON (C/D/E) is live per the deploy mechanism (`pkg/` is gitignored).

---

## 6. Artifact index

**Plan docs (read these to reload context):**
- `docs/PLAN-phase3-phaseD-outdoor-terrain-optionC-2026-06-28.md`
- `docs/PLAN-phase3-phaseE1-stepup-climbing-2026-06-29.md`
- `docs/PLAN-phase3-phaseE1b-vertical-lip-stepup-2026-06-29.md`
- (this) `docs/HANDOFF-phase3-phaseE-loop-resume-2026-06-29.md`

**Reusable workflow scripts** (clone via `Workflow({scriptPath, ...})` or as a template for E2/E3):
- D: `.../4901c4f6-.../workflows/scripts/phase-d-outdoor-terrain-wf_cc681426-041.js`
- E1: `.../workflows/scripts/phase-e1-stepup-climbing-wf_c00c125f-e26.js`
- E1b: `.../workflows/scripts/phase-e1b-vertical-lip-stepup-wf_ad714425-02c.js`
  (base dir: `/home/wbterminal/.claude/projects/-home-wbterminal-WorldBuilder-ACME-Edition/4901c4f6-ede5-46ee-93cb-0f6053fe9e50/workflows/scripts/`)

**Completed workflow results (full JSON):** `/tmp/claude-1000/-home-wbterminal/4901c4f6-.../tasks/{wgxi2gnkm,wbc0bi6dq,wfpvsw49w}.output`
(D, E1, E1b). Mechanism deep-dive: `.../tasks/add3f415f75bda49f.output` (the vertical-lip lift spec).

**Key source seams:** driver `external/holtburger/crates/holtburger-dat/src/transition/`; bridge
`external/holtburger/crates/holtburger-world/src/spatial/{faithful_bridge.rs,scene.rs,transition.rs}`; flags
`external/holtburger/crates/holtburger-core/src/client/movement/{system.rs,handle.rs}` +
`apps/holtburger-web/src/lib.rs` + `apps/holtburger-web/docs/url-flags.md`.

**Reference oracles:** decomp `/home/wbterminal/ac-headers/acclient.{c,h,txt}`; map
`$REPO/external/chorizite/Chorizite/Chorizite.Core/acclient.map`; Chorizite ACBindings
`$REPO/external/chorizite/ACBindings/Generated`; ACE `/home/wbterminal/ace-server/Source/ACE.Server/Physics`
(reference-only); Discord `/mnt/wbterminal2/ac-discord-archive/_indextest/ac.db` (gold channels:
worldbuilder, decalinfo, chorizite, metaf, sourcecode, tool-dev, alt-clients).
