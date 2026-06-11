# Retail-Manager Unification Survey — 16-agent sweep (PROMPT)

Date: 2026-06-11 · Status: **DRAFT — not yet run**
Model: Fable 5, effort **medium**, **no verify stage** (replaced by the dual-citation rule, §2.2)
Repo: `/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger` (all relative paths below are repo-relative)
Output dir: `apps/holtburger-web/docs/2026-06-11-unification-survey/` (this dir) — `agents/*.md` + `ROADMAP.md`

## 0. Mission

Map every subsystem where holtburger's behavior is split across JS / Rust / scattered call sites
against the retail client's canonical class decomposition (the manager classes in
`~/ac-headers/acclient.c`), and produce **staged, flag-gated unification plans** plus one
dependency-ordered ROADMAP. This is the movement-pipeline Stage 1 pattern
(commit `a1a3f5b1`, DESIGN at `apps/holtburger-web/docs/2026-06-11-unified-movement-pipeline/DESIGN.md`)
repeated across the remaining subsystems. **Survey output is plans and maps — zero code edits.**

## 1. Why now

- Discovery is not the bottleneck: bughunt/audit backlogs (§3.3) still hold unfixed items, and the
  1070 eye-test box is down. Architecture planning is exactly the work that needs no GPU.
- Unification is the regression-risk lever: split-brain subsystems (same behavior implemented in
  both JS and Rust, or in N call sites) are where fixes regress. Stage 1 proved the pattern.
- The roadmap is durable capital: later execution can be done by Opus-class agents against these
  plans even if Fable access ends.

## 2. Non-negotiable rules (every agent reads this first)

1. **PLANS, NOT EDITS.** Read-only everywhere. The only file you may write is your one report file
   under `agents/`. No code changes, no `git` mutations, no flag flips.
2. **Dual-citation rule** (this replaces the verify stage): every divergence claim must cite
   BOTH sides — `acclient.c:<line>` (or BN pseudo-C line) for retail behavior AND `<file>:<line>`
   for our behavior. A claim missing either side goes in your `SPECULATIVE / UNRESOLVED` section,
   never in the divergence table.
3. **Parity is a success result.** If your subsystem is already unified or already matches retail,
   say "NO WORK NEEDED — parity" with citations. Do not invent work to justify your slot.
4. **Dedupe before reporting.** Check the backlog docs (§3.3) and the movement DESIGN.md. If a
   divergence is already tracked, reference its ID (e.g. `F4-2`, `B11`, `G-3`) in the `tracked?`
   column instead of re-describing it. Untracked findings are the valuable ones.
5. **3D path only.** holtburger-web has two renderers. Claims about render/scene behavior must
   cite the `scene3d/` path (`scene3d/loop.js` dispatchOne, `scene3d/entities.js`), NOT the
   `index.html` 2D sprite path. (Agent A15 is the one exception — it compares the two.)
6. **Source precedence.** `acclient.c` is behavioral truth for the client. ACE C# (`../ACE` from
   repo root, i.e. `WB-ACME/external/ACE`) is the server-side cross-reference (Stage 1 pinned
   constants to ACE `MotionInterp.cs` — do likewise where the server owns the value). No
   PhatAC/PhatSDK. DRW field names may mislabel — trust acclient widths.
7. **Bounded effort (medium).** Start from the anchors given in your roster block. If you cannot
   locate a side after ~15 minutes of searching, record it as UNRESOLVED with the grep patterns
   you tried, and move on. An honest UNRESOLVED beats a padded guess.
8. **No builds.** No `cargo build/test`, no `wasm-pack`, no servers, no browsers. Text reading
   only — this sweep runs on the 8GB laptop.

## 3. Ground-truth inputs

### 3.1 Retail (read these for behavior)
- `~/ac-headers/acclient.c` — 31MB decompiled client, function bodies. PRIMARY.
- `~/ac-headers/acclient.h` — struct layouts, fields, enums.
- `~/ac-headers/acclient_2013.bndb_pseudo_c.txt` — Binary Ninja pseudo-C. SECONDARY: use when an
  acclient.c body is garbled/missing.
- `~/ac-headers/acclient.txt` — PDB symbol dump (cvdump). Address mapping: a symbol at
  `0001:00123260` lives at VA `0x401000 + 0x123260 = 0x524260`. Use to find mangled names /
  confirm identity; bodies are in acclient.c.

### 3.2 Ours (read these for current implementation)
- `crates/holtburger-core/src/client/` — Rust client core: `movement/` (Stage 1:
  `raw_state.rs`, `interp_state.rs`, `motion_interp.rs`), `movement_types.rs`, `simulation.rs`,
  `runtime.rs`, `messages.rs`, `commands.rs`.
- `crates/holtburger-world/src/` — world/physics side: `context.rs`, `entity.rs`, `events.rs`,
  `handlers/`, `hydration.rs`, `player/`.
- `apps/holtburger-web/src/lib.rs` — the wasm-bindgen bridge (the `pkg/` wasm-pack target).
- `apps/holtburger-web/scene3d/` — the 3D renderer: `loop.js` (frame loop + `dispatchOne`),
  `entities.js`, and siblings (materials, particles, camera, audio — locate by grep).
- `apps/holtburger-web/docs/url-flags.md` — the flag registry. Propose new flags in its style.

### 3.3 Backlog docs (dedupe sources — reference IDs from these)
- `~/out/bughunt86-combat-render-loop-items-2026-06-09.md` (F-items, B-items)
- `~/out/holtburger-motion-dispatch-coverage-2026-06-09.md`
- `~/out/holtburger-unsurfaced-render-audit-2026-06-09.md`
- `~/out/grind-loop-2026-06-11.md` (G-items)
- `apps/holtburger-web/docs/2026-06-11-unified-movement-pipeline/DESIGN.md` (movement Stages 1–3
  are already specced here — A3 audits this, nobody re-specs it)
- Older deep-dives if useful: `docs/motion-table-acclient-audit-2026-05-19.md`,
  `apps/holtburger-web/docs/` (animation deep-dive, movement-fixes 2026-06-05).

## 4. Pre-resolved facts (do not re-derive; do not contradict without citations)

- **Stage 1 is shipped but NOT eye-tested.** `USE_INTERPRETED_VELOCITY` is ON,
  `SKIP_PARENTED_ENTITY_COLLISION` is ON, both pending the 1070. Plans that build on Stage 1 must
  list "Stage 1 eye-test PASS" as a gate.
- The 1070 is currently shut down: tag every test step as `headless-now` vs `1070-gated`.
- Rust changes go live only on wasm rebuild (batch them); JS changes are live on reload.
- Retail's per-frame spine: `CPhysics::UseTime` → `CPhysicsObj::update_object` →
  manager `UseTime` chain (MovementManager / PositionManager / MoveToManager /
  MotionTableManager...). A1 owns mapping this ordering.
- Excluded scopes (deliberate, do not survey): **Sound** (2026-06-09 systemic audit: 0 content
  gaps; fix shipped). **UI/HUD** (separate HUD-parity workflow exists). **DAT parsing/bake**
  (offline pipeline, different risk profile). **WB.Terminal** (different app).

## 5. Agent roster — 15 surveyors + 1 synthesis

Heavyweights (animation, collision) get two agents with an explicit seam. Each block: retail
anchors (verified to exist in acclient.h/.c), our-side starting points, leads from prior sessions
(**leads are unverified memory — confirm with citations before using**), and the key questions.

### A1 — frame-orchestration
- Retail anchors: `CPhysics::UseTime`, `CPhysicsObj::update_object` / `update_object_internal`,
  the order in which manager `UseTime`s fire, `PhysicsTimer`, transient-state ordering.
- Ours: `holtburger-core/src/client/simulation.rs`, `runtime.rs` tick; `scene3d/loop.js` rAF order
  (input → wasm tick → dispatch → render).
- Key questions: what is retail's exact per-frame call order, and where does ours differ in
  sequencing (not in math)? Which ordering differences can explain known
  late-by-one-frame artifacts? Does our split (Rust tick vs JS rAF) respect retail's
  update boundaries?

### A2 — position-manager-trio
- Retail anchors: `PositionManager` (`UseTime`, `adjust_offset`, `InterpolateTo`, `StickTo`,
  `ConstrainTo`), `InterpolationManager`, `StickyManager`, `ConstraintManager`.
- Ours: grep `interp|sticky|constraint` in `holtburger-core/src/client/` +
  `holtburger-world/src/player/`; `scene3d/loop.js` position smoothing.
- Leads (verify): F3-4 sticky fix shipped 2026-06-09; 5Hz UpdatePosition cadence; FU-3 experiment.
- Key questions: retail funnels ALL position correction through one `adjust_offset` pipeline —
  where do we apply corrections instead (count the sites)? What would a single
  `position_manager.rs` owner look like? Overlap warning: movement DESIGN.md Stage 3 covers
  MoveToManager — A2 owns the position trio only; flag the seam for A16.

### A3 — movement-stack-gap (audit, not re-spec)
- Retail anchors: `MovementManager` (PerformMovement / unpack_movement / MotionDone /
  ReportExhaustion / HitGround / LeaveGround / EnterDefaultState), `CMotionInterp`
  (jump_charge_is_allowed, set_hold_run, contact_allows_move, add_to_queue, server_action_stamp),
  `MoveToManager`.
- Ours: `holtburger-core/src/client/movement/*` (Stage 1 code) + DESIGN.md Stages 2–3.
- Key questions: diff DESIGN.md's Stage 2/3 scope against the full retail cluster — what does the
  spec MISS (candidates to check: MotionDone routing to weenie/server, ReportExhaustion,
  HitGround/LeaveGround fan-out, pending-motion queue semantics, jump charge/extent path,
  StopCompletely)? Output is a **delta to DESIGN.md**, not a new plan.

### A4 — motion-table-queue (animation heavyweight 1/2)
- Retail anchors: `MotionTableManager` (state, animation_counter, pending_animations,
  add_to_queue, truncate_animation_list, remove_redundant_links, CheckForCompletedMotions,
  AnimationDone), `CMotionTable` (GetObjectSequence, StopSequenceMotion, re_modify, is_allowed,
  get_link), `MotionState` (modifiers/actions lists).
- Ours: Rust motion-table code (grep `MotionTable|motion_table` in crates/) + wherever
  completion ("anim done") is decided today.
- Leads (verify): motion-dispatch coverage doc 2026-06-09; M1–M4 staged fixes.
- Key questions: who owns the pending-animation queue and the AnimationDone → MotionDone chain in
  our stack, and does completion-ordering match retail? Is `re_modify` (re-applying modifiers
  after sequence swap) represented at all?

### A5 — sequence-playback (animation heavyweight 2/2)
- Retail anchors: `CSequence` (frame advance, link/queue of CAnimSequenceNodes, first-cycle
  semantics), `CAnimHook` dispatch point, part-frame application into `CPartArray`.
- Ours: Rust sequence/frame advance (grep `Sequence|part_frames` in crates/) + JS animation hook
  dispatch (24-type AnimationHook dispatch — find it under scene3d/) + rig application.
- Leads (verify): DIM5-2 root-motion orient gate; velScale/MOTK cycleBaseSpeed prefetch fix
  2026-06-05; Stage 2 of movement DESIGN.md will drive the rig from interpreted state.
- Key questions: who owns the playback clock (Rust vs JS vs three.js mixer)? Where do hook
  timings diverge from retail frame semantics? Seam with A4: A4 owns queue/completion, A5 owns
  per-frame playback + hooks.

### A6 — transition-pipeline (collision heavyweight 1/2)
- Retail anchors: `CTransition` + transition entry points on CPhysicsObj (`transition`,
  `transitional_insert`-style flow), SpherePath/ObjectInfo/CollisionInfo structs, cell transit
  (which cell does a moving sphere land in).
- Ours: `holtburger-world/src/` collision/transit (grep `transition|collide|sphere` in
  holtburger-world), wasm bridge collision exports in `apps/holtburger-web/src/lib.rs`.
- Leads (verify): B4-Tier-2 static-BSP push-out behind `USE_STATIC_BSP` (default-off, 5df77717);
  swept find_collisions deferred; indoor per-poly walls + floor raycast (academy rubberband fix).
- Key questions: retail runs ONE transition pipeline for all movers; how many distinct collision
  paths do we run (player vs entity vs projectile vs camera), and what would one pipeline look
  like staged behind flags?

### A7 — collision-resolution (collision heavyweight 2/2)
- Retail anchors: contact/slide resolution inside the transition system — walkable checks,
  step-up/step-down, slide-along-contour, ethereal checks, water depth.
- Ours: same files as A6, resolution layer; plus shipped fixes F4-1/F4-2/F4-3/F4-4, step_up
  0.6 / step_down 1.5 (physics-retail-parity branch work).
- Key questions: which resolution rules are ported vs approximated (cite the constants), and
  which of the recent F4-x point fixes would be subsumed by a unified resolver? Seam with A6:
  A6 owns pipeline/cell-transit shape, A7 owns the contact math.

### A8 — cell-visibility-maint
- Retail anchors: `CObjectMaint` (visible-object/cell lists, destruction timers), `CellManager`,
  `DetectionManager`, `CEnvCell`/`CLandBlock` handoff.
- Ours: entity lifecycle + visibility gating (grep `kind == 17|visible|destroy` in scene3d/ and
  crates/holtburger-world/src/entity.rs), EnvCell build path (buildEnvCellsForLandblock),
  PVS handling.
- Leads (verify): draw-gate kind=17 predicate shipped 2026-05-16; PVS 24/104-at-spawn is
  retail-correct; ObjectCreate seeding.
- Key questions: retail separates "known" (maint) from "visible" (PVS) from "drawn" — do we
  conflate any two, and is there one owner for entity lifecycle or N ad-hoc sites?

### A9 — part-array-setup
- Retail anchors: `CSetup`, `CPartArray`, `CPhysicsPart`, `CGfxObj` — part placement frames,
  setup hierarchy, scale, palette/texture/anim-part swaps (obj-desc changes).
- Ours: `scene3d/entities.js` setup→Object3D construction + Rust setup/part code (grep
  `Setup|PartArray|part` in crates/holtburger-dat and -core).
- Leads (verify): weapon-grip B5 fix touched part attach; clothing/palette swap path exists from
  item-manipulation plan (PR8 "appears on character" was planned, JS ParentEvent 0xF749 gap).
- Key questions: is the setup→scene mapping one module or scattered across entities.js? Where do
  placement-frame semantics (parent frames, attachment transforms) diverge from CPartArray?

### A10 — render-state-materials
- Retail anchors: Surface (0x08) render-state bits (luminous/diffuse/alpha), per-part render
  flags, the degrade/quality ladder if present near CGfxObj usage.
- Ours: `scene3d/` materials module (materials.js — locate), clone-on-write material handling
  (`__cacheOwned`), statics renderer material path.
- Leads (verify): Surface render-state pivot memo 2026-05-28 (material-override chain 0x16/17/18
  shipped-DEAD; real lever is Surface render-state); white-door/dark-buildings = lighting OPEN.
- Key questions: one material-decision function or several? Which Surface bits are honored,
  ignored, or approximated (table them)? What's the staged plan to a single
  surface→three.js-material mapper?

### A11 — particles-physics-scripts
- Retail anchors: `ParticleManager`, `ScriptManager` (PhysicsScript 0x33 / script table 0x34),
  ParticleEmitter (0x32) lifecycle: create/destroy, attachment to parts, script-driven emission.
- Ours: JS particle runtime under scene3d/ (Sky-J P1–P5 work) + Rust parsers
  (crates/holtburger-dat) + hook-driven CreateParticle dispatch.
- Leads (verify): particle `__cacheOwned` clone leak fixed f068fa15; MotionTable→CreateParticle→
  0x32 chain (OptimShi); portal-space donut used engine-direct Setup.
- Key questions: parser/runtime split is fine, but who owns emitter LIFECYCLE (attach, timeout,
  kill-on-object-destroy)? Retail routes via managers — do we leak or orphan emitters because no
  single owner exists?

### A12 — camera
- Retail anchors: `CameraManager` methods (modes, follow/first-person transitions, collision-aware
  positioning if present).
- Ours: scene3d camera module (3D camera/game-feel waves A–G shipped 2026-05-11).
- Key questions: is our camera an intentional port or ad-hoc? Only propose unification if there's
  player-visible divergence (occlusion handling, transition snaps) — "NO WORK NEEDED" is a likely
  valid outcome here.

### A13 — wire-state-packs
- Retail anchors: `JumpPack`, `MoveToStatePack`, `AutonomousPositionPack`, `TurnToEventPack`
  (Pack/UnPack bodies; the instance/server_control/teleport/force_position timestamp quartet),
  `ACCmdInterp::Send*Event` boundary.
- Ours: `holtburger-core/src/client/messages.rs` + `commands.rs` + the wasm bridge
  `apps/holtburger-web/src/lib.rs` (known dual-site pattern), cli app message handlers.
- Leads (verify): F2-3 LoginComplete defer is dual-site (cli + wasm); F5-3 fixed a 4-byte decode
  shift in 0xF753; timestamp echo rules matter for ACE accepting moves.
- Key questions: how many sites encode/decode each pack today? Plan for ONE pack codec module
  (Rust) + one send boundary, with the timestamp quartet handled in exactly one place.

### A14 — input-to-motion
- Retail anchors: `ACCmdInterp` (OnAction, SetMotion, HandleNewForwardMovement, DoJump/
  CommenceJump/FinishJump, UITogglesRun, autonomy levels), `CInputManager`, HoldKey semantics.
- Ours: holtburger-web input handling (keymap from DAT 0x14 gmDefaultMap) → wasm motion calls;
  grep `keydown|HoldKey|set_motion` in apps/holtburger-web.
- Key questions: retail's input→raw-state→interpreted funnel vs ours (does anything bypass
  raw-state?); hold-key (run/sidestep modifier) semantics parity; jump charge input path
  (ties to A3 — A14 owns input side only).

### A15 — dual-renderer-seam (holtburger-internal; retail-cite rule waived)
- Compare: `index.html` 2D sprite path vs `scene3d/` path. Dual-citation here means citing BOTH
  renderer paths.
- Key questions: which message handlers are duplicated across the two paths (table them with both
  cites)? What breaks 2D if scene3d-only fixes land (or vice versa)? Plan: unify dispatch into one
  message→handler layer with renderer backends, or formally quarantine the 2D path (document
  which is cheaper and what tests guard it).

### A16 — synthesis (runs after all 15; spec in §7)

## 6. Per-agent method + report schema

Work phases (in order): (1) read your roster block + §2 rules; (2) retail map from acclient.c
bodies; (3) ours map (Rust AND JS sides); (4) divergence table; (5) staged plan; (6) scores.

Write exactly one file: `apps/holtburger-web/docs/2026-06-11-unification-survey/agents/<ID>-<slug>.md`

```markdown
# <ID> <slug> — unification survey
## 1. Retail map            # responsibilities + call order, every claim acclient.c:line cited
## 2. Ours map              # implementation sites, file:line, Rust and JS columns
## 3. Divergences
| # | behavior | retail cite | our cite(s) | class | symptom | tracked? |
# class ∈ MISSING / DIFF-ALGO / SPLIT-BRAIN (N sites) / EXTRA (we do, retail doesn't) / PARITY
## 4. Staged unification plan        # or "NO WORK NEEDED — parity" with citations
# per stage: scope · files · new module shape · flag name (default-off) · JS-live or wasm-rebuild
#            · tests (headless-now vs 1070-gated) · rollback (flag off)
## 5. Scores
# leverage: backlog IDs subsumed; regression-risk reduction H/M/L; impl risk H/M/L;
# 1070-dependency Y/N; depends-on (other agents' subsystems / Stage 1 eye-test)
## 6. SPECULATIVE / UNRESOLVED       # single-cited claims + search patterns tried
```

Return value (to the workflow, not the user): 4 lines — divergence counts by class, stages
proposed, backlog IDs subsumed, headline finding. The report file is the deliverable.

## 7. Synthesis spec (A16)

Input: all 15 reports (read fully). Output: `ROADMAP.md` in this dir.

1. **Top-5 recommended unifications** with one-paragraph rationale each
   (priority = leverage ÷ implementation risk).
2. **Dependency order**: what blocks what; "Stage 1 eye-test PASS" called out as the gate for
   anything building on movement; A2/A3 and A4/A5 and A6/A7 seams resolved into a single sequence.
3. **Conflict matrix**: plans touching the same files (`simulation.rs`, `lib.rs` bridge,
   `loop.js`, `entities.js`) — mark which must serialize.
4. **Two lanes**: headless-verifiable-now vs 1070-gated (parked until the box returns).
5. **Wasm-rebuild batches**: group Rust-side stages into rebuild batches; JS-live items separate.
6. **Leverage table**: backlog IDs subsumed per plan (a plan that obsoletes many open F/B/G items
   ranks up).
7. **Do-not-do list**: surveyed but low-leverage or conflicting items, with reasons.
8. **Execution model per item**: "Opus-class with this plan" vs "needs Fable-class judgment".

Rules: cite agent reports per claim (`agents/A6-...md §3 row 4`). Where two reports contradict,
surface the contradiction explicitly for human review — do not smooth it over.

## 8. Execution

Runner checklist (the session that launches this):
- `/effort medium` (this manifest is tuned for medium; max wastes budget on a survey).
- Laptop is fine: read-only text work, no builds (rule §2.8 keeps OOM constraints satisfied).
- Expected spend: 15 surveyor agents (medium, large file reads) + 1 synthesis — comparable to the
  previous 16-wide sweep. No verify stage by design.
- After the run: human reviews ROADMAP.md; commit the survey dir (new files only, hunk-selective
  rule trivially satisfied).

Workflow script (paste into the Workflow tool; requires explicit ultracode/workflow opt-in):

```javascript
export const meta = {
  name: 'unification-survey',
  description: 'Survey 15 subsystems vs retail manager decomposition; emit staged unification plans + roadmap',
  phases: [
    { title: 'Survey', detail: '15 subsystem agents, Fable 5, plans not edits' },
    { title: 'Synthesize', detail: 'dependency-ordered ROADMAP.md' },
  ],
}
const DOC = '/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/docs/2026-06-11-unification-survey/PROMPT.md'
const SUBSYSTEMS = [
  ['A1','frame-orchestration'], ['A2','position-manager-trio'], ['A3','movement-stack-gap'],
  ['A4','motion-table-queue'],  ['A5','sequence-playback'],     ['A6','transition-pipeline'],
  ['A7','collision-resolution'],['A8','cell-visibility-maint'], ['A9','part-array-setup'],
  ['A10','render-state-materials'], ['A11','particles-physics-scripts'], ['A12','camera'],
  ['A13','wire-state-packs'],   ['A14','input-to-motion'],      ['A15','dual-renderer-seam'],
]
const SUMMARY = { type: 'object', properties: {
  id: { type: 'string' }, divergences: { type: 'number' }, parity: { type: 'boolean' },
  stages: { type: 'number' }, subsumed: { type: 'array', items: { type: 'string' } },
  headline: { type: 'string' } }, required: ['id','divergences','parity','headline'] }

phase('Survey')
const results = await parallel(SUBSYSTEMS.map(([id, slug]) => () =>
  agent(
    `You are survey agent ${id} (${slug}). Read ${DOC} in full. Obey §2 rules exactly — ` +
    `read-only, dual-citation, parity-is-success, no builds. Your subsystem brief is the ` +
    `"### ${id} — ${slug}" block in §5. Follow the §6 method and write your report to ` +
    `${DOC.replace('PROMPT.md','')}agents/${id}-${slug}.md using the §6 schema. ` +
    `Return only the structured summary.`,
    { label: `${id}:${slug}`, phase: 'Survey', model: 'fable', schema: SUMMARY })))
const ok = results.filter(Boolean)
log(`${ok.length}/15 reports written; ${ok.filter(r => r.parity).length} parity; ` +
    `${ok.reduce((n, r) => n + (r.divergences || 0), 0)} divergences total`)

phase('Synthesize')
const roadmap = await agent(
  `You are synthesis agent A16. Read ${DOC} §7 and ALL reports in ` +
  `${DOC.replace('PROMPT.md','')}agents/. Write ROADMAP.md per §7 to ` +
  `${DOC.replace('PROMPT.md','')}ROADMAP.md. Cite reports per claim; surface contradictions. ` +
  `Summaries from the surveyors: ${JSON.stringify(ok)}. Return the top-5 list as text.`,
  { label: 'A16:synthesis', phase: 'Synthesize', model: 'fable' })
return { reports: ok.length, parity: ok.filter(r => r.parity).map(r => r.id), top5: roadmap }
```
