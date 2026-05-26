# Movement + Animation Overhaul — Team Plan (2026-05-26)

**Scope:** `external/holtburger/apps/holtburger-web/` 3D renderer path. Fix Q/E direction; fix jump animation; wire missing locomotion MotionCommands (sidestep, turn-in-place, run-backward); make all stances animate correctly across the full input matrix; add stance-transition + remote-player swing fidelity; validate end-to-end on the 1070 Ti.

**Method:** 7 waves. Wave 1 (foundation fixes) must finish first because downstream waves depend on the corrected sign + the deleted airborne overlay. Waves 2–5 can run in parallel after Wave 1. Wave 6 validates each prior wave. Wave 7 is optional polish.

---

## Findings from the 5-agent audit (all source paths are `external/holtburger/apps/holtburger-web/` unless noted)

### Root-cause bugs

1. **Q/E direction inverted** at `src/lib.rs:20517-20521` (`motion_state_for_input`):
   ```rust
   if turn > 0 { builder = builder.turn_right(); }       // BUG: turn>0 is E, should be turn_left
   else if turn < 0 { builder = builder.turn_left(); }   // BUG: turn<0 is Q, should be turn_right
   ```
   JS at `scene3d/camera.js:1207` computes `qeTurn = (k.e ? 1 : 0) - (k.q ? 1 : 0)` (E=+1, Q=-1). Per AC retail convention (acclient.c) E = `TurnRight (0x6500000d)` and Q = `TurnLeft (0x6500000e)`. Wasm flips them.
   **Fix:** swap the two branches at `lib.rs:20517-20521`. Don't negate at the call site — keep the input layer clean.

2. **Jump animation freeze**: TWO systems race on jump.
   - Real motion-table Jump clip (`0x2500003B`) is in `ATTACK_COMMANDS` at `scene3d/entities.js:170-175`. Classifier routes it through `_tryPlayLink` (`entities.js:2897-2911`) which fetches and plays it as `LoopOnce`. ✓ Correct.
   - **BUT** `kind=18` (EntityAirborneChanged) fires `setAirborne(true)` at `entities.js:1580-1703` which **pauses the mixer** at `entities.js:2806` and overlays a quaternion arms-spread tween (Wave 3.B placeholder). The Jump clip sits frozen at frame 0; only the tween is visible.
   - **Fix:** delete the airborne tween entirely (`setAirborne`, `_applyHumanJumpPose`, `_clearHumanJumpPose`, `_applyGenericJumpPose`, `_clearGenericJumpPose` at `entities.js:1580-1703`; `_tickJumpPoseTween` at `entities.js:2748-2813`; recv-loop `kind=18` handler in `index.html:8469-8485`). Let the motion-table Jump clip + server-broadcast Jump command + physics z-velocity arc do the work, per retail.

### Locomotion coverage gaps

| MotionCommand | Value | Data present in MT 0x09000001 | Wired in classifier (entities.js:318-332) | Notes |
|---|---|---|---|---|
| WalkForward | 0x45000005 | yes (13 stances) | yes ("walk") | W key |
| WalkBackwards | 0x45000006 | yes (13 stances) | yes ("walk") | S key |
| RunForward | 0x44000007 | yes (13 stances) | yes ("run") | Shift+W |
| **SideStepLeft** | 0x65000010 | yes (13 stances) | **NO** | A key dispatched but no clip plays |
| **SideStepRight** | 0x6500000F | yes (13 stances) | **NO** | D key dispatched but no clip plays |
| **TurnLeft** | 0x6500000E | yes (13 stances) | **NO** | Q key turns yaw but no turn-in-place clip |
| **TurnRight** | 0x6500000D | yes (13 stances) | **NO** | E key turns yaw but no turn-in-place clip |
| Jump | 0x2500003B | yes (all stances) | yes ("attack") | Currently frozen by airborne overlay bug |
| **JumpCharging** | 0x4000001D | yes | **NO** | Pre-jump windup unused |
| **FallDown / Falling / Fallen** | 0x10000050 / 0x40000015 / 0x40000008 | yes | **NO** | Free-fall has no clip; tween used instead |

The renderer reads stance correctly into `AnimationCache.makeKey(setupId, mtableId, cmd, stance)` (`entities.js:2915`), so per-stance walk/run already differ. **Spot-check needed**: one agent flagged a possible hardcoded `default_movement_profile_for_stance(0x8000003D)` (NonCombat) in lib.rs — Wave 3 verifies and fixes if real.

### Combat + transition gaps

- **Remote-player swings** still use the vibe-pose `setSwingPose` (placeholder triangle-wave tween) instead of the real `setSwingMotion` clip. Path: `damageTaken` → `findGuidByName` → `setSwingPose`. Memory item `project_holtburger_combat_phase_d_done_2026-05-17.md` flagged this; the 70-LOC follow-on from `project_holtburger_motion_table_combat_path.md` covers it.
- **Charge-attack hold**: `classifyMotionCommandTyped` exposes `durationSec` but the hold-at-peak-frame logic is not wired. Charge-attack currently snaps through the swing without pausing.
- **Magic cast during locomotion**: prior agents confirm cast IS layered as an action over locomotion (correct per retail). Smoke-test only.
- **Weapon-draw/sheath**: per retail audit, AC retail does NOT play a discrete DrawSword clip on stance transition — modifier-stacking handles the visual blend. The MotionCommand enum has no top-level DrawSword. **Decision: do not add fake draw clips; instead add a short (150ms) crossfade on stance-Ready swap to match retail's blend feel.**

### Retail-canonical reference (for the implementation team)

| Behavior | Retail | Citation |
|---|---|---|
| Walk → Run | `apply_run_to_command`: `WalkForward(0x45000005)` + speed>0 → `RunForward(0x44000007)`; motion code changes, then scaled by `run_factor` | acclient.c:343439-343483 |
| Diagonal (W+D) | Independent simultaneous modifiers (`forward_command` + `sidestep_command`); no diagonal clip; geometric ~1.41× velocity | acclient.c:332759-332786 |
| Turn while moving (W+Q) | Independent simultaneous modifiers (`forward_command` + `turn_command`); both curves applied; no `TurnLeftWhileWalking` clip | chorizite InterpretedMotionState |
| Jump | Single `Jump` clip; physics modulates z-velocity via `get_jump_v_z(extent)` (extent = 0–1 charge factor); 500ms ramp is our guess, not retail | acclient.c:343343-343364 |
| Stance transition | Atomic `current_style` swap + `forward_command = Ready`; no explicit Draw clip; modifier-stacking blends | acclient.c:332771-332786 |
| Magic cast | Cast queued as action modifier (0x10000xxx); overlays under locomotion | acclient.c:332778-332779 |
| Server vs. client | Client predicts via `InterpretedMotionState`; server `UpdateMotion` is authoritative; client reconciles | ACE WorldObject_Networking.cs:1306+ |

---

## Wave 1 — Foundation fixes (must finish first)

**Agent assignment:** 1 implementation agent (general-purpose). Sequential phases.

### Phase 1.1 — Fix Q/E direction
- File: `src/lib.rs:20517-20521`
- Swap the two branches of the turn sign check in `motion_state_for_input`.
- Validation: `cargo check -p holtburger-web --target wasm32-unknown-unknown`; press Q in-game, observe player rotates left (CCW from above); E rotates right.

### Phase 1.2 — Delete airborne tween, let Jump clip drive
- Files: `scene3d/entities.js:1580-1703` (delete `setAirborne` + 4 pose helpers); `scene3d/entities.js:2748-2813` (delete `_tickJumpPoseTween`); `scene3d/entities.js:2214` (delete the tween-tick call); `index.html:8469-8485` (delete `kind=18` recv handler).
- Optionally remove `setAirborne` callers in wasm `src/lib.rs` if they exist (search for `EntityAirborneChanged` event emission). Keep the `is_airborne` physics state — only the **visual overlay** dies.
- Validation: jump in-game; observe the motion-table Jump clip plays end-to-end (crouch → launch → apex → land) instead of the arms-spread freeze.

### Phase 1.3 — Wire SideStep / Turn-in-place classifier
- File: `scene3d/entities.js:128-178`
- Add constants `CMD_LOW_SIDESTEP_LEFT = 0x0010`, `CMD_LOW_SIDESTEP_RIGHT = 0x000F`, `CMD_LOW_TURN_LEFT = 0x000E`, `CMD_LOW_TURN_RIGHT = 0x000D`.
- Extend `classifyMotionCommand` (entities.js:318-332): return `"walk"` for sidestep/turn (so they dispatch as cyclic locomotion).
- Validation: hold A; UpdateMotion(SideStepLeft) arrives; classifier returns "walk"; AnimationCache fetches the sidestep clip from MotionTable.cycles.

### Phase 1.4 — Verify wasm dispatches sidestep/turn MotionCommands
- File: `src/lib.rs` (search for `motion_state_for_input` and the MotionStateBuilder usage)
- Trace what command the wasm sends to ACE when `strafe=+1` (D held) or `turn=-1` (Q held after Phase 1.1 fix). It MUST be `SideStepRight (0x6500000F)` / `TurnLeft (0x6500000E)` — not just yaw integration.
- If currently absent (likely: the wasm probably only adjusts heading), add `MotionStateBuilder::side_step_left/right()` + `turn_left/right()` calls in `motion_state_for_input`.
- Validation: `__diag.motion.snapshot(localGuid)` shows the right MotionCommand in history when A or Q held.

**Wave 1 exit gate:** Q/E rotate correctly; spacebar plays the real Jump clip; A/D/Q/E generate the correct MotionCommand wire packets per `__diag.motion`.

---

## Wave 2 — Locomotion coverage expansion

**Agent assignment:** 1 implementation agent. Depends on Wave 1.

### Phase 2.1 — Backpedal-run + sidestep-run
- Verify whether MT 0x09000001 has `RunBackward` and run-speed sidestep entries (use WB.Terminal skill at `~/.claude/skills/worldbuilder-terminal/`).
- If yes: extend `apply_run_to_command` parity in `src/lib.rs` — `WalkBackwards + Shift` → `RunBackward`, `SideStepLeft + Shift` → run-sidestep variant.
- If no (retail doesn't have these): cap sidestep at walk speed even with Shift, matching retail's ±3.0 sidestep clamp (acclient.c:343475).

### Phase 2.2 — Diagonal composition validation
- Per retail: W+D = simultaneous `forward_command=WalkForward` + `sidestep_command=SideStepRight`, blended geometrically.
- Audit `motion_state_for_input` in `src/lib.rs`: does the current MotionStateBuilder support emitting BOTH forward AND sidestep in one MotionState? If not, extend it.
- Validation: hold W+D; `__diag.motion.snapshot` shows both commands active simultaneously; visual: player moves diagonally at ~1.41× speed with both clips playing (sidestep arms + walk legs blend via three.js mixer's weight system, or layered actions with `play()` on both).

### Phase 2.3 — Walk→Run transformation parity
- File: `src/lib.rs` `motion_state_for_input`
- Implement retail `apply_run_to_command`: when `forward=+1` AND `run=true`, emit `MotionCommand::RunForward` (0x44000007), not `WalkForward` with a speed multiplier. The motion code itself must change so the motion-table fetches the run clip, not a sped-up walk clip.
- Validation: hold W (no shift) → UpdateMotion(WalkForward); hold Shift+W → UpdateMotion(RunForward); `__diag.motion` confirms.

### Phase 2.4 — Turn-in-place dispatch gating
- Only fire `TurnLeft`/`TurnRight` MotionCommands when `forward=0` AND `strafe=0` (i.e., player is stationary turning).
- When moving + turning (W+Q): emit `WalkForward` and let the wasm integrator apply yaw delta to heading without a separate turn-in-place clip — retail blends turn into the walk via modifier-stacking, not a separate clip slot.

**Wave 2 exit gate:** All 8 cardinal + 4 diagonal directions produce the correct MotionCommand and clip per direction; Walk↔Run swap via Shift; turn-in-place only when stationary.

---

## Wave 3 — Stance-aware locomotion

**Agent assignment:** 1 implementation agent. Depends on Wave 1, can parallel with Wave 2.

### Phase 3.1 — Audit stance threading
- Grep `src/lib.rs` for `default_movement_profile_for_stance`. If it hardcodes `0x8000003D` (NonCombat), find the call sites and route the actual player stance instead.
- Grep `scene3d/` for any hardcoded stance fallback in AnimationCache or fetch paths.
- Validation: switch player to SwordCombat stance, walk; `__diag.motion.snapshot` shows `cmd=WalkForward stance=0x8000003E`; visually distinct from NonCombat walk.

### Phase 3.2 — Per-stance regression matrix
- Write `external/holtburger/apps/holtburger-web/test_ac_locomotion_per_stance.mjs`.
- For each stance ∈ {NonCombat, HandCombat, SwordCombat, BowCombat, SwordShieldCombat, Magic, ThrownWeaponCombat, DualWieldCombat}, fetch `MotionTable.cycles[(stance, WalkForward)]` and assert non-null + distinct anim DID from NonCombat.
- Run via `node external/holtburger/apps/holtburger-web/test_ac_locomotion_per_stance.mjs`.

### Phase 3.3 — Stance-transition crossfade
- File: `scene3d/entities.js:2820-2920` (setMotion dispatch on Ready substitution)
- When the stance changes (compare `inst.lastStance` vs. new stance), apply a 150ms crossfade on the Ready cycle swap instead of hard-cut. Match retail's modifier-stacking blend feel without a discrete Draw clip.
- Validation: toggle stance via backtick key; visually, the weapon-up pose blends in over ~150ms rather than snap-popping.

**Wave 3 exit gate:** Walking in each stance produces a stance-unique clip; stance transitions blend instead of snap.

---

## Wave 4 — Combat-animation fidelity

**Agent assignment:** 1 implementation agent. Depends on Wave 1.

### Phase 4.1 — Remote-player real-clip swings
- Files: `scene3d/entities.js:1721-1729` (findGuidByName path on damageTaken)
- Replace `setSwingPose` with `setSwingMotion(guid, motion, durationSec)`. The motion ID comes from the `damageDealt`/`damageTaken` server broadcast — if not currently carried on the wire, fall back to `WeaponSkill`→default attack motion per AttackType (already wired for local).
- Validation: NPC attacks player; `__diag.motion.snapshot(npcGuid)` shows the real swing clip key, not the vibe-pose key.

### Phase 4.2 — Charge-attack hold-at-peak
- Files: `scene3d/picking.js:802-808` (charge cancel); related charge state in `entities.js`
- During charge: play the swing clip up to its peak frame (use `durationSec * 0.5` as approximation OR find an exposed `hookTime` from MotionData hooks), then pause `mixer.time` at that frame. On release, resume from peak frame to end.
- Validation: hold left-click in HandCombat; arms hold at peak windup; release; swing completes.

### Phase 4.3 — Magic cast during locomotion smoke
- Confirm cast actions layer correctly over walk/run cycles (current `playCastSequence` design suggests it does, but no regression test exists).
- Add a standalone test in `test_ac_cast_over_locomotion.mjs` that simulates Magic stance + WalkForward + cast trigger.

### Phase 4.4 — Combat-mode-cycle Ready-pose blend
- When `toggleCombatMode` lands a new UpdateMotion(Ready, newStance), apply the Phase 3.3 crossfade.

**Wave 4 exit gate:** Remote NPCs swing visibly with real clips; charge holds at peak; magic+walk overlays correctly.

---

## Wave 5 — Falling, landing, edge cases

**Agent assignment:** 1 implementation agent. Depends on Wave 1 (specifically Phase 1.2 deletion of airborne tween).

### Phase 5.1 — Falling state → motion-table cycle
- When wasm detects sustained vertical velocity downward without grounded contact (free-fall, not jump): emit `UpdateMotion(Falling, currentStance)`.
- The renderer fetches `MotionTable.cycles[(stance, Falling)]` as a looping cycle (replaces the deleted pose tween).
- Validation: walk off a ledge; player plays Falling cycle instead of T-pose-arms.

### Phase 5.2 — Land clip on touchdown
- On grounded transition (z-velocity flips from negative to ~0 with floor contact): emit `UpdateMotion(Land, currentStance)` as a one-shot.
- Validation: jump from height; on landing, see Land clip play once before returning to idle.

### Phase 5.3 — Mid-air horizontal control
- Per retail: horizontal velocity is preserved during jump (player can adjust mid-air slightly).
- Verify current wasm physics preserves horizontal input during `is_airborne`. If not, add a damped input integrator (5–10% input authority while airborne).

### Phase 5.4 — Fall-damage / god-mode interaction
- Memory `project_holtburger_godmode_falldamage.md`: persistent fall-damage bug in capture runs. Verify the new fall animation works with `/god` admin command (or document if not).

**Wave 5 exit gate:** Free-fall, landing, and mid-air control all behave correctly; no T-pose freeze on falls.

---

## Wave 6 — Diag, validation, and integration tests

**Agent assignment:** 1 validation agent. Runs incrementally as each prior wave lands, then final pass.

### Phase 6.1 — Extend `__diag.motion`
- Add per-stance × per-direction counter to `scene3d/diag/motion.js`.
- New accessor: `__diag.motion.coverageMatrix()` returns `{ stance: { motionCmd: playCount } }`.
- Validation: run the full input matrix (W, S, A, D, Q, E, W+A, W+D, S+A, S+D, Shift+each, Space at idle, Space during each direction); inspect `coverageMatrix()`; every cell that has a clip in MT 0x09000001 should have a play count >0.

### Phase 6.2 — Standalone test scripts
- `test_ac_locomotion_dispatch.mjs` — for each input combo, assert correct MotionCommand emitted.
- `test_ac_stance_transition_crossfade.mjs` — assert 150ms blend on stance Ready swap.
- `test_ac_jump_clip_plays.mjs` — assert mixer time advances during jump (would have caught the airborne-tween freeze).

### Phase 6.3 — Visual smoke (1070 Ti)
- Via SSH+reverse-tunnel to 1070 Ti per memory `reference_1070_ssh_access.md`.
- Run a Playwright-driven capture: spawn local player, cycle through full input matrix, screenshot at fixed frames per direction. Compare against retail reference (if available) or just visually inspect for T-pose / freeze.

### Phase 6.4 — ACE wire-conformance check
- Wave 1's `wave1_wire_conformance` infrastructure (memory `project_wave1_wire_conformance_done_2026-05-19.md`) has 24/24 pass. Add fixtures for the new MotionCommands wired in this overhaul (SideStep, TurnLeft/Right, Falling, Land) so future regressions catch wire-shape drift.

**Wave 6 exit gate:** Coverage matrix shows >0 plays for every wired (stance, direction) cell; all standalone tests pass; 1070 Ti capture shows correct animations.

---

## Wave 7 — Optional polish (only if time permits)

### Phase 7.1 — Walk-cycle phase preservation
- When user releases W then re-presses within ~200ms, resume walk cycle from previous mixer.time instead of restarting frame 0. Reduces foot-pop on quick stops.

### Phase 7.2 — Jump-charge UI feedback
- Memory mentions retuning the 500ms ramp. Add a thin power bar near the player when Space is held, similar to combat-bar's charge indicator. Keeps the player informed during the hold.

### Phase 7.3 — MotionData blend_time hints
- Audit MotionData.flags / bitfield for any blend-time hints in the parsed data. If retail motion tables carry per-link blend durations, plumb them through `AnimationCache.get` into the action's `crossFadeTo` duration argument (currently hardcoded to 0).

---

## Cross-cutting conventions (all waves follow these)

- **Validation cadence:** After every phase: `node --check <files>`, run any new `test_X.mjs`, `cargo check -p holtburger-web --target wasm32-unknown-unknown`.
- **Wasm build:** `wasm-pack build --target web --out-dir pkg --dev` from `apps/holtburger-web/`.
- **Diag-first telemetry:** Every new feature exposes counters under `__diag.motion.*` or a sibling area; no console.log spam in production code paths.
- **File:line citations:** Every doc claim and commit body should cite the source file + line.
- **Three-source cross-reference:** For any new claim about retail behavior, cite ACE + acclient.c + chorizite; favor acclient.c for client-side mechanics, ACE for server contracts.
- **Commit pattern:** `feat(holtburger-web): <wave-N-phase-X subject>` with multi-paragraph body (citations + validation result).
- **Disk pressure:** All scratch logs/screenshots/captures under `/mnt/wbterminal1/tmp/claude-scratch/movement-overhaul/`.

## Estimated wave size

| Wave | Phases | Surface | Risk |
|---|---|---|---|
| 1 | 4 | Foundation fixes (Q/E, jump, classifier, dispatch) | LOW — bugs are isolated and identified |
| 2 | 4 | Locomotion coverage expansion (sidestep, turn, run swap, diagonal) | MED — touches wasm MovementSystem |
| 3 | 3 | Stance-aware locomotion + crossfade | LOW — data already exists, just plumb it |
| 4 | 4 | Combat fidelity (remote swings, charge hold, magic+walk, stance Ready) | MED — touches multiple plugins |
| 5 | 4 | Falling/landing/mid-air control | MED — physics interactions |
| 6 | 4 | Diag + validation infrastructure | LOW — additive |
| 7 | 3 | Polish (optional) | LOW |

**Total: 26 phases across 7 waves.** Wave 1 is unblocking; Waves 2–5 parallelizable; Wave 6 runs incrementally; Wave 7 only on a "lift everything else first" trigger.

## Key citations (for fast reference during implementation)

- Input: `scene3d/camera.js:1198-1359` (computeMovementFromKeys); `index.html:7623-7712` (top-level keydown/keyup); `ui/keymap.js:33-234` (LOCAL_ACTIONS)
- Wasm dispatch: `src/lib.rs:20517-20521` (turn sign bug); `src/lib.rs:~26946` (call site); `src/lib.rs:20452-20458` (locomotion constants)
- Animation: `scene3d/animation.js:1-783` (AnimationCache); `scene3d/entities.js:128-178` (constants); `:318-332` (classifyMotionCommand); `:1580-1703` (airborne tween to delete); `:2820-2920` (setMotion dispatch); `:2897-2911` (_tryPlayLink)
- Diag: `scene3d/diag/motion.js:1-263`
- MotionCommand enum: `external/ACE/Source/ACE.Entity/Enum/MotionCommand.cs:8-80` (canonical); `crates/holtburger-dat/tests/common/motion_command_names.rs:25-435` (parser test symbols)
- Retail behavior reference: `~/ac-headers/acclient.c:332759-332786` (ApplyMotion); `:343343-343483` (apply_run_to_command + jump velocity)
