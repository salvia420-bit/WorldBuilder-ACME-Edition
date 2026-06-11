# Retail-Manager Unification ROADMAP — synthesis (A16)

Date: 2026-06-11 · Input: agents/A1–A15 (15/15 reported, 0 parity verdicts, 137 divergences)
· Spec: PROMPT.md §7. Citations are `A<n> §<sec> [row <r>]` into `agents/`.

Naming note: three reports independently used "M1…M4" stage labels (A8 lifecycle, A10
materials, plus the roster's "M1–M4 motion fixes" lead that A4 §6 could not find in the
motion-dispatch doc and judges a memory mislabel). All stages below are namespaced
`<agent>-<stage>` (e.g. A8-M2) to kill the collision.

---

## 1. Top-5 recommended unifications (priority = leverage ÷ implementation risk)

### 1. Wasm-spine canonicalization — make the browser run the canonical Rust client
**Bundle: A1-O1 + A1-O2 + A13-W1/W2 + A8-M1/M2** (one program; same root cause, same files,
one wasm-rebuild batch family).
Three reports independently found the same structural defect: the wasm path bypasses the
canonical Rust client. A1 §3 row 1: the browser tick arm runs ONLY `movement.tick` — no
`world.tick()` (eviction/liveness) and no `simulation.tick` (quantum solver) ever execute
in-browser (lib.rs:38526 vs runtime.rs:171–199). A13 §3 rows 3–4:
`should_route_message_to_world` excludes UpdatePosition/UpdateMotion/PlayerTeleport, so the
wasm recv loop hand-mirrors 3 of the 4 timestamp-quartet sequences and echoes
`server_control_sequence = 0` forever (vs retail acclient.c:718176). A8 §3 rows 1–2: the same
exclusion gives entity lifecycle three parallel copies, and retail's 25 s out-of-visibility
destruction never reaches the web renderer — rigs persist all session. Every one of these is
the proven "fix lands in cli, regresses in wasm" class (A13 cites the teleport-mirror bug,
A8 cites the KIND_APPEARANCE drop). A1-O2 (publish pose AFTER `movement.tick`, two-line move,
A1 §4) rides the same batch and is the cheapest single win in the whole survey.
Risk M (A8-M1 hinges on diagnosing the wasm spatial `unreachable`, lib.rs:21917; A13-W1
touches load-bearing recv arms). Leverage H: retires B1-residual, F2-3 dual-site, F16-1/2
root cause, liveness.rs:137 TODO; unblocks #4's sync-tick stage.

### 2. Animation/motion completion layer — the queue nobody owns
**Bundle: A4-Q1/Q2 folded into A3-D1 (one DESIGN.md delta, per A4 §4 coordination note).**
A4 §2: retail's `pending_animations` queue + `AnimationDone → MotionDone` fan-out
(acclient.c:329873 → 317097 → 339349) has NO owner anywhere — completion is decided by
three.js clip end and never fed back to Rust; Stage-1's interpreted action FIFO
(interp_state.rs:50) is write-only dead code. A3 §3 row 1 confirms from the movement side:
no pending-motion queue, no MotionDone pop, so one-shot actions never complete pipeline-side
(stuck action state, jump allowed when retail refuses, sticky never auto-released). Crucially
this gap is **untracked in every existing plan**: DESIGN.md Stage 2 scope-gates the queue out
while its own code comment assumes it ("drained by stage 2's PerformMovement",
interp_state.rs:31 — internal plan contradiction, A4 §6). Subsumes C1 (partial), C2, the
motion-dispatch Wave-4 get_link resolver, and is the prerequisite both the ~90-command
dispatcher fix and DESIGN Stage 2 silently assume. Risk M, strongly headless-testable (Q1 is
a small faithful port with unit lanes); 1070 only for the eye-tests.

### 3. Single JS InputController (A14-I1, then I2; absorbs A12-C1)
A14 §3 row 1: two independent keystate trackers + three dispatcher families
(index.html:10823, camera.js:1464, picking.js:374) all feed the one Rust funnel, vs retail's
single ACCmdInterp→MovePlayer owner (acclient.c:435951, 717800) — with live symptoms (orbit
suppression exists on only one path; pursuit/charge-end stomps held WASD with (0,0,0),
A14 §3 row 2). A12 §3 row 11 independently found camera.js is a god-object owning input
dispatch and proposes the same extraction (A12-C1 explicitly defers to A14 — fold it in).
I1 is JS-live, flag-gated `?inputFunnel`, headless-verifiable, no Stage-1 gate; I2 (pursuit/
turn-to as wasm intents) re-homes F7-3/F8-5/F6-4/F6-5 point fixes. Leverage H ÷ risk L-M is
the best ratio of any H-leverage item.

### 4. Frame-ordering parity (A1-O2 immediately; A1-O3 sync tick after #1)
A1 §3 rows 2–3: we publish the player pose BEFORE integrating it (lib.rs:38739 vs 38921,
inverting retail's post-update callback, acclient.c:311375) and integrate physics AFTER
render via async microtask — a structural 2–3-frame input latency vs retail's same-frame
contract. O2 is trivial (ships inside #1's batch); O3 (`?syncPhysicsTick`) is the follow-on
that needs Fable-class judgment on the async→sync boundary and is gated on Stage-1 eye-test.
This also resolves A12 §3 row 12 (camera reads last frame's pose — A12 defers the ruling to
A1) and A2 §3 row 7's render-side smoothers exist partly to mask this ordering. Listed
separately from #1 because O3/O4 carry different risk and gating than the canonicalization
batch.

### 5. One surface render-state decoder (A10-M1/M2, then M3)
A10 §3 rows 1–3: retail has ONE decision function (`D3DPolyRender::SetSurface`,
acclient.c:454385); we have three decode sites that have **already diverged against each
other** — materials.js:1962–1964 attaches emissiveMap for luminous surfaces while
entities.js:3462–3465 explicitly does not, *both citing the same retail line with opposite
readings* (dyed luminous gear washes white), and the F.41 entity-owned path applies no flags
at all. Pure JS-live refactor, prop-equality unit-testable headless, risk L; closes the
unsurfaced-audit InvAlpha and solid-alpha rows and the F.41 debt as one-line cases inside
the unified function. Cheapest H-confidence structural fix in the render half.

**Near-misses (do these too, they just lost the top-5 cut):** A15-Q1/Q2 (two untracked
unbounded-buffer leaks + the 5-site EntityUpdate clone schema, A15 §3 rows 2–4 — near-zero
risk, zero dependencies, can start today); A11-S0/S1 (two untracked emitter-lifecycle bugs +
the 3-walker script executor, closes G13/G14 as a side effect, A11 §3 rows 1–2, 5–6).

---

## 2. Dependency order

**Global gate:** `Stage 1 eye-test PASS` (1070 currently down) gates: A1-O3, A3-D1/D2/D3
acceptance, A4 queue consumption, A6-T1+, A7-R5 flag flips, A13-W1 acceptance eye-test,
A14-I4, A2 acceptance, A5-P3. It does NOT gate landing those stages flag-off, nor any of:
A14-I1, A15-Q*, A10-M*, A11-S0–S2, A12-C2/C3, A9 stages, A8-M1/M3 (each report's §5
explicitly exempts these).

**Seam resolutions into one sequence (§7.2 requirement):**

- **A3/A4 seam:** A4 owns WHO fires completion, A3 owns what completion DOES (A4 §4, A3 §4
  D1). Sequence: A4-Q1 (queue core) → A3-D1 (MotionDone consumer, merged into the DESIGN
  delta — do NOT spec twice) → A5-P1 (hook drain/deferred fire) → A4-Q2 (AnimationDone
  wiring; A5 decides where `finished` fires, A4 §5 depends-on) → A3-D2 → A4-Q3/Q4 →
  A3-D3 (needs D1's DoMotion lattice; serialize with A13 on the recv arm).
- **A4/A5 seam:** A5-P1's per-entity hook queue must exist before Q2 routes completion
  through it (A5 §4 Stage P1 routes the `finished` listeners through the same queue).
  A11-S1's shared hook-executor must REUSE A5's `_fireHook`, not fork a 4th copy (A11 §5).
- **A6/A7 seam:** A7's predicates are pure functions that transplant into A6's pipeline
  (A7 §4 seam note). Sequence: A7-R1/R2/R3/R6 (headless, independent) → A6-T0 (inert shell)
  → A6-T1 (consumes A7 helpers; gated Stage-1 PASS) → A6-T2 → A7-R5 flag flips →
  A6-T3/T5. A6-T4 is parked (contradiction, §7 below).
- **A2/A3 seam:** A2-P1 (queue generalization) anytime; A2-P3 (sticky) strictly AFTER
  DESIGN Stage 3 / A3-D3 lands (target-update plumbing, A2 §4 P3); A2-P2 after the #1
  batch (it adds a remote pose export to lib.rs). A2-P4 is a 1070-only experiment, last.
- **2D-path seam:** A1-O4 (single frame driver) is BLOCKED until A15-Q4 (renderer-neutral
  core extraction — streaming is load-bearing inside the 2D handler, A15 §3 row 7) AND
  A8-M3 (kind-17 visibility currently routed through the 2D drain, A8 §3 row 6) land.
- **Input seam:** A14-I1 first; A12-C1 folds into it; A14-I2 targets A3's MoveToManager
  entry shape (don't duplicate its math, A14 §4 I2); A14-I4 emits through A13's single
  builder (W3).

**Recommended execution waves:**

| wave | items | gate |
|---|---|---|
| W0 (now, JS-live) | A15-Q1/Q2 · A14-I1 · A10-M1/M2 · A11-S0/S1 · A9-Stage2 | none |
| W1 (wasm batch R1) | A1-O2 · A1-O1 · A13-W1/W2/W3 · A8-M1 → A8-M2 | headless tests; teleport eye-test 1070-deferred |
| W2 (wasm batch R2) | A4-Q1 · A3-D1/D2 · A7-R1/R2/R3/R6 · A9-Stage1 · A2-P1 | headless |
| W3 (JS + manifest) | A5-P1/P2 · A4-Q2 · A11-S2 · A15-Q3 · A12-C2/C3 | W2 |
| W4 | A6-T0/T1/T2 · A3-D3 · A2-P2 · A14-I2 | Stage-1 eye-test PASS + W2 |
| W5 | A15-Q4 + A8-M3 → A1-O3/O4 · A11-S3 · A2-P3 · A14-I3/I4 · A4-Q3/Q4 | W3/W4 + A15 ruling |
| W6 (1070 return) | all parked eye-tests, A7-R5 flag flips, A1-O5, A2-P4, A9-Stage3 default-flip | 1070 |

---

## 3. Conflict matrix (same-file plans — serialize within a column)

| file | plans touching it | ruling |
|---|---|---|
| `apps/holtburger-web/src/lib.rs` (bridge) | A1-O1/O2/O3 · A13-W1/W2 · A8-M1/M2 · A4-Q2 · A2-P2 · A9-Stage1 · A5-P3 · A14-I2/I4 · A11-S4 · A10-M3a | **Hottest file.** W1 batch (A1+A13+A8) is one serialized change-set; everything else queues behind it. Small getter-only additions (A10-M3a, A11-S4, A5-P3 metadata) can batch together independently. |
| `crates/.../movement/system.rs` | A3-D1/D2/D3 · A4-Q1 · A6-T1/T2 · A7 consumers · A13-W3 · A14-I2/I3 · A2 step-site | A4-Q1+A3-D1 are one change-set; A6-T1 strictly after (it rewrites the tick spine those hooks live in); A13-W3 is a pure extraction, do it FIRST (shrinks the file others edit). |
| `scene3d/loop.js` | A1-O3/O4 · A15-Q3/Q4 · A8-M3 · A11-S3 · A2 (pose read) | A15-Q3 → A8-M3 → A15-Q4 → A1-O4 → A11-S3, in that order (each restructures dispatch the next depends on). |
| `scene3d/entities.js` | A5-P1/P2 · A4-Q2 · A9-Stage2/3 · A10-M1 delegate · A11-S0/S2 · A12-C2 helper · A15 | A9-Stage2 (rig-module extraction) is the big mover — either do it FIRST and rebase others, or LAST after the small edits; recommend first-in-W3. A5-P1 and A4-Q2 are one coordinated change (same `finished` listeners). |
| `spatial/physics.rs` + `spatial/collision.rs` | A6-T0/T1 · A7-R1–R6 | A7 first (pure functions), A6 consumes. |
| `index.html` | A14-I1 · A15-Q1/Q4 · A8-M3 · A1-O4 | A14-I1 (input block) is disjoint from A15-Q1 (drain block) — parallel OK; Q4/M3/O4 serialize. |
| `scene3d/camera.js` | A12-C1/C2/C3 · A14-I1 · A2-P4 | A14-I1 extracts the input half first; A12-C2/C3 touch only pose math, parallel-safe after. |
| `crates/holtburger-world/src/entity.rs` | A8-M1 · A3-D3 · A7-R6 | serialize in wave order (W1, W2, W4). |

---

## 4. Two lanes

**Lane A — headless-verifiable now (land flag-off + unit/golden tests on buildbox):**
A15-Q1/Q2/Q3 · A14-I1 (node sig-dedupe tests) · A10-M1/M2 (prop-equality tests) ·
A11-S0/S1/S2 (deterministic time/RNG seams) · A13-W1/W2/W3/W5 (golden-bytes, routed-set
asserts) · A8-M1/M4 · A1-O1/O2/O5 (spine-order + slicing unit tests) · A4-Q1 (queue-order
table tests) · A3-D1/D2 (FIFO/exhaustion units) · A7-R1/R2/R3/R6 · A6-T0 · A2-P1 ·
A9-Stage1/Stage2 · A5-P1/P2 (synthetic action-time harness) · A12-C2/C3 unit halves.

**Lane B — 1070-gated (parked until the box returns; tags from each report's §4 tests):**
every default-ON promotion and feel/eye test: Stage-1 eye-test itself; A1-O3/O4 latency
verdicts; A13-W1 teleport ring test; A8-M2 walk-away soak; A4-Q2/Q3 spam-truncation and
portal-cancel visuals; A5-P1 swing-end/door-thunk; A5-P3, A2-P2/P3/P4; A6-T1+ in-world runs;
A7-R2 feel + all R5 flips; A9-Stage1 chest-pose, Stage3/4; A10 dyed-luminous/fog/foliage;
A11-S3/S4/S5; A12-C2/C3 feel; A14-I2/I4 feel; A15-Q3/Q4 spot-checks.

---

## 5. Wasm-rebuild batches (Rust stages grouped; JS-live listed separately)

- **Batch R1 (the canonicalization batch):** A1-O1, A1-O2, A13-W1, A13-W2, A13-W3, A8-M1,
  A8-M2. One coherent recv-arm/spine rework; one manifest bump.
- **Batch R2 (movement crate):** A4-Q1, A3-D1, A3-D2(a), A2-P1, A14-I2 intent enum (code
  only, JS consumer later).
- **Batch R3 (spatial):** A7-R1, A7-R2, A7-R3, A7-R6, A6-T0 (+T1 when gated-on).
- **Batch R4 (small bridge getters/exports):** A10-M3a `hasPalette`, A11-S4 degradeDistance,
  A5-P3 root-motion metadata, A9-Stage1 placement-id plumb, A2-P2 remote-pose export,
  A4-Q2 `notifyAnimationDone` export, A14-I4 charge-clock.
- **JS-live (no rebuild, ship anytime within conflict order):** A14-I1, A15-Q1–Q4, A10-M1/M2
  /M3b, A11-S0–S3/S5, A5-P1/P2, A9-Stage2/3, A12-C1–C3, A8-M3/M4, A6-T5 interim form.

---

## 6. Leverage table (backlog IDs subsumed/unblocked per plan)

| plan | subsumes / closes | unblocks |
|---|---|---|
| A1 frame-orchestration | B1 residual, RP3-starvation class | A8-M2, browser remote-body solve, A1-O3 |
| A2 position trio | F3-4 (re-fix with cited math), heading-ease K=14, `USE_LOCAL_FORCE_POSITION_CONSTRAINT` legacy | F3-2 (P2 IS the deferred remote driver) |
| A3 movement delta | G-7/F1-6 wire half, B9 formalization | A4 MotionDone consumer, M-wave dispatcher completion half |
| A4 motion-table queue | C2 outright, C1 partial, dispatch Wave-4 resolver | DESIGN Stage-2 FIFO drain, motion-dispatch Waves |
| A5 sequence playback | (de-risks G14 routing); G10/G12 connection via P3 | A11-S1 shared executor |
| A6 transition pipeline | B4 (`USE_STATIC_BSP` becomes a backend), B11 residual, `USE_SUBSTEP_TRANSITION`/`USE_CALCNUMSTEPS_3D_DIST`/`USE_CLIFF_SLIDE_INTRA_SUBSTEP` orphan gates, `USE_PHYSICS_BSP` scaffold, G-4/F3-1 follow-on | A7 transplant target |
| A7 collision resolution | F4-2 remainder, F4-4 activation, G-6/G-8 follow-ons; 5 of 9 rows NEW/untracked | A6-T1 callees |
| A8 lifecycle | liveness.rs:137 TODO, F16-1/F16-2 root cause, F16-5 generalized | A15-Q4, A1-O4 |
| A9 part-array | G9-row12 (shipped by B5 — close it), Wave-7.5 clothingHotSwap promoted, G2 plumbing shared | A10/A11 rig-module consumers |
| A10 materials | unsurfaced-audit InvAlpha + solid-alpha rows, F.41 debt, C1 follow-on note | — |
| A11 particles/scripts | **G13, G14**, 2 untracked bugs (rows 5–6) | A5 hook-executor reuse |
| A12 camera | none (2026-06-07 CRIT already fixed in-tree) | — |
| A13 wire packs | F2-3 collapse, F5-2/F2-1 hardening, F5-3 recurrence-class | A3-Stage-3 send surface, A14-I4 |
| A14 input | F7-3, F8-5, F6-4, F6-5 re-homed; G-7/F1-6 + F1-5 follow-ons | A12-C1 (absorbed) |
| A15 dual-renderer | SG-D regression class, 2 untracked leaks | A1-O4, A8-M3 |

Caveat (multiple reports' §6): `~/out/bughunt86-…` and `~/out/grind-loop-2026-06-11.md` are
laptop-only and absent on the buildbox — A2/A6/A9/A13/A14/A15 all flag that their `tracked?`
columns may under-report. **Human action: re-grep those two docs on the laptop against the
rows each report lists as "untracked" before treating them as new.**

---

## 7. Contradictions surfaced (for human review — not smoothed over)

1. **Retail camera collision — A6 vs A12 (direct conflict, both dual-cited).** A6 §1/§3
   row 7 cites acclient.c:145082–145089 (`makeTransition → init_sphere(viewer_sphere) →
   find_valid_position`) and a dedicated viewer arm in `calc_num_steps` to claim the camera
   IS a transition client; A12 §1 cites acclient.c:147425–147864 to claim
   `CameraManager::UpdateCamera` contains no sweeps and "retail's camera clips through
   geometry", classifying our sweeps EXTRA-keep (A12 §3 row 10). Both can be literally true
   (the transition call sits at the SmartBox layer, outside UpdateCamera), but the *plans*
   conflict: A6-T4 ports a viewer-sphere pipeline; A12 says keep the modern controller.
   **Ruling needed; A6 already marked T4 droppable. Default: park A6-T4 (do-not-do §8).**
2. **In-codebase citation conflict (A10 §3 row 2):** materials.js:1962–1964 and
   entities.js:3462–3465 cite the SAME retail line (acclient.c:454691–454697) with opposite
   emissiveMap conclusions. A10-M1 resolves inside the unified function (adopts the
   emissiveMap reading as consistent with the FF-modulate combiner). Flagging because one of
   our shipped comments is wrong and will mislead future greps until M1 lands.
3. **DESIGN.md internal inconsistency (A4 §6 + A3 §3 row 1):** Stage 2 scope-gates the
   pending queue OUT while interp_state.rs:31 says the FIFO is "drained by stage 2's
   PerformMovement". A3's DESIGN delta (D1) is the designated fix; A4-Q1/Q2 must be folded
   into that delta, not specced twice.
4. **A1-O4 vs A15 row 7 / A8 row 6:** "single frame driver" cannot simply cancel the 2D
   loop — 3D world streaming (index.html:6027–6113) and kind-17 visibility routing live in
   it. All three reports flag the seam consistently; resolution is the W5 ordering above
   (A15-Q4 + A8-M3 before A1-O4). No actual disagreement, but an easy way to ship a breakage
   if executed from A1's report alone.
5. **MAX_QUANTUM 0.1 (ACE pin) vs 0.2 (retail)** — deliberate, documented in three places
   (A1 §3 row 6). A1-O5 wants ONE recorded decision; not a bug, but currently looks like one.
6. **Roster lead "M1–M4 staged motion fixes" not found** (A4 §6): the motion-dispatch doc
   uses Wave-N/C-item IDs. Memory likely conflated with the scenery-oracle M1–M4. Update
   memory doc accordingly.
7. **Local-player sticky exclusion** (A2 §6): retail's `stick_to_object` is not
   player-excluded and the interp progress test carries a sticky exemption, implying retail
   had local melee-lock sticky; ours excludes the local player (loop.js:1855). Single-cited
   on the ACE side — A2 kept it out of its table; recorded here so A2-P3 design re-checks it.

---

## 8. Do-not-do list (surveyed; rejected or parked, with reasons)

- **A13 row 2 (JumpPack Position omission) & row 9 (AutonomyLevel never sent):** NO WORK
  while ACE is the target server — ACE reads-and-discards / never reads (A13 §4). Revisit
  only for a non-ACE server.
- **A13-W4 (TurnToEvent 0xF649):** design-gated — ACE handler existence UNRESOLVED (A13 §6;
  this checkout lacks the ACE Network/GameAction tree). Confirm server-side consumption
  first; otherwise this is a dead send.
- **A6-T4 (camera through the transition pipeline):** parked on contradiction §7.1; A12's
  modern-controller verdict stands unless a human rules otherwise.
- **A12 rows 7/9/10:** ortho map-mode, slope/velocity look alignment, removal of camera
  collision sweeps — deliberate modernizations, keep (A12 §4).
- **Wholesale CSequence port:** A5 §4 explicitly: bake-then-mixer is parity on the core
  math (A5 §3 rows 9–11); only hook-stream/root-motion fidelity is worked.
- **2D sprite-backend port of EntityUpdate kinds 6–9, or deleting the 2D path:** A15 §4 —
  quarantine + shared core is cheaper; deletion breaks 3D streaming (A15 §3 row 7).
- **A8 deferred rows:** lost-cell park-and-reenter (row 4 — small payoff until streaming
  changes), DetectionManager (row 9 — wait for a real wire capture), CLOAKED shimmer
  (row 7 — already tracked, A10's domain).
- **A9-Stage4 (per-part LOD):** H risk, defer until G2 statics multi-band work is scheduled
  (shared plumbing — do together).
- **A6-T3 (remote-entity collision):** divergence real, but perf cost vs player-visible
  payoff is a judgment call A6 itself flags as speculative (A6 §6). Hold for after T1/T2
  prove out.
- **A2-P4 (render-smoother retirement):** eye-test-only experiment; meaningless before
  P1–P3 + Stage-1 PASS.
- **A11 row 8 EXTRA nets (RP6 cull, FIFO cap, reaper):** keep as owner-policy; only fold
  authored degrade radii in via S4.
- **A14 row 3 (hold-sidestep chord) & row 9 (mouse-walk):** deliberate WASD/camera
  modernizations; optional retail-keys flag only if I3 is otherwise free.
- **A1 row 10 (JS dt-clamp regime):** defensible EXTRA; revisit only inside O5.

---

## 9. Execution model per item

**Opus-class with the plan as written** (mechanical port/refactor, strong headless test
lane, unambiguous acceptance): A1-O2 · A13-W2/W3/W5 · A8-M2(after M1)/M4 · A4-Q1 · A3-D2 ·
A7-R1/R2/R3/R6 · A10-M1/M2/M3 · A11-S0/S1/S2 · A9-Stage1/Stage2 · A14-I1/I3 · A15-Q1/Q2/Q3 ·
A5-P1/P2 · A2-P1 · A12-C2/C3 · A6-T0.

**Needs Fable-class judgment** (diagnosis, async/ownership redesign, live-spine rewrite, or
cross-report seam arbitration): A8-M1 (the un-diagnosed wasm spatial `unreachable` is
load-bearing) · A13-W1 (recv-arm surgery on the camera-feeding UpdatePosition path) ·
A1-O1/O3/O4 (spine extraction; async→sync boundary; 2D-loop retirement) · A4-Q2 + A5-P1
interplay (completion-ordering across the wasm boundary) · A3-D1/D3 (DESIGN delta authoring)
· A6-T1/T2 (player-tick spine rewrite, H impl risk) · A2-P2/P3 (remote driver + sticky seam)
· A14-I2/I4 · A15-Q4 + A8-M3 (renderer-neutral core extraction) · A9-Stage3 default-flip ·
A11-S3 (clock move, serialized with A1).

**Needs a human, not an agent:** §7.1 camera ruling · §7.7 local-sticky check · A15 §6
"is 2D still used?" deprecation call · laptop re-grep of bughunt86/grind-loop docs (§6
caveat) · the MAX_QUANTUM 0.1-vs-0.2 decision record (A1-O5).
