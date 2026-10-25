# Drone Deploy — implementation plan (2026-10-24)

**Status:** implemented and 1070-eye-tested 2026-10-24/25 (phases 0–4); default-on since 2026-10-25 with the `?drone=off` escape. The contract is scene3d/drone/SPEC.md, usage in scene3d/drone/README.md, the eye test in live/EYETEST.md.
Real DAT data pulled for it sits next to this file in `recon/` (Appendix A says how it was produced).
The risky assumptions were checked live on the 1070 the same day, on-screen and muted, with the owner's
OK. Findings are in §13; screenshots and the probe scripts are in `recon/probe/`.

---

## 0. Summary

A new button sits directly under the RynthSuite ⚒ button in the toolbar's add-on column. Clicking it
plays a short local scene on your character:

1. reach into the pack for the drone,
2. kneel and set it on the ground,
3. stand and pull FPV goggles down over the eyes,
4. raise a drone tablet in both hands.

The drone spins up, lifts off and backs away. The view then cuts into the goggles, and the first frame
looks back at your character holding the tablet. You fly the drone with keyboard and mouse or a gamepad,
with an FPV-style OSD, until you recall it. It flies home and lands, and the character puts everything
away in reverse.

Design decisions:

- **Local-only.** Gestures, props and flight are all client-side. A full deploy → fly → stow cycle sends
  nothing to the server (this is an acceptance check, §10), so it is safe on Coldeve. Other players see
  you standing still. An option can also send the real `/read` emote; it is off by default.
- **Reuse film mode's drone stack and add a manual pilot.** `scene3d/film/` already has the multirotor
  flight model, camera ownership (viewer cell, light pool), the collision reflex, world prewarm and FPV
  lens props. New work is a stick-driven control layer, the gestures and props on the rig, the OSD, and
  the HUD button.
- **No Rust/wasm change, so no wasm rebuild.** Every motion uses retail DAT animation frames.
  - The three one-shot gestures (reach into the pack, kneel and place, goggles on) are **JS clips**. Each
    is built from retail animation frame ranges and played through the existing Rust `MotionSequence`
    playhead.
  - The held tablet pose is the retail `ReadState`, set with `setMotion`.
  - Verified on the 1070:
    - a JS clip reproduces the retail frames exactly;
    - `ReadState` enters and leaves smoothly and holds;
    - `setMotion(Pickup)` / `setMotion(StoreInBackpack)` snap back upright, which is why those two are
      clips (§13).
  - The only edits to existing hot files are two small additive seams: `EntityManager.playLocalClip`
    (entities.js) and `AudioManager.getEffectBus` (audio_manager.js).
- **Wielded items are hidden locally for the whole cycle.** A sword or shield would otherwise cut
  through the drone and tablet (seen on the 1070). This uses the existing film seam
  `entityManager.setFilmHidden(childGuid, …)` on the pilot's attached children, restored at the end.
- **One rig covers 11 of the 13 heritages.** Every humanoid heritage, male and female, uses a 34-part
  rig: right hand = part 15, left hand = part 12, head = part 16. Their motion tables point at the same
  animations (`recon/rig-table.json`). Olthoi player rigs have no hands, so props and gestures are
  skipped and the drone simply lifts off beside them.
- **Flag.** `?drone=on` (exact match) during development. After the 1070 eye test it flips to default-on
  with a `?drone=off` escape (project convention).

**How I read "under the RynthSuite button":** a separate button, stacked directly below ⚒ in
`#hb-hotbar .hb-hotbar-addons` (the vertical column on the toolbar's edge). If you meant a button inside
the RynthSuite window, only lane L5 changes.

---

## 1. What already exists (reuse map)

| Need | Existing code | How it's used |
|---|---|---|
| Launcher slot under ⚒ | `plugins/hotbar.js` `.hb-hotbar-addons` (flex column; `__hotbar.addonSlot()`; `hb-hotbar-mounted` event). `plugins/rynth-hud.js` `buildLauncher` / `attachLauncher` / `launcherTick` (flips to the left at the screen edge; fixed float when there is no toolbar) | Same pattern. CSS `order` keeps it below ⚒ whatever the plugin load order |
| Multirotor dynamics | `scene3d/film/drone/flight_model.js` `createDrone(preset)`, `DRONE_PRESETS` (cinema/heavy/fpv/indoor). Jerk-, acceleration- and velocity-limited tracking, tilt from thrust, gimbal or hard mount | Cine mode flies a stick-integrated setpoint through it |
| Camera ownership | `film/runtime/camera_owner.js` `createCameraOwner` (`own` / `release` / `write(pose)`). Viewer cell; the light pool answers with the eye; `liveScene3d.film.preFrame/postRender` via `ensureFilmHooks` | Drives `cameraSwitcher.persp` while in the goggles |
| Never clip into the world | `film/runtime/safety.js` `createSafety(...).clamp(prevPose, desiredPose, ctx)`. Sphere sweep through every collision layer, slides, terrain floor +0.7 m, cell clip, near-lens particle hides | Per-frame clamp, plus contact feedback into the craft |
| World loaded around the drone | `film/runtime/world.js` `createWorld(...).prewarm({points, radius})`. Terrain ring, statics, buildings, envcells, collision, heightmap corridor | Prewarm when the drone enters a new landblock |
| FPV props in frame | `film/runtime/lens_overlay.js` `createLensOverlay` (`configure`, `draw({t, throttle, fov})`) | Angle and acro modes |
| Input-lock precedent | `film/runtime/clean_frame.js`: `__inputFunnel.releaseHeld`, `poison("gate")`, capture-phase blockers, `cameraSwitcher._endFollowDrag`, zeroed `cameraSwitcher.keys` | Same steps, plus the drone's own key/mouse/gamepad layer |
| Local animation on the player rig | `scene3d/entities.js` `setMotion(guid, cmd, stance, speed)` (held emote state = link + cycle). `app/slash_commands.js` `predictLocalEmote` already does exactly this for emotes | ReadState hold and its exit to Ready. Not used for Pickup / StoreInBackpack: they snap upright on the local rig (§13) |
| Custom one-shot | entities.js `_tryUnifiedCycleOneShot` → `inst._unifiedSeq = {seq: MotionSequence.fromDescriptor(...), desc, …}`. `motion/motion_sequence.js` poser (7 floats per part per frame). wasm `fetchAnimation(did)` → `AnimationJs.frames`, same 7-float layout | New `playLocalClip` seam for the pack / place / goggles clips (verified on the 1070) |
| Props on hands and head | entities.js `attachChildToParent` / `_resolveHoldingLocation` (wasm `fetchSetupHoldingLocations`). `_isAttachedChildNode`: `userData.__attachedChildOf` survives part-content swaps | Parent three.js props to rig part groups |
| Abort signals | `plugins/api.js` client events `vitalChangedHealth {current, oldValue}`, `death`. `ui/portal_busy.js` `portalSpaceActive()`. `entityManager.getStance(guid)` | Emergency exit |
| Audio | `scene3d/audio/audio_manager.js` (`_ctx`, `_effectMaster` bus). `scene3d/index.js` keeps the listener on the active camera | Motor hum on the effects bus |

---

## 2. Storyboard

All motions are retail DAT animations in the NonCombat stance (0x8000003D) at 30 fps. Durations come
from frame counts. Coordinates are object space in metres (x right, y forward, z up; male human).

### 2.1 Deploy (≈5.6 s from click to control; quick deploy ≈3 s)

Wielded items are hidden locally before beat 1 and shown again after the stow.

| # | Beat | How | Time | Prop event |
|---|---|---|---|---|
| 1 | Reach into pack and bring the drone out | Clip `pack`: StoreInBackpack anim 0x030003B7, frames 0→19, hold 3 frames, 19→0 | 1.43 s | Frame 18 (0.6 s): the drone appears in the right hand over the shoulder (grip ≈ (−0.06, −0.22, 1.60)) and rides the hand back down |
| 2 | Kneel, place, stand | Clip `place`: Pickup anim 0x03000247, frames 0→21, hold 6 frames, 21→0 | 1.67 s | Frame 18 (0.6 s): the drone detaches into the world, set on the ground under the grip, yaw facing the pilot. Measured on the 1070: grip 0.10 m above the ground, 0.72 m ahead |
| 3 | Goggles on | Clip `goggles`: Cry anim 0x030004F8, frames 0→20, then 20→0 | 1.40 s | Frame 14 (0.47 s): goggles attach to the head (part 16). Measured: both hands within 5–6 cm of the eyes at 0.43 s |
| 4 | Tablet up | `setMotion(ReadState 0x43000146)`: link 0x030003B9, then the 0x030003BA cycle loops | 0.73 s | Link start: tablet attaches to the left hand (part 12) at the solved two-hand grip. Rotors spin up and the hum fades in during this beat |
| 5 | Lift-off and goggle cut | Autopilot rises 1.7 m and backs away 3.4 m over 2.2 s, facing the pilot. The 0.35 s fade into the goggles comes about 0.8 s in (≈1 m up, ≈1.5 m out) | 2.2 s | The first FPV frames show the pilot with goggles and tablet. From the ground the view only shows legs (probe shot 09a). Sticks take over at the end, or earlier on any input |

Notes:

- Clicking the button again during the deploy skips to beat 5.
- Quick deploy (a setting) drops beat 1 and plays the rest at speed 1.5. The drone then appears in the
  hand at the start of the kneel.
- Beats 1–3 are JS clips, not `setMotion`. On the local rig, `setMotion(Pickup)` kneels in 0.64 s and
  then snaps upright in one frame (§13). The clips play down and back up smoothly.

### 2.2 Flying

See §6. **Tab is "pilot view":** the camera goes back to the normal follow camera while the drone holds
position, so you can look at your character wearing goggles and holding the tablet. Tab again returns
to the goggles.

### 2.3 Recall and stow (≈5 s after touchdown; quick ≈2.5 s)

Recall (the button, Shift+F11, or R for return-to-home): the autopilot climbs to at least 15 m AGL,
flies to the drop spot, descends and lands. The view cuts back to the follow camera 5 m before
touchdown, so the stow is seen in third person.

| # | Beat | How | Time | Prop event |
|---|---|---|---|---|
| 1 | Tablet down | `setMotion(Ready)`. Measured smooth: hands 1.36 → 0.85 m over 0.6 s | 0.73 s | End: tablet removed |
| 2 | Goggles off | Clip `goggles` | 1.40 s | Frame 14: goggles removed |
| 3 | Pick up | Clip `place` | 1.67 s | Frame 18: drone back in the right hand |
| 4 | Stow | Clip `pack` | 1.43 s | Frame 18: drone removed. Wielded items shown again at the end |

### 2.4 Abort (within one frame)

**Triggers:**

- taking damage
- dying
- entering portal space
- a stance change to combat
- the pilot moving more than 2 m (teleport or position correction)
- a session or character change
- a film take starting
- WebGL context loss

**What happens:**

- the camera is back on the pilot
- input is restored, any running clip is stopped, and `setMotion(Ready)` is applied
- goggles and tablet are removed, and wielded items are shown again
- the drone auto-lands where it is and fades out after 5 s

Nothing is sent to the server. If the tab is hidden, the drone hovers in place rather than aborting.

---

## 3. Architecture

```
plugins/drone-hud.js (+ drone-hud.manifest.json)  button under ⚒, tooltip and disabled reasons, settings popover.
        │ lazy import on first click             Nothing under scene3d/drone/ loads until it is used.
        ▼
scene3d/drone/index.js     installDrone(deps) → window.__drone (wiring + per-frame driver)
 ├─ sequence.js            pure state machine: states, beats, timers, abort triggers → actions
 ├─ gestures.js            rig profile, gesture clips (pack / place / goggles from fetchAnimation frames), ReadState hold, wielded-item hide
 ├─ props.js               procedural drone / tablet / goggles meshes, attach/detach, material prewarm, dispose
 ├─ manual_flight.js       pure: sticks → craft pose (cine via film createDrone; angle/acro own integrator), contact feedback
 ├─ tether.js              pure: range/signal, ceiling, battery, return-to-home path
 ├─ controls.js            keyboard / pointer-lock mouse / gamepad → sticks; input lock + restore
 ├─ osd.js                 DOM OSD, static/vignette layer, clean view
 ├─ audio.js               WebAudio motor hum on the client effects bus
 └─ world_link.js          film runtime wiring: camera owner, safety, world prewarm, lens overlay, hooks
```

**Rules** (the film convention):

- Page modules get every dependency injected through `installDrone(deps)` and never import stateful
  scene3d modules.
- The pure modules have no DOM, three, wasm, clocks or `Math.random`, and are deterministic: sequence,
  manual_flight, tether, the gestures clip builder, and the osd formatters.
- `scene3d/drone/*` may import the film runtime pieces directly. These are page modules with injected
  deps, and they load without `?filmMode=on`:
  - `film/drone/flight_model.js`
  - `film/core/*`
  - `film/runtime/{camera_owner,safety,world,lens_overlay}.js`
  - `film/scene/{world_query,los,particles_query}.js`
- **No edits to `scene3d/film/*`.**

**Per frame.** These steps run in a `liveScene3d.film.preFrame` listener via `ensureFilmHooks`, so the
pose lands before culling, the viewer cell and CSM read it:

1. `controls.poll()` → sticks (the gamepad is polled here)
2. `sequence.tick(dt, signals)` → actions: beats, autopilot, aborts
3. `craft.step(sticks | autopilot, dt)` → desired pose
4. `tether.clamp(pose)` → range sphere and ceiling
5. `safety.clamp(prevPose, pose, {fovDeg, aspect})` → clamped pose, then `craft.contact(hits)`
6. `cameraOwner.write(pose)` while in the goggles. The drone mesh transform is updated every frame
   either way.
7. OSD at 10 Hz, audio params, and prewarm when the landblock changed. Prewarm runs at most once per
   2 s and is never awaited.

Then, in `postRender`: the lens overlay `draw()` in angle/acro modes. Steps 1–7 allocate nothing per
frame; reuse scratch vectors.

**Edits outside the new files:**

- `scene3d/entities.js` adds `EntityManager.prototype.playLocalClip(guid, desc, {holdFinal = false, speed = 1}) → boolean`
  and `stopLocalClip(guid) → boolean`. These mirror the tail of `_tryUnifiedCycleOneShot`:
  1. `MotionSequence.fromDescriptor(numFrames, framerate, duration, frameTimes, segmentStarts, segmentCounts, false)`
  2. free the previous `_unifiedSeq`
  3. `_clearUnifiedQueue(inst)`
  4. `inst._unifiedSeq = {seq, desc, clearOnDone: !holdFinal, hooks: [], lastHookTime: -1, speed}`

  The record has no `inPlace` flag, so `poseRigAt` writes the clip's raw object-space part frames.
  The change is additive; nothing calls it except the drone.

  The 1070 probe ran exactly these four steps from the console; the clip matched retail Cry frame 17 with
  0 position error (§13).
- `scene3d/audio/audio_manager.js` adds `getEffectBus() → {ctx, node} | null` (the `_effectMaster`
  gain, once the context exists).
- `plugins/index.json` is regenerated with `node plugins/gen-index.mjs`; it is never hand-edited.
- `harness/run-js-headless.mjs` gets tier-5 rows `drone(<topic>)`. Orchestrator only.
- `docs/url-flags.md` gets the flag rows.

---

## 4. Contracts (phase 0 freezes these into `scene3d/drone/SPEC.md`)

### 4.1 `window.__drone` (`DRONE_API_VERSION = "drone-1"`)

Every method returns JSON-safe output. It returns `{ok: false, code, reason}` instead of throwing.

| Method | Does |
|---|---|
| `status()` | `{version, state, mode, since, rig, craft: {pos, vel, hpr, aglM, speed, distHomeM, signal, battery}, input: {source, pointerLocked}, flags, lastAbort}` |
| `deploy({quick?})` | Start the deploy. Refusal reasons: `not-in-world`, `indoors`, `combat`, `moving`, `portal`, `dead`, `film-busy`, `busy` |
| `recall({instant?})` | Return-to-home, then stow. With `instant`, the view cuts back now and the drone flies home in third person |
| `abort(reason)` | Emergency exit (§2.4) |
| `setMode(mode)` | `'cine'`, `'angle'` or `'acro'` |
| `pilotView(on?)` | Follow camera on the pilot while the drone holds position |
| `settings()` / `setSettings(patch)` | §4.5 |
| `tune()` / `tune(patch)` | Prop offsets per setup (dev; persisted) |
| `debug` | Only with `?droneDebug=on`: `setSticks(axes, ms)`, `trigger(signal)`, `clipParity()`, `events()` |

Button behaviour by state:

| State | Click | Shift+click |
|---|---|---|
| idle | deploy | — |
| deploying | skip to flight | — |
| flying | return home and stow | instant recall |
| returning | instant recall | — |
| stowing | ignored | — |

### 4.2 State machine (`sequence.js`, pure)

**States:**

- `idle → deploying(beat) → flying ⇄ pilotView → returning → landing → stowing(beat) → idle`
- `aborting → idle`, reachable from any state
- `crashed → stowing(beats 1, 2) → idle`. The crashed drone fades out where it lies; there is nothing to
  pick up or pack.

**Input per tick:**

```
{dt, now,
 request: 'deploy'|'recall'|'recallInstant'|'abort'|'skip'|'pilotView'|null,
 signals: {damage, death, portal, stanceCombat, pilotMovedM, sessionChanged, filmBusy, contextLost, hidden},
 craft: {landed, aglM, distHomeM, impactSpeed},
 beatDone}
```

**Output:** a list of actions that `index.js` executes:

- `motion(cmd, speed)` (ReadState / Ready only), `clip('pack' | 'place' | 'goggles', speed)`, `stopClip()`, `hideWielded(on)`
- `attach(prop, anchor)`, `detach(prop, 'world'|'remove')`
- `cameraOwn`, `cameraRelease`, `inputLock`, `inputRestore`
- `autopilot(plan | null)`, `rotors(level)`, `osd(mode)`, `audio(level)`

Beat completion is time-based: the §2 duration ÷ speed + 50 ms. The gesture layer may report early
completion. Because the module is pure, every transition is unit-testable.

### 4.3 Module APIs

- **`gestures.js`**
  - `rigProfile({partCount, holdingLocations}) → {kind: 'humanoid' | 'no-hands', rightHand, leftHand, head}`
  - `buildClip(anim, plan, {fps = 30}) → descriptor`. `anim` has the AnimationJs shape
    `{numFrames, numParts, frames}`. `plan` is `[{from, to} | {hold, frames}, …]`; `to < from` plays
    reversed.
  - `GESTURE_CLIPS`:
    ```
    pack:    {anim: 0x030003B7, plan: [{from:0,to:19},{hold:19,frames:3},{from:19,to:0}], eventAtFrame: 18}  // drone appears / is removed
    place:   {anim: 0x03000247, plan: [{from:0,to:21},{hold:21,frames:6},{from:21,to:0}], eventAtFrame: 18}  // drone released / picked up
    goggles: {anim: 0x030004F8, plan: [{from:0,to:20},{from:20,to:0}],                    eventAtFrame: 14}  // goggles on / off
    ```
  - `createGestureDriver({entityManager, wasm, guid})` returns `clip(name, speed)` (resolves at the end;
    fires `eventAtFrame`), `hold(ReadState)` / `release()` via `setMotion`, `stop()`, `hideWielded(on)`,
    and `watchHeld(cmd)`.
- **`props.js`**
  - `createProps({THREE, renderer, scene})` returns:
    - `drone`, `tablet`, `goggles`
    - `attach(prop, rigPart, offset)`, `toWorld(prop, groundZ, yaw)`, `remove(prop)`
    - `setRotor(throttle, t)`, `setScreen(state)`
    - `prewarm(camera)`, `dispose()`
- **`manual_flight.js`**
  - `createManualCraft({mode, presets}) → {reset(pose), step(sticks, dt) → {pos, vel, q, camQ, throttle, landed}, contact(hits), setMode(mode), autopilot(path | null)}`
  - `sticks = {throttle, yaw, pitch, roll, gimbal, boost}`; every axis is in −1..1.
- **`tether.js`**
  - `createTether({rangeM, ceilingAglM, batterySec})` returns:
    - `clamp(pos, home, groundZ) → {pos, signal, limited}`
    - `drain(dt, throttle) → {battery, warn, rth, empty}`
    - `planReturn(from, home, {cruiseAglM}) → path`
- **`controls.js`**
  - `createControls({window, document, canvas, funnel, cameraSwitcher, settings}) → {lock(), restore(), poll(dt) → sticks, onAction(fn), pointerLocked}`
- **`osd.js`**
  - `createOsd({document}) → {show(mode), update(state), staticLevel(signal), clean(on), dispose()}`
  - Plus pure formatters.
- **`audio.js`**
  - `createDroneAudio({bus}) → {start(), update({throttle, speed, distM, fpv}), stop(), dispose()}`
  - Silent no-op when there is no bus.
- **`world_link.js`**
  - `createWorldLink({liveScene3d, THREE, sessionHandle, wasmExports, window, particleManagers?})` returns:
    - `cameraOwner`, `safety`, `world`, `worldQuery`, `lensOverlay()`
    - `groundZ(x, y)`, `prewarmAround(pos)`
    - `hooks`, `dispose()`
  - Built the way `scene3d/film/index.js` builds them (lines ≈370–520).

### 4.4 Flags and storage

| Flag | Default | Effect |
|---|---|---|
| `?drone=on` | off during development; on after the eye test, with a `?drone=off` escape | Mounts the button |
| `?droneDebug=on` | off | `__drone.debug`, gizmos |
| `?droneAudio=off` | on | No motor hum |

Flags are parsed with exact `=== "on"` / `=== "off"`. Storage keys, with every read and write in
try/catch:

- `hb.drone.v1`: settings
- `hb.drone.tune.v1`: prop offsets keyed by setup id

The shipped tuned defaults go in `data/drone-rig-profiles.json` after the eye test.

### 4.5 Settings (defaults)

| Setting | Default |
|---|---|
| mode | `cine` |
| sensitivity | 1.0 |
| invertY | false |
| gamepadLayout | `mode2` |
| acro rates | rc 1.0 / super 0.7 / expo 0 |
| rangeM | 150 (max 180) |
| ceilingAglM | 120 |
| batteryMin | 10 (0 = off) |
| crash | on, at 7 m/s |
| quickDeploy | off |
| launchFacing | `pilot` |
| broadcastPose | off |
| volume | 0.6 |

---

## 5. Rig, animation and props (from the DAT)

### 5.1 Rig profiles (`recon/rig-table.json`)

**humanoid:**

- Aluvian, Gharu'ndim, Sho, Viamontian: 0x02000001 / 0x0200004E with motion table 0x09000001
- Umbraen, Penumbraen, Gear Knight, Tumerok, Lugian, Empyrean, Undead

All have 34 parts, RightHand on part 15, LeftHand on part 12, and the head on part 16 (parts 21 and 22
hang off it). Every one of their motion tables maps NonCombat Ready → Pickup / StoreInBackpack /
ReadState / Cry to the same animations. Empyreans add 0x03000C34 hover segments around them. Larger
races inherit the rig root's scale, so props scale with them.

**no-hands:**

- Olthoi: 0x02001A21, 25 parts
- Acid Olthoi: 0x02001A20, 31 parts

They have no hand holding locations, and every link resolves to one generic animation. They get no
gestures and no handheld props: the drone appears on the ground beside them and lifts off. An unknown
setup is treated as no-hands.

**Detection at deploy:** `fetchSetupHoldingLocations(setupId)` (cached by `_resolveHoldingLocation`)
has RightHand on part 15 and LeftHand on part 12, and the rig has at least 17 parts.

### 5.2 Key frames (object space)

| Anim | Frames | Fact |
|---|---|---|
| Pickup 0x03000247 | 16–21 | Pelvis drops to 0.34 m. Right grip (0.07, 0.72, 0.10) at frame 18 is the release point |
| StoreInBackpack 0x030003B7 | 19 (held) | Right grip (−0.06, −0.22, 1.60), over the shoulder |
| Cry 0x030004F8 | 14–42 | Both grips within 6 cm of the eyes, at (−0.03, 0.24, 1.53) and (0.06, 0.24, 1.53). Frames 49 and later are the sobbing; never played |
| ReadState cycle 0x030003BA | all 35 | Grips (−0.14, 0.34, 1.36) and (0.05, 0.46, 1.33), 0.22 m apart; almost static |

None of these animations has hooks, so playing them cannot fire sounds or particles.

Measured live on the 1070 (male human, per-frame samples):

- **pack clip:** the right hand peaks over the shoulder at about 0.38 s.
- **place clip:** the grip reaches 0.097 m above the ground, 0.723 m ahead, at about 0.6 s, then rises
  smoothly.
- **goggles clip:** both hands come closest to the eyes at about 0.43 s (5.2 cm and 6.1 cm).
- **ReadState:**
  - in: 0.85 → 1.36 m over about 0.7 s
  - out: 1.36 → 0.85 m over about 0.6 s
  - largest per-frame step 4 cm (no snap)

### 5.3 Prop anchors (DAT-derived defaults, placement checked on the 1070; final values tuned with `__drone.tune`)

Placeholder boxes at these anchors looked right on the 1070:

- the goggles sit on the face (shots 04b, 07)
- the tablet sits between both hands at chest height (04c, 07), with its screen side facing the pilot
  (over-the-shoulder shot 07b shows the cyan screen face)
- the drone lands under the hand (08)

- **Tablet → LeftHand (part 12).** Position (−0.105, −0.035, −0.143), quaternion wxyz
  (−0.509, 0.062, −0.685, 0.518). Derived from ReadState frame 0:
  - centre = midpoint of the two hand grips
  - screen normal points at the eyes, (0.08, −0.63, 0.78), about 51° back from vertical
  - width 0.24 m, matching the 0.22 m grip span
- **Goggles → head (part 16).** Position (0, −0.10, 0.085) in head-local. The head part's rest frame is
  rotated 180° about z, so head-local −y points forward. This is an eye-test item.
- **Drone in hand → RightHand holding location.** Part 15, grip frame (0.025, 0, −0.076), rotated 90°
  about x. The drone body is centred on the grip.
- **Drone on the ground.** The world position under the right grip at Pickup frame 18, with
  z = ground height (`worldQuery.groundZ`). Yaw = pilot heading + 180° (`launchFacing: 'pilot'`) or
  + 0° (`'away'`).

### 5.4 Gesture clips (pack, place, goggles)

**`buildClip` output:**

- `fetchAnimation(did).frames` (7 floats per part per frame: xyz, then quaternion w-first; object space),
  sliced and concatenated per the plan. For example, goggles = frames 0..20 then 20..0: 42 frames, 1.40 s.
- framerate 30, `frameTimes[k] = k/30`, one segment (`segmentStarts [0]`, `segmentCounts [n]`)
- **`posFrames: null`.** Not an empty array: `poseRigAt`'s non-in-place branch reads `posFrames[f*3]`,
  so an empty array would add `undefined` and produce NaN positions.
- no `rootFrames`, because the one-shot record has no `inPlace`, so the frames are written as-is
- the record gets `hooks: []`

**Verified on the 1070:** the live rig matched the retail frame exactly while the clip played (Cry frame
17, position error 0), so the layout and the space are confirmed.

**Guard:** `anim.numParts` must equal the rig's part count. Otherwise skip the gesture; the props then just
appear and disappear at the beat times.

**Why clips:**

- `setMotion(Pickup 0x40000018)` and `setMotion(StoreInBackpack 0x40000019)` on the local rig play the
  descent, then snap upright in one frame. The grip went 0.10 → 0.80 m between two frames (§13).
- Only the 0x43 held emote state (ReadState) enters and leaves smoothly through `setMotion`.

**Live check:** `__drone.debug.clipParity()` reruns the frame-match on the current rig.

### 5.5 Attachment rules

- Parent each prop to `inst.parts[i]`.
- Set `root.userData.__attachedChildOf = pilotGuid`. entities.js `_isAttachedChildNode` then keeps it
  through part-content swaps.
- Never set `__disposable`. The drone module disposes its own meshes.
- Check the pilot's rig instance at 4 Hz (`entityMap.get(guid)` identity). An appearance respawn
  rebuilds the rig; when that happens, re-attach.
- `toWorld`: `droneGroup.attach(prop)` keeps the world transform; then snap to the ground. `droneGroup`
  is a child of `liveScene3d.scene`, not of `entitiesGroup`.
- Held-motion watchdog: while flying, if the local rig's held motion is no longer ReadState and no abort
  fired, re-issue it, at most once per second. On the 1070 nothing touched ReadState in 10+ s idle; the
  watchdog stays as insurance against server motion updates.
- Wielded items:
  - Before the first beat, call `entityManager.setFilmHidden(guid, true)` for each guid in
    `inst._attachedChildren`.
  - After the stow, or on abort, set the same guids back to `false`.
  - Never call `clearAllFilmHidden()`: it would clear film's own hides.
  - Verified: it hid the sword and restored it.

### 5.6 Prop look

**Constraints:**

- Procedural, with stock three materials only (`MeshStandardMaterial` / `MeshBasicMaterial`). The
  renderer runs `logarithmicDepthBuffer`, which built-in materials handle. A custom ShaderMaterial would
  need `scene3d/shader_logdepth.js`.
- No `onBeforeCompile` and no `customProgramCacheKey`.
- **No lights.** Changing the light count forces a shader relink freeze. LEDs and screens are emissive.

**Drone** (≈0.32 m span, ≈600 tris):

- AC-flavoured brass-and-iron quad with a glowing mana-crystal camera
- two-blade rotors that become a translucent blur disc above 30 % throttle
- emissive LEDs: front white, rear red, blinking
- a soft blob-shadow disc near the ground (no shadow casting)

**Tablet** (0.24 × 0.16 × 0.012 m):

- brass frame
- CanvasTexture screen, 256×160: signal, battery, home arrow, "LIVE"
- the screen redraws at 4 Hz, and only while it can be seen (pilot view, cutscenes)

**Goggles** (0.18 × 0.07 × 0.08 m):

- dark visor block with two lens panels, a strap and a stub antenna
- red emissive REC pip

**Compile once, in idle time after login,** with `renderer.compileAsync(group, camera, scene)`, so the
first deploy has no shader hitch.

---

## 6. Flight and controls

### 6.1 Modes

- **Cine** (default; position hold, like a camera drone).
  - Sticks set velocity in the yaw frame: 12 m/s, 20 m/s with boost, 4 m/s vertical, 90°/s yaw.
  - A setpoint integrates them with a 3 m leash, so there is no wind-up against walls.
  - `createDrone('cinema')` flies the setpoint, which gives inertia, lean into acceleration and gimbal
    lag.
  - Mouse Y tilts the gimbal (−90°…+30°).
  - Releasing the keys brakes to a hover.
- **Angle** (self-levelling FPV).
  - Sticks set tilt (up to 35°) and yaw rate (up to 200°/s).
  - Auto-throttle holds altitude unless up or down is held.
  - Hard-mounted camera with 20° uptilt; lens props on.
- **Acro** (gamepad recommended).
  - Sticks set body rates (Betaflight-style rc/super/expo, ≈670°/s at the defaults) and collective
    thrust (0–2.5 g).
  - Gravity and quadratic drag.
  - 25° uptilt; lens props on.

Angle and acro use a small rigid-body integrator in `manual_flight.js`, sub-stepped at 1/240 s like
`flight_model.js`. Cine reuses `createDrone`.

### 6.2 Control map

| Action | Keyboard / mouse | Gamepad (mode 2) |
|---|---|---|
| Forward / back | W / S | right stick Y |
| Strafe (roll) | A / D | right stick X |
| Yaw | Q / E, mouse X (pointer-locked) | left stick X |
| Up / down | Space / C | left stick Y |
| Gimbal tilt (cine) | mouse Y | LT / RT |
| Boost | Shift | RB |
| Field of view 60–110° | wheel | — |
| Mode | M | Y |
| Pilot view | Tab | View / Back |
| Hide HUD | H | — |
| Return home | R | A |
| Recall and stow | Shift+F11 or the button | hold B |

- Pointer lock starts on the first canvas click while flying.
- Esc releases pointer lock (browser behaviour), and the drone hovers. Esc is otherwise left to the
  client.
- Gamepad sticks use deadzone 0.08 and expo 0.3.
- Rebinding through Options → Controls is v2.

### 6.3 Collision and crashes

Every frame, `safety.clamp(prev, desired, {fovDeg, aspect})`:

- sphere-sweeps through terrain, buildings, statics, scenery, cells and creatures
- slides along hits
- keeps the eye ≥ 0.7 m above the terrain

Its hits feed back into the craft through `contact`: velocity along the hit normal is removed and
position becomes the clamped one, so the craft never keeps integrating into a wall.

An impact above 7 m/s is a crash (configurable):

- the OSD shows "CRASH" and the drone tumbles to the ground
- the view cuts back to the pilot after 1 s of static
- stow beats 1 and 2 play (tablet down, goggles off), and the crashed drone fades out after 5 s

### 6.4 Range, ceiling, battery, return-to-home

- **Range.**
  - Signal is 100 % out to 100 m and falls to 0 at 150 m.
  - At the limit the setpoint is projected back inside the sphere, and the OSD shows "RANGE LIMIT".
  - Static noise rises as the signal drops.
  - Hard cap 180 m, because the client's 3×3 terrain ring around the player's landblock always reaches at
    least 192 m in every direction, and ACE sends objects for about that same neighbourhood. So the drone
    never flies into unloaded ground and never shows anything the server hadn't already sent.
- **Ceiling.** 120 m AGL.
- **Battery** (10 min by default; `batteryMin: 0` turns it off).
  - Warning at 20 %.
  - Automatic return-to-home at 10 %, which can be cancelled once.
  - Forced landing at 0.
- **Return-to-home.**
  - Climb to max(current, 15 m AGL), cruise straight, descend over the drop spot, land.
  - `createDrone('cinema')` flies it along the path.
  - Any stick input cancels it, except the forced one.

### 6.5 Camera transitions

- **Goggle cut.** A 0.35 s fade through black with an OSD boot wipe, then `cameraOwner.own()` and the
  FPV pose. The cut comes about 0.8 s into the lift-off, with the drone ≈1 m up and ≈1.5 m out. Cutting
  at ground level shows only the pilot's legs (shot 09a). The end of the move frames the whole pilot with
  goggles and tablet (09c).
  - Checked on the 1070 with film's `createCameraOwner` and `createDrone('cinema')` loaded outside film
    mode: own, 502 pose writes with 0 rejected, the light pool anchored at the eye, and a clean release.
- **Pilot view (Tab).** `cameraOwner.release()` puts the follow camera back on the pilot while the craft
  holds position; Tab owns the camera again. The follow camera may fade an avatar it thinks is too close;
  that is an eye-test item.
- **Landing.** The view cuts back 5 m before touchdown, so the stow is seen in third person.

### 6.6 OSD (DOM, `#hb-drone-osd`)

**Layout:**

- top-left: mode, battery, flight timer
- top-right: signal bars, distance home, altitude AGL, speed
- centre: crosshair (cine) or horizon line (angle/acro)
- bottom: heading tape with a home arrow
- first flight: a controls cheat sheet that fades after 5 s

**Effects:**

- edge vignette
- a static layer: a pre-generated noise tile whose opacity follows signal loss
- banners: RANGE LIMIT, LOW BATTERY, RETURNING, CRASH

**Update rates:** text at 10 Hz; the heading tape moves by CSS transform every frame.

**H** hides the client HUD using film's clean CSS only (no input lock).

### 6.7 Audio

- **Synthesis.** Two detuned sawtooth oscillators through a low-pass filter, plus band-passed noise for
  prop wash. Pitch and level follow throttle and speed.
- **Placement.** In the goggles it plays in-ear; in third person it goes through a PannerNode at the
  drone.
- **Routing.** Through `audioManager.getEffectBus()`, so the master and effects sliders and mute apply.
- **World sounds.** These are heard at the active camera (`scene3d/index.js` keeps the listener there),
  so in the goggles you hear the drone's surroundings, not the pilot's. That is another reason damage
  must abort (§2.4).

---

## 7. Client integration notes

- **Camera.** `createCameraOwner` drives `cameraSwitcher.persp`, which every system reads. It also
  carries the viewer cell and answers the light pool with the eye position, so torches near the drone
  stay lit. v1 is outdoors only, so the viewer cell stays 0.
- **Streaming.** Call `world.prewarm({points: [pos], radius: 96, maxLandblocks: 4})` whenever the drone
  enters a new landblock: at most once per 2 s, and never awaited by the frame. This covers statics,
  buildings and collision in the neighbouring landblocks the flight reaches.
- **Input lock** (`controls.js`, at the goggle cut):
  1. `__inputFunnel.releaseHeld("drone")`
  2. `poison("gate")`, only if the funnel isn't already poisoned; remember whether we did it
  3. `cameraSwitcher._endFollowDrag?.()`
  4. zero `cameraSwitcher.keys`
  5. add window capture-phase listeners that call `preventDefault()` + `stopImmediatePropagation()` on:
     - drone-bound key codes, but not while a text input has focus, so chat keeps working
     - pointer, mouse, click, dblclick, contextmenu and wheel events on the canvas, which blocks picking
       and the follow camera

  `restore()` undoes each step. F-key panels and chat Enter sit outside the funnel and stay usable.
- **Button** (`plugins/drone-hud.js`).
  - **Look:** `.dhud-launcher`, 30×30 like `.rhud-launcher` (same sprite and border), with an inline SVG
    quadcopter icon.
  - **Position:** `order: 10`, so it stacks under ⚒ whatever the plugin load order. It mounts through
    `window.__hotbar.addonSlot()` or the `hb-hotbar-mounted` event. With no toolbar, it becomes a fixed
    float at `right: 12px; bottom: 84px`, under RynthSuite's float at `bottom: 120px`.
  - **Status dot:** grey idle, amber deploying or returning, green flying, red refused.
  - **Disabled states:** the reason is the tooltip (indoors, combat, portal space, dead, film take,
    Olthoi "no hands").
  - **Manifest:**
    - id `drone-hud`, name "Drone", `iconHidden: true`, slots `["hud", "overlay"]`
    - hotkey `{id: "toggle", default: "Shift+F11", label: "Deploy / recall drone"}`. Shift+F11 is free
      today: F11 is the Skills tab and Shift+F12 is RynthSuite.
  - **Settings:** right-click opens a small settings popover in the hud_kit look.
- **Film coexistence.** Deploy refuses while `window.__film?.status?.()` reports a take or an owned
  camera. Film sessions boot with `plugins=none`, so the button doesn't exist there.
- **Performance budget.**
  - ≤ 3 extra draw calls for props in the goggles view (the drone itself is behind the camera)
  - ≤ 6 for the lens overlay
  - no per-frame allocation in the controller
  - FPS while flying within 5 % of walking at the same spot

---

## 8. Coldeve (public ACE server)

- **Nothing is sent.** Deploy, flight and stow send nothing to the server.
  - `__diag.wire.summary()` counts **inbound** events, so it can't prove this.
  - The acceptance check wraps `WebSocket.prototype.send` and counts outbound game actions by opcode.
    Each one is `0xF7B1` (LE) + u32 sequence + u32 opcode inside the `[port u16][AC packet]` frame.
    Compare a full cycle against an idle baseline of the same length.
  - Measured on the 1070 with this counter (`recon/probe/scripts/probe2.mjs`): idle 15 s sent 13 ×
    `0x01E9` (Character_RequestPing) and nothing else. The gesture run (pack, place, goggles, tablet)
    sent 15 × `0x01E9` and nothing else: no `0xF61C` MoveToState, no emote, no other action.
- **`broadcastPose`** (default off) sends the real `/read` emote at tablet-up, through
  `window.__routeSlashCommand(handle, "/read")`, the same path as typing it. Other players then see the
  reading pose. Nothing else is ever sent.
- **No automation against Coldeve.** Any automated or bot-driven check runs against the local ACE on this
  laptop, and only when you ask for that run (see §9, phase 2).

---

## 9. Workflow plan

### 9.1 Shared brief (PRE) — include in every agent prompt

The CLAUDE.md rule, verbatim:

> Parallel agents may read, edit and run TARGETED single tests only (`node test_x.mjs`). They must NOT
> run the full JS gate, cargo, wasm-pack or browsers. The orchestrator runs the full gate and builds
> ONCE, after merging, one at a time.

Plus:

- **Scope.** Edit only your lane's files. No git state changes, no pushing, no self-armed automation
  (cron, loops, hooks). No servers, browsers, dotnet or cargo. The laptop has 8 GB.
- **Inputs.** Read this PLAN and `scene3d/drone/SPEC.md` completely first. Code exactly against the SPEC
  names, and report any deviation.
- **Tests** follow the film-workflow conventions:
  - files are `tests/drone_<topic>.test.mjs`, using `node:assert/strict`
  - a local `check(name, fn)` prints `[PASS]` / `[FAIL]`, then a summary line; `process.exit(1)` on failure
  - a header comment with WHY, the flag, and the run line
  - tests import and execute the real modules, with fakes for the rest
  - no SKIP banners; each suite under 30 s
- **Code conventions:**
  - JSDoc on every export
  - no new npm dependencies
  - three comes from the import map (`"three"`); tests use the `_three_stub*.mjs` loaders
  - flags parse with exact `=== "on"` / `=== "off"`. `!== "off"` silently defaults to on.
  - never use `rg -rln` (`-r` is `--replace`)
- **Messaging.** No cross-agent messages. Everything goes through the orchestrator's report.
- **Report schema** (as in the film workflows):
  `{lane, files: [{path, purpose}], exports, tests: [{file, command, passed, failed}], deviations, gaps, notesForOthers}`

### 9.2 Phase 0: spec freeze (1 agent)

The agent turns §4 into `scene3d/drone/SPEC.md`, then confirms each assumption below by reading the
code, marking each one confirmed or amended. If an assumption fails, it amends the SPEC, not code.
A1–A4 were already settled live on the 1070 (§13); the agent records those results and checks the rest.

- **A1 (amended, 1070).** `setMotion(ReadState)` enters, holds (10+ s with no stomp) and leaves smoothly
  on the local rig. `setMotion(Pickup | StoreInBackpack)` snaps upright after the descent, so those beats
  are clips. Still to read in code: why the 0x40 substates snap back (cmdInterp Ready lane /
  `_readyIssue`), only to document it.
- **A2 (confirmed, 1070).** A JS-built descriptor in `inst._unifiedSeq` plays through the poser.
  `playLocalClip` is enough; no Rust change.
- **A3 (confirmed, 1070).** `AnimationJs.frames` has the same layout and space the poser writes (exact
  frame match).
- **A4 (partly confirmed, 1070).** `createCameraOwner` and `createDrone` construct and run outside
  `?filmMode=on`. Still to check: `createSafety`, `createWorld` (prewarm), `createWorldQuery` and
  `createLensOverlay`, built from `{liveScene3d, THREE, sessionHandle, wasmExports, window}` plus the
  particle manager exports.
- **A5.** `window.__inputFunnel` exists at plugin mount, and `poison` / `unpoison` / `releaseHeld` behave
  as `clean_frame.js` assumes.
- **A6.** `liveScene3d.audioManager` is stamped onto the same object `window.liveScene3d` points to
  (`scene3d/index.js` ≈6923).
- **A7.** How a plugin reaches the client event bus (`vitalChangedHealth`, `death`). Fallback: poll the
  local vitals from the session handle at 4 Hz.

### 9.3 Phase 1: build, five lanes in parallel (file-disjoint)

| Lane | Owns | Tests |
|---|---|---|
| L1 FLIGHT | `scene3d/drone/manual_flight.js`, `tether.js` | drone_flight, drone_tether |
| L2 RIG | `scene3d/drone/gestures.js`, `props.js`; the seam in `scene3d/entities.js` (the only lane allowed to touch it); `fixtures/drone/` (copied from `recon/`) | drone_gestures, drone_props, drone_entities_seam |
| L3 INPUT / OSD / AUDIO | `scene3d/drone/controls.js`, `osd.js`, `audio.js`; the seam in `scene3d/audio/audio_manager.js` (the only lane allowed to touch it) | drone_controls, drone_osd, drone_audio |
| L4 CORE | `scene3d/drone/sequence.js`, `world_link.js`, `index.js` | drone_sequence, drone_api |
| L5 HUD | `plugins/drone-hud.js`, `plugins/drone-hud.manifest.json`, `plugins/index.json` (via gen-index.mjs), `scene3d/drone/README.md`, `docs/url-flags.md` rows | drone_hud, `node test_plugin_index_gen.mjs` |

L4 codes against the SPEC, using fakes for the other lanes' modules; the orchestrator reconciles them.

**What each suite must pin:**

- **drone_flight:**
  - cine holds position within 0.1 m at zero sticks
  - full stick reaches vmax and stops within braking distance after release
  - yaw-rate limit holds
  - the leash prevents wind-up when contact blocks the craft
  - angle mode levels within 0.5 s
  - acro hover thrust is 1 g
  - terminal velocity from drag
  - deterministic for identical inputs
  - NaN-free at dt = 0 and at huge dt
- **drone_tether:**
  - signal curve, range projection, the 180 m cap, ceiling
  - battery drain, warning, RTH, empty
  - the return path is continuous (climb → cruise → descend) and lands on the home point
- **drone_gestures:**
  - `buildClip` on the real frames (fixture) for pack (43 frames), place (50) and goggles (42):
    - reversed halves are in the right order
    - holds repeat the right frame
    - `frameTimes = k/30`
    - `posFrames === null` (never an empty array)
  - the event frame fires once per clip
  - refuses a part-count mismatch
  - `rigProfile` on the real rig table: humanoid ×11, no-hands ×2
  - driver call order against a fake entityManager: clips through `playLocalClip`, ReadState / Ready
    through `setMotion`
  - `hideWielded` round trip touches only the pilot's attached children
- **drone_props:**
  - build + dispose leaves no geometry, material or texture behind
  - no Light objects
  - stock materials only (no `onBeforeCompile` / `customProgramCacheKey` / ShaderMaterial)
  - attach sets `__attachedChildOf` and not `__disposable`
  - `toWorld` keeps the world transform
- **drone_entities_seam:**
  - `playLocalClip` installs `_unifiedSeq` with the given descriptor and clears the queue
  - `stopLocalClip` frees it
  - an unknown guid returns false
- **drone_controls:**
  - key → stick mapping
  - a focused text input passes keys through
  - gamepad deadzone and expo
  - lock/restore round trip against a fake funnel: only un-poisons what it poisoned
  - against a fake window: every listener is removed
- **drone_osd / drone_audio:**
  - formatters; static level from signal
  - audio is a no-op without a bus and disconnects everything on dispose
- **drone_sequence:**
  - every transition, skip, quick deploy
  - each abort signal from every state
  - deploy and recall are idempotent
  - the crash path and pilot view
- **drone_api:**
  - `installDrone` with fakes: deploy → 120 flying ticks → recall → idle
  - afterwards the camera is released, the funnel gate is open, and no listeners or hooks remain
  - `__drone` never throws and its output is JSON-safe
- **drone_hud:**
  - the launcher orders after ⚒
  - fallback float
  - disabled reasons
  - exact `?drone` flag match

### 9.4 Phase 2: integrate (orchestrator, one heavy job at a time)

1. Merge. Add the tier-5 rows to `harness/run-js-headless.mjs`, e.g.
   `{ tier: 5, flag: "drone(sequence)", file: "tests/drone_sequence.test.mjs" }`.
2. Run each drone suite one at a time, plus `film_runtime_camera`, `film_hooks`, and the entity suites
   the seam touches.
3. Check `free -m` (need ≥ 2.5 GB available), then run `capped-build node harness/run-js-headless.mjs`
   once.
4. If it's red: one fix agent (targeted tests only), then re-run the gate once.
5. No wasm build is needed; this is pure JS. Rebuild `pkg/` only if a pull made it stale.
6. **Live functional smoke on the 1070.** You allowed on-screen 1070 testing on 2026-10-24; never on the
   8 GB laptop. Use the probe recipe in `recon/probe/scripts/`:
   - a separate Chrome profile, `--mute-audio`, launched through `hidden-run.vbs`
   - CDP on :9333 through the existing tunnel
   - log in as the local ACE test account with `server_host=127.0.0.1` pinned; never the owner's Coldeve
     profile or session
   - URL flags `?nosw=1&drone=on&droneDebug=on`
   - `__drone.deploy({quick: true})`, `debug.setSticks(...)` for a few seconds, then `recall()`

   Assert:
   - the state sequence
   - zero console errors
   - zero extra outbound game actions (the send counter, §8)
   - the gate reopened and the camera released

   Then log out, close that Chrome by its profile, and delete its task.

### 9.5 Phase 3: review (two read-only agents in parallel), then one fix agent

- **R1 — lifecycle.**
  - every state × every abort signal
  - every restore path: camera, funnel, listeners, pointer lock, props, motions, audio, hooks
  - rig rebuild mid-flight; tab hidden; logout
- **R2 — seams and cost.**
  - the two hot-file seams
  - input conflicts with camera.js, picking.js and escape_action.js
  - per-frame allocation
  - light count unchanged; material programs
  - prewarm storms

### 9.6 Phase 4: owner eye test on the 1070

- Batched and muted, with `?nosw=1&drone=on`. On-screen is fine (owner, 2026-10-24).
- Run the checklist in §10.
- Record the tuned offsets with `__drone.tune()` into `data/drone-rig-profiles.json`.
- Then flip `?drone` to default-on with the `=off` escape, and update `url-flags.md`.

**Budget:** 1 + 5 + 1 + 2 + 1 = 10 agents.

---

## 10. Verification

**Default verification:** the node suites (§9.3) and the full gate (§9.4).

**1070 eye-test checklist** (on-screen allowed; audio muted; local ACE only):

| # | Check |
|---|---|
| E1 | The button sits under ⚒ and moves with the column when it flips; tooltips and disabled reasons are right |
| E2 | Deploy on a human male and female, plus a Lugian, Tumerok or Empyrean if a character exists. The drone comes from the pack and sits on the ground (no float or sink). The goggles sit over the eyes (no clipping, also with a helmet). The tablet is in both hands, facing the face |
| E3 | The lift-off reveal frame looks right, with no camera pop |
| E4 | Flight:<br>• cine is smooth at 60 and 30 fps<br>• a building and a tree: it slides, no clipping<br>• the terrain floor holds<br>• range static and RANGE LIMIT appear<br>• with battery set to 1 min, return-to-home triggers<br>• pilot view shows the character with goggles and tablet |
| E5 | Recall and stow land on the drop spot, all props are gone, and movement works immediately |
| E6 | Getting hit while flying (or `debug.trigger('damage')`) puts the camera back in one frame with input live |
| E7 | FPS flying vs walking at the same spot (≤ 5 % loss); no first-deploy frame over 50 ms; no console errors |
| E8 | The 1070 run stays muted; check the hum on the laptop instead |
| E9 | No outbound game actions over a full cycle beyond the idle `0x01E9` pings (the send counter, §8) |

**Done** = E1–E9 pass, the gate is green, and the flag is flipped.

---

## 11. Defaults to confirm, and risks

**Defaults chosen** (change any before the workflow runs):

- **D1.** Its own button under ⚒ in the toolbar column. Alternative: inside the RynthSuite window.
- **D2.** Local-only, with the `/read` broadcast off.
- **D3.** An AC-flavoured brass quad with a mana-crystal camera. Alternative: a modern carbon FPV quad.
- **D4.** Outdoors only in v1.
- **D5.** Range 150 m, battery 10 min, crashes on.
- **D6.** The drone launches facing the pilot (the reveal shot).

**Risks:**

- **R1. Something re-issues Ready on the local rig mid-flight** (a server UpdateMotion, a local lane).
  *Mitigation:* the held-motion watchdog re-asserts ReadState; A1 checks the local lanes.
- **R2. Goggle and tablet offsets differ by head model or helmet.**
  *Mitigation:* DAT defaults, `tune()`, and a per-setup table from the eye test. Helmets may need a larger
  goggle scale.
- **R3. `playLocalClip` could collide with a queued server gesture.**
  *Mitigation:* `_clearUnifiedQueue`, and the clip only plays while the funnel is locked, so there are no
  player-initiated actions.
- **R4. First-use shader compile hitch on ANGLE/D3D11.**
  *Mitigation:* `compileAsync` prewarm after login.
- **R5. Prewarm storms when flying along landblock edges.**
  *Mitigation:* at most once per 2 s, at most 4 landblocks, never awaited.
- **R6. `poison("gate")` is a single global slot shared with film's clean frame.**
  *Mitigation:* mutual exclusion with film, and restore only what we set.
- **R7. Acro on a keyboard is hard.**
  *Mitigation:* the keyboard defaults to cine or angle, and acro shows a "gamepad recommended" hint.
- **R8. In pilot view, the follow camera's near-fade could hide the pilot when the drone hovers close.**
  *Mitigation:* eye-test items E2 and E4.
- **R9. Empyreans' motion links wrap these animations in 0x03000C34 hover segments.** The clips are built
  from the shared animations alone, so an Empyrean may drop to foot level during a clip and pop back up.
  *Mitigation:* for Empyrean setups, prepend and append the 0x03000C34 frames in the clip plan, or fall
  back to plain `setMotion` for that rig. Eye-test E2 on an Empyrean.
- **R10. Weapons and shields in hand cut through the props** (seen on the 1070 with a sword).
  *Mitigation:* `hideWielded` for the whole cycle (verified). Watch that a server ObjDesc/wield update
  mid-flight doesn't re-show them; re-apply at 4 Hz with the rig watch.

---

## 12. Later (v2, not in this plan)

- Dungeon flight (indoor preset, carrying the viewer cell)
- Recording through film's WebCodecs recorder
- A live tablet feed (render-to-texture)
- Orbit, follow-me and reveal autopilot using film's `drone.*` techniques
- Rebinding in Options → Controls
- A picture-in-picture pilot camera

---

## 13. Verified live on the 1070 (2026-10-24)

**Setup:**

- GTX 1070 / ANGLE D3D11, on-screen, `--mute-audio`, with a separate Chrome profile
- the local ACE (`+Tester`, a human male on Setup 0x02000001 with motion table 0x09000001)
- everything was done from the console with placeholder boxes; no client code was changed
- zero page errors throughout
- afterwards: logged out, that Chrome closed, its task and profile deleted

**Recipe:** `recon/probe/scripts/` (`lib.mjs` reads the test password from `scripts/perf-worker/hbbench.mjs`
at runtime). **Shots:** `recon/probe/*.jpg`.

| Question | Result | Evidence |
|---|---|---|
| Do Pickup / StoreInBackpack hold through `setMotion` on the local rig? | **No.** The kneel descends in 0.64 s, then the grip jumps 0.10 → 0.80 m in one frame. Use clips | probe3 curve; shots 01, 02 |
| Does a JS-built clip play through `_unifiedSeq`? | **Yes.** The live rig matched retail Cry frame 17 (0 position error) and stood back up smoothly | probe; shots 03, 08, 08b |
| Kneel-and-place clip | Released at 0.6 s with the grip 0.097 m above the ground, 0.723 m ahead; drone on the ground at the hand | shot 08 |
| Goggles clip | Both hands 5–6 cm from the eyes at 0.43 s; goggles anchor on the face | shots 03, 04b, 07 |
| ReadState | Smooth in (0.7 s) and out (0.6 s); held 10+ s with nothing re-issuing Ready | probe4, probe5; shot 05 |
| Tablet anchor | Between both hands at chest height; screen side faces the pilot | shots 04c, 07, 07b |
| Wielded sword | Cuts through the tablet; `setFilmHidden(child)` hides and restores it | shots 04 vs 07 |
| Film camera owner + flight model outside film mode | Work: own, 502 writes / 0 rejected, eye-anchored light pool, clean release | probe4; shots 09a–c |
| Goggle-cut framing | From the ground: legs only. Mid-climb to the end: the full pilot with goggles and tablet | 09a vs 09c |
| Outbound traffic from the gestures | None beyond the idle `0x01E9` pings (13 idle vs 15 during the run, same 15 s windows) | probe2 send counter |

**Not exercised yet** (phase 0 / phase 2): `createSafety`, `createWorld` prewarm, the lens overlay,
input lock, audio, the HUD button, and non-human rigs (Lugian, Tumerok, Empyrean, Olthoi).

## Appendix A — DAT facts

| Motion | Value | Kind | Human motion table, NonCombat Ready → | Length |
|---|---|---|---|---|
| Ready | 0x41000003 | substate | — | — |
| StoreInBackpack | 0x40000019 | substate (snaps back on the local rig, so used as a clip) | link 0x030003B7 (20 frames); cycle holds frame 19 | 0.67 s |
| Pickup | 0x40000018 | substate (snaps back on the local rig, so used as a clip) | link 0x03000247 (22 frames); cycle holds the last frame | 0.73 s |
| ReadState | 0x43000146 | held emote state | link 0x030003B9 (22 frames) + cycle 0x030003BA (35 frames, loops) | 0.73 s |
| Cry | 0x1300007F | one-shot emote | 0x030004F8 (85 frames) | 2.83 s (only 0–20 is used) |

Other facts:

- The stance is NonCombat (0x8000003D).
- None of these five animations has hooks.

**Recon files:**

- `recon/anims.json` holds the full frames of the five animations in the AnimationJs layout, for tests.
- `recon/rig-table.json` holds each heritage × sex → setup, motion table, part count, hand parts, and
  the four links. It also holds the human Setup's holding locations, parent indices and default
  placement frames.

**How they were produced:** WorldBuilder.Terminal `chorizite-parse-dat-record` on
`~/ac_base_dats/client_portal.dat`, reading CharGen 0x0E000002, every player Setup and MotionTable, and
the five Animations. The Coldeve session wasn't needed: the client reads the same DAT.

**Live probe (§13):** `recon/probe/*.jpg` and `recon/probe/scripts/`.

- `lib.mjs`: CDP connect, plus the local login URL with the server pinned to 127.0.0.1
- `probe.mjs` … `probe5.mjs`: motions, clips, props, timings, the send counter, the camera owner
- `cleanup.mjs`: undo everything in the page, then about:blank

To run them you need:

- a `node_modules/playwright-core` symlink next to the scripts
  (`~/.npm/_npx/*/node_modules/playwright-core`)
- the 1070 tunnel with `-L 9333 -R 8765 -R 8080`
- a muted, separate-profile Chrome on the box (fleet runbook MODE2i launcher pattern)

## Appendix B — code anchors (2026-10-24; symbols are stable, line numbers drift)

- **`plugins/hotbar.js`**
  - `.hb-hotbar-addons` CSS ≈620
  - `addonSlot()` ≈1984
  - `hb-hotbar-mounted` event ≈1527
- **`plugins/rynth-hud.js`**
  - `buildLauncher` ≈1106, `attachLauncher` ≈1124, `launcherTick` ≈1145
  - `FLOAT_ID` CSS ≈252
  - `mount` ≈1247
- **`scene3d/entities.js`**
  - `_isAttachedChildNode` 3528
  - `setFilmHidden` 7507
  - `attachChildToParent` 7607, `_resolveHoldingLocation` 7962
  - `_tryUnifiedCycleOneShot` 11127, `_clearUnifiedQueue` 11323
  - `setSwingMotion` 11538, `setMotion` 12008
- **`scene3d/motion/motion_sequence.js`:** poser with exact in-place via `rootFrames`
- **`scene3d/animation.js`:** `buildSequenceDescriptor` ≈72
- **`app/slash_commands.js`:** `predictLocalEmote` 430, `runSoulEmote` 459
- **`scene3d/film/index.js`:** runtime wiring ≈370–520
- **`scene3d/film/runtime/`**
  - `camera_owner.js`: `ensureFilmHooks` 164, `createCameraOwner` 288
  - `safety.js`: `createSafety` 118
  - `world.js`: `createWorld` 194, `playerPose` 244, `prewarm` 621, `actor` ≈778
  - `lens_overlay.js`: `createLensOverlay` 304 (`configure` 469, `draw` 537)
  - `clean_frame.js`: input lock ≈177–205
- **`scene3d/film/drone/flight_model.js`:** `DRONE_PRESETS` 93, `createDrone` 361
- **`ui/input-funnel.js`:** `releaseHeld` 567, `poison` 724, `unpoison` 728, `window.__inputFunnel` 764
- **`ui/portal_busy.js`:** `portalSpaceActive` 43
- **`scene3d/audio/audio_manager.js`:** `_effectMaster` created ≈406
- **`scene3d/index.js`**
  - audio listener on the active camera ≈2950
  - `liveScene3d` literal 4125 (`wasmExports` and `sessionHandle` ≈4851), `window.liveScene3d` 4854
  - `audioManager` stamped ≈6923
- **`plugins/api.js`:** client events (`vitalChangedHealth`, `death`) ≈480–520
- **`harness/run-js-headless.mjs`:** tier-5 film rows ≈1186
