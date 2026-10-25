# Drone Deploy (`scene3d/drone/`)

**`SPEC.md` (next to this file) is the contract.** Every module name, signature, shape, order and constant
lives there; where this README, `docs/drone-deploy-2026-10-24/PLAN.md` (the intent) or a comment disagrees with
it, the SPEC wins. Changing a contract goes through the orchestrator, never through a lane.

## Purpose

A toolbar button directly under RynthSuite's ⚒ plays a short local scene on your character: reach into the pack
for the drone, kneel and set it down, pull FPV goggles on. The drone spins up while the goggles go on and lifts off
as the tablet comes up, the view cuts into the goggles, and you fly it with keyboard and pointer-locked mouse or a
gamepad, with an FPV OSD, until you recall it. After a 3 s window to take the recall back, the view cuts to your
character, the drone comes down onto the spot where it was set down, and the character stows everything in reverse.

- **Local-only.** A full deploy → fly → stow cycle sends nothing to the game server. The `broadcastPose` setting
  (default off) sends the real `/read` emote when the tablet comes up (the lift-off), or at a skip past it (0x01E1 SoulEmote + one 0xF61C
  MoveToState, SPEC DV-33).
- **Reuses film mode's stack** (flight model, camera owner, safety reflex, world prewarm, lens overlay), imported
  directly — no `?filmMode=on`. No edits to `scene3d/film/*`, ever.
- **No wasm change.** The gestures are JS clips built from retail Animation frames and played through the Rust
  `MotionSequence` playhead (`EntityManager.playLocalClip`); the held tablet pose is the retail `ReadState`.
- **Outdoors only** in v1, **with open sky above the launch spot**: the drone comes home by descending straight onto
  the spot where it was set down (and the first seconds of a recall climb toward 15 m above the ground), so it cannot
  return under a roof, an arch or an overhang (a deploy there is refused, below). Humanoid rigs get the gestures, a no-hands rig (Olthoi) launches the
  drone beside it.

## Flags

| Flag | Default | Effect |
|---|---|---|
| `?drone=off` | **on** since 2026-10-25 (`DRONE_DEFAULT_ON = true` in `plugins/drone-hud.js`, flipped after the 1070 eye test — `docs/drone-deploy-2026-10-24/live/EYETEST.md`) | Only the exact `?drone=off` hides the launcher; then nothing under `scene3d/drone/` loads. |
| `?droneDebug=on` | off | `window.__drone.debug` (below). No scene objects, draws or program keys. |
| `?droneAudio=off` | on | No motor hum (no WebAudio nodes). |

The rows live in `docs/url-flags.md` (§1 `drone`, §4 `droneDebug` / `droneAudio`, and the §0 flip criteria).

Storage (every access in try/catch; blocked storage = defaults): `hb.drone.v1` (settings), `hb.drone.tune.v1`
(prop anchors per setup), `hb.drone.seen.v1` (the first-flight cheat sheet was shown).

## Files

| File | Lane | Role |
|---|---|---|
| `SPEC.md` | phase 0 | The frozen contract. |
| `sequence.js` | L4 | Pure state machine: states, beats, timers, abort triggers → plain action objects. |
| `world_link.js` | L4 | Film runtime wiring: camera owner, two safety reflexes (eye / body), world prewarm, lens overlay, hooks. |
| `index.js` | L4 | `installDrone(deps)` → `window.__drone`; the per-frame driver in `liveScene3d.film.preFrame`; action executors. |
| `gestures.js` | L2 | Rig profile, the pack / place / goggles clips from `fetchAnimation` frames, ReadState hold, wielded-item hide. |
| `props.js` | L2 | Procedural drone / tablet / goggles (stock materials, no lights), attach / detach, the material prewarm. |
| `manual_flight.js` | L1 | Pure: sticks → craft pose (cine via film `createDrone`; angle / acro own integrator), autopilot plans. |
| `tether.js` | L1 | Pure: range sphere / signal, ceiling, battery, the return-to-home path. |
| `controls.js` | L3 | Keyboard / pointer lock / gamepad → sticks; the input lock and its restore. |
| `osd.js` | L3 | DOM FPV OSD (`#hb-drone-osd`), static / vignette, the clean-HUD view (H). |
| `audio.js` | L3 | WebAudio motor hum on `audioManager.getEffectBus()`. |

Outside this folder: `plugins/drone-hud.js` + `plugins/drone-hud.manifest.json` (L5: the launcher, the deploy-refusal
reader, the plugin-bus edges, `/read`, the settings popover, the idle prewarm), the additive seams
`EntityManager.playLocalClip` / `stopLocalClip` (`scene3d/entities.js`, L2), `AudioManager.getEffectBus`
(`scene3d/audio/audio_manager.js`, L3) and the Shift+F11 entry in `app/plugin_bar.js` `PLUGIN_HOTKEY_DISPATCH` (L5),
`data/drone-rig-profiles.json` (L4; tuned anchors per setup, filled in phase 4), `fixtures/drone/*` (L2; copies of the
recon DAT data for the tests).

Load order: the plugin imports nothing from `scene3d/` or `three` statically (I-27). The first use — a launcher click,
Shift+F11, the settings popover or `window.__droneHud.load()` — imports `scene3d/drone/index.js` (location.href-
relative), which imports every sibling dynamically. The one idle prewarm per page (`props.prewarm`, after the scene is
ready, in idle time) is the only other thing that loads before use.

## The launcher

A 30×30 button in the toolbar's add-on column (`plugins/hotbar.js` `.hb-hotbar-addons`, CSS `order: 10` so it stacks
under ⚒ whatever the mount order); a fixed float at `right: 12px; bottom: 84px` when there is no toolbar.

| Drone state | Click | Shift+click | Dot |
|---|---|---|---|
| idle | deploy (refused with the reason in the tooltip and a red flash) | deploy | grey; red while a refusal holds (not in world, indoors, combat, portal space, dead, a film take) |
| deploying | skip to the lift-off | skip | amber |
| flying / pilot view | recall: 3 s in the goggles to take it back, then it comes down at home and is stowed | recall now (the view cuts back at once) | green |
| returning | recall now | recall now | amber |
| landing / stowing / aborting / crashed | ignored | ignored | amber |

Shift+F11 is the click (the manifest hotkey; `window.__toggleDroneHud`). Right-click opens the settings popover:
flight mode, quick deploy, invert mouse Y, crashes, show `/read` to others, motor volume, mouse sensitivity, range,
battery. It closes on Esc, its close button, a second right-click or any press outside it (the game canvas too, also
while the drone is flying). Deploy refusals: `Enter the world first`, `Not while in portal space`, `Not while dead`,
`A film take owns the camera`, `The drone is busy`, `Finish targeting first` (a "Use X on…" target cursor is
pending), `Outdoors only`, `Leave combat mode first`, `Stand still to deploy`, and `Needs open sky above you`: a roof,
an arch or another overhanging structure or rock within about 16 m above you, the spots where the drone is set down
(0.72 m and 1.5 m in front of you) or the end of its lift-off (4 m in front) — step out into the open and deploy again.
That one is found only when you click (the drone module checks the sky at deploy), so the dot flashes red instead of
staying red; another player, an NPC or a creature standing in front of you does not count, and neither does the floor
you stand on (a porch, a platform).

The drone is set down where the place clip brings the hand to the ground, about 0.72 m in front of the pilot. When the
hand is not there at the release — more than 0.3 m above the pilot's feet or less than 0.4 m out from them
horizontally, as after a timer-mode place (`clipMode: 'timer'` or a clip that could not be built), a clip cut short or
a rig rebuilt during the place — it is set down 0.72 m in front of the pilot instead (a no-hands rig always gets its
drone 1.5 m in front), so the lift-off always backs straight away from the pilot. When the pilot stands on the
terrain (their feet within 0.25 m of it) the drone rests on the terrain at its drop spot, however steep the slope; a
pilot standing on a floor, a porch or a platform above the terrain gets the drone at the level of their feet unless
the terrain at the drop spot is within 0.5 m of them (the client's ground height knows only the terrain, not floors).

## Controls (while the drone is out)

| Action | Keyboard / mouse | Gamepad (mode 2) |
|---|---|---|
| Forward / back | W / S | right stick Y |
| Strafe (roll) | A / D | right stick X |
| Yaw | Q / E, mouse X (pointer-locked) | left stick X |
| Up / down | Space / C | left stick Y |
| Gimbal tilt (cine) | mouse Y | LT / RT |
| Boost (cine) | Shift | RB |
| Field of view 60–110° | wheel | — |
| Mode (cine → angle → acro) | M | Y |
| Pilot view | Tab | View / Back |
| Hide HUD | H | — |
| Return home | R | A |
| Recall and stow | Shift+F11 or the button | hold B (0.8 s) |

- The input lock runs from the deploy click until control comes back: the end of the stow, or earlier after an abort,
  a crash or a landing away from home (DV-3). **KeyC and KeyM are taken while locked** (C is the client's camera-mode
  toggle, M the World Map, which sits outside the input funnel) — DV-5. Never taken: Escape, Enter, F1–F12 (so
  **Shift+F11 always reaches the manifest bridge**), digits, Ctrl / Alt / Meta chords, and any key while you type
  (chat keeps working). A dropdown left focused (the popover's Flight mode, say) does not count as
  typing: drone keys keep flying instead of picking an option by letter; the arrows, Enter and Esc still work it.
- **Tab inside an open dialog** (a server Yes / No confirmation such as a fellowship invite, the salvage confirm)
  moves the dialog's focus as usual instead of toggling pilot view, so Tab then Enter declines as expected. Space stays
  taken there, so a held climb never presses the focused button.
- **H hides the whole client HUD** — vitals, radar, chat, the toolbar with the drone launcher, nameplates — and the
  mouse cursor; only the OSD stays. H again brings it back, and it comes back by itself as soon as control returns
  (an abort, a crash, the end of the stow). R and Shift+F11 still recall while it is hidden.
- R and Tab work as soon as the goggles view is up: during the end of the lift-off they first take control (as a
  stick input would), then return home or switch to pilot view.
- Keys still held when control comes back (an abort, a crash, the end of the stow) are **drained**: their autorepeats
  and the final keyup never reach the game, so the character does not run in place on a key it never saw pressed.
  Press the key again to use it. The drain removes itself on that release, on a fresh press or when the window loses
  focus, also after the cycle has ended.
- **Return home and recall** (DV-19, owner amendment 2026-10-25 — SPEC §14.6): R, gamepad A, hold-B, the button and
  Shift+F11 all request the recall. The drone turns for home and the goggles stay on for 3 s while the OSD counts
  down `RETURNING 3 · FLY TO CANCEL`: a FRESH stick input in that window takes control back (look and gimbal do not;
  a stick still held when the return started never cancels it). Then the view cuts to your character and the drone
  comes down 5 m onto the spot where it was set down — the long flight home is skipped — lands, and is stowed. The
  low-battery return takes the same 3 s. Shift (instant recall), a second press while it returns and a recall from
  pilot view skip the 3 s; in pilot view a drone within about 25 m flies home in view instead, and one already
  within 5 m of home lands straight there. A forced landing (empty battery) lands where it is. A descent held back
  by an obstacle lands where it is 3 s after its planned arrival and fades out there instead of being picked up.
- Pointer lock starts on the first canvas click while flying. Esc releases it (the browser) and the drone holds as its
  mode does at zero sticks; keys and the gamepad keep flying. In pilot view the right-button drag orbits the follow
  camera round the pilot; a short right-click is swallowed (no Examine / Use context menu opens).
- Mouse by mode (DV-29): cine — X yaws, Y tilts the gimbal; angle — X yaws, Y ignored; acro — mouse ignored
  (gamepad recommended). Cine flies a diagonal (W+D) at the axis speed (12 m/s, boost 20); angle tilts at most 35° in
  total; acro's collective is 1 g with the stick centred, 2.5 g full up, 0 full down.

Aborts (the camera back on the pilot within a frame, input restored): taking damage, dying, a combat stance,
portal space, the pilot moving more than 2 m, a session or character change, a film take starting (≤ 250 ms), WebGL
context loss, a rig that is gone. Damage, death, combat and `abort('user')` land the drone where it is and fade it out
after 5 s; the others remove it at once (DV-17). A hidden tab never aborts (the drone hovers).

## `window.__drone` (`DRONE_API_VERSION = "drone-1"`)

Installed by `installDrone` on first use. Every method returns JSON-safe data and never throws: `{ok: true, …}` or
`{ok: false, code, reason}`.

| Method | Does |
|---|---|
| `status()` | `{ok, version, state, beat, mode, since, quick, rig, craft, input, camera, flags, lastAbort}` |
| `deploy({quick})` | Start a cycle (idle only; refusal codes `not-in-world`, `indoors`, `combat`, `moving`, `portal`, `dead`, `film-busy`, `busy`, `targeting`, `covered` — the open-sky check; `debug.events()` then holds one `message: 'covered'` entry naming the column, the layer and the roof's height) |
| `recall({instant})` | Return home and stow; `instant` cuts the view back now |
| `skip()` | Deploying → straight to the lift-off |
| `button({shift})` | The launcher action for the current state (table above) |
| `abort(reason)` | Emergency exit (`user` by default) |
| `setMode(mode)` | `cine` \| `angle` \| `acro` (persisted) |
| `pilotView(on)` | Follow camera on the pilot while the drone holds; no argument toggles |
| `settings()` / `setSettings(patch)` | The `hb.drone.v1` settings (SPEC §3.9 table); one bad key refuses the whole patch |
| `tune(patch?)` | Prop anchors for the pilot's setup (`tablet`, `goggles`, `droneInHand`, `clipMode`, `reset`), persisted in `hb.drone.tune.v1` |
| `dispose()` | Hard abort, teardown, `delete window.__drone` |
| `debug` | Only with `?droneDebug=on`: `setSticks(axes, ms)`, `trigger(signal)` (`damage` \| `death` \| `portal` \| `combat` \| `pilotMoved` \| `session` \| `film` \| `contextLost`), `clipParity()`, `events({limit})` (the log ring; `message: 'state'` entries are the transitions) |

The plugin adds `window.__droneHud = {load(), prewarm()}` (`load()` installs `window.__drone` without deploying →
`{ok, version}`; `prewarm()` runs the page's one prop-material prewarm now) and `window.__toggleDroneHud()` (the
button). Each state transition dispatches one `hb-drone-state` event on `document` (`bubbles: false`,
`detail = {state, prev, at}`).

## Tests

Run from `apps/holtburger-web/`, one at a time (the laptop rule: targeted suites only; the orchestrator runs the full
gate):

```
node tests/drone_flight.test.mjs
node tests/drone_tether.test.mjs
node tests/drone_gestures.test.mjs
node tests/drone_props.test.mjs
node tests/drone_entities_seam.test.mjs
node tests/drone_controls.test.mjs
node tests/drone_osd.test.mjs
node tests/drone_audio.test.mjs
node tests/drone_sequence.test.mjs
node tests/drone_api.test.mjs
node tests/drone_hud.test.mjs
node test_plugin_index_gen.mjs
node tests/plugin_loader.test.cjs
```

Harness rows: `drone(<topic>)` in `harness/run-js-headless.mjs` tier 5 (`--only=drone(` selects them).

## The 1070 smoke

SPEC §12.3 step 6 (PLAN §9.4 step 6) is the recipe: local ACE only, a separate muted Chrome profile, CDP :9333,
`?nosw=1&drone=on&droneDebug=on`, then `await __droneHud.load()` → `__drone.deploy({quick: true})` → wait for
`flying` → `__drone.debug.setSticks({pitch: 0.5}, 3000)` → `__drone.recall()` → wait for `idle`, asserting the state
sequence from `__drone.debug.events()`, zero console errors, no outbound game actions beyond the idle `0x01E9` pings,
the funnel gate reopened and the camera released. The live probe scripts that exercised these page APIs are in
`docs/drone-deploy-2026-10-24/recon/probe/scripts/`; the eye-test checklist is PLAN §10 plus SPEC §10.2.

E4's battery return-to-home: the popover offers Off / 5 – 20 min, so set one minute from the console first,
`__drone.setSettings({batteryMin: 1})` (it applies at the next deploy; the return then fires after about 54 s of
hovering), and put it back with `__drone.setSettings({batteryMin: 10})` afterwards.
