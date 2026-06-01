# Player-Movement Physics — Investigation Guide & Future-Work Handoff

**Created:** 2026-06-01
**Subject:** Holtburger (ACME WorldBuilder external) 3D-render player-movement physics, compared against the decompiled retail Asheron's Call client and the ACE server port.
**Status:** Investigation complete + adversarially verified. No code changed yet — this is a research/handoff package.

---

## 0. What this folder is

A self-contained handoff so a future agent (or the user) can resume physics work **without re-running the ~3.3 M-token investigation**. It contains the verified findings, the raw evidence, a cross-codebase file:line index, and ready-to-run task prompts for each gap.

```
physics-deep-dive-2026-06-01/
├── GUIDE.md                          ← you are here (start here)
├── verified-comparison-report.md     ← the full synthesis: 7 dimensions, ours vs retail, verified
├── cross-codebase-reference-index.md ← every load-bearing file:line, both sides, all repos
├── PROMPTS.md                        ← copy-pasteable task prompts for each prioritized gap
└── artifacts/
    ├── workflow-full-result.json     ← raw output of the deep-dive workflow (64 agents, all claims+verdicts)
    ├── deep-dive-claims-digest.txt   ← human-readable digest of all 57 claims + adversarial verdicts + corrections
    └── physics-deep-dive-workflow.js ← the exact workflow script (re-runnable / resumable — see §5)
```

**Read order for a new agent:** this GUIDE → `verified-comparison-report.md` → `cross-codebase-reference-index.md` (as a lookup table) → pick a task from `PROMPTS.md`. Open `artifacts/deep-dive-claims-digest.txt` when you need the exact evidence/corrections behind a specific claim.

---

## 1. The one-paragraph situation

Our movement physics is **two predictors stapled together** where retail has one. (1) A **Rust/wasm authoritative integrator** (`crates/holtburger-core/src/client/movement/system.rs` + `crates/holtburger-world/`) that is a genuinely faithful port of the retail math for the *parameters* (jump, friction form, motion architecture, fall damage are 1:1 with ACE/`acclient.c`). (2) A **separate JS dead-reckon predictor** (`apps/holtburger-web/scene3d/camera.js`) that smooths the camera/avatar X/Y at a flat 4.5 m/s and lerps toward the integrator pose. The real fidelity debt is **not in the movement constants** — it's in the **integration loop, the collision solver, and the reconciliation mechanism**. Retail = one `CPhysicsObj`; ACE = a 1:1 C# port of it and is the readable proxy for the decompiled client.

---

## 2. Verdict summary (adversarially verified)

The deep-dive workflow ran 7 investigators, then ~40 skeptical verifiers each tasked with **refuting** a specific claim. Result: **44 confirmed, 13 partially-correct, 0 refuted.** The model below is what survived scrutiny.

### Prioritized fidelity-gap table

| # | Gap | Impact | Fix locus | Effort |
|---|---|---|---|---|
| 1 | **No quantum subdivision / no HugeQuantum skip / no terminal-velocity clamp; raw unbounded `dt`** → frame-hitch over-integrates falls | HIGH | `handle.rs:96` (dt computation) + `system.rs:597` (integration); port ACE `update_object` clamp-subdivide loop | medium |
| 2 | **JS predictor can't see the integrator's speed** — flat 4.5 m/s vs skill-derived; `LocalPlayerPose` export has no velocity field → sustained forward-bias sawtooth | HIGH | add velocity to `LocalPlayerPose` export, OR drop JS independent-advance and only lerp-to-integrator | medium |
| 3 | **No step-up / step-down / edge-slide / cliff-slide** — stairs & curbs impassable. Setup.dat step heights are *parsed but ignored* | HIGH | feed `setup_model` step heights into `spatial/physics.rs` floor-snap/clamp solver | medium-high |
| 4 | **Server force-position never corrects the wasm working pose** (Snapshot mode preserves it) + heartbeat is unconditional (re-asserts drifted pose) | HIGH | `mutations.rs:606` / `scene.rs:1230-1246` (apply small force-pos to body.pose); add position-changed gate to heartbeat (`system.rs` ~1419) | medium |
| 5 | **Backstep speed bug** — `(Run,Backstep)` returns raw `run_rate_scalar` (~4.5) *as m/s* instead of `WalkAnimSpeed·BackwardsFactor·run_factor` (~2.03×) | MEDIUM | `common.rs:442` backstep arm | low |
| 6 | **Walkable-slope threshold** `normal.z ≥ 0.5` (60°) vs retail `FloorZ = 0.66417` (48.4°) | MEDIUM | floor classifier constant in `spatial/physics.rs` | low |
| 7 | First-order/symplectic Euler; gravity applied to velocity not acceleration; missing `0.5·a·t²` term | LOW | `system.rs:936-939` | low |

Full per-dimension detail, evidence, and the partially-correct nuances are in `verified-comparison-report.md`.

---

## 3. Things the adversarial pass CORRECTED — do not repeat these mistakes

A future agent will likely re-derive the same wrong first impressions. The skeptics caught these:

1. **"Ours is MotionTable-derived, retail is hardcoded 4.0/3.12" is HALF WRONG.** *Both* retail and our integrator drive **grounded** speed from DAT cycle velocity. Retail's `RunAnimSpeed=4.0 / WalkAnimSpeed=3.12 / SidestepAnimSpeed=1.25` constants live in `get_state_velocity`, which ACE calls **only** from `get_leave_ground_velocity` — i.e. **jump take-off + a max-speed clamp, NOT steady-state walking** (`MotionInterp.cs:656` is the sole caller). Don't frame grounded speed as a hardcoded-vs-data divergence.

2. **The dual-predictor speed mismatch is ~1.8×, not 4.5×.** The "1.0" in our walk path is a *run-rate scalar* (a multiplier), not m/s. Real Rust/retail run speed ≈ `base_run_velocity × run_factor`. The genuine bug is that **JS uses `4.5` directly as a final m/s** and never consults the skill/burden formula.

3. **The Jump animation clip `0x2500003B` is ABSENT from all 436 real motion tables.** A finder claimed it exists; the skeptic *ran `jump_clip_data_check.rs` against the real `client_portal.dat`* → `OVERALL=FAIL`. `JUMP` is only a wire/enum constant set programmatically by `begin_jump` (`types.rs:738`); there is no backing clip. The arms-up jump *visual* is a quaternion overlay (`setAirborne`), per Joe Trevis's note that retail had a combined arms-up jump/fall, not a discrete clip.

4. **There is no "5 m snap" on the local-player force-position path.** The local-player teleport snap triggers on **landblock-ID crossing** (`index.html:5960-5968`); the wasm side is **sequence-gated, not distance-gated**. The 5 m rule only governs the JS dead-reckon reconcile.

---

## 4. Ground-truth constants (verified, both sides)

| Quantity | Retail / ACE | Ours | File refs |
|---|---|---|---|
| Gravity | `-9.8` (`PhysicsGlobals.cs:13`) | `9.8` (`system.rs:938`) | ✅ |
| Jump height | `burdenMod·(skill/(skill+1300)·22.2+0.05)·power`, floor `0.35` | identical (`player/types.rs:715`) | ✅ |
| Jump velocity | `√(h·19.6)` (`WeenieObject.cs:93-95`) | identical | ✅ |
| Fall damage | `ratio·87.293810`, `jumpV=11.25434`, `+4.5` (`Player_Move.cs:254-271`) | identical but **0 callers** (`types.rs:643-650`) | ✅ |
| Small-velocity snap | `SmallVelocity=0.25` | `0.25` (`common.rs:382`, applied `system.rs:705`) | ✅ |
| Friction form | `v*=(1-f)^q` | same | ✅ |
| Friction coeff | `0.95` (`PhysicsGlobals.cs:15`) | **`0.5`** (`common.rs:374`) | ⚠️ ~4.2× weaker/tick |
| Lateral accel cap | none (friction-only) | **`8 m/s²`** (`common.rs:405`) | ⚠️ ours-only |
| Sidestep run cap | `MaxSidestepAnimRate=3.0` | `3.0` (`common.rs:417`) | ✅ |
| Run rate | `GetRunRate`: 4.5 @ skill≥800 | `run_rate_from_skill_and_burden` (1:1) | ✅ |
| Walkable slope | `FloorZ=0.66417` (48.4°) | `≥0.5` (60°) | ⚠️ |
| Terminal velocity | `MaxVelocity=50` | **none** | ❌ |
| Timestep | `MinQuantum=1/30`, `MaxQuantum=0.1`, `HugeQuantum=2.0` subdivide+skip | variable rAF `dt`, **no clamp/subdivision** | ❌ |
| Integration | 2nd-order `0.5·a·q²+v·q`, accel-carried gravity | 1st-order symplectic Euler, velocity-carried gravity | ⚠️ |
| Step up/down | `0.01` global / `0.04` non-walkable fallback / Setup.dat per-object | **parsed, ignored** | ❌ |

---

## 5. Re-running / extending the investigation

The workflow is **resumable and re-runnable**. The script is `artifacts/physics-deep-dive-workflow.js` (also persisted at its original session path). To re-run with edits:

```
# Edit artifacts/physics-deep-dive-workflow.js (add a dimension, change a prompt, etc.)
# then from the Workflow tool:
Workflow({ scriptPath: "<absolute path to the edited .js>" })
```

It's a two-phase pipeline: **Investigate** (one deep-read agent per dimension, schema-validated structured output) → **Verify** (adversarial skeptic per claim, defaults to refute). To add a dimension, append to the `DIMENSIONS` array; the verify phase fans out automatically. Concurrency is capped at ~14; ~64 agents total took ~74 min.

**Resume note:** the original run id was `wf_5333a897-5f9` (same-session resume only; not valid in a new session). For a fresh session just re-invoke with the `scriptPath`.

---

## 6. Open questions that CANNOT be answered from source (need a live run / DAT dump)

These gate the remaining uncertainty. Do these before trusting any speed-parity claim:

1. **What is the real player MotionTable `0x09000001` `base_run_forward_velocity` magnitude?** Determines whether our grounded run speed actually equals retail. Test fixtures use synthetic `(1.0, 1.5)`. → Use a `WB.Terminal` motion-table oracle dump, or `__diag` in-browser. See `~/.claude/skills/worldbuilder-terminal/` and the memory note **[Use existing DAT tools first]**.
2. **Steady-state visible amplitude of the dual-predictor sawtooth** for a low-Run character (Run≈0). Estimated ~0.12 m/emit overrun pulled back each 150 ms lerp — needs an off-screen capture on the 1070 to confirm whether it reads as jitter or a steady forward bias.
3. **Does a sub-snap force-position leave a persistent oscillation in-world?** The Snapshot-mode `preserve_local_runtime_pose` means `body.pose` is never corrected and the next heartbeat re-sends the drifted pose. Needs a live rubberband capture.

**HARD RULE for any 1070 testing:** invisible only — off-screen/headless, no window/focus/input steal. See memory **[1070 tests NEVER on screen]** and **[wire agent mode]** / **[wire-agent diag layer]** (`window.__diag` surfaces + `?wireframe=1` + `?autoLogin`).

---

## 7. Key reference paths (all codebases)

| Repo | Path | Role |
|---|---|---|
| **Ours (active)** | `/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger` | the 3D-render app + Rust crates. Branch at investigation time: `fix/holtburger-stutter-streaming` |
| Decompiled retail | `/home/wbterminal/ac-headers/acclient.c` (31 MB C), `.h` (structs/enums), `.txt` (82 MB cvdump) | primary behavioral retail ref; obfuscated — cross-check with ACE |
| ACE (server) | `/home/wbterminal/WorldBuilder-ACME-Edition/external/ACE/Source/ACE.Server/Physics/` | **readable 1:1 port of retail physics** — use as the proxy. (mirror: `/home/wbterminal/ace-server`) |
| DatReaderWriter | `/home/wbterminal/WorldBuilder-ACME-Edition/external/DatReaderWriter` | MotionTable/Setup DAT parsing (no physics sim) |
| Chorizite | `/home/wbterminal/WorldBuilder-ACME-Edition/external/chorizite` | client hooks/protocol only (native C++ physics, not reimplemented) |
| melt | `/home/wbterminal/WorldBuilder-ACME-Edition/external/melt` | research-only enums/structs |

Full file:line index in `cross-codebase-reference-index.md`.

---

## 8. Related existing docs & memory

**Repo design docs** (read before touching movement):
- `external/holtburger/docs/movement-animation-overhaul-plan-2026-05-26.md` — master plan, Waves 1-7, root-cause bugs, retail refs
- `external/holtburger/docs/wave-2-diagonal-composition-2026-05-26.md` — diagonal forward+sidestep slots
- `external/holtburger/ARCHITECTURE.md` — world-owned runtime state / physics authority threading
- `external/holtburger/HANDOFF.md` — camera/movement workstreams A-G

**Memory entries** (`~/.claude/projects/-home-wbterminal/memory/`):
- `project_movement_overhaul_done_2026-05-26.md` — 421f82f2 waves
- `project_wave3f_done_2026-05-19.md` — pure-prediction shadow, 5/5 PASS maxDrift 0.04-0.09 m
- `project_wave3a_done_2026-05-19.md` / `project_wave3bc_done_2026-05-19.md` — physics-replay infra, jump formula
- `project_holtburger_jump_done_2026-05-16.md` — ACE GetJumpHeight + Jump 0xF61B wire
- `project_holtburger_entity_collision_done_2026-05-16.md` — cylinder collision + PhysicsState
- `project_academy_rubberband_diagnosis.md` — indoor collision history
- `reference_wire_agent_mode.md` / `reference_wire_agent_diag_layer.md` — how to run a headless diag client

---

## 9. Suggested next step

Gap **#1** (integration loop) is the highest-impact, lowest-risk, fully source-grounded fix and unblocks honest A/B testing of everything else. Start there — the ready-to-run prompt is in `PROMPTS.md §1`. After #1, do an off-screen 1070 capture to resolve the §6 open questions before tuning speeds (#2/#5).
