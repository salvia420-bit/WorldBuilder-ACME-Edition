# A12 camera — unification survey

Date: 2026-06-11 · Agent: A12 · Sources: `~/ac-headers/acclient.c` / `acclient.h` (retail),
`apps/holtburger-web/scene3d/camera.js` + `scene3d/loop.js` + `scene3d/index.js` (ours).
Rule §2.5 honored: all our-side cites are the `scene3d/` 3D path.

## 1. Retail map

Retail splits the camera across two classes plus two call sites:

- **`CameraManager`** (struct `acclient.h:35238-35263`) — the pure math owner. State:
  `t_stiffness`/`r_stiffness`, `pivot_object_id`+`pivot_offset`, `target_object_id`+`target_offset`,
  `direction`, `target_status` (bitmask: LOOK_IN_DIRECTION=1, LOOK_AT_OBJECT=2, LOOK_AT_PIVOT=4,
  ALIGN_WITH_PLANE=0x10 — usage at `acclient.c:148224-148242`), `viewer_offset`,
  `m_bAlignCameraToSlope`, `old_velocities[5]` ring, `scale`, `m_pCurrentCameraSet`.
  - `CameraManager::UpdateCamera` (`acclient.c:147425-147864`) is the whole per-frame pipeline:
    1. integrate offset-movement flags × quantum (`acclient.c:147522-147542`);
    2. resolve pivot object position via `QueryPivotPosition` (`acclient.c:147352`, called at
       `acclient.c:147550`);
    3. accumulate `target_direction` from up to three sources: LOOK_AT_OBJECT
       (`acclient.c:147559-147589`), slope/velocity alignment using the 5-sample
       `old_velocities` average when `m_bAlignCameraToSlope && target_status & 0x10`
       (`acclient.c:147591-147736`), LOOK_IN_DIRECTION (`acclient.c:147737-147743`);
    4. build the sought camera frame = pivot frame + `viewer_offset` localtoglobal
       (`acclient.c:147752-147760`), LOOK_AT_PIVOT redirect (`acclient.c:147761-147787`);
    5. **stiffness smoothing**: `frac = stiffness * quantum * 10`, clamped to 1
       (`acclient.c:147796-147825`), then `Frame::interpolate_origin` /
       `Frame::interpolate_rotation` from current viewer pos toward the sought frame
       (`acclient.c:147841-147842`), with an early-out when within 4e-4 m / close_rotation
       (`acclient.c:147845-147853`).
  - Constants: `CAMERA_MOUSELOOK_LIMIT = 0.8` (`acclient.c:39549`),
    `CAMERA_DEFAULT_PIVOT_Z = 1.5` (`acclient.c:39550`).

- **`CameraSet`** (struct `acclient.h` "struct __cppobj CameraSet", shown at the 3753 block) —
  the mode/UX owner sitting on SmartBox. State: `looking_down`, `in_map_mode`,
  `mouselook_active`, `targeting`, `rot_left/rot_right/raise/lower/closer/farther` latches,
  zoom/rotate timestamps.
  - **In-head (first person)** is not a mode enum — it is the `viewer_offset == (0, 0.18, 0)`
    point of the zoom continuum: `CameraSet::InHead` (`acclient.c:147680-147687`, static variant
    `acclient.c:148094`), `SetInHead` (`acclient.c:149230-149262`).
  - **Zoom continuum**: `Closer` (`acclient.c:148977-149046`) multiplicatively shrinks
    `viewer_offset` by `1 - adjustSpeed*dt*0.2`, refusing below radius 0.5; `Farther`
    (`acclient.c:149048-149137`) grows it by `1 + adjustSpeed*dt*0.2`, clamped to
    `|x|,|y| ≤ 10, z ≤ 450`, and when leaving in-head re-seats the pivot at
    `CAMERA_DEFAULT_PIVOT_Z` (`acclient.c:149093-149097`). Both force stiffness 1.0 when
    `offset.y ≤ -1.8` (`acclient.c:149025-149028`, `149110-149113`).
  - **Raise/Lower** rotate the offset vector spherically (radius preserved) by
    `adjustSpeed*dt` and clamp the in-head look direction z to ±0.8
    (`acclient.c:148398-148409`, body of `Raise` from `acclient.c:148321`).
  - **LookDown / map mode**: `LookDown` saves/restores offset+direction and points the camera
    down (`acclient.c:148619-148717`); `SetMapMode` = lookdown with `viewer_offset.y = -450`
    plus `SmartBox::DisableDegrades(1)` / `DisableFogging(1)` (`acclient.c:148719-148756`).
  - **Target tracking**: `TrackTarget` sets LOOK_AT_OBJECT on a gid (`acclient.c:148758-148787`);
    `SetTargetForOffset` picks the target_status bits from the offset shape
    (`acclient.c:148219-148242`).
  - **Mouse-look**: `MouseLookHandler` (`acclient.c:149264-149372`) runs
    `FilterMouseInput` (two-sample average inside a 0.25 s window blended by
    `m_MouseSmoothingAmount`, `acclient.c:148138-148163`), then scales by
    `m_MouseLookSensitivity * 0.0666` (`acclient.c:149300-149303`), honors
    `m_InvertMouseLookYAxis` (`acclient.c:149304-149309`), and applies a 5-event extent
    dead-band before routing horizontal→`Rotate`, vertical→`Raise`/`Lower`
    (`acclient.c:149322-149372`).
  - **Per-frame**: `CameraSet::UpdateCamera` (`acclient.c:149139-149228`) services the held
    rotate/zoom/raise latches, then runs **player auto-fade**: in-head →
    `SetTranslucencyHierarchical(player, 1.0)` (`acclient.c:149187`); third-person → fade the
    player as camera-to-pivot distance drops below 0.45 m, fully invisible toward 0.2 m
    (`acclient.c:149190-149216`).

- **Call order**: `CameraSet::UpdateCamera` runs from `gmSmartBoxUI::UseTime`
  (`acclient.c:262368`, call at `262586`); `CameraManager::UpdateCamera` runs from
  `SmartBox::PlayerPhysicsUpdatedCallback` (`acclient.c:144043-144052`) — i.e. **after** the
  player's physics update for the frame.

- **No camera collision**: `CameraManager::UpdateCamera` (`acclient.c:147425-147864`) contains
  no transition/sphere-sweep calls; retail's camera clips through geometry.

## 2. Ours map

One JS module owns everything; there is no Rust-side camera code (the wasm bridge only
*serves* sweeps/poses the camera asks for).

| concern | site |
|---|---|
| Mode set (follow / topDown / orbit) + cycle on `C` | `scene3d/camera.js:142`, `camera.js:1627-1647` |
| Construction / wiring | `scene3d/index.js:1990-2021` |
| Per-frame tick (called BEFORE the wasm entity tick) | `scene3d/loop.js:1507-1521`; ordering rationale `loop.js:18-36` |
| Follow positioning (yaw/pitch/distance offset, hard-set, lookAt) | `camera.js:701-756`; constants `camera.js:152-164, 319` |
| Camera collision sweep chain (terrain clamp → building AABB → building tris → statics → EnvCell tris, via wasm exports) | `camera.js:808-925` |
| Mouse-look (right-drag, raw deltas × fixed sens) | `camera.js:511-584`; sens `camera.js:163-164` |
| Top-down ortho (300 m up, wheel zoom 0.2–8.0) | `camera.js:765-773, 1613-1624`; `createOrthoCamera` `camera.js:219-238` |
| Orbit mode (three.js OrbitControls) | `camera.js:587-629` |
| Player-pose smoothing/prediction (now direct-assign of integrator pose) | `camera.js:1294-1325` (legacy predictor `camera.js:949-1230` behind `window.__predPureSmooth === false`) |
| WASD/QE/Shift keystate + input→`setMovementInput` dispatch | `camera.js:1571-1624, 1464-1517` |
| Local-rig locomotion MotionCommand dispatch (`setMotion`) | `camera.js:1525-1567` |
| Listener lifecycle (C1 global/per-mode split) | `camera.js:440-455, 478-490, 1668-1683` |

## 3. Divergences

| # | behavior | retail cite | our cite(s) | class | symptom | tracked? |
|---|---|---|---|---|---|---|
| 1 | Camera-frame stiffness smoothing (interpolate origin+rotation toward sought frame at `stiffness*dt*10`) | acclient.c:147796-147842 | camera.js:737,756 hard-set every frame | DIFF-ALGO | camera rigidly welded to avatar; corrections/teleport jolts transmit 1:1 to viewport | no |
| 2 | First-person (in-head) endpoint of zoom continuum, `viewer_offset=(0,0.18,0)` | acclient.c:147680-147687, 149230-149262 | camera.js:142 (3 fixed modes), camera.js:319 (`followDistance = 6.0`) | MISSING | no first-person view at all | no |
| 3 | Continuous zoom (Closer/Farther multiplicative offset scaling, min 0.5 / max z 450, stiffness 1.0 near in-head) | acclient.c:148977-149137 | camera.js:319 fixed 6 m; wheel zoom only in topDown camera.js:1613-1624 | MISSING | follow distance not adjustable; no zoom-to-first-person | no |
| 4 | Player auto-fade when camera within 0.45 m of pivot; opaque in-head | acclient.c:149187-149216 | none — camera.js:808-925 only pulls camera in; no translucency call (entities.js:3256 translucency path is objdesc-driven only) | MISSING | wall push-in leaves the avatar filling/blocking the screen | no |
| 5 | Mouse-look filtering + user options (0.25 s two-sample smoothing, sensitivity, invert-Y, 5-event dead-band) | acclient.c:148138-148163, 149264-149372 | camera.js:525-536 raw per-event deltas × fixed 0.0025/0.0020 (camera.js:163-164) | DIFF-ALGO | mouselook feel differs; no sensitivity/invert settings | no |
| 6 | Pitch geometry/clamp: spherical offset rotation, radius preserved, dir-z clamp ±0.8 | acclient.c:148321-148409 | camera.js:152-153 (`[-0.5, 1.4]` rad), 708-725 (offset recomputed from pitch, radius fixed) | DIFF-ALGO | different reachable pitch envelope (minor) | no |
| 7 | Map mode: lookdown at y=-450 perspective + DisableDegrades/DisableFogging | acclient.c:148719-148756 | camera.js:765-773 ortho at +300 m, no fog/degrade hooks | DIFF-ALGO | approximation; deliberate (ortho minimap) | no |
| 8 | Target tracking (LOOK_AT_OBJECT camera follow of a selected gid) | acclient.c:148758-148787, 147559-147589 | none in camera.js (no target_status equivalent) | MISSING | camera cannot track a combat/selected target | no |
| 9 | Slope/velocity alignment (5-sample velocity average steering look dir) | acclient.c:147591-147736 | none | MISSING | minor downhill-run framing difference | no |
| 10 | Camera collision sweeps (terrain/buildings/statics/EnvCells) | absent from acclient.c:147425-147864 | camera.js:808-925 | EXTRA | ours is an enhancement — retail clips through walls; KEEP | no |
| 11 | Ownership: camera also owns input→motion dispatch, local-rig setMotion, and player-pose smoothing; retail camera only consumes pivot pose (CommandInterpreter owns input — struct acclient.h block 3772; InterpolationManager owns pose smoothing) | acclient.c:147540-147550 (camera reads pose only) | camera.js:1464-1517 (setMovementInput), 1525-1567 (rig setMotion), 1294-1325 (pose smoothing) | SPLIT-BRAIN (3 foreign concerns in 1 module) | fixes to input/interp/anim must be made inside camera.js; cross-subsystem regressions | seams: A14 (input), A2 (interp), A4/A5 (rig motion) |
| 12 | Update ordering: retail camera updates AFTER player physics for the frame | acclient.c:144043-144052; 262586 | loop.js:1507-1521 camera tick BEFORE wasm entity tick (reads last frame's integrator pose) | DIFF-ALGO (ordering) | candidate one-frame camera-vs-avatar lag during motion | A1 seam (frame orchestration owns the ruling) |

## 4. Staged unification plan

Our camera is an **intentional modern controller**, not a failed port (header comment
`camera.js:1-128` documents the design). Rows 7, 9, 10 need no work. The player-visible gaps
are the zoom/first-person continuum (#2/#3), the near-fade (#4), and feel items (#1/#5). The
structural item is #11, which belongs mostly to other agents' subsystems. Small plan:

- **Stage C1 — evict foreign concerns from camera.js** (the #11 split-brain).
  Scope: move `_dispatchMovement`/`computeMovementFromKeys`/keystate (→ new
  `scene3d/input.js`, coordinate with **A14**) and `_dispatchLocalRigMotion` (→ entities.js
  motion-dispatch layer, coordinate with **A4/A5**); leave `_smoothToIntegrator` ownership
  ruling to **A2** (it is the InterpolationManager analogue). Camera keeps only pose math +
  collision clip. Files: `camera.js`, new `scene3d/input.js`, `index.js` wiring.
  Flag: none needed if pure refactor with identical call graph, but per survey rules gate as
  `?cameraInputSplit=on` (default-off, old path intact). JS-live. Tests: headless-now (node
  unit test that keystate→dispatch signatures are byte-identical across the flag). Rollback:
  flag off. **Do not execute before A14/A4 publish their plans — this stage may be subsumed
  by A14's input-funnel unification.**

- **Stage C2 — retail zoom continuum + in-head + near-fade** (#2, #3, #4).
  Scope: replace fixed `followDistance` with a `viewer_offset`-style scalar driven by wheel /
  PageUp-PageDown in follow mode, retail constants: multiplicative `±adjustSpeed*dt*0.2` steps
  (acclient.c:148996-149020), min radius 0.5 collapsing to in-head (offset (0,0.18,0),
  acclient.c:149023, 147685), max clamp (acclient.c:149119). In-head hides… shows the player
  opaque at 1.0 and suppresses the collision pull-in; third-person fades player material
  opacity below 0.45 m camera distance per acclient.c:149190-149216. Files: `camera.js`
  (positioning + wheel), `entities.js` (a setLocalPlayerOpacity helper). New module shape:
  none — stays in camera.js. Flag: `?retailCamZoom=on` (default-off) in `docs/url-flags.md`
  style. JS-live. Tests: headless-now (unit: zoom step math, fade curve values at d=0.45/0.30/
  0.20); 1070-gated (eye-test: zoom into first person, fade smoothness, no z-fighting with
  head mesh). Rollback: flag off.

- **Stage C3 — stiffness smoothing + mouse-look filter** (#1, #5).
  Scope: optional exponential interpolation of the camera frame toward the sought frame with
  `frac = clamp(stiffness*dt*10, 0, 1)` for origin and rotation separately
  (acclient.c:147796-147842), plus the FilterMouseInput two-sample/0.25 s smoothing and a
  sensitivity/invert-Y option surface (acclient.c:148138-148163, 149300-149309). Files:
  `camera.js` only. Flags: `?camStiffness=<float0..1>` (absent = off = current hard-lock) and
  `?mouseSmooth=<0..1>`. JS-live. Tests: headless-now (unit: interpolation fraction clamps,
  filter output for synthetic event trains); 1070-gated (feel eye-test; check no motion
  sickness regression vs current). Rollback: flags off.

Ordering: C1 after A14's plan lands (or is folded into it); C2/C3 independent and JS-live.
Nothing here depends on Stage 1 movement eye-test (camera reads pose, doesn't write it) —
except row 12, whose disposition belongs to A1.

## 5. Scores

- **Leverage**: backlog IDs subsumed: **none** — the 2026-06-07 CRIT "switchMode wipes input
  listeners" is already fixed in-tree (C1 global/per-mode listener split, camera.js:440-455,
  1668-1683); no open F/B/G camera items found in §3.3 docs (grep "camera" hit only an
  unrelated statics-LOD note in the unsurfaced-render audit).
- **Regression-risk reduction**: M for Stage C1 (removes the 3-way concern tangle that makes
  input/anim fixes touch camera.js); L for C2/C3 (additive, flag-gated).
- **Implementation risk**: L (C2, C3 — pure JS, default-off), M (C1 — wide call-graph refactor,
  must serialize with A14).
- **1070-dependency**: Y for C2/C3 final acceptance (feel/visual); N for C1 and for all unit
  tests.
- **Depends-on**: A14 (input funnel) and A4/A5 (motion dispatch) for Stage C1; A2 for the
  pose-smoothing ownership ruling; A1 for divergence #12 (ordering). Not gated on Stage 1
  movement eye-test.

## 6. SPECULATIVE / UNRESOLVED

- **One-frame camera lag (#12)**: ordering difference is dual-cited, but the *symptom*
  (visible avatar-vs-camera desync) is speculative — `loop.js:18-36` argues camera-first is
  correct for input latency, and the avatar rig reads the same predicted pose. Needs A1's
  frame-order map plus a 1070 eye-test to confirm any artifact. Not in the plan.
- **`CameraManager::OnAction` keybind coverage** (`acclient.c:146969-147119` routes ~12 camera
  actions incl. SetDefaultOffsets/ToggleLookDown/ToggleMapMode at `acclient.c:146992-147110`):
  our side has only `C`-cycle + right-drag + wheel; I did not enumerate the DAT 0x14 keymap to
  confirm which retail camera binds are reachable in holtburger-web — single-sided on ours.
  Greps tried: `grep -rn "InHead|firstPerson" scene3d/` (0 camera hits), `grep "camera"` over
  §3.3 backlog docs.
- **`scale` / `SetScale` path** (`acclient.c:147843ff` SetScale at 148130s region,
  `acclient.c:148398` Raise interaction): retail rescales viewer_offset by a global camera
  scale (race/size related?). Could not determine the gameplay trigger from acclient.c alone;
  no our-side counterpart. Left out of the divergence table (retail-side behavior unclear).
