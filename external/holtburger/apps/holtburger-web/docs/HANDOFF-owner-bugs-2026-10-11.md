# Owner bug batch — handoff (2026-10-11)

The owner reported eight issues after playing the 8f65edbc build. One orchestrator and six agents worked
them in one session. The agents had laptop rules: read, edit and targeted `node` tests only. The
orchestrator ran every cargo, GPU-smoke, gate and wasm build, one at a time and capped. Nothing here has
been eye-tested. Section 9 is the batched 1070 queue.

| # | Owner report | Status | Escape |
|---|---|---|---|
| 1 | "always daylight outdoor option in hud doesnt seem to work" | fixed (JS) | uncheck the option |
| 2 | ragdoll "takes too long … as the user is waiting to loot the corpse … shreths" | fixed (JS) | `?ragdollRest=off`, `?handoffLoot=off` |
| 3 | scorch/blood "has a squarish pixelated effect on the ground" | fixed (JS/GLSL) | `?fxDecalSmooth=off` |
| 4 | NPCs "face away from me or 90 degrees from me" | fixed (Rust) | heading units fix has no flag; `?remoteMoveToBegin=off` |
| 5 | moon clouds "throttled … the inside is missing", "paintbrushy, like … jupiter", "more 3d" | fixed (JS/GLSL) | `?moonFx=off`, `?moonPhase=0..1` |
| 6 | "go in the air just a little tiny bit" on hilly terrain | see §6 | see §6 |
| 7 | sporadic slowdown "until i stop the movement and restart" | see §7 | see §7 |

## 1. Always daylight outdoors

- **Cause.** The Options checkbox (CharacterOption 0x05 = CharacterOptions2 `PersistentAtDay`) only reached the
  server. Nothing in the renderer read the bit.
- **Retail.** `LScape::SetDay` (acclient.c:306897) is applied at login (:452815) and on every option change
  (:452973). `set_landscape_lighting` (:307016) then lights the land from `CRegionDesc::GetLighting(0.5, …)`, which
  is Midsong (noon).
- **Fix.** `scene3d/always_daylight.js` is driven from index.html `pumpNetFrame`.
  - While the option is on, it pins the wasm sky evaluator to 0.5 with `setSkyTimeOverride`, the same sticky
    override `?skytime` uses.
  - It re-asserts the pin every 250 ms, because an EnteredWorld repopulate replaces the evaluator and drops it.
  - Turning the option off clears the pin once with NaN. A `?skytime` pin or accel cycle takes priority.
- **Deliberate difference from retail.** Retail left the sky dome on the real clock. Our atmosphere ties the sky to its
  sun, so the sky turns to day as well.
- **Not done.** "Disable distance fog" (0x30, retail `LScape::m_fFogEnabled`) and "Disable most weather effects"
  (0x04, retail `SmartBox::EnableWeather`) are not read by the renderer either. They are the same kind of gap and
  are left as a follow-up.
- **Test.** `tests/always_daylight.test.mjs`.

## 2. Death ragdoll → lootable corpse

- **Causes.**
  - `_tryCorpseDeathHandoff` hid the corpse until the ragdoll rested. Hidden rigs are unpickable and are skipped by
    target cycling, so the dying body (already deleted server-side) was what got clicked.
  - The reveal polled 8 × 500 ms.
  - Shreths (Setup 0x020005A7; Gnawer/Carrion 0x020005C4 have the same graph) have 25 parts, and 10 of them are
    invisible 3-vertex placeholders. Placeholder node 18 kept failing the "every node still" rest test. On top of
    that, the forelegs crept 0.5–1.4 mm/step along the floor until ~5 s.
- **Fix, `?ragdollRest` (default on).**
  - Only DRAWN parts count toward rest, using a 0.4 s rest box at 0.6 % of body height.
  - The rest test is frame-rate independent.
  - Static floor friction applies after the joints give, and calm damping is time-based.
  - The hard stop is 6 s (was 14 s).
  - The reveal polls every 100 ms (4 s cap) and also waits for a ragdoll that is still arming.
  - Result: shreth settle p90 drops from 5.5 s to 3.7 s at 60 Hz and from 7.3 s to 3.2 s at 30 Hz.
- **Fix, `?handoffLoot` (default on).**
  - The claimed dying rig picks and selects AS its corpse (entities.js `pickGuidFor`, `_selectionStateVisible`).
    Hover, click, double-click Use and Closest/Next Unopened Corpse all reach the corpse while it still tumbles.
  - A deleted rig that no corpse has claimed is click-through. This matches retail `ACCWeenieObject::Remove`
    (:438580).
- **Open.**
  - Shreth hind legs (roots 8/11) drift from the torso once the bracing fades. This was already happening. A
    persistent hip link was prototyped: it fixes the gap but changes the crumple, so it needs an owner call.
  - `_tryCorpseDeathHandoff` starts `bestD2` at the 4 m radius², so the documented 8 m live-ragdoll match never
    applies.
- **Tests.** `tests/ragdoll_rest.test.mjs` (43) and `tests/corpse_handoff_loot.test.mjs` (14).

## 3. War-spell ground marks

- **Cause.** The mark is the tier-2 scorch, not blood. Every war bolt gets ACE's Explode, and Explode scorches.
  `vfx/fx_decal_effect.js` had three defects:
  - **Square ember tiles.** The embers were whole cells of a 9-per-radius grid, switched on by `step()`.
  - **Absolute world positions in fp32.** Past 32 km (Holtburg is ~34.6 km north) these resolve only to 3.9 mm, and
    the `dFdx`/`dFdy` normal dropped whole 2×2 quads. The GPU probe measured 94.5 % holes close-up at
    Holtburg-like coordinates.
  - **Quad-derivative normals.** These cut 2×2 blocks at every depth edge.
- **Fix, `?fxDecalSmooth` (default on; `=off` is the old shader byte for byte).**
  - Round soft jittered dots, and gradient-noise fbm on a rotated lattice.
  - Positions relative to the camera: centres are eye-relative in float64 on the CPU, and the view rotation is
    applied on the GPU.
  - Per-pixel normals from the four neighbouring depth texels.
  - The rim no longer uses `pow(negative)`.
- **GPU smoke.** `test_fx_decal_gpu.cjs` passes 9/9: 0 holes and 0 hard steps, where the old shader had 3,926 hard
  steps. `test_particle_fx_tier2_gpu.cjs` passes 30/30.
- **Open.**
  - Every war bolt leaves the same orange scorch, because ACE only sends Explode. An element-aware Explode cue would
    fix that.
  - `vfx/fx_distort_effect.js` has the same `pow(negative, 2.0)`.

## 4. NPCs facing the player

- **Cause 1: wrong convention.**
  - Our pose heading is 0 = West, 90 = North (`Quaternion::to_heading`). Every heading the server sends is the retail
    compass, 0 = North, 90 = East (`Frame::set_heading` :357692; ACE `AFrame`). So pose = wire + 90°.
  - The MoveTo driver used absolute wire headings as pose headings: TurnToHeading, MoveToPosition's final heading,
    and the TurnToObject unknown-target fallback. The legacy snaps also passed degrees as radians to `from_heading`.
  - As a result, emote turns and home facings ended 90° off. The next `Rotate(player)` then needed more turn than
    ACE's `GetRotateDelay` waits for, and ACE's next emote motion cancelled it part-way (the "facing away" case).
- **Cause 2: late start.** Remote turns began one physics step after the unpack. Retail begins inside it.
- **Fix.**
  - One conversion boundary: `holtburger_common::math::{pose_heading_deg_from_wire, wire_heading_deg_from_pose}` and
    `Quaternion::from_wire_heading`. move_to.rs uses it through `node_heading_from_retail`.
  - `handlers::movement::turn_directive_facing` replaces the duplicated snaps.
  - The legacy KIND_TURN emit sends the right facing.
  - `?remoteMoveToBegin` (default on): a remote MoveTo/TurnTo begins inside its own unpack.
- **Tests.** holtburger-world passes 1031/1031, including new `spine_npc_turns_to_face_the_local_player`
  (E/S/W/NE and across a landblock edge), `spine_npc_turn_finishes_inside_ace_rotate_delay`, unknown-target and
  final-heading cases, and the corrected convention tests. The holtburger-common heading tests pass 5/5.
- **Open.** `?serverTurn=on` (default off) passes a JS yaw where `turnToHeading` expects a pose heading.

## 5. Moons

- **Cause.** The legacy Alb'arel opacity `t < 1 ? t : 1 - (t - 1) * 0.4` with `uCloudIntensity` 5 folds back to 0
  for every dense cloud pixel. 63.7 % of the cloud region was exactly 0, which left only a ring at the mask edges.
  There was also a +0.05 grey wash and a hard `trBleed` seam.
- **Fix, `?moonFx` (default on; `=off` keeps the old shader, pinned by sha256).**
  - **Clouds:** a monotone cloud threshold over a sphere-mapped field. Irregular latitude bands, alternating jets
    shearing brushed streaks, and three vortex ovals, on a cloud clock that never loses precision.
  - **Sphere lighting:** the painted-in sun is divided out of both textures, and each moon is relit with the sky's
    sun, giving real phases and a soft terminator.
  - **Detail:** earthshine floor, crater relief, cloud shadows, a rim and halo on Alb'arel, an aureole on Rez'arel,
    ±6° libration, and horizon reddening.
  - **Day:** the unlit part turns translucent by day.
  - **City lights:** they sit on the night side.
- **Knobs.** `?moonPhase=0..1` sets phase strength. `__setMoonPhase` / `Ambient` / `Relief` / `Halo` / `Horizon` /
  `Rim` / `CloudShadow` / `Libration` and `__moonFxState()`.
- **Tests.** `tests/ac_moons_fx.test.mjs` (47) and the `test_moon_fx_gpu.cjs` smoke.

## 6. Terrain hop

- **Plain running never leaves the ground.** `terrain_hop_tests.rs` drives the real
  `advance_local_pose_for_manual_drive` at 12 and 18 m/s and 30/60/144 fps. The courses are a steep descent onto flatter
  ground, a convex crest, a concave dip, a small bump, rolling 2-D hills, a 40° crest and the real Holtburg ADB1 grid,
  each run at the origin and at Holtburg world coordinates. All give zero lift-offs, with feet within 3 mm of rest. The
  heightfield fallback solver gives the same.
- **Cause.** This morning's `?landingBounce` (8f65edbc) acts after any real airborne moment:
  - **Ski-jump.** The retail-literal lift-off relaunches a moving lander horizontally (`get_leave_ground_velocity`,
    acclient.c:343806). On a descent that flies the body off the hill: a jump onto 15° stays clear for 40 frames and
    lands 2.2 m lower.
  - **Chains.** The flight lands hard enough to bounce again on slopes steeper than ~25° at 12 m/s or ~16° at 18 m/s.
    A step-off on 25° chained 3 hops, up to 3.8 m clear.
  - **Wrong normal.** Settle-band landings bounced off a level (0,0,1) normal, which overstates a slope impact.
- **Fix, `?bounceAlongSlope` (browser default on, native const off; `=off` = the morning's behaviour).**
  - A bounce lift-off relaunches along the plane it bounced off, laid the way `adjust_offset` lays a grounded step
    (:311941-311954).
  - A bounce lift-off never chains: `PlayerState::bounce_relaunched` is cleared by `land()` and `begin_jump()`.
  - Settle-band landings bounce off the terrain normal under the feet.
  - Jump and fall landings still bounce. A running landing on flat ground is a ~6 mm hop lasting about 4 frames.
- **Tests.** `terrain_hop_*` (9 diagnostics plus the asserting `terrain_hop_landing_bounce_follows_the_slope`) and
  `bounce_along_slope_flag_defaults_on_unless_off`.
- **Open.** The trigger for a non-jumping runner's first airborne moment is not found. Untested leads:
  - landblock seams;
  - unwalkable patches inside a hillside;
  - the post-transition scenery/entity XY collision correction, which leaves z alone, so on a slope the body floats
    or sinks by step × tanθ for one frame. Moving z along the contact plane is the likely fix.

## 7. Sporadic slowdown

Not confirmed live. There are two fixes for the two plausible causes, plus a detector that names the cause in the
next session.

- **A. Leash starvation (most likely).**
  - **What the leash does.** `?retailLeash` (`ConstraintManager`) scales the run once travel since the last
    self-position echo passes 10 m outdoors or 5 m indoors (acclient.c:389478, re-armed by `ConstrainTo` :145209).
  - **Why we run out.** ACE only echoes our own AutonomousPosition and MoveToState. We sent APs at 1 Hz, on a cell
    change, and never while airborne, and we skipped retail's in-window contact-plane trigger (:718131). A fast
    runner therefore drifts into the slowdown band before each echo, and harder after jumps or late echoes.
  - **Why stop+restart fixes it.** It sends MoveToStates, ACE echoes them, and the leash re-arms. ACE's dev
    describes the same "slowdown = constraint manager" in the community Discord.
  - **Fix, `?apPlaneResend` (browser default on, native const off).** Retail's contact-plane AP send, with a 100 ms
    floor (ours) between sends.
- **B. Held W dead after a cast.**
  - `?castHoldReclaim` keeps a held W dead inside a cast window. ACE's FinishCast Ready echo lands before UseDone
    (Player_Magic.cs:960), so the last reclaim ran under the lock and nothing re-applied W afterwards.
  - A W+strafe runner kept only the strafe until a fresh press.
  - **Fix, `?castLockRevive` (browser default on).** `CommandInterpreter::revive_forward_after_cast_lock` re-applies
    the held movement on the first tick after the window closes, if the player holds control.
- **Refuted for default flags.**
  - The `?castTakesControl` latch on ACE's `HandleRunRateUpdate` echo: `use_time` reclaims on the next pump with
    no press (pinned by a test, both arms).
  - Interpolation pull: `?leashEchoGate` keeps echoes from interpolating the local player.
  - A slower server run rate: ACE omits the exhausted rate of 1.0, which leaves us faster, not slower.
- **Detector (always on).**
  - `slow_run_diag.rs` and `__diag.slowRun.summary() / tail() / explain() / clear()`.
  - It fires when a held, grounded run stays more than 10 % under its expected rate for over 0.5 s. It names the
    stage that lost the speed (run rate, drive, leash or collision) and snapshots control, MoveTo, cast lock,
    leash budget and echo/AP ages into a 16-entry ring.
  - It prints at most one `[slow-run]` console warning every 5 s.
- **Open.** `player_motions_pending()` also counts the projection and interpolation, where retail counts only the
  motion queue. That only matters with `?leashEchoGate=off`.

## 8. Verification

Every heavy job was run capped and one at a time, after the agents finished.

- **Rust.**
  - holtburger-core: 623 passed, 1 ignored.
  - holtburger-world: 1031 passed.
  - holtburger-common: 73 passed.
  - holtburger-web native: 333 passed, 4 ignored.
  - One new slow-run test compared single frames against a single long frame. Every ~5th frame of a 33 ms
    harness frame runs ~3 % short (quantum aliasing, before the echo as well as after it), so it now compares
    mean speed across the echo, with a 95 % per-frame floor.
- **JS gate** (`harness/run-js-headless.mjs`): 517/521 on the first run. The four failures were fixed:
  - Two suites splice `entities.js` with the shared stub list, which lacked the new `ragdollRestEnabled` import
    (`harness/lib/scene3d_stubs.mjs`).
  - `test_build_shell`'s module-preload count went from 372 to 374 (the two new modules).
  - `test_diag_schema`'s `__diag.runAll` evidence line moved from 654 to 660.

  Targeted reruns pass. `tests/corpse_handoff_loot.test.mjs` failed once during a rerun while the release wasm was
  building and passed in the next 6 runs; watch it.
- **GPU smokes** (`capped-build node …`, one SwiftShader tab):
  - `test_fx_decal_gpu.cjs`: 9/9.
  - `test_particle_fx_tier2_gpu.cjs`: 30/30.
  - `test_moon_fx_gpu.cjs`: 25/25.
- **Lints.** `lint-url-flags --strict`, `audit-flag-defaults --mismatch` and `gen-modulepreload --check` are clean.
- **Wasm.** A release build went into `pkg/`, and the previous `pkg/` is in `pkg-prev-20261011-preownerbugs/`. The
  cache stamp moved from `wasmrev-20261011e` to `wasmrev-20261011f`. Load with `?nosw=1` and do a full reload;
  the bake worker holds its own wasm.

## 9. 1070 eye-test queue (batched, off-screen, `?nosw=1` + full reload; the bake worker holds its own wasm)

1. **Daylight.** At night, tick Options → Character → Visual → "Always daylight outdoors". Within a second the sky and
   ground go to noon, and they stay noon after a portal or relog. Untick it and the real time comes back.
   `window.__alwaysDaylight.state()` shows `{on, pinned}`.
2. **Ragdoll → loot.** Kill Blood/Hunter shreths.
   - While the body is still settling, hover shows "Corpse of …", a click selects the corpse, and a double-click
     opens the loot.
   - The reveal keeps the pose: no pop, no double body.
   - Tab never selects the dying body, and Closest Unopened Corpse finds the corpse mid-tumble.
   - The body stops within about 1 s of its last visible motion.
   - The first ~2 s match `?ragdollRest=off&handoffLoot=off`.
3. **Scorch.** Cast war bolts at targets and at the ground 4/15/30 m away at Holtburg. Expect a ragged soft char with
   round flickering embers: no orange squares, no 2×2 speckle, no gaps along grass or rocks. Compare
   `?fxDecalSmooth=off`.
4. **NPC turns.**
   - Talk to a Holtburg vendor from the front, both sides and behind: it turns the short way and ends square to you.
   - A quest NPC with a TurnToTarget emote faces you before its first line.
   - A vendor reset or a monster leash ends on its spawn facing.
   - Compare `?remoteMoveToBegin=off`.
5. **Moons.** `?skytime=0&moonSpeed=10`, facing north.
   - Banded brush-streak clouds across the whole Alb'arel disc, with no hollow ring, wash or seam.
   - Phases with a soft terminator, the green city on the dark side, and both limbs reddening near the horizon.
   - `&skytime=12` makes the unlit part fade into the sky.
   - Compare `&moonFx=off` and `&moonPhase=0`.
6. **Slowdown.** Buffed runner, bare URL.
   - Run hills for 30 s with a few running jumps, then a dungeon corridor; then hold W+strafe through a targeted
     cast's end.
   - When it feels slow, before stopping, copy `__diag.slowRun.explain()` and the `[slow-run]` line.
   - Pass: no `cause=leash` outdoors or after landings, and the held W resumes by itself when the spell goes out.
   - Compare `?apPlaneResend=off` and `?castLockRevive=off`.
7. **Terrain hop.**
   - Run full speed down a 15–30° hill and jump, and jump off a crest onto a slope: one small hop that follows the
     hill, with no second flight and no hops all the way down.
   - Running over hills without jumping never leaves the ground.
   - A standing full jump on flat ground still gets the small bounce.
   - `?bounceAlongSlope=off` brings the descent ski-jump back. If the owner still sees hops while NOT jumping, note
     the spot: a landblock seam, a steep patch, or next to a rock or tree.
