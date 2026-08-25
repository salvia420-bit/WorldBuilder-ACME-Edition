# HANDOFF — Phase 3 CTransition · Phase E workflow-loop RESUME (2026-06-29)

**Purpose:** resume Phase E from a fresh session. D/E1/E2 done; **E3 in progress** (E3.1/E3.2/E3.4 done,
**E3.3 next**). E3 is being done **DIRECTLY in-session, not via workflows** (the user's call). Self-contained:
commit state, the per-sub-item E3 plan (§5 — the meat for resuming), build commands, and the reusable workflow
template (§3, only if you switch back to workflows).

---

## 1. State of record

- **Branch:** `feat/phase3-phaseD-outdoor-terrain` (Phase E is stacking on it; rename later if you like).
- **Commits (local, NOT pushed) — HEAD = `2ccaf9ca`:**
  - `69a782b8` — Phase D: faithful outdoor terrain collision + Option C off-center-building fix (default-ON).
  - `2f181a96` — Phase E1: faithful vertical-lip step-up (curbs/stairs/ledges), default-ON.
  - `336bd9e5` / `79a29a93` — docs: this resume handoff (+ E2-done update).
  - `7af9273b` — Phase E2: cross-portal collision (resolve portal-neighbour handles, depth-1, default-ON).
  - `3a63079f` — Phase E3.1: fix 2 stale `position_manager` tests (consts intentionally ON per git `a7cfb75e`).
  - `6705f522` — Phase E3.4: per-static scale (static sweep uses the static's own scale, not the mover's).
  - `2ccaf9ca` — Phase E3.2: precise `point_in_cell` via the cell-membership BSP (over the AABB).
- **Working tree:** CLEAN (all the above committed; only pre-existing untracked junk remains). **E3.3/E3.5/E3.6
  NOT started** — resume from a clean tree at HEAD `2ccaf9ca`.
- **`pkg/` wasm** rebuilt at E3.4 (17.9 MB). Rebuild again after E3.3+ before any live test / ship.

### Phase ladder
| Phase | What | Status |
|---|---|---|
| C | indoor env-cell BSP + in-cell statics | ✅ (pre-existing, default-ON) |
| D | outdoor terrain (2-tri/cell) + Option C off-center-building fix | ✅ `69a782b8` |
| E1 | walkable step-up: vertical-lip climb (curbs/stairs/ledges) via `ON_WALKABLE` precondition | ✅ `2f181a96` |
| E2 | cross-portal cell transitions (portal-neighbour cells collision-tested, depth-1) | ✅ `7af9273b` (direct in-session) |
| E3 | precision polish + live validation + ship (FULL scope per user; DIRECT, not a workflow) | 🔄 **3/6 done** |
| · E3.1 | fix the 2 stale `position_manager` tests | ✅ `3a63079f` |
| · E3.2 | precise `point_in_cell` via cell-membership BSP | ✅ `2ccaf9ca` |
| · E3.4 | per-static scale | ✅ `6705f522` |
| · **E3.3** | **cross-portal MULTI-HOP + sphere-vs-portal gate** (E2 shipped depth-1) | ⛔ **NEXT** — design ready, §5 |
| · E3.5 | quaternion `Frame` + per-step SLERP | ⏳ HIGH-RISK; §5 |
| · E3.6 | water type/depth (needs the WS8 data feed) | ⏳ §5 |
| then | rebuild wasm → off-screen 1070 live A/B of C/D/E → ship | ⏳ after code lands |

### Task list (TaskCreate IDs in this session)
`#1`–`#5` ✅ (wait-D, assess-D, derive-E, E1, E2). `#6` E3 — IN PROGRESS: E3.1/E3.2/E3.4 ✅; **E3.3 next**,
then E3.5 (SLERP), E3.6 (water), then live 1070 validation + ship.

---

## 2. How to RESUME

HEAD = `2ccaf9ca` on `feat/phase3-phaseD-outdoor-terrain`; tree CLEAN. E3 is DIRECT in-session (user's call),
full scope; **E3.1/E3.2/E3.4 DONE+committed**; resume at **E3.3**. The discord-gotchas + acclient.txt +
decomp/ACE/chorizite/holtburger research the user wanted is DONE for ALL of E3 (6 streams, digested into §5) —
no re-research needed; implement per §5. To resume, paste:

    Continue Phase E3 directly in-session from HEAD 2ccaf9ca (E3.1/E3.2/E3.4 done; tree clean). Implement E3.3
    (cross-portal multi-hop + sphere-vs-portal gate) per HANDOFF §5, then E3.5 (SLERP — HIGH-RISK, confirm scope
    first), then E3.6 (water — needs the WS8 data feed). capped-build, ground in acclient.c, ACE reference-only,
    keep drift (27) + transition:: (256) green, checkpoint-commit each sub-item. After the code lands: rebuild
    wasm + off-screen 1070 live A/B of C/D/E (account `<test-account>`; 1070 had full GPU headroom but a person's
    Roblox is running → off-screen only, never browser.close the live session), then ship.

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
Note: the 2 `position_manager` failures (stale default-OFF assertions vs the intentionally-ON consts — git
`a7cfb75e` "enable full unified pipeline") were **FIXED in E3.1** (`3a63079f`); `position_manager` is now 17/17.
Current suites: drift **27/27**, `transition::` **256**, core clean, wasm builds.

---

## 4. E2 (DONE `7af9273b`) — design reference

**Shipped:** depth-1 cross-portal collision (portal-neighbour cells resolved + collision-tested). E3.3 (§5) takes
it multi-hop + gated. Original design notes kept below for reference.

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

## 5. E3 — per-sub-item state + plans (THE RESUME MEAT)

Research is DONE for all of E3 (6 explore streams: decomp×2, ACE, holtburger-seams, headers+Chorizite, Discord —
digested below). Order = low-risk first. Each ✅ item is committed; each ⏳ item has its faithful mechanism +
exact seams below. Ground in `acclient.c`; ACE reference-only; capped-build; keep drift 27 + transition:: 256 green.

### ✅ E3.1 — stale `position_manager` tests (`3a63079f`)
git `a7cfb75e` ("enable full unified pipeline (all movement consts on)") flipped `USE_POSITION_MANAGER_QUEUE` /
`USE_STICKY_MANAGER` to true INTENTIONALLY → the consts are correct; the tests' default-OFF asserts + "OFF
(default)" comments were stale. Removed the asserts, renamed the lanes, refreshed comments. `position_manager` 17/17.

### ✅ E3.2 — precise `point_in_cell` via membership BSP (`2ccaf9ca`)
Added `SpatialScene::cell_membership(id)` accessor + a `membership: Option<CellMembership>` field on `SceneObjCell`
(populated in `build_cell_inner`). `point_in_cell` now rebases world→cell-local (`CellMembership::world_to_local`)
and walks the cell_bsp via the already-ported `BspNode::point_inside_cell` (= `BSPNODE::point_inside_cell_bsp`,
acclient.c:362944), AABB fallback when no membership. Test `point_in_cell_uses_membership_bsp_over_aabb`.

### ✅ E3.4 — per-static scale (`6705f522`)
`find_obj_collisions` used the MOVER's scale to cache the sphere into each static's frame; retail uses the PART's
`gfxobj_scale.z` (acclient.c:314669). Added `CellPhysicsBsp.scale` (default 1.0), switched the static pass to
`st.scale`. Proof test (scale-2 static stops the mover ~2× farther). wasm static sites carry a TODO to plumb the
real scenery placement scale (the feed doesn't extract it yet).

### ⛔ E3.3 — cross-portal MULTI-HOP + sphere-vs-portal gate  ← **DO THIS FIRST**
E2 floods portal neighbours **depth-1, ungated** (`SceneObjCell::find_transit_cells` adds every resolved
`resolved_neighbours` handle). Retail floods MULTI-HOP, **gated** by `CCellStruct::sphere_intersects_cell`
(acclient.c:348337/355502 → `BSPNODE::sphere_intersects_cell_bsp` 362980, radius+0.01 pad), and `find_cell_list`'s
loop re-reads `num_cells` so it visits added neighbours → self-terminating multi-hop (the gate is the spatial bound
that prevents the cascade gmriggs/trevis warned about; `CellArray::add_cell` dedups by id).
**The gate primitive is already ported:** `BspNode::sphere_intersects_cell(&center_local, radius) -> CellBound`
(physics.rs:115). **Plan (contained in `faithful_bridge.rs`):**
1. Carry each neighbour's membership for the gate: change `resolved_neighbours: Vec<(u32, ObjCellHandle)>`
   (faithful_bridge.rs:152) → `Vec<(u32, ObjCellHandle, Option<CellMembership>)>` (store `scene.cell_membership(nb)`).
2. GATE in `find_transit_cells` (:319): for each neighbour, transform each WORLD sphere into the neighbour frame
   (`membership.world_to_local(sphere.center)`) and `add_cell` only if `tree.sphere_intersects_cell(..) != Outside`
   (membership `None` ⇒ add ungated, as today). The spheres are in `find_transit_cells`'s `spheres` arg.
3. MULTI-HOP: change `build_cell_inner(cell_id, resolve_neighbours: bool)` (:452) → a hop count
   (`MAX_PORTAL_HOPS` const, ~2–3); resolve neighbours with `hops-1` (the `false` at :477 → `hops>0`), so neighbours
   carry their OWN resolved_neighbours and the `find_cell_list` loop floods multi-hop (gated → bounded; exponential
   build is tiny at depth 2–3, OR add a visited-set for linear). `build_outdoor_cell` literal (:753) stays empty.
4. Test: extend the cross-portal A/B — a sphere spanning TWO portals collides in the 2nd-hop cell; a neighbour the
   sphere does NOT reach is gated out (not collision-tested).
Regression guard: drift 27 (incl. `cross_portal_neighbour_wall_stops_mover`). DON'T break E2's depth-1 case.

### ⏳ E3.5 — quaternion `Frame` + per-step SLERP  (HIGH RISK — confirm scope first)
holtburger `Frame` (frame_transform.rs:49) is `fl2gv: [f32;9]` + `origin` — **no quaternion**; only `set_heading`
(pure yaw). Retail `Frame` (acclient.txt) = `qw/qx/qy/qz @0–15` + cached 3×3 `@16–51` + origin `@52–63`. Per-step
rotation = `Frame::interpolate_rotation` (acclient.c:357258, **true SLERP** with linear fallback when
`1−cosom ≤ 0.0002`; ACE uses `Quaternion.Lerp` — **decomp wins**) applied at `t=(step+1)/num_steps` in the
transition step loop (the `CalcNumSteps`/step loop in the driver), UNLESS `FreeRotate`. **Why it's risky:** adds a
quaternion to `Frame` (touches every Frame construction + `cache_localspace_sphere`'s capsule assumption) and the
heavily-tested step loop. **Why it may not be needed yet:** the player capsule is UPRIGHT → identity frame is
already faithful; this only matters for orientation-changing sweeps (rare for a player). **Recommendation:** confirm
with the user whether any mover actually needs it before the Frame surgery; if yes, gate behind a flag + test an
orientation-changing sweep; if no, document as VERIFY and move on.

### ⏳ E3.6 — water type/depth  (needs the WS8 data feed)
Mechanism: `CObjCell::get_water_depth` (acclient.c:347233; ENTIRELY=0.9, PARTIALLY interpolated 0.1–0.45) is
**ADDED to the plane eval** in `OBJECTINFO::validate_walkable` (acclient.c:314161) to gate walkability; an
ENTIRELY-water block (`get_block_water_type`) returns Collided for non-viewer/non-missile (ACE LandCell.cs:55).
WaterType enum 0/1/2; cell water is corner-based (**all-4-corners-deep = unwalkable**, Discord paradox) and depth
comes from **water NODES** (Discord paradox); **swimming is unimplemented** (out of scope). holtburger today:
`SceneObjCell::water_type` returns `NotWater`, `get_water_depth` returns 0 → the water gate (already wired in the
terrain path, `find_terrain_collisions`, and `validate_walkable` which already TAKES `water_depth`) is INERT.
**Plan:** (1) compute + store per-cell/landblock water type+depth in `SpatialScene` (port `CalcWater`,
LandblockStruct.cs:145 — terrain water bits `terrain>>2 & 0x1F`). (2) wasm feed (lib.rs) populates it on landblock
load. (3) `SceneObjCell::{water_type,get_block_water_type,get_water_depth}` return the real values. (4) confirm
`validate_walkable` adds depth to the plane eval; gate ENTIRELY-water for non-viewer. Test deep/partial cells.

### then — rebuild wasm + 1070 live validation (AFTER the code lands) + ship
- `capped-build wasm-pack build --target web --out-dir pkg --dev` (pkg/ gitignored).
- **Off-screen 1070 live A/B of C/D/E** (1070 pinged this session: **0% GPU, 183 MiB used — full headroom**, but
  `RobloxPlayerBeta.exe` is running → MODE2i off-screen ONLY; kill test chrome by `--user-data-dir` match, NEVER
  `browser.close()` / `taskkill /IM chrome.exe` the person's session). Account **`<test-account>`/`<test-account>`** (NOT
  `<account>`). Collision is CPU-side so the laptop SwiftShader/drift path validates logic; 1070 is for render
  fidelity. Confirm in-world: outdoor walk grounded, indoor/outdoor curbs climb, off-center building stops,
  cross-portal wall stops, 0 errors.
- **Ship** the wasm so default-ON (C/D/E) is live (`pkg/` gitignored → per the deploy mechanism). Confirm with the
  user before any push/deploy (outward-facing).

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
