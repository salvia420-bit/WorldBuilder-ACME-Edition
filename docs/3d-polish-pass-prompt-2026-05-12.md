# 3D Polish Pass — Multi-Session Prompt Doc

**Authored:** 2026-05-12 (post-skybox push).
**Audience:** team of agents picking up cohesion fixes after the camera/movement push and the skybox push both shipped. Workstreams here are grouped into sessions; each session is sized to land in one coherent push (similar to the camera push's A-G or skybox push's Sky-A-H), but the doc as a whole spans 2-4 sessions.
**Status:** planning doc. No code changes here. Earlier docs are now load-bearing references — do NOT duplicate their content; cite + carry forward.

---

## Context

### What this project is

Holtburger is a browser-playable Asheron's Call client. The 3D viewport (Phases 7.0 → 7.7 + the 2026-05-11 camera-movement push + the 2026-05-11 skybox push) is feature-flagged via `?renderer=3d`. The 2D PIXI path remains the default. This doc closes the next round of cohesion gaps before we promote the 3D path.

### Load-bearing reference docs (read these first — do NOT duplicate)

- **`docs/3d-port-state-2026-05-10.md`** — canonical state doc. Has long-form per-workstream descriptions for BOTH the camera push (Workstreams A-G) and the skybox push (Workstreams Sky-A-G + Sky-I-A/B/C correction). Treat as source-of-truth state.
- **`external/holtburger/HANDOFF.md`** — operational handoff (post Sky-I). Has "Open follow-ons" + "What's still deferred" + "Direction forward" lists; this doc inherits them.
- **`docs/3d-camera-game-feel-fix-prompt.md`** — prior prompt doc. **Template style for this doc.**
- **`external/holtburger/docs/sky-i-probe-2026-05-11.md`** — investigation-style memo, ~280 lines. Useful style reference for the empirical-probe workstreams below.
- **`docs/emit-dynamic-site.md`** — partially stale (last refresh ~2026-05-09) but still the load-bearing design-intent record. Grep for specific topics; don't read end-to-end.

### What just shipped

Two pushes landed on `external/holtburger` master:

- **Camera/movement push** (commits `2aa39d4` → `87aef38`, Workstreams A-G + F follow-on): wasm exports for local-player events + 30 Hz position; client-side prediction in 3D follow camera; wasm-backed camera collision; camera-relative WASD + auto-turn (math); local-player rig render; live e2e capture. Per-workstream unit tests all green; live eye-tests on Developer-promoted account still deferred.
- **Skybox push** (commits `ed4d227` → `59e6cbc`, Workstreams Sky-A-H + Sky-I-A/B/C correction): retail-AC parametric skybox to `?renderer=3d`. Dome with time-of-day variation eye-test PASS. Sun-mesh-visible eye-test still PARTIAL — Sky-J carry-forward (celestial depth-test occlusion).

Test baselines: `cargo test --workspace` 1274/0/1; `node smoke_test.cjs` 157/0/1; `capture_skybox_e2e.cjs` 17/18; `capture_3d_movement_e2e.cjs` 11/11; phase7 captures all green.

---

## Two reported live issues (the headlines)

These are the user-observed live behaviors that motivated this doc. Quoted verbatim — do not embellish.

### Issue 1 — Animation cohesion in motion

> "The character animation is perfect when in a static pose, but it breaks apart when moving, when it should stay cohesive and bonded. The static pose is very good."

**What we know:** The rig builder (Phase 7.4a/7.4b) and EntityCycleSet (per-stance keyframe bake, motion-table fps) ship correctly per Phase 6 baseline. The rig PARTS spawn correctly and pose correctly. Decoherence is movement-triggered.

**Concrete starting points for investigation:**

- `apps/holtburger-web/scene3d/entities.js:163-204` — `EntityInstance` motion state machine + `crossFadeTo` method (crossFade interval default `0.15s`).
- `apps/holtburger-web/scene3d/entities.js:89-102` — motion-command category mapping (where stance transitions get classified).
- `apps/holtburger-web/scene3d/animation.js` — `buildAnimationClip` + `AnimationCache`.
- `apps/holtburger-web/scene3d/loop.js` — `dispatchOne` MOTION_COMMAND handler.
- `crates/holtburger-world/src/state/motion_resolution.rs` — `PlayerMotionTableResolution` struct (wasm-side resolution of motion-command IDs to keyframe sets).
- `apps/holtburger-web/src/lib.rs::fetch_entity_animation_keyframes` — wasm export Phase 7.4b uses to fetch baked clips on demand.

**Working hypothesis (UNVERIFIED — needs probe):** Either (a) `crossFadeTo` interval (0.15s) is too tight for the keyframe arrival cadence so the rig is mid-blend when the next motion command lands, OR (b) motion-command category mapping (`entities.js:89`) misclassifies locomotion stance transitions, loading the wrong keyframe set so per-bone hierarchies decohere as parts pick from different clips.

### Issue 2 — WASD partial (forward/back works; strafe + rotate don't)

> "WASD controls etc, it currently can move forward and backwards, but doesn't seem to be able to rotate left or right, or strafe."

**What we know:** Workstream D of the camera push landed camera-relative WASD + auto-turn-to-align math; `test_workstream_d_camera_relative.mjs` is **11/11 PASS**. So the JS-side math handling A/D strafe + Q/E rotate is correct in isolation. Live behavior disagrees — forward/back drive the integrator but strafe + rotate don't produce visible motion.

**Concrete starting points for investigation:**

- `apps/holtburger-web/scene3d/loop.js` — keyboard event listeners (WASD keystate maintained per rAF).
- `apps/holtburger-web/scene3d/camera.js:430-545` — `computeMovementFromKeys` method signature + A/D/Q/E axis mapping.
- `apps/holtburger-web/src/lib.rs` — `setMovementInput` wasm export, dispatches into the integrator.
- **`crates/holtburger-world/src/state/self_movement.rs:225-290`** — `optional_turn_left_omega` / `optional_turn_right_omega` resolution checks. **This is the strongest lead.**

**Working hypothesis (UNVERIFIED — needs probe):** This is structurally identical to Workstream G's PlayerTeleport bug from the camera push (commit `24790fb`). JS dispatches `setMovementInput(forward, strafe, turn)` correctly; wasm-side integrator silently gates strafe + turn inputs while accepting forward/back. Likely site: a `if` gate in `self_movement.rs:225-290` that drops `optional_turn_*_omega` when some runtime-pose precondition isn't met. Same "math passes unit test, integrator silently rejects in live" pattern as PlayerTeleport.

---

## Open follow-ons surface (inherited)

This doc inherits the open-followons lists from `HANDOFF.md` and `docs/3d-port-state-2026-05-10.md`. Each session's workstreams pull from this surface — citations are by `HANDOFF.md` line where applicable.

**Animation / Motion / Stance:**
- E real-backtick stance keypress (`HANDOFF.md:213`) — rig-side capability is wired (verified via `em.setMotion(stance=0x3E)` direct call); the `` ` `` keypress reaching the 3D path's stance handler is unverified. Likely keybinding plumbing.

**Movement / Camera:**
- Integrator overshoot 25 m/s vs 4.5 m/s target — F capture bullet 9 detects + accepts. Per-tick velocity tracing needed.
- C-prime live eye-test (Holtburg building interior camera no-clip) — Developer account needed.
- D mouse-look live eye-test — math passes 11/11; live feel unverified.
- Cross-continent `@telepoi Yaraq` — fresh accounts lack `@telepoi` privilege; Workstream G's teleport fix is mechanically equivalent.

**Sky / Celestial (the Sky-J carry-forward):**
- Celestial depth-test fix — sun mesh geometrically in-frame at t=0.05 but not painted; dome at radius 1000 with `depthWrite=true` depth-test-rejects celestials at vertex distance 2700. Three concrete options documented in `HANDOFF.md:33`: (1) `gl_FragDepth=1.0` in dome shader; (2) celestial `depthTest=false + renderOrder>-1`; (3) celestial re-architecture to dome-radius vertex coords.
- Pitch-curve retail screenshot comparison — `sin(p·π)·(π/2)` is derived, not DAT-sourced; tune in `crates/holtburger-world/src/sky.rs::evaluate_sky_object` if eye-test reveals altitude bias.
- Properties bit refinement — `0x01 ADDITIVE_BLEND` (LOW) + `0x04 WEATHER_STREAK` (MED) want Rainy/Clear/Cloudy DayGroup eye-tests.
- Mesh-swap exerciser — retail Dereth's `replace.gfx_obj_id == 0` everywhere; mechanism ready for non-retail data.

**Infrastructure / Perf:**
- Cargo `target/` (~40 GB on `/`) — `/` at 97% / 4.2 GB free; `cargo clean` recovers 40 GB (~15 min rebuild cost).
- Workstream-E backlog-replay chunking — `installSharedDrainHook` replays ~350 entity events synchronously at end of init3D (~+13s); production pop-in for ~30-50s under heavy NPC counts.
- F headed-browser path-(a) verification — confirms wasm tick rate is 60 Hz when not Playwright-headless-throttled.

**Skybox alternative experiments (modular path):**
- PNG-skybox swap toggle — the Sky-I refactor isolated the dome material to a single replaceable component. URL-flag-toggle to a `MeshBasicMaterial({ map: pngTex, side: BackSide })` is a 15-30 min experiment, 1-2 hours polished. Could land as a Session-2 sidebar workstream if time-of-day-blended PNG skyboxes are the path forward.

---

## Session plan

The total scope below is 2-4 sessions, each shaped like a single coherent push (A-G or Sky-A-H style). Workstreams within a session are dependency-ordered; sessions themselves are sequential (Session 2 builds on Session 1).

### Session 1 — Cohesion (animation + WASD)

The two headline reported issues, plus the closely-related Sky-J celestial depth fix. **5 workstreams.**

| | Workstream | Touches | Deps | Effort |
|---|---|---|---|---|
| **Cohere-A** | Empirical probe: animation decoherence | Read-only investigation + `?animdebug=1` instrumentation. Output: memo at `external/holtburger/docs/cohere-A-animation-probe-2026-05-12.md` with concrete root cause (crossFade timing / category mapping / motion table) + recommendation for Cohere-B. | — | medium |
| **Cohere-B** | Animation cohesion fix | Apply Cohere-A's recommendation. Likely lands in `scene3d/entities.js` + possibly `crates/holtburger-world/src/state/motion_resolution.rs`. Verify via live capture: hold W for 5s, screenshot the rig at peak motion, eye-test cohesive. Unit test: motion-command dispatch under simulated keyframe-arrival cadence. | Cohere-A | medium |
| **Cohere-C** | Empirical probe: WASD strafe + rotate gate | Read-only investigation. Trace JS keystate → `setMovementInput` → wasm integrator. Confirm OR refute the `self_movement.rs:225-290` gate hypothesis. Output: memo at `external/holtburger/docs/cohere-C-wasd-probe-2026-05-12.md`. | — | small |
| **Cohere-D** | WASD strafe + rotate fix | Apply Cohere-C's recommendation. Likely a wasm integrator gate similar to PlayerTeleport's missing `set_teleport_sequence` + `suspend_runtime_bodies` (commit `24790fb` shape). Verify via live capture: hold Q, observe heading change; tap A, observe lateral motion. | Cohere-C | small-medium |
| **Cohere-E** | Sky-J: celestial depth-test fix | Sky-I-C carry-forward. Pick option (1) `gl_FragDepth=1.0` in dome shader, (2) celestial `depthTest=false + renderOrder>-1`, or (3) celestial re-architecture to dome-radius coords. Verify: refresh `capture_skybox_demo.cjs`, sun mesh visible in `02-foredawn-sun-rising.png`. | — | small-medium |

Estimated wall-clock: 8-15 hours of agent work. Phasing: Cohere-A + Cohere-C + Cohere-E start in parallel (independent investigations); Cohere-B + Cohere-D launch after their respective probes.

### Session 2 — Live eye-tests under Developer-promoted account

The deferred-eye-test bullets that need `<account>/<account>`. Headed-browser path-(a) verification on F capture. **3-4 workstreams.**

| | Workstream | Touches | Deps | Effort |
|---|---|---|---|---|
| **Eye-A** | Developer-account live session orchestrator | Single capture (or manual + screenshot pack) that logs in as `<account>/<account>`, drives the deferred eye-tests in one continuous session: (i) C-prime hillside camera pull-in; (ii) D mouse-look pan + auto-turn feel; (iii) Cross-continent `@telepoi Yaraq` after `@telepoi Holtburg`. Output: 1-page report + screenshot pack. | Cohere-D (so WASD works for the walking part) | medium |
| **Eye-B** | F headed-browser path-(a) | `capture_3d_movement_e2e.cjs` bullet 7 path-(a) verification. xvfb/VNC-based or actual desktop. Confirms wasm tick rate is 60 Hz when not Playwright-headless-throttled. | — | small |
| **Eye-C** | Skybox properties bit refinement | `setGameDayOverride(day, year)` to force Rainy / Clear / Cloudy DayGroups; eye-test `0x01 ADDITIVE_BLEND` (LOW conf) + `0x04 WEATHER_STREAK` (MED conf) under headed browser. Update memory entry `project_holtburger_skybox_properties_flags` with refined confidences. | Cohere-E (sun visible needed) | small |
| **Eye-D** | Backtick stance keypress live | Verify `` ` `` keypress reaching 3D path's stance handler. May need keybinding plumbing fix in `loop.js` keyboard listener. | Cohere-D | small |

Estimated wall-clock: 4-8 hours, much of it human-eye observation.

### Session 3 — Production performance + cleanup

Backlog-replay chunking, integrator overshoot root-cause, disk pressure. **3 workstreams.**

| | Workstream | Touches | Deps | Effort |
|---|---|---|---|---|
| **Perf-A** | Backlog-replay chunking | `installSharedDrainHook` synchronous `[workstream-E] replaying 350+ pre-init3D entity events` burst chunked into rAF batches. Cuts production pop-in from ~30-50s to ~5-10s. | — | medium |
| **Perf-B** | Integrator overshoot root-cause | Per-tick `world.player.runtime_body.velocity` tracing across the W-release window. Identify dt-scaling vs damping-miss vs Playwright-artifact. Either fix the integrator or close the F bullet 9 follow-on as "Playwright-only artifact." | — | medium |
| **Perf-C** | Disk pressure plan | Either move repo to `/mnt/wbterminal1` with symlink back (HANDOFF's prior recommendation) OR document a `cargo clean` cadence + accept the 15-min cold rebuild. `/` is at 97% / 4.2 GB free as of this doc's authoring. | — | small |

Estimated wall-clock: 4-8 hours.

### Session 4 (optional sidebar) — PNG skybox modularity experiment

Demonstrates the Sky-I refactor's modularity by swapping the dome material for a `MeshBasicMaterial({ map: equirectPngTex, side: BackSide })`. URL toggle, 2-3 sample images, optional time-of-day cross-fade. **1-2 workstreams.**

Estimated wall-clock: 1-3 hours. Could land as a single-session experiment if Session 1 finishes early.

---

## Per-workstream specs

### Cohere-A — Empirical probe: animation decoherence

**Owner profile:** comfortable with three.js `AnimationMixer` / `SkeletonHelper`; able to instrument JS-side with debug overlays; willing to capture short video clips of the issue.

**Problem.** User-reported live behavior: static pose is cohesive (head/torso/limbs bonded correctly); during walking/running the rig "breaks apart." Need to identify subsystem before fixing.

**Approach (sequential):**

1. **Reproduce live.** Login, spawn, teleport to Holtburg, hold W for 5s. Visual confirmation the rig decoheres. Capture screenshot at peak motion + a 2-3 second screen-capture if possible (xdotool / `recordmydesktop` are options — output to `/mnt/wbterminal1/holtburger-captures/cohere-a/`).
2. **Instrument with `?animdebug=1`.** Add a JS-side overlay in `scene3d/entities.js` that, when the URL flag is set, draws a `THREE.SkeletonHelper` per entity AND logs per-frame: `(entityGuid, currentMotionId, mixerTime, activeClipName, crossFadeProgress)`. Same `?skydebug=1` pattern Sky-I-A used.
3. **Probe wasm side.** Add a temporary `[anim-trace]` log in `crates/holtburger-world/src/state/motion_resolution.rs::PlayerMotionTableResolution::resolve` that prints `(input_motion_command, resolved_clip_id, stance)` per call. Walk for 5s with `?animdebug=1`; correlate JS-side clip changes with wasm-side resolution events.
4. **Identify decoherence mechanism.** Three candidate causes — disambiguate empirically:
   - **(a) CrossFade timing:** if `crossFadeProgress` stays partway (e.g. 0.4) for extended intervals during locomotion, the rig is mid-blend when each new MOTION_COMMAND lands. Look for "crossFadeProgress never reaches 1.0 during W-hold."
   - **(b) Category misclassification:** if `motion-command category mapping` (`entities.js:89`) routes a single keypress through multiple stance transitions per frame, the rig flip-flops between clip sets. Look for "active clip name oscillates between two values per second."
   - **(c) Keyframe bake desync:** if the rig's per-bone keyframes were baked at fps=30 but the mixer ticks at 60Hz (or vice versa), bones drift relative to each other. Look for "per-bone position deltas exceed expected envelope."
5. **Write memo** at `external/holtburger/docs/cohere-A-animation-probe-2026-05-12.md` covering: which of (a/b/c) is the cause (with concrete probe-output excerpts), confidence, recommended fix shape for Cohere-B, alternative fixes if Cohere-B's choice doesn't pan out.

**Verification:** the memo's "which subsystem is broken" answer must be supported by a concrete probe excerpt — no hand-waving.

**Dependencies:** none.

---

### Cohere-B — Animation cohesion fix

**Owner profile:** same as Cohere-A; ideally same agent for context continuity.

**Problem.** Apply Cohere-A's recommendation.

**Files (depends on Cohere-A's findings):**

- If (a) crossFade timing: `scene3d/entities.js::crossFadeTo` interval tuning + possibly a "wait for prior crossFade to settle" gate.
- If (b) category misclassification: `entities.js:89` motion-command category map; possibly the wasm-side category emitter.
- If (c) keyframe bake desync: `crates/holtburger-world` motion-table fps reading; possibly `scene3d/animation.js::buildAnimationClip` time-base normalization.

**Verification:**

1. Reproduce the original live behavior pre-fix — confirm the original issue.
2. Apply the fix.
3. Re-run the live capture; rig stays cohesive over 5s W-hold.
4. Unit test in `test_workstream_b_prediction.mjs` style: simulate the failure mode (rapid motion-command dispatch, mismatched fps, or category-stutter) and assert the rig output stays valid.
5. No regression in `capture_phase7_4_entities.cjs`.

**Dependencies:** Cohere-A.

---

### Cohere-C — Empirical probe: WASD strafe + rotate gate

**Owner profile:** comfortable with the wasm `MovementSystem::tick` integrator path; reads ACE log + wasm console traces.

**Problem.** Forward/back work; strafe (A/D) + rotate (Q/E) don't produce visible motion. Workstream D's unit test (`test_workstream_d_camera_relative.mjs` 11/11) covers the JS-side rotation math; the gap is downstream.

**Approach (sequential):**

1. **Trace JS-side dispatch.** Add a `[wasd-trace]` console.log in `scene3d/camera.js::computeMovementFromKeys` that dumps `(forward, strafe, turn, run)` per call. Hold A for 1s, hold Q for 1s, observe the values.
2. **Trace wasm-side entry.** Inspect `setMovementInput` in `apps/holtburger-web/src/lib.rs`. Confirm strafe + turn values land in the recv queue.
3. **Trace wasm-side consumption.** Add a temporary `[movement-trace]` log in `crates/holtburger-world/src/state/self_movement.rs` around lines 225-290 (`optional_turn_left_omega` / `optional_turn_right_omega`). Dump `(input_strafe, input_turn, optional_turn_left_omega.value, optional_turn_right_omega.value, runtime_body.lateral_velocity)` per tick.
4. **Identify gate.** Look for a precondition that's failing only for strafe + turn but not for forward. The pattern from Workstream G (PlayerTeleport) was a missing `set_teleport_sequence` + `suspend_runtime_bodies(TeleportOrWorldReset)` in the recv-loop arm; the equivalent here may be a missing `set_lateral_drive_enabled` or `set_rotation_drive_enabled` somewhere in the integrator init or per-tick dispatch.
5. **Write memo** at `external/holtburger/docs/cohere-C-wasd-probe-2026-05-12.md` with concrete trace excerpts + the identified gate + recommended fix for Cohere-D.

**Verification:** the memo's "which line gates strafe/turn" answer must be supported by a trace excerpt showing the gate engaging.

**Dependencies:** none.

---

### Cohere-D — WASD strafe + rotate fix

**Owner profile:** Rust + wasm-bindgen; comfortable with `tokio` async + `MovementSystem` internals.

**Problem.** Apply Cohere-C's recommendation. Almost certainly a small wasm-side patch mirroring how the cli or PhatAC handles the same drive path.

**Verification:**

1. Reproduce the original live behavior pre-fix (no strafe, no rotate).
2. Apply the fix.
3. Hold Q for 1s, observe heading rotates ~1.5 rad/s (`RUN_HELD_TURN_SPEED_RAD_PER_SEC`).
4. Tap A and D, observe lateral motion in the expected direction.
5. Walking + mouse-pan: auto-turn-to-align engages (D's auto-turn math should now be live).
6. `cargo test --workspace`: at least 1274/0/1; add a regression test that asserts the gate Cohere-C identified is now permissive.
7. No regression in `capture_3d_movement_e2e.cjs` (still 11/11) or `capture_academy_rubberband.cjs` (2D path).

**Dependencies:** Cohere-C.

---

### Cohere-E — Sky-J: celestial depth-test fix

**Owner profile:** three.js shader-aware; comfortable with renderer state machine + depth-buffer semantics.

**Problem.** Sky-I-B's separate `skyScene` + `skyCamera` render pass renders the sky cell correctly — celestial meshes are at correct world positions inside `skyCamera.far=50000`. But the dome (radius 1000, `depthWrite=true`) writes depth values close to the camera; celestials at vertex distance ~2700 fail `LEQUAL` depth-test against the dome.

**Three concrete options** (per `HANDOFF.md:33`):

1. **`gl_FragDepth = 1.0` in dome shader.** Force dome fragments to maximum depth; celestials pass `LEQUAL` against `1.0` cleanly. Requires WebGL2 (most browsers have this). One-line shader change.
2. **Celestial `depthTest = false + renderOrder > -1`.** Disable depth-test on celestial meshes; rely on three.js render order. Cleaner but loses celestial occlusion against each other if multiple overlap.
3. **Celestial re-architecture to dome-radius vertex coords.** Rebake the celestial meshes (or transform them at load time) so their vertex distances are <= 1000 (matching dome radius). Most invasive but eliminates the depth conflict by construction.

**Sky-I-C's history:** tried (2) with `renderOrder=2`, broke dome rendering in different ways under swiftshader; reverted. (1) is the recommended next attempt.

**Verification:**

1. Apply the chosen fix.
2. Refresh `capture_skybox_demo.cjs`. Inspect `02-foredawn-sun-rising.png` for visible sun mesh.
3. Confirm no regression in dome time-of-day variation (the eye-test that Sky-I-C already achieved).
4. Sky-F bullet 12 (`celestial children at dawn`) and bullet 15 (`pixel-hue histogram`) stay PASS.
5. Test in BOTH headless and (if available) headed browser — Sky-I-C found swiftshader had its own depth quirks.

**Dependencies:** none (independent of Cohere-A through D).

---

(Session 2 + Session 3 + Session 4 workstream specs are intentionally less detailed — they'll be filled in when those sessions launch, informed by what Session 1 actually reveals.)

---

## Grounding & resources

### Files and well-known locations

Same as prior pushes — see `docs/3d-port-state-2026-05-10.md`'s "Architecture" section. New since the skybox push:

- **Sky-J carry-forward:** options listed in `external/holtburger/HANDOFF.md:33`.
- **Sky-I probe memo:** `external/holtburger/docs/sky-i-probe-2026-05-11.md` — template for the Cohere-A and Cohere-C probe memos.
- **Sky-I instrumentation pattern:** `?skydebug=1` URL flag (in `scene3d/sky_dome.js`) — same shape for `?animdebug=1` (Cohere-A) and `?wasdtrace=1` (Cohere-C).

### Live stack

ACE on UDP 9000; wsbridge on 8080; cloudflared tunnel; web proxy on 7080; Tailscale `<server-ip>:7080`. See HANDOFF.md.

### Test character

Fresh per-run timestamped accounts per `capture_academy_rubberband.cjs` pattern. `<account>/<account>` (dev-promoted) reserved for Session 2's eye-tests.

### Memory & feedback discipline (load-bearing — read before deviating)

- **`feedback_test_fixtures_real_data`** — real `client_portal.dat`, not synthetic.
- **`feedback_ground_in_real_wire_data`** — probe + traces before code changes. Cohere-A + Cohere-C are explicit probe phases for this reason.
- **`feedback_no_partial_demos`** — if a probe is inconclusive, document the gap rather than ship a speculative fix.
- **`feedback_attribution_precision`** — user's verbatim quotes preserved in this doc's "Two reported live issues" section. Don't embellish.
- **`project_holtburger_envcell_vs_building`** — load-bearing for any collision work.
- **`project_holtburger_skybox_done_2026-05-11`** + **`project_3d_camera_game_feel_done_2026-05-11`** — prior push state.

---

## Anti-patterns & out of scope

### Don't

- **Don't blow up the prior pushes.** Camera/movement push (Workstreams A-G) + skybox push (Sky-A-G + Sky-I) are load-bearing; this doc layers cohesion on top, doesn't rewrite.
- **Don't speculate without instrumentation.** Cohere-A + Cohere-C are explicit probe phases. The Sky-I push's success came from Sky-I-A's empirical-probe pattern — repeat it.
- **Don't bake to `/` or `/tmp`** — `/` at 97% / 4.2 GB free.
- **Don't conflate the two reported issues.** Animation cohesion (Issue 1) and WASD partial (Issue 2) have separate subsystems; don't write a fix that touches both unless the probe explicitly identifies a shared root cause.
- **Don't skip the live capture + eye-test.** Both reported issues are observed via the live tunnel; unit tests alone can't close them.

### Out of scope for this prompt

- Combat, spells, chat, inventory, networking layer. Cohesion + control fidelity only.
- Cutover from 2D PIXI to 3D as the new default. Separate decision after this doc's DoD ships.
- ACE-side changes. All fixes land in the wasm bundle or JS; ACE source isn't touched.

---

## Definition of Done (across all sessions)

**Session 1 DoD:**

1. Cohere-A memo committed and load-bearing for the fix.
2. Cohere-B fix landed; live capture shows the rig stays cohesive over 5s W-hold.
3. Cohere-C memo committed.
4. Cohere-D fix landed; live capture shows strafe + rotate produce visible motion.
5. Cohere-E sun mesh visible in `02-foredawn-sun-rising.png`.
6. `cargo test --workspace` + `smoke_test.cjs` baselines preserved or improved.
7. `capture_3d_movement_e2e.cjs`, `capture_skybox_e2e.cjs`, `capture_skybox_demo.cjs`, all phase7 captures green.
8. HANDOFF.md successor written for Session 1 closure.

**Session 2 DoD:** Developer-account eye-test report + screenshot pack; F headed-browser path-(a) PASS; properties bit confidences updated in memory.

**Session 3 DoD:** Backlog-replay pop-in < 10s under heavy NPC counts; integrator overshoot either fixed or closed-as-Playwright-artifact; disk plan documented or repo relocated.

**Session 4 DoD (optional):** PNG-skybox toggle works against 2-3 sample equirectangular images; optional cross-fade lerps cleanly across time-of-day.

When all sessions land, the 3D viewport graduates from "tech preview with visible-but-eye-test-deferred features" to "real third-person game client whose static + motion fidelity has been live-eye-tested end-to-end." That's the bar.
