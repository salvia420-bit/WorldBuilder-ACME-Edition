# HANDOFF — running animation / movement (2026-10-24)

Branch `runanim-2026-10-24` (not committed, not pushed). Every new flag is in `docs/url-flags.md` §11.

## 1. Owner prompt (verbatim)

> for holtburger-web there have been some critisisms after people watched a 3 hour video of it. their quotes. well basically they were critisizing the running animation/movement system. lets fix this now. a complete understanding of everything that touches it. we have webac, openac and the decomp to compare to. there could be a urlflag messing it up. leave no stone unturned use opus 5.5 agents to help. test onscreen muted autonomously until its fixed /goal

> you can have full screen onscreen testing

No viewer quotes were supplied, so the work started from a full map of the movement and animation chain. Eight research lanes (local sim, animation, remote entities, camera, retail decomp, WebAC, OpenAC, URL flags) wrote reports to `/mnt/wbterminal1/tmp/runanim-2026-10-24/research/*.md`. Every finding below was re-checked against acclient.c and measured live on the 1070 before it was fixed.

## 2. What a viewer saw, why, and what changed

Live numbers are from the 1070 (GTX 1070, ANGLE D3D11, full screen 1920×1080, 60 fps soft cap, muted Chrome), test character `+Tester` (run rate R = 4.5, ACE's cap), unless marked 30 fps off-screen. "Slide" is the planted foot's ground speed divided by the body's (0 = no skating).

| # | What a viewer saw | Cause (retail reference) | Fix (flag) | Before → after (live) |
|---|---|---|---|---|
| 1 | **Ice-skating run.** The legs pump slowly while the body runs at 18 m/s. | The local rig dispatchers passed speed 1.0 for every key gait. Retail plays the run at R (`apply_run_to_command` acclient.c:343439). `cycleTimeScale` also clamped at 4.0. | `retailRigSpeed` (local), clamp lifted | run tempo 1.0× → 4.5×; slide 0.82 → 0.006 (strict, 30 fps) |
| 2 | Backpedal and strafe skate too. | Same: backpedal −0.65 × R, sidestep min(1.248 R, 3) and turn ×1.5 under hold-run (`adjust_motion` :343746). | `retailRigSpeed` | backpedal −0.65× → −2.925×, slide 0.71 → 0.20; strafe 1.0× → 3.0×; turn in place 1.0× → 1.5× |
| 3 | **Other players** skate the same way. | `_unifiedLocoGaitScale` used the wire speed only for creatures and walk cycles; a player's run played at 1.0×. | `retailGaitTempo` | remote run tempo 1.0× → wire forward_speed |
| 4 | Running feet float ~10 cm above the ground; the body bounce is flattened. | The bake folds root motion into the parts; the in-place pose subtracted the per-frame MEAN, which also removed the 11 cm bob and lifted the stance foot. | `inPlaceExact` + a new `rootFrames` channel from the bake | planted foot 9–14 cm → 1.2 cm; pelvis bob 3.6 cm → 11.3 cm (both as authored) |
| 5 | Start, stop and walk↔run lurch up to 2.5 m ahead, then snap back. | Locomotion links drawn with their folded root motion while the body is moved by the sim. Retail moves the object by the root (`CSequence::update_internal` :340719). | `inPlaceLinks` | code-verified (in_place_exact test) |
| 6 | Starting or stopping a backpedal takes a step forward, then pops. | Retail's `get_link` takes the reversed pair for a negative speed (:337585) and two-hops through Ready when signs differ (:337779-337810). We used the forward link. | `signedLinks` (+ wasm `fetchMotionLinkKeyframes` signed args) | unit + cargo tests; live backpedal start/stop now resolves the reversed pair |
| 7 | The first run after login slides in the idle pose. | The run cycle baked asynchronously on first use while the body already ran. | `locoPrewarm` | 33 frames (0.93 s) of idle-pose slide → 1 frame (50 ms) |
| 8 | Remote players strafing slide in their idle pose; a left turn plays right-turn footwork. | KIND_MOTION carried only the forward command (Ready for a pure strafe/turn); the turn was replayed at +1.0. Retail plays the sidestep/turn as the substate at its signed speed (:337763). | `remoteSubstate` (wasm position.rs + loop.js) | see §4 |
| 9 | Monsters chasing you glide (MoveTo run clip lost while the rig spawns). | The MoveTo phase edge was dropped for an unbuilt rig; a matching hint reset the speed to ×1.0. | `moveToPhaseParked` | unit tests |
| 10 | In combat stance, walking/backpedalling moves at the peace-mode speed under a combat cycle. | The local sim always resolved the table's default style. | `stanceKinematics` (wasm) | cargo test |
| 11 | After any hitch the legs freeze for ~10 frames while bodies glide. | A 10-frame dt = 0 band after a long frame. Retail moves body and parts in one quantum (:323081). | `dtNoFreeze` | film_hooks H7k2 |
| 12 | The camera snaps back out to 6 m the frame after a trunk or wall corner. | Hard lock: pull-in and re-extension both instant. | `camBoomEase` (re-extension eased at retail's 0.15/tick; pull-in stays instant) | live: snap → ease |
| 13 | The runner disappears behind a hill crest. | The eye was only floored above the terrain under it; retail sweeps the whole boom (`SmartBox::update_viewer` :144991). | `camTerrainSweep` + `camTerrainEase` | the eye comes in before the crest, gliding over ~0.15 s instead of a 3 m one-frame jump (§4) |
| 14 | The camera collapses into the runner's head next to some buildings. | The statics collision index took the visual box of every static, even ones with no physics. Holtburg's doorway banners (`0x01000AEF`, no physics polygons) put a box at head height. Retail gives such objects no collision (`FindObjCollisions` ladder :316229-316281), and the camera transit runs as the player object. | `staticPhysicsOnly` (wasm) | clip log: `Statics` t = 0.01 at the doorway → see §4. Also removes invisible walls for the player at BSP-less props. |

## 3. Flags

All are behaviour fixes, so all ship DEFAULT ON with an `off`/`0`/`false` escape, read once at load. Rows with readers, tests and mechanism are in `docs/url-flags.md` §11: `retailRigSpeed`, `retailGaitTempo`, `inPlaceExact`, `inPlaceLinks`, `signedLinks`, `locoPrewarm`, `moveToPhaseParked`, `remoteSubstate`, `dtNoFreeze`, `camBoomEase`, `camTerrainSweep`, `camTerrainEase`, `staticPhysicsOnly` (wasm), `stanceKinematics` (wasm).

The pkg must be rebuilt for the wasm parts (`rootFrames`, signed links, `remoteSubstate`'s position.rs half, `stanceKinematics`, `staticPhysicsOnly`); the stamp is `wasmrev-20261024d`. With an older pkg the JS falls back (mean in-place pose, no signed link) without errors.

## 4. Verification

**Live, 1070 on-screen** (full screen, muted, 60 fps soft cap; captures in `/mnt/wbterminal1/tmp/runanim-2026-10-24/captures`):

| Check | Before | After | Capture |
|---|---|---|---|
| Local run | tempo 1.0×, slide 0.82 (30 fps) | tempo 4.5×, body 18.5 m/s, strict slide 0.006 | `f1-*` → `f4-run8`, `b2-run8` |
| Local backpedal / strafe / turn in place | −0.65× / 1.0× / 1.0× | −2.92× / 3.0× (3.5 m/s) / 1.5× | `b2-back`, `b2-strafeonly`, `b2-turnonly` |
| First run after a fresh login | 33 frames (0.93 s) in the idle pose at 18 m/s | 1 frame (50 ms) | `os-run8` → `b2-firstrun` (`slide_start.py`) |
| Camera at the Holtburg doorway banners (run + turn) | boom collapses into the head 2–3× per pass; screen jitter RMS 95 px, max 1306 px | no collapse (clip log: no `Statics` hit); RMS 3 px, max 39 px | `b2-runturn` → `b3-runturn` (+ `.camclip.json`) |
| Camera over hill crests (run, strafe) | crest hid the runner (build 1); then a 3.1 m one-frame pull-in (terrain sweep alone) | largest one-frame jump 0.9 m (the glide's first step); eye ≥ 0.36 m above the ground on every frame | `b3-strafe`, `b2-run8` → `b3e-run8`, `b3e-strafe` |
| Remote player (bot client) pure strafe right / left | idle pose sliding at 3.75 m/s | SideStepRight at +3.0× / −3.0×, 3.75 m/s | `b3-subst.remote.json` |
| Remote turn in place right / left | turn cycle at +1.0 both ways | TurnRight at +1 / −1 (the wire speed ACE sends) | `b3-subst.remote.json` |
| Remote run / backpedal | 1.0× / −2.925× | 4.5× at 17.7 m/s / −2.925× | `b3-mix.remote.json`, `b3-run-clear.remote.json` |
| Remote runner on a clear path | — | 4% zero-move frames, all single frames (no freezes) | `b3-run-clear.remote.json` |
| REMOTE-4 probe (body running with wire contact 0) | — | 0 frames in ~3,000 remote frames, including a 7 s downhill run: not observed, so no change | `b3-*.remote.json` |

The 0.2 s remote freezes in `b3-mix` are the bot running straight into Holtburg's fenced plot (rail `0x010007C4` and post `0x0200022C`, both physical) at (106–117, 154–161). The bot was itself blocked there, so this is correct, not a defect.

**Tests.** New targeted tests, all registered in the gate (tier 5): `retail_rig_speed`, `in_place_exact`, `signed_loco_links`, `loco_prewarm`, `remote_substate`, `cam_boom_ease` (incl. the terrain glide), `cam_terrain_sweep`; extended: `creature_gait_retail`, `remote_moveto_phase`, `film_hooks` (H7k2). Native: `stance_kinematics_flag_defaults_on_off_escape`, `static_physics_only_flag_defaults_on_off_escape`, `signed_link_bake_resolves_the_reversed_pair_and_plays_it_backwards` (holtburger-web), `resolve_player_motion_table_profile_uses_the_current_stance_walk` (holtburger-world). Gate results are in §8. The signed-link native test first failed because native builds hard-wire the legacy single-hop link lookup (`get_link_flag()` is false off-wasm), which ignored the speeds. The single hop now also takes retail's reversed pair for a negative speed, which is also the `?getLink=off` behaviour; the browser default (`getLink` on) was already right.

## 8. Gate and eye test

- Rust (per crate, in the cap): `cargo test -p holtburger-world --lib` 1114 passed; `cargo test -p holtburger-web --lib` 524 passed, 7 ignored (pre-existing).
- Full JS gate, run 1 (`capped-build node harness/run-js-headless.mjs`, 9.6 min): 2 failures, both older tests pinning behaviour this work changes on purpose. `local_auto_motion` compared the command object exactly and it now carries `run`. `camera_viewer_step` S3/S4 expected the boom to snap back out in one frame, which `camBoomEase` replaces; those two cases now turn the ease off, since they pin sweep geometry. Both pass when re-run.
- Full JS gate, run 2 (after the review fixes, build 4 deployed as `wasmrev-20261024d`): **888 passed, 0 failed, 0 skipped** (9.8 min).
- **Owner eye test (~2 min, 1070, real eyes).** Open the usual recording URL and stand anywhere in Holtburg:
  1. Hold W on open ground: the legs keep pace with the ground, the feet plant, and the body bounces.
  2. Tap W on and off a few times: no lurch ahead and snap back at the start or the stop. The stop is still abrupt (LOCALSIM-3, §6).
  3. Hold S, then A and D, then Q and E standing still: backward steps, side steps and turns at a matching pace, no gliding. A backpedal starts and stops with a backward step.
  4. Run down the hill north of the start spot: the camera glides in over the crest and does not jump.
  5. Run along the north face of the building about 40 m north of the start spot (`0xA9B4` local ~(84, 131); two hanging banners at y ≈ 139.5): the camera no longer slams into the head.
  Escape hatches if anything looks wrong are in `docs/url-flags.md` §11 (each `?flag=off`).

## 5. Owner decisions (nothing changed here)

- **Camera feel (CAMERA-1 / CAMERA-4).** Retail eases the camera at stiffness 0.45 and frames a 2.87 m boom at the neck (16.7°). holtburger hard-locks a 6 m boom aimed at the hips. Under the hard lock every pose irregularity shakes the whole picture, and the long boom hits terrain and trunks far more often. On a steep downhill the terrain sweep pulls the eye in up to ~3 m; `camTerrainEase` glides that in over ~0.15 s (retail pulls in instantly, but on a boom less than half as long). Try `?camStiffness=0.45` for the feel; the framing would need a new opt-in.
- **`apTravelResend`** (ours, an AP every 2.5 m): observers see a 140 ms stutter. A/B on the 1070: 23% zero-move frames with it on, 12% with it off. It exists to keep the server in step on long runs.
- **Non-retail combat overlays on moving monsters** (`limbDamage`, `carnage`, `dismember`, `ragdoll`, `blood`, all ON): after 2 leg hits a monster's legs buckle on a fixed 0.9 s sine unrelated to its gait, and at 4 a leg is severed while the server creature keeps running. A chaser can look broken. Consider `limbDamage` OFF for footage.
- **Frame cap.** A visible but unfocused window or a focused recorder drops the page to 30 fps (VTank soft cap). For recordings use `?targetFps=0` or raise `TargetFPSFocused`.

## 6. Not done (next)

- **LOCALSIM-3, stop coast.** Releasing W stops the body dead while the rig plays the 0.4 s run→Ready step; retail coasts ~0.79 m on the link's root motion. Needs the body to follow link root motion (OpenAC's shape) — a design change.
- **LOCALSIM-2 remainder.** A pure strafe still moves at the closed-form 1.25 m/s × speed in every stance; retail moves by the stance's own sidestep cycle. Needs per-stance sidestep root speeds (a MotionKinematics re-bake).
- **CAMERA-2.** The sim clock and the presentation clock differ; magnitude unmeasured.
- **REMOTE-4** (hypothesis). A non-grounded wire bit could freeze a grounded remote. See §4 for the live probe.
- **REMOTE-5 / FLAGS-7.** A dynamic-LOD respawn of a moving single-part remote drops `_motionSpeed` / `_runRate` / MoveTo phase (tempo ×1.0 after the swap).
- **Remote turn overshoot (R3).** A remote that turns while running keeps the old heading until the next server position, then snaps back. Dead-reckoning heading; remote-motion lane (FLAGS-8 `remoteSpineHeading`).
- **FLAGS-11 landing bounce.** A running landing may replay land → take-off → land; A/B `?landingBounce=off`.
- **Flag hygiene (FLAGS-12/13).** Several comments and doc rows state the wrong default; the audit does not sweep wasm readers.

## 6b. Independent review (Opus agent, read-only) and what was done

| # | Finding | Severity | Done |
|---|---|---|---|
| 1 | A run-rate change while standing re-dispatched the local rig, i.e. sent Ready: it ended a held emote (sit, kneel), cut a cast gesture short and released the death hold (CQ-06 treats Ready as a revival). | medium | Fixed: the run rate joins the rig signature only for run / running backpedal / running strafe. `tests/rig_speed_redispatch.test.mjs`. |
| 2 | The signed link lookup ignored the speeds off-wasm and under `?getLink=off`. | medium | Fixed (single hop reads `links[to][from]` for a negative speed); the native test's miss assertion is now strict. |
| 3 | The terrain glide could place the eye behind a wall the chain never swept (it swept only up to the terrain clip point). | low-medium | Fixed: each eased eye is re-swept (no terrain sweep). `cam_boom_ease` test. |
| 4 | `?creatureGait=off` stopped working while `retailGaitTempo` was on. | low | Fixed: it is the escape for the whole retail tempo again. `tests/creature_gait_off.test.mjs`. |
| 5 | `app/frame_pump.js` (live under `?cmdInterp=off`) still sent the local run at 1.0, racing the camera's R. | low | Fixed: same `localRigSpeed`. |
| 6 | `scenery_model_rung` cached an unfetchable record as no-collision, and the statics skip shares that cache. | low (latent) | Fixed: misses are not cached; the statics skip needs a fetchable record. |
| — | Test gaps: `remote_substate` fed full commands while the wasm emits low-16. | — | Added the low-16 cases. Still open: an end-to-end test of `_setMotionImpl`'s signed link queueing and of `_playLinkEntry`'s `rec.inPlace`. |

## 7. Resume

- Harness: `/mnt/wbterminal1/tmp/runanim-2026-10-24/harness` (README in the header of each script).
  - `hbanim.mjs <scenario> <label>` drives the 1070 page's local player and records every presented frame; `metrics.py` (tempo, slide, body speed, jitter), `slide_start.py` (idle-pose slide at run start).
  - `battery.sh <prefix> [scenarios]` teleports to the start spot (`@teleloc 0xA9B40025 96 96 80.005 1 0 0 0`) and runs each scenario.
  - `remote_test.sh <scenario> <label>` runs the render-less spare-account client (`bot2.mjs`, the ONE heavy job) next to the 1070 character and records it as a remote (`remote_timeline2.js`, `remote_metrics.py`).
  - `camclip_install.js` / `camclip_collect.js` log which camera clip step shortened the boom, per frame.
  - On-screen session: `onscreen_boot.mjs` (refuses unless the test Chrome carries `--mute-audio`), `relog.mjs`.
- Captures: `/mnt/wbterminal1/tmp/runanim-2026-10-24/captures` (`f1-*`/`f4-*` = 30 fps off-screen, `os-*` = on-screen build 1, `b2-*` = build 2).
- ColdEve session (owner request, 2026-10-24): a throwaway ColdEve account with one character (Aluvian, Holtburg start area). Credentials are in `~/.config/holtburger/coldeve-test-account.json` (mode 600, not in the repo). `coldeve_prep.mjs` (login form), `coldeve_create.mjs` (first login creates the account, then one character), `coldeve_relog.mjs` (full-screen `?autoLogin=1` game view; the password goes into the tab's sessionStorage stash, never a URL). No admin on ColdEve, so the `@teleloc`-based battery does not apply there.
- pkg backups: `pkg-prev-20261024-prerunanim/` (before this work, for a rollback), `pkg-prev-20261024-build1/` .. `-build3/` (each previous build). The build outputs `pkg-runanim/`, `pkg-runanim2/` .. `pkg-runanim4/` are leftovers (`pkg-runanim4` = the deployed `pkg`); ~9 MB each, safe to delete.
