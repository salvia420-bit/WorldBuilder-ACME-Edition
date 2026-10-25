# Drone Deploy — frozen contracts (v1, 2026-10-24)

> **Drone Deploy** for holtburger-web. A toolbar button directly under RynthSuite's ⚒ plays a short local scene on the
> player's character: reach into the pack for the drone, kneel and set it down, pull FPV goggles on, raise a tablet.
> The drone lifts off, the view cuts into the goggles, the player flies it (keyboard + mouse or gamepad, FPV OSD) until
> recall; it flies home, lands, and the character stows everything in reverse. **Local-only**: a full deploy → fly →
> stow cycle sends nothing to the game server (the default-off `broadcastPose` setting sends the real `/read` emote).
> Flag `?drone`: **DEFAULT ON since 2026-10-25** (flipped after the 1070 eye test, §14.5); only the exact `?drone=off` disables it.
>
> This file is the single source of truth for module boundaries. Phase-1 lanes code against it EXACTLY: every
> cross-lane name, signature, shape, order and constant here is binding. Where `docs/drone-deploy-2026-10-24/PLAN.md`
> (PLAN) and the code disagree, the code wins; this SPEC carries the amended contract: §10 lists every PLAN deviation
> and §14 every phase-1 / phase-3 / phase-4 amendment (the rows below already carry them).
> Changing a contract requires the orchestrator. Paths are relative to
> `APP = external/holtburger/apps/holtburger-web` unless they start with `scene3d/film/` (also under APP) or
> `../../scripts/` (the holtburger repo `scripts/`).

---

## 1. Status, purpose, ownership

### 1.1 Status

- Frozen 2026-10-24 (phase 0, when only this file existed under `scene3d/drone/`). Phase 1 builds five file-disjoint
  lanes (§11) in parallel; the orchestrator merges, adds the harness rows (§12.1) and runs the gate.
- Every hard contract below was spot-checked against the code on 2026-10-24 (entities.js seam region and tick,
  motion_sequence.js `poseRigAt`, film `camera_owner` / `safety` / `world` / `world_query` / `lens_overlay` /
  `flight_model`, `ui/input-funnel.js`, `ui/escape_action.js`, `audio_manager.js`, `plugins/rynth-hud.js`,
  `plugins/hotbar.js`, `app/plugin_bar.js`, `plugins/rejection_feedback.js`, the recon fixtures). Line numbers drift:
  anchor on symbols.
- Phase-0 review (two independent checkers, same day): every issue was re-verified against the code (flight-model
  numbers re-measured with the real `film/drone/flight_model.js` in node) and applied; §13 lists each change.
- Amended the same day after phase 1 (the lane builders' and verifiers' accepted deviations) and phase 3 (the review
  fixes), and on 2026-10-25 after the phase-4 1070 eye test (F1 the open-sky `covered` refusal, F2 the slope drop):
  §14 lists each amendment, and every affected row, table and code block below is updated in place, so this file
  stays the contract.

### 1.2 Purpose

PLAN §0–§2 describe the experience; this SPEC fixes how it is built: a pure state machine (`sequence.js`) emits plain
action objects that a page driver (`index.js`) executes each frame in a `liveScene3d.film.preFrame` listener, using
film mode's flight model, camera owner, safety reflex, world prewarm and lens overlay (imported directly, no
`?filmMode=on`), two additive seams in hot files (entities.js, audio_manager.js), and a HUD plugin that loads
everything on first use.

### 1.3 Files and lanes (binding; nobody edits a file outside their lane)

| Lane | Owns (creates or edits) | Owns tests |
|---|---|---|
| **L1 FLIGHT** | `scene3d/drone/manual_flight.js`, `scene3d/drone/tether.js` | `tests/drone_flight.test.mjs`, `tests/drone_tether.test.mjs` |
| **L2 RIG** | `scene3d/drone/gestures.js`, `scene3d/drone/props.js`; **`scene3d/entities.js` — ONLY the additive seam §6.1**; `fixtures/drone/anims.json` + `fixtures/drone/rig-table.json` (byte-for-byte copies of `docs/drone-deploy-2026-10-24/recon/anims.json` / `rig-table.json`) | `tests/drone_gestures.test.mjs`, `tests/drone_props.test.mjs`, `tests/drone_entities_seam.test.mjs` |
| **L3 INPUT / OSD / AUDIO** | `scene3d/drone/controls.js`, `scene3d/drone/osd.js`, `scene3d/drone/audio.js`; **`scene3d/audio/audio_manager.js` — ONLY the additive seam §6.2** | `tests/drone_controls.test.mjs`, `tests/drone_osd.test.mjs`, `tests/drone_audio.test.mjs` |
| **L4 CORE** | `scene3d/drone/sequence.js`, `scene3d/drone/world_link.js`, `scene3d/drone/index.js`; `data/drone-rig-profiles.json` (created EMPTY in phase 1 — `{"version": 1, "profiles": {}}`, §7.6; phase 4 fills it) | `tests/drone_sequence.test.mjs`, `tests/drone_api.test.mjs` |
| **L5 HUD** | `plugins/drone-hud.js`, `plugins/drone-hud.manifest.json`, `plugins/index.json` (regenerated with `node plugins/gen-index.mjs`, never hand-edited), `scene3d/drone/README.md`, `docs/url-flags.md` (only the rows of §12.2); **`app/plugin_bar.js` — ONLY the dispatch entry §6.8** (amendment DV-14); **`tests/plugin_loader.test.cjs` — ONLY the 50 → 51 count edits §6.8** (amendment DV-15) | `tests/drone_hud.test.mjs`; runs the existing `test_plugin_index_gen.mjs` |
| **Orchestrator** | `harness/run-js-headless.mjs` (rows §12.1); merge; gate; 1070 smoke | — |

Hot-file seams: `scene3d/entities.js` (L2 only), `scene3d/audio/audio_manager.js` (L3 only), `app/plugin_bar.js`
(L5 only). **No edits to `scene3d/film/*` ever.** No other existing file is edited by anyone.

### 1.4 Module graph and import rules

```
plugins/drone-hud.js ─ dynamic import(new URL("scene3d/drone/index.js", location.href).href) ─▶ installDrone(deps)
                     ─ dynamic import(new URL("scene3d/drone/props.js", location.href).href) + import("three")
                       (the ONE idle prewarm, §7.5)
scene3d/drone/index.js ─ dynamic import(new URL("./<name>.js", import.meta.url).href) of every default factory
                         (each overridable by deps.modules, §7.2) ─▶ sequence · gestures · props · manual_flight ·
                         tether · controls · osd · audio · world_link
```

Allowed imports (exhaustive; anything not listed is forbidden):

| Importer | May import |
|---|---|
| `sequence.js`, `tether.js` | nothing (self-contained) |
| `manual_flight.js` | `../film/drone/flight_model.js` (`createDrone`, `DRONE_PRESETS`), `../film/core/{gimbal,quat,vec3,easing}.js` |
| `gestures.js` | nothing (its pure half and its page half are both self-contained; deps injected) |
| `props.js` | nothing (THREE injected) |
| `controls.js` | `../../ui/escape_action.js` — named `cancelJumpCharge`, `jumpChargePending` only |
| `osd.js` | `../film/runtime/clean_frame.js` — named `FILM_CLEAN_CSS`, `FILM_CLEAN_CLASS`, `FILM_CLEAN_STYLE_ID` only (never `createCleanFrame`) |
| `audio.js` | `../film/core/rng.js` (`mulberry32`, `hashString`) |
| `world_link.js` | `../film/runtime/{camera_owner,safety,world,lens_overlay}.js`, `* as LOS from "../film/scene/los.js"`, `../film/scene/{world_query,particles_query}.js`, `../film/core/{errors,units,gimbal}.js` |
| `index.js` | static: `../film/core/{gimbal,units,rng}.js` only; everything else dynamic (§7.2) incl. `import("three")` |
| `plugins/drone-hud.js` | static exactly: `../ui/hud_kit.js` (`makeTitlebar`), `../ui/keymap.js` (`listManifestBindings`), `../ui/hud_focus.js` (`releaseMouseFocus`), `../ui/hud_scale.js` (`hudRect`, `hudViewport`), `../ui/escape_action.js` (`isStandingStill`, `heldMovementKey`); dynamic only: `scene3d/drone/index.js`, `scene3d/drone/props.js`, `"three"` |

- Transitively pulled (fine: no listeners, no DOM, no import-time effect beyond constructing module state):
  `scene3d/film/shots/{trajectory,framing}.js`, `scene3d/film/scene/terrain_corridor.js`, `scene3d/projectile_sweep.js`
  (pure); ui `input-funnel.js` → `keymap.js` → `ac_strings.js`, `movement_keys.js`, `spew_box.js` (lazy caches only;
  `getInputFunnel` is never called from drone code); and `scene3d/particles/owner_registry.js`, which is **stateful**:
  it exports the singleton `ownerRegistry` (no imports, no listeners) that `film/scene/particles_query.js` uses as its
  default registry. On `index.html` the drone's import resolves to the client's own instance (same URL), so
  `particles.near` sees every owner-registry manager; on `index-bundled.html` (next bullet) it gets a separate, EMPTY
  registry and sees only `em._worldParticleManager` (plus `live._staticParticleManager` if it were stamped — the statics
  bake stamps the static manager on `scene3dForBuilders`, a different object from `liveScene3d`). Accepted limitation: on the bundled shell the near-lens
  particle hide can miss static emitters (cosmetic; E7+). particle_manager.js `allParticleManagers` reaches only
  `installFilmMode` (under `?filmMode=on`), so `particleManagers` stays unset (§6.3).
- Forbidden everywhere under `scene3d/drone/`: a static `import ... from "three"` or `"three/addons/..."` (THREE is
  injected); any stateful scene3d module (`entities.js`, `camera.js`, `index.js`, `loop.js`, `cells.js`,
  `statics.js`, `terrain.js`, `lighting.js`, `particles/particle_manager.js`, `audio/audio_manager.js`, any module the
  client loads with a `?v=` query); `scene3d/film/index.js`, `scene3d/film/flags.js`; `ui/input-funnel.js` directly;
  `ui/combat_mode_pending.js`; `plugins/*`.
- On `index-bundled.html` the plugin is bundled but `scene3d/drone/*` (computed-URL import) is not: those modules get
  their own instances of everything they import. That is why every live object (funnel, managers, handle) is reached
  through injected deps or `window`, never through a module import.

---

## 2. Conventions (all modules)

### 2.1 Frames and orientation

- **AC world frame** (every drone pose, craft state, tether, autopilot plan, status field): metres, `x` east, `y`
  north, `z` up, right-handed; `wx = lbX·192 + localX`, `wy = lbY·192 + localY`, `z` absolute. Identical to film SPEC §1
  and `film/drone/flight_model.js`.
- **Heading `h`**: compass radians, clockwise from north (+y). `forward(h, p) = (sin h·cos p, cos h·cos p, sin p)`.
  **Pitch `p`**: + up, [−π/2, π/2]. **Roll `r`**: + = top of frame moves right = bank right. A heading may be unwrapped
  (createDrone's is); wrap with film core `wrapPi` for display / status.
- Wasm `LocalPlayerPose.heading` and the rig root yaw are **counter-clockwise**: `compass = −yaw`.
  `entityManager.getLocalPlayerHeading()` and `worldQuery.localPlayer().heading` already return compass. (Probe4 used
  the raw yaw as a compass value — amended DV-21.)
- **Body frame** (craft body, the drone, tablet and goggles models): `+x` right, `+y` forward, `+z` up. Signs:
  nose-up = rotation +θ about body +x; bank right = +φ about body +y; yaw right (compass increases) = rotation about
  body +z by **−ψ**. Body attitude `{h, p, r}`: `p < 0` is nose-down. The mesh's AC orientation is
  `quatFromHPR(h, p, r)` (film `core/gimbal.js`, = Rz(−h)·Rx(p)·Ry(r)).
- **Camera**: identity camera looks +y with up +z (film). Hard-mounted camera (angle/acro) = body ⊗ Rx(+uptiltDeg).
- **Quaternion component order**: every AC quaternion in drone code (poses, plans, anchors, tune data, status) is an
  array **`[w, x, y, z]`**. The only exceptions, each confined to its seam:
  1. animation / clip frames: 7 floats per (frame, part) `[x, y, z, qw, qx, qy, qz]` (w-first inside the record),
     frame-major then part-minor (`base = (f·partCount + p)·7`) — `AnimationJs.frames`, `recon/anims.json`, the poser;
  2. holding-location entries: named fields `{partId, ox, oy, oz, qw, qx, qy, qz}`;
  3. three.js `Quaternion` objects `(x, y, z, w)`: written only as `obj.quaternion.set(q[1], q[2], q[3], q[0])`.
- **three seams** (the only places AC meets three):
  - Entity rigs live under `worldRoot` (rotation.x = −π/2): `inst.root.position` = AC world metres,
    `inst.root.quaternion` = the AC quaternion in three field order, `inst.root.scale` = objScale.
  - `inst.parts[i]` (THREE.Group `part_${i}`, direct children of `inst.root`, ordered by setup part index) carry
    part-local transforms in **rig object space** (AC axes: x right, y forward, z up, metres before root scale). Anim
    frames, holding locations and prop anchors are all in this space / the part-local frame of the part they name.
  - **`droneGroup`** (owned by `props.js`): a direct child of `liveScene3d.scene` with `rotation.x = −Math.PI/2`
    (worldRoot's transform), so its children take AC world coordinates directly: `position.set(x, y, z)`,
    `quaternion.set(q[1], q[2], q[3], q[0])`.
  - The camera is unparented; only film `camera_owner.write` touches it (`acToThreePos = [x, z, −y]`,
    `acQuatToThree = [x, z, −y, w]`).
  - WebAudio panner positions are three world: `(x, z, −y)` from AC `(x, y, z)`.
- **FOV**: vertical degrees (camera_owner's unit; it accepts (1, 170) and pins `camera.userData.csmFitFov` to 75 above).
  The drone FOV setting is clamped to [60, 110]; default 75 (§3.9).

### 2.2 Units

Metres, seconds, radians (except names ending `Deg`), speeds m/s (`…Mps`), throttle = thrust / weight (1 = hover,
0 = motors off), battery and signal in [0, 1]. Gravity `9.80665` m/s² (flight_model's value).

### 2.3 Time base

- The frame driver runs in `liveScene3d.film.preFrame(tsMs, dt)`: `dt` seconds, clamped ≤ 0.1 by scene3d/index.js
  (first frame 0.016; under `?dtNoFreeze=off` it can be 0 for 10 frames after a stall). No frame runs while the tab is
  hidden or the WebGL context is lost.
- `now` = `deps.clock()` seconds (default `performance.now() / 1000`, monotonic). It stamps `since` / events only;
  **beat clocks are Σdt**, so a clip's playhead and its beat timer advance by the same clamped dt.
- **Requests are synchronous**: API calls, control actions and DOM events call `sequence.tick` immediately with
  `dt = 0` and execute the returned actions before returning. Per-frame ticks carry `request: null`.
- No `setInterval` / `setTimeout` / `requestAnimationFrame` in `scene3d/drone/*`, with exactly two exceptions: the
  `props.prewarm` 10 ms ready-poll and film `world.prewarm`'s internal polling. Periodic work (10 Hz OSD, 4 Hz watches,
  fades) is a dt / clock accumulator in the frame driver. (The HUD plugin keeps its own 500 ms launcher tick, §3.11.)

### 2.4 Determinism and purity

- **Pure modules**: `sequence.js`, `manual_flight.js`, `tether.js`, the pure exports of `gestures.js` (`buildClip`,
  `rigProfile`, `GESTURE_CLIPS`, constants) and of `osd.js` (formatters). No `window`, `document`, three, wasm,
  clocks or `Math.random`; same inputs → deep-equal outputs. They run in plain node.
- Randomness only from `film/core/rng.js` `mulberry32(hashString(<constant>))` (audio noise: seed string
  `"drone-audio"`). The OSD static is a deterministic SVG `feTurbulence` data URI (no RNG).

### 2.5 Flags (exact string compares on the same line as `.get(...)`)

| Flag | Default | Reader (exact code shape) | Effect |
|---|---|---|---|
| `?drone=off` | **on** (`DRONE_DEFAULT_ON = true` since 2026-10-25; was false during development) | `plugins/drone-hud.js` `droneHudEnabled(search, defaultOn = DRONE_DEFAULT_ON)`: `const v = new URLSearchParams(search ?? "").get("drone"); return defaultOn ? !(v === "off") : v === "on";` | mounts the launcher; nothing else can load the drone |
| `?droneDebug=on` | off | `scene3d/drone/index.js` `readDroneFlags(search).debug`: `q.get("droneDebug") === "on"` | `__drone.debug` only (no scene objects, draws or program keys; PLAN's "gizmos" are v2 — DV-35) |
| `?droneAudio=off` | on | `readDroneFlags(search).audio`: `!(q.get("droneAudio") === "off")` | no motor hum (no WebAudio nodes) |

`readDroneFlags(search)` never throws (`new URLSearchParams` in try/catch → `{debug:false, audio:true}`). Only the exact
strings count. Phase 4 flipped `DRONE_DEFAULT_ON` to `true` on 2026-10-25 (§14.5): only the exact `?drone=off` disables
(`?drone=ON`, `=0`, `=OFF`, absent stay on); `droneHudEnabled(s, false)` keeps the development reader (only `=on`).

### 2.6 Storage keys (every read and write in try/catch; storage = `deps.storage ?? window.localStorage`)

| Key | Owner | Value |
|---|---|---|
| `hb.drone.v1` | index.js | flat JSON object of the §3.9 settings keys; unknown keys dropped and invalid values replaced by defaults on load |
| `hb.drone.tune.v1` | index.js | `{"version": 1, "profiles": {"0x02000001": TuneProfile, …}}` (§7.6); keys = `"0x"` + 8 UPPERCASE hex digits |
| `hb.drone.seen.v1` | index.js (osd shows) | `"1"` once the first-flight cheat sheet was shown |

A missing / blocked storage means defaults and the cheat sheet on every page load; nothing fails.

### 2.7 JSON-safety

Every `window.__drone` result (and every `status()` / `state()` of every module) is plain data: objects, arrays,
strings, booleans, `null`, finite numbers. `NaN` / `±Infinity` → `null`; typed arrays → arrays; no functions, no
`undefined` values (omit the key), no cycles. Status numbers are rounded: positions / distances 3 decimals, angles in
degrees 2 decimals, speeds 2 decimals.

### 2.8 Errors, logging

- `window.__drone` methods **never throw**. Success `{ok: true, …}`; failure `{ok: false, code, reason}`.
- Codes: refusals `not-in-world`, `indoors`, `combat`, `moving`, `portal`, `dead`, `film-busy`, `busy`, `targeting`,
  `covered`; operational `bad-argument`, `not-flying`, `not-available`, `internal`, `disposed`.
- Refusal `reason` strings (exact; `plugins/drone-hud.js` `REFUSAL_TEXT` and `index.js` `DRONE_REFUSAL_REASONS` are the
  same table):

  | code | reason |
  |---|---|
  | `not-in-world` | `Enter the world first` |
  | `portal` | `Not while in portal space` |
  | `dead` | `Not while dead` |
  | `film-busy` | `A film take owns the camera` |
  | `busy` | `The drone is busy` |
  | `targeting` | `Finish targeting first` |
  | `indoors` | `Outdoors only` |
  | `combat` | `Leave combat mode first` |
  | `moving` | `Stand still to deploy` |
  | `covered` | `Needs open sky above you` |

  `busy` = the drone's own state is not `idle`; `targeting` = a pending use-target (`__useTargeting.pending`, a "Use X
  on…" cursor), non-persistent like `moving` (R4-10); `covered` = a roof, arch or overhang over the launch spot, found
  by index.js's own open-sky check at deploy (§3.9, phase 4 F1) — index-only and non-persistent: the plugin has no
  signal for it (`refusalFor` never returns it) and shows it as the click's red flash through the api refusal (§6.7).
  index.js passes a `deps.refusal` code through with this text; an unknown code reads `Cannot deploy (<code>)`.

- Factories throw only for a missing REQUIRED dependency (named per module below; film's `FilmError` with a code is
  fine). Per-call methods never throw. `index.js` wraps every call into another module in try/catch: a throw at deploy
  → `{ok:false, code:'internal'}`; a throw in the frame driver → hard abort with reason `error` (§4.6) and one warn.
- Logging: `deps.log(entry)` with `entry = {event: "drone", level: "info"|"warn", message, …}`. Default: a 200-entry
  ring (served by `debug.events()`) plus `console.warn("[drone] " + message)` once per distinct message for `warn`.
  **Never `console.error`.**

---

## 3. Module contracts

Every export carries JSDoc. "Reused object" means the same object is returned / written on every call (callers must
copy what they keep).

### 3.1 `scene3d/drone/gestures.js` (L2)

**Pure exports**

```js
export const FLOATS_PER_PART = 7;
export const HUMANOID_RIG = Object.freeze({ rightHand: 15, leftHand: 12, head: 16, minParts: 17 });
export const LOC_RIGHT_HAND = 1;   // ACE ParentLocation keys of the client's holding table
export const LOC_LEFT_HAND = 2;
export const MOTION = Object.freeze({ READY: 0x41000003, READ_STATE: 0x43000146, NONCOMBAT: 0x8000003d });
export const GESTURE_CLIPS = Object.freeze({
  pack:    Object.freeze({ anim: 0x030003b7, plan: Object.freeze([{from:0,to:19},{hold:19,frames:3},{from:19,to:0}]), eventAtFrame: 18, frames: 43 }),
  place:   Object.freeze({ anim: 0x03000247, plan: Object.freeze([{from:0,to:21},{hold:21,frames:6},{from:21,to:0}]), eventAtFrame: 18, frames: 50 }),
  goggles: Object.freeze({ anim: 0x030004f8, plan: Object.freeze([{from:0,to:20},{from:20,to:0}]),                   eventAtFrame: 14, frames: 42 }),
});   // every plan entry object frozen too; eventAtFrame is a CLIP frame index
export function clipFrameCount(plan) → number          // frames a plan produces (0 for a bad plan)
export function buildClip(anim, plan, { fps = 30 } = {}) → ClipDescriptor | null
export function rigProfile({ partCount, holdingLocations } = {}) → RigProfile
```

- `anim` = AnimationJs shape `{numFrames, numParts, frames}` (+ optional `did`, `flags`); `frames` a `Float32Array` or
  a plain number array (fixtures) of length `numFrames·numParts·7`. `plan` = array of `{from, to}` (inclusive; `to <
  from` plays reversed) or `{hold, frames}` (repeat source frame `hold` `frames` times).
- `buildClip` returns **null** (never throws) for: a missing / non-positive `numParts` or `numFrames`, a `frames`
  length mismatch, a non-array or empty plan, a non-object (or array) entry, any source frame outside `[0, numFrames)`
  or not an integer, a hold of fewer than 1 frame, a plan of more than 3600 frames, `fps <= 0` (`clipFrameCount` → 0
  for the same plans). `buildClip(anim, plan, opts)` and `rigProfile(input = {})` take no destructuring defaults, so a
  null argument returns null / `no-hands` instead of throwing.
- **ClipDescriptor** (the engine one-shot shape; `poseRigAt` reads `partFrames, partCount, posFrames, numFrames`):
  `{partCount, numFrames: n, framerate: fps, partFrames: Float32Array(n·partCount·7), frameTimes: Float32Array(n)
  with frameTimes[k] = k/fps, duration: n/fps, posFrames: null, segmentStarts: Uint32Array([0]), segmentCounts:
  Uint32Array([n]), segmentFramerates: Float32Array([fps]), segmentAnimIds: Uint32Array([anim.did >>> 0 || 0]),
  rootFrames: null, sourceFrames: Uint16Array(order)}`. **`posFrames` is `null` — never `[]` or an empty typed array**
  (`poseRigAt` tests truthiness; an empty array poses NaN, verified on the fixture). Clip frame k copies source frame
  `order[k]` (all `numParts·7` floats) unchanged; root motion (POS_FRAMES, `flags & 1`) is never carried.
- **RigProfile** `{kind: 'humanoid'|'no-hands', rightHand, leftHand, head, rightGrip, leftGrip}`. Humanoid iff
  `partCount >= 17 && holding(1).partId === 15 && holding(2).partId === 12`; then parts 15 / 12 / 16 and the two grip
  entries; otherwise `{kind:'no-hands', rightHand:-1, leftHand:-1, head:-1, rightGrip:null, leftGrip:null}`.
  `holdingLocations` is a `Map` or plain object keyed by ParentLocation number (1, 2) or name (`"RightHand"`,
  `"LeftHand"`); entries need only `partId`. Unknown / partial input → `no-hands`. Head 16 is a humanoid constant (no
  holding entry exists for it).

**Page exports**

```js
export async function loadAnim(wasm, did) → AnimLite | null
export async function readHoldingLocations(entityManager, setupId) → Map<1|2, HoldingEntry>
export function createWieldedHider(entityManager, guid) → { apply() → number, restore() → number, hidden() → number[] }
export function createGestureDriver(deps) → GestureDriver
```

- `loadAnim`: `wasm.fetchAnimation(did >>> 0)` (async; rejects on a DAT miss) → `{did, numFrames, numParts, flags,
  frames}`; reads the `frames` getter ONCE (each access copies); `free()`s the AnimationJs in `finally`; rejection or a
  missing export → `null`. `wasm` = `liveScene3d.wasmExports` (`window.__hbWasm` has no `fetchAnimation`). Results are
  cached per did in a module-level `Map` (DAT constants).
- `readHoldingLocations`: `await entityManager._resolveHoldingLocation(setupId >>> 0, key)` for keys 1 and 2 (the
  client's cached table; never call wasm `fetchSetupHoldingLocations` — its `takeLocations()` is a one-shot drain whose
  entries must be freed). Each throw → that key missing.
- `createWieldedHider` — exact code §6.10.
- **`createGestureDriver(deps)`** — deps `{entityManager (REQUIRED), wasm, guid (REQUIRED, non-zero u32: 0 throws a
  TypeError), clipMode?: () => 'clip'|'timer', log?}`. Returns:

  | Member | Contract |
  |---|---|
  | `ready() → Promise<{ok, profile, clips: {pack, place, goggles}}>` | Resolves the rig: `inst = em.entityMap.get(guid)`, `sid = (inst.meta.modelId ?? inst.meta.setupId ?? 0) >>> 0`, holding locations, `rigProfile({partCount: inst.parts.length, holdingLocations})`; then (humanoid only) loads the three anims and builds the three clips, keeping a clip only when `anim.numParts === inst.parts.length`. `clips.<name>` = boolean (built). Never rejects; memoised until `rebind()`; a `rebind()` while it is still resolving hands this promise over to the re-resolution (it resolves with the rebuilt rig's answer, never a stale `{profile: null}`). When `(anim.flags & 1) !== 0` it logs one warn (root motion dropped) and still builds. |
  | `profile() → RigProfile \| null` | Sync; non-null as soon as the profile is known (before the clips finish). |
  | `clip(name, speed = 1) → {ok, mode: 'clip'\|'timer', name}` | Starts a job and replaces any current job (stopping our clip first). `mode 'clip'` when the clip is built, `clipMode() !== 'timer'` and `em.playLocalClip(guid, desc, {speed})` returned true; otherwise a **timer job** (no rig motion; the event and the end are timed: event at `eventAtFrame/30/speed` s, end at `frames/30/speed` s of polled dt). Unknown name → `{ok:false, mode:null, name}`. |
  | `poll(dt) → GesturePoll` | Call once per frame. Reused object `{active, name, event, done, rigChanged}`: `event` true on exactly ONE poll per job (the first with `rec.seq.globalFrameIndex >= eventAtFrame`, read only while `inst._unifiedSeq === rec`; a job that ends before the event fires it on its `done` poll); `done` true on exactly one poll (`inst._unifiedSeq !== rec`, or the instance changed — `rigChanged` true —, or the timer elapsed); after `done`, `active` false. `event` / `done` refer ONLY to the current job: a job replaced by `clip()` or ended by `stop()` is discarded silently and never reports either afterwards (index.js feeds them straight into the tick, §5 step 3). Never touches `rec.seq` once the record is no longer the playhead (the real wasm getters throw on a freed pointer; the node fake does not). |
  | `stop() → boolean` | Ends the current job; `em.stopLocalClip(guid)` (true when our clip was freed). |
  | `hold(cmd = MOTION.READ_STATE, speed = 1) → Promise<void>` | `em.setMotion(guid, cmd, MOTION.NONCOMBAT, speed)` (returns a promise; wrapped, never rejects); remembers `heldCmd`. |
  | `release() → Promise<void>` | Clears `heldCmd`; unless `em.isDeathHeld(guid)` → `em.setMotion(guid, MOTION.READY, MOTION.NONCOMBAT, 1.0)` (Ready on a death-held rig would stand the corpse up — CQ-06 lets Ready through). |
  | `watch(nowSec) → boolean` | Held-motion watchdog: when `heldCmd` is set, at most once per `1.0` s, if `(inst.lastMotionCommand >>> 0) !== heldCmd` and not death-held → re-issue `hold(heldCmd)`; returns true when it re-issued. Each `hold()` counts as an issue: the first `watch()` after it only starts the 1 s clock (`setMotion` commits `lastMotionCommand` asynchronously, so a same-frame re-issue would duplicate it). |
  | `hideWielded(on) → number` / `applyWielded() → number` | `on`: hide the pilot's `_attachedChildren` (wielded hider `apply`); `off`: `restore()`. `applyWielded()` = `apply()` while hidden (4 Hz from the driver; catches a newly wielded guid). Return = guids hidden / restored. |
  | `rebind(inst) → void` | The rig was rebuilt (new EntityInstance): ends the current job (`rigChanged`), drops the memoised `ready()` so the next `ready()` re-resolves, keeps `heldCmd`. |
  | `clipParity() → Promise<{ok, setupId, clips: {name: {built, flags, maxPosErr, maxQuatErr}}}>` | Debug: rebuilds each clip and compares clip frame k to source frame `sourceFrames[k]` (expect 0 error); JSON-safe. |
  | `dispose() → void` | `stop()` (also a local clip left on the pilot's playhead), `hideWielded(false)`, clears `heldCmd` (does NOT issue Ready). Idempotent. |

### 3.2 `scene3d/drone/props.js` (L2)

```js
export const PROP_NAMES = Object.freeze(["drone", "tablet", "goggles"]);
export const DRONE_BODY = Object.freeze({ spanM: 0.32, restHeightM: 0.06, radiusM: 0.18 });
export const DEFAULT_ANCHORS = Object.freeze({
  droneInHand: Object.freeze({ pos: Object.freeze([0.025, 0, -0.076]),       quat: Object.freeze([0.932351, 0.304211, 0.142447, -0.13374]) }),   // R4-03
  tablet:      Object.freeze({ pos: Object.freeze([-0.105, -0.035, -0.143]),  quat: Object.freeze([-0.509, 0.062, -0.685, 0.518]) }),
  goggles:     Object.freeze({ pos: Object.freeze([0, -0.10, 0.085]),         quat: Object.freeze([1, 0, 0, 0]), scale: 1 }),
});   // part-local frame of the anchor part; quat [w,x,y,z]. droneInHand.quat = q15(src 18)⁻¹ ⊗ Rz(π) on the fixture
      // place anim (R4-03): the place release lands with no snap (was [0.707107, 0.707107, 0, 0]: 58° in one frame)
export const ANCHOR_OF = Object.freeze({ drone: "rightHand", tablet: "leftHand", goggles: "head" });
export const ANCHOR_KEY = Object.freeze({ drone: "droneInHand", tablet: "tablet", goggles: "goggles" });
export function prewarm(deps) → Promise<{ok, compiled, ms, reason?}>      // module-level, memoised per renderer
export function createProps(deps) → Props
export function _resetPrewarmForTest() → void
```

**Model conventions** (body frame §2.1; origin = the prop's centre):
- drone: ≈0.32 m span quad in the xy plane, camera end at +y, landing feet at `z = −DRONE_BODY.restHeightM`; brass +
  iron body, glowing mana-crystal camera, two-blade rotors that switch to translucent blur discs above throttle 0.3,
  emissive LEDs (front white steady, rear red blinking 1 Hz), and a separate blob-shadow disc (§5.6 PLAN). The blur
  discs are clearly see-through (V2, 1070: they rendered as opaque cream plates): low opacity (≈ 0.2–0.35 at the rim,
  less toward the centre through the texture / vertex alpha), a neutral grey tint, `depthWrite: false`, `transparent`
  and the map fixed at creation (no runtime program-key change).
- tablet: 0.24 (x) × 0.16 (y) × 0.012 (z) m, **screen on the +z face** (the probe box had its cyan +z face toward the
  pilot with exactly this anchor quaternion), brass frame, CanvasTexture screen 256×160.
- goggles: 0.18 (x) × 0.07 (y) × 0.08 (z) m (built 0.18 × 0.067 × 0.0675; nothing consumes the size — the fit is the
  anchor plus `goggles.scale`), **lenses facing local −y** (head-local −y is forward: the head part's rest frame is
  rotated 180° about z), strap toward +y, a red emissive REC pip, a stub antenna. Default quat identity (as probed). A
  dark visor block whose two lens panels are dark tinted glass (V3, 1070: they glowed white-blue, "lit eyes"):
  near-black blue / green, little or no emissive, a faint sheen from roughness / metalness; only the REC pip glows.

**Look and cost rules (binding)**: stock `MeshStandardMaterial` / `MeshBasicMaterial` only; no `ShaderMaterial`, no
`onBeforeCompile`, no `customProgramCacheKey` override; **no Light objects** (the light count is baked into every lit
program; LEDs and screens are emissive / basic); every material created with its FINAL `map` (a map added later is a
new program key); no `userData.__disposable` / `__cacheOwned` on anything; geometry merged per material per prop with a
local helper built on the injected THREE (no `three/addons`); `castShadow = receiveShadow = false`; every node on
**layer 1 only** (`layers.set(1)`); every Mesh gets `raycast = noop`; `frustumCulled` stays default. Mesh budget:
tablet ≤ 2 meshes, goggles ≤ 2, drone ≤ 6 (incl. blob shadow and the blur discs). Triangle budget (PLAN §5.6 "≈600
tris"): drone ≤ 700 over all its meshes (body, rotors, blur discs, LEDs, blob), tablet + goggles ≤ 600 (indexed:
`index.count / 3`, else `position.count / 3`). Program-key twins of the login-idle
archetype warm (facts: `{map, transparent, depthWrite:false}` MeshBasic for the screen and blob; mapless DoubleSide
MeshStandard for brass; etc.) are preferred. The blob shadow is lifted 0.03 m above the ground (no `polygonOffset`:
under reversed-Z its units are not negated). Any fade material (§`fadeOut`) is created at build time and is part of
`prewarm` — no program key may change at runtime.

**`prewarm(deps)`** — deps `{THREE, renderer, scene, camera, offscreen = true}`. Builds the prop material set (the same
factory `createProps` uses, so keys match) on tiny proxy meshes, then compiles for the composer variant: binds a 1×1
`HalfFloatType` `WebGLRenderTarget` (`depthBuffer:false, stencilBuffer:false`) around `renderer.compile(root, camera,
scene)` when `offscreen` (caller passes `offscreen: !liveScene3d.wireframeMode`; without a composer the canvas variant
is the live one), restores the previous target, disposes the target, then polls `renderer.properties.get(m)
.currentProgram.isReady()` every 10 ms treating a vanished program as done (three's own `compileAsync` throws from its
timer when a material is disposed mid-link). It **keeps the proxy materials alive** for the page (so the programs stay
referenced even under `?programRetain=off`). Memoised per renderer (`WeakMap`): a second call returns the first
promise. Never rejects: no renderer / `compile` → `{ok:false, compiled:0, ms:0, reason}`; no THREE / camera / scene →
the same, NOT memoised (a later call retries); a throwing compile → `{ok:false, reason}` after the previous target is
restored; the ready poll is capped at 20 s (`{ok:false, reason: 'ready-poll timeout'}`). Never call it from inside a
render.
**Lens-overlay twin** (R2-2: the angle / acro overlay's programs would otherwise link inside the goggle-cut frame; the
async link guard covers only the main scene): prewarm also compiles one plain `Mesh(PlaneGeometry)` with
`MeshBasicMaterial({map: <any non-video texture>, transparent: true, depthTest: false, depthWrite: false, fog: false,
toneMapped: false, side: THREE.DoubleSide})`, with `renderer.setRenderTarget(null)` bound and an EMPTY `THREE.Scene`
(no lights, no fog) as the target scene, outside the HalfFloat-target compile (the previous target restored after),
and keeps it alive. The ready poll covers it through every entry of `renderer.properties.get(m).programs` (the
DoubleSide twin owns a Back and a Front program). Verified on three r184: the main scene as target scene, the
HalfFloat target or FrontSide each leave overlay programs uncompiled.

**`createProps(deps)`** — deps `{THREE (REQUIRED), scene (REQUIRED; liveScene3d.scene), anchors?: Anchors (default
DEFAULT_ANCHORS), createCanvas?: (w, h) => HTMLCanvasElement|null (default document.createElement when a document
exists; none in node → the screen uses a 1×1 DataTexture and `setScreen` returns false), log?}`. Creates
`droneGroup` (`name "drone-world"`, `rotation.x = −Math.PI/2`, `userData.__punchPhase = 2`, layer 1) and adds it to
`scene`; builds all three props hidden (state `'none'`). Returns:

| Member | Contract |
|---|---|
| `drone`, `tablet`, `goggles`, `group` | THREE roots (read-only references; `group` = droneGroup). |
| `setRig(rig) → void` | `rig = {guid, parts: THREE.Group[], rootScale: number, profile: RigProfile}` or `null`. Re-parents every prop currently on the rig to the same anchor part of the new rig (rig rebuild); a prop the new rig cannot hold (no-hands or null profile, missing part, `rig` null) is removed to `'none'`. |
| `setAnchors(anchors) → void` | Replaces the offsets (tune) and re-applies them to props on the rig. |
| `attach(name, anchor) → boolean` | Parent `name` to `rig.parts[profile[anchor]]` at `anchors[ANCHOR_KEY[name]]` (pos, quat, goggles `scale`); `root.userData.__attachedChildOf = rig.guid >>> 0`; visible. The drone on the rig is counter-scaled `1 / rig.rootScale` (its world size stays 1:1; tablet and goggles inherit the rig scale). false without a rig / humanoid profile / valid part. Idempotent. |
| `toWorld(name, groundZ, yaw) → {ok, pos}` | `droneGroup.attach(root)` (keeps the world transform), `delete userData.__attachedChildOf`, scale 1, then snap: keep AC x/y, `z = groundZ + (name === 'drone' ? DRONE_BODY.restHeightM : 0)`, orientation = level yaw `compass yaw` (AC quat `[cos(−yaw/2), 0, 0, sin(−yaw/2)]`). `pos` = new AC world position (fresh array). Refuses `{ok:false, pos:null}` with nothing changed when the prop is at `'none'` or `groundZ` / `yaw` is non-finite (index.js then uses `place`). |
| `place(name, pos, yaw) → boolean` | Put `name` directly in the world at AC `pos` (already including the rest height) with level `yaw`; removes it from the rig if needed. |
| `remove(name) → boolean` | Hide and detach (back to state `'none'`; kept for reuse until dispose). Cancels a fade. True for any valid name (idempotent); false for an unknown name or after dispose. |
| `where(name) → 'none'\|'rig'\|'world'` | Current placement. |
| `worldPos(name, out) → out \| null` | AC world position via `getWorldPosition` (never a stale `.matrixWorld`; `?skipHiddenMatrix`) converted from three. |
| `setDronePose(pos, q) → boolean` | AC pose of the drone in the world (droneGroup child); called every frame while the drone is in the world; allocation-free. false when not in the world or non-finite. |
| `setVisible(name, on) → void` | Render visibility only (placement unchanged). The driver hides the drone while the camera is owned. |
| `setRotor(spin, t) → void` | Per frame while the drone exists (any placement): `spin` 0..2.5 (0 = stopped; blur discs above 0.3), `t` seconds; also advances LED blink, the blob shadow (opacity ∝ max(0, 1 − AGL/3), AGL from the drone's z and its last `groundZ` given to `toWorld`/`place`/`setGround`) and any running fade. Allocation-free. |
| `setGround(z) → void` | Terrain z under the drone for the blob shadow (driver, per frame while airborne; null keeps the last). |
| `setScreen(state) → boolean` | Redraw the tablet CanvasTexture: `state = {signal, battery (0..1 \| null), homeBearingRad, distM, live: boolean}`; `needsUpdate = true`; false without a canvas. A non-finite `homeBearingRad` draws no home arrow (the driver passes NaN out of the world and within 1 m of home, §5 step 13). The numeric texts (battery %, distance) are rebuilt only when the shown value changes (whole %, whole metres, 10 m steps above 1 km: `Math.round(m / 10) / 100` km). The driver calls it ≤ 4 Hz and only while the tablet is visible to the camera (pilot view, third person). |
| `fadeOut(name, {delaySec = 0, durationSec = 1, now}) → boolean` | Starts a fade at `now + delaySec` lasting `durationSec` (driven by `setRotor`'s `t`), then `remove(name)`; no program-key change (L2's choice: a scale-out toward the feet plus the blob's opacity, no twin materials). false at `'none'`. |
| `fading(name) → boolean` | A fade is pending or running. |
| `stats() → {meshes, geometries, materials, textures, built: boolean}` | Diagnostics (JSON-safe). |
| `dispose() → {ok, disposed: {geometries, materials, textures}}` | Removes droneGroup from the scene, detaches everything from the rig, disposes every geometry / material / texture it created (exactly those). Idempotent (second call disposes 0). |

### 3.3 `scene3d/drone/manual_flight.js` (L1, pure)

```js
export const CRAFT_MODES = Object.freeze(["cine", "angle", "acro"]);
export const CRAFT_TUNING = Object.freeze({
  cine:  Object.freeze({ vmaxH: 12, vmaxBoost: 20, vzMax: 4, yawRateDeg: 90, gimbalRateDeg: 60, pitchMinDeg: -90, pitchMaxDeg: 30 }),
  angle: Object.freeze({ maxTiltDeg: 35, yawRateDeg: 200, vzMax: 4, uptiltDeg: 20, levelOmega: 12, drag: 0.025, maxThrustG: 2.5 }),
  acro:  Object.freeze({ rc: 1.0, super: 0.7, expo: 0, hoverG: 1, maxThrustG: 2.5, uptiltDeg: 25, drag: 0.025 }),
  common: Object.freeze({ gravity: 9.80665, subDt: 1 / 240, maxSubsteps: 4800, restHeightM: 0.06, idleSpin: 0.35 }),
  rth: Object.freeze({ climbMps: 3, cruiseMps: 8, descendMps: 2, finalMps: 0.6, finalM: 1.5 }),
});   // the lift-off geometry (1.7 m up, 3.4 m back, 2.2 s) travels in the plan built by index.js
export function betaflightRateDeg(x, { rc, super: sup, expo }) → number   // deg/s at stick x ∈ [−1, 1]
export function createManualCraft(deps = {}) → ManualCraft
```

- `CRAFT_TUNING` also carries additive keys (phase 1; every key and value above is unchanged; no other lane reads
  them): `angle.{holdBelow: 0.05, vzGain: 4, azMax: 4, altGain: 1}`, `rth.{amax: 3.6, jmax: 7.2}` (0.9 × the cinema
  limits), `crash: {tumbleRadPerMps: 1.2, tumbleMinRad: 3, tumbleMaxRad: 12, drag: 0.025, frictionPerSec: 6,
  spinDecayPerSec: 8, settlePerSec: 6}`.

- `betaflightRateDeg`: `x' = x·|x|³·expo + x·(1 − expo)`; `rate = 200·rc·x'`; when `sup > 0`: `rate /= clamp(1 −
  |x'|·sup, 0.01, 1)`. At the defaults full stick = 666.67 °/s.
- deps `{mode = 'cine', rates?: {rc, super, expo}, createDrone? (default film flight_model createDrone — injectable
  for tests)}`. Unknown mode → `'cine'`.
- **Sticks** (`controls.poll()` object, §3.5): `{throttle, yaw, pitch, roll, gimbal, boost, lookX, lookY, zoom}`; axes in
  [−1, 1]; +pitch forward, +roll right, +yaw right (compass +), +throttle up, +gimbal up; `boost` 0|1; `lookX` / `lookY`
  radians since the last poll (+lookX yaw right, +lookY tilt up); `zoom` is ignored by the craft.
- **Step input** (caller-owned, reused): `{sticks, dt, groundZ: number|null, fovDeg}`.
- **CraftFrame** (reused object returned by every `step` / `reset`):

  ```
  { t, pos:[x,y,z], vel:[x,y,z], speed,
    body: {h, p, r, q:[w,x,y,z]},                 // body attitude (the mesh)
    cam:  {t, pos:[x,y,z], h, p, r, q:[w,x,y,z], fov},   // camera pose = film flight_model Pose; cam.pos equals pos
    throttle, landed, autopilot: null|'liftoff'|'rth'|'hold'|'land'|'crash', autopilotDone, distTouchdownM: number|null }
  ```

- **Modes** (manual control; autopilot plans override):
  - **cine**: one internal `createDrone({preset: 'cinema', vmax: 20})`. Commanded velocity in the frame of the camera's
    current heading (what the pilot sees): horizontal `(roll·right + pitch·forward)`, clamped to unit length, `·
    (boost ? 20 : 12)` (a diagonal W+D flies 12 m/s, boost 20 — not 16.97), vertical `throttle · 4`; heading command integrates `yaw · 90°/s`
    plus `lookX`; gimbal pitch integrates `gimbal · 60°/s` plus `lookY`, clamped [−90°, +30°]. Target = **one-step
    lead**: `pos + vCmd·dt` (`pos` = the craft position before this step: where the commanded velocity puts it at the
    end of the step) with exact `vel = vCmd` feed-forward while any translation axis is held; on release latch the
    jerk-aware stop point `pos + v·(|v|/(2·amax) + amax/(2·jmax))` (cinema amax 4, jmax 8) and hold it (`vel = 0`).
    **Never a longer lead**: createDrone adds `kp·|e|` (kp = 0.75) on top of the feed-forward, so a 0.5 s carrot settles
    at 16.3 m/s instead of 12 (vertical 5.45 instead of 4) once `vmax: 20` stops clamping it; a zero lead runs 1–2 %
    slow, frame-rate dependent (11.89 m/s at 60 Hz, 11.74 at 30 Hz). One scratch target object is reused (createDrone
    copies what it keeps). Camera = createDrone's output pose (`cam.q` exactly; past the gimbal's −90° pole, where
    createDrone overshoots by up to ≈ 2.8°–5.5°, `cam.h / p / r` are re-expressed as `h + π, −π/2, r + π` — the same
    image — and `cam.h` is unwrapped next to the previous frame's, so the cine yaw frame, plan seeds and the OSD heading
    stay continuous through nadir); body = `createDrone.state().body`. (Replaces PLAN's "3 m
    leash" — measured 18 m overshoot. One-step lead + latch, measured on the real flight model at 10–60 Hz: 12.04 /
    19.96 / 4.01 m/s at full stick / boost / vertical; release from 12 m/s → 21.1 m travel, 0.13 m past the stop point,
    `|v| < 0.05` after 3.8 s; boost 0.31 m / 5.6 s — DV-6.)
  - **angle**: own rigid-body integrator, sub-stepped at `1/240` s (≤ 4800 sub-steps). Sticks → target tilt (`pitch`
    → nose-down `−pitch·35°`, `roll` → bank `roll·35°`; pitch and roll together limited to 35° of total tilt, so a
    diagonal is not 49.5°), yaw rate `yaw·200°/s` (+ `lookX` as a direct heading delta;
    `lookY` ignored), vertical speed command `throttle·4 m/s` with auto-throttle (altitude hold at `|throttle| < 0.05`);
    attitude critically damped with ω = 12 rad/s; thrust along body up, clamped [0, 2.5 g]; quadratic drag `c = 0.025`
    1/m; camera hard mount with 20° uptilt.
  - **acro**: same integrator; body rates from `betaflightRateDeg` (pitch stick → nose-down rate, roll → bank right, yaw
    → compass +); collective `thrustG = 1 + throttle·(throttle >= 0 ? 1.5 : 1)` (centred = 1 g hover, full up 2.5 g,
    full down 0); gravity and quadratic drag; 25° uptilt; mouse ignored.
  - **Handover into a rigid mode** (R4-04): `autopilot(null)` from a cine-driven plan (liftoff / rth / hold / land:
    T8, a T16 cancel, T11 back from pilot view) in angle / acro does not snap the camera to the hard mount (that popped
    the view 28° / 33° in one frame): the plan's last `cam.q` is kept, in a preallocated quaternion, as an offset in the mount's frame
    (`offset = (body ⊗ mount)⁻¹ ⊗ cam.q` at the handover), and for 0.4 s `cam.q = (body ⊗ mount) ⊗ slerp(offset,
    identity, minJerk(t / 0.4))` — it eases from the plan's last view onto body ⊗ mount while the pilot's stick rotation
    passes straight through (a world-frame slerp from a fixed view lags the sticks and flips once an acro roll carries
    the mount past 180° from it); `cam.h / p / r` derived from the blended q; allocation-free. Only the camera blends:
    the body is seeded as before (level, no lurch).
  - Boost affects cine only. Mode switches keep position, velocity and heading continuous (the angle/acro integrator is
    seeded from the cine craft and vice versa through `reset(pose, {velocity, acceleration})`).
- **Members**:

  | Member | Contract |
  |---|---|
  | `reset(pose, opts?) → CraftFrame` | `pose = {pos, h, p = 0}` (AC); `opts = {velocity?, landed = false}`; re-seeds every integrator and clears any installed autopilot plan (a plan built for the old position would be stale; install plans after it); `landed: true` = on the ground, motors idle. Non-finite pose → keeps the previous state (never throws). |
  | `step(input) → CraftFrame` | Advance by `input.dt` (≤ 0 or non-finite → returns the current frame unchanged; a dt above `subDt·maxSubsteps` = 20 s is clamped to 20 s — film createDrone returns a NaN attitude for one step of dt ≥ ≈ 1000 —, and a guard re-seeds at the last finite pose if anything non-finite appears: never NaN). Uses the active autopilot plan if any, else the mode. A landed craft with no plan and `sticks.throttle <= 0.1` stays landed (motors idle). |
  | `contact(hits, clampedPos) → {impactSpeed}` | `hits` = array-like of `{layer, kind, t, point, normal}` (film safety hits, plus the tether hit §5). `impactSpeed` = max over hits of `−(v·n̂)`, floored at 0 (a `null` normal counts `\|v\|`; `layer === 'tether'` never counts, but its into-surface velocity is still removed, so the craft slides along the range sphere / ceiling). A hit with no normal removes the velocity along the clamp's correction direction (no correction → the craft stops). Removes the into-surface velocity / acceleration components and moves the craft to `clampedPos` (cine: `createDrone.reset(clampedCamPose, {velocity, acceleration})` only when the move is > 0.02 m or the removed speed > 0.05 m/s, to avoid gimbal hitches). During a `liftoff` plan it only reports `impactSpeed`: the kinematic plan owns the position (the safety clamp keeps the rendered pose out of geometry; the first manual step after the plan is clamped normally). |
  | `setMode(mode) → mode` | Applies at once (continuity above). Unknown → unchanged. |
  | `setRates({rc, super, expo}) → void` | Acro rates (validated by index.js). |
  | `autopilot(plan) → {ok, kind}` | Install a plan (or `null` = manual control). Plans (JSON-safe, built by index.js §7.4): `{kind:'liftoff', from, to, durationSec, heading, lookAt: [x,y,z]\|null}` — a **kinematic** min-jerk path: each step `createDrone.reset({pos: P, q}, {velocity: V, acceleration: A})` with `τ = clamp(t/durationSec, 0, 1)` (`t` = Σ step dt since the plan was installed), `P = from + (to − from)·minJerk(τ)` (film `core/easing.js`), `V`, `A` its analytic first / second time derivatives (0 at τ = 1), and `q = quatFromHPR(h, p, 0)` of the direction from `P` to `lookAt` (level at `heading` when null; the body heading follows the camera's: exactly `heading` for a level look, ≈ `heading` when facing the pilot, since the path runs along `away`) — exact at every speed, the body tilt comes from the profile's thrust (reset derives it, ≤ 25°), and the cine craft is continuous (pos, vel, acc) whenever the plan is replaced (a tracked min-jerk target is infeasible for amax 4 / jmax 8 — DV-31); `{kind:'rth', path: ReturnPath, yaw?: number}` — climb / cruise / descend at `CRAFT_TUNING.rth` speeds, the last `finalM` at `finalMps`, ends landed on `path.points[last]` (a blocked route lands where it can, below); a finite `yaw` (index.js passes `home.yaw`, R4-03) eases the body heading — and the cine camera heading — to it during the final descent, so the drone lands facing the way it was set down and the pickup grab needs no yaw snap (absent → no yaw change); `{kind:'hold'}` — position and heading hold where it is (from a moving start it brakes to the jerk-aware stop point and keeps the camera heading / pitch of the moment it was installed); `{kind:'land', at:[x,y,z]}` — descend vertically onto `at` (ground + rest height) at `descendMps`, `finalMps` for the last `finalM`; `{kind:'crash'}` — ballistic fall with a tumble (spin axis `normalize(v × up)`, deterministic) until it rests at `groundZ + restHeightM`. Every plan except `crash` uses the internal cine craft regardless of mode: `liftoff` drives it kinematically (above); `rth`, `hold` and `land` fly it as tracked targets that must stay inside the cinema limits (amax 4, jmax 8; no position lead beyond one step, as in cine) — brake into every corner and the end, e.g. a rest-to-rest `sCurveProfile(segmentLength, phaseSpeed, 3.6, 7.2)` per path segment fed as pos + vel + acc (a naive target moving at the phase speed overshoots the cruise → descent corner by ≈ 10 m); `crash` is its own ballistic integrator. `rth`, `land` and `hold` started while moving brake first on a jerk-limited profile: `rth` then re-plans from the stop point with planReturn's construction (climb there, cruise straight home at `max(path.cruiseZ, stop z)`), `land` flies back over `at` at cruise speed and then descends (all within what the cine craft can carry, vmax 20). An invalid plan (rth with no finite points, land with a non-finite `at`, liftoff with `durationSec <= 0`) → `{ok:false}` and the current plan is kept. |
  | `state() → object` | JSON-safe snapshot `{mode, pos, vel, speed, body, cam, throttle, landed, autopilot, autopilotDone, distTouchdownM}` (−0 reported as 0; the per-frame CraftFrame may carry −0). |

- `landed` becomes true when a ground-ending plan (`rth`, `land`, `crash`) reaches its end point within 0.05 m with
  `speed < 0.3`, and also on a floor-like contact (normal z ≥ 0.5, < 0.3 m/s after the contact) within the last
  `finalM + 0.5` m of a rth / land plan, and during a crash (the crash then rests there): the wasm layers hold the
  0.18 m body sphere ≈ 0.12 m above a platform end point; a floor contact far above the end point (a canopy) does not
  land the plan. So the contacts fed to a ground plan must be the BODY reflex's (§5 step 7, R3-1). **Stall landing**: a
  rth / land still not down 3 s after its plan clock ended (an end point held out of reach, e.g. behind a wall) lands
  away from it — a vertical descent onto the ground under it (else the last known ground, else in place; never
  upward) — and T21 then takes the noDrone stow.
- `distTouchdownM` = the remaining plan distance — rth: the remaining path length; land: from a hover the height above
  `at`, plus the brake / fly-back legs of a moving start — but **never less than the closest straight-line distance
  to the route end the craft has reached so far** (R3-3: a route held back by an obstacle must not reach T17's 5 m on
  the plan clock while the drone is still ≈ 17 m out; because the value is also non-increasing it can sit up to
  ≈ 1 m below the CURRENT straight-line distance while an obstacle pushes the craft away), non-increasing, 0 once
  landed; null for every other plan. `autopilotDone` = the plan reached
  its end (liftoff at `durationSec`, with a 1e-9 s tolerance for the summed dt; rth / land / crash when landed; hold
  never). `throttle`: thrust / weight, 0 when landed and idle.

### 3.4 `scene3d/drone/tether.js` (L1, pure)

```js
export const TETHER_DEFAULTS = Object.freeze({ rangeM: 150, hardCapM: 180, signalFadeM: 50, ceilingAglM: 120,
  batterySec: 600, warnAt: 0.2, rthAt: 0.1, drainIdle: 0.6, drainPerThrottle: 0.4 });
export function signalForDistance(distM, rangeM, fadeM = 50) → number   // 1 at ≤ rangeM − fadeM, linear to 0 at rangeM
export function createTether(opts = {}) → Tether
```

- opts `{rangeM, ceilingAglM, batterySec}`; `rangeM` clamped to [20, 180] (the 3×3 terrain ring around the player's
  landblock always reaches ≥ 192 m, so the drone never sees unloaded ground or unsent objects); `batterySec <= 0` =
  battery off.
- Members (all allocation-free; returned objects are reused):

  | Member | Contract |
  |---|---|
  | `clamp(pos, home, groundZ) → {pos, signal, limited, kind, normal, distM}` | 3-D distance `distM` from `home`; outside `rangeM` → projected onto the sphere, `kind 'range'`, `normal` = unit vector toward home; above `(groundZ ?? home[2]) + ceilingAglM` → z clamped, `kind 'ceiling'`, `normal [0, 0, −1]` (range wins when both); `signal = signalForDistance(distM before projection)`; `limited` boolean; `kind`/`normal` null when not limited. |
  | `drain(dt, throttle) → {battery, warn, rth, empty}` | `battery −= dt / batterySec · (0.6 + 0.4·clamp(throttle, 0, 2.5))`, floored at 0; `warn = battery <= 0.2`; `rth` true on exactly ONE call (the one that crosses 0.1); `empty = battery <= 0` (a level below 1e-9 reads as empty: floating-point drift in the summed dt). Battery off → `{battery: 1, warn: false, rth: false, empty: false}`. |
  | `planReturn(from, home, {cruiseAglM = 15, groundZFrom = null, groundZHome = null}) → ReturnPath` | `ReturnPath = {points: [[x,y,z]…], lengthM, cruiseZ}` (fresh arrays; a plan, not per frame). `cruiseZ = max(from[2], (groundZFrom ?? home[2]) + cruiseAglM, (groundZHome ?? home[2]) + cruiseAglM)`. Horizontal distance ≥ 3 m: `[from, [from.x, from.y, cruiseZ], [home.x, home.y, cruiseZ], home]`; < 3 m: `[from, [home.x, home.y, max(from.z, home.z + 1)], home]`. Consecutive duplicates removed; the last point is a value-exact copy of `home` (deep-equal, a fresh array — not the caller's array; §8.2's "=== home" means exactly that). |
  | `configure({rangeM?, ceilingAglM?}) → void` | Live settings change. |
  | `reset({battery = 1}) → void`; `state() → {rangeM, ceilingAglM, batterySec, battery, rthFired}` | |

### 3.5 `scene3d/drone/controls.js` (L3)

```js
export const DRONE_KEY_AXES;      // {KeyW:["pitch",1], KeyS:["pitch",-1], KeyD:["roll",1], KeyA:["roll",-1],
                                  //  KeyE:["yaw",1], KeyQ:["yaw",-1], Space:["throttle",1], KeyC:["throttle",-1]}
export const DRONE_KEY_ACTIONS;   // {Tab:"pilotView", KeyM:"mode", KeyH:"hideHud", KeyR:"returnHome"}
export const DRONE_BOOST_CODES;   // ["ShiftLeft", "ShiftRight"]
export const DRONE_KEY_CODES;     // all codes above (axes + actions + boost)
export const DRONE_ACTIONS;       // ["pilotView", "mode", "hideHud", "returnHome", "recall"]
export const KEY_EVENTS;          // ["keydown", "keyup", "keypress"]
export const POINTER_EVENTS;      // pointerdown/up/move/cancel, mousedown/up/move, click, dblclick, auxclick,
                                  // contextmenu, wheel, touchstart/move/end/cancel, dragover, drop
export const CONTROL_PHASES;      // ["deploy", "fly", "pilot", "stow"]
export const GAMEPAD_DEADZONE = 0.08, GAMEPAD_EXPO = 0.3, RECALL_HOLD_MS = 800;
export const LOOK_YAW_RAD_PER_PX = 0.0025, LOOK_PITCH_RAD_PER_PX = 0.0020, LOOK_MAX_PX_PER_EVENT = 300;
export const PAD;                 // {A:0, B:1, X:2, Y:3, LB:4, RB:5, LT:6, RT:7, VIEW:8, MENU:9}
export function takesText(el) → boolean
export function isTypingTarget(ev, doc) → boolean
export function shapeAxis(v, deadzone = 0.08, expo = 0.3) → number
export function createControls(deps = {}) → Controls
```

- `takesText`: TEXTAREA, contentEditable, or an INPUT whose type is not one of `button, checkbox, color,
  file, image, radio, range, reset, submit` (a settings checkbox left focused by a click must not park the sticks).
  A SELECT takes no typed text either (R2-5): while locked, drone keys on a focused select are taken and prevented, so
  a popover select left focused never type-aheads a setting mid-flight (`a` → Angle) and Space opens no dropdown; the
  arrows, Enter and Esc are not drone keys and still reach it.
  `isTypingTarget(ev, doc)`: `ev.target` takes text, or the connected `doc.activeElement` does (a detached
  activeElement is ignored). `shapeAxis`: 0 inside the deadzone, rescaled, `(1 − expo)·n + expo·n³`, sign kept,
  non-finite → 0 (`shapeAxis(0.5) = 0.3481`).
- deps `{window, document, navigator, canvas?, funnel?, cameraSwitcher?, settings: () => ({sensitivity, invertY,
  gamepadLayout})}` (`canvas` default `cameraSwitcher.domElement`; `funnel` resolved at `lock()` time as
  `deps.funnel ?? window.__inputFunnel`, never at create).
- Members:

  | Member | Contract |
  |---|---|
  | `lock() → {ok, already, steps}` | The input lock recipe §6.4 (funnel release + gate, held-Space charge cancel, camera input reset, window capture listeners). Idempotent. `steps` JSON-safe per step (`{ok:false, skipped}` when a dep is missing — the other steps still run). |
  | `restore() → {ok, wasLocked, steps}` | Exits OUR pointer lock, removes every listener it added, drains keys still physically held (their repeats and final keyup swallowed; a fresh non-repeat press hands the key back; the drain's 3 window listeners — capture keydown / keyup, bubble blur — remove themselves on that keyup, a fresh press or a window blur), un-poisons only a gate it set and that still reads `"gate"` (`steps.funnel.unpoisoned === true` exactly when this restore released our own gate — index.js reads it, §7.4 `inputRestore`). Idempotent. |
  | `setPhase(phase) → phase` | `phase` is null before the first `setPhase()` and after `restore()` (null behaves like `'deploy'`). `'deploy'` / `'stow'`: drone keys taken and tracked, canvas pointer events blocked, no pointer-lock requests (and our pointer lock exited), look/zoom not accumulated. `'fly'`: plus the first canvas `pointerdown` (button 0) blurs the focused element and requests pointer lock (a returned promise's rejection is caught, and a grant that resolves after `restore()` or outside `'fly'` exits our lock at once — `p.then(() => { if (!locked \|\| phase !== "fly") exitOurPointerLock(); }, onLockRejected)`, R1-09; while the listeners are attached, `pointerlockchange` does the same for a grant that lands outside `'fly'`); look (`pointermove.movementX/Y` while locked; per-event spikes > 300 px dropped) and wheel zoom accumulate. `'pilot'`: exits our pointer lock; canvas right-button press / drag / contextmenu pass through to camera.js (orbit the follow camera round the pilot); a right-button `mouseup` while that drag is active first ends it with `cs._endFollowDrag()` — checked before the canvas test, so also when released over the HUD — which nulls camera.js's candidate entity: a short right-click opens no context menu (Use / Examine would move the pilot or send an appraisal), the mouseup itself still passes and drags keep orbiting (R4-05); leaving `'pilot'` mid-drag also calls `_endFollowDrag()`; everything else stays blocked. Pointer-lock loss (`pointerlockchange` with no lock element: Esc, focus loss, the browser) zeroes the look accumulators and `pointerLocked`; keys and the gamepad keep producing sticks (the input lock stays), so with no stick held the craft holds as its mode does at zero sticks (PLAN §6.2 "the drone hovers": cine / angle hover, acro keeps its attitude at 1 g); in `'fly'` the next canvas `pointerdown` re-requests the lock. |
  | `poll(dt) → Sticks` | Reused object `{throttle, yaw, pitch, roll, gimbal, boost, lookX, lookY, zoom}` (§3.3). Keyboard + gamepad summed and clamped to [−1, 1]; gamepad standard mapping only (mode2: left X yaw, left Y throttle (up +), right X roll, right Y pitch (forward +); mode1 swaps the two Y axes; LT/RT gimbal −/+; RB boost; edges: Y `mode`, View `pilotView`, A `returnHome`; B held ≥ 800 ms → `recall` once per hold; a button already held when `lock()` runs is primed, not a press). `lookX = px·0.0025·sens`, `lookY = −py·0.0020·sens·(invertY ? −1 : 1)` radians accumulated since the last poll; `zoom` = wheel notches since the last poll (`deltaY > 0` → +1 = wider). All zero while unlocked. Allocation-free. |
  | `onAction(fn) → unsubscribe` | `fn({type, source: 'keyboard'\|'gamepad'})`, `type ∈ DRONE_ACTIONS`; press edges only (no repeats); a throwing listener never breaks input. |
  | `locked`, `pointerLocked`, `phase` | Getters. |
  | `status() → {locked, phase, pointerLocked, draining, source, gamepad, held, blocked, actions, lockRequests, lockErrors, drained, funnelInstalled}` | JSON-safe; `funnelInstalled = funnel.installed === true` (false under `?inputFunnelV2=off`, where the gate poison does nothing and only our capture listeners block). |
  | `dispose() → restore result` | `const r = restore(); actionFns.clear(); disposed = true; return r;` — drops every action listener but **keeps a running restore drain** (R1-01: teardown disposes in the same tick as T25's / a hard abort's `inputRestore`, and a dropped drain let the held key's autorepeat reach the reopened funnel — the rig ran in place and the unpaired release sent one MoveToState). The drain removes itself as above; a re-created controls (the next deploy) works while an old drain is alive. |

- Keys NOT taken (always the client's): Escape, Enter, F1–F12 (incl. **Shift+F11** — it reaches the manifest bridge
  §6.8), digits, and any key with Ctrl / Alt / Meta held, and any drone key while `isTypingTarget` (chat keeps working);
  and **Tab inside an open modal dialog** (R2-3): `onKey`, after the typing and modifier checks and before `block()`,
  returns for `Tab` when `ev.target` or the connected `doc.activeElement` has `.closest('[aria-modal="true"]')`, so a
  server confirmation (`#hb-modal-dialog`: fellowship, allegiance, Yes / No) or the salvage confirm cycles its own focus
  instead of toggling pilot view (Tab + Enter would otherwise accept what the player meant to decline). Space stays
  blocked there (a held climb never activates the focused OK).
  A keyup of a drone key that the lock did not see pressed is still blocked (never hand the funnel a release it did not
  start), except while typing.

### 3.6 `scene3d/drone/osd.js` (L3)

```js
export const OSD_ID = "hb-drone-osd";
export const OSD_STYLE_ID = "hb-drone-osd-style";
export const DRONE_CLEAN_STYLE_ID = "hb-drone-clean-css";
export const DRONE_CLEAN_KEEP_CSS = "html.film-clean #hb-drone-osd { display: block !important; }";
export const OSD_MODES = Object.freeze(["off", "boot", "fpv", "pilot", "crash"]);
// pure formatters (null / non-finite input → "--" for strings)
export function formatPercent(frac) → string            // 0.874 → "87%"
export function formatDistance(m) → string             // 12.34 → "12 m", 1234 → "1.23 km"
export function formatAltitude(m) → string             // 15.24 → "15.2 m" (< 100 m one decimal), 123.4 → "123 m"
export function formatSpeed(mps) → string              // 12.34 → "12.3 m/s"
export function formatTimer(sec) → string              // 135 → "02:15", 3725 → "1:02:05"
export function formatHeading(rad) → string            // compass, wrapped [0, 360): 0.785 → "045°"
export function compassLabel(rad) → string             // 8-point: "N" "NE" … "NW"
export function modeLabel(mode) → string               // "CINE" | "ANGLE" | "ACRO"
export function signalBars(signal) → number            // 0..5: signal <= 0 → 0, else ceil(signal·5)
export function staticOpacity(signal) → number         // 0.85·(1 − clamp01(signal))^1.5
export function headingTapeOffsetPx(rad, pxPerDeg = 4) → number   // −(wrapped degrees)·pxPerDeg
export function homeArrowDeg(headingRad, bearingRad) → number     // relative bearing in (−180, 180]
export function createOsd(deps = {}) → Osd
```

- deps `{document (REQUIRED for the DOM; absent → every method is a no-op returning false), window, clock?: () =>
  seconds (default `performance.now() / 1000`; it times the cheat-sheet fade inside `frame()`, only while the sheet
  is up)}` (the cheat-sheet storage key is index.js's, §7.4).
- DOM (built on first `show` other than `'off'`; no `innerHTML` except `""`, no `createElementNS`, no canvas): a
  direct `<body>` child `div#hb-drone-osd` with `data-mode`, `pointer-events: none` on it and every child, positioned
  `position: fixed; left: 0; top: 0; width: calc(100 * var(--hb-hud-vw, 1vw)); height: calc(100 * var(--hb-hud-vh,
  1vh))` (it is HUD-zoomed as a `body > [id^="hb-"]` element; `vw`/`vh` are not divided by the zoom — ui/hud_scale.js
  trap 2; the `1vw` / `1vh` fallback only matters before hud_scale sets the variables).
  Children (class names are API for tests): `.dosd-tl` (mode, battery, timer), `.dosd-tr` (signal bars, distance home,
  AGL, speed), `.dosd-center` (crosshair `[data-reticle="crosshair"]` in cine, horizon `[data-reticle="horizon"]` in
  angle/acro), `.dosd-tape` (heading tape + home arrow), `.dosd-banner` (`RANGE LIMIT`, `LOW BATTERY`, `RETURNING`,
  `CRASH`, `PILOT VIEW · Tab / View: goggles`, `ACRO: gamepad recommended`), `.dosd-static` (SVG feTurbulence data-URI
  background; opacity = `staticOpacity(signal)`), `.dosd-vignette`, `.dosd-fade` (black, for the boot wipe),
  `.dosd-cheat` (controls cheat sheet). Styles in `<style id="hb-drone-osd-style">`.
- **Layout** (HUD px — the OSD is HUD-zoomed; PLAN §6.6; R4-01 / R4-08, the 1070's V1): the default vitals (orbs
  ≈ y 6–127, classic bars ≈ y 6–169, both x 260–738) draw at z ≥ 48 over the OSD's z 30, so the instrument row sits
  below them: `.dosd-tl` and `.dosd-tr` at `top: 190px` (`.dosd-tr { right: max(calc(50% - 330px), 310px) }`, so an
  open main panel — right 8, width 300 — never covers it on a 16:10 HUD space; equal at 16:9); the heading tape at the BOTTOM (`.dosd-tape { top: auto;
  bottom: 150px; }`) so the centred banners (`top: 30%`) never cross it; the cheat sheet raised to `bottom: 240px`; in
  pilot view the banner sits low, below the pilot's feet and above the toolbar (`#hb-drone-osd[data-mode="pilot"] >
  .dosd-banner { top: auto; bottom: 24%; }`), not across the character the view exists to show. The `html.film-clean`
  corner overrides (H) stay, adjusted so nothing overlaps in the clean view. Positions are eye-test items (E3 / E4).
- Members:

  | Member | Contract |
  |---|---|
  | `show(mode, {durationSec = 0.35} = {}) → boolean` | `'off'` hides the root; `'boot'` runs the goggle-cut animation over `durationSec` (fade to black in the first half, wipe in during the second — CSS transitions / animations; the driver switches the camera at the black midpoint) and hides the static and the cheat sheet; `'fpv'` full OSD; `'pilot'` the banner row only (PILOT VIEW forced on, plus LOW BATTERY when flagged — the battery keeps draining); `'crash'` the CRASH banner, the static pinned at 0.85 and the vignette (readouts hidden). The cheat sheet shows only in `'fpv'`. |
  | `update(view) → boolean` | 10 Hz text update from `OsdView` (§5 step 11) `{mode, battery, timerSec, signal, distHomeM, aglM, speedMps, headingRad, homeBearingRad, banners: {rangeLimit, lowBattery, returning, crash, acroHint}, reticle: 'crosshair'\|'horizon'}`: every value is raw (`mode` ∈ `'cine'\|'angle'\|'acro'`, numbers, booleans) and osd applies its own formatters (`modeLabel(mode)`, `formatPercent(battery)`, …), so index.js needs no osd constant (§7.2); writes only changed `textContent`. Callable before the first `show()` (the values are kept and rendered when the DOM is built); false until the DOM exists. |
  | `frame({headingRad, rollRad, pitchRad}) → boolean` | Every frame: CSS transform of the heading tape and the horizon line only; allocation-free (cached string pieces); false until the DOM exists. |
  | `staticLevel(signal) → number` | Applies and returns `staticOpacity(signal)` (`staticOpacity(non-finite) = 0`); pinned at 0.85 in `'crash'` whatever is passed; false without a document. |
  | `cheatSheet(show, {durationSec = 5} = {}) → boolean` | Shows the cheat sheet (fades after `durationSec`, driven by `frame` calls and the `clock` dep — no timers); returns whether it is now showing (`cheatSheet(false)` → false). |
  | `clean(on) → boolean` | H key: on → adds `<style id="hb-drone-clean-css">` with `FILM_CLEAN_CSS + " " + DRONE_CLEAN_KEEP_CSS` and the `film-clean` class on `<html>`; off → removes that style and removes the class only if film's own `#film-clean-css` style is absent. Never calls `createCleanFrame` (it would lock every input). Returns the state. |
  | `dispose() → void` | `clean(false)`, removes the root and the style. Idempotent. |
  | `mode`, `built` | Diagnostic getters (the current OSD mode; whether the DOM exists). |

### 3.7 `scene3d/drone/audio.js` (L3)

```js
export const HUM_TUNING;   // L3-chosen constants (frequencies, detune, filter, noise band) — frozen
export function humParams({throttle, speed, level}) → {freqA, freqB, cutoffHz, noiseGain, gain}   // pure
export function createDroneAudio(deps = {}) → DroneAudio
```

- deps `{bus: EffectBus | (() => EffectBus|null) | null, enabled = true, volume: () => number (settings.volume),
  rng?, clock?: () => seconds (default `performance.now() / 1000`)}` where `EffectBus = {ctx, node, sliderGain: () =>
  number}` (§6.2). `bus` as a function is resolved at `start()` and, while started but unbuilt, at most once per
  second (by `clock`) in `update()`. `rng` is called once per instance to fill a cached noise table (builds stay
  identical with an injected generator).
- `humParams`: all finite; `gain = 0` when `level <= 0`; `freqA` and `cutoffHz` non-decreasing in throttle; a missing
  or non-object state reads as all zero (never throws).
- Graph (single-use nodes, rebuilt on a `start()` after `stop()`; a `start()` while a graph runs and is not fading
  keeps it and returns true, so a redundant start cannot click): two detuned sawtooth `OscillatorNode`s → low-pass
  `BiquadFilterNode` → input gain; band-passed looping noise `AudioBufferSourceNode` (buffer filled from
  `mulberry32(hashString("drone-audio"))`) → input gain; input → `ear` gain → `bus.node` and input → `pan` gain →
  `PannerNode` (HRTF, `distanceModel 'exponential'`, `refDistance 5`, `rolloffFactor 2`, `maxDistance 200` — the
  audio_manager HRTF model) → `bus.node`. The hum takes no voice-pool slot.
- Members: `start() → boolean` (false: disabled, no bus, or no ctx — a getter bus that is not ready yet still leaves it
  started, retrying from `update()` as above; resumes a suspended ctx — `start` runs inside the
  deploy click, a user gesture; builds the graph with output gain **0**, so it is silent until an `update` with
  `level > 0` — `update` runs only once the drone is in the world, and the level stays 0 until the rotors arm); `update({throttle, speed, level, fpv, pos}) → void` per frame, allocation-free:
  `level` 0..1 (rotor arm level), `fpv` true = in-ear (the listener is the drone eye), false = panner at AC `pos`
  written as `(x, z, −y)`; output gain = `humParams(...).gain · volume() · bus.sliderGain()`; AudioParams via
  `setTargetAtTime` (ear/pan crossfade τ 0.08 s, level τ 0.05 s); `stop({fadeSec = 0.4} = {}) → void` (ramps to 0, then
  stops oscillators and disconnects; from the `stop()` call on, `update` is a no-op until the next `start()`, so the
  per-frame `level: armLevel` never fights the fade — §7.4 `audio`); `dispose() → void` (immediate stop + disconnect of every node; idempotent);
  `active` getter; `stats() → {built, started, nodes}`. No bus → every method is a silent no-op (never throws).
  `?droneAudio=off` → `enabled: false`.

### 3.8 `scene3d/drone/world_link.js` (L4)

```js
export const DRONE_PREWARM = Object.freeze({ radius: 96, maxLandblocks: 4, minIntervalMs: 2000, timeoutSec: 8,
  envCells: false, collision: false, corridor: true });
export const DRONE_LENS_QUERY_MS = 250;
export function writeAcPose(obj, pos, q) → boolean        // for objects under liveScene3d.scene (three world)
export function prepareFollowCamera(cs) → CamPrep
export function restoreFollowCamera(cs, saved) → boolean
export function framePilotFront(cs, nowMs) → boolean
export function forcePilotOpaque(cs) → boolean
export function createWorldLink(deps = {}) → WorldLink
```

- Camera helpers — exact code §6.5. `writeAcPose(obj, pos, q)`: allocation-free `position.set(x, z, −y)`, normalised
  `quaternion.set(qx, qz, −qy, qw)`; false for non-finite input (kept for scene-direct objects; drone props use
  `props.setDronePose`).
- deps `{liveScene3d (REQUIRED; else FilmError code 'DRONE_NO_SCENE'), THREE, window, getSessionHandle: () => handle,
  wasmExports, body: {radiusM, restHeightM} (default {0.18, 0.06} = props DRONE_BODY), particleManagers?, log, now?}`.
  Construction recipe §6.3. Build at deploy, dispose at idle (createCameraOwner installs `liveScene3d.film` at
  construction; createWorldQuery pins the session handle at construction).
- **WorldLink**:

  | Member | Contract |
  |---|---|
  | `cameraOwner` | film camera owner: `own() → {ok, already, mode, camera}` (throws FilmError `FILM_CAMERA_UNAVAILABLE` without a camera — callers wrap), `release() → {ok, wasOwned}`, `write(pose) → boolean`, `owned`, `viewerCell() → u32`, `camera()`, `stats()`. |
  | `hooks`, `onPreFrame(fn) → off`, `onPostRender(fn) → off` | The shared film hooks; listeners added here are removed by `dispose()`. |
  | `safety` | Eye reflex: film defaults (near-plane radius ≥ 0.25 m, 0.7 m terrain floor), near-lens particle hide through a 4 Hz-throttled `particles.near`. |
  | `safetyBody` | Body reflex: `minRadius = body.radiusM` (call with `ctx.fovDeg = 1`), `terrainClearance = body.restHeightM`, `particleLens: false`. |
  | `world`, `worldQuery`, `particles`, `los` | Film objects (only `world.prewarm` is ever called; never `teleport` / `command` / `actor` / `avatar`). |
  | `groundZ(x, y) → number \| null` | `worldQuery.groundZ` — TERRAIN only (never floors / roofs), null when unknown (queues a corridor fetch). |
  | `prewarmAround(pos) → boolean` | `world.prewarm({points: [[x, y, z]], radius, maxLandblocks, timeoutSec, envCells, collision, corridor})` (those six keys of `DRONE_PREWARM`) when the drone entered a new landblock (`landblockOfWorld(x, y)` changed), one in flight, ≥ `minIntervalMs` apart, never awaited; true when started. The first call only sets the landblock baseline (the pilot's own landblock is resident); the landblock is re-derived only when `floor(x / LB_SIZE)` / `floor(y / LB_SIZE)` changes (`landblockOfWorld` allocates; `LB_SIZE` from the allowed `units.js` import). |
  | `aspect() → number` | Canvas width / height (`renderer.domElement`), else `cameraSwitcher.persp.aspect`, else 16/9. |
  | `configureLens(mode) → {ok, on}` / `drawLens({t, theta, throttle, fov}) → boolean` | Film lens overlay (lazily built from `{THREE, renderer}`): `'cine'` → `configure(null)` (off); `'angle'` → `configure({props:{style:'freestyle'}}, {uptiltDeg: 20})`; `'acro'` → same with `uptiltDeg: 25`; an unknown mode → off, `{ok:false, on:false}`. `drawLens` only when owned and active. |
  | `prepareFollowCamera() → CamPrep`, `restoreFollowCamera(saved)`, `framePilotFront(nowMs)`, `forcePilotOpaque()` | The §6.5 helpers bound to `liveScene3d.cameraSwitcher` (read at call time; no-ops returning false without one). |
  | `stats() → object` | JSON-safe (`camera`, `hooks`, `safety`, `safetyBody`, `lens`, `prewarm`, `disposed`, `listeners`). |
  | `dispose() → {ok, already, emittersShown}` | Reverse order: our hook listeners (only ours), `safety.release()` + `safetyBody.release()`, then `cameraOwner.dispose()` (release + delete `liveScene3d.film` when no listener and no holdLoop remain) — or only `cameraOwner.release()` when `liveScene3d.film` already held a hooks object before the link was built and the drone's owner adopted that very object (`foreignHooks`: `live.film` read right before `createCameraOwner` is an object and `=== cameraOwner.hooks`; film installs its hooks at init3D, before any deploy, so deleting them would detach film's camera owner, take grab and scout stills for the rest of the page — R1-04; no `win.__film` clause), lens overlay `dispose()`, `worldQuery.reset()`, `corridor.clear()`. Idempotent; afterwards `onPreFrame` / `onPostRender` return no-op unsubscribers (no hooks re-installed) and `prewarmAround` / `drawLens` return false. A prewarm in flight is not cancellable and finishes on its own (every required kind baked, or its 8 s `timeoutSec`, then it awaits the corridor fetch). |

### 3.9 `scene3d/drone/index.js` (L4) — `window.__drone`

```js
export const DRONE_API_VERSION = "drone-1";
export const DRONE_REFUSAL_REASONS;   // §2.8 table (incl. `targeting` and the index-only `covered`)
export const DRONE_SETTINGS_DEFAULTS; // table below
export const SETTINGS_RULES;          // {key: {type:'enum'|'number'|'boolean', values?|min?/max?}}
export function readDroneFlags(search) → {debug, audio}
export function validateSettingsPatch(patch) → {ok:true, value} | {ok:false, code:'bad-argument', reason}
export function mergeAnchors(defaults, profile, local) → Anchors
export function jsonSafe(v) → JSON-safe copy
export function sessionKey(h), sessionMark(win), sessionChanged(win, mark)   // §6.7
export function filmBusy(win) → boolean                                         // §6.7
export function readPilot(live, win, out) → inst | null                         // §6.7
export function watchContextLoss(canvas, onLost, onRestored) → unsubscribe      // §6.13
export async function installDrone(deps = {}) → DroneApi
export function _resetDroneForTest() → void
```

**Settings** (`DRONE_SETTINGS_DEFAULTS`; `setSettings` validates every key; one bad key → the whole patch refused):

| Key | Type / range | Default | Applies |
|---|---|---|---|
| `mode` | `'cine'\|'angle'\|'acro'` | `'cine'` | live (`craft.setMode`, lens overlay) |
| `sensitivity` | number [0.1, 5] | 1.0 | live (controls) |
| `invertY` | boolean | false | live |
| `gamepadLayout` | `'mode2'\|'mode1'` | `'mode2'` | live |
| `acroRc` / `acroSuper` / `acroExpo` | [0.1, 3] / [0, 0.95] / [0, 1] | 1.0 / 0.7 / 0 | live (`craft.setRates`) |
| `rangeM` | number [20, 180] | 150 | live (`tether.configure`) |
| `ceilingAglM` | number [10, 120] | 120 | live |
| `batteryMin` | number [0, 60] (0 = off) | 10 | next deploy |
| `crash` / `crashMps` | boolean / [2, 30] | true / 7 | live (tick input `crashMps`, 0 when `crash` false) |
| `quickDeploy` | boolean | false | next deploy (and its stow) |
| `launchFacing` | `'pilot'\|'away'` | `'pilot'` | next deploy |
| `broadcastPose` | boolean | false | next tablet-up |
| `volume` | number [0, 1] | 0.6 | live |
| `fovDeg` | number [60, 110] (vertical) | 75 | live; the wheel steps it ±5° per notch (§5 step 1; dirty only when the value changes — no writes while clamped at 60 / 110) and persists debounced (§5 step 13) |

**DroneApi** (installed as `window.__drone`; every method never throws, JSON-safe):

| Method | Contract |
|---|---|
| `version` | `"drone-1"` |
| `status() → {ok, version, state, beat, mode, since, quick, rig, craft, input, camera, flags, lastAbort}` | Runs `settleFilmGate()` first (R1-03, §6.4; the plugin polls `status()` at 2 Hz in every state). `rig = {kind, setupId: "0x…", parts} \| null` (while idle: the last known rig of the same local guid, so the HUD can show the no-hands note after load; else null); `craft = {pos, vel, hprDeg: {h, p, r}, aglM, speed, distHomeM, signal, battery} \| null` (null while the drone is not in the world); `input = {source, pointerLocked, locked, gamepad}`; `camera = {owned, fovDeg}`; `flags = {debug, audio, signals: 'bus'\|'levels-only'}`; `lastAbort = {reason, from, at} \| null`. After `dispose()` → `{ok:false, code:'disposed'}`. |
| `deploy({quick} = {}) → {ok, state, quick} \| {ok:true, already:true, state} \| refusal` | Idle only (deploying → `already`; other states → `busy`; also `busy` while the previous cycle's teardown is still pending, i.e. a deploy from inside its `idle` event). Order: own state, `settleFilmGate()`, `deps.refusal?.()` code (passed through with the §2.8 text, e.g. `targeting`; an unknown code → `Cannot deploy (<code>)`), internal `not-in-world` checks (§6.7, incl. `live.__webglContextLost === true` — R1-08: no lock while the canvas is lost), build the cycle (§7.3) up to the world link, the **open-sky check** (below; a roof → `covered`, the half-built cycle torn down), the rest of the cycle, synchronous request tick (T1 locks input). `quick` defaults to the `quickDeploy` setting; non-object options or a non-boolean `quick` → `bad-argument`. |
| `recall({instant} = {}) → {ok, state} \| {ok:true, already:true, state}` | deploying after the own (state `deploying`, live cycle, `seq.state().cutFired.own === true`: the pilot already sees the goggles view) → `takeControlAfterCut()` first, i.e. `request('skip')`, which is T8, then as from flying (R1-02: the press is no longer dropped until T8); flying / pilotView → returning (instant → camera released now); returning → `instant` cuts the camera now, otherwise `already`; landing / stowing → `already`; else `{ok:false, code:'not-flying'}`. A non-boolean `instant` → `bad-argument`; `already` answers carry `state`. |
| `skip() → {ok, state}` | deploying → jump to lift-off / the cut / flight (§4.5 T9); else `not-flying`. |
| `button({shift} = {}) → {ok, action, ...}` | The launcher / Shift+F11 action by state: idle → `deploy()`; deploying → `skip()`; flying / pilotView → `recall({instant: shift})`; returning → `recall({instant: true})`; landing / stowing / aborting / crashed → `{ok:true, action:'ignored', state}`. |
| `abort(reason = 'user') → {ok, state}` | Unknown reason → `'user'`; idle → `{ok:true, state:'idle', already:true}`. |
| `setMode(mode) → {ok, mode}` | Validates, persists `settings.mode`, applies live. |
| `pilotView(on) → {ok, state}` | Deploying after the own → `takeControlAfterCut()` first (as `recall`, R1-02); `undefined` toggles; true enters from flying; false leaves to flying; else `not-flying`. A non-boolean `on` → `bad-argument`; `already` answers carry `state`. |
| `settings() → {ok, settings, defaults}` / `setSettings(patch) → {ok, settings} \| {ok:false, code:'bad-argument', reason}` | Works without a scene (the HUD popover uses it before any deploy). Persists `hb.drone.v1`. |
| `tune(patch?) → {ok, setupId, anchors, clipMode, source}` | No arg: the active anchors for the pilot's setup (`source 'default'\|'profile'\|'local'`); patch `{tablet?, goggles?, droneInHand?: {pos?:[3], quat?:[4], scale?}, clipMode?: 'clip'\|'timer', reset?: true}` validated (finite; quats normalised; `scale` only for `goggles`; unknown keys or invalid fields → `bad-argument`), merged into `hb.drone.tune.v1[setupId]`, applied live (`props.setAnchors`). No pilot → `not-in-world`. |
| `debug` | Present only with `?droneDebug=on`: `setSticks(axes, ms) → {ok, untilSec}` (override `controls.poll` for `ms` of driver time; axes clamped), `trigger(signal) → {ok}` (`'damage'\|'death'\|'portal'\|'combat'\|'pilotMoved'\|'session'\|'film'\|'contextLost'`, latched for the next tick), `clipParity() → Promise<…>` (gestures), `events({limit = 100}) → {ok, events}`. |
| `dispose() → {ok}` | Hard abort `'dispose'`, teardown, `delete window.__drone`, module singleton cleared; later calls → `{ok:false, code:'disposed'}`. |

**Open-sky check** (`deploy()`, phase 4 F1; §14.4). The return climbs to ground + 15 m (`RTH_CRUISE_AGL_M`) and comes
straight down onto home, so a roof, an arch or an overhang over the launch spot catches it (1070: it settled on an
archway 14 m above home). After the refusals and `not-in-world` checks, once `link = createWorldLink(…)` exists
(the check needs `link.los`, `link.groundZ` and the link's session handle) and BEFORE anything else of the cycle and
`request('deploy')` (T1 locks input):

- **Columns** (AC world): the pilot `P` (`readPilot`) and, along the pilot's compass `c` (`f = (sin c, cos c)`),
  `P + f·DROP_AHEAD_M.humanoid` (0.72), `P + f·DROP_AHEAD_M.noHands` (1.5) and the lift-off end
  `P + f·(DROP_AHEAD_M.humanoid + LIFTOFF.backM)` (4.12; the lift-off backs away along `away` = the drop direction).
- **Each column**: `base = dropZ(x, y, P)` — the drop height there (§6.11): the terrain `link.groundZ(x, y)` under a
  pilot standing on the terrain, `P.z` where the terrain is unknown, for a pilot on a floor / platform the DV-22
  height (the pilot's floor `P.z` unless the terrain there is within 0.5 m of it) —; the segment
  `(x, y, base + 0.5) → (x, y, base + OPEN_SKY_M)` with `OPEN_SKY_M = 16.5` (the cruise AGL 15 + a margin; 0.5 m keeps
  ground clutter out); `link.los.segmentBlocked(sh, from, to, {layers: ["buildingMesh", "statics", "scenery",
  "cellMesh", "cellStatics"], radius: DRONE_BODY.radiusM, exemptLocalPlayer: true})` (film `scene/los.js`; `sh` = the
  link's session handle, its §6.3 `shOf` chain). No `terrain` (the floor), no `entities` (BSP doors, chests), no
  `objects` (the cylsphere / sphere bodies of creatures, players, NPCs and dynamic props): none is a roof. The cell
  layers sweep only with cell ids, which an outdoor launch spot has none of (no-ops kept in the list).
- **Any `blocked`** → `{ok:false, code:'covered', reason:'Needs open sky above you'}`; the cycle holds only the link
  then and is torn down exactly like the internal-error path (`teardown`: `link.dispose()` — no hook listener, the
  camera never owned, `liveScene3d.film` deleted when the link made it, film's own hooks object kept; no window /
  document / canvas listener, no lock, prop, audio graph, AudioContext resume or bus subscription was ever made; the
  funnel untouched; the state stays `idle`, no `hb-drone-state` event). An info log entry `{message: 'covered', aheadM,
  layer, kind, roofM}` (roofM = the hit's height above `base`) names the column.
- A sweep method the handle lacks finds nothing (an old pkg, a test fake: open sky), and so does a missing session
  handle (no handle anywhere in the chain: nothing is swept); a throwing column reads as open sky (a warn).
  Deploy-time only: ≤ 4 columns × 3 wasm sweeps (one chunk each), allocates.
- Known misses (false negatives, recorded in phase 4, not fixed): each wasm sweep returns only its earliest hit, so a
  column that starts within the body radius of a surface (a wall < 0.18 m away, a floor just under `base + 0.5`) gets
  a t ≈ 0 along / away hit that los.js discards, and a roof above it in that layer goes unseen; a column that starts
  inside a static's AABB finds nothing in `statics` (physics.rs `ray_aabb_entry`); building triangles are read for
  the column's own landblock only (a building of the neighbouring landblock overhanging the edge is missed); the
  no-hands lift-off end (1.5 + 3.4 m) is not a column.

### 3.10 `scene3d/drone/sequence.js` (L4, pure)

```js
export const SEQUENCE_STATES = Object.freeze(["idle","deploying","flying","pilotView","returning","landing","stowing","aborting","crashed"]);
export const REQUESTS = Object.freeze(["deploy","skip","recall","recallInstant","pilotView","abort"]);
export const ACTION_TYPES = Object.freeze(["state","inputLock","inputRestore","controlsPhase","hideWielded","clip",
  "stopClip","motion","attach","detach","place","fadeOut","cameraOwn","cameraRelease","autopilot","rotors","osd",
  "audio","broadcastPose"]);
export const ABORT_REASONS = Object.freeze(["damage","death","portal","combat","pilotMoved","session","film",
  "contextLost","user","dispose","rigLost","error"]);
export const HARD_ABORT_REASONS = Object.freeze(["session","contextLost","portal","pilotMoved","film","dispose","rigLost","error"]);
export const BEAT_SEC;          // §4.4 (frame counts / 30)
export const BEAT_EVENT_SEC;    // §4.4 (exported too, phase 1)
export const SEQUENCE_DEFAULTS = Object.freeze({ quickSpeed: 1.5, slackSec: 0.05, prepTimeoutSec: 1.0,
  crashStaticSec: 1.0, landingReleaseM: 5, homeToleranceM: 1.5, pilotMovedAbortM: 2,
  fadeDelaySec: 5, fadeDurationSec: 1, cutStartSec: 0.925, cutBlackSec: 1.1, cutEndSec: 1.275, settleTimeoutSec: 8 });
// cutBlackSec = BEAT_SEC.liftoff / 2: the own lands on the lift-off path midpoint (0.85 m up, 1.7 m out; DV-31);
// cutStartSec / cutEndSec = cutBlackSec ∓ 0.175 (the 0.35 s boot wipe). settleTimeoutSec = fadeDelaySec +
// fadeDurationSec + 2 (T29). All at speed 1; the liftoff sub-events divide by the beat speed like the beat itself.
export const NO_ACTIONS;        // Object.freeze([])
export function createSequence(opts = {}) → { tick(input) → Action[], state() → SequenceState, reset() → void }
```

Fully specified in §4.

### 3.11 `plugins/drone-hud.js` (L5)

```js
export const DRONE_DEFAULT_ON = true;   // flipped 2026-10-25 (§14.5)
export function droneHudEnabled(search, defaultOn = DRONE_DEFAULT_ON) → boolean     // §2.5
export const REFUSAL_TEXT;                                                          // §2.8 table
export function refusalFor(signals) → string | null                                 // §6.7
export function readDeploySignals(win = globalThis.window, cache = S, droneState) → signals   // §6.7
export function broadcastReadEmote(win = globalThis.window) → {ok, echo?, error?}   // §6.9
export function mount(ctx) → dispose
export default { mount };
```

- **Manifest** `plugins/drone-hud.manifest.json` (exact):
  ```json
  {
    "$schema": "./schemas/plugin-manifest.json",
    "id": "drone-hud",
    "name": "Drone",
    "author": "holtburger",
    "version": "0.1.0",
    "description": "Drone Deploy launcher: a toolbar button under the RynthSuite ⚒ (plugins/hotbar.js .hb-hotbar-addons) that deploys, flies and recalls a local-only camera drone (scene3d/drone/, loaded on first use). Click deploys / skips / recalls, Shift+click recalls at once, right-click opens the settings, Shift+F11 = the button; on by default, ?drone=off (exact match) hides it.",
    "icon": "✈",
    "iconHidden": true,
    "entry": "./drone-hud.js",
    "environments": ["browser"],
    "slots": ["hud", "overlay"],
    "hotkeys": [{ "id": "toggle", "default": "Shift+F11", "label": "Deploy / recall drone" }],
    "clientApi": "^1.0"
  }
  ```
  No `capabilities` (a required capability missing from the handle probe makes the loader skip the plugin). Then
  `node plugins/gen-index.mjs` (51 entries; `drone-hud` sorts between `corpse-loot-bar` and `dye-preview`).
- **DOM ids / classes (API for tests)**: style `#hb-drone-hud-style`, launcher `button#hb-drone-hud-launcher.dhud-launcher`
  with children `span.dhud-launcher-icon` (quadcopter SVG as a CSS `mask` data URI — no `innerHTML`, no
  `createElementNS`) and `span.dhud-launcher-dot`; float `#hb-drone-hud-launcher-float`; settings popover
  `div#hb-drone-hud-settings.hbk-window` (`data-open "0"|"1"`).
- **Mount** `mount(ctx)` (`ctx = {client: null, slot, root, bar}` from ui/bar.js; test seams `ctx.loadDrone?: (deps) =>
  Promise<DroneApi>`, `ctx.prewarm?: () => Promise`): returns `() => {}` when `!droneHudEnabled(location.search)` or
  when a launcher already exists; otherwise styles, launcher (§6.6), `releaseMouseFocus(launcher)`, the
  `hb-hotbar-mounted` listener, the `hb-drone-state` listener (`document.addEventListener("hb-drone-state", …)` — the
  event is dispatched on `document` with `bubbles: false`, exactly once per transition, `detail = {state, prev, at}`,
  §7.4; a window listener would never see it; the handler runs `launcherTick` in a microtask, after index.js's action
  list), the popover's outside-press closer (below), the late-bound bus (§6.7), the idle prewarm (§7.5), a
  500 ms `launcherTick`, `window.__toggleDroneHud = () => activate({shift:false})`, `window.__droneHud = Object.freeze({
  load(), prewarm() })` — `load()` → `{ok: true, version}` \| `{ok: false, code: 'not-available', reason}` and never
  rejects; `prewarm()` before `__sceneReadyEverFired` → `{ok:false, compiled:0, ms:0, reason: 'the scene is not
  ready'}` without using up the page's one prewarm, afterwards the memoised result. The disposer removes all of it,
  also the style and the popover, and is idempotent (a second call never touches a newer mount; production never calls
  it — bar teardown is not wired; tests do).
- **Launcher behaviour**: click (`e.stopPropagation()`) → `activate({shift: e.shiftKey})`; right-click
  (`preventDefault` + `stopPropagation`) → the settings popover (a second right-click closes it); never `disabled` (a
  disabled button gets no contextmenu) — refused states use `aria-disabled="true"`. `activate`: drone state `idle` (or
  module not loaded) → `refusalFor(readDeploySignals(window, S, state))` first, with the state it has just read (red
  flash, no load) → else `loadDrone()` then `api.button({shift})`; other states → `api.button({shift})`. A failed load
  clears the memo (the next click retries) and flashes red (`busy`).
- **Dot** (`data-state`): `busy` (amber `#e0b040`) in deploying / returning / landing / stowing / aborting / crashed;
  `flying` (green `#6fe36f` + glow) in flying / pilotView; `refused` (red `#c85040`) when idle and either a persistent
  refusal is current (`not-in-world`, `indoors`, `combat`, `portal`, `dead`, `film-busy`) or a click was refused in the
  last 2.5 s; else `idle` (grey `#555`). `moving`, `busy` and `targeting` never turn the dot red on their own (nor does
  `covered`, which only index.js sees, at deploy: it arrives as a refused click); the
  tooltip still shows them, and a persistent code behind them still turns it red (the dot reads the refusal past them:
  `refusalFor({...s, busy: false, targeting: false, moving: false})`). `aria-disabled` toggles `"true"` / `"false"` and
  is `"true"` exactly while a persistent refusal holds (a click flash does not set it). `.is-active` (§6.6 CSS) = a
  cycle is running (state ≠ idle) or the popover is open.
- **Tooltip** (`data-tip=""` + `_hbTip() → {text: "Drone", key: hotkeyLabel(), sub}`): `sub` = the current refusal
  `REFUSAL_TEXT` in idle (with none current but a click refused in the last 2.5 s: that click's
  `REFUSAL_TEXT[code] ?? reason`), else `Deploy the camera drone (right-click: settings)`; `Deploying — click to skip`;
  `Flying — click to fly home (Shift: now)`; `Flying home — click to recall now`; `Landing…`; `Stowing…`;
  `Aborting…`; `Crashed…`; after load, a no-hands rig appends ` · No hands: the drone launches beside you` to that one
  `sub` line (the kit tooltip renders a single sub line). `hotkeyLabel()` = rynth-hud's (manifest binding for
  `drone-hud` / `toggle`, fallback `"Shift+F11"`). Short lines (the kit tooltip is `nowrap`). Every state read here and
  in the tick is one `status()` call whose state is passed into `readDeploySignals` (R2-7).
- **Settings popover** (right-click; HUD-kit look: `hbk-window`, `makeTitlebar("Drone", {onClose})`, `.hbk-select`,
  `.hbk-check`, `.hbk-range`): loads the drone module (`loadDrone()` — installDrone needs no scene), renders from
  `api.settings()`, writes with `api.setSettings(patch)` and re-renders from the result. Rows: Flight mode, Quick
  deploy, Invert mouse Y, Crashes, Show /read to others, Motor volume, Mouse sensitivity (0.25–3), Range (50–180 m),
  Battery (Off / 5 / 10 / 15 / 20 min; a stored value off the list, e.g. 1 set through the API, shows as an extra
  option). Ranges write on `change` (the label follows `input`); checks and ranges get `releaseMouseFocus`, selects
  blur on change. Placed next to the launcher in HUD px (`hudRect`, `hudViewport`); closes on Escape (preventDefault —
  counts as consumed for escape_action; this keydown listener lives only while open), the titlebar close, a second
  right-click, or an **outside press**: one window-capture `pointerdown` + `mousedown` closer registered ONCE at mount
  (it returns while the popover is closed) and removed only by the disposer (R2-4: registered at open time it sat
  behind the drone lock's window-capture blockers, which `stopImmediatePropagation()` every canvas press from T1 on,
  so a popover opened mid-cycle never closed on a canvas click; `pointerdown` too because a cancelled pointerdown —
  picking.js on an entity pick, HUD buttons — sends no compatibility `mousedown`). A press on the launcher is not
  outside. Every close blurs a control still focused inside the popover (the input funnel defers every key while an
  INPUT / SELECT is focused).
- `droneDeps` (§6.7) is one `Object.freeze`d object per page; index.js never writes to it.

---

## 4. The state machine (`sequence.js`)

### 4.1 States and the sequence's own model

States: `idle → deploying(beat) → flying ⇄ pilotView → returning → landing → stowing(beat) → idle`; `crashed →
stowing(noDrone) → idle`; `aborting → idle`. The sequence keeps (and `state()` reports, JSON-safe):

```
{ state, beat: string|null, beatIndex, beatElapsed, since, quick, speed, rig, pendingSkip,
  fpv: boolean,          // the sequence has issued cameraOwn and not cameraRelease
  locked: boolean,       // inputLock issued, inputRestore not yet
  drone: 'none'|'hand'|'ground'|'air'|'fading',
  tablet, goggles, wieldedHidden, held: boolean,   // held = ReadState issued, Ready not yet
  clipActive: boolean,   // a clip beat is running
  rth: null | {reason: 'user'|'battery', fpv: boolean, cancellable: boolean,
               armed: boolean},   // false whenever an RTH starts (T12–T14, T18); true from the first returning tick
                                  // with !input.sticksActive; only T16 reads it
  forcedLanding: boolean, batteryRthUsed: boolean, stowKind: 'full'|'noDrone'|null,
  cutFired: {boot, own, fpv}, eventFired: boolean, lastAbort: {reason, from, at}|null }
```

### 4.2 Tick input (one reused object, owned by index.js; the sequence never keeps a reference)

```
{ dt, now,                                     // dt ≥ 0 (non-finite → 0); now seconds
  request: null|'deploy'|'skip'|'recall'|'recallInstant'|'pilotView'|'abort',
  arg: null | {quick: boolean} | {reason: string},
  rig: null|'humanoid'|'no-hands',             // the kind once gestures.ready() has RESOLVED (profile + clips settled,
                                               // built or failed); null before. Ends the prep (§4.4).
  rigKnown: null|'humanoid'|'no-hands',        // gestures.profile()?.kind (known before the clips); read only by the
                                               // prep timeout
  beatEvent: boolean, beatDone: boolean,       // gestures.poll(): this tick's event / end of the current clip job
  input: {sticksActive, anyInput},             // sticksActive: |throttle|,|yaw|,|pitch|,|roll| > 0.1;
                                               // anyInput: sticksActive || |gimbal| > 0.1 || boost || lookX || lookY
  signals: {damage, death, portal, stanceCombat, pilotMovedM, sessionChanged, filmBusy, contextLost, hidden},
  craft: {landed, aglM, distHomeM, distTouchdownM, impactSpeed, autopilotDone, gone},  // previous frame's craft
  battery: {level, warn, rth, empty},          // tether.drain() → {level: r.battery, warn, rth, empty}; before the
                                               // first drain {level: 1, warn: false, rth: false, empty: false}
  crashMps }                                   // 0 = crashes off
```

`craft.gone` = the drone left the scene after a fade (`props.where('drone') === 'none' && !props.fading('drone')`).

### 4.3 Actions (plain objects, executed in order by index.js §7.4)

| Action | Payload |
|---|---|
| `{type:'state', state, prev}` | first action of every transition |
| `{type:'inputLock'}` / `{type:'inputRestore'}` | |
| `{type:'controlsPhase', phase: 'deploy'\|'fly'\|'pilot'\|'stow'}` | |
| `{type:'hideWielded', on}` | |
| `{type:'clip', name: 'pack'\|'place'\|'goggles', speed}` / `{type:'stopClip'}` | |
| `{type:'motion', cmd: 'ReadState'\|'Ready', speed: 1}` | motions always at speed 1 (DV-12) |
| `{type:'attach', prop, anchor}` | `prop ∈ drone\|tablet\|goggles`, `anchor ∈ rightHand\|leftHand\|head` |
| `{type:'detach', prop, to: 'world'\|'remove'}` | `world` = the drone onto the ground under the hand |
| `{type:'place', prop: 'drone'}` | the drone straight onto the drop spot (quick, skip, no-hands) |
| `{type:'fadeOut', prop: 'drone', delaySec, durationSec}` | |
| `{type:'cameraOwn'}` / `{type:'cameraRelease', framePilot: boolean}` | |
| `{type:'autopilot', plan: 'liftoff'\|'rth'\|'hold'\|'landHere'\|'crash'\|null, speed}` | symbolic; index.js builds the plan; `speed` = the beat speed `s` for liftoff, 1 for every other plan |
| `{type:'rotors', level: 0\|1, rampSec}` | motor arm level |
| `{type:'osd', mode: 'off'\|'boot'\|'fpv'\|'pilot'\|'crash', durationSec?}` | `durationSec` only on `boot` |
| `{type:'audio', level: 0\|1, rampSec}` | 0 → stop after the ramp |
| `{type:'broadcastPose'}` | index.js runs it only when `settings.broadcastPose` |

`tick` returns `NO_ACTIONS` (the shared frozen empty array) when nothing happens; action arrays are allocated only on
transitions.

### 4.4 Beats

`s` = 1 (or `quickSpeed` 1.5 when quick). `slack` = 0.05 s. A beat **ends** on the first tick with `beatDone`
(clip beats) or `beatElapsed ≥ duration + slack`; its **event** fires once on `beatEvent` or `beatElapsed ≥ eventSec +
slack`, and always before the end actions (an end without an event fires the event first).

| Phase / beat | idx | duration | event at | entry actions | event actions | next |
|---|---|---|---|---|---|---|
| deploy `prep` | 0 | ends on a tick with `dt > 0` when `rig !== null` (i.e. after `gestures.ready()` resolved, so the first pack clip is a real clip whenever it can be built — on the first deploy of a page the anims are still loading when the profile becomes known), or at `prepTimeoutSec` 1.0 (rig → `rigKnown ?? 'no-hands'`: a known humanoid still plays its gesture beats — clips not built by then run as timer jobs — and only an unresolved rig takes the no-hands flow) | — | (T1) | — | `pendingSkip` → `liftoff` via the skip list; humanoid → `pack` (`place` when quick); no-hands → `spawn` |
| deploy `pack` | 1 | 43/30/s | 18/30/s | `clip(pack, s)` | `attach(drone, rightHand)` | `place` |
| deploy `place` | 2 | 50/30/s | 18/30/s | `attach(drone, rightHand)` if drone `none` (quick); `clip(place, s)` | `detach(drone, world)` | `goggles` |
| deploy `goggles` | 3 | 42/30/s | 14/30/s | `clip(goggles, s)` | `attach(goggles, head)` | `tabletUp` |
| deploy `tabletUp` | 4 | 22/30 | — | `attach(tablet, leftHand)`, `motion(ReadState, 1)`, `broadcastPose`, `rotors(1, 22/30)`, `audio(1, 22/30)` | — | `liftoff` |
| deploy `spawn` (no-hands) | 4 | 22/30 | — | `place(drone)`, `rotors(1, 22/30)`, `audio(1, 22/30)` | — | `liftoff` |
| deploy `liftoff` | 5 | 2.2/s | sub-events below | `autopilot(liftoff, s)` (drone → `air`) | at `cutStartSec/s` (0.925/s): `osd(boot, durationSec 0.35/s)`; at `cutBlackSec/s` (1.1/s, the path midpoint): `cameraOwn`, `controlsPhase(fly)`; at `cutEndSec/s` (1.275/s): `osd(fpv)` | `flying` (T8) |
| stow `tabletDown` | 1 | 22/30 | — | `motion(Ready, 1)` | — | end: `detach(tablet, remove)` → `gogglesOff` |
| stow `gogglesOff` | 2 | 42/30/s | 14/30/s | `clip(goggles, s)` | `detach(goggles, remove)` | full → `pickUp`; noDrone → `settle` (T26) |
| stow `pickUp` | 3 | 50/30/s | 18/30/s | `clip(place, s)` | `attach(drone, rightHand)` | normal → `packAway`; quick → end `detach(drone, remove)` → finish (T25) |
| stow `packAway` | 4 | 43/30/s | 18/30/s | `clip(pack, s)` | `detach(drone, remove)` | finish (T25) |
| stow `powerDown` (no-hands, full) | 1 | 0.6 | — | — | — | end: `detach(drone, remove)` → finish (T25) |
| stow `settle` / aborting `settle` | — | until `craft.gone`, at most `settleTimeoutSec` 8 | — | — | — | idle (T27; T29 on the timeout) |
| crashed `static` | — | `crashStaticSec` 1.0 | — | (T22) | — | T23 |

`BEAT_SEC = {pack: 43/30, place: 50/30, goggles: 42/30, tabletUp: 22/30, tabletDown: 22/30, spawn: 22/30,
powerDown: 0.6, liftoff: 2.2, crashStatic: 1.0}` and `BEAT_EVENT_SEC = {pack: 18/30, place: 18/30, goggles: 14/30}`
(at speed 1; gestures `GESTURE_CLIPS[name].frames` must equal 43 / 50 / 42).

**Totals** (from the end of `prep`, which takes ≥ 1 frame and ≤ 1.0 s; a clip beat may end a frame late, a timer beat
adds its 0.05 s slack). The kinematic lift-off makes every lift-off number exact (DV-31):

| Cycle | Gestures | Boot wipe starts | `cameraOwn` | Control by time (T8; any input after the own takes it earlier) |
|---|---|---|---|---|
| deploy, humanoid | 43/30 + 50/30 + 42/30 + 22/30 = 5.233 s | 6.158 s | 6.333 s | 7.433 s |
| deploy, humanoid, quick | 50/30/1.5 + 42/30/1.5 + 22/30 = 2.778 s | 3.394 s | 3.511 s | 4.244 s |
| deploy, no-hands (`spawn`) | 22/30 = 0.733 s | 1.658 s | 1.833 s | 2.933 s |
| deploy, no-hands, quick | 0.733 s | 1.350 s | 1.467 s | 2.200 s |

Stow from touchdown (humanoid): full 22/30 + 42/30 + 50/30 + 43/30 = 5.233 s; quick 22/30 + 42/30/1.5 + 50/30/1.5 =
2.778 s; noDrone 22/30 + 42/30/s, then the settle until the fade ends. (PLAN §2.1 "≈5.6 s from click to control;
quick ≈3 s" and §2.3 "≈5 s; quick ≈2.5 s" do not add up from its own beats — DV-34.)

### 4.5 Transition table

Guards are checked in this order every tick: (1) the request, (2) abort signals (§4.6), (3) crash, (4) battery,
(5) the state's own rules / beat clock. One transition per tick at most, except that a beat ending immediately applies
the next beat's entry actions in the same tick. A request tick that transitions nothing still runs guards (2)–(5)
(e.g. an ignored request in returning with released sticks sets `rth.armed`); index.js clears `beatEvent` / `beatDone`
on request ticks (they are frame edges).

| # | From | Trigger (guard) | To | Actions (in order) |
|---|---|---|---|---|
| T1 | idle | `deploy` (`arg.quick`) | deploying/prep | `state`, `inputLock`, `controlsPhase(deploy)`, `hideWielded(true)` |
| T2 | deploying/prep | §4.4 prep rule | next beat | the next beat's entry actions |
| T3 | deploying/clip beat | event | (same) | the beat's event actions (once) |
| T4 | deploying/beat | end | next beat | pending event actions, the beat's end actions, next entry |
| T5–T7 | deploying/liftoff | `beatElapsed ≥ cutStartSec/s`, `≥ cutBlackSec/s`, `≥ cutEndSec/s` (each once) | (same) | §4.4 liftoff sub-events |
| T8 | deploying/liftoff | `fpv && (craft.autopilotDone \|\| beatElapsed ≥ 2.2/s \|\| input.anyInput)` | flying | `state`, [`osd(fpv)` when control is taken before the cutEnd sub-event (T7 not yet fired): any input, autopilotDone or a skip in the 0.175 s after the own — else the OSD would stay in `boot` for the whole flight], `autopilot(null)`. index.js `takeControlAfterCut()` reaches this row from `recall()` / `pilotView()` too (a `skip` request after the own, §3.9) |
| T9 | deploying/any | `skip` | deploying/liftoff | prep → `pendingSkip = true` (no actions; prep then ends into the skip list). Beats 1–4 → `stopClip` (if `clipActive`), `attach(goggles, head)` and `attach(tablet, leftHand)` (humanoid), `place(drone)` (if drone ∉ {ground}), `motion(ReadState, 1)` (humanoid, if not held), `broadcastPose` (right after it: the skipped tabletUp beat is the only other place the opt-in `/read` goes out; a no-op with the setting off), `rotors(1, 0.3)`, `audio(1, 0.3)`, then the liftoff entry (`beatElapsed = 0`: PLAN "skips to beat 5", whose cut stays on the path midpoint so it frames the pilot, not the legs). Liftoff before `cutBlackSec/s` → `beatElapsed = max(beatElapsed, cutStartSec/s)` (the cut starts now; the kinematic plan keeps its own clock, so a skip early in the lift-off cuts in low and the eye reflex holds its 0.7 m terrain floor until the path climbs past it — E3+). Liftoff after the own → T8 now. |
| T10 | flying | `pilotView` | pilotView | `state`, `autopilot(hold)`, `cameraRelease(framePilot: true)`, `controlsPhase(pilot)`, `osd(pilot)` |
| T11 | pilotView | `pilotView` | flying | `state`, `cameraOwn`, `controlsPhase(fly)`, `osd(fpv)`, `autopilot(null)` |
| T12 | flying | `recall` | returning `{user, fpv, cancellable, armed: false}` | `state`, `autopilot(rth)` |
| T13 | flying | `recallInstant` | returning `{user, third, not cancellable}` | `state`, `cameraRelease(framePilot: false)`, `controlsPhase(stow)`, `osd(off)`, `autopilot(rth)` |
| T14 | pilotView | `recall` / `recallInstant` | returning `{user, third, not cancellable}` | `state`, `controlsPhase(stow)`, `osd(off)`, `autopilot(rth)` |
| T15 | returning (fpv) | `recallInstant` | (same; `fpv false`, not cancellable) | `cameraRelease(framePilot: false)`, `controlsPhase(stow)`, `osd(off)` |
| T16 | returning (fpv, cancellable) | `rth.armed && input.sticksActive` — `armed` turns true (no action) on the first returning tick with `!input.sticksActive`, so a stick still held when R / gamepad A / the battery triggered the RTH never cancels it; only a fresh stick input does | flying | `state`, `autopilot(null)` |
| T17 | returning | `craft.distTouchdownM !== null && ≤ landingReleaseM (5)` | landing | `state`, then if fpv: `cameraRelease(framePilot: false)`, `controlsPhase(stow)`, `osd(off)` |
| T18 | flying / pilotView | `battery.rth && !batteryRthUsed` | returning `{battery, fpv: state === flying, cancellable: state === flying, armed: false}` | `state`, `autopilot(rth)` (+ from pilotView: `controlsPhase(stow)`, `osd(off)`); `batteryRthUsed = true` |
| T19 | flying / pilotView / returning | `battery.empty` | landing (`forcedLanding`) | `state`, `autopilot(landHere)` (+ from pilotView: `controlsPhase(stow)`, `osd(off)` — the "PILOT VIEW · Tab / View: goggles" banner must not outlive the pilot view) |
| T20 | landing (fpv) | `craft.distTouchdownM !== null && ≤ 5` | (same) | `cameraRelease(framePilot: false)`, `controlsPhase(stow)`, `osd(off)` |
| T21 | landing | `craft.landed` | stowing (`full` if `!forcedLanding && craft.distHomeM ≤ homeToleranceM 1.5`, else `noDrone`) | `state`, [if fpv: `cameraRelease(framePilot: false)`, `controlsPhase(stow)`, `osd(off)` — T20's actions, when `landed` and `distTouchdownM ≤ 5` are first seen in the same tick, e.g. a forced landing that starts on the ground: one transition per tick means T20 never ran], `rotors(0, 0.6)`, `audio(0, 0.6)`, [`fadeOut(drone, 5, 1)` if noDrone], first stow beat entry (humanoid full `tabletDown`; humanoid noDrone `tabletDown`; no-hands full `powerDown`; no-hands noDrone → T26 actions + `settle`) |
| T22 | flying / pilotView / returning / landing / deploying-liftoff (drone `air`) | `crashMps > 0 && craft.impactSpeed > crashMps` | crashed/static | `state`, `autopilot(crash)`, `rotors(0, 0.2)`, `audio(0, 0.3)`, `osd(crash)` if fpv, else `osd(off)` (drops a pilot-view banner), `fadeOut(drone, 5, 1)` (drone → `fading`) |
| T23 | crashed | `beatElapsed ≥ 1.0` | stowing (noDrone) | `state` (first, §4.3); if fpv: `cameraRelease(framePilot: false)`; `controlsPhase(stow)` (always — also after a crash from pilot view); `osd(off)`; humanoid: `tabletDown` entry; no-hands: T26 actions + `settle` |
| T24 | stowing beats | §4.4 | | |
| T25 | stowing (full) | last beat end | idle | the last beat's pending event and end actions first (T4's event → end order), then `state(idle)`, `hideWielded(false)`, `inputRestore` |
| T26 | stowing (noDrone) | `gogglesOff` end (no-hands: entry) | stowing/settle | `hideWielded(false)`, `inputRestore` |
| T27 | stowing/settle, aborting/settle | `craft.gone` | idle | `state(idle)` |
| T28 | aborting | `craft.landed` (first time, drone `air` → `ground`) | (same) | `rotors(0, 0.6)` |
| T29 | stowing/settle, aborting/settle | settle `beatElapsed ≥ settleTimeoutSec` (8; Σdt like every beat clock, so a hidden tab pauses it too: a fade that never started or never finished — e.g. `props.fadeOut` refused, or `fadeOut` and `setRotor` on different clocks) | idle | `state(idle)`, `detach(drone, remove)` (the button never sticks at `busy`) |

Requests not listed for a state are ignored by the sequence (the API answers `not-flying` / `already` / `busy` per
§3.9). `deploy` outside idle is ignored (idempotent); `recall` in returning / landing / stowing is ignored.

### 4.6 Abort table

Signal → reason (first match in this priority order): `sessionChanged → session`, `contextLost → contextLost`,
`portal → portal`, `filmBusy → film`, `pilotMovedM > 2 → pilotMoved`, `death → death`, `damage → damage`,
`stanceCombat → combat`; the request `abort` carries `arg.reason` (`user` default). `hidden` never aborts (the drone
hovers; no frames run). `pilotMovedM`, `stanceCombat`, `damage` and `death` are ignored once `locked` is false (the
player has control again: the abort settle and the noDrone settle).

| From | Soft reason (`damage`, `death`, `combat`, `user`) | Hard reason (`HARD_ABORT_REASONS`) |
|---|---|---|
| idle | ignored | ignored |
| deploying, flying, pilotView, returning, landing, crashed | → **aborting** with SOFT actions | → **idle** with HARD actions |
| stowing (locked) | → idle with HARD actions (the stow is cut short) — or aborting/settle when the drone is `fading` | → idle with HARD actions |
| stowing/settle, aborting | ignored (a second `abort` request upgrades to HARD) | → idle: `state(idle)`, `detach(drone, remove)` |

**SOFT actions** (flags decide each item; order binding): `state(aborting)` — or `state(idle)` when the drone is
`none` / `hand` (nothing left to land) —, `stopClip` (if clipActive), `cameraRelease(framePilot: false)` (if fpv),
`osd(off)`, `inputRestore` (if locked), `motion(Ready, 1)` (if held and reason ∉ {`death`, `combat`}: on `combat` the
server's stance motion has already replaced ReadState, and Ready in NonCombat would re-pose the rig out of step with
it; the watchdog stops anyway, §5 step 14), `detach(tablet, remove)` (if tablet), `detach(goggles, remove)` (if
goggles), `hideWielded(false)` (if hidden), `audio(0, 0.3)`; drone: `hand` → `detach(drone, remove)`; `ground` → `rotors(0, 0.6)`, `fadeOut(drone, 5, 1)`; `air` → `autopilot(landHere)`,
`fadeOut(drone, 5, 1)` (T28 stops the rotors at touchdown; the model keeps `drone: 'air'` until T28 although the fade
was issued); `fading` → nothing. Then aborting/settle until `craft.gone` (T27).

**HARD actions**: `state(idle)`, `stopClip` (if clipActive), `cameraRelease(framePilot: false)` (if fpv), `osd(off)`,
`inputRestore` (if locked), `motion(Ready, 1)` (if held and reason ≠ `death`), `detach(tablet, remove)`,
`detach(goggles, remove)`, `hideWielded(false)` (if hidden), `audio(0, 0)`, `rotors(0, 0)`, `autopilot(null)`,
`detach(drone, remove)` (if drone ≠ `none`).

`lastAbort = {reason, from, at: now}` on every abort. Every action executor is idempotent (§7.4), so a flag the
sequence over-approximates is harmless.

### 4.7 Determinism and API

`createSequence(opts)` merges `SEQUENCE_DEFAULTS`; `tick` is deterministic (same input stream → deep-equal action
streams and states); `state()` returns a fresh JSON-safe copy; `reset()` → idle without actions (dispose only).

---

## 5. Per-frame driver (`index.js`, the `liveScene3d.film.preFrame` listener)

Installed at deploy, removed at idle (no listener while idle). Order (binding):

1. `sticks = debugOverride ?? controls.poll(dt)`; `input.sticksActive` / `input.anyInput` from it. A non-zero
   `sticks.zoom` → `settings.fovDeg = clamp(settings.fovDeg + 5·sticks.zoom, 60, 110)` and, when the value changed,
   `settingsDirty = true` (persisted by step 13, never here).
2. Signals into the reused `signals` object (§6.7): latched edges (bus, debug, context event) + levels; film-busy and
   the rig watch on a 4 Hz accumulator (so a film take starting is seen ≤ 250 ms late, DV-17); the latches are cleared
   after step 4.
3. `gesture = gestures.poll(dt)` → `beatEvent = gesture.event && !gesture.rigChanged`, `beatDone = gesture.done &&
   !gesture.rigChanged` (both refer only to the current job, §3.1; a rig rebuild ends the clip but its beat's event and
   end then come from the beat timer, §6.12); `rigKnown = gestures.profile()?.kind ?? null`; `rig` = `readyKind` (§7.3:
   latched when the `gestures.ready()` promise resolves, null before). The first tick where `gestures.profile()` is
   non-null → `props.setRig({guid, parts: inst.parts, rootScale: inst.root.scale.x, profile})` (`attach` refuses
   without a humanoid profile, so this must happen before the first `attach`, which the prep guarantees).
4. `actions = sequence.tick(tickInput)`; execute in order (§7.4); if an action set `idle`, run the teardown after the
   list and return.
Steps 5–12 run only while the drone is in the world (`props.where('drone') === 'world'`); otherwise only step 10's
`setRotor` (spin 0) and steps 13–14 run.

5. `frame = craft.step({sticks: activeSticks, dt, groundZ: link.groundZ(x, y), fovDeg: settings.fovDeg})` (x, y = the
   previous frame's position), where `activeSticks` = sticks while state is `flying`, deploying/liftoff after the own,
   or returning while cancellable, and a shared all-zero sticks object otherwise (an active autopilot plan ignores
   sticks anyway).
6. `t = tether.clamp(frame.cam.pos, home.pos, groundZ)` (`home = {pos, yaw}`, §7.4; tether takes the `[x, y, z]`
   array); if `t.limited` push the reused tether hit
   `{layer:'tether', kind: t.kind, t: 1, point: t.pos, normal: t.normal}` into the reused `hits` scratch array
   (length reset to 0 each frame).
7. Safety: `groundPlan = frame.autopilot ∈ {'crash', 'land', 'rth'}` (a ground-ending plan). FPV
   (`cameraOwner.owned`) and not a ground plan → the eye moves the craft: `res = link.safety.clamp(prevEye ?? prevPose,
   wantPose, {fovDeg, aspect: link.aspect(), cell: viewerCell (when ≠ 0), cut, ignoreGuid: 0})`; otherwise — third
   person, OR a ground plan even while the camera is owned — `res = link.safetyBody.clamp(prevPose, wantPose, {fovDeg:
   1, aspect, cut})` (R3-1: with the eye's 0.7 m terrain floor in charge, an FPV crash near the ground came to rest and
   a forced landing touched down 0.64 m in the air, on the eye's synthetic `terrain-floor` hit, and stowed floating;
   `rth` is a no-op for a normal RTH — T17 releases ≥ 5 m up — and is needed for R3-3). `wantPose` = a reused `{t, pos,
   q, h, p, r, fov}` holding the tether-clamped position and `frame.cam` orientation. `cut` = `prevPose === null` or
   the cut flag set by `cameraOwn` / `cameraRelease` / `place` / `toWorld` / crash start. Push `res.hits` into `hits`.
8. If `hits.length`: `craft.contact(hits, res.pose.pos)` (its `impactSpeed` feeds the next tick's
   `craft.impactSpeed`; 0 otherwise). `prevPose = res.pose`. The props mesh (step 10) follows `res.pose` too.
9. FPV: the camera pose `eye` = `res.pose`, except on a ground plan, where a second, camera-only eye clamp gives it —
   `eye = link.safety.clamp(prevEye ?? prevPose, res.pose, eyeCtx).pose` (`eyeCtx.cut = cut || prevEye === null`;
   fovDeg / aspect / cell as in step 7) — so the camera stays at or above the eye floor while the craft rests on the
   ground; it never feeds `craft.contact`. `prevEye` (declared `null` in the cycle literal) is set to the eye pose on
   every owned frame and never nulled inside a cycle (a cut still makes the next clamp a teleport), so every eye sweep
   starts from the last eye pose — never inside the body radius or under the eye floor — and neither a plan start nor
   a T16 cancel gets an unswept eye frame. `cameraOwner.write({pos: eye.pos, q: frame.cam.q, h, p, r, fov: settings.fovDeg})` (a reused
   pose object). Cost: one extra clamp per frame, only while owned on a crash / land / rth plan.
10. `props.setDronePose(res.pose.pos, frame.body.q)`; `props.setGround(groundZ)`; `props.setRotor(spin, now)` (`now` =
    the driver's `deps.clock()` seconds, the same clock `fadeOut` was given) with `spin = armLevel · (frame.landed ?
    0.35 : clamp(frame.throttle, 0.35, 2.5))` (`armLevel` ramps linearly toward the `rotors` target over `rampSec`),
    every frame while the drone exists in any placement (`spin = 0` in the hand).
11. 10 Hz: fill the reused `OsdView` `{mode: settings.mode (raw; osd applies `modeLabel`, §3.6), battery (null when
    off), timerSec (Σdt since lift-off), signal: t.signal, distHomeM, aglM: z − (groundZ ?? home.pos[2] − rest),
    speedMps: frame.speed, headingRad: wrapPi(frame.cam.h), homeBearingRad (compass bearing to `home.pos`), banners:
    {rangeLimit: t.kind === 'range',
    lowBattery: battery.warn, returning: state === 'returning', crash: state === 'crashed', acroHint: acro without a
    gamepad during its first 3 s}, reticle: cine ? 'crosshair' : 'horizon'}` → `osd.update(view)`; every frame
    `osd.frame({headingRad, rollRad: frame.body.r, pitchRad: frame.body.p})` and `osd.staticLevel(signal)` (crash:
    0.85).
12. `audio.update({throttle: frame.throttle, speed: frame.speed, level: armLevel, fpv: owned, pos: res.pose.pos})` —
    the hum follows the rotor arm level; an `audio` action only stops it (§7.4).
13. 4 Hz: `gestures.applyWielded()` while hidden; `props.setScreen(...)` while the tablet is attached and the camera is
    not owned, with `homeBearingRad = !inWorld || lastDistHome < 1 ? NaN : Math.atan2(hx, hy)` (R3-5: no confident
    north arrow with `HOME 0 m` at tablet-up / tablet-down; the OSD hides its arrow below 1 m too); `filmBusy(win)`
    poll; the rig watch (§6.12); every 4th tick (1 Hz), when `settingsDirty`, persist `hb.drone.v1` and clear the flag
    (also at teardown).
14. Every frame: `gestures.watch(now)` while index.js's `held` flag (set by the `motion` ReadState executor, cleared
    by Ready) and its `locked` flag (inputLock / inputRestore executors) are both true — so the watchdog stops at every
    abort, including the ones that issue no Ready (`death`, `combat`); in the world: `link.prewarmAround(res.pose.pos)`
    and, while the drone is airborne (not `frame.landed`), `r = tether.drain(dt, frame.throttle)` → the next tick's
    `battery = {level: r.battery, warn: r.warn, rth: r.rth, empty: r.empty}` (copied into the reused object).

`postRender` listener: when the camera is owned and the mode is angle / acro, `link.drawLens({t: frameTime.tsSec,
theta: Σ(throttle·dt), throttle: frame.throttle, fov: settings.fovDeg})`.

**Allocation rules**: steps 1–14 allocate nothing in drone code (reused scratch objects / arrays; no closures, no
`[...]` literals, no string building except the 10 Hz OSD text changes). Exempt, because they are film pieces or
transitions: `createDrone.step` / `.state()` inside the cine craft, `safety.clamp` and its hits, `cameraOwner.write`, the
film hooks plumbing, `world.prewarm`, `sequence.tick` action arrays on transitions, `filmBusy` (4 Hz), the settings
persist (≤ 1 Hz, only when dirty).
**Every per-frame call is in try/catch**; a throw → hard abort `error` (§2.8).

---

## 6. External seams (paste-ready)

### 6.1 `scene3d/entities.js` — `EntityManager.playLocalClip` / `stopLocalClip` (L2, the only lane allowed)

Insert directly after the closing brace of `_clearUnifiedQueue(inst) { … }` and before the comment
`// Door open/close always routes through the Rust authority (playDoorMotion).` (`usesUnifiedDoor() { return true; }`
follows it). Purely additive; uses the module-scope `_motionSequenceClass`, `_finiteOr0`, `EMPTY_F32`, `EMPTY_U32`.

```js
  // ---- Drone Deploy (2026-10-24, `?drone=on`, DEFAULT OFF) -----------------
  // Local-only gesture clips for scene3d/drone/gestures.js. The clip is built in
  // JS from retail Animation (0x03) frames (wasm `fetchAnimation`, the poser's
  // own 7-float, w-first, object-space layout) and goes onto THE playhead the
  // way `_tryUnifiedCycleOneShot`'s tail installs a one-shot: build the Rust
  // MotionSequence, free the previous one-shot, drop the J5 pending tail,
  // install the record. No bake, no MotionTable lookup, nothing on the wire.
  // The record carries no `inPlace`, so `poseRigAt` writes the raw part frames
  // (`desc.posFrames` must be null: an empty array poses NaN). A clearOnDone
  // clip (the default) is never cut by an incoming setMotion and hands back to
  // `_unifiedLoco` when it ends; `holdFinal` latches the last frame until the
  // next setMotion (any command, even a deduped re-issue) cuts it. `localClip`
  // marks the record so `stopLocalClip` never frees a server gesture or a death
  // hold. Additive: only scene3d/drone/ calls these.
  /**
   * Play a JS-built gesture clip on `guid`'s rig. Local-only (nothing is sent).
   * @param {number} guid
   * @param {object} desc gestures.js `buildClip` output: partFrames (Float32Array,
   *   numFrames*partCount*7), partCount, numFrames, framerate, duration,
   *   frameTimes (Float32Array), segmentStarts / segmentCounts (Uint32Array),
   *   posFrames: null
   * @param {{holdFinal?: boolean, speed?: number}} [opts] defaults false / 1
   * @returns {boolean} true when the clip owns the playhead
   */
  playLocalClip(guid, desc, opts = undefined) {
    const inst = this.entityMap.get(guid >>> 0);
    if (!inst || inst._disposed || !desc) return false;
    // CQ-06: a death hold is sticky; no gesture may replace it.
    if (inst._unifiedSeq?.deathHold === true) return false;
    const MS = _motionSequenceClass();
    if (!MS) return false;
    const n = desc.numFrames >>> 0;
    const pc = desc.partCount >>> 0;
    if (!n || !pc || pc !== (inst.parts?.length ?? 0)) return false;
    if (!desc.partFrames || desc.partFrames.length !== n * pc * 7) return false;
    const seq = MS.fromDescriptor(
      n, _finiteOr0(desc.framerate), _finiteOr0(desc.duration),
      desc.frameTimes || EMPTY_F32, desc.segmentStarts || EMPTY_U32, desc.segmentCounts || EMPTY_U32,
      false, // one-shot: latches `done` and clamps the final frame
    );
    if (!seq) return false;
    if (inst._unifiedSeq) { try { inst._unifiedSeq.seq.free(); } catch (_) {} }
    this._clearUnifiedQueue(inst);
    const sp = +(opts?.speed ?? 1);
    inst._unifiedSeq = {
      seq, desc, clearOnDone: opts?.holdFinal !== true, hooks: [], lastHookTime: -1,
      speed: Number.isFinite(sp) && sp > 0 ? sp : 1, localClip: true,
    };
    return true;
  }

  /**
   * Stop the clip `playLocalClip` put on `guid`'s playhead (abort / skip): free
   * it and drop the pending tail; the tick then poses the `_unifiedLoco` cycle.
   * Any other one-shot (a server gesture, a door or a death hold) is left alone.
   * @param {number} guid
   * @returns {boolean} true when a local clip was stopped
   */
  stopLocalClip(guid) {
    const inst = this.entityMap.get(guid >>> 0);
    const ua = inst?._unifiedSeq;
    if (!ua || ua.localClip !== true) return false;
    try { ua.seq.free(); } catch (_) { /* already freed */ }
    inst._unifiedSeq = null;
    this._clearUnifiedQueue(inst);
    return true;
  }
```

Why the order is safe: `_clearUnifiedQueue` frees every queued payload except the one that IS `inst._unifiedSeq`, so
freeing the old playhead first never double-frees a record that is both playhead and queue head. Consequences pinned by
the code (not changed by the seam): a clearOnDone clip is never cut by `setMotion` (`_preemptUnifiedForMotion` returns
on clearOnDone); server gestures and the Ready→ReadState link queue behind it and play after it; it is cut by
`cancelCastSequence` (a fizzle), the death branch, despawn / respawn, and `_tryUnifiedCycleOneShot` (a one-shot
emote whose link is missing). holdFinal clips are cut by ANY `setMotion` (incl. the drone's own watchdog) — the drone
never uses holdFinal. **Nothing calls these but `scene3d/drone/gestures.js`.**

### 6.2 `scene3d/audio/audio_manager.js` — `AudioManager.prototype.getEffectBus` (L3, the only lane allowed)

Insert inside `class AudioManager` directly after `setAmbientGain(value) { … }` and before the JSDoc that starts
`Wave 3 / A4 — per-rAF position update for follow-mode sounds.` Purely additive.

```js
  /**
   * Drone Deploy (2026-10-24) — the effect-category bus, for a caller that
   * synthesises its own continuous sound (scene3d/drone/audio.js, the motor
   * hum) instead of playing a Wave through `play()`.
   *
   * `{ctx, node, sliderGain}` once the AudioContext exists (the first
   * pointerdown / keydown reaches `notifyUserGesture`), else null. This never
   * creates the context — `resume()` from a user gesture does — so a caller
   * that got null asks again later. `node` is `_effectMaster`: whatever
   * connects to it takes the master slider and the focus mute
   * (`_applyFocusMute` on `_master`) exactly as a `category: "effect"` voice
   * does, and in the default HRTF mix the effect slider too. Under
   * `?audioRetailPan=on` the slider is folded into each voice's dB instead and
   * this bus stays at unity (`_busGain`), so `sliderGain()` is the factor the
   * caller multiplies in itself (1 in the HRTF mix); it follows the Options
   * slider, so read it whenever levels are set. The caller owns every node it
   * builds and disconnects them; nothing here tracks them, and they take no
   * slot in the retail voice pool (`voicePool`).
   *
   * @returns {{ctx: AudioContext, node: GainNode, sliderGain: () => number}|null}
   */
  getEffectBus() {
    if (!this._ctx || !this._effectMaster) return null;
    return {
      ctx: this._ctx,
      node: this._effectMaster,
      sliderGain: () => (this._hrtf ? 1.0 : this._effectGainValue),
    };
  }
```

Callers resolve it lazily at use time: `window.liveScene3d?.audioManager?.getEffectBus?.() ?? null` (null before
init3D's audio stamp, under `?wireframe=1` without diag, or before the first gesture → silent). Call once per `start()`,
never per frame (it allocates a closure). If null inside the deploy click: `audioManager.resume()` (async, never rejects;
its synchronous prefix `_initContext()` creates the context inside the gesture) then ask again — index.js does exactly
this in `deploy()` right before `audio.start()` (§7.3). The bus getter handed to audio.js never calls `resume()`: it is
also polled at ≤ 1 Hz from `update()`, outside any gesture, where a new context would start suspended.

### 6.3 World-link construction recipe (L4; built the way `scene3d/film/index.js` builds its components, without the
pilot, take player, recorder, look, sensors, catalogs, night_ramp or the rynth router, and without `?filmMode=on`)

```js
import { FilmError } from "../film/core/errors.js";
import { landblockOfWorld } from "../film/core/units.js";
import { createCameraOwner } from "../film/runtime/camera_owner.js";
import { createLensOverlay } from "../film/runtime/lens_overlay.js";
import { createSafety } from "../film/runtime/safety.js";
import { createWorld } from "../film/runtime/world.js";
import * as LOS from "../film/scene/los.js";
import { createParticlesQuery } from "../film/scene/particles_query.js";
import { createWorldQuery } from "../film/scene/world_query.js";

// inside createWorldLink(deps): d = deps; win = d.window ?? globalThis.window ?? null; THREE = d.THREE ?? null;
// log = d.log; body = d.body ?? {radiusM: 0.18, restHeightM: 0.06}; NO_ROWS = Object.freeze([]);
// nowMs = d.now ?? (() => performance.now()); managers = typeof d.particleManagers === "function" ? d.particleManagers
//   : Array.isArray(d.particleManagers) ? () => d.particleManagers : null   (index.js passes none: the default
//   enumeration finds the world manager and — on index.html, where the drone shares the client's owner_registry.js
//   instance — every owner-registry manager; on index-bundled.html that registry is a separate empty one, §1.4;
//   particle_manager.js is never imported)
const live = d.liveScene3d;                       // REQUIRED → else throw new FilmError("…", "DRONE_NO_SCENE")
const shOf = () => {
  const h = typeof d.getSessionHandle === "function" ? d.getSessionHandle() : null;
  return h ?? live.sessionHandle ?? (win ? win.__sessionHandle : null) ?? null;
};
const wasm = d.wasmExports ?? live.wasmExports ?? null;   // init3D's curated object (no scenery-collider populate;
                                                          // moot: DRONE_PREWARM.collision is false, §10 DV-9)
// camera_owner / safety / world read their handle LAZILY from the deps object they were given, so a getter keeps
// them on the current window.__sessionHandle (liveScene3d.sessionHandle is the init3D-time handle, never re-pointed).
const priorFilm = live.film;                              // film's hooks object when film installed it (init3D), else none
const cameraOwner = createCameraOwner({ liveScene3d: live, THREE, window: win, log, get sessionHandle() { return shOf(); } });
const hooks = cameraOwner.hooks;                          // ensureFilmHooks(live) ran at construction
// R1-04: the owner adopted film's object → dispose() only releases the camera and removes our own listeners (§3.8)
const foreignHooks = priorFilm !== null && typeof priorFilm === "object" && priorFilm === hooks;
const worldQuery = createWorldQuery({                     // pins its handle at construction → link per deploy
  liveScene3d: live, sessionHandle: shOf(), wasmExports: wasm, THREE, log,
  getLocalPlayerGuid: () => (win && typeof win.getLocalPlayerGuid === "function" ? win.getLocalPlayerGuid() : 0),
  ...(managers ? { particles: createParticlesQuery({ liveScene3d: live, THREE, managers }) } : {}),
});
const particles = worldQuery.particles && typeof worldQuery.particles.near === "function" ? worldQuery.particles : null;
let lensAt = -Infinity;                                   // particles.near rebuilds an all-emitter snapshot: ≤ 4 Hz
const lensParticles = particles ? { near(c, r) { const t = nowMs(); if (t - lensAt < DRONE_LENS_QUERY_MS) return NO_ROWS; lensAt = t; return particles.near(c, r); } } : null;
const safety = createSafety({ get sh() { return shOf(); }, worldQuery, los: LOS, particles: lensParticles, liveScene3d: live, log });
const safetyBody = createSafety({ get sh() { return shOf(); }, worldQuery, los: LOS, particles: null, particleLens: false,
  liveScene3d: live, log, minRadius: body.radiusM, terrainClearance: body.restHeightM });
const world = createWorld({ liveScene3d: live, window: win, worldQuery, corridor: worldQuery.corridor, wasmExports: wasm, log,
  get sessionHandle() { return shOf(); } });          // no parkViewerCell: the drone never teleports
let overlay = null;                                       // lazily: createLensOverlay({THREE, renderer: live.renderer, log})
```

Facts this relies on (verified): `createSafety` needs `los` (the namespace with `segmentBlocked`; else FilmError
BAD_ARGUMENT) and reads the handle from `d.sh`; there is no `cut()` / `dispose()` (cut via `ctx.cut`; teardown =
`release()`); the terrain floor applies on every outdoor clamp unless `ctx.terrain === false` (hence the body instance's
low clearance); `exemptLocalPlayer` is hard-coded true (the drone can pass through the pilot). `createWorld`'s API is
only `{teleport, command, ready, checkReady, prewarm, avatar, actor, stats}` (`playerPose` is internal). Prewarm resolves
as soon as every required kind is baked, polling only while something is still missing, until its `timeoutSec` (8 s
here); it then awaits the corridor fetch (and populate, off here) and is not cancellable. Collision populate skips the
player's 3×3 ring, which bounds the drone
(180 m cap < 192 m), so `collision: false`. The lens overlay takes `{THREE, renderer}` and a SHOT overlay
`{props:{style}}` (a flat `{style}` silently answers `on:false`); freestyle = 24 draw calls. Nothing here sends to the
server.

### 6.4 Input lock / restore recipe (L3 `controls.lock()` / `restore()`)

Locked from **deploy start** (T1) to idle or abort — not at the goggle cut (DV-3). Steps, each in its own try/catch
(a failure is recorded in `steps`, the rest still run):

```js
// 1. funnel: ONE untagged fault slot shared with film's clean frame and __diag.input; never a bare poison() ("throw").
const f = deps.funnel ?? win.__inputFunnel;                       // resolved NOW, not at create
const prevFault = typeof f.snapshot === "function" ? (f.snapshot().fault ?? null) : (f._fault ?? null);
if (prevFault !== "throw" && typeof f.releaseHeld === "function") f.releaseHeld("drone");   // synthetic keyups (not Space)
let didPoison = false;
if (prevFault === null && typeof f.poison === "function") { f.poison("gate"); didPoison = true; }
saved.funnel = { ref: f, prevFault, didPoison };
// 2. a held Space charge: releaseHeld skips Space (its release is DoJump) and our blockers eat its keyup.
if (jumpChargePending(win, win.__sessionHandle)) cancelJumpCharge(win, win.__sessionHandle, doc);   // local; sends nothing
// 3. camera input
cs._endFollowDrag?.(); for (const k of Object.keys(cs.keys)) cs.keys[k] = false;
// 4. window CAPTURE listeners (window is first on the capture path, whatever the registration order → they run before
//    the funnel's document-capture handlers and every element / bubble listener; window-capture listeners registered
//    earlier — hover tooltip, the drone HUD popover's outside-press closer (armed at mount, §3.11), an Options rebind
//    capture started BEFORE the deploy — still run first, see "Not covered"):
//    KEY_EVENTS {capture:true} → onKey (drone codes only; typing passes); POINTER_EVENTS {capture:true}, wheel/touch*
//    {capture:true, passive:false} → onPointer (ev.target === canvas, or any target while pointer-locked; dragover is
//    stopImmediatePropagation()ed WITHOUT preventDefault — a prevented dragover means "drop allowed");
//    window blur + document visibilitychange (hidden) → zero held keys and look; document pointerlockchange/-error.
// restore():
if (s.funnel?.didPoison && ((s.funnel.ref.snapshot?.().fault ?? s.funnel.ref._fault) === "gate")) s.funnel.ref.unpoison();
```

The blocker (film clean_frame's): `ev.stopImmediatePropagation()` (fallback `stopPropagation`), then `preventDefault()`
when cancelable. What the lock covers (verified census): the funnel gate kills W/A/S/D/Q/E/Space/Tab/T/C/R/PageUp/Down,
quickslot digits, in-world Esc, combat and emote keys; our capture listeners additionally take KeyM (World Map is a
window-bubble listener outside the funnel), Tab focus moves, Space's button activation, and every canvas pointer /
mouse / wheel / touch / drop event (picking.js Uses on a second canvas `pointerdown` ≤ 500 ms — not on `dblclick`).
Not covered (by design): HUD clicks, chat (text entry), F-key panels, Shift+F11, Esc panel closers; earlier
window-capture listeners (hover-tooltip hide, the Options rebind capture — but only one started before the deploy:
`startCapture()` registers its window-capture keydown when the capture starts, so one started mid-cycle sits behind
`onKey` and cannot take drone keys, which fly the drone; R2-8). Not stopped by the lock, so refused at deploy instead
(§6.7 `moving` / `targeting`): autorun, a server MoveTo / TurnTo, a pending use-target, a jump charge.
Under `?inputFunnelV2=off` the funnel is not installed (`installed === false`): only our capture listeners block.

**Film's clean frame and the gate** (A5, R1-03): film's `clean_frame` `apply()` snapshots the funnel's fault and its
`restore()` puts it back blindly. A take or `__film.clean(true)` that starts mid-cycle snapshots the drone's `'gate'`;
the drone's hard `film` abort (≤ 250 ms) then releases that gate; when the take ends, film restores `'gate'` and nobody
owns it — every funnel key dead until reload. So index.js keeps `let filmGate = null`: the `inputRestore` executor
records the funnel (`d.funnel ?? win.__inputFunnel`) when `filmBusy(win)` was true AND this `controls.restore()`
released our own gate (`steps.funnel.unpoisoned === true` — a `'gate'` set by someone else, e.g. `__diag.input`, is
never touched); `settleFilmGate()` — first in `status()` and in `deploy()` after the state check — returns unless
`filmGate && !C && !filmBusy(win)`, then un-poisons only if the fault still reads `'gate'` and clears `filmGate`. The
plugin's 2 Hz `status()` poll clears a stale gate within 0.5 s of film's restore.

### 6.5 Camera owner usage (L4 index.js + the world_link helpers)

```js
/** Deploy start (inputLock executor): leave orbit / topDown / first person BEFORE any held motion; restored at idle. */
export function prepareFollowCamera(cs) {
  const saved = { ok: false, mode: null, followYaw: null, followPitch: null, followDistance: null, inHead: false };
  if (!cs || typeof cs !== "object") return saved;
  saved.ok = true;
  saved.mode = typeof cs.mode === "string" ? cs.mode : null;
  saved.followYaw = Number.isFinite(cs.followYaw) ? cs.followYaw : null;
  saved.followPitch = Number.isFinite(cs.followPitch) ? cs.followPitch : null;
  saved.followDistance = Number.isFinite(cs.followDistance) ? cs.followDistance : null;
  saved.inHead = cs._inHead === true;
  if (cs.mode !== "follow" && typeof cs.switchMode === "function") { try { cs.switchMode("follow"); } catch (_) {} }
  if (saved.inHead) { cs._inHead = false; cs._prevEyeAc = null; cs._stiffSeeded = false; }
  return saved;
}
/** After the FINAL cameraOwner.release() (inputRestore executor): each own() re-snapshots, so restore our own copy. */
export function restoreFollowCamera(cs, saved) {
  if (!cs || !saved || !saved.ok) return false;
  if (saved.followYaw !== null) cs.followYaw = saved.followYaw;
  if (saved.followPitch !== null) cs.followPitch = saved.followPitch;
  if (saved.followDistance !== null) cs.followDistance = saved.followDistance;
  if (saved.inHead) cs._inHead = true;
  cs._prevEyeAc = null;
  if (saved.mode && cs.mode !== saved.mode && typeof cs.switchMode === "function") {
    // R3-4: orbit entry makes camera.js _dispatchMovement send Ready once (the follow ticks cleared the latch), which
    // would stand a death-held corpse up (CQ-06 lets Ready through). The cycle has already issued Ready (tabletDown,
    // aborts) or withheld it on purpose (death, combat), so the orbit latch is pre-set: no Ready in any case.
    if (saved.mode === "orbit") cs._orbitRigStopped = true;
    try { cs.switchMode(saved.mode); } catch (_) {}
  }
  return true;
}
/** Pilot view (Tab), right after release(): the follow camera in FRONT of the pilot (release() alone puts it behind). */
export function framePilotFront(cs, nowMs) {
  if (!cs || typeof cs.getPlayerHeading !== "function") return false;
  let h = null; try { h = cs.getPlayerHeading(); } catch (_) { h = null; }   // followYaw convention (CW from north)
  if (!Number.isFinite(h)) return false;
  cs.followYaw = h + Math.PI;
  if (Number.isFinite(nowMs)) cs._lastUserYawMs = nowMs;                      // autofollow grace (350 ms)
  cs._prevEyeAc = null;                                                      // snap, no swing through the pilot
  return true;
}
/** Right after own(): while owned camera.js computes no near-fade, so the last pushed opacity would persist. */
export function forcePilotOpaque(cs) {
  if (!cs || typeof cs._applyCameraPlayerFade !== "function") return false;
  try { cs._camFadeLastOpacity = undefined; cs._applyCameraPlayerFade(1); return true; } catch (_) { return false; }
}
```

- `cameraOwn` executor: `try { link.cameraOwner.own() } catch → hard abort 'error'`; `link.forcePilotOpaque()`;
  `props.setVisible('drone', false)` (the FPV eye is the drone; near plane 0.1 m); `link.configureLens(mode)`; set the
  cut flag; `controls` phase is set by its own action. The first `write` after `own()` seeds the viewer cell from the
  player-head walk; while owned every write carries a non-zero outdoor landcell and publishes `liveScene3d.filmViewer`
  (DV-8).
- `cameraRelease` executor: `link.cameraOwner.release()` (restores follow mode, followYaw / followPitch, fov,
  csmFitFov, the avatar fade, `_prevEyeAc = null`, deletes `filmViewer`); if `framePilot` →
  `link.framePilotFront(win.performance.now())` (camera.js compares `_lastUserYawMs` with `performance.now()`);
  `props.setVisible('drone', true)`; `link.configureLens('cine')` (off); set the cut flag.
- Writes happen only in the preFrame driver (step 9), so cells, culling, CSM, the light pool and the audio listener
  read the drone eye in the same frame. Never set `liveScene3d.film.holdLoop`.
- Camera mode toggling is impossible while locked (KeyC = down is taken), so `own()` never switches orbit → follow
  mid-cycle (which would make camera.js dispatch Ready and drop the tablet).

### 6.6 Hotbar launcher mounting and the fallback float (L5; the rynth-hud pattern)

CSS (in `#hb-drone-hud-style`; exact geometry and colours of `.rhud-launcher` plus `order: 10`):

```css
.dhud-launcher { position: relative; width: 30px; height: 30px; padding: 0; order: 10;
  border: 1px solid var(--hbk-gold-dim, #8a7544); background: url("./data/ui-sprites/0x06004CC2.png") repeat, #0b0c10;
  color: var(--hbk-gold, #d9b45a); cursor: pointer; box-shadow: 0 0 0 1px #000, 0 4px 10px rgba(0, 0, 0, 0.6); }
.dhud-launcher:hover, .dhud-launcher:focus-visible { color: var(--hbk-gold-bright, #f3d27a); border-color: var(--hbk-gold, #d9b45a); outline: none; }
.dhud-launcher.is-active { box-shadow: 0 0 0 1px #000, 0 0 7px rgba(243, 210, 122, 0.65); }
.dhud-launcher[aria-disabled="true"] { cursor: default; }
.dhud-launcher[aria-disabled="true"] .dhud-launcher-icon { opacity: 0.45; }
.dhud-launcher-icon { position: absolute; left: 4px; top: 4px; width: 20px; height: 20px; pointer-events: none;
  background: currentColor; -webkit-mask: QUAD_MASK center / 20px 20px no-repeat; mask: QUAD_MASK center / 20px 20px no-repeat; }
.dhud-launcher-dot { position: absolute; right: 2px; bottom: 2px; width: 7px; height: 7px; border-radius: 50%; background: #555; box-shadow: 0 0 0 1px #000; pointer-events: none; }
.dhud-launcher[data-state="busy"] .dhud-launcher-dot { background: #e0b040; }
.dhud-launcher[data-state="flying"] .dhud-launcher-dot { background: #6fe36f; box-shadow: 0 0 0 1px #000, 0 0 5px #6fe36f; }
.dhud-launcher[data-state="refused"] .dhud-launcher-dot { background: #c85040; }
#hb-drone-hud-launcher-float { position: fixed; right: 12px; bottom: 84px; z-index: 55; }
#hb-drone-hud-settings { width: 240px; z-index: 61; }
#hb-drone-hud-settings[data-open="0"] { display: none; }
```

(`QUAD_MASK` = `url("data:image/svg+xml,…")` of a 24×24 quadcopter outline, `encodeURIComponent`-ed.)

Attach (call at mount, on `hb-hotbar-mounted` with `ev.detail.addons`, and from the tick when `!b.isConnected`):

```js
function attachLauncher(hint) {
  const b = S.launcher; if (!b) return;
  // hb-hotbar-mounted fires BEFORE hotbar.js assigns window.__hotbar: on a remount __hotbar.addonSlot() is the
  // removed column. Prefer the event's column, then a connected addonSlot(), then the live DOM.
  let slot = hint && hint.isConnected !== false ? hint : null;
  if (!slot) { try { slot = window.__hotbar?.addonSlot?.() ?? null; } catch { slot = null; } if (slot && slot.isConnected === false) slot = null; }
  if (!slot) slot = document.querySelector?.("#hb-hotbar .hb-hotbar-addons") ?? null;
  if (slot) { document.getElementById("hb-drone-hud-launcher-float")?.remove(); if (b.parentNode !== slot) slot.appendChild(b); b.removeAttribute("title"); return; }
  let float = document.getElementById("hb-drone-hud-launcher-float");
  if (!float) { float = document.createElement("div"); float.id = "hb-drone-hud-launcher-float"; document.body.appendChild(float); }
  if (b.parentNode !== float) float.appendChild(b);
  b.title = `Drone — deploy / recall (${hotkeyLabel() || "Shift+F11"})`;   // no kit tooltip outside #hb-hotbar
}
```

`launcherTick` (500 ms, and on every `hb-drone-state` event): re-attach when disconnected; `data-state` /
`aria-disabled` / `.is-active` per §3.11; and the column flip exactly as rynth-hud (`flip = rect.right + 36·zoom >
innerWidth`, zoom = `currentCSSZoom`) — idempotent with rynth-hud's own tick and needed under `?rynthHud=off`. The
launcher is a `<button>` (exempt from the toolbar drag handle). Neither drone-hud nor rynth-hud is in
`app/plugin_bar.js` `BAR_SLOT_ORDER`, so both mount after the listed slots in the loader's `loaded` order (its
dependency walk over the id-sorted index; nothing depends on either): drone-hud first, so its launcher is appended ahead
of ⚒ in DOM order — and `order: 10` (⚒ has 0) stacks it below ⚒ regardless of DOM order.

### 6.7 Abort and refusal signal sources (exact accessors)

**Deploy refusals — the plugin is the single implementation** (tooltip before the module loads, and
`deps.refusal = () => refusalFor(readDeploySignals(window, S))` for `deploy()`):

```js
export function refusalFor(s) {
  if (!s || s.inWorld !== true) return "not-in-world";
  if (s.portal) return "portal"; if (s.dead) return "dead"; if (s.filmBusy) return "film-busy"; if (s.busy) return "busy";
  if (s.targeting) return "targeting";
  if (s.indoors) return "indoors"; if (s.combat) return "combat"; if (s.moving) return "moving";
  return null;
}
// droneState: the drone state the caller has JUST read (the launcher tick, the tooltip, activate — each one status()
// call, R2-7); omitted (deps.refusal) → read here. Never a cached value: activate() reads a fresh state, and a
// 'stowing' up to 500 ms old would turn an idle click into a false busy.
export function readDeploySignals(win = globalThis.window, cache = S, droneState) {   // never throws
  const w = win || {};
  const read = (fn, dflt) => { try { const v = fn(); return v === undefined || v === null ? dflt : v; } catch { return dflt; } };
  const h = read(() => w.__sessionHandle, null);
  const bs = read(() => w.__bootState, "");
  // 'in-world' and 'ready' share one scalar and arrive in EITHER order (index.html setBootState).
  const inWorld = (bs === "in-world" || bs === "ready") && !!h && !!read(() => w.liveScene3d, null)
    && read(() => (w.getLocalPlayerGuid?.() ?? 0) >>> 0, 0) !== 0 && read(() => w.__hbLoggingOff, false) !== true;
  if (!inWorld) return { inWorld: false };
  const portal = read(() => w.__isPortalSpaceActive?.() === true, false);
  let hp = cache && cache.health ? cache.health : null;
  if (!hp) { const v = read(() => w.__pluginClient?.host?.TryGetPlayerStats?.()?.vitals?.[1], null); if (v) hp = { current: v.current >>> 0, max: v.max >>> 0 }; }
  const dead = !!hp && hp.max > 0 && hp.current === 0;
  const fs = read(() => w.__film?.status?.(), null);
  const filmBusy = !!fs && (fs.active === true || fs.cameraOwned === true || fs.clean === true
    || fs.take?.running != null);                                  // take.running: null | {mode, locked, record, frames, progress}
  const busy = (typeof droneState === "string" ? droneState : read(() => w.__drone?.status?.()?.state, "idle")) !== "idle";
  const targeting = read(() => w.__useTargeting?.pending != null, false); // pending: null | {itemGuid, itemName} (app/hud_panels.js)
  const cell = read(() => h.getCurrentCellId?.() >>> 0, 0);
  const indoors = read(() => h.isCurrentCellIndoor?.() === true, false) || (cell & 0xffff) >= 0x100;
  const low = read(() => (w.__getCurrentStanceLow?.() ?? 0x3d) & 0xffff, 0x3d);
  const combat = low !== 0 && low !== 0x3d;                      // NonCombat 0x8000003D; magic 0x49 counts as combat
  let onGround = true;
  try { const pose = h.getLocalPlayerPose?.(); if (pose) { if (pose.isOnGround === false) onGround = false; try { pose.free?.(); } catch {} } } catch {}
  const moving = !isStandingStill({ onGround, movementKeyHeld: read(() => heldMovementKey(w.__inputFunnel), false),
    autoRun: read(() => w.__autoRunOn === true, false), autonomousMotion: read(() => h.localAutonomousMotion?.() >>> 0, 0) })
    || read(() => jumpPending(w, h), false);                       // __jumpKeydownTs != null || __jumpChargeActive === true
  return { inWorld, portal, dead, filmBusy, busy, targeting, indoors, combat, moving };
}
```

(`jumpPending` is a local 2-line check of `w.__jumpKeydownTs != null || w.__jumpChargeActive === true`; the plugin
imports nothing else for it.) `index.js` adds its own `not-in-world` checks after `deps.refusal()`: `window.liveScene3d`
with `scene`, `renderer`, `cameraSwitcher`, `entityManager`; `live.__webglContextLost !== true` (R1-08: a deploy
during a lost context would lock input and gate the funnel with no frame running until the restore); a non-zero
`getLocalPlayerGuid()`; the pilot instance in `entityMap`; and its own `busy` (state ≠ idle, checked first, or the
previous cycle's teardown still pending). Last, once the world link is built, its **open-sky check** (§3.9, phase 4
F1) → `covered` (`Needs open sky above you`). `covered` is index-only and non-persistent: the plugin cannot know it
before the module loads (no page signal maps to it; `refusalFor` / `readDeploySignals` are unchanged and it is not in
`PERSISTENT_REFUSALS`), so it reaches the launcher only as a click's api refusal — the 2.5 s red flash with
`REFUSAL_TEXT.covered` in the tooltip (§3.11), never `aria-disabled`.

**Abort signals — read by index.js every tick** (allocation-free; edges are latched until consumed):

| Signal | Source (exact) |
|---|---|
| `damage` | edge: the name `'damage'` delivered to the listener index.js registered with `deps.onSignal(fn)` (the plugin bus, below), or `debug.trigger('damage')` |
| `death` | edge: `'death'` delivered to that `deps.onSignal` listener, OR level `em.isDeathHeld(guid) === true` |
| `portal` | edge: `'portal'` delivered to that `deps.onSignal` listener, OR level `win.__isPortalSpaceActive?.() === true` |
| `stanceCombat` | `const low = (win.__getCurrentStanceLow?.() ?? 0x3d) & 0xffff; low !== 0 && low !== 0x3d` (server-confirmed stance; there is no stance event) |
| `pilotMovedM` | 3-D distance of `inst.root.position` (AC world) from the deploy anchor (the last known position while the rig is rebuilding) |
| `sessionChanged` | `sessionChanged(win, mark)` below, also run synchronously on window `holtburger:state` and `pagehide` |
| `filmBusy` | `filmBusy(win)` at 4 Hz (≤ 250 ms latency; `status()` allocates): `const s = win.__film?.status?.(); return !!s && s.ok !== false && (s.active === true \|\| s.cameraOwned === true \|\| s.clean === true \|\| s.take?.running != null)` (`take.running` is null or an object; film never refuses a foreign camera owner and shares the funnel slot, so the drone enforces the exclusion) |
| `contextLost` | the canvas `webglcontextlost` event aborts synchronously (§6.13); level `live.__webglContextLost === true` |
| `hidden` | `doc.visibilityState === "hidden"` (never aborts) |

```js
const RAW_SESSION = Symbol.for("holtburger.rawSessionHandle");   // plugins/rejection_feedback.js Proxy-wraps the handle
export function sessionKey(h) {                                  // ~100 ms after login and after each reconnect; unwrap
  let cur = h ?? null;
  for (let i = 0; i < 4 && cur != null; i++) { let inner; try { inner = cur[RAW_SESSION]; } catch { break; } if (inner == null || inner === cur) break; cur = inner; }
  return cur;
}
export function sessionMark(win) {
  const d = win.__lastDisconnect;
  return { key: sessionKey(win.__sessionHandle), guid: (win.getLocalPlayerGuid?.() ?? 0) >>> 0, discTs: d && Number.isFinite(d.ts) ? d.ts : 0 };
}
export function sessionChanged(win, mark) {
  const h = win.__sessionHandle;
  if (!h || sessionKey(h) !== mark.key) return true;                         // pagehide nulls it; a reconnect replaces it
  if (((win.getLocalPlayerGuid?.() ?? 0) >>> 0) !== mark.guid) return true;
  if (win.__hbLoggingOff === true || win.__hbLoggedOff === true) return true; // /logout (the page reloads after)
  const d = win.__lastDisconnect;
  if (d && Number.isFinite(d.ts) && d.ts !== mark.discTs) return true;        // kind-4 disconnect, wasm panic
  const s = win.__bootState;
  return s !== "in-world" && s !== "ready";
}
/** The local pilot's rig pose, allocation-free: AC world + compass heading. A preFrame read is the previous frame's pose. */
export function readPilot(live, win, out) {
  const g = typeof win.getLocalPlayerGuid === "function" ? win.getLocalPlayerGuid() : null;
  if (g === null || g === undefined) return null;
  const inst = live?.entityManager?.entityMap?.get(g >>> 0) ?? null;
  const root = inst ? inst.root : null;
  if (!root) return null;
  const p = root.position, q = root.quaternion;
  out.x = p.x; out.y = p.y; out.z = p.z;
  out.compass = -Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z));   // root yaw is CCW
  return inst;
}
```

**Bus edges — the plugin owns the subscription** (A7): `mount()` runs with `ctx.client === null`; bind late with
`const client = ctx?.client ?? window.__pluginClient ?? null; if (client?.events?.on) subscribe(client); else
window.__pluginClientReady?.then?.((c) => subscribe(c ?? window.__pluginClient));`. Handlers receive a
`CustomEvent`; the payload is `ev.detail`; `events.on` returns nothing (keep the handler refs for `events.off`).
Subscriptions ("emit" = `emitSignal`, below): `vitalChangedHealth` (`{current, buffedMax, oldValue}`; cache `S.health = {current >>> 0, max: buffedMax >>> 0}`;
emit `damage` when `oldValue != null && current < oldValue && buffedMax >= previous max` — with no previous max on
record the max counts as unchanged, so the first drop seen is damage —, and `death` when `buffedMax > 0 && current ===
0`; a non-numeric payload is ignored), `damageTaken` (emit `damage`), `death` (`{victimGuid, killerGuid, message}`, broadcast for every
kill: emit only when `victimGuid >>> 0 === getLocalPlayerGuid() >>> 0`), `portalSpaceEntered` (`{teleportSeq}`; emit
`portal`), `landblockChanged` (emit `landblock`; unused by v1). Forwarding: `deps.onSignal(fn) → unsubscribe`, `fn(name,
detail)` — the PLUGIN calls index.js's listener, never the reverse. Exact wiring (plugin side, `S.sinks` a `Set` in the
plugin's module state; one deps object per page, passed to every `installDrone` call):

```js
const droneDeps = Object.freeze({                 // frozen; index.js never writes to deps
  refusal: () => refusalFor(readDeploySignals(window, S)),   // no state passed: readDeploySignals reads status() itself
  onSignal: (fn) => { if (typeof fn !== "function") return () => {}; S.sinks.add(fn); return () => { S.sinks.delete(fn); }; },
  broadcastPose: () => broadcastReadEmote(window),
});
function emitSignal(name, detail) { for (const fn of [...S.sinks]) { try { fn(name, detail); } catch {} } }
// index.js (deploy): offSignal = deps.onSignal?.((name) => { if (name === "damage" || name === "death" || name === "portal") latched[name] = true; }) ?? null;
// teardown: offSignal?.()
```

Without `deps.onSignal` index.js runs levels only (`status().flags.signals = 'levels-only'`; damage then goes
undetected).

### 6.8 Shift+F11 dispatch seam and the loader-count bump (L5)

A manifest hotkey reaches a plugin only through `app/plugin_bar.js` `PLUGIN_HOTKEY_DISPATCH[pluginId]()`; without an
entry the bridge calls `window.__mainPanel.toggleView("drone-hud")`, which only warns. Insert in `const
PLUGIN_HOTKEY_DISPATCH = {` directly after `"rynth-hud": () => window.__toggleRynthHud?.(),`:

```js
    // Drone Deploy (Shift+F11) — the toolbar launcher's action by drone state
    // (plugins/drone-hud.js installs window.__toggleDroneHud). Not a
    // main-panel view: the generic rule would call toggleView("drone-hud").
    "drone-hud": () => window.__toggleDroneHud?.(),
```

The bridge is a window-bubble keydown outside the funnel (so it works while the drone holds the gate), skips
Ctrl/Meta/Alt chords and text inputs, `preventDefault`s, ignores repeats. controls.js never takes F-keys, so Shift+F11
always reaches it (one handler, one action — `api.button()`), whatever the state.

`tests/plugin_loader.test.cjs` pins the manifest count in three asserts plus names / comments: replace `50` with `51` at
the header comment (`all 50 bundled manifests`), the `[H]` section comment, the check name (append
`, drone-hud added 2026-10-24` to its history), `j.plugins.length` / its message, `manifestFiles.length` (name + assert),
and the dependency-graph check name + `started.length` / its message. `tests/keymap_manifest.test.cjs` needs no edit
(it checks a subset; Shift+F11 parses).

### 6.9 The `/read` broadcast path (L5 implements, index.js calls)

```js
export function broadcastReadEmote(win = globalThis.window) {
  const handle = win?.__sessionHandle ?? null;
  const route = win?.__routeSlashCommand;
  if (!handle || typeof route !== "function") return { ok: false, error: "Enter the world first." };
  if (typeof handle.resolveSoulEmote !== "function") return { ok: false, error: "Emotes need a newer client build." };
  let probe = null; try { probe = handle.resolveSoulEmote("read"); } catch { probe = null; }
  const known = !!probe; try { probe?.free?.(); } catch {}
  if (!known) return { ok: false, error: "/read is not available yet." };   // an UNKNOWN token would go out as "@read"
  let r = null; try { r = route(handle, "/read"); } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
  if (r?.error) return { ok: false, error: r.error };
  if (!r?.dispatched) return { ok: false, error: "/read is not available." };
  if (r.echo) { try { win.__appendChatLine?.(r.echo, 4); } catch {} }      // CHAT_CATEGORY.EMOTE; the chat form prints it
  return { ok: true, echo: r.echo ?? null };
}
```

Passed as `deps.broadcastPose = () => broadcastReadEmote(window)`. index.js executes the `broadcastPose` action only
when `settings.broadcastPose === true` (then 0x01E1 SoulEmote + one MoveToState go out — the only outbound traffic the
drone can cause). The route's local prediction also calls `setMotion(ReadState)`; the drone's own `hold(ReadState)` is a
dedupe no-op on top. Nothing is sent at the stow: other players keep seeing the reading pose until the pilot's next
movement (accepted, documented).

### 6.10 Wielded-item hide (L2 `gestures.createWieldedHider`, exact)

```js
export function createWieldedHider(entityManager, guid) {
  const mine = new Set();
  return {
    apply() {                                   // deploy start, then 4 Hz (a newly wielded guid gets hidden too)
      const kids = entityManager?.entityMap?.get(guid >>> 0)?._attachedChildren;   // null until the first attach
      if (!kids || kids.size === 0) return mine.size;
      for (const c of kids) {
        const g = c >>> 0;
        if (mine.has(g)) continue;
        if (entityManager._filmHiddenGuids?.has(g)) continue;   // someone else's (film's) hide: not ours to restore
        entityManager.setFilmHidden(g, true);
        mine.add(g);
      }
      return mine.size;
    },
    restore() {                                 // EVERY exit path: stow end, abort, session change, dispose
      let n = 0;
      for (const g of mine) { try { entityManager.setFilmHidden(g, false); n += 1; } catch (_) {} }
      mine.clear();                             // setFilmHidden remembers absent guids; un-hiding them forgets them
      return n;
    },
    hidden() { return [...mine]; },
  };
}
```

Never `clearAllFilmHidden()` (film's own hides). Hidden items' pool lights and particles keep drawing (setFilmHidden
docs) — an eye-test note.

### 6.11 Attach rules (L2 `props.attach`)

```js
function noRaycast() {}
function stampRigProp(root, pilotGuid) {
  root.userData.__attachedChildOf = pilotGuid >>> 0;   // _isAttachedChildNode: survives part-content swaps; rig dispose prunes here
  root.traverse((o) => { o.layers.set(1); o.castShadow = false; o.receiveShadow = false; if (o.isMesh) o.raycast = noRaycast; });
  return root;
}
```

- Parent to `inst.parts[profile[anchor]]` (part groups are direct children of `inst.root`); never set `__disposable`;
  the drone module disposes its own resources. Rig dispose / despawn / `clearWorldEntities()` (a kind-4 disconnect)
  detach props with the old part groups without disposing them.
- Layer 1 on every node (the entities INDOOR-LAYER INVARIANT; `_stampEntityIndoorLayer` re-stamps after hot-swaps,
  which is consistent). picking.js raycasts rig roots recursively, hence the no-op raycast. FCULL may hide the rig root
  and the props with it (fine). The follow-camera near-fade and selection flash read only DAT `surfaceDid` meshes, so
  props never fade (a first-person / clipped pilot can show floating props — mitigated by `prepareFollowCamera` and
  `forcePilotOpaque`).
- `toWorld`: `droneGroup.attach(root)` (three computes both world matrices with `updateWorldMatrix`, unaffected by
  `skipHiddenMatrix` / `freezeWorldRoots`), delete `__attachedChildOf`, snap (§3.2). The drop z (`dropZ`, every drop
  path: `detach world` and `place`, §7.4; also the open-sky columns' base, §3.9): index.js computes `gz =
  link.groundZ(x, y)` at the drop spot's world xy and first decides whether the pilot stands on the terrain, `gp =
  link.groundZ(pilot.x, pilot.y)`: when `gp !== null && |gp − pilot.z| <= 0.25`, `dropZ = gz` whenever `gz !== null`
  (the drop follows the terrain at the drop spot whatever the slope — phase 4 F2: 1.5 m ahead on a ~30° slope is
  ≈ 0.8 m off the feet and the no-hands drone floated); otherwise the DV-22 rule, `dropZ = (gz !== null && |gz −
  pilot.z| <= 0.5) ? gz : pilot.z` (groundZ is terrain-only: a pilot on a floor or platform keeps the drone at foot
  level). Unknown terrain at the drop spot → `pilot.z`. Before that, the hand must have reached the ground (§7.4
  `detach world`, R3-2); otherwise the drone is `place`d.

### 6.12 Rig rebuild watch (index.js, 4 Hz)

`cur = em.entityMap.get(guid)`:
- `cur === inst` → nothing.
- `cur` undefined and `em.spawnInFlight?.has(guid)` → rebuilding (a hot-swap fallback or a same-guid CreateObject):
  wait up to 3 s (setMotion calls in the gap are stashed and replayed by entities.js).
- `cur` undefined and not in flight for ≥ 1 s, or rebuilding for > 3 s → hard abort `rigLost`.
- `cur` defined and `!== inst` (a NEW instance) → `inst = cur`; `props.setRig({guid, parts: cur.parts, rootScale:
  cur.root.scale.x, profile})`; `gestures.rebind(cur)`; if held AND locked → `gestures.hold(READ_STATE)` (the step 14
  watchdog's gate: a soft combat / death abort issues no Ready, so `held` stays true through the settle, and a rebuild
  there must not re-pose the rig in ReadState — R1-07, DV-13); if wielded hidden →
  `gestures.applyWielded()`; a running clip ends (`rigChanged`) and its beat continues on time. The default ObjDesc
  path (`?clothingHotSwap`) keeps the same instance, part groups, playhead and tagged props — identity does not change.

### 6.13 Context loss, session events, page teardown (index.js)

```js
export function watchContextLoss(canvas, onLost, onRestored) {
  if (!canvas || typeof canvas.addEventListener !== "function") return () => {};
  const lost = () => { try { onLost(); } catch (_) {} };            // the recovery module already preventDefault()s
  const restored = () => { try { onRestored?.(); } catch (_) {} };
  canvas.addEventListener("webglcontextlost", lost, false);
  canvas.addEventListener("webglcontextrestored", restored, false);
  return () => { try { canvas.removeEventListener("webglcontextlost", lost, false); } catch (_) {}
    try { canvas.removeEventListener("webglcontextrestored", restored, false); } catch (_) {} };
}
```

At deploy: `watchContextLoss(live.renderer.domElement, () => request('abort', {reason: 'contextLost'}))` (the render loop
is paused on loss, so a per-frame check would only fire after the restore); window `holtburger:state` → run
`sessionChanged` now; window `pagehide` → hard abort `session`. All removed at idle.

---

## 7. `index.js` wiring

### 7.1 `installDrone(deps)` — dependency injection

```
deps = {
  window, document,                 // default globalThis.window / document
  liveScene3d,                      // optional; default window.liveScene3d read at deploy (null before init3D)
  THREE,                            // default await import("three") (the import-map instance; node_modules in tests)
  getSessionHandle,                 // default () => window.__sessionHandle ?? null
  funnel,                           // optional; controls resolve window.__inputFunnel at lock time
  refusal,                          // () => code|null (plugin §6.7); optional
  onSignal,                         // (fn) => unsubscribe (plugin bus edges); optional
  broadcastPose,                    // () => {ok, …} (plugin §6.9); optional
  clock,                            // () => seconds; default performance.now() / 1000
  search,                           // URL search for flags; default window.location.search
  storage,                          // default window.localStorage (try/catch)
  fetchJson,                        // (url) => Promise<object|null>; default fetch + json, any failure → null
  log,                              // (entry) => void
  modules,                          // optional factory overrides (§7.2)
}
```

`installDrone` is async (it loads THREE, the default modules and the tuned profiles) and idempotent: a concurrent or
later call returns a promise that resolves to the same instance (`export async function`: a new promise per call over
one memoised inner promise, which a rejection clears; the deps of later calls are ignored). It sets `window.__drone`
and resolves to the api. It needs no scene: settings and tune work before any deploy. `_resetDroneForTest()` disposes and
clears the singleton.

### 7.2 `deps.modules` overrides and lazy loading

| Key | Default (dynamic `import(new URL(path, import.meta.url).href)`) |
|---|---|
| `createSequence` | `./sequence.js` `createSequence` |
| `createGestureDriver` | `./gestures.js` `createGestureDriver` |
| `createProps`, `prewarmProps` | `./props.js` `createProps`, `prewarm` (also `DEFAULT_ANCHORS`, `DRONE_BODY` read from the module when not overridden; overrides: `modules.DEFAULT_ANCHORS`, `modules.DRONE_BODY`) |
| `createManualCraft` | `./manual_flight.js` `createManualCraft` |
| `createTether` | `./tether.js` `createTether` |
| `createControls` | `./controls.js` `createControls` |
| `createOsd` | `./osd.js` `createOsd` |
| `createDroneAudio` | `./audio.js` `createDroneAudio` |
| `createWorldLink` | `./world_link.js` `createWorldLink` |

Only keys absent from `deps.modules` are imported (all in parallel at install): `./props.js` is imported only when
at least one of `createProps`, `prewarmProps`, `DEFAULT_ANCHORS`, `DRONE_BODY` is absent, and likewise per file. A
failed default import rejects `installDrone` (the plugin's memo then retries on the next click). index.js has no
static import of a sibling module and takes no constant from one: it defines its own `READ_STATE = 0x43000146`,
`READY = 0x41000003`, `LIFTOFF = {riseM: 1.7, backM: 3.4, durationSec: 2.2}`, `DROP_AHEAD_M = {humanoid: 0.72,
noHands: 1.5}` (equal to the gestures / sequence values by contract), so it loads and its tests run with every
sibling faked.

### 7.3 Building a cycle (`deploy()`), lifetime

`deploy()` (sync): refusals → `mark = sessionMark(win)`; `anchor` = `readPilot` position; `profile` source anchors =
`mergeAnchors(DEFAULT_ANCHORS, rigProfiles[setupHex], tuneLocal[setupHex])`; then create, in order (any throw → teardown
+ `{ok:false, code:'internal'}`): `link = createWorldLink({liveScene3d, THREE, window, getSessionHandle, wasmExports:
live.wasmExports, body: DRONE_BODY, log})`; the open-sky check (§3.9, phase 4 F1: a roof → that same teardown, of a
cycle that holds only the link, + `{ok:false, code:'covered'}`; nothing below is created); `props = createProps({THREE, scene: live.scene, anchors, log})` +
`props.setRig({guid, parts: inst.parts, rootScale: inst.root.scale.x, profile: null})` (the profile follows on the
first tick it is known, §5 step 3); `prewarmProps({THREE, renderer: live.renderer, scene: live.scene, camera:
live.camera, offscreen: !live.wireframeMode})` (memoised; not awaited); `gestures = createGestureDriver({entityManager:
em, wasm: live.wasmExports, guid, clipMode: () => anchors.clipMode ?? 'clip', log})` + `readyKind = null; const g =
gestures; g.ready().then((r) => { if (gestures === g) readyKind = r?.profile?.kind ?? 'no-hands'; })` (not awaited;
the guard drops a late answer from a torn-down cycle; `readyKind` is `tickInput.rig`, `profile()?.kind` is `rigKnown`,
§5 step 3); `craft = createManualCraft({mode: settings.mode, rates})`; `tether = createTether({rangeM, ceilingAglM,
batterySec: batteryMin·60})`; `controls = createControls({window, document, navigator, canvas: cs.domElement, funnel:
deps.funnel, cameraSwitcher: cs, settings: () => settings})` (`funnel` undefined → controls resolve
`window.__inputFunnel` at lock time) + `controls.onAction(onControlAction)`; `osd = createOsd({document, window})`;
`audio = createDroneAudio({bus: () => live.audioManager?.getEffectBus?.() ?? null, enabled: flags.audio, volume: () =>
settings.volume})`, then — inside the click — the resume fallback `const am = live.audioManager; if (flags.audio && am
&& !am.getEffectBus?.() && typeof am.resume === "function") { try { am.resume()?.catch?.(() => {}); } catch (_) {} }`
and `audio.start()`; `seq = createSequence()`; the preFrame / postRender listeners via `link.onPreFrame` /
`link.onPostRender`; context-loss / session / pagehide listeners; the `deps.onSignal` subscription (§6.7); then
`request('deploy', {quick})`.

**Teardown** (on the `state(idle)` action, after the action list; idempotent): unsubscribe signals and DOM listeners,
`controls.dispose()` (restores if still locked; a running restore drain survives it, §3.5 — R1-01), `gestures.dispose()`,
`osd.dispose()`, `audio.dispose()`, `props.dispose()`, `link.dispose()` (removes our hook listeners, releases the
camera, deletes `liveScene3d.film` only when the link created it — §3.8, R1-04), persist dirty settings, drop craft /
tether / sequence references. No event of its own: the `state(idle)` executor already dispatched this transition's one
`hb-drone-state` event (§7.4). Afterwards: no drone listener on window / document / canvas — except a running
restore drain's ≤ 3 self-removing window listeners (capture keydown / keyup, bubble blur), gone on that key's
release, a fresh press or a blur —, no hook listener, the camera released, the funnel gate as it was before deploy.

Re-entrancy (phase 1): `process()` stops executing an action list as soon as the cycle is dead (a `dispose()` from an
`hb-drone-state` listener mid-list), and `deploy()` answers `busy` while a cycle object still exists (a deploy from
inside the `idle` event, before its teardown ran). A throwing `sequence.tick` (the emergency path) calls
`gestures.release()` (death-aware Ready) when held, then tears down.

`onControlAction({type})`: `pilotView` → `pilotView()`; `mode` → cycle cine → angle → acro → cine (`setMode`);
`hideHud` → `clean = osd.clean(!clean) === true`; `returnHome` / `recall` → `recall()`.

### 7.4 Action executors (idempotent; called in order)

| Action | Executor |
|---|---|
| `state` | record; `log({event: "drone", level: "info", message: "state", state, prev, at})` (the §2.8 ring that `debug.events()` serves — the 1070 smoke reads the state sequence from it); dispatch exactly ONE `new CustomEvent("hb-drone-state", {bubbles: false, detail: {state, prev, at}})` on `document` per transition (try/catch; the plugin listens on `document`, §3.11); `idle` → teardown after the list (no second event) |
| `inputLock` | `controls.lock()`; `camPrep = link.prepareFollowCamera()`; `locked = true` (§5 step 14) |
| `inputRestore` | if the camera is still owned → `cameraRelease` first; `const busyFilm = filmBusy(win); const rr = controls.restore();` `if (busyFilm && rr?.steps?.funnel?.unpoisoned === true) filmGate = d.funnel ?? win?.__inputFunnel ?? null;` (§6.4, R1-03); `if (clean) clean = osd.clean(false) === true;` right after the restore (R1-06: H's hidden HUD and cursor end when control comes back — every abort, T25, T26; H itself no longer reaches the drone then); `link.restoreFollowCamera(camPrep)`; `locked = false` |
| `controlsPhase` | `controls.setPhase(phase)` |
| `hideWielded` | `gestures.hideWielded(on)` |
| `clip` | `gestures.clip(name, speed)` |
| `stopClip` | `gestures.stop()` |
| `motion` | `ReadState` → `gestures.hold(READ_STATE, 1)`, `held = true`; `Ready` → `gestures.release()` (death-aware), `held = false` (§5 step 14) |
| `attach` | `props.attach(prop, anchor)` (no rig / no-hands → no-op) |
| `detach` `world` | drone in the hand → `p = props.worldPos('drone', out)`; **if the hand is not at the ground** — `if (!fin(pz) \|\| pz − pilot.z > 0.3 \|\| hypot(px − pilot.x, py − pilot.y) < 0.4)` against the pilot's FEET z (not `dropZ`, which follows the slope): a timer-mode place (no rig motion: `clipMode 'timer'`, an unbuilt or refused clip, a rig rebuilt during the beat), a cut clip, a standing hand — → `place` (0.72 m ahead on the pilot compass; R3-2: the hip drop was 0.31 m out at 71° right, so the lift-off went sideways); else `dropZ` at the hand's xy (§6.11; a pilot on the terrain → the terrain there whatever the slope, F2) → `props.toWorld('drone', dropZ, yaw)` (a refusal → `place`). The fixture place anim passes on source frames 13–21 (event frame 18: 0.10 m up, 0.72 m out) and fails on 0–12 (standing: 0.80 m, 0.27 m); a rig scale up to ≈ 1.5 stays inside. Not in the hand → `place` |
| `detach` `remove` | `props.remove(prop)` |
| `place` | drop spot = pilot position + `(sin c, cos c)·(0.72 humanoid \| 1.5 no-hands)`, z = `dropZ + DRONE_BODY.restHeightM` (`dropZ` at the drop spot, §6.11: the terrain there for a pilot on the terrain, whatever the slope — F2; the feet on a platform — DV-22); `props.place('drone', pos, yaw)` |
| (after `toWorld` / `place`) | `home = {pos, yaw}`; `craft.reset({pos, h: yaw, p: 0}, {landed: true})`; cut flag |
| `fadeOut` | `props.fadeOut('drone', {delaySec, durationSec, now})` |
| `cameraOwn` / `cameraRelease` | §6.5 |
| `autopilot` | build and install the plan: `liftoff` → `{kind:'liftoff', from: home.pos, to: home.pos + away·LIFTOFF.backM + [0, 0, LIFTOFF.riseM], durationSec: LIFTOFF.durationSec/speed, heading: home.yaw, lookAt: launchFacing 'pilot' ? [pilot.x, pilot.y, pilot.z + 1.2] : null}` with `away` = unit horizontal (home − pilot) (degenerate — below 0.1 m horizontal → `(sin c, cos c)`); `rth` → `{kind:'rth', path: tether.planReturn(frame.pos, home.pos, {cruiseAglM: 15, groundZFrom: link.groundZ(frame xy), groundZHome: link.groundZ(home xy)}), yaw: home.yaw}` (R4-03: it lands facing the way it was set down, §3.3); `hold` → `{kind:'hold'}`; `landHere` → `{kind:'land', at: [x, y, (link.groundZ(x, y) ?? home.pos[2] − rest) + rest]}`; `crash` → `{kind:'crash'}`; `null` → `craft.autopilot(null)` |
| `rotors` | arm-level target + ramp (§5 step 10) |
| `osd` | `osd.show(mode, {durationSec})`; the first `fpv` of a page load with storage `hb.drone.seen.v1` unset → `osd.cheatSheet(true)` and set the key |
| `audio` | `level 0` → `audio.stop({fadeSec: rampSec})`; `level 1` → nothing (the graph has run at gain 0 since `deploy()` and the hum's level is the rotor `armLevel`, §5 step 12; every `audio(1, r)` is paired with `rotors(1, r)`, and the abort cases that stop the hum while the rotors still spin go through `level 0`) |
| `broadcastPose` | `settings.broadcastPose === true` → `deps.broadcastPose?.()` |

Drone yaw at the drop: `launchFacing 'pilot'` → `pilotCompass + π`; `'away'` → `pilotCompass`.

### 7.5 Idle prewarm (plugin side, D-g) and lazy loading

- **First use** loads `scene3d/drone/index.js`: the launcher click, Shift+F11, the settings popover, or
  `window.__droneHud.load()` (the 1070 smoke's hook: installs `window.__drone` without deploying).
- **Exactly one idle prewarm per page**: armed at mount; fires when `window.__sceneReadyEverFired === true` (latched by
  `setBootState("ready")`; checked at mount and on window `holtburger:state` with `detail.state === "ready"`), then
  `requestIdleCallback(run, {timeout: 5000})` (fallback `setTimeout(run, 2000)`); `run` = `Promise.all([import("three"),
  import(new URL("scene3d/drone/props.js", location.href).href)])` → `m.prewarm({THREE, renderer: live.renderer, scene:
  live.scene, camera: live.camera, offscreen: !live.wireframeMode})`; failures swallowed (one `[drone]` warn). The
  deploy path calls the same memoised `prewarm` (a no-op when it already ran). Nothing else loads before use.

### 7.6 Tuned profiles and persistence

- At install: `rigProfiles = (await fetchJson(new URL("../../data/drone-rig-profiles.json", import.meta.url).href))
  ?.profiles ?? {}` (L4 ships the file EMPTY in phase 1 — `{"version": 1, "profiles": {}}` + newline — because a
  missing file is a 404 that Chrome logs as a console error on every install, failing the phase-2 smoke and E7; phase 4
  only fills it; unreadable / invalid → `{}`); `tuneLocal = storage hb.drone.tune.v1 .profiles ?? {}`.
- `TuneProfile = {tablet?: {pos?, quat?}, goggles?: {pos?, quat?, scale?}, droneInHand?: {pos?, quat?}, clipMode?:
  'clip'|'timer'}`; `mergeAnchors(defaults, profile, local)` merges per anchor, per field (`local` wins over `profile`
  wins over `defaults`); `source` reports the highest layer that contributed.
- `data/drone-rig-profiles.json` format: `{"version": 1, "profiles": {"0x02000001": TuneProfile, …}}` (keys as in
  `recon/anims.json`: `"0x" + 8 UPPERCASE hex`).
- Settings: load `hb.drone.v1` at install (validated per key); `setSettings` validates the whole patch first, then
  writes the full settings object back.

---

## 8. Test plan

### 8.1 Conventions (PLAN §9.1, binding for every suite)

- File `tests/drone_<topic>.test.mjs`; `import assert from "node:assert/strict"`; a local `check(name, fn)` (async
  allowed) printing `[PASS] name` / `[FAIL] name` + the first error line; a final summary `drone_<topic>: N passed, M
  failed`; `process.exit(1)` on any failure. Header comment: WHY, the flag (`?drone=on`, DEFAULT OFF), `Run from
  apps/holtburger-web/: node tests/drone_<topic>.test.mjs`. Each suite < 30 s, no SKIP banners, no network, no browser.
- Tests import and EXECUTE the real module under test (no source-text pinning except the I-27 static-import check in
  drone_hud); fakes only for its dependencies. three: real three from node_modules via `import * as THREE from "three"` /
  `await import("three")` (r184), as the film tests do; the `_three_stub_loader.mjs` (`node --loader`) path is not
  needed by any drone suite.
- Fixtures: `fixtures/drone/anims.json` (`{source, layout, anims: {"0x030003B7": {name, numFrames, numParts, hooks,
  frames}}}`; frames are JSON numbers → `Float32Array.from`) and `fixtures/drone/rig-table.json` (`{source, rigs: 26
  rows, humanSetup0x02000001}`; rows carry `parts, rightHandPart, leftHandPart, headPart, profile` but NO holding
  locations: synthesize `new Map([[1, {partId: row.rightHandPart}], [2, {partId: row.leftHandPart}]])` minus nulls).
  Loaded with `readFileSync(new URL("../fixtures/drone/<file>", import.meta.url))`.

### 8.2 Suites and what they pin

| Suite (lane) | Pins |
|---|---|
| `drone_flight` (L1) | cine holds within 0.1 m at zero sticks (10 s); full stick settles within [0.98, 1.02]·12 m/s (boost [0.98, 1.02]·20; vertical `\|vz\|` within [0.98, 1.02]·4), checked at dt 1/60 AND 1/30 (the one-step lead is frame-rate independent; a 0.5 s carrot fails the upper bound, a zero lead the lower one at 30 Hz); after release from 12 m/s the travel ≤ v²/(2·4) + v·4/(2·8) + 1 m and `\|v\| < 0.05` within 6 s; yaw: the cine heading command ≤ 90 °/s, camera output ≤ 120 °/s (preset cap), angle ≤ 200 °/s, acro full stick = `betaflightRateDeg` (666.67 °/s ± 0.5); no wind-up: 3 s full stick into a contact wall (contact every frame) then release → the craft never penetrates and ends < 0.5 m from the wall point; angle levels from 35° to < 1° within 0.5 s and auto-throttle holds altitude ± 0.2 m; acro zero sticks = 1 g ± 1e-6 and `\|vz\| < 0.05` after 2 s; terminal velocity at zero thrust = √(g/0.025) ± 2 %; contact: impactSpeed = max −(v·n̂), null normal counts `\|v\|`, `tether` excluded, into-surface velocity removed; autopilot liftoff is exact at `durationSec` 2.2 AND 2.2/1.5: `pos` = from + (to − from)·minJerk(t/durationSec) ± 1e-6 at every step, `autopilotDone` and `\|v\| < 1e-6` at `durationSec`, body tilt ≤ 25°, `contact` during it only reports `impactSpeed`, and replacing the plan (`autopilot(null)`) mid-move or at the end — cine with full pitch stick, angle / acro with zero sticks (seeded from the cine craft) — moves the craft ≤ \|v\|·dt + 0.01 m with \|Δv\| < 0.2 m/s on the next step (dt 1/60); rth lands on the path end (landed, ≤ 0.05 m) with `distTouchdownM` non-increasing and never below the closest straight-line distance to the route end reached so far (a route held back by a wall keeps `distTouchdownM` > 5 m; the stall-landing timing is measured from the plan duration — an unobstructed twin's landing time —, not from `distTouchdownM === 0`) and never more than 0.5 m off the planned polyline (no corner overshoot); land the same against its vertical line; hold ± 0.1 m; crash reaches the ground (landed); mode switches keep \|Δpos\| < 0.05 m per step; identical inputs → deep-equal frames; NaN-free at dt 0, −1, NaN, 1e6 and NaN sticks (no throw). |
| `drone_tether` (L1) | `signalForDistance` (rangeM 150: 100 → 1, 125 → 0.5, ≥ 150 → 0); range projection onto the sphere (kind, inward normal, limited); `rangeM: 500` → 180; ceiling against groundZ and the home fallback; battery: hover drain empties in `batterySec`, warn at ≤ 0.2, `rth` exactly once at the 0.1 crossing, empty at 0, `batterySec 0` off; `planReturn` continuous climb → cruise → descend with cruise ≥ ground + 15, last point === home, `lengthM` = Σ segments, the < 3 m variant; JSON-safe `state()`; determinism. |
| `drone_gestures` (L2) | `buildClip` on the fixture frames for pack (43), place (50), goggles (42): `sourceFrames` equals the expected order (reversed halves, holds repeat the right frame), every partFrames slice equals its source frame bytes, `frameTimes[k] = k/30`, `duration = n/30`, `posFrames === null` (and not an empty array), `rootFrames === null`, one segment; refusals → null (frames length, out-of-range frame, empty plan, fps ≤ 0); `GESTURE_CLIPS` frozen with frames 43/50/42; `rigProfile` on all 26 rows = `row.profile` (22 humanoid / 4 no-hands rows; 11 / 2 heritages); driver against a fake entityManager (`entityMap` with a 34- or 3-part instance, `playLocalClip`/`stopLocalClip` recording, `setMotion` recording, `isDeathHeld`, `_resolveHoldingLocation`, `_attachedChildren`, `_filmHiddenGuids`, `setFilmHidden`, a fake seq with `globalFrameIndex`): clips go through `playLocalClip(guid, desc, {speed})`, ReadState / Ready through `setMotion(guid, cmd, 0x8000003D, 1)`, no Ready on a death hold, the event fires exactly once per job (also when the record is cut before the event frame), `done` once, timer mode on a part-count mismatch (event at 18/30/speed, end at 43/30/speed), `watch` re-issues at most once per second and only on a differing `lastMotionCommand`; `clip(B)` while A runs and `stop()` never report A's `event` / `done` afterwards (only the current job reports), `rebind` reports `done` with `rigChanged: true`; `hideWielded` round trip touches only the pilot's attached children, skips already film-hidden guids, restores exactly what it hid (absent guids included), `applyWielded` picks up a new wield; `loadAnim` reads `frames` once and frees (fake wasm), rejection → null. |
| `drone_props` (L2) | (real three, no DOM) build: droneGroup is a scene child with rotation.x −π/2 and `__punchPhase 2`; every node `layers.mask === 2`; no shadows; mesh raycast is a no-op; no `isLight` anywhere; only MeshStandard / MeshBasic, no `onBeforeCompile`, `customProgramCacheKey === THREE.Material.prototype.customProgramCacheKey`, no `__disposable` / `__cacheOwned`; mesh budgets (tablet ≤ 2, goggles ≤ 2, drone ≤ 6) and triangle budgets (drone ≤ 700, tablet + goggles ≤ 600, §3.2); `attach` sets `__attachedChildOf === guid` (never `__disposable`), the drone counter-scales `1/rootScale`; `toWorld` keeps AC x/y (1e-6) under a worldRoot-like rig (rotation.x −π/2), snaps z = groundZ + 0.06 and the yaw, scale 1; `remove` / `where`; `setRotor` blur switch at 0.3; `setScreen` false without a canvas; `fadeOut` → removed after delay + duration of `setRotor` time, no material swap that changes a program-relevant field; `dispose` disposes exactly what was created (count `'dispose'` events on every geometry / material / texture found before dispose) and removes droneGroup; second dispose disposes 0; `prewarm` with a fake renderer binds a HalfFloat target during `compile` and restores the previous one, resolves `{ok:true, compiled > 0}`, is memoised per renderer, keeps its materials alive, and answers `{ok:false}` (no throw) without a renderer; the prewarm material list has the same program-relevant fields as the createProps materials. |
| `drone_entities_seam` (L2) | Real `EntityManager` (same mocks and import order as `tests/unified_motion_authority.test.mjs`: import entities.js, THEN `installFakeMotionSequence()`): S1 the record = `{seq, desc, clearOnDone: true, hooks: [], lastHookTime: -1, speed: 1, localClip: true}`, no `inPlace`, non-cyclic seq, no bake fetch; S2 the previous one-shot and the pending queue are freed exactly once, queue null; S3 the tick poses the RAW frames (a common drift is kept, not removed in place) then hands back to the unchanged `_unifiedLoco`; S4 `setMotion` never cuts a clearOnDone clip; S5 `holdFinal` latches the last frame until the next `setMotion` (even a deduped Ready) cuts it; S6 `speed` scales the playhead; S7 refusals: unknown guid, part-count mismatch, death hold, `stopLocalClip` false for a non-local record and idempotent; S8 `FakeMotionSequence.doubleFrees === 0`. |
| `drone_controls` (L3) | Key → stick mapping (W/S/A/D/Q/E/Space/C/Shift); typing in a text INPUT passes keys through, a focused checkbox or SELECT does not (R2-5); Tab inside an open `[aria-modal="true"]` dialog passes, Space there stays blocked (R2-3); in `'pilot'` a short right-click ends the follow drag (`_endFollowDrag`) and its mouseup passes (R4-05); Esc / Enter / plain F11 / Shift+F11 / digits / Ctrl chords pass through; gamepad deadzone and expo (`shapeAxis(0.08) = 0`, `(0.5) = 0.3481`, `(1) = 1`, NaN → 0), mode2 / mode1 mapping through a fake `navigator.getGamepads`, hold-B `recall` at ≥ 800 ms once per hold; lock: `releaseHeld('drone')` then `poison('gate')`, `cs.keys` zeroed, `_endFollowDrag` called; restore un-poisons only its own gate (a pre-existing `'throw'` is neither released through nor cleared; a gate someone else re-set is left); every listener removed (fake window / document counting add/remove by type and capture flag); `setPhase('fly')` → a canvas pointerdown blurs focus and requests pointer lock (a rejected promise is caught), look gains + invertY, wheel → zoom ±1; `'deploy'` never requests pointer lock; `'pilot'` lets the right-button drag pass; a `pointerlockchange` to unlocked zeroes look while keys keep producing sticks, and the next fly-phase canvas `pointerdown` re-requests the lock; keys held at restore are drained (repeat + final keyup swallowed, then the drain listeners are gone), also when `dispose()` follows `restore()` in the same tick (R1-01: the autorepeat is still blocked, the keyup swallowed, then the listeners are gone and a fresh press reaches the client; a re-created controls works while an old drain is alive); blur zeroes; `dragover` stopped but not prevented. |
| `drone_osd` (L3) | Every formatter's exact strings (incl. `--` for null / NaN), `signalBars`, `staticOpacity` (1 → 0, 0 → 0.85), `headingTapeOffsetPx`, `homeArrowDeg` range; on `tests/helpers/social_fake_dom.mjs`: `show('fpv')` builds `#hb-drone-osd` with the §3.6 children and `pointer-events: none`, `data-mode` follows `show`, `update` writes the texts from raw values (`mode: 'acro'` → `ACRO` via `modeLabel`, `battery: 0.874` → `87%`), `clean(true)` adds `#hb-drone-clean-css` (FILM_CLEAN_CSS + the keep rule) and `html.film-clean`, `clean(false)` removes them (but keeps the class when `#film-clean-css` exists), `dispose` removes root and styles; no `document` → every method returns false without throwing. |
| `drone_audio` (L3) | The seam on the shared fake (`tests/helpers/fake_audio_context.mjs`): `getEffectBus()` null before `notifyUserGesture()`, then `{ctx === am._ctx, node === am._effectMaster}` connected to `_master`, HRTF mix `sliderGain() === 1` with the slider on the bus, retail mix (`hrtf: false`) bus at 1 and `sliderGain() === 0.4` after `setEffectGain(0.4)`; `createDroneAudio` with no bus: `start()` false, `update` / `stop` / `dispose` silent; with an in-test fake ctx that adds `createOscillator`, `createBiquadFilter`, `createBuffer` and AudioParam `setTargetAtTime`/`setValueAtTime`: the graph ends on `bus.node`, `start()` builds at output gain 0 (silent before an `update` with `level > 0`), `update` after `stop()` writes nothing, fpv crossfades ear/pan, panner position = (x, z, −y), level 0 → gain 0, the noise buffer is identical across builds, `dispose` stops every oscillator and leaves no connection; `humParams` finite and monotonic. Also re-run (not edited): `audio_manager_retail`, `audio_voice_pool`, `audio_retail_mixer`, `audio_volume_zero`, `audio_soundhook_slider_twice`, `audio_retail_setpan`, `audio_mp3_wave_bytes`, `audio_sound_prefs`, `options_sound_prefs`. |
| `drone_sequence` (L4) | Every row of §4.5 (actions deep-equal, in order); every beat duration / event time at speed 1 and 1.5; quick deploy (no pack; drone attached at the place entry; stow without packAway); skip from prep, every beat and liftoff before / after the own; the liftoff sub-events fire once each at `cutStartSec` / `cutBlackSec` / `cutEndSec` ÷ speed (the own on the path midpoint, `cutBlackSec === BEAT_SEC.liftoff / 2`) and T8 by time, autopilotDone and anyInput; the §4.4 totals table at both speeds; pilot view both ways; recall, recallInstant (flying, pilotView, returning) and RTH cancel by sticks (not by look / gimbal), but never by a stick held through the recall (T16 needs `armed`: held → no cancel; released, then pressed → cancel); battery rth once, forced landing (also from pilotView: `controlsPhase(stow)` + `osd(off)`), noDrone stow; T21 with fpv when `landed` and `distTouchdownM ≤ 5` arrive in the same tick (the release comes before the stow); crash path (static 1 s, release, tabletDown, gogglesOff, settle until gone), from pilotView too (T22 `osd(off)`; T23 `state` first and `controlsPhase(stow)`); T29 after `settleTimeoutSec` without `craft.gone`; every abort signal from every state (soft vs hard lists, the priority order, ignored once unlocked, the second-abort upgrade, `death` and `combat` → no Ready); `hidden` never aborts; deploy / recall idempotent; the prep waits for `rig` (not `rigKnown`); prep timeout → `rigKnown 'humanoid'` keeps the humanoid beats, `rigKnown null` → no-hands beats; `NO_ACTIONS` identity when nothing happens; `state()` JSON-safe; deterministic replays of a scripted input stream. |
| `drone_api` (L4) | `installDrone` with `deps.modules` FAKES for every other-lane key (`createGestureDriver`, `createProps`, `prewarmProps`, `DEFAULT_ANCHORS`, `DRONE_BODY`, `createManualCraft`, `createTether`, `createControls`, `createOsd`, `createDroneAudio` — minimal objects implementing exactly the §3 shapes and recording calls, so no L1 / L2 / L3 file is imported) and the REAL sequence + REAL world link over a fake `liveScene3d` (a FakeSwitcher with a real `THREE.PerspectiveCamera` as `persp` — `tests/film_runtime_camera.test.mjs` pattern —, a fake renderer with `domElement {width, height}`, `render() {}`, `info`, a fake entityManager with the pilot instance, a fake session handle); frames driven by calling `liveScene3d.film.preFrame(ts, dt)` / `postRender()`: deploy → beats → flying → 120 flying ticks → recall → landing → stow → idle; afterwards the camera is released (`cs.positionCamera` not an own property, `filmViewer` absent), `liveScene3d.film` deleted, the fake funnel's `_fault === null` — meaningful because the fake controls apply §6.4 to the funnel they resolve (`deps.funnel ?? window.__inputFunnel`: `poison('gate')` at `lock()`, `unpoison()` at `restore()`), so it checks index.js's lock / restore wiring and the `funnel` forwarding —, window / document / canvas listener counts back to baseline, no hook listener; a fake gestures driver whose `ready()` resolves several frames after `profile()` is known: no `clip` action before it resolves, `props.setRig` gets the profile on the first tick it is known, and the fake props refuse `attach` without a humanoid profile (so a missed setRig fails); the fake tether's `clamp` receives `home.pos` (an array); exactly one `hb-drone-state` event on `document` per transition (none on window, none extra at teardown) and a `message: 'state'` entry per transition in `debug.events()`; wheel zoom moves `settings.fovDeg` within [60, 110] and the storage write happens at most once per second; idempotent `installDrone`; every method (incl. bad arguments, calls after `dispose`) never throws and `JSON.parse(JSON.stringify(r))` deep-equals `r`; refusals pass `deps.refusal` codes through with the exact reasons; settings validation and persistence through a fake storage; `tune` merge order; `readDroneFlags` exact matching; `sessionChanged` with a Proxy-wrapped handle (stable) vs a new raw handle (changed). Phase 4 (P10, §14.4): over the real world link and a fake session handle whose `sweepSphereAgainstBuildingMesh` models horizontal roof slabs (physics.rs's two-sided triangle sweep: the earliest contact on the start side, the normal toward the start): a roof over the pilot → `{ok:false, code:'covered', reason:'Needs open sky above you'}` (also through `button()`), state idle, no `hb-drone-state` event, no window / document / canvas listener ever added, the funnel untouched, `liveScene3d.film` absent, the link disposed with no hook listener, nothing past the link built (no props / gestures / craft / tether / controls / OSD / audio / prewarm, no AudioContext resume, no bus subscription), the hit box freed, the `covered` log entry; open sky again → the next deploy starts; a roof over the lift-off end only refuses too (film's own hooks object stays, with none of ours); clutter 0.25 m above the base, an overhang at base + 17 m, a body (`objects`) or a door (`entities`) over every column never refuse; the four columns on a 30° slope: x / y at 0 / 0.72 / 1.5 / 4.12 m along the compass, z from terrain + 0.5 to terrain + 16.5, radius 0.18, one sweep per roof layer per column, no cell / entity / object sweep; the plain fake handle (no sweep method) deploys; a pilot on a 1 m platform: every column starts 0.5 m above the platform (its floor is no roof) and a roof 6 m over it refuses; a throwing `segmentBlocked` reads as open sky (the deploy starts, a warn per column); the sweeps use the link's session-handle chain (`deps.getSessionHandle()`, then `liveScene3d.sessionHandle`, then `window.__sessionHandle`) and no handle at all reads as open sky (the deploy starts, nothing swept); the check runs last (a `deps.refusal` code such as `moving` and the own `not-in-world` checks win over a roof, with no world link built and nothing swept). F2: a 30° slope with the pilot on the terrain → the drone rests at terrain + 0.06 (± 0.01, at the drop and in `status().craft.aglM`) for the humanoid 0.72 m drop (at the hand downhill; placed uphill, where the hand is > 0.3 m above the feet) and the no-hands 1.5 m drop both ways; a 40° slope, where the humanoid drop 0.72 m out is 0.6 m off the feet (past DV-22's 0.5 m — at 30° it is 0.42 m, which DV-22 alone already took): the hand drop downhill (`toWorld`) and the place uphill both rest at terrain + 0.06; the "on the terrain" band: feet 0.2 m over or under the terrain still follow the 30° slope, 0.3 m over it keep the feet; a pilot 1 m above the terrain → foot level (the no-hands place and the humanoid hand drop). |
| `drone_hud` (L5) | On `tests/helpers/social_fake_dom.mjs` (`globalThis.window = globalThis`; `location.href` = the app's `index.html` file URL, `search: "?drone=on"`; a `FakeCustomEvent` subclass for `detail`): only the exact `?drone=on` mounts (`ON`, `1`, `true`, `off`, absent → nothing; `droneHudEnabled(s, true)`: only `off` disables); the launcher lands in `.hb-hotbar-addons`, is a BUTTON with `data-tip=""` and `_hbTip()` `{text:"Drone", key:"Shift+F11", sub}`, the style text contains `order: 10`; remount via `hb-hotbar-mounted` re-attaches; no toolbar → the float with `right: 12px; bottom: 84px` and a `title`; refusal tooltips and dot states for each refusal signal (fake handle / globals — the real shapes: `__useTargeting.pending = {itemGuid: 1, itemName: "x"}` → `targeting` (not `busy`; `Finish targeting first`, never red on its own), `pending: null` → not targeting; a running drone state → `busy`; `readDeploySignals(win, cache, state)` with a passed state makes no `status()` call, and an idle tick / tooltip read / click reads `status()` once per state read (R2-7); `__film.status()` with `active: false` but `take.running` an object → `film-busy`); the `hb-drone-state` listener is on `document`; never `disabled`; the bus binds late through a pending `__pluginClientReady` and forwards `damage` / `death` (self only) / `portal` to every listener registered through `deps.onSignal(fn)` (`fn(name, detail)`; the returned unsubscribe removes it); clicks map to `api.button({shift})` on a fake api from `ctx.loadDrone`; right-click opens the kit popover (`preventDefault`), Escape closes it; the window-capture `pointerdown` / `mousedown` outside-press closers are present after mount and gone after dispose, and a popover opened after a (fake) drone lock's later-registered capture blocker still closes on a canvas press — the test emulates the browser's window-capture order, which the fake DOM lacks (R2-4); `window.__toggleDroneHud` / `__droneHud` installed and removed by dispose; I-27: no static import of `scene3d/` or `three` in `plugins/drone-hud.js` and `new URL(` + `location.href` present; the manifest's exact hotkey and `iconHidden`; `plugins/index.json` lists `./drone-hud.manifest.json`. Phase 4 (§14.4): `REFUSAL_TEXT` has the exact `covered: "Needs open sky above you"` entry and `refusalFor` never returns it; a click whose `api.button()` answers `covered` loads the module, flashes the dot red for 2.5 s with that tooltip text and never sets `aria-disabled`. L5 also runs `node test_plugin_index_gen.mjs` and `node tests/plugin_loader.test.cjs`. |

### 8.3 Run lines (from APP)

`node tests/drone_flight.test.mjs`, `node tests/drone_tether.test.mjs`, `node tests/drone_gestures.test.mjs`,
`node tests/drone_props.test.mjs`, `node tests/drone_entities_seam.test.mjs`, `node tests/drone_controls.test.mjs`,
`node tests/drone_osd.test.mjs`, `node tests/drone_audio.test.mjs`, `node tests/drone_sequence.test.mjs`,
`node tests/drone_api.test.mjs`, `node tests/drone_hud.test.mjs`; plus `node test_plugin_index_gen.mjs` and
`node tests/plugin_loader.test.cjs` (L5). Parallel agents run only their own targeted suites (CLAUDE.md rule).

---

## 9. Assumptions A1–A7

| # | Status | Evidence (code) | SPEC impact |
|---|---|---|---|
| **A1** | **amended** | The 1070 result holds (ReadState enters / holds 10+ s / leaves smoothly; Pickup / StoreInBackpack snap upright). Cause, read in code: Pickup 0x18 and StoreInBackpack 0x19 are in entities.js `INTERACTION_COMMANDS`, so `classifyMotionCommand` returns `"attack"`; `_setMotionImpl`'s action branch plays ONLY the Ready→cmd MotionTable link through `_tryPlayLink` → `_playLinkEntry` (a clearOnDone one-shot), never installs the substate's held cycle and leaves `lastMotionCommand` unchanged, so the tick hands back to the untouched Ready `_unifiedLoco` — the one-frame snap. ReadState 0x0146 is in `STATIONARY_COMMANDS` → `"walk"` → link + looping held cycle on `_unifiedLoco`. Not the cmdInterp lane, not `_readyIssue` (a missile-reload stamp read only by `_missileReloadFrom`). Local lanes that DO issue Ready on the pilot: camera.js `_dispatchMovement` → `_dispatchLocalRigMotion` on any key-signature change and on orbit ↔ follow switches; cmdInterp DriveApplied on key edges; `cancelCastSequence` (fizzle); `app/local_auto_motion.js` after a server drive. | Gestures stay JS clips; ReadState / Ready stay `setMotion`. The input lock starts at deploy start (DV-3), the camera is normalised to follow / third person before any held motion (§6.5), KeyC is taken, and the 1 Hz watchdog re-asserts ReadState. No classification change (out of scope). |
| **A2** | **confirmed** | The tick's one-shot branch suppresses `_unifiedLoco`, advances `ua.seq` (a Rust MotionSequence holding timing only) and poses `ua.desc` with `poseRigAt(…, ua.inPlace === true)`; the probe ran the four-step tail. | §6.1 freezes the seam, with three additions: the part-count guard, the death-hold refusal and the `localClip` marker (so `stopLocalClip` never frees a server gesture or a death hold). |
| **A3** | **confirmed** | Rust `fetch_animation` pushes origin xyz then orientation w,x,y,z per (frame, part); the poser reads `(f·partCount + p)·7` and `quaternion.set(+4, +5, +6, +3)`; fixture grips reproduce the 1070 measurements. Caveat: Animation POS_FRAMES (`flags & 1`) is never exported, so a clip never carries root motion; the `frames` getter copies on every access. | `buildClip` slices frames with `posFrames: null`; `loadAnim` reads `frames` once, records `flags` and warns on POS_FRAMES; `clipParity()` reports the flags on the 1070. |
| **A4** | **confirmed (deps amended)** | `createSafety`, `createWorld` (+ prewarm), `createWorldQuery` and `createLensOverlay` construct and run outside `?filmMode=on`; only `film/index.js` imports `flags.js`; no film module has top-level side effects. Exact deps differ from PLAN: safety needs `los` (namespace, else FilmError BAD_ARGUMENT) and reads the handle from `sh`; the lens overlay takes `{THREE, renderer}`; worldQuery pins the handle at construction; createWorld exposes only `{teleport, command, ready, checkReady, prewarm, avatar, actor, stats}`; `liveScene3d.wasmExports` lacks `populateSceneryCollidersForLandblock`; `allParticleManagers` is optional (default enumeration covers the world manager and every owner-registry manager — on index.html; on index-bundled.html the drone's owner_registry.js is a separate empty instance, §1.4). | §6.3 recipe; link built per deploy and disposed at idle; handle getters; `particleManagers` omitted; prewarm `collision: false` (DV-9). |
| **A5** | **confirmed (caveats)** | `window.__inputFunnel` is created at index.html module top level before `initPluginBar`; `releaseHeld(reason)` synthesises keyups (not Space) through `handleKeyUp`; `poison('gate')` closes keydowns only; `unpoison()` clears unconditionally; `snapshot().fault` reads the ONE untagged slot. Caveats: a bare `poison()` means `"throw"`; under `?inputFunnelV2=off` the funnel exists but is not installed; the gate function is injected only at login; film's clean frame restores its saved fault blindly, so interleaving breaks either side. | §6.4: resolve at lock time; poison only from null; un-poison only our own still-set gate; cancel a held Space charge separately; report `funnelInstalled`; hard mutual exclusion with film (refuse + abort on `filmBusy`); and the film-gate settle (`filmGate` / `settleFilmGate()`, §6.4 — R1-03: the abort alone left film's blind restore holding an orphaned `'gate'`). |
| **A6** | **confirmed (caveats)** | `liveScene3d.audioManager = audioManager` (scene3d/index.js ≈6923) stamps the same object as `window.liveScene3d = liveScene3d` (≈4854) and the tick's `liveScene3dRef`. Caveats: `window.liveScene3d` is null until init3D publishes it; `audioManager` stays undefined until init3D passes its atmosphere await; it never exists under `?wireframe=1` without diag or without `wasmExports.fetchWave`; its context is null until the first gesture. | Resolve `window.liveScene3d?.audioManager?.getEffectBus?.() ?? null` lazily at `start()`; deploy refuses `not-in-world` while `window.liveScene3d` is null; no bus = silent, never an error. |
| **A7** | **amended** | A plugin reaches the bus through `window.__pluginClient.events` (`on / off / once / emit` over an EventTarget), NOT through `mount()`'s ctx (`client: null` at page load). The client is created once at the first login and announced by `window.__pluginClientReady`; it survives reconnects (`attachHandle`). Payloads are `ev.detail`: `vitalChangedHealth {current, buffedMax, oldValue}` (oldValue may be undefined), `death {victimGuid, killerGuid, message}` for EVERY kill, `damageTaken` (combat JSON), `portalSpaceEntered {teleportSeq}` (exists; api.js's coverage table is stale), `landblockChanged {prevLb, lbId}`; no stance event. Polling fallback: `__pluginClient.host.TryGetPlayerStats().vitals[1]` (frees its box). | The plugin owns the late-bound subscription and forwards edges via `deps.onSignal`; levels (stance, portal, death hold) are polled per tick (§6.7). |

---

## 10. Deviations from PLAN, and the 1070 eye-test items

### 10.1 Deviations (each with its reason)

- **DV-1 `deps.modules` + async idempotent `installDrone`** (D-a): added `prewarmProps`, `DEFAULT_ANCHORS`,
  `DRONE_BODY` override keys so index.js never statically imports a sibling.
- **DV-2 New API methods** `skip()`, `button({shift})`, `dispose()`; `status().craft.hprDeg` (degrees, named) instead
  of `hpr`; status adds `beat`, `quick`, `camera`, `flags.signals`. Reason: the button table needs a skip and one mapping
  for click / Shift+F11; JSON readability.
- **DV-3 Input lock from deploy start to idle** (PLAN §7: "at the goggle cut"). Beats 1–4 (≈5 s) would otherwise be
  unlocked: movement keys reach cmdInterp (MoveToState sends — breaks §8 / E9), canvas clicks Use objects, and key
  changes make camera.js re-issue Ready. This also resolves PLAN R3's own contradiction.
- **DV-4 Camera normalisation** (`prepareFollowCamera`): deploying from orbit / topDown / first person switches to
  follow third person at deploy start and restores after the stow (orbit ↔ follow transitions issue Ready on the pilot;
  in-head pushes avatar opacity 0). `forcePilotOpaque` after `own()`; `framePilotFront` in pilot view (release() alone
  shows the pilot's back); the right-button drag passes in pilot view.
- **DV-5 KeyC and KeyM are taken while locked** (C is the client's camera-mode toggle; M the World Map, outside the
  funnel); Shift+F11 is never taken by controls (it reaches the manifest bridge).
- **DV-6 Cine setpoint** (amended in the phase-0 review): a one-step lead (`pos + vCmd·dt`, exact vel feed-forward) +
  a latched jerk-aware stop point, not a 3 m leashed integrated setpoint (measured 18 m overshoot / 10 s settle).
  Measured on the real flight model at 10–60 Hz: 12.04 / 19.96 / 4.01 m/s at full stick / boost / vertical; release
  from 12 m/s → 21.1 m travel, 0.13 m past the stop point, `|v| < 0.05` after 3.8 s at 60 Hz (≤ 4.0 s down to 10 Hz;
  boost 54.8 m, 0.31 m, 5.6 s).
  Boost via `createDrone({ preset: 'cinema', vmax: 20 })` (cinema caps |v| at 12) — which is exactly why no longer lead
  is allowed: createDrone adds `kp·|e|` to the feed-forward, so the first draft's 0.5 s carrot settled at 16.3 m/s
  (37.5 m braking travel against the 22 m pin) and climbed at 5.45 m/s; its "0.25 m / 3.6 s" held only while vmax 12
  clamped the overspeed. Contact goes through `createDrone.reset` (no contact API).
- **DV-7 Two safety instances**: eye (film defaults + throttled lens hide) and body (radius 0.18 m, clearance = rest
  height 0.06 m, no lens) — the eye's 0.7 m floor on every outdoor clamp would forbid landing and lift-off.
- **DV-8 Viewer cell**: not 0 outdoors — while owned, camera_owner carries the outdoor landcell and publishes
  `liveScene3d.filmViewer` (PLAN §7 said "stays 0"). No action needed; documented.
- **DV-9 Prewarm options** `{radius 96, maxLandblocks 4, timeoutSec 8, envCells false, collision false, corridor true}`,
  one in flight, ≥ 2 s apart, only on a landblock change: prewarm is not cancellable (it resolves once baked, else at
  its timeout — default 30 s), collision populate
  skips the player's 3×3 ring which bounds the drone (180 m cap), envCells are indoor content (v1 is outdoors).
- **DV-10 Lens overlay budget**: reusing film's overlay costs 24 draw calls (freestyle; cinewhoop 38) and one extra
  render, not "≤ 6"; style freestyle, uptilt 20° (angle) / 25° (acro). Prop budget: ≤ 4 draws in the goggles view
  (tablet 2 + goggles 2; the drone is hidden while the camera is owned), not "≤ 3". Hence PLAN §7's "FPS within 5 % of
  walking" (E7, and the §12.2 flip criterion) is measured in **cine** (lens overlay off); the angle / acro overlay cost
  (24 draws + one extra render) is measured and reported separately on the 1070, not held to the 5 %. (Phase 3: the 24
  are overlay meshes; three r184 draws each transparent DoubleSide quad in two passes, so the freestyle overlay measures
  48 GL draws per frame — §10.2 E7, §14.3.)
- **DV-11 Prewarm** (D-g): fires on the `__sceneReadyEverFired` latch / the `holtburger:state` "ready" event (the
  `__bootState` scalar can be overwritten by `in-world`), and compiles through a bound HalfFloat target with a guarded
  ready-poll, not a bare `renderer.compileAsync` (that warms the unused canvas variant and throws from three's timer if
  a material is disposed mid-link). The props module's `prewarm` is a module function (the plugin warms without
  building an instance or loading index.js); the instance has no `prewarm(camera)`.
- **DV-12 Motions at speed 1**: ReadState and Ready are always issued at speed 1.0 (even in quick deploy): `setMotion`'s
  speed lingers in `inst._motionSpeed` and would replay the held cycle and later one-shots at 1.5×. Quick-deploy clips
  and the lift-off still run at 1.5 (quick: the boot wipe starts at 3.39 s, the own at 3.51 s — §4.4 totals).
- **DV-13 Death- and stance-aware abort** (PLAN §2.4 "`setMotion(Ready)` is applied"): no `setMotion(Ready)` on
  reason `death` or a death-held rig (Ready passes CQ-06, frees the death hold and clears `_deathAt` — the local corpse
  would stand up), nor on reason `combat` (the server's combat-stance motion has already replaced ReadState; Ready in
  NonCombat would re-pose the rig out of step with it). The held-motion watchdog runs only while held AND locked, so
  it stops at every abort and never re-asserts ReadState after one.
- **DV-14 Third hot-file seam** `app/plugin_bar.js` (one dispatch entry, L5): the manifest hotkey alone does nothing.
- **DV-15 `tests/plugin_loader.test.cjs` 50 → 51** (L5): the 51st manifest otherwise turns the gate red.
- **DV-16 Refusal / signal ownership**: the plugin is the single implementation of the deploy-refusal reader
  (`deps.refusal`), the bus edges (`deps.onSignal`) and `/read` (`deps.broadcastPose`); `ui/portal_busy.js` is not
  imported (its `portalSpaceActive()` is the global read). `moving`, `busy` and (phase 3, R4-10) `targeting` never turn
  the dot red on their own; the Olthoi "no hands" case is informational, not a disabled state (§5.1 says they still
  deploy).
- **DV-17 Abort split** soft (land in place + fade 5 s; damage / death / combat / user) vs hard (remove now; session,
  context loss, portal, pilot moved, film, dispose, rig lost, error): a drone landing in a world being torn down or in a
  film take helps nobody. "Within one frame" holds for the camera, input and props on the pilot in both — counted from
  the tick that sees the signal: edges and levels are read every tick, but `filmBusy` is polled at 4 Hz (`__film.status()`
  allocates a large object), so a film take starting is acted on up to 250 ms late (PLAN §2.4 amended for that one
  trigger).
- **DV-18 Crash / forced landing / abort fades** keep the cycle in `stowing/settle` or `aborting/settle` until the drone
  is gone, with input already restored, so `idle` always means "nothing left".
- **DV-19 RTH and recall**: R, gamepad A, hold-B, the button and Shift+F11 all request `recall` (RTH then land and
  stow); RTH from the goggles is cancellable by stick axes (not by look / gimbal) except a forced landing; from pilot
  view or after an instant recall it is not. Only a FRESH stick input cancels (PLAN §6.4 "any stick input"): the sticks
  must first read released after the recall (`rth.armed`, T16), so the stick still held when R, gamepad A or the
  battery triggered the RTH never cancels it on the next tick.
- **DV-20 Range sphere uses 3-D distance**; `rangeM` setting range [20, 180]; signal fades over the last 50 m of
  `rangeM` (100 → 150 m at the default).
- **DV-21 Heading conventions**: the drop spot and the drone yaw use the compass heading from the rig root
  (`−yaw`); probe4's raw-yaw formula is wrong except facing N/S.
- **DV-22 Drop height**: `worldQuery.groundZ` is terrain-only, so the drone sits at the pilot's foot level unless the
  terrain under the drop xy is within 0.5 m of it.
- **DV-23 droneGroup** is a scene child WITH `rotation.x = −π/2`, `__punchPhase = 2` and layer 1 on every node (an
  untagged scene child is punch phase 0, the terrain family, erased by the doorway punch; layer 0 props are overpainted
  by the indoor depth split).
- **DV-24 Depth buffer**: reversed-Z is the default since 2026-10-19 (PLAN §5.6 said logarithmic); stock materials handle
  both; no custom shaders, no polygon-offset units.
- **DV-25 The drone is hidden while the camera is owned** (saves draws; the FPV near plane is 0.1 m); the craft position
  is the eye.
- **DV-26 Settings** split `crash` into `crash` + `crashMps`, flatten acro rates to `acroRc / acroSuper / acroExpo`, add
  `fovDeg` (vertical, default 75); new storage key `hb.drone.seen.v1`.
- **DV-27 Flag reader spelling** (D-i): `defaultOn ? !(v === "off") : v === "on"` — two exact comparisons; the literal
  `!== "off"` would read as default-on to `../../scripts/audit-flag-defaults.mjs` while the constant is false.
- **DV-28 Empyrean (R9)**: v1 plays the same clips on Empyrean setups (0x02001A16 / 0x02001A10); if E2 shows the
  foot-level drop, phase 4 sets `clipMode: 'timer'` for those setups in `data/drone-rig-profiles.json` (no code change).
  The 0x03000C34 hover anim is not in the fixtures, so the prepend/append mitigation is v2.
- **DV-29 Mouse in angle / acro**: angle — mouse X yaws, Y ignored; acro — mouse ignored; boost is cine-only.
- **DV-30 Per-frame allocation** applies to drone code only (film pieces allocate per call; §5 lists the exemptions).
- **DV-31 Kinematic lift-off, cut on the path midpoint** (PLAN §2.1 beat 5, §6.5): the PLAN's 3.8 m lift-off in 2.2 s
  (min-jerk peak 4.5 m/s², 21 m/s³) is outside the cinema craft's limits (amax 4, jmax 8). Flown as a tracked target
  through `createDrone` it ended 1.06–1.46 m short with 1.3–2.1 m overshoot and settled only after ≈ 6 s (quick:
  0.97 m short), and at the old own time (0.975 s) the craft was ≈ 0.5 m up, so the eye's 0.7 m floor would have
  popped the first FPV frame. So the `liftoff` plan drives the cine craft kinematically (§3.3: per-step
  `createDrone.reset` on the min-jerk path with exact velocity / acceleration — exact at both speeds, body tilt ≤ 24°
  measured, continuous at the handover), and the goggle cut is centred on the path midpoint: `cutBlackSec = 1.1` =
  liftoff / 2 (0.85 m up, 1.7 m out on the nominal path — PLAN's "≈1 m up, ≈1.5 m out"), the wipe from 0.925 s (PLAN
  "about 0.8 s in"). The other plans stay tracked targets and must be feasible (§3.3: a naive phase-speed RTH target
  overshoots the descent corner by ≈ 10 m).
- **DV-32 Module signatures reshaped — the SPEC wins over PLAN §4.3** (lanes read PLAN for intent, this SPEC for
  every name): gestures `clip(name, speed)` is a synchronous `{ok, mode, name}` job reported by `poll(dt)` (PLAN:
  "resolves at the end; fires `eventAtFrame`"), `watchHeld(cmd)` → `watch(nowSec)`, plus `ready`, `profile`,
  `applyWielded`, `rebind`, `clipParity`, `dispose`; props `createProps({THREE, renderer, scene})` → `{THREE, scene,
  anchors, createCanvas, log}`, `attach(prop, rigPart, offset)` → `attach(name, anchor)`, `setRotor(throttle, t)` →
  `setRotor(spin, t)`, `prewarm(camera)` → the module function `prewarm(deps)` (DV-11), plus `group`, `setRig`,
  `setAnchors`, `place`, `where`, `worldPos`, `setDronePose`, `setVisible`, `setGround`, `fadeOut`, `fading`, `stats`; craft `createManualCraft({mode,
  presets})` → `{mode, rates, createDrone}`, `reset(pose)` → `reset(pose, opts)`, `step(sticks, dt) → {pos, vel, q, camQ,
  throttle, landed}` → `step(input) → CraftFrame`, `contact(hits)` → `contact(hits, clampedPos)`, `autopilot(path)` →
  `autopilot(plan)`, plus `setRates`, `state`; tether `clamp` adds `kind, normal, distM`, `planReturn` options add the
  two ground heights, plus `configure`, `reset`, `state`; controls `createControls` adds `navigator`, plus `setPhase`,
  `status`, `dispose`, `phase`, `locked`; osd `createOsd({document})` → `{document, window}`, `show(mode)` →
  `show(mode, {durationSec})`, `update(state)` → `update(view)`, plus `frame`, `cheatSheet`; audio `createDroneAudio({bus})`
  → `{bus, enabled, volume, rng}`, `update({throttle, speed, distM, fpv})` → `update({throttle, speed, level, fpv,
  pos})`, `stop()` → `stop({fadeSec})`; world_link `{…, sessionHandle, …}` → `getSessionHandle`, `lensOverlay()` →
  `configureLens` / `drawLens`, plus `safetyBody`, `aspect`, `particles`, `los`, `onPreFrame` / `onPostRender`, the
  camera helpers, `stats`.
- **DV-33 `broadcastPose` traffic** (PLAN §8 "Nothing else is ever sent"): with the setting on, tablet-up sends
  0x01E1 Communication_SoulEmote AND one 0xF61C MoveToState (`app/slash_commands.js` `runSoulEmote` →
  `handle.broadcastEmoteMotion`, the same path as typing `/read`); nothing is sent at the stow (other players keep the
  reading pose until the pilot's next movement). With the setting off (the default) a full cycle sends nothing (E9).
- **DV-34 Beat totals** (PLAN §2.1 "≈5.6 s from click to control; quick ≈3 s", §2.3 "≈5 s; quick ≈2.5 s"): the
  PLAN's own beats give 5.233 s of gestures before the lift-off and a 5.233 s full stow; §4.4 states the recomputed
  totals (humanoid: own at 6.33 s, control by time at 7.43 s; quick: 3.51 s / 4.24 s; stow 5.23 s / quick 2.78 s).
- **DV-35 Dropped or clarified PLAN details**: `?droneDebug=on` adds no gizmos in v1 (only `__drone.debug`: no scene
  objects, draws or program keys; PLAN §4.4 "gizmos" is v2); pointer-lock loss (PLAN §6.2 "Esc releases pointer lock
  … and the drone hovers") zeroes look and leaves the keys / gamepad flying (§3.5); the prop triangle budget (PLAN §5.6
  drone "≈600 tris") is pinned as drone ≤ 700, tablet + goggles ≤ 600 (§3.2, drone_props).

### 10.2 Items left for the 1070 eye test (append to PLAN §10)

- **E1+** Shift+F11 does not toggle browser fullscreen or anything else in Chrome; the button stacks under ⚒ with and
  without `?rynthHud=off`; the float position with no toolbar.
- **E2+** Goggles orientation (lenses forward with the identity anchor quaternion) and helmet fit (`goggles.scale`);
  the drone's world size for large races (counter-scaled in the hand); an Empyrean clip (DV-28); Lugian / Tumerok
  offsets; the blob shadow sits on the ground (no z-fight) and the drone neither floats nor sinks on slopes / platforms.
- **E3+** The goggle cut with the boot wipe: no pop; the first FPV frame (on the lift-off path midpoint, ≈ 0.9 m AGL,
  DV-31) frames the pilot (look-at chest z + 1.2 m). Also: a launch facing an upslope (the eye's 0.7 m floor may lift the
  first FPV frames slightly) and a skip early in the lift-off (cuts in low; the eye rides the floor until the path
  passes it, T9).
- **E4+** Deploying from orbit / topDown / first person (DV-4); pilot view framing in front of the pilot and the
  right-drag orbit; ReadState survives own / release / pilot view; the avatar is opaque in the reveal.
- **E6+** `debug.trigger` for each signal; a real hit; a fizzle mid-deploy; a server emote mid-flight (queues behind the
  clip; the watchdog re-raises the tablet within 1 s).
- **E7+** FPS with CSM on and the camera moving at 12–20 m/s (cascade re-raster); E7's "≤ 5 % loss" is measured in
  cine, and the lens overlay's 24 draws + extra render in angle / acro are measured and reported separately (DV-10);
  first-deploy frame times with and without the idle prewarm; prewarm storms along landblock edges; on
  `index-bundled.html`, smoke / gas from STATIC emitters near the lens may stay unhidden (§1.4 owner-registry gap).
- **E9+** The send counter over a full cycle with `broadcastPose` off (only 0x01E9 pings) and on (plus exactly one
  0x01E1 and one 0xF61C at tablet-up).
- Hidden wielded items' lights / particles (a held torch) keep drawing; the drone can fly through the pilot
  (`exemptLocalPlayer`); `cancelCastSequence` / chat emotes during the deploy.
- **Phase-3 additions** (§14): E1 — the popover closes on a canvas click mid-flight (R2-4), and a pilot-view
  right-tap on an NPC opens no radial menu (R4-05; one opened before could only be closed with Esc or a right press —
  R2-4's radial-menu half). E2 — the new `droneInHand` quaternion
  (R4-03) on a male and a female human: no snap at the place release or the pickup, the shoulder pose; the
  see-through blur discs (V2) and the dark lenses (V3). E3 — the angle / acro handover blend at T8 (R4-04, ≤ ≈ 3° of
  view turn per frame); a crash or forced landing near the ground rests on the ground while the camera keeps the eye
  floor (R3-1). E4 — the OSD layout clear of both vitals layouts at 1920×1080 and on the 1070 window, and the
  pilot-view banner below the feet (R4-01 / R4-08); the battery RTH with `__drone.setSettings({batteryMin: 1})` as a
  pre-step (restore 10 afterwards; the popover offers 5 – 20 min, R4-06); pilot view shows the tablet's back plate
  (the screen faces the pilot's eyes — decide: a higher follow pitch, over-the-shoulder framing, or accept; R4-11);
  the short-recall time (a recall from 4–12 m climbs to 15 m AGL and takes ≈ 24–26 s — an owner decision, R4-07).
  E6 — deploy from orbit, die mid-flight (a real death hold; `debug.trigger('death')` creates none): the corpse stays
  down (R3-4); a pointer-lock grant racing a hard abort (`__drone.debug.trigger('damage')` in the click's frame, then
  read `document.pointerLockElement`, R1-09). E7 — the first angle / acro FPV frame on a fresh profile (the overlay
  twin, R2-2); the overlay's DoubleSide quads render in two passes on r184 (48 draws / frame, `forceSinglePass` would
  halve it — measured in node, not adopted).
- **Phase-4 additions** (§14.4, re-check on the 1070): E5 — under the F1 archway (AC world 4650.62, 9422.93, 76.01;
  landblock 0x1831) a click flashes red with `Needs open sky above you`, nothing locks and `debug.events()` holds one
  `covered` entry naming the column; a few metres out in the open the same character deploys and lands on the drop
  spot; a deploy from a porch / doorstep / platform outdoors (the pilot on a floor above the terrain) is NOT refused;
  another player or an NPC standing in front never refuses. E2 — `+Drone Olthoi` on the snowy slope: the drone rests on
  the snow at the drop spot (`status().craft.aglM` ≈ 0.06 at the spawn beat, was 0.81), also facing up the slope.

---

## 11. Lane cards

**L1 FLIGHT** — files `scene3d/drone/manual_flight.js`, `scene3d/drone/tether.js`. Provide: `CRAFT_MODES`,
`CRAFT_TUNING`, `betaflightRateDeg`, `createManualCraft` (`reset`, `step`, `contact`, `setMode`, `setRates`,
`autopilot`, `state`) with the CraftFrame / plan shapes of §3.3 — the cine one-step lead, the KINEMATIC lift-off and
feasible (corner-braking) rth / land targets are binding (DV-6, DV-31); `TETHER_DEFAULTS`, `signalForDistance`, `createTether`
(`clamp`, `drain`, `planReturn`, `configure`, `reset`, `state`) per §3.4. Consume: film `createDrone` / `DRONE_PRESETS`,
film core gimbal / quat / vec3 / easing; the Sticks shape (§3.3, produced by L3); plan descriptors (built by L4 §7.4);
safety hit shape (§5). Tests: drone_flight, drone_tether. Never: DOM, three, wasm, clocks, Math.random; never edit
`scene3d/film/*`.

**L2 RIG** — files `scene3d/drone/gestures.js`, `scene3d/drone/props.js`, the §6.1 seam in `scene3d/entities.js`,
`fixtures/drone/{anims,rig-table}.json` (copies). Provide: everything in §3.1 and §3.2 (exact names, the ClipDescriptor,
RigProfile, GesturePoll, the props member table, `prewarm`, `DEFAULT_ANCHORS`, `DRONE_BODY`, `ANCHOR_OF`, `ANCHOR_KEY`),
`playLocalClip` / `stopLocalClip`. Consume: the entities API (`entityMap`, `setMotion`, `isDeathHeld`,
`_resolveHoldingLocation`, `setFilmHidden`, `_filmHiddenGuids`, `_attachedChildren`, `spawnInFlight`), wasm
`fetchAnimation`, injected THREE. Tests: drone_gestures, drone_props, drone_entities_seam. Never: any other edit to
entities.js; `clearAllFilmHidden`; Light objects; custom shaders; `__disposable`; static three imports.

**L3 INPUT / OSD / AUDIO** — files `scene3d/drone/controls.js`, `osd.js`, `audio.js`, the §6.2 seam in
`scene3d/audio/audio_manager.js`. Provide: §3.5, §3.6, §3.7 exactly (Sticks shape, actions, phases, OSD ids / classes /
formatters / OsdView, `getEffectBus`, `createDroneAudio`, `humParams`). Consume: `window.__inputFunnel` (lock time),
`cameraSwitcher` (`keys`, `_endFollowDrag`, `domElement`), `ui/escape_action.js` jump helpers, film clean-frame CSS
constants, `film/core/rng.js`. Tests: drone_controls, drone_osd, drone_audio (+ the existing audio suites). Never:
taking Esc / Enter / F-keys; `createCleanFrame`; a bare `poison()`; touching the funnel's `_fault` except through its
methods; editing `tests/helpers/*`.

**L4 CORE** — files `scene3d/drone/sequence.js`, `world_link.js`, `index.js`, and `data/drone-rig-profiles.json`
(EMPTY: `{"version": 1, "profiles": {}}`, §7.6). Provide: §3.8, §3.9, §3.10, §4, §5, §6.3,
§6.5, §6.7 (index.js part), §6.12, §6.13, §7. Consume every other lane's factory only through `deps.modules` /
dynamic import (§7.2) and the plugin's `deps.refusal` / `onSignal` / `broadcastPose`. Tests: drone_sequence, drone_api
(fakes for every other-lane factory). Never: static imports of sibling modules; `world.teleport / command / actor /
avatar`; `liveScene3d.film.holdLoop`; `clearAllFilmHidden`; editing film.

**L5 HUD** — files `plugins/drone-hud.js`, `plugins/drone-hud.manifest.json`, `plugins/index.json` (generated),
`scene3d/drone/README.md`, the `docs/url-flags.md` rows (§12.2), the `app/plugin_bar.js` entry and the
`tests/plugin_loader.test.cjs` count (§6.8). Provide: §3.11, §6.6, §6.7 (plugin part: `refusalFor`,
`readDeploySignals`, the bus), §6.9, §7.5, `window.__toggleDroneHud`, `window.__droneHud`. Consume: `installDrone(deps)`
and the DroneApi (§3.9), `props.prewarm` (§3.2), hotbar `.hb-hotbar-addons` / `hb-hotbar-mounted`, the kit / keymap /
focus / hud_scale / escape_action helpers. README sections: purpose, flags, files, controls (§6.2 PLAN table with the
DV-5 / DV-19 notes), the `__drone` API + debug, test run lines, the 1070 smoke recipe pointer, "SPEC.md is the contract".
Tests: drone_hud, `node test_plugin_index_gen.mjs`, `node tests/plugin_loader.test.cjs`. Never: static imports of
`scene3d/` or `three`; hand-editing index.json; other plugin_bar.js changes.

---

## 12. Orchestrator notes

### 12.1 Harness rows (`harness/run-js-headless.mjs`, TIER5)

Insert directly after the last film row of the film block (`{ tier: 5, flag: "filmMode(terrain_corridor)", file:
"tests/film_terrain_corridor.test.mjs" },`):

```js
  // Drone Deploy (2026-10-24, ?drone=on, DEFAULT OFF): scene3d/drone/** + plugins/drone-hud.js suites (SPEC scene3d/drone/SPEC.md).
  { tier: 5, flag: "drone(flight)", file: "tests/drone_flight.test.mjs" },
  { tier: 5, flag: "drone(tether)", file: "tests/drone_tether.test.mjs" },
  { tier: 5, flag: "drone(gestures)", file: "tests/drone_gestures.test.mjs" },
  { tier: 5, flag: "drone(props)", file: "tests/drone_props.test.mjs" },
  { tier: 5, flag: "drone(entities_seam)", file: "tests/drone_entities_seam.test.mjs" },
  { tier: 5, flag: "drone(controls)", file: "tests/drone_controls.test.mjs" },
  { tier: 5, flag: "drone(osd)", file: "tests/drone_osd.test.mjs" },
  { tier: 5, flag: "drone(audio)", file: "tests/drone_audio.test.mjs" },
  { tier: 5, flag: "drone(sequence)", file: "tests/drone_sequence.test.mjs" },
  { tier: 5, flag: "drone(api)", file: "tests/drone_api.test.mjs" },
  { tier: 5, flag: "drone(hud)", file: "tests/drone_hud.test.mjs" },
```

`--only=drone(` selects them. The coverage guard fails a full run when a `tests/drone_*.test.mjs` exists without a row.

### 12.2 `docs/url-flags.md` rows (L5 writes them; six columns; `\|` inside cells)

§1 Required / mode flags — directly after the `rynthHud` row:

```
| `drone` | `on` to enable | **off** (2026-10-24, during development: `DRONE_DEFAULT_ON = false` in plugins/drone-hud.js; the 1070 eye test flips it to on with a `?drone=off` escape, PLAN §9.6) | exact match: `=== "on"` opt-in while `DRONE_DEFAULT_ON` is false (absent, `=1`, `=true`, `=ON` ⇒ off); after the flip only `=== "off"` disables | **Drone Deploy** (`scene3d/drone/SPEC.md`): a 30×30 button directly under RynthSuite's ⚒ in the toolbar's add-on column (`plugins/hotbar.js` `.hb-hotbar-addons`, CSS `order: 10`; a fixed float at `right: 12px; bottom: 84px` without a toolbar). Click deploys / skips / recalls by state, Shift+click recalls at once, right-click opens the settings, **Shift+F11** = the button. A local gesture scene (pack, place, goggles, tablet), an FPV camera drone flown with keyboard / pointer-locked mouse / gamepad, and the stow in reverse; local-only — a cycle sends nothing (the `broadcastPose` setting, default off, sends the real `/read` emote). `scene3d/drone/index.js` (`window.__drone`) is imported on first use only (location.href-relative); with the flag off nothing under `scene3d/drone/` loads. | plugins/drone-hud.js `droneHudEnabled`; app/plugin_bar.js `PLUGIN_HOTKEY_DISPATCH["drone-hud"]` |
```

§4 Dev / debug / perf flags — directly after the `filmProps` row:

```
| `droneDebug` | `on` to enable | **off** | `=== "on"` opt-in (absent, `=1`, `=true`, `=ON` ⇒ off) | Drone Deploy dev surface: `window.__drone.debug` (`setSticks(axes, ms)`, `trigger(signal)`, `clipParity()`, `events()`). Only meaningful with `?drone=on`. | scene3d/drone/index.js `readDroneFlags` |
| `droneAudio` | `off` | **on** (motor hum on the client effects bus) | `=== "off"` opt-out | `?droneAudio=off` builds no WebAudio nodes for the drone's motor hum (`scene3d/drone/audio.js` on `audioManager.getEffectBus()`); when on, the master / effects sliders and the focus mute apply. Only the exact string `off` disables. | scene3d/drone/index.js `readDroneFlags` |
```

§0 DEFAULT-OFF FLIP CRITERIA (blockquote table) — after the `reversedZ` row:

```
> | `drone` | Drone Deploy is new (2026-10-24): gestures, props, the FPV camera, the input lock and the OSD have not had the owner's 1070 eye test. | PLAN §10 E1–E9 (+ SPEC §10.2) pass on the 1070: button under ⚒, deploy / fly / stow on a male and a female human, no prop clipping, FPS within 5 % (cine; the angle / acro lens overlay cost is reported separately, SPEC DV-10), zero console errors, no outbound game actions beyond the idle `0x01E9` pings. | **Gated on that pass** (PLAN §9.6); then default-on (`DRONE_DEFAULT_ON = true`) with the `?drone=off` escape. |
> | `droneDebug` | Debug pin — `window.__drone.debug` for the drone tests and the 1070 smoke. | n/a (debug). | Intentional debug pin. |
```

### 12.3 Integration order (phase 2; one heavy job at a time, `free -m` ≥ 2.5 GB first)

1. Merge all five lanes (file-disjoint). Check: `scene3d/drone/` has exactly README.md, SPEC.md and the ten modules
   (`index.js` + the nine of §1.4); `fixtures/drone/` byte-equal to `recon/` (`cmp`); `data/drone-rig-profiles.json`
   exists and parses.
2. Add the §12.1 rows. Run each drone suite alone (`node tests/drone_<topic>.test.mjs`), then the neighbours the
   seams touch: `tests/unified_motion_authority.test.mjs`, `unified_queue_preempt`, `unified_handback`,
   `unified_hook_drain`, `node tests/test_ws12_cast_audio.mjs` (regex-pins `cancelCastSequence`'s clearOnDone one-shot
   free; the seam leaves that code untouched), `film_runtime_camera`,
   `film_hooks`, `film_runtime_overlay`, `film_runtime_world`, `film_scene_los`, `film_flight_model`, the nine audio
   suites (§8.2 drone_audio), `plugin_loader`, `test_plugin_index_gen.mjs`, `keymap_manifest`, `rynth_hud_dom`,
   `rynth_vt_hud_integration`, `plugins_late_client_bind`.
3. Lints (light, from the holtburger repo root): `node scripts/lint-url-flags.mjs --strict` (the `droneDebug` /
   `droneAudio` readers under scene3d/ need their rows), `node scripts/audit-flag-defaults.mjs --mismatch`
   (expect no drone row; `drone` classifies as tristate), `node scripts/lint-harness-params.mjs`.
4. Wire check by reading: the drone modules' static imports match §1.4 (`rg -n '^import' scene3d/drone/*.js
   plugins/drone-hud.js`).
5. `capped-build node harness/run-js-headless.mjs` once. No wasm build (pure JS; rebuild `pkg/` only if a pull made it
   stale).
6. 1070 smoke (PLAN §9.4 step 6; on-screen allowed by the owner, 2026-10-24). **Local ACE only**: a separate, muted
   Chrome profile (`--mute-audio`, launched through `hidden-run.vbs`), CDP :9333 through the existing tunnel, the local
   test account with `server_host=127.0.0.1` pinned — never the owner's Coldeve profile or session; URL flags
   `?nosw=1&drone=on&droneDebug=on`. Script (each step awaited; `deploy()` returns at once and `setSticks` counts driver
   time from its call, so the sticks go in only once flying):
   1. `await __droneHud.load()`; start the probe2 send counter and the probe4 console-error collector;
   2. `__drone.deploy({quick: true})` → poll `__drone.status().state` until `'flying'` (≈ 4.3 s, §4.4; 15 s timeout);
   3. `__drone.debug.setSticks({pitch: 0.5}, 3000)`, wait 3.5 s;
   4. `__drone.recall()` → `{ok: true, state: 'returning'}`; poll until `'idle'` (60 s timeout).

   Assert: the state sequence read from `__drone.debug.events({limit: 200})` (`message: 'state'` entries, §7.4):
   deploying → flying → returning → landing → stowing → idle; zero console errors; zero outbound game actions beyond
   the idle-baseline `0x01E9` pings (`broadcastPose` is off); the funnel gate reopened
   (`__inputFunnel.snapshot().fault === null`) and the camera released (`__drone.status().camera.owned === false`,
   `liveScene3d.film` absent — the smoke URL has no `?filmMode=on`; a hooks object film installed before the deploy
   stays, R1-04). Then log out, close that Chrome by its profile (`--user-data-dir` match; never the
   owner's Chrome) and delete its task.

---

## 13. Phase-0 review changelog (2026-10-24)

Two checkers (api-truth, buildability) raised 29 issues. Each was re-verified against the code before it was applied;
none was rejected (#12 duplicates #1). Where a proposed fix fell short on re-measurement, a variant was used (noted).

| # | Sev. | Change |
|---|---|---|
| 1, 12 | major | §6.7 `busy`: `w.__useTargeting?.pending != null` (pending is `null` or `{itemGuid, itemName}`, never `true`); drone_hud fakes the real object. (Phase 3: a pending use-target is its own `targeting` code, §14 R4-10.) |
| 2 | minor | §6.7 both `filmBusy` copies: `take?.running != null` (it is `null` or an object). |
| 3 | minor | §6.2 / §7.3: index.js calls `audioManager.resume()` in `deploy()` right before `audio.start()`, inside the gesture. Variant: not in the bus getter, which is also polled at ≤ 1 Hz outside any gesture. |
| 4 | minor | §1.4 / §6.3 / A4: owner_registry.js named stateful; the index-bundled.html gap (separate empty registry) is an accepted limitation (E7+). |
| 5 | minor | §12.3: `node tests/test_ws12_cast_audio.mjs`, described as the `cancelCastSequence` regex pin. |
| 6 | minor | §6.6: mount-order reason (neither plugin is in `BAR_SLOT_ORDER`; loader order; `order: 10` decides). |
| 7 | minor | §3.8 / §6.3 / DV-9: prewarm resolves once baked, else at `timeoutSec`; not cancellable. |
| 8 | minor | §6.4 step 4: window-capture ordering reason corrected. |
| 9 | blocker | §3.3 cine: **one-step lead** `pos + vCmd·dt`. Re-measured: the 0.5 s carrot settles at 16.3 m/s (37.5 m braking travel, 22 m bound) and climbs at 5.45 m/s. Variant: the proposed zero lead runs 11.74 m/s at 30 Hz, failing the 0.98 pin; the one-step lead gives 12.04 / 19.96 / 4.01 m/s at 10–60 Hz. `CRAFT_TUNING.cine.leadSec` removed; DV-6 numbers corrected; drone_flight gains the 1.02 upper pins at 60 and 30 Hz. Same root cause: rth / land targets must be feasible (a naive RTH target overshoots its corner by 10 m, measured) and drone_flight pins ≤ 0.5 m off the polyline. |
| 10 | blocker | §3.3 liftoff **kinematic** (per-step `createDrone.reset` on the min-jerk path with exact velocity / acceleration; measured exact at both speeds and continuous at the handover). Cut moved to the path midpoint: `cutStartSec / cutBlackSec / cutEndSec = 0.925 / 1.1 / 1.275`, so the own is at 0.85 m up / 1.7 m out. Updated: T9 and the drone_flight / drone_sequence pins; DV-31 added, DV-12 corrected; E3+ notes. |
| 11 | major | §3.6 / §5 step 11: `OsdView.mode` (raw); osd applies `modeLabel`. |
| 13 | major | §4.2 `rig` = the kind once `gestures.ready()` resolved; new `rigKnown` feeds the prep timeout, so a known humanoid keeps its beats with timer clips (§4.4, §5 step 3, §7.3 `readyKind`); drone_sequence / drone_api cases added. Not adopted: the optional loadAnim warm in the idle prewarm, which would add a plugin import. |
| 14 | major | L4 ships `data/drone-rig-profiles.json` = `{"version": 1, "profiles": {}}` in phase 1 (§1.3, §7.6, §11, §12.3); this avoids the 404 console error. |
| 15 | minor | §6.7: the abort-signal rows state the forwarding direction; the plugin's `droneDeps` / `emitSignal` and index.js's subscription are given verbatim. |
| 16 | minor | §3.11 / §7.3 / §7.4: `hb-drone-state` on `document`, `bubbles: false`, one per transition, `{state, prev, at}`; the teardown re-dispatch is dropped. |
| 17 | minor | T19 from pilotView adds `controlsPhase(stow)` + `osd(off)`. T21 carries T20's release when both are first seen in one tick. T22 adds `osd(off)` when not fpv. T23 puts `state` first and always sets `controlsPhase(stow)`. drone_sequence rows added. |
| 18 | minor | §5 step 6 / 11: `home.pos`. §4.2 / step 14: the battery mapping. Step 3: `props.setRig` with the profile on the first known tick (fake props refuse attach without one). §7.3: `funnel: deps.funnel` forwarded (the drone_api fake controls drive the fake funnel). Step 1 / 13: wheel zoom, persisted ≤ 1 Hz. |
| 19 | minor | §3.7: `start()` builds at gain 0, and `update` is a no-op after `stop()`. §7.4: the hum follows `armLevel`; `audio(0)` stops it, `audio(1)` does nothing. |
| 20 | minor | DV-32 (signatures reshaped, the SPEC wins) and DV-33 (`broadcastPose` = 0x01E1 + one 0xF61C) added. |
| 21 | minor | §12.3 step 6: smoke rescripted (wait for `flying` → sticks → recall → wait for `idle`); the `state` executor logs each transition for `debug.events()`; local-ACE / 127.0.0.1 / no-Coldeve restated. |
| 22 | minor | `SEQUENCE_DEFAULTS.settleTimeoutSec: 8` and T29 (forced `state(idle)` + `detach(drone, remove)`). |
| 23 | minor | SOFT: no `motion(Ready)` on `combat` (DV-13). The watchdog runs only while held AND locked, so it stops at every abort. |
| 24 | minor | T16 needs `rth.armed`, so a stick held through the recall never cancels it (DV-19); `armed` is in the §4.1 model. |
| 25 | minor | §3.1: `event` / `done` come from the current job only. §5 step 3 also drops them on `rigChanged`, to keep §6.12's "beat continues on time". |
| 26 | minor | Triangle budget (drone ≤ 700, tablet + goggles ≤ 600); "gizmos" dropped (DV-35); pointer-lock loss specified (§3.5); film-take abort latency ≤ 250 ms (DV-17); "ten modules". |
| 27 | minor | §4.4 totals table (own 6.33 s / quick 3.51 s; control 7.43 / 4.24 s; stow 5.23 / 2.78 s); DV-34. |
| 28 | minor | DV-10, E7+ and the §12.2 flip row: the 5 % FPS target is measured in cine; the angle / acro overlay cost is reported separately. |
| 29 | minor | Portal refusal text: `Not while in portal space`. |

---

## 14. Phase-1, phase-3 and phase-4 amendments (2026-10-24 / 25)

Every row is already applied in place in the section it names, so the sections above stay the contract; this list is
the changelog. Phase 1: the deviations the lane builders and verifiers recorded and the orchestrator accepted.
Phase 3: the orchestrator's decisions on the review findings (`R1-…`–`R4-…`; `V1`–`V3` are the phase-2 1070 visual
findings). Where a reviewer and a verifier disagreed, the verifier's fix was taken unless the row says otherwise.
Phase 4 (§14.4): the orchestrator's decisions on the 1070 eye-test findings (`F1`, `F2`).

### 14.1 Phase 1 — accepted lane deviations

| Lane | § | Amendment |
|---|---|---|
| L1 | §3.3 | Additive `CRAFT_TUNING` keys (angle hold / altitude gains, `rth.amax 3.6 / jmax 7.2`, a `crash` group); every SPEC key and value unchanged. |
| L1 | §3.3 | cine: the horizontal stick vector is clamped to unit length (a diagonal flies 12 / 20 m/s, not 16.97), in the frame of the camera's current heading. angle: 35° of TOTAL tilt (pitch + roll), not per axis. |
| L1 | §3.3 | `step()` clamps a dt above 20 s (film createDrone goes NaN for one step of dt ≥ ≈ 1000) and re-seeds at the last finite pose; `reset()` also clears an installed plan; `state()` maps −0 to 0. |
| L1 | §3.3 | rth / land / hold from a moving start brake first (rth re-plans from the stop point, land flies back over `at`, hold keeps the stop point and the camera heading / pitch); an invalid plan → `{ok:false}`, current plan kept. |
| L1 | §3.3 | Floor-contact landing (normal z ≥ 0.5, < 0.3 m/s, within the last `finalM + 0.5` m of rth / land, and in a crash); stall landing 3 s after the plan clock ends (vertical descent, lands away → noDrone stow); land's `distTouchdownM` = the remaining plan distance, non-increasing. |
| L1 | §3.3 | `contact()`: impactSpeed floored at 0; a no-normal hit removes the velocity along the clamp's correction (none → stop); the tether hit's into-surface velocity is removed although it never counts. |
| L1 | §3.3 | cine `cam.h / p / r` re-expressed past the gimbal's −90° pole and unwrapped (continuous heading through nadir); `cam.q` stays createDrone's exact pose. |
| L1 | §3.4 | `drain`: a level below 1e-9 reads as empty; `planReturn`'s last point is a value-exact copy of `home`. |
| L2 | §3.1 | `watch()`: the first call after a `hold()` only starts the 1 s clock; `ready()`: a `rebind()` during resolution hands the promise over to the re-resolution; `buildClip` / `rigProfile` null-safe with stricter plan validation; guid 0 → TypeError; `dispose()` also stops a local clip left on the playhead. |
| L2 | §3.2 | `prewarm` refusals without THREE / camera / scene (not memoised), a throwing compile restores the target, a 20 s ready-poll cap; `toWorld` refuses `{ok:false, pos:null}`; `setRig` removes a prop the new rig cannot hold; `remove()` true for any valid name; `setScreen` builds its strings only when the shown value changes; `fadeOut` = a scale-out + the blob's opacity; goggles built 0.18 × 0.067 × 0.0675 m. |
| L3 | §3.6, §3.7 | Optional `clock` deps (osd cheat-sheet fade, audio bus retry); OSD root size with the `1vw` / `1vh` fallback; per-mode OSD content (pilot = banner row; crash = banner + static 0.85 + vignette; boot hides static and cheat sheet; cheat sheet only in fpv); `update` / `frame` return booleans; `mode` / `built` getters; `staticOpacity(non-finite) = 0`; `audio.start()` keeps a running graph; `humParams(null)` = all zero. |
| L3 | §3.5 | `phase` null before `setPhase` / after `restore` (= `'deploy'`); `'deploy'` / `'stow'` exit our pointer lock and a lock granted outside `'fly'` is released at once; a gamepad button held at `lock()` is primed; the drain also ends on blur; leaving `'pilot'` mid-drag calls `_endFollowDrag()`. |
| L4 | §4.3, §4.5, §4.6 | T8 also emits the pending `osd(fpv)` when control is taken before cutEnd; T9 adds `broadcastPose` after the skip's `motion(ReadState)`; T25 runs the last beat's pending event / end actions first; request ticks run guards (2)–(5); `BEAT_EVENT_SEC` exported; autopilot `speed` = s only for liftoff; osd `durationSec` only on boot; a soft abort keeps `drone: 'air'` until T28. |
| L4 | §3.9, §5 | `bad-argument` validation (non-object options, non-boolean `quick` / `instant` / `pilotView`, tune keys; `scale` goggles-only); `already` answers carry `state`; an unknown refusal code → `Cannot deploy (<code>)`; the wheel marks settings dirty only on a change; `status().rig` kept while idle for the same guid; the lift-off `away` degenerate below 0.1 m. |
| L4 | §3.9, §7.3 | `deploy()` answers `busy` while a teardown is pending (D4); `process()` stops on a dead cycle (D1); `emergency()` releases Ready when held (D2). |
| L4 | §3.8, §7.1 | `prewarmAround`: the first call sets the baseline, the landblock is cached per grid cell (D3: `landblockOfWorld` allocates); `configureLens(unknown)` → `{ok:false, on:false}`; no-op unsubscribers after dispose; `stats()` adds `disposed`, `listeners`; `installDrone` stays `async` (a new promise per call, one memoised inner promise). |
| L5 | §3.11, §6.7 | Tooltips `Stowing…` / `Aborting…` / `Crashed…` and the no-hands note appended to the single sub line; `.is-active` defined; `aria-disabled` `"true"` / `"false"`; `__droneHud.load()` / `prewarm()` result shapes, never rejecting; the default prewarm refuses without a live scene; the dot reads persistent codes past `busy` / `moving`; the vitals no-previous-max rule; `droneDeps` frozen; the `hb-drone-state` tick in a microtask; the popover's outside `pointerdown` (with `mousedown`), blur on close, right-click toggle, launcher not outside, ranges on `change`, off-list values shown; an idempotent disposer that also removes the style and the popover. |

### 14.2 Phase 3 — review decisions

| Id | Sev. | § | Decision |
|---|---|---|---|
| R3-1 | major | §5 steps 7–9, §3.3 | A ground-ending plan (`crash` / `land` / `rth`) clamps the CRAFT with `safetyBody` even while the camera is owned (those hits feed `contact` and the mesh); the owned camera gets a second, camera-only eye clamp from `prevEye ?? prevPose` (`prevEye: null` declared in the cycle). A crash / forced landing now rests at ground + 0.06 m, not on the eye's 0.7 m floor. |
| R3-2 | major | §6.11, §7.4 `detach world` | A hand more than 0.3 m above the pilot's feet or within 0.4 m of them horizontally (a timer-mode place, a standing hand), or a non-finite hand height → `place` 0.72 m ahead on the pilot compass; the release-frame hand still drops at the hand. |
| R3-3 | minor | §3.3, §8.2 | `distTouchdownM` is never less than the closest straight-line distance to the route end reached so far (and stays non-increasing) (ships with R3-1's `rth` body clamp); drone_flight F8 times the route end from the plan duration. |
| R3-4 (+ R1-05) | major | §6.5 | `restoreFollowCamera` pre-sets `cs._orbitRigStopped = true` before `switchMode('orbit')`: no orbit-entry Ready in any exit (a death-held corpse no longer stands up). R1-05's index.js `followPrep` alternative not taken. |
| R3-5 | nit | §5 step 13, §3.2 | The tablet's `homeBearingRad` is NaN out of the world and within 1 m of home (no arrow, like the OSD). |
| R1-01 (+ R2-1) | major | §3.5, §7.3, §8.2 | Option B: `controls.dispose()` keeps a running restore drain (≤ 3 self-removing window listeners after idle); the two drone_controls pins that expected the drain dropped are flipped. |
| R1-02 | minor | §3.9, §4.5 T8 | `takeControlAfterCut()` (deploying, live cycle, `cutFired.own`) → `request('skip')` = T8, in `recall()` after its argument checks and `pilotView()` after its argument check: R / Tab / the API in the window between the goggle cut and T8 are no longer dropped. |
| R1-03 | major | §6.4, §7.4, §9 A5 | `filmGate` recorded by `inputRestore` (film busy AND `steps.funnel.unpoisoned`), cleared by `settleFilmGate()` first in `status()` / `deploy()` (only a `'gate'` still set, no cycle, film idle). |
| R1-04 | major | §3.8, §7.3 | `foreignHooks` (a `liveScene3d.film` object present before `createCameraOwner`, adopted by it) → `dispose()` only releases the camera owner and removes our own listeners; film's shared hooks survive a drone cycle. No `win.__film` clause (it would break the P5 film-busy pin). |
| R1-06 (+ R4-02) | major | §7.4 `inputRestore` | `if (c.clean) c.clean = c.osd.clean(false) === true;` right after `controls.restore()`: H's hidden HUD / cursor end when control comes back. No `osd(off)` clause (H keeps working while input stays locked). |
| R1-07 | minor | §6.12 | The rig watch re-holds ReadState only while held AND locked. |
| R1-08 | nit | §3.9, §6.7 | `deploy()` → `not-in-world` while `live.__webglContextLost === true`. |
| R1-09 | nit | §3.5 | The pointer-lock promise's grant handler exits our lock when it resolves after `restore()` or outside `'fly'` (browser timing: a 1070 check). |
| R2-2 | minor | §3.2 | The lens-overlay twin in `props.prewarm` (empty scene, null target, DoubleSide, kept alive, every program polled). |
| R2-3 | minor | §3.5 | Tab passes through inside an open `[aria-modal="true"]` dialog; Space stays blocked. |
| R2-4 | minor | §3.11, §6.4 | The popover's outside-press closers are registered once at mount (they run before a later deploy's lock blockers) and removed only by the disposer; Escape stays open-time. |
| R2-5 | minor | §3.5 | `takesText` no longer counts SELECT (drone keys on a focused select are taken; arrows / Enter / Esc still reach it). |
| R2-7 | nit | §3.11, §6.7 | `readDeploySignals(win, cache, droneState)`: the launcher tick, tooltip and `activate` pass the state they just read (one `status()` per read); `deps.refusal` falls back to the `status()` read; no cached state. |
| R2-8 | nit | §6.4 | Docs only: an Options rebind capture started mid-cycle sits behind the lock and cannot take drone keys. |
| R4-01 (V1) | major | §3.6 | OSD instrument row at `top: 190px`, heading tape at the bottom (150 px), cheat sheet at 240 px; the clean-view corner overrides kept. |
| R4-03 | minor | §3.2, §3.3, §7.4 | `DEFAULT_ANCHORS.droneInHand.quat = [0.932351, 0.304211, 0.142447, −0.13374]` (no snap at the place release); the rth plan carries `yaw: home.yaw`, which manual_flight eases the heading to in the final descent (no yaw snap at the pickup). |
| R4-04 | minor | §3.3 | angle / acro handover from a cine-driven plan (T8; also T11, T16): a 0.4 s min-jerk slerp, in the mount's frame, from the plan's last camera onto body ⊗ mount (stick rotation passes through; ≤ ≈ 3° of view turn per frame), allocation-free. |
| R4-05 | minor | §3.5 | In `'pilot'` a right-button mouseup during the drag ends it (`_endFollowDrag`) before the canvas check: no context menu from a short right-click; drags keep orbiting. |
| R4-08 | minor | §3.6 | The pilot-view banner sits at `bottom: 24%`; text `PILOT VIEW · Tab / View: goggles`. |
| R4-09 | nit | README | H hides the whole HUD and the cursor (restored with H or when control returns; R / Shift+F11 still recall); the drain; Tab in dialogs; the right-click; the drop rule; `batteryMin: 1` for E4. |
| R4-10 | nit | §2.8, §3.11, §6.7, §8.2 | New non-persistent refusal `targeting` → `Finish targeting first` for a pending use-target, ranked right after `busy` (now only the drone state ≠ idle). |
| V2 | major (look) | §3.2 | Rotor blur discs translucent grey, `depthWrite: false`, program key fixed. |
| V3 | look | §3.2 | Goggle lenses dark tinted glass; only the REC pip emissive. |

### 14.3 Recorded, not changed

- **R2-6** (nit): integrated per-frame drone allocation is ≈ 0.6–2.5 KB / frame of V8 number boxing (no JS literals or
  closures), and `status()` is ≈ 6.6 KB per call while flying (the HUD now makes one call per state read, R2-7). §5's
  allocation rule is the JS-level rule (objects, arrays, closures, strings).
- **R4-06 / R4-07**: refuted — the popover's battery options are §3.11-pinned and the API takes 1 min (an E4 pre-step,
  §10.2); a short recall's 15 m climb follows PLAN §2.3 / §6.4 (an owner decision at the eye test).
- **R4-11** (nit): pilot view shows the tablet's back plate (an E4 note, §10.2).
- R2-2's per-frame two-pass overlay cost (`forceSinglePass`): measured in node, not adopted (an E7 note).
- Pre-existing, outside the drone (not changed, out of scope): `EntityInstance.dispose()` (scene3d/entities.js)
  double-frees a J5 one-shot that is both the playhead and the queue head (found by L2); camera.js's orbit-entry Ready
  also fires for a death-held rig when C is pressed while dead (R1-05's root cause).

### 14.4 Phase-4 (1070) amendments (2026-10-25)

Evidence: `docs/drone-deploy-2026-10-24/live/` (`EYETEST.md` E2 / E5, `eye-*.json`; `shots/look-az*.jpg` = the archway,
`shots/olt-01-pack-reach.jpg` = the no-hands spawn on the slope). Re-check items: §10.2 "Phase-4 additions".

| Id | Sev. | § | Decision | Evidence |
|---|---|---|---|---|
| F1 | major | §2.8, §3.9, §6.7, §7.3, §8.2 | New deploy refusal `covered` → `Needs open sky above you` (`DRONE_REFUSAL_REASONS` and `REFUSAL_TEXT`; index-only, non-persistent: the click's red flash). `deploy()` runs the open-sky check after the refusals and `not-in-world` checks, once the world link is built, before anything else and before `request('deploy')` (T1): four columns (the pilot, 0.72 m, 1.5 m and 4.12 m ahead on the pilot's compass), each `base + 0.5 → base + OPEN_SKY_M` (16.5), the body sphere, the roof layers; any hit → the half-built cycle is torn down like the internal-error path (nothing left: no listener, hook, lock, `liveScene3d.film`; the funnel untouched; idle). Two deviations from the decided recipe, found against the code (each is one line of index.js and one P10 pin): (a) the `objects` layer is left out — wasm `sweepSphereAgainstObjects` (lib.rs; `missile_sweep.rs`) holds the cylsphere / sphere bodies of creatures, players, NPCs and dynamic props (the human Setup's upper sphere sits 1.35 m up, r 0.48, so a column next to another player or an NPC hits it from below), which is the decision's own "players / NPCs are not a roof"; `entities` is BSP doors and chests, also out; (b) `base` is the drop height `dropZ` (§6.11), which equals the decided `link.groundZ(x, y) ?? P.z` whenever the pilot stands on the terrain (the 1070 archway, every slope case), and is the pilot's floor for a pilot on a porch / platform above the terrain — the building-mesh sweep is two-sided (physics.rs `sweep_sphere_against_triangles` picks the start side), so a column from the terrain would hit the floor under the pilot from below and refuse a launch with open sky above it. | `+Tester` at AC world (4650.62, 9422.93, 76.01) (landblock 0x1831, 62.6S 82.5W) under a stone archway: building mesh 11.9 m above the pilot, 7.1 m above the drop spot, the arch underside 15.2 m up where the drone climbed; the rth (climb to max(current, ground + 15 m), straight cruise, vertical descent) stopped on an upward building surface 14.1 m above home; the plan clock ran out, the floor-contact rule landed it there (14.1 m AGL), T21 took the noDrone stow and it faded on the roof. In the open (Holtburg) the same cycle releases the goggles 4.9 m above home and lands on it. |
| F2 | minor (look) | §6.11, §7.4, §8.2 | `dropZ`: when the pilot stands on the terrain (`gp = link.groundZ(pilot.x, pilot.y)` finite and `\|gp − pilot.z\| <= 0.25`), the drop takes the terrain at the drop spot whenever it is known, whatever the slope; otherwise the DV-22 rule (the terrain within 0.5 m of the feet, else the feet: a floor / platform / unknown terrain). Same rule for every drop path (`detach world`, `place`) and the open-sky columns' base. | `+Drone Olthoi` on a snowy slope: at the `spawn` beat the drone read 0.81 m AGL (0.75 m above the rest height): 1.5 m ahead on a ~30° slope is ≈ 0.8 m off the feet, past the 0.5 m tolerance, so it stayed at foot level. |

### 14.5 Phase-4 flip (2026-10-25)

| Item | Decision |
|---|---|
| `?drone` default | **ON** (`DRONE_DEFAULT_ON = true`), only the exact `?drone=off` disables it; `docs/url-flags.md` §1 and §0 rows updated. Criteria (§12.2 / url-flags §0) met on the 1070: launcher under ⚒, deploy / fly / stow on male and female humans plus Lugian, Empyrean, Tumerok and Olthoi, no prop clipping, cine FPS within 5 %, zero console errors, only the idle `0x01E9` pings outbound (E9; `broadcastPose` adds exactly one `0x01E1` + one `0xF61C`). Evidence and the full E1–E9 table: `docs/drone-deploy-2026-10-24/live/EYETEST.md`. |
| E7 first-deploy frame | Not met and recorded, not blocking: the one 127–151 ms frame right after the goggle cut on the first deploy at a place is three.js uploading compressed world textures that come into view for the first time (`compressedTexSubImage2D` in `uploadTexture`); the module's first evaluation at the first click costs 42–89 ms. The client itself shows 458–750 ms frames while standing. |
| `drone_hud` pins | the flag checks now pin default-on (only `?drone=off` disables; `droneHudEnabled(s, false)` keeps the development reader) and the manifest description. |
